"""Strict data contracts used by the parallel_v4 pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Annotated, Any, Dict, List, Literal, Mapping, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


class V4BlockStatus(str, Enum):
    PENDING = "pending"
    SCANNED = "scanned"
    READY = "ready"
    TRANSLATING = "translating"
    COMPLETED = "completed"
    COMPLETED_WITH_WARNINGS = "completed_with_warnings"
    NEEDS_REVALIDATE = "needs_revalidate"
    INCOMPLETE_REQUIRES_HUMAN = "incomplete_requires_human"
    FAILED_RETRYABLE = "failed_retryable"
    FAILED_TERMINAL = "failed_terminal"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ScanMention(StrictModel):
    paragraph_id: str = Field(pattern=r"^P\d{3}$")
    source_form: str = Field(min_length=1, max_length=200)
    category: str = Field(
        default="concept",
        pattern=(
            r"^(person|place|organization|group|item|concept|unit|title|"
            r"event|species|technology|work)$"
        ),
    )
    suggested_target: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=600)
    discourse_function: str = Field(
        default="referential",
        pattern=r"^(referential|vocative|institutional|unknown)$",
    )
    evidence_quote: str = Field(min_length=1, max_length=500)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    candidate_id: str = Field(default="", max_length=80)
    canonical_form: str = Field(default="", max_length=200)


class ScanAmbiguity(StrictModel):
    paragraph_id: str = Field(pattern=r"^P\d{3}$")
    evidence_quote: str = Field(min_length=1, max_length=500)
    constraint: str = Field(min_length=1, max_length=600)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class ScanResponse(StrictModel):
    mentions: List[ScanMention] = Field(default_factory=list)
    ambiguities: List[ScanAmbiguity] = Field(default_factory=list)


class CandidateMentionDecision(StrictModel):
    candidate_id: str = Field(pattern=r"^C\d{3}$")
    category: str = Field(
        default="concept",
        pattern=(
            r"^(person|place|organization|group|item|concept|unit|title|"
            r"event|species|technology|work)$"
        ),
    )
    suggested_target: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=600)
    discourse_function: str = Field(
        default="referential",
        pattern=r"^(referential|vocative|institutional|unknown)$",
    )
    canonical_candidate_id: Optional[str] = Field(
        default=None,
        pattern=r"^C\d{3}$",
    )
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class CandidateScanResponse(StrictModel):
    mentions: List[CandidateMentionDecision] = Field(default_factory=list)


AdjudicationAlias = Annotated[
    str,
    Field(pattern=r"^K(?:0[1-9]|1[0-2])[A-D]$"),
]


class AdjudicationDecision(StrictModel):
    cluster_id: str = Field(pattern=r"^K(?:0[1-9]|1[0-2])$")
    verdict: Literal["promote", "reject", "split", "supersede", "defer"]
    selected_ids: List[AdjudicationAlias] = Field(default_factory=list, max_length=4)
    entity_kind: Literal[
        "person",
        "place",
        "organization",
        "group",
        "item",
        "concept",
        "unit",
        "title",
        "event",
        "species",
        "technology",
        "work",
        "artwork",
        "personification",
        "role",
        "unknown_named_entity",
    ]
    confidence: float = Field(ge=0.0, le=1.0)
    reason: str = Field(default="", max_length=200)


class AdjudicationResponse(StrictModel):
    decisions: List[AdjudicationDecision] = Field(default_factory=list, max_length=12)


class WorkingTargetRule(StrictModel):
    condition: Dict[str, str] = Field(min_length=1, max_length=8)
    target: str = Field(min_length=1, max_length=200)

    @field_validator("condition")
    @classmethod
    def _condition_must_be_concrete(cls, value: Dict[str, str]) -> Dict[str, str]:
        normalized: Dict[str, str] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key).strip()
            item = str(raw_value).strip()
            if not key or not item:
                raise ValueError("working-target rule conditions cannot be empty")
            normalized[key] = item
        return normalized

    @field_validator("target")
    @classmethod
    def _rule_target_must_be_nonempty(cls, value: str) -> str:
        target = value.strip()
        if not target:
            raise ValueError("working-target rule target cannot be empty")
        return target


class WorkingTargetDecision(StrictModel):
    concept_id: str = Field(pattern=r"^Q(?:0[1-9]|1\d|2[0-4])$")
    working_target: str = Field(min_length=1, max_length=200)
    semantic_core: str = Field(min_length=1, max_length=600)
    contrast_sources: List[str] = Field(max_length=12)
    rules: List[WorkingTargetRule] = Field(max_length=6)
    confidence: float = Field(ge=0.0, le=1.0)

    @field_validator("working_target")
    @classmethod
    def _target_must_be_nonempty(cls, value: str) -> str:
        target = value.strip()
        if not target:
            raise ValueError("working target cannot be empty")
        return target

    @field_validator("semantic_core")
    @classmethod
    def _semantic_core_is_trimmed(cls, value: str) -> str:
        semantic_core = value.strip()
        if not semantic_core:
            raise ValueError("semantic core cannot be empty")
        return semantic_core

    @field_validator("contrast_sources")
    @classmethod
    def _contrast_sources_are_bounded(cls, value: List[str]) -> List[str]:
        normalized: List[str] = []
        seen: set[str] = set()
        for raw in value:
            item = str(raw).strip()
            if not item or len(item) > 120:
                raise ValueError("contrast sources must be non-empty and at most 120 characters")
            key = item.casefold()
            if key not in seen:
                seen.add(key)
                normalized.append(item)
        return normalized


class WorkingTargetResponse(StrictModel):
    decisions: List[WorkingTargetDecision] = Field(max_length=24)


class CoreferenceVote(StrictModel):
    case_id: str = Field(pattern=r"^R\d{3}$")
    relation: Literal["same", "different", "uncertain", "non_entity"]
    mention_ids: list[str] = Field(min_length=1, max_length=8)
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(max_length=300)


class CoreferenceResponse(StrictModel):
    votes: list[CoreferenceVote] = Field(min_length=1, max_length=999)


class VerificationResponse(StrictModel):
    verdict: str = Field(pattern=r"^(support|reject|uncertain)$")
    rationale: str = Field(min_length=1, max_length=1200)
    evidence_quotes: List[str] = Field(default_factory=list, max_length=10)


class RepairResponse(StrictModel):
    paragraphs: List[str] = Field(min_length=1)
    repair_notes: List[str] = Field(default_factory=list, max_length=20)


RevalidationTaskAlias = Annotated[str, Field(pattern=r"^T\d{3}$")]
RevalidationCaseAlias = Annotated[str, Field(pattern=r"^C\d{3}$")]
RevalidationSubjectAlias = Annotated[str, Field(pattern=r"^S\d{3}$")]


class RevalidationSpan(StrictModel):
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def _ordered(self) -> "RevalidationSpan":
        if self.end <= self.start:
            raise ValueError("revalidation span must be a non-empty half-open range")
        return self


class RevalidationResponse(StrictModel):
    """One bounded validator answer resolved only through prompt-local aliases."""

    task_alias: RevalidationTaskAlias = Field(
        validation_alias=AliasChoices("task_alias", "task")
    )
    case_aliases: List[RevalidationCaseAlias] = Field(
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("case_aliases", "cases"),
    )
    action: Literal["no_effect", "patch_required", "retranslate", "uncertain"]
    spans: List[RevalidationSpan] = Field(default_factory=list, max_length=128)
    subject_aliases: List[RevalidationSubjectAlias] = Field(
        default_factory=list,
        max_length=128,
        validation_alias=AliasChoices("subject_aliases", "subjects"),
    )
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(min_length=1, max_length=600)

    @field_validator("case_aliases", "subject_aliases")
    @classmethod
    def _aliases_are_unique(cls, value: List[str]) -> List[str]:
        if len(value) != len(set(value)):
            raise ValueError("revalidation aliases must be unique")
        return value

    @field_validator("rationale")
    @classmethod
    def _bounded_rationale_is_not_blank(cls, value: str) -> str:
        rationale = value.strip()
        if not rationale:
            raise ValueError("revalidation rationale cannot be blank")
        return rationale


@dataclass(frozen=True)
class V4Block:
    id: str
    source_edition_id: int
    chapter_id: str
    chapter_index: int
    block_index: int
    global_index: int
    block_type: str
    source_text: str
    source_hash: str
    token_count: int
    status: str
    legacy_id: str = ""


@dataclass(frozen=True)
class LexemeRef:
    id: str
    language: str
    normalized_form: str
    canonical_form: str


@dataclass(frozen=True)
class TypeObservation:
    lexeme_id: str
    kind: str
    confidence: float
    source: str
    mention_id: int | None = None
    concept_id: str | None = None
    evidence_id: int | None = None
    adjudication_id: str | None = None


@dataclass(frozen=True)
class CoreferenceTypeObservation:
    observation_id: int
    kind: str
    confidence: float
    source: str
    mention_id: int | None = None
    concept_id: str | None = None
    evidence_id: int | None = None
    adjudication_id: str | None = None


@dataclass(frozen=True)
class CoreferenceConceptAnchor:
    concept_id: str
    kind: str
    canonical_source: str
    status: str
    role: str
    anchor_mention_id: int | None = None
    evidence_id: int | None = None


@dataclass(frozen=True)
class CoreferenceMention:
    mention_id: int
    request_id: str
    lexeme_id: str
    evidence_id: int
    block_id: str
    paragraph_id: str
    block_kind: str
    source_hash: str
    source_edition_hash: str
    source_form: str
    discourse_function: str
    context: str
    context_source: str
    start_offset: int | None
    end_offset: int | None
    type_observations: tuple[CoreferenceTypeObservation, ...] = ()
    concept_anchor_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CoreferenceCase:
    case_id: str
    mention_set_id: str
    knowledge_version: int
    lexeme_id: str
    language: str
    normalized_form: str
    canonical_form: str
    mentions: tuple[CoreferenceMention, ...]
    type_observations: tuple[CoreferenceTypeObservation, ...] = ()
    concept_anchors: tuple[CoreferenceConceptAnchor, ...] = ()

    @property
    def lexeme(self) -> LexemeRef:
        return LexemeRef(
            id=self.lexeme_id,
            language=self.language,
            normalized_form=self.normalized_form,
            canonical_form=self.canonical_form,
        )


@dataclass(frozen=True)
class FormOccurrence:
    lexeme_id: str
    block_id: str
    start_offset: int
    end_offset: int
    source_form: str
    source_hash: str


@dataclass
class ScanOutcome:
    block: V4Block
    response: Optional[ScanResponse]
    raw_response: str = ""
    request_payload: Dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    elapsed_ms: int = 0
    error: Optional[str] = None
    audit_calls: List[Dict[str, Any]] = field(default_factory=list)
    lexical_candidates: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class ContextPacket:
    block_id: str
    knowledge_version: int
    rendered: str
    required_chars: int
    memory_version: int = 1
    snapshot_id: str = ""
    matched_lexeme_ids: List[str] = field(default_factory=list)
    matched_concept_ids: List[str] = field(default_factory=list)
    matched_rule_ids: List[str] = field(default_factory=list)
    matched_claim_ids: List[str] = field(default_factory=list)
    matched_memory_ids: List[str] = field(default_factory=list)
    style_snapshot_id: str = ""
    discourse_state_hash: str = ""
    context_hash: str = ""
    section_token_estimates: Dict[str, int] = field(default_factory=dict)
    draft_projection: Any = None
    polish_base_projection: Any = None
    polish_projection: Any = None
    draft_sections: tuple[Any, ...] = ()
    polish_sections: tuple[Any, ...] = ()
    dropped_optional_sections: List[str] = field(default_factory=list)
    style_projection: str = ""
    style_anchor_id: Optional[str] = None


@dataclass(frozen=True)
class RenderingMatchSnapshot:
    """Bounded, import-safe copy of one frozen render-index match."""

    lexeme_id: str
    concept_id: Optional[str]
    matched_form: str
    start_offset: int
    end_offset: int
    rendered_target: str
    applied_rule_ids: tuple[str, ...] = ()
    dependency_fingerprint: str = ""


@dataclass(frozen=True)
class ClaimDependencySnapshot:
    """Frozen prompt-semantic identity for one matched claim."""

    claim_id: str
    semantic_fingerprint: str


@dataclass(frozen=True)
class NarrativeDependencySnapshot:
    """Frozen prompt-semantic identity for one narrative memory."""

    memory_id: str
    semantic_fingerprint: str


@dataclass
class TranslationOutcome:
    block: V4Block
    knowledge_version: int
    status: str
    memory_version: int = 1
    snapshot_id: str = ""
    context_hash: str = ""
    style_snapshot_id: str = ""
    style_anchor_id: str = ""
    discourse_state_hash: str = ""
    draft_translation: str = ""
    final_translation: str = ""
    analysis: str = ""
    semantic_obligations: str = ""
    memory_summary: str = ""
    warnings: List[str] = field(default_factory=list)
    term_proposals: List[Dict[str, Any]] = field(default_factory=list)
    relation_proposals: List[Dict[str, Any]] = field(default_factory=list)
    matched_concept_ids: List[str] = field(default_factory=list)
    matched_renderings: tuple[RenderingMatchSnapshot, ...] = ()
    claim_dependencies: tuple[ClaimDependencySnapshot, ...] = ()
    narrative_dependencies: tuple[NarrativeDependencySnapshot, ...] = ()
    supplemental_memory_candidates: List[Dict[str, Any]] = field(default_factory=list)
    style_delta: Dict[str, Any] = field(default_factory=dict)
    audit_calls: List[Dict[str, Any]] = field(default_factory=list)
    attempts: int = 1
    elapsed_ms: int = 0
    error: Optional[str] = None


@dataclass(frozen=True)
class RevalidationClaim:
    """Immutable lease plus the exact canonical payload shown to validators."""

    task_id: str
    lease_token: str
    owner: str
    expires_at: str
    task_snapshot: Mapping[str, Any]
    payload: Mapping[str, Any]
    payload_bytes: bytes
    payload_hash: str

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


@dataclass(frozen=True)
class Island:
    id: str
    blocks: List[V4Block]
