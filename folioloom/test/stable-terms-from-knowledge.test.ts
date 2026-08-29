import assert from "node:assert/strict";
import test from "node:test";

import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { stableTermsFromKnowledge } from "../src/knowledge/stable-terms-from-knowledge.js";

test("projects a scoped manual rendering rule into executable stable terms", () => {
  const domain = new KnowledgeStore();
  const payload = {
    ruleId: "concealed-name",
    conceptId: "entity-severian",
    entityId: "entity-severian",
    sourceForms: ["Severian"],
    target: "灰袍人",
    allowedTargets: ["灰袍人"],
    policy: "locked",
    locked: true,
    selector: {
      kind: "block_range",
      sourceVersion: "source-v1",
      startBlockId: "block-2",
      endBlockId: "block-5",
      startGlobalIndex: 2,
      endGlobalIndex: 5,
    },
    priority: 3,
  } as const;
  const revision = domain.appendRevision({
    normalizedSubject: "severian",
    kind: "term_rendering_rule:concealed-name",
    payload,
    alternatives: [payload],
    status: "active",
    authority: {
      origin: "manual",
      scope: "book",
      ownedFields: ["/target", "/selector"],
    },
  });

  const terms = stableTermsFromKnowledge([revision]);
  assert.equal(terms.length, 1);
  assert.equal(terms[0]?.target, "灰袍人");
  assert.equal(terms[0]?.baseConceptId, "entity-severian");
  assert.equal(terms[0]?.ruleId, "concealed-name");
  assert.equal(terms[0]?.authorityRank, 60);
  assert.deepEqual(terms[0]?.applicability, {
    kind: "block_range",
    sourceVersion: "source-v1",
    startBlockId: "block-2",
    endBlockId: "block-5",
    startGlobalIndex: 2,
    endGlobalIndex: 5,
  });
  assert.match(terms[0]?.renderFingerprint ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(terms[0]?.revisionId, revision.revisionId);
});
