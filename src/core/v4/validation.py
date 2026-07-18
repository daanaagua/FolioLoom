"""Deterministic validation for parallel_v4 translations."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import List

from ..translator import TranslationEngine
from .database import V4Database
from .models import V4BlockStatus


@dataclass(frozen=True)
class ValidationIssue:
    block_id: str
    severity: str
    code: str
    message: str


@dataclass
class ValidationReport:
    block_count: int
    translated_count: int
    issues: List[ValidationIssue] = field(default_factory=list)

    @property
    def high_count(self) -> int:
        return sum(issue.severity == "high" for issue in self.issues)

    @property
    def warning_count(self) -> int:
        return sum(issue.severity == "warning" for issue in self.issues)

    def to_markdown(self) -> str:
        lines = [
            "# parallel_v4 质量报告",
            "",
            f"- 文本块总数：{self.block_count}",
            f"- 已生成译文：{self.translated_count}",
            f"- 高严重度问题：{self.high_count}",
            f"- 警告：{self.warning_count}",
            "",
        ]
        if not self.issues:
            lines.append("未发现确定性结构问题。")
            return "\n".join(lines) + "\n"
        lines.extend(["## 问题", ""])
        for issue in self.issues:
            lines.append(
                f"- [{issue.severity}] `{issue.block_id}` `{issue.code}`：{issue.message}"
            )
        return "\n".join(lines) + "\n"


class V4Validator:
    def __init__(self, database: V4Database):
        self.database = database

    @staticmethod
    def _has_wrapper(text: str) -> bool:
        stripped = text.strip()
        return bool(
            stripped.startswith("```")
            or re.search(r"</?(?:final_translation|translation|response)>", stripped, re.I)
        )

    def validate(self) -> ValidationReport:
        rows = self.database.export_rows("parallel_v4")
        translated = sum(bool(row.get("translation_status")) for row in rows)
        report = ValidationReport(block_count=len(rows), translated_count=translated)
        for row in rows:
            block_id = row.get("legacy_id") or row["id"]
            status = row.get("translation_status")
            final = row.get("final_translation") or ""
            draft = row.get("draft_translation") or ""
            if not status:
                report.issues.append(
                    ValidationIssue(block_id, "high", "missing_translation", "没有活动译文版本")
                )
                continue
            if status in {
                V4BlockStatus.FAILED_RETRYABLE.value,
                V4BlockStatus.FAILED_TERMINAL.value,
                V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
            }:
                report.issues.append(
                    ValidationIssue(block_id, "high", status, "该文本块尚未完成")
                )
                continue
            if status == V4BlockStatus.COMPLETED_WITH_WARNINGS.value:
                warnings = json.loads(row.get("warnings_json") or "[]")
                report.issues.append(
                    ValidationIssue(
                        block_id,
                        "warning",
                        "completed_with_warnings",
                        "；".join(warnings) or "译文需要人工复核",
                    )
                )
            if row.get("validation_status") == "warning_stale":
                try:
                    task_result = json.loads(
                        row.get("revalidation_result_json") or "{}"
                    )
                except (TypeError, json.JSONDecodeError):
                    task_result = {}
                change_ids = task_result.get("change_ids") or []
                reason = (
                    task_result.get("reason")
                    or task_result.get("error_category")
                    or row.get("revalidation_error")
                    or row.get("revalidation_task_action")
                    or "revalidation warning fallback"
                )
                old_knowledge_version = (
                    row.get("revalidation_from_knowledge_version")
                    or row.get("validated_knowledge_version")
                    or row.get("revalidation_to_knowledge_version")
                    or "-"
                )
                report.issues.append(
                    ValidationIssue(
                        block_id,
                        "warning",
                        "warning_stale",
                        (
                            f"active translation remains usable but stale; "
                            f"task={row.get('revalidation_task_id') or '-'}; "
                            f"change_ids={change_ids}; reason={reason}; "
                            f"old_knowledge_version={old_knowledge_version}"
                        ),
                    )
                )
            if not final.strip():
                report.issues.append(
                    ValidationIssue(block_id, "high", "empty_final", "最终译文为空")
                )
                continue
            if self._has_wrapper(final):
                report.issues.append(
                    ValidationIssue(block_id, "high", "output_wrapper", "最终译文仍含结构包装标记")
                )
            if row.get("block_type") != "bibliography":
                for problem in TranslationEngine._translation_shape_problems(
                    row["source_text"],
                    draft,
                    stage="第一层译稿",
                    min_length_ratio=0.15,
                ):
                    report.issues.append(
                        ValidationIssue(block_id, "high", "draft_shape", problem)
                    )
            for problem in TranslationEngine._translation_shape_problems(
                draft,
                final,
                stage="最终译文",
                min_length_ratio=0.75,
            ):
                report.issues.append(
                    ValidationIssue(block_id, "high", "final_shape", problem)
                )
        return report
