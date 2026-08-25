import { createHash } from "node:crypto";

import type { StableTerm, StableTermPolicy } from "../domain/types.js";
import type { LexicalConcept } from "./lexical-concept.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { buildConceptOccurrenceIndex } from "./concept-occurrence-index.js";

export type TermUsageDiscourseRole =
  | "narrative"
  | "vocative"
  | "title"
  | "other";

export interface TermUsageSubmission {
  readonly occurrenceId: string;
  readonly blockId: string;
  readonly conceptId: string;
  readonly sourceForm: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly discourseRole: TermUsageDiscourseRole;
  readonly targetSurface: string;
}

export interface ExpectedTermOccurrence {
  readonly occurrenceId: string;
  readonly blockId: string;
  readonly conceptId: string;
  readonly revisionId: string;
  readonly renderFingerprint: string;
  readonly sourceForm: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly canonicalTarget: string;
  readonly allowedRealizations: readonly string[];
  readonly policy: StableTermPolicy;
}

export type TermUsageFailureCode =
  | "TERM_USAGE_UNKNOWN"
  | "TERM_USAGE_DUPLICATE"
  | "TERM_USAGE_SOURCE_MISMATCH"
  | "TERM_USAGE_TARGET_NOT_ALLOWED"
  | "TERM_USAGE_TARGET_NOT_FOUND"
  | "TERM_USAGE_MISSING";

export interface TermUsageValidationFailure {
  readonly code: TermUsageFailureCode;
  readonly occurrenceId: string;
}

export interface TermOccurrenceBlock {
  readonly id: string;
  readonly sourceText: string;
}

export type TermConceptProjection = Pick<
  LexicalConcept,
  | "conceptId"
  | "revisionId"
  | "renderFingerprint"
  | "sourceForms"
  | "canonicalTarget"
  | "allowedRealizations"
  | "policy"
>;

export function conceptsFromStableTerms(
  terms: readonly StableTerm[],
): TermConceptProjection[] {
  const grouped = new Map<string, TermConceptProjection>();
  for (const term of terms) {
    if (term.semanticClass === undefined
      || term.revisionId === undefined
      || term.renderFingerprint === undefined
      || !/^[a-f0-9]{64}$/u.test(term.renderFingerprint)
      || term.policy === undefined
      || term.allowedTargets === undefined
      || term.allowedTargets.length === 0) {
      continue;
    }
    const previous = grouped.get(term.conceptId);
    if (previous !== undefined) {
      if (previous.revisionId !== term.revisionId
        || previous.renderFingerprint !== term.renderFingerprint
        || previous.canonicalTarget !== term.target
        || previous.policy !== term.policy) {
        throw new Error(`conflicting stable-term projections for ${term.conceptId}`);
      }
      grouped.set(term.conceptId, {
        ...previous,
        sourceForms: [...new Set([...previous.sourceForms, term.sourceForm])],
      });
      continue;
    }
    grouped.set(term.conceptId, {
      conceptId: term.conceptId,
      revisionId: term.revisionId,
      renderFingerprint: term.renderFingerprint,
      sourceForms: [term.sourceForm],
      canonicalTarget: term.target,
      allowedRealizations: [...term.allowedTargets],
      policy: term.policy,
    });
  }
  return [...grouped.values()];
}

