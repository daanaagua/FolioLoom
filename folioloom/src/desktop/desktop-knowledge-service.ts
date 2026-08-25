import type {
  JsonValue,
  KnowledgeEvidence,
} from "../knowledge/knowledge-authority.js";
import {
  catalogDocumentFromRevision,
  type CatalogKnowledgeDocument,
  type KnowledgeCommitResult,
} from "../knowledge/knowledge-commands.js";
import {
  GlobalKnowledgeStore,
  type GlobalKnowledgeRevision,
} from "../knowledge/global-knowledge-store.js";
import {
  KnowledgeQueryService,
  type KnowledgeDetail,
  type KnowledgeQueryRecord,
} from "../knowledge/knowledge-query.js";
import { canonicalClone, canonicalJson } from "../knowledge/knowledge-store.js";
import { LOSSLESS_BOOK_SCHEMA_VERSION } from "../storage/book-schema-v3.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import type {
  DesktopAttachGlobalKnowledgeRequest,
  DesktopError,
  DesktopGlobalKnowledgeListRequest,
  DesktopGlobalKnowledgePage,
  DesktopKnowledgeDetail,
  DesktopKnowledgeDiagnostics,
  DesktopKnowledgeListRequest,
  DesktopKnowledgeMutationRequest,
  DesktopKnowledgeMutationResult,
  DesktopKnowledgePage,
  DesktopProjectRequest,
  DesktopPromoteKnowledgeRequest,
  DesktopResult,
} from "./contracts.js";
import { DesktopInputError, fail, ok, toDesktopError } from "./desktop-errors.js";
import { DesktopProjectService } from "./desktop-project-service.js";

type KnowledgeTarget = {
  readonly storePath: string;
  readonly runId: string;
  readonly sourceVersion: string;
  readonly sourceLanguage: string;
};

const MAX_RELATED_KNOWLEDGE = 200;

function publicError(error: unknown): DesktopError {
  let normalized = error;
  if (error instanceof Error
    && !(error instanceof DesktopInputError)
    && /^[A-Z][A-Z0-9_]+(?::|\b)/u.test(error.message)) {
    const code = error.message.match(/^[A-Z][A-Z0-9_]+/u)?.[0] ?? "DESKTOP_ERROR";
    normalized = new DesktopInputError(code, error.message);
  }
  const mapped = toDesktopError(normalized);
  return {
    code: mapped.code,
    message: mapped.message,
    retryable: mapped.retryable,
    ...(mapped.nextAction === undefined ? {} : { nextAction: mapped.nextAction }),
  };
}

function jsonObject(value: unknown): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("KNOWLEDGE_PAYLOAD_INVALID");
  }
  return canonicalClone(value) as Readonly<Record<string, JsonValue>>;
}

function authority(revision: KnowledgeDetail["history"][number]): {
  origin: "model" | "manual" | "import" | "rollback";
  scope: "book" | "project" | "global";
} {
  return {
    origin: revision.authority?.origin ?? "model",
    scope: revision.authority?.scope ?? "book",
  };
}

function desktopEvidence(
  evidence: readonly KnowledgeEvidence[],
): DesktopKnowledgeDetail["evidence"] {
  return evidence.map((item) => ({
    kind: item.kind,
    ...(item.canonicalStart === undefined
      ? {}
      : { canonicalStart: item.canonicalStart }),
    ...(item.canonicalEnd === undefined
      ? {}
      : { canonicalEnd: item.canonicalEnd }),
    ...(item.quote === undefined ? {} : { sourceText: item.quote }),
  }));
}

function relationRows(
  records: readonly KnowledgeQueryRecord[],
  current: KnowledgeDetail,
): DesktopKnowledgeDetail["relations"] {
  const aliases = new Set([current.current.id, current.current.normalizedSubject]);
  return records.flatMap((record) => {
    if (record.objectType !== "relation") return [];
    const payload = record.revision.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }
    const raw = payload as Record<string, unknown>;
    const subjectId = raw.fromEntityId ?? raw.subjectId;
    const predicate = raw.relationType ?? raw.predicate;
    const objectId = raw.toEntityId ?? raw.objectId;
    if (typeof subjectId !== "string"
      || typeof predicate !== "string"
      || typeof objectId !== "string"
      || (!aliases.has(subjectId) && !aliases.has(objectId))) {
      return [];
    }
    return [{ subjectId, predicate, objectId }];
  });
}

