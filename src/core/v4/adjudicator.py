"""Conservative model adjudication for bounded lexical candidate clusters."""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, Mapping, Optional, Sequence
from uuid import uuid4

from .candidate_clusters import CandidateCluster, CandidateClusterBatch
from .lexical_index import COORDINATORS, LexicalCandidate, lexical_key
from .models import AdjudicationDecision, AdjudicationResponse


ADJUDICATION_PROTOCOL = """CANONICAL ADJUDICATION JSON PROTOCOL
The root object has exactly one key, "decisions". Its value is an array with one
object for every supplied cluster. Each decision object has exactly these six keys:
"cluster_id", "verdict", "selected_ids", "entity_kind", "confidence", "reason".
Do not omit "reason"; use an empty string when no explanation is needed.

Allowed "verdict" values: "promote", "reject", "split", "supersede", "defer".
Allowed "entity_kind" values: "person", "place", "organization", "group",
"item", "concept", "unit", "title", "event", "species", "technology", "work",
"artwork", "personification", "role", "unknown_named_entity".
Selection rules:
- promote: selected_ids has exactly one local Kxx[A-D] alias.
- reject/defer: selected_ids is [].
- split: selected_ids has two or more non-overlapping local aliases.
- supersede: selected_ids has exactly one local alias whose span contains the
  smaller alternative that it replaces.
Use only the supplied Kxx cluster aliases and their Kxx[A-D] alternative aliases.
Never copy a stable identifier and never invent a span. If the correct span is
absent, use "defer", [], "unknown_named_entity", and reason "missing_span".

This is a complete one-decision JSON template (repeat the object for more clusters):
{"decisions":[{"cluster_id":"K01","verdict":"promote","selected_ids":["K01A"],"entity_kind":"person","confidence":0.95,"reason":""}]}

The following synonym keys are forbidden: "decision", "action", "selected_id",
"alternative_id", "span_id", "cluster", "type". Do not return Markdown, prose,
schema commentary, or any keys other than the canonical keys above.
"""


ADJUDICATION_SYSTEM = f"""You adjudicate bounded lexical candidate spans.
Promote genuine named entities, fictional terms, and recurring roles, professions,
social ranks, or institutional identities that need a stable translation across
the book. Being a common noun is not by itself a reason to reject a candidate:
use entity_kind "role" when an otherwise ordinary occupational or identity noun
has recurring book-specific translation consequences.
Reject ordinary verbs, ordinary nouns with no book-wide translation consequence,
function words, and fragment noise.
Treat weak evidence conservatively: when a candidate is not clearly a recurring
named entity, fictional term, or translation-sensitive role, defer.
Be conservative: extraction merely proposes spans and does not prove termhood.

{ADJUDICATION_PROTOCOL}"""


def _external_error_kind(exc: Exception) -> Optional[str]:
    """Classify only provider pressure and transport failures."""

    status_code = getattr(exc, "status_code", None)
    text = f"{type(exc).__name__}: {exc}".lower()
    if (
        status_code == 429
        or "rate limit" in text
        or "too many requests" in text
    ):
        return "rate_limit"
    if isinstance(exc, TimeoutError) or "timeout" in text or "timed out" in text:
        return "timeout"
    if (
        "connection" in text
        or "temporarily unavailable" in text
        or "service unavailable" in text
    ):
        return "transient_network"
    return None


def _adjudication_retry_message(last_error: str) -> str:
    return (
        "The previous JSON failed strict local validation. Correct the complete "
        "answer and return it again. The full validator report follows:\n"
        f"{last_error}\n\n{ADJUDICATION_PROTOCOL}"
    )


@dataclass(frozen=True)
class AdjudicationResult:
    """A validated decision resolved back to stable local candidate identifiers."""

    cluster_id: str
    verdict: str
    selected_candidate_ids: tuple[str, ...]
    entity_kind: str
    confidence: float
    reason: str = ""
    rounds: int = 1


@dataclass(frozen=True)
class AdjudicationAuditAttempt:
    """One model attempt buffered until the coordinator persists its batch."""

    messages: tuple[Mapping[str, str], ...]
    raw_response: str
    parsed: Optional[Mapping[str, Any]]
    accepted: bool
    attempt: int
    elapsed_ms: int
    error: Optional[str]
    error_kind: Optional[str]
    model: str
    knowledge_version: int
    audit_mode: str


