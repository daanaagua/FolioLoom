import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.core.v4.database import V4Database
from src.core.v4.models import ScanOutcome, ScanResponse
from src.core.v4 import schema_v8
from src.core.v4.migration import V4Migrator
from src.core.v4.schema_v8 import (
    SchemaMigrationError,
    SchemaUpgradeRequired,
    confirm_schema8,
    create_schema8,
    preview_schema8,
)
from src.core.v4.schema_v9 import (
    SCHEMA_VERSION,
    migrate_schema9,
    preview_schema9,
)


def seed_schema7_database(tmp_path):
    path = tmp_path / "artifacts" / "parallel_v4" / "book.db"
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO schema_meta VALUES('schema_version', '7');
            """
        )
    return path


def seed_schema7_migration_fixture(tmp_path):
    database = V4Database(tmp_path)
    path = database.path
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.executescript(
            """
            DROP TABLE source_forms;
            CREATE TABLE source_forms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                concept_id TEXT NOT NULL,
                form TEXT NOT NULL,
                normalized_form TEXT NOT NULL,
                grammar_json TEXT NOT NULL DEFAULT '{}'
            );
            DROP TABLE mentions;
            CREATE TABLE mentions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                block_id TEXT NOT NULL,
                paragraph_id TEXT NOT NULL,
                source_form TEXT NOT NULL,
                normalized_form TEXT NOT NULL,
                discourse_function TEXT NOT NULL,
                concept_id TEXT NOT NULL,
                evidence_id INTEGER NOT NULL
            );
            DROP TABLE rendering_rules;
            CREATE TABLE rendering_rules (
                id TEXT PRIMARY KEY,
                concept_id TEXT NOT NULL,
                condition_json TEXT NOT NULL,
                target TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'provisional',
                scope TEXT NOT NULL DEFAULT 'book',
                locked INTEGER NOT NULL DEFAULT 0,
                created_version INTEGER NOT NULL,
                retired_version INTEGER,
                created_at TEXT NOT NULL
            );
            DROP TABLE dependencies;
            DROP TABLE translation_versions;
            CREATE TABLE translation_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                block_id TEXT NOT NULL,
                pipeline TEXT NOT NULL,
                run_id TEXT,
                knowledge_version INTEGER,
                status TEXT NOT NULL,
                draft_translation TEXT NOT NULL DEFAULT '',
                final_translation TEXT NOT NULL DEFAULT '',
                analysis TEXT NOT NULL DEFAULT '',
                semantic_obligations TEXT NOT NULL DEFAULT '',
                memory_summary TEXT NOT NULL DEFAULT '',
                warnings_json TEXT NOT NULL DEFAULT '[]',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE dependencies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                translation_id INTEGER NOT NULL,
                dependency_type TEXT NOT NULL,
                dependency_id TEXT NOT NULL,
                knowledge_version INTEGER NOT NULL,
                UNIQUE(translation_id, dependency_type, dependency_id)
            );
            DELETE FROM concepts;
            DELETE FROM blocks;
            DELETE FROM source_editions;
            DELETE FROM knowledge_versions;
            INSERT INTO knowledge_versions(id, parent_id, reason, created_at)
            VALUES(1, NULL, 'schema7 base', '2026-01-01T00:00:00+00:00'),
                  (2, 1, 'target changed', '2026-01-02T00:00:00+00:00');
            INSERT INTO source_editions(
                id, raw_sha256, normalized_sha256, parser_version,
                source_path, active, created_at)
            VALUES(1, 'raw', 'normalized', 'schema7', 'source.txt', 1, 'now');
            """
        )
        concepts = [
            ("c-briah-place", "place", "Briah", "", "", "", "provisional", 0),
            ("c-briah-work", "work", "BRIAH", "", "", "", "provisional", 0),
            ("c-mal-old", "person", "Malrubius", "旧马", "旧马", "", "provisional", 0),
            ("c-mal-locked", "person", "MALRUBIUS", "锁定马", "锁定马", "锁定马", "verified", 1),
            ("c-tri-old", "object", "Triskele", "三曲", "三曲", "", "provisional", 0),
            ("c-tri-new", "object", "TRISKELE", "三旋", "三旋", "三旋", "verified", 0),
        ]
        connection.executemany(
            """INSERT INTO concepts(
                   id, kind, canonical_source, default_target, working_target,
                   verified_target, description, status, scope, locked,
                   created_version, created_at)
               VALUES(?, ?, ?, ?, ?, ?, '', ?, 'book', ?, 1, 'now')""",
            concepts,
        )
        for index in range(38):
            status = "needs_revalidate" if index < 37 else "ready"
            text = (
                "Malrubius named the Triskele in Briah."
                if index == 36
                else f"Quiet block {index}."
            )
            connection.execute(
                """INSERT INTO blocks(
                       id, legacy_id, source_edition_id, chapter_id,
                       chapter_title, chapter_index, block_index, global_index,
                       source_text, source_hash, status, updated_at)
                   VALUES(?, ?, 1, 'ch-1', 'Same title', 0, ?, ?, ?, ?, ?, 'now')""",
                (
                    f"block-{index:02d}",
                    f"legacy-{index:02d}",
                    index,
                    index,
                    text,
                    hashlib.sha256(text.encode()).hexdigest(),
                    status,
                ),
            )
        for ordinal, concept in enumerate(concepts, start=1):
            concept_id, _, source, *_ = concept
            evidence_id = connection.execute(
                """INSERT INTO evidence(
                       block_id, paragraph_id, kind, source_form,
                       evidence_quote, payload_json, confidence, extractor,
                       created_at)
                   VALUES('block-36', ?, 'legacy', ?, ?, '{}', 1.0,
                          'schema7', 'now')""",
                (f"P{ordinal:03d}", source, source),
            ).lastrowid
            connection.execute(
                """INSERT INTO mentions(
                       block_id, paragraph_id, source_form, normalized_form,
                       discourse_function, concept_id, evidence_id)
                   VALUES('block-36', ?, ?, ?, 'referential', ?, ?)""",
                (f"P{ordinal:03d}", source, source.casefold(), concept_id, evidence_id),
            )
            connection.execute(
                """INSERT INTO source_forms(
                       concept_id, form, normalized_form, grammar_json)
                   VALUES(?, ?, ?, '{}')""",
                (concept_id, source, source.casefold()),
            )
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at)
               VALUES('locked-rule', 'c-mal-locked', '{}', '锁定马', 100,
                      'verified', 'book', 1, 1, 'now')"""
        )
        active_id = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at)
               VALUES('block-36', 'parallel_v4', 1, 'completed',
                      '旧译文', 1, 'now')"""
        ).lastrowid
        historical_id = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at)
               VALUES('block-36', 'parallel_v4', 1, 'completed',
                      '历史译文', 0, 'before')"""
        ).lastrowid
        connection.executemany(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version)
               VALUES(?, 'concept', 'c-mal-old', 1)""",
            ((active_id,), (historical_id,)),
        )
        connection.execute(
            """INSERT INTO audit_calls(
                   purpose, model, request_json, raw_response, accepted,
                   archive_relative_path, archive_offset,
                   archive_compressed_length, archive_sha256, created_at)
               VALUES('locked legacy decision', 'human', '{}', '{}', 1,
                      'audit/locked.jsonl.zst', 7, 11, 'archive-hash', 'now')"""
        )
        connection.execute(
            "UPDATE schema_meta SET value='7' WHERE key='schema_version'"
        )
        connection.commit()
    return path.resolve()


def read_schema_version(path):
    with closing(sqlite3.connect(path)) as connection:
        return int(
            connection.execute(
                "SELECT value FROM schema_meta WHERE key='schema_version'"
            ).fetchone()[0]
        )


def upgrade_schema8_fixture_to_schema9(path):
    preview = preview_schema9(Path(path).resolve())
    return migrate_schema9(path, preview["confirmation_token"])


def filesystem_snapshot(root):
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def seed_incomplete_schema8(tmp_path, corruption):
    path = tmp_path / "artifacts" / "parallel_v4" / "book.db"
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as connection:
        if corruption == "sentinel":
            connection.executescript(
                """
                CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT INTO schema_meta VALUES('schema_version', '8');
                CREATE TABLE sentinel(value TEXT);
                """
            )
        else:
            create_schema8(connection)
            if corruption == "table":
                connection.execute("DROP TABLE lexemes")
            elif corruption == "concepts_table":
                connection.execute("DROP TABLE concepts")
            elif corruption == "column":
                connection.executescript(
                    """
                    DROP TABLE candidate_resolutions;
                    CREATE TABLE candidate_resolutions(id TEXT PRIMARY KEY);
                    """
                )
            elif corruption == "index":
                connection.execute("DROP INDEX uq_active_lexeme")
            elif corruption == "lexeme_index_and_false":
                connection.executescript(
                    """
                    DROP INDEX uq_active_lexeme;
                    CREATE UNIQUE INDEX uq_active_lexeme
                    ON lexemes(language, normalized_form)
                    WHERE retired_version IS NULL AND 0;
                    """
                )
            elif corruption == "concept_lexeme_index_and_false":
                connection.executescript(
                    """
                    DROP INDEX uq_active_concept_lexeme_role;
                    CREATE UNIQUE INDEX uq_active_concept_lexeme_role
                    ON concept_lexemes(concept_id, lexeme_id, role)
                    WHERE retired_version IS NULL AND 0;
                    """
                )
            elif corruption == "legacy_dependencies":
                connection.executescript(
                    """
                    DROP TABLE dependencies;
                    CREATE TABLE dependencies (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        translation_id INTEGER NOT NULL,
                        dependency_type TEXT NOT NULL,
                        dependency_id TEXT NOT NULL,
                        knowledge_version INTEGER NOT NULL,
                        UNIQUE(translation_id, dependency_type, dependency_id)
                    );
                    """
                )
            elif corruption == "rendering_check":
                connection.executescript(
                    """
                    ALTER TABLE rendering_rules RENAME TO old_rendering_rules;
                    CREATE TABLE rendering_rules (
                        id TEXT PRIMARY KEY,
                        lexeme_id TEXT,
                        concept_id TEXT,
                        condition_json TEXT NOT NULL,
                        target TEXT NOT NULL,
                        created_version INTEGER NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    DROP TABLE old_rendering_rules;
                    """
                )
            elif corruption == "translation_check":
                connection.executescript(
                    """
                    ALTER TABLE translation_versions RENAME TO old_translation_versions;
                    CREATE TABLE translation_versions (
                        id INTEGER PRIMARY KEY,
                        block_id TEXT NOT NULL,
                        pipeline TEXT NOT NULL,
                        status TEXT NOT NULL,
                        validation_status TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    DROP TABLE old_translation_versions;
                    """
                )
            elif corruption == "translation_literal_case":
                schema_version = connection.execute(
                    "PRAGMA schema_version"
                ).fetchone()[0]
                connection.execute("PRAGMA writable_schema = ON")
                connection.execute(
                    """UPDATE sqlite_master
                       SET sql=replace(
                           sql,
                           '''clean'', ''pending''',
                           '''CLEAN'', ''pending'''
                       )
                       WHERE type='table' AND name='translation_versions'"""
                )
                connection.execute("PRAGMA writable_schema = OFF")
                connection.execute(f"PRAGMA schema_version = {schema_version + 1}")
            elif corruption == "revalidation_check":
                connection.executescript(
                    """
                    DROP TABLE revalidation_tasks;
                    CREATE TABLE revalidation_tasks (
                        id TEXT PRIMARY KEY,
                        status TEXT NOT NULL
                    );
                    """
                )
            else:
                raise AssertionError(f"unknown corruption: {corruption}")
            connection.commit()
    return path


def test_schema7_requires_explicit_preview_and_confirm(tmp_path):
    path = seed_schema7_database(tmp_path)
    with pytest.raises(SchemaUpgradeRequired, match="migrate-v4 --preview"):
        V4Database(tmp_path)
    assert read_schema_version(path) == 7


def test_minimal_schema7_meta_is_rebuilt_canonically(tmp_path):
    path = seed_schema7_database(tmp_path).resolve()
    preview = preview_schema8(path)

    assert confirm_schema8(path, preview["confirm_token"])["status"] == "migrated"
    upgrade_schema8_fixture_to_schema9(path)
    V4Database(tmp_path)


def test_v4_migrator_delays_database_open_until_explicit_schema_check(tmp_path):
    path = seed_schema7_database(tmp_path)
    project = SimpleNamespace(root_dir=tmp_path)

    migrator = V4Migrator(project)

    assert migrator.database is None
    assert read_schema_version(path) == 7
    with pytest.raises(SchemaUpgradeRequired, match="schema 9 upgrade"):
        migrator.migrate()
    assert migrator.database is None
    assert read_schema_version(path) == 7


def test_schema7_preview_is_stable_read_only_and_rejects_bad_confirm(tmp_path):
    path = seed_schema7_migration_fixture(tmp_path)
    before = filesystem_snapshot(tmp_path)

    first = preview_schema8(path)
    second = preview_schema8(path)

    assert first == second
    assert first["status"] == "ready"
    assert first["source_path"] == str(path)
    assert first["source_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert first["table_row_counts"]["blocks"] == 38
    assert len(first["lexeme_collisions"]) == 3
    assert len(first["target_conflicts"]) == 2
    assert first["status_repairs"] == 36
    assert first["stale_tasks"] == 1
    assert first["confirm_token"]
    assert filesystem_snapshot(tmp_path) == before

    with pytest.raises(SchemaMigrationError, match="confirm token"):
        confirm_schema8(path, "wrong-token")
    assert filesystem_snapshot(tmp_path) == before


def test_schema7_confirm_backs_up_migrates_and_is_idempotent(tmp_path):
    path = seed_schema7_migration_fixture(tmp_path)
    preview = preview_schema8(path)

    result = confirm_schema8(path, preview["confirm_token"])

    assert result["status"] == "migrated"
    backup_path = Path(result["backup_path"])
    assert backup_path.exists()
    assert backup_path.parent.parent == path.parent
    assert read_schema_version(backup_path) == 7
    assert read_schema_version(path) == 8
    second = confirm_schema8(path, preview["confirm_token"])
    assert second["status"] == "already_schema8"
    assert second["backup_path"] == result["backup_path"]
    upgrade_schema8_fixture_to_schema9(path)
    database = V4Database(tmp_path)
    with closing(database.connect()) as connection:
        repaired = connection.execute(
            "SELECT COUNT(*) FROM blocks WHERE status='ready'"
        ).fetchone()[0]
        stale = connection.execute(
            """SELECT validation_status FROM translation_versions
               WHERE pipeline='parallel_v4' AND active=1"""
        ).fetchone()[0]
        task_count = connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks"
        ).fetchone()[0]
        locked = connection.execute(
            """SELECT locked, verified_target FROM concepts
               WHERE id='c-mal-locked'"""
        ).fetchone()
        rule = connection.execute(
            """SELECT concept_id, lexeme_id, locked FROM rendering_rules
               WHERE id='locked-rule'"""
        ).fetchone()
        lexeme = connection.execute(
            """SELECT working_target, locked FROM lexemes
               WHERE normalized_form='malrubius'"""
        ).fetchone()
        locator = connection.execute(
            """SELECT archive_relative_path, archive_offset,
                      archive_compressed_length, archive_sha256
               FROM audit_calls WHERE purpose='locked legacy decision'"""
        ).fetchone()
    assert repaired == 37
    assert stale == "warning_stale"
    assert task_count == 1
    assert tuple(locked) == (1, "锁定马")
    assert tuple(rule) == ("c-mal-locked", None, 1)
    assert tuple(lexeme) == ("锁定马", 0)
    assert tuple(locator) == ("audit/locked.jsonl.zst", 7, 11, "archive-hash")

def test_schema7_occurrence_backfill_preserves_matcher_boundaries_and_offsets(
    tmp_path,
):
    path = seed_schema7_migration_fixture(tmp_path)
    source_text = "SEVERIAN Severiana ia; cosmos OS. O’Neill O’Neills and O'Neill."
    forms = (
        ("c-severian", "person", "Severian"),
        ("c-ia", "term", "ia"),
        ("c-os", "term", "os"),
        ("c-oneill", "person", "O’Neill"),
    )
    with closing(sqlite3.connect(path)) as connection:
        connection.executemany(
            """INSERT INTO concepts(
                   id, kind, canonical_source, default_target, working_target,
                   verified_target, description, status, scope, locked,
                   created_version, created_at)
               VALUES(?, ?, ?, '', '', '', '', 'provisional', 'book', 0,
                      1, 'now')""",
            forms,
        )
        connection.execute(
            """UPDATE blocks
               SET source_text=?, source_hash=?
               WHERE id='block-00'""",
            (source_text, hashlib.sha256(source_text.encode()).hexdigest()),
        )
        connection.commit()

    preview = preview_schema8(path)
    confirm_schema8(path, preview["confirm_token"])

    with closing(sqlite3.connect(path)) as connection:
        occurrences = connection.execute(
            """SELECT l.normalized_form, o.source_form,
                      o.start_offset, o.end_offset
               FROM form_occurrences AS o
               JOIN lexemes AS l ON l.id=o.lexeme_id
               WHERE o.block_id='block-00'
               ORDER BY o.start_offset, l.normalized_form"""
        ).fetchall()

    expected_sources = (
        ("severian", "SEVERIAN", source_text.index("SEVERIAN")),
        ("ia", "ia", source_text.index(" ia;") + 1),
        ("os", "OS", source_text.index(" OS.") + 1),
        ("o'neill", "O’Neill", source_text.index("O’Neill")),
    )
    assert occurrences == [
        (
            normalized,
            source,
            start,
            start + len(source),
        )
        for normalized, source, start in expected_sources
    ]
    assert all(
        source_text[start:end] == source
        for _, source, start, end in occurrences
    )


def test_migrated_stale_task_has_claimable_bounded_provenance(tmp_path):
    path = seed_schema7_migration_fixture(tmp_path)
    preview = preview_schema8(path)
    confirm_schema8(path, preview["confirm_token"])
    upgrade_schema8_fixture_to_schema9(path)
    database = V4Database(tmp_path)

    claim = database.claim_revalidation_task("migration-test")

    assert claim is not None
    assert len(claim.payload["cases"]) == 1
    with closing(database.connect()) as connection:
        task = connection.execute(
            "SELECT result_json FROM revalidation_tasks WHERE id=?",
            (claim.task_id,),
        ).fetchone()
        result = json.loads(task["result_json"])
        change_ids = result["change_ids"]
        reasons = result["reasons"]
        changes = connection.execute(
            """SELECT id, change_kind FROM knowledge_changes
               WHERE id IN ({})""".format(
                ",".join("?" for _ in change_ids)
            ),
            change_ids,
        ).fetchall()
    assert change_ids
    assert [reason["change_id"] for reason in reasons] == change_ids
    assert all(reason["via"] == ["schema7_migration"] for reason in reasons)
    assert [row["id"] for row in changes] == change_ids


def test_confirm_rejects_reused_backup_with_wrong_sha256(tmp_path):
    path = seed_schema7_migration_fixture(tmp_path)
    preview = preview_schema8(path)
    backup = Path(preview["backup_path"])
    backup.parent.mkdir(parents=True)
    backup.write_bytes(path.read_bytes())
    with closing(sqlite3.connect(backup)) as connection:
        connection.execute(
            "UPDATE concepts SET default_target='tampered' WHERE id='c-mal-old'"
        )
        connection.commit()
    source_before = path.read_bytes()

    with pytest.raises(SchemaMigrationError, match="backup.*SHA-256"):
        confirm_schema8(path, preview["confirm_token"])

    assert path.read_bytes() == source_before
    assert read_schema_version(path) == 7


def test_sidecar_cleanup_failure_happens_before_atomic_replace(
    tmp_path, monkeypatch
):
    path = seed_schema7_migration_fixture(tmp_path)
    preview = preview_schema8(path)
    sidecar = Path(f"{path}-wal")
    sidecar.write_bytes(b"")
    original_unlink = Path.unlink

    def fail_source_sidecar(self, *args, **kwargs):
        if self == sidecar:
            raise PermissionError("injected sidecar cleanup failure")
        return original_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_source_sidecar)
    with pytest.raises(PermissionError, match="sidecar cleanup"):
        confirm_schema8(path, preview["confirm_token"])

    assert read_schema_version(path) == 7


def test_schema7_confirm_keeps_original_and_backup_on_upgrade_failure(
    tmp_path, monkeypatch
):
    path = seed_schema7_migration_fixture(tmp_path)
    preview = preview_schema8(path)
    source_before = path.read_bytes()

    def fail_upgrade(*args, **kwargs):
        raise RuntimeError("injected migration failure")

    monkeypatch.setattr(schema_v8, "_rebuild_schema7_transaction", fail_upgrade)
    with pytest.raises(RuntimeError, match="injected migration failure"):
        confirm_schema8(path, preview["confirm_token"])

    assert path.read_bytes() == source_before
    backup_path = Path(preview["backup_path"])
    assert backup_path.exists()
    assert backup_path.read_bytes() != b""


def test_schema7_migration_path_must_be_absolute_and_project_scoped(tmp_path):
    path = seed_schema7_database(tmp_path)
    with pytest.raises(SchemaMigrationError, match="absolute"):
        preview_schema8(Path("artifacts/parallel_v4/book.db"))

    outside = tmp_path / "book.db"
    outside.write_bytes(path.read_bytes())
    with pytest.raises(SchemaMigrationError, match="artifacts/parallel_v4"):
        preview_schema8(outside.resolve())


@pytest.mark.parametrize(
    "corruption",
    (
        "sentinel",
        "table",
        "concepts_table",
        "column",
        "index",
        "lexeme_index_and_false",
        "concept_lexeme_index_and_false",
        "legacy_dependencies",
        "rendering_check",
        "translation_check",
        "translation_literal_case",
        "revalidation_check",
    ),
)
def test_incomplete_schema8_is_rejected_without_writes(tmp_path, corruption):
    path = seed_incomplete_schema8(tmp_path, corruption)
    before = filesystem_snapshot(tmp_path)

    with pytest.raises(
        (SchemaMigrationError, SchemaUpgradeRequired),
        match=r"(?:incomplete|corrupt|canonical|schema 8).*",
    ):
        preview_schema9(path.resolve())

    assert filesystem_snapshot(tmp_path) == before
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before[
        str(path.relative_to(tmp_path))
    ]


def test_create_schema8_two_phase_state_can_finish_initialization(tmp_path):
    path = tmp_path / "artifacts" / "parallel_v4" / "book.db"
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as connection:
        create_schema8(connection)

    upgrade_schema8_fixture_to_schema9(path)
    database = V4Database(tmp_path)

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0] == "9"
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blocks'"
        ).fetchone() is not None


def test_empty_directory_creates_schema8_with_required_tables(tmp_path):
    database = V4Database(tmp_path)
    with closing(database.connect()) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        version = int(
            connection.execute(
                "SELECT value FROM schema_meta WHERE key='schema_version'"
            ).fetchone()[0]
        )
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        columns = {
            table: {
                row[1]
                for row in connection.execute(f"PRAGMA table_info({table})")
            }
            for table in (
                "source_forms",
                "mentions",
                "rendering_rules",
                "candidate_resolutions",
                "translation_versions",
                "dependencies",
            )
        }
        column_info = {
            table: {
                row[1]: row
                for row in connection.execute(f"PRAGMA table_info({table})")
            }
            for table in ("source_forms", "mentions")
        }

    assert version == SCHEMA_VERSION == 9
    assert {
        "lexemes",
        "concept_lexemes",
        "concept_type_observations",
        "coreference_decisions",
        "concept_redirects",
        "form_occurrences",
        "knowledge_changes",
        "revalidation_tasks",
        "narrative_memories",
        "narrative_snapshots",
        "style_snapshots",
    } <= tables
    assert "lexeme_id" in columns["source_forms"]
    assert "lexeme_id" in columns["mentions"]
    assert column_info["source_forms"]["lexeme_id"][3] == 1
    assert "concept_id" not in column_info["source_forms"]
    assert column_info["mentions"]["lexeme_id"][3] == 1
    assert {"lexeme_id", "concept_id"} <= columns["rendering_rules"]
    assert "lexeme_id" in columns["candidate_resolutions"]
    assert {
        "validation_status",
        "validated_knowledge_version",
        "validation_fingerprint",
        "memory_version",
        "snapshot_id",
        "context_hash",
        "style_snapshot_id",
        "discourse_state_hash",
    } <= columns["translation_versions"]
    assert {
        "dependency_fingerprint",
        "matched_form",
        "occurrence_count",
        "rendered_target",
        "applied_rule_ids_json",
        "source_spans_json",
    } <= columns["dependencies"]


def test_lexeme_owned_rows_reject_missing_lexeme(tmp_path):
    database = V4Database(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, created_version, created_at)
               VALUES('concept-1', 'person', 'Drotte', ?, 'now')""",
            (version,),
        )
        connection.execute(
            """INSERT INTO source_editions(
                   raw_sha256, normalized_sha256, parser_version, source_path,
                   created_at)
               VALUES('raw', 'normalized', 'test', 'source.txt', 'now')"""
        )
        edition_id = connection.execute(
            "SELECT id FROM source_editions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO blocks(
                   id, legacy_id, source_edition_id, chapter_id, chapter_title,
                   chapter_index, block_index, global_index, source_text,
                   source_hash, updated_at)
               VALUES('block-1', 'block-1', ?, 'chapter-1', 'One', 0, 0, 0,
                      'Drotte', 'hash', 'now')""",
            (edition_id,),
        )
        evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, evidence_quote, payload_json,
                   confidence, extractor, created_at)
               VALUES('block-1', 'P000', 'entity', 'Drotte', '{}', 1.0,
                      'test', 'now')"""
        ).lastrowid

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """INSERT INTO source_forms(form, normalized_form)
                   VALUES('Drotte', 'drotte')"""
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """INSERT INTO mentions(
                       block_id, paragraph_id, source_form, normalized_form,
                       discourse_function, concept_id, evidence_id)
                   VALUES('block-1', 'P000', 'Drotte', 'drotte',
                          'referential', 'concept-1', ?)""",
                (evidence_id,),
            )


