from __future__ import annotations

import hashlib

import pytest

from src.core.v4.database import V4Database
from src.core.v4.narrative_models import (
    DiscourseState,
    NarrativeMemoryCandidate,
    NarrativePremapResult,
    NarrativeSubject,
)


def _seed_database(tmp_path, count: int = 7):
    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    rows = []
    for index in range(count):
        source = (
            "The gate is locked."
            if index == 0
            else "Tecla speaks." if index == 1 else f"He waits at place {index}."
        )
        rows.append(
            {
                "id": f"block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                "token_count": len(source.split()),
                "status": "ready",
            }
        )
    database.upsert_blocks(edition, rows)
    return database, database.list_blocks()


def _fact(
    *,
    candidate_id: str = "M1",
    statement: str = "The gate is locked.",
    evidence: str = "The gate is locked",
    subjects=(),
    memory_type: str = "explicit_fact",
    related=(),
    operation: str = "append",
    visibility: str = "reader_visible",
    high_impact: bool = False,
):
    return NarrativeMemoryCandidate(
        candidate_id=candidate_id,
        memory_type=memory_type,
        statement=statement,
        truth_status="asserted",
        visibility=visibility,
        confidence=0.9,
        evidence_spans=(evidence,),
        subjects=tuple(subjects),
        related_memory_ids=tuple(related),
        state_operation=operation,
        high_impact=high_impact,
    )


def test_premap_cache_key_is_stable_and_result_is_reused(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    key = store.premap_cache_key(
        block=blocks[0],
        structure_hash="structure",
        prompt_hash="prompt",
        model_id="deepseek-v4-flash",
        parameters_hash="parameters",
        prior_snapshot_hash="before",
        provisional_subject_hash="subjects",
    )
    result = NarrativePremapResult(
        semantic_relations=(),
        memory_candidates=(_fact(),),
        discourse_delta=DiscourseState(),
    )

    first_id = store.save_premap_result(
        cache_key=key,
        block=blocks[0],
        result=result,
        model_id="deepseek-v4-flash",
        prompt_hash="prompt",
        prior_snapshot_hash="before",
        request_hash="request",
        response_hash="response",
    )
    second_id = store.save_premap_result(
        cache_key=key,
        block=blocks[0],
        result=result,
        model_id="deepseek-v4-flash",
        prompt_hash="prompt",
        prior_snapshot_hash="before",
        request_hash="request",
        response_hash="response",
    )

    assert first_id == second_id
    loaded = store.load_premap_result(key)
    assert loaded is not None
    assert loaded.memory_candidates[0].statement == "The gate is locked."
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM premap_results"
        ).fetchone()[0] == 1


def test_memory_merge_is_idempotent_and_append_only(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)

    first = store.merge_candidates(blocks[0], [_fact()])
    duplicate = store.merge_candidates(blocks[0], [_fact()])

    assert duplicate.memory_ids == first.memory_ids
    assert duplicate.memory_version == first.memory_version
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM narrative_memories"
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM memory_versions"
        ).fetchone()[0] == 2


def test_contradiction_candidate_preserves_both_memories_and_links_them(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    first = store.merge_candidates(blocks[0], [_fact()])
    first_id = first.memory_ids[0]

    second = store.merge_candidates(
        blocks[0],
        [
            _fact(
                candidate_id="M2",
                statement="The description conflicts with the locked gate.",
                memory_type="contradiction",
                related=(first_id,),
            )
        ],
    )

    assert second.memory_ids[0] != first_id
    assert store.links_for_memory(second.memory_ids[0]) == [
        {
            "to_memory_id": first_id,
            "relation": "contradicts",
        }
    ]


def test_snapshot_excludes_future_and_system_private_memories(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    past = store.merge_candidates(blocks[0], [_fact()]).memory_ids[0]
    private = store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-private",
                statement="Private hypothesis.",
                evidence="Tecla speaks",
                memory_type="hypothesis",
                visibility="system_private",
            )
        ],
    ).memory_ids[0]
    future = store.merge_candidates(
        blocks[6],
        [
            _fact(
                candidate_id="M-future",
                statement="A future location is known.",
                evidence="He waits at place 6",
                memory_type="location_state",
            )
        ],
    ).memory_ids[0]

    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(),
    )

    assert past in snapshot.visible_memory_ids
    assert private not in snapshot.visible_memory_ids
    assert future not in snapshot.visible_memory_ids


def test_retrieval_uses_active_speaker_without_keyword_match(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    tecla = NarrativeSubject("concept", "concept-tecla", "character")
    memory_id = store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-tecla",
                statement="Tecla is speaking.",
                evidence="Tecla speaks",
                memory_type="character_state",
                subjects=(tecla,),
            )
        ],
    ).memory_ids[0]
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(
            active_speakers=("concept-tecla",),
            state_confidence=0.8,
        ),
    )

    retrieval = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        max_chars=4_000,
    )

    assert memory_id in {memory.id for memory in retrieval.memories}


