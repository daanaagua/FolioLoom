import { createHash, randomBytes } from "node:crypto";

import {
  ModelProviderError,
  type PiRunResult,
} from "../agents/pi-runtime.js";
import {
  runTranslationBatch,
  validateTranslationBatchCandidate,
  type TranslationBatchResult,
  type TranslationBatchWindowResult,
  type TranslationProviderResponseEvidence,
} from "../agents/translation-batch.js";
import {
  expectedTermOccurrencesForTranslationInput,
  narrowSelectedKnowledgeToTranslationWireInput,
  type TranslationRequestInput,
} from "../agents/translation-request.js";
import {
  BudgetLedger,
  DEFAULT_BUDGET_LIMITS,
} from "../kernel/budget.js";
import type { SourceLanguageProfile } from "../language/types.js";
import type { LosslessBlock } from "../source/types.js";
import {
  type UsageObservation,
  type WeightedTokenEstimator,
} from "../source/token-estimator.js";
import type { SchedulerObservationStatus } from "./adaptive-scheduler.js";
import {
  AdmissionController,
  BookTokenEnvelopeExceededError,
} from "./admission-controller.js";
import { packPhysicalRequests } from "./request-batcher.js";
import {
  RequestBudgeter,
  type RequestBudgetAssessment,
} from "./request-budgeter.js";
import { coldStartReasoningUpperBound } from "./budget-oracle.js";
import {
  assembleParagraphFragmentCandidates,
  paragraphFragmentExecutionScope,
  paragraphFragmentFirstRequired,
  planParagraphFragments,
  sourceParagraphSpans,
  type ParagraphFragmentCandidate,
  type ParagraphFragmentPlan,
  type ParagraphFragmentUnit,
} from "./paragraph-fragment.js";
import type { RuntimeFeatures } from "./runtime-cost-model.js";
import type { TaskExecutionVariant } from "./rolling-horizon-planner.js";
import {
  normalizeRuntimeUsage,
  type NormalizedRuntimeUsage,
  type RuntimeObservationStatus,
} from "./runtime-telemetry.js";
import type {
  PhysicalRequestPlan,
  RequestBatchWindow,
  TranslationRuntime,
  TranslationRuntimeSet,
} from "./types.js";

export class BookRequestCapacityError extends Error {
  readonly code = "REQUEST_CONTEXT_EXCEEDED" as const;
  readonly retryable = false;

  constructor(
    requestId: string,
    assessment: RequestBudgetAssessment,
    detail?: string,
  ) {
    super(
      `REQUEST_CONTEXT_EXCEEDED: ${requestId} reserves ${assessment.totalReserved} tokens `
      + `for a ${assessment.contextWindowTokens}-token context`
      + (detail === undefined ? "" : ` (${detail})`),
    );
    this.name = "BookRequestCapacityError";
  }
}

const CONTEXT_FRAGMENT_PROTOCOL_VERSION = "v5-context-fragment-1";
export const MAX_CONTEXT_SPLIT_DEPTH = 16;
export const MAX_CONTEXT_SPLIT_ATTEMPTS = 32;
export const MAX_PROTOCOL_SPLIT_ATTEMPTS = 16;
export const MAX_TARGETED_REPAIRS_PER_REQUEST = 3;

export interface AdmittedRequestFragment<TInput> {
  request: PhysicalRequestPlan;
  input: TInput;
  assessment: RequestBudgetAssessment;
  /** Every split raises this number, so recovery cannot re-enqueue the same shape forever. */
  depth: number;
  readonly paragraphPlan?: ParagraphFragmentPlan;
  readonly paragraphUnit?: ParagraphFragmentUnit;
  /** Balanced local bisection tree; only a failed node descends into its children. */
  readonly paragraphRefinements?: readonly AdmittedRequestFragment<TInput>[];
}

export interface AdmittedTranslationRequest<TInput> {
  /** Original physical grouping: the durable claim/stage/promote boundary. */
  readonly request: PhysicalRequestPlan;
  /** Context-safe provider calls executed serially under one scheduler permit. */
  readonly fragments: readonly AdmittedRequestFragment<TInput>[];
  /** Largest serial fragment reservation used by the outer schedulers. */
  readonly assessment: RequestBudgetAssessment;
  /** Pre-admitted topology used to size anti-loop limits for later recovery. */
  readonly paragraphRecoveryFragments:
    readonly AdmittedRequestFragment<TInput>[];
  /**
   * Bounded reserve for whole-request degeneration into paragraph vectors and
   * their complete legal local-bisection graph.
   */
  readonly paragraphRecoveryReserveTokens: number;
  /** Legal-policy baseline reserve for the admitted local-bisection graph. */
  readonly paragraphRefinementReserveTokens: number;
  /** Bounded reserve for independent semantic repair scopes in this request. */
  readonly targetedRepairReserveTokens: number;
}

export interface PlannedTranslationExecution {
  readonly admitted: AdmittedTranslationRequest<TranslationRequestInput>;
  readonly runtime: TranslationRuntime;
  readonly buildInput: (
    request: PhysicalRequestPlan,
  ) => TranslationRequestInput;
  readonly features: RuntimeFeatures;
  readonly variant: TaskExecutionVariant;
}

export interface MergedTranslationResult {
  windows: TranslationBatchWindowResult[];
  responseErrors: string[];
}

export interface CompletedTranslationRequest {
  request: PhysicalRequestPlan;
  budget: Readonly<Record<string, number>>;
  result?: MergedTranslationResult;
  error?: unknown;
  runtime: {
    readonly durationMs: number;
    readonly usage: NormalizedRuntimeUsage;
    /** Usage charged by the parent attempt; recovery attempts settle separately. */
    readonly accountingUsage: NormalizedRuntimeUsage;
    readonly observationDurationMs: number;
    readonly observationUsage: NormalizedRuntimeUsage;
    readonly status: RuntimeObservationStatus;
    readonly features: RuntimeFeatures;
    readonly variant: TaskExecutionVariant;
    readonly recoveries: readonly {
      readonly durationMs: number;
      readonly usage: NormalizedRuntimeUsage;
      readonly status: Exclude<RuntimeObservationStatus, "success">;
      readonly protocol: "typed_tool" | "framed_text";
    }[];
  };
}

export interface ScheduledResult<T> {
  value: T;
  status: SchedulerObservationStatus;
}

export interface TranslationExecutionDeps {
  readonly admission: AdmissionController;
  /**
   * Allocates a durable request identity that is fresh across process
   * restarts as well as within the current execution.
   */
  readonly nextLedgerAttemptId: (
    operationId: string,
    attempt: number,
  ) => string;
  readonly runtimeSet: TranslationRuntimeSet;
  readonly estimator: Pick<WeightedTokenEstimator, "observeUsage"> & WeightedTokenEstimator;
  readonly languageProfile: SourceLanguageProfile;
  readonly blockById: ReadonlyMap<string, LosslessBlock>;
  readonly signal?: AbortSignal;
  readonly hardDeadlineMs?: number;
  readonly retryRound: number;
  /** Recomputed immediately before any secondary provider attempt. */
  readonly conservativeHorizonFloor: () => number;
  readonly onProviderResponse?: (
    evidence: TranslationProviderResponseEvidence,
  ) => void | Promise<void>;
}

function fragmentTranslationTurnLimit(
  fragment: Pick<
    AdmittedRequestFragment<TranslationRequestInput>,
    "input"
  >,
): number {
  return fragment.input.responseProtocol === "framed_text" ? 1 : 2;
}

function admittedFragmentTree<TInput>(
  fragments: readonly AdmittedRequestFragment<TInput>[],
): AdmittedRequestFragment<TInput>[] {
  return fragments.flatMap((fragment) => [
    fragment,
    ...admittedFragmentTree(fragment.paragraphRefinements ?? []),
  ]);
}

