import type {
  OptimizationProfile,
  SchedulerMode,
} from "./optimization-policy.js";
import type { SchedulerRunReport } from "./dynamic-scheduler.js";

export type LedgerPurpose =
  | "translate"
  | "repair"
  | "protocol_switch"
  | "context_split"
  | "paragraph_fragment"
  | "anchor"
  | "revalidate";

export type LedgerBaselineSource =
  | "translate_horizon"
  | "revalidate"
  | "anchor"
  | "recovery_floor";

export type LedgerSettleOutcome =
  | "success"
  | "protocol"
  | "failed"
  | "cancelled";

export type LedgerReleaseReason =
  | "not_launched"
  | "superseded"
  | "run_cancelled";

export type SchedulerPlanningStatus = SchedulerRunReport["planningStatus"];

export interface SchedulerCountersPatch {
  readonly decisions?: number;
  readonly fallbacks?: number;
  readonly recoveries?: number;
  readonly plannerDeadlines?: number;
  readonly throttles?: number;
  readonly planningStatus?: SchedulerPlanningStatus;
  readonly predictedTokens?: number;
  readonly predictedWallTimeMs?: number;
  readonly actualWallTimeMs?: number;
  readonly baselineWallTimeMs?: number;
  readonly contextProfiles?: Readonly<Record<string, "lean" | "balanced" | "rich">>;
  readonly effortCounts?: Readonly<Record<string, number>>;
  readonly protocolCounts?: Readonly<Partial<Record<
    "typed_tool" | "framed_text" | "local",
    number
  >>>;
}

export function schedulerCountersPatch(
  report: SchedulerRunReport,
): SchedulerCountersPatch {
  return {
    decisions: report.decisions,
    fallbacks: report.fallbacks,
    recoveries: report.recoveries,
    plannerDeadlines: report.plannerDeadlines,
    throttles: report.throttles,
    planningStatus: report.planningStatus,
    predictedTokens: report.predictedTokens,
    predictedWallTimeMs: Math.floor(report.predictedWallTimeMs),
    actualWallTimeMs: Math.floor(report.actualWallTimeMs),
    baselineWallTimeMs: Math.floor(report.baselineWallTimeMs),
    contextProfiles: report.contextProfiles,
    effortCounts: report.effortCounts,
    protocolCounts: report.protocolCounts,
  };
}

export type LedgerEvent =
  | {
      readonly type: "baseline_added";
      readonly taskIds: readonly string[];
      readonly baselineTokens: number;
      readonly source: LedgerBaselineSource;
      readonly reason: string;
    }
  | {
      readonly type: "reserved";
      readonly requestId: string;
      readonly purpose: LedgerPurpose;
      readonly taskIds: readonly string[];
      readonly predictedTokens: number;
      readonly attempt: number;
    }
  | {
      readonly type: "dispatched";
      readonly requestId: string;
    }
  | {
      readonly type: "settled";
      readonly requestId: string;
      readonly actualTokens: number;
      readonly usageComplete: boolean;
      readonly outcome: LedgerSettleOutcome;
    }
  | {
      readonly type: "released";
      readonly requestId: string;
      readonly reason: LedgerReleaseReason;
    }
  | {
      readonly type: "counters_patched";
      readonly patch: SchedulerCountersPatch;
    };

export interface TokenLedgerInit {
  readonly mode: SchedulerMode;
  readonly profile: OptimizationProfile;
  readonly tokenIncreaseCap: number;
  /**
   * New writers require an explicit dispatched event before settlement.
   * Historical event streams are replayed permissively, then enforcement is
   * enabled for every event appended after recovery.
   */
  readonly enforceDispatchLifecycle?: boolean;
}

export interface OpenReservation {
  readonly requestId: string;
  readonly purpose: LedgerPurpose;
  readonly taskIds: readonly string[];
  readonly predictedTokens: number;
  readonly attempt: number;
}

export interface LedgerState {
  readonly baselineTokens: number;
  readonly allowedTokens: number;
  readonly spentTokens: number;
  readonly reservedTokens: number;
  readonly tokenUsageComplete: boolean;
  readonly baselinedTaskIds: ReadonlySet<string>;
  readonly openReservations: ReadonlyMap<string, OpenReservation>;
  readonly dispatchedRequestIds: ReadonlySet<string>;
  readonly terminalRequestIds: ReadonlySet<string>;
  readonly decisions: number;
  readonly fallbacks: number;
  readonly recoveries: number;
  readonly plannerDeadlines: number;
  readonly throttles: number;
  readonly planningStatus: SchedulerPlanningStatus;
  readonly predictedTokens: number;
  readonly predictedWallTimeMs: number;
  readonly actualWallTimeMs: number;
  readonly baselineWallTimeMs: number;
  readonly contextProfiles: Readonly<Record<string, "lean" | "balanced" | "rich">>;
  readonly effortCounts: Readonly<Record<string, number>>;
  readonly protocolCounts: Readonly<Record<
    "typed_tool" | "framed_text" | "local",
    number
  >>;
}

