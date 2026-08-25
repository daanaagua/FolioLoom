import { performance } from "node:perf_hooks";

import { ModelProviderError } from "../agents/pi-runtime.js";
import { BudgetExceeded } from "../kernel/budget.js";
import {
  evaluateRevalidationBindings,
  type RevalidationBindingDecision,
} from "../knowledge/sparse-revalidation.js";
import type {
  KnowledgeRevalidationTask,
  RevalidationReplacementInput,
  RevalidationWorkItem,
} from "../storage/lossless-book-store.js";
import {
  optimizationPolicy,
  type OptimizationProfile,
} from "./optimization-policy.js";
import {
  planRollingHorizon,
  type RollingPlannerResult,
  type TaskExecutionVariant,
} from "./rolling-horizon-planner.js";
import type { RuntimePrediction } from "./runtime-cost-model.js";
import {
  buildTaskGraph,
  TaskGraphIntegrityError,
  type SchedulerTask,
} from "./task-graph.js";
import { assessTaskRisk } from "./task-risk.js";

export interface RevalidationModelTelemetry {
  readonly modelCalls: number;
  readonly modelDurationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export interface RevalidationTranslationOutput
  extends Omit<
    RevalidationReplacementInput,
    "runId" | "taskId" | "action"
  > {
  readonly telemetry?: RevalidationModelTelemetry;
}

export interface RevalidationTaskStore {
  revalidationWorkItem(runId: string, taskId: string): RevalidationWorkItem;
  deferRevalidationTask(
    runId: string,
    taskId: string,
    result: unknown,
  ): void;
  resolveRevalidationNoop(
    runId: string,
    taskId: string,
    result: unknown,
  ): void;
  replaceTranslationForRevalidation(
    input: RevalidationReplacementInput,
  ): number;
  completeRevalidationWithWarning(
    runId: string,
    taskId: string,
    result: unknown,
  ): void;
}

export interface RevalidationExecutionStore extends RevalidationTaskStore {
  revalidationTasks(runId: string): KnowledgeRevalidationTask[];
  claimRevalidationTask(
    runId: string,
    taskId: string,
    maxAttempts: number,
    expectedAttempts: number,
  ): KnowledgeRevalidationTask | undefined;
}

export interface RevalidationDrainReport {
  readonly claimed: number;
  readonly noop: number;
  readonly repaired: number;
  readonly retranslated: number;
  readonly warning: number;
  readonly modelCalls: number;
  readonly modelDurationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly tokenUsageComplete: boolean;
  readonly wallTimeMs: number;
}

export interface RevalidationExecutionReport extends RevalidationDrainReport {
  readonly maximumObservedConcurrency: number;
  readonly maximumReservedTokens: number;
}

export interface RevalidationExecutionOptions {
  readonly store: RevalidationExecutionStore;
  readonly runId: string;
  readonly maxAttempts: number;
  readonly maxConcurrency: number;
  readonly maxInFlightTokens: number;
  readonly profile?: OptimizationProfile;
  readonly planner?: typeof planRollingHorizon;
  readonly predictionForTask?: (
    task: KnowledgeRevalidationTask,
  ) => RuntimePrediction;
  readonly reservedTokensForTask?: (
    task: KnowledgeRevalidationTask,
  ) => number;
  readonly translate: (
    work: RevalidationWorkItem,
    action: Exclude<RevalidationBindingDecision["action"], "noop">,
  ) => Promise<RevalidationTranslationOutput>;
  readonly isExpectedFailure: (error: unknown) => boolean;
  readonly isRunBlockingFailure?: (error: unknown) => boolean;
  readonly shouldRetryFailure?: (
    error: unknown,
    task: KnowledgeRevalidationTask,
  ) => boolean;
}

export interface RevalidationDrainOptions {
  readonly store: RevalidationTaskStore & {
    claimNextRevalidationTask(
      runId: string,
      maxAttempts: number,
    ): KnowledgeRevalidationTask | undefined;
  };
  readonly runId: string;
  readonly maxAttempts: number;
  readonly translate: RevalidationExecutionOptions["translate"];
  readonly isExpectedFailure: RevalidationExecutionOptions["isExpectedFailure"];
  readonly isRunBlockingFailure?:
    RevalidationExecutionOptions["isRunBlockingFailure"];
  readonly shouldRetryFailure?:
    RevalidationExecutionOptions["shouldRetryFailure"];
}

export interface RevalidationPermit {
  readonly taskId: string;
  readonly reservedTokens: number;
  release(): void;
}

export type RevalidationTaskOutcomeKind =
  | "noop"
  | "repaired"
  | "retranslated"
  | "retry"
  | "warning";

export interface RevalidationTaskOutcome {
  readonly taskId: string;
  readonly kind: RevalidationTaskOutcomeKind;
  readonly modelCalls: number;
  readonly modelDurationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly tokenUsageComplete: boolean;
}

interface MutableReport {
  claimed: number;
  noop: number;
  repaired: number;
  retranslated: number;
  warning: number;
  modelCalls: number;
  modelDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  tokenUsageComplete: boolean;
  maximumObservedConcurrency: number;
  maximumReservedTokens: number;
}

const COMPLETE_VALIDATORS = [
  "structure",
  "terminology",
  "cross_block",
  "knowledge_coverage",
] as const;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function defaultPrediction(totalTokens: number): RuntimePrediction {
  return {
    p50DurationMs: 80,
    p90DurationMs: 100,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    failureProbability: 0.12,
    confidence: 0,
  };
}

function revalidationTasksForPlanning(
  tasks: readonly KnowledgeRevalidationTask[],
  options: {
    readonly maxConcurrency: number;
    readonly maxInFlightTokens: number;
    readonly profile: OptimizationProfile;
    readonly predictionForTask?: (
      task: KnowledgeRevalidationTask,
    ) => RuntimePrediction;
    readonly reservedTokensForTask?: (
      task: KnowledgeRevalidationTask,
    ) => number;
  },
): {
  readonly graphTasks: readonly SchedulerTask[];
  readonly variants: readonly TaskExecutionVariant[];
  readonly reservedTokensByTaskId: ReadonlyMap<string, number>;
} {
  const defaultReservation = Math.max(
    1,
    Math.floor(options.maxInFlightTokens / options.maxConcurrency),
  );
  const reservedTokensByTaskId = new Map<string, number>();
  const variants: TaskExecutionVariant[] = [];
  const graphTasks = tasks.map((task, ordinal): SchedulerTask => {
    const reservedTokens = positiveInteger(
      options.reservedTokensForTask?.(task) ?? defaultReservation,
      `reserved tokens for ${task.taskId}`,
    );
    if (reservedTokens > options.maxInFlightTokens) {
      throw new RangeError(
        `revalidation task ${task.taskId} reserves ${reservedTokens} tokens `
        + `but maxInFlightTokens is ${options.maxInFlightTokens}`,
      );
    }
    reservedTokensByTaskId.set(task.taskId, reservedTokens);
    const risk = assessTaskRisk({
      sourceTokens: reservedTokens,
      entityMentions: 0,
      pronounMentions: 0,
      relationKinds: [],
      remoteEvidenceDistance: 0,
      lockedTermOccurrences: task.conceptIds.length,
      needsRevalidate: true,
      priorRepairs: Math.max(0, task.attempts - 1),
      sourceAnomalies: 0,
    });
    const rawPrediction = options.predictionForTask?.(task)
      ?? defaultPrediction(reservedTokens);
    const prediction = {
      ...rawPrediction,
      totalTokens: Math.max(rawPrediction.totalTokens, reservedTokens),
    };
    variants.push({
      variantId: `${task.taskId}:revalidate`,
      taskId: task.taskId,
      contextProfile: "rich",
      effort: "high",
      effortRank: 4,
      protocol: "typed_tool",
      validators: COMPLETE_VALIDATORS,
      predicted: prediction,
    });
    return {
      taskId: task.taskId,
      type: "revalidate",
      ordinal,
      dependencyIds: [],
      readResources: [`snapshot:${task.toSnapshotId}`],
      writeResources: [
        `window:translation-${task.translationId}`,
        ...task.conceptIds.map((conceptId) => `concept:${conceptId}`),
      ],
      sourceTokens: reservedTokens,
      risk,
    };
  });
  return { graphTasks, variants, reservedTokensByTaskId };
}

export function planRevalidationTasks(
  tasks: readonly KnowledgeRevalidationTask[],
  options: {
    readonly maxConcurrency: number;
    readonly maxInFlightTokens: number;
    readonly profile?: OptimizationProfile;
    readonly planner?: typeof planRollingHorizon;
    readonly predictionForTask?: (
      task: KnowledgeRevalidationTask,
    ) => RuntimePrediction;
    readonly reservedTokensForTask?: (
      task: KnowledgeRevalidationTask,
    ) => number;
  },
): {
  readonly result: RollingPlannerResult;
  readonly reservedTokensByTaskId: ReadonlyMap<string, number>;
} {
  const maxConcurrency = positiveInteger(
    options.maxConcurrency,
    "revalidation maxConcurrency",
  );
  const maxInFlightTokens = positiveInteger(
    options.maxInFlightTokens,
    "revalidation maxInFlightTokens",
  );
  const profile = options.profile ?? "balanced";
  const planned = revalidationTasksForPlanning(tasks, {
    maxConcurrency,
    maxInFlightTokens,
    profile,
    ...(options.predictionForTask === undefined
      ? {}
      : { predictionForTask: options.predictionForTask }),
    ...(options.reservedTokensForTask === undefined
      ? {}
      : { reservedTokensForTask: options.reservedTokensForTask }),
  });
  const baselineTokens = planned.variants.reduce(
    (total, variant) => total + variant.predicted.totalTokens,
    0,
  );
  const planner = options.planner ?? planRollingHorizon;
  return {
    result: planner({
      graph: buildTaskGraph(planned.graphTasks),
      completedTaskIds: [],
      running: [],
      variants: planned.variants,
      policy: optimizationPolicy(profile),
      runBaselineTotalTokens: baselineTokens,
      actualRunTokens: 0,
      runningReservedTokens: 0,
      horizonBaselineTokens: baselineTokens,
      maxConcurrency,
      maxInFlightTokens,
    }),
    reservedTokensByTaskId: planned.reservedTokensByTaskId,
  };
}

function revalidationFailureCode(error: unknown): string {
  if (error instanceof ModelProviderError) {
    return `PROVIDER_${error.kind.toUpperCase()}`;
  }
  if (error instanceof BudgetExceeded) {
    return "BUDGET_EXCEEDED";
  }
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) {
      return code;
    }
  }
  return "REVALIDATION_FAILED";
}

