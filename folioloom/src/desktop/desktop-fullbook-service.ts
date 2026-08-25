import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  LOSSLESS_BOOK_PROTOCOL_VERSION,
  runBook,
  type LosslessBookRunOptions,
  type LosslessBookRunResult,
} from "../fullbook/book-runner.js";
import { profileFromLegacyRunMode } from "../fullbook/optimization-policy.js";
import {
  createStoreRecoveryIncident,
  loadAttemptedRecoveryStrategies,
  RecoveryEngine,
  StoreRecoveryKernel,
} from "../recovery/recovery-engine.js";
import { SourceLedger } from "../source/source-ledger.js";
import {
  LosslessBookStore,
  type LosslessBookStatusSummary,
  type StoredTranslationRun,
} from "../storage/lossless-book-store.js";
import type { RuntimeProfileStore } from "../storage/runtime-profile-store.js";
import type {
  DesktopError,
  DesktopAttentionSummary,
  DesktopFullBookPhase,
  DesktopFullBookProgress,
  DesktopFullBookRunSnapshot,
  DesktopFullBookSnapshot,
  DesktopOptimizationProfile,
  DesktopProjectRequest,
  DesktopResumeFullBookRequest,
  DesktopStartFullBookRequest,
  DesktopTrialMode,
} from "./contracts.js";
import { projectAttentionItems } from "./desktop-attention.js";
import { toDesktopError } from "./desktop-errors.js";
import {
  buildDesktopRuntimePlan,
  DesktopRuntimePlanError,
  serializeDesktopRuntimeFingerprint,
  type DesktopRuntimeFingerprint,
  type DesktopRuntimePlan,
  type DesktopRuntimeResolver,
} from "./desktop-runtime-plan.js";

const FULLBOOK_SCHEMA = "folioloom-desktop-fullbook-1";
const DEFAULT_STYLE_PROFILE_HASH = "desktop-default-style-1";
const DEFAULT_POLL_INTERVAL_MS = 750;

export type DesktopFullBookErrorCode =
  | "DESKTOP_FULLBOOK_ALREADY_RUNNING"
  | "DESKTOP_FULLBOOK_ATTENTION_RECOVERY_UNAVAILABLE"
  | "DESKTOP_FULLBOOK_INPUT_INVALID"
  | "DESKTOP_FULLBOOK_MODEL_NOT_READY"
  | "DESKTOP_FULLBOOK_PAUSED"
  | "DESKTOP_FULLBOOK_RUN_NOT_FOUND"
  | "DESKTOP_FULLBOOK_RUNTIME_MISMATCH"
  | "DESKTOP_FULLBOOK_SOURCE_CHANGED";

export class DesktopFullBookError extends Error {
  constructor(readonly code: DesktopFullBookErrorCode, message: string) {
    super(message);
    this.name = "DesktopFullBookError";
  }
}

export interface DesktopFullBookServiceOptions {
  runtime: DesktopRuntimeResolver;
  runtimeProfileStore?: RuntimeProfileStore;
  runBook?: (options: LosslessBookRunOptions) => Promise<LosslessBookRunResult>;
  createRunId?: () => string;
  onProgress?: (progress: DesktopFullBookProgress) => void;
  pollIntervalMs?: number;
  shutdownGraceMs?: number;
}

interface NormalizedProject {
  request: DesktopProjectRequest;
  manifestPath: string;
  projectDirectory: string;
  storePath: string;
  sourceVersion: string;
}

interface FullBookMetadata {
  schema: typeof FULLBOOK_SCHEMA;
  mode: DesktopTrialMode;
  optimizationProfile: DesktopOptimizationProfile;
  dynamicScheduler: boolean;
  runtimeFingerprint: string;
  styleProfileHash: string;
}

interface RunOverlay {
  projectKey: string;
  runId: string;
  sourceVersion: string;
  modelId: string;
  mode: DesktopTrialMode;
  optimizationProfile: DesktopOptimizationProfile;
  phase: DesktopFullBookPhase;
  progress: DesktopFullBookRunSnapshot["progress"];
  scheduler?: DesktopFullBookRunSnapshot["scheduler"];
  error?: DesktopError;
}

interface ActiveFullBookTask {
  owner: DesktopFullBookService;
  project: NormalizedProject;
  runId: string;
  mode: DesktopTrialMode;
  optimizationProfile: DesktopOptimizationProfile;
  schedulerMode: "off" | "active";
  controller: AbortController;
  phase: "preparing" | "running" | "pausing";
  pauseRequested: boolean;
  modelId: string;
  settled: Promise<void>;
  poller?: ReturnType<typeof setInterval>;
}