/**
 * Size the local anti-loop ledger from the already-admitted execution graph.
 * Token admission remains authoritative; these counters only prevent a legal
 * paragraph plan from colliding with the older single-request turn defaults.
 */
export function executionBudgetLimits(
  fragments: readonly AdmittedRequestFragment<TranslationRequestInput>[],
): {
  readonly modelCalls: number;
  readonly translationTurns: number;
  readonly translationToolCalls: number;
  readonly repairTurns: number;
} {
  const legalFragments = admittedFragmentTree(fragments);
  const legalTranslationTurns = legalFragments.reduce(
    (total, fragment) => total + fragmentTranslationTurnLimit(fragment),
    0,
  );
  const potentialRepairScopes = legalFragments.length;
  const repairTurns = Math.min(
    MAX_TARGETED_REPAIRS_PER_REQUEST,
    potentialRepairScopes,
  );
  const translationTurns = Math.max(
    DEFAULT_BUDGET_LIMITS.translationTurns,
    legalTranslationTurns,
  );
  return {
    translationTurns,
    translationToolCalls: Math.max(
      DEFAULT_BUDGET_LIMITS.translationToolCalls,
      legalTranslationTurns + repairTurns,
    ),
    modelCalls: Math.max(
      DEFAULT_BUDGET_LIMITS.modelCalls,
      legalTranslationTurns + repairTurns,
    ),
    repairTurns: Math.max(
      DEFAULT_BUDGET_LIMITS.repairTurns,
      repairTurns,
    ),
  };
}

interface FragmentTranslationExecution {
  fragment: AdmittedRequestFragment<TranslationRequestInput>;
  result: TranslationBatchResult;
}

const PARAGRAPH_FRAGMENT_ORACLE_CHARACTERS = 1_024;
const PARAGRAPH_FRAGMENT_ORACLE_PLACEHOLDER =
  "续".repeat(PARAGRAPH_FRAGMENT_ORACLE_CHARACTERS);

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function reasoningReserveTokens(runtime: TranslationRuntime): number {
  return coldStartReasoningUpperBound(
    runtime.model.maxTokens,
    runtime.effort ?? runtime.thinkingLevel,
  );
}

export function outputReserveTokens(
  request: PhysicalRequestPlan,
  runtime: TranslationRuntime,
): number {
  const completionCapacity = Math.max(
    0,
    Math.floor(runtime.model.maxTokens) - reasoningReserveTokens(runtime),
  );
  return Math.min(
    completionCapacity,
    Math.max(768, Math.ceil(request.sourceTokens * 1.6) + 512),
  );
}

function contextFragmentRequestId(
  parentRequestId: string,
  windowId: string,
  blockIds: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(CONTEXT_FRAGMENT_PROTOCOL_VERSION);
  hash.update("\0");
  hash.update(parentRequestId);
  hash.update("\0");
  hash.update(windowId);
  for (const blockId of blockIds) {
    hash.update("\0");
    hash.update(blockId);
  }
  return `request-${hash.digest("hex").slice(0, 20)}`;
}

function paragraphFragmentRequestId(
  parentRequestId: string,
  executionUnitId: string,
): string {
  const hash = createHash("sha256");
  hash.update("paragraph-fragment-request-v1");
  hash.update("\0");
  hash.update(parentRequestId);
  hash.update("\0");
  hash.update(executionUnitId);
  return `request-${hash.digest("hex").slice(0, 20)}`;
}

function blocksForFragment(
  blockIds: readonly string[],
  blockById: ReadonlyMap<string, LosslessBlock>,
): LosslessBlock[] {
  return blockIds.map((blockId) => {
    const block = blockById.get(blockId);
    if (block === undefined) {
      throw new Error(`context fragment references unknown block ${blockId}`);
    }
    return block;
  });
}

function fragmentWindowAtBlocks(
  window: RequestBatchWindow,
  blockIds: readonly string[],
  blockById: ReadonlyMap<string, LosslessBlock>,
): RequestBatchWindow {
  const blocks = blocksForFragment(blockIds, blockById);
  return {
    ...window,
    blockIds: [...blockIds],
    globalIndexes: blocks.map((block) => block.globalIndex),
    sourceTokens: blocks.reduce((total, block) => total + block.tokenCount, 0),
    sourceChars: blocks.reduce(
      (total, block) => total + block.canonicalEnd - block.canonicalStart,
      0,
    ),
    oversized: false,
  };
}

export function splitSingleWindowRequestAtBlocks(
  request: PhysicalRequestPlan,
  blockById: ReadonlyMap<string, LosslessBlock>,
): PhysicalRequestPlan[] {
  const window = request.windows[0];
  if (window === undefined || window.blockIds.length < 2) {
    return [];
  }
  const blocks = blocksForFragment(window.blockIds, blockById);
  const totalTokens = blocks.reduce((total, block) => total + block.tokenCount, 0);
  let leftTokens = 0;
  let bestCut = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < blocks.length; index += 1) {
    leftTokens += (blocks[index - 1] as LosslessBlock).tokenCount;
    const distance = Math.abs(totalTokens - leftTokens * 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCut = index;
    }
  }
  const partitions = [
    window.blockIds.slice(0, bestCut),
    window.blockIds.slice(bestCut),
  ];
  return partitions.map((blockIds) => {
    const fragmentWindow = fragmentWindowAtBlocks(window, blockIds, blockById);
    return {
      requestId: contextFragmentRequestId(request.requestId, window.windowId, blockIds),
      windows: [fragmentWindow],
      sourceTokens: fragmentWindow.sourceTokens,
    };
  });
}

/**
 * Always isolate logical windows before splitting their source.  This ordering
 * preserves maximal narrative context whenever the provider capacity permits it.
 */
export function splitPhysicalRequestAtBoundaries(
  request: PhysicalRequestPlan,
  blockById: ReadonlyMap<string, LosslessBlock>,
): PhysicalRequestPlan[] {
  if (request.windows.length > 1) {
    return packPhysicalRequests(request.windows, {
      tinyWindowTokens: 1,
      maxRequestTokens: Math.max(1, request.sourceTokens),
      maxWindowsPerRequest: 1,
    });
  }
  return splitSingleWindowRequestAtBlocks(request, blockById);
}

export function assessTranslationFragment<TInput extends TranslationRequestInput>(
  request: PhysicalRequestPlan,
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  buildInput: (request: PhysicalRequestPlan) => TInput,
  depth = 0,
): AdmittedRequestFragment<TInput> {
  const built = buildInput(request);
  const input = (
    built.responseProtocol === "framed_text"
    && built.framedNonce === undefined
  )
    ? {
      ...built,
      framedNonce: randomBytes(16).toString("hex"),
    } as TInput
    : built;
  return assessPreparedTranslationFragment(
    request,
    input,
    runtime,
    estimator,
    depth,
  );
}

function assessPreparedTranslationFragment<
  TInput extends TranslationRequestInput,
>(
  request: PhysicalRequestPlan,
  input: TInput,
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  depth: number,
  paragraphPlan?: ParagraphFragmentPlan,
  paragraphUnit?: ParagraphFragmentUnit,
): AdmittedRequestFragment<TInput> {
  const assessment = new RequestBudgeter(estimator, {
    modelId: runtime.model.id,
    contextWindowTokens: runtime.model.contextWindow,
    maxCompletionTokens: runtime.model.maxTokens,
    outputTokens: outputReserveTokens(request, runtime),
    reasoningReserveTokens: Math.min(
      reasoningReserveTokens(runtime),
      runtime.model.maxTokens,
    ),
    safetyMarginTokens: Math.max(512, Math.ceil(runtime.model.contextWindow * 0.02)),
  }).assess(input);
  return {
    request,
    input,
    assessment,
    depth,
    ...(paragraphPlan === undefined ? {} : { paragraphPlan }),
    ...(paragraphUnit === undefined ? {} : { paragraphUnit }),
  };
}

