import { createHash } from "node:crypto";

import type { JsonValue } from "../knowledge/knowledge-authority.js";
import type {
  KnowledgeObjectType,
} from "../knowledge/knowledge-commands.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import type {
  NormalizedImportRecord,
} from "./record-normalizer.js";
import type {
  ImportConflictDecision,
  ImportDiagnostic,
  ImportPreviewRow,
} from "./types.js";

export interface ExistingImportKnowledge {
  readonly id: string;
  readonly objectType: KnowledgeObjectType;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly payload: JsonValue;
}

export interface ImportClassificationOptions {
  /**
   * Near matches are deliberately informational only. They must never make an
   * otherwise new object merge automatically.
   */
  readonly similarSubjects?: readonly string[];
  readonly missingReferences?: readonly string[];
  readonly skipped?: boolean;
}

export interface ImportClassification {
  readonly state: ImportPreviewRow["state"];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly allowedDecisions: readonly ImportConflictDecision["action"][];
  readonly unresolved: boolean;
  readonly conflictSignature?: string;
}

const ADDITIVE_ARRAY_FIELDS = new Set([
  "aliases",
  "alternatives",
  "contexts",
  "entities",
  "pronouns",
  "sourceForms",
  "timeline",
]);

function diagnostic(
  code: string,
  message: string,
  record: NormalizedImportRecord,
  field?: string,
): ImportDiagnostic {
  return Object.freeze({
    code,
    message,
    location: record.location,
    ...(field === undefined ? {} : { field }),
  });
}

function decisionsFor(
  objectType: KnowledgeObjectType,
): readonly ImportConflictDecision["action"][] {
  const decisions: ImportConflictDecision["action"][] = [
    "keep_existing",
    "use_imported",
  ];
  if (objectType === "term" || objectType === "entity" || objectType === "alias") {
    decisions.push("merge_as_alias");
  }
  if (objectType !== "style") decisions.push("create_separate");
  decisions.push("skip");
  return Object.freeze(decisions);
}

function signature(
  record: NormalizedImportRecord,
  codes: readonly string[],
  fields: readonly string[],
): string {
  return createHash("sha256").update(canonicalJson({
    objectType: record.command.objectType,
    normalizedSubject: identityText(record.command.normalizedSubject),
    kind: identityText(record.command.kind),
    codes: [...codes].sort(),
    fields: [...fields].sort(),
  })).digest("hex");
}

function invalid(
  record: NormalizedImportRecord,
  diagnostics: readonly ImportDiagnostic[],
): ImportClassification {
  return Object.freeze({
    state: "invalid",
    diagnostics: Object.freeze([...diagnostics]),
    allowedDecisions: Object.freeze(["skip"] as const),
    unresolved: true,
    conflictSignature: signature(
      record,
      diagnostics.map((item) => item.code),
      diagnostics.flatMap((item) => item.field === undefined ? [] : [item.field]),
    ),
  });
}

function payloadRecord(
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}

function identityText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function additiveArrayCompatible(
  field: string,
  existing: JsonValue,
  incoming: JsonValue,
): boolean {
  if (!ADDITIVE_ARRAY_FIELDS.has(field)
    || !Array.isArray(existing)
    || !Array.isArray(incoming)) {
    return false;
  }
  return true;
}

function missingMemoryPosition(
  record: NormalizedImportRecord,
  existing: ExistingImportKnowledge | undefined,
): boolean {
  if (record.command.objectType !== "memory") return false;
  const patch = record.command.fieldPatch;
  if (typeof patch.startBlockId === "string"
    || typeof patch.endBlockId === "string") {
    return false;
  }
  const current = existing === undefined
    ? undefined
    : payloadRecord(existing.payload);
  return typeof current?.startBlockId !== "string"
    && typeof current?.endBlockId !== "string";
}

