import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { CommitPromotion } from "../fullbook/commit-coordinator.js";
import type { BookWindowPlan, BookWindowStatus } from "../fullbook/types.js";
import { supportedSourceLanguageIds } from "../language/profiles.js";
import {
  canonicalJson,
  KnowledgeStore,
  type KnowledgeCandidate,
  type KnowledgeRevision,
  type KnowledgeStatus,
} from "../knowledge/knowledge-store.js";
import {
  createKnowledgeSnapshot,
  type KnowledgeSnapshot,
} from "../knowledge/snapshot.js";
import { blockId } from "../source/block-builder.js";
import type { LosslessBlock, StructureAnnotation } from "../source/types.js";
import { scalarLength } from "../source/types.js";
import { parseStyleObservation } from "../style/style-observation.js";
import type { LocalStyleObservation } from "../style/types.js";
import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER,
  LOSSLESS_BOOK_SCHEMA_TABLES,
  LOSSLESS_BOOK_SCHEMA_V2,
  LOSSLESS_BOOK_SCHEMA_VERSION,
} from "./book-schema-v2.js";

export interface CertifiedSourceRange {
  rangeId: string;
  canonicalStart: number;
  canonicalEnd: number;
  originKind: string;
  originRef: string;
  transformation: string;
  rawStart?: number;
  rawEnd?: number;
}

export interface CertifiedSourceInput {
  sourceVersion: string;
  rawSha256: string;
  canonicalSha256: string;
  canonicalChars: number;
  coordinateUnit: "unicode_scalar";
  sourceFormat: string;
  encoding: string;
  extractor: string;
  sourceLanguage?: string;
  sourceLanguageProfileVersion?: string;
  sourceLanguageCompatibilityMode?: boolean;
  ranges: readonly CertifiedSourceRange[];
}

export interface DerivedPlan {
  blocks: readonly LosslessBlock[];
  annotations: readonly StructureAnnotation[];
}

export interface TranslationRunMeta {
  runId?: string;
  sourceVersion: string;
  protocolVersion: string;
  modelId: string;
  initialSnapshotId: string;
  initialSnapshot?: KnowledgeSnapshot;
  metadata?: unknown;
}

export interface LosslessBookStatusSummary {
  totalWindows: number;
  pendingWindows: number;
  runningWindows: number;
  stagedWindows: number;
  completedWindows: number;
  warningWindows: number;
  humanRequiredWindows: number;
  failedWindows: number;
  modelCalls: number;
}

export interface StoredTranslationRun {
  runId: string;
  sourceVersion: string;
  protocolVersion: string;
  modelId: string;
  status: string;
  metadata: unknown;
}

export interface RecoveryMutationPromotion {
  recoveryId: string;
  runId: string;
  kind: "reset_interrupted_windows" | "reset_missing_windows" | "quarantine_old_run";
  affectedWindowIds: readonly string[];
  expectedBeforeHash: string;
  expectedAfterHash: string;
  result: unknown;
}

export interface StagedTranslationInput {
  blockId: string;
  sourceHash: string;
  text: string;
}

export interface KnowledgeCandidateInput {
  recordId: string;
  normalizedSubject: string;
  kind: string;
  payload: unknown;
}

export interface WindowStageInput {
  runId: string;
  windowId: string;
  snapshotId: string;
  status: "completed" | "completed_with_warnings";
  translations: StagedTranslationInput[];
  knowledgeCandidates: KnowledgeCandidateInput[];
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

export type FaultCheckpoint =
  | "after_stage"
  | "before_translation_insert"
  | "before_promote"
  | "before_commit";

export interface FaultInjector {
  checkpoint(name: FaultCheckpoint): void;
}

export interface PersistedLosslessWindow extends BookWindowPlan {
  status: BookWindowStatus | "staged";
  attemptCount: number;
  snapshotId: string | null;
  budget: Record<string, number>;
  warnings: string[];
  lastError: string;
}

export interface ActiveLosslessTranslation {
  runId: string;
  windowId: string;
  blockId: string;
  sourceVersion: string;
  sourceHash: string;
  text: string;
  status: "completed" | "completed_with_warnings";
  version: number;
}

export type KnowledgeHistoryRecord = KnowledgeRevision;

export interface CandidateHistoryRecord {
  runId: string;
  candidateId: string;
  windowId: string;
  snapshotId: string;
  normalizedSubject: string;
  kind: string;
  payload: unknown;
  stageState: "staged" | "promoted";
}

export interface CachedWaveAnchorDecision {
  inputHash: string;
  decision: unknown;
}

export interface AuditProjection {
  runId: string;
  sourceVersion: string;
  protocolVersion: string;
  modelId: string;
  status: string;
  windows: PersistedLosslessWindow[];
  translations: ActiveLosslessTranslation[];
  knowledge: KnowledgeHistoryRecord[];
  snapshotIds: string[];
}

export interface LosslessAuditBlock {
  blockId: string;
  sourceVersion: string;
  canonicalStart: number;
  canonicalEnd: number;
  sourceText: string;
  sourceHash: string;
  globalIndex: number;
  tokenCount: number;
}

export interface LosslessAuditMembership {
  runId: string;
  windowId: string;
  sourceVersion: string;
  blockId: string;
  position: number;
}

export interface LosslessAuditTranslation {
  runId: string;
  windowId: string;
  sourceVersion: string;
  blockId: string;
  sourceHash: string;
  text: string;
  resultStatus: string;
  version: number;
  stageState: string;
  active: boolean;
  snapshotId: string;
}

export interface LosslessAuditKnowledgeRevision {
  runId: string;
  recordId: string;
  revisionId: string;
  revision: number;
  normalizedSubject: string;
  kind: string;
  status: string;
  active: boolean;
  payload: unknown;
  producingWindowId: string;
}

export interface LosslessAuditSnapshot {
  sequence: number;
  snapshotId: string;
  parentSnapshotId: string | null;
  producingWindowId: string | null;
  contentHash: string;
  payload: unknown;
}

export interface LosslessAuditState {
  runId: string;
  sourceVersion: string;
  protocolVersion: string;
  modelId: string;
  runStatus: string;
  runMetadata: unknown;
  canonicalSha256: string;
  canonicalChars: number;
  blocks: LosslessAuditBlock[];
  windows: PersistedLosslessWindow[];
  memberships: LosslessAuditMembership[];
  translations: LosslessAuditTranslation[];
  knowledgeRevisions: LosslessAuditKnowledgeRevision[];
  snapshots: LosslessAuditSnapshot[];
}

interface SourceVersionRow {
  source_version: string;
  canonical_sha256: string;
  canonical_chars: number;
  source_fingerprint: string;
  plan_fingerprint: string | null;
}

interface RunRow {
  run_id: string;
  source_version: string;
  protocol_version: string;
  model_id: string;
  metadata_json: string;
  status: string;
}

interface WindowRow {
  run_id: string;
  window_id: string;
  source_version: string;
  ordinal: number;
  chapter_id: string;
  chapter_title: string | null;
  source_tokens: number;
  source_chars: number;
  oversized: number;
  status: BookWindowStatus | "staged";
  attempt_count: number;
  snapshot_id: string | null;
  budget_json: string;
  warnings_json: string;
  last_error: string;
}

interface LogicalBlockRow {
  block_id: string;
  source_version: string;
  source_hash: string;
  global_index: number;
  canonical_start: number;
  canonical_end: number;
  token_count: number;
}

function all<T>(statement: StatementSync, ...values: any[]): T[] {
  return statement.all(...values) as unknown as T[];
}

function one<T>(statement: StatementSync, ...values: any[]): T | undefined {
  return statement.get(...values) as unknown as T | undefined;
}

function requireNonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function requireSafeInteger(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function jsonText(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value, (_key, candidate: unknown) => {
      if (candidate === undefined
        || typeof candidate === "function"
        || typeof candidate === "symbol"
        || typeof candidate === "bigint") {
        throw new TypeError("unsupported JSON value");
      }
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        throw new TypeError("non-finite JSON number");
      }
      return candidate;
    });
    if (encoded === undefined) {
      throw new TypeError("undefined JSON root");
    }
    return encoded;
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function knowledgeRecordId(normalizedSubject: string, kind: string): string {
  return hashText(`${normalizedSubject}\0${kind}`);
}

const PROJECTABLE_KNOWLEDGE_STATUSES = new Set<KnowledgeStatus>([
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
]);

function stringArrayFromJson(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`corrupt ${label} JSON`);
  }
  return [...parsed];
}

function budgetFromJson(value: string): Record<string, number> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("corrupt budget JSON");
  }
  const result: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(parsed)) {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new Error("corrupt budget JSON");
    }
    result[key] = candidate;
  }
  return result;
}

function validateBudget(budget: Readonly<Record<string, number>>): string {
  if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
    throw new TypeError("budget must be an object");
  }
  for (const [key, value] of Object.entries(budget)) {
    requireNonempty(key, "budget key");
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`budget value for ${key} must be finite and non-negative`);
    }
  }
  return jsonText(budget, "budget");
}

function validateWarnings(warnings: readonly string[]): string {
  if (!Array.isArray(warnings) || warnings.some((item) => typeof item !== "string")) {
    throw new TypeError("warnings must be an array of strings");
  }
  return jsonText(warnings, "warnings");
}

function windowFromRow(row: WindowRow, blockIds: string[]): PersistedLosslessWindow {
  return {
    windowId: row.window_id,
    ordinal: row.ordinal,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    blockIds,
    globalIndexes: [],
    sourceTokens: row.source_tokens,
    sourceChars: row.source_chars,
    oversized: Boolean(row.oversized),
    status: row.status,
    attemptCount: row.attempt_count,
    snapshotId: row.snapshot_id,
    budget: budgetFromJson(row.budget_json),
    warnings: stringArrayFromJson(row.warnings_json, "warnings"),
    lastError: row.last_error,
  };
}

