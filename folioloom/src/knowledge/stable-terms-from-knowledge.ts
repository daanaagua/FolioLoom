import { createHash } from "node:crypto";

import { entityLinkAsTerms, type EntityLink } from "../domain/entity-links.js";
import type { StableTerm } from "../domain/types.js";
import type { LexicalSemanticClass } from "./lexical-concept.js";
import {
  canonicalJson,
  type KnowledgeRevision,
} from "./knowledge-store.js";
import { createTermRenderingRule } from "./term-rendering-rule.js";
import { combineLexicalPreferences, readLexicalPreference } from "./lexical-preference.js";

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

function authorityRank(revision: Partial<KnowledgeRevision>): number {
  const scope = revision.authority?.scope === "book"
    ? 40
    : revision.authority?.scope === "project"
      ? 20
      : 10;
  const origin = revision.authority?.origin === "manual"
    || revision.authority?.origin === "rollback"
    ? 20
    : revision.authority?.origin === "import"
      ? 10
      : 0;
  return scope + origin;
}

function renderingFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
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
  const preferences: StableTerm[] = [];
  for (const raw of revisions) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const revision = raw as Partial<KnowledgeRevision>;
    if (revision.status !== "active") continue;
    const payload = record(revision.payload);
    if (revision.kind?.startsWith("lexical_preference:")) {
      const term = readLexicalPreference(payload);
      if (term !== undefined) preferences.push({ ...term, origin: "knowledge" });
      continue;
    }
    if (typeof revision.kind === "string"
      && revision.kind.startsWith("term_rendering_rule:")
      && payload !== undefined
      && typeof revision.revisionId === "string") {
      const sourceForms = Array.isArray(payload.sourceForms)
        ? payload.sourceForms
        : typeof payload.sourceForm === "string"
          ? [payload.sourceForm]
          : [];
      const rule = createTermRenderingRule({
        ruleId: payload.ruleId,
        conceptId: payload.conceptId,
        ...(payload.entityId === undefined ? {} : { entityId: payload.entityId }),
        sourceForms: sourceForms as string[],
        target: payload.target,
        allowedTargets: payload.allowedTargets as string[] | undefined,
        policy: payload.policy,
        selector: payload.selector,
        priority: payload.priority,
        authorityRank: authorityRank(revision),
      } as Parameters<typeof createTermRenderingRule>[0]);
      const fingerprint = renderingFingerprint({
        baseConceptId: rule.conceptId,
        sourceForms: rule.sourceForms,
        target: rule.target,
        allowedTargets: rule.allowedTargets,
        policy: rule.policy,
        selector: rule.selector,
        priority: rule.priority,
        authorityRank: rule.authorityRank,
      });
      const bindingConceptId = `term-rule-${createHash("sha256")
        .update(`${rule.conceptId}\0${rule.ruleId}`, "utf8")
        .digest("hex")
        .slice(0, 24)}`;
      terms.push(...rule.sourceForms.map((sourceForm, index): StableTerm => ({
        conceptId: bindingConceptId,
        lexemeId: `${bindingConceptId}-lexeme-${index}`,
        sourceForm,
        canonicalSource: revision.normalizedSubject ?? sourceForm,
        target: rule.target,
        locked: rule.policy === "locked",
        policy: rule.policy,
        semanticClass: rule.entityId === undefined
          ? "technical_term"
          : "proper_name",
        allowedTargets: [...rule.allowedTargets],
        revisionId: revision.revisionId,
        renderFingerprint: fingerprint,
        origin: "knowledge",
        ruleId: rule.ruleId,
        baseConceptId: rule.conceptId,
        ...(rule.entityId === undefined ? {} : { entityId: rule.entityId }),
        applicability: rule.selector,
        authorityRank: rule.authorityRank,
        priority: rule.priority,
      })));
      continue;
    }
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
  return [...terms, ...combineLexicalPreferences(preferences)];
}
