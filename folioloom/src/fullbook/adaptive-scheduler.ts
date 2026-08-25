export type SchedulerObservationStatus =
  | "success"
  | "throttled"
  | "timeout"
  | "busy"
  | "context"
  | "failed";

export interface SchedulerObservation {
  status: SchedulerObservationStatus;
  durationMs: number;
  estimatedTokens: number;
}

export interface AdaptiveSchedulerSnapshot {
  version: "adaptive-scheduler-1";
  concurrency: number;
  maxConcurrency: number;
  maxInFlightTokens: number;
  inFlight: number;
  inFlightTokens: number;
  successfulObservations: number;
  congestionEvents: number;
}

export interface AdaptiveSchedulerOptions {
  initialConcurrency: number;
  maxConcurrency: number;
  maxInFlightTokens: number;
  snapshot?: AdaptiveSchedulerSnapshot;
}

export interface SchedulerPermit {
  release(): void;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

export class AdaptiveScheduler {
  readonly #maxConcurrency: number;
  readonly #maxInFlightTokens: number;
  readonly #permits = new Map<symbol, number>();
  #concurrency: number;
  #inFlightTokens = 0;
  #successfulObservations = 0;
  #congestionEvents = 0;

  constructor(options: AdaptiveSchedulerOptions) {
    const initialConcurrency = positiveInteger(options.initialConcurrency, "initialConcurrency");
    this.#maxConcurrency = positiveInteger(options.maxConcurrency, "maxConcurrency");
    this.#maxInFlightTokens = positiveInteger(options.maxInFlightTokens, "maxInFlightTokens");
    if (initialConcurrency > this.#maxConcurrency) {
      throw new TypeError("initialConcurrency must not exceed maxConcurrency");
    }
    const snapshot = options.snapshot;
    if (snapshot === undefined) {
      this.#concurrency = initialConcurrency;
      return;
    }
    if (snapshot.version !== "adaptive-scheduler-1"
      || snapshot.inFlight !== 0
      || snapshot.inFlightTokens !== 0) {
      throw new TypeError("scheduler snapshot is incompatible or contains active work");
    }
    const priorMaxConcurrency = positiveInteger(
      snapshot.maxConcurrency,
      "snapshot.maxConcurrency",
    );
    positiveInteger(snapshot.maxInFlightTokens, "snapshot.maxInFlightTokens");
    const priorConcurrency = positiveInteger(snapshot.concurrency, "snapshot.concurrency");
    if (priorConcurrency > priorMaxConcurrency) {
      throw new TypeError("snapshot concurrency exceeds snapshot.maxConcurrency");
    }
    this.#concurrency = Math.min(priorConcurrency, this.#maxConcurrency);
    this.#successfulObservations = positiveOrZeroInteger(
      snapshot.successfulObservations,
      "snapshot.successfulObservations",
    );
    this.#congestionEvents = positiveOrZeroInteger(
      snapshot.congestionEvents,
      "snapshot.congestionEvents",
    );
  }

  tryAcquire(
    estimatedTokens: number,
    options: { readonly tokenGate?: "internal" | "external" } = {},
  ): SchedulerPermit | undefined {
    const tokens = positiveInteger(estimatedTokens, "estimatedTokens");
    const tokenGate = options.tokenGate ?? "internal";
    if (this.#permits.size >= this.#concurrency) {
      return undefined;
    }
    if (tokenGate === "internal"
      && this.#inFlightTokens + tokens > this.#maxInFlightTokens) {
      return undefined;
    }
    const id = Symbol("scheduler-permit");
    // External token gate: still track estimated tokens for snapshots, but do
    // not refuse the slot — durable envelope lives on TokenLedger.
    this.#permits.set(id, tokens);
    this.#inFlightTokens += tokens;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const reserved = this.#permits.get(id);
        if (reserved === undefined) return;
        this.#permits.delete(id);
        this.#inFlightTokens -= reserved;
      },
    };
  }

  observe(observation: SchedulerObservation): void {
    nonNegativeFinite(observation.durationMs, "durationMs");
    positiveInteger(observation.estimatedTokens, "estimatedTokens");
    if (observation.status === "success") {
      this.#successfulObservations += 1;
      this.#concurrency = Math.min(this.#maxConcurrency, this.#concurrency + 1);
      return;
    }
    if (observation.status === "throttled"
      || observation.status === "timeout"
      || observation.status === "busy") {
      this.#congestionEvents += 1;
      this.#concurrency = Math.max(1, Math.floor(this.#concurrency / 2));
    }
  }

  snapshot(): AdaptiveSchedulerSnapshot {
    return {
      version: "adaptive-scheduler-1",
      concurrency: this.#concurrency,
      maxConcurrency: this.#maxConcurrency,
      maxInFlightTokens: this.#maxInFlightTokens,
      inFlight: this.#permits.size,
      inFlightTokens: this.#inFlightTokens,
      successfulObservations: this.#successfulObservations,
      congestionEvents: this.#congestionEvents,
    };
  }
}

function positiveOrZeroInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