export interface TokenLedgerReconciliation {
  readonly consistent: boolean;
  readonly openRequestIds: readonly string[];
  readonly dispatchedOpenRequestIds: readonly string[];
  readonly orphanDispatchedRequestIds: readonly string[];
}

export class TokenLedgerReconciliationError extends Error {
  readonly code = "TOKEN_LEDGER_RECONCILIATION_FAILED" as const;

  constructor(readonly reconciliation: TokenLedgerReconciliation) {
    super(
      "TOKEN_LEDGER_RECONCILIATION_FAILED: "
      + `${reconciliation.openRequestIds.length} open attempts, `
      + `${reconciliation.orphanDispatchedRequestIds.length} orphan dispatches`,
    );
    this.name = "TokenLedgerReconciliationError";
  }
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nonemptyId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function allowedTokens(baseline: number, cap: number): number {
  return Math.floor(baseline + baseline * cap + Number.EPSILON);
}

export class TokenLedger {
  readonly #mode: SchedulerMode;
  readonly #profile: OptimizationProfile;
  readonly #tokenIncreaseCap: number;
  #baselineTokens = 0;
  #spentTokens = 0;
  #tokenUsageComplete = true;
  readonly #baselinedTaskIds = new Set<string>();
  readonly #openReservations = new Map<string, OpenReservation>();
  readonly #dispatchedRequestIds = new Set<string>();
  readonly #terminalRequestIds = new Set<string>();
  #enforceDispatchLifecycle: boolean;
  #decisions = 0;
  #fallbacks = 0;
  #recoveries = 0;
  #plannerDeadlines = 0;
  #throttles = 0;
  #planningStatus: SchedulerPlanningStatus;
  #predictedTokens = 0;
  #predictedWallTimeMs = 0;
  #actualWallTimeMs = 0;
  #baselineWallTimeMs = 0;
  #contextProfiles: Record<string, "lean" | "balanced" | "rich"> = {};
  #effortCounts: Record<string, number> = {};
  #protocolCounts: Record<"typed_tool" | "framed_text" | "local", number> = {
    typed_tool: 0,
    framed_text: 0,
    local: 0,
  };

  private constructor(
    init: TokenLedgerInit,
    enforceDispatchLifecycle = init.enforceDispatchLifecycle ?? false,
  ) {
    this.#mode = init.mode;
    this.#profile = init.profile;
    if (!(init.tokenIncreaseCap >= 0) || !Number.isFinite(init.tokenIncreaseCap)) {
      throw new TypeError("tokenIncreaseCap must be a finite non-negative number");
    }
    this.#tokenIncreaseCap = init.tokenIncreaseCap;
    this.#enforceDispatchLifecycle = enforceDispatchLifecycle;
    this.#planningStatus = init.mode === "off"
      ? "disabled"
      : init.mode === "shadow"
        ? "shadow"
        : "optimal";
  }

  static create(init: TokenLedgerInit): TokenLedger {
    return new TokenLedger(init);
  }

  static fromEvents(
    init: TokenLedgerInit,
    events: readonly LedgerEvent[],
  ): TokenLedger {
    const ledger = new TokenLedger(init, false);
    for (const event of events) {
      ledger.apply(event);
    }
    ledger.#enforceDispatchLifecycle = init.enforceDispatchLifecycle ?? false;
    return ledger;
  }

