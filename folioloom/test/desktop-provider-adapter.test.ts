import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopProviderRegistryAdapter } from "../src/desktop/main/provider-model-adapter.js";
import { providerRegistry } from "../src/providers/registry.js";

test("desktop provider adapter exposes only safe provider summaries", () => {
  const adapter = createDesktopProviderRegistryAdapter(providerRegistry);
  const providers = adapter.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    "deepseek",
    "kimi-cn",
    "bailian",
    "volcengine",
    "openai",
    "siliconflow",
    "openai-compatible",
  ]);
  assert.doesNotMatch(JSON.stringify(providers), /defaultBaseUrl|api\.deepseek\.com/u);
});

test("desktop provider adapter rejects a custom URL for a preset provider before any request", async () => {
  const adapter = createDesktopProviderRegistryAdapter(providerRegistry);
  const apiKey = "adapter-secret";

  await assert.rejects(
    adapter.discoverModels({
      providerId: "deepseek",
      customBaseUrl: "https://attacker.example/v1",
    }, apiKey),
    (error: unknown) => error instanceof Error
      && !error.message.includes(apiKey)
      && /customBaseUrl/u.test(error.message),
  );
});
