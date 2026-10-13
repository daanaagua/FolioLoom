import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport } from "../src/report.js";
import { directGenerationUsage } from "../src/fullbook/direct-compact.js";
import { directRecoveryStatus } from "../src/fullbook/direct-recovery.js";

test("preplanned fragments and one failed response finish beyond the old total-call cap and resume without calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-compact-")), source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 85 }, (_, i) => `quiet words remain here ${i}.`).join("\n\n"));
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider(); let calls = 0;
  faux.setResponses(Array.from({ length: 20 }, () => (context: Context) => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
    assert.ok(p.paragraphs.length <= 24);
    if (++calls === 1) return fauxAssistantMessage("{", { stopReason: "length" });
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "平静的话语留在这里。"]), names: [], nameUses: [] }));
  }));
  const options = { workflow: "direct" as const, manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "compact", protocolVersion: "test" }, model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 100, maxSourceTokens: 10000, targetSourceTokens: 10000 }, maxConcurrency: 1, maxAttempts: 2, schedulerMode: "active" as const };
  const result = await runBook(options);
  assert.equal(result.outcome, "completed"); assert.ok(calls > 2);
  const before = calls; await runBook(options); assert.equal(calls, before);
  const db = LosslessBookStore.openReadOnly(options.storePath);
  try {
    const records = db.directRecords("compact"), window = db.allWindows("compact")[0]!;
    assert.equal(directGenerationUsage(records, window.windowId).failures, 1);
    assert.equal(records.filter(r => r.kind === "generation_budget").length, 1);
    assert.equal(auditLosslessBookExport(db, "compact").audit.strictExportable, true);
  } finally { db.close(); }
});

async function boundedFixture() {
  const root = mkdtempSync(join(tmpdir(), "folioloom-compact-budget-")), source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 50 }, (_, i) => `quiet words remain here ${i}.`).join("\n\n"));
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const options = { workflow: "direct" as const, manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "budget", protocolVersion: "test" }, model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 100, maxSourceTokens: 10000, targetSourceTokens: 10000 }, maxConcurrency: 1, maxAttempts: 2 };
  return { options, faux };
}
const payload = (context: Context) => { const m = context.messages.findLast(m => m.role === "user")!;
  return JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("")); };
const translated = (p: any) => JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "平静的话语。"]), names: [], nameUses: [] });

test("failure credits persist when the override is omitted and exhausted resumes dispatch nothing", async () => {
  const f = await boundedFixture();
  f.faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("{", { stopReason: "length" })));
  await assert.rejects(() => runBook(f.options), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 2);
  await assert.rejects(() => runBook({ ...f.options, maxAttempts: undefined }), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 2);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { const state = directRecoveryStatus(db, "budget"); assert.equal(state.baseAttemptLimit, 2);
    assert.equal(state.windows[0]?.failedAttempts, 2); assert.equal(state.windows[0]?.remaining, 0); }
  finally { db.close(); }
});

test("the token envelope survives resume and cannot be renewed by raising the failure limit", async () => {
  const f = await boundedFixture();
  f.faux.setResponses([(context: Context) => fauxAssistantMessage(translated(payload(context)))]);
  const streamFn: StreamFn = (model, context, options) => {
    const out = createAssistantMessageEventStream();
    void (async () => { try { for await (const event of await f.options.streamFn(model, context, options)) {
      if (event.type === "done") {
        const db = LosslessBookStore.openReadOnly(f.options.storePath); let cap: number;
        try { cap = Number(db.directRecords("budget").find(r => r.kind === "generation_budget")!.payload.tokenLimit); } finally { db.close(); }
        event.message.usage = { ...event.message.usage, input: cap - 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: cap - 1 };
      }
      out.push(event);
    } } finally { out.end(); } })();
    return out;
  };
  await assert.rejects(() => runBook({ ...f.options, streamFn }), /DIRECT_TOKEN_BUDGET_EXHAUSTED/u);
  await assert.rejects(() => runBook({ ...f.options, streamFn, maxAttempts: 16 }), /DIRECT_TOKEN_BUDGET_EXHAUSTED/u);
  assert.equal(f.faux.state.callCount, 1);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.equal(db.directRecords("budget").filter(r => r.kind === "generation_budget").length, 1); }
  finally { db.close(); }
});

test("a crash before fragment acceptance replays the durable response without spending another request", async t => {
  const f = await boundedFixture(); let calls = 0;
  f.faux.setResponses(Array.from({ length: 10 }, () => (context: Context) => { calls++; return fauxAssistantMessage(translated(payload(context))); }));
  const append = LosslessBookStore.prototype.appendDirectRecord;
  const crash = t.mock.method(LosslessBookStore.prototype, "appendDirectRecord", function(this: LosslessBookStore, ...args: Parameters<typeof append>) {
    if (args[1].kind === "fragment_result") throw new Error("acceptance crash");
    return append.apply(this, args);
  });
  await assert.rejects(() => runBook(f.options), /acceptance crash/u); assert.equal(calls, 1); crash.mock.restore();
  const result = await runBook(f.options); assert.equal(result.outcome, "completed"); assert.equal(calls, 3);
  await assert.rejects(() => runBook({ ...f.options, namingReferences: [{ source: "quiet", target: "安静" }] }), /identity mismatch/u);
  assert.equal(calls, 3);
});
