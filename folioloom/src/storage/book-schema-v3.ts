import { createHash } from "node:crypto";

import {
  LOSSLESS_BOOK_SCHEMA_V2,
  LOSSLESS_BOOK_SCHEMA_V2_KNOWLEDGE_RECORDS,
} from "./book-schema-v2.js";

export const LOSSLESS_BOOK_SCHEMA_VERSION = 3;
export const LOSSLESS_BOOK_SCHEMA_MARKER =
  "folioloom-lossless-book-store-v3-user-knowledge";

export const LOSSLESS_BOOK_SCHEMA_TABLES = [
  "book_knowledge_revisions",
  "book_knowledge_state",
  "events",
  "knowledge_block_impacts",
  "knowledge_candidates",
  "knowledge_import_batches",
  "knowledge_import_rows",
  "knowledge_records",
  "knowledge_snapshots",
  "knowledge_state",
  "logical_blocks",
  "lossless_schema_meta",
  "migration_candidates",
  "project_knowledge_revisions",
  "project_knowledge_state",
  "recovery_runs",
  "source_ranges",
  "source_versions",
  "structure_annotations",
  "translation_runs",
  "translations",
  "window_membership",
  "window_plans",
] as const;

export const LOSSLESS_BOOK_SCHEMA_V3_KNOWLEDGE_RECORDS = `
  CREATE TABLE knowledge_records(
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
    producing_window_id TEXT,
    origin TEXT NOT NULL DEFAULT 'model'
      CHECK(origin IN ('model', 'manual', 'import', 'rollback')),
    scope TEXT NOT NULL DEFAULT 'book'
      CHECK(scope IN ('book', 'project', 'global')),
    owned_fields_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(owned_fields_json)),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
    import_batch_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, record_id, revision),
    UNIQUE(run_id, revision_id),
    FOREIGN KEY(run_id, producing_window_id)
      REFERENCES window_plans(run_id, window_id) ON DELETE RESTRICT
  ) STRICT;
`;

export const LOSSLESS_BOOK_SCHEMA_V3_EXTENSION = `
  CREATE TABLE knowledge_state(
    run_id TEXT PRIMARY KEY REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    applied_book_generation INTEGER NOT NULL DEFAULT 0
      CHECK(applied_book_generation >= 0),
    applied_project_generation INTEGER NOT NULL DEFAULT 0
      CHECK(applied_project_generation >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE book_knowledge_state(
    source_version TEXT PRIMARY KEY
      REFERENCES source_versions(source_version) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE book_knowledge_revisions(
    source_version TEXT NOT NULL
      REFERENCES source_versions(source_version) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    revision_id TEXT NOT NULL UNIQUE,
    object_type TEXT NOT NULL
      CHECK(object_type IN ('term', 'entity', 'alias', 'relation', 'memory', 'style')),
    normalized_subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    origin TEXT NOT NULL CHECK(origin IN ('manual', 'import', 'rollback')),
    scope TEXT NOT NULL CHECK(scope IN ('book', 'global')),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(source_version, record_id, revision)
  ) STRICT;

  CREATE TABLE project_knowledge_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE project_knowledge_revisions(
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    revision_id TEXT NOT NULL UNIQUE,
    object_type TEXT NOT NULL
      CHECK(object_type IN ('term', 'entity', 'alias', 'relation', 'memory', 'style')),
    normalized_subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    origin TEXT NOT NULL CHECK(origin IN ('manual', 'import', 'rollback')),
    scope TEXT NOT NULL CHECK(scope = 'project'),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(record_id, revision)
  ) STRICT;

  CREATE TABLE knowledge_block_impacts(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    block_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'acknowledged', 'retranslated')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, revision_id, block_id),
    FOREIGN KEY(source_version, block_id)
      REFERENCES logical_blocks(source_version, block_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE knowledge_import_batches(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_format TEXT NOT NULL,
    mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
    mapping_hash TEXT NOT NULL CHECK(length(mapping_hash) = 64),
    status TEXT NOT NULL
      CHECK(status IN ('staged', 'committed', 'rolled_back', 'discarded', 'failed')),
    report_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, batch_id)
  ) STRICT;

  CREATE TABLE knowledge_import_rows(
    run_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK(row_ordinal >= 0),
    state TEXT NOT NULL
      CHECK(state IN ('ready', 'merge', 'conflict', 'invalid', 'skipped', 'committed')),
    normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
    diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json)),
    decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
    PRIMARY KEY(run_id, batch_id, row_ordinal),
    FOREIGN KEY(run_id, batch_id)
      REFERENCES knowledge_import_batches(run_id, batch_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_v5_knowledge_records_list
    ON knowledge_records(run_id, active, normalized_subject, kind, record_id);
  CREATE UNIQUE INDEX idx_v5_knowledge_records_active_record
    ON knowledge_records(run_id, record_id)
    WHERE active=1;
  CREATE INDEX idx_v5_book_knowledge_active
    ON book_knowledge_revisions(
      source_version, active, object_type, normalized_subject, kind, record_id
    );
  CREATE INDEX idx_v5_project_knowledge_active
    ON project_knowledge_revisions(
      active, object_type, normalized_subject, kind, record_id
    );
  CREATE INDEX idx_v5_knowledge_impacts_status
    ON knowledge_block_impacts(run_id, status, created_at, block_id);
  CREATE INDEX idx_v5_import_batches_status
    ON knowledge_import_batches(run_id, status, created_at, batch_id);
  CREATE UNIQUE INDEX idx_v5_import_batches_active_identity
    ON knowledge_import_batches(run_id, source_hash, mapping_hash)
    WHERE status IN ('staged', 'committed');
  CREATE INDEX idx_v5_import_rows_state
    ON knowledge_import_rows(run_id, batch_id, state, row_ordinal);
`;

export const LOSSLESS_BOOK_SCHEMA_V3 = LOSSLESS_BOOK_SCHEMA_V2.replace(
  LOSSLESS_BOOK_SCHEMA_V2_KNOWLEDGE_RECORDS,
  LOSSLESS_BOOK_SCHEMA_V3_KNOWLEDGE_RECORDS,
) + LOSSLESS_BOOK_SCHEMA_V3_EXTENSION;

export const LOSSLESS_BOOK_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(LOSSLESS_BOOK_SCHEMA_V3, "utf8")
  .digest("hex");
