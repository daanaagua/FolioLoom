import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { preloadEntryPath } from "../src/desktop/main/runtime.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("desktop build emits the preload file consumed by the main process", () => {
  const preloadPath = preloadEntryPath(join(projectRoot, "out", "main"));
  assert.equal(preloadPath, join(projectRoot, "out", "preload", "index.cjs"));
  assert.equal(existsSync(preloadPath), true, `missing built preload at ${preloadPath}`);
  const preloadSource = readFileSync(preloadPath, "utf8");
  assert.doesNotMatch(preloadSource, /^\s*import\s/m, "sandboxed preload must not contain ESM imports");
  assert.match(preloadSource, /require\(["']electron["']\)/, "sandboxed preload must load Electron through CommonJS");
  let exposedApi: Record<string, unknown> | undefined;
  runInNewContext(preloadSource, {
    require(specifier: string) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name: string, value: Record<string, unknown>) {
            assert.equal(name, "folioLoom");
            exposedApi = value;
          },
        },
        ipcRenderer: {
          invoke() { return Promise.resolve(); },
          on() { return undefined; },
          removeListener() { return undefined; },
        },
      };
    },
  });
  assert.ok(exposedApi, "sandboxed preload must expose the desktop bridge");
  for (const operation of ["chooseSource", "confirmSourceEncoding", "getOnboardingState", "testModel", "startTrial"]) {
    assert.equal(typeof exposedApi[operation], "function", `missing desktop bridge operation ${operation}`);
  }
  assert.equal(
    existsSync(join(projectRoot, "out", "renderer", "index.html")),
    true,
    "missing built renderer entry",
  );
});
