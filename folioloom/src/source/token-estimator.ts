import type { SourceLanguageProfile } from "../language/types.js";

export const LEGACY_TOKEN_ESTIMATOR_VERSION = "legacy-scalar-v1";
export const WEIGHTED_TOKEN_ESTIMATOR_VERSION = "weighted-unicode-v1";

const WEIGHT_SCALE = 100;
const CJK_SCALAR_WEIGHT_UNITS = 85;
const LATIN_OR_DIGIT_WEIGHT_UNITS = 30;
const WHITESPACE_OR_PUNCTUATION_WEIGHT_UNITS = 20;
const OTHER_SCALAR_WEIGHT_UNITS = 55;
const PARAGRAPH_BOUNDARY_OVERHEAD = 1;
const STRUCTURED_FIELD_OVERHEAD = 1;
const CURSOR_LINE_BREAK_OVERHEAD_UNITS = WEIGHT_SCALE;
const CURSOR_NONEMPTY_RANGE_OVERHEAD = 1;
const MIN_CALIBRATION_FACTOR = 0.85;
const MAX_CALIBRATION_FACTOR = 1.25;
const CALIBRATION_SMOOTHING = 0.20;
const MAX_UINT32 = 0xffff_ffff;
const MAX_CURSOR_UNITS_PER_SCALAR = (
  CJK_SCALAR_WEIGHT_UNITS + CURSOR_LINE_BREAK_OVERHEAD_UNITS
);

const LATIN = /\p{Script=Latin}/u;
const NUMBER = /\p{Number}/u;
const WHITESPACE = /\s/u;
const PUNCTUATION = /\p{Punctuation}/u;

export interface TokenEstimate {
  tokens: number;
  uncertainty: number;
  estimatorVersion: string;
  calibrationFactor: number;
}

export interface TokenEstimateOptions {
  /** Structured prompt fields carried beside the source text, such as a heading. */
  structuredFields?: number;
  /** Calibration remains local to a provider/model and source-language profile. */
  modelId?: string;
}

export interface UsageObservation {
  modelId: string;
  profile: SourceLanguageProfile;
  estimatedTokens: number;
  actualInputTokens: number;
}

/**
 * An immutable index for one source string. Its range estimate is deliberately
 * conservative: it makes budget cuts safe without rescanning source prefixes.
 */
export interface TokenEstimationCursor {
  readonly estimatorVersion: string;
  estimateRangeUpperBound(
    startScalar: number,
    endScalar: number,
    options?: TokenEstimateOptions,
  ): TokenEstimate;
  maximumEndWithinBudget(
    startScalar: number,
    maxSourceTokens: number,
    options?: TokenEstimateOptions,
  ): number;
}

