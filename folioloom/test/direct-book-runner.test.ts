import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport } from "../src/report.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { loadGlossary } from "../src/glossary/glossary-profile.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { directHash, directNameCandidates, DIRECT_SYSTEM_PROMPT, DIRECT_TRANSLATION_VERSION, DIRECT_MEMORY_VERSION, DIRECT_MEMORY_SYSTEM_PROMPT } from "../src/fullbook/direct-translation.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { directRecoveryStatus, releaseDirectTransportRecovery, type DirectTransportRelease } from "../src/fullbook/direct-recovery.js";
import { RunLease } from "../src/kernel/run-lease.js";

function releaseRequest(path: string, baseAttemptLimit = 1): DirectTransportRelease {
  const db = LosslessBookStore.openReadOnly(path);
  try {
    const record = db.directRecords("direct").findLast(r => r.kind === "request")!;
    const identity = (db.listTranslationRuns()[0]!.metadata as any).workflow.identityHash;
    return { requestId: "restore-transport", windowId: record.windowId, expectedLastRequestId: record.id,
      expectedIdentityHash: identity, baseAttemptLimit, additionalAttempts: 1, reason: "Fixture connection restored" };
  } finally { db.close(); }
}

test("explicit transport release adds only its bounded durable allowance and preserves unknown usage", async () => {
  const f = await fixture(false, false, false);
  f.faux.setResponses([() => { throw new Error("Connection error."); }, reply]);
  const options = { ...f.options, maxWindows: 1, maxAttempts: 1 };
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 1);
  const request = releaseRequest(options.storePath);
  releaseDirectTransportRecovery(options.storePath, "direct", request);
  releaseDirectTransportRecovery(options.storePath, "direct", request);
  const result = await runBook({ ...options, maxAttempts: undefined });
  assert.equal(result.status.completedWindows, 1); assert.equal(f.faux.state.callCount, 2);
  const db = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal(db.directRecords("direct").filter(r => r.kind === "transport_release").length, 1);
    assert.equal(directRecoveryStatus(db, "direct").baseAttemptLimit, 1);
    assert.equal(db.loadTokenLedgerEvents("direct").filter(e => e.type === "settled" && !e.usageComplete).length, 1);
    assert.equal(auditLosslessBookExport(db, "direct").audit.strictExportable, false);
  } finally { db.close(); }
});

test("eight default attempts resume nested splits without regenerating successful subgroups", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-direct-splits-"));
  const source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 8 }, (_, i) => `Mira waited beside gate number ${i + 1}.`).join("\n\n"), "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const requested: string[][] = [];
  faux.setResponses(Array.from({ length: 16 }, () => (context: Context) => {
    const p = payload(context);
    requested.push(p.paragraphs.map(([id]: [string]) => id));
    if (p.paragraphs.length > 2) return fauxAssistantMessage("{truncated");
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "米拉在门边等候。"]), names: [] }));
  }));
  const options = { workflow: "direct" as const, manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "direct", protocolVersion: "test" }, model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
    maxWindows: 1, maxConcurrency: 1, schedulerMode: "active" as const };
  await assert.rejects(() => runBook({ ...options, maxAttempts: 4 }), /DIRECT_RECOVERY_PAUSED/u);
  assert.deepEqual(requested.map(p => p.length), [8, 4, 2, 2]);
  let db = LosslessBookStore.openReadOnly(options.storePath);
  const saved = db.directRecords("direct").filter(r => r.kind === "response");
  const oldIdentity = (db.listTranslationRuns()[0]!.metadata as any).workflow.identityHash;
  db.close();
  const result = await runBook(options);
  assert.equal(result.status.completedWindows, 1);
  assert.deepEqual(requested.map(p => p.length), [8, 4, 2, 2, 4, 2, 2]);
  assert.equal(new Set(requested.filter(p => p.length === 2).map(p => JSON.stringify(p))).size, 4);
  db = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal((db.listTranslationRuns()[0]!.metadata as any).workflow.identityHash, oldIdentity);
    assert.deepEqual(db.directRecords("direct").filter(r => saved.some(s => s.id === r.id)), saved);
    assert.equal(db.loadTokenLedgerEvents("direct").filter(e => e.type === "settled").length, 7);
    assert.equal(auditLosslessBookExport(db, "direct").audit.strictExportable, true);
    assert.equal(directRecoveryStatus(db, "direct").baseAttemptLimit, 8);
  } finally { db.close(); }
  await runBook(options);
  assert.equal(requested.length, 7);
  await assert.rejects(() => runBook({ ...options, maxAttempts: 17 }), /cannot exceed 16/u);
});

