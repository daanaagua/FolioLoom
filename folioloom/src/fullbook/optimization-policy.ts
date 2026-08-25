import type { TranslationRuntime } from "./types.js";

export type OptimizationProfile = "economy" | "balanced" | "speed";
export type SchedulerMode = "off" | "shadow" | "active";

export interface OptimizationPolicy {
  readonly profile: OptimizationProfile;
  readonly tokenIncreaseCap: number;
  readonly objectiveWeights: {
    readonly time: number;
    readonly tokens: number;
    readonly rework: number;
  };
  readonly horizon: number;
  readonly maxParetoLabels: number;
  readonly maxBatchCandidates: number;
  readonly planningDeadlineMs: number;
}

const POLICIES: Readonly<Record<OptimizationProfile, OptimizationPolicy>> = {
  economy: {
    profile: "economy",
    tokenIncreaseCap: 0.05,
    objectiveWeights: { time: 1, tokens: 1.5, rework: 1 },
    horizon: 12,
    maxParetoLabels: 8,
    maxBatchCandidates: 16,
    planningDeadlineMs: 50,
  },
  balanced: {
    profile: "balanced",
    tokenIncreaseCap: 0.10,
    objectiveWeights: { time: 1, tokens: 0.75, rework: 1 },
    horizon: 12,
    maxParetoLabels: 8,
    maxBatchCandidates: 24,
    planningDeadlineMs: 50,
  },
  speed: {
    profile: "speed",
    tokenIncreaseCap: 0.20,
    objectiveWeights: { time: 1, tokens: 0.25, rework: 1 },
    horizon: 16,
    maxParetoLabels: 8,
    maxBatchCandidates: 24,
    planningDeadlineMs: 250,
  },
};

const EFFORT_ORDER = new Map<string, number>([
  ["off", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["on", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
]);

export function optimizationPolicy(
  profile: OptimizationProfile,
): OptimizationPolicy {
  return structuredClone(POLICIES[profile]);
}

export function profileFromLegacyRunMode(
  mode: "quality" | "fast",
): OptimizationProfile {
  return mode === "quality" ? "balanced" : "speed";
}

function runtimeModelId(runtime: TranslationRuntime): string {
  const modelId = runtime.model?.id;
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    throw new TypeError("runtime variant model identity must be non-empty");
  }
  return modelId;
}

function runtimeEffortRank(runtime: TranslationRuntime): number {
  const label = runtime.effort ?? runtime.thinkingLevel ?? "";
  return EFFORT_ORDER.get(label) ?? Number.MAX_SAFE_INTEGER;
}

function runtimeVariantKey(runtime: TranslationRuntime): string {
  return JSON.stringify([
    runtimeModelId(runtime),
    runtime.effort ?? null,
    runtime.thinkingLevel ?? null,
  ]);
}

export function validateRuntimeVariants(
  variants: readonly TranslationRuntime[],
): readonly TranslationRuntime[] {
  if (variants.length === 0) {
    throw new TypeError("at least one runtime variant is required");
  }

  const modelId = runtimeModelId(variants[0]!);
  const unique = new Map<string, TranslationRuntime>();
  for (const runtime of variants) {
    if (runtimeModelId(runtime) !== modelId) {
      throw new TypeError("runtime variants must retain the same model identity");
    }
    const key = runtimeVariantKey(runtime);
    if (!unique.has(key)) {
      unique.set(key, runtime);
    }
  }

  return Object.freeze(
    [...unique.values()].sort((left, right) => {
      const rankDifference = runtimeEffortRank(left) - runtimeEffortRank(right);
      if (rankDifference !== 0) {
        return rankDifference;
      }
      return runtimeVariantKey(left).localeCompare(runtimeVariantKey(right), "en");
    }),
  );
}
