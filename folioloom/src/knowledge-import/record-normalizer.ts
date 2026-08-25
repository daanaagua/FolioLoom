import { createHash } from "node:crypto";

import type { JsonValue } from "../knowledge/knowledge-authority.js";
import {
  validateKnowledgeCommand,
  type KnowledgeObjectType,
  type UpdateKnowledgeCommand,
} from "../knowledge/knowledge-commands.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { knowledgeImportFields } from "./field-mapping.js";
import type {
  ImportDiagnostic,
  ImportFieldMapping,
  ImportRecordSource,
  ImportSelection,
} from "./types.js";

type ValueShape = "text" | "list" | "boolean" | "number";

interface NormalizedFieldDefinition {
  readonly patchFields: readonly string[];
  readonly shape: ValueShape;
  readonly subject?: boolean;
  readonly required?: boolean;
}

const NORMALIZED_FIELDS: Readonly<Record<
  KnowledgeObjectType,
  Readonly<Record<string, NormalizedFieldDefinition>>
>> = {
  term: {
    source: {
      patchFields: ["sourceForm", "canonicalSource"],
      shape: "text",
      subject: true,
      required: true,
    },
    sourceForms: { patchFields: ["sourceForms"], shape: "list" },
    target: { patchFields: ["target"], shape: "text", required: true },
    alternatives: { patchFields: ["alternatives"], shape: "list" },
    policy: { patchFields: ["policy"], shape: "text" },
    note: { patchFields: ["note"], shape: "text" },
    locked: { patchFields: ["locked"], shape: "boolean" },
    contexts: { patchFields: ["contexts"], shape: "list" },
    register: { patchFields: ["register"], shape: "text" },
  },
  entity: {
    canonicalName: {
      patchFields: ["canonicalName"],
      shape: "text",
      subject: true,
      required: true,
    },
    targetName: { patchFields: ["targetName"], shape: "text" },
    entityType: { patchFields: ["entityType"], shape: "text" },
    description: { patchFields: ["description"], shape: "text" },
    aliases: { patchFields: ["aliases"], shape: "list" },
    gender: { patchFields: ["gender"], shape: "text" },
    pronouns: { patchFields: ["pronouns"], shape: "list" },
    note: { patchFields: ["note"], shape: "text" },
  },
  alias: {
    alias: {
      patchFields: ["alias"],
      shape: "text",
      subject: true,
      required: true,
    },
    entityId: { patchFields: ["entityId"], shape: "text", required: true },
    context: { patchFields: ["context"], shape: "text" },
    note: { patchFields: ["note"], shape: "text" },
  },
  relation: {
    fromEntityId: {
      patchFields: ["fromEntityId"],
      shape: "text",
      required: true,
    },
    relationType: {
      patchFields: ["relationType"],
      shape: "text",
      required: true,
    },
    toEntityId: {
      patchFields: ["toEntityId"],
      shape: "text",
      required: true,
    },
    position: { patchFields: ["position"], shape: "number" },
    note: { patchFields: ["note"], shape: "text" },
  },
  memory: {
    summary: {
      patchFields: ["summary"],
      shape: "text",
      subject: true,
      required: true,
    },
    startBlockId: { patchFields: ["startBlockId"], shape: "text" },
    endBlockId: { patchFields: ["endBlockId"], shape: "text" },
    entities: { patchFields: ["entities"], shape: "list" },
    timeline: { patchFields: ["timeline"], shape: "list" },
    note: { patchFields: ["note"], shape: "text" },
  },
  style: {
    register: { patchFields: ["register"], shape: "text" },
    sentencePolicy: { patchFields: ["sentencePolicy"], shape: "text" },
    explicitation: { patchFields: ["explicitation"], shape: "text" },
    imagery: { patchFields: ["imagery"], shape: "text" },
    dialogue: { patchFields: ["dialogue"], shape: "text" },
    technicalProse: { patchFields: ["technicalProse"], shape: "text" },
    typography: { patchFields: ["typography"], shape: "text" },
    narratorVoice: { patchFields: ["narratorVoice"], shape: "text" },
    additionalInstruction: { patchFields: ["additionalInstruction"], shape: "text" },
    narrativeDistance: { patchFields: ["narrativeDistance"], shape: "text" },
    dialogueRegister: { patchFields: ["dialogueRegister"], shape: "text" },
  },
};

const KIND_BY_OBJECT_TYPE: Readonly<Record<KnowledgeObjectType, string>> = {
  term: "lexical_anchor",
  entity: "entity_identity",
  alias: "entity_alias_link",
  relation: "entity_relation",
  memory: "narrative_memory",
  style: "style_directive",
};

