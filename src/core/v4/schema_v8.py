"""Schema 8 creation and the explicit upgrade boundary for parallel_v4."""

from __future__ import annotations

import sqlite3
import hashlib
import hmac
import json
import os
import shutil
import unicodedata
import uuid
from contextlib import closing
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from .matcher import MultiFormMatcher


SCHEMA_VERSION = 8


class SchemaUpgradeRequired(RuntimeError):
    """An existing database must be migrated by the explicit migration command."""


class SchemaMigrationError(RuntimeError, ValueError):
    """A schema migration request failed its non-destructive safety checks."""


def _connect_readonly(path: Path) -> sqlite3.Connection:
    # ``immutable=1`` prevents SQLite from materializing WAL/SHM sidecars during
    # preview and boundary checks. Writers must be quiescent before migration.
    uri = f"{path.resolve().as_uri()}?mode=ro&immutable=1"
    return sqlite3.connect(uri, uri=True)


def inspect_schema(path: Path) -> int | None:
    """Return the persisted schema version, or ``None`` for an empty database."""

    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        return None
    with closing(_connect_readonly(path)) as connection:
        table = connection.execute(
            """SELECT 1 FROM sqlite_master
               WHERE type='table' AND name='schema_meta'"""
        ).fetchone()
        if table is None:
            return None
        row = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
    if row is None:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError) as exc:
        raise SchemaUpgradeRequired(
            "parallel_v4 database has an invalid schema version; "
            "run migrate-v4 --preview before opening it"
        ) from exc


def _normalize_schema_sql(sql: str) -> str:
    """Preserve DDL semantics while ignoring sqlite_master edge whitespace."""

    return sql.strip()


def _schema_signature(connection: sqlite3.Connection) -> dict[tuple[str, str], str]:
    return {
        (str(object_type), str(name)): _normalize_schema_sql(str(sql))
        for object_type, name, sql in connection.execute(
            """SELECT type, name, sql FROM sqlite_master
               WHERE type IN ('table', 'index') AND sql IS NOT NULL"""
        )
    }


def _execute_schema_script(connection: sqlite3.Connection, script: str) -> None:
    """Execute DDL without sqlite3.executescript's implicit pre-commit."""

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
            raise sqlite3.OperationalError("incomplete schema statement")
        if owns_transaction:
            connection.commit()
    except Exception:
        if owns_transaction:
            connection.rollback()
        raise


