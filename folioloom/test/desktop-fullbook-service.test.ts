import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import {
  DesktopFullBookError,
  DesktopFullBookService,
  type DesktopFullBookServiceOptions,
} from "../src/desktop/desktop-fullbook-service.js";
import {
  buildDesktopRuntimePlan,
  serializeDesktopRuntimeFingerprint,
  type DesktopRuntimeResolver,
  type DesktopTranslationRuntime,
} from "../src/desktop/desktop-runtime-plan.js";
import type {
  DesktopFullBookPhase,
  DesktopFullBookProgress,
  DesktopProjectRequest,
} from "../src/desktop/contracts.js";
import type {
  LosslessBookRunOptions,
  LosslessBookRunResult,
} from "../src/fullbook/book-runner.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import type { ModelProfile, ProviderEffort } from "../src/providers/types.js";
import { scalarLength } from "../src/source/types.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { RuntimeProfileStore } from "../src/storage/runtime-profile-store.js";

function fixture(source = `${"A".repeat(3_500)}\n\n${"B".repeat(3_500)}`): {
  directory: string;
  projectDirectory: string;
  manifestPath: string;
  storePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-fullbook-"));
  const projectDirectory = join(directory, "project");
  const sourceDirectory = join(projectDirectory, "source");
  const rawPath = join(sourceDirectory, "original.txt");
  const canonicalPath = join(sourceDirectory, "source.txt");
  const manifestPath = join(projectDirectory, "source_manifest.json");
  const storePath = join(projectDirectory, "artifacts", "folioloom", "book.db");
  mkdirSync(sourceDirectory, { recursive: true });
  const raw = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, raw);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "source/original.txt",
    raw_size: raw.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    canonical_path: "source/source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: scalarLength(source),
      origin_kind: "decoded_bytes",
      origin_ref: "source/original.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  return { directory, projectDirectory, manifestPath, storePath };
}

const streamFn = (async () => {
  throw new Error("not used by desktop full-book service tests");
}) as StreamFn;

function runtimeResolver(
  profile: ModelProfile = {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "high",
  },
  supportedEfforts: readonly ProviderEffort[] = ["off", "high"],
): DesktopRuntimeResolver {
  const create = (candidate: ModelProfile): DesktopTranslationRuntime => ({
    profile: candidate,
    model: { id: candidate.modelId } as Model<any>,
    streamFn,
    supportedEfforts,
    createWithProfile: create,
  });
  return {
    async resolve() {
      return create(profile);
    },
  };
}

function status(
  overrides: Partial<LosslessBookRunResult["status"]> = {},
): LosslessBookRunResult["status"] {
  return {
    totalWindows: 2,
    pendingWindows: 0,
    runningWindows: 0,
    stagedWindows: 0,
    completedWindows: 2,
    warningWindows: 0,
    humanRequiredWindows: 0,
    failedWindows: 0,
    modelCalls: 2,
    ...overrides,
  };
}

function runResult(
  runId: string,
  overrides: Partial<LosslessBookRunResult> = {},
): LosslessBookRunResult {
  return {
    outcome: "completed",
    runId,
    processedWindows: 2,
    waves: [],
    status: status(),
    windows: [],
    wallTimeMs: 10,
    revalidationOverhead: {
      coverageScan: {
        occurrenceDependencies: 0,
        candidateTranslations: 0,
        tasksCreated: 0,
        bindingsCreated: 0,
        wallTimeMs: 0,
      },
      drain: {
        claimed: 0,
        noop: 0,
        repaired: 0,
        retranslated: 0,
        warning: 0,
        modelCalls: 0,
        modelDurationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        tokenUsageComplete: true,
        wallTimeMs: 0,
      },
    },
    scheduler: {
      mode: "off",
      profile: "balanced",
      planningStatus: "disabled",
      decisions: 0,
      fallbacks: 0,
      baselineWallTimeMs: 0,
      predictedWallTimeMs: 0,
      actualWallTimeMs: 0,
      baselineTokens: 0,
      allowedTokens: 0,
      predictedTokens: 0,
      actualTokens: 0,
      tokenUsageComplete: true,
      contextProfiles: {},
      effortCounts: {},
      protocolCounts: {
        typed_tool: 0,
        framed_text: 0,
        local: 0,
      },
      plannerDeadlines: 0,
      throttles: 0,
      recoveries: 0,
    },
    leaseReleased: true,
    artifacts: null,
    ...overrides,
  };
}

