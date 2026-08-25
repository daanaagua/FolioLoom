import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import type { CommitPromotion } from "../fullbook/commit-coordinator.js";
import type { AdaptiveSchedulerSnapshot } from "../fullbook/adaptive-scheduler.js";
import type { SchedulerRunReport } from "../fullbook/dynamic-scheduler.js";
import {
  schedulerCountersPatch,
  TokenLedger,
  type LedgerEvent,
  type TokenLedgerInit,
} from "../fullbook/token-ledger.js";
import type { BookWindowPlan, BookWindowStatus } from "../fullbook/types.js";
import {
  classifyImport,
  type ExistingImportKnowledge,
  type ImportClassification,
} from "../knowledge-import/conflict-classifier.js";
import type {
  PreparedImportRecord,
} from "../knowledge-import/knowledge-import-service.js";
import type {
  NormalizedImportRecord,
} from "../knowledge-import/record-normalizer.js";
import type {
  CommittedImportReport,
  DiscardStagedImportRequest,
  ImportConflictDecision,
  ImportCountSummary,
  ImportDecisionRequest,
  ImportPreviewRow,
  ImportSelection,
  KnowledgeImportFormat,
  RolledBackImportReport,
  StageImportRequest,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "../knowledge-import/types.js";
import { MAX_STAGED_IMPORT_PAGE_SIZE } from "../knowledge-import/types.js";
import {
  getSourceLanguageProfile,
  supportedSourceLanguageIds,
} from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  canonicalJson,
  KnowledgeStore,
  type KnowledgeCandidate,
  type KnowledgeRevision,
  type KnowledgeStatus,
} from "../knowledge/knowledge-store.js";
import {
  applyKnowledgeFieldPatch,
  catalogDocumentFromRevision,
  knowledgeCommandRequestHash,
  requireMatchingKnowledgeReplay,
  validateCatalogKnowledgeDocument,
  validateCommitKnowledgeCommandsRequest,
  validateKnowledgeCommand,
  validateKnowledgeEvidence,
  validateKnowledgePayload,
  type CatalogKnowledgeDocument,
  type CommitKnowledgeCommandsRequest,
  type KnowledgeCommand,
  type KnowledgeCommandEventPayload,
  type KnowledgeCommitResult,
  type KnowledgeObjectType,
  type KnowledgeStateView,
  type RollbackKnowledgeCommand,
  type UpdateKnowledgeCommand,
} from "../knowledge/knowledge-commands.js";
import {
  compareAuthority,
  normalizeKnowledgeAuthority,
  type JsonValue,
  type KnowledgeAuthority,
  type KnowledgeEvidence,
  type KnowledgeOrigin,
  type KnowledgeScope,
} from "../knowledge/knowledge-authority.js";
import {
  createKnowledgeSnapshot,
  type KnowledgeSnapshot,
} from "../knowledge/snapshot.js";
import {
  buildConceptOccurrenceIndex,
  type ConceptOccurrence,
  type ConceptOccurrenceSpan,
} from "../knowledge/concept-occurrence-index.js";
import {
  evaluateRevalidationBindings,
  evaluateStagedConceptBindings,
  planSparseRevalidation,
  type BindingGateDecision,
  type RevalidationBindingState,
} from "../knowledge/sparse-revalidation.js";
import type {
  LexicalConcept,
  LexicalSemanticClass,
} from "../knowledge/lexical-concept.js";
import {
  expectedTermOccurrences,
  validateTermUsages,
  type TermConceptProjection,
  type TermUsageSubmission,
} from "../knowledge/term-usage.js";
/*
 * Keep the runtime validators above in the storage commit gate.  A durable
 * replacement must not trust that its caller used the same request harness.
 */
import {
  knowledgeRevisionMatchesSearch,
  type KnowledgeDiagnosticsSummary,
  type KnowledgeImpactView,
  type KnowledgeRecordPageQuery,
  type KnowledgeQueryRecord,
  type KnowledgeQuerySource,
} from "../knowledge/knowledge-query.js";
import { matchKnowledgeImpacts } from "../knowledge/knowledge-impact-matcher.js";
import { sourceFormsFromRevision } from "../knowledge/knowledge-source-forms.js";
import { blockId } from "../source/block-builder.js";
import { LEGACY_TOKEN_ESTIMATOR_VERSION } from "../source/token-estimator.js";
import type { LosslessBlock, StructureAnnotation } from "../source/types.js";
import { scalarLength } from "../source/types.js";
import { parseStyleObservation } from "../style/style-observation.js";
import type { LocalStyleObservation } from "../style/types.js";
import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT as LOSSLESS_BOOK_SCHEMA_V2_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER as LOSSLESS_BOOK_SCHEMA_V2_MARKER,
  LOSSLESS_BOOK_SCHEMA_TABLES as LOSSLESS_BOOK_SCHEMA_V2_TABLES,
  LOSSLESS_BOOK_SCHEMA_VERSION as LOSSLESS_BOOK_SCHEMA_V2_VERSION,
} from "./book-schema-v2.js";
import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT as LOSSLESS_BOOK_SCHEMA_V3_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER as LOSSLESS_BOOK_SCHEMA_V3_MARKER,
  LOSSLESS_BOOK_SCHEMA_TABLES as LOSSLESS_BOOK_SCHEMA_V3_TABLES,
  LOSSLESS_BOOK_SCHEMA_V3,
  LOSSLESS_BOOK_SCHEMA_V3_EXTENSION,
  LOSSLESS_BOOK_SCHEMA_V3_KNOWLEDGE_RECORDS,
  LOSSLESS_BOOK_SCHEMA_VERSION as LOSSLESS_BOOK_SCHEMA_V3_VERSION,
} from "./book-schema-v3.js";
import {
  LOSSLESS_BOOK_SCHEMA_FINGERPRINT,
  LOSSLESS_BOOK_SCHEMA_MARKER,
  LOSSLESS_BOOK_SCHEMA_TABLES,
  LOSSLESS_BOOK_SCHEMA_V4,
  LOSSLESS_BOOK_SCHEMA_V4_EXTENSION,
  LOSSLESS_BOOK_SCHEMA_VERSION,
} from "./book-schema-v4.js";

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
  /** Omitted only by plans created before versioned token estimation. */
  estimatorVersion?: string;
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

export interface ProviderResponseEvidenceInput {
  readonly runId: string;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly phase: "research" | "translation" | "repair" | "recovery";
  readonly modelCallOrdinal: number;
  readonly requestHash: string;
  readonly responseProtocol: "typed_tool" | "framed_text";
  readonly executionUnitId?: string;
  readonly assistantMessage: unknown;
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

export interface ScopedKnowledgeSyncResult {
  readonly changed: boolean;
  readonly generation: number;
  readonly snapshotId: string;
  readonly appliedBookGeneration: number;
  readonly appliedProjectGeneration: number;
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
  conceptBindings?: WindowConceptBindingsInput;
}

export interface WindowConceptBindingsInput {
  readonly usages: readonly TermUsageSubmission[];
  readonly concepts: readonly TermConceptProjection[];
}

export interface LexicalConceptChange {
  readonly conceptId: string;
  readonly revision: number;
  readonly previousRevisionId: string | null;
  readonly revisionId: string;
  readonly previousRenderFingerprint: string | null;
  readonly renderFingerprint: string;
  readonly renderChanged: boolean;
}

export interface StoredLexicalConcept extends LexicalConcept {
  readonly revision: number;
}

export interface StoredConceptOccurrence extends ConceptOccurrence {
  readonly sourceVersion: string;
}

export interface TranslationConceptBinding {
  readonly translationId: number;
  readonly conceptId: string;
  readonly appliedRevisionId: string;
  readonly appliedRenderFingerprint: string;
  readonly termUsages: readonly TermUsageSubmission[];
  readonly validationStatus:
    | "clean"
    | "pending"
    | "validating"
    | "stale"
    | "warning_stale";
  readonly validatedRevisionId: string;
}

export type WindowPromotionOutcome = "promoted" | "retry_latest_snapshot";

export interface KnowledgeRevalidationTask {
  readonly taskId: string;
  readonly runId: string;
  readonly translationId: number;
  readonly blockId: string;
  readonly changeSetHash: string;
  readonly fromSnapshotId: string;
  readonly toSnapshotId: string;
  readonly conceptIds: readonly string[];
  readonly status:
    | "pending"
    | "validating"
    | "resolved_noop"
    | "resolved_repair"
    | "resolved_retranslate"
    | "completed_with_warning";
  readonly attempts: number;
  readonly result: unknown;
  readonly replacementTranslationId: number | null;
}

export interface ConceptCoverageRevalidationReport {
  readonly occurrenceDependencies: number;
  readonly candidateTranslations: number;
  readonly tasksCreated: number;
  readonly bindingsCreated: number;
  readonly wallTimeMs: number;
}

export interface RevalidationTranslationRecord
  extends ActiveLosslessTranslation {
  readonly translationId: number;
  readonly snapshotId: string;
}

export interface RevalidationSourceBlock {
  readonly blockId: string;
  readonly sourceVersion: string;
  readonly sourceHash: string;
  readonly sourceText: string;
  readonly globalIndex: number;
  readonly tokenCount: number;
}

export interface RevalidationConceptState extends RevalidationBindingState {
  readonly appliedConcept: StoredLexicalConcept;
  readonly currentConcept: StoredLexicalConcept;
}

export interface RevalidationWorkItem {
  readonly task: KnowledgeRevalidationTask;
  readonly translation: RevalidationTranslationRecord;
  readonly source: RevalidationSourceBlock;
  readonly window: PersistedLosslessWindow;
  readonly concepts: readonly RevalidationConceptState[];
}

export interface RevalidationReplacementInput {
  readonly runId: string;
  readonly taskId: string;
  readonly snapshotId: string;
  readonly action: "repair" | "retranslate";
  readonly text: string;
  readonly resultStatus: "completed" | "completed_with_warnings";
  readonly termUsages: readonly TermUsageSubmission[];
  readonly concepts: readonly TermConceptProjection[];
  readonly result: unknown;
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
  | "before_commit"
  | "knowledge_command_before_commit"
  | "knowledge_import_stage_before_commit"
  | "knowledge_import_before_commit"
  | "knowledge_import_rollback_before_commit"
  | "schema_v3_before_commit"
  | "schema_v4_before_commit";

export interface FaultInjector {
  checkpoint(name: FaultCheckpoint): void;
}

export interface PersistKnowledgeImportStageInput {
  readonly runId: string;
  readonly batchId: string;
  readonly sourceHash: string;
  readonly sourceName: string;
  readonly sourceFormat: KnowledgeImportFormat;
  readonly mappingJson: string;
  readonly mappingHash: string;
  readonly request: StageImportRequest;
  readonly records: Iterable<PreparedImportRecord>;
}

export interface CommitStoredKnowledgeImportInput {
  readonly runId: string;
  readonly batchId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly signal: AbortSignal;
}

export interface AttachGlobalKnowledgeSnapshotInput {
  readonly requestId: string;
  readonly runId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly globalRevisionId: string;
  readonly document: CatalogKnowledgeDocument;
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
  producingWindowId: string | null;
}

export interface LosslessAuditSnapshot {
  sequence: number;
  snapshotId: string;
  parentSnapshotId: string | null;
  producingWindowId: string | null;
  contentHash: string;
  payload: unknown;
}

export interface LosslessAuditConceptBinding {
  translationId: number;
  conceptId: string;
  validationStatus: TranslationConceptBinding["validationStatus"];
}

export interface LosslessAuditMissingConceptBinding {
  translationId: number;
  blockId: string;
  conceptId: string;
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
  conceptBindings: LosslessAuditConceptBinding[];
  missingConceptBindings: LosslessAuditMissingConceptBinding[];
  revalidationTasks: KnowledgeRevalidationTask[];
}

type LosslessStoreOpenMode = "read-write" | "read-only";

interface ReadOnlySourceFileState {
  size: number;
  mtimeMs: number;
}

interface ReadOnlySnapshotState {
  database: ReadOnlySourceFileState;
  wal: ReadOnlySourceFileState | undefined;
}

interface ReadOnlySnapshot {
  databasePath: string;
  directory: string;
}

const READ_ONLY_SNAPSHOT_ATTEMPTS = 3;
const DEFAULT_MAX_REVALIDATION_ATTEMPTS = 2;

export class LosslessReadSnapshotError extends Error {
  readonly code = "LOSSLESS_READ_SNAPSHOT_UNSTABLE";

