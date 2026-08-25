import { createHash } from "node:crypto";

export const LOSSLESS_BOOK_SCHEMA_VERSION = 2;
export const LOSSLESS_BOOK_SCHEMA_MARKER = "deepnovel-lossless-book-store-v2-knowledge-history";
export const LOSSLESS_BOOK_SCHEMA_TABLES = [
  "events",
  "knowledge_candidates",
  "knowledge_records",
  "knowledge_snapshots",
  "logical_blocks",
  "lossless_schema_meta",
  "migration_candidates",
  "recovery_runs",
  "source_ranges",
  "source_versions",
  "structure_annotations",
  "translation_runs",
  "translations",
  "window_membership",
  "window_plans",
] as const;

export const LOSSLESS_BOOK_SCHEMA_V2_KNOWLEDGE_RECORDS = `  CREATE TABLE knowledge_records(
    run_id TEXT NOT NULL,
    record_id TEXT NOT NULL CHECK(length(trim(record_id)) > 0),
    revision_id TEXT NOT NULL CHECK(length(trim(revision_id)) > 0),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    normalized_subject TEXT NOT NULL CHECK(length(trim(normalized_subject)) > 0),
    kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    status TEXT NOT NULL
      CHECK(status IN ('candidate', 'provisional', 'active', 'needs_revalidate', 'contextual', 'superseded')),
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    producing_window_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, record_id, revision),
    UNIQUE(run_id, revision_id),
    FOREIGN KEY(run_id, producing_window_id)
      REFERENCES window_plans(run_id, window_id) ON DELETE RESTRICT
  ) STRICT;
`;

/**
 * Schema v2 is intentionally separate from the legacy BookStore schema.
 * Every mutable translation artifact is namespaced by a translation run.
 */
