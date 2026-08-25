import { performance } from "node:perf_hooks";

import type { OptimizationPolicy } from "./optimization-policy.js";
import type { RuntimePrediction } from "./runtime-cost-model.js";
import type {
  SchedulerTask,
  SchedulerTaskGraph,
} from "./task-graph.js";

export interface TaskExecutionVariant {
  readonly variantId: string;
  readonly taskId: string;
  readonly contextProfile: "lean" | "balanced" | "rich";
  readonly effort: string;
  readonly effortRank: number;
  readonly protocol: "typed_tool" | "framed_text" | "local";
  readonly validators: readonly string[];
  readonly predicted: RuntimePrediction;
}

export interface RunningTaskReservation {
  readonly taskId: string;
  readonly variantId: string;
  readonly remainingP90DurationMs: number;
  readonly reservedTokens: number;
}

export interface RollingPlannerInput {
  readonly graph: SchedulerTaskGraph;
  readonly completedTaskIds: readonly string[];
  readonly running: readonly RunningTaskReservation[];
  readonly variants: readonly TaskExecutionVariant[];
  readonly policy: OptimizationPolicy;
  readonly runBaselineTotalTokens: number;
  readonly actualRunTokens: number;
  readonly runningReservedTokens: number;
  readonly horizonBaselineTokens: number;
  readonly maxConcurrency: number;
  readonly maxInFlightTokens: number;
  readonly clock?: () => number;
}

export interface PlannedTaskDispatch {
  readonly taskId: string;
  readonly variantId: string;
}

export interface RollingPlannerAction {
  readonly actionId: string;
  readonly startOffsetMs: number;
  readonly p90DurationMs: number;
  readonly totalTokens: number;
  readonly expectedReworkMs: number;
  readonly dispatch: readonly PlannedTaskDispatch[];
}

export interface RollingPlannerResult {
  readonly planningStatus: "optimal" | "bounded" | "fallback";
  readonly deadlineReached: boolean;
  readonly firstDispatch: readonly PlannedTaskDispatch[];
  readonly actions: readonly RollingPlannerAction[];
  readonly objective: number;
  readonly predictedWallTimeMs: number;
  readonly predictedTotalTokens: number;
  readonly predictedExpectedReworkMs: number;
  readonly allowedTotalTokens: number;
  readonly horizonTaskIds: readonly string[];
}

interface ValidatedInput {
  readonly graph: SchedulerTaskGraph;
  readonly completedTaskIds: readonly string[];
  readonly completedTaskIdSet: ReadonlySet<string>;
  readonly running: readonly RunningTaskReservation[];
  readonly runningTaskIds: ReadonlySet<string>;
  readonly variants: readonly TaskExecutionVariant[];
  readonly policy: OptimizationPolicy;
  readonly runBaselineTotalTokens: number;
  readonly actualRunTokens: number;
  readonly runningReservedTokens: number;
  readonly horizonBaselineTokens: number;
  readonly maxConcurrency: number;
  readonly maxInFlightTokens: number;
  readonly clock: () => number;
}

interface Batch {
  readonly actionId: string;
  readonly taskMask: number;
  readonly p90DurationMs: number;
  readonly totalTokens: number;
  readonly expectedReworkMs: number;
  readonly dispatch: readonly PlannedTaskDispatch[];
}

interface Label {
  readonly completedMask: number;
  readonly elapsedMs: number;
  readonly tokens: number;
  readonly expectedReworkMs: number;
  readonly actionKey: string;
  readonly parent?: Label;
  readonly lastBatch?: Batch;
  readonly lastStartOffsetMs?: number;
}

interface TaskPrerequisite {
  readonly horizonMask: number;
  readonly runningReadyAtMs: number;
  readonly externallyBlocked: boolean;
}

interface BatchSelection {
  readonly variants: readonly TaskExecutionVariant[];
  readonly selectedMask: number;
  readonly lastTaskIndex: number;
  readonly batch: Batch;
}

const CONTEXT_RANK = {
  lean: 0,
  balanced: 1,
  rich: 2,
} as const;

const MINIMUM_EFFORT_RANK = {
  low: 2,
  medium: 3,
  high: 4,
} as const;

const PROTOCOLS = new Set(["typed_tool", "framed_text", "local"]);
const EPSILON_TIME = 0.01;
const EPSILON_TOKENS = 0.005;
const DEADLINE_CHECK_INTERVAL = 128;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.trim().length === 0
    || /\s/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return result;
}

function finiteNonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function ratio(value: unknown, label: string): number {
  const result = finiteNonnegative(value, label);
  if (result > 1) {
    throw new TypeError(`${label} must be from zero through one`);
  }
  return result;
}

