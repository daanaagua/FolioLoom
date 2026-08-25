import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { BookWindowPlan } from "../src/fullbook/types.js";
import { blockId } from "../src/source/block-builder.js";
import type { LosslessBlock } from "../src/source/types.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
} from "../src/storage/lossless-book-store.js";
import {
  prepareRevalidationBenchmark,
  RevalidationBenchmarkError,
} from "../scripts/prepare-revalidation-benchmark.js";

const SOURCE_TEXT = "A.B.C.D.E.";
const RUN_ID = "benchmark-run";
const SNAPSHOT_ID = "benchmark-snapshot";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceInput(): CertifiedSourceInput {
  return {
    sourceVersion: "benchmark-source",
    rawSha256: sha256(SOURCE_TEXT),
    canonicalSha256: sha256(SOURCE_TEXT),
    canonicalChars: [...SOURCE_TEXT].length,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    sourceLanguageProfileVersion: "source-language-profile-1",
    sourceLanguageCompatibilityMode: false,
    ranges: [{
      rangeId: "benchmark-range",
      canonicalStart: 0,
      canonicalEnd: [...SOURCE_TEXT].length,
      originKind: "text",
      originRef: "fixture.txt",
      transformation: "identity",
    }],
  };
}

function fixtureBlocks(): LosslessBlock[] {
  return ["A.", "B.", "C.", "D.", "E."].map((sourceText, globalIndex) => {
    const canonicalStart = globalIndex * 2;
    const canonicalEnd = canonicalStart + 2;
    return {
      id: blockId("benchmark-source", canonicalStart, canonicalEnd, sourceText),
      sourceVersion: "benchmark-source",
      canonicalStart,
      canonicalEnd,
      sourceText,
      sourceHash: sha256(sourceText),
      globalIndex,
      tokenCount: 1,
      structureId: null,
      structureTitle: null,
    };
  });
}

function fixtureWindow(blocks: readonly LosslessBlock[]): BookWindowPlan {
  return {
    windowId: "benchmark-window",
    ordinal: 0,
    chapterId: "benchmark-chapter",
    chapterTitle: "Fixture",
    blockIds: blocks.map((block) => block.id),
    globalIndexes: blocks.map((block) => block.globalIndex),
    sourceTokens: blocks.length,
    sourceChars: [...SOURCE_TEXT].length,
    oversized: false,
  };
}

