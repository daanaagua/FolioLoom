import assert from "node:assert/strict";
import test from "node:test";

import {
  mappingIdentity,
  suggestMapping,
} from "../src/knowledge-import/field-mapping.js";
import {
  normalizeImportRecord,
} from "../src/knowledge-import/record-normalizer.js";
import type {
  ImportFieldMapping,
  ImportRecordSource,
  ImportSelection,
  KnowledgeImportFormat,
} from "../src/knowledge-import/types.js";
import type { KnowledgeObjectType } from "../src/knowledge/knowledge-commands.js";

function selection(
  objectType: KnowledgeObjectType,
  overrides: Partial<ImportSelection> = {},
): ImportSelection {
  return {
    objectType,
    scope: "book",
    recordPathId: "record-path:1",
    ...overrides,
  };
}

function mapping(
  targetField: string,
  sourceColumn: string,
  overrides: Partial<ImportFieldMapping> = {},
): ImportFieldMapping {
  return {
    targetField,
    sourceColumn,
    confidence: "high",
    confirmed: true,
    ...overrides,
  };
}

function record(
  values: ImportRecordSource["values"],
  ordinal = 1,
): ImportRecordSource {
  return {
    ordinal,
    location: `row ${ordinal + 1}`,
    values,
  };
}

test("suggests multilingual source and target without auto-accepting an ambiguous note", () => {
  const result = suggestMapping({
    objectType: "term",
    columns: ["原文", "译名", "说明"],
  });
  assert.deepEqual(result.fields.source, {
    targetField: "source",
    sourceColumn: "原文",
    confidence: "high",
    confirmed: true,
  });
  assert.deepEqual(result.fields.target, {
    targetField: "target",
    sourceColumn: "译名",
    confidence: "high",
    confirmed: true,
  });
  assert.equal(result.fields.note?.sourceColumn, "说明");
  assert.equal(result.fields.note?.confidence, "medium");
  assert.equal(result.fields.note?.confirmed, false);
  assert.match(result.reasons.source?.join(" ") ?? "", /exact alias/iu);
});

test("leaves low-confidence fields unmapped and explains collisions", () => {
  const low = suggestMapping({
    objectType: "entity",
    columns: ["A", "B", "C"],
  });
  assert.equal(low.fields.canonicalName, undefined);

  const collision = suggestMapping({
    objectType: "term",
    columns: ["source", "original", "target"],
  });
  assert.equal(collision.fields.source?.confirmed, false);
  assert.notEqual(collision.fields.source?.confidence, "high");
  assert.match(collision.reasons.source?.join(" ") ?? "", /collision|ambiguous/iu);
});

test("uses explicit confirmed mappings and normalizes a term command", () => {
  const normalized = normalizeImportRecord({
    record: record({
      src: " Archon ",
      dst: "执政官",
      forms: "archon|Archon",
      note: "formal title, not a personal name",
    }),
    selection: selection("term"),
    fields: {
      source: mapping("source", "src"),
      target: mapping("target", "dst"),
      sourceForms: mapping("sourceForms", "forms", { separator: "|" }),
      note: mapping("note", "note"),
    },
    importBatchId: "batch-1",
  });

  assert.equal(normalized.command.objectType, "term");
  assert.equal(normalized.command.normalizedSubject, "Archon");
  assert.deepEqual({ ...normalized.command.fieldPatch }, {
    sourceForm: "Archon",
    canonicalSource: "Archon",
    target: "执政官",
    sourceForms: ["archon", "Archon"],
    note: "formal title, not a personal name",
    policy: "preferred",
    locked: false,
  });
  assert.deepEqual(normalized.command.ownedFields, [
    "/canonicalSource",
    "/locked",
    "/note",
    "/policy",
    "/sourceForm",
    "/sourceForms",
    "/target",
  ]);
  assert.equal(normalized.command.origin, "import");
  assert.equal(normalized.command.importBatchId, "batch-1");
  assert.match(normalized.canonicalHash, /^[\da-f]{64}$/u);
});

