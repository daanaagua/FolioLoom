import { createHash } from "node:crypto";

import { LOSSLESS_BOOK_SCHEMA_V3 } from "./book-schema-v3.js";

export const LOSSLESS_BOOK_SCHEMA_VERSION = 4;
export const LOSSLESS_BOOK_SCHEMA_MARKER =
  "folioloom-lossless-book-store-v4-sparse-revalidation";

export const LOSSLESS_BOOK_SCHEMA_TABLES = [
  "book_knowledge_revisions",
  "book_knowledge_state",
  "concept_occurrences",
  "events",
  "knowledge_block_impacts",
  "knowledge_candidates",
  "knowledge_import_batches",
  "knowledge_import_rows",
  "knowledge_records",
  "knowledge_revalidation_tasks",
  "knowledge_snapshots",
  "knowledge_state",
  "lexical_concepts",
  "logical_blocks",
  "lossless_schema_meta",
  "migration_candidates",
  "project_knowledge_revisions",
  "project_knowledge_state",
  "recovery_runs",
  "source_ranges",
  "source_versions",
  "structure_annotations",
  "translation_concept_bindings",
  "translation_runs",
  "translations",
  "window_membership",
  "window_plans",
] as const;

export const LOSSLESS_BOOK_SCHEMA_V4_EXTENSION = `
  CREATE TABLE lexical_concepts(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    concept_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    revision_id TEXT NOT NULL,
    normalized_subject TEXT NOT NULL,
    source_forms_json TEXT NOT NULL CHECK(json_valid(source_forms_json)),
    semantic_class TEXT NOT NULL,
    canonical_target TEXT NOT NULL,
    policy TEXT NOT NULL CHECK(policy IN ('locked','preferred','contextual')),
    allowed_realizations_json TEXT NOT NULL CHECK(json_valid(allowed_realizations_json)),
    visibility TEXT NOT NULL
      CHECK(visibility IN ('translator_global','narrative_before_target')),
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    render_fingerprint TEXT NOT NULL CHECK(length(render_fingerprint)=64),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    PRIMARY KEY(run_id, concept_id, revision),
    UNIQUE(run_id, revision_id)
  ) STRICT;

  CREATE TABLE concept_occurrences(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    concept_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    block_id TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL CHECK(occurrence_count >= 1),
    source_spans_json TEXT NOT NULL CHECK(json_valid(source_spans_json)),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    PRIMARY KEY(run_id, concept_id, block_id),
    FOREIGN KEY(source_version, block_id)
      REFERENCES logical_blocks(source_version, block_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE translation_concept_bindings(
    translation_id INTEGER NOT NULL
      REFERENCES translations(translation_id) ON DELETE CASCADE,
    concept_id TEXT NOT NULL,
    applied_revision_id TEXT NOT NULL,
    applied_render_fingerprint TEXT NOT NULL
      CHECK(length(applied_render_fingerprint)=64),
    term_usages_json TEXT NOT NULL CHECK(json_valid(term_usages_json)),
    validation_status TEXT NOT NULL
      CHECK(validation_status IN (
        'clean','pending','validating','stale','warning_stale'
      )),
    validated_revision_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT(datetime('now')),
    PRIMARY KEY(translation_id, concept_id)
  ) STRICT;

  CREATE TABLE knowledge_revalidation_tasks(
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    translation_id INTEGER NOT NULL
      REFERENCES translations(translation_id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    change_set_hash TEXT NOT NULL CHECK(length(change_set_hash)=64),
    from_snapshot_id TEXT NOT NULL,
    to_snapshot_id TEXT NOT NULL,
    concept_ids_json TEXT NOT NULL CHECK(json_valid(concept_ids_json)),
    status TEXT NOT NULL
      CHECK(status IN (
        'pending','validating','resolved_noop','resolved_repair',
        'resolved_retranslate','completed_with_warning'
      )),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    result_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(result_json)),
    replacement_translation_id INTEGER REFERENCES translations(translation_id),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    resolved_at TEXT,
    UNIQUE(translation_id, change_set_hash)
  ) STRICT;

  CREATE UNIQUE INDEX idx_folioloom_lexical_concepts_active
    ON lexical_concepts(run_id, concept_id) WHERE active=1;
  CREATE INDEX idx_folioloom_lexical_concepts_subject
    ON lexical_concepts(run_id, active, normalized_subject, concept_id);
  CREATE INDEX idx_folioloom_concept_occurrences_lookup
    ON concept_occurrences(run_id, concept_id, block_id);
  CREATE INDEX idx_folioloom_concept_occurrences_block
    ON concept_occurrences(run_id, block_id, concept_id);
  CREATE INDEX idx_folioloom_translation_bindings_status
    ON translation_concept_bindings(validation_status, concept_id, translation_id);
  CREATE INDEX idx_folioloom_revalidation_tasks_status
    ON knowledge_revalidation_tasks(run_id, status, created_at, task_id);
  CREATE INDEX idx_folioloom_revalidation_tasks_translation
    ON knowledge_revalidation_tasks(translation_id, status, task_id);
`;

export const LOSSLESS_BOOK_SCHEMA_V4 =
  LOSSLESS_BOOK_SCHEMA_V3 + LOSSLESS_BOOK_SCHEMA_V4_EXTENSION;

export const LOSSLESS_BOOK_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(LOSSLESS_BOOK_SCHEMA_V4, "utf8")
  .digest("hex");
