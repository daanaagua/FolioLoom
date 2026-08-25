import assert from "node:assert/strict";
import test from "node:test";

import { OnlineRuntimeCostModel } from "../src/fullbook/runtime-cost-model.js";
import { TelemetrySink } from "../src/fullbook/telemetry-sink.js";

test("telemetry sink forwards observations to the cost model", () => {
  const model = OnlineRuntimeCostModel.coldStart("model:en");
  const sink = new TelemetrySink({ costModel: model });
  const before = model.snapshot();
  sink.observeRuntime({
    features: {
      inputTokens: 100,
      outputTokens: 50,
      sourceTokens: 80,
      effortRank: 2,
      protocolRank: 1,
      cacheHitRatio: 0,
      concurrency: 1,
      riskScore: 0.1,
      batchWindows: 1,
    },
    durationMs: 120,
    usage: {
      inputTokens: 90,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 130,
      complete: true,
    },
    status: "success",
    observedAt: new Date().toISOString(),
  });
  const after = model.snapshot();
  assert.notDeepEqual(after, before);
});