  apply(event: LedgerEvent): void {
    switch (event.type) {
      case "baseline_added":
        this.#applyBaseline(event);
        return;
      case "reserved":
        this.#applyReserved(event);
        return;
      case "dispatched":
        this.#applyDispatched(event);
        return;
      case "settled":
        this.#applySettled(event);
        return;
      case "released":
        this.#applyReleased(event);
        return;
      case "counters_patched":
        this.#applyCounters(event.patch);
        return;
      default: {
        const _exhaustive: never = event;
        throw new TypeError(`unknown ledger event: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  state(): LedgerState {
    return {
      baselineTokens: this.#baselineTokens,
      allowedTokens: allowedTokens(this.#baselineTokens, this.#tokenIncreaseCap),
      spentTokens: this.#spentTokens,
      reservedTokens: this.#reservedSum(),
      tokenUsageComplete: this.#tokenUsageComplete,
      baselinedTaskIds: new Set(this.#baselinedTaskIds),
      openReservations: new Map(this.#openReservations),
      dispatchedRequestIds: new Set(this.#dispatchedRequestIds),
      terminalRequestIds: new Set(this.#terminalRequestIds),
      decisions: this.#decisions,
      fallbacks: this.#fallbacks,
      recoveries: this.#recoveries,
      plannerDeadlines: this.#plannerDeadlines,
      throttles: this.#throttles,
      planningStatus: this.#planningStatus,
      predictedTokens: this.#predictedTokens,
      predictedWallTimeMs: this.#predictedWallTimeMs,
      actualWallTimeMs: this.#actualWallTimeMs,
      baselineWallTimeMs: this.#baselineWallTimeMs,
      contextProfiles: { ...this.#contextProfiles },
      effortCounts: { ...this.#effortCounts },
      protocolCounts: { ...this.#protocolCounts },
    };
  }

  reconcile(): TokenLedgerReconciliation {
    const openRequestIds = [...this.#openReservations.keys()].sort();
    const dispatchedOpenRequestIds = [...this.#dispatchedRequestIds]
      .filter((requestId) => this.#openReservations.has(requestId))
      .sort();
    const orphanDispatchedRequestIds = [...this.#dispatchedRequestIds]
      .filter((requestId) => !this.#openReservations.has(requestId))
      .sort();
    return {
      consistent: openRequestIds.length === 0
        && orphanDispatchedRequestIds.length === 0,
      openRequestIds,
      dispatchedOpenRequestIds,
      orphanDispatchedRequestIds,
    };
  }

  assertReconciled(): void {
    const reconciliation = this.reconcile();
    if (!reconciliation.consistent) {
      throw new TokenLedgerReconciliationError(reconciliation);
    }
  }

  canReserve(
    newReserveTokens: number,
    conservativeHorizonFloor: number,
  ): boolean {
    const next = nonnegativeInteger(newReserveTokens, "newReserveTokens");
    const floor = nonnegativeInteger(
      conservativeHorizonFloor,
      "conservativeHorizonFloor",
    );
    const allowed = allowedTokens(this.#baselineTokens, this.#tokenIncreaseCap);
    return this.#spentTokens + this.#reservedSum() + next + floor <= allowed;
  }

  toSchedulerRunReport(): SchedulerRunReport {
    const state = this.state();
    return {
      mode: this.#mode,
      profile: this.#profile,
      planningStatus: state.planningStatus,
      decisions: state.decisions,
      fallbacks: state.fallbacks,
      baselineWallTimeMs: state.baselineWallTimeMs,
      predictedWallTimeMs: state.predictedWallTimeMs,
      actualWallTimeMs: state.actualWallTimeMs,
      baselineTokens: state.baselineTokens,
      allowedTokens: state.allowedTokens,
      predictedTokens: state.predictedTokens,
      actualTokens: state.spentTokens,
      tokenUsageComplete: state.tokenUsageComplete,
      contextProfiles: { ...state.contextProfiles },
      effortCounts: { ...state.effortCounts },
      protocolCounts: { ...state.protocolCounts },
      plannerDeadlines: state.plannerDeadlines,
      throttles: state.throttles,
      recoveries: state.recoveries,
    };
  }

  #reservedSum(): number {
    let total = 0;
    for (const reservation of this.#openReservations.values()) {
      total += reservation.predictedTokens;
    }
    return total;
  }

  #applyBaseline(event: Extract<LedgerEvent, { type: "baseline_added" }>): void {
    const tokens = nonnegativeInteger(event.baselineTokens, "baselineTokens");
    if (event.taskIds.length === 0) {
      throw new TypeError("baseline_added requires at least one taskId");
    }
    for (const taskId of event.taskIds) {
      const id = nonemptyId(taskId, "baseline taskId");
      if (this.#baselinedTaskIds.has(id)) {
        throw new Error(`baseline task id already recorded: ${id}`);
      }
    }
    for (const taskId of event.taskIds) {
      this.#baselinedTaskIds.add(taskId);
    }
    this.#baselineTokens += tokens;
  }

  #applyReserved(event: Extract<LedgerEvent, { type: "reserved" }>): void {
    const requestId = nonemptyId(event.requestId, "requestId");
    if (this.#openReservations.has(requestId)
      || this.#terminalRequestIds.has(requestId)) {
      throw new Error(`request already reserved or terminal: ${requestId}`);
    }
    const predictedTokens = nonnegativeInteger(
      event.predictedTokens,
      "predictedTokens",
    );
    nonnegativeInteger(event.attempt, "attempt");
    this.#openReservations.set(requestId, {
      requestId,
      purpose: event.purpose,
      taskIds: [...event.taskIds],
      predictedTokens,
      attempt: event.attempt,
    });
  }

  #applyDispatched(event: Extract<LedgerEvent, { type: "dispatched" }>): void {
    const requestId = nonemptyId(event.requestId, "requestId");
    if (!this.#openReservations.has(requestId)) {
      throw new Error(`dispatch for unknown request (not open): ${requestId}`);
    }
    if (this.#dispatchedRequestIds.has(requestId)) {
      throw new Error(`request already dispatched: ${requestId}`);
    }
    this.#dispatchedRequestIds.add(requestId);
  }

  #applySettled(event: Extract<LedgerEvent, { type: "settled" }>): void {
    const requestId = nonemptyId(event.requestId, "requestId");
    const open = this.#openReservations.get(requestId);
    if (open === undefined) {
      throw new Error(`settle for unknown request (not open): ${requestId}`);
    }
    if (this.#enforceDispatchLifecycle
      && !this.#dispatchedRequestIds.has(requestId)) {
      throw new Error(`settle requires dispatched request: ${requestId}`);
    }
    const actualTokens = nonnegativeInteger(event.actualTokens, "actualTokens");
    this.#openReservations.delete(requestId);
    this.#dispatchedRequestIds.delete(requestId);
    this.#terminalRequestIds.add(requestId);
    if (event.usageComplete) {
      this.#spentTokens += actualTokens;
    } else {
      this.#spentTokens += Math.max(actualTokens, open.predictedTokens);
      this.#tokenUsageComplete = false;
    }
  }

  #applyReleased(event: Extract<LedgerEvent, { type: "released" }>): void {
    const requestId = nonemptyId(event.requestId, "requestId");
    if (!this.#openReservations.has(requestId)) {
      throw new Error(`release for unknown request (not open): ${requestId}`);
    }
    if (this.#enforceDispatchLifecycle
      && this.#dispatchedRequestIds.has(requestId)) {
      throw new Error(`cannot release dispatched request as unlaunched: ${requestId}`);
    }
    this.#openReservations.delete(requestId);
    this.#terminalRequestIds.add(requestId);
  }

  #applyCounters(patch: SchedulerCountersPatch): void {
    if (patch.decisions !== undefined) {
      this.#decisions = nonnegativeInteger(patch.decisions, "decisions");
    }
    if (patch.fallbacks !== undefined) {
      this.#fallbacks = nonnegativeInteger(patch.fallbacks, "fallbacks");
    }
    if (patch.recoveries !== undefined) {
      this.#recoveries = nonnegativeInteger(patch.recoveries, "recoveries");
    }
    if (patch.plannerDeadlines !== undefined) {
      this.#plannerDeadlines = nonnegativeInteger(
        patch.plannerDeadlines,
        "plannerDeadlines",
      );
    }
    if (patch.throttles !== undefined) {
      this.#throttles = nonnegativeInteger(patch.throttles, "throttles");
    }
    if (patch.planningStatus !== undefined) {
      this.#planningStatus = patch.planningStatus;
    }
    if (patch.predictedTokens !== undefined) {
      this.#predictedTokens = nonnegativeInteger(
        patch.predictedTokens,
        "predictedTokens",
      );
    }
    if (patch.predictedWallTimeMs !== undefined) {
      this.#predictedWallTimeMs = nonnegativeInteger(
        patch.predictedWallTimeMs,
        "predictedWallTimeMs",
      );
    }
    if (patch.actualWallTimeMs !== undefined) {
      this.#actualWallTimeMs = nonnegativeInteger(
        patch.actualWallTimeMs,
        "actualWallTimeMs",
      );
    }
    if (patch.baselineWallTimeMs !== undefined) {
      this.#baselineWallTimeMs = nonnegativeInteger(
        patch.baselineWallTimeMs,
        "baselineWallTimeMs",
      );
    }
    if (patch.contextProfiles !== undefined) {
      this.#contextProfiles = { ...patch.contextProfiles };
    }
    if (patch.effortCounts !== undefined) {
      this.#effortCounts = { ...patch.effortCounts };
    }
    if (patch.protocolCounts !== undefined) {
      this.#protocolCounts = {
        typed_tool: patch.protocolCounts.typed_tool ?? this.#protocolCounts.typed_tool,
        framed_text: patch.protocolCounts.framed_text ?? this.#protocolCounts.framed_text,
        local: patch.protocolCounts.local ?? this.#protocolCounts.local,
      };
    }
  }
}
