import type {
  NormalizedRuntimeUsage,
  RuntimeObservationStatus,
} from "./runtime-telemetry.js";
import type {
  RuntimeProfileStore,
  StructuredValue,
} from "../storage/runtime-profile-store.js";

const FEATURE_DIMENSIONS = 10;
const FORGETTING_FACTOR = 0.97;
const FAILURE_PRIOR = 0.12;
const FAILURE_PRIOR_SAMPLES = 20;
const MIN_FAILURE_PROBABILITY = 0.001;
const MAX_FAILURE_PROBABILITY = 0.95;
const MAX_DURATION_MS = 6 * 60 * 60 * 1_000;
const MIN_TOKEN_RATIO = 0.1;
const MAX_TOKEN_RATIO = 10;

export interface RuntimeFeatures {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly sourceTokens: number;
  readonly effortRank: number;
  readonly cacheHitRatio: number;
  readonly concurrency: number;
  readonly batchWindows: number;
  readonly riskScore: number;
  readonly protocolRank: number;
}

export interface RuntimePrediction {
  readonly p50DurationMs: number;
  readonly p90DurationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly failureProbability: number;
  readonly confidence: number;
}

export interface RuntimeCostObservation {
  readonly features: RuntimeFeatures;
  readonly durationMs: number;
  readonly usage: NormalizedRuntimeUsage;
  readonly status: RuntimeObservationStatus;
  readonly observedAt: string;
}

export type RuntimeCostModelSnapshotStatus = "cold" | "valid" | "invalid";

export interface RuntimeCostModelSnapshot {
  readonly [key: string]: StructuredValue;
  readonly schemaVersion: "folioloom-runtime-cost-1";
  readonly profileKey: string;
  readonly durationWeights: readonly number[];
  readonly durationCovariance: readonly (readonly number[])[];
  readonly residualAbsoluteEma: number;
  readonly inputTokenRatio: number;
  readonly outputTokenRatio: number;
  readonly totalTokenRatio: number;
  readonly durationSamples: number;
  readonly tokenSamples: number;
  readonly failureSamples: number;
  readonly failureWeights: readonly number[];
  readonly statusCounts: Readonly<Record<RuntimeObservationStatus, number>>;
  readonly latestObservedAt: string | null;
}

interface RuntimeCostModelState {
  profileKey: string;
  durationWeights: number[];
  durationCovariance: number[][];
  residualAbsoluteEma: number;
  inputTokenRatio: number;
  outputTokenRatio: number;
  totalTokenRatio: number;
  durationSamples: number;
  tokenSamples: number;
  failureSamples: number;
  failureWeights: number[];
  statusCounts: Record<RuntimeObservationStatus, number>;
  latestObservedAt: string | null;
}

function finiteNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function tokenRatio(value: number, label: string): number {
  if (!Number.isFinite(value)
    || value < MIN_TOKEN_RATIO
    || value > MAX_TOKEN_RATIO) {
    throw new TypeError(
      `${label} must be between ${MIN_TOKEN_RATIO} and ${MAX_TOKEN_RATIO}`,
    );
  }
  return value;
}

function safeNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between zero and one`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateRuntimeFeatures(features: RuntimeFeatures): RuntimeFeatures {
  return {
    inputTokens: safeNonnegativeInteger(features.inputTokens, "input tokens"),
    outputTokens: safeNonnegativeInteger(features.outputTokens, "output tokens"),
    sourceTokens: safeNonnegativeInteger(features.sourceTokens, "source tokens"),
    effortRank: finiteNonnegative(features.effortRank, "effort rank"),
    cacheHitRatio: ratio(features.cacheHitRatio, "cache hit ratio"),
    concurrency: positiveInteger(features.concurrency, "concurrency"),
    batchWindows: positiveInteger(features.batchWindows, "batch windows"),
    riskScore: ratio(features.riskScore, "risk score"),
    protocolRank: finiteNonnegative(features.protocolRank, "protocol rank"),
  };
}

export function runtimeFeatureVector(
  rawFeatures: RuntimeFeatures,
): readonly number[] {
  const features = validateRuntimeFeatures(rawFeatures);
  return [
    1,
    Math.log1p(features.inputTokens),
    Math.log1p(features.outputTokens),
    Math.log1p(features.sourceTokens),
    features.effortRank,
    features.cacheHitRatio,
    features.concurrency,
    features.batchWindows,
    features.riskScore,
    features.protocolRank,
  ];
}

function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

function multiplyMatrixVector(
  matrix: readonly (readonly number[])[],
  vector: readonly number[],
): number[] {
  return matrix.map((row) => dot(row, vector));
}

function identityMatrix(size: number, scale: number): number[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => row === column ? scale : 0));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exponential = Math.exp(-value);
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function coldDurationWeights(): number[] {
  return [
    Math.log1p(100),
    0.45,
    0.15,
    0.05,
    0.12,
    -0.25,
    0.12,
    0.05,
    0.10,
    0.05,
  ];
}

function emptyStatusCounts(): Record<RuntimeObservationStatus, number> {
  return {
    success: 0,
    throttled: 0,
    timeout: 0,
    context: 0,
    protocol: 0,
    failed: 0,
  };
}

function coldState(profileKey: string): RuntimeCostModelState {
  const normalizedProfileKey = profileKey.trim();
  if (normalizedProfileKey.length === 0) {
    throw new TypeError("runtime cost profile key must be non-empty");
  }
  return {
    profileKey: normalizedProfileKey,
    durationWeights: coldDurationWeights(),
    durationCovariance: identityMatrix(FEATURE_DIMENSIONS, 8),
    residualAbsoluteEma: 0.55,
    inputTokenRatio: 1,
    outputTokenRatio: 1,
    totalTokenRatio: 1,
    durationSamples: 0,
    tokenSamples: 0,
    failureSamples: 0,
    failureWeights: Array.from({ length: FEATURE_DIMENSIONS }, () => 0),
    statusCounts: emptyStatusCounts(),
    latestObservedAt: null,
  };
}

function validateUsage(usage: NormalizedRuntimeUsage): void {
  safeNonnegativeInteger(usage.inputTokens, "observed input tokens");
  safeNonnegativeInteger(usage.outputTokens, "observed output tokens");
  safeNonnegativeInteger(usage.cacheReadTokens, "observed cache read tokens");
  safeNonnegativeInteger(usage.cacheWriteTokens, "observed cache write tokens");
  safeNonnegativeInteger(usage.reasoningTokens, "observed reasoning tokens");
  safeNonnegativeInteger(usage.totalTokens, "observed total tokens");
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("runtime observation timestamp must be ISO-compatible");
  }
  return timestamp;
}

function elapsedForgettingUnits(
  latestObservedAt: string | null,
  nextObservedAt: string,
): number {
  if (latestObservedAt === null) {
    return 1;
  }
  const elapsedDays = (
    parseTimestamp(nextObservedAt) - parseTimestamp(latestObservedAt)
  ) / (24 * 60 * 60 * 1_000);
  return clamp(elapsedDays, 1, 60);
}

function latestTimestamp(
  current: string | null,
  candidate: string,
): string {
  if (current === null || parseTimestamp(candidate) > parseTimestamp(current)) {
    return candidate;
  }
  return current;
}

function cloneState(state: RuntimeCostModelState): RuntimeCostModelState {
  return {
    ...state,
    durationWeights: [...state.durationWeights],
    durationCovariance: state.durationCovariance.map((row) => [...row]),
    failureWeights: [...state.failureWeights],
    statusCounts: { ...state.statusCounts },
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNumberArray(
  value: unknown,
  length: number,
  label: string,
): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} must contain ${length} numbers`);
  }
  return value.map((item, index) =>
    finite(item as number, `${label}[${index}]`));
}

function requireCovariance(value: unknown): number[][] {
  if (!Array.isArray(value) || value.length !== FEATURE_DIMENSIONS) {
    throw new TypeError(
      `duration covariance must contain ${FEATURE_DIMENSIONS} rows`,
    );
  }
  return value.map((row, index) =>
    requireNumberArray(row, FEATURE_DIMENSIONS, `duration covariance[${index}]`));
}

