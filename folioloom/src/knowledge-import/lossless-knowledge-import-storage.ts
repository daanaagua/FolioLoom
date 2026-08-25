import {
  closeSync,
  openSync,
  readSync,
} from "node:fs";
import {
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../knowledge/knowledge-store.js";
import {
  type CommitStoredKnowledgeImportInput,
  LosslessBookStore,
} from "../storage/lossless-book-store.js";
import { mappingIdentity } from "./field-mapping.js";
import type {
  KnowledgeImportStorageAdapter,
  PreparedImportRecord,
  StageBatchInput,
} from "./knowledge-import-service.js";
import type {
  CommitImportRequest,
  CommittedImportReport,
  DiscardStagedImportRequest,
  ImportDecisionRequest,
  RollbackImportRequest,
  RolledBackImportReport,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "./types.js";

function mappingJson(input: StageBatchInput): string {
  const fields = Object.fromEntries(
    Object.entries(input.request.fields)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  return canonicalJson({
    schema: "folioloom-knowledge-import-mapping-1",
    format: input.sourceFormat,
    selection: input.request.selection,
    fields,
  });
}

function storedMutation(
  runId: string,
  input: CommitImportRequest | RollbackImportRequest,
  signal: AbortSignal,
): CommitStoredKnowledgeImportInput {
  return {
    runId,
    batchId: input.batchId,
    expectedGeneration: input.expectedGeneration,
    expectedSnapshotId: input.expectedSnapshotId,
    signal,
  };
}

const SPOOL_CHUNK_RECORDS = 512;
const SPOOL_READ_BYTES = 1024 * 1024;

function parseSpoolRecord(line: Buffer): PreparedImportRecord {
  return JSON.parse(line.toString("utf8")) as PreparedImportRecord;
}

function* readPreparedSpool(path: string): Generator<PreparedImportRecord> {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(SPOOL_READ_BYTES);
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const incoming = chunk.subarray(0, bytesRead);
      const data = pending.length === 0
        ? incoming
        : Buffer.concat([pending, incoming]);
      let start = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        if (index > start) yield parseSpoolRecord(data.subarray(start, index));
        start = index + 1;
      }
      pending = start === data.length
        ? Buffer.alloc(0)
        : Buffer.from(data.subarray(start));
    }
    if (pending.length > 0) yield parseSpoolRecord(pending);
  } finally {
    closeSync(descriptor);
  }
}

export class LosslessKnowledgeImportStorageAdapter
implements KnowledgeImportStorageAdapter {
  constructor(
    readonly store: LosslessBookStore,
    readonly runId: string,
  ) {}

  async stageBatch(input: StageBatchInput): Promise<StagedImportReport> {
    const canonicalMapping = mappingJson(input);
    const directory = await mkdtemp(join(tmpdir(), "folioloom-import-stage-"));
    const spoolPath = join(directory, "prepared.ndjson");
    const spool = await open(spoolPath, "wx");
    try {
      let buffered: string[] = [];
      for await (const record of input.records) {
        if (input.signal.aborted) throw new Error("knowledge import cancelled");
        buffered.push(`${canonicalJson(record)}\n`);
        if (buffered.length >= SPOOL_CHUNK_RECORDS) {
          await spool.write(buffered.join(""));
          buffered = [];
        }
      }
      if (buffered.length > 0) await spool.write(buffered.join(""));
      await spool.close();
      if (input.signal.aborted) throw new Error("knowledge import cancelled");
      return this.store.stageKnowledgeImport({
        runId: this.runId,
        batchId: input.batchId,
        sourceHash: input.sourceHash,
        sourceName: input.sourceName,
        sourceFormat: input.sourceFormat,
        mappingJson: canonicalMapping,
        mappingHash: mappingIdentity(
          input.sourceFormat,
          input.request.selection,
          input.request.fields,
        ),
        request: input.request,
        records: readPreparedSpool(spoolPath),
      });
    } finally {
      await spool.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async listStaged(): Promise<readonly StagedImportSummary[]> {
    return this.store.listStagedKnowledgeImports(this.runId);
  }

  async getStaged(input: StagedImportPageRequest): Promise<StagedImportReport> {
    return this.store.getStagedKnowledgeImport(this.runId, input);
  }

  async setDecisions(input: ImportDecisionRequest): Promise<StagedImportReport> {
    return this.store.setKnowledgeImportDecisions(this.runId, input);
  }

  async discardStaged(input: DiscardStagedImportRequest): Promise<void> {
    this.store.discardStagedKnowledgeImport(this.runId, input);
  }

  async commitBatch(
    input: CommitImportRequest & { readonly signal: AbortSignal },
  ): Promise<CommittedImportReport> {
    return this.store.commitKnowledgeImport(
      storedMutation(this.runId, input, input.signal),
    );
  }

  async rollbackBatch(
    input: RollbackImportRequest & { readonly signal: AbortSignal },
  ): Promise<RolledBackImportReport> {
    return this.store.rollbackKnowledgeImport(
      storedMutation(this.runId, input, input.signal),
    );
  }
}
