import { createHash } from "node:crypto";

import type { TermUsageSubmission } from "../knowledge/term-usage.js";
import type { LosslessBlock } from "../source/types.js";
import { hasSemanticText } from "../text/semantic-text.js";
import type { TranslationMemoryCandidate } from "../tools/candidate-collector.js";

export const PARAGRAPH_FRAGMENT_PLAN_VERSION =
  "paragraph-fragment-plan-v1" as const;
export const PARAGRAPH_FRAGMENT_POLICY_VERSION =
  "paragraph-fragment-policy-v2" as const;
export const DEFAULT_MAX_TARGET_PARAGRAPHS_PER_FRAGMENT = 10;
export const DEFAULT_MAX_SOURCE_TOKENS_PER_FRAGMENT = 720;
export const PARAGRAPH_FRAGMENT_FIRST_THRESHOLD = 12;
const DEFAULT_TARGET_PARAGRAPHS_PER_FRAGMENT = 8;
const DEFAULT_TARGET_SOURCE_TOKENS_PER_FRAGMENT = 640;

export interface SourceParagraphSpan {
  readonly paragraphId: string;
  readonly ordinal: number;
  readonly scalarStart: number;
  readonly scalarEnd: number;
  readonly utf16Start: number;
  readonly utf16End: number;
  readonly sourceText: string;
}

export interface ParagraphFragmentUnit {
  readonly executionUnitId: string;
  readonly planId: string;
  readonly blockId: string;
  readonly paragraphStart: number;
  readonly paragraphEnd: number;
  readonly paragraphs: readonly SourceParagraphSpan[];
  readonly leftSourceContext: readonly SourceParagraphSpan[];
  readonly rightSourceContext: readonly SourceParagraphSpan[];
}

export interface ParagraphFragmentExecutionScope {
  readonly planId: string;
  readonly executionUnitId: string;
  readonly blockId: string;
  readonly sourceHash: string;
  readonly snapshotId: string;
  readonly paragraphs: readonly SourceParagraphSpan[];
  readonly leftSourceContext: readonly SourceParagraphSpan[];
  readonly rightSourceContext: readonly SourceParagraphSpan[];
}

export interface ParagraphFragmentPlan {
  readonly schemaVersion: typeof PARAGRAPH_FRAGMENT_PLAN_VERSION;
  readonly policyVersion: typeof PARAGRAPH_FRAGMENT_POLICY_VERSION;
  readonly planId: string;
  readonly windowId: string;
  readonly blockId: string;
  readonly sourceHash: string;
  readonly snapshotId: string;
  readonly paragraphs: readonly SourceParagraphSpan[];
  readonly units: readonly ParagraphFragmentUnit[];
}

export interface ParagraphFragmentCandidate {
  planId: string;
  executionUnitId: string;
  windowId: string;
  blockId: string;
  sourceHash: string;
  snapshotId: string;
  paragraphs: Array<{ paragraphId: string; text: string }>;
  termUsages: TermUsageSubmission[];
  notes: string[];
  memoryCandidates: TranslationMemoryCandidate[];
}

export interface ParagraphFragmentAssembly {
  readonly translation: { blockId: string; text: string };
  readonly termUsages: TermUsageSubmission[];
  readonly notes: string[];
  readonly memoryCandidates: TranslationMemoryCandidate[];
}

