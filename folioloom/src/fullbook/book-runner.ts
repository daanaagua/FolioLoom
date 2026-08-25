import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import {
  collectWindowAnchorCandidates,
  LexicalAnchorer,
  sourceAuthoredAnchorFallback,
  softenModelAnchorTerm,
  type LexicalAnchor,
  type LexicalAnchorOutcome,
} from "../agents/lexical-anchorer.js";
import {
  ModelProviderError,
  PiRuntime,
} from "../agents/pi-runtime.js";
import {
  type TranslationBatchWindowResult,
} from "../agents/translation-batch.js";
import type { TranslationRequestInput } from "../agents/translation-request.js";
import type { EntityLink } from "../domain/entity-links.js";
import type { StableTerm, V4Block } from "../domain/types.js";
import {
  relevantGlossaryTerms,
  type LoadedGlossary,
} from "../glossary/glossary-profile.js";
import {
  BudgetExceeded,
  BudgetLedger,
  DEFAULT_BUDGET_LIMITS,
} from "../kernel/budget.js";
import { RunLease } from "../kernel/run-lease.js";
import {
  canonicalJson,
  KnowledgeStore,
  type KnowledgeCandidate,
  type KnowledgeRevision,
} from "../knowledge/knowledge-store.js";
import {
  collectTranslationKnowledgeCandidates,
  type TranslationKnowledgeCandidate,
} from "../knowledge/translation-knowledge-projection.js";
import {
  mergeStyleState,
  persistedStyleFromKnowledge,
} from "../knowledge/persisted-style.js";
import { stableTermsFromKnowledge } from "../knowledge/stable-terms-from-knowledge.js";
import {
  conceptFromAnchor,
  type LexicalSemanticClass,
} from "../knowledge/lexical-concept.js";
import { conceptsFromStableTerms } from "../knowledge/term-usage.js";
import { createKnowledgeSnapshot } from "../knowledge/snapshot.js";
import { SourceLedger } from "../source/source-ledger.js";
import type { LosslessBlock } from "../source/types.js";
import {
  WeightedTokenEstimator,
} from "../source/token-estimator.js";
import {
  analyzeSourceAnomalies,
  type SourceAnomalyReport,
} from "../source/anomaly-report.js";
import {
  runTranslationWindow,
  type PilotResult,
} from "../pilot-runner.js";
import { writeBookArtifacts, type BookArtifactPaths } from "../report.js";
import {
  BookStore,
  type BookStatusSummary,
  type PersistedWindow,
} from "../storage/book-store.js";
import {
  LosslessBookStore,
  type ConceptCoverageRevalidationReport,
  type LosslessBookStatusSummary,
  type PersistedLosslessWindow,
  type RevalidationWorkItem,
} from "../storage/lossless-book-store.js";
import type { RuntimeProfileStore } from "../storage/runtime-profile-store.js";
import {
  sanitizeTranslationMemoryCandidates,
  type TranslationMemoryCandidate,
} from "../tools/candidate-collector.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import type { StyleState } from "../tools/translation-tools.js";
import { TranslationValidator } from "../validators/translation-validator.js";
import {
  composeEffectiveStyle,
  createBookStyleConstitution,
} from "../style/effective-style.js";
import { createStyleObservation } from "../style/style-observation.js";
import { projectEffectiveStyle } from "../style/style-projection.js";
import { simplifyChineseTranslation } from "../style/chinese-script-normalization.js";
import type {
  BookStyleConstitution,
  EffectiveStyleProjection,
  VoiceProfile,
} from "../style/types.js";
import { BookContext } from "./book-context.js";
import {
  AdaptiveScheduler,
} from "./adaptive-scheduler.js";
import {
  AdmissionController,
  BookTokenEnvelopeExceededError,
  incrementalBaselineProjection,
  weightedBaselineProjectionTasks,
} from "./admission-controller.js";
import { CongestionSensor } from "./congestion-sensor.js";
import { CommitCoordinator } from "./commit-coordinator.js";
import { TelemetrySink } from "./telemetry-sink.js";
import {
  planContextProfiles,
  type ContextProfile,
  type ContextProfileName,
} from "./context-profile-planner.js";
import {
  DEFAULT_TRANSLATION_KNOWLEDGE_MAX_ENTRIES,
} from "../knowledge/translation-knowledge-projection.js";
import {
  DynamicScheduler,
  type SchedulerDispatchReport,
  type SchedulerRunReport,
} from "./dynamic-scheduler.js";
import {
  admitTranslationRequests,
  BookRequestCapacityError,
  executePlannedTranslationRequest,
  type AdmittedTranslationRequest,
  type CompletedTranslationRequest,
  type MergedTranslationResult,
  type PlannedTranslationExecution,
  type ScheduledResult,
} from "./execution-worker.js";
import {
  boundedActiveTail,
  memoriesFromSnapshot,
} from "./memory-projection.js";
import {
  optimizationPolicy,
  profileFromLegacyRunMode,
  validateRuntimeVariants,
  type OptimizationProfile,
  type SchedulerMode,
} from "./optimization-policy.js";
import {
  schedulerCountersPatch,
  TokenLedger,
  type LedgerEvent,
} from "./token-ledger.js";
import { assessLexicalAnchorAttempt } from "./lexical-anchor-budget.js";
import {
  planRollingHorizon,
  type PlannedTaskDispatch,
  type RunningTaskReservation,
  type RollingPlannerInput,
  type TaskExecutionVariant,
} from "./rolling-horizon-planner.js";
import {
  loadRuntimeCostModel,
  OnlineRuntimeCostModel,
  persistRuntimeCostModel,
  type RuntimeFeatures,
} from "./runtime-cost-model.js";
import {
  type NormalizedRuntimeUsage,
  type RuntimeObservationStatus,
} from "./runtime-telemetry.js";
import { buildTaskGraph, type SchedulerTask } from "./task-graph.js";
import {
  assessTaskRisk,
  type TaskRelationKind,
  type TaskRiskAssessment,
} from "./task-risk.js";
import {
  drainKnowledgeRevalidationTasks,
  emptyRevalidationDrainReport,
  executeRevalidationTasks,
  mergeRevalidationDrainReports,
  type RevalidationDrainReport,
  type RevalidationModelTelemetry,
  type RevalidationTranslationOutput,
} from "./revalidation-executor.js";
import type { WindowExecutionSummary } from "./types.js";
import type {
  PhysicalRequestPlan,
  RequestBatchWindow,
  TranslationRuntime,
  TranslationRuntimeSet,
} from "./types.js";
import { packPhysicalRequests } from "./request-batcher.js";
import {
  nextConcurrency,
  planBookWindows,
  type WindowPlanOptions,
} from "./window-planner.js";

export const LOSSLESS_BOOK_PROTOCOL_VERSION = "v5-book-3";
export { drainKnowledgeRevalidationTasks };
export type {
  RevalidationDrainOptions,
  RevalidationDrainReport,
  RevalidationModelTelemetry,
  RevalidationTranslationOutput,
} from "./revalidation-executor.js";

const DEFAULT_PROTOCOL_VERSION = LOSSLESS_BOOK_PROTOCOL_VERSION;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_CONCURRENCY = 2;
const FAST_TARGET_SOURCE_TOKENS = 3_200;
const FAST_MAX_SOURCE_TOKENS = 4_800;
const FAST_MAX_BLOCKS = 4;

export class BookStorageIncidentError extends Error {
  readonly code = "STORAGE_LOCKED" as const;
  readonly retryable = true;

  constructor(cause: unknown) {
    super(`STORAGE_LOCKED: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BookStorageIncidentError";
  }
}

class BookSourceVersionChangedError extends Error {
  readonly code = "SOURCE_VERSION_CHANGED" as const;

  constructor(message: string) {
    super(`SOURCE_VERSION_CHANGED: ${message}`);
    this.name = "BookSourceVersionChangedError";
  }
}

function isStorageLocked(error: unknown): boolean {
  return error instanceof Error
    && /(?:SQLITE_BUSY|database(?: table)? is locked)/iu.test(error.message);
}

function assertSourceVersionUnchanged(context: BookContext): void {
  const expected = context.sourceLedger.sourceVersion;
  try {
    const current = SourceLedger.open(context.sourceLedger.manifestPath);
    if (current.sourceVersion !== expected) {
      throw new BookSourceVersionChangedError(
        `expected ${expected}, found ${current.sourceVersion}`,
      );
    }
  } catch (error) {
    if (error instanceof BookSourceVersionChangedError) {
      throw error;
    }
    throw new BookSourceVersionChangedError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function runMetadataWithLanguageProfile(
  metadata: unknown,
  context: BookContext,
  runtimeSet?: TranslationRuntimeSet,
): Record<string, unknown> {
  const userMetadata = typeof metadata === "object"
    && metadata !== null
    && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : metadata === undefined
      ? {}
      : { userMetadata: metadata };
  return {
    ...userMetadata,
    sourceLanguageProfile: {
      id: context.languageProfile.id,
      version: context.languageProfile.version,
      compatibilityMode: context.sourceLedger.sourceLanguageCompatibilityMode,
    },
    sourceAnomalies: analyzeSourceAnomalies(context.sourceLedger.sourceText),
    ...(runtimeSet === undefined ? {} : {
      translationRuntime: {
        mode: runtimeSet.mode,
        primary: {
          modelId: runtimeSet.primary.model.id,
          ...(runtimeSet.primary.effort === undefined
            ? {}
            : { effort: runtimeSet.primary.effort }),
          ...(runtimeSet.primary.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: runtimeSet.primary.thinkingLevel }),
        },
        escalation: {
          modelId: runtimeSet.escalation.model.id,
          ...(runtimeSet.escalation.effort === undefined
            ? {}
            : { effort: runtimeSet.escalation.effort }),
          ...(runtimeSet.escalation.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: runtimeSet.escalation.thinkingLevel }),
        },
      },
    }),
  };
}

function runtimeMetadata(metadata: unknown): unknown | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return (metadata as Record<string, unknown>).translationRuntime;
}

function joinedStyleInstruction(
  primary: string | undefined,
  qualifierLabel: string,
  qualifier: string | undefined,
): string | undefined {
  const normalizedQualifier = qualifier?.trim();
  const values = [
    normalizedQualifier === undefined || normalizedQualifier.length === 0
      ? undefined
      : `${qualifierLabel}：${normalizedQualifier}`,
    primary?.trim(),
  ].filter((value): value is string => value !== undefined && value.length > 0);
  return values.length === 0 ? undefined : values.join("；");
}

function losslessStyleConstitution(style: StyleState | undefined): BookStyleConstitution {
  return createBookStyleConstitution({
    register: style?.register,
    sentencePolicy: style?.sentencePolicy,
    explicitation: style?.explicitation,
    imagery: style?.imagery,
    dialogue: joinedStyleInstruction(
      style?.dialogue,
      "对话语域",
      style?.dialogueRegister,
    ),
    technicalProse: style?.technicalProse,
    typography: style?.typography ?? style?.dialogueQuotes,
    additionalInstruction: style?.additionalInstruction,
  });
}

function losslessVoiceProfiles(style: StyleState | undefined): VoiceProfile[] {
  return [{
    voiceId: "narrator",
    scope: "main_narrator",
    instruction: joinedStyleInstruction(
      style?.narratorVoice,
      "叙事距离",
      style?.narrativeDistance,
    ) ?? "保持作品主叙述者既定视角、距离和信息显隐",
    confidence: 1,
  }];
}
const DEFAULT_WARMUP_WINDOWS = 2;

export interface BookPreflight {
  sourceFingerprint: string;
  blocks: number;
  chapters: number;
  windows: number;
  sourceTokens: number;
  sourceChars: number;
  oversizedWindows: number;
  sourceWarnings: string[];
}

export interface BookWaveReport {
  wave: number;
  concurrency: number;
  windowIds: string[];
}

export interface BookRunOptions {
  dbPath: string;
  storePath: string;
  outputDir: string;
  model: Model<any>;
  streamFn: StreamFn;
  windowOptions?: WindowPlanOptions;
  protocolVersion?: string;
  styleState?: StyleState;
  maxWindows?: number;
  warmupWindows?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  hardDeadlineMs?: number;
}

export interface BookRunResult {
  outcome: "completed" | "completed_with_warnings" | "human_required" | "partial";
  processedWindows: number;
  waves: BookWaveReport[];
  status: BookStatusSummary;
  windows: PersistedWindow[];
  wallTimeMs: number;
  leaseReleased: boolean;
  artifacts: BookArtifactPaths;
}

export interface LosslessBookRunMeta {
  runId: string;
  protocolVersion: string;
  modelId?: string;
  metadata?: unknown;
}

export interface LosslessBookRunOptions {
  manifestPath: string;
  legacyV4DbPath?: string;
  storePath: string;
  runMeta: LosslessBookRunMeta;
  model: Model<any>;
  streamFn: StreamFn;
  /** Optional explicit dual-runtime policy. Legacy callers remain quality mode. */
  runtimeSet?: TranslationRuntimeSet;
  optimizationProfile?: OptimizationProfile;
  schedulerMode?: SchedulerMode;
  runtimeProfileStore?: RuntimeProfileStore;
  windowOptions?: WindowPlanOptions;
  styleState?: StyleState;
  glossary?: LoadedGlossary;
  maxWindows?: number;
  maxConcurrency?: number;
  maxInFlightTokens?: number;
  maxAttempts?: number;
  hardDeadlineMs?: number;
  tinyWindowTokens?: number;
  maxRequestTokens?: number;
  maxWindowsPerRequest?: number;
  /** Optional shared estimator keeps provider/language calibration across waves and test runs. */
  tokenEstimator?: WeightedTokenEstimator;
  /**
   * Stops between durable window operations. A promotion that has already
   * entered the store remains atomic and is never interrupted mid-transaction.
   */
  signal?: AbortSignal;
  /**
   * Requests a cooperative stop at the next durable wave boundary. Unlike
   * aborting `signal`, this does not discard an in-flight provider response or
   * turn an unknown-usage cancellation into permanent envelope spend.
   */
  shouldPause?: () => boolean;
}

export { BookRequestCapacityError };
export { BookTokenEnvelopeExceededError };

export class BookNoLegalPlanError extends Error {
  readonly code = "NO_LEGAL_PLAN" as const;
  readonly retryable = false;

  constructor(
    readonly actualTokens: number,
    readonly runningReservedTokens: number,
    readonly allowedTokens: number,
    readonly pendingTasks: number,
  ) {
    super(
      `NO_LEGAL_PLAN: planner found no legal active dispatch for `
      + `${pendingTasks} pending task(s) with actual ${actualTokens}, running `
      + `${runningReservedTokens}, and allowed ${allowedTokens}`,
    );
    this.name = "BookNoLegalPlanError";
  }
}

class RevalidationOutputError extends Error {
  readonly code = "REVALIDATION_OUTPUT_INVALID" as const;

  constructor(detail: string) {
    super(`REVALIDATION_OUTPUT_INVALID: ${detail}`);
    this.name = "RevalidationOutputError";
  }
}

export interface LosslessBookRunResult {
  outcome: "completed" | "completed_with_warnings" | "human_required" | "partial";
  runId: string;
  processedWindows: number;
  waves: BookWaveReport[];
  status: LosslessBookStatusSummary;
  windows: PersistedLosslessWindow[];
  wallTimeMs: number;
  revalidationOverhead: {
    readonly coverageScan: ConceptCoverageRevalidationReport;
    readonly drain: RevalidationDrainReport;
  };
  scheduler: SchedulerRunReport;
  leaseReleased: boolean;
  artifacts: null;
}

interface AttemptResult {
  window: PersistedWindow;
  result?: PilotResult;
  error?: string;
  fatalProviderError?: boolean;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function preflightBook(
  databasePath: string,
  windowOptions: WindowPlanOptions = {},
): BookPreflight {
  const context = BookContext.open(databasePath);
  try {
    const blocks = context.blocks;
    const windows = planBookWindows(blocks, windowOptions);
    const source = blocks.map((block) => block.sourceText).join("\n");
    const sourceWarnings: string[] = [];
    const replacements = [...source.matchAll(/�/gu)].length;
    const nulls = [...source.matchAll(/\0/gu)].length;
    if (replacements > 0) {
      sourceWarnings.push(`source contains ${replacements} replacement character(s)`);
    }
    if (nulls > 0) {
      sourceWarnings.push(`source contains ${nulls} NUL character(s)`);
    }
    return {
      sourceFingerprint: context.sourceFingerprint,
      blocks: blocks.length,
      chapters: new Set(blocks.map((block) => block.chapterId)).size,
      windows: windows.length,
      sourceTokens: blocks.reduce((total, block) => total + block.tokenCount, 0),
      sourceChars: blocks.reduce((total, block) => total + block.sourceText.length, 0),
      oversizedWindows: windows.filter((window) => window.oversized).length,
      sourceWarnings,
    };
  } finally {
    context.close();
  }
}

function normalizeForm(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function anchorConflict(
  existing: readonly LexicalAnchor[],
  proposed: readonly LexicalAnchor[],
): string | undefined {
  const bySource = new Map(existing.map((anchor) => [normalizeForm(anchor.sourceForm), anchor]));
  for (const anchor of proposed) {
    const prior = bySource.get(normalizeForm(anchor.sourceForm));
    if (prior === undefined) {
      continue;
    }
    if (prior.mode !== anchor.mode
      || (prior.mode === "stable" && prior.target !== anchor.target)) {
      return `lexical anchor conflict for ${anchor.sourceForm}`;
    }
  }
  return undefined;
}

function resultSummary(result: PilotResult): WindowExecutionSummary {
  return {
    status: result.status === "completed"
      ? "completed"
      : result.status === "completed_with_warnings"
        ? "completed_with_warnings"
        : "human_required",
    modelCalls: result.metrics.modelCalls,
    modelCallLimit: DEFAULT_BUDGET_LIMITS.modelCalls,
    repaired: result.audit.validations.some((item) => item.repaired),
    deadlineExceeded: result.metrics.degradedReasons.some((reason) =>
      reason.toLocaleLowerCase().includes("deadline")),
  };
}

async function runLegacyBook(options: BookRunOptions): Promise<BookRunResult> {
  const startedAt = performance.now();
  const maxWindows = nonNegativeInteger(
    options.maxWindows ?? Number.MAX_SAFE_INTEGER,
    "maxWindows",
  );
  const maxConcurrency = positiveInteger(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    "maxConcurrency",
  );
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const warmupWindows = nonNegativeInteger(
    options.warmupWindows ?? DEFAULT_WARMUP_WINDOWS,
    "warmupWindows",
  );
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  mkdirSync(options.outputDir, { recursive: true });
  const context = BookContext.open(options.dbPath);
  const store = new BookStore(options.storePath);
  const windows = planBookWindows(context.blocks, {
    ...options.windowOptions,
    protocolVersion,
  });
  store.initializePlan({
    sourceDbPath: options.dbPath,
    sourceFingerprint: context.sourceFingerprint,
    protocolVersion,
    modelId: options.model.id,
    blocks: context.blocks,
    windows,
  });
  const leasePath = `${resolve(options.storePath)}.run.lock`;
  const lease = RunLease.acquire(leasePath, `book:${context.sourceFingerprint}`);
  const waves: BookWaveReport[] = [];
  const history: WindowExecutionSummary[] = [];
  let processedWindows = 0;

  const runAttempt = async (pending: PersistedWindow): Promise<AttemptResult> => {
    const claimed = store.claimWindow(pending.windowId);
    try {
      const result = await runTranslationWindow({
        dbPath: options.dbPath,
        context,
        outputDir: join(
          options.outputDir,
          ".windows",
          claimed.windowId,
          `attempt-${claimed.attemptCount}`,
        ),
        outputPrefix: "window",
        globalIndexes: claimed.globalIndexes,
        model: options.model,
        streamFn: options.streamFn,
        translationConcurrency: 1,
        hardDeadlineMs: options.hardDeadlineMs,
        protocolVersion,
        persistedAnchors: store.loadLexicalAnchors(),
        persistedNarrativeMemories: store.loadNarrativeMemories(),
        previousActiveTail: store.loadStyleTail(),
        styleState: options.styleState,
        researchMode: "on_demand",
      });
      return { window: claimed, result };
    } catch (error) {
      return {
        window: claimed,
        error: error instanceof Error ? error.message : String(error),
        fatalProviderError: error instanceof ModelProviderError,
      };
    }
  };

  const finalizeAttempt = async (initial: AttemptResult): Promise<WindowExecutionSummary> => {
    let attempt = initial;
    while (true) {
      if (attempt.fatalProviderError) {
        const error = attempt.error ?? "external model provider failure";
        store.failWindow(attempt.window.windowId, {
          error,
          retry: true,
          budget: {},
          warnings: ["external model provider failure; run aborted without human task"],
        });
        throw new ModelProviderError(error);
      }
      const result = attempt.result;
      const conflict = result === undefined
        ? undefined
        : anchorConflict(store.loadLexicalAnchors(), result.audit.lexicalAnchors);
      const successful = result !== undefined
        && !result.audit.validations.some((item) => !item.valid)
        && result.translations.length === attempt.window.blockIds.length
        && (result.status === "completed" || result.status === "completed_with_warnings")
        && conflict === undefined;
      if (successful) {
        const sourceById = new Map(context.blocks.map((block) => [block.id, block]));
        store.commitWindow({
          windowId: attempt.window.windowId,
          status: result.status as "completed" | "completed_with_warnings",
          translations: result.translations.map((translation) => ({
            blockId: translation.blockId,
            sourceHash: (sourceById.get(translation.blockId) as { sourceHash: string }).sourceHash,
            text: translation.text,
          })),
          lexicalAnchors: result.audit.lexicalAnchors,
          narrativeMemories: [
            ...memoriesFromSnapshot(result.snapshot),
            ...result.narrativeMemories,
          ],
          styleTail: boundedActiveTail(
            result.translations.map((translation) => translation.text).join("\n\n"),
          ),
          budget: result.metrics.budget,
          warnings: result.metrics.degradedReasons,
        });
        return resultSummary(result);
      }

      const error = conflict
        ?? attempt.error
        ?? `window ended as ${result?.status ?? "failed"} without a complete valid submission`;
      const retry = attempt.window.attemptCount < maxAttempts;
      store.failWindow(attempt.window.windowId, {
        error,
        retry,
        budget: result?.metrics.budget ?? {},
        warnings: result?.metrics.degradedReasons ?? [error],
      });
      if (!retry) {
        return {
          status: "human_required",
          modelCalls: result?.metrics.modelCalls ?? 0,
          modelCallLimit: DEFAULT_BUDGET_LIMITS.modelCalls,
          repaired: result?.audit.validations.some((item) => item.repaired) ?? false,
          deadlineExceeded: error.toLocaleLowerCase().includes("deadline"),
        };
      }
      attempt = await runAttempt(store.window(attempt.window.windowId) as PersistedWindow);
    }
  };

  try {
    while (processedWindows < maxWindows) {
      const pending = store.pendingWindows();
      if (pending.length === 0) {
        break;
      }
      const concurrency = nextConcurrency(history, {
        warmupWindows,
        maxConcurrency,
      });
      const remaining = maxWindows - processedWindows;
      const selected = pending.slice(0, Math.min(concurrency, remaining));
      if (selected.length === 0) {
        break;
      }
      waves.push({
        wave: waves.length,
        concurrency: selected.length,
        windowIds: selected.map((window) => window.windowId),
      });
      const attempts = await Promise.all(selected.map(runAttempt));
      attempts.sort((left, right) => left.window.ordinal - right.window.ordinal);
      for (const attempt of attempts) {
        history.push(await finalizeAttempt(attempt));
      }
      processedWindows += selected.length;
    }
    const status = store.statusSummary();
    const outcome: BookRunResult["outcome"] = status.humanRequiredWindows > 0
      ? "human_required"
      : status.pendingWindows > 0
        ? "partial"
        : status.warningWindows > 0
          ? "completed_with_warnings"
          : "completed";
    const artifacts = writeBookArtifacts(store, options.outputDir, {
      allowIncomplete: true,
    });
    return {
      outcome,
      processedWindows,
      waves,
      status,
      windows: store.allWindows(),
      wallTimeMs: performance.now() - startedAt,
      leaseReleased: true,
      artifacts,
    };
  } finally {
    lease.release();
    store.close();
    context.close();
  }
}

function requiredIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be nonempty`);
  }
  return value;
}

