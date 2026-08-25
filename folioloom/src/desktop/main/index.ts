import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} from "electron";

import {
  DESKTOP_FULLBOOK_PROGRESS_CHANNEL,
  DESKTOP_TRIAL_PROGRESS_CHANNEL,
  type DesktopFullBookProgress,
  type DesktopProjectRequest,
  type DesktopTrialProgress,
} from "../contracts.js";
import { DesktopCredentialStore } from "../desktop-credential-store.js";
import {
  DesktopDiagnosticLogger,
  formatDesktopDiagnosticSummary,
  writeDesktopDiagnosticReport,
  type DesktopDiagnosticContext,
} from "../desktop-diagnostics.js";
import { DesktopExportService } from "../desktop-export-service.js";
import { DesktopFullBookService } from "../desktop-fullbook-service.js";
import { DesktopKnowledgeImportStorage } from "../desktop-knowledge-import-storage.js";
import { DesktopKnowledgeService } from "../desktop-knowledge-service.js";
import { DesktopModelService } from "../desktop-model-service.js";
import { DesktopPreferences } from "../desktop-preferences.js";
import { DesktopProjectService } from "../desktop-project-service.js";
import { DesktopSourceService } from "../desktop-source-service.js";
import { DesktopTrialService } from "../desktop-trial-service.js";
import type {
  DesktopRuntimeResolver,
  DesktopTranslationRuntime,
} from "../desktop-runtime-plan.js";
import { createProviderRuntime } from "../../providers/runtime.js";
import { providerRegistry } from "../../providers/registry.js";
import type { ModelProfile } from "../../providers/types.js";
import { GlobalKnowledgeStore } from "../../knowledge/global-knowledge-store.js";
import { KnowledgeImportService } from "../../knowledge-import/knowledge-import-service.js";
import { RuntimeProfileStore } from "../../storage/runtime-profile-store.js";
import { runtimeProfilePath } from "../runtime-profile-path.js";
import { registerDesktopIpc } from "./ipc.js";
import { createDesktopProviderRegistryAdapter } from "./provider-model-adapter.js";
import {
  desktopWindowChrome,
  installNavigationGuards,
  isTrustedDesktopIpcEvent,
  preloadEntryPath,
  resolveDesktopRendererTarget,
} from "./runtime.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const trustedRendererUrls = new Map<number, string>();
const desktopChrome = desktopWindowChrome();
let trialServiceForShutdown: DesktopTrialService | undefined;
let fullBookServiceForShutdown: DesktopFullBookService | undefined;
let globalKnowledgeStoreForShutdown: GlobalKnowledgeStore | undefined;
let runtimeProfileStoreForShutdown: RuntimeProfileStore | undefined;
let quitAfterTrialSettles = false;
let quitSettlementStarted = false;

function broadcastTrialProgress(progress: DesktopTrialProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !trustedRendererUrls.has(window.webContents.id)) continue;
    window.webContents.send(DESKTOP_TRIAL_PROGRESS_CHANNEL, progress);
  }
}

function broadcastFullBookProgress(progress: DesktopFullBookProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !trustedRendererUrls.has(window.webContents.id)) continue;
    window.webContents.send(DESKTOP_FULLBOOK_PROGRESS_CHANNEL, progress);
  }
}

