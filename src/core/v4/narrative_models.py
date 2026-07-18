"""Bounded immutable values used by narrative pre-mapping and retrieval."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


MEMORY_TYPES = frozenset(
    {
        "explicit_fact",
        "observation",
        "hypothesis",
        "open_question",
        "contradiction",
        "character_state",
        "relationship_state",
        "timeline_anchor",
        "location_state",
        "narrator_state",
    }
)
TRUTH_STATUSES = frozenset(
    {"asserted", "observed", "inferred", "disputed", "unknown"}
)
VISIBILITIES = frozenset({"reader_visible", "system_private", "render_only"})
MEMORY_OPERATIONS = frozenset(
    {"append", "supersede", "relate", "close_question"}
)
SUBJECT_TYPES = frozenset(
    {"lexeme", "concept", "anonymous_actor", "location", "thread"}
)
RELATION_TYPES = frozenset(
    {
        "referential_link",
        "same_event_different_rendering",
        "viewpoint_or_layer_shift",
        "ellipsis_or_implicit_subject",
        "causal_or_contrast_link",
        "deliberate_ambiguity",
    }
)
INFERENCE_STRENGTHS = frozenset(
    {"explicit", "strongly_implied", "ambiguous"}
)
MAX_STATEMENT_CHARS = 4_096
MAX_EVIDENCE_SPANS = 8
MAX_SUBJECTS = 16
MAX_RELATED_MEMORIES = 16
MAX_STATE_IDS = 32
MAX_STYLE_SIGNALS = 16


def _required_text(value: str, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} cannot be empty")
    normalized = value.strip()
    if len(normalized) > maximum:
        raise ValueError(f"{label} exceeds {maximum} characters")
    return normalized


def _bounded_text_tuple(
    values: tuple[str, ...], label: str, limit: int, item_limit: int = 256
) -> tuple[str, ...]:
    if not isinstance(values, tuple):
        raise TypeError(f"{label} must be a tuple")
    if len(values) > limit:
        raise ValueError(f"{label} exceeds {limit} items")
    normalized = []
    for value in values:
        normalized.append(_required_text(value, label, item_limit))
    return tuple(dict.fromkeys(normalized))


@dataclass(frozen=True)
class DiscourseState:
    viewpoint_holder: str = ""
    narrator_layer: str = ""
    active_speakers: tuple[str, ...] = ()
    addressed_parties: tuple[str, ...] = ()
    scene_location: str = ""
    scene_time: str = ""
    presentation_layer: str = ""
    unresolved_references: tuple[str, ...] = ()
    style_signals: tuple[str, ...] = ()
    state_confidence: float = 0.0
    premap_uncertain: bool = False

    def __post_init__(self) -> None:
        if not 0.0 <= float(self.state_confidence) <= 1.0:
            raise ValueError("state_confidence must be between 0 and 1")
        for field_name in (
            "viewpoint_holder",
            "narrator_layer",
            "scene_location",
            "scene_time",
            "presentation_layer",
        ):
            value = getattr(self, field_name)
            if not isinstance(value, str) or len(value) > 256:
                raise ValueError(f"{field_name} is invalid")
        for field_name, limit in (
            ("active_speakers", MAX_STATE_IDS),
            ("addressed_parties", MAX_STATE_IDS),
            ("unresolved_references", MAX_STATE_IDS),
            ("style_signals", MAX_STYLE_SIGNALS),
        ):
            normalized = _bounded_text_tuple(
                getattr(self, field_name), field_name, limit
            )
            object.__setattr__(self, field_name, normalized)

    def to_dict(self) -> dict[str, Any]:
        return {
            "viewpoint_holder": self.viewpoint_holder,
            "narrator_layer": self.narrator_layer,
            "active_speakers": list(self.active_speakers),
            "addressed_parties": list(self.addressed_parties),
            "scene_location": self.scene_location,
            "scene_time": self.scene_time,
            "presentation_layer": self.presentation_layer,
            "unresolved_references": list(self.unresolved_references),
            "style_signals": list(self.style_signals),
            "state_confidence": float(self.state_confidence),
            "premap_uncertain": bool(self.premap_uncertain),
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> "DiscourseState":
        raw = dict(value or {})
        return cls(
            viewpoint_holder=str(raw.get("viewpoint_holder") or ""),
            narrator_layer=str(raw.get("narrator_layer") or ""),
            active_speakers=tuple(raw.get("active_speakers") or ()),
            addressed_parties=tuple(raw.get("addressed_parties") or ()),
            scene_location=str(raw.get("scene_location") or ""),
            scene_time=str(raw.get("scene_time") or ""),
            presentation_layer=str(raw.get("presentation_layer") or ""),
            unresolved_references=tuple(
                raw.get("unresolved_references") or ()
            ),
            style_signals=tuple(raw.get("style_signals") or ()),
            state_confidence=float(raw.get("state_confidence") or 0.0),
            premap_uncertain=bool(raw.get("premap_uncertain")),
        )


@dataclass(frozen=True)
class DiscourseDelta:
    viewpoint_holder: str | None = None
    narrator_layer: str | None = None
    active_speakers: tuple[str, ...] | None = None
    addressed_parties: tuple[str, ...] | None = None
    scene_location: str | None = None
    scene_time: str | None = None
    presentation_layer: str | None = None
    unresolved_references: tuple[str, ...] | None = None
    style_signals: tuple[str, ...] | None = None
    state_confidence: float | None = None
    premap_uncertain: bool = False

    def __post_init__(self) -> None:
        if self.state_confidence is not None and not (
            0.0 <= float(self.state_confidence) <= 1.0
        ):
            raise ValueError("state_confidence must be between 0 and 1")
        for field_name in (
            "viewpoint_holder",
            "narrator_layer",
            "scene_location",
            "scene_time",
            "presentation_layer",
        ):
            value = getattr(self, field_name)
            if value is not None and (
                not isinstance(value, str) or len(value) > 256
            ):
                raise ValueError(f"{field_name} is invalid")
        for field_name, limit in (
            ("active_speakers", MAX_STATE_IDS),
            ("addressed_parties", MAX_STATE_IDS),
            ("unresolved_references", MAX_STATE_IDS),
            ("style_signals", MAX_STYLE_SIGNALS),
        ):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(
                    self,
                    field_name,
                    _bounded_text_tuple(value, field_name, limit),
                )

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for field_name in (
            "viewpoint_holder",
            "narrator_layer",
            "active_speakers",
            "addressed_parties",
            "scene_location",
            "scene_time",
            "presentation_layer",
            "unresolved_references",
            "style_signals",
            "state_confidence",
        ):
            value = getattr(self, field_name)
            if value is None:
                continue
            result[field_name] = list(value) if isinstance(value, tuple) else value
        if self.premap_uncertain:
            result["premap_uncertain"] = True
        return result

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> "DiscourseDelta":
        raw = dict(value or {})

        def optional_text(name: str) -> str | None:
            return str(raw[name]) if name in raw and raw[name] is not None else None

        def optional_tuple(name: str) -> tuple[str, ...] | None:
            if name not in raw or raw[name] is None:
                return None
            return tuple(str(item) for item in raw[name])

        return cls(
            viewpoint_holder=optional_text("viewpoint_holder"),
            narrator_layer=optional_text("narrator_layer"),
            active_speakers=optional_tuple("active_speakers"),
            addressed_parties=optional_tuple("addressed_parties"),
            scene_location=optional_text("scene_location"),
            scene_time=optional_text("scene_time"),
            presentation_layer=optional_text("presentation_layer"),
            unresolved_references=optional_tuple("unresolved_references"),
            style_signals=optional_tuple("style_signals"),
            state_confidence=(
                float(raw["state_confidence"])
                if "state_confidence" in raw
                and raw["state_confidence"] is not None
                else None
            ),
            premap_uncertain=bool(raw.get("premap_uncertain")),
        )

    @classmethod
    def from_state(cls, value: DiscourseState) -> "DiscourseDelta":
        return cls(
            viewpoint_holder=value.viewpoint_holder,
            narrator_layer=value.narrator_layer,
            active_speakers=value.active_speakers,
            addressed_parties=value.addressed_parties,
            scene_location=value.scene_location,
            scene_time=value.scene_time,
            presentation_layer=value.presentation_layer,
            unresolved_references=value.unresolved_references,
            style_signals=value.style_signals,
            state_confidence=value.state_confidence,
            premap_uncertain=value.premap_uncertain,
        )


def apply_discourse_delta(
    prior: DiscourseState, delta: DiscourseDelta
) -> DiscourseState:
    if not isinstance(prior, DiscourseState):
        raise TypeError("prior must be DiscourseState")
    if not isinstance(delta, DiscourseDelta):
        raise TypeError("delta must be DiscourseDelta")

    def choose(name: str) -> Any:
        value = getattr(delta, name)
        return getattr(prior, name) if value is None else value

    return DiscourseState(
        viewpoint_holder=choose("viewpoint_holder"),
        narrator_layer=choose("narrator_layer"),
        active_speakers=choose("active_speakers"),
        addressed_parties=choose("addressed_parties"),
        scene_location=choose("scene_location"),
        scene_time=choose("scene_time"),
        presentation_layer=choose("presentation_layer"),
        unresolved_references=choose("unresolved_references"),
        style_signals=choose("style_signals"),
        state_confidence=choose("state_confidence"),
        premap_uncertain=bool(
            prior.premap_uncertain or delta.premap_uncertain
        ),
    )


@dataclass(frozen=True)
class SemanticRelation:
    relation_type: str
    inference_strength: str
    source_spans: tuple[str, ...]
    translation_constraint: str
    related_memory_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.relation_type not in RELATION_TYPES:
            raise ValueError("relation_type is invalid")
        if self.inference_strength not in INFERENCE_STRENGTHS:
            raise ValueError("inference_strength is invalid")
        spans = _bounded_text_tuple(
            self.source_spans, "source_spans", MAX_EVIDENCE_SPANS, 1_024
        )
        if not spans:
            raise ValueError("source_spans requires at least one item")
        object.__setattr__(self, "source_spans", spans)
        object.__setattr__(
            self,
            "translation_constraint",
            _required_text(
                self.translation_constraint,
                "translation_constraint",
                MAX_STATEMENT_CHARS,
            ),
        )
        object.__setattr__(
            self,
            "related_memory_ids",
            _bounded_text_tuple(
                self.related_memory_ids,
                "related_memory_ids",
                MAX_RELATED_MEMORIES,
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "relation_type": self.relation_type,
            "inference_strength": self.inference_strength,
            "source_spans": list(self.source_spans),
            "related_memory_ids": list(self.related_memory_ids),
            "translation_constraint": self.translation_constraint,
        }


@dataclass(frozen=True)
class NarrativeSubject:
    subject_type: str
    subject_id: str
    role: str = "subject"

    def __post_init__(self) -> None:
        if self.subject_type not in SUBJECT_TYPES:
            raise ValueError("subject_type is invalid")
        object.__setattr__(
            self, "subject_id", _required_text(self.subject_id, "subject_id", 256)
        )
        object.__setattr__(self, "role", _required_text(self.role, "role", 64))

    def to_dict(self) -> dict[str, str]:
        return {
            "subject_type": self.subject_type,
            "subject_id": self.subject_id,
            "role": self.role,
        }


@dataclass(frozen=True)
class NarrativeMemoryCandidate:
    candidate_id: str
    memory_type: str
    statement: str
    truth_status: str
    visibility: str
    confidence: float
    evidence_spans: tuple[str, ...]
    subjects: tuple[NarrativeSubject, ...] = ()
    related_memory_ids: tuple[str, ...] = ()
    state_operation: str = "append"
    high_impact: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "candidate_id",
            _required_text(self.candidate_id, "candidate_id", 128),
        )
        if self.memory_type not in MEMORY_TYPES:
            raise ValueError("memory_type is invalid")
        if self.truth_status not in TRUTH_STATUSES:
            raise ValueError("truth_status is invalid")
        if self.visibility not in VISIBILITIES:
            raise ValueError("visibility is invalid")
        if self.state_operation not in MEMORY_OPERATIONS:
            raise ValueError("state_operation is invalid")
        if not 0.0 <= float(self.confidence) <= 1.0:
            raise ValueError("confidence must be between 0 and 1")
        object.__setattr__(
            self,
            "statement",
            _required_text(self.statement, "statement", MAX_STATEMENT_CHARS),
        )
        evidence = _bounded_text_tuple(
            self.evidence_spans,
            "evidence_spans",
            MAX_EVIDENCE_SPANS,
            1_024,
        )
        if not evidence:
            raise ValueError("evidence_spans cannot be empty")
        object.__setattr__(self, "evidence_spans", evidence)
        if not isinstance(self.subjects, tuple) or len(self.subjects) > MAX_SUBJECTS:
            raise ValueError(f"subjects exceeds {MAX_SUBJECTS} items")
        if not all(isinstance(value, NarrativeSubject) for value in self.subjects):
            raise TypeError("subjects must contain NarrativeSubject values")
        object.__setattr__(
            self,
            "related_memory_ids",
            _bounded_text_tuple(
                self.related_memory_ids,
                "related_memory_ids",
                MAX_RELATED_MEMORIES,
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "memory_type": self.memory_type,
            "statement": self.statement,
            "truth_status": self.truth_status,
            "visibility": self.visibility,
            "confidence": float(self.confidence),
            "subjects": [value.to_dict() for value in self.subjects],
            "related_memory_ids": list(self.related_memory_ids),
            "evidence_spans": list(self.evidence_spans),
            "state_operation": self.state_operation,
            "high_impact": bool(self.high_impact),
        }

    @classmethod
    def from_mapping(
        cls, value: Mapping[str, Any]
    ) -> "NarrativeMemoryCandidate":
        return cls(
            candidate_id=str(value.get("candidate_id") or ""),
            memory_type=str(value.get("memory_type") or ""),
            statement=str(value.get("statement") or ""),
            truth_status=str(value.get("truth_status") or ""),
            visibility=str(value.get("visibility") or ""),
            confidence=float(value.get("confidence")),
            evidence_spans=tuple(value.get("evidence_spans") or ()),
            subjects=tuple(
                NarrativeSubject(
                    subject_type=str(subject.get("subject_type") or ""),
                    subject_id=str(subject.get("subject_id") or ""),
                    role=str(subject.get("role") or "subject"),
                )
                for subject in value.get("subjects") or ()
                if isinstance(subject, Mapping)
            ),
            related_memory_ids=tuple(
                value.get("related_memory_ids") or ()
            ),
            state_operation=str(
                value.get("state_operation") or "append"
            ),
            high_impact=bool(value.get("high_impact")),
        )


@dataclass(frozen=True)
class NarrativePremapResult:
    semantic_relations: tuple[SemanticRelation, ...]
    memory_candidates: tuple[NarrativeMemoryCandidate, ...]
    discourse_delta: DiscourseDelta
    validation_warnings: tuple[str, ...] = ()
    degraded: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "semantic_relations": [
                value.to_dict() for value in self.semantic_relations
            ],
            "memory_candidates": [
                value.to_dict() for value in self.memory_candidates
            ],
            "discourse_delta": self.discourse_delta.to_dict(),
            "validation_warnings": list(self.validation_warnings),
            "degraded": bool(self.degraded),
        }


@dataclass(frozen=True)
class NarrativeMemoryRecord:
    id: str
    memory_type: str
    statement: str
    truth_status: str
    visibility: str
    confidence: float
    reveal_global_index: int
    source_block_id: str
    status: str
    high_impact: bool
    semantic_fingerprint: str
    subjects: tuple[NarrativeSubject, ...] = ()


@dataclass(frozen=True)
class NarrativeSnapshot:
    id: str
    block_id: str
    global_index: int
    knowledge_version: int
    memory_version: int
    previous_snapshot_id: str
    discourse_state: DiscourseState
    visible_memory_ids: tuple[str, ...]
    snapshot_hash: str


@dataclass(frozen=True)
class NarrativeRetrieval:
    memories: tuple[NarrativeMemoryRecord, ...]
    required_memory_ids: tuple[str, ...]
    rendered_chars: int


def render_narrative_memory(
    memory: NarrativeMemoryRecord, *, required: bool
) -> str:
    subjects = ", ".join(
        f"{subject.subject_type}:{subject.subject_id}:{subject.role}"
        for subject in memory.subjects
    )
    label = "硬约束" if required else "保守提示"
    return (
        f"- [{label}] {memory.id} · {memory.memory_type} · "
        f"{memory.truth_status}/{memory.status}: {memory.statement}"
        + (f" [主体: {subjects}]" if subjects else "")
    )
