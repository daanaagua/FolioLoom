from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from types import SimpleNamespace

import pytest
import yaml

from src.core.v4.context import ContextBuilder
from src.core.v4.database import V4Database
from src.core.v4.models import V4Block
from src.core.v4.narrative_models import (
    DiscourseState,
    NarrativeMemoryCandidate,
    NarrativeSubject,
    SemanticRelation,
)


def _blocks(count: int = 6):
    return [
        V4Block(
            id=f"block-{index}",
            source_edition_id=1,
            chapter_id="ch01" if index < 4 else "ch02",
            chapter_index=0 if index < 4 else 1,
            block_index=index if index < 4 else index - 4,
            global_index=index,
            block_type="prose",
            source_text=f"Source {index}.",
            source_hash=f"hash-{index}",
            token_count=2,
            status="ready",
        )
        for index in range(count)
    ]


def test_high_volatility_forces_single_worker_and_small_island():
    from src.core.v4.narrative_scheduler import (
        NarrativeScheduler,
        NarrativeSignals,
    )

    plan = NarrativeScheduler(max_workers=8).plan(
        NarrativeSignals(
            global_index=4,
            viewpoint_shift=True,
            unresolved_references=4,
            high_impact_memories=1,
        )
    )

    assert plan.volatility >= 65
    assert plan.workers == 1
    assert 1 <= plan.island_size <= 2
    assert "viewpoint_shift" in plan.reasons


def test_medium_and_low_volatility_restore_parallelism():
    from src.core.v4.narrative_scheduler import (
        NarrativeScheduler,
        NarrativeSignals,
    )

    scheduler = NarrativeScheduler(max_workers=8)
    medium = scheduler.plan(
        NarrativeSignals(
            global_index=1,
            location_shift=True,
            new_subjects=2,
        )
    )
    low = scheduler.plan(NarrativeSignals(global_index=2))

    assert 35 <= medium.volatility < 65
    assert medium.workers == 2
    assert 2 <= medium.island_size <= 3
    assert low.volatility < 35
    assert low.workers == 4
    assert 3 <= low.island_size <= 5


def test_dynamic_islands_never_cross_chapter_or_reveal_boundary():
    from src.core.v4.narrative_scheduler import NarrativeScheduler

    islands = NarrativeScheduler().make_islands(
        _blocks(),
        island_size=4,
        boundary_indexes={2},
    )
    indexes = [[block.global_index for block in island.blocks] for island in islands]

    assert indexes == [[0, 1], [2, 3], [4, 5]]


def test_noncontiguous_blocks_start_new_dynamic_island():
    from src.core.v4.narrative_scheduler import NarrativeScheduler

    blocks = _blocks()
    islands = NarrativeScheduler().make_islands(
        [blocks[0], blocks[1], blocks[3]],
        island_size=4,
    )

    assert [
        [block.global_index for block in island.blocks] for island in islands
    ] == [[0, 1], [3]]


def test_provisional_subjects_include_all_prior_discourse_layers(tmp_path):
    from src.core.v4.pipeline import V4TranslationPipeline

    database = V4Database(tmp_path / "book")
    pipeline = V4TranslationPipeline(database, lambda: object())
    block = _blocks(1)[0]

    subjects = pipeline._provisional_subjects(
        block,
        DiscourseState(
            narrator_layer="layer-narrator",
            scene_time="time-night",
            presentation_layer="layer-dream",
        ),
    )

    assert {subject["id"] for subject in subjects} >= {
        "layer-narrator",
        "time-night",
        "layer-dream",
    }
    assert all(subject["subject_type"] for subject in subjects)


def test_status_and_quality_report_include_narrative_metrics(tmp_path):
    from src.core.v4.exporter import ParallelV4BookExporter

    database = V4Database(tmp_path / "book")
    status = database.status_summary()

    assert {
        "premap_cursor",
        "translation_cursor",
        "memory_version",
        "premap_cache_hit_rate",
        "degraded_premap_blocks",
        "unresolved_narrative_references",
        "disputed_narrative_memories",
        "memory_revalidation_tasks",
    } <= status.keys()
    exporter = ParallelV4BookExporter(
        SimpleNamespace(root_dir=tmp_path / "book"),
        database=database,
    )
    report = exporter.build_quality_report()
    assert "narrative_memory" in report
    assert "dynamic_scheduling" in report