export interface NormalizeImportRecordInput {
  readonly record: ImportRecordSource;
  readonly selection: ImportSelection;
  readonly fields: Readonly<Record<string, ImportFieldMapping | undefined>>;
  readonly importBatchId: string;
  readonly expectedRevision?: number | null;
  readonly expectedScopeRevision?: {
    readonly scope: "book" | "project";
    readonly revision: number;
  } | null;
}

export interface NormalizedImportRecord {
  readonly ordinal: number;
  readonly location: string;
  readonly command: UpdateKnowledgeCommand;
  readonly canonicalHash: string;
  readonly diagnostics: readonly ImportDiagnostic[];
}

export class KnowledgeImportMappingError extends TypeError {
  readonly code: string;
  readonly location: string;
  readonly field?: string;

  constructor(code: string, message: string, location: string, field?: string) {
    super(`${code}: ${message} at ${location}`);
    this.name = "KnowledgeImportMappingError";
    this.code = code;
    this.location = location;
    if (field !== undefined) this.field = field;
  }
}

function fail(
  code: string,
  message: string,
  location: string,
  field?: string,
): never {
  throw new KnowledgeImportMappingError(code, message, location, field);
}

function cleanText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "string" ? value : String(value);
  const normalized = text.normalize("NFKC").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function listValue(
  value: unknown,
  mapping: ImportFieldMapping,
  location: string,
  field: string,
): readonly string[] | undefined {
  const rawItems = Array.isArray(value)
    ? value
    : mapping.separator !== undefined && typeof value === "string"
      ? value.split(mapping.separator)
      : [value];
  const items = rawItems.map((item) => {
    if (item !== null && typeof item === "object") {
      fail(
        "KNOWLEDGE_IMPORT_FIELD_TYPE_INVALID",
        "array fields accept only scalar items",
        location,
        field,
      );
    }
    return cleanText(item);
  }).filter((item): item is string => item !== undefined);
  return items.length === 0 ? undefined : Object.freeze(items);
}

function booleanValue(
  value: unknown,
  location: string,
  field: string,
): boolean | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = cleanText(value)?.toLocaleLowerCase("und");
  if (normalized === "true" || normalized === "yes" || normalized === "1" || normalized === "是") {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "0" || normalized === "否") {
    return false;
  }
  fail(
    "KNOWLEDGE_IMPORT_FIELD_TYPE_INVALID",
    "boolean field must be true or false",
    location,
    field,
  );
}

function normalizedValue(
  value: unknown,
  definition: NormalizedFieldDefinition,
  mapping: ImportFieldMapping,
  location: string,
  field: string,
): JsonValue | undefined {
  if (value === null && mapping.nullMeansDelete === true) {
    fail(
      "KNOWLEDGE_IMPORT_DELETE_UNSUPPORTED",
      "field deletion requires a dedicated rollback command",
      location,
      field,
    );
  }
  if (definition.shape === "list") {
    return listValue(value, mapping, location, field);
  }
  if (definition.shape === "boolean") {
    return booleanValue(value, location, field);
  }
  if (definition.shape === "number") {
    if (value === null || value === undefined || value === "") return undefined;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail("KNOWLEDGE_IMPORT_FIELD_TYPE_INVALID", "number must be finite", location, field);
      }
      return value;
    }
    return cleanText(value);
  }
  return cleanText(value);
}