function createFixture(path: string, eligibleTaskCount = 5): void {
  const blocks = fixtureBlocks();
  const store = new LosslessBookStore(path);
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("benchmark-source", {
    blocks,
    annotations: [],
  });
  store.createTranslationRun({
    runId: RUN_ID,
    sourceVersion: "benchmark-source",
    protocolVersion: "benchmark-fixture",
    modelId: "fixture-model",
    initialSnapshotId: SNAPSHOT_ID,
  });
  store.initializeWindowPlan(RUN_ID, [fixtureWindow(blocks)]);
  store.close();

  const database = new DatabaseSync(path);
  const insertTranslation = database.prepare(`
    INSERT INTO translations(
      run_id, window_id, source_version, block_id, version, source_hash, text,
      result_status, stage_state, active, snapshot_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'completed', 'promoted', ?, ?)
  `);
  const insertBinding = database.prepare(`
    INSERT INTO translation_concept_bindings(
      translation_id, concept_id, applied_revision_id,
      applied_render_fingerprint, term_usages_json, validation_status,
      validated_revision_id
    ) VALUES(?, ?, ?, ?, ?, 'clean', ?)
  `);
  const insertTask = database.prepare(`
    INSERT INTO knowledge_revalidation_tasks(
      task_id, run_id, translation_id, block_id, change_set_hash,
      from_snapshot_id, to_snapshot_id, concept_ids_json, status, attempts,
      result_json, replacement_translation_id, resolved_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'resolved_retranslate', 1, ?, ?, datetime('now'))
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [index, block] of blocks.entries()) {
      const oldResult = insertTranslation.run(
        RUN_ID,
        "benchmark-window",
        "benchmark-source",
        block.id,
        1,
        block.sourceHash,
        `old-${index}`,
        0,
        SNAPSHOT_ID,
      );
      const activeResult = insertTranslation.run(
        RUN_ID,
        "benchmark-window",
        "benchmark-source",
        block.id,
        2,
        block.sourceHash,
        `active-${index}`,
        1,
        SNAPSHOT_ID,
      );
      const activeTranslationId = Number(activeResult.lastInsertRowid);
      const conceptId = `concept-${index}`;
      insertBinding.run(
        activeTranslationId,
        conceptId,
        `revision-${index}`,
        sha256(`render-${index}`),
        JSON.stringify([{ blockId: block.id, targetSurface: `term-${index}` }]),
        `revision-${index}`,
      );
      if (index < eligibleTaskCount) {
        insertTask.run(
          `resolved-task-${index}`,
          RUN_ID,
          Number(oldResult.lastInsertRowid),
          block.id,
          sha256(`old-change-${index}`),
          SNAPSHOT_ID,
          SNAPSHOT_ID,
          JSON.stringify([conceptId]),
          JSON.stringify({ outcome: "retranslated" }),
          activeTranslationId,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

test("benchmark preparation mutates only a copy and creates five active pending tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-revalidation-benchmark-"));
  const sourceStorePath = join(root, "source.db");
  const outputStorePath = join(root, "benchmark.db");
  try {
    createFixture(sourceStorePath);
    const sourceSha256Before = sha256(readFileSync(sourceStorePath));

    const prepared = await prepareRevalidationBenchmark({
      sourceStorePath,
      outputStorePath,
      runId: RUN_ID,
      taskCount: 5,
    });

    assert.deepEqual(prepared, {
      outputStorePath,
      sourceSha256Before,
      sourceSha256After: sourceSha256Before,
      pendingTaskIds: prepared.pendingTaskIds,
    });
    assert.equal(new Set(prepared.pendingTaskIds).size, 5);
    assert.equal(sha256(readFileSync(sourceStorePath)), sourceSha256Before);

    const source = new DatabaseSync(sourceStorePath, { readOnly: true });
    const output = new DatabaseSync(outputStorePath, { readOnly: true });
    try {
      assert.equal((source.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_revalidation_tasks
        WHERE status='pending'
      `).get() as { count: number }).count, 0);
      assert.equal((output.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_revalidation_tasks AS task
        JOIN translations AS translation
          ON translation.translation_id=task.translation_id
        WHERE task.status='pending'
          AND task.run_id=?
          AND translation.active=1
      `).get(RUN_ID) as { count: number }).count, 5);
      assert.equal((output.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_revalidation_tasks AS task
        JOIN translation_concept_bindings AS binding
          ON binding.translation_id=task.translation_id
        WHERE task.status='pending'
          AND task.run_id=?
          AND binding.term_usages_json='[]'
          AND binding.validation_status='stale'
      `).get(RUN_ID) as { count: number }).count, 5);
    } finally {
      source.close();
      output.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark preparation rejects path collisions and existing output", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-revalidation-benchmark-"));
  const sourceStorePath = join(root, "source.db");
  const outputStorePath = join(root, "existing.db");
  try {
    createFixture(sourceStorePath);
    await assert.rejects(
      prepareRevalidationBenchmark({
        sourceStorePath,
        outputStorePath: sourceStorePath,
        runId: RUN_ID,
        taskCount: 5,
      }),
      (error) => error instanceof RevalidationBenchmarkError
        && error.code === "BENCHMARK_PATH_COLLISION",
    );

    writeFileSync(outputStorePath, "do-not-overwrite", "utf8");
    await assert.rejects(
      prepareRevalidationBenchmark({
        sourceStorePath,
        outputStorePath,
        runId: RUN_ID,
        taskCount: 5,
      }),
      (error) => error instanceof RevalidationBenchmarkError
        && error.code === "BENCHMARK_OUTPUT_EXISTS",
    );
    assert.equal(readFileSync(outputStorePath, "utf8"), "do-not-overwrite");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark preparation removes an incomplete copy when five tasks are unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-revalidation-benchmark-"));
  const sourceStorePath = join(root, "source.db");
  const outputStorePath = join(root, "benchmark.db");
  try {
    createFixture(sourceStorePath, 4);
    const sourceSha256Before = sha256(readFileSync(sourceStorePath));

    await assert.rejects(
      prepareRevalidationBenchmark({
        sourceStorePath,
        outputStorePath,
        runId: RUN_ID,
        taskCount: 5,
      }),
      (error) => error instanceof RevalidationBenchmarkError
        && error.code === "BENCHMARK_TASK_COUNT",
    );

    assert.equal(existsSync(outputStorePath), false);
    assert.equal(sha256(readFileSync(sourceStorePath)), sourceSha256Before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark preparation deletes its copy when the source bytes change", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-revalidation-benchmark-"));
  const sourceStorePath = join(root, "source.db");
  const outputStorePath = join(root, "benchmark.db");
  let watcher: ReturnType<typeof setInterval> | undefined;
  try {
    createFixture(sourceStorePath);
    watcher = setInterval(() => {
      if (existsSync(outputStorePath)) {
        clearInterval(watcher);
        watcher = undefined;
        appendFileSync(sourceStorePath, Buffer.from([0]));
      }
    }, 0);

    await assert.rejects(
      prepareRevalidationBenchmark({
        sourceStorePath,
        outputStorePath,
        runId: RUN_ID,
        taskCount: 5,
      }),
      (error) => error instanceof RevalidationBenchmarkError
        && error.code === "BENCHMARK_SOURCE_MUTATED",
    );

    assert.equal(existsSync(outputStorePath), false);
  } finally {
    if (watcher !== undefined) clearInterval(watcher);
    rmSync(root, { recursive: true, force: true });
  }
});