def test_context_includes_semantics_memory_discourse_and_exact_dependencies(
    tmp_path,
):
    from src.core.v4.narrative_memory import NarrativeMemoryStore

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "Tecla answers him."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "block-context",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 3,
                "status": "ready",
            }
        ],
    )
    block = database.list_blocks()[0]
    store = NarrativeMemoryStore(database)
    memory_id = store.merge_candidates(
        block,
        [
            NarrativeMemoryCandidate(
                candidate_id="M1",
                memory_type="character_state",
                statement="Tecla is the active speaker.",
                truth_status="observed",
                visibility="reader_visible",
                confidence=0.9,
                evidence_spans=("Tecla answers",),
                subjects=(
                    NarrativeSubject("concept", "concept-tecla", "speaker"),
                ),
            )
        ],
    ).memory_ids[0]
    discourse = DiscourseState(
        viewpoint_holder="concept-severian",
        active_speakers=("concept-tecla",),
        addressed_parties=("concept-severian",),
        state_confidence=0.8,
    )
    snapshot = store.build_snapshot(
        block,
        knowledge_version=database.current_knowledge_version(),
        discourse_state=discourse,
    )
    retrieval = store.retrieve_for_block(
        block,
        snapshot,
        matched_subject_ids=("concept-tecla",),
        max_chars=4_000,
    )
    relations = (
        SemanticRelation(
            relation_type="referential_link",
            inference_strength="explicit",
            source_spans=("Tecla", "him"),
            translation_constraint="保留说话者和受话者关系。",
        ),
    )

    packet = ContextBuilder(database).build(
        block,
        narrative_snapshot=snapshot,
        narrative_retrieval=retrieval,
        semantic_relations=relations,
        source_structure={"block_type": "prose"},
        style_snapshot={
            "id": "style-1",
            "state": {"register": "formal"},
        },
    )

    assert packet.rendered.index("<semantic_relations>") < packet.rendered.index(
        "<narrative_memory>"
    )
    assert packet.rendered.index("<narrative_memory>") < packet.rendered.index(
        "<discourse_state>"
    )
    assert packet.matched_memory_ids == [memory_id]
    assert packet.memory_version == snapshot.memory_version
    assert packet.snapshot_id == snapshot.id
    assert packet.style_snapshot_id == "style-1"
    assert packet.discourse_state_hash
    assert packet.context_hash


def test_narrative_context_overflow_commits_without_claiming_snapshot_use(
    tmp_path,
):
    from src.core.v4.models import Island, V4BlockStatus
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.pipeline import V4TranslationPipeline

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": "overflow-block",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": "A required narrative context is too large.",
                "source_hash": "overflow-source-hash",
                "token_count": 8,
                "status": "ready",
            }
        ],
    )
    block = database.list_blocks()[0]
    snapshot = NarrativeMemoryStore(database).build_snapshot(
        block,
        knowledge_version=database.current_knowledge_version(),
        discourse_state=DiscourseState(viewpoint_holder="narrator"),
    )
    pipeline = V4TranslationPipeline(database, lambda: object())
    pipeline._active_narrative_contexts = {
        block.id: SimpleNamespace(
            snapshot=snapshot,
            error="required narrative context exceeds budget",
        )
    }

    outcome = pipeline._translate_island(
        Island(id="overflow-island", blocks=[block]),
        database.current_knowledge_version(),
    )[0]

    assert outcome.status == V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value
    assert outcome.snapshot_id == ""
    assert outcome.context_hash == ""
    assert outcome.discourse_state_hash == ""
    run_id = "overflow-run"
    database.start_run(run_id, "translate", {})
    database.commit_translation_batch(run_id, [outcome])
    assert database.active_translations("parallel_v4")[block.id]["status"] == (
        V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value
    )


def test_translation_supplemental_memory_requires_current_english_evidence():
    from src.core.translator import TranslationEngine

    values = [
        {
            "candidate_id": "valid",
            "memory_type": "observation",
            "statement": "The gate appears locked.",
            "truth_status": "observed",
            "visibility": "reader_visible",
            "confidence": 0.5,
            "evidence_spans": ["The gate is locked"],
            "subjects": [],
            "related_memory_ids": [],
            "state_operation": "append",
            "high_impact": False,
        },
        {
            "candidate_id": "invalid",
            "memory_type": "observation",
            "statement": "A Chinese-only inference.",
            "truth_status": "inferred",
            "visibility": "reader_visible",
            "confidence": 0.5,
            "evidence_spans": ["中文措辞"],
            "subjects": [],
            "related_memory_ids": [],
            "state_operation": "append",
            "high_impact": False,
        },
    ]

    accepted = TranslationEngine._validated_supplemental_memory(
        values,
        "The gate is locked.",
    )

    assert [item["candidate_id"] for item in accepted] == ["valid"]