function desktopDetail(
  detail: KnowledgeDetail,
  records: readonly KnowledgeQueryRecord[],
): DesktopKnowledgeDetail {
  return {
    item: detail.current,
    fields: jsonObject(detail.payload),
    evidence: desktopEvidence(detail.evidence),
    history: detail.history.map((revision) => ({
      revision: revision.revision,
      revisionId: revision.revisionId,
      ...authority(revision),
      // Legacy knowledge revisions do not carry wall-clock metadata. The
      // revision number and content hash remain the authoritative ordering.
      createdAt: "",
    })),
    impacts: detail.impacts.map((impact) => ({
      blockId: impact.blockId,
      globalIndex: impact.globalIndex,
      status: impact.status,
    })),
    relations: relationRows(records, detail),
  };
}

function detailForId(
  store: LosslessBookStore,
  runId: string,
  objectId: string,
): DesktopKnowledgeDetail {
  const source = store.knowledgeQuerySource(runId);
  const detail = new KnowledgeQueryService(source).detail(objectId);
  const records = source.relatedKnowledgeRecords?.(
    [detail.current.id, detail.current.normalizedSubject],
    MAX_RELATED_KNOWLEDGE,
  ) ?? source.listKnowledgeRecords();
  return desktopDetail(detail, records);
}

function detailForSubject(
  store: LosslessBookStore,
  runId: string,
  normalizedSubject: string,
  kind: string,
): DesktopKnowledgeDetail {
  const source = store.knowledgeQuerySource(runId);
  const record = source.knowledgeRecordBySubject?.(
    normalizedSubject,
    kind,
  ) ?? source.listKnowledgeRecords().find((item) =>
    item.revision.normalizedSubject === normalizedSubject
      && item.revision.kind === kind);
  if (record === undefined) {
    throw new Error("KNOWLEDGE_NOT_FOUND");
  }
  const detail = new KnowledgeQueryService(source).detail(record.id);
  const records = source.relatedKnowledgeRecords?.(
    [detail.current.id, detail.current.normalizedSubject],
    MAX_RELATED_KNOWLEDGE,
  ) ?? source.listKnowledgeRecords();
  return desktopDetail(detail, records);
}

function mutationResult(
  store: LosslessBookStore,
  runId: string,
  commit: KnowledgeCommitResult,
  normalizedSubject: string,
  kind: string,
): DesktopKnowledgeMutationResult {
  return {
    generation: commit.generation,
    snapshotId: commit.snapshotId,
    detail: detailForSubject(store, runId, normalizedSubject, kind),
  };
}

