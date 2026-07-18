"""Append-only narrative memory, premap cache, snapshots, and retrieval."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from contextlib import closing, contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Sequence

from .database import V4Database, stable_id, utc_now
from .models import V4Block
from .narrative_models import (
    DiscourseDelta,
    DiscourseState,
    NarrativeMemoryCandidate,
    NarrativeMemoryRecord,
    NarrativePremapResult,
    NarrativeRetrieval,
    NarrativeSnapshot,
    NarrativeSubject,
    SemanticRelation,
    render_narrative_memory,
)
from .prompt_projection import StyleAnchorCandidate, sanitize_style_delta


MAX_VISIBLE_MEMORIES = 512
MAX_CACHE_JSON_BYTES = 256 * 1024


class NarrativeContextOverflow(RuntimeError):
    pass


@dataclass(frozen=True)
class MemoryMergeResult:
    memory_version: int
    memory_ids: tuple[str, ...]
    change_ids: tuple[int, ...] = ()


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _normalize_statement(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _semantic_fingerprint(
    candidate: NarrativeMemoryCandidate,
    block: V4Block,
    evidence_offsets: Sequence[tuple[int, int]],
) -> str:
    payload = {
        "memory_type": candidate.memory_type,
        "statement": _normalize_statement(candidate.statement),
        "subjects": sorted(
            (
                subject.subject_type,
                subject.subject_id,
                subject.role,
            )
            for subject in candidate.subjects
        ),
        "source_block_id": block.id,
        "evidence_offsets": sorted(evidence_offsets),
        "visibility": candidate.visibility,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


class NarrativeMemoryStore:
    def __init__(self, database: V4Database):
        if not isinstance(database, V4Database):
            raise TypeError("database must be a V4Database")
        self.database = database

    @contextmanager
    def _write(
        self, connection: sqlite3.Connection | None
    ) -> Iterator[sqlite3.Connection]:
        if connection is not None:
            if not connection.in_transaction:
                raise ValueError("external connection requires an active transaction")
            yield connection
            return
        with self.database.transaction() as owned:
            yield owned

    def current_memory_version(
        self, connection: sqlite3.Connection | None = None
    ) -> int:
        if connection is not None:
            row = connection.execute(
                "SELECT MAX(id) FROM memory_versions"
            ).fetchone()
            return int(row[0])
        with closing(self.database.connect()) as owned:
            row = owned.execute("SELECT MAX(id) FROM memory_versions").fetchone()
        return int(row[0])

    def memory_change_ids_between(
        self,
        lower_exclusive: int,
        upper_inclusive: int,
        connection: sqlite3.Connection | None = None,
    ) -> list[int]:
        if lower_exclusive >= upper_inclusive:
            return []
        if connection is not None:
            return [
                int(row[0])
                for row in connection.execute(
                    """SELECT id FROM memory_changes
                       WHERE memory_version>? AND memory_version<=?
                       ORDER BY id""",
                    (int(lower_exclusive), int(upper_inclusive)),
                ).fetchall()
            ]
        with closing(self.database.connect()) as owned:
            return [
                int(row[0])
                for row in owned.execute(
                    """SELECT id FROM memory_changes
                       WHERE memory_version>? AND memory_version<=?
                       ORDER BY id""",
                    (int(lower_exclusive), int(upper_inclusive)),
                ).fetchall()
            ]

    def _create_memory_version(
        self,
        connection: sqlite3.Connection,
        reason: str,
        source_global_index: int,
    ) -> int:
        parent = self.current_memory_version(connection)
        cursor = connection.execute(
            """INSERT INTO memory_versions(
                   parent_id, reason, source_global_index, created_at)
               VALUES(?, ?, ?, ?)""",
            (parent, reason[:512], int(source_global_index), utc_now()),
        )
        return int(cursor.lastrowid)

    @staticmethod
    def premap_cache_key(
        *,
        block: V4Block,
        structure_hash: str,
        prompt_hash: str,
        model_id: str,
        parameters_hash: str,
        prior_snapshot_hash: str,
        provisional_subject_hash: str,
        protocol_version: str = "narrative-premap-v2",
    ) -> str:
        payload = {
            "protocol_version": protocol_version,
            "source_hash": block.source_hash,
            "structure_hash": structure_hash,
            "prompt_hash": prompt_hash,
            "model_id": model_id,
            "parameters_hash": parameters_hash,
            "prior_snapshot_hash": prior_snapshot_hash,
            "provisional_subject_hash": provisional_subject_hash,
        }
        return "premap-cache_" + hashlib.sha256(
            _canonical_json(payload).encode("utf-8")
        ).hexdigest()

    def save_premap_result(
        self,
        *,
        cache_key: str,
        block: V4Block,
        result: NarrativePremapResult,
        model_id: str,
        prompt_hash: str,
        prior_snapshot_hash: str,
        request_hash: str,
        response_hash: str,
        audit_call_id: int | None = None,
    ) -> str:
        if not isinstance(result, NarrativePremapResult):
            raise TypeError("result must be NarrativePremapResult")
        payload = result.to_dict()
        encoded = _canonical_json(payload).encode("utf-8")
        if len(encoded) > MAX_CACHE_JSON_BYTES:
            raise ValueError("premap result exceeds cache size limit")
        result_id = stable_id("premap", cache_key, 32)
        status = (
            "degraded"
            if result.degraded and not (
                result.semantic_relations or result.memory_candidates
            )
            else "accepted_with_warnings"
            if result.validation_warnings
            else "accepted"
        )
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM premap_results WHERE cache_key=?",
                (cache_key,),
            ).fetchone()
            if existing is not None:
                return str(existing["id"])
            connection.execute(
                """INSERT INTO premap_results(
                       id, block_id, cache_key, status, semantic_json,
                       memory_candidates_json, discourse_delta_json,
                       validation_json, model_id, prompt_hash,
                       prior_snapshot_hash, request_hash, response_hash,
                       audit_call_id, snapshot_id, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
                (
                    result_id,
                    block.id,
                    cache_key,
                    status,
                    _canonical_json(
                        [value.to_dict() for value in result.semantic_relations]
                    ),
                    _canonical_json(
                        [value.to_dict() for value in result.memory_candidates]
                    ),
                    _canonical_json(result.discourse_delta.to_dict()),
                    _canonical_json(
                        {
                            "warnings": list(result.validation_warnings),
                            "degraded": result.degraded,
                        }
                    ),
                    model_id[:256],
                    prompt_hash[:256],
                    prior_snapshot_hash[:256],
                    request_hash[:256],
                    response_hash[:256],
                    audit_call_id,
                    utc_now(),
                ),
            )
        return result_id

    def save_source_structure(
        self,
        block: V4Block,
        structure: Mapping[str, Any],
        *,
        extractor_version: str = "narrative-structure-v1",
    ) -> str:
        structure_json = _canonical_json(dict(structure))
        structure_hash = hashlib.sha256(
            structure_json.encode("utf-8")
        ).hexdigest()
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO source_structure(
                       block_id, structure_json, structure_hash,
                       extractor_version, created_at)
                   VALUES(?, ?, ?, ?, ?)
                   ON CONFLICT(block_id) DO UPDATE SET
                       structure_json=excluded.structure_json,
                       structure_hash=excluded.structure_hash,
                       extractor_version=excluded.extractor_version,
                       created_at=excluded.created_at""",
                (
                    block.id,
                    structure_json,
                    structure_hash,
                    extractor_version[:128],
                    utc_now(),
                ),
            )
        return structure_hash

    def load_premap_result(
        self, cache_key: str
    ) -> NarrativePremapResult | None:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM premap_results WHERE cache_key=?",
                (cache_key,),
            ).fetchone()
        if row is None:
            return None
        relations = []
        for item in json.loads(row["semantic_json"] or "[]"):
            relations.append(
                SemanticRelation(
                    relation_type=str(item["relation_type"]),
                    inference_strength=str(item["inference_strength"]),
                    source_spans=tuple(item.get("source_spans") or ()),
                    related_memory_ids=tuple(
                        item.get("related_memory_ids") or ()
                    ),
                    translation_constraint=str(
                        item["translation_constraint"]
                    ),
                )
            )
        candidates = []
        for item in json.loads(row["memory_candidates_json"] or "[]"):
            candidates.append(
                NarrativeMemoryCandidate(
                    candidate_id=str(item["candidate_id"]),
                    memory_type=str(item["memory_type"]),
                    statement=str(item["statement"]),
                    truth_status=str(item["truth_status"]),
                    visibility=str(item["visibility"]),
                    confidence=float(item["confidence"]),
                    evidence_spans=tuple(item.get("evidence_spans") or ()),
                    subjects=tuple(
                        NarrativeSubject(
                            subject_type=str(subject["subject_type"]),
                            subject_id=str(subject["subject_id"]),
                            role=str(subject.get("role") or "subject"),
                        )
                        for subject in item.get("subjects") or ()
                    ),
                    related_memory_ids=tuple(
                        item.get("related_memory_ids") or ()
                    ),
                    state_operation=str(
                        item.get("state_operation") or "append"
                    ),
                    high_impact=bool(item.get("high_impact")),
                )
            )
        validation = json.loads(row["validation_json"] or "{}")
        return NarrativePremapResult(
            semantic_relations=tuple(relations),
            memory_candidates=tuple(candidates),
            discourse_delta=DiscourseDelta.from_mapping(
                json.loads(row["discourse_delta_json"] or "{}")
            ),
            validation_warnings=tuple(validation.get("warnings") or ()),
            degraded=bool(validation.get("degraded")),
        )

    def link_premap_snapshot(
        self,
        cache_key: str,
        snapshot_id: str,
        *,
        metrics: Mapping[str, Any] | None = None,
    ) -> None:
        with self.database.transaction() as connection:
            exists = connection.execute(
                "SELECT 1 FROM narrative_snapshots WHERE id=?",
                (snapshot_id,),
            ).fetchone()
            if exists is None:
                raise KeyError(f"narrative snapshot does not exist: {snapshot_id}")
            row = connection.execute(
                """SELECT validation_json FROM premap_results
                   WHERE cache_key=?""",
                (cache_key,),
            ).fetchone()
            if row is None:
                raise KeyError(f"premap cache does not exist: {cache_key}")
            try:
                validation = json.loads(
                    str(row["validation_json"] or "{}")
                )
            except (TypeError, ValueError, json.JSONDecodeError):
                validation = {}
            if not isinstance(validation, dict):
                validation = {}
            if metrics:
                validation["metrics"] = dict(metrics)
            updated = connection.execute(
                """UPDATE premap_results
                   SET snapshot_id=?, validation_json=?
                   WHERE cache_key=?""",
                (
                    snapshot_id,
                    _canonical_json(validation),
                    cache_key,
                ),
            )
            if updated.rowcount != 1:
                raise KeyError(f"premap cache does not exist: {cache_key}")

    def latest_premap_cache_key(self, block_id: str) -> str:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                """SELECT cache_key FROM premap_results
                   WHERE block_id=? AND status!='rejected'
                   ORDER BY created_at DESC, id DESC LIMIT 1""",
                (block_id,),
            ).fetchone()
        return str(row["cache_key"]) if row is not None else ""

    def load_snapshot(self, snapshot_id: str) -> NarrativeSnapshot | None:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM narrative_snapshots WHERE id=?",
                (snapshot_id,),
            ).fetchone()
        if row is None:
            return None
        return NarrativeSnapshot(
            id=str(row["id"]),
            block_id=str(row["block_id"]),
            global_index=int(row["global_index"]),
            knowledge_version=int(row["knowledge_version"]),
            memory_version=int(row["memory_version"]),
            previous_snapshot_id=str(row["previous_snapshot_id"] or ""),
            discourse_state=DiscourseState.from_mapping(
                json.loads(row["discourse_state_json"] or "{}")
            ),
            visible_memory_ids=tuple(
                json.loads(row["visible_memory_ids_json"] or "[]")
            ),
            snapshot_hash=str(row["snapshot_hash"]),
        )

    def latest_snapshot_for_block(
        self, block_id: str
    ) -> NarrativeSnapshot | None:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                """SELECT id FROM narrative_snapshots
                   WHERE block_id=?
                   ORDER BY memory_version DESC, knowledge_version DESC,
                            created_at DESC, id DESC
                   LIMIT 1""",
                (block_id,),
            ).fetchone()
        if row is None:
            return None
        return self.load_snapshot(str(row["id"]))

    def latest_premap_result_for_block(
        self, block_id: str
    ) -> NarrativePremapResult | None:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                """SELECT cache_key FROM premap_results
                   WHERE block_id=? AND status!='rejected'
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1""",
                (block_id,),
            ).fetchone()
        if row is None:
            return None
        return self.load_premap_result(str(row["cache_key"]))

    def latest_snapshot_before(
        self,
        global_index: int,
        *,
        source_edition_id: int | None = None,
    ) -> NarrativeSnapshot | None:
        query = """
            SELECT snapshot.id
            FROM narrative_snapshots AS snapshot
            JOIN blocks AS block ON block.id=snapshot.block_id
            WHERE snapshot.global_index<?
        """
        parameters: list[Any] = [int(global_index)]
        if source_edition_id is not None:
            if type(source_edition_id) is not int or source_edition_id <= 0:
                raise ValueError("source_edition_id must be a positive integer")
            query += " AND block.source_edition_id=?"
            parameters.append(source_edition_id)
        query += """
            ORDER BY snapshot.global_index DESC,
                     snapshot.memory_version DESC,
                     snapshot.knowledge_version DESC,
                     snapshot.id DESC
            LIMIT 1
        """
        with closing(self.database.connect()) as connection:
            row = connection.execute(query, parameters).fetchone()
        if row is None:
            return None
        return self.load_snapshot(str(row["id"]))

    def load_style_snapshot(
        self,
        snapshot_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any] | None:
        if connection is not None:
            row = connection.execute(
                "SELECT * FROM style_snapshots WHERE id=?",
                (snapshot_id,),
            ).fetchone()
        else:
            with closing(self.database.connect()) as owned:
                row = owned.execute(
                    "SELECT * FROM style_snapshots WHERE id=?",
                    (snapshot_id,),
                ).fetchone()
        if row is None:
            return None
        return {
            "id": str(row["id"]),
            "block_id": str(row["block_id"]),
            "global_index": int(row["global_index"]),
            "previous_snapshot_id": str(
                row["previous_snapshot_id"] or ""
            ),
            "state": json.loads(str(row["state_json"] or "{}")),
            "state_hash": str(row["state_hash"]),
        }

    def latest_style_snapshot(self) -> dict[str, Any] | None:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                """SELECT id FROM style_snapshots
                   ORDER BY global_index DESC, created_at DESC, id DESC
                   LIMIT 1"""
            ).fetchone()
        if row is None:
            return None
        return self.load_style_snapshot(str(row["id"]))

    def latest_style_snapshot_before(
        self,
        global_index: int,
        *,
        source_edition_id: int | None = None,
    ) -> dict[str, Any] | None:
        if type(global_index) is not int:
            raise TypeError("global_index must be an integer")
        query = """
            SELECT style.id
            FROM style_snapshots AS style
            JOIN blocks AS block ON block.id=style.block_id
            WHERE style.global_index<?
        """
        parameters: list[Any] = [global_index]
        if source_edition_id is not None:
            if type(source_edition_id) is not int or source_edition_id <= 0:
                raise ValueError("source_edition_id must be a positive integer")
            query += " AND block.source_edition_id=?"
            parameters.append(source_edition_id)
        query += """
            ORDER BY style.global_index DESC, style.created_at DESC,
                     style.id DESC
            LIMIT 1
        """
        with closing(self.database.connect()) as connection:
            row = connection.execute(query, parameters).fetchone()
        if row is None:
            return None
        return self.load_style_snapshot(str(row["id"]))

    def merge_style_delta(
        self,
        block: V4Block,
        delta: Mapping[str, Any],
        *,
        previous_snapshot_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any] | None:
        if previous_snapshot_id is None:
            previous = self.latest_style_snapshot_before(
                block.global_index,
                source_edition_id=block.source_edition_id,
            )
        elif previous_snapshot_id:
            previous = self.load_style_snapshot(
                previous_snapshot_id,
                connection=connection,
            )
        else:
            previous = None
        state = dict((previous or {}).get("state") or {})
        if not isinstance(delta, Mapping):
            raise TypeError("style delta must be a mapping")
        state.update(sanitize_style_delta(delta))
        if previous is not None and state == previous["state"]:
            return previous
        if not state:
            return None
        state_json = _canonical_json(state)
        state_hash = hashlib.sha256(
            state_json.encode("utf-8")
        ).hexdigest()
        previous_id = str((previous or {}).get("id") or "")
        snapshot_id = stable_id(
            "style",
            f"{block.id}:{previous_id}:{state_hash}",
            32,
        )
        with self._write(connection) as active:
            active.execute(
                """INSERT OR IGNORE INTO style_snapshots(
                       id, block_id, global_index, previous_snapshot_id,
                       state_json, state_hash, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?)""",
                (
                    snapshot_id,
                    block.id,
                    block.global_index,
                    previous_id or None,
                    state_json,
                    state_hash,
                    utc_now(),
                ),
            )
        return {
            "id": snapshot_id,
            "block_id": block.id,
            "global_index": block.global_index,
            "previous_snapshot_id": previous_id,
            "state": state,
            "state_hash": state_hash,
        }

    def style_anchor_candidates_before(
        self,
        block: V4Block,
        *,
        limit: int = 24,
    ) -> list[StyleAnchorCandidate]:
        """Derive auditable anchors from existing active translation rows.

        Metadata is intentionally projected from append-only translation,
        dependency, block and style-snapshot rows, avoiding a schema migration.
        """

        bounded_limit = max(1, min(128, int(limit)))
        with closing(self.database.connect()) as connection:
            translation_columns = {
                str(row["name"])
                for row in connection.execute(
                    "PRAGMA table_info(translation_versions)"
                ).fetchall()
            }
            validation_expr = (
                "t.validation_status"
                if "validation_status" in translation_columns
                else "'clean'"
            )
            style_expr = (
                "t.style_snapshot_id"
                if "style_snapshot_id" in translation_columns
                else "NULL"
            )
            rows = connection.execute(
                f"""SELECT t.id AS translation_id, t.block_id,
                            t.final_translation, t.draft_translation,
                            t.warnings_json, t.status,
                            {validation_expr} AS validation_status,
                            {style_expr} AS style_snapshot_id,
                            b.global_index, b.block_type, b.source_text
                     FROM translation_versions AS t
                     JOIN blocks AS b ON b.id=t.block_id
                     WHERE t.pipeline='parallel_v4'
                       AND t.active=1
                       AND b.source_edition_id=?
                       AND b.global_index<?
                       AND t.status IN ('completed', 'completed_with_warnings')
                     ORDER BY b.global_index DESC, t.id DESC
                     LIMIT ?""",
                (
                    block.source_edition_id,
                    block.global_index,
                    bounded_limit,
                ),
            ).fetchall()
            candidates: list[StyleAnchorCandidate] = []
            for row in rows:
                source_text = str(row["source_text"] or "").strip()
                target_text = str(row["final_translation"] or "").strip()
                if not source_text or not target_text:
                    continue
                try:
                    warnings = json.loads(str(row["warnings_json"] or "[]"))
                except json.JSONDecodeError:
                    warnings = ["invalid warning payload"]
                warning_text = _canonical_json(warnings)
                fallback = "回退" in warning_text or "fallback" in warning_text.lower()
                integrity_passed = str(row["validation_status"]) == "clean"
                if not integrity_passed or fallback:
                    continue
                style = self.load_style_snapshot(
                    str(row["style_snapshot_id"] or ""),
                    connection=connection,
                )
                style_state = dict((style or {}).get("state") or {})
                anchor_id = f"translation:{int(row['translation_id'])}"
                parent_anchor_id = self._style_anchor_parent(
                    connection, int(row["translation_id"])
                )
                ancestors = self._style_anchor_ancestors(
                    connection, parent_anchor_id
                )
                syntax = style_state.get("syntax_features") or ()
                if isinstance(syntax, str):
                    syntax = (syntax,)
                candidates.append(
                    StyleAnchorCandidate(
                        anchor_id=anchor_id,
                        source_block_id=str(row["block_id"]),
                        source_global_index=int(row["global_index"]),
                        source_text=source_text,
                        target_text=target_text,
                        quality_score=1.0 if not warnings else 0.85,
                        integrity_passed=True,
                        active=True,
                        fallback=False,
                        text_type=str(
                            style_state.get("text_type")
                            or row["block_type"]
                            or "prose"
                        ),
                        narrative_layer=str(
                            style_state.get("narrative_layer") or ""
                        ),
                        register=str(style_state.get("register") or ""),
                        syntax_features=tuple(str(value) for value in syntax),
                        usage_count=self._style_anchor_usage_count(
                            connection, anchor_id
                        ),
                        parent_anchor_id=parent_anchor_id,
                        ancestor_anchor_ids=ancestors,
                        calibration_version="translation-anchor-v1",
                    )
                )
        return candidates

    @staticmethod
    def _style_anchor_parent(
        connection: sqlite3.Connection,
        translation_id: int,
    ) -> str:
        row = connection.execute(
            """SELECT dependency_id FROM dependencies
               WHERE translation_id=? AND dependency_type='style_anchor'
               ORDER BY id DESC LIMIT 1""",
            (translation_id,),
        ).fetchone()
        return str(row["dependency_id"] or "") if row is not None else ""

    @classmethod
    def _style_anchor_ancestors(
        cls,
        connection: sqlite3.Connection,
        parent_anchor_id: str,
    ) -> tuple[str, ...]:
        ancestors: list[str] = []
        current = str(parent_anchor_id or "")
        for _ in range(16):
            if not current or current in ancestors:
                break
            ancestors.append(current)
            if not current.startswith("translation:"):
                break
            try:
                translation_id = int(current.split(":", 1)[1])
            except ValueError:
                break
            current = cls._style_anchor_parent(connection, translation_id)
        return tuple(ancestors)

    @staticmethod
    def _style_anchor_usage_count(
        connection: sqlite3.Connection,
        anchor_id: str,
    ) -> int:
        row = connection.execute(
            """SELECT COUNT(*) AS count FROM dependencies
               WHERE dependency_type='style_anchor' AND dependency_id=?""",
            (anchor_id,),
        ).fetchone()
        return int(row["count"] if row is not None else 0)

    def inspect(
        self,
        *,
        block_id: str | None = None,
        subject_id: str | None = None,
        memory_type: str | None = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError("narrative inspection limit must be 1..1000")
        clauses = ["1=1"]
        params: list[Any] = []
        visible_ids: tuple[str, ...] = ()
        if block_id:
            latest = self.latest_snapshot_for_block(block_id)
            if latest is not None:
                visible_ids = latest.visible_memory_ids
            if visible_ids:
                placeholders = ",".join("?" for _ in visible_ids)
                clauses.append(
                    f"(memory.source_block_id=? OR memory.id IN ({placeholders}))"
                )
                params.extend((block_id, *visible_ids))
            else:
                clauses.append("memory.source_block_id=?")
                params.append(block_id)
        if subject_id:
            clauses.append(
                """EXISTS(
                    SELECT 1 FROM narrative_memory_subjects filter_subject
                    WHERE filter_subject.memory_id=memory.id
                      AND filter_subject.subject_id=?
                )"""
            )
            params.append(subject_id)
        if memory_type:
            clauses.append("memory.memory_type=?")
            params.append(memory_type)
        with closing(self.database.connect()) as connection:
            memory_rows = connection.execute(
                f"""SELECT memory.* FROM narrative_memories memory
                    WHERE {' AND '.join(clauses)}
                    ORDER BY memory.reveal_global_index DESC, memory.id
                    LIMIT ?""",
                (*params, limit),
            ).fetchall()
            memory_ids = tuple(str(row["id"]) for row in memory_rows)
            evidence: dict[str, list[dict[str, Any]]] = {}
            subjects: dict[str, list[dict[str, Any]]] = {}
            links: dict[str, list[dict[str, Any]]] = {}
            if memory_ids:
                placeholders = ",".join("?" for _ in memory_ids)
                for row in connection.execute(
                    f"""SELECT * FROM narrative_memory_evidence
                        WHERE memory_id IN ({placeholders})
                        ORDER BY memory_id, block_id, start_offset""",
                    memory_ids,
                ):
                    evidence.setdefault(str(row["memory_id"]), []).append(
                        dict(row)
                    )
                for row in connection.execute(
                    f"""SELECT * FROM narrative_memory_subjects
                        WHERE memory_id IN ({placeholders})
                        ORDER BY memory_id, subject_type, subject_id, role""",
                    memory_ids,
                ):
                    subjects.setdefault(str(row["memory_id"]), []).append(
                        dict(row)
                    )
                for row in connection.execute(
                    f"""SELECT * FROM narrative_memory_links
                        WHERE from_memory_id IN ({placeholders})
                           OR to_memory_id IN ({placeholders})
                        ORDER BY created_memory_version, relation,
                                 from_memory_id, to_memory_id""",
                    (*memory_ids, *memory_ids),
                ):
                    item = dict(row)
                    for memory_id in {
                        str(row["from_memory_id"]),
                        str(row["to_memory_id"]),
                    } & set(memory_ids):
                        links.setdefault(memory_id, []).append(item)
            snapshot_rows = (
                connection.execute(
                    """SELECT * FROM narrative_snapshots
                       WHERE block_id=?
                       ORDER BY memory_version DESC, knowledge_version DESC,
                                created_at DESC, id DESC
                       LIMIT 20""",
                    (block_id,),
                ).fetchall()
                if block_id
                else []
            )
            premap_rows = (
                connection.execute(
                    """SELECT id, block_id, status, validation_json,
                              snapshot_id, model_id, created_at
                       FROM premap_results WHERE block_id=?
                       ORDER BY created_at DESC, id DESC LIMIT 20""",
                    (block_id,),
                ).fetchall()
                if block_id
                else []
            )
        memories = []
        for row in memory_rows:
            item = dict(row)
            memory_id = str(row["id"])
            item["evidence"] = evidence.get(memory_id, [])
            item["subjects"] = subjects.get(memory_id, [])
            item["links"] = links.get(memory_id, [])
            memories.append(item)
        snapshots = []
        for row in snapshot_rows:
            item = dict(row)
            item["discourse_state"] = json.loads(
                item.pop("discourse_state_json") or "{}"
            )
            item["visible_memory_ids"] = json.loads(
                item.pop("visible_memory_ids_json") or "[]"
            )
            snapshots.append(item)
        premap = []
        for row in premap_rows:
            item = dict(row)
            item["validation"] = json.loads(
                item.pop("validation_json") or "{}"
            )
            premap.append(item)
        return {
            "filters": {
                "block_id": block_id,
                "subject_id": subject_id,
                "memory_type": memory_type,
            },
            "memories": memories,
            "snapshots": snapshots,
            "premap": premap,
        }

    def snapshot_for_cache(
        self, cache_key: str
    ) -> NarrativeSnapshot | None:
        with closing(self.database.connect()) as connection:
            row = connection.execute(
                """SELECT snapshot_id FROM premap_results
                   WHERE cache_key=?""",
                (cache_key,),
            ).fetchone()
        if row is None or not row["snapshot_id"]:
            return None
        return self.load_snapshot(str(row["snapshot_id"]))

    def snapshot_payload(
        self, snapshot: NarrativeSnapshot, *, max_memories: int = 64
    ) -> dict[str, Any]:
        selected_ids = snapshot.visible_memory_ids[:max_memories]
        if not selected_ids:
            memories: list[dict[str, Any]] = []
        else:
            placeholders = ",".join("?" for _ in selected_ids)
            with closing(self.database.connect()) as connection:
                rows = connection.execute(
                    f"""SELECT id, memory_type, statement, truth_status,
                               visibility, confidence, status
                        FROM narrative_memories
                        WHERE id IN ({placeholders})""",
                    selected_ids,
                ).fetchall()
            by_id = {str(row["id"]): row for row in rows}
            memories = [
                {
                    "id": memory_id,
                    "memory_type": str(by_id[memory_id]["memory_type"]),
                    "statement": str(by_id[memory_id]["statement"]),
                    "truth_status": str(by_id[memory_id]["truth_status"]),
                    "visibility": str(by_id[memory_id]["visibility"]),
                    "confidence": float(by_id[memory_id]["confidence"]),
                    "status": str(by_id[memory_id]["status"]),
                }
                for memory_id in selected_ids
                if memory_id in by_id
            ]
        return {
            "id": snapshot.id,
            "snapshot_hash": snapshot.snapshot_hash,
            "global_index": snapshot.global_index,
            "memory_version": snapshot.memory_version,
            "visible_memories": memories,
        }

    @staticmethod
    def _evidence_offsets(
        block: V4Block, candidate: NarrativeMemoryCandidate
    ) -> tuple[tuple[int, int, str], ...]:
        found: list[tuple[int, int, str]] = []
        cursor = 0
        for quote in candidate.evidence_spans:
            start = block.source_text.find(quote, cursor)
            if start < 0:
                start = block.source_text.find(quote)
            if start < 0:
                raise ValueError(
                    f"memory evidence is not grounded in {block.id}: {quote!r}"
                )
            end = start + len(quote)
            found.append((start, end, quote))
            cursor = end
        return tuple(found)

    @staticmethod
    def _link_relation(candidate: NarrativeMemoryCandidate) -> str:
        if candidate.memory_type == "contradiction":
            return "contradicts"
        if candidate.state_operation == "supersede":
            return "supersedes"
        if candidate.state_operation == "close_question":
            return "answers"
        if candidate.state_operation == "relate":
            return "elaborates"
        return "supports"

    @staticmethod
    def _impact(candidate: NarrativeMemoryCandidate) -> int:
        if candidate.high_impact or candidate.memory_type in {
            "timeline_anchor",
            "narrator_state",
        }:
            return 3
        if candidate.memory_type in {
            "relationship_state",
            "location_state",
            "character_state",
            "contradiction",
        }:
            return 2
        if candidate.visibility == "render_only":
            return 1
        return 0

    def merge_candidates(
        self,
        block: V4Block,
        candidates: Sequence[NarrativeMemoryCandidate],
        *,
        source: str = "premap",
        connection: sqlite3.Connection | None = None,
    ) -> MemoryMergeResult:
        prepared_by_id: dict[
            str,
            tuple[
                NarrativeMemoryCandidate,
                tuple[tuple[int, int, str], ...],
                str,
                str,
            ],
        ] = {}
        for candidate in candidates:
            if not isinstance(candidate, NarrativeMemoryCandidate):
                raise TypeError(
                    "memory candidates must contain NarrativeMemoryCandidate values"
                )
            evidence = self._evidence_offsets(block, candidate)
            fingerprint = _semantic_fingerprint(
                candidate,
                block,
                [(start, end) for start, end, _ in evidence],
            )
            memory_id = stable_id("memory", fingerprint, 32)
            prepared_by_id.setdefault(
                memory_id,
                (candidate, evidence, fingerprint, memory_id),
            )
        prepared = list(prepared_by_id.values())
        if not prepared:
            return MemoryMergeResult(self.current_memory_version(), ())

        with self._write(connection) as active:
            existing_ids = {
                str(row["id"])
                for row in active.execute(
                    f"""SELECT id FROM narrative_memories
                        WHERE id IN ({','.join('?' for _ in prepared)})""",
                    tuple(value[3] for value in prepared),
                )
            }
            new_rows = [value for value in prepared if value[3] not in existing_ids]
            missing_links: list[tuple[str, str, str, float]] = []
            for candidate, _evidence, _fingerprint, memory_id in prepared:
                relation = self._link_relation(candidate)
                for related_id in candidate.related_memory_ids:
                    target = active.execute(
                        "SELECT 1 FROM narrative_memories WHERE id=?",
                        (related_id,),
                    ).fetchone()
                    if target is None:
                        continue
                    exists = active.execute(
                        """SELECT 1 FROM narrative_memory_links
                           WHERE from_memory_id=? AND to_memory_id=?
                             AND relation=?""",
                        (memory_id, related_id, relation),
                    ).fetchone()
                    if exists is None:
                        missing_links.append(
                            (memory_id, related_id, relation, candidate.confidence)
                        )
            if not new_rows and not missing_links:
                return MemoryMergeResult(
                    self.current_memory_version(active),
                    tuple(value[3] for value in prepared),
                )

            version = self._create_memory_version(
                active,
                f"{source} narrative memory for {block.id}",
                block.global_index,
            )
            change_ids: list[int] = []
            for candidate, evidence, fingerprint, memory_id in new_rows:
                active.execute(
                    """INSERT INTO narrative_memories(
                           id, memory_type, statement, truth_status, visibility,
                           confidence, reveal_global_index, source_block_id,
                           source_hash, status, high_impact,
                           semantic_fingerprint, created_memory_version,
                           retired_memory_version, created_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?, ?,
                              ?, NULL, ?)""",
                    (
                        memory_id,
                        candidate.memory_type,
                        candidate.statement,
                        candidate.truth_status,
                        candidate.visibility,
                        candidate.confidence,
                        block.global_index,
                        block.id,
                        block.source_hash,
                        int(candidate.high_impact),
                        fingerprint,
                        version,
                        utc_now(),
                    ),
                )
                for start, end, quote in evidence:
                    active.execute(
                        """INSERT OR IGNORE INTO narrative_memory_evidence(
                               memory_id, block_id, start_offset, end_offset,
                               quote, source_hash)
                           VALUES(?, ?, ?, ?, ?, ?)""",
                        (
                            memory_id,
                            block.id,
                            start,
                            end,
                            quote,
                            block.source_hash,
                        ),
                    )
                for subject in candidate.subjects:
                    active.execute(
                        """INSERT OR IGNORE INTO narrative_memory_subjects(
                               memory_id, subject_type, subject_id, role)
                           VALUES(?, ?, ?, ?)""",
                        (
                            memory_id,
                            subject.subject_type,
                            subject.subject_id,
                            subject.role,
                        ),
                    )
                cursor = active.execute(
                    """INSERT INTO memory_changes(
                           memory_version, subject_type, subject_id, change_kind,
                           old_fingerprint, new_fingerprint, impact_level,
                           payload_json, created_at)
                       VALUES(?, 'narrative_memory', ?, ?, '', ?, ?, ?, ?)""",
                    (
                        version,
                        memory_id,
                        candidate.memory_type,
                        fingerprint,
                        self._impact(candidate),
                        _canonical_json(
                            {
                                "source_block_id": block.id,
                                "visibility": candidate.visibility,
                                "high_impact": candidate.high_impact,
                            }
                        ),
                        utc_now(),
                    ),
                )
                change_ids.append(int(cursor.lastrowid))
            for from_id, to_id, relation, confidence in missing_links:
                active.execute(
                    """INSERT OR IGNORE INTO narrative_memory_links(
                           from_memory_id, to_memory_id, relation, confidence,
                           created_memory_version)
                       VALUES(?, ?, ?, ?, ?)""",
                    (from_id, to_id, relation, confidence, version),
                )
                if relation in {"answers", "supersedes"}:
                    prior = active.execute(
                        """SELECT semantic_fingerprint FROM narrative_memories
                           WHERE id=? AND retired_memory_version IS NULL""",
                        (to_id,),
                    ).fetchone()
                    if prior is not None:
                        active.execute(
                            """UPDATE narrative_memories
                               SET status='superseded',
                                   retired_memory_version=?
                               WHERE id=? AND retired_memory_version IS NULL""",
                            (version, to_id),
                        )
                        cursor = active.execute(
                            """INSERT INTO memory_changes(
                                   memory_version, subject_type, subject_id,
                                   change_kind, old_fingerprint,
                                   new_fingerprint, impact_level,
                                   payload_json, created_at)
                               VALUES(?, 'narrative_memory', ?, ?, ?, '', 2,
                                      ?, ?)""",
                            (
                                version,
                                to_id,
                                relation,
                                str(prior["semantic_fingerprint"]),
                                _canonical_json({"replacement": from_id}),
                                utc_now(),
                            ),
                        )
                        change_ids.append(int(cursor.lastrowid))
            return MemoryMergeResult(
                version,
                tuple(value[3] for value in prepared),
                tuple(change_ids),
            )

    def links_for_memory(self, memory_id: str) -> list[dict[str, str]]:
        with closing(self.database.connect()) as connection:
            rows = connection.execute(
                """SELECT to_memory_id, relation
                   FROM narrative_memory_links
                   WHERE from_memory_id=?
                   ORDER BY relation, to_memory_id""",
                (memory_id,),
            ).fetchall()
        return [
            {
                "to_memory_id": str(row["to_memory_id"]),
                "relation": str(row["relation"]),
            }
            for row in rows
        ]

    def build_snapshot(
        self,
        block: V4Block,
        *,
        knowledge_version: int,
        discourse_state: DiscourseState,
        memory_version: int | None = None,
    ) -> NarrativeSnapshot:
        version = memory_version or self.current_memory_version()
        priority_subject_ids = {
            value
            for value in (
                *discourse_state.active_speakers,
                *discourse_state.addressed_parties,
                *discourse_state.unresolved_references,
                discourse_state.viewpoint_holder,
                discourse_state.narrator_layer,
                discourse_state.scene_location,
                discourse_state.scene_time,
                discourse_state.presentation_layer,
            )
            if value
        }
        with self.database.transaction() as connection:
            if priority_subject_ids:
                subject_placeholders = ",".join(
                    "?" for _ in priority_subject_ids
                )
                priority_sql = f"""EXISTS(
                    SELECT 1 FROM narrative_memory_subjects nms
                    WHERE nms.memory_id=nm.id
                      AND nms.subject_id IN ({subject_placeholders})
                )"""
                priority_args = tuple(sorted(priority_subject_ids))
            else:
                priority_sql = "0"
                priority_args = ()
            rows = connection.execute(
                f"""SELECT nm.id, {priority_sql} priority_match
                    FROM narrative_memories nm
                    JOIN blocks source_block
                      ON source_block.id=nm.source_block_id
                     AND source_block.source_hash=nm.source_hash
                    WHERE nm.reveal_global_index<=?
                      AND nm.visibility!='system_private'
                      AND nm.status!='rejected'
                      AND nm.created_memory_version<=?
                      AND (nm.retired_memory_version IS NULL
                           OR nm.retired_memory_version>?)
                    ORDER BY priority_match DESC, nm.high_impact DESC,
                             nm.reveal_global_index DESC, nm.id
                    LIMIT ?""",
                priority_args
                + (
                    block.global_index,
                    version,
                    version,
                    MAX_VISIBLE_MEMORIES,
                ),
            ).fetchall()
            visible_ids = tuple(str(row["id"]) for row in rows)
            previous = connection.execute(
                """SELECT snapshot.id
                   FROM narrative_snapshots AS snapshot
                   JOIN blocks AS previous_block
                     ON previous_block.id=snapshot.block_id
                   WHERE snapshot.global_index<?
                     AND previous_block.source_edition_id=?
                     AND snapshot.knowledge_version<=?
                     AND snapshot.memory_version<=?
                   ORDER BY snapshot.global_index DESC,
                            snapshot.memory_version DESC, snapshot.id DESC
                   LIMIT 1""",
                (
                    block.global_index,
                    block.source_edition_id,
                    knowledge_version,
                    version,
                ),
            ).fetchone()
            previous_id = str(previous["id"]) if previous is not None else ""
            state_json = _canonical_json(discourse_state.to_dict())
            snapshot_hash = hashlib.sha256(
                _canonical_json(
                    {
                        "block_id": block.id,
                        "global_index": block.global_index,
                        "knowledge_version": int(knowledge_version),
                        "memory_version": int(version),
                        "previous_snapshot_id": previous_id,
                        "discourse_state": discourse_state.to_dict(),
                        "visible_memory_ids": visible_ids,
                    }
                ).encode("utf-8")
            ).hexdigest()
            snapshot_id = stable_id("snapshot", snapshot_hash, 32)
            connection.execute(
                """INSERT OR IGNORE INTO narrative_snapshots(
                       id, block_id, global_index, knowledge_version,
                       memory_version, previous_snapshot_id,
                       discourse_state_json, visible_memory_ids_json,
                       snapshot_hash, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    snapshot_id,
                    block.id,
                    block.global_index,
                    int(knowledge_version),
                    int(version),
                    previous_id or None,
                    state_json,
                    _canonical_json(visible_ids),
                    snapshot_hash,
                    utc_now(),
                ),
            )
        return NarrativeSnapshot(
            id=snapshot_id,
            block_id=block.id,
            global_index=block.global_index,
            knowledge_version=int(knowledge_version),
            memory_version=int(version),
            previous_snapshot_id=previous_id,
            discourse_state=discourse_state,
            visible_memory_ids=visible_ids,
            snapshot_hash=snapshot_hash,
        )

    @staticmethod
    def _record_from_row(
        row: sqlite3.Row, subjects: Sequence[NarrativeSubject]
    ) -> NarrativeMemoryRecord:
        return NarrativeMemoryRecord(
            id=str(row["id"]),
            memory_type=str(row["memory_type"]),
            statement=str(row["statement"]),
            truth_status=str(row["truth_status"]),
            visibility=str(row["visibility"]),
            confidence=float(row["confidence"]),
            reveal_global_index=int(row["reveal_global_index"]),
            source_block_id=str(row["source_block_id"]),
            status=str(row["status"]),
            high_impact=bool(row["high_impact"]),
            semantic_fingerprint=str(row["semantic_fingerprint"]),
            subjects=tuple(subjects),
        )

    def retrieve_for_block(
        self,
        block: V4Block,
        snapshot: NarrativeSnapshot,
        *,
        matched_subject_ids: Sequence[str],
        semantic_relation_memory_ids: Sequence[str] = (),
        max_chars: int,
    ) -> NarrativeRetrieval:
        if max_chars < 1:
            raise ValueError("max_chars must be positive")
        if not snapshot.visible_memory_ids:
            return NarrativeRetrieval((), (), 0)
        placeholders = ",".join("?" for _ in snapshot.visible_memory_ids)
        direct_relation_ids = {
            str(value)
            for value in semantic_relation_memory_ids
            if str(value) in snapshot.visible_memory_ids
        }
        with closing(self.database.connect()) as connection:
            rows = connection.execute(
                f"""SELECT * FROM narrative_memories
                    WHERE id IN ({placeholders})""",
                snapshot.visible_memory_ids,
            ).fetchall()
            subject_rows = connection.execute(
                f"""SELECT * FROM narrative_memory_subjects
                    WHERE memory_id IN ({placeholders})
                    ORDER BY memory_id, subject_type, subject_id, role""",
                snapshot.visible_memory_ids,
            ).fetchall()
        subjects_by_memory: dict[str, list[NarrativeSubject]] = {}
        for row in subject_rows:
            subjects_by_memory.setdefault(str(row["memory_id"]), []).append(
                NarrativeSubject(
                    subject_type=str(row["subject_type"]),
                    subject_id=str(row["subject_id"]),
                    role=str(row["role"]),
                )
            )
        matched = {str(value) for value in matched_subject_ids}
        discourse = set(snapshot.discourse_state.active_speakers)
        discourse.update(snapshot.discourse_state.addressed_parties)
        discourse.update(snapshot.discourse_state.unresolved_references)
        if snapshot.discourse_state.viewpoint_holder:
            discourse.add(snapshot.discourse_state.viewpoint_holder)
        if snapshot.discourse_state.narrator_layer:
            discourse.add(snapshot.discourse_state.narrator_layer)
        if snapshot.discourse_state.scene_location:
            discourse.add(snapshot.discourse_state.scene_location)
        if snapshot.discourse_state.scene_time:
            discourse.add(snapshot.discourse_state.scene_time)
        if snapshot.discourse_state.presentation_layer:
            discourse.add(snapshot.discourse_state.presentation_layer)
        one_hop_seed_ids = set(direct_relation_ids)
        for memory_id, memory_subjects in subjects_by_memory.items():
            subject_ids = {value.subject_id for value in memory_subjects}
            if subject_ids & matched or subject_ids & discourse:
                one_hop_seed_ids.add(memory_id)
        one_hop_ids: set[str] = set()
        if one_hop_seed_ids:
            seed_placeholders = ",".join("?" for _ in one_hop_seed_ids)
            with closing(self.database.connect()) as connection:
                link_rows = connection.execute(
                    f"""SELECT from_memory_id, to_memory_id
                        FROM narrative_memory_links
                        WHERE created_memory_version<=?
                          AND (
                              from_memory_id IN ({seed_placeholders})
                              OR to_memory_id IN ({seed_placeholders})
                          )""",
                    (
                        snapshot.memory_version,
                        *sorted(one_hop_seed_ids),
                        *sorted(one_hop_seed_ids),
                    ),
                ).fetchall()
            visible_ids = set(snapshot.visible_memory_ids)
            for link in link_rows:
                from_id = str(link["from_memory_id"])
                to_id = str(link["to_memory_id"])
                if from_id in one_hop_seed_ids and to_id in visible_ids:
                    one_hop_ids.add(to_id)
                if to_id in one_hop_seed_ids and from_id in visible_ids:
                    one_hop_ids.add(from_id)
            one_hop_ids.difference_update(one_hop_seed_ids)
        ranked = []
        for row in rows:
            memory_id = str(row["id"])
            memory_subjects = subjects_by_memory.get(str(row["id"]), [])
            subject_ids = {value.subject_id for value in memory_subjects}
            direct = bool(subject_ids & matched)
            participant = bool(subject_ids & discourse)
            semantic_reference = memory_id in direct_relation_ids
            one_hop_relation = memory_id in one_hop_ids
            distance = max(
                0, block.global_index - int(row["reveal_global_index"])
            )
            score = (
                100 * int(direct)
                + 80 * int(participant)
                + 70 * int(semantic_reference)
                + 50 * int(distance <= 3)
                + 30 * int(str(row["memory_type"]) == "open_question")
                + 25 * int(bool(row["high_impact"]))
                + 20 * int(one_hop_relation)
                + int(float(row["confidence"]) * 20)
                - min(distance, 50)
            )
            record = self._record_from_row(row, memory_subjects)
            required = bool(
                semantic_reference
                or (record.high_impact and (direct or participant))
                or (
                    record.visibility == "render_only"
                    and (direct or participant)
                )
                or (
                    record.memory_type == "explicit_fact"
                    and record.status == "verified"
                    and direct
                )
            )
            rendered_size = len(
                render_narrative_memory(record, required=required)
            ) + 1
            ranked.append(
                (
                    required,
                    score,
                    record.reveal_global_index,
                    record.id,
                    rendered_size,
                    record,
                )
            )
        ranked.sort(key=lambda item: (-int(item[0]), -item[1], -item[2], item[3]))
        required_rows = [item for item in ranked if item[0]]
        required_chars = sum(item[4] for item in required_rows)
        if required_chars > max_chars:
            raise NarrativeContextOverflow(
                f"{block.id} required narrative context {required_chars} "
                f"exceeds budget {max_chars}"
            )
        selected = list(required_rows)
        used = required_chars
        for item in ranked:
            if item[0]:
                continue
            if used + item[4] > max_chars:
                continue
            selected.append(item)
            used += item[4]
        return NarrativeRetrieval(
            memories=tuple(item[5] for item in selected),
            required_memory_ids=tuple(item[5].id for item in required_rows),
            rendered_chars=used,
        )
