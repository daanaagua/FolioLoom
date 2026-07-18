import assert from "node:assert/strict";
import test from "node:test";

import {
  entityLinkAsTerms,
  evaluateEntityLink,
  revalidateEntityLink,
  type EntityLinkEvidence,
} from "../src/domain/entity-links.js";
import {
  appendEntityLinkRevision,
  driftCandidatesForConfirmedLink,
  shouldScheduleAliasRevalidation,
} from "../src/fullbook/entity-revalidation.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

const profile = getSourceLanguageProfile("en");

function evidence(
  evidenceId: string,
  kind: EntityLinkEvidence["kind"],
  weight: number,
): EntityLinkEvidence {
  return {
    evidenceId,
    kind,
    weight,
    sourceForms: ["Loukianos", "Lucian"],
    blockId: `block-${evidenceId}`,
    globalIndex: 1,
  };
}

test("entity link remains provisional when only string similarity exists", () => {
  const link = evaluateEntityLink({
    sourceForms: ["Loukianos", "Lucian"],
    evidence: [evidence("similar", "string_similarity", 1)],
    proposedTarget: "卢奇安",
    profile,
  });
  assert.equal(link.status, "provisional");
  assert.equal(link.preferredTarget, null);
  assert.equal(link.scoreComponents.stringSimilarity, 0.15);
});

test("explicit naming confirms aliases with one concept and separate lexemes", () => {
  const link = evaluateEntityLink({
    sourceForms: ["Loukianos", "Lucian"],
    evidence: [evidence("named", "explicit_naming", 0.95)],
    proposedTarget: "卢奇安",
    profile,
  });
  assert.equal(link.status, "confirmed");
  assert.equal(link.preferredTarget, "卢奇安");
  const terms = entityLinkAsTerms(link);
  assert.equal(new Set(terms.map((term) => term.conceptId)).size, 1);
  assert.equal(new Set(terms.map((term) => term.lexemeId)).size, 2);
  assert.deepEqual(terms.map((term) => term.target), ["卢奇安", "卢奇安"]);
});

test("independent contextual signals can confirm while contradiction conflicts", () => {
  const contextual = evaluateEntityLink({
    sourceForms: ["Loukianos", "Lucian"],
    evidence: [
      evidence("context", "contextual_compatibility", 0.9),
      evidence("distribution", "distributional_compatibility", 0.9),
      evidence("model", "model_verdict", 0.9),
    ],
    proposedTarget: "卢奇安",
    profile,
  });
  assert.equal(contextual.status, "confirmed");

  const conflicted = revalidateEntityLink(contextual, [
    evidence("contradiction", "contradiction", 0.8),
  ], { proposedTarget: "卢奇安", profile });
  assert.equal(conflicted.status, "conflicted");
  assert.ok(conflicted.evidence.some((item) => item.evidenceId === "model"));
  assert.ok(conflicted.evidence.some((item) => item.evidenceId === "contradiction"));
});

test("entity evidence order cannot change final state or revision payload", () => {
  const items = [
    evidence("b", "distributional_compatibility", 0.8),
    evidence("a", "contextual_compatibility", 0.9),
    evidence("c", "model_verdict", 0.9),
  ];
  const first = evaluateEntityLink({
    sourceForms: ["Lucian", "Loukianos"],
    evidence: items,
    proposedTarget: "卢奇安",
    profile,
  });
  const second = evaluateEntityLink({
    sourceForms: ["Loukianos", "Lucian"],
    evidence: [...items].reverse(),
    proposedTarget: "卢奇安",
    profile,
  });
  assert.deepEqual(second, first);

  const firstStore = new KnowledgeStore();
  const secondStore = new KnowledgeStore();
  const firstRevision = appendEntityLinkRevision(firstStore, first, "window-1");
  const secondRevision = appendEntityLinkRevision(secondStore, second, "window-1");
  assert.equal(firstRevision.revisionId, secondRevision.revisionId);
});

test("new occurrences revalidate unresolved links and confirmed drift is explicit", () => {
  const provisional = evaluateEntityLink({
    sourceForms: ["Loukianos", "Lucian"],
    evidence: [evidence("similar", "string_similarity", 1)],
    proposedTarget: "卢奇安",
    profile,
  });
  assert.equal(shouldScheduleAliasRevalidation(provisional, "Lucian", profile), true);

  const confirmed = revalidateEntityLink(provisional, [
    evidence("named", "explicit_naming", 1),
  ], { proposedTarget: "卢奇安", profile });
  assert.equal(shouldScheduleAliasRevalidation(confirmed, "Lucian", profile), false);
  assert.deepEqual(driftCandidatesForConfirmedLink(confirmed, [{
    windowId: "window-0",
    blockId: "block-0",
    sourceForm: "Lucian",
    activeTarget: "路吉阿诺斯",
  }]), [{
    kind: "confirmed_alias_target_drift",
    linkId: confirmed.linkId,
    windowId: "window-0",
    blockId: "block-0",
    sourceForm: "Lucian",
    activeTarget: "路吉阿诺斯",
    preferredTarget: "卢奇安",
  }]);
});
