import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import {
  validateCatalogKnowledgeDocument,
  type CatalogKnowledgeDocument,
} from "./knowledge-commands.js";
import {
  canonicalClone,
  canonicalJson,
  deepFreeze,
} from "./knowledge-store.js";

export type GlobalKnowledgeObjectType = "term" | "style";
export type GlobalKnowledgeEventKind =
  | "promoted"
  | "attached"
  | "unattached";

export interface GlobalKnowledgeRevision {
  readonly recordId: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly objectType: GlobalKnowledgeObjectType;
  readonly normalizedSubject: string;
  readonly document: CatalogKnowledgeDocument;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface PromoteGlobalKnowledgeOptions {
  readonly expectedRevision: number | null;
  readonly recordId?: string;
}

export interface GlobalKnowledgeListRequest {
  readonly search?: string;
  readonly objectTypes?: readonly GlobalKnowledgeObjectType[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface GlobalKnowledgePage {
  readonly items: readonly GlobalKnowledgeRevision[];
  readonly nextCursor?: string;
}

export interface GlobalKnowledgeAuditEvent {
  readonly sequence: number;
  readonly recordId: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly kind: GlobalKnowledgeEventKind;
  readonly createdAt: string;
}

export interface GlobalKnowledgeAuditListRequest {
  readonly recordId?: string;
  readonly kinds?: readonly GlobalKnowledgeEventKind[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface GlobalKnowledgeAuditPage {
  readonly items: readonly GlobalKnowledgeAuditEvent[];
  readonly nextCursor?: string;
}

interface RevisionRow {
  readonly record_id: string;
  readonly revision: number;
  readonly revision_id: string;
  readonly object_type: string;
  readonly normalized_subject: string;
  readonly document_json: string;
  readonly active: number;
  readonly created_at: string;
}

interface EventRow {
  readonly sequence: number;
  readonly record_id: string;
  readonly revision: number;
  readonly kind: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly revision_id: string;
}

interface ListCursor {
  readonly version: 2;
  readonly libraryGeneration: number;
  readonly filtersHash: string;
  readonly normalizedSubject: string;
  readonly objectType: GlobalKnowledgeObjectType;
  readonly recordId: string;
  readonly revision: number;
}

interface AuditCursor {
  readonly version: 1;
  readonly sequence: number;
}

const GLOBAL_SCHEMA_VERSION = 1;
const RECORD_ID_PATTERN = /^gk_[0-9a-f]{64}$/u;
const REVISION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const GLOBAL_OBJECT_TYPES = new Set<GlobalKnowledgeObjectType>([
  "term",
  "style",
]);
const EVENT_KINDS = new Set<GlobalKnowledgeEventKind>([
  "promoted",
  "attached",
  "unattached",
]);
const MAX_PAGE_SIZE = 200;
const MAX_SEARCH_SCALARS = 512;

const GLOBAL_SCHEMA = `
  CREATE TABLE global_knowledge_revisions(
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    revision_id TEXT NOT NULL UNIQUE CHECK(length(revision_id) = 64),
    object_type TEXT NOT NULL CHECK(object_type IN ('term', 'style')),
    normalized_subject TEXT NOT NULL CHECK(length(trim(normalized_subject)) > 0),
    document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(record_id, revision)
  ) STRICT;

  CREATE TABLE global_knowledge_events(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('promoted', 'attached', 'unattached')),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(record_id, revision)
      REFERENCES global_knowledge_revisions(record_id, revision) ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX global_knowledge_one_active_revision
    ON global_knowledge_revisions(record_id)
    WHERE active = 1;
  CREATE INDEX global_knowledge_active_list
    ON global_knowledge_revisions(
      active, normalized_subject, object_type, record_id, revision
    );
  CREATE INDEX global_knowledge_event_audit
    ON global_knowledge_events(record_id, sequence);
`;

function all<T>(statement: StatementSync, ...parameters: SQLInputValue[]): T[] {
  return statement.all(...parameters) as T[];
}

function one<T>(
  statement: StatementSync,
  ...parameters: SQLInputValue[]
): T | undefined {
  return statement.get(...parameters) as T | undefined;
}

function scalarLength(value: string): number {
  return [...value].length;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function requirePageSize(value: unknown): number {
  const limit = requirePositiveInteger(value, "limit");
  if (limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit exceeds ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

function requireRecordId(value: unknown): string {
  if (typeof value !== "string" || !RECORD_ID_PATTERN.test(value)) {
    throw new TypeError("global knowledge recordId is invalid");
  }
  return value;
}

function requireObjectType(value: unknown): GlobalKnowledgeObjectType {
  if (typeof value !== "string"
    || !GLOBAL_OBJECT_TYPES.has(value as GlobalKnowledgeObjectType)) {
    throw new TypeError("global knowledge object type is invalid");
  }
  return value as GlobalKnowledgeObjectType;
}

function requireEventKind(value: unknown): GlobalKnowledgeEventKind {
  if (typeof value !== "string"
    || !EVENT_KINDS.has(value as GlobalKnowledgeEventKind)) {
    throw new TypeError("global knowledge event kind is invalid");
  }
  return value as GlobalKnowledgeEventKind;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  errorCode: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  const raw = value as Record<string, unknown>;
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(errorCode);
  }
  return raw;
}

function encodeCursor(value: ListCursor | AuditCursor): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function decodeListCursor(value: string): ListCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
    }
    const text = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64url") !== value) {
      throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
    }
    const raw = exactObject(
      JSON.parse(text),
      [
        "version",
        "libraryGeneration",
        "filtersHash",
        "normalizedSubject",
        "objectType",
        "recordId",
        "revision",
      ],
      "GLOBAL_KNOWLEDGE_CURSOR_INVALID",
    );
    if (raw.version !== 2
      || typeof raw.filtersHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(raw.filtersHash)
      || typeof raw.normalizedSubject !== "string"
      || raw.normalizedSubject.length === 0) {
      throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
    }
    const cursor: ListCursor = {
      version: 2,
      libraryGeneration: requireNonnegativeInteger(
        raw.libraryGeneration,
        "cursor library generation",
      ),
      filtersHash: raw.filtersHash,
      normalizedSubject: raw.normalizedSubject,
      objectType: requireObjectType(raw.objectType),
      recordId: requireRecordId(raw.recordId),
      revision: requirePositiveInteger(raw.revision, "cursor revision"),
    };
    if (canonicalJson(cursor) !== text) {
      throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
    }
    return cursor;
  } catch {
    throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
  }
}

function decodeAuditCursor(value: string): AuditCursor {
  try {
    const raw = exactObject(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      ["version", "sequence"],
      "GLOBAL_KNOWLEDGE_CURSOR_INVALID",
    );
    if (raw.version !== 1) {
      throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
    }
    return {
      version: 1,
      sequence: requirePositiveInteger(raw.sequence, "cursor sequence"),
    };
  } catch {
    throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
  }
}

function sanitizeDocument(input: unknown): CatalogKnowledgeDocument {
  const validated = validateCatalogKnowledgeDocument(input);
  if (validated.objectType !== "term" && validated.objectType !== "style") {
    throw new Error("GLOBAL_SCOPE_FORBIDDEN");
  }
  return {
    objectType: validated.objectType,
    normalizedSubject: validated.normalizedSubject,
    kind: validated.kind,
    payload: canonicalClone(validated.payload),
    alternatives: validated.alternatives.map((value) => canonicalClone(value)),
    status: validated.status,
    authority: {
      origin: validated.authority.origin,
      scope: "global",
      ownedFields: [...validated.authority.ownedFields],
    },
    evidence: [],
  };
}

function generatedRecordId(document: CatalogKnowledgeDocument): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      version: 1,
      objectType: document.objectType,
      normalizedSubject: document.normalizedSubject,
      kind: document.kind,
    }))
    .digest("hex");
  return `gk_${digest}`;
}