export class LosslessBookStore {
  readonly #database: DatabaseSync;
  readonly #faultInjector: FaultInjector | undefined;

  constructor(path: string, faultInjector?: FaultInjector) {
    const absolute = resolve(requireNonempty(path, "database path"));
    this.#faultInjector = faultInjector;
    mkdirSync(dirname(absolute), { recursive: true });
    this.#database = new DatabaseSync(absolute);
    try {
      this.#database.exec("PRAGMA foreign_keys=ON");
      const userVersion = one<{ user_version: number }>(
        this.#database.prepare("PRAGMA user_version"),
      )?.user_version ?? 0;
      const tables = all<{ name: string }>(this.#database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)).map((row) => row.name);
      if (tables.length === 0 && userVersion === 0) {
        this.#initializeSchema();
      } else {
        this.#verifyExistingSchema(userVersion, tables);
      }
      this.#database.exec("PRAGMA journal_mode=WAL");
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  databaseSettings(): { foreignKeys: boolean; journalMode: string } {
    const foreignKeys = one<{ foreign_keys: number }>(
      this.#database.prepare("PRAGMA foreign_keys"),
    )?.foreign_keys;
    const journalMode = one<{ journal_mode: string }>(
      this.#database.prepare("PRAGMA journal_mode"),
    )?.journal_mode;
    return { foreignKeys: foreignKeys === 1, journalMode: journalMode ?? "" };
  }

  listTranslationRuns(): StoredTranslationRun[] {
    return all<RunRow>(this.#database.prepare(`
      SELECT run_id, source_version, protocol_version, model_id, metadata_json, status
      FROM translation_runs ORDER BY created_at, run_id
    `)).map((run) => ({
      runId: run.run_id,
      sourceVersion: run.source_version,
      protocolVersion: run.protocol_version,
      modelId: run.model_id,
      status: run.status,
      metadata: JSON.parse(run.metadata_json) as unknown,
    }));
  }

  registerSource(input: CertifiedSourceInput): string {
    const normalized = this.#validateSource(input);
    const payload = jsonText(normalized, "certified source");
    const fingerprint = hashText(payload);
    const existing = one<SourceVersionRow>(
      this.#database.prepare("SELECT * FROM source_versions WHERE source_version=?"),
      input.sourceVersion,
    );
    if (existing !== undefined) {
      if (existing.source_fingerprint !== fingerprint) {
        throw new Error(`source version ${input.sourceVersion} already identifies a different source`);
      }
      return existing.source_version;
    }

    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO source_versions(
          source_version, raw_sha256, canonical_sha256, canonical_chars,
          coordinate_unit, source_format, encoding, extractor,
          source_fingerprint, source_payload_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.sourceVersion,
        normalized.rawSha256,
        normalized.canonicalSha256,
        normalized.canonicalChars,
        normalized.coordinateUnit,
        normalized.sourceFormat,
        normalized.encoding,
        normalized.extractor,
        fingerprint,
        payload,
      );
      const insertRange = this.#database.prepare(`
        INSERT INTO source_ranges(
          source_version, range_id, canonical_start, canonical_end,
          origin_kind, origin_ref, transformation, raw_start, raw_end
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const range of normalized.ranges) {
        insertRange.run(
          normalized.sourceVersion,
          range.rangeId,
          range.canonicalStart,
          range.canonicalEnd,
          range.originKind,
          range.originRef,
          range.transformation,
          range.rawStart ?? null,
          range.rawEnd ?? null,
        );
      }
      this.#appendEvent(null, "source_registered", {
        sourceVersion: normalized.sourceVersion,
        fingerprint,
      });
    });
    return normalized.sourceVersion;
  }

