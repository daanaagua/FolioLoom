import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseArgs } from "../src/cli.js";
import { verifyExport } from "../src/export/export-verifier.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import {
  writeLosslessBookArtifacts,
  type LosslessBookArtifactPaths,
} from "../src/report.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function sourceManifest(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "v5-export-verifier-"));
  const payload = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(payload).digest("hex");
  writeFileSync(join(directory, "original.txt"), payload);
  writeFileSync(join(directory, "source.txt"), payload);
  const manifest = join(directory, "source_manifest.json");
  writeFileSync(manifest, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: payload.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    canonical_path: "source.txt",
    canonical_chars: [...source].length,
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: [...source].length,
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: 0,
      raw_end: payload.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  return manifest;
}

function addRun(
  store: LosslessBookStore,
  context: BookContext,
  runId: string,
  translatedWindows: number,
): void {
  const snapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion: context.sourceLedger.sourceVersion,
    protocolVersion: "v5-book-3",
    modelId: `model-${runId}`,
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
    metadata: { fixture: runId },
  });
  const windows = planBookWindows(context.losslessBlocks, {
    protocolVersion: "v5-book-3",
    maxBlocks: 1,
  });
  store.initializeWindowPlan(runId, windows);
  for (const window of windows.slice(0, translatedWindows)) {
    store.bindWindowsToSnapshot(runId, [window.windowId], snapshot.id);
    store.claimWindow(runId, window.windowId);
    store.stageWindow({
      runId,
      windowId: window.windowId,
      snapshotId: snapshot.id,
      status: "completed",
      translations: window.blockIds.map((blockId) => {
        const block = context.losslessBlocks.find((item) => item.id === blockId)!;
        return { blockId, sourceHash: block.sourceHash, text: `${runId}-${block.globalIndex}` };
      }),
      knowledgeCandidates: [],
      styleTail: "",
      budget: {},
      warnings: [],
    });
    store.promoteStagedWindow(runId, window.windowId);
  }
}

function fixture(): {
  store: LosslessBookStore;
  context: BookContext;
  output: string;
} {
  const manifest = sourceManifest(`${"A".repeat(3_500)}\n\n${"B".repeat(3_500)}`);
  const context = BookContext.openLossless({ manifestPath: manifest });
  const store = new LosslessBookStore(join(dirname(manifest), "book.db"));
  store.registerSource(context.certifiedSource!);
  store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
    annotations: context.annotations,
    blocks: context.losslessBlocks,
  });
  return { store, context, output: join(dirname(manifest), "out") };
}

function storedZipEntry(name: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(payload.length, 18);
  header.writeUInt32LE(payload.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([header, nameBytes, payload]);
}

test("lossless export writes stable lineage sidecars and verifier detects tampering", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    const paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);
    const translationLineage = JSON.parse(readFileSync(paths.translationLineage, "utf8"));
    const bilingualLineage = JSON.parse(readFileSync(paths.bilingualLineage, "utf8"));
    const auditLineage = JSON.parse(readFileSync(paths.auditLineage, "utf8"));
    assert.deepEqual(translationLineage, bilingualLineage);
    assert.deepEqual(translationLineage, auditLineage);
    assert.equal(translationLineage.schema, "v5-book-lineage-1");
    assert.equal(translationLineage.runId, "run-a");
    assert.equal(translationLineage.complete, true);
    assert.deepEqual(
      translationLineage.blocks.map((block: { ordinal: number }) => block.ordinal),
      [0, 1],
    );
    assert.equal(verifyExport(paths, item.store, "run-a").ok, true);

    translationLineage.blocks[0].sourceHash = "bad-hash";
    writeFileSync(paths.translationLineage, JSON.stringify(translationLineage), "utf8");
    const verification = verifyExport(paths, item.store, "run-a");
    assert.equal(verification.ok, false);
    assert.ok(verification.incidentCodes.includes("LINEAGE_MISMATCH"));
  } finally {
    item.store.close();
    item.context.close();
  }
});

test("partial lineage is explicit and selected run never mixes another run", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", 1);
    addRun(item.store, item.context, "run-b", item.context.losslessBlocks.length);
    const paths = writeLosslessBookArtifacts(item.store, "run-a", item.output, {
      allowIncomplete: true,
    });
    const lineage = JSON.parse(readFileSync(paths.translationLineage, "utf8"));
    assert.equal(lineage.complete, false);
    assert.equal(lineage.missingBlockIds.length, 1);
    const translation = readFileSync(paths.translation, "utf8");
    assert.match(translation, /run-a-0/u);
    assert.doesNotMatch(translation, /run-b/u);
    assert.equal(verifyExport(paths, item.store, "run-a").ok, true);
  } finally {
    item.store.close();
    item.context.close();
  }
});

test("verifier rejects lineage from a different run", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    addRun(item.store, item.context, "run-b", item.context.losslessBlocks.length);
    const pathsA = writeLosslessBookArtifacts(item.store, "run-a", join(item.output, "a"));
    const pathsB = writeLosslessBookArtifacts(item.store, "run-b", join(item.output, "b"));
    const mixed: LosslessBookArtifactPaths = {
      ...pathsA,
      bilingualLineage: pathsB.bilingualLineage,
    };
    const verification = verifyExport(mixed, item.store, "run-a");
    assert.equal(verification.ok, false);
    assert.ok(verification.incidentCodes.includes("RUN_MISMATCH"));
  } finally {
    item.store.close();
    item.context.close();
  }
});

test("verifier checks the EPUB embedded lineage projection", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    const paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);
    const epub = join(item.output, "book.epub");
    writeFileSync(epub, storedZipEntry(
      "META-INF/v5-lineage.json",
      Buffer.from(readFileSync(paths.translationLineage, "utf8"), "utf8"),
    ));
    assert.equal(verifyExport({ ...paths, epub }, item.store, "run-a").ok, true);

    writeFileSync(epub, storedZipEntry(
      "META-INF/v5-lineage.json",
      Buffer.from('{"schema":"v5-book-lineage-1","runId":"run-b"}', "utf8"),
    ));
    const verification = verifyExport({ ...paths, epub }, item.store, "run-a");
    assert.equal(verification.ok, false);
    assert.ok(verification.incidentCodes.includes("EPUB_LINEAGE_MISMATCH"));
  } finally {
    item.store.close();
    item.context.close();
  }
});

test("CLI parses verify-export with an optional EPUB", () => {
  assert.deepEqual(parseArgs([
    "book", "verify-export", "--store", "book.db", "--run", "run-a",
    "--output", "exports", "--epub", "book.epub",
  ]), {
    command: "book-verify-export",
    store: join(process.cwd(), "book.db"),
    runId: "run-a",
    output: join(process.cwd(), "exports"),
    epub: join(process.cwd(), "book.epub"),
  });
});
