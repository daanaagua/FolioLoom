import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { EvidenceIndex } from "../src/index/evidence-index.js";
import { QueryCompiler } from "../src/index/query-compiler.js";
import { V4ReadAdapter } from "../src/storage/v4-read-adapter.js";

function createV4Fixture(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        legacy_id TEXT,
        source_edition_id TEXT,
        chapter_id TEXT,
        chapter_title TEXT,
        chapter_index INTEGER,
        block_index INTEGER,
        global_index INTEGER,
        block_type TEXT,
        source_text TEXT,
        source_hash TEXT,
        token_count INTEGER,
        status TEXT,
        last_error TEXT,
        updated_at TEXT
      );
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY,
        kind TEXT,
        canonical_source TEXT,
        default_target TEXT,
        working_target TEXT,
        verified_target TEXT,
        description TEXT,
        status TEXT,
        scope TEXT,
        locked INTEGER,
        primary_lexeme_id TEXT,
        anchor_mention_id TEXT,
        created_version INTEGER,
        retired_version INTEGER,
        created_at TEXT
      );
      CREATE TABLE lexemes (
        id TEXT PRIMARY KEY,
        language TEXT,
        normalized_form TEXT,
        canonical_form TEXT,
        default_target TEXT,
        working_target TEXT,
        verified_target TEXT,
        status TEXT,
        locked INTEGER,
        created_version INTEGER,
        retired_version INTEGER,
        created_at TEXT
      );
      CREATE TABLE concept_lexemes (
        concept_id TEXT,
        lexeme_id TEXT,
        role TEXT,
        confidence REAL,
        status TEXT,
        evidence_id TEXT,
        created_version INTEGER,
        retired_version INTEGER,
        created_at TEXT
      );
      CREATE TABLE source_forms (
        id TEXT PRIMARY KEY,
        lexeme_id TEXT,
        form TEXT,
        normalized_form TEXT,
        grammar_json TEXT
      );
    `);
    const insertBlock = database.prepare(`
      INSERT INTO blocks (
        id, legacy_id, chapter_id, chapter_title, chapter_index,
        block_index, global_index, block_type, source_text, source_hash,
        token_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertBlock.run(
      "block-10", "legacy-10", "chapter-1", "The Mountain", 1,
      0, 10, "prose", "Typhon spoke from the throne.\n\nThe air was cold.",
      "hash-10", 12, "ready",
    );
    insertBlock.run(
      "block-30", "legacy-30", "chapter-2", "Afterward", 2,
      0, 30, "prose", "Typhon was later explained by the narrator.",
      "hash-30", 9, "ready",
    );

    database.prepare(`
      INSERT INTO concepts (
        id, kind, canonical_source, default_target, working_target,
        verified_target, status, locked, primary_lexeme_id, retired_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "concept-typhon", "person", "Typhon", "提丰旧译", "提丰", null,
      "active", 1, "lexeme-typhon", null,
    );
    database.prepare(`
      INSERT INTO lexemes (
        id, language, normalized_form, canonical_form, default_target,
        working_target, verified_target, status, locked, retired_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "lexeme-typhon", "en", "typhon", "Typhon", "台风", null, null,
      "active", 0, null,
    );
    database.prepare(`
      INSERT INTO concept_lexemes (
        concept_id, lexeme_id, role, confidence, status, retired_version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "concept-typhon", "lexeme-typhon", "canonical", 0.99, "active", null,
    );
    database.prepare(`
      INSERT INTO source_forms (id, lexeme_id, form, normalized_form)
      VALUES (?, ?, ?, ?)
    `).run("form-typhon", "lexeme-typhon", "Typhon", "typhon");
  } finally {
    database.close();
  }
}

test("cold adapter reads blocks and stable terms without narrative-memory APIs", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-v4-adapter-"));
  const databasePath = join(directory, "book.db");
  createV4Fixture(databasePath);

  const adapter = new V4ReadAdapter(databasePath);
  try {
    const blocks = adapter.loadBlocks([10, 30]);
    assert.deepEqual(blocks.map((block) => block.globalIndex), [10, 30]);

    const terms = adapter.loadStableTerms();
    assert.equal(terms.length, 1);
    assert.equal(terms[0]?.sourceForm, "Typhon");
    assert.equal(terms[0]?.target, "提丰");
    assert.equal(terms[0]?.locked, true);
    assert.equal("loadNarrativeMemories" in adapter, false);
    assert.equal("loadNarrativeSnapshots" in adapter, false);
    assert.equal("loadPremapResults" in adapter, false);
  } finally {
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("narrative-before-target excludes future evidence while translator-global can see it", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-evidence-index-"));
  const databasePath = join(directory, "book.db");
  createV4Fixture(databasePath);

  const adapter = new V4ReadAdapter(databasePath);
  const blocks = adapter.loadBlocks();
  const index = EvidenceIndex.fromBlocks(blocks);
  try {
    const narrativeHits = index.searchMentions({
      terms: ["Typhon"],
      channel: "narrative_before_target",
      targetGlobalIndex: 20,
      limit: 10,
    });
    assert.deepEqual(narrativeHits.map((hit) => hit.globalIndex), [10]);

    const translatorHits = index.searchMentions({
      terms: ["Typhon"],
      channel: "translator_global",
      targetGlobalIndex: 20,
      limit: 10,
    });
    assert.deepEqual(
      translatorHits.map((hit) => hit.globalIndex).sort((a, b) => a - b),
      [10, 30],
    );
  } finally {
    index.close();
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("evidence ids are deterministic across index rebuilds", () => {
  const block = {
    id: "block-stable",
    legacyId: "legacy-stable",
    chapterId: "chapter-stable",
    chapterTitle: "Stable",
    globalIndex: 7,
    blockIndex: 0,
    sourceText: "A deterministic paragraph.",
    sourceHash: "source-hash",
    tokenCount: 4,
  };
  const first = EvidenceIndex.fromBlocks([block]);
  const second = EvidenceIndex.fromBlocks([block]);
  try {
    const firstId = first.searchMentions({
      terms: ["deterministic"],
      channel: "translator_global",
      targetGlobalIndex: 7,
      limit: 1,
    })[0]?.evidenceId;
    const secondId = second.searchMentions({
      terms: ["deterministic"],
      channel: "translator_global",
      targetGlobalIndex: 7,
      limit: 1,
    })[0]?.evidenceId;
    assert.ok(firstId);
    assert.equal(firstId, secondId);
  } finally {
    first.close();
    second.close();
  }
});

test("query compiler accepts typed searches and rejects raw SQL", () => {
  const compiler = new QueryCompiler();
  assert.deepEqual(
    compiler.compile({
      operation: "mentions",
      terms: ["Typhon"],
      limit: 3,
    }),
    { operation: "mentions", terms: ["Typhon"], limit: 3 },
  );
  assert.throws(
    () => compiler.compile({ operation: "sql", sql: "SELECT * FROM blocks" }),
    /unsupported query operation/,
  );
});
