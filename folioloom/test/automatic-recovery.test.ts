import assert from "node:assert/strict";
import test from "node:test";
import { ModelProviderError } from "../src/agents/pi-runtime.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AutomaticRecovery, type RecoveryRecord } from "../src/fullbook/automatic-recovery.js";

function fixture() {
  const records: RecoveryRecord[] = [];
  let now = 1000;
  const store = { recoveryRecords: () => structuredClone(records),
    appendRecoveryRecord: (_run: string, record: RecoveryRecord) => { records.push(structuredClone(record)); } };
  const controller = () => new AutomaticRecovery({ runId: "run", store, now: () => now,
    sleep: async () => {} });
  return { records, controller, advance: () => { now += 1_000_000; } };
}

test("recovery credits and repeated-fault circuit breaker survive reconstruction", async () => {
  const f = fixture();
  const fault = { scope: "window:w1", action: "provider_retry" as const, fingerprint: "busy" };
  assert.equal(await f.controller().claim(fault), true);
  assert.equal(await f.controller().claim(fault), true);
  assert.equal(await f.controller().claim(fault), false);
  assert.equal(f.records.filter(r => r.state === "claimed").length, 2);
  assert.equal(f.records.at(-1)?.reason, "repeated_fault");
});

test("changing the failure signature cannot evade total credits or elapsed-time limit", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) assert.equal(await f.controller().claim({ scope: "w", action: "provider_retry", fingerprint: String(i) }), true);
  assert.equal(await f.controller().claim({ scope: "w", action: "provider_retry", fingerprint: "next" }), false);
  const g = fixture();
  await g.controller().claim({ scope: "w", action: "export_retry", fingerprint: "busy" });
  g.advance();
  assert.equal(await g.controller().claim({ scope: "w", action: "export_retry", fingerprint: "again" }), false);
  assert.equal(g.records.at(-1)?.reason, "elapsed_limit");
});

test("export retries only transient I/O, reusing completed earlier stages", async () => {
  const f = fixture();
  let textWrites = 0, epubWrites = 0;
  await f.controller().exportStep("destination:text", () => { textWrites++; });
  await f.controller().exportStep("destination:epub", () => {
    epubWrites++;
    if (epubWrites === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
  });
  assert.equal(textWrites, 1);
  assert.equal(epubWrites, 2);
  for (const code of ["EACCES", "ENOSPC", "EPERM", "VERIFICATION_FAILED"]) {
    let calls = 0;
    await assert.rejects(() => f.controller().exportStep(code, () => { calls++; throw Object.assign(new Error(code), { code }); }));
    assert.equal(calls, 1);
  }
});

test("provider recovery never converts auth, unknown usage, or cancellation into retries", async () => {
  const f = fixture();
  for (const kind of ["auth", "quota", "unknown", "protocol", "context"] as const)
    assert.equal(await f.controller().providerRetry("w", new ModelProviderError(kind, kind)), false);
  assert.equal(await f.controller().providerRetry("w", new ModelProviderError("busy", "busy")), false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => f.controller().claim({ scope: "w", action: "provider_retry", fingerprint: "busy", signal: abort.signal }));
  assert.equal(f.records.filter(r => r.state === "claimed").length, 0);
});

test("positive aggregate usage cannot conceal a response whose usage is unknown", async () => {
  const f = fixture();
  const known = fauxAssistantMessage("answer");
  const unknown = { ...known, usage: { ...known.usage, input: 0, output: 0, totalTokens: 0 } };
  const run = { modelCalls: 2, toolNames: [], toolErrors: [], usage: known.usage, durationMs: 1,
    stopReason: "error" as const, messages: [known, unknown], deadlineExceeded: false, turnLimitReached: false };
  assert.equal(await f.controller().providerRetry("w", new ModelProviderError("503 busy", "busy", true, run)), false);
  assert.equal(f.records.length, 0);
});

test("a blocked scope cannot dispatch an initial attempt after restart", async () => {
  const f = fixture();
  await f.controller().claim({ scope: "w", action: "export_retry", fingerprint: "busy", deadlineAtMs: 1100 });
  assert.throws(() => f.controller().assertAvailable("w"), /AUTOMATIC_RECOVERY_PAUSED.*deadline/u);
  let calls = 0;
  await assert.rejects(() => f.controller().exportStep("w", () => { calls++; }));
  assert.equal(calls, 0);
});

test("a crash after the last claim cannot create a fresh initial attempt", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) await f.controller().claim({ scope: "w", action: "provider_retry", fingerprint: "busy" });
  assert.throws(() => f.controller().assertAvailable("w", true), /AUTOMATIC_RECOVERY_PAUSED/u);
});
