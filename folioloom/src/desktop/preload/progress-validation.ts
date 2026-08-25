import type {
  DesktopFullBookPhase,
  DesktopFullBookProgress,
  DesktopFullBookWindowProgress,
} from "../contracts.js";

const PHASES = new Set<DesktopFullBookPhase>([
  "idle",
  "preparing",
  "running",
  "pausing",
  "paused",
  "completed",
  "needs_attention",
  "failed",
]);

const PROGRESS_FIELDS = [
  "totalWindows",
  "pendingWindows",
  "runningWindows",
  "stagedWindows",
  "completedWindows",
  "warningWindows",
  "humanRequiredWindows",
  "failedWindows",
] as const satisfies readonly (keyof DesktopFullBookWindowProgress)[];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseDesktopFullBookProgress(
  value: unknown,
): DesktopFullBookProgress | undefined {
  const input = record(value);
  if (input === undefined
    || Object.keys(input).length !== 3
    || typeof input.runId !== "string"
    || input.runId.trim().length === 0
    || typeof input.phase !== "string"
    || !PHASES.has(input.phase as DesktopFullBookPhase)) {
    return undefined;
  }
  const rawProgress = record(input.progress);
  if (rawProgress === undefined
    || Object.keys(rawProgress).length !== PROGRESS_FIELDS.length
    || PROGRESS_FIELDS.some((field) => !nonnegativeSafeInteger(rawProgress[field]))) {
    return undefined;
  }
  const progress = Object.fromEntries(
    PROGRESS_FIELDS.map((field) => [field, rawProgress[field] as number]),
  ) as unknown as DesktopFullBookWindowProgress;
  return {
    runId: input.runId,
    phase: input.phase as DesktopFullBookPhase,
    progress,
  };
}
