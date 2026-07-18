"""Schema 9: append-only narrative memory and translation snapshots."""

from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path
from typing import Any

from .schema_v8 import (
    SchemaMigrationError,
    SchemaUpgradeRequired,
    assert_schema8_or_empty,
    create_schema8,
    inspect_schema,
)


SCHEMA_VERSION = 9


SCHEMA9_SQL = """
CREATE TABLE IF NOT EXISTS term_profiles (
    subject_type TEXT NOT NULL CHECK(subject_type IN ('lexeme', 'concept')),
    subject_id TEXT NOT NULL,
    semantic_core TEXT NOT NULL DEFAULT '',
    contrast_sources_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'provisional',
    locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
    retired_version INTEGER REFERENCES knowledge_versions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY(subject_type, subject_id, created_version)
);
CREATE INDEX IF NOT EXISTS idx_term_profiles_active
    ON term_profiles(subject_type, subject_id, retired_version, created_version);

CREATE TABLE IF NOT EXISTS source_structure (
    block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
    structure_json TEXT NOT NULL DEFAULT '{}',
    structure_hash TEXT NOT NULL DEFAULT '',
    extractor_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES memory_versions(id),
    reason TEXT NOT NULL,
    source_global_index INTEGER NOT NULL DEFAULT -1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS narrative_memories (
    id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL CHECK (memory_type IN (
        'explicit_fact', 'observation', 'hypothesis', 'open_question',
        'contradiction', 'character_state', 'relationship_state',
        'timeline_anchor', 'location_state', 'narrator_state'
    )),
    statement TEXT NOT NULL,
    truth_status TEXT NOT NULL CHECK (truth_status IN (
        'asserted', 'observed', 'inferred', 'disputed', 'unknown'
    )),
    visibility TEXT NOT NULL CHECK (visibility IN (
        'reader_visible', 'system_private', 'render_only'
    )),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    reveal_global_index INTEGER NOT NULL,
    source_block_id TEXT NOT NULL REFERENCES blocks(id),
    source_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'provisional', 'verified', 'disputed', 'superseded', 'rejected'
    )),
    high_impact INTEGER NOT NULL DEFAULT 0 CHECK (high_impact IN (0, 1)),
    semantic_fingerprint TEXT NOT NULL,
    created_memory_version INTEGER NOT NULL REFERENCES memory_versions(id),
    retired_memory_version INTEGER REFERENCES memory_versions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_narrative_memories_visible
    ON narrative_memories(
        visibility, reveal_global_index, retired_memory_version, status, id
    );
CREATE INDEX IF NOT EXISTS idx_narrative_memories_source
    ON narrative_memories(source_block_id, created_memory_version, id);
CREATE INDEX IF NOT EXISTS idx_narrative_memories_fingerprint
    ON narrative_memories(semantic_fingerprint, source_block_id, id);

CREATE TABLE IF NOT EXISTS narrative_memory_evidence (
    memory_id TEXT NOT NULL REFERENCES narrative_memories(id) ON DELETE CASCADE,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    quote TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    PRIMARY KEY(memory_id, block_id, start_offset, end_offset)
);
CREATE INDEX IF NOT EXISTS idx_narrative_evidence_block
    ON narrative_memory_evidence(block_id, start_offset, end_offset, memory_id);

CREATE TABLE IF NOT EXISTS narrative_memory_subjects (
    memory_id TEXT NOT NULL REFERENCES narrative_memories(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL CHECK (subject_type IN (
        'lexeme', 'concept', 'anonymous_actor', 'location', 'thread'
    )),
    subject_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'subject',
    PRIMARY KEY(memory_id, subject_type, subject_id, role)
);
CREATE INDEX IF NOT EXISTS idx_narrative_subject_lookup
    ON narrative_memory_subjects(subject_type, subject_id, memory_id);

CREATE TABLE IF NOT EXISTS narrative_memory_links (
    from_memory_id TEXT NOT NULL
        REFERENCES narrative_memories(id) ON DELETE CASCADE,
    to_memory_id TEXT NOT NULL
        REFERENCES narrative_memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (relation IN (
        'supports', 'contradicts', 'supersedes', 'answers', 'elaborates'
    )),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    created_memory_version INTEGER NOT NULL REFERENCES memory_versions(id),
    PRIMARY KEY(
        from_memory_id, to_memory_id, relation, created_memory_version
    ),
    CHECK (from_memory_id != to_memory_id)
);
CREATE INDEX IF NOT EXISTS idx_narrative_links_reverse
    ON narrative_memory_links(to_memory_id, relation, from_memory_id);

CREATE TABLE IF NOT EXISTS narrative_snapshots (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    global_index INTEGER NOT NULL,
    knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
    memory_version INTEGER NOT NULL REFERENCES memory_versions(id),
    previous_snapshot_id TEXT REFERENCES narrative_snapshots(id),
    discourse_state_json TEXT NOT NULL DEFAULT '{}',
    visible_memory_ids_json TEXT NOT NULL DEFAULT '[]',
    snapshot_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(block_id, knowledge_version, memory_version, snapshot_hash)
);
CREATE INDEX IF NOT EXISTS idx_narrative_snapshots_order
    ON narrative_snapshots(global_index, memory_version, id);
CREATE INDEX IF NOT EXISTS idx_narrative_snapshots_block
    ON narrative_snapshots(block_id, memory_version, id);

CREATE TABLE IF NOT EXISTS premap_results (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    cache_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN (
        'accepted', 'accepted_with_warnings', 'degraded', 'rejected'
    )),
    semantic_json TEXT NOT NULL DEFAULT '[]',
    memory_candidates_json TEXT NOT NULL DEFAULT '[]',
    discourse_delta_json TEXT NOT NULL DEFAULT '{}',
    validation_json TEXT NOT NULL DEFAULT '{}',
    model_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    prior_snapshot_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    audit_call_id INTEGER REFERENCES audit_calls(id),
    snapshot_id TEXT REFERENCES narrative_snapshots(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_premap_results_block
    ON premap_results(block_id, created_at, id);

CREATE TABLE IF NOT EXISTS style_snapshots (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES blocks(id),
    global_index INTEGER NOT NULL,
    previous_snapshot_id TEXT REFERENCES style_snapshots(id),
    state_json TEXT NOT NULL DEFAULT '{}',
    state_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(block_id, state_hash)
);
CREATE INDEX IF NOT EXISTS idx_style_snapshots_order
    ON style_snapshots(global_index, id);

CREATE TABLE IF NOT EXISTS memory_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_version INTEGER NOT NULL REFERENCES memory_versions(id),
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    change_kind TEXT NOT NULL,
    old_fingerprint TEXT NOT NULL DEFAULT '',
    new_fingerprint TEXT NOT NULL DEFAULT '',
    impact_level INTEGER NOT NULL CHECK (impact_level BETWEEN 0 AND 3),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_changes_version
    ON memory_changes(memory_version, impact_level, id);
CREATE INDEX IF NOT EXISTS idx_memory_changes_subject
    ON memory_changes(subject_type, subject_id, memory_version);
"""


