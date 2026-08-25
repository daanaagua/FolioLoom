import type { SourceLanguageProfile } from "../language/types.js";
import type { LexicalConcept } from "./lexical-concept.js";

export interface ConceptOccurrenceSpan {
  readonly start: number;
  readonly end: number;
  readonly sourceForm: string;
}

export interface ConceptOccurrence {
  readonly conceptId: string;
  readonly blockId: string;
  readonly sourceSpans: readonly ConceptOccurrenceSpan[];
}

export interface ConceptOccurrenceSourceBlock {
  readonly blockId: string;
  readonly sourceText: string;
}

interface FormEntry {
  readonly normalizedScalars: readonly string[];
  readonly conceptIds: readonly string[];
}

interface MatcherNode {
  readonly next: Map<string, number>;
  fail: number;
  readonly outputs: number[];
}

function identifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function formEntries(
  concepts: readonly Pick<LexicalConcept, "conceptId" | "sourceForms">[],
  profile: SourceLanguageProfile,
): FormEntry[] {
  const conceptsByForm = new Map<string, Set<string>>();
  for (const concept of concepts) {
    for (const raw of concept.sourceForms) {
      const form = profile.normalizeSourceLiteral(raw.trim());
      if (Array.from(form).length < 2) continue;
      const ids = conceptsByForm.get(form) ?? new Set<string>();
      ids.add(concept.conceptId);
      conceptsByForm.set(form, ids);
    }
  }
  return [...conceptsByForm.entries()]
    .sort(([left], [right]) => left.localeCompare(right, profile.locale))
    .map(([form, conceptIds]) => ({
      normalizedScalars: Array.from(form),
      conceptIds: [...conceptIds].sort(),
    }));
}

function buildMatcher(entries: readonly FormEntry[]): MatcherNode[] {
  const nodes: MatcherNode[] = [{
    next: new Map(),
    fail: 0,
    outputs: [],
  }];
  for (let output = 0; output < entries.length; output += 1) {
    let state = 0;
    for (const character of entries[output]!.normalizedScalars) {
      let next = nodes[state]!.next.get(character);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.next.set(character, next);
        nodes.push({ next: new Map(), fail: 0, outputs: [] });
      }
      state = next;
    }
    nodes[state]!.outputs.push(output);
  }
  const queue = [...nodes[0]!.next.values()];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!;
    for (const [character, child] of nodes[state]!.next) {
      queue.push(child);
      let fallback = nodes[state]!.fail;
      while (fallback !== 0 && !nodes[fallback]!.next.has(character)) {
        fallback = nodes[fallback]!.fail;
      }
      nodes[child]!.fail = nodes[fallback]!.next.get(character) ?? 0;
      nodes[child]!.outputs.push(...nodes[nodes[child]!.fail]!.outputs);
    }
  }
  return nodes;
}

interface OriginalScalarSpan {
  readonly start: number;
  readonly end: number;
}

function normalizedToOriginalScalarMap(
  sourceText: string,
  normalizedSource: string,
  profile: SourceLanguageProfile,
): OriginalScalarSpan[] {
  const original = Array.from(sourceText);
  const baseline: string[] = [];
  const originalSpans: OriginalScalarSpan[] = [];
  for (let index = 0; index < original.length; index += 1) {
    const normalized = profile.normalizeSourceLiteral(original[index]!);
    for (const scalar of normalized) {
      baseline.push(scalar);
      originalSpans.push({ start: index, end: index + 1 });
    }
  }
  const normalized = Array.from(normalizedSource);
  if (normalized.length === 0) return [];
  if (baseline.length === normalized.length
    && baseline.every((scalar, index) => scalar === normalized[index])) {
    return originalSpans;
  }
  const graphemeNormalized: string[] = [];
  const graphemeSpans: OriginalScalarSpan[] = [];
  let scalarOffset = 0;
  const segmenter = new Intl.Segmenter(profile.locale, { granularity: "grapheme" });
  for (const part of segmenter.segment(sourceText)) {
    const start = scalarOffset;
    const end = start + Array.from(part.segment).length;
    scalarOffset = end;
    for (const scalar of profile.normalizeSourceLiteral(part.segment)) {
      graphemeNormalized.push(scalar);
      graphemeSpans.push({ start, end });
    }
  }
  if (graphemeNormalized.length === normalized.length
    && graphemeNormalized.every((scalar, index) => scalar === normalized[index])) {
    return graphemeSpans;
  }
  throw new Error("source literal normalization cannot preserve scalar coordinates");
}

