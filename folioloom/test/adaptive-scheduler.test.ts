import assert from "node:assert/strict";
import test from "node:test";

import { AdaptiveScheduler } from "../src/fullbook/adaptive-scheduler.js";

test("scheduler grows additively and halves on retryable congestion", () => {
  const scheduler = new AdaptiveScheduler({
    initialConcurrency: 2,
    maxConcurrency: 6,
    maxInFlightTokens: 20_000,
  });
  scheduler.observe({ status: "success", durationMs: 100, estimatedTokens: 2_000 });
  assert.equal(scheduler.snapshot().concurrency, 3);
  scheduler.observe({ status: "throttled", durationMs: 100, estimatedTokens: 2_000 });
  assert.equal(scheduler.snapshot().concurrency, 1);
});

test("scheduler admits work only inside both concurrency and token budgets", () => {
  const scheduler = new AdaptiveScheduler({
    initialConcurrency: 3,
    maxConcurrency: 6,
    maxInFlightTokens: 5_000,
  });
  const first = scheduler.tryAcquire(3_000);
  assert.ok(first);
  assert.equal(scheduler.tryAcquire(2_001), undefined);
  const second = scheduler.tryAcquire(2_000);
  assert.ok(second);
  assert.equal(scheduler.tryAcquire(1), undefined);
  first.release();
  assert.ok(scheduler.tryAcquire(1_000));
  second.release();
});

test("scheduler snapshots restore a prior congestion downgrade deterministically", () => {
  const original = new AdaptiveScheduler({
    initialConcurrency: 4,
    maxConcurrency: 8,
    maxInFlightTokens: 12_000,
  });
  original.observe({ status: "timeout", durationMs: 2_000, estimatedTokens: 3_000 });
  const snapshot = original.snapshot();
  const restored = new AdaptiveScheduler({
    initialConcurrency: 4,
    maxConcurrency: 8,
    maxInFlightTokens: 12_000,
    snapshot,
  });
  assert.deepEqual(restored.snapshot(), snapshot);
});

test("invalid estimates and double release cannot corrupt scheduler state", () => {
  const scheduler = new AdaptiveScheduler({
    initialConcurrency: 1,
    maxConcurrency: 2,
    maxInFlightTokens: 2_000,
  });
  assert.throws(() => scheduler.tryAcquire(0), /positive/u);
  const permit = scheduler.tryAcquire(1_000);
  assert.ok(permit);
  permit.release();
  permit.release();
  assert.equal(scheduler.snapshot().inFlight, 0);
  assert.equal(scheduler.snapshot().inFlightTokens, 0);
});