export const LOSSLESS_BOOK_SCHEMA_V2 = `
  CREATE TABLE lossless_schema_meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE source_versions(
    source_version TEXT PRIMARY KEY CHECK(length(trim(source_version)) > 0),
    raw_sha256 TEXT NOT NULL CHECK(length(trim(raw_sha256)) > 0),
    canonical_sha256 TEXT NOT NULL CHECK(length(trim(canonical_sha256)) > 0),
    canonical_chars INTEGER NOT NULL CHECK(canonical_chars >= 0),
    coordinate_unit TEXT NOT NULL CHECK(coordinate_unit = 'unicode_scalar'),
    source_format TEXT NOT NULL CHECK(length(trim(source_format)) > 0),
    encoding TEXT NOT NULL CHECK(length(trim(encoding)) > 0),
    extractor TEXT NOT NULL CHECK(length(trim(extractor)) > 0),
    source_fingerprint TEXT NOT NULL,
    source_payload_json TEXT NOT NULL CHECK(json_valid(source_payload_json)),
    plan_fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE source_ranges(
    source_version TEXT NOT NULL REFERENCES source_versions(source_version) ON DELETE RESTRICT,
    range_id TEXT NOT NULL CHECK(length(trim(range_id)) > 0),
    canonical_start INTEGER NOT NULL CHECK(canonical_start >= 0),
    canonical_end INTEGER NOT NULL CHECK(canonical_end >= canonical_start),
    origin_kind TEXT NOT NULL CHECK(length(trim(origin_kind)) > 0),
    origin_ref TEXT NOT NULL CHECK(length(trim(origin_ref)) > 0),
    transformation TEXT NOT NULL CHECK(length(trim(transformation)) > 0),
    raw_start INTEGER CHECK(raw_start IS NULL OR raw_start >= 0),
    raw_end INTEGER CHECK(raw_end IS NULL OR raw_end >= raw_start),
    PRIMARY KEY(source_version, range_id),
    UNIQUE(source_version, canonical_start, canonical_end)
  ) STRICT;

  CREATE TABLE structure_annotations(
    source_version TEXT NOT NULL REFERENCES source_versions(source_version) ON DELETE RESTRICT,
    annotation_id TEXT NOT NULL CHECK(length(trim(annotation_id)) > 0),
    kind TEXT NOT NULL CHECK(kind IN ('volume_heading', 'chapter_heading', 'prose', 'epigraph')),
    canonical_start INTEGER NOT NULL CHECK(canonical_start >= 0),
    canonical_end INTEGER NOT NULL CHECK(canonical_end >= canonical_start),
    title TEXT NOT NULL,
    boundary_weight REAL NOT NULL CHECK(boundary_weight >= 0),
    PRIMARY KEY(source_version, annotation_id)
  ) STRICT;

  CREATE TABLE logical_blocks(
    source_version TEXT NOT NULL REFERENCES source_versions(source_version) ON DELETE RESTRICT,
    block_id TEXT NOT NULL CHECK(length(trim(block_id)) > 0),
    canonical_start INTEGER NOT NULL CHECK(canonical_start >= 0),
    canonical_end INTEGER NOT NULL CHECK(canonical_end > canonical_start),
    source_text TEXT NOT NULL CHECK(length(source_text) > 0),
    source_hash TEXT NOT NULL CHECK(length(trim(source_hash)) > 0),
    global_index INTEGER NOT NULL CHECK(global_index >= 0),
    token_count INTEGER NOT NULL CHECK(token_count >= 0),
    structure_id TEXT,
    structure_title TEXT,
    PRIMARY KEY(source_version, block_id),
    UNIQUE(source_version, global_index),
    UNIQUE(source_version, block_id, source_hash),
    FOREIGN KEY(source_version, structure_id)
      REFERENCES structure_annotations(source_version, annotation_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE translation_runs(
    run_id TEXT PRIMARY KEY CHECK(length(trim(run_id)) > 0),
    source_version TEXT NOT NULL REFERENCES source_versions(source_version) ON DELETE RESTRICT,
    protocol_version TEXT NOT NULL CHECK(length(trim(protocol_version)) > 0),
    model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
    status TEXT NOT NULL DEFAULT 'created'
      CHECK(status IN ('created', 'running', 'completed', 'failed', 'quarantined')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, source_version)
  ) STRICT;

  CREATE TABLE knowledge_snapshots(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE RESTRICT,
    snapshot_id TEXT NOT NULL CHECK(length(trim(snapshot_id)) > 0),
    parent_snapshot_id TEXT,
    producing_window_id TEXT,
    content_hash TEXT NOT NULL CHECK(length(trim(content_hash)) > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, snapshot_id),
    FOREIGN KEY(run_id, parent_snapshot_id)
      REFERENCES knowledge_snapshots(run_id, snapshot_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE window_plans(
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL CHECK(length(trim(window_id)) > 0),
    source_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    chapter_id TEXT NOT NULL,
    chapter_title TEXT,
    source_tokens INTEGER NOT NULL CHECK(source_tokens >= 0),
    source_chars INTEGER NOT NULL CHECK(source_chars >= 0),
    oversized INTEGER NOT NULL DEFAULT 0 CHECK(oversized IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'running', 'staged', 'completed',
                       'completed_with_warnings', 'human_required', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    result_status TEXT CHECK(result_status IN ('completed', 'completed_with_warnings')),
    snapshot_id TEXT,
    style_tail TEXT NOT NULL DEFAULT '',
    budget_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(budget_json)),
    warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, window_id),
    UNIQUE(run_id, ordinal),
    UNIQUE(run_id, window_id, source_version),
    FOREIGN KEY(run_id, source_version)
      REFERENCES translation_runs(run_id, source_version) ON DELETE RESTRICT,
    FOREIGN KEY(run_id, snapshot_id)
      REFERENCES knowledge_snapshots(run_id, snapshot_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE window_membership(
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    block_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(run_id, window_id, block_id),
    UNIQUE(run_id, window_id, source_version, block_id),
    UNIQUE(run_id, block_id),
    UNIQUE(run_id, window_id, position),
    FOREIGN KEY(run_id, window_id, source_version)
      REFERENCES window_plans(run_id, window_id, source_version) ON DELETE CASCADE,
    FOREIGN KEY(source_version, block_id)
      REFERENCES logical_blocks(source_version, block_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE translations(
    translation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    block_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    source_hash TEXT NOT NULL CHECK(length(trim(source_hash)) > 0),
    text TEXT NOT NULL,
    result_status TEXT NOT NULL CHECK(result_status IN ('completed', 'completed_with_warnings')),
    stage_state TEXT NOT NULL CHECK(stage_state IN ('staged', 'promoted')),
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    snapshot_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, block_id, version),
    FOREIGN KEY(run_id, window_id, source_version, block_id)
      REFERENCES window_membership(run_id, window_id, source_version, block_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_version, block_id, source_hash)
      REFERENCES logical_blocks(source_version, block_id, source_hash) ON DELETE RESTRICT,
    FOREIGN KEY(run_id, snapshot_id)
      REFERENCES knowledge_snapshots(run_id, snapshot_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX idx_v5_lossless_active_translation
    ON translations(run_id, block_id) WHERE active=1;

  CREATE TABLE knowledge_candidates(
    run_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL CHECK(length(trim(candidate_id)) > 0),
    window_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    normalized_subject TEXT NOT NULL CHECK(length(trim(normalized_subject)) > 0),
    kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    stage_state TEXT NOT NULL DEFAULT 'staged'
      CHECK(stage_state IN ('staged', 'promoted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, candidate_id),
    FOREIGN KEY(run_id, window_id)
      REFERENCES window_plans(run_id, window_id) ON DELETE RESTRICT,
    FOREIGN KEY(run_id, snapshot_id)
      REFERENCES knowledge_snapshots(run_id, snapshot_id) ON DELETE RESTRICT
  ) STRICT;

${LOSSLESS_BOOK_SCHEMA_V2_KNOWLEDGE_RECORDS}\n  CREATE TABLE migration_candidates(
    candidate_id TEXT PRIMARY KEY CHECK(length(trim(candidate_id)) > 0),
    run_id TEXT REFERENCES translation_runs(run_id) ON DELETE RESTRICT,
    source_version TEXT NOT NULL REFERENCES source_versions(source_version) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'accepted', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE recovery_runs(
    recovery_id TEXT PRIMARY KEY CHECK(length(trim(recovery_id)) > 0),
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE RESTRICT,
    state TEXT NOT NULL
      CHECK(state IN ('preflight_blocked', 'recovery_planning', 'recovery_trial',
                      'auditing', 'resumed', 'quarantined')),
    before_hash TEXT NOT NULL,
    after_hash TEXT,
    strategy TEXT NOT NULL,
    parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE events(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT REFERENCES translation_runs(run_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;
`;

export const LOSSLESS_BOOK_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(LOSSLESS_BOOK_SCHEMA_V2, "utf8")
  .digest("hex");
