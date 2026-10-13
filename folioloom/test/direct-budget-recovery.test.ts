import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxProvider, fauxAssistantMessage, createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { RunLease } from "../src/kernel/run-lease.js";
import { auditLosslessBookExport } from "../src/report.js";
import { main, parseArgs } from "../src/cli.js";
import * as recovery from "../src/fullbook/direct-recovery.js";

function readState(path: string) {
  const db = LosslessBookStore.openReadOnly(path);
  try { return { status: recovery.directRecoveryStatus(db, "budget"), records: db.directRecords("budget"), ledger: db.loadTokenLedgerEvents("budget") }; }
  finally { db.close(); }
}

async function exhaustedFixture(unknown = false) {
  const root = mkdtempSync(join(tmpdir(), "folioloom-budget-extension-")), source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 50 }, (_, i) => `quiet words remain here ${i}.`).join("\n\n"));
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const requested: string[][] = [];
  faux.setResponses(Array.from({ length: 20 }, (_, i) => (context: Context) => {
    if (unknown && i === 0) throw new Error("Connection error.");
    const message = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
    requested.push(p.paragraphs.map(([id]: [string]) => id));
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id]: [string]) => [id, "平静的话语。"]), names: [], nameUses: [] }));
  }));
  const storePath = join(root, "book.db"), delegate = faux.provider.streamSimple.bind(faux.provider);
  let spent = false;
  const streamFn: StreamFn = (model, context, options) => {
    const out = createAssistantMessageEventStream();
    void (async () => { try { for await (const event of await delegate(model, context, options)) {
      if (event.type === "done" && !spent) {
        const cap = readState(storePath).status.windows[0]!.tokenLimit!;
        event.message.usage = { ...event.message.usage, input: cap - 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: cap - 1 };
        spent = true;
      }
      out.push(event);
    } } finally { out.end(); } })();
    return out;
  };
  const options = { workflow: "direct" as const, manifestPath: imported.manifestPath, storePath,
    runMeta: { runId: "budget", protocolVersion: "test" }, model: faux.getModel(), streamFn,
    windowOptions: { maxBlocks: 100, maxSourceTokens: 10000, targetSourceTokens: 10000 }, maxConcurrency: 1, maxAttempts: 4 };
  await assert.rejects(() => runBook(options), /DIRECT_TOKEN_BUDGET_EXHAUSTED/u);
  const state = readState(storePath), window = state.status.windows[0]!;
  const request = { requestId: "grant-1", windowId: window.windowId, expectedLastRequestId: window.lastRequestId!,
    expectedIdentityHash: state.status.identityHash, expectedTokenLimit: window.tokenLimit!, additionalTokens: window.tokenLimit!, reason: "Additional bounded translation allowance" };
  return { options, faux, request, state, requested };
}

test("explicit token extensions are idempotent across restart and retain responses, unknown usage and failure credits", async () => {
  const f = await exhaustedFixture(true), beforeCalls = f.faux.state.callCount;
  const grant = recovery.extendDirectTokenBudget(f.options.storePath, "budget", f.request);
  assert.deepEqual(recovery.extendDirectTokenBudget(f.options.storePath, "budget", f.request), grant);
  let after = readState(f.options.storePath), window = after.status.windows[0]!;
  assert.equal(window.baseTokenLimit, f.request.expectedTokenLimit);
  assert.equal(window.additionalTokens, f.request.additionalTokens);
  assert.equal(window.tokenLimit, f.request.expectedTokenLimit + f.request.additionalTokens);
  assert.equal(window.chargedTokens, f.state.status.windows[0]!.chargedTokens);
  assert.equal(window.failedAttempts, f.state.status.windows[0]!.failedAttempts);
  assert.equal(window.maxCalls, f.state.status.windows[0]!.maxCalls);
  assert.equal(after.status.unknownUsage, 1);
  assert.equal(after.records.filter(r => r.kind === "token_budget_extension").length, 1);
  assert.deepEqual(after.ledger, f.state.ledger);
  assert.deepEqual(after.records.filter(r => r.kind !== "token_budget_extension"), f.state.records);
  assert.equal(f.faux.state.callCount, beforeCalls);
  const result = await runBook(f.options);
  assert.equal(result.outcome, "completed");
  const allIds = f.requested.flat();
  assert.equal(new Set(allIds).size, allIds.length, "successful fragments must never be regenerated");
  const completedCalls = f.faux.state.callCount;
  assert.deepEqual(recovery.extendDirectTokenBudget(f.options.storePath, "budget", f.request), grant);
  assert.throws(() => recovery.extendDirectTokenBudget(f.options.storePath, "budget", { ...f.request,
    requestId: "completed-grant", expectedTokenLimit: f.request.expectedTokenLimit + f.request.additionalTokens }), /pending window/u);
  await runBook(f.options);
  assert.equal(f.faux.state.callCount, completedCalls);
  after = readState(f.options.storePath);
  assert.equal(after.status.windows[0]!.tokenLimit, f.request.expectedTokenLimit + f.request.additionalTokens);
  assert.equal(after.status.unknownUsage, 1);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.ok(auditLosslessBookExport(db, "budget").audit.incidentCodes.includes("TOKEN_USAGE_INCOMPLETE")); }
  finally { db.close(); }
});

