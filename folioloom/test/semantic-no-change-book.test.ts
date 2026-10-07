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

function userText(context: Context): string {
  const message = context.messages.findLast(m => m.role === "user");
  return !message ? "" : typeof message.content === "string" ? message.content
    : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

for (const valueWire of [false, true]) {
for (const genuineIssue of [false, true]) {
test(`no-change proposals need grounded closure and survive resume (values=${valueWire}, genuine=${genuineIssue})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-no-change-"));
  const source = join(root, "source.txt");
  writeFileSync(source, "the keeper waited beside the gate.\n\nhe quietly asked the visitor to wait outside.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const text = `守门人站在大门旁边等候。\n\n${genuineIssue ? "她" : "他"}轻声请那位来访者在外面稍等片刻。`;
  const faux = fauxProvider();
  let repairs = 0, translations = 0, ordinaryReviews = 0, closureReviews = 0, pause = true;
  const response = (context: Context) => {
    const prompt = userText(context);
    const answer = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) return answer("submit_lexical_anchors", { anchors: [], entityLinks: [] });
    if (context.tools?.some(t => ["submit_supervisor_decision", "submit_supervisor_values"].includes(t.name))) {
      const data = JSON.parse(prompt);
      if (data.event === "plan") return valueWire
        ? answer("submit_supervisor_values", { values: [data.windows.length, [1], [], "Review the complete candidate."] })
        : answer("submit_supervisor_decision", { action: "translate", windowIds: data.windows.map((w: any) => w.windowId),
          reviewBlockIds: data.windows.flatMap((w: any) => w.blockIds), guidance: [], issues: [], reason: "Review the complete candidate." });
      const sourceRef = data.source[0].evidence.find((e: any) => e.text.includes("he quietly"));
      const targetRef = data.candidate[0].evidence.find((e: any) => e.text.includes("轻声"));
      assert.ok(sourceRef && targetRef);
      const closure = !!data.priorIssues?.length;
      if (closure) closureReviews++; else ordinaryReviews++;
      const revise = !closure || genuineIssue;
      const problem = "The male keeper is incorrectly rendered with a female pronoun.";
      const status = genuineIssue ? "unresolved" : "dismissed";
      const note = genuineIssue ? "The target still has a female pronoun." : "The bound target already has the correct male pronoun.";
      if (valueWire) return answer("submit_supervisor_values", { values: [revise ? "revise" : "accept",
        revise ? [[sourceRef.id, targetRef.id, problem]] : [],
        closure ? data.priorIssues.map(() => [status, sourceRef.id, targetRef.id, note]) : [], "Checked the original finding."] });
      return answer("submit_supervisor_decision", { action: revise ? "revise" : "accept",
        windowIds: data.windows.map((w: any) => w.windowId), reviewBlockIds: [], guidance: [],
        issues: revise ? [{ blockId: data.candidate[0].blockId, sourceRef: sourceRef.id, targetRef: targetRef.id, problem }] : [],
        ...(closure ? { dispositions: data.priorIssues.map((p: any) => ({ issueId: p.issueId, status,
          sourceRef: sourceRef.id, targetRef: targetRef.id, note })) } : {}), reason: "Checked the original finding." });
    }
    if (prompt.includes("ORDERED TEXT SLOTS")) {
      repairs++;
      const slots = JSON.parse(/ORDERED TEXT SLOTS[^\n]*\n\n([^\n]+)/u.exec(prompt)![1]!);
      return fauxAssistantMessage(JSON.stringify(slots.map(() => null)));
    }
    translations++;
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text })), notes: [] })) });
  };
  faux.setResponses(Array.from({ length: 20 }, () => response));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "no-change", protocolVersion: "test" },
    model: { ...faux.getModel(), ...(valueWire ? { provider: "folioloom-deepseek" } : {}) },
    streamFn: faux.provider.streamSimple.bind(faux.provider), supervisorMode: "bounded" as const, deliveryMode: "standard" as const,
    shouldPause: () => pause && repairs > 0, maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
  await runBook(options);
  const pending = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal(pending.activeTranslations("no-change")[0]?.text, text);
    const audit = auditLosslessBookExport(pending, "no-change").audit;
    assert.equal(audit.strictExportable, false, "a no-change proposal does not close an issue");
    assert.equal(audit.quality?.pending, 1);
    const issue = pending.qualityRecords("no-change")[0]!.issues[0]!;
    assert.ok(issue.evidence?.sourceQuote && issue.evidence?.targetQuote);
  } finally { pending.close(); }
  assert.equal(repairs, 1);
  assert.equal(ordinaryReviews, 1);
  assert.equal(closureReviews, 0);
  pause = false;
  await runBook(options);
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal(store.activeTranslations("no-change")[0]?.text, text);
    const audit = auditLosslessBookExport(store, "no-change").audit;
    assert.equal(audit.strictExportable, !genuineIssue);
    assert.equal(audit.quality?.resolved, genuineIssue ? 0 : 1);
    assert.equal(audit.quality?.unresolved, genuineIssue ? 1 : 0);
    const final = store.qualityRecords("no-change").at(-1)!;
    assert.equal(final.closure?.dispositions[0]?.status, genuineIssue ? "unresolved" : "dismissed");
    assert.ok(store.loadTokenLedgerEvents("no-change").filter(e => e.type === "settled").every(e => e.usageComplete));
  } finally { store.close(); }
  assert.equal(translations, 1, "resume must not regenerate a deferred valid candidate");
  assert.equal(ordinaryReviews, 1);
  const calls = faux.state.callCount;
  await runBook(options);
  assert.equal(faux.state.callCount, calls, "resume must not renew a spent quality review");
});
}
}