def test_required_memory_over_budget_returns_manual_boundary(tmp_path):
    from src.core.v4.narrative_memory import (
        NarrativeContextOverflow,
        NarrativeMemoryStore,
    )

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    subject = NarrativeSubject("concept", "concept-tecla", "character")
    store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-required",
                statement="X" * 500,
                evidence="Tecla speaks",
                memory_type="explicit_fact",
                subjects=(subject,),
                high_impact=True,
            )
        ],
    )
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(active_speakers=("concept-tecla",)),
    )

    with pytest.raises(NarrativeContextOverflow, match="required narrative"):
        store.retrieve_for_block(
            blocks[3],
            snapshot,
            matched_subject_ids=("concept-tecla",),
            max_chars=50,
        )


def test_same_response_duplicate_candidates_are_idempotent(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    candidate = _fact()

    result = store.merge_candidates(blocks[0], [candidate, candidate])

    assert len(set(result.memory_ids)) == 1
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM narrative_memories"
        ).fetchone()[0] == 1


def test_source_hash_change_excludes_stale_memory_from_new_snapshot(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    memory_id = store.merge_candidates(blocks[0], [_fact()]).memory_ids[0]
    edition = blocks[0].source_edition_id
    database.upsert_blocks(
        edition,
        [
            {
                "id": blocks[0].id,
                "legacy_id": blocks[0].legacy_id,
                "chapter_id": blocks[0].chapter_id,
                "chapter_title": "I",
                "chapter_index": blocks[0].chapter_index,
                "block_index": blocks[0].block_index,
                "global_index": blocks[0].global_index,
                "block_type": blocks[0].block_type,
                "source_text": "The gate is open.",
                "source_hash": "changed-source-hash",
                "token_count": 4,
                "status": "ready",
            }
        ],
    )
    refreshed = database.get_block_by_identifier(blocks[0].id)

    snapshot = store.build_snapshot(
        refreshed,
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(),
    )

    assert memory_id not in snapshot.visible_memory_ids


def test_snapshot_prioritizes_old_active_speaker_before_recent_noise(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path, count=514)
    store = NarrativeMemoryStore(database)
    with database.transaction() as connection:
        for index in range(513):
            memory_id = f"memory-{index:04d}"
            connection.execute(
                """INSERT INTO narrative_memories(
                       id, memory_type, statement, truth_status, visibility,
                       confidence, reveal_global_index, source_block_id,
                       source_hash, status, high_impact, semantic_fingerprint,
                       created_memory_version, retired_memory_version, created_at)
                   VALUES(?, 'observation', ?, 'observed', 'reader_visible',
                          0.5, ?, ?, ?, 'provisional', 0, ?, 1, NULL, ?)""",
                (
                    memory_id,
                    f"Noise {index}",
                    index,
                    blocks[index].id,
                    blocks[index].source_hash,
                    f"fingerprint-{index}",
                    "2026-07-16T00:00:00+00:00",
                ),
            )
        connection.execute(
            """INSERT INTO narrative_memory_subjects(
                   memory_id, subject_type, subject_id, role)
               VALUES('memory-0000', 'concept', 'concept-old-speaker', 'speaker')"""
        )

    snapshot = store.build_snapshot(
        blocks[513],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(
            active_speakers=("concept-old-speaker",),
            state_confidence=0.8,
        ),
    )

    assert len(snapshot.visible_memory_ids) == 512
    assert "memory-0000" in snapshot.visible_memory_ids


def test_retrieval_budget_counts_full_subject_rendering(tmp_path):
    from src.core.v4.narrative_memory import (
        NarrativeContextOverflow,
        NarrativeMemoryStore,
    )

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    subjects = tuple(
        NarrativeSubject(
            "concept",
            f"concept-{'x' * 200}-{index}",
            "participant",
        )
        for index in range(16)
    )
    store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-many-subjects",
                statement="Tecla speaks.",
                evidence="Tecla speaks",
                subjects=subjects,
                high_impact=True,
            )
        ],
    )
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(
            active_speakers=(subjects[0].subject_id,),
        ),
    )

    with pytest.raises(NarrativeContextOverflow, match="required narrative"):
        store.retrieve_for_block(
            blocks[3],
            snapshot,
            matched_subject_ids=(subjects[0].subject_id,),
            max_chars=200,
        )


def test_close_question_retires_old_question_from_later_snapshot(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    question_id = store.merge_candidates(
        blocks[0],
        [
            _fact(
                candidate_id="M-question",
                statement="Is the gate locked?",
                memory_type="open_question",
            )
        ],
    ).memory_ids[0]
    store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-answer",
                statement="The question is answered.",
                evidence="Tecla speaks",
                memory_type="explicit_fact",
                related=(question_id,),
                operation="close_question",
            )
        ],
    )

    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(),
    )

    assert question_id not in snapshot.visible_memory_ids
    with database.connect() as connection:
        status, retired = connection.execute(
            """SELECT status, retired_memory_version
               FROM narrative_memories WHERE id=?""",
            (question_id,),
        ).fetchone()
    assert status == "superseded"
    assert retired is not None


