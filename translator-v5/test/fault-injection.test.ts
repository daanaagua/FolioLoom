import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { cliErrorPayload } from "../src/cli.js";
import {
  BookStorageIncidentError,
  runBook,
} from "../src/fullbook/book-runner.js";
import type { BookWindowPlan } from "../src/fullbook/types.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { auditLosslessBookStore } from "../src/report.js";
import { blockId, buildLosslessBlocks } from "../src/source/block-builder.js";
import { SourceLedger } from "../src/source/source-ledger.js";
import { annotateStructure } from "../src/source/structure-annotator.js";
import { scalarLength, type LosslessBlock } from "../src/source/types.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
  type FaultCheckpoint,
  type FaultInjector,
  type WindowStageInput,
} from "../src/storage/lossless-book-store.js";

const SOURCE = "Alpha.Beta.";
const CHECKPOINTS = [
  "after_stage",
  "before_translation_insert",
  "before_promote",
  "before_commit",
] as const satisfies readonly FaultCheckpoint[];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceInput(): CertifiedSourceInput {
  return {
    sourceVersion: "source-v1",
    rawSha256: sha256(SOURCE),
    canonicalSha256: sha256(SOURCE),
    canonicalChars: scalarLength(SOURCE),
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    ranges: [{
      rangeId: "range-0",
      canonicalStart: 0,
      canonicalEnd: scalarLength(SOURCE),
      originKind: "decoded_bytes",
      originRef: "original.txt",
      transformation: "decode+newline-normalize",
    }],
  };
}

function blocks(): LosslessBlock[] {
  return ["Alpha.", "Beta."].map((text, index) => {
    const start = index === 0 ? 0 : 6;
    const end = start + scalarLength(text);
    return {
      id: blockId("source-v1", start, end, text),
      sourceVersion: "source-v1",
      canonicalStart: start,
      canonicalEnd: end,
      sourceText: text,
      sourceHash: sha256(text),
      globalIndex: index,
      tokenCount: 2,
      structureId: null,
      structureTitle: null,
    };
  });
}

function window(): BookWindowPlan {
  return {
    windowId: "window-0",
    ordinal: 0,
    chapterId: "chapter-0",
    chapterTitle: "One",
    blockIds: blocks().map((block) => block.id),
    globalIndexes: [0, 1],
    sourceTokens: 4,
    sourceChars: scalarLength(SOURCE),
    oversized: false,
  };
}

function stage(snapshotId: string): WindowStageInput {
  return {
    runId: "run-a",
    windowId: "window-0",
    snapshotId,
    status: "completed",
    translations: blocks().map((block) => ({
      blockId: block.id,
      sourceHash: block.sourceHash,
      text: `译文-${block.globalIndex}`,
    })),
    knowledgeCandidates: [],
    styleTail: "",
    budget: { modelCalls: 1 },
    warnings: [],
  };
}

function initializeStore(path: string, injector?: FaultInjector): {
  store: LosslessBookStore;
  snapshotId: string;
} {
  const store = new LosslessBookStore(path, injector);
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });
  const snapshot = createKnowledgeSnapshot("run-a", []);
  store.createTranslationRun({
    runId: "run-a",
    sourceVersion: "source-v1",
    protocolVersion: "v5-book-3",
    modelId: "fixture-model",
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
  });
  store.initializeWindowPlan("run-a", [window()]);
  store.bindWindowsToSnapshot("run-a", ["window-0"], snapshot.id);
  store.claimWindow("run-a", "window-0");
  return { store, snapshotId: snapshot.id };
}

function finish(store: LosslessBookStore, snapshotId: string): void {
  store.stageWindow(stage(snapshotId));
  store.promoteStagedWindow("run-a", "window-0");
}

function finalProjection(path: string): unknown {
  const store = new LosslessBookStore(path);
  try {
    return {
      translations: store.activeTranslations("run-a"),
      audit: auditLosslessBookStore(store, "run-a"),
      status: store.statusSummary("run-a"),
    };
  } finally {
    store.close();
  }
}

for (const checkpoint of CHECKPOINTS) {
  test(`resume after injected ${checkpoint} matches uninterrupted final state`, () => {
    const directory = mkdtempSync(join(tmpdir(), `v5-fault-${checkpoint}-`));
    const interruptedPath = join(directory, "interrupted.db");
    const cleanPath = join(directory, "clean.db");
    let armed = false;
    let injected = false;
    const injector: FaultInjector = {
      checkpoint(name) {
        if (armed && !injected && name === checkpoint) {
          injected = true;
          throw new Error(`injected ${checkpoint}`);
        }
      },
    };
    const interrupted = initializeStore(interruptedPath, injector);
    if (checkpoint === "before_promote") {
      interrupted.store.stageWindow(stage(interrupted.snapshotId));
      armed = true;
      assert.throws(
        () => interrupted.store.promoteStagedWindow("run-a", "window-0"),
        new RegExp(`injected ${checkpoint}`),
      );
    } else {
      armed = true;
      assert.throws(
        () => interrupted.store.stageWindow(stage(interrupted.snapshotId)),
        new RegExp(`injected ${checkpoint}`),
      );
    }
    assert.equal(injected, true);
    interrupted.store.close();

    const reopened = new LosslessBookStore(interruptedPath);
    assert.equal(reopened.activeTranslations("run-a").length, 0);
    const rowsBeforeRecovery = reopened.auditState("run-a").translations;
    assert.ok(rowsBeforeRecovery.length === 0 || rowsBeforeRecovery.length === blocks().length);
    assert.deepEqual(reopened.recoverInterruptedWindows("run-a"), ["window-0"]);
    reopened.bindWindowsToSnapshot("run-a", ["window-0"], interrupted.snapshotId);
    reopened.claimWindow("run-a", "window-0");
    finish(reopened, interrupted.snapshotId);
    reopened.close();

    const clean = initializeStore(cleanPath);
    finish(clean.store, clean.snapshotId);
    clean.store.close();
    assert.deepEqual(finalProjection(interruptedPath), finalProjection(cleanPath));
  });
}