function globalDisplayValue(revision: GlobalKnowledgeRevision): string {
  const payload = revision.document.payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const raw = payload as Readonly<Record<string, JsonValue>>;
    for (const key of [
      "target",
      "canonicalName",
      "narrativeVoice",
      "dialogueRegister",
      "technicalProse",
      "formality",
    ]) {
      const value = raw[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  return revision.normalizedSubject;
}

function matchingGlobalRevision(
  globals: GlobalKnowledgeStore,
  document: CatalogKnowledgeDocument,
): GlobalKnowledgeRevision | undefined {
  return globals.list({
    search: document.normalizedSubject,
    objectTypes: document.objectType === "term" || document.objectType === "style"
      ? [document.objectType]
      : [],
    limit: 200,
  }).items.find((item) =>
    item.objectType === document.objectType
    && item.normalizedSubject === document.normalizedSubject
    && item.document.kind === document.kind);
}

function sameGlobalContent(
  left: CatalogKnowledgeDocument,
  right: CatalogKnowledgeDocument,
): boolean {
  return canonicalJson({
    objectType: left.objectType,
    normalizedSubject: left.normalizedSubject,
    kind: left.kind,
    payload: left.payload,
    alternatives: left.alternatives,
    status: left.status,
    ownedFields: left.authority.ownedFields,
  }) === canonicalJson({
    objectType: right.objectType,
    normalizedSubject: right.normalizedSubject,
    kind: right.kind,
    payload: right.payload,
    alternatives: right.alternatives,
    status: right.status,
    ownedFields: right.authority.ownedFields,
  });
}

function recordHasGlobalContent(
  record: KnowledgeQueryRecord | undefined,
  global: GlobalKnowledgeRevision,
): boolean {
  return record !== undefined
    && record.objectType === global.objectType
    && record.revision.normalizedSubject === global.document.normalizedSubject
    && record.revision.kind === global.document.kind
    && canonicalJson(record.revision.payload) === canonicalJson(global.document.payload);
}

export class DesktopKnowledgeService {
  constructor(
    private readonly projects: DesktopProjectService,
    private readonly globals: GlobalKnowledgeStore,
    private readonly getCurrentRequest: () => DesktopProjectRequest | undefined,
  ) {}

  list(request: DesktopKnowledgeListRequest): DesktopResult<DesktopKnowledgePage> {
    return this.#withCurrentStore("read-only", (store, target) => {
      const state = store.knowledgeState(target.runId);
      const page = new KnowledgeQueryService(store.knowledgeQuerySource(target.runId))
        .list(request);
      return {
        generation: state.generation,
        snapshotId: state.snapshotId,
        items: page.items,
        ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
      };
    });
  }

  detail(objectId: string): DesktopResult<DesktopKnowledgeDetail> {
    return this.#withCurrentStore(
      "read-only",
      (store, target) => detailForId(store, target.runId, objectId),
    );
  }

  mutate(
    request: DesktopKnowledgeMutationRequest,
  ): DesktopResult<DesktopKnowledgeMutationResult> {
    return this.#withCurrentStore("read-write", (store, target) => {
      const commit = store.commitKnowledgeCommands({
        requestId: request.requestId,
        runId: target.runId,
        expectedGeneration: request.expectedGeneration,
        expectedSnapshotId: request.expectedSnapshotId,
        commands: [request.command],
      });
      return mutationResult(
        store,
        target.runId,
        commit,
        request.command.normalizedSubject,
        request.command.kind,
      );
    });
  }

  promoteGlobal(
    request: DesktopPromoteKnowledgeRequest,
  ): DesktopResult<DesktopKnowledgeMutationResult> {
    return this.#withCurrentStore("read-write", (store, target) => {
      const source = store.knowledgeQuerySource(target.runId);
      const record = source.knowledgeRecord(request.objectId);
      if (record === undefined) {
        throw new Error("KNOWLEDGE_NOT_FOUND");
      }
      if (record.objectType !== "term" && record.objectType !== "style") {
        throw new Error("GLOBAL_SCOPE_FORBIDDEN");
      }
      const document = catalogDocumentFromRevision(
        record.objectType,
        record.revision,
        record.evidence,
      );
      const existing = matchingGlobalRevision(this.globals, document);
      const global = existing !== undefined
        && sameGlobalContent(existing.document, document)
        ? existing
        : this.globals.promote(document, {
            expectedRevision: existing?.revision ?? null,
            ...(existing === undefined ? {} : { recordId: existing.recordId }),
          });
      const state = store.knowledgeState(target.runId);
      if (state.generation !== request.expectedGeneration
        || state.snapshotId !== request.expectedSnapshotId) {
        if (recordHasGlobalContent(record, global)) {
          return {
            generation: state.generation,
            snapshotId: state.snapshotId,
            detail: detailForId(store, target.runId, record.id),
          };
        }
        throw new Error("KNOWLEDGE_GENERATION_CONFLICT");
      }
      return {
        generation: state.generation,
        snapshotId: state.snapshotId,
        detail: detailForId(store, target.runId, record.id),
      };
    });
  }

  listGlobal(
    request: DesktopGlobalKnowledgeListRequest,
  ): DesktopResult<DesktopGlobalKnowledgePage> {
    try {
      const page = this.globals.list(request);
      return ok({
        items: page.items.map((item) => ({
          recordId: item.recordId,
          revision: item.revision,
          objectType: item.objectType,
          normalizedSubject: item.normalizedSubject,
          displayValue: globalDisplayValue(item),
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
    } catch (error) {
      return fail(publicError(error));
    }
  }

  attachGlobal(
    request: DesktopAttachGlobalKnowledgeRequest,
  ): DesktopResult<DesktopKnowledgeMutationResult> {
    return this.#withCurrentStore("read-write", (store, target) => {
      const global = this.globals.get(request.recordId, request.revision);
      if (global === undefined) {
        throw new Error("GLOBAL_KNOWLEDGE_REVISION_NOT_FOUND");
      }
      try {
        const commit = store.attachGlobalKnowledgeSnapshot({
          requestId: request.requestId,
          runId: target.runId,
          expectedGeneration: request.expectedGeneration,
          expectedSnapshotId: request.expectedSnapshotId,
          globalRevisionId: global.revisionId,
          document: global.document,
        });
        this.globals.recordAttached(global.recordId, global.revision);
        return mutationResult(
          store,
          target.runId,
          commit,
          global.document.normalizedSubject,
          global.document.kind,
        );
      } catch (error) {
        this.globals.recordUnattached(global.recordId, global.revision);
        throw error;
      }
    });
  }

  diagnostics(): DesktopResult<DesktopKnowledgeDiagnostics> {
    return this.#withCurrentStore("read-only", (store, target) => {
      const state = store.knowledgeState(target.runId);
      const source = store.knowledgeQuerySource(target.runId);
      const summary = source.knowledgeDiagnostics?.();
      const records = summary === undefined
        ? source.listKnowledgeRecords()
        : undefined;
      const countsByType: Record<string, number> = {
        ...(summary?.countsByType ?? {}),
      };
      const countsByStatus: Record<string, number> = {
        ...(summary?.countsByStatus ?? {}),
      };
      let pendingImpacts = summary?.pendingImpacts ?? 0;
      for (const record of records ?? []) {
        countsByType[record.objectType] = (countsByType[record.objectType] ?? 0) + 1;
        countsByStatus[record.revision.status] =
          (countsByStatus[record.revision.status] ?? 0) + 1;
        pendingImpacts += record.impacts.filter((impact) => impact.status === "pending").length;
      }
      return {
        schemaVersion: LOSSLESS_BOOK_SCHEMA_VERSION,
        knowledgeGeneration: state.generation,
        countsByType,
        countsByStatus,
        pendingImpacts,
        latestMigration: "lossless-book-schema-v3",
      };
    });
  }

  #withCurrentStore<T>(
    mode: "read-only" | "read-write",
    operation: (store: LosslessBookStore, target: KnowledgeTarget) => T,
  ): DesktopResult<T> {
    try {
      const request = this.getCurrentRequest();
      if (request === undefined) {
        throw new DesktopInputError(
          "DESKTOP_PROJECT_NOT_SELECTED",
          "Open a project before using the knowledge workbench",
        );
      }
      const resolved = this.projects.resolveKnowledgeTarget(request);
      if (!resolved.ok) {
        return fail({
          code: resolved.error.code,
          message: resolved.error.message,
          retryable: resolved.error.retryable,
          ...(resolved.error.nextAction === undefined
            ? {}
            : { nextAction: resolved.error.nextAction }),
        });
      }
      const target = resolved.value;
      if (mode === "read-only") {
        const synchronizer = new LosslessBookStore(target.storePath);
        try {
          synchronizer.syncScopedKnowledge(target.runId);
        } finally {
          synchronizer.close();
        }
      }
      const store = mode === "read-only"
        ? LosslessBookStore.openReadOnly(target.storePath)
        : new LosslessBookStore(target.storePath);
      try {
        return ok(operation(store, target));
      } finally {
        store.close();
      }
    } catch (error) {
      return fail(publicError(error));
    }
  }
}
