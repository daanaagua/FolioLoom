import type {
  OptimizationProfile,
  SchedulerMode,
} from "./optimization-policy.js";
import {
  planRollingHorizon,
  type PlannedTaskDispatch,
  type RollingPlannerInput,
  type RollingPlannerResult,
  type TaskExecutionVariant,
} from "./rolling-horizon-planner.js";
import type { OnlineRuntimeCostModel } from "./runtime-cost-model.js";
import { TaskGraphIntegrityError } from "./task-graph.js";
import type { RuntimeProfileStore } from "../storage/runtime-profile-store.js";

export interface DynamicSchedulerOptions {
  readonly mode: SchedulerMode;
  readonly profile: OptimizationProfile;
  readonly planner: typeof planRollingHorizon;
  readonly costModel: OnlineRuntimeCostModel;
  readonly profileStore?: RuntimeProfileStore;
}

export interface DynamicSchedulerDecisionMetadata {
  readonly decisionId: string;
  readonly runId: string;
  readonly createdAt: string;
}

export interface DynamicSchedulerDispatchOptions {
  readonly legacyTaskIds: readonly string[];
  readonly legacyVariants?: readonly TaskExecutionVariant[];
  readonly decision?: DynamicSchedulerDecisionMetadata;
}

export interface SchedulerDispatchReport {
  readonly mode: SchedulerMode;
  readonly planningStatus:
    | "disabled"
    | "shadow"
    | "optimal"
    | "bounded"
    | "fallback";
  readonly plannerDeadlineReached: boolean;
  readonly dispatchedTaskIds: readonly string[];
  readonly dispatchedVariants: readonly PlannedTaskDispatch[];
  readonly predictedWallTimeMs: number;
  readonly predictedTokens: number;
  readonly validatorsSkipped: 0;
  readonly contextProfiles: Readonly<Record<
    "lean" | "balanced" | "rich",
    number
  >>;
  readonly shadowDecision?: RollingPlannerResult;
  readonly fallbackReason?: string;
}

export interface SchedulerRunReport {
  readonly mode: SchedulerMode;
  readonly profile: OptimizationProfile;
  readonly planningStatus: SchedulerDispatchReport["planningStatus"];
  readonly decisions: number;
  readonly fallbacks: number;
  readonly baselineWallTimeMs: number;
  readonly predictedWallTimeMs: number;
  readonly actualWallTimeMs: number;
  readonly baselineTokens: number;
  readonly allowedTokens: number;
  readonly predictedTokens: number;
  readonly actualTokens: number;
  readonly tokenUsageComplete: boolean;
  readonly contextProfiles: Readonly<Record<
    string,
    "lean" | "balanced" | "rich"
  >>;
  readonly effortCounts: Readonly<Record<string, number>>;
  readonly protocolCounts: Readonly<Record<
    "typed_tool" | "framed_text" | "local",
    number
  >>;
  readonly plannerDeadlines: number;
  readonly throttles: number;
  readonly recoveries: number;
}

function variantsById(
  variants: readonly TaskExecutionVariant[],
): ReadonlyMap<string, TaskExecutionVariant> {
  return new Map(variants.map((variant) => [variant.variantId, variant]));
}

function firstVariantByTaskId(
  variants: readonly TaskExecutionVariant[],
): ReadonlyMap<string, TaskExecutionVariant> {
  const result = new Map<string, TaskExecutionVariant>();
  for (const variant of [...variants].sort((left, right) =>
    left.variantId.localeCompare(right.variantId, "en"))) {
    if (!result.has(variant.taskId)) {
      result.set(variant.taskId, variant);
    }
  }
  return result;
}

function legacyDispatch(
  input: RollingPlannerInput,
  taskIds: readonly string[],
  legacyVariants: readonly TaskExecutionVariant[] = [],
): readonly PlannedTaskDispatch[] {
  const variantByTaskId = firstVariantByTaskId(input.variants);
  const legacyVariantByTaskId = firstVariantByTaskId(legacyVariants);
  return taskIds.map((taskId) => ({
    taskId,
    variantId: legacyVariantByTaskId.get(taskId)?.variantId
      ?? variantByTaskId.get(taskId)?.variantId
      ?? "",
  }));
}