test("transport recovery remains bounded at sixteen lifetime attempts", async () => {
  const f = await fixture(false, false, false);
  f.faux.setResponses([() => { throw new Error("Connection error."); }]);
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 1, maxAttempts: 1 }), /DIRECT_RECOVERY_PAUSED/u);
  const request = releaseRequest(f.options.storePath, 8);
  const seedThrough = (end: number) => {
    const db = new LosslessBookStore(f.options.storePath);
    try {
      const count = db.directRecords("direct").filter(r => r.kind === "request").length;
      for (let i = count; i < end; i++) {
        const id = `synthetic-transport-${i}`;
        db.appendDirectRecord("direct", { id, kind: "request", windowId: request.windowId, key: directHash(id), at: i, payload: {} });
        db.appendDirectRecord("direct", { id: `${id}:response`, kind: "response", windowId: request.windowId, key: directHash(id), at: i,
          payload: { requestId: id, stopReason: "error" } });
      }
    } finally { db.close(); }
  };
  for (const attempts of [8, 12]) {
    seedThrough(attempts);
    const current = releaseRequest(f.options.storePath, 8);
    const grant = releaseDirectTransportRecovery(f.options.storePath, "direct", { ...current, requestId: `grant-${attempts}`, additionalAttempts: 4 });
    assert.equal(grant.payload.attemptCeiling, attempts + 4);
  }
  seedThrough(16);
  const last = releaseRequest(f.options.storePath, 8);
  assert.throws(() => releaseDirectTransportRecovery(f.options.storePath, "direct", { ...last, requestId: "over-cap" }), /lifetime attempt cap/u);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    const status = directRecoveryStatus(db, "direct");
    assert.equal(status.lifetimeAttemptCap, 16);
    assert.equal(status.windows[0]!.releaseEligible, false);
    assert.equal(status.windows[0]!.remaining, 0);
  } finally { db.close(); }
});

test("spent transport release cannot mint attempts on ordinary resume or duplicate release", async () => {
  const f = await fixture(); f.faux.setResponses(Array.from({ length: 5 }, () => () => { throw new Error("Connection error."); }));
  const options = { ...f.options, maxWindows: 1, maxAttempts: 1 };
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  const request = releaseRequest(options.storePath);
  releaseDirectTransportRecovery(options.storePath, "direct", request);
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 2);
  releaseDirectTransportRecovery(options.storePath, "direct", request);
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 2);
  assert.throws(() => releaseDirectTransportRecovery(options.storePath, "direct", { ...request, requestId: "stale" }), /stale/u);
});

test("transport release rejects semantic failures, stale identities and active writer leases", async () => {
  const f = await fixture(); let calls = 0;
  f.faux.setResponses(Array.from({ length: 5 }, () => (context: Context) => {
    if (++calls === 1) return reply(context);
    const p = payload(context);
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "蜜拉等候着。"]), names: [["Mira", "蜜拉"]] }));
  }));
  const options = { ...f.options, maxWindows: 1, maxAttempts: 1 };
  await runBook(options); await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  const request = releaseRequest(options.storePath);
  assert.throws(() => releaseDirectTransportRecovery(options.storePath, "direct", request), /transport/u);
  assert.throws(() => releaseDirectTransportRecovery(options.storePath, "direct", { ...request, expectedIdentityHash: "0".repeat(64) }), /identity/u);
  const lease = RunLease.acquire(options.storePath + ".run.lock", "lossless:direct");
  try { assert.throws(() => releaseDirectTransportRecovery(options.storePath, "direct", request), /active run lease/u); }
  finally { lease.release(); }
});

function payload(context: Context) {
  assert.equal(context.tools?.length ?? 0, 0, "direct translation has no model tools or supervisor");
  const user = context.messages.findLast(m => m.role === "user")!;
  return JSON.parse(typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
function reply(context: Context) {
  const p = payload(context);
  return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id, source]: [string, string]) => [id,
    `米拉在第${id.replace(/\D/gu, "")}段等候。` + "旅人静静站在花园门旁，等候雨停。".repeat(Math.max(1, Math.floor(source.length / 45)))]),
    names: (p.namingCandidates ?? []).filter((n: any) => n.source === "Mira").map((n: any) => [n.id, "米拉"]) }));
}
function typedName(p: any, source: string, target: string) {
  const paragraph = p.paragraphs.find(([, text]: [string, string]) => text.includes(source));
  return { source, target, kind: "person", scope: "book", evidence: { paragraphId: paragraph[0], quote: source } };
}

