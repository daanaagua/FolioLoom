"""TXT/EPUB shadow exporter backed by the parallel_v4 SQLite database."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Dict, List

from ..exporter import BookExporter, ExportResult
from ..schemas import Chapter, ChunkStatus, TextChunk
from .database import V4Database
from .models import V4BlockStatus
from .validation import V4Validator


@dataclass
class V4ExportResult:
    txt_path: Path
    epub_path: Path
    quality_report_path: Path
    chapter_count: int
    chunk_count: int


class ParallelV4BookExporter(BookExporter):
    def __init__(self, project, database: V4Database | None = None):
        super().__init__(project)
        self.database = database or V4Database(project.root_dir)
        self._include_annotations = False

    def build_quality_report(self) -> str:
        report = V4Validator(self.database).validate()
        status = self.database.status_summary()
        narrative_lines = [
            "",
            "## narrative_memory",
            "",
            f"- memory_version: {status['memory_version']}",
            f"- premap_cursor: {status['premap_cursor']}",
            f"- translation_cursor: {status['translation_cursor']}",
            (
                "- premap_cache_hit_rate: "
                f"{status['premap_cache_hit_rate']:.4f}"
            ),
            (
                "- degraded_premap_blocks: "
                f"{status['degraded_premap_blocks']}"
            ),
            (
                "- unresolved_references: "
                f"{status['unresolved_narrative_references']}"
            ),
            (
                "- disputed_memories: "
                f"{status['disputed_narrative_memories']}"
            ),
            (
                "- memory_revalidation_tasks: "
                f"{status['memory_revalidation_tasks']}"
            ),
            "",
            "## dynamic_scheduling",
            "",
            (
                "- volatility_low: "
                f"{status['narrative_volatility_low']}"
            ),
            (
                "- volatility_medium: "
                f"{status['narrative_volatility_medium']}"
            ),
            (
                "- volatility_high: "
                f"{status['narrative_volatility_high']}"
            ),
            f"- deferred_proposals: {status['frozen_proposals']}",
            f"- warning_stale: {status['warning_stale']}",
        ]
        return report.to_markdown().rstrip() + "\n" + "\n".join(
            narrative_lines
        ) + "\n"

    def _chapters(self) -> List[Chapter]:
        annotations_by_block: Dict[str, List[dict]] = {}
        if self._include_annotations:
            for annotation in self.database.list_annotations("approved"):
                annotations_by_block.setdefault(annotation["block_id"], []).append(annotation)
        grouped: Dict[str, List[dict]] = {}
        for row in self.database.export_rows("parallel_v4"):
            grouped.setdefault(row["chapter_id"], []).append(row)
        chapters: List[Chapter] = []
        for rows in grouped.values():
            first = rows[0]
            chunks = []
            chapter_notes: List[str] = []
            for row in rows:
                status = row.get("translation_status")
                if status == V4BlockStatus.COMPLETED.value:
                    chunk_status = ChunkStatus.COMPLETED
                elif status == V4BlockStatus.COMPLETED_WITH_WARNINGS.value:
                    chunk_status = ChunkStatus.HUMAN_REVIEW
                else:
                    chunk_status = ChunkStatus.PENDING
                final_translation = row.get("final_translation") or ""
                for annotation in annotations_by_block.get(row["id"], []):
                    paragraphs = [
                        part.strip()
                        for part in re.split(r"\n\s*\n", final_translation.strip())
                        if part.strip()
                    ]
                    paragraph_index = int(annotation["paragraph_index"])
                    if paragraph_index >= len(paragraphs):
                        raise ValueError(
                            f"注释 {annotation['id']} 的段落序号超出译文范围"
                        )
                    note_number = len(chapter_notes) + 1
                    paragraphs[paragraph_index] += f"〔注{note_number}〕"
                    chapter_notes.append(f"〔注{note_number}〕{annotation['body']}")
                    final_translation = "\n\n".join(paragraphs)
                chunks.append(
                    TextChunk(
                        id=row["id"],
                        chapter_id=row["chapter_id"],
                        index=row["block_index"],
                        source_text=row["source_text"],
                        status=chunk_status,
                        draft_translation=row.get("draft_translation") or "",
                        final_translation=final_translation,
                    )
                )
            if chapter_notes and chunks:
                chunks[-1].final_translation = (
                    chunks[-1].final_translation.rstrip()
                    + "\n\n注释\n\n"
                    + "\n\n".join(chapter_notes)
                )
            chapters.append(
                Chapter(
                    id=first["chapter_id"],
                    title=first["chapter_title"],
                    index=first["chapter_index"],
                    source_text="\n\n".join(row["source_text"] for row in rows),
                    chunks=chunks,
                )
            )
        return sorted(chapters, key=lambda chapter: chapter.index)

    def export_v4(
        self,
        output_dir: str | Path | None = None,
        allow_warnings: bool = False,
        include_annotations: bool = False,
        strict_validation: bool = False,
    ) -> V4ExportResult:
        report = V4Validator(self.database).validate()
        if report.high_count:
            raise ValueError(f"严格导出被拒绝：存在 {report.high_count} 个高严重度问题")
        stale_warnings = [
            issue for issue in report.issues if issue.code == "warning_stale"
        ]
        other_warnings = [
            issue
            for issue in report.issues
            if issue.severity == "warning" and issue.code != "warning_stale"
        ]
        if strict_validation and stale_warnings:
            raise ValueError(
                "strict validation rejected "
                f"{len(stale_warnings)} warning_stale translation(s)"
            )
        if other_warnings and not allow_warnings:
            raise ValueError(
                f"严格导出被拒绝：存在 {len(other_warnings)} 个警告；"
                "确认后可使用 allow_warnings"
            )
        target_dir = (
            Path(output_dir)
            if output_dir
            else self.project.root_dir / "exports" / "parallel_v4"
        )
        self._include_annotations = include_annotations
        try:
            result: ExportResult = super().export(output_dir=target_dir, require_complete=True)
        finally:
            self._include_annotations = False
        report_path = target_dir / "quality_report.md"
        report_path.write_text(
            self.build_quality_report(), encoding="utf-8"
        )
        return V4ExportResult(
            txt_path=result.txt_path,
            epub_path=result.epub_path,
            quality_report_path=report_path,
            chapter_count=result.chapter_count,
            chunk_count=result.chunk_count,
        )
