import { createHash } from "node:crypto";

import {
  LOSSLESS_BOOK_SCHEMA_TABLES as LOSSLESS_BOOK_SCHEMA_V4_TABLES,
  LOSSLESS_BOOK_SCHEMA_V4,
} from "./book-schema-v4.js";

export const LOSSLESS_BOOK_SCHEMA_VERSION = 5;
export const LOSSLESS_BOOK_SCHEMA_MARKER =
  "folioloom-lossless-book-store-v5-live-terminology";

export const LOSSLESS_BOOK_SCHEMA_TABLES = Object.freeze([
  ...LOSSLESS_BOOK_SCHEMA_V4_TABLES,
  "knowledge_change_queue",
  "term_retrofit_items",
  "term_retrofit_jobs",
].sort());

export const LOSSLESS_BOOK_SCHEMA_V5_EXTENSION = `
  ALTER TABLE lexical_concepts
    ADD COLUMN rule_id TEXT;
  ALTER TABLE lexical_concepts
    ADD COLUMN base_concept_id TEXT;
  ALTER TABLE lexical_concepts
    ADD COLUMN authority_rank INTEGER NOT NULL DEFAULT 0
      CHECK(authority_rank >= 0);
  ALTER TABLE lexical_concepts
    ADD COLUMN applicability_json TEXT NOT NULL DEFAULT '{"kind":"whole_book"}'
      CHECK(json_valid(applicability_json));

  CREATE TABLE knowledge_change_queue(
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    base_generation INTEGER NOT NULL CHECK(base_generation >= 0),
    base_snapshot_id TEXT NOT NULL,
    object_keys_json TEXT NOT NULL CHECK(json_valid(object_keys_json)),
    commands_json TEXT NOT NULL CHECK(json_valid(commands_json)),
    status TEXT NOT NULL
      CHECK(status IN ('queued','applying','applied','rejected','cancelled')),
    result_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(result_json)),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    applied_at TEXT
  ) STRICT;

  CREATE TABLE term_retrofit_jobs(
    job_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    rule_revision_id TEXT NOT NULL,
    base_generation INTEGER NOT NULL CHECK(base_generation >= 0),
    base_snapshot_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
    status TEXT NOT NULL
      CHECK(status IN (
        'planned','running','completed','needs_attention','failed',
        'cancelled','rolled_back'
      )),
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    error_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(error_json)),
    created_at TEXT NOT NULL DEFAULT(datetime('now')),
    updated_at TEXT NOT NULL DEFAULT(datetime('now')),
    completed_at TEXT,
    UNIQUE(run_id, request_id)
  ) STRICT;

  CREATE TABLE term_retrofit_items(
    job_id TEXT NOT NULL REFERENCES term_retrofit_jobs(job_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    source_version TEXT NOT NULL,
    block_id TEXT NOT NULL,
    old_translation_id INTEGER NOT NULL
      REFERENCES translations(translation_id),
    classification TEXT NOT NULL
      CHECK(classification IN (
        'noop','local_repair','model_retranslate','human_required'
      )),
    status TEXT NOT NULL
      CHECK(status IN (
        'pending','running','completed','needs_attention','failed',
        'cancelled','rolled_back'
      )),
    new_translation_id INTEGER REFERENCES translations(translation_id),
    result_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(result_json)),
    updated_at TEXT NOT NULL DEFAULT(datetime('now')),
    PRIMARY KEY(job_id, ordinal),
    UNIQUE(job_id, block_id),
    FOREIGN KEY(source_version, block_id)
      REFERENCES logical_blocks(source_version, block_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_folioloom_knowledge_change_queue_status
    ON knowledge_change_queue(run_id, status, created_at, request_id);
  CREATE INDEX idx_folioloom_term_retrofit_jobs_status
    ON term_retrofit_jobs(run_id, status, created_at, job_id);
  CREATE INDEX idx_folioloom_term_retrofit_items_status
    ON term_retrofit_items(job_id, status, ordinal);
`;

export const LOSSLESS_BOOK_SCHEMA_V5 =
  LOSSLESS_BOOK_SCHEMA_V4 + LOSSLESS_BOOK_SCHEMA_V5_EXTENSION;

export const LOSSLESS_BOOK_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(LOSSLESS_BOOK_SCHEMA_V5, "utf8")
  .digest("hex");
