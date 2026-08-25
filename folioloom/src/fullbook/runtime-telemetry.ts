export interface NormalizedRuntimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly complete: boolean;
}

export interface RawRuntimeUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
}

export type RuntimeTaskType =
  | "translate"
  | "lexical_anchor"
  | "revalidate"
  | "validate";

export type RuntimeProtocol = "typed_tool" | "framed_text" | "local";

export type RuntimeObservationStatus =
  | "success"
  | "throttled"
  | "timeout"
  | "context"
  | "protocol"
  | "failed";

export interface RuntimeObservation {
  readonly observationId: string;
  readonly requestId: string;
  readonly modelId: string;
  readonly languageProfileId: string;
  readonly taskType: RuntimeTaskType;
  readonly protocol: RuntimeProtocol;
  readonly effort: string;
  readonly inputEstimate: number;
  readonly outputEstimate: number;
  readonly sourceTokens: number;
  readonly contextProfile: "lean" | "balanced" | "rich";
  readonly concurrency: number;
  readonly cacheHitRatio: number;
  readonly riskScore: number;
  readonly durationMs: number;
  readonly usage: NormalizedRuntimeUsage;
  readonly status: RuntimeObservationStatus;
  readonly observedAt: string;
}

function usageCount(value: number | undefined, label: string): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return normalized;
}

export function normalizeRuntimeUsage(
  raw: RawRuntimeUsage,
): NormalizedRuntimeUsage {
  const inputTokens = usageCount(raw.input, "input tokens");
  const outputTokens = usageCount(raw.output, "output tokens");
  const cacheReadTokens = usageCount(raw.cacheRead, "cache read tokens");
  const cacheWriteTokens = usageCount(raw.cacheWrite, "cache write tokens");
  const reasoningTokens = usageCount(raw.reasoning, "reasoning tokens");
  const derivedTotal = inputTokens
    + outputTokens
    + cacheReadTokens
    + cacheWriteTokens;
  const totalTokens = raw.totalTokens === undefined
    ? derivedTotal
    : usageCount(raw.totalTokens, "total tokens");

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    complete: raw.input !== undefined
      && raw.output !== undefined
      && raw.totalTokens !== undefined,
  };
}

function profilePart(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty printable string`);
  }
  return normalized;
}

export function runtimeObservationProfileKey(
  value: Pick<RuntimeObservation, "modelId" | "languageProfileId">,
): string {
  return [
    profilePart(value.modelId, "model id"),
    profilePart(value.languageProfileId, "language profile id"),
  ].join(":");
}
