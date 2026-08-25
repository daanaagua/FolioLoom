import type { EntityLink } from "../domain/entity-links.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  KnowledgeStore,
  type KnowledgeRevision,
  type KnowledgeStatus,
} from "../knowledge/knowledge-store.js";

export interface ActiveEntityRendering {
  windowId: string;
  blockId: string;
  sourceForm: string;
  activeTarget: string;
}

export interface EntityTargetDriftCandidate extends ActiveEntityRendering {
  kind: "confirmed_alias_target_drift";
  linkId: string;
  preferredTarget: string;
}

function knowledgeStatus(link: EntityLink): KnowledgeStatus {
  if (link.status === "confirmed") {
    return "active";
  }
  if (link.status === "conflicted") {
    return "needs_revalidate";
  }
  return "provisional";
}

export function appendEntityLinkRevision(
  store: KnowledgeStore,
  link: EntityLink,
  sourceWindowId: string,
): KnowledgeRevision {
  const subject = `entity-alias:${link.linkId}`;
  const current = store.latestRevision(subject, "entity_alias_link");
  return store.appendRevision({
    normalizedSubject: subject,
    kind: "entity_alias_link",
    payload: link,
    status: knowledgeStatus(link),
    candidateIds: [
      ...(current?.candidateIds ?? []),
      ...link.evidence.map((item) => item.evidenceId),
    ],
    sourceWindowIds: [...(current?.sourceWindowIds ?? []), sourceWindowId],
  });
}

export function shouldScheduleAliasRevalidation(
  link: EntityLink,
  occurrenceSourceForm: string,
  profile: SourceLanguageProfile,
): boolean {
  if (link.status === "confirmed") {
    return false;
  }
  const normalized = profile.normalizeSourceForm(occurrenceSourceForm);
  return link.normalizedForms.includes(normalized);
}

export function driftCandidatesForConfirmedLink(
  link: EntityLink,
  renderings: readonly ActiveEntityRendering[],
): EntityTargetDriftCandidate[] {
  if (link.status !== "confirmed" || link.preferredTarget === null) {
    return [];
  }
  return renderings.filter((rendering) =>
    link.sourceForms.includes(rendering.sourceForm)
    && rendering.activeTarget !== link.preferredTarget)
    .map((rendering) => ({
      kind: "confirmed_alias_target_drift",
      linkId: link.linkId,
      ...rendering,
      preferredTarget: link.preferredTarget as string,
    }));
}