function pointer(field: string): string {
  return `/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function relationSubject(fieldPatch: Readonly<Record<string, JsonValue>>): string {
  return [
    fieldPatch.fromEntityId,
    fieldPatch.relationType,
    fieldPatch.toEntityId,
  ].join(" → ");
}

function subjectFor(
  objectType: KnowledgeObjectType,
  mappedSubjects: readonly string[],
  fieldPatch: Readonly<Record<string, JsonValue>>,
): string {
  if (objectType === "relation") return relationSubject(fieldPatch);
  if (objectType === "style") return "style";
  const subject = mappedSubjects[0];
  if (subject === undefined) {
    throw new Error(`KNOWLEDGE_IMPORT_REQUIRED_FIELD_EMPTY: ${objectType} subject is empty`);
  }
  return subject;
}

function completeTermPolicy(
  fieldPatch: Record<string, JsonValue>,
  location: string,
): void {
  const explicitPolicy = fieldPatch.policy;
  const explicitLocked = fieldPatch.locked;
  if (explicitPolicy === undefined && explicitLocked === undefined) {
    fieldPatch.policy = "preferred";
    fieldPatch.locked = false;
    return;
  }
  if (explicitPolicy === undefined && typeof explicitLocked === "boolean") {
    fieldPatch.policy = explicitLocked ? "locked" : "preferred";
    return;
  }
  if (typeof explicitPolicy === "string" && explicitLocked === undefined) {
    fieldPatch.locked = explicitPolicy === "locked";
    return;
  }
  if (explicitLocked === true && explicitPolicy !== "locked") {
    fail(
      "KNOWLEDGE_IMPORT_TERM_POLICY_CONFLICT",
      "term.locked=true requires policy=locked",
      location,
      "locked",
    );
  }
  if (explicitPolicy === "locked" && explicitLocked !== true) {
    fail(
      "KNOWLEDGE_IMPORT_TERM_POLICY_CONFLICT",
      "term.policy=locked requires locked=true",
      location,
      "policy",
    );
  }
}

export function normalizeImportRecord(
  input: NormalizeImportRecordInput,
): NormalizedImportRecord {
  if (input.selection.scope === ("global" as ImportSelection["scope"])) {
    fail(
      "GLOBAL_IMPORT_REQUIRES_LIBRARY_CONFIRMATION",
      "global knowledge must use the dedicated library promotion flow",
      input.record.location,
    );
  }
  const definitions = NORMALIZED_FIELDS[input.selection.objectType];
  const allowed = new Set(knowledgeImportFields(input.selection.objectType));
  const fieldPatch: Record<string, JsonValue> = {};
  const mappedSubjects: string[] = [];
  const mappedTargets = new Set<string>();
  for (const [field, mapping] of Object.entries(input.fields)) {
    if (!allowed.has(field) || definitions[field] === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_MAPPING_FIELD_UNKNOWN",
        `unknown target field ${field}`,
        input.record.location,
        field,
      );
    }
    if (mapping === undefined) continue;
    if (mapping.targetField !== field) {
      fail(
        "KNOWLEDGE_IMPORT_MAPPING_FIELD_MISMATCH",
        `mapping target ${mapping.targetField} does not match ${field}`,
        input.record.location,
        field,
      );
    }
    if (!mapping.confirmed) {
      fail(
        "KNOWLEDGE_IMPORT_MAPPING_UNCONFIRMED",
        "medium-confidence mappings require explicit confirmation",
        input.record.location,
        field,
      );
    }
    if (mapping.sourceColumn.trim().length === 0
      || !Object.hasOwn(input.record.values, mapping.sourceColumn)) {
      fail(
        "KNOWLEDGE_IMPORT_SOURCE_COLUMN_UNKNOWN",
        `source column ${mapping.sourceColumn} is missing`,
        input.record.location,
        field,
      );
    }
    const definition = definitions[field] as NormalizedFieldDefinition;
    const value = normalizedValue(
      input.record.values[mapping.sourceColumn],
      definition,
      mapping,
      input.record.location,
      field,
    );
    if (value === undefined) continue;
    for (const patchField of definition.patchFields) {
      if (mappedTargets.has(patchField)) {
        fail(
          "KNOWLEDGE_IMPORT_MAPPING_COLLISION",
          `multiple mappings write ${patchField}`,
          input.record.location,
          field,
        );
      }
      mappedTargets.add(patchField);
      fieldPatch[patchField] = value;
    }
    if (definition.subject === true && typeof value === "string") {
      mappedSubjects.push(value);
    }
  }
  for (const [field, definition] of Object.entries(definitions)) {
    if (definition.required !== true) continue;
    if (!definition.patchFields.some((patchField) => Object.hasOwn(fieldPatch, patchField))) {
      fail(
        "KNOWLEDGE_IMPORT_REQUIRED_FIELD_EMPTY",
        `required field ${field} is empty`,
        input.record.location,
        field,
      );
    }
  }
  if (input.selection.objectType === "term") {
    completeTermPolicy(fieldPatch, input.record.location);
  }
  if (Object.keys(fieldPatch).length === 0) {
    fail(
      "KNOWLEDGE_IMPORT_REQUIRED_FIELD_EMPTY",
      "record does not contain any mapped knowledge",
      input.record.location,
    );
  }
  const command = validateKnowledgeCommand({
    type: "upsert",
    objectType: input.selection.objectType,
    normalizedSubject: subjectFor(
      input.selection.objectType,
      mappedSubjects,
      fieldPatch,
    ),
    kind: KIND_BY_OBJECT_TYPE[input.selection.objectType],
    expectedRevision: input.expectedRevision ?? null,
    expectedScopeRevision: input.expectedScopeRevision ?? null,
    fieldPatch,
    ownedFields: Object.keys(fieldPatch).sort().map(pointer),
    scope: input.selection.scope,
    evidence: [],
    origin: "import",
    importBatchId: input.importBatchId,
  });
  if (command.type !== "upsert") {
    throw new Error("normalized import record did not produce an update command");
  }
  return Object.freeze({
    ordinal: input.record.ordinal,
    location: input.record.location,
    command,
    canonicalHash: createHash("sha256")
      .update(canonicalJson(command))
      .digest("hex"),
    diagnostics: Object.freeze([]),
  });
}
