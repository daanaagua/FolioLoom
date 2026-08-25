import type { SchedulerMode } from "./optimization-policy.js";
import type {
  LedgerBaselineSource,
  LedgerEvent,
  LedgerPurpose,
  LedgerReleaseReason,
  LedgerSettleOutcome,
  TokenLedger,
} from "./token-ledger.js";

export class BookTokenEnvelopeExceededError extends Error {
  readonly code = "TOKEN_ENVELOPE_EXHAUSTED" as const;
  readonly retryable = false;

  constructor(
    readonly actualTokens: number,
    readonly runningReservedTokens: number,
    readonly minimumPendingTokens: number,
    readonly allowedTokens: number,
  ) {
    super(
      `TOKEN_ENVELOPE_EXHAUSTED: actual ${actualTokens} + running `
      + `${runningReservedTokens} + minimum pending ${minimumPendingTokens} `
      + `exceeds allowed ${allowedTokens}`,
    );
    this.name = "BookTokenEnvelopeExceededError";
  }
}

export interface AdmissionControllerOptions {
  readonly ledger: TokenLedger;
  readonly mode: SchedulerMode;
  readonly persist: (event: LedgerEvent) => void;
}

export interface AdmissionReserveRequest {
  readonly requestId: string;
  readonly purpose: LedgerPurpose;
  readonly taskIds: readonly string[];
  readonly predictedTokens: number;
  readonly attempt: number;
  /** Mandatory work not covered by this or another open reservation. */
  readonly conservativeHorizonFloor: number;
}

export interface AdmissionSettleRequest {
  readonly requestId: string;
  readonly actualTokens: number;
  readonly usageComplete: boolean;
  readonly outcome: LedgerSettleOutcome;
}

export interface AdmissionBaselineRequest {
  readonly taskIds: readonly string[];
  readonly baselineTokens: number;
  readonly source: LedgerBaselineSource;
  readonly reason: string;
}

export interface AdmissionReservation {
  readonly requestId: string;
  markDispatched(): void;
  settle(request: Omit<AdmissionSettleRequest, "requestId">): void;
  releaseUnlaunched(reason: LedgerReleaseReason): void;
}

export interface BaselineProjectionTask {
  readonly taskId: string;
  readonly baselineTokens: number;
  readonly baselineWallTimeMs: number;
}

export interface WeightedBaselineProjectionTask {
  readonly taskId: string;
  readonly weight: number;
}

export interface IncrementalBaselineProjection {
  readonly taskIds: readonly string[];
  readonly baselineTokens: number;
  readonly baselineWallTimeMs: number;
}

