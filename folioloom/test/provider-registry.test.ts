import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRegistry,
  providerRegistry,
  toInternalThinking,
  toProviderEffort,
  validateCustomOpenAICompatibleBaseUrl,
} from "../src/providers/registry.js";
import { PROVIDER_PRESETS } from "../src/providers/presets.js";
import type { ModelProfile } from "../src/providers/types.js";

test("provider registry exposes the supported first-party order", () => {
  assert.deepEqual(providerRegistry.list().map((item) => item.id), [
    "deepseek",
    "kimi-cn",
    "bailian",
    "volcengine",
    "openai",
    "siliconflow",
    "openai-compatible",
  ]);
});

test("DeepSeek exposes only the current V4 Flash and Pro models", () => {
  const definition = providerRegistry.get("deepseek");
  assert.equal(definition.modelDiscovery, "curated");
  assert.deepEqual(definition.fallbackModels, [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
  assert.equal(definition.allowManualModel, false);
  assert.equal(
    providerRegistry.resolve({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    }).profile.modelId,
    "deepseek-v4-flash",
  );
});

test("retired DeepSeek aliases fail with a stable public error code", () => {
  for (const modelId of ["deepseek-chat", "deepseek-reasoner"]) {
    assert.throws(
      () => providerRegistry.resolve({ providerId: "deepseek", modelId }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "DEEPSEEK_MODEL_RETIRED"
      ),
    );
  }
});

test("preset provider base URLs cannot be overridden by a profile", () => {
  const resolved = providerRegistry.resolve({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    customBaseUrl: "https://untrusted.example/v1",
  });

  assert.equal(resolved.baseUrl, "https://api.deepseek.com/v1");
});

test("custom provider URL accepts HTTPS and loopback HTTP only", () => {
  assert.equal(
    validateCustomOpenAICompatibleBaseUrl("https://gateway.example/v1"),
    "https://gateway.example/v1",
  );
  assert.equal(
    validateCustomOpenAICompatibleBaseUrl("http://localhost:11434/v1/"),
    "http://localhost:11434/v1",
  );
  assert.equal(
    validateCustomOpenAICompatibleBaseUrl("http://[::1]:8080/v1"),
    "http://[::1]:8080/v1",
  );

  for (const value of [
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?secret=1",
    "https://example.com/v1#fragment",
    "not a URL",
  ]) {
    assert.throws(() => validateCustomOpenAICompatibleBaseUrl(value), /custom provider base URL/i);
  }
});

test("raw max effort stays max after the internal xhigh mapping", () => {
  const profile = {
    providerId: "deepseek" as const,
    modelId: "deepseek-v4-pro",
    reasoningEffort: "max",
  } satisfies ModelProfile;

  assert.equal(toInternalThinking("max"), "xhigh");
  assert.equal(toProviderEffort("xhigh", profile), "max");
});

test("Bailian exposes its Qwen reasoning control as an honest on/off toggle", () => {
  const profile = {
    providerId: "bailian" as const,
    modelId: "qwen-plus",
    reasoningEffort: "on",
  } satisfies ModelProfile;

  assert.deepEqual(providerRegistry.get("bailian").capabilities.efforts, ["off", "on"]);
  assert.equal(toInternalThinking("on"), "high");
  assert.equal(toProviderEffort("high", profile), "on");
  assert.throws(
    () => providerRegistry.resolve({ providerId: "bailian", modelId: "qwen-plus", reasoningEffort: "high" }),
    /does not support reasoning effort/i,
  );
});

test("dynamic provider model discovery de-duplicates live ids and labels a fallback honestly", async () => {
  const registry = new ProviderRegistry(PROVIDER_PRESETS);
  const live = await registry.discoverModels({
    profile: { providerId: "kimi-cn", modelId: "moonshot-v1-8k" },
    credential: "credential-never-serialized",
    fetch: async () => new Response(JSON.stringify({
      data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }, { id: 42 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(live, [
    { id: "a-model", source: "live" },
    { id: "z-model", source: "live" },
  ]);

  const fallback = await registry.discoverModels({
    profile: { providerId: "kimi-cn", modelId: "moonshot-v1-8k" },
    credential: "credential-never-serialized",
    fetch: async () => {
      throw new Error("offline fixture");
    },
  });
  assert.equal(fallback[0]?.source, "fallback");
  assert.deepEqual(fallback.slice(0, 2), [
    { id: "moonshot-v1-8k", source: "fallback" },
    { id: "moonshot-v1-32k", source: "fallback" },
  ]);
});
