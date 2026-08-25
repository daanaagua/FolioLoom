import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyImport,
  type ExistingImportKnowledge,
} from "../src/knowledge-import/conflict-classifier.js";
import type {
  ImportDiagnostic,
} from "../src/knowledge-import/types.js";
import type {
  NormalizedImportRecord,
} from "../src/knowledge-import/record-normalizer.js";
import type {
  KnowledgeObjectType,
  UpdateKnowledgeCommand,
} from "../src/knowledge/knowledge-commands.js";

function incoming(
  objectType: KnowledgeObjectType,
  normalizedSubject: string,
  fieldPatch: UpdateKnowledgeCommand["fieldPatch"],
  diagnostics: readonly ImportDiagnostic[] = [],
): NormalizedImportRecord {
  const kind = {
    term: "lexical_anchor",
    entity: "entity_identity",
    alias: "entity_alias_link",
    relation: "entity_relation",
    memory: "narrative_memory",
    style: "style_directive",
  }[objectType];
  return {
    ordinal: 1,
    location: "row 2",
    canonicalHash: "incoming-hash",
    diagnostics,
    command: {
      type: "upsert",
      objectType,
      normalizedSubject,
      kind,
      expectedRevision: null,
      expectedScopeRevision: null,
      fieldPatch,
      ownedFields: Object.keys(fieldPatch).sort().map((field) => `/${field}`),
      scope: "book",
      evidence: [],
      origin: "import",
      importBatchId: "batch-1",
    },
  };
}

function existing(
  record: NormalizedImportRecord,
  payload: ExistingImportKnowledge["payload"] = record.command.fieldPatch,
): ExistingImportKnowledge {
  return {
    id: "knowledge-1",
    objectType: record.command.objectType,
    normalizedSubject: record.command.normalizedSubject,
    kind: record.command.kind,
    payload,
  };
}

test("classifies new, additive and conflicting records deterministically", () => {
  const fresh = incoming("term", "Archon", {
    sourceForm: "Archon",
    target: "执政官",
  });
  assert.equal(classifyImport(undefined, fresh).state, "ready");

  const additive = incoming("term", "Archon", {
    sourceForm: "Archon",
    target: "执政官",
    sourceForms: ["Archon", "archon"],
  });
  assert.equal(classifyImport({
    ...existing(fresh, {
    sourceForm: "Archon",
    target: "执政官",
    sourceForms: ["Archon"],
    }),
    normalizedSubject: "  archon  ",
  }, additive).state, "merge");

  const conflict = incoming("term", "Archon", {
    sourceForm: "Archon",
    target: "阁下",
  });
  const first = classifyImport(existing(fresh), conflict);
  const reorderedExisting = existing(fresh, {
    target: "执政官",
    sourceForm: "Archon",
  });
  const second = classifyImport(reorderedExisting, conflict);
  assert.equal(first.state, "conflict");
  assert.equal(second.state, "conflict");
  assert.equal(first.conflictSignature, second.conflictSignature);
  assert.deepEqual(first.allowedDecisions, [
    "keep_existing",
    "use_imported",
    "merge_as_alias",
    "create_separate",
    "skip",
  ]);
  assert.match(first.diagnostics[0]?.code ?? "", /OWNED_FIELD_CONFLICT/u);
});

test("never merges merely similar subjects without an exact identity match", () => {
  const record = incoming("entity", "Piaton", {
    canonicalName: "Piaton",
    targetName: "皮亚顿",
  });
  assert.equal(classifyImport(undefined, record, {
    similarSubjects: ["Piaton the slave", "Piaton?"],
  }).state, "ready");
  assert.equal(classifyImport(undefined, record, {
    similarSubjects: ["Piaton the slave"],
  }).diagnostics[0]?.code, "KNOWLEDGE_IMPORT_SIMILAR_SUBJECT_HINT");

  const uncertain = classifyImport({
    ...existing(record),
    normalizedSubject: "Piaton the slave",
  }, record);
  assert.equal(uncertain.state, "conflict");
  assert.match(uncertain.diagnostics[0]?.code ?? "", /IDENTITY_UNCERTAIN/u);
});

test("marks schema diagnostics, dangling references and unpositioned memories invalid", () => {
  const diagnostic: ImportDiagnostic = {
    code: "KNOWLEDGE_IMPORT_FIELD_TYPE_INVALID",
    message: "field has the wrong type",
    location: "row 2",
    field: "target",
  };
  const malformed = incoming("term", "Archon", {
    sourceForm: "Archon",
    target: "执政官",
  }, [diagnostic]);
  assert.equal(classifyImport(undefined, malformed).state, "invalid");

  const relation = incoming("relation", "Typhon → controls → Piaton", {
    fromEntityId: "Typhon",
    relationType: "controls",
    toEntityId: "Piaton",
  });
  const dangling = classifyImport(undefined, relation, {
    missingReferences: ["Piaton"],
  });
  assert.equal(dangling.state, "invalid");
  assert.match(dangling.diagnostics[0]?.code ?? "", /REFERENCE_MISSING/u);

  const memory = incoming("memory", "Typhon awakens", {
    summary: "Typhon awakens in the mountain.",
  });
  const unpositioned = classifyImport(undefined, memory);
  assert.equal(unpositioned.state, "invalid");
  assert.match(unpositioned.diagnostics[0]?.code ?? "", /MEMORY_POSITION_REQUIRED/u);

  const positionedExisting = existing(memory, {
    summary: "Typhon awakens in the mountain.",
    startBlockId: "block-120",
  });
  assert.equal(classifyImport(positionedExisting, memory).state, "merge");
});

test("represents an explicit skip without leaving an unresolved conflict", () => {
  const record = incoming("term", "Archon", {
    sourceForm: "Archon",
    target: "执政官",
  });
  const result = classifyImport(existing(record), record, { skipped: true });
  assert.equal(result.state, "skipped");
  assert.deepEqual(result.allowedDecisions, []);
  assert.equal(result.unresolved, false);
});