function flushBackground(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function storedFullBookRun(options: {
  project: ReturnType<typeof fixture>;
  runId: string;
  mode?: "quality" | "fast";
  optimizationProfile?: "economy" | "balanced" | "speed";
  completedWindows?: number;
  humanRequired?: boolean;
  failureError?: string;
  runtime?: DesktopRuntimeResolver;
}): unknown {
  const runtime = options.runtime ?? runtimeResolver();
  let resolvedRuntime: DesktopTranslationRuntime | undefined;
  const resolveRuntime = runtime.resolve().then((value) => { resolvedRuntime = value; });
  // Test runtime resolvers are deliberately synchronous async functions.
  return resolveRuntime.then(() => {
    assert.ok(resolvedRuntime);
    const plan = buildDesktopRuntimePlan(options.mode ?? "quality", resolvedRuntime);
    const context = BookContext.openLossless({ manifestPath: options.project.manifestPath });
    mkdirSync(dirname(options.project.storePath), { recursive: true });
    const store = new LosslessBookStore(options.project.storePath);
    try {
      store.registerSource(context.certifiedSource!);
      store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
        annotations: context.annotations,
        blocks: context.losslessBlocks,
      });
      const snapshot = createKnowledgeSnapshot(options.runId, []);
      const metadata = {
        desktopFullBook: {
          schema: "folioloom-desktop-fullbook-1",
          mode: options.mode ?? "quality",
          ...(options.optimizationProfile === undefined
            ? {}
            : { optimizationProfile: options.optimizationProfile }),
          runtimeFingerprint: serializeDesktopRuntimeFingerprint(plan.fingerprint),
          styleProfileHash: "desktop-default-style-1",
        },
      };
      store.createTranslationRun({
        runId: options.runId,
        sourceVersion: context.sourceLedger.sourceVersion,
        protocolVersion: "v5-book-3",
        modelId: plan.runtimeSet.primary.model.id,
        initialSnapshotId: snapshot.id,
        initialSnapshot: snapshot,
        metadata,
      });
      const windows = planBookWindows(context.losslessBlocks, {
        protocolVersion: "v5-book-3",
        maxBlocks: 1,
      });
      store.initializeWindowPlan(options.runId, windows);
      const completed = options.completedWindows ?? 0;
      for (const window of windows.slice(0, completed)) {
        store.bindWindowsToSnapshot(options.runId, [window.windowId], snapshot.id);
        store.claimWindow(options.runId, window.windowId);
        store.stageWindow({
          runId: options.runId,
          windowId: window.windowId,
          snapshotId: snapshot.id,
          status: "completed",
          translations: window.blockIds.map((blockId) => {
            const block = context.losslessBlocks.find((item) => item.id === blockId)!;
            return {
              blockId,
              sourceHash: block.sourceHash,
              text: `译文-${block.globalIndex}`,
            };
          }),
          knowledgeCandidates: [],
          styleTail: "",
          budget: {},
          warnings: [],
        });
        store.promoteStagedWindow(options.runId, window.windowId);
      }
      if (options.humanRequired) {
        const window = windows[completed];
        assert.ok(window);
        store.claimWindow(options.runId, window.windowId);
        store.failWindow(options.runId, window.windowId, {
          error: options.failureError ?? "fixture needs attention",
          retry: false,
          budget: {},
          warnings: [options.failureError ?? "fixture needs attention"],
        });
      }
      return metadata;
    } finally {
      store.close();
      context.close();
    }
  });
}

