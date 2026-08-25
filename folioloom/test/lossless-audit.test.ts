import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { conceptFromAnchor } from "../src/knowledge/lexical-concept.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import {
  auditLosslessBookStore,
  schedulerMetrics,
  writeLosslessBookArtifacts,
} from "../src/report.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

test("scheduler metrics compare legacy, predicted, and actual execution", () => {
  const report = schedulerMetrics({
    mode: "active",
    profile: "balanced",
    planningStatus: "optimal",
    decisions: 5,
    fallbacks: 0,
    baselineWallTimeMs: 492_000,
    predictedWallTimeMs: 240_000,
    actualWallTimeMs: 238_000,
    baselineTokens: 100_000,
    allowedTokens: 110_000,
    predictedTokens: 104_000,
    actualTokens: 103_000,
    tokenUsageComplete: true,
    contextProfiles: {
      "window-1": "lean",
      "window-2": "balanced",
      "window-3": "rich",
    },
    effortCounts: { low: 2, high: 3 },
    protocolCounts: { typed_tool: 4, framed_text: 1, local: 0 },
    plannerDeadlines: 0,
    throttles: 0,
    recoveries: 1,
  });

  assert.deepEqual(report.wallTime, {
    legacyEstimateMs: 492_000,
    plannedEstimateMs: 240_000,
    actualMs: 238_000,
  });
  assert.deepEqual(report.tokenEnvelope, {
    baselineTokens: 100_000,
    allowedTokens: 110_000,
    predictedTokens: 104_000,
    actualTokens: 103_000,
    exceeded: false,
  });
  assert.deepEqual(report.selections, {
    contextProfiles: { lean: 1, balanced: 1, rich: 1 },
    efforts: { high: 3, low: 2 },
    protocols: { framed_text: 1, typed_tool: 4 },
  });
  assert.deepEqual(report.events, {
    plannerDeadlines: 0,
    fallbacks: 0,
    throttles: 0,
    recoveries: 1,
  });
});

function sourceManifest(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "v5-lossless-audit-"));
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

function completeRun(withKnowledge = false): { storePath: string; runId: string } {
  const manifestPath = sourceManifest("Alpha.");
  const storePath = join(dirname(manifestPath), "book.db");
  const runId = withKnowledge ? "run-knowledge" : "run-translation";
  const context = BookContext.openLossless({ manifestPath });
  const store = new LosslessBookStore(storePath);
  try {
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    const initialSnapshot = createKnowledgeSnapshot(runId, []);
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "lossless-v5-1",
      modelId: "test-model",
      initialSnapshotId: initialSnapshot.id,
      initialSnapshot,
    });
    const windows = planBookWindows(context.losslessBlocks, {
      protocolVersion: "lossless-v5-1",
    });
    store.initializeWindowPlan(runId, windows);
    const [window] = windows;
    assert.ok(window);
    store.bindWindowsToSnapshot(runId, [window.windowId], initialSnapshot.id);
    store.claimWindow(runId, window.windowId);
    const candidates = withKnowledge
      ? [{
          recordId: "candidate-alpha",
          normalizedSubject: "alpha",
          kind: "term",
          payload: { target: "阿尔法" },
        }]
      : [];
    store.stageWindow({
      runId,
      windowId: window.windowId,
      snapshotId: initialSnapshot.id,
      status: "completed",
      translations: context.losslessBlocks.map((block) => ({
        blockId: block.id,
        sourceHash: block.sourceHash,
        text: `译文-${block.globalIndex}`,
      })),
      knowledgeCandidates: candidates,
      styleTail: "",
      budget: {},
      warnings: [],
    });
    if (withKnowledge) {
      const knowledge = new KnowledgeStore();
      const appendedRevisions = knowledge.reconcileCandidates(candidates, window.windowId);
      const nextSnapshot = createKnowledgeSnapshot(
        runId,
        knowledge.projectableRevisions(),
        initialSnapshot.id,
      );
      store.promoteStagedWindow({
        runId,
        windowId: window.windowId,
        ordinal: window.ordinal,
        snapshotId: initialSnapshot.id,
        candidates,
        appendedRevisions,
        nextSnapshot,
      });
    } else {
      store.promoteStagedWindow(runId, window.windowId);
    }
  } finally {
    store.close();
    context.close();
  }
  return { storePath, runId };
}

