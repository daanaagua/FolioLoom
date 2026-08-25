import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRuntimeUsage,
  runtimeObservationProfileKey,
} from "../src/fullbook/runtime-telemetry.js";

test("normalized usage never double counts reasoning tokens", () => {
  const usage = normalizeRuntimeUsage({
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: 30,
    totalTokens: 170,
  });
  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 30,
    totalTokens: 170,
    complete: true,
  });
});

test("runtime usage derives a conservative incomplete total without reasoning", () => {
  const usage = normalizeRuntimeUsage({
    input: 100,
    output: 50,
    cacheRead: 20,
    reasoning: 30,
  });

  assert.equal(usage.totalTokens, 170);
  assert.equal(usage.complete, false);
});

test("runtime usage rejects negative, non-finite, fractional, and unsafe values", () => {
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 54]) {
    assert.throws(
      () => normalizeRuntimeUsage({ input: invalid }),
      /non-negative safe integer/u,
    );
  }
});

test("runtime profile keys are deterministic and exclude request content", () => {
  assert.equal(runtimeObservationProfileKey({
    modelId: "deepseek-v4-flash",
    languageProfileId: "de",
  }), "deepseek-v4-flash:de");
});