function normalizedGlobalSearch(value: string | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().toLocaleLowerCase("und");
  return normalized === undefined || normalized.length === 0
    ? null
    : normalized;
}

function normalizedGlobalObjectTypes(
  value: readonly GlobalKnowledgeObjectType[] | undefined,
): readonly GlobalKnowledgeObjectType[] {
  return Object.freeze(
    [...new Set((value ?? []).map(requireObjectType))].sort(),
  );
}

function globalListFiltersHash(
  search: string | null,
  objectTypes: readonly GlobalKnowledgeObjectType[],
): string {
  return createHash("sha256")
    .update(canonicalJson({ search, objectTypes }))
    .digest("hex");
}

function revisionIdFor(
  recordId: string,
  revision: number,
  document: CatalogKnowledgeDocument,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      version: 1,
      recordId,
      revision,
      objectType: document.objectType,
      normalizedSubject: document.normalizedSubject,
      document,
    }))
    .digest("hex");
}

function revisionFromRow(row: RevisionRow): GlobalKnowledgeRevision {
  const recordId = requireRecordId(row.record_id);
  const revision = requirePositiveInteger(row.revision, "stored revision");
  if (!REVISION_ID_PATTERN.test(row.revision_id)) {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: invalid revision id");
  }
  const objectType = requireObjectType(row.object_type);
  if (row.active !== 0 && row.active !== 1) {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: invalid active flag");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document_json);
  } catch {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: invalid document JSON");
  }
  const document = sanitizeDocument(parsed);
  if (document.objectType !== objectType
    || document.normalizedSubject !== row.normalized_subject
    || canonicalJson(document) !== row.document_json) {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: document columns disagree");
  }
  if (revisionIdFor(recordId, revision, document) !== row.revision_id) {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: revision hash mismatch");
  }
  return deepFreeze({
    recordId,
    revision,
    revisionId: row.revision_id,
    objectType,
    normalizedSubject: row.normalized_subject,
    document,
    active: row.active === 1,
    createdAt: row.created_at,
  });
}