@dataclass(frozen=True)
class AdjudicationBatchOutcome:
    """Pure worker output; it contains no database side effects."""

    batch_index: int
    results: tuple[AdjudicationResult, ...]
    audit_attempts: tuple[AdjudicationAuditAttempt, ...]
    model_calls: int
    model_elapsed_ms_sum: int
    error_kinds: tuple[str, ...]


@dataclass(frozen=True)
class _RoundOutcome:
    results: Optional[Mapping[str, AdjudicationResult]]
    audit_attempts: tuple[AdjudicationAuditAttempt, ...]


@dataclass(frozen=True)
class _RoundBatch:
    clusters: tuple[CandidateCluster, ...]
    cluster_by_alias: Mapping[str, CandidateCluster]
    candidate_by_alias: Mapping[str, LexicalCandidate]
    aliases_by_cluster: Mapping[str, frozenset[str]]
    payload: Mapping[str, object]


class AdjudicationProtocolError(ValueError):
    """The model response cannot be resolved safely to the supplied lattice."""


class V4Adjudicator:
    """Run strict local adjudication and independent re-aliased risk review."""

    def __init__(
        self,
        llm: Any,
        max_attempts: int = 2,
        max_tokens: int = 8192,
        database: Optional[Any] = None,
        audit_mode: str = "full",
        llm_factory: Optional[Callable[[], Any]] = None,
    ):
        if audit_mode not in {"full", "response", "minimal"}:
            raise ValueError("audit_mode must be full, response, or minimal")
        self.llm = llm
        self.max_attempts = max(1, int(max_attempts))
        self.max_tokens = max(1, int(max_tokens))
        self.database = database
        self.audit_mode = audit_mode
        self.llm_factory = llm_factory

    def _new_worker(self) -> "V4Adjudicator":
        llm = self.llm_factory() if self.llm_factory is not None else self.llm
        return V4Adjudicator(
            llm,
            max_attempts=self.max_attempts,
            max_tokens=self.max_tokens,
            audit_mode=self.audit_mode,
        )

    @staticmethod
    def _clean_json(raw: str) -> str:
        text = raw.strip()
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        return text.strip()

    @staticmethod
    def _clusters_from_subject(
        subject: CandidateClusterBatch | CandidateCluster | Sequence[CandidateCluster],
    ) -> tuple[CandidateCluster, ...]:
        if isinstance(subject, CandidateClusterBatch):
            clusters = subject.clusters
        elif isinstance(subject, CandidateCluster):
            clusters = (subject,)
        else:
            clusters = tuple(subject)
        return tuple(sorted(clusters, key=lambda cluster: cluster.id))

    @classmethod
    def _round_batch(
        cls,
        clusters: Sequence[CandidateCluster],
        *,
        reverse_alternatives: bool,
    ) -> _RoundBatch:
        ordered = tuple(sorted(clusters, key=lambda cluster: cluster.id))
        if not ordered or len(ordered) > 12:
            raise ValueError("an adjudication batch must contain 1..12 clusters")

        cluster_by_alias: Dict[str, CandidateCluster] = {}
        candidate_by_alias: Dict[str, LexicalCandidate] = {}
        aliases_by_cluster: Dict[str, frozenset[str]] = {}
        rendered_clusters = []
        for cluster_index, cluster in enumerate(ordered, start=1):
            if not cluster.alternatives or len(cluster.alternatives) > 4:
                raise ValueError("each cluster must contain 1..4 alternatives")
            cluster_alias = f"K{cluster_index:02d}"
            cluster_by_alias[cluster_alias] = cluster
            alternatives = tuple(cluster.alternatives)
            if reverse_alternatives:
                alternatives = tuple(reversed(alternatives))
            rendered_alternatives = []
            local_aliases = []
            alias_letters = "ABCD"
            if reverse_alternatives:
                alias_letters = {
                    1: "D",
                    2: "AB",
                    3: "DCB",
                    4: "ABCD",
                }[len(alternatives)]
            for alternative_index, alternative in enumerate(alternatives):
                alias_letter = alias_letters[alternative_index]
                alias = f"{cluster_alias}{alias_letter}"
                candidate_by_alias[alias] = alternative
                local_aliases.append(alias)
                rendered_alternatives.append(
                    {
                        "id": alias,
                        "text": alternative.original_text,
                        "risk_flags": list(alternative.risk_flags),
                    }
                )
            aliases_by_cluster[cluster.id] = frozenset(local_aliases)
            rendered_clusters.append(
                {
                    "cluster_id": cluster_alias,
                    "alternatives": rendered_alternatives,
                    "contexts": [
                        {
                            "text": context.text,
                            "risk_flags": list(context.risk_flags),
                        }
                        for context in cluster.contexts
                    ],
                    "risk_flags": list(cluster.risk_flags),
                    "affected_blocks": cluster.affected_blocks,
                }
            )
        return _RoundBatch(
            clusters=ordered,
            cluster_by_alias=cluster_by_alias,
            candidate_by_alias=candidate_by_alias,
            aliases_by_cluster=aliases_by_cluster,
            payload={"clusters": rendered_clusters},
        )

    @staticmethod
    def _source_spans_are_valid(
        clusters: Sequence[CandidateCluster], source_texts: Mapping[str, str]
    ) -> bool:
        for cluster in clusters:
            for candidate in cluster.alternatives:
                source = source_texts.get(candidate.block_id)
                if source is None:
                    return False
                if not (0 <= candidate.start_offset < candidate.end_offset <= len(source)):
                    return False
                if source[candidate.start_offset : candidate.end_offset] != candidate.original_text:
                    return False
        return True

    @staticmethod
    def _overlap(left: LexicalCandidate, right: LexicalCandidate) -> bool:
        return (
            left.block_id == right.block_id
            and left.start_offset < right.end_offset
            and right.start_offset < left.end_offset
        )

    @classmethod
    def _valid_supersede(
        cls,
        selected: LexicalCandidate,
        alternatives: Sequence[LexicalCandidate],
    ) -> bool:
        for other in alternatives:
            if other.id == selected.id:
                continue
            if (
                selected.block_id == other.block_id
                and selected.start_offset <= other.start_offset
                and other.end_offset <= selected.end_offset
            ):
                return True
        return False

    @classmethod
    def _resolve_decisions(
        cls,
        parsed: AdjudicationResponse,
        round_batch: _RoundBatch,
    ) -> Dict[str, AdjudicationResult]:
        decisions_by_alias: Dict[str, AdjudicationDecision] = {}
        for decision in parsed.decisions:
            if decision.cluster_id in decisions_by_alias:
                raise AdjudicationProtocolError(
                    f"duplicate cluster decision: {decision.cluster_id}"
                )
            decisions_by_alias[decision.cluster_id] = decision
        if set(decisions_by_alias) != set(round_batch.cluster_by_alias):
            raise AdjudicationProtocolError("missing or unknown cluster decision")

        resolved: Dict[str, AdjudicationResult] = {}
        for cluster_alias, cluster in round_batch.cluster_by_alias.items():
            decision = decisions_by_alias[cluster_alias]
            if len(decision.selected_ids) != len(set(decision.selected_ids)):
                raise AdjudicationProtocolError("duplicate selected alias")
            allowed_aliases = round_batch.aliases_by_cluster[cluster.id]
            if any(alias not in allowed_aliases for alias in decision.selected_ids):
                raise AdjudicationProtocolError("unknown or cross-cluster selected alias")
            selected = tuple(
                round_batch.candidate_by_alias[alias] for alias in decision.selected_ids
            )

            if decision.reason == "missing_span" and decision.verdict != "defer":
                raise AdjudicationProtocolError("missing_span requires defer")
            if decision.verdict == "promote" and len(selected) != 1:
                raise AdjudicationProtocolError("promote requires exactly one span")
            if decision.verdict in {"reject", "defer"} and selected:
                raise AdjudicationProtocolError(
                    f"{decision.verdict} cannot select spans"
                )
            if decision.verdict == "split":
                if len(selected) < 2:
                    raise AdjudicationProtocolError("split requires at least two spans")
                if any(
                    cls._overlap(left, right)
                    for index, left in enumerate(selected)
                    for right in selected[index + 1 :]
                ):
                    raise AdjudicationProtocolError("split spans overlap")
            if decision.verdict == "supersede":
                if len(selected) != 1 or not cls._valid_supersede(
                    selected[0], cluster.alternatives
                ):
                    raise AdjudicationProtocolError(
                        "supersede span does not contain a replaced span"
                    )

            resolved[cluster.id] = AdjudicationResult(
                cluster_id=cluster.id,
                verdict=decision.verdict,
                selected_candidate_ids=tuple(sorted(item.id for item in selected)),
                entity_kind=decision.entity_kind,
                confidence=decision.confidence,
                reason=decision.reason,
            )
        return resolved

    def _model_name(self) -> str:
        try:
            return str(self.llm.get_model("candidate_adjudication"))
        except (AttributeError, KeyError, TypeError):
            return type(self.llm).__name__

    def _call_round(
        self,
        round_batch: _RoundBatch,
        *,
        knowledge_version: int,
    ) -> _RoundOutcome:
        base_messages = [
            {"role": "system", "content": ADJUDICATION_SYSTEM},
            {
                "role": "user",
                "content": json.dumps(round_batch.payload, ensure_ascii=False),
            },
        ]
        last_error = ""
        audit_attempts = []
        model = self._model_name()
        for _attempt in range(1, self.max_attempts + 1):
            messages = list(base_messages)
            if last_error:
                messages.append(
                    {
                        "role": "user",
                        "content": _adjudication_retry_message(last_error),
                    }
                )
            started = time.perf_counter()
            raw = ""
            parsed_payload = None
            try:
                raw = self.llm.chat(
                    messages=messages,
                    purpose="candidate_adjudication",
                    temperature=0.0,
                    max_tokens=self.max_tokens,
                    json_mode=True,
                    stream=False,
                )
                parsed = AdjudicationResponse.model_validate_json(
                    self._clean_json(raw)
                )
                parsed_payload = parsed.model_dump(mode="json")
                resolved = self._resolve_decisions(parsed, round_batch)
            except Exception as exc:
                last_error = str(exc)
                error_kind = _external_error_kind(exc)
                audit_attempts.append(
                    AdjudicationAuditAttempt(
                        messages=tuple(dict(message) for message in messages),
                        raw_response=str(raw or ""),
                        parsed=parsed_payload,
                        accepted=False,
                        attempt=_attempt,
                        elapsed_ms=int((time.perf_counter() - started) * 1000),
                        error=last_error,
                        error_kind=error_kind,
                        model=model,
                        knowledge_version=int(knowledge_version),
                        audit_mode=self.audit_mode,
                    )
                )
                continue
            audit_attempts.append(
                AdjudicationAuditAttempt(
                    messages=tuple(dict(message) for message in messages),
                    raw_response=str(raw or ""),
                    parsed=parsed_payload,
                    accepted=True,
                    attempt=_attempt,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                    error=None,
                    error_kind=None,
                    model=model,
                    knowledge_version=int(knowledge_version),
                    audit_mode=self.audit_mode,
                )
            )
            return _RoundOutcome(resolved, tuple(audit_attempts))
        return _RoundOutcome(None, tuple(audit_attempts))

    def _persist_audit_attempts(
        self,
        database: Any,
        run_id: str,
        audit_attempts: Sequence[AdjudicationAuditAttempt],
    ) -> None:
        for audit in audit_attempts:
            database.record_audit_call(
                run_id=run_id,
                block_id=None,
                purpose="candidate_adjudication",
                model=audit.model,
                knowledge_version=audit.knowledge_version,
                request={
                    "messages": [dict(message) for message in audit.messages],
                    "audit_mode": audit.audit_mode,
                },
                raw_response=audit.raw_response,
                parsed=dict(audit.parsed) if audit.parsed is not None else None,
                accepted=audit.accepted,
                attempts=audit.attempt,
                elapsed_ms=audit.elapsed_ms,
                error=audit.error,
            )

    @staticmethod
    def _needs_independent_round(
        cluster: CandidateCluster,
        decision: AdjudicationResult,
    ) -> bool:
        flags = set(cluster.risk_flags)
        for alternative in cluster.alternatives:
            flags.update(alternative.risk_flags)
        if {"coordination", "span_competition"} & flags:
            return True
        if any("type_conflict" in flag for flag in flags):
            return True
        if cluster.affected_blocks >= 3:
            return True
        if decision.confidence < 0.90:
            return True
        if decision.verdict in {"split", "supersede"}:
            return True
        if decision.entity_kind == "person":
            selected_ids = set(decision.selected_candidate_ids)
            for alternative in cluster.alternatives:
                if alternative.id not in selected_ids:
                    continue
                words = lexical_key(alternative.original_text).split()
                if any(word in COORDINATORS for word in words[1:-1]):
                    return True
        return False

    @staticmethod
    def _semantically_equal(
        first: AdjudicationResult,
        second: AdjudicationResult,
    ) -> bool:
        return (
            first.verdict,
            first.selected_candidate_ids,
            first.entity_kind,
        ) == (
            second.verdict,
            second.selected_candidate_ids,
            second.entity_kind,
        )

    @staticmethod
    def _deferred(
        cluster: CandidateCluster,
        reason: str,
        *,
        rounds: int,
    ) -> AdjudicationResult:
        return AdjudicationResult(
            cluster_id=cluster.id,
            verdict="defer",
            selected_candidate_ids=(),
            entity_kind="unknown_named_entity",
            confidence=0.0,
            reason=reason,
            rounds=rounds,
        )

    def _adjudicate_batch_outcome(
        self,
        batch_index: int,
        clusters: Sequence[CandidateCluster],
        source_texts: Mapping[str, str],
        *,
        knowledge_version: int,
    ) -> AdjudicationBatchOutcome:
        ordered = tuple(sorted(clusters, key=lambda cluster: cluster.id))
        if not self._source_spans_are_valid(ordered, source_texts):
            results = tuple(
                self._deferred(cluster, "model_protocol_failure", rounds=0)
                for cluster in ordered
            )
            return AdjudicationBatchOutcome(
                batch_index=batch_index,
                results=results,
                audit_attempts=(),
                model_calls=0,
                model_elapsed_ms_sum=0,
                error_kinds=(),
            )

        first_round = self._round_batch(ordered, reverse_alternatives=False)
        first = self._call_round(
            first_round,
            knowledge_version=knowledge_version,
        )
        if first.results is None:
            results = tuple(
                self._deferred(cluster, "model_protocol_failure", rounds=1)
                for cluster in ordered
            )
            return self._batch_outcome(
                batch_index, results, first.audit_attempts
            )

        risky = tuple(
            cluster
            for cluster in ordered
            if self._needs_independent_round(cluster, first.results[cluster.id])
        )
        if not risky:
            results = tuple(first.results[cluster.id] for cluster in ordered)
            return self._batch_outcome(
                batch_index, results, first.audit_attempts
            )

        second_round = self._round_batch(risky, reverse_alternatives=True)
        second = self._call_round(
            second_round,
            knowledge_version=knowledge_version,
        )
        final = dict(first.results)
        if second.results is None:
            for cluster in risky:
                final[cluster.id] = self._deferred(
                    cluster, "model_protocol_failure", rounds=2
                )
        else:
            for cluster in risky:
                first_decision = first.results[cluster.id]
                second_decision = second.results[cluster.id]
                if not self._semantically_equal(first_decision, second_decision):
                    final[cluster.id] = self._deferred(
                        cluster, "independent_verdict_conflict", rounds=2
                    )
                else:
                    final[cluster.id] = replace(
                        first_decision,
                        confidence=min(
                            first_decision.confidence, second_decision.confidence
                        ),
                        rounds=2,
                    )
        results = tuple(final[cluster.id] for cluster in ordered)
        return self._batch_outcome(
            batch_index,
            results,
            first.audit_attempts + second.audit_attempts,
        )

    @staticmethod
    def _batch_outcome(
        batch_index: int,
        results: Sequence[AdjudicationResult],
        audit_attempts: Sequence[AdjudicationAuditAttempt],
    ) -> AdjudicationBatchOutcome:
        attempts = tuple(audit_attempts)
        return AdjudicationBatchOutcome(
            batch_index=batch_index,
            results=tuple(results),
            audit_attempts=attempts,
            model_calls=len(attempts),
            model_elapsed_ms_sum=sum(item.elapsed_ms for item in attempts),
            error_kinds=tuple(
                item.error_kind for item in attempts if item.error_kind is not None
            ),
        )

    def _adjudicate_one_batch(
        self,
        clusters: Sequence[CandidateCluster],
        source_texts: Mapping[str, str],
        *,
        run_id: Optional[str] = None,
        database: Optional[Any] = None,
        knowledge_version: Optional[int] = None,
    ) -> tuple[AdjudicationResult, ...]:
        version = knowledge_version
        if version is None:
            version = (
                int(database.current_knowledge_version())
                if database is not None
                else 0
            )
        outcome = self._adjudicate_batch_outcome(
            0,
            clusters,
            source_texts,
            knowledge_version=int(version),
        )
        if run_id and database is not None:
            self._persist_audit_attempts(database, run_id, outcome.audit_attempts)
        return outcome.results

    def adjudicate(
        self,
        subject: CandidateClusterBatch | CandidateCluster | Sequence[CandidateCluster],
        source_texts: Mapping[str, str],
        *,
        run_id: Optional[str] = None,
        database: Optional[Any] = None,
        knowledge_version: Optional[int] = None,
    ) -> tuple[AdjudicationResult, ...]:
        """Adjudicate one batch or deterministically partition a cluster sequence."""

        clusters = self._clusters_from_subject(subject)
        if not clusters:
            return ()
        results = []
        for start in range(0, len(clusters), 12):
            results.extend(
                self._adjudicate_one_batch(
                    clusters[start : start + 12],
                    source_texts,
                    run_id=run_id,
                    database=database,
                    knowledge_version=knowledge_version,
                )
            )
        return tuple(results)

    def run(
        self,
        database: Optional[Any] = None,
        *,
        max_clusters: Optional[int] = None,
        initial_workers: int = 1,
        max_workers: int = 1,
    ) -> Dict[str, Any]:
        """Adjudicate persisted pending clusters as an independent stage."""
        store = database or self.database
        if store is None:
            raise ValueError("V4Adjudicator.run requires a database")
        initial_workers = int(initial_workers)
        max_workers = int(max_workers)
        if initial_workers < 1 or max_workers < 1:
            raise ValueError("adjudication worker counts must be positive")
        if initial_workers > max_workers:
            raise ValueError("initial_workers cannot exceed max_workers")
        if max_workers > 1 and self.llm_factory is None:
            raise ValueError("parallel adjudication requires an llm_factory")
        run_id = f"adjudicate_{uuid4().hex}"
        config = {
            "max_clusters": max_clusters,
            "batch_size": 12,
            "max_attempts": self.max_attempts,
            "initial_workers": initial_workers,
            "max_workers": max_workers,
        }
        store.start_run(run_id, "adjudicate", config)
        adjudicated = failed = deferred = 0
        concept_ids: set[str] = set()
        knowledge_version = None
        remaining = None if max_clusters is None else max(0, int(max_clusters))
        workers = initial_workers
        waves = batches = model_calls = model_elapsed_ms_sum = 0
        peak_workers = 0
        rate_limit_events = transient_error_events = worker_reductions = 0
        worker_history: list[int] = []
        started = time.perf_counter()
        try:
            if remaining == 0:
                store.finalize_adjudication_run(run_id, "completed")
            while remaining is None or remaining > 0:
                claimed_batches = []
                for _slot in range(workers):
                    claim_limit = 12 if remaining is None else min(12, remaining)
                    if claim_limit <= 0:
                        break
                    claimed = store.claim_pending_candidate_clusters(
                        run_id, claim_limit
                    )
                    if not claimed:
                        break
                    claimed_batches.append(tuple(claimed))
                    if remaining is not None:
                        remaining -= len(claimed)
                if not claimed_batches:
                    status = "completed_with_errors" if failed else "completed"
                    store.finalize_adjudication_run(run_id, status)
                    break
                waves += 1
                worker_history.append(workers)
                batches += len(claimed_batches)
                peak_workers = max(peak_workers, len(claimed_batches))
                source_texts = store.source_texts_for_candidate_clusters(
                    tuple(
                        cluster
                        for claimed_batch in claimed_batches
                        for cluster in claimed_batch
                    )
                )
                wave_knowledge_version = (
                    int(knowledge_version)
                    if knowledge_version is not None
                    else int(store.current_knowledge_version())
                )
                outcomes: list[AdjudicationBatchOutcome] = []
                worker_errors: list[Exception] = []
                with ThreadPoolExecutor(max_workers=len(claimed_batches)) as executor:
                    futures = []
                    for batch_index, claimed_batch in enumerate(claimed_batches):
                        worker = self._new_worker()
                        futures.append(
                            executor.submit(
                                worker._adjudicate_batch_outcome,
                                batch_index,
                                claimed_batch,
                                source_texts,
                                knowledge_version=wave_knowledge_version,
                            )
                        )
                    for future in futures:
                        try:
                            outcomes.append(future.result())
                        except Exception as exc:
                            worker_errors.append(exc)

                ordered_outcomes = sorted(
                    outcomes, key=lambda outcome: outcome.batch_index
                )
                no_more = (
                    remaining == 0
                    or not store.has_claimable_candidate_clusters()
                )
                for outcome_index, outcome in enumerate(ordered_outcomes):
                    results = outcome.results
                    batch_failed = sum(
                        result.reason == "model_protocol_failure"
                        for result in results
                    )
                    batch_deferred = sum(
                        result.verdict == "defer" for result in results
                    )
                    next_adjudicated = adjudicated + len(results)
                    next_failed = failed + batch_failed
                    next_deferred = deferred + batch_deferred
                    is_last_outcome = outcome_index == len(ordered_outcomes) - 1
                    final_status = None
                    if no_more and is_last_outcome and not worker_errors:
                        final_status = (
                            "completed_with_errors" if next_failed else "completed"
                        )
                    committed = store.commit_adjudications(
                        run_id,
                        results,
                        audit_attempts=outcome.audit_attempts,
                        require_lease=True,
                        finalize_run_status=final_status,
                    )
                    adjudicated = next_adjudicated
                    failed = next_failed
                    deferred = next_deferred
                    model_calls += outcome.model_calls
                    model_elapsed_ms_sum += outcome.model_elapsed_ms_sum
                    concept_ids.update(committed.get("concept_ids", []))
                    knowledge_version = committed.get("knowledge_version")
                wave_error_kinds = [
                    error_kind
                    for outcome in ordered_outcomes
                    for error_kind in outcome.error_kinds
                ]
                rate_limit_events += wave_error_kinds.count("rate_limit")
                transient_error_events += sum(
                    error_kind in {"timeout", "transient_network"}
                    for error_kind in wave_error_kinds
                )
                if worker_errors:
                    raise worker_errors[0]
                if no_more:
                    break
                previous_workers = workers
                if "rate_limit" in wave_error_kinds:
                    workers = max(1, workers // 2)
                elif {"timeout", "transient_network"} & set(wave_error_kinds):
                    workers = max(1, workers - 1)
                elif workers < max_workers:
                    workers += 1
                if workers < previous_workers:
                    worker_reductions += 1
            return {
                "run_id": run_id,
                "adjudicated": adjudicated,
                "concepts": len(concept_ids),
                "failed": failed,
                "deferred": deferred,
                "knowledge_version": knowledge_version,
                "initial_workers": initial_workers,
                "max_workers": max_workers,
                "peak_workers": peak_workers,
                "waves": waves,
                "batches": batches,
                "model_calls": model_calls,
                "model_elapsed_ms_sum": model_elapsed_ms_sum,
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
                "rate_limit_events": rate_limit_events,
                "transient_error_events": transient_error_events,
                "worker_reductions": worker_reductions,
                "worker_history": worker_history,
            }
        except Exception as exc:
            store.finalize_adjudication_run(run_id, "failed", str(exc))
            raise
