import type { SourceLanguageProfile } from "../language/types.js";

export interface BudgetTokenEstimate {
  readonly tokens: number;
  readonly uncertainty?: number;
  readonly estimatorVersion?: string;
}

export interface BudgetTokenEstimator {
  estimateText(
    text: string,
    profile: SourceLanguageProfile,
    options?: { readonly modelId?: string },
  ): BudgetTokenEstimate;
  estimateJson?(
    value: unknown,
    profile: SourceLanguageProfile,
    options?: { readonly modelId?: string },
  ): BudgetTokenEstimate;
}

export interface BudgetOracleOptions {
  readonly modelId?: string;
  readonly contextWindowTokens: number;
  readonly maxCompletionTokens?: number;
  readonly visibleOutputUpperBound: number;
  readonly reasoningUpperBound: number;
  readonly protocolFallbackReserve?: number;
  readonly safetyMarginTokens: number;
}

export interface BudgetPayloadComponent<Kind extends string = string> {
  readonly kind: Kind;
  readonly text: string;
  readonly jsonPayload?: unknown;
}

export interface BudgetComponentAssessment<Kind extends string = string> {
  readonly kind: Kind;
  readonly tokens: number;
  readonly uncertaintyTokens: number;
  readonly estimatorVersion?: string;
}

export interface BudgetOracleAssessment<Kind extends string = string> {
  readonly components: readonly BudgetComponentAssessment<Kind>[];
  readonly inputTokens: number;
  readonly inputUncertaintyTokens: number;
  readonly visibleOutputUpperBound: number;
  readonly reasoningUpperBound: number;
  readonly protocolFallbackReserve: number;
  readonly safetyMarginTokens: number;
  readonly totalReservation: number;
  readonly contextWindowTokens: number;
  readonly fits: boolean;
}

export function coldStartReasoningUpperBound(
  maxCompletionTokens: number,
  effort: string | undefined,
): number {
  const capacity = nonnegativeInteger(
    Math.floor(maxCompletionTokens),
    "maxCompletionTokens",
  );
  const reserve = (
    fraction: number,
    minimum: number,
  ): number => Math.min(
    capacity,
    Math.max(minimum, Math.ceil(capacity * fraction)),
  );
  switch (effort) {
    case "off":
      return 0;
    case "minimal":
      return reserve(0.04, 256);
    case "low":
      return reserve(0.12, 512);
    case "medium":
    case "on":
      return reserve(0.30, 1_024);
    case "xhigh":
      return reserve(0.70, 3_072);
    case "max":
      return reserve(0.82, 4_096);
    case "high":
    case undefined:
    default:
      return reserve(0.55, 2_048);
  }
}

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

function normalizeEstimate(value: BudgetTokenEstimate, label: string): {
  tokens: number;
  uncertaintyTokens: number;
  estimatorVersion?: string;
} {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must return an estimate object`);
  }
  const tokens = Math.ceil(value.tokens);
  const uncertaintyTokens = Math.ceil(value.uncertainty ?? 0);
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new TypeError(`${label}.tokens must be a non-negative finite number`);
  }
  if (!Number.isSafeInteger(uncertaintyTokens) || uncertaintyTokens < 0) {
    throw new TypeError(`${label}.uncertainty must be a non-negative finite number`);
  }
  return {
    tokens,
    uncertaintyTokens,
    ...(value.estimatorVersion === undefined
      ? {}
      : { estimatorVersion: value.estimatorVersion }),
  };
}

function addSafely(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds safe integer range`);
  }
  return result;
}

/**
 * One exact-payload budget calculator shared by every provider task type.
 * It deliberately knows nothing about translation windows or scheduler state.
 */
export class BudgetOracle {
  readonly #estimator: BudgetTokenEstimator;
  readonly #options: Required<Omit<BudgetOracleOptions, "modelId" | "maxCompletionTokens">>
    & Pick<BudgetOracleOptions, "modelId" | "maxCompletionTokens">;