function emptyOutcome(
  taskId: string,
  kind: RevalidationTaskOutcomeKind,
): RevalidationTaskOutcome {
  return {
    taskId,
    kind,
    modelCalls: 0,
    modelDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    tokenUsageComplete: true,
  };
}

export async function executeOneRevalidationTask(
  task: KnowledgeRevalidationTask,
  options: {
    readonly store: RevalidationTaskStore;
    readonly runId: string;
    readonly maxAttempts: number;
    readonly translate: RevalidationExecutionOptions["translate"];
    readonly isExpectedFailure:
      RevalidationExecutionOptions["isExpectedFailure"];
    readonly isRunBlockingFailure?:
      RevalidationExecutionOptions["isRunBlockingFailure"];
    readonly shouldRetryFailure?:
      RevalidationExecutionOptions["shouldRetryFailure"];
  },
): Promise<RevalidationTaskOutcome> {
  const work = options.store.revalidationWorkItem(
    options.runId,
    task.taskId,
  );
  const decision = evaluateRevalidationBindings(work.concepts);
  if (decision.action === "noop") {
    options.store.resolveRevalidationNoop(
      options.runId,
      task.taskId,
      { reason: "recorded_surfaces_remain_allowed" },
    );
    return emptyOutcome(task.taskId, "noop");
  }

  const modelStartedAt = performance.now();
  try {
    const output = await options.translate(work, decision.action);
    options.store.replaceTranslationForRevalidation({
      ...output,
      runId: options.runId,
      taskId: task.taskId,
      action: decision.action,
    });
    if (output.telemetry === undefined) {
      return {
        ...emptyOutcome(
          task.taskId,
          decision.action === "repair" ? "repaired" : "retranslated",
        ),
        modelCalls: 1,
        modelDurationMs: performance.now() - modelStartedAt,
        tokenUsageComplete: false,
      };
    }
    return {
      ...emptyOutcome(
        task.taskId,
        decision.action === "repair" ? "repaired" : "retranslated",
      ),
      ...output.telemetry,
      tokenUsageComplete: true,
    };
  } catch (error) {
    if (options.isRunBlockingFailure?.(error) === true) {
      options.store.deferRevalidationTask(
        options.runId,
        task.taskId,
        { code: revalidationFailureCode(error) },
      );
      throw error;
    }
    if (!options.isExpectedFailure(error)) {
      throw error;
    }
    const retryable = options.shouldRetryFailure?.(error, task) ?? true;
    if (retryable && task.attempts < options.maxAttempts) {
      return {
        ...emptyOutcome(task.taskId, "retry"),
        modelCalls: 1,
        modelDurationMs: performance.now() - modelStartedAt,
        tokenUsageComplete: false,
      };
    }
    options.store.completeRevalidationWithWarning(
      options.runId,
      task.taskId,
      { code: revalidationFailureCode(error) },
    );
    return {
      ...emptyOutcome(task.taskId, "warning"),
      modelCalls: 1,
      modelDurationMs: performance.now() - modelStartedAt,
      tokenUsageComplete: false,
    };
  }
}