test("normalizes all six object types through command validation", () => {
  const cases: readonly {
    objectType: KnowledgeObjectType;
    values: ImportRecordSource["values"];
    fields: Readonly<Record<string, ImportFieldMapping>>;
    requiredPatch: string;
  }[] = [
    {
      objectType: "term",
      values: { source: "archon", target: "执政官" },
      fields: {
        source: mapping("source", "source"),
        target: mapping("target", "target"),
      },
      requiredPatch: "target",
    },
    {
      objectType: "entity",
      values: { name: "Piaton", aliases: ["the slave", "second head"] },
      fields: {
        canonicalName: mapping("canonicalName", "name"),
        aliases: mapping("aliases", "aliases"),
      },
      requiredPatch: "canonicalName",
    },
    {
      objectType: "alias",
      values: { alias: "the slave", entity: "Piaton" },
      fields: {
        alias: mapping("alias", "alias"),
        entityId: mapping("entityId", "entity"),
      },
      requiredPatch: "entityId",
    },
    {
      objectType: "relation",
      values: { from: "Piaton", relation: "controls", to: "heart" },
      fields: {
        fromEntityId: mapping("fromEntityId", "from"),
        relationType: mapping("relationType", "relation"),
        toEntityId: mapping("toEntityId", "to"),
      },
      requiredPatch: "relationType",
    },
    {
      objectType: "memory",
      values: {
        summary: "Piaton controls the shared body's heartbeat.",
        entities: ["Piaton", "Typhon"],
      },
      fields: {
        summary: mapping("summary", "summary"),
        entities: mapping("entities", "entities"),
      },
      requiredPatch: "summary",
    },
    {
      objectType: "style",
      values: { register: "restrained and formal" },
      fields: {
        register: mapping("register", "register"),
      },
      requiredPatch: "register",
    },
  ];
  const expectedKinds: Readonly<Record<KnowledgeObjectType, string>> = {
    term: "lexical_anchor",
    entity: "entity_identity",
    alias: "entity_alias_link",
    relation: "entity_relation",
    memory: "narrative_memory",
    style: "style_directive",
  };

  for (const [index, item] of cases.entries()) {
    const normalized = normalizeImportRecord({
      record: record(item.values, index + 1),
      selection: selection(item.objectType),
      fields: item.fields,
      importBatchId: "batch-six-types",
    });
    assert.equal(normalized.command.objectType, item.objectType);
    assert.equal(normalized.command.kind, expectedKinds[item.objectType]);
    assert.equal(Object.hasOwn(normalized.command.fieldPatch, item.requiredPatch), true);
  }
});

test("term imports use preferred semantics by default and preserve explicit lock policy", () => {
  const preferred = normalizeImportRecord({
    record: record({ source: "Archon", target: "执政官" }),
    selection: selection("term"),
    fields: {
      source: mapping("source", "source"),
      target: mapping("target", "target"),
    },
    importBatchId: "batch-preferred",
  });
  assert.equal(preferred.command.fieldPatch.policy, "preferred");
  assert.equal(preferred.command.fieldPatch.locked, false);

  const locked = normalizeImportRecord({
    record: record({ source: "Archon", target: "阁下", policy: "locked" }),
    selection: selection("term"),
    fields: {
      source: mapping("source", "source"),
      target: mapping("target", "target"),
      policy: mapping("policy", "policy"),
    },
    importBatchId: "batch-locked",
  });
  assert.equal(locked.command.fieldPatch.policy, "locked");
  assert.equal(locked.command.fieldPatch.locked, true);

  assert.throws(
    () => normalizeImportRecord({
      record: record({
        source: "Archon",
        target: "执政官",
        policy: "contextual",
        locked: true,
      }),
      selection: selection("term"),
      fields: {
        source: mapping("source", "source"),
        target: mapping("target", "target"),
        policy: mapping("policy", "policy"),
        locked: mapping("locked", "locked"),
      },
      importBatchId: "batch-conflicting-policy",
    }),
    /term\.locked=true requires policy=locked/u,
  );
});

