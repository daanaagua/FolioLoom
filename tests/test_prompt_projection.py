from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from src.core.schemas import TermStatus, TextChunk
from src.core.translator import TranslationConfig, TranslationEngine
from src.core.v4.context import ContextBuilder
from src.core.v4.database import V4Database
from src.core.v4.models import ContextPacket
from src.core.v4.models import TranslationOutcome, V4BlockStatus
from src.core.v4.narrative_memory import NarrativeMemoryStore
from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline
from src.core.v4.prompt_projection import (
    PromptBudgetOverflow,
    PromptBudgetPolicy,
    PromptProjector,
    PromptSection,
    StyleAnchorCandidate,
    estimate_tokens,
)


def test_projection_drops_optional_anchor_before_required_semantics():
    policy = PromptBudgetPolicy(draft_soft_tokens=80, reserve_ratio=0.20)
    result = PromptProjector(policy).project(
        stage="draft",
        sections=(
            PromptSection("source", "source", priority=0, required=True),
            PromptSection("semantic", "must keep", priority=0, required=True),
            PromptSection(
                "style_anchor",
                "example " * 200,
                priority=4,
                marginal_utility=0.1,
            ),
        ),
    )

    assert "source" in result.included_section_ids
    assert "semantic" in result.included_section_ids
    assert "style_anchor" in result.dropped_section_ids
    assert result.decisions["style_anchor"].reason == "soft_budget"


def test_projection_is_deterministic_and_audits_each_section():
    sections = (
        PromptSection("source", "alpha", priority=0, required=True),
        PromptSection("tail", "beta", priority=3, marginal_utility=0.4),
        PromptSection("memory", "gamma", priority=2, marginal_utility=0.9),
    )
    projector = PromptProjector(
        PromptBudgetPolicy(draft_soft_tokens=200, reserve_ratio=0.20),
        token_counter=lambda text: len(text),
    )

    first = projector.project(stage="draft", sections=sections)
    second = projector.project(stage="draft", sections=sections)

    assert first == second
    assert first.section_token_estimates == {
        "source": 5,
        "tail": 4,
        "memory": 5,
    }
    assert all(item.stage == "draft" for item in first.decisions.values())


def test_accounting_only_sections_count_tokens_without_entering_user_projection():
    projector = PromptProjector(
        PromptBudgetPolicy(draft_soft_tokens=200, reserve_ratio=0.0),
        token_counter=lambda text: len(text),
    )
    result = projector.project(
        stage="draft",
        sections=(
            PromptSection(
                "system_prompt",
                "SYSTEM-PROTOCOL",
                priority=0,
                required=True,
                render=False,
            ),
            PromptSection("source", "SOURCE", priority=0, required=True),
        ),
    )

    assert result.rendered == "SOURCE"
    assert result.estimated_tokens == len("SYSTEM-PROTOCOL") + len("SOURCE")
    assert result.section_token_estimates["system_prompt"] == len(
        "SYSTEM-PROTOCOL"
    )


def test_projection_raises_manual_overflow_for_required_material_only():
    projector = PromptProjector(
        PromptBudgetPolicy(draft_soft_tokens=10, reserve_ratio=0.20),
        token_counter=lambda text: len(text),
    )

    with pytest.raises(PromptBudgetOverflow) as error:
        projector.project(
            stage="draft",
            sections=(
                PromptSection(
                    "source", "complete source", priority=0, required=True
                ),
            ),
        )

    assert error.value.stage == "draft"
    assert error.value.required_tokens == len("complete source")
    assert "需要人工处理" in str(error.value)


def test_optional_sections_are_selected_by_utility_not_input_order():
    projector = PromptProjector(
        PromptBudgetPolicy(draft_soft_tokens=25, reserve_ratio=0.0),
        token_counter=lambda text: len(text),
    )
    result = projector.project(
        stage="draft",
        sections=(
            PromptSection("source", "12345", priority=0, required=True),
            PromptSection(
                "low", "abcdefghij", priority=2, marginal_utility=0.1
            ),
            PromptSection(
                "high", "ABCDEFGHIJ", priority=3, marginal_utility=0.9
            ),
            PromptSection(
                "middle", "klmnopqrst", priority=1, marginal_utility=0.5
            ),
        ),
    )

    assert result.included_section_ids == ("source", "high", "middle")
    assert result.dropped_section_ids == ("low",)