function paragraphFragmentRequest(
  parentRequest: PhysicalRequestPlan,
  plan: ParagraphFragmentPlan,
  unit: ParagraphFragmentUnit,
  block: LosslessBlock,
): PhysicalRequestPlan {
  const parentWindow = parentRequest.windows.find((window) =>
    window.windowId === plan.windowId);
  if (parentWindow === undefined) {
    throw new Error(`paragraph plan references unknown window ${plan.windowId}`);
  }
  const fragmentChars = unit.paragraphs.reduce(
    (total, paragraph) => total + paragraph.sourceText.length,
    0,
  );
  const sourceTokens = Math.max(
    1,
    Math.ceil(
      block.tokenCount
      * fragmentChars
      / Math.max(1, block.sourceText.length),
    ),
  );
  return {
    requestId: paragraphFragmentRequestId(
      parentRequest.requestId,
      unit.executionUnitId,
    ),
    windows: [{
      ...parentWindow,
      blockIds: [plan.blockId],
      globalIndexes: [block.globalIndex],
      sourceTokens,
      sourceChars: fragmentChars,
      oversized: false,
    }],
    sourceTokens,
  };
}

function paragraphRefinementUnits(
  unit: ParagraphFragmentUnit,
): ParagraphFragmentUnit[] {
  if (unit.paragraphs.length <= 1) return [];
  const weights = unit.paragraphs.map((paragraph) =>
    Math.max(1, Array.from(paragraph.sourceText).length));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let leftWeight = 0;
  let splitIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < unit.paragraphs.length; index += 1) {
    leftWeight += weights[index - 1] ?? 0;
    const distance = Math.abs(totalWeight - leftWeight * 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      splitIndex = index;
    }
  }
  const groups = [
    unit.paragraphs.slice(0, splitIndex),
    unit.paragraphs.slice(splitIndex),
  ];
  return groups.map((paragraphs, index) => {
    const first = paragraphs[0]!;
    const last = paragraphs.at(-1)!;
    const previous = index === 0
      ? unit.leftSourceContext.at(-1)
      : unit.paragraphs[splitIndex - 1];
    const next = index === 0
      ? unit.paragraphs[splitIndex]
      : unit.rightSourceContext[0];
    const executionUnitId = `paragraph-refinement-${
      createHash("sha256")
        .update([
          unit.executionUnitId,
          first.paragraphId,
          last.paragraphId,
          String(index),
        ].join("\0"))
        .digest("hex")
        .slice(0, 24)
    }`;
    return {
      executionUnitId,
      planId: unit.planId,
      blockId: unit.blockId,
      paragraphStart: first.ordinal,
      paragraphEnd: last.ordinal + 1,
      paragraphs,
      leftSourceContext: previous === undefined
        ? []
        : [previous],
      rightSourceContext: next === undefined
        ? []
        : [next],
    };
  });
}

function paragraphPlanForWindow(
  request: PhysicalRequestPlan,
  window: RequestBatchWindow,
  blockById: ReadonlyMap<string, LosslessBlock>,
  baseInput: TranslationRequestInput,
  requireHighRisk: boolean,
): ParagraphFragmentPlan | undefined {
  if (window.blockIds.length !== 1) return undefined;
  const blockId = window.blockIds[0];
  const block = blockId === undefined ? undefined : blockById.get(blockId);
  if (block === undefined
    || sourceParagraphSpans(block).length < 2
    || (requireHighRisk && !paragraphFragmentFirstRequired(block))) {
    return undefined;
  }
  return planParagraphFragments({
    windowId: window.windowId,
    block,
    snapshotId: baseInput.snapshot.id,
    protectedSourceRanges: expectedTermOccurrencesForTranslationInput(baseInput)
      .filter((occurrence) => occurrence.blockId === block.id)
      .map((occurrence) => ({
        sourceStart: occurrence.sourceStart,
        sourceEnd: occurrence.sourceEnd,
      })),
  });
}

function admitParagraphFragmentPlan<
  TInput extends TranslationRequestInput,
>(
  parentRequest: PhysicalRequestPlan,
  plan: ParagraphFragmentPlan,
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  blockById: ReadonlyMap<string, LosslessBlock>,
  buildInput: (request: PhysicalRequestPlan) => TInput,
  depth: number,
): AdmittedRequestFragment<TInput>[] {
  const block = blockById.get(plan.blockId);
  if (block === undefined) {
    throw new Error(`paragraph plan references unknown block ${plan.blockId}`);
  }
  const admitUnit = (
    unit: ParagraphFragmentUnit,
    refinementDepth: number,
  ): AdmittedRequestFragment<TInput> => {
    const request = paragraphFragmentRequest(
      parentRequest,
      plan,
      unit,
      block,
    );
    const input = narrowSelectedKnowledgeToTranslationWireInput({
      ...buildInput(request),
      responseProtocol: "typed_tool" as const,
      paragraphFragment: paragraphFragmentExecutionScope(plan, unit),
      previousActiveTail: PARAGRAPH_FRAGMENT_ORACLE_PLACEHOLDER,
    } as TInput);
    const admitted = assessPreparedTranslationFragment(
      request,
      input,
      runtime,
      estimator,
      depth + refinementDepth,
      plan,
      unit,
    );
    const paragraphRefinements = paragraphRefinementUnits(unit).map(
      (refinementUnit) => admitUnit(
        refinementUnit,
        refinementDepth + 1,
      ),
    );
    return paragraphRefinements.length === 0
      ? admitted
      : { ...admitted, paragraphRefinements };
  };
  return plan.units.map((unit) => admitUnit(unit, 0));
}

function admitHighRiskParagraphFragments<
  TInput extends TranslationRequestInput,
>(
  request: PhysicalRequestPlan,
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  blockById: ReadonlyMap<string, LosslessBlock>,
  buildInput: (request: PhysicalRequestPlan) => TInput,
): AdmittedRequestFragment<TInput>[] | undefined {
  const fragments: AdmittedRequestFragment<TInput>[] = [];
  let fragmented = false;
  for (const window of request.windows) {
    const highRiskBlockIds = window.blockIds.filter((blockId) => {
      const block = blockById.get(blockId);
      if (block === undefined) {
        throw new Error(`paragraph admission references unknown block ${blockId}`);
      }
      return paragraphFragmentFirstRequired(block);
    });
    const blockGroups = highRiskBlockIds.length === 0
      ? [window.blockIds]
      : window.blockIds.map((blockId) => [blockId]);
    if (highRiskBlockIds.length > 0) {
      fragmented = true;
    }
    for (const blockIds of blockGroups) {
      const isolatedWindow = fragmentWindowAtBlocks(
        window,
        blockIds,
        blockById,
      );
      const isolatedRequest: PhysicalRequestPlan = {
        requestId: contextFragmentRequestId(
          request.requestId,
          window.windowId,
          blockIds,
        ),
        windows: [isolatedWindow],
        sourceTokens: isolatedWindow.sourceTokens,
      };
      const plan = paragraphPlanForWindow(
        isolatedRequest,
        isolatedWindow,
        blockById,
        buildInput(isolatedRequest),
        true,
      );
      if (plan === undefined) {
        fragments.push(...admitTranslationFragments(
          [isolatedRequest],
          runtime,
          estimator,
          blockById,
          buildInput,
        ));
        continue;
      }
      fragments.push(...admitParagraphFragmentPlan(
        isolatedRequest,
        plan,
        runtime,
        estimator,
        blockById,
        buildInput,
        0,
      ));
    }
  }
  return fragmented ? fragments : undefined;
}

