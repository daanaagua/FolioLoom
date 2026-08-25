import assert from "node:assert/strict";
import test from "node:test";

import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";

test("lexical concept preserves contextual policy with a stable render fingerprint", () => {
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });

  assert.equal(concept.policy, "contextual");
  assert.equal(concept.normalizedSubject, "prokurist");
  assert.deepEqual(concept.sourceForms, ["Prokurist"]);
  assert.deepEqual(concept.allowedRealizations, ["主事"]);
  assert.equal(concept.renderFingerprint.length, 64);
  assert.equal(
    reviseConcept(concept, { confidence: 0.99 }).renderFingerprint,
    concept.renderFingerprint,
  );
  assert.notEqual(
    reviseConcept(concept, { canonicalTarget: "协理" }).renderFingerprint,
    concept.renderFingerprint,
  );
});

test("lexical concept identity is deterministic while revision identity follows all content", () => {
  const first = conceptFromAnchor({
    sourceForm: "  Archon ",
    target: "执政官",
    mode: "stable",
    semanticClass: "unique_title",
    confidence: 0.9,
  });
  const second = conceptFromAnchor({
    sourceForm: "Archon",
    target: "执政官",
    mode: "stable",
    semanticClass: "unique_title",
    confidence: 0.9,
  });
  const confidenceRevision = reviseConcept(first, { confidence: 0.95 });

  assert.deepEqual(first, second);
  assert.equal(confidenceRevision.conceptId, first.conceptId);
  assert.notEqual(confidenceRevision.revisionId, first.revisionId);
  assert.equal(confidenceRevision.renderFingerprint, first.renderFingerprint);
});

test("lexical concept canonicalizes allowed realizations without losing the canonical target", () => {
  const concept = conceptFromAnchor({
    sourceForm: "Archon",
    target: "执政官",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.9,
    allowedRealizations: ["阁下", "执政官", "阁下"],
  });

  assert.deepEqual(concept.allowedRealizations, ["执政官", "阁下"]);
  assert.equal(concept.visibility, "translator_global");
});

test("ordinary words and arbitrary semantic kinds cannot become lexical concepts", () => {
  assert.throws(
    () => conceptFromAnchor({
      sourceForm: "night",
      target: "夜晚",
      mode: "contextual",
      semanticClass: "ordinary_word" as never,
      confidence: 0.99,
    }),
    /semantic class/u,
  );
  assert.throws(
    () => conceptFromAnchor({
      sourceForm: "Corpse",
      target: "尸体",
      mode: "stable",
      semanticClass: "plot_device" as never,
      confidence: 0.99,
    }),
    /semantic class/u,
  );
});

test("lexical concept rejects malformed surface policy inputs", () => {
  assert.throws(
    () => conceptFromAnchor({
      sourceForm: "Prokurist",
      target: "",
      mode: "contextual",
      semanticClass: "role",
      confidence: 0.95,
    }),
    /target/u,
  );
  assert.throws(
    () => conceptFromAnchor({
      sourceForm: "Prokurist",
      target: "主事",
      mode: "contextual",
      semanticClass: "role",
      confidence: Number.NaN,
    }),
    /confidence/u,
  );
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });
  assert.throws(
    () => reviseConcept(concept, {
      visibility: "private_reasoning" as never,
    }),
    /visibility/u,
  );
});