test("typed waves use source-order decisions and repair all conflicts before advancing the snapshot", async () => {
  const f = await fixture(false, true, false); let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => async (context: Context) => {
    const p = payload(context), n = ++calls;
    if (n === 1) return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "旅人等候着。"]), names: [] }));
    if (n === 2) await new Promise(r => setTimeout(r, 30));
    const target = n === 3 ? "蜜拉" : "米拉";
    const yara = n === 3 ? "雅菈" : "雅拉";
    if (n >= 4) {
      assert.ok(p.sharedNames.some((x: any) => x.source === "Mira" && x.target === "米拉"));
      assert.ok(p.sharedNames.some((x: any) => x.source === "Yara" && x.target === "雅拉"));
    }
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, target + "和" + yara + "等候着。"]),
      names: [typedName(p, "Mira", target), typedName(p, "Yara", yara)] }));
  }));
  const result = await runBook({ ...f.options, maxWindows: 4 });
  assert.equal(result.status.completedWindows, 4); assert.equal(calls, 5);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    const conflicts = db.directRecords("direct").filter(r => r.kind === "name_conflict");
    assert.equal(conflicts.length, 1); assert.equal((conflicts[0]!.payload.conflicts as any[]).length, 2);
    assert.equal(db.directNames("direct").length, 2); assert.equal(db.qualityRecords("direct").length, 0);
  } finally { db.close(); }
});

test("typed wave interruption retains peer drafts and resumes with lower concurrency without re-generation", async () => {
  const f = await fixture(false, false, false); let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (context: Context) => {
    const p = payload(context), n = ++calls;
    if (n === 2) throw new Error("401 Unauthorized");
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "米拉等候着。"]), names: [typedName(p, "Mira", "米拉")] }));
  }));
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 3 }), /Unauthorized/u);
  assert.equal(calls, 3);
  const result = await runBook({ ...f.options, maxWindows: 2, maxConcurrency: 1 });
  assert.equal(result.status.completedWindows, 3); assert.equal(calls, 4);
});

test("typed naming plan and valid peer checkpoints survive a commit crash without extra calls", async t => {
  const f = await fixture(false, false, false); let calls = 0, staged = 0;
  f.faux.setResponses(Array.from({ length: 12 }, () => (context: Context) => {
    calls++; const p = payload(context);
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "米拉等候着。"]), names: [typedName(p, "Mira", "米拉")] }));
  }));
  const stage = LosslessBookStore.prototype.stageWindow;
  const crash = t.mock.method(LosslessBookStore.prototype, "stageWindow", function(this: LosslessBookStore, input: Parameters<typeof stage>[0]) {
    if (++staged === 2) throw new Error("typed wave commit crash");
    return stage.call(this, input);
  });
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 3 }), /typed wave commit crash/u);
  assert.equal(calls, 3); crash.mock.restore();
  const store = LosslessBookStore.openReadOnly(f.options.storePath);
  const remaining = store.allWindows("direct").filter(w => w.ordinal < 3 && w.status !== "completed").length;
  store.close();
  const result = await runBook({ ...f.options, maxWindows: remaining, maxConcurrency: 1 });
  assert.equal(result.status.completedWindows, 3); assert.equal(calls, 3);
});
async function fixture(namedHeading = false, secondName = false, legacy = true) {
  const root = mkdtempSync(join(tmpdir(), "folioloom-direct-"));
  const source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 6 }, (_, i) => `Chapter ${i + 1}${namedHeading ? " Mira" : ""}\n\n` + `Mira${secondName ? " and Yara" : ""} waited at gate number ${i + 1}. `.repeat(60)).join("\n\n"), "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "direct", protocolVersion: "test" },
    workflow: "direct" as const, model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 800 }, maxConcurrency: 2, hardDeadlineMs: 10000 };
  if (legacy) {
    const context = BookContext.openLossless({ manifestPath: imported.manifestPath });
    const plan = planBookWindows(context.losslessBlocks, { ...options.windowOptions, targetSourceTokens: 800, protocolVersion: "test" });
    const identity = { version: DIRECT_MEMORY_VERSION, promptHash: directHash(DIRECT_MEMORY_SYSTEM_PROMPT), source: context.sourceLedger.sourceVersion,
      plan, candidates: directNameCandidates(context.losslessBlocks, context.languageProfile), names: [], style: null,
      model: { id: options.model.id, provider: options.model.provider, api: options.model.api, baseUrl: options.model.baseUrl,
        contextWindow: options.model.contextWindow, maxTokens: options.model.maxTokens, effort: null, thinkingLevel: "high" }, taskContext: null };
    const db = new LosslessBookStore(options.storePath);
    try {
      db.registerSource(context.certifiedSource!); db.replaceDerivedPlan(context.sourceLedger.sourceVersion, { blocks: context.losslessBlocks, annotations: context.annotations });
      const initial = createKnowledgeSnapshot("direct", []);
      db.createTranslationRun({ runId: "direct", sourceVersion: context.sourceLedger.sourceVersion, protocolVersion: "test", modelId: options.model.id,
        metadata: { workflow: { name: "direct", version: DIRECT_MEMORY_VERSION, identityHash: directHash(identity) } }, initialSnapshotId: initial.id, initialSnapshot: initial });
    } finally { db.close(); context.close(); }
  }
  return { faux, options };
}

