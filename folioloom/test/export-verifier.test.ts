import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseArgs } from "../src/cli.js";
import { writeLosslessBookEpub } from "../src/export/epub-writer.js";
import { verifyExport } from "../src/export/export-verifier.js";
import {
  readStoredZipEntries,
  writeStoredZip,
} from "../src/export/stored-zip.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import {
  renderTranslation,
  schedulerMetrics,
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

test("lossless translation rendering does not leak or duplicate source-language headings", () => {
  const rendered = renderTranslation([{
    blockId: "block-heading",
    globalIndex: 0,
    chapterId: "chapter-at-0",
    chapterTitle: "■ 운명의 시작 □",
    sourceText: "■ 운명의 시작 □",
    text: "■ 命运的开端 □",
  }], { includeChapterMetadata: false });

  assert.equal(rendered, "■ 命运的开端 □\n");
  assert.doesNotMatch(rendered, /운명의 시작|chapter-at-0/u);
});

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

test("verifier detects tampering in each rendered text artifact", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    let paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);

    writeFileSync(paths.translation, "tampered translation\n", "utf8");
    assert.ok(
      verifyExport(paths, item.store, "run-a").incidentCodes
        .includes("TRANSLATION_CONTENT_MISMATCH"),
    );

    paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);
    writeFileSync(paths.bilingual, "tampered bilingual\n", "utf8");
    assert.ok(
      verifyExport(paths, item.store, "run-a").incidentCodes
        .includes("BILINGUAL_CONTENT_MISMATCH"),
    );

    paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);
    writeFileSync(paths.audit, '{"schema":"tampered"}\n', "utf8");
    assert.ok(
      verifyExport(paths, item.store, "run-a").incidentCodes
        .includes("AUDIT_CONTENT_MISMATCH"),
    );
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

test("partial scheduler report contains only aggregate execution metrics", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", 1);
    const scheduler = {
      mode: "shadow" as const,
      profile: "balanced" as const,
      planningStatus: "shadow" as const,
      decisions: 2,
      fallbacks: 0,
      baselineWallTimeMs: 2_400,
      predictedWallTimeMs: 1_200,
      actualWallTimeMs: 1_350,
      baselineTokens: 780,
      allowedTokens: 858,
      predictedTokens: 800,
      actualTokens: 820,
      tokenUsageComplete: true,
      contextProfiles: { "window-a": "lean" as const },
      effortCounts: { high: 1 },
      protocolCounts: {
        typed_tool: 1,
        framed_text: 0,
        local: 0,
      },
      plannerDeadlines: 0,
      throttles: 0,
      recoveries: 0,
    };
    const paths = writeLosslessBookArtifacts(
      item.store,
      "run-a",
      item.output,
      { allowIncomplete: true, scheduler },
    );

    const metrics = JSON.parse(readFileSync(paths.metrics, "utf8")) as {
      scheduler?: unknown;
    };
    assert.deepEqual(metrics.scheduler, schedulerMetrics(scheduler));
    assert.doesNotMatch(
      JSON.stringify(metrics.scheduler),
      /sourceText|prompt|translation/u,
    );
  } finally {
    item.store.close();
    item.context.close();
  }
});