def create_schema8(connection: sqlite3.Connection) -> None:
    """Create the schema 8 tables that differ from the schema 7 layout."""

    _execute_schema_script(
        connection,
        """
        CREATE TABLE IF NOT EXISTS schema_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS concepts (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            canonical_source TEXT NOT NULL,
            default_target TEXT NOT NULL DEFAULT '',
            working_target TEXT NOT NULL DEFAULT '',
            verified_target TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'provisional',
            scope TEXT NOT NULL DEFAULT 'book',
            locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
            primary_lexeme_id TEXT REFERENCES lexemes(id),
            anchor_mention_id INTEGER REFERENCES mentions(id),
            created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            retired_version INTEGER REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_concepts_active_source
            ON concepts(canonical_source, retired_version, locked);
        CREATE INDEX IF NOT EXISTS idx_concepts_primary_lexeme
            ON concepts(primary_lexeme_id, retired_version);

        CREATE TABLE IF NOT EXISTS lexemes (
            id TEXT PRIMARY KEY,
            language TEXT NOT NULL,
            normalized_form TEXT NOT NULL,
            canonical_form TEXT NOT NULL,
            default_target TEXT NOT NULL DEFAULT '',
            working_target TEXT NOT NULL DEFAULT '',
            verified_target TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'provisional',
            locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
            created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            retired_version INTEGER REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_active_lexeme
            ON lexemes(language, normalized_form) WHERE retired_version IS NULL;

        CREATE TABLE IF NOT EXISTS concept_lexemes (
            concept_id TEXT NOT NULL REFERENCES concepts(id),
            lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
            role TEXT NOT NULL
                CHECK (role IN ('primary', 'alias', 'title', 'uncertain')),
            confidence REAL NOT NULL DEFAULT 1.0
                CHECK (confidence >= 0.0 AND confidence <= 1.0),
            status TEXT NOT NULL DEFAULT 'provisional',
            evidence_id INTEGER REFERENCES evidence(id),
            created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            retired_version INTEGER REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL,
            PRIMARY KEY (concept_id, lexeme_id, role, created_version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_active_concept_lexeme_role
            ON concept_lexemes(concept_id, lexeme_id, role)
            WHERE retired_version IS NULL;
        CREATE INDEX IF NOT EXISTS idx_concept_lexemes_lexeme
            ON concept_lexemes(lexeme_id, retired_version, concept_id);

        CREATE TABLE IF NOT EXISTS source_forms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
            form TEXT NOT NULL,
            normalized_form TEXT NOT NULL,
            grammar_json TEXT NOT NULL DEFAULT '{}',
            UNIQUE(lexeme_id, normalized_form, form)
        );
        CREATE INDEX IF NOT EXISTS idx_source_forms_normalized
            ON source_forms(normalized_form);
        CREATE INDEX IF NOT EXISTS idx_source_forms_lexeme
            ON source_forms(lexeme_id, normalized_form);

        CREATE TABLE IF NOT EXISTS mentions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id TEXT NOT NULL REFERENCES blocks(id),
            paragraph_id TEXT NOT NULL,
            source_form TEXT NOT NULL,
            normalized_form TEXT NOT NULL,
            discourse_function TEXT NOT NULL,
            lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
            concept_id TEXT REFERENCES concepts(id),
            evidence_id INTEGER NOT NULL REFERENCES evidence(id),
            UNIQUE(block_id, paragraph_id, source_form, evidence_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mentions_lexeme
            ON mentions(lexeme_id, block_id, id);
        CREATE INDEX IF NOT EXISTS idx_mentions_concept
            ON mentions(concept_id, block_id, id);

        CREATE TABLE IF NOT EXISTS concept_type_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            concept_id TEXT REFERENCES concepts(id),
            lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
            mention_id INTEGER REFERENCES mentions(id),
            evidence_id INTEGER REFERENCES evidence(id),
            kind TEXT NOT NULL,
            confidence REAL NOT NULL
                CHECK (confidence >= 0.0 AND confidence <= 1.0),
            source TEXT NOT NULL,
            adjudication_id TEXT REFERENCES candidate_adjudications(id),
            created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            retired_version INTEGER REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_type_observations_lexeme
            ON concept_type_observations(lexeme_id, retired_version, kind);
        CREATE INDEX IF NOT EXISTS idx_type_observations_concept
            ON concept_type_observations(concept_id, retired_version, kind);

        CREATE TABLE IF NOT EXISTS candidate_resolutions (
            id TEXT PRIMARY KEY,
            adjudication_id TEXT NOT NULL REFERENCES candidate_adjudications(id)
                ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs(id),
            cluster_id TEXT NOT NULL,
            candidate_id TEXT REFERENCES lexical_candidates(id),
            lexeme_id TEXT REFERENCES lexemes(id),
            concept_id TEXT REFERENCES concepts(id),
            evidence_id INTEGER REFERENCES evidence(id),
            decision TEXT NOT NULL,
            ordinal INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(adjudication_id, ordinal),
            FOREIGN KEY(cluster_id)
                REFERENCES candidate_clusters(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_cluster
            ON candidate_resolutions(run_id, cluster_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_candidate
            ON candidate_resolutions(candidate_id, decision);
        CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_lexeme
            ON candidate_resolutions(lexeme_id, decision);
        CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_concept
            ON candidate_resolutions(concept_id, decision);

        CREATE TABLE IF NOT EXISTS rendering_rules (
            id TEXT PRIMARY KEY,
            lexeme_id TEXT REFERENCES lexemes(id),
            concept_id TEXT REFERENCES concepts(id),
            condition_json TEXT NOT NULL,
            target TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'provisional',
            scope TEXT NOT NULL DEFAULT 'book',
            locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
            created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            retired_version INTEGER REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL,
            CHECK ((lexeme_id IS NULL) != (concept_id IS NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_rendering_rules_lexeme
            ON rendering_rules(lexeme_id, retired_version, priority);
        CREATE INDEX IF NOT EXISTS idx_rendering_rules_concept
            ON rendering_rules(concept_id, retired_version, priority);

        CREATE TABLE IF NOT EXISTS coreference_decisions (
            id TEXT PRIMARY KEY,
            lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
            left_anchor_type TEXT NOT NULL
                CHECK (left_anchor_type IN ('concept', 'mention_set')),
            left_anchor_id TEXT NOT NULL,
            right_anchor_type TEXT NOT NULL
                CHECK (right_anchor_type IN ('concept', 'mention_set')),
            right_anchor_id TEXT NOT NULL,
            relation TEXT NOT NULL
                CHECK (relation IN ('same', 'different', 'uncertain', 'non_entity')),
            decision_source TEXT NOT NULL
                CHECK (decision_source IN ('deterministic', 'dual_model', 'human')),
            confidence REAL NOT NULL DEFAULT 0.0
                CHECK (confidence >= 0.0 AND confidence <= 1.0),
            locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
            votes_json TEXT NOT NULL DEFAULT '[]',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            anchor_members_json TEXT NOT NULL DEFAULT '[]',
            payload_hash TEXT NOT NULL,
            created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            retired_version INTEGER REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_active_coreference_payload
            ON coreference_decisions(payload_hash) WHERE retired_version IS NULL;
        CREATE INDEX IF NOT EXISTS idx_coreference_decisions_lexeme
            ON coreference_decisions(lexeme_id, retired_version, relation);

        CREATE TABLE IF NOT EXISTS concept_redirects (
            retired_concept_id TEXT PRIMARY KEY REFERENCES concepts(id),
            canonical_concept_id TEXT NOT NULL REFERENCES concepts(id),
            reason TEXT NOT NULL,
            knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            created_at TEXT NOT NULL,
            CHECK (retired_concept_id != canonical_concept_id)
        );
        CREATE INDEX IF NOT EXISTS idx_concept_redirects_canonical
            ON concept_redirects(canonical_concept_id);

        CREATE TABLE IF NOT EXISTS form_occurrences (
            lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
            block_id TEXT NOT NULL REFERENCES blocks(id),
            start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
            end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
            source_form TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (lexeme_id, block_id, start_offset, end_offset)
        );
        CREATE INDEX IF NOT EXISTS idx_form_occurrences_block
            ON form_occurrences(block_id, start_offset, end_offset);

        CREATE TABLE IF NOT EXISTS knowledge_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            subject_type TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            change_kind TEXT NOT NULL,
            old_fingerprint TEXT NOT NULL DEFAULT '',
            new_fingerprint TEXT NOT NULL DEFAULT '',
            impact_level INTEGER NOT NULL CHECK (impact_level BETWEEN 0 AND 3),
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_changes_version
            ON knowledge_changes(knowledge_version, impact_level, id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_changes_subject
            ON knowledge_changes(subject_type, subject_id, knowledge_version);

        CREATE TABLE IF NOT EXISTS translation_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id TEXT NOT NULL REFERENCES blocks(id),
            pipeline TEXT NOT NULL,
            run_id TEXT REFERENCES runs(id),
            knowledge_version INTEGER,
            status TEXT NOT NULL,
            draft_translation TEXT NOT NULL DEFAULT '',
            final_translation TEXT NOT NULL DEFAULT '',
            analysis TEXT NOT NULL DEFAULT '',
            semantic_obligations TEXT NOT NULL DEFAULT '',
            memory_summary TEXT NOT NULL DEFAULT '',
            warnings_json TEXT NOT NULL DEFAULT '[]',
            validation_status TEXT NOT NULL DEFAULT 'clean'
                CHECK (validation_status IN
                    ('clean', 'pending', 'validating', 'warning_stale')),
            validated_knowledge_version INTEGER REFERENCES knowledge_versions(id),
            validation_fingerprint TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_translation_active
            ON translation_versions(block_id, pipeline, active);
        CREATE INDEX IF NOT EXISTS idx_translation_validation
            ON translation_versions(validation_status, active, block_id);

        CREATE TABLE IF NOT EXISTS dependencies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            translation_id INTEGER NOT NULL REFERENCES translation_versions(id),
            dependency_type TEXT NOT NULL,
            dependency_id TEXT NOT NULL,
            knowledge_version INTEGER NOT NULL,
            dependency_fingerprint TEXT NOT NULL DEFAULT '',
            matched_form TEXT NOT NULL DEFAULT '',
            occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
            rendered_target TEXT NOT NULL DEFAULT '',
            applied_rule_ids_json TEXT NOT NULL DEFAULT '[]',
            source_spans_json TEXT NOT NULL DEFAULT '[]',
            UNIQUE(translation_id, dependency_type, dependency_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dependencies_reverse
            ON dependencies(dependency_type, dependency_id);

        CREATE TABLE IF NOT EXISTS revalidation_tasks (
            id TEXT PRIMARY KEY,
            translation_id INTEGER NOT NULL REFERENCES translation_versions(id),
            block_id TEXT NOT NULL REFERENCES blocks(id),
            from_knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            to_knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            change_set_hash TEXT NOT NULL,
            impact_level INTEGER NOT NULL CHECK (impact_level BETWEEN 0 AND 3),
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN (
                    'pending', 'validating', 'resolved_noop', 'resolved_patch',
                    'resolved_retranslate', 'completed_with_warning'
                )),
            action TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
            result_json TEXT NOT NULL DEFAULT '{}',
            replacement_translation_id INTEGER REFERENCES translation_versions(id),
            error TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_revalidation_change_set
            ON revalidation_tasks(translation_id, change_set_hash);
        CREATE INDEX IF NOT EXISTS idx_revalidation_tasks_status
            ON revalidation_tasks(status, impact_level, created_at, id);

        INSERT OR REPLACE INTO schema_meta(key, value)
        VALUES('schema_version', '8');
        """
    )


