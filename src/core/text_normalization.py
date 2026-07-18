"""Deterministic normalization shared by translation and review surfaces."""

from __future__ import annotations

import re


_CORNER_QUOTES = str.maketrans(
    {"「": "“", "」": "”", "『": "‘", "』": "’", "«": "“", "»": "”"}
)


def normalize_chinese_quote_style(text: str) -> str:
    """统一中文译文引号，同时保留英文单词内部的撇号。"""
    normalized = (text or "").translate(_CORNER_QUOTES)
    normalized = re.sub(r'"([^"\n]*)"', r'“\1”', normalized)
    normalized = re.sub(
        r"(?<![\w])'([^'\n]+)'(?![\w])",
        r"‘\1’",
        normalized,
    )
    return normalized
