"""Bounded knowledge epochs for translation proposal checkpoints."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from .database import FrozenRenderBundle, V4Database
from .matcher import MultiFormMatcher
from .models import FormOccurrence, TranslationOutcome, V4BlockStatus
from .narrative_memory import NarrativeMemoryStore
from .narrative_models import NarrativeMemoryCandidate
from .revalidation import RevalidationPlanner


OCCURRENCE_BATCH_SIZE = 1_000


def _canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


@dataclass(frozen=True)
class KnowledgeEpoch:
    ordinal: int
    knowledge_version: int
    memory_version: int
    render_bundle: FrozenRenderBundle

    @property
    def index(self):
        return self.render_bundle.index


@dataclass(frozen=True)
class EpochCheckpointResult:
    epoch: KnowledgeEpoch
    applied: bool
    capped: bool
    reused: bool
    paused: bool
    staged_proposals: int
    deferred_proposals: int
    change_ids: tuple[int, ...]
    memory_change_ids: tuple[int, ...]
    planned_tasks: int
    payload_hash: str


class KnowledgeEpochCoordinator:
    """Stage proposal payloads and apply them at deterministic bounded checkpoints."""

    def __init__(
        self,
        database: V4Database,
        block_ids: Sequence[str] = (),
        *,
        max_knowledge_epochs: int = 3,
        decision_mode: str = "auto",
        pause_on_review: bool = False,
    ):
        if not isinstance(database, V4Database):
            raise TypeError("database must be a V4Database")
        if type(max_knowledge_epochs) is not int or max_knowledge_epochs < 1:
            raise ValueError("max_knowledge_epochs must be a positive integer")
        if decision_mode == "unattended":
            decision_mode = "auto"
        if decision_mode not in {"auto", "interactive"}:
            raise ValueError("decision_mode must be auto or interactive")
        self.database = database
        self.block_ids = tuple(dict.fromkeys(str(value) for value in block_ids))
        self.max_knowledge_epochs = max_knowledge_epochs
        self.decision_mode = decision_mode
        self.pause_on_review = bool(pause_on_review)
        self._ordinal = 0
        self._epoch: Optional[KnowledgeEpoch] = None
        self.narrative_store = NarrativeMemoryStore(database)

    def freeze(self) -> KnowledgeEpoch:
        if self._epoch is None:
            bundle = self.database.freeze_render_bundle(self.block_ids)
            self._epoch = KnowledgeEpoch(
                ordinal=self._ordinal,
                knowledge_version=bundle.knowledge_version,
                memory_version=self.narrative_store.current_memory_version(),
                render_bundle=bundle,
            )
        return self._epoch

    @staticmethod
    def _entry(outcome: TranslationOutcome) -> Optional[dict[str, Any]]:
        terms = [dict(value) for value in outcome.term_proposals]
        relations = [dict(value) for value in outcome.relation_proposals]
        supplemental_memory = [
            dict(value) for value in outcome.supplemental_memory_candidates
        ]
        if not terms and not relations and not supplemental_memory:
            return None
        payload = {
            "block_id": outcome.block.id,
            "knowledge_version": int(outcome.knowledge_version),
            "term_proposals": terms,
            "relation_proposals": relations,
            "supplemental_memory_candidates": supplemental_memory,
        }
        payload["entry_hash"] = hashlib.sha256(
            _canonical(
                {
                    "block_id": payload["block_id"],
                    "term_proposals": terms,
                    "relation_proposals": relations,
                    "supplemental_memory_candidates": supplemental_memory,
                }
            ).encode("utf-8")
        ).hexdigest()
        return payload

    def _initial_state(self) -> dict[str, Any]:
        epoch = self.freeze()
        return {
            "ordinal": epoch.ordinal,
            "base_knowledge_version": epoch.knowledge_version,
            "base_memory_version": epoch.memory_version,
            "staged": [],
            "seen_entry_hashes": [],
            "checkpoints": {},
            "deferred_proposals": 0,
        }

    def _load_state(
        self,
        run_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        state = self.database.load_knowledge_epoch_state(
            run_id,
            connection=connection,
        )
        if not state:
            return self._initial_state()
        ordinal = state.get("ordinal")
        base_version = state.get("base_knowledge_version")
        base_memory_version = state.get("base_memory_version")
        if type(ordinal) is not int or ordinal < 0:
            raise ValueError("knowledge epoch ordinal is invalid")
        if type(base_version) is not int or base_version < 1:
            raise ValueError("knowledge epoch base version is invalid")
        if type(base_memory_version) is not int or base_memory_version < 1:
            raise ValueError("knowledge epoch base memory version is invalid")
        for key in ("staged", "seen_entry_hashes"):
            if not isinstance(state.get(key), list):
                raise ValueError(f"knowledge epoch {key} is invalid")
        if not isinstance(state.get("checkpoints"), dict):
            raise ValueError("knowledge epoch checkpoints are invalid")
        self._ordinal = ordinal
        return state

    def stage(
        self,
        run_id: str,
        outcomes: Sequence[TranslationOutcome],
        connection: sqlite3.Connection | None = None,
    ) -> int:
        if isinstance(outcomes, (str, bytes)) or not isinstance(outcomes, Sequence):
            raise TypeError("epoch outcomes must be a sequence")
        state = self._load_state(run_id, connection)
        seen = {str(value) for value in state["seen_entry_hashes"]}
        staged_hashes = {
            str(entry.get("entry_hash") or "")
            for entry in state["staged"]
            if isinstance(entry, Mapping)
        }
        added = 0
        for outcome in outcomes:
            if not isinstance(outcome, TranslationOutcome):
                raise TypeError("epoch outcomes must contain TranslationOutcome values")
            entry = self._entry(outcome)
            if entry is None or entry["entry_hash"] in seen | staged_hashes:
                continue
            state["staged"].append(entry)
            staged_hashes.add(entry["entry_hash"])
            added += (
                len(entry["term_proposals"])
                + len(entry["relation_proposals"])
                + len(entry["supplemental_memory_candidates"])
            )
        self.database.save_knowledge_epoch_state(
            run_id,
            state,
            connection=connection,
        )
        return added

    def _restore_outcomes(
        self, staged: Sequence[Mapping[str, Any]]
    ) -> list[TranslationOutcome]:
        restored: list[TranslationOutcome] = []
        for entry in staged:
            block = self.database.get_block_by_identifier(str(entry["block_id"]))
            restored.append(
                TranslationOutcome(
                    block=block,
                    knowledge_version=int(entry["knowledge_version"]),
                    status=V4BlockStatus.COMPLETED.value,
                    term_proposals=[dict(value) for value in entry["term_proposals"]],
                    relation_proposals=[
                        dict(value) for value in entry["relation_proposals"]
                    ],
                    supplemental_memory_candidates=[
                        dict(value)
                        for value in entry.get(
                            "supplemental_memory_candidates"
                        )
                        or ()
                    ],
                )
            )
        return restored

    @staticmethod
    def _proposal_count(staged: Sequence[Mapping[str, Any]]) -> int:
        return sum(
            len(entry.get("term_proposals") or ())
            + len(entry.get("relation_proposals") or ())
            + len(entry.get("supplemental_memory_candidates") or ())
            for entry in staged
        )

    def _ensure_term_forms(
        self,
        staged: Sequence[Mapping[str, Any]],
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, str]:
        forms = sorted(
            {
                str(proposal.get("src") or "").strip()
                for entry in staged
                for proposal in entry.get("term_proposals") or ()
                if isinstance(proposal, Mapping)
                and str(proposal.get("src") or "").strip()
            },
            key=lambda value: (value.casefold(), value),
        )
        if not forms:
            return {}
        if connection is not None:
            return {
                form: self.database.ensure_lexeme(
                    form, connection=connection
                )
                for form in forms
            }
        with self.database.transaction() as connection:
            return {
                form: self.database.ensure_lexeme(form, connection=connection)
                for form in forms
            }

    def backfill_form_occurrences(
        self,
        forms: Mapping[str, str],
        connection: sqlite3.Connection | None = None,
    ) -> int:
        """Scan every active source block once and idempotently batch occurrences."""

        if not isinstance(forms, Mapping):
            raise TypeError("forms must be a mapping from source form to lexeme id")
        normalized = {
            str(form).strip(): str(lexeme_id).strip()
            for form, lexeme_id in forms.items()
            if str(form).strip() and str(lexeme_id).strip()
        }
        if not normalized:
            return 0
        matcher = MultiFormMatcher.compile(
            {form: (lexeme_id,) for form, lexeme_id in normalized.items()}
        )
        inserted = 0
        batch: list[FormOccurrence] = []
        blocks = self.database.list_blocks()
        def write(active: sqlite3.Connection) -> None:
            nonlocal inserted
            for block in blocks:
                for lexeme_id, source_form, start, end in matcher.finditer(
                    block.source_text
                ):
                    batch.append(
                        FormOccurrence(
                            lexeme_id=lexeme_id,
                            block_id=block.id,
                            start_offset=start,
                            end_offset=end,
                            source_form=source_form,
                            source_hash=block.source_hash,
                        )
                    )
                    if len(batch) == OCCURRENCE_BATCH_SIZE:
                        inserted += self.database.record_form_occurrences(
                            batch, connection=active
                        )
                        batch.clear()
            if batch:
                inserted += self.database.record_form_occurrences(
                    batch, connection=active
                )
        if connection is not None:
            write(connection)
        else:
            with self.database.transaction() as active:
                write(active)
        return inserted

    def _result_from_state(
        self, raw: Mapping[str, Any], *, reused: bool
    ) -> EpochCheckpointResult:
        self._ordinal = int(raw["ordinal"])
        if self._epoch is not None and self._epoch.ordinal != self._ordinal:
            self._epoch = None
        epoch = self.freeze()
        return EpochCheckpointResult(
            epoch=epoch,
            applied=bool(raw.get("applied")),
            capped=bool(raw.get("capped")),
            reused=reused,
            paused=bool(raw.get("paused")),
            staged_proposals=int(raw.get("staged_proposals") or 0),
            deferred_proposals=int(raw.get("deferred_proposals") or 0),
            change_ids=tuple(int(value) for value in raw.get("change_ids") or ()),
            memory_change_ids=tuple(
                int(value)
                for value in raw.get("memory_change_ids") or ()
            ),
            planned_tasks=int(raw.get("planned_tasks") or 0),
            payload_hash=str(raw.get("payload_hash") or ""),
        )

    def checkpoint_in_transaction(
        self,
        run_id: str,
        connection: sqlite3.Connection,
    ) -> tuple[dict[str, Any], bool]:
        if not connection.in_transaction:
            raise ValueError(
                "checkpoint connection requires an active transaction"
            )
        state = self._load_state(run_id, connection)
        staged = [dict(value) for value in state["staged"]]
        base_version = int(state["base_knowledge_version"])
        base_memory_version = int(state["base_memory_version"])
        external_change_ids = self.database.knowledge_change_ids_after(
            base_version,
            connection=connection,
        )
        current_memory_version = (
            self.narrative_store.current_memory_version(connection)
        )
        external_memory_change_ids = (
            self.narrative_store.memory_change_ids_between(
                base_memory_version,
                current_memory_version,
                connection=connection,
            )
        )
        if (
            not staged
            and not external_change_ids
            and not external_memory_change_ids
            and isinstance(
            state.get("last_result"), Mapping
            )
        ):
            return dict(state["last_result"]), True
        payload_hash = hashlib.sha256(
            _canonical(
                {
                    "ordinal": int(state["ordinal"]),
                    "staged": staged,
                    "external_change_ids": external_change_ids,
                    "external_memory_change_ids": external_memory_change_ids,
                }
            ).encode("utf-8")
        ).hexdigest()
        checkpoint_key = f"{state['ordinal']}:{payload_hash}"
        prior = state["checkpoints"].get(checkpoint_key)
        if isinstance(prior, Mapping):
            return dict(prior), True

        staged_count = self._proposal_count(staged)
        capped = bool(staged and int(state["ordinal"]) >= self.max_knowledge_epochs - 1)
        proposal_change_ids: list[int] = []
        memory_change_ids: list[int] = []
        proposal_version: Optional[int] = None
        applied = False
        if staged and not capped:
            proposed_forms = self._ensure_term_forms(
                staged,
                connection=connection,
            )
            if proposed_forms:
                self.backfill_form_occurrences(
                    proposed_forms,
                    connection=connection,
                )
            restored = self._restore_outcomes(staged)
            if any(
                outcome.term_proposals or outcome.relation_proposals
                for outcome in restored
            ):
                proposal_result = self.database.commit_translation_proposals(
                    run_id,
                    restored,
                    enqueue_review=self.decision_mode == "interactive",
                    return_change_ids=True,
                    connection=connection,
                )
                if isinstance(proposal_result, Mapping):
                    if proposal_result.get("knowledge_version") is not None:
                        proposal_version = int(
                            proposal_result["knowledge_version"]
                        )
                    proposal_change_ids = [
                        int(value)
                        for value in proposal_result.get("change_ids") or ()
                    ]
                elif proposal_result is not None:
                    proposal_version = int(proposal_result)
            for outcome in sorted(
                restored, key=lambda value: value.block.global_index
            ):
                candidates = [
                    NarrativeMemoryCandidate.from_mapping(value)
                    for value in outcome.supplemental_memory_candidates
                ]
                if not candidates:
                    continue
                merged = self.narrative_store.merge_candidates(
                    outcome.block,
                    candidates,
                    source="translation_supplemental",
                    connection=connection,
                )
                memory_change_ids.extend(merged.change_ids)
            applied = bool(proposal_version is not None or memory_change_ids)

        final_high_water = self.database.current_knowledge_version(
            connection
        )
        final_memory_high_water = (
            self.narrative_store.current_memory_version(connection)
        )
        bounded_change_ids = self.database.knowledge_change_ids_between(
            base_version,
            final_high_water,
            connection=connection,
        )
        change_ids = tuple(sorted(set(bounded_change_ids + proposal_change_ids)))
        bounded_memory_change_ids = (
            self.narrative_store.memory_change_ids_between(
                base_memory_version,
                final_memory_high_water,
                connection=connection,
            )
        )
        memory_change_ids = tuple(
            sorted(
                set(
                    bounded_memory_change_ids
                    + memory_change_ids
                    + external_memory_change_ids
                )
            )
        )
        planned_tasks = 0
        planner = RevalidationPlanner(self.database)
        if change_ids:
            planned_tasks += int(
                planner.plan(
                    change_ids,
                    connection=connection,
                )["planned"]
            )
        if memory_change_ids:
            planned_tasks += int(
                planner.plan_memory(
                    memory_change_ids,
                    connection=connection,
                )["planned"]
            )
        advanced = (
            final_high_water > base_version
            or final_memory_high_water > base_memory_version
        )
        if advanced:
            state["ordinal"] = min(
                self.max_knowledge_epochs - 1, int(state["ordinal"]) + 1
            )
        state["base_knowledge_version"] = final_high_water
        state["base_memory_version"] = final_memory_high_water
        if not capped:
            state["seen_entry_hashes"] = sorted(
                set(str(value) for value in state["seen_entry_hashes"])
                | {str(entry["entry_hash"]) for entry in staged}
            )
            state["staged"] = []
        state["deferred_proposals"] = (
            self._proposal_count(state["staged"]) if capped else 0
        )
        paused = bool(
            self.decision_mode == "interactive"
            and self.pause_on_review
            and proposal_version is not None
        )
        raw_result = {
            "ordinal": int(state["ordinal"]),
            "applied": applied,
            "capped": capped,
            "paused": paused,
            "staged_proposals": staged_count,
            "deferred_proposals": int(state["deferred_proposals"]),
            "change_ids": list(change_ids),
            "memory_change_ids": list(memory_change_ids),
            "planned_tasks": planned_tasks,
            "payload_hash": payload_hash,
        }
        state["checkpoints"][checkpoint_key] = raw_result
        state["last_result"] = raw_result
        self._ordinal = int(state["ordinal"])
        if advanced:
            self._epoch = None
        self.database.save_knowledge_epoch_state(
            run_id,
            state,
            knowledge_version=final_high_water,
            connection=connection,
        )
        return raw_result, False

    def checkpoint(self, run_id: str) -> EpochCheckpointResult:
        with self.database.transaction() as connection:
            raw_result, reused = self.checkpoint_in_transaction(
                run_id,
                connection,
            )
        return self._result_from_state(raw_result, reused=reused)
