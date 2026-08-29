import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT as V4_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER as V4_MARKER,
  LOSSLESS_BOOK_SCHEMA_V4,
  LOSSLESS_BOOK_SCHEMA_VERSION as V4_VERSION,
} from "../src/storage/book-schema-v4.js";
import {
  LOSSLESS_BOOK_SCHEMA_TABLES,
  LOSSLESS_BOOK_SCHEMA_VERSION,
} from "../src/storage/book-schema-v5.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "folioloom-schema-v5-")), "book.db");
}

function createV4Fixture(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    database.exec(LOSSLESS_BOOK_SCHEMA_V4);
    const marker = database.prepare(`
      INSERT INTO lossless_schema_meta(key, value) VALUES(?, ?)
    `);
    marker.run("marker", V4_MARKER);
    marker.run("fingerprint", V4_FINGERPRINT);
    database.exec(`PRAGMA user_version=${V4_VERSION}`);
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
  const row = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  database.close();
  return row.user_version;
}

function tableNames(path: string): string[] {
  const database = new DatabaseSync(path);
  const result = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map((row) => row.name);
  database.close();
  return result;
}

function columnNames(path: string, table: string): string[] {
  const database = new DatabaseSync(path);
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  const result = rows.map((row) => row.name);
  database.close();
  return result;
}

test("schema v5 creates the live terminology control tables", () => {
  const path = fixturePath();
  new LosslessBookStore(path).close();

  assert.equal(userVersion(path), LOSSLESS_BOOK_SCHEMA_VERSION);
  assert.deepEqual(tableNames(path), [...LOSSLESS_BOOK_SCHEMA_TABLES]);
  assert.ok(columnNames(path, "lexical_concepts").includes("applicability_json"));
});

test("schema v5 migrates v4 atomically and remains idempotent", () => {
  const path = fixturePath();
  createV4Fixture(path);

  new LosslessBookStore(path).close();
  const first = {
    version: userVersion(path),
    tables: tableNames(path),
    lexicalColumns: columnNames(path, "lexical_concepts"),
  };
  new LosslessBookStore(path).close();

  assert.equal(first.version, 5);
  assert.deepEqual(first.tables, [...LOSSLESS_BOOK_SCHEMA_TABLES]);
  assert.ok(first.lexicalColumns.includes("applicability_json"));
  assert.deepEqual({
    version: userVersion(path),
    tables: tableNames(path),
    lexicalColumns: columnNames(path, "lexical_concepts"),
  }, first);
});

test("schema v5 rolls back a faulted v4 migration", () => {
  const path = fixturePath();
  createV4Fixture(path);

  assert.throws(() => new LosslessBookStore(path, {
    checkpoint(name) {
      if (name === "schema_v5_before_commit") {
        throw new Error("injected v5 migration fault");
      }
    },
  }), /injected v5 migration fault/u);

  assert.equal(userVersion(path), 4);
  assert.equal(tableNames(path).includes("knowledge_change_queue"), false);
  assert.equal(columnNames(path, "lexical_concepts").includes("applicability_json"), false);
});