TRANSLATION_COLUMNS = {
    "memory_version": "INTEGER REFERENCES memory_versions(id)",
    "snapshot_id": "TEXT REFERENCES narrative_snapshots(id)",
    "context_hash": "TEXT NOT NULL DEFAULT ''",
    "style_snapshot_id": "TEXT REFERENCES style_snapshots(id)",
    "discourse_state_hash": "TEXT NOT NULL DEFAULT ''",
}

REVALIDATION_COLUMNS = {
    "change_domain": (
        "TEXT NOT NULL DEFAULT 'knowledge' "
        "CHECK (change_domain IN ('knowledge', 'memory'))"
    ),
    "from_memory_version": "INTEGER REFERENCES memory_versions(id)",
    "to_memory_version": "INTEGER REFERENCES memory_versions(id)",
}


REQUIRED_TABLES = {
    "term_profiles",
    "source_structure",
    "memory_versions",
    "narrative_memories",
    "narrative_memory_evidence",
    "narrative_memory_subjects",
    "narrative_memory_links",
    "narrative_snapshots",
    "premap_results",
    "style_snapshots",
    "memory_changes",
}


def _execute_script(connection: sqlite3.Connection, script: str) -> None:
    owns_transaction = not connection.in_transaction
    if owns_transaction:
        connection.execute("BEGIN IMMEDIATE")
    statement = ""
    try:
        for line in script.splitlines(keepends=True):
            statement += line
            if sqlite3.complete_statement(statement):
                sql = statement.strip()
                statement = ""
                if sql:
                    connection.execute(sql)
        if statement.strip():
            raise sqlite3.OperationalError("incomplete schema 9 statement")
        if owns_transaction:
            connection.commit()
    except Exception:
        if owns_transaction:
            connection.rollback()
        raise


