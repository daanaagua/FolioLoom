import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER,
  LOSSLESS_BOOK_SCHEMA_V2,
  LOSSLESS_BOOK_SCHEMA_VERSION,
} from "../src/storage/book-schema-v2.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "v5-schema-v3-")), "book.db");
}

function createV2Fixture(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    database.exec(LOSSLESS_BOOK_SCHEMA_V2);
    const insertMarker = database.prepare(`
      INSERT INTO lossless_schema_meta(key, value) VALUES(?, ?)
    `);
    insertMarker.run("marker", LOSSLESS_BOOK_SCHEMA_MARKER);
    insertMarker.run("fingerprint", LOSSLESS_BOOK_SCHEMA_FINGERPRINT);
    database.prepare(`
      INSERT INTO source_versions(
        source_version, raw_sha256, canonical_sha256, canonical_chars,
        coordinate_unit, source_format, encoding, extractor,
        source_fingerprint, source_payload_json
      ) VALUES('source-v1', 'raw', 'canonical', 5, 'unicode_scalar',
        'txt', 'utf-8', 'plain-text-v1', 'source-fingerprint', '{}')
    `).run();
    database.prepare(`
      INSERT INTO translation_runs(
        run_id, source_version, protocol_version, model_id, metadata_json
      ) VALUES('run-v1', 'source-v1', 'lossless-v5-1', 'model-a', '{}')
    `).run();
    database.prepare(`
      INSERT INTO knowledge_snapshots(
        run_id, snapshot_id, content_hash, payload_json
      ) VALUES('run-v1', 'snapshot-v1', 'snapshot-hash-v1', '[]')
    `).run();
    database.prepare(`
      INSERT INTO window_plans(
        run_id, window_id, source_version, ordinal, chapter_id,
        source_tokens, source_chars
      ) VALUES('run-v1', 'window-v1', 'source-v1', 0, 'chapter-v1', 1, 5)
    `).run();
    database.prepare(`
      INSERT INTO knowledge_records(
        run_id, record_id, revision_id, revision, normalized_subject,
        kind, payload_json, status, active, producing_window_id
      ) VALUES(
        'run-v1', 'record-v1', 'revision-v1', 1, 'archon',
        'term', '{"target":"执政官"}', 'active', 1, 'window-v1'
      )
    `).run();
    database.exec(`PRAGMA user_version=${LOSSLESS_BOOK_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function userVersion(path: string): number {
  const database = new DatabaseSync(path);
  const version = (database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  database.close();
  return version;
}

function readKnowledgeRows(path: string): unknown {
  const database = new DatabaseSync(path);
  const records = database.prepare(`
    SELECT run_id, record_id, revision_id, revision, normalized_subject,
           kind, payload_json, status, active, producing_window_id, created_at
    FROM knowledge_records ORDER BY run_id, record_id, revision
  `).all();
  const snapshots = database.prepare(`
    SELECT run_id, snapshot_id, parent_snapshot_id, producing_window_id,
           content_hash, payload_json, created_at
    FROM knowledge_snapshots ORDER BY run_id, snapshot_id
  `).all();
  database.close();
  return {
    records: records.map((row) => ({ ...row })),
    snapshots: snapshots.map((row) => ({ ...row })),
  };
}

function requiredTables(path: string): string[] {
  const required = new Set([
    "book_knowledge_revisions",
    "book_knowledge_state",
    "knowledge_block_impacts",
    "knowledge_import_batches",
    "knowledge_import_rows",
    "knowledge_state",
    "project_knowledge_revisions",
    "project_knowledge_state",
  ]);
  const database = new DatabaseSync(path);
  const tables = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as unknown as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => required.has(name));
  database.close();
  return tables;
}

function tableExists(path: string, name: string): boolean {
  const database = new DatabaseSync(path);
  const row = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(name);
  database.close();
  return row !== undefined;
}

function queryPlan(path: string, sql: string): string[] {
  const database = new DatabaseSync(path);
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
    "run-v1",
    "record-v1",
  ) as unknown as Array<{ detail: string }>;
  database.close();
  return rows.map((row) => row.detail);
}

test("creates a fresh current store with every v3 knowledge table", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  store.close();

  assert.equal(userVersion(path), 4);
  assert.deepEqual(requiredTables(path), [
    "book_knowledge_revisions",
    "book_knowledge_state",
    "knowledge_block_impacts",
    "knowledge_import_batches",
    "knowledge_import_rows",
    "knowledge_state",
    "project_knowledge_revisions",
    "project_knowledge_state",
  ]);
});

test("indexes active run knowledge by stable record identity", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  store.close();

  assert.match(
    queryPlan(path, `
      UPDATE knowledge_records SET active=0
      WHERE run_id=? AND record_id=? AND active=1
    `).join("\n"),
    /idx_v5_knowledge_records_active_record/u,
  );
});

test("opens a v2 store at the current schema without changing knowledge identities", () => {
  const path = fixturePath();
  createV2Fixture(path);
  const before = readKnowledgeRows(path);

  const store = new LosslessBookStore(path);
  store.close();

  assert.equal(userVersion(path), 4);
  assert.deepEqual(readKnowledgeRows(path), before);
  assert.deepEqual(requiredTables(path), [
    "book_knowledge_revisions",
    "book_knowledge_state",
    "knowledge_block_impacts",
    "knowledge_import_batches",
    "knowledge_import_rows",
    "knowledge_state",
    "project_knowledge_revisions",
    "project_knowledge_state",
  ]);
});

test("opens a v2 store read-only without migrating it", () => {
  const path = fixturePath();
  createV2Fixture(path);

  const store = LosslessBookStore.openReadOnly(path);
  assert.equal(store.listTranslationRuns()[0]?.runId, "run-v1");
  store.close();

  assert.equal(userVersion(path), 2);
  assert.equal(tableExists(path, "knowledge_state"), false);
});

test("rolls back the complete v2 to v3 migration after a fault", () => {
  const path = fixturePath();
  createV2Fixture(path);
  assert.throws(
    () => new LosslessBookStore(path, {
      checkpoint(name) {
        if (name === "schema_v3_before_commit") {
          throw new Error("injected");
        }
      },
    }),
    /injected/u,
  );
  assert.equal(userVersion(path), 2);
  assert.equal(tableExists(path, "knowledge_state"), false);
});