function admitParagraphRecoveryFragments<
  TInput extends TranslationRequestInput,
>(
  request: PhysicalRequestPlan,
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  blockById: ReadonlyMap<string, LosslessBlock>,
  buildInput: (request: PhysicalRequestPlan) => TInput,
  depth: number,
): AdmittedRequestFragment<TInput>[] | undefined {
  const fragments: AdmittedRequestFragment<TInput>[] = [];
  for (const window of request.windows) {
    const isolatedRequest: PhysicalRequestPlan = {
      requestId: contextFragmentRequestId(
        request.requestId,
        window.windowId,
        window.blockIds,
      ),
      windows: [window],
      sourceTokens: window.sourceTokens,
    };
    const plan = paragraphPlanForWindow(
      isolatedRequest,
      window,
      blockById,
      buildInput(isolatedRequest),
      false,
    );
    if (plan === undefined) return undefined;
    fragments.push(...admitParagraphFragmentPlan(
      isolatedRequest,
      plan,
      runtime,
      estimator,
      blockById,
      buildInput,
      depth,
    ));
  }
  return fragments.length > 0 ? fragments : undefined;
}

export function capacityAssessmentForProviderContext(
  assessment: RequestBudgetAssessment,
): RequestBudgetAssessment {
  if (!assessment.fits) {
    return assessment;
  }
  const totalReserved = assessment.contextWindowTokens < Number.MAX_SAFE_INTEGER
    ? Math.max(assessment.totalReserved, assessment.contextWindowTokens + 1)
    : assessment.totalReserved;
  return {
    ...assessment,
    totalReserved,
    fits: false,
    decision: "split_window",
  };
}

export function admitTranslationFragments<TInput extends TranslationRequestInput>(
  requests: readonly PhysicalRequestPlan[],
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  blockById: ReadonlyMap<string, LosslessBlock>,
  buildInput: (request: PhysicalRequestPlan) => TInput,
  initialDepth = 0,
): AdmittedRequestFragment<TInput>[] {
  const admitted: AdmittedRequestFragment<TInput>[] = [];
  const queue = requests.map((request) => ({ request, depth: initialDepth }));
  while (queue.length > 0) {
    const queued = queue.shift() as { request: PhysicalRequestPlan; depth: number };
    const fragment = assessTranslationFragment(
      queued.request,
      runtime,
      estimator,
      buildInput,
      queued.depth,
    );
    if (fragment.assessment.fits) {
      admitted.push(fragment);
      continue;
    }
    const children = splitPhysicalRequestAtBoundaries(fragment.request, blockById);
    if (children.length === 0 || fragment.depth >= MAX_CONTEXT_SPLIT_DEPTH) {
      throw new BookRequestCapacityError(
        fragment.request.requestId,
        fragment.assessment,
        children.length === 0
          ? "one logical source block cannot be subdivided further"
          : `automatic context subdivision reached ${MAX_CONTEXT_SPLIT_DEPTH} levels`,
      );
    }
    queue.unshift(...children.map((request) => ({ request, depth: fragment.depth + 1 })));
  }
  return admitted;
}

export function admitTranslationRequests<TInput extends TranslationRequestInput>(
  requests: readonly PhysicalRequestPlan[],
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  blockById: ReadonlyMap<string, LosslessBlock>,
  buildInput: (request: PhysicalRequestPlan) => TInput,
): AdmittedTranslationRequest<TInput>[] {
  return requests.map((request) => {
    let fragments = admitHighRiskParagraphFragments(
      request,
      runtime,
      estimator,
      blockById,
      buildInput,
    );
    if (fragments === undefined) {
      try {
        fragments = admitTranslationFragments(
          [request],
          runtime,
          estimator,
          blockById,
          buildInput,
        );
      } catch (error) {
        if (!(error instanceof BookRequestCapacityError)) {
          throw error;
        }
        fragments = admitParagraphRecoveryFragments(
          request,
          runtime,
          estimator,
          blockById,
          buildInput,
          1,
        );
        if (fragments === undefined) {
          throw error;
        }
      }
    }
    const largest = fragments.reduce((current, fragment) =>
      fragment.assessment.totalReserved > current.assessment.totalReserved
        ? fragment
        : current,
    );
    const refinementReserveFor = (
      candidates: readonly AdmittedRequestFragment<TInput>[],
    ): number => admittedFragmentTree(candidates)
      .filter((fragment) => !candidates.includes(fragment))
      .reduce(
        (total, fragment) => total + fragment.assessment.totalReserved,
        0,
      );
    const paragraphRefinementReserveTokens =
      refinementReserveFor(fragments);
    const paragraphRecoveryFragments = fragments.some((fragment) =>
      fragment.paragraphPlan !== undefined)
      ? []
      : request.windows.flatMap((window) =>
          admitParagraphRecoveryFragments(
            requestWithWindows(request, new Set([window.windowId])),
            runtime,
            estimator,
            blockById,
            buildInput,
            1,
          ) ?? []);
    const paragraphRecoveryReserveTokens =
      paragraphRecoveryFragments.reduce(
        (total, fragment) =>
          total + fragment.assessment.totalReserved,
        0,
      )
      + refinementReserveFor(paragraphRecoveryFragments);
    const targetedRepairReserveTokens = [
      ...fragments,
      ...paragraphRecoveryFragments,
    ]
      .flatMap((fragment) => admittedFragmentTree([fragment]))
      .map((fragment) => fragment.assessment.totalReserved)
      .sort((left, right) => right - left)
      .slice(0, MAX_TARGETED_REPAIRS_PER_REQUEST)
      .reduce((total, reserve) => total + reserve, 0);
    return {
      request,
      fragments,
      assessment: largest.assessment,
      paragraphRecoveryFragments,
      paragraphRecoveryReserveTokens,
      paragraphRefinementReserveTokens,
      targetedRepairReserveTokens,
    };
  });
}

export function runtimeUsageForRuns(
  runs: readonly PiRunResult[],
): NormalizedRuntimeUsage {
  if (runs.length === 0) {
    return normalizeRuntimeUsage({});
  }
  return normalizeRuntimeUsage({
    input: runs.reduce((total, run) => total + run.usage.input, 0),
    output: runs.reduce((total, run) => total + run.usage.output, 0),
    cacheRead: runs.reduce((total, run) => total + run.usage.cacheRead, 0),
    cacheWrite: runs.reduce((total, run) => total + run.usage.cacheWrite, 0),
    reasoning: runs.reduce(
      (total, run) => total + (run.usage.reasoning ?? 0),
      0,
    ),
    totalTokens: runs.reduce(
      (total, run) => total + run.usage.totalTokens,
      0,
    ),
  });
}

function accountingUsageForRuns(
  runs: readonly PiRunResult[],
): NormalizedRuntimeUsage {
  const usage = runtimeUsageForRuns(runs);
  return runs.length > 0
    && runs.every((run) =>
      run.modelCalls === 0 || run.usage.totalTokens > 0)
    ? usage
    : { ...usage, complete: false };
}

function providerErrorRun(error: unknown): PiRunResult | undefined {
  return error instanceof ModelProviderError ? error.run : undefined;
}

function providerErrorUsage(error: unknown): NormalizedRuntimeUsage {
  const run = providerErrorRun(error);
  if (run === undefined) {
    return { ...runtimeUsageForRuns([]), complete: false };
  }
  const usage = runtimeUsageForRuns([run]);
  return run.usage.totalTokens > 0
    ? usage
    : { ...usage, complete: false };
}

export function runtimeObservationStatus(
  status: SchedulerObservationStatus,
): RuntimeObservationStatus {
  return status === "busy" ? "throttled" : status;
}