def _install_schema9_extensions(connection: sqlite3.Connection) -> None:
    _execute_script(connection, SCHEMA9_SQL)
    columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(translation_versions)"
        ).fetchall()
    }
    for name, declaration in TRANSLATION_COLUMNS.items():
        if name not in columns:
            connection.execute(
                f"ALTER TABLE translation_versions ADD COLUMN {name} {declaration}"
            )
    revalidation_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(revalidation_tasks)"
        ).fetchall()
    }
    for name, declaration in REVALIDATION_COLUMNS.items():
        if name not in revalidation_columns:
            connection.execute(
                f"ALTER TABLE revalidation_tasks ADD COLUMN {name} {declaration}"
            )
    if connection.execute("SELECT COUNT(*) FROM memory_versions").fetchone()[0] == 0:
        connection.execute(
            """INSERT INTO memory_versions(
                   parent_id, reason, source_global_index, created_at)
               VALUES(NULL, 'initialize narrative memory', -1,
                      '1970-01-01T00:00:00+00:00')"""
        )
    connection.execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '9')"
    )


def create_schema9(connection: sqlite3.Connection) -> None:
    """Create schema 8 plus the schema 9 narrative extensions."""

    owns_transaction = not connection.in_transaction
    create_schema8(connection)
    _install_schema9_extensions(connection)
    if owns_transaction and connection.in_transaction:
        connection.commit()


def _extension_signature(
    connection: sqlite3.Connection,
) -> dict[tuple[str, str], str]:
    names = tuple(sorted(REQUIRED_TABLES))
    placeholders = ",".join("?" for _ in names)
    return {
        (str(row[0]), str(row[1])): str(row[3] or "").strip()
        for row in connection.execute(
            f"""SELECT type, name, tbl_name, sql FROM sqlite_master
                WHERE sql IS NOT NULL
                  AND (name IN ({placeholders})
                       OR tbl_name IN ({placeholders}))
                ORDER BY type, name""",
            names + names,
        )
    }