function validatedPrediction(
  raw: RuntimePrediction,
  label: string,
): RuntimePrediction {
  if (raw === null || typeof raw !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  const p50DurationMs = finiteNonnegative(
    raw.p50DurationMs,
    `${label}.p50DurationMs`,
  );
  const p90DurationMs = finiteNonnegative(
    raw.p90DurationMs,
    `${label}.p90DurationMs`,
  );
  if (p90DurationMs < p50DurationMs) {
    throw new TypeError(`${label}.p90DurationMs must be at least p50DurationMs`);
  }
  return Object.freeze({
    p50DurationMs,
    p90DurationMs,
    inputTokens: nonnegativeInteger(raw.inputTokens, `${label}.inputTokens`),
    outputTokens: nonnegativeInteger(raw.outputTokens, `${label}.outputTokens`),
    totalTokens: nonnegativeInteger(raw.totalTokens, `${label}.totalTokens`),
    failureProbability: ratio(
      raw.failureProbability,
      `${label}.failureProbability`,
    ),
    confidence: ratio(raw.confidence, `${label}.confidence`),
  });
}

function validatedPolicy(raw: OptimizationPolicy): OptimizationPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new TypeError("policy must be an object");
  }
  if (raw.profile !== "economy"
    && raw.profile !== "balanced"
    && raw.profile !== "speed") {
    throw new TypeError("policy profile is unsupported");
  }
  const horizon = positiveInteger(raw.horizon, "policy.horizon");
  if (horizon > 16) {
    throw new TypeError("policy.horizon cannot exceed 16");
  }
  const objectiveWeights = {
    time: finiteNonnegative(
      raw.objectiveWeights?.time,
      "policy.objectiveWeights.time",
    ),
    tokens: finiteNonnegative(
      raw.objectiveWeights?.tokens,
      "policy.objectiveWeights.tokens",
    ),
    rework: finiteNonnegative(
      raw.objectiveWeights?.rework,
      "policy.objectiveWeights.rework",
    ),
  };
  return Object.freeze({
    profile: raw.profile,
    tokenIncreaseCap: finiteNonnegative(
      raw.tokenIncreaseCap,
      "policy.tokenIncreaseCap",
    ),
    objectiveWeights: Object.freeze(objectiveWeights),
    horizon,
    maxParetoLabels: positiveInteger(
      raw.maxParetoLabels,
      "policy.maxParetoLabels",
    ),
    maxBatchCandidates: positiveInteger(
      raw.maxBatchCandidates,
      "policy.maxBatchCandidates",
    ),
    planningDeadlineMs: finiteNonnegative(
      raw.planningDeadlineMs,
      "policy.planningDeadlineMs",
    ),
  });
}

function validatedVariant(
  raw: TaskExecutionVariant,
  taskIds: ReadonlySet<string>,
  seenVariantIds: Set<string>,
): TaskExecutionVariant {
  if (raw === null || typeof raw !== "object") {
    throw new TypeError("variant must be an object");
  }
  const variantId = identifier(raw.variantId, "variantId");
  if (seenVariantIds.has(variantId)) {
    throw new TypeError(`duplicate variantId ${variantId}`);
  }
  seenVariantIds.add(variantId);
  const taskId = identifier(raw.taskId, `variant ${variantId} taskId`);
  if (!taskIds.has(taskId)) {
    throw new TypeError(
      `variant ${variantId} references unknown task ${taskId}`,
    );
  }
  if (!(raw.contextProfile in CONTEXT_RANK)) {
    throw new TypeError(`variant ${variantId} has invalid context profile`);
  }
  if (!PROTOCOLS.has(raw.protocol)) {
    throw new TypeError(`variant ${variantId} has invalid protocol`);
  }
  if (!Array.isArray(raw.validators)) {
    throw new TypeError(`variant ${variantId} validators must be an array`);
  }
  const validators = raw.validators.map((validator, index) =>
    identifier(validator, `variant ${variantId} validators[${index}]`));
  if (new Set(validators).size !== validators.length) {
    throw new TypeError(`variant ${variantId} contains duplicate validators`);
  }
  return Object.freeze({
    variantId,
    taskId,
    contextProfile: raw.contextProfile,
    effort: typeof raw.effort === "string" ? raw.effort : String(raw.effort),
    effortRank: finiteNonnegative(
      raw.effortRank,
      `variant ${variantId} effortRank`,
    ),
    protocol: raw.protocol,
    validators: Object.freeze([...validators].sort(compareText)),
    predicted: validatedPrediction(
      raw.predicted,
      `variant ${variantId} prediction`,
    ),
  });
}