function allocateWeightedTotal(
  tasks: readonly WeightedBaselineProjectionTask[],
  total: number,
): number[] {
  if (tasks.length === 0) return [];
  const safeTotal = Math.max(0, Math.floor(total));
  const weights = tasks.map((task) =>
    Number.isFinite(task.weight) ? Math.max(0, task.weight) : 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const effectiveWeights = weightTotal > 0
    ? weights
    : tasks.map(() => 1);
  const effectiveTotal = effectiveWeights.reduce(
    (sum, weight) => sum + weight,
    0,
  );
  let priorBoundary = 0;
  let cumulativeWeight = 0;
  return effectiveWeights.map((weight, index) => {
    cumulativeWeight += weight;
    const boundary = index === effectiveWeights.length - 1
      ? safeTotal
      : Math.floor(safeTotal * cumulativeWeight / effectiveTotal);
    const allocation = boundary - priorBoundary;
    priorBoundary = boundary;
    return allocation;
  });
}

export function weightedBaselineProjectionTasks(
  tasks: readonly WeightedBaselineProjectionTask[],
  baselineTokens: number,
  baselineWallTimeMs: number,
): BaselineProjectionTask[] {
  const tokenAllocations = allocateWeightedTotal(tasks, baselineTokens);
  const wallTimeAllocations = allocateWeightedTotal(
    tasks,
    baselineWallTimeMs,
  );
  return tasks.map((task, index) => ({
    taskId: task.taskId,
    baselineTokens: tokenAllocations[index] ?? 0,
    baselineWallTimeMs: wallTimeAllocations[index] ?? 0,
  }));
}

export function incrementalBaselineProjection(
  tasks: readonly BaselineProjectionTask[],
  baselinedTaskIds: ReadonlySet<string>,
): IncrementalBaselineProjection {
  const fresh = tasks.filter((task) => !baselinedTaskIds.has(task.taskId));
  return {
    taskIds: fresh.map((task) => task.taskId),
    baselineTokens: fresh.reduce(
      (total, task) => total + task.baselineTokens,
      0,
    ),
    baselineWallTimeMs: fresh.reduce(
      (total, task) => total + task.baselineWallTimeMs,
      0,
    ),
  };
}

/**
 * Single write path for run-level token envelope decisions.
 * Planner remains pure; this controller is the only place that should
 * reserve/settle/release against the durable ledger during execution.
 */
export class AdmissionController {
  readonly #ledger: TokenLedger;
  readonly #mode: SchedulerMode;
  readonly #persist: (event: LedgerEvent) => void;

  constructor(options: AdmissionControllerOptions) {
    this.#ledger = options.ledger;
    this.#mode = options.mode;
    this.#persist = options.persist;
  }

  get ledger(): TokenLedger {
    return this.#ledger;
  }

  spentTokens(): number {
    return this.#ledger.state().spentTokens;
  }

  reservedTokens(): number {
    return this.#ledger.state().reservedTokens;
  }

  allowedTokens(): number {
    return this.#ledger.state().allowedTokens;
  }

  canLaunch(
    predictedTokens: number,
    conservativeHorizonFloor: number,
  ): boolean {
    if (this.#mode !== "active") return true;
    return this.#ledger.canReserve(predictedTokens, conservativeHorizonFloor);
  }

  addBaseline(request: AdmissionBaselineRequest): void {
    const fresh = request.taskIds.filter(
      (taskId) => !this.#ledger.state().baselinedTaskIds.has(taskId),
    );
    if (fresh.length === 0 || request.baselineTokens <= 0) return;
    this.#apply({
      type: "baseline_added",
      taskIds: fresh,
      baselineTokens: request.baselineTokens,
      source: request.source,
      reason: request.reason,
    });
  }

  reserve(request: AdmissionReserveRequest): void {
    if (this.#ledger.state().openReservations.has(request.requestId)) {
      return;
    }
    const predictedTokens = Math.max(1, request.predictedTokens);
    const conservativeHorizonFloor = Math.max(
      0,
      request.conservativeHorizonFloor,
    );
    if (this.#mode === "active"
      && !this.#ledger.canReserve(predictedTokens, conservativeHorizonFloor)) {
      throw new BookTokenEnvelopeExceededError(
        this.spentTokens(),
        this.reservedTokens(),
        predictedTokens + conservativeHorizonFloor,
        this.allowedTokens(),
      );
    }
    this.#apply({
      type: "reserved",
      requestId: request.requestId,
      purpose: request.purpose,
      taskIds: request.taskIds,
      predictedTokens,
      attempt: request.attempt,
    });
  }

  begin(request: AdmissionReserveRequest): AdmissionReservation {
    this.reserve(request);
    let terminal = false;
    return {
      requestId: request.requestId,
      markDispatched: () => {
        if (terminal) {
          throw new Error(
            `cannot dispatch terminal reservation: ${request.requestId}`,
          );
        }
        this.markDispatched(request.requestId);
      },
      settle: (settlement) => {
        if (terminal) {
          throw new Error(
            `cannot settle terminal reservation: ${request.requestId}`,
          );
        }
        this.settle({
          requestId: request.requestId,
          ...settlement,
        });
        terminal = true;
      },
      releaseUnlaunched: (reason) => {
        if (terminal) return;
        this.release(request.requestId, reason);
        terminal = true;
      },
    };
  }

  markDispatched(requestId: string): void {
    if (this.#ledger.state().dispatchedRequestIds.has(requestId)) {
      return;
    }
    if (!this.#ledger.state().openReservations.has(requestId)) {
      throw new Error(`cannot dispatch request without reservation: ${requestId}`);
    }
    this.#apply({
      type: "dispatched",
      requestId,
    });
  }

  settle(request: AdmissionSettleRequest): void {
    if (!this.#ledger.state().openReservations.has(request.requestId)) {
      return;
    }
    this.#apply({
      type: "settled",
      requestId: request.requestId,
      actualTokens: request.actualTokens,
      usageComplete: request.usageComplete,
      outcome: request.outcome,
    });
    if (this.#mode === "active") {
      const state = this.#ledger.state();
      if (state.spentTokens + state.reservedTokens > state.allowedTokens) {
        throw new BookTokenEnvelopeExceededError(
          state.spentTokens,
          state.reservedTokens,
          0,
          state.allowedTokens,
        );
      }
    }
  }

  release(requestId: string, reason: LedgerReleaseReason): void {
    if (!this.#ledger.state().openReservations.has(requestId)) {
      return;
    }
    this.#apply({
      type: "released",
      requestId,
      reason,
    });
  }

  #apply(event: LedgerEvent): void {
    this.#persist(event);
  }
}