  constructor() {
    super(
      "source database changed while preparing a read-only snapshot; try again after the writer is idle",
    );
    this.name = "LosslessReadSnapshotError";
  }
}

function sameReadOnlySourceFileState(
  left: ReadOnlySourceFileState | undefined,
  right: ReadOnlySourceFileState | undefined,
): boolean {
  return left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;
}

function sameReadOnlySnapshotState(
  left: ReadOnlySnapshotState,
  right: ReadOnlySnapshotState,
): boolean {
  return sameReadOnlySourceFileState(left.database, right.database)
    && sameReadOnlySourceFileState(left.wal, right.wal);
}

function isMissingPath(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && (error as { code?: unknown }).code === "ENOENT";
}

function isTransientSnapshotCleanupError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && ["EBUSY", "ENOTEMPTY", "EPERM"].includes(
      String((error as { code?: unknown }).code),
    );
}

function removeReadOnlySnapshotDirectory(directory: string): void {
  try {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch (error) {
    // SQLite and virus scanners can briefly retain a copied WAL/SHM handle on
    // Windows after DatabaseSync.close(). A disposable snapshot must never
    // turn a successful project read into a startup failure.
    if (!isTransientSnapshotCleanupError(error)) {
      throw error;
    }
  }
}

function readOnlySourceFileState(path: string): ReadOnlySourceFileState {
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new Error(`read-only snapshot source must be a regular file: ${path}`);
  }
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

function optionalReadOnlySourceFileState(path: string): ReadOnlySourceFileState | undefined {
  try {
    return readOnlySourceFileState(path);
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

function readOnlySnapshotState(path: string): ReadOnlySnapshotState {
  return {
    database: readOnlySourceFileState(path),
    wal: optionalReadOnlySourceFileState(`${path}-wal`),
  };
}

function createReadOnlySnapshot(path: string): ReadOnlySnapshot {
  for (let attempt = 0; attempt < READ_ONLY_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = readOnlySnapshotState(path);
    const directory = mkdtempSync(join(tmpdir(), "folioloom-readonly-"));
    const databasePath = join(directory, "book.db");
    try {
      copyFileSync(path, databasePath);
      if (before.wal !== undefined) {
        copyFileSync(`${path}-wal`, `${databasePath}-wal`);
      }
      const after = readOnlySnapshotState(path);
      if (sameReadOnlySnapshotState(before, after)) {
        return { databasePath, directory };
      }
    } catch (error) {
      removeReadOnlySnapshotDirectory(directory);
      if (!isMissingPath(error)) {
        throw error;
      }
      continue;
    }
    removeReadOnlySnapshotDirectory(directory);
  }
  throw new LosslessReadSnapshotError();
}

interface SourceVersionRow {
  source_version: string;
  canonical_sha256: string;
  canonical_chars: number;
  source_fingerprint: string;
  plan_fingerprint: string | null;
  source_payload_json: string;
}

interface RunRow {
  run_id: string;
  source_version: string;
  protocol_version: string;
  model_id: string;
  metadata_json: string;
  status: string;
}

interface KnowledgeStateRow {
  generation: number;
  applied_book_generation: number;
  applied_project_generation: number;
}

interface StoredKnowledgeSummaryRow {
  run_id: string;
  record_id: string;
  revision_id: string;
  revision: number;
  normalized_subject: string;
  kind: string;
  payload_json: string;
  status: string;
  active: number;
  origin: string;
  scope: string;
  owned_fields_json: string;
}

interface StoredKnowledgeRevisionRow extends StoredKnowledgeSummaryRow {
  evidence_json: string;
  import_batch_id: string | null;
}

interface KnowledgePageRow extends StoredKnowledgeSummaryRow {
  object_type: string;
  catalog_object_type: string | null;
  scope_revision: number | null;
  scope_revision_scope: string | null;
  provenance_catalog: string | null;
  provenance_revision_id: string | null;
}

interface CatalogKnowledgeRow {
  source_version: string | null;
  record_id: string;
  revision: number;
  revision_id: string;
  object_type: string;
  normalized_subject: string;
  kind: string;
  document_json: string;
  origin: string;
  scope: string;
  active: number;
}

interface ActiveCatalogEntry {
  readonly row: CatalogKnowledgeRow;
  readonly document: CatalogKnowledgeDocument;
}

interface AppliedKnowledgeCommand {
  readonly revision: KnowledgeRevision;
  readonly bookChanged: boolean;
  readonly projectChanged: boolean;
}

interface KnowledgeImportBatchRow {
  run_id: string;
  batch_id: string;
  source_hash: string;
  source_name: string;
  source_format: KnowledgeImportFormat;
  mapping_json: string;
  mapping_hash: string;
  status: "staged" | "committed" | "rolled_back" | "discarded" | "failed";
  report_json: string;
  created_at: string;
}

interface KnowledgeImportRow {
  run_id: string;
  batch_id: string;
  row_ordinal: number;
  state: ImportPreviewRow["state"] | "committed";
  normalized_json: string;
  diagnostics_json: string;
  decision_json: string | null;
}

interface StoredNormalizedImportRow {
  readonly state: ImportPreviewRow["state"];
  readonly prepared: PreparedImportRecord;
  readonly classification: Pick<
    ImportClassification,
    "allowedDecisions" | "conflictSignature"
  >;
  readonly displayFields: Readonly<Record<string, JsonValue>>;
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

interface LexicalConceptRow {
  run_id: string;
  concept_id: string;
  revision: number;
  revision_id: string;
  normalized_subject: string;
  source_forms_json: string;
  semantic_class: string;
  canonical_target: string;
  policy: string;
  allowed_realizations_json: string;
  visibility: string;
  confidence: number;
  render_fingerprint: string;
  active: number;
}

interface TranslationConceptBindingRow {
  translation_id: number;
  concept_id: string;
  applied_revision_id: string;
  applied_render_fingerprint: string;
  term_usages_json: string;
  validation_status: TranslationConceptBinding["validationStatus"];
  validated_revision_id: string;
}

interface KnowledgeRevalidationTaskRow {
  task_id: string;
  run_id: string;
  translation_id: number;
  block_id: string;
  change_set_hash: string;
  from_snapshot_id: string;
  to_snapshot_id: string;
  concept_ids_json: string;
  status: KnowledgeRevalidationTask["status"];
  attempts: number;
  result_json: string;
  replacement_translation_id: number | null;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function knowledgeKey(normalizedSubject: string, kind: string): string {
  return `${normalizedSubject}\0${kind}`;
}

const PROJECTABLE_KNOWLEDGE_STATUSES = new Set<KnowledgeStatus>([
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
]);

function knowledgeObjectType(
  revision: KnowledgeRevision,
): KnowledgeObjectType {
  const payload = revision.payload !== null
    && typeof revision.payload === "object"
    && !Array.isArray(revision.payload)
    ? revision.payload as Record<string, unknown>
    : {};
  if ("sourceForm" in payload || "canonicalSource" in payload || "target" in payload) {
    return "term";
  }
  if ("alias" in payload && "entityId" in payload) return "alias";
  if ("fromEntityId" in payload || "relationType" in payload) return "relation";
  if ("canonicalName" in payload || "targetName" in payload || "entityType" in payload) {
    return "entity";
  }
  if ("summary" in payload || "timeline" in payload || "startBlockId" in payload) {
    return "memory";
  }
  if (revision.kind.includes("style")) return "style";
  if (revision.kind.includes("alias")) return "alias";
  if (revision.kind.includes("relation")) return "relation";
  if (revision.kind.includes("entity")) return "entity";
  if (revision.kind.includes("memory") || revision.kind === "fact") return "memory";
  return "term";
}

function parsedKnowledgeRevision(value: unknown): KnowledgeRevision {
  if (typeof value !== "string") {
    throw new TypeError("stored knowledge revision JSON must be text");
  }
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("stored knowledge revision JSON must be an object");
  }
  return parsed as KnowledgeRevision;
}

function sqliteKnowledgeObjectType(value: unknown): string {
  return knowledgeObjectType(parsedKnowledgeRevision(value));
}

function sqliteKnowledgeMatches(
  value: unknown,
  objectType: unknown,
  search: unknown,
): number {
  if (typeof objectType !== "string" || typeof search !== "string") {
    return 0;
  }
  return knowledgeRevisionMatchesSearch(
    parsedKnowledgeRevision(value),
    objectType as KnowledgeObjectType,
    search,
  ) ? 1 : 0;
}

function importCursor(batchId: string, ordinal: number): string {
  return Buffer.from(canonicalJson({
    schema: "folioloom-knowledge-import-cursor-1",
    batchId,
    ordinal,
  }), "utf8").toString("base64url");
}

function parseImportCursor(
  cursor: string | undefined,
  batchId: string,
): number {
  if (cursor === undefined) return -1;
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (raw.schema !== "folioloom-knowledge-import-cursor-1"
      || raw.batchId !== batchId
      || !Number.isSafeInteger(raw.ordinal)
      || (raw.ordinal as number) < 0
      || importCursor(batchId, raw.ordinal as number) !== cursor) {
      throw new Error("cursor identity mismatch");
    }
    return raw.ordinal as number;
  } catch (error) {
    throw new Error("KNOWLEDGE_IMPORT_CURSOR_INVALID", { cause: error });
  }
}

function emptyImportCounts(): ImportCountSummary {
  return { ready: 0, merge: 0, conflict: 0, invalid: 0, skipped: 0 };
}

function parseImportDecision(value: string | null): ImportConflictDecision | undefined {
  if (value === null) return undefined;
  const raw = JSON.parse(value) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("corrupt knowledge import decision");
  }
  const decision = raw as Record<string, unknown>;
  if (decision.action === "keep_existing"
    || decision.action === "use_imported"
    || decision.action === "merge_as_alias"
    || decision.action === "skip") {
    if (Object.keys(decision).length !== 1) {
      throw new Error("corrupt knowledge import decision");
    }
    return { action: decision.action };
  }
  if (decision.action === "create_separate"
    && Object.keys(decision).length === 2
    && typeof decision.normalizedSubject === "string"
    && decision.normalizedSubject.trim().length > 0) {
    return {
      action: "create_separate",
      normalizedSubject: decision.normalizedSubject.normalize("NFKC").trim(),
    };
  }
  throw new Error("corrupt knowledge import decision");
}

function parseStoredImportRow(row: KnowledgeImportRow): StoredNormalizedImportRow {
  const parsed = JSON.parse(row.normalized_json) as StoredNormalizedImportRow;
  if (parsed === null || typeof parsed !== "object"
    || parsed.prepared === undefined
    || parsed.classification === undefined
    || parsed.displayFields === undefined
    || parsed.state === undefined) {
    throw new Error(`corrupt knowledge import row ${row.batch_id}/${row.row_ordinal}`);
  }
  if (parsed.prepared.state === "normalized"
    && parsed.prepared.record.ordinal !== row.row_ordinal) {
    throw new Error(`corrupt knowledge import row ${row.batch_id}/${row.row_ordinal}`);
  }
  if (parsed.prepared.state === "invalid"
    && parsed.prepared.ordinal !== row.row_ordinal) {
    throw new Error(`corrupt knowledge import row ${row.batch_id}/${row.row_ordinal}`);
  }
  return parsed;
}

function importPreviewFromRow(row: KnowledgeImportRow): ImportPreviewRow {
  const stored = parseStoredImportRow(row);
  const decision = parseImportDecision(row.decision_json);
  const effectiveState = decision?.action === "skip"
    || decision?.action === "keep_existing"
    ? "skipped"
    : stored.state;
  const diagnostics = JSON.parse(row.diagnostics_json) as ImportPreviewRow["diagnostics"];
  if (!Array.isArray(diagnostics)) {
    throw new Error(`corrupt knowledge import diagnostics ${row.batch_id}/${row.row_ordinal}`);
  }
  return Object.freeze({
    ordinal: row.row_ordinal,
    location: stored.prepared.state === "normalized"
      ? stored.prepared.record.location
      : stored.prepared.location,
    state: effectiveState,
    displayFields: Object.freeze({ ...stored.displayFields }),
    diagnostics: Object.freeze([...diagnostics]),
    allowedDecisions: Object.freeze([
      ...stored.classification.allowedDecisions,
    ]),
  });
}

function importCounts(rows: readonly KnowledgeImportRow[]): {
  readonly counts: ImportCountSummary;
  readonly unresolved: number;
} {
  const counts = emptyImportCounts();
  const mutableCounts = counts as {
    -readonly [Key in keyof ImportCountSummary]: number;
  };
  let unresolved = 0;
  for (const row of rows) {
    const stored = parseStoredImportRow(row);
    const decision = parseImportDecision(row.decision_json);
    const state = decision?.action === "skip"
      || decision?.action === "keep_existing"
      ? "skipped"
      : stored.state;
    mutableCounts[state] += 1;
    if ((stored.state === "conflict" || stored.state === "invalid")
      && decision === undefined) {
      unresolved += 1;
    }
  }
  return { counts, unresolved };
}

function importIdentityKey(normalizedSubject: string, kind: string): string {
  return `${normalizedSubject.normalize("NFKC").trim().toLocaleLowerCase("und")}`
    + `\0${kind.normalize("NFKC").trim().toLocaleLowerCase("und")}`;
}

function bindImportRecordIdentity(
  record: NormalizedImportRecord,
  existing: ExistingImportKnowledge | undefined,
): NormalizedImportRecord {
  if (existing === undefined
    || existing.objectType !== record.command.objectType
    || (existing.normalizedSubject === record.command.normalizedSubject
      && existing.kind === record.command.kind)) {
    return record;
  }
  const command = Object.freeze({
    ...record.command,
    normalizedSubject: existing.normalizedSubject,
    kind: existing.kind,
  });
  return Object.freeze({
    ...record,
    command,
    canonicalHash: hashText(canonicalJson(command)),
  });
}

function parseCommittedImportReport(value: string): CommittedImportReport {
  const report = JSON.parse(value) as CommittedImportReport;
  if (report === null || typeof report !== "object"
    || typeof report.batchId !== "string"
    || !Number.isSafeInteger(report.generation)
    || typeof report.snapshotId !== "string") {
    throw new Error("corrupt committed knowledge import report");
  }
  return Object.freeze({ ...report });
}

function parseRolledBackImportReport(value: string): RolledBackImportReport {
  const report = JSON.parse(value) as RolledBackImportReport;
  if (report === null || typeof report !== "object"
    || typeof report.batchId !== "string"
    || !Number.isSafeInteger(report.generation)
    || typeof report.snapshotId !== "string") {
    throw new Error("corrupt rolled-back knowledge import report");
  }
  return Object.freeze({ ...report });
}

function shortSourceExcerpt(
  sourceText: string,
  forms: readonly string[],
  profile: SourceLanguageProfile,
): string {
  const scalars = [...sourceText];
  if (scalars.length <= 160) return sourceText;
  const lowerSource = sourceText.normalize("NFKC").toLocaleLowerCase(profile.locale);
  const rawIndex = forms
    .map((form) =>
      lowerSource.indexOf(form.normalize("NFKC").toLocaleLowerCase(profile.locale)))
    .find((index) => index >= 0) ?? 0;
  const scalarIndex = [...sourceText.slice(0, rawIndex)].length;
  const start = Math.max(0, scalarIndex - 60);
  return scalars.slice(start, Math.min(scalars.length, start + 160)).join("");
}

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

function revalidationTaskFromRow(
  row: KnowledgeRevalidationTaskRow,
): KnowledgeRevalidationTask {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    translationId: row.translation_id,
    blockId: row.block_id,
    changeSetHash: row.change_set_hash,
    fromSnapshotId: row.from_snapshot_id,
    toSnapshotId: row.to_snapshot_id,
    conceptIds: stringArrayFromJson(
      row.concept_ids_json,
      "revalidation concept IDs",
    ),
    status: row.status,
    attempts: row.attempts,
    result: JSON.parse(row.result_json) as unknown,
    replacementTranslationId: row.replacement_translation_id,
  };
}

function lexicalConceptFromRow(row: LexicalConceptRow): StoredLexicalConcept {
  const semanticClasses = new Set<LexicalSemanticClass>([
    "proper_name",
    "unique_title",
    "technical_term",
    "role",
  ]);
  if (!semanticClasses.has(row.semantic_class as LexicalSemanticClass)
    || !["locked", "preferred", "contextual"].includes(row.policy)
    || !["translator_global", "narrative_before_target"].includes(row.visibility)) {
    throw new Error(`corrupt lexical concept ${row.concept_id}`);
  }
  return {
    conceptId: row.concept_id,
    revision: requireSafeInteger(row.revision, "lexical concept revision", 1),
    revisionId: row.revision_id,
    normalizedSubject: row.normalized_subject,
    sourceForms: stringArrayFromJson(
      row.source_forms_json,
      "lexical source forms",
    ),
    semanticClass: row.semantic_class as LexicalSemanticClass,
    canonicalTarget: row.canonical_target,
    policy: row.policy as LexicalConcept["policy"],
    allowedRealizations: stringArrayFromJson(
      row.allowed_realizations_json,
      "lexical allowed realizations",
    ),
    visibility: row.visibility as LexicalConcept["visibility"],
    confidence: row.confidence,
    renderFingerprint: row.render_fingerprint,
  };
}

function lexicalConceptFromPayload(value: unknown): LexicalConcept {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("corrupt lexical concept knowledge payload");
  }
  const payload = value as Partial<LexicalConcept>;
  if (typeof payload.conceptId !== "string"
    || typeof payload.revisionId !== "string"
    || typeof payload.normalizedSubject !== "string"
    || !Array.isArray(payload.sourceForms)
    || payload.sourceForms.length === 0
    || payload.sourceForms.some((item: unknown) =>
      typeof item !== "string" || item.trim().length === 0)
    || !["proper_name", "unique_title", "technical_term", "role"].includes(
      payload.semanticClass ?? "",
    )
    || typeof payload.canonicalTarget !== "string"
    || !["locked", "preferred", "contextual"].includes(payload.policy ?? "")
    || !Array.isArray(payload.allowedRealizations)
    || payload.allowedRealizations.length === 0
    || payload.allowedRealizations.some((item: unknown) =>
      typeof item !== "string" || item.trim().length === 0)
    || typeof payload.confidence !== "number"
    || !Number.isFinite(payload.confidence)
    || payload.confidence < 0
    || payload.confidence > 1
    || !["translator_global", "narrative_before_target"].includes(
      payload.visibility ?? "",
    )
    || typeof payload.renderFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(payload.renderFingerprint)) {
    throw new Error("corrupt lexical concept knowledge payload");
  }
  return {
    conceptId: payload.conceptId,
    revisionId: payload.revisionId,
    normalizedSubject: payload.normalizedSubject,
    sourceForms: [...payload.sourceForms] as string[],
    semanticClass: payload.semanticClass as LexicalConcept["semanticClass"],
    canonicalTarget: payload.canonicalTarget,
    policy: payload.policy as LexicalConcept["policy"],
    allowedRealizations: [...payload.allowedRealizations] as string[],
    confidence: payload.confidence,
    visibility: payload.visibility as LexicalConcept["visibility"],
    renderFingerprint: payload.renderFingerprint,
  };
}

function termUsagesFromJson(value: string): TermUsageSubmission[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("corrupt term usages JSON");
  }
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("corrupt term usages JSON");
    }
    const usage = item as Partial<TermUsageSubmission>;
    if (typeof usage.occurrenceId !== "string"
      || typeof usage.blockId !== "string"
      || typeof usage.conceptId !== "string"
      || typeof usage.sourceForm !== "string"
      || !Number.isSafeInteger(usage.sourceStart)
      || !Number.isSafeInteger(usage.sourceEnd)
      || typeof usage.targetSurface !== "string"
      || !["narrative", "vocative", "title", "other"].includes(
        usage.discourseRole ?? "",
      )) {
      throw new Error("corrupt term usages JSON");
    }
  }
  return parsed as TermUsageSubmission[];
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
  readonly #databasePath: string;
  readonly #faultInjector: FaultInjector | undefined;
  readonly #temporarySnapshotDirectory: string | undefined;
  readonly #schemaVersion: number;

  constructor(
    path: string,
    faultInjector?: FaultInjector,
    mode: LosslessStoreOpenMode = "read-write",
    temporarySnapshotDirectory?: string,
  ) {
    const absolute = resolve(requireNonempty(path, "database path"));
    this.#databasePath = absolute;
    this.#faultInjector = faultInjector;
    this.#temporarySnapshotDirectory = temporarySnapshotDirectory;
    if (mode === "read-write") {
      mkdirSync(dirname(absolute), { recursive: true });
    }
    this.#database = new DatabaseSync(
      absolute,
      mode === "read-only" ? { readOnly: true } : {},
    );
    try {
      this.#database.exec("PRAGMA foreign_keys=ON");
      this.#database.function(
        "folioloom_knowledge_object_type",
        { deterministic: true },
        sqliteKnowledgeObjectType,
      );
      this.#database.function(
        "folioloom_knowledge_matches",
        { deterministic: true },
        sqliteKnowledgeMatches,
      );
      const userVersion = one<{ user_version: number }>(
        this.#database.prepare("PRAGMA user_version"),
      )?.user_version ?? 0;
      const tables = all<{ name: string }>(this.#database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)).map((row) => row.name);
      if (tables.length === 0 && userVersion === 0) {
        if (mode === "read-only") {
          throw new Error("lossless book store does not exist");
        }
        this.#initializeSchema();
        this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_VERSION;
      } else if (userVersion === LOSSLESS_BOOK_SCHEMA_V2_VERSION) {
        this.#verifyV2Schema(tables);
        if (mode === "read-write") {
          this.#migrateV2ToV3();
          this.#migrateV3ToV4();
          this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_VERSION;
        } else {
          this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_V2_VERSION;
        }
      } else if (userVersion === LOSSLESS_BOOK_SCHEMA_V3_VERSION) {
        this.#verifyV3Schema(userVersion, tables);
        if (mode === "read-write") {
          this.#migrateV3ToV4();
          this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_VERSION;
        } else {
          this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_V3_VERSION;
        }
      } else {
        this.#verifyV4Schema(userVersion, tables);
        this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_VERSION;
      }
      if (mode === "read-write") {
        this.#database.exec("PRAGMA journal_mode=WAL");
      }
    } catch (error) {
      this.#database.close();
      if (this.#temporarySnapshotDirectory !== undefined) {
        removeReadOnlySnapshotDirectory(this.#temporarySnapshotDirectory);
      }
      throw error;
    }
  }

  static openReadOnly(path: string): LosslessBookStore {
    const sourcePath = resolve(requireNonempty(path, "database path"));
    const snapshot = createReadOnlySnapshot(sourcePath);
    try {
      return new LosslessBookStore(
        snapshot.databasePath,
        undefined,
        "read-only",
        snapshot.directory,
      );
    } catch (error) {
      removeReadOnlySnapshotDirectory(snapshot.directory);
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
      this.#database.prepare(`
        INSERT INTO book_knowledge_state(source_version, generation)
        VALUES(?, 0)
      `).run(normalized.sourceVersion);
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
        throw new Error(
          `derived plan for ${sourceVersion} already contains different data or a different estimator version`,
        );
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
      this.#appendEvent(null, "derived_plan_registered", {
        sourceVersion,
        fingerprint,
        estimatorVersion: normalized.estimatorVersion,
      });
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
    const requestedSnapshotId = requireNonempty(
      meta.initialSnapshotId,
      "initialSnapshotId",
    );
    const metadata = jsonText(meta.metadata ?? {}, "translation run metadata");
    const initialSnapshot = meta.initialSnapshot;
    if (initialSnapshot !== undefined) {
      if (initialSnapshot.runId !== runId) {
        throw new Error(`initial snapshot ${initialSnapshot.id} belongs to another run`);
      }
      if (initialSnapshot.id !== requestedSnapshotId
        || initialSnapshot.id !== initialSnapshot.contentHash) {
        throw new Error("initial snapshot identity mismatch");
      }
    }
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
      const snapshot = one<{ snapshot_id: string; payload_json: string }>(
        this.#database.prepare(`
        SELECT snapshot_id, payload_json FROM knowledge_snapshots
        WHERE run_id=? ORDER BY rowid LIMIT 1
      `),
        runId,
      );
      const requestedIsCanonicalEmpty = initialSnapshot !== undefined
        && initialSnapshot.revisions.length === 0
        && initialSnapshot.parentSnapshotId === null
        && initialSnapshot.id === createKnowledgeSnapshot(runId, []).id;
      const persistedWasCatalogSeeded = snapshot !== undefined
        && (() => {
          const parsed = JSON.parse(snapshot.payload_json) as unknown;
          return parsed !== null
            && typeof parsed === "object"
            && !Array.isArray(parsed)
            && Array.isArray((parsed as { revisions?: unknown }).revisions)
            && ((parsed as { revisions: unknown[] }).revisions.length > 0);
        })();
      if (snapshot === undefined
        || (snapshot.snapshot_id !== requestedSnapshotId
          && !(requestedIsCanonicalEmpty && persistedWasCatalogSeeded))) {
        throw new Error(`translation run ${runId} initial snapshot mismatch`);
      }
      this.#verifyRunKnowledgeState(runId, sourceVersion);
      return runId;
    }

    this.#transaction(() => {
      const bookGeneration = one<{ generation: number }>(this.#database.prepare(`
        SELECT generation FROM book_knowledge_state WHERE source_version=?
      `), sourceVersion)?.generation;
      const projectGeneration = one<{ generation: number }>(this.#database.prepare(`
        SELECT generation FROM project_knowledge_state WHERE singleton=1
      `))?.generation;
      if (bookGeneration === undefined || projectGeneration === undefined) {
        throw new Error("schema v3 knowledge generation state is incomplete");
      }
      const seededRevisions = this.#catalogSeedRevisions(runId, sourceVersion);
      if (seededRevisions.length > 0
        && initialSnapshot !== undefined
        && (initialSnapshot.revisions.length !== 0
          || initialSnapshot.parentSnapshotId !== null
          || initialSnapshot.id !== createKnowledgeSnapshot(runId, []).id)) {
        throw new Error(
          "initial knowledge snapshot conflicts with current book/project knowledge",
        );
      }
      const effectiveSnapshot = seededRevisions.length === 0
        ? initialSnapshot
        : createKnowledgeSnapshot(runId, seededRevisions);
      const effectiveSnapshotId = effectiveSnapshot?.id ?? requestedSnapshotId;
      const snapshotPayload = jsonText(
        effectiveSnapshot ?? [],
        "initial knowledge snapshot",
      );
      const snapshotHash = effectiveSnapshot?.contentHash ?? hashText(snapshotPayload);
      this.#database.prepare(`
        INSERT INTO translation_runs(
          run_id, source_version, protocol_version, model_id, metadata_json
        ) VALUES(?, ?, ?, ?, ?)
      `).run(runId, sourceVersion, protocolVersion, modelId, metadata);
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, content_hash, payload_json
        ) VALUES(?, ?, ?, ?)
      `).run(runId, effectiveSnapshotId, snapshotHash, snapshotPayload);
      for (const revision of seededRevisions) {
        this.#insertRunKnowledgeRevision(
          runId,
          revision,
          null,
          this.#catalogEvidenceForRevision(revision),
          undefined,
        );
      }
      this.#database.prepare(`
        INSERT INTO knowledge_state(
          run_id, generation, applied_book_generation, applied_project_generation
        ) VALUES(?, 0, ?, ?)
      `).run(runId, bookGeneration, projectGeneration);
      this.#appendEvent(runId, "translation_run_created", {
        runId,
        sourceVersion,
        protocolVersion,
        modelId,
        snapshotId: effectiveSnapshotId,
        seededKnowledgeRevisions: seededRevisions.length,
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
      if (input.conceptBindings !== undefined) {
        this.#writeWindowConceptBindings(
          input.runId,
          input.windowId,
          input.conceptBindings.usages,
          input.conceptBindings.concepts,
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

  promoteStagedWindow(promotion: CommitPromotion): WindowPromotionOutcome;
  promoteStagedWindow(
    runId: string,
    windowId: string,
    nextSnapshot?: KnowledgeSnapshot,
  ): WindowPromotionOutcome;
  promoteStagedWindow(
    promotionOrRunId: CommitPromotion | string,
    legacyWindowId?: string,
    legacyNextSnapshot?: KnowledgeSnapshot,
  ): WindowPromotionOutcome {
    const promotion = typeof promotionOrRunId === "string"
      ? undefined
      : promotionOrRunId;
    const runId = promotion?.runId ?? promotionOrRunId as string;
    const windowId = promotion?.windowId ?? legacyWindowId as string;
    const nextSnapshot = promotion?.nextSnapshot ?? legacyNextSnapshot;
    requireNonempty(runId, "runId");
    requireNonempty(windowId, "windowId");
    this.#faultInjector?.checkpoint("before_promote");
    return this.#transaction((): WindowPromotionOutcome => {
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
      const bindingGate = this.#evaluateStagedBindingGate(runId, windowId);
      if (bindingGate.status === "retry_latest_snapshot") {
        this.#database.prepare(`
          DELETE FROM translations
          WHERE run_id=? AND window_id=? AND stage_state='staged' AND active=0
        `).run(runId, windowId);
        this.#database.prepare(`
          DELETE FROM knowledge_candidates
          WHERE run_id=? AND window_id=? AND stage_state='staged'
        `).run(runId, windowId);
        const reset = this.#database.prepare(`
          UPDATE window_plans
          SET status='pending', result_status=NULL, snapshot_id=NULL,
              style_tail='', warnings_json='[]',
              last_error='staged concept binding requires the latest snapshot',
              updated_at=datetime('now')
          WHERE run_id=? AND window_id=? AND status='staged'
        `).run(runId, windowId);
        if (Number(reset.changes) !== 1) {
          throw new Error(`failed to reset stale staged window ${runId}/${windowId}`);
        }
        this.#appendEvent(runId, "window_concept_binding_retry", {
          runId,
          windowId,
          incompatibleConceptIds: bindingGate.incompatibleConceptIds,
        });
        return "retry_latest_snapshot";
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

      for (const revision of appendedRevisions) {
        const recordId = knowledgeRecordId(revision.normalizedSubject, revision.kind);
        const evidence = this.#activeRunKnowledgeEvidence(runId, recordId);
        this.#insertRunKnowledgeRevision(
          runId,
          revision,
          windowId,
          evidence,
          undefined,
        );
      }
      this.#projectLexicalConceptRevisions(
        runId,
        appendedRevisions,
        nextSnapshot?.id ?? row.snapshot_id,
      );
      if (appendedRevisions.length > 0) {
        const updatedKnowledgeState = this.#database.prepare(`
          UPDATE knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE run_id=?
        `).run(runId);
        if (Number(updatedKnowledgeState.changes) !== 1) {
          throw new Error(`translation run ${runId} knowledge state mismatch`);
        }
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
      return "promoted";
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

  upsertLexicalConcepts(
    runId: string,
    concepts: readonly LexicalConcept[],
  ): LexicalConceptChange[] {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v4 write upgrade required");
    }
    this.#run(runId);
    if (!Array.isArray(concepts)) {
      throw new TypeError("concepts must be an array");
    }
    const seen = new Set<string>();
    for (const concept of concepts) {
      requireNonempty(concept.conceptId, "conceptId");
      requireNonempty(concept.revisionId, "concept revisionId");
      requireNonempty(concept.normalizedSubject, "concept normalizedSubject");
      requireNonempty(concept.canonicalTarget, "concept canonicalTarget");
      if (seen.has(concept.conceptId)) {
        throw new Error(`duplicate lexical concept ${concept.conceptId}`);
      }
      seen.add(concept.conceptId);
      if (!/^[0-9a-f]{64}$/u.test(concept.renderFingerprint)) {
        throw new TypeError("concept renderFingerprint must be a SHA-256 hash");
      }
      if (!Array.isArray(concept.sourceForms)
        || concept.sourceForms.length === 0
        || concept.sourceForms.some((form: unknown) =>
          typeof form !== "string" || form.trim().length === 0)) {
        throw new TypeError("concept sourceForms must contain nonempty strings");
      }
      if (!Array.isArray(concept.allowedRealizations)
        || concept.allowedRealizations.length === 0
        || concept.allowedRealizations.some((surface: unknown) =>
          typeof surface !== "string" || surface.trim().length === 0)) {
        throw new TypeError(
          "concept allowedRealizations must contain nonempty strings",
        );
      }
    }
    return this.#transaction(() =>
      this.#upsertLexicalConceptRows(runId, concepts));
  }

  activeLexicalConcept(
    runId: string,
    conceptId: string,
  ): StoredLexicalConcept | undefined {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) return undefined;
    this.#run(runId);
    requireNonempty(conceptId, "conceptId");
    const row = one<LexicalConceptRow>(this.#database.prepare(`
      SELECT * FROM lexical_concepts
      WHERE run_id=? AND concept_id=? AND active=1
    `), runId, conceptId);
    return row === undefined ? undefined : lexicalConceptFromRow(row);
  }

  replaceConceptOccurrences(
    runId: string,
    conceptId: string,
    occurrences: readonly ConceptOccurrence[],
  ): void {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v4 write upgrade required");
    }
    const run = this.#run(runId);
    requireNonempty(conceptId, "conceptId");
    if (!Array.isArray(occurrences)) {
      throw new TypeError("occurrences must be an array");
    }
    if (this.activeLexicalConcept(runId, conceptId) === undefined) {
      throw new Error(`unknown active lexical concept ${conceptId}`);
    }
    const normalized = occurrences.map((occurrence) => {
      if (occurrence.conceptId !== conceptId) {
        throw new Error(`occurrence concept mismatch for ${occurrence.blockId}`);
      }
      const blockIdValue = requireNonempty(occurrence.blockId, "occurrence blockId");
      const block = one<{ source_text: string }>(this.#database.prepare(`
        SELECT source_text FROM logical_blocks
        WHERE source_version=? AND block_id=?
      `), run.source_version, blockIdValue);
      if (block === undefined) {
        throw new Error(`unknown occurrence block ${blockIdValue}`);
      }
      if (!Array.isArray(occurrence.sourceSpans)
        || occurrence.sourceSpans.length === 0) {
        throw new Error(`occurrence ${blockIdValue} must contain source spans`);
      }
      const sourceScalars = Array.from(block.source_text);
      const spanKeys = new Set<string>();
      const spans = occurrence.sourceSpans.map((span: ConceptOccurrenceSpan) => {
        requireSafeInteger(span.start, "occurrence start");
        requireSafeInteger(span.end, "occurrence end", 1);
        if (span.end <= span.start || span.end > sourceScalars.length) {
          throw new Error(`invalid occurrence span in block ${blockIdValue}`);
        }
        const sourceForm = requireNonempty(
          span.sourceForm,
          "occurrence sourceForm",
        );
        if (sourceScalars.slice(span.start, span.end).join("") !== sourceForm) {
          throw new Error(`occurrence source form mismatch in block ${blockIdValue}`);
        }
        const key = `${span.start}\0${span.end}`;
        if (spanKeys.has(key)) {
          throw new Error(`duplicate occurrence span in block ${blockIdValue}`);
        }
        spanKeys.add(key);
        return { start: span.start, end: span.end, sourceForm };
      }).sort((
        left: ConceptOccurrenceSpan,
        right: ConceptOccurrenceSpan,
      ) => left.start - right.start || left.end - right.end);
      return {
        conceptId,
        blockId: blockIdValue,
        sourceVersion: run.source_version,
        sourceSpans: spans,
      };
    });
    if (new Set(normalized.map((item) => item.blockId)).size !== normalized.length) {
      throw new Error(`duplicate occurrence block for ${conceptId}`);
    }
    this.#transaction(() => {
      this.#database.prepare(`
        DELETE FROM concept_occurrences WHERE run_id=? AND concept_id=?
      `).run(runId, conceptId);
      const insert = this.#database.prepare(`
        INSERT INTO concept_occurrences(
          run_id, concept_id, source_version, block_id,
          occurrence_count, source_spans_json
        ) VALUES(?, ?, ?, ?, ?, ?)
      `);
      for (const occurrence of normalized) {
        insert.run(
          runId,
          conceptId,
          occurrence.sourceVersion,
          occurrence.blockId,
          occurrence.sourceSpans.length,
          jsonText(occurrence.sourceSpans, "concept occurrence spans"),
        );
      }
    });
  }

  conceptOccurrences(
    runId: string,
    conceptId: string,
  ): StoredConceptOccurrence[] {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) return [];
    this.#run(runId);
    requireNonempty(conceptId, "conceptId");
    return all<{
      source_version: string;
      block_id: string;
      occurrence_count: number;
      source_spans_json: string;
    }>(this.#database.prepare(`
      SELECT source_version, block_id, occurrence_count, source_spans_json
      FROM concept_occurrences
      WHERE run_id=? AND concept_id=?
      ORDER BY block_id
    `), runId, conceptId).map((row) => {
      const spans = JSON.parse(row.source_spans_json) as ConceptOccurrenceSpan[];
      if (!Array.isArray(spans) || spans.length !== row.occurrence_count) {
        throw new Error(`corrupt concept occurrences for ${conceptId}`);
      }
      return {
        conceptId,
        blockId: row.block_id,
        sourceVersion: row.source_version,
        sourceSpans: spans,
      };
    });
  }

  stageWindowConceptBindings(
    runId: string,
    windowId: string,
    usages: readonly TermUsageSubmission[],
    concepts: readonly TermConceptProjection[],
  ): void {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v4 write upgrade required");
    }
    this.#run(runId);
    requireNonempty(windowId, "windowId");
    this.#transaction(() => {
      const window = this.#window(runId, windowId);
      if (window === undefined || window.status !== "staged") {
        throw new Error(`window is not staged: ${runId}/${windowId}`);
      }
      this.#writeWindowConceptBindings(runId, windowId, usages, concepts);
    });
  }

  activeTranslationBindings(
    runId: string,
    blockId: string,
  ): TranslationConceptBinding[] {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) return [];
    this.#run(runId);
    requireNonempty(blockId, "blockId");
    return all<TranslationConceptBindingRow>(this.#database.prepare(`
      SELECT b.*
      FROM translations AS t
      JOIN translation_concept_bindings AS b
        ON b.translation_id=t.translation_id
      WHERE t.run_id=? AND t.block_id=? AND t.active=1
      ORDER BY b.concept_id
    `), runId, blockId).map((row) => ({
      translationId: row.translation_id,
      conceptId: row.concept_id,
      appliedRevisionId: row.applied_revision_id,
      appliedRenderFingerprint: row.applied_render_fingerprint,
      termUsages: termUsagesFromJson(row.term_usages_json),
      validationStatus: row.validation_status,
      validatedRevisionId: row.validated_revision_id,
    }));
  }

  ensureConceptCoverageRevalidationTasks(
    runId: string,
    toSnapshotId: string,
  ): ConceptCoverageRevalidationReport {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v4 write upgrade required");
    }
    const run = this.#run(runId);
    requireNonempty(toSnapshotId, "toSnapshotId");
    const snapshot = one<{ present: number }>(this.#database.prepare(`
      SELECT 1 AS present FROM knowledge_snapshots
      WHERE run_id=? AND snapshot_id=?
    `), runId, toSnapshotId);
    if (snapshot === undefined) {
      throw new Error(`unknown knowledge snapshot ${runId}/${toSnapshotId}`);
    }
    return this.#transaction(() => {
      const concepts = all<LexicalConceptRow>(this.#database.prepare(`
        SELECT * FROM lexical_concepts
        WHERE run_id=? AND active=1
        ORDER BY concept_id
      `), runId).map(lexicalConceptFromRow);
      const sourcePayload = JSON.parse(
        this.#source(run.source_version).source_payload_json,
      ) as { sourceLanguage?: unknown };
      const profile = getSourceLanguageProfile(
        typeof sourcePayload.sourceLanguage === "string"
          ? sourcePayload.sourceLanguage
          : undefined,
      );
      const blocks = all<{ block_id: string; source_text: string }>(
        this.#database.prepare(`
          SELECT block_id, source_text FROM logical_blocks
          WHERE source_version=? ORDER BY global_index
        `),
        run.source_version,
      ).map((block) => ({
        blockId: block.block_id,
        sourceText: block.source_text,
      }));
      const occurrences = buildConceptOccurrenceIndex(
        blocks,
        concepts,
        profile,
      );
      this.#database.prepare(`
        DELETE FROM concept_occurrences WHERE run_id=?
      `).run(runId);
      const insertOccurrence = this.#database.prepare(`
        INSERT INTO concept_occurrences(
          run_id, concept_id, source_version, block_id,
          occurrence_count, source_spans_json
        ) VALUES(?, ?, ?, ?, ?, ?)
      `);
      for (const occurrence of occurrences) {
        insertOccurrence.run(
          runId,
          occurrence.conceptId,
          run.source_version,
          occurrence.blockId,
          occurrence.sourceSpans.length,
          jsonText(occurrence.sourceSpans, "concept occurrence spans"),
        );
      }
      const occurrenceKeys = new Set(occurrences.map((occurrence) =>
        `${occurrence.conceptId}\0${occurrence.blockId}`));
      const openTasks = all<KnowledgeRevalidationTaskRow>(
        this.#database.prepare(`
          SELECT * FROM knowledge_revalidation_tasks
          WHERE run_id=? AND status IN ('pending','validating')
          ORDER BY created_at, task_id
        `),
        runId,
      ).map(revalidationTaskFromRow);
      for (const task of openTasks) {
        if (task.conceptIds.every((conceptId) =>
          occurrenceKeys.has(`${conceptId}\0${task.blockId}`))) {
          continue;
        }
        for (const conceptId of task.conceptIds) {
          this.#database.prepare(`
            DELETE FROM translation_concept_bindings
            WHERE translation_id=? AND concept_id=?
              AND term_usages_json='[]'
              AND validation_status IN ('stale','validating')
          `).run(task.translationId, conceptId);
        }
        const retired = this.#database.prepare(`
          UPDATE knowledge_revalidation_tasks
          SET status='resolved_noop', result_json=?, resolved_at=datetime('now')
          WHERE run_id=? AND task_id=? AND status IN ('pending','validating')
        `).run(
          jsonText(
            { reason: "source_occurrence_obsolete" },
            "revalidation result",
          ),
          runId,
          task.taskId,
        );
        if (Number(retired.changes) === 1) {
          this.#appendEvent(runId, "sparse_revalidation_resolved_noop", {
            runId,
            taskId: task.taskId,
            reason: "source_occurrence_obsolete",
          });
        }
      }
      this.#database.prepare(`
        DELETE FROM translation_concept_bindings
        WHERE translation_id IN (
          SELECT translation_id FROM translations
          WHERE run_id=? AND active=1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM translations AS translation
          JOIN concept_occurrences AS occurrence
            ON occurrence.run_id=translation.run_id
           AND occurrence.block_id=translation.block_id
           AND occurrence.concept_id=translation_concept_bindings.concept_id
          WHERE translation.translation_id=
            translation_concept_bindings.translation_id
        )
      `).run(runId);
      return this.#createSparseRevalidationTasks(
        runId,
        concepts,
        occurrences,
        toSnapshotId,
      );
    });
  }

  revalidationTasks(runId: string): KnowledgeRevalidationTask[] {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) return [];
    this.#run(runId);
    return all<KnowledgeRevalidationTaskRow>(this.#database.prepare(`
      SELECT * FROM knowledge_revalidation_tasks
      WHERE run_id=? ORDER BY created_at, task_id
    `), runId).map(revalidationTaskFromRow);
  }

  claimRevalidationTask(
    runId: string,
    taskId: string,
    maxAttempts = DEFAULT_MAX_REVALIDATION_ATTEMPTS,
    expectedAttempts = 0,
  ): KnowledgeRevalidationTask | undefined {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) return undefined;
    this.#run(runId);
    requireNonempty(taskId, "taskId");
    requireSafeInteger(maxAttempts, "maxAttempts", 1);
    requireSafeInteger(expectedAttempts, "expectedAttempts");
    return this.#transaction(() => {
      const row = one<KnowledgeRevalidationTaskRow & { translation_active: number }>(
        this.#database.prepare(`
          SELECT task.*, translation.active AS translation_active
          FROM knowledge_revalidation_tasks AS task
          JOIN translations AS translation
            ON translation.translation_id=task.translation_id
          WHERE task.run_id=? AND task.task_id=?
        `),
        runId,
        taskId,
      );
      if (row === undefined
        || row.attempts !== expectedAttempts
        || (row.status !== "pending" && row.status !== "validating")) {
        return undefined;
      }
      const task = revalidationTaskFromRow(row);
      if (row.translation_active === 0) {
        this.#finishRevalidationTask(
          task,
          "resolved_noop",
          { reason: "translation_superseded" },
          null,
          "clean",
        );
        return undefined;
      }
      if (row.attempts >= maxAttempts) {
        if (row.status === "validating") {
          this.#finishRevalidationTask(
            task,
            "completed_with_warning",
            { code: "REVALIDATION_ATTEMPTS_EXHAUSTED" },
            null,
            "warning_stale",
          );
        }
        return undefined;
      }
      const claimed = this.#database.prepare(`
        UPDATE knowledge_revalidation_tasks
        SET status='validating', attempts=attempts+1
        WHERE run_id=? AND task_id=?
          AND status IN ('pending','validating') AND attempts=?
      `).run(runId, taskId, row.attempts);
      if (Number(claimed.changes) !== 1) {
        return undefined;
      }
      const result = this.#revalidationTask(runId, taskId);
      for (const conceptId of result.conceptIds) {
        this.#database.prepare(`
          UPDATE translation_concept_bindings
          SET validation_status='validating', updated_at=datetime('now')
          WHERE translation_id=? AND concept_id=?
        `).run(result.translationId, conceptId);
      }
      this.#appendEvent(runId, "sparse_revalidation_claimed", {
        runId,
        taskId: result.taskId,
        attempt: result.attempts,
      });
      return result;
    });
  }

  claimNextRevalidationTask(
    runId: string,
    maxAttempts = DEFAULT_MAX_REVALIDATION_ATTEMPTS,
  ): KnowledgeRevalidationTask | undefined {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) return undefined;
    this.#run(runId);
    requireSafeInteger(maxAttempts, "maxAttempts", 1);
    return this.#transaction(() => {
      const abandoned = all<KnowledgeRevalidationTaskRow>(
        this.#database.prepare(`
          SELECT task.*
          FROM knowledge_revalidation_tasks AS task
          JOIN translations AS translation
            ON translation.translation_id=task.translation_id
          WHERE task.run_id=?
            AND task.status IN ('pending','validating')
            AND translation.active=0
          ORDER BY task.created_at, task.task_id
        `),
        runId,
      );
      for (const row of abandoned) {
        this.#finishRevalidationTask(
          revalidationTaskFromRow(row),
          "resolved_noop",
          { reason: "translation_superseded" },
          null,
          "clean",
        );
      }

      const exhausted = all<KnowledgeRevalidationTaskRow>(
        this.#database.prepare(`
          SELECT task.*
          FROM knowledge_revalidation_tasks AS task
          JOIN translations AS translation
            ON translation.translation_id=task.translation_id
          WHERE task.run_id=? AND task.status='validating'
            AND task.attempts>=? AND translation.active=1
          ORDER BY task.created_at, task.task_id
        `),
        runId,
        maxAttempts,
      );
      for (const row of exhausted) {
        this.#finishRevalidationTask(
          revalidationTaskFromRow(row),
          "completed_with_warning",
          { code: "REVALIDATION_ATTEMPTS_EXHAUSTED" },
          null,
          "warning_stale",
        );
      }

      const row = one<KnowledgeRevalidationTaskRow>(
        this.#database.prepare(`
          SELECT task.*
          FROM knowledge_revalidation_tasks AS task
          JOIN translations AS translation
            ON translation.translation_id=task.translation_id
          WHERE task.run_id=?
            AND task.status IN ('pending','validating')
            AND task.attempts<?
            AND translation.active=1
          ORDER BY task.created_at, task.task_id
          LIMIT 1
        `),
        runId,
        maxAttempts,
      );
      if (row === undefined) return undefined;
      const claimed = this.#database.prepare(`
        UPDATE knowledge_revalidation_tasks
        SET status='validating', attempts=attempts+1
        WHERE run_id=? AND task_id=?
          AND status IN ('pending','validating') AND attempts=?
      `).run(runId, row.task_id, row.attempts);
      if (Number(claimed.changes) !== 1) {
        throw new Error(`failed to claim revalidation task ${row.task_id}`);
      }
      const task = this.#revalidationTask(runId, row.task_id);
      for (const conceptId of task.conceptIds) {
        this.#database.prepare(`
          UPDATE translation_concept_bindings
          SET validation_status='validating', updated_at=datetime('now')
          WHERE translation_id=? AND concept_id=?
        `).run(task.translationId, conceptId);
      }
      this.#appendEvent(runId, "sparse_revalidation_claimed", {
        runId,
        taskId: task.taskId,
        attempt: task.attempts,
      });
      return task;
    });
  }

  revalidationWorkItem(
    runId: string,
    taskId: string,
  ): RevalidationWorkItem {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v4 write upgrade required");
    }
    this.#run(runId);
    requireNonempty(taskId, "taskId");
    const task = this.#revalidationTask(runId, taskId);
    if (task.status !== "validating") {
      throw new Error(`revalidation task is not validating: ${taskId}`);
    }
    const translation = one<{
      translation_id: number;
      run_id: string;
      window_id: string;
      block_id: string;
      source_version: string;
      source_hash: string;
      text: string;
      result_status: ActiveLosslessTranslation["status"];
      version: number;
      snapshot_id: string;
      source_text: string;
      global_index: number;
      token_count: number;
    }>(this.#database.prepare(`
      SELECT t.translation_id, t.run_id, t.window_id, t.block_id,
             t.source_version, t.source_hash, t.text, t.result_status,
             t.version, t.snapshot_id, b.source_text, b.global_index,
             b.token_count
      FROM translations AS t
      JOIN logical_blocks AS b
        ON b.source_version=t.source_version AND b.block_id=t.block_id
      WHERE t.translation_id=? AND t.run_id=? AND t.active=1
    `), task.translationId, runId);
    if (translation === undefined || translation.block_id !== task.blockId) {
      throw new Error(`revalidation task translation is no longer active: ${taskId}`);
    }
    const window = this.#window(runId, translation.window_id);
    if (window === undefined) {
      throw new Error(`revalidation task window is missing: ${taskId}`);
    }
    const bindingRows = all<TranslationConceptBindingRow>(
      this.#database.prepare(`
        SELECT * FROM translation_concept_bindings
        WHERE translation_id=? ORDER BY concept_id
      `),
      task.translationId,
    );
    const bindingByConcept = new Map(bindingRows.map((binding) => [
      binding.concept_id,
      binding,
    ]));
    const concepts = task.conceptIds.map((conceptId): RevalidationConceptState => {
      const binding = bindingByConcept.get(conceptId);
      if (binding === undefined) {
        throw new Error(`revalidation binding is missing: ${taskId}/${conceptId}`);
      }
      const applied = one<LexicalConceptRow>(this.#database.prepare(`
        SELECT * FROM lexical_concepts
        WHERE run_id=? AND concept_id=? AND revision_id=?
      `), runId, conceptId, binding.applied_revision_id);
      const current = one<LexicalConceptRow>(this.#database.prepare(`
        SELECT * FROM lexical_concepts
        WHERE run_id=? AND concept_id=? AND active=1
      `), runId, conceptId);
      if (applied === undefined || current === undefined) {
        throw new Error(`revalidation concept revision is missing: ${taskId}/${conceptId}`);
      }
      return {
        conceptId,
        appliedConcept: lexicalConceptFromRow(applied),
        currentConcept: lexicalConceptFromRow(current),
        termUsages: termUsagesFromJson(binding.term_usages_json),
      };
    });
    return {
      task,
      translation: {
        translationId: translation.translation_id,
        runId: translation.run_id,
        windowId: translation.window_id,
        blockId: translation.block_id,
        sourceVersion: translation.source_version,
        sourceHash: translation.source_hash,
        text: translation.text,
        status: translation.result_status,
        version: translation.version,
        snapshotId: translation.snapshot_id,
      },
      source: {
        blockId: translation.block_id,
        sourceVersion: translation.source_version,
        sourceHash: translation.source_hash,
        sourceText: translation.source_text,
        globalIndex: translation.global_index,
        tokenCount: translation.token_count,
      },
      window,
      concepts,
    };
  }

  resolveRevalidationNoop(
    runId: string,
    taskId: string,
    result: unknown,
  ): void {
    requireNonempty(runId, "runId");
    requireNonempty(taskId, "taskId");
    const resultJson = jsonText(result, "revalidation result");
    this.#transaction(() => {
      const work = this.revalidationWorkItem(runId, taskId);
      const decision = evaluateRevalidationBindings(work.concepts);
      if (decision.action !== "noop") {
        throw new Error(`revalidation task ${taskId} is not a local noop`);
      }
      for (const state of work.concepts) {
        const updated = this.#database.prepare(`
          UPDATE translation_concept_bindings
          SET applied_revision_id=?, applied_render_fingerprint=?,
              validation_status='clean', validated_revision_id=?,
              updated_at=datetime('now')
          WHERE translation_id=? AND concept_id=?
        `).run(
          state.currentConcept.revisionId,
          state.currentConcept.renderFingerprint,
          state.currentConcept.revisionId,
          work.translation.translationId,
          state.conceptId,
        );
        if (Number(updated.changes) !== 1) {
          throw new Error(`failed to resolve revalidation binding ${state.conceptId}`);
        }
      }
      const completed = this.#database.prepare(`
        UPDATE knowledge_revalidation_tasks
        SET status='resolved_noop', result_json=?, resolved_at=datetime('now')
        WHERE run_id=? AND task_id=? AND status='validating'
      `).run(resultJson, runId, taskId);
      if (Number(completed.changes) !== 1) {
        throw new Error(`failed to resolve revalidation task ${taskId}`);
      }
      this.#appendEvent(runId, "sparse_revalidation_resolved_noop", {
        runId,
        taskId,
      });
    });
  }

  replaceTranslationForRevalidation(
    input: RevalidationReplacementInput,
  ): number {
    requireNonempty(input.runId, "runId");
    requireNonempty(input.taskId, "taskId");
    requireNonempty(input.snapshotId, "snapshotId");
    requireNonempty(input.text, "revalidation translation text");
    if (input.action !== "repair" && input.action !== "retranslate") {
      throw new TypeError("revalidation action must be repair or retranslate");
    }
    if (input.resultStatus !== "completed"
      && input.resultStatus !== "completed_with_warnings") {
      throw new TypeError("invalid revalidation result status");
    }
    const resultJson = jsonText(input.result, "revalidation result");
    return this.#transaction(() => {
      const work = this.revalidationWorkItem(input.runId, input.taskId);
      const snapshot = one<{ present: number }>(this.#database.prepare(`
        SELECT 1 AS present FROM knowledge_snapshots
        WHERE run_id=? AND snapshot_id=?
      `), input.runId, input.snapshotId);
      if (snapshot === undefined) {
        throw new Error(
          `revalidation snapshot does not belong to run ${input.runId}`,
        );
      }
      const decision = evaluateRevalidationBindings(work.concepts);
      if (decision.action !== input.action) {
        throw new Error(
          `revalidation action mismatch: expected ${decision.action}, got ${input.action}`,
        );
      }
      const currentById = new Map(input.concepts.map((concept) => [
        concept.conceptId,
        concept,
      ]));
      for (const concept of input.concepts) {
        const active = this.activeLexicalConcept(input.runId, concept.conceptId);
        if (active === undefined
          || active.revisionId !== concept.revisionId
          || active.renderFingerprint !== concept.renderFingerprint) {
          throw new Error(
            `replacement uses a stale lexical concept ${concept.conceptId}`,
          );
        }
      }
      for (const conceptId of work.task.conceptIds) {
        if (!currentById.has(conceptId)) {
          throw new Error(`replacement omitted changed concept ${conceptId}`);
        }
      }
      const run = this.#run(input.runId);
      const sourcePayload = JSON.parse(
        this.#source(run.source_version).source_payload_json,
      ) as { sourceLanguage?: unknown };
      const profile = getSourceLanguageProfile(
        typeof sourcePayload.sourceLanguage === "string"
          ? sourcePayload.sourceLanguage
          : undefined,
      );
      const expected = expectedTermOccurrences(
        [{ id: work.source.blockId, sourceText: work.source.sourceText }],
        input.concepts,
        profile,
      );
      const failures = validateTermUsages(
        expected,
        input.termUsages,
        { [work.source.blockId]: input.text },
      );
      if (failures.length > 0) {
        throw new Error(
          `replacement term usage validation failed: ${failures
            .map((failure) => failure.code)
            .join(",")}`,
        );
      }
      for (const conceptId of work.task.conceptIds) {
        if (!expected.some((occurrence) => occurrence.conceptId === conceptId)) {
          throw new Error(`replacement source occurrence missing for ${conceptId}`);
        }
      }
      const staged = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM translations
        WHERE run_id=? AND window_id=? AND stage_state='staged' AND active=0
      `), input.runId, work.translation.windowId)?.count ?? 0;
      if (staged !== 0) {
        throw new Error(
          `revalidation window already contains staged translations: ${work.translation.windowId}`,
        );
      }
      if (work.window.status !== "completed"
        && work.window.status !== "completed_with_warnings") {
        throw new Error(
          `revalidation window is not committed: ${work.translation.windowId}`,
        );
      }
      const effectiveResultStatus =
        work.window.status === "completed_with_warnings"
        || input.resultStatus === "completed_with_warnings"
          ? "completed_with_warnings"
          : "completed";
      const inserted = this.#database.prepare(`
        INSERT INTO translations(
          run_id, window_id, source_version, block_id, version, source_hash,
          text, result_status, stage_state, active, snapshot_id
        ) VALUES(?, ?, ?, ?,
          COALESCE((
            SELECT MAX(version)+1 FROM translations
            WHERE run_id=? AND block_id=?
          ), 1),
          ?, ?, ?, 'staged', 0, ?)
      `).run(
        input.runId,
        work.translation.windowId,
        work.source.sourceVersion,
        work.source.blockId,
        input.runId,
        work.source.blockId,
        work.source.sourceHash,
        input.text,
        effectiveResultStatus,
        input.snapshotId,
      );
      const replacementTranslationId = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(replacementTranslationId)
        || replacementTranslationId < 1) {
        throw new Error(`failed to insert revalidation replacement ${input.taskId}`);
      }
      this.#writeWindowConceptBindings(
        input.runId,
        work.translation.windowId,
        input.termUsages,
        input.concepts,
      );
      const insertCoverageBinding = this.#database.prepare(`
        INSERT OR IGNORE INTO translation_concept_bindings(
          translation_id, concept_id, applied_revision_id,
          applied_render_fingerprint, term_usages_json, validation_status,
          validated_revision_id
        ) VALUES(?, ?, ?, ?, '[]', 'clean', ?)
      `);
      for (const conceptId of [...new Set(
        expected.map((occurrence) => occurrence.conceptId),
      )].sort(compareText)) {
        const concept = currentById.get(conceptId);
        if (concept === undefined) {
          throw new Error(
            `replacement occurrence references unknown concept ${conceptId}`,
          );
        }
        insertCoverageBinding.run(
          replacementTranslationId,
          concept.conceptId,
          concept.revisionId,
          concept.renderFingerprint,
          concept.revisionId,
        );
      }
      const deactivated = this.#database.prepare(`
        UPDATE translations SET active=0
        WHERE translation_id=? AND run_id=? AND active=1
      `).run(work.translation.translationId, input.runId);
      if (Number(deactivated.changes) !== 1) {
        throw new Error(`active translation changed during revalidation ${input.taskId}`);
      }
      const activated = this.#database.prepare(`
        UPDATE translations SET active=1, stage_state='promoted'
        WHERE translation_id=? AND run_id=? AND active=0 AND stage_state='staged'
      `).run(replacementTranslationId, input.runId);
      if (Number(activated.changes) !== 1) {
        throw new Error(`failed to activate revalidation replacement ${input.taskId}`);
      }
      if (effectiveResultStatus !== work.window.status) {
        const updatedWindow = this.#database.prepare(`
          UPDATE window_plans SET status=?
          WHERE run_id=? AND window_id=? AND status=?
        `).run(
          effectiveResultStatus,
          input.runId,
          work.translation.windowId,
          work.window.status,
        );
        if (Number(updatedWindow.changes) !== 1) {
          throw new Error(
            `revalidation window status changed concurrently: ${work.translation.windowId}`,
          );
        }
        this.#database.prepare(`
          UPDATE translations SET result_status=?
          WHERE run_id=? AND window_id=? AND active=1
        `).run(
          effectiveResultStatus,
          input.runId,
          work.translation.windowId,
        );
      }
      const terminalStatus = input.action === "repair"
        ? "resolved_repair"
        : "resolved_retranslate";
      const completed = this.#database.prepare(`
        UPDATE knowledge_revalidation_tasks
        SET status=?, result_json=?, replacement_translation_id=?,
            resolved_at=datetime('now')
        WHERE run_id=? AND task_id=? AND status='validating'
      `).run(
        terminalStatus,
        resultJson,
        replacementTranslationId,
        input.runId,
        input.taskId,
      );
      if (Number(completed.changes) !== 1) {
        throw new Error(`failed to complete revalidation task ${input.taskId}`);
      }
      this.#appendEvent(input.runId, "sparse_revalidation_replaced", {
        runId: input.runId,
        taskId: input.taskId,
        action: input.action,
        oldTranslationId: work.translation.translationId,
        replacementTranslationId,
      });
      return replacementTranslationId;
    });
  }

  completeRevalidationWithWarning(
    runId: string,
    taskId: string,
    result: unknown,
  ): void {
    requireNonempty(runId, "runId");
    requireNonempty(taskId, "taskId");
    this.#transaction(() => {
      const task = this.#revalidationTask(runId, taskId);
      if (task.status !== "validating") {
        throw new Error(`revalidation task is not validating: ${taskId}`);
      }
      this.#finishRevalidationTask(
        task,
        "completed_with_warning",
        result,
        null,
        "warning_stale",
      );
      this.#appendEvent(runId, "sparse_revalidation_warning", {
        runId,
        taskId,
      });
    });
  }

  deferRevalidationTask(
    runId: string,
    taskId: string,
    result: unknown,
  ): void {
    requireNonempty(runId, "runId");
    requireNonempty(taskId, "taskId");
    const resultJson = jsonText(result, "revalidation defer result");
    this.#transaction(() => {
      const task = this.#revalidationTask(runId, taskId);
      if (task.status !== "validating" || task.attempts < 1) {
        throw new Error(`revalidation task is not deferrable: ${taskId}`);
      }
      for (const conceptId of task.conceptIds) {
        this.#database.prepare(`
          UPDATE translation_concept_bindings
          SET validation_status='stale', updated_at=datetime('now')
          WHERE translation_id=? AND concept_id=?
            AND validation_status='validating'
        `).run(task.translationId, conceptId);
      }
      const deferred = this.#database.prepare(`
        UPDATE knowledge_revalidation_tasks
        SET status='pending', attempts=attempts-1, result_json=?,
            resolved_at=NULL
        WHERE run_id=? AND task_id=? AND status='validating' AND attempts>0
      `).run(resultJson, runId, taskId);
      if (Number(deferred.changes) !== 1) {
        throw new Error(`failed to defer revalidation task ${taskId}`);
      }
      this.#appendEvent(runId, "sparse_revalidation_deferred", {
        runId,
        taskId,
        result,
      });
    });
  }

  knowledgeState(runId: string): KnowledgeStateView {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v3 write upgrade required");
    }
    this.#run(runId);
    const state = one<KnowledgeStateRow>(this.#database.prepare(`
      SELECT generation, applied_book_generation, applied_project_generation
      FROM knowledge_state WHERE run_id=?
    `), runId);
    if (state === undefined) {
      throw new Error("schema v3 write upgrade required");
    }
    const snapshot = one<{ snapshot_id: string }>(this.#database.prepare(`
      SELECT snapshot_id FROM knowledge_snapshots
      WHERE run_id=? ORDER BY rowid DESC LIMIT 1
    `), runId);
    if (snapshot === undefined) {
      throw new Error(`translation run ${runId} has no knowledge snapshot`);
    }
    return {
      generation: requireSafeInteger(state.generation, "knowledge generation"),
      snapshotId: snapshot.snapshot_id,
      appliedBookGeneration: requireSafeInteger(
        state.applied_book_generation,
        "applied book generation",
      ),
      appliedProjectGeneration: requireSafeInteger(
        state.applied_project_generation,
        "applied project generation",
      ),
    };
  }

  syncScopedKnowledge(runId: string): ScopedKnowledgeSyncResult {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v3 write upgrade required");
    }
    return this.#transaction(() => {
      const run = this.#run(runId);
      const state = this.knowledgeState(runId);
      const bookGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `),
        run.source_version,
      )?.generation;
      const projectGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `),
      )?.generation;
      if (bookGeneration === undefined || projectGeneration === undefined) {
        throw new Error("schema v3 knowledge generation state is incomplete");
      }
      if (state.appliedBookGeneration > bookGeneration
        || state.appliedProjectGeneration > projectGeneration) {
        throw new Error(`translation run ${runId} knowledge state mismatch`);
      }
      if (state.appliedBookGeneration === bookGeneration
        && state.appliedProjectGeneration === projectGeneration) {
        return {
          changed: false,
          generation: state.generation,
          snapshotId: state.snapshotId,
          appliedBookGeneration: state.appliedBookGeneration,
          appliedProjectGeneration: state.appliedProjectGeneration,
        };
      }

      const busy = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM window_plans
        WHERE run_id=? AND status IN ('running', 'staged')
      `), runId)?.count ?? 0;
      if (busy > 0) {
        throw new Error(
          "KNOWLEDGE_EDIT_BUSY: wait for the active translation window to finish",
        );
      }

      const domain = new KnowledgeStore(this.knowledgeRevisions(runId));
      const desired = this.#catalogSeedRevisions(runId, run.source_version);
      const desiredKeys = new Set(desired.map((revision) =>
        knowledgeKey(revision.normalizedSubject, revision.kind)));
      for (const catalogRevision of desired) {
        const current = domain.latestRevision(
          catalogRevision.normalizedSubject,
          catalogRevision.kind,
        );
        const desiredProvenance = catalogRevision.authority?.provenance;
        const currentProvenance = current?.authority?.provenance;
        if (desiredProvenance !== undefined
          && currentProvenance?.catalog === desiredProvenance.catalog
          && currentProvenance.catalogRevisionId
            === desiredProvenance.catalogRevisionId) {
          continue;
        }
        const appended = domain.appendRevision({
          normalizedSubject: catalogRevision.normalizedSubject,
          kind: catalogRevision.kind,
          payload: catalogRevision.payload,
          alternatives: catalogRevision.alternatives,
          status: catalogRevision.status,
          candidateIds: current?.candidateIds ?? catalogRevision.candidateIds,
          sourceWindowIds:
            current?.sourceWindowIds ?? catalogRevision.sourceWindowIds,
          authority: catalogRevision.authority,
        });
        this.#insertRunKnowledgeRevision(
          runId,
          appended,
          null,
          this.#catalogEvidenceForRevision(appended),
          undefined,
        );
        this.#insertKnowledgeImpactsForRevision(run, appended);
      }
      for (const current of domain.projectableRevisions()) {
        if (current.authority?.provenance === undefined
          || desiredKeys.has(knowledgeKey(
            current.normalizedSubject,
            current.kind,
          ))) {
          continue;
        }
        const superseded = domain.appendRevision({
          normalizedSubject: current.normalizedSubject,
          kind: current.kind,
          payload: current.payload,
          alternatives: current.alternatives,
          status: "superseded",
          candidateIds: current.candidateIds,
          sourceWindowIds: current.sourceWindowIds,
          authority: current.authority,
        });
        this.#insertRunKnowledgeRevision(
          runId,
          superseded,
          null,
          this.#catalogEvidenceForRevision(superseded),
          undefined,
        );
        this.#insertKnowledgeImpactsForRevision(run, superseded);
      }

      const parentSnapshot = this.latestKnowledgeSnapshot(runId);
      const snapshot = createKnowledgeSnapshot(
        runId,
        domain.projectableRevisions(),
        parentSnapshot.id,
      );
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, parent_snapshot_id, producing_window_id,
          content_hash, payload_json
        ) VALUES(?, ?, ?, NULL, ?, ?)
      `).run(
        runId,
        snapshot.id,
        parentSnapshot.id,
        snapshot.contentHash,
        jsonText(snapshot, "scoped knowledge synchronization snapshot"),
      );

      const generation = state.generation + 1;
      const updated = this.#database.prepare(`
        UPDATE knowledge_state
        SET generation=?, applied_book_generation=?,
            applied_project_generation=?, updated_at=datetime('now')
        WHERE run_id=? AND generation=? AND applied_book_generation=?
          AND applied_project_generation=?
      `).run(
        generation,
        bookGeneration,
        projectGeneration,
        runId,
        state.generation,
        state.appliedBookGeneration,
        state.appliedProjectGeneration,
      );
      if (Number(updated.changes) !== 1) {
        throw new Error("KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed");
      }
      this.#appendEvent(runId, "knowledge_scope_synchronized", {
        generation,
        snapshotId: snapshot.id,
        previousBookGeneration: state.appliedBookGeneration,
        previousProjectGeneration: state.appliedProjectGeneration,
        bookGeneration,
        projectGeneration,
      });
      return {
        changed: true,
        generation,
        snapshotId: snapshot.id,
        appliedBookGeneration: bookGeneration,
        appliedProjectGeneration: projectGeneration,
      };
    });
  }

  knowledgeQuerySource(runId: string): KnowledgeQuerySource {
    const run = this.#run(runId);
    const state = this.knowledgeState(runId);
    const generation = this.#knowledgeQueryGeneration(run, state);
    let legacyRecords: readonly KnowledgeQueryRecord[] | undefined;
    const requireCurrentGeneration = (): void => {
      const currentRun = this.#run(runId);
      const current = this.#knowledgeQueryGeneration(
        currentRun,
        this.knowledgeState(runId),
      );
      if (current !== generation) {
        throw new Error("KNOWLEDGE_QUERY_SOURCE_STALE");
      }
    };
    return Object.freeze({
      generation,
      listKnowledgeRecords: () => {
        requireCurrentGeneration();
        if (legacyRecords === undefined) {
          const summaries: KnowledgeQueryRecord[] = [];
          let after: KnowledgeRecordPageQuery["after"];
          while (true) {
            const page = this.#queryKnowledgeRecordsPage(run, {
              search: null,
              objectTypes: [],
              statuses: [],
              origins: [],
              scopes: [],
              ...(after === undefined ? {} : { after }),
              limit: 201,
            });
            const visible = page.slice(0, 200);
            for (const summary of visible) {
              const detail = this.#knowledgeQueryRecord(run, summary.id);
              if (detail !== undefined) summaries.push(detail);
            }
            if (page.length <= 200 || visible.length === 0) break;
            const last = visible.at(-1)!;
            after = {
              normalizedSubject: last.revision.normalizedSubject,
              kind: last.revision.kind,
              id: last.id,
            };
          }
          legacyRecords = Object.freeze(summaries);
        }
        return legacyRecords;
      },
      queryKnowledgeRecords: (query: KnowledgeRecordPageQuery) => {
        requireCurrentGeneration();
        return this.#queryKnowledgeRecordsPage(run, query);
      },
      knowledgeRecord: (id: string) => {
        requireCurrentGeneration();
        return this.#knowledgeQueryRecord(run, id);
      },
      knowledgeRecordBySubject: (
        normalizedSubject: string,
        kind: string,
      ) => {
        requireCurrentGeneration();
        requireNonempty(normalizedSubject, "normalizedSubject");
        requireNonempty(kind, "kind");
        return this.#knowledgeQueryRecord(
          run,
          knowledgeRecordId(normalizedSubject, kind),
        );
      },
      relatedKnowledgeRecords: (
        identifiers: readonly string[],
        limit: number,
      ) => {
        requireCurrentGeneration();
        return this.#relatedKnowledgeRecords(run, identifiers, limit);
      },
      knowledgeDiagnostics: () => {
        requireCurrentGeneration();
        return this.#knowledgeDiagnostics(run);
      },
    });
  }

  stageKnowledgeImport(
    input: PersistKnowledgeImportStageInput,
  ): StagedImportReport {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v3 write upgrade required");
    }
    requireNonempty(input.runId, "runId");
    requireNonempty(input.batchId, "batchId");
    requireNonempty(input.sourceName, "sourceName");
    if (input.sourceName.includes("/") || input.sourceName.includes("\\")) {
      throw new Error("KNOWLEDGE_IMPORT_SOURCE_NAME_INVALID");
    }
    if (!/^[0-9a-f]{64}$/u.test(input.sourceHash)
      || !/^[0-9a-f]{64}$/u.test(input.mappingHash)) {
      throw new Error("KNOWLEDGE_IMPORT_IDENTITY_INVALID");
    }
    const parsedMapping = JSON.parse(input.mappingJson) as unknown;
    if (canonicalJson(parsedMapping) !== input.mappingJson) {
      throw new Error("KNOWLEDGE_IMPORT_MAPPING_NOT_CANONICAL");
    }
    return this.#transaction(() => {
      const duplicateByBatch = this.#knowledgeImportBatch(
        input.runId,
        input.batchId,
      );
      const duplicateByIdentity = one<KnowledgeImportBatchRow>(
        this.#database.prepare(`
          SELECT * FROM knowledge_import_batches
          WHERE run_id=? AND source_hash=? AND mapping_hash=?
            AND status IN ('staged', 'committed')
          ORDER BY created_at DESC, batch_id DESC
          LIMIT 1
        `),
        input.runId,
        input.sourceHash,
        input.mappingHash,
      );
      const existing = duplicateByBatch ?? duplicateByIdentity;
      if (existing !== undefined) {
        if (existing.source_hash !== input.sourceHash
          || existing.source_format !== input.sourceFormat
          || existing.mapping_hash !== input.mappingHash
          || existing.mapping_json !== input.mappingJson) {
          throw new Error("KNOWLEDGE_IMPORT_IDENTITY_CONFLICT");
        }
        if (existing.status === "staged") {
          return this.#stagedImportReport(input.runId, existing.batch_id, {
            limit: MAX_STAGED_IMPORT_PAGE_SIZE,
          });
        }
        if (existing.status === "committed") {
          throw new Error("KNOWLEDGE_IMPORT_ALREADY_COMMITTED");
        }
        throw new Error("KNOWLEDGE_IMPORT_BATCH_NOT_STAGED");
      }

      const run = this.#run(input.runId);
      const state = this.knowledgeState(input.runId);
      if (state.generation !== input.request.expectedGeneration
        || state.snapshotId !== input.request.expectedSnapshotId) {
        throw new Error(
          "KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed; inspect again",
        );
      }
      const active = new KnowledgeStore(this.knowledgeRevisions(input.runId))
        .projectableRevisions();
      const simulated = new Map<string, ExistingImportKnowledge>();
      for (const revision of active) {
        const key = importIdentityKey(
          revision.normalizedSubject,
          revision.kind,
        );
        const candidate: ExistingImportKnowledge = {
          id: knowledgeRecordId(
            revision.normalizedSubject,
            revision.kind,
          ),
          objectType: knowledgeObjectType(revision),
          normalizedSubject: revision.normalizedSubject,
          kind: revision.kind,
          payload: validateKnowledgePayload(
            knowledgeObjectType(revision),
            revision.payload,
          ),
        };
        const previous = simulated.get(key);
        if (previous !== undefined
          && canonicalJson(previous) !== canonicalJson(candidate)) {
          throw new Error(`KNOWLEDGE_AUTHORITY_CONFLICT: ${key}`);
        }
        simulated.set(key, candidate);
      }

      const insertBatch = this.#database.prepare(`
        INSERT INTO knowledge_import_batches(
          run_id, batch_id, source_hash, source_name, source_format,
          mapping_json, mapping_hash, status, report_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'staged', '{}')
      `);
      insertBatch.run(
        input.runId,
        input.batchId,
        input.sourceHash,
        input.sourceName,
        input.sourceFormat,
        input.mappingJson,
        input.mappingHash,
      );
      const insertRow = this.#database.prepare(`
        INSERT INTO knowledge_import_rows(
          run_id, batch_id, row_ordinal, state, normalized_json,
          diagnostics_json, decision_json
        ) VALUES(?, ?, ?, ?, ?, ?, NULL)
      `);
      const ordinals = new Set<number>();
      for (const prepared of input.records) {
        const ordinal = prepared.state === "normalized"
          ? prepared.record.ordinal
          : prepared.ordinal;
        if (!Number.isSafeInteger(ordinal) || ordinal < 0
          || ordinals.has(ordinal)) {
          throw new Error("KNOWLEDGE_IMPORT_ROW_ORDINAL_INVALID");
        }
        ordinals.add(ordinal);
        if (prepared.state === "invalid") {
          const persisted: StoredNormalizedImportRow = {
            state: "invalid",
            prepared,
            classification: {
              allowedDecisions: Object.freeze(["skip"]),
            },
            displayFields: Object.freeze({}),
          };
          insertRow.run(
            input.runId,
            input.batchId,
            ordinal,
            "invalid",
            canonicalJson(persisted),
            canonicalJson(prepared.diagnostics),
          );
          continue;
        }
        const incomingRecord = prepared.record;
        const key = importIdentityKey(
          incomingRecord.command.normalizedSubject,
          incomingRecord.command.kind,
        );
        const current = simulated.get(key);
        const record = bindImportRecordIdentity(incomingRecord, current);
        const canonicalPrepared: PreparedImportRecord = record === incomingRecord
          ? prepared
          : Object.freeze({ state: "normalized", record });
        const classification = classifyImport(current, record);
        const persisted: StoredNormalizedImportRow = {
          state: classification.state,
          prepared: canonicalPrepared,
          classification: {
            allowedDecisions: classification.allowedDecisions,
            ...(classification.conflictSignature === undefined
              ? {}
              : { conflictSignature: classification.conflictSignature }),
          },
          displayFields: Object.freeze({ ...record.command.fieldPatch }),
        };
        insertRow.run(
          input.runId,
          input.batchId,
          ordinal,
          classification.state,
          canonicalJson(persisted),
          canonicalJson(classification.diagnostics),
        );
        if (classification.state === "ready"
          || classification.state === "merge") {
          simulated.set(key, {
            id: current?.id ?? knowledgeRecordId(
              record.command.normalizedSubject,
              record.command.kind,
            ),
            objectType: record.command.objectType,
            normalizedSubject: record.command.normalizedSubject,
            kind: record.command.kind,
            payload: validateKnowledgePayload(
              record.command.objectType,
              applyKnowledgeFieldPatch(
                current?.payload,
                record.command.fieldPatch,
              ),
            ),
          });
        }
      }
      const summary = this.#knowledgeImportSummary(input.runId, input.batchId);
      this.#database.prepare(`
        UPDATE knowledge_import_batches SET report_json=?
        WHERE run_id=? AND batch_id=? AND status='staged'
      `).run(
        canonicalJson({
          batchId: input.batchId,
          counts: summary.counts,
          unresolved: summary.unresolved,
        }),
        input.runId,
        input.batchId,
      );
      this.#appendEvent(input.runId, "knowledge_import_staged", {
        batchId: input.batchId,
        sourceHash: input.sourceHash,
        mappingHash: input.mappingHash,
        counts: summary.counts,
        unresolved: summary.unresolved,
      });
      this.#faultInjector?.checkpoint("knowledge_import_stage_before_commit");
      return this.#stagedImportReport(input.runId, input.batchId, {
        limit: MAX_STAGED_IMPORT_PAGE_SIZE,
      });
    });
  }

  listStagedKnowledgeImports(
    runId: string,
  ): readonly StagedImportSummary[] {
    this.#run(runId);
    const batches = all<KnowledgeImportBatchRow>(this.#database.prepare(`
      SELECT * FROM knowledge_import_batches
      WHERE run_id=? AND status='staged'
      ORDER BY created_at, batch_id
    `), runId);
    return Object.freeze(batches.map((batch) => {
      const summary = this.#knowledgeImportSummary(runId, batch.batch_id);
      return Object.freeze({
        batchId: batch.batch_id,
        sourceName: batch.source_name,
        sourceFormat: batch.source_format,
        counts: summary.counts,
        unresolved: summary.unresolved,
        createdAt: batch.created_at,
      });
    }));
  }

  getStagedKnowledgeImport(
    runId: string,
    input: StagedImportPageRequest,
  ): StagedImportReport {
    return this.#stagedImportReport(runId, input.batchId, {
      cursor: input.cursor,
      limit: input.limit,
    });
  }

  setKnowledgeImportDecisions(
    runId: string,
    input: ImportDecisionRequest,
  ): StagedImportReport {
    return this.#transaction(() => {
      const batch = this.#requireKnowledgeImportBatch(runId, input.batchId);
      if (batch.status !== "staged") {
        throw new Error("KNOWLEDGE_IMPORT_BATCH_NOT_STAGED");
      }
      const seen = new Set<number>();
      for (const item of input.decisions) {
        if (!Number.isSafeInteger(item.rowOrdinal) || item.rowOrdinal < 0
          || seen.has(item.rowOrdinal)) {
          throw new Error("KNOWLEDGE_IMPORT_DECISION_ROW_INVALID");
        }
        seen.add(item.rowOrdinal);
        const row = one<KnowledgeImportRow>(this.#database.prepare(`
          SELECT * FROM knowledge_import_rows
          WHERE run_id=? AND batch_id=? AND row_ordinal=?
        `), runId, input.batchId, item.rowOrdinal);
        if (row === undefined) {
          throw new Error("KNOWLEDGE_IMPORT_DECISION_ROW_UNKNOWN");
        }
        const stored = parseStoredImportRow(row);
        const decision = parseImportDecision(canonicalJson(item.decision));
        if (decision === undefined
          || !stored.classification.allowedDecisions.includes(decision.action)) {
          throw new Error("KNOWLEDGE_IMPORT_DECISION_NOT_ALLOWED");
        }
        if (decision.action === "create_separate") {
          if (stored.prepared.state !== "normalized"
            || importIdentityKey(
              decision.normalizedSubject,
              stored.prepared.record.command.kind,
            ) === importIdentityKey(
              stored.prepared.record.command.normalizedSubject,
              stored.prepared.record.command.kind,
            )) {
            throw new Error("KNOWLEDGE_IMPORT_SEPARATE_SUBJECT_INVALID");
          }
          const current = new KnowledgeStore(this.knowledgeRevisions(runId))
            .activeKnowledge(
              decision.normalizedSubject,
              stored.prepared.record.command.kind,
            );
          if (current !== undefined) {
            throw new Error("KNOWLEDGE_IMPORT_SEPARATE_SUBJECT_EXISTS");
          }
        }
        this.#database.prepare(`
          UPDATE knowledge_import_rows SET decision_json=?
          WHERE run_id=? AND batch_id=? AND row_ordinal=?
        `).run(
          canonicalJson(decision),
          runId,
          input.batchId,
          item.rowOrdinal,
        );
      }
      const summary = this.#knowledgeImportSummary(runId, input.batchId);
      this.#database.prepare(`
        UPDATE knowledge_import_batches SET report_json=?
        WHERE run_id=? AND batch_id=? AND status='staged'
      `).run(
        canonicalJson({
          batchId: input.batchId,
          counts: summary.counts,
          unresolved: summary.unresolved,
        }),
        runId,
        input.batchId,
      );
      return this.#stagedImportReport(runId, input.batchId, {
        limit: MAX_STAGED_IMPORT_PAGE_SIZE,
      });
    });
  }

  discardStagedKnowledgeImport(
    runId: string,
    input: DiscardStagedImportRequest,
  ): void {
    this.#transaction(() => {
      const batch = this.#requireKnowledgeImportBatch(runId, input.batchId);
      if (batch.status !== "staged") {
        throw new Error("KNOWLEDGE_IMPORT_BATCH_NOT_STAGED");
      }
      const summary = this.#knowledgeImportSummary(runId, input.batchId);
      const rowCount = Object.values(summary.counts)
        .reduce((total, count) => total + count, 0);
      this.#database.prepare(`
        UPDATE knowledge_import_batches
        SET status='discarded', report_json=?
        WHERE run_id=? AND batch_id=? AND status='staged'
      `).run(
        canonicalJson({
          batchId: input.batchId,
          counts: summary.counts,
          unresolved: summary.unresolved,
          discarded: rowCount,
        }),
        runId,
        input.batchId,
      );
      this.#database.prepare(`
        DELETE FROM knowledge_import_rows WHERE run_id=? AND batch_id=?
      `).run(runId, input.batchId);
      this.#appendEvent(runId, "knowledge_import_discarded", {
        batchId: input.batchId,
        rows: rowCount,
      });
    });
  }

  commitKnowledgeImport(
    input: CommitStoredKnowledgeImportInput,
  ): CommittedImportReport {
    if (input.signal.aborted) {
      throw new Error("KNOWLEDGE_IMPORT_CANCELLED");
    }
    return this.#transaction(() => {
      const batch = this.#requireKnowledgeImportBatch(input.runId, input.batchId);
      if (batch.status === "committed") {
        return parseCommittedImportReport(batch.report_json);
      }
      if (batch.status !== "staged") {
        throw new Error("KNOWLEDGE_IMPORT_BATCH_NOT_STAGED");
      }
      const run = this.#run(input.runId);
      const state = this.knowledgeState(input.runId);
      if (state.generation !== input.expectedGeneration
        || state.snapshotId !== input.expectedSnapshotId) {
        throw new Error(
          "KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed; reload before committing",
        );
      }
      const currentBookGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `),
        run.source_version,
      )?.generation;
      const currentProjectGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `),
      )?.generation;
      if (currentBookGeneration !== state.appliedBookGeneration
        || currentProjectGeneration !== state.appliedProjectGeneration) {
        throw new Error(
          "KNOWLEDGE_SCOPE_GENERATION_CONFLICT: synchronize current knowledge first",
        );
      }
      const busy = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM window_plans
        WHERE run_id=? AND status IN ('running', 'staged')
      `), input.runId)?.count ?? 0;
      if (busy > 0) {
        throw new Error(
          "KNOWLEDGE_EDIT_BUSY: wait for the active translation window to finish",
        );
      }

      const rows = this.#knowledgeImportRows(input.runId, input.batchId);
      const summary = importCounts(rows);
      if (summary.unresolved > 0) {
        throw new Error("KNOWLEDGE_IMPORT_CONFLICTS_UNRESOLVED");
      }
      const domain = new KnowledgeStore(this.knowledgeRevisions(input.runId));
      let bookChanged = false;
      let projectChanged = false;
      let added = 0;
      let updated = 0;
      let merged = 0;
      let skipped = 0;
      let invalid = 0;
      let committed = 0;
      const revisionIds: string[] = [];
      const impactRevisions: KnowledgeRevision[] = [];
      for (const row of rows) {
        if (input.signal.aborted) {
          throw new Error("KNOWLEDGE_IMPORT_CANCELLED");
        }
        const stored = parseStoredImportRow(row);
        const decision = parseImportDecision(row.decision_json);
        if (stored.state === "invalid") {
          invalid += 1;
          if (decision?.action !== "skip") {
            throw new Error("KNOWLEDGE_IMPORT_INVALID_ROW_UNRESOLVED");
          }
          skipped += 1;
          this.#database.prepare(`
            UPDATE knowledge_import_rows SET state='skipped'
            WHERE run_id=? AND batch_id=? AND row_ordinal=?
          `).run(input.runId, input.batchId, row.row_ordinal);
          continue;
        }
        if (stored.prepared.state !== "normalized") {
          throw new Error("corrupt normalized knowledge import row");
        }
        if (decision?.action === "skip"
          || decision?.action === "keep_existing") {
          skipped += 1;
          this.#database.prepare(`
            UPDATE knowledge_import_rows SET state='skipped'
            WHERE run_id=? AND batch_id=? AND row_ordinal=?
          `).run(input.runId, input.batchId, row.row_ordinal);
          continue;
        }
        let rawCommand: UpdateKnowledgeCommand = stored.prepared.record.command;
        if (decision?.action === "create_separate") {
          rawCommand = {
            ...rawCommand,
            normalizedSubject: decision.normalizedSubject,
          };
        } else if (decision?.action === "merge_as_alias") {
          rawCommand = this.#importAliasMergeCommand(domain, rawCommand);
        }
        const current = domain.latestRevision(
          rawCommand.normalizedSubject,
          rawCommand.kind,
        );
        const catalog = this.#activeCatalogEntries(
          run,
          rawCommand.normalizedSubject,
          rawCommand.kind,
        ).find((entry) =>
          entry.document.authority.scope === rawCommand.scope);
        const command = validateKnowledgeCommand({
          ...rawCommand,
          expectedRevision: current?.revision ?? null,
          expectedScopeRevision: catalog === undefined
            ? null
            : {
                scope: catalog.document.authority.scope,
                revision: catalog.row.revision,
              },
          origin: "import",
          importBatchId: input.batchId,
        });
        if (command.type !== "upsert") {
          throw new Error("knowledge import produced a non-upsert command");
        }
        const applied = this.#applyKnowledgeCommand(run, domain, command);
        revisionIds.push(applied.revision.revisionId);
        impactRevisions.push(applied.revision);
        bookChanged ||= applied.bookChanged;
        projectChanged ||= applied.projectChanged;
        committed += 1;
        if (decision?.action === "merge_as_alias"
          || stored.state === "merge") {
          merged += 1;
        } else if (current === undefined) {
          added += 1;
        } else {
          updated += 1;
        }
        this.#database.prepare(`
          UPDATE knowledge_import_rows SET state='committed'
          WHERE run_id=? AND batch_id=? AND row_ordinal=?
        `).run(input.runId, input.batchId, row.row_ordinal);
      }
      this.#insertKnowledgeImpactsForRevisions(run, impactRevisions);

      const parentSnapshot = this.latestKnowledgeSnapshot(input.runId);
      const snapshot = createKnowledgeSnapshot(
        input.runId,
        domain.projectableRevisions(),
        parentSnapshot.id,
      );
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, parent_snapshot_id, producing_window_id,
          content_hash, payload_json
        ) VALUES(?, ?, ?, NULL, ?, ?)
      `).run(
        input.runId,
        snapshot.id,
        parentSnapshot.id,
        snapshot.contentHash,
        jsonText(snapshot, "knowledge import snapshot"),
      );
      let bookGeneration = state.appliedBookGeneration;
      if (bookChanged) {
        this.#database.prepare(`
          UPDATE book_knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE source_version=?
        `).run(run.source_version);
        bookGeneration = one<{ generation: number }>(this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `), run.source_version)?.generation ?? -1;
      }
      let projectGeneration = state.appliedProjectGeneration;
      if (projectChanged) {
        this.#database.prepare(`
          UPDATE project_knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE singleton=1
        `).run();
        projectGeneration = one<{ generation: number }>(this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `))?.generation ?? -1;
      }
      const generation = state.generation + 1;
      const changed = this.#database.prepare(`
        UPDATE knowledge_state
        SET generation=?, applied_book_generation=?,
            applied_project_generation=?, updated_at=datetime('now')
        WHERE run_id=? AND generation=?
      `).run(
        generation,
        bookGeneration,
        projectGeneration,
        input.runId,
        state.generation,
      );
      if (Number(changed.changes) !== 1) {
        throw new Error("KNOWLEDGE_GENERATION_CONFLICT");
      }
      const report: CommittedImportReport = Object.freeze({
        batchId: input.batchId,
        added,
        updated,
        merged,
        skipped,
        invalid,
        committed,
        generation,
        snapshotId: snapshot.id,
      });
      this.#database.prepare(`
        UPDATE knowledge_import_batches
        SET status='committed', report_json=?
        WHERE run_id=? AND batch_id=? AND status='staged'
      `).run(canonicalJson(report), input.runId, input.batchId);
      this.#appendEvent(input.runId, "knowledge_import_committed", {
        ...report,
        revisionIds,
      });
      this.#faultInjector?.checkpoint("knowledge_import_before_commit");
      return report;
    });
  }

  rollbackKnowledgeImport(
    input: CommitStoredKnowledgeImportInput,
  ): RolledBackImportReport {
    if (input.signal.aborted) {
      throw new Error("KNOWLEDGE_IMPORT_CANCELLED");
    }
    return this.#transaction(() => {
      const batch = this.#requireKnowledgeImportBatch(input.runId, input.batchId);
      if (batch.status === "rolled_back") {
        return parseRolledBackImportReport(batch.report_json);
      }
      if (batch.status !== "committed") {
        throw new Error("KNOWLEDGE_IMPORT_BATCH_NOT_COMMITTED");
      }
      const run = this.#run(input.runId);
      const state = this.knowledgeState(input.runId);
      if (state.generation !== input.expectedGeneration
        || state.snapshotId !== input.expectedSnapshotId) {
        throw new Error(
          "KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed; reload before rollback",
        );
      }
      const currentBookGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `),
        run.source_version,
      )?.generation;
      const currentProjectGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `),
      )?.generation;
      if (currentBookGeneration !== state.appliedBookGeneration
        || currentProjectGeneration !== state.appliedProjectGeneration) {
        throw new Error(
          "KNOWLEDGE_SCOPE_GENERATION_CONFLICT: synchronize current knowledge first",
        );
      }
      const busy = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM window_plans
        WHERE run_id=? AND status IN ('running', 'staged')
      `), input.runId)?.count ?? 0;
      if (busy > 0) {
        throw new Error(
          "KNOWLEDGE_EDIT_BUSY: wait for the active translation window to finish",
        );
      }
      const importedRows = all<{
        revision_id: string;
        payload_json: string;
      }>(this.#database.prepare(`
        SELECT revision_id, payload_json FROM knowledge_records
        WHERE run_id=? AND import_batch_id=?
        ORDER BY normalized_subject, kind, revision
      `), input.runId, input.batchId);
      const batchCatalogIds = new Set(importedRows.map((row) => {
        const revision = JSON.parse(row.payload_json) as KnowledgeRevision;
        return revision.authority?.provenance?.catalogRevisionId;
      }).filter((item): item is string => typeof item === "string"));
      const activeImported = importedRows.map((row) =>
        JSON.parse(row.payload_json) as KnowledgeRevision).filter((revision) => {
        const latest = one<{ active: number }>(this.#database.prepare(`
          SELECT active FROM knowledge_records
          WHERE run_id=? AND revision_id=?
        `), input.runId, revision.revisionId);
        return latest?.active === 1;
      });
      const domain = new KnowledgeStore(this.knowledgeRevisions(input.runId));
      let bookChanged = false;
      let projectChanged = false;
      const impactRevisions: KnowledgeRevision[] = [];
      for (const imported of activeImported) {
        if (input.signal.aborted) {
          throw new Error("KNOWLEDGE_IMPORT_CANCELLED");
        }
        const provenance = imported.authority?.provenance;
        if (provenance === undefined) {
          throw new Error("KNOWLEDGE_IMPORT_ROLLBACK_PROVENANCE_MISSING");
        }
        const catalogRow = provenance.catalog === "project"
          ? one<CatalogKnowledgeRow>(this.#database.prepare(`
              SELECT NULL AS source_version, record_id, revision, revision_id,
                     object_type, normalized_subject, kind, document_json,
                     origin, scope, active
              FROM project_knowledge_revisions WHERE revision_id=?
            `), provenance.catalogRevisionId)
          : one<CatalogKnowledgeRow>(this.#database.prepare(`
              SELECT source_version, record_id, revision, revision_id,
                     object_type, normalized_subject, kind, document_json,
                     origin, scope, active
              FROM book_knowledge_revisions WHERE revision_id=?
            `), provenance.catalogRevisionId);
        if (catalogRow === undefined || catalogRow.active !== 1) {
          throw new Error("KNOWLEDGE_IMPORT_ROLLBACK_CATALOG_CHANGED");
        }
        const catalog = this.#catalogEntryFromRow(catalogRow);
        const previousRows = catalog.document.authority.scope === "project"
          ? all<CatalogKnowledgeRow>(this.#database.prepare(`
              SELECT NULL AS source_version, record_id, revision, revision_id,
                     object_type, normalized_subject, kind, document_json,
                     origin, scope, active
              FROM project_knowledge_revisions
              WHERE record_id=? AND revision<?
              ORDER BY revision DESC
            `), catalogRow.record_id, catalogRow.revision)
          : all<CatalogKnowledgeRow>(this.#database.prepare(`
              SELECT source_version, record_id, revision, revision_id,
                     object_type, normalized_subject, kind, document_json,
                     origin, scope, active
              FROM book_knowledge_revisions
              WHERE source_version=? AND record_id=? AND revision<?
              ORDER BY revision DESC
            `), run.source_version, catalogRow.record_id, catalogRow.revision);
        const previous = previousRows
          .filter((row) => !batchCatalogIds.has(row.revision_id))
          .map((row) => this.#catalogEntryFromRow(row))
          .find((entry) => PROJECTABLE_KNOWLEDGE_STATUSES.has(
            entry.document.status,
          ));
        if (previous === undefined) {
          this.#appendCatalogRevision(
            run,
            {
              ...catalog.document,
              status: "superseded",
              authority: normalizeKnowledgeAuthority({
                origin: "rollback",
                scope: catalog.document.authority.scope,
                ownedFields: catalog.document.authority.ownedFields,
              }),
            },
            false,
          );
        } else {
          this.#appendCatalogRevision(
            run,
            {
              ...previous.document,
              status: "active",
              authority: normalizeKnowledgeAuthority({
                origin: "rollback",
                scope: previous.document.authority.scope,
                ownedFields: previous.document.authority.ownedFields,
              }),
            },
            true,
          );
        }
        bookChanged ||= catalog.document.authority.scope !== "project";
        projectChanged ||= catalog.document.authority.scope === "project";

        const desired = this.#effectiveCatalogEntry(
          run,
          imported.normalizedSubject,
          imported.kind,
        );
        if (desired === undefined) {
          const superseded = domain.appendRevision({
            normalizedSubject: imported.normalizedSubject,
            kind: imported.kind,
            payload: imported.payload,
            alternatives: imported.alternatives,
            status: "superseded",
            candidateIds: imported.candidateIds,
            sourceWindowIds: imported.sourceWindowIds,
            authority: normalizeKnowledgeAuthority({
              origin: "rollback",
              scope: imported.authority?.scope ?? "book",
              ownedFields: imported.authority?.ownedFields ?? [],
            }),
          });
          this.#insertRunKnowledgeRevision(
            input.runId,
            superseded,
            null,
            [],
            undefined,
          );
          impactRevisions.push(superseded);
        } else {
          const scope = desired.document.authority.scope;
          const restored = domain.appendRevision({
            normalizedSubject: desired.document.normalizedSubject,
            kind: desired.document.kind,
            payload: desired.document.payload,
            alternatives: desired.document.alternatives,
            status: desired.document.status,
            candidateIds: imported.candidateIds,
            sourceWindowIds: imported.sourceWindowIds,
            authority: normalizeKnowledgeAuthority({
              ...desired.document.authority,
              provenance: {
                catalog: scope === "project" ? "project" : "book",
                catalogRevisionId: desired.row.revision_id,
              },
            }),
          });
          this.#insertRunKnowledgeRevision(
            input.runId,
            restored,
            null,
            desired.document.evidence,
            undefined,
          );
          impactRevisions.push(restored);
        }
      }
      this.#insertKnowledgeImpactsForRevisions(run, impactRevisions);
      const parentSnapshot = this.latestKnowledgeSnapshot(input.runId);
      const snapshot = createKnowledgeSnapshot(
        input.runId,
        domain.projectableRevisions(),
        parentSnapshot.id,
      );
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, parent_snapshot_id, producing_window_id,
          content_hash, payload_json
        ) VALUES(?, ?, ?, NULL, ?, ?)
      `).run(
        input.runId,
        snapshot.id,
        parentSnapshot.id,
        snapshot.contentHash,
        jsonText(snapshot, "knowledge import rollback snapshot"),
      );
      let bookGeneration = state.appliedBookGeneration;
      if (bookChanged) {
        this.#database.prepare(`
          UPDATE book_knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE source_version=?
        `).run(run.source_version);
        bookGeneration = one<{ generation: number }>(this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `), run.source_version)?.generation ?? -1;
      }
      let projectGeneration = state.appliedProjectGeneration;
      if (projectChanged) {
        this.#database.prepare(`
          UPDATE project_knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE singleton=1
        `).run();
        projectGeneration = one<{ generation: number }>(this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `))?.generation ?? -1;
      }
      const generation = state.generation + 1;
      const changed = this.#database.prepare(`
        UPDATE knowledge_state
        SET generation=?, applied_book_generation=?,
            applied_project_generation=?, updated_at=datetime('now')
        WHERE run_id=? AND generation=?
      `).run(
        generation,
        bookGeneration,
        projectGeneration,
        input.runId,
        state.generation,
      );
      if (Number(changed.changes) !== 1) {
        throw new Error("KNOWLEDGE_GENERATION_CONFLICT");
      }
      const report: RolledBackImportReport = Object.freeze({
        batchId: input.batchId,
        rolledBack: activeImported.length,
        generation,
        snapshotId: snapshot.id,
      });
      this.#database.prepare(`
        UPDATE knowledge_import_batches
        SET status='rolled_back', report_json=?
        WHERE run_id=? AND batch_id=? AND status='committed'
      `).run(canonicalJson(report), input.runId, input.batchId);
      this.#appendEvent(input.runId, "knowledge_import_rolled_back", report);
      this.#faultInjector?.checkpoint("knowledge_import_rollback_before_commit");
      return report;
    });
  }

  commitKnowledgeCommands(
    input: CommitKnowledgeCommandsRequest | unknown,
  ): KnowledgeCommitResult {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v3 write upgrade required");
    }
    const request = validateCommitKnowledgeCommandsRequest(input);
    const requestHash = knowledgeCommandRequestHash(request);
    return this.#transaction(() => {
      const replay = this.#knowledgeCommandReplay(
        request.runId,
        request.requestId,
        requestHash,
      );
      if (replay !== undefined) {
        return replay;
      }
      const run = this.#run(request.runId);
      const state = this.knowledgeState(request.runId);
      if (state.generation !== request.expectedGeneration
        || state.snapshotId !== request.expectedSnapshotId) {
        throw new Error(
          "KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed; reload before saving",
        );
      }
      const currentBookGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `),
        run.source_version,
      )?.generation;
      const currentProjectGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `),
      )?.generation;
      if (currentBookGeneration === undefined
        || currentProjectGeneration === undefined) {
        throw new Error("schema v3 knowledge generation state is incomplete");
      }
      if (currentBookGeneration !== state.appliedBookGeneration
        || currentProjectGeneration !== state.appliedProjectGeneration) {
        throw new Error(
          "KNOWLEDGE_SCOPE_GENERATION_CONFLICT: synchronize current book/project knowledge before saving",
        );
      }
      const busy = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM window_plans
        WHERE run_id=? AND status IN ('running', 'staged')
      `), request.runId)?.count ?? 0;
      if (busy > 0) {
        throw new Error(
          "KNOWLEDGE_EDIT_BUSY: wait for the active translation window to finish",
        );
      }

      const domain = new KnowledgeStore(this.knowledgeRevisions(request.runId));
      const revisionIds: string[] = [];
      let bookChanged = false;
      let projectChanged = false;
      for (const command of request.commands) {
        const result = this.#applyKnowledgeCommand(run, domain, command);
        revisionIds.push(result.revision.revisionId);
        this.#insertKnowledgeImpactsForRevision(run, result.revision);
        bookChanged ||= result.bookChanged;
        projectChanged ||= result.projectChanged;
      }

      const parentSnapshot = this.latestKnowledgeSnapshot(request.runId);
      const snapshot = createKnowledgeSnapshot(
        request.runId,
        domain.projectableRevisions(),
        parentSnapshot.id,
      );
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, parent_snapshot_id, producing_window_id,
          content_hash, payload_json
        ) VALUES(?, ?, ?, NULL, ?, ?)
      `).run(
        request.runId,
        snapshot.id,
        parentSnapshot.id,
        snapshot.contentHash,
        jsonText(snapshot, "knowledge command snapshot"),
      );

      let bookGeneration = state.appliedBookGeneration;
      if (bookChanged) {
        const updated = this.#database.prepare(`
          UPDATE book_knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE source_version=?
        `).run(run.source_version);
        if (Number(updated.changes) !== 1) {
          throw new Error("book knowledge generation state is incomplete");
        }
        bookGeneration = one<{ generation: number }>(this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `), run.source_version)?.generation ?? -1;
      }
      let projectGeneration = state.appliedProjectGeneration;
      if (projectChanged) {
        const updated = this.#database.prepare(`
          UPDATE project_knowledge_state
          SET generation=generation+1, updated_at=datetime('now')
          WHERE singleton=1
        `).run();
        if (Number(updated.changes) !== 1) {
          throw new Error("project knowledge generation state is incomplete");
        }
        projectGeneration = one<{ generation: number }>(this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `))?.generation ?? -1;
      }
      const generation = state.generation + 1;
      const updatedState = this.#database.prepare(`
        UPDATE knowledge_state
        SET generation=?, applied_book_generation=?,
            applied_project_generation=?, updated_at=datetime('now')
        WHERE run_id=? AND generation=?
      `).run(
        generation,
        bookGeneration,
        projectGeneration,
        request.runId,
        state.generation,
      );
      if (Number(updatedState.changes) !== 1) {
        throw new Error("KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed");
      }
      const result: KnowledgeCommitResult = {
        requestId: request.requestId,
        generation,
        snapshotId: snapshot.id,
        revisionIds,
        bookGeneration,
        projectGeneration,
      };
      const event: KnowledgeCommandEventPayload = {
        requestId: request.requestId,
        requestHash,
        result,
      };
      this.#appendEvent(request.runId, "knowledge_user_commit", event);
      this.#faultInjector?.checkpoint("knowledge_command_before_commit");
      return result;
    });
  }

  attachGlobalKnowledgeSnapshot(
    input: AttachGlobalKnowledgeSnapshotInput,
  ): KnowledgeCommitResult {
    if (this.#schemaVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error("schema v3 write upgrade required");
    }
    const requestId = requireNonempty(input.requestId, "requestId");
    const runId = requireNonempty(input.runId, "runId");
    const expectedSnapshotId = requireNonempty(
      input.expectedSnapshotId,
      "expectedSnapshotId",
    );
    if (!Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration < 0) {
      throw new TypeError("expectedGeneration must be a non-negative safe integer");
    }
    if (!/^[0-9a-f]{64}$/u.test(input.globalRevisionId)) {
      throw new TypeError("globalRevisionId must be a revision hash");
    }
    const sourceDocument = validateCatalogKnowledgeDocument(input.document);
    if ((sourceDocument.objectType !== "term"
        && sourceDocument.objectType !== "style")
      || sourceDocument.authority.scope !== "global") {
      throw new Error("GLOBAL_SCOPE_FORBIDDEN");
    }
    if (sourceDocument.globalRevisionId !== undefined
      && sourceDocument.globalRevisionId !== input.globalRevisionId) {
      throw new Error("GLOBAL_KNOWLEDGE_REVISION_MISMATCH");
    }
    const document = validateCatalogKnowledgeDocument({
      ...sourceDocument,
      authority: {
        origin: "import",
        scope: "global",
        ownedFields: sourceDocument.authority.ownedFields,
      },
      globalRevisionId: input.globalRevisionId,
      evidence: [],
    });
    const requestHash = hashText(canonicalJson({
      requestId,
      runId,
      expectedGeneration: input.expectedGeneration,
      expectedSnapshotId,
      globalRevisionId: input.globalRevisionId,
      document,
    }));

    return this.#transaction(() => {
      const replayRows = all<{ payload_json: string }>(this.#database.prepare(`
        SELECT payload_json FROM events
        WHERE run_id=? AND kind='knowledge_global_attached'
          AND json_extract(payload_json, '$.requestId')=?
        ORDER BY sequence
      `), runId, requestId);
      if (replayRows.length > 0) {
        const payloads = replayRows.map((row) =>
          JSON.parse(row.payload_json) as {
            requestId: string;
            requestHash: string;
            result: KnowledgeCommitResult;
          });
        const first = payloads[0]!;
        if (first.requestHash !== requestHash
          || payloads.some((payload) =>
            canonicalJson(payload) !== canonicalJson(first))) {
          throw new Error("KNOWLEDGE_REQUEST_REUSE_CONFLICT");
        }
        return structuredClone(first.result);
      }

      const run = this.#run(runId);
      const state = this.knowledgeState(runId);
      const domain = new KnowledgeStore(this.knowledgeRevisions(runId));
      const current = domain.latestRevision(
        document.normalizedSubject,
        document.kind,
      );
      if (current?.authority?.scope === "global"
        && current.authority.provenance?.globalRevisionId
          === input.globalRevisionId
        && canonicalJson(current.payload) === canonicalJson(document.payload)) {
        const result: KnowledgeCommitResult = {
          requestId,
          generation: state.generation,
          snapshotId: state.snapshotId,
          revisionIds: [current.revisionId],
          bookGeneration: state.appliedBookGeneration,
          projectGeneration: state.appliedProjectGeneration,
        };
        this.#appendEvent(runId, "knowledge_global_attached", {
          requestId,
          requestHash,
          result,
        });
        return result;
      }
      if (current !== undefined) {
        throw new Error(
          "GLOBAL_KNOWLEDGE_SHADOWED: a stronger local value already exists",
        );
      }
      if (state.generation !== input.expectedGeneration
        || state.snapshotId !== expectedSnapshotId) {
        throw new Error(
          "KNOWLEDGE_GENERATION_CONFLICT: knowledge state changed; reload before saving",
        );
      }
      const bookGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM book_knowledge_state WHERE source_version=?
        `),
        run.source_version,
      )?.generation;
      const projectGeneration = one<{ generation: number }>(
        this.#database.prepare(`
          SELECT generation FROM project_knowledge_state WHERE singleton=1
        `),
      )?.generation;
      if (bookGeneration === undefined || projectGeneration === undefined
        || bookGeneration !== state.appliedBookGeneration
        || projectGeneration !== state.appliedProjectGeneration) {
        throw new Error(
          "KNOWLEDGE_SCOPE_GENERATION_CONFLICT: synchronize current knowledge before attaching",
        );
      }
      const busy = one<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM window_plans
        WHERE run_id=? AND status IN ('running', 'staged')
      `), runId)?.count ?? 0;
      if (busy > 0) {
        throw new Error(
          "KNOWLEDGE_EDIT_BUSY: wait for the active translation window to finish",
        );
      }

      const catalog = this.#appendCatalogRevision(run, document, true, true);
      const revision = domain.appendRevision({
        normalizedSubject: document.normalizedSubject,
        kind: document.kind,
        payload: document.payload,
        alternatives: document.alternatives,
        status: document.status,
        authority: normalizeKnowledgeAuthority({
          ...document.authority,
          provenance: {
            catalog: "book",
            catalogRevisionId: catalog.revision_id,
            globalRevisionId: input.globalRevisionId,
          },
        }),
      });
      this.#insertRunKnowledgeRevision(
        runId,
        revision,
        null,
        document.evidence,
        `global:${input.globalRevisionId}`,
      );
      this.#insertKnowledgeImpactsForRevision(run, revision);

      const parentSnapshot = this.latestKnowledgeSnapshot(runId);
      const snapshot = createKnowledgeSnapshot(
        runId,
        domain.projectableRevisions(),
        parentSnapshot.id,
      );
      this.#database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, parent_snapshot_id, producing_window_id,
          content_hash, payload_json
        ) VALUES(?, ?, ?, NULL, ?, ?)
      `).run(
        runId,
        snapshot.id,
        parentSnapshot.id,
        snapshot.contentHash,
        jsonText(snapshot, "global knowledge attachment snapshot"),
      );
      const bookState = this.#database.prepare(`
        UPDATE book_knowledge_state
        SET generation=generation+1, updated_at=datetime('now')
        WHERE source_version=? AND generation=?
      `).run(run.source_version, bookGeneration);
      if (Number(bookState.changes) !== 1) {
        throw new Error("KNOWLEDGE_SCOPE_GENERATION_CONFLICT");
      }
      const nextBookGeneration = bookGeneration + 1;
      const generation = state.generation + 1;
      const updated = this.#database.prepare(`
        UPDATE knowledge_state
        SET generation=?, applied_book_generation=?,
            applied_project_generation=?, updated_at=datetime('now')
        WHERE run_id=? AND generation=?
      `).run(
        generation,
        nextBookGeneration,
        projectGeneration,
        runId,
        state.generation,
      );
      if (Number(updated.changes) !== 1) {
        throw new Error("KNOWLEDGE_GENERATION_CONFLICT");
      }
      const result: KnowledgeCommitResult = {
        requestId,
        generation,
        snapshotId: snapshot.id,
        revisionIds: [revision.revisionId],
        bookGeneration: nextBookGeneration,
        projectGeneration,
      };
      this.#appendEvent(runId, "knowledge_global_attached", {
        requestId,
        requestHash,
        result,
      });
      this.#faultInjector?.checkpoint("knowledge_command_before_commit");
      return result;
    });
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
      origin: string;
      scope: string;
      owned_fields_json: string;
      evidence_json: string;
      import_batch_id: string | null;
    }>(this.#database.prepare(`
      SELECT run_id, record_id, revision_id, revision, normalized_subject, kind,
             payload_json, status, active, origin, scope, owned_fields_json,
             evidence_json, import_batch_id
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
      const authority = parsed.authority === undefined
        ? undefined
        : normalizeKnowledgeAuthority(parsed.authority);
      const ownedFields = JSON.parse(row.owned_fields_json) as unknown;
      const evidence = validateKnowledgeEvidence(
        JSON.parse(row.evidence_json) as unknown,
      );
      if (row.origin !== (authority?.origin ?? "model")
        || row.scope !== (authority?.scope ?? "book")
        || canonicalJson(ownedFields) !== canonicalJson(
          authority?.ownedFields ?? [],
        )) {
        throw new Error(`corrupt knowledge authority row ${row.revision_id}`);
      }
      if (authority?.provenance !== undefined
        && canonicalJson(evidence) !== canonicalJson(
          this.#catalogEvidenceForRevision(parsed),
        )) {
        throw new Error(`corrupt knowledge evidence row ${row.revision_id}`);
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
      producing_window_id: string | null;
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
    const conceptBindings = this.#schemaVersion === LOSSLESS_BOOK_SCHEMA_VERSION
      ? all<{
          translation_id: number;
          concept_id: string;
          validation_status: TranslationConceptBinding["validationStatus"];
        }>(this.#database.prepare(`
          SELECT binding.translation_id, binding.concept_id,
                 binding.validation_status
          FROM translation_concept_bindings AS binding
          JOIN translations AS translation
            ON translation.translation_id=binding.translation_id
          WHERE translation.run_id=? AND translation.active=1
          ORDER BY binding.translation_id, binding.concept_id
        `), runId).map((row) => ({
          translationId: row.translation_id,
          conceptId: row.concept_id,
          validationStatus: row.validation_status,
        }))
      : [];
    const missingConceptBindings = this.#schemaVersion === LOSSLESS_BOOK_SCHEMA_VERSION
      ? all<{
          translation_id: number;
          block_id: string;
          concept_id: string;
        }>(this.#database.prepare(`
          SELECT translation.translation_id, translation.block_id,
                 occurrence.concept_id
          FROM translations AS translation
          JOIN concept_occurrences AS occurrence
            ON occurrence.run_id=translation.run_id
           AND occurrence.block_id=translation.block_id
          JOIN lexical_concepts AS concept
            ON concept.run_id=occurrence.run_id
           AND concept.concept_id=occurrence.concept_id
           AND concept.active=1
          LEFT JOIN translation_concept_bindings AS binding
            ON binding.translation_id=translation.translation_id
           AND binding.concept_id=occurrence.concept_id
          WHERE translation.run_id=? AND translation.active=1
            AND binding.translation_id IS NULL
          ORDER BY translation.translation_id, occurrence.concept_id
        `), runId).map((row) => ({
          translationId: row.translation_id,
          blockId: row.block_id,
          conceptId: row.concept_id,
        }))
      : [];
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
      conceptBindings,
      missingConceptBindings,
      revalidationTasks: this.revalidationTasks(runId),
    };
  }

  close(): void {
    try {
      this.#database.close();
    } finally {
      if (this.#temporarySnapshotDirectory !== undefined) {
        removeReadOnlySnapshotDirectory(this.#temporarySnapshotDirectory);
      }
    }
  }

  latestSchedulerSnapshot(runId: string): AdaptiveSchedulerSnapshot | undefined {
    this.#run(runId);
    const row = one<{ payload_json: string }>(this.#database.prepare(`
      SELECT payload_json FROM events
      WHERE run_id=? AND kind='adaptive_scheduler_snapshot'
      ORDER BY sequence DESC LIMIT 1
    `), runId);
    if (row === undefined) {
      return undefined;
    }
    const payload = JSON.parse(row.payload_json) as { snapshot?: unknown };
    if (payload === null || typeof payload !== "object" || payload.snapshot === undefined) {
      throw new Error(`corrupt adaptive scheduler snapshot for ${runId}`);
    }
    return structuredClone(payload.snapshot) as AdaptiveSchedulerSnapshot;
  }

  saveSchedulerSnapshot(runId: string, snapshot: AdaptiveSchedulerSnapshot): void {
    this.#run(runId);
    if (snapshot.inFlight !== 0 || snapshot.inFlightTokens !== 0) {
      throw new TypeError("only an idle adaptive scheduler snapshot can be persisted");
    }
    this.#transaction(() => {
      this.#appendEvent(runId, "adaptive_scheduler_snapshot", { snapshot });
    });
  }

  appendTokenLedgerEvent(runId: string, event: LedgerEvent): void {
    this.#run(runId);
    validateLedgerEvent(event);
    this.#transaction(() => {
      this.#appendEvent(runId, ledgerEventKind(event.type), {
        event,
        ts: new Date().toISOString(),
      });
    });
  }

  loadTokenLedgerEvents(runId: string): LedgerEvent[] {
    this.#run(runId);
    const rows = this.#database.prepare(`
      SELECT kind, payload_json FROM events
      WHERE run_id=? AND kind IN (
        'token_ledger_baseline_added',
        'token_ledger_reserved',
        'token_ledger_dispatched',
        'token_ledger_settled',
        'token_ledger_released',
        'token_ledger_counters_patched'
      )
      ORDER BY sequence ASC
    `).all(runId) as Array<{ kind: string; payload_json: string }>;
    return rows.map((row) => parseLedgerEventPayload(row.kind, row.payload_json));
  }

  loadTokenLedger(runId: string, init: TokenLedgerInit): TokenLedger {
    return TokenLedger.fromEvents(init, this.loadTokenLedgerEvents(runId));
  }

  saveSchedulerRunProjection(runId: string, report: SchedulerRunReport): void {
    this.#run(runId);
    validateSchedulerRunReport(report);
    this.#transaction(() => {
      this.#appendEvent(runId, "scheduler_run_projection", {
        report,
        ts: new Date().toISOString(),
      });
    });
  }

  loadSchedulerMetrics(
    runId: string,
    init?: TokenLedgerInit,
  ): SchedulerRunReport | undefined {
    this.#run(runId);
    const projection = one<{ payload_json: string }>(this.#database.prepare(`
      SELECT payload_json FROM events
      WHERE run_id=? AND kind='scheduler_run_projection'
      ORDER BY sequence DESC LIMIT 1
    `), runId);
    let projectedReport: SchedulerRunReport | undefined;
    if (projection !== undefined) {
      const payload = JSON.parse(projection.payload_json) as { report?: unknown };
      if (
        payload === null
        || typeof payload !== "object"
        || payload.report === undefined
      ) {
        throw new Error(`corrupt scheduler run projection for ${runId}`);
      }
      validateSchedulerRunReport(payload.report);
      projectedReport = structuredClone(payload.report) as SchedulerRunReport;
    }

    const events = this.loadTokenLedgerEvents(runId);
    if (events.length === 0) {
      return projectedReport;
    }
    if (init !== undefined) {
      const ledger = TokenLedger.fromEvents(init, events);
      if (projectedReport !== undefined) {
        ledger.apply({
          type: "counters_patched",
          patch: schedulerCountersPatch(projectedReport),
        });
      }
      return ledger.toSchedulerRunReport();
    }
    if (projectedReport !== undefined) {
      return projectedReport;
    }
    throw new TypeError(
      "loadSchedulerMetrics requires TokenLedgerInit when rebuilding from ledger events",
    );
  }

  appendProviderResponseEvidence(
    input: ProviderResponseEvidenceInput,
  ): void {
    const runId = requireNonempty(input.runId, "provider evidence runId");
    this.#run(runId);
    const requestId = requireNonempty(
      input.requestId,
      "provider evidence requestId",
    );
    const snapshotId = requireNonempty(
      input.snapshotId,
      "provider evidence snapshotId",
    );
    if (!Number.isSafeInteger(input.modelCallOrdinal)
      || input.modelCallOrdinal < 1) {
      throw new TypeError(
        "provider evidence modelCallOrdinal must be a positive safe integer",
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(input.requestHash)) {
      throw new TypeError("provider evidence requestHash must be sha256 hex");
    }
    const assistantJson = JSON.stringify(input.assistantMessage);
    if (assistantJson === undefined) {
      throw new TypeError("provider evidence assistantMessage must be JSON-serializable");
    }
    const responseHash = hashText(assistantJson);
    const runDirectory = `run-${hashText(runId).slice(0, 24)}`;
    const evidenceDirectory = join(
      dirname(this.#databasePath),
      "evidence",
      runDirectory,
    );
    mkdirSync(evidenceDirectory, { recursive: true });
    const filename = `${responseHash}.json.gz`;
    const absoluteLocator = join(evidenceDirectory, filename);
    if (!existsSync(absoluteLocator)) {
      const temporary = join(
        evidenceDirectory,
        `.${filename}.${randomUUID()}.tmp`,
      );
      const envelope = JSON.stringify({
        schema: "folioloom-provider-response-evidence-1",
        responseHash,
        assistantMessage: JSON.parse(assistantJson) as unknown,
      });
      const descriptor = openSync(temporary, "wx");
      try {
        writeFileSync(descriptor, gzipSync(envelope));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      try {
        renameSync(temporary, absoluteLocator);
      } catch (error) {
        rmSync(temporary, { force: true });
        if (!existsSync(absoluteLocator)) {
          throw error;
        }
      }
    }
    const assistant = input.assistantMessage !== null
        && typeof input.assistantMessage === "object"
      ? input.assistantMessage as Record<string, unknown>
      : {};
    const locator = [
      "evidence",
      runDirectory,
      filename,
    ].join("/");
    const metadata = {
      schema: "folioloom-provider-response-evidence-ref-1",
      requestId,
      snapshotId,
      phase: input.phase,
      modelCallOrdinal: input.modelCallOrdinal,
      requestHash: input.requestHash,
      responseHash,
      responseProtocol: input.responseProtocol,
      locator,
      compressedBytes: statSync(absoluteLocator).size,
      ...(input.executionUnitId === undefined
        ? {}
        : {
          executionUnitId: requireNonempty(
            input.executionUnitId,
            "provider evidence executionUnitId",
          ),
        }),
      ...(typeof assistant.id === "string"
        ? { providerResponseId: assistant.id }
        : {}),
      ...(typeof assistant.provider === "string"
        ? { provider: assistant.provider }
        : {}),
      ...(typeof assistant.model === "string"
        ? { model: assistant.model }
        : {}),
      ...(typeof assistant.api === "string"
        ? { api: assistant.api }
        : {}),
      ...(typeof assistant.stopReason === "string"
        ? { stopReason: assistant.stopReason }
        : {}),
      ...(assistant.usage !== undefined
        ? { usage: assistant.usage }
        : {}),
    };
    this.#transaction(() => {
      this.#appendEvent(runId, "provider_response_evidence", metadata);
    });
  }

  #initializeSchema(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(LOSSLESS_BOOK_SCHEMA_V4);
      this.#database.prepare(`
        INSERT INTO project_knowledge_state(singleton, generation) VALUES(1, 0)
      `).run();
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

  #verifyNoLegacySchema(tables: readonly string[]): void {
    const legacyNames = new Set(["book_meta", "book_blocks", "windows"]);
    if (tables.some((table) => legacyNames.has(table))) {
      throw new Error(
        "legacy BookStore schema requires a new database for schema v3; in-place migration is forbidden",
      );
    }
  }

  #verifyV2Schema(tables: readonly string[]): void {
    this.#verifyNoLegacySchema(tables);
    const expected = [...LOSSLESS_BOOK_SCHEMA_V2_TABLES];
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
    if (markers.get("marker") !== LOSSLESS_BOOK_SCHEMA_V2_MARKER
      || markers.get("fingerprint") !== LOSSLESS_BOOK_SCHEMA_V2_FINGERPRINT) {
      throw new Error("schema v2 marker or fingerprint mismatch");
    }
  }

  #verifyV3Schema(userVersion: number, tables: readonly string[]): void {
    this.#verifyNoLegacySchema(tables);
    if (userVersion !== LOSSLESS_BOOK_SCHEMA_V3_VERSION) {
      throw new Error(
        `unsupported schema user_version ${userVersion}; expected ${LOSSLESS_BOOK_SCHEMA_V3_VERSION}`,
      );
    }
    const expected = [...LOSSLESS_BOOK_SCHEMA_V3_TABLES];
    if (tables.length !== expected.length
      || tables.some((table, index) => table !== expected[index])) {
      throw new Error("schema v3 table set is incomplete or contains unknown tables");
    }
    const markers = new Map(all<{ key: string; value: string }>(
      this.#database.prepare(`
        SELECT key, value FROM lossless_schema_meta
        WHERE key IN ('marker', 'fingerprint')
      `),
    ).map((row) => [row.key, row.value]));
    if (markers.get("marker") !== LOSSLESS_BOOK_SCHEMA_V3_MARKER
      || markers.get("fingerprint") !== LOSSLESS_BOOK_SCHEMA_V3_FINGERPRINT) {
      throw new Error("schema v3 marker or fingerprint mismatch");
    }
  }

  #verifyV4Schema(userVersion: number, tables: readonly string[]): void {
    this.#verifyNoLegacySchema(tables);
    if (userVersion !== LOSSLESS_BOOK_SCHEMA_VERSION) {
      throw new Error(
        `unsupported schema user_version ${userVersion}; expected ${LOSSLESS_BOOK_SCHEMA_VERSION}`,
      );
    }
    const expected = [...LOSSLESS_BOOK_SCHEMA_TABLES];
    if (tables.length !== expected.length
      || tables.some((table, index) => table !== expected[index])) {
      throw new Error("schema v4 table set is incomplete or contains unknown tables");
    }
    const markers = new Map(all<{ key: string; value: string }>(
      this.#database.prepare(`
        SELECT key, value FROM lossless_schema_meta
        WHERE key IN ('marker', 'fingerprint')
      `),
    ).map((row) => [row.key, row.value]));
    if (markers.get("marker") !== LOSSLESS_BOOK_SCHEMA_MARKER
      || markers.get("fingerprint") !== LOSSLESS_BOOK_SCHEMA_FINGERPRINT) {
      throw new Error("schema v4 marker or fingerprint mismatch");
    }
  }

  #migrateV2ToV3(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec("ALTER TABLE knowledge_records RENAME TO knowledge_records_v2");
      this.#database.exec(LOSSLESS_BOOK_SCHEMA_V3_KNOWLEDGE_RECORDS);
      this.#database.exec(`
        INSERT INTO knowledge_records(
          run_id, record_id, revision_id, revision, normalized_subject,
          kind, payload_json, status, active, producing_window_id,
          origin, scope, owned_fields_json, evidence_json, import_batch_id,
          created_at
        )
        SELECT
          run_id, record_id, revision_id, revision, normalized_subject,
          kind, payload_json, status, active, producing_window_id,
          'model', 'book', '[]', '[]', NULL, created_at
        FROM knowledge_records_v2;
        DROP TABLE knowledge_records_v2;
      `);
      this.#database.exec(LOSSLESS_BOOK_SCHEMA_V3_EXTENSION);
      this.#database.exec(`
        INSERT INTO book_knowledge_state(source_version, generation)
        SELECT source_version, 0 FROM source_versions;
        INSERT INTO project_knowledge_state(singleton, generation) VALUES(1, 0);
        INSERT INTO knowledge_state(
          run_id, generation, applied_book_generation, applied_project_generation
        )
        SELECT run_id, 0, 0, 0 FROM translation_runs;
      `);
      const updateMarker = this.#database.prepare(`
        UPDATE lossless_schema_meta SET value=? WHERE key=?
      `);
      updateMarker.run(LOSSLESS_BOOK_SCHEMA_V3_MARKER, "marker");
      updateMarker.run(LOSSLESS_BOOK_SCHEMA_V3_FINGERPRINT, "fingerprint");
      this.#database.exec(`PRAGMA user_version=${LOSSLESS_BOOK_SCHEMA_V3_VERSION}`);
      this.#faultInjector?.checkpoint("schema_v3_before_commit");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV3ToV4(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(LOSSLESS_BOOK_SCHEMA_V4_EXTENSION);
      const updateMarker = this.#database.prepare(`
        UPDATE lossless_schema_meta SET value=? WHERE key=?
      `);
      updateMarker.run(LOSSLESS_BOOK_SCHEMA_MARKER, "marker");
      updateMarker.run(LOSSLESS_BOOK_SCHEMA_FINGERPRINT, "fingerprint");
      this.#database.exec(`PRAGMA user_version=${LOSSLESS_BOOK_SCHEMA_VERSION}`);
      this.#faultInjector?.checkpoint("schema_v4_before_commit");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #verifyRunKnowledgeState(runId: string, sourceVersion: string): void {
    const state = one<{
      generation: number;
      applied_book_generation: number;
      applied_project_generation: number;
    }>(this.#database.prepare(`
      SELECT generation, applied_book_generation, applied_project_generation
      FROM knowledge_state WHERE run_id=?
    `), runId);
    const bookGeneration = one<{ generation: number }>(this.#database.prepare(`
      SELECT generation FROM book_knowledge_state WHERE source_version=?
    `), sourceVersion)?.generation;
    const projectGeneration = one<{ generation: number }>(this.#database.prepare(`
      SELECT generation FROM project_knowledge_state WHERE singleton=1
    `))?.generation;
    const generations = state === undefined
      ? []
      : [
          state.generation,
          state.applied_book_generation,
          state.applied_project_generation,
        ];
    if (state === undefined
      || bookGeneration === undefined
      || projectGeneration === undefined
      || generations.some((generation) => !Number.isSafeInteger(generation) || generation < 0)
      || state.applied_book_generation > bookGeneration
      || state.applied_project_generation > projectGeneration) {
      throw new Error(`translation run ${runId} knowledge state mismatch`);
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
    const declaredEstimatorVersion = plan.estimatorVersion === undefined
      ? undefined
      : requireNonempty(plan.estimatorVersion, "derived plan estimatorVersion");
    const observedEstimatorVersions = new Set(plan.blocks.map((block, index) => (
      block.estimatorVersion === undefined
        ? LEGACY_TOKEN_ESTIMATOR_VERSION
        : requireNonempty(block.estimatorVersion, `block[${index}].estimatorVersion`)
    )));
    if (declaredEstimatorVersion === undefined && observedEstimatorVersions.size > 1) {
      throw new Error("derived plan mixes estimator versions without an explicit plan version");
    }
    const estimatorVersion = declaredEstimatorVersion
      ?? observedEstimatorVersions.values().next().value
      ?? LEGACY_TOKEN_ESTIMATOR_VERSION;
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
      const blockEstimatorVersion = block.estimatorVersion === undefined
        ? estimatorVersion
        : requireNonempty(block.estimatorVersion, `block[${index}].estimatorVersion`);
      if (blockEstimatorVersion !== estimatorVersion) {
        throw new Error(
          `block ${id} estimator version does not match derived plan estimator version`,
        );
      }
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
        estimatorVersion: blockEstimatorVersion,
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
    return { estimatorVersion, annotations, blocks };
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

  #evaluateStagedBindingGate(
    runId: string,
    windowId: string,
  ): BindingGateDecision {
    const rows = all<TranslationConceptBindingRow>(this.#database.prepare(`
      SELECT b.*
      FROM translations AS t
      JOIN translation_concept_bindings AS b
        ON b.translation_id=t.translation_id
      WHERE t.run_id=? AND t.window_id=?
        AND t.stage_state='staged' AND t.active=0
      ORDER BY b.concept_id, b.translation_id
    `), runId, windowId);
    if (rows.length === 0) {
      return {
        status: "compatible",
        updates: [],
        incompatibleConceptIds: [],
      };
    }
    const conceptIds = [...new Set(rows.map((row) => row.concept_id))];
    const concepts = conceptIds.flatMap((conceptId) => {
      const row = one<LexicalConceptRow>(this.#database.prepare(`
        SELECT * FROM lexical_concepts
        WHERE run_id=? AND concept_id=? AND active=1
      `), runId, conceptId);
      return row === undefined ? [] : [lexicalConceptFromRow(row)];
    });
    const decision = evaluateStagedConceptBindings({
      concepts,
      bindings: rows.map((row) => ({
        conceptId: row.concept_id,
        appliedRevisionId: row.applied_revision_id,
        appliedRenderFingerprint: row.applied_render_fingerprint,
        termUsages: termUsagesFromJson(row.term_usages_json),
      })),
    });
    if (decision.status !== "compatible") return decision;
    for (const update of decision.updates) {
      this.#database.prepare(`
        UPDATE translation_concept_bindings
        SET applied_revision_id=?, applied_render_fingerprint=?,
            validation_status='clean', validated_revision_id=?,
            updated_at=datetime('now')
        WHERE concept_id=? AND translation_id IN (
          SELECT translation_id FROM translations
          WHERE run_id=? AND window_id=?
            AND stage_state='staged' AND active=0
        )
      `).run(
        update.revisionId,
        update.renderFingerprint,
        update.revisionId,
        update.conceptId,
        runId,
        windowId,
      );
    }
    return decision;
  }

  #projectLexicalConceptRevisions(
    runId: string,
    revisions: readonly KnowledgeRevision[],
    toSnapshotId: string,
  ): void {
    const concepts = revisions
      .filter((revision) =>
        revision.kind === "lexical_concept" && revision.status === "active")
      .map((revision) => lexicalConceptFromPayload(revision.payload));
    if (concepts.length === 0) return;
    const changes = this.#upsertLexicalConceptRows(runId, concepts);
    for (const change of changes) {
      if (change.renderChanged) continue;
      this.#database.prepare(`
        UPDATE translation_concept_bindings
        SET applied_revision_id=?,
            validated_revision_id=?,
            validation_status='clean',
            updated_at=datetime('now')
        WHERE concept_id=?
          AND applied_render_fingerprint=?
          AND translation_id IN (
            SELECT translation_id FROM translations
            WHERE run_id=? AND active=1
          )
      `).run(
        change.revisionId,
        change.revisionId,
        change.conceptId,
        change.renderFingerprint,
        runId,
      );
    }
    const renderChanged = new Set(changes
      .filter((change) => change.renderChanged)
      .map((change) => change.conceptId));
    if (renderChanged.size === 0) return;
    const changedConcepts = concepts.filter((concept) =>
      renderChanged.has(concept.conceptId));
    const run = this.#run(runId);
    const source = this.#source(run.source_version);
    const sourcePayload = JSON.parse(source.source_payload_json) as {
      sourceLanguage?: unknown;
    };
    const profile = getSourceLanguageProfile(
      typeof sourcePayload.sourceLanguage === "string"
        ? sourcePayload.sourceLanguage
        : undefined,
    );
    const blocks = all<{ block_id: string; source_text: string }>(
      this.#database.prepare(`
        SELECT block_id, source_text FROM logical_blocks
        WHERE source_version=? ORDER BY global_index
      `),
      run.source_version,
    ).map((block) => ({
      blockId: block.block_id,
      sourceText: block.source_text,
    }));
    const occurrences = buildConceptOccurrenceIndex(
      blocks,
      changedConcepts,
      profile,
    );
    const insert = this.#database.prepare(`
      INSERT INTO concept_occurrences(
        run_id, concept_id, source_version, block_id,
        occurrence_count, source_spans_json
      ) VALUES(?, ?, ?, ?, ?, ?)
    `);
    for (const concept of changedConcepts) {
      this.#database.prepare(`
        DELETE FROM concept_occurrences WHERE run_id=? AND concept_id=?
      `).run(runId, concept.conceptId);
    }
    for (const occurrence of occurrences) {
      insert.run(
        runId,
        occurrence.conceptId,
        run.source_version,
        occurrence.blockId,
        occurrence.sourceSpans.length,
        jsonText(occurrence.sourceSpans, "concept occurrence spans"),
      );
    }
    this.#createSparseRevalidationTasks(
      runId,
      changedConcepts,
      occurrences,
      toSnapshotId,
    );
  }

  #createSparseRevalidationTasks(
    runId: string,
    concepts: readonly LexicalConcept[],
    occurrences: readonly ConceptOccurrence[],
    toSnapshotId: string,
  ): ConceptCoverageRevalidationReport {
    const startedAt = performance.now();
    if (concepts.length === 0 || occurrences.length === 0) {
      return {
        occurrenceDependencies: 0,
        candidateTranslations: 0,
        tasksCreated: 0,
        bindingsCreated: 0,
        wallTimeMs: performance.now() - startedAt,
      };
    }
    const conceptIds = new Set(concepts.map((concept) => concept.conceptId));
    const conceptById = new Map(concepts.map((concept) => [
      concept.conceptId,
      concept,
    ]));
    const occurrenceDependencies = new Set(occurrences
      .filter((occurrence) => conceptIds.has(occurrence.conceptId))
      .map((occurrence) =>
        `${occurrence.conceptId}\0${occurrence.blockId}`));
    const occurrenceBlockIds = [...new Set(occurrences
      .filter((occurrence) => conceptIds.has(occurrence.conceptId))
      .map((occurrence) => occurrence.blockId))];
    const rows: Array<{
      translation_id: number;
      block_id: string;
      snapshot_id: string;
      concept_id: string | null;
      applied_revision_id: string | null;
      applied_render_fingerprint: string | null;
    }> = [];
    const blockBatchSize = 400;
    for (let offset = 0; offset < occurrenceBlockIds.length; offset += blockBatchSize) {
      const blockIds = occurrenceBlockIds.slice(offset, offset + blockBatchSize);
      const placeholders = blockIds.map(() => "?").join(",");
      rows.push(...all<{
        translation_id: number;
        block_id: string;
        snapshot_id: string;
        concept_id: string | null;
        applied_revision_id: string | null;
        applied_render_fingerprint: string | null;
      }>(this.#database.prepare(`
        SELECT t.translation_id, t.block_id, t.snapshot_id,
               b.concept_id, b.applied_revision_id,
               b.applied_render_fingerprint
        FROM translations AS t
        LEFT JOIN translation_concept_bindings AS b
          ON b.translation_id=t.translation_id
        WHERE t.run_id=? AND t.active=1
          AND t.block_id IN (${placeholders})
        ORDER BY t.translation_id, b.concept_id
      `), runId, ...blockIds));
    }
    const dependencies = new Map<number, {
      translationId: number;
      blockId: string;
      snapshotId: string;
      bindings: Array<{
        conceptId: string;
        appliedRevisionId: string;
        appliedRenderFingerprint: string;
      }>;
    }>();
    for (const row of rows) {
      const dependency = dependencies.get(row.translation_id) ?? {
        translationId: row.translation_id,
        blockId: row.block_id,
        snapshotId: row.snapshot_id,
        bindings: [],
      };
      if (row.concept_id !== null
        && row.applied_revision_id !== null
        && row.applied_render_fingerprint !== null
        && conceptIds.has(row.concept_id)) {
        dependency.bindings.push({
          conceptId: row.concept_id,
          appliedRevisionId: row.applied_revision_id,
          appliedRenderFingerprint: row.applied_render_fingerprint,
        });
      }
      dependencies.set(row.translation_id, dependency);
    }
    const candidates = planSparseRevalidation({
      concepts,
      occurrences,
      translations: [...dependencies.values()],
      toSnapshotId,
    });
    const insert = this.#database.prepare(`
      INSERT OR IGNORE INTO knowledge_revalidation_tasks(
        task_id, run_id, translation_id, block_id, change_set_hash,
        from_snapshot_id, to_snapshot_id, concept_ids_json, status
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    const insertPlaceholderBinding = this.#database.prepare(`
      INSERT OR IGNORE INTO translation_concept_bindings(
        translation_id, concept_id, applied_revision_id,
        applied_render_fingerprint, term_usages_json, validation_status,
        validated_revision_id
      ) VALUES(?, ?, ?, ?, '[]', 'stale', ?)
    `);
    const createdTaskIds: string[] = [];
    let bindingsCreated = 0;
    for (const candidate of candidates) {
      const taskId = `revalidation-${hashText([
        runId,
        String(candidate.translationId),
        candidate.changeSetHash,
      ].join("\0")).slice(0, 32)}`;
      const inserted = insert.run(
        taskId,
        runId,
        candidate.translationId,
        candidate.blockId,
        candidate.changeSetHash,
        candidate.fromSnapshotId,
        candidate.toSnapshotId,
        jsonText(candidate.conceptIds, "revalidation concept IDs"),
      );
      const existingTask = Number(inserted.changes) === 1
        ? undefined
        : one<{ status: KnowledgeRevalidationTask["status"] }>(
            this.#database.prepare(`
              SELECT status FROM knowledge_revalidation_tasks
              WHERE run_id=? AND task_id=?
            `),
            runId,
            taskId,
          );
      const activeTask = Number(inserted.changes) === 1
        || existingTask?.status === "pending"
        || existingTask?.status === "validating";
      if (Number(inserted.changes) === 1) {
        createdTaskIds.push(taskId);
      }
      if (!activeTask) continue;
      for (const conceptId of candidate.conceptIds) {
        const concept = conceptById.get(conceptId);
        if (concept === undefined) {
          throw new Error(`revalidation concept is missing: ${conceptId}`);
        }
        const placeholder = insertPlaceholderBinding.run(
          candidate.translationId,
          conceptId,
          concept.revisionId,
          concept.renderFingerprint,
          concept.revisionId,
        );
        bindingsCreated += Number(placeholder.changes);
        this.#database.prepare(`
          UPDATE translation_concept_bindings
          SET validation_status='stale', updated_at=datetime('now')
          WHERE translation_id=? AND concept_id=?
        `).run(candidate.translationId, conceptId);
      }
    }
    if (createdTaskIds.length > 0) {
      this.#appendEvent(runId, "sparse_revalidation_planned", {
        runId,
        toSnapshotId,
        taskIds: createdTaskIds,
      });
    }
    return {
      occurrenceDependencies: occurrenceDependencies.size,
      candidateTranslations: candidates.length,
      tasksCreated: createdTaskIds.length,
      bindingsCreated,
      wallTimeMs: performance.now() - startedAt,
    };
  }

  #upsertLexicalConceptRows(
    runId: string,
    concepts: readonly LexicalConcept[],
  ): LexicalConceptChange[] {
    const changes: LexicalConceptChange[] = [];
    for (const concept of [...concepts].sort((left, right) =>
      compareText(left.conceptId, right.conceptId))) {
      const active = one<LexicalConceptRow>(this.#database.prepare(`
        SELECT * FROM lexical_concepts
        WHERE run_id=? AND concept_id=? AND active=1
      `), runId, concept.conceptId);
      if (active?.revision_id === concept.revisionId) {
        continue;
      }
      const stored = one<LexicalConceptRow>(this.#database.prepare(`
        SELECT * FROM lexical_concepts
        WHERE run_id=? AND revision_id=?
      `), runId, concept.revisionId);
      if (stored !== undefined && stored.concept_id !== concept.conceptId) {
        throw new Error(
          `lexical revision ${concept.revisionId} belongs to another concept`,
        );
      }
      this.#database.prepare(`
        UPDATE lexical_concepts SET active=0
        WHERE run_id=? AND concept_id=? AND active=1
      `).run(runId, concept.conceptId);
      let revision: number;
      if (stored !== undefined) {
        revision = stored.revision;
        const activated = this.#database.prepare(`
          UPDATE lexical_concepts SET active=1
          WHERE run_id=? AND concept_id=? AND revision=?
        `).run(runId, concept.conceptId, revision);
        if (Number(activated.changes) !== 1) {
          throw new Error(`failed to reactivate lexical concept ${concept.conceptId}`);
        }
      } else {
        revision = (one<{ next_revision: number }>(this.#database.prepare(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
          FROM lexical_concepts WHERE run_id=? AND concept_id=?
        `), runId, concept.conceptId)?.next_revision) ?? 1;
        this.#database.prepare(`
          INSERT INTO lexical_concepts(
            run_id, concept_id, revision, revision_id, normalized_subject,
            source_forms_json, semantic_class, canonical_target, policy,
            allowed_realizations_json, visibility, confidence,
            render_fingerprint, active
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          runId,
          concept.conceptId,
          revision,
          concept.revisionId,
          concept.normalizedSubject,
          jsonText(concept.sourceForms, "concept source forms"),
          concept.semanticClass,
          concept.canonicalTarget,
          concept.policy,
          jsonText(
            concept.allowedRealizations,
            "concept allowed realizations",
          ),
          concept.visibility,
          concept.confidence,
          concept.renderFingerprint,
        );
      }
      changes.push({
        conceptId: concept.conceptId,
        revision,
        previousRevisionId: active?.revision_id ?? null,
        revisionId: concept.revisionId,
        previousRenderFingerprint: active?.render_fingerprint ?? null,
        renderFingerprint: concept.renderFingerprint,
        renderChanged: active?.render_fingerprint !== concept.renderFingerprint,
      });
    }
    return changes;
  }

  #writeWindowConceptBindings(
    runId: string,
    windowId: string,
    usages: readonly TermUsageSubmission[],
    concepts: readonly TermConceptProjection[],
  ): void {
    if (!Array.isArray(usages) || !Array.isArray(concepts)) {
      throw new TypeError("concept bindings must contain usage and concept arrays");
    }
    const conceptById = new Map<string, TermConceptProjection>();
    for (const concept of concepts) {
      const conceptId = requireNonempty(concept.conceptId, "binding conceptId");
      requireNonempty(concept.revisionId, "binding revisionId");
      if (!/^[0-9a-f]{64}$/u.test(concept.renderFingerprint)) {
        throw new TypeError(
          `binding renderFingerprint for ${conceptId} must be a SHA-256 hash`,
        );
      }
      const previous = conceptById.get(conceptId);
      if (previous !== undefined) {
        if (previous.revisionId !== concept.revisionId
          || previous.renderFingerprint !== concept.renderFingerprint) {
          throw new Error(`conflicting binding concept ${conceptId}`);
        }
        continue;
      }
      conceptById.set(conceptId, concept);
    }
    const translations = all<{
      translation_id: number;
      block_id: string;
      text: string;
      source_text: string;
    }>(this.#database.prepare(`
      SELECT translation.translation_id, translation.block_id,
             translation.text, block.source_text
      FROM translations AS translation
      JOIN logical_blocks AS block
        ON block.source_version=translation.source_version
       AND block.block_id=translation.block_id
      WHERE translation.run_id=? AND translation.window_id=?
        AND translation.stage_state='staged' AND translation.active=0
      ORDER BY translation.translation_id
    `), runId, windowId);
    const translationByBlock = new Map(translations.map((translation) => [
      translation.block_id,
      translation,
    ]));
    if (translationByBlock.size !== translations.length) {
      throw new Error(`duplicate staged translation block in ${runId}/${windowId}`);
    }
    const membership = this.#membership(runId, windowId);
    const seenOccurrenceIds = new Set<string>();
    const grouped = new Map<string, {
      translationId: number;
      concept: TermConceptProjection;
      usages: TermUsageSubmission[];
    }>();
    const run = this.#run(runId);
    const sourcePayload = JSON.parse(
      this.#source(run.source_version).source_payload_json,
    ) as { sourceLanguage?: unknown };
    const profile = getSourceLanguageProfile(
      typeof sourcePayload.sourceLanguage === "string"
        ? sourcePayload.sourceLanguage
        : undefined,
    );
    const expected = expectedTermOccurrences(
      translations.map((translation) => ({
        id: translation.block_id,
        sourceText: translation.source_text,
      })),
      concepts,
      profile,
    );
    const failures = validateTermUsages(
      expected,
      usages,
      new Map(translations.map((translation) => [
        translation.block_id,
        translation.text,
      ])),
    );
    if (failures.length > 0) {
      throw new Error(
        `staged term usage validation failed: ${failures
          .map((failure) => failure.code)
          .join(",")}`,
      );
    }
    for (const usage of usages) {
      const occurrenceId = requireNonempty(
        usage.occurrenceId,
        "term usage occurrenceId",
      );
      if (seenOccurrenceIds.has(occurrenceId)) {
        throw new Error(`duplicate term usage ${occurrenceId}`);
      }
      seenOccurrenceIds.add(occurrenceId);
      const concept = conceptById.get(
        requireNonempty(usage.conceptId, "term usage conceptId"),
      );
      if (concept === undefined) {
        throw new Error(`term usage references unknown concept ${usage.conceptId}`);
      }
      const translation = translationByBlock.get(
        requireNonempty(usage.blockId, "term usage blockId"),
      );
      const block = membership.get(usage.blockId);
      if (translation === undefined || block === undefined) {
        throw new Error(
          `term usage references a block outside ${runId}/${windowId}`,
        );
      }
      requireSafeInteger(usage.sourceStart, "term usage sourceStart");
      requireSafeInteger(usage.sourceEnd, "term usage sourceEnd", 1);
      if (usage.sourceEnd <= usage.sourceStart) {
        throw new Error(`invalid term usage source span ${occurrenceId}`);
      }
      const source = one<{ source_text: string }>(this.#database.prepare(`
        SELECT source_text FROM logical_blocks
        WHERE source_version=? AND block_id=?
      `), block.source_version, block.block_id);
      const sourceScalars = Array.from(source?.source_text ?? "");
      if (usage.sourceEnd > sourceScalars.length
        || sourceScalars.slice(usage.sourceStart, usage.sourceEnd).join("")
          !== usage.sourceForm) {
        throw new Error(`term usage source mismatch ${occurrenceId}`);
      }
      const targetSurface = requireNonempty(
        usage.targetSurface,
        "term usage targetSurface",
      );
      if (!translation.text.includes(targetSurface)) {
        throw new Error(`term usage target missing from translation ${occurrenceId}`);
      }
      if (!["narrative", "vocative", "title", "other"].includes(
        usage.discourseRole,
      )) {
        throw new Error(`invalid term usage discourse role ${occurrenceId}`);
      }
      const key = `${usage.blockId}\0${usage.conceptId}`;
      const item = grouped.get(key) ?? {
        translationId: translation.translation_id,
        concept,
        usages: [],
      };
      item.usages.push({ ...usage, targetSurface });
      grouped.set(key, item);
    }
    for (const occurrence of expected) {
      const key = `${occurrence.blockId}\0${occurrence.conceptId}`;
      if (grouped.has(key)) continue;
      const translation = translationByBlock.get(occurrence.blockId);
      const concept = conceptById.get(occurrence.conceptId);
      if (translation === undefined || concept === undefined) {
        throw new Error(
          `term occurrence references unknown staged coverage ${occurrence.occurrenceId}`,
        );
      }
      grouped.set(key, {
        translationId: translation.translation_id,
        concept,
        usages: [],
      });
    }
    if (translations.length > 0) {
      this.#database.prepare(`
        DELETE FROM translation_concept_bindings
        WHERE translation_id IN (
          SELECT translation_id FROM translations
          WHERE run_id=? AND window_id=? AND stage_state='staged' AND active=0
        )
      `).run(runId, windowId);
    }
    const insert = this.#database.prepare(`
      INSERT INTO translation_concept_bindings(
        translation_id, concept_id, applied_revision_id,
        applied_render_fingerprint, term_usages_json, validation_status,
        validated_revision_id
      ) VALUES(?, ?, ?, ?, ?, 'clean', ?)
    `);
    for (const item of [...grouped.values()].sort((left, right) =>
      left.translationId - right.translationId
      || compareText(left.concept.conceptId, right.concept.conceptId))) {
      const orderedUsages = item.usages.sort((left, right) =>
        left.sourceStart - right.sourceStart
        || left.sourceEnd - right.sourceEnd
        || compareText(left.occurrenceId, right.occurrenceId));
      insert.run(
        item.translationId,
        item.concept.conceptId,
        item.concept.revisionId,
        item.concept.renderFingerprint,
        jsonText(orderedUsages, "term usages"),
        item.concept.revisionId,
      );
    }
  }

  #revalidationTask(
    runId: string,
    taskId: string,
  ): KnowledgeRevalidationTask {
    const row = one<KnowledgeRevalidationTaskRow>(
      this.#database.prepare(`
        SELECT * FROM knowledge_revalidation_tasks
        WHERE run_id=? AND task_id=?
      `),
      runId,
      taskId,
    );
    if (row === undefined) {
      throw new Error(`unknown revalidation task ${runId}/${taskId}`);
    }
    return revalidationTaskFromRow(row);
  }

  #finishRevalidationTask(
    task: KnowledgeRevalidationTask,
    status: Extract<
      KnowledgeRevalidationTask["status"],
      "resolved_noop" | "completed_with_warning"
    >,
    result: unknown,
    replacementTranslationId: number | null,
    bindingStatus: Extract<
      TranslationConceptBinding["validationStatus"],
      "clean" | "warning_stale"
    >,
  ): void {
    const resultJson = jsonText(result, "revalidation result");
    for (const conceptId of task.conceptIds) {
      this.#database.prepare(`
        UPDATE translation_concept_bindings
        SET validation_status=?, updated_at=datetime('now')
        WHERE translation_id=? AND concept_id=?
      `).run(bindingStatus, task.translationId, conceptId);
    }
    const completed = this.#database.prepare(`
      UPDATE knowledge_revalidation_tasks
      SET status=?, result_json=?, replacement_translation_id=?,
          resolved_at=datetime('now')
      WHERE run_id=? AND task_id=? AND status IN ('pending','validating')
    `).run(
      status,
      resultJson,
      replacementTranslationId,
      task.runId,
      task.taskId,
    );
    if (Number(completed.changes) !== 1) {
      throw new Error(`failed to finish revalidation task ${task.taskId}`);
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

  #knowledgeImportBatch(
    runId: string,
    batchId: string,
  ): KnowledgeImportBatchRow | undefined {
    return one<KnowledgeImportBatchRow>(this.#database.prepare(`
      SELECT * FROM knowledge_import_batches WHERE run_id=? AND batch_id=?
    `), runId, batchId);
  }

  #requireKnowledgeImportBatch(
    runId: string,
    batchId: string,
  ): KnowledgeImportBatchRow {
    this.#run(runId);
    const batch = this.#knowledgeImportBatch(runId, batchId);
    if (batch === undefined) {
      throw new Error("KNOWLEDGE_IMPORT_BATCH_UNKNOWN");
    }
    return batch;
  }

  #knowledgeImportRows(
    runId: string,
    batchId: string,
  ): KnowledgeImportRow[] {
    return all<KnowledgeImportRow>(this.#database.prepare(`
      SELECT * FROM knowledge_import_rows
      WHERE run_id=? AND batch_id=?
      ORDER BY row_ordinal
    `), runId, batchId);
  }

  #knowledgeImportSummary(
    runId: string,
    batchId: string,
  ): {
    readonly counts: ImportCountSummary;
    readonly unresolved: number;
  } {
    const row = one<{
      ready: number;
      merge: number;
      conflict: number;
      invalid: number;
      skipped: number;
      unresolved: number;
    }>(this.#database.prepare(`
      WITH effective AS (
        SELECT
          state,
          COALESCE(json_extract(decision_json, '$.action'), '') AS action,
          decision_json
        FROM knowledge_import_rows
        WHERE run_id=? AND batch_id=?
      )
      SELECT
        COALESCE(SUM(CASE
          WHEN state='ready' AND action NOT IN ('skip', 'keep_existing')
          THEN 1 ELSE 0 END), 0) AS ready,
        COALESCE(SUM(CASE
          WHEN state='merge' AND action NOT IN ('skip', 'keep_existing')
          THEN 1 ELSE 0 END), 0) AS merge,
        COALESCE(SUM(CASE
          WHEN state='conflict' AND action NOT IN ('skip', 'keep_existing')
          THEN 1 ELSE 0 END), 0) AS conflict,
        COALESCE(SUM(CASE
          WHEN state='invalid' AND action NOT IN ('skip', 'keep_existing')
          THEN 1 ELSE 0 END), 0) AS invalid,
        COALESCE(SUM(CASE
          WHEN state='skipped' OR action IN ('skip', 'keep_existing')
          THEN 1 ELSE 0 END), 0) AS skipped,
        COALESCE(SUM(CASE
          WHEN state IN ('conflict', 'invalid') AND decision_json IS NULL
          THEN 1 ELSE 0 END), 0) AS unresolved
      FROM effective
    `), runId, batchId);
    return {
      counts: Object.freeze({
        ready: row?.ready ?? 0,
        merge: row?.merge ?? 0,
        conflict: row?.conflict ?? 0,
        invalid: row?.invalid ?? 0,
        skipped: row?.skipped ?? 0,
      }),
      unresolved: row?.unresolved ?? 0,
    };
  }

  #stagedImportReport(
    runId: string,
    batchId: string,
    page: { readonly cursor?: string; readonly limit: number },
  ): StagedImportReport {
    const batch = this.#requireKnowledgeImportBatch(runId, batchId);
    if (batch.status !== "staged") {
      throw new Error("KNOWLEDGE_IMPORT_BATCH_NOT_STAGED");
    }
    if (!Number.isSafeInteger(page.limit)
      || page.limit < 1
      || page.limit > MAX_STAGED_IMPORT_PAGE_SIZE) {
      throw new Error("KNOWLEDGE_IMPORT_PAGE_LIMIT_INVALID");
    }
    const after = parseImportCursor(page.cursor, batchId);
    const summary = this.#knowledgeImportSummary(runId, batchId);
    const available = all<KnowledgeImportRow>(this.#database.prepare(`
      SELECT * FROM knowledge_import_rows
      WHERE run_id=? AND batch_id=? AND row_ordinal>?
      ORDER BY row_ordinal
      LIMIT ?
    `), runId, batchId, after, page.limit + 1);
    const pageRows = available.slice(0, page.limit);
    const hasMore = available.length > pageRows.length;
    return Object.freeze({
      batchId,
      counts: summary.counts,
      unresolved: summary.unresolved,
      rows: Object.freeze(pageRows.map(importPreviewFromRow)),
      ...(hasMore && pageRows.length > 0
        ? {
            nextCursor: importCursor(
              batchId,
              pageRows.at(-1)!.row_ordinal,
            ),
          }
        : {}),
    });
  }

  #knowledgeCommandReplay(
    runId: string,
    requestId: string,
    requestHash: string,
  ): KnowledgeCommitResult | undefined {
    const rows = all<{ payload_json: string }>(this.#database.prepare(`
      SELECT payload_json FROM events
      WHERE run_id=? AND kind='knowledge_user_commit'
        AND json_extract(payload_json, '$.requestId')=?
      ORDER BY sequence
    `), runId, requestId);
    if (rows.length === 0) {
      return undefined;
    }
    const parsed = rows.map((row) =>
      JSON.parse(row.payload_json) as KnowledgeCommandEventPayload);
    const first = parsed[0] as KnowledgeCommandEventPayload;
    const result = requireMatchingKnowledgeReplay(first, requestHash);
    for (const item of parsed.slice(1)) {
      if (canonicalJson(item) !== canonicalJson(first)) {
        throw new Error(
          `corrupt duplicate knowledge command replay for ${requestId}`,
        );
      }
    }
    return result;
  }

  #applyKnowledgeCommand(
    run: RunRow,
    domain: KnowledgeStore,
    command: KnowledgeCommand,
  ): AppliedKnowledgeCommand {
    return command.type === "upsert"
      ? this.#applyUpsertKnowledgeCommand(run, domain, command)
      : this.#applyRollbackKnowledgeCommand(run, domain, command);
  }

  #applyUpsertKnowledgeCommand(
    run: RunRow,
    domain: KnowledgeStore,
    command: UpdateKnowledgeCommand,
  ): AppliedKnowledgeCommand {
    const current = domain.latestRevision(
      command.normalizedSubject,
      command.kind,
    );
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== command.expectedRevision) {
      throw new Error(
        "KNOWLEDGE_REVISION_CONFLICT: the knowledge object changed; reload before saving",
      );
    }
    const expectedCatalog = this.#expectedCatalogEntry(
      run,
      command.normalizedSubject,
      command.kind,
      command.expectedScopeRevision,
    );
    if (expectedCatalog !== undefined
      && expectedCatalog.document.objectType !== command.objectType) {
      throw new Error("KNOWLEDGE_OBJECT_TYPE_CONFLICT");
    }

    const payload = validateKnowledgePayload(
      command.objectType,
      applyKnowledgeFieldPatch(current?.payload, command.fieldPatch),
    );
    const priorAuthority = current?.authority === undefined
      ? undefined
      : normalizeKnowledgeAuthority(current.authority);
    let authority: KnowledgeAuthority = normalizeKnowledgeAuthority({
      origin: command.origin,
      scope: command.scope,
      ownedFields: command.ownedFields,
    });
    if (priorAuthority !== undefined && priorAuthority.scope === command.scope) {
      const ownedFields = [...new Set([
        ...priorAuthority.ownedFields,
        ...authority.ownedFields,
      ])].sort(compareText);
      const origin = compareAuthority(priorAuthority, authority) > 0
        ? priorAuthority.origin
        : authority.origin;
      authority = normalizeKnowledgeAuthority({
        origin,
        scope: command.scope,
        ownedFields,
      });
    }
    const evidence = command.evidence.length > 0
      ? command.evidence
      : (expectedCatalog?.document.evidence ?? []);
    const scopeChanged = expectedCatalog !== undefined
      && expectedCatalog.document.authority.scope !== command.scope;
    let bookChanged = command.scope !== "project";
    let projectChanged = command.scope === "project";
    if (scopeChanged) {
      const oldScope = expectedCatalog.document.authority.scope;
      this.#appendCatalogRevision(
        run,
        {
          ...expectedCatalog.document,
          status: "superseded",
          authority: normalizeKnowledgeAuthority({
            origin: command.origin,
            scope: oldScope,
            ownedFields: expectedCatalog.document.authority.ownedFields,
          }),
        },
        false,
        oldScope === "global",
      );
      bookChanged ||= oldScope !== "project";
      projectChanged ||= oldScope === "project";
    }
    const catalog = this.#appendCatalogRevision(
      run,
      {
        objectType: command.objectType,
        normalizedSubject: command.normalizedSubject,
        kind: command.kind,
        payload,
        alternatives: [payload],
        status: "active",
        authority,
        evidence,
      },
      true,
    );
    const runAuthority = normalizeKnowledgeAuthority({
      ...authority,
      provenance: {
        catalog: command.scope === "project" ? "project" : "book",
        catalogRevisionId: catalog.revision_id,
      },
    });
    const revision = domain.appendRevision({
      normalizedSubject: command.normalizedSubject,
      kind: command.kind,
      payload,
      alternatives: [payload],
      status: "active",
      candidateIds: current?.candidateIds ?? [],
      sourceWindowIds: current?.sourceWindowIds ?? [],
      authority: runAuthority,
    });
    this.#insertRunKnowledgeRevision(
      run.run_id,
      revision,
      null,
      evidence,
      command.importBatchId,
    );
    return { revision, bookChanged, projectChanged };
  }

  #applyRollbackKnowledgeCommand(
    run: RunRow,
    domain: KnowledgeStore,
    command: RollbackKnowledgeCommand,
  ): AppliedKnowledgeCommand {
    const current = domain.latestRevision(
      command.normalizedSubject,
      command.kind,
    );
    if (current?.revision !== command.expectedRevision) {
      throw new Error(
        "KNOWLEDGE_REVISION_CONFLICT: the knowledge object changed; reload before restoring",
      );
    }
    const expectedCatalog = this.#expectedCatalogEntry(
      run,
      command.normalizedSubject,
      command.kind,
      command.expectedScopeRevision,
    );
    if (expectedCatalog === undefined) {
      throw new Error("KNOWLEDGE_CATALOG_REVISION_CONFLICT");
    }
    const target = domain.listRevisions().find((revision) =>
      revision.normalizedSubject === command.normalizedSubject
      && revision.kind === command.kind
      && revision.revision === command.targetRevision);
    if (target === undefined) {
      throw new Error(
        `KNOWLEDGE_ROLLBACK_TARGET_MISSING: revision ${command.targetRevision}`,
      );
    }
    const scope = expectedCatalog.document.authority.scope;
    const ownedFields = target.authority?.ownedFields
      ?? expectedCatalog.document.authority.ownedFields;
    const authority = normalizeKnowledgeAuthority({
      origin: "rollback",
      scope,
      ownedFields,
    });
    const payload = validateKnowledgePayload(
      expectedCatalog.document.objectType,
      structuredClone(target.payload),
    );
    const catalog = this.#appendCatalogRevision(
      run,
      {
        objectType: expectedCatalog.document.objectType,
        normalizedSubject: command.normalizedSubject,
        kind: command.kind,
        payload,
        alternatives: [payload],
        status: "active",
        authority,
        evidence: expectedCatalog.document.evidence,
      },
      true,
    );
    const runAuthority = normalizeKnowledgeAuthority({
      ...authority,
      provenance: {
        catalog: scope === "project" ? "project" : "book",
        catalogRevisionId: catalog.revision_id,
      },
    });
    const revision = domain.appendRevision({
      normalizedSubject: command.normalizedSubject,
      kind: command.kind,
      payload,
      alternatives: [payload],
      status: "active",
      candidateIds: target.candidateIds,
      sourceWindowIds: target.sourceWindowIds,
      authority: runAuthority,
    });
    this.#insertRunKnowledgeRevision(
      run.run_id,
      revision,
      null,
      expectedCatalog.document.evidence,
      undefined,
    );
    return {
      revision,
      bookChanged: scope !== "project",
      projectChanged: scope === "project",
    };
  }

  #expectedCatalogEntry(
    run: RunRow,
    normalizedSubject: string,
    kind: string,
    expectation: {
      readonly scope: KnowledgeScope;
      readonly revision: number;
    } | null,
  ): ActiveCatalogEntry | undefined {
    const entries = this.#activeCatalogEntries(run, normalizedSubject, kind);
    if (expectation === null) {
      if (entries.length > 0) {
        throw new Error(
          "KNOWLEDGE_CATALOG_REVISION_CONFLICT: catalog entry already exists",
        );
      }
      return undefined;
    }
    const entry = entries.find(
      (candidate) => candidate.document.authority.scope === expectation.scope,
    );
    if (entry === undefined || entry.row.revision !== expectation.revision) {
      throw new Error(
        "KNOWLEDGE_CATALOG_REVISION_CONFLICT: catalog entry changed; reload before saving",
      );
    }
    if (entries.some((candidate) =>
      candidate !== entry
      && compareAuthority(
        candidate.document.authority,
        entry.document.authority,
      ) >= 0)) {
      throw new Error(
        "KNOWLEDGE_CATALOG_REVISION_CONFLICT: a stronger catalog override exists",
      );
    }
    return entry;
  }

  #importAliasMergeCommand(
    domain: KnowledgeStore,
    command: UpdateKnowledgeCommand,
  ): UpdateKnowledgeCommand {
    if (command.objectType === "alias") {
      const alias = command.fieldPatch.alias;
      const entityId = command.fieldPatch.entityId;
      if (typeof alias !== "string" || typeof entityId !== "string") {
        throw new Error("KNOWLEDGE_IMPORT_ALIAS_MERGE_INVALID");
      }
      return {
        ...command,
        normalizedSubject: `${alias} -> ${entityId}`,
      };
    }
    if (command.objectType !== "term" && command.objectType !== "entity") {
      throw new Error("KNOWLEDGE_IMPORT_ALIAS_MERGE_NOT_ALLOWED");
    }
    const current = domain.activeKnowledge(
      command.normalizedSubject,
      command.kind,
    );
    if (current === undefined
      || current.payload === null
      || typeof current.payload !== "object"
      || Array.isArray(current.payload)) {
      throw new Error("KNOWLEDGE_IMPORT_ALIAS_MERGE_TARGET_MISSING");
    }
    const currentPayload = current.payload as Record<string, unknown>;
    const values: string[] = [];
    const add = (value: unknown): void => {
      if (typeof value === "string" && value.trim().length > 0) {
        values.push(value.normalize("NFKC").trim());
      } else if (Array.isArray(value)) {
        for (const item of value) add(item);
      }
    };
    const field = command.objectType === "term" ? "sourceForms" : "aliases";
    if (command.objectType === "term") {
      add(currentPayload.sourceForm);
      add(currentPayload.canonicalSource);
      add(currentPayload.sourceForms);
      add(command.fieldPatch.sourceForm);
      add(command.fieldPatch.canonicalSource);
      add(command.fieldPatch.sourceForms);
    } else {
      add(currentPayload.canonicalName);
      add(currentPayload.aliases);
      add(command.fieldPatch.canonicalName);
      add(command.fieldPatch.aliases);
    }
    const unique = [...new Set(values)].sort(compareText);
    if (unique.length === 0) {
      throw new Error("KNOWLEDGE_IMPORT_ALIAS_MERGE_EMPTY");
    }
    return {
      ...command,
      fieldPatch: { [field]: unique },
      ownedFields: [`/${field}`],
    };
  }

  #effectiveCatalogEntry(
    run: RunRow,
    normalizedSubject: string,
    kind: string,
  ): ActiveCatalogEntry | undefined {
    let effective: ActiveCatalogEntry | undefined;
    for (const entry of this.#activeCatalogEntries(
      run,
      normalizedSubject,
      kind,
    )) {
      if (effective === undefined) {
        effective = entry;
        continue;
      }
      const comparison = compareAuthority(
        entry.document.authority,
        effective.document.authority,
      );
      if (comparison > 0) {
        effective = entry;
      } else if (comparison === 0
        && canonicalJson(entry.document) !== canonicalJson(effective.document)) {
        throw new Error(
          `KNOWLEDGE_AUTHORITY_CONFLICT: ${normalizedSubject}/${kind}`,
        );
      }
    }
    return effective;
  }

  #activeCatalogEntries(
    run: RunRow,
    normalizedSubject: string,
    kind: string,
  ): ActiveCatalogEntry[] {
    const recordId = knowledgeRecordId(normalizedSubject, kind);
    const rows = [
      ...all<CatalogKnowledgeRow>(this.#database.prepare(`
        SELECT source_version, record_id, revision, revision_id, object_type,
               normalized_subject, kind, document_json, origin, scope, active
        FROM book_knowledge_revisions
        WHERE source_version=? AND record_id=? AND active=1
      `), run.source_version, recordId),
      ...all<CatalogKnowledgeRow>(this.#database.prepare(`
        SELECT NULL AS source_version, record_id, revision, revision_id, object_type,
               normalized_subject, kind, document_json, origin, scope, active
        FROM project_knowledge_revisions
        WHERE record_id=? AND active=1
      `), recordId),
    ];
    return rows.map((row) =>
      this.#catalogEntryFromRow(row, normalizedSubject, kind));
  }

  #catalogEntryFromRow(
    row: CatalogKnowledgeRow,
    normalizedSubject = row.normalized_subject,
    kind = row.kind,
  ): ActiveCatalogEntry {
    const document = validateCatalogKnowledgeDocument(
      JSON.parse(row.document_json) as unknown,
    );
    if (row.record_id !== knowledgeRecordId(normalizedSubject, kind)
      || row.normalized_subject !== normalizedSubject
      || row.kind !== kind
      || row.object_type !== document.objectType
      || row.normalized_subject !== document.normalizedSubject
      || row.kind !== document.kind
      || row.origin !== document.authority.origin
      || row.scope !== document.authority.scope
      || (row.active !== 0 && row.active !== 1)
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1
      || (row.scope === "project"
        ? row.source_version !== null
        : typeof row.source_version !== "string"
          || row.source_version.length === 0)) {
      throw new Error(`corrupt catalog knowledge revision ${row.revision_id}`);
    }
    const expectedRevisionId = hashText(canonicalJson({
      catalogVersion: 1,
      sourceVersion: row.scope === "project" ? null : row.source_version,
      recordId: row.record_id,
      revision: row.revision,
      document,
    }));
    if (row.revision_id !== expectedRevisionId) {
      throw new Error(`corrupt catalog knowledge revision ${row.revision_id}`);
    }
    return { row, document };
  }

  #appendCatalogRevision(
    run: RunRow,
    documentInput: CatalogKnowledgeDocument,
    active: boolean,
    allowGlobalSnapshot = false,
  ): CatalogKnowledgeRow {
    const document = validateCatalogKnowledgeDocument(documentInput);
    const scope = document.authority.scope;
    if (scope === "global"
      && (!allowGlobalSnapshot || document.globalRevisionId === undefined)) {
      throw new Error(
        "global knowledge must be snapshotted through the global knowledge workflow",
      );
    }
    if (document.authority.origin === "model") {
      throw new Error("model knowledge cannot be written to a user catalog");
    }
    const recordId = knowledgeRecordId(
      document.normalizedSubject,
      document.kind,
    );
    const isProject = scope === "project";
    const revision = isProject
      ? (one<{ revision: number }>(this.#database.prepare(`
          SELECT MAX(revision) AS revision FROM project_knowledge_revisions
          WHERE record_id=?
        `), recordId)?.revision ?? 0) + 1
      : (one<{ revision: number }>(this.#database.prepare(`
          SELECT MAX(revision) AS revision FROM book_knowledge_revisions
          WHERE source_version=? AND record_id=?
        `), run.source_version, recordId)?.revision ?? 0) + 1;
    const revisionId = hashText(canonicalJson({
      catalogVersion: 1,
      sourceVersion: isProject ? null : run.source_version,
      recordId,
      revision,
      document,
    }));
    if (isProject) {
      this.#database.prepare(`
        UPDATE project_knowledge_revisions SET active=0
        WHERE record_id=? AND active=1
      `).run(recordId);
      this.#database.prepare(`
        INSERT INTO project_knowledge_revisions(
          record_id, revision, revision_id, object_type, normalized_subject,
          kind, document_json, origin, scope, active
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'project', ?)
      `).run(
        recordId,
        revision,
        revisionId,
        document.objectType,
        document.normalizedSubject,
        document.kind,
        canonicalJson(document),
        document.authority.origin,
        active ? 1 : 0,
      );
    } else {
      this.#database.prepare(`
        UPDATE book_knowledge_revisions SET active=0
        WHERE source_version=? AND record_id=? AND active=1
      `).run(run.source_version, recordId);
      this.#database.prepare(`
        INSERT INTO book_knowledge_revisions(
          source_version, record_id, revision, revision_id, object_type,
          normalized_subject, kind, document_json, origin, scope, active
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.source_version,
        recordId,
        revision,
        revisionId,
        document.objectType,
        document.normalizedSubject,
        document.kind,
        canonicalJson(document),
        document.authority.origin,
        scope,
        active ? 1 : 0,
      );
    }
    return {
      source_version: isProject ? null : run.source_version,
      record_id: recordId,
      revision,
      revision_id: revisionId,
      object_type: document.objectType,
      normalized_subject: document.normalizedSubject,
      kind: document.kind,
      document_json: canonicalJson(document),
      origin: document.authority.origin,
      scope,
      active: active ? 1 : 0,
    };
  }

  #insertRunKnowledgeRevision(
    runId: string,
    revision: KnowledgeRevision,
    producingWindowId: string | null,
    evidence: readonly KnowledgeEvidence[],
    importBatchId: string | undefined,
  ): void {
    const recordId = knowledgeRecordId(
      revision.normalizedSubject,
      revision.kind,
    );
    const authority = revision.authority === undefined
      ? undefined
      : normalizeKnowledgeAuthority(revision.authority);
    this.#database.prepare(`
      UPDATE knowledge_records SET active=0
      WHERE run_id=? AND record_id=? AND active=1
    `).run(runId, recordId);
    this.#database.prepare(`
      INSERT INTO knowledge_records(
        run_id, record_id, revision_id, revision, normalized_subject, kind,
        payload_json, status, active, producing_window_id, origin, scope,
        owned_fields_json, evidence_json, import_batch_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      recordId,
      revision.revisionId,
      revision.revision,
      revision.normalizedSubject,
      revision.kind,
      canonicalJson(revision),
      revision.status,
      PROJECTABLE_KNOWLEDGE_STATUSES.has(revision.status) ? 1 : 0,
      producingWindowId,
      authority?.origin ?? "model",
      authority?.scope ?? "book",
      canonicalJson(authority?.ownedFields ?? []),
      canonicalJson(evidence),
      importBatchId ?? null,
    );
  }

  #insertKnowledgeImpactsForRevision(
    run: RunRow,
    revision: KnowledgeRevision,
  ): void {
    this.#insertKnowledgeImpactsForRevisions(run, [revision]);
  }

  #insertKnowledgeImpactsForRevisions(
    run: RunRow,
    revisions: readonly KnowledgeRevision[],
  ): void {
    const revisionForms = revisions.map((revision) => ({
      revisionId: revision.revisionId,
      forms: sourceFormsFromRevision(revision),
    })).filter((revision) => revision.forms.length > 0);
    if (revisionForms.length === 0) return;
    const source = this.#source(run.source_version);
    const sourcePayload = JSON.parse(source.source_payload_json) as {
      sourceLanguage?: unknown;
    };
    const profile = getSourceLanguageProfile(
      typeof sourcePayload.sourceLanguage === "string"
        ? sourcePayload.sourceLanguage
        : undefined,
    );
    const blocks = all<{
      source_version: string;
      block_id: string;
      source_text: string;
    }>(this.#database.prepare(`
      SELECT DISTINCT b.source_version, b.block_id, b.source_text
      FROM translations AS t
      JOIN logical_blocks AS b
        ON b.source_version=t.source_version AND b.block_id=t.block_id
      WHERE t.run_id=? AND t.active=1 AND b.source_version=?
      ORDER BY b.global_index, b.block_id
    `), run.run_id, run.source_version);
    const insert = this.#database.prepare(`
      INSERT OR IGNORE INTO knowledge_block_impacts(
        run_id, revision_id, source_version, block_id, reason
      ) VALUES(?, ?, ?, ?, 'explicit_source_form_match')
    `);
    const matches = matchKnowledgeImpacts(
      revisionForms,
      blocks.map((block) => ({
        sourceVersion: block.source_version,
        blockId: block.block_id,
        sourceText: block.source_text,
      })),
      profile,
    );
    for (const match of matches) {
      insert.run(
        run.run_id,
        match.revisionId,
        match.sourceVersion,
        match.blockId,
      );
    }
  }

  #knowledgeQueryGeneration(
    run: RunRow,
    state: KnowledgeStateView,
  ): string {
    return hashText(canonicalJson({
      schema: "folioloom-knowledge-query-generation-1",
      runId: run.run_id,
      sourceVersion: run.source_version,
      generation: state.generation,
      snapshotId: state.snapshotId,
      bookGeneration: state.appliedBookGeneration,
      projectGeneration: state.appliedProjectGeneration,
    }));
  }

  #storedKnowledgeRevision(
    runId: string,
    row: StoredKnowledgeSummaryRow | StoredKnowledgeRevisionRow,
  ): KnowledgeRevision {
    const revision = parsedKnowledgeRevision(row.payload_json);
    if (row.run_id !== runId
      || row.record_id !== knowledgeRecordId(
        row.normalized_subject,
        row.kind,
      )
      || revision.revisionId !== row.revision_id
      || revision.revision !== row.revision
      || revision.normalizedSubject !== row.normalized_subject
      || revision.kind !== row.kind
      || revision.status !== row.status
      || !Array.isArray(revision.alternatives)
      || !Array.isArray(revision.candidateIds)
      || !Array.isArray(revision.sourceWindowIds)) {
      throw new Error(`corrupt knowledge revision row ${row.revision_id}`);
    }
    const {
      revisionId: _revisionId,
      ...revisionContent
    } = revision;
    if (hashText(canonicalJson(revisionContent)) !== revision.revisionId) {
      throw new Error(`corrupt knowledge revision hash ${row.revision_id}`);
    }
    const authority = revision.authority === undefined
      ? undefined
      : normalizeKnowledgeAuthority(revision.authority);
    const ownedFields = JSON.parse(row.owned_fields_json) as unknown;
    if (row.origin !== (authority?.origin ?? "model")
      || row.scope !== (authority?.scope ?? "book")
      || canonicalJson(ownedFields) !== canonicalJson(
        authority?.ownedFields ?? [],
      )) {
      throw new Error(`corrupt knowledge authority row ${row.revision_id}`);
    }
    if ("evidence_json" in row) {
      const evidence = validateKnowledgeEvidence(
        JSON.parse(row.evidence_json) as unknown,
      );
      if (authority?.provenance !== undefined
        && canonicalJson(evidence) !== canonicalJson(
          this.#catalogEvidenceForRevision(revision),
        )) {
        throw new Error(`corrupt knowledge evidence row ${row.revision_id}`);
      }
    }
    return revision;
  }

  #relatedKnowledgeRecords(
    run: RunRow,
    rawIdentifiers: readonly string[],
    limit: number,
  ): readonly KnowledgeQueryRecord[] {
    if (!Array.isArray(rawIdentifiers) || rawIdentifiers.length > 16) {
      throw new RangeError("knowledge relation identifiers must contain at most 16 values");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("knowledge relation limit must be between 1 and 200");
    }
    const identifiers = [...new Set(rawIdentifiers.map((value) => {
      requireNonempty(value, "knowledge relation identifier");
      if (value.length > 512) {
        throw new RangeError("knowledge relation identifier is too long");
      }
      return value;
    }))];
    if (identifiers.length === 0) return Object.freeze([]);
    const placeholders = identifiers.map(() => "?").join(", ");
    const rows = all<{ record_id: string }>(this.#database.prepare(`
      SELECT records.record_id
      FROM knowledge_records AS records
      LEFT JOIN project_knowledge_revisions AS project_catalog
        ON json_extract(
          records.payload_json,
          '$.authority.provenance.catalog'
        ) = 'project'
       AND project_catalog.revision_id = json_extract(
         records.payload_json,
         '$.authority.provenance.catalogRevisionId'
       )
      LEFT JOIN book_knowledge_revisions AS book_catalog
        ON json_extract(
          records.payload_json,
          '$.authority.provenance.catalog'
        ) = 'book'
       AND book_catalog.source_version = ?
       AND book_catalog.revision_id = json_extract(
         records.payload_json,
         '$.authority.provenance.catalogRevisionId'
       )
      WHERE records.run_id = ?
        AND records.active = 1
        AND COALESCE(
          project_catalog.object_type,
          book_catalog.object_type,
          folioloom_knowledge_object_type(records.payload_json)
        ) = 'relation'
        AND (
          json_extract(records.payload_json, '$.payload.fromEntityId')
            IN (${placeholders})
          OR json_extract(records.payload_json, '$.payload.subjectId')
            IN (${placeholders})
          OR json_extract(records.payload_json, '$.payload.toEntityId')
            IN (${placeholders})
          OR json_extract(records.payload_json, '$.payload.objectId')
            IN (${placeholders})
        )
      ORDER BY records.normalized_subject, records.kind, records.record_id
      LIMIT ?
    `),
    run.source_version,
    run.run_id,
    ...identifiers,
    ...identifiers,
    ...identifiers,
    ...identifiers,
    limit);
    return Object.freeze(rows.map((row) => {
      const record = this.#knowledgeQueryRecord(run, row.record_id);
      if (record === undefined || record.objectType !== "relation") {
        throw new Error(`corrupt relation knowledge row ${row.record_id}`);
      }
      return record;
    }));
  }

  #knowledgeDiagnostics(run: RunRow): KnowledgeDiagnosticsSummary {
    const base = `
      FROM knowledge_records AS records
      LEFT JOIN project_knowledge_revisions AS project_catalog
        ON json_extract(
          records.payload_json,
          '$.authority.provenance.catalog'
        ) = 'project'
       AND project_catalog.revision_id = json_extract(
         records.payload_json,
         '$.authority.provenance.catalogRevisionId'
       )
      LEFT JOIN book_knowledge_revisions AS book_catalog
        ON json_extract(
          records.payload_json,
          '$.authority.provenance.catalog'
        ) = 'book'
       AND book_catalog.source_version = ?
       AND book_catalog.revision_id = json_extract(
         records.payload_json,
         '$.authority.provenance.catalogRevisionId'
       )
      WHERE records.run_id = ? AND records.active = 1
    `;
    const typeRows = all<{ key: string; count: number }>(
      this.#database.prepare(`
        SELECT COALESCE(
          project_catalog.object_type,
          book_catalog.object_type,
          folioloom_knowledge_object_type(records.payload_json)
        ) AS key, COUNT(*) AS count
        ${base}
        GROUP BY key
        ORDER BY key
      `),
      run.source_version,
      run.run_id,
    );
    const statusRows = all<{ key: string; count: number }>(
      this.#database.prepare(`
        SELECT records.status AS key, COUNT(*) AS count
        ${base}
        GROUP BY records.status
        ORDER BY records.status
      `),
      run.source_version,
      run.run_id,
    );
    const countsByType: Partial<Record<KnowledgeObjectType, number>> = {};
    for (const row of typeRows) {
      if (!["term", "entity", "alias", "relation", "memory", "style"]
        .includes(row.key)) {
        throw new Error(`corrupt knowledge object type ${row.key}`);
      }
      countsByType[row.key as KnowledgeObjectType] = row.count;
    }
    const countsByStatus: Partial<Record<KnowledgeStatus, number>> = {};
    for (const row of statusRows) {
      if (![
        "candidate",
        "provisional",
        "active",
        "needs_revalidate",
        "contextual",
        "superseded",
      ].includes(row.key)) {
        throw new Error(`corrupt knowledge status ${row.key}`);
      }
      countsByStatus[row.key as KnowledgeStatus] = row.count;
    }
    const pendingImpacts = one<{ count: number }>(this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_block_impacts AS impacts
      JOIN knowledge_records AS records
        ON records.run_id = impacts.run_id
       AND records.revision_id = impacts.revision_id
       AND records.active = 1
      WHERE impacts.run_id = ? AND impacts.status = 'pending'
    `), run.run_id)?.count ?? 0;
    return Object.freeze({
      countsByType: Object.freeze(countsByType),
      countsByStatus: Object.freeze(countsByStatus),
      pendingImpacts,
    });
  }

  #queryKnowledgeRecordsPage(
    run: RunRow,
    query: KnowledgeRecordPageQuery,
  ): readonly KnowledgeQueryRecord[] {
    if (!Number.isSafeInteger(query.limit)
      || query.limit < 1
      || query.limit > 201) {
      throw new RangeError("knowledge page source limit must be between 1 and 201");
    }
    const clauses = ["1 = 1"];
    const parameters: (string | number)[] = [
      run.source_version,
      run.run_id,
    ];
    const appendSetFilter = (
      column: string,
      values: readonly string[],
    ): void => {
      if (values.length === 0) return;
      clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
      parameters.push(...values);
    };
    appendSetFilter("object_type", query.objectTypes);
    appendSetFilter("status", query.statuses);
    appendSetFilter("origin", query.origins);
    appendSetFilter("scope", query.scopes);
    if (query.search !== null) {
      clauses.push(
        "folioloom_knowledge_matches(payload_json, object_type, ?) = 1",
      );
      parameters.push(query.search);
    }
    if (query.after !== undefined) {
      clauses.push(
        "(normalized_subject, kind, record_id) > (?, ?, ?)",
      );
      parameters.push(
        query.after.normalizedSubject,
        query.after.kind,
        query.after.id,
      );
    }
    parameters.push(query.limit);
    const rows = all<KnowledgePageRow>(this.#database.prepare(`
      WITH active_knowledge AS (
        SELECT
          records.run_id,
          records.record_id,
          records.revision_id,
          records.revision,
          records.normalized_subject,
          records.kind,
          records.payload_json,
          records.status,
          records.active,
          records.origin,
          records.scope,
          records.owned_fields_json,
          COALESCE(
            project_catalog.object_type,
            book_catalog.object_type,
            folioloom_knowledge_object_type(records.payload_json)
          ) AS object_type,
          COALESCE(
            project_catalog.object_type,
            book_catalog.object_type
          ) AS catalog_object_type,
          COALESCE(
            project_catalog.revision,
            book_catalog.revision
          ) AS scope_revision,
          COALESCE(
            project_catalog.scope,
            book_catalog.scope
          ) AS scope_revision_scope,
          json_extract(
            records.payload_json,
            '$.authority.provenance.catalog'
          ) AS provenance_catalog,
          json_extract(
            records.payload_json,
            '$.authority.provenance.catalogRevisionId'
          ) AS provenance_revision_id
        FROM knowledge_records AS records
        LEFT JOIN project_knowledge_revisions AS project_catalog
          ON json_extract(
            records.payload_json,
            '$.authority.provenance.catalog'
          ) = 'project'
         AND project_catalog.revision_id = json_extract(
           records.payload_json,
           '$.authority.provenance.catalogRevisionId'
         )
        LEFT JOIN book_knowledge_revisions AS book_catalog
          ON json_extract(
            records.payload_json,
            '$.authority.provenance.catalog'
          ) = 'book'
         AND book_catalog.source_version = ?
         AND book_catalog.revision_id = json_extract(
           records.payload_json,
           '$.authority.provenance.catalogRevisionId'
         )
        WHERE records.run_id = ? AND records.active = 1
      )
      SELECT *
      FROM active_knowledge
      WHERE ${clauses.join(" AND ")}
      ORDER BY normalized_subject, kind, record_id
      LIMIT ?
    `), ...parameters).map((row) => {
      const revision = this.#storedKnowledgeRevision(run.run_id, row);
      const objectType = row.object_type as KnowledgeObjectType;
      if (![
        "term",
        "entity",
        "alias",
        "relation",
        "memory",
        "style",
      ].includes(objectType)) {
        throw new Error(`corrupt knowledge object type ${row.object_type}`);
      }
      const provenance = revision.authority?.provenance;
      if (provenance === undefined) {
        if (row.catalog_object_type !== null
          || row.scope_revision !== null
          || row.scope_revision_scope !== null
          || row.provenance_catalog !== null
          || row.provenance_revision_id !== null) {
          throw new Error(`corrupt knowledge catalog metadata ${row.revision_id}`);
        }
      } else if (
        row.catalog_object_type === null
        || row.scope_revision === null
        || row.scope_revision_scope === null
        || row.provenance_catalog !== provenance.catalog
        || row.provenance_revision_id !== provenance.catalogRevisionId
      ) {
        throw new Error(
          `corrupt knowledge catalog provenance ${provenance.catalogRevisionId}`,
        );
      }
      return Object.freeze({
        id: row.record_id,
        objectType,
        revision,
        scopeRevision: row.scope_revision === null
          ? null
          : {
            scope: row.scope_revision_scope as KnowledgeScope,
            revision: row.scope_revision,
          },
        evidence: Object.freeze([]),
        history: Object.freeze([]),
        impacts: Object.freeze([]),
      });
    });
    return Object.freeze(rows);
  }

  #knowledgeQueryRecord(
    run: RunRow,
    recordId: string,
  ): KnowledgeQueryRecord | undefined {
    const rows = all<StoredKnowledgeRevisionRow>(this.#database.prepare(`
      SELECT run_id, record_id, revision_id, revision, normalized_subject, kind,
             payload_json, status, active, origin, scope, owned_fields_json,
             evidence_json, import_batch_id
      FROM knowledge_records
      WHERE run_id=? AND record_id=?
      ORDER BY revision
    `), run.run_id, recordId);
    if (rows.length === 0) return undefined;
    const activeRows = rows.filter((row) => row.active === 1);
    if (activeRows.length === 0) return undefined;
    if (activeRows.length !== 1) {
      throw new Error(`corrupt active knowledge query row ${recordId}`);
    }
    const history = new KnowledgeStore(
      rows.map((row) => this.#storedKnowledgeRevision(run.run_id, row)),
    ).listRevisions();
    const activeRow = activeRows[0]!;
    const revision = history.find(
      (candidate) => candidate.revisionId === activeRow.revision_id,
    );
    if (revision === undefined
      || history.at(-1)?.revisionId !== revision.revisionId
      || !PROJECTABLE_KNOWLEDGE_STATUSES.has(revision.status)) {
      throw new Error(`corrupt active knowledge query row ${recordId}`);
    }
    const catalog = this.#catalogMetadataForRevision(run, revision);
    return Object.freeze({
      id: recordId,
      objectType: catalog?.objectType ?? knowledgeObjectType(revision),
      revision,
      scopeRevision: catalog?.scopeRevision ?? null,
      evidence: Object.freeze(this.#resolvedKnowledgeEvidence(
        run,
        revision,
        JSON.parse(activeRow.evidence_json) as unknown,
      )),
      history: Object.freeze([...history]),
      impacts: Object.freeze(this.#knowledgeImpacts(run, revision)),
    });
  }

  #catalogMetadataForRevision(
    run: RunRow,
    revision: KnowledgeRevision,
  ): {
    readonly objectType: KnowledgeObjectType;
    readonly scopeRevision: {
      readonly scope: KnowledgeScope;
      readonly revision: number;
    };
  } | undefined {
    const provenance = revision.authority?.provenance;
    if (provenance === undefined) return undefined;
    const row = provenance.catalog === "project"
      ? one<CatalogKnowledgeRow>(this.#database.prepare(`
          SELECT NULL AS source_version, record_id, revision, revision_id,
                 object_type, normalized_subject, kind, document_json,
                 origin, scope, active
          FROM project_knowledge_revisions WHERE revision_id=?
        `), provenance.catalogRevisionId)
      : one<CatalogKnowledgeRow>(this.#database.prepare(`
          SELECT source_version, record_id, revision, revision_id,
                 object_type, normalized_subject, kind, document_json,
                 origin, scope, active
          FROM book_knowledge_revisions
          WHERE source_version=? AND revision_id=?
        `), run.source_version, provenance.catalogRevisionId);
    if (row === undefined) {
      throw new Error(
        `corrupt knowledge catalog provenance ${provenance.catalogRevisionId}`,
      );
    }
    const entry = this.#catalogEntryFromRow(
      row,
      revision.normalizedSubject,
      revision.kind,
    );
    return {
      objectType: entry.document.objectType,
      scopeRevision: {
        scope: entry.document.authority.scope,
        revision: row.revision,
      },
    };
  }

  #resolvedKnowledgeEvidence(
    run: RunRow,
    revision: KnowledgeRevision,
    rawEvidence: unknown,
  ): KnowledgeEvidence[] {
    const evidence = [...validateKnowledgeEvidence(rawEvidence)];
    const seenWindows = new Set(evidence
      .filter((item) => item.kind === "source_window")
      .map((item) => item.sourceWindowId));
    for (const sourceWindowId of revision.sourceWindowIds) {
      if (!seenWindows.has(sourceWindowId)) {
        evidence.push({ kind: "source_window", sourceWindowId });
        seenWindows.add(sourceWindowId);
      }
    }
    return evidence.map((item): KnowledgeEvidence => {
      if (item.kind === "user_note") return item;
      if (item.kind === "source_window") {
        const present = one<{ present: number }>(this.#database.prepare(`
          SELECT 1 AS present FROM window_plans
          WHERE run_id=? AND window_id=? AND source_version=?
        `), run.run_id, item.sourceWindowId, run.source_version);
        if (present === undefined) {
          throw new Error("KNOWLEDGE_EVIDENCE_POSITION_MISMATCH");
        }
        return item;
      }
      const block = one<{
        canonical_start: number;
        canonical_end: number;
        source_text: string;
      }>(this.#database.prepare(`
        SELECT canonical_start, canonical_end, source_text
        FROM logical_blocks WHERE source_version=? AND block_id=?
      `), run.source_version, item.blockId);
      if (block === undefined) {
        throw new Error("KNOWLEDGE_EVIDENCE_POSITION_MISMATCH");
      }
      const scalars = [...block.source_text];
      let start = item.canonicalStart;
      let end = item.canonicalEnd;
      if ((start === undefined) !== (end === undefined)) {
        throw new Error("KNOWLEDGE_EVIDENCE_POSITION_MISMATCH");
      }
      if (start === undefined && end === undefined && item.quote !== undefined) {
        const index = block.source_text.indexOf(item.quote);
        if (index < 0) {
          throw new Error("KNOWLEDGE_EVIDENCE_POSITION_MISMATCH");
        }
        start = block.canonical_start
          + [...block.source_text.slice(0, index)].length;
        end = start + scalarLength(item.quote);
      }
      if (start === undefined || end === undefined) {
        start = block.canonical_start;
        end = Math.min(block.canonical_end, start + 160);
      }
      if (start < block.canonical_start
        || end < start
        || end > block.canonical_end) {
        throw new Error("KNOWLEDGE_EVIDENCE_POSITION_MISMATCH");
      }
      const relativeStart = start - block.canonical_start;
      const relativeEnd = end - block.canonical_start;
      const exact = scalars.slice(relativeStart, relativeEnd).join("");
      if (item.quote !== undefined && item.quote !== exact) {
        throw new Error("KNOWLEDGE_EVIDENCE_POSITION_MISMATCH");
      }
      if (scalarLength(exact) > 160) {
        end = start + 160;
      }
      return {
        kind: "source_block",
        blockId: item.blockId,
        canonicalStart: start,
        canonicalEnd: end,
        quote: scalars.slice(
          relativeStart,
          relativeStart + (end - start),
        ).join(""),
      };
    });
  }

  #knowledgeImpacts(
    run: RunRow,
    revision: KnowledgeRevision,
  ): KnowledgeImpactView[] {
    const forms = sourceFormsFromRevision(revision);
    const source = this.#source(run.source_version);
    const sourcePayload = JSON.parse(source.source_payload_json) as {
      sourceLanguage?: unknown;
    };
    const profile = getSourceLanguageProfile(
      typeof sourcePayload.sourceLanguage === "string"
        ? sourcePayload.sourceLanguage
        : undefined,
    );
    return all<{
      block_id: string;
      global_index: number;
      source_version: string;
      status: "pending" | "acknowledged" | "retranslated";
      reason: string;
      source_text: string;
    }>(this.#database.prepare(`
      SELECT i.block_id, b.global_index, i.source_version, i.status,
             i.reason, b.source_text
      FROM knowledge_block_impacts AS i
      JOIN logical_blocks AS b
        ON b.source_version=i.source_version AND b.block_id=i.block_id
      WHERE i.run_id=? AND i.revision_id=? AND i.source_version=?
      ORDER BY b.global_index, i.block_id
    `), run.run_id, revision.revisionId, run.source_version).map((row) => ({
      blockId: row.block_id,
      globalIndex: row.global_index,
      sourceVersion: row.source_version,
      status: row.status,
      reason: row.reason,
      sourceExcerpt: shortSourceExcerpt(row.source_text, forms, profile),
    }));
  }

  #activeRunKnowledgeEvidence(
    runId: string,
    recordId: string,
  ): readonly KnowledgeEvidence[] {
    const row = one<{ evidence_json: string }>(this.#database.prepare(`
      SELECT evidence_json FROM knowledge_records
      WHERE run_id=? AND record_id=? AND active=1
    `), runId, recordId);
    if (row === undefined) {
      return [];
    }
    const parsed = JSON.parse(row.evidence_json) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`corrupt evidence JSON for ${recordId}`);
    }
    return parsed as KnowledgeEvidence[];
  }

  #catalogSeedRevisions(
    runId: string,
    sourceVersion: string,
  ): readonly KnowledgeRevision[] {
    const rows = [
      ...all<CatalogKnowledgeRow>(this.#database.prepare(`
        SELECT NULL AS source_version, record_id, revision, revision_id, object_type,
               normalized_subject, kind, document_json, origin, scope, active
        FROM project_knowledge_revisions WHERE active=1
      `)),
      ...all<CatalogKnowledgeRow>(this.#database.prepare(`
        SELECT source_version, record_id, revision, revision_id, object_type,
               normalized_subject, kind, document_json, origin, scope, active
        FROM book_knowledge_revisions
        WHERE source_version=? AND active=1
      `), sourceVersion),
    ];
    const effective = new Map<string, ActiveCatalogEntry>();
    for (const row of rows) {
      const entry = this.#catalogEntryFromRow(row);
      const key = knowledgeKey(
        entry.document.normalizedSubject,
        entry.document.kind,
      );
      const previous = effective.get(key);
      if (previous === undefined) {
        effective.set(key, entry);
        continue;
      }
      const comparison = compareAuthority(
        entry.document.authority,
        previous.document.authority,
      );
      if (comparison > 0) {
        effective.set(key, entry);
      } else if (comparison === 0
        && canonicalJson(entry.document) !== canonicalJson(previous.document)) {
        throw new Error(
          `KNOWLEDGE_AUTHORITY_CONFLICT: catalog seed differs for ${key}`,
        );
      }
    }
    const domain = new KnowledgeStore();
    for (const entry of [...effective.values()].sort((left, right) =>
      compareText(left.document.normalizedSubject, right.document.normalizedSubject)
      || compareText(left.document.kind, right.document.kind))) {
      const catalogScope = entry.document.authority.scope;
      const authority = normalizeKnowledgeAuthority({
        ...entry.document.authority,
        provenance: {
          catalog: catalogScope === "project" ? "project" : "book",
          catalogRevisionId: entry.row.revision_id,
          ...(entry.document.globalRevisionId === undefined
            ? {}
            : { globalRevisionId: entry.document.globalRevisionId }),
        },
      });
      domain.appendRevision({
        normalizedSubject: entry.document.normalizedSubject,
        kind: entry.document.kind,
        payload: entry.document.payload,
        alternatives: entry.document.alternatives,
        status: entry.document.status,
        authority,
      });
    }
    return domain.listRevisions();
  }

  #catalogEvidenceForRevision(
    revision: KnowledgeRevision,
  ): readonly KnowledgeEvidence[] {
    const provenance = revision.authority?.provenance;
    if (provenance === undefined) {
      return [];
    }
    const row = provenance.catalog === "project"
      ? one<CatalogKnowledgeRow>(this.#database.prepare(`
          SELECT NULL AS source_version, record_id, revision, revision_id, object_type,
                 normalized_subject, kind, document_json, origin, scope, active
          FROM project_knowledge_revisions WHERE revision_id=?
        `), provenance.catalogRevisionId)
      : one<CatalogKnowledgeRow>(this.#database.prepare(`
          SELECT source_version, record_id, revision, revision_id, object_type,
                 normalized_subject, kind, document_json, origin, scope, active
          FROM book_knowledge_revisions WHERE revision_id=?
        `), provenance.catalogRevisionId);
    if (row === undefined) {
      throw new Error(
        `catalog provenance ${provenance.catalogRevisionId} is missing`,
      );
    }
    return this.#catalogEntryFromRow(row).document.evidence;
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

const LEDGER_EVENT_KINDS = {
  baseline_added: "token_ledger_baseline_added",
  reserved: "token_ledger_reserved",
  dispatched: "token_ledger_dispatched",
  settled: "token_ledger_settled",
  released: "token_ledger_released",
  counters_patched: "token_ledger_counters_patched",
} as const;

function ledgerEventKind(type: LedgerEvent["type"]): string {
  const kind = LEDGER_EVENT_KINDS[type];
  if (kind === undefined) {
    throw new TypeError(`unknown ledger event type: ${String(type)}`);
  }
  return kind;
}

function validateLedgerEvent(event: LedgerEvent): void {
  if (event === null || typeof event !== "object" || !("type" in event)) {
    throw new TypeError("ledger event must be an object with type");
  }
  // Round-trip through TokenLedger validates numeric and sequence rules for
  // standalone checks; store only needs structural presence for append.
  switch (event.type) {
    case "baseline_added":
      if (!Array.isArray(event.taskIds) || event.taskIds.length === 0) {
        throw new TypeError("baseline_added.taskIds must be non-empty");
      }
      if (!Number.isSafeInteger(event.baselineTokens) || event.baselineTokens < 0) {
        throw new TypeError("baseline_added.baselineTokens invalid");
      }
      return;
    case "reserved":
      if (typeof event.requestId !== "string" || event.requestId.trim() === "") {
        throw new TypeError("reserved.requestId invalid");
      }
      if (!Number.isSafeInteger(event.predictedTokens) || event.predictedTokens < 0) {
        throw new TypeError("reserved.predictedTokens invalid");
      }
      return;
    case "dispatched":
      if (typeof event.requestId !== "string" || event.requestId.trim() === "") {
        throw new TypeError("dispatched.requestId invalid");
      }
      return;
    case "settled":
      if (typeof event.requestId !== "string" || event.requestId.trim() === "") {
        throw new TypeError("settled.requestId invalid");
      }
      if (!Number.isSafeInteger(event.actualTokens) || event.actualTokens < 0) {
        throw new TypeError("settled.actualTokens invalid");
      }
      return;
    case "released":
      if (typeof event.requestId !== "string" || event.requestId.trim() === "") {
        throw new TypeError("released.requestId invalid");
      }
      return;
    case "counters_patched":
      if (event.patch === null || typeof event.patch !== "object") {
        throw new TypeError("counters_patched.patch invalid");
      }
      return;
    default: {
      const _exhaustive: never = event;
      throw new TypeError(`unknown ledger event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function parseLedgerEventPayload(kind: string, payloadJson: string): LedgerEvent {
  const payload = JSON.parse(payloadJson) as { event?: unknown };
  if (payload === null || typeof payload !== "object" || payload.event === undefined) {
    throw new Error(`corrupt token ledger event payload for kind ${kind}`);
  }
  const event = payload.event as LedgerEvent;
  validateLedgerEvent(event);
  const expected = LEDGER_EVENT_KINDS[event.type];
  if (expected !== kind) {
    throw new Error(
      `token ledger event kind mismatch: row ${kind} payload ${event.type}`,
    );
  }
  return event;
}

function validateSchedulerRunReport(report: unknown): asserts report is SchedulerRunReport {
  if (report === null || typeof report !== "object") {
    throw new TypeError("scheduler run report must be an object");
  }
  const value = report as Record<string, unknown>;
  for (const key of [
    "mode",
    "profile",
    "planningStatus",
    "decisions",
    "fallbacks",
    "baselineWallTimeMs",
    "predictedWallTimeMs",
    "actualWallTimeMs",
    "baselineTokens",
    "allowedTokens",
    "predictedTokens",
    "actualTokens",
    "tokenUsageComplete",
    "plannerDeadlines",
    "throttles",
    "recoveries",
  ] as const) {
    if (!(key in value)) {
      throw new TypeError(`scheduler run report missing ${key}`);
    }
  }
}
