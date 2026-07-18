"""Generate a readable serial_v3 versus parallel_v4 shadow comparison."""

from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path
from typing import Optional

from ..text_normalization import normalize_chinese_quote_style
from .database import V4Database


def write_shadow_comparison(
    database: V4Database,
    output_path: str | Path,
    max_blocks: Optional[int] = None,
    baseline_name: Optional[str] = None,
) -> Path:
    with closing(database.connect()) as connection:
        rows = connection.execute(
            """SELECT b.id block_id, b.legacy_id, b.chapter_title, b.global_index, b.source_text,
                      serial.final_translation serial_translation,
                      v4.status v4_status, v4.final_translation v4_translation,
                      v4.warnings_json
               FROM blocks b
               JOIN translation_versions v4
                 ON v4.block_id=b.id AND v4.pipeline='parallel_v4' AND v4.active=1
               LEFT JOIN translation_versions serial
                 ON serial.block_id=b.id AND serial.pipeline='serial_v3' AND serial.active=1
               WHERE b.source_edition_id=(SELECT id FROM source_editions WHERE active=1)
               ORDER BY b.global_index"""
        ).fetchall()
    if max_blocks is not None:
        rows = rows[:max_blocks]
    if not rows:
        raise ValueError("当前没有parallel_v4译文可供比较")
    lines = [
        "# parallel_v4 影子对照",
        "",
        "本文件仅用于人工验收，不参与翻译上下文或正式导出。",
        "",
    ]
    for row in rows:
        warnings = json.loads(row["warnings_json"] or "[]")
        external = database.baseline_for_block(row["block_id"], baseline_name)
        if external:
            baseline_label = external["document"]["name"]
            baseline_text = normalize_chinese_quote_style(external["text"])
            boundary_note = (
                "（该文本块在原书段落内部切分；外部基线显示相交的完整段落。）"
                if external["has_partial_boundary"]
                else ""
            )
        else:
            baseline_label = "serial_v3"
            baseline_text = normalize_chinese_quote_style(
                row["serial_translation"] or "（无可用基线译文）"
            )
            boundary_note = ""
        lines.extend(
            [
                f"## {row['legacy_id']} · {row['chapter_title']}",
                "",
                f"parallel_v4状态：`{row['v4_status']}`",
                "",
            ]
        )
        if warnings:
            lines.extend(["警告：", ""])
            lines.extend(f"- {warning}" for warning in warnings)
            lines.append("")
        lines.extend(
            [
                "### 原文",
                "",
                row["source_text"].strip(),
                "",
                f"### {baseline_label}",
                "",
                boundary_note,
                "" if not boundary_note else "",
                baseline_text.strip(),
                "",
                "### parallel_v4",
                "",
                normalize_chinese_quote_style(row["v4_translation"]).strip(),
                "",
            ]
        )
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path