const RECOVERABLE_STRUCTURAL_SUBMISSION_ERROR = /^(?:missing window submission|duplicate windowId|unknown blockId|duplicate blockId|empty translation|block set mismatch|missing block translations while merging context fragments|duplicate block translation while merging context fragments)/u;
const RECOVERABLE_LOCAL_DEGENERATION_ERROR = /^(?:(?:validation|cross-block validation) failed after one targeted repair|shape collapse):[\s\S]*(?:untranslated_latin|paragraph_count_incompatible|paragraph_length_incompatible|abnormal_block_shortening|insufficient_lexical_content|abnormal_shortening|cross_block_translation_overlap)/u;
const RECOVERABLE_PARAGRAPH_REFINEMENT_ERROR = /^(?:missing window submission|paragraph count mismatch|empty translation|block set mismatch|shape collapse)/u;

function failedWindowIdsMatching(
  result: TranslationBatchResult,
  pattern: RegExp,
): Set<string> {
  return new Set(result.windows.flatMap((window) => (
    window.status === "failed"
      && pattern.test(window.error ?? "")
      ? [window.windowId]
      : []
  )));
}

export function recoverableStructuralWindowIds(result: TranslationBatchResult): Set<string> {
  return failedWindowIdsMatching(result, RECOVERABLE_STRUCTURAL_SUBMISSION_ERROR);
}

export function recoverableDegenerationWindowIds(result: TranslationBatchResult): Set<string> {
  return failedWindowIdsMatching(result, RECOVERABLE_LOCAL_DEGENERATION_ERROR);
}

export function requestWithWindows(
  request: PhysicalRequestPlan,
  windowIds: ReadonlySet<string>,
): PhysicalRequestPlan {
  const windows = request.windows.filter((window) => windowIds.has(window.windowId));
  return {
    ...request,
    windows,
    sourceTokens: windows.reduce((total, window) => total + window.sourceTokens, 0),
  };
}

export function mergeFragmentTranslationResults(
  request: PhysicalRequestPlan,
  executions: readonly FragmentTranslationExecution[],
): MergedTranslationResult {
  const partsByWindow = new Map<string, TranslationBatchWindowResult[]>();
  for (const execution of executions) {
    if (execution.fragment.paragraphPlan !== undefined) continue;
    for (const result of execution.result.windows) {
      const parts = partsByWindow.get(result.windowId) ?? [];
      parts.push(result);
      partsByWindow.set(result.windowId, parts);
    }
  }
  const windows = request.windows.map((logicalWindow): TranslationBatchWindowResult => {
    const paragraphExecutions = executions.filter((execution) =>
      execution.fragment.paragraphPlan?.windowId === logicalWindow.windowId);
    const paragraphExecutionGroups = new Map<
      string,
      FragmentTranslationExecution[]
    >();
    for (const execution of paragraphExecutions) {
      const planId = execution.fragment.paragraphPlan?.planId;
      if (planId === undefined) continue;
      const group = paragraphExecutionGroups.get(planId) ?? [];
      group.push(execution);
      paragraphExecutionGroups.set(planId, group);
    }
    const paragraphParts: TranslationBatchWindowResult[] = [];
    for (const group of paragraphExecutionGroups.values()) {
      const plan = group[0]?.fragment.paragraphPlan;
      if (plan === undefined
        || group.some((execution) =>
          execution.fragment.paragraphPlan?.planId !== plan.planId
          || execution.fragment.paragraphPlan?.blockId !== plan.blockId)) {
        paragraphParts.push({
          windowId: logicalWindow.windowId,
          ordinal: logicalWindow.ordinal,
          status: "failed",
          translations: [],
          termUsages: [],
          notes: [],
          memoryCandidates: [],
          error: "mixed paragraph fragment plans while assembling logical block",
        });
        continue;
      }
      const candidates: ParagraphFragmentCandidate[] = [];
      let failedPart: TranslationBatchWindowResult | undefined;
      for (const execution of group) {
        const unit = execution.fragment.paragraphUnit;
        const result = execution.result.windows.find((window) =>
          window.windowId === logicalWindow.windowId);
        if (unit === undefined || result === undefined
          || result.status === "failed"
          || result.paragraphs === undefined) {
          failedPart = {
            windowId: logicalWindow.windowId,
            ordinal: logicalWindow.ordinal,
            status: "failed",
            translations: [],
            termUsages: [],
            notes: [],
            memoryCandidates: [],
            error: result?.error ?? "paragraph fragment translation failed",
          };
          break;
        }
        candidates.push({
          planId: plan.planId,
          executionUnitId: unit.executionUnitId,
          windowId: plan.windowId,
          blockId: plan.blockId,
          sourceHash: plan.sourceHash,
          snapshotId: plan.snapshotId,
          paragraphs: result.paragraphs.map((paragraph) => ({ ...paragraph })),
          termUsages: result.termUsages.map((usage) => ({ ...usage })),
          notes: [...result.notes],
          memoryCandidates: [...result.memoryCandidates],
        });
      }
      if (failedPart !== undefined) {
        paragraphParts.push(failedPart);
        continue;
      }
      try {
        const assembly = assembleParagraphFragmentCandidates(plan, candidates);
        let styleObservation: TranslationBatchWindowResult["styleObservation"];
        for (const execution of group) {
          const observation = execution.result.windows.find((window) =>
            window.windowId === logicalWindow.windowId)?.styleObservation;
          if (observation !== undefined) styleObservation = observation;
        }
        paragraphParts.push({
          windowId: logicalWindow.windowId,
          ordinal: logicalWindow.ordinal,
          status: group.some((execution) =>
            execution.result.windows.some((window) =>
              window.windowId === logicalWindow.windowId
              && window.status === "completed_with_warnings"))
            ? "completed_with_warnings"
            : "completed",
          translations: [assembly.translation],
          termUsages: assembly.termUsages,
          notes: assembly.notes,
          memoryCandidates: assembly.memoryCandidates,
          ...(styleObservation === undefined ? {} : { styleObservation }),
        });
      } catch (error) {
        paragraphParts.push({
          windowId: logicalWindow.windowId,
          ordinal: logicalWindow.ordinal,
          status: "failed",
          translations: [],
          termUsages: [],
          notes: [],
          memoryCandidates: [],
          error: error instanceof Error
            ? error.message
            : "paragraph fragment assembly failed",
        });
      }
    }
    const parts = [
      ...(partsByWindow.get(logicalWindow.windowId) ?? []),
      ...paragraphParts,
    ];
    const failedPart = parts.find((part) => part.status === "failed");
    if (failedPart !== undefined) {
      return {
        windowId: logicalWindow.windowId,
        ordinal: logicalWindow.ordinal,
        status: "failed",
        translations: [],
        termUsages: [],
        notes: [],
        memoryCandidates: [],
        error: failedPart.error ?? "fragment translation failed",
      };
    }
    const translationsByBlock = new Map<string, { blockId: string; text: string }>();
    for (const part of parts) {
      for (const translation of part.translations) {
        if (translationsByBlock.has(translation.blockId)) {
          return {
            windowId: logicalWindow.windowId,
            ordinal: logicalWindow.ordinal,
            status: "failed",
            translations: [],
            termUsages: [],
            notes: [],
            memoryCandidates: [],
            error: `duplicate block translation while merging context fragments: ${translation.blockId}`,
          };
        }
        translationsByBlock.set(translation.blockId, translation);
      }
    }
    const missing = logicalWindow.blockIds.filter((blockId) => !translationsByBlock.has(blockId));
    if (missing.length > 0) {
      return {
        windowId: logicalWindow.windowId,
        ordinal: logicalWindow.ordinal,
        status: "failed",
        translations: [],
        termUsages: [],
        notes: [],
        memoryCandidates: [],
        error: `missing block translations while merging context fragments: ${missing.join(", ")}`,
      };
    }
    let styleObservation: TranslationBatchWindowResult["styleObservation"];
    for (const part of parts) {
      if (part.styleObservation !== undefined) {
        styleObservation = part.styleObservation;
      }
    }
    return {
      windowId: logicalWindow.windowId,
      ordinal: logicalWindow.ordinal,
      status: parts.some((part) => part.status === "completed_with_warnings")
        ? "completed_with_warnings"
        : "completed",
      translations: logicalWindow.blockIds.map((blockId) =>
        translationsByBlock.get(blockId) as { blockId: string; text: string }),
      termUsages: parts.flatMap((part) => part.termUsages),
      notes: parts.flatMap((part) => part.notes),
      memoryCandidates: parts.flatMap((part) => part.memoryCandidates),
      ...(styleObservation === undefined ? {} : { styleObservation }),
    };
  });
  return {
    windows,
    responseErrors: executions.flatMap((execution) => execution.result.responseErrors),
  };
}

