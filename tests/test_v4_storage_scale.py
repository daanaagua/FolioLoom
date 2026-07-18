import hashlib
import json
import re
import sqlite3
import time
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

import pytest

from src.core.v4.adjudicator import AdjudicationResult
from src.core.v4.audit_archive import (
    AuditArchive,
    StorageBudget,
    StorageBudgetExceeded,
)
from src.core.v4.candidate_clusters import CandidateCluster, CandidateContext
from src.core.v4.database import SCHEMA_VERSION, V4Database
from src.core.v4 import matcher as matcher_module
from src.core.v4.knowledge_epochs import KnowledgeEpochCoordinator
from src.core.v4.lexical_index import LexicalCandidate
from src.core.v4.models import (
    FormOccurrence,
    ScanOutcome,
    TranslationOutcome,
    V4BlockStatus,
)
from src.core.v4.schema_v8 import SchemaUpgradeRequired


def _candidate(candidate_id, block, start, text, *, risk_flags=()):
    return LexicalCandidate(
        id=candidate_id,
        block_id=block.id,
        paragraph_id="P000",
        start_offset=start,
        end_offset=start + len(text),
        original_text=text,
        normalized_text=text,
        left_context="left",
        right_context="right",
        extraction_reason="test",
        book_frequency=1,
        score=1,
        risk_flags=tuple(risk_flags),
    )


def _cluster(cluster_id, candidates):
    contexts = tuple(
        CandidateContext(
            candidate_id=item.id,
            block_id=item.block_id,
            paragraph_id=item.paragraph_id,
            original_text=item.original_text,
            left_context=item.left_context,
            right_context=item.right_context,
            risk_flags=item.risk_flags,
        )
        for item in candidates[:3]
    )
    return CandidateCluster(
        id=cluster_id,
        alternatives=tuple(candidates[:4]),
        contexts=contexts,
        risk_flags=tuple(sorted({flag for item in candidates for flag in item.risk_flags})),
        affected_blocks=len({item.block_id for item in candidates}),
    )


def _seed_database(tmp_path, names=("Drotte", "Roche")):
    root = tmp_path / "book"
    db = V4Database(root)
    edition = db.ensure_source_edition("raw", "normalized", "test", "source.txt")
    source = " ".join(names)
    db.upsert_blocks(
        edition,
        [
            {
                "id": "block-1",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": "hash-1",
                "token_count": len(names),
            }
        ],
    )
    block = db.list_blocks()[0]
    candidates = []
    offset = 0
    for index, name in enumerate(names):
        candidates.append(
            _candidate(
                f"candidate-{index:04d}",
                block,
                offset,
                name,
                risk_flags=("span_competition",) if index == 0 else (),
            )
        )
        offset += len(name) + 1
    db.start_run("scan-run", "scan", {})
    db.start_run("judge-run", "candidate_adjudication", {})
    db.commit_scan_batch(
        "scan-run",
        [
            ScanOutcome(
                block=block,
                response=None,
                lexical_candidates=[item.storage_payload() for item in candidates],
            )
        ],
        "fake",
    )
    return db, edition, block, candidates


def test_narrative_schema_scales_to_hundred_thousand_blocks(tmp_path):
    block_count = 100_000
    sampled_blocks = 1_000
    memory_count = 2_000
    db = V4Database(tmp_path / "large-book")
    edition = db.ensure_source_edition(
        "raw-scale",
        "normalized-scale",
        "scale-test",
        "source.txt",
    )
    created_at = "2000-01-01T00:00:00+00:00"
    with db.transaction() as connection:
        connection.executemany(
            """INSERT INTO blocks(
                   id, legacy_id, source_edition_id, chapter_id,
                   chapter_title, chapter_index, block_index, global_index,
                   block_type, source_text, source_hash, token_count, status,
                   updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'prose', 'x', 'h', 1,
                      'ready', ?)""",
            (
                (
                    f"scale-block-{index:06d}",
                    f"v01_ch{index // 1000:03d}_{index % 1000:03d}",
                    edition,
                    f"ch{index // 1000:03d}",
                    f"Chapter {index // 1000}",
                    index // 1000,
                    index % 1000,
                    index,
                    created_at,
                )
                for index in range(block_count)
            ),
        )
        knowledge_version = int(
            connection.execute(
                "SELECT MAX(id) FROM knowledge_versions"
            ).fetchone()[0]
        )
        memory_version = int(
            connection.execute(
                "SELECT MAX(id) FROM memory_versions"
            ).fetchone()[0]
        )
        connection.executemany(
            """INSERT INTO narrative_memories(
                   id, memory_type, statement, truth_status, visibility,
                   confidence, reveal_global_index, source_block_id,
                   source_hash, status, high_impact, semantic_fingerprint,
                   created_memory_version, created_at)
               VALUES(?, 'observation', ?, 'observed', 'reader_visible',
                      0.8, ?, ?, 'h', 'provisional', 0, ?, ?, ?)""",
            (
                (
                    f"scale-memory-{index:06d}",
                    f"Observed scale fact {index}.",
                    index,
                    f"scale-block-{index:06d}",
                    f"fingerprint-{index:06d}",
                    memory_version,
                    created_at,
                )
                for index in range(memory_count)
            ),
        )
        connection.executemany(
            """INSERT INTO narrative_memory_subjects(
                   memory_id, subject_type, subject_id, role)
               VALUES(?, 'concept', ?, 'subject')""",
            (
                (
                    f"scale-memory-{index:06d}",
                    f"concept-{index % 100:03d}",
                )
                for index in range(memory_count)
            ),
        )
        connection.executemany(
            """INSERT INTO narrative_snapshots(
                   id, block_id, global_index, knowledge_version,
                   memory_version, previous_snapshot_id,
                   discourse_state_json, visible_memory_ids_json,
                   snapshot_hash, created_at)
               VALUES(?, ?, ?, ?, ?, NULL, '{}', '[]', ?, ?)""",
            (
                (
                    f"scale-snapshot-{index:06d}",
                    f"scale-block-{index:06d}",
                    index,
                    knowledge_version,
                    memory_version,
                    f"snapshot-hash-{index:06d}",
                    created_at,
                )
                for index in range(sampled_blocks)
            ),
        )
        connection.executemany(
            """INSERT INTO premap_results(
                   id, block_id, cache_key, status, semantic_json,
                   memory_candidates_json, discourse_delta_json,
                   validation_json, model_id, prompt_hash,
                   prior_snapshot_hash, request_hash, response_hash,
                   snapshot_id, created_at)
               VALUES(?, ?, ?, 'accepted', '[]', '[]', '{}', '{}',
                      'scale-model', ?, '', ?, ?, ?, ?)""",
            (
                (
                    f"scale-premap-{protocol}-{index:06d}",
                    f"scale-block-{index:06d}",
                    f"scale-cache-{protocol}-{index:06d}",
                    f"prompt-{protocol}",
                    f"request-{protocol}-{index:06d}",
                    f"response-{protocol}-{index:06d}",
                    f"scale-snapshot-{index:06d}",
                    created_at,
                )
                for protocol in range(2)
                for index in range(sampled_blocks)
            ),
        )
        plan = connection.execute(
            """EXPLAIN QUERY PLAN
               SELECT memory_id
               FROM narrative_memory_subjects
               WHERE subject_type='concept' AND subject_id='concept-050'"""
        ).fetchall()
        snapshot_rows = int(
            connection.execute(
                "SELECT COUNT(*) FROM narrative_snapshots"
            ).fetchone()[0]
        )
        premap_rows = int(
            connection.execute(
                "SELECT COUNT(*) FROM premap_results"
            ).fetchone()[0]
        )

    assert any(
        "idx_narrative_subject_lookup" in str(row[-1])
        for row in plan
    )
    assert snapshot_rows <= block_count
    assert premap_rows <= block_count * 2
    status = db.status_summary()
    assert status["premap_cursor"] == sampled_blocks - 1
    assert status["premap_cursor"] + 1 == sampled_blocks