_SCHEMA8_REBUILT_TABLES = (
    "schema_meta",
    "concepts",
    "lexemes",
    "concept_lexemes",
    "source_forms",
    "mentions",
    "concept_type_observations",
    "candidate_resolutions",
    "rendering_rules",
    "coreference_decisions",
    "concept_redirects",
    "form_occurrences",
    "knowledge_changes",
    "translation_versions",
    "dependencies",
    "revalidation_tasks",
)


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def _table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    if not _table_exists(connection, table):
        return set()
    return {
        str(row[1])
        for row in connection.execute(
            f"PRAGMA table_info({_quote_identifier(table)})"
        ).fetchall()
    }


def _table_rows(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    if not _table_exists(connection, table):
        return []
    cursor = connection.execute(f"SELECT * FROM {_quote_identifier(table)}")
    names = [str(item[0]) for item in cursor.description or ()]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def _stable_id(prefix: str, value: str, length: int = 16) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}_{digest}"


def _normalize_form(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).translate(
        str.maketrans(
            {
                "‘": "'",
                "’": "'",
                "`": "'",
                "´": "'",
                "“": '"',
                "”": '"',
                "«": '"',
                "»": '"',
                "–": "-",
                "—": "-",
                "−": "-",
                "\u00a0": " ",
            }
        )
    )
    normalized = " ".join(normalized.strip().casefold().split())
    if normalized.endswith("'s"):
        normalized = normalized[:-2]
    elif normalized.endswith("'"):
        normalized = normalized[:-1]
    return normalized


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_database_path(path: str | Path) -> Path:
    raw = Path(path)
    if not raw.is_absolute():
        raise SchemaMigrationError("schema migration path must be absolute")
    try:
        resolved = raw.resolve(strict=True)
    except FileNotFoundError as exc:
        raise SchemaMigrationError("schema migration source does not exist") from exc
    if not resolved.is_file():
        raise SchemaMigrationError("schema migration source must be a database file")
    if (
        resolved.parent.name != "parallel_v4"
        or resolved.parent.parent.name != "artifacts"
    ):
        raise SchemaMigrationError(
            "schema migration source must be inside project artifacts/parallel_v4"
        )
    scope = (resolved.parent.parent.parent / "artifacts" / "parallel_v4").resolve()
    if resolved.parent != scope:
        raise SchemaMigrationError(
            "schema migration source must be inside project artifacts/parallel_v4"
        )
    return resolved


def _effective_concept_target(row: Mapping[str, Any]) -> str:
    for name in ("verified_target", "working_target", "default_target", "target"):
        target = str(row.get(name) or "").strip()
        if target:
            return target
    return ""