function contextProfileCounts(
  input: RollingPlannerInput,
  dispatch: readonly PlannedTaskDispatch[],
  legacyVariants: readonly TaskExecutionVariant[] = [],
): Readonly<Record<"lean" | "balanced" | "rich", number>> {
  const result = { lean: 0, balanced: 0, rich: 0 };
  const variantById = variantsById([
    ...input.variants,
    ...legacyVariants,
  ]);
  const variantByTaskId = firstVariantByTaskId(input.variants);
  for (const item of dispatch) {
    const variant = variantById.get(item.variantId)
      ?? variantByTaskId.get(item.taskId);
    if (variant !== undefined) {
      result[variant.contextProfile] += 1;
    }
  }
  return Object.freeze(result);
}

function legacyProjection(
  input: RollingPlannerInput,
  dispatch: readonly PlannedTaskDispatch[],
  legacyVariants: readonly TaskExecutionVariant[] = [],
): {
  readonly wallTimeMs: number;
  readonly totalTokens: number;
} {
  const variantById = variantsById([
    ...input.variants,
    ...legacyVariants,
  ]);
  const variantByTaskId = firstVariantByTaskId(input.variants);
  const selected = dispatch
    .map((item) =>
      variantById.get(item.variantId) ?? variantByTaskId.get(item.taskId))
    .filter((variant): variant is TaskExecutionVariant =>
      variant !== undefined);
  return {
    wallTimeMs: selected.reduce(
      (maximum, variant) =>
        Math.max(maximum, variant.predicted.p90DurationMs),
      0,
    ),
    totalTokens: selected.reduce(
      (total, variant) => total + variant.predicted.totalTokens,
      0,
    ),
  };
}

function legacyDispatchWithinTokenEnvelope(
  input: RollingPlannerInput,
  dispatch: readonly PlannedTaskDispatch[],
  legacyVariants: readonly TaskExecutionVariant[] = [],
): readonly PlannedTaskDispatch[] {
  const allowedTokens = Math.floor(
    input.runBaselineTotalTokens
      + input.runBaselineTotalTokens * input.policy.tokenIncreaseCap
      + Number.EPSILON,
  );
  let remainingTokens = allowedTokens
    - input.actualRunTokens
    - input.runningReservedTokens;
  if (remainingTokens <= 0) return [];

  const variantById = variantsById([
    ...input.variants,
    ...legacyVariants,
  ]);
  const selected: PlannedTaskDispatch[] = [];
  for (const item of dispatch) {
    const variant = variantById.get(item.variantId);
    if (variant === undefined
      || variant.predicted.totalTokens > remainingTokens) {
      break;
    }
    selected.push(item);
    remainingTokens -= variant.predicted.totalTokens;
  }
  return selected;
}

export class DynamicScheduler {
  readonly mode: SchedulerMode;
  readonly profile: OptimizationProfile;
  readonly costModel: OnlineRuntimeCostModel;
  readonly #planner: typeof planRollingHorizon;
  readonly #profileStore?: RuntimeProfileStore;

  constructor(options: DynamicSchedulerOptions) {
    this.mode = options.mode;
    this.profile = options.profile;
    this.costModel = options.costModel;
    this.#planner = options.planner;
    this.#profileStore = options.profileStore;
  }