def test_translation_wave_failure_rolls_back_to_previous_checkpoint(tmp_path):
    db = V4Database(tmp_path / "atomic-book")
    edition = db.ensure_source_edition(
        "raw-atomic",
        "normalized-atomic",
        "atomic-test",
        "source.txt",
    )
    rows = []
    for index in range(2):
        source = f"Atomic sentence {index}."
        rows.append(
            {
                "id": f"atomic-block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 3,
                "status": "ready",
            }
        )
    db.upsert_blocks(edition, rows)
    blocks = db.list_blocks()
    knowledge_version = db.current_knowledge_version()
    memory_version = db.status_summary()["memory_version"]
    db.start_run(
        "atomic-wave",
        "translate",
        {},
        knowledge_version=knowledge_version,
    )

    with pytest.raises(ValueError, match="source drift"):
        db.commit_translation_batch(
            "atomic-wave",
            [
                TranslationOutcome(
                    block=blocks[0],
                    knowledge_version=knowledge_version,
                    memory_version=memory_version,
                    status=V4BlockStatus.COMPLETED.value,
                    final_translation="第一块译文",
                ),
                TranslationOutcome(
                    block=replace(
                        blocks[1],
                        source_text="Injected source drift.",
                    ),
                    knowledge_version=knowledge_version,
                    memory_version=memory_version,
                    status=V4BlockStatus.COMPLETED.value,
                    final_translation="第二块译文",
                ),
            ],
        )

    with closing(db.connect()) as connection:
        assert connection.execute(
            """SELECT COUNT(*) FROM translation_versions
               WHERE run_id='atomic-wave'"""
        ).fetchone()[0] == 0
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE run_id='atomic-wave'"""
        ).fetchone()[0] == 0
    assert db.status_summary()["memory_version"] == memory_version


def test_concept_redirect_merge_scales_without_read_n_plus_one_or_unbounded_growth(
    tmp_path,
):
    db, _, _, _ = _seed_database(tmp_path, names=("Briah",))
    lexeme_id = db.ensure_lexeme("Briah")
    canonical_id = "concept-scale-canonical"
    old_id = "concept-scale-old"
    count = 1_000
    with db.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.executemany(
            """INSERT INTO concepts(
                   id, kind, canonical_source, locked, primary_lexeme_id,
                   created_version, created_at)
               VALUES(?, 'person', ?, ?, ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            [
                (canonical_id, "canonical", 1, lexeme_id, version),
                (old_id, "old", 0, lexeme_id, version),
            ],
        )
        connection.executemany(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, ?, 'primary', 1.0, 'provisional', ?,
                      '2000-01-01T00:00:00+00:00')""",
            [(canonical_id, lexeme_id, version), (old_id, lexeme_id, version)],
        )
        evidence_rows = [
            (
                "block-1",
                f"P{index:04d}",
                "Briah",
                f"Briah evidence {index}",
            )
            for index in range(count * 2)
        ]
        connection.executemany(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, created_at)
               VALUES(?, ?, 'scale', ?, ?, '{}', 1.0, 'scale-test',
                      '2000-01-01T00:00:00+00:00')""",
            evidence_rows,
        )
        evidence_ids = [
            int(row[0])
            for row in connection.execute(
                """SELECT id FROM evidence WHERE kind='scale' ORDER BY id"""
            ).fetchall()
        ]
        connection.executemany(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id)
               VALUES('block-1', ?, 'Briah', 'briah', 'referential', ?, ?, ?)""",
            [
                (
                    f"P{index:04d}",
                    lexeme_id,
                    canonical_id if index % 2 == 0 else old_id,
                    evidence_ids[index],
                )
                for index in range(count * 2)
            ],
        )
        translation_ids = []
        for _ in range(count):
            translation_ids.append(
                int(
                    connection.execute(
                        """INSERT INTO translation_versions(
                               block_id, pipeline, knowledge_version, status,
                               active, created_at)
                           VALUES('block-1', 'scale', ?, 'completed', 1,
                                  '2000-01-01T00:00:00+00:00')""",
                        (version,),
                    ).lastrowid
                )
            )
        connection.executemany(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority,
                   created_version, created_at)
               VALUES(?, ?, ?, '译名', 0, ?,
                      '2000-01-01T00:00:00+00:00')""",
            [
                (
                    f"rule-scale-{index:04d}",
                    old_id,
                    json.dumps({"occurrence": index}),
                    version,
                )
                for index in range(count)
            ],
        )
        dependency_rows = []
        for index, translation_id in enumerate(translation_ids):
            dependency_rows.extend(
                [
                    (
                        translation_id,
                        canonical_id,
                        version,
                        1,
                        "[]",
                        json.dumps([[index, index + 1]]),
                    ),
                    (
                        translation_id,
                        old_id,
                        version,
                        1,
                        json.dumps([f"rule-scale-{index:04d}"]),
                        json.dumps([[index + 1, index + 2]]),
                    ),
                ]
            )
        connection.executemany(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version, occurrence_count, applied_rule_ids_json,
                   source_spans_json)
               VALUES(?, 'concept', ?, ?, ?, ?, ?)""",
            dependency_rows,
        )
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-scale-merge', ?, 'concept', ?, 'concept', ?,
                      'same', 'human', 1.0, 1, '[]', '[]', '[]',
                      'scale-merge-payload', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, canonical_id, old_id, version),
        )
    before_bytes = db.path.stat().st_size
    statements = []
    with db.transaction() as connection:
        connection.set_trace_callback(statements.append)
        result = db.merge_concepts(
            [old_id, canonical_id],
            reason="scale merge",
            decision_id="coref-scale-merge",
            connection=connection,
        )
        connection.set_trace_callback(None)
    after_bytes = db.path.stat().st_size

    read_statements = [
        statement
        for statement in statements
        if statement.lstrip().upper().startswith(("SELECT", "WITH"))
    ]
    assert result["canonical_id"] == canonical_id
    assert len(read_statements) <= 40
    assert after_bytes - before_bytes <= 2 * 1024**2
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(DISTINCT concept_id) FROM mentions WHERE lexeme_id=?",
            (lexeme_id,),
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM dependencies
               WHERE dependency_type='concept' AND dependency_id=?""",
            (canonical_id,),
        ).fetchone()[0] == count
        assert connection.execute(
            """SELECT COUNT(*) FROM rendering_rules
               WHERE concept_id=? AND retired_version IS NULL""",
            (canonical_id,),
        ).fetchone()[0] == count
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_schema6_requires_explicit_upgrade_without_mutating_data(tmp_path):
    root = tmp_path / "legacy"
    path = root / "artifacts" / "parallel_v4" / "book.db"
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO schema_meta VALUES('schema_version', '6');
            CREATE TABLE knowledge_versions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO knowledge_versions(parent_id, reason, created_at)
            VALUES(NULL, 'legacy', 'now');
            CREATE TABLE concepts(
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                canonical_source TEXT NOT NULL,
                default_target TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'provisional',
                scope TEXT NOT NULL DEFAULT 'book',
                locked INTEGER NOT NULL DEFAULT 0,
                created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                retired_version INTEGER REFERENCES knowledge_versions(id),
                created_at TEXT NOT NULL
            );
            INSERT INTO concepts VALUES(
                'locked-old', 'person', 'Drotte', '德罗特', '', 'verified',
                'book', 1, 1, NULL, 'now'
            );
            CREATE TABLE lexical_candidates(
                id TEXT PRIMARY KEY,
                block_id TEXT NOT NULL,
                paragraph_id TEXT NOT NULL,
                start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL,
                original_text TEXT NOT NULL,
                normalized_text TEXT NOT NULL,
                left_context TEXT NOT NULL DEFAULT '',
                right_context TEXT NOT NULL DEFAULT '',
                extraction_reason TEXT NOT NULL,
                book_frequency INTEGER NOT NULL DEFAULT 1,
                model_status TEXT NOT NULL DEFAULT 'pending',
                selected INTEGER NOT NULL DEFAULT 0,
                run_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(block_id, start_offset, end_offset, normalized_text)
            );
            """
        )

    with pytest.raises(SchemaUpgradeRequired, match="migrate-v4 --preview"):
        V4Database(root)
    with closing(sqlite3.connect(path)) as connection:
        lexical_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(lexical_candidates)")
        }
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]
        concept = connection.execute(
            "SELECT default_target FROM concepts WHERE id='locked-old'"
        ).fetchone()

    assert SCHEMA_VERSION == 9
    assert version == "6"
    assert concept[0] == "德罗特"
    assert "risk_flags_json" not in lexical_columns
    assert "resolution_status" not in lexical_columns


def test_unreleased_legacy_schema7_adjudication_table_is_not_migrated_in_place(tmp_path):
    root = tmp_path / "legacy-schema7"
    path = root / "artifacts" / "parallel_v4" / "book.db"
    path.parent.mkdir(parents=True)
    payload = {
        "cluster_id": "cluster-old",
        "verdict": "defer",
        "selected_candidate_ids": [],
        "entity_kind": "concept",
        "confidence": 0.4,
        "reason": "model_protocol_failure",
        "rounds": 1,
    }
    payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            f"""
            CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO schema_meta VALUES('schema_version', '7');
            CREATE TABLE knowledge_versions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER REFERENCES knowledge_versions(id),
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO knowledge_versions(parent_id, reason, created_at)
            VALUES(NULL, 'legacy', 'now');
            CREATE TABLE runs(
                id TEXT PRIMARY KEY, stage TEXT NOT NULL, status TEXT NOT NULL,
                knowledge_version INTEGER, config_json TEXT NOT NULL,
                started_at TEXT NOT NULL, finished_at TEXT, error TEXT
            );
            INSERT INTO runs VALUES(
                'run-old', 'candidate_adjudication', 'completed', 1, '{{}}',
                'now', 'now', NULL
            );
            CREATE TABLE candidate_clusters(
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                risk_flags_json TEXT NOT NULL DEFAULT '[]',
                affected_blocks_json TEXT NOT NULL DEFAULT '[]',
                affected_block_count INTEGER NOT NULL DEFAULT 0,
                ordinal INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(run_id, id)
            );
            INSERT INTO candidate_clusters VALUES(
                'cluster-old', 'run-old', '[]', '[]', 0, 0, 'now', 'now'
            );
            CREATE TABLE candidate_adjudications(
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                cluster_id TEXT NOT NULL,
                verdict TEXT NOT NULL,
                selected_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                entity_kind TEXT NOT NULL DEFAULT '',
                confidence REAL NOT NULL DEFAULT 0.0,
                reason TEXT NOT NULL DEFAULT '',
                rounds INTEGER NOT NULL DEFAULT 1,
                payload_json TEXT NOT NULL DEFAULT '{{}}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(run_id, cluster_id),
                FOREIGN KEY(cluster_id) REFERENCES candidate_clusters(id) ON DELETE CASCADE
            );
            """
        )
        connection.execute(
            """INSERT INTO candidate_adjudications(
                   id, run_id, cluster_id, verdict, selected_candidate_ids_json,
                   entity_kind, confidence, reason, rounds, payload_json,
                   created_at, updated_at
               ) VALUES('adjud-old', 'run-old', 'cluster-old', 'defer', '[]',
                        'concept', 0.4, 'model_protocol_failure', 1, ?, 'now', 'now')""",
            (payload_json,),
        )
        connection.commit()

    with pytest.raises(SchemaUpgradeRequired, match="migrate-v4 --preview"):
        V4Database(root)
    with closing(sqlite3.connect(path)) as connection:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(candidate_adjudications)")
        }
        row = connection.execute(
            """SELECT verdict, payload_json
               FROM candidate_adjudications WHERE id='adjud-old'"""
        ).fetchone()
        table_sql = connection.execute(
            """SELECT sql FROM sqlite_master
               WHERE type='table' AND name='candidate_adjudications'"""
        ).fetchone()[0]
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]
    assert {"payload_hash", "knowledge_version", "active", "superseded_at"}.isdisjoint(
        columns
    )
    assert tuple(row) == ("defer", payload_json)
    assert "UNIQUE(run_id, cluster_id)" in table_sql.replace("\n", " ")
    assert version == "7"


def test_multi_form_matcher_preserves_boundaries_case_curly_punctuation_and_offsets():
    matcher = matcher_module.MultiFormMatcher.compile(
        {
            "Archon": ("lex-archon",),
            "O’Neill": ("lex-curly",),
        }
    )
    text = "ARCHON met O’Neill; Archoness and O'Neill."

    matches = list(matcher.finditer(text))

    curly_start = text.index("O’Neill")
    assert matches == [
        ("lex-archon", "ARCHON", 0, 6),
        ("lex-curly", "O’Neill", curly_start, curly_start + len("O’Neill")),
    ]
    assert all(text[start:end] == source for _, source, start, end in matches)


def test_legacy_schema7_migration_recovers_adjudication_version_for_exact_retry(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-old", candidates)])
    result = AdjudicationResult(
        cluster_id="cluster-old",
        verdict="defer",
        selected_candidate_ids=(),
        entity_kind="concept",
        confidence=0.4,
        reason="model_protocol_failure",
        rounds=1,
    )
    first = db.commit_adjudications("judge-run", [result])
    assert first["knowledge_version"] == 2

    with closing(sqlite3.connect(db.path)) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.executescript(
            """
            CREATE TABLE candidate_adjudications_b7(
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                cluster_id TEXT NOT NULL,
                verdict TEXT NOT NULL,
                selected_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                entity_kind TEXT NOT NULL DEFAULT '',
                confidence REAL NOT NULL DEFAULT 0.0,
                reason TEXT NOT NULL DEFAULT '',
                rounds INTEGER NOT NULL DEFAULT 1,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(run_id, cluster_id),
                FOREIGN KEY(cluster_id)
                    REFERENCES candidate_clusters(id) ON DELETE CASCADE
            );
            INSERT INTO candidate_adjudications_b7(
                id, run_id, cluster_id, verdict, selected_candidate_ids_json,
                entity_kind, confidence, reason, rounds, payload_json,
                created_at, updated_at)
            SELECT id, run_id, cluster_id, verdict, selected_candidate_ids_json,
                   entity_kind, confidence, reason, rounds, payload_json,
                   created_at, updated_at
            FROM candidate_adjudications WHERE active=1;
            DROP TABLE candidate_adjudications;
            ALTER TABLE candidate_adjudications_b7
                RENAME TO candidate_adjudications;
            """
        )
        connection.commit()

    migrated = V4Database(db.project_root)
    with closing(migrated.connect()) as connection:
        adjudication_version = connection.execute(
            "SELECT knowledge_version FROM candidate_adjudications WHERE active=1"
        ).fetchone()[0]
        before_versions = connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0]
    retry = migrated.commit_adjudications("judge-run", [result])
    with closing(migrated.connect()) as connection:
        after_versions = connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0]

    assert adjudication_version == 2
    assert retry["knowledge_version"] == 2
    assert retry["changed"] == 0
    assert after_versions == before_versions == 2


def test_cluster_persistence_and_adjudication_promotion_commits_lexeme_evidence_atomically(
    tmp_path,
):
    db, _, _, candidates = _seed_database(tmp_path)
    item = _cluster("cluster-1", candidates)
    summary = db.persist_candidate_clusters("scan-run", [item])
    assert summary["clusters"] == 1
    assert summary["members"] == 2

    result = AdjudicationResult(
        cluster_id="cluster-1",
        verdict="promote",
        selected_candidate_ids=(candidates[0].id,),
        entity_kind="person",
        confidence=0.97,
        reason="consensus",
        rounds=2,
    )
    committed = db.commit_adjudications("judge-run", [result])

    with closing(db.connect()) as connection:
        selected = connection.execute(
            "SELECT selected, model_status, resolution_status, risk_flags_json "
            "FROM lexical_candidates WHERE id=?",
            (candidates[0].id,),
        ).fetchone()
        resolution = connection.execute(
            "SELECT cluster_id, candidate_id, lexeme_id, concept_id, evidence_id, decision "
            "FROM candidate_resolutions"
        ).fetchone()
        mention = connection.execute(
            "SELECT lexeme_id, concept_id, evidence_id FROM mentions"
        ).fetchone()
        occurrence = connection.execute(
            """SELECT lexeme_id, block_id, start_offset, end_offset,
                      source_form, source_hash FROM form_occurrences"""
        ).fetchone()
        observation = connection.execute(
            """SELECT lexeme_id, mention_id, concept_id, evidence_id, kind,
                      confidence, source, adjudication_id
               FROM concept_type_observations"""
        ).fetchone()
        adjudication_id = connection.execute(
            "SELECT id FROM candidate_adjudications WHERE active=1"
        ).fetchone()[0]

    assert selected["selected"] == 1
    assert selected["model_status"] == "accepted"
    assert selected["resolution_status"] == "promoted"
    assert json.loads(selected["risk_flags_json"]) == ["span_competition"]
    assert committed["concept_ids"] == []
    assert resolution["cluster_id"] == "cluster-1"
    assert resolution["candidate_id"] == candidates[0].id
    assert resolution["lexeme_id"] is not None
    assert resolution["concept_id"] is None
    assert resolution["evidence_id"] is not None
    assert resolution["decision"] == "promote"
    assert tuple(mention) == (
        resolution["lexeme_id"],
        None,
        resolution["evidence_id"],
    )
    assert tuple(occurrence) == (
        resolution["lexeme_id"],
        candidates[0].block_id,
        candidates[0].start_offset,
        candidates[0].end_offset,
        candidates[0].original_text,
        "hash-1",
    )
    assert observation["lexeme_id"] == resolution["lexeme_id"]
    assert observation["mention_id"] is not None
    assert observation["concept_id"] is None
    assert observation["evidence_id"] == resolution["evidence_id"]
    assert observation["kind"] == "person"
    assert observation["confidence"] == pytest.approx(0.97)
    assert observation["source"] == "candidate_adjudication"
    assert observation["adjudication_id"] == adjudication_id

    # Re-indexing must refresh evidence flags without undoing a final decision.
    block = db.list_blocks()[0]
    updated = candidates[0].storage_payload(model_status="pending")
    updated["risk_flags_json"] = '["updated-risk"]'
    db.commit_scan_batch(
        "scan-run",
        [ScanOutcome(block=block, response=None, lexical_candidates=[updated])],
        "fake",
    )
    with closing(db.connect()) as connection:
        preserved = connection.execute(
            "SELECT selected, model_status, resolution_status, risk_flags_json "
            "FROM lexical_candidates WHERE id=?",
            (candidates[0].id,),
        ).fetchone()
    assert tuple(preserved)[:3] == (1, "accepted", "promoted")
    assert json.loads(preserved["risk_flags_json"]) == ["updated-risk"]

    bad_cluster = _cluster("cluster-bad", [candidates[0]])
    missing = _candidate("missing-candidate", db.list_blocks()[0], 0, "Missing")
    bad_cluster = CandidateCluster(
        id=bad_cluster.id,
        alternatives=(candidates[0], missing),
        contexts=bad_cluster.contexts,
        risk_flags=(),
        affected_blocks=1,
    )
    with pytest.raises((ValueError, sqlite3.IntegrityError)):
        db.persist_candidate_clusters("scan-run", [bad_cluster])
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_clusters WHERE id='cluster-bad'"
        ).fetchone()[0] == 0


def test_context_only_member_cannot_be_selected_or_resolved(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    alternative, context_only = candidates
    item = CandidateCluster(
        id="cluster-context",
        alternatives=(alternative,),
        contexts=(
            CandidateContext(
                candidate_id=context_only.id,
                block_id=context_only.block_id,
                paragraph_id=context_only.paragraph_id,
                original_text=context_only.original_text,
                left_context=context_only.left_context,
                right_context=context_only.right_context,
                risk_flags=context_only.risk_flags,
            ),
        ),
        risk_flags=(),
        affected_blocks=1,
    )
    db.persist_candidate_clusters("scan-run", [item])

    with pytest.raises(ValueError, match="alternative"):
        db.commit_adjudications(
            "judge-run",
            [
                AdjudicationResult(
                    "cluster-context",
                    "promote",
                    (context_only.id,),
                    "person",
                    0.9,
                )
            ],
        )
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM candidate_resolutions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_type_observations"
        ).fetchone()[0] == 0

    db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-context", "reject", (), "concept", 0.8)],
    )
    with closing(db.connect()) as connection:
        rows = connection.execute(
            """SELECT lc.id, lc.resolution_status, cm.role,
                      EXISTS(SELECT 1 FROM candidate_resolutions cr
                             WHERE cr.candidate_id=lc.id) has_resolution
               FROM lexical_candidates lc
               JOIN candidate_cluster_members cm ON cm.candidate_id=lc.id
               ORDER BY lc.id"""
        ).fetchall()
    by_id = {row["id"]: row for row in rows}
    assert tuple(by_id[alternative.id])[1:] == ("rejected", "alternative", 1)
    assert tuple(by_id[context_only.id])[1:] == ("pending", "context", 0)


def test_promotions_with_different_entity_kinds_share_lexeme_and_keep_observations(
    tmp_path,
):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])

    first = db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-1", "promote", (candidates[0].id,), "person", 0.9)],
    )
    second = db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-1", "promote", (candidates[0].id,), "place", 0.8)],
    )
    identical = db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-1", "promote", (candidates[0].id,), "place", 0.8)],
    )
    with closing(db.connect()) as connection:
        chains = connection.execute(
            """SELECT ca.knowledge_version, ca.active, cr.lexeme_id,
                      cr.concept_id, cr.evidence_id AS resolution_evidence_id,
                      cto.mention_id, cto.evidence_id AS observation_evidence_id,
                      m.evidence_id AS mention_evidence_id,
                      cto.kind, cto.confidence
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               JOIN concept_type_observations cto
                 ON cto.adjudication_id=ca.id AND cto.lexeme_id=cr.lexeme_id
                    AND cto.evidence_id=cr.evidence_id
               JOIN mentions m ON m.id=cto.mention_id
               WHERE cr.candidate_id=? AND cr.decision='promote'
               ORDER BY ca.knowledge_version""",
            (candidates[0].id,),
        ).fetchall()
        counts = {
            "concepts": connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0],
            "lexemes": connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0],
            "mentions": connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0],
            "occurrences": connection.execute(
                "SELECT COUNT(*) FROM form_occurrences"
            ).fetchone()[0],
        }

    assert first["concept_ids"] == second["concept_ids"] == []
    assert identical["knowledge_version"] == second["knowledge_version"]
    assert identical["changed"] == 0
    assert len(chains) == 2
    assert [row["active"] for row in chains] == [0, 1]
    assert len({row["lexeme_id"] for row in chains}) == 1
    assert all(row["concept_id"] is None for row in chains)
    assert [(row["kind"], row["confidence"]) for row in chains] == [
        ("person", 0.9),
        ("place", 0.8),
    ]
    assert len({row["mention_id"] for row in chains}) == 2
    assert len({row["resolution_evidence_id"] for row in chains}) == 2
    assert all(
        row["resolution_evidence_id"]
        == row["observation_evidence_id"]
        == row["mention_evidence_id"]
        for row in chains
    )
    assert counts == {"concepts": 0, "lexemes": 1, "mentions": 2, "occurrences": 1}


def test_promotion_reuses_locked_concept_lexeme_without_binding_or_modifying_concept(
    tmp_path,
):
    locked_db, _, _, locked_candidates = _seed_database(tmp_path)
    locked = locked_db.lock_concept_translation("Drotte", "德罗特", kind="title")
    locked_db.persist_candidate_clusters(
        "scan-run", [_cluster("cluster-locked", locked_candidates)]
    )
    with closing(locked_db.connect()) as connection:
        before = tuple(
            connection.execute(
                """SELECT kind, canonical_source, default_target, working_target,
                          verified_target, description, status, scope, locked,
                          created_version, retired_version, created_at,
                          primary_lexeme_id
                   FROM concepts WHERE id=?""",
                (locked["concept_id"],),
            ).fetchone()
        )

    committed = locked_db.commit_adjudications(
        "judge-run",
        [
            AdjudicationResult(
                "cluster-locked",
                "promote",
                (locked_candidates[0].id,),
                "person",
                0.9,
            )
        ],
    )
    with closing(locked_db.connect()) as connection:
        after = tuple(
            connection.execute(
                """SELECT kind, canonical_source, default_target, working_target,
                          verified_target, description, status, scope, locked,
                          created_version, retired_version, created_at,
                          primary_lexeme_id
                   FROM concepts WHERE id=?""",
                (locked["concept_id"],),
            ).fetchone()
        )
        latest_resolution = connection.execute(
            "SELECT lexeme_id, concept_id FROM candidate_resolutions WHERE candidate_id=?",
            (locked_candidates[0].id,),
        ).fetchone()
    assert committed["concept_ids"] == []
    assert after == before
    assert latest_resolution["lexeme_id"] == before[-1]
    assert latest_resolution["concept_id"] is None


def test_invalid_adjudication_rolls_back_every_result_in_batch(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    valid = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    invalid = AdjudicationResult(
        "missing-cluster", "promote", (candidates[1].id,), "person", 0.9
    )

    with pytest.raises(ValueError, match="cluster"):
        db.commit_adjudications("judge-run", [valid, invalid])

    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM candidate_resolutions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM lexical_candidates WHERE resolution_status!='pending'"
        ).fetchone()[0] == 0


def test_database_failure_halfway_through_promotion_rolls_back_all_writes(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    with db.transaction() as connection:
        connection.execute(
            f"""CREATE TRIGGER fail_second_resolution
                BEFORE INSERT ON candidate_resolutions
                WHEN NEW.candidate_id='{candidates[1].id}'
                BEGIN SELECT RAISE(ABORT, 'forced storage failure'); END"""
        )

    result = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    with pytest.raises(sqlite3.IntegrityError, match="forced storage failure"):
        db.commit_adjudications("judge-run", [result])

    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM candidate_resolutions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM evidence").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM source_forms").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_type_observations"
        ).fetchone()[0] == 0
        statuses = connection.execute(
            "SELECT resolution_status, selected FROM lexical_candidates ORDER BY id"
        ).fetchall()
    assert [tuple(row) for row in statuses] == [("pending", 0), ("pending", 0)]


@pytest.mark.parametrize(
    ("verdict", "reason", "expected_status"),
    [
        ("defer", "model_protocol_failure", "deferred"),
        ("defer", "independent_verdict_conflict", "deferred"),
        ("reject", "not_an_entity", "rejected"),
    ],
)
def test_nonpromotion_adjudications_remain_traceable(
    tmp_path, verdict, reason, expected_status
):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])

    db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-1", verdict, (), "concept", 0.4, reason)],
    )

    with closing(db.connect()) as connection:
        adjudication = connection.execute(
            "SELECT verdict, reason FROM candidate_adjudications"
        ).fetchone()
        decisions = connection.execute(
            "SELECT decision FROM candidate_resolutions ORDER BY ordinal"
        ).fetchall()
        statuses = connection.execute(
            "SELECT resolution_status FROM lexical_candidates ORDER BY id"
        ).fetchall()
    assert tuple(adjudication) == (verdict, reason)
    assert [row[0] for row in decisions] == [expected_status, expected_status]
    assert [row[0] for row in statuses] == [expected_status, expected_status]


def test_changed_adjudication_keeps_history_and_exact_retry_is_idempotent(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    promote = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    reject = AdjudicationResult(
        "cluster-1", "reject", (), "person", 0.8, "not_an_entity"
    )

    first = db.commit_adjudications("judge-run", [promote])
    with closing(db.connect()) as connection:
        before = {
            "knowledge_versions": connection.execute(
                "SELECT COUNT(*) FROM knowledge_versions"
            ).fetchone()[0],
            "adjudications": connection.execute(
                "SELECT COUNT(*) FROM candidate_adjudications"
            ).fetchone()[0],
            "resolutions": connection.execute(
                "SELECT COUNT(*) FROM candidate_resolutions"
            ).fetchone()[0],
            "evidence": connection.execute("SELECT COUNT(*) FROM evidence").fetchone()[0],
            "mentions": connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0],
            "occurrences": connection.execute(
                "SELECT COUNT(*) FROM form_occurrences"
            ).fetchone()[0],
            "observations": connection.execute(
                "SELECT COUNT(*) FROM concept_type_observations"
            ).fetchone()[0],
            "concepts": connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0],
            "adjudication_row": tuple(
                connection.execute(
                    """SELECT id, verdict, payload_json, created_at, updated_at
                       FROM candidate_adjudications WHERE active=1"""
                ).fetchone()
            ),
        }

    identical = db.commit_adjudications("judge-run", [promote])
    with closing(db.connect()) as connection:
        assert identical["knowledge_version"] == first["knowledge_version"]
        assert connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone()[0] == before["knowledge_versions"]
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == before["adjudications"]
        assert connection.execute("SELECT COUNT(*) FROM candidate_resolutions").fetchone()[0] == before["resolutions"]
        assert connection.execute("SELECT COUNT(*) FROM evidence").fetchone()[0] == before["evidence"]
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] == before["mentions"]
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == before["occurrences"]
        assert connection.execute("SELECT COUNT(*) FROM concept_type_observations").fetchone()[0] == before["observations"]
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == before["concepts"]
        assert tuple(
            connection.execute(
                """SELECT id, verdict, payload_json, created_at, updated_at
                   FROM candidate_adjudications WHERE active=1"""
            ).fetchone()
        ) == before["adjudication_row"]

    changed = db.commit_adjudications("judge-run", [reject])
    with closing(db.connect()) as connection:
        adjudications = connection.execute(
            """SELECT verdict, active, knowledge_version
               FROM candidate_adjudications ORDER BY created_at, id"""
        ).fetchall()
        active_resolutions = connection.execute(
            """SELECT cr.decision FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               WHERE ca.active=1 ORDER BY cr.ordinal"""
        ).fetchall()
        old_evidence = connection.execute(
            """SELECT COUNT(*) FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               JOIN evidence e ON e.id=cr.evidence_id
               WHERE ca.active=0 AND ca.verdict='promote'"""
        ).fetchone()[0]
        candidate_rows = connection.execute(
            "SELECT resolution_status, selected FROM lexical_candidates ORDER BY id"
        ).fetchall()

    assert changed["knowledge_version"] != first["knowledge_version"]
    assert [(row["verdict"], row["active"]) for row in adjudications] == [
        ("promote", 0),
        ("reject", 1),
    ]
    assert [row[0] for row in active_resolutions] == ["rejected", "rejected"]
    assert old_evidence == 1
    assert first["concept_ids"] == changed["concept_ids"] == []
    assert [tuple(row) for row in candidate_rows] == [("rejected", 0), ("rejected", 0)]

    before_retry = db.current_knowledge_version()
    retry = db.commit_adjudications("judge-run", [reject])
    with closing(db.connect()) as connection:
        assert retry["knowledge_version"] == changed["knowledge_version"]
        assert db.current_knowledge_version() == before_retry
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == 2


def test_promote_reject_promote_keeps_mentions_per_evidence_and_reuses_occurrence(
    tmp_path,
):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    promote = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    reject = AdjudicationResult(
        "cluster-1", "reject", (), "person", 0.8, "not_an_entity"
    )

    db.commit_adjudications("judge-run", [promote])
    db.commit_adjudications("judge-run", [reject])
    third = db.commit_adjudications("judge-run", [promote])

    with closing(db.connect()) as connection:
        active_resolution = connection.execute(
            """SELECT cr.lexeme_id, cr.concept_id
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[0].id,),
        ).fetchone()
        counts = {
            "concepts": connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0],
            "mentions": connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0],
            "occurrences": connection.execute(
                "SELECT COUNT(*) FROM form_occurrences"
            ).fetchone()[0],
            "observations": connection.execute(
                "SELECT COUNT(*) FROM concept_type_observations"
            ).fetchone()[0],
        }
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []

    assert third["concept_ids"] == []
    assert active_resolution["lexeme_id"] is not None
    assert active_resolution["concept_id"] is None
    assert counts == {"concepts": 0, "mentions": 2, "occurrences": 1, "observations": 2}