test("unknown and duplicate block IDs cannot stage", () => {
  const path = join(mkdtempSync(join(tmpdir(), "v5-invalid-stage-")), "book.db");
  const fixture = initializeStore(path);
  try {
    const valid = stage(fixture.snapshotId);
    assert.throws(() => fixture.store.stageWindow({
      ...valid,
      translations: [{ ...valid.translations[0]!, blockId: "unknown-block" }],
    }), /unknown.*block/i);
    assert.throws(() => fixture.store.stageWindow({
      ...valid,
      translations: [valid.translations[0]!, valid.translations[0]!],
    }), /duplicate.*block/i);
    assert.equal(fixture.store.auditState("run-a").translations.length, 0);
  } finally {
    fixture.store.close();
  }
});

function runnerFixture() {
  const directory = mkdtempSync(join(tmpdir(), "v5-wave-integrity-"));
  const source = "BOOK ONE\n\nAlpha.\n\nBOOK TWO\n\nBeta.";
  const raw = Buffer.from(source, "utf8");
  const rawPath = join(directory, "original.txt");
  const canonicalPath = join(directory, "source.txt");
  const manifestPath = join(directory, "source_manifest.json");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, raw);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: raw.length,
    raw_sha256: sha256(raw),
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    canonical_path: "source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: sha256(raw),
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: scalarLength(source),
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }));
  const ledger = SourceLedger.open(manifestPath);
  const blocks = buildLosslessBlocks(
    ledger,
    annotateStructure(ledger, ledger.sourceVersion),
    { sourceVersion: ledger.sourceVersion },
  );
  const windows = planBookWindows(blocks, {
    protocolVersion: "v5-book-3",
    maxBlocks: 1,
    maxSourceTokens: 100,
  });
  assert.ok(windows.length >= 2);
  const faux = fauxProvider();
  faux.setResponses(windows.slice(0, 2).map((item) => fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    {
      windows: [{
        windowId: item.windowId,
        translations: item.blockIds.map((blockId) => ({
          blockId,
          text: "这是完整的中文译文。",
        })),
        notes: [],
      }],
    },
  ), { stopReason: "toolUse" })));
  const stream = faux.provider.streamSimple.bind(faux.provider);
  return {
    canonicalPath,
    storePath: join(directory, "book.db"),
    faux,
    stream,
    options: {
      manifestPath,
      storePath: join(directory, "book.db"),
      runMeta: { runId: "run-wave", protocolVersion: "v5-book-3" },
      model: faux.getModel(),
      windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
      maxWindows: 2,
      maxConcurrency: 1,
      maxWindowsPerRequest: 1,
      maxRequestTokens: 100,
      tinyWindowTokens: 100,
    },
  };
}

test("canonical source changes block the next wave before a second model call", async () => {
  const fixture = runnerFixture();
  let changed = false;
  const stream: typeof fixture.stream = (...args) => {
    const result = fixture.stream(...args);
    if (!changed) {
      changed = true;
      writeFileSync(fixture.canonicalPath, "tampered", "utf8");
    }
    return result;
  };
  await assert.rejects(runBook({ ...fixture.options, streamFn: stream } as never),
    (error: unknown) => cliErrorPayload(error).code === "SOURCE_VERSION_CHANGED");
  assert.equal(fixture.faux.state.callCount, 1);
});

test("SQLite lock surfaces a retryable storage incident without a human translation task", async () => {
  const fixture = runnerFixture();
  let lock: DatabaseSync | undefined;
  const stream: typeof fixture.stream = (...args) => {
    const result = fixture.stream(...args);
    if (lock === undefined) {
      lock = new DatabaseSync(fixture.storePath);
      lock.exec("BEGIN IMMEDIATE");
    }
    return result;
  };
  try {
    await assert.rejects(
      runBook({ ...fixture.options, streamFn: stream } as never),
      (error: unknown) => {
        const payload = cliErrorPayload(error);
        return error instanceof BookStorageIncidentError
          && error.code === "STORAGE_LOCKED"
          && error.retryable
          && payload.code === "STORAGE_LOCKED"
          && payload.retryable === true;
      },
    );
  } finally {
    lock?.exec("ROLLBACK");
    lock?.close();
  }
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const status = store.statusSummary("run-wave");
    assert.equal(status.humanRequiredWindows, 0);
    assert.equal(status.runningWindows, 1);
  } finally {
    store.close();
  }
});