function createWindow(): BrowserWindow {
  const rendererFilePath = join(currentDirectory, "../renderer/index.html");
  const rendererTarget = resolveDesktopRendererTarget({
    isPackaged: app.isPackaged,
    rendererFilePath,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
  const window = new BrowserWindow({
    ...desktopChrome.windowOptions,
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#101318",
    title: "FolioLoom",
    webPreferences: {
      preload: preloadEntryPath(currentDirectory),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const webContentsId = window.webContents.id;
  trustedRendererUrls.set(webContentsId, rendererTarget.expectedUrl);
  window.once("closed", () => {
    trustedRendererUrls.delete(webContentsId);
  });
  installNavigationGuards(window.webContents);
  if (rendererTarget.kind === "development") {
    void window.loadURL(rendererTarget.url);
  } else {
    void window.loadFile(rendererTarget.filePath);
  }
  return window;
}

function loadRecentRequest(preferences: DesktopPreferences): DesktopProjectRequest | undefined {
  const recent = preferences.load();
  if (recent === undefined) {
    return undefined;
  }
  if (!existsSync(recent.manifestPath)) {
    // The preferences file also carries model metadata; discard only the stale
    // recent-project pointer instead of erasing a verified model setup.
    preferences.saveState({ ...preferences.loadState(), recent: undefined });
    return undefined;
  }
  return recent;
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(desktopChrome.applicationMenu);
  const userDataPath = app.getPath("userData");
  const runtimeProfileStore = new RuntimeProfileStore(
    runtimeProfilePath(userDataPath),
  );
  runtimeProfileStoreForShutdown = runtimeProfileStore;
  const preferencesPath = join(userDataPath, "desktop-preferences.json");
  const preferences = new DesktopPreferences(preferencesPath);
  const diagnosticLogger = new DesktopDiagnosticLogger({
    directory: join(userDataPath, "diagnostics"),
    appVersion: app.getVersion(),
    pathAliases: {
      userData: userDataPath,
      temp: app.getPath("temp"),
      app: app.getAppPath(),
    },
  });
  const projectService = new DesktopProjectService();
  const sourceService = new DesktopSourceService({
    projectsRoot: join(app.getPath("documents"), "FolioLoom", "Projects"),
  });
  const credentialStore = new DesktopCredentialStore({
    path: join(app.getPath("userData"), "desktop-credentials.json"),
    secretBox: safeStorage,
  });
  const modelService = new DesktopModelService({
    providers: createDesktopProviderRegistryAdapter(),
    preferences,
    credentials: credentialStore,
  });
  const runtimeResolver: DesktopRuntimeResolver = {
    async resolve() {
      const profile = preferences.loadState().activeModelProfile;
      if (profile === undefined) return undefined;
      const credential = credentialStore.read(profile.providerId);
      if (credential.status !== "available") return undefined;
      const createRuntime = (candidate: ModelProfile): DesktopTranslationRuntime => {
        const resolved = providerRegistry.resolve(candidate);
        const runtime = createProviderRuntime(resolved.profile, credential.credential);
        return {
          profile: resolved.profile,
          model: runtime.model,
          streamFn: runtime.streamFn,
          supportedEfforts: resolved.definition.capabilities.efforts,
          createWithProfile: createRuntime,
        };
      };
      return createRuntime(profile);
    },
  };
  const trialService = new DesktopTrialService({
    runtime: runtimeResolver,
    onProgress(stage) {
      diagnosticLogger.record({
        event: "desktop.trial.progress",
        operationId: "trial-active",
        phase: stage,
        outcome: stage === "completed"
          ? "completed"
          : stage === "failed"
            ? "failed"
            : "started",
        ...(stage === "failed" ? { severity: "warning" as const } : {}),
      });
      broadcastTrialProgress({ stage });
    },
  });
  const fullBookService = new DesktopFullBookService({
    runtime: runtimeResolver,
    runtimeProfileStore,
    onProgress(progress) {
      diagnosticLogger.record({
        event: "desktop.fullbook.progress",
        operationId: progress.runId,
        phase: progress.phase,
        outcome: progress.phase === "completed"
          ? "completed"
          : progress.phase === "failed"
            ? "failed"
            : "started",
        ...(progress.phase === "failed" ? { severity: "warning" as const } : {}),
        metadata: {
          totalWindows: progress.progress.totalWindows,
          completedWindows: progress.progress.completedWindows,
          warningWindows: progress.progress.warningWindows,
          humanRequiredWindows: progress.progress.humanRequiredWindows,
          failedWindows: progress.progress.failedWindows,
        },
      });
      broadcastFullBookProgress(progress);
    },
  });
  const exportService = new DesktopExportService();
  trialServiceForShutdown = trialService;
  fullBookServiceForShutdown = fullBookService;
  let currentRequest = loadRecentRequest(preferences);
  const globalKnowledgeStore = new GlobalKnowledgeStore(
    join(app.getPath("userData"), "global-knowledge.db"),
  );
  globalKnowledgeStoreForShutdown = globalKnowledgeStore;
  const knowledgeService = new DesktopKnowledgeService(
    projectService,
    globalKnowledgeStore,
    () => currentRequest,
  );
  const knowledgeImportService = new KnowledgeImportService({
    storage: new DesktopKnowledgeImportStorage(
      projectService,
      () => currentRequest,
    ),
  });

  const diagnosticContext = (): DesktopDiagnosticContext => {
    const modelSnapshot = modelService.snapshot();
    const model = modelSnapshot.activeModelProfile;
    const current = currentRequest;
    const project = current === undefined ? undefined : projectService.snapshot(current);
    let format = "unknown";
    if (current !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(current.manifestPath, "utf8")) as {
          source_format?: unknown;
        };
        if (typeof manifest.source_format === "string") format = manifest.source_format;
      } catch {
        // A malformed manifest is represented by the project error and latest operation.
      }
    }
    const fullBook = current === undefined ? undefined : fullBookService.snapshot(current);
    const activeRun = fullBook?.runs.find((run) => run.runId === fullBook.activeRunId)
      ?? fullBook?.runs.at(-1);
    return {
      ...(model === undefined
        ? {}
        : {
          model: {
            providerId: model.providerId,
            modelId: model.modelId,
            ...(model.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: model.reasoningEffort }),
            ...(modelSnapshot.latestProbe?.status === undefined
              ? {}
              : { probeStatus: modelSnapshot.latestProbe.status }),
            ...(modelSnapshot.latestProbe?.code === undefined
              ? {}
              : { probeCode: modelSnapshot.latestProbe.code }),
          },
        }),
      ...(project?.ok !== true
        ? {}
        : {
          source: {
            format,
            language: project.value.sourceLanguage,
            encoding: project.value.sourceEncoding,
            characterCount: project.value.sourceChars,
            hashPrefix: project.value.sourceVersion.slice(0, 16),
          },
        }),
      ...(activeRun === undefined
        ? {}
        : {
          runSummary: {
            runId: activeRun.runId,
            phase: activeRun.phase,
            totalWindows: activeRun.progress.totalWindows,
            completedWindows: activeRun.progress.completedWindows,
            warningWindows: activeRun.progress.warningWindows,
            humanRequiredWindows: activeRun.progress.humanRequiredWindows,
            failedWindows: activeRun.progress.failedWindows,
          },
        }),
    };
  };

  const processFailure = (event: string, error: unknown): void => {
    diagnosticLogger.recordFailure({
      event,
      operationId: randomUUID(),
      phase: "main-process",
      error,
    });
  };
  const onUncaughtException = (error: Error): void => {
    processFailure("desktop.process.uncaught-exception", error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    processFailure("desktop.process.unhandled-rejection", reason);
  };
  process.on("uncaughtExceptionMonitor", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  app.once("will-quit", () => {
    process.off("uncaughtExceptionMonitor", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  });

  registerDesktopIpc({
    ipcMain: {
      handle(channel, handler) {
        ipcMain.handle(channel, handler);
      },
    },
    dialog: {
      showOpenDialog(options) {
        return dialog.showOpenDialog(options);
      },
      showSaveDialog(options) {
        return dialog.showSaveDialog(options);
      },
    },
    projectService,
    sourceService,
    modelService,
    trialService,
    fullBookService,
    exportService,
    knowledgeService,
    knowledgeImportService,
    diagnostics: {
      record(input) {
        diagnosticLogger.record({
          ...input,
          ...(currentRequest === undefined
            ? {}
            : { projectDirectory: dirname(currentRequest.manifestPath) }),
        });
      },
      recordFailure(input) {
        diagnosticLogger.recordFailure({
          ...input,
          ...(currentRequest === undefined
            ? {}
            : { projectDirectory: dirname(currentRequest.manifestPath) }),
        });
      },
      copySummary() {
        clipboard.writeText(formatDesktopDiagnosticSummary(
          diagnosticLogger.buildReport(diagnosticContext()),
        ));
      },
      exportReport(path) {
        writeDesktopDiagnosticReport(
          path,
          diagnosticLogger.buildReport(diagnosticContext()),
        );
      },
    },
    isTrustedEvent(event) {
      return isTrustedDesktopIpcEvent(event, trustedRendererUrls);
    },
    getCurrentRequest() {
      return currentRequest;
    },
    setCurrentRequest(request) {
      currentRequest = request;
      preferences.save(request);
    },
    openDirectory(path) {
      return shell.openPath(path);
    },
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalKnowledgeStoreForShutdown?.close();
  globalKnowledgeStoreForShutdown = undefined;
  runtimeProfileStoreForShutdown?.close();
  runtimeProfileStoreForShutdown = undefined;
});

app.on("before-quit", (event) => {
  if (quitAfterTrialSettles
    || (trialServiceForShutdown === undefined && fullBookServiceForShutdown === undefined)) return;
  event.preventDefault();
  if (quitSettlementStarted) return;
  quitSettlementStarted = true;
  void Promise.all([
    trialServiceForShutdown?.cancel(),
    fullBookServiceForShutdown?.settleForShutdown(),
  ]).finally(() => {
    quitAfterTrialSettles = true;
    app.quit();
  });
});