def test_projection_uses_character_guard_to_drop_optional_sections():
    projector = PromptProjector(
        PromptBudgetPolicy(draft_soft_tokens=1000, reserve_ratio=0.0),
        token_counter=lambda _text: 1,
    )
    result = projector.project(
        stage="draft",
        max_chars=15,
        sections=(
            PromptSection("source", "12345", priority=0, required=True),
            PromptSection(
                "high", "abcdefghij", priority=1, marginal_utility=0.9
            ),
            PromptSection(
                "low", "ABCDEFGHIJ", priority=2, marginal_utility=0.1
            ),
        ),
    )

    assert result.included_section_ids == ("source", "high")
    assert result.dropped_section_ids == ("low",)
    assert result.decisions["low"].reason == "character_guard"


def test_context_builder_trims_large_optional_context_before_char_overflow(
    tmp_path, monkeypatch
):
    database = V4Database(tmp_path / "char-guard-book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "A short source."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "char-guard-block",
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
    monkeypatch.setattr(
        database,
        "concepts_for_text",
        lambda *_args, **_kwargs: [
            {
                "id": "working-large",
                "source": "optional-concept",
                "default_target": "可选概念",
                "target_strength": "working",
                "description": "x" * 3000,
                "term_profile": {},
                "rules": [],
                "primary_lexeme_id": "lex-working-large",
            }
        ],
    )
    monkeypatch.setattr(database, "claims_for_block", lambda _block: [])
    monkeypatch.setattr(
        database, "prior_concept_source_evidence", lambda *_args: []
    )

    packet = ContextBuilder(
        database,
        max_context_chars=800,
        budget_policy=PromptBudgetPolicy(
            draft_soft_tokens=5000,
            polish_soft_tokens=5000,
            reserve_ratio=0.0,
        ),
    ).build(database.list_blocks()[0])

    assert "working_concepts" in packet.dropped_optional_sections
    assert "x" * 100 not in packet.draft_projection.rendered


def _candidate(**overrides) -> StyleAnchorCandidate:
    values = {
        "anchor_id": "anchor-1",
        "source_block_id": "past-block",
        "source_global_index": 3,
        "source_text": "The measured voice remained close to the observer. " * 5,
        "target_text": "克制的声音始终贴近观察者。" * 10,
        "quality_score": 0.95,
        "integrity_passed": True,
        "active": True,
        "fallback": False,
        "text_type": "dialogue",
        "narrative_layer": "first_person",
        "register": "restrained",
        "syntax_features": ("long_sentence", "subordination"),
        "usage_count": 0,
        "parent_anchor_id": "",
        "ancestor_anchor_ids": (),
        "calibration_version": "style-v1",
    }
    values.update(overrides)
    return StyleAnchorCandidate(**values)


def test_style_projection_is_controlled_and_draft_never_gets_anchor():
    projector = PromptProjector(
        PromptBudgetPolicy(style_directive_max_tokens=60)
    )
    material = projector.build_style_material(
        stage="draft",
        style_state={
            "register": "formal",
            "rhythm": "measured",
            "arbitrary_fact": "future spoiler " * 500,
        },
        anchor_candidates=[_candidate()],
        current_global_index=10,
        current_text_type="dialogue",
        current_narrative_layer="first_person",
        current_register="restrained",
        current_syntax_features=("long_sentence", "subordination"),
    )

    assert material.anchor is None
    assert "future spoiler" not in material.directive
    assert "arbitrary_fact" not in material.directive
    assert "\n" not in material.directive
    assert estimate_tokens(material.directive) <= 60


@pytest.mark.parametrize(
    "candidate_overrides",
    [
        {"source_global_index": 10},
        {"quality_score": 0.4},
        {"integrity_passed": False},
        {"active": False},
        {"fallback": True},
        {"text_type": "exposition"},
        {"ancestor_anchor_ids": ("current-parent",)},
    ],
)
def test_polish_anchor_requires_position_quality_type_and_lineage_gates(
    candidate_overrides,
):
    material = PromptProjector(PromptBudgetPolicy()).build_style_material(
        stage="polish",
        style_state={"register": "restrained"},
        anchor_candidates=[_candidate(**candidate_overrides)],
        current_global_index=10,
        current_text_type="dialogue",
        current_narrative_layer="first_person",
        current_register="restrained",
        current_syntax_features=("long_sentence", "subordination"),
        current_lineage_ids=("current-parent",),
        current_source_style_confidence=0.4,
    )

    assert material.anchor is None


def test_polish_selects_one_short_anchor_without_internal_metadata():
    best = _candidate()
    weaker = _candidate(
        anchor_id="anchor-2",
        source_block_id="older-block",
        source_global_index=2,
        quality_score=0.84,
        register="neutral",
        usage_count=3,
    )
    material = PromptProjector(
        PromptBudgetPolicy(style_anchor_max_tokens=300)
    ).build_style_material(
        stage="polish",
        style_state={"register": "restrained", "rhythm": "measured"},
        anchor_candidates=[weaker, best],
        current_global_index=10,
        current_text_type="dialogue",
        current_narrative_layer="first_person",
        current_register="restrained",
        current_syntax_features=("long_sentence", "subordination"),
        current_source_style_confidence=0.4,
    )

    assert material.anchor is not None
    assert material.anchor.anchor_id == "anchor-1"
    assert estimate_tokens(material.anchor.rendered) <= 300
    assert "anchor-1" not in material.anchor.rendered
    assert "0.95" not in material.anchor.rendered
    assert "style-v1" not in material.anchor.rendered


def test_clear_current_source_style_suppresses_anchor():
    material = PromptProjector(PromptBudgetPolicy()).build_style_material(
        stage="polish",
        style_state={"register": "restrained"},
        anchor_candidates=[_candidate()],
        current_global_index=10,
        current_text_type="dialogue",
        current_narrative_layer="first_person",
        current_register="restrained",
        current_syntax_features=("long_sentence", "subordination"),
        current_source_style_confidence=0.95,
    )

    assert material.anchor is None


def test_anchor_is_not_selected_without_comparable_style_dimensions():
    material = PromptProjector(PromptBudgetPolicy()).build_style_material(
        stage="polish",
        style_state={},
        anchor_candidates=[
            _candidate(
                narrative_layer="",
                register="",
                syntax_features=(),
            )
        ],
        current_global_index=10,
        current_text_type="dialogue",
        current_source_style_confidence=0.0,
    )

    assert material.anchor is None


def test_pipeline_uses_current_premap_style_confidence_for_anchor_gate():
    result = SimpleNamespace(
        discourse_delta=SimpleNamespace(
            style_signals=("短句", "口语"),
            state_confidence=0.92,
        )
    )

    assert V4TranslationPipeline._source_style_confidence(result) == 0.92


def test_context_builder_exposes_stage_specific_projections(tmp_path):
    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "The complete source must remain present."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "projection-block",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": "source-hash",
                "token_count": 7,
                "status": "ready",
            }
        ],
    )
    block = database.list_blocks()[0]
    packet = ContextBuilder(
        database,
        budget_policy=PromptBudgetPolicy(
            draft_soft_tokens=1000,
            polish_soft_tokens=1000,
        ),
    ).build(
        block,
        style_snapshot={
            "id": "style-1",
            "state": {
                "register": "formal",
                "arbitrary_fact": "must never enter a prompt",
            },
        },
    )

    assert packet.rendered  # legacy compatibility
    assert source in packet.draft_projection.rendered
    assert source in packet.polish_base_projection.rendered
    assert "arbitrary_fact" not in packet.draft_projection.rendered
    assert "<style_anchor>" not in packet.draft_projection.rendered
    assert packet.section_token_estimates["source"] > 0
    assert packet.dropped_optional_sections == []