export function classifyImport(
  existing: ExistingImportKnowledge | undefined,
  incoming: NormalizedImportRecord,
  options: ImportClassificationOptions = {},
): ImportClassification {
  if (options.skipped === true) {
    return Object.freeze({
      state: "skipped",
      diagnostics: Object.freeze([]),
      allowedDecisions: Object.freeze([]),
      unresolved: false,
    });
  }
  if (incoming.diagnostics.length > 0) {
    return invalid(incoming, incoming.diagnostics);
  }
  if (missingMemoryPosition(incoming, existing)) {
    return invalid(incoming, [
      diagnostic(
        "KNOWLEDGE_IMPORT_MEMORY_POSITION_REQUIRED",
        "narrative memory requires a start or end block",
        incoming,
      ),
    ]);
  }
  const missingReferences = [...new Set(options.missingReferences ?? [])]
    .map((item) => item.normalize("NFKC").trim())
    .filter((item) => item.length > 0)
    .sort();
  if (missingReferences.length > 0) {
    return invalid(incoming, missingReferences.map((reference) =>
      diagnostic(
        "KNOWLEDGE_IMPORT_REFERENCE_MISSING",
        `referenced object ${reference} does not exist`,
        incoming,
      )));
  }
  if (existing === undefined) {
    const hints = [...new Set(options.similarSubjects ?? [])]
      .map((item) => item.normalize("NFKC").trim())
      .filter((item) => item.length > 0
        && identityText(item) !== identityText(incoming.command.normalizedSubject))
      .sort()
      .map((subject) => diagnostic(
        "KNOWLEDGE_IMPORT_SIMILAR_SUBJECT_HINT",
        `possible related subject: ${subject}`,
        incoming,
      ));
    return Object.freeze({
      state: "ready",
      diagnostics: Object.freeze(hints),
      allowedDecisions: Object.freeze([]),
      unresolved: false,
    });
  }
  const exactIdentity = existing.objectType === incoming.command.objectType
    && identityText(existing.normalizedSubject)
      === identityText(incoming.command.normalizedSubject)
    && identityText(existing.kind) === identityText(incoming.command.kind);
  if (!exactIdentity) {
    const diagnostics = Object.freeze([
      diagnostic(
        "KNOWLEDGE_IMPORT_IDENTITY_UNCERTAIN",
        "the candidate does not have an exact subject, kind, and object type match",
        incoming,
      ),
    ]);
    return Object.freeze({
      state: "conflict",
      diagnostics,
      allowedDecisions: decisionsFor(incoming.command.objectType),
      unresolved: true,
      conflictSignature: signature(
        incoming,
        diagnostics.map((item) => item.code),
        [],
      ),
    });
  }
  const current = payloadRecord(existing.payload);
  if (current === undefined) {
    const diagnostics = Object.freeze([
      diagnostic(
        "KNOWLEDGE_IMPORT_EXISTING_PAYLOAD_INVALID",
        "the existing object payload is not a field map",
        incoming,
      ),
    ]);
    return Object.freeze({
      state: "conflict",
      diagnostics,
      allowedDecisions: decisionsFor(incoming.command.objectType),
      unresolved: true,
      conflictSignature: signature(
        incoming,
        diagnostics.map((item) => item.code),
        [],
      ),
    });
  }
  const conflicts: string[] = [];
  for (const [field, value] of Object.entries(incoming.command.fieldPatch)) {
    const previous = current[field];
    if (previous === undefined
      || sameJson(previous, value)
      || additiveArrayCompatible(field, previous, value)) {
      continue;
    }
    conflicts.push(field);
  }
  if (conflicts.length === 0) {
    return Object.freeze({
      state: "merge",
      diagnostics: Object.freeze([]),
      allowedDecisions: Object.freeze([]),
      unresolved: false,
    });
  }
  conflicts.sort();
  const diagnostics = Object.freeze(conflicts.map((field) =>
    diagnostic(
      "KNOWLEDGE_IMPORT_OWNED_FIELD_CONFLICT",
      `field ${field} has a different active value`,
      incoming,
      field,
    )));
  return Object.freeze({
    state: "conflict",
    diagnostics,
    allowedDecisions: decisionsFor(incoming.command.objectType),
    unresolved: true,
    conflictSignature: signature(
      incoming,
      diagnostics.map((item) => item.code),
      conflicts,
    ),
  });
}