test("desktop full-book start launches in background with formal run metadata", async () => {
  const project = fixture();
  const runtimeProfileStore = new RuntimeProfileStore(
    join(project.directory, "runtime-profiles.db"),
  );
  const seen: LosslessBookRunOptions[] = [];
  let complete!: (result: LosslessBookRunResult) => void;
  const running = new Promise<LosslessBookRunResult>((resolve) => { complete = resolve; });
  const progress: DesktopFullBookProgress[] = [];
  try {
    const service = new DesktopFullBookService({
      runtime: runtimeResolver(),
      runtimeProfileStore,
      createRunId: () => "run-fullbook-start",
      runBook: async (options) => {
        seen.push(options);
        return running;
      },
      onProgress: (value) => progress.push(value),
      pollIntervalMs: 60_000,
    });

    const snapshot = await service.start(
      { manifestPath: project.manifestPath },
      { optimizationProfile: "balanced" },
    );

    assert.equal(snapshot.activeRunId, "run-fullbook-start");
    assert.equal(snapshot.runs[0]?.phase, "running");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.storePath, project.storePath);
    assert.equal(seen[0]?.maxWindows, undefined);
    assert.equal(seen[0]?.runtimeSet?.mode, "quality");
    assert.equal(seen[0]?.optimizationProfile, "balanced");
    assert.equal(seen[0]?.schedulerMode, "active");
    assert.equal(seen[0]?.runtimeProfileStore, runtimeProfileStore);
    assert.deepEqual(seen[0]?.runMeta.metadata, {
      desktopFullBook: {
        schema: "folioloom-desktop-fullbook-1",
        mode: "quality",
        optimizationProfile: "balanced",
        runtimeFingerprint: serializeDesktopRuntimeFingerprint(
          buildDesktopRuntimePlan("quality", (await runtimeResolver().resolve())!).fingerprint,
        ),
        styleProfileHash: "desktop-default-style-1",
      },
    });
    assert.ok(progress.some((item) => item.phase === "running"));

    complete(runResult("run-fullbook-start", {
      scheduler: {
        mode: "active",
        profile: "balanced",
        planningStatus: "optimal",
        decisions: 2,
        fallbacks: 0,
        baselineWallTimeMs: 2_000,
        predictedWallTimeMs: 1_000,
        actualWallTimeMs: 900,
        baselineTokens: 100,
        allowedTokens: 110,
        predictedTokens: 100,
        actualTokens: 95,
        tokenUsageComplete: true,
        contextProfiles: {},
        effortCounts: { high: 1 },
        protocolCounts: {
          typed_tool: 1,
          framed_text: 0,
          local: 0,
        },
        plannerDeadlines: 0,
        throttles: 0,
        recoveries: 0,
      },
    }));
    await flushBackground();
    assert.deepEqual(
      service.snapshot({ manifestPath: project.manifestPath }).runs[0]?.scheduler,
      {
        estimatedRemainingMs: 0,
        predictedTokenRange: { lower: 100, upper: 100 },
        wallTimeDeviationPercent: -10,
        tokenDeviationPercent: -5,
        adjustment: "steady",
      },
    );
  } finally {
    runtimeProfileStore.close();
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book enforces one active task and pauses at the runner boundary", async () => {
  const project = fixture();
  let observedSignal: AbortSignal | undefined;
  let shouldPause: (() => boolean) | undefined;
  let settle!: (result: LosslessBookRunResult) => void;
  const running = new Promise<LosslessBookRunResult>((resolve) => { settle = resolve; });
  try {
    const service = new DesktopFullBookService({
      runtime: runtimeResolver(),
      createRunId: () => "run-fullbook-pause",
      runBook: async (options) => {
        observedSignal = options.signal;
        shouldPause = options.shouldPause;
        return running;
      },
      pollIntervalMs: 60_000,
    });
    await service.start(
      { manifestPath: project.manifestPath },
      { optimizationProfile: "speed" },
    );

    await assert.rejects(
      service.start(
        { manifestPath: project.manifestPath },
        { optimizationProfile: "speed" },
      ),
      (error: unknown) => error instanceof DesktopFullBookError
        && error.code === "DESKTOP_FULLBOOK_ALREADY_RUNNING",
    );

    const pausing = service.pause();
    assert.equal(observedSignal?.aborted, false);
    assert.equal(shouldPause?.(), true);
    settle(runResult("run-fullbook-pause", {
      outcome: "partial",
      status: status({
        pendingWindows: 2,
        completedWindows: 0,
        modelCalls: 0,
      }),
    }));
    const paused = await pausing;
    assert.equal(paused.activeRunId, undefined);
    assert.equal(paused.runs[0]?.phase, "paused");
    assert.equal(service.hasActiveTask(), false);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop shutdown aborts after a bounded cooperative pause grace period", async () => {
  const project = fixture();
  let observedSignal: AbortSignal | undefined;
  let settle!: (result: LosslessBookRunResult) => void;
  const running = new Promise<LosslessBookRunResult>((resolve) => {
    settle = resolve;
  });
  try {
    const service = new DesktopFullBookService({
      runtime: runtimeResolver(),
      createRunId: () => "run-fullbook-shutdown",
      runBook: async (options) => {
        observedSignal = options.signal;
        return running;
      },
      pollIntervalMs: 60_000,
      shutdownGraceMs: 5,
    });
    await service.start(
      { manifestPath: project.manifestPath },
      { optimizationProfile: "balanced" },
    );

    await Promise.race([
      service.settleForShutdown(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("shutdown settlement was unbounded")), 500);
      }),
    ]);
    assert.equal(observedSignal?.aborted, true);

    settle(runResult("run-fullbook-shutdown", {
      outcome: "partial",
      status: status({ pendingWindows: 2, completedWindows: 0 }),
    }));
    for (let attempt = 0; attempt < 10 && service.hasActiveTask(); attempt += 1) {
      await flushBackground();
    }
    assert.equal(service.hasActiveTask(), false);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book resume reuses exact stored metadata and rejects a changed runtime", async () => {
  const project = fixture();
  const storedRuntime = runtimeResolver();
  const metadata = await storedFullBookRun({
    project,
    runId: "run-resume",
    mode: "quality",
    runtime: storedRuntime,
  });
  const seen: LosslessBookRunOptions[] = [];
  let settle!: (result: LosslessBookRunResult) => void;
  const running = new Promise<LosslessBookRunResult>((resolve) => { settle = resolve; });
  try {
    const service = new DesktopFullBookService({
      runtime: storedRuntime,
      runBook: async (options) => {
        seen.push(options);
        return running;
      },
      pollIntervalMs: 60_000,
    });
    await service.resume(
      { manifestPath: project.manifestPath },
      { runId: "run-resume" },
    );
    assert.equal(seen[0]?.runMeta.runId, "run-resume");
    assert.equal(seen[0]?.runMeta.protocolVersion, "v5-book-3");
    assert.equal(seen[0]?.runMeta.modelId, "deepseek-v4-flash");
    assert.deepEqual(seen[0]?.runMeta.metadata, metadata);
    assert.equal(seen[0]?.optimizationProfile, "balanced");
    assert.equal(seen[0]?.schedulerMode, "off");
    const pausing = service.pause();
    settle(runResult("run-resume", {
      outcome: "partial",
      status: status({ pendingWindows: 2, completedWindows: 0 }),
    }));
    await pausing;

    const changed = new DesktopFullBookService({
      runtime: runtimeResolver({
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        reasoningEffort: "max",
      }),
    });
    await assert.rejects(
      changed.resume(
        { manifestPath: project.manifestPath },
        { runId: "run-resume" },
      ),
      (error: unknown) => error instanceof DesktopFullBookError
        && error.code === "DESKTOP_FULLBOOK_RUNTIME_MISMATCH",
    );
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book rejects inconsistent persisted optimization metadata", async () => {
  const project = fixture();
  try {
    await storedFullBookRun({
      project,
      runId: "run-inconsistent-profile",
      mode: "quality",
      optimizationProfile: "speed",
    });
    const service = new DesktopFullBookService({ runtime: runtimeResolver() });

    assert.deepEqual(
      service.snapshot({ manifestPath: project.manifestPath }),
      { runs: [] },
    );
    await assert.rejects(
      service.resume(
        { manifestPath: project.manifestPath },
        { runId: "run-inconsistent-profile" },
      ),
      (error: unknown) => error instanceof DesktopFullBookError
        && error.code === "DESKTOP_FULLBOOK_RUN_NOT_FOUND",
    );
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book reconstructs paused, completed, and attention states from SQLite", async () => {
  const pausedProject = fixture();
  const completedProject = fixture();
  const attentionProject = fixture();
  try {
    await storedFullBookRun({
      project: pausedProject,
      runId: "run-paused",
      completedWindows: 0,
    });
    await storedFullBookRun({
      project: completedProject,
      runId: "run-completed",
      completedWindows: 2,
    });
    await storedFullBookRun({
      project: attentionProject,
      runId: "run-attention",
      completedWindows: 1,
      humanRequired: true,
    });
    const service = new DesktopFullBookService({ runtime: runtimeResolver() });

    const paused = service.snapshot({ manifestPath: pausedProject.manifestPath });
    assert.equal(paused.runs[0]?.phase, "paused");
    assert.equal(paused.runs[0]?.canResume, true);
    assert.equal(paused.runs[0]?.canExport, false);

    const completed = service.snapshot({ manifestPath: completedProject.manifestPath });
    assert.equal(completed.runs[0]?.phase, "completed");
    assert.equal(completed.runs[0]?.canResume, false);
    assert.equal(completed.runs[0]?.canExport, true);

    const attention = service.snapshot({ manifestPath: attentionProject.manifestPath });
    assert.equal(attention.runs[0]?.phase, "needs_attention");
    assert.equal(attention.runs[0]?.progress.humanRequiredWindows, 1);
    assert.equal(attention.runs[0]?.canResume, true);
    assert.equal(attention.runs[0]?.canExport, false);
    assert.equal(attention.runs[0]?.attention?.items.length, 1);
    assert.equal(attention.runs[0]?.attention?.items[0]?.code, "ATTENTION_UNCLASSIFIED");
    assert.equal(attention.runs[0]?.attention?.retryAvailable, true);
    assert.equal(attention.runs[0]?.attention?.retryAttempted, false);
  } finally {
    rmSync(pausedProject.directory, { recursive: true, force: true });
    rmSync(completedProject.directory, { recursive: true, force: true });
    rmSync(attentionProject.directory, { recursive: true, force: true });
  }
});

test("desktop full-book safely requeues human-required windows before resuming", async () => {
  const project = fixture();
  const seen: LosslessBookRunOptions[] = [];
  try {
    await storedFullBookRun({
      project,
      runId: "run-attention-retry",
      completedWindows: 1,
      humanRequired: true,
      failureError: "framed response protocol rejected the final submission",
    });
    const service = new DesktopFullBookService({
      runtime: runtimeResolver(),
      runBook: async (options) => {
        seen.push(options);
        return runResult("run-attention-retry", {
          outcome: "partial",
          processedWindows: 0,
        });
      },
      pollIntervalMs: 5,
    });

    const before = service.snapshot({ manifestPath: project.manifestPath });
    assert.equal(before.runs[0]?.attention?.items[0]?.category, "protocol");

    await service.resume(
      { manifestPath: project.manifestPath },
      { runId: "run-attention-retry" },
    );
    await flushBackground();
    assert.equal(seen.length, 1);

    const store = LosslessBookStore.openReadOnly(project.storePath);
    try {
      const windows = store.allWindows("run-attention-retry");
      assert.equal(windows.filter((window) => window.status === "human_required").length, 0);
      assert.equal(windows.filter((window) => window.status === "pending").length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book exposes an exhausted attention retry without offering a second mutation", async () => {
  const project = fixture();
  try {
    await storedFullBookRun({
      project,
      runId: "run-attention-once",
      completedWindows: 1,
      humanRequired: true,
      failureError: "external model provider timeout",
    });
    const service = new DesktopFullBookService({
      runtime: runtimeResolver(),
      runBook: async () => runResult("run-attention-once", {
        outcome: "partial",
        processedWindows: 0,
      }),
      pollIntervalMs: 5,
    });
    await service.resume(
      { manifestPath: project.manifestPath },
      { runId: "run-attention-once" },
    );
    await flushBackground();

    const store = new LosslessBookStore(project.storePath);
    try {
      const pending = store.pendingWindows("run-attention-once")[0];
      assert.ok(pending);
      store.claimWindow("run-attention-once", pending.windowId);
      store.failWindow("run-attention-once", pending.windowId, {
        error: "external model provider timeout after audited retry",
        retry: false,
        budget: {},
        warnings: [],
      });
    } finally {
      store.close();
    }

    const restarted = new DesktopFullBookService({ runtime: runtimeResolver() });
    const after = restarted.snapshot({ manifestPath: project.manifestPath });
    assert.equal(after.runs[0]?.attention?.retryAttempted, true);
    assert.equal(after.runs[0]?.attention?.retryAvailable, false);
    assert.equal(after.runs[0]?.canResume, false);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book excludes trial runs from formal task snapshots", async () => {
  const project = fixture();
  const context = BookContext.openLossless({ manifestPath: project.manifestPath });
  mkdirSync(dirname(project.storePath), { recursive: true });
  const store = new LosslessBookStore(project.storePath);
  try {
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    const snapshot = createKnowledgeSnapshot("trial-run", []);
    store.createTranslationRun({
      runId: "trial-run",
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "v5-book-3",
      modelId: "deepseek-v4-flash",
      initialSnapshotId: snapshot.id,
      initialSnapshot: snapshot,
      metadata: {
        desktopTrial: {
          schema: "folioloom-desktop-trial-2",
          runtimeFingerprint: "{}",
        },
      },
    });
    assert.deepEqual(
      new DesktopFullBookService({ runtime: runtimeResolver() })
        .snapshot({ manifestPath: project.manifestPath }),
      { runs: [] },
    );
  } finally {
    store.close();
    context.close();
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book rejects an unready model before reserving an active task", async () => {
  const project = fixture();
  try {
    const options: DesktopFullBookServiceOptions = {
      runtime: { async resolve() { return undefined; } },
    };
    const service = new DesktopFullBookService(options);

    await assert.rejects(
      service.start(
        { manifestPath: project.manifestPath },
        { optimizationProfile: "balanced" },
      ),
      (error: unknown) => error instanceof DesktopFullBookError
        && error.code === "DESKTOP_FULLBOOK_MODEL_NOT_READY",
    );
    assert.equal(service.hasActiveTask(), false);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book rejects invalid modes before resolving the runtime", async () => {
  const project = fixture();
  let resolved = 0;
  try {
    const service = new DesktopFullBookService({
      runtime: {
        async resolve() {
          resolved += 1;
          return undefined;
        },
      },
    });
    await assert.rejects(
      service.start(
        { manifestPath: project.manifestPath } satisfies DesktopProjectRequest,
        { optimizationProfile: "cheap" as never },
      ),
      (error: unknown) => error instanceof DesktopFullBookError
        && error.code === "DESKTOP_FULLBOOK_INPUT_INVALID",
    );
    assert.equal(resolved, 0);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop full-book progress uses only public phase and non-negative counters", () => {
  const phase: DesktopFullBookPhase = "running";
  const progress: DesktopFullBookProgress = {
    runId: "run-public",
    phase,
    progress: {
      totalWindows: 3,
      pendingWindows: 2,
      runningWindows: 1,
      stagedWindows: 0,
      completedWindows: 0,
      warningWindows: 0,
      humanRequiredWindows: 0,
      failedWindows: 0,
    },
  };
  assert.equal(progress.phase, "running");
  assert.equal(progress.progress.totalWindows, 3);
});