def test_split_reuses_each_existing_lexeme_without_creating_composite_identity(tmp_path):
    db, _, block, candidates = _seed_database(
        tmp_path, names=("Malrubius", "and", "Triskele")
    )
    composite = _candidate(
        "candidate-composite",
        block,
        0,
        "Malrubius and Triskele",
        risk_flags=("coordination",),
    )
    db.commit_scan_batch(
        "scan-run",
        [
            ScanOutcome(
                block=block,
                response=None,
                lexical_candidates=[composite.storage_payload()],
            )
        ],
        "fake",
    )
    malrubius_lexeme = db.ensure_lexeme("Malrubius")
    triskele_lexeme = db.ensure_lexeme("Triskele")
    selected = (candidates[0], candidates[2])
    db.persist_candidate_clusters(
        "scan-run",
        [_cluster("cluster-split", [composite, *selected])],
    )

    committed = db.commit_adjudications(
        "judge-run",
        [
            AdjudicationResult(
                "cluster-split",
                "split",
                tuple(candidate.id for candidate in selected),
                "person",
                0.95,
            )
        ],
    )
    with closing(db.connect()) as connection:
        resolutions = {
            row["candidate_id"]: row
            for row in connection.execute(
                """SELECT candidate_id, lexeme_id, concept_id, decision
                   FROM candidate_resolutions ORDER BY ordinal"""
            )
        }
        normalized_lexemes = {
            row[0]
            for row in connection.execute(
                "SELECT normalized_form FROM lexemes ORDER BY normalized_form"
            )
        }
        mention_lexemes = {
            row[0] for row in connection.execute("SELECT lexeme_id FROM mentions")
        }
        occurrence_lexemes = {
            row[0] for row in connection.execute("SELECT lexeme_id FROM form_occurrences")
        }

    assert committed["concept_ids"] == []
    assert resolutions[candidates[0].id]["lexeme_id"] == malrubius_lexeme
    assert resolutions[candidates[2].id]["lexeme_id"] == triskele_lexeme
    assert resolutions[candidates[0].id]["decision"] == "split"
    assert resolutions[candidates[2].id]["decision"] == "split"
    assert resolutions[composite.id]["lexeme_id"] is None
    assert resolutions[composite.id]["decision"] == "rejected"
    assert all(row["concept_id"] is None for row in resolutions.values())
    assert normalized_lexemes == {"malrubius", "triskele"}
    assert mention_lexemes == occurrence_lexemes == {
        malrubius_lexeme,
        triskele_lexeme,
    }