class _EmptyGlossary:
    def find_terms_in_text(self, *_args, **_kwargs):
        return []


class _CapturingTranslationLLM:
    def __init__(self):
        self.calls = []

    def chat(self, *, messages, purpose, stream, **_kwargs):
        self.calls.append({"messages": messages, "purpose": purpose})
        if purpose == "draft":
            payload = (
                "<response><analysis></analysis>"
                "<semantic_obligations>保留明确否定。</semantic_obligations>"
                "<translation>这是完整的第一层中文译文。</translation>"
                "<new_terms></new_terms><relations></relations>"
                "<supplemental_memory></supplemental_memory>"
                "<style_delta register=\"formal\" /></response>"
            )
        else:
            payload = "这是完整且自然的第二层中文定稿译文。"

        def generate():
            yield "content", payload

        return generate()


def test_translation_engine_uses_separate_draft_and_polish_projections():
    policy = PromptBudgetPolicy(
        draft_soft_tokens=1000,
        polish_soft_tokens=1000,
        reserve_ratio=0.0,
    )
    projector = PromptProjector(policy)
    source_section = PromptSection(
        "source",
        "<text_to_translate>Alpha is not absent.</text_to_translate>",
        priority=0,
        required=True,
    )
    hard_section = PromptSection(
        "hard_semantics",
        "<hard_semantics>保留明确否定。</hard_semantics>",
        priority=0,
        required=True,
    )
    style_section = PromptSection(
        "style_state",
        "<style_state>风格（非事实）：语域=formal；当前原文优先。</style_state>",
        priority=3,
        marginal_utility=0.8,
    )
    anchor_section = PromptSection(
        "style_anchor",
        "<style_anchor>英文：Past.\n中文：旧日。</style_anchor>",
        priority=4,
        marginal_utility=0.5,
    )
    draft_projection = projector.project(
        stage="draft",
        sections=(source_section, hard_section, style_section),
    )
    polish_base_projection = projector.project(
        stage="polish",
        sections=(source_section, hard_section, style_section, anchor_section),
    )
    packet = ContextPacket(
        block_id="block-1",
        knowledge_version=1,
        rendered="legacy context must not be duplicated",
        required_chars=100,
        draft_projection=draft_projection,
        polish_base_projection=polish_base_projection,
        draft_sections=(source_section, hard_section, style_section),
        polish_sections=(
            source_section,
            hard_section,
            style_section,
            anchor_section,
        ),
    )
    llm = _CapturingTranslationLLM()
    engine = TranslationEngine(
        llm,
        _EmptyGlossary(),
        config=TranslationConfig(
            enable_polish=True,
            strict_response_parsing=True,
            draft_input_soft_tokens=1000,
            polish_input_soft_tokens=1000,
            prompt_reserve_ratio=0.0,
        ),
    )

    result = engine.translate_chunk(
        TextChunk(
            id="block-1",
            chapter_id="ch01",
            index=0,
            source_text="Alpha is not absent.",
            token_count=5,
        ),
        memory_context=packet.rendered,
        prompt_context=packet,
        comparison_reference="",
    )

    assert result.final_translation
    draft_prompt = "\n".join(
        message["content"] for message in llm.calls[0]["messages"]
    )
    polish_prompt = "\n".join(
        message["content"] for message in llm.calls[1]["messages"]
    )
    assert "Alpha is not absent." in draft_prompt
    assert "保留明确否定" in draft_prompt
    assert "<style_anchor>" not in draft_prompt
    assert "legacy context must not be duplicated" not in draft_prompt
    assert "Alpha is not absent." in polish_prompt
    assert "这是完整的第一层中文译文" in polish_prompt
    assert "<style_anchor>" in polish_prompt
    assert packet.polish_projection is not None
    assert packet.polish_projection.section_token_estimates["draft_translation"] > 0
    assert packet.draft_projection.estimated_tokens == sum(
        estimate_tokens(message["content"])
        for message in llm.calls[0]["messages"]
    )
    assert packet.polish_projection.estimated_tokens == sum(
        estimate_tokens(message["content"])
        for message in llm.calls[1]["messages"]
    )