class RevalidationPermitPool {
  readonly #maxConcurrency: number;
  readonly #maxInFlightTokens: number;
  readonly #active = new Map<string, number>();
  #reservedTokens = 0;

  constructor(maxConcurrency: number, maxInFlightTokens: number) {
    this.#maxConcurrency = maxConcurrency;
    this.#maxInFlightTokens = maxInFlightTokens;
  }

  acquire(taskId: string, reservedTokens: number): RevalidationPermit | undefined {
    if (this.#active.has(taskId)
      || this.#active.size >= this.#maxConcurrency
      || this.#reservedTokens + reservedTokens > this.#maxInFlightTokens) {
      return undefined;
    }
    this.#active.set(taskId, reservedTokens);
    this.#reservedTokens += reservedTokens;
    let released = false;
    return {
      taskId,
      reservedTokens,
      release: () => {
        if (released) return;
        released = true;
        const reservation = this.#active.get(taskId);
        if (reservation === undefined) return;
        this.#active.delete(taskId);
        this.#reservedTokens -= reservation;
      },
    };
  }

  get active(): number {
    return this.#active.size;
  }

  get reservedTokens(): number {
    return this.#reservedTokens;
  }
}

function mutableReport(): MutableReport {
  return {
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
    maximumObservedConcurrency: 0,
    maximumReservedTokens: 0,
  };
}