function validateInput(input: RollingPlannerInput): ValidatedInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("rolling planner input must be an object");
  }
  const tasks = input.graph?.tasks;
  if (!Array.isArray(tasks)
    || typeof input.graph.readyTaskIds !== "function"
    || typeof input.graph.horizon !== "function"
    || typeof input.graph.tasksCompatible !== "function") {
    throw new TypeError("graph must implement SchedulerTaskGraph");
  }
  const taskIds = new Set(tasks.map((task) => task.taskId));
  if (!Array.isArray(input.completedTaskIds)) {
    throw new TypeError("completedTaskIds must be an array");
  }
  const completedTaskIds = input.completedTaskIds.map((taskId, index) =>
    identifier(taskId, `completedTaskIds[${index}]`));
  if (new Set(completedTaskIds).size !== completedTaskIds.length) {
    throw new TypeError("completedTaskIds contains duplicates");
  }
  for (const taskId of completedTaskIds) {
    if (!taskIds.has(taskId)) {
      throw new TypeError(`completed task does not exist: ${taskId}`);
    }
  }
  if (!Array.isArray(input.running)) {
    throw new TypeError("running must be an array");
  }
  const runningTaskIds = new Set<string>();
  const running = input.running.map((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      throw new TypeError(`running[${index}] must be an object`);
    }
    const taskId = identifier(raw.taskId, `running[${index}].taskId`);
    if (!taskIds.has(taskId)) {
      throw new TypeError(`running task does not exist: ${taskId}`);
    }
    if (runningTaskIds.has(taskId)) {
      throw new TypeError(`duplicate running task ${taskId}`);
    }
    if (completedTaskIds.includes(taskId)) {
      throw new TypeError(`task ${taskId} cannot be completed and running`);
    }
    runningTaskIds.add(taskId);
    return Object.freeze({
      taskId,
      variantId: identifier(
        raw.variantId,
        `running[${index}].variantId`,
      ),
      remainingP90DurationMs: finiteNonnegative(
        raw.remainingP90DurationMs,
        `running[${index}].remainingP90DurationMs`,
      ),
      reservedTokens: nonnegativeInteger(
        raw.reservedTokens,
        `running[${index}].reservedTokens`,
      ),
    });
  }).sort((left, right) =>
    left.remainingP90DurationMs - right.remainingP90DurationMs
    || compareText(left.taskId, right.taskId));
  const maxConcurrency = positiveInteger(
    input.maxConcurrency,
    "maxConcurrency",
  );
  if (running.length > maxConcurrency) {
    throw new TypeError("running reservations exceed maxConcurrency");
  }
  const maxInFlightTokens = nonnegativeInteger(
    input.maxInFlightTokens,
    "maxInFlightTokens",
  );
  const runningReservedTokens = nonnegativeInteger(
    input.runningReservedTokens,
    "runningReservedTokens",
  );
  const reservationTokenSum = running.reduce(
    (total, reservation) => total + reservation.reservedTokens,
    0,
  );
  if (reservationTokenSum !== runningReservedTokens) {
    throw new TypeError(
      "runningReservedTokens must equal reservation token total",
    );
  }
  if (runningReservedTokens > maxInFlightTokens) {
    throw new TypeError("running reservations exceed maxInFlightTokens");
  }
  if (!Array.isArray(input.variants)) {
    throw new TypeError("variants must be an array");
  }
  const seenVariantIds = new Set<string>();
  const variants = input.variants
    .map((raw) => validatedVariant(raw, taskIds, seenVariantIds))
    .sort((left, right) =>
      compareText(left.taskId, right.taskId)
      || compareText(left.variantId, right.variantId));
  const clock = input.clock ?? (() => performance.now());
  if (typeof clock !== "function") {
    throw new TypeError("clock must be a function");
  }
  return {
    graph: input.graph,
    completedTaskIds: Object.freeze(completedTaskIds),
    completedTaskIdSet: new Set(completedTaskIds),
    running: Object.freeze(running),
    runningTaskIds,
    variants: Object.freeze(variants),
    policy: validatedPolicy(input.policy),
    runBaselineTotalTokens: nonnegativeInteger(
      input.runBaselineTotalTokens,
      "runBaselineTotalTokens",
    ),
    actualRunTokens: nonnegativeInteger(
      input.actualRunTokens,
      "actualRunTokens",
    ),
    runningReservedTokens,
    horizonBaselineTokens: nonnegativeInteger(
      input.horizonBaselineTokens,
      "horizonBaselineTokens",
    ),
    maxConcurrency,
    maxInFlightTokens,
    clock,
  };
}

function variantPassesRiskGate(
  variant: TaskExecutionVariant,
  task: SchedulerTask,
): boolean {
  if (CONTEXT_RANK[variant.contextProfile]
    < CONTEXT_RANK[task.risk.minimumContextProfile]) {
    return false;
  }
  if (variant.effortRank
    < MINIMUM_EFFORT_RANK[task.risk.minimumEffort]) {
    return false;
  }
  const validators = new Set(variant.validators);
  return task.risk.requiredValidators.every((validator) =>
    validators.has(validator));
}

function predictionDominates(
  left: TaskExecutionVariant,
  right: TaskExecutionVariant,
): boolean {
  const noWorse = left.predicted.p90DurationMs
      <= right.predicted.p90DurationMs
    && left.predicted.totalTokens <= right.predicted.totalTokens
    && left.predicted.failureProbability
      <= right.predicted.failureProbability;
  if (!noWorse) return false;
  const strictlyBetter = left.predicted.p90DurationMs
      < right.predicted.p90DurationMs
    || left.predicted.totalTokens < right.predicted.totalTokens
    || left.predicted.failureProbability
      < right.predicted.failureProbability;
  return strictlyBetter
    || compareText(left.variantId, right.variantId) < 0;
}