def test_legacy_concept_owned_active_resolution_is_superseded_by_lexeme_resolution(
    tmp_path,
):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    promote = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    first = db.commit_adjudications("judge-run", [promote])
    locked = db.lock_concept_translation("Drotte", "德罗特", kind="person")
    with db.transaction() as connection:
        connection.execute(
            """UPDATE candidate_resolutions
               SET lexeme_id=NULL, concept_id=?
               WHERE adjudication_id=(
                   SELECT id FROM candidate_adjudications WHERE active=1
               ) AND candidate_id=?""",
            (locked["concept_id"], candidates[0].id),
        )
        locked_before = tuple(
            connection.execute(
                """SELECT default_target, working_target, verified_target,
                          description, status, locked, retired_version
                   FROM concepts WHERE id=?""",
                (locked["concept_id"],),
            ).fetchone()
        )

    repaired = db.commit_adjudications("judge-run", [promote])
    with closing(db.connect()) as connection:
        adjudications = connection.execute(
            "SELECT active FROM candidate_adjudications ORDER BY knowledge_version"
        ).fetchall()
        active_resolution = connection.execute(
            """SELECT cr.lexeme_id, cr.concept_id
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[0].id,),
        ).fetchone()
        locked_after = tuple(
            connection.execute(
                """SELECT default_target, working_target, verified_target,
                          description, status, locked, retired_version
                   FROM concepts WHERE id=?""",
                (locked["concept_id"],),
            ).fetchone()
        )

    assert repaired["knowledge_version"] != first["knowledge_version"]
    assert repaired["changed"] == 1
    assert repaired["concept_ids"] == []
    assert [row["active"] for row in adjudications] == [0, 1]
    assert active_resolution["lexeme_id"] is not None
    assert active_resolution["concept_id"] is None
    assert locked_after == locked_before


def test_candidate_source_form_must_match_exact_persisted_span(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    before_version = db.current_knowledge_version()
    with db.transaction() as connection:
        connection.execute(
            "UPDATE lexical_candidates SET original_text='drotte' WHERE id=?",
            (candidates[0].id,),
        )

    with pytest.raises(ValueError, match="source form does not match block slice"):
        db.commit_adjudications(
            "judge-run",
            [
                AdjudicationResult(
                    "cluster-1", "promote", (candidates[0].id,), "person", 0.9
                )
            ],
        )

    with closing(db.connect()) as connection:
        assert db.current_knowledge_version() == before_version
        assert connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_type_observations"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications"
        ).fetchone()[0] == 0


@pytest.mark.parametrize(
    ("verdict", "selected_indexes", "reason", "overlap"),
    [
        ("promote", (0, 1), "", False),
        ("split", (0,), "", False),
        ("split", (0, 1), "", True),
        ("supersede", (0, 1), "", False),
        ("supersede", (0,), "", False),
        ("promote", (0,), "missing_span", False),
    ],
)
def test_commit_adjudications_revalidates_protocol_atomically(
    tmp_path, verdict, selected_indexes, reason, overlap
):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    if overlap:
        with db.transaction() as connection:
            connection.execute(
                """UPDATE lexical_candidates SET start_offset=3, end_offset=9
                   WHERE id=?""",
                (candidates[1].id,),
            )
    before_version = db.current_knowledge_version()
    selected = tuple(candidates[index].id for index in selected_indexes)

    with pytest.raises(ValueError):
        db.commit_adjudications(
            "judge-run",
            [
                AdjudicationResult(
                    "cluster-1", verdict, selected, "concept", 0.9, reason
                )
            ],
        )

    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM candidate_resolutions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        statuses = connection.execute(
            "SELECT resolution_status, selected FROM lexical_candidates ORDER BY id"
        ).fetchall()
    assert db.current_knowledge_version() == before_version
    assert [tuple(row) for row in statuses] == [("pending", 0), ("pending", 0)]


def test_identical_payload_repairs_drifted_active_candidate_state(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    result = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    first = db.commit_adjudications("judge-run", [result])
    with db.transaction() as connection:
        connection.execute(
            """UPDATE lexical_candidates SET resolution_status='rejected',
               model_status='rejected', selected=0 WHERE id=?""",
            (candidates[0].id,),
        )

    repaired = db.commit_adjudications("judge-run", [result])

    assert repaired["knowledge_version"] != first["knowledge_version"]
    with closing(db.connect()) as connection:
        candidate_row = connection.execute(
            "SELECT resolution_status, model_status, selected FROM lexical_candidates WHERE id=?",
            (candidates[0].id,),
        ).fetchone()
        assert tuple(candidate_row) == ("promoted", "accepted", 1)
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications"
        ).fetchone()[0] == 2


def test_identical_payload_supersedes_drifted_mention_evidence_chain(tmp_path):
    db, _, block, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    result = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    first = db.commit_adjudications("judge-run", [result])
    with db.transaction() as connection:
        active = connection.execute(
            """SELECT ca.id AS adjudication_id, cr.lexeme_id
               FROM candidate_adjudications ca
               JOIN candidate_resolutions cr ON cr.adjudication_id=ca.id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[0].id,),
        ).fetchone()
        drift_evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at
               ) VALUES(?, 'P000', 'candidate_adjudication', 'Drotte',
                        'Drotte', '{}', 0.9, 'candidate_adjudication',
                        'judge-run', 'now')""",
            (block.id,),
        ).lastrowid
        drift_mention_id = connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id
               ) VALUES(?, 'P000', 'Drotte', 'drotte', 'referential',
                        ?, NULL, ?)""",
            (block.id, active["lexeme_id"], drift_evidence_id),
        ).lastrowid
        connection.execute(
            """UPDATE concept_type_observations SET mention_id=?
               WHERE adjudication_id=?""",
            (drift_mention_id, active["adjudication_id"]),
        )

    repaired = db.commit_adjudications("judge-run", [result])

    assert repaired["knowledge_version"] != first["knowledge_version"]
    assert repaired["changed"] == 1
    with closing(db.connect()) as connection:
        chain = connection.execute(
            """SELECT cr.evidence_id AS resolution_evidence_id,
                      cto.evidence_id AS observation_evidence_id,
                      cto.mention_id, m.evidence_id AS mention_evidence_id
               FROM candidate_adjudications ca
               JOIN candidate_resolutions cr ON cr.adjudication_id=ca.id
               JOIN concept_type_observations cto
                 ON cto.adjudication_id=ca.id AND cto.lexeme_id=cr.lexeme_id
               JOIN mentions m ON m.id=cto.mention_id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[0].id,),
        ).fetchone()
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications"
        ).fetchone()[0] == 2
    assert (
        chain["resolution_evidence_id"]
        == chain["observation_evidence_id"]
        == chain["mention_evidence_id"]
    )


def test_identical_payload_supersedes_duplicate_candidate_resolution(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    result = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    first = db.commit_adjudications("judge-run", [result])
    with db.transaction() as connection:
        connection.execute(
            """INSERT INTO candidate_resolutions(
                   id, adjudication_id, run_id, cluster_id, candidate_id,
                   lexeme_id, concept_id, evidence_id, decision, ordinal,
                   payload_json, created_at
               )
               SELECT 'duplicate-resolution', cr.adjudication_id, cr.run_id,
                      cr.cluster_id, cr.candidate_id, cr.lexeme_id,
                      cr.concept_id, cr.evidence_id, cr.decision, 99,
                      cr.payload_json, cr.created_at
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[1].id,),
        )

    repaired = db.commit_adjudications("judge-run", [result])

    assert repaired["knowledge_version"] != first["knowledge_version"]
    assert repaired["changed"] == 1
    with closing(db.connect()) as connection:
        adjudications = connection.execute(
            """SELECT active, superseded_at FROM candidate_adjudications
               ORDER BY knowledge_version"""
        ).fetchall()
        resolution_counts = connection.execute(
            """SELECT COUNT(*) AS total,
                      COUNT(DISTINCT cr.candidate_id) AS candidates
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               WHERE ca.active=1"""
        ).fetchone()
    assert [row["active"] for row in adjudications] == [0, 1]
    assert adjudications[0]["superseded_at"] is not None
    assert tuple(resolution_counts) == (len(candidates), len(candidates))


