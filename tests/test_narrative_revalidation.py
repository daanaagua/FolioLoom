from __future__ import annotations

import hashlib
import json

import pytest

from src.core.v4.database import V4Database
from src.core.v4.narrative_memory import NarrativeMemoryStore
from src.core.v4.narrative_models import NarrativeMemoryCandidate
from src.core.v4.narrative_models import DiscourseState
from src.core.v4.models import TranslationOutcome, V4BlockStatus
from src.core.v4.revalidation import (
    RevalidationPlanner,
    RevalidationRunner,
    classify_memory_change,
)


def _seed_database(tmp_path):
    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    texts = (
        "The gate is locked. The gate is open.",
        "He recalls the gate.",
        "A bell rings.",
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": text,
                "source_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "token_count": len(text.split()),
                "status": "ready",
            }
            for index, text in enumerate(texts)
        ],
    )
    return database, database.list_blocks()


def _candidate(
    candidate_id: str,
    statement: str,
    evidence: str,
    *,
    related=(),
    operation="append",
):
    return NarrativeMemoryCandidate(
        candidate_id=candidate_id,
        memory_type="explicit_fact",
        statement=statement,
        truth_status="asserted",
        visibility="reader_visible",
        confidence=0.9,
        evidence_spans=(evidence,),
        related_memory_ids=tuple(related),
        state_operation=operation,
    )


