import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { KnowledgeImportService } from "../src/knowledge-import/knowledge-import-service.js";
import { LosslessKnowledgeImportStorageAdapter } from "../src/knowledge-import/lossless-knowledge-import-storage.js";
import type { ImportFieldMapping } from "../src/knowledge-import/types.js";
import { KnowledgeQueryService } from "../src/knowledge/knowledge-query.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { blockId } from "../src/source/block-builder.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
} from "../src/storage/lossless-book-store.js";

const requestedRecords = Number(process.env.FOLIOLOOM_PERF_RECORDS ?? "50000");
if (!Number.isSafeInteger(requestedRecords)
  || requestedRecords < 1
  || requestedRecords > 50_000) {
  throw new Error("FOLIOLOOM_PERF_RECORDS must be an integer from 1 to 50000");
}
const RECORDS = requestedRecords;
const MAX_QUERY_MS = 250;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapping(targetField: string, sourceColumn: string): ImportFieldMapping {
  return {
    targetField,
    sourceColumn,
    confidence: "high",
    confirmed: true,
  };
}

function measure<T>(operation: () => T): { readonly value: T; readonly elapsedMs: number } {
  const started = performance.now();
  const value = operation();
  return { value, elapsedMs: performance.now() - started };
}

function requireFast(label: string, elapsedMs: number): void {
  if (elapsedMs > MAX_QUERY_MS) {
    throw new Error(`${label} exceeded ${MAX_QUERY_MS}ms: ${elapsedMs.toFixed(1)}ms`);
  }
}

const directory = await mkdtemp(join(tmpdir(), "folioloom-workbench-perf-"));
const csvPath = join(directory, "terms.csv");
const storePath = join(directory, "book.db");
let store: LosslessBookStore | undefined;

try {
  await writeFile(csvPath, [
    "source,target",
    ...Array.from({ length: RECORDS }, (_item, index) => {
      const suffix = index.toString().padStart(5, "0");
      return `Term-${suffix},术语-${suffix}`;
    }),
    "",
  ].join("\n"), "utf8");

  const sourceText = "source";
  const sourceVersion = "knowledge-workbench-performance-source";
  const runId = "knowledge-workbench-performance-run";
  const source: CertifiedSourceInput = {
    sourceVersion,
    rawSha256: sha256(sourceText),
    canonicalSha256: sha256(sourceText),
    canonicalChars: sourceText.length,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "synthetic-workbench-performance",
    ranges: [{
      rangeId: "source-range",
      canonicalStart: 0,
      canonicalEnd: sourceText.length,
      originKind: "text",
      originRef: "synthetic.txt",
      transformation: "identity",
    }],
  };
  store = new LosslessBookStore(storePath);
  store.registerSource(source);
  store.replaceDerivedPlan(sourceVersion, {
    blocks: [{
      id: blockId(sourceVersion, 0, sourceText.length, sourceText),
      sourceVersion,
      canonicalStart: 0,
      canonicalEnd: sourceText.length,
      sourceText,
      sourceHash: sha256(sourceText),
      globalIndex: 0,
      tokenCount: 1,
      structureId: null,
      structureTitle: null,
    }],
    annotations: [],
  });
  const initial = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion,
    protocolVersion: "knowledge-workbench-performance",
    modelId: "none",
    initialSnapshotId: initial.id,
    initialSnapshot: initial,
  });
  const service = new KnowledgeImportService({
    storage: new LosslessKnowledgeImportStorageAdapter(store, runId),
  });
  const pending = service.registerPending(csvPath);
  const inspection = await service.inspect({
    pendingImportId: pending.pendingImportId,
    operationId: randomUUID(),
  });
  if (inspection.status !== "ready") {
    throw new Error("synthetic UTF-8 CSV unexpectedly required encoding confirmation");
  }
  const stageStarted = performance.now();
  const staged = await service.stage({
    pendingImportId: pending.pendingImportId,
    operationId: randomUUID(),
    expectedGeneration: 0,
    expectedSnapshotId: initial.id,
    selection: {
      objectType: "term",
      scope: "book",
      headerRow: 1,
    },
    fields: {
      source: mapping("source", "column:0"),
      target: mapping("target", "column:1"),
    },
  });
  const stageMs = performance.now() - stageStarted;
  process.stderr.write(`staged ${RECORDS} records in ${stageMs.toFixed(0)}ms\n`);
  if (staged.counts.ready !== RECORDS || staged.unresolved !== 0) {
    throw new Error(`unexpected staging result: ${JSON.stringify(staged.counts)}`);
  }
  const commitStarted = performance.now();
  const committed = await service.commit({
    batchId: staged.batchId,
    operationId: randomUUID(),
    expectedGeneration: 0,
    expectedSnapshotId: initial.id,
  });
  const commitMs = performance.now() - commitStarted;
  process.stderr.write(`committed ${RECORDS} records in ${commitMs.toFixed(0)}ms\n`);
  if (committed.committed !== RECORDS) {
    throw new Error(`unexpected committed record count: ${committed.committed}`);
  }

  const sourceAdapter = store.knowledgeQuerySource(runId);
  const query = new KnowledgeQueryService(sourceAdapter);
  const first = measure(() => query.list({ limit: 50 }));
  const next = measure(() => query.list({
    limit: 50,
    ...(first.value.nextCursor === null ? {} : { cursor: first.value.nextCursor }),
  }));
  const lastSuffix = (RECORDS - 1).toString().padStart(5, "0");
  const searched = measure(() => query.list({
    search: `Term-${lastSuffix}`,
    limit: 50,
  }));
  const firstId = first.value.items[0]?.id;
  if (firstId === undefined || first.value.nextCursor === null
    || next.value.items.length !== 50
    || searched.value.items.length !== 1) {
    throw new Error("knowledge workbench pagination or search result was incomplete");
  }
  const detail = measure(() => query.detail(firstId));
  const diagnostics = measure(() => sourceAdapter.knowledgeDiagnostics?.());
  if (detail.value.current.id !== firstId
    || diagnostics.value?.countsByType.term !== RECORDS) {
    throw new Error("knowledge detail or diagnostics result was incomplete");
  }
  for (const [label, elapsedMs] of [
    ["firstPageMs", first.elapsedMs],
    ["nextPageMs", next.elapsedMs],
    ["detailMs", detail.elapsedMs],
  ] as const) {
    requireFast(label, elapsedMs);
  }

  process.stdout.write(`${JSON.stringify({
    records: RECORDS,
    stageMs: Math.round(stageMs),
    commitMs: Math.round(commitMs),
    firstPageMs: Number(first.elapsedMs.toFixed(2)),
    nextPageMs: Number(next.elapsedMs.toFixed(2)),
    searchMs: Number(searched.elapsedMs.toFixed(2)),
    detailMs: Number(detail.elapsedMs.toFixed(2)),
    diagnosticsMs: Number(diagnostics.elapsedMs.toFixed(2)),
    databaseBytes: (await stat(storePath)).size,
    thresholdMs: MAX_QUERY_MS,
  }, null, 2)}\n`);
} finally {
  store?.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