def _legacy_analysis(connection: sqlite3.Connection) -> dict[str, Any]:
    tables = {
        str(row[0]): int(
            connection.execute(
                f"SELECT COUNT(*) FROM {_quote_identifier(str(row[0]))}"
            ).fetchone()[0]
        )
        for row in connection.execute(
            """SELECT name FROM sqlite_master
               WHERE type='table' AND name NOT LIKE 'sqlite_%'
               ORDER BY name"""
        ).fetchall()
    }
    concepts = _table_rows(connection, "concepts")
    forms = _table_rows(connection, "source_forms")
    mentions = _table_rows(connection, "mentions")
    old_lexemes = _table_rows(connection, "lexemes")
    translations = _table_rows(connection, "translation_versions")
    dependencies = _table_rows(connection, "dependencies")
    blocks = _table_rows(connection, "blocks")
    versions = _table_rows(connection, "knowledge_versions")
    max_version = max((int(row.get("id") or 0) for row in versions), default=0)

    concept_by_id = {
        str(row.get("id")): row for row in concepts if str(row.get("id") or "")
    }
    groups: dict[str, dict[str, Any]] = {}

    def include_form(
        value: object,
        *,
        concept_id: object = "",
        old_lexeme_id: object = "",
    ) -> None:
        form = str(value or "").strip()
        normalized = _normalize_form(form)
        if not normalized:
            return
        group = groups.setdefault(
            normalized,
            {
                "normalized_form": normalized,
                "forms": set(),
                "concept_ids": set(),
                "old_lexeme_ids": set(),
            },
        )
        group["forms"].add(form)
        if str(concept_id or ""):
            group["concept_ids"].add(str(concept_id))
        if str(old_lexeme_id or ""):
            group["old_lexeme_ids"].add(str(old_lexeme_id))

    for concept in concepts:
        include_form(
            concept.get("canonical_source"),
            concept_id=concept.get("id"),
            old_lexeme_id=concept.get("primary_lexeme_id"),
        )
    for form in forms:
        include_form(
            form.get("form") or form.get("normalized_form"),
            concept_id=form.get("concept_id"),
            old_lexeme_id=form.get("lexeme_id"),
        )
    for mention in mentions:
        include_form(
            mention.get("source_form") or mention.get("normalized_form"),
            concept_id=mention.get("concept_id"),
            old_lexeme_id=mention.get("lexeme_id"),
        )
    for lexeme in old_lexemes:
        include_form(
            lexeme.get("canonical_form") or lexeme.get("normalized_form"),
            old_lexeme_id=lexeme.get("id"),
        )

    active_translation_ids = {
        int(row.get("id"))
        for row in translations
        if row.get("id") is not None
        and str(row.get("pipeline") or "") == "parallel_v4"
        and int(row.get("active") if row.get("active") is not None else 1) == 1
    }
    dependency_votes: dict[str, int] = {}
    dependencies_by_translation: dict[int, list[dict[str, Any]]] = {}
    for dependency in dependencies:
        translation_id = int(dependency.get("translation_id") or 0)
        dependencies_by_translation.setdefault(translation_id, []).append(dependency)
        if (
            translation_id in active_translation_ids
            and str(dependency.get("dependency_type") or "") == "concept"
        ):
            concept = concept_by_id.get(str(dependency.get("dependency_id") or ""))
            target = _effective_concept_target(concept or {})
            if target:
                concept_id = str(dependency.get("dependency_id") or "")
                dependency_votes[concept_id] = dependency_votes.get(concept_id, 0) + 1

    lexeme_collisions: list[dict[str, Any]] = []
    target_conflicts: list[dict[str, Any]] = []
    for normalized, group in sorted(groups.items()):
        concept_ids = sorted(group["concept_ids"])
        group["forms"] = sorted(group["forms"])
        group["concept_ids"] = concept_ids
        group["old_lexeme_ids"] = sorted(group["old_lexeme_ids"])
        group["lexeme_id"] = _stable_id("lexeme", f"en:{normalized}")
        group["canonical_form"] = min(
            group["forms"], key=lambda item: (item.casefold(), item)
        )
        if len(concept_ids) > 1:
            lexeme_collisions.append(
                {
                    "normalized_form": normalized,
                    "concept_ids": concept_ids,
                    "forms": list(group["forms"]),
                }
            )
        candidates: dict[str, dict[str, int]] = {}
        for concept_id in concept_ids:
            concept = concept_by_id.get(concept_id, {})
            target = _effective_concept_target(concept)
            if not target:
                continue
            target_fields = [
                str(concept.get(name) or "").strip()
                for name in ("default_target", "working_target", "verified_target")
                if str(concept.get(name) or "").strip()
            ]
            score = candidates.setdefault(
                target,
                {"locked": 0, "verified": 0, "consistent": 0, "active_votes": 0},
            )
            score["locked"] += int(bool(concept.get("locked")))
            score["verified"] += int(
                str(concept.get("status") or "") == "verified"
                or str(concept.get("verified_target") or "").strip() == target
            )
            score["consistent"] += int(bool(target_fields) and len(set(target_fields)) == 1)
            score["active_votes"] += dependency_votes.get(concept_id, 0)
        ordered_targets = sorted(
            candidates,
            key=lambda target: (
                -candidates[target]["locked"],
                -candidates[target]["verified"],
                -candidates[target]["consistent"],
                -candidates[target]["active_votes"],
                target,
            ),
        )
        winner = ordered_targets[0] if ordered_targets else ""
        group["target"] = winner
        if len(ordered_targets) > 1:
            target_conflicts.append(
                {
                    "normalized_form": normalized,
                    "lexeme_id": group["lexeme_id"],
                    "winner": winner,
                    "targets": ordered_targets,
                    "scores": {target: candidates[target] for target in ordered_targets},
                    "concept_ids": concept_ids,
                }
            )

    translations_by_block: dict[str, list[dict[str, Any]]] = {}
    for translation in translations:
        if (
            str(translation.get("pipeline") or "") == "parallel_v4"
            and int(
                translation.get("active")
                if translation.get("active") is not None
                else 1
            )
            == 1
        ):
            translations_by_block.setdefault(
                str(translation.get("block_id") or ""), []
            ).append(translation)

    repair_block_ids: list[str] = []
    stale_translation_ids: list[int] = []
    for block in blocks:
        if str(block.get("status") or "") != "needs_revalidate":
            continue
        block_id = str(block.get("id") or "")
        active = translations_by_block.get(block_id, [])
        if not active:
            repair_block_ids.append(block_id)
            continue
        for translation in active:
            translation_id = int(translation.get("id") or 0)
            dependency_versions = [
                int(item.get("knowledge_version") or 0)
                for item in dependencies_by_translation.get(translation_id, [])
            ]
            translation_version = int(translation.get("knowledge_version") or 0)
            if (
                max_version > 0
                and (
                    translation_version < max_version
                    or any(version < max_version for version in dependency_versions)
                )
            ):
                stale_translation_ids.append(translation_id)

    return {
        "table_row_counts": tables,
        "concepts": concepts,
        "concept_by_id": concept_by_id,
        "forms": forms,
        "mentions": mentions,
        "old_lexemes": old_lexemes,
        "translations": translations,
        "dependencies": dependencies,
        "blocks": blocks,
        "groups": groups,
        "lexeme_collisions": lexeme_collisions,
        "target_conflicts": target_conflicts,
        "repair_block_ids": sorted(repair_block_ids),
        "stale_translation_ids": sorted(set(stale_translation_ids)),
        "max_version": max_version,
    }


def _backup_path(path: Path, source_hash: str) -> Path:
    modified = datetime.fromtimestamp(
        path.stat().st_mtime_ns / 1_000_000_000, timezone.utc
    ).strftime("%Y%m%dT%H%M%S%fZ")
    return (
        path.parent
        / "backups"
        / f"{path.stem}.schema7.{modified}.{source_hash[:16]}.db"
    )