let ACTIVE_FULLBOOK_TASK: ActiveFullBookTask | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function emptyProgress(): DesktopFullBookRunSnapshot["progress"] {
  return {
    totalWindows: 0,
    pendingWindows: 0,
    runningWindows: 0,
    stagedWindows: 0,
    completedWindows: 0,
    warningWindows: 0,
    humanRequiredWindows: 0,
    failedWindows: 0,
  };
}

function publicProgress(
  status: LosslessBookStatusSummary,
): DesktopFullBookRunSnapshot["progress"] {
  return {
    totalWindows: status.totalWindows,
    pendingWindows: status.pendingWindows,
    runningWindows: status.runningWindows,
    stagedWindows: status.stagedWindows,
    completedWindows: status.completedWindows,
    warningWindows: status.warningWindows,
    humanRequiredWindows: status.humanRequiredWindows,
    failedWindows: status.failedWindows,
  };
}

function validRunId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 200
    && !/[\u0000-\u001f]/u.test(value);
}

function requireOptimizationProfile(
  value: unknown,
): DesktopOptimizationProfile {
  if (value !== "economy" && value !== "balanced" && value !== "speed") {
    throw new DesktopFullBookError(
      "DESKTOP_FULLBOOK_INPUT_INVALID",
      "optimizationProfile must be economy, balanced, or speed",
    );
  }
  return value;
}

function modeForOptimizationProfile(
  profile: DesktopOptimizationProfile,
): DesktopTrialMode {
  return profile === "speed" ? "fast" : "quality";
}

function normalizeProject(project: DesktopProjectRequest): NormalizedProject {
  if (typeof project?.manifestPath !== "string"
    || !isAbsolute(project.manifestPath)) {
    throw new DesktopFullBookError(
      "DESKTOP_FULLBOOK_INPUT_INVALID",
      "full-book translation requires an absolute source manifest path",
    );
  }
  const manifestPath = resolve(project.manifestPath);
  if (basename(manifestPath) !== "source_manifest.json") {
    throw new DesktopFullBookError(
      "DESKTOP_FULLBOOK_INPUT_INVALID",
      "full-book translation requires source_manifest.json",
    );
  }
  const ledger = SourceLedger.open(manifestPath);
  let storePath: string;
  if (project.storePath === undefined) {
    storePath = join(dirname(manifestPath), "artifacts", "folioloom", "book.db");
  } else {
    if (!isAbsolute(project.storePath) || extname(project.storePath) !== ".db") {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_INPUT_INVALID",
        "full-book store must be an absolute .db path",
      );
    }
    storePath = resolve(project.storePath);
  }
  return {
    request: { ...project, manifestPath, storePath },
    manifestPath,
    projectDirectory: resolve(dirname(manifestPath)),
    storePath,
    sourceVersion: ledger.sourceVersion,
  };
}

function fullBookMetadata(value: unknown): FullBookMetadata | undefined {
  const root = record(value);
  const item = record(root?.desktopFullBook);
  const optimizationProfile = item?.optimizationProfile === undefined
    ? item?.mode === "quality" || item?.mode === "fast"
      ? profileFromLegacyRunMode(item.mode)
      : undefined
    : item.optimizationProfile;
  if (item?.schema !== FULLBOOK_SCHEMA
    || (item.mode !== "quality" && item.mode !== "fast")
    || (optimizationProfile !== "economy"
      && optimizationProfile !== "balanced"
      && optimizationProfile !== "speed")
    || typeof item.runtimeFingerprint !== "string"
    || item.runtimeFingerprint.length === 0
    || typeof item.styleProfileHash !== "string"
    || item.styleProfileHash.length === 0) {
    return undefined;
  }
  if (modeForOptimizationProfile(optimizationProfile) !== item.mode) {
    return undefined;
  }
  return {
    schema: FULLBOOK_SCHEMA,
    mode: item.mode,
    optimizationProfile,
    dynamicScheduler: item.optimizationProfile !== undefined,
    runtimeFingerprint: item.runtimeFingerprint,
    styleProfileHash: item.styleProfileHash,
  };
}

