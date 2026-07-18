import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { auditLosslessBookStore } from "../src/report.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

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
