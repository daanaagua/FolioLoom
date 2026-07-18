"""Read-only, single-run exporter for the lossless translator-v5 schema."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import OrderedDict
from pathlib import Path
from typing import Any, List
from zipfile import ZIP_DEFLATED, ZipFile

from .exporter import BookExporter, ExportResult
from .schemas import Chapter, ChunkStatus, TextChunk


LOSSLESS_SCHEMA_VERSION = 2
LOSSLESS_SCHEMA_MARKER = "deepnovel-lossless-book-store-v2-knowledge-history"
REQUIRED_TABLES = frozenset(
    {
        "lossless_schema_meta",
        "source_versions",
        "logical_blocks",
        "translation_runs",
        "window_plans",
        "window_membership",
        "translations",
    }
)


class V5BookExporter(BookExporter):
    """Project exactly one schema-v2 run into TXT/EPUB plus stable lineage."""

    def __init__(
        self,
        project,
        database_path: str | Path | None = None,
        *,
        run_id: str | None = None,
    ):
        super().__init__(project)
        self.database_path = Path(database_path) if database_path else (
            Path(project.root_dir) / "artifacts" / "translator_v5" / "book.db"
        )
        self.requested_run_id = run_id
        self.run_id: str | None = None
        self._cached_chapters: List[Chapter] | None = None
        self._missing_ids: list[str] = []
        self._stale_ids: list[str] = []
        self._lineage: dict[str, Any] | None = None

    @staticmethod
    def _sha256(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def _read_json(value: str, label: str) -> Any:
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid {label} JSON") from exc

    @staticmethod
    def _validate_schema(database: sqlite3.Connection) -> None:
        version = int(database.execute("PRAGMA user_version").fetchone()[0])
        tables = {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if version != LOSSLESS_SCHEMA_VERSION or not REQUIRED_TABLES.issubset(tables):
            raise ValueError("V5 exporter requires the lossless schema v2 database")
        marker = database.execute(
            "SELECT value FROM lossless_schema_meta WHERE key='marker'"
        ).fetchone()
        if marker is None or marker[0] != LOSSLESS_SCHEMA_MARKER:
            raise ValueError("V5 exporter requires the lossless schema v2 marker")

    def _select_run(self, database: sqlite3.Connection) -> sqlite3.Row:
        candidates = database.execute(
            """
            SELECT run_id, source_version, protocol_version, model_id,
                   metadata_json, status
            FROM translation_runs
            WHERE status <> 'quarantined'
            ORDER BY run_id
            """
        ).fetchall()
        if self.requested_run_id is None:
            if len(candidates) != 1:
                raise ValueError(
                    f"export requires --run-id when {len(candidates)} non-quarantined runs exist"
                )
            return candidates[0]
        selected = [row for row in candidates if row["run_id"] == self.requested_run_id]
        if len(selected) != 1:
            raise ValueError(f"run ID is unknown or quarantined: {self.requested_run_id}")
        return selected[0]

    def _load_projection(self) -> tuple[list[sqlite3.Row], sqlite3.Row]:
        if not self.database_path.exists():
            raise FileNotFoundError(f"V5 database does not exist: {self.database_path}")
        uri = f"{self.database_path.resolve().as_uri()}?mode=ro"
        with sqlite3.connect(uri, uri=True) as database:
            database.row_factory = sqlite3.Row
            self._validate_schema(database)
            run = self._select_run(database)
            rows = database.execute(
                """
                SELECT b.block_id, b.global_index, b.canonical_start, b.canonical_end,
                       b.source_text, b.source_hash,
                       m.window_id, m.position,
                       w.ordinal AS window_ordinal, w.chapter_id, w.chapter_title,
                       t.run_id AS translation_run_id,
                       t.source_version AS translation_source_version,
                       t.block_id AS translation_block_id,
                       t.version AS translation_version,
                       t.source_hash AS translation_source_hash,
                       t.text AS translation_text,
                       t.result_status AS translation_status,
                       t.stage_state AS translation_stage_state
                FROM logical_blocks AS b
                JOIN window_membership AS m
                  ON m.source_version=b.source_version AND m.block_id=b.block_id
                JOIN window_plans AS w
                  ON w.run_id=m.run_id AND w.window_id=m.window_id
                 AND w.source_version=m.source_version
                LEFT JOIN translations AS t
                  ON t.run_id=m.run_id AND t.window_id=m.window_id
                 AND t.source_version=m.source_version AND t.block_id=m.block_id
                 AND t.active=1
                WHERE m.run_id=? AND b.source_version=?
                ORDER BY b.global_index
                """,
                (run["run_id"], run["source_version"]),
            ).fetchall()
            source = database.execute(
                """
                SELECT canonical_sha256, canonical_chars
                FROM source_versions WHERE source_version=?
                """,
                (run["source_version"],),
            ).fetchone()
            block_count = database.execute(
                "SELECT COUNT(*) FROM logical_blocks WHERE source_version=?",
                (run["source_version"],),
            ).fetchone()[0]
        if source is None or not rows or len(rows) != int(block_count):
            raise ValueError("selected run does not cover every logical block exactly once")
        canonical = "".join(row["source_text"] for row in rows)
        if len(canonical) != int(source["canonical_chars"]):
            raise ValueError("selected source version has an invalid canonical character count")
        if self._sha256(canonical) != source["canonical_sha256"]:
            raise ValueError("selected source version canonical hash does not match its blocks")
        for ordinal, row in enumerate(rows):
            if row["global_index"] != ordinal:
                raise ValueError("selected run block order is not continuous")
            if self._sha256(row["source_text"]) != row["source_hash"]:
                raise ValueError(f"source hash mismatch for block {row['block_id']}")
        return rows, run

    def _chapters(self) -> List[Chapter]:
        if self._cached_chapters is not None:
            return self._cached_chapters
        rows, run = self._load_projection()
        self.run_id = run["run_id"]
        metadata = self._read_json(run["metadata_json"], "run metadata")
        grouped: OrderedDict[str, dict[str, Any]] = OrderedDict()
        missing: list[str] = []
        stale: list[str] = []
        lineage_blocks: list[dict[str, Any]] = []
        for row in rows:
            chapter_id = row["chapter_id"]
            grouped.setdefault(
                chapter_id,
                {"title": row["chapter_title"], "source": [], "chunks": []},
            )
            translation = row["translation_text"]
            valid_identity = (
                row["translation_run_id"] == run["run_id"]
                and row["translation_source_version"] == run["source_version"]
                and row["translation_block_id"] == row["block_id"]
                and row["translation_stage_state"] == "promoted"
                and row["translation_status"]
                in ("completed", "completed_with_warnings")
                and isinstance(row["translation_version"], int)
                and row["translation_version"] > 0
            )
            translation_revision: int | None = None
            if translation is None or not str(translation).strip():
                missing.append(row["block_id"])
                status = ChunkStatus.PENDING
                final_translation = None
            elif not valid_identity or row["translation_source_hash"] != row["source_hash"]:
                stale.append(row["block_id"])
                status = ChunkStatus.PENDING
                final_translation = None
            else:
                translation_revision = int(row["translation_version"])
                status = (
                    ChunkStatus.HUMAN_REVIEW
                    if row["translation_status"] == "completed_with_warnings"
                    else ChunkStatus.COMPLETED
                )
                final_translation = str(translation).strip()
            grouped[chapter_id]["source"].append(row["source_text"])
            grouped[chapter_id]["chunks"].append(
                TextChunk(
                    id=row["block_id"],
                    chapter_id=chapter_id,
                    index=int(row["position"]),
                    source_text=row["source_text"],
                    status=status,
                    final_translation=final_translation,
                )
            )
            lineage_blocks.append(
                {
                    "ordinal": int(row["global_index"]),
                    "blockId": row["block_id"],
                    "sourceHash": row["source_hash"],
                    "translationRevision": translation_revision,
                }
            )
        self._missing_ids = missing
        self._stale_ids = stale
        all_missing = [
            item["blockId"]
            for item in lineage_blocks
            if item["translationRevision"] is None
        ]
        self._lineage = {
            "schema": "v5-book-lineage-1",
            "runId": run["run_id"],
            "sourceVersion": run["source_version"],
            "protocolVersion": run["protocol_version"],
            "modelId": run["model_id"],
            "runMetadata": metadata,
            "complete": len(all_missing) == 0,
            "missingBlockIds": all_missing,
            "blocks": lineage_blocks,
        }
        self._cached_chapters = [
            Chapter(
                id=chapter_id,
                title=data["title"],
                index=index,
                source_text="\n\n".join(data["source"]),
                chunks=data["chunks"],
            )
            for index, (chapter_id, data) in enumerate(grouped.items())
        ]
        return self._cached_chapters

    def export_v5(
        self,
        output_dir: str | Path | None = None,
        *,
        allow_incomplete: bool = False,
    ) -> ExportResult:
        self._chapters()
        if self._stale_ids:
            raise ValueError(
                f"{len(self._stale_ids)} active translations have stale source hash or run lineage"
            )
        if not allow_incomplete:
            if self._missing_ids:
                raise ValueError(f"{len(self._missing_ids)} text blocks have no active translation")
        target_dir = output_dir or (
            Path(self.project.root_dir) / "exports" / "translator_v5"
        )
        result = self.export(
            output_dir=target_dir,
            require_complete=not allow_incomplete,
        )
        lineage = self._lineage
        if lineage is None:
            raise RuntimeError("lineage projection was not initialized")
        encoded = json.dumps(
            lineage,
            ensure_ascii=False,
            indent=2,
            separators=(",", ": "),
        ) + "\n"
        lineage_path = result.txt_path.with_suffix(".lineage.json")
        lineage_path.write_text(encoded, encoding="utf-8")
        with ZipFile(result.epub_path, "a") as archive:
            archive.writestr(
                "META-INF/v5-lineage.json",
                encoded.encode("utf-8"),
                compress_type=ZIP_DEFLATED,
            )
        return result