function mergeParagraphRefinementExecutions(
  original: AdmittedRequestFragment<TranslationRequestInput>,
  refinements: readonly FragmentTranslationExecution[],
): FragmentTranslationExecution {
  const logicalWindow = original.request.windows[0];
  const first = refinements[0];
  const last = refinements.at(-1);
  if (logicalWindow === undefined || first === undefined || last === undefined) {
    throw new Error("paragraph refinement requires one window and at least one result");
  }
  const parts = refinements.map((execution) =>
    execution.result.windows.find((window) =>
      window.windowId === logicalWindow.windowId));
  const failedIndex = parts.findIndex((part) =>
    part === undefined
    || part.status === "failed"
    || part.paragraphs === undefined);
  const failed = failedIndex < 0 ? undefined : parts[failedIndex];
  const aggregateWindow: TranslationBatchWindowResult = failedIndex >= 0
    ? {
      windowId: logicalWindow.windowId,
      ordinal: logicalWindow.ordinal,
      status: "failed",
      translations: [],
      termUsages: [],
      notes: [],
      memoryCandidates: [],
      error: failed?.error ?? "paragraph refinement translation failed",
    }
    : (() => {
      const accepted = parts as Array<
        TranslationBatchWindowResult & {
          paragraphs: Array<{ paragraphId: string; text: string }>;
        }
      >;
      const paragraphs = accepted.flatMap((part) =>
        part.paragraphs.map((paragraph) => ({ ...paragraph })));
      let styleObservation: TranslationBatchWindowResult["styleObservation"];
      for (const part of accepted) {
        if (part.styleObservation !== undefined) {
          styleObservation = part.styleObservation;
        }
      }
      return {
        windowId: logicalWindow.windowId,
        ordinal: logicalWindow.ordinal,
        status: accepted.some((part) =>
          part.status === "completed_with_warnings")
          ? "completed_with_warnings"
          : "completed",
        translations: [{
          blockId: original.input.paragraphFragment?.blockId ?? "",
          text: paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
        }],
        paragraphs,
        termUsages: accepted.flatMap((part) =>
          part.termUsages.map((usage) => ({ ...usage }))),
        notes: accepted.flatMap((part) => [...part.notes]),
        memoryCandidates: accepted.flatMap((part) => [...part.memoryCandidates]),
        ...(styleObservation === undefined ? {} : { styleObservation }),
      };
    })();
  return {
    fragment: original,
    result: {
      requestId: original.input.request.requestId,
      snapshotId: original.input.snapshot.id,
      windows: [aggregateWindow],
      responseErrors: refinements.flatMap((execution) =>
        execution.result.responseErrors),
      run: last.result.run,
      repairRuns: refinements.flatMap((execution) =>
        execution.result.repairRuns),
    },
  };
}

