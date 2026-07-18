import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadOpenCodeApiKey,
  loadPilotConfig,
} from "../src/config.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/config.yaml", import.meta.url),
);

test("loads the selected DeepSeek role without exposing the key in JSON", () => {
  const config = loadPilotConfig(fixturePath, "draft");

  assert.equal(config.provider, "deepseek");
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.reasoningEffort, "high");
  assert.equal(JSON.stringify(config).includes("secret-test-key"), false);
  assert.equal(config.apiKeyForRuntime(), "secret-test-key");
});

test("loads an OpenCode provider credential without serializing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-opencode-auth-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    deepseek: { type: "api", key: "opencode-fixture-key" },
  }), "utf8");
  try {
    const key = loadOpenCodeApiKey(authPath, "deepseek");
    const config = loadPilotConfig(fixturePath, "draft", { apiKeyOverride: key });
    assert.equal(config.apiKeyForRuntime(), "opencode-fixture-key");
    assert.equal(JSON.stringify(config).includes("opencode-fixture-key"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
