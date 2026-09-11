import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopProviderRegistryAdapter } from "../src/desktop/main/provider-model-adapter.js";
import { ProviderRegistry, providerRegistry } from "../src/providers/registry.js";

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

test("desktop discovery requests live models and preserves their source", async () => {
  const registry = new ProviderRegistry();
  registry.discoverModels = async (request) => {
    assert.equal(request.forceLive, true);
    assert.equal(request.profile.providerId, "deepseek");
    return [{ id: "deepseek-flash", source: "live" }];
  };
  const models = await createDesktopProviderRegistryAdapter(registry)
    .discoverModels({ providerId: "deepseek" }, "fixture-key");
  assert.deepEqual(models, [{ id: "deepseek-flash", displayName: "deepseek-flash", source: "live" }]);
});