def test_split_supersedes_reused_evidence_and_orphan_observation_chain(tmp_path):
    db, _, _, candidates = _seed_database(tmp_path, names=("Drotte", "Drotte"))
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    result = AdjudicationResult(
        "cluster-1",
        "split",
        tuple(candidate.id for candidate in candidates),
        "person",
        0.9,
    )
    first = db.commit_adjudications("judge-run", [result])
    with db.transaction() as connection:
        resolutions = connection.execute(
            """SELECT cr.id, cr.evidence_id
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               WHERE ca.active=1 ORDER BY cr.ordinal"""
        ).fetchall()
        connection.execute(
            "UPDATE candidate_resolutions SET evidence_id=? WHERE id=?",
            (resolutions[0]["evidence_id"], resolutions[1]["id"]),
        )

    repaired = db.commit_adjudications("judge-run", [result])

    assert repaired["knowledge_version"] != first["knowledge_version"]
    assert repaired["changed"] == 1
    with closing(db.connect()) as connection:
        adjudications = connection.execute(
            """SELECT active, superseded_at FROM candidate_adjudications
               ORDER BY knowledge_version"""
        ).fetchall()
        chains = connection.execute(
            """SELECT cr.candidate_id, cr.evidence_id, cto.id AS observation_id,
                      cto.mention_id, m.evidence_id AS mention_evidence_id
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               JOIN concept_type_observations cto
                 ON cto.adjudication_id=cr.adjudication_id
                    AND cto.lexeme_id=cr.lexeme_id
                    AND cto.evidence_id=cr.evidence_id
               JOIN mentions m ON m.id=cto.mention_id
               WHERE ca.active=1 AND cr.decision='split'
               ORDER BY cr.ordinal"""
        ).fetchall()
        active_observations = connection.execute(
            """SELECT COUNT(*) FROM concept_type_observations cto
               JOIN candidate_adjudications ca ON ca.id=cto.adjudication_id
               WHERE ca.active=1 AND cto.source='candidate_adjudication'"""
        ).fetchone()[0]
        orphan_observations = connection.execute(
            """SELECT COUNT(*) FROM concept_type_observations cto
               JOIN candidate_adjudications ca ON ca.id=cto.adjudication_id
               WHERE ca.active=1 AND cto.source='candidate_adjudication'
                 AND NOT EXISTS(
                     SELECT 1 FROM candidate_resolutions cr
                     WHERE cr.adjudication_id=cto.adjudication_id
                       AND cr.lexeme_id=cto.lexeme_id
                       AND cr.evidence_id=cto.evidence_id)"""
        ).fetchone()[0]
    assert [row["active"] for row in adjudications] == [0, 1]
    assert adjudications[0]["superseded_at"] is not None
    assert len(chains) == len(candidates)
    assert len({row["candidate_id"] for row in chains}) == len(candidates)
    assert len({row["evidence_id"] for row in chains}) == len(candidates)
    assert len({row["mention_id"] for row in chains}) == len(candidates)
    assert len({row["observation_id"] for row in chains}) == len(candidates)
    assert all(
        row["evidence_id"] == row["mention_evidence_id"] for row in chains
    )
    assert active_observations == len(candidates)
    assert orphan_observations == 0


