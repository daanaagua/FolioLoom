import { createHash } from "node:crypto";

import type {
  KnowledgeEvidence,
  KnowledgeOrigin,
  KnowledgeScope,
} from "./knowledge-authority.js";
import type {
  KnowledgeCatalogExpectation,
  KnowledgeObjectType,
} from "./knowledge-commands.js";
import {
  canonicalJson,
  type KnowledgeRevision,
  type KnowledgeStatus,
} from "./knowledge-store.js";
import { sourceFormsFromRevision } from "./knowledge-source-forms.js";

const CURSOR_SCHEMA = "folioloom-knowledge-cursor-2";
const DEFAULT_MAX_LIMIT = 200;

const OBJECT_TYPES = new Set<KnowledgeObjectType>([
  "term",
  "entity",
  "alias",
  "relation",
  "memory",
  "style",
]);
const STATUSES = new Set<KnowledgeStatus>([
  "candidate",
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
  "superseded",
]);
const ORIGINS = new Set<KnowledgeOrigin>([
  "model",
  "manual",
  "import",
  "rollback",
]);
const SCOPES = new Set<KnowledgeScope>(["book", "project", "global"]);

export interface KnowledgeListQuery {
  readonly search?: string;
  readonly objectTypes?: readonly KnowledgeObjectType[];
  readonly statuses?: readonly KnowledgeStatus[];
  readonly origins?: readonly KnowledgeOrigin[];
  readonly scopes?: readonly KnowledgeScope[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface KnowledgeListItem {
  readonly id: string;
  readonly normalizedSubject: string;
  readonly displayName: string;
  readonly objectType: KnowledgeObjectType;
  readonly kind: string;
  readonly revision: number;
  readonly scopeRevision: KnowledgeCatalogExpectation | null;
  readonly status: KnowledgeStatus;
  readonly origin: KnowledgeOrigin;
  readonly scope: KnowledgeScope;
}

export interface KnowledgeImpactView {
  readonly blockId: string;
  readonly globalIndex: number;
  readonly sourceVersion: string;
  readonly status: "pending" | "acknowledged" | "retranslated";
  readonly reason: string;
  readonly sourceExcerpt?: string;
}

export interface KnowledgeQueryRecord {
  readonly id: string;
  readonly objectType: KnowledgeObjectType;
  readonly revision: KnowledgeRevision;
  readonly scopeRevision: KnowledgeCatalogExpectation | null;
  readonly evidence: readonly KnowledgeEvidence[];
  readonly history: readonly KnowledgeRevision[];
  readonly impacts: readonly KnowledgeImpactView[];
}

export interface KnowledgeDetail {
  readonly current: KnowledgeListItem;
  readonly payload: unknown;
  readonly alternatives: readonly unknown[];
  readonly sourceForms: readonly string[];
  readonly history: readonly KnowledgeRevision[];
  readonly evidence: readonly KnowledgeEvidence[];
  readonly impacts: readonly KnowledgeImpactView[];
}

export interface KnowledgeListPage {
  readonly items: readonly KnowledgeListItem[];
  readonly nextCursor: string | null;
}

export interface KnowledgeQuerySortKey {
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly id: string;
}

/**
 * Store-facing, already-normalized list request. Implementations must apply
 * every filter and return rows in strict `(normalizedSubject, kind, id)` order.
 * `limit` includes the one look-ahead row requested by the service.
 */
export interface KnowledgeRecordPageQuery {
  readonly search: string | null;
  readonly objectTypes: readonly KnowledgeObjectType[];
  readonly statuses: readonly KnowledgeStatus[];
  readonly origins: readonly KnowledgeOrigin[];
  readonly scopes: readonly KnowledgeScope[];
  readonly after?: KnowledgeQuerySortKey;
  readonly limit: number;
}

export interface KnowledgeDiagnosticsSummary {
  readonly countsByType: Readonly<Partial<Record<KnowledgeObjectType, number>>>;
  readonly countsByStatus: Readonly<Partial<Record<KnowledgeStatus, number>>>;
  readonly pendingImpacts: number;
}

/**
 * The database adapter deliberately exposes no SQL or paths. A store only
 * needs to provide a generation token, active records, and one lazy detail
 * lookup; the query semantics remain deterministic and independently tested.
 */
export interface KnowledgeQuerySource {
  readonly generation: string;
  listKnowledgeRecords(): readonly KnowledgeQueryRecord[];
  queryKnowledgeRecords?(
    query: KnowledgeRecordPageQuery,
  ): readonly KnowledgeQueryRecord[];
  knowledgeRecord(id: string): KnowledgeQueryRecord | undefined;
  knowledgeRecordBySubject?(
    normalizedSubject: string,
    kind: string,
  ): KnowledgeQueryRecord | undefined;
  relatedKnowledgeRecords?(
    identifiers: readonly string[],
    limit: number,
  ): readonly KnowledgeQueryRecord[];
  knowledgeDiagnostics?(): KnowledgeDiagnosticsSummary;
}

interface NormalizedFilters {
  readonly search: string | null;
  readonly objectTypes: readonly KnowledgeObjectType[];
  readonly statuses: readonly KnowledgeStatus[];
  readonly origins: readonly KnowledgeOrigin[];
  readonly scopes: readonly KnowledgeScope[];
}

interface KnowledgeCursor {
  readonly schema: typeof CURSOR_SCHEMA;
  readonly generation: string;
  readonly filtersHash: string;
  readonly after: KnowledgeQuerySortKey;
}

function invalidCursor(): never {
  throw new Error("KNOWLEDGE_CURSOR_INVALID");
}

function compareText(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  );
}

function compareSortKey(
  left: KnowledgeQuerySortKey,
  right: KnowledgeQuerySortKey,
): number {
  return compareText(left.normalizedSubject, right.normalizedSubject)
    || compareText(left.kind, right.kind)
    || compareText(left.id, right.id);
}

function sortKey(record: KnowledgeQueryRecord): KnowledgeQuerySortKey {
  return {
    normalizedSubject: record.revision.normalizedSubject,
    kind: record.revision.kind,
    id: record.id,
  };
}

function normalizedSet<T extends string>(
  value: readonly T[] | undefined,
  allowed: ReadonlySet<T>,
  label: string,
): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T)) {
      throw new TypeError(`${label} contains an invalid value`);
    }
  }
  return Object.freeze([...new Set(value)].sort(compareText));
}

