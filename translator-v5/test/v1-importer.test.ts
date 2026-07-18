import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { parseArgs } from "../src/cli.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { importLegacyV1 } from "../src/migration/v1-importer.js";
import { auditLosslessBookStore } from "../src/report.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function sourceManifest(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "v5-v1-importer-"));
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

function legacyStore(manifestPath: string): string {
  const context = BookContext.openLossless({ manifestPath });
  const legacyPath = join(dirname(manifestPath), "legacy.db");
  const database = new DatabaseSync(legacyPath);
  database.exec(`
    CREATE TABLE book_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE book_blocks(
      block_id TEXT PRIMARY KEY,
      global_index INTEGER NOT NULL,
      source_text TEXT NOT NULL,
      source_hash TEXT NOT NULL
    );
    CREATE TABLE translations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      active INTEGER NOT NULL
    );
  `);
  database.prepare("INSERT INTO book_meta VALUES('source_fingerprint', 'legacy-fingerprint')").run();
  database.prepare("INSERT INTO book_meta VALUES('model_id', 'legacy-model')").run();
  const insertBlock = database.prepare("INSERT INTO book_blocks VALUES(?, ?, ?, ?)");
  const insertTranslation = database.prepare(`
    INSERT INTO translations(block_id, version, source_hash, text, status, active)
    VALUES(?, ?, ?, ?, 'completed', 1)
  `);
  for (const block of context.losslessBlocks.slice(0, 2)) {
    insertBlock.run(block.id, block.globalIndex, block.sourceText, block.sourceHash);
    insertTranslation.run(
      block.id,
      block.globalIndex + 3,
      block.sourceHash,
      block.globalIndex === 0 ? "唯一译文" : "不应静默晋升",
    );
  }
  database.close();
  context.close();
  return legacyPath;
}

test("v1 importer activates only a unique exact source match and quarantines repeats", () => {
  const unique = `${"unique ".repeat(500)}\n\n`;
  const repeated = `${"repeated ".repeat(420)}\n\n`;
  const manifestPath = sourceManifest(`${unique}${repeated}${repeated}`);
  const storePath = join(dirname(manifestPath), "lossless.db");
  const result = importLegacyV1({
    legacyStorePath: legacyStore(manifestPath),
    manifestPath,
    storePath,
  });
  assert.equal(result.importedTranslations, 1);
  assert.equal(result.referenceCandidates, 1);

  const store = new LosslessBookStore(storePath);
  try {
    const active = store.activeTranslations(result.runId);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.text, "唯一译文");
    const audit = auditLosslessBookStore(store, result.runId);
    assert.equal(audit.complete, false);
    assert.deepEqual(audit.incidentCodes, []);
    const state = store.auditState(result.runId);
    assert.equal(state.protocolVersion, "v5-book-3");
    assert.equal(state.modelId, "legacy-model");
    assert.deepEqual(state.runMetadata, {
      migration: "v1",
      legacyStoreFingerprint: "legacy-fingerprint",
      provenance: "v5-book-3",
    });
    const database = new DatabaseSync(storePath, { readOnly: true });
    const candidates = database.prepare(`
      SELECT kind, status, payload_json FROM migration_candidates WHERE run_id=?
    `).all(result.runId) as Array<Record<string, unknown>>;
    database.close();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.kind, "legacy_v1_translation");
    assert.equal(candidates[0]?.status, "pending");
    assert.match(String(candidates[0]?.payload_json), /不应静默晋升/u);
  } finally {
    store.close();
  }
});

test("v1 importer defaults missing legacy model metadata", () => {
  const manifestPath = sourceManifest("only source.\n\n");
  const legacyPath = legacyStore(manifestPath);
  const database = new DatabaseSync(legacyPath);
  database.prepare("DELETE FROM book_meta WHERE key='model_id'").run();
  database.close();
  const storePath = join(dirname(manifestPath), "lossless.db");
  const result = importLegacyV1({ legacyStorePath: legacyPath, manifestPath, storePath });
  const store = new LosslessBookStore(storePath);
  try {
    assert.equal(store.auditState(result.runId).modelId, "legacy-unknown");
  } finally {
    store.close();
  }
});

test("CLI parses explicit v1 migration paths", () => {
  assert.deepEqual(parseArgs([
    "book", "migrate-v1",
    "--legacy-store", "old.db",
    "--manifest", "source_manifest.json",
    "--store", "new.db",
  ]), {
    command: "book-migrate-v1",
    legacyStore: join(process.cwd(), "old.db"),
    manifest: join(process.cwd(), "source_manifest.json"),
    store: join(process.cwd(), "new.db"),
  });
});