function knowledgeCandidatesFor(
  runId: string,
  windowId: string,
  candidates: readonly TranslationMemoryCandidate[],
): KnowledgeCandidate[] {
  return sanitizeTranslationMemoryCandidates(candidates).candidates
    .map((candidate, index) => {
      const normalizedSubject = candidate.subjectForms[0]
        ?.normalize("NFKC")
        .trim()
        .toLocaleLowerCase();
      if (normalizedSubject === undefined || normalizedSubject.length === 0) {
        throw new Error(`memory candidate ${index} has no nonempty subject form`);
      }
      const payload = {
        fact: candidate.fact,
        confidence: candidate.confidence,
        subjectForms: [...candidate.subjectForms],
      };
      const recordId = `knowledge-${createHash("sha256")
        .update(`${runId}\0${windowId}\0${index}\0${JSON.stringify({
          normalizedSubject,
          kind: candidate.kind,
          payload,
        })}`)
        .digest("hex")
        .slice(0, 24)}`;
      return {
        recordId,
        normalizedSubject,
        kind: candidate.kind,
        payload,
      };
    });
}

interface WaveKnowledgeCandidate {
  candidate: KnowledgeCandidate;
  sourceForms: readonly string[];
}

interface WaveAnchorSnapshot {
  schemaVersion: "v5-wave-anchor-1";
  inputHash: string;
  anchors: readonly LexicalAnchor[];
  entityLinks: readonly EntityLink[];
  terms: readonly StableTerm[];
}

function waveAnchorInputHash(
  context: BookContext,
  candidates: readonly { sourceForm: string; contexts: readonly string[] }[],
  stableTerms: readonly StableTerm[],
): string {
  return createHash("sha256").update(canonicalJson({
    schemaVersion: "v5-wave-anchor-input-1",
    profile: {
      id: context.languageProfile.id,
      version: context.languageProfile.version,
    },
    candidates,
    stableTerms: stableTerms.map((term) => ({
      sourceForm: term.sourceForm,
      canonicalSource: term.canonicalSource,
      target: term.target,
      locked: term.locked,
      ...(term.policy === undefined ? {} : { policy: term.policy }),
      ...(term.semanticClass === undefined ? {} : { semanticClass: term.semanticClass }),
      ...(term.allowedTargets === undefined ? {} : { allowedTargets: term.allowedTargets }),
      ...(term.revisionId === undefined ? {} : { revisionId: term.revisionId }),
      ...(term.renderFingerprint === undefined
        ? {}
        : { renderFingerprint: term.renderFingerprint }),
      ...(term.note === undefined ? {} : { note: term.note }),
      ...(term.origin === undefined ? {} : { origin: term.origin }),
    })),
  })).digest("hex");
}

function parseWaveAnchorSnapshot(
  value: unknown,
  expectedInputHash: string,
): WaveAnchorSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("corrupt cached wave anchor decision");
  }
  const candidate = value as Partial<WaveAnchorSnapshot>;
  if (candidate.schemaVersion !== "v5-wave-anchor-1"
    || candidate.inputHash !== expectedInputHash
    || !Array.isArray(candidate.anchors)
    || !Array.isArray(candidate.entityLinks)
    || !Array.isArray(candidate.terms)) {
    throw new Error("corrupt cached wave anchor decision");
  }
  const snapshot = structuredClone(candidate as WaveAnchorSnapshot);
  return {
    ...snapshot,
    anchors: snapshot.anchors.map((anchor) => ({
      ...anchor,
      semanticClass: anchor.semanticClass ?? "unclassified",
      lockEligible: anchor.lockEligible === true,
      target: simplifyChineseTranslation(anchor.target),
    })),
    terms: snapshot.terms.map((term) => softenModelAnchorTerm({
      ...term,
      target: simplifyChineseTranslation(term.target),
    })),
    entityLinks: snapshot.entityLinks.map((link) => ({
      ...link,
      preferredTarget: link.preferredTarget === null
        ? null
        : simplifyChineseTranslation(link.preferredTarget),
    })),
  };
}

function unresolvedEntityWarnings(snapshot: WaveAnchorSnapshot | undefined): string[] {
  return snapshot?.entityLinks.filter((link) => link.status !== "confirmed")
    .map((link) => [
      link.sourceForms.join(" / "),
      link.status,
      "same-entity relation is unresolved; do not lock them to one Chinese target",
    ].join(": ")) ?? [];
}

function losslessAsV4(block: BookContext["losslessBlocks"][number]): V4Block {
  return {
    id: block.id,
    legacyId: null,
    chapterId: block.structureId,
    chapterTitle: block.structureTitle,
    globalIndex: block.globalIndex,
    blockIndex: block.globalIndex,
    sourceText: block.sourceText,
    sourceHash: block.sourceHash,
    tokenCount: block.tokenCount,
  };
}

function withoutStructureHeadingLines(
  block: V4Block,
  context: BookContext,
): V4Block | undefined {
  const sourceText = block.sourceText.split(/\r?\n/gu)
    .filter((line) => context.languageProfile.detectStructureHeading(line.trim()) === null)
    .join("\n")
    .trim();
  return sourceText.length === 0 ? undefined : { ...block, sourceText };
}

function windowSourceText(
  window: PersistedLosslessWindow,
  blockById: ReadonlyMap<string, BookContext["losslessBlocks"][number]>,
): string {
  return window.blockIds.map((blockId) => blockById.get(blockId)?.sourceText ?? "")
    .join("\n\n");
}

function decidedAnchorFormsFromKnowledge(revisions: readonly unknown[]): string[] {
  return revisions.flatMap((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return [];
    }
    const revision = raw as { kind?: unknown; payload?: unknown; status?: unknown };
    if ((revision.kind !== "lexical_anchor_decision"
      && revision.kind !== "lexical_concept")
      || (revision.status !== "active" && revision.status !== "contextual")
      || revision.payload === null
      || typeof revision.payload !== "object"
      || Array.isArray(revision.payload)) {
      return [];
    }
    const payload = revision.payload as {
      sourceForm?: unknown;
      sourceForms?: unknown;
    };
    if (revision.kind === "lexical_concept" && Array.isArray(payload.sourceForms)) {
      return payload.sourceForms.filter((sourceForm): sourceForm is string =>
        typeof sourceForm === "string" && sourceForm.trim().length > 0);
    }
    return typeof payload.sourceForm === "string" && payload.sourceForm.trim().length > 0
      ? [payload.sourceForm]
      : [];
  });
}

function uniqueTerms(
  terms: readonly StableTerm[],
  context: BookContext,
): StableTerm[] {
  const byForm = new Map<string, StableTerm>();
  for (const sourceTerm of terms) {
    const safeSourceTerm = softenModelAnchorTerm(sourceTerm);
    const term = safeSourceTerm.origin === "knowledge"
      ? { ...safeSourceTerm, target: simplifyChineseTranslation(safeSourceTerm.target) }
      : safeSourceTerm;
    const normalized = context.languageProfile.normalizeSourceForm(term.sourceForm);
    const previous = byForm.get(normalized);
    const priority = (value: StableTerm): number => {
      if (value.origin === "glossary") {
        return 3;
      }
      if (value.origin === "legacy") {
        return 2;
      }
      return 1;
    };
    if (previous === undefined || priority(term) >= priority(previous)) {
      byForm.set(normalized, { ...term });
    }
  }
  return [...byForm.values()].sort((left, right) =>
    left.sourceForm.localeCompare(right.sourceForm));
}

function sourceBlocksForWindows(
  windows: readonly Pick<PersistedLosslessWindow, "blockIds">[],
  blockById: ReadonlyMap<string, BookContext["losslessBlocks"][number]>,
): BookContext["losslessBlocks"] {
  return windows.flatMap((window) => window.blockIds
    .map((blockId) => blockById.get(blockId))
    .filter((block): block is BookContext["losslessBlocks"][number] => block !== undefined));
}

function termsForWindows(
  terms: readonly StableTerm[],
  windows: readonly Pick<PersistedLosslessWindow, "blockIds" | "globalIndexes">[],
  context: BookContext,
  glossary: LoadedGlossary | undefined,
): StableTerm[] {
  const nonGlossary = terms.filter((term) => term.origin !== "glossary");
  if (glossary === undefined) {
    return uniqueTerms(nonGlossary, context);
  }
  const glossaryRelevant = relevantGlossaryTerms(
    glossary,
    windows.flatMap((window) => window.globalIndexes),
  );
  return uniqueTerms([...nonGlossary, ...glossaryRelevant], context);
}

function waveKnowledgeCandidates(
  runId: string,
  outcome: Pick<WaveAnchorSnapshot, "anchors" | "terms" | "entityLinks"> | undefined,
  context: BookContext,
): WaveKnowledgeCandidate[] {
  if (outcome === undefined) {
    return [];
  }
  const entityForms = new Set(outcome.entityLinks
    .filter((link) => link.status === "confirmed")
    .flatMap((link) => link.normalizedForms));
  const projectedTermForms = new Set(outcome.terms.map((term) =>
    context.languageProfile.normalizeSourceForm(term.sourceForm)));
  const termsByForm = new Map(outcome.terms.map((term) => [
    context.languageProfile.normalizeSourceForm(term.sourceForm),
    term,
  ]));
  const conceptForms = new Set<string>();
  const result: WaveKnowledgeCandidate[] = [];
  for (const anchor of outcome.anchors) {
    const normalizedSource = context.languageProfile.normalizeSourceForm(anchor.sourceForm);
    const semanticClass = anchor.semanticClass ?? "unclassified";
    const term = termsByForm.get(normalizedSource);
    const conceptEligible = [
      "proper_name",
      "unique_title",
      "technical_term",
      "role",
    ].includes(semanticClass);
    if (conceptEligible && term !== undefined) {
      const concept = conceptFromAnchor({
        sourceForm: anchor.sourceForm,
        target: simplifyChineseTranslation(anchor.target),
        mode: anchor.mode,
        semanticClass: semanticClass as LexicalSemanticClass,
        confidence: anchor.confidence,
        allowedRealizations: term.allowedTargets ?? [term.target],
      });
      conceptForms.add(normalizedSource);
      result.push({
        candidate: {
          recordId: `wave-lexical-concept-${createHash("sha256")
            .update(`${runId}\0${canonicalJson(concept)}`)
            .digest("hex")
            .slice(0, 24)}`,
          normalizedSubject: normalizedSource,
          kind: "lexical_concept",
          payload: concept,
        },
        sourceForms: concept.sourceForms,
      });
      continue;
    }
    if (anchor.mode !== "contextual" && !projectedTermForms.has(normalizedSource)) continue;
    const payload = {
      sourceForm: anchor.sourceForm,
      target: simplifyChineseTranslation(anchor.target),
      mode: anchor.mode,
      semanticClass,
      confidence: anchor.confidence,
    };
    result.push({
      candidate: {
        recordId: `wave-anchor-decision-${createHash("sha256")
          .update(`${runId}\0${canonicalJson(payload)}`)
          .digest("hex")
          .slice(0, 24)}`,
        normalizedSubject: normalizedSource,
        kind: "lexical_anchor_decision",
        payload,
      },
      sourceForms: [anchor.sourceForm],
    });
  }
  for (const sourceTerm of outcome.terms) {
    const term = softenModelAnchorTerm(sourceTerm);
    const normalizedSource =
      context.languageProfile.normalizeSourceForm(term.sourceForm);
    if (entityForms.has(normalizedSource) || conceptForms.has(normalizedSource)) {
      continue;
    }
    const payload = { ...term, target: simplifyChineseTranslation(term.target) };
    result.push({
      candidate: {
        recordId: `wave-anchor-${createHash("sha256")
          .update(`${runId}\0${canonicalJson(payload)}`)
          .digest("hex")
          .slice(0, 24)}`,
        normalizedSubject: normalizedSource,
        kind: "lexical_anchor",
        payload,
      },
      sourceForms: [term.sourceForm],
    });
  }
  for (const link of outcome.entityLinks) {
    const payload = {
      ...link,
      preferredTarget: link.preferredTarget === null
        ? null
        : simplifyChineseTranslation(link.preferredTarget),
    };
    result.push({
      candidate: {
        recordId: `wave-entity-${createHash("sha256")
          .update(`${runId}\0${canonicalJson(payload)}`)
          .digest("hex")
          .slice(0, 24)}`,
        normalizedSubject: `entity-alias:${link.linkId}`,
        kind: "entity_alias_link",
        payload,
      },
      sourceForms: link.sourceForms,
    });
  }
  return result;
}