test("direct seed and translation need one response per window, persist names, and resume without analysis", async () => {
  const f = await fixture(); let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (context: Context) => {
    const p = payload(context); calls++;
    if (calls === 1) assert.ok(p.namingCandidates);
    else { assert.equal(p.namingCandidates, undefined); assert.ok(p.sharedNames.some((n: any) => n.source === "Mira" && n.target === "米拉")); }
    return reply(context);
  }));
  const first = await runBook({ ...f.options, maxWindows: 1 });
  assert.equal(first.status.completedWindows, 1); assert.equal(calls, 1);
  const result = await runBook(f.options);
  assert.equal(result.status.completedWindows, result.status.totalWindows);
  assert.equal(calls, result.status.totalWindows);
  const store = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    assert.equal(store.supervisionRecords("direct").length, 0);
    assert.equal(store.qualityRecords("direct").length, 0);
    assert.equal(store.recoveryRecords("direct").length, 0);
    assert.equal(auditLosslessBookExport(store, "direct").audit.strictExportable, true);
  } finally { store.close(); }
  await runBook(f.options); assert.equal(calls, result.status.totalWindows);
  await assert.rejects(() => runBook({ ...f.options, workflow: "supervised" }), /workflow/u);
});

test("direct worker pool refills before a slower earlier result commits", async () => {
  const f = await fixture(); let calls = 0, filled = false;
  let release!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  f.faux.setResponses(Array.from({ length: 30 }, () => async (context: Context) => {
    const n = ++calls;
    if (n === 4) { filled = true; release(); }
    if (n === 2) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no free-slot refill")), 1500); })]); }
      finally { clearTimeout(timer); }
    }
    return reply(context);
  }));
  const result = await runBook({ ...f.options, maxWindows: 4 });
  assert.equal(filled, true); assert.equal(result.status.completedWindows, 4); assert.equal(calls, 4);
});

test("direct transient unknown-usage response retries but cannot become strict accounting success", async () => {
  const f = await fixture();
  const fault = () => { throw new Error("Connection error."); };
  f.faux.setResponses([fault, ...Array.from({ length: 30 }, () => reply)]);
  const result = await runBook(f.options);
  assert.equal(result.status.completedWindows, result.status.totalWindows);
  assert.equal(f.faux.state.callCount, result.status.totalWindows + 1);
  const store = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    const settlements = store.loadTokenLedgerEvents("direct").filter(e => e.type === "settled");
    assert.equal(settlements.filter(e => !e.usageComplete).length, 1);
    assert.equal(settlements.find(e => !e.usageComplete)?.actualTokens, 0);
    assert.equal(auditLosslessBookExport(store, "direct").audit.strictExportable, false);
  } finally { store.close(); }
});

