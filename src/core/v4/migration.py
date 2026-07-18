"""Non-destructive import from serial_v3 project artifacts."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Dict, List

from ...agents.glossary_manager import GlossaryManager
from ..schemas import ChunkStatus
from .database import V4Database, normalize_english_form, stable_id
from .schema_v9 import (
    SchemaUpgradeRequired,
    confirm_schema9,
    inspect_schema,
)


PARSER_VERSION = "serial-v3-artifacts-1"


class V4Migrator:
    def __init__(
        self,
        project,
        *,
        confirm_token: str | None = None,
        schema8_confirm_token: str | None = None,
    ):
        if (
            confirm_token is not None
            and schema8_confirm_token is not None
            and confirm_token != schema8_confirm_token
        ):
            raise ValueError("conflicting schema migration confirm tokens")
        self.project = project
        self.confirm_token = confirm_token or schema8_confirm_token
        self.database: V4Database | None = None

    def _open_database(self) -> V4Database:
        if self.database is not None:
            return self.database
        path = (
            Path(self.project.root_dir)
            / "artifacts"
            / "parallel_v4"
            / "book.db"
        )
        version = inspect_schema(path)
        if version == 8:
            if not self.confirm_token:
                raise SchemaUpgradeRequired(
                    "parallel_v4 schema 8 requires an explicit schema 9 upgrade; "
                    "run migrate-v4 --preview and confirm the migration before importing"
                )
            confirm_schema9(path.resolve(), self.confirm_token)
        self.database = V4Database(self.project.root_dir)
        return self.database

    @staticmethod
    def _sha256_bytes(value: bytes) -> str:
        return hashlib.sha256(value).hexdigest()

    @staticmethod
    def _block_type(source_text: str) -> str:
        normalized = source_text.strip().casefold()
        if normalized.startswith("afterword") and normalized.endswith("the end"):
            return "bibliography"
        return "prose"

    def migrate(self) -> Dict[str, int | str]:
        database = self._open_database()
        source_bytes = self.project.source_file.read_bytes()
        source_text = self.project.source_file.read_text(encoding="utf-8")
        edition_id = database.ensure_source_edition(
            raw_sha256=self._sha256_bytes(source_bytes),
            normalized_sha256=self._sha256_bytes(source_text.encode("utf-8")),
            parser_version=PARSER_VERSION,
            source_path=str(self.project.source_file),
        )

        block_rows: List[dict] = []
        legacy_chunks = []
        global_index = 0
        chapters = []
        for chapter_file in sorted(self.project.memory.chapters_dir.glob("*.json")):
            chapter = self.project.memory.load_chapter(chapter_file.stem)
            if chapter:
                chapters.append(chapter)
        for chapter in sorted(chapters, key=lambda item: (item.index, item.id)):
            for chunk in sorted(chapter.chunks, key=lambda item: (item.index, item.id)):
                internal_id = stable_id("block", f"{edition_id}:{chunk.id}")
                block_rows.append(
                    {
                        "id": internal_id,
                        "legacy_id": chunk.id,
                        "chapter_id": chapter.id,
                        "chapter_title": chapter.title or chapter.id,
                        "chapter_index": chapter.index,
                        "block_index": chunk.index,
                        "global_index": global_index,
                        "block_type": self._block_type(chunk.source_text),
                        "source_text": chunk.source_text,
                        "source_hash": self._sha256_bytes(chunk.source_text.encode("utf-8")),
                        "token_count": chunk.token_count or 0,
                        "status": "pending",
                    }
                )
                legacy_chunks.append((internal_id, chunk))
                global_index += 1
        database.upsert_blocks(edition_id, block_rows)

        glossary = GlossaryManager(str(self.project.glossary_dir))
        glossary.load()
        imported_terms = 0
        normalized_counts: Dict[str, int] = {}
        for item in glossary.glossary.items:
            normalized = normalize_english_form(item.src)
            normalized_counts[normalized] = normalized_counts.get(normalized, 0) + 1
        for item in glossary.glossary.items:
            with database.transaction() as connection:
                lexeme_id = database.ensure_lexeme(
                    item.src,
                    connection=connection,
                )
                connection.execute(
                    """UPDATE lexemes
                       SET working_target=CASE
                               WHEN verified_target='' AND locked=0 THEN ?
                               ELSE working_target END,
                           status=CASE
                               WHEN verified_target='' AND locked=0 THEN 'working'
                               ELSE status END
                       WHERE id=? AND retired_version IS NULL""",
                    (item.default_target, lexeme_id),
                )
            explicit_sense = bool(item.rules) or normalized_counts.get(
                normalize_english_form(item.src), 0
            ) > 1
            manually_locked = bool(getattr(item, "locked", False))
            if explicit_sense or manually_locked:
                database.import_legacy_concept(
                    source=item.src,
                    target=item.default_target,
                    kind=item.category.value if item.category else "concept",
                    description=item.description or "",
                    status="verified" if manually_locked else "legacy_provisional",
                )
                if manually_locked and item.default_target:
                    database.lock_concept_translation(
                        item.src,
                        item.default_target,
                        kind=item.category.value if item.category else "concept",
                    )
            imported_terms += 1

        imported_translations = 0
        for internal_id, chunk in legacy_chunks:
            if chunk.final_translation:
                database.import_legacy_translation(
                    block_id=internal_id,
                    status=chunk.status.value,
                    draft=chunk.draft_translation or "",
                    final=chunk.final_translation,
                    analysis=chunk.analysis or "",
                    warnings=chunk.quality_warnings,
                )
                imported_translations += 1

        return {
            "source_edition_id": edition_id,
            "blocks": len(block_rows),
            "legacy_terms": imported_terms,
            "legacy_translations": imported_translations,
            "database": str(database.path),
        }
