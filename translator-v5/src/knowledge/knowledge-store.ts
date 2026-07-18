import { createHash } from "node:crypto";

export type KnowledgeStatus =
  | "candidate"
  | "provisional"
  | "active"
  | "needs_revalidate"
  | "contextual"
  | "superseded";

const ALLOWED_TRANSITIONS: Readonly<Record<KnowledgeStatus, readonly KnowledgeStatus[]>> = {
  candidate: ["provisional", "active", "needs_revalidate", "contextual", "superseded"],
  provisional: ["active", "needs_revalidate", "contextual", "superseded"],
  active: ["active", "needs_revalidate", "contextual", "superseded"],
  needs_revalidate: ["active", "needs_revalidate", "contextual", "superseded"],
  contextual: ["active", "needs_revalidate", "contextual", "superseded"],
  superseded: [],
};

const KNOWLEDGE_STATUSES = new Set<KnowledgeStatus>([
  "candidate",
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
  "superseded",
]);

const PROJECTABLE_STATUSES = new Set<KnowledgeStatus>([
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
]);

export function transitionAllowed(
  from: KnowledgeStatus,
  to: KnowledgeStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface KnowledgeCandidate {
  readonly recordId: string;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface KnowledgeRevision {
  readonly revisionId: string;
  readonly revision: number;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly alternatives: readonly unknown[];
  readonly status: KnowledgeStatus;
  readonly candidateIds: readonly string[];
  readonly sourceWindowIds: readonly string[];
}

type KnowledgeRevisionContent = Omit<KnowledgeRevision, "revisionId">;

export interface AppendKnowledgeRevision {
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly alternatives?: readonly unknown[];
  readonly status: KnowledgeStatus;
  readonly candidateIds?: readonly string[];
  readonly sourceWindowIds?: readonly string[];
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON rejects non-finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON rejects circular values");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts only arrays and plain objects");
    }
    const result: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort(compareText)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new TypeError(`canonical JSON rejects undefined at ${key}`);
      }
      result[key] = canonicalize(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function keyOf(normalizedSubject: string, kind: string): string {
  return `${normalizedSubject}\0${kind}`;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return [...new Set(value.map((item) => requireIdentifier(item, `${label} item`)))]
    .sort(compareText);
}

function sortedAlternatives(values: readonly unknown[]): unknown[] {
  const byJson = new Map<string, unknown>();
  for (const value of values) {
    const encoded = canonicalJson(value);
    if (!byJson.has(encoded)) {
      byJson.set(encoded, canonicalClone(value));
    }
  }
  return [...byJson.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function singletonCandidateStatus(kind: string, payload: unknown): KnowledgeStatus {
  if (kind !== "entity_alias_link"
    || payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)) {
    return "active";
  }
  const status = (payload as { status?: unknown }).status;
  return status === "confirmed"
    ? "active"
    : status === "conflicted"
      ? "needs_revalidate"
      : "provisional";
}

function normalizeRevisionContent(input: unknown): KnowledgeRevisionContent {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("knowledge revision must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) {
    throw new TypeError("knowledge revision must be a positive safe integer");
  }
  if (typeof raw.status !== "string"
    || !KNOWLEDGE_STATUSES.has(raw.status as KnowledgeStatus)) {
    throw new TypeError(`invalid knowledge status: ${String(raw.status)}`);
  }
  if (!Array.isArray(raw.alternatives) || raw.alternatives.length === 0) {
    throw new TypeError("knowledge alternatives must be a nonempty array");
  }
  return {
    revision: raw.revision as number,
    normalizedSubject: requireIdentifier(raw.normalizedSubject, "normalizedSubject"),
    kind: requireIdentifier(raw.kind, "kind"),
    payload: canonicalClone(raw.payload),
    alternatives: sortedAlternatives(raw.alternatives),
    status: raw.status as KnowledgeStatus,
    candidateIds: requireStringArray(raw.candidateIds, "candidateIds"),
    sourceWindowIds: requireStringArray(raw.sourceWindowIds, "sourceWindowIds"),
  };
}

function revisionFromContent(input: unknown): KnowledgeRevision {
  const content = normalizeRevisionContent(input);
  const revisionId = createHash("sha256")
    .update(canonicalJson(content))
    .digest("hex");
  return deepFreeze({ revisionId, ...content });
}

function compareRevision(left: KnowledgeRevision, right: KnowledgeRevision): number {
  return compareText(left.normalizedSubject, right.normalizedSubject)
    || compareText(left.kind, right.kind)
    || left.revision - right.revision
    || compareText(left.revisionId, right.revisionId);
}

/**
 * Append-only domain store. It owns no database; callers may hydrate it from the
 * existing book ledger and persist coordinator commits through one adapter.
 */
export class KnowledgeStore {
  readonly #revisions: KnowledgeRevision[] = [];
  readonly #latestByKey = new Map<string, KnowledgeRevision>();

  constructor(revisions: readonly KnowledgeRevision[] = []) {
    if (!Array.isArray(revisions)) {
      throw new TypeError("knowledge revisions must be an array");
    }
    const hydrated = revisions.map((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError("knowledge revision must be an object");
      }
      const suppliedId = requireIdentifier(
        (raw as unknown as Record<string, unknown>).revisionId,
        "revisionId",
      );
      const copy = revisionFromContent(raw);
      if (suppliedId !== copy.revisionId) {
        throw new Error(`knowledge revision id/hash mismatch: ${suppliedId}`);
      }
      return copy;
    }).sort(compareRevision);
    for (const copy of hydrated) {
      const key = keyOf(copy.normalizedSubject, copy.kind);
      const previous = this.#latestByKey.get(key);
      const expectedRevision = (previous?.revision ?? 0) + 1;
      if (copy.revision !== expectedRevision) {
        throw new Error(
          `knowledge revisions must be continuous for ${copy.normalizedSubject}/${copy.kind}: `
          + `expected ${expectedRevision}, got ${copy.revision}`,
        );
      }
      if (previous !== undefined && !transitionAllowed(previous.status, copy.status)) {
        throw new Error(
          `knowledge transition is not allowed: ${previous.status} -> ${copy.status}`,
        );
      }
      this.#revisions.push(copy);
      this.#latestByKey.set(key, copy);
    }
  }

  listRevisions(): readonly KnowledgeRevision[] {
    return Object.freeze([...this.#revisions].sort(compareRevision));
  }

  activeKnowledge(
    normalizedSubject: string,
    kind: string,
  ): KnowledgeRevision | undefined {
    const latest = this.latestRevision(normalizedSubject, kind);
    return latest !== undefined && PROJECTABLE_STATUSES.has(latest.status)
      ? latest
      : undefined;
  }

  latestRevision(
    normalizedSubject: string,
    kind: string,
  ): KnowledgeRevision | undefined {
    return this.#latestByKey.get(keyOf(normalizedSubject, kind));
  }

  projectableRevisions(): readonly KnowledgeRevision[] {
    return Object.freeze([...this.#latestByKey.values()]
      .filter((revision) => PROJECTABLE_STATUSES.has(revision.status))
      .sort((left, right) =>
        compareText(left.normalizedSubject, right.normalizedSubject)
        || compareText(left.kind, right.kind)
        || compareText(left.revisionId, right.revisionId)));
  }

  appendRevision(input: AppendKnowledgeRevision): KnowledgeRevision {
    const normalizedSubject = requireIdentifier(input.normalizedSubject, "normalizedSubject");
    const kind = requireIdentifier(input.kind, "kind");
    const key = keyOf(normalizedSubject, kind);
    const previous = this.#latestByKey.get(key);
    const revision = (previous?.revision ?? 0) + 1;
    const appended = revisionFromContent({
      revision,
      normalizedSubject,
      kind,
      payload: input.payload,
      alternatives: input.alternatives ?? [input.payload],
      status: input.status,
      candidateIds: input.candidateIds ?? [],
      sourceWindowIds: input.sourceWindowIds ?? [],
    });
    if (previous !== undefined && !transitionAllowed(previous.status, appended.status)) {
      throw new Error(
        `knowledge transition is not allowed: ${previous.status} -> ${appended.status}`,
      );
    }
    this.#revisions.push(appended);
    this.#latestByKey.set(key, appended);
    return appended;
  }

  reconcileCandidates(
    candidates: readonly KnowledgeCandidate[],
    sourceWindowId: string,
  ): readonly KnowledgeRevision[] {
    requireIdentifier(sourceWindowId, "sourceWindowId");
    const seenRecordIds = new Set<string>();
    const groups = new Map<string, {
      normalizedSubject: string;
      kind: string;
      candidates: KnowledgeCandidate[];
    }>();
    for (const input of candidates) {
      const candidate: KnowledgeCandidate = {
        recordId: requireIdentifier(input.recordId, "candidate recordId"),
        normalizedSubject: requireIdentifier(input.normalizedSubject, "normalizedSubject"),
        kind: requireIdentifier(input.kind, "knowledge kind"),
        payload: canonicalClone(input.payload),
      };
      if (seenRecordIds.has(candidate.recordId)) {
        throw new Error(`duplicate candidate recordId: ${candidate.recordId}`);
      }
      seenRecordIds.add(candidate.recordId);
      const key = keyOf(candidate.normalizedSubject, candidate.kind);
      const group = groups.get(key) ?? {
        normalizedSubject: candidate.normalizedSubject,
        kind: candidate.kind,
        candidates: [],
      };
      group.candidates.push(candidate);
      groups.set(key, group);
    }

    const appended: KnowledgeRevision[] = [];
    for (const group of [...groups.values()].sort((left, right) =>
      compareText(left.normalizedSubject, right.normalizedSubject)
      || compareText(left.kind, right.kind))) {
      group.candidates.sort((left, right) =>
        compareText(canonicalJson(left.payload), canonicalJson(right.payload))
        || compareText(left.recordId, right.recordId));
      const current = this.latestRevision(group.normalizedSubject, group.kind);
      const alternatives = sortedAlternatives([
        ...(current?.alternatives ?? []),
        ...group.candidates.map((candidate) => candidate.payload),
      ]);
      const status: KnowledgeStatus = alternatives.length === 1
        ? singletonCandidateStatus(group.kind, alternatives[0])
        : "needs_revalidate";
      appended.push(this.appendRevision({
        normalizedSubject: group.normalizedSubject,
        kind: group.kind,
        payload: alternatives.length === 1
          ? alternatives[0]
          : { alternatives },
        alternatives,
        status,
        candidateIds: [
          ...(current?.candidateIds ?? []),
          ...group.candidates.map((candidate) => candidate.recordId),
        ],
        sourceWindowIds: [...(current?.sourceWindowIds ?? []), sourceWindowId],
      }));
    }
    return Object.freeze(appended);
  }

  fork(): KnowledgeStore {
    return new KnowledgeStore(this.#revisions);
  }

  replaceWith(replacement: KnowledgeStore): void {
    this.#revisions.splice(0, this.#revisions.length, ...replacement.#revisions);
    this.#latestByKey.clear();
    for (const [key, revision] of replacement.#latestByKey) {
      this.#latestByKey.set(key, revision);
    }
  }
}