@lru_cache(maxsize=1)
def _expected_schema9_features() -> tuple[
    dict[tuple[str, str], str],
    dict[str, tuple[Any, ...]],
    set[tuple[str, str, str]],
    dict[str, tuple[Any, ...]],
    set[tuple[str, str, str]],
]:
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.row_factory = sqlite3.Row
        create_schema9(connection)
        signature = _extension_signature(connection)
        columns = {
            str(row["name"]): (
                str(row["type"]),
                int(row["notnull"]),
                row["dflt_value"],
                int(row["pk"]),
            )
            for row in connection.execute(
                "PRAGMA table_info(translation_versions)"
            )
            if str(row["name"]) in TRANSLATION_COLUMNS
        }
        foreign_keys = {
            (str(row["from"]), str(row["table"]), str(row["to"]))
            for row in connection.execute(
                "PRAGMA foreign_key_list(translation_versions)"
            )
            if str(row["from"]) in TRANSLATION_COLUMNS
        }
        revalidation_columns = {
            str(row["name"]): (
                str(row["type"]),
                int(row["notnull"]),
                row["dflt_value"],
                int(row["pk"]),
            )
            for row in connection.execute(
                "PRAGMA table_info(revalidation_tasks)"
            )
            if str(row["name"]) in REVALIDATION_COLUMNS
        }
        revalidation_foreign_keys = {
            (str(row["from"]), str(row["table"]), str(row["to"]))
            for row in connection.execute(
                "PRAGMA foreign_key_list(revalidation_tasks)"
            )
            if str(row["from"]) in REVALIDATION_COLUMNS
        }
    return (
        signature,
        columns,
        foreign_keys,
        revalidation_columns,
        revalidation_foreign_keys,
    )


def _schema9_errors(connection: sqlite3.Connection) -> list[str]:
    (
        expected_signature,
        expected_columns,
        expected_foreign_keys,
        expected_revalidation_columns,
        expected_revalidation_foreign_keys,
    ) = _expected_schema9_features()
    actual_signature = _extension_signature(connection)
    errors: list[str] = []
    for key, expected_sql in expected_signature.items():
        actual_sql = actual_signature.get(key)
        if actual_sql is None:
            errors.append(f"missing {key[0]} {key[1]}")
        elif actual_sql != expected_sql:
            errors.append(f"noncanonical {key[0]} {key[1]}")
    actual_columns = {
        str(row["name"]): (
            str(row["type"]),
            int(row["notnull"]),
            row["dflt_value"],
            int(row["pk"]),
        )
        for row in connection.execute(
            "PRAGMA table_info(translation_versions)"
        )
        if str(row["name"]) in TRANSLATION_COLUMNS
    }
    if actual_columns != expected_columns:
        errors.append("translation narrative columns are noncanonical")
    actual_foreign_keys = {
        (str(row["from"]), str(row["table"]), str(row["to"]))
        for row in connection.execute(
            "PRAGMA foreign_key_list(translation_versions)"
        )
        if str(row["from"]) in TRANSLATION_COLUMNS
    }
    if actual_foreign_keys != expected_foreign_keys:
        errors.append("translation narrative foreign keys are noncanonical")
    actual_revalidation_columns = {
        str(row["name"]): (
            str(row["type"]),
            int(row["notnull"]),
            row["dflt_value"],
            int(row["pk"]),
        )
        for row in connection.execute(
            "PRAGMA table_info(revalidation_tasks)"
        )
        if str(row["name"]) in REVALIDATION_COLUMNS
    }
    if actual_revalidation_columns != expected_revalidation_columns:
        errors.append("revalidation narrative columns are noncanonical")
    actual_revalidation_foreign_keys = {
        (str(row["from"]), str(row["table"]), str(row["to"]))
        for row in connection.execute(
            "PRAGMA foreign_key_list(revalidation_tasks)"
        )
        if str(row["from"]) in REVALIDATION_COLUMNS
    }
    if (
        actual_revalidation_foreign_keys
        != expected_revalidation_foreign_keys
    ):
        errors.append("revalidation narrative foreign keys are noncanonical")
    version = connection.execute(
        "SELECT value FROM schema_meta WHERE key='schema_version'"
    ).fetchone()
    if version is None or str(version[0]) != "9":
        errors.append("schema_meta is not version 9")
    try:
        foreign_key_errors = connection.execute(
            "PRAGMA foreign_key_check"
        ).fetchall()
    except sqlite3.DatabaseError as exc:
        errors.append(f"foreign key schema is invalid: {exc}")
    else:
        if foreign_key_errors:
            errors.append("foreign key check failed")
    duplicate = connection.execute(
        """SELECT block_id, pipeline, COUNT(*) duplicate_count
           FROM translation_versions
           WHERE active=1
           GROUP BY block_id, pipeline
           HAVING COUNT(*)>1
           LIMIT 1"""
    ).fetchone()
    if duplicate is not None:
        errors.append(
            "duplicate active translation "
            f"{duplicate['block_id']}:{duplicate['pipeline']}"
        )
    return errors


