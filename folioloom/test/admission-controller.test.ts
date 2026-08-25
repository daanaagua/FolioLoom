import assert from "node:assert/strict";
import test from "node:test";

import {
  AdmissionController,
  BookTokenEnvelopeExceededError,
  incrementalBaselineProjection,
  weightedBaselineProjectionTasks,
} from "../src/fullbook/admission-controller.js";
import { TokenLedger } from "../src/fullbook/token-ledger.js";

function controller(mode: "active" | "shadow" | "off" = "active") {
  const events: unknown[] = [];
  const ledger = TokenLedger.create({
    mode,
    profile: "balanced",
    tokenIncreaseCap: 0.1,
  });
  const admission = new AdmissionController({
    ledger,
    mode,
    persist(event) {
      events.push(event);
      ledger.apply(event);
    },
  });
  return { admission, ledger, events };
}

function transactionalController() {
  const events: unknown[] = [];
  const ledger = TokenLedger.create({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: 0.1,
    enforceDispatchLifecycle: true,
  });
  const admission = new AdmissionController({
    ledger,
    mode: "active",
    persist(event) {
      events.push(event);
      ledger.apply(event);
    },
  });
  return { admission, ledger, events };
}

test("admission reserves and settles through the ledger", () => {
  const { admission, ledger } = controller();
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  assert.equal(admission.canLaunch(100, 0), true);
  admission.reserve({
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
    conservativeHorizonFloor: 0,
  });
  assert.equal(ledger.state().reservedTokens, 100);
  admission.settle({
    requestId: "r1",
    actualTokens: 120,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.state().spentTokens, 120);
  assert.equal(ledger.state().reservedTokens, 0);
});

test("active mode rejects launch that exceeds envelope", () => {
  const { admission } = controller("active");
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 100,
    source: "translate_horizon",
    reason: "wave",
  });
  assert.equal(admission.canLaunch(111, 0), false);
  assert.throws(
    () => admission.reserve({
      requestId: "r1",
      purpose: "translate",
      taskIds: ["t1"],
      predictedTokens: 111,
      attempt: 0,
      conservativeHorizonFloor: 0,
    }),
    (error: unknown) => error instanceof BookTokenEnvelopeExceededError,
  );
});

test("reserve atomically includes the mandatory horizon floor", () => {
  const { admission, ledger } = transactionalController();
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 1_000,
    source: "translate_horizon",
    reason: "wave",
  });

  assert.throws(
    () => admission.reserve({
      requestId: "r-floor",
      purpose: "translate",
      taskIds: ["t1"],
      predictedTokens: 901,
      attempt: 0,
      conservativeHorizonFloor: 200,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookTokenEnvelopeExceededError);
      assert.equal(error.minimumPendingTokens, 1_101);
      return true;
    },
  );
  assert.equal(ledger.state().openReservations.size, 0);
});

test("admission persists dispatch before settling a transactional attempt", () => {
  const { admission, ledger, events } = transactionalController();
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 1_000,
    source: "translate_horizon",
    reason: "wave",
  });
  admission.reserve({
    requestId: "r-dispatch",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
    conservativeHorizonFloor: 0,
  });
  admission.markDispatched("r-dispatch");
  admission.settle({
    requestId: "r-dispatch",
    actualTokens: 90,
    usageComplete: true,
    outcome: "success",
  });

  assert.deepEqual(
    events.map((event) => (event as { type: string }).type),
    ["baseline_added", "reserved", "dispatched", "settled"],
  );
  assert.equal(ledger.state().spentTokens, 90);
});

test("active mode persists actual usage and rejects a post-settle envelope overrun", () => {
  const { admission, ledger } = controller("active");
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 100,
    source: "translate_horizon",
    reason: "wave",
  });
  admission.reserve({
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
    conservativeHorizonFloor: 0,
  });

  assert.throws(
    () => admission.settle({
      requestId: "r1",
      actualTokens: 150,
      usageComplete: true,
      outcome: "success",
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookTokenEnvelopeExceededError);
      assert.equal(error.actualTokens, 150);
      assert.equal(error.runningReservedTokens, 0);
      assert.equal(error.minimumPendingTokens, 0);
      assert.equal(error.allowedTokens, 110);
      return true;
    },
  );
  assert.equal(ledger.state().spentTokens, 150);
  assert.equal(ledger.state().reservedTokens, 0);
});

test("shadow mode still records spend but does not hard-reject", () => {
  const { admission, ledger } = controller("shadow");
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 100,
    source: "translate_horizon",
    reason: "wave",
  });
  assert.equal(admission.canLaunch(200, 0), true);
  admission.reserve({
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 200,
    attempt: 0,
    conservativeHorizonFloor: 0,
  });
  admission.settle({
    requestId: "r1",
    actualTokens: 250,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.state().spentTokens, 250);
});

test("unlaunched transaction reservation can be released without spending", () => {
  const { admission, ledger } = controller("active");
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  admission.reserve({
    requestId: "parent",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
    conservativeHorizonFloor: 0,
  });
  const transaction = admission.begin({
    requestId: "parent:protocol:0",
    purpose: "protocol_switch",
    taskIds: ["t1"],
    predictedTokens: 80,
    attempt: 0,
    conservativeHorizonFloor: 0,
  });
  assert.equal(ledger.state().reservedTokens, 180);
  transaction.releaseUnlaunched("superseded");
  assert.equal(ledger.state().reservedTokens, 100);
  assert.equal(ledger.state().spentTokens, 0);
});

test("dispatched transaction must settle and cannot be released", () => {
  const { admission, ledger } = transactionalController();
  admission.addBaseline({
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "wave",
  });
  const transaction = admission.begin({
    requestId: "r-transaction",
    purpose: "protocol_switch",
    taskIds: ["t1"],
    predictedTokens: 180,
    attempt: 1,
    conservativeHorizonFloor: 0,
  });
  transaction.markDispatched();
  assert.throws(
    () => transaction.releaseUnlaunched("superseded"),
    /cannot release dispatched/u,
  );
  transaction.settle({
    actualTokens: 140,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.state().spentTokens, 140);
  assert.equal(ledger.state().openReservations.size, 0);
});

test("resume baseline projection counts only tasks not already in the durable ledger", () => {
  const firstBatch = weightedBaselineProjectionTasks([
    { taskId: "translate-window:a", weight: 1 },
    { taskId: "translate-window:b", weight: 1 },
  ], 24_000, 80_000);
  const resumedBatch = weightedBaselineProjectionTasks([
    { taskId: "translate-window:b", weight: 1 },
  ], 15_000, 50_000);
  const projection = incrementalBaselineProjection(
    resumedBatch,
    new Set(firstBatch.map((task) => task.taskId)),
  );

  assert.deepEqual(projection, {
    taskIds: [],
    baselineTokens: 0,
    baselineWallTimeMs: 0,
  });
});

test("weighted baseline projection preserves request totals across logical windows", () => {
  const tasks = weightedBaselineProjectionTasks([
    { taskId: "translate-window:a", weight: 1 },
    { taskId: "translate-window:b", weight: 2 },
  ], 10, 20);

  assert.deepEqual(tasks, [
    {
      taskId: "translate-window:a",
      baselineTokens: 3,
      baselineWallTimeMs: 6,
    },
    {
      taskId: "translate-window:b",
      baselineTokens: 7,
      baselineWallTimeMs: 14,
    },
  ]);
});