class _WorkingGlossary(_EmptyGlossary):
    def __init__(self):
        self.term = SimpleNamespace(
            src="ultrauniquelexeme",
            default_target="唯一测试译名",
            category="concept",
            description="",
            rules=[],
        )

    def find_terms_in_text(self, _text, *, status_filter):
        return [self.term] if TermStatus.WORKING in status_filter else []


def test_projected_path_does_not_duplicate_glossary_in_system_prompt():
    policy = PromptBudgetPolicy(
        draft_soft_tokens=2000,
        polish_soft_tokens=2000,
        reserve_ratio=0.0,
    )
    projector = PromptProjector(policy)
    source = "The ultrauniquelexeme remained visible."
    source_section = PromptSection(
        "source",
        f"<text_to_translate>{source}</text_to_translate>",
        priority=0,
        required=True,
    )
    working_section = PromptSection(
        "working_concepts",
        "<working_concepts>ultrauniquelexeme -> 唯一测试译名</working_concepts>",
        priority=1,
        marginal_utility=0.8,
    )
    packet = ContextPacket(
        block_id="block-working",
        knowledge_version=1,
        rendered="legacy",
        required_chars=10,
        draft_projection=projector.project(
            stage="draft", sections=(source_section, working_section)
        ),
        polish_base_projection=projector.project(
            stage="polish", sections=(source_section, working_section)
        ),
        draft_sections=(source_section, working_section),
        polish_sections=(source_section, working_section),
    )
    llm = _CapturingTranslationLLM()
    engine = TranslationEngine(
        llm,
        _WorkingGlossary(),
        config=TranslationConfig(
            enable_polish=True,
            strict_response_parsing=True,
            draft_input_soft_tokens=2000,
            polish_input_soft_tokens=2000,
            prompt_reserve_ratio=0.0,
        ),
    )

    result = engine.translate_chunk(
        TextChunk(
            id="block-working",
            chapter_id="ch01",
            index=0,
            source_text=source,
            token_count=5,
        ),
        prompt_context=packet,
    )

    assert result.final_translation
    for call in llm.calls:
        complete_prompt = "\n".join(
            message["content"] for message in call["messages"]
        )
        assert complete_prompt.count("ultrauniquelexeme") == 2


