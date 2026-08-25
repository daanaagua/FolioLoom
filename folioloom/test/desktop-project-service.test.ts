import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { doctorBook } from "../src/cli.js";
import { BookContext } from "../src/fullbook/book-context.js";
import type { BookWindowPlan } from "../src/fullbook/types.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import type { LosslessBlock } from "../src/source/types.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { DesktopProjectService } from "../src/desktop/desktop-project-service.js";

const SOURCE = "Chapter I\n\nAlpha.\n\nChapter II\n\nBeta.";

interface DesktopFixtureOptions {
  runIds?: readonly string[];
  completeFirstWindow?: boolean;
  foreignRun?: boolean;
  sourceLanguage?: string;
}

interface DesktopFixture {
  directory: string;
  manifestPath: string;
  storePath: string;
  glossaryPath: string;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function windowsFor(blocks: readonly LosslessBlock[]): BookWindowPlan[] {
  return blocks.map((block, ordinal) => ({
    windowId: `window-${ordinal}`,
    ordinal,
    chapterId: block.structureId ?? `chapter-${ordinal}`,
    chapterTitle: block.structureTitle,
    blockIds: [block.id],
    globalIndexes: [block.globalIndex],
    sourceTokens: block.tokenCount,
    sourceChars: block.canonicalEnd - block.canonicalStart,
    oversized: false,
  }));
}

function createFixture(options: DesktopFixtureOptions = {}): DesktopFixture {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-project-"));
  const rawPath = join(directory, "original.txt");
  const canonicalPath = join(directory, "source.txt");
  const manifestPath = join(directory, "source_manifest.json");
  const storePath = join(directory, "book.db");
  const glossaryPath = join(directory, "glossary.json");
  const source = Buffer.from(SOURCE, "utf8");
  writeFileSync(rawPath, source);
  writeFileSync(canonicalPath, source);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: source.length,
    raw_sha256: sha256(source),
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: options.sourceLanguage ?? "en",
    canonical_path: "source.txt",
    canonical_chars: [...SOURCE].length,
    canonical_sha256: sha256(source),
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: [...SOURCE].length,
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      transformation: "decode+newline-normalize",
      raw_start: 0,
      raw_end: source.length,
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  writeFileSync(glossaryPath, JSON.stringify({
    Alpha: "阿尔法",
    Absent: "缺席者",
  }), "utf8");

  const runIds = options.runIds ?? [];
  if (runIds.length > 0 || options.foreignRun) {
    const context = BookContext.openLossless({ manifestPath });
    const blocks = context.losslessBlocks;
    const annotations = context.annotations;
    const certifiedSource = context.certifiedSource;
    const ledger = context.sourceLedger;
    const windows = windowsFor(blocks);
    context.close();
    assert.equal(windows.length, 2, "fixture must produce two logical windows");

    const store = new LosslessBookStore(storePath);
    try {
      if (runIds.length > 0) {
        store.registerSource(certifiedSource!);
        store.replaceDerivedPlan(certifiedSource!.sourceVersion, { blocks, annotations });
        for (const runId of runIds) {
          const snapshotId = `snapshot-${runId}`;
          store.createTranslationRun({
            runId,
            sourceVersion: certifiedSource!.sourceVersion,
            protocolVersion: "lossless-v5-1",
            modelId: "desktop-test-model",
            initialSnapshotId: snapshotId,
            metadata: { fixture: runId },
          });
          store.initializeWindowPlan(runId, windows);
        }
      }
      if (options.completeFirstWindow) {
        const runId = runIds[0] as string;
        const firstWindow = windows[0] as BookWindowPlan;
        const sourceById = new Map(blocks.map((block) => [block.id, block]));
        store.claimWindow(runId, firstWindow.windowId);
        store.stageWindow({
          runId,
          windowId: firstWindow.windowId,
          snapshotId: `snapshot-${runId}`,
          status: "completed",
          translations: firstWindow.blockIds.map((blockId) => {
            const block = sourceById.get(blockId) as LosslessBlock;
            return { blockId, sourceHash: block.sourceHash, text: `译文：${block.sourceText}` };
          }),
          knowledgeCandidates: [],
          styleTail: "",
          budget: { modelCalls: 1 },
          warnings: [],
        });
        store.promoteStagedWindow(runId, firstWindow.windowId);
      }
      if (options.foreignRun) {
        const foreignSourceVersion = `${certifiedSource!.sourceVersion}-foreign`;
        const foreignBlocks = buildLosslessBlocks(ledger, annotations, {
          sourceVersion: foreignSourceVersion,
        });
        const foreignWindows = windowsFor(foreignBlocks);
        store.registerSource({ ...certifiedSource!, sourceVersion: foreignSourceVersion });
        store.replaceDerivedPlan(foreignSourceVersion, {
          blocks: foreignBlocks,
          annotations,
        });
        store.createTranslationRun({
          runId: "run-foreign",
          sourceVersion: foreignSourceVersion,
          protocolVersion: "lossless-v5-1",
          modelId: "desktop-test-model",
          initialSnapshotId: "snapshot-run-foreign",
          metadata: { fixture: "foreign" },
        });
        store.initializeWindowPlan("run-foreign", foreignWindows);
      }
    } finally {
      store.close();
    }
  }

  return { directory, manifestPath, storePath, glossaryPath };
}

test("snapshot exposes reader-facing source diagnostics without internal project paths", () => {
  const fixture = createFixture();
  try {
    const result = new DesktopProjectService().snapshot({
      manifestPath: fixture.manifestPath,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.store.state, "not_found");
      assert.equal(result.value.runSelection, "none");
      assert.equal(result.value.sourceLanguage, "en");
      assert.equal(result.value.detectedLanguage, "英语");
      assert.equal(result.value.sourceEncoding, "utf-8");
      assert.equal(result.value.encodingConfidence, 1);
      assert.equal(result.value.languageProfileVersion, "source-language-profile-5");
      assert.equal(result.value.title, "original");
      assert.equal("manifestPath" in result.value, false);
      assert.equal("glossaryPath" in result.value, false);
      assert.equal("path" in result.value.store, false);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("snapshot localizes Japanese and Korean source profiles for the reader", () => {
  const japanese = createFixture({ sourceLanguage: "ja" });
  const korean = createFixture({ sourceLanguage: "ko" });
  try {
    const service = new DesktopProjectService();
    const japaneseResult = service.snapshot({ manifestPath: japanese.manifestPath });
    const koreanResult = service.snapshot({ manifestPath: korean.manifestPath });
    assert.equal(japaneseResult.ok, true);
    assert.equal(koreanResult.ok, true);
    if (japaneseResult.ok) assert.equal(japaneseResult.value.detectedLanguage, "日语");
    if (koreanResult.ok) assert.equal(koreanResult.value.detectedLanguage, "韩语");
  } finally {
    rmSync(japanese.directory, { recursive: true, force: true });
    rmSync(korean.directory, { recursive: true, force: true });
  }
});

test("snapshot rejects an automatically discovered database reparse point outside the project", () => {
  const fixture = createFixture();
  const externalDirectory = mkdtempSync(join(tmpdir(), "folioloom-external-store-"));
  try {
    const externalStoreDirectory = join(externalDirectory, "folioloom");
    const externalStorePath = join(externalStoreDirectory, "book.db");
    mkdirSync(externalStoreDirectory, { recursive: true });
    const externalStore = new LosslessBookStore(externalStorePath);
    externalStore.close();
    symlinkSync(externalDirectory, join(fixture.directory, "artifacts"), "junction");

    const result = new DesktopProjectService().snapshot({
      manifestPath: fixture.manifestPath,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DESKTOP_INPUT_INVALID");
      assert.match(result.error.message, /project directory/);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(externalDirectory, { recursive: true, force: true });
  }
});

test("snapshot validates a discovered database suffix after resolving a file link", (t) => {
  const fixture = createFixture();
  const nonDatabasePath = join(fixture.directory, "outside-store.txt");
  try {
    writeFileSync(nonDatabasePath, "not a SQLite database", "utf8");
    try {
      symlinkSync(nonDatabasePath, fixture.storePath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM"
        || (error as NodeJS.ErrnoException).code === "EACCES") {
        t.skip("file symlinks are unavailable in this Windows environment");
        return;
      }
      throw error;
    }

    const result = new DesktopProjectService().snapshot({
      manifestPath: fixture.manifestPath,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DESKTOP_INPUT_INVALID");
      assert.match(result.error.message, /storePath must identify a \.db file/);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("snapshot permits an explicitly selected database outside the project", () => {
  const fixture = createFixture();
  const externalDirectory = mkdtempSync(join(tmpdir(), "folioloom-external-store-"));
  const externalStorePath = join(externalDirectory, "book.db");
  try {
    const externalStore = new LosslessBookStore(externalStorePath);
    externalStore.close();

    const result = new DesktopProjectService().snapshot({
      manifestPath: fixture.manifestPath,
      storePath: externalStorePath,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.store, { state: "ready" });
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(externalDirectory, { recursive: true, force: true });
  }
});

test("snapshot uses the sole matching run and reports true counters", () => {
  const fixture = createFixture({
    runIds: ["run-desktop"],
    completeFirstWindow: true,
  });
  try {
    const result = new DesktopProjectService().snapshot({
      manifestPath: fixture.manifestPath,
      storePath: fixture.storePath,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.selectedRunId, "run-desktop");
      assert.deepEqual(result.value.runs[0]?.progress, {
        totalWindows: 2,
        pendingWindows: 1,
        completedWindows: 1,
        warningWindows: 0,
        humanRequiredWindows: 0,
        failedWindows: 0,
      });
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("snapshot requires an explicit selection for multiple matching runs", () => {
  const fixture = createFixture({ runIds: ["run-left", "run-right"] });
  try {
    const service = new DesktopProjectService();
    const result = service.snapshot({
      manifestPath: fixture.manifestPath,
      storePath: fixture.storePath,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.runSelection, "required");
      assert.equal(result.value.selectedRunId, undefined);
    }

    const selected = service.snapshot({
      manifestPath: fixture.manifestPath,
      storePath: fixture.storePath,
      runId: "run-right",
    });
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.equal(selected.value.runSelection, "selected");
      assert.equal(selected.value.selectedRunId, "run-right");
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("resolves one trusted knowledge target without returning it through snapshot", () => {
  const fixture = createFixture({ runIds: ["run-a"] });
  try {
    const service = new DesktopProjectService();
    const target = service.resolveKnowledgeTarget({
      manifestPath: fixture.manifestPath,
      storePath: fixture.storePath,
    });
    assert.equal(target.ok, true);
    if (target.ok) {
      assert.equal(target.value.storePath, fixture.storePath);
      assert.equal(target.value.runId, "run-a");
      assert.equal(typeof target.value.sourceVersion, "string");
      assert.equal(target.value.sourceLanguage, "en");
    }
    const snapshot = service.snapshot({
      manifestPath: fixture.manifestPath,
      storePath: fixture.storePath,
    });
    assert.equal(JSON.stringify(snapshot).includes(fixture.storePath), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("snapshot marks stores with only foreign source runs invalid", () => {
  const fixture = createFixture({ foreignRun: true });
  try {
    const result = new DesktopProjectService().snapshot({
      manifestPath: fixture.manifestPath,
      storePath: fixture.storePath,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.store.state, "invalid");
      assert.equal(result.value.store.error?.code, "SOURCE_VERSION_MISMATCH");
      assert.equal(result.value.runSelection, "none");
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("doctor calls no provider and preserves the glossary report", () => {
  const fixture = createFixture();
  try {
    let doctorCalls = 0;
    const service = new DesktopProjectService({
      doctor: (manifestPath, options, glossaryPath) => {
        doctorCalls += 1;
        return doctorBook(manifestPath, options, glossaryPath);
      },
    });
    const result = service.doctor({
      manifestPath: fixture.manifestPath,
      glossaryPath: fixture.glossaryPath,
    });
    assert.equal(result.ok, true);
    assert.equal(doctorCalls, 1);
    if (result.ok) {
      assert.equal(result.value.coveredChars, result.value.sourceChars);
      assert.equal(result.value.anomalyCount, 0);
      assert.deepEqual(result.value.glossary, {
        path: fixture.glossaryPath,
        totalTerms: 2,
        matchedTerms: 1,
        unmatchedTerms: 1,
        unmatchedForms: ["Absent"],
      });
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
