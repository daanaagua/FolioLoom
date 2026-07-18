import {
  DISCOURSE_MODES,
  type BookStyleConstitution,
  type DiscourseMode,
  type DiscourseModeWeights,
  type EffectiveLocalStyle,
  type EffectiveStyle,
  type LocalStyleObservation,
  type VoiceProfile,
  type WeightedAddressChoice,
  type WeightedLexicalChoice,
  type WeightedStyleValue,
} from "./types.js";

const DEFAULT_CONSTITUTION: Omit<BookStyleConstitution, "schemaVersion" | "version"> = {
  register: "文学、准确、克制，避免网络流行语和无依据的口语化",
  sentencePolicy: "保留原文句法关系；只在中文可读性确有需要时自然拆句",
  explicitation: "不擅自解释、补因果或消除原文有意保留的歧义",
  imagery: "保留意象、比喻及其陌生联系，不替换成陈词滥调",
  dialogue: "对白符合人物关系和场景，不机械追求字面对齐",
  technicalProse: "科学和技术说明优先准确、清楚、术语一致",
  typography: "使用规范中文标点、引号和段落格式",
};

function bounded(value: string | undefined, fallback: string, max = 180): string {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  return (normalized.length === 0 ? fallback : normalized).slice(0, max);
}

export function createBookStyleConstitution(
  overrides: Partial<Omit<BookStyleConstitution, "schemaVersion" | "version">> = {},
  version = 1,
): BookStyleConstitution {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("book style constitution version must be a positive safe integer");
  }
  return Object.freeze({
    schemaVersion: "v5-book-style-1" as const,
    version,
    register: bounded(overrides.register, DEFAULT_CONSTITUTION.register),
    sentencePolicy: bounded(overrides.sentencePolicy, DEFAULT_CONSTITUTION.sentencePolicy),
    explicitation: bounded(overrides.explicitation, DEFAULT_CONSTITUTION.explicitation),
    imagery: bounded(overrides.imagery, DEFAULT_CONSTITUTION.imagery),
    dialogue: bounded(overrides.dialogue, DEFAULT_CONSTITUTION.dialogue),
    technicalProse: bounded(overrides.technicalProse, DEFAULT_CONSTITUTION.technicalProse),
    typography: bounded(overrides.typography, DEFAULT_CONSTITUTION.typography),
  });
}

function normalizeWeights(values: Record<DiscourseMode, number>): DiscourseModeWeights {
  const total = DISCOURSE_MODES.reduce((sum, mode) => sum + Math.max(0, values[mode]), 0);
  const denominator = total === 0 ? 1 : total;
  return Object.freeze(Object.fromEntries(DISCOURSE_MODES.map((mode) => [
    mode,
    Math.max(0, values[mode]) / denominator,
  ])) as unknown as DiscourseModeWeights);
}

function occurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