export interface PlanParagraphFragmentsInput {
  readonly windowId: string;
  readonly block: LosslessBlock;
  readonly snapshotId: string;
  readonly maxTargetParagraphs?: number;
  readonly maxSourceTokens?: number;
  readonly protectedSourceRanges?: readonly {
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
}

export function paragraphFragmentExecutionScope(
  plan: ParagraphFragmentPlan,
  unit: ParagraphFragmentUnit,
): ParagraphFragmentExecutionScope {
  if (unit.planId !== plan.planId || unit.blockId !== plan.blockId) {
    throw new Error("paragraph fragment unit does not belong to plan");
  }
  return {
    planId: plan.planId,
    executionUnitId: unit.executionUnitId,
    blockId: plan.blockId,
    sourceHash: plan.sourceHash,
    snapshotId: plan.snapshotId,
    paragraphs: unit.paragraphs,
    leftSourceContext: unit.leftSourceContext,
    rightSourceContext: unit.rightSourceContext,
  };
}

const PARAGRAPH_SEPARATOR =
  /(?:\r?\n)[\t ]*(?:\r?\n)+|\[\[\]\]/gu;

function requireNonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function stableHash(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function trimmedSourceSpan(
  sourceText: string,
  start: number,
  end: number,
): { start: number; end: number; text: string } | undefined {
  const raw = sourceText.slice(start, end);
  if (!hasSemanticText(raw)) return undefined;
  const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
  const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
  const trimmedStart = start + leading;
  const trimmedEnd = Math.max(trimmedStart, end - trailing);
  const text = sourceText.slice(trimmedStart, trimmedEnd);
  return hasSemanticText(text)
    ? { start: trimmedStart, end: trimmedEnd, text }
    : undefined;
}

export function sourceParagraphSpans(block: LosslessBlock): SourceParagraphSpan[] {
  const boundaries: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of block.sourceText.matchAll(PARAGRAPH_SEPARATOR)) {
    const separatorStart = match.index;
    if (separatorStart === undefined) continue;
    boundaries.push({ start, end: separatorStart });
    start = separatorStart + match[0].length;
  }
  boundaries.push({ start, end: block.sourceText.length });

  return boundaries.flatMap((boundary) => {
    const span = trimmedSourceSpan(
      block.sourceText,
      boundary.start,
      boundary.end,
    );
    if (span === undefined) return [];
    const ordinal = boundaries
      .slice(0, boundaries.indexOf(boundary))
      .filter((candidate) =>
        trimmedSourceSpan(
          block.sourceText,
          candidate.start,
          candidate.end,
        ) !== undefined)
      .length;
    return [{
      paragraphId: `${block.id}:paragraph:${String(ordinal).padStart(4, "0")}`,
      ordinal,
      scalarStart: Array.from(
        block.sourceText.slice(0, span.start),
      ).length,
      scalarEnd: Array.from(
        block.sourceText.slice(0, span.end),
      ).length,
      utf16Start: span.start,
      utf16End: span.end,
      sourceText: span.text,
    }];
  });
}

export function paragraphFragmentFirstRequired(block: LosslessBlock): boolean {
  return sourceParagraphSpans(block).length
    > PARAGRAPH_FRAGMENT_FIRST_THRESHOLD;
}

export function planParagraphFragments(
  input: PlanParagraphFragmentsInput,
): ParagraphFragmentPlan {
  requireNonempty(input.windowId, "windowId");
  requireNonempty(input.block.id, "blockId");
  requireNonempty(input.block.sourceHash, "sourceHash");
  requireNonempty(input.snapshotId, "snapshotId");
  const maxTargetParagraphs =
    input.maxTargetParagraphs
    ?? DEFAULT_MAX_TARGET_PARAGRAPHS_PER_FRAGMENT;
  if (!Number.isSafeInteger(maxTargetParagraphs) || maxTargetParagraphs <= 0) {
    throw new RangeError("maxTargetParagraphs must be a positive safe integer");
  }
  const maxSourceTokens =
    input.maxSourceTokens
    ?? DEFAULT_MAX_SOURCE_TOKENS_PER_FRAGMENT;
  if (!Number.isSafeInteger(maxSourceTokens) || maxSourceTokens <= 0) {
    throw new RangeError("maxSourceTokens must be a positive safe integer");
  }
  const paragraphs = sourceParagraphSpans(input.block);
  if (paragraphs.length < 2) {
    throw new RangeError(
      `paragraph fragmentation requires at least two source paragraphs: ${input.block.id}`,
    );
  }
  const protectedSourceRanges = (input.protectedSourceRanges ?? [])
    .map((range) => {
      if (!Number.isSafeInteger(range.sourceStart)
        || !Number.isSafeInteger(range.sourceEnd)
        || range.sourceStart < 0
        || range.sourceEnd <= range.sourceStart
        || range.sourceEnd > Array.from(input.block.sourceText).length) {
        throw new RangeError("protected source range must be inside the source block");
      }
      return { ...range };
    })
    .sort((left, right) =>
      left.sourceStart - right.sourceStart
      || left.sourceEnd - right.sourceEnd);
  const planHash = stableHash([
    PARAGRAPH_FRAGMENT_PLAN_VERSION,
    PARAGRAPH_FRAGMENT_POLICY_VERSION,
    input.windowId,
    input.block.id,
    input.block.sourceHash,
    input.snapshotId,
    String(maxTargetParagraphs),
    String(maxSourceTokens),
    ...protectedSourceRanges.flatMap((range) => [
      String(range.sourceStart),
      String(range.sourceEnd),
    ]),
    ...paragraphs.flatMap((paragraph) => [
      paragraph.paragraphId,
      String(paragraph.scalarStart),
      String(paragraph.scalarEnd),
      String(paragraph.utf16Start),
      String(paragraph.utf16End),
      paragraph.sourceText,
    ]),
  ]);
  const planId = `paragraph-plan-${planHash.slice(0, 24)}`;
  const blockScalarLength = Math.max(
    1,
    Array.from(input.block.sourceText).length,
  );
  const estimatedTokens = (
    start: number,
    end: number,
  ): number => {
    const sourceScalars = paragraphs.slice(start, end).reduce(
      (total, paragraph, index) =>
        total
        + paragraph.scalarEnd
        - paragraph.scalarStart
        + (index === 0 ? 0 : 2),
      0,
    );
    return Math.max(
      1,
      Math.ceil(
        input.block.tokenCount * sourceScalars / blockScalarLength,
      ),
    );
  };
  const legalCut = Array.from(
    { length: paragraphs.length + 1 },
    (_, index) => {
      if (index === 0 || index === paragraphs.length) return true;
      const left = paragraphs[index - 1];
      const right = paragraphs[index];
      return left !== undefined
        && right !== undefined
        && !protectedSourceRanges.some((range) =>
          range.sourceStart < right.scalarStart
          && range.sourceEnd > left.scalarEnd);
    },
  );
  const legalCutPrefix = legalCut.reduce<number[]>((prefix, allowed, index) => {
    prefix.push((prefix[index - 1] ?? 0) + (allowed ? 1 : 0));
    return prefix;
  }, []);
  const hasInternalLegalCut = (start: number, end: number): boolean =>
    (legalCutPrefix[end - 1] ?? 0) - (legalCutPrefix[start] ?? 0) > 0;
  const targetParagraphs = Math.min(
    maxTargetParagraphs,
    DEFAULT_TARGET_PARAGRAPHS_PER_FRAGMENT,
  );
  const targetSourceTokens = Math.min(
    maxSourceTokens,
    DEFAULT_TARGET_SOURCE_TOKENS_PER_FRAGMENT,
  );
  type PartitionState = {
    readonly groups: number;
    readonly imbalance: number;
    readonly previous: number;
  };
  const best: Array<PartitionState | undefined> =
    Array.from({ length: paragraphs.length + 1 });
  best[0] = { groups: 0, imbalance: 0, previous: -1 };
  for (let end = 1; end <= paragraphs.length; end += 1) {
    if (!legalCut[end]) continue;
    for (let start = 0; start < end; start += 1) {
      const prior = best[start];
      if (prior === undefined || !legalCut[start]) continue;
      const count = end - start;
      const tokens = estimatedTokens(start, end);
      const forcedAtomic = !hasInternalLegalCut(start, end);
      if (
        (count > maxTargetParagraphs
          || (tokens > maxSourceTokens && count > 1))
        && !forcedAtomic
      ) {
        continue;
      }
      const paragraphDeviation = count - targetParagraphs;
      const tokenDeviation = tokens / Math.max(1, targetSourceTokens) - 1;
      const candidate: PartitionState = {
        groups: prior.groups + 1,
        imbalance: prior.imbalance
          + paragraphDeviation * paragraphDeviation
          + tokenDeviation * tokenDeviation,
        previous: start,
      };
      const current = best[end];
      if (
        current === undefined
        || candidate.groups < current.groups
        || (
          candidate.groups === current.groups
          && (
            candidate.imbalance < current.imbalance - Number.EPSILON
            || (
              Math.abs(candidate.imbalance - current.imbalance)
                <= Number.EPSILON
              && candidate.previous > current.previous
            )
          )
        )
      ) {
        best[end] = candidate;
      }
    }
  }
  if (best[paragraphs.length] === undefined) {
    throw new Error("paragraph fragment policy could not produce an exact cover");
  }
  const boundaries: number[] = [paragraphs.length];
  for (let end = paragraphs.length; end > 0;) {
    const previous = best[end]?.previous;
    if (previous === undefined || previous < 0) {
      throw new Error("paragraph fragment partition lineage is incomplete");
    }
    boundaries.push(previous);
    end = previous;
  }
  boundaries.reverse();
  const units: ParagraphFragmentUnit[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const paragraphStart = boundaries[index]!;
    const paragraphEnd = boundaries[index + 1]!;
    const target = paragraphs.slice(paragraphStart, paragraphEnd);
    const executionUnitId = `paragraph-unit-${stableHash([
      planId,
      String(paragraphStart),
      String(paragraphEnd),
      ...target.map((paragraph) => paragraph.paragraphId),
    ]).slice(0, 24)}`;
    units.push({
      executionUnitId,
      planId,
      blockId: input.block.id,
      paragraphStart,
      paragraphEnd,
      paragraphs: target,
      leftSourceContext: paragraphs.slice(
        Math.max(0, paragraphStart - 1),
        paragraphStart,
      ),
      rightSourceContext: paragraphs.slice(
        paragraphEnd,
        Math.min(paragraphs.length, paragraphEnd + 1),
      ),
    });
  }
  return {
    schemaVersion: PARAGRAPH_FRAGMENT_PLAN_VERSION,
    policyVersion: PARAGRAPH_FRAGMENT_POLICY_VERSION,
    planId,
    windowId: input.windowId,
    blockId: input.block.id,
    sourceHash: input.block.sourceHash,
    snapshotId: input.snapshotId,
    paragraphs,
    units,
  };
}

function uniqueByCanonicalJson<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function assembleParagraphFragmentCandidates(
  plan: ParagraphFragmentPlan,
  candidates: readonly ParagraphFragmentCandidate[],
): ParagraphFragmentAssembly {
  const candidateByUnit = new Map<string, ParagraphFragmentCandidate>();
  for (const candidate of candidates) {
    if (candidateByUnit.has(candidate.executionUnitId)) {
      throw new Error(
        `duplicate execution unit candidate: ${candidate.executionUnitId}`,
      );
    }
    candidateByUnit.set(candidate.executionUnitId, candidate);
  }
  const expectedUnitIds = new Set(plan.units.map((unit) => unit.executionUnitId));
  if (candidateByUnit.size !== expectedUnitIds.size
    || [...candidateByUnit.keys()].some((unitId) => !expectedUnitIds.has(unitId))) {
    throw new Error("paragraph fragment execution unit exact cover failed");
  }

  const translatedParagraphs: Array<{ paragraphId: string; text: string }> = [];
  const termUsages: TermUsageSubmission[] = [];
  const notes: string[] = [];
  const memoryCandidates: TranslationMemoryCandidate[] = [];
  for (const unit of plan.units) {
    const candidate = candidateByUnit.get(unit.executionUnitId);
    if (candidate === undefined) {
      throw new Error("paragraph fragment execution unit exact cover failed");
    }
    if (candidate.planId !== plan.planId
      || candidate.windowId !== plan.windowId
      || candidate.blockId !== plan.blockId
      || candidate.sourceHash !== plan.sourceHash
      || candidate.snapshotId !== plan.snapshotId) {
      throw new Error(
        `fragment candidate lineage mismatch: ${candidate.executionUnitId}`,
      );
    }
    const expectedParagraphIds = unit.paragraphs.map((paragraph) =>
      paragraph.paragraphId);
    const actualParagraphIds = candidate.paragraphs.map((paragraph) =>
      paragraph.paragraphId);
    const expectedSet = new Set(expectedParagraphIds);
    const actualSet = new Set(actualParagraphIds);
    if (actualSet.size !== actualParagraphIds.length
      || actualSet.size !== expectedSet.size
      || [...actualSet].some((paragraphId) => !expectedSet.has(paragraphId))) {
      throw new Error(
        `paragraph exact cover failed: ${candidate.executionUnitId}`,
      );
    }
    if (actualParagraphIds.some((paragraphId, index) =>
      paragraphId !== expectedParagraphIds[index])) {
      throw new Error(
        `paragraph order mismatch: ${candidate.executionUnitId}`,
      );
    }
    for (const paragraph of candidate.paragraphs) {
      if (!hasSemanticText(paragraph.text)) {
        throw new Error(`empty target paragraph: ${paragraph.paragraphId}`);
      }
      translatedParagraphs.push({ ...paragraph });
    }
    termUsages.push(...candidate.termUsages.map((usage) => ({ ...usage })));
    notes.push(...candidate.notes);
    memoryCandidates.push(...candidate.memoryCandidates);
  }

  const expectedParagraphIds = plan.paragraphs.map((paragraph) =>
    paragraph.paragraphId);
  if (translatedParagraphs.length !== expectedParagraphIds.length
    || translatedParagraphs.some((paragraph, index) =>
      paragraph.paragraphId !== expectedParagraphIds[index])) {
    throw new Error("paragraph exact cover failed after assembly");
  }
  return {
    translation: {
      blockId: plan.blockId,
      text: translatedParagraphs.map((paragraph) => paragraph.text).join("\n\n"),
    },
    termUsages,
    notes,
    memoryCandidates: uniqueByCanonicalJson(memoryCandidates),
  };
}
