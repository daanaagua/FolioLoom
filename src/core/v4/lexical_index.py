"""Deterministic lexical candidate indexing with reversible source locations."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, replace
from typing import Dict, Iterable, List, Sequence

from .models import V4Block


WORD_RE = re.compile(
    r"[A-Za-z]+(?:[’'][A-Za-z]+)*(?:-[A-Za-z]+(?:[’'][A-Za-z]+)*)*|\d+(?:\.\d+)?"
)
SENTENCE_END_RE = re.compile(r"[.!?]+")
COORDINATORS = {"and", "or", "nor"}
CONNECTORS = COORDINATORS | {"of", "for", "the", "to", "de", "del", "la", "van", "von"}
GRAMMATICAL_FUNCTION_WORDS = {
    "a", "an", "the", "this", "that", "these", "those", "all", "any", "both",
    "each", "either", "every", "few", "many", "much", "neither", "no", "some",
    "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "ourselves",
    "you", "your", "yours", "yourself", "yourselves", "he", "him", "his", "himself",
    "she", "her", "hers", "herself", "it", "its", "itself", "they", "them", "their",
    "theirs", "themselves", "who", "whom", "whose", "what", "which",
    "about", "above", "after", "against", "along", "among", "around", "as", "at",
    "before", "below", "beside", "between", "by", "during", "for", "from", "in",
    "into", "of", "off", "on", "out", "over", "since", "through", "to", "under",
    "until", "up", "upon", "with", "without",
    "am", "are", "is", "was", "were", "be", "being", "been", "do", "does", "did",
    "done", "have", "has", "had", "can", "could", "may", "might", "must", "shall",
    "should", "will", "would",
    "and", "or", "but", "nor", "yet", "so", "if", "then", "else", "although",
    "because", "though", "while", "when", "where", "whether", "unless",
}
NUMBER_WORDS = {
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "hundred", "thousand", "million", "first", "second", "third",
}
UNIT_WORDS = {
    "watch", "watches", "chain", "chains", "pace", "paces", "cubit", "cubits",
    "league", "leagues", "mile", "miles", "year", "years", "century", "centuries",
    "day", "days", "hour", "hours", "minute", "minutes", "second", "seconds",
    "thousand", "million", "millennium", "millennia",
}
COMMON_WORDS = {
    "a", "an", "the", "i", "me", "my", "mine", "myself", "we", "us", "our",
    "ours", "ourselves", "you", "your", "yours", "yourself", "yourselves", "he",
    "him", "his", "himself", "she", "her", "hers", "herself", "it", "its", "itself",
    "they", "them", "their", "theirs", "themselves", "who", "whom", "whose",
    "what", "which", "where", "when", "why", "how", "and", "or", "but", "nor",
    "for", "yet", "so", "if", "then", "else", "as", "at", "by", "in", "of", "on",
    "to", "up", "out", "off", "from", "with", "without", "through", "during",
    "is", "am", "are", "was", "were", "be", "being", "been", "do", "does", "did",
    "done", "has", "have", "had", "can", "could", "may", "might", "must", "shall",
    "should", "will", "would", "not", "no", "yes", "all", "any", "both", "each",
    "either", "neither", "few", "many", "more", "most", "some", "such", "only",
    "own", "same", "too", "very", "just", "now", "here", "there", "thus", "later",
    "someone", "something", "everything", "nothing", "dont", "didnt", "isnt", "wasnt",
    "youre", "youve", "weve", "ive", "ill", "theyd", "hes", "shes",
    "about", "above", "after", "again", "against", "almost", "along", "already",
    "also", "although", "always", "among", "another", "around", "because", "before",
    "being", "below", "between", "both", "could", "every", "first", "found", "from",
    "great", "having", "however", "into", "itself", "might", "more", "most", "much",
    "must", "never", "nothing", "often", "other", "perhaps", "rather", "really",
    "seemed", "should", "since", "something", "still", "such", "than", "that", "their",
    "them", "themselves", "then", "there", "these", "they", "thing", "think", "those",
    "though", "through", "under", "until", "upon", "very", "what", "when", "where",
    "which", "while", "with", "without", "would", "your", "have", "were", "been",
    "will", "shall", "does", "did", "this", "only", "some", "once", "even", "ever",
    "here", "away", "down", "over", "back", "like", "made", "make", "said", "came",
    "come", "went", "looked", "asked", "told", "knew", "know", "thought", "felt",
    "eyes", "hand", "hands", "face", "head", "time", "long", "little", "large",
    "small", "young", "good", "same", "many", "enough", "each", "whole", "part",
    "place", "people", "world", "room", "door", "wall", "water", "light", "dark",
}


def normalize_punctuation(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    return value.translate(
        str.maketrans(
            {
                "’": "'", "‘": "'", "`": "'", "´": "'",
                "“": '"', "”": '"', "«": '"', "»": '"',
                "–": "-", "—": "-", "−": "-", "…": "...",
                "\u00a0": " ",
            }
        )
    )


def lexical_words(value: str) -> List[str]:
    normalized = normalize_punctuation(value)
    return [match.group(0) for match in WORD_RE.finditer(normalized)]


def lexical_key(value: str) -> str:
    words = []
    for word in lexical_words(value):
        normalized = normalize_punctuation(word).casefold()
        normalized = re.sub(r"'s$", "", normalized)
        words.append(normalized.replace("'", ""))
    return " ".join(words)


def simplified_text(value: str) -> str:
    """Return words with sentence boundaries represented only by periods."""
    normalized = normalize_punctuation(value)
    matches = list(WORD_RE.finditer(normalized))
    parts: List[str] = []
    previous_end = 0
    for match in matches:
        gap = normalized[previous_end:match.start()]
        if parts and SENTENCE_END_RE.search(gap) and parts[-1] != ".":
            parts.append(".")
        word = match.group(0)
        word = re.sub(r"[’']s$", "", word, flags=re.I)
        parts.append(word.replace("'", "").replace("’", ""))
        previous_end = match.end()
    return " ".join(parts)


@dataclass(frozen=True)
class ParagraphSpan:
    paragraph_id: str
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class LexicalCandidate:
    id: str
    block_id: str
    paragraph_id: str
    start_offset: int
    end_offset: int
    original_text: str
    normalized_text: str
    left_context: str
    right_context: str
    extraction_reason: str
    book_frequency: int
    score: int
    risk_flags: tuple[str, ...] = ()

    def model_payload(self) -> Dict[str, object]:
        context = " ".join(
            part for part in (self.left_context, self.normalized_text, self.right_context) if part
        )
        return {
            "candidate_id": self.id,
            "candidate": self.normalized_text,
            "context": context,
        }

    def storage_payload(self, *, selected: bool = False, model_status: str = "pending") -> Dict[str, object]:
        return {
            "id": self.id,
            "block_id": self.block_id,
            "paragraph_id": self.paragraph_id,
            "start_offset": self.start_offset,
            "end_offset": self.end_offset,
            "original_text": self.original_text,
            "normalized_text": self.normalized_text,
            "left_context": self.left_context,
            "right_context": self.right_context,
            "extraction_reason": self.extraction_reason,
            "book_frequency": self.book_frequency,
            "risk_flags_json": json.dumps(self.risk_flags, ensure_ascii=False),
            "selected": selected,
            "model_status": model_status,
        }


def paragraph_spans(source_text: str) -> List[ParagraphSpan]:
    spans: List[ParagraphSpan] = []
    for match in re.finditer(r"\S(?:.*?\S)?(?=\s*(?:\n\s*\n|\Z))", source_text, re.DOTALL):
        spans.append(
            ParagraphSpan(
                paragraph_id=f"P{len(spans):03d}",
                text=match.group(0),
                start=match.start(),
                end=match.end(),
            )
        )
    return spans


class LexicalCandidateExtractor:
    def __init__(
        self,
        blocks: Sequence[V4Block] = (),
        max_candidates: int = 80,
        context_words: int = 4,
    ):
        self.max_candidates = max(1, max_candidates)
        self.context_words = max(2, context_words)
        self.book_frequencies: Counter[str] = Counter()
        self.lowercase_frequencies: Counter[str] = Counter()
        self.capitalized_frequencies: Counter[str] = Counter()
        for block in blocks:
            for word in lexical_words(block.source_text):
                key = lexical_key(word)
                self.book_frequencies[key] += 1
                if word[0].isupper():
                    self.capitalized_frequencies[key] += 1
                else:
                    self.lowercase_frequencies[key] += 1

    @staticmethod
    def _candidate_id(block_id: str, paragraph_id: str, start: int, end: int) -> str:
        value = f"{block_id}:{paragraph_id}:{start}:{end}"
        return "cand_" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]

    def _context(self, paragraph: ParagraphSpan, start: int, end: int) -> tuple[str, str]:
        tokens = list(WORD_RE.finditer(paragraph.text))
        local_start = start - paragraph.start
        local_end = end - paragraph.start
        first = next((i for i, token in enumerate(tokens) if token.end() > local_start), 0)
        last = first
        while last < len(tokens) and tokens[last].start() < local_end:
            last += 1
        left_tokens = tokens[max(0, first - self.context_words):first]
        right_tokens = tokens[last:last + self.context_words]
        left_start = left_tokens[0].start() if left_tokens else local_start
        right_end = right_tokens[-1].end() if right_tokens else local_end
        left = simplified_text(paragraph.text[left_start:local_start])
        right = simplified_text(paragraph.text[local_end:right_end])
        return left, right

    def _make_candidate(
        self,
        block: V4Block,
        paragraph: ParagraphSpan,
        start: int,
        end: int,
        reason: str,
        score: int,
    ) -> LexicalCandidate | None:
        original = block.source_text[start:end].strip()
        normalized = simplified_text(original).replace(" .", ".").strip(" .")
        key = lexical_key(original)
        if not key or not normalized:
            return None
        left, right = self._context(paragraph, start, end)
        return LexicalCandidate(
            id=self._candidate_id(block.id, paragraph.paragraph_id, start, end),
            block_id=block.id,
            paragraph_id=paragraph.paragraph_id,
            start_offset=start,
            end_offset=end,
            original_text=original,
            normalized_text=normalized,
            left_context=left,
            right_context=right,
            extraction_reason=reason,
            book_frequency=int(self.book_frequencies.get(key, 1)),
            score=score,
        )

    @staticmethod
    def _mark_candidate_risks(
        candidates: Sequence[LexicalCandidate],
    ) -> List[LexicalCandidate]:
        flagged: List[LexicalCandidate] = []
        for candidate in candidates:
            flags = set(candidate.risk_flags)
            words = lexical_key(candidate.original_text).split()
            if any(word in COORDINATORS for word in words[1:-1]):
                flags.add("coordination")
            if any(
                other.paragraph_id == candidate.paragraph_id
                and other.id != candidate.id
                and (
                    (
                        other.start_offset <= candidate.start_offset
                        and candidate.end_offset <= other.end_offset
                    )
                    or (
                        candidate.start_offset <= other.start_offset
                        and other.end_offset <= candidate.end_offset
                    )
                )
                for other in candidates
            ):
                flags.add("span_competition")
            flagged.append(replace(candidate, risk_flags=tuple(sorted(flags))))
        return flagged

    def extract(self, block: V4Block) -> List[LexicalCandidate]:
        by_span: Dict[tuple[str, int, int, str], LexicalCandidate] = {}

        def retain(candidate: LexicalCandidate) -> None:
            candidate_key = (
                candidate.paragraph_id,
                candidate.start_offset,
                candidate.end_offset,
                lexical_key(candidate.original_text),
            )
            previous = by_span.get(candidate_key)
            if previous is None or candidate.score > previous.score:
                by_span[candidate_key] = candidate

        for paragraph in paragraph_spans(block.source_text):
            tokens = list(WORD_RE.finditer(paragraph.text))
            if (
                paragraph.paragraph_id == "P000"
                and len(tokens) <= 10
                and not SENTENCE_END_RE.search(paragraph.text)
            ):
                continue
            for index, token in enumerate(tokens):
                text = token.group(0)
                key = lexical_key(text)
                if not key:
                    continue
                absolute_start = paragraph.start + token.start()
                absolute_end = paragraph.start + token.end()
                is_capitalized = text[0].isupper()
                previous_gap = (
                    paragraph.text[:token.start()]
                    if index == 0
                    else paragraph.text[tokens[index - 1].end():token.start()]
                )
                sentence_initial = index == 0 or bool(SENTENCE_END_RE.search(previous_gap))
                capitalized_like_name = (
                    not sentence_initial
                    or self.lowercase_frequencies.get(key, 0) == 0
                    or self.book_frequencies.get(key, 0) <= 20
                    or self.capitalized_frequencies.get(key, 0)
                    >= self.lowercase_frequencies.get(key, 0) * 3
                )
                if sentence_initial and re.search(r"(?:ly|ing|ed)$", key):
                    capitalized_like_name = False
                if is_capitalized and key not in COMMON_WORDS and capitalized_like_name:
                    candidate = self._make_candidate(
                        block, paragraph, absolute_start, absolute_end, "capitalized", 90
                    )
                    if candidate:
                        retain(candidate)

                if is_capitalized and key not in COMMON_WORDS and capitalized_like_name:
                    last = index + 1
                    content_count = 1
                    while last < len(tokens) and last - index < 7:
                        gap = paragraph.text[tokens[last - 1].end():tokens[last].start()]
                        if SENTENCE_END_RE.search(gap) or re.search(r"[,;:()\[\]{}\"“”«»]", gap):
                            break
                        next_text = tokens[last].group(0)
                        next_key = lexical_key(next_text)
                        if (
                            next_text[0].isupper()
                            and next_key not in GRAMMATICAL_FUNCTION_WORDS
                        ):
                            content_count += 1
                            last += 1
                            continue
                        if (
                            next_key in CONNECTORS
                            and last + 1 < len(tokens)
                            and tokens[last + 1].group(0)[0].isupper()
                        ):
                            last += 1
                            continue
                        break
                    if content_count >= 2:
                        phrase_end = paragraph.start + tokens[last - 1].end()
                        candidate = self._make_candidate(
                            block, paragraph, absolute_start, phrase_end, "capitalized_phrase", 110
                        )
                        if candidate:
                            retain(candidate)

                frequency = int(self.book_frequencies.get(key, 1))
                word_length = len(key.replace(" ", ""))
                unusual = (
                    "-" in text
                    or word_length >= 8
                    or (frequency >= 2 and word_length >= 5)
                )
                if re.search(r"(?:ed|ing|ly)$", key):
                    unusual = False
                if not is_capitalized and key not in COMMON_WORDS and unusual:
                    score = 35 + min(frequency, 10) + min(word_length, 10)
                    candidate = self._make_candidate(
                        block, paragraph, absolute_start, absolute_end, "rare_or_repeated", score
                    )
                    if candidate:
                        retain(candidate)

                if (
                    key in NUMBER_WORDS
                    and index + 1 < len(tokens)
                    and lexical_key(tokens[index + 1].group(0)) in UNIT_WORDS
                ):
                    phrase_end = paragraph.start + tokens[index + 1].end()
                    candidate = self._make_candidate(
                        block, paragraph, absolute_start, phrase_end, "number_or_unit", 65
                    )
                    if candidate:
                        retain(candidate)

        ordered = sorted(
            by_span.values(),
            key=lambda item: (-item.score, item.start_offset, -len(item.original_text)),
        )
        return self._mark_candidate_risks(ordered[: self.max_candidates])