test("strict export fails closed when durable provider usage is incomplete", () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    item.store.appendTokenLedgerEvent("run-a", {
      type: "baseline_added",
      taskIds: ["translate-window:one"],
      baselineTokens: 1_000,
      source: "translate_horizon",
      reason: "fixture",
    });
    item.store.appendTokenLedgerEvent("run-a", {
      type: "reserved",
      requestId: "attempt-one",
      purpose: "translate",
      taskIds: ["translate-window:one"],
      predictedTokens: 300,
      attempt: 0,
    });
    item.store.appendTokenLedgerEvent("run-a", {
      type: "dispatched",
      requestId: "attempt-one",
    });
    item.store.appendTokenLedgerEvent("run-a", {
      type: "settled",
      requestId: "attempt-one",
      actualTokens: 120,
      usageComplete: false,
      outcome: "failed",
    });
    const ledger = item.store.loadTokenLedger("run-a", {
      mode: "active",
      profile: "balanced",
      tokenIncreaseCap: 0.1,
      enforceDispatchLifecycle: true,
    });
    item.store.saveSchedulerRunProjection(
      "run-a",
      ledger.toSchedulerRunReport(),
    );

    assert.throws(
      () => writeLosslessBookArtifacts(item.store, "run-a", item.output),
      /TOKEN_USAGE_INCOMPLETE/u,
    );
    const paths = writeLosslessBookArtifacts(
      item.store,
      "run-a",
      item.output,
      { allowIncomplete: true },
    );
    const audit = JSON.parse(readFileSync(paths.audit, "utf8")) as {
      complete: boolean;
      strictExportable: boolean;
      incidentCodes: string[];
    };
    assert.equal(audit.complete, false);
    assert.equal(audit.strictExportable, false);
    assert.ok(audit.incidentCodes.includes("TOKEN_USAGE_INCOMPLETE"));
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

test("verifier checks the EPUB embedded lineage projection", async () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    const paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);
    const epub = join(item.output, "book.epub");
    await writeLosslessBookEpub(item.store, "run-a", epub, {
      title: "Verified export",
      language: "zh-CN",
    });
    assert.equal(verifyExport({ ...paths, epub }, item.store, "run-a").ok, true);

    const entries = readStoredZipEntries(epub).map((entry) => ({
      name: entry.name,
      data: entry.name === "META-INF/v5-lineage.json"
        ? '{"schema":"v5-book-lineage-1","runId":"run-b"}'
        : entry.data,
    }));
    writeStoredZip(epub, entries);
    const verification = verifyExport({ ...paths, epub }, item.store, "run-a");
    assert.equal(verification.ok, false);
    assert.ok(verification.incidentCodes.includes("EPUB_LINEAGE_MISMATCH"));
  } finally {
    item.store.close();
    item.context.close();
  }
});

test("verifier rejects malformed EPUB mimetype, package, and navigation", async () => {
  const item = fixture();
  try {
    addRun(item.store, item.context, "run-a", item.context.losslessBlocks.length);
    const paths = writeLosslessBookArtifacts(item.store, "run-a", item.output);
    const epub = join(item.output, "book.epub");
    await writeLosslessBookEpub(item.store, "run-a", epub, {
      title: "Verified export",
      language: "zh-CN",
    });
    const original = readStoredZipEntries(epub);

    writeStoredZip(epub, original.map((entry) => ({
      name: entry.name,
      data: entry.name === "mimetype" ? "application/zip" : entry.data,
    })));
    assert.ok(
      verifyExport({ ...paths, epub }, item.store, "run-a").incidentCodes
        .includes("EPUB_MIMETYPE_INVALID"),
    );

    writeStoredZip(epub, original.map((entry) => ({
      name: entry.name,
      data: entry.name === "META-INF/container.xml"
        ? '<?xml version="1.0"?><container><rootfiles/></container>'
        : entry.data,
    })));
    assert.ok(
      verifyExport({ ...paths, epub }, item.store, "run-a").incidentCodes
        .includes("EPUB_PACKAGE_INVALID"),
    );

    writeStoredZip(epub, original.map((entry) => ({
      name: entry.name,
      data: entry.name === "EPUB/nav.xhtml"
        ? entry.data.toString("utf8").replace("section-1.xhtml", "missing.xhtml")
        : entry.data,
    })));
    assert.ok(
      verifyExport({ ...paths, epub }, item.store, "run-a").incidentCodes
        .includes("EPUB_NAVIGATION_INVALID"),
    );

    writeStoredZip(epub, original.map((entry) => ({
      name: entry.name,
      data: /^EPUB\/section-\d+\.xhtml$/u.test(entry.name)
        ? entry.data.toString("utf8").replace('href="styles.css"', 'href="missing.css"')
        : entry.data,
    })));
    assert.ok(
      verifyExport({ ...paths, epub }, item.store, "run-a").incidentCodes
        .includes("EPUB_LINK_INVALID"),
    );
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
