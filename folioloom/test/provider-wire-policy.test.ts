import assert from "node:assert/strict";
import test from "node:test";

import { providerWirePolicy } from "../src/providers/wire-policy.js";
import { providerRegistry } from "../src/providers/registry.js";

test("DeepSeek policy keeps its probe and runtime wire format aligned", () => {
  const off = providerWirePolicy(providerRegistry.resolve({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "off",
  }));
  const high = providerWirePolicy(providerRegistry.resolve({
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    reasoningEffort: "high",
  }));

  assert.equal(off.outputTokenField, "max_completion_tokens");
  assert.equal(off.initialProbeTokens("off"), 128);
  assert.deepEqual(off.serializeThinking("off"), { thinking: { type: "disabled" } });
  assert.equal(off.requiresReasoningReplay("off"), false);
  assert.deepEqual(high.serializeThinking("high"), {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.equal(high.initialProbeTokens("high"), 512);
  assert.equal(high.requiresReasoningReplay("high"), true);
  assert.deepEqual(high.thinkingLevelMap, { high: "high" });
});

test("wire policy selects the API family's token field and only serializes replay when required", () => {
  const kimi = providerWirePolicy(providerRegistry.resolve({
    providerId: "kimi-cn",
    modelId: "moonshot-v1-8k",
    reasoningEffort: "high",
  }));
  const openai = providerWirePolicy(providerRegistry.resolve({
    providerId: "openai",
    modelId: "gpt-5-mini",
    reasoningEffort: "high",
  }));
  const assistant = {
    text: "",
    reasoning: "keep this chain",
    toolCall: { id: "call-1", name: "return_probe_token", arguments: '{"token":"FOLIOLOOM_PROBE"}' },
  };

  assert.equal(kimi.outputTokenField, "max_tokens");
  assert.equal(openai.outputTokenField, "max_output_tokens");
  assert.deepEqual(kimi.serializeAssistantContinuation(assistant, "high"), {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call-1",
      type: "function",
      function: { name: "return_probe_token", arguments: '{"token":"FOLIOLOOM_PROBE"}' },
    }],
    reasoning_content: "keep this chain",
  });
  assert.equal(
    Object.hasOwn(kimi.serializeAssistantContinuation(assistant, "off"), "reasoning_content"),
    false,
  );
});