function eventFromRow(row: EventRow): GlobalKnowledgeAuditEvent {
  const recordId = requireRecordId(row.record_id);
  const revision = requirePositiveInteger(row.revision, "stored event revision");
  const kind = requireEventKind(row.kind);
  let payload: Record<string, unknown>;
  try {
    payload = exactObject(
      JSON.parse(row.payload_json),
      ["revisionId"],
      "GLOBAL_KNOWLEDGE_SCHEMA_INVALID",
    );
  } catch {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: invalid event payload");
  }
  if (payload.revisionId !== row.revision_id) {
    throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: event revision mismatch");
  }
  return deepFreeze({
    sequence: requirePositiveInteger(row.sequence, "stored event sequence"),
    recordId,
    revision,
    revisionId: row.revision_id,
    kind,
    createdAt: row.created_at,
  });
}

export class GlobalKnowledgeStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new TypeError("global knowledge database path must be nonempty");
    }
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.#database = new DatabaseSync(absolute);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.#database.function(
        "folioloom_normalize_search",
        { deterministic: true },
        (value) => typeof value === "string"
          ? value.normalize("NFKC").toLocaleLowerCase("und")
          : null,
      );
      this.#initializeSchema();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  promote(
    input: CatalogKnowledgeDocument,
    options: PromoteGlobalKnowledgeOptions,
  ): GlobalKnowledgeRevision {
    this.#requireOpen();
    const document = sanitizeDocument(input);
    const expectedRevision = options.expectedRevision === null
      ? null
      : requirePositiveInteger(options.expectedRevision, "expectedRevision");
    const recordId = options.recordId === undefined
      ? generatedRecordId(document)
      : requireRecordId(options.recordId);

    return this.#transaction(() => {
      const latest = one<RevisionRow>(this.#database.prepare(`
        SELECT *
        FROM global_knowledge_revisions
        WHERE record_id = ?
        ORDER BY revision DESC
        LIMIT 1
      `), recordId);
      const currentRevision = latest?.revision ?? null;
      if (currentRevision !== expectedRevision) {
        throw new Error(
          `GLOBAL_KNOWLEDGE_CONFLICT: expected ${
            String(expectedRevision)
          }, got ${String(currentRevision)}`,
        );
      }
      const revision = (currentRevision ?? 0) + 1;
      const revisionId = revisionIdFor(recordId, revision, document);
      if (latest !== undefined) {
        this.#database.prepare(`
          UPDATE global_knowledge_revisions
          SET active = 0
          WHERE record_id = ? AND revision = ? AND active = 1
        `).run(recordId, latest.revision);
      }
      this.#database.prepare(`
        INSERT INTO global_knowledge_revisions(
          record_id,
          revision,
          revision_id,
          object_type,
          normalized_subject,
          document_json,
          active
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        recordId,
        revision,
        revisionId,
        document.objectType,
        document.normalizedSubject,
        canonicalJson(document),
      );
      this.#insertEvent(recordId, revision, revisionId, "promoted");
      return this.#requireRevision(recordId, revision);
    });
  }

  get(
    recordId: string,
    revision?: number,
  ): GlobalKnowledgeRevision | undefined {
    this.#requireOpen();
    const normalizedRecordId = requireRecordId(recordId);
    const row = revision === undefined
      ? one<RevisionRow>(this.#database.prepare(`
          SELECT *
          FROM global_knowledge_revisions
          WHERE record_id = ? AND active = 1
          LIMIT 1
        `), normalizedRecordId)
      : one<RevisionRow>(this.#database.prepare(`
          SELECT *
          FROM global_knowledge_revisions
          WHERE record_id = ? AND revision = ?
          LIMIT 1
        `), normalizedRecordId, requirePositiveInteger(revision, "revision"));
    return row === undefined ? undefined : revisionFromRow(row);
  }

  list(request: GlobalKnowledgeListRequest): GlobalKnowledgePage {
    this.#requireOpen();
    const limit = requirePageSize(request.limit);
    const search = normalizedGlobalSearch(request.search);
    if (search !== null && scalarLength(search) > MAX_SEARCH_SCALARS) {
      throw new RangeError(`search exceeds ${MAX_SEARCH_SCALARS} Unicode scalars`);
    }
    const objectTypes = normalizedGlobalObjectTypes(request.objectTypes);
    const filtersHash = globalListFiltersHash(search, objectTypes);
    const libraryGeneration = one<{ generation: number }>(
      this.#database.prepare(`
        SELECT COALESCE(MAX(rowid), 0) AS generation
        FROM global_knowledge_revisions
      `),
    )?.generation ?? 0;
    const cursor = request.cursor === undefined
      ? undefined
      : decodeListCursor(request.cursor);
    if (cursor !== undefined
      && (
        cursor.filtersHash !== filtersHash
        || cursor.libraryGeneration !== libraryGeneration
      )) {
      throw new Error("GLOBAL_KNOWLEDGE_CURSOR_INVALID");
    }

    const clauses = ["active = 1"];
    const parameters: SQLInputValue[] = [];
    if (search !== null) {
      clauses.push(
        "(instr(folioloom_normalize_search(normalized_subject), ?) > 0 "
        + "OR instr(folioloom_normalize_search(document_json), ?) > 0)",
      );
      parameters.push(search, search);
    }
    if (objectTypes.length > 0) {
      clauses.push(
        `object_type IN (${objectTypes.map(() => "?").join(", ")})`,
      );
      parameters.push(...objectTypes);
    }
    if (cursor !== undefined) {
      clauses.push(`(
        normalized_subject > ?
        OR (normalized_subject = ? AND object_type > ?)
        OR (
          normalized_subject = ? AND object_type = ? AND record_id > ?
        )
        OR (
          normalized_subject = ? AND object_type = ? AND record_id = ?
          AND revision > ?
        )
      )`);
      parameters.push(
        cursor.normalizedSubject,
        cursor.normalizedSubject,
        cursor.objectType,
        cursor.normalizedSubject,
        cursor.objectType,
        cursor.recordId,
        cursor.normalizedSubject,
        cursor.objectType,
        cursor.recordId,
        cursor.revision,
      );
    }
    parameters.push(limit + 1);
    const rows = all<RevisionRow>(this.#database.prepare(`
      SELECT *
      FROM global_knowledge_revisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY normalized_subject, object_type, record_id, revision
      LIMIT ?
    `), ...parameters);
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const items = pageRows.map(revisionFromRow);
    if (!hasNext || items.length === 0) {
      return deepFreeze({ items });
    }
    const last = items.at(-1)!;
    return deepFreeze({
      items,
      nextCursor: encodeCursor({
        version: 2,
        libraryGeneration,
        filtersHash,
        normalizedSubject: last.normalizedSubject,
        objectType: last.objectType,
        recordId: last.recordId,
        revision: last.revision,
      }),
    });
  }

  recordAttached(recordId: string, revision: number): GlobalKnowledgeAuditEvent {
    return this.#recordOutcome(recordId, revision, "attached");
  }

  recordUnattached(
    recordId: string,
    revision: number,
  ): GlobalKnowledgeAuditEvent {
    return this.#recordOutcome(recordId, revision, "unattached");
  }

  listAuditEvents(
    request: GlobalKnowledgeAuditListRequest,
  ): GlobalKnowledgeAuditPage {
    this.#requireOpen();
    const limit = requirePageSize(request.limit);
    const recordId = request.recordId === undefined
      ? undefined
      : requireRecordId(request.recordId);
    const kinds = request.kinds === undefined
      ? []
      : [...new Set(request.kinds.map(requireEventKind))];
    const cursor = request.cursor === undefined
      ? undefined
      : decodeAuditCursor(request.cursor);

    const clauses = ["1 = 1"];
    const parameters: SQLInputValue[] = [];
    if (recordId !== undefined) {
      clauses.push("events.record_id = ?");
      parameters.push(recordId);
    }
    if (kinds.length > 0) {
      clauses.push(`events.kind IN (${kinds.map(() => "?").join(", ")})`);
      parameters.push(...kinds);
    }
    if (cursor !== undefined) {
      clauses.push("events.sequence > ?");
      parameters.push(cursor.sequence);
    }
    parameters.push(limit + 1);
    const rows = all<EventRow>(this.#database.prepare(`
      SELECT
        events.sequence,
        events.record_id,
        events.revision,
        events.kind,
        events.payload_json,
        events.created_at,
        revisions.revision_id
      FROM global_knowledge_events AS events
      JOIN global_knowledge_revisions AS revisions
        ON revisions.record_id = events.record_id
       AND revisions.revision = events.revision
      WHERE ${clauses.join(" AND ")}
      ORDER BY events.sequence
      LIMIT ?
    `), ...parameters);
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const items = pageRows.map(eventFromRow);
    if (!hasNext || items.length === 0) {
      return deepFreeze({ items });
    }
    return deepFreeze({
      items,
      nextCursor: encodeCursor({
        version: 1,
        sequence: items.at(-1)!.sequence,
      }),
    });
  }

  #initializeSchema(): void {
    const existing = all<{ name: string }>(this.#database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)).map((row) => row.name);
    if (existing.length > 0
      && canonicalJson(existing)
        !== canonicalJson([
          "global_knowledge_events",
          "global_knowledge_revisions",
        ])) {
      throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: unexpected tables");
    }
    if (existing.length === 0) {
      this.#transaction(() => {
        this.#database.exec(GLOBAL_SCHEMA);
        this.#database.exec(`PRAGMA user_version = ${GLOBAL_SCHEMA_VERSION}`);
      });
    }
    const version = one<{ user_version: number }>(
      this.#database.prepare("PRAGMA user_version"),
    )?.user_version;
    const strictTables = all<{ name: string; strict: number }>(
      this.#database.prepare(`
        SELECT name, strict
        FROM pragma_table_list
        WHERE name IN (
          'global_knowledge_revisions',
          'global_knowledge_events'
        )
        ORDER BY name
      `),
    );
    if (version !== GLOBAL_SCHEMA_VERSION
      || strictTables.length !== 2
      || strictTables.some((table) => table.strict !== 1)) {
      throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID");
    }
  }

  #recordOutcome(
    recordId: string,
    revision: number,
    kind: "attached" | "unattached",
  ): GlobalKnowledgeAuditEvent {
    this.#requireOpen();
    const normalizedRecordId = requireRecordId(recordId);
    const normalizedRevision = requirePositiveInteger(revision, "revision");
    return this.#transaction(() => {
      const target = this.get(normalizedRecordId, normalizedRevision);
      if (target === undefined) {
        throw new Error("GLOBAL_KNOWLEDGE_REVISION_NOT_FOUND");
      }
      const sequence = this.#insertEvent(
        normalizedRecordId,
        normalizedRevision,
        target.revisionId,
        kind,
      );
      const row = one<EventRow>(this.#database.prepare(`
        SELECT
          events.sequence,
          events.record_id,
          events.revision,
          events.kind,
          events.payload_json,
          events.created_at,
          revisions.revision_id
        FROM global_knowledge_events AS events
        JOIN global_knowledge_revisions AS revisions
          ON revisions.record_id = events.record_id
         AND revisions.revision = events.revision
        WHERE events.sequence = ?
      `), sequence);
      if (row === undefined) {
        throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: missing audit event");
      }
      return eventFromRow(row);
    });
  }

  #insertEvent(
    recordId: string,
    revision: number,
    revisionId: string,
    kind: GlobalKnowledgeEventKind,
  ): number {
    const result = this.#database.prepare(`
      INSERT INTO global_knowledge_events(
        record_id, revision, kind, payload_json
      ) VALUES (?, ?, ?, ?)
    `).run(
      recordId,
      revision,
      kind,
      canonicalJson({ revisionId }),
    );
    return Number(result.lastInsertRowid);
  }

  #requireRevision(
    recordId: string,
    revision: number,
  ): GlobalKnowledgeRevision {
    const row = one<RevisionRow>(this.#database.prepare(`
      SELECT *
      FROM global_knowledge_revisions
      WHERE record_id = ? AND revision = ?
    `), recordId, revision);
    if (row === undefined) {
      throw new Error("GLOBAL_KNOWLEDGE_SCHEMA_INVALID: missing revision");
    }
    return revisionFromRow(row);
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new Error("GLOBAL_KNOWLEDGE_STORE_CLOSED");
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#database.isTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw error;
    }
  }
}