class _PipelineProjectionLLM:
    def __init__(self):
        self.calls = []

    def get_model(self, purpose):
        return f"fake-{purpose}"

    def chat(self, *, messages, purpose, stream=False, **_kwargs):
        self.calls.append({"purpose": purpose, "messages": messages})
        if purpose == "draft":
            payload = (
                "<response><analysis></analysis>"
                "<semantic_obligations>无</semantic_obligations>"
                "<translation>第一层完整译文。</translation>"
                "<new_terms></new_terms><relations></relations>"
                "<supplemental_memory></supplemental_memory>"
                "<style_delta register=\"formal\" /></response>"
            )
        else:
            payload = "第二层完整定稿译文。"

        def generate():
            yield "content", payload

        return generate() if stream else payload


def test_v4_pipeline_loads_budgeted_context_and_audits_projection(tmp_path):
    database = V4Database(tmp_path / "book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "A complete projected source sentence."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "pipeline-projection-block",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 6,
                "status": "ready",
            }
        ],
    )
    llm = _PipelineProjectionLLM()
    result = V4TranslationPipeline(
        database,
        lambda: llm,
        config=V4PipelineConfig(
            island_size=1,
            initial_workers=1,
            max_workers=1,
            max_blocks=1,
            draft_input_soft_tokens=1200,
            polish_input_soft_tokens=1600,
            prompt_reserve_ratio=0.10,
            style_directive_max_tokens=50,
            style_anchor_max_tokens=240,
            enable_style_anchors=False,
        ),
    ).run()

    assert result["completed"] == 1
    draft = next(call for call in llm.calls if call["purpose"] == "draft")
    polish = next(call for call in llm.calls if call["purpose"] == "polish")
    draft_prompt = "\n".join(item["content"] for item in draft["messages"])
    polish_prompt = "\n".join(item["content"] for item in polish["messages"])
    assert source in draft_prompt
    assert source in polish_prompt
    assert "第一层完整译文" in polish_prompt
    with database.connect() as connection:
        rows = connection.execute(
            """SELECT id, purpose FROM audit_calls
               WHERE run_id=? AND purpose IN ('draft', 'polish')
               ORDER BY id""",
            (result["run_id"],),
        ).fetchall()
    audits = {
        row["purpose"]: database.read_audit_payload(row["id"])["request"]
        for row in rows
    }
    assert audits["draft"]["prompt_projection"]["estimated_tokens"] > 0
    assert "section_token_estimates" in audits["polish"]["prompt_projection"]


class _OversizedDraftLLM(_PipelineProjectionLLM):
    def chat(self, *, messages, purpose, stream=False, **_kwargs):
        self.calls.append({"purpose": purpose, "messages": messages})
        if purpose != "draft":
            raise AssertionError("polish must not be called after hard prompt overflow")
        payload = (
            "<response><analysis></analysis>"
            "<semantic_obligations>无</semantic_obligations>"
            f"<translation>{'译' * 900}</translation>"
            "<new_terms></new_terms><relations></relations>"
            "<supplemental_memory></supplemental_memory>"
            "<style_delta /></response>"
        )

        def generate():
            yield "content", payload

        return generate() if stream else payload


