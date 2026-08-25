import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopPreferences, type DesktopModelPreference, type DesktopProbePreference } from "../src/desktop/desktop-preferences.js";

test("recent project preferences keep only supported absolute fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-preferences-"));
  const path = join(directory, "preferences.json");
  const manifestPath = join(directory, "source_manifest.json");
  const storePath = join(directory, "book.db");
  try {
    const preferences = new DesktopPreferences(path);
    assert.equal(preferences.load(), undefined);

    preferences.save({
      manifestPath,
      storePath,
      runId: "run-desktop",
      glossaryPath: join(directory, "glossary.json"),
    });

    assert.deepEqual(preferences.load(), { manifestPath, storePath, runId: "run-desktop" });
    const payload = JSON.parse(readFileSync(path, "utf8")) as { schema: string; recent: Record<string, unknown> };
    assert.equal(payload.schema, "folioloom-desktop-preferences-2");
    assert.deepEqual(Object.keys(payload.recent).sort(), ["manifestPath", "runId", "storePath"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema one recent projects migrate without persisting model secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-preferences-"));
  const path = join(directory, "preferences.json");
  const manifestPath = join(directory, "source_manifest.json");
  try {
    writeFileSync(path, JSON.stringify({
      schema: "folioloom-desktop-preferences-1",
      recent: { manifestPath },
    }), "utf8");
    const preferences = new DesktopPreferences(path);
    assert.deepEqual(preferences.loadState(), { recent: { manifestPath } });

    preferences.saveState({
      recent: { manifestPath },
      activeModelProfile: {
        providerId: "deepseek",
        modelId: "deepseek-reasoner",
        reasoningEffort: "max",
        customBaseUrl: "https://example.invalid/v1",
        apiKey: "must-not-persist",
      } as unknown as DesktopModelPreference,
      latestProbe: {
        status: "ready",
        providerId: "deepseek",
        modelId: "deepseek-reasoner",
        code: "READY",
        message: "Connected",
        apiKey: "must-not-persist",
      } as unknown as DesktopProbePreference,
    });

    const serialized = readFileSync(path, "utf8");
    assert.doesNotMatch(serialized, /must-not-persist/);
    const payload = JSON.parse(serialized) as {
      schema: string;
      activeModelProfile: Record<string, unknown>;
      latestProbe: Record<string, unknown>;
    };
    assert.equal(payload.schema, "folioloom-desktop-preferences-2");
    assert.deepEqual(payload.activeModelProfile, {
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
      reasoningEffort: "max",
      customBaseUrl: "https://example.invalid/v1",
    });
    assert.deepEqual(payload.latestProbe, {
      status: "ready",
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
      code: "READY",
      message: "Connected",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recent project preferences ignore corrupt or unsupported files", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-preferences-"));
  const path = join(directory, "preferences.json");
  try {
    const preferences = new DesktopPreferences(path);
    writeFileSync(path, "not JSON", "utf8");
    assert.equal(preferences.load(), undefined);

    writeFileSync(path, JSON.stringify({ schema: "other", recent: { manifestPath: "C:\\book.json" } }), "utf8");
    assert.equal(preferences.load(), undefined);

    writeFileSync(path, JSON.stringify({
      schema: "folioloom-desktop-preferences-2",
      recent: { manifestPath: "relative/source_manifest.json" },
    }), "utf8");
    assert.equal(preferences.load(), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