function runMetadata(
  mode: DesktopTrialMode,
  optimizationProfile: DesktopOptimizationProfile,
  fingerprint: DesktopRuntimeFingerprint,
): { desktopFullBook: Omit<FullBookMetadata, "dynamicScheduler"> } {
  return {
    desktopFullBook: {
      schema: FULLBOOK_SCHEMA,
      mode,
      optimizationProfile,
      runtimeFingerprint: serializeDesktopRuntimeFingerprint(fingerprint),
      styleProfileHash: DEFAULT_STYLE_PROFILE_HASH,
    },
  };
}

function deviationPercent(actual: number, predicted: number): number | undefined {
  if (!Number.isFinite(actual)
    || !Number.isFinite(predicted)
    || actual < 0
    || predicted <= 0) {
    return undefined;
  }
  return Math.round(((actual - predicted) / predicted) * 10_000) / 100;
}

function schedulerSummary(
  scheduler: LosslessBookRunResult["scheduler"],
  status: LosslessBookStatusSummary,
): NonNullable<DesktopFullBookRunSnapshot["scheduler"]> {
  const wallTimeDeviationPercent = deviationPercent(
    scheduler.actualWallTimeMs,
    scheduler.predictedWallTimeMs,
  );
  const tokenDeviationPercent = deviationPercent(
    scheduler.actualTokens,
    scheduler.predictedTokens,
  );
  return {
    estimatedRemainingMs: status.pendingWindows === 0
      && status.runningWindows === 0
      && status.stagedWindows === 0
      ? 0
      : Math.max(
        0,
        Math.round(
          scheduler.predictedWallTimeMs - scheduler.actualWallTimeMs,
        ),
      ),
    predictedTokenRange: {
      lower: scheduler.predictedTokens,
      upper: scheduler.predictedTokens,
    },
    ...(wallTimeDeviationPercent === undefined
      ? {}
      : { wallTimeDeviationPercent }),
    ...(tokenDeviationPercent === undefined
      ? {}
      : { tokenDeviationPercent }),
    adjustment: scheduler.fallbacks > 0 ? "recovering" : "steady",
  };
}

function persistedPhase(
  progress: DesktopFullBookRunSnapshot["progress"],
): DesktopFullBookPhase {
  if (progress.humanRequiredWindows > 0 || progress.failedWindows > 0) {
    return "needs_attention";
  }
  if (progress.totalWindows > 0
    && progress.completedWindows === progress.totalWindows
    && progress.pendingWindows === 0
    && progress.runningWindows === 0
    && progress.stagedWindows === 0) {
    return "completed";
  }
  return "paused";
}

function capabilities(
  phase: DesktopFullBookPhase,
  progress: DesktopFullBookRunSnapshot["progress"],
  attentionRetryAvailable = false,
): Pick<DesktopFullBookRunSnapshot, "canPause" | "canResume" | "canExport"> {
  const complete = progress.totalWindows > 0
    && progress.completedWindows === progress.totalWindows
    && progress.pendingWindows === 0
    && progress.runningWindows === 0
    && progress.stagedWindows === 0
    && progress.humanRequiredWindows === 0
    && progress.failedWindows === 0;
  return {
    canPause: phase === "preparing" || phase === "running",
    canResume: phase === "paused"
      || phase === "failed"
      || (phase === "needs_attention" && attentionRetryAvailable),
    canExport: phase === "completed" && complete,
  };
}

function publicRun(
  run: StoredTranslationRun,
  metadata: FullBookMetadata,
  progress: DesktopFullBookRunSnapshot["progress"],
  attention: DesktopAttentionSummary | undefined,
  overlay?: RunOverlay,
): DesktopFullBookRunSnapshot {
  const phase = overlay?.phase ?? persistedPhase(progress);
  return {
    runId: run.runId,
    sourceVersion: run.sourceVersion,
    modelId: run.modelId,
    mode: metadata.mode,
    optimizationProfile: metadata.optimizationProfile,
    phase,
    progress: overlay?.progress ?? progress,
    ...(overlay?.scheduler === undefined
      ? {}
      : { scheduler: overlay.scheduler }),
    ...capabilities(phase, overlay?.progress ?? progress, attention?.retryAvailable),
    ...(attention === undefined ? {} : { attention }),
    ...(overlay?.error === undefined ? {} : { error: overlay.error }),
  };
}

