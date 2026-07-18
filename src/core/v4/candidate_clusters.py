"""Deterministic adjudication clusters for overlapping lexical candidates."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Dict, Mapping, Sequence

from .lexical_index import LexicalCandidate, lexical_key, normalize_punctuation


@dataclass(frozen=True)
class CandidateContext:
    """A reversible source occurrence retained as evidence for a cluster."""

    candidate_id: str
    block_id: str
    paragraph_id: str
    original_text: str
    left_context: str
    right_context: str
    risk_flags: tuple[str, ...]

    @property
    def text(self) -> str:
        return " ".join(
            part for part in (self.left_context, self.original_text, self.right_context) if part
        )


@dataclass(frozen=True)
class CandidateCluster:
    """A stable local adjudication unit and its bounded model-facing evidence."""

    id: str
    alternatives: tuple[LexicalCandidate, ...]
    contexts: tuple[CandidateContext, ...]
    risk_flags: tuple[str, ...]
    affected_blocks: int
    # Complete occurrence support is retained for persistence and propagation,
    # but is deliberately never rendered into the adjudication prompt.
    members: tuple[LexicalCandidate, ...] = ()

    @property
    def texts(self) -> tuple[str, ...]:
        return tuple(alternative.original_text for alternative in self.alternatives)


@dataclass(frozen=True)
class CandidateClusterBatch:
    """At most twelve clusters with aliases scoped only to this batch."""

    clusters: tuple[CandidateCluster, ...]
    alias_map: Mapping[str, str]

    def candidate_id_for_alias(self, alias: str) -> str:
        return self.alias_map[alias]

    def alias_for_candidate(self, candidate_id: str) -> str:
        for alias, mapped_candidate_id in self.alias_map.items():
            if mapped_candidate_id == candidate_id:
                return alias
        raise KeyError(candidate_id)


class _UnionFind:
    def __init__(self, size: int):
        self.parent = list(range(size))

    def find(self, item: int) -> int:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if left_root < right_root:
            self.parent[right_root] = left_root
        else:
            self.parent[left_root] = right_root


class CandidateClusterBuilder:
    """Group overlapping spans without fuzzy cross-block entity conflation."""

    def __init__(self, max_contexts: int = 3, max_alternatives: int = 4):
        self.max_contexts = max(1, min(int(max_contexts), 3))
        self.max_alternatives = max(1, min(int(max_alternatives), 4))

    @staticmethod
    def _location_key(candidate: LexicalCandidate) -> tuple[object, ...]:
        return (
            candidate.block_id,
            candidate.paragraph_id,
            candidate.start_offset,
            candidate.end_offset,
            candidate.id,
        )

    @staticmethod
    def _span_signature(candidate: LexicalCandidate) -> str:
        return lexical_key(candidate.normalized_text or candidate.original_text)

    @classmethod
    def _alternative_equivalence_key(
        cls, candidate: LexicalCandidate
    ) -> tuple[str, str, tuple[str, ...]]:
        normalized_surface = " ".join(
            normalize_punctuation(candidate.original_text).casefold().split()
        )
        return (
            cls._span_signature(candidate),
            normalized_surface,
            tuple(sorted(set(candidate.risk_flags))),
        )

    @classmethod
    def _candidate_key(cls, candidate: LexicalCandidate) -> tuple[object, ...]:
        return cls._location_key(candidate) + (
            cls._span_signature(candidate),
            candidate.original_text,
            candidate.risk_flags,
        )

    @staticmethod
    def _overlaps(left: LexicalCandidate, right: LexicalCandidate) -> bool:
        return (
            left.start_offset < right.end_offset
            and right.start_offset < left.end_offset
        )

    @classmethod
    def _cluster_id(cls, members: Sequence[LexicalCandidate]) -> str:
        identity = "\n".join(sorted(candidate.id for candidate in members))
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
        return f"cluster_{digest}"

    def _select_alternatives(
        self, members: Sequence[LexicalCandidate]
    ) -> tuple[LexicalCandidate, ...]:
        eligible = tuple(members)
        by_equivalence: Dict[
            tuple[str, str, tuple[str, ...]], list[LexicalCandidate]
        ] = {}
        for candidate in eligible:
            key = self._alternative_equivalence_key(candidate)
            by_equivalence.setdefault(key, []).append(candidate)

        def structural_risk_count(candidate: LexicalCandidate) -> int:
            return len(set(candidate.risk_flags) - {"span_competition"})

        def representative(
            key: tuple[str, str, tuple[str, ...]],
            *,
            prefer_longest: bool,
        ) -> LexicalCandidate:
            if prefer_longest:
                return min(
                    by_equivalence[key],
                    key=lambda candidate: (
                        -(candidate.end_offset - candidate.start_offset),
                        -structural_risk_count(candidate),
                        -candidate.score,
                        self._location_key(candidate),
                    ),
                )
            return min(
                by_equivalence[key],
                key=lambda candidate: (
                    -structural_risk_count(candidate),
                    -(candidate.end_offset - candidate.start_offset),
                    -candidate.score,
                    self._location_key(candidate),
                ),
            )

        longest = min(
            eligible,
            key=lambda candidate: (
                -(candidate.end_offset - candidate.start_offset),
                -len(self._span_signature(candidate).split()),
                self._location_key(candidate),
            ),
        )
        longest_key = self._alternative_equivalence_key(longest)
        selected_keys: list[tuple[str, str, tuple[str, ...]]] = []

        def add_key(key: tuple[str, str, tuple[str, ...]]) -> None:
            if (
                key not in selected_keys
                and len(selected_keys) < self.max_alternatives
            ):
                selected_keys.append(key)

        add_key(longest_key)

        atomic_keys = sorted(
            (key for key in by_equivalence if len(key[0].split()) == 1),
            key=lambda key: min(
                self._location_key(candidate) for candidate in by_equivalence[key]
            ),
        )
        for key in atomic_keys:
            add_key(key)

        def structural_key(
            key: tuple[str, str, tuple[str, ...]]
        ) -> tuple[object, ...]:
            candidate = representative(key, prefer_longest=False)
            return (
                -structural_risk_count(candidate),
                -(candidate.end_offset - candidate.start_offset),
                key,
            )

        structural_keys = sorted(
            (
                key
                for key, candidates in by_equivalence.items()
                if any(structural_risk_count(candidate) for candidate in candidates)
            ),
            key=structural_key,
        )
        for key in structural_keys:
            add_key(key)

        for key in sorted(by_equivalence):
            add_key(key)

        return tuple(
            representative(
                key,
                prefer_longest=key == longest_key,
            )
            for key in selected_keys
        )

    @staticmethod
    def _as_context(candidate: LexicalCandidate) -> CandidateContext:
        return CandidateContext(
            candidate_id=candidate.id,
            block_id=candidate.block_id,
            paragraph_id=candidate.paragraph_id,
            original_text=candidate.original_text,
            left_context=candidate.left_context,
            right_context=candidate.right_context,
            risk_flags=candidate.risk_flags,
        )

    def _select_contexts(
        self, members: Sequence[LexicalCandidate]
    ) -> tuple[CandidateContext, ...]:
        ordered = sorted(members, key=self._location_key)
        selected: list[LexicalCandidate] = []

        def add(candidate: LexicalCandidate) -> None:
            if candidate not in selected and len(selected) < self.max_contexts:
                selected.append(candidate)

        add(ordered[0])
        add(
            min(
                members,
                key=lambda candidate: (-candidate.book_frequency, self._location_key(candidate)),
            )
        )

        seen_risks = {candidate.risk_flags for candidate in selected}
        for candidate in sorted(
            members,
            key=lambda item: (
                -len(item.risk_flags),
                item.risk_flags,
                self._location_key(item),
            ),
        ):
            if candidate.risk_flags not in seen_risks:
                add(candidate)
                seen_risks.add(candidate.risk_flags)

        for candidate in ordered:
            add(candidate)

        return tuple(self._as_context(candidate) for candidate in selected)

    def build(
        self, candidates: Sequence[LexicalCandidate]
    ) -> tuple[CandidateCluster, ...]:
        by_id: Dict[str, LexicalCandidate] = {}
        for candidate in sorted(candidates, key=self._candidate_key):
            by_id.setdefault(candidate.id, candidate)
        ordered = tuple(sorted(by_id.values(), key=self._candidate_key))
        if not ordered:
            return ()

        union_find = _UnionFind(len(ordered))
        by_paragraph: Dict[tuple[str, str], list[int]] = {}
        for index, candidate in enumerate(ordered):
            by_paragraph.setdefault((candidate.block_id, candidate.paragraph_id), []).append(index)

        for indexes in by_paragraph.values():
            for offset, left_index in enumerate(indexes):
                left = ordered[left_index]
                for right_index in indexes[offset + 1 :]:
                    right = ordered[right_index]
                    if right.start_offset >= left.end_offset:
                        break
                    if self._overlaps(left, right):
                        union_find.union(left_index, right_index)

        members_by_root: Dict[int, list[LexicalCandidate]] = {}
        for index, candidate in enumerate(ordered):
            members_by_root.setdefault(union_find.find(index), []).append(candidate)

        local_components = list(members_by_root.values())
        components_by_signature_set: Dict[
            tuple[str, ...], list[list[LexicalCandidate]]
        ] = {}
        for members in local_components:
            signature_set = tuple(
                sorted({self._span_signature(candidate) for candidate in members})
            )
            components_by_signature_set.setdefault(signature_set, []).append(members)

        member_groups: list[list[LexicalCandidate]] = []
        for signature_set in sorted(components_by_signature_set):
            components = components_by_signature_set[signature_set]
            block_ids = {
                candidate.block_id
                for component in components
                for candidate in component
            }
            if len(block_ids) >= 2:
                member_groups.append(
                    [candidate for component in components for candidate in component]
                )
            else:
                member_groups.extend(components)

        clusters = []
        for members in member_groups:
            members.sort(key=self._candidate_key)
            clusters.append(
                CandidateCluster(
                    id=self._cluster_id(members),
                    alternatives=self._select_alternatives(members),
                    contexts=self._select_contexts(members),
                    risk_flags=tuple(
                        sorted({flag for candidate in members for flag in candidate.risk_flags})
                    ),
                    affected_blocks=len({candidate.block_id for candidate in members}),
                    members=tuple(members),
                )
            )
        return tuple(sorted(clusters, key=lambda cluster: cluster.id))

    def batch(
        self,
        clusters: Sequence[CandidateCluster],
        batch_size: int = 12,
    ) -> tuple[CandidateClusterBatch, ...]:
        size = max(1, min(int(batch_size), 12))
        ordered = tuple(sorted(clusters, key=lambda cluster: cluster.id))
        seen_candidate_ids: set[str] = set()
        for cluster in ordered:
            if len(cluster.alternatives) > 4:
                raise ValueError("clusters may contain at most 4 alternatives")
            if len(cluster.contexts) > 3:
                raise ValueError("clusters may contain at most 3 contexts")
            for alternative in cluster.alternatives:
                if alternative.id in seen_candidate_ids:
                    raise ValueError("candidate ids must be unique within a batch request")
                seen_candidate_ids.add(alternative.id)
        batches = []
        for start in range(0, len(ordered), size):
            batch_clusters = ordered[start : start + size]
            alias_map: Dict[str, str] = {}
            for cluster_index, cluster in enumerate(batch_clusters, start=1):
                for alternative_index, alternative in enumerate(cluster.alternatives):
                    alias = f"K{cluster_index:02d}{chr(ord('A') + alternative_index)}"
                    alias_map[alias] = alternative.id
            batches.append(CandidateClusterBatch(batch_clusters, alias_map))
        return tuple(batches)

    def build_batches(
        self,
        candidates: Sequence[LexicalCandidate],
        batch_size: int = 12,
    ) -> tuple[CandidateClusterBatch, ...]:
        return self.batch(self.build(candidates), batch_size=batch_size)