def test_identical_payload_supersedes_drifted_evidence_metadata(tmp_path):
    db, _, block, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    result = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    first = db.commit_adjudications("judge-run", [result])
    with db.transaction() as connection:
        active = connection.execute(
            """SELECT ca.id AS adjudication_id, ca.payload_json, cr.evidence_id
               FROM candidate_adjudications ca
               JOIN candidate_resolutions cr ON cr.adjudication_id=ca.id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[0].id,),
        ).fetchone()
        expected_payload_json = active["payload_json"]
        connection.execute(
            """UPDATE evidence
               SET paragraph_id='drifted', evidence_quote='wrong quote',
                   payload_json='{}', confidence=0.1, run_id='scan-run'
               WHERE id=?""",
            (active["evidence_id"],),
        )

    repaired = db.commit_adjudications("judge-run", [result])

    assert repaired["knowledge_version"] != first["knowledge_version"]
    assert repaired["changed"] == 1
    with closing(db.connect()) as connection:
        adjudications = connection.execute(
            """SELECT id, active, superseded_at
               FROM candidate_adjudications ORDER BY knowledge_version"""
        ).fetchall()
        chain = connection.execute(
            """SELECT e.block_id, e.paragraph_id, e.kind, e.source_form,
                      e.evidence_quote, e.payload_json, e.confidence,
                      e.extractor, e.run_id
               FROM candidate_adjudications ca
               JOIN candidate_resolutions cr ON cr.adjudication_id=ca.id
               JOIN evidence e ON e.id=cr.evidence_id
               WHERE ca.active=1 AND cr.candidate_id=?""",
            (candidates[0].id,),
        ).fetchone()
    assert [row["active"] for row in adjudications] == [0, 1]
    assert adjudications[0]["superseded_at"] is not None
    assert tuple(chain) == (
        block.id,
        candidates[0].paragraph_id,
        "candidate_adjudication",
        candidates[0].original_text,
        candidates[0].original_text,
        expected_payload_json,
        result.confidence,
        "candidate_adjudication",
        "judge-run",
    )


@pytest.mark.parametrize(
    ("column", "drifted_value"),
    (("normalized_form", "corrupt"), ("discourse_function", "vocative")),
)
def test_identical_payload_supersedes_drifted_mention_metadata(
    tmp_path, column, drifted_value
):
    db, _, _, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    result = AdjudicationResult(
        "cluster-1", "promote", (candidates[0].id,), "person", 0.9
    )
    first = db.commit_adjudications("judge-run", [result])
    with db.transaction() as connection:
        active = connection.execute(
            """SELECT ca.id AS adjudication_id, cto.mention_id
               FROM candidate_adjudications ca
               JOIN concept_type_observations cto
                 ON cto.adjudication_id=ca.id
               WHERE ca.active=1"""
        ).fetchone()
        connection.execute(
            f"UPDATE mentions SET {column}=? WHERE id=?",
            (drifted_value, active["mention_id"]),
        )

    repaired = db.commit_adjudications("judge-run", [result])

    assert repaired["knowledge_version"] != first["knowledge_version"]
    assert repaired["changed"] == 1
    with closing(db.connect()) as connection:
        adjudications = connection.execute(
            """SELECT active, superseded_at FROM candidate_adjudications
               ORDER BY knowledge_version"""
        ).fetchall()
        mention = connection.execute(
            """SELECT m.normalized_form, m.discourse_function
               FROM candidate_adjudications ca
               JOIN concept_type_observations cto
                 ON cto.adjudication_id=ca.id
               JOIN mentions m ON m.id=cto.mention_id
               WHERE ca.active=1"""
        ).fetchone()
    assert [row["active"] for row in adjudications] == [0, 1]
    assert adjudications[0]["superseded_at"] is not None
    assert tuple(mention) == ("drotte", "referential")


def test_reset_removes_orphan_automatic_type_observation_and_lexeme(tmp_path):
    db = V4Database(tmp_path / "orphan-automatic-observation")
    lexeme_id = db.ensure_lexeme("OrphanTerm")
    observation_id = db.record_type_observation(
        lexeme_id,
        "person",
        confidence=0.4,
        source="candidate_adjudication",
    )

    preview = db.preview_scan_reset()

    assert preview["concept_type_observations"] == 1
    assert preview["lexemes"] == 1
    assert preview["source_forms"] == 1
    deleted = db.reset_scan_derivatives(preview["token"])
    assert deleted["concept_type_observations"] == 1
    assert deleted["lexemes"] == 1
    assert deleted["source_forms"] == 1
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_type_observations WHERE id=?",
            (observation_id,),
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM lexemes WHERE id=?", (lexeme_id,)
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM source_forms WHERE lexeme_id=?", (lexeme_id,)
        ).fetchone()[0] == 0


def test_reset_token_guards_snapshot_and_preserves_sources_baseline_and_locks(tmp_path):
    db, edition, block, candidates = _seed_database(tmp_path)
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-1", "promote", (candidates[0].id,), "person", 0.9)],
    )
    locked = db.lock_concept_translation("Roche", "罗奇", kind="person")
    manual_concept_id = db.import_legacy_concept(
        "ManualTerm", "人工译名", "concept", "non-scan human data"
    )
    with db.transaction() as connection:
        connection.execute(
            """INSERT INTO source_paragraphs(
                   source_edition_id, paragraph_index, source_text, source_hash,
                   char_start, char_end
               ) VALUES(?, 0, 'Drotte Roche', 'paragraph-hash', 0, 12)""",
            (edition,),
        )
        connection.execute(
            """INSERT INTO baseline_documents(
                   id, source_edition_id, name, kind, file_path, file_sha256,
                   paragraph_count, metadata_json, active, created_at
               ) VALUES('baseline-1', ?, 'old', 'docx', 'old.docx', 'sha', 1, '{}', 1, 'now')""",
            (edition,),
        )
        connection.execute(
            "INSERT INTO baseline_paragraphs VALUES('baseline-1', 0, '旧译', 'target-hash')"
        )
        connection.execute(
            """INSERT INTO block_baseline_links(
                   block_id, baseline_document_id, paragraph_index, ordinal,
                   overlap_start, overlap_end
               ) VALUES(?, 'baseline-1', 0, 0, 0, 12)""",
            (block.id,),
        )
        evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at
               ) VALUES(?, 'P000', 'human_note', 'ManualTerm', 'ManualTerm',
                        '{}', 1.0, 'human', NULL, 'now')""",
            (block.id,),
        ).lastrowid
        manual_lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (manual_concept_id,),
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id
               ) VALUES(?, 'P000', 'ManualTerm', 'manualterm',
                        'referential', ?, ?, ?)""",
            (block.id, manual_lexeme_id, manual_concept_id, evidence_id),
        )

    preview = db.preview_scan_reset()
    assert preview["lexical_candidates"] == 2
    assert preview["concepts"] == 0
    assert preview["preserved_locked_concepts"] == 1

    with db.transaction() as connection:
        connection.execute(
            "UPDATE lexical_candidates SET updated_at='changed' WHERE id=?",
            (candidates[0].id,),
        )
    with pytest.raises(ValueError, match="token"):
        db.reset_scan_derivatives(preview["token"])
    assert db.preview_scan_reset()["lexical_candidates"] == 2

    fresh = db.preview_scan_reset()
    deleted = db.reset_scan_derivatives(fresh["token"])
    assert deleted["lexical_candidates"] == 2
    deletion_keys = {
        "lexical_candidates",
        "candidate_clusters",
        "candidate_cluster_members",
        "candidate_adjudications",
        "candidate_resolutions",
        "concept_type_observations",
        "usage_decisions",
        "mentions",
        "evidence",
        "claim_evidence",
        "claims",
        "source_forms",
        "lexemes",
        "rendering_rules",
        "verification_votes",
        "verification_tasks",
        "concepts",
        "blocks_reset",
    }
    assert {key: fresh[key] for key in deletion_keys} == deleted
    assert db.source_block_count() == 1
    assert db.locked_concept_count() == 1
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT status FROM blocks").fetchone()[0] == "pending"
        assert connection.execute("SELECT COUNT(*) FROM source_editions").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM source_paragraphs").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM baseline_documents").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM baseline_paragraphs").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM block_baseline_links").fetchone()[0] == 1
        locked_targets = connection.execute(
            "SELECT default_target, working_target, verified_target FROM concepts WHERE id=?",
            (locked["concept_id"],),
        ).fetchone()
        assert tuple(locked_targets) == ("罗奇", "罗奇", "罗奇")
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts WHERE id=?", (manual_concept_id,)
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM evidence WHERE extractor='human'"
        ).fetchone()[0] == 1
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_reset_token_tracks_usage_lock_and_preserves_locked_occurrence_dependencies(tmp_path):
    db, _, block, candidates = _seed_database(tmp_path)
    preexisting_lexeme_id = db.ensure_lexeme("Drotte")
    with db.transaction() as connection:
        db.record_form_occurrences(
            [
                FormOccurrence(
                    lexeme_id=preexisting_lexeme_id,
                    block_id=block.id,
                    start_offset=candidates[0].start_offset,
                    end_offset=candidates[0].end_offset,
                    source_form=candidates[0].original_text,
                    source_hash=block.source_hash,
                )
            ],
            connection=connection,
        )
    db.persist_candidate_clusters("scan-run", [_cluster("cluster-1", candidates)])
    db.commit_adjudications(
        "judge-run",
        [AdjudicationResult("cluster-1", "promote", (candidates[0].id,), "person", 0.9)],
    )
    locked = db.lock_concept_translation(
        "Drotte", "德罗特", kind="person", description="human identity fixture"
    )
    concept_id = locked["concept_id"]
    with db.transaction() as connection:
        version = connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        adjudication_id = connection.execute(
            "SELECT id FROM candidate_adjudications WHERE active=1"
        ).fetchone()[0]
        cursor = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at
               ) VALUES(?, 'P000', 'mention', 'Drotte', 'Drotte', '{}', 1.0,
                        'scan_v4_2', 'scan-run', 'now')""",
            (block.id,),
        )
        evidence_id = cursor.lastrowid
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()[0]
        cursor = connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id
               ) VALUES(?, 'P000', 'Drotte', 'drotte', 'vocative', ?, ?, ?)""",
            (block.id, lexeme_id, concept_id, evidence_id),
        )
        mention_id = cursor.lastrowid
        cursor = connection.execute(
            """INSERT INTO usage_decisions(
                   mention_id, rendering, status, scope, locked,
                   created_version, created_at
               ) VALUES(?, '德罗特阁下', 'provisional', 'occurrence', 0, ?, 'now')""",
            (mention_id, version),
        )
        usage_id = cursor.lastrowid
    preview = db.preview_scan_reset()
    assert preview["usage_decisions"] == 1
    with db.transaction() as connection:
        connection.execute(
            """UPDATE usage_decisions SET locked=1, status='verified'
               WHERE id=?""",
            (usage_id,),
        )
        human_observation_id = db.record_type_observation(
            lexeme_id,
            "person",
            confidence=1.0,
            source="human",
            mention_id=mention_id,
            concept_id=concept_id,
            evidence_id=evidence_id,
            adjudication_id=adjudication_id,
            connection=connection,
        )
    with pytest.raises(ValueError, match="token"):
        db.reset_scan_derivatives(preview["token"])

    fresh = db.preview_scan_reset()
    assert fresh["usage_decisions"] == 0
    assert fresh["concept_type_observations"] == 1
    deleted = db.reset_scan_derivatives(fresh["token"])
    assert deleted["concept_type_observations"] == 1
    with closing(db.connect()) as connection:
        usage = connection.execute(
            "SELECT locked, status, mention_id FROM usage_decisions WHERE id=?", (usage_id,)
        ).fetchone()
        mention = connection.execute(
            "SELECT evidence_id, concept_id FROM mentions WHERE id=?", (mention_id,)
        ).fetchone()
        assert tuple(usage) == (1, "verified", mention_id)
        assert mention["evidence_id"] == evidence_id
        assert mention["concept_id"] == concept_id
        occurrence = connection.execute(
            """SELECT source_form, source_hash FROM form_occurrences
               WHERE lexeme_id=? AND block_id=? AND start_offset=? AND end_offset=?""",
            (
                preexisting_lexeme_id,
                block.id,
                candidates[0].start_offset,
                candidates[0].end_offset,
            ),
        ).fetchone()
        human_observation = connection.execute(
            """SELECT source, lexeme_id, mention_id, concept_id, evidence_id,
                      adjudication_id
               FROM concept_type_observations WHERE id=?""",
            (human_observation_id,),
        ).fetchone()
        assert tuple(occurrence) == (candidates[0].original_text, block.source_hash)
        assert tuple(human_observation) == (
            "human",
            preexisting_lexeme_id,
            mention_id,
            concept_id,
            evidence_id,
            adjudication_id,
        )
        assert connection.execute(
            """SELECT COUNT(*) FROM concept_type_observations
               WHERE source='candidate_adjudication'"""
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications WHERE id=?",
            (adjudication_id,),
        ).fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM evidence WHERE id=?", (evidence_id,)).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM source_forms sf
               JOIN concept_lexemes cl ON cl.lexeme_id=sf.lexeme_id
               WHERE cl.concept_id=? AND cl.retired_version IS NULL""",
            (concept_id,),
        ).fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM concepts WHERE id=?", (concept_id,)).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM lexemes WHERE id=?", (preexisting_lexeme_id,)
        ).fetchone()[0] == 1
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_reset_preserves_locked_claim_and_its_scan_evidence_chain(tmp_path):
    db, _, block, _ = _seed_database(tmp_path)
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at)
               VALUES(?, 'P000', 'claim', 'Drotte', 'Drotte', '{}', 1.0,
                      'scan_full', 'scan-run', 'now')""",
            (block.id,),
        ).lastrowid
        connection.execute(
            """INSERT INTO claims(
                   id, kind, statement, subject_form, status, scope, confidence,
                   reveal_global_index, high_impact, locked, created_version,
                   created_at)
               VALUES('claim-locked', 'identity', 'Drotte is Drotte', 'Drotte',
                      'verified', 'book', 1.0, 0, 1, 1, ?, 'now')""",
            (version,),
        )
        connection.execute(
            "INSERT INTO claim_evidence(claim_id, evidence_id) VALUES('claim-locked', ?)",
            (evidence_id,),
        )

    preview = db.preview_scan_reset()
    assert preview["claims"] == 0
    assert preview["claim_evidence"] == 0
    assert preview["evidence"] == 0
    deleted = db.reset_scan_derivatives(preview["token"])

    assert deleted["claims"] == preview["claims"]
    assert deleted["claim_evidence"] == preview["claim_evidence"]
    assert deleted["evidence"] == preview["evidence"]
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM claims WHERE id='claim-locked'"
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM claim_evidence
               WHERE claim_id='claim-locked' AND evidence_id=?""",
            (evidence_id,),
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM evidence WHERE id=?", (evidence_id,)
        ).fetchone()[0] == 1
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_reset_token_tracks_exact_block_status_rows(tmp_path):
    db, edition, block, _ = _seed_database(tmp_path)
    db.upsert_blocks(
        edition,
        [
            {
                "id": "block-pending",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 1,
                "global_index": 1,
                "block_type": "prose",
                "source_text": "Pending.",
                "source_hash": "pending-hash",
                "token_count": 1,
                "status": "pending",
            }
        ],
    )
    with db.transaction() as connection:
        pending_before = connection.execute(
            "SELECT updated_at FROM blocks WHERE id='block-pending'"
        ).fetchone()[0]

    preview = db.preview_scan_reset()
    assert preview["blocks_reset"] == 1
    with db.transaction() as connection:
        connection.execute(
            """UPDATE blocks SET status='ready', last_error='changed',
               updated_at='changed' WHERE id=?""",
            (block.id,),
        )
    with pytest.raises(ValueError, match="token"):
        db.reset_scan_derivatives(preview["token"])

    fresh = db.preview_scan_reset()
    assert fresh["blocks_reset"] == 1
    deleted = db.reset_scan_derivatives(fresh["token"])
    assert deleted["blocks_reset"] == 1
    with closing(db.connect()) as connection:
        reset_row = connection.execute(
            "SELECT status, last_error FROM blocks WHERE id=?", (block.id,)
        ).fetchone()
        pending_after = connection.execute(
            "SELECT status, last_error, updated_at FROM blocks WHERE id='block-pending'"
        ).fetchone()
    assert tuple(reset_row) == ("pending", None)
    assert tuple(pending_after) == ("pending", None, pending_before)


