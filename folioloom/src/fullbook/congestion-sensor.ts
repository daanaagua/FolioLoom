import {
  AdaptiveScheduler,
  type SchedulerObservation,
  type SchedulerPermit,
} from "./adaptive-scheduler.js";

export type CongestionTier = "clear" | "warm" | "congested";

export interface CongestionSnapshot {
  readonly tier: CongestionTier;
  readonly recommendedConcurrency: number;
  readonly congestionEvents: number;
  readonly successfulObservations: number;
  readonly inFlight: number;
}

export interface SlotAcquireOptions {
  /**
   * internal: legacy dual gate (concurrency + AIMD token budget)
   * external: concurrency only; token envelope is owned by AdmissionController
   */
  readonly tokenGate: "internal" | "external";
}

/**
 * AIMD-backed congestion sensor. In active mode the runner should use
 * tokenGate="external" so only concurrency slots come from this sensor;
 * token hard gates live on the durable ledger.
 */
export class CongestionSensor {
  readonly #adaptive: AdaptiveScheduler;

  constructor(adaptive: AdaptiveScheduler) {
    this.#adaptive = adaptive;
  }

  get adaptive(): AdaptiveScheduler {
    return this.#adaptive;
  }

  observe(observation: SchedulerObservation): void {
    this.#adaptive.observe(observation);
  }

  snapshot(): CongestionSnapshot {
    const snap = this.#adaptive.snapshot();
    const tier: CongestionTier = snap.congestionEvents === 0
      ? "clear"
      : snap.concurrency <= 1
        ? "congested"
        : "warm";
    return {
      tier,
      recommendedConcurrency: snap.concurrency,
      congestionEvents: snap.congestionEvents,
      successfulObservations: snap.successfulObservations,
      inFlight: snap.inFlight,
    };
  }

  tryAcquireSlot(
    estimatedTokens: number,
    options: SlotAcquireOptions,
  ): SchedulerPermit | undefined {
    return this.#adaptive.tryAcquire(estimatedTokens, {
      tokenGate: options.tokenGate,
    });
  }
}