def test_xml_parser_reads_supplemental_memory_and_style_delta():
    from src.core.translator import TranslationEngine

    engine = TranslationEngine.__new__(TranslationEngine)
    parsed = engine._parse_xml_response(
        """
        <response>
          <translation>门锁着。</translation>
          <supplemental_memory>
            <memory candidate_id="M1" memory_type="observation"
                    statement="The gate appears locked."
                    truth_status="observed" visibility="reader_visible"
                    confidence="0.5" evidence="The gate is locked" />
          </supplemental_memory>
          <style_delta register="formal" />
        </response>
        """
    )

    assert parsed["supplemental_memory_candidates"][0]["candidate_id"] == "M1"
    assert parsed["style_delta"] == {"register": "formal"}


def test_draft_prompt_requests_bounded_memory_and_style_outputs():
    from pathlib import Path

    prompts = yaml.safe_load(
        (
            Path(__file__).resolve().parents[1]
            / "config"
            / "prompts.yaml"
        ).read_text(encoding="utf-8")
    )
    draft = prompts["draft"]["system"]

    assert "<supplemental_memory>" in draft
    assert "<style_delta" in draft
    assert "只允许引用当前英文原文中的证据" in draft


def test_translator_imports_in_a_fresh_interpreter_without_package_cycle():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from src.core.translator import TranslationEngine; "
            "print(TranslationEngine.__name__)",
        ],
        cwd=str(__import__("pathlib").Path(__file__).resolve().parents[1]),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "TranslationEngine"


def test_pipeline_premaps_ahead_and_reuses_cached_snapshot_chain(tmp_path):
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class NarrativeLLM:
        def __init__(self):
            self.counts = {}

        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, messages, purpose="draft", stream=False, **_kwargs):
            self.counts[purpose] = self.counts.get(purpose, 0) + 1
            if purpose == "narrative_premap":
                request = json.loads(messages[1]["content"])
                source = request["current_source"]
                payload = json.dumps(
                    {
                        "semantic_relations": [],
                        "memory_candidates": [
                            {
                                "candidate_id": f"M-{hashlib.sha1(source.encode()).hexdigest()[:8]}",
                                "memory_type": "observation",
                                "statement": f"Observed: {source}",
                                "truth_status": "observed",
                                "visibility": "reader_visible",
                                "confidence": 0.6,
                                "subjects": [],
                                "related_memory_ids": [],
                                "evidence_spans": [source],
                                "state_operation": "append",
                                "high_impact": False,
                            }
                        ],
                        "discourse_delta": {"state_confidence": 0.6},
                    }
                )
                return payload
            source = messages[-1]["content"].split(
                "<text_to_translate>\n", 1
            )[-1].split("\n</text_to_translate>", 1)[0]
            payload = json.dumps(
                {
                    "analysis": "保持原文信息。",
                    "translation": f"完整译文：{source}",
                    "memory_summary": "继续。",
                    "new_terms": [],
                    "relations": [],
                    "supplemental_memory_candidates": [],
                    "style_delta": {},
                },
                ensure_ascii=False,
            )

            def generator():
                yield ("content", payload)

            return generator() if stream else payload

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"pipeline-block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": f"Source sentence {index}.",
                "source_hash": f"source-hash-{index}",
                "token_count": 3,
                "status": "ready",
            }
            for index in range(3)
        ],
    )
    llm = NarrativeLLM()
    config = V4PipelineConfig(
        enable_polish=False,
        enable_narrative_premap=True,
        dynamic_scheduling=True,
        premap_ahead_blocks=3,
        max_blocks=3,
        initial_workers=2,
        max_workers=4,
    )

    first = V4TranslationPipeline(
        database,
        llm_factory=lambda: llm,
        config=config,
    ).run()
    first_premap_calls = llm.counts.get("narrative_premap", 0)
    second = V4TranslationPipeline(
        database,
        llm_factory=lambda: llm,
        config=V4PipelineConfig(
            **{
                **config.__dict__,
                "force": True,
            }
        ),
    ).run()

    assert first["completed"] == 3
    assert first["premap_cursor"] >= first["translation_cursor"] == 2
    assert first_premap_calls == 3
    assert llm.counts.get("narrative_premap", 0) == first_premap_calls
    assert second["completed"] == 3
    with database.connect() as connection:
        translation = connection.execute(
            """SELECT id, memory_version, snapshot_id, context_hash,
                      discourse_state_hash
               FROM translation_versions
               WHERE block_id='pipeline-block-0'
                 AND pipeline='parallel_v4' AND active=1"""
        ).fetchone()
        dependencies = {
            str(row["dependency_type"])
            for row in connection.execute(
                "SELECT dependency_type FROM dependencies WHERE translation_id=?",
                (translation["id"],),
            )
        }
    assert translation["memory_version"] is not None
    assert translation["snapshot_id"]
    assert translation["context_hash"]
    assert translation["discourse_state_hash"]
    assert {
        "narrative_memory",
        "narrative_snapshot",
        "discourse_state",
    } <= dependencies