def test_polish_hard_prompt_overflow_returns_manual_without_retry(tmp_path):
    database = V4Database(tmp_path / "polish-overflow-book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    source = "A short source sentence."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "polish-overflow-block",
                "legacy_id": "v01_ch01_000",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 5,
                "status": "ready",
            }
        ],
    )
    llm = _OversizedDraftLLM()

    result = V4TranslationPipeline(
        database,
        lambda: llm,
        config=V4PipelineConfig(
            island_size=1,
            initial_workers=1,
            max_workers=1,
            max_blocks=1,
            max_attempts=1,
            draft_input_soft_tokens=3000,
            polish_input_soft_tokens=700,
            prompt_reserve_ratio=0.0,
        ),
    ).run()

    assert result["incomplete_requires_human"] == 1
    assert result["failed_retryable"] == 0
    assert [call["purpose"] for call in llm.calls] == ["draft"]


def test_shipped_config_declares_prompt_budgets_and_draft_avoids_full_summary():
    root = Path(__file__).resolve().parents[1]
    config = yaml.safe_load(
        (root / "config" / "config.example.yaml").read_text(encoding="utf-8")
    )
    settings = config["parallel_v4"]

    assert settings["draft_input_soft_tokens"] == 6000
    assert settings["polish_input_soft_tokens"] == 8000
    assert settings["prompt_reserve_ratio"] == 0.20
    assert settings["style_directive_max_tokens"] == 60
    assert settings["style_anchor_max_tokens"] == 300
    assert settings["enable_style_anchors"] is True

    prompts = (root / "config" / "prompts.yaml").read_text(encoding="utf-8")
    assert "全书滚动摘要" not in prompts
    assert "<memory_summary>" not in prompts


def _anchor_database(tmp_path):
    database = V4Database(tmp_path / "anchor-book")
    edition = database.ensure_source_edition(
        "raw", "normalized", "test", "source.txt"
    )
    rows = []
    for index in range(3):
        source = f"Source style example {index}."
        rows.append(
            {
                "id": f"anchor-block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode()).hexdigest(),
                "token_count": 4,
                "status": "ready",
            }
        )
    database.upsert_blocks(edition, rows)
    return database, database.list_blocks()


def test_style_snapshot_persists_only_controlled_fields(tmp_path):
    database, blocks = _anchor_database(tmp_path)
    snapshot = NarrativeMemoryStore(database).merge_style_delta(
        blocks[0],
        {
            "register": "formal",
            "rhythm": "measured",
            "future_spoiler": "must not persist",
        },
    )

    assert snapshot is not None
    assert snapshot["state"] == {
        "register": "formal",
        "rhythm": "measured",
    }


def test_anchor_candidates_reuse_active_translations_and_track_lineage(tmp_path):
    database, blocks = _anchor_database(tmp_path)
    store = NarrativeMemoryStore(database)
    snapshot = store.merge_style_delta(
        blocks[0],
        {"register": "formal", "text_type": "prose"},
    )
    database.start_run("anchor-run-1", "translate", {})
    database.commit_translation_batch(
        "anchor-run-1",
        [
            TranslationOutcome(
                block=blocks[0],
                knowledge_version=database.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                draft_translation="第一段初译。",
                final_translation="第一段经过完整性校验的定稿。",
                style_snapshot_id=snapshot["id"],
            )
        ],
    )
    first = store.style_anchor_candidates_before(blocks[1])

    assert len(first) == 1
    assert first[0].source_block_id == blocks[0].id
    assert first[0].source_text == blocks[0].source_text
    assert first[0].target_text == "第一段经过完整性校验的定稿。"
    assert first[0].register == "formal"

    database.start_run("anchor-run-2", "translate", {})
    database.commit_translation_batch(
        "anchor-run-2",
        [
            TranslationOutcome(
                block=blocks[1],
                knowledge_version=database.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                draft_translation="第二段初译。",
                final_translation="第二段经过完整性校验的定稿。",
                style_snapshot_id=snapshot["id"],
                style_anchor_id=first[0].anchor_id,
            )
        ],
    )
    second = store.style_anchor_candidates_before(blocks[2])
    derived = next(item for item in second if item.source_block_id == blocks[1].id)

    assert derived.parent_anchor_id == first[0].anchor_id
    assert first[0].anchor_id in derived.ancestor_anchor_ids