  constructor(
    estimator: BudgetTokenEstimator,
    options: BudgetOracleOptions,
  ) {
    const visibleOutputUpperBound = nonnegativeInteger(
      options.visibleOutputUpperBound,
      "visibleOutputUpperBound",
    );
    const reasoningUpperBound = nonnegativeInteger(
      options.reasoningUpperBound,
      "reasoningUpperBound",
    );
    const maxCompletionTokens = options.maxCompletionTokens === undefined
      ? undefined
      : positiveInteger(options.maxCompletionTokens, "maxCompletionTokens");
    if (maxCompletionTokens !== undefined
      && visibleOutputUpperBound + reasoningUpperBound > maxCompletionTokens) {
      throw new RangeError(
        "visible output and reasoning reservation exceed model completion capacity",
      );
    }
    this.#estimator = estimator;
    this.#options = {
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
      contextWindowTokens: positiveInteger(
        options.contextWindowTokens,
        "contextWindowTokens",
      ),
      visibleOutputUpperBound,
      reasoningUpperBound,
      protocolFallbackReserve: nonnegativeInteger(
        options.protocolFallbackReserve ?? 0,
        "protocolFallbackReserve",
      ),
      safetyMarginTokens: nonnegativeInteger(
        options.safetyMarginTokens,
        "safetyMarginTokens",
      ),
    };
  }

  assess<Kind extends string>(
    payload: readonly BudgetPayloadComponent<Kind>[],
    profile: SourceLanguageProfile,
  ): BudgetOracleAssessment<Kind> {
    if (payload.length === 0) {
      throw new TypeError("budget payload requires at least one component");
    }
    const components = payload.map((component): BudgetComponentAssessment<Kind> => {
      const textual = normalizeEstimate(
        this.#estimator.estimateText(
          component.text,
          profile,
          { modelId: this.#options.modelId },
        ),
        `estimateText(${component.kind})`,
      );
      const structured = component.jsonPayload === undefined
        ? undefined
        : this.#estimator.estimateJson === undefined
          ? normalizeEstimate(
              this.#estimator.estimateText(
                JSON.stringify(component.jsonPayload) ?? "null",
                profile,
                { modelId: this.#options.modelId },
              ),
              `estimateText(json:${component.kind})`,
            )
          : normalizeEstimate(
              this.#estimator.estimateJson(
                component.jsonPayload,
                profile,
                { modelId: this.#options.modelId },
              ),
              `estimateJson(${component.kind})`,
            );
      return {
        kind: component.kind,
        tokens: Math.max(textual.tokens, structured?.tokens ?? 0),
        uncertaintyTokens: Math.max(
          textual.uncertaintyTokens,
          structured?.uncertaintyTokens ?? 0,
        ),
        ...(textual.estimatorVersion === undefined
          && structured?.estimatorVersion === undefined
          ? {}
          : {
              estimatorVersion:
                textual.estimatorVersion ?? structured?.estimatorVersion,
            }),
      };
    });
    const inputTokens = components.reduce(
      (total, component) =>
        addSafely(total, component.tokens, "input token total"),
      0,
    );
    const inputUncertaintyTokens = components.reduce(
      (total, component) => addSafely(
        total,
        component.uncertaintyTokens,
        "input uncertainty total",
      ),
      0,
    );
    const totalReservation = [
      inputTokens,
      inputUncertaintyTokens,
      this.#options.visibleOutputUpperBound,
      this.#options.reasoningUpperBound,
      this.#options.protocolFallbackReserve,
      this.#options.safetyMarginTokens,
    ].reduce(
      (total, value) =>
        addSafely(total, value, "provider request reservation"),
      0,
    );
    return {
      components,
      inputTokens,
      inputUncertaintyTokens,
      visibleOutputUpperBound: this.#options.visibleOutputUpperBound,
      reasoningUpperBound: this.#options.reasoningUpperBound,
      protocolFallbackReserve: this.#options.protocolFallbackReserve,
      safetyMarginTokens: this.#options.safetyMarginTokens,
      totalReservation,
      contextWindowTokens: this.#options.contextWindowTokens,
      fits: totalReservation <= this.#options.contextWindowTokens,
    };
  }
}
