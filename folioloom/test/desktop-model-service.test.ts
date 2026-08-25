import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopCredentialStore, type DesktopSecretBox } from "../src/desktop/desktop-credential-store.js";
import { DesktopModelService, type DesktopProviderRegistry } from "../src/desktop/desktop-model-service.js";
import { DesktopPreferences } from "../src/desktop/desktop-preferences.js";

function secretBox(): DesktopSecretBox {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString(value) {
      return value.toString("utf8").replace(/^encrypted:/, "");
    },
  };
}

function registry(status: "ready" | "limited" = "ready"): DesktopProviderRegistry & {
  seenCredentials: string[];
} {
  const seenCredentials: string[] = [];
  return {
    seenCredentials,
    listProviders() {
      return [{
        id: "deepseek",
        displayName: "DeepSeek",
        keyPlaceholder: "DeepSeek API Key",
        efforts: ["off", "medium", "max"],
        fallbackModelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
        allowManualModel: false,
        allowCustomBaseUrl: false,
      }];
    },
    async discoverModels(_request, credential) {
      seenCredentials.push(credential);
      return [{ id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }];
    },
    async probe(_profile, credential) {
      seenCredentials.push(credential);
      return {
        status,
        code: status === "ready" ? "READY" : "TOOL_CALL_UNSUPPORTED",
        message: `probe saw ${credential}`,
        retryable: false,
      };
    },
  };
}