function injectKnowledgeRevalidation(
  storePath: string,
  runId: string,
  input: {
    bindingStatus: "stale" | "warning_stale";
    taskStatus: "pending" | "completed_with_warning";
  },
): void {
  const database = new DatabaseSync(storePath);
  try {
    const translation = database.prepare(`
      SELECT translation_id, block_id, snapshot_id
      FROM translations
      WHERE run_id=? AND active=1
      ORDER BY translation_id
      LIMIT 1
    `).get(runId) as {
      translation_id: number;
      block_id: string;
      snapshot_id: string;
    } | undefined;
    assert.ok(translation);
    database.prepare(`
      INSERT INTO translation_concept_bindings(
        translation_id, concept_id, applied_revision_id,
        applied_render_fingerprint, term_usages_json,
        validation_status, validated_revision_id
      ) VALUES(?, 'concept-audit', 'revision-old', ?, '[]', ?, 'revision-old')
    `).run(
      translation.translation_id,
      "a".repeat(64),
      input.bindingStatus,
    );
    database.prepare(`
      INSERT INTO knowledge_revalidation_tasks(
        task_id, run_id, translation_id, block_id, change_set_hash,
        from_snapshot_id, to_snapshot_id, concept_ids_json, status
      ) VALUES(
        'task-audit', ?, ?, ?, ?, ?, ?, '["concept-audit"]', ?
      )
    `).run(
      runId,
      translation.translation_id,
      translation.block_id,
      "b".repeat(64),
      translation.snapshot_id,
      translation.snapshot_id,
      input.taskStatus,
    );
  } finally {
    database.close();
  }
}

test("audit rejects an empty active translation in a completed run", () => {
  const fixture = completeRun();
  const database = new DatabaseSync(fixture.storePath);
  database.prepare("UPDATE translations SET text='' WHERE run_id=? AND active=1")
    .run(fixture.runId);
  database.close();
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const report = auditLosslessBookStore(store, fixture.runId);
    assert.equal(report.complete, false);
    assert.ok(report.incidentCodes.includes("ACTIVE_TRANSLATION_INVALID"));
  } finally {
    store.close();
  }
});

test("knowledge convergence blocks strict export without hiding structural completeness", () => {
  const fixture = completeRun();
  injectKnowledgeRevalidation(fixture.storePath, fixture.runId, {
    bindingStatus: "stale",
    taskStatus: "pending",
  });
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const report = auditLosslessBookStore(store, fixture.runId);
    assert.equal(report.structurallyComplete, true);
    assert.equal(report.knowledgeConverged, false);
    assert.equal(report.strictExportable, false);
    assert.equal(report.complete, false);
    assert.ok(report.incidentCodes.includes("STALE_KNOWLEDGE_BINDING"));
    assert.deepEqual(report.revalidation, {
      pending: 1,
      validating: 0,
      stale: 1,
      warningStale: 0,
      coverageMissing: 0,
      resolvedNoop: 0,
      repaired: 0,
      retranslated: 0,
    });

    const output = mkdtempSync(join(tmpdir(), "folioloom-stale-export-"));
    assert.throws(
      () => writeLosslessBookArtifacts(store, fixture.runId, output),
      /STALE_KNOWLEDGE_BINDING|knowledge convergence/u,
    );
    const paths = writeLosslessBookArtifacts(
      store,
      fixture.runId,
      output,
      { allowIncomplete: true },
    );
    assert.match(paths.translation, /\.partial\.txt$/u);
    const exportedAudit = JSON.parse(
      readFileSync(paths.audit, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(exportedAudit.structurallyComplete, true);
    assert.equal(exportedAudit.knowledgeConverged, false);
    assert.equal(exportedAudit.strictExportable, false);
  } finally {
    store.close();
  }
});

test("audit rejects an active translation whose concept occurrence has no binding", () => {
  const fixture = completeRun();
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const concept = conceptFromAnchor({
      sourceForm: "Alpha",
      target: "阿尔法",
      mode: "stable",
      semanticClass: "technical_term",
      confidence: 0.95,
    });
    const [block] = store.auditState(fixture.runId).blocks;
    assert.ok(block);
    store.upsertLexicalConcepts(fixture.runId, [concept]);
    store.replaceConceptOccurrences(fixture.runId, concept.conceptId, [{
      conceptId: concept.conceptId,
      blockId: block.blockId,
      sourceSpans: [{ start: 0, end: 5, sourceForm: "Alpha" }],
    }]);

    const report = auditLosslessBookStore(store, fixture.runId);
    assert.equal(report.structurallyComplete, true);
    assert.equal(report.knowledgeConverged, false);
    assert.equal(report.strictExportable, false);
    assert.equal(report.revalidation.coverageMissing, 1);
    assert.ok(report.incidentCodes.includes("STALE_KNOWLEDGE_BINDING"));
  } finally {
    store.close();
  }
});