function overlayRun(overlay: RunOverlay): DesktopFullBookRunSnapshot {
  return {
    runId: overlay.runId,
    sourceVersion: overlay.sourceVersion,
    modelId: overlay.modelId,
    mode: overlay.mode,
    optimizationProfile: overlay.optimizationProfile,
    phase: overlay.phase,
    progress: overlay.progress,
    ...(overlay.scheduler === undefined ? {} : { scheduler: overlay.scheduler }),
    ...capabilities(overlay.phase, overlay.progress),
    ...(overlay.error === undefined ? {} : { error: overlay.error }),
  };
}

function runtimePlan(
  mode: DesktopTrialMode,
  runtime: Awaited<ReturnType<DesktopRuntimeResolver["resolve"]>>,
): DesktopRuntimePlan {
  if (runtime === undefined) {
    throw new DesktopFullBookError(
      "DESKTOP_FULLBOOK_MODEL_NOT_READY",
      "a successfully tested model is required before starting a full-book translation",
    );
  }
  try {
    return buildDesktopRuntimePlan(mode, runtime);
  } catch (error) {
    if (error instanceof DesktopRuntimePlanError) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_RUNTIME_MISMATCH",
        error.message,
      );
    }
    throw error;
  }
}

export class DesktopFullBookService {
  readonly #runtime: DesktopRuntimeResolver;
  readonly #runtimeProfileStore: RuntimeProfileStore | undefined;
  readonly #runBook: (options: LosslessBookRunOptions) => Promise<LosslessBookRunResult>;
  readonly #createRunId: () => string;
  readonly #onProgress: ((progress: DesktopFullBookProgress) => void) | undefined;
  readonly #pollIntervalMs: number;
  readonly #shutdownGraceMs: number;
  readonly #overlays = new Map<string, RunOverlay>();
  #lastProject: NormalizedProject | undefined;

