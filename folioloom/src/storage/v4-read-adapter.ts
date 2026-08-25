import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import type { StableTerm, V4Block } from "../domain/types.js";

interface BlockRow {
  id: string;
  legacy_id: string | null;
  chapter_id: string | null;
  chapter_title: string | null;
  global_index: number;
  block_index: number;
  source_text: string;
  source_hash: string;
  token_count: number;
}

interface StableTermRow {
  concept_id: string;
  lexeme_id: string;
  source_form: string;
  canonical_source: string;
  target: string;
  concept_locked: number;
  lexeme_locked: number;
}

function rows<T>(statement: StatementSync, ...parameters: SQLInputValue[]): T[] {
  return statement.all(...parameters) as unknown as T[];
}

/**
 * Narrow, read-only bridge into the V4 database. Deliberately exposes only
 * source blocks and stable lexical decisions: V4 narrative memories, snapshots,
 * and pre-map artifacts cannot cross this boundary.
 */
export class V4ReadAdapter {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath, { readOnly: true });
  }

  loadBlocks(globalIndexes?: readonly number[]): V4Block[] {
    const requested = globalIndexes === undefined
      ? undefined
      : [...new Set(globalIndexes)].sort((left, right) => left - right);
    if (requested?.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError("global indexes must be non-negative safe integers");
    }
    if (requested?.length === 0) {
      return [];
    }

    const filter = requested === undefined
      ? ""
      : `WHERE global_index IN (${requested.map(() => "?").join(", ")})`;
    const statement = this.#database.prepare(`
      SELECT
        id, legacy_id, chapter_id, chapter_title, global_index, block_index,
        source_text, source_hash, token_count
      FROM blocks
      ${filter}
      ORDER BY global_index ASC, block_index ASC, id ASC
    `);
    return rows<BlockRow>(statement, ...(requested ?? [])).map((row) => ({
      id: row.id,
      legacyId: row.legacy_id,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      globalIndex: row.global_index,
      blockIndex: row.block_index,
      sourceText: row.source_text,
      sourceHash: row.source_hash,
      tokenCount: row.token_count,
    }));
  }

  loadStableTerms(): StableTerm[] {
    const statement = this.#database.prepare(`
      SELECT
        c.id AS concept_id,
        l.id AS lexeme_id,
        COALESCE(sf.form, l.canonical_form, c.canonical_source) AS source_form,
        COALESCE(c.canonical_source, l.canonical_form, sf.form) AS canonical_source,
        COALESCE(
          NULLIF(c.verified_target, ''),
          NULLIF(c.working_target, ''),
          NULLIF(c.default_target, ''),
          NULLIF(l.verified_target, ''),
          NULLIF(l.working_target, ''),
          NULLIF(l.default_target, '')
        ) AS target,
        COALESCE(c.locked, 0) AS concept_locked,
        COALESCE(l.locked, 0) AS lexeme_locked
      FROM concepts AS c
      JOIN concept_lexemes AS cl ON cl.concept_id = c.id
      JOIN lexemes AS l ON l.id = cl.lexeme_id
      LEFT JOIN source_forms AS sf ON sf.lexeme_id = l.id
      WHERE c.retired_version IS NULL
        AND cl.retired_version IS NULL
        AND l.retired_version IS NULL
        AND COALESCE(c.status, '') NOT IN ('retired', 'rejected')
        AND COALESCE(cl.status, '') NOT IN ('retired', 'rejected')
        AND COALESCE(l.status, '') NOT IN ('retired', 'rejected')
        AND COALESCE(
          NULLIF(c.verified_target, ''),
          NULLIF(c.working_target, ''),
          NULLIF(c.default_target, ''),
          NULLIF(l.verified_target, ''),
          NULLIF(l.working_target, ''),
          NULLIF(l.default_target, '')
        ) IS NOT NULL
      ORDER BY c.id ASC, l.id ASC, source_form ASC
    `);
    return rows<StableTermRow>(statement).map((row) => ({
      conceptId: row.concept_id,
      lexemeId: row.lexeme_id,
      sourceForm: row.source_form,
      canonicalSource: row.canonical_source,
      target: row.target,
      locked: Boolean(row.concept_locked || row.lexeme_locked),
    }));
  }

  close(): void {
    this.#database.close();
  }
}
