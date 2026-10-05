import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { piRunUsageComplete, type PiRunResult } from "../src/agents/pi-runtime.js";

test("positive aggregate usage cannot conceal an unmetered response", () => {
  const good = fauxAssistantMessage("done");
  good.usage = { ...good.usage, input: 100, output: 20, totalTokens: 120 };
  const missing = { ...good, usage: { ...good.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 } };
  const run = { modelCalls: 1, usage: good.usage, messages: [good] } as PiRunResult;
  assert.equal(piRunUsageComplete(run), true);
  assert.equal(piRunUsageComplete({ ...run, modelCalls: 2, messages: [good, missing] }), false);
  assert.equal(piRunUsageComplete({ ...run, modelCalls: 2 }), false);
  assert.equal(piRunUsageComplete({ ...run, messages: [{ ...good, usage: { ...good.usage, input: NaN } }] }), false);
  assert.equal(piRunUsageComplete({ ...run, usage: { ...good.usage, totalTokens: good.usage.totalTokens + 1 } }), false);
  assert.equal(piRunUsageComplete({ ...run, modelCalls: 0, messages: [], usage: missing.usage }), true);
});
