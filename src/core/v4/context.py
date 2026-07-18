"""Build required, non-spoiling context packets for one translation block."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .database import V4Database
from .matcher import FrozenRenderIndex
from .models import ContextPacket, V4Block
from .narrative_models import (
    NarrativeRetrieval,
    NarrativeSnapshot,
    SemanticRelation,
    render_narrative_memory,
)
from .prompt_projection import (
    PromptBudgetPolicy,
    PromptProjector,
    PromptSection,
    StyleAnchorCandidate,
)


class ContextOverflow(RuntimeError):
    def __init__(self, block_id: str, required_chars: int, budget_chars: int):
        self.block_id = block_id
        self.required_chars = required_chars
        self.budget_chars = budget_chars
        super().__init__(
            f"{block_id} 必需上下文 {required_chars} 字符超过预算 {budget_chars}；需要人工处理"
        )


class ContextBuilder:
    def __init__(
        self,
        database: V4Database,
        max_context_chars: int = 24000,
        budget_policy: PromptBudgetPolicy | None = None,
    ):
        self.database = database
        self.max_context_chars = max_context_chars
        self.prompt_projector = PromptProjector(
            budget_policy or PromptBudgetPolicy()
        )

    @staticmethod
    def _render_concepts(concepts: List[dict]) -> str:
        if not concepts:
            return "（当前块没有命中的已知概念）"
        rendered = []
        for concept in concepts:
            effective_target = str(concept.get("default_target") or "").strip()
            strength = concept.get("target_strength") or "unset"
            if effective_target:
                strength_label = "已核验" if strength == "verified" else "工作译名"
                target_line = f"{effective_target}（{strength_label}）"
            else:
                target_line = "（未定）"
            lines = [
                f"- {concept['source']}",
                f"  核心译名: {target_line}",
                f"  concept_id: {concept['id']}",
            ]
            if concept.get("description"):
                lines.append(f"  概念含义: {concept['description']}")
            profile = concept.get("term_profile") or {}
            semantic_core = str(profile.get("semantic_core") or "").strip()
            if semantic_core:
                lines.append(f"  语义边界: {semantic_core}")
            contrast_sources = [
                str(value).strip()
                for value in profile.get("contrast_sources") or []
                if str(value).strip()
            ]
            if contrast_sources:
                lines.append(
                    "  须与以下原文词保持区别: "
                    + "、".join(contrast_sources)
                )
            for rule in concept.get("rules", []):
                condition = rule.get("condition") or {}
                target = str(rule.get("target") or "").strip()
                if not target:
                    continue
                lines.append(
                    f"  语境规则: {json.dumps(condition, ensure_ascii=False)} → {target}"
                )
            rendered.append("\n".join(lines))
        return "\n".join(rendered)

    @staticmethod
    def _render_prior_concept_evidence(evidence: List[dict]) -> str:
        if not evidence:
            return "（没有命中的前文概念证据）"
        return "\n\n".join(
            (
                f"- [{item['legacy_id']} {item['paragraph_id']}] "
                f"与 {item['concept_source']} 相关的前文原文：\n"
                f"  {item['source_text']}"
            )
            for item in evidence
        )

    @staticmethod
    def _render_semantic_relations(
        relations: Sequence[SemanticRelation],
    ) -> str:
        if not relations:
            return "（当前块没有额外的跨句语义义务）"
        return "\n".join(
            (
                f"- {relation.relation_type} / "
                f"{relation.inference_strength}: "
                f"{relation.translation_constraint} "
                f"[原文片段: {' | '.join(relation.source_spans)}]"
            )
            for relation in relations
        )

    @staticmethod
    def _render_narrative_memory(retrieval: NarrativeRetrieval) -> str:
        if not retrieval.memories:
            return "（当前位置没有命中的叙事记忆）"
        required = set(retrieval.required_memory_ids)
        return "\n".join(
            render_narrative_memory(
                memory, required=memory.id in required
            )
            for memory in retrieval.memories
        )

    def build(
        self,
        block: V4Block,
        previous_source: str = "",
        previous_translation: str = "",
        local_summary: str = "",
        knowledge_version: Optional[int] = None,
        concept_snapshot: Optional[Sequence[Dict[str, Any]]] = None,
        frozen_claims: Optional[Sequence[Mapping[str, Any]]] = None,
        frozen_prior_concept_evidence: Optional[
            Sequence[Mapping[str, Any]]
        ] = None,
        narrative_snapshot: Optional[NarrativeSnapshot] = None,
        narrative_retrieval: Optional[NarrativeRetrieval] = None,
        semantic_relations: Sequence[SemanticRelation] = (),
        source_structure: Optional[Mapping[str, Any]] = None,
        style_snapshot: Optional[Mapping[str, Any]] = None,
        style_anchor_candidates: Sequence[StyleAnchorCandidate] = (),
        source_style_confidence: float = 0.0,
    ) -> ContextPacket:
        version = (
            knowledge_version
            if knowledge_version is not None
            else self.database.current_knowledge_version()
        )
        concepts = self.database.concepts_for_text(
            block.source_text, concept_snapshot=concept_snapshot
        )
        if isinstance(concept_snapshot, FrozenRenderIndex) and (
            frozen_claims is None or frozen_prior_concept_evidence is None
        ):
            raise RuntimeError(
                "frozen claims and prior evidence are required with a frozen render index"
            )
        claims = (
            [dict(claim) for claim in frozen_claims]
            if frozen_claims is not None
            else self.database.claims_for_block(block)
        )
        prior_evidence = (
            [dict(item) for item in frozen_prior_concept_evidence]
            if frozen_prior_concept_evidence is not None
            else self.database.prior_concept_source_evidence(block, concepts)
        )
        if (narrative_snapshot is None) != (narrative_retrieval is None):
            raise ValueError(
                "narrative snapshot and retrieval must be supplied together"
            )
        style_state = dict((style_snapshot or {}).get("state") or {})
        syntax_features = style_state.get("syntax_features") or ()
        if isinstance(syntax_features, str):
            syntax_features = (syntax_features,)
        style_material = self.prompt_projector.build_style_material(
            stage="polish",
            style_state=style_state,
            anchor_candidates=style_anchor_candidates,
            current_global_index=block.global_index,
            current_text_type=str(
                style_state.get("text_type") or block.block_type or "prose"
            ),
            current_narrative_layer=str(
                style_state.get("narrative_layer") or ""
            ),
            current_register=str(style_state.get("register") or ""),
            current_syntax_features=tuple(syntax_features),
            current_source_style_confidence=source_style_confidence,
        )
        hard_concepts = [
            concept
            for concept in concepts
            if str(concept.get("target_strength") or "") == "verified"
            or bool(concept.get("rules"))
        ]
        working_concepts = [
            concept for concept in concepts if concept not in hard_concepts
        ]
        hard_constraints = "\n".join(
            [
                "<translation_constraints>",
                "只使用当前位置可知的信息；不得根据后文推断身份、性别或谜底。",
                "概念含义用于理解世界机制，不得把定义逐字扩写进正文；核心译名可按中文句法添加方位、所属、量词等成分。",
                self._render_concepts(hard_concepts),
                "可用的保守翻译约束：",
                *(f"- {claim['statement']}" for claim in claims),
                "</translation_constraints>",
            ]
        )
        working_context = (
            "<working_concepts>\n"
            "以下工作概念仅用于一致性；当前英文语境优先：\n"
            f"{self._render_concepts(working_concepts)}\n"
            "</working_concepts>"
            if working_concepts
            else ""
        )
        constraints = "\n".join(
            value for value in (hard_constraints, working_context) if value
        )
        structure = "\n".join(
            [
                "<source_structure>",
                json.dumps(
                    dict(source_structure or {}),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "</source_structure>",
            ]
        )
        relations = "\n".join(
            [
                "<semantic_relations>",
                self._render_semantic_relations(semantic_relations),
                "</semantic_relations>",
            ]
        )
        parts = [constraints, structure, relations]
        sections: list[PromptSection] = [
            PromptSection(
                "source",
                f"<text_to_translate>\n{block.source_text}\n</text_to_translate>",
                priority=0,
                required=True,
            ),
            PromptSection(
                "constraints", hard_constraints, priority=0, required=True
            ),
            PromptSection("source_structure", structure, priority=0, required=True),
            PromptSection("semantic_relations", relations, priority=0, required=True),
        ]
        if working_context:
            sections.append(
                PromptSection(
                    "working_concepts",
                    working_context,
                    priority=1,
                    marginal_utility=0.85,
                )
            )
        if narrative_snapshot is not None and narrative_retrieval is not None:
            narrative = "\n".join(
                [
                    "<narrative_memory>",
                    "只使用当前位置已经开放的信息；保守提示不得被扩写成原文没有明说的事实。",
                    self._render_narrative_memory(narrative_retrieval),
                    "</narrative_memory>",
                ]
            )
            discourse = "\n".join(
                [
                    "<discourse_state>",
                    json.dumps(
                        narrative_snapshot.discourse_state.to_dict(),
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    "</discourse_state>",
                ]
            )
            parts.extend([narrative, discourse])
            sections.extend(
                [
                    PromptSection(
                        "narrative_memory",
                        narrative,
                        priority=1,
                        marginal_utility=0.95,
                    ),
                    PromptSection(
                        "discourse_state",
                        discourse,
                        priority=1,
                        marginal_utility=0.9,
                    ),
                ]
            )
        style_section = PromptSection(
            "style_state",
            f"<style_state>{style_material.directive}</style_state>",
            priority=3,
            marginal_utility=0.65,
        )
        parts.append(style_section.content)
        sections.append(style_section)
        prior = "\n".join(
            [
                "<prior_concept_evidence>",
                "以下是当前概念在当前位置之前的原文用例，只用于恢复已明示的机制和用法，不构成后文解释：",
                self._render_prior_concept_evidence(prior_evidence),
                "</prior_concept_evidence>",
            ]
        )
        parts.append(prior)
        sections.append(
            PromptSection(
                "prior_concept_evidence",
                prior,
                priority=2,
                marginal_utility=0.75,
            )
        )
        if local_summary:
            island_summary = (
                f"<island_summary>\n{local_summary}\n</island_summary>"
            )
            parts.append(island_summary)
            sections.append(
                PromptSection(
                    "island_summary",
                    island_summary,
                    priority=2,
                    marginal_utility=0.55,
                )
            )
        if previous_source or previous_translation:
            previous = "\n".join(
                [
                    "<island_previous>",
                    f"<source_tail>{previous_source[-800:]}</source_tail>",
                    f"<translation_tail>{previous_translation[-1200:]}</translation_tail>",
                    "</island_previous>",
                ]
            )
            parts.append(previous)
            sections.append(
                PromptSection(
                    "island_previous",
                    previous,
                    priority=3,
                    marginal_utility=0.45,
                )
            )
        required_chars = sum(
            len(section.content) for section in sections if section.required
        )
        if required_chars > self.max_context_chars:
            raise ContextOverflow(block.id, required_chars, self.max_context_chars)
        draft_sections = tuple(sections)
        polish_sections = list(sections)
        if style_material.anchor is not None:
            polish_sections.append(
                PromptSection(
                    "style_anchor",
                    style_material.anchor.rendered,
                    priority=4,
                    marginal_utility=0.45,
                    dependency_ids=(style_material.anchor.anchor_id,),
                )
            )
        draft_projection = self.prompt_projector.project(
            stage="draft",
            sections=draft_sections,
            max_chars=self.max_context_chars,
        )
        polish_base_projection = self.prompt_projector.project(
            stage="polish",
            sections=tuple(polish_sections),
            max_chars=self.max_context_chars,
        )
        rendered = draft_projection.rendered
        matched_rule_ids = sorted(
            {
                str(rule.get("id") or "")
                for concept in concepts
                for rule in concept.get("rules", [])
                if str(rule.get("id") or "")
            }
        )
        matched_lexeme_ids = sorted(
            {
                str(concept.get("primary_lexeme_id") or "")
                for concept in concepts
                if str(concept.get("primary_lexeme_id") or "")
            }
        )
        discourse_state_hash = (
            hashlib.sha256(
                json.dumps(
                    narrative_snapshot.discourse_state.to_dict(),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            if narrative_snapshot is not None
            else ""
        )
        context_hash = hashlib.sha256(
            json.dumps(
                {
                    "block_id": block.id,
                    "source_hash": block.source_hash,
                    "knowledge_version": version,
                    "memory_version": (
                        narrative_snapshot.memory_version
                        if narrative_snapshot is not None
                        else 1
                    ),
                    "draft_projection": draft_projection.rendered,
                    "draft_included": draft_projection.included_section_ids,
                    "draft_dropped": draft_projection.dropped_section_ids,
                    "polish_projection": polish_base_projection.rendered,
                    "polish_included": polish_base_projection.included_section_ids,
                    "polish_dropped": polish_base_projection.dropped_section_ids,
                    "estimator_version": draft_projection.estimator_version,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        return ContextPacket(
            block_id=block.id,
            knowledge_version=version,
            rendered=rendered,
            required_chars=required_chars,
            memory_version=(
                narrative_snapshot.memory_version
                if narrative_snapshot is not None
                else 1
            ),
            snapshot_id=(
                narrative_snapshot.id if narrative_snapshot is not None else ""
            ),
            matched_lexeme_ids=matched_lexeme_ids,
            matched_concept_ids=[concept["id"] for concept in concepts],
            matched_rule_ids=matched_rule_ids,
            matched_claim_ids=[claim["id"] for claim in claims],
            matched_memory_ids=(
                [memory.id for memory in narrative_retrieval.memories]
                if narrative_retrieval is not None
                else []
            ),
            style_snapshot_id=str(
                (style_snapshot or {}).get("id") or ""
            ),
            discourse_state_hash=discourse_state_hash,
            context_hash=context_hash,
            section_token_estimates=dict(
                draft_projection.section_token_estimates
            ),
            draft_projection=draft_projection,
            polish_base_projection=polish_base_projection,
            draft_sections=draft_sections,
            polish_sections=tuple(polish_sections),
            dropped_optional_sections=list(
                dict.fromkeys(
                    [
                        *draft_projection.dropped_section_ids,
                        *polish_base_projection.dropped_section_ids,
                    ]
                )
            ),
            style_projection=style_material.directive,
            style_anchor_id=(
                style_material.anchor.anchor_id
                if style_material.anchor is not None
                else None
            ),
        )