function paretoVariants(
  variants: readonly TaskExecutionVariant[],
  task: SchedulerTask,
): readonly TaskExecutionVariant[] {
  const legal = variants.filter((variant) =>
    variantPassesRiskGate(variant, task));
  return Object.freeze(legal.filter((candidate) =>
    !legal.some((other) =>
      other !== candidate && predictionDominates(other, candidate)))
    .sort((left, right) =>
      left.predicted.p90DurationMs - right.predicted.p90DurationMs
      || left.predicted.totalTokens - right.predicted.totalTokens
      || left.predicted.failureProbability
        - right.predicted.failureProbability
      || compareText(left.variantId, right.variantId)));
}

function allowedTotalTokens(input: ValidatedInput): number {
  return Math.floor(
    input.runBaselineTotalTokens
      + input.runBaselineTotalTokens * input.policy.tokenIncreaseCap
      + Number.EPSILON,
  );
}

function labelObjective(
  label: Label,
  input: ValidatedInput,
  baselineWallTimeMs: number,
): number {
  return input.policy.objectiveWeights.time
      * (label.elapsedMs / Math.max(1, baselineWallTimeMs))
    + input.policy.objectiveWeights.tokens
      * (label.tokens / Math.max(1, input.horizonBaselineTokens))
    + input.policy.objectiveWeights.rework
      * (label.expectedReworkMs / Math.max(1, baselineWallTimeMs));
}

function compareLabels(
  left: Label,
  right: Label,
  input: ValidatedInput,
  baselineWallTimeMs: number,
): number {
  return labelObjective(left, input, baselineWallTimeMs)
    - labelObjective(right, input, baselineWallTimeMs)
    || left.tokens - right.tokens
    || compareText(left.actionKey, right.actionKey);
}

function epsilonDominates(left: Label, right: Label): boolean {
  const noWorse = left.elapsedMs <= right.elapsedMs * (1 + EPSILON_TIME)
    && left.tokens <= right.tokens * (1 + EPSILON_TOKENS)
    && left.expectedReworkMs <= right.expectedReworkMs;
  if (!noWorse) return false;
  return left.elapsedMs < right.elapsedMs
    || left.tokens < right.tokens
    || left.expectedReworkMs < right.expectedReworkMs
    || left.actionKey <= right.actionKey;
}

function addToFrontier(
  frontier: Label[],
  candidate: Label,
  input: ValidatedInput,
  baselineWallTimeMs: number,
): boolean {
  if (frontier.some((label) => epsilonDominates(label, candidate))) {
    return false;
  }
  for (let index = frontier.length - 1; index >= 0; index -= 1) {
    if (epsilonDominates(candidate, frontier[index]!)) {
      frontier.splice(index, 1);
    }
  }
  frontier.push(candidate);
  frontier.sort((left, right) =>
    compareLabels(left, right, input, baselineWallTimeMs));
  if (frontier.length > input.policy.maxParetoLabels) {
    frontier.length = input.policy.maxParetoLabels;
  }
  return frontier.includes(candidate);
}

function activeReservations(
  running: readonly RunningTaskReservation[],
  elapsedMs: number,
): readonly RunningTaskReservation[] {
  return running.filter((reservation) =>
    reservation.remainingP90DurationMs > elapsedMs);
}

function directPredecessorIds(
  graph: SchedulerTaskGraph,
  taskId: string,
): readonly string[] {
  return graph.predecessorTaskIds(taskId);
}

function taskPrerequisites(
  horizonTasks: readonly SchedulerTask[],
  input: ValidatedInput,
  taskIndexById: ReadonlyMap<string, number>,
): readonly TaskPrerequisite[] {
  const runningByTaskId = new Map(
    input.running.map((reservation) => [reservation.taskId, reservation]),
  );
  return horizonTasks.map((task) => {
    let horizonMask = 0;
    let runningReadyAtMs = 0;
    let externallyBlocked = false;
    for (const predecessorId of directPredecessorIds(
      input.graph,
      task.taskId,
    )) {
      const horizonIndex = taskIndexById.get(predecessorId);
      if (horizonIndex !== undefined) {
        horizonMask |= 1 << horizonIndex;
        continue;
      }
      const reservation = runningByTaskId.get(predecessorId);
      if (reservation !== undefined) {
        runningReadyAtMs = Math.max(
          runningReadyAtMs,
          reservation.remainingP90DurationMs,
        );
        continue;
      }
      if (!input.completedTaskIdSet.has(predecessorId)) {
        externallyBlocked = true;
      }
    }
    return {
      horizonMask,
      runningReadyAtMs,
      externallyBlocked,
    };
  });
}

function readyTaskMask(
  completedMask: number,
  elapsedMs: number,
  prerequisites: readonly TaskPrerequisite[],
): number {
  let readyMask = 0;
  for (let index = 0; index < prerequisites.length; index += 1) {
    const bit = 1 << index;
    if ((completedMask & bit) !== 0) continue;
    const prerequisite = prerequisites[index]!;
    if (!prerequisite.externallyBlocked
      && (prerequisite.horizonMask & ~completedMask) === 0
      && prerequisite.runningReadyAtMs <= elapsedMs) {
      readyMask |= bit;
    }
  }
  return readyMask;
}

