import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  chooseEffectiveField,
  compareAuthority,
  mergeCandidateWithAuthority,
  type KnowledgeAuthority,
  type KnowledgeOrigin,
  type KnowledgeScope,
} from "../src/knowledge/knowledge-authority.js";
import {
  canonicalJson,
  KnowledgeStore,
} from "../src/knowledge/knowledge-store.js";

function authority(
  origin: KnowledgeOrigin,
  scope: KnowledgeScope,
  ownedFields: readonly string[] = [],
): KnowledgeAuthority {
  return { origin, scope, ownedFields };
}

function field(
  origin: KnowledgeOrigin,
  scope: KnowledgeScope,
  value: unknown,
) {
  return { authority: authority(origin, scope), value };
}

test("keeps legacy revision hashes when authority is absent", () => {
  const legacy = new KnowledgeStore();
  const revision = legacy.appendRevision({
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "执政官" },
    status: "active",
  });
  const expected = createHash("sha256").update(canonicalJson({
    revision: 1,
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "执政官" },
    alternatives: [{ target: "执政官" }],
    status: "active",
    candidateIds: [],
    sourceWindowIds: [],
  })).digest("hex");
  assert.equal(revision.revisionId, expected);
  assert.equal(revision.authority, undefined);
});

test("a manual owned target survives later model candidates", () => {
  const store = new KnowledgeStore();
  store.appendRevision({
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "阁下", note: "direct address" },
    status: "active",
    authority: {
      origin: "manual",
      scope: "book",
      ownedFields: ["/target"],
    },
  });
  const [next] = store.reconcileCandidates([{
    recordId: "candidate-1",
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "执政官", note: "title" },
  }], "window-2");

  assert.equal((next?.payload as { target: string }).target, "阁下");
  assert.equal((next?.payload as { note: string }).note, "title");
  assert.equal(next?.status, "active");
  assert.deepEqual(next?.authority, {
    origin: "manual",
    scope: "book",
    ownedFields: ["/target"],
  });
});

test("resolves authority by scope and origin and exposes same-rank conflicts", () => {
  assert.equal(compareAuthority(
    authority("manual", "book"),
    authority("manual", "global"),
  ), 1);
  assert.equal(compareAuthority(
    authority("manual", "book"),
    authority("import", "book"),
  ), 1);
  assert.equal(compareAuthority(
    authority("rollback", "project"),
    authority("manual", "project"),
  ), 0);
  assert.equal(
    chooseEffectiveField([
      field("manual", "global", "全局值"),
      field("model", "book", "书内模型值"),
    ]),
    "书内模型值",
  );
  assert.throws(
    () => chooseEffectiveField([
      field("manual", "book", "执政官"),
      field("manual", "book", "阁下"),
    ]),
    /KNOWLEDGE_AUTHORITY_CONFLICT/u,
  );
});

test("accepts only safe RFC 6901 root fields and pure JSON values", () => {
  assert.deepEqual(
    mergeCandidateWithAuthority(
      { "display/name": "阁下", note: "manual" },
      { "display/name": "执政官", note: "model" },
      authority("manual", "book", ["/display~1name"]),
    ),
    { "display/name": "阁下", note: "model" },
  );

  for (const ownedField of [
    "",
    "/nested/value",
    "/0",
    "/__proto__",
    "/prototype",
    "/constructor",
    "/bad~escape",
  ]) {
    assert.throws(
      () => mergeCandidateWithAuthority(
        { target: "阁下" },
        { target: "执政官" },
        authority("manual", "book", [ownedField]),
      ),
      /owned field|JSON Pointer/i,
    );
  }
  assert.throws(
    () => mergeCandidateWithAuthority(
      { target: undefined },
      { target: "执政官" },
      authority("manual", "book", ["/target"]),
    ),
    /JSON/i,
  );
});