def test_legacy_concept_import_populates_lexeme_ownership(tmp_path):
    database = V4Database(tmp_path)
    concept_id = database.import_legacy_concept(
        "Drotte", "德罗特", "person", "a companion"
    )
    with closing(database.connect()) as connection:
        concept = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()
        lexeme = connection.execute(
            """SELECT language, normalized_form, canonical_form
               FROM lexemes WHERE id=?""",
            (concept["primary_lexeme_id"],),
        ).fetchone()
        association = connection.execute(
            """SELECT role FROM concept_lexemes
               WHERE concept_id=? AND lexeme_id=? AND retired_version IS NULL""",
            (concept_id, concept["primary_lexeme_id"]),
        ).fetchone()
        source_form = connection.execute(
            """SELECT lexeme_id, form, normalized_form FROM source_forms"""
        ).fetchone()

    assert tuple(lexeme) == ("en", "drotte", "Drotte")
    assert association["role"] == "primary"
    assert tuple(source_form) == (concept["primary_lexeme_id"], "Drotte", "drotte")


@pytest.mark.parametrize(
    "operations",
    (("import", "lock"), ("lock", "import")),
)
def test_ownership_helper_never_copies_concept_target_state(tmp_path, operations):
    database = V4Database(tmp_path)
    for operation in operations:
        if operation == "import":
            database.import_legacy_concept(
                "Drotte", "", "person", "a companion"
            )
        else:
            database.lock_concept_translation("Drotte", "德罗特", kind="person")

    with closing(database.connect()) as connection:
        lexeme = connection.execute(
            """SELECT default_target, working_target, verified_target,
                      status, locked
               FROM lexemes WHERE normalized_form='drotte'"""
        ).fetchone()

    assert tuple(lexeme) == ("", "", "", "provisional", 0)


