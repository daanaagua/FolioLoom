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

test("value supervision, scoped value repair and durable native book resume share one canonical journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-value-wire-"));
  const source = join(root, "source.txt");
  writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.\n\nno one spoke while the lamp burned in the room.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const bad = "那位安静的旅人已经离开了屋子。他守在门边，一直等到外面的雨停了下来。\n\n屋里的灯一直亮着，谁也没有说话。";
  let repairs = 0;
  const reply = (context: Context) => {
    assert.ok(context.systemPrompt?.startsWith("A synthetic authorized translation."));
    const user = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("");
    if (context.tools?.some(t => t.name === "finalize_translation_batch")) {
      const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
      return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
        translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: bad })), notes: [] })) }), { stopReason: "toolUse" });
    }
    if (prompt.includes("ORDERED TEXT SLOTS")) {
      repairs++;
      const slots: [number, string, string][] = JSON.parse(/ORDERED TEXT SLOTS[^\n]*\n\n([^\n]+)/u.exec(prompt)![1]!);
      return fauxAssistantMessage(JSON.stringify(slots.map(([, , target]) => target.includes("已经离开了") ? target.replace("已经离开了", "没有离开") : null)));
    }
    const data = JSON.parse(prompt);
    if (data.event === "plan") return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [data.windows.length, data.windows.flatMap((w: any) => w.blockIds), [], "Review negation."] }), { stopReason: "toolUse" });
    const wrong = data.candidate.some((b: any) => b.evidence.some((r: any) => r.text.includes("已经离开了")));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [wrong ? "revise" : "accept", wrong
      ? [[data.source[0].evidence[0].id, data.candidate[0].evidence[0].id, "Restore the source negation."]] : [], [], "Checked source meaning."] }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 12 }, () => reply));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "value-wire", protocolVersion: "test" },
    model: { ...faux.getModel(), provider: "folioloom-deepseek" }, streamFn: faux.provider.streamSimple.bind(faux.provider),
    supervisorMode: "bounded" as const, taskContext: "A synthetic authorized translation.", maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
  assert.equal((await runBook(options)).outcome, "completed");
  assert.equal(repairs, 1);
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal(store.activeTranslations("value-wire")[0]!.text, bad.replace("已经离开了", "没有离开"));
    const records = store.supervisionRecords("value-wire");
    assert.ok(records.filter(r => r.state === "completed").every(r => r.wireProtocol === "folioloom-supervisor-values-tool-1"));
    assert.ok(records.some(r => r.decision?.issues[0]?.sourceRef?.startsWith("s:")));
    assert.ok(auditLosslessBookExport(store, "value-wire").audit.strictExportable);
    assert.ok(store.loadTokenLedgerEvents("value-wire").filter(e => e.type === "settled").every(e => e.usageComplete));
  } finally { store.close(); }
  const calls = faux.state.callCount;
  await runBook(options);
  assert.equal(faux.state.callCount, calls);
});

for (const status of ["dismissed", "variant"] as const) {
  test(`a grounded ${status} receipt persists without another vote or changing committed text`, async () => {
    const root = mkdtempSync(join(tmpdir(), "folioloom-grounded-closure-"));
    const source = join(root, "source.txt");
    const original = "the quiet traveler waited beside the house. he stayed near the door until the rain stopped.";
    const translated = "那位安静的旅人等在屋旁。他一直待在门边，直到外面的雨停了下来。";
    writeFileSync(source, original, "utf8");
    const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
    const faux = fauxProvider();
    const reply = (context: Context) => {
      const user = context.messages.findLast(m => m.role === "user")!;
      const prompt = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("");
      if (context.tools?.some(t => t.name === "finalize_translation_batch")) {
        const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
        return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
          translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: translated })), notes: [] })) }), { stopReason: "toolUse" });
      }
      const p = JSON.parse(prompt);
      assert.notEqual(p.qualityReviewStage, "verification");
      const values = p.event === "plan" ? [p.windows.length, [], [], "Translate."] : ["accept", [],
        (p.priorIssues ?? []).map(() => [status, p.source[0].evidence[0].id, p.candidate[0].evidence[0].id, "Meaning is preserved in context."]), "Checked."];
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values }), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 6 }, () => reply));
    const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "grounded", protocolVersion: "test" },
      model: { ...faux.getModel(), provider: "folioloom-deepseek" }, streamFn: faux.provider.streamSimple.bind(faux.provider),
      supervisorMode: "bounded" as const, deliveryMode: "standard" as const, maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
    await runBook(options);
    const writable = new LosslessBookStore(options.storePath);
    let active;
    try {
      active = writable.activeTranslations("grounded");
      new QualityQueue("grounded", writable).defer({ windowId: active[0]!.windowId, candidateHash: supervisionCandidateHash(active),
        issues: [{ code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: active[0]!.blockId, issueKey: "wording", repairable: true,
          message: "Check the wording.", evidence: { sourceQuote: original, targetQuote: translated, problem: "Check the wording." } }] });
    } finally { writable.close(); }
    const calls = faux.state.callCount;
    await runBook(options);
    assert.equal(faux.state.callCount, calls + 1);
    const store = LosslessBookStore.openReadOnly(options.storePath);
    try {
      const item = new QualityQueue("grounded", store).items()[0]!;
      assert.equal(item.state, "resolved");
      assert.equal(item.closure?.policy, "issue-closure-2");
      assert.equal(item.closure?.dispositions[0]?.status, status);
      assert.equal(item.closure?.verificationDecisionId, undefined);
      assert.deepEqual(store.activeTranslations("grounded"), active);
      assert.ok(auditLosslessBookExport(store, "grounded").audit.strictExportable);
      assert.ok(store.loadTokenLedgerEvents("grounded").filter(e => e.type === "settled").every(e => e.usageComplete));
    } finally { store.close(); }
  });
}