export function extractDiscourseModeWeights(text: string): DiscourseModeWeights {
  const source = text.trim();
  const length = Math.max(1, [...source].length);
  const paragraphs = source.split(/\n\s*\n/gu).filter((value) => value.trim().length > 0);
  const sentences = source.split(/[.!?。！？]+/gu).filter((value) => value.trim().length > 0);
  const quoteMarks = occurrences(source, /[“”"«»„]/gu);
  const numerals = occurrences(source, /\p{N}/gu);
  const formulaMarks = occurrences(source, /[=+×÷<>±%]/gu);
  const parentheses = occurrences(source, /[()[\]{}]/gu);
  const listLines = source.split(/\r?\n/gu)
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/u.test(line)).length;
  const exclamations = occurrences(source, /[!！]/gu);
  const questions = occurrences(source, /[?？]/gu);
  const semicolons = occurrences(source, /[;；:：]/gu);
  const shortLineRatio = source.length === 0 ? 0 : source.split(/\r?\n/gu)
    .filter((line) => line.trim().length > 0 && [...line.trim()].length <= 36).length
      / Math.max(1, source.split(/\r?\n/gu).filter((line) => line.trim().length > 0).length);
  const averageSentence = length / Math.max(1, sentences.length);
  const values: Record<DiscourseMode, number> = {
    narrative: 0.7,
    dialogue: 0.1 + Math.min(1.6, quoteMarks * 0.45 + questions * 0.12),
    action: 0.12 + Math.min(0.9, exclamations * 0.25 + (averageSentence < 45 ? 0.2 : 0)),
    description: 0.2 + Math.min(0.8, averageSentence / 180 + semicolons * 0.08),
    technical: 0.05 + Math.min(1.8, numerals / length * 18 + formulaMarks * 0.3
      + parentheses * 0.1),
    documentary: 0.05 + Math.min(1.2, listLines * 0.35 + (paragraphs.length > 4 ? 0.15 : 0)),
    lyrical: 0.05 + Math.min(0.6, shortLineRatio * 0.25 + semicolons * 0.05),
    interior: 0.05 + Math.min(0.5, questions * 0.08),
  };
  return normalizeWeights(values);
}

function rankedModes(weights: DiscourseModeWeights): DiscourseMode[] {
  return [...DISCOURSE_MODES].sort((left, right) =>
    weights[right] - weights[left] || left.localeCompare(right));
}

function compatibleModes(
  left: DiscourseModeWeights,
  right: DiscourseModeWeights,
): boolean {
  const leftTop = rankedModes(left).slice(0, 2);
  const rightTop = new Set(rankedModes(right).slice(0, 2));
  return leftTop.some((mode) => rightTop.has(mode));
}

function weightedValues(
  observations: readonly { value: string; weight: number; ordinal: number }[],
  limit: number,
): WeightedStyleValue[] {
  const byValue = new Map<string, { weight: number; ordinal: number }>();
  for (const item of observations) {
    const prior = byValue.get(item.value);
    if (prior === undefined || item.weight > prior.weight
      || (item.weight === prior.weight && item.ordinal > prior.ordinal)) {
      byValue.set(item.value, { weight: item.weight, ordinal: item.ordinal });
    }
  }
  return [...byValue.entries()].map(([value, item]) => ({ value, ...item }))
    .sort((left, right) => right.weight - left.weight
      || right.ordinal - left.ordinal || left.value.localeCompare(right.value))
    .slice(0, limit)
    .map(({ value, weight }) => ({ value, weight }));
}

function localProjection(
  observations: readonly LocalStyleObservation[],
  currentOrdinal: number,
  ttl: number,
  decay: number,
): EffectiveLocalStyle {
  const visible = observations.filter((item) => item.accepted)
    .map((item) => ({ item, distance: currentOrdinal - item.ordinal }))
    .filter(({ distance }) => distance > 0 && distance < ttl)
    .map(({ item, distance }) => ({ item, weight: decay ** distance }));
  const strings = (selector: (item: LocalStyleObservation) => string | null) =>
    weightedValues(visible.flatMap(({ item, weight }) => {
      const value = selector(item);
      return value === null ? [] : [{ value, weight, ordinal: item.ordinal }];
    }), 3);
  const notes = weightedValues(visible.flatMap(({ item, weight }) =>
    item.continuityNotes.map((value) => ({ value, weight, ordinal: item.ordinal }))), 4);
  const addressChoices: WeightedAddressChoice[] = visible.flatMap(({ item, weight }) =>
    item.addressChoices.map((value) => ({ ...value, weight, ordinal: item.ordinal })))
    .sort((left, right) => right.weight - left.weight || right.ordinal - left.ordinal
      || left.subject.localeCompare(right.subject))
    .slice(0, 6)
    .map(({ subject, target, weight }) => ({ subject, target, weight }));
  const lexicalChoices: WeightedLexicalChoice[] = visible.flatMap(({ item, weight }) =>
    item.lexicalChoices.map((value) => ({ ...value, weight, ordinal: item.ordinal })))
    .sort((left, right) => right.weight - left.weight || right.ordinal - left.ordinal
      || left.source.localeCompare(right.source))
    .slice(0, 6)
    .map(({ source, target, weight }) => ({ source, target, weight }));
  return {
    registers: strings((item) => item.activeRegister),
    rhythms: strings((item) => item.rhythm),
    addressChoices,
    lexicalChoices,
    continuityNotes: notes,
  };
}

export interface ComposeEffectiveStyleInput {
  constitution: BookStyleConstitution;
  voices: readonly VoiceProfile[];
  observations: readonly LocalStyleObservation[];
  currentOrdinal: number;
  sourceText: string;
  defaultVoiceId: string;
  localTtl?: number;
  localDecay?: number;
}

export function composeEffectiveStyle(input: ComposeEffectiveStyleInput): EffectiveStyle {
  const voice = input.voices.find((item) => item.voiceId === input.defaultVoiceId)
    ?? input.voices[0];
  if (voice === undefined) {
    throw new TypeError("effective style requires at least one voice profile");
  }
  const modeWeights = extractDiscourseModeWeights(input.sourceText);
  const topModes = rankedModes(modeWeights).slice(0, 2);
  const local = localProjection(
    input.observations,
    input.currentOrdinal,
    input.localTtl ?? 6,
    input.localDecay ?? 0.65,
  );
  const examples = input.observations.filter((item) => item.accepted
      && item.ordinal < input.currentOrdinal
      && item.voiceId === voice.voiceId
      && input.currentOrdinal - item.ordinal < (input.localTtl ?? 6)
      && compatibleModes(modeWeights, item.modeWeights))
    .sort((left, right) => right.ordinal - left.ordinal || left.windowId.localeCompare(right.windowId))
    .flatMap((item) => item.examples)
    .slice(0, 2);
  return {
    constitution: structuredClone(input.constitution),
    voice: structuredClone(voice),
    modeWeights,
    topModes,
    local,
    examples,
  };
}