def test_reconcile_reuses_canonical_mention_lexeme(tmp_path):
    database = V4Database(tmp_path)
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": "block-1",
                "chapter_id": "chapter-1",
                "chapter_title": "One",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": "Wolves gathered.",
                "source_hash": "hash",
            }
        ],
    )
    block = database.list_blocks()[0]
    response = ScanResponse.model_validate(
        {
            "mentions": [
                {
                    "paragraph_id": "P000",
                    "source_form": "Wolves",
                    "canonical_form": "Wolf",
                    "category": "species",
                    "evidence_quote": "Wolves",
                }
            ]
        }
    )
    database.start_run("scan-run", "scan", {})
    database.commit_scan_batch(
        "scan-run", [ScanOutcome(block=block, response=response)], "fake"
    )

    database.reconcile_exact_forms()

    with closing(database.connect()) as connection:
        mention = connection.execute(
            "SELECT lexeme_id, concept_id FROM mentions"
        ).fetchone()
        concept = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (mention["concept_id"],),
        ).fetchone()
        lexemes = connection.execute(
            "SELECT id, normalized_form FROM lexemes ORDER BY normalized_form"
        ).fetchall()

    assert [row["normalized_form"] for row in lexemes] == ["wolf"]
    assert concept["primary_lexeme_id"] == mention["lexeme_id"] == lexemes[0]["id"]


