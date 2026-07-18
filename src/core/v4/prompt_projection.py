"""Deterministic, auditable prompt budgeting and bounded style projection."""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
from typing import Callable, Iterable, Literal, Mapping, Optional, Sequence


PROMPT_TOKEN_ESTIMATOR_VERSION = "conservative-v1"
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_TOKEN_PART_RE = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"
    r"|[A-Za-z]+(?:['’-][A-Za-z]+)*"
    r"|\d+"
    r"|<[^>]+>"
    r"|[^\s]"
)


def estimate_tokens(
    text: str,
    token_counter: Optional[Callable[[str], int]] = None,
) -> int:
    """Return a deterministic conservative estimate without external packages."""

    value = str(text or "")
    if not value:
        return 0
    if token_counter is not None:
        return max(0, int(token_counter(value)))
    total = 0
    for part in _TOKEN_PART_RE.findall(value):
        if _CJK_RE.fullmatch(part):
            total += 1
        elif part.startswith("<") and part.endswith(">"):
            total += max(1, math.ceil(len(part) / 4))
        elif part.isdigit():
            total += max(1, math.ceil(len(part) / 3))
        elif re.fullmatch(r"[A-Za-z]+(?:['’-][A-Za-z]+)*", part):
            total += max(1, math.ceil(len(part) / 6))
        else:
            total += 1
    return total


@dataclass(frozen=True)
class PromptBudgetPolicy:
    draft_soft_tokens: int = 6000
    polish_soft_tokens: int = 8000
    reserve_ratio: float = 0.20
    style_directive_max_tokens: int = 60
    style_anchor_max_tokens: int = 300
    enable_style_anchors: bool = True
    anchor_quality_threshold: float = 0.80
    anchor_similarity_threshold: float = 0.65
    source_style_sufficient_threshold: float = 0.80

    def __post_init__(self) -> None:
        if self.draft_soft_tokens <= 0 or self.polish_soft_tokens <= 0:
            raise ValueError("prompt token budgets must be positive")
        if not 0.0 <= self.reserve_ratio < 1.0:
            raise ValueError("reserve_ratio must be in [0, 1)")
        if self.style_directive_max_tokens <= 0:
            raise ValueError("style_directive_max_tokens must be positive")
        if self.style_anchor_max_tokens <= 0:
            raise ValueError("style_anchor_max_tokens must be positive")

    def usable_tokens(self, stage: Literal["draft", "polish"]) -> int:
        soft = (
            self.draft_soft_tokens
            if stage == "draft"
            else self.polish_soft_tokens
        )
        return max(1, math.floor(soft * (1.0 - self.reserve_ratio)))


@dataclass(frozen=True)
class PromptSection:
    stable_id: str
    content: str
    priority: int
    required: bool = False
    marginal_utility: float = 1.0
    dependency_ids: tuple[str, ...] = ()
    render: bool = True


@dataclass(frozen=True)
class PromptSectionDecision:
    stable_id: str
    stage: str
    estimated_tokens: int
    included: bool
    reason: str
    priority: int
    marginal_utility: float


@dataclass(frozen=True)
class PromptProjection:
    stage: str
    rendered: str
    estimated_tokens: int
    estimated_chars: int
    budget_tokens: int
    budget_chars: Optional[int]
    reserve_ratio: float
    estimator_version: str
    included_section_ids: tuple[str, ...]
    dropped_section_ids: tuple[str, ...]
    section_token_estimates: Mapping[str, int]
    decisions: Mapping[str, PromptSectionDecision]


class PromptBudgetOverflow(RuntimeError):
    def __init__(
        self,
        stage: str,
        required_tokens: int,
        budget_tokens: int,
        required_section_ids: Sequence[str],
    ) -> None:
        self.stage = stage
        self.required_tokens = required_tokens
        self.budget_tokens = budget_tokens
        self.required_section_ids = tuple(required_section_ids)
        super().__init__(
            f"{stage} 必需提示 {required_tokens} token 超过预算 "
            f"{budget_tokens}；需要人工处理"
        )


@dataclass(frozen=True)
class StyleAnchorCandidate:
    anchor_id: str
    source_block_id: str
    source_global_index: int
    source_text: str
    target_text: str
    quality_score: float
    integrity_passed: bool
    active: bool
    fallback: bool
    text_type: str
    narrative_layer: str = ""
    register: str = ""
    syntax_features: tuple[str, ...] = ()
    usage_count: int = 0
    parent_anchor_id: str = ""
    ancestor_anchor_ids: tuple[str, ...] = ()
    calibration_version: str = ""


@dataclass(frozen=True)
class SelectedStyleAnchor:
    anchor_id: str
    source_block_id: str
    rendered: str
    estimated_tokens: int


@dataclass(frozen=True)
class StyleMaterial:
    directive: str
    controlled_state: Mapping[str, str]
    anchor: Optional[SelectedStyleAnchor] = None