function incompatibleTaskMasks(
  horizonTasks: readonly SchedulerTask[],
  graph: SchedulerTaskGraph,
): readonly number[] {
  return horizonTasks.map((task, index) => {
    let mask = 0;
    for (let otherIndex = 0; otherIndex < horizonTasks.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      if (!graph.tasksCompatible(
        task.taskId,
        horizonTasks[otherIndex]!.taskId,
      )) {
        mask |= 1 << otherIndex;
      }
    }
    return mask;
  });
}

function batchFromVariants(
  variants: readonly TaskExecutionVariant[],
  taskIndexById: ReadonlyMap<string, number>,
): Batch {
  const selected = [...variants].sort((left, right) =>
    compareText(left.taskId, right.taskId)
    || compareText(left.variantId, right.variantId));
  const dispatch = selected.map((variant) => ({
    taskId: variant.taskId,
    variantId: variant.variantId,
  }));
  const actionId = dispatch
    .map((item) => `${item.taskId}@${item.variantId}`)
    .join("+");
  return {
    actionId,
    taskMask: selected.reduce(
      (mask, variant) =>
        mask | (1 << taskIndexById.get(variant.taskId)!),
      0,
    ),
    p90DurationMs: Math.max(
      ...selected.map((variant) => variant.predicted.p90DurationMs),
    ),
    totalTokens: selected.reduce(
      (total, variant) => total + variant.predicted.totalTokens,
      0,
    ),
    expectedReworkMs: selected.reduce(
      (total, variant) =>
        total + variant.predicted.failureProbability
          * variant.predicted.p90DurationMs,
      0,
    ),
    dispatch,
  };
}

function compareBatches(
  left: Batch,
  right: Batch,
  baselineWallTimeMs: number,
  input: ValidatedInput,
): number {
  const leftCount = left.dispatch.length;
  const rightCount = right.dispatch.length;
  const leftScore = (
    input.policy.objectiveWeights.time
      * (left.p90DurationMs / Math.max(1, baselineWallTimeMs))
    + input.policy.objectiveWeights.tokens
      * (left.totalTokens / Math.max(1, input.horizonBaselineTokens))
    + input.policy.objectiveWeights.rework
      * (left.expectedReworkMs / Math.max(1, baselineWallTimeMs))
  ) / leftCount;
  const rightScore = (
    input.policy.objectiveWeights.time
      * (right.p90DurationMs / Math.max(1, baselineWallTimeMs))
    + input.policy.objectiveWeights.tokens
      * (right.totalTokens / Math.max(1, input.horizonBaselineTokens))
    + input.policy.objectiveWeights.rework
      * (right.expectedReworkMs / Math.max(1, baselineWallTimeMs))
  ) / rightCount;
  return rightCount - leftCount
    || leftScore - rightScore
    || left.totalTokens - right.totalTokens
    || compareText(left.actionId, right.actionId);
}

function enumerateBatches(
  readyTaskMask: number,
  variantsByTaskIndex: readonly (readonly TaskExecutionVariant[])[],
  taskIndexById: ReadonlyMap<string, number>,
  incompatibleMasks: readonly number[],
  freeSlots: number,
  availableInFlightTokens: number,
  baselineWallTimeMs: number,
  input: ValidatedInput,
): readonly Batch[] {
  if (freeSlots <= 0 || readyTaskMask === 0) return [];
  const beamLimit = Math.max(
    input.policy.maxBatchCandidates * 8,
    128,
  );
  let level: BatchSelection[] = [];
  const allBatches: Batch[] = [];
  for (let taskIndex = 0; taskIndex < variantsByTaskIndex.length; taskIndex += 1) {
    if ((readyTaskMask & (1 << taskIndex)) === 0) continue;
    for (const variant of variantsByTaskIndex[taskIndex] ?? []) {
      if (variant.predicted.totalTokens > availableInFlightTokens) continue;
      const variants = [variant];
      const batch = batchFromVariants(variants, taskIndexById);
      level.push({
        variants,
        selectedMask: 1 << taskIndex,
        lastTaskIndex: taskIndex,
        batch,
      });
    }
  }
  level.sort((left, right) =>
    compareBatches(left.batch, right.batch, baselineWallTimeMs, input));
  if (level.length > beamLimit) level.length = beamLimit;
  allBatches.push(...level.map((selection) => selection.batch));

  for (
    let selectedCount = 2;
    selectedCount <= freeSlots && level.length > 0;
    selectedCount += 1
  ) {
    const nextById = new Map<string, BatchSelection>();
    for (const partial of level) {
      for (
        let taskIndex = partial.lastTaskIndex + 1;
        taskIndex < variantsByTaskIndex.length;
        taskIndex += 1
      ) {
        const taskBit = 1 << taskIndex;
        if ((readyTaskMask & taskBit) === 0
          || ((incompatibleMasks[taskIndex] ?? 0)
            & partial.selectedMask) !== 0) {
          continue;
        }
        for (const variant of variantsByTaskIndex[taskIndex] ?? []) {
          if (partial.batch.totalTokens + variant.predicted.totalTokens
            > availableInFlightTokens) {
            continue;
          }
          const variants = [...partial.variants, variant];
          const batch = batchFromVariants(variants, taskIndexById);
          nextById.set(batch.actionId, {
            variants,
            selectedMask: partial.selectedMask | taskBit,
            lastTaskIndex: taskIndex,
            batch,
          });
        }
      }
    }
    level = [...nextById.values()].sort((left, right) =>
      compareBatches(left.batch, right.batch, baselineWallTimeMs, input));
    if (level.length > beamLimit) level.length = beamLimit;
    allBatches.push(...level.map((selection) => selection.batch));
  }
  const unique = new Map(
    allBatches.map((batch) => [batch.actionId, batch]),
  );
  return [...unique.values()]
    .sort((left, right) =>
      compareBatches(left, right, baselineWallTimeMs, input));
}

