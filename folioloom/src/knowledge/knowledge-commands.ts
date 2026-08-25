import { createHash } from "node:crypto";

import {
  normalizeKnowledgeAuthority,
  type JsonValue,
  type KnowledgeAuthority,
  type KnowledgeEvidence,
  type KnowledgeOrigin,
  type KnowledgeScope,
} from "./knowledge-authority.js";
import {
  canonicalClone,
  canonicalJson,
  type KnowledgeRevision,
  type KnowledgeStatus,
} from "./knowledge-store.js";

export type KnowledgeObjectType =
  | "term"
  | "entity"
  | "alias"
  | "relation"
  | "memory"
  | "style";

export interface CatalogKnowledgeDocument {
  readonly objectType: KnowledgeObjectType;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly alternatives: readonly JsonValue[];
  readonly status: KnowledgeStatus;
  readonly authority: KnowledgeAuthority;
  readonly evidence: readonly KnowledgeEvidence[];
  /** Immutable upstream identity when a global revision is snapshotted locally. */
  readonly globalRevisionId?: string;
}

export interface KnowledgeCatalogExpectation {
  readonly scope: KnowledgeScope;
  readonly revision: number;
}

export interface UpdateKnowledgeCommand {
  readonly type: "upsert";
  readonly objectType: KnowledgeObjectType;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly expectedRevision: number | null;
  readonly expectedScopeRevision: KnowledgeCatalogExpectation | null;
  readonly fieldPatch: Readonly<Record<string, JsonValue>>;
  readonly ownedFields: readonly string[];
  readonly scope: KnowledgeScope;
  readonly evidence: readonly KnowledgeEvidence[];
  readonly origin: "manual" | "import";
  readonly importBatchId?: string;
}

export interface RollbackKnowledgeCommand {
  readonly type: "rollback";
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly expectedRevision: number;
  readonly expectedScopeRevision: KnowledgeCatalogExpectation;
  readonly targetRevision: number;
}

export type KnowledgeCommand = UpdateKnowledgeCommand | RollbackKnowledgeCommand;

export interface CommitKnowledgeCommandsRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly commands: readonly KnowledgeCommand[];
}

export interface KnowledgeCommitResult {
  readonly requestId: string;
  readonly generation: number;
  readonly snapshotId: string;
  readonly revisionIds: readonly string[];
  readonly bookGeneration: number;
  readonly projectGeneration: number;
}

export interface KnowledgeStateView {
  readonly generation: number;
  readonly snapshotId: string;
  readonly appliedBookGeneration: number;
  readonly appliedProjectGeneration: number;
}

export interface KnowledgeCommandEventPayload {
  readonly requestId: string;
  readonly requestHash: string;
  readonly result: KnowledgeCommitResult;
}

const OBJECT_TYPES = new Set<KnowledgeObjectType>([
  "term",
  "entity",
  "alias",
  "relation",
  "memory",
  "style",
]);

const SCOPES = new Set<KnowledgeScope>(["book", "project", "global"]);
const COMMAND_ORIGINS = new Set<KnowledgeOrigin>(["manual", "import"]);
const KNOWLEDGE_STATUSES = new Set<KnowledgeStatus>([
  "candidate",
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
  "superseded",
]);

const FIELD_RULES: Readonly<Record<KnowledgeObjectType, {
  readonly allowed: ReadonlySet<string>;
  readonly requiredForNew: ReadonlySet<string>;
}>> = {
  term: {
    allowed: new Set([
      "sourceForm",
      "sourceForms",
      "canonicalSource",
      "subjectForms",
      "normalizedForms",
      "target",
      "alternatives",
      "policy",
      "note",
      "locked",
      "contexts",
      "register",
    ]),
    requiredForNew: new Set(["target"]),
  },
  entity: {
    allowed: new Set([
      "canonicalName",
      "targetName",
      "entityType",
      "description",
      "aliases",
      "gender",
      "pronouns",
      "note",
    ]),
    requiredForNew: new Set(["canonicalName"]),
  },
  alias: {
    allowed: new Set(["alias", "entityId", "context", "note"]),
    requiredForNew: new Set(["alias", "entityId"]),
  },
  relation: {
    allowed: new Set([
      "fromEntityId",
      "relationType",
      "toEntityId",
      "position",
      "note",
    ]),
    requiredForNew: new Set(["fromEntityId", "relationType", "toEntityId"]),
  },
  memory: {
    allowed: new Set([
      "summary",
      "startBlockId",
      "endBlockId",
      "entities",
      "timeline",
      "note",
    ]),
    requiredForNew: new Set(["summary"]),
  },
  style: {
    allowed: new Set([
      "register",
      "sentencePolicy",
      "explicitation",
      "imagery",
      "dialogue",
      "technicalProse",
      "typography",
      "narratorVoice",
      "additionalInstruction",
      "narrativeDistance",
      "dialogueRegister",
    ]),
    requiredForNew: new Set(),
  },
};