def test_public_premap_and_memory_inspection_reuse_cache(tmp_path):
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class PremapOnlyLLM:
        def __init__(self):
            self.calls = 0

        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, purpose, **_kwargs):
            assert purpose == "narrative_premap"
            self.calls += 1
            return json.dumps(
                {
                        "semantic_relations": [],
                        "memory_candidates": [],
                        "discourse_delta": {
                            "narrator_layer": "test-narrator",
                            "state_confidence": 0.5,
                        },
                }
            )

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    rows = []
    for index in range(2):
        source = f"Premap sentence {index}."
        rows.append(
            {
                "id": f"premap-only-{index}",
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
    database.upsert_blocks(edition, rows)
    llm = PremapOnlyLLM()
    config = V4PipelineConfig(enable_narrative_premap=True)

    first = V4TranslationPipeline(
        database, lambda: llm, config=config
    ).premap(max_blocks=2)
    second = V4TranslationPipeline(
        database, lambda: llm, config=config
    ).premap(max_blocks=2)
    inspected = database.inspect_narrative_memory(
        block_id="premap-only-1",
        subject_id=None,
        memory_type=None,
    )

    assert first["premapped"] == second["premapped"] == 2
    assert first["premap_model_calls"] == 2
    assert second["premap_cache_hits"] == 2
    assert llm.calls == 2
    assert inspected["snapshots"][0]["block_id"] == "premap-only-1"


def test_style_delta_is_persisted_and_available_to_next_wave(tmp_path):
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class StyleLLM:
        def __init__(self):
            self.draft_saw_formal = []
            self.premap_calls = 0

        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, messages, purpose="draft", stream=False, **_kwargs):
            if purpose == "narrative_premap":
                self.premap_calls += 1
                return json.dumps(
                    {
                        "semantic_relations": [],
                        "memory_candidates": (
                            [
                                {
                                    "candidate_id": "M-style-boundary",
                                    "memory_type": "contradiction",
                                    "statement": "The presentation layer changes.",
                                    "truth_status": "observed",
                                    "visibility": "reader_visible",
                                    "confidence": 0.8,
                                    "evidence_spans": [
                                        "Style sentence 0."
                                    ],
                                    "subjects": [],
                                    "related_memory_ids": [],
                                    "state_operation": "append",
                                    "high_impact": True,
                                }
                            ]
                            if self.premap_calls == 1
                            else []
                        ),
                        "discourse_delta": (
                            {
                                "narrator_layer": "narrator-a",
                                "presentation_layer": "layer-a",
                                "scene_time": "later",
                            }
                            if self.premap_calls == 1
                            else {}
                        ),
                    }
                )
            joined = "\n".join(str(item["content"]) for item in messages)
            self.draft_saw_formal.append("formal" in joined)
            style = (
                {"register": "formal"}
                if len(self.draft_saw_formal) == 1
                else {}
            )
            payload = json.dumps(
                {
                    "analysis": "",
                    "translation": "译文。",
                    "memory_summary": "",
                    "new_terms": [],
                    "relations": [],
                    "supplemental_memory_candidates": [],
                    "style_delta": style,
                }
            )

            def generator():
                yield ("content", payload)

            return generator() if stream else payload

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    rows = []
    for index in range(2):
        source = f"Style sentence {index}."
        rows.append(
            {
                "id": f"style-block-{index}",
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
    database.upsert_blocks(edition, rows)
    llm = StyleLLM()

    result = V4TranslationPipeline(
        database,
        lambda: llm,
        config=V4PipelineConfig(
            enable_narrative_premap=True,
            enable_polish=False,
            island_size=1,
            initial_workers=1,
            max_workers=1,
            premap_ahead_blocks=2,
        ),
    ).run()

    assert result["completed"] == 2
    assert llm.draft_saw_formal == [False, True]
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM style_snapshots"
        ).fetchone()[0] == 1
        style_snapshot_id = connection.execute(
            """SELECT style_snapshot_id FROM translation_versions
               WHERE block_id='style-block-1' AND active=1"""
        ).fetchone()[0]
    assert style_snapshot_id


def test_rebuild_snapshots_preserves_premap_cache_provenance(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class PremapLLM:
        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, purpose="draft", **_kwargs):
            assert purpose == "narrative_premap"
            return json.dumps(
                {
                    "semantic_relations": [],
                    "memory_candidates": [],
                    "discourse_delta": {},
                }
            )

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"rebuild-block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": f"Rebuild sentence {index}.",
                "source_hash": hashlib.sha256(
                    f"Rebuild sentence {index}.".encode()
                ).hexdigest(),
                "token_count": 3,
                "status": "ready",
            }
            for index in range(2)
        ],
    )
    config = V4PipelineConfig(enable_narrative_premap=True)
    V4TranslationPipeline(
        database, PremapLLM, config=config
    ).premap(max_blocks=2)
    with database.connect() as connection:
        before = [
            tuple(row)
            for row in connection.execute(
                """SELECT cache_key, snapshot_id, prior_snapshot_hash
                   FROM premap_results ORDER BY block_id"""
            ).fetchall()
        ]

    store = NarrativeMemoryStore(database)
    first_block = database.list_blocks()[0]
    store.merge_candidates(
        first_block,
        [
            NarrativeMemoryCandidate(
                candidate_id="rebuild-memory",
                memory_type="explicit_fact",
                statement="A new visible fact exists.",
                truth_status="observed",
                visibility="reader_visible",
                confidence=0.9,
                evidence_spans=(first_block.source_text,),
                subjects=(),
            )
        ],
        source="test",
    )
    V4TranslationPipeline(
        database, PremapLLM, config=config
    ).rebuild_snapshots(from_index=0)

    with database.connect() as connection:
        after = [
            tuple(row)
            for row in connection.execute(
                """SELECT cache_key, snapshot_id, prior_snapshot_hash
                   FROM premap_results ORDER BY block_id"""
            ).fetchall()
        ]
    assert after == before
    for _, snapshot_id, prior_snapshot_hash in after:
        snapshot = store.load_snapshot(snapshot_id)
        assert snapshot is not None
        previous = (
            store.load_snapshot(snapshot.previous_snapshot_id)
            if snapshot.previous_snapshot_id
            else None
        )
        assert prior_snapshot_hash == (
            previous.snapshot_hash if previous is not None else ""
        )
    rerun = V4TranslationPipeline(
        database, PremapLLM, config=config
    ).premap(max_blocks=2)
    assert rerun["premap_cache_hits"] == 1
    assert rerun["premap_model_calls"] == 1