function requireStatusCounts(
  value: unknown,
): Record<RuntimeObservationStatus, number> {
  const raw = requireObject(value, "status counts");
  const result = emptyStatusCounts();
  for (const status of Object.keys(result) as RuntimeObservationStatus[]) {
    result[status] = safeNonnegativeInteger(
      raw[status] as number,
      `${status} status count`,
    );
  }
  return result;
}

function stateFromSnapshot(snapshot: unknown): RuntimeCostModelState {
  const raw = requireObject(snapshot, "runtime cost model snapshot");
  if (raw.schemaVersion !== "folioloom-runtime-cost-1") {
    throw new TypeError("unsupported runtime cost model snapshot schema");
  }
  if (typeof raw.profileKey !== "string" || raw.profileKey.trim().length === 0) {
    throw new TypeError("runtime cost model snapshot profile key must be non-empty");
  }
  if (raw.latestObservedAt !== null && typeof raw.latestObservedAt !== "string") {
    throw new TypeError("latest observed timestamp must be a string or null");
  }
  if (typeof raw.latestObservedAt === "string") {
    parseTimestamp(raw.latestObservedAt);
  }
  return {
    profileKey: raw.profileKey,
    durationWeights: requireNumberArray(
      raw.durationWeights,
      FEATURE_DIMENSIONS,
      "duration weights",
    ),
    durationCovariance: requireCovariance(raw.durationCovariance),
    residualAbsoluteEma: finiteNonnegative(
      raw.residualAbsoluteEma as number,
      "residual absolute EMA",
    ),
    inputTokenRatio: tokenRatio(
      raw.inputTokenRatio as number,
      "input token ratio",
    ),
    outputTokenRatio: tokenRatio(
      raw.outputTokenRatio as number,
      "output token ratio",
    ),
    totalTokenRatio: tokenRatio(
      raw.totalTokenRatio as number,
      "total token ratio",
    ),
    durationSamples: safeNonnegativeInteger(
      raw.durationSamples as number,
      "duration samples",
    ),
    tokenSamples: safeNonnegativeInteger(
      raw.tokenSamples as number,
      "token samples",
    ),
    failureSamples: safeNonnegativeInteger(
      raw.failureSamples as number,
      "failure samples",
    ),
    failureWeights: requireNumberArray(
      raw.failureWeights,
      FEATURE_DIMENSIONS,
      "failure weights",
    ),
    statusCounts: requireStatusCounts(raw.statusCounts),
    latestObservedAt: raw.latestObservedAt as string | null,
  };
}

export class OnlineRuntimeCostModel {
  readonly profileKey: string;
  readonly snapshotStatus: RuntimeCostModelSnapshotStatus;
  #state: RuntimeCostModelState;

  private constructor(
    state: RuntimeCostModelState,
    snapshotStatus: RuntimeCostModelSnapshotStatus,
  ) {
    this.#state = cloneState(state);
    this.profileKey = state.profileKey;
    this.snapshotStatus = snapshotStatus;
  }

  static coldStart(
    profileKey: string,
    snapshotStatus: "cold" | "invalid" = "cold",
  ): OnlineRuntimeCostModel {
    return new OnlineRuntimeCostModel(coldState(profileKey), snapshotStatus);
  }

  static fromSnapshot(snapshot: unknown): OnlineRuntimeCostModel {
    return new OnlineRuntimeCostModel(stateFromSnapshot(snapshot), "valid");
  }