def _assert_schema9_features(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.row_factory = sqlite3.Row
        errors = _schema9_errors(connection)
    if errors:
        raise SchemaUpgradeRequired(
            "parallel_v4 schema 9 is incomplete or corrupt "
            f"({'; '.join(errors[:6])}); run migrate-v4 --preview"
        )


def assert_schema9_or_empty(path: Path) -> None:
    """Create schema 9 for an empty path or require explicit schema 8 migration."""

    path = Path(path)
    version = inspect_schema(path)
    if version == SCHEMA_VERSION:
        with closing(sqlite3.connect(path)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("BEGIN IMMEDIATE")
            try:
                _install_schema9_extensions(connection)
                errors = _schema9_errors(connection)
                if errors:
                    raise SchemaUpgradeRequired(
                        "parallel_v4 schema 9 is incomplete or corrupt "
                        f"({'; '.join(errors[:6])}); "
                        "run migrate-v4 --preview"
                    )
                connection.commit()
            except sqlite3.DatabaseError as exc:
                connection.rollback()
                raise SchemaUpgradeRequired(
                    "parallel_v4 schema 9 is incomplete or corrupt "
                    f"({exc}); run migrate-v4 --preview"
                ) from None
            except Exception:
                connection.rollback()
                raise
        return
    if version is not None:
        raise SchemaUpgradeRequired(
            f"parallel_v4 schema {version} requires an explicit schema 9 upgrade; "
            "run migrate-v4 --preview and confirm the migration before opening it"
        )
    if path.exists() and path.stat().st_size:
        with closing(sqlite3.connect(path)) as connection:
            user_tables = connection.execute(
                """SELECT name FROM sqlite_master
                   WHERE type='table' AND name NOT LIKE 'sqlite_%'"""
            ).fetchall()
        if user_tables:
            raise SchemaUpgradeRequired(
                "unversioned parallel_v4 database requires an explicit upgrade; "
                "run migrate-v4 --preview"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        create_schema9(connection)


def _confirmation_token(
    path: Path, source_sha256: str, source_bytes: int
) -> str:
    material = (
        f"schema9:{path.resolve()}:{source_bytes}:{source_sha256}"
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def _serialized_snapshot(path: Path) -> bytes:
    with closing(sqlite3.connect(path, timeout=30)) as connection:
        return bytes(connection.serialize())


def preview_schema9(path: str | Path) -> dict[str, Any]:
    source = Path(path).resolve()
    if not source.exists() or not source.is_file():
        raise SchemaMigrationError("schema 9 migration source does not exist")
    version = inspect_schema(source)
    if version == SCHEMA_VERSION:
        return {
            "status": "already_schema9",
            "from_version": 9,
            "to_version": 9,
            "schema_version": 9,
            "confirmation_token": "",
            "database": str(source),
        }
    if version != 8:
        raise SchemaMigrationError(
            f"only schema 8 can be migrated to schema 9 (found {version!r})"
        )
    assert_schema8_or_empty(source)
    serialized = _serialized_snapshot(source)
    source_sha256 = hashlib.sha256(serialized).hexdigest()
    source_bytes = len(serialized)
    backup = source.with_name(
        f"{source.name}.schema8-{source_sha256[:12]}.bak"
    )
    with closing(sqlite3.connect(source)) as connection:
        active_translations = int(
            connection.execute(
                "SELECT COUNT(*) FROM translation_versions WHERE active=1"
            ).fetchone()[0]
        )
        unfinished_tasks = 0
        if connection.execute(
            """SELECT 1 FROM sqlite_master
               WHERE type='table' AND name='revalidation_tasks'"""
        ).fetchone():
            unfinished_tasks = int(
                connection.execute(
                    """SELECT COUNT(*) FROM revalidation_tasks
                       WHERE status IN ('pending', 'validating')"""
                ).fetchone()[0]
            )
    return {
        "status": "preview",
        "from_version": 8,
        "to_version": 9,
        "database": str(source),
        "source_sha256": source_sha256,
        "source_bytes": source_bytes,
        "estimated_added_bytes": max(64 * 1024, source_bytes // 50),
        "active_translations": active_translations,
        "unfinished_tasks": unfinished_tasks,
        "backup_path": str(backup),
        "confirmation_token": _confirmation_token(
            source, source_sha256, source_bytes
        ),
    }


def migrate_schema9(path: str | Path, confirm_token: str) -> dict[str, Any]:
    """Install schema 9 using exclusive, transactional in-place DDL."""

    source = Path(path).resolve()
    preview = preview_schema9(source)
    if preview["status"] == "already_schema9":
        return preview
    expected = str(preview["confirmation_token"])
    if not isinstance(confirm_token, str) or not hmac.compare_digest(
        confirm_token, expected
    ):
        raise SchemaMigrationError(
            "schema 9 migration token is invalid; run preview again"
        )

    backup = Path(str(preview["backup_path"]))
    with closing(sqlite3.connect(source, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN EXCLUSIVE")
        try:
            serialized = bytes(connection.serialize())
            serialized_hash = hashlib.sha256(serialized).hexdigest()
            if serialized_hash != str(preview["source_sha256"]):
                raise SchemaMigrationError(
                    "schema 8 database changed after preview; run preview again"
                )
            if backup.exists():
                backup_hash = hashlib.sha256(backup.read_bytes()).hexdigest()
                if backup_hash != serialized_hash:
                    raise SchemaMigrationError(
                        "schema 9 backup path contains a different database"
                    )
            else:
                backup.parent.mkdir(parents=True, exist_ok=True)
                temporary_backup = backup.with_suffix(backup.suffix + ".tmp")
                temporary_backup.write_bytes(serialized)
                os.replace(temporary_backup, backup)

            requested_tables = (
                "blocks",
                "concepts",
                "lexemes",
                "claims",
                "translation_versions",
                "dependencies",
            )
            existing_tables = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            tracked_tables = tuple(
                table
                for table in requested_tables
                if table in existing_tables
            )
            before_counts = {
                table: int(
                    connection.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()[0]
                )
                for table in tracked_tables
            }
            duplicate = connection.execute(
                """SELECT block_id, pipeline FROM translation_versions
                   WHERE active=1
                   GROUP BY block_id, pipeline
                   HAVING COUNT(*)>1
                   LIMIT 1"""
            ).fetchone()
            if duplicate is not None:
                raise SchemaMigrationError(
                    "schema 8 has duplicate active translation "
                    f"{duplicate['block_id']}:{duplicate['pipeline']}"
                )
            _install_schema9_extensions(connection)
            errors = _schema9_errors(connection)
            if errors:
                raise SchemaMigrationError(
                    "schema 9 validation failed: " + "; ".join(errors[:6])
                )
            after_counts = {
                table: int(
                    connection.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()[0]
                )
                for table in tracked_tables
            }
            if after_counts != before_counts:
                raise SchemaMigrationError(
                    "schema 9 migration changed existing table row counts"
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    if inspect_schema(source) != SCHEMA_VERSION:
        raise SchemaMigrationError("database did not reach schema 9")
    _assert_schema9_features(source)
    return {
        **preview,
        "status": "migrated",
        "schema_version": 9,
        "backup_path": str(backup),
    }


def confirm_schema9(path: str | Path, confirm_token: str) -> dict[str, Any]:
    return migrate_schema9(path, confirm_token)