  replaceDerivedPlan(sourceVersion: string, plan: DerivedPlan): void {
    requireNonempty(sourceVersion, "sourceVersion");
    const source = this.#source(sourceVersion);
    const normalized = this.#validateDerivedPlan(source, plan);
    const fingerprint = hashText(jsonText(normalized, "derived plan"));
    if (source.plan_fingerprint !== null) {
      if (source.plan_fingerprint !== fingerprint) {
        throw new Error(`derived plan for ${sourceVersion} already contains different data`);
      }
      return;
    }

    this.#transaction(() => {
      const insertAnnotation = this.#database.prepare(`
        INSERT INTO structure_annotations(
          source_version, annotation_id, kind, canonical_start, canonical_end,
          title, boundary_weight
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      for (const annotation of normalized.annotations) {
        insertAnnotation.run(
          sourceVersion,
          annotation.id,
          annotation.kind,
          annotation.start,
          annotation.end,
          annotation.title,
          annotation.boundaryWeight,
        );
      }
      const insertBlock = this.#database.prepare(`
        INSERT INTO logical_blocks(
          source_version, block_id, canonical_start, canonical_end, source_text,
          source_hash, global_index, token_count, structure_id, structure_title
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const block of normalized.blocks) {
        insertBlock.run(
          sourceVersion,
          block.id,
          block.canonicalStart,
          block.canonicalEnd,
          block.sourceText,
          block.sourceHash,
          block.globalIndex,
          block.tokenCount,
          block.structureId,
          block.structureTitle,
        );
      }
      const result = this.#database.prepare(`
        UPDATE source_versions SET plan_fingerprint=?
        WHERE source_version=? AND plan_fingerprint IS NULL
      `).run(fingerprint, sourceVersion);
      if (Number(result.changes) !== 1) {
        throw new Error(`derived plan changed concurrently for ${sourceVersion}`);
      }
      this.#appendEvent(null, "derived_plan_registered", { sourceVersion, fingerprint });
    });
  }

  createTranslationRun(meta: TranslationRunMeta): string {
    const runId = meta.runId === undefined ? randomUUID() : requireNonempty(meta.runId, "runId");
    const sourceVersion = requireNonempty(meta.sourceVersion, "sourceVersion");
    const source = this.#source(sourceVersion);
    if (source.plan_fingerprint === null) {
      throw new Error(`source ${sourceVersion} has no derived plan`);
    }
    const protocolVersion = requireNonempty(meta.protocolVersion, "protocolVersion");
    const modelId = requireNonempty(meta.modelId, "modelId");
    const snapshotId = requireNonempty(meta.initialSnapshotId, "initialSnapshotId");
    const metadata = jsonText(meta.metadata ?? {}, "translation run metadata");
    const initialSnapshot = meta.initialSnapshot;
    if (initialSnapshot !== undefined) {
      if (initialSnapshot.runId !== runId) {
        throw new Error(`initial snapshot ${initialSnapshot.id} belongs to another run`);
      }
      if (initialSnapshot.id !== snapshotId
        || initialSnapshot.id !== initialSnapshot.contentHash) {
        throw new Error("initial snapshot identity mismatch");
      }
    }
    const snapshotPayload = jsonText(initialSnapshot ?? [], "initial knowledge snapshot");
    const snapshotHash = initialSnapshot?.contentHash ?? hashText(snapshotPayload);
    const existing = one<RunRow>(
      this.#database.prepare("SELECT * FROM translation_runs WHERE run_id=?"),
      runId,
    );
    if (existing !== undefined) {
      if (existing.source_version !== sourceVersion
        || existing.protocol_version !== protocolVersion
        || existing.model_id !== modelId
        || existing.metadata_json !== metadata) {
        throw new Error(`translation run ${runId} metadata mismatch`);
      }
      const snapshot = one<{ snapshot_id: string }>(this.#database.prepare(`
        SELECT snapshot_id FROM knowledge_snapshots
        WHERE run_id=? ORDER BY rowid LIMIT 1
      `), runId);
      if (snapshot?.snapshot_id !== snapshotId) {
        throw new Error(`translation run ${runId} initial snapshot mismatch`);
      }
      return runId;
    }

    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO translation_runs(
          run_id, source_version, protocol_version, model_id, metadata_json
        ) VALUES(?, ?, ?, ?, ?)
      `).run(runId, sourceVersion, protocolVersion, modelId, metadata);
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, content_hash, payload_json
        ) VALUES(?, ?, ?, ?)
      `).run(runId, snapshotId, snapshotHash, snapshotPayload);
      this.#appendEvent(runId, "translation_run_created", {
        runId, sourceVersion, protocolVersion, modelId, snapshotId,
      });
    });
    return runId;
  }

  initializeWindowPlan(runId: string, windows: readonly BookWindowPlan[]): void {
    const run = this.#run(runId);
    const normalized = this.#validateWindows(run, windows);
    const existing = one<{ count: number }>(
      this.#database.prepare("SELECT COUNT(*) AS count FROM window_plans WHERE run_id=?"),
      runId,
    )?.count ?? 0;
    if (existing !== 0) {
      const persisted = all<WindowRow>(this.#database.prepare(`
        SELECT * FROM window_plans WHERE run_id=? ORDER BY ordinal
      `), runId).map((row) => {
        const window = windowFromRow(row, this.#membershipIds(runId, row.window_id));
        window.globalIndexes = this.#globalIndexes(runId, row.window_id);
        return {
          windowId: window.windowId,
          ordinal: window.ordinal,
          chapterId: window.chapterId,
          chapterTitle: window.chapterTitle,
          blockIds: window.blockIds,
          globalIndexes: window.globalIndexes,
          sourceTokens: window.sourceTokens,
          sourceChars: window.sourceChars,
          oversized: window.oversized,
        } satisfies BookWindowPlan;
      });
      if (jsonText(persisted, "persisted window plan") !== jsonText(normalized, "window plan")) {
        throw new Error(`window plan mismatch for run ${runId}`);
      }
      return;
    }

    this.#transaction(() => {
      const insertWindow = this.#database.prepare(`
        INSERT INTO window_plans(
          run_id, window_id, source_version, ordinal, chapter_id, chapter_title,
          source_tokens, source_chars, oversized
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMembership = this.#database.prepare(`
        INSERT INTO window_membership(
          run_id, window_id, source_version, block_id, position
        ) VALUES(?, ?, ?, ?, ?)
      `);
      for (const window of normalized) {
        insertWindow.run(
          runId,
          window.windowId,
          run.source_version,
          window.ordinal,
          window.chapterId,
          window.chapterTitle,
          window.sourceTokens,
          window.sourceChars,
          window.oversized ? 1 : 0,
        );
        for (let position = 0; position < window.blockIds.length; position += 1) {
          insertMembership.run(
            runId,
            window.windowId,
            run.source_version,
            window.blockIds[position],
            position,
          );
        }
      }
      this.#database.prepare(
        "UPDATE translation_runs SET status='running' WHERE run_id=? AND status='created'",
      ).run(runId);
      this.#appendEvent(runId, "window_plan_initialized", {
        runId,
        windows: normalized.map((window) => window.windowId),
      });
    });
  }

  bindWindowsToSnapshot(
    runId: string,
    windowIds: readonly string[],
    snapshotId: string,
  ): void {
    this.#run(runId);
    requireNonempty(snapshotId, "snapshotId");
    if (!Array.isArray(windowIds) || windowIds.length === 0) {
      throw new TypeError("windowIds must not be empty");
    }
    const unique = [...new Set(windowIds.map((windowId) =>
      requireNonempty(windowId, "windowId")))];
    if (unique.length !== windowIds.length) {
      throw new Error("duplicate windowId in snapshot binding");
    }
    const snapshot = one<{ present: number }>(this.#database.prepare(`
      SELECT 1 AS present FROM knowledge_snapshots WHERE run_id=? AND snapshot_id=?
    `), runId, snapshotId);
    if (snapshot === undefined) {
      const foreign = one<{ run_id: string }>(this.#database.prepare(`
        SELECT run_id FROM knowledge_snapshots WHERE snapshot_id=? LIMIT 1
      `), snapshotId);
      throw new Error(foreign === undefined
        ? `unknown snapshot ${snapshotId} for run ${runId}`
        : `snapshot ${snapshotId} belongs to another run`);
    }
    this.#transaction(() => {
      for (const windowId of unique) {
        const window = this.#window(runId, windowId);
        if (window === undefined) {
          throw new Error(`run ${runId} has no window ${windowId}`);
        }
        if (window.status !== "pending") {
          throw new Error(`window is not pending: ${runId}/${windowId}`);
        }
        if (window.snapshotId !== null && window.snapshotId !== snapshotId) {
          throw new Error(
            `snapshot mismatch for ${windowId}: expected ${window.snapshotId}, got ${snapshotId}`,
          );
        }
        this.#database.prepare(`
          UPDATE window_plans SET snapshot_id=?, updated_at=datetime('now')
          WHERE run_id=? AND window_id=? AND status='pending'
        `).run(snapshotId, runId, windowId);
      }
      this.#appendEvent(runId, "wave_snapshot_bound", {
        runId, snapshotId, windowIds: unique,
      });
    });
  }

  claimWindow(runId: string, windowId: string): PersistedLosslessWindow {
    requireNonempty(runId, "runId");
    requireNonempty(windowId, "windowId");
    return this.#transaction(() => {
      const result = this.#database.prepare(`
        UPDATE window_plans
        SET status='running', attempt_count=attempt_count+1,
            last_error='', updated_at=datetime('now')
        WHERE run_id=? AND window_id=? AND status='pending'
      `).run(runId, windowId);
      if (Number(result.changes) !== 1) {
        const exists = one<{ present: number }>(
          this.#database.prepare(`
            SELECT 1 AS present FROM window_plans WHERE run_id=? AND window_id=?
          `),
          runId,
          windowId,
        );
        if (exists === undefined) {
          throw new Error(`run ${runId} has no window ${windowId}`);
        }
        throw new Error(`window is not pending: ${runId}/${windowId}`);
      }
      this.#appendEvent(runId, "window_claimed", { runId, windowId });
      return this.#window(runId, windowId) as PersistedLosslessWindow;
    });
  }

  stageWindow(input: WindowStageInput): void {
    requireNonempty(input.runId, "runId");
    requireNonempty(input.windowId, "windowId");
    requireNonempty(input.snapshotId, "snapshotId");
    if (input.status !== "completed" && input.status !== "completed_with_warnings") {
      throw new TypeError("stage status must be completed or completed_with_warnings");
    }
    if (typeof input.styleTail !== "string") {
      throw new TypeError("styleTail must be a string");
    }
    const budgetJson = validateBudget(input.budget);
    const warningsJson = validateWarnings(input.warnings);
    const candidates = input.knowledgeCandidates.map((candidate) => ({
      recordId: requireNonempty(candidate.recordId, "knowledge recordId"),
      normalizedSubject: requireNonempty(candidate.normalizedSubject, "normalizedSubject"),
      kind: requireNonempty(candidate.kind, "knowledge kind"),
      payloadJson: jsonText(candidate.payload, "knowledge payload"),
    }));
    if (new Set(candidates.map((candidate) => candidate.recordId)).size !== candidates.length) {
      throw new Error("duplicate knowledge recordId in staged window");
    }

    this.#transaction(() => {
      const window = this.#window(input.runId, input.windowId);
      if (window === undefined) {
        throw new Error(`run ${input.runId} has no window ${input.windowId}`);
      }
      const snapshot = one<{ run_id: string }>(
        this.#database.prepare(`
          SELECT run_id FROM knowledge_snapshots WHERE run_id=? AND snapshot_id=?
        `),
        input.runId,
        input.snapshotId,
      );
      if (snapshot === undefined) {
        const other = one<{ run_id: string }>(
          this.#database.prepare("SELECT run_id FROM knowledge_snapshots WHERE snapshot_id=? LIMIT 1"),
          input.snapshotId,
        );
        if (other !== undefined) {
          throw new Error(`snapshot ${input.snapshotId} belongs to another run`);
        }
        throw new Error(`snapshot ${input.snapshotId} does not belong to run ${input.runId}`);
      }
      if (window.status !== "running") {
        throw new Error(`window is not running: ${input.runId}/${input.windowId}`);
      }
      if (window.snapshotId !== null && window.snapshotId !== input.snapshotId) {
        throw new Error(
          `snapshot mismatch for ${input.windowId}: expected ${window.snapshotId}, got ${input.snapshotId}`,
        );
      }
      const expected = this.#membership(input.runId, input.windowId);
      this.#validateTranslations(input.translations, expected);

      const insertTranslation = this.#database.prepare(`
        INSERT INTO translations(
          run_id, window_id, source_version, block_id, version, source_hash,
          text, result_status, stage_state, active, snapshot_id
        ) VALUES(
          ?, ?, ?, ?,
          COALESCE((SELECT MAX(version)+1 FROM translations WHERE run_id=? AND block_id=?), 1),
          ?, ?, ?, 'staged', 0, ?
        )
      `);
      this.#faultInjector?.checkpoint("before_translation_insert");
      for (const translation of input.translations) {
        const block = expected.get(translation.blockId) as LogicalBlockRow;
        insertTranslation.run(
          input.runId,
          input.windowId,
          block.source_version,
          translation.blockId,
          input.runId,
          translation.blockId,
          translation.sourceHash,
          translation.text,
          input.status,
          input.snapshotId,
        );
      }

      const insertKnowledgeCandidate = this.#database.prepare(`
        INSERT INTO knowledge_candidates(
          run_id, candidate_id, window_id, snapshot_id,
          normalized_subject, kind, payload_json, stage_state
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'staged')
      `);
      for (const candidate of candidates) {
        insertKnowledgeCandidate.run(
          input.runId,
          candidate.recordId,
          input.windowId,
          input.snapshotId,
          candidate.normalizedSubject,
          candidate.kind,
          candidate.payloadJson,
        );
      }

      const result = this.#database.prepare(`
        UPDATE window_plans
        SET status='staged', result_status=?, snapshot_id=?, style_tail=?,
            budget_json=?, warnings_json=?, updated_at=datetime('now')
        WHERE run_id=? AND window_id=? AND status='running'
      `).run(
        input.status,
        input.snapshotId,
        input.styleTail,
        budgetJson,
        warningsJson,
        input.runId,
        input.windowId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`failed to stage running window ${input.runId}/${input.windowId}`);
      }
      this.#appendEvent(input.runId, "window_staged", {
        runId: input.runId,
        windowId: input.windowId,
        snapshotId: input.snapshotId,
        blocks: input.translations.map((translation) => translation.blockId),
      });
    });
    this.#faultInjector?.checkpoint("after_stage");
  }

  promoteStagedWindow(promotion: CommitPromotion): void;
  promoteStagedWindow(
    runId: string,
    windowId: string,
    nextSnapshot?: KnowledgeSnapshot,
  ): void;
  promoteStagedWindow(
    promotionOrRunId: CommitPromotion | string,
    legacyWindowId?: string,
    legacyNextSnapshot?: KnowledgeSnapshot,
  ): void {
    const promotion = typeof promotionOrRunId === "string"
      ? undefined
      : promotionOrRunId;
    const runId = promotion?.runId ?? promotionOrRunId as string;
    const windowId = promotion?.windowId ?? legacyWindowId as string;
    const nextSnapshot = promotion?.nextSnapshot ?? legacyNextSnapshot;
    requireNonempty(runId, "runId");
    requireNonempty(windowId, "windowId");
    this.#faultInjector?.checkpoint("before_promote");
    this.#transaction(() => {
      const row = one<WindowRow & { result_status: string | null }>(
        this.#database.prepare(`
          SELECT * FROM window_plans WHERE run_id=? AND window_id=?
        `),
        runId,
        windowId,
      );
      if (row === undefined) {
        throw new Error(`run ${runId} has no window ${windowId}`);
      }
      if (row.status !== "staged") {
        throw new Error(`window is not staged: ${runId}/${windowId}`);
      }
      if (row.snapshot_id === null || row.result_status === null) {
        throw new Error(`staged window is missing snapshot or result status: ${runId}/${windowId}`);
      }
      if (promotion !== undefined) {
        if (promotion.windowId !== windowId || promotion.runId !== runId) {
          throw new Error("promotion run/window provenance mismatch");
        }
        if (promotion.snapshotId !== row.snapshot_id) {
          throw new Error(
            `promotion snapshot mismatch for ${windowId}: expected ${row.snapshot_id}, got ${promotion.snapshotId}`,
          );
        }
      }
      const snapshot = one<{ present: number }>(
        this.#database.prepare(`
          SELECT 1 AS present FROM knowledge_snapshots WHERE run_id=? AND snapshot_id=?
        `),
        runId,
        row.snapshot_id,
      );
      if (snapshot === undefined) {
        throw new Error(`snapshot ${row.snapshot_id} does not belong to run ${runId}`);
      }
      const earlier = one<{ window_id: string }>(this.#database.prepare(`
        SELECT window_id FROM window_plans
        WHERE run_id=? AND ordinal<?
          AND status NOT IN ('completed', 'completed_with_warnings')
        ORDER BY ordinal LIMIT 1
      `), runId, row.ordinal);
      if (earlier !== undefined) {
        throw new Error(
          `earlier ordinal ${earlier.window_id} blocks promotion of ${windowId}`,
        );
      }

      const stagedCandidateRows = all<{
        candidate_id: string;
        window_id: string;
        snapshot_id: string;
        normalized_subject: string;
        kind: string;
        payload_json: string;
        stage_state: string;
      }>(this.#database.prepare(`
        SELECT candidate_id, window_id, snapshot_id, normalized_subject, kind,
               payload_json, stage_state
        FROM knowledge_candidates
        WHERE run_id=? AND window_id=? AND stage_state='staged'
        ORDER BY candidate_id
      `), runId, windowId);
      const stagedCandidates: KnowledgeCandidate[] = stagedCandidateRows.map((candidate) => {
        if (candidate.window_id !== windowId
          || candidate.snapshot_id !== row.snapshot_id
          || candidate.stage_state !== "staged") {
          throw new Error(`candidate provenance mismatch for ${candidate.candidate_id}`);
        }
        return {
          recordId: candidate.candidate_id,
          normalizedSubject: candidate.normalized_subject,
          kind: candidate.kind,
          payload: JSON.parse(candidate.payload_json) as unknown,
        };
      });
      const byRecordId = (candidates: readonly KnowledgeCandidate[]): KnowledgeCandidate[] =>
        [...candidates].sort((left, right) =>
          left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0);
      if (promotion === undefined && stagedCandidates.length > 0) {
        throw new Error("knowledge candidates require a complete domain promotion");
      }
      if (promotion !== undefined
        && canonicalJson(byRecordId(promotion.candidates))
          !== canonicalJson(byRecordId(stagedCandidates))) {
        throw new Error(`promotion candidates do not match staged provenance for ${windowId}`);
      }

      const existingKnowledge = this.knowledgeRevisions(runId);
      const expectedKnowledge = new KnowledgeStore(existingKnowledge);
      const expectedAppended = expectedKnowledge.reconcileCandidates(
        stagedCandidates,
        windowId,
      );
      const appendedRevisions = promotion?.appendedRevisions ?? [];
      if (canonicalJson(appendedRevisions) !== canonicalJson(expectedAppended)) {
        throw new Error(`promotion appended revisions do not reconcile staged candidates for ${windowId}`);
      }
      const nextKnowledge = new KnowledgeStore([
        ...existingKnowledge,
        ...appendedRevisions,
      ]);

      const currentSnapshot = one<{ snapshot_id: string }>(this.#database.prepare(`
        SELECT snapshot_id FROM knowledge_snapshots
        WHERE run_id=? ORDER BY rowid DESC LIMIT 1
      `), runId);
      if (currentSnapshot === undefined) {
        throw new Error(`translation run ${runId} has no current knowledge snapshot`);
      }
      const expectedNextSnapshot = createKnowledgeSnapshot(
        runId,
        nextKnowledge.projectableRevisions(),
        currentSnapshot.snapshot_id,
      );
      if (nextSnapshot !== undefined && nextSnapshot.runId !== runId) {
        throw new Error(`next snapshot ${nextSnapshot.id} belongs to another run`);
      }
      if (nextSnapshot !== undefined && nextSnapshot.id !== nextSnapshot.contentHash) {
        throw new Error(`next snapshot ${nextSnapshot.id} has an identity mismatch`);
      }
      if (nextSnapshot !== undefined
        && canonicalJson(nextSnapshot) !== canonicalJson(expectedNextSnapshot)) {
        throw new Error(`next knowledge snapshot does not match reconciled domain state for ${windowId}`);
      }
      if (promotion !== undefined && nextSnapshot === undefined) {
        throw new Error("complete domain promotion requires a next knowledge snapshot");
      }
      if (nextSnapshot !== undefined) {
        if (nextSnapshot.runId !== runId) {
          throw new Error(`next snapshot ${nextSnapshot.id} belongs to another run`);
        }
        if (nextSnapshot.id !== nextSnapshot.contentHash) {
          throw new Error(`next snapshot ${nextSnapshot.id} has an identity mismatch`);
        }
        if (nextSnapshot.parentSnapshotId === null) {
          throw new Error("promoted knowledge snapshot requires a parent");
        }
        if (nextSnapshot.parentSnapshotId !== currentSnapshot.snapshot_id) {
          throw new Error(
            `snapshot parent mismatch: expected ${currentSnapshot.snapshot_id}, got ${nextSnapshot.parentSnapshotId}`,
          );
        }
        const parent = one<{ present: number }>(this.#database.prepare(`
          SELECT 1 AS present FROM knowledge_snapshots
          WHERE run_id=? AND snapshot_id=?
        `), runId, nextSnapshot.parentSnapshotId);
        if (parent === undefined) {
          throw new Error(
            `snapshot parent ${nextSnapshot.parentSnapshotId} does not belong to run ${runId}`,
          );
        }
        const payload = jsonText(nextSnapshot, "next knowledge snapshot");
        const existingSnapshot = one<{
          content_hash: string;
          payload_json: string;
          producing_window_id: string | null;
        }>(this.#database.prepare(`
          SELECT content_hash, payload_json, producing_window_id
          FROM knowledge_snapshots WHERE run_id=? AND snapshot_id=?
        `), runId, nextSnapshot.id);
        if (existingSnapshot === undefined) {
          this.#database.prepare(`
            INSERT INTO knowledge_snapshots(
              run_id, snapshot_id, parent_snapshot_id, producing_window_id,
              content_hash, payload_json
            ) VALUES(?, ?, ?, ?, ?, ?)
          `).run(
            runId,
            nextSnapshot.id,
            nextSnapshot.parentSnapshotId,
            windowId,
            nextSnapshot.contentHash,
            payload,
          );
        } else if (existingSnapshot.content_hash !== nextSnapshot.contentHash
          || existingSnapshot.payload_json !== payload
          || existingSnapshot.producing_window_id !== windowId) {
          throw new Error(`snapshot ${nextSnapshot.id} already contains different data`);
        }
      }

      const expected = this.#membership(runId, windowId);
      const staged = all<{
        translation_id: number;
        block_id: string;
        source_version: string;
        source_hash: string;
        text: string;
        active: number;
        stage_state: string;
        snapshot_id: string;
      }>(this.#database.prepare(`
        SELECT translation_id, block_id, source_version, source_hash, text,
               active, stage_state, snapshot_id
        FROM translations
        WHERE run_id=? AND window_id=? AND stage_state='staged'
        ORDER BY translation_id
      `), runId, windowId);
      if (staged.length !== expected.size) {
        throw new Error(`staged window expected ${expected.size} translations but found ${staged.length}`);
      }
      const seen = new Set<string>();
      for (const translation of staged) {
        const block = expected.get(translation.block_id);
        if (block === undefined || seen.has(translation.block_id)) {
          throw new Error(`staged window contains unknown or duplicate block ${translation.block_id}`);
        }
        seen.add(translation.block_id);
        if (translation.source_hash !== block.source_hash) {
          throw new Error(`source hash mismatch for block ${translation.block_id}`);
        }
        if (translation.source_version !== block.source_version) {
          throw new Error(`source version mismatch for block ${translation.block_id}`);
        }
        if (translation.text.trim().length === 0) {
          throw new Error(`empty staged translation for block ${translation.block_id}`);
        }
        if (translation.active !== 0 || translation.stage_state !== "staged") {
          throw new Error(`translation is not safely staged for block ${translation.block_id}`);
        }
        if (translation.snapshot_id !== row.snapshot_id) {
          throw new Error(`translation snapshot mismatch for block ${translation.block_id}`);
        }
      }

      for (const blockId of expected.keys()) {
        this.#database.prepare(`
          UPDATE translations SET active=0
          WHERE run_id=? AND block_id=? AND active=1
        `).run(runId, blockId);
      }
      const promoted = this.#database.prepare(`
        UPDATE translations SET active=1, stage_state='promoted'
        WHERE run_id=? AND window_id=? AND stage_state='staged' AND active=0
      `).run(runId, windowId);
      if (Number(promoted.changes) !== expected.size) {
        throw new Error(`failed to promote complete window ${runId}/${windowId}`);
      }

      const insertKnowledgeRevision = this.#database.prepare(`
        INSERT INTO knowledge_records(
          run_id, record_id, revision_id, revision, normalized_subject, kind,
          payload_json, status, active, producing_window_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const revision of appendedRevisions) {
        const recordId = knowledgeRecordId(revision.normalizedSubject, revision.kind);
        this.#database.prepare(`
          UPDATE knowledge_records SET active=0
          WHERE run_id=? AND record_id=? AND active=1
        `).run(runId, recordId);
        insertKnowledgeRevision.run(
          runId,
          recordId,
          revision.revisionId,
          revision.revision,
          revision.normalizedSubject,
          revision.kind,
          canonicalJson(revision),
          revision.status,
          PROJECTABLE_KNOWLEDGE_STATUSES.has(revision.status) ? 1 : 0,
          windowId,
        );
      }
      const promotedCandidates = this.#database.prepare(`
        UPDATE knowledge_candidates SET stage_state='promoted'
        WHERE run_id=? AND window_id=? AND stage_state='staged'
      `).run(runId, windowId);
      if (Number(promotedCandidates.changes) !== stagedCandidates.length) {
        throw new Error(`failed to promote staged knowledge candidates for ${runId}/${windowId}`);
      }
      const completed = this.#database.prepare(`
        UPDATE window_plans SET status=result_status, updated_at=datetime('now')
        WHERE run_id=? AND window_id=? AND status='staged'
      `).run(runId, windowId);
      if (Number(completed.changes) !== 1) {
        throw new Error(`failed to complete staged window ${runId}/${windowId}`);
      }
      const remaining = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM window_plans
        WHERE run_id=? AND status NOT IN ('completed', 'completed_with_warnings')
      `), runId)?.count ?? 0;
      if (remaining === 0) {
        this.#database.prepare(`
          UPDATE translation_runs SET status='completed' WHERE run_id=?
        `).run(runId);
      }
      this.#appendEvent(runId, "window_promoted", {
        runId,
        windowId,
        snapshotId: row.snapshot_id,
        nextSnapshotId: nextSnapshot?.id ?? null,
      });
    });
  }

  failWindow(runId: string, windowId: string, failure: WindowFailureInput): void {
    requireNonempty(runId, "runId");
    requireNonempty(windowId, "windowId");
    if (typeof failure.error !== "string" || failure.error.trim().length === 0) {
      throw new TypeError("failure error must be nonempty");
    }
    const budgetJson = validateBudget(failure.budget);
    const warningsJson = validateWarnings(failure.warnings);
    const status = failure.retry ? "pending" : "human_required";
    this.#transaction(() => {
      this.#database.prepare(`
        DELETE FROM knowledge_candidates
        WHERE run_id=? AND window_id=? AND stage_state='staged'
      `).run(runId, windowId);
      const result = this.#database.prepare(`
        UPDATE window_plans
        SET status=?, snapshot_id=CASE WHEN ?='pending' THEN NULL ELSE snapshot_id END,
            budget_json=?, warnings_json=?, last_error=?,
            updated_at=datetime('now')
        WHERE run_id=? AND window_id=? AND status='running'
      `).run(
        status,
        status,
        budgetJson,
        warningsJson,
        failure.error.slice(0, 4_000),
        runId,
        windowId,
      );
      if (Number(result.changes) !== 1) {
        const exists = one<{ present: number }>(
          this.#database.prepare(`
            SELECT 1 AS present FROM window_plans WHERE run_id=? AND window_id=?
          `),
          runId,
          windowId,
        );
        if (exists === undefined) {
          throw new Error(`run ${runId} has no window ${windowId}`);
        }
        throw new Error(`window is not running: ${runId}/${windowId}`);
      }
      this.#appendEvent(runId, "window_failed", {
        runId,
        windowId,
        retry: failure.retry,
        status,
        error: failure.error.slice(0, 1_000),
      });
    });
  }

  recoverInterruptedWindows(runId: string): string[] {
    this.#run(runId);
    return this.#transaction(() => {
      const interrupted = all<{ window_id: string }>(this.#database.prepare(`
        SELECT window_id FROM window_plans
        WHERE run_id=? AND status IN ('running', 'staged') ORDER BY ordinal
      `), runId).map((row) => row.window_id);
      if (interrupted.length === 0) {
        return [];
      }
      this.#database.prepare(`
        DELETE FROM translations
        WHERE run_id=? AND active=0 AND window_id IN (
          SELECT window_id FROM window_plans
          WHERE run_id=? AND status IN ('running', 'staged')
        )
      `).run(runId, runId);
      this.#database.prepare(`
        DELETE FROM knowledge_candidates
        WHERE run_id=? AND stage_state='staged' AND window_id IN (
          SELECT window_id FROM window_plans
          WHERE run_id=? AND status IN ('running', 'staged')
        )
      `).run(runId, runId);
      this.#database.prepare(`
        UPDATE window_plans
        SET status='pending', result_status=NULL, snapshot_id=NULL,
            style_tail='', budget_json='{}', warnings_json='[]',
            last_error='recovered interrupted window', updated_at=datetime('now')
        WHERE run_id=? AND status IN ('running', 'staged')
      `).run(runId);
      this.#appendEvent(runId, "interrupted_windows_recovered", {
        runId, windowIds: interrupted,
      });
      return interrupted;
    });
  }

  recoveryProjectionHash(runId: string): string {
    const state = this.auditState(runId);
    return hashText(jsonText({
      runId: state.runId,
      sourceVersion: state.sourceVersion,
      canonicalSha256: state.canonicalSha256,
      runStatus: state.runStatus,
      windows: state.windows.map((window) => ({
        windowId: window.windowId,
        ordinal: window.ordinal,
        status: window.status,
        snapshotId: window.snapshotId,
      })),
      memberships: state.memberships,
      translations: state.translations,
      snapshots: state.snapshots,
    }, "recovery projection"));
  }

  promoteRecoveryMutation(input: RecoveryMutationPromotion): void {
    requireNonempty(input.runId, "runId");
    requireNonempty(input.recoveryId, "recoveryId");
    requireNonempty(input.expectedBeforeHash, "expectedBeforeHash");
    requireNonempty(input.expectedAfterHash, "expectedAfterHash");
    const windowIds = [...new Set(input.affectedWindowIds.map((windowId) =>
      requireNonempty(windowId, "windowId")))];
    if (windowIds.length !== input.affectedWindowIds.length) {
      throw new Error("duplicate recovery window ID");
    }
    this.#transaction(() => {
      const beforeHash = this.recoveryProjectionHash(input.runId);
      if (beforeHash !== input.expectedBeforeHash) {
        throw new Error("recovery promotion precondition changed after shadow audit");
      }
      if (input.kind === "reset_interrupted_windows") {
        const interrupted = all<{ window_id: string }>(this.#database.prepare(`
          SELECT window_id FROM window_plans
          WHERE run_id=? AND status IN ('running', 'staged') ORDER BY ordinal
        `), input.runId).map((row) => row.window_id);
        if (jsonText(interrupted, "interrupted windows")
          !== jsonText(windowIds, "recovery windows")) {
          throw new Error("interrupted window set changed after shadow audit");
        }
        for (const windowId of windowIds) {
          this.#database.prepare(`
            DELETE FROM translations
            WHERE run_id=? AND window_id=? AND active=0
          `).run(input.runId, windowId);
          this.#database.prepare(`
            DELETE FROM knowledge_candidates
            WHERE run_id=? AND window_id=? AND stage_state='staged'
          `).run(input.runId, windowId);
          this.#database.prepare(`
            UPDATE window_plans
            SET status='pending', result_status=NULL, snapshot_id=NULL,
                style_tail='', budget_json='{}', warnings_json='[]',
                last_error='recovered interrupted window', updated_at=datetime('now')
            WHERE run_id=? AND window_id=? AND status IN ('running', 'staged')
          `).run(input.runId, windowId);
        }
      } else if (input.kind === "reset_missing_windows") {
        for (const windowId of windowIds) {
          this.#database.prepare(`
            UPDATE window_plans
            SET status='pending', snapshot_id=NULL, result_status=NULL,
                updated_at=datetime('now')
            WHERE run_id=? AND window_id=? AND status IN ('pending', 'human_required')
          `).run(input.runId, windowId);
        }
      } else {
        this.#database.prepare(`
          UPDATE translation_runs SET status='quarantined' WHERE run_id=?
        `).run(input.runId);
      }
      const afterHash = this.recoveryProjectionHash(input.runId);
      if (afterHash !== input.expectedAfterHash) {
        throw new Error("recovery promotion differs from audited shadow state");
      }
      const recovery = this.#database.prepare(`
        UPDATE recovery_runs
        SET state='resumed', after_hash=?, result_json=?
        WHERE recovery_id=? AND run_id=? AND state='auditing'
      `).run(
        afterHash,
        jsonText(input.result, "recovery promotion result"),
        input.recoveryId,
        input.runId,
      );
      if (Number(recovery.changes) !== 1) {
        throw new Error("recovery state changed before atomic promotion");
      }
      this.#appendEvent(input.runId, "recovery_promoted", {
        recoveryId: input.recoveryId,
        kind: input.kind,
        affectedWindowIds: windowIds,
        beforeHash,
        afterHash,
      });
    });
  }

  allWindows(runId: string): PersistedLosslessWindow[] {
    this.#run(runId);
    return all<WindowRow>(this.#database.prepare(`
      SELECT * FROM window_plans WHERE run_id=? ORDER BY ordinal
    `), runId).map((row) => {
      const window = windowFromRow(row, this.#membershipIds(runId, row.window_id));
      window.globalIndexes = this.#globalIndexes(runId, row.window_id);
      return window;
    });
  }

  pendingWindows(runId: string): PersistedLosslessWindow[] {
    return this.allWindows(runId).filter((window) => window.status === "pending");
  }

  latestKnowledgeSnapshot(runId: string): KnowledgeSnapshot {
    this.#run(runId);
    const row = one<{ snapshot_id: string; payload_json: string }>(
      this.#database.prepare(`
        SELECT snapshot_id, payload_json FROM knowledge_snapshots
        WHERE run_id=? ORDER BY rowid DESC LIMIT 1
      `),
      runId,
    );
    if (row === undefined) {
      throw new Error(`translation run ${runId} has no knowledge snapshot`);
    }
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`knowledge snapshot ${row.snapshot_id} has no typed payload`);
    }
    const snapshot = parsed as KnowledgeSnapshot;
    if (snapshot.runId !== runId
      || snapshot.id !== row.snapshot_id
      || snapshot.contentHash !== snapshot.id
      || !Array.isArray(snapshot.revisions)) {
      throw new Error(`knowledge snapshot ${row.snapshot_id} identity mismatch`);
    }
    const rebuilt = createKnowledgeSnapshot(
      runId,
      snapshot.revisions,
      snapshot.parentSnapshotId,
    );
    if (rebuilt.id !== snapshot.id) {
      throw new Error(`knowledge snapshot ${row.snapshot_id} content hash mismatch`);
    }
    return rebuilt;
  }

  statusSummary(runId: string): LosslessBookStatusSummary {
    const windows = this.allWindows(runId);
    const count = (status: PersistedLosslessWindow["status"]): number =>
      windows.filter((window) => window.status === status).length;
    return {
      totalWindows: windows.length,
      pendingWindows: count("pending"),
      runningWindows: count("running"),
      stagedWindows: count("staged"),
      completedWindows: count("completed") + count("completed_with_warnings"),
      warningWindows: count("completed_with_warnings"),
      humanRequiredWindows: count("human_required"),
      failedWindows: count("failed"),
      modelCalls: windows.reduce(
        (total, window) => total + (window.budget.modelCalls ?? 0),
        0,
      ),
    };
  }

  activeTranslations(runId: string): ActiveLosslessTranslation[] {
    this.#run(runId);
    return all<{
      run_id: string;
      window_id: string;
      block_id: string;
      source_version: string;
      source_hash: string;
      text: string;
      result_status: "completed" | "completed_with_warnings";
      version: number;
    }>(this.#database.prepare(`
      SELECT t.run_id, t.window_id, t.block_id, t.source_version, t.source_hash,
             t.text, t.result_status, t.version
      FROM translations AS t
      JOIN logical_blocks AS b
        ON b.source_version=t.source_version AND b.block_id=t.block_id
      WHERE t.run_id=? AND t.active=1
      ORDER BY b.global_index
    `), runId).map((row) => ({
      runId: row.run_id,
      windowId: row.window_id,
      blockId: row.block_id,
      sourceVersion: row.source_version,
      sourceHash: row.source_hash,
      text: row.text,
      status: row.result_status,
      version: row.version,
    }));
  }

  knowledgeRevisions(runId: string): KnowledgeRevision[] {
    this.#run(runId);
    const rows = all<{
      run_id: string;
      record_id: string;
      revision_id: string;
      revision: number;
      normalized_subject: string;
      kind: string;
      payload_json: string;
      status: string;
      active: number;
    }>(this.#database.prepare(`
      SELECT run_id, record_id, revision_id, revision, normalized_subject, kind,
             payload_json, status, active
      FROM knowledge_records
      WHERE run_id=?
      ORDER BY normalized_subject, kind, revision
    `), runId);
    const revisions = rows.map((row): KnowledgeRevision => {
      const parsed = JSON.parse(row.payload_json) as KnowledgeRevision;
      if (row.run_id !== runId
        || row.record_id !== knowledgeRecordId(row.normalized_subject, row.kind)
        || parsed.revisionId !== row.revision_id
        || parsed.revision !== row.revision
        || parsed.normalizedSubject !== row.normalized_subject
        || parsed.kind !== row.kind
        || parsed.status !== row.status) {
        throw new Error(`corrupt knowledge revision row ${row.revision_id}`);
      }
      return parsed;
    });
    const hydrated = new KnowledgeStore(revisions);
    const canonical = [...hydrated.listRevisions()];
    const rowByRevisionId = new Map(rows.map((row) => [row.revision_id, row]));
    for (const revision of canonical) {
      const row = rowByRevisionId.get(revision.revisionId) as (typeof rows)[number];
      const latest = hydrated.latestRevision(revision.normalizedSubject, revision.kind);
      const expectedActive = latest?.revisionId === revision.revisionId
        && PROJECTABLE_KNOWLEDGE_STATUSES.has(revision.status);
      if (Boolean(row.active) !== expectedActive) {
        throw new Error(`corrupt active knowledge projection for ${revision.revisionId}`);
      }
    }
    return canonical;
  }

  knowledgeHistory(runId: string): KnowledgeHistoryRecord[] {
    return this.knowledgeRevisions(runId);
  }

  candidateHistory(runId: string): CandidateHistoryRecord[] {
    this.#run(runId);
    return all<{
      run_id: string;
      candidate_id: string;
      window_id: string;
      snapshot_id: string;
      normalized_subject: string;
      kind: string;
      payload_json: string;
      stage_state: "staged" | "promoted";
    }>(this.#database.prepare(`
      SELECT run_id, candidate_id, window_id, snapshot_id, normalized_subject,
             kind, payload_json, stage_state
      FROM knowledge_candidates WHERE run_id=? ORDER BY candidate_id
    `), runId).map((row) => ({
      runId: row.run_id,
      candidateId: row.candidate_id,
      windowId: row.window_id,
      snapshotId: row.snapshot_id,
      normalizedSubject: row.normalized_subject,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      stageState: row.stage_state,
    }));
  }

  styleObservations(runId: string): LocalStyleObservation[] {
    this.#run(runId);
    const rows = all<{ window_id: string; ordinal: number; style_tail: string }>(
      this.#database.prepare(`
        SELECT window_id, ordinal, style_tail
        FROM window_plans
        WHERE run_id=? AND status IN ('completed', 'completed_with_warnings')
        ORDER BY ordinal
      `),
      runId,
    );
    return rows.flatMap((row) => {
      let raw: unknown;
      try {
        raw = JSON.parse(row.style_tail) as unknown;
      } catch {
        return [];
      }
      const observation = parseStyleObservation(raw);
      if (observation === undefined) {
        return [];
      }
      if (observation.windowId !== row.window_id || observation.ordinal !== row.ordinal) {
        throw new Error(`style observation provenance mismatch for ${row.window_id}`);
      }
      return [observation];
    });
  }

  waveAnchorDecision(runId: string, inputHash: string): unknown | undefined {
    this.#run(runId);
    requireNonempty(inputHash, "wave anchor inputHash");
    const matches = all<{ payload_json: string }>(this.#database.prepare(`
      SELECT payload_json FROM events
      WHERE run_id=? AND kind='wave_anchor_cached'
      ORDER BY sequence
    `), runId).map((row) => JSON.parse(row.payload_json) as CachedWaveAnchorDecision)
      .filter((item) => item.inputHash === inputHash);
    if (matches.length === 0) {
      return undefined;
    }
    const canonical = canonicalJson(matches[0]?.decision);
    if (matches.some((item) => canonicalJson(item.decision) !== canonical)) {
      throw new Error(`conflicting cached wave anchor decision for ${inputHash}`);
    }
    return structuredClone(matches[0]?.decision);
  }

  cacheWaveAnchorDecision(runId: string, inputHash: string, decision: unknown): void {
    this.#run(runId);
    requireNonempty(inputHash, "wave anchor inputHash");
    const existing = this.waveAnchorDecision(runId, inputHash);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(decision)) {
        throw new Error(`cached wave anchor decision mismatch for ${inputHash}`);
      }
      return;
    }
    this.#transaction(() => {
      this.#appendEvent(runId, "wave_anchor_cached", { inputHash, decision });
    });
  }

  auditRows(runId: string): AuditProjection {
    const run = this.#run(runId);
    const windows = all<WindowRow>(
      this.#database.prepare("SELECT * FROM window_plans WHERE run_id=? ORDER BY ordinal"),
      runId,
    ).map((row) => windowFromRow(row, this.#membershipIds(runId, row.window_id)));
    for (const window of windows) {
      window.globalIndexes = all<{ global_index: number }>(this.#database.prepare(`
        SELECT b.global_index
        FROM window_membership AS m
        JOIN logical_blocks AS b
          ON b.source_version=m.source_version AND b.block_id=m.block_id
        WHERE m.run_id=? AND m.window_id=? ORDER BY m.position
      `), runId, window.windowId).map((row) => row.global_index);
    }
    const snapshotIds = all<{ snapshot_id: string }>(this.#database.prepare(`
      SELECT snapshot_id FROM knowledge_snapshots WHERE run_id=? ORDER BY created_at, snapshot_id
    `), runId).map((row) => row.snapshot_id);
    return {
      runId: run.run_id,
      sourceVersion: run.source_version,
      protocolVersion: run.protocol_version,
      modelId: run.model_id,
      status: run.status,
      windows,
      translations: this.activeTranslations(runId),
      knowledge: this.knowledgeHistory(runId),
      snapshotIds,
    };
  }

  auditState(runId: string): LosslessAuditState {
    const run = this.#run(runId);
    const source = this.#source(run.source_version);
    const blocks = all<{
      block_id: string;
      source_version: string;
      canonical_start: number;
      canonical_end: number;
      source_text: string;
      source_hash: string;
      global_index: number;
      token_count: number;
    }>(this.#database.prepare(`
      SELECT block_id, source_version, canonical_start, canonical_end, source_text,
             source_hash, global_index, token_count
      FROM logical_blocks WHERE source_version=? ORDER BY global_index, block_id
    `), run.source_version).map((row) => ({
      blockId: row.block_id,
      sourceVersion: row.source_version,
      canonicalStart: row.canonical_start,
      canonicalEnd: row.canonical_end,
      sourceText: row.source_text,
      sourceHash: row.source_hash,
      globalIndex: row.global_index,
      tokenCount: row.token_count,
    }));
    const memberships = all<{
      run_id: string;
      window_id: string;
      source_version: string;
      block_id: string;
      position: number;
    }>(this.#database.prepare(`
      SELECT run_id, window_id, source_version, block_id, position
      FROM window_membership WHERE run_id=? ORDER BY window_id, position
    `), runId).map((row) => ({
      runId: row.run_id,
      windowId: row.window_id,
      sourceVersion: row.source_version,
      blockId: row.block_id,
      position: row.position,
    }));
    const translations = all<{
      run_id: string;
      window_id: string;
      source_version: string;
      block_id: string;
      source_hash: string;
      text: string;
      result_status: string;
      version: number;
      stage_state: string;
      active: number;
      snapshot_id: string;
    }>(this.#database.prepare(`
      SELECT run_id, window_id, source_version, block_id, source_hash, text,
             result_status, version, stage_state, active, snapshot_id
      FROM translations WHERE run_id=? ORDER BY translation_id
    `), runId).map((row) => ({
      runId: row.run_id,
      windowId: row.window_id,
      sourceVersion: row.source_version,
      blockId: row.block_id,
      sourceHash: row.source_hash,
      text: row.text,
      resultStatus: row.result_status,
      version: row.version,
      stageState: row.stage_state,
      active: row.active === 1,
      snapshotId: row.snapshot_id,
    }));
    const knowledgeRevisions = all<{
      run_id: string;
      record_id: string;
      revision_id: string;
      revision: number;
      normalized_subject: string;
      kind: string;
      status: string;
      active: number;
      payload_json: string;
      producing_window_id: string;
    }>(this.#database.prepare(`
      SELECT run_id, record_id, revision_id, revision, normalized_subject, kind,
             status, active, payload_json, producing_window_id
      FROM knowledge_records WHERE run_id=?
      ORDER BY normalized_subject, kind, revision
    `), runId).map((row) => ({
      runId: row.run_id,
      recordId: row.record_id,
      revisionId: row.revision_id,
      revision: row.revision,
      normalizedSubject: row.normalized_subject,
      kind: row.kind,
      status: row.status,
      active: row.active === 1,
      payload: JSON.parse(row.payload_json) as unknown,
      producingWindowId: row.producing_window_id,
    }));
    const snapshots = all<{
      sequence: number;
      snapshot_id: string;
      parent_snapshot_id: string | null;
      producing_window_id: string | null;
      content_hash: string;
      payload_json: string;
    }>(this.#database.prepare(`
      SELECT rowid AS sequence, snapshot_id, parent_snapshot_id,
             producing_window_id, content_hash, payload_json
      FROM knowledge_snapshots WHERE run_id=? ORDER BY rowid
    `), runId).map((row) => ({
      sequence: row.sequence,
      snapshotId: row.snapshot_id,
      parentSnapshotId: row.parent_snapshot_id,
      producingWindowId: row.producing_window_id,
      contentHash: row.content_hash,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
    return {
      runId: run.run_id,
      sourceVersion: run.source_version,
      protocolVersion: run.protocol_version,
      modelId: run.model_id,
      runStatus: run.status,
      runMetadata: JSON.parse(run.metadata_json) as unknown,
      canonicalSha256: source.canonical_sha256,
      canonicalChars: source.canonical_chars,
      blocks,
      windows: this.allWindows(runId),
      memberships,
      translations,
      knowledgeRevisions,
      snapshots,
    };
  }

  close(): void {
    this.#database.close();
  }

  #initializeSchema(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(LOSSLESS_BOOK_SCHEMA_V2);
      const insertMarker = this.#database.prepare(`
        INSERT INTO lossless_schema_meta(key, value) VALUES(?, ?)
      `);
      insertMarker.run("marker", LOSSLESS_BOOK_SCHEMA_MARKER);
      insertMarker.run("fingerprint", LOSSLESS_BOOK_SCHEMA_FINGERPRINT);
      this.#database.exec(`PRAGMA user_version=${LOSSLESS_BOOK_SCHEMA_VERSION}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #verifyExistingSchema(userVersion: number, tables: readonly string[]): void {
    const legacyNames = new Set(["book_meta", "book_blocks", "windows"]);
    if (tables.some((table) => legacyNames.has(table))) {
      throw new Error(
        "legacy BookStore schema requires a new database for schema v2; in-place migration is forbidden",
      );
    }
    if (userVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error(
        `unsupported schema user_version ${userVersion}; expected ${LOSSLESS_BOOK_SCHEMA_VERSION}`,
      );
    }
    const expected = [...LOSSLESS_BOOK_SCHEMA_TABLES];
    if (tables.length !== expected.length
      || tables.some((table, index) => table !== expected[index])) {
      throw new Error("schema v2 table set is incomplete or contains unknown tables");
    }
    const markers = new Map(all<{ key: string; value: string }>(
      this.#database.prepare(`
        SELECT key, value FROM lossless_schema_meta
        WHERE key IN ('marker', 'fingerprint')
      `),
    ).map((row) => [row.key, row.value]));
    if (markers.get("marker") !== LOSSLESS_BOOK_SCHEMA_MARKER
      || markers.get("fingerprint") !== LOSSLESS_BOOK_SCHEMA_FINGERPRINT) {
      throw new Error("schema v2 marker or fingerprint mismatch");
    }
  }

  #validateSource(input: CertifiedSourceInput): CertifiedSourceInput {
    const sourceVersion = requireNonempty(input.sourceVersion, "sourceVersion");
    const rawSha256 = requireNonempty(input.rawSha256, "rawSha256");
    const canonicalSha256 = requireNonempty(input.canonicalSha256, "canonicalSha256");
    const canonicalChars = requireSafeInteger(input.canonicalChars, "canonicalChars");
    if (input.coordinateUnit !== "unicode_scalar") {
      throw new TypeError("coordinateUnit must be unicode_scalar");
    }
    const sourceFormat = requireNonempty(input.sourceFormat, "sourceFormat");
    const encoding = requireNonempty(input.encoding, "encoding");
    const extractor = requireNonempty(input.extractor, "extractor");
    const sourceLanguage = input.sourceLanguage ?? "en";
    if (!supportedSourceLanguageIds().includes(sourceLanguage)) {
      throw new TypeError(`unsupported sourceLanguage: ${sourceLanguage}`);
    }
    const sourceLanguageProfileVersion = requireNonempty(
      input.sourceLanguageProfileVersion ?? "legacy-source-language-profile",
      "sourceLanguageProfileVersion",
    );
    const sourceLanguageCompatibilityMode = input.sourceLanguageCompatibilityMode ?? true;
    if (typeof sourceLanguageCompatibilityMode !== "boolean") {
      throw new TypeError("sourceLanguageCompatibilityMode must be boolean");
    }
    if (!Array.isArray(input.ranges)) {
      throw new TypeError("source ranges must be an array");
    }
    const ids = new Set<string>();
    let cursor = 0;
    const ranges = input.ranges.map((range, index) => {
      const rangeId = requireNonempty(range.rangeId, `range[${index}].rangeId`);
      if (ids.has(rangeId)) {
        throw new Error(`duplicate source range id ${rangeId}`);
      }
      ids.add(rangeId);
      const canonicalStart = requireSafeInteger(range.canonicalStart, `range[${index}].canonicalStart`);
      const canonicalEnd = requireSafeInteger(range.canonicalEnd, `range[${index}].canonicalEnd`);
      if (canonicalStart !== cursor || canonicalEnd < canonicalStart || canonicalEnd > canonicalChars) {
        throw new Error(`source ranges must cover canonical coordinates continuously at ${cursor}`);
      }
      cursor = canonicalEnd;
      const hasRawStart = range.rawStart !== undefined;
      const hasRawEnd = range.rawEnd !== undefined;
      if (hasRawStart !== hasRawEnd) {
        throw new Error(`source range ${rangeId} must provide both rawStart and rawEnd`);
      }
      const rawStart = hasRawStart
        ? requireSafeInteger(range.rawStart as number, `range[${index}].rawStart`)
        : undefined;
      const rawEnd = hasRawEnd
        ? requireSafeInteger(range.rawEnd as number, `range[${index}].rawEnd`)
        : undefined;
      if (rawStart !== undefined && rawEnd !== undefined && rawEnd < rawStart) {
        throw new Error(`source range ${rangeId} has reversed raw coordinates`);
      }
      return {
        rangeId,
        canonicalStart,
        canonicalEnd,
        originKind: requireNonempty(range.originKind, `range[${index}].originKind`),
        originRef: requireNonempty(range.originRef, `range[${index}].originRef`),
        transformation: requireNonempty(range.transformation, `range[${index}].transformation`),
        ...(rawStart === undefined ? {} : { rawStart, rawEnd: rawEnd as number }),
      };
    });
    if (cursor !== canonicalChars) {
      throw new Error(`source ranges cover ${cursor} canonical characters, expected ${canonicalChars}`);
    }
    return {
      sourceVersion,
      rawSha256,
      canonicalSha256,
      canonicalChars,
      coordinateUnit: input.coordinateUnit,
      sourceFormat,
      encoding,
      extractor,
      sourceLanguage,
      sourceLanguageProfileVersion,
      sourceLanguageCompatibilityMode,
      ranges,
    };
  }

  #validateDerivedPlan(source: SourceVersionRow, plan: DerivedPlan): DerivedPlan {
    if (!Array.isArray(plan.annotations) || !Array.isArray(plan.blocks)) {
      throw new TypeError("derived plan annotations and blocks must be arrays");
    }
    const annotationIds = new Set<string>();
    const annotations = plan.annotations.map((annotation, index) => {
      const id = requireNonempty(annotation.id, `annotation[${index}].id`);
      if (annotationIds.has(id)) {
        throw new Error(`duplicate annotation id ${id}`);
      }
      annotationIds.add(id);
      const start = requireSafeInteger(annotation.start, `annotation[${index}].start`);
      const end = requireSafeInteger(annotation.end, `annotation[${index}].end`);
      if (end < start || end > source.canonical_chars) {
        throw new Error(`annotation ${id} is outside canonical source`);
      }
      if (!Number.isFinite(annotation.boundaryWeight) || annotation.boundaryWeight < 0) {
        throw new TypeError(`annotation ${id} boundaryWeight must be finite and non-negative`);
      }
      return {
        id,
        kind: annotation.kind,
        start,
        end,
        title: annotation.title,
        boundaryWeight: annotation.boundaryWeight,
      };
    });
    if (plan.blocks.length === 0 && source.canonical_chars > 0) {
      throw new Error("derived plan has no logical blocks");
    }
    const blockIds = new Set<string>();
    let cursor = 0;
    const reconstructedCanonical = createHash("sha256");
    const blocks = plan.blocks.map((block, index) => {
      const id = requireNonempty(block.id, `block[${index}].id`);
      if (blockIds.has(id)) {
        throw new Error(`duplicate block id ${id}`);
      }
      blockIds.add(id);
      if (block.sourceVersion !== source.source_version) {
        throw new Error(`block ${id} source version does not match ${source.source_version}`);
      }
      const start = requireSafeInteger(block.canonicalStart, `block[${index}].canonicalStart`);
      const end = requireSafeInteger(block.canonicalEnd, `block[${index}].canonicalEnd`);
      if (start !== cursor || end <= start || end > source.canonical_chars) {
        throw new Error(`logical blocks must cover canonical source continuously at ${cursor}`);
      }
      cursor = end;
      requireNonempty(block.sourceText, `block[${index}].sourceText`);
      if (scalarLength(block.sourceText) !== end - start) {
        throw new Error(`block ${id} source text length does not match scalar range`);
      }
      requireNonempty(block.sourceHash, `block[${index}].sourceHash`);
      const expectedSourceHash = hashText(block.sourceText);
      if (block.sourceHash !== expectedSourceHash) {
        throw new Error(`block ${id} source hash does not match source text`);
      }
      const expectedBlockId = blockId(source.source_version, start, end, block.sourceText);
      if (id !== expectedBlockId) {
        throw new Error(`block id does not match certified source identity: ${id}`);
      }
      reconstructedCanonical.update(block.sourceText, "utf8");
      const globalIndex = requireSafeInteger(block.globalIndex, `block[${index}].globalIndex`);
      if (globalIndex !== index) {
        throw new Error("logical block global indexes must be unique and continuous");
      }
      requireSafeInteger(block.tokenCount, `block[${index}].tokenCount`);
      if (block.structureId !== null && !annotationIds.has(block.structureId)) {
        throw new Error(`block ${id} references unknown structure ${block.structureId}`);
      }
      return {
        id,
        sourceVersion: block.sourceVersion,
        canonicalStart: start,
        canonicalEnd: end,
        sourceText: block.sourceText,
        sourceHash: block.sourceHash,
        globalIndex,
        tokenCount: block.tokenCount,
        structureId: block.structureId,
        structureTitle: block.structureTitle,
      };
    });
    if (cursor !== source.canonical_chars) {
      throw new Error(`logical blocks cover ${cursor} canonical characters, expected ${source.canonical_chars}`);
    }
    if (reconstructedCanonical.digest("hex") !== source.canonical_sha256) {
      throw new Error("reconstructed canonical hash does not match certified source");
    }
    return { annotations, blocks };
  }

  #validateWindows(run: RunRow, windows: readonly BookWindowPlan[]): BookWindowPlan[] {
    if (!Array.isArray(windows) || windows.length === 0) {
      throw new Error("window plan must not be empty");
    }
    const blocks = all<LogicalBlockRow>(this.#database.prepare(`
      SELECT block_id, source_version, source_hash, global_index,
             canonical_start, canonical_end, token_count
      FROM logical_blocks WHERE source_version=? ORDER BY global_index
    `), run.source_version);
    const blockById = new Map(blocks.map((block) => [block.block_id, block]));
    const sorted = [...windows].sort((left, right) => left.ordinal - right.ordinal);
    const windowIds = new Set<string>();
    const memberIds = new Set<string>();
    let nextGlobalIndex = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      const window = sorted[index] as BookWindowPlan;
      const windowId = requireNonempty(window.windowId, `window[${index}].windowId`);
      if (windowIds.has(windowId)) {
        throw new Error(`duplicate window id ${windowId}`);
      }
      windowIds.add(windowId);
      if (requireSafeInteger(window.ordinal, `window ${windowId} ordinal`) !== index) {
        throw new Error("window ordinals must be unique and continuous from zero");
      }
      requireNonempty(window.chapterId, `window ${windowId} chapterId`);
      if (!Array.isArray(window.blockIds) || window.blockIds.length === 0) {
        throw new Error(`window ${windowId} must contain blocks`);
      }
      if (!Array.isArray(window.globalIndexes)
        || window.globalIndexes.length !== window.blockIds.length) {
        throw new Error(`window ${windowId} global indexes must match block membership`);
      }
      let calculatedTokens = 0;
      let calculatedChars = 0;
      for (let position = 0; position < window.blockIds.length; position += 1) {
        const blockId = requireNonempty(window.blockIds[position] as string, `window ${windowId} blockId`);
        if (memberIds.has(blockId)) {
          throw new Error(`duplicate block membership ${blockId}`);
        }
        memberIds.add(blockId);
        const block = blockById.get(blockId);
        if (block === undefined) {
          throw new Error(`unknown block ${blockId} in window ${windowId}`);
        }
        if (window.globalIndexes[position] !== block.global_index) {
          throw new Error(`window ${windowId} global index mismatch for block ${blockId}`);
        }
        if (block.global_index !== nextGlobalIndex) {
          throw new Error(`window membership is not in source order at block ${blockId}`);
        }
        nextGlobalIndex += 1;
        calculatedTokens += block.token_count;
        calculatedChars += block.canonical_end - block.canonical_start;
      }
      requireSafeInteger(window.sourceTokens, `window ${windowId} sourceTokens`);
      requireSafeInteger(window.sourceChars, `window ${windowId} sourceChars`);
      if (window.sourceTokens !== calculatedTokens || window.sourceChars !== calculatedChars) {
        throw new Error(`window ${windowId} token or character totals do not match membership`);
      }
      if (typeof window.oversized !== "boolean") {
        throw new TypeError(`window ${windowId} oversized must be boolean`);
      }
    }
    if (memberIds.size !== blocks.length) {
      throw new Error(`window plan does not provide complete block membership: ${memberIds.size}/${blocks.length}`);
    }
    return sorted;
  }

  #validateTranslations(
    translations: readonly StagedTranslationInput[],
    expected: ReadonlyMap<string, LogicalBlockRow>,
  ): void {
    if (!Array.isArray(translations)) {
      throw new TypeError("translations must be an array");
    }
    const seen = new Set<string>();
    for (const translation of translations) {
      const blockId = requireNonempty(translation.blockId, "translation blockId");
      if (seen.has(blockId)) {
        throw new Error(`duplicate translation for block ${blockId}`);
      }
      seen.add(blockId);
      const block = expected.get(blockId);
      if (block === undefined) {
        throw new Error(`unknown translated block ${blockId}`);
      }
      if (translation.sourceHash !== block.source_hash) {
        throw new Error(`source hash mismatch for block ${blockId}`);
      }
      if (typeof translation.text !== "string" || translation.text.trim().length === 0) {
        throw new Error(`empty translation for block ${blockId}`);
      }
    }
    if (seen.size !== expected.size) {
      throw new Error(`window requires ${expected.size} translations but received ${seen.size}`);
    }
  }

  #source(sourceVersion: string): SourceVersionRow {
    requireNonempty(sourceVersion, "sourceVersion");
    const source = one<SourceVersionRow>(
      this.#database.prepare("SELECT * FROM source_versions WHERE source_version=?"),
      sourceVersion,
    );
    if (source === undefined) {
      throw new Error(`unknown source version ${sourceVersion}`);
    }
    return source;
  }

  #run(runId: string): RunRow {
    requireNonempty(runId, "runId");
    const run = one<RunRow>(
      this.#database.prepare("SELECT * FROM translation_runs WHERE run_id=?"),
      runId,
    );
    if (run === undefined) {
      throw new Error(`unknown translation run ${runId}`);
    }
    return run;
  }

  #window(runId: string, windowId: string): PersistedLosslessWindow | undefined {
    const row = one<WindowRow>(
      this.#database.prepare("SELECT * FROM window_plans WHERE run_id=? AND window_id=?"),
      runId,
      windowId,
    );
    if (row === undefined) {
      return undefined;
    }
    const window = windowFromRow(row, this.#membershipIds(runId, windowId));
    window.globalIndexes = this.#globalIndexes(runId, windowId);
    return window;
  }

  #membershipIds(runId: string, windowId: string): string[] {
    return all<{ block_id: string }>(this.#database.prepare(`
      SELECT block_id FROM window_membership
      WHERE run_id=? AND window_id=? ORDER BY position
    `), runId, windowId).map((row) => row.block_id);
  }

  #globalIndexes(runId: string, windowId: string): number[] {
    return all<{ global_index: number }>(this.#database.prepare(`
      SELECT b.global_index
      FROM window_membership AS m
      JOIN logical_blocks AS b
        ON b.source_version=m.source_version AND b.block_id=m.block_id
      WHERE m.run_id=? AND m.window_id=? ORDER BY m.position
    `), runId, windowId).map((row) => row.global_index);
  }

  #membership(runId: string, windowId: string): Map<string, LogicalBlockRow> {
    const rows = all<LogicalBlockRow>(this.#database.prepare(`
      SELECT b.block_id, b.source_version, b.source_hash, b.global_index,
             b.canonical_start, b.canonical_end, b.token_count
      FROM window_membership AS m
      JOIN logical_blocks AS b
        ON b.source_version=m.source_version AND b.block_id=m.block_id
      WHERE m.run_id=? AND m.window_id=? ORDER BY m.position
    `), runId, windowId);
    return new Map(rows.map((row) => [row.block_id, row]));
  }

  #appendEvent(runId: string | null, kind: string, payload: unknown): void {
    this.#database.prepare(`
      INSERT INTO events(run_id, kind, payload_json) VALUES(?, ?, ?)
    `).run(runId, requireNonempty(kind, "event kind"), jsonText(payload, "event payload"));
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#faultInjector?.checkpoint("before_commit");
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