def test_reset_preserves_block_status_when_any_translation_version_exists(tmp_path):
    db, _, block, _ = _seed_database(tmp_path)
    db.start_run("translate-run", "translate", {})
    with db.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, run_id, knowledge_version, status,
                   draft_translation, final_translation, active, created_at
               ) VALUES(?, 'parallel_v4', 'translate-run', ?, 'completed',
                        '译稿', '定稿', 1, 'now')""",
            (block.id, version),
        )
        connection.execute(
            """UPDATE blocks SET status='completed', last_error=NULL,
                   updated_at='translated' WHERE id=?""",
            (block.id,),
        )

    preview = db.preview_scan_reset()
    assert preview["blocks_reset"] == 0
    db.reset_scan_derivatives(preview["token"])

    with closing(db.connect()) as connection:
        block_row = connection.execute(
            "SELECT status,last_error,updated_at FROM blocks WHERE id=?",
            (block.id,),
        ).fetchone()
        translation_row = connection.execute(
            """SELECT status,active,draft_translation,final_translation
               FROM translation_versions WHERE block_id=?""",
            (block.id,),
        ).fetchone()
    assert tuple(block_row) == ("completed", None, "translated")
    assert tuple(translation_row) == ("completed", 1, "译稿", "定稿")


def test_moderate_candidate_storage_scale_keeps_integrity(tmp_path):
    names = tuple(f"Name{index:03d}" for index in range(240))
    db, _, _, candidates = _seed_database(tmp_path, names=names)
    clusters = [
        _cluster(f"cluster-{index:03d}", candidates[index : index + 4])
        for index in range(0, len(candidates), 4)
    ]
    persisted = db.persist_candidate_clusters("scan-run", list(reversed(clusters)))

    assert persisted == {"clusters": 60, "members": 240}
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM lexical_candidates").fetchone()[0] == 240
        assert connection.execute("SELECT COUNT(*) FROM candidate_clusters").fetchone()[0] == 60
        assert connection.execute("SELECT COUNT(*) FROM candidate_cluster_members").fetchone()[0] == 240
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_accepted_audit_round_trips_from_independent_zstd_frames(tmp_path):
    archive = AuditArchive(tmp_path / "audit")
    first_payload = {"request": {"x": 1}, "response": "ok"}
    second_payload = {"request": {"x": 2}, "response": "also ok"}

    first = archive.append("run_1", first_payload, stage="translate")
    second = archive.append("run_1", second_payload, stage="translate")

    assert first.relative_path == second.relative_path
    assert second.offset == first.offset + first.compressed_length
    assert len(first.sha256) == 64
    assert archive.read(first) == first_payload
    assert archive.read(second) == second_payload


def test_independent_archive_instances_append_unique_readable_frames(tmp_path):
    root = tmp_path / "audit"
    archives = [AuditArchive(root) for _ in range(24)]
    barrier = Barrier(len(archives))

    def append_one(index):
        barrier.wait()
        return archives[index].append(
            "shared-run", {"index": index}, stage="concurrent"
        )

    with ThreadPoolExecutor(max_workers=len(archives)) as executor:
        locators = list(executor.map(append_one, range(len(archives))))

    assert len({item.offset for item in locators}) == len(locators)
    assert sorted(item.offset for item in locators)[0] == 0
    for locator in locators:
        assert AuditArchive(root).read(locator)["index"] in range(len(archives))


def test_database_externalizes_only_successful_automatic_audits(tmp_path):
    db, _, block, _ = _seed_database(tmp_path)
    accepted_id = db.record_audit_call(
        "scan-run",
        block.id,
        "translate",
        "fake",
        db.current_knowledge_version(),
        {"messages": [{"content": "large request"}]},
        "large response",
        {"translation": "译文"},
        True,
        1,
        12,
        None,
    )
    failed_id = db.record_audit_call(
        "scan-run",
        block.id,
        "translate",
        "fake",
        db.current_knowledge_version(),
        {"messages": [{"content": "failed request"}]},
        "failed response",
        None,
        False,
        2,
        24,
        "protocol failure",
    )
    manual_id = db.record_audit_call(
        "scan-run",
        block.id,
        "manual_review",
        "human",
        db.current_knowledge_version(),
        {"note": "keep in SQL"},
        "accepted by editor",
        {"choice": "A"},
        True,
        1,
        0,
        None,
    )

    with closing(db.connect()) as connection:
        accepted = connection.execute(
            "SELECT * FROM audit_calls WHERE id=?", (accepted_id,)
        ).fetchone()
        failed = connection.execute(
            "SELECT * FROM audit_calls WHERE id=?", (failed_id,)
        ).fetchone()
        manual = connection.execute(
            "SELECT * FROM audit_calls WHERE id=?", (manual_id,)
        ).fetchone()

    assert accepted["request_json"] == "{}"
    assert accepted["raw_response"] == ""
    assert accepted["parsed_json"] is None
    assert accepted["archive_relative_path"].endswith("translate_scan-run.jsonl.zst")
    assert accepted["archive_offset"] >= 0
    assert accepted["archive_compressed_length"] > 0
    assert len(accepted["archive_sha256"]) == 64
    assert db.read_audit_payload(accepted_id) == {
        "request": {"messages": [{"content": "large request"}]},
        "raw_response": "large response",
        "parsed": {"translation": "译文"},
    }

    assert failed["archive_relative_path"] is None
    assert json.loads(failed["request_json"])["messages"][0]["content"] == "failed request"
    assert failed["raw_response"] == "failed response"
    assert manual["archive_relative_path"] is None
    assert json.loads(manual["request_json"]) == {"note": "keep in SQL"}
    assert manual["raw_response"] == "accepted by editor"


def test_audit_mode_never_truncates_persisted_success_or_failure(tmp_path):
    db, _, block, _ = _seed_database(tmp_path)
    db.start_run("translate-audit", "translate", {})
    accepted = {
        "purpose": "translate",
        "model": "fake",
        "request": {"messages": [{"content": "complete accepted request"}]},
        "raw_response": "complete accepted response",
        "parsed": {"translation": "完整译文"},
        "accepted": True,
    }
    failed = {
        "purpose": "polish",
        "model": "fake",
        "request": {"messages": [{"content": "complete failed request"}]},
        "raw_response": "complete failed response",
        "parsed": {"partial": True},
        "accepted": False,
        "error": "strict validation failed",
    }

    db.commit_translation_batch(
        "translate-audit",
        [
            TranslationOutcome(
                block=block,
                knowledge_version=db.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                final_translation="完整译文",
                audit_calls=[accepted, failed],
            )
        ],
        audit_mode="minimal",
    )

    with closing(db.connect()) as connection:
        rows = connection.execute(
            "SELECT * FROM audit_calls WHERE run_id='translate-audit' ORDER BY id"
        ).fetchall()
    assert len(rows) == 2
    assert db.read_audit_payload(rows[0]["id"]) == {
        "request": accepted["request"],
        "raw_response": accepted["raw_response"],
        "parsed": accepted["parsed"],
    }
    assert rows[1]["archive_relative_path"] is None
    assert json.loads(rows[1]["request_json"]) == failed["request"]
    assert rows[1]["raw_response"] == failed["raw_response"]
    assert json.loads(rows[1]["parsed_json"]) == failed["parsed"]


def test_human_model_is_kept_inline_even_with_ordinary_purpose(tmp_path):
    db, _, block, _ = _seed_database(tmp_path)
    audit_id = db.record_audit_call(
        "scan-run",
        block.id,
        "translate",
        "human",
        db.current_knowledge_version(),
        {"note": "ordinary purpose, human model"},
        "editor response",
        {"choice": "B"},
        True,
        1,
        0,
        None,
    )

    with closing(db.connect()) as connection:
        row = connection.execute(
            "SELECT * FROM audit_calls WHERE id=?", (audit_id,)
        ).fetchone()
    assert row["archive_relative_path"] is None
    assert json.loads(row["request_json"]) == {
        "note": "ordinary purpose, human model"
    }
    assert row["raw_response"] == "editor response"


@pytest.mark.parametrize(
    ("model", "request_payload"),
    [
        ("human reviewer", {}),
        ("automatic", {"provider": "human/editor"}),
        ("automatic", {"call_type": "manual review"}),
    ],
)
def test_structured_human_markers_with_common_separators_stay_inline(
    tmp_path, model, request_payload
):
    db, _, block, _ = _seed_database(tmp_path)
    audit_id = db.record_audit_call(
        "scan-run",
        block.id,
        "translate",
        model,
        db.current_knowledge_version(),
        request_payload,
        "editor response",
        {"choice": "B"},
        True,
        1,
        0,
        None,
    )

    with closing(db.connect()) as connection:
        row = connection.execute(
            "SELECT * FROM audit_calls WHERE id=?", (audit_id,)
        ).fetchone()
    assert row["archive_relative_path"] is None
    assert json.loads(row["request_json"]) == request_payload


def test_existing_schema7_audit_table_is_not_mutated_on_open(tmp_path):
    root = tmp_path / "legacy-audit"
    path = root / "artifacts" / "parallel_v4" / "book.db"
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO schema_meta VALUES('schema_version', '7');
            CREATE TABLE audit_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT,
                block_id TEXT,
                purpose TEXT NOT NULL,
                model TEXT NOT NULL,
                knowledge_version INTEGER,
                request_json TEXT NOT NULL,
                raw_response TEXT NOT NULL,
                parsed_json TEXT,
                accepted INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 1,
                elapsed_ms INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL
            );
            """
        )

    with pytest.raises(SchemaUpgradeRequired, match="migrate-v4 --preview"):
        V4Database(root)

    with closing(sqlite3.connect(path)) as connection:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(audit_calls)")
        }
    assert {
        "archive_relative_path",
        "archive_offset",
        "archive_compressed_length",
        "archive_sha256",
    }.isdisjoint(columns)


def test_storage_budget_formula_and_batch_rollback(tmp_path, monkeypatch):
    budget = StorageBudget(source_bytes=1_000_000)
    assert budget.active_limit == 40_000_000 + 64 * 1024**2
    with pytest.raises(StorageBudgetExceeded):
        budget.check(budget.active_limit + 1)

    db, _, _, candidates = _seed_database(tmp_path)
    monkeypatch.setattr(StorageBudget, "FIXED_ALLOWANCE_BYTES", 0)
    item = _cluster("cluster-over-budget", candidates)

    with pytest.raises(StorageBudgetExceeded):
        db.persist_candidate_clusters("scan-run", [item])

    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_clusters WHERE id='cluster-over-budget'"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_cluster_members WHERE cluster_id='cluster-over-budget'"
        ).fetchone()[0] == 0


def test_storage_budget_rolls_back_repair_failure_and_human_queue(
    tmp_path, monkeypatch
):
    db, _, block, _ = _seed_database(tmp_path)
    db.start_run("translate-repair-base", "translate", {})
    db.commit_translation_batch(
        "translate-repair-base",
        [
            TranslationOutcome(
                block=block,
                knowledge_version=db.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                final_translation="旧译文",
            )
        ],
    )
    task_id = db.request_repair(block.id, ["遗漏"])
    db.start_run("repair-over-budget", "repair", {})
    monkeypatch.setattr(StorageBudget, "FIXED_ALLOWANCE_BYTES", 0)

    with pytest.raises(StorageBudgetExceeded):
        db.commit_repair_failure(
            task_id,
            "repair failed",
            run_id="repair-over-budget",
            audit={
                "model": "fake",
                "request": {"messages": [{"content": "repair"}]},
                "raw_response": "bad repair",
                "parsed": None,
            },
        )

    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT status FROM repair_tasks WHERE id=?", (task_id,)
        ).fetchone()[0] == "open"
        assert connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE kind='repair_failed'"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls WHERE run_id='repair-over-budget'"
        ).fetchone()[0] == 0