test("a durable response is reused after a crash before saving the window checkpoint", async t => {
  const f = await fixture();
  f.faux.setResponses(Array.from({ length: 30 }, () => reply));
  const append = LosslessBookStore.prototype.appendDirectRecord;
  const crash = t.mock.method(LosslessBookStore.prototype, "appendDirectRecord", function(this: LosslessBookStore, runId: string, record: import("../src/fullbook/direct-translation.js").DirectRecord) {
    if (record.kind === "checkpoint") throw new Error("fixture crash after response");
    return append.call(this, runId, record);
  });
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 1 }), /fixture crash/u);
  assert.equal(f.faux.state.callCount, 1);
  crash.mock.restore();
  const resumed = await runBook({ ...f.options, maxWindows: 1 });
  assert.equal(resumed.status.completedWindows, 1);
  assert.equal(f.faux.state.callCount, 1, "replay the already recorded response without contacting the provider");
});

test("a crash after reservation but before dispatch uses a fresh ledger id on resume", async t => {
  const f = await fixture(); f.faux.setResponses(Array.from({ length: 30 }, () => reply));
  const append = LosslessBookStore.prototype.appendDirectRecord;
  const crash = t.mock.method(LosslessBookStore.prototype, "appendDirectRecord", function(this: LosslessBookStore, runId: string, record: import("../src/fullbook/direct-translation.js").DirectRecord) {
    if (record.kind === "request") throw new Error("fixture reservation crash");
    return append.call(this, runId, record);
  });
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 1 }), /fixture reservation crash/u);
  assert.equal(f.faux.state.callCount, 0);
  crash.mock.restore();
  const resumed = await runBook({ ...f.options, maxWindows: 1 });
  assert.equal(resumed.status.completedWindows, 1); assert.equal(f.faux.state.callCount, 1);
  const store = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.equal(store.loadTokenLedgerEvents("direct").filter(e => e.type === "settled" && !e.usageComplete).length, 0); }
  finally { store.close(); }
});

test("authentication failure stops dispatch while completed parallel checkpoints survive resume", async () => {
  const f = await fixture(); let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (context: Context) => {
    if (++calls === 2) throw new Error("401 Unauthorized");
    return reply(context);
  }));
  await assert.rejects(() => runBook(f.options), /Unauthorized/u);
  const stopped = calls;
  assert.ok(stopped <= 3, "no automatic authentication retry");
  const resumed = await runBook(f.options);
  assert.equal(resumed.status.completedWindows, resumed.status.totalWindows);
  assert.equal(calls, resumed.status.totalWindows + 1, "successful parallel work is not regenerated");
});

test("exhausted direct request allowance cannot be renewed by restarting", async () => {
  const f = await fixture();
  f.faux.setResponses([() => { throw new Error("Connection error."); }]);
  const options = { ...f.options, maxAttempts: 1 };
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 1);
});

test("structural truncation reuses saved sibling groups and their seed names after a crash", async t => {
  const f = await fixture(true); let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (context: Context) => {
    const p = payload(context);
    if (++calls === 1 && p.paragraphs.length > 1) return fauxAssistantMessage('{"paragraphs":[', { stopReason: "length" });
    if (calls === 3) assert.ok(p.sharedNames.some((n: any) => n.source === "Mira" && n.target === "米拉"));
    return reply(context);
  }));
  const append = LosslessBookStore.prototype.appendDirectRecord;
  const crash = t.mock.method(LosslessBookStore.prototype, "appendDirectRecord", function(this: LosslessBookStore, runId: string, record: import("../src/fullbook/direct-translation.js").DirectRecord) {
    if (record.kind === "checkpoint") throw new Error("fixture fragmented checkpoint crash");
    return append.call(this, runId, record);
  });
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 1 }), /fixture fragmented checkpoint crash/u);
  assert.equal(calls, 3);
  crash.mock.restore();
  const result = await runBook({ ...f.options, maxWindows: 1 });
  assert.equal(result.status.completedWindows, 1);
  assert.equal(calls, 3);
  await runBook({ ...f.options, maxWindows: 0 }); assert.equal(calls, 3);
});

test("direct dispatch honors the explicit in-flight token cap before any provider call", async () => {
  const f = await fixture(); f.faux.setResponses(Array.from({ length: 30 }, () => reply));
  await assert.rejects(() => runBook({ ...f.options, maxInFlightTokens: 1 }), /DIRECT_INPUT_CAPACITY/u);
  assert.equal(f.faux.state.callCount, 0);
});

