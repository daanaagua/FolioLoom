import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport } from "../src/report.js";
import { QualityQueue } from "../src/fullbook/delivery-policy.js";
import { supervisionCandidateHash } from "../src/domain/supervision.js";

for (const priorOnly of [false, true]) {
for (const applyRepair of [false, true]) {
test(`unapplied fixes and existing findings enter bounded repair (repair=${applyRepair}, priorOnly=${priorOnly})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-proposed-fix-"));
  const sourcePath = join(root, "source.txt");
  const source = "the guard did not leave the tower. he waited beside the door until the rain stopped.\n\nthe visitor stood outside in silence.";
  const bad = "守卫已经离开了塔楼。他在门旁等着，一直等到外面的雨停了下来。\n\n来访者静静地站在外面。";
  writeFileSync(sourcePath, source, "utf8");
  const imported = await importSource({ sourcePath, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  let repairs = 0, translations = 0, closures = 0;
  const reply = (context: Context) => {
    const user = context.messages.findLast(m => m.role === "user")!;
    const raw = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("");
    const answer = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) return answer("submit_lexical_anchors", { anchors: [], entityLinks: [] });
    if (context.tools?.some(t => t.name === "finalize_translation_batch")) {
      translations++;
      const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(raw)![1]!);
      return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
        translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: bad })), notes: [] })) });
    }
    if (raw.includes("ORDERED TEXT SLOTS")) {
      repairs++;
      const slots: [number, string, string][] = JSON.parse(/ORDERED TEXT SLOTS[^\n]*\n\n([^\n]+)/u.exec(raw)![1]!);
      return fauxAssistantMessage(JSON.stringify(slots.map(([, , target]) => applyRepair && target.includes("已经离开了")
        ? target.replace("已经离开了", "没有离开") : null)));
    }
    const p = JSON.parse(raw);
    if (p.event === "plan") return answer("submit_supervisor_values", { values: [p.windows.length, [], [], "Translate."] });
    if (!p.priorIssues?.length) return answer("submit_supervisor_values", { values: ["accept", [], [], "Checked."] });
    closures++;
    const s = p.source[0].evidence[0].id, t = p.candidate[0].evidence[0].id;
    const wrong = p.candidate[0].evidence[0].text.includes("已经离开了");
    return answer("submit_supervisor_values", { values: [wrong ? "revise" : "accept",
      wrong && !priorOnly ? [[s, t, "Restore the missing negation."]] : [],
      p.priorIssues.map(() => [wrong && priorOnly ? "unresolved" : "fixed", s, t, wrong ? "The proposed replacement restores the negation." : "The repaired candidate preserves the negation."]), "Checked current text."] });
  };
  faux.setResponses(Array.from({ length: 12 }, () => reply));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "proposal", protocolVersion: "test" },
    model: { ...faux.getModel(), provider: "folioloom-deepseek" }, streamFn: faux.provider.streamSimple.bind(faux.provider),
    supervisorMode: "bounded" as const, deliveryMode: "standard" as const, maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
  await runBook(options);
  const writable = new LosslessBookStore(options.storePath);
  try {
    const active = writable.activeTranslations("proposal");
    new QualityQueue("proposal", writable).defer({ windowId: active[0]!.windowId, candidateHash: supervisionCandidateHash(active),
      issues: [{ code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: active[0]!.blockId, issueKey: "negation", repairable: true,
        message: "Restore the missing negation.", evidence: { sourceQuote: source.split("\n\n")[0]!, targetQuote: bad.split("\n\n")[0]!, problem: "Restore the missing negation." } }] });
  } finally { writable.close(); }
  await runBook(options);
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try {
    const item = new QualityQueue("proposal", store).items()[0]!;
    assert.equal(item.state, applyRepair ? "resolved" : "unresolved");
    assert.equal(item.closure?.dispositions[0]?.status, applyRepair ? "fixed" : "unresolved");
    assert.equal(store.activeTranslations("proposal")[0]!.text, applyRepair ? bad.replace("已经离开了", "没有离开") : bad);
    assert.equal(auditLosslessBookExport(store, "proposal").audit.strictExportable, applyRepair);
    const receipts = store.supervisionRecords("proposal").filter(r => r.qualityItemId && r.state === "completed");
    assert.equal(receipts[0]!.decision!.dispositions![0]!.status, "unresolved");
    assert.ok(store.loadTokenLedgerEvents("proposal").filter(e => e.type === "settled").every(e => e.usageComplete));
  } finally { store.close(); }
  assert.equal(translations, 1);
  assert.equal(repairs, 1);
  assert.equal(closures, applyRepair ? 2 : 1);
  const calls = faux.state.callCount;
  await runBook(options);
  assert.equal(faux.state.callCount, calls, "resume must not replenish the final-review credit");
});
}
}
