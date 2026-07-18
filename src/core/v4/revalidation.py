"""Plan precise schema-8 revalidation work from persisted dependency indexes."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import unicodedata
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from pydantic import ValidationError

from .database import V4Database, utc_now
from .models import (
    RevalidationClaim,
    RevalidationResponse,
    TranslationOutcome,
    V4BlockStatus,
)
from .repairer import V4Repairer


MAX_CHANGE_IDS = 1024
MAX_RAW_CHANGE_IDS = MAX_CHANGE_IDS
MAX_INPUT_BYTES = 16 * 1024
MAX_RESULT_BYTES = 64 * 1024
_MAX_PAYLOAD_BYTES = 64 * 1024
_MAX_PAYLOAD_IDS = 64
_MAX_SUBJECT_ID_CHARS = 256
_MAX_RESULT_SUBJECTS = 128
_MAX_RESULT_REASONS = MAX_CHANGE_IDS
_MAX_AUDIT_RAW_CHARS = 16_384


REVALIDATION_SYSTEM = """You validate one frozen stale-translation task.
Use only the supplied block source, active translation, old/new effective targets and
rules, numeric half-open spans, change reasons, and impact levels. Return exactly one
JSON object with task, cases, action, optional spans/subjects, confidence, rationale.
action must be no_effect, patch_required, retranslate, or uncertain. Do not use or
request book-wide knowledge, evidence, or adjacent blocks."""


class PlanningBudgetError(ValueError):
    """Raised before committing a plan that exceeds a persisted size budget."""


class PlanningProtocolError(ValueError):
    """Raised when persisted task provenance cannot be safely merged."""


@dataclass
class _Candidate:
    translation_id: int
    block_id: str
    from_version: int
    source_hash: str
    changes: dict[int, dict[str, Any]] = field(default_factory=dict)


@dataclass
class _MemoryCandidate:
    translation_id: int
    block_id: str
    knowledge_version: int
    from_memory_version: int
    source_hash: str
    changes: dict[int, dict[str, Any]] = field(default_factory=dict)


def classify_memory_change(change_kind: str, high_impact: bool = False) -> int:
    """Return the conservative revalidation impact for a narrative change."""

    if high_impact:
        return 3
    normalized = str(change_kind or "").strip().casefold()
    if any(
        token in normalized
        for token in (
            "viewpoint",
            "timeline",
            "scene_time",
            "narrator",
            "presentation_layer",
            "identity",
        )
    ):
        return 3
    if any(
        token in normalized
        for token in (
            "relationship",
            "location",
            "character_state",
            "contradiction",
            "supersede",
            "answer",
            "close_question",
        )
    ):
        return 2
    if any(
        token in normalized
        for token in (
            "render_only",
            "address",
            "honorific",
            "style_signal",
        )
    ):
        return 1
    return 0


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _change_set_hash(change_ids: Sequence[int], to_version: int) -> str:
    canonical = _canonical_json(
        {
            "change_ids": sorted(set(int(value) for value in change_ids)),
            "to_knowledge_version": int(to_version),
        }
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _memory_change_set_hash(
    change_ids: Sequence[int], to_memory_version: int
) -> str:
    canonical = _canonical_json(
        {
            "change_domain": "memory",
            "change_ids": sorted(set(int(value) for value in change_ids)),
            "to_memory_version": int(to_memory_version),
        }
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _task_id(translation_id: int, change_hash: str) -> str:
    digest = hashlib.sha256(
        f"{int(translation_id)}:{change_hash}".encode("utf-8")
    ).hexdigest()
    return f"revalidate_{digest[:24]}"


def _parse_task_result(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise ValueError("pending revalidation result_json must be text")
    if len(raw.encode("utf-8")) > MAX_RESULT_BYTES:
        raise PlanningBudgetError("pending revalidation result exceeds byte budget")
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        raise ValueError("pending revalidation result_json is invalid JSON") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("change_ids"), list):
        raise ValueError("pending revalidation result must contain change_ids")
    raw_ids = payload["change_ids"]
    if not raw_ids:
        raise ValueError("pending revalidation change_ids cannot be empty")
    if len(raw_ids) > MAX_CHANGE_IDS:
        raise PlanningBudgetError("pending revalidation change_ids exceed budget")
    values: list[int] = []
    for value in payload["change_ids"]:
        if type(value) is not int or value <= 0:
            raise ValueError("pending revalidation change_ids must be positive integers")
        values.append(value)
    if values != sorted(set(values)):
        raise ValueError("pending revalidation change_ids must be sorted and unique")
    for key in ("subjects", "reasons"):
        if key in payload and not isinstance(payload[key], list):
            raise ValueError(f"pending revalidation {key} must be a list")
    if len(payload.get("subjects", [])) > _MAX_RESULT_SUBJECTS:
        raise PlanningBudgetError("pending revalidation subjects exceed budget")
    if len(payload.get("reasons", [])) > _MAX_RESULT_REASONS:
        raise PlanningBudgetError("pending revalidation reasons exceed budget")
    subjects = payload.get("subjects", [])
    if any(
        not isinstance(item, dict)
        or not isinstance(item.get("subject_type"), str)
        or not isinstance(item.get("subject_id"), str)
        for item in subjects
    ):
        raise ValueError("pending revalidation subjects are invalid")
    reasons = payload.get("reasons", [])
    if any(
        not isinstance(item, dict)
        or type(item.get("change_id")) is not int
        or item["change_id"] <= 0
        or not isinstance(item.get("change_kind"), str)
        or not isinstance(item.get("via"), list)
        or not item["via"]
        or any(not isinstance(via, str) for via in item["via"])
        or not isinstance(item.get("subjects"), list)
        or not item["subjects"]
        or any(
            not isinstance(subject, dict)
            or not isinstance(subject.get("subject_type"), str)
            or not isinstance(subject.get("subject_id"), str)
            for subject in item["subjects"]
        )
        for item in reasons
    ):
        raise PlanningProtocolError(
            "pending revalidation provenance reasons are invalid"
        )
    for key in ("omitted_subjects", "omitted_reasons"):
        if key in payload and (type(payload[key]) is not int or payload[key] < 0):
            raise ValueError(f"pending revalidation {key} must be a non-negative integer")
    if int(payload.get("omitted_reasons", 0)) != 0:
        raise PlanningProtocolError(
            "pending revalidation provenance cannot omit reasons"
        )
    if len(reasons) != len(values):
        raise PlanningProtocolError(
            "pending revalidation provenance reason count is inconsistent"
        )
    details: dict[int, dict[str, Any]] = {}
    for reason in reasons:
        change_id = int(reason["change_id"])
        if change_id not in values or change_id in details:
            raise PlanningProtocolError(
                "pending revalidation provenance change IDs are inconsistent"
            )
        details[change_id] = {
            "change_kind": str(reason["change_kind"]),
            "via": tuple(sorted(set(str(value) for value in reason["via"]))),
            "subjects": tuple(
                sorted(
                    {
                        (str(subject["subject_type"]), str(subject["subject_id"]))
                        for subject in reason["subjects"]
                    }
                )
            ),
        }
    return {"change_ids": set(values), "details": details, "payload": payload}


def _authentic_source(source_text: str, source_hash: str) -> bool:
    return (
        len(source_hash) == 64
        and all(character in "0123456789abcdef" for character in source_hash)
        and hashlib.sha256(source_text.encode("utf-8")).hexdigest() == source_hash
    )


class RevalidationPlanner:
    """Create or merge pending tasks without executing validation work."""

    def __init__(self, database: V4Database):
        if not isinstance(database, V4Database):
            raise TypeError("database must be a V4Database")
        self.database = database

    @staticmethod
    def _normalize_change_ids(change_ids: Sequence[int]) -> list[int]:
        if isinstance(change_ids, (str, bytes)) or not isinstance(change_ids, Sequence):
            raise TypeError("change_ids must be a sequence of positive integers")
        raw_length = len(change_ids)
        if raw_length > MAX_RAW_CHANGE_IDS:
            raise PlanningBudgetError("raw change_ids exceed planning budget")
        normalized: set[int] = set()
        raw_count = 0
        input_bytes = 0
        for value in change_ids:
            raw_count += 1
            if raw_count > MAX_RAW_CHANGE_IDS:
                raise PlanningBudgetError("raw change_ids exceed planning budget")
            if type(value) is not int or value <= 0:
                raise ValueError("change_ids must contain positive integers")
            try:
                input_bytes += len(str(value)) + 1
            except (ValueError, OverflowError):
                raise PlanningBudgetError("change_ids exceed input byte budget") from None
            if input_bytes > MAX_INPUT_BYTES:
                raise PlanningBudgetError("change_ids exceed input byte budget")
            normalized.add(value)
            if len(normalized) > MAX_CHANGE_IDS:
                raise PlanningBudgetError("change_ids exceed planning budget")
        return sorted(normalized)

    @staticmethod
    def _verified_concept_redirect(
        connection: sqlite3.Connection,
        retired_id: str,
        canonical_id: str,
        change_version: int,
    ) -> bool:
        if retired_id == canonical_id:
            return False
        retired = connection.execute(
            "SELECT created_version, retired_version FROM concepts WHERE id=?",
            (retired_id,),
        ).fetchone()
        canonical = connection.execute(
            "SELECT created_version, retired_version FROM concepts WHERE id=?",
            (canonical_id,),
        ).fetchone()
        if (
            retired is None
            or canonical is None
            or int(retired["created_version"]) > change_version
            or int(canonical["created_version"]) > change_version
            or retired["retired_version"] is None
            or int(retired["retired_version"]) > change_version
            or (
                canonical["retired_version"] is not None
                and int(canonical["retired_version"]) <= change_version
            )
        ):
            return False
        current = retired_id
        visited: set[str] = set()
        for _ in range(64):
            if current in visited:
                return False
            visited.add(current)
            edge = connection.execute(
                """SELECT canonical_concept_id, knowledge_version
                   FROM concept_redirects WHERE retired_concept_id=?""",
                (current,),
            ).fetchone()
            if edge is None or int(edge["knowledge_version"]) > change_version:
                return False
            current = str(edge["canonical_concept_id"])
            if current == canonical_id:
                return True
        return False

    @classmethod
    def _safe_payload_subjects(
        cls, connection: sqlite3.Connection, row: sqlite3.Row
    ) -> list[tuple[str, str]]:
        """Expand only payload relationships proven by schema-8 rows."""

        raw = str(row["payload_json"] or "{}")
        if len(raw.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
            return []
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        if not isinstance(payload, dict):
            return []
        kind = str(row["change_kind"] or "").casefold()
        subject_type = str(row["subject_type"] or "").strip()
        subject_id = str(row["subject_id"] or "").strip()
        change_version = int(row["knowledge_version"])
        subjects: set[tuple[str, str]] = set()

        if subject_type == "concept" and any(
            token in kind for token in ("merge", "redirect", "subject_link")
        ):
            explicit_canonical = payload.get(
                "canonical_concept_id", payload.get("canonical_id", subject_id)
            )
            if explicit_canonical == subject_id and connection.execute(
                """SELECT 1 FROM concepts
                   WHERE id=? AND created_version<=?
                     AND (retired_version IS NULL OR retired_version>?)""",
                (subject_id, change_version, change_version),
            ).fetchone() is not None:
                values: list[Any] = []
                for key in ("retired_concept_id", "old_concept_id"):
                    if key in payload:
                        values.append(payload[key])
                merged = payload.get("merged_concept_ids", [])
                if isinstance(merged, list) and len(merged) <= _MAX_PAYLOAD_IDS:
                    values.extend(merged)
                for value in values:
                    if not isinstance(value, str):
                        continue
                    retired_id = value.strip()
                    if (
                        0 < len(retired_id) <= _MAX_SUBJECT_ID_CHARS
                        and cls._verified_concept_redirect(
                            connection, retired_id, subject_id, change_version
                        )
                    ):
                        subjects.add(("concept", retired_id))

        if subject_type in {"concept", "lexeme"} and "rule" in kind:
            values: list[Any] = []
            for key in ("rule_id", "old_rule_id", "new_rule_id"):
                if key in payload:
                    values.append(payload[key])
            rule_ids = payload.get("rule_ids", [])
            if isinstance(rule_ids, list) and len(rule_ids) <= _MAX_PAYLOAD_IDS:
                values.extend(rule_ids)
            owner_column = "concept_id" if subject_type == "concept" else "lexeme_id"
            for value in values:
                if not isinstance(value, str):
                    continue
                rule_id = value.strip()
                if not 0 < len(rule_id) <= _MAX_SUBJECT_ID_CHARS:
                    continue
                if connection.execute(
                    f"""SELECT 1 FROM rendering_rules
                         WHERE id=? AND {owner_column}=? AND created_version<=?
                           AND (retired_version IS NULL OR retired_version>?)""",
                    (rule_id, subject_id, change_version, change_version),
                ).fetchone() is not None:
                    subjects.add(("rule", rule_id))

        if subject_type == "concept" and any(
            token in kind for token in ("source_form", "alias", "lexeme")
        ):
            values = []
            for key in ("lexeme_id", "old_lexeme_id", "new_lexeme_id"):
                if key in payload:
                    values.append(payload[key])
            lexeme_ids = payload.get("lexeme_ids", [])
            if isinstance(lexeme_ids, list) and len(lexeme_ids) <= _MAX_PAYLOAD_IDS:
                values.extend(lexeme_ids)
            for value in values:
                if not isinstance(value, str):
                    continue
                lexeme_id = value.strip()
                if not 0 < len(lexeme_id) <= _MAX_SUBJECT_ID_CHARS:
                    continue
                if connection.execute(
                    """SELECT 1 FROM concept_lexemes
                       WHERE concept_id=? AND lexeme_id=? AND created_version<=?
                         AND (retired_version IS NULL OR retired_version>?)""",
                    (subject_id, lexeme_id, change_version, change_version),
                ).fetchone() is not None:
                    subjects.add(("lexeme", lexeme_id))
        return sorted(subjects)

    @staticmethod
    def _dependency_snapshot_is_current(row: sqlite3.Row) -> bool:
        source_hash = str(row["source_hash"] or "")
        source_text = str(row["source_text"] or "")
        if not _authentic_source(source_text, source_hash):
            return False
        raw_spans = str(row["source_spans_json"] or "[]")
        try:
            spans = json.loads(raw_spans)
        except (TypeError, ValueError, json.JSONDecodeError):
            return False
        if not isinstance(spans, list) or not spans or len(spans) > 128:
            return False
        matched_form = str(row["matched_form"] or "")
        if not matched_form:
            return False
        normalized_form = unicodedata.normalize("NFKC", matched_form)
        for span in spans:
            if (
                not isinstance(span, list)
                or len(span) != 2
                or isinstance(span[0], bool)
                or isinstance(span[1], bool)
                or not isinstance(span[0], int)
                or not isinstance(span[1], int)
            ):
                return False
            start, end = span
            if not 0 <= start < end <= len(source_text):
                return False
            if unicodedata.normalize("NFKC", source_text[start:end]) != normalized_form:
                return False
        return True

    @staticmethod
    def _occurrence_snapshot_is_current(row: sqlite3.Row) -> bool:
        source_text = str(row["source_text"] or "")
        block_hash = str(row["source_hash"] or "")
        occurrence_hash = str(row["occurrence_source_hash"] or "")
        if not _authentic_source(source_text, block_hash) or occurrence_hash != block_hash:
            return False
        start = row["start_offset"]
        end = row["end_offset"]
        if type(start) is not int or type(end) is not int:
            return False
        if not 0 <= start < end <= len(source_text):
            return False
        return (
            unicodedata.normalize("NFKC", source_text[start:end])
            == unicodedata.normalize("NFKC", str(row["source_form"] or ""))
        )

    @staticmethod
    def _empty_result(requested: int = 0, effective: int = 0) -> dict[str, Any]:
        return {
            "requested": requested,
            "effective": effective,
            "planned": 0,
            "created": 0,
            "merged": 0,
            "unchanged": 0,
            "retired": 0,
        }

    def plan(
        self,
        change_ids: Sequence[int],
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        normalized = self._normalize_change_ids(change_ids)
        if not normalized:
            return self._empty_result()
        if connection is not None:
            with self.database._method_savepoint(
                connection, "revalidation_plan"
            ):
                return self._plan_in_transaction(connection, normalized)
        with self.database.transaction() as connection:
            with self.database._method_savepoint(connection, "revalidation_plan"):
                return self._plan_in_transaction(connection, normalized)

    def plan_memory(
        self,
        change_ids: Sequence[int],
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Plan only translations whose frozen narrative context can change."""

        normalized = self._normalize_change_ids(change_ids)
        if not normalized:
            return {**self._empty_result(), "planned_block_ids": []}
        if connection is not None:
            with self.database._method_savepoint(
                connection, "memory_revalidation_plan"
            ):
                return self._plan_memory_in_transaction(
                    connection, normalized
                )
        with self.database.transaction() as connection:
            with self.database._method_savepoint(
                connection, "memory_revalidation_plan"
            ):
                return self._plan_memory_in_transaction(connection, normalized)

    def _plan_memory_in_transaction(
        self, connection: sqlite3.Connection, change_ids: list[int]
    ) -> dict[str, Any]:
        connection.execute(
            "CREATE TEMP TABLE memory_revalidation_input(id INTEGER PRIMARY KEY)"
        )
        connection.executemany(
            "INSERT INTO memory_revalidation_input(id) VALUES(?)",
            [(change_id,) for change_id in change_ids],
        )
        rows = connection.execute(
            """SELECT mc.* FROM memory_changes mc
               JOIN memory_revalidation_input input ON input.id=mc.id
               ORDER BY mc.id"""
        ).fetchall()
        found = {int(row["id"]) for row in rows}
        missing = sorted(set(change_ids) - found)
        if missing:
            raise KeyError(f"unknown narrative memory change: {missing[0]}")

        effective_rows: list[tuple[sqlite3.Row, int]] = []
        for row in rows:
            try:
                payload = json.loads(str(row["payload_json"] or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                payload = {}
            high_impact = bool(
                isinstance(payload, dict) and payload.get("high_impact")
            )
            impact = max(
                int(row["impact_level"]),
                classify_memory_change(
                    str(row["change_kind"]), high_impact=high_impact
                ),
            )
            if (
                impact > 0
                and str(row["old_fingerprint"] or "")
                != str(row["new_fingerprint"] or "")
            ):
                effective_rows.append((row, impact))

        retired_payload = _canonical_json({"reason": "translation_inactive"})
        retired = connection.execute(
            """UPDATE revalidation_tasks AS task
               SET status='resolved_noop', result_json=?, resolved_at=?
               WHERE task.status='pending'
                 AND task.change_domain='memory'
                 AND NOT EXISTS(
                     SELECT 1 FROM translation_versions tv
                     WHERE tv.id=task.translation_id AND tv.active=1
                 )""",
            (retired_payload, utc_now()),
        ).rowcount
        if not effective_rows:
            result = self._empty_result(len(change_ids), 0)
            result.update(
                {
                    "retired": int(retired),
                    "planned_block_ids": [],
                }
            )
            return result

        connection.execute(
            """CREATE TEMP TABLE memory_revalidation_changes(
                   change_id INTEGER PRIMARY KEY,
                   memory_version INTEGER NOT NULL,
                   impact_level INTEGER NOT NULL,
                   change_kind TEXT NOT NULL,
                   subject_type TEXT NOT NULL,
                   subject_id TEXT NOT NULL,
                   old_fingerprint TEXT NOT NULL,
                   new_fingerprint TEXT NOT NULL
               )"""
        )
        connection.executemany(
            """INSERT INTO memory_revalidation_changes(
                   change_id, memory_version, impact_level, change_kind,
                   subject_type, subject_id, old_fingerprint, new_fingerprint)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    int(row["id"]),
                    int(row["memory_version"]),
                    impact,
                    str(row["change_kind"]),
                    str(row["subject_type"]),
                    str(row["subject_id"]),
                    str(row["old_fingerprint"] or ""),
                    str(row["new_fingerprint"] or ""),
                )
                for row, impact in effective_rows
            ],
        )

        candidates: dict[int, _MemoryCandidate] = {}
        direct_rows = connection.execute(
            """SELECT DISTINCT
                      tv.id translation_id, tv.block_id,
                      tv.knowledge_version, tv.memory_version from_memory_version,
                      b.source_hash, b.source_text,
                      change.change_id, change.memory_version,
                      change.impact_level, change.change_kind,
                      change.subject_type, change.subject_id
               FROM memory_revalidation_changes change
               JOIN dependencies dependency
                 ON dependency.dependency_type='narrative_memory'
                AND dependency.dependency_id=change.subject_id
               JOIN translation_versions tv
                 ON tv.id=dependency.translation_id
               JOIN blocks b ON b.id=tv.block_id
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               WHERE tv.active=1 AND tv.pipeline='parallel_v4'
                 AND tv.status IN ('completed','completed_with_warnings')
                 AND b.status IN ('completed','completed_with_warnings')
                 AND tv.memory_version IS NOT NULL
                 AND change.memory_version>tv.memory_version
                 AND dependency.dependency_fingerprint
                     <>change.new_fingerprint
               ORDER BY tv.id, change.change_id"""
        ).fetchall()
        for row in direct_rows:
            if _authentic_source(
                str(row["source_text"]), str(row["source_hash"])
            ):
                self._add_memory_candidate(
                    candidates, row, "narrative_dependency"
                )

        subject_rows = connection.execute(
            """SELECT DISTINCT
                      tv.id translation_id, tv.block_id,
                      tv.knowledge_version, tv.memory_version from_memory_version,
                      b.source_hash, b.source_text,
                      change.change_id, change.memory_version,
                      change.impact_level, change.change_kind,
                      change.subject_type, change.subject_id
               FROM memory_revalidation_changes change
               JOIN narrative_memories memory
                 ON memory.id=change.subject_id
               JOIN narrative_memory_subjects memory_subject
                 ON memory_subject.memory_id=memory.id
               JOIN dependencies dependency
                 ON dependency.dependency_type=memory_subject.subject_type
                AND dependency.dependency_id=memory_subject.subject_id
               JOIN translation_versions tv
                 ON tv.id=dependency.translation_id
               JOIN blocks b ON b.id=tv.block_id
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               WHERE change.old_fingerprint=''
                 AND tv.active=1 AND tv.pipeline='parallel_v4'
                 AND tv.status IN ('completed','completed_with_warnings')
                 AND b.status IN ('completed','completed_with_warnings')
                 AND tv.memory_version IS NOT NULL
                 AND change.memory_version>tv.memory_version
                 AND b.global_index>=memory.reveal_global_index
               ORDER BY tv.id, change.change_id"""
        ).fetchall()
        for row in subject_rows:
            if _authentic_source(
                str(row["source_text"]), str(row["source_hash"])
            ):
                self._add_memory_candidate(
                    candidates, row, "subject_visibility"
                )

        reveal_rows = connection.execute(
            """SELECT DISTINCT
                      tv.id translation_id, tv.block_id,
                      tv.knowledge_version, tv.memory_version from_memory_version,
                      b.source_hash, b.source_text,
                      change.change_id, change.memory_version,
                      change.impact_level, change.change_kind,
                      change.subject_type, change.subject_id
               FROM memory_revalidation_changes change
               JOIN narrative_memories memory
                 ON memory.id=change.subject_id
               JOIN translation_versions tv
                 ON tv.memory_version IS NOT NULL
                AND change.memory_version>tv.memory_version
               JOIN dependencies snapshot_dependency
                 ON snapshot_dependency.translation_id=tv.id
                AND snapshot_dependency.dependency_type='narrative_snapshot'
               JOIN blocks b ON b.id=tv.block_id
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               WHERE change.old_fingerprint=''
                 AND change.impact_level>=2
                 AND tv.active=1 AND tv.pipeline='parallel_v4'
                 AND tv.status IN ('completed','completed_with_warnings')
                 AND b.status IN ('completed','completed_with_warnings')
                 AND b.global_index>=memory.reveal_global_index
               ORDER BY tv.id, change.change_id"""
        ).fetchall()
        for row in reveal_rows:
            if _authentic_source(
                str(row["source_text"]), str(row["source_hash"])
            ):
                self._add_memory_candidate(
                    candidates, row, "high_impact_reveal"
                )

        counters = {"created": 0, "merged": 0, "unchanged": 0}
        planned_blocks: list[str] = []
        for candidate in candidates.values():
            outcome = self._upsert_memory_candidate(connection, candidate)
            if outcome is not None:
                counters[outcome] += 1
                planned_blocks.append(candidate.block_id)
        return {
            "requested": len(change_ids),
            "effective": len(effective_rows),
            "planned": sum(counters.values()),
            **counters,
            "retired": int(retired),
            "planned_block_ids": sorted(set(planned_blocks)),
        }

    @staticmethod
    def _add_memory_candidate(
        candidates: dict[int, _MemoryCandidate],
        row: sqlite3.Row,
        via: str,
    ) -> None:
        translation_id = int(row["translation_id"])
        candidate = candidates.setdefault(
            translation_id,
            _MemoryCandidate(
                translation_id=translation_id,
                block_id=str(row["block_id"]),
                knowledge_version=int(row["knowledge_version"]),
                from_memory_version=int(row["from_memory_version"]),
                source_hash=str(row["source_hash"]),
            ),
        )
        change_id = int(row["change_id"])
        detail = candidate.changes.setdefault(
            change_id,
            {
                "memory_version": int(row["memory_version"]),
                "impact_level": int(row["impact_level"]),
                "change_kind": str(row["change_kind"]),
                "subjects": set(),
                "via": set(),
            },
        )
        detail["subjects"].add(
            (str(row["subject_type"]), str(row["subject_id"]))
        )
        detail["via"].add(via)

    @staticmethod
    def _memory_change_rows(
        connection: sqlite3.Connection, change_ids: set[int]
    ) -> dict[int, sqlite3.Row]:
        rows: dict[int, sqlite3.Row] = {}
        ordered = sorted(change_ids)
        for start in range(0, len(ordered), 500):
            chunk = ordered[start : start + 500]
            placeholders = ",".join("?" for _ in chunk)
            for row in connection.execute(
                f"""SELECT id, memory_version, impact_level, change_kind,
                            subject_type, subject_id, old_fingerprint,
                            new_fingerprint, payload_json
                     FROM memory_changes WHERE id IN ({placeholders})""",
                chunk,
            ).fetchall():
                rows[int(row["id"])] = row
        return rows

    @staticmethod
    def _memory_task_result(
        candidate: _MemoryCandidate,
        change_ids: set[int],
        change_rows: Mapping[int, sqlite3.Row],
        persisted_details: Mapping[int, Mapping[str, Any]] | None = None,
    ) -> str:
        persisted_details = persisted_details or {}
        subjects: set[tuple[str, str]] = set()
        reasons: list[dict[str, Any]] = []
        for change_id in sorted(change_ids):
            row = change_rows[change_id]
            detail = candidate.changes.get(change_id)
            persisted = persisted_details.get(change_id)
            if persisted is not None:
                change_subjects = set(persisted["subjects"])
                vias = list(persisted["via"])
            elif detail is not None:
                change_subjects = set(detail["subjects"])
                vias = sorted(detail["via"])
            else:
                change_subjects = {
                    (str(row["subject_type"]), str(row["subject_id"]))
                }
                vias = ["persisted_memory_change"]
            subjects.update(change_subjects)
            reasons.append(
                {
                    "change_id": change_id,
                    "change_kind": str(row["change_kind"]),
                    "via": vias,
                    "subjects": [
                        {
                            "subject_type": subject_type,
                            "subject_id": subject_id,
                        }
                        for subject_type, subject_id in sorted(
                            change_subjects
                        )
                    ],
                }
            )
        return _canonical_json(
            {
                "change_domain": "memory",
                "change_ids": sorted(change_ids),
                "subjects": [
                    {
                        "subject_type": subject_type,
                        "subject_id": subject_id,
                    }
                    for subject_type, subject_id in sorted(subjects)
                ],
                "omitted_subjects": 0,
                "reasons": reasons,
                "omitted_reasons": 0,
                "source_hash": candidate.source_hash,
                # Narrative changes alter the frozen snapshot/version.  A local
                # string replacement cannot safely mint the replacement
                # snapshot, so the bounded automatic action is full retranslation.
                "recommended_action": "retranslate",
            }
        )

    def _upsert_memory_candidate(
        self,
        connection: sqlite3.Connection,
        candidate: _MemoryCandidate,
    ) -> str | None:
        tasks = connection.execute(
            """SELECT * FROM revalidation_tasks
               WHERE translation_id=? AND change_domain='memory'
                 AND status IN ('pending','validating')
               ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                        created_at, id""",
            (candidate.translation_id,),
        ).fetchall()
        pending = [row for row in tasks if row["status"] == "pending"]
        validating_ids: set[int] = set()
        existing_ids: set[int] = set()
        existing_details: dict[int, dict[str, Any]] = {}
        for task in tasks:
            parsed = _parse_task_result(task["result_json"])
            if (
                int(task["from_knowledge_version"])
                != candidate.knowledge_version
                or int(task["to_knowledge_version"])
                != candidate.knowledge_version
                or int(task["from_memory_version"])
                != candidate.from_memory_version
                or str(task["block_id"]) != candidate.block_id
            ):
                raise ValueError(
                    "pending memory revalidation task does not match translation"
                )
            if task["status"] == "validating":
                validating_ids.update(parsed["change_ids"])
            else:
                existing_ids.update(parsed["change_ids"])
                existing_details.update(parsed["details"])

        candidate_ids = set(candidate.changes) - validating_ids
        if not candidate_ids:
            return None
        current = pending[0] if pending else None
        for duplicate in pending[1:]:
            connection.execute(
                """UPDATE revalidation_tasks
                   SET status='resolved_noop', result_json=?, resolved_at=?
                   WHERE id=?""",
                (
                    _canonical_json(
                        {"reason": "duplicate_pending_memory_task"}
                    ),
                    utc_now(),
                    duplicate["id"],
                ),
            )
        merged_ids = existing_ids | candidate_ids
        if len(merged_ids) > MAX_CHANGE_IDS:
            raise PlanningBudgetError(
                "merged memory revalidation change_ids exceed budget"
            )
        rows = self._memory_change_rows(connection, merged_ids)
        if set(rows) != merged_ids:
            raise ValueError(
                "pending memory revalidation task references unknown changes"
            )
        if any(
            int(row["memory_version"]) <= candidate.from_memory_version
            for row in rows.values()
        ):
            raise ValueError(
                "memory revalidation changes must be newer than translation"
            )
        to_memory_version = max(
            int(row["memory_version"]) for row in rows.values()
        )
        if current is not None and merged_ids == existing_ids:
            return "unchanged"
        impact = max(int(row["impact_level"]) for row in rows.values())
        change_hash = _memory_change_set_hash(
            sorted(merged_ids), to_memory_version
        )
        result_json = self._memory_task_result(
            candidate,
            merged_ids,
            rows,
            existing_details,
        )
        if len(result_json.encode("utf-8")) > MAX_RESULT_BYTES:
            raise PlanningBudgetError(
                "memory revalidation result exceeds byte budget"
            )
        conflict = connection.execute(
            """SELECT id FROM revalidation_tasks
               WHERE translation_id=? AND change_set_hash=?
                 AND (? IS NULL OR id<>?)""",
            (
                candidate.translation_id,
                change_hash,
                current["id"] if current is not None else None,
                current["id"] if current is not None else None,
            ),
        ).fetchone()
        if conflict is not None:
            return "unchanged" if current is not None else None
        if current is None:
            connection.execute(
                """INSERT INTO revalidation_tasks(
                       id, translation_id, block_id,
                       from_knowledge_version, to_knowledge_version,
                       change_set_hash, impact_level, status, action,
                       attempts, result_json, created_at, change_domain,
                       from_memory_version, to_memory_version)
                   VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', '', 0, ?, ?,
                          'memory', ?, ?)""",
                (
                    _task_id(candidate.translation_id, change_hash),
                    candidate.translation_id,
                    candidate.block_id,
                    candidate.knowledge_version,
                    candidate.knowledge_version,
                    change_hash,
                    impact,
                    result_json,
                    utc_now(),
                    candidate.from_memory_version,
                    to_memory_version,
                ),
            )
            return "created"
        connection.execute(
            """UPDATE revalidation_tasks
               SET change_set_hash=?, impact_level=?, result_json=?,
                   to_memory_version=?
               WHERE id=? AND status='pending'""",
            (
                change_hash,
                impact,
                result_json,
                to_memory_version,
                current["id"],
            ),
        )
        return "merged"

    def _plan_in_transaction(
        self, connection: sqlite3.Connection, change_ids: list[int]
    ) -> dict[str, Any]:
        connection.execute(
            "CREATE TEMP TABLE revalidation_input(id INTEGER PRIMARY KEY)"
        )
        connection.executemany(
            "INSERT INTO revalidation_input(id) VALUES(?)",
            [(change_id,) for change_id in change_ids],
        )
        rows = connection.execute(
            """SELECT kc.* FROM knowledge_changes kc
               JOIN revalidation_input input ON input.id=kc.id
               ORDER BY kc.id"""
        ).fetchall()
        found = {int(row["id"]) for row in rows}
        missing = sorted(set(change_ids) - found)
        if missing:
            raise KeyError(f"unknown knowledge change: {missing[0]}")

        effective_rows = [
            row
            for row in rows
            if int(row["impact_level"]) > 0
            and str(row["old_fingerprint"] or "")
            != str(row["new_fingerprint"] or "")
        ]
        retired_payload = _canonical_json({"reason": "translation_inactive"})
        retired = connection.execute(
            """UPDATE revalidation_tasks AS task
               SET status='resolved_noop', result_json=?, resolved_at=?
               WHERE task.status='pending'
                 AND NOT EXISTS(
                     SELECT 1 FROM translation_versions tv
                     WHERE tv.id=task.translation_id AND tv.active=1
                 )""",
            (retired_payload, utc_now()),
        ).rowcount
        if not effective_rows:
            result = self._empty_result(len(change_ids), 0)
            result["retired"] = int(retired)
            return result

        connection.execute(
            """CREATE TEMP TABLE revalidation_subjects(
                   change_id INTEGER NOT NULL,
                   knowledge_version INTEGER NOT NULL,
                   impact_level INTEGER NOT NULL,
                   change_kind TEXT NOT NULL,
                   subject_type TEXT NOT NULL,
                   subject_id TEXT NOT NULL,
                   new_fingerprint TEXT NOT NULL,
                   PRIMARY KEY(change_id, subject_type, subject_id)
               )"""
        )
        subject_rows: list[tuple[Any, ...]] = []
        for row in effective_rows:
            subjects = {
                (str(row["subject_type"]).strip(), str(row["subject_id"]).strip())
            }
            subjects.update(self._safe_payload_subjects(connection, row))
            for subject_type, subject_id in sorted(subjects):
                if (
                    not subject_type
                    or not subject_id
                    or len(subject_type) > 64
                    or len(subject_id) > _MAX_SUBJECT_ID_CHARS
                ):
                    continue
                subject_rows.append(
                    (
                        int(row["id"]),
                        int(row["knowledge_version"]),
                        int(row["impact_level"]),
                        str(row["change_kind"]),
                        subject_type,
                        subject_id,
                        str(row["new_fingerprint"] or ""),
                    )
                )
        connection.executemany(
            """INSERT OR IGNORE INTO revalidation_subjects(
                   change_id, knowledge_version, impact_level, change_kind,
                   subject_type, subject_id, new_fingerprint)
               VALUES(?, ?, ?, ?, ?, ?, ?)""",
            subject_rows,
        )

        candidates: dict[int, _Candidate] = {}
        dependency_rows = connection.execute(
            """SELECT DISTINCT
                      tv.id translation_id, tv.block_id,
                      tv.knowledge_version from_version,
                      b.source_hash, b.source_text,
                      d.matched_form, d.source_spans_json,
                      subject.change_id, subject.knowledge_version,
                      subject.impact_level, subject.change_kind,
                      subject.subject_type, subject.subject_id
               FROM revalidation_subjects subject
               JOIN dependencies d
                 ON d.dependency_type=subject.subject_type
                AND d.dependency_id=subject.subject_id
               JOIN translation_versions tv ON tv.id=d.translation_id
               JOIN knowledge_versions translated_version
                 ON translated_version.id=tv.knowledge_version
               JOIN blocks b ON b.id=tv.block_id
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               WHERE tv.active=1 AND tv.pipeline='parallel_v4'
                 AND tv.status IN ('completed','completed_with_warnings')
                 AND b.status IN ('completed','completed_with_warnings')
                 AND d.knowledge_version=tv.knowledge_version
                 AND subject.knowledge_version>tv.knowledge_version
                 AND d.dependency_fingerprint<>subject.new_fingerprint
               ORDER BY tv.id, subject.change_id, subject.subject_type, subject.subject_id"""
        ).fetchall()
        for row in dependency_rows:
            if not self._dependency_snapshot_is_current(row):
                continue
            self._add_candidate(candidates, row, "dependency")

        occurrence_rows = connection.execute(
            """SELECT DISTINCT
                      tv.id translation_id, tv.block_id,
                      tv.knowledge_version from_version,
                      b.source_hash, b.source_text,
                      occurrence.source_hash occurrence_source_hash,
                      occurrence.start_offset, occurrence.end_offset,
                      occurrence.source_form,
                      subject.change_id, subject.knowledge_version,
                      subject.impact_level, subject.change_kind,
                      subject.subject_type, subject.subject_id
               FROM revalidation_subjects subject
               JOIN form_occurrences occurrence
                 ON occurrence.lexeme_id=subject.subject_id
                AND subject.subject_type='lexeme'
               JOIN blocks b ON b.id=occurrence.block_id
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               JOIN translation_versions tv ON tv.block_id=b.id
               JOIN knowledge_versions translated_version
                 ON translated_version.id=tv.knowledge_version
               WHERE occurrence.source_hash=b.source_hash
                 AND occurrence.start_offset>=0
                 AND occurrence.end_offset<=length(b.source_text)
                 AND substr(
                       b.source_text,
                       occurrence.start_offset+1,
                       occurrence.end_offset-occurrence.start_offset
                     )=occurrence.source_form
                 AND tv.active=1 AND tv.pipeline='parallel_v4'
                 AND tv.status IN ('completed','completed_with_warnings')
                 AND b.status IN ('completed','completed_with_warnings')
                 AND subject.knowledge_version>tv.knowledge_version
                 AND NOT EXISTS(
                     SELECT 1 FROM dependencies existing
                     WHERE existing.translation_id=tv.id
                       AND existing.dependency_type='lexeme'
                       AND existing.dependency_id=subject.subject_id
                 )
               UNION
               SELECT DISTINCT
                      tv.id translation_id, tv.block_id,
                      tv.knowledge_version from_version,
                      b.source_hash, b.source_text,
                      occurrence.source_hash occurrence_source_hash,
                      occurrence.start_offset, occurrence.end_offset,
                      occurrence.source_form,
                      subject.change_id, subject.knowledge_version,
                      subject.impact_level, subject.change_kind,
                      subject.subject_type, subject.subject_id
               FROM revalidation_subjects subject
               JOIN concept_lexemes link
                 ON link.concept_id=subject.subject_id
                AND link.created_version<=subject.knowledge_version
                AND (link.retired_version IS NULL
                     OR link.retired_version>subject.knowledge_version)
                AND subject.subject_type='concept'
               JOIN form_occurrences occurrence ON occurrence.lexeme_id=link.lexeme_id
               JOIN blocks b ON b.id=occurrence.block_id
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               JOIN translation_versions tv ON tv.block_id=b.id
               JOIN knowledge_versions translated_version
                 ON translated_version.id=tv.knowledge_version
               WHERE occurrence.source_hash=b.source_hash
                 AND occurrence.start_offset>=0
                 AND occurrence.end_offset<=length(b.source_text)
                 AND substr(
                       b.source_text,
                       occurrence.start_offset+1,
                       occurrence.end_offset-occurrence.start_offset
                     )=occurrence.source_form
                 AND tv.active=1 AND tv.pipeline='parallel_v4'
                 AND tv.status IN ('completed','completed_with_warnings')
                 AND b.status IN ('completed','completed_with_warnings')
                 AND subject.knowledge_version>tv.knowledge_version
                 AND NOT EXISTS(
                     SELECT 1 FROM dependencies existing
                     WHERE existing.translation_id=tv.id
                       AND existing.dependency_type='concept'
                       AND existing.dependency_id=subject.subject_id
                 )
               ORDER BY translation_id, change_id, subject_type, subject_id"""
        ).fetchall()
        for row in occurrence_rows:
            if not self._occurrence_snapshot_is_current(row):
                continue
            self._add_candidate(candidates, row, "occurrence")

        counters = {"created": 0, "merged": 0, "unchanged": 0}
        for candidate in candidates.values():
            outcome = self._upsert_candidate(connection, candidate)
            if outcome is not None:
                counters[outcome] += 1
        return {
            "requested": len(change_ids),
            "effective": len(effective_rows),
            "planned": sum(counters.values()),
            **counters,
            "retired": int(retired),
        }

    @staticmethod
    def _add_candidate(
        candidates: dict[int, _Candidate], row: sqlite3.Row, via: str
    ) -> None:
        translation_id = int(row["translation_id"])
        candidate = candidates.setdefault(
            translation_id,
            _Candidate(
                translation_id=translation_id,
                block_id=str(row["block_id"]),
                from_version=int(row["from_version"]),
                source_hash=str(row["source_hash"]),
            ),
        )
        change_id = int(row["change_id"])
        detail = candidate.changes.setdefault(
            change_id,
            {
                "knowledge_version": int(row["knowledge_version"]),
                "impact_level": int(row["impact_level"]),
                "change_kind": str(row["change_kind"]),
                "subjects": set(),
                "via": set(),
            },
        )
        detail["subjects"].add(
            (str(row["subject_type"]), str(row["subject_id"]))
        )
        detail["via"].add(via)

    @staticmethod
    def _change_rows(
        connection: sqlite3.Connection, change_ids: set[int]
    ) -> dict[int, sqlite3.Row]:
        rows: dict[int, sqlite3.Row] = {}
        ordered = sorted(change_ids)
        for start in range(0, len(ordered), 500):
            chunk = ordered[start : start + 500]
            placeholders = ",".join("?" for _ in chunk)
            for row in connection.execute(
                f"""SELECT id, knowledge_version, impact_level, change_kind,
                            subject_type, subject_id
                     FROM knowledge_changes WHERE id IN ({placeholders})""",
                chunk,
            ).fetchall():
                rows[int(row["id"])] = row
        return rows

    def _upsert_candidate(
        self, connection: sqlite3.Connection, candidate: _Candidate
    ) -> str | None:
        tasks = connection.execute(
            """SELECT * FROM revalidation_tasks
               WHERE translation_id=? AND status IN ('pending','validating')
               ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at, id""",
            (candidate.translation_id,),
        ).fetchall()
        pending = [row for row in tasks if row["status"] == "pending"]
        task_results: dict[str, dict[str, Any]] = {}
        for row in tasks:
            row_id = str(row["id"])
            parsed_result = _parse_task_result(row["result_json"])
            parsed_ids = set(parsed_result["change_ids"])
            task_results[row_id] = parsed_result
            if (
                int(row["from_knowledge_version"]) != candidate.from_version
                or str(row["block_id"]) != candidate.block_id
            ):
                raise ValueError("pending revalidation task does not match translation")
            persisted_changes = self._change_rows(connection, parsed_ids)
            if set(persisted_changes) != parsed_ids:
                raise ValueError("pending revalidation task references unknown changes")
            if any(
                parsed_result["details"][change_id]["change_kind"]
                != str(persisted_changes[change_id]["change_kind"])
                for change_id in parsed_ids
            ):
                raise PlanningProtocolError(
                    "pending revalidation provenance change kind is inconsistent"
                )
            if any(
                int(change["knowledge_version"]) <= candidate.from_version
                for change in persisted_changes.values()
            ):
                raise ValueError("revalidation changes must be newer than translation")
            expected_to = max(
                int(change["knowledge_version"])
                for change in persisted_changes.values()
            )
            if (
                int(row["to_knowledge_version"]) != expected_to
                or expected_to <= candidate.from_version
                or str(row["change_set_hash"])
                != _change_set_hash(sorted(parsed_ids), expected_to)
                or int(row["impact_level"])
                != max(
                    int(change["impact_level"])
                    for change in persisted_changes.values()
                )
            ):
                raise ValueError("pending revalidation task metadata is inconsistent")
            payload = json.loads(str(row["result_json"]))
            if payload.get("source_hash") != candidate.source_hash:
                raise ValueError("pending revalidation source hash is inconsistent")
        validating_ids: set[int] = set()
        for row in tasks:
            if row["status"] == "validating":
                validating_ids.update(task_results[str(row["id"])]["change_ids"])
        for detail in candidate.changes.values():
            if int(detail["knowledge_version"]) <= candidate.from_version:
                raise ValueError("revalidation changes must be newer than translation")
        candidate_ids = set(candidate.changes) - validating_ids
        if not candidate_ids:
            return None

        existing_ids: set[int] = set()
        existing_details: dict[int, dict[str, Any]] = {}
        current: sqlite3.Row | None = pending[0] if pending else None
        if current is not None:
            for task in pending:
                result = task_results[str(task["id"])]
                existing_ids.update(result["change_ids"])
                for change_id, detail in result["details"].items():
                    prior = existing_details.get(change_id)
                    if prior is not None and prior != detail:
                        raise PlanningProtocolError(
                            "pending revalidation provenance conflicts across tasks"
                        )
                    existing_details[change_id] = detail
            for duplicate in pending[1:]:
                connection.execute(
                    """UPDATE revalidation_tasks
                       SET status='resolved_noop', result_json=?, resolved_at=?
                       WHERE id=?""",
                    (
                        _canonical_json({"reason": "duplicate_pending_task"}),
                        utc_now(),
                        duplicate["id"],
                    ),
                )
        merged_ids = existing_ids | candidate_ids
        if len(merged_ids) > MAX_CHANGE_IDS:
            raise PlanningBudgetError("merged revalidation change_ids exceed budget")

        change_rows = self._change_rows(connection, merged_ids)
        if set(change_rows) != merged_ids:
            raise ValueError("pending revalidation task references unknown changes")
        if any(
            int(row["knowledge_version"]) <= candidate.from_version
            for row in change_rows.values()
        ):
            raise ValueError("revalidation changes must be newer than translation")
        to_version = max(int(row["knowledge_version"]) for row in change_rows.values())
        if to_version <= candidate.from_version:
            raise ValueError("revalidation target version must move forward")
        if current is not None and existing_ids:
            existing_rows = {change_id: change_rows[change_id] for change_id in existing_ids}
            stored_to = int(current["to_knowledge_version"])
            expected_to = max(
                int(row["knowledge_version"]) for row in existing_rows.values()
            )
            if stored_to != expected_to:
                raise ValueError("pending revalidation target version is inconsistent")
            if to_version < stored_to:
                raise ValueError("pending revalidation target version cannot decrease")
        if current is not None and merged_ids == existing_ids:
            return "unchanged"
        impact = max(int(row["impact_level"]) for row in change_rows.values())
        change_hash = _change_set_hash(sorted(merged_ids), to_version)
        conflict = connection.execute(
            """SELECT id FROM revalidation_tasks
               WHERE translation_id=? AND change_set_hash=?
                 AND (? IS NULL OR id<>?)""",
            (
                candidate.translation_id,
                change_hash,
                current["id"] if current is not None else None,
                current["id"] if current is not None else None,
            ),
        ).fetchone()
        if conflict is not None:
            return "unchanged" if current is not None else None

        result_json = self._task_result(
            candidate, merged_ids, change_rows, existing_details
        )
        if len(result_json.encode("utf-8")) > MAX_RESULT_BYTES:
            raise PlanningBudgetError("revalidation result exceeds byte budget")
        if current is None:
            connection.execute(
                """INSERT INTO revalidation_tasks(
                       id, translation_id, block_id, from_knowledge_version,
                       to_knowledge_version, change_set_hash, impact_level,
                       status, action, attempts, result_json, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', '', 0, ?, ?)""",
                (
                    _task_id(candidate.translation_id, change_hash),
                    candidate.translation_id,
                    candidate.block_id,
                    candidate.from_version,
                    to_version,
                    change_hash,
                    impact,
                    result_json,
                    utc_now(),
                ),
            )
            return "created"
        connection.execute(
            """UPDATE revalidation_tasks
               SET to_knowledge_version=?, change_set_hash=?, impact_level=?,
                   result_json=?
               WHERE id=? AND status='pending'""",
            (to_version, change_hash, impact, result_json, current["id"]),
        )
        return "merged"

    @staticmethod
    def _task_result(
        candidate: _Candidate,
        change_ids: set[int],
        change_rows: dict[int, sqlite3.Row],
        persisted_details: dict[int, dict[str, Any]] | None = None,
    ) -> str:
        persisted_details = persisted_details or {}
        subjects: set[tuple[str, str]] = set()
        reasons: list[dict[str, Any]] = []
        for change_id in sorted(change_ids):
            persisted = persisted_details.get(change_id)
            detail = candidate.changes.get(change_id)
            if persisted is not None:
                change_subjects = set(persisted["subjects"])
                vias = list(persisted["via"])
                change_kind = str(persisted["change_kind"])
            elif detail is not None:
                change_subjects = set(detail["subjects"])
                vias = sorted(detail["via"])
                change_kind = str(detail["change_kind"])
            else:
                raise PlanningProtocolError(
                    f"missing revalidation provenance for change {change_id}"
                )
            subjects.update(change_subjects)
            reasons.append(
                {
                    "change_id": change_id,
                    "change_kind": change_kind,
                    "via": vias,
                    "subjects": [
                        {"subject_type": subject_type, "subject_id": subject_id}
                        for subject_type, subject_id in sorted(change_subjects)
                    ],
                }
            )
        ordered_subjects = sorted(subjects)
        payload = {
            "change_ids": sorted(change_ids),
            "subjects": [
                {"subject_type": subject_type, "subject_id": subject_id}
                for subject_type, subject_id in ordered_subjects[:_MAX_RESULT_SUBJECTS]
            ],
            "omitted_subjects": max(0, len(ordered_subjects) - _MAX_RESULT_SUBJECTS),
            "reasons": reasons,
            "omitted_reasons": 0,
            "source_hash": candidate.source_hash,
        }
        return _canonical_json(payload)


class RevalidationProtocolError(ValueError):
    """A validator answer cannot be mapped to the frozen bounded payload."""


class RevalidationRunner:
    """Claim, validate, optionally repair, and atomically resolve stale translations."""

    def __init__(
        self,
        database: V4Database,
        validator_factory: Optional[Callable[[], Any]] = None,
        *,
        validator_factories: Optional[Sequence[Callable[[], Any]]] = None,
        repairer: Optional[V4Repairer] = None,
        translate_block_factory: Optional[Callable[[], Any]] = None,
        max_attempts: int = 2,
        lease_seconds: int = 300,
        owner: Optional[str] = None,
    ):
        if not isinstance(database, V4Database):
            raise TypeError("database must be a V4Database")
        if validator_factories is not None and validator_factory is not None:
            raise ValueError("provide validator_factory or validator_factories, not both")
        factories = tuple(validator_factories or ())
        if validator_factory is not None:
            factories = (validator_factory,)
        if any(not callable(factory) for factory in factories):
            raise TypeError("validator factories must be callable")
        if translate_block_factory is not None and not callable(translate_block_factory):
            raise TypeError("translate_block_factory must be callable")
        if type(max_attempts) is not int or max_attempts < 1:
            raise ValueError("max_attempts must be a positive integer")
        self.database = database
        self.validator_factories = factories
        self.repairer = repairer
        self.translate_block_factory = translate_block_factory
        self.max_attempts = max_attempts
        self.lease_seconds = lease_seconds
        self.owner = owner or f"revalidation-{uuid.uuid4().hex}"

    @staticmethod
    def _model_name(client: Any) -> str:
        try:
            return str(client.get_model("revalidate"))[:256]
        except Exception:
            return type(client).__name__[:256]

    @staticmethod
    def _validate_coverage(
        response: RevalidationResponse, payload: Mapping[str, Any]
    ) -> None:
        if response.task_alias != str(payload.get("task_alias")):
            raise RevalidationProtocolError("validator returned an unknown task alias")
        cases = payload.get("cases")
        if not isinstance(cases, list):
            raise RevalidationProtocolError("frozen validator cases are invalid")
        expected_cases = {
            str(case.get("case_alias"))
            for case in cases
            if isinstance(case, dict)
        }
        if set(response.case_aliases) != expected_cases:
            raise RevalidationProtocolError(
                "validator case aliases do not cover the frozen task"
            )
        legal_subjects: set[str] = set()
        legal_spans: set[tuple[int, int]] = set()
        source_text = str((payload.get("block") or {}).get("source_text") or "")
        for case in cases:
            if not isinstance(case, dict):
                continue
            for subject in case.get("subjects") or ():
                if isinstance(subject, dict):
                    legal_subjects.add(str(subject.get("subject_alias") or ""))
            for span in case.get("spans") or ():
                if (
                    isinstance(span, dict)
                    and type(span.get("start")) is int
                    and type(span.get("end")) is int
                ):
                    legal_spans.add((int(span["start"]), int(span["end"])))
        if not set(response.subject_aliases).issubset(legal_subjects):
            raise RevalidationProtocolError("validator returned an unknown subject alias")
        response_spans = {(span.start, span.end) for span in response.spans}
        if not response_spans.issubset(legal_spans):
            raise RevalidationProtocolError("validator returned a span outside coverage")
        if any(not 0 <= start < end <= len(source_text) for start, end in response_spans):
            raise RevalidationProtocolError("validator returned an invalid source span")

    def _validate_side(
        self,
        client: Any,
        claim: RevalidationClaim,
    ) -> tuple[Optional[RevalidationResponse], list[dict[str, Any]]]:
        payload_text = claim.payload_bytes.decode("utf-8")
        base_messages = [
            {"role": "system", "content": REVALIDATION_SYSTEM},
            {"role": "user", "content": payload_text},
        ]
        audits: list[dict[str, Any]] = []
        last_error = ""
        for attempt in range(1, self.max_attempts + 1):
            messages = list(base_messages)
            if last_error:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "The previous JSON failed strict validation. Return the complete "
                            f"corrected answer. Error: {last_error[:600]}"
                        ),
                    }
                )
            raw = ""
            started = time.perf_counter()
            try:
                raw = str(
                    client.chat(
                        messages=messages,
                        purpose="revalidate",
                        temperature=0.0,
                        max_tokens=1200,
                        json_mode=True,
                        stream=False,
                    )
                )
                response = RevalidationResponse.model_validate_json(raw)
                payload = json.loads(payload_text)
                self._validate_coverage(response, payload)
                audits.append(
                    {
                        "purpose": "revalidate",
                        "model": self._model_name(client),
                        "request": {
                            "messages": messages,
                            "json_mode": True,
                            "payload_sha256": claim.payload_hash,
                        },
                        "raw_response": raw[:_MAX_AUDIT_RAW_CHARS],
                        "parsed": response.model_dump(mode="json"),
                        "accepted": True,
                        "attempts": attempt,
                        "elapsed_ms": int((time.perf_counter() - started) * 1000),
                        "error": None,
                    }
                )
                return response, audits
            except (ValidationError, RevalidationProtocolError, ValueError, Exception) as exc:
                last_error = str(exc)[:1024]
                audits.append(
                    {
                        "purpose": "revalidate",
                        "model": self._model_name(client),
                        "request": {
                            "messages": messages,
                            "json_mode": True,
                            "payload_sha256": claim.payload_hash,
                        },
                        "raw_response": raw[:_MAX_AUDIT_RAW_CHARS],
                        "parsed": None,
                        "accepted": False,
                        "attempts": attempt,
                        "elapsed_ms": int((time.perf_counter() - started) * 1000),
                        "error": last_error,
                    }
                )
        return None, audits

    def _factories_for_impact(self, impact: int) -> tuple[Callable[[], Any], ...]:
        required = 2 if impact == 2 else 1
        if not self.validator_factories:
            return ()
        if required == 1:
            return self.validator_factories[:1]
        if len(self.validator_factories) >= 2:
            return self.validator_factories[:2]
        return (self.validator_factories[0], self.validator_factories[0])

    @staticmethod
    def _narrative_context_requires_retranslation(
        task_snapshot: Mapping[str, Any],
    ) -> bool:
        memory_version = task_snapshot.get("translation_memory_version")
        return bool(
            str(task_snapshot.get("translation_snapshot_id") or "")
            or (
                type(memory_version) is int
                and int(memory_version) > 1
            )
        )

    @staticmethod
    def _retranslation_category(error: BaseException | str, status: str = "") -> str:
        message = f"{type(error).__name__} {error}".casefold()
        if any(
            marker in message
            for marker in (
                "context window",
                "context limit",
                "context overflow",
                "max_context",
                "上下文",
            )
        ):
            return "context"
        if any(
            marker in message
            for marker in ("budget", "token limit", "token cap", "quota", "预算")
        ):
            return "budget"
        if any(
            marker in message
            for marker in ("protocol", "json", "schema", "parse", "协议")
        ):
            return "protocol"
        if any(
            marker in message
            for marker in (
                "structure",
                "paragraph",
                "wrapper",
                "integrity",
                "empty",
                "结构",
                "段落",
                "空译文",
            )
        ):
            return "structure"
        if isinstance(error, (TimeoutError, ConnectionError, OSError)) or any(
            marker in message
            for marker in ("timeout", "network", "service", "unavailable", "rate limit")
        ):
            return "external"
        if isinstance(error, BaseException):
            if isinstance(error, (RevalidationProtocolError, ValidationError, ValueError, TypeError)):
                return "protocol"
            return "external"
        if status == V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value:
            return "context"
        if status not in {
            V4BlockStatus.COMPLETED.value,
            V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
            V4BlockStatus.FAILED_RETRYABLE.value,
        }:
            return "protocol"
        return "external" if status == V4BlockStatus.FAILED_RETRYABLE.value else "structure"

    @staticmethod
    def _retranslation_audit(
        claim: RevalidationClaim,
        block_id: str,
        attempt: int,
        error: BaseException | str,
    ) -> dict[str, Any]:
        return {
            "purpose": "retranslate",
            "model": "translate_block_factory",
            "request": {
                "block_id": block_id,
                "payload_sha256": claim.payload_hash,
            },
            "raw_response": "",
            "parsed": None,
            "accepted": False,
            "attempts": attempt,
            "elapsed_ms": 0,
            "error": str(error)[:1024],
        }

    def _retranslate_or_warn(
        self,
        claim: RevalidationClaim,
        *,
        reason: str,
        result: Mapping[str, Any],
        audits: list[dict[str, Any]],
        run_id: str,
        summary: dict[str, Any],
    ) -> None:
        block = self.database.get_block_by_identifier(
            str(claim.task_snapshot["block_id"])
        )
        final_category = "protocol"
        final_error = "translate_block_factory is unavailable"
        attempts = 0
        for attempt in range(1, self.max_attempts + 1):
            attempts = attempt
            outcome: Optional[TranslationOutcome] = None
            try:
                if self.translate_block_factory is None:
                    raise RevalidationProtocolError(final_error)
                translator = self.translate_block_factory()
                if callable(translator):
                    candidate = translator(block)
                elif callable(getattr(translator, "translate_block", None)):
                    candidate = translator.translate_block(block)
                else:
                    raise RevalidationProtocolError(
                        "translate_block_factory returned a non-callable translator"
                    )
                if not isinstance(candidate, TranslationOutcome):
                    raise RevalidationProtocolError(
                        "translator did not return a TranslationOutcome"
                    )
                outcome = candidate
                if outcome.block.id != block.id:
                    raise RevalidationProtocolError(
                        "translator returned an outcome for another block"
                    )
                if outcome.status in {
                    V4BlockStatus.COMPLETED.value,
                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                } and outcome.final_translation.strip():
                    self.database.commit_revalidation_resolution(
                        claim,
                        status="resolved_retranslate",
                        action="retranslate",
                        result={**dict(result), "reason": reason, "attempts": attempt},
                        outcome=outcome,
                        audits=audits,
                        run_id=run_id,
                    )
                    summary["retranslate"] += 1
                    return
                if outcome.status in {
                    V4BlockStatus.COMPLETED.value,
                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                }:
                    final_error = str(outcome.error or "translation structure is empty")
                else:
                    final_error = str(outcome.error or outcome.status)
                final_category = self._retranslation_category(
                    final_error, outcome.status
                )
            except Exception as exc:
                final_error = str(exc)[:1024]
                final_category = self._retranslation_category(exc)
            if outcome is not None and outcome.audit_calls:
                audits.extend(dict(audit) for audit in outcome.audit_calls)
            else:
                audits.append(
                    self._retranslation_audit(
                        claim, block.id, attempt, final_error
                    )
                )
            if final_category not in {"protocol", "structure", "external"}:
                break
        self.database.complete_with_warning(
            claim,
            error_category=final_category,
            attempts=attempts,
            error=final_error,
            audits=audits,
            run_id=run_id,
        )
        summary["warnings"] += 1

    def run(self, max_tasks: Optional[int] = None) -> dict[str, Any]:
        if max_tasks is not None and (type(max_tasks) is not int or max_tasks < 0):
            raise ValueError("max_tasks must be a non-negative integer or None")
        summary: dict[str, Any] = {
            "claimed": 0,
            "noop": 0,
            "patched": 0,
            "retranslate": 0,
            "warnings": 0,
            "protocol_failures": 0,
            "conflicts": 0,
        }
        if max_tasks == 0:
            summary["unfinished"] = self.database.unfinished_revalidation_count()
            summary["status"] = (
                "in_progress"
                if summary["unfinished"]
                else "completed_with_warnings"
                if self.database.warning_revalidation_count()
                else "completed"
            )
            return summary
        run_id = f"revalidation_{uuid.uuid4().hex}"
        self.database.start_run(
            run_id,
            "revalidation",
            {
                "max_tasks": max_tasks,
                "max_attempts": self.max_attempts,
                "lease_seconds": self.lease_seconds,
            },
        )
        processed: set[str] = set()
        try:
            while max_tasks is None or summary["claimed"] < max_tasks:
                claim = self.database.claim_revalidation_task(
                    self.owner,
                    lease_seconds=self.lease_seconds,
                    exclude_task_ids=tuple(processed),
                )
                if claim is None:
                    break
                processed.add(claim.task_id)
                summary["claimed"] += 1
                impact = int(claim.task_snapshot["impact_level"])
                audits: list[dict[str, Any]] = []
                if (
                    str(
                        claim.task_snapshot.get(
                            "change_domain", "knowledge"
                        )
                    )
                    == "memory"
                ):
                    self._retranslate_or_warn(
                        claim,
                        reason="narrative_memory_change",
                        result={
                            "recommended_action": "retranslate",
                            "from_memory_version": claim.task_snapshot.get(
                                "from_memory_version"
                            ),
                            "to_memory_version": claim.task_snapshot.get(
                                "to_memory_version"
                            ),
                        },
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                if impact >= 3:
                    self._retranslate_or_warn(
                        claim,
                        reason="impact_level_3",
                        result={},
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                frozen_payload = json.loads(claim.payload_bytes.decode("utf-8"))
                if not bool(frozen_payload.get("coverage_complete", True)):
                    summary["protocol_failures"] += 1
                    audits.append(
                        {
                            "purpose": "revalidate",
                            "model": "none",
                            "request": {"payload_sha256": claim.payload_hash},
                            "raw_response": "",
                            "parsed": None,
                            "accepted": False,
                            "attempts": 1,
                            "elapsed_ms": 0,
                            "error": str(
                                frozen_payload.get("coverage_error")
                                or "validator case coverage exceeds bound"
                            ),
                        }
                    )
                    self._retranslate_or_warn(
                        claim,
                        reason="validator_payload_incomplete",
                        result={
                            "error": "bounded validator payload cannot cover the full task"
                        },
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                factories = self._factories_for_impact(impact)
                if len(factories) < (2 if impact == 2 else 1):
                    summary["protocol_failures"] += 1
                    self._retranslate_or_warn(
                        claim,
                        reason="validator_unavailable",
                        result={"error": "independent validator factory is unavailable"},
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                responses: list[Optional[RevalidationResponse]] = []
                clients: list[Any] = []
                factory_error = ""
                for factory in factories:
                    try:
                        clients.append(factory())
                    except Exception as exc:
                        factory_error = str(exc)[:1024]
                        break
                if factory_error or (
                    impact == 2 and len(clients) == 2 and clients[0] is clients[1]
                ):
                    summary["protocol_failures"] += 1
                    self._retranslate_or_warn(
                        claim,
                        reason="validator_unavailable",
                        result={
                            "error": factory_error
                            or "impact-2 validators shared one client instance"
                        },
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                for client in clients:
                    response, side_audits = self._validate_side(client, claim)
                    responses.append(response)
                    audits.extend(side_audits)
                if any(response is None for response in responses):
                    summary["protocol_failures"] += 1
                    self._retranslate_or_warn(
                        claim,
                        reason="validator_protocol_exhausted",
                        result={"error": "validator protocol attempts exhausted"},
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                actions = [response.action for response in responses if response]
                if len(set(actions)) > 1:
                    summary["conflicts"] += 1
                if impact == 1:
                    decision = actions[0]
                elif actions == ["no_effect", "no_effect"]:
                    decision = "no_effect"
                elif actions == ["patch_required", "patch_required"]:
                    decision = "patch_required"
                else:
                    decision = "retranslate"
                result = {
                    "validator_actions": actions,
                    "decisions": [
                        response.model_dump(mode="json")
                        for response in responses
                        if response is not None
                    ],
                }
                if decision == "no_effect":
                    self.database.commit_revalidation_resolution(
                        claim,
                        status="resolved_noop",
                        action="no_effect",
                        result=result,
                        audits=audits,
                        run_id=run_id,
                    )
                    summary["noop"] += 1
                    continue
                if (
                    decision == "patch_required"
                    and self._narrative_context_requires_retranslation(
                        claim.task_snapshot
                    )
                ):
                    self._retranslate_or_warn(
                        claim,
                        reason="narrative_context_requires_full_retranslation",
                        result=result,
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                if decision != "patch_required" or self.repairer is None:
                    self._retranslate_or_warn(
                        claim,
                        reason="validation_matrix",
                        result=result,
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                payload = json.loads(claim.payload_bytes.decode("utf-8"))
                block = self.database.get_block_by_identifier(
                    str(claim.task_snapshot["block_id"])
                )
                outcome = self.repairer.repair_full_block(
                    block,
                    str(payload["active_translation"]["text"]),
                    {"cases": payload["cases"]},
                    issues=[
                        f"{case['change_kind']}: {case['reason']}"
                        for case in payload["cases"]
                    ],
                    knowledge_version=int(claim.task_snapshot["to_knowledge_version"]),
                )
                if outcome.status not in {
                    V4BlockStatus.COMPLETED.value,
                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                }:
                    audits.extend(dict(audit) for audit in outcome.audit_calls)
                    self._retranslate_or_warn(
                        claim,
                        reason="full_block_repair_failed",
                        result={
                            **result,
                            "error": str(outcome.error or "")[:1024],
                        },
                        audits=audits,
                        run_id=run_id,
                        summary=summary,
                    )
                    continue
                self.database.commit_revalidation_resolution(
                    claim,
                    status="resolved_patch",
                    action="patch_required",
                    result=result,
                    outcome=outcome,
                    audits=audits,
                    run_id=run_id,
                )
                summary["patched"] += 1
            summary["unfinished"] = self.database.unfinished_revalidation_count()
            summary["status"] = (
                "in_progress"
                if summary["unfinished"]
                else "completed_with_warnings"
                if self.database.warning_revalidation_count()
                else "completed"
            )
            self.database.finish_run(run_id, summary["status"])
            return summary
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc)[:1024])
            raise