test("new names learned after the seed persist in SQLite and are loaded on resume", async () => {
  const f = await fixture(); let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (context: Context) => {
    const p = payload(context); calls++;
    if (calls === 1) return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "米拉等候着。"]), names: [] }));
    if (calls === 2) return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "米拉等候着。"]), names: [["Mira", "米拉"]] }));
    assert.ok(p.sharedNames.some((n: any) => n.source === "Mira" && n.target === "米拉"), "later translation reads a learned name");
    return reply(context);
  }));
  await runBook({ ...f.options, maxConcurrency: 1, maxWindows: 2 });
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.ok(db.directRecords("direct").some(r => (r.kind as string) === "names" && (r.payload.names as any[]).some(n => n.source === "Mira"))); }
  finally { db.close(); }
  await runBook(f.options);
});

test("concurrent naming conflicts retain the first durable decision and only regenerate the conflicting window", async () => {
  const f = await fixture(); let calls = 0, repairs = 0;
  let release!: () => void;
  const peerStarted = new Promise<void>(r => { release = r; });
  f.faux.setResponses(Array.from({ length: 40 }, () => async (context: Context) => {
    const p = payload(context), n = ++calls;
    if (n === 1) return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "旅人等候着。"]), names: [] }));
    if (n === 2) await peerStarted;
    if (n === 3) { release(); await new Promise(r => setTimeout(r, 25)); }
    const target = n === 3 ? "蜜拉" : "米拉";
    if (n > 3 && p.sharedNames.some((x: any) => x.source === "Mira")) repairs++;
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, target + "等候着。"]), names: [["Mira", target]] }));
  }));
  const result = await runBook({ ...f.options, maxWindows: 3 });
  assert.equal(result.status.completedWindows, 3);
  assert.equal(calls, 4, "one extra translation for the stale conflicting response");
  assert.equal(repairs, 1);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    const decisions = db.directRecords("direct").filter(r => (r.kind as string) === "names");
    assert.ok(decisions.length > 0);
    assert.ok(decisions.every(r => (r.payload.names as any[]).every(n => n.target === "米拉")));
    assert.equal(db.qualityRecords("direct").length, 0);
  } finally { db.close(); }
  await runBook({ ...f.options, maxWindows: 0 }); assert.equal(calls, 4);
});

test("an explicit glossary does not disable learning, and a conflicting proposal cannot overwrite it", async () => {
  const f = await fixture(false, true, false); let calls = 0;
  const path = f.options.storePath + ".glossary.json";
  writeFileSync(path, JSON.stringify({ schema: "folioloom-glossary-1", terms: [{ source: "Mira", target: "米拉", policy: "locked" }] }));
  const context = BookContext.openLossless({ manifestPath: f.options.manifestPath });
  const glossary = loadGlossary({ glossaryPath: path, blocks: context.losslessBlocks, profile: context.languageProfile }); context.close();
  f.faux.setResponses(Array.from({ length: 10 }, () => (context: Context) => {
    const p = payload(context), n = ++calls;
    assert.ok(p.sharedNames.some((x: any) => x.source === "Mira" && x.target === "米拉"));
    const target = n === 1 ? "蜜拉" : "米拉";
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, target + "和雅拉等候着。"]), names: [typedName(p, "Mira", target), typedName(p, "Yara", "雅拉")] }));
  }));
  await runBook({ ...f.options, glossary, maxWindows: 1 });
  assert.equal(calls, 2);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.deepEqual(db.directNames("direct").map(n => ({ source: n.source, target: n.target })), [{ source: "Yara", target: "雅拉" }]); }
  finally { db.close(); }
  await runBook({ ...f.options, glossary, maxWindows: 1 });
  assert.equal(calls, 3);
});

test("a crash after learning but before staging replays both translation and naming without new calls", async t => {
  const f = await fixture(); f.faux.setResponses(Array.from({ length: 30 }, () => reply));
  const crash = t.mock.method(LosslessBookStore.prototype, "stageWindow", () => { throw new Error("fixture stage crash"); });
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 1 }), /fixture stage crash/u);
  assert.equal(f.faux.state.callCount, 1); crash.mock.restore();
  const result = await runBook({ ...f.options, maxWindows: 1 });
  assert.equal(result.status.completedWindows, 1); assert.equal(f.faux.state.callCount, 1);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.deepEqual(db.directNames("direct"), [{ source: "Mira", target: "米拉" }]); }
  finally { db.close(); }
});

