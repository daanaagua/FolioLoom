import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  desktopWindowChrome,
  installNavigationGuards,
  isTrustedDesktopIpcEvent,
  preloadEntryPath,
  resolveDesktopRendererTarget,
  type DesktopNavigationWebContents,
} from "../src/desktop/main/runtime.js";
import { parseDesktopFullBookProgress } from "../src/desktop/preload/progress-validation.js";

test("desktop chrome keeps native controls in a dark overlay and removes the application menu", () => {
  assert.deepEqual(desktopWindowChrome(), {
    applicationMenu: null,
    windowOptions: {
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0c0f13",
        symbolColor: "#edf2f7",
        height: 42,
      },
    },
  });
});

test("sandboxed preload path points to Electron Vite's emitted CommonJS entry", () => {
  const mainDirectory = join(tmpdir(), "folioloom", "out", "main");
  assert.equal(
    preloadEntryPath(mainDirectory),
    join(mainDirectory, "..", "preload", "index.cjs"),
  );
});

test("packaged runtime ignores arbitrary development renderer URLs", () => {
  const rendererFilePath = join(tmpdir(), "folioloom", "out", "renderer", "index.html");
  const target = resolveDesktopRendererTarget({
    isPackaged: true,
    rendererFilePath,
    rendererUrl: "https://attacker.example/",
  });

  assert.deepEqual(target, {
    kind: "file",
    filePath: rendererFilePath,
    expectedUrl: pathToFileURL(rendererFilePath).href,
  });
});

test("development runtime accepts only a loopback renderer URL", () => {
  const rendererFilePath = join(tmpdir(), "folioloom", "out", "renderer", "index.html");
  const remoteTarget = resolveDesktopRendererTarget({
    isPackaged: false,
    rendererFilePath,
    rendererUrl: "https://attacker.example/",
  });
  assert.equal(remoteTarget.kind, "file");

  const loopbackTarget = resolveDesktopRendererTarget({
    isPackaged: false,
    rendererFilePath,
    rendererUrl: "http://127.0.0.1:5173/",
  });
  assert.deepEqual(loopbackTarget, {
    kind: "development",
    url: "http://127.0.0.1:5173/",
    expectedUrl: "http://127.0.0.1:5173/",
  });
});

test("navigation guards deny remote navigation and every window.open request", () => {
  let navigationListener: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  let windowOpenHandler: ((details: unknown) => { action: "deny" }) | undefined;
  const webContents: DesktopNavigationWebContents = {
    on(_event, listener) {
      navigationListener = listener;
    },
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler;
    },
  };

  installNavigationGuards(webContents);
  assert.notEqual(navigationListener, undefined);
  assert.notEqual(windowOpenHandler, undefined);

  let prevented = false;
  navigationListener!({ preventDefault: () => { prevented = true; } }, "https://attacker.example/");
  assert.equal(prevented, true);
  assert.deepEqual(windowOpenHandler!({ url: "https://attacker.example/" }), { action: "deny" });
});

test("trusted IPC requires the app window, expected renderer URL, and main frame", () => {
  const trustedRenderers = new Map([[17, "http://127.0.0.1:5173/"]]);
  const trustedEvent = {
    sender: { id: 17 },
    senderFrame: { url: "http://127.0.0.1:5173/", parent: null },
  };
  assert.equal(isTrustedDesktopIpcEvent(trustedEvent, trustedRenderers), true);
  assert.equal(isTrustedDesktopIpcEvent({
    sender: { id: 18 },
    senderFrame: trustedEvent.senderFrame,
  }, trustedRenderers), false);
  assert.equal(isTrustedDesktopIpcEvent({
    sender: trustedEvent.sender,
    senderFrame: { url: "https://attacker.example/", parent: null },
  }, trustedRenderers), false);
  assert.equal(isTrustedDesktopIpcEvent({
    sender: trustedEvent.sender,
    senderFrame: { url: "http://127.0.0.1:5173/untrusted-route", parent: null },
  }, trustedRenderers), false);
  assert.equal(isTrustedDesktopIpcEvent({
    sender: trustedEvent.sender,
    senderFrame: { ...trustedEvent.senderFrame, parent: {} },
  }, trustedRenderers), false);
});

