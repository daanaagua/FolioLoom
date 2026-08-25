import assert from "node:assert/strict";
import test from "node:test";

import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";

test("ordinary-word lexical decisions become contextual negative cache", () => {
  const store = new KnowledgeStore();
  const [revision] = store.reconcileCandidates([{
    recordId: "decision-fenster",
    normalizedSubject: "fenster",
    kind: "lexical_anchor_decision",
    payload: {
      sourceForm: "Fenster",
      target: "",
      mode: "contextual",
      semanticClass: "ordinary_word",
      confidence: 0.99,
    },
  }], "window-1");

  assert.equal(revision?.status, "contextual");
});

