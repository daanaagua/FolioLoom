import assert from "node:assert/strict";
import test from "node:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import {
  optimizationPolicy,
  profileFromLegacyRunMode,
  validateRuntimeVariants,
} from "../src/fullbook/optimization-policy.js";
import type { TranslationRuntime } from "../src/fullbook/types.js";
import type { ProviderEffort } from "../src/providers/types.js";

const streamFn = (async () => {
  throw new Error("not used by optimization policy tests");
}) as StreamFn;

function runtime(
  modelId: string,
  effort: ProviderEffort,
): TranslationRuntime {
  return {
    model: { id: modelId } as Model<any>,
    streamFn,
    effort,
  };
}

test("optimization profiles expose fixed token envelopes", () => {
  assert.equal(optimizationPolicy("economy").tokenIncreaseCap, 0.05);
  assert.equal(optimizationPolicy("balanced").tokenIncreaseCap, 0.10);
  assert.equal(optimizationPolicy("speed").tokenIncreaseCap, 0.20);
});

test("optimization policy callers cannot mutate shared defaults", () => {
  const first = optimizationPolicy("balanced");
  (first.objectiveWeights as { tokens: number }).tokens = 99;

  assert.equal(optimizationPolicy("balanced").objectiveWeights.tokens, 0.75);
});

test("legacy run modes map without changing resumed run metadata", () => {
  assert.equal(profileFromLegacyRunMode("quality"), "balanced");
  assert.equal(profileFromLegacyRunMode("fast"), "speed");
});

test("runtime variants must retain one provider model identity", () => {
  assert.throws(
    () => validateRuntimeVariants([
      runtime("model-a", "low"),
      runtime("model-b", "high"),
    ]),
    /same model identity/u,
  );
});

test("runtime variants reject an empty candidate list", () => {
  assert.throws(
    () => validateRuntimeVariants([]),
    /at least one runtime variant/u,
  );
});

test("runtime variants deduplicate and sort DeepSeek effort levels", () => {
  const high = runtime("deepseek-v4-flash", "high");
  const low = runtime("deepseek-v4-flash", "low");
  const medium = runtime("deepseek-v4-flash", "medium");

  const result = validateRuntimeVariants([high, low, medium, low]);

  assert.deepEqual(result.map((candidate) => candidate.effort), [
    "low",
    "medium",
    "high",
  ]);
  assert.equal(result[0], low);
});

test("legacy primary and escalation runtimes remain valid candidates", () => {
  const primary = runtime("deepseek-v4-flash", "low");
  const escalation = runtime("deepseek-v4-flash", "high");

  const result = validateRuntimeVariants([primary, escalation]);

  assert.deepEqual(result, [primary, escalation]);
});
