import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import {
  createDeepSeekModel,
  createDeepSeekStreamFn,
} from "../src/agents/pi-runtime.js";
import { createProviderRuntime } from "../src/providers/runtime.js";

async function qwenPayload(reasoningEffort: "off" | "on"): Promise<Record<string, unknown>> {
  const runtime = createProviderRuntime({
    providerId: "bailian",
    modelId: "qwen-plus",
    reasoningEffort,
  }, "qwen-runtime-fixture-secret");
  let captured: Record<string, unknown> | undefined;
  const stream = await runtime.streamFn(runtime.model, {
    messages: [{ role: "user", content: "Reply with a payload fixture.", timestamp: 0 }],
  }, {
    onPayload(payload) {
      captured = payload as Record<string, unknown>;
      throw new Error("stop after payload capture");
    },
  });
  await stream.result();
  if (captured === undefined) {
    throw new Error("Qwen payload was not captured");
  }
  return captured;
}

test("provider runtime maps DeepSeek raw max without serializing the credential", () => {
  const credential = "provider-runtime-fixture-secret";
  const runtime = createProviderRuntime({
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    reasoningEffort: "max",
  }, credential);

  assert.equal(runtime.model.api, "openai-completions");
  assert.equal(runtime.model.thinkingLevelMap?.xhigh, "max");
  if (runtime.model.api !== "openai-completions") {
    throw new TypeError("expected the DeepSeek runtime to use chat completions");
  }
  const model = runtime.model as Model<"openai-completions">;
  assert.equal(model.compat?.thinkingFormat, "deepseek");
  assert.equal(model.compat?.maxTokensField, "max_completion_tokens");
  assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(JSON.stringify(runtime.model).includes(credential), false);
});

test("provider runtime does not replay DeepSeek reasoning when the effort is off", () => {
  const runtime = createProviderRuntime({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "off",
  }, "provider-runtime-fixture-secret");

  if (runtime.model.api !== "openai-completions") {
    throw new TypeError("expected the DeepSeek runtime to use chat completions");
  }
  const model = runtime.model as Model<"openai-completions">;
  assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, false);
  assert.equal(model.thinkingLevelMap, undefined);
});

test("provider runtime uses the OpenAI Responses API without exposing credentials", () => {
  const credential = "openai-runtime-fixture-secret";
  const runtime = createProviderRuntime({
    providerId: "openai",
    modelId: "gpt-5-mini",
    reasoningEffort: "high",
  }, credential);

  assert.equal(runtime.model.api, "openai-responses");
  assert.equal(runtime.model.baseUrl, "https://api.openai.com/v1");
  assert.equal(JSON.stringify(runtime).includes(credential), false);
});

test("Bailian runtime sends the Qwen thinking toggle without a synthetic raw effort", async () => {
  const on = await qwenPayload("on");
  const off = await qwenPayload("off");

  assert.equal(on.enable_thinking, true);
  assert.equal(off.enable_thinking, false);
  assert.equal("reasoning_effort" in on, false);
  assert.equal("reasoning_effort" in off, false);
});

test("legacy DeepSeek CLI wrappers delegate to the provider runtime", () => {
  const config = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://example.invalid/v1",
    timeoutMs: 30_000,
    reasoningEffort: "max",
    apiKeyForRuntime: () => "legacy-wrapper-secret",
    toJSON: () => ({ apiKeyConfigured: true }),
  };

  const model = createDeepSeekModel(config);
  const streamFn = createDeepSeekStreamFn(config);

  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://example.invalid/v1");
  assert.equal(model.thinkingLevelMap?.xhigh, "max");
  assert.equal(typeof streamFn, "function");
});