const MAX_IDENTIFIER_SCALARS = 512;
const MAX_FIELD_SCALARS = 8_192;
const MAX_PATCH_JSON_SCALARS = 64 * 1024;
const MAX_EVIDENCE = 256;
const MAX_COMMANDS = 100_000;
const MAX_LIST_ITEMS = 256;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function scalarLength(value: string): number {
  return [...value].length;
}

function requireNonemptyText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  const normalized = value.trim();
  if (scalarLength(normalized) > max) {
    throw new RangeError(`${label} exceeds ${max} Unicode scalars`);
  }
  return normalized;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requirePlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key) || !allowed.has(key)) {
      throw new TypeError(`${label} contains unknown field: ${key}`);
    }
  }
}

function requireJsonField(value: unknown, label: string): JsonValue {
  const cloned = canonicalClone(value) as JsonValue;
  const encoded = canonicalJson(cloned);
  if (scalarLength(encoded) > MAX_FIELD_SCALARS) {
    throw new RangeError(`${label} exceeds ${MAX_FIELD_SCALARS} Unicode scalars`);
  }
  return cloned;
}

function requireSemanticText(
  value: unknown,
  label: string,
  max = MAX_FIELD_SCALARS,
): string {
  return requireNonemptyText(value, label, max);
}

function requireSemanticStringList(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of nonempty strings`);
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new RangeError(`${label} exceeds ${MAX_LIST_ITEMS} entries`);
  }
  return value.map((item, index) =>
    requireSemanticText(item, `${label}[${index}]`, MAX_IDENTIFIER_SCALARS));
}

function validateTermField(field: string, value: unknown): void {
  if (field === "locked") {
    if (typeof value !== "boolean") {
      throw new TypeError("term.locked must be boolean");
    }
    return;
  }
  if (field === "sourceForms"
    || field === "subjectForms"
    || field === "normalizedForms"
    || field === "alternatives"
    || field === "contexts") {
    requireSemanticStringList(value, `term.${field}`);
    return;
  }
  const text = requireSemanticText(value, `term.${field}`);
  if (field === "policy"
    && text !== "locked"
    && text !== "preferred"
    && text !== "contextual") {
    throw new TypeError("term.policy is invalid");
  }
}

function validateEntityField(field: string, value: unknown): void {
  if (field === "aliases" || field === "pronouns") {
    requireSemanticStringList(value, `entity.${field}`);
    return;
  }
  requireSemanticText(value, `entity.${field}`);
}

function validateAliasField(field: string, value: unknown): void {
  requireSemanticText(value, `alias.${field}`);
}

function validateRelationField(field: string, value: unknown): void {
  if (field === "position") {
    if (typeof value === "number") {
      requireNonnegativeInteger(value, "relation.position");
      return;
    }
    requireSemanticText(value, "relation.position", MAX_IDENTIFIER_SCALARS);
    return;
  }
  requireSemanticText(value, `relation.${field}`, MAX_IDENTIFIER_SCALARS);
}

function validateMemoryField(field: string, value: unknown): void {
  if (field === "entities") {
    requireSemanticStringList(value, "memory.entities");
    return;
  }
  if (field === "timeline" && Array.isArray(value)) {
    requireSemanticStringList(value, "memory.timeline");
    return;
  }
  requireSemanticText(
    value,
    `memory.${field}`,
    field === "summary" ? MAX_FIELD_SCALARS : MAX_IDENTIFIER_SCALARS,
  );
}

function validateStyleField(field: string, value: unknown): void {
  requireSemanticText(
    value,
    `style.${field}`,
    field === "additionalInstruction" ? 600 : 180,
  );
}

function validateSemanticField(
  objectType: KnowledgeObjectType,
  field: string,
  value: unknown,
): void {
  switch (objectType) {
    case "term":
      validateTermField(field, value);
      break;
    case "entity":
      validateEntityField(field, value);
      break;
    case "alias":
      validateAliasField(field, value);
      break;
    case "relation":
      validateRelationField(field, value);
      break;
    case "memory":
      validateMemoryField(field, value);
      break;
    case "style":
      validateStyleField(field, value);
      break;
  }
}

export function validateKnowledgePayload(
  objectType: KnowledgeObjectType,
  input: unknown,
): Readonly<Record<string, JsonValue>> {
  const payload = requirePlainObject(input, `${objectType} payload`);
  const rule = FIELD_RULES[objectType];
  requireExactKeys(payload, rule.allowed, `${objectType} payload`);
  for (const field of rule.requiredForNew) {
    if (!Object.hasOwn(payload, field)) {
      throw new TypeError(`${objectType} payload requires ${field}`);
    }
  }
  if (objectType === "style" && Object.keys(payload).length === 0) {
    throw new TypeError("style payload must not be empty");
  }
  for (const [field, value] of Object.entries(payload)) {
    validateSemanticField(objectType, field, value);
  }
  if (objectType === "memory") {
    const hasStart = Object.hasOwn(payload, "startBlockId");
    const hasEnd = Object.hasOwn(payload, "endBlockId");
    if (hasStart !== hasEnd) {
      throw new TypeError(
        "memory.startBlockId and memory.endBlockId must be provided together",
      );
    }
  }
  if (objectType === "term") {
    if (payload.locked === true
      && payload.policy !== undefined
      && payload.policy !== "locked") {
      throw new TypeError("term.locked=true requires policy=locked");
    }
    if (payload.policy === "locked"
      && payload.locked !== undefined
      && payload.locked !== true) {
      throw new TypeError("term.policy=locked requires locked=true");
    }
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [field, value] of Object.entries(payload)) {
    result[field] = requireJsonField(value, `${objectType}.${field}`);
  }
  return result;
}

function normalizeOwnedFields(
  input: unknown,
  patchFields: ReadonlySet<string>,
): readonly string[] {
  const authority = normalizeKnowledgeAuthority({
    origin: "manual",
    scope: "book",
    ownedFields: input,
  });
  for (const pointer of authority.ownedFields) {
    const field = pointer.slice(1).replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!patchFields.has(field)) {
      throw new TypeError(`ownedFields references an unpatched field: ${pointer}`);
    }
  }
  return authority.ownedFields;
}

function normalizeExpectation(
  input: unknown,
  label: string,
): KnowledgeCatalogExpectation {
  const raw = requirePlainObject(input, label);
  requireExactKeys(raw, new Set(["scope", "revision"]), label);
  if (typeof raw.scope !== "string" || !SCOPES.has(raw.scope as KnowledgeScope)) {
    throw new TypeError(`${label}.scope is invalid`);
  }
  return {
    scope: raw.scope as KnowledgeScope,
    revision: requirePositiveInteger(raw.revision, `${label}.revision`),
  };
}

function normalizeEvidence(input: unknown): readonly KnowledgeEvidence[] {
  if (!Array.isArray(input)) {
    throw new TypeError("evidence must be an array");
  }
  if (input.length > MAX_EVIDENCE) {
    throw new RangeError(`evidence exceeds ${MAX_EVIDENCE} entries`);
  }
  return input.map((item, index) => {
    const label = `evidence[${index}]`;
    const raw = requirePlainObject(item, label);
    requireExactKeys(
      raw,
      new Set([
        "kind",
        "blockId",
        "sourceWindowId",
        "canonicalStart",
        "canonicalEnd",
        "quote",
      ]),
      label,
    );
    if (raw.kind !== "source_block"
      && raw.kind !== "source_window"
      && raw.kind !== "user_note") {
      throw new TypeError(`${label}.kind is invalid`);
    }
    const result: {
      kind: "source_block" | "source_window" | "user_note";
      blockId?: string;
      sourceWindowId?: string;
      canonicalStart?: number;
      canonicalEnd?: number;
      quote?: string;
    } = { kind: raw.kind };
    if (raw.blockId !== undefined) {
      result.blockId = requireNonemptyText(
        raw.blockId,
        `${label}.blockId`,
        MAX_IDENTIFIER_SCALARS,
      );
    }
    if (raw.sourceWindowId !== undefined) {
      result.sourceWindowId = requireNonemptyText(
        raw.sourceWindowId,
        `${label}.sourceWindowId`,
        MAX_IDENTIFIER_SCALARS,
      );
    }
    if (raw.canonicalStart !== undefined) {
      result.canonicalStart = requireNonnegativeInteger(
        raw.canonicalStart,
        `${label}.canonicalStart`,
      );
    }
    if (raw.canonicalEnd !== undefined) {
      result.canonicalEnd = requireNonnegativeInteger(
        raw.canonicalEnd,
        `${label}.canonicalEnd`,
      );
    }
    if (result.canonicalStart !== undefined
      && result.canonicalEnd !== undefined
      && result.canonicalEnd < result.canonicalStart) {
      throw new RangeError(`${label} canonical range is reversed`);
    }
    if (raw.quote !== undefined) {
      result.quote = requireNonemptyText(
        raw.quote,
        `${label}.quote`,
        MAX_FIELD_SCALARS,
      );
    }
    if (result.kind === "source_block" && result.blockId === undefined) {
      throw new TypeError(`${label}.blockId is required`);
    }
    if (result.kind === "source_window" && result.sourceWindowId === undefined) {
      throw new TypeError(`${label}.sourceWindowId is required`);
    }
    if (result.kind === "user_note" && result.quote === undefined) {
      throw new TypeError(`${label}.quote is required`);
    }
    return result;
  });
}

export function validateKnowledgeEvidence(
  input: unknown,
): readonly KnowledgeEvidence[] {
  return normalizeEvidence(input);
}

function normalizeUpdateCommand(
  raw: Record<string, unknown>,
): UpdateKnowledgeCommand {
  requireExactKeys(
    raw,
    new Set([
      "type",
      "objectType",
      "normalizedSubject",
      "kind",
      "expectedRevision",
      "expectedScopeRevision",
      "fieldPatch",
      "ownedFields",
      "scope",
      "evidence",
      "origin",
      "importBatchId",
    ]),
    "knowledge command",
  );
  if (typeof raw.objectType !== "string"
    || !OBJECT_TYPES.has(raw.objectType as KnowledgeObjectType)) {
    throw new TypeError("knowledge command objectType is invalid");
  }
  const objectType = raw.objectType as KnowledgeObjectType;
  if (typeof raw.scope !== "string" || !SCOPES.has(raw.scope as KnowledgeScope)) {
    throw new TypeError("knowledge command scope is invalid");
  }
  if (raw.scope === "global") {
    throw new TypeError("global knowledge cannot be edited through a book command");
  }
  if (typeof raw.origin !== "string"
    || !COMMAND_ORIGINS.has(raw.origin as KnowledgeOrigin)) {
    throw new TypeError("knowledge command origin must be manual or import");
  }
  const expectedRevision = raw.expectedRevision === null
    ? null
    : requirePositiveInteger(raw.expectedRevision, "expectedRevision");
  const expectedScopeRevision = raw.expectedScopeRevision === null
    ? null
    : normalizeExpectation(raw.expectedScopeRevision, "expectedScopeRevision");
  const inputPatch = requirePlainObject(raw.fieldPatch, "fieldPatch");
  const fieldRule = FIELD_RULES[objectType];
  requireExactKeys(inputPatch, fieldRule.allowed, `${objectType} fieldPatch`);
  if (Object.keys(inputPatch).length === 0) {
    throw new TypeError("fieldPatch must not be empty");
  }
  if (expectedRevision === null) {
    for (const field of fieldRule.requiredForNew) {
      if (!Object.hasOwn(inputPatch, field)) {
        throw new TypeError(`${objectType} fieldPatch requires ${field}`);
      }
    }
  }
  const fieldPatch: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [field, value] of Object.entries(inputPatch)) {
    validateSemanticField(objectType, field, value);
    fieldPatch[field] = requireJsonField(value, `fieldPatch.${field}`);
  }
  if (scalarLength(canonicalJson(fieldPatch)) > MAX_PATCH_JSON_SCALARS) {
    throw new RangeError(
      `fieldPatch exceeds ${MAX_PATCH_JSON_SCALARS} Unicode scalars`,
    );
  }
  const importBatchId = raw.importBatchId === undefined
    ? undefined
    : requireNonemptyText(
      raw.importBatchId,
      "importBatchId",
      MAX_IDENTIFIER_SCALARS,
    );
  if (raw.origin === "import" && importBatchId === undefined) {
    throw new TypeError("importBatchId is required for imported knowledge");
  }
  if (raw.origin !== "import" && importBatchId !== undefined) {
    throw new TypeError("importBatchId is only valid for imported knowledge");
  }
  const result: {
    type: "upsert";
    objectType: KnowledgeObjectType;
    normalizedSubject: string;
    kind: string;
    expectedRevision: number | null;
    expectedScopeRevision: KnowledgeCatalogExpectation | null;
    fieldPatch: Readonly<Record<string, JsonValue>>;
    ownedFields: readonly string[];
    scope: KnowledgeScope;
    evidence: readonly KnowledgeEvidence[];
    origin: "manual" | "import";
    importBatchId?: string;
  } = {
    type: "upsert",
    objectType,
    normalizedSubject: requireNonemptyText(
      raw.normalizedSubject,
      "normalizedSubject",
      MAX_IDENTIFIER_SCALARS,
    ),
    kind: requireNonemptyText(raw.kind, "kind", MAX_IDENTIFIER_SCALARS),
    expectedRevision,
    expectedScopeRevision,
    fieldPatch,
    ownedFields: normalizeOwnedFields(raw.ownedFields, new Set(Object.keys(fieldPatch))),
    scope: raw.scope as KnowledgeScope,
    evidence: normalizeEvidence(raw.evidence),
    origin: raw.origin as "manual" | "import",
  };
  if (importBatchId !== undefined) {
    result.importBatchId = importBatchId;
  }
  return result;
}

function normalizeRollbackCommand(
  raw: Record<string, unknown>,
): RollbackKnowledgeCommand {
  requireExactKeys(
    raw,
    new Set([
      "type",
      "normalizedSubject",
      "kind",
      "expectedRevision",
      "expectedScopeRevision",
      "targetRevision",
    ]),
    "rollback command",
  );
  const expectation = normalizeExpectation(
    raw.expectedScopeRevision,
    "expectedScopeRevision",
  );
  if (expectation.scope === "global") {
    throw new TypeError("global knowledge cannot be rolled back through a book command");
  }
  return {
    type: "rollback",
    normalizedSubject: requireNonemptyText(
      raw.normalizedSubject,
      "normalizedSubject",
      MAX_IDENTIFIER_SCALARS,
    ),
    kind: requireNonemptyText(raw.kind, "kind", MAX_IDENTIFIER_SCALARS),
    expectedRevision: requirePositiveInteger(
      raw.expectedRevision,
      "expectedRevision",
    ),
    expectedScopeRevision: expectation,
    targetRevision: requirePositiveInteger(raw.targetRevision, "targetRevision"),
  };
}

export function validateKnowledgeCommand(input: unknown): KnowledgeCommand {
  const raw = requirePlainObject(input, "knowledge command");
  if (raw.type === "upsert") {
    return normalizeUpdateCommand(raw);
  }
  if (raw.type === "rollback") {
    return normalizeRollbackCommand(raw);
  }
  throw new TypeError(`unknown knowledge command type: ${String(raw.type)}`);
}

export function validateCommitKnowledgeCommandsRequest(
  input: unknown,
): CommitKnowledgeCommandsRequest {
  const raw = requirePlainObject(input, "knowledge command request");
  requireExactKeys(
    raw,
    new Set([
      "requestId",
      "runId",
      "expectedGeneration",
      "expectedSnapshotId",
      "commands",
    ]),
    "knowledge command request",
  );
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new TypeError("commands must not be empty");
  }
  if (raw.commands.length > MAX_COMMANDS) {
    throw new RangeError(`commands exceeds ${MAX_COMMANDS} entries`);
  }
  return {
    requestId: requireNonemptyText(
      raw.requestId,
      "requestId",
      MAX_IDENTIFIER_SCALARS,
    ),
    runId: requireNonemptyText(raw.runId, "runId", MAX_IDENTIFIER_SCALARS),
    expectedGeneration: requireNonnegativeInteger(
      raw.expectedGeneration,
      "expectedGeneration",
    ),
    expectedSnapshotId: requireNonemptyText(
      raw.expectedSnapshotId,
      "expectedSnapshotId",
      MAX_IDENTIFIER_SCALARS,
    ),
    commands: raw.commands.map(validateKnowledgeCommand),
  };
}

export function knowledgeCommandRequestHash(
  input: CommitKnowledgeCommandsRequest,
): string {
  return createHash("sha256")
    .update(canonicalJson(input))
    .digest("hex");
}

export function requireMatchingKnowledgeReplay(
  stored: KnowledgeCommandEventPayload,
  requestHash: string,
): KnowledgeCommitResult {
  if (stored.requestHash !== requestHash) {
    throw new Error("KNOWLEDGE_REQUEST_REUSE_CONFLICT");
  }
  return canonicalClone(stored.result);
}

export function applyKnowledgeFieldPatch(
  current: unknown,
  patch: Readonly<Record<string, JsonValue>>,
): JsonValue {
  const base = current === null || current === undefined
    ? {}
    : requirePlainObject(current, "knowledge payload");
  const next: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [key, value] of Object.entries(base)) {
    next[key] = requireJsonField(value, `knowledge payload.${key}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    next[key] = requireJsonField(value, `fieldPatch.${key}`);
  }
  return canonicalClone(next);
}

