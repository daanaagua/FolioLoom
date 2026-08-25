import { createHash } from "node:crypto";

import type { SourceLanguageProfile } from "../language/types.js";
import type { StableTerm } from "./types.js";

export type EntityLinkStatus = "provisional" | "confirmed" | "conflicted";

export type EntityLinkEvidenceKind =
  | "explicit_naming"
  | "apposition"
  | "contextual_compatibility"
  | "distributional_compatibility"
  | "model_verdict"
  | "string_similarity"
  | "contradiction";

export interface EntityLinkEvidence {
  evidenceId: string;
  kind: EntityLinkEvidenceKind;
  weight: number;
  sourceForms: readonly string[];
  blockId?: string;
  globalIndex?: number;
}

export interface EntityLinkScoreComponents {
  explicitNaming: number;
  apposition: number;
  contextualCompatibility: number;
  distributionalCompatibility: number;
  modelVerdict: number;
  stringSimilarity: number;
  contradictionPenalty: number;
}

export interface EntityLink {
  schemaVersion: "v5-entity-link-1";
  linkId: string;
  revision: number;
  sourceForms: readonly string[];
  normalizedForms: readonly string[];
  conceptId: string | null;
  status: EntityLinkStatus;
  confidence: number;
  preferredTarget: string | null;
  score: number;
  scoreComponents: EntityLinkScoreComponents;
  evidence: readonly EntityLinkEvidence[];
}

interface EvaluateEntityLinkInput {
  sourceForms: readonly string[];
  evidence: readonly EntityLinkEvidence[];
  proposedTarget?: string;
  profile: SourceLanguageProfile;
}

interface RevalidateEntityLinkOptions {
  proposedTarget?: string;
  profile: SourceLanguageProfile;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function requireWeight(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("entity-link evidence weight must be from zero to one");
  }
  return value;
}

function canonicalEvidence(
  evidence: readonly EntityLinkEvidence[],
): EntityLinkEvidence[] {
  const byId = new Map<string, EntityLinkEvidence>();
  for (const item of evidence) {
    if (item.evidenceId.trim().length === 0) {
      throw new TypeError("entity-link evidenceId must be nonempty");
    }
    const normalized: EntityLinkEvidence = {
      evidenceId: item.evidenceId,
      kind: item.kind,
      weight: requireWeight(item.weight),
      sourceForms: [...new Set(item.sourceForms)].sort(compareText),
      ...(item.blockId === undefined ? {} : { blockId: item.blockId }),
      ...(item.globalIndex === undefined ? {} : { globalIndex: item.globalIndex }),
    };
    const previous = byId.get(normalized.evidenceId);
    if (previous !== undefined
      && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`conflicting entity-link evidence id: ${normalized.evidenceId}`);
    }
    byId.set(normalized.evidenceId, normalized);
  }
  return [...byId.values()].sort((left, right) =>
    compareText(left.evidenceId, right.evidenceId));
}

function maximum(
  evidence: readonly EntityLinkEvidence[],
  kind: EntityLinkEvidenceKind,
): number {
  return evidence.reduce((result, item) =>
    item.kind === kind ? Math.max(result, item.weight) : result, 0);
}

function scoreComponents(evidence: readonly EntityLinkEvidence[]): EntityLinkScoreComponents {
  return {
    explicitNaming: rounded(maximum(evidence, "explicit_naming")),
    apposition: rounded(maximum(evidence, "apposition") * 0.8),
    contextualCompatibility: rounded(maximum(evidence, "contextual_compatibility") * 0.5),
    distributionalCompatibility: rounded(maximum(evidence, "distributional_compatibility") * 0.4),
    modelVerdict: rounded(maximum(evidence, "model_verdict") * 0.4),
    stringSimilarity: rounded(maximum(evidence, "string_similarity") * 0.15),
    contradictionPenalty: rounded(maximum(evidence, "contradiction")),
  };
}

function buildLink(
  input: EvaluateEntityLinkInput,
  revision: number,
): EntityLink {
  const pairs = input.sourceForms.map((sourceForm) => ({
    sourceForm,
    normalized: input.profile.normalizeSourceForm(sourceForm),
  })).filter((item) => item.normalized.length > 0)
    .sort((left, right) => compareText(left.normalized, right.normalized)
      || compareText(left.sourceForm, right.sourceForm));
  const unique = new Map(pairs.map((pair) => [pair.normalized, pair]));
  if (unique.size < 2) {
    throw new TypeError("entity link requires at least two distinct normalized source forms");
  }
  const normalizedPairs = [...unique.values()];
  const normalizedForms = normalizedPairs.map((pair) => pair.normalized);
  const sourceForms = normalizedPairs.map((pair) => pair.sourceForm);
  const linkId = `entity-link-${createHash("sha256")
    .update(`${input.profile.id}\0${normalizedForms.join("\0")}`)
    .digest("hex")
    .slice(0, 20)}`;
  const evidence = canonicalEvidence(input.evidence);
  const components = scoreComponents(evidence);
  const positive = components.explicitNaming
    + components.apposition
    + components.contextualCompatibility
    + components.distributionalCompatibility
    + components.modelVerdict
    + components.stringSimilarity;
  const score = rounded(positive - components.contradictionPenalty);
  const independentSignals = [
    components.contextualCompatibility,
    components.distributionalCompatibility,
    components.modelVerdict,
  ].filter((value) => value > 0).length;
  const status: EntityLinkStatus = components.contradictionPenalty >= 0.5
    ? "conflicted"
    : components.explicitNaming >= 0.8
      || components.apposition >= 0.7
      || (independentSignals >= 2 && score >= 1)
      ? "confirmed"
      : "provisional";
  const target = input.proposedTarget?.trim() ?? "";
  const preferredTarget = status === "confirmed" && target.length > 0
    ? target
    : null;
  const conceptId = status === "confirmed" ? `entity-${linkId.slice(12)}` : null;
  const confidence = status === "conflicted"
    ? rounded(Math.min(1, components.contradictionPenalty))
    : rounded(Math.max(0, Math.min(1, positive / 1.2)));
  return {
    schemaVersion: "v5-entity-link-1",
    linkId,
    revision,
    sourceForms,
    normalizedForms,
    conceptId,
    status,
    confidence,
    preferredTarget,
    score,
    scoreComponents: components,
    evidence,
  };
}

export function evaluateEntityLink(input: EvaluateEntityLinkInput): EntityLink {
  return buildLink(input, 1);
}

export function revalidateEntityLink(
  current: EntityLink,
  additionalEvidence: readonly EntityLinkEvidence[],
  options: RevalidateEntityLinkOptions,
): EntityLink {
  return buildLink({
    sourceForms: current.sourceForms,
    evidence: [...current.evidence, ...additionalEvidence],
    proposedTarget: options.proposedTarget ?? current.preferredTarget ?? undefined,
    profile: options.profile,
  }, current.revision + 1);
}

export function entityLinkAsTerms(link: EntityLink): StableTerm[] {
  if (link.status !== "confirmed"
    || link.conceptId === null
    || link.preferredTarget === null) {
    return [];
  }
  return link.sourceForms.map((sourceForm, index) => ({
    conceptId: link.conceptId as string,
    lexemeId: `entity-lexeme-${createHash("sha256")
      .update(`${link.linkId}\0${link.normalizedForms[index]}`)
      .digest("hex")
      .slice(0, 20)}`,
    sourceForm,
    canonicalSource: sourceForm,
    target: link.preferredTarget as string,
    locked: true,
  }));
}
