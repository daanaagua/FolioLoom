"""Barriered parallel translation coordinator for the parallel_v4 shadow pipeline."""

from __future__ import annotations

import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Literal, Mapping, Optional, Sequence
from uuid import uuid4

from ...agents.glossary_manager import GlossaryManager
from ..schemas import (
    ChunkStatus,
    Glossary,
    GlossaryItem,
    GlossaryRule,
    TermCategory,
    TermStatus,
    TextChunk,
)
from ..translator import TranslationConfig, TranslationEngine
from .context import ContextBuilder, ContextOverflow
from .database import FrozenRenderBundle, KnowledgeSnapshotError, V4Database
from .knowledge_epochs import KnowledgeEpochCoordinator
from .matcher import FrozenRenderIndex
from .models import (
    ClaimDependencySnapshot,
    Island,
    NarrativeDependencySnapshot,
    RenderingMatchSnapshot,
    TranslationOutcome,
    V4Block,
    V4BlockStatus,
)
from .narrative_memory import NarrativeContextOverflow, NarrativeMemoryStore
from .narrative_models import (
    DiscourseDelta,
    DiscourseState,
    NarrativePremapResult,
    NarrativeRetrieval,
    NarrativeSnapshot,
    apply_discourse_delta,
)
from .narrative_protocol import NarrativePremapper, PremapperConfig
from .narrative_scheduler import (
    NarrativeScheduler,
    NarrativeSignals,
)
from .prompt_projection import (
    PromptBudgetOverflow,
    PromptBudgetPolicy,
    PromptProjection,
)
from .semantic_mapper import SemanticMapper, SemanticMapperConfig
from .term_validator import TermConsistencyValidator


@dataclass
class V4PipelineConfig:
    island_size: int = 3
    initial_workers: int = 2
    max_workers: int = 4
    max_context_chars: int = 24000
    max_attempts: int = 2
    max_blocks: Optional[int] = None
    include_block_ids: tuple[str, ...] = ()
    decision_mode: Literal["auto", "interactive"] = "auto"
    pause_on_review: bool = False
    unattended_failure_policy: Literal["finish_with_warnings"] = "finish_with_warnings"
    max_knowledge_epochs: int = 3
    enable_polish: bool = True
    enable_semantic_mapper: bool = False
    semantic_temperature: float = 0.0
    semantic_max_tokens: int = 4096
    semantic_max_attempts: int = 2
    enable_narrative_premap: bool = False
    dynamic_scheduling: bool = True
    premap_ahead_blocks: int = 12
    premap_max_tokens: int = 6144
    premap_max_attempts: int = 2
    max_narrative_context_chars: int = 6000
    draft_temperature: float = 0.1
    draft_max_tokens: int = 6144
    polish_temperature: float = 0.2
    polish_max_tokens: int = 6144
    style_reference: Optional[str] = None
    use_baseline_reference: bool = False
    draft_input_soft_tokens: int = 6000
    polish_input_soft_tokens: int = 8000
    prompt_reserve_ratio: float = 0.20
    style_directive_max_tokens: int = 60
    style_anchor_max_tokens: int = 300
    enable_style_anchors: bool = True
    audit_mode: str = "full"
    force: bool = False

    def __post_init__(self) -> None:
        if self.decision_mode == "unattended":
            self.decision_mode = "auto"
        if self.decision_mode not in {"auto", "interactive"}:
            raise ValueError("decision_mode 必须是 auto 或 interactive")
        if self.unattended_failure_policy != "finish_with_warnings":
            raise ValueError("unattended_failure_policy 必须是 finish_with_warnings")
        if type(self.max_knowledge_epochs) is not int or self.max_knowledge_epochs < 1:
            raise ValueError("max_knowledge_epochs 必须是正整数")
        if self.audit_mode not in {"full", "response", "minimal"}:
            raise ValueError("audit_mode 必须是 full、response 或 minimal")
        self.island_size = max(1, self.island_size)
        self.initial_workers = max(1, self.initial_workers)
        self.max_workers = max(self.initial_workers, self.max_workers)
        self.max_attempts = max(1, self.max_attempts)
        self.semantic_max_attempts = max(1, self.semantic_max_attempts)
        self.premap_ahead_blocks = max(1, self.premap_ahead_blocks)
        self.premap_max_tokens = max(256, self.premap_max_tokens)
        self.premap_max_attempts = max(1, self.premap_max_attempts)
        self.max_narrative_context_chars = max(
            256, self.max_narrative_context_chars
        )
        self.draft_input_soft_tokens = max(256, self.draft_input_soft_tokens)
        self.polish_input_soft_tokens = max(256, self.polish_input_soft_tokens)
        if not 0.0 <= self.prompt_reserve_ratio < 1.0:
            raise ValueError("prompt_reserve_ratio 必须在 [0, 1) 范围内")
        self.style_directive_max_tokens = max(
            20, min(60, self.style_directive_max_tokens)
        )
        self.style_anchor_max_tokens = max(
            120, min(300, self.style_anchor_max_tokens)
        )
        self.include_block_ids = tuple(dict.fromkeys(self.include_block_ids))


class AuditedLLM:
    """Capture model traffic in memory; workers never write the database."""

    def __init__(self, delegate: Any):
        self.delegate = delegate
        self.calls: List[Dict[str, Any]] = []

    def get_model(self, purpose: str) -> str:
        getter = getattr(self.delegate, "get_model", None)
        return getter(purpose) if getter else "unknown"

    def chat(self, *, messages: List[Dict[str, str]], purpose: str = "draft", **kwargs: Any):
        started = time.perf_counter()
        request = {
            "messages": messages,
            "temperature": kwargs.get("temperature"),
            "max_tokens": kwargs.get("max_tokens"),
            "json_mode": bool(kwargs.get("json_mode", False)),
            "stream": bool(kwargs.get("stream", False)),
        }
        try:
            response = self.delegate.chat(messages=messages, purpose=purpose, **kwargs)
        except Exception as exc:
            self.calls.append(
                {
                    "purpose": purpose,
                    "model": self.get_model(purpose),
                    "request": request,
                    "raw_response": "",
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                    "error": str(exc),
                }
            )
            raise
        if not kwargs.get("stream", False):
            self.calls.append(
                {
                    "purpose": purpose,
                    "model": self.get_model(purpose),
                    "request": request,
                    "raw_response": str(response),
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                }
            )
            return response

        def captured_stream():
            parts: List[Dict[str, str]] = []
            stream_error: Optional[str] = None
            try:
                for item in response:
                    if isinstance(item, tuple):
                        kind, content = item
                    else:
                        kind, content = "content", str(item)
                    parts.append({"type": str(kind), "content": str(content)})
                    yield item
            except Exception as exc:
                stream_error = str(exc)
                raise
            finally:
                call = {
                    "purpose": purpose,
                    "model": self.get_model(purpose),
                    "request": request,
                    "raw_response": json.dumps(parts, ensure_ascii=False),
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                }
                if stream_error:
                    call["error"] = stream_error
                self.calls.append(call)

        return captured_stream()


@dataclass(frozen=True)
class NarrativeBlockContext:
    result: NarrativePremapResult
    snapshot: NarrativeSnapshot
    retrieval: NarrativeRetrieval
    signals: NarrativeSignals
    matched_subject_ids: tuple[str, ...]
    source_structure: Mapping[str, Any]
    error: str = ""