  dispatch(
    input: RollingPlannerInput,
    options: DynamicSchedulerDispatchOptions,
  ): SchedulerDispatchReport {
    const legacyVariants = options.legacyVariants ?? [];
    const legacy = legacyDispatch(
      input,
      options.legacyTaskIds,
      legacyVariants,
    );
    const legacyPrediction = legacyProjection(
      input,
      legacy,
      legacyVariants,
    );
    if (this.mode === "off") {
      return Object.freeze({
        mode: this.mode,
        planningStatus: "disabled",
        plannerDeadlineReached: false,
        dispatchedTaskIds: Object.freeze([...options.legacyTaskIds]),
        dispatchedVariants: Object.freeze(legacy),
        predictedWallTimeMs: legacyPrediction.wallTimeMs,
        predictedTokens: legacyPrediction.totalTokens,
        validatorsSkipped: 0,
        contextProfiles: contextProfileCounts(
          input,
          legacy,
          legacyVariants,
        ),
      });
    }

    try {
      const decision = this.#planner(input);
      const plannedDispatch = decision.firstDispatch;
      const useLegacy = this.mode === "shadow";
      const selectedDispatch = useLegacy ? legacy : plannedDispatch;
      const report: SchedulerDispatchReport = Object.freeze({
        mode: this.mode,
        planningStatus: this.mode === "shadow"
          ? "shadow"
          : decision.planningStatus,
        plannerDeadlineReached: decision.deadlineReached,
        dispatchedTaskIds: Object.freeze(
          selectedDispatch.map((item) => item.taskId),
        ),
        dispatchedVariants: Object.freeze([...selectedDispatch]),
        predictedWallTimeMs: decision.predictedWallTimeMs,
        predictedTokens: decision.predictedTotalTokens,
        validatorsSkipped: 0,
        contextProfiles: contextProfileCounts(
          input,
          this.mode === "shadow"
            ? (plannedDispatch.length > 0 ? plannedDispatch : legacy)
            : selectedDispatch,
          legacyVariants,
        ),
        ...(this.mode === "shadow" ? { shadowDecision: decision } : {}),
        ...(decision.planningStatus === "fallback"
          ? { fallbackReason: "NO_LEGAL_PLAN" }
          : {}),
      });
      this.#recordDecision(report, options);
      return report;
    } catch (error) {
      if (error instanceof TaskGraphIntegrityError) {
        throw error;
      }
      const boundedLegacy = this.mode === "active"
        ? legacyDispatchWithinTokenEnvelope(
          input,
          legacy,
          legacyVariants,
        )
        : legacy;
      const legacyPrediction = legacyProjection(
        input,
        boundedLegacy,
        legacyVariants,
      );
      const envelopeExhausted = legacy.length > 0
        && boundedLegacy.length === 0;
      const report: SchedulerDispatchReport = Object.freeze({
        mode: this.mode,
        planningStatus: "fallback",
        plannerDeadlineReached: false,
        dispatchedTaskIds: Object.freeze(
          boundedLegacy.map((item) => item.taskId),
        ),
        dispatchedVariants: Object.freeze([...boundedLegacy]),
        predictedWallTimeMs: legacyPrediction.wallTimeMs,
        predictedTokens: legacyPrediction.totalTokens,
        validatorsSkipped: 0,
        contextProfiles: contextProfileCounts(
          input,
          boundedLegacy,
          legacyVariants,
        ),
        fallbackReason: envelopeExhausted
          ? "TOKEN_ENVELOPE_EXHAUSTED"
          : "PLANNER_FAILED",
      });
      this.#recordDecision(report, options);
      return report;
    }
  }

  #recordDecision(
    report: SchedulerDispatchReport,
    options: DynamicSchedulerDispatchOptions,
  ): void {
    if (this.#profileStore === undefined || options.decision === undefined) {
      return;
    }
    this.#profileStore.appendDecision({
      ...options.decision,
      mode: this.mode,
      profile: this.profile,
      predicted: {
        durationMs: report.predictedWallTimeMs,
        totalTokens: report.predictedTokens,
      },
      selected: {
        taskIds: report.shadowDecision?.firstDispatch.map(
          (dispatch) => dispatch.taskId,
        ) ?? report.dispatchedTaskIds,
        concurrency: Math.max(
          1,
          report.shadowDecision?.firstDispatch.length
            ?? report.dispatchedTaskIds.length,
        ),
      },
    });
  }
}
