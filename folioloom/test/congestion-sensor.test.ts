import assert from "node:assert/strict";
import test from "node:test";

import { AdaptiveScheduler } from "../src/fullbook/adaptive-scheduler.js";
import { CongestionSensor } from "../src/fullbook/congestion-sensor.js";

test("congestion sensor recommends concurrency from AIMD observations", () => {
  const adaptive = new AdaptiveScheduler({
    initialConcurrency: 2,
    maxConcurrency: 6,
    maxInFlightTokens: 50_000,
  });
  const sensor = new CongestionSensor(adaptive);
  assert.equal(sensor.snapshot().recommendedConcurrency, 2);
  assert.equal(sensor.snapshot().tier, "clear");
  sensor.observe({ status: "success", durationMs: 100, estimatedTokens: 1_000 });
  assert.equal(sensor.snapshot().recommendedConcurrency, 3);
  sensor.observe({ status: "throttled", durationMs: 100, estimatedTokens: 1_000 });
  assert.equal(sensor.snapshot().recommendedConcurrency, 1);
  assert.equal(sensor.snapshot().tier, "congested");
});

test("active token gate uses external reserved total only for concurrency permits", () => {
  const adaptive = new AdaptiveScheduler({
    initialConcurrency: 2,
    maxConcurrency: 4,
    maxInFlightTokens: 1_000,
  });
  const sensor = new CongestionSensor(adaptive);
  const first = sensor.tryAcquireSlot(5_000, { tokenGate: "external" });
  assert.ok(first);
  const second = sensor.tryAcquireSlot(5_000, { tokenGate: "external" });
  assert.ok(second);
  assert.equal(
    sensor.tryAcquireSlot(1, { tokenGate: "external" }),
    undefined,
  );
  first.release();
  second.release();
});