test("preload exposes named onboarding operations without a generic IPC or credential reader", () => {
  const preloadSource = readFileSync(
    new URL("../src/desktop/preload/index.ts", import.meta.url),
    "utf8",
  );

  for (const operation of [
    "chooseSource",
    "confirmSourceEncoding",
    "getOnboardingState",
    "discoverModels",
    "testModel",
    "forgetCredential",
    "startTrial",
    "cancelTrial",
    "onTrialProgress",
    "getFullBookState",
    "startFullBook",
    "pauseFullBook",
    "resumeFullBook",
    "onFullBookProgress",
    "getExportState",
    "chooseExportDirectory",
    "exportBook",
    "openExportDirectory",
    "copyDiagnosticSummary",
    "exportDiagnostics",
    "listKnowledge",
    "getKnowledgeDetail",
    "mutateKnowledge",
    "promoteKnowledgeToGlobal",
    "listGlobalKnowledge",
    "attachGlobalKnowledge",
    "getKnowledgeDiagnostics",
    "chooseKnowledgeImport",
    "inspectKnowledgeImport",
    "confirmKnowledgeImportEncoding",
    "listStagedKnowledgeImports",
    "getStagedKnowledgeImport",
    "suggestKnowledgeImport",
    "stageKnowledgeImport",
    "decideKnowledgeImport",
    "commitKnowledgeImport",
    "rollbackKnowledgeImport",
    "cancelKnowledgeImportOperation",
    "cancelPendingKnowledgeImport",
    "discardStagedKnowledgeImport",
  ]) {
    assert.match(preloadSource, new RegExp(`\\b${operation}\\s*:`));
  }
  assert.match(preloadSource, /removeListener\s*\(\s*DESKTOP_TRIAL_PROGRESS_CHANNEL/u);
  assert.match(preloadSource, /removeListener\s*\(\s*DESKTOP_FULLBOOK_PROGRESS_CHANNEL/u);
  assert.doesNotMatch(preloadSource, /invoke\s*\(\s*(?:channel|name|method)\b/u);
  assert.doesNotMatch(preloadSource, /\b(?:getCredential|readCredential|readFile|globalThis\.fetch)\b/u);
});

test("main process owns diagnostic logs, clipboard, save dialog, and process failure capture", () => {
  const mainSource = readFileSync(
    new URL("../src/desktop/main/index.ts", import.meta.url),
    "utf8",
  );
  const ipcSource = readFileSync(
    new URL("../src/desktop/main/ipc.ts", import.meta.url),
    "utf8",
  );
  assert.match(mainSource, /new DesktopDiagnosticLogger/u);
  assert.match(mainSource, /clipboard\.writeText/u);
  assert.match(mainSource, /dialog\.showSaveDialog/u);
  assert.match(mainSource, /uncaughtExceptionMonitor/u);
  assert.match(mainSource, /unhandledRejection/u);
  assert.doesNotMatch(
    ipcSource,
    /diagnostics\.(?:record|recordFailure)\s*\(\s*\{[\s\S]{0,300}\b(?:args|payload)\b/u,
  );
});

test("full-book progress bridge forwards only exact bounded public projections", () => {
  const progress = {
    runId: "run-a",
    phase: "running",
    progress: {
      totalWindows: 10,
      pendingWindows: 8,
      runningWindows: 1,
      stagedWindows: 0,
      completedWindows: 1,
      warningWindows: 0,
      humanRequiredWindows: 0,
      failedWindows: 0,
    },
  };
  assert.deepEqual(parseDesktopFullBookProgress(progress), progress);
  assert.equal(parseDesktopFullBookProgress({ ...progress, storePath: "C:\\book.db" }), undefined);
  assert.equal(parseDesktopFullBookProgress({
    ...progress,
    progress: { ...progress.progress, pendingWindows: -1 },
  }), undefined);
  assert.equal(parseDesktopFullBookProgress({ ...progress, phase: "unknown" }), undefined);
});

test("main process shares one runtime resolver and settles translation before quit", () => {
  const mainSource = readFileSync(
    new URL("../src/desktop/main/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(mainSource, /const runtimeResolver:\s*DesktopRuntimeResolver/u);
  assert.match(
    mainSource,
    /new DesktopTrialService\s*\(\s*\{[\s\S]*?runtime:\s*runtimeResolver/u,
  );
  assert.match(
    mainSource,
    /new DesktopFullBookService\s*\(\s*\{[\s\S]*?runtime:\s*runtimeResolver/u,
  );
  assert.match(mainSource, /fullBookServiceForShutdown\?\.settleForShutdown\s*\(\s*\)/u);
  assert.match(mainSource, /shell\.openPath\s*\(\s*path\s*\)/u);
});