/**
 * Compile every source form once and scan each source block once. Source spans
 * use Unicode-scalar offsets into the immutable lossless block.
 */
export function buildConceptOccurrenceIndex(
  blocks: readonly ConceptOccurrenceSourceBlock[],
  concepts: readonly Pick<LexicalConcept, "conceptId" | "sourceForms">[],
  profile: SourceLanguageProfile,
): ConceptOccurrence[] {
  const entries = formEntries(concepts, profile);
  if (entries.length === 0 || blocks.length === 0) return [];
  const nodes = buildMatcher(entries);
  const cjk = profile.scripts.some((script) =>
    script === "kana" || script === "hangul" || script === "han");
  const grouped = new Map<string, {
    conceptId: string;
    blockId: string;
    spans: Map<string, ConceptOccurrenceSpan>;
  }>();
  for (const block of blocks) {
    const normalizedSource = profile.normalizeSourceLiteral(block.sourceText);
    const normalizedScalars = Array.from(normalizedSource);
    const originalScalars = Array.from(block.sourceText);
    const normalizedToOriginal = normalizedToOriginalScalarMap(
      block.sourceText,
      normalizedSource,
      profile,
    );
    const sourceWordSpans = new Set(profile.segment(block.sourceText)
      .filter((token) => token.isWordLike)
      .map((token) => `${token.start}\0${token.end}`));
    const originalUtf16Spans: OriginalScalarSpan[] = [];
    let utf16Offset = 0;
    for (const scalar of originalScalars) {
      originalUtf16Spans.push({
        start: utf16Offset,
        end: utf16Offset + scalar.length,
      });
      utf16Offset += scalar.length;
    }
    let state = 0;
    for (let offset = 0; offset < normalizedScalars.length; offset += 1) {
      const character = normalizedScalars[offset]!;
      while (state !== 0 && !nodes[state]!.next.has(character)) {
        state = nodes[state]!.fail;
      }
      state = nodes[state]!.next.get(character) ?? 0;
      const end = offset + 1;
      for (const output of nodes[state]!.outputs) {
        const entry = entries[output]!;
        const start = end - entry.normalizedScalars.length;
        const originalFirst = normalizedToOriginal[start];
        const originalLast = normalizedToOriginal[end - 1];
        if (originalFirst === undefined || originalLast === undefined) continue;
        const originalStart = originalFirst.start;
        const originalEnd = originalLast.end;
        const utf16First = originalUtf16Spans[originalStart];
        const utf16Last = originalUtf16Spans[originalEnd - 1];
        const isExactWordToken = utf16First !== undefined
          && utf16Last !== undefined
          && sourceWordSpans.has(`${utf16First.start}\0${utf16Last.end}`);
        const hasBoundary = cjk
          || isExactWordToken
          || (!identifierCharacter(normalizedScalars[start - 1])
            && !identifierCharacter(normalizedScalars[end]));
        if (!hasBoundary) continue;
        const sourceForm = originalScalars.slice(originalStart, originalEnd).join("");
        for (const conceptId of entry.conceptIds) {
          const key = `${conceptId}\0${block.blockId}`;
          const item = grouped.get(key) ?? {
            conceptId,
            blockId: block.blockId,
            spans: new Map(),
          };
          item.spans.set(`${originalStart}\0${originalEnd}`, {
            start: originalStart,
            end: originalEnd,
            sourceForm,
          });
          grouped.set(key, item);
        }
      }
    }
  }
  const blockOrder = new Map(blocks.map((block, index) => [block.blockId, index]));
  return [...grouped.values()]
    .sort((left, right) =>
      (blockOrder.get(left.blockId) ?? 0) - (blockOrder.get(right.blockId) ?? 0)
      || left.conceptId.localeCompare(right.conceptId))
    .map((item) => ({
      conceptId: item.conceptId,
      blockId: item.blockId,
      sourceSpans: [...item.spans.values()].sort((left, right) =>
        left.start - right.start || left.end - right.end),
    }));
}
