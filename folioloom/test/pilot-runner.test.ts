import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import { runPilot } from "../src/pilot-runner.js";
import { BookContext } from "../src/fullbook/book-context.js";

function createPilotFixture(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY, legacy_id TEXT, source_edition_id TEXT,
        chapter_id TEXT, chapter_title TEXT, chapter_index INTEGER,
        block_index INTEGER, global_index INTEGER, block_type TEXT,
        source_text TEXT, source_hash TEXT, token_count INTEGER,
        status TEXT, last_error TEXT, updated_at TEXT
      );
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY, kind TEXT, canonical_source TEXT,
        default_target TEXT, working_target TEXT, verified_target TEXT,
        description TEXT, status TEXT, scope TEXT, locked INTEGER,
        primary_lexeme_id TEXT, anchor_mention_id TEXT,
        created_version INTEGER, retired_version INTEGER, created_at TEXT
      );
      CREATE TABLE lexemes (
        id TEXT PRIMARY KEY, language TEXT, normalized_form TEXT,
        canonical_form TEXT, default_target TEXT, working_target TEXT,
        verified_target TEXT, status TEXT, locked INTEGER,
        created_version INTEGER, retired_version INTEGER, created_at TEXT
      );
      CREATE TABLE concept_lexemes (
        concept_id TEXT, lexeme_id TEXT, role TEXT, confidence REAL,
        status TEXT, evidence_id TEXT, created_version INTEGER,
        retired_version INTEGER, created_at TEXT
      );
      CREATE TABLE source_forms (
        id TEXT PRIMARY KEY, lexeme_id TEXT, form TEXT,
        normalized_form TEXT, grammar_json TEXT
      );
    `);
    const insert = database.prepare(`
      INSERT INTO blocks (
        id, legacy_id, chapter_id, chapter_title, chapter_index,
        block_index, global_index, block_type, source_text, source_hash,
        token_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prose', ?, ?, ?, 'ready')
    `);
    const targets = [
      ["v06_ch07_001", "v06_ch07", "Chapter Seven", 7, 1, 219],
      ["v06_ch08_000", "v06_ch08", "Chapter Eight", 8, 0, 220],
      ["v06_ch08_001", "v06_ch08", "Chapter Eight", 8, 1, 221],
      ["v06_ch09_000", "v06_ch09", "Chapter Nine", 9, 0, 222],
      ["v06_ch09_001", "v06_ch09", "Chapter Nine", 9, 1, 223],
    ] as const;
    for (const [id, chapterId, title, chapterIndex, blockIndex, globalIndex] of targets) {
      const source = `Typhon source block ${globalIndex} contains complete prose and dialogue for translation.`;
      insert.run(
        id,
        id,
        chapterId,
        title,
        chapterIndex,
        blockIndex,
        globalIndex,
        source,
        `hash-${globalIndex}`,
        14,
      );
    }
    insert.run(
      "evidence-100", "evidence-100", "earlier", "Earlier", 1, 0, 100,
      "Typhon and Piaton once shared a body and a voice.", "hash-100", 10,
    );
    database.prepare(`
      INSERT INTO concepts (
        id, kind, canonical_source, default_target, working_target,
        verified_target, status, locked, primary_lexeme_id, retired_version
      ) VALUES ('typhon', 'person', 'Typhon', '提丰', '提丰', '提丰',
        'verified', 1, 'lex-typhon', NULL)
    `).run();
    database.prepare(`
      INSERT INTO lexemes (
        id, language, normalized_form, canonical_form, default_target,
        working_target, verified_target, status, locked, retired_version
      ) VALUES ('lex-typhon', 'en', 'typhon', 'Typhon', '提丰', '提丰',
        '提丰', 'verified', 1, NULL)
    `).run();
    database.prepare(`
      INSERT INTO concept_lexemes (
        concept_id, lexeme_id, role, confidence, status, retired_version
      ) VALUES ('typhon', 'lex-typhon', 'canonical', 1.0, 'verified', NULL)
    `).run();
    database.prepare(`
      INSERT INTO source_forms (id, lexeme_id, form, normalized_form)
      VALUES ('form-typhon', 'lex-typhon', 'Typhon', 'typhon')
    `).run();
  } finally {
    database.close();
  }
}

function userText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message && message.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
}

test("cold preview completes five blocks without narrative reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-pilot-runner-"));
  const databasePath = join(directory, "book.db");
  const output = join(directory, "output");
  createPilotFixture(databasePath);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("submit_questions", { questions: [] }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("finish_research", { unresolvedQuestionIds: [] }),
      { stopReason: "toolUse" },
    ),
    ...Array.from({ length: 3 }, () => (context: Context) => {
      const ids = [...userText(context).matchAll(/\[(v06_ch\d+_\d+)\]/gu)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined);
      assert.ok(ids.length > 0);
      return fauxAssistantMessage(
        fauxToolCall("finalize_translation", {
          translations: ids.map((blockId) => ({
            blockId,
            text: "提丰出现在对应文本块的完整中文译文中，保留了原文中的叙事与对话。",
          })),
          notes: [],
        }),
        { stopReason: "toolUse" },
      );
    }),
  ]);

  try {
    const result = await runPilot({
      dbPath: databasePath,
      outputDir: output,
      globalIndexes: [219, 220, 221, 222, 223],
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      translationConcurrency: 1,
      hardDeadlineMs: 30_000,
    });

    assert.equal(result.translations.length, 5);
    assert.equal(result.metrics.narrativeTableReads, 0);
    assert.ok(result.metrics.modelCalls <= 20);
    assert.ok(result.metrics.offTargetEvidenceChars <= 12_000);
    assert.equal(result.metrics.leaseReleased, true);
    assert.equal(existsSync(result.leasePath), false);
    assert.equal(result.status, "completed");
    for (const name of [
      "Typhon_v5_agent_translation.txt",
      "Typhon_v5_agent_bilingual.txt",
      "Typhon_v5_agent_audit.json",
      "Typhon_v5_agent_metrics.json",
    ]) {
      assert.equal(existsSync(join(output, name)), true, name);
    }
    const audit = readFileSync(
      join(output, "Typhon_v5_agent_audit.json"),
      "utf8",
    );
    assert.equal(audit.includes("reasoning_content"), false);
    assert.equal(audit.includes("Typhon and Piaton once shared"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared context reuses lexical decisions, bounded tail, and visible memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-shared-window-"));
  const databasePath = join(directory, "book.db");
  createPilotFixture(databasePath);
  const database = new DatabaseSync(databasePath);
  database.prepare(`UPDATE blocks SET source_text=?, source_hash=? WHERE global_index=219`).run(
    "Smoky stood beside Typhon and listened.",
    "hash-smoky-219",
  );
  database.prepare(`UPDATE blocks SET source_text=?, source_hash=? WHERE global_index=220`).run(
    "Smoky answered Typhon without hesitation.",
    "hash-smoky-220",
  );
  database.close();
  const context = BookContext.open(databasePath);
  try {
    const firstFaux = fauxProvider();
    firstFaux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
        anchors: [{
          sourceForm: "Smoky",
          target: "斯莫基",
          mode: "stable",
          semanticClass: "proper_name",
          confidence: 0.97,
        }],
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("submit_questions", { questions: [] }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("finalize_translation", {
        translations: [{
          blockId: "v06_ch07_001",
          text: "斯莫基站在提丰身旁，静静听着。",
        }],
        notes: [],
      }), { stopReason: "toolUse" }),
    ]);
    const first = await runPilot({
      dbPath: databasePath,
      context,
      outputDir: join(directory, "first"),
      globalIndexes: [219],
      model: firstFaux.getModel(),
      streamFn: firstFaux.provider.streamSimple.bind(firstFaux.provider),
      hardDeadlineMs: 30_000,
    });
    assert.equal(first.audit.lexicalAnchors[0]?.sourceForm, "Smoky");

    const secondFaux = fauxProvider();
    secondFaux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("submit_questions", { questions: [] }),
        { stopReason: "toolUse" },
      ),
      (agentContext: Context) => {
        const prompt = userText(agentContext);
        assert.match(prompt, /上一窗尾部/u);
        assert.match(prompt, /Typhon is a single continuing subject/u);
        return fauxAssistantMessage(fauxToolCall("finalize_translation", {
          translations: [{
            blockId: "v06_ch08_000",
            text: "斯莫基毫不迟疑地回答了提丰。",
          }],
          notes: [],
        }), { stopReason: "toolUse" });
      },
    ]);
    const second = await runPilot({
      dbPath: databasePath,
      context,
      outputDir: join(directory, "second"),
      globalIndexes: [220],
      model: secondFaux.getModel(),
      streamFn: secondFaux.provider.streamSimple.bind(secondFaux.provider),
      persistedAnchors: first.audit.lexicalAnchors,
      persistedNarrativeMemories: [{
        questionId: "q-typhon-persisted",
        kind: "entity_identity",
        subjectIds: ["typhon"],
        verdict: "Typhon is a single continuing subject.",
        confidence: 0.96,
        channel: "translator_global",
        visibleFromGlobalIndex: 0,
        evidenceIds: ["ev-typhon"],
      }],
      previousActiveTail: "上一窗尾部",
      hardDeadlineMs: 30_000,
    });
    assert.equal(second.audit.lexicalAnchors.length, 0);
    assert.deepEqual(
      second.snapshot.translatorFacts.map((item) => item.questionId),
      ["q-typhon-persisted"],
    );
  } finally {
    context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
