import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { EvidenceHit, VisibilityChannel } from "../domain/types.js";

interface EvidenceSourceBlock {
  id: string;
  globalIndex: number;
  sourceText: string;
  sourceHash: string;
}

export interface MentionSearch {
  terms: readonly string[];
  channel: VisibilityChannel;
  targetGlobalIndex: number;
  limit: number;
}

export interface CooccurrenceSearch extends MentionSearch {
  cues: readonly string[];
}

export interface ContextSearch {
  evidenceIds: readonly string[];
  channel: VisibilityChannel;
  targetGlobalIndex: number;
  beforeParagraphs: number;
  afterParagraphs: number;
}

interface EvidenceRow {
  evidence_id: string;
  block_id: string;
  global_index: number;
  paragraph_index: number;
  quote: string;
  source_hash: string;
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function evidenceId(block: EvidenceSourceBlock, paragraphIndex: number, quote: string): string {
  return `ev_${createHash("sha256")
    .update(block.id)
    .update("\0")
    .update(String(paragraphIndex))
    .update("\0")
    .update(normalizeQuote(quote))
    .update("\0")
    .update(block.sourceHash)
    .digest("hex")
    .slice(0, 24)}`;
}

function toFtsQuery(values: readonly string[]): string {
  const terms = [...new Set(values.map(normalizeQuote).filter(Boolean))];
  if (terms.length === 0) {
    throw new TypeError("at least one non-empty search term is required");
  }
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function assertSearchBounds(targetGlobalIndex: number, limit: number): void {
  if (!Number.isSafeInteger(targetGlobalIndex) || targetGlobalIndex < 0) {
    throw new TypeError("targetGlobalIndex must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("limit must be an integer from 1 to 100");
  }
}

export class EvidenceIndex {
  readonly #database: DatabaseSync;

  private constructor(blocks: readonly EvidenceSourceBlock[]) {
    this.#database = new DatabaseSync(":memory:");
    this.#database.exec(`
      CREATE TABLE evidence_paragraphs (
        evidence_id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL,
        global_index INTEGER NOT NULL,
        paragraph_index INTEGER NOT NULL,
        quote TEXT NOT NULL,
        source_hash TEXT NOT NULL
      );
      CREATE INDEX evidence_location
        ON evidence_paragraphs(global_index, block_id, paragraph_index);
      CREATE VIRTUAL TABLE evidence_fts
        USING fts5(evidence_id UNINDEXED, quote, tokenize='unicode61');
    `);
    const insertParagraph = this.#database.prepare(`
      INSERT INTO evidence_paragraphs (
        evidence_id, block_id, global_index, paragraph_index, quote, source_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.#database.prepare(`
      INSERT INTO evidence_fts (evidence_id, quote) VALUES (?, ?)
    `);
    this.#database.exec("BEGIN");
    try {
      for (const block of blocks) {
        const paragraphs = block.sourceText
          .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean);
        for (const [paragraphIndex, quote] of paragraphs.entries()) {
          const id = evidenceId(block, paragraphIndex, quote);
          insertParagraph.run(
            id,
            block.id,
            block.globalIndex,
            paragraphIndex,
            quote,
            block.sourceHash,
          );
          insertFts.run(id, quote);
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  static fromBlocks(blocks: readonly EvidenceSourceBlock[]): EvidenceIndex {
    return new EvidenceIndex(blocks);
  }

  searchMentions(search: MentionSearch): EvidenceHit[] {
    assertSearchBounds(search.targetGlobalIndex, search.limit);
    return this.#search(toFtsQuery(search.terms), search);
  }

  searchCooccurrence(search: CooccurrenceSearch): EvidenceHit[] {
    assertSearchBounds(search.targetGlobalIndex, search.limit);
    const termQuery = toFtsQuery(search.terms);
    const cueQuery = toFtsQuery(search.cues);
    return this.#search(`(${termQuery}) AND (${cueQuery})`, search);
  }

  getContext(search: ContextSearch): EvidenceHit[] {
    if (search.evidenceIds.length === 0) {
      return [];
    }
    for (const value of [search.beforeParagraphs, search.afterParagraphs]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
        throw new TypeError("context radius must be an integer from 0 to 10");
      }
    }
    const placeholders = search.evidenceIds.map(() => "?").join(", ");
    const visibility = search.channel === "narrative_before_target"
      ? "AND context.global_index <= ?"
      : "";
    const statement = this.#database.prepare(`
      SELECT DISTINCT
        context.evidence_id,
        context.block_id,
        context.global_index,
        context.paragraph_index,
        context.quote,
        context.source_hash
      FROM evidence_paragraphs AS seed
      JOIN evidence_paragraphs AS context
        ON context.block_id = seed.block_id
       AND context.paragraph_index BETWEEN
         seed.paragraph_index - ? AND seed.paragraph_index + ?
      WHERE seed.evidence_id IN (${placeholders})
        ${visibility}
      ORDER BY context.global_index ASC, context.paragraph_index ASC,
        context.evidence_id ASC
    `);
    // SQL placeholder order follows the context radius before the seed IDs.
    const ordered = [
      search.beforeParagraphs,
      search.afterParagraphs,
      ...search.evidenceIds,
      ...(search.channel === "narrative_before_target"
        ? [search.targetGlobalIndex]
        : []),
    ];
    return (statement.all(...ordered) as unknown as EvidenceRow[])
      .map((row) => this.#toHit(row, search.channel));
  }

  #search(query: string, search: MentionSearch): EvidenceHit[] {
    const visibility = search.channel === "narrative_before_target"
      ? "AND p.global_index <= ?"
      : "";
    const parameters: SQLInputValue[] = [query];
    if (search.channel === "narrative_before_target") {
      parameters.push(search.targetGlobalIndex);
    }
    parameters.push(search.targetGlobalIndex, search.limit);
    const statement = this.#database.prepare(`
      SELECT
        p.evidence_id,
        p.block_id,
        p.global_index,
        p.paragraph_index,
        p.quote,
        p.source_hash
      FROM evidence_fts AS f
      JOIN evidence_paragraphs AS p ON p.evidence_id = f.evidence_id
      WHERE evidence_fts MATCH ?
        ${visibility}
      ORDER BY bm25(evidence_fts) ASC,
        ABS(p.global_index - ?) ASC,
        p.global_index ASC,
        p.paragraph_index ASC,
        p.evidence_id ASC
      LIMIT ?
    `);
    return (statement.all(...parameters) as unknown as EvidenceRow[])
      .map((row) => this.#toHit(row, search.channel));
  }

  #toHit(row: EvidenceRow, channel: VisibilityChannel): EvidenceHit {
    return {
      evidenceId: row.evidence_id,
      blockId: row.block_id,
      globalIndex: row.global_index,
      paragraphIndex: row.paragraph_index,
      quote: row.quote,
      sourceHash: row.source_hash,
      channel,
    };
  }

  close(): void {
    this.#database.close();
  }
}
