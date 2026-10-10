import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport, writeLosslessBookArtifacts } from "../src/report.js";
import { QualityQueue } from "../src/fullbook/delivery-policy.js";
import { supervisionCandidateHash } from "../src/domain/supervision.js";
import { writeLosslessBookEpub } from "../src/export/epub-writer.js";
import { verifyExport } from "../src/export/export-verifier.js";

async function fixture(translate = true, supervise = false) {
  const root = mkdtempSync(join(tmpdir(), "folioloom-delivery-boundary-"));
  const sourcePath = join(root, "source.txt");
  const source = "the quiet traveler waited beside the gate until the rain stopped. the keeper silently watched the empty road.";
  const target = "那位安静的旅人在大门旁等候，直到雨停下来。守门人默默望着空荡荡的道路。";
  writeFileSync(sourcePath, source, "utf8");
  const imported = await importSource({ sourcePath, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const response = (context: Context) => {
    const user = context.messages.findLast(m => m.role === "user")!;
    const raw = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("");
    const answer = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) return answer("submit_lexical_anchors", { anchors: [], entityLinks: [] });
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const p = JSON.parse(raw);
      return answer("submit_supervisor_decision", { action: p.event === "plan" ? "translate" : "accept",
        windowIds: p.windows.map((w: any) => w.windowId), reviewBlockIds: [], guidance: [], issues: [], reason: "Checked." });
    }
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(raw)![1]!);
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: target })), notes: [] })) });
  };
  faux.setResponses(Array.from({ length: 5 }, () => response));
  const storePath = join(root, "book.db");
  const options = { manifestPath: imported.manifestPath, storePath, runMeta: { runId: "delivery", protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), supervisorMode: supervise ? "bounded" as const : "off" as const,
    deliveryMode: "standard" as const, maxConcurrency: 1, maxAttempts: 1, ...(translate ? {} : { maxWindows: 0 }) };
  await runBook(options);
  const store = new LosslessBookStore(storePath);
  return { root, store, target, source, options, faux };
}

for (const state of ["pending", "blocked", "unresolved"] as const) {
  test(`complete standard output retains ${state} semantic findings without claiming strict acceptance`, async () => {
    const f = await fixture();
    try {
      const active = f.store.activeTranslations("delivery"), queue = new QualityQueue("delivery", f.store);
      const item = queue.defer({ windowId: active[0]!.windowId, candidateHash: supervisionCandidateHash(active), issues: [
        { code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: active[0]!.blockId, issueKey: "wording", repairable: true,
          message: "Check the context-dependent rendering of keeper.", evidence: { sourceQuote: f.source, targetQuote: f.target, problem: "Check keeper." } },
      ] });
      if (state !== "pending") {
        queue.claimFinal(item.itemId);
        queue.finish(item.itemId, state, item.candidateHash, item.issues, "The bounded review retained this finding.");
      }
      const before = f.store.activeTranslations("delivery");
      const audit = auditLosslessBookExport(f.store, "delivery").audit;
      assert.equal(audit.structurallyComplete, true);
      assert.equal(audit.strictExportable, false);
      assert.equal(audit.deliveryReady, true);
      const paths = writeLosslessBookArtifacts(f.store, "delivery", join(f.root, "output"));
      paths.epub = await writeLosslessBookEpub(f.store, "delivery", join(f.root, "output", "book.epub"), { title: "A quiet road", language: "zh-CN" });
      assert.equal(verifyExport(paths, f.store, "delivery").ok, true);
      assert.ok(readFileSync(paths.qualityReport!, "utf8").includes(`"state": "${state}"`));
      assert.deepEqual(f.store.activeTranslations("delivery"), before);
      assert.throws(() => writeLosslessBookArtifacts(f.store, "delivery", join(f.root, "strict"), { deliveryMode: "strict" }));
    } finally { f.store.close(); }
  });
}

test("standard output keeps unknown historical usage visible without blocking complete text", async () => {
  const f = await fixture();
  try {
    f.store.appendTokenLedgerEvent("delivery", { type: "reserved", requestId: "historical", purpose: "supervision", taskIds: [], predictedTokens: 100, attempt: 0 });
    f.store.appendTokenLedgerEvent("delivery", { type: "dispatched", requestId: "historical" });
    f.store.appendTokenLedgerEvent("delivery", { type: "settled", requestId: "historical", actualTokens: 0, usageComplete: false, outcome: "failed" });
    const projection = f.store.loadSchedulerMetrics("delivery")!;
    f.store.saveSchedulerRunProjection("delivery", f.store.loadTokenLedger("delivery", {
      mode: projection.mode, profile: projection.profile, tokenIncreaseCap: 0.1, enforceDispatchLifecycle: true,
    }).toSchedulerRunReport());
    const audit = auditLosslessBookExport(f.store, "delivery").audit;
    assert.ok(audit.incidentCodes.includes("TOKEN_USAGE_INCOMPLETE"));
    assert.equal(audit.strictExportable, false);
    assert.equal(audit.deliveryReady, true);
    const paths = writeLosslessBookArtifacts(f.store, "delivery", join(f.root, "output"));
    assert.equal(verifyExport(paths, f.store, "delivery").ok, true);
    assert.ok(readFileSync(paths.audit, "utf8").includes("TOKEN_USAGE_INCOMPLETE"));
  } finally { f.store.close(); }
});

test("standard output still rejects missing source coverage", async () => {
  const f = await fixture(false);
  try {
    assert.equal(auditLosslessBookExport(f.store, "delivery").audit.deliveryReady, false);
    assert.throws(() => writeLosslessBookArtifacts(f.store, "delivery", join(f.root, "output")));
    await assert.rejects(() => writeLosslessBookEpub(f.store, "delivery", join(f.root, "book.epub"), { title: "Incomplete", language: "zh-CN" }));
  } finally { f.store.close(); }
});

test("exhausted final-review protocol becomes a reported warning and does not prevent whole-book delivery", async () => {
  const f = await fixture(true, true);
  const active = f.store.activeTranslations("delivery");
  new QualityQueue("delivery", f.store).defer({ windowId: active[0]!.windowId, candidateHash: supervisionCandidateHash(active), issues: [
    { code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: active[0]!.blockId, repairable: true,
      message: "Check keeper.", evidence: { sourceQuote: f.source, targetQuote: f.target, problem: "Check keeper." } },
  ] });
  f.store.close();
  f.faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Missing the decision tool.")));
  const result = await runBook(f.options);
  assert.equal(result.outcome, "completed_with_warnings");
  const store = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    assert.deepEqual(store.activeTranslations("delivery"), active);
    assert.equal(new QualityQueue("delivery", store).items()[0]!.state, "blocked");
    assert.equal(auditLosslessBookExport(store, "delivery").audit.deliveryReady, true);
  } finally { store.close(); }
  const calls = f.faux.state.callCount;
  assert.equal((await runBook(f.options)).outcome, "completed_with_warnings");
  assert.equal(f.faux.state.callCount, calls, "a warning is not an unbounded retry request");
});
