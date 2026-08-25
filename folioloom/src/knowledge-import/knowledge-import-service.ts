import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import {
  inspectCsv,
  streamCsvRecords,
  type ReadyCsvInspection,
} from "./csv-reader.js";
import {
  suggestMapping as suggestFieldMapping,
} from "./field-mapping.js";
import {
  enforceImportFileSize,
  inspectImportPath,
} from "./input-policy.js";
import {
  inspectJsonText,
  inspectYamlText,
  readStructuredRecords,
  type StructuredInspection,
} from "./json-yaml-reader.js";
import {
  KnowledgeImportMappingError,
  normalizeImportRecord,
  type NormalizedImportRecord,
} from "./record-normalizer.js";
import type {
  CancelImportOperationRequest,
  CommitImportRequest,
  CommittedImportReport,
  ConfirmImportEncodingRequest,
  DiscardStagedImportRequest,
  ImportDecisionRequest,
  ImportDiagnostic,
  ImportInspection,
  ImportInspectionResult,
  ImportRecordSource,
  ImportSelection,
  InspectImportRequest,
  MappingSuggestion,
  PendingKnowledgeImport,
  RollbackImportRequest,
  RolledBackImportReport,
  StageImportRequest,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "./types.js";
import {
  inspectXlsx,
  streamXlsxRecords,
  type XlsxInspection,
} from "./xlsx-reader.js";

export const KNOWLEDGE_IMPORT_PENDING_TTL_MS = 15 * 60 * 1_000;
export const MAX_PENDING_KNOWLEDGE_IMPORTS = 4;
const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class KnowledgeImportServiceError extends Error {
  readonly name = "KnowledgeImportServiceError";

  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export type PreparedImportRecord =
  | {
      readonly state: "normalized";
      readonly record: NormalizedImportRecord;
    }
  | {
      readonly state: "invalid";
      readonly ordinal: number;
      readonly location: string;
      readonly diagnostics: readonly ImportDiagnostic[];
    };

export interface StageBatchInput {
  readonly batchId: string;
  readonly sourceHash: string;
  readonly sourceName: string;
  readonly sourceFormat: PendingKnowledgeImport["format"];
  readonly request: StageImportRequest;
  readonly signal: AbortSignal;
  /**
   * The adapter must consume this iterable and persist the batch in one
   * transaction. Throwing or aborting must leave neither a batch nor rows.
   */
  readonly records: AsyncIterable<PreparedImportRecord>;
}

async function sourceFileHash(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      if (signal.aborted) {
        stream.destroy();
        throw cancelled();
      }
      hash.update(chunk as Buffer);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (signal.aborted) throw cancelled();
  return hash.digest("hex");
}

/**
 * Persistence is deliberately inverted: the import domain never imports the
 * project store or SQL. A store adapter can classify and stage records inside
 * its own transaction, preserving generation and snapshot invariants.
 */
export interface KnowledgeImportStorageAdapter {
  stageBatch(input: StageBatchInput): Promise<StagedImportReport>;
  listStaged?(): Promise<readonly StagedImportSummary[]>;
  getStaged?(input: StagedImportPageRequest): Promise<StagedImportReport>;
  setDecisions?(input: ImportDecisionRequest): Promise<StagedImportReport>;
  discardStaged?(input: DiscardStagedImportRequest): Promise<void>;
  commitBatch?(
    input: CommitImportRequest & { readonly signal: AbortSignal },
  ): Promise<CommittedImportReport>;
  rollbackBatch?(
    input: RollbackImportRequest & { readonly signal: AbortSignal },
  ): Promise<RolledBackImportReport>;
}

interface PendingEntry {
  readonly pending: PendingKnowledgeImport;
  readonly absolutePath: string;
  readonly expiresAt: number;
  context?: InspectionContext;
  inspectedSourceHash?: string;
}

interface SourceFileStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

type InspectionContext =
  | {
      readonly kind: "structured";
      readonly inspection: StructuredInspection;
    }
  | {
      readonly kind: "csv";
      readonly inspection: ReadyCsvInspection;
      readonly headerRow: number;
    }
  | {
      readonly kind: "xlsx";
      readonly inspection: XlsxInspection;
    };

export interface KnowledgeImportServiceOptions {
  readonly storage?: KnowledgeImportStorageAdapter;
  readonly now?: () => number;
  readonly createId?: () => string;
}

function fail(code: string, message: string): never {
  throw new KnowledgeImportServiceError(code, message);
}

function requireOperationId(operationId: string): void {
  if (!OPERATION_UUID.test(operationId)) {
    fail("KNOWLEDGE_IMPORT_OPERATION_ID_INVALID", "operationId must be a UUID");
  }
}

function cancelled(): KnowledgeImportServiceError {
  return new KnowledgeImportServiceError(
    "KNOWLEDGE_IMPORT_CANCELLED",
    "the operation was cancelled",
  );
}

async function sourceFileStamp(path: string): Promise<SourceFileStamp> {
  const details = await stat(path);
  if (!details.isFile()) {
    fail("KNOWLEDGE_IMPORT_NOT_FILE", "pending import is not a regular file");
  }
  return Object.freeze({
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
  });
}

function sameSourceFileStamp(
  left: SourceFileStamp,
  right: SourceFileStamp,
): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function frozenInspection(
  pending: PendingKnowledgeImport,
  recordPaths: ImportInspection["recordPaths"],
  sheets: ImportInspection["sheets"],
  sample: ImportInspection["sample"],
): ImportInspectionResult {
  return Object.freeze({
    status: "ready",
    inspection: Object.freeze({
      pendingImportId: pending.pendingImportId,
      fileName: pending.fileName,
      format: pending.format,
      recordPaths: Object.freeze([...recordPaths]),
      sheets: Object.freeze([...sheets]),
      sample: Object.freeze(sample.slice(0, 50)),
    }),
  });
}

function diagnosticFromMappingError(
  error: KnowledgeImportMappingError,
): ImportDiagnostic {
  return Object.freeze({
    code: error.code,
    message: error.message,
    location: error.location,
    ...(error.field === undefined ? {} : { field: error.field }),
  });
}

export class KnowledgeImportService {
  readonly #storage: KnowledgeImportStorageAdapter | undefined;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #operations = new Map<string, AbortController>();

  constructor(options: KnowledgeImportServiceOptions = {}) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(id);
    }
  }

  #entry(pendingImportId: string): PendingEntry {
    this.#pruneExpired();
    const entry = this.#pending.get(pendingImportId);
    if (entry === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_PENDING_UNKNOWN_OR_EXPIRED",
        "pending import is unknown or expired",
      );
    }
    return entry;
  }

  #requireStorage(): KnowledgeImportStorageAdapter {
    if (this.#storage === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_STORAGE_UNAVAILABLE",
        "no knowledge import persistence adapter is connected",
      );
    }
    return this.#storage;
  }

  async #withOperation<T>(
    operationId: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    requireOperationId(operationId);
    if (this.#operations.has(operationId)) {
      fail(
        "KNOWLEDGE_IMPORT_OPERATION_ACTIVE",
        "operationId is already active",
      );
    }
    const controller = new AbortController();
    this.#operations.set(operationId, controller);
    try {
      const result = await action(controller.signal);
      if (controller.signal.aborted) throw cancelled();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw cancelled();
      throw error;
    } finally {
      if (this.#operations.get(operationId) === controller) {
        this.#operations.delete(operationId);
      }
    }
  }

  registerPending(absolutePath: string): PendingKnowledgeImport {
    if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) {
      fail(
        "KNOWLEDGE_IMPORT_PATH_INVALID",
        "only an absolute path supplied by the main-process chooser is accepted",
      );
    }
    this.#pruneExpired();
    if (this.#pending.size >= MAX_PENDING_KNOWLEDGE_IMPORTS) {
      fail(
        "KNOWLEDGE_IMPORT_PENDING_LIMIT",
        `at most ${MAX_PENDING_KNOWLEDGE_IMPORTS} pending files may be registered`,
      );
    }
    const fileName = basename(absolutePath);
    const descriptor = inspectImportPath(fileName);
    const pending = Object.freeze({
      pendingImportId: this.#createId(),
      fileName,
      format: descriptor.format,
    });
    this.#pending.set(pending.pendingImportId, {
      pending,
      absolutePath,
      expiresAt: this.#now() + KNOWLEDGE_IMPORT_PENDING_TTL_MS,
    });
    return pending;
  }

  cancelPendingImport(pendingImportId: string): void {
    this.#pending.delete(pendingImportId);
  }

  cancelOperation(input: CancelImportOperationRequest): void {
    requireOperationId(input.operationId);
    this.#operations.get(input.operationId)?.abort();
  }

  async #inspectStructured(entry: PendingEntry): Promise<ImportInspectionResult> {
    const details = await stat(entry.absolutePath);
    if (!details.isFile()) {
      fail("KNOWLEDGE_IMPORT_NOT_FILE", "pending import is not a regular file");
    }
    enforceImportFileSize(details.size, entry.pending.fileName);
    const text = await readFile(entry.absolutePath, "utf8");
    const inspection = entry.pending.format === "json"
      ? await inspectJsonText(text)
      : await inspectYamlText(text);
    entry.context = { kind: "structured", inspection };
    const preferredPath = inspection.officialTemplate?.recordPathId
      ?? inspection.recordPaths[0]?.id;
    const sample = preferredPath === undefined
      ? []
      : await readStructuredRecords(inspection, preferredPath);
    return frozenInspection(
      entry.pending,
      inspection.recordPaths.map((item) => ({
        id: item.id,
        label: item.label,
        shape: item.shape,
      })),
      [],
      sample,
    );
  }

  async #inspectCsv(
    entry: PendingEntry,
    encoding?: ConfirmImportEncodingRequest["encoding"],
  ): Promise<ImportInspectionResult> {
    const inspection = await inspectCsv(entry.absolutePath, {
      ...(encoding === undefined ? {} : { encoding }),
    });
    if (inspection.status === "encoding_required") {
      return Object.freeze({
        status: "encoding_required",
        pendingImportId: entry.pending.pendingImportId,
        fileName: entry.pending.fileName,
        encodings: inspection.encodings,
        previews: inspection.previews,
      });
    }
    entry.context = { kind: "csv", inspection, headerRow: 1 };
    return frozenInspection(entry.pending, [], [], inspection.sample);
  }

  async #inspectXlsx(entry: PendingEntry): Promise<ImportInspectionResult> {
    const inspection = await inspectXlsx(entry.absolutePath);
    entry.context = { kind: "xlsx", inspection };
    return frozenInspection(
      entry.pending,
      [],
      inspection.sheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        suggestedHeaderRows: sheet.suggestedHeaderRows,
      })),
      inspection.sample,
    );
  }

  async #inspectWithIdentity(
    entry: PendingEntry,
    signal: AbortSignal,
    inspect: () => Promise<ImportInspectionResult>,
  ): Promise<ImportInspectionResult> {
    entry.context = undefined;
    entry.inspectedSourceHash = undefined;
    const before = await sourceFileStamp(entry.absolutePath);
    const result = await inspect();
    if (result.status !== "ready") return result;
    const sourceHash = await sourceFileHash(entry.absolutePath, signal);
    const after = await sourceFileStamp(entry.absolutePath);
    if (!sameSourceFileStamp(before, after)) {
      entry.context = undefined;
      fail(
        "KNOWLEDGE_IMPORT_SOURCE_CHANGED",
        "the source file changed while it was being inspected; inspect it again",
      );
    }
    entry.inspectedSourceHash = sourceHash;
    return result;
  }

  inspect(input: InspectImportRequest): Promise<ImportInspectionResult> {
    return this.#withOperation(input.operationId, async (signal) => {
      const entry = this.#entry(input.pendingImportId);
      if (signal.aborted) throw cancelled();
      return this.#inspectWithIdentity(entry, signal, async () => {
        if (entry.pending.format === "json" || entry.pending.format === "yaml") {
          return this.#inspectStructured(entry);
        }
        if (entry.pending.format === "csv") return this.#inspectCsv(entry);
        return this.#inspectXlsx(entry);
      });
    });
  }

  confirmEncoding(
    input: ConfirmImportEncodingRequest,
  ): Promise<ImportInspectionResult> {
    return this.#withOperation(input.operationId, async (signal) => {
      const entry = this.#entry(input.pendingImportId);
      if (entry.pending.format !== "csv") {
        fail(
          "KNOWLEDGE_IMPORT_ENCODING_NOT_APPLICABLE",
          "encoding confirmation is accepted only for CSV",
        );
      }
      if (signal.aborted) throw cancelled();
      return this.#inspectWithIdentity(
        entry,
        signal,
        () => this.#inspectCsv(entry, input.encoding),
      );
    });
  }

  async suggestMapping(
    pendingImportId: string,
    selection: ImportSelection,
  ): Promise<MappingSuggestion> {
    const entry = this.#entry(pendingImportId);
    const context = entry.context;
    if (context === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_INSPECTION_REQUIRED",
        "inspect the pending file before requesting a mapping",
      );
    }
    if (context.kind === "structured") {
      if (selection.recordPathId === undefined) {
        fail(
          "KNOWLEDGE_IMPORT_RECORD_PATH_REQUIRED",
          "a structured record path must be selected",
        );
      }
      const records = await readStructuredRecords(
        context.inspection,
        selection.recordPathId,
      );
      const columns = Object.keys(records[0]?.values ?? {}).sort();
      return suggestFieldMapping({
        objectType: selection.objectType,
        scope: selection.scope,
        columns,
        sample: records.slice(0, 50),
        format: entry.pending.format,
        selection,
        templateVersion: context.inspection.officialTemplate?.schema,
      });
    }
    if (context.kind === "csv") {
      const headerRow = selection.headerRow ?? context.headerRow;
      const encoding = selection.encoding ?? context.inspection.encoding;
      const inspection = headerRow === context.headerRow
        && encoding === context.inspection.encoding
        ? context.inspection
        : await inspectCsv(entry.absolutePath, { headerRow, encoding });
      if (inspection.status !== "ready") {
        fail(
          "KNOWLEDGE_IMPORT_ENCODING_REQUIRED",
          "confirm an encoding before mapping CSV columns",
        );
      }
      entry.context = { kind: "csv", inspection, headerRow };
      return suggestFieldMapping({
        objectType: selection.objectType,
        scope: selection.scope,
        columns: inspection.columnDetails,
        sample: inspection.sample,
        format: "csv",
        selection,
      });
    }
    if (selection.sheetId === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_SHEET_REQUIRED",
        "an XLSX sheet must be selected",
      );
    }
    const sheet = context.inspection.sheets.find(
      (item) => item.id === selection.sheetId,
    );
    if (sheet === undefined) {
      fail("KNOWLEDGE_IMPORT_SHEET_UNKNOWN", "selected XLSX sheet is unknown");
    }
    return suggestFieldMapping({
      objectType: selection.objectType,
      scope: selection.scope,
      columns: sheet.columns,
      sample: context.inspection.sample.filter(
        (item) => item.sheetId === selection.sheetId,
      ),
      format: "xlsx",
      selection,
    });
  }

  async *#recordSources(
    entry: PendingEntry,
    selection: ImportSelection,
  ): AsyncGenerator<ImportRecordSource> {
    const context = entry.context;
    if (context === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_INSPECTION_REQUIRED",
        "inspect the pending file before staging",
      );
    }
    if (context.kind === "structured") {
      if (selection.recordPathId === undefined) {
        fail(
          "KNOWLEDGE_IMPORT_RECORD_PATH_REQUIRED",
          "a structured record path must be selected",
        );
      }
      for (const record of await readStructuredRecords(
        context.inspection,
        selection.recordPathId,
      )) {
        yield record;
      }
      return;
    }
    if (context.kind === "csv") {
      for await (const record of streamCsvRecords(entry.absolutePath, {
        headerRow: selection.headerRow ?? context.headerRow,
        encoding: selection.encoding ?? context.inspection.encoding,
      })) {
        yield record;
      }
      return;
    }
    if (selection.sheetId === undefined) {
      fail(
        "KNOWLEDGE_IMPORT_SHEET_REQUIRED",
        "an XLSX sheet must be selected",
      );
    }
    for await (const record of streamXlsxRecords(entry.absolutePath, {
      sheetId: selection.sheetId,
      headerRow: selection.headerRow ?? 1,
    })) {
      yield record;
    }
  }

  async *#preparedRecords(
    entry: PendingEntry,
    input: StageImportRequest,
    batchId: string,
    signal: AbortSignal,
    expectedStamp: SourceFileStamp,
  ): AsyncGenerator<PreparedImportRecord> {
    let seen = 0;
    for await (const source of this.#recordSources(entry, input.selection)) {
      seen += 1;
      if (signal.aborted) throw cancelled();
      try {
        yield Object.freeze({
          state: "normalized",
          record: normalizeImportRecord({
            record: source,
            selection: input.selection,
            fields: input.fields,
            importBatchId: batchId,
          }),
        });
      } catch (error) {
        if (!(error instanceof KnowledgeImportMappingError)) throw error;
        yield Object.freeze({
          state: "invalid",
          ordinal: source.ordinal,
          location: source.location,
          diagnostics: Object.freeze([diagnosticFromMappingError(error)]),
        });
      }
      if (seen % 256 === 0 && signal.aborted) throw cancelled();
    }
    const finalStamp = await sourceFileStamp(entry.absolutePath);
    if (!sameSourceFileStamp(expectedStamp, finalStamp)) {
      fail(
        "KNOWLEDGE_IMPORT_SOURCE_CHANGED",
        "the source file changed while it was being staged; inspect it again",
      );
    }
  }

  stage(input: StageImportRequest): Promise<StagedImportReport> {
    return this.#withOperation(input.operationId, async (signal) => {
      const entry = this.#entry(input.pendingImportId);
      const storage = this.#requireStorage();
      const batchId = this.#createId();
      if (entry.context === undefined
        || entry.inspectedSourceHash === undefined) {
        fail(
          "KNOWLEDGE_IMPORT_INSPECTION_REQUIRED",
          "inspect the pending file before staging it",
        );
      }
      const beforeHash = await sourceFileStamp(entry.absolutePath);
      const sourceHash = await sourceFileHash(entry.absolutePath, signal);
      const afterHash = await sourceFileStamp(entry.absolutePath);
      if (!sameSourceFileStamp(beforeHash, afterHash)
        || sourceHash !== entry.inspectedSourceHash) {
        fail(
          "KNOWLEDGE_IMPORT_SOURCE_CHANGED",
          "the source file changed after inspection; inspect it again",
        );
      }
      return storage.stageBatch({
        batchId,
        sourceHash,
        sourceName: entry.pending.fileName,
        sourceFormat: entry.pending.format,
        request: input,
        signal,
        records: this.#preparedRecords(
          entry,
          input,
          batchId,
          signal,
          afterHash,
        ),
      });
    });
  }

  async listStaged(): Promise<readonly StagedImportSummary[]> {
    return this.#storage?.listStaged?.() ?? Object.freeze([]);
  }

  getStaged(input: StagedImportPageRequest): Promise<StagedImportReport> {
    const method = this.#requireStorage().getStaged;
    if (method === undefined) {
      return Promise.reject(new KnowledgeImportServiceError(
        "KNOWLEDGE_IMPORT_STORAGE_METHOD_UNAVAILABLE",
        "the storage adapter does not implement getStaged",
      ));
    }
    return method.call(this.#storage, input);
  }

  setDecisions(input: ImportDecisionRequest): Promise<StagedImportReport> {
    const method = this.#requireStorage().setDecisions;
    if (method === undefined) {
      return Promise.reject(new KnowledgeImportServiceError(
        "KNOWLEDGE_IMPORT_STORAGE_METHOD_UNAVAILABLE",
        "the storage adapter does not implement setDecisions",
      ));
    }
    return method.call(this.#storage, input);
  }

  discardStaged(input: DiscardStagedImportRequest): Promise<void> {
    const method = this.#requireStorage().discardStaged;
    if (method === undefined) {
      return Promise.reject(new KnowledgeImportServiceError(
        "KNOWLEDGE_IMPORT_STORAGE_METHOD_UNAVAILABLE",
        "the storage adapter does not implement discardStaged",
      ));
    }
    return method.call(this.#storage, input);
  }

  commit(input: CommitImportRequest): Promise<CommittedImportReport> {
    return this.#withOperation(input.operationId, async (signal) => {
      const method = this.#requireStorage().commitBatch;
      if (method === undefined) {
        fail(
          "KNOWLEDGE_IMPORT_STORAGE_METHOD_UNAVAILABLE",
          "the storage adapter does not implement commitBatch",
        );
      }
      return method.call(this.#storage, { ...input, signal });
    });
  }

  rollback(input: RollbackImportRequest): Promise<RolledBackImportReport> {
    return this.#withOperation(input.operationId, async (signal) => {
      const method = this.#requireStorage().rollbackBatch;
      if (method === undefined) {
        fail(
          "KNOWLEDGE_IMPORT_STORAGE_METHOD_UNAVAILABLE",
          "the storage adapter does not implement rollbackBatch",
        );
      }
      return method.call(this.#storage, { ...input, signal });
    });
  }
}