function windowContainsAnyForm(
  window: PersistedLosslessWindow,
  forms: readonly string[],
  blockById: ReadonlyMap<string, BookContext["losslessBlocks"][number]>,
  context: BookContext,
): boolean {
  const requested = new Set(forms.map((form) =>
    context.languageProfile.normalizeAnchorSourceForm(form)));
  return window.blockIds.some((blockId) => {
    const block = blockById.get(blockId);
    return block !== undefined && context.languageProfile.segment(block.sourceText)
      .some((token) => token.isWordLike
        && requested.has(context.languageProfile.normalizeAnchorSourceForm(token.value)));
  });
}

function assignWaveKnowledge(
  candidates: readonly WaveKnowledgeCandidate[],
  selected: readonly PersistedLosslessWindow[],
  successfulWindowIds: ReadonlySet<string>,
  blockById: ReadonlyMap<string, BookContext["losslessBlocks"][number]>,
  context: BookContext,
): Map<string, KnowledgeCandidate[]> {
  const assigned = new Map<string, KnowledgeCandidate[]>();
  const successful = selected.filter((window) => successfulWindowIds.has(window.windowId));
  for (const item of candidates) {
    const owner = successful.find((window) =>
      windowContainsAnyForm(window, item.sourceForms, blockById, context));
    if (owner === undefined) {
      continue;
    }
    const values = assigned.get(owner.windowId) ?? [];
    values.push(item.candidate);
    assigned.set(owner.windowId, values);
  }
  return assigned;
}

function firstUncommitted(
  windows: readonly PersistedLosslessWindow[],
): PersistedLosslessWindow | undefined {
  return windows.find((window) =>
    window.status !== "completed" && window.status !== "completed_with_warnings");
}

