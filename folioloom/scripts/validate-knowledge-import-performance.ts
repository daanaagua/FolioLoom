import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { KnowledgeImportService } from "../src/knowledge-import/knowledge-import-service.js";
import { LosslessKnowledgeImportStorageAdapter } from "../src/knowledge-import/lossless-knowledge-import-storage.js";
import type { ImportFieldMapping } from "../src/knowledge-import/types.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { blockId } from "../src/source/block-builder.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
} from "../src/storage/lossless-book-store.js";

const ROWS = 100_000;

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

const directory = await mkdtemp(join(tmpdir(), "folioloom-import-perf-"));
const csvPath = join(directory, "terms.csv");
const storePath = join(directory, "book.db");
let store: LosslessBookStore | undefined;

try {
  const csv = [
    "source,target",
    ...Array.from({ length: ROWS }, (_item, index) => {
      const suffix = index.toString().padStart(6, "0");
      return `Term-${suffix},术语-${suffix}`;
    }),
    "",
  ].join("\n");
  await writeFile(csvPath, csv, "utf8");

  const sourceText = "source";
  const sourceVersion = "knowledge-import-performance-source";
  const runId = "knowledge-import-performance-run";
  const source: CertifiedSourceInput = {
    sourceVersion,
    rawSha256: sha256(sourceText),
    canonicalSha256: sha256(sourceText),
    canonicalChars: sourceText.length,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "synthetic-performance-validation",
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
    protocolVersion: "knowledge-import-performance",
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
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const report = await service.stage({
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
  const elapsedMs = performance.now() - started;
  const rssAfter = process.memoryUsage().rss;
  const maxRss = process.resourceUsage().maxRSS;
  if (report.counts.ready !== ROWS || report.unresolved !== 0) {
    throw new Error(`unexpected staging result: ${JSON.stringify(report.counts)}`);
  }
  process.stdout.write(`${JSON.stringify({
    rows: ROWS,
    elapsedMs: Math.round(elapsedMs),
    rowsPerSecond: Math.round(ROWS / (elapsedMs / 1_000)),
    rssBeforeBytes: rssBefore,
    rssAfterBytes: rssAfter,
    maxRssPlatformUnits: maxRss,
    databaseBytes: (await stat(storePath)).size,
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