function occurrenceId(
  blockId: string,
  conceptId: string,
  sourceStart: number,
  sourceEnd: number,
): string {
  return `term-occurrence-${createHash("sha256")
    .update(`${blockId}\0${conceptId}\0${sourceStart}\0${sourceEnd}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function expectedTermOccurrences(
  blocks: readonly TermOccurrenceBlock[],
  concepts: readonly TermConceptProjection[],
  profile: SourceLanguageProfile,
): ExpectedTermOccurrence[] {
  const conceptById = new Map(concepts.map((concept) => [
    concept.conceptId,
    concept,
  ]));
  const indexed = buildConceptOccurrenceIndex(
    blocks.map((block) => ({
      blockId: block.id,
      sourceText: block.sourceText,
    })),
    concepts,
    profile,
  );
  const results: ExpectedTermOccurrence[] = [];
  for (const occurrence of indexed) {
    const concept = conceptById.get(occurrence.conceptId);
    if (concept === undefined) {
      throw new Error(`indexed unknown term concept ${occurrence.conceptId}`);
    }
    for (const span of occurrence.sourceSpans) {
      results.push({
        occurrenceId: occurrenceId(
          occurrence.blockId,
          concept.conceptId,
          span.start,
          span.end,
        ),
        blockId: occurrence.blockId,
        conceptId: concept.conceptId,
        revisionId: concept.revisionId,
        renderFingerprint: concept.renderFingerprint,
        sourceForm: span.sourceForm,
        sourceStart: span.start,
        sourceEnd: span.end,
        canonicalTarget: concept.canonicalTarget,
        allowedRealizations: [...concept.allowedRealizations],
        policy: concept.policy,
      });
    }
  }
  return results.sort((left, right) => {
    const blockOrder = blocks.findIndex((block) => block.id === left.blockId)
      - blocks.findIndex((block) => block.id === right.blockId);
    return blockOrder
      || left.sourceStart - right.sourceStart
      || left.sourceEnd - right.sourceEnd
      || left.conceptId.localeCompare(right.conceptId);
  });
}

function targetText(
  values: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  blockId: string,
): string | undefined {
  if ("get" in values && typeof values.get === "function") {
    return values.get(blockId);
  }
  return (values as Readonly<Record<string, string>>)[blockId];
}

export function termSurfaceAllowed(
  expected: Pick<ExpectedTermOccurrence, "allowedRealizations" | "policy">,
  surface: string,
): boolean {
  if (expected.allowedRealizations.includes(surface)) return true;
  if (expected.policy !== "contextual"
    || !/^\p{Script=Han}+$/u.test(surface)
    || Array.from(surface).length > 12) {
    return false;
  }
  return expected.allowedRealizations.some((allowed) =>
    surface.includes(allowed)
    && Array.from(surface).length - Array.from(allowed).length <= 4);
}

export function termReceiptSurfaceAccepted(
  expected: Pick<ExpectedTermOccurrence, "allowedRealizations" | "policy">,
  surface: string,
): boolean {
  if (expected.policy === "locked") {
    return termSurfaceAllowed(expected, surface);
  }
  return Array.from(surface).length <= 12
    && /^[\p{L}\p{M}\p{N}\p{Pc}·・.'’\-]+$/u.test(surface);
}

export function validateTermUsages(
  expected: readonly ExpectedTermOccurrence[],
  submissions: readonly TermUsageSubmission[],
  targetByBlock: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): TermUsageValidationFailure[] {
  const expectedById = new Map(expected.map((item) => [
    item.occurrenceId,
    item,
  ]));
  const counts = new Map<string, number>();
  for (const submission of submissions) {
    counts.set(
      submission.occurrenceId,
      (counts.get(submission.occurrenceId) ?? 0) + 1,
    );
  }
  const failures: TermUsageValidationFailure[] = [];
  const failedIds = new Set<string>();
  const fail = (code: TermUsageFailureCode, id: string): void => {
    if (failedIds.has(id)) return;
    failedIds.add(id);
    failures.push({ code, occurrenceId: id });
  };
  for (const submission of submissions) {
    const known = expectedById.get(submission.occurrenceId);
    if ((counts.get(submission.occurrenceId) ?? 0) > 1) {
      fail("TERM_USAGE_DUPLICATE", submission.occurrenceId);
      continue;
    }
    if (known === undefined) {
      fail("TERM_USAGE_UNKNOWN", submission.occurrenceId);
      continue;
    }
    if (submission.blockId !== known.blockId
      || submission.conceptId !== known.conceptId
      || submission.sourceForm !== known.sourceForm
      || submission.sourceStart !== known.sourceStart
      || submission.sourceEnd !== known.sourceEnd) {
      fail("TERM_USAGE_SOURCE_MISMATCH", submission.occurrenceId);
      continue;
    }
    if (!termReceiptSurfaceAccepted(known, submission.targetSurface)) {
      fail("TERM_USAGE_TARGET_NOT_ALLOWED", submission.occurrenceId);
      continue;
    }
    const target = targetText(targetByBlock, submission.blockId);
    if (target === undefined || !target.includes(submission.targetSurface)) {
      fail("TERM_USAGE_TARGET_NOT_FOUND", submission.occurrenceId);
    }
  }
  if (failures.length > 0) {
    return failures;
  }
  const submittedIds = new Set(submissions.map((item) => item.occurrenceId));
  return expected
    .filter((item) =>
      item.policy === "locked"
      && !submittedIds.has(item.occurrenceId))
    .map((item) => ({
      code: "TERM_USAGE_MISSING" as const,
      occurrenceId: item.occurrenceId,
    }));
}

export function inferTermUsages(
  expected: readonly ExpectedTermOccurrence[],
  targetByBlock: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): TermUsageSubmission[] {
  return expected.flatMap((occurrence): TermUsageSubmission[] => {
    const target = targetText(targetByBlock, occurrence.blockId);
    if (target === undefined) return [];
    const surface = [...occurrence.allowedRealizations]
      .sort((left, right) => right.length - left.length)
      .find((candidate) => target.includes(candidate));
    if (surface === undefined) return [];
    return [{
      occurrenceId: occurrence.occurrenceId,
      blockId: occurrence.blockId,
      conceptId: occurrence.conceptId,
      sourceForm: occurrence.sourceForm,
      sourceStart: occurrence.sourceStart,
      sourceEnd: occurrence.sourceEnd,
      discourseRole: "other",
      targetSurface: surface,
    }];
  });
}

/**
 * Preserve every model-submitted receipt, then deterministically fill only
 * omitted receipts whose allowed target realization is already present in the
 * translated block.  Invalid, duplicate, or forged submissions are never
 * replaced, so the strict validator still reports them.
 */
export function completeTermUsagesFromTarget(
  expected: readonly ExpectedTermOccurrence[],
  submissions: readonly TermUsageSubmission[],
  targetByBlock: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): TermUsageSubmission[] {
  const submittedIds = new Set(submissions.map((submission) =>
    submission.occurrenceId));
  return [
    ...submissions.map((submission) => ({ ...submission })),
    ...inferTermUsages(
      expected.filter((occurrence) =>
        !submittedIds.has(occurrence.occurrenceId)),
      targetByBlock,
    ),
  ];
}