function mergeOutcome(
  report: MutableReport,
  outcome: RevalidationTaskOutcome,
): void {
  if (outcome.kind !== "retry") {
    report[outcome.kind] += 1;
  }
  report.modelCalls += outcome.modelCalls;
  report.modelDurationMs += outcome.modelDurationMs;
  report.inputTokens += outcome.inputTokens;
  report.outputTokens += outcome.outputTokens;
  report.cacheReadTokens += outcome.cacheReadTokens;
  report.cacheWriteTokens += outcome.cacheWriteTokens;
  report.reasoningTokens += outcome.reasoningTokens;
  report.totalTokens += outcome.totalTokens;
  report.tokenUsageComplete =
    report.tokenUsageComplete && outcome.tokenUsageComplete;
}

function candidateTasks(
  options: RevalidationExecutionOptions,
  unavailableTaskIds: ReadonlySet<string>,
): KnowledgeRevalidationTask[] {
  const tasks = options.store.revalidationTasks(options.runId);
  for (const task of tasks) {
    if (!unavailableTaskIds.has(task.taskId)
      && task.status === "validating"
      && task.attempts >= options.maxAttempts) {
      options.store.completeRevalidationWithWarning(
        options.runId,
        task.taskId,
        { code: "REVALIDATION_ATTEMPTS_EXHAUSTED" },
      );
    }
  }
  return options.store.revalidationTasks(options.runId).filter((task) =>
    !unavailableTaskIds.has(task.taskId)
    && (task.status === "pending" || task.status === "validating")
    && task.attempts < options.maxAttempts);
}

