import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  DesktopChooseSourceResult,
  DesktopDoctorReport,
  DesktopExportFormat,
  DesktopExportRequest,
  DesktopFullBookSnapshot,
  DesktopKnowledgeDiagnostics,
  DesktopKnowledgeMutationRequest,
  DesktopKnowledgePage,
  PendingKnowledgeImport,
  StagedImportReport,
  DesktopProjectRequest,
  DesktopProjectSnapshot,
  DesktopResult,
  DesktopTrialMode,
  DesktopTrialResult,
} from "../src/desktop/contracts.js";
import {
  registerDesktopIpc,
  type DesktopIpcDependencies,
  type DesktopIpcHandler,
  type DesktopIpcModelSnapshot,
  type DesktopIpcModelTestResult,
} from "../src/desktop/main/ipc.js";

const EMPTY_DOCTOR_REPORT: DesktopDoctorReport = {
  sourceVersion: "source-v1",
  sourceChars: 1,
  coveredChars: 1,
  annotationCount: 0,
  blockCount: 0,
  windowCount: 0,
  incidentCodes: [],
  anomalyCount: 0,
};

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T = never>(code: string, message: string): DesktopResult<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

function snapshotFor(
  manifestPath: string,
  activeRunIds: readonly string[],
  request: DesktopProjectRequest,
): DesktopProjectSnapshot {
  const runs = activeRunIds.map((runId) => ({
    runId,
    sourceVersion: "source-v1",
    modelId: "desktop-test-model",
    status: "running",
    progress: {
      totalWindows: 1,
      pendingWindows: 1,
      completedWindows: 0,
      warningWindows: 0,
      humanRequiredWindows: 0,
      failedWindows: 0,
    },
  }));
  return {
    title: "fixture",
    sourceLanguage: "en",
    detectedLanguage: "英语",
    sourceEncoding: "utf-8",
    encodingConfidence: 1,
    languageProfileVersion: "source-language-profile-2",
    sourceChars: 1,
    sourceVersion: "source-v1",
    store: { state: "ready" },
    runs,
    ...(runs.length === 1 ? { selectedRunId: runs[0]!.runId } : {}),
    runSelection: runs.length <= 1 ? "selected" : "required",
  };
}

interface IpcFixtureOptions {
  activeRunIds?: readonly string[];
  pickedStore?: "directory" | "text";
  pickedSource?: "cancel" | "source" | "invalid";
  existingReadyModel?: boolean;
  testStatus?: "ready" | "limited" | "failed";
  sourceEncodingRequired?: boolean;
  pickedKnowledgeImport?: boolean;
  pickedExportDirectory?: "selected" | "cancel-after-selected";
  diagnosticSave?: "selected" | "cancel";
  fullBookActive?: boolean;
}

interface IpcFixture {
  directory: string;
  manifestPath: string;
  sourcePath: string;
  textPath: string;
  handlers: Map<string, DesktopIpcHandler>;
  trustedEvent: unknown;
  snapshotCalls: number;
  sourceImports: readonly string[];
  sourceRequests: readonly unknown[];
  encodingConfirmations: readonly unknown[];
  modelCalls: {
    discoveries: readonly unknown[];
    tests: readonly unknown[];
    forgotten: readonly unknown[];
  };
  trialCalls: {
    starts: readonly { manifestPath: string; mode: DesktopTrialMode }[];
    cancellations: number;
  };
  fullBookCalls: {
    starts: readonly unknown[];
    pauses: number;
    resumes: readonly unknown[];
  };
  exportCalls: {
    destinations: readonly string[];
    exports: readonly unknown[];
    opened: readonly string[];
  };
  knowledgeCalls: {
    lists: readonly unknown[];
    mutations: readonly unknown[];
  };
  knowledgeImportCalls: {
    registered: readonly string[];
    staged: readonly unknown[];
  };
  dialogFilters: ReadonlyArray<{ name: string; extensions: string[] }>;
  dialogProperties: readonly string[][];
  diagnosticCalls: {
    events: readonly unknown[];
    failures: readonly unknown[];
    copies: number;
    exports: readonly string[];
  };
  currentRequest: DesktopProjectRequest | undefined;
}