def test_rendering_rule_requires_exactly_one_subject(tmp_path):
    database = V4Database(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO lexemes(
                   id, language, normalized_form, canonical_form,
                   created_version, created_at)
               VALUES('lexeme-1', 'en', 'drotte', 'Drotte', ?, 'now')""",
            (version,),
        )
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, created_version, created_at)
               VALUES('concept-1', 'person', 'Drotte', ?, 'now')""",
            (version,),
        )
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            connection.execute(
                """INSERT INTO rendering_rules(
                       id, lexeme_id, concept_id, condition_json, target,
                       created_version, created_at)
                   VALUES('rule-neither', NULL, NULL, '{}', '德罗特', ?, 'now')""",
                (version,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            connection.execute(
                """INSERT INTO rendering_rules(
                       id, lexeme_id, concept_id, condition_json, target,
                       created_version, created_at)
                   VALUES('rule-both', 'lexeme-1', 'concept-1', '{}',
                          '德罗特', ?, 'now')""",
                (version,),
            )


def test_schema8_status_enums_are_checked(tmp_path):
    database = V4Database(tmp_path)
    with database.transaction() as connection:
        connection.execute(
            """INSERT INTO source_editions(
                   raw_sha256, normalized_sha256, parser_version, source_path,
                   created_at)
               VALUES('raw', 'normalized', 'test', 'source.txt', 'now')"""
        )
        edition_id = connection.execute(
            "SELECT id FROM source_editions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO blocks(
                   id, legacy_id, source_edition_id, chapter_id, chapter_title,
                   chapter_index, block_index, global_index, source_text,
                   source_hash, updated_at)
               VALUES('block-1', 'block-1', ?, 'chapter-1', 'One', 0, 0, 0,
                      'Drotte', 'hash', 'now')""",
            (edition_id,),
        )
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, status, validation_status, created_at)
                   VALUES('block-1', 'parallel_v4', 'completed', 'invalid', 'now')"""
            )
        translation_id = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, status, validation_status, created_at)
               VALUES('block-1', 'parallel_v4', 'completed', 'clean', 'now')"""
        ).lastrowid
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            connection.execute(
                """INSERT INTO revalidation_tasks(
                       id, translation_id, block_id, from_knowledge_version,
                       to_knowledge_version, change_set_hash, impact_level,
                       status, created_at)
                   VALUES('task-1', ?, 'block-1', ?, ?, 'changes', 1,
                          'invalid', 'now')""",
                (translation_id, version, version),
            )