export async function executeRevalidationTasks(
  options: RevalidationExecutionOptions,
): Promise<RevalidationExecutionReport> {
  positiveInteger(options.maxAttempts, "revalidation maxAttempts");
  const maxConcurrency = positiveInteger(
    options.maxConcurrency,
    "revalidation maxConcurrency",
  );
  const maxInFlightTokens = positiveInteger(
    options.maxInFlightTokens,
    "revalidation maxInFlightTokens",
  );
  const startedAt = performance.now();
  const report = mutableReport();
  const permits = new RevalidationPermitPool(
    maxConcurrency,
    maxInFlightTokens,
  );
  const unavailableTaskIds = new Set<string>();

  while (true) {
    const candidates = candidateTasks(options, unavailableTaskIds);
    if (candidates.length === 0) break;
    let planning: ReturnType<typeof planRevalidationTasks> | undefined;
    try {
      planning = planRevalidationTasks(candidates, {
        maxConcurrency,
        maxInFlightTokens,
        profile: options.profile,
        planner: options.planner,
        predictionForTask: options.predictionForTask,
        reservedTokensForTask: options.reservedTokensForTask,
      });
    } catch (error) {
      if (error instanceof TaskGraphIntegrityError) throw error;
    }
    const fallbackPlanning = planning === undefined
      ? revalidationTasksForPlanning(candidates, {
        maxConcurrency,
        maxInFlightTokens,
        profile: options.profile ?? "balanced",
        ...(options.predictionForTask === undefined
          ? {}
          : { predictionForTask: options.predictionForTask }),
        ...(options.reservedTokensForTask === undefined
          ? {}
          : { reservedTokensForTask: options.reservedTokensForTask }),
      })
      : undefined;
    const reservedTokensByTaskId = planning?.reservedTokensByTaskId
      ?? fallbackPlanning!.reservedTokensByTaskId;
    const plannedIds = planning?.result.firstDispatch.map(
      (item) => item.taskId,
    ) ?? [];
    const dispatchIds = plannedIds.length > 0
      ? plannedIds
      : [candidates[0]!.taskId];
    const claimed: Array<{
      readonly task: KnowledgeRevalidationTask;
      readonly permit: RevalidationPermit;
    }> = [];
    for (const taskId of dispatchIds) {
      const reservedTokens = reservedTokensByTaskId.get(taskId);
      if (reservedTokens === undefined) continue;
      const permit = permits.acquire(taskId, reservedTokens);
      if (permit === undefined) continue;
      const task = options.store.claimRevalidationTask(
        options.runId,
        taskId,
        options.maxAttempts,
        candidates.find((candidate) =>
          candidate.taskId === taskId)!.attempts,
      );
      if (task === undefined) {
        permit.release();
        unavailableTaskIds.add(taskId);
        continue;
      }
      report.claimed += 1;
      claimed.push({ task, permit });
    }
    if (claimed.length === 0) {
      continue;
    }
    report.maximumObservedConcurrency = Math.max(
      report.maximumObservedConcurrency,
      permits.active,
    );
    report.maximumReservedTokens = Math.max(
      report.maximumReservedTokens,
      permits.reservedTokens,
    );
    const settled = await Promise.allSettled(claimed.map(
      async ({ task, permit }) => {
        try {
          return await executeOneRevalidationTask(task, options);
        } finally {
          permit.release();
        }
      },
    ));
    let unexpected: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        mergeOutcome(report, result.value);
      } else {
        unexpected ??= result.reason;
      }
    }
    if (unexpected !== undefined) {
      throw unexpected;
    }
  }

  return {
    ...report,
    wallTimeMs: performance.now() - startedAt,
  };
}

export function emptyRevalidationDrainReport(): RevalidationDrainReport {
  const report = mutableReport();
  return {
    claimed: report.claimed,
    noop: report.noop,
    repaired: report.repaired,
    retranslated: report.retranslated,
    warning: report.warning,
    modelCalls: report.modelCalls,
    modelDurationMs: report.modelDurationMs,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    cacheReadTokens: report.cacheReadTokens,
    cacheWriteTokens: report.cacheWriteTokens,
    reasoningTokens: report.reasoningTokens,
    totalTokens: report.totalTokens,
    tokenUsageComplete: report.tokenUsageComplete,
    wallTimeMs: 0,
  };
}

export function mergeRevalidationDrainReports(
  left: RevalidationDrainReport,
  right: RevalidationDrainReport,
): RevalidationDrainReport {
  return {
    claimed: left.claimed + right.claimed,
    noop: left.noop + right.noop,
    repaired: left.repaired + right.repaired,
    retranslated: left.retranslated + right.retranslated,
    warning: left.warning + right.warning,
    modelCalls: left.modelCalls + right.modelCalls,
    modelDurationMs: left.modelDurationMs + right.modelDurationMs,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    tokenUsageComplete:
      left.tokenUsageComplete && right.tokenUsageComplete,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

/**
 * Compatibility drain for off and shadow modes. It retains the original
 * durable claim order while sharing the exact same one-task state machine as
 * the active executor.
 */
export async function drainKnowledgeRevalidationTasks(
  options: RevalidationDrainOptions,
): Promise<RevalidationDrainReport> {
  positiveInteger(options.maxAttempts, "revalidation maxAttempts");
  const startedAt = performance.now();
  const report = mutableReport();
  while (true) {
    const task = options.store.claimNextRevalidationTask(
      options.runId,
      options.maxAttempts,
    );
    if (task === undefined) break;
    report.claimed += 1;
    const outcome = await executeOneRevalidationTask(task, options);
    mergeOutcome(report, outcome);
  }
  const drain: RevalidationDrainReport = {
    claimed: report.claimed,
    noop: report.noop,
    repaired: report.repaired,
    retranslated: report.retranslated,
    warning: report.warning,
    modelCalls: report.modelCalls,
    modelDurationMs: report.modelDurationMs,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    cacheReadTokens: report.cacheReadTokens,
    cacheWriteTokens: report.cacheWriteTokens,
    reasoningTokens: report.reasoningTokens,
    totalTokens: report.totalTokens,
    tokenUsageComplete: report.tokenUsageComplete,
    wallTimeMs: performance.now() - startedAt,
  };
  return drain;
}