def test_partial_run_does_not_seed_style_from_future_block(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"style-future-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": f"Style future sentence {index}.",
                "source_hash": hashlib.sha256(
                    f"Style future sentence {index}.".encode()
                ).hexdigest(),
                "token_count": 4,
                "status": "ready",
            }
            for index in range(2)
        ],
    )
    blocks = database.list_blocks()
    NarrativeMemoryStore(database).merge_style_delta(
        blocks[1],
        {"register": "future-formal"},
        previous_snapshot_id="",
    )
    pipeline = V4TranslationPipeline(
        database,
        lambda: object(),
        config=V4PipelineConfig(
            enable_narrative_premap=True,
            include_block_ids=(blocks[0].id,),
        ),
    )
    captured = {}

    def capture_run(candidates, **_kwargs):
        captured["tail"] = pipeline._style_tail_snapshot
        return {"status": "captured", "candidate_count": len(candidates)}

    pipeline._run_narrative = capture_run
    result = pipeline.run()

    assert result["candidate_count"] == 1
    assert captured["tail"] is None


def test_retranslation_does_not_use_style_from_future_block(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"style-retranslate-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": f"Style retranslate sentence {index}.",
                "source_hash": hashlib.sha256(
                    f"Style retranslate sentence {index}.".encode()
                ).hexdigest(),
                "token_count": 4,
                "status": "ready",
            }
            for index in range(2)
        ],
    )
    blocks = database.list_blocks()
    NarrativeMemoryStore(database).merge_style_delta(
        blocks[1],
        {"register": "future-formal"},
        previous_snapshot_id="",
    )
    pipeline = V4TranslationPipeline(
        database,
        lambda: object(),
        config=V4PipelineConfig(enable_narrative_premap=False),
    )
    captured = {}

    def capture_island(island, *_args, **_kwargs):
        captured.update(pipeline._active_style_snapshots)
        return [SimpleNamespace(block=island.blocks[0])]

    pipeline._translate_island = capture_island
    pipeline.translate_block_factory()(blocks[0])

    assert captured == {}


