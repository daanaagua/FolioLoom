import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BookContext } from "../src/fullbook/book-context.js";
import { scalarLength } from "../src/source/types.js";
import { V4ReadAdapter } from "../src/storage/v4-read-adapter.js";

function manifestFixture(directory: string, source: string, sourceLanguage?: string): string {
  const raw = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  writeFileSync(join(directory, "original.txt"), raw);
  writeFileSync(join(directory, "source.txt"), raw);
  const manifestPath = join(directory, "source_manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: raw.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
    canonical_path: "source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: hash,
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
  }), "utf8");
  return manifestPath;
}

function createFixture(path: string, withStableTerm = false): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY, legacy_id TEXT, chapter_id TEXT, chapter_title TEXT,
      block_index INTEGER, global_index INTEGER, source_text TEXT,
      source_hash TEXT, token_count INTEGER
    );
    CREATE TABLE concepts (
      id TEXT PRIMARY KEY, canonical_source TEXT, default_target TEXT,
      working_target TEXT, verified_target TEXT, status TEXT, locked INTEGER,
      retired_version INTEGER
    );
    CREATE TABLE lexemes (
      id TEXT PRIMARY KEY, canonical_form TEXT, default_target TEXT,
      working_target TEXT, verified_target TEXT, status TEXT, locked INTEGER,
      retired_version INTEGER
    );
    CREATE TABLE concept_lexemes (
      concept_id TEXT, lexeme_id TEXT, status TEXT, retired_version INTEGER
    );
    CREATE TABLE source_forms (lexeme_id TEXT, form TEXT);
  `);
  const insert = database.prepare(`
    INSERT INTO blocks VALUES(?, ?, 'ch1', 'One', ?, ?, ?, ?, 10)
  `);
  insert.run("block-0", "legacy-0", 0, 0, "Smoky walked.", "hash-0");
  insert.run("block-1", "legacy-1", 1, 1, "Smoky stopped.", "hash-1");
  insert.run("block-2", "legacy-2", 2, 2, "Alice waited.", "hash-2");
  if (withStableTerm) {
    database.exec(`
      INSERT INTO concepts VALUES('person-smoky', 'Smoky', '', '', '斯莫基', 'active', 1, NULL);
      INSERT INTO lexemes VALUES('lex-smoky', 'Smoky', '', '', '', 'active', 1, NULL);
      INSERT INTO concept_lexemes VALUES('person-smoky', 'lex-smoky', 'active', NULL);
      INSERT INTO source_forms VALUES('lex-smoky', 'Smoky');
    `);
  }
  database.close();
}

test("book context loads source and builds one reusable evidence index", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-context-"));
  const path = join(directory, "book.db");
  createFixture(path);
  const context = BookContext.open(path);
  try {
    assert.deepEqual(context.blocks.map((item) => item.globalIndex), [0, 1, 2]);
    assert.equal(context.stableTerms.length, 0);
    assert.equal(context.evidenceIndex, context.evidenceIndex);
    assert.equal(context.sourceFingerprint.length, 64);
    assert.deepEqual(
      context.blocksForIndexes([2, 0]).map((item) => item.globalIndex),
      [0, 2],
    );
  } finally {
    context.close();
  }
});

test("lossless book context never loads legacy blocks but imports stable terms", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-lossless-context-"));
  const legacyPath = join(directory, "legacy.db");
  createFixture(legacyPath, true);
  const manifestPath = manifestFixture(directory, "Smoky walked.\n\nBOOK ONE");
  const original = V4ReadAdapter.prototype.loadBlocks;
  V4ReadAdapter.prototype.loadBlocks = () => {
    throw new Error("poison legacy loadBlocks");
  };
  try {
    const context = BookContext.openLossless({ manifestPath, legacyV4DbPath: legacyPath });
    try {
      assert.equal(
        context.losslessBlocks.map((block) => block.sourceText).join(""),
        "Smoky walked.\n\nBOOK ONE",
      );
      assert.equal(context.stableTerms[0]?.target, "斯莫基");
      assert.equal(context.sourceLedger.sourceText, "Smoky walked.\n\nBOOK ONE");
    } finally {
      context.close();
    }
  } finally {
    V4ReadAdapter.prototype.loadBlocks = original;
  }
});

test("lossless book context exposes one reusable source language profile", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-language-context-"));
  const manifestPath = manifestFixture(
    directory,
    "CHAPITRE PREMIER\n\nLe texte.",
    "fr",
  );
  const context = BookContext.openLossless({ manifestPath });
  try {
    assert.equal(context.languageProfile.id, "fr");
    assert.equal(context.languageProfile, context.sourceLedger.languageProfile);
    assert.equal(context.certifiedSource?.sourceLanguage, "fr");
    assert.equal(
      context.certifiedSource?.sourceLanguageProfileVersion,
      context.languageProfile.version,
    );
  } finally {
    context.close();
  }
});
