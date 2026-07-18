import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { LexicalAnchor } from "../agents/lexical-anchorer.js";
import type { V4Block, VisibilityChannel } from "../domain/types.js";
import type {
  BookWindowPlan,
  BookWindowStatus,
  NarrativeMemoryRecord,
} from "../fullbook/types.js";

const SCHEMA_VERSION = "1";

export interface BookPlanInput {
  sourceDbPath: string;
  sourceFingerprint: string;
  protocolVersion: string;
  modelId: string;
  blocks: readonly V4Block[];
  windows: readonly BookWindowPlan[];
}

export interface PersistedWindow extends BookWindowPlan {
  status: BookWindowStatus;
  attemptCount: number;
  budget: Record<string, number>;
  warnings: string[];
  lastError: string;
}

export interface WindowCommitInput {
  windowId: string;
  status: "completed" | "completed_with_warnings";
  translations: Array<{ blockId: string; sourceHash: string; text: string }>;
  lexicalAnchors: readonly LexicalAnchor[];
  narrativeMemories: readonly NarrativeMemoryRecord[];
  styleTail: string;
  budget: Readonly<Record<string, number>>;
  warnings: readonly string[];
}

export interface WindowFailureInput {
  error: string;
  retry: boolean;
  budget: Readonly<Record<string, number>>;
  warnings: readonly string[];
}

export interface ActiveBookTranslation {
  blockId: string;
  globalIndex: number;
  chapterId: string;
  chapterTitle: string | null;
  sourceText: string;
  sourceHash: string;
  text: string;
  status: "completed" | "completed_with_warnings";
}

export interface BookStatusSummary {
  totalWindows: number;
  pendingWindows: number;
  runningWindows: number;
  completedWindows: number;
  warningWindows: number;
  humanRequiredWindows: number;
  failedWindows: number;
  translatedBlocks: number;
  totalBlocks: number;
  modelCalls: number;
}

interface WindowRow {
  window_id: string;
  ordinal: number;
  chapter_id: string;
  chapter_title: string | null;
  block_ids_json: string;
  global_indexes_json: string;
  source_tokens: number;
  source_chars: number;
  oversized: number;
  status: BookWindowStatus;
  attempt_count: number;
  budget_json: string;
  warnings_json: string;
  last_error: string;
}

function all<T>(statement: StatementSync, ...values: any[]): T[] {
  return statement.all(...values) as unknown as T[];
}

function one<T>(statement: StatementSync, ...values: any[]): T | undefined {
  return statement.get(...values) as unknown as T | undefined;
}

function normalizeSourceForm(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("corrupt string array in v5 book store");
  }
  return [...parsed];
}

function parseNumberArray(value: string): number[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => !Number.isSafeInteger(item))) {
    throw new Error("corrupt number array in v5 book store");
  }
  return [...parsed] as number[];
}

function windowFromRow(row: WindowRow): PersistedWindow {
  return {
    windowId: row.window_id,
    ordinal: row.ordinal,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    blockIds: parseStringArray(row.block_ids_json),
    globalIndexes: parseNumberArray(row.global_indexes_json),
    sourceTokens: row.source_tokens,
    sourceChars: row.source_chars,
    oversized: Boolean(row.oversized),
    status: row.status,
    attemptCount: row.attempt_count,
    budget: JSON.parse(row.budget_json) as Record<string, number>,
    warnings: parseStringArray(row.warnings_json),
    lastError: row.last_error,
  };
}