def _insert_translation(
    database: V4Database,
    *,
    block_id: str,
    memory_version: int,
    final_translation: str,
    memory_id: str | None = None,
) -> int:
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET status='completed' WHERE id=?",
            (block_id,),
        )
        knowledge_version = int(
            connection.execute(
                "SELECT MAX(id) FROM knowledge_versions"
            ).fetchone()[0]
        )
        translation_id = int(
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, memory_version,
                       status, final_translation, active, created_at)
                   VALUES(?, 'parallel_v4', ?, ?, 'completed', ?, 1, 'now')""",
                (
                    block_id,
                    knowledge_version,
                    memory_version,
                    final_translation,
                ),
            ).lastrowid
        )
        if memory_id is not None:
            fingerprint = str(
                connection.execute(
                    """SELECT semantic_fingerprint
                       FROM narrative_memories WHERE id=?""",
                    (memory_id,),
                ).fetchone()[0]
            )
            connection.execute(
                """INSERT INTO dependencies(
                       translation_id, dependency_type, dependency_id,
                       knowledge_version, dependency_fingerprint,
                       matched_form, occurrence_count, rendered_target,
                       applied_rule_ids_json, source_spans_json)
                   VALUES(?, 'narrative_memory', ?, ?, ?, '', 0, '',
                          '[]', '[]')""",
                (
                    translation_id,
                    memory_id,
                    knowledge_version,
                    fingerprint,
                ),
            )
        return translation_id


def _retire_memory(database, blocks):
    store = NarrativeMemoryStore(database)
    first = store.merge_candidates(
        blocks[0],
        [
            _candidate(
                "M-old",
                "The gate is locked.",
                "The gate is locked",
            )
        ],
    )
    memory_id = first.memory_ids[0]
    _insert_translation(
        database,
        block_id=blocks[1].id,
        memory_version=first.memory_version,
        final_translation="他记得那扇门。",
        memory_id=memory_id,
    )
    _insert_translation(
        database,
        block_id=blocks[2].id,
        memory_version=first.memory_version,
        final_translation="铃声响起。",
    )
    second = store.merge_candidates(
        blocks[0],
        [
            _candidate(
                "M-new",
                "The gate is open.",
                "The gate is open",
                related=(memory_id,),
                operation="supersede",
            )
        ],
    )
    return memory_id, second.change_ids[-1]


@pytest.mark.parametrize(
    ("change_kind", "impact"),
    [
        ("memory_evidence", 0),
        ("render_only_address", 1),
        ("relationship_state", 2),
        ("viewpoint_shift", 3),
        ("timeline_anchor", 3),
    ],
)
def test_memory_change_impact(change_kind, impact):
    assert classify_memory_change(change_kind, high_impact=False) == impact


def test_narrative_translation_never_uses_local_patch_path():
    assert RevalidationRunner._narrative_context_requires_retranslation(
        {
            "translation_memory_version": 4,
            "translation_snapshot_id": "snapshot-4",
        }
    )
    assert not RevalidationRunner._narrative_context_requires_retranslation(
        {
            "translation_memory_version": 1,
            "translation_snapshot_id": "",
        }
    )


def test_memory_change_only_plans_actual_dependents(tmp_path):
    database, blocks = _seed_database(tmp_path)
    _memory_id, change_id = _retire_memory(database, blocks)

    result = RevalidationPlanner(database).plan_memory([change_id])

    assert result["planned_block_ids"] == ["block-1"]
    assert result["created"] == 1
    with database.connect() as connection:
        tasks = connection.execute(
            """SELECT change_domain, block_id, from_memory_version,
                      to_memory_version
               FROM revalidation_tasks"""
        ).fetchall()
    assert [tuple(row) for row in tasks] == [
        ("memory", "block-1", 2, 3)
    ]


def test_memory_planner_does_not_advertise_unsupported_local_patch(tmp_path):
    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    first = store.merge_candidates(
        blocks[0],
        [
            _candidate(
                "M-address",
                "The gate is locked.",
                "The gate is locked",
            )
        ],
    )
    memory_id = first.memory_ids[0]
    _insert_translation(
        database,
        block_id=blocks[1].id,
        memory_version=first.memory_version,
        final_translation="阁下，门锁着。",
        memory_id=memory_id,
    )
    with database.transaction() as connection:
        version = int(
            connection.execute(
                """INSERT INTO memory_versions(
                       parent_id, reason, source_global_index, created_at)
                   VALUES(?, 'address update', 1, 'now')""",
                (first.memory_version,),
            ).lastrowid
        )
        old_fingerprint = str(
            connection.execute(
                """SELECT semantic_fingerprint
                   FROM narrative_memories WHERE id=?""",
                (memory_id,),
            ).fetchone()[0]
        )
        change_id = int(
            connection.execute(
                """INSERT INTO memory_changes(
                       memory_version, subject_type, subject_id, change_kind,
                       old_fingerprint, new_fingerprint, impact_level,
                       payload_json, created_at)
                   VALUES(?, 'narrative_memory', ?,
                          'render_only_address', ?, 'new-fingerprint', 1,
                          ?, 'now')""",
                (
                    version,
                    memory_id,
                    old_fingerprint,
                    json.dumps(
                        {
                            "exact_unique_render_change": True,
                            "old_rendered_target": "阁下",
                            "new_rendered_target": "大人",
                        }
                    ),
                ),
            ).lastrowid
        )

    RevalidationPlanner(database).plan_memory([change_id])

    with database.connect() as connection:
        result = json.loads(
            str(
                connection.execute(
                    "SELECT result_json FROM revalidation_tasks"
                ).fetchone()[0]
            )
        )
    assert result["recommended_action"] == "retranslate"


def test_failed_memory_retranslation_keeps_old_active_translation(tmp_path):
    database, blocks = _seed_database(tmp_path)
    _memory_id, change_id = _retire_memory(database, blocks)
    RevalidationPlanner(database).plan_memory([change_id])

    def unavailable_factory():
        raise ConnectionError("model unavailable")

    summary = RevalidationRunner(
        database,
        translate_block_factory=unavailable_factory,
        max_attempts=1,
    ).run()

    assert summary["warnings"] == 1
    active = database.active_translations("parallel_v4")
    assert active["block-1"]["final_translation"] == "他记得那扇门。"
    with database.connect() as connection:
        task = connection.execute(
            """SELECT status, action FROM revalidation_tasks
               WHERE block_id='block-1'"""
        ).fetchone()
    assert tuple(task) == ("completed_with_warning", "warning_fallback")


def test_successful_memory_retranslation_commits_target_memory_snapshot(
    tmp_path,
):
    database, blocks = _seed_database(tmp_path)
    _memory_id, change_id = _retire_memory(database, blocks)
    RevalidationPlanner(database).plan_memory([change_id])
    store = NarrativeMemoryStore(database)
    snapshot = store.build_snapshot(
        blocks[1],
        knowledge_version=database.current_knowledge_version(),
        memory_version=store.current_memory_version(),
        discourse_state=DiscourseState(),
    )
    with database.connect() as connection:
        discourse_json = str(
            connection.execute(
                """SELECT discourse_state_json FROM narrative_snapshots
                   WHERE id=?""",
                (snapshot.id,),
            ).fetchone()[0]
        )
    discourse_hash = hashlib.sha256(
        discourse_json.encode("utf-8")
    ).hexdigest()

    def translator_factory():
        def translate(block):
            return TranslationOutcome(
                block=block,
                knowledge_version=database.current_knowledge_version(),
                memory_version=store.current_memory_version(),
                snapshot_id=snapshot.id,
                context_hash=hashlib.sha256(b"context").hexdigest(),
                discourse_state_hash=discourse_hash,
                status=V4BlockStatus.COMPLETED.value,
                final_translation="他如今知道那扇门已经打开。",
            )

        return translate

    summary = RevalidationRunner(
        database,
        translate_block_factory=translator_factory,
        max_attempts=1,
    ).run()

    assert summary["retranslate"] == 1
    active = database.active_translations("parallel_v4")["block-1"]
    assert active["final_translation"] == "他如今知道那扇门已经打开。"
    assert active["memory_version"] == store.current_memory_version()
    assert active["snapshot_id"] == snapshot.id
    with database.connect() as connection:
        dependency_types = {
            str(row[0])
            for row in connection.execute(
                """SELECT dependency_type FROM dependencies
                   WHERE translation_id=?""",
                (active["id"],),
            )
        }
    assert {"narrative_snapshot", "discourse_state"} <= dependency_types


def test_production_retranslation_factory_rebuilds_current_narrative_context(
    tmp_path,
):
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    database, blocks = _seed_database(tmp_path)
    _memory_id, _change_id = _retire_memory(database, blocks)
    store = NarrativeMemoryStore(database)
    old_snapshot = store.build_snapshot(
        blocks[1],
        knowledge_version=database.current_knowledge_version(),
        memory_version=2,
        discourse_state=DiscourseState(
            scene_location="the-gate",
        ),
    )
    with database.transaction() as connection:
        connection.execute(
            """UPDATE translation_versions SET snapshot_id=?
               WHERE block_id='block-1' AND active=1""",
            (old_snapshot.id,),
        )
    pipeline = V4TranslationPipeline(
        database,
        lambda: object(),
        config=V4PipelineConfig(enable_narrative_premap=True),
    )

    def fake_translate_island(island, knowledge_version, concept_snapshot):
        context = pipeline._active_narrative_contexts[blocks[1].id]
        return [
            TranslationOutcome(
                block=blocks[1],
                knowledge_version=knowledge_version,
                memory_version=context.snapshot.memory_version,
                snapshot_id=context.snapshot.id,
                context_hash=hashlib.sha256(b"context").hexdigest(),
                discourse_state_hash=hashlib.sha256(
                    json.dumps(
                        context.snapshot.discourse_state.to_dict(),
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ).hexdigest(),
                status=V4BlockStatus.COMPLETED.value,
                final_translation="重译",
            )
        ]

    pipeline._translate_island = fake_translate_island
    outcome = pipeline.translate_block_factory()(blocks[1])

    assert outcome.memory_version == store.current_memory_version()
    assert outcome.snapshot_id != old_snapshot.id
    assert pipeline._active_narrative_contexts[
        blocks[1].id
    ].snapshot.discourse_state.scene_location == "the-gate"