test("does not split arrays without an explicit separator", () => {
  const normalized = normalizeImportRecord({
    record: record({
      name: "Piaton",
      aliases: "the slave, second head",
    }),
    selection: selection("entity"),
    fields: {
      canonicalName: mapping("canonicalName", "name"),
      aliases: mapping("aliases", "aliases"),
    },
    importBatchId: "batch-no-implicit-split",
  });
  assert.deepEqual(normalized.command.fieldPatch.aliases, ["the slave, second head"]);
});

test("rejects unknown fields, unconfirmed mappings, and empty required values", () => {
  assert.throws(
    () => normalizeImportRecord({
      record: record({ source: "archon", target: "执政官", sql: "DROP TABLE events" }),
      selection: selection("term"),
      fields: {
        source: mapping("source", "source"),
        target: mapping("target", "target"),
        sql: mapping("sql", "sql"),
      },
      importBatchId: "batch-invalid",
    }),
    /KNOWLEDGE_IMPORT_MAPPING_FIELD_UNKNOWN/u,
  );
  assert.throws(
    () => normalizeImportRecord({
      record: record({ source: "archon", target: "执政官" }),
      selection: selection("term"),
      fields: {
        source: mapping("source", "source"),
        target: mapping("target", "target", {
          confidence: "medium",
          confirmed: false,
        }),
      },
      importBatchId: "batch-unconfirmed",
    }),
    /KNOWLEDGE_IMPORT_MAPPING_UNCONFIRMED/u,
  );
  assert.throws(
    () => normalizeImportRecord({
      record: record({ source: "archon", target: " " }),
      selection: selection("term"),
      fields: {
        source: mapping("source", "source"),
        target: mapping("target", "target"),
      },
      importBatchId: "batch-empty",
    }),
    /KNOWLEDGE_IMPORT_REQUIRED_FIELD_EMPTY/u,
  );
});

test("never routes global scope through normal import commands", () => {
  assert.throws(
    () => normalizeImportRecord({
      record: record({ source: "archon", target: "执政官" }),
      selection: {
        ...selection("term"),
        scope: "global",
      } as unknown as ImportSelection,
      fields: {
        source: mapping("source", "source"),
        target: mapping("target", "target"),
      },
      importBatchId: "batch-global",
    }),
    /GLOBAL_IMPORT_REQUIRES_LIBRARY_CONFIRMATION/u,
  );
});

test("mapping identity includes format, location, encoding, fields, and template version", () => {
  const fields = {
    source: mapping("source", "column:0"),
    target: mapping("target", "column:1"),
  };
  const csvSelection = selection("term", {
    recordPathId: undefined,
    headerRow: 2,
    encoding: "windows-949",
  });
  const base = mappingIdentity("csv", csvSelection, fields, {
    templateVersion: "folioloom-knowledge-import-1",
  });
  assert.equal(base, mappingIdentity("csv", csvSelection, {
    target: fields.target,
    source: fields.source,
  }, {
    templateVersion: "folioloom-knowledge-import-1",
  }));
  const changes: readonly [KnowledgeImportFormat, ImportSelection, string][] = [
    ["json", { ...csvSelection, recordPathId: "$.terms" }, "format/path"],
    ["xlsx", {
      ...csvSelection,
      encoding: undefined,
      sheetId: "sheet:1",
      headerRow: 2,
    }, "sheet"],
    ["csv", { ...csvSelection, headerRow: 3 }, "header"],
    ["csv", { ...csvSelection, encoding: "utf-8" }, "encoding"],
  ];
  for (const [format, changedSelection, label] of changes) {
    assert.notEqual(
      base,
      mappingIdentity(format, changedSelection, fields, {
        templateVersion: "folioloom-knowledge-import-1",
      }),
      label,
    );
  }
  assert.notEqual(
    base,
    mappingIdentity("csv", csvSelection, fields, {
      templateVersion: "folioloom-knowledge-import-2",
    }),
  );
});