  predict(rawFeatures: RuntimeFeatures): RuntimePrediction {
    const features = validateRuntimeFeatures(rawFeatures);
    const vector = runtimeFeatureVector(features);
    const predictedLogDuration = clamp(
      dot(this.#state.durationWeights, vector),
      Math.log1p(1),
      Math.log1p(MAX_DURATION_MS),
    );
    const p50DurationMs = Math.max(1, Math.round(Math.expm1(predictedLogDuration)));
    const p90LogDuration = clamp(
      predictedLogDuration
        + 1.7 * Math.max(0.15, this.#state.residualAbsoluteEma),
      predictedLogDuration,
      Math.log1p(MAX_DURATION_MS),
    );
    const p90DurationMs = Math.max(
      p50DurationMs,
      Math.round(Math.expm1(p90LogDuration)),
    );
    const inputTokens = Math.max(
      0,
      Math.round(features.inputTokens * this.#state.inputTokenRatio),
    );
    const outputTokens = Math.max(
      0,
      Math.round(features.outputTokens * this.#state.outputTokenRatio),
    );
    const baselineTokens = features.inputTokens + features.outputTokens;
    const totalTokens = Math.max(
      inputTokens + outputTokens,
      Math.round(baselineTokens * this.#state.totalTokenRatio),
    );
    const onlineFailureProbability = sigmoid(
      dot(this.#state.failureWeights, vector),
    );
    const onlineWeight = clamp(
      this.#state.failureSamples / FAILURE_PRIOR_SAMPLES,
      0,
      1,
    );
    const failureProbability = clamp(
      FAILURE_PRIOR * (1 - onlineWeight)
        + onlineFailureProbability * onlineWeight,
      MIN_FAILURE_PROBABILITY,
      MAX_FAILURE_PROBABILITY,
    );
    const confidenceSamples = Math.min(
      this.#state.durationSamples,
      this.#state.failureSamples,
    );
    const confidence = confidenceSamples / (confidenceSamples + 20);

    return {
      p50DurationMs,
      p90DurationMs,
      inputTokens,
      outputTokens,
      totalTokens,
      failureProbability,
      confidence,
    };
  }

  observe(observation: RuntimeCostObservation): void {
    const features = validateRuntimeFeatures(observation.features);
    finiteNonnegative(observation.durationMs, "observed duration");
    validateUsage(observation.usage);
    const observedTimestamp = new Date(parseTimestamp(
      observation.observedAt,
    )).toISOString();
    const elapsedUnits = elapsedForgettingUnits(
      this.#state.latestObservedAt,
      observedTimestamp,
    );
    const vector = runtimeFeatureVector(features);
    this.#state.statusCounts[observation.status] += 1;

    if (observation.status === "success") {
      this.#observeDuration(vector, observation.durationMs, elapsedUnits);
      if (observation.usage.complete) {
        this.#observeTokens(features, observation.usage, elapsedUnits);
      }
    }
    this.#observeFailure(vector, observation.status !== "success");
    this.#state.latestObservedAt = latestTimestamp(
      this.#state.latestObservedAt,
      observedTimestamp,
    );
  }

  snapshot(): RuntimeCostModelSnapshot {
    return {
      schemaVersion: "folioloom-runtime-cost-1",
      profileKey: this.#state.profileKey,
      durationWeights: [...this.#state.durationWeights],
      durationCovariance: this.#state.durationCovariance.map((row) => [...row]),
      residualAbsoluteEma: this.#state.residualAbsoluteEma,
      inputTokenRatio: this.#state.inputTokenRatio,
      outputTokenRatio: this.#state.outputTokenRatio,
      totalTokenRatio: this.#state.totalTokenRatio,
      durationSamples: this.#state.durationSamples,
      tokenSamples: this.#state.tokenSamples,
      failureSamples: this.#state.failureSamples,
      failureWeights: [...this.#state.failureWeights],
      statusCounts: { ...this.#state.statusCounts },
      latestObservedAt: this.#state.latestObservedAt,
    };
  }

  #observeDuration(
    vector: readonly number[],
    durationMs: number,
    elapsedUnits: number,
  ): void {
    const effectiveForgettingFactor = Math.max(
      0.4,
      FORGETTING_FACTOR ** elapsedUnits,
    );
    const covarianceTimesFeatures = multiplyMatrixVector(
      this.#state.durationCovariance,
      vector,
    );
    const gainDenominator = effectiveForgettingFactor
      + dot(vector, covarianceTimesFeatures);
    const gain = covarianceTimesFeatures.map(
      (value) => value / gainDenominator,
    );
    const rawResidual = Math.log1p(durationMs)
      - dot(this.#state.durationWeights, vector);
    const huberResidual = clamp(rawResidual, -1.5, 1.5);
    this.#state.durationWeights = this.#state.durationWeights.map(
      (weight, index) => weight + gain[index]! * huberResidual,
    );
    this.#state.durationCovariance = this.#state.durationCovariance.map(
      (row, rowIndex) => row.map((value, columnIndex) => (
        value - gain[rowIndex]! * covarianceTimesFeatures[columnIndex]!
      ) / effectiveForgettingFactor),
    );
    const residualAlpha = 1 - (0.8 ** elapsedUnits);
    this.#state.residualAbsoluteEma = (
      (1 - residualAlpha) * this.#state.residualAbsoluteEma
      + residualAlpha * Math.min(Math.abs(rawResidual), 3)
    );
    this.#state.durationSamples += 1;
  }

  #observeTokens(
    features: RuntimeFeatures,
    usage: NormalizedRuntimeUsage,
    elapsedUnits: number,
  ): void {
    const inputRatio = features.inputTokens === 0
      ? this.#state.inputTokenRatio
      : usage.inputTokens / features.inputTokens;
    const outputRatio = features.outputTokens === 0
      ? this.#state.outputTokenRatio
      : usage.outputTokens / features.outputTokens;
    const estimatedTotal = features.inputTokens + features.outputTokens;
    const totalRatio = estimatedTotal === 0
      ? this.#state.totalTokenRatio
      : usage.totalTokens / estimatedTotal;
    const alpha = clamp(1 - (0.8 ** elapsedUnits), 0.05, 0.8);
    this.#state.inputTokenRatio = clamp(
      (1 - alpha) * this.#state.inputTokenRatio + alpha * inputRatio,
      MIN_TOKEN_RATIO,
      MAX_TOKEN_RATIO,
    );
    this.#state.outputTokenRatio = clamp(
      (1 - alpha) * this.#state.outputTokenRatio + alpha * outputRatio,
      MIN_TOKEN_RATIO,
      MAX_TOKEN_RATIO,
    );
    this.#state.totalTokenRatio = clamp(
      (1 - alpha) * this.#state.totalTokenRatio + alpha * totalRatio,
      MIN_TOKEN_RATIO,
      MAX_TOKEN_RATIO,
    );
    this.#state.tokenSamples += 1;
  }

  #observeFailure(vector: readonly number[], failed: boolean): void {
    const prediction = sigmoid(dot(this.#state.failureWeights, vector));
    const target = failed ? 1 : 0;
    const learningRate = clamp(
      0.025 / Math.sqrt(this.#state.failureSamples + 1),
      0.002,
      0.025,
    );
    const l2 = 0.002;
    this.#state.failureWeights = this.#state.failureWeights.map(
      (weight, index) => clamp(
        weight * (1 - learningRate * l2)
          + learningRate * (target - prediction) * vector[index]!,
        -2,
        2,
      ),
    );
    this.#state.failureSamples += 1;
  }
}

export function loadRuntimeCostModel(
  store: RuntimeProfileStore,
  profileKey: string,
): OnlineRuntimeCostModel {
  try {
    const snapshot = store.modelSnapshot(profileKey);
    if (snapshot === undefined) {
      return OnlineRuntimeCostModel.coldStart(profileKey);
    }
    const restored = OnlineRuntimeCostModel.fromSnapshot(snapshot);
    if (restored.profileKey !== profileKey) {
      return OnlineRuntimeCostModel.coldStart(profileKey, "invalid");
    }
    return restored;
  } catch {
    return OnlineRuntimeCostModel.coldStart(profileKey, "invalid");
  }
}

export function persistRuntimeCostModel(
  store: RuntimeProfileStore,
  model: OnlineRuntimeCostModel,
): void {
  store.saveModelSnapshot(model.profileKey, model.snapshot());
}
