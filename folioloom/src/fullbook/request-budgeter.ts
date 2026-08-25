import {
  prepareTranslationRequest,
  type TranslationRequestInput,
  type TranslationRequestSectionKind,
} from "../agents/translation-request.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  BudgetOracle,
  type BudgetComponentAssessment,
  type BudgetTokenEstimate,
  type BudgetTokenEstimator,
} from "./budget-oracle.js";

/** Minimal interface deliberately shared with the future source token estimator. */
export type RequestTokenEstimate = BudgetTokenEstimate;
export type RequestTokenEstimator = BudgetTokenEstimator;

export interface RequestBudgetOptions {
  /** Calibration scope for the provider/model that will execute this request. */
  readonly modelId?: string;
  /** Provider context capacity reserved for this complete request. */
  readonly contextWindowTokens: number;
  /** Provider maximum combined visible-output and hidden-reasoning tokens. */
  readonly maxCompletionTokens?: number;
  /** Expected completion budget, including all translated source blocks. */
  readonly outputTokens: number;
  /** Explicit hidden-reasoning reserve for models that use it. */
  readonly reasoningReserveTokens: number;
  /** Conservative fixed margin for provider framing and estimator error. */
  readonly safetyMarginTokens: number;
}

export type RequestBudgetComponentKind =
  | "system"
  | "request"
  | TranslationRequestSectionKind
  | "tool_schemas";

export interface RequestBudgetComponent {
  readonly kind: RequestBudgetComponentKind;
  readonly tokens: number;
  readonly uncertaintyTokens: number;
  readonly estimatorVersion?: string;
}

export type RequestBudgetDecision = "accepted" | "split_request" | "split_window";

export interface RequestBudgetAssessment {
  readonly components: readonly RequestBudgetComponent[];
  readonly inputTokens: number;
  readonly inputUncertaintyTokens: number;
  readonly outputTokens: number;
  readonly reasoningReserveTokens: number;
  readonly safetyMarginTokens: number;
  readonly totalReserved: number;
  readonly contextWindowTokens: number;
  readonly fits: boolean;
  /** A deterministic capacity action; this module never mutates scheduling state. */
  readonly decision: RequestBudgetDecision;
}

/**
 * Admission control for the exact prompt/tool payload that runtime will send.
 * It measures every text section and, when available, the corresponding JSON
 * projection.  Taking the higher estimate guards against optimistic estimators
 * without double counting the same serialized material.
 */
export class RequestBudgeter {
  readonly #estimator: RequestTokenEstimator;
  readonly #options: RequestBudgetOptions;

  constructor(estimator: RequestTokenEstimator, options: RequestBudgetOptions) {
    this.#estimator = estimator;
    this.#options = { ...options };
  }

  assess(input: TranslationRequestInput): RequestBudgetAssessment {
    const prepared = prepareTranslationRequest(input);
    const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
    const payload: Array<{
      kind: RequestBudgetComponentKind;
      text: string;
      jsonPayload?: unknown;
    }> = [{
      kind: "system",
      text: prepared.systemPrompt,
    }];
    for (const section of prepared.sections) {
      payload.push({
        kind: section.kind,
        text: section.text,
        ...(section.jsonPayload === undefined
          ? {}
          : { jsonPayload: section.jsonPayload }),
      });
    }
    const toolSchemaPayload = JSON.parse(prepared.serializedToolSchemas) as unknown;
    payload.push({
      kind: "tool_schemas",
      text: prepared.serializedToolSchemas,
      jsonPayload: toolSchemaPayload,
    });
    const assessment = new BudgetOracle(this.#estimator, {
      ...(this.#options.modelId === undefined
        ? {}
        : { modelId: this.#options.modelId }),
      contextWindowTokens: this.#options.contextWindowTokens,
      ...(this.#options.maxCompletionTokens === undefined
        ? {}
        : { maxCompletionTokens: this.#options.maxCompletionTokens }),
      visibleOutputUpperBound: this.#options.outputTokens,
      reasoningUpperBound: this.#options.reasoningReserveTokens,
      safetyMarginTokens: this.#options.safetyMarginTokens,
    }).assess(payload, profile);
    const fits = assessment.fits;
    const decision: RequestBudgetDecision = fits
      ? "accepted"
      : input.request.windows.length > 1
        ? "split_request"
        : "split_window";
    return {
      components: assessment.components as readonly RequestBudgetComponent[],
      inputTokens: assessment.inputTokens,
      inputUncertaintyTokens: assessment.inputUncertaintyTokens,
      outputTokens: this.#options.outputTokens,
      reasoningReserveTokens: this.#options.reasoningReserveTokens,
      safetyMarginTokens: this.#options.safetyMarginTokens,
      totalReserved: assessment.totalReservation,
      contextWindowTokens: this.#options.contextWindowTokens,
      fits,
      decision,
    };
  }
}