function normalizeFilters(query: KnowledgeListQuery): NormalizedFilters {
  const search = query.search?.normalize("NFKC").trim().toLocaleLowerCase("und");
  return {
    search: search === undefined || search.length === 0 ? null : search,
    objectTypes: normalizedSet(query.objectTypes, OBJECT_TYPES, "objectTypes"),
    statuses: normalizedSet(query.statuses, STATUSES, "statuses"),
    origins: normalizedSet(query.origins, ORIGINS, "origins"),
    scopes: normalizedSet(query.scopes, SCOPES, "scopes"),
  };
}

function filtersHash(filters: NormalizedFilters): string {
  return createHash("sha256")
    .update(canonicalJson(filters))
    .digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireCursorString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidCursor();
  return value;
}

function decodeCursor(encoded: string): KnowledgeCursor {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) invalidCursor();
  try {
    const text = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64url") !== encoded) {
      invalidCursor();
    }
    const raw = record(JSON.parse(text));
    if (raw === undefined
      || Object.keys(raw).sort(compareText).join(",")
        !== "after,filtersHash,generation,schema") {
      invalidCursor();
    }
    const after = record(raw.after);
    if (after === undefined
      || Object.keys(after).sort(compareText).join(",")
        !== "id,kind,normalizedSubject"
      || raw.schema !== CURSOR_SCHEMA) {
      invalidCursor();
    }
    const cursor: KnowledgeCursor = {
      schema: CURSOR_SCHEMA,
      generation: requireCursorString(raw.generation),
      filtersHash: requireCursorString(raw.filtersHash),
      after: {
        normalizedSubject: requireCursorString(after.normalizedSubject),
        kind: requireCursorString(after.kind),
        id: requireCursorString(after.id),
      },
    };
    if (canonicalJson(cursor) !== text) invalidCursor();
    return cursor;
  } catch (error) {
    if (error instanceof Error && error.message === "KNOWLEDGE_CURSOR_INVALID") {
      throw error;
    }
    return invalidCursor();
  }
}

function encodeCursor(cursor: KnowledgeCursor): string {
  return Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");
}

function authorityOf(revision: KnowledgeRevision): {
  origin: KnowledgeOrigin;
  scope: KnowledgeScope;
} {
  return {
    origin: revision.authority?.origin ?? "model",
    scope: revision.authority?.scope ?? "book",
  };
}

function payloadRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return record(value);
}

function displayName(recordValue: KnowledgeQueryRecord): string {
  const payload = payloadRecord(recordValue.revision.payload);
  const candidates = [
    payload?.canonicalName,
    payload?.sourceForm,
    payload?.canonicalSource,
    sourceFormsFromRevision(recordValue.revision)[0],
    recordValue.revision.normalizedSubject,
  ];
  return candidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )?.trim() ?? recordValue.revision.normalizedSubject;
}