class V4TranslationPipeline:
    def __init__(
        self,
        database: V4Database,
        llm_factory: Callable[[], Any],
        prompts: Optional[Dict[str, Any]] = None,
        config: Optional[V4PipelineConfig] = None,
    ):
        self.database = database
        self.llm_factory = llm_factory
        self.prompts = prompts or {}
        self.config = config or V4PipelineConfig()
        self.context_builder = ContextBuilder(
            database,
            self.config.max_context_chars,
            budget_policy=PromptBudgetPolicy(
                draft_soft_tokens=self.config.draft_input_soft_tokens,
                polish_soft_tokens=self.config.polish_input_soft_tokens,
                reserve_ratio=self.config.prompt_reserve_ratio,
                style_directive_max_tokens=(
                    self.config.style_directive_max_tokens
                ),
                style_anchor_max_tokens=self.config.style_anchor_max_tokens,
                enable_style_anchors=self.config.enable_style_anchors,
            ),
        )
        self.narrative_store = NarrativeMemoryStore(database)
        self.narrative_scheduler = NarrativeScheduler(
            max_workers=self.config.max_workers
        )
        self._premap_contexts: Dict[str, NarrativeBlockContext] = {}
        self._active_narrative_contexts: Mapping[
            str, NarrativeBlockContext
        ] = {}
        self._premap_cursor = -1
        self._premap_tail_snapshot: NarrativeSnapshot | None = None
        self._premap_tail_state = DiscourseState()
        self._premap_cache_hits = 0
        self._premap_model_calls = 0
        self._style_tail_snapshot: Mapping[str, Any] | None = None
        self._active_style_snapshots: Mapping[
            str, Mapping[str, Any]
        ] = {}

    @staticmethod
    def _category(value: str) -> Optional[TermCategory]:
        try:
            return TermCategory(value)
        except ValueError:
            return TermCategory.CONCEPT

    def _glossary_for(
        self,
        blocks: Sequence[V4Block],
        concept_snapshot: Optional[Sequence[Dict[str, Any]]] = None,
        rendering_contexts_by_block: Optional[
            Mapping[str, Sequence[Mapping[str, Any]]]
        ] = None,
    ) -> GlossaryManager:
        if isinstance(concept_snapshot, FrozenRenderIndex):
            if rendering_contexts_by_block is None:
                active_bundle = getattr(self, "_active_render_bundle", None)
                if (
                    isinstance(active_bundle, FrozenRenderBundle)
                    and active_bundle.index.signature == concept_snapshot.signature
                ):
                    rendering_contexts_by_block = active_bundle.contexts_by_block
                else:
                    rendering_contexts_by_block = self.database.freeze_render_bundle(
                        [block.id for block in blocks]
                    ).contexts_by_block
            items: List[GlossaryItem] = []
            item_priorities: Dict[str, int] = {}
            pattern_sources: Dict[str, str] = {}
            for block in blocks:
                occurrence_contexts = list(
                    rendering_contexts_by_block.get(block.id, [])
                )
                matched_items = concept_snapshot.matched_renderings(
                    block.source_text,
                    block_id=block.id,
                    occurrence_contexts=occurrence_contexts,
                )
                grouped: Dict[tuple[str, str], List[Any]] = {}
                for matched in matched_items:
                    if str(matched.rendered_target or "").strip():
                        key = (matched.lexeme_id, matched.matched_form.casefold())
                        grouped.setdefault(key, []).append(matched)
                for group in grouped.values():
                    by_target: Dict[str, List[Any]] = {}
                    for matched in group:
                        target = str(matched.rendered_target or "").strip()
                        by_target.setdefault(target, []).append(matched)
                    multiple_targets = len(by_target) > 1
                    for target, target_matches in by_target.items():
                        matched = target_matches[0]
                        offsets = sorted(
                            {
                                (value.start_offset, value.end_offset)
                                for value in target_matches
                            }
                        )
                        shown_offsets = offsets[:8]
                        offset_label = "、".join(
                            f"{start}:{end}" for start, end in shown_offsets
                        )
                        if len(offsets) > len(shown_offsets):
                            offset_label += "、等"
                        matched_form = str(matched.matched_form or "").strip()
                        source = matched_form
                        location_note = ""
                        if multiple_targets:
                            source = f"{matched_form}（原文字符{offset_label}）"
                            location_note = (
                                f"仅适用于原文字符位置 {offset_label}；"
                                "不得用于同块其他同形词。"
                            )
                            pattern_sources[source] = matched_form
                        lexeme = concept_snapshot.get_lexeme(matched.lexeme_id) or {}
                        concept = next(
                            (
                                value
                                for value in lexeme.get("concepts", []) or []
                                if str(value.get("id") or "") == matched.concept_id
                            ),
                            None,
                        )
                        if concept is None:
                            concept = next(iter(lexeme.get("concepts", []) or []), {})
                        winning_rules = {
                            str(rule.get("id") or ""): rule
                            for rule in list(lexeme.get("rules", []) or [])
                            + list(concept.get("rules", []) or [])
                        }
                        rule_verified = any(
                            bool(winning_rules.get(rule_id, {}).get("locked"))
                            or str(winning_rules.get(rule_id, {}).get("status") or "")
                            == "verified"
                            for rule_id in matched.applied_rule_ids
                        )
                        winning_priority = max(
                            (
                                int(
                                    winning_rules.get(rule_id, {}).get("priority")
                                    or 0
                                )
                                for rule_id in matched.applied_rule_ids
                            ),
                            default=0,
                        )
                        verified = rule_verified or target in {
                            str(lexeme.get("verified_target") or "").strip(),
                            str(concept.get("verified_target") or "").strip(),
                        }
                        status = (
                            TermStatus.VERIFIED if verified else TermStatus.WORKING
                        )
                        base_description = str(
                            concept.get("description") or ""
                        ).strip()
                        term_profile = (
                            concept.get("term_profile")
                            or lexeme.get("term_profile")
                            or {}
                        )
                        semantic_core = str(
                            term_profile.get("semantic_core") or ""
                        ).strip()
                        contrast_sources = [
                            str(value).strip()
                            for value in term_profile.get("contrast_sources") or []
                            if str(value).strip()
                        ]
                        contrast_note = (
                            "须与原文词保持区别: "
                            + "、".join(contrast_sources)
                            if contrast_sources
                            else ""
                        )
                        description = " ".join(
                            value
                            for value in (
                                base_description,
                                semantic_core,
                                contrast_note,
                                location_note,
                            )
                            if value
                        ) or None
                        item_id = (
                            f"{matched.concept_id or matched.lexeme_id}:"
                            f"{block.id}:{offset_label}"
                        )
                        item = GlossaryItem(
                                id=item_id,
                                src=source or str(lexeme.get("source") or ""),
                                default_target=target,
                                category=self._category(
                                    str(
                                        concept.get("kind")
                                        or lexeme.get("kind")
                                        or "concept"
                                    )
                                ),
                                status=status,
                                description=description,
                                rules=[],
                        )
                        items.append(item)
                        item_priorities[item_id] = winning_priority
            ranked_items = sorted(
                enumerate(items),
                key=lambda value: (
                    -item_priorities.get(str(value[1].id), 0),
                    value[0],
                    str(value[1].id),
                ),
            )
            item_limit = 128
            character_limit = max(0, min(16 * 1024, self.config.max_context_chars))
            selected_items: List[GlossaryItem] = []
            omitted_items: List[GlossaryItem] = []
            visible_characters = 0
            for _ordinal, item in ranked_items:
                rendered = TranslationEngine._render_glossary_term(item)
                added = len(rendered) + (1 if selected_items else 0)
                if (
                    len(selected_items) >= item_limit
                    or visible_characters + added > character_limit
                ):
                    omitted_items.append(item)
                    continue
                selected_items.append(item)
                visible_characters += added
            omitted_digest = hashlib.sha256(
                "\n".join(str(item.id) for item in omitted_items).encode("utf-8")
            ).hexdigest()
            manager = GlossaryManager(str(self.database.root / "readonly_glossary"))
            manager.glossary = Glossary(items=selected_items)
            manager._build_patterns()
            selected_sources = {str(item.src) for item in selected_items}
            for annotated_source, matched_form in pattern_sources.items():
                if annotated_source not in selected_sources:
                    continue
                manager._term_patterns[annotated_source] = re.compile(
                    rf"(?<!\w){re.escape(matched_form)}(?!\w)", re.IGNORECASE
                )
            manager.render_limit_metadata = {
                "total": len(items),
                "included": len(selected_items),
                "omitted": len(omitted_items),
                "visible_characters": visible_characters,
                "character_limit": character_limit,
                "item_limit": item_limit,
                "omitted_digest": omitted_digest,
                "reason": "bounded_translation_glossary",
            }
            manager.render_warnings = (
                [
                    {
                        "kind": "render_constraints_truncated",
                        "total": len(items),
                        "kept": len(selected_items),
                        "omitted": len(omitted_items),
                        "digest": omitted_digest,
                        "reason": "bounded_translation_glossary",
                    }
                ]
                if omitted_items
                else []
            )
            return manager

        source = "\n".join(block.source_text for block in blocks)
        concepts = self.database.concepts_for_text(
            source, concept_snapshot=concept_snapshot
        )
        items: List[GlossaryItem] = []
        for concept in concepts:
            src = str(concept.get("source") or "").strip()
            target = str(concept.get("default_target") or "").strip()
            if not src or not target:
                continue
            rules = [
                GlossaryRule(
                    condition=json.dumps(rule.get("condition") or {}, ensure_ascii=False),
                    target=rule.get("target") or "",
                )
                for rule in concept.get("rules", [])
                if rule.get("target")
            ]
            verified = concept.get("target_strength") == "verified" or bool(
                concept.get("locked")
            )
            status = (
                TermStatus.VERIFIED
                if verified
                else TermStatus.WORKING
                if concept.get("target_strength") == "working"
                else TermStatus.PENDING
            )
            profile = concept.get("term_profile") or {}
            semantic_core = str(profile.get("semantic_core") or "").strip()
            contrast_sources = [
                str(value).strip()
                for value in profile.get("contrast_sources") or []
                if str(value).strip()
            ]
            description = " ".join(
                value
                for value in (
                    str(concept.get("description") or "").strip(),
                    semantic_core,
                    (
                        "须与原文词保持区别: "
                        + "、".join(contrast_sources)
                        if contrast_sources
                        else ""
                    ),
                )
                if value
            ) or None
            items.append(
                GlossaryItem(
                    id=concept["id"],
                    src=src,
                    default_target=target,
                    category=self._category(concept.get("kind") or "concept"),
                    status=status,
                    description=description,
                    rules=rules,
                )
            )
        manager = GlossaryManager(str(self.database.root / "readonly_glossary"))
        manager.glossary = Glossary(items=items)
        manager._build_patterns()
        return manager

    @staticmethod
    def _make_islands(blocks: Sequence[V4Block], island_size: int) -> List[Island]:
        islands: List[Island] = []
        current: List[V4Block] = []
        for block in blocks:
            is_contiguous = (
                current
                and current[-1].chapter_id == block.chapter_id
                and current[-1].global_index + 1 == block.global_index
            )
            if current and (not is_contiguous or len(current) >= island_size):
                islands.append(Island(id=f"island_{current[0].global_index:06d}", blocks=current))
                current = []
            current.append(block)
        if current:
            islands.append(Island(id=f"island_{current[0].global_index:06d}", blocks=current))
        return islands

    def _translation_config(self) -> TranslationConfig:
        return TranslationConfig(
            draft_temperature=self.config.draft_temperature,
            draft_max_tokens=self.config.draft_max_tokens,
            polish_temperature=self.config.polish_temperature,
            polish_max_tokens=self.config.polish_max_tokens,
            enable_polish=self.config.enable_polish,
            style_reference=self.config.style_reference,
            glossary_mode="manual",
            strict_response_parsing=True,
            persist_discoveries=False,
            draft_input_soft_tokens=self.config.draft_input_soft_tokens,
            polish_input_soft_tokens=self.config.polish_input_soft_tokens,
            prompt_reserve_ratio=self.config.prompt_reserve_ratio,
            style_directive_max_tokens=self.config.style_directive_max_tokens,
            style_anchor_max_tokens=self.config.style_anchor_max_tokens,
            enable_style_anchors=self.config.enable_style_anchors,
            max_context_chars=self.config.max_context_chars,
        )

    @staticmethod
    def _narrative_semantic_hint(result: NarrativePremapResult) -> str:
        if not result.semantic_relations:
            return ""
        return "\n".join(
            (
                f"- {relation.relation_type} / "
                f"{relation.inference_strength}: "
                f"{relation.translation_constraint}"
            )
            for relation in result.semantic_relations
        )

    @staticmethod
    def _source_style_confidence(result: NarrativePremapResult) -> float:
        """Use only current-block premap evidence to suppress needless anchors."""

        delta = result.discourse_delta
        if (
            not tuple(delta.style_signals or ())
            or bool(getattr(result, "degraded", False))
            or bool(getattr(delta, "premap_uncertain", False))
        ):
            return 0.0
        confidence = delta.state_confidence
        if confidence is None:
            return 0.8
        return min(1.0, max(0.0, float(confidence)))

    @staticmethod
    def _projection_audit(
        projection: PromptProjection | None,
    ) -> Dict[str, Any]:
        if projection is None:
            return {}
        return {
            "stage": projection.stage,
            "estimated_tokens": projection.estimated_tokens,
            "estimated_chars": projection.estimated_chars,
            "budget_tokens": projection.budget_tokens,
            "budget_chars": projection.budget_chars,
            "reserve_ratio": projection.reserve_ratio,
            "estimator_version": projection.estimator_version,
            "included_section_ids": list(
                projection.included_section_ids
            ),
            "dropped_section_ids": list(projection.dropped_section_ids),
            "section_token_estimates": dict(
                projection.section_token_estimates
            ),
            "decisions": {
                stable_id: {
                    "included": decision.included,
                    "reason": decision.reason,
                    "estimated_tokens": decision.estimated_tokens,
                    "priority": decision.priority,
                    "marginal_utility": decision.marginal_utility,
                }
                for stable_id, decision in projection.decisions.items()
            },
        }

    def _provisional_subjects(
        self, block: V4Block, prior_state: DiscourseState
    ) -> list[dict[str, str]]:
        subjects: dict[str, dict[str, str]] = {}
        for concept in self.database.concepts_for_text(block.source_text):
            concept_id = str(concept.get("id") or "").strip()
            if concept_id:
                subjects[concept_id] = {
                    "id": concept_id,
                    "label": str(
                        concept.get("source")
                        or concept.get("canonical_source")
                        or concept_id
                    )[:256],
                    "subject_type": "concept",
                    "semantic_kind": str(
                        concept.get("kind") or "concept"
                    )[:64],
                }
            lexeme_id = str(
                concept.get("primary_lexeme_id") or ""
            ).strip()
            if lexeme_id:
                subjects[lexeme_id] = {
                    "id": lexeme_id,
                    "label": str(concept.get("source") or lexeme_id)[:256],
                    "subject_type": "lexeme",
                    "semantic_kind": "lexeme",
                }
        prior_ids = {
            *prior_state.active_speakers,
            *prior_state.addressed_parties,
            *prior_state.unresolved_references,
        }
        for value in (
            prior_state.viewpoint_holder,
            prior_state.narrator_layer,
            prior_state.scene_location,
            prior_state.scene_time,
            prior_state.presentation_layer,
        ):
            if value:
                prior_ids.add(value)
        for subject_id in prior_ids:
            subjects.setdefault(
                subject_id,
                {
                    "id": subject_id,
                    "label": "prior discourse subject",
                    "subject_type": (
                        "concept"
                        if subject_id.startswith("concept_")
                        else "lexeme"
                        if subject_id.startswith("lexeme_")
                        else "thread"
                    ),
                    "semantic_kind": "prior",
                },
            )
        return [subjects[key] for key in sorted(subjects)]

    @staticmethod
    def _source_structure(block: V4Block) -> dict[str, Any]:
        return {
            "block_type": block.block_type,
            "chapter_id": block.chapter_id,
            "chapter_index": block.chapter_index,
            "block_index": block.block_index,
        }

    @staticmethod
    def _narrative_signals(
        block: V4Block,
        result: NarrativePremapResult,
        prior_state: DiscourseState,
        current_state: DiscourseState,
    ) -> NarrativeSignals:
        delta = result.discourse_delta
        subject_ids = {
            subject.subject_id
            for candidate in result.memory_candidates
            for subject in candidate.subjects
        }
        return NarrativeSignals(
            global_index=block.global_index,
            new_subjects=len(subject_ids),
            viewpoint_shift=bool(
                delta.viewpoint_holder is not None
                and delta.viewpoint_holder != prior_state.viewpoint_holder
            ),
            narrator_layer_shift=bool(
                delta.narrator_layer is not None
                and delta.narrator_layer != prior_state.narrator_layer
            ),
            presentation_layer_shift=bool(
                delta.presentation_layer is not None
                and delta.presentation_layer
                != prior_state.presentation_layer
            ),
            time_shift=bool(
                delta.scene_time is not None
                and delta.scene_time != prior_state.scene_time
            ),
            location_shift=bool(
                delta.scene_location is not None
                and delta.scene_location != prior_state.scene_location
            ),
            unresolved_references=len(current_state.unresolved_references),
            contradictions=sum(
                candidate.memory_type == "contradiction"
                for candidate in result.memory_candidates
            ),
            open_questions=sum(
                candidate.memory_type == "open_question"
                for candidate in result.memory_candidates
            ),
            high_impact_memories=sum(
                candidate.high_impact
                for candidate in result.memory_candidates
            ),
            dialogue_participant_changes=(
                len(delta.active_speakers or ())
                + len(delta.addressed_parties or ())
                if delta.active_speakers is not None
                or delta.addressed_parties is not None
                else 0
            ),
            structure_complexity=int(
                block.block_type
                in {"poem", "letter", "footnote", "quotation"}
            ),
            premap_degraded=result.degraded,
        )

    def _premap_block(
        self,
        block: V4Block,
        *,
        knowledge_version: int,
        run_id: str,
        prior_snapshot: NarrativeSnapshot | None,
        prior_state: DiscourseState,
    ) -> NarrativeBlockContext:
        structure = self._source_structure(block)
        structure_hash = self.narrative_store.save_source_structure(
            block, structure
        )
        provisional_subjects = self._provisional_subjects(
            block, prior_state
        )
        client = AuditedLLM(self.llm_factory())
        model_id = str(client.get_model("narrative_premap"))
        prompt_hash = hashlib.sha256(
            NarrativePremapper.SYSTEM_PROMPT.encode("utf-8")
        ).hexdigest()
        parameters_hash = hashlib.sha256(
            json.dumps(
                {
                    "temperature": self.config.semantic_temperature,
                    "max_tokens": self.config.premap_max_tokens,
                    "max_attempts": self.config.premap_max_attempts,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        provisional_hash = hashlib.sha256(
            json.dumps(
                provisional_subjects,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        prior_hash = (
            prior_snapshot.snapshot_hash if prior_snapshot is not None else ""
        )
        cache_key = self.narrative_store.premap_cache_key(
            block=block,
            structure_hash=structure_hash,
            prompt_hash=prompt_hash,
            model_id=model_id,
            parameters_hash=parameters_hash,
            prior_snapshot_hash=prior_hash,
            provisional_subject_hash=provisional_hash,
        )
        cached = self.narrative_store.load_premap_result(cache_key)
        cached_snapshot = self.narrative_store.snapshot_for_cache(cache_key)
        current_memory_version = (
            self.narrative_store.current_memory_version()
        )
        linked_snapshot_is_compatible = bool(
            cached_snapshot is not None
            and cached_snapshot.knowledge_version == knowledge_version
            and cached_snapshot.memory_version == current_memory_version
        )
        if cached is not None and cached_snapshot is not None:
            self._premap_cache_hits += 1
            self.database.record_audit_call(
                run_id=run_id,
                block_id=block.id,
                purpose="narrative_premap_cache_hit",
                model=model_id,
                knowledge_version=knowledge_version,
                request={"cache_key": cache_key},
                raw_response="",
                parsed={"snapshot_id": cached_snapshot.id},
                accepted=True,
                attempts=1,
                elapsed_ms=0,
                error=None,
                archive_payload=False,
            )
            result = cached
            current_state = apply_discourse_delta(
                prior_state, result.discourse_delta
            )
            refreshed_snapshot = None
            if (
                not linked_snapshot_is_compatible
                and cached_snapshot.knowledge_version == knowledge_version
            ):
                refreshed_snapshot = self.narrative_store.build_snapshot(
                    block,
                    knowledge_version=knowledge_version,
                    memory_version=current_memory_version,
                    discourse_state=current_state,
                )
                linked_snapshot_is_compatible = bool(
                    refreshed_snapshot.visible_memory_ids
                    == cached_snapshot.visible_memory_ids
                    and refreshed_snapshot.discourse_state
                    == cached_snapshot.discourse_state
                )
            if linked_snapshot_is_compatible:
                snapshot = cached_snapshot
            else:
                snapshot = (
                    refreshed_snapshot
                    or self.narrative_store.build_snapshot(
                        block,
                        knowledge_version=knowledge_version,
                        memory_version=current_memory_version,
                        discourse_state=current_state,
                    )
                )
        else:
            if cached is None:
                premapper = NarrativePremapper(
                    client,
                    PremapperConfig(
                        temperature=self.config.semantic_temperature,
                        max_tokens=self.config.premap_max_tokens,
                        max_attempts=self.config.premap_max_attempts,
                    ),
                )
                result = premapper.map(
                    block=block,
                    structure=structure,
                    prior_snapshot=(
                        self.narrative_store.snapshot_payload(prior_snapshot)
                        if prior_snapshot is not None
                        else {"visible_memories": []}
                    ),
                    discourse_state=prior_state,
                    provisional_subjects=provisional_subjects,
                )
                self._premap_model_calls += len(client.calls)
                audit_id: int | None = None
                for index, call in enumerate(client.calls):
                    accepted = bool(
                        index == len(client.calls) - 1
                        and premapper.last_succeeded
                    )
                    audit_id = self.database.record_audit_call(
                        run_id=run_id,
                        block_id=block.id,
                        purpose="narrative_premap",
                        model=str(call.get("model") or model_id),
                        knowledge_version=knowledge_version,
                        request=dict(call.get("request") or {}),
                        raw_response=str(call.get("raw_response") or ""),
                        parsed=result.to_dict() if accepted else None,
                        accepted=accepted,
                        attempts=index + 1,
                        elapsed_ms=int(call.get("elapsed_ms") or 0),
                        error=(
                            str(call.get("error"))
                            if call.get("error")
                            else None
                        ),
                        archive_payload=self.config.audit_mode == "full",
                    )
                response_hash = hashlib.sha256(
                    (
                        str(client.calls[-1].get("raw_response") or "")
                        if client.calls
                        else ""
                    ).encode("utf-8")
                ).hexdigest()
                self.narrative_store.save_premap_result(
                    cache_key=cache_key,
                    block=block,
                    result=result,
                    model_id=model_id,
                    prompt_hash=prompt_hash,
                    prior_snapshot_hash=prior_hash,
                    request_hash=hashlib.sha256(
                        json.dumps(
                            client.calls[-1].get("request") if client.calls else {},
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ).encode("utf-8")
                    ).hexdigest(),
                    response_hash=response_hash,
                    audit_call_id=audit_id,
                )
            else:
                result = cached
            self.narrative_store.merge_candidates(
                block,
                result.memory_candidates,
                source="narrative_premap",
            )
            current_state = apply_discourse_delta(
                prior_state, result.discourse_delta
            )
            snapshot = self.narrative_store.build_snapshot(
                block,
                knowledge_version=knowledge_version,
                discourse_state=current_state,
            )
        signals = self._narrative_signals(
            block, result, prior_state, current_state
        )
        schedule_plan = self.narrative_scheduler.plan(signals)
        if cached_snapshot is None or linked_snapshot_is_compatible:
            self.narrative_store.link_premap_snapshot(
                cache_key,
                snapshot.id,
                metrics={
                    "volatility": schedule_plan.volatility,
                    "reasons": list(schedule_plan.reasons),
                    "workers": schedule_plan.workers,
                    "island_size": schedule_plan.island_size,
                },
            )
        matched_subject_ids = tuple(
            value["id"] for value in provisional_subjects
        )
        error = ""
        semantic_relation_memory_ids = tuple(
            dict.fromkeys(
                memory_id
                for relation in result.semantic_relations
                for memory_id in relation.related_memory_ids
            )
        )
        try:
            retrieval = self.narrative_store.retrieve_for_block(
                block,
                snapshot,
                matched_subject_ids=matched_subject_ids,
                semantic_relation_memory_ids=semantic_relation_memory_ids,
                max_chars=self.config.max_narrative_context_chars,
            )
        except NarrativeContextOverflow as exc:
            retrieval = NarrativeRetrieval((), (), 0)
            error = str(exc)
        return NarrativeBlockContext(
            result=result,
            snapshot=snapshot,
            retrieval=retrieval,
            signals=signals,
            matched_subject_ids=matched_subject_ids,
            source_structure=structure,
            error=error,
        )

    def _ensure_premapped(
        self,
        candidates: Sequence[V4Block],
        *,
        through_position: int,
        knowledge_version: int,
        run_id: str,
    ) -> None:
        target = min(len(candidates) - 1, through_position)
        while self._premap_cursor < target:
            position = self._premap_cursor + 1
            block = candidates[position]
            context = self._premap_block(
                block,
                knowledge_version=knowledge_version,
                run_id=run_id,
                prior_snapshot=self._premap_tail_snapshot,
                prior_state=self._premap_tail_state,
            )
            self._premap_contexts[block.id] = context
            self._premap_tail_snapshot = context.snapshot
            self._premap_tail_state = context.snapshot.discourse_state
            self._premap_cursor = position

    def _translation_narrative_context(
        self, block: V4Block, knowledge_version: int
    ) -> NarrativeBlockContext:
        base = self._premap_contexts[block.id]
        current_memory_version = self.narrative_store.current_memory_version()
        if (
            base.snapshot.knowledge_version == knowledge_version
            and base.snapshot.memory_version == current_memory_version
        ):
            return base
        snapshot = self.narrative_store.build_snapshot(
            block,
            knowledge_version=knowledge_version,
            memory_version=current_memory_version,
            discourse_state=base.snapshot.discourse_state,
        )
        try:
            semantic_relation_memory_ids = tuple(
                dict.fromkeys(
                    memory_id
                    for relation in base.result.semantic_relations
                    for memory_id in relation.related_memory_ids
                )
            )
            retrieval = self.narrative_store.retrieve_for_block(
                block,
                snapshot,
                matched_subject_ids=base.matched_subject_ids,
                semantic_relation_memory_ids=semantic_relation_memory_ids,
                max_chars=self.config.max_narrative_context_chars,
            )
            error = ""
        except NarrativeContextOverflow as exc:
            retrieval = NarrativeRetrieval((), (), 0)
            error = str(exc)
        return NarrativeBlockContext(
            result=base.result,
            snapshot=snapshot,
            retrieval=retrieval,
            signals=base.signals,
            matched_subject_ids=base.matched_subject_ids,
            source_structure=base.source_structure,
            error=error,
        )

    def _translate_island(
        self,
        island: Island,
        knowledge_version: int,
        concept_snapshot: Optional[Sequence[Dict[str, Any]]] = None,
    ) -> List[TranslationOutcome]:
        audited_llm = AuditedLLM(self.llm_factory())
        semantic_mapper = SemanticMapper(
            audited_llm,
            SemanticMapperConfig(
                temperature=self.config.semantic_temperature,
                max_tokens=self.config.semantic_max_tokens,
                max_attempts=self.config.semantic_max_attempts,
            ),
        )
        proposals: List[tuple[str, Dict[str, Any]]] = []
        rendering_contexts_by_block: Mapping[
            str, Sequence[Mapping[str, Any]]
        ] = {}
        frozen_claims_by_block: Mapping[
            str, Sequence[Mapping[str, Any]]
        ] = {}
        frozen_prior_evidence_by_block: Mapping[
            str, Sequence[Mapping[str, Any]]
        ] = {}
        if isinstance(concept_snapshot, FrozenRenderIndex):
            active_bundle = getattr(self, "_active_render_bundle", None)
            if (
                isinstance(active_bundle, FrozenRenderBundle)
                and active_bundle.index is concept_snapshot
                and active_bundle.knowledge_version == knowledge_version
                and all(
                    block.id in active_bundle.block_ids for block in island.blocks
                )
            ):
                rendering_contexts_by_block = active_bundle.contexts_by_block
                frozen_claims_by_block = active_bundle.claims_by_block
                frozen_prior_evidence_by_block = (
                    active_bundle.prior_concept_evidence_by_block
                )
            else:
                raise RuntimeError(
                    "translation requires the exact frozen render bundle and contexts"
                )
        engine = TranslationEngine(
            llm_manager=audited_llm,
            glossary_manager=self._glossary_for(
                island.blocks,
                concept_snapshot=concept_snapshot,
                rendering_contexts_by_block=rendering_contexts_by_block,
            ),
            knowledge_base=None,
            prompts=self.prompts,
            config=self._translation_config(),
            proposal_sink=lambda kind, payload: proposals.append((kind, payload)),
        )
        outcomes: List[TranslationOutcome] = []
        previous_source = ""
        previous_translation = ""
        local_summary = ""
        for block in island.blocks:
            narrative_context = self._active_narrative_contexts.get(block.id)
            if narrative_context is not None and narrative_context.error:
                outcomes.append(
                    TranslationOutcome(
                        block=block,
                        knowledge_version=knowledge_version,
                        status=V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
                        error=narrative_context.error,
                    )
                )
                break
            render_constraint_warnings: List[Dict[str, Any]] = []
            frozen_render_matches: tuple[RenderingMatchSnapshot, ...] = ()
            if isinstance(concept_snapshot, FrozenRenderIndex):
                engine.glossary = self._glossary_for(
                    [block],
                    concept_snapshot=concept_snapshot,
                    rendering_contexts_by_block=rendering_contexts_by_block,
                )
                render_constraint_warnings = [
                    dict(value)
                    for value in getattr(engine.glossary, "render_warnings", [])
                    if isinstance(value, Mapping)
                ]
                frozen_render_matches = tuple(
                    RenderingMatchSnapshot(
                        lexeme_id=match.lexeme_id,
                        concept_id=match.concept_id,
                        matched_form=match.matched_form,
                        start_offset=match.start_offset,
                        end_offset=match.end_offset,
                        rendered_target=match.rendered_target,
                        applied_rule_ids=tuple(match.applied_rule_ids),
                        dependency_fingerprint=match.dependency_fingerprint,
                    )
                    for match in concept_snapshot.matched_renderings(
                        block.source_text,
                        block_id=block.id,
                        occurrence_contexts=list(
                            rendering_contexts_by_block.get(block.id, [])
                        ),
                    )
                )
            frozen_block_concept_ids = [
                str(concept["id"])
                for concept in self.database.concepts_for_text(
                    block.source_text, concept_snapshot=concept_snapshot
                )
            ]
            try:
                packet = self.context_builder.build(
                    block,
                    previous_source=previous_source,
                    previous_translation=previous_translation,
                    local_summary=local_summary,
                    knowledge_version=knowledge_version,
                    concept_snapshot=concept_snapshot,
                    frozen_claims=frozen_claims_by_block.get(block.id, ()),
                    frozen_prior_concept_evidence=(
                        frozen_prior_evidence_by_block.get(block.id, ())
                    ),
                    narrative_snapshot=(
                        narrative_context.snapshot
                        if narrative_context is not None
                        else None
                    ),
                    narrative_retrieval=(
                        narrative_context.retrieval
                        if narrative_context is not None
                        else None
                    ),
                    semantic_relations=(
                        narrative_context.result.semantic_relations
                        if narrative_context is not None
                        else ()
                    ),
                    source_structure=(
                        narrative_context.source_structure
                        if narrative_context is not None
                        else self._source_structure(block)
                    ),
                    style_snapshot=self._active_style_snapshots.get(
                        block.id
                    ),
                    style_anchor_candidates=(
                        self.narrative_store.style_anchor_candidates_before(
                            block
                        )
                        if self.config.enable_style_anchors
                        else ()
                    ),
                    source_style_confidence=(
                        self._source_style_confidence(
                            narrative_context.result
                        )
                        if narrative_context is not None
                        else 0.0
                    ),
                )
            except (ContextOverflow, PromptBudgetOverflow) as exc:
                outcomes.append(
                    TranslationOutcome(
                        block=block,
                        knowledge_version=knowledge_version,
                        status=V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
                        matched_concept_ids=frozen_block_concept_ids,
                        matched_renderings=frozen_render_matches,
                        error=str(exc),
                    )
                )
                break

            started = time.perf_counter()
            call_start = len(audited_llm.calls)
            proposal_start = len(proposals)
            comparison_reference = ""
            if self.config.use_baseline_reference:
                reference = self.database.comparison_reference_for_block(block.id)
                if reference:
                    comparison_reference = str(reference.get("text") or "").strip()
            result: Optional[TextChunk] = None
            attempts = 0
            semantic_obligations_hint = (
                self._narrative_semantic_hint(narrative_context.result)
                if narrative_context is not None
                else ""
            )
            if (
                self.config.enable_semantic_mapper
                and narrative_context is None
            ):
                semantic_obligations_hint = semantic_mapper.map(
                    block.source_text,
                    packet.rendered,
                )
                required_with_hint = packet.required_chars + len(semantic_obligations_hint)
                if required_with_hint > self.config.max_context_chars:
                    block_audits = [dict(call) for call in audited_llm.calls[call_start:]]
                    for call in block_audits:
                        call["accepted"] = False
                    semantic_audits = [
                        call for call in block_audits if call.get("purpose") == "semantic"
                    ]
                    if semantic_audits:
                        semantic_audits[-1]["accepted"] = semantic_mapper.last_succeeded
                        semantic_audits[-1]["parsed"] = {
                            "semantic_obligations_hint": semantic_obligations_hint
                        }
                    outcomes.append(
                        TranslationOutcome(
                            block=block,
                            knowledge_version=knowledge_version,
                            status=V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
                            matched_concept_ids=list(packet.matched_concept_ids),
                            matched_renderings=frozen_render_matches,
                            audit_calls=block_audits,
                            elapsed_ms=int((time.perf_counter() - started) * 1000),
                            error=(
                                f"{block.id} 加入独立语义映射后必需上下文为 "
                                f"{required_with_hint} 字符，超过预算 "
                                f"{self.config.max_context_chars}；需要人工处理"
                            ),
                        )
                    )
                    break
            prompt_budget_error: PromptBudgetOverflow | None = None
            for attempts in range(1, self.config.max_attempts + 1):
                try:
                    result = engine.translate_chunk(
                        TextChunk(
                            id=block.id,
                            chapter_id=block.chapter_id,
                            index=block.block_index,
                            source_text=block.source_text,
                            token_count=block.token_count,
                        ),
                        memory_context=packet.rendered,
                        previous_summary=local_summary,
                        previous_chunk_text=previous_source,
                        comparison_reference=comparison_reference,
                        semantic_obligations_hint=semantic_obligations_hint,
                        prompt_context=packet,
                    )
                except PromptBudgetOverflow as exc:
                    prompt_budget_error = exc
                    break
                if result.status in {ChunkStatus.COMPLETED, ChunkStatus.HUMAN_REVIEW}:
                    break
            if prompt_budget_error is not None:
                block_audits = [
                    dict(call) for call in audited_llm.calls[call_start:]
                ]
                for call in block_audits:
                    call["accepted"] = False
                    if call.get("purpose") == "draft":
                        request = dict(call.get("request") or {})
                        request["prompt_projection"] = (
                            self._projection_audit(packet.draft_projection)
                        )
                        call["request"] = request
                    elif call.get("purpose") == "polish":
                        request = dict(call.get("request") or {})
                        request["prompt_projection"] = (
                            self._projection_audit(packet.polish_projection)
                        )
                        call["request"] = request
                outcomes.append(
                    TranslationOutcome(
                        block=block,
                        knowledge_version=knowledge_version,
                        memory_version=packet.memory_version,
                        snapshot_id=packet.snapshot_id,
                        context_hash=packet.context_hash,
                        style_snapshot_id=packet.style_snapshot_id,
                        style_anchor_id=packet.style_anchor_id or "",
                        discourse_state_hash=packet.discourse_state_hash,
                        status=(
                            V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value
                        ),
                        matched_concept_ids=list(packet.matched_concept_ids),
                        matched_renderings=frozen_render_matches,
                        audit_calls=block_audits,
                        attempts=attempts,
                        elapsed_ms=int(
                            (time.perf_counter() - started) * 1000
                        ),
                        error=str(prompt_budget_error),
                    )
                )
                break
            assert result is not None
            block_proposals = proposals[proposal_start:]
            term_proposals = [payload for kind, payload in block_proposals if kind == "term"]
            relation_proposals = [payload for kind, payload in block_proposals if kind == "relation"]
            term_consistency_warnings: List[Dict[str, Any]] = []
            if (
                isinstance(concept_snapshot, FrozenRenderIndex)
                and result.status
                in {ChunkStatus.COMPLETED, ChunkStatus.HUMAN_REVIEW}
                and bool((result.final_translation or "").strip())
            ):
                term_consistency_warnings = TermConsistencyValidator.validate(
                    source_text=block.source_text,
                    final_translation=result.final_translation or "",
                    matches=frozen_render_matches,
                    render_index=concept_snapshot,
                )
            if result.status == ChunkStatus.COMPLETED:
                status = (
                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value
                    if term_consistency_warnings
                    else V4BlockStatus.COMPLETED.value
                )
            elif result.status == ChunkStatus.HUMAN_REVIEW:
                status = V4BlockStatus.COMPLETED_WITH_WARNINGS.value
            else:
                status = V4BlockStatus.FAILED_RETRYABLE.value
            block_audits = [dict(call) for call in audited_llm.calls[call_start:]]
            for call in block_audits:
                call["accepted"] = False
            draft_audits = [call for call in block_audits if call.get("purpose") == "draft"]
            polish_audits = [call for call in block_audits if call.get("purpose") == "polish"]
            if draft_audits:
                draft_request = dict(draft_audits[-1].get("request") or {})
                draft_request["prompt_projection"] = self._projection_audit(
                    packet.draft_projection
                )
                draft_audits[-1]["request"] = draft_request
            if polish_audits:
                polish_request = dict(polish_audits[-1].get("request") or {})
                polish_request["prompt_projection"] = self._projection_audit(
                    packet.polish_projection
                )
                polish_audits[-1]["request"] = polish_request
            semantic_audits = [
                call for call in block_audits if call.get("purpose") == "semantic"
            ]
            if semantic_audits:
                semantic_audits[-1]["accepted"] = semantic_mapper.last_succeeded
                semantic_audits[-1]["parsed"] = {
                    "semantic_obligations_hint": semantic_obligations_hint
                }
            if draft_audits:
                draft_audits[-1]["accepted"] = result.status in {
                    ChunkStatus.COMPLETED,
                    ChunkStatus.HUMAN_REVIEW,
                }
                draft_audits[-1]["parsed"] = {
                    "analysis": result.analysis or "",
                    "semantic_obligations": result.semantic_obligations or "",
                    "translation": result.draft_translation or "",
                    "memory_summary": result.memory_summary or "",
                }
            if polish_audits:
                normalized_polish = engine._normalize_chinese_punctuation(
                    result.polished_translation or ""
                )
                polish_audits[-1]["accepted"] = bool(
                    result.polished_translation
                    and result.final_translation == normalized_polish
                )
                polish_audits[-1]["parsed"] = {
                    "final_translation": result.final_translation or "",
                    "warnings": list(result.quality_warnings),
                }
            quality_warnings: List[Any] = []
            warning_keys: set[str] = set()
            for warning in (
                list(result.quality_warnings)
                + render_constraint_warnings
                + term_consistency_warnings
            ):
                key = json.dumps(
                    warning,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ) if isinstance(warning, Mapping) else str(warning)
                if key in warning_keys:
                    continue
                warning_keys.add(key)
                quality_warnings.append(warning)
            audit_with_warnings = (
                polish_audits[-1]
                if polish_audits
                else draft_audits[-1] if draft_audits else None
            )
            if audit_with_warnings is not None and quality_warnings:
                parsed_with_warnings = dict(
                    audit_with_warnings.get("parsed") or {}
                )
                parsed_with_warnings["quality_warnings"] = quality_warnings
                audit_with_warnings["parsed"] = parsed_with_warnings
            matched_claim_ids = frozenset(
                str(claim_id) for claim_id in packet.matched_claim_ids
            )
            outcome = TranslationOutcome(
                block=block,
                knowledge_version=knowledge_version,
                memory_version=packet.memory_version,
                snapshot_id=packet.snapshot_id,
                context_hash=packet.context_hash,
                style_snapshot_id=packet.style_snapshot_id,
                style_anchor_id=packet.style_anchor_id or "",
                discourse_state_hash=packet.discourse_state_hash,
                status=status,
                draft_translation=result.draft_translation or "",
                final_translation=result.final_translation or "",
                analysis=result.analysis or "",
                semantic_obligations=result.semantic_obligations or "",
                memory_summary=result.memory_summary or "",
                warnings=quality_warnings,
                term_proposals=term_proposals,
                relation_proposals=relation_proposals,
                matched_concept_ids=list(packet.matched_concept_ids),
                matched_renderings=frozen_render_matches,
                claim_dependencies=tuple(
                    ClaimDependencySnapshot(
                        claim_id=str(claim["id"]),
                        semantic_fingerprint=str(claim["semantic_fingerprint"]),
                    )
                    for claim in frozen_claims_by_block.get(block.id, ())
                    if str(claim["id"]) in matched_claim_ids
                ),
                narrative_dependencies=tuple(
                    NarrativeDependencySnapshot(
                        memory_id=memory.id,
                        semantic_fingerprint=memory.semantic_fingerprint,
                    )
                    for memory in (
                        narrative_context.retrieval.memories
                        if narrative_context is not None
                        else ()
                    )
                ),
                supplemental_memory_candidates=list(
                    result.supplemental_memory_candidates or []
                ),
                style_delta=dict(result.style_delta or {}),
                audit_calls=block_audits,
                attempts=attempts,
                elapsed_ms=int((time.perf_counter() - started) * 1000),
                error=result.error_message,
            )
            outcome.quality_warnings = quality_warnings
            outcomes.append(outcome)
            if status == V4BlockStatus.FAILED_RETRYABLE.value:
                break
            previous_source = block.source_text
            previous_translation = outcome.final_translation
            local_summary = outcome.memory_summary
        return outcomes

    def translate_block_factory(self) -> Callable[[V4Block], TranslationOutcome]:
        """Build the normal frozen-bundle translator used by revalidation."""

        def translate_block(block: V4Block) -> TranslationOutcome:
            if not isinstance(block, V4Block):
                raise TypeError("retranslation requires a V4Block")
            bundle = self.database.freeze_render_bundle([block.id])
            self._active_render_bundle = bundle
            active = self.database.active_translations("parallel_v4").get(
                block.id, {}
            )
            if (
                self.config.enable_narrative_premap
                or int(active.get("memory_version") or 1) > 1
                or bool(active.get("snapshot_id"))
            ):
                narrative_context = (
                    self._retranslation_narrative_context(
                        block, bundle.knowledge_version
                    )
                )
                self._active_narrative_contexts = {
                    block.id: narrative_context
                }
            style_snapshot = (
                self.narrative_store.latest_style_snapshot_before(
                    block.global_index,
                    source_edition_id=block.source_edition_id,
                )
            )
            self._active_style_snapshots = (
                {block.id: style_snapshot}
                if style_snapshot is not None
                else {}
            )
            outcomes = self._translate_island(
                Island(id=f"revalidate-{block.id}", blocks=[block]),
                bundle.knowledge_version,
                bundle.index,
            )
            if len(outcomes) != 1 or outcomes[0].block.id != block.id:
                raise RuntimeError("retranslation structure did not return one full block")
            return outcomes[0]

        return translate_block

    def premap(
        self,
        *,
        block_ids: Sequence[str] = (),
        max_blocks: int | None = None,
    ) -> Dict[str, Any]:
        """Run the fused narrative premap without translating any prose."""

        if max_blocks is not None and (
            type(max_blocks) is not int or max_blocks < 0
        ):
            raise ValueError("max_blocks must be a non-negative integer")
        blocks = self.database.list_blocks()
        requested = set(str(value) for value in block_ids)
        if requested:
            positions = [
                index
                for index, block in enumerate(blocks)
                if block.id in requested
            ]
            missing = requested - {blocks[index].id for index in positions}
            if missing:
                raise KeyError(f"unknown premap block: {sorted(missing)[0]}")
            blocks = blocks[: max(positions) + 1] if positions else []
        if max_blocks is not None:
            blocks = blocks[:max_blocks]
        self._premap_contexts = {}
        self._premap_cursor = -1
        self._premap_tail_snapshot = None
        self._premap_tail_state = DiscourseState()
        self._premap_cache_hits = 0
        self._premap_model_calls = 0
        run_id = f"premap_{uuid4().hex}"
        knowledge_version = self.database.current_knowledge_version()
        self.database.start_run(
            run_id,
            "premap",
            {
                "max_blocks": max_blocks,
                "block_ids": sorted(requested),
                "narrative_premap_mode": True,
            },
            knowledge_version=knowledge_version,
        )
        try:
            if blocks:
                self._ensure_premapped(
                    blocks,
                    through_position=len(blocks) - 1,
                    knowledge_version=knowledge_version,
                    run_id=run_id,
                )
            self.database.finish_run(run_id, "completed")
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc)[:1024])
            raise
        return {
            "run_id": run_id,
            "status": "completed",
            "premapped": len(blocks),
            "requested_block_ids": sorted(requested),
            "premap_cursor": (
                blocks[self._premap_cursor].global_index
                if blocks and self._premap_cursor >= 0
                else -1
            ),
            "premap_cache_hits": self._premap_cache_hits,
            "premap_model_calls": self._premap_model_calls,
            "memory_version": self.narrative_store.current_memory_version(),
        }

    def rebuild_snapshots(
        self, *, from_index: int = 0
    ) -> Dict[str, Any]:
        if type(from_index) is not int or from_index < 0:
            raise ValueError("from_index must be a non-negative integer")
        blocks = [
            block
            for block in self.database.list_blocks()
            if block.global_index >= from_index
        ]
        previous = self.narrative_store.latest_snapshot_before(
            from_index,
            source_edition_id=(
                blocks[0].source_edition_id if blocks else None
            ),
        )
        state = (
            previous.discourse_state if previous is not None else DiscourseState()
        )
        knowledge_version = self.database.current_knowledge_version()
        rebuilt = skipped = 0
        snapshot_ids: list[str] = []
        for block in blocks:
            result = self.narrative_store.latest_premap_result_for_block(
                block.id
            )
            if result is None:
                skipped += 1
                continue
            prior_state = state
            state = apply_discourse_delta(state, result.discourse_delta)
            snapshot = self.narrative_store.build_snapshot(
                block,
                knowledge_version=knowledge_version,
                memory_version=self.narrative_store.current_memory_version(),
                discourse_state=state,
            )
            rebuilt += 1
            snapshot_ids.append(snapshot.id)
        return {
            "status": "completed",
            "from_index": from_index,
            "rebuilt": rebuilt,
            "skipped": skipped,
            "snapshot_ids": snapshot_ids,
            "memory_version": self.narrative_store.current_memory_version(),
        }

    def _retranslation_narrative_context(
        self, block: V4Block, knowledge_version: int
    ) -> NarrativeBlockContext:
        active = self.database.active_translations("parallel_v4").get(
            block.id, {}
        )
        previous_snapshot = None
        if active.get("snapshot_id"):
            previous_snapshot = self.narrative_store.load_snapshot(
                str(active["snapshot_id"])
            )
        if previous_snapshot is None:
            previous_snapshot = (
                self.narrative_store.latest_snapshot_for_block(block.id)
            )
        discourse_state = (
            previous_snapshot.discourse_state
            if previous_snapshot is not None
            else DiscourseState()
        )
        result = (
            self.narrative_store.latest_premap_result_for_block(block.id)
            or NarrativePremapResult(
                semantic_relations=(),
                memory_candidates=(),
                discourse_delta=DiscourseDelta(),
                validation_warnings=(
                    "retranslation reused persisted discourse without "
                    "a cached premap result",
                ),
                degraded=True,
            )
        )
        provisional_subjects = self._provisional_subjects(
            block, discourse_state
        )
        matched_subject_ids = tuple(
            value["id"] for value in provisional_subjects
        )
        snapshot = self.narrative_store.build_snapshot(
            block,
            knowledge_version=knowledge_version,
            memory_version=self.narrative_store.current_memory_version(),
            discourse_state=discourse_state,
        )
        semantic_relation_memory_ids = tuple(
            dict.fromkeys(
                memory_id
                for relation in result.semantic_relations
                for memory_id in relation.related_memory_ids
            )
        )
        retrieval = self.narrative_store.retrieve_for_block(
            block,
            snapshot,
            matched_subject_ids=matched_subject_ids,
            semantic_relation_memory_ids=semantic_relation_memory_ids,
            max_chars=self.config.max_narrative_context_chars,
        )
        return NarrativeBlockContext(
            result=result,
            snapshot=snapshot,
            retrieval=retrieval,
            signals=self._narrative_signals(
                block, result, discourse_state, discourse_state
            ),
            matched_subject_ids=matched_subject_ids,
            source_structure=self._source_structure(block),
        )

    def _run_narrative(
        self,
        candidates: Sequence[V4Block],
        *,
        premap_blocks: Sequence[V4Block] | None = None,
    ) -> Dict[str, Any]:
        premap_sequence = list(premap_blocks or candidates)

        def ensure_through_candidate(
            candidate_position: int,
            *,
            knowledge_version: int,
            run_id: str,
        ) -> None:
            if not candidates or not premap_sequence:
                return
            target_global_index = candidates[
                min(len(candidates) - 1, candidate_position)
            ].global_index
            through_position = -1
            for index, block in enumerate(premap_sequence):
                if block.global_index > target_global_index:
                    break
                through_position = index
            if through_position >= 0:
                self._ensure_premapped(
                    premap_sequence,
                    through_position=through_position,
                    knowledge_version=knowledge_version,
                    run_id=run_id,
                )

        run_id = f"translate_{uuid4().hex}"
        run_config = dict(self.config.__dict__)
        run_config["knowledge_epoch_mode"] = True
        run_config["narrative_premap_mode"] = True
        completed = warnings = failed = manual = 0
        paused = False
        knowledge_stale = False
        change_ids: set[int] = set()
        deferred_proposals = 0
        cursor = 0
        final_workers = 1
        epoch_coordinator = KnowledgeEpochCoordinator(
            self.database,
            [block.id for block in candidates],
            max_knowledge_epochs=self.config.max_knowledge_epochs,
            decision_mode=self.config.decision_mode,
            pause_on_review=self.config.pause_on_review,
        )
        try:
            epoch = epoch_coordinator.freeze()
            render_bundle = epoch.render_bundle
            knowledge_version = epoch.knowledge_version
            initial_knowledge_version = knowledge_version
            concept_snapshot = render_bundle.index
            target_signature = render_bundle.signature
            self._active_render_bundle = render_bundle
        except KnowledgeSnapshotError as exc:
            self.database.fail_run_for_invalid_snapshot(
                run_id, "translate", run_config, exc
            )
            return {
                "run_id": run_id,
                "status": "failed",
                "completed": 0,
                "completed_with_warnings": 0,
                "failed_retryable": 0,
                "incomplete_requires_human": 0,
                "remaining_islands": len(candidates),
                "final_workers": 1,
                "knowledge_stale": False,
                "frozen_knowledge_version": None,
                "knowledge_epoch": None,
                "deferred_proposals": 0,
                "change_ids": [],
                "premap_cursor": -1,
                "translation_cursor": -1,
                "premap_cache_hits": 0,
                "premap_model_calls": 0,
            }
        run_config["frozen_knowledge_version"] = knowledge_version
        run_config["initial_knowledge_epoch"] = epoch.ordinal
        run_config["render_context_block_ids"] = list(render_bundle.block_ids)
        self.database.start_run(
            run_id,
            "translate",
            run_config,
            knowledge_version=knowledge_version,
        )
        adaptive_worker_cap = self.config.max_workers
        try:
            while cursor < len(candidates):
                through = min(
                    len(candidates) - 1,
                    cursor + self.config.premap_ahead_blocks - 1,
                )
                ensure_through_candidate(
                    through,
                    knowledge_version=knowledge_version,
                    run_id=run_id,
                )
                current_block = candidates[cursor]
                current_context = self._premap_contexts[current_block.id]
                plan = (
                    self.narrative_scheduler.plan(current_context.signals)
                    if self.config.dynamic_scheduling
                    else self.narrative_scheduler.plan(
                        NarrativeSignals(global_index=current_block.global_index)
                    )
                )
                desired_workers = max(
                    1, min(plan.workers, adaptive_worker_cap)
                )
                block_limit = max(
                    1, desired_workers * plan.island_size
                )
                ensure_through_candidate(
                    cursor + block_limit - 1,
                    knowledge_version=knowledge_version,
                    run_id=run_id,
                )
                planned_blocks = list(
                    candidates[cursor : cursor + block_limit]
                )
                boundary_indexes = {
                    block.global_index
                    for block in planned_blocks[1:]
                    if (
                        self._premap_contexts[block.id].signals.premap_degraded
                        or self.narrative_scheduler.score(
                            self._premap_contexts[block.id].signals
                        )[0]
                        >= self.narrative_scheduler.high_threshold
                        or any(
                            reason in {
                                "viewpoint_shift",
                                "narrator_layer_shift",
                                "presentation_layer_shift",
                                "time_shift",
                                "location_shift",
                            }
                            for reason in self.narrative_scheduler.score(
                                self._premap_contexts[block.id].signals
                            )[1]
                        )
                    )
                }
                islands = self.narrative_scheduler.make_islands(
                    planned_blocks,
                    island_size=plan.island_size,
                    boundary_indexes=boundary_indexes,
                )
                wave = islands[:desired_workers]
                wave_blocks = [
                    block for island in wave for block in island.blocks
                ]
                self._active_narrative_contexts = {
                    block.id: self._translation_narrative_context(
                        block, knowledge_version
                    )
                    for block in wave_blocks
                }
                self._active_style_snapshots = (
                    {
                        block.id: self._style_tail_snapshot
                        for block in wave_blocks
                    }
                    if self._style_tail_snapshot is not None
                    else {}
                )
                wave_outcomes: List[TranslationOutcome] = []
                final_workers = max(1, len(wave))
                with ThreadPoolExecutor(
                    max_workers=final_workers
                ) as executor:
                    futures = {
                        executor.submit(
                            self._translate_island,
                            island,
                            knowledge_version,
                            concept_snapshot,
                        ): island
                        for island in wave
                    }
                    for future in as_completed(futures):
                        wave_outcomes.extend(future.result())
                with self.database.transaction() as connection:
                    self.database.commit_translation_batch(
                        run_id,
                        wave_outcomes,
                        audit_mode=self.config.audit_mode,
                        connection=connection,
                    )
                    for outcome in sorted(
                        wave_outcomes,
                        key=lambda value: value.block.global_index,
                    ):
                        if outcome.status not in {
                            V4BlockStatus.COMPLETED.value,
                            V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                        }:
                            continue
                        if outcome.style_delta:
                            self._style_tail_snapshot = (
                                self.narrative_store.merge_style_delta(
                                    outcome.block,
                                    outcome.style_delta,
                                    previous_snapshot_id=str(
                                        (
                                            self._style_tail_snapshot
                                            or {}
                                        ).get("id")
                                        or ""
                                    ),
                                    connection=connection,
                                )
                            )
                    epoch_coordinator.stage(
                        run_id,
                        wave_outcomes,
                        connection=connection,
                    )
                    epoch_coordinator.checkpoint_in_transaction(
                        run_id,
                        connection,
                    )
                checkpoint = epoch_coordinator.checkpoint(run_id)
                change_ids.update(checkpoint.change_ids)
                deferred_proposals = checkpoint.deferred_proposals
                completed += sum(
                    outcome.status == V4BlockStatus.COMPLETED.value
                    for outcome in wave_outcomes
                )
                warnings += sum(
                    outcome.status
                    == V4BlockStatus.COMPLETED_WITH_WARNINGS.value
                    for outcome in wave_outcomes
                )
                failed += sum(
                    outcome.status == V4BlockStatus.FAILED_RETRYABLE.value
                    for outcome in wave_outcomes
                )
                manual += sum(
                    outcome.status
                    == V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value
                    for outcome in wave_outcomes
                )
                wave_has_problem = any(
                    outcome.status
                    in {
                        V4BlockStatus.FAILED_RETRYABLE.value,
                        V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
                    }
                    for outcome in wave_outcomes
                )
                if wave_has_problem:
                    adaptive_worker_cap = max(
                        1, adaptive_worker_cap - 1
                    )
                elif adaptive_worker_cap < self.config.max_workers:
                    adaptive_worker_cap += 1
                cursor += len(wave_blocks)
                epoch = checkpoint.epoch
                render_bundle = epoch.render_bundle
                knowledge_version = epoch.knowledge_version
                concept_snapshot = render_bundle.index
                target_signature = render_bundle.signature
                self._active_render_bundle = render_bundle
                if checkpoint.paused:
                    paused = True
                    break
            desired_status = (
                "paused_for_review"
                if paused
                else "completed_with_errors"
                if failed or manual
                else "completed"
            )
            status, finalized_knowledge_stale = (
                self.database.finish_translation_run_atomically(
                    run_id,
                    target_signature,
                    desired_status,
                    force_revalidate=knowledge_stale,
                    context_block_ids=render_bundle.block_ids,
                )
            )
            final_checkpoint = epoch_coordinator.checkpoint(run_id)
            change_ids.update(final_checkpoint.change_ids)
            deferred_proposals = final_checkpoint.deferred_proposals
            epoch = final_checkpoint.epoch
            if final_checkpoint.paused and status != "paused_for_review":
                status = "paused_for_review"
                self.database.finish_run(run_id, status)
            knowledge_stale = (
                knowledge_stale or finalized_knowledge_stale
            )
        except KnowledgeSnapshotError as exc:
            self.database.fail_run_for_invalid_snapshot(
                run_id, "translate", run_config, exc
            )
            status = "failed"
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc))
            raise
        return {
            "run_id": run_id,
            "status": status,
            "completed": completed,
            "completed_with_warnings": warnings,
            "failed_retryable": failed,
            "incomplete_requires_human": manual,
            "remaining_islands": max(0, len(candidates) - cursor),
            "final_workers": final_workers,
            "knowledge_stale": knowledge_stale,
            "frozen_knowledge_version": initial_knowledge_version,
            "knowledge_epoch": epoch.ordinal,
            "deferred_proposals": deferred_proposals,
            "change_ids": sorted(change_ids),
            "premap_cursor": (
                self._premap_tail_snapshot.global_index
                if self._premap_tail_snapshot is not None
                else -1
            ),
            "translation_cursor": (
                candidates[cursor - 1].global_index
                if cursor > 0
                else -1
            ),
            "premap_cache_hits": self._premap_cache_hits,
            "premap_model_calls": self._premap_model_calls,
        }

    def run(self) -> Dict[str, Any]:
        eligible_statuses = [
            V4BlockStatus.READY.value,
            V4BlockStatus.FAILED_RETRYABLE.value,
            V4BlockStatus.NEEDS_REVALIDATE.value,
        ]
        if self.config.force:
            eligible_statuses.extend(
                [
                    V4BlockStatus.COMPLETED.value,
                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                ]
            )
        eligible = self.database.list_blocks(eligible_statuses)
        active = self.database.active_translations("parallel_v4")
        candidates = [
            block
            for block in eligible
            if self.config.force or not (
                block.id in active
                and active[block.id]["status"]
                in {
                    V4BlockStatus.COMPLETED.value,
                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                }
            )
        ]
        if self.config.include_block_ids:
            included = set(self.config.include_block_ids)
            candidates = [block for block in candidates if block.id in included]
        if self.config.max_blocks is not None:
            candidates = candidates[: self.config.max_blocks]
        if self.config.enable_narrative_premap:
            self._premap_contexts = {}
            self._premap_cursor = -1
            self._premap_tail_snapshot = (
                self.narrative_store.latest_snapshot_before(
                    candidates[0].global_index,
                    source_edition_id=candidates[0].source_edition_id,
                )
                if candidates
                else None
            )
            self._premap_tail_state = (
                self._premap_tail_snapshot.discourse_state
                if self._premap_tail_snapshot is not None
                else DiscourseState()
            )
            self._premap_cache_hits = 0
            self._premap_model_calls = 0
            self._style_tail_snapshot = (
                self.narrative_store.latest_style_snapshot_before(
                    candidates[0].global_index,
                    source_edition_id=candidates[0].source_edition_id,
                )
                if candidates
                else None
            )
            self._active_style_snapshots = {}
            seed_global_index = (
                self._premap_tail_snapshot.global_index
                if self._premap_tail_snapshot is not None
                else -1
            )
            max_candidate_index = (
                max(block.global_index for block in candidates)
                if candidates
                else -1
            )
            premap_blocks = [
                block
                for block in self.database.list_blocks()
                if seed_global_index < block.global_index <= max_candidate_index
            ]
            return self._run_narrative(
                candidates,
                premap_blocks=premap_blocks,
            )
        islands = self._make_islands(candidates, self.config.island_size)
        run_id = f"translate_{uuid4().hex}"
        run_config = dict(self.config.__dict__)
        run_config["knowledge_epoch_mode"] = True
        workers = min(self.config.initial_workers, self.config.max_workers)
        completed = warnings = failed = manual = 0
        paused = False
        knowledge_stale = False
        change_ids: set[int] = set()
        deferred_proposals = 0
        cursor = 0
        epoch_coordinator = KnowledgeEpochCoordinator(
            self.database,
            [block.id for block in candidates],
            max_knowledge_epochs=self.config.max_knowledge_epochs,
            decision_mode=self.config.decision_mode,
            pause_on_review=self.config.pause_on_review,
        )
        try:
            epoch = epoch_coordinator.freeze()
            render_bundle = epoch.render_bundle
            knowledge_version = epoch.knowledge_version
            initial_knowledge_version = knowledge_version
            concept_snapshot = render_bundle.index
            target_signature = render_bundle.signature
            self._active_render_bundle = render_bundle
        except KnowledgeSnapshotError as exc:
            self.database.fail_run_for_invalid_snapshot(
                run_id, "translate", run_config, exc
            )
            return {
                "run_id": run_id,
                "status": "failed",
                "completed": 0,
                "completed_with_warnings": 0,
                "failed_retryable": 0,
                "incomplete_requires_human": 0,
                "remaining_islands": len(islands),
                "final_workers": workers,
                "knowledge_stale": False,
                "frozen_knowledge_version": None,
                "knowledge_epoch": None,
                "deferred_proposals": 0,
                "change_ids": [],
            }
        run_config["frozen_knowledge_version"] = knowledge_version
        run_config["initial_knowledge_epoch"] = epoch.ordinal
        run_config["render_context_block_ids"] = list(render_bundle.block_ids)
        self.database.start_run(
            run_id,
            "translate",
            run_config,
            knowledge_version=knowledge_version,
        )
        try:
            while cursor < len(islands):
                wave = islands[cursor : cursor + workers]
                wave_outcomes: List[TranslationOutcome] = []
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    futures = {
                        executor.submit(
                            self._translate_island,
                            island,
                            knowledge_version,
                            concept_snapshot,
                        ): island
                        for island in wave
                    }
                    for future in as_completed(futures):
                        wave_outcomes.extend(future.result())
                with self.database.transaction() as connection:
                    self.database.commit_translation_batch(
                        run_id,
                        wave_outcomes,
                        audit_mode=self.config.audit_mode,
                        connection=connection,
                    )
                    epoch_coordinator.stage(
                        run_id,
                        wave_outcomes,
                        connection=connection,
                    )
                    epoch_coordinator.checkpoint_in_transaction(
                        run_id,
                        connection,
                    )
                checkpoint = epoch_coordinator.checkpoint(run_id)
                change_ids.update(checkpoint.change_ids)
                deferred_proposals = checkpoint.deferred_proposals
                completed += sum(o.status == V4BlockStatus.COMPLETED.value for o in wave_outcomes)
                warnings += sum(
                    o.status == V4BlockStatus.COMPLETED_WITH_WARNINGS.value
                    for o in wave_outcomes
                )
                failed += sum(o.status == V4BlockStatus.FAILED_RETRYABLE.value for o in wave_outcomes)
                manual += sum(
                    o.status == V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value
                    for o in wave_outcomes
                )
                wave_has_problem = any(
                    o.status
                    in {
                        V4BlockStatus.FAILED_RETRYABLE.value,
                        V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
                    }
                    for o in wave_outcomes
                )
                if wave_has_problem:
                    workers = max(1, workers - 1)
                elif workers < self.config.max_workers:
                    workers += 1
                cursor += len(wave)
                epoch = checkpoint.epoch
                render_bundle = epoch.render_bundle
                knowledge_version = epoch.knowledge_version
                concept_snapshot = render_bundle.index
                target_signature = render_bundle.signature
                self._active_render_bundle = render_bundle
                if checkpoint.paused:
                    paused = True
                    break
            desired_status = "paused_for_review" if paused else (
                "completed_with_errors" if failed or manual else "completed"
            )
            status, finalized_knowledge_stale = (
                self.database.finish_translation_run_atomically(
                    run_id,
                    target_signature,
                    desired_status,
                    force_revalidate=knowledge_stale,
                    context_block_ids=render_bundle.block_ids,
                )
            )
            final_checkpoint = epoch_coordinator.checkpoint(run_id)
            change_ids.update(final_checkpoint.change_ids)
            deferred_proposals = final_checkpoint.deferred_proposals
            epoch = final_checkpoint.epoch
            if final_checkpoint.paused and status != "paused_for_review":
                status = "paused_for_review"
                self.database.finish_run(run_id, status)
            knowledge_stale = knowledge_stale or finalized_knowledge_stale
        except KnowledgeSnapshotError as exc:
            self.database.fail_run_for_invalid_snapshot(
                run_id, "translate", run_config, exc
            )
            status = "failed"
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc))
            raise
        return {
            "run_id": run_id,
            "status": status,
            "completed": completed,
            "completed_with_warnings": warnings,
            "failed_retryable": failed,
            "incomplete_requires_human": manual,
            "remaining_islands": max(0, len(islands) - cursor),
            "final_workers": workers,
            "knowledge_stale": knowledge_stale,
            "frozen_knowledge_version": initial_knowledge_version,
            "knowledge_epoch": epoch.ordinal,
            "deferred_proposals": deferred_proposals,
            "change_ids": sorted(change_ids),
        }