def test_resumed_run_seeds_premap_from_last_committed_prefix(tmp_path):
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class PremapLLM:
        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, purpose="draft", **_kwargs):
            assert purpose == "narrative_premap"
            return json.dumps(
                {
                    "semantic_relations": [],
                    "memory_candidates": [],
                    "discourse_delta": {
                        "scene_time": "remembered-prefix",
                    },
                }
            )

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"resume-block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": f"Resume sentence {index}.",
                "source_hash": hashlib.sha256(
                    f"Resume sentence {index}.".encode()
                ).hexdigest(),
                "token_count": 3,
                "status": "ready",
            }
            for index in range(3)
        ],
    )
    config = V4PipelineConfig(enable_narrative_premap=True)
    V4TranslationPipeline(
        database, PremapLLM, config=config
    ).premap(max_blocks=2)
    with database.transaction() as connection:
        connection.execute(
            """UPDATE blocks SET status='completed'
               WHERE global_index<2"""
        )

    pipeline = V4TranslationPipeline(
        database, PremapLLM, config=config
    )
    captured = {}

    def capture_run(candidates, **_kwargs):
        captured["snapshot"] = pipeline._premap_tail_snapshot
        captured["state"] = pipeline._premap_tail_state
        return {"status": "captured", "candidate_count": len(candidates)}

    pipeline._run_narrative = capture_run
    result = pipeline.run()

    assert result["candidate_count"] == 1
    assert captured["snapshot"] is not None
    assert captured["snapshot"].global_index == 1
    assert captured["state"].scene_time == "remembered-prefix"


def test_fresh_noncontiguous_selection_premaps_the_missing_prefix(tmp_path):
    from src.core.v4.narrative_memory import NarrativeMemoryStore
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class SelectionLLM:
        def __init__(self):
            self.premap_calls = 0

        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, purpose="draft", stream=False, **_kwargs):
            if purpose == "narrative_premap":
                self.premap_calls += 1
                return json.dumps(
                    {
                        "semantic_relations": [],
                        "memory_candidates": [],
                        "discourse_delta": {},
                    }
                )
            payload = json.dumps(
                {
                    "analysis": "",
                    "translation": "选中块译文。",
                    "memory_summary": "",
                    "new_terms": [],
                    "relations": [],
                    "supplemental_memory_candidates": [],
                    "style_delta": {},
                },
                ensure_ascii=False,
            )

            def generator():
                yield ("content", payload)

            return generator() if stream else payload

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"selected-prefix-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": f"Selected sentence {index}.",
                "source_hash": hashlib.sha256(
                    f"Selected sentence {index}.".encode()
                ).hexdigest(),
                "token_count": 3,
                "status": "ready",
            }
            for index in range(3)
        ],
    )
    blocks = database.list_blocks()
    llm = SelectionLLM()
    result = V4TranslationPipeline(
        database,
        lambda: llm,
        config=V4PipelineConfig(
            enable_narrative_premap=True,
            enable_polish=False,
            include_block_ids=(blocks[2].id,),
            initial_workers=1,
            max_workers=1,
        ),
    ).run()

    assert result["completed"] == 1
    assert llm.premap_calls == 3
    snapshot = NarrativeMemoryStore(database).latest_snapshot_for_block(
        blocks[2].id
    )
    assert snapshot is not None
    previous = NarrativeMemoryStore(database).load_snapshot(
        snapshot.previous_snapshot_id
    )
    assert previous is not None
    assert previous.global_index == 1


