"""Deterministic narrative-volatility scoring and dynamic island planning."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from .models import Island, V4Block


@dataclass(frozen=True)
class NarrativeSignals:
    global_index: int
    new_subjects: int = 0
    viewpoint_shift: bool = False
    narrator_layer_shift: bool = False
    presentation_layer_shift: bool = False
    time_shift: bool = False
    location_shift: bool = False
    unresolved_references: int = 0
    contradictions: int = 0
    open_questions: int = 0
    high_impact_memories: int = 0
    uncertain_coreferences: int = 0
    revalidation_volume: int = 0
    dialogue_participant_changes: int = 0
    structure_complexity: int = 0
    premap_degraded: bool = False

    def __post_init__(self) -> None:
        for field_name in (
            "global_index",
            "new_subjects",
            "unresolved_references",
            "contradictions",
            "open_questions",
            "high_impact_memories",
            "uncertain_coreferences",
            "revalidation_volume",
            "dialogue_participant_changes",
            "structure_complexity",
        ):
            if int(getattr(self, field_name)) < 0:
                raise ValueError(f"{field_name} cannot be negative")


@dataclass(frozen=True)
class DynamicWavePlan:
    start_global_index: int
    end_global_index: int
    volatility: int
    reasons: tuple[str, ...]
    workers: int
    island_size: int


class NarrativeScheduler:
    def __init__(
        self,
        *,
        max_workers: int = 8,
        high_threshold: int = 65,
        medium_threshold: int = 35,
    ) -> None:
        if max_workers < 1:
            raise ValueError("max_workers must be positive")
        if not 0 < medium_threshold < high_threshold <= 100:
            raise ValueError("volatility thresholds are invalid")
        self.max_workers = int(max_workers)
        self.high_threshold = int(high_threshold)
        self.medium_threshold = int(medium_threshold)

    @staticmethod
    def score(signals: NarrativeSignals) -> tuple[int, tuple[str, ...]]:
        score = 0
        reasons: list[str] = []

        def add(condition: bool, points: int, reason: str) -> None:
            nonlocal score
            if condition:
                score += points
                reasons.append(reason)

        if signals.new_subjects:
            score += min(24, signals.new_subjects * 8)
            reasons.append(f"new_subjects:{signals.new_subjects}")
        add(signals.viewpoint_shift, 25, "viewpoint_shift")
        add(signals.narrator_layer_shift, 25, "narrator_layer_shift")
        add(
            signals.presentation_layer_shift,
            20,
            "presentation_layer_shift",
        )
        add(signals.time_shift, 18, "time_shift")
        add(signals.location_shift, 20, "location_shift")
        for value, weight, reason, cap in (
            (signals.unresolved_references, 6, "unresolved_references", 24),
            (signals.contradictions, 10, "contradictions", 20),
            (signals.open_questions, 5, "open_questions", 15),
            (signals.high_impact_memories, 20, "high_impact_memories", 40),
            (
                signals.uncertain_coreferences,
                8,
                "uncertain_coreferences",
                24,
            ),
            (signals.revalidation_volume, 2, "revalidation_volume", 16),
            (
                signals.dialogue_participant_changes,
                5,
                "dialogue_participant_changes",
                20,
            ),
            (
                signals.structure_complexity,
                4,
                "structure_complexity",
                16,
            ),
        ):
            if value:
                score += min(cap, int(value) * weight)
                reasons.append(f"{reason}:{value}")
        add(signals.premap_degraded, 25, "premap_degraded")
        return min(100, score), tuple(reasons)

    def plan(self, signals: NarrativeSignals) -> DynamicWavePlan:
        volatility, reasons = self.score(signals)
        if volatility >= self.high_threshold:
            workers = 1
            island_size = 1 if volatility >= 85 else 2
        elif volatility >= self.medium_threshold:
            workers = min(2, self.max_workers)
            island_size = 2 if volatility >= 50 else 3
        else:
            workers = min(4, self.max_workers)
            island_size = 4
        return DynamicWavePlan(
            start_global_index=signals.global_index,
            end_global_index=signals.global_index,
            volatility=volatility,
            reasons=reasons,
            workers=max(1, workers),
            island_size=island_size,
        )

    @staticmethod
    def make_islands(
        blocks: Sequence[V4Block],
        *,
        island_size: int,
        boundary_indexes: Iterable[int] = (),
    ) -> list[Island]:
        if island_size < 1:
            raise ValueError("island_size must be positive")
        boundaries = {int(value) for value in boundary_indexes}
        islands: list[Island] = []
        current: list[V4Block] = []
        for block in blocks:
            contiguous = bool(
                current
                and current[-1].chapter_id == block.chapter_id
                and current[-1].global_index + 1 == block.global_index
            )
            starts_boundary = block.global_index in boundaries
            if current and (
                not contiguous
                or starts_boundary
                or len(current) >= island_size
            ):
                islands.append(
                    Island(
                        id=f"island_{current[0].global_index:06d}",
                        blocks=current,
                    )
                )
                current = []
            current.append(block)
        if current:
            islands.append(
                Island(
                    id=f"island_{current[0].global_index:06d}",
                    blocks=current,
                )
            )
        return islands
