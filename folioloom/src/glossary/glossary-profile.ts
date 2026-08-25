import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { StableTerm, StableTermPolicy } from "../domain/types.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import type { SourceLanguageProfile, SourceToken } from "../language/types.js";
import type { LosslessBlock } from "../source/types.js";

const GLOSSARY_SCHEMA = "folioloom-glossary-1";
const REPORT_SCHEMA = "folioloom-glossary-report-1" as const;
const MAX_TERMS = 10_000;
const MAX_FORMS_PER_TERM = 16;
const MAX_TERM_SCALARS = 240;
const MAX_KIND_SCALARS = 80;
const MAX_NOTE_SCALARS = 600;

const TERM_POLICIES = new Set<StableTermPolicy>([
  "locked",
  "preferred",
  "contextual",
]);
const ROOT_KEYS = new Set(["schema", "terms"]);
const TERM_KEYS = new Set(["source", "target", "kind", "policy", "forms", "note"]);

export type GlossaryPolicy = StableTermPolicy;

export interface GlossaryTermReport {
  readonly source: string;
  readonly target: string;
  readonly policy: GlossaryPolicy;
  readonly forms: readonly string[];
  readonly kind?: string;
  readonly note?: string;
  readonly occurrenceCount: number;
  readonly globalIndexes: readonly number[];
  readonly unmatchedForms: readonly string[];
}

export interface GlossaryImportReport {
  readonly schema: typeof REPORT_SCHEMA;
  readonly glossaryHash: string;
  readonly sourceLanguage: {
    readonly id: string;
    readonly profileVersion: string;
  };
  readonly totalTerms: number;
  readonly totalForms: number;
  readonly matchedTerms: number;
  readonly unmatchedTerms: number;
  readonly terms: readonly GlossaryTermReport[];
}

export interface LoadedGlossary {
  readonly hash: string;
  readonly sourceVersion?: string;
  readonly stableTerms: readonly StableTerm[];
  readonly report: GlossaryImportReport;
  readonly occurrenceIndexesByLexeme: Readonly<Record<string, readonly number[]>>;
}

export interface LoadGlossaryInput {
  readonly glossaryPath: string;
  readonly blocks: readonly LosslessBlock[];
  readonly profile: SourceLanguageProfile;
  readonly existingStableTerms?: readonly StableTerm[];
}

interface ParsedGlossaryTerm {
  readonly source: string;
  readonly target: string;
  readonly policy: GlossaryPolicy;
  readonly forms: readonly string[];
  readonly kind?: string;
  readonly note?: string;
}

interface FormEvidence {
  readonly occurrenceCount: number;
  readonly globalIndexes: readonly number[];
  readonly occurrenceKeys: readonly string[];
}

function unicodeScalars(value: string): number {
  return [...value].length;
}

function nonemptyText(value: unknown, label: string, maxScalars: number): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (unicodeScalars(normalized) > maxScalars) {
    throw new RangeError(`${label} exceeds ${maxScalars} Unicode scalars`);
  }
  return normalized;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parsePolicy(value: unknown, label: string): GlossaryPolicy {
  if (value === undefined) {
    return "preferred";
  }
  if (typeof value !== "string" || !TERM_POLICIES.has(value as GlossaryPolicy)) {
    throw new TypeError(`${label} must be one of locked, preferred, contextual`);
  }
  return value as GlossaryPolicy;
}

function parseForms(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  if (value.length > MAX_FORMS_PER_TERM) {
    throw new RangeError(`${label} exceeds ${MAX_FORMS_PER_TERM} entries`);
  }
  return value.map((form, index) => nonemptyText(
    form,
    `${label}[${index}]`,
    MAX_TERM_SCALARS,
  ));
}

function parseStructuredTerm(value: unknown, index: number): ParsedGlossaryTerm {
  const record = plainObject(value, `glossary.terms[${index}]`);
  for (const key of Object.keys(record)) {
    if (!TERM_KEYS.has(key)) {
      throw new TypeError(`unknown glossary term field: ${key}`);
    }
  }
  const source = nonemptyText(record.source, `glossary.terms[${index}].source`, MAX_TERM_SCALARS);
  const target = nonemptyText(record.target, `glossary.terms[${index}].target`, MAX_TERM_SCALARS);
  const forms = parseForms(record.forms, `glossary.terms[${index}].forms`);
  const kind = record.kind === undefined
    ? undefined
    : nonemptyText(record.kind, `glossary.terms[${index}].kind`, MAX_KIND_SCALARS);
  const note = record.note === undefined
    ? undefined
    : nonemptyText(record.note, `glossary.terms[${index}].note`, MAX_NOTE_SCALARS);
  return {
    source,
    target,
    policy: parsePolicy(record.policy, `glossary.terms[${index}].policy`),
    forms: [source, ...forms],
    ...(kind === undefined ? {} : { kind }),
    ...(note === undefined ? {} : { note }),
  };
}