export interface TokenEstimator {
  readonly id: string;
  readonly version: string;
  estimateText(
    text: string,
    profile: SourceLanguageProfile,
    options?: TokenEstimateOptions,
  ): TokenEstimate;
  estimateJson?(
    value: unknown,
    profile: SourceLanguageProfile,
    options?: TokenEstimateOptions,
  ): TokenEstimate;
  /** Optional fast path; text-only estimators remain valid through a bounded fallback. */
  createCursor?(text: string, profile: SourceLanguageProfile): TokenEstimationCursor;
  observeUsage(sample: UsageObservation): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function paragraphCount(text: string): number {
  if (text.trim().length === 0) {
    return 0;
  }
  return text
    .trim()
    .split(/(?:\r\n|\r|\n)[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)+/u)
    .filter((paragraph) => paragraph.trim().length > 0)
    .length;
}

function isCjkScalar(scalar: string): boolean {
  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  return (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x1100 && codePoint <= 0x11ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x323af);
}

function scalarWeightUnits(scalar: string): number {
  if (isCjkScalar(scalar)) {
    return CJK_SCALAR_WEIGHT_UNITS;
  }
  if (LATIN.test(scalar) || NUMBER.test(scalar)) {
    return LATIN_OR_DIGIT_WEIGHT_UNITS;
  }
  if (WHITESPACE.test(scalar) || PUNCTUATION.test(scalar)) {
    return WHITESPACE_OR_PUNCTUATION_WEIGHT_UNITS;
  }
  return OTHER_SCALAR_WEIGHT_UNITS;
}

function rawTokenUnits(text: string): number {
  let units = 0;
  for (const scalar of text) {
    units += scalarWeightUnits(scalar);
  }
  return units;
}

function requireNonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function requireNonNegativeInteger(value: number | undefined, label: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function createPrefixIndex(text: string): {
  readonly prefix: Uint32Array | Float64Array;
  readonly scalarLength: number;
} {
  const useFloat64 = text.length > Math.floor(MAX_UINT32 / MAX_CURSOR_UNITS_PER_SCALAR);
  const prefix = useFloat64
    ? new Float64Array(text.length + 1)
    : new Uint32Array(text.length + 1);
  let totalUnits = 0;
  let scalarLength = 0;
  for (const scalar of text) {
    totalUnits += scalarWeightUnits(scalar)
      + (scalar === "\r" || scalar === "\n" ? CURSOR_LINE_BREAK_OVERHEAD_UNITS : 0);
    scalarLength += 1;
    prefix[scalarLength] = totalUnits;
  }
  return { prefix, scalarLength };
}

/**
 * A deterministic Unicode-density estimate with optional, bounded provider calibration.
 * It deliberately models text shape rather than pretending to know any provider tokenizer.
 */
export class WeightedTokenEstimator implements TokenEstimator {
  readonly id = "weighted-unicode";
  readonly version = WEIGHTED_TOKEN_ESTIMATOR_VERSION;
  readonly #calibrationByScope = new Map<string, number>();

  estimateText(
    text: string,
    profile: SourceLanguageProfile,
    options: TokenEstimateOptions = {},
  ): TokenEstimate {
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    const structuredFields = requireNonNegativeInteger(
      options.structuredFields,
      "structuredFields",
    );
    const rawTokens = rawTokenUnits(text) / WEIGHT_SCALE
      + paragraphCount(text) * PARAGRAPH_BOUNDARY_OVERHEAD
      + structuredFields * STRUCTURED_FIELD_OVERHEAD;
    return this.#estimateRawTokens(rawTokens, profile, options);
  }

  createCursor(text: string, profile: SourceLanguageProfile): TokenEstimationCursor {
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    const { prefix, scalarLength } = createPrefixIndex(text);
    const requireRange = (startScalar: number, endScalar: number): void => {
      if (!Number.isSafeInteger(startScalar)
        || !Number.isSafeInteger(endScalar)
        || startScalar < 0
        || endScalar < startScalar
        || endScalar > scalarLength) {
        throw new RangeError(`scalar range is outside source: [${startScalar}, ${endScalar})`);
      }
    };
    const rawUpperBound = (
      startScalar: number,
      endScalar: number,
      structuredFields: number,
    ): number => (
      ((prefix[endScalar] as number) - (prefix[startScalar] as number)) / WEIGHT_SCALE
      + (endScalar > startScalar ? CURSOR_NONEMPTY_RANGE_OVERHEAD : 0)
      + structuredFields * STRUCTURED_FIELD_OVERHEAD
    );
    return {
      estimatorVersion: this.version,
      estimateRangeUpperBound: (
        startScalar: number,
        endScalar: number,
        options: TokenEstimateOptions = {},
      ): TokenEstimate => {
        requireRange(startScalar, endScalar);
        const structuredFields = requireNonNegativeInteger(
          options.structuredFields,
          "structuredFields",
        );
        return this.#estimateRawTokens(
          rawUpperBound(startScalar, endScalar, structuredFields),
          profile,
          options,
        );
      },
      maximumEndWithinBudget: (
        startScalar: number,
        maxSourceTokens: number,
        options: TokenEstimateOptions = {},
      ): number => {
        requireRange(startScalar, startScalar);
        requirePositiveInteger(maxSourceTokens, "maxSourceTokens");
        const structuredFields = requireNonNegativeInteger(
          options.structuredFields,
          "structuredFields",
        );
        const calibrationFactor = this.#calibrationForOptions(profile, options);
        let low = startScalar + 1;
        let high = scalarLength;
        let best = startScalar;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const rawTokens = rawUpperBound(startScalar, middle, structuredFields);
          if (this.#tokensForRawTokens(rawTokens, calibrationFactor) <= maxSourceTokens) {
            best = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        return best === startScalar ? Math.min(startScalar + 1, scalarLength) : best;
      },
    };
  }

  estimateJson(
    value: unknown,
    profile: SourceLanguageProfile,
    options: TokenEstimateOptions = {},
  ): TokenEstimate {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new TypeError(
        `value must be JSON-serializable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    return this.estimateText(serialized ?? "null", profile, options);
  }

  observeUsage(sample: UsageObservation): void {
    const modelId = requireNonempty(sample.modelId, "sample.modelId");
    if (!Number.isFinite(sample.estimatedTokens) || sample.estimatedTokens <= 0) {
      throw new TypeError("sample.estimatedTokens must be finite and positive");
    }
    if (!Number.isFinite(sample.actualInputTokens) || sample.actualInputTokens <= 0) {
      throw new TypeError("sample.actualInputTokens must be finite and positive");
    }
    const observedFactor = clamp(
      sample.actualInputTokens / sample.estimatedTokens,
      MIN_CALIBRATION_FACTOR,
      MAX_CALIBRATION_FACTOR,
    );
    const key = this.#scopeKey(modelId, sample.profile);
    const previous = this.#calibrationByScope.get(key) ?? 1;
    this.#calibrationByScope.set(
      key,
      clamp(
        previous + (observedFactor - previous) * CALIBRATION_SMOOTHING,
        MIN_CALIBRATION_FACTOR,
        MAX_CALIBRATION_FACTOR,
      ),
    );
  }

  #estimateRawTokens(
    rawTokens: number,
    profile: SourceLanguageProfile,
    options: TokenEstimateOptions,
  ): TokenEstimate {
    const calibrationFactor = this.#calibrationForOptions(profile, options);
    const tokens = this.#tokensForRawTokens(rawTokens, calibrationFactor);
    return {
      tokens,
      uncertainty: tokens === 0 ? 0 : Math.max(1, Math.ceil(tokens * 0.15)),
      estimatorVersion: this.version,
      calibrationFactor,
    };
  }

  #tokensForRawTokens(rawTokens: number, calibrationFactor: number): number {
    return rawTokens === 0 ? 0 : Math.max(1, Math.ceil(rawTokens * calibrationFactor));
  }

  #calibrationForOptions(
    profile: SourceLanguageProfile,
    options: TokenEstimateOptions,
  ): number {
    return options.modelId === undefined
      ? 1
      : this.#calibrationFor(requireNonempty(options.modelId, "modelId"), profile);
  }

  #calibrationFor(modelId: string, profile: SourceLanguageProfile): number {
    return this.#calibrationByScope.get(this.#scopeKey(modelId, profile)) ?? 1;
  }

  #scopeKey(modelId: string, profile: SourceLanguageProfile): string {
    return [modelId, profile.id, profile.version, this.version].join("\0");
  }
}