def _preview_token(payload: Mapping[str, Any]) -> str:
    token_payload = {
        key: payload[key]
        for key in (
            "source_path",
            "source_sha256",
            "backup_path",
            "table_row_counts",
            "lexeme_collisions",
            "target_conflicts",
            "status_repairs",
            "stale_tasks",
        )
    }
    serialized = json.dumps(
        token_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(f"schema7-to-8\0{serialized}".encode("utf-8")).hexdigest()


def preview_schema8(path: str | Path) -> dict[str, Any]:
    """Build a stable schema-7 upgrade plan without creating or writing files."""

    source = _validated_database_path(path)
    wal_path = Path(f"{source}-wal")
    if wal_path.exists() and wal_path.stat().st_size:
        raise SchemaMigrationError(
            "schema migration requires a quiescent database with no pending WAL"
        )
    source_hash = _sha256_file(source)
    with closing(_connect_readonly(source)) as connection:
        version = inspect_schema(source)
        if version == SCHEMA_VERSION:
            backup_row = connection.execute(
                "SELECT value FROM schema_meta WHERE key='schema7_backup_path'"
            ).fetchone()
            return {
                "status": "already_schema8",
                "source_path": str(source),
                "source_sha256": source_hash,
                "backup_path": str(backup_row[0]) if backup_row else "",
                "table_row_counts": {},
                "lexeme_collisions": [],
                "target_conflicts": [],
                "status_repairs": 0,
                "stale_tasks": 0,
                "confirm_token": "",
            }
        if version != 7:
            raise SchemaMigrationError(
                f"only schema 7 can be migrated to schema 8 (found {version!r})"
            )
        analysis = _legacy_analysis(connection)
    if _sha256_file(source) != source_hash:
        raise SchemaMigrationError("schema migration source changed during preview")
    result: dict[str, Any] = {
        "status": "ready",
        "source_path": str(source),
        "source_sha256": source_hash,
        "backup_path": str(_backup_path(source, source_hash)),
        "table_row_counts": analysis["table_row_counts"],
        "lexeme_collisions": analysis["lexeme_collisions"],
        "target_conflicts": analysis["target_conflicts"],
        "status_repairs": len(analysis["repair_block_ids"]),
        "stale_tasks": len(analysis["stale_translation_ids"]),
    }
    result["confirm_token"] = _preview_token(result)
    return result


def _insert_mapping(
    connection: sqlite3.Connection,
    table: str,
    values: Mapping[str, Any],
    *,
    ignore: bool = False,
) -> None:
    allowed = _table_columns(connection, table)
    selected = {key: value for key, value in values.items() if key in allowed}
    if not selected:
        return
    columns = list(selected)
    prefix = "INSERT OR IGNORE" if ignore else "INSERT"
    connection.execute(
        f"{prefix} INTO {_quote_identifier(table)} "
        f"({', '.join(_quote_identifier(column) for column in columns)}) "
        f"VALUES({', '.join('?' for _ in columns)})",
        tuple(selected[column] for column in columns),
    )


def _rename_schema7_tables(connection: sqlite3.Connection) -> list[str]:
    renamed: list[str] = []
    for table in _SCHEMA8_REBUILT_TABLES:
        if not _table_exists(connection, table):
            continue
        legacy = f"__schema7_{table}"
        if _table_exists(connection, legacy):
            raise SchemaMigrationError(f"reserved migration table already exists: {legacy}")
        indexes = connection.execute(
            """SELECT name FROM sqlite_master
               WHERE type='index' AND tbl_name=? AND sql IS NOT NULL""",
            (table,),
        ).fetchall()
        for (index,) in indexes:
            connection.execute(f"DROP INDEX {_quote_identifier(str(index))}")
        connection.execute(
            f"ALTER TABLE {_quote_identifier(table)} "
            f"RENAME TO {_quote_identifier(legacy)}"
        )
        renamed.append(table)
    return renamed


def _legacy_name(table: str) -> str:
    return f"__schema7_{table}"


def _concept_rank(row: Mapping[str, Any]) -> tuple[int, int, str]:
    return (
        -int(bool(row.get("locked"))),
        -int(str(row.get("status") or "") == "verified"),
        str(row.get("id") or ""),
    )


def _rebuild_schema7_transaction(
    path: Path,
    *,
    source_hash: str,
    backup_path: Path,
) -> dict[str, int]:
    """Rebuild the copied database in one transaction; never touches source."""

    with closing(sqlite3.connect(path)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute("PRAGMA legacy_alter_table = ON")
        connection.execute("BEGIN IMMEDIATE")
        try:
            analysis = _legacy_analysis(connection)
            renamed = _rename_schema7_tables(connection)
            create_schema8(connection)
            max_version = int(analysis["max_version"] or 0)
            if _table_exists(connection, "knowledge_versions") and max_version == 0:
                connection.execute(
                    """INSERT INTO knowledge_versions(parent_id, reason, created_at)
                       VALUES(NULL, 'schema 7 to 8 migration', ?)""",
                    (datetime.now(timezone.utc).isoformat(),),
                )
                max_version = int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            now = datetime.now(timezone.utc).isoformat()
            groups: dict[str, dict[str, Any]] = analysis["groups"]
            concept_by_id: dict[str, dict[str, Any]] = analysis["concept_by_id"]
            concept_lexeme: dict[str, str] = {}
            old_lexeme_map: dict[str, str] = {}
            for normalized, group in sorted(groups.items()):
                lexeme_id = str(group["lexeme_id"])
                _insert_mapping(
                    connection,
                    "lexemes",
                    {
                        "id": lexeme_id,
                        "language": "en",
                        "normalized_form": normalized,
                        "canonical_form": group["canonical_form"],
                        "default_target": "",
                        "working_target": group["target"],
                        "verified_target": "",
                        "status": "working" if group["target"] else "provisional",
                        "locked": 0,
                        "created_version": max_version,
                        "retired_version": None,
                        "created_at": now,
                    },
                )
                for concept_id in group["concept_ids"]:
                    concept_lexeme[str(concept_id)] = lexeme_id
                for old_lexeme_id in group["old_lexeme_ids"]:
                    old_lexeme_map[str(old_lexeme_id)] = lexeme_id

            migrated_mentions: list[dict[str, Any]] = []
            next_mention_id = 1
            for legacy in analysis["mentions"]:
                mention_id = int(legacy.get("id") or next_mention_id)
                next_mention_id = max(next_mention_id, mention_id + 1)
                concept_id = str(legacy.get("concept_id") or "")
                normalized = _normalize_form(
                    legacy.get("source_form") or legacy.get("normalized_form")
                )
                lexeme_id = concept_lexeme.get(concept_id)
                if not lexeme_id:
                    lexeme_id = old_lexeme_map.get(str(legacy.get("lexeme_id") or ""))
                if not lexeme_id and normalized in groups:
                    lexeme_id = str(groups[normalized]["lexeme_id"])
                if not lexeme_id or legacy.get("evidence_id") is None:
                    continue
                migrated = dict(legacy)
                migrated.update(
                    {
                        "id": mention_id,
                        "normalized_form": normalized,
                        "lexeme_id": lexeme_id,
                        "concept_id": concept_id or None,
                    }
                )
                migrated_mentions.append(migrated)
            anchors: dict[str, int] = {}
            for mention in migrated_mentions:
                concept_id = str(mention.get("concept_id") or "")
                if concept_id:
                    anchors.setdefault(concept_id, int(mention["id"]))

            redirects: dict[str, str] = {}
            for group in groups.values():
                by_kind: dict[str, list[dict[str, Any]]] = {}
                for concept_id in group["concept_ids"]:
                    concept = concept_by_id.get(str(concept_id))
                    if concept:
                        by_kind.setdefault(str(concept.get("kind") or "concept"), []).append(concept)
                for same_kind in by_kind.values():
                    if len(same_kind) < 2:
                        continue
                    canonical = sorted(same_kind, key=_concept_rank)[0]
                    for duplicate in same_kind:
                        if duplicate is not canonical:
                            redirects[str(duplicate["id"])] = str(canonical["id"])

            for legacy in sorted(analysis["concepts"], key=lambda row: str(row.get("id") or "")):
                concept_id = str(legacy.get("id") or "")
                lexeme_id = concept_lexeme.get(concept_id)
                if not concept_id or not lexeme_id:
                    continue
                values = dict(legacy)
                values.update(
                    {
                        "primary_lexeme_id": lexeme_id,
                        "anchor_mention_id": anchors.get(concept_id),
                        "created_version": int(legacy.get("created_version") or max_version),
                        "retired_version": (
                            max_version
                            if concept_id in redirects and legacy.get("retired_version") is None
                            else legacy.get("retired_version")
                        ),
                        "created_at": legacy.get("created_at") or now,
                    }
                )
                _insert_mapping(connection, "concepts", values)
                _insert_mapping(
                    connection,
                    "concept_lexemes",
                    {
                        "concept_id": concept_id,
                        "lexeme_id": lexeme_id,
                        "role": "primary",
                        "confidence": 1.0,
                        "status": legacy.get("status") or "provisional",
                        "created_version": int(legacy.get("created_version") or max_version),
                        "retired_version": values["retired_version"],
                        "created_at": legacy.get("created_at") or now,
                    },
                    ignore=True,
                )
                _insert_mapping(
                    connection,
                    "concept_type_observations",
                    {
                        "concept_id": concept_id,
                        "lexeme_id": lexeme_id,
                        "mention_id": anchors.get(concept_id),
                        "evidence_id": None,
                        "kind": legacy.get("kind") or "concept",
                        "confidence": 1.0 if legacy.get("locked") or legacy.get("status") == "verified" else 0.8,
                        "source": "human" if legacy.get("locked") else "schema7_migration",
                        "adjudication_id": None,
                        "created_version": int(legacy.get("created_version") or max_version),
                        "retired_version": values["retired_version"],
                        "created_at": now,
                    },
                )

            for mention in migrated_mentions:
                _insert_mapping(connection, "mentions", mention, ignore=True)

            seen_forms: set[tuple[str, str, str]] = set()
            form_inputs = list(analysis["forms"]) + [
                {
                    "form": mention.get("source_form"),
                    "normalized_form": mention.get("normalized_form"),
                    "concept_id": mention.get("concept_id"),
                    "lexeme_id": mention.get("lexeme_id"),
                    "grammar_json": "{}",
                }
                for mention in migrated_mentions
            ]
            for legacy in form_inputs:
                form = str(legacy.get("form") or "").strip()
                normalized = _normalize_form(form or legacy.get("normalized_form"))
                lexeme_id = concept_lexeme.get(str(legacy.get("concept_id") or ""))
                if not lexeme_id:
                    lexeme_id = old_lexeme_map.get(str(legacy.get("lexeme_id") or ""))
                if not lexeme_id and normalized in groups:
                    lexeme_id = str(groups[normalized]["lexeme_id"])
                key = (str(lexeme_id or ""), normalized, form)
                if not lexeme_id or not form or key in seen_forms:
                    continue
                seen_forms.add(key)
                _insert_mapping(
                    connection,
                    "source_forms",
                    {
                        "lexeme_id": lexeme_id,
                        "form": form,
                        "normalized_form": normalized,
                        "grammar_json": legacy.get("grammar_json") or "{}",
                    },
                    ignore=True,
                )

            if "candidate_resolutions" in renamed:
                for legacy in _table_rows(connection, _legacy_name("candidate_resolutions")):
                    concept_id = str(legacy.get("concept_id") or "")
                    values = dict(legacy)
                    values["concept_id"] = redirects.get(concept_id, concept_id) or None
                    values["lexeme_id"] = (
                        concept_lexeme.get(concept_id)
                        or old_lexeme_map.get(str(legacy.get("lexeme_id") or ""))
                    )
                    _insert_mapping(connection, "candidate_resolutions", values, ignore=True)

            for legacy in (
                _table_rows(connection, _legacy_name("rendering_rules"))
                if "rendering_rules" in renamed
                else []
            ):
                concept_id = str(legacy.get("concept_id") or "")
                concept = concept_by_id.get(concept_id, {})
                keep_concept = bool(legacy.get("locked")) or bool(concept.get("locked"))
                keep_concept = keep_concept or str(legacy.get("condition_json") or "{}").strip() not in {"", "{}"}
                values = dict(legacy)
                if keep_concept:
                    values["concept_id"] = redirects.get(concept_id, concept_id)
                    values["lexeme_id"] = None
                else:
                    values["concept_id"] = None
                    values["lexeme_id"] = concept_lexeme.get(concept_id) or old_lexeme_map.get(
                        str(legacy.get("lexeme_id") or "")
                    )
                if values.get("concept_id") or values.get("lexeme_id"):
                    _insert_mapping(connection, "rendering_rules", values, ignore=True)

            stale_ids = set(int(item) for item in analysis["stale_translation_ids"])
            if "translation_versions" in renamed:
                for legacy in _table_rows(connection, _legacy_name("translation_versions")):
                    translation_id = int(legacy.get("id") or 0)
                    dep_payload = sorted(
                        (
                            str(item.get("dependency_type") or ""),
                            str(item.get("dependency_id") or ""),
                            int(item.get("knowledge_version") or 0),
                        )
                        for item in analysis["dependencies"]
                        if int(item.get("translation_id") or 0) == translation_id
                    )
                    values = dict(legacy)
                    values.update(
                        {
                            "validation_status": "warning_stale" if translation_id in stale_ids else str(legacy.get("validation_status") or "clean"),
                            "validated_knowledge_version": legacy.get("validated_knowledge_version") or legacy.get("knowledge_version"),
                            "validation_fingerprint": str(legacy.get("validation_fingerprint") or hashlib.sha256(json.dumps(dep_payload, sort_keys=True).encode()).hexdigest()),
                        }
                    )
                    _insert_mapping(connection, "translation_versions", values, ignore=True)

            if "dependencies" in renamed:
                for legacy in _table_rows(connection, _legacy_name("dependencies")):
                    dependency_type = str(legacy.get("dependency_type") or "")
                    dependency_id = str(legacy.get("dependency_id") or "")
                    matched_form = str(legacy.get("matched_form") or "")
                    rendered_target = str(legacy.get("rendered_target") or "")
                    if dependency_type == "concept":
                        concept = concept_by_id.get(dependency_id, {})
                        if concept.get("locked"):
                            dependency_id = redirects.get(dependency_id, dependency_id)
                            rendered_target = rendered_target or _effective_concept_target(concept)
                        else:
                            dependency_type = "lexeme"
                            dependency_id = concept_lexeme.get(dependency_id, dependency_id)
                            normalized = next(
                                (
                                    name
                                    for name, group in groups.items()
                                    if str(group["lexeme_id"]) == dependency_id
                                ),
                                "",
                            )
                            group = groups.get(normalized, {})
                            matched_form = matched_form or str(group.get("canonical_form") or "")
                            rendered_target = rendered_target or str(group.get("target") or "")
                    elif dependency_type == "lexeme":
                        dependency_id = old_lexeme_map.get(dependency_id, dependency_id)
                    fingerprint_payload = {
                        "type": dependency_type,
                        "id": dependency_id,
                        "target": rendered_target,
                    }
                    values = dict(legacy)
                    values.update(
                        {
                            "dependency_type": dependency_type,
                            "dependency_id": dependency_id,
                            "dependency_fingerprint": str(legacy.get("dependency_fingerprint") or hashlib.sha256(json.dumps(fingerprint_payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()),
                            "matched_form": matched_form,
                            "occurrence_count": int(legacy.get("occurrence_count") or 0),
                            "rendered_target": rendered_target,
                            "applied_rule_ids_json": legacy.get("applied_rule_ids_json") or "[]",
                            "source_spans_json": legacy.get("source_spans_json") or "[]",
                        }
                    )
                    _insert_mapping(connection, "dependencies", values, ignore=True)

            for group in groups.values():
                concept_ids = list(group["concept_ids"])
                for left_index, left_id in enumerate(concept_ids):
                    for right_id in concept_ids[left_index + 1 :]:
                        left = concept_by_id.get(str(left_id), {})
                        right = concept_by_id.get(str(right_id), {})
                        relation = "same" if str(left.get("kind")) == str(right.get("kind")) else "different"
                        payload = f"{group['lexeme_id']}:{left_id}:{right_id}:{relation}"
                        _insert_mapping(
                            connection,
                            "coreference_decisions",
                            {
                                "id": _stable_id("coref", payload, 24),
                                "lexeme_id": group["lexeme_id"],
                                "left_anchor_type": "concept",
                                "left_anchor_id": left_id,
                                "right_anchor_type": "concept",
                                "right_anchor_id": right_id,
                                "relation": relation,
                                "decision_source": "deterministic",
                                "confidence": 1.0,
                                "locked": int(bool(left.get("locked")) or bool(right.get("locked"))),
                                "votes_json": "[]",
                                "evidence_ids_json": "[]",
                                "anchor_members_json": "[]",
                                "payload_hash": hashlib.sha256(payload.encode()).hexdigest(),
                                "created_version": max_version,
                                "retired_version": None,
                                "created_at": now,
                            },
                            ignore=True,
                        )
            for retired_id, canonical_id in sorted(redirects.items()):
                _insert_mapping(
                    connection,
                    "concept_redirects",
                    {
                        "retired_concept_id": retired_id,
                        "canonical_concept_id": canonical_id,
                        "reason": "schema7 deterministic same-lexeme same-type merge",
                        "knowledge_version": max_version,
                        "created_at": now,
                    },
                    ignore=True,
                )

            block_by_id = {
                str(row.get("id") or ""): row for row in analysis["blocks"]
            }
            forms_by_source: dict[str, set[str]] = {}
            for group in groups.values():
                lexeme_id = str(group["lexeme_id"])
                for form in group["forms"]:
                    source_form = str(form).strip()
                    if source_form:
                        forms_by_source.setdefault(source_form, set()).add(lexeme_id)
            occurrence_matcher = MultiFormMatcher.compile(forms_by_source)
            for block_id, block in block_by_id.items():
                source_text = str(block.get("source_text") or "")
                source_hash = block.get("source_hash") or hashlib.sha256(
                    source_text.encode()
                ).hexdigest()
                occurrence_rows = [
                    (
                        lexeme_id,
                        block_id,
                        start_offset,
                        end_offset,
                        source_form,
                        source_hash,
                        now,
                    )
                    for lexeme_id, source_form, start_offset, end_offset
                    in occurrence_matcher.finditer(source_text)
                ]
                connection.executemany(
                    """INSERT OR IGNORE INTO form_occurrences(
                           lexeme_id, block_id, start_offset, end_offset,
                           source_form, source_hash, created_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?)""",
                    occurrence_rows,
                )

            for block_id in analysis["repair_block_ids"]:
                connection.execute(
                    "UPDATE blocks SET status='ready', last_error=NULL WHERE id=?",
                    (block_id,),
                )
            translations_by_id = {
                int(row.get("id") or 0): row for row in analysis["translations"]
            }
            if "knowledge_changes" in renamed:
                for legacy in _table_rows(
                    connection, _legacy_name("knowledge_changes")
                ):
                    _insert_mapping(
                        connection, "knowledge_changes", legacy, ignore=True
                    )
            for translation_id in analysis["stale_translation_ids"]:
                translation = translations_by_id[int(translation_id)]
                from_version = int(translation.get("knowledge_version") or max_version)
                dependency = connection.execute(
                    """SELECT dependency_type, dependency_id,
                              dependency_fingerprint
                       FROM dependencies WHERE translation_id=?
                       ORDER BY id LIMIT 1""",
                    (translation_id,),
                ).fetchone()
                subject_type = (
                    str(dependency["dependency_type"])
                    if dependency is not None
                    else "translation"
                )
                subject_id = (
                    str(dependency["dependency_id"])
                    if dependency is not None
                    else str(translation_id)
                )
                change_kind = "schema7_stale_dependency"
                change_payload = {
                    "reason": "schema 7 active translation predates migrated knowledge",
                    "old": {"knowledge_version": from_version},
                    "new": {"knowledge_version": max_version},
                }
                change_id = int(
                    connection.execute(
                        """INSERT INTO knowledge_changes(
                               knowledge_version, subject_type, subject_id,
                               change_kind, old_fingerprint, new_fingerprint,
                               impact_level, payload_json, created_at)
                           VALUES(?, ?, ?, ?, '', ?, 2, ?, ?)""",
                        (
                            max_version,
                            subject_type,
                            subject_id,
                            change_kind,
                            (
                                str(dependency["dependency_fingerprint"])
                                if dependency is not None
                                else ""
                            ),
                            json.dumps(
                                change_payload,
                                ensure_ascii=False,
                                sort_keys=True,
                                separators=(",", ":"),
                            ),
                            now,
                        ),
                    ).lastrowid
                )
                change_hash = hashlib.sha256(
                    json.dumps(
                        {
                            "change_ids": [change_id],
                            "to_knowledge_version": max_version,
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ).hexdigest()
                task_result = json.dumps(
                    {
                        "change_ids": [change_id],
                        "subjects": [
                            {
                                "subject_type": subject_type,
                                "subject_id": subject_id,
                            }
                        ],
                        "omitted_subjects": 0,
                        "reasons": [
                            {
                                "change_id": change_id,
                                "change_kind": change_kind,
                                "via": ["schema7_migration"],
                                "subjects": [
                                    {
                                        "subject_type": subject_type,
                                        "subject_id": subject_id,
                                    }
                                ],
                            }
                        ],
                        "omitted_reasons": 0,
                        "source_hash": str(
                            block_by_id.get(
                                str(translation.get("block_id") or ""), {}
                            ).get("source_hash")
                            or ""
                        ),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                _insert_mapping(
                    connection,
                    "revalidation_tasks",
                    {
                        "id": _stable_id("revalidate", f"{translation_id}:{change_hash}", 24),
                        "translation_id": translation_id,
                        "block_id": translation.get("block_id"),
                        "from_knowledge_version": from_version,
                        "to_knowledge_version": max_version,
                        "change_set_hash": change_hash,
                        "impact_level": 2,
                        "status": "pending",
                        "action": "",
                        "attempts": 0,
                        "result_json": task_result,
                        "created_at": now,
                    },
                    ignore=True,
                )

            for conflict in analysis["target_conflicts"]:
                payload_json = json.dumps(conflict, ensure_ascii=False, sort_keys=True)
                if _table_exists(connection, "audit_calls"):
                    exists = connection.execute(
                        "SELECT 1 FROM audit_calls WHERE purpose=? AND request_json=?",
                        ("schema8_target_conflict", payload_json),
                    ).fetchone()
                    if exists is None:
                        _insert_mapping(
                            connection,
                            "audit_calls",
                            {
                                "run_id": None,
                                "block_id": None,
                                "purpose": "schema8_target_conflict",
                                "model": "deterministic_migration",
                                "knowledge_version": max_version,
                                "request_json": payload_json,
                                "raw_response": conflict["winner"],
                                "parsed_json": payload_json,
                                "accepted": 1,
                                "attempts": 1,
                                "elapsed_ms": 0,
                                "error": None,
                                "created_at": now,
                            },
                        )
                if _table_exists(connection, "human_queue"):
                    _insert_mapping(
                        connection,
                        "human_queue",
                        {
                            "block_id": None,
                            "kind": "schema8_target_conflict",
                            "severity": "warning",
                            "status": "open",
                            "payload_json": payload_json,
                            "created_at": now,
                            "resolved_at": None,
                        },
                    )

            for table in ("revalidation_tasks",):
                if table not in renamed:
                    continue
                for legacy in _table_rows(connection, _legacy_name(table)):
                    _insert_mapping(connection, table, legacy, ignore=True)

            if "schema_meta" in renamed:
                for legacy in _table_rows(connection, _legacy_name("schema_meta")):
                    if str(legacy.get("key") or "") != "schema_version":
                        _insert_mapping(connection, "schema_meta", legacy, ignore=True)
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '8')"
            )
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema7_source_sha256', ?)",
                (source_hash,),
            )
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema7_backup_path', ?)",
                (str(backup_path),),
            )
            for table in reversed(renamed):
                connection.execute(f"DROP TABLE {_quote_identifier(_legacy_name(table))}")
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise SchemaMigrationError(f"migrated database failed integrity check: {integrity}")
            foreign_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
            if foreign_errors:
                raise SchemaMigrationError(
                    f"migrated database failed foreign-key check: {foreign_errors[0]}"
                )
            connection.commit()
            return {
                "status_repairs": len(analysis["repair_block_ids"]),
                "stale_tasks": len(analysis["stale_translation_ids"]),
                "target_conflict_count": len(analysis["target_conflicts"]),
            }
        except Exception:
            connection.rollback()
            raise


def _sqlite_backup(source: Path, destination: Path) -> None:
    source_uri = f"{source.resolve().as_uri()}?mode=ro&immutable=1"
    with closing(sqlite3.connect(source_uri, uri=True)) as source_connection, closing(
        sqlite3.connect(destination)
    ) as destination_connection:
        source_connection.backup(destination_connection)


def _best_effort_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def confirm_schema8(path: str | Path, confirm_token: str) -> dict[str, Any]:
    """Confirm a matching preview, retain a backup, then atomically install schema 8."""

    source = _validated_database_path(path)
    preview = preview_schema8(source)
    if preview["status"] == "already_schema8":
        return preview
    expected = str(preview["confirm_token"])
    if not isinstance(confirm_token, str) or not hmac.compare_digest(
        confirm_token, expected
    ):
        raise SchemaMigrationError(
            "schema migration confirm token is invalid or expired; run preview again"
        )
    backup = Path(str(preview["backup_path"]))
    backup.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists():
        if inspect_schema(backup) != 7:
            raise SchemaMigrationError("schema migration backup path is already occupied")
    else:
        _sqlite_backup(source, backup)
        # SQLite's backup API can rewrite page-header bytes. The retained copy
        # is normalized to the quiescent source bytes so reuse can be bound to
        # the preview's byte hash without trusting path or schema alone.
        if _sha256_file(backup) != str(preview["source_sha256"]):
            shutil.copyfile(source, backup)
    if _sha256_file(backup) != str(preview["source_sha256"]):
        raise SchemaMigrationError(
            "existing schema migration backup SHA-256 does not match preview source"
        )
    staging = source.parent / f".{source.name}.{uuid.uuid4().hex}.migrating"
    try:
        _sqlite_backup(backup, staging)
        summary = _rebuild_schema7_transaction(
            staging,
            source_hash=str(preview["source_sha256"]),
            backup_path=backup,
        )
        if inspect_schema(staging) != SCHEMA_VERSION:
            raise SchemaMigrationError("staged database did not reach schema 8")
        _assert_schema8_features(staging)
        # All fallible validation and cleanup must finish before the atomic
        # replacement. A raised cleanup error therefore leaves schema 7 live.
        for database_path in (source, staging):
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{database_path}{suffix}")
                if sidecar.exists():
                    sidecar.unlink()
        os.replace(staging, source)
    finally:
        _best_effort_unlink(staging)
        for suffix in ("-wal", "-shm"):
            _best_effort_unlink(Path(f"{staging}{suffix}"))
    return {
        **preview,
        **summary,
        "status": "migrated",
        "backup_path": str(backup),
    }


def migrate_schema8(path: str | Path, confirm_token: str) -> dict[str, Any]:
    """Compatibility spelling for callers that treat confirmation as migration."""

    return confirm_schema8(path, confirm_token)


@lru_cache(maxsize=1)
def _expected_schema8_signature() -> tuple[tuple[str, str, str], ...]:
    with closing(sqlite3.connect(":memory:")) as connection:
        create_schema8(connection)
        signature = _schema_signature(connection)
    return tuple(
        (object_type, name, sql)
        for (object_type, name), sql in sorted(signature.items())
    )


def _assert_schema8_features(path: Path) -> None:
    expected = {
        (object_type, name): sql
        for object_type, name, sql in _expected_schema8_signature()
    }
    with closing(_connect_readonly(path)) as connection:
        actual = _schema_signature(connection)

    errors: list[str] = []
    for (object_type, name), expected_sql in expected.items():
        actual_sql = actual.get((object_type, name))
        if actual_sql is None:
            errors.append(f"missing {object_type} {name}")
        elif actual_sql != expected_sql:
            errors.append(f"noncanonical {object_type} {name}")
    if errors:
        detail = "; ".join(errors[:4])
        raise SchemaUpgradeRequired(
            f"parallel_v4 schema 8 is incomplete or corrupt ({detail}); "
            "run migrate-v4 --preview before opening it"
        )


def assert_schema8_or_empty(path: Path) -> None:
    """Create schema 8 for an empty path or reject any older database."""

    path = Path(path)
    version = inspect_schema(path)
    if version == SCHEMA_VERSION:
        _assert_schema8_features(path)
        return
    if version is not None:
        raise SchemaUpgradeRequired(
            f"parallel_v4 schema {version} requires an explicit upgrade; "
            "run migrate-v4 --preview and confirm the migration before opening it"
        )

    if path.exists() and path.stat().st_size:
        with closing(_connect_readonly(path)) as connection:
            user_tables = connection.execute(
                """SELECT name FROM sqlite_master
                   WHERE type='table' AND name NOT LIKE 'sqlite_%'"""
            ).fetchall()
        if user_tables:
            raise SchemaUpgradeRequired(
                "unversioned parallel_v4 database requires an explicit upgrade; "
                "run migrate-v4 --preview before opening it"
            )

    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        create_schema8(connection)
