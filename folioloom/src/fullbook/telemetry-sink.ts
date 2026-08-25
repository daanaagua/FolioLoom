import type {
  OnlineRuntimeCostModel,
  RuntimeCostObservation,
} from "./runtime-cost-model.js";
import type { RuntimeObservation } from "./runtime-telemetry.js";
import type { RuntimeProfileStore } from "../storage/runtime-profile-store.js";

export interface TelemetrySinkOptions {
  readonly costModel: OnlineRuntimeCostModel;
  readonly profileStore?: RuntimeProfileStore;
}

/**
 * Numeric telemetry only: cost-model learning and optional profile-store log.
 * Never accepts prompt text, API keys, or full private paths.
 */
export class TelemetrySink {
  readonly #costModel: OnlineRuntimeCostModel;
  readonly #profileStore: RuntimeProfileStore | undefined;

  constructor(options: TelemetrySinkOptions) {
    this.#costModel = options.costModel;
    this.#profileStore = options.profileStore;
  }

  observeRuntime(observation: RuntimeCostObservation): void {
    this.#costModel.observe(observation);
  }

  appendProfileObservation(observation: RuntimeObservation): void {
    this.#profileStore?.appendObservation(observation);
  }
}