def test_storage_budget_rolls_back_verification_batch(tmp_path, monkeypatch):
    db, _, _, _ = _seed_database(tmp_path)
    db.start_run("verify-over-budget", "verify", {})
    with db.transaction() as connection:
        connection.execute(
            """INSERT INTO verification_tasks(
                   id, subject_type, subject_id, payload_json, status,
                   required_votes, created_at
               ) VALUES('verify-budget', 'claim', 'claim-budget', '{}',
                        'open', 1, 'now')"""
        )
    task = {
        "id": "verify-budget",
        "subject_type": "claim",
        "subject_id": "claim-budget",
        "payload_json": "{}",
        "required_votes": 1,
    }
    monkeypatch.setattr(StorageBudget, "FIXED_ALLOWANCE_BYTES", 0)

    with pytest.raises(StorageBudgetExceeded):
        db.commit_verification_result(
            "verify-over-budget",
            task,
            [
                {
                    "model": "fake",
                    "request": {"messages": [{"content": "verify"}]},
                    "raw_response": "uncertain",
                    "parsed": {
                        "verdict": "uncertain",
                        "rationale": "insufficient evidence",
                        "evidence_quotes": [],
                    },
                    "accepted": True,
                }
            ],
        )

    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT status FROM verification_tasks WHERE id='verify-budget'"
        ).fetchone()[0] == "open"
        assert connection.execute(
            "SELECT COUNT(*) FROM verification_votes WHERE task_id='verify-budget'"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls WHERE run_id='verify-over-budget'"
        ).fetchone()[0] == 0


def test_storage_budget_rolls_back_legacy_translation(tmp_path, monkeypatch):
    db, _, block, _ = _seed_database(tmp_path)
    monkeypatch.setattr(StorageBudget, "FIXED_ALLOWANCE_BYTES", 0)

    with pytest.raises(StorageBudgetExceeded):
        db.import_legacy_translation(
            block.id,
            V4BlockStatus.COMPLETED.value,
            "legacy draft",
            "legacy final",
            "legacy analysis",
            [],
        )

    with closing(db.connect()) as connection:
        assert connection.execute(
            """SELECT COUNT(*) FROM translation_versions
               WHERE block_id=? AND pipeline='serial_v3'""",
            (block.id,),
        ).fetchone()[0] == 0


def test_budget_failure_rolls_back_new_audit_frame(tmp_path, monkeypatch):
    db, _, block, _ = _seed_database(tmp_path)
    db.start_run("audit-budget", "translate", {})
    before = sum(
        path.stat().st_size
        for path in db.audit_archive.root.glob("*.jsonl.zst")
    )
    monkeypatch.setattr(StorageBudget, "FIXED_ALLOWANCE_BYTES", 0)

    with pytest.raises(StorageBudgetExceeded):
        db.record_audit_call(
            "audit-budget",
            block.id,
            "translate",
            "fake",
            db.current_knowledge_version(),
            {"messages": [{"content": "must roll back"}]},
            "must roll back",
            {"translation": "回滚"},
            True,
            1,
            1,
            None,
        )

    after = sum(
        path.stat().st_size
        for path in db.audit_archive.root.glob("*.jsonl.zst")
    )
    assert after == before
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls WHERE run_id='audit-budget'"
        ).fetchone()[0] == 0


def test_sql_commit_failure_truncates_only_uncommitted_audit_frame(tmp_path):
    db, _, block, _ = _seed_database(tmp_path)
    db.start_run("audit-commit-fail", "translate", {})
    baseline_payload = {"baseline": True}
    baseline = db.audit_archive.append(
        "audit-commit-fail", baseline_payload, stage="translate"
    )
    archive_path = db.audit_archive.root / baseline.relative_path
    before = archive_path.stat().st_size

    with pytest.raises(sqlite3.IntegrityError):
        with db.transaction() as connection:
            connection.execute("PRAGMA defer_foreign_keys=ON")
            db.record_audit_call(
                "audit-commit-fail",
                block.id,
                "translate",
                "fake",
                db.current_knowledge_version(),
                {"messages": [{"content": "uncommitted"}]},
                "uncommitted",
                {"translation": "不应保留"},
                True,
                1,
                1,
                None,
                connection=connection,
            )
            connection.execute(
                """INSERT INTO dependencies(
                       translation_id, dependency_type, dependency_id,
                       knowledge_version
                   ) VALUES(999999, 'concept', 'missing', ?)""",
                (db.current_knowledge_version(),),
            )

    assert archive_path.stat().st_size == before
    assert db.audit_archive.read(baseline) == baseline_payload
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls WHERE run_id='audit-commit-fail'"
        ).fetchone()[0] == 0


def test_occurrence_backfill_reuses_one_transaction_for_2001_matches(
    tmp_path, monkeypatch,
):
    root = tmp_path / "occurrence-transaction-book"
    database = V4Database(root)
    edition = database.ensure_source_edition(
        "occurrence-raw", "occurrence-normalized", "scale", "synthetic.txt"
    )
    source_text = " ".join(["Term"] * 2_001)
    database.upsert_blocks(
        edition,
        [
            {
                "id": "occurrence-block",
                "chapter_id": "chapter-1",
                "chapter_title": "Chapter 1",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source_text,
                "source_hash": hashlib.sha256(source_text.encode("utf-8")).hexdigest(),
                "token_count": 2_001,
            }
        ],
    )
    lexeme_id = database.ensure_lexeme("Term")
    coordinator = KnowledgeEpochCoordinator(database, ["occurrence-block"])

    budget_scans = 0
    batch_sizes = []
    batch_connections = []
    original_source_bytes = database._source_bytes
    original_record = database.record_form_occurrences

    def counted_source_bytes(connection):
        nonlocal budget_scans
        budget_scans += 1
        return original_source_bytes(connection)

    def counted_record(rows, **kwargs):
        batch_sizes.append(len(rows))
        batch_connections.append(kwargs.get("connection"))
        return original_record(rows, **kwargs)

    monkeypatch.setattr(database, "_source_bytes", counted_source_bytes)
    monkeypatch.setattr(database, "record_form_occurrences", counted_record)

    inserted = coordinator.backfill_form_occurrences({"Term": lexeme_id})

    assert inserted == 2_001
    assert batch_sizes == [1_000, 1_000, 1]
    assert batch_connections[0] is not None
    assert all(
        connection is batch_connections[0] for connection in batch_connections
    )
    assert budget_scans <= 1
    assert coordinator.backfill_form_occurrences({"Term": lexeme_id}) == 0
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM form_occurrences"
        ).fetchone()[0] == 2_001


def test_three_million_words_backfill_uses_one_active_source_pass_and_is_idempotent(
    tmp_path, monkeypatch,
):
    root = tmp_path / "three-million-book"
    database = V4Database(root)
    edition = database.ensure_source_edition(
        "three-million-raw", "three-million-normalized", "scale", "synthetic.txt"
    )
    new_forms = [f"Term{index:04d}" for index in range(100)]
    block_rows = []
    source_bytes = 0
    for index in range(10_000):
        words = ["x"] * 300
        if index % 2 == 0:
            words[-1] = new_forms[(index // 2) % len(new_forms)]
        source_text = " ".join(words)
        source_bytes += len(source_text.encode("utf-8"))
        block_rows.append(
            {
                "id": f"scale-block-{index:05d}",
                "legacy_id": f"scale_{index:05d}",
                "chapter_id": f"chapter-{index // 100:03d}",
                "chapter_title": f"Chapter {index // 100}",
                "chapter_index": index // 100,
                "block_index": index % 100,
                "global_index": index,
                "block_type": "prose",
                "source_text": source_text,
                "source_hash": hashlib.sha256(source_text.encode("utf-8")).hexdigest(),
                "token_count": 300,
                "status": "ready",
            }
        )
    database.upsert_blocks(edition, block_rows)
    del block_rows

    with database.transaction() as connection:
        version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        connection.executemany(
            """INSERT INTO lexemes(
                   id, language, normalized_form, canonical_form,
                   created_version, created_at)
               VALUES(?, 'en', ?, ?, ?, 'now')""",
            [
                (f"existing-lexeme-{index:04d}", f"existing{index:04d}", f"Existing{index:04d}", version)
                for index in range(1_900)
            ],
        )
        connection.executemany(
            """INSERT INTO source_forms(
                   lexeme_id, form, normalized_form, grammar_json)
               VALUES(?, ?, ?, '{}')""",
            [
                (f"existing-lexeme-{index:04d}", f"Existing{index:04d}", f"existing{index:04d}")
                for index in range(1_900)
            ],
        )

    first_block = database.get_block_by_identifier("scale-block-00000")
    run_id = "three-million-occurrence-backfill"
    database.start_run(run_id, "translate", {"scale_test": True})
    coordinator = KnowledgeEpochCoordinator(
        database,
        [first_block.id],
        max_knowledge_epochs=2,
        decision_mode="auto",
    )
    coordinator.stage(
        run_id,
        [
            TranslationOutcome(
                block=first_block,
                knowledge_version=database.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                term_proposals=[
                    {
                        "src": form,
                        "tgt": f"译名{index:04d}",
                        "type": "concept",
                        "context": "scale",
                    }
                    for index, form in enumerate(new_forms)
                ],
            )
        ],
    )

    traversals = {"calls": 0, "blocks": 0}
    batch_sizes = []
    original_list_blocks = database.list_blocks
    original_record = database.record_form_occurrences

    def counted_list_blocks(*args, **kwargs):
        rows = original_list_blocks(*args, **kwargs)
        traversals["calls"] += 1
        traversals["blocks"] += len(rows)
        return rows

    def counted_record(rows, **kwargs):
        batch_sizes.append(len(rows))
        return original_record(rows, **kwargs)

    monkeypatch.setattr(database, "list_blocks", counted_list_blocks)
    monkeypatch.setattr(database, "record_form_occurrences", counted_record)
    compile_calls = {"forms": 0}
    original_compile = re.compile

    def counted_compile(pattern, *args, **kwargs):
        if isinstance(pattern, str) and pattern.startswith(r"\bTerm"):
            compile_calls["forms"] += 1
        return original_compile(pattern, *args, **kwargs)

    monkeypatch.setattr(re, "compile", counted_compile)
    started = time.perf_counter()
    checkpoint = coordinator.checkpoint(run_id)
    elapsed = time.perf_counter() - started

    assert checkpoint.applied
    assert traversals == {"calls": 1, "blocks": 10_000}
    assert compile_calls["forms"] <= 1
    assert batch_sizes and max(batch_sizes) <= 1_000 and len(batch_sizes) >= 5
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0] == 2_000
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == 5_000
        bad_slices = connection.execute(
            """SELECT COUNT(*)
               FROM form_occurrences occurrence
               JOIN blocks block ON block.id=occurrence.block_id
               WHERE substr(block.source_text, occurrence.start_offset + 1,
                            occurrence.end_offset - occurrence.start_offset)
                     != occurrence.source_form"""
        ).fetchone()[0]
        assert bad_slices == 0
        active_bytes = int(connection.execute("PRAGMA page_count").fetchone()[0]) * int(
            connection.execute("PRAGMA page_size").fetchone()[0]
        )
    StorageBudget(source_bytes).check(active_bytes)

    with closing(database.connect()) as connection:
        form_map = {
            str(row["form"]): str(row["lexeme_id"])
            for row in connection.execute(
                """SELECT form, lexeme_id FROM source_forms
                   WHERE form LIKE 'Term%' ORDER BY form"""
            )
        }
    second_inserted = coordinator.backfill_form_occurrences(form_map)
    assert second_inserted == 0
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == 5_000
    print(f"three_million_local_algorithm_seconds={elapsed:.3f}")