function feasibleBatchesForState(
  pool: readonly Batch[],
  readyMask: number,
  freeSlots: number,
  availableInFlightTokens: number,
  limit: number,
): readonly Batch[] {
  const selected: Batch[] = [];
  let maximumBatchSize = 0;
  for (const batch of pool) {
    const batchSize = batch.dispatch.length;
    if (batchSize > freeSlots
      || batch.totalTokens > availableInFlightTokens
      || (batch.taskMask & readyMask) !== batch.taskMask) {
      continue;
    }
    if (maximumBatchSize === 0) {
      maximumBatchSize = batchSize;
    } else if (batchSize < maximumBatchSize) {
      break;
    }
    selected.push(batch);
    if (selected.length >= limit) break;
  }
  return selected;
}

function popcount(value: number): number {
  let count = 0;
  let remaining = value;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function comparePartialLabels(
  left: Label,
  right: Label,
  input: ValidatedInput,
  baselineWallTimeMs: number,
): number {
  const leftProgress = popcount(left.completedMask);
  const rightProgress = popcount(right.completedMask);
  const leftScore = labelObjective(left, input, baselineWallTimeMs)
    / Math.max(1, leftProgress);
  const rightScore = labelObjective(right, input, baselineWallTimeMs)
    / Math.max(1, rightProgress);
  return leftScore - rightScore
    || rightProgress - leftProgress
    || compareText(left.actionKey, right.actionKey);
}

function actionsForLabel(label: Label): readonly RollingPlannerAction[] {
  const reversed: RollingPlannerAction[] = [];
  let current: Label | undefined = label;
  while (current !== undefined
    && current.lastBatch !== undefined
    && current.lastStartOffsetMs !== undefined) {
    const batch = current.lastBatch;
    reversed.push({
      actionId: batch.actionId,
      startOffsetMs: current.lastStartOffsetMs,
      p90DurationMs: batch.p90DurationMs,
      totalTokens: batch.totalTokens,
      expectedReworkMs: batch.expectedReworkMs,
      dispatch: batch.dispatch,
    });
    current = current.parent;
  }
  reversed.reverse();
  return reversed;
}

function scheduleAroundReservations(
  actions: readonly RollingPlannerAction[],
  input: ValidatedInput,
): readonly RollingPlannerAction[] {
  if (input.running.length === 0 || actions.length === 0) {
    return actions;
  }
  const completionByTaskId = new Map<string, number>(
    input.completedTaskIds.map((taskId) => [taskId, 0]),
  );
  const occupancies: Array<{
    readonly endMs: number;
    readonly slots: number;
    readonly tokens: number;
  }> = input.running.map((reservation) => {
    completionByTaskId.set(
      reservation.taskId,
      reservation.remainingP90DurationMs,
    );
    return {
      endMs: reservation.remainingP90DurationMs,
      slots: 1,
      tokens: reservation.reservedTokens,
    };
  });
  const scheduled: RollingPlannerAction[] = [];
  let priorStartMs = 0;
  for (const action of actions) {
    let earliestStartMs = priorStartMs;
    let dependenciesKnown = true;
    for (const dispatch of action.dispatch) {
      for (const predecessorId of input.graph.predecessorTaskIds(
        dispatch.taskId,
      )) {
        const completedAt = completionByTaskId.get(predecessorId);
        if (completedAt === undefined) {
          dependenciesKnown = false;
          break;
        }
        earliestStartMs = Math.max(earliestStartMs, completedAt);
      }
    }
    if (!dependenciesKnown) {
      earliestStartMs = Math.max(earliestStartMs, action.startOffsetMs);
    }
    const eventTimes = [...new Set([
      earliestStartMs,
      ...occupancies
        .map((occupancy) => occupancy.endMs)
        .filter((endMs) => endMs >= earliestStartMs),
    ])].sort((left, right) => left - right);
    let startOffsetMs = eventTimes.at(-1) ?? earliestStartMs;
    for (const eventTime of eventTimes) {
      const active = occupancies.filter((occupancy) =>
        occupancy.endMs > eventTime);
      const occupiedSlots = active.reduce(
        (total, occupancy) => total + occupancy.slots,
        0,
      );
      const occupiedTokens = active.reduce(
        (total, occupancy) => total + occupancy.tokens,
        0,
      );
      if (occupiedSlots + action.dispatch.length <= input.maxConcurrency
        && occupiedTokens + action.totalTokens
          <= input.maxInFlightTokens) {
        startOffsetMs = eventTime;
        break;
      }
    }
    const endMs = startOffsetMs + action.p90DurationMs;
    occupancies.push({
      endMs,
      slots: action.dispatch.length,
      tokens: action.totalTokens,
    });
    for (const dispatch of action.dispatch) {
      completionByTaskId.set(dispatch.taskId, endMs);
    }
    scheduled.push({ ...action, startOffsetMs });
    priorStartMs = startOffsetMs;
  }
  return scheduled;
}

function scheduledWallTime(
  label: Label,
  input: ValidatedInput,
): number {
  const actions = scheduleAroundReservations(actionsForLabel(label), input);
  const actionCompletion = actions.reduce(
    (maximum, action) =>
      Math.max(maximum, action.startOffsetMs + action.p90DurationMs),
    0,
  );
  return input.running.reduce(
    (maximum, reservation) =>
      Math.max(maximum, reservation.remainingP90DurationMs),
    actionCompletion,
  );
}

function resultFromLabel(
  status: RollingPlannerResult["planningStatus"],
  label: Label,
  input: ValidatedInput,
  baselineWallTimeMs: number,
  allowedTokens: number,
  horizonTaskIds: readonly string[],
  transitionCount: number,
  deadlineReached = false,
): RollingPlannerResult {
  const actions = scheduleAroundReservations(
    actionsForLabel(label),
    input,
  );
  const predictedWallTimeMs = input.running.reduce(
    (maximum, reservation) =>
      Math.max(maximum, reservation.remainingP90DurationMs),
    actions.reduce(
      (maximum, action) =>
        Math.max(
          maximum,
          action.startOffsetMs + action.p90DurationMs,
        ),
      0,
    ),
  );
  const firstAction = actions[0];
  const firstDispatch = firstAction?.startOffsetMs === 0
    ? firstAction.dispatch
    : [];
  return Object.freeze({
    planningStatus: status,
    deadlineReached,
    firstDispatch: Object.freeze([...firstDispatch]),
    actions: Object.freeze(actions.map((action) => Object.freeze(action))),
    objective: labelObjective(
      { ...label, elapsedMs: predictedWallTimeMs },
      input,
      baselineWallTimeMs,
    ),
    predictedWallTimeMs,
    predictedTotalTokens: input.actualRunTokens
      + input.runningReservedTokens
      + label.tokens,
    predictedExpectedReworkMs: label.expectedReworkMs,
    allowedTotalTokens: allowedTokens,
    horizonTaskIds: Object.freeze([...horizonTaskIds]),
  });
}

function fallbackResult(
  input: ValidatedInput,
  allowedTokens: number,
  horizonTaskIds: readonly string[],
  transitionCount: number,
): RollingPlannerResult {
  const empty: Label = {
    completedMask: 0,
    elapsedMs: 0,
    tokens: 0,
    expectedReworkMs: 0,
    actionKey: "",
  };
  return resultFromLabel(
    "fallback",
    empty,
    input,
    1,
    allowedTokens,
    horizonTaskIds,
    transitionCount,
  );
}

export function planRollingHorizon(
  rawInput: RollingPlannerInput,
): RollingPlannerResult {
  const input = validateInput(rawInput);
  const planningStarted = input.clock();
  if (!Number.isFinite(planningStarted)) {
    throw new TypeError("clock must return finite milliseconds");
  }
  const horizonTasks = input.graph.horizon(
    [...input.completedTaskIds, ...input.runningTaskIds],
    input.policy.horizon,
  );
  const horizonTaskIds = horizonTasks.map((task) => task.taskId);
  const taskIndexById = new Map(
    horizonTasks.map((task, index) => [task.taskId, index]),
  );
  const variantsByRawTaskId = new Map<string, TaskExecutionVariant[]>();
  for (const variant of input.variants) {
    const taskVariants = variantsByRawTaskId.get(variant.taskId) ?? [];
    taskVariants.push(variant);
    variantsByRawTaskId.set(variant.taskId, taskVariants);
  }
  const variantsByTaskId = new Map<string, readonly TaskExecutionVariant[]>();
  for (const task of horizonTasks) {
    variantsByTaskId.set(
      task.taskId,
      paretoVariants(
        variantsByRawTaskId.get(task.taskId) ?? [],
        task,
      ),
    );
  }
  const variantsByTaskIndex = horizonTasks.map((task) =>
    variantsByTaskId.get(task.taskId) ?? []);
  const prerequisites = taskPrerequisites(
    horizonTasks,
    input,
    taskIndexById,
  );
  const incompatibleMasks = incompatibleTaskMasks(
    horizonTasks,
    input.graph,
  );
  const baselineWallTimeMs = horizonTasks.reduce((total, task) => {
    const variants = variantsByTaskId.get(task.taskId) ?? [];
    return total + variants.reduce(
      (maximum, variant) =>
        Math.max(maximum, variant.predicted.p90DurationMs),
      0,
    );
  }, 0);
  const allowedTokens = allowedTotalTokens(input);
  const fullMask = (1 << horizonTasks.length) - 1;
  if (fullMask === 0) {
    return resultFromLabel(
      "optimal",
      {
        completedMask: 0,
        elapsedMs: 0,
        tokens: 0,
        expectedReworkMs: 0,
        actionKey: "",
      },
      input,
      Math.max(1, baselineWallTimeMs),
      allowedTokens,
      horizonTaskIds,
      0,
    );
  }
  const candidateBatchPool = enumerateBatches(
    fullMask,
    variantsByTaskIndex,
    taskIndexById,
    incompatibleMasks,
    input.maxConcurrency,
    input.maxInFlightTokens,
    Math.max(1, baselineWallTimeMs),
    input,
  );

  const frontiers: Array<Label[] | undefined> = new Array(fullMask + 1);
  frontiers[0] = [{
    completedMask: 0,
    elapsedMs: 0,
    tokens: 0,
    expectedReworkMs: 0,
    actionKey: "",
  }];
  const stateBatchCache = new Map<string, readonly Batch[]>();
  let bestPartial: Label | undefined;
  let transitionCount = 0;
  let deadlineReached = false;

  outer:
  for (let mask = 0; mask <= fullMask; mask += 1) {
    const labels = frontiers[mask];
    if (labels === undefined) continue;
    for (const rawLabel of [...labels]) {
      if (mask === fullMask) continue;
      let label = rawLabel;
      let batches: readonly Batch[] = [];
      while (true) {
        const active = activeReservations(input.running, label.elapsedMs);
        const readyMask = readyTaskMask(
          mask,
          label.elapsedMs,
          prerequisites,
        );
        const freeSlots = input.maxConcurrency - active.length;
        const availableInFlightTokens = input.maxInFlightTokens
          - active.reduce(
            (total, reservation) => total + reservation.reservedTokens,
            0,
          );
        const stateBatchKey = `${readyMask}:${freeSlots}:${availableInFlightTokens}`;
        batches = stateBatchCache.get(stateBatchKey)
          ?? feasibleBatchesForState(
            candidateBatchPool,
            readyMask,
            freeSlots,
            availableInFlightTokens,
            input.policy.maxBatchCandidates,
          );
        stateBatchCache.set(stateBatchKey, batches);
        if (batches.length > 0) break;
        const nextReservation = active[0];
        if (nextReservation === undefined) break;
        label = {
          ...label,
          elapsedMs: nextReservation.remainingP90DurationMs,
        };
      }

      for (const batch of batches) {
        const nextTokens = label.tokens + batch.totalTokens;
        if (input.actualRunTokens
          + input.runningReservedTokens
          + nextTokens > allowedTokens) {
          continue;
        }
        const next: Label = {
          completedMask: mask | batch.taskMask,
          elapsedMs: label.elapsedMs + batch.p90DurationMs,
          tokens: nextTokens,
          expectedReworkMs: label.expectedReworkMs
            + batch.expectedReworkMs,
          actionKey: label.actionKey.length === 0
            ? batch.actionId
            : `${label.actionKey}|${batch.actionId}`,
          parent: label,
          lastBatch: batch,
          lastStartOffsetMs: label.elapsedMs,
        };
        const nextFrontier = frontiers[next.completedMask] ?? [];
        if (addToFrontier(
          nextFrontier,
          next,
          input,
          Math.max(1, baselineWallTimeMs),
        )) {
          frontiers[next.completedMask] = nextFrontier;
          if (bestPartial === undefined
            || comparePartialLabels(
              next,
              bestPartial,
              input,
              Math.max(1, baselineWallTimeMs),
            ) < 0) {
            bestPartial = next;
          }
        }
        transitionCount += 1;
        if (transitionCount % DEADLINE_CHECK_INTERVAL === 0) {
          const now = input.clock();
          if (!Number.isFinite(now)) {
            throw new TypeError("clock must return finite milliseconds");
          }
          if (now - planningStarted >= input.policy.planningDeadlineMs) {
            deadlineReached = true;
            break outer;
          }
        }
      }
    }
  }

  const completeLabels = frontiers[fullMask] ?? [];
  if (completeLabels.length > 0) {
    const completed = completeLabels
      .map((label) => ({
        ...label,
        elapsedMs: scheduledWallTime(label, input),
      }))
      .sort((left, right) =>
        compareLabels(
          left,
          right,
          input,
          Math.max(1, baselineWallTimeMs),
        ))[0]!;
    return resultFromLabel(
      deadlineReached ? "bounded" : "optimal",
      completed,
      input,
      Math.max(1, baselineWallTimeMs),
      allowedTokens,
      horizonTaskIds,
      transitionCount,
      deadlineReached,
    );
  }
  if (bestPartial !== undefined) {
    return resultFromLabel(
      "bounded",
      bestPartial,
      input,
      Math.max(1, baselineWallTimeMs),
      allowedTokens,
      horizonTaskIds,
      transitionCount,
      deadlineReached,
    );
  }
  return fallbackResult(
    input,
    allowedTokens,
    horizonTaskIds,
    transitionCount,
  );
}
