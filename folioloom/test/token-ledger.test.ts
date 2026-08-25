import assert from "node:assert/strict";
import test from "node:test";

import { TokenLedger } from "../src/fullbook/token-ledger.js";

function createLedger(cap = 0.1) {
  return TokenLedger.create({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: cap,
  });
}

function createTransactionalLedger(cap = 0.1) {
  return TokenLedger.create({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: cap,
    enforceDispatchLifecycle: true,
  });
}

test("empty ledger starts at zero", () => {
  const ledger = createLedger();
  const state = ledger.state();
  assert.equal(state.baselineTokens, 0);
  assert.equal(state.allowedTokens, 0);
  assert.equal(state.spentTokens, 0);
  assert.equal(state.reservedTokens, 0);
  assert.equal(state.tokenUsageComplete, true);
  assert.equal(state.decisions, 0);
  assert.equal(state.planningStatus, "optimal");
});

test("baseline accumulates and computes allowed tokens", () => {
  const ledger = createLedger(0.1);
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1", "t2"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  assert.equal(ledger.state().baselineTokens, 1000);
  assert.equal(ledger.state().allowedTokens, 1100);
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t3"],
    baselineTokens: 500,
    source: "translate_horizon",
    reason: "wave2",
  });
  assert.equal(ledger.state().baselineTokens, 1500);
  assert.equal(ledger.state().allowedTokens, 1650);
});

test("duplicate baseline task ids are rejected", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 100,
    source: "translate_horizon",
    reason: "wave",
  });
  assert.throws(
    () => ledger.apply({
      type: "baseline_added",
      taskIds: ["t1"],
      baselineTokens: 50,
      source: "translate_horizon",
      reason: "retry",
    }),
    /baseline.*t1|t1.*baseline/i,
  );
  assert.equal(ledger.state().baselineTokens, 100);
});

test("reserve settle success moves reserved into spent", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
  });
  assert.equal(ledger.state().reservedTokens, 100);
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 120,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.state().spentTokens, 120);
  assert.equal(ledger.state().reservedTokens, 0);
  assert.equal(ledger.state().tokenUsageComplete, true);
});

test("failed settle with usage still charges spent", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
  });
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 80,
    usageComplete: true,
    outcome: "failed",
  });
  assert.equal(ledger.state().spentTokens, 80);
  assert.equal(ledger.state().reservedTokens, 0);
});

test("missing usage settles reserved amount and marks incomplete", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "repair",
    taskIds: ["t1"],
    predictedTokens: 150,
    attempt: 1,
  });
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 0,
    usageComplete: false,
    outcome: "failed",
  });
  assert.equal(ledger.state().spentTokens, 150);
  assert.equal(ledger.state().reservedTokens, 0);
  assert.equal(ledger.state().tokenUsageComplete, false);
});

test("partial unknown usage never charges less than the observed usage", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "repair",
    taskIds: ["t1"],
    predictedTokens: 150,
    attempt: 1,
  });
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 220,
    usageComplete: false,
    outcome: "failed",
  });
  assert.equal(ledger.state().spentTokens, 220);
  assert.equal(ledger.state().tokenUsageComplete, false);
});

test("reconciliation reports every open and dispatched attempt", () => {
  const ledger = TokenLedger.create({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: 0.1,
    enforceDispatchLifecycle: true,
  });
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r-open",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
  });
  ledger.apply({
    type: "dispatched",
    requestId: "r-open",
  });

  assert.deepEqual(ledger.reconcile(), {
    consistent: false,
    openRequestIds: ["r-open"],
    dispatchedOpenRequestIds: ["r-open"],
    orphanDispatchedRequestIds: [],
  });
  assert.throws(
    () => ledger.assertReconciled(),
    /TOKEN_LEDGER_RECONCILIATION_FAILED/u,
  );
});

test("release drops reserved without spending", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 200,
    attempt: 0,
  });
  ledger.apply({
    type: "released",
    requestId: "r1",
    reason: "not_launched",
  });
  assert.equal(ledger.state().spentTokens, 0);
  assert.equal(ledger.state().reservedTokens, 0);
});

test("settle without reserve is rejected", () => {
  const ledger = createLedger();
  assert.throws(
    () => ledger.apply({
      type: "settled",
      requestId: "missing",
      actualTokens: 10,
      usageComplete: true,
      outcome: "success",
    }),
    /reserve|not open|unknown request/i,
  );
});

