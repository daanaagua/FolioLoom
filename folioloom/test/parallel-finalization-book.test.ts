import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { QualityQueue } from "../src/fullbook/delivery-policy.js";

test("native finalization overlaps independent chapter slices and repairs, then resumes without calls", { timeout: 8000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-parallel-final-"));
  const source = join(root, "source.txt");
  writeFileSync(source, ["the baker did not leave the bakery.", "the sailor did not leave the harbor.",
    "the clerk did not leave the office.", "the painter did not leave the studio.",
    "the farmer did not leave the meadow.", "the guard did not leave the gate."].join("[[]]"), "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const gates = { chapter: Promise.withResolvers<void>(), quality: Promise.withResolvers<void>() };
  const active = { chapter: 0, quality: 0 }, peak = { chapter: 0, quality: 0 };
  let translations = 0;
  const reply = async (context: Context) => {
    const m = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("");
    const answer = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) return answer("submit_lexical_anchors", { anchors: [] });
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const p = JSON.parse(prompt);
      if (p.event === "plan") return answer("submit_supervisor_decision", { action: "translate", windowIds: p.windows.map((w: any) => w.windowId),
        reviewBlockIds: [], guidance: [], issues: [], reason: "Translate this batch." });
      const stage = p.chapterReview ? "chapter" : "quality";
      active[stage]++; peak[stage] = Math.max(peak[stage], active[stage]);
      if (active[stage] === 2) gates[stage].resolve();
      await gates[stage].promise;
      active[stage]--;
      return answer("submit_supervisor_decision", { action: p.chapterReview ? "revise" : "accept", windowIds: p.windows.map((w: any) => w.windowId),
        reviewBlockIds: [], guidance: [], reason: "Check the negation.",
        issues: p.chapterReview ? [{ blockId: p.source[0].blockId, sourceRef: p.source[0].evidence[0].id,
          targetRef: p.candidate[0].evidence[0].id, problem: "Restore negation." }] : [],
        ...(p.priorIssues ? { dispositions: p.priorIssues.map((i: any) => ({ issueId: i.issueId, status: "fixed",
          sourceRef: i.source.id, targetRef: i.current.id, note: "Negation restored." })) } : {}) });
    }
    if (context.tools?.some(t => t.name === "submit_repaired_translation")) {
      const candidate = JSON.parse(/FAILED CANDIDATE\n\n([^\n]+)/u.exec(prompt)![1]!);
      return answer("submit_repaired_translation", { translations: candidate.map((t: any) => ({ blockId: t.blockId, text: t.text.replace("已经离开", "没有离开") })), notes: [] });
    }
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: `第${++translations}处的人已经离开了那座建筑物。` })), notes: [] })) });
  };
  faux.setResponses(Array.from({ length: 40 }, () => reply));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "parallel-final", protocolVersion: "test" }, model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
    supervisorMode: "bounded" as const, chapterReviewMode: "bounded" as const, deliveryMode: "standard" as const,
    maxConcurrency: 2, maxWindowsPerRequest: 1, windowOptions: { maxBlocks: 1, maxSourceTokens: 1000 }, hardDeadlineMs: 6000 };
  await runBook(options);
  assert.deepEqual(peak, { chapter: 2, quality: 2 });
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal(store.chapterReviewCheckpoints("parallel-final").length, 2);
    assert.deepEqual(new QualityQueue("parallel-final", store).items().map(i => i.state), ["resolved", "resolved"]);
    const ledger = store.loadTokenLedgerEvents("parallel-final");
    assert.equal(ledger.filter(e => e.type === "reserved").length, ledger.filter(e => e.type === "settled").length);
  } finally { store.close(); }
  const calls = faux.state.callCount;
  await runBook(options);
  assert.equal(faux.state.callCount, calls);
});
