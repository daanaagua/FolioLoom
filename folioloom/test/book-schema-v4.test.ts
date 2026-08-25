import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT as LOSSLESS_BOOK_SCHEMA_V3_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER as LOSSLESS_BOOK_SCHEMA_V3_MARKER,
  LOSSLESS_BOOK_SCHEMA_V3,
  LOSSLESS_BOOK_SCHEMA_VERSION as LOSSLESS_BOOK_SCHEMA_V3_VERSION,
} from "../src/storage/book-schema-v3.js";
import {
  LOSSLESS_BOOK_SCHEMA_TABLES,
  LOSSLESS_BOOK_SCHEMA_VERSION,
} from "../src/storage/book-schema-v4.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "folioloom-schema-v4-")), "book.db");
}

function createV3Fixture(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    database.exec(LOSSLESS_BOOK_SCHEMA_V3);
    const insertMarker = database.prepare(`
      INSERT INTO lossless_schema_meta(key, value) VALUES(?, ?)
    `);
    insertMarker.run("marker", LOSSLESS_BOOK_SCHEMA_V3_MARKER);
    insertMarker.run("fingerprint", LOSSLESS_BOOK_SCHEMA_V3_FINGERPRINT);
    database.prepare(`
      INSERT INTO source_versions(
        source_version, raw_sha256, canonical_sha256, canonical_chars,
        coordinate_unit, source_format, encoding, extractor,
        source_fingerprint, source_payload_json
      ) VALUES(
        'source-v1', 'raw', 'canonical', 5, 'unicode_scalar', 'txt',
        'utf-8', 'plain-text-v1', 'source-fingerprint', '{}'
      )
    `).run();
    database.prepare(`
      INSERT INTO logical_blocks(
        source_version, block_id, canonical_start, canonical_end,
        source_text, source_hash, global_index, token_count
      ) VALUES('source-v1', 'block-v1', 0, 5, 'Alpha', 'source-hash', 0, 1)
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
        source_tokens, source_chars, status, result_status, snapshot_id
      ) VALUES(
        'run-v1', 'window-v1', 'source-v1', 0, 'chapter-v1',
        1, 5, 'completed', 'completed', 'snapshot-v1'
      )
    `).run();
    database.prepare(`
      INSERT INTO window_membership(
        run_id, window_id, source_version, block_id, position
      ) VALUES('run-v1', 'window-v1', 'source-v1', 'block-v1', 0)
    `).run();
    database.prepare(`
      INSERT INTO translations(
        run_id, window_id, source_version, block_id, version, source_hash,
        text, result_status, stage_state, active, snapshot_id
      ) VALUES(
        'run-v1', 'window-v1', 'source-v1', 'block-v1', 1, 'source-hash',
        '原有译文', 'completed', 'promoted', 1, 'snapshot-v1'
      )
    `).run();
    database.prepare(`
      INSERT INTO knowledge_records(
        run_id, record_id, revision_id, revision, normalized_subject,
        kind, payload_json, status, active, producing_window_id
      ) VALUES(
        'run-v1', 'record-v1', 'revision-v1', 1, 'prokurist',
        'lexical_anchor_decision', '{"target":"主事"}', 'active', 1, 'window-v1'
      )
    `).run();
    database.prepare(`
      INSERT INTO book_knowledge_state(source_version, generation)
      VALUES('source-v1', 0)
    `).run();
    database.prepare(`
      INSERT INTO project_knowledge_state(singleton, generation) VALUES(1, 0)
    `).run();
    database.prepare(`
      INSERT INTO knowledge_state(
        run_id, generation, applied_book_generation, applied_project_generation
      ) VALUES('run-v1', 0, 0, 0)
    `).run();
    database.exec(`PRAGMA user_version=${LOSSLESS_BOOK_SCHEMA_V3_VERSION}`);
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

function tableNames(path: string): string[] {
  const database = new DatabaseSync(path);
  const tables = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map((row) => row.name);
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

function activeTranslationText(path: string): string | undefined {
  const database = new DatabaseSync(path);
  const row = database.prepare(`
    SELECT text FROM translations WHERE run_id='run-v1' AND active=1
  `).get() as { text: string } | undefined;
  database.close();
  return row?.text;
}

test("schema v4 creates every sparse revalidation table", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  store.close();

  assert.equal(userVersion(path), LOSSLESS_BOOK_SCHEMA_VERSION);
  assert.deepEqual(tableNames(path), [...LOSSLESS_BOOK_SCHEMA_TABLES]);
});

test("schema v4 migrates a v3 store without changing active artifacts", () => {
  const path = fixturePath();
  createV3Fixture(path);

  const store = new LosslessBookStore(path);
  store.close();

  assert.equal(userVersion(path), 4);
  assert.deepEqual(tableNames(path), [...LOSSLESS_BOOK_SCHEMA_TABLES]);
  assert.equal(activeTranslationText(path), "原有译文");
  const database = new DatabaseSync(path);
  const count = database.prepare(`
    SELECT COUNT(*) AS count FROM concept_occurrences
  `).get() as { count: number };
  database.close();
  assert.equal(count.count, 0);
});

test("schema v4 opens a v3 store read-only without migrating it", () => {
  const path = fixturePath();
  createV3Fixture(path);

  const store = LosslessBookStore.openReadOnly(path);
  assert.equal(store.listTranslationRuns()[0]?.runId, "run-v1");
  store.close();

  assert.equal(userVersion(path), 3);
  assert.equal(tableExists(path, "lexical_concepts"), false);
});

test("schema v4 rolls back the complete v3 migration after a fault", () => {
  const path = fixturePath();
  createV3Fixture(path);

  assert.throws(
    () => new LosslessBookStore(path, {
      checkpoint(name) {
        if (name === "schema_v4_before_commit") {
          throw new Error("injected v4 migration fault");
        }
      },
    }),
    /injected v4 migration fault/u,
  );
  assert.equal(userVersion(path), 3);
  assert.equal(tableExists(path, "lexical_concepts"), false);
  assert.equal(activeTranslationText(path), "原有译文");
});

test("schema v4 migration is idempotent across later opens", () => {
  const path = fixturePath();
  createV3Fixture(path);

  new LosslessBookStore(path).close();
  const afterFirstOpen = {
    version: userVersion(path),
    tables: tableNames(path),
    text: activeTranslationText(path),
  };
  new LosslessBookStore(path).close();

  assert.deepEqual({
    version: userVersion(path),
    tables: tableNames(path),
    text: activeTranslationText(path),
  }, afterFirstOpen);
});