def test_unresolved_reference_outweighs_recent_unrelated_memory(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.narrative_models import render_narrative_memory

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    alice_id = store.merge_candidates(
        blocks[0],
        [
            _fact(
                candidate_id="M-alice",
                statement="Alice is waiting.",
                subjects=(
                    NarrativeSubject(
                        "concept", "concept-alice", "character"
                    ),
                ),
            )
        ],
    ).memory_ids[0]
    bell_id = store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-bell",
                statement="A bell is ringing.",
                evidence="Tecla speaks",
            )
        ],
    ).memory_ids[0]
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(
            unresolved_references=("concept-alice",),
        ),
    )
    full = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        max_chars=4_000,
    )
    alice = next(memory for memory in full.memories if memory.id == alice_id)
    one_item_budget = len(
        render_narrative_memory(alice, required=False)
    ) + 1

    selected = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        max_chars=one_item_budget,
    )

    assert [memory.id for memory in selected.memories] == [alice_id]
    assert bell_id not in {memory.id for memory in selected.memories}


def test_semantic_relation_reference_is_required_under_tight_budget(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.narrative_models import render_narrative_memory

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    referenced_id = store.merge_candidates(
        blocks[0],
        [
            _fact(
                candidate_id="M-referenced",
                statement="The old gate was already locked.",
            )
        ],
    ).memory_ids[0]
    unrelated_id = store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-unrelated",
                statement="Tecla speaks.",
                evidence="Tecla speaks",
            )
        ],
    ).memory_ids[0]
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(),
    )
    full = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        semantic_relation_memory_ids=(referenced_id,),
        max_chars=4_000,
    )
    referenced = next(
        memory for memory in full.memories if memory.id == referenced_id
    )
    one_item_budget = len(
        render_narrative_memory(referenced, required=True)
    ) + 1

    selected = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        semantic_relation_memory_ids=(referenced_id,),
        max_chars=one_item_budget,
    )

    assert selected.required_memory_ids == (referenced_id,)
    assert [memory.id for memory in selected.memories] == [referenced_id]
    assert unrelated_id not in {memory.id for memory in selected.memories}


def test_one_hop_relation_outweighs_recent_unrelated_memory(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.narrative_models import render_narrative_memory

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    linked_id = store.merge_candidates(
        blocks[0],
        [
            _fact(
                candidate_id="M-linked",
                statement="The gate is locked.",
            )
        ],
    ).memory_ids[0]
    direct_id = store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-direct",
                statement="Tecla remembers the gate.",
                evidence="Tecla speaks",
                related=(linked_id,),
                operation="relate",
            )
        ],
    ).memory_ids[0]
    unrelated_id = store.merge_candidates(
        blocks[2],
        [
            _fact(
                candidate_id="M-recent",
                statement="He waits at place 2.",
                evidence="He waits at place 2",
            )
        ],
    ).memory_ids[0]
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(),
    )
    full = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        semantic_relation_memory_ids=(direct_id,),
        max_chars=4_000,
    )
    by_id = {memory.id: memory for memory in full.memories}
    budget = (
        len(render_narrative_memory(by_id[direct_id], required=True))
        + len(render_narrative_memory(by_id[linked_id], required=False))
        + 2
    )

    selected = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=(),
        semantic_relation_memory_ids=(direct_id,),
        max_chars=budget,
    )

    assert [memory.id for memory in selected.memories] == [
        direct_id,
        linked_id,
    ]
    assert unrelated_id not in {memory.id for memory in selected.memories}


def test_matched_subject_expands_one_hop_relation_without_semantic_reference(
    tmp_path,
):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.narrative_models import render_narrative_memory

    database, blocks = _seed_database(tmp_path)
    store = NarrativeMemoryStore(database)
    linked_id = store.merge_candidates(
        blocks[0],
        [
            _fact(
                candidate_id="M-linked-subject",
                statement="Alice once guarded the gate.",
            )
        ],
    ).memory_ids[0]
    subject_id = store.merge_candidates(
        blocks[1],
        [
            _fact(
                candidate_id="M-subject",
                statement="Tecla speaks.",
                evidence="Tecla speaks",
                subjects=(
                    NarrativeSubject(
                        "concept", "concept-alice", "character"
                    ),
                ),
                related=(linked_id,),
                operation="relate",
            )
        ],
    ).memory_ids[0]
    unrelated_id = store.merge_candidates(
        blocks[2],
        [
            _fact(
                candidate_id="M-recent-subject",
                statement="He waits at place 2.",
                evidence="He waits at place 2",
            )
        ],
    ).memory_ids[0]
    snapshot = store.build_snapshot(
        blocks[3],
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(),
    )
    full = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=("concept-alice",),
        max_chars=4_000,
    )
    by_id = {memory.id: memory for memory in full.memories}
    budget = (
        len(render_narrative_memory(by_id[subject_id], required=False))
        + len(render_narrative_memory(by_id[linked_id], required=False))
        + 2
    )

    selected = store.retrieve_for_block(
        blocks[3],
        snapshot,
        matched_subject_ids=("concept-alice",),
        max_chars=budget,
    )

    assert [memory.id for memory in selected.memories] == [
        subject_id,
        linked_id,
    ]
    assert unrelated_id not in {memory.id for memory in selected.memories}