export async function executePlannedTranslationRequest(
  execution: PlannedTranslationExecution,
  deps: TranslationExecutionDeps,
): Promise<ScheduledResult<CompletedTranslationRequest>> {
  const {
    admission,
    nextLedgerAttemptId,
    runtimeSet,
    estimator,
    languageProfile,
    blockById,
    signal,
    hardDeadlineMs,
    retryRound,
    conservativeHorizonFloor,
    onProviderResponse,
  } = deps;
  const {
    admitted: {
      request,
      fragments,
      paragraphRecoveryFragments = [],
    },
    runtime: selectedRuntime,
    buildInput: selectedBuildInput,
    features,
    variant,
  } = execution;
  const requestStartedAt = performance.now();
  const observedRuns: PiRunResult[] = [];
  const secondaryRuns = new Set<PiRunResult>();
  const recoveryRuns = new Set<PiRunResult>();
  const recoveries: Array<{
    durationMs: number;
    usage: NormalizedRuntimeUsage;
    status: Exclude<RuntimeObservationStatus, "success">;
    protocol: "typed_tool" | "framed_text";
  }> = [];
  // Fragments are one logical provider operation. Reusing the ledger
  // preserves the original hard ceilings instead of multiplying every
  // budget limit by the number of context-recovery fragments.
  const budget = new BudgetLedger(executionBudgetLimits([
    ...fragments,
    ...paragraphRecoveryFragments,
  ]));
  let observedContextOverflow = false;
  let contextSplitAttempts = 0;
  let protocolSplitAttempts = 0;
  let secondaryChargeOrdinal = 0;
  const targetedRepairScopeKeys = new Set<string>();
  const refinedParagraphExecutionUnitIds = new Set<string>();
  const acceptedTailByBlockId = new Map<string, string>();
  const chargeSecondaryFragments = async (
    purpose:
      | "repair"
      | "protocol_switch"
      | "context_split"
      | "paragraph_fragment",
    admitted: readonly AdmittedRequestFragment<TranslationRequestInput>[],
    run: () => Promise<FragmentTranslationExecution[]>,
  ): Promise<FragmentTranslationExecution[]> => {
    const predictedTokens = Math.max(
      1,
      admitted.reduce(
        (total, item) => total + item.assessment.totalReserved,
        0,
      ),
    );
    const secondaryOperationId = [
      request.requestId,
      purpose,
      secondaryChargeOrdinal,
    ].join(":");
    secondaryChargeOrdinal += 1;
    const secondaryId = nextLedgerAttemptId(
      secondaryOperationId,
      retryRound,
    );
    const transaction = admission.begin({
      requestId: secondaryId,
      purpose,
      taskIds: [request.requestId],
      predictedTokens,
      attempt: retryRound,
      conservativeHorizonFloor: conservativeHorizonFloor(),
    });
    const firstObservedRun = observedRuns.length;
    try {
      transaction.markDispatched();
    } catch (error) {
      transaction.releaseUnlaunched("not_launched");
      throw error;
    }
    let completed: FragmentTranslationExecution[] | undefined;
    let failure: unknown;
    try {
      completed = await run();
    } catch (error) {
      failure = error;
    }
    const directlyObservedRuns = observedRuns
      .slice(firstObservedRun)
      .filter((observed) => !secondaryRuns.has(observed));
    directlyObservedRuns.forEach((observed) => secondaryRuns.add(observed));
    const usage = accountingUsageForRuns(directlyObservedRuns);
    transaction.settle({
      actualTokens: usage.totalTokens,
      usageComplete: usage.complete,
      outcome: failure === undefined
        ? "success"
        : failure instanceof ModelProviderError
          && failure.kind === "protocol"
          ? "protocol"
          : "failed",
    });
    if (failure !== undefined) {
      throw failure;
    }
    return completed as FragmentTranslationExecution[];
  };
  const executeFragments = async (
    pendingFragments: readonly AdmittedRequestFragment<TranslationRequestInput>[],
    activeRuntime: TranslationRuntime = selectedRuntime,
    retryingLocally = false,
  ): Promise<FragmentTranslationExecution[]> => {
    const completed: FragmentTranslationExecution[] = [];
    for (const fragment of pendingFragments) {
      const fragmentStartedAt = performance.now();
      try {
        throwIfAborted(signal);
        const paragraphScope = fragment.input.paragraphFragment;
        const targetedRepairScopeKey = paragraphScope === undefined
          ? `fragment:${fragment.request.requestId}`
          : `paragraph:${paragraphScope.planId}:${paragraphScope.executionUnitId}`;
        const runtimeInput: TranslationRequestInput = paragraphScope === undefined
          ? fragment.input
          : {
            ...fragment.input,
            previousActiveTail:
              acceptedTailByBlockId.get(paragraphScope.blockId) ?? "",
          };
        const result = await runTranslationBatch({
          ...runtimeInput,
          model: activeRuntime.model,
          streamFn: activeRuntime.streamFn,
          thinkingLevel: activeRuntime.thinkingLevel,
          repairEnabled:
            targetedRepairScopeKeys.size < MAX_TARGETED_REPAIRS_PER_REQUEST
            && !targetedRepairScopeKeys.has(targetedRepairScopeKey),
          repairRuntime: retryingLocally
            ? {
              model: activeRuntime.model,
              streamFn: activeRuntime.streamFn,
              thinkingLevel: activeRuntime.thinkingLevel,
            }
            : {
              model: runtimeSet.escalation.model,
              streamFn: runtimeSet.escalation.streamFn,
              thinkingLevel: runtimeSet.escalation.thinkingLevel,
            },
          budget,
          signal,
          deadlineMs: hardDeadlineMs,
          ...(onProviderResponse === undefined
            ? {}
            : { onProviderResponse }),
        });
        observedRuns.push(result.run, ...result.repairRuns);
        if (result.repairRuns.length > 0) {
          targetedRepairScopeKeys.add(targetedRepairScopeKey);
        }
        if (paragraphScope !== undefined) {
          const accepted = result.windows.find((window) =>
            window.windowId === fragment.request.windows[0]?.windowId
            && window.status !== "failed"
            && window.paragraphs !== undefined);
          if (accepted?.paragraphs !== undefined) {
            const tail = accepted.paragraphs.map((paragraph) =>
              paragraph.text).join("\n\n");
            acceptedTailByBlockId.set(
              paragraphScope.blockId,
              Array.from(tail)
                .slice(-PARAGRAPH_FRAGMENT_ORACLE_CHARACTERS)
                .join(""),
            );
          }
        }
        if (result.run.modelCalls === 1
          && fragment.assessment.inputTokens > 0
          && result.run.usage.input > 0) {
          const observation: UsageObservation = {
            modelId: activeRuntime.model.id,
            profile: languageProfile,
            estimatedTokens: fragment.assessment.inputTokens,
            actualInputTokens: result.run.usage.input,
          };
          estimator.observeUsage(observation);
        }
        const structuralWindowIds = recoverableStructuralWindowIds(result);
        const degenerationWindowIds = recoverableDegenerationWindowIds(result);
        const recoverableWindowIds = new Set([
          ...structuralWindowIds,
          ...degenerationWindowIds,
        ]);
        if (paragraphScope !== undefined
          && result.windows.some((window) =>
            window.status === "failed"
            && RECOVERABLE_PARAGRAPH_REFINEMENT_ERROR.test(
              window.error ?? "",
            ))
          && !refinedParagraphExecutionUnitIds.has(
            paragraphScope.executionUnitId,
          )
          && (fragment.paragraphRefinements?.length ?? 0) > 0) {
          const failedRuns = [result.run, ...result.repairRuns];
          failedRuns.forEach((run) => recoveryRuns.add(run));
          recoveries.push({
            durationMs: performance.now() - fragmentStartedAt,
            usage: runtimeUsageForRuns(failedRuns),
            status: "failed",
            protocol: "typed_tool",
          });
          refinedParagraphExecutionUnitIds.add(
            paragraphScope.executionUnitId,
          );
          const refinementExecutions = await chargeSecondaryFragments(
            "paragraph_fragment",
            fragment.paragraphRefinements ?? [],
            () => executeFragments(
              fragment.paragraphRefinements ?? [],
              runtimeSet.escalation,
              true,
            ),
          );
          completed.push(mergeParagraphRefinementExecutions(
            fragment,
            refinementExecutions,
          ));
          continue;
        }
        if (degenerationWindowIds.size > 0
          && fragment.paragraphPlan === undefined
          && fragment.input.responseProtocol === "typed_tool"
          && protocolSplitAttempts < MAX_PROTOCOL_SPLIT_ATTEMPTS) {
          const failedRequest = requestWithWindows(
            fragment.request,
            degenerationWindowIds,
          );
          const admittedRecovery = admitParagraphRecoveryFragments(
            failedRequest,
            runtimeSet.escalation,
            estimator,
            blockById,
            selectedBuildInput,
            fragment.depth + 1,
          );
          if (admittedRecovery !== undefined) {
            const failedRuns = [
              result.run,
              ...result.repairRuns,
            ];
            failedRuns.forEach((run) => recoveryRuns.add(run));
            recoveries.push({
              durationMs: performance.now() - fragmentStartedAt,
              usage: runtimeUsageForRuns(failedRuns),
              status: "failed",
              protocol: "typed_tool",
            });
            protocolSplitAttempts += 1;
            const validWindows = result.windows.filter((window) =>
              !degenerationWindowIds.has(window.windowId));
            if (validWindows.length > 0) {
              completed.push({
                fragment,
                result: { ...result, windows: validWindows },
              });
            }
            completed.push(...await chargeSecondaryFragments(
              "paragraph_fragment",
              admittedRecovery,
              () => executeFragments(
                admittedRecovery,
                runtimeSet.escalation,
                true,
              ),
            ));
            continue;
          }
        }
        if (recoverableWindowIds.size > 0
          && fragment.paragraphPlan === undefined
          && fragment.input.responseProtocol === "typed_tool"
          && protocolSplitAttempts < MAX_PROTOCOL_SPLIT_ATTEMPTS) {
          const failedRequest = requestWithWindows(
            fragment.request,
            recoverableWindowIds,
          );
          if (failedRequest.windows.length > 0) {
            const failedRuns = [
              result.run,
              ...result.repairRuns,
            ];
            failedRuns.forEach((run) => recoveryRuns.add(run));
            recoveries.push({
              durationMs: performance.now() - fragmentStartedAt,
              usage: runtimeUsageForRuns(failedRuns),
              status: "protocol",
              protocol: "typed_tool",
            });
            protocolSplitAttempts += 1;
            const validWindows = result.windows.filter((window) =>
              !recoverableWindowIds.has(window.windowId));
            if (validWindows.length > 0) {
              completed.push({
                fragment,
                result: { ...result, windows: validWindows },
              });
            }
            const buildFramedTranslationInput = (
              request: PhysicalRequestPlan,
            ): TranslationRequestInput => ({
              ...selectedBuildInput(request),
              responseProtocol: "framed_text",
            });
            const admittedFallback = admitTranslationFragments(
              [failedRequest],
              runtimeSet.escalation,
              estimator,
              blockById,
              buildFramedTranslationInput,
              fragment.depth,
            );
            completed.push(...await chargeSecondaryFragments(
              "protocol_switch",
              admittedFallback,
              () => executeFragments(
                admittedFallback,
                runtimeSet.escalation,
                true,
              ),
            ));
            continue;
          }
        }
        if (recoverableWindowIds.size > 0
          && (fragment.request.windows.length === 1
            || degenerationWindowIds.size > 0)
          && fragment.depth < MAX_CONTEXT_SPLIT_DEPTH
          && protocolSplitAttempts < MAX_PROTOCOL_SPLIT_ATTEMPTS) {
          const failedRequest = requestWithWindows(
            fragment.request,
            recoverableWindowIds,
          );
          const children = splitPhysicalRequestAtBoundaries(
            failedRequest,
            blockById,
          );
          if (children.length > 0) {
            const failedRuns = [
              result.run,
              ...result.repairRuns,
            ];
            failedRuns.forEach((run) => recoveryRuns.add(run));
            recoveries.push({
              durationMs: performance.now() - fragmentStartedAt,
              usage: runtimeUsageForRuns(failedRuns),
              status: structuralWindowIds.size > 0
                ? "protocol"
                : "failed",
              protocol: fragment.input.responseProtocol
                ?? "typed_tool",
            });
            protocolSplitAttempts += 1;
            const validWindows = result.windows.filter((window) =>
              !recoverableWindowIds.has(window.windowId));
            if (validWindows.length > 0) {
              completed.push({
                fragment,
                result: { ...result, windows: validWindows },
              });
            }
            const admittedChildren = admitTranslationFragments(
              children,
              runtimeSet.escalation,
              estimator,
              blockById,
              selectedBuildInput,
              fragment.depth + 1,
            );
            completed.push(...await chargeSecondaryFragments(
              "context_split",
              admittedChildren,
              () => executeFragments(
                admittedChildren,
                runtimeSet.escalation,
                true,
              ),
            ));
            continue;
          }
        }
        completed.push({ fragment, result });
      } catch (error) {
        if (error instanceof BookTokenEnvelopeExceededError) {
          throw error;
        }
        const failedRun = providerErrorRun(error);
        if (failedRun !== undefined && !observedRuns.includes(failedRun)) {
          observedRuns.push(failedRun);
          recoveryRuns.add(failedRun);
        }
        if (error instanceof ModelProviderError
          && error.kind === "protocol"
          && fragment.paragraphPlan === undefined
          && fragment.input.responseProtocol === "typed_tool"
          && protocolSplitAttempts < MAX_PROTOCOL_SPLIT_ATTEMPTS) {
          recoveries.push({
            durationMs: performance.now() - fragmentStartedAt,
            usage: providerErrorUsage(error),
            status: "protocol",
            protocol: "typed_tool",
          });
          protocolSplitAttempts += 1;
          const buildFramedTranslationInput = (
            request: PhysicalRequestPlan,
          ): TranslationRequestInput => ({
            ...selectedBuildInput(request),
            responseProtocol: "framed_text",
          });
          const admittedFallback = admitTranslationFragments(
            [fragment.request],
            activeRuntime,
            estimator,
            blockById,
            buildFramedTranslationInput,
            fragment.depth,
          );
          completed.push(...await chargeSecondaryFragments(
            "protocol_switch",
            admittedFallback,
            () => executeFragments(
              admittedFallback,
              activeRuntime,
              false,
            ),
          ));
          continue;
        }
        if (!(error instanceof ModelProviderError) || error.kind !== "context") {
          throw error;
        }
        observedContextOverflow = true;
        recoveries.push({
          durationMs: performance.now() - fragmentStartedAt,
          usage: providerErrorUsage(error),
          status: "context",
          protocol: fragment.input.responseProtocol ?? "typed_tool",
        });
        contextSplitAttempts += 1;
        const children = splitPhysicalRequestAtBoundaries(
          fragment.request,
          blockById,
        );
        if (children.length === 0
          || fragment.depth >= MAX_CONTEXT_SPLIT_DEPTH
          || contextSplitAttempts > MAX_CONTEXT_SPLIT_ATTEMPTS) {
          throw new BookRequestCapacityError(
            fragment.request.requestId,
            capacityAssessmentForProviderContext(fragment.assessment),
            children.length === 0
              ? "provider rejected one indivisible source block for context capacity"
              : fragment.depth >= MAX_CONTEXT_SPLIT_DEPTH
                ? `provider context recovery reached ${MAX_CONTEXT_SPLIT_DEPTH} levels`
                : `provider context recovery exceeded ${MAX_CONTEXT_SPLIT_ATTEMPTS} retries`,
          );
        }
        const admittedChildren = admitTranslationFragments(
          children,
          activeRuntime,
          estimator,
          blockById,
          selectedBuildInput,
          fragment.depth + 1,
        );
        completed.push(...await chargeSecondaryFragments(
          "context_split",
          admittedChildren,
          () => executeFragments(
            admittedChildren,
            activeRuntime,
            true,
          ),
        ));
      }
    }
    return completed;
  };
  const successfulObservationUsage = (): NormalizedRuntimeUsage =>
    runtimeUsageForRuns(observedRuns.filter((run) =>
      !recoveryRuns.has(run)));
  const successfulObservationDuration = (
    totalDurationMs: number,
  ): number => Math.max(
    0,
    totalDurationMs - recoveries.reduce(
      (total, recovery) => total + recovery.durationMs,
      0,
    ),
  );
  try {
    const executions = await executeFragments(fragments);
    let result = mergeFragmentTranslationResults(request, executions);
    if (executions.some((item) => item.fragment.paragraphPlan !== undefined)) {
      const checked = await validateTranslationBatchCandidate({
        ...selectedBuildInput(request),
        model: selectedRuntime.model,
        streamFn: selectedRuntime.streamFn,
        thinkingLevel: selectedRuntime.thinkingLevel,
        budget,
      }, result);
      result = {
        windows: checked.windows,
        responseErrors: checked.responseErrors,
      };
    }
    const failed = result.windows.some((window) =>
      window.status === "failed");
    const schedulerStatus: SchedulerObservationStatus = failed
      ? "failed"
      : observedContextOverflow ? "context" : "success";
    const durationMs = performance.now() - requestStartedAt;
    const observedUsage = runtimeUsageForRuns(observedRuns);
    const accountingUsage = accountingUsageForRuns(
      observedRuns.filter((run) => !secondaryRuns.has(run)),
    );
    const usage = recoveries.some((recovery) =>
      !recovery.usage.complete)
      ? { ...observedUsage, complete: false }
      : observedUsage;
    return {
      value: {
        request,
        budget: budget.snapshot(),
        result,
        runtime: {
          durationMs,
          usage,
          accountingUsage,
          observationDurationMs:
            successfulObservationDuration(durationMs),
          observationUsage: successfulObservationUsage(),
          status: failed ? "failed" : "success",
          features,
          variant,
          recoveries,
        },
      },
      status: schedulerStatus,
    };
  } catch (error) {
    const status: SchedulerObservationStatus = error instanceof ModelProviderError
      && (error.kind === "throttled"
        || error.kind === "timeout"
        || error.kind === "busy"
        || error.kind === "context")
      ? error.kind
      : "failed";
    const failedRun = providerErrorRun(error);
    if (failedRun !== undefined && !observedRuns.includes(failedRun)) {
      observedRuns.push(failedRun);
    }
    const observedUsage = runtimeUsageForRuns(observedRuns);
    const accountingUsage = accountingUsageForRuns(
      observedRuns.filter((run) => !secondaryRuns.has(run)),
    );
    const providerUsage = providerErrorUsage(error);
    const usage = (error instanceof ModelProviderError && !providerUsage.complete)
      || recoveries.some((recovery) => !recovery.usage.complete)
      ? { ...observedUsage, complete: false }
      : observedUsage;
    const durationMs = performance.now() - requestStartedAt;
    const observationUsage = successfulObservationUsage();
    return {
      value: {
        request,
        budget: budget.snapshot(),
        error,
        runtime: {
          durationMs,
          usage,
          accountingUsage,
          observationDurationMs:
            successfulObservationDuration(durationMs),
          observationUsage: error instanceof ModelProviderError
            && !providerUsage.complete
            ? { ...observationUsage, complete: false }
            : observationUsage,
          status: runtimeObservationStatus(status),
          features,
          variant,
          recoveries,
        },
      },
      status,
    };
  }
}