def test_failed_epoch_checkpoint_rolls_back_entire_translation_wave(
    tmp_path, monkeypatch
):
    from src.core.v4.knowledge_epochs import KnowledgeEpochCoordinator
    from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline

    class AtomicWaveLLM:
        def get_model(self, purpose):
            return f"fake-{purpose}"

        def chat(self, *, purpose="draft", stream=False, **_kwargs):
            if purpose == "narrative_premap":
                return json.dumps(
                    {
                        "semantic_relations": [],
                        "memory_candidates": [],
                        "discourse_delta": {},
                    }
                )
            payload = json.dumps(
                {
                    "analysis": "",
                    "translation": "原子波次译文。",
                    "memory_summary": "",
                    "new_terms": [],
                    "relations": [],
                    "supplemental_memory_candidates": [
                        {
                            "candidate_id": "atomic-memory",
                            "memory_type": "observation",
                            "statement": "The atomic sentence exists.",
                            "truth_status": "observed",
                            "visibility": "reader_visible",
                            "confidence": 0.7,
                            "evidence_spans": ["Atomic source sentence."],
                            "subjects": [],
                            "related_memory_ids": [],
                            "state_operation": "append",
                            "high_impact": False,
                        }
                    ],
                    "style_delta": {"register": "formal"},
                },
                ensure_ascii=False,
            )

            def generator():
                yield ("content", payload)

            return generator() if stream else payload

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "Atomic source sentence."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "atomic-wave-block",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 3,
                "status": "ready",
            }
        ],
    )
    initial_memory_version = database.status_summary()["memory_version"]
    original = KnowledgeEpochCoordinator.checkpoint_in_transaction

    def fail_after_checkpoint(self, run_id, connection):
        result = original(self, run_id, connection)
        assert self.narrative_store.current_memory_version(
            connection
        ) > initial_memory_version
        raise RuntimeError("injected checkpoint failure")

    monkeypatch.setattr(
        KnowledgeEpochCoordinator,
        "checkpoint_in_transaction",
        fail_after_checkpoint,
    )

    with pytest.raises(RuntimeError, match="injected checkpoint failure"):
        V4TranslationPipeline(
            database,
            AtomicWaveLLM,
            config=V4PipelineConfig(
                enable_narrative_premap=True,
                enable_polish=False,
                initial_workers=1,
                max_workers=1,
            ),
        ).run()

    with database.connect() as connection:
        assert connection.execute(
            """SELECT COUNT(*) FROM translation_versions
               WHERE active=1"""
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM narrative_memories"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM style_snapshots"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT status FROM blocks WHERE id='atomic-wave-block'"
        ).fetchone()[0] == "ready"
    assert database.status_summary()["memory_version"] == (
        initial_memory_version
    )


def test_knowledge_checkpoint_merges_supplemental_memory_once(tmp_path):
    from src.core.v4.knowledge_epochs import KnowledgeEpochCoordinator
    from src.core.v4.models import TranslationOutcome, V4BlockStatus

    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "The gate remains locked."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "memory-proposal-block",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 4,
                "status": "ready",
            }
        ],
    )
    block = database.list_blocks()[0]
    run_id = "memory-epoch-run"
    database.start_run(run_id, "translate", {"knowledge_epoch_mode": True})
    coordinator = KnowledgeEpochCoordinator(
        database,
        [block.id],
        max_knowledge_epochs=3,
    )
    initial = coordinator.freeze()
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=initial.knowledge_version,
        memory_version=initial.memory_version,
        status=V4BlockStatus.COMPLETED.value,
        supplemental_memory_candidates=[
            {
                "candidate_id": "supplemental-1",
                "memory_type": "observation",
                "statement": "The gate remains locked.",
                "truth_status": "observed",
                "visibility": "reader_visible",
                "confidence": 0.4,
                "evidence_spans": [source],
                "subjects": [],
                "related_memory_ids": [],
                "state_operation": "append",
                "high_impact": False,
            }
        ],
    )

    assert coordinator.stage(run_id, [outcome]) == 1
    first = coordinator.checkpoint(run_id)
    second = coordinator.checkpoint(run_id)

    assert first.epoch.memory_version > initial.memory_version
    assert second.reused is True
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM narrative_memories"
        ).fetchone()[0] == 1