function combinedBudget(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): Record<string, number> {
  const combined = { ...previous };
  for (const [counter, value] of Object.entries(current)) {
    combined[counter] = (combined[counter] ?? 0) + value;
  }
  return combined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function normalizeRuntimeSet(options: LosslessBookRunOptions): TranslationRuntimeSet {
  const runtimeSet: TranslationRuntimeSet = options.runtimeSet ?? {
    mode: "quality" as const,
    primary: { model: options.model, streamFn: options.streamFn },
    escalation: { model: options.model, streamFn: options.streamFn },
  };
  if (runtimeSet.primary.model.id !== runtimeSet.escalation.model.id) {
    throw new TypeError("primary and escalation runtimes must use the same model identity");
  }
  if (runtimeSet.mode === "quality"
    && (runtimeSet.primary.effort !== runtimeSet.escalation.effort
      || runtimeSet.primary.thinkingLevel !== runtimeSet.escalation.thinkingLevel
      || runtimeSet.primary.model !== runtimeSet.escalation.model
      || runtimeSet.primary.streamFn !== runtimeSet.escalation.streamFn)) {
    throw new TypeError("quality mode cannot change effort during retries or repair");
  }
  if (runtimeSet.mode === "fast"
    && runtimeEffortRank(runtimeSet.escalation)
      < runtimeEffortRank(runtimeSet.primary)) {
    throw new TypeError(
      "fast mode escalation runtime cannot use lower effort than primary",
    );
  }
  return runtimeSet;
}

export function windowOptionsForRunMode(
  mode: TranslationRuntimeSet["mode"],
  requested: WindowPlanOptions = {},
): WindowPlanOptions {
  if (mode === "quality") return { ...requested };
  const maxSourceTokens = requested.maxSourceTokens ?? FAST_MAX_SOURCE_TOKENS;
  return {
    ...requested,
    targetSourceTokens: requested.targetSourceTokens
      ?? Math.min(FAST_TARGET_SOURCE_TOKENS, maxSourceTokens),
    maxSourceTokens,
    maxBlocks: requested.maxBlocks ?? FAST_MAX_BLOCKS,
  };
}

const RUNTIME_EFFORT_RANK = new Map<string, number>([
  ["off", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["on", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
]);

const CONTEXT_PROFILE_ORDER = [
  "lean",
  "balanced",
  "rich",
] as const satisfies readonly ContextProfileName[];
const TRANSLATION_VALIDATORS = [
  "structure",
  "terminology",
  "cross_block",
  "knowledge_coverage",
] as const;

interface DynamicRequestPlanning {
  readonly input: RollingPlannerInput;
  readonly executionsByVariantId: ReadonlyMap<
    string,
    PlannedTranslationExecution
  >;
  readonly legacyByTaskId: ReadonlyMap<string, PlannedTranslationExecution>;
  readonly baselineVariantByTaskId: ReadonlyMap<string, TaskExecutionVariant>;
  readonly baselineWallTimeMs: number;
  readonly baselineTokens: number;
}

export function schedulableTranslationExecutions(
  refreshedExecutions: ReadonlyMap<string, PlannedTranslationExecution>,
  legacyByTaskId: ReadonlyMap<string, PlannedTranslationExecution>,
  pendingTaskIds: ReadonlySet<string>,
): ReadonlyMap<string, PlannedTranslationExecution> {
  const schedulable = new Map(refreshedExecutions);
  for (const taskId of pendingTaskIds) {
    const legacy = legacyByTaskId.get(taskId);
    if (legacy !== undefined && !schedulable.has(legacy.variant.variantId)) {
      schedulable.set(legacy.variant.variantId, legacy);
    }
  }
  return schedulable;
}

function runtimeEffort(runtime: TranslationRuntime): string {
  return runtime.effort ?? runtime.thinkingLevel ?? "high";
}

function runtimeEffortRank(runtime: TranslationRuntime): number {
  return RUNTIME_EFFORT_RANK.get(runtimeEffort(runtime)) ?? 4;
}

function contextProfileRank(profile: ContextProfileName): number {
  return CONTEXT_PROFILE_ORDER.indexOf(profile);
}

function requestBlocks(
  request: PhysicalRequestPlan,
  blockById: ReadonlyMap<string, LosslessBlock>,
): readonly LosslessBlock[] {
  return request.windows.flatMap((window) => window.blockIds.map((blockId) => {
    const block = blockById.get(blockId);
    if (block === undefined) {
      throw new Error(`translation request references unknown block ${blockId}`);
    }
    return block;
  }));
}

function sourceAnomaliesForRequest(
  request: PhysicalRequestPlan,
  report: SourceAnomalyReport,
  blockById: ReadonlyMap<string, LosslessBlock>,
): number {
  const blocks = requestBlocks(request, blockById);
  const sampledGlobalCount = report.findings.flatMap((finding) =>
    finding.samples)
    .filter((sample) => blocks.some((block) =>
      sample.scalarStart < block.canonicalEnd
      && sample.scalarEnd > block.canonicalStart))
    .length;
  const localReport = analyzeSourceAnomalies(
    blocks.map((block) => block.sourceText).join("\n"),
  );
  const localCount = Object.values(localReport.counts).reduce(
    (total, count) => total + count,
    0,
  );
  return Math.max(sampledGlobalCount, localCount);
}

function countLiteralOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function lockedTermOccurrences(
  sourceTexts: readonly string[],
  terms: readonly StableTerm[],
): number {
  const source = sourceTexts.join("\n").toLocaleLowerCase("und");
  return terms
    .filter((term) => term.locked)
    .reduce((total, term) =>
      total + countLiteralOccurrences(
        source,
        term.sourceForm.toLocaleLowerCase("und"),
      ), 0);
}

function relationKindsForCandidates(
  candidates: readonly TranslationKnowledgeCandidate[],
): readonly TaskRelationKind[] {
  const result = new Set<TaskRelationKind>();
  for (const dimension of candidates.flatMap((candidate) =>
    candidate.coverage)) {
    switch (dimension) {
      case "entity_identity":
        result.add("identity");
        break;
      case "part_whole":
        result.add("part_of");
        break;
      case "control":
      case "causality":
      case "timeline":
      case "viewpoint":
      case "character_knowledge":
        result.add(dimension);
        break;
      case "pronoun_resolution":
        break;
    }
  }
  return [...result];
}

function contextBudgets(
  candidates: readonly TranslationKnowledgeCandidate[],
): Readonly<Record<ContextProfileName, number>> {
  const total = candidates.reduce(
    (sum, candidate) => sum + candidate.tokenCost,
    0,
  );
  const mandatory = candidates
    .filter((candidate) => candidate.mandatory)
    .reduce((sum, candidate) => sum + candidate.tokenCost, 0);
  const optional = Math.max(0, total - mandatory);
  return {
    lean: mandatory + Math.floor(optional * 0.25),
    balanced: mandatory + Math.floor(optional * 0.6),
    rich: total,
  };
}

interface TranslationContextPlan {
  readonly candidates: readonly TranslationKnowledgeCandidate[];
  readonly profiles: Readonly<Record<
    ContextProfileName,
    ContextProfile | undefined
  >>;
  readonly risk: TaskRiskAssessment;
}

function translationContextPlan(
  request: PhysicalRequestPlan,
  baseInput: TranslationRequestInput,
  priorRepairs: number,
  sourceAnomalyReport: SourceAnomalyReport,
  blockById: ReadonlyMap<string, LosslessBlock>,
): TranslationContextPlan {
  const blocks = requestBlocks(request, blockById);
  const sourceTexts = blocks.map((block) => block.sourceText);
  const profile = baseInput.sourceLanguageProfile;
  if (profile === undefined) {
    throw new TypeError("dynamic translation planning requires a language profile");
  }
  const windowByBlockId = new Map(request.windows.flatMap((window) =>
    window.blockIds.map((blockId) => [blockId, window.windowId] as const)));
  const candidates = collectTranslationKnowledgeCandidates(
    baseInput.snapshot.revisions,
    sourceTexts,
    profile,
    {
      corpusBlocks: baseInput.blocks.map((block) => ({
        blockId: block.id,
        globalIndex: block.globalIndex,
      })),
      currentBlocks: blocks.map((block) => ({
        blockId: block.id,
        globalIndex: block.globalIndex,
        windowId: windowByBlockId.get(block.id) as string,
      })),
    },
  );
  const risk = assessTaskRisk({
    sourceTokens: request.sourceTokens,
    entityMentions: candidates.filter((candidate) =>
      candidate.kind === "entity").length,
    pronounMentions: candidates.some((candidate) =>
      candidate.coverage.includes("pronoun_resolution")) ? 4 : 0,
    relationKinds: relationKindsForCandidates(candidates),
    remoteEvidenceDistance: candidates.reduce(
      (maximum, candidate) =>
        Math.max(maximum, candidate.evidenceDistance ?? 0),
      0,
    ),
    lockedTermOccurrences: lockedTermOccurrences(
      sourceTexts,
      baseInput.stableTerms,
    ),
    needsRevalidate: candidates.some((candidate) => candidate.mandatory),
    priorRepairs,
    sourceAnomalies: sourceAnomaliesForRequest(
      request,
      sourceAnomalyReport,
      blockById,
    ),
  });
  return {
    candidates,
    profiles: planContextProfiles({
      bundles: candidates,
      requiredCoverage: risk.requiredCoverage,
      budgets: contextBudgets(candidates),
      maxEntries: DEFAULT_TRANSLATION_KNOWLEDGE_MAX_ENTRIES,
    }),
    risk,
  };
}

function revisionIdsForProfile(
  profile: ContextProfile,
  candidates: readonly TranslationKnowledgeCandidate[],
): readonly string[] {
  const byBundleId = new Map(candidates.map((candidate) => [
    candidate.bundleId,
    candidate,
  ]));
  return [...new Set(profile.bundleIds.flatMap((bundleId) => {
    const candidate = byBundleId.get(bundleId);
    if (candidate === undefined) {
      throw new Error(`context profile references unknown bundle ${bundleId}`);
    }
    return candidate.revisionIds;
  }))].sort((left, right) => left.localeCompare(right, "en"));
}

function baselineVariantForTask(
  item: AdmittedTranslationRequest<TranslationRequestInput>,
  options: {
    readonly runtime: TranslationRuntime;
    readonly risk: TaskRiskAssessment;
    readonly costModel: OnlineRuntimeCostModel;
    readonly maxConcurrency: number;
  },
): {
  readonly features: RuntimeFeatures;
  readonly variant: TaskExecutionVariant;
} {
  const protocol = item.fragments[0]?.input.responseProtocol ?? "typed_tool";
  const features: RuntimeFeatures = {
    inputTokens: item.fragments.reduce(
      (total, fragment) => total + fragment.assessment.inputTokens,
      0,
    ),
    outputTokens: item.fragments.reduce(
      (total, fragment) => total + fragment.assessment.outputTokens,
      0,
    ),
    sourceTokens: item.request.sourceTokens,
    effortRank: runtimeEffortRank(options.runtime),
    cacheHitRatio: 0,
    concurrency: options.maxConcurrency,
    batchWindows: item.request.windows.length,
    riskScore: options.risk.score,
    protocolRank: protocol === "typed_tool" ? 1 : 0,
  };
  const fragmentPredictions = item.fragments.map((fragment) => {
    const predicted = options.costModel.predict({
      ...features,
      inputTokens: fragment.assessment.inputTokens,
      outputTokens: fragment.assessment.outputTokens,
      sourceTokens: fragment.request.sourceTokens,
      batchWindows: fragment.request.windows.length,
    });
    return {
      ...predicted,
      totalTokens: Math.max(
        predicted.totalTokens,
        fragment.assessment.totalReserved,
      ),
    };
  });
  const predicted = {
    p50DurationMs: fragmentPredictions.reduce(
      (total, prediction) => total + prediction.p50DurationMs,
      0,
    ),
    p90DurationMs: fragmentPredictions.reduce(
      (total, prediction) => total + prediction.p90DurationMs,
      0,
    ),
    inputTokens: fragmentPredictions.reduce(
      (total, prediction) => total + prediction.inputTokens,
      0,
    ),
    outputTokens: fragmentPredictions.reduce(
      (total, prediction) => total + prediction.outputTokens,
      0,
    ),
    totalTokens: fragmentPredictions.reduce(
      (total, prediction) => total + prediction.totalTokens,
      0,
    ),
    failureProbability: 1 - fragmentPredictions.reduce(
      (success, prediction) =>
        success * (1 - prediction.failureProbability),
      1,
    ),
    confidence: fragmentPredictions.reduce(
      (minimum, prediction) => Math.min(minimum, prediction.confidence),
      1,
    ),
  };
  return {
    features,
    variant: {
      variantId: `${item.request.requestId}:baseline`,
      taskId: item.request.requestId,
      contextProfile: "rich",
      effort: runtimeEffort(options.runtime),
      effortRank: features.effortRank,
      protocol,
      validators: TRANSLATION_VALIDATORS,
      predicted,
    },
  };
}

function planningRuntimes(
  runtimeSet: TranslationRuntimeSet,
  executionRuntime: TranslationRuntime,
  retryRound: number,
): readonly TranslationRuntime[] {
  const variants = validateRuntimeVariants([
    executionRuntime,
    ...(runtimeSet.variants ?? []),
    runtimeSet.escalation,
  ]);
  if (retryRound === 0) return variants;
  const minimumRank = runtimeEffortRank(executionRuntime);
  return variants.filter((runtime) =>
    runtimeEffortRank(runtime) >= minimumRank);
}

export function planningProtocols(
  originalProtocol: "typed_tool" | "framed_text",
  retryRound: number,
): readonly ("typed_tool" | "framed_text")[] {
  if (originalProtocol === "framed_text") return ["framed_text"];
  return retryRound === 0
    ? ["typed_tool", "framed_text"]
    : ["typed_tool"];
}

export function translationBaselineTaskId(windowId: string): string {
  return `translate-window:${windowId}`;
}

function dynamicRequestPlanning(
  requests: readonly PhysicalRequestPlan[],
  legacyRequests: readonly AdmittedTranslationRequest<TranslationRequestInput>[],
  options: {
    readonly runtimeSet: TranslationRuntimeSet;
    readonly executionRuntime: TranslationRuntime;
    readonly mode: SchedulerMode;
    readonly buildBaseInput: (
      request: PhysicalRequestPlan,
    ) => TranslationRequestInput;
    readonly estimator: WeightedTokenEstimator;
    readonly sourceAnomalyReport: SourceAnomalyReport;
    readonly blockById: ReadonlyMap<string, LosslessBlock>;
    readonly snapshotId: string;
    readonly retryRound: number;
    readonly costModel: OnlineRuntimeCostModel;
    readonly profile: OptimizationProfile;
    readonly cumulativeBaselineTokens: number;
    readonly actualRunTokens: number;
    readonly maxConcurrency: number;
    readonly maxInFlightTokens: number;
  },
): DynamicRequestPlanning {
  const legacyByTaskId = new Map<string, PlannedTranslationExecution>();
  const executionsByVariantId = new Map<string, PlannedTranslationExecution>();
  const variants: TaskExecutionVariant[] = [];
  const baselineVariants: TaskExecutionVariant[] = [];
  const baselineVariantByTaskId = new Map<string, TaskExecutionVariant>();
  const legacyRequestById = new Map(legacyRequests.map((item) => [
    item.request.requestId,
    item,
  ]));
  const runtimes = options.mode === "off"
    ? [options.executionRuntime]
    : planningRuntimes(
      options.runtimeSet,
      options.executionRuntime,
      options.retryRound,
    );

  const tasks: SchedulerTask[] = requests.map((request, ordinal) => {
    const baseInput = options.buildBaseInput(request);
    const contextPlan = options.mode === "off"
      ? undefined
      : translationContextPlan(
        request,
        baseInput,
        options.retryRound,
        options.sourceAnomalyReport,
        options.blockById,
      );
    const risk = contextPlan === undefined
      ? assessTaskRisk({
        sourceTokens: request.sourceTokens,
        entityMentions: 0,
        pronounMentions: 0,
        relationKinds: [],
        remoteEvidenceDistance: 0,
        lockedTermOccurrences: 0,
        needsRevalidate: false,
        priorRepairs: options.retryRound,
        sourceAnomalies: 0,
      })
      : contextPlan.risk;
    const legacy = legacyRequestById.get(request.requestId);
    if (legacy === undefined) {
      throw new Error(`missing baseline admission for ${request.requestId}`);
    }
    const baseline = baselineVariantForTask(legacy, {
      runtime: options.executionRuntime,
      risk,
      costModel: options.costModel,
      maxConcurrency: options.maxConcurrency,
    });
    const escalationIsDistinct =
      options.executionRuntime.model !== options.runtimeSet.escalation.model
      || options.executionRuntime.streamFn !== options.runtimeSet.escalation.streamFn
      || options.executionRuntime.effort !== options.runtimeSet.escalation.effort
      || options.executionRuntime.thinkingLevel
        !== options.runtimeSet.escalation.thinkingLevel;
    const baselineExecutionVariant = baseline.variant;
    let mandatoryBaselineVariant: TaskExecutionVariant = {
      ...baselineExecutionVariant,
      predicted: {
        ...baselineExecutionVariant.predicted,
        totalTokens:
          baselineExecutionVariant.predicted.totalTokens
          + legacy.paragraphRecoveryReserveTokens
          + legacy.targetedRepairReserveTokens
          + legacy.paragraphRefinementReserveTokens,
      },
    };
    if (options.retryRound === 0 && escalationIsDistinct) {
      const escalationAdmission = admitTranslationRequests(
        [request],
        options.runtimeSet.escalation,
        options.estimator,
        options.blockById,
        options.buildBaseInput,
      )[0];
      if (escalationAdmission === undefined) {
        throw new Error(`missing escalation baseline for ${request.requestId}`);
      }
      const escalationBaseline = baselineVariantForTask(
        escalationAdmission,
        {
          runtime: options.runtimeSet.escalation,
          risk,
          costModel: options.costModel,
          maxConcurrency: options.maxConcurrency,
        },
      );
      mandatoryBaselineVariant = {
        ...baseline.variant,
        predicted: {
          ...baseline.variant.predicted,
          p50DurationMs: Math.max(
            baseline.variant.predicted.p50DurationMs,
            escalationBaseline.variant.predicted.p50DurationMs,
          ),
          p90DurationMs: Math.max(
            baseline.variant.predicted.p90DurationMs,
            escalationBaseline.variant.predicted.p90DurationMs,
          ),
          inputTokens: Math.max(
            baseline.variant.predicted.inputTokens,
            escalationBaseline.variant.predicted.inputTokens,
          ),
          outputTokens: Math.max(
            baseline.variant.predicted.outputTokens,
            escalationBaseline.variant.predicted.outputTokens,
          ),
          totalTokens: Math.max(
            mandatoryBaselineVariant.predicted.totalTokens,
            escalationBaseline.variant.predicted.totalTokens
              + escalationAdmission.paragraphRecoveryReserveTokens
              + escalationAdmission.targetedRepairReserveTokens
              + escalationAdmission.paragraphRefinementReserveTokens,
          ),
          failureProbability: Math.max(
            baseline.variant.predicted.failureProbability,
            escalationBaseline.variant.predicted.failureProbability,
          ),
          confidence: Math.min(
            baseline.variant.predicted.confidence,
            escalationBaseline.variant.predicted.confidence,
          ),
        },
      };
    }
    baselineVariants.push(mandatoryBaselineVariant);
    baselineVariantByTaskId.set(request.requestId, mandatoryBaselineVariant);
    legacyByTaskId.set(request.requestId, {
      admitted: legacy,
      runtime: options.executionRuntime,
      buildInput: options.buildBaseInput,
      features: baseline.features,
      variant: baselineExecutionVariant,
    });

    if (contextPlan === undefined) {
      return {
        taskId: request.requestId,
        type: "translate",
        ordinal: request.windows[0]?.ordinal ?? ordinal,
        dependencyIds: [],
        readResources: [`snapshot:${options.snapshotId}`],
        writeResources: request.windows.map((window) =>
          `window:${window.windowId}`),
        sourceTokens: request.sourceTokens,
        risk,
      };
    }

    const originalProtocol = baseInput.responseProtocol ?? "typed_tool";
    const protocols = planningProtocols(
      originalProtocol,
      options.retryRound,
    );
    for (const profileName of CONTEXT_PROFILE_ORDER) {
      const selectedProfile = contextPlan.profiles[profileName];
      if (selectedProfile === undefined
        || contextProfileRank(profileName)
          < contextProfileRank(risk.minimumContextProfile)) {
        continue;
      }
      const buildSelectedInput = (
        selectedRequest: PhysicalRequestPlan,
        protocol: "typed_tool" | "framed_text",
      ): TranslationRequestInput => {
        const selectedBase = options.buildBaseInput(selectedRequest);
        const selectedPlan = selectedRequest === request
          ? contextPlan
          : translationContextPlan(
            selectedRequest,
            selectedBase,
            options.retryRound,
            options.sourceAnomalyReport,
            options.blockById,
          );
        const profile = selectedPlan.profiles[profileName];
        if (profile === undefined) {
          throw new RangeError(
            `${profileName} context is infeasible for ${selectedRequest.requestId}`,
          );
        }
        return {
          ...selectedBase,
          selectedKnowledgeRevisionIds: revisionIdsForProfile(
            profile,
            selectedPlan.candidates,
          ),
          contextProfileName: profileName,
          responseProtocol: protocol,
        };
      };
      for (const [runtimeIndex, runtime] of runtimes.entries()) {
        for (const protocol of protocols) {
          const buildInput = (selectedRequest: PhysicalRequestPlan) =>
            buildSelectedInput(selectedRequest, protocol);
          const admitted = admitTranslationRequests(
            [request],
            runtime,
            options.estimator,
            options.blockById,
            buildInput,
          )[0];
          if (admitted === undefined
            || admitted.fragments.some((fragment) =>
              !fragment.assessment.fits
              || fragment.assessment.totalReserved
                > options.maxInFlightTokens)) {
            continue;
          }
          const assessedInputTokens = admitted.fragments.reduce(
            (total, fragment) => total + fragment.assessment.inputTokens,
            0,
          );
          const assessedOutputTokens = admitted.fragments.reduce(
            (total, fragment) => total + fragment.assessment.outputTokens,
            0,
          );
          const assessedTotalTokens = admitted.fragments.reduce(
            (total, fragment) => total + fragment.assessment.totalReserved,
            0,
          );
          const features: RuntimeFeatures = {
            inputTokens: assessedInputTokens,
            outputTokens: assessedOutputTokens,
            sourceTokens: request.sourceTokens,
            effortRank: runtimeEffortRank(runtime),
            cacheHitRatio: 0,
            concurrency: options.maxConcurrency,
            batchWindows: request.windows.length,
            riskScore: risk.score,
            protocolRank: protocol === "typed_tool" ? 1 : 0,
          };
          const rawPrediction = options.costModel.predict(features);
          const variant: TaskExecutionVariant = {
            variantId: [
              request.requestId,
              `context-${profileName}`,
              `runtime-${runtimeIndex}`,
              `effort-${String(features.effortRank).padStart(2, "0")}`,
              `protocol-${protocol}`,
            ].join(":"),
            taskId: request.requestId,
            contextProfile: profileName,
            effort: runtimeEffort(runtime),
            effortRank: features.effortRank,
            protocol,
            validators: TRANSLATION_VALIDATORS,
            predicted: {
              ...rawPrediction,
              totalTokens: Math.max(
                rawPrediction.totalTokens,
                assessedTotalTokens,
              ),
            },
          };
          const execution: PlannedTranslationExecution = {
            admitted,
            runtime,
            buildInput,
            features,
            variant,
          };
          variants.push(variant);
          executionsByVariantId.set(variant.variantId, execution);
        }
      }
    }
    return {
      taskId: request.requestId,
      type: "translate",
      ordinal: request.windows[0]?.ordinal ?? ordinal,
      dependencyIds: [],
      readResources: [`snapshot:${options.snapshotId}`],
      writeResources: request.windows.map((window) =>
        `window:${window.windowId}`),
      sourceTokens: request.sourceTokens,
      risk,
    };
  });
  const horizonBaselineTokens = baselineVariants.reduce(
    (total, variant) => total + variant.predicted.totalTokens,
    0,
  );
  const baselineWallTimeMs = baselineVariants.reduce(
    (total, variant) => total + variant.predicted.p90DurationMs,
    0,
  );
  return {
    input: {
      graph: buildTaskGraph(tasks),
      completedTaskIds: [],
      running: [],
      variants,
      policy: optimizationPolicy(options.profile),
      runBaselineTotalTokens:
        options.cumulativeBaselineTokens
        + (options.retryRound === 0 ? horizonBaselineTokens : 0),
      actualRunTokens: options.actualRunTokens,
      runningReservedTokens: 0,
      horizonBaselineTokens,
      maxConcurrency: options.maxConcurrency,
      maxInFlightTokens: options.maxInFlightTokens,
    },
    executionsByVariantId,
    legacyByTaskId,
    baselineVariantByTaskId,
    baselineWallTimeMs,
    baselineTokens: horizonBaselineTokens,
  };
}

async function runWithAdaptiveScheduler<TInput, TOutput>(
  items: readonly AdmittedTranslationRequest<TInput>[],
  scheduler: AdaptiveScheduler,
  worker: (
    item: AdmittedTranslationRequest<TInput>,
  ) => Promise<ScheduledResult<TOutput>>,
  signal?: AbortSignal,
): Promise<TOutput[]> {
  const pending = [...items];
  const running = new Set<Promise<void>>();
  const completed: TOutput[] = [];
  while (pending.length > 0 || running.size > 0) {
    throwIfAborted(signal);
    let admittedAny = false;
    for (let index = 0; index < pending.length;) {
      const item = pending[index] as AdmittedTranslationRequest<TInput>;
      const permit = scheduler.tryAcquire(item.assessment.totalReserved);
      if (permit === undefined) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      admittedAny = true;
      const startedAt = performance.now();
      let task: Promise<void>;
      task = (async () => {
        const result = await worker(item);
        completed.push(result.value);
        scheduler.observe({
          status: result.status,
          durationMs: performance.now() - startedAt,
          estimatedTokens: item.assessment.totalReserved,
        });
      })().finally(() => {
        permit.release();
        running.delete(task);
      });
      running.add(task);
    }
    if (running.size === 0 && pending.length > 0) {
      const smallest = Math.min(...pending.map((item) => item.assessment.totalReserved));
      throw new RangeError(
        `maxInFlightTokens cannot admit the smallest request reservation (${smallest})`,
      );
    }
    if (running.size > 0 && (!admittedAny || pending.length === 0)) {
      await Promise.race(running);
    }
  }
  return completed;
}

interface RunningTranslation<T> {
  readonly execution: PlannedTranslationExecution;
  readonly promise: Promise<void>;
  readonly startedAt: number;
  readonly reservedTokens: number;
}

async function runWithDynamicScheduler<T>(
  planning: DynamicRequestPlanning,
  scheduler: AdaptiveScheduler,
  dynamicScheduler: DynamicScheduler,
  worker: (
    execution: PlannedTranslationExecution,
  ) => Promise<ScheduledResult<T>>,
  options: {
    readonly actualRunTokens: () => number;
    readonly decision: () => {
      readonly decisionId: string;
      readonly runId: string;
      readonly createdAt: string;
    };
    readonly onDecision: (report: SchedulerDispatchReport) => void;
    readonly canLaunch?: (execution: PlannedTranslationExecution) => boolean;
    readonly onLaunch: (execution: PlannedTranslationExecution) => void;
    readonly onComplete: (
      value: T,
      execution: PlannedTranslationExecution,
    ) => void;
    readonly tokenGate?: "internal" | "external";
    readonly signal?: AbortSignal;
  },
): Promise<T[]> {
  const tokenGate = options.tokenGate ?? "internal";
  const taskOrder = planning.input.graph.tasks.map((task) => task.taskId);
  const pending = new Set(taskOrder);
  const completedTaskIds = new Set<string>();
  const running = new Map<string, RunningTranslation<T>>();
  const completed: T[] = [];

  try {
  while (pending.size > 0 || running.size > 0) {
    throwIfAborted(options.signal);
    if (pending.size > 0) {
      const now = performance.now();
      const reservations: RunningTaskReservation[] = [...running.entries()]
        .map(([taskId, item]) => ({
          taskId,
          variantId: item.execution.variant.variantId,
          remainingP90DurationMs: Math.max(
            0,
            item.execution.variant.predicted.p90DurationMs
              - (now - item.startedAt),
          ),
          reservedTokens: item.reservedTokens,
        }));
      const runningReservedTokens = reservations.reduce(
        (total, reservation) => total + reservation.reservedTokens,
        0,
      );
      const horizonBaselineTokens = [...pending].reduce((total, taskId) =>
        total + (
          planning.legacyByTaskId.get(taskId)?.variant.predicted.totalTokens
            ?? 0
        ), 0);
      const refreshedExecutions = new Map(
        [...planning.executionsByVariantId].map(([variantId, execution]) => {
          const predicted = dynamicScheduler.costModel.predict(
            execution.features,
          );
          return [variantId, {
            ...execution,
            variant: {
              ...execution.variant,
              predicted: {
                ...predicted,
                totalTokens: Math.max(
                  predicted.totalTokens,
                  execution.admitted.assessment.totalReserved,
                ),
              },
            },
          }] as const;
        }),
      );
      // Context profile packing can be infeasible even when the fully
      // validated rich baseline request is provider- and risk-legal. Keep
      // that execution inside the planner candidate set so it goes through
      // the same risk, in-flight, and token-envelope gates instead of turning
      // a legal final task into NO_LEGAL_PLAN.
      const schedulableExecutions = schedulableTranslationExecutions(
        refreshedExecutions,
        planning.legacyByTaskId,
        pending,
      );
      // Congestion sensor owns recommended concurrency; token envelope is
      // external (ledger) when tokenGate is external.
      const adaptiveConcurrency = scheduler.snapshot().concurrency;
      const report = dynamicScheduler.dispatch(
        {
          ...planning.input,
          variants: [...schedulableExecutions.values()].map((execution) =>
            execution.variant),
          completedTaskIds: [...completedTaskIds],
          running: reservations,
          actualRunTokens: options.actualRunTokens(),
          runningReservedTokens,
          horizonBaselineTokens,
          maxConcurrency: Math.max(adaptiveConcurrency, reservations.length),
        },
        {
          legacyTaskIds: taskOrder.filter((taskId) => pending.has(taskId)),
          legacyVariants: taskOrder
            .filter((taskId) => pending.has(taskId))
            .map((taskId) => planning.legacyByTaskId.get(taskId)?.variant)
            .filter((variant): variant is TaskExecutionVariant =>
              variant !== undefined),
          decision: options.decision(),
        },
      );
      options.onDecision(report);

      const dispatches: readonly PlannedTaskDispatch[] =
        report.planningStatus === "fallback"
          ? report.dispatchedTaskIds.map((taskId) => ({
            taskId,
            variantId: "",
          }))
          : report.dispatchedVariants;
      let launched = 0;
      for (const dispatch of dispatches) {
        if (!pending.has(dispatch.taskId)) continue;
        const execution = report.planningStatus === "fallback"
          ? planning.legacyByTaskId.get(dispatch.taskId)
          : schedulableExecutions.get(dispatch.variantId);
        if (execution === undefined) {
          throw new Error(
            `scheduler selected unknown translation variant ${dispatch.variantId}`,
          );
        }
        if (options.canLaunch !== undefined && !options.canLaunch(execution)) {
          continue;
        }
        const permit = scheduler.tryAcquire(
          execution.admitted.assessment.totalReserved,
          { tokenGate },
        );
        if (permit === undefined) continue;

        pending.delete(dispatch.taskId);
        try {
          options.onLaunch(execution);
        } catch (error) {
          permit.release();
          pending.add(dispatch.taskId);
          throw error;
        }
        const startedAt = performance.now();
        let promise: Promise<void>;
        promise = (async () => {
          const result = await worker(execution);
          completed.push(result.value);
          completedTaskIds.add(dispatch.taskId);
          scheduler.observe({
            status: result.status,
            durationMs: performance.now() - startedAt,
            estimatedTokens: execution.admitted.assessment.totalReserved,
          });
          options.onComplete(result.value, execution);
        })().finally(() => {
          permit.release();
          running.delete(dispatch.taskId);
        });
        running.set(dispatch.taskId, {
          execution,
          promise,
          startedAt,
          reservedTokens: execution.variant.predicted.totalTokens,
        });
        launched += 1;
      }
      if (launched > 0) {
        await Promise.race([...running.values()].map((item) => item.promise));
        continue;
      }
      if (running.size === 0 && pending.size > 0) {
        const firstPendingTaskId = taskOrder.find((taskId) =>
          pending.has(taskId));
        const firstPendingExecution = firstPendingTaskId === undefined
          ? undefined
          : planning.legacyByTaskId.get(firstPendingTaskId)
            ?? [...planning.executionsByVariantId.values()].find(
              (item) => item.admitted.request.requestId === firstPendingTaskId,
            );
        const minimumPendingTokens = firstPendingExecution === undefined
          ? Number.POSITIVE_INFINITY
          : firstPendingExecution.variant.predicted.totalTokens;
        const minimumPlannedTokens = Math.min(
          ...[...schedulableExecutions.values()]
            .filter((execution) =>
              execution.admitted.request.requestId === firstPendingTaskId)
            .map((execution) => execution.variant.predicted.totalTokens),
        );
        const actualTokens = options.actualRunTokens();
        const allowedTokens = Math.floor(
          planning.input.runBaselineTotalTokens
            * (1 + planning.input.policy.tokenIncreaseCap),
        );
        const blockedByEnvelope = firstPendingExecution !== undefined
          && options.canLaunch !== undefined
          && !options.canLaunch(firstPendingExecution);
        const noLegalPlan = report.planningStatus === "fallback"
          && report.fallbackReason === "NO_LEGAL_PLAN"
          && report.dispatchedTaskIds.length === 0;
        const noLegalPlanExhaustsEnvelope = noLegalPlan
          && Number.isFinite(minimumPlannedTokens)
          && actualTokens + runningReservedTokens + minimumPlannedTokens
            > allowedTokens;
        if (noLegalPlanExhaustsEnvelope
          || blockedByEnvelope
          || (report.planningStatus === "fallback"
            && report.dispatchedTaskIds.length === 0
            && Number.isFinite(minimumPendingTokens)
            && actualTokens + runningReservedTokens + minimumPendingTokens
              > allowedTokens)) {
          const reportedMinimum = noLegalPlanExhaustsEnvelope
            ? minimumPlannedTokens
            : minimumPendingTokens;
          throw new BookTokenEnvelopeExceededError(
            actualTokens,
            runningReservedTokens,
            Number.isFinite(reportedMinimum) ? reportedMinimum : 0,
            allowedTokens,
          );
        }
        if (noLegalPlan) {
          throw new BookNoLegalPlanError(
            actualTokens,
            runningReservedTokens,
            allowedTokens,
            pending.size,
          );
        }
      }
    }

    if (running.size === 0) {
      const smallest = Math.min(...[...pending].map((taskId) =>
        planning.legacyByTaskId.get(taskId)?.admitted.assessment.totalReserved
          ?? Number.POSITIVE_INFINITY));
      throw new RangeError(
        `maxInFlightTokens cannot admit the smallest request reservation (${smallest})`,
      );
    }
    await Promise.race([...running.values()].map((item) => item.promise));
  }
  return completed;
  } finally {
    if (running.size > 0) {
      await Promise.allSettled(
        [...running.values()].map((item) => item.promise),
      );
    }
  }
}

async function runLosslessBook(
  options: LosslessBookRunOptions,
): Promise<LosslessBookRunResult> {
  const startedAt = performance.now();
  const runtimeSet = normalizeRuntimeSet(options);
  const schedulerMode = options.schedulerMode ?? "off";
  if (schedulerMode !== "off"
    && schedulerMode !== "shadow"
    && schedulerMode !== "active") {
    throw new TypeError(`unsupported scheduler mode: ${String(schedulerMode)}`);
  }
  const optimizationProfile = options.optimizationProfile
    ?? profileFromLegacyRunMode(runtimeSet.mode);
  const selectedOptimizationPolicy = optimizationPolicy(
    optimizationProfile,
  );
  const maxWindows = nonNegativeInteger(
    options.maxWindows ?? Number.MAX_SAFE_INTEGER,
    "maxWindows",
  );
  const maxConcurrency = positiveInteger(
    options.maxConcurrency ?? (runtimeSet.mode === "fast" ? 4 : DEFAULT_MAX_CONCURRENCY),
    "maxConcurrency",
  );
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const tinyWindowTokens = positiveInteger(
    options.tinyWindowTokens ?? 128,
    "tinyWindowTokens",
  );
  const maxRequestTokens = positiveInteger(
    options.maxRequestTokens
      ?? (runtimeSet.mode === "fast" ? FAST_MAX_SOURCE_TOKENS : 3_200),
    "maxRequestTokens",
  );
  const maxWindowsPerRequest = positiveInteger(
    options.maxWindowsPerRequest ?? 4,
    "maxWindowsPerRequest",
  );
  const maxInFlightTokens = positiveInteger(
    options.maxInFlightTokens ?? Math.min(
      runtimeSet.primary.model.contextWindow * maxConcurrency,
      256_000,
    ),
    "maxInFlightTokens",
  );
  const runId = requiredIdentifier(options.runMeta.runId, "runMeta.runId");
  const protocolVersion = requiredIdentifier(
    options.runMeta.protocolVersion,
    "runMeta.protocolVersion",
  );

  // Opening the certified ledger and running the independent coverage audit is
  // deliberately the first source operation. No provider call is reachable
  // before this doctor gate succeeds.
  const context = BookContext.openLossless({
    manifestPath: options.manifestPath,
    ...(options.legacyV4DbPath === undefined
      ? {}
      : { legacyV4DbPath: options.legacyV4DbPath }),
  });
  const sourceAnomalyReport = analyzeSourceAnomalies(
    context.sourceLedger.sourceText,
  );
  const glossaryExpectedSourceVersion = context.sourceLedger.sourceVersion;
  if (options.glossary?.sourceVersion !== undefined
    && options.glossary.sourceVersion !== glossaryExpectedSourceVersion) {
    context.close();
    throw new Error(
      `glossary snapshot source version mismatch: expected ${glossaryExpectedSourceVersion}, found ${options.glossary.sourceVersion}`,
    );
  }
  const modelId = options.runMeta.modelId ?? runtimeSet.primary.model.id;
  if (modelId !== runtimeSet.primary.model.id) {
    context.close();
    throw new Error(
      `run model mismatch: metadata declares ${modelId}, provider model is ${runtimeSet.primary.model.id}`,
    );
  }
  mkdirSync(dirname(resolve(options.storePath)), { recursive: true });
  let lease: ReturnType<typeof RunLease.acquire>;
  try {
    lease = RunLease.acquire(
      `${resolve(options.storePath)}.run.lock`,
      `lossless:${runId}`,
    );
  } catch (error) {
    context.close();
    throw error;
  }
  let store: LosslessBookStore;
  try {
    store = new LosslessBookStore(options.storePath);
  } catch (error) {
    lease.release();
    context.close();
    throw isStorageLocked(error) ? new BookStorageIncidentError(error) : error;
  }
  const waves: BookWaveReport[] = [];
  let processedWindows = 0;
  const schedulerMetrics = {
    mode: schedulerMode,
    profile: optimizationProfile,
    planningStatus: (
      schedulerMode === "off"
        ? "disabled"
        : schedulerMode === "shadow"
          ? "shadow"
          : "optimal"
    ) as SchedulerRunReport["planningStatus"],
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
    contextProfiles: {} as Record<
      string,
      "lean" | "balanced" | "rich"
    >,
    effortCounts: {} as Record<string, number>,
    protocolCounts: {
      typed_tool: 0,
      framed_text: 0,
      local: 0,
    },
    plannerDeadlines: 0,
    throttles: 0,
    recoveries: 0,
  };
  let flushSchedulerProjection: (() => void) | undefined;
  let reconcileOpenLedgerAttempts: (() => void) | undefined;
  let tokenLedgerForReconciliation: TokenLedger | undefined;

  try {
    store.registerSource(context.certifiedSource as NonNullable<typeof context.certifiedSource>);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      blocks: context.losslessBlocks,
      annotations: context.annotations,
    });
    const initialSnapshot = createKnowledgeSnapshot(runId, []);
    const requestedMetadata = runMetadataWithLanguageProfile(
      options.runMeta.metadata,
      context,
      runtimeSet,
    );
    const existingRun = store.listTranslationRuns().find((item) => item.runId === runId);
    const existingRuntimeMetadata = runtimeMetadata(existingRun?.metadata);
    if (existingRun !== undefined) {
      if (existingRuntimeMetadata === undefined && runtimeSet.mode !== "quality") {
        throw new Error("legacy translation runs can only resume in quality mode");
      }
      if (existingRuntimeMetadata !== undefined
        && canonicalJson(existingRuntimeMetadata) !== canonicalJson(
          runtimeMetadata(requestedMetadata),
        )) {
        throw new Error(`translation runtime policy mismatch for ${runId}`);
      }
    }
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion,
      modelId,
      initialSnapshotId: initialSnapshot.id,
      initialSnapshot,
      metadata: existingRun?.metadata ?? requestedMetadata,
    });
    const planned = planBookWindows(context.losslessBlocks, {
      ...windowOptionsForRunMode(runtimeSet.mode, options.windowOptions),
      protocolVersion,
    });
    store.initializeWindowPlan(runId, planned);
    store.recoverInterruptedWindows(runId);
    const estimator = options.tokenEstimator ?? new WeightedTokenEstimator();
    const schedulerSnapshot = store.latestSchedulerSnapshot(runId);
    const scheduler = new AdaptiveScheduler({
      initialConcurrency: Math.min(2, maxConcurrency),
      maxConcurrency,
      maxInFlightTokens,
      ...(schedulerSnapshot === undefined ? {} : { snapshot: schedulerSnapshot }),
    });
    const runtimeProfileKey = [
      runtimeSet.primary.model.id,
      context.languageProfile.id,
    ].join(":");
    const runtimeCostModel = options.runtimeProfileStore === undefined
      ? OnlineRuntimeCostModel.coldStart(runtimeProfileKey)
      : loadRuntimeCostModel(options.runtimeProfileStore, runtimeProfileKey);
    const dynamicScheduler = new DynamicScheduler({
      mode: schedulerMode,
      profile: optimizationProfile,
      planner: planRollingHorizon,
      costModel: runtimeCostModel,
      ...(options.runtimeProfileStore === undefined
        ? {}
        : { profileStore: options.runtimeProfileStore }),
    });
    const tokenLedgerInit = {
      mode: schedulerMode,
      profile: optimizationProfile,
      tokenIncreaseCap: selectedOptimizationPolicy.tokenIncreaseCap,
      enforceDispatchLifecycle: true,
    };
    const tokenLedger = store.loadTokenLedger(runId, tokenLedgerInit);
    tokenLedgerForReconciliation = tokenLedger;
    const priorSchedulerMetrics = store.loadSchedulerMetrics(
      runId,
      tokenLedgerInit,
    );
    for (const open of [...tokenLedger.state().openReservations.values()]) {
      const reconcileEvent: LedgerEvent = tokenLedger.state()
        .dispatchedRequestIds.has(open.requestId)
        ? {
            type: "settled",
            requestId: open.requestId,
            actualTokens: open.predictedTokens,
            usageComplete: false,
            outcome: "cancelled",
          }
        : {
            type: "released",
            requestId: open.requestId,
            reason: "superseded",
          };
      tokenLedger.apply(reconcileEvent);
      store.appendTokenLedgerEvent(runId, reconcileEvent);
    }
    if (priorSchedulerMetrics !== undefined) {
      tokenLedger.apply({
        type: "counters_patched",
        patch: schedulerCountersPatch(priorSchedulerMetrics),
      });
    }
    const hydrateSchedulerMetricsFromLedger = (): void => {
      const report = tokenLedger.toSchedulerRunReport();
      schedulerMetrics.mode = report.mode;
      schedulerMetrics.profile = report.profile;
      schedulerMetrics.planningStatus = report.planningStatus;
      schedulerMetrics.decisions = report.decisions;
      schedulerMetrics.fallbacks = report.fallbacks;
      schedulerMetrics.baselineWallTimeMs = report.baselineWallTimeMs;
      schedulerMetrics.predictedWallTimeMs = report.predictedWallTimeMs;
      schedulerMetrics.actualWallTimeMs = report.actualWallTimeMs;
      schedulerMetrics.baselineTokens = report.baselineTokens;
      schedulerMetrics.allowedTokens = report.allowedTokens;
      schedulerMetrics.predictedTokens = report.predictedTokens;
      schedulerMetrics.actualTokens = report.actualTokens;
      schedulerMetrics.tokenUsageComplete = report.tokenUsageComplete;
      schedulerMetrics.contextProfiles = { ...report.contextProfiles };
      schedulerMetrics.effortCounts = { ...report.effortCounts };
      schedulerMetrics.protocolCounts = { ...report.protocolCounts };
      schedulerMetrics.plannerDeadlines = report.plannerDeadlines;
      schedulerMetrics.throttles = report.throttles;
      schedulerMetrics.recoveries = report.recoveries;
    };
    hydrateSchedulerMetricsFromLedger();
    const persistLedgerEvent = (event: LedgerEvent): void => {
      tokenLedger.apply(event);
      try {
        store.appendTokenLedgerEvent(runId, event);
      } catch (error) {
        if (!(error instanceof Error)
          || !/not open|closed/i.test(error.message)) {
          throw error;
        }
      }
      const state = tokenLedger.state();
      schedulerMetrics.baselineTokens = state.baselineTokens;
      schedulerMetrics.allowedTokens = state.allowedTokens;
      schedulerMetrics.actualTokens = state.spentTokens;
      schedulerMetrics.tokenUsageComplete = state.tokenUsageComplete;
    };
    const admission = new AdmissionController({
      ledger: tokenLedger,
      mode: schedulerMode,
      persist: persistLedgerEvent,
    });
    reconcileOpenLedgerAttempts = (): void => {
      for (const open of [...tokenLedger.state().openReservations.values()]) {
        const event: LedgerEvent = tokenLedger.state()
          .dispatchedRequestIds.has(open.requestId)
          ? {
              type: "settled",
              requestId: open.requestId,
              actualTokens: open.predictedTokens,
              usageComplete: false,
              outcome: "cancelled",
            }
          : {
              type: "released",
              requestId: open.requestId,
              reason: "run_cancelled",
            };
        persistLedgerEvent(event);
      }
    };
    const nextLedgerAttemptId = (
      operationId: string,
      attempt: number,
    ): string => {
      const stem = `${operationId}:attempt-${attempt}`;
      const state = tokenLedger.state();
      if (!state.openReservations.has(stem)
        && !state.terminalRequestIds.has(stem)) {
        return stem;
      }
      let recovery = 1;
      while (state.openReservations.has(`${stem}:recovery-${recovery}`)
        || state.terminalRequestIds.has(`${stem}:recovery-${recovery}`)) {
        recovery += 1;
      }
      return `${stem}:recovery-${recovery}`;
    };
    const congestion = new CongestionSensor(scheduler);
    const telemetrySink = new TelemetrySink({
      costModel: runtimeCostModel,
      ...(options.runtimeProfileStore === undefined
        ? {}
        : { profileStore: options.runtimeProfileStore }),
    });
    flushSchedulerProjection = (): void => {
      tokenLedger.apply({
        type: "counters_patched",
        patch: {
          decisions: schedulerMetrics.decisions,
          fallbacks: schedulerMetrics.fallbacks,
          recoveries: schedulerMetrics.recoveries,
          plannerDeadlines: schedulerMetrics.plannerDeadlines,
          throttles: schedulerMetrics.throttles,
          planningStatus: schedulerMetrics.planningStatus,
          predictedTokens: schedulerMetrics.predictedTokens,
          predictedWallTimeMs: Math.floor(schedulerMetrics.predictedWallTimeMs),
          actualWallTimeMs: Math.floor(schedulerMetrics.actualWallTimeMs),
          baselineWallTimeMs: Math.floor(schedulerMetrics.baselineWallTimeMs),
          contextProfiles: schedulerMetrics.contextProfiles,
          effortCounts: schedulerMetrics.effortCounts,
          protocolCounts: schedulerMetrics.protocolCounts,
        },
      });
      hydrateSchedulerMetricsFromLedger();
      try {
        store.saveSchedulerRunProjection(
          runId,
          tokenLedger.toSchedulerRunReport(),
        );
      } catch (error) {
        if (!(error instanceof Error)
          || !/not open|closed/i.test(error.message)) {
          throw error;
        }
      }
    };
    let cumulativeBaselineTokens = schedulerMetrics.baselineTokens;
    const blockById = new Map(context.losslessBlocks.map((block) => [block.id, block]));
    store.syncScopedKnowledge(runId);
    const coverageScan = store.ensureConceptCoverageRevalidationTasks(
      runId,
      store.latestKnowledgeSnapshot(runId).id,
    );
    let revalidationDrain = emptyRevalidationDrainReport();
    let fastWaveHorizonMultiplier = runtimeSet.mode === "fast" ? 2 : 1;
    const translateRevalidation = async (
      work: RevalidationWorkItem,
      action: "repair" | "retranslate",
    ): Promise<RevalidationTranslationOutput> => {
      throwIfAborted(options.signal);
      const sourceBlock = blockById.get(work.source.blockId);
      if (sourceBlock === undefined
        || sourceBlock.sourceHash !== work.source.sourceHash) {
        throw new RevalidationOutputError("source block provenance changed");
      }
      const snapshot = store.latestKnowledgeSnapshot(runId);
      if (snapshot.id !== work.task.toSnapshotId) {
        if (work.task.conceptIds.some((conceptId) =>
          store.activeLexicalConcept(runId, conceptId) === undefined)) {
          throw new RevalidationOutputError(
            "latest snapshot no longer contains a changed concept",
          );
        }
      }
      const requestStyle = mergeStyleState(
        options.styleState,
        persistedStyleFromKnowledge(snapshot.revisions),
      );
      const requestWindow: RequestBatchWindow = {
        windowId: work.window.windowId,
        ordinal: work.window.ordinal,
        chapterId: work.window.chapterId,
        chapterTitle: work.window.chapterTitle,
        blockIds: [work.source.blockId],
        globalIndexes: [work.source.globalIndex],
        sourceTokens: work.source.tokenCount,
        sourceChars: Array.from(work.source.sourceText).length,
        oversized: work.source.tokenCount > maxRequestTokens,
        status: "pending",
      };
      const request: PhysicalRequestPlan = {
        requestId: `revalidation-${createHash("sha256")
          .update([
            runId,
            work.task.taskId,
            String(work.task.attempts),
          ].join("\0"), "utf8")
          .digest("hex")
          .slice(0, 24)}`,
        windows: [requestWindow],
        sourceTokens: requestWindow.sourceTokens,
      };
      const terms = termsForWindows(
        uniqueTerms([
          ...context.stableTerms.map((term) => ({
            ...term,
            origin: term.origin ?? "legacy" as const,
          })),
          ...(options.glossary?.stableTerms ?? []),
          ...stableTermsFromKnowledge(snapshot.revisions),
        ], context),
        [requestWindow],
        context,
        options.glossary,
      );
      const effectiveStyle = projectEffectiveStyle(composeEffectiveStyle({
        constitution: losslessStyleConstitution(requestStyle),
        voices: losslessVoiceProfiles(requestStyle),
        observations: store.styleObservations(runId),
        currentOrdinal: work.window.ordinal,
        sourceText: work.source.sourceText,
        defaultVoiceId: "narrator",
      }));
      const runtime = work.task.attempts > 1
        ? runtimeSet.escalation
        : runtimeSet.primary;
      const committedBoundaryFailures = (
        translatedText: string,
      ): ValidationFailure[] => {
        const active = store.activeTranslations(runId);
        const activeIndex = active.findIndex((translation) =>
          translation.blockId === work.source.blockId);
        if (activeIndex < 0) {
          throw new RevalidationOutputError(
            "active translation disappeared during boundary validation",
          );
        }
        const boundaryTranslations = [
          ...(activeIndex > 0 ? [active[activeIndex - 1]!] : []),
          {
            ...work.translation,
            text: translatedText,
          },
          ...(activeIndex + 1 < active.length
            ? [active[activeIndex + 1]!]
            : []),
        ].map((translation) => ({
          blockId: translation.blockId,
          text: translation.text,
        }));
        const boundaryBlocks = boundaryTranslations
          .map((translation) => blockById.get(translation.blockId))
          .filter((block): block is BookContext["losslessBlocks"][number] =>
            block !== undefined)
          .map(losslessAsV4);
        return new TranslationValidator().validateCrossBlockAlignment(
          boundaryBlocks,
          {
            translations: boundaryTranslations,
            notes: [],
            repaired: false,
          },
        ).failures.map((failure) => ({
          ...failure,
          // Only the revalidation candidate is mutable. Mapping every
          // committed-boundary failure to it keeps the targeted repair from
          // attempting to rewrite an already committed neighbour.
          blockId: work.source.blockId,
          message: `committed-boundary validation: ${failure.message}`,
        }));
      };
      const responseProtocol = runtimeSet.mode === "fast"
        ? "framed_text" as const
        : "typed_tool" as const;
      const buildTranslationInput = (
        selectedRequest: PhysicalRequestPlan,
      ): TranslationRequestInput => ({
        request: selectedRequest,
        blocks: context.losslessBlocks,
        stableTerms: terms,
        snapshot,
        styleState: requestStyle,
        sourceLanguageProfile: context.languageProfile,
        entityLinkWarnings: [],
        effectiveStyleByWindow: Object.fromEntries(
          selectedRequest.windows.map((window) => [
            window.windowId,
            effectiveStyle,
          ]),
        ),
        responseProtocol,
        ...(selectedRequest.requestId === request.requestId
          ? {
              additionalValidationFailures: (
                window: TranslationBatchWindowResult,
              ): readonly ValidationFailure[] => {
                const translated = window.translations.find((translation) =>
                  translation.blockId === work.source.blockId);
                return translated === undefined
                  ? []
                  : committedBoundaryFailures(translated.text);
              },
            }
          : {}),
      });
      const admitted = admitTranslationRequests(
        [request],
        runtime,
        estimator,
        blockById,
        buildTranslationInput,
      )[0];
      if (admitted === undefined) {
        throw new Error(`missing revalidation admission for ${request.requestId}`);
      }
      const risk = assessTaskRisk({
        sourceTokens: request.sourceTokens,
        entityMentions: 0,
        pronounMentions: 0,
        relationKinds: [],
        remoteEvidenceDistance: 0,
        lockedTermOccurrences: lockedTermOccurrences(
          [work.source.sourceText],
          terms,
        ),
        needsRevalidate: true,
        priorRepairs: Math.max(0, work.task.attempts - 1),
        sourceAnomalies: sourceAnomaliesForRequest(
          request,
          sourceAnomalyReport,
          blockById,
        ),
      });
      const baseline = baselineVariantForTask(admitted, {
        runtime,
        risk,
        costModel: runtimeCostModel,
        maxConcurrency,
      });
      const escalationAdmitted = runtime === runtimeSet.escalation
        ? admitted
        : admitTranslationRequests(
            [request],
            runtimeSet.escalation,
            estimator,
            blockById,
            buildTranslationInput,
          )[0];
      if (escalationAdmitted === undefined) {
        throw new Error(
          `missing escalation revalidation admission for ${request.requestId}`,
        );
      }
      const escalationBaseline = runtime === runtimeSet.escalation
        ? baseline
        : baselineVariantForTask(escalationAdmitted, {
            runtime: runtimeSet.escalation,
            risk,
            costModel: runtimeCostModel,
            maxConcurrency,
          });
      const execution: PlannedTranslationExecution = {
        admitted,
        runtime,
        buildInput: buildTranslationInput,
        features: baseline.features,
        variant: baseline.variant,
      };
      const baselineTaskId = `revalidation-task:${work.task.taskId}`;
      admission.addBaseline({
        taskIds: [baselineTaskId],
        baselineTokens:
          Math.max(
            baseline.variant.predicted.totalTokens,
            escalationBaseline.variant.predicted.totalTokens,
          )
          + Math.max(
            admitted.paragraphRecoveryReserveTokens,
            escalationAdmitted.paragraphRecoveryReserveTokens,
          )
          + Math.max(
            admitted.paragraphRefinementReserveTokens,
            escalationAdmitted.paragraphRefinementReserveTokens,
          )
          + Math.max(
            admitted.targetedRepairReserveTokens,
            escalationAdmitted.targetedRepairReserveTokens,
          ),
        source: "revalidate",
        reason: "task_attempt",
      });
      const ledgerAttemptId = nextLedgerAttemptId(
        `revalidation:${runId}:${work.task.taskId}`,
        work.task.attempts,
      );
      admission.reserve({
        requestId: ledgerAttemptId,
        purpose: "revalidate",
        taskIds: [baselineTaskId],
        predictedTokens: baseline.variant.predicted.totalTokens,
        attempt: work.task.attempts,
        conservativeHorizonFloor: 0,
      });
      admission.markDispatched(ledgerAttemptId);
      let completed: CompletedTranslationRequest;
      try {
        completed = (await executePlannedTranslationRequest(execution, {
          admission,
          nextLedgerAttemptId,
          runtimeSet,
          estimator,
          languageProfile: context.languageProfile,
          blockById,
          ...(options.signal === undefined
            ? {}
            : { signal: options.signal }),
          ...(options.hardDeadlineMs === undefined
            ? {}
            : { hardDeadlineMs: options.hardDeadlineMs }),
          retryRound: work.task.attempts,
          conservativeHorizonFloor: () => 0,
          onProviderResponse: (evidence) =>
            store.appendProviderResponseEvidence({
              runId,
              requestId: evidence.requestId,
              snapshotId: evidence.snapshotId,
              phase: evidence.phase,
              modelCallOrdinal: evidence.modelCallOrdinal,
              requestHash: evidence.requestHash,
              responseProtocol: evidence.responseProtocol,
              ...(evidence.executionUnitId === undefined
                ? {}
                : { executionUnitId: evidence.executionUnitId }),
              assistantMessage: evidence.assistantMessage,
            }),
        })).value;
      } catch (error) {
        admission.settle({
          requestId: ledgerAttemptId,
          actualTokens: baseline.variant.predicted.totalTokens,
          usageComplete: false,
          outcome: "failed",
        });
        throw error;
      }
      const accountingUsage = completed.runtime.accountingUsage;
      admission.settle({
        requestId: ledgerAttemptId,
        actualTokens: accountingUsage.complete
          ? accountingUsage.totalTokens
          : Math.max(
            accountingUsage.totalTokens,
            baseline.variant.predicted.totalTokens,
          ),
        usageComplete: accountingUsage.complete,
        outcome: completed.error === undefined
          ? "success"
          : completed.runtime.status === "protocol"
            ? "protocol"
            : "failed",
      });
      if (completed.error !== undefined) {
        throw completed.error;
      }
      const result = completed.result;
      if (result === undefined) {
        throw new RevalidationOutputError(
          "revalidation execution produced no result",
        );
      }
      const windowResult = result.windows.find((candidate) =>
        candidate.windowId === requestWindow.windowId);
      if (windowResult === undefined
        || windowResult.status === "failed"
        || windowResult.translations.length !== 1
        || windowResult.translations[0]?.blockId !== work.source.blockId) {
        throw new RevalidationOutputError("single-block translation was incomplete");
      }
      const translatedText = windowResult.translations[0].text;
      const boundaryFailures = committedBoundaryFailures(translatedText);
      if (boundaryFailures.length > 0) {
        throw new RevalidationOutputError(
          `cross-block alignment failed after repair: ${boundaryFailures
            .map((failure) => failure.code)
            .join(",")}`,
        );
      }
      const warnings = [...windowResult.notes, ...result.responseErrors];
      const runtimeUsage = completed.runtime.usage;
      const modelCalls = completed.budget.modelCalls ?? 0;
      const telemetry: RevalidationModelTelemetry = {
        modelCalls,
        modelDurationMs: completed.runtime.durationMs,
        inputTokens: runtimeUsage.inputTokens,
        outputTokens: runtimeUsage.outputTokens,
        cacheReadTokens: runtimeUsage.cacheReadTokens,
        cacheWriteTokens: runtimeUsage.cacheWriteTokens,
        reasoningTokens: runtimeUsage.reasoningTokens,
        totalTokens: runtimeUsage.totalTokens,
      };
      return {
        snapshotId: snapshot.id,
        text: translatedText,
        resultStatus: warnings.length > 0
          ? "completed_with_warnings"
          : "completed",
        termUsages: windowResult.termUsages,
        concepts: conceptsFromStableTerms(terms),
        telemetry,
        result: {
          action,
          responseWarnings: result.responseErrors.length,
          notes: windowResult.notes.length,
          modelCalls,
        },
      };
    };

    const drainRevalidationAtFinalBarrier = async (): Promise<void> => {
      const revalidationOptions = {
        store,
        runId,
        maxAttempts,
        translate: translateRevalidation,
        isExpectedFailure: (error: unknown) =>
          error instanceof ModelProviderError
          || error instanceof BudgetExceeded
          || error instanceof BookRequestCapacityError
          || error instanceof RevalidationOutputError,
        isRunBlockingFailure: (error: unknown) =>
          error instanceof ModelProviderError,
        shouldRetryFailure: (error: unknown) =>
          error instanceof RevalidationOutputError
          || (error instanceof ModelProviderError && error.retryable),
      };
      const drainedRevalidation = schedulerMode === "active"
        ? await executeRevalidationTasks({
          ...revalidationOptions,
          maxConcurrency,
          maxInFlightTokens,
          profile: optimizationProfile,
        })
        : await drainKnowledgeRevalidationTasks(revalidationOptions);
      revalidationDrain = mergeRevalidationDrainReports(
        revalidationDrain,
        drainedRevalidation,
      );
      if (drainedRevalidation.modelCalls > 0) {
        flushSchedulerProjection?.();
      }
    };

    let paused = false;
    while (processedWindows < maxWindows) {
      if (options.shouldPause?.() === true) {
        paused = true;
        break;
      }
      throwIfAborted(options.signal);
      assertSourceVersionUnchanged(context);
      // A book or project catalog can be edited by another completed run while
      // this run is paused. Synchronize only at the wave boundary, before any
      // window is claimed, so the next request sees the newest durable user
      // knowledge without ever changing a running/staged wave.
      store.syncScopedKnowledge(runId);
      const allWindows = store.allWindows(runId);
      const barrier = firstUncommitted(allWindows);
      if (barrier === undefined || barrier.status !== "pending") {
        break;
      }
      const remaining = maxWindows - processedWindows;
      const selected: PersistedLosslessWindow[] = [];
      const physicalRequestHorizon = maxConcurrency * fastWaveHorizonMultiplier;
      for (const window of allWindows.slice(barrier.ordinal)) {
        if (window.status !== "pending"
          || selected.length >= remaining) {
          break;
        }
        const tentative = [...selected, window];
        const physicalCount = packPhysicalRequests(
          tentative.map((item) => ({ ...item, status: "pending" as const })),
          { tinyWindowTokens, maxRequestTokens, maxWindowsPerRequest },
        ).length;
        if (physicalCount > physicalRequestHorizon) {
          break;
        }
        selected.push(window);
      }
      if (selected.length === 0) {
        break;
      }

      const snapshot = store.latestKnowledgeSnapshot(runId);
      const requestStyle = mergeStyleState(
        options.styleState,
        persistedStyleFromKnowledge(snapshot.revisions),
      );
      const styleConstitution = losslessStyleConstitution(requestStyle);
      const voiceProfiles = losslessVoiceProfiles(requestStyle);
      const priorStyleObservations = store.styleObservations(runId);
      const effectiveStyleByWindow = Object.fromEntries(selected.map((window) => [
        window.windowId,
        projectEffectiveStyle(composeEffectiveStyle({
          constitution: styleConstitution,
          voices: voiceProfiles,
          observations: priorStyleObservations,
          currentOrdinal: window.ordinal,
          sourceText: windowSourceText(window, blockById),
          defaultVoiceId: "narrator",
        })),
      ])) as Record<string, EffectiveStyleProjection>;
      const establishedTerms = uniqueTerms([
        ...context.stableTerms.map((term) => ({
          ...term,
          origin: term.origin ?? "legacy" as const,
        })),
        ...(options.glossary?.stableTerms ?? []),
        ...stableTermsFromKnowledge(snapshot.revisions),
      ], context);
      const selectedSourceBlocks = sourceBlocksForWindows(selected, blockById);
      const selectedBlocks = selectedSourceBlocks.map(losslessAsV4);
      const anchorStableTerms = termsForWindows(
        establishedTerms,
        selected,
        context,
        options.glossary,
      );
      const corpusBlocks = context.losslessBlocks.map(losslessAsV4);
      const anchorCandidates = collectWindowAnchorCandidates(
        selectedBlocks.map((block) => withoutStructureHeadingLines(block, context))
          .filter((block): block is V4Block => block !== undefined),
        corpusBlocks.map((block) => withoutStructureHeadingLines(block, context))
          .filter((block): block is V4Block => block !== undefined),
        anchorStableTerms,
        decidedAnchorFormsFromKnowledge(snapshot.revisions),
        context.languageProfile,
      );
      const anchorBudget = new BudgetLedger();
      let waveAnchorSnapshot: WaveAnchorSnapshot | undefined;
      if (anchorCandidates.length === 1
        && anchorCandidates[0]?.sourceAuthoredTarget !== undefined) {
        const inputHash = waveAnchorInputHash(context, anchorCandidates, anchorStableTerms);
        const cached = store.waveAnchorDecision(runId, inputHash);
        if (cached !== undefined) {
          waveAnchorSnapshot = parseWaveAnchorSnapshot(cached, inputHash);
        } else {
          const outcome = sourceAuthoredAnchorFallback(anchorCandidates);
          waveAnchorSnapshot = {
            schemaVersion: "v5-wave-anchor-1",
            inputHash,
            anchors: outcome.anchors,
            entityLinks: outcome.entityLinks,
            terms: outcome.terms,
          };
          const projectedForms = new Set(outcome.terms.map((term) =>
            context.languageProfile.normalizeSourceForm(term.sourceForm)));
          const anchorByForm = new Map(outcome.anchors.map((anchor) => [
            context.languageProfile.normalizeSourceForm(anchor.sourceForm),
            anchor,
          ]));
          const reusableDecision = anchorCandidates.every((candidate) => {
            const normalized = context.languageProfile.normalizeSourceForm(candidate.sourceForm);
            const anchor = anchorByForm.get(normalized);
            return anchor !== undefined
              && (anchor.mode === "contextual" || projectedForms.has(normalized));
          });
          if (reusableDecision) {
            store.cacheWaveAnchorDecision(runId, inputHash, waveAnchorSnapshot);
          }
        }
      }
      if (anchorCandidates.length >= 2) {
        const inputHash = waveAnchorInputHash(context, anchorCandidates, anchorStableTerms);
        const cached = store.waveAnchorDecision(runId, inputHash);
        if (cached !== undefined) {
          waveAnchorSnapshot = parseWaveAnchorSnapshot(cached, inputHash);
        } else {
          throwIfAborted(options.signal);
          const anchorRuntime = runtimeSet.mode === "fast"
            ? runtimeSet.primary
            : runtimeSet.escalation;
          const anchorer = new LexicalAnchorer(new PiRuntime());
          const anchorInput = (runtime: TranslationRuntime) => ({
            candidates: anchorCandidates,
            stableTerms: anchorStableTerms,
            model: runtime.model,
            streamFn: runtime.streamFn,
            budget: anchorBudget,
            sourceLanguageProfile: context.languageProfile,
            thinkingLevel: runtime.thinkingLevel,
            signal: options.signal,
            deadlineMs: options.hardDeadlineMs,
          });
          const escalationIsDistinct = anchorRuntime.model !== runtimeSet.escalation.model
            || anchorRuntime.streamFn !== runtimeSet.escalation.streamFn
            || anchorRuntime.effort !== runtimeSet.escalation.effort
            || anchorRuntime.thinkingLevel !== runtimeSet.escalation.thinkingLevel;
          const anchorRequestId = `anchor:${runId}:wave${waves.length}:${inputHash.slice(0, 12)}`;
          const anchorBudgetInput = {
            candidates: anchorCandidates,
            stableTerms: anchorStableTerms,
            sourceLanguageProfile: context.languageProfile,
          };
          const anchorAssessments = runtimeSet.mode === "fast"
            ? [
                assessLexicalAnchorAttempt(
                  anchorBudgetInput,
                  anchorRuntime,
                  estimator,
                  "framed_text",
                ),
                ...(escalationIsDistinct
                  ? [
                      assessLexicalAnchorAttempt(
                        anchorBudgetInput,
                        runtimeSet.escalation,
                        estimator,
                        "typed_tool",
                      ),
                      assessLexicalAnchorAttempt(
                        anchorBudgetInput,
                        runtimeSet.escalation,
                        estimator,
                        "framed_text",
                      ),
                    ]
                  : []),
              ]
            : [
                assessLexicalAnchorAttempt(
                  anchorBudgetInput,
                  anchorRuntime,
                  estimator,
                  "typed_tool",
                ),
                assessLexicalAnchorAttempt(
                  anchorBudgetInput,
                  anchorRuntime,
                  estimator,
                  "framed_text",
                ),
              ];
          const anchorPredictedTokens = anchorAssessments.reduce(
            (total, assessment) => total + assessment.totalReserved,
            0,
          );
          admission.addBaseline({
            taskIds: [anchorRequestId],
            baselineTokens: anchorPredictedTokens,
            source: "anchor",
            reason: "wave_anchor",
          });
          let anchorAttemptOrdinal = 0;
          const captureAnchorRun = async (
            runtime: TranslationRuntime,
            protocol: "typed_tool" | "framed_text",
            operation: (
              attemptId: string,
            ) => Promise<LexicalAnchorOutcome>,
          ): Promise<LexicalAnchorOutcome> => {
            const ordinal = anchorAttemptOrdinal;
            anchorAttemptOrdinal += 1;
            const assessment = assessLexicalAnchorAttempt(
              anchorBudgetInput,
              runtime,
              estimator,
              protocol,
            );
            const attemptId = nextLedgerAttemptId(
              `${anchorRequestId}:${protocol}:${runtime.model.id}`,
              ordinal,
            );
            const transaction = admission.begin({
              requestId: attemptId,
              purpose: "anchor",
              taskIds: [anchorRequestId],
              predictedTokens: assessment.totalReserved,
              attempt: ordinal,
              conservativeHorizonFloor: 0,
            });
            try {
              transaction.markDispatched();
            } catch (error) {
              transaction.releaseUnlaunched("not_launched");
              throw error;
            }
            try {
              const resolved = await operation(attemptId);
              transaction.settle({
                actualTokens: resolved.run.usage.totalTokens,
                usageComplete: resolved.run.modelCalls === 0
                  || resolved.run.usage.totalTokens > 0,
                outcome: "success",
              });
              return resolved;
            } catch (error) {
              const failedRun = error instanceof ModelProviderError
                ? error.run
                : undefined;
              transaction.settle({
                actualTokens: failedRun?.usage.totalTokens ?? 0,
                usageComplete: failedRun !== undefined
                  && (failedRun.modelCalls === 0
                    || failedRun.usage.totalTokens > 0),
                outcome: error instanceof ModelProviderError
                  && error.kind === "protocol"
                  ? "protocol"
                  : "failed",
              });
              throw error;
            }
          };
          const resolveAnchors = (runtime: TranslationRuntime) =>
            captureAnchorRun(
              runtime,
              "typed_tool",
              (attemptId) => anchorer.run({
                ...anchorInput(runtime),
                onAssistantResponse: (evidence) =>
                  store.appendProviderResponseEvidence({
                    runId,
                    requestId: attemptId,
                    snapshotId: snapshot.id,
                    phase: evidence.phase,
                    modelCallOrdinal: evidence.modelCallOrdinal,
                    requestHash: evidence.requestHash,
                    responseProtocol: "typed_tool",
                    assistantMessage: evidence.assistantMessage,
                  }),
              }),
            );
          const resolvePreferredFallback = (runtime: TranslationRuntime) =>
            captureAnchorRun(
              runtime,
              "framed_text",
              (attemptId) => anchorer.runPreferredTextFallback({
                ...anchorInput(runtime),
                onAssistantResponse: (evidence) =>
                  store.appendProviderResponseEvidence({
                    runId,
                    requestId: attemptId,
                    snapshotId: snapshot.id,
                    phase: evidence.phase,
                    modelCallOrdinal: evidence.modelCallOrdinal,
                    requestHash: evidence.requestHash,
                    responseProtocol: "framed_text",
                    assistantMessage: evidence.assistantMessage,
                  }),
              }),
            );
          const preferredOrSourceFallback = async (runtime: TranslationRuntime) => {
            try {
              return await resolvePreferredFallback(runtime);
            } catch (fallbackError) {
              if (fallbackError instanceof ModelProviderError
                && fallbackError.kind === "protocol") {
                return sourceAuthoredAnchorFallback(anchorCandidates);
              }
              throw fallbackError;
            }
          };
          let outcome: Pick<LexicalAnchorOutcome, "anchors" | "entityLinks" | "terms">
            | undefined;
          if (runtimeSet.mode === "fast") {
            try {
              outcome = await resolvePreferredFallback(anchorRuntime);
            } catch (error) {
              throwIfAborted(options.signal);
              const cannotBenefitFromEscalation = error instanceof ModelProviderError
                && (error.kind === "auth" || error.kind === "quota");
              if (cannotBenefitFromEscalation || !escalationIsDistinct) {
                if (error instanceof ModelProviderError && error.kind === "protocol") {
                  outcome = sourceAuthoredAnchorFallback(anchorCandidates);
                } else {
                  throw error;
                }
              } else {
                try {
                  outcome = await resolveAnchors(runtimeSet.escalation);
                } catch (escalationError) {
                  if (!(escalationError instanceof ModelProviderError)
                    || escalationError.kind !== "protocol") {
                    throw escalationError;
                  }
                  outcome = await preferredOrSourceFallback(runtimeSet.escalation);
                }
              }
            }
          } else {
            try {
              outcome = await resolveAnchors(anchorRuntime);
            } catch (error) {
              throwIfAborted(options.signal);
              if (!(error instanceof ModelProviderError) || error.kind !== "protocol") {
                throw error;
              }
              outcome = await preferredOrSourceFallback(anchorRuntime);
            }
          }
          if (outcome === undefined) {
            throw new Error("lexical anchor produced no outcome");
          }
          waveAnchorSnapshot = {
            schemaVersion: "v5-wave-anchor-1",
            inputHash,
            anchors: outcome.anchors,
            entityLinks: outcome.entityLinks,
            terms: outcome.terms,
          };
          const projectedForms = new Set(outcome.terms.map((term) =>
            context.languageProfile.normalizeSourceForm(term.sourceForm)));
          const anchorByForm = new Map(outcome.anchors.map((anchor) => [
            context.languageProfile.normalizeSourceForm(anchor.sourceForm),
            anchor,
          ]));
          const reusableDecision = anchorCandidates.every((candidate) => {
            const normalized = context.languageProfile.normalizeSourceForm(candidate.sourceForm);
            const anchor = anchorByForm.get(normalized);
            return anchor !== undefined
              && (anchor.mode === "contextual" || projectedForms.has(normalized));
          });
          if (reusableDecision) {
            store.cacheWaveAnchorDecision(runId, inputHash, waveAnchorSnapshot);
          }
        }
      }
      const activeTerms = uniqueTerms([
        ...establishedTerms,
        ...(waveAnchorSnapshot?.terms ?? []).map((term) => ({
          ...term,
          origin: term.origin ?? "knowledge" as const,
        })),
      ], context);
      const unpersistedWaveKnowledge = waveKnowledgeCandidates(
        runId,
        waveAnchorSnapshot,
        context,
      );
      const entityLinkWarnings = unresolvedEntityWarnings(waveAnchorSnapshot);
      const coordinator = new CommitCoordinator(
        runId,
        new KnowledgeStore(store.knowledgeRevisions(runId)),
        {
          commitPromotion: (promotion) =>
            store.promoteStagedWindow(promotion),
        },
        snapshot,
      );
      const relativeOrdinal = new Map<string, number>();
      selected.forEach((window, ordinal) => {
        relativeOrdinal.set(window.windowId, ordinal);
        coordinator.bindWindow({ ordinal, windowId: window.windowId, snapshot });
      });
      let retryWindows = selected;
      let providerFailure: ModelProviderError | undefined;
      let firstProviderFailure: ModelProviderError | undefined;
      let freshWaveRequired = false;
      let initialRequestCount = 0;
      let retryRound = 0;
      const acceptedWaveTranslations = new Map<string, {
        blockId: string;
        text: string;
        windowId: string;
      }>();
      let anchorBudgetPending = Object.keys(anchorBudget.snapshot()).length > 0;
      const persistedBudgetFor = (
        window: PersistedLosslessWindow,
        requestBudget: Readonly<Record<string, number>>,
        receivesRequestBudget: boolean,
      ): Record<string, number> => {
        let increment = receivesRequestBudget ? requestBudget : {};
        if (anchorBudgetPending && window.windowId === selected[0]?.windowId) {
          increment = combinedBudget(increment, anchorBudget.snapshot());
          anchorBudgetPending = false;
        }
        return combinedBudget(window.budget, increment);
      };
      while (retryWindows.length > 0 && providerFailure === undefined) {
        throwIfAborted(options.signal);
        store.bindWindowsToSnapshot(
          runId,
          retryWindows.map((window) => window.windowId),
          snapshot.id,
        );
        const requests = packPhysicalRequests(
          retryWindows.map((window) => ({ ...window, status: "pending" as const })),
          { tinyWindowTokens, maxRequestTokens, maxWindowsPerRequest },
        );
        const executionRuntime = retryRound === 0
          ? runtimeSet.primary
          : runtimeSet.escalation;
        const buildTranslationInput = (request: PhysicalRequestPlan): TranslationRequestInput => ({
          request,
          blocks: context.losslessBlocks,
          stableTerms: termsForWindows(
            activeTerms,
            request.windows,
            context,
            options.glossary,
          ),
          snapshot,
          styleState: requestStyle,
          sourceLanguageProfile: context.languageProfile,
          entityLinkWarnings,
          effectiveStyleByWindow: Object.fromEntries(request.windows.map((window) => [
            window.windowId,
            effectiveStyleByWindow[window.windowId] as EffectiveStyleProjection,
          ])),
          responseProtocol: runtimeSet.mode === "fast" ? "framed_text" : "typed_tool",
        });
        const requestInputs = admitTranslationRequests(
          requests,
          executionRuntime,
          estimator,
          blockById,
          buildTranslationInput,
        );
        if (initialRequestCount === 0) {
          initialRequestCount = requestInputs.length;
        }
        const oversizedReservation = requestInputs.find((item) =>
          item.assessment.totalReserved > maxInFlightTokens);
        if (oversizedReservation !== undefined) {
          throw new RangeError(
            `maxInFlightTokens cannot admit request ${oversizedReservation.request.requestId} `
            + `(${oversizedReservation.assessment.totalReserved} tokens)`,
          );
        }
        let requestPlanning = dynamicRequestPlanning(requests, requestInputs, {
          runtimeSet,
          executionRuntime,
          mode: schedulerMode,
          buildBaseInput: buildTranslationInput,
          estimator,
          sourceAnomalyReport,
          blockById,
          snapshotId: snapshot.id,
          retryRound,
          costModel: runtimeCostModel,
          profile: optimizationProfile,
          cumulativeBaselineTokens,
          actualRunTokens: schedulerMetrics.actualTokens,
          maxConcurrency,
          maxInFlightTokens,
        });
        if (retryRound === 0) {
          const baseline = incrementalBaselineProjection(
            [...requestPlanning.legacyByTaskId.values()].flatMap((execution) =>
              weightedBaselineProjectionTasks(
                execution.admitted.request.windows.map((window) => ({
                  taskId: translationBaselineTaskId(window.windowId),
                  weight: window.sourceTokens,
                })),
                requestPlanning.baselineVariantByTaskId.get(
                  execution.admitted.request.requestId,
                )?.predicted.totalTokens
                  ?? execution.variant.predicted.totalTokens,
                requestPlanning.baselineVariantByTaskId.get(
                  execution.admitted.request.requestId,
                )?.predicted.p90DurationMs
                  ?? execution.variant.predicted.p90DurationMs,
              )),
            tokenLedger.state().baselinedTaskIds,
          );
          admission.addBaseline({
            taskIds: baseline.taskIds,
            baselineTokens: baseline.baselineTokens,
            source: "translate_horizon",
            reason: `wave_${waves.length}_round0`,
          });
          cumulativeBaselineTokens = schedulerMetrics.baselineTokens;
          requestPlanning = {
            ...requestPlanning,
            input: {
              ...requestPlanning.input,
              runBaselineTotalTokens: cumulativeBaselineTokens,
            },
          };
          schedulerMetrics.baselineWallTimeMs +=
            baseline.baselineWallTimeMs;
        } else {
          schedulerMetrics.recoveries += requestInputs.length;
        }
        const decisionOrdinal = schedulerMetrics.decisions;
        let initialPlanningEstimateRecorded = false;
        const decisionMetadata = () => ({
          decisionId: `decision-${createHash("sha256")
            .update([
              runId,
              String(waves.length),
              String(retryRound),
              String(schedulerMetrics.decisions),
              ...requestInputs.map((item) => item.request.requestId),
            ].join("\0"), "utf8")
            .digest("hex")
            .slice(0, 24)}`,
          runId,
          createdAt: new Date().toISOString(),
        });
        const recordDispatchReport = (
          dispatchReport: SchedulerDispatchReport,
        ): void => {
          if (schedulerMode === "off") return;
          schedulerMetrics.decisions += 1;
          if (schedulerMode === "active") {
            if (dispatchReport.planningStatus === "fallback") {
              schedulerMetrics.planningStatus = "fallback";
            } else if (dispatchReport.planningStatus === "bounded"
              && schedulerMetrics.planningStatus !== "fallback") {
              schedulerMetrics.planningStatus = "bounded";
            }
          }
          if (dispatchReport.plannerDeadlineReached) {
            schedulerMetrics.plannerDeadlines += 1;
          }
          if (dispatchReport.planningStatus === "fallback"
            || dispatchReport.fallbackReason !== undefined) {
            schedulerMetrics.fallbacks += 1;
          }
          if (!initialPlanningEstimateRecorded) {
            initialPlanningEstimateRecorded = true;
            schedulerMetrics.predictedWallTimeMs +=
              dispatchReport.predictedWallTimeMs;
            schedulerMetrics.predictedTokens += Math.max(
              0,
              dispatchReport.predictedTokens
                - (dispatchReport.fallbackReason === "PLANNER_FAILED"
                  ? 0
                  : schedulerMetrics.actualTokens),
            );
          }
        };
        if (schedulerMode !== "active") {
          const dispatchReport = dynamicScheduler.dispatch(
            requestPlanning.input,
            {
              legacyTaskIds: requestInputs.map((item) =>
                item.request.requestId),
              legacyVariants: [...requestPlanning.legacyByTaskId.values()]
                .map((execution) => execution.variant),
              decision: decisionMetadata(),
            },
          );
          recordDispatchReport(dispatchReport);
        }
        const claimed = new Map<string, PersistedLosslessWindow>();
        throwIfAborted(options.signal);
        for (const { request } of requestInputs) {
          for (const window of request.windows) {
            if (!claimed.has(window.windowId)) {
              claimed.set(window.windowId, store.claimWindow(runId, window.windowId));
            }
          }
        }

        type CompletedRequest = CompletedTranslationRequest;
        const ledgerAttemptByRequestId = new Map<string, string>();
        const completedRequestIds = new Set<string>();
        const dynamicExecutionStartedAt = performance.now();
        const executePlannedRequest = (
          execution: PlannedTranslationExecution,
        ): Promise<ScheduledResult<CompletedRequest>> => {
          const requestId = execution.admitted.request.requestId;
          const ledgerAttemptId = ledgerAttemptByRequestId.get(requestId);
          if (ledgerAttemptId === undefined) {
            throw new Error(`missing ledger attempt for ${requestId}`);
          }
          admission.markDispatched(ledgerAttemptId);
          return executePlannedTranslationRequest(execution, {
            admission,
            nextLedgerAttemptId,
            runtimeSet,
            estimator,
            languageProfile: context.languageProfile,
            blockById,
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(options.hardDeadlineMs === undefined
              ? {}
              : { hardDeadlineMs: options.hardDeadlineMs }),
            retryRound,
            conservativeHorizonFloor: () =>
              minimumMandatoryPendingTokens(),
            onProviderResponse: (evidence) =>
              store.appendProviderResponseEvidence({
                runId,
                requestId: evidence.requestId,
                snapshotId: evidence.snapshotId,
                phase: evidence.phase,
                modelCallOrdinal: evidence.modelCallOrdinal,
                requestHash: evidence.requestHash,
                responseProtocol: evidence.responseProtocol,
                ...(evidence.executionUnitId === undefined
                  ? {}
                  : { executionUnitId: evidence.executionUnitId }),
                assistantMessage: evidence.assistantMessage,
              }),
          });
        };
        const observeCompletedRequest = (completed: CompletedRequest): void => {
          const telemetry = completed.runtime;
          schedulerMetrics.recoveries += telemetry.recoveries.length;
          schedulerMetrics.throttles += [
            ...telemetry.recoveries.map((recovery) => recovery.status),
            telemetry.status,
          ].filter((status) => status === "throttled").length;
          const requestId = completed.request.requestId;
          const ledgerAttemptId = ledgerAttemptByRequestId.get(requestId);
          if (ledgerAttemptId !== undefined
            && tokenLedger.state().openReservations.has(ledgerAttemptId)) {
            const actualTokens = telemetry.accountingUsage.complete
              ? telemetry.accountingUsage.totalTokens
              : Math.max(
                telemetry.accountingUsage.totalTokens,
                telemetry.variant.predicted.totalTokens,
              );
            admission.settle({
              requestId: ledgerAttemptId,
              actualTokens,
              usageComplete: telemetry.accountingUsage.complete,
              outcome: completed.error === undefined
                ? "success"
                : telemetry.status === "protocol"
                  ? "protocol"
                  : "failed",
            });
            completedRequestIds.add(requestId);
          } else {
            schedulerMetrics.tokenUsageComplete =
              schedulerMetrics.tokenUsageComplete && telemetry.usage.complete;
            schedulerMetrics.actualTokens += telemetry.usage.complete
              ? telemetry.usage.totalTokens
              : Math.max(
                telemetry.usage.totalTokens,
                telemetry.variant.predicted.totalTokens,
              );
          }
          const observationStartedAt = Date.now();
          const recordRuntimeObservation = (
            observation: {
              readonly durationMs: number;
              readonly usage: NormalizedRuntimeUsage;
              readonly status: RuntimeObservationStatus;
              readonly protocol: "typed_tool" | "framed_text";
            },
            observationOrdinal: number,
          ): void => {
            const observedAt = new Date(
              observationStartedAt + observationOrdinal,
            ).toISOString();
            const features: RuntimeFeatures = {
              ...telemetry.features,
              protocolRank: observation.protocol === "typed_tool" ? 1 : 0,
            };
            telemetrySink.observeRuntime({
              features,
              durationMs: observation.durationMs,
              usage: observation.usage,
              status: observation.status,
              observedAt,
            });
            telemetrySink.appendProfileObservation({
              observationId: `observation-${createHash("sha256")
                .update([
                  runId,
                  completed.request.requestId,
                  String(waves.length),
                  String(retryRound),
                  String(decisionOrdinal),
                  String(observationOrdinal),
                  observation.status,
                ].join("\0"), "utf8")
                .digest("hex")
                .slice(0, 24)}`,
              requestId: completed.request.requestId,
              modelId: runtimeSet.primary.model.id,
              languageProfileId: context.languageProfile.id,
              taskType: "translate",
              protocol: observation.protocol,
              effort: telemetry.variant.effort,
              inputEstimate: features.inputTokens,
              outputEstimate: features.outputTokens,
              sourceTokens: features.sourceTokens,
              contextProfile: telemetry.variant.contextProfile,
              concurrency: features.concurrency,
              cacheHitRatio: features.cacheHitRatio,
              riskScore: features.riskScore,
              durationMs: observation.durationMs,
              usage: observation.usage,
              status: observation.status,
              observedAt,
            });
          };
          telemetry.recoveries.forEach((recovery, index) => {
            recordRuntimeObservation(recovery, index);
          });
          recordRuntimeObservation({
            durationMs: telemetry.observationDurationMs,
            usage: telemetry.observationUsage,
            status: telemetry.status,
            protocol: telemetry.variant.protocol === "framed_text"
              ? "framed_text"
              : "typed_tool",
          }, telemetry.recoveries.length);
        };
        const recordSelectedVariant = (
          execution: PlannedTranslationExecution,
        ): void => {
          for (const window of execution.admitted.request.windows) {
            schedulerMetrics.contextProfiles[window.windowId] =
              execution.variant.contextProfile;
          }
          schedulerMetrics.effortCounts[execution.variant.effort] =
            (schedulerMetrics.effortCounts[execution.variant.effort] ?? 0) + 1;
          schedulerMetrics.protocolCounts[execution.variant.protocol] += 1;
        };
        const predictedForExecution = (
          execution: PlannedTranslationExecution,
        ): number => Math.max(1, execution.variant.predicted.totalTokens);
        const minimumPredictionByTaskId = new Map<string, number>();
        for (const variant of requestPlanning.input.variants) {
          const predicted = Math.max(1, variant.predicted.totalTokens);
          const prior = minimumPredictionByTaskId.get(variant.taskId);
          if (prior === undefined || predicted < prior) {
            minimumPredictionByTaskId.set(variant.taskId, predicted);
          }
        }
        for (const [taskId, execution] of requestPlanning.legacyByTaskId) {
          if (!minimumPredictionByTaskId.has(taskId)) {
            minimumPredictionByTaskId.set(
              taskId,
              predictedForExecution(execution),
            );
          }
        }
        const minimumMandatoryPendingTokens = (
          excludeRequestId?: string,
        ): number => {
          const state = tokenLedger.state();
          let total = 0;
          for (const [taskId, predicted] of minimumPredictionByTaskId) {
            if (taskId === excludeRequestId
              || completedRequestIds.has(taskId)) {
              continue;
            }
            const attemptId = ledgerAttemptByRequestId.get(taskId);
            if (attemptId !== undefined
              && (state.openReservations.has(attemptId)
                || state.terminalRequestIds.has(attemptId))) {
              continue;
            }
            total += predicted;
          }
          return total;
        };
        const canLaunchExecution = (
          execution: PlannedTranslationExecution,
        ): boolean => {
          const requestId = execution.admitted.request.requestId;
          const attemptId = ledgerAttemptByRequestId.get(requestId);
          if (attemptId !== undefined
            && tokenLedger.state().openReservations.has(attemptId)) {
            return true;
          }
          return admission.canLaunch(
            predictedForExecution(execution),
            minimumMandatoryPendingTokens(requestId),
          );
        };
        const admitExecution = (
          execution: PlannedTranslationExecution,
        ): void => {
          const requestId = execution.admitted.request.requestId;
          const ledgerAttemptId = nextLedgerAttemptId(
            requestId,
            retryRound,
          );
          ledgerAttemptByRequestId.set(requestId, ledgerAttemptId);
          admission.reserve({
            requestId: ledgerAttemptId,
            purpose: "translate",
            taskIds: execution.admitted.request.windows.map((window) =>
              translationBaselineTaskId(window.windowId)),
            predictedTokens: predictedForExecution(execution),
            attempt: retryRound,
            conservativeHorizonFloor:
              minimumMandatoryPendingTokens(requestId),
          });
          recordSelectedVariant(execution);
        };
        let completionOrder: CompletedRequest[];
        if (schedulerMode === "active") {
          try {
            completionOrder = await runWithDynamicScheduler(
              requestPlanning,
              scheduler,
              dynamicScheduler,
              executePlannedRequest,
              {
                actualRunTokens: () => schedulerMetrics.actualTokens,
                decision: decisionMetadata,
                onDecision: recordDispatchReport,
                canLaunch: canLaunchExecution,
                onLaunch: admitExecution,
                onComplete: observeCompletedRequest,
                tokenGate: "external",
                ...(options.signal === undefined
                  ? {}
                  : { signal: options.signal }),
              },
            );
          } catch (error) {
            if (error instanceof BookTokenEnvelopeExceededError) {
              store.recoverInterruptedWindows(runId);
              store.saveSchedulerSnapshot(runId, scheduler.snapshot());
              flushSchedulerProjection();
            }
            throw error;
          }
        } else {
          const legacyExecutionByTaskId = requestPlanning.legacyByTaskId;
          completionOrder = await runWithAdaptiveScheduler(
            requestInputs,
            scheduler,
            (item) => {
              const execution = legacyExecutionByTaskId.get(
                item.request.requestId,
              );
              if (execution === undefined) {
                throw new Error(
                  `missing legacy execution for ${item.request.requestId}`,
                );
              }
              admitExecution(execution);
              return executePlannedRequest(execution);
            },
            options.signal,
          );
          for (const completed of completionOrder) {
            observeCompletedRequest(completed);
          }
        }
        schedulerMetrics.actualWallTimeMs +=
          performance.now() - dynamicExecutionStartedAt;
        flushSchedulerProjection();
        if (options.runtimeProfileStore !== undefined) {
          persistRuntimeCostModel(
            options.runtimeProfileStore,
            runtimeCostModel,
          );
        }
        store.saveSchedulerSnapshot(runId, scheduler.snapshot());

        throwIfAborted(options.signal);

        const currentTranslations = completionOrder.flatMap((completed) =>
          completed.result?.windows.flatMap((window) => window.status === "failed"
            ? []
            : window.translations.map((translation) => ({
              ...translation,
              windowId: window.windowId,
            }))) ?? []);
        const currentBlockIds = new Set(currentTranslations.map((item) => item.blockId));
        const currentIndexes = currentTranslations.map((item) =>
          blockById.get(item.blockId)?.globalIndex)
          .filter((index): index is number => index !== undefined);
        const earliestCurrentIndex = currentIndexes.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(...currentIndexes);
        const priorActive = store.activeTranslations(runId)
          .filter((translation) =>
            (blockById.get(translation.blockId)?.globalIndex ?? Number.POSITIVE_INFINITY)
              < earliestCurrentIndex)
          .at(-1);
        const boundaryTranslations = [
          ...(priorActive === undefined ? [] : [{
            blockId: priorActive.blockId,
            text: priorActive.text,
          }]),
          ...[...acceptedWaveTranslations.values()].map(({ blockId, text }) => ({
            blockId,
            text,
          })),
          ...currentTranslations.map(({ blockId, text }) => ({ blockId, text })),
        ];
        const uniqueBoundaryTranslations = [...new Map(boundaryTranslations.map((item) => [
          item.blockId,
          item,
        ])).values()];
        const boundaryBlocks = uniqueBoundaryTranslations
          .map((translation) => blockById.get(translation.blockId))
          .filter((block): block is BookContext["losslessBlocks"][number] => block !== undefined)
          .map(losslessAsV4);
        const boundaryValidation = new TranslationValidator().validateCrossBlockAlignment(
          boundaryBlocks,
          {
            translations: uniqueBoundaryTranslations,
            notes: [],
            repaired: false,
          },
        );
        const boundaryFailuresByWindow = new Map<string, string[]>();
        for (const failure of boundaryValidation.failures) {
          if (failure.blockId === undefined || !currentBlockIds.has(failure.blockId)) {
            continue;
          }
          const windowId = currentTranslations.find((translation) =>
            translation.blockId === failure.blockId)?.windowId;
          if (windowId === undefined) {
            continue;
          }
          const messages = boundaryFailuresByWindow.get(windowId) ?? [];
          messages.push(`${failure.code}: ${failure.message}`);
          boundaryFailuresByWindow.set(windowId, messages);
        }

        const successfulWindowIds = new Set(completionOrder.flatMap((completed) =>
          completed.result?.windows
            .filter((window) => window.status !== "failed"
              && !boundaryFailuresByWindow.has(window.windowId))
            .map((window) => window.windowId) ?? []));
        const assignedWaveKnowledge = assignWaveKnowledge(
          unpersistedWaveKnowledge,
          selected,
          successfulWindowIds,
          blockById,
          context,
        );
        const assignedRecordIds = new Set([...assignedWaveKnowledge.values()]
          .flatMap((items) => items.map((item) => item.recordId)));
        for (let index = unpersistedWaveKnowledge.length - 1; index >= 0; index -= 1) {
          if (assignedRecordIds.has(unpersistedWaveKnowledge[index]!.candidate.recordId)) {
            unpersistedWaveKnowledge.splice(index, 1);
          }
        }
        const nextRetries: PersistedLosslessWindow[] = [];
        let capacityFailure: BookRequestCapacityError | undefined;
        for (const completed of completionOrder) {
          if (completed.error !== undefined) {
            const completedError = completed.error;
            const message = completedError instanceof Error
              ? completedError.message
              : String(completedError);
            const capacityError = completedError instanceof BookRequestCapacityError;
            for (const requestWindow of completed.request.windows) {
              const window = claimed.get(requestWindow.windowId) as PersistedLosslessWindow;
              const external = !capacityError && completedError instanceof ModelProviderError;
              if (external && firstProviderFailure === undefined) {
                firstProviderFailure = completedError;
              }
              const retry = !capacityError && (external || window.attemptCount < maxAttempts);
              store.failWindow(runId, window.windowId, {
                error: message,
                retry,
                budget: persistedBudgetFor(
                  window,
                  completed.budget,
                  completed.request.windows[0]?.windowId === window.windowId,
                ),
                warnings: external
                  ? ["external model provider failure; run aborted without human task"]
                  : [message],
              });
              if (!external && retry) {
                nextRetries.push(store.pendingWindows(runId)
                  .find((item) => item.windowId === window.windowId) as PersistedLosslessWindow);
              }
            }
            if (capacityError) {
              capacityFailure ??= completedError;
              continue;
            }
            if (completedError instanceof ModelProviderError) {
              const definitiveFailure = completedError.kind === "auth"
                || completedError.kind === "quota"
                || completedError.kind === "protocol"
                || completedError.kind === "context";
              providerFailure = definitiveFailure
                ? completedError
                : (firstProviderFailure ?? completedError);
            }
            continue;
          }

          const result = completed.result as MergedTranslationResult;
          for (const windowResult of result.windows) {
            const window = claimed.get(windowResult.windowId) as PersistedLosslessWindow;
            const boundaryErrors = boundaryFailuresByWindow.get(window.windowId);
            if (windowResult.status === "failed" || boundaryErrors !== undefined) {
              const error = boundaryErrors === undefined
                ? windowResult.error ?? "invalid batch window submission"
                : `cross-request boundary validation failed: ${boundaryErrors.join("; ")}`;
              const retry = window.attemptCount < maxAttempts;
              store.failWindow(runId, window.windowId, {
                error,
                retry,
                budget: persistedBudgetFor(
                  window,
                  completed.budget,
                  completed.request.windows[0]?.windowId === window.windowId,
                ),
                warnings: [error, ...result.responseErrors],
              });
              if (retry) {
                nextRetries.push(store.pendingWindows(runId)
                  .find((item) => item.windowId === window.windowId) as PersistedLosslessWindow);
              }
              continue;
            }

            for (const translation of windowResult.translations) {
              acceptedWaveTranslations.set(translation.blockId, {
                ...translation,
                windowId: window.windowId,
              });
            }

            const candidates = [
              ...knowledgeCandidatesFor(
                runId,
                window.windowId,
                windowResult.memoryCandidates,
              ),
              ...(assignedWaveKnowledge.get(window.windowId) ?? []),
            ];
            // Validate domain reconciliation before any durable stage is written.
            coordinator.knowledge.fork().reconcileCandidates(candidates, window.windowId);
            const ordinal = relativeOrdinal.get(window.windowId) as number;
            const translations = windowResult.translations.map((translation) => ({
              ...translation,
              sourceHash: (blockById.get(translation.blockId) as { sourceHash: string }).sourceHash,
            }));
            const warnings = [...windowResult.notes, ...result.responseErrors];
            const status = warnings.length > 0
              ? "completed_with_warnings" as const
              : "completed" as const;
            const styleObservation = createStyleObservation({
              windowId: window.windowId,
              ordinal: window.ordinal,
              sourceText: windowSourceText(window, blockById),
              translations: window.blockIds.map((blockId) =>
                translations.find((item) => item.blockId === blockId)?.text ?? ""),
              submission: windowResult.styleObservation,
            });
            throwIfAborted(options.signal);
            store.stageWindow({
              runId,
              windowId: window.windowId,
              snapshotId: snapshot.id,
              status,
              translations,
              knowledgeCandidates: candidates,
              styleTail: canonicalJson(styleObservation),
              budget: persistedBudgetFor(
                window,
                completed.budget,
                completed.request.windows[0]?.windowId === window.windowId,
              ),
              warnings,
              conceptBindings: {
                usages: windowResult.termUsages,
                concepts: conceptsFromStableTerms(activeTerms),
              },
            });
            coordinator.stage({
              runId,
              windowId: window.windowId,
              ordinal,
              snapshotId: snapshot.id,
              candidates,
            });
            throwIfAborted(options.signal);
            coordinator.promoteReady();
            if (coordinator.takeRetryWindowIds().length > 0) {
              freshWaveRequired = true;
            }
          }
        }
        if (capacityFailure !== undefined) {
          throw capacityFailure;
        }
        if (freshWaveRequired) {
          store.recoverInterruptedWindows(runId);
          retryWindows = [];
        } else {
          retryWindows = nextRetries;
        }
        retryRound += 1;
      }

      const initialRequests = packPhysicalRequests(
        selected.map((window) => ({ ...window, status: "pending" as const })),
        { tinyWindowTokens, maxRequestTokens, maxWindowsPerRequest },
      );
      waves.push({
        wave: waves.length,
        concurrency: initialRequestCount || initialRequests.length,
        windowIds: selected.map((window) => window.windowId),
      });
      const completedWindowIds = freshWaveRequired
        ? new Set(store.allWindows(runId)
            .filter((window) =>
              window.status === "completed"
              || window.status === "completed_with_warnings")
            .map((window) => window.windowId))
        : undefined;
      processedWindows += completedWindowIds === undefined
        ? selected.length
        : selected.filter((window) =>
            completedWindowIds.has(window.windowId)).length;
      if (runtimeSet.mode === "fast") {
        const hasUnresolvedKnowledge = store.latestKnowledgeSnapshot(runId).revisions
          .some((revision) => revision.status === "needs_revalidate");
        const waveWasUnstable = retryRound > 1
          || freshWaveRequired
          || entityLinkWarnings.length > 0
          || hasUnresolvedKnowledge;
        fastWaveHorizonMultiplier = waveWasUnstable ? 1 : 2;
      }
      if (providerFailure !== undefined) {
        throw providerFailure;
      }
    }

    if (!paused) {
      // Model revalidation is a final-watermark operation.  Knowledge may
      // continue to change while untranslated windows remain, so draining at
      // every wave repeats expensive work against snapshots that are already
      // known to be provisional.  Pending tasks remain durable and stale
      // bindings continue to block strict export until this barrier is reached.
      store.syncScopedKnowledge(runId);
      if (firstUncommitted(store.allWindows(runId)) === undefined) {
        await drainRevalidationAtFinalBarrier();
      }
    }

    const status = store.statusSummary(runId);
    const outcome: LosslessBookRunResult["outcome"] = status.humanRequiredWindows > 0
      ? "human_required"
      : status.pendingWindows > 0 || status.runningWindows > 0 || status.stagedWindows > 0
        ? "partial"
        : status.warningWindows > 0
          ? "completed_with_warnings"
          : "completed";
    tokenLedger.assertReconciled();
    flushSchedulerProjection();
    return {
      outcome,
      runId,
      processedWindows,
      waves,
      status,
      windows: store.allWindows(runId),
      wallTimeMs: performance.now() - startedAt,
      revalidationOverhead: {
        coverageScan,
        drain: revalidationDrain,
      },
      scheduler: { ...schedulerMetrics },
      leaseReleased: true,
      artifacts: null,
    };
  } catch (error) {
    try {
      reconcileOpenLedgerAttempts?.();
      tokenLedgerForReconciliation?.assertReconciled();
      flushSchedulerProjection?.();
    } catch {
      // Reconciliation/projection failure must not mask the original failure.
    }
    if (isStorageLocked(error)) {
      throw new BookStorageIncidentError(error);
    }
    throw error;
  } finally {
    store.close();
    lease.release();
    context.close();
  }
}

export function runBook(options: BookRunOptions): Promise<BookRunResult>;
export function runBook(options: LosslessBookRunOptions): Promise<LosslessBookRunResult>;
export function runBook(
  options: BookRunOptions | LosslessBookRunOptions,
): Promise<BookRunResult | LosslessBookRunResult> {
  return "manifestPath" in options
    ? runLosslessBook(options)
    : runLegacyBook(options);
}
