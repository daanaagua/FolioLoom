"""不可变源载荷与 canonical source 清单。"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Iterable, Mapping

from .preprocessor import SourceDocument


SOURCE_LEDGER_SCHEMA = "v5-source-ledger-1"
SUPPORTED_SOURCE_LANGUAGES = frozenset({"en", "fr", "de", "es", "ru", "ja", "und"})
ALLOWED_EXCLUDED_RAW_POLICIES = frozenset(
    {
        "UTF8_BOM",
        "UTF16_LE_BOM",
        "UTF16_BE_BOM",
        "UTF32_LE_BOM",
        "UTF32_BE_BOM",
        "EPUB_NON_SPINE_DATA",
        "DOCX_NON_DOCUMENT_DATA",
    }
)


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def normalize_source_language(value: str) -> str:
    """Return the supported primary BCP-47 source-language subtag."""
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", value
    ):
        raise ValueError(f"invalid source language: {value!r}")
    primary = value.split("-", 1)[0].lower()
    if primary not in SUPPORTED_SOURCE_LANGUAGES:
        raise ValueError(f"unsupported source language: {value!r}")
    return primary


def _validate_canonical_segments(
    segments: Iterable[Mapping[str, object]], canonical_chars: int
) -> list[dict]:
    checked: list[dict] = []
    cursor = 0
    for index, original in enumerate(segments):
        segment = dict(original)
        start = segment.get("canonical_start")
        end = segment.get("canonical_end")
        if not isinstance(start, int) or isinstance(start, bool):
            raise ValueError(f"canonical segment {index} has invalid start")
        if not isinstance(end, int) or isinstance(end, bool):
            raise ValueError(f"canonical segment {index} has invalid end")
        if start != cursor:
            raise ValueError(
                f"canonical segments must be contiguous: expected {cursor}, got {start}"
            )
        if end < start or end > canonical_chars:
            raise ValueError(f"canonical segment {index} is out of bounds")
        for field in ("origin_kind", "origin_ref", "transformation"):
            if not isinstance(segment.get(field), str) or not segment[field]:
                raise ValueError(f"canonical segment {index} has invalid {field}")
        checked.append(segment)
        cursor = end

    if cursor != canonical_chars:
        raise ValueError(
            f"canonical segments must cover [0, {canonical_chars}), stopped at {cursor}"
        )
    return checked


def _validate_excluded_raw_ranges(
    ranges: Iterable[Mapping[str, object]], raw_size: int
) -> list[dict]:
    checked: list[dict] = []
    previous_end = 0
    for index, original in enumerate(ranges):
        item = dict(original)
        start = item.get("raw_start")
        end = item.get("raw_end")
        policy = item.get("policy")
        if policy not in ALLOWED_EXCLUDED_RAW_POLICIES:
            raise ValueError(f"unknown excluded raw range policy: {policy!r}")
        if not isinstance(start, int) or isinstance(start, bool):
            raise ValueError(f"excluded raw range {index} has invalid start")
        if not isinstance(end, int) or isinstance(end, bool):
            raise ValueError(f"excluded raw range {index} has invalid end")
        if start < previous_end or end <= start or end > raw_size:
            raise ValueError(f"excluded raw range {index} is overlapping or out of bounds")
        checked.append(item)
        previous_end = end
    return checked


def _write_immutable(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as target:
        target.write(payload)


def create_source_ledger(
    source: Path,
    project_dir: Path,
    document: SourceDocument,
    source_language: str = "en",
) -> dict:
    """保存原始字节、canonical source 和经验证的 provenance 清单。"""
    source = Path(source)
    project_dir = Path(project_dir)
    raw = source.read_bytes()
    if (
        document.raw_size is not None
        and document.raw_size != len(raw)
    ) or (
        document.raw_sha256 is not None
        and document.raw_sha256 != _sha256(raw)
    ):
        raise ValueError("source changed after document load")
    canonical = document.text.replace("\r\n", "\n").replace("\r", "\n")
    canonical_bytes = canonical.encode("utf-8")
    source_language = normalize_source_language(source_language)

    segments = _validate_canonical_segments(
        document.canonical_segments, len(canonical)
    )
    excluded_ranges = _validate_excluded_raw_ranges(
        document.excluded_raw_ranges, len(raw)
    )

    raw_target = project_dir / "source" / f"original{source.suffix.lower()}"
    canonical_target = project_dir / "source.txt"
    manifest_target = project_dir / "source_manifest.json"
    raw_relative = raw_target.relative_to(project_dir).as_posix()

    manifest = {
        "schema_version": SOURCE_LEDGER_SCHEMA,
        "coordinate_unit": "unicode_scalar",
        "raw_path": raw_relative,
        "raw_size": len(raw),
        "raw_sha256": _sha256(raw),
        "source_format": document.source_format,
        "encoding": document.encoding,
        "extractor": document.extractor,
        "sourceLanguage": source_language,
        "canonical_path": "source.txt",
        "canonical_chars": len(canonical),
        "canonical_sha256": _sha256(canonical_bytes),
        "canonical_segments": segments,
        "excluded_raw_ranges": excluded_ranges,
    }
    manifest_bytes = json.dumps(
        manifest, ensure_ascii=False, indent=2
    ).encode("utf-8")

    _write_immutable(raw_target, raw)
    _write_immutable(canonical_target, canonical_bytes)
    _write_immutable(manifest_target, manifest_bytes)
    return manifest