function parseGlossary(glossaryPath: string): ParsedGlossaryTerm[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(glossaryPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read glossary ${glossaryPath}: ${message}`);
  }
  const root = plainObject(parsed, "glossary");
  if (root.schema !== undefined || root.terms !== undefined) {
    for (const key of Object.keys(root)) {
      if (!ROOT_KEYS.has(key)) {
        throw new TypeError(`unknown glossary field: ${key}`);
      }
    }
    if (root.schema !== GLOSSARY_SCHEMA) {
      throw new TypeError(`glossary.schema must be ${GLOSSARY_SCHEMA}`);
    }
    if (!Array.isArray(root.terms)) {
      throw new TypeError("glossary.terms must be an array");
    }
    if (root.terms.length > MAX_TERMS) {
      throw new RangeError(`glossary.terms exceeds ${MAX_TERMS} entries`);
    }
    return root.terms.map(parseStructuredTerm);
  }
  const entries = Object.entries(root);
  if (entries.length > MAX_TERMS) {
    throw new RangeError(`glossary exceeds ${MAX_TERMS} entries`);
  }
  return entries.map(([source, target]) => ({
    source: nonemptyText(source, "glossary source", MAX_TERM_SCALARS),
    target: nonemptyText(target, `glossary.${source}`, MAX_TERM_SCALARS),
    policy: "preferred" as const,
    forms: [source.trim()],
  }));
}

function normalizedForms(
  term: ParsedGlossaryTerm,
  profile: SourceLanguageProfile,
): Array<{ raw: string; normalized: string }> {
  const forms = new Map<string, string>();
  for (const form of term.forms) {
    const normalized = profile.normalizeSourceForm(form);
    if (normalized.length === 0) {
      throw new TypeError(`glossary form ${form} has no normalized content`);
    }
    if (!forms.has(normalized)) {
      forms.set(normalized, form);
    }
  }
  return [...forms.entries()]
    .map(([normalized, raw]) => ({ raw, normalized }))
    .sort((left, right) => compareText(left.raw, right.raw));
}

function assertNoDuplicateForms(
  terms: readonly ParsedGlossaryTerm[],
  profile: SourceLanguageProfile,
): void {
  const seen = new Map<string, string>();
  for (const term of terms) {
    for (const form of normalizedForms(term, profile)) {
      const existing = seen.get(form.normalized);
      if (existing !== undefined) {
        throw new Error(
          `duplicate normalized glossary form: ${form.raw} conflicts with ${existing}`,
        );
      }
      seen.set(form.normalized, form.raw);
    }
  }
}

function canonicalTerm(term: ParsedGlossaryTerm): Record<string, unknown> {
  return {
    source: term.source,
    target: term.target,
    policy: term.policy,
    forms: [...term.forms].sort(compareText),
    ...(term.kind === undefined ? {} : { kind: term.kind }),
    ...(term.note === undefined ? {} : { note: term.note }),
  };
}

function glossaryHash(terms: readonly ParsedGlossaryTerm[]): string {
  const canonicalTerms = terms.map(canonicalTerm)
    .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  return createHash("sha256")
    .update(canonicalJson({ schema: GLOSSARY_SCHEMA, terms: canonicalTerms }), "utf8")
    .digest("hex");
}

function termId(term: ParsedGlossaryTerm): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalTerm(term)), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function tokenSequence(form: string, profile: SourceLanguageProfile): string[] {
  const tokens = profile.segment(form)
    .filter((token) => token.isWordLike && token.normalized.length > 0)
    .map((token) => token.normalized);
  if (tokens.length === 0) {
    throw new TypeError(`glossary form ${form} contains no word-like source token`);
  }
  return tokens;
}

function tokensForBlock(block: LosslessBlock, profile: SourceLanguageProfile): SourceToken[] {
  return profile.segment(block.sourceText)
    .filter((token) => token.isWordLike && token.normalized.length > 0);
}

function matchingEvidence(
  form: string,
  blocks: readonly LosslessBlock[],
  profile: SourceLanguageProfile,
): FormEvidence {
  const pattern = tokenSequence(form, profile);
  const indexes = new Set<number>();
  const occurrenceKeys = new Set<string>();
  let occurrenceCount = 0;
  for (const block of blocks) {
    const tokens = tokensForBlock(block, profile);
    for (let start = 0; start <= tokens.length - pattern.length; start += 1) {
      const matches = pattern.every((part, offset) =>
        tokens[start + offset]?.normalized === part);
      if (matches) {
        occurrenceCount += 1;
        indexes.add(block.globalIndex);
        occurrenceKeys.add(`${block.id}\u0000${tokens[start]?.start ?? 0}`);
      }
    }
  }
  return {
    occurrenceCount,
    globalIndexes: [...indexes].sort((left, right) => left - right),
    occurrenceKeys: [...occurrenceKeys].sort(compareText),
  };
}

function stableTermsFor(
  terms: readonly ParsedGlossaryTerm[],
  profile: SourceLanguageProfile,
): StableTerm[] {
  return terms.flatMap((term) => {
    const id = termId(term);
    return normalizedForms(term, profile).map((form, index) => ({
      conceptId: `glossary-${id}`,
      lexemeId: `glossary-${id}-${index}`,
      sourceForm: form.raw,
      canonicalSource: term.source,
      target: term.target,
      locked: term.policy === "locked",
      policy: term.policy,
      ...(term.note === undefined ? {} : { note: term.note }),
      origin: "glossary" as const,
    }));
  }).sort((left, right) => compareText(left.sourceForm, right.sourceForm));
}

function assertNoExistingConflict(
  terms: readonly StableTerm[],
  existing: readonly StableTerm[],
  profile: SourceLanguageProfile,
): void {
  const existingByForm = new Map<string, Set<string>>();
  for (const term of existing) {
    const normalized = profile.normalizeSourceForm(term.sourceForm);
    const targets = existingByForm.get(normalized) ?? new Set<string>();
    targets.add(term.target);
    existingByForm.set(normalized, targets);
  }
  for (const term of terms) {
    const previousTargets = existingByForm.get(profile.normalizeSourceForm(term.sourceForm));
    const conflictingTarget = [...(previousTargets ?? [])]
      .find((target) => target !== term.target);
    if (conflictingTarget !== undefined) {
      throw new Error(
        `glossary conflicts with existing stable term for ${term.sourceForm}: ${conflictingTarget} != ${term.target}`,
      );
    }
  }
}

function evidenceForTerm(
  term: ParsedGlossaryTerm,
  blocks: readonly LosslessBlock[],
  profile: SourceLanguageProfile,
): GlossaryTermReport {
  const formEvidence = term.forms.map((form) => ({ form, evidence: matchingEvidence(form, blocks, profile) }));
  const indexSet = new Set<number>();
  const unmatchedForms: string[] = [];
  for (const item of formEvidence) {
    item.evidence.globalIndexes.forEach((index) => indexSet.add(index));
    if (item.evidence.occurrenceCount === 0) {
      unmatchedForms.push(item.form);
    }
  }
  const uniqueOccurrences = new Set(formEvidence.flatMap((item) => item.evidence.occurrenceKeys));
  return {
    source: term.source,
    target: term.target,
    policy: term.policy,
    forms: [...term.forms],
    ...(term.kind === undefined ? {} : { kind: term.kind }),
    ...(term.note === undefined ? {} : { note: term.note }),
    occurrenceCount: uniqueOccurrences.size,
    globalIndexes: [...indexSet].sort((left, right) => left - right),
    unmatchedForms,
  };
}

/**
 * Parses a user glossary and grounds it against lossless source blocks without
 * asking a model to read the book. The returned hash describes semantic term
 * content, not formatting or file path.
 */
export function loadGlossary(input: LoadGlossaryInput): LoadedGlossary {
  const terms = parseGlossary(input.glossaryPath);
  const sourceVersions = new Set(input.blocks.map((block) => block.sourceVersion));
  if (sourceVersions.size > 1) {
    throw new Error("glossary source blocks do not share one source version");
  }
  assertNoDuplicateForms(terms, input.profile);
  const stableTerms = stableTermsFor(terms, input.profile);
  assertNoExistingConflict(stableTerms, input.existingStableTerms ?? [], input.profile);
  const occurrenceIndexesByLexeme: Record<string, readonly number[]> = {};
  for (const term of stableTerms) {
    occurrenceIndexesByLexeme[term.lexemeId] = matchingEvidence(
      term.sourceForm,
      input.blocks,
      input.profile,
    ).globalIndexes;
  }
  const reportTerms = terms.map((term) => evidenceForTerm(term, input.blocks, input.profile))
    .sort((left, right) => compareText(left.source, right.source));
  const hash = glossaryHash(terms);
  const report: GlossaryImportReport = {
    schema: REPORT_SCHEMA,
    glossaryHash: hash,
    sourceLanguage: {
      id: input.profile.id,
      profileVersion: input.profile.version,
    },
    totalTerms: terms.length,
    totalForms: terms.reduce((total, term) => total + term.forms.length, 0),
    matchedTerms: reportTerms.filter((term) => term.occurrenceCount > 0).length,
    unmatchedTerms: reportTerms.filter((term) => term.occurrenceCount === 0).length,
    terms: reportTerms,
  };
  return {
    hash,
    ...(sourceVersions.size === 0 ? {} : { sourceVersion: [...sourceVersions][0] }),
    stableTerms,
    report,
    occurrenceIndexesByLexeme,
  };
}

/** Returns the imported terms with deterministic evidence inside any requested block. */
export function relevantGlossaryTerms(
  glossary: LoadedGlossary,
  globalIndexes: readonly number[],
): StableTerm[] {
  const requested = new Set(globalIndexes);
  return glossary.stableTerms.filter((term) =>
    (glossary.occurrenceIndexesByLexeme[term.lexemeId] ?? [])
    .some((index) => requested.has(index)))
    .map((term) => ({ ...term }));
}