  constructor(options: DesktopFullBookServiceOptions) {
    this.#runtime = options.runtime;
    this.#runtimeProfileStore = options.runtimeProfileStore;
    this.#runBook = options.runBook ?? runBook;
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#onProgress = options.onProgress;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_INPUT_INVALID",
        "pollIntervalMs must be a positive safe integer",
      );
    }
    if (!Number.isSafeInteger(this.#shutdownGraceMs)
      || this.#shutdownGraceMs <= 0) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_INPUT_INVALID",
        "shutdownGraceMs must be a positive safe integer",
      );
    }
  }

  snapshot(projectRequest: DesktopProjectRequest): DesktopFullBookSnapshot {
    const project = normalizeProject(projectRequest);
    this.#lastProject = project;
    const persisted: DesktopFullBookRunSnapshot[] = [];
    const seen = new Set<string>();
    if (existsSync(project.storePath)) {
      const store = LosslessBookStore.openReadOnly(project.storePath);
      try {
        for (const run of store.listTranslationRuns()) {
          if (run.sourceVersion !== project.sourceVersion) continue;
          const metadata = fullBookMetadata(run.metadata);
          if (metadata === undefined) continue;
          const progress = publicProgress(store.statusSummary(run.runId));
          const allAttentionItems = projectAttentionItems(store.allWindows(run.runId));
          const retryAttempted = allAttentionItems.length > 0
            && loadAttemptedRecoveryStrategies(
              project.storePath,
              run.runId,
              "EXPORT_INCOMPLETE",
            ).length > 0;
          const attention: DesktopAttentionSummary | undefined = allAttentionItems.length === 0
            ? undefined
            : {
                items: allAttentionItems.slice(0, 100),
                totalItems: allAttentionItems.length,
                truncated: allAttentionItems.length > 100,
                retryAvailable: !retryAttempted
                  && progress.failedWindows === 0
                  && allAttentionItems.some((item) => item.retryable),
                retryAttempted,
              };
          const overlay = this.#overlays.get(run.runId);
          persisted.push(publicRun(run, metadata, progress, attention, overlay));
          seen.add(run.runId);
        }
      } finally {
        store.close();
      }
    }
    for (const overlay of this.#overlays.values()) {
      if (overlay.projectKey === project.projectDirectory && !seen.has(overlay.runId)) {
        persisted.push(overlayRun(overlay));
      }
    }
    const active = ACTIVE_FULLBOOK_TASK;
    return {
      ...(active?.project.projectDirectory === project.projectDirectory
        ? { activeRunId: active.runId }
        : {}),
      runs: persisted,
    };
  }

  async start(
    projectRequest: DesktopProjectRequest,
    request: DesktopStartFullBookRequest,
  ): Promise<DesktopFullBookSnapshot> {
    const optimizationProfile = requireOptimizationProfile(
      request?.optimizationProfile,
    );
    const mode = modeForOptimizationProfile(optimizationProfile);
    const project = normalizeProject(projectRequest);
    const runId = this.#createRunId();
    if (!validRunId(runId)) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_INPUT_INVALID",
        "the generated full-book run id is invalid",
      );
    }
    const task = this.#reserve(
      project,
      runId,
      mode,
      optimizationProfile,
      "active",
    );
    try {
      const beforeVersion = project.sourceVersion;
      const plan = runtimePlan(mode, await this.#runtime.resolve());
      task.controller.signal.throwIfAborted();
      const afterVersion = SourceLedger.open(project.manifestPath).sourceVersion;
      if (afterVersion !== beforeVersion) {
        throw new DesktopFullBookError(
          "DESKTOP_FULLBOOK_SOURCE_CHANGED",
          "the manuscript changed while the translation runtime was being prepared",
        );
      }
      task.modelId = plan.runtimeSet.primary.model.id;
      const metadata = runMetadata(
        mode,
        optimizationProfile,
        plan.fingerprint,
      );
      return this.#launch(task, plan, {
        runId,
        protocolVersion: LOSSLESS_BOOK_PROTOCOL_VERSION,
        modelId: task.modelId,
        metadata,
      });
    } catch (error) {
      this.#releasePreparation(task);
      throw error;
    }
  }

  async resume(
    projectRequest: DesktopProjectRequest,
    request: DesktopResumeFullBookRequest,
  ): Promise<DesktopFullBookSnapshot> {
    if (!validRunId(request?.runId)) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_INPUT_INVALID",
        "runId must identify a full-book translation",
      );
    }
    const project = normalizeProject(projectRequest);
    if (!existsSync(project.storePath)) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_RUN_NOT_FOUND",
        "the full-book translation state database does not exist",
      );
    }
    const store = LosslessBookStore.openReadOnly(project.storePath);
    let storedRun: StoredTranslationRun | undefined;
    let metadata: FullBookMetadata | undefined;
    let requiresAttentionRecovery = false;
    try {
      storedRun = store.listTranslationRuns().find((candidate) =>
        candidate.runId === request.runId
        && candidate.sourceVersion === project.sourceVersion);
      metadata = fullBookMetadata(storedRun?.metadata);
      if (storedRun !== undefined && metadata !== undefined) {
        const status = store.statusSummary(storedRun.runId);
        if (status.failedWindows > 0) {
          throw new DesktopFullBookError(
            "DESKTOP_FULLBOOK_ATTENTION_RECOVERY_UNAVAILABLE",
            "failed windows require diagnostics before the run can resume",
          );
        }
        requiresAttentionRecovery = status.humanRequiredWindows > 0;
      }
    } finally {
      store.close();
    }
    if (storedRun === undefined || metadata === undefined) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_RUN_NOT_FOUND",
        "the selected run is not a resumable desktop full-book translation",
      );
    }
    const task = this.#reserve(
      project,
      storedRun.runId,
      metadata.mode,
      metadata.optimizationProfile,
      metadata.dynamicScheduler ? "active" : "off",
      storedRun.modelId,
    );
    try {
      const plan = runtimePlan(metadata.mode, await this.#runtime.resolve());
      task.controller.signal.throwIfAborted();
      if (metadata.runtimeFingerprint
        !== serializeDesktopRuntimeFingerprint(plan.fingerprint)
        || storedRun.modelId !== plan.runtimeSet.primary.model.id) {
        throw new DesktopFullBookError(
          "DESKTOP_FULLBOOK_RUNTIME_MISMATCH",
          "the active model configuration does not match this full-book run",
        );
      }
      if (SourceLedger.open(project.manifestPath).sourceVersion !== project.sourceVersion) {
        throw new DesktopFullBookError(
          "DESKTOP_FULLBOOK_SOURCE_CHANGED",
          "the manuscript changed while the translation runtime was being prepared",
        );
      }
      if (requiresAttentionRecovery) {
        await this.#recoverAttentionWindows(project, storedRun.runId);
      }
      return this.#launch(task, plan, {
        runId: storedRun.runId,
        protocolVersion: storedRun.protocolVersion,
        modelId: storedRun.modelId,
        metadata: storedRun.metadata,
      });
    } catch (error) {
      this.#releasePreparation(task);
      throw error;
    }
  }

  async #recoverAttentionWindows(
    project: NormalizedProject,
    runId: string,
  ): Promise<void> {
    const attempted = loadAttemptedRecoveryStrategies(
      project.storePath,
      runId,
      "EXPORT_INCOMPLETE",
    );
    if (attempted.length > 0) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_ATTENTION_RECOVERY_UNAVAILABLE",
        "the audited automatic retry for these windows has already been used",
      );
    }
    const store = new LosslessBookStore(project.storePath);
    try {
      const incident = createStoreRecoveryIncident(
        store,
        runId,
        "EXPORT_INCOMPLETE",
      );
      const engine = new RecoveryEngine({
        kernel: new StoreRecoveryKernel(store, project.storePath),
      });
      const result = await engine.recover(incident);
      if (result.status !== "resumed" || result.strategy !== "reset_missing_windows") {
        throw new DesktopFullBookError(
          "DESKTOP_FULLBOOK_ATTENTION_RECOVERY_UNAVAILABLE",
          result.reason ?? "the audited automatic retry was not accepted",
        );
      }
    } finally {
      store.close();
    }
  }

  async pause(): Promise<DesktopFullBookSnapshot> {
    const task = ACTIVE_FULLBOOK_TASK;
    if (task === undefined) {
      return this.#lastProject === undefined
        ? { runs: [] }
        : this.snapshot(this.#lastProject.request);
    }
    const priorPhase = task.phase;
    task.phase = "pausing";
    this.#setOverlay(task, "pausing");
    this.#emit(task);
    if (priorPhase === "preparing" && !task.controller.signal.aborted) {
      task.controller.abort(new DesktopFullBookError(
        "DESKTOP_FULLBOOK_PAUSED",
        "full-book translation paused before execution",
      ));
    } else {
      task.pauseRequested = true;
    }
    await task.settled;
    return this.snapshot(task.project.request);
  }

  hasActiveTask(): boolean {
    return ACTIVE_FULLBOOK_TASK !== undefined;
  }

  async settleForShutdown(): Promise<void> {
    const task = ACTIVE_FULLBOOK_TASK;
    if (task === undefined) return;
    const cooperativePause = this.pause();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedShutdown = new Promise<void>((resolve) => {
      abortTimer = setTimeout(() => {
        if (!task.controller.signal.aborted) {
          task.controller.abort(new DesktopFullBookError(
            "DESKTOP_FULLBOOK_PAUSED",
            "full-book translation aborted after the shutdown grace period",
          ));
        }
        giveUpTimer = setTimeout(resolve, this.#shutdownGraceMs);
        giveUpTimer.unref?.();
      }, this.#shutdownGraceMs);
      abortTimer.unref?.();
    });
    try {
      await Promise.race([
        cooperativePause.then(() => undefined),
        boundedShutdown,
      ]);
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
    }
  }

  #reserve(
    project: NormalizedProject,
    runId: string,
    mode: DesktopTrialMode,
    optimizationProfile: DesktopOptimizationProfile,
    schedulerMode: "off" | "active",
    modelId = "",
  ): ActiveFullBookTask {
    if (ACTIVE_FULLBOOK_TASK !== undefined) {
      throw new DesktopFullBookError(
        "DESKTOP_FULLBOOK_ALREADY_RUNNING",
        "another full-book translation is already active",
      );
    }
    const task: ActiveFullBookTask = {
      owner: this,
      project,
      runId,
      mode,
      optimizationProfile,
      schedulerMode,
      controller: new AbortController(),
      pauseRequested: false,
      phase: "preparing",
      modelId,
      settled: Promise.resolve(),
    };
    ACTIVE_FULLBOOK_TASK = task;
    this.#lastProject = project;
    this.#setOverlay(
      task,
      "preparing",
      undefined,
      undefined,
      { adjustment: "planning" },
    );
    this.#emit(task);
    return task;
  }

  #launch(
    task: ActiveFullBookTask,
    plan: DesktopRuntimePlan,
    runMeta: LosslessBookRunOptions["runMeta"],
  ): DesktopFullBookSnapshot {
    task.phase = "running";
    this.#setOverlay(task, "running");
    this.#emit(task);
    task.poller = setInterval(() => this.#emit(task), this.#pollIntervalMs);
    task.poller.unref?.();

    let running: Promise<LosslessBookRunResult>;
    try {
      running = this.#runBook({
        manifestPath: task.project.manifestPath,
        storePath: task.project.storePath,
        runMeta,
        model: plan.runtimeSet.primary.model,
        streamFn: plan.runtimeSet.primary.streamFn,
        runtimeSet: plan.runtimeSet,
        optimizationProfile: task.optimizationProfile,
        schedulerMode: task.schedulerMode,
        ...(this.#runtimeProfileStore === undefined
          ? {}
          : { runtimeProfileStore: this.#runtimeProfileStore }),
        signal: task.controller.signal,
        shouldPause: () => task.pauseRequested,
      });
    } catch (error) {
      running = Promise.reject(error);
    }
    task.settled = running.then(
      (result) => {
        if (task.controller.signal.aborted) {
          this.#setOverlay(
            task,
            "paused",
            result.status,
            undefined,
            schedulerSummary(result.scheduler, result.status),
          );
        } else {
          const phase: DesktopFullBookPhase = result.outcome === "human_required"
            ? "needs_attention"
            : result.outcome === "partial"
              ? "paused"
              : "completed";
          this.#setOverlay(
            task,
            phase,
            result.status,
            undefined,
            schedulerSummary(result.scheduler, result.status),
          );
        }
      },
      (error: unknown) => {
        if (task.controller.signal.aborted) {
          this.#setOverlay(task, "paused");
        } else {
          this.#setOverlay(task, "failed", undefined, toDesktopError(error));
        }
      },
    ).finally(() => {
      if (task.poller !== undefined) {
        clearInterval(task.poller);
      }
      if (ACTIVE_FULLBOOK_TASK === task) {
        ACTIVE_FULLBOOK_TASK = undefined;
      }
      this.#emit(task);
    });
    return this.snapshot(task.project.request);
  }

  #releasePreparation(task: ActiveFullBookTask): void {
    if (task.poller !== undefined) {
      clearInterval(task.poller);
    }
    if (ACTIVE_FULLBOOK_TASK === task) {
      ACTIVE_FULLBOOK_TASK = undefined;
    }
    this.#overlays.delete(task.runId);
  }

  #setOverlay(
    task: ActiveFullBookTask,
    phase: DesktopFullBookPhase,
    status?: LosslessBookStatusSummary,
    error?: DesktopError,
    scheduler?: DesktopFullBookRunSnapshot["scheduler"],
  ): void {
    let progress = status === undefined ? emptyProgress() : publicProgress(status);
    let adaptiveCongestion = false;
    if (status === undefined && existsSync(task.project.storePath)) {
      try {
        const store = LosslessBookStore.openReadOnly(task.project.storePath);
        try {
          const run = store.listTranslationRuns().find((item) => item.runId === task.runId);
          if (run !== undefined) {
            progress = publicProgress(store.statusSummary(task.runId));
            adaptiveCongestion =
              (store.latestSchedulerSnapshot(task.runId)?.congestionEvents ?? 0) > 0;
          }
        } finally {
          store.close();
        }
      } catch {
        // The writer can be between atomic SQLite operations. Keep the last
        // public projection and let the next poll refresh it.
        progress = this.#overlays.get(task.runId)?.progress ?? progress;
      }
    }
    const priorScheduler = this.#overlays.get(task.runId)?.scheduler;
    const projectedScheduler = scheduler
      ?? (adaptiveCongestion
        ? {
          ...priorScheduler,
          adjustment: "throttled" as const,
        }
        : priorScheduler);
    this.#overlays.set(task.runId, {
      projectKey: task.project.projectDirectory,
      runId: task.runId,
      sourceVersion: task.project.sourceVersion,
      modelId: task.modelId,
      mode: task.mode,
      optimizationProfile: task.optimizationProfile,
      phase,
      progress,
      ...(projectedScheduler === undefined
        ? {}
        : { scheduler: projectedScheduler }),
      ...(error === undefined ? {} : { error }),
    });
  }

  #emit(task: ActiveFullBookTask): void {
    try {
      const snapshot = this.snapshot(task.project.request);
      const run = snapshot.runs.find((item) => item.runId === task.runId);
      if (run === undefined) return;
      this.#onProgress?.({
        runId: run.runId,
        phase: run.phase,
        progress: run.progress,
      });
    } catch {
      // Progress is presentation plumbing. Durable execution and pause
      // semantics must not depend on an observer or a temporary read failure.
    }
  }
}
