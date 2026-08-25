import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OnlineRuntimeCostModel,
  loadRuntimeCostModel,
  persistRuntimeCostModel,
  runtimeFeatureVector,
  type RuntimeCostObservation,
  type RuntimeFeatures,
} from "../src/fullbook/runtime-cost-model.js";
import { normalizeRuntimeUsage } from "../src/fullbook/runtime-telemetry.js";
import { RuntimeProfileStore } from "../src/storage/runtime-profile-store.js";

function features(
  overrides: Partial<RuntimeFeatures> = {},
): RuntimeFeatures {
  return {
    inputTokens: 1_000,
    outputTokens: 600,
    sourceTokens: 800,
    effortRank: 2,
    cacheHitRatio: 0.25,
    concurrency: 2,
    batchWindows: 1,
    riskScore: 0.4,
    protocolRank: 1,
    ...overrides,
  };
}

function successObservation(
  durationMs: number,
  observedAt: string,
  overrides: Partial<RuntimeCostObservation> = {},
): RuntimeCostObservation {
  return {
    features: features(),
    durationMs,
    usage: normalizeRuntimeUsage({
      input: 900,
      output: 500,
      totalTokens: 1_400,
    }),
    status: "success",
    observedAt,
    ...overrides,
  };
}

test("RuntimeCostModel uses one fixed ten-dimensional feature vector", () => {
  const vector = runtimeFeatureVector(features());
  assert.equal(vector.length, 10);
  assert.deepEqual(vector.slice(0, 2), [1, Math.log1p(1_000)]);
});

test("cold predictions use conservative p90 priors", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  const prediction = model.predict(features());
  assert.ok(prediction.p90DurationMs >= prediction.p50DurationMs);
  assert.ok(prediction.totalTokens > 0);
  assert.ok(prediction.failureProbability > 0);
  assert.equal(prediction.confidence, 0);
});

test("recent slow observations raise p90 more than expired observations", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  for (let index = 0; index < 20; index += 1) {
    model.observe(successObservation(
      1_000,
      `2026-07-01T00:00:${String(index).padStart(2, "0")}Z`,
    ));
  }
  const before = model.predict(features()).p90DurationMs;
  model.observe(successObservation(4_000, "2026-07-27T00:00:00Z"));
  assert.ok(model.predict(features()).p90DurationMs > before);
});

test("provider timeouts update failure risk but never normal duration", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  const before = model.predict(features());
  model.observe({
    ...successObservation(90_000, "2026-07-27T00:00:00Z"),
    status: "timeout",
  });
  const after = model.predict(features());

  assert.equal(after.p50DurationMs, before.p50DurationMs);
  assert.ok(after.failureProbability > before.failureProbability);
});

test("successful complete usage calibrates input and output token estimates", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  for (let index = 0; index < 8; index += 1) {
    model.observe(successObservation(
      1_000,
      `2026-07-27T00:00:${String(index).padStart(2, "0")}Z`,
    ));
  }

  const prediction = model.predict(features());
  assert.ok(prediction.inputTokens < 1_000);
  assert.ok(prediction.outputTokens < 600);
  assert.ok(prediction.totalTokens >= prediction.inputTokens + prediction.outputTokens);
});

test("many successful observations shrink failure probability", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  const before = model.predict(features()).failureProbability;
  for (let index = 0; index < 25; index += 1) {
    model.observe(successObservation(
      1_000,
      `2026-07-27T00:00:${String(index).padStart(2, "0")}Z`,
    ));
  }
  assert.ok(model.predict(features()).failureProbability < before);
});

test("snapshot round trip is deterministic", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  model.observe(successObservation(1_500, "2026-07-27T00:00:00Z"));
  model.observe({
    ...successObservation(1_500, "2026-07-27T00:00:01Z"),
    status: "protocol",
  });

  const restored = OnlineRuntimeCostModel.fromSnapshot(model.snapshot());
  assert.deepEqual(restored.predict(features()), model.predict(features()));
  assert.deepEqual(restored.snapshot(), model.snapshot());
});

test("runtime cost model persists and invalid snapshots fall back deterministically", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "folioloom-cost-model-")),
    "profiles.db",
  );
  const store = new RuntimeProfileStore(path);
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  model.observe(successObservation(1_250, "2026-07-27T00:00:00Z"));
  persistRuntimeCostModel(store, model);

  const restored = loadRuntimeCostModel(store, "deepseek-v4-flash:de");
  assert.equal(restored.snapshotStatus, "valid");
  assert.deepEqual(restored.predict(features()), model.predict(features()));

  store.saveModelSnapshot(
    "deepseek-v4-flash:ko",
    { schemaVersion: 99, profileKey: "deepseek-v4-flash:ko" },
    "2026-07-27T00:00:00Z",
  );
  const invalid = loadRuntimeCostModel(store, "deepseek-v4-flash:ko");
  assert.equal(invalid.snapshotStatus, "invalid");
  assert.equal(invalid.profileKey, "deepseek-v4-flash:ko");
  store.close();
});

test("runtime cost model rejects token ratios outside its learned bounds", () => {
  const store = new RuntimeProfileStore(join(
    mkdtempSync(join(tmpdir(), "folioloom-cost-model-ratio-")),
    "profiles.db",
  ));
  const profileKey = "deepseek-v4-flash:de";
  const snapshot = OnlineRuntimeCostModel.coldStart(profileKey).snapshot();
  store.saveModelSnapshot(
    profileKey,
    {
      ...snapshot,
      inputTokenRatio: 0,
      outputTokenRatio: 0,
      totalTokenRatio: 0,
    },
    "2026-07-27T00:00:00Z",
  );

  const restored = loadRuntimeCostModel(store, profileKey);

  assert.equal(restored.snapshotStatus, "invalid");
  assert.ok(restored.predict(features()).totalTokens > 0);
  store.close();
});

test("runtime features reject negative and non-finite values", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  assert.throws(
    () => model.predict(features({ concurrency: Number.NaN })),
    /concurrency/u,
  );
  assert.throws(
    () => model.predict(features({ sourceTokens: -1 })),
    /source tokens/u,
  );
});