export function validateCatalogKnowledgeDocument(
  input: unknown,
): CatalogKnowledgeDocument {
  const raw = requirePlainObject(input, "catalog knowledge document");
  requireExactKeys(
    raw,
    new Set([
      "objectType",
      "normalizedSubject",
      "kind",
      "payload",
      "alternatives",
      "status",
      "authority",
      "evidence",
      "globalRevisionId",
    ]),
    "catalog knowledge document",
  );
  if (typeof raw.objectType !== "string"
    || !OBJECT_TYPES.has(raw.objectType as KnowledgeObjectType)) {
    throw new TypeError("catalog knowledge document objectType is invalid");
  }
  if (typeof raw.status !== "string"
    || !KNOWLEDGE_STATUSES.has(raw.status as KnowledgeStatus)) {
    throw new TypeError("catalog knowledge document status is invalid");
  }
  if (!Array.isArray(raw.alternatives) || raw.alternatives.length === 0) {
    throw new TypeError("catalog knowledge document alternatives must not be empty");
  }
  const objectType = raw.objectType as KnowledgeObjectType;
  const authority = normalizeKnowledgeAuthority(raw.authority);
  const globalRevisionId = raw.globalRevisionId === undefined
    ? undefined
    : requireNonemptyText(
        raw.globalRevisionId,
        "catalog globalRevisionId",
        MAX_IDENTIFIER_SCALARS,
      );
  if (globalRevisionId !== undefined && authority.scope !== "global") {
    throw new TypeError(
      "catalog globalRevisionId is valid only for global snapshots",
    );
  }
  return {
    objectType,
    normalizedSubject: requireNonemptyText(
      raw.normalizedSubject,
      "catalog normalizedSubject",
      MAX_IDENTIFIER_SCALARS,
    ),
    kind: requireNonemptyText(
      raw.kind,
      "catalog kind",
      MAX_IDENTIFIER_SCALARS,
    ),
    payload: validateKnowledgePayload(objectType, raw.payload),
    alternatives: raw.alternatives.map(
      (item, index) => {
        try {
          return validateKnowledgePayload(objectType, item);
        } catch (error) {
          throw new TypeError(`catalog alternatives[${index}] is invalid`, {
            cause: error,
          });
        }
      },
    ),
    status: raw.status as KnowledgeStatus,
    authority,
    evidence: normalizeEvidence(raw.evidence),
    ...(globalRevisionId === undefined ? {} : { globalRevisionId }),
  };
}

export function catalogDocumentFromRevision(
  objectType: KnowledgeObjectType,
  revision: KnowledgeRevision,
  evidence: readonly KnowledgeEvidence[] = [],
): CatalogKnowledgeDocument {
  if (revision.authority === undefined) {
    throw new TypeError("catalog revisions require knowledge authority");
  }
  const globalRevisionId = revision.authority.provenance?.globalRevisionId;
  return {
    objectType,
    normalizedSubject: revision.normalizedSubject,
    kind: revision.kind,
    payload: canonicalClone(revision.payload) as JsonValue,
    alternatives: revision.alternatives.map(
      (item) => canonicalClone(item) as JsonValue,
    ),
    status: revision.status,
    authority: normalizeKnowledgeAuthority(revision.authority),
    evidence: normalizeEvidence(evidence),
    ...(globalRevisionId === undefined ? {} : { globalRevisionId }),
  };
}
