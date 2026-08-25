export type KnowledgeOrigin = "model" | "manual" | "import" | "rollback";
export type KnowledgeScope = "book" | "project" | "global";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface KnowledgeAuthority {
  readonly origin: KnowledgeOrigin;
  readonly scope: KnowledgeScope;
  readonly ownedFields: readonly string[];
  readonly provenance?: {
    readonly catalog: "book" | "project";
    readonly catalogRevisionId: string;
    readonly globalRevisionId?: string;
  };
}

export interface KnowledgeEvidence {
  readonly kind: "source_block" | "source_window" | "user_note";
  readonly blockId?: string;
  readonly sourceWindowId?: string;
  readonly canonicalStart?: number;
  readonly canonicalEnd?: number;
  readonly quote?: string;
}

export interface EffectiveKnowledgeField<T = unknown> {
  readonly authority: KnowledgeAuthority;
  readonly value: T;
}

const ORIGIN_RANK: Readonly<Record<KnowledgeOrigin, number>> = {
  model: 0,
  import: 1,
  manual: 2,
  rollback: 2,
};

const SCOPE_RANK: Readonly<Record<KnowledgeScope, number>> = {
  global: 0,
  project: 1,
  book: 2,
};

const FORBIDDEN_FIELDS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function requireJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("knowledge authority accepts only pure JSON values");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("knowledge authority accepts only pure JSON values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("knowledge authority rejects circular JSON values");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null) {
    throw new TypeError("knowledge authority accepts only plain JSON objects");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("knowledge authority rejects sparse JSON arrays");
        }
        requireJson(value[index], ancestors);
      }
      return;
    }
    for (const key of Object.keys(value)) {
      requireJson((value as Record<string, unknown>)[key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  requireJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  requireJson(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value as object).sort(compareText)
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function decodeOwnedField(pointer: unknown): string {
  if (typeof pointer !== "string"
    || !pointer.startsWith("/")
    || pointer.length === 1
    || pointer.slice(1).includes("/")
    || /~(?![01])/u.test(pointer)) {
    throw new TypeError(`invalid owned field JSON Pointer: ${String(pointer)}`);
  }
  const field = pointer.slice(1).replace(/~1/gu, "/").replace(/~0/gu, "~");
  if (field.length === 0
    || /^(?:0|[1-9]\d*)$/u.test(field)
    || FORBIDDEN_FIELDS.has(field)) {
    throw new TypeError(`invalid owned field JSON Pointer: ${pointer}`);
  }
  return field;
}

export function normalizeKnowledgeAuthority(input: unknown): KnowledgeAuthority {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("knowledge authority must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.origin !== "string" || !Object.hasOwn(ORIGIN_RANK, raw.origin)) {
    throw new TypeError(`invalid knowledge authority origin: ${String(raw.origin)}`);
  }
  if (typeof raw.scope !== "string" || !Object.hasOwn(SCOPE_RANK, raw.scope)) {
    throw new TypeError(`invalid knowledge authority scope: ${String(raw.scope)}`);
  }
  if (!Array.isArray(raw.ownedFields)) {
    throw new TypeError("knowledge authority ownedFields must be an array");
  }
  const ownedFields = [...new Set(raw.ownedFields.map((pointer) => {
    decodeOwnedField(pointer);
    return pointer as string;
  }))].sort(compareText);
  const authority: {
    origin: KnowledgeOrigin;
    scope: KnowledgeScope;
    ownedFields: string[];
    provenance?: {
      catalog: "book" | "project";
      catalogRevisionId: string;
      globalRevisionId?: string;
    };
  } = {
    origin: raw.origin as KnowledgeOrigin,
    scope: raw.scope as KnowledgeScope,
    ownedFields,
  };
  if (raw.provenance !== undefined) {
    if (raw.provenance === null
      || typeof raw.provenance !== "object"
      || Array.isArray(raw.provenance)) {
      throw new TypeError("knowledge authority provenance must be an object");
    }
    const provenance = raw.provenance as Record<string, unknown>;
    if (provenance.catalog !== "book" && provenance.catalog !== "project") {
      throw new TypeError("invalid knowledge authority provenance catalog");
    }
    authority.provenance = {
      catalog: provenance.catalog,
      catalogRevisionId: requireIdentifier(
        provenance.catalogRevisionId,
        "catalogRevisionId",
      ),
    };
    if (provenance.globalRevisionId !== undefined) {
      authority.provenance.globalRevisionId = requireIdentifier(
        provenance.globalRevisionId,
        "globalRevisionId",
      );
    }
  }
  return authority;
}

export function compareAuthority(
  left: KnowledgeAuthority,
  right: KnowledgeAuthority,
): -1 | 0 | 1 {
  const normalizedLeft = normalizeKnowledgeAuthority(left);
  const normalizedRight = normalizeKnowledgeAuthority(right);
  const rank = SCOPE_RANK[normalizedLeft.scope] - SCOPE_RANK[normalizedRight.scope]
    || ORIGIN_RANK[normalizedLeft.origin] - ORIGIN_RANK[normalizedRight.origin];
  return rank < 0 ? -1 : rank > 0 ? 1 : 0;
}

export function chooseEffectiveField<T>(
  fields: readonly EffectiveKnowledgeField<T>[],
): T | undefined {
  if (!Array.isArray(fields) || fields.length === 0) {
    return undefined;
  }
  let effective = fields[0] as EffectiveKnowledgeField<T>;
  let effectiveAuthority = normalizeKnowledgeAuthority(effective.authority);
  let effectiveJson = canonicalJson(effective.value);
  for (const field of fields.slice(1)) {
    const authority = normalizeKnowledgeAuthority(field.authority);
    const comparison = compareAuthority(authority, effectiveAuthority);
    if (comparison > 0) {
      effective = field;
      effectiveAuthority = authority;
      effectiveJson = canonicalJson(field.value);
    } else if (comparison === 0) {
      const fieldJson = canonicalJson(field.value);
      if (fieldJson !== effectiveJson) {
        throw new Error("KNOWLEDGE_AUTHORITY_CONFLICT: same-rank field values differ");
      }
    }
  }
  return cloneJson(effective.value);
}

export function mergeCandidateWithAuthority(
  current: unknown,
  candidate: unknown,
  authority: KnowledgeAuthority | undefined,
): unknown {
  requireJson(current);
  const merged = cloneJson(candidate);
  if (authority === undefined) {
    return merged;
  }
  const normalized = normalizeKnowledgeAuthority(authority);
  if (normalized.ownedFields.length === 0) {
    return merged;
  }
  if (current === null
    || typeof current !== "object"
    || Array.isArray(current)
    || merged === null
    || typeof merged !== "object"
    || Array.isArray(merged)) {
    throw new TypeError("owned fields require plain JSON object payloads");
  }
  const currentRecord = current as Record<string, unknown>;
  const mergedRecord = merged as Record<string, unknown>;
  for (const pointer of normalized.ownedFields) {
    const field = decodeOwnedField(pointer);
    if (Object.hasOwn(currentRecord, field)) {
      mergedRecord[field] = cloneJson(currentRecord[field]);
    } else {
      delete mergedRecord[field];
    }
  }
  return merged;
}