export class BookStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.#database = new DatabaseSync(absolute);
    this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    this.#createSchema();
  }

  initializePlan(input: BookPlanInput): void {
    if (input.blocks.length === 0 || input.windows.length === 0) {
      throw new Error("book plan must contain blocks and windows");
    }
    const existingFingerprint = this.#meta("source_fingerprint");
    if (existingFingerprint !== undefined
      && existingFingerprint !== input.sourceFingerprint) {
      throw new Error("source fingerprint mismatch for existing v5 book store");
    }
    const existingProtocol = this.#meta("protocol_version");
    if (existingProtocol !== undefined && existingProtocol !== input.protocolVersion) {
      throw new Error("protocol version mismatch for existing v5 book store");
    }
    if (existingFingerprint !== undefined) {
      this.#assertStoredBlocks(input.blocks);
      this.#assertStoredWindows(input.windows);
    }
    this.#transaction(() => {
      this.#setMeta("schema_version", SCHEMA_VERSION);
      this.#setMeta("source_db_path", resolve(input.sourceDbPath));
      this.#setMeta("source_fingerprint", input.sourceFingerprint);
      this.#setMeta("protocol_version", input.protocolVersion);
      this.#setMeta("model_id", input.modelId);
      const insertBlock = this.#database.prepare(`
        INSERT INTO book_blocks(
          block_id, global_index, chapter_id, chapter_title, block_index,
          source_text, source_hash, token_count
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(block_id) DO NOTHING
      `);
      for (const block of input.blocks) {
        insertBlock.run(
          block.id,
          block.globalIndex,
          block.chapterId ?? `chapter-at-${block.globalIndex}`,
          block.chapterTitle,
          block.blockIndex,
          block.sourceText,
          block.sourceHash,
          block.tokenCount,
        );
      }
      const insertWindow = this.#database.prepare(`
        INSERT INTO windows(
          window_id, ordinal, chapter_id, chapter_title, block_ids_json,
          global_indexes_json, source_tokens, source_chars, oversized, status
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(window_id) DO NOTHING
      `);
      for (const window of input.windows) {
        insertWindow.run(
          window.windowId,
          window.ordinal,
          window.chapterId,
          window.chapterTitle,
          JSON.stringify(window.blockIds),
          JSON.stringify(window.globalIndexes),
          window.sourceTokens,
          window.sourceChars,
          window.oversized ? 1 : 0,
        );
      }
      this.#database.prepare(`
        UPDATE windows
        SET status='pending', updated_at=datetime('now'),
            last_error=CASE
              WHEN last_error='' THEN 'recovered interrupted running window'
              ELSE last_error END
        WHERE status='running'
      `).run();
    });
    this.#assertStoredPlan(input);
  }

  pendingWindows(limit?: number): PersistedWindow[] {
    const maximum = limit === undefined ? Number.MAX_SAFE_INTEGER : limit;
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new TypeError("pending window limit must be a non-negative integer");
    }
    return all<WindowRow>(this.#database.prepare(`
      SELECT * FROM windows
      WHERE status='pending'
      ORDER BY ordinal ASC
      LIMIT ?
    `), maximum).map(windowFromRow);
  }

  window(windowId: string): PersistedWindow | undefined {
    const row = one<WindowRow>(
      this.#database.prepare("SELECT * FROM windows WHERE window_id=?"),
      windowId,
    );
    return row === undefined ? undefined : windowFromRow(row);
  }

  claimWindow(windowId: string): PersistedWindow {
    const result = this.#database.prepare(`
      UPDATE windows
      SET status='running', attempt_count=attempt_count+1,
          updated_at=datetime('now'), last_error=''
      WHERE window_id=? AND status='pending'
    `).run(windowId);
    if (Number(result.changes) !== 1) {
      throw new Error(`window is not pending: ${windowId}`);
    }
    return this.window(windowId) as PersistedWindow;
  }

  commitWindow(input: WindowCommitInput): void {
    const window = this.window(input.windowId);
    if (window === undefined || window.status !== "running") {
      throw new Error(`window is not running: ${input.windowId}`);
    }
    const expected = new Set(window.blockIds);
    const seen = new Set<string>();
    for (const translation of input.translations) {
      if (!expected.has(translation.blockId) || seen.has(translation.blockId)) {
        throw new Error(`unknown or duplicate committed block: ${translation.blockId}`);
      }
      seen.add(translation.blockId);
      const source = one<{ source_hash: string }>(
        this.#database.prepare("SELECT source_hash FROM book_blocks WHERE block_id=?"),
        translation.blockId,
      );
      if (source?.source_hash !== translation.sourceHash) {
        throw new Error(`source hash mismatch for block: ${translation.blockId}`);
      }
      if (translation.text.trim().length === 0) {
        throw new Error(`empty committed translation: ${translation.blockId}`);
      }
    }
    if (seen.size !== expected.size) {
      throw new Error(`window commit expected ${expected.size} blocks but received ${seen.size}`);
    }

    this.#transaction(() => {
      const deactivate = this.#database.prepare(
        "UPDATE translations SET active=0 WHERE block_id=? AND active=1",
      );
      const insertTranslation = this.#database.prepare(`
        INSERT INTO translations(
          block_id, window_id, version, source_hash, text, status, active
        ) VALUES(
          ?, ?,
          COALESCE((SELECT MAX(version)+1 FROM translations WHERE block_id=?), 1),
          ?, ?, ?, 1
        )
      `);
      for (const translation of input.translations) {
        deactivate.run(translation.blockId);
        insertTranslation.run(
          translation.blockId,
          input.windowId,
          translation.blockId,
          translation.sourceHash,
          translation.text.trim(),
          input.status,
        );
      }

      const upsertAnchor = this.#database.prepare(`
        INSERT INTO lexical_anchors(
          normalized_source, source_form, target, mode, confidence, updated_at
        ) VALUES(?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(normalized_source) DO NOTHING
      `);
      for (const anchor of input.lexicalAnchors) {
        upsertAnchor.run(
          normalizeSourceForm(anchor.sourceForm),
          anchor.sourceForm,
          anchor.target,
          anchor.mode,
          anchor.confidence,
        );
      }

      const upsertMemory = this.#database.prepare(`
        INSERT INTO narrative_memories(
          question_id, kind, subject_ids_json, verdict, confidence, channel,
          visible_from_global_index, evidence_ids_json, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(question_id) DO UPDATE SET
          kind=excluded.kind,
          subject_ids_json=excluded.subject_ids_json,
          verdict=excluded.verdict,
          confidence=excluded.confidence,
          channel=excluded.channel,
          visible_from_global_index=excluded.visible_from_global_index,
          evidence_ids_json=excluded.evidence_ids_json,
          updated_at=excluded.updated_at
      `);
      for (const memory of input.narrativeMemories) {
        upsertMemory.run(
          memory.questionId,
          memory.kind,
          JSON.stringify(memory.subjectIds),
          memory.verdict,
          memory.confidence,
          memory.channel,
          memory.visibleFromGlobalIndex,
          JSON.stringify(memory.evidenceIds),
        );
      }
      this.#database.prepare(`
        INSERT INTO style_state(key, value, updated_at)
        VALUES('previous_active_tail', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `).run(input.styleTail.slice(-1_600));
      this.#database.prepare(`
        UPDATE windows
        SET status=?, budget_json=?, warnings_json=?, last_error='',
            updated_at=datetime('now')
        WHERE window_id=? AND status='running'
      `).run(
        input.status,
        JSON.stringify(this.#mergeBudget(window.budget, input.budget)),
        JSON.stringify([...window.warnings, ...input.warnings]),
        input.windowId,
      );
      this.#appendEvent("window_committed", {
        windowId: input.windowId,
        status: input.status,
        blocks: input.translations.map((item) => item.blockId),
      });
    });
  }

  failWindow(windowId: string, input: WindowFailureInput): void {
    const window = this.window(windowId);
    if (window === undefined || window.status !== "running") {
      throw new Error(`window is not running: ${windowId}`);
    }
    const status: BookWindowStatus = input.retry ? "pending" : "human_required";
    this.#transaction(() => {
      const result = this.#database.prepare(`
        UPDATE windows
        SET status=?, budget_json=?, warnings_json=?, last_error=?,
            updated_at=datetime('now')
        WHERE window_id=? AND status='running'
      `).run(
        status,
        JSON.stringify(this.#mergeBudget(window.budget, input.budget)),
        JSON.stringify([...window.warnings, ...input.warnings]),
        input.error.slice(0, 4_000),
        windowId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`failed to update running window: ${windowId}`);
      }
      this.#appendEvent("window_failed", {
        windowId,
        retry: input.retry,
        status,
        error: input.error.slice(0, 1_000),
      });
    });
  }

  loadStyleTail(): string {
    return one<{ value: string }>(
      this.#database.prepare("SELECT value FROM style_state WHERE key='previous_active_tail'"),
    )?.value ?? "";
  }

  loadLexicalAnchors(): LexicalAnchor[] {
    return all<{
      source_form: string;
      target: string;
      mode: "stable" | "contextual";
      confidence: number;
    }>(this.#database.prepare(`
      SELECT source_form, target, mode, confidence
      FROM lexical_anchors ORDER BY normalized_source
    `)).map((row) => ({
      sourceForm: row.source_form,
      target: row.target,
      mode: row.mode,
      confidence: row.confidence,
    }));
  }

  loadNarrativeMemories(): NarrativeMemoryRecord[] {
    return all<{
      question_id: string;
      kind: string;
      subject_ids_json: string;
      verdict: string;
      confidence: number;
      channel: VisibilityChannel;
      visible_from_global_index: number;
      evidence_ids_json: string;
    }>(this.#database.prepare(`
      SELECT question_id, kind, subject_ids_json, verdict, confidence, channel,
             visible_from_global_index, evidence_ids_json
      FROM narrative_memories ORDER BY question_id
    `)).map((row) => ({
      questionId: row.question_id,
      kind: row.kind,
      subjectIds: parseStringArray(row.subject_ids_json),
      verdict: row.verdict,
      confidence: row.confidence,
      channel: row.channel,
      visibleFromGlobalIndex: row.visible_from_global_index,
      evidenceIds: parseStringArray(row.evidence_ids_json),
    }));
  }

  activeTranslations(): ActiveBookTranslation[] {
    return all<{
      block_id: string;
      global_index: number;
      chapter_id: string;
      chapter_title: string | null;
      source_text: string;
      source_hash: string;
      text: string;
      status: "completed" | "completed_with_warnings";
    }>(this.#database.prepare(`
      SELECT b.block_id, b.global_index, b.chapter_id, b.chapter_title,
             b.source_text, b.source_hash, t.text, t.status
      FROM book_blocks AS b
      JOIN translations AS t ON t.block_id=b.block_id AND t.active=1
      ORDER BY b.global_index
    `)).map((row) => ({
      blockId: row.block_id,
      globalIndex: row.global_index,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      sourceText: row.source_text,
      sourceHash: row.source_hash,
      text: row.text,
      status: row.status,
    }));
  }

  allWindows(): PersistedWindow[] {
    return all<WindowRow>(
      this.#database.prepare("SELECT * FROM windows ORDER BY ordinal"),
    ).map(windowFromRow);
  }

  statusSummary(): BookStatusSummary {
    const counts = new Map<string, number>();
    for (const row of all<{ status: string; count: number }>(
      this.#database.prepare("SELECT status, COUNT(*) AS count FROM windows GROUP BY status"),
    )) {
      counts.set(row.status, row.count);
    }
    const budgetRows = all<{ budget_json: string }>(
      this.#database.prepare("SELECT budget_json FROM windows"),
    );
    return {
      totalWindows: [...counts.values()].reduce((sum, value) => sum + value, 0),
      pendingWindows: counts.get("pending") ?? 0,
      runningWindows: counts.get("running") ?? 0,
      completedWindows: counts.get("completed") ?? 0,
      warningWindows: counts.get("completed_with_warnings") ?? 0,
      humanRequiredWindows: counts.get("human_required") ?? 0,
      failedWindows: counts.get("failed") ?? 0,
      translatedBlocks: one<{ count: number }>(
        this.#database.prepare("SELECT COUNT(*) AS count FROM translations WHERE active=1"),
      )?.count ?? 0,
      totalBlocks: one<{ count: number }>(
        this.#database.prepare("SELECT COUNT(*) AS count FROM book_blocks"),
      )?.count ?? 0,
      modelCalls: budgetRows.reduce((total, row) => {
        const budget = JSON.parse(row.budget_json) as Record<string, number>;
        return total + (Number(budget.modelCalls) || 0);
      }, 0),
    };
  }

  close(): void {
    this.#database.close();
  }

  #createSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS book_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS book_blocks(
        block_id TEXT PRIMARY KEY,
        global_index INTEGER NOT NULL UNIQUE,
        chapter_id TEXT NOT NULL,
        chapter_title TEXT,
        block_index INTEGER NOT NULL,
        source_text TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        token_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS windows(
        window_id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        chapter_id TEXT NOT NULL,
        chapter_title TEXT,
        block_ids_json TEXT NOT NULL,
        global_indexes_json TEXT NOT NULL,
        source_tokens INTEGER NOT NULL,
        source_chars INTEGER NOT NULL,
        oversized INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        budget_json TEXT NOT NULL DEFAULT '{}',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS translations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id TEXT NOT NULL REFERENCES book_blocks(block_id),
        window_id TEXT NOT NULL REFERENCES windows(window_id),
        version INTEGER NOT NULL,
        source_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(block_id, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_v5_active_translation
        ON translations(block_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS lexical_anchors(
        normalized_source TEXT PRIMARY KEY,
        source_form TEXT NOT NULL,
        target TEXT NOT NULL,
        mode TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS narrative_memories(
        question_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_ids_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        confidence REAL NOT NULL,
        channel TEXT NOT NULL,
        visible_from_global_index INTEGER NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS style_state(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  #meta(key: string): string | undefined {
    return one<{ value: string }>(
      this.#database.prepare("SELECT value FROM book_meta WHERE key=?"),
      key,
    )?.value;
  }

  #setMeta(key: string, value: string): void {
    this.#database.prepare(`
      INSERT INTO book_meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, value);
  }

  #appendEvent(kind: string, payload: unknown): void {
    this.#database.prepare(
      "INSERT INTO events(kind, payload_json) VALUES(?, ?)",
    ).run(kind, JSON.stringify(payload));
  }

  #mergeBudget(
    previous: Readonly<Record<string, number>>,
    current: Readonly<Record<string, number>>,
  ): Record<string, number> {
    const merged: Record<string, number> = { ...previous };
    for (const [key, rawValue] of Object.entries(current)) {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`invalid budget value for ${key}: ${rawValue}`);
      }
      merged[key] = (merged[key] ?? 0) + value;
    }
    return merged;
  }

  #assertStoredPlan(input: BookPlanInput): void {
    this.#assertStoredBlocks(input.blocks);
    this.#assertStoredWindows(input.windows);
  }

  #assertStoredBlocks(blocks: readonly V4Block[]): void {
    const storedBlocks = all<{ block_id: string; source_hash: string }>(
      this.#database.prepare("SELECT block_id, source_hash FROM book_blocks ORDER BY global_index"),
    );
    if (storedBlocks.length !== blocks.length) {
      throw new Error("stored block count does not match source plan");
    }
    const hashes = new Map(storedBlocks.map((row) => [row.block_id, row.source_hash]));
    for (const block of blocks) {
      if (hashes.get(block.id) !== block.sourceHash) {
        throw new Error(`stored source hash mismatch for block: ${block.id}`);
      }
    }
  }

  #assertStoredWindows(windows: readonly BookWindowPlan[]): void {
    const stored = all<{ window_id: string; ordinal: number }>(
      this.#database.prepare("SELECT window_id, ordinal FROM windows ORDER BY ordinal"),
    );
    if (stored.length !== windows.length) {
      throw new Error("stored window count does not match source plan");
    }
    for (let index = 0; index < windows.length; index += 1) {
      if (stored[index]?.window_id !== windows[index]?.windowId
        || stored[index]?.ordinal !== windows[index]?.ordinal) {
        throw new Error("stored window plan does not match source plan");
      }
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