test("double settle is rejected", () => {
  const ledger = createLedger();
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 50,
    attempt: 0,
  });
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 50,
    usageComplete: true,
    outcome: "success",
  });
  assert.throws(
    () => ledger.apply({
      type: "settled",
      requestId: "r1",
      actualTokens: 10,
      usageComplete: true,
      outcome: "success",
    }),
    /already|double|not open|unknown request/i,
  );
});

test("transactional ledger requires dispatch before settlement", () => {
  const ledger = createTransactionalLedger();
  ledger.apply({
    type: "reserved",
    requestId: "attempt-1",
    purpose: "translate",
    taskIds: ["task-1"],
    predictedTokens: 100,
    attempt: 0,
  });
  assert.throws(
    () => ledger.apply({
      type: "settled",
      requestId: "attempt-1",
      actualTokens: 80,
      usageComplete: true,
      outcome: "success",
    }),
    /dispatch/i,
  );
  ledger.apply({
    type: "dispatched",
    requestId: "attempt-1",
  });
  ledger.apply({
    type: "settled",
    requestId: "attempt-1",
    actualTokens: 80,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.state().spentTokens, 80);
});

test("dispatched attempts cannot be released as unlaunched", () => {
  const ledger = createTransactionalLedger();
  ledger.apply({
    type: "reserved",
    requestId: "attempt-2",
    purpose: "anchor",
    taskIds: ["task-2"],
    predictedTokens: 120,
    attempt: 0,
  });
  ledger.apply({
    type: "dispatched",
    requestId: "attempt-2",
  });
  assert.throws(
    () => ledger.apply({
      type: "released",
      requestId: "attempt-2",
      reason: "run_cancelled",
    }),
    /dispatch|unlaunched/i,
  );
});

test("terminal attempt ids cannot be reserved again", () => {
  const ledger = createTransactionalLedger();
  ledger.apply({
    type: "reserved",
    requestId: "attempt-3",
    purpose: "translate",
    taskIds: ["task-3"],
    predictedTokens: 100,
    attempt: 0,
  });
  ledger.apply({
    type: "released",
    requestId: "attempt-3",
    reason: "not_launched",
  });
  assert.throws(
    () => ledger.apply({
      type: "reserved",
      requestId: "attempt-3",
      purpose: "translate",
      taskIds: ["task-3"],
      predictedTokens: 100,
      attempt: 1,
    }),
    /terminal|already/i,
  );
});

test("hard gate uses spent reserved new reserve and floor", () => {
  const ledger = createLedger(0.1);
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  assert.equal(ledger.state().allowedTokens, 1100);
  assert.equal(ledger.canReserve(1100, 0), true);
  assert.equal(ledger.canReserve(1101, 0), false);
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 400,
    attempt: 0,
  });
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 500,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.canReserve(600, 0), true);
  assert.equal(ledger.canReserve(601, 0), false);
  assert.equal(ledger.canReserve(500, 100), true);
  assert.equal(ledger.canReserve(500, 101), false);
});

test("fromEvents replays to identical state", () => {
  const events = [
    {
      type: "baseline_added" as const,
      taskIds: ["t1"],
      baselineTokens: 200,
      source: "translate_horizon" as const,
      reason: "w",
    },
    {
      type: "reserved" as const,
      requestId: "r1",
      purpose: "translate" as const,
      taskIds: ["t1"],
      predictedTokens: 40,
      attempt: 0,
    },
    {
      type: "settled" as const,
      requestId: "r1",
      actualTokens: 55,
      usageComplete: true,
      outcome: "success" as const,
    },
    {
      type: "counters_patched" as const,
      patch: {
        decisions: 2,
        fallbacks: 1,
        planningStatus: "bounded" as const,
        predictedTokens: 80,
        predictedWallTimeMs: 1000,
        actualWallTimeMs: 900,
        baselineWallTimeMs: 1200,
      },
    },
  ];
  const ledger = TokenLedger.fromEvents({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: 0.1,
  }, events);
  assert.equal(ledger.state().spentTokens, 55);
  assert.equal(ledger.state().baselineTokens, 200);
  assert.equal(ledger.state().decisions, 2);
  assert.equal(ledger.state().planningStatus, "bounded");
  const report = ledger.toSchedulerRunReport();
  assert.equal(report.actualTokens, 55);
  assert.equal(report.baselineTokens, 200);
  assert.equal(report.allowedTokens, 220);
  assert.equal(report.decisions, 2);
  assert.equal(report.mode, "active");
  assert.equal(report.profile, "balanced");
  assert.equal(report.planningStatus, "bounded");
});