_STYLE_FIELDS = (
    "narrative_distance",
    "register",
    "diction_density",
    "syntax_density",
    "rhythm",
    "dialogue_habit",
    "text_type",
)
_STYLE_ALIASES = {
    "diction": "diction_density",
    "dialogue": "dialogue_habit",
}
_STYLE_LABELS = {
    "narrative_distance": "叙事距离",
    "register": "语域",
    "diction_density": "措辞密度",
    "syntax_density": "句法密度",
    "rhythm": "节奏",
    "dialogue_habit": "对话习惯",
    "text_type": "文本类型",
}


class PromptProjector:
    def __init__(
        self,
        policy: PromptBudgetPolicy,
        token_counter: Optional[Callable[[str], int]] = None,
    ) -> None:
        self.policy = policy
        self.token_counter = token_counter

    def _estimate(self, text: str) -> int:
        return estimate_tokens(text, self.token_counter)

    def project(
        self,
        *,
        stage: Literal["draft", "polish"],
        sections: Sequence[PromptSection],
        max_chars: Optional[int] = None,
    ) -> PromptProjection:
        if stage not in {"draft", "polish"}:
            raise ValueError("stage must be draft or polish")
        if len({section.stable_id for section in sections}) != len(sections):
            raise ValueError("prompt section stable_id values must be unique")
        budget = self.policy.usable_tokens(stage)
        estimates = {
            section.stable_id: self._estimate(section.content)
            for section in sections
        }
        char_estimates = {
            section.stable_id: len(section.content) for section in sections
        }
        required = [section for section in sections if section.required]
        required_tokens = sum(estimates[item.stable_id] for item in required)
        required_chars = sum(
            char_estimates[item.stable_id] for item in required
        )
        if required_tokens > budget:
            raise PromptBudgetOverflow(
                stage,
                required_tokens,
                budget,
                [item.stable_id for item in required],
            )
        if max_chars is not None and required_chars > max_chars:
            raise PromptBudgetOverflow(
                stage,
                required_tokens,
                budget,
                [item.stable_id for item in required],
            )

        included = list(required)
        consumed = required_tokens
        consumed_chars = required_chars
        decisions: dict[str, PromptSectionDecision] = {
            item.stable_id: PromptSectionDecision(
                stable_id=item.stable_id,
                stage=stage,
                estimated_tokens=estimates[item.stable_id],
                included=True,
                reason="required",
                priority=item.priority,
                marginal_utility=item.marginal_utility,
            )
            for item in required
        }
        optional = sorted(
            (section for section in sections if not section.required),
            key=lambda item: (
                -float(item.marginal_utility),
                int(item.priority),
                item.stable_id,
            ),
        )
        for item in optional:
            item_tokens = estimates[item.stable_id]
            item_chars = char_estimates[item.stable_id]
            fits_tokens = consumed + item_tokens <= budget
            fits_chars = (
                max_chars is None
                or consumed_chars + item_chars <= max_chars
            )
            should_include = (
                item.marginal_utility > 0 and fits_tokens and fits_chars
            )
            reason = "utility" if should_include else (
                "non_positive_utility"
                if item.marginal_utility <= 0
                else "soft_budget"
                if not fits_tokens
                else "character_guard"
            )
            if should_include:
                included.append(item)
                consumed += item_tokens
                consumed_chars += item_chars
            decisions[item.stable_id] = PromptSectionDecision(
                stable_id=item.stable_id,
                stage=stage,
                estimated_tokens=item_tokens,
                included=should_include,
                reason=reason,
                priority=item.priority,
                marginal_utility=item.marginal_utility,
            )

        included_ids = tuple(item.stable_id for item in included)
        dropped_ids = tuple(
            item.stable_id for item in sections if item.stable_id not in included_ids
        )
        return PromptProjection(
            stage=stage,
            rendered="\n".join(
                item.content
                for item in included
                if item.content and item.render
            ),
            estimated_tokens=consumed,
            estimated_chars=consumed_chars,
            budget_tokens=budget,
            budget_chars=max_chars,
            reserve_ratio=self.policy.reserve_ratio,
            estimator_version=PROMPT_TOKEN_ESTIMATOR_VERSION,
            included_section_ids=included_ids,
            dropped_section_ids=dropped_ids,
            section_token_estimates=estimates,
            decisions=decisions,
        )

    def build_style_material(
        self,
        *,
        stage: Literal["draft", "polish"],
        style_state: Mapping[str, object] | None,
        anchor_candidates: Sequence[StyleAnchorCandidate] = (),
        current_global_index: int = 0,
        current_text_type: str = "",
        current_narrative_layer: str = "",
        current_register: str = "",
        current_syntax_features: Sequence[str] = (),
        current_lineage_ids: Sequence[str] = (),
        current_source_style_confidence: float = 0.0,
    ) -> StyleMaterial:
        controlled = self._controlled_style_state(style_state or {})
        directive = self._style_directive(controlled)
        if (
            stage != "polish"
            or not self.policy.enable_style_anchors
            or current_source_style_confidence
            >= self.policy.source_style_sufficient_threshold
        ):
            return StyleMaterial(directive, controlled)

        current_lineage = {str(value) for value in current_lineage_ids if value}
        scored: list[tuple[float, str, StyleAnchorCandidate]] = []
        for candidate in anchor_candidates:
            if candidate.source_global_index >= current_global_index:
                continue
            if (
                not candidate.active
                or not candidate.integrity_passed
                or candidate.fallback
                or candidate.quality_score < self.policy.anchor_quality_threshold
            ):
                continue
            if current_text_type and candidate.text_type != current_text_type:
                continue
            ancestry = {
                candidate.anchor_id,
                candidate.parent_anchor_id,
                *candidate.ancestor_anchor_ids,
            }
            ancestry.discard("")
            if ancestry & current_lineage:
                continue
            similarity = self._style_similarity(
                candidate,
                narrative_layer=current_narrative_layer,
                register=current_register,
                syntax_features=current_syntax_features,
            )
            if similarity < self.policy.anchor_similarity_threshold:
                continue
            utility = (
                similarity
                + (candidate.quality_score - self.policy.anchor_quality_threshold)
                - min(0.45, candidate.usage_count * 0.08)
                - 0.08 * len(candidate.ancestor_anchor_ids)
            )
            if utility > 0:
                scored.append((utility, candidate.anchor_id, candidate))
        if not scored:
            return StyleMaterial(directive, controlled)
        candidate = sorted(scored, key=lambda item: (-item[0], item[1]))[0][2]
        rendered = self._render_anchor(candidate)
        return StyleMaterial(
            directive,
            controlled,
            SelectedStyleAnchor(
                anchor_id=candidate.anchor_id,
                source_block_id=candidate.source_block_id,
                rendered=rendered,
                estimated_tokens=self._estimate(rendered),
            ),
        )

    @staticmethod
    def _controlled_style_state(
        style_state: Mapping[str, object],
    ) -> Mapping[str, str]:
        controlled: dict[str, str] = {}
        for raw_key, raw_value in style_state.items():
            key = _STYLE_ALIASES.get(str(raw_key), str(raw_key))
            if key not in _STYLE_FIELDS or raw_value is None:
                continue
            value = " ".join(str(raw_value).split())[:48]
            if value:
                controlled[key] = value
        return controlled

    def _style_directive(self, controlled: Mapping[str, str]) -> str:
        if not controlled:
            return "风格：以当前英文原文为准，不额外统一文风。"
        parts: list[str] = []
        for key in _STYLE_FIELDS:
            value = controlled.get(key)
            if not value:
                continue
            candidate = "风格（非事实）：" + "；".join(
                [*parts, f"{_STYLE_LABELS[key]}={value}"]
            ) + "；当前原文优先。"
            if self._estimate(candidate) > self.policy.style_directive_max_tokens:
                break
            parts.append(f"{_STYLE_LABELS[key]}={value}")
        directive = (
            "风格（非事实）：" + "；".join(parts) + "；当前原文优先。"
            if parts
            else "风格：以当前英文原文为准，不额外统一文风。"
        )
        return directive

    @staticmethod
    def _style_similarity(
        candidate: StyleAnchorCandidate,
        *,
        narrative_layer: str,
        register: str,
        syntax_features: Sequence[str],
    ) -> float:
        components: list[float] = []
        if narrative_layer:
            components.append(float(candidate.narrative_layer == narrative_layer))
        if register:
            components.append(float(candidate.register == register))
        wanted = {str(value) for value in syntax_features if value}
        if wanted:
            available = set(candidate.syntax_features)
            components.append(len(wanted & available) / len(wanted | available))
        return sum(components) / len(components) if components else 0.0

    def _render_anchor(self, candidate: StyleAnchorCandidate) -> str:
        max_tokens = self.policy.style_anchor_max_tokens
        wrapper = "<style_anchor>\n英文：\n中文：\n</style_anchor>"
        remaining = max(2, max_tokens - self._estimate(wrapper))
        source_budget = max(1, remaining // 2)
        target_budget = max(1, remaining - source_budget)
        source = self._fit(candidate.source_text, source_budget)
        target = self._fit(candidate.target_text, target_budget)
        return (
            "<style_anchor>\n"
            f"英文：{source}\n"
            f"中文：{target}\n"
            "</style_anchor>"
        )

    def _fit(self, text: str, budget: int) -> str:
        value = " ".join(str(text or "").split())
        if self._estimate(value) <= budget:
            return value
        low, high = 0, len(value)
        while low < high:
            midpoint = (low + high + 1) // 2
            if self._estimate(value[:midpoint]) <= budget:
                low = midpoint
            else:
                high = midpoint - 1
        return value[:low].rstrip()


def sanitize_style_delta(style_delta: Mapping[str, object]) -> dict[str, str]:
    """Public boundary used before persisting model-provided style deltas."""

    return dict(PromptProjector._controlled_style_state(style_delta))
