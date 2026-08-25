import {
  DISCOURSE_MODES,
  type DiscourseMode,
  type DiscourseModeWeights,
  type LocalStyleObservation,
  type StyleObservationSubmission,
} from "./types.js";
import { extractDiscourseModeWeights } from "./effective-style.js";

function clean(value: string | undefined, max: number): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  return normalized.length === 0 ? null : normalized.slice(0, max);
}

function cleanList(values: readonly string[] | undefined, limit: number, max: number): string[] {
  return [...new Set((values ?? []).map((value) => clean(value, max))
    .filter((value): value is string => value !== null))].slice(0, limit);
}

function normalizeMixedWeights(
  source: DiscourseModeWeights,
  submitted: Partial<Record<DiscourseMode, number>> | undefined,
): DiscourseModeWeights {
  const values = Object.fromEntries(DISCOURSE_MODES.map((mode) => {
    const proposed = submitted?.[mode];
    const bounded = typeof proposed === "number" && Number.isFinite(proposed)
      ? Math.max(0, Math.min(1, proposed))
      : source[mode];
    return [mode, source[mode] * 0.8 + bounded * 0.2];
  })) as Record<DiscourseMode, number>;
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  return Object.freeze(Object.fromEntries(DISCOURSE_MODES.map((mode) => [
    mode,
    values[mode] / total,
  ])) as unknown as DiscourseModeWeights);
}

export interface CreateStyleObservationInput {
  windowId: string;
  ordinal: number;
  sourceText: string;
  translations: readonly string[];
  submission?: StyleObservationSubmission;
  accepted?: boolean;
}

export function createStyleObservation(
  input: CreateStyleObservationInput,
): LocalStyleObservation {
  if (input.windowId.trim().length === 0 || !Number.isSafeInteger(input.ordinal)
    || input.ordinal < 0) {
    throw new TypeError("style observation requires a valid window and ordinal");
  }
  const sourceWeights = extractDiscourseModeWeights(input.sourceText);
  const submission = input.submission ?? {};
  const addressChoices = (submission.addressChoices ?? []).flatMap((value) => {
    const subject = clean(value.subject, 80);
    const target = clean(value.target, 80);
    return subject === null || target === null ? [] : [{ subject, target }];
  }).slice(0, 6);
  const lexicalChoices = (submission.lexicalChoices ?? []).flatMap((value) => {
    const source = clean(value.source, 80);
    const target = clean(value.target, 80);
    return source === null || target === null ? [] : [{ source, target }];
  }).slice(0, 6);
  return {
    schemaVersion: "v5-style-observation-1",
    windowId: input.windowId,
    ordinal: input.ordinal,
    accepted: input.accepted ?? true,
    voiceId: clean(submission.voiceId, 80) ?? "narrator",
    modeWeights: normalizeMixedWeights(sourceWeights, submission.modeWeights),
    activeRegister: clean(submission.activeRegister, 120),
    rhythm: clean(submission.rhythm, 120),
    addressChoices,
    lexicalChoices,
    continuityNotes: cleanList(submission.continuityNotes, 4, 140),
    examples: cleanList(input.translations, 2, 220),
  };
}

export function parseStyleObservation(value: unknown): LocalStyleObservation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<LocalStyleObservation>;
  if (candidate.schemaVersion !== "v5-style-observation-1"
    || typeof candidate.windowId !== "string"
    || !Number.isSafeInteger(candidate.ordinal)
    || typeof candidate.accepted !== "boolean"
    || typeof candidate.voiceId !== "string"
    || candidate.modeWeights === undefined
    || !Array.isArray(candidate.addressChoices)
    || !Array.isArray(candidate.lexicalChoices)
    || !Array.isArray(candidate.continuityNotes)
    || !Array.isArray(candidate.examples)) {
    return undefined;
  }
  return structuredClone(candidate as LocalStyleObservation);
}