test("model service persists only ready non-secret model settings and never returns the API key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-model-service-"));
  const preferencesPath = join(directory, "preferences.json");
  const credentialsPath = join(directory, "credentials.json");
  const apiKey = "sk-model-service-secret";
  try {
    const providers = registry();
    const preferences = new DesktopPreferences(preferencesPath);
    const credentials = new DesktopCredentialStore({ path: credentialsPath, secretBox: secretBox() });
    const service = new DesktopModelService({ providers, preferences, credentials, now: () => "2026-07-22T00:00:00.000Z" });

    assert.deepEqual(service.listProviders(), [{
      id: "deepseek",
      displayName: "DeepSeek",
      keyPlaceholder: "DeepSeek API Key",
      efforts: ["off", "medium", "max"],
      fallbackModelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
      allowManualModel: false,
      allowCustomBaseUrl: false,
      credentialStatus: "missing",
    }]);

    const result = await service.testAndSave({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max",
      apiKey,
    });

    assert.equal(result.report.status, "ready");
    assert.equal(result.report.providerId, "deepseek");
    assert.equal(result.report.modelId, "deepseek-v4-pro");
    assert.deepEqual(preferences.loadState().activeModelProfile, {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningEffort: "max",
    });
    assert.equal(preferences.loadState().latestProbe?.providerId, "deepseek");
    assert.equal(preferences.loadState().latestProbe?.modelId, "deepseek-v4-pro");
    assert.deepEqual(providers.seenCredentials, [apiKey]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
    assert.doesNotMatch(readFileSync(preferencesPath, "utf8"), new RegExp(apiKey));
    assert.doesNotMatch(JSON.stringify(service.snapshot()), new RegExp(apiKey));

    const discovered = await service.discoverModels({ providerId: "deepseek" });
    assert.deepEqual(discovered, [{ id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }]);
    assert.deepEqual(providers.seenCredentials, [apiKey, apiKey]);

    service.forgetCredential("deepseek");
    assert.equal(credentials.read("deepseek").status, "missing");
    assert.equal(preferences.loadState().activeModelProfile, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snapshot invalidates a retired persisted DeepSeek model without deleting its credential", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-model-service-"));
  try {
    const preferences = new DesktopPreferences(join(directory, "preferences.json"));
    const credentials = new DesktopCredentialStore({
      path: join(directory, "credentials.json"),
      secretBox: secretBox(),
    });
    credentials.save("deepseek", "keep-this-credential");
    preferences.saveState({
      activeModelProfile: {
        providerId: "deepseek",
        modelId: "deepseek-chat",
      },
      latestProbe: {
        status: "ready",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        code: "READY",
      },
    });
    const service = new DesktopModelService({
      providers: registry(),
      preferences,
      credentials,
    });

    const snapshot = service.snapshot();
    assert.equal(snapshot.activeModelProfile, undefined);
    assert.equal(snapshot.latestProbe, undefined);
    assert.equal(credentials.read("deepseek").status, "available");
    assert.equal(preferences.loadState().activeModelProfile, undefined);
    assert.equal(preferences.loadState().latestProbe, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only openai-compatible providers may persist a custom endpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-model-service-"));
  try {
    const providers = registry();
    providers.listProviders = () => [{
      id: "openai-compatible",
      displayName: "Custom OpenAI-compatible",
      keyPlaceholder: "Compatible API Key",
      efforts: [],
      fallbackModelIds: [],
      allowManualModel: true,
      allowCustomBaseUrl: true,
    }];
    const preferences = new DesktopPreferences(join(directory, "preferences.json"));
    const service = new DesktopModelService({
      providers,
      preferences,
      credentials: new DesktopCredentialStore({ path: join(directory, "credentials.json"), secretBox: secretBox() }),
      now: () => "2026-07-22T00:00:00.000Z",
    });

    await service.testAndSave({
      providerId: "openai-compatible",
      modelId: "local-model",
      customBaseUrl: "https://example.invalid/v1",
      apiKey: "compatible-secret",
    });

    assert.equal(
      preferences.loadState().activeModelProfile?.customBaseUrl,
      "https://example.invalid/v1",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preset providers reject custom endpoints before saving a model profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-model-service-"));
  try {
    const preferences = new DesktopPreferences(join(directory, "preferences.json"));
    const credentials = new DesktopCredentialStore({ path: join(directory, "credentials.json"), secretBox: secretBox() });
    const service = new DesktopModelService({
      providers: registry(),
      preferences,
      credentials,
    });

    await assert.rejects(
      service.discoverModels({
        providerId: "deepseek",
        customBaseUrl: "https://example.invalid/v1",
        apiKey: "preset-provider-secret",
      }),
      /不支持自定义接口地址/,
    );
    await assert.rejects(
      service.testAndSave({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        customBaseUrl: "https://example.invalid/v1",
        apiKey: "preset-provider-secret",
      }),
      /不支持自定义接口地址/,
    );
    assert.equal(credentials.read("deepseek").status, "missing");
    assert.equal(preferences.loadState().activeModelProfile, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("limited probes do not save a key or active model profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-model-service-"));
  try {
    const preferences = new DesktopPreferences(join(directory, "preferences.json"));
    const credentials = new DesktopCredentialStore({ path: join(directory, "credentials.json"), secretBox: secretBox() });
    const service = new DesktopModelService({
      providers: registry("limited"),
      preferences,
      credentials,
      now: () => "2026-07-22T00:00:00.000Z",
    });

    const result = await service.testAndSave({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      apiKey: "limited-model-secret",
    });

    assert.equal(result.report.status, "limited");
    assert.equal(credentials.read("deepseek").status, "missing");
    assert.equal(preferences.loadState().activeModelProfile, undefined);
    assert.doesNotMatch(JSON.stringify(result), /limited-model-secret/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model discovery replaces provider-thrown secret text with a safe error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-model-service-"));
  const apiKey = "provider-discovery-secret";
  try {
    const providers = registry();
    providers.discoverModels = async (_request, credential) => {
      throw new Error(`provider transport leaked ${credential}`);
    };
    const service = new DesktopModelService({
      providers,
      preferences: new DesktopPreferences(join(directory, "preferences.json")),
      credentials: new DesktopCredentialStore({ path: join(directory, "credentials.json"), secretBox: secretBox() }),
    });

    await assert.rejects(
      service.discoverModels({ providerId: "deepseek", apiKey }),
      (error: unknown) => error instanceof Error
        && !error.message.includes(apiKey)
        && /无法获取可用模型/.test(error.message),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