test("token extensions reject stale boundaries, conflicting IDs, invalid amounts and active writers", async () => {
  const f = await exhaustedFixture();
  const extend = (changes: Record<string, unknown>) => recovery.extendDirectTokenBudget(f.options.storePath, "budget", { ...f.request, ...changes });
  assert.throws(() => extend({ expectedIdentityHash: "0".repeat(64) }), /identity/u);
  assert.throws(() => extend({ expectedLastRequestId: "old-request" }), /stale/u);
  assert.throws(() => extend({ expectedTokenLimit: f.request.expectedTokenLimit + 1 }), /stale/u);
  assert.throws(() => extend({ windowId: "missing" }), /pending window/u);
  for (const additionalTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity])
    assert.throws(() => extend({ additionalTokens }), /invalid|limit/u);
  assert.throws(() => extend({ reason: "" }), /invalid/u);
  const lease = RunLease.acquire(`${resolve(f.options.storePath)}.run.lock`, "lossless:budget");
  try { assert.throws(() => extend({}), /active run lease/u); } finally { lease.release(); }
  assert.deepEqual(readState(f.options.storePath), f.state);
  extend({});
  assert.throws(() => extend({ additionalTokens: 1 }), /conflict/u);
  assert.throws(() => extend({ requestId: "grant-2" }), /stale/u);
  const updated = readState(f.options.storePath).status.windows[0]!;
  extend({ requestId: "grant-2", expectedTokenLimit: updated.tokenLimit, additionalTokens: 100 });
  assert.equal(readState(f.options.storePath).status.windows[0]!.tokenLimit, updated.tokenLimit! + 100);
});

test("a token extension does not release failure credits or permit repeated grants to renew budget", async () => {
  const f = await exhaustedFixture(true);
  recovery.extendDirectTokenBudget(f.options.storePath, "budget", f.request);
  const calls = f.faux.state.callCount;
  await assert.rejects(() => runBook({ ...f.options, maxAttempts: 1 }), /DIRECT_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, calls);
  const current = readState(f.options.storePath).status.windows[0]!;
  assert.equal(current.failedAttempts, 1);
  assert.equal(current.tokenLimit, f.request.expectedTokenLimit + f.request.additionalTokens);
});

test("CLI token extension requires an explicit input file", () => {
  const common = ["book", "direct-recovery", "extend-budget", "--store", "book.db", "--run", "fixture"];
  assert.equal(parseArgs([...common, "--input", "grant.json"]).command, "book-direct-recovery-extend-budget");
  assert.throws(() => parseArgs(common), /input/u);
  assert.throws(() => parseArgs([...common, "--input", "grant.json", "--max-attempts", "12"]), /unknown|unsupported|unexpected/u);
});

test("CLI applies and replays the same grant without provider calls", async t => {
  const f = await exhaustedFixture(), input = `${f.options.storePath}.grant.json`;
  writeFileSync(input, '\uFEFF' + JSON.stringify(f.request), "utf8");
  const outputs: string[] = [];
  t.mock.method(console, "log", (value: string) => outputs.push(value));
  const args = ["book", "direct-recovery", "extend-budget", "--store", f.options.storePath, "--run", "budget", "--input", input];
  await main(args);
  await main(args);
  assert.deepEqual(JSON.parse(outputs[0]!), JSON.parse(outputs[1]!));
  assert.equal(readState(f.options.storePath).records.filter(r => r.kind === "token_budget_extension").length, 1);
  assert.equal(f.faux.state.callCount, 1);
});

test("failed persistence leaves the budget unchanged and releases the writer lease", async t => {
  const f = await exhaustedFixture();
  const original = LosslessBookStore.prototype.appendDirectRecord;
  const failure = t.mock.method(LosslessBookStore.prototype, "appendDirectRecord", function(this: LosslessBookStore, ...args: Parameters<typeof original>) {
    if (args[1].kind === "token_budget_extension") throw new Error("injected persistence failure");
    return original.apply(this, args);
  });
  assert.throws(() => recovery.extendDirectTokenBudget(f.options.storePath, "budget", f.request), /persistence failure/u);
  failure.mock.restore();
  assert.deepEqual(readState(f.options.storePath), f.state);
  recovery.extendDirectTokenBudget(f.options.storePath, "budget", f.request);
  assert.equal(readState(f.options.storePath).status.windows[0]!.tokenLimit, f.request.expectedTokenLimit + f.request.additionalTokens);
});

test("legacy direct protocols cannot receive token budget extensions", async () => {
  const f = await exhaustedFixture(), storePath = `${f.options.storePath}.legacy`;
  await runBook({ ...f.options, storePath, directProtocolVersion: "direct-translation-4", maxWindows: 0 });
  assert.throws(() => recovery.extendDirectTokenBudget(storePath, "budget", f.request), /requires direct-translation-5/u);
  assert.equal(readState(storePath).records.filter(r => r.kind === "token_budget_extension").length, 0);
});