test("warning-stale bindings remain explicit strict-export blockers", () => {
  const fixture = completeRun();
  injectKnowledgeRevalidation(fixture.storePath, fixture.runId, {
    bindingStatus: "warning_stale",
    taskStatus: "completed_with_warning",
  });
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const report = auditLosslessBookStore(store, fixture.runId);
    assert.equal(report.structurallyComplete, true);
    assert.equal(report.knowledgeConverged, false);
    assert.equal(report.strictExportable, false);
    assert.equal(report.revalidation.warningStale, 1);
    assert.ok(report.incidentCodes.includes("STALE_KNOWLEDGE_BINDING"));
  } finally {
    store.close();
  }
});

test("audit accepts a snapshot projection whose latest knowledge entry is revision two", () => {
  const manifestPath = sourceManifest("Alpha.[[]]Beta.");
  const storePath = join(dirname(manifestPath), "book.db");
  const runId = "run-revision-two";
  const context = BookContext.openLossless({ manifestPath });
  const store = new LosslessBookStore(storePath);
  try {
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    let snapshot = createKnowledgeSnapshot(runId, []);
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "lossless-v5-1",
      modelId: "test-model",
      initialSnapshotId: snapshot.id,
      initialSnapshot: snapshot,
    });
    const windows = planBookWindows(context.losslessBlocks, {
      maxBlocks: 1,
      maxSourceTokens: 100,
      protocolVersion: "lossless-v5-1",
    });
    assert.equal(windows.length, 2);
    store.initializeWindowPlan(runId, windows);
    const blockById = new Map(context.losslessBlocks.map((block) => [block.id, block]));
    const knowledge = new KnowledgeStore();
    for (const [index, window] of windows.entries()) {
      store.bindWindowsToSnapshot(runId, [window.windowId], snapshot.id);
      store.claimWindow(runId, window.windowId);
      const candidates = [{
        recordId: `candidate-alpha-${index}`,
        normalizedSubject: "alpha",
        kind: "term",
        payload: { target: index === 0 ? "阿尔法" : "阿尔法二" },
      }];
      store.stageWindow({
        runId,
        windowId: window.windowId,
        snapshotId: snapshot.id,
        status: "completed",
        translations: window.blockIds.map((blockId) => ({
          blockId,
          sourceHash: blockById.get(blockId)!.sourceHash,
          text: `译文-${index}`,
        })),
        knowledgeCandidates: candidates,
        styleTail: "",
        budget: {},
        warnings: [],
      });
      const appendedRevisions = knowledge.reconcileCandidates(candidates, window.windowId);
      const nextSnapshot = createKnowledgeSnapshot(
        runId,
        knowledge.projectableRevisions(),
        snapshot.id,
      );
      store.promoteStagedWindow({
        runId,
        windowId: window.windowId,
        ordinal: window.ordinal,
        snapshotId: snapshot.id,
        candidates,
        appendedRevisions,
        nextSnapshot,
      });
      snapshot = nextSnapshot;
    }

    const report = auditLosslessBookStore(store, runId);
    assert.equal(report.complete, true);
    assert.deepEqual(report.incidentCodes, []);
  } finally {
    store.close();
    context.close();
  }
});

test("audit replays knowledge history instead of trusting snapshot payloads", () => {
  const fixture = completeRun(true);
  const database = new DatabaseSync(fixture.storePath);
  database.prepare("DELETE FROM knowledge_records WHERE run_id=?").run(fixture.runId);
  database.close();
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const report = auditLosslessBookStore(store, fixture.runId);
    assert.equal(report.complete, false);
    assert.ok(report.incidentCodes.includes("KNOWLEDGE_HISTORY_INVALID"));
  } finally {
    store.close();
  }
});

test("audit verifies every relational knowledge column against its canonical payload", () => {
  const fixture = completeRun(true);
  const database = new DatabaseSync(fixture.storePath);
  database.prepare("UPDATE knowledge_records SET status='needs_revalidate' WHERE run_id=?")
    .run(fixture.runId);
  database.close();
  const store = new LosslessBookStore(fixture.storePath);
  try {
    const report = auditLosslessBookStore(store, fixture.runId);
    assert.equal(report.complete, false);
    assert.ok(report.incidentCodes.includes("KNOWLEDGE_HISTORY_INVALID"));
  } finally {
    store.close();
  }
});

test("book audit exits nonzero with a structured integrity error", () => {
  const fixture = completeRun();
  const database = new DatabaseSync(fixture.storePath);
  database.prepare("UPDATE logical_blocks SET source_text='tampered' WHERE global_index=0").run();
  database.close();
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "book", "audit",
    "--store", fixture.storePath, "--run", fixture.runId,
  ], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 1);
  const payloadText = result.stderr.split(/\r?\n/u)
    .find((line) => line.startsWith('{"schema":"v5-book-cli-error-1"'));
  assert.ok(payloadText);
  const payload = JSON.parse(payloadText) as Record<string, unknown>;
  assert.equal(payload.code, "BOOK_AUDIT_FAILED");
});