function listItem(recordValue: KnowledgeQueryRecord): KnowledgeListItem {
  const authority = authorityOf(recordValue.revision);
  return {
    id: recordValue.id,
    normalizedSubject: recordValue.revision.normalizedSubject,
    displayName: displayName(recordValue),
    objectType: recordValue.objectType,
    kind: recordValue.revision.kind,
    revision: recordValue.revision.revision,
    scopeRevision: recordValue.scopeRevision,
    status: recordValue.revision.status,
    origin: authority.origin,
    scope: authority.scope,
  };
}

export function knowledgeRevisionMatchesSearch(
  revision: KnowledgeRevision,
  objectType: KnowledgeObjectType,
  normalizedSearch: string,
): boolean {
  const payload = payloadRecord(revision.payload);
  const display = [
    payload?.canonicalName,
    payload?.sourceForm,
    payload?.canonicalSource,
    sourceFormsFromRevision(revision)[0],
    revision.normalizedSubject,
  ].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  )?.trim() ?? revision.normalizedSubject;
  const searchable = [
    revision.normalizedSubject,
    display,
    revision.kind,
    objectType,
    ...sourceFormsFromRevision(revision),
  ].map((value) => value.normalize("NFKC").toLocaleLowerCase("und"));
  return searchable.some((value) => value.includes(normalizedSearch));
}

function includes<T>(filter: readonly T[], value: T): boolean {
  return filter.length === 0 || filter.includes(value);
}

function matches(
  recordValue: KnowledgeQueryRecord,
  filters: NormalizedFilters,
): boolean {
  const item = listItem(recordValue);
  if (!includes(filters.objectTypes, item.objectType)
    || !includes(filters.statuses, item.status)
    || !includes(filters.origins, item.origin)
    || !includes(filters.scopes, item.scope)) {
    return false;
  }
  if (filters.search === null) return true;
  return knowledgeRevisionMatchesSearch(
    recordValue.revision,
    item.objectType,
    filters.search,
  );
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${DEFAULT_MAX_LIMIT}`);
  }
  return value;
}

export class KnowledgeQueryService {
  constructor(readonly source: KnowledgeQuerySource) {
    if (typeof source.generation !== "string"
      || source.generation.trim().length === 0) {
      throw new TypeError("knowledge source generation must be nonempty");
    }
  }

  list(query: KnowledgeListQuery): KnowledgeListPage {
    const limit = requireLimit(query.limit);
    const filters = normalizeFilters(query);
    const hash = filtersHash(filters);
    let after: KnowledgeQuerySortKey | undefined;
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.generation !== this.source.generation
        || cursor.filtersHash !== hash) {
        invalidCursor();
      }
      after = cursor.after;
    }
    const matched = this.source.queryKnowledgeRecords === undefined
      ? this.source.listKnowledgeRecords()
        .filter((item) => matches(item, filters))
        .sort((left, right) => compareSortKey(sortKey(left), sortKey(right)))
        .filter((item) =>
          after === undefined || compareSortKey(sortKey(item), after) > 0)
      : this.source.queryKnowledgeRecords({
        search: filters.search,
        objectTypes: filters.objectTypes,
        statuses: filters.statuses,
        origins: filters.origins,
        scopes: filters.scopes,
        ...(after === undefined ? {} : { after }),
        limit: limit + 1,
      });
    if (matched.length > limit + 1) {
      throw new Error("KNOWLEDGE_QUERY_SOURCE_INVALID");
    }
    let previous = after;
    for (const item of matched) {
      const current = sortKey(item);
      if (!matches(item, filters)
        || (previous !== undefined && compareSortKey(current, previous) <= 0)) {
        throw new Error("KNOWLEDGE_QUERY_SOURCE_INVALID");
      }
      previous = current;
    }
    const page = matched.slice(0, limit);
    const nextCursor = matched.length > limit && page.length > 0
      ? encodeCursor({
        schema: CURSOR_SCHEMA,
        generation: this.source.generation,
        filtersHash: hash,
        after: sortKey(page.at(-1) as KnowledgeQueryRecord),
      })
      : null;
    return {
      items: Object.freeze(page.map(listItem)),
      nextCursor,
    };
  }

  detail(id: string): KnowledgeDetail {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new TypeError("knowledge id must be nonempty");
    }
    const recordValue = this.source.knowledgeRecord(id);
    if (recordValue === undefined) {
      throw new Error("KNOWLEDGE_NOT_FOUND");
    }
    return {
      current: listItem(recordValue),
      payload: recordValue.revision.payload,
      alternatives: Object.freeze([...recordValue.revision.alternatives]),
      sourceForms: sourceFormsFromRevision(recordValue.revision),
      history: Object.freeze([...recordValue.history]),
      evidence: Object.freeze([...recordValue.evidence]),
      impacts: Object.freeze([...recordValue.impacts]),
    };
  }
}
