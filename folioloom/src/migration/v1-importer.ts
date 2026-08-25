import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BookContext } from "../fullbook/book-context.js";
import { planBookWindows } from "../fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../knowledge/snapshot.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";

export interface LegacyV1ImportOptions {
  legacyStorePath: string;
  manifestPath: string;
  storePath: string;
  runId?: string;
}

export interface LegacyV1ImportResult {
  schema: "v5-v1-migration-result-1";
  runId: string;
  importedTranslations: number;
  referenceCandidates: number;
}

interface LegacyTranslation {
  blockId: string;
  globalIndex: number;
  sourceText: string;
  sourceHash: string;
  version: number;
  translationSourceHash: string;
  text: string;
  status: string;
}

function legacyMeta(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare("SELECT key, value FROM book_meta").all() as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

function legacyTranslations(database: DatabaseSync): LegacyTranslation[] {
  return (database.prepare(`
    SELECT b.block_id, b.global_index, b.source_text, b.source_hash,
           t.version, t.source_hash AS translation_source_hash,
           t.text, t.status
    FROM book_blocks AS b
    JOIN translations AS t ON t.block_id=b.block_id AND t.active=1
    ORDER BY b.global_index, t.version
  `).all() as Array<{
    block_id: string;
    global_index: number;
    source_text: string;
    source_hash: string;
    version: number;
    translation_source_hash: string;
    text: string;
    status: string;
  }>).map((row) => ({
    blockId: row.block_id,
    globalIndex: row.global_index,
    sourceText: row.source_text,
    sourceHash: row.source_hash,
    version: row.version,
    translationSourceHash: row.translation_source_hash,
    text: row.text,
    status: row.status,
  }));
}

function computedLegacyFingerprint(rows: readonly LegacyTranslation[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row.blockId}\0${row.globalIndex}\0${row.sourceHash}\n`, "utf8");
  }
  return hash.digest("hex");
}

function candidateId(runId: string, row: LegacyTranslation): string {
  return `migration-${createHash("sha256")
    .update(`${runId}\0${row.blockId}\0${row.version}\0${row.sourceHash}`, "utf8")
    .digest("hex")}`;
}

export function importLegacyV1(options: LegacyV1ImportOptions): LegacyV1ImportResult {
  const legacyPath = resolve(options.legacyStorePath);
  const destinationPath = resolve(options.storePath);
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  let rows: LegacyTranslation[];
  let metadata: Map<string, string>;
  try {
    metadata = legacyMeta(legacy);
    rows = legacyTranslations(legacy);
  } finally {
    legacy.close();
  }
  const runId = options.runId ?? `migration-v1-${randomUUID()}`;
  const context = BookContext.openLossless({ manifestPath: resolve(options.manifestPath) });
  const store = new LosslessBookStore(destinationPath);
  const snapshot = createKnowledgeSnapshot(runId, []);
  try {
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "v5-book-3",
      modelId: metadata.get("model_id") ?? "legacy-unknown",
      initialSnapshotId: snapshot.id,
      initialSnapshot: snapshot,
      metadata: {
        migration: "v1",
        legacyStoreFingerprint: metadata.get("source_fingerprint")
          ?? computedLegacyFingerprint(rows),
        provenance: "v5-book-3",
      },
    });
    store.initializeWindowPlan(runId, planBookWindows(context.losslessBlocks, {
      protocolVersion: "v5-book-3",
      maxBlocks: 1,
    }));
  } finally {
    store.close();
  }

  const newBlocksBySource = new Map<string, typeof context.losslessBlocks>();
  for (const block of context.losslessBlocks) {
    const key = `${block.sourceHash}\0${block.sourceText}`;
    const matches = newBlocksBySource.get(key) ?? [];
    matches.push(block);
    newBlocksBySource.set(key, matches);
  }
  const database = new DatabaseSync(destinationPath);
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  let importedTranslations = 0;
  let referenceCandidates = 0;
  try {
    const membership = database.prepare(`
      SELECT window_id FROM window_membership
      WHERE run_id=? AND source_version=? AND block_id=?
    `);
    const insertTranslation = database.prepare(`
      INSERT INTO translations(
        run_id, window_id, source_version, block_id, version, source_hash,
        text, result_status, stage_state, active, snapshot_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'promoted', 1, ?)
    `);
    const completeWindow = database.prepare(`
      UPDATE window_plans
      SET status=?, result_status=?, snapshot_id=?, updated_at=datetime('now')
      WHERE run_id=? AND window_id=?
    `);
    const insertCandidate = database.prepare(`
      INSERT INTO migration_candidates(
        candidate_id, run_id, source_version, kind, payload_json, status
      ) VALUES(?, ?, ?, 'legacy_v1_translation', ?, 'pending')
    `);
    for (const row of rows) {
      const matches = newBlocksBySource.get(`${row.sourceHash}\0${row.sourceText}`) ?? [];
      const match = matches.length === 1 && matches[0]!.globalIndex === row.globalIndex
        && row.translationSourceHash === row.sourceHash
        && row.text.trim().length > 0
        ? matches[0]
        : undefined;
      if (match !== undefined) {
        const member = membership.get(
          runId,
          context.sourceLedger.sourceVersion,
          match.id,
        ) as { window_id: string } | undefined;
        if (member === undefined) {
          throw new Error(`migration window membership missing for ${match.id}`);
        }
        const status = row.status === "completed_with_warnings"
          ? "completed_with_warnings"
          : "completed";
        insertTranslation.run(
          runId,
          member.window_id,
          context.sourceLedger.sourceVersion,
          match.id,
          Math.max(1, row.version),
          match.sourceHash,
          row.text,
          status,
          snapshot.id,
        );
        completeWindow.run(status, status, snapshot.id, runId, member.window_id);
        importedTranslations += 1;
      } else {
        insertCandidate.run(
          candidateId(runId, row),
          runId,
          context.sourceLedger.sourceVersion,
          JSON.stringify({
            legacyBlockId: row.blockId,
            legacyGlobalIndex: row.globalIndex,
            sourceHash: row.sourceHash,
            sourceText: row.sourceText,
            translationRevision: row.version,
            translationText: row.text,
            possibleBlockIds: matches.map((item) => item.id),
          }),
        );
        referenceCandidates += 1;
      }
    }
    database.prepare("UPDATE translation_runs SET status=? WHERE run_id=?").run(
      importedTranslations === context.losslessBlocks.length ? "completed" : "running",
      runId,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
    context.close();
  }
  return {
    schema: "v5-v1-migration-result-1",
    runId,
    importedTranslations,
    referenceCandidates,
  };
}