function registerFixtureHandlers(options: IpcFixtureOptions = {}): IpcFixture {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-ipc-"));
  const manifestPath = join(directory, "source_manifest.json");
  const importedManifestPath = join(directory, "Imported", "source_manifest.json");
  const sourcePath = join(directory, "chapter.epub");
  const invalidSourcePath = join(directory, "chapter.exe");
  const textPath = join(directory, "not-a-store.txt");
  const knowledgeImportPath = join(directory, "terms.xlsx");
  const exportDirectory = join(directory, "exports");
  const activeRunIds = options.activeRunIds ?? [];
  const handlers = new Map<string, DesktopIpcHandler>();
  const sourceImports: string[] = [];
  const sourceRequests: unknown[] = [];
  const encodingConfirmations: unknown[] = [];
  const discoveries: unknown[] = [];
  const tests: unknown[] = [];
  const forgotten: unknown[] = [];
  const trialStarts: Array<{ manifestPath: string; mode: DesktopTrialMode }> = [];
  const knowledgeLists: unknown[] = [];
  const knowledgeMutations: unknown[] = [];
  const registeredKnowledgeImports: string[] = [];
  const stagedKnowledgeImports: unknown[] = [];
  const fullBookStarts: unknown[] = [];
  const fullBookResumes: unknown[] = [];
  const exportDestinations: string[] = [];
  const exportRequests: unknown[] = [];
  const openedDirectories: string[] = [];
  const diagnosticEvents: unknown[] = [];
  const diagnosticFailures: unknown[] = [];
  const diagnosticExports: string[] = [];
  let diagnosticCopies = 0;
  let trialCancellations = 0;
  let fullBookPauses = 0;
  let exportDialogCount = 0;
  const dialogFilters: Array<{ name: string; extensions: string[] }> = [];
  const dialogProperties: string[][] = [];
  const trustedEvent = {
    sender: { id: 7 },
    senderFrame: { url: "file:///folioloom/index.html", parent: null },
  };
  let snapshotCalls = 0;
  let currentRequest: DesktopProjectRequest | undefined = { manifestPath };
  let activeModelProfile: {
    providerId: string;
    modelId: string;
    reasoningEffort?: string;
    customBaseUrl?: string;
  } | undefined = options.existingReadyModel
    ? { providerId: "deepseek", modelId: "saved-ready-model" }
    : undefined;
  let latestProbe: {
    status: "ready" | "limited" | "failed";
    code?: string;
    message?: string;
    retryable?: boolean;
    checkedAt?: string;
  } | undefined = options.existingReadyModel
    ? {
      status: "ready",
      code: "READY",
      message: "Saved model was verified.",
      retryable: false,
      checkedAt: "2026-07-22T00:00:00.000Z",
    }
    : undefined;

  const modelSnapshot = (): DesktopIpcModelSnapshot => ({
    providers: [{
      id: "deepseek",
      displayName: "DeepSeek",
      keyPlaceholder: "DeepSeek API Key",
      efforts: ["off", "high", "max"],
      fallbackModelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
      allowManualModel: false,
      allowCustomBaseUrl: false,
      credentialStatus: activeModelProfile === undefined ? "missing" as const : "available" as const,
      ...(activeModelProfile === undefined ? {} : { credentialPersistence: "encrypted" as const }),
    }],
    ...(activeModelProfile === undefined ? {} : { activeModelProfile }),
    ...(latestProbe === undefined ? {} : { latestProbe }),
  });

  const dependencies: DesktopIpcDependencies = {
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    dialog: {
      async showOpenDialog(dialogOptions) {
        dialogProperties.push([...dialogOptions.properties]);
        dialogFilters.push(...dialogOptions.filters.map((filter) => ({
          name: filter.name,
          extensions: [...filter.extensions],
        })));
        if (dialogOptions.properties.includes("openDirectory")) {
          exportDialogCount += 1;
          const selected = options.pickedExportDirectory === "selected"
            || (options.pickedExportDirectory === "cancel-after-selected"
              && exportDialogCount === 1);
          return selected
            ? { canceled: false, filePaths: [exportDirectory] }
            : { canceled: true, filePaths: [] };
        }
        const extension = dialogOptions.filters[0]?.extensions[0];
        const selected = dialogOptions.filters[0]?.extensions.includes("xlsx")
          ? options.pickedKnowledgeImport
            ? knowledgeImportPath
            : undefined
          : extension === "txt"
          ? options.pickedSource === "source"
            ? sourcePath
            : options.pickedSource === "invalid"
              ? invalidSourcePath
            : undefined
          : extension !== "db"
          ? manifestPath
          : options.pickedStore === "directory"
            ? directory
            : options.pickedStore === "text"
              ? textPath
              : undefined;
        return selected === undefined
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [selected] };
      },
      async showSaveDialog() {
        return options.diagnosticSave === "selected"
          ? {
            canceled: false,
            filePath: join(directory, "FolioLoom-diagnostics.json"),
          }
          : { canceled: true };
      },
    },
    diagnostics: {
      record(input) {
        diagnosticEvents.push(input);
      },
      recordFailure(input) {
        diagnosticFailures.push(input);
      },
      copySummary() {
        diagnosticCopies += 1;
      },
      exportReport(path) {
        diagnosticExports.push(path);
      },
    },
    projectService: {
      snapshot(request) {
        snapshotCalls += 1;
        if (request.storePath === directory || request.storePath === textPath) {
          return fail("DESKTOP_INPUT_INVALID", "storePath must identify a .db file");
        }
        return ok(snapshotFor(manifestPath, activeRunIds, request));
      },
      doctor() {
        return ok(EMPTY_DOCTOR_REPORT);
      },
    },
    sourceService: {
      async importSource(request) {
        sourceImports.push(request.sourcePath);
        sourceRequests.push(request);
        return options.sourceEncodingRequired
          ? {
            status: "encoding_required" as const,
            pendingImportId: "8f0f8277-ec45-41dc-82e1-55586912908b",
            fileName: "chapter.epub",
            encodings: ["euc-kr" as const, "windows-949" as const],
          }
          : { status: "ready" as const, manifestPath: importedManifestPath };
      },
      async confirmEncoding(request) {
        encodingConfirmations.push(request);
        return { status: "ready" as const, manifestPath: importedManifestPath };
      },
    },
    modelService: {
      snapshot: modelSnapshot,
      async discoverModels(request) {
        discoveries.push(request);
        return [{ id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" }];
      },
      async testAndSave(request): Promise<DesktopIpcModelTestResult> {
        tests.push(request);
        const status = options.testStatus ?? "ready";
        if (status === "ready") {
          activeModelProfile = {
            providerId: request.providerId,
            modelId: request.modelId,
            ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
            ...(request.customBaseUrl === undefined ? {} : { customBaseUrl: request.customBaseUrl }),
          };
        }
        latestProbe = {
          status,
          code: status === "ready" ? "READY" : "TOOL_CALL_UNSUPPORTED",
          message: status === "ready" ? "Compatibility passed." : "Compatibility failed.",
          retryable: false,
          checkedAt: "2026-07-22T00:00:00.000Z",
        };
        return { report: latestProbe, snapshot: modelSnapshot() };
      },
      forgetCredential(providerId) {
        forgotten.push(providerId);
        activeModelProfile = undefined;
      },
    },
    trialService: {
      async start(request) {
        trialStarts.push(request);
        return {
          runId: "trial-run-1",
          sourceText: "The bell rang.",
          translationText: "钟声响起。",
        } satisfies DesktopTrialResult;
      },
      async cancel() {
        trialCancellations += 1;
      },
    },
    fullBookService: {
      snapshot() {
        return {
          ...(options.fullBookActive ? { activeRunId: "run-a" } : {}),
          runs: activeRunIds.map((runId) => ({
            runId,
            sourceVersion: "source-v1",
            modelId: "desktop-test-model",
            mode: "quality" as const,
            optimizationProfile: "balanced" as const,
            phase: "paused" as const,
            progress: {
              totalWindows: 2,
              pendingWindows: 1,
              runningWindows: 0,
              stagedWindows: 0,
              completedWindows: 1,
              warningWindows: 0,
              humanRequiredWindows: 0,
              failedWindows: 0,
            },
            canPause: false,
            canResume: true,
            canExport: false,
          })),
        } satisfies DesktopFullBookSnapshot;
      },
      async start(project, request) {
        fullBookStarts.push({ project, request });
        return this.snapshot(project);
      },
      async pause() {
        fullBookPauses += 1;
        return this.snapshot({ manifestPath });
      },
      async resume(project, request) {
        fullBookResumes.push({ project, request });
        return this.snapshot(project);
      },
      hasActiveTask() {
        return options.fullBookActive === true;
      },
    },
    exportService: {
      snapshot() {
        return {
          candidates: [{
            runId: "run-a",
            modelId: "desktop-test-model",
            status: "ready" as const,
            completedWindows: 2,
            totalWindows: 2,
            blockers: [],
          }],
          defaultDestination: {
            destinationId: "default-destination",
            displayPath: join(directory, "default-exports"),
          },
        };
      },
      registerDestination(path) {
        exportDestinations.push(path);
        return {
          destinationId: "chosen-destination",
          displayPath: path,
        };
      },
      async export(project, request) {
        exportRequests.push({ project, request });
        return {
          exportId: "export-1",
          runId: request.runId,
          directory: exportDirectory,
          files: request.formats.map((format: DesktopExportFormat) => ({
            format,
            fileName: `${format}.file`,
          })),
        };
      },
      completedDirectory(exportId) {
        return exportId === "export-1" ? exportDirectory : undefined;
      },
    },
    async openDirectory(path) {
      openedDirectories.push(path);
      return "";
    },
    knowledgeService: {
      list(request) {
        knowledgeLists.push(request);
        return ok({
          generation: 0,
          snapshotId: "snapshot-0",
          items: [],
        } satisfies DesktopKnowledgePage);
      },
      detail() {
        return fail("KNOWLEDGE_NOT_FOUND", "not found");
      },
      mutate(request: DesktopKnowledgeMutationRequest) {
        knowledgeMutations.push(request);
        return fail("KNOWLEDGE_NOT_FOUND", "not found");
      },
      promoteGlobal() {
        return fail("KNOWLEDGE_NOT_FOUND", "not found");
      },
      listGlobal() {
        return ok({ items: [] });
      },
      attachGlobal() {
        return fail("GLOBAL_KNOWLEDGE_REVISION_NOT_FOUND", "not found");
      },
      diagnostics() {
        return ok({
          schemaVersion: 3,
          knowledgeGeneration: 0,
          countsByType: {},
          countsByStatus: {},
          pendingImpacts: 0,
          latestMigration: "lossless-book-schema-v3",
        } satisfies DesktopKnowledgeDiagnostics);
      },
    },
    knowledgeImportService: {
      registerPending(path) {
        registeredKnowledgeImports.push(path);
        return {
          pendingImportId: "a22f46e4-539b-45e1-84a7-9c58a69eb92d",
          fileName: "terms.xlsx",
          format: "xlsx",
        } satisfies PendingKnowledgeImport;
      },
      async inspect() {
        throw new Error("not used");
      },
      async confirmEncoding() {
        throw new Error("not used");
      },
      async suggestMapping() {
        throw new Error("not used");
      },
      async stage(request) {
        stagedKnowledgeImports.push(request);
        return {
          batchId: "833c5f65-3ae0-4128-b2db-3f900d33f2ee",
          counts: {
            ready: 0,
            merge: 0,
            conflict: 0,
            invalid: 0,
            skipped: 0,
          },
          unresolved: 0,
          rows: [],
        } satisfies StagedImportReport;
      },
      async listStaged() {
        return [];
      },
      async getStaged() {
        throw new Error("not used");
      },
      async setDecisions() {
        throw new Error("not used");
      },
      async discardStaged() {},
      async commit() {
        throw new Error("not used");
      },
      async rollback() {
        throw new Error("not used");
      },
      cancelOperation() {},
      cancelPendingImport() {},
    },
    isTrustedEvent(event) {
      return event === trustedEvent;
    },
    getCurrentRequest() {
      return currentRequest;
    },
    setCurrentRequest(request) {
      currentRequest = request;
    },
  };
  registerDesktopIpc(dependencies);
  return {
    directory,
    manifestPath,
    sourcePath,
    textPath,
    handlers,
    trustedEvent,
    get snapshotCalls() {
      return snapshotCalls;
    },
    get sourceImports() {
      return sourceImports;
    },
    get sourceRequests() {
      return sourceRequests;
    },
    get encodingConfirmations() {
      return encodingConfirmations;
    },
    get modelCalls() {
      return { discoveries, tests, forgotten };
    },
    get trialCalls() {
      return { starts: trialStarts, cancellations: trialCancellations };
    },
    get fullBookCalls() {
      return {
        starts: fullBookStarts,
        pauses: fullBookPauses,
        resumes: fullBookResumes,
      };
    },
    get exportCalls() {
      return {
        destinations: exportDestinations,
        exports: exportRequests,
        opened: openedDirectories,
      };
    },
    get knowledgeCalls() {
      return { lists: knowledgeLists, mutations: knowledgeMutations };
    },
    get knowledgeImportCalls() {
      return {
        registered: registeredKnowledgeImports,
        staged: stagedKnowledgeImports,
      };
    },
    get dialogFilters() {
      return dialogFilters;
    },
    get dialogProperties() {
      return dialogProperties;
    },
    get diagnosticCalls() {
      return {
        events: diagnosticEvents,
        failures: diagnosticFailures,
        copies: diagnosticCopies,
        exports: diagnosticExports,
      };
    },
    get currentRequest() {
      return currentRequest;
    },
  };
}

function handler(fixture: IpcFixture, channel: string): DesktopIpcHandler {
  const registered = fixture.handlers.get(channel);
  if (registered === undefined) {
    throw new Error(`missing handler for ${channel}`);
  }
  return registered;
}

test("IPC only registers the desktop allowlist", () => {
  const fixture = registerFixtureHandlers();
  try {
    assert.deepEqual([...fixture.handlers.keys()].sort(), [
      "folioloom:choose-source",
      "folioloom:confirm-source-encoding",
      "folioloom:copy-diagnostic-summary",
      "folioloom:choose-project",
      "folioloom:choose-export-directory",
      "folioloom:choose-store",
      "folioloom:discover-models",
      "folioloom:doctor",
      "folioloom:forget-credential",
      "folioloom:fullbook-state",
      "folioloom:knowledge-list",
      "folioloom:knowledge-detail",
      "folioloom:knowledge-mutate",
      "folioloom:knowledge-promote-global",
      "folioloom:knowledge-global-list",
      "folioloom:knowledge-global-attach",
      "folioloom:knowledge-diagnostics",
      "folioloom:knowledge-import-choose",
      "folioloom:knowledge-import-inspect",
      "folioloom:knowledge-import-confirm-encoding",
      "folioloom:knowledge-import-list-staged",
      "folioloom:knowledge-import-get-staged",
      "folioloom:knowledge-import-suggest",
      "folioloom:knowledge-import-stage",
      "folioloom:knowledge-import-decide",
      "folioloom:knowledge-import-commit",
      "folioloom:knowledge-import-rollback",
      "folioloom:knowledge-import-cancel-operation",
      "folioloom:knowledge-import-cancel-pending",
      "folioloom:knowledge-import-discard-staged",
      "folioloom:onboarding-state",
      "folioloom:open-export-directory",
      "folioloom:pause-fullbook",
      "folioloom:refresh-project",
      "folioloom:resume-fullbook",
      "folioloom:select-run",
      "folioloom:export-book",
      "folioloom:export-diagnostics",
      "folioloom:export-state",
      "folioloom:test-model",
      "folioloom:start-fullbook",
      "folioloom:start-trial",
      "folioloom:cancel-trial",
    ].sort());
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("trusted IPC records only bounded operation metadata and never records request payloads", async () => {
  const fixture = registerFixtureHandlers();
  const apiKey = "sk-never-log-this";
  try {
    await handler(fixture, "folioloom:test-model")(fixture.trustedEvent, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      apiKey,
    });
    const serialized = JSON.stringify({
      events: fixture.diagnosticCalls.events,
      failures: fixture.diagnosticCalls.failures,
    });
    assert.match(serialized, /folioloom:test-model/u);
    assert.doesNotMatch(serialized, new RegExp(apiKey));
    assert.doesNotMatch(serialized, /providerId|modelId|args|payload/u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("diagnostic summary and export use fixed operations while cancellation remains silent", async () => {
  const cancelledFixture = registerFixtureHandlers({ diagnosticSave: "cancel" });
  try {
    const copied = await handler(cancelledFixture, "folioloom:copy-diagnostic-summary")(
      cancelledFixture.trustedEvent,
    ) as DesktopResult<void>;
    assert.deepEqual(copied, ok(undefined));
    assert.equal(cancelledFixture.diagnosticCalls.copies, 1);

    const cancelled = await handler(cancelledFixture, "folioloom:export-diagnostics")(
      cancelledFixture.trustedEvent,
    ) as DesktopResult<unknown>;
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.error.code, "DESKTOP_SELECTION_CANCELLED");
    assert.equal(cancelledFixture.diagnosticCalls.exports.length, 0);
  } finally {
    rmSync(cancelledFixture.directory, { recursive: true, force: true });
  }

  const selectedFixture = registerFixtureHandlers({ diagnosticSave: "selected" });
  try {
    const exported = await handler(selectedFixture, "folioloom:export-diagnostics")(
      selectedFixture.trustedEvent,
    ) as DesktopResult<{ fileName: string; displayPath: string }>;
    assert.equal(exported.ok, true);
    if (exported.ok) {
      assert.equal(exported.value.fileName, "FolioLoom-diagnostics.json");
      assert.match(exported.value.displayPath, /FolioLoom-diagnostics\.json$/u);
    }
    assert.equal(selectedFixture.diagnosticCalls.exports.length, 1);
  } finally {
    rmSync(selectedFixture.directory, { recursive: true, force: true });
  }
});

test("knowledge import IPC owns file paths and rejects renderer path injection", async () => {
  const fixture = registerFixtureHandlers({ pickedKnowledgeImport: true });
  try {
    const chosen = await handler(
      fixture,
      "folioloom:knowledge-import-choose",
    )(fixture.trustedEvent) as DesktopResult<PendingKnowledgeImport>;
    assert.deepEqual(chosen, ok({
      pendingImportId: "a22f46e4-539b-45e1-84a7-9c58a69eb92d",
      fileName: "terms.xlsx",
      format: "xlsx",
    }));
    assert.equal(fixture.knowledgeImportCalls.registered.length, 1);
    assert.doesNotMatch(JSON.stringify(chosen), /[A-Z]:\\|knowledgeImportPath/u);

    const injected = await handler(
      fixture,
      "folioloom:knowledge-import-stage",
    )(fixture.trustedEvent, {
      pendingImportId: "a22f46e4-539b-45e1-84a7-9c58a69eb92d",
      operationId: "65e535fb-69e7-40af-b531-c5840741ee81",
      expectedGeneration: 0,
      expectedSnapshotId:
        "0000000000000000000000000000000000000000000000000000000000000000",
      selection: {
        sheetId: "sheet-1",
        headerRow: 1,
        objectType: "term",
        scope: "book",
      },
      fields: {},
      path: "C:\\outside\\secrets.xlsx",
    }) as DesktopResult<unknown>;
    assert.equal(injected.ok, false);
    if (!injected.ok) assert.equal(injected.error.code, "DESKTOP_INPUT_INVALID");
    assert.equal(fixture.knowledgeImportCalls.staged.length, 0);

    const valid = await handler(
      fixture,
      "folioloom:knowledge-import-stage",
    )(fixture.trustedEvent, {
      pendingImportId: "a22f46e4-539b-45e1-84a7-9c58a69eb92d",
      operationId: "65e535fb-69e7-40af-b531-c5840741ee81",
      expectedGeneration: 0,
      expectedSnapshotId:
        "0000000000000000000000000000000000000000000000000000000000000000",
      selection: {
        recordPathId: "$.records",
        objectType: "term",
        scope: "book",
      },
      fields: {
        source: {
          targetField: "source",
          sourceColumn: "source",
          confidence: "high",
          confirmed: true,
        },
        sourceForms: {
          targetField: "sourceForms",
          sourceColumn: "forms",
          confidence: "high",
          confirmed: true,
        },
        contexts: {
          targetField: "contexts",
          sourceColumn: "contexts",
          confidence: "high",
          confirmed: true,
        },
        register: {
          targetField: "register",
          sourceColumn: "register",
          confidence: "high",
          confirmed: true,
        },
      },
    }) as DesktopResult<unknown>;
    assert.equal(valid.ok, true);
    assert.deepEqual(
      Object.keys((fixture.knowledgeImportCalls.staged[0] as {
        fields: Record<string, unknown>;
      }).fields).sort(),
      ["contexts", "register", "source", "sourceForms"],
    );

    const wrongObjectType = await handler(
      fixture,
      "folioloom:knowledge-import-stage",
    )(fixture.trustedEvent, {
      pendingImportId: "a22f46e4-539b-45e1-84a7-9c58a69eb92d",
      operationId: "65e535fb-69e7-40af-b531-c5840741ee82",
      expectedGeneration: 0,
      expectedSnapshotId:
        "0000000000000000000000000000000000000000000000000000000000000000",
      selection: {
        recordPathId: "$.records",
        objectType: "term",
        scope: "book",
      },
      fields: {
        canonicalName: {
          targetField: "canonicalName",
          sourceColumn: "name",
          confidence: "high",
          confirmed: true,
        },
      },
    }) as DesktopResult<unknown>;
    assert.equal(wrongObjectType.ok, false);
    if (!wrongObjectType.ok) {
      assert.equal(wrongObjectType.error.code, "DESKTOP_INPUT_INVALID");
    }
    assert.equal(fixture.knowledgeImportCalls.staged.length, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("knowledge IPC accepts only narrow renderer-safe payloads", async () => {
  const fixture = registerFixtureHandlers();
  try {
    const listed = await handler(fixture, "folioloom:knowledge-list")(
      fixture.trustedEvent,
      { search: "Archon", objectTypes: ["term"], limit: 50 },
    ) as DesktopResult<DesktopKnowledgePage>;
    assert.equal(listed.ok, true);
    assert.deepEqual(fixture.knowledgeCalls.lists, [{
      search: "Archon",
      objectTypes: ["term"],
      limit: 50,
    }]);

    const injected = await handler(fixture, "folioloom:knowledge-mutate")(
      fixture.trustedEvent,
      {
        requestId: "39e28df1-cde0-4a46-89ef-af5d13777639",
        expectedGeneration: 0,
        expectedSnapshotId: "snapshot-0",
        command: {
          type: "upsert",
          objectType: "term",
          normalizedSubject: "archon",
          kind: "lexical_anchor",
          expectedRevision: null,
          expectedScopeRevision: null,
          fieldPatch: { sourceForm: "Archon", target: "阁下" },
          ownedFields: ["/target"],
          scope: "book",
          evidence: [],
          origin: "manual",
        },
        storePath: "C:\\outside\\book.db",
      },
    ) as DesktopResult<unknown>;
    assert.equal(injected.ok, false);
    if (!injected.ok) assert.equal(injected.error.code, "DESKTOP_INPUT_INVALID");
    assert.equal(fixture.knowledgeCalls.mutations.length, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("trial IPC accepts only an explicit mode, keeps the manuscript main-process-owned, and cancels through a fixed operation", async () => {
  const fixture = registerFixtureHandlers({ existingReadyModel: true });
  try {
    const started = await handler(fixture, "folioloom:start-trial")(fixture.trustedEvent, {
      mode: "quality",
    }) as DesktopResult<DesktopTrialResult>;
    assert.deepEqual(started, ok({
      runId: "trial-run-1",
      sourceText: "The bell rang.",
      translationText: "钟声响起。",
    }));
    assert.deepEqual(fixture.trialCalls.starts, [{
      manifestPath: fixture.manifestPath,
      mode: "quality",
    }]);

    const cancelled = await handler(fixture, "folioloom:cancel-trial")(fixture.trustedEvent) as DesktopResult<void>;
    assert.deepEqual(cancelled, ok(undefined));
    assert.equal(fixture.trialCalls.cancellations, 1);

    const arbitraryMode = await handler(fixture, "folioloom:start-trial")(fixture.trustedEvent, {
      mode: "cheap",
    }) as DesktopResult<unknown>;
    assert.equal(arbitraryMode.ok, false);

    const injected = await handler(fixture, "folioloom:start-trial")(fixture.trustedEvent, {
      mode: "fast",
      manifestPath: "C:\\outside\\source_manifest.json",
    }) as DesktopResult<unknown>;
    assert.equal(injected.ok, false);
    assert.deepEqual(fixture.trialCalls.starts, [{
      manifestPath: fixture.manifestPath,
      mode: "quality",
    }]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("full-book IPC owns project paths and validates start, pause, and existing-run resume", async () => {
  const fixture = registerFixtureHandlers({ activeRunIds: ["run-a"] });
  try {
    const state = await handler(fixture, "folioloom:fullbook-state")(
      fixture.trustedEvent,
    ) as DesktopResult<DesktopFullBookSnapshot>;
    assert.equal(state.ok, true);

    const started = await handler(fixture, "folioloom:start-fullbook")(
      fixture.trustedEvent,
      { optimizationProfile: "balanced" },
    ) as DesktopResult<DesktopFullBookSnapshot>;
    assert.equal(started.ok, true);
    assert.deepEqual(fixture.fullBookCalls.starts, [{
      project: { manifestPath: fixture.manifestPath },
      request: { optimizationProfile: "balanced" },
    }]);

    const resumed = await handler(fixture, "folioloom:resume-fullbook")(
      fixture.trustedEvent,
      { runId: "run-a" },
    ) as DesktopResult<DesktopFullBookSnapshot>;
    assert.equal(resumed.ok, true);
    assert.deepEqual(fixture.fullBookCalls.resumes, [{
      project: { manifestPath: fixture.manifestPath },
      request: { runId: "run-a" },
    }]);

    const missing = await handler(fixture, "folioloom:resume-fullbook")(
      fixture.trustedEvent,
      { runId: "run-missing" },
    ) as DesktopResult<unknown>;
    assert.equal(missing.ok, false);
    assert.equal(fixture.fullBookCalls.resumes.length, 1);

    const paused = await handler(fixture, "folioloom:pause-fullbook")(
      fixture.trustedEvent,
    ) as DesktopResult<DesktopFullBookSnapshot>;
    assert.equal(paused.ok, true);
    assert.equal(fixture.fullBookCalls.pauses, 1);

    for (const [channel, payload] of [
      ["folioloom:start-fullbook", {
        optimizationProfile: "speed",
        manifestPath: "C:\\outside\\source_manifest.json",
      }],
      ["folioloom:resume-fullbook", { runId: "run-a", storePath: "C:\\outside\\book.db" }],
    ] as const) {
      const result = await handler(fixture, channel)(
        fixture.trustedEvent,
        payload,
      ) as DesktopResult<unknown>;
      assert.equal(result.ok, false);
    }
    const extraPause = await handler(fixture, "folioloom:pause-fullbook")(
      fixture.trustedEvent,
      {},
    ) as DesktopResult<unknown>;
    assert.equal(extraPause.ok, false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("active full-book translation prevents replacing the manuscript before opening a dialog", async () => {
  const fixture = registerFixtureHandlers({
    pickedSource: "source",
    fullBookActive: true,
  });
  try {
    const result = await handler(fixture, "folioloom:choose-source")(
      fixture.trustedEvent,
    ) as DesktopResult<unknown>;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DESKTOP_FULLBOOK_ACTIVE");
    assert.equal(fixture.sourceImports.length, 0);
    assert.equal(fixture.dialogProperties.length, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("export IPC preserves directory grants, validates formats, and opens only completed exports", async () => {
  const fixture = registerFixtureHandlers({
    activeRunIds: ["run-a"],
    pickedExportDirectory: "cancel-after-selected",
  });
  try {
    const state = await handler(fixture, "folioloom:export-state")(
      fixture.trustedEvent,
    ) as DesktopResult<unknown>;
    assert.equal(state.ok, true);

    const chosen = await handler(fixture, "folioloom:choose-export-directory")(
      fixture.trustedEvent,
    ) as DesktopResult<{ destinationId: string; displayPath: string }>;
    assert.equal(chosen.ok, true);
    const canceled = await handler(fixture, "folioloom:choose-export-directory")(
      fixture.trustedEvent,
    ) as DesktopResult<{ destinationId: string; displayPath: string }>;
    assert.deepEqual(canceled, chosen);
    assert.deepEqual(fixture.dialogProperties.slice(-2), [
      ["openDirectory", "createDirectory"],
      ["openDirectory", "createDirectory"],
    ]);

    if (!chosen.ok) throw new Error("destination should be selected");
    const request: DesktopExportRequest = {
      runId: "run-a",
      destinationId: chosen.value.destinationId,
      formats: ["translation_txt", "epub"],
    };
    const exported = await handler(fixture, "folioloom:export-book")(
      fixture.trustedEvent,
      request,
    ) as DesktopResult<{ exportId: string }>;
    assert.equal(exported.ok, true);
    assert.deepEqual(fixture.exportCalls.exports, [{
      project: { manifestPath: fixture.manifestPath },
      request,
    }]);

    for (const payload of [
      { ...request, formats: ["translation_txt", "translation_txt"] },
      { ...request, formats: ["pdf"] },
      { ...request, outputPath: "C:\\outside", formats: ["translation_txt"] },
    ]) {
      const invalid = await handler(fixture, "folioloom:export-book")(
        fixture.trustedEvent,
        payload,
      ) as DesktopResult<unknown>;
      assert.equal(invalid.ok, false);
    }
    assert.equal(fixture.exportCalls.exports.length, 1);

    const opened = await handler(fixture, "folioloom:open-export-directory")(
      fixture.trustedEvent,
      "export-1",
    ) as DesktopResult<void>;
    assert.deepEqual(opened, ok(undefined));
    assert.equal(fixture.exportCalls.opened.length, 1);
    const unknown = await handler(fixture, "folioloom:open-export-directory")(
      fixture.trustedEvent,
      "export-missing",
    ) as DesktopResult<unknown>;
    assert.equal(unknown.ok, false);
    const extra = await handler(fixture, "folioloom:open-export-directory")(
      fixture.trustedEvent,
      "export-1",
      "C:\\outside",
    ) as DesktopResult<unknown>;
    assert.equal(extra.ok, false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("choose-source accepts only manuscript formats and cancellation preserves the active project", async () => {
  const fixture = registerFixtureHandlers({ pickedSource: "cancel" });
  try {
    const before = fixture.currentRequest;
    const result = await handler(fixture, "folioloom:choose-source")(fixture.trustedEvent) as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DESKTOP_SELECTION_CANCELLED");
    }
    assert.deepEqual(fixture.dialogFilters, [{
      name: "书稿",
      extensions: ["txt", "md", "markdown", "epub", "docx"],
    }]);
    assert.equal(fixture.sourceImports.length, 0);
    assert.deepEqual(fixture.currentRequest, before);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("choose-source imports a selected manuscript without exposing a path-taking renderer API", async () => {
  const fixture = registerFixtureHandlers({ pickedSource: "source" });
  try {
    const result = await handler(fixture, "folioloom:choose-source")(fixture.trustedEvent) as DesktopResult<DesktopChooseSourceResult>;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.status, "ready");
    assert.deepEqual(fixture.sourceImports, [fixture.sourcePath]);
    assert.equal(
      fixture.currentRequest?.manifestPath,
      join(fixture.directory, "Imported", "source_manifest.json"),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("choose-source forwards only a supported explicit source-language override", async () => {
  const fixture = registerFixtureHandlers({ pickedSource: "source" });
  try {
    const result = await handler(fixture, "folioloom:choose-source")(
      fixture.trustedEvent,
      { sourceLanguage: "de" },
    ) as DesktopResult<DesktopChooseSourceResult>;
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.sourceRequests, [{
      sourcePath: fixture.sourcePath,
      sourceLanguage: "de",
    }]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }

  const rejected = registerFixtureHandlers({ pickedSource: "source" });
  try {
    const result = await handler(rejected, "folioloom:choose-source")(
      rejected.trustedEvent,
      { sourceLanguage: "xx", sourcePath: "C:\\outside.txt" },
    ) as DesktopResult<unknown>;
    assert.equal(result.ok, false);
    assert.equal(rejected.sourceRequests.length, 0);
  } finally {
    rmSync(rejected.directory, { recursive: true, force: true });
  }
});

test("ambiguous source selection exposes an opaque encoding choice and confirms it once", async () => {
  const fixture = registerFixtureHandlers({ pickedSource: "source", sourceEncodingRequired: true });
  try {
    const before = fixture.currentRequest;
    const selected = await handler(fixture, "folioloom:choose-source")(
      fixture.trustedEvent,
    ) as DesktopResult<DesktopChooseSourceResult>;
    assert.equal(selected.ok, true);
    if (!selected.ok) throw new Error("expected a successful source choice");
    assert.equal(selected.value.status, "encoding_required");
    if (selected.value.status !== "encoding_required") {
      throw new Error("expected an encoding choice");
    }
    assert.deepEqual(selected.value.encodings, ["euc-kr", "windows-949"]);
    assert.equal(selected.value.fileName, "chapter.epub");
    assert.doesNotMatch(JSON.stringify(selected.value), /[A-Z]:\\|sourcePath|manifestPath/u);
    assert.deepEqual(fixture.currentRequest, before);

    const confirmed = await handler(fixture, "folioloom:confirm-source-encoding")(
      fixture.trustedEvent,
      {
        pendingImportId: selected.value.pendingImportId,
        encoding: "euc-kr",
      },
    ) as DesktopResult<DesktopChooseSourceResult>;
    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal(confirmed.value.status, "ready");
    assert.deepEqual(fixture.encodingConfirmations, [{
      pendingImportId: selected.value.pendingImportId,
      encoding: "euc-kr",
    }]);
    assert.equal(
      fixture.currentRequest?.manifestPath,
      join(fixture.directory, "Imported", "source_manifest.json"),
    );

    const injected = await handler(fixture, "folioloom:confirm-source-encoding")(
      fixture.trustedEvent,
      {
        pendingImportId: selected.value.pendingImportId,
        encoding: "euc-kr",
        sourcePath: "C:\\outside.txt",
      },
    ) as DesktopResult<unknown>;
    assert.equal(injected.ok, false);
    assert.equal(fixture.encodingConfirmations.length, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("choose-source refuses an unexpected dialog result before importing", async () => {
  const fixture = registerFixtureHandlers({ pickedSource: "invalid" });
  try {
    const result = await handler(fixture, "folioloom:choose-source")(fixture.trustedEvent) as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DESKTOP_INPUT_INVALID");
    }
    assert.equal(fixture.sourceImports.length, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("onboarding IPC projects source/model readiness and never returns the submitted API Key", async () => {
  const fixture = registerFixtureHandlers();
  const apiKey = "desktop-ipc-secret";
  try {
    const testResult = await handler(fixture, "folioloom:test-model")(fixture.trustedEvent, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
      apiKey,
    }) as DesktopResult<unknown>;
    assert.equal(testResult.ok, true);
    assert.doesNotMatch(JSON.stringify(testResult), new RegExp(apiKey));
    assert.equal(fixture.modelCalls.tests.length, 1);

    const onboarding = await handler(fixture, "folioloom:onboarding-state")(fixture.trustedEvent) as DesktopResult<{
      readiness: { source: boolean; model: boolean; trial: boolean };
      activeModel?: { providerId: string; modelId: string; capability: string };
      providers: readonly { id: string; [key: string]: unknown }[];
    }>;
    assert.equal(onboarding.ok, true);
    if (!onboarding.ok) {
      throw new Error("onboarding state should succeed");
    }
    assert.deepEqual(onboarding.value.readiness, { source: true, model: true, trial: true });
    assert.deepEqual(onboarding.value.activeModel, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
      capability: "ready",
    });
    assert.equal(onboarding.value.providers[0]?.id, "deepseek");
    assert.doesNotMatch(JSON.stringify(onboarding.value), /apiKey|desktop-ipc-secret|https:\/\//u);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("onboarding keeps a previously saved ready model usable after another model test fails", async () => {
  const fixture = registerFixtureHandlers({ existingReadyModel: true, testStatus: "failed" });
  try {
    const result = await handler(fixture, "folioloom:test-model")(fixture.trustedEvent, {
      providerId: "deepseek",
      modelId: "unverified-model",
      apiKey: "failed-model-secret",
    }) as DesktopResult<{
      report: { status: string };
      onboarding: {
        readiness: { source: boolean; model: boolean; trial: boolean };
        activeModel?: { modelId: string; capability: string };
        latestProbe?: { status: string };
      };
    }>;
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("model result should be projected");
    }
    assert.equal(result.value.report.status, "failed");
    assert.equal(result.value.onboarding.latestProbe?.status, "failed");
    assert.equal(result.value.onboarding.activeModel?.modelId, "saved-ready-model");
    assert.equal(result.value.onboarding.activeModel?.capability, "ready");
    assert.deepEqual(result.value.onboarding.readiness, { source: true, model: true, trial: true });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("model IPC validates exact payloads before reaching services", async () => {
  const fixture = registerFixtureHandlers();
  try {
    const malformedTest = await handler(fixture, "folioloom:test-model")(fixture.trustedEvent, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      apiKey: 42,
    }) as DesktopResult<unknown>;
    const malformedDiscovery = await handler(fixture, "folioloom:discover-models")(fixture.trustedEvent, {
      providerId: "deepseek",
      sourcePath: "C:\\outside.txt",
    }) as DesktopResult<unknown>;
    const malformedForget = await handler(fixture, "folioloom:forget-credential")(fixture.trustedEvent, { providerId: "deepseek" }) as DesktopResult<unknown>;

    assert.equal(malformedTest.ok, false);
    assert.equal(malformedDiscovery.ok, false);
    assert.equal(malformedForget.ok, false);
    assert.equal(fixture.modelCalls.tests.length, 0);
    assert.equal(fixture.modelCalls.discoveries.length, 0);
    assert.equal(fixture.modelCalls.forgotten.length, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("discover-models and forget-credential use fixed operations only", async () => {
  const fixture = registerFixtureHandlers();
  try {
    const discovered = await handler(fixture, "folioloom:discover-models")(fixture.trustedEvent, {
      providerId: "deepseek",
      apiKey: "discovery-only-secret",
    }) as DesktopResult<unknown>;
    const forgotten = await handler(fixture, "folioloom:forget-credential")(fixture.trustedEvent, "deepseek") as DesktopResult<unknown>;
    assert.equal(discovered.ok, true);
    assert.doesNotMatch(JSON.stringify(discovered), /discovery-only-secret/);
    assert.equal(forgotten.ok, true);
    assert.equal(fixture.modelCalls.discoveries.length, 1);
    assert.deepEqual(fixture.modelCalls.forgotten, ["deepseek"]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("select-run accepts only a run id from the active snapshot", async () => {
  const fixture = registerFixtureHandlers({ activeRunIds: ["run-a"] });
  try {
    await handler(fixture, "folioloom:refresh-project")(fixture.trustedEvent);
    const selected = await handler(fixture, "folioloom:select-run")(fixture.trustedEvent, "run-a") as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(selected.ok, true);

    const rejected = await handler(fixture, "folioloom:select-run")(fixture.trustedEvent, "..\\outside") as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(rejected.ok, false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("choose-store rejects a directory and a non-db selection", async () => {
  const directoryFixture = registerFixtureHandlers({ pickedStore: "directory" });
  try {
    const directoryResult = await handler(directoryFixture, "folioloom:choose-store")(directoryFixture.trustedEvent) as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(directoryResult.ok, false);
  } finally {
    rmSync(directoryFixture.directory, { recursive: true, force: true });
  }

  const textFixture = registerFixtureHandlers({ pickedStore: "text" });
  try {
    const textResult = await handler(textFixture, "folioloom:choose-store")(textFixture.trustedEvent) as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(textResult.ok, false);
  } finally {
    rmSync(textFixture.directory, { recursive: true, force: true });
  }
});

test("IPC rejects a foreign renderer event before it reads project state", async () => {
  const fixture = registerFixtureHandlers();
  try {
    const result = await handler(fixture, "folioloom:refresh-project")({
      sender: { id: 999 },
      senderFrame: { url: "https://attacker.example/", parent: null },
    }) as DesktopResult<DesktopProjectSnapshot>;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DESKTOP_UNTRUSTED_IPC");
    }
    assert.equal(fixture.snapshotCalls, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
