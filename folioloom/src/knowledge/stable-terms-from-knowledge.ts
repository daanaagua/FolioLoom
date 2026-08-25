import { createHash } from "node:crypto";

import { entityLinkAsTerms, type EntityLink } from "../domain/entity-links.js";
import type { StableTerm } from "../domain/types.js";
import type { LexicalSemanticClass } from "./lexical-concept.js";
import type { KnowledgeRevision } from "./knowledge-store.js";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function modelSafeTerm(term: StableTerm): StableTerm {
  if (!term.conceptId.startsWith("run-anchor-")
    || (term.locked && term.policy === "locked")) {
    return { ...term };
  }
  return {
    ...term,
    locked: false,
    policy: "preferred",
    note: "single-pass model anchor; prefer this rendering but allow context-sensitive Chinese wording",
  };
}

/**
 * Convert active durable lexical knowledge into the stable-term wire protocol.
 * User/import policy remains authoritative; single-pass model anchors are
 * softened to preferences unless the existing evidence protocol locked them.
 */
export function stableTermsFromKnowledge(
  revisions: readonly unknown[],
): StableTerm[] {
  const terms: StableTerm[] = [];
  for (const raw of revisions) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const revision = raw as Partial<KnowledgeRevision>;
    if (revision.status !== "active") continue;
    const payload = record(revision.payload);
    if (revision.kind === "lexical_concept" && payload !== undefined) {
      const sourceForms = payload.sourceForms;
      const semanticClass = payload.semanticClass;
      const policy = payload.policy;
      const allowedRealizations = payload.allowedRealizations;
      const conceptId = payload.conceptId;
      const revisionId = payload.revisionId;
      const normalizedSubject = payload.normalizedSubject;
      const canonicalTarget = payload.canonicalTarget;
      const renderFingerprint = payload.renderFingerprint;
      if (Array.isArray(sourceForms)
        && sourceForms.length > 0
        && sourceForms.every((value) =>
          typeof value === "string" && value.trim().length > 0)
        && typeof semanticClass === "string"
        && ["proper_name", "unique_title", "technical_term", "role"]
          .includes(semanticClass)
        && typeof policy === "string"
        && ["locked", "preferred", "contextual"].includes(policy)
        && Array.isArray(allowedRealizations)
        && allowedRealizations.length > 0
        && allowedRealizations.every((value) =>
          typeof value === "string" && value.trim().length > 0)
        && typeof conceptId === "string"
        && conceptId.trim().length > 0
        && typeof revisionId === "string"
        && revisionId.trim().length > 0
        && typeof normalizedSubject === "string"
        && normalizedSubject.trim().length > 0
        && typeof canonicalTarget === "string"
        && canonicalTarget.trim().length > 0
        && typeof renderFingerprint === "string"
        && /^[a-f0-9]{64}$/u.test(renderFingerprint)) {
        terms.push(...sourceForms.map((sourceForm) => ({
          conceptId,
          lexemeId: `${conceptId}-lexeme-${createHash("sha256")
            .update(sourceForm)
            .digest("hex")
            .slice(0, 12)}`,
          sourceForm,
          canonicalSource: normalizedSubject,
          target: canonicalTarget,
          locked: policy === "locked",
          policy: policy as StableTerm["policy"],
          semanticClass: semanticClass as LexicalSemanticClass,
          allowedTargets: [...allowedRealizations] as string[],
          revisionId,
          renderFingerprint,
          note: policy === "contextual"
            ? "semantic concept; choose an allowed Chinese realization appropriate to context"
            : "closed lexical concept",
          origin: "knowledge" as const,
        })));
      }
      continue;
    }
    if (revision.kind === "lexical_anchor" && payload !== undefined) {
      if (typeof payload.sourceForm === "string"
        && typeof payload.canonicalSource === "string"
        && typeof payload.target === "string"
        && typeof payload.locked === "boolean") {
        const term: StableTerm = {
          conceptId: typeof payload.conceptId === "string"
            ? payload.conceptId
            : `user-${revision.normalizedSubject ?? payload.canonicalSource}`,
          lexemeId: typeof payload.lexemeId === "string"
            ? payload.lexemeId
            : `user-${revision.revisionId ?? revision.normalizedSubject ?? payload.sourceForm}`,
          sourceForm: payload.sourceForm,
          canonicalSource: payload.canonicalSource,
          target: payload.target,
          locked: payload.locked,
          ...(payload.policy === undefined
            ? {}
            : { policy: payload.policy as StableTerm["policy"] }),
          ...(payload.note === undefined ? {} : { note: String(payload.note) }),
          origin: "knowledge",
        };
        const modelAuthored = revision.authority === undefined
          || revision.authority.origin === "model";
        terms.push(modelAuthored ? modelSafeTerm(term) : term);
      }
      continue;
    }
    if (revision.kind === "entity_alias_link" && payload !== undefined) {
      terms.push(...entityLinkAsTerms(payload as unknown as EntityLink).map((term) => ({
        ...term,
        origin: term.origin ?? "knowledge",
      })));
    }
  }
  return terms;
}