test("conflicting naming retries cannot refresh their allowance on restart", async () => {
  const f = await fixture(); let calls = 0;
  f.faux.setResponses(Array.from({ length: 10 }, () => (context: Context) => {
    if (++calls === 1) return reply(context);
    const p = payload(context);
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "蜜拉等候着。"]), names: [["Mira", "蜜拉"]] }));
  }));
  await runBook({ ...f.options, maxWindows: 1, maxAttempts: 2 });
  const options = { ...f.options, maxWindows: 1, maxAttempts: 2 };
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(calls, 3);
  await assert.rejects(() => runBook(options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(calls, 3);
});

test("legacy recovery checks all saved responses against current names after context changes without refreshing allowance", async () => {
  const f = await fixture(); f.faux.setResponses([reply]);
  await runBook({ ...f.options, maxWindows: 1 });
  const db = new LosslessBookStore(f.options.storePath);
  try {
    const window = db.pendingWindows("direct")[0]!;
    const context = BookContext.openLossless({ manifestPath: f.options.manifestPath });
    const { directParagraphs } = await import("../src/fullbook/direct-translation.js");
    const paragraphs = directParagraphs(context.losslessBlocks.filter(b => window.blockIds.includes(b.id)));
    context.close();
    for (let i = 0; i < 4; i++) {
      const id = `historical:${i}`, target = i === 3 ? "米拉" : "蜜拉";
      db.appendDirectRecord("direct", { id, kind: "request", windowId: window.windowId, key: directHash("older-context"), at: Date.now(),
        payload: { paragraphIds: paragraphs.map(p => p.id), seed: false } });
      db.appendDirectRecord("direct", { id: id + ":response", kind: "response", windowId: window.windowId, key: directHash("older-context"), at: Date.now(),
        payload: { requestId: id, stopReason: "stop", text: JSON.stringify({ paragraphs: paragraphs.map(p => [p.id, target + "等候着。"]), names: [["Mira", target]] }) } });
    }
  } finally { db.close(); }
  const result = await runBook({ ...f.options, maxWindows: 1 });
  assert.equal(result.status.completedWindows, 2);
  assert.equal(f.faux.state.callCount, 1, "cached compatible response uses no provider call even at the original limit");
  const check = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    assert.equal(check.directRecords("direct").filter(r => r.kind === "request").length, 5);
    assert.equal(check.loadTokenLedgerEvents("direct").filter(e => e.type === "settled").length, 1);
    assert.ok(check.directRecords("direct").some(r => r.kind === "replay" && r.payload.requestId === "historical:3"));
  } finally { check.close(); }
});

test("stored version-one runs retain their original prompt, identity and frozen-name behavior", async () => {
  const f = await fixture(false, false, false);
  const context = BookContext.openLossless({ manifestPath: f.options.manifestPath });
  const windows = planBookWindows(context.losslessBlocks, { ...f.options.windowOptions, targetSourceTokens: 800, protocolVersion: "test" });
  const identity = { version: DIRECT_TRANSLATION_VERSION, promptHash: directHash(DIRECT_SYSTEM_PROMPT), source: context.sourceLedger.sourceVersion,
    plan: windows, candidates: directNameCandidates(context.losslessBlocks, context.languageProfile), names: [], style: null,
    model: { id: f.options.model.id, provider: f.options.model.provider, api: f.options.model.api, baseUrl: f.options.model.baseUrl,
      contextWindow: f.options.model.contextWindow, maxTokens: f.options.model.maxTokens, effort: null, thinkingLevel: "high" }, taskContext: null };
  const db = new LosslessBookStore(f.options.storePath);
  try {
    db.registerSource(context.certifiedSource!);
    db.replaceDerivedPlan(context.sourceLedger.sourceVersion, { blocks: context.losslessBlocks, annotations: context.annotations });
    const snapshot = createKnowledgeSnapshot("direct", []);
    db.createTranslationRun({ runId: "direct", sourceVersion: context.sourceLedger.sourceVersion, protocolVersion: "test", modelId: f.options.model.id,
      metadata: { workflow: { name: "direct", version: DIRECT_TRANSLATION_VERSION, identityHash: directHash(identity) } }, initialSnapshotId: snapshot.id, initialSnapshot: snapshot });
  } finally { db.close(); context.close(); }
  f.faux.setResponses(Array.from({ length: 30 }, () => (context: Context) => { assert.equal(context.systemPrompt, DIRECT_SYSTEM_PROMPT); return reply(context); }));
  const result = await runBook(f.options); assert.equal(result.outcome, "completed");
  const check = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.equal(check.directRecords("direct").filter(r => r.kind === "names" || r.kind === "name_context").length, 0); }
  finally { check.close(); }
});
