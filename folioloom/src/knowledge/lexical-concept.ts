import { createHash } from "node:crypto";

import type {
  StableTermPolicy,
  VisibilityChannel,
} from "../domain/types.js";

export type LexicalSemanticClass =
  | "proper_name"
  | "unique_title"
  | "technical_term"
  | "role";

export interface LexicalConcept {
  readonly conceptId: string;
  readonly revisionId: string;
  readonly normalizedSubject: string;
  readonly sourceForms: readonly string[];
  readonly semanticClass: LexicalSemanticClass;
  readonly canonicalTarget: string;
  readonly policy: StableTermPolicy;
  readonly allowedRealizations: readonly string[];
  readonly confidence: number;
  readonly visibility: VisibilityChannel;
  readonly renderFingerprint: string;
}

export interface LexicalConceptAnchorInput {
  readonly sourceForm: string;
  readonly sourceForms?: readonly string[];
  readonly target: string;
  readonly mode: "stable" | "contextual";
  readonly semanticClass: LexicalSemanticClass;
  readonly confidence: number;
  readonly allowedRealizations?: readonly string[];
  readonly visibility?: VisibilityChannel;
}

export type LexicalConceptRevision = Partial<Pick<
  LexicalConcept,
  | "sourceForms"
  | "semanticClass"
  | "canonicalTarget"
  | "policy"
  | "allowedRealizations"
  | "confidence"
  | "visibility"
>>;

const SEMANTIC_CLASSES = new Set<LexicalSemanticClass>([
  "proper_name",
  "unique_title",
  "technical_term",
  "role",
]);

const POLICIES = new Set<StableTermPolicy>([
  "locked",
  "preferred",
  "contextual",
]);

const VISIBILITIES = new Set<VisibilityChannel>([
  "translator_global",
  "narrative_before_target",
]);

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function normalizedText(value: unknown, label: string, maxScalars: number): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0
    || Array.from(normalized).length > maxScalars
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function normalizedSubject(sourceForm: string): string {
  return sourceForm.toLocaleLowerCase("und");
}

function sourceForms(values: readonly string[]): string[] {
  const normalized = values.map((value) =>
    normalizedText(value, "source form", 128));
  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right, "und"));
}

function realizations(
  canonicalTarget: string,
  values: readonly string[],
): string[] {
  const unique = new Set(values.map((value) =>
    normalizedText(value, "allowed realization", 64)));
  unique.add(canonicalTarget);
  return [
    canonicalTarget,
    ...[...unique]
      .filter((value) => value !== canonicalTarget)
      .sort((left, right) => left.localeCompare(right, "zh-Hans")),
  ];
}

function semanticClass(value: unknown): LexicalSemanticClass {
  if (typeof value !== "string"
    || !SEMANTIC_CLASSES.has(value as LexicalSemanticClass)) {
    throw new TypeError(`invalid lexical semantic class: ${String(value)}`);
  }
  return value as LexicalSemanticClass;
}

function policy(value: unknown): StableTermPolicy {
  if (typeof value !== "string" || !POLICIES.has(value as StableTermPolicy)) {
    throw new TypeError(`invalid lexical policy: ${String(value)}`);
  }
  return value as StableTermPolicy;
}

function visibility(value: unknown): VisibilityChannel {
  if (typeof value !== "string"
    || !VISIBILITIES.has(value as VisibilityChannel)) {
    throw new TypeError(`invalid lexical visibility: ${String(value)}`);
  }
  return value as VisibilityChannel;
}

function confidence(value: unknown): number {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1) {
    throw new TypeError("lexical confidence must be a finite number from 0 through 1");
  }
  return value;
}

interface ConceptContent {
  readonly normalizedSubject: string;
  readonly sourceForms: readonly string[];
  readonly semanticClass: LexicalSemanticClass;
  readonly canonicalTarget: string;
  readonly policy: StableTermPolicy;
  readonly allowedRealizations: readonly string[];
  readonly confidence: number;
  readonly visibility: VisibilityChannel;
}

function createConcept(
  conceptId: string,
  raw: ConceptContent,
): LexicalConcept {
  const forms = sourceForms(raw.sourceForms);
  if (forms.length === 0) {
    throw new TypeError("lexical concept requires at least one source form");
  }
  const target = normalizedText(raw.canonicalTarget, "canonical target", 64);
  const semantics = semanticClass(raw.semanticClass);
  const surfacePolicy = policy(raw.policy);
  const channel = visibility(raw.visibility);
  const certainty = confidence(raw.confidence);
  const allowed = realizations(target, raw.allowedRealizations);
  const subject = normalizedText(raw.normalizedSubject, "normalized subject", 128)
    .toLocaleLowerCase("und");
  const renderContent = {
    sourceForms: forms,
    semanticClass: semantics,
    canonicalTarget: target,
    policy: surfacePolicy,
    allowedRealizations: allowed,
    visibility: channel,
  };
  const renderFingerprint = hash(renderContent);
  const revisionId = `lexical-revision-${hash({
    conceptId,
    normalizedSubject: subject,
    ...renderContent,
    confidence: certainty,
  }).slice(0, 24)}`;
  return Object.freeze({
    conceptId,
    revisionId,
    normalizedSubject: subject,
    sourceForms: Object.freeze(forms),
    semanticClass: semantics,
    canonicalTarget: target,
    policy: surfacePolicy,
    allowedRealizations: Object.freeze(allowed),
    confidence: certainty,
    visibility: channel,
    renderFingerprint,
  });
}

export function conceptFromAnchor(
  input: LexicalConceptAnchorInput,
): LexicalConcept {
  const primary = normalizedText(input.sourceForm, "source form", 128);
  const forms = sourceForms([primary, ...(input.sourceForms ?? [])]);
  const semantics = semanticClass(input.semanticClass);
  const subject = normalizedSubject(primary);
  const conceptId = `lexical-${hash({
    normalizedSubject: subject,
    semanticClass: semantics,
  }).slice(0, 24)}`;
  return createConcept(conceptId, {
    normalizedSubject: subject,
    sourceForms: forms,
    semanticClass: semantics,
    canonicalTarget: input.target,
    policy: input.mode === "contextual" ? "contextual" : "preferred",
    allowedRealizations: input.allowedRealizations ?? [input.target],
    confidence: input.confidence,
    visibility: input.visibility ?? "translator_global",
  });
}

export function reviseConcept(
  concept: LexicalConcept,
  patch: LexicalConceptRevision,
): LexicalConcept {
  return createConcept(concept.conceptId, {
    normalizedSubject: concept.normalizedSubject,
    sourceForms: patch.sourceForms ?? concept.sourceForms,
    semanticClass: patch.semanticClass ?? concept.semanticClass,
    canonicalTarget: patch.canonicalTarget ?? concept.canonicalTarget,
    policy: patch.policy ?? concept.policy,
    allowedRealizations: patch.allowedRealizations ?? concept.allowedRealizations,
    confidence: patch.confidence ?? concept.confidence,
    visibility: patch.visibility ?? concept.visibility,
  });
}
