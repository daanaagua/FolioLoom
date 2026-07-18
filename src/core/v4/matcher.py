"""Linear multi-pattern matching for frozen lexeme/concept rendering state."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import deque
from copy import deepcopy
from dataclasses import dataclass
from threading import RLock
from typing import Any, Callable, Dict, Iterable, Iterator, Mapping, Sequence, overload


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def _word_character(value: str) -> bool:
    return value == "_" or value.isalnum()


def _is_grapheme_extend(value: str) -> bool:
    codepoint = ord(value)
    return (
        unicodedata.category(value).startswith("M")
        or 0xFE00 <= codepoint <= 0xFE0F
        or 0xE0100 <= codepoint <= 0xE01EF
        or 0x1F3FB <= codepoint <= 0x1F3FF
    )


def _hangul_jamo_class(value: str) -> str:
    codepoint = ord(value)
    if 0xAC00 <= codepoint <= 0xD7A3:
        return "LV" if (codepoint - 0xAC00) % 28 == 0 else "LVT"
    if 0x1100 <= codepoint <= 0x115F or 0xA960 <= codepoint <= 0xA97C:
        return "L"
    if 0x1160 <= codepoint <= 0x11A7 or 0xD7B0 <= codepoint <= 0xD7C6:
        return "V"
    if 0x11A8 <= codepoint <= 0x11FF or 0xD7CB <= codepoint <= 0xD7FB:
        return "T"
    return ""


def _grapheme_clusters(text: str) -> Iterator[tuple[int, int]]:
    index = 0
    while index < len(text):
        start = index
        previous_hangul = _hangul_jamo_class(text[index])
        index += 1
        while index < len(text):
            value = text[index]
            current_hangul = _hangul_jamo_class(value)
            if _is_grapheme_extend(value):
                index += 1
                continue
            if value == "\u200d" and index + 1 < len(text):
                index += 2
                previous_hangul = _hangul_jamo_class(text[index - 1])
                continue
            if (
                (
                    previous_hangul == "L"
                    and current_hangul in {"L", "V", "LV", "LVT"}
                )
                or (
                    previous_hangul in {"LV", "V"}
                    and current_hangul in {"V", "T"}
                )
                or (
                    previous_hangul in {"LVT", "T"}
                    and current_hangul == "T"
                )
            ):
                previous_hangul = current_hangul
                index += 1
                continue
            break
        yield start, index


def _normalized_offsets(text: str) -> tuple[str, list[int], list[int]]:
    """Normalize while retaining half-open offsets into the original string."""

    parts: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for start, end in _grapheme_clusters(text):
        normalized = _normalized(text[start:end])
        parts.append(normalized)
        starts.extend([start] * len(normalized))
        ends.extend([end] * len(normalized))
    return "".join(parts), starts, ends


class AhoConceptMatcher:
    """A compact Aho-Corasick matcher kept under its legacy public name."""

    def __init__(self, forms: Mapping[str, Iterable[str]]):
        self._next: list[Dict[str, int]] = [{}]
        self._failure: list[int] = [0]
        self._outputs: list[list[tuple[str, tuple[str, ...]]]] = [[]]
        normalized_forms: Dict[str, set[str]] = {}
        for raw_form, identity_ids in forms.items():
            form = _normalized(raw_form)
            ids = {str(value) for value in identity_ids if str(value)}
            if form and ids:
                normalized_forms.setdefault(form, set()).update(ids)
        for form, identity_ids in sorted(normalized_forms.items()):
            ids = tuple(sorted(identity_ids))
            state = 0
            for character in form:
                child = self._next[state].get(character)
                if child is None:
                    child = len(self._next)
                    self._next[state][character] = child
                    self._next.append({})
                    self._failure.append(0)
                    self._outputs.append([])
                state = child
            self._outputs[state].append((form, ids))
        self._build_failures()

    @classmethod
    def from_snapshot(cls, snapshot: Sequence[Mapping[str, Any]]):
        forms: Dict[str, set[str]] = {}
        for item in snapshot:
            identity_id = str(item.get("lexeme_id") or item.get("id") or "")
            if not identity_id:
                continue
            for value in item.get("forms", []) or []:
                form = str(value).strip()
                if form:
                    forms.setdefault(form, set()).add(identity_id)
        return cls(forms)

    def _build_failures(self) -> None:
        queue: deque[int] = deque()
        for child in self._next[0].values():
            queue.append(child)
        while queue:
            state = queue.popleft()
            for character, child in self._next[state].items():
                queue.append(child)
                fallback = self._failure[state]
                while fallback and character not in self._next[fallback]:
                    fallback = self._failure[fallback]
                self._failure[child] = self._next[fallback].get(character, 0)
                inherited = self._outputs[self._failure[child]]
                if inherited:
                    self._outputs[child].extend(inherited)

    @staticmethod
    def _has_word_boundaries(text: str, start: int, end: int) -> bool:
        matched = text[start:end]
        if not matched:
            return False
        if _word_character(matched[0]) and start > 0 and _word_character(text[start - 1]):
            return False
        if _word_character(matched[-1]) and end < len(text) and _word_character(text[end]):
            return False
        return True

    def iter_matches(self, text: str) -> tuple[tuple[str, str, int, int], ...]:
        normalized, starts, ends = _normalized_offsets(text)
        state = 0
        found: set[tuple[str, int, int]] = set()
        for index, character in enumerate(normalized):
            while state and character not in self._next[state]:
                state = self._failure[state]
            state = self._next[state].get(character, 0)
            for form, identity_ids in self._outputs[state]:
                normalized_end = index + 1
                normalized_start = normalized_end - len(form)
                if normalized_start < 0 or not starts:
                    continue
                if (
                    normalized_start > 0
                    and starts[normalized_start] == starts[normalized_start - 1]
                ):
                    continue
                if (
                    normalized_end < len(starts)
                    and starts[normalized_end] == starts[normalized_end - 1]
                ):
                    continue
                start = starts[normalized_start]
                end = ends[normalized_end - 1]
                if not self._has_word_boundaries(text, start, end):
                    continue
                for identity_id in identity_ids:
                    found.add((identity_id, start, end))
        longest: Dict[tuple[str, int], int] = {}
        for identity_id, start, end in found:
            key = (identity_id, start)
            longest[key] = max(end, longest.get(key, start))
        return tuple(
            (identity_id, text[start:end], start, end)
            for (identity_id, start), end in sorted(
                longest.items(), key=lambda item: (item[0][1], item[1], item[0][0])
            )
        )

    def match(self, text: str) -> tuple[str, ...]:
        return tuple(sorted({item[0] for item in self.iter_matches(text)}))

    def scan(self, text: str) -> tuple[str, ...]:
        return self.match(text)


class MultiFormMatcher:
    """Compiled multi-form matcher for one-pass occurrence backfills."""

    def __init__(self, matcher: AhoConceptMatcher):
        self._matcher = matcher

    @classmethod
    def compile(
        cls,
        forms: Mapping[str, Iterable[str] | str],
    ) -> "MultiFormMatcher":
        if not isinstance(forms, Mapping):
            raise TypeError("forms must be a mapping from source form to lexeme ids")
        compiled: Dict[str, tuple[str, ...]] = {}
        for raw_form, raw_ids in forms.items():
            form = str(raw_form).strip()
            if not form:
                continue
            values = (raw_ids,) if isinstance(raw_ids, str) else tuple(raw_ids)
            identity_ids = tuple(
                sorted({str(value).strip() for value in values if str(value).strip()})
            )
            if identity_ids:
                compiled[form] = identity_ids
        return cls(AhoConceptMatcher(compiled))

    def finditer(self, text: str) -> Iterator[tuple[str, str, int, int]]:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        yield from self._matcher.iter_matches(text)


@dataclass(frozen=True)
class MatchedRendering:
    lexeme_id: str
    concept_id: str | None
    matched_form: str
    start_offset: int
    end_offset: int
    rendered_target: str
    applied_rule_ids: tuple[str, ...]
    dependency_fingerprint: str


@dataclass(frozen=True)
class _Candidate:
    layer: int
    target: str
    subject_type: str
    subject_id: str
    source_field: str
    priority: int = -(10**9)
    status: str = ""
    locked: bool = False
    created_version: int = 0
    rule_id: str = ""
    condition: Mapping[str, Any] | None = None

    @property
    def sort_key(self) -> tuple[Any, ...]:
        status_rank = {
            "verified": 3,
            "working": 2,
            "legacy_provisional": 1,
            "provisional": 1,
        }.get(self.status, 0)
        return (
            self.layer,
            -self.priority,
            -int(self.locked),
            -status_rank,
            -self.created_version,
            self.rule_id,
            self.subject_type,
            self.subject_id,
            self.source_field,
            self.target,
        )


class FrozenRenderIndex(Sequence[Mapping[str, Any]]):
    """One immutable-by-copy, compiled rendering index for a translation batch."""

    _cache_lock = RLock()
    _cache: Dict[str, "FrozenRenderIndex"] = {}
    _max_entries = 8
    _indexable_condition_fields = (
        "mention_id",
        "block_id",
        "paragraph_id",
        "paragraph",
        "paragraph_index",
        "discourse_function",
        "start_offset",
        "end_offset",
        "occurrence_offset",
        "speaker",
        "speaker_id",
        "thread",
        "thread_id",
        "concept_id",
        "lexeme_id",
        "source_form",
        "matched_form",
        "occurrence",
    )

    def __init__(
        self,
        snapshot: tuple[Dict[str, Any], ...],
        signature: str,
        by_id: Dict[str, Dict[str, Any]],
        matcher: AhoConceptMatcher,
    ):
        self._snapshot = snapshot
        self.signature = signature
        self._by_id = by_id
        self._matcher = matcher
        self._rule_buckets: Dict[
            tuple[str, str],
            Dict[tuple[tuple[str, str], ...], tuple[Mapping[str, Any], ...]],
        ] = {}
        self._rule_keysets: Dict[tuple[str, str], tuple[tuple[str, ...], ...]] = {}
        self._generic_rules: Dict[
            tuple[str, str], tuple[Mapping[str, Any], ...]
        ] = {}
        self._redirects: Dict[str, str] = {}
        for lexeme in snapshot:
            for concept in lexeme.get("concepts", []) or []:
                concept_id = str(concept.get("id") or "")
                if not concept_id:
                    continue
                self._redirects[concept_id] = concept_id
                for source_id in concept.get("redirect_source_ids", []) or []:
                    if str(source_id):
                        self._redirects[str(source_id)] = concept_id
        self._compile_rule_buckets(snapshot)

    @staticmethod
    def _scalar_bucket_value(value: Any) -> str | None:
        if value is None or isinstance(value, (str, int, float, bool)):
            return json.dumps(
                [type(value).__name__, value],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        return None

    @classmethod
    def _condition_bucket_entries(
        cls, condition: Mapping[str, Any]
    ) -> tuple[tuple[tuple[str, str], ...], ...]:
        if any(key not in cls._indexable_condition_fields for key in condition):
            return ()
        ordered_keys = [
            key for key in cls._indexable_condition_fields if key in condition
        ]
        combinations: list[tuple[tuple[str, str], ...]] = [()]
        for key in ordered_keys:
            expected = condition[key]
            values = expected if isinstance(expected, list) else [expected]
            encoded = [cls._scalar_bucket_value(value) for value in values]
            if not encoded or any(value is None for value in encoded):
                return ()
            combinations = [
                current + ((key, str(value)),)
                for current in combinations
                for value in encoded
            ]
            if len(combinations) > 256:
                return ()
        return tuple(combinations)

    @staticmethod
    def _rule_layer(rule: Mapping[str, Any], subject_type: str) -> int:
        condition = rule.get("condition") or {}
        locked = bool(rule.get("locked"))
        status = str(rule.get("status") or "")
        if locked and condition:
            return 1
        if subject_type == "concept":
            return 2 if locked or status == "verified" else 4
        return 3 if locked or status == "verified" else 5

    @classmethod
    def _best_unconditional_rules(
        cls,
        rules: Sequence[Mapping[str, Any]],
        subject_type: str,
    ) -> tuple[Mapping[str, Any], ...]:
        status_rank = {
            "verified": 3,
            "working": 2,
            "legacy_provisional": 1,
            "provisional": 1,
        }
        best: Dict[int, tuple[tuple[Any, ...], Mapping[str, Any]]] = {}
        for rule in rules:
            layer = cls._rule_layer(rule, subject_type)
            rank = (
                -int(rule.get("priority") or 0),
                -int(bool(rule.get("locked"))),
                -status_rank.get(str(rule.get("status") or ""), 0),
                -int(rule.get("created_version") or 0),
                str(rule.get("id") or ""),
                str(rule.get("target") or ""),
            )
            if layer not in best or rank < best[layer][0]:
                best[layer] = (rank, rule)
        return tuple(best[layer][1] for layer in sorted(best))

    def _compile_rule_buckets(
        self, snapshot: Sequence[Mapping[str, Any]]
    ) -> None:
        subjects: Dict[tuple[str, str], Sequence[Mapping[str, Any]]] = {}
        for lexeme in snapshot:
            lexeme_id = str(lexeme.get("lexeme_id") or lexeme.get("id") or "")
            if lexeme_id:
                subjects[("lexeme", lexeme_id)] = list(
                    lexeme.get("lexeme_rules", lexeme.get("rules", [])) or []
                )
            for concept in lexeme.get("concepts", []) or []:
                concept_id = str(concept.get("id") or "")
                if concept_id and ("concept", concept_id) not in subjects:
                    subjects[("concept", concept_id)] = list(
                        concept.get("rules", []) or []
                    )
        for subject_key, rules in subjects.items():
            buckets: Dict[
                tuple[tuple[str, str], ...], list[Mapping[str, Any]]
            ] = {}
            unconditional: list[Mapping[str, Any]] = []
            complex_generic: list[Mapping[str, Any]] = []
            keysets: set[tuple[str, ...]] = set()
            for rule in rules:
                condition = rule.get("condition") or {}
                if not condition:
                    unconditional.append(rule)
                    continue
                if not isinstance(condition, Mapping):
                    continue
                if any(
                    key not in self._indexable_condition_fields
                    for key in condition
                ):
                    continue
                entries = self._condition_bucket_entries(condition)
                if not entries:
                    complex_generic.append(rule)
                    continue
                for entry in entries:
                    keysets.add(tuple(key for key, _value in entry))
                    buckets.setdefault(entry, []).append(rule)
            self._rule_buckets[subject_key] = {
                key: tuple(value) for key, value in buckets.items()
            }
            self._rule_keysets[subject_key] = tuple(sorted(keysets))
            ranked_complex = sorted(
                complex_generic,
                key=lambda rule: (
                    self._rule_layer(rule, subject_key[0]),
                    -int(rule.get("priority") or 0),
                    -int(bool(rule.get("locked"))),
                    str(rule.get("id") or ""),
                ),
            )[:16]
            self._generic_rules[subject_key] = (
                self._best_unconditional_rules(unconditional, subject_key[0])
                + tuple(ranked_complex)
            )

    def _rules_for_context(
        self,
        subject: Mapping[str, Any],
        subject_type: str,
        context: Mapping[str, Any],
    ) -> tuple[Mapping[str, Any], ...]:
        subject_id = str(
            subject.get("lexeme_id") or subject.get("id") or ""
            if subject_type == "lexeme"
            else subject.get("id") or ""
        )
        subject_key = (subject_type, subject_id)
        selected: list[Mapping[str, Any]] = list(
            self._generic_rules.get(subject_key, ())
        )
        seen = {id(rule) for rule in selected}
        buckets = self._rule_buckets.get(subject_key, {})
        for keyset in self._rule_keysets.get(subject_key, ()):
            entry: list[tuple[str, str]] = []
            for key in keyset:
                if key not in context:
                    entry = []
                    break
                encoded = self._scalar_bucket_value(context[key])
                if encoded is None:
                    entry = []
                    break
                entry.append((key, encoded))
            if not entry:
                continue
            for rule in buckets.get(tuple(entry), ()):
                if id(rule) not in seen:
                    seen.add(id(rule))
                    selected.append(rule)
        return tuple(selected)

    @staticmethod
    def _deep_snapshot(
        snapshot: Sequence[Mapping[str, Any]],
    ) -> tuple[Dict[str, Any], ...]:
        return tuple(deepcopy(dict(item)) for item in snapshot)

    @staticmethod
    def _build_map(
        snapshot: Sequence[Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        return {
            str(item.get("lexeme_id") or item.get("id") or ""): item
            for item in snapshot
            if str(item.get("lexeme_id") or item.get("id") or "")
        }

    @staticmethod
    def _build_matcher(snapshot: Sequence[Mapping[str, Any]]) -> AhoConceptMatcher:
        return AhoConceptMatcher.from_snapshot(snapshot)

    @classmethod
    def compile(
        cls,
        snapshot: Sequence[Mapping[str, Any]],
        signature_builder: Callable[[Sequence[Dict[str, Any]]], str],
    ) -> "FrozenRenderIndex":
        frozen = cls._deep_snapshot(snapshot)
        signature = signature_builder(frozen)
        with cls._cache_lock:
            cached = cls._cache.get(signature)
            if cached is not None:
                return cached
        compiled = cls(
            frozen,
            signature,
            cls._build_map(frozen),
            cls._build_matcher(frozen),
        )
        with cls._cache_lock:
            existing = cls._cache.setdefault(signature, compiled)
            while len(cls._cache) > cls._max_entries:
                cls._cache.pop(next(iter(cls._cache)))
            return existing

    @classmethod
    def clear_cache(cls) -> None:
        with cls._cache_lock:
            cls._cache.clear()

    def get_lexeme(self, lexeme_id: str) -> Dict[str, Any] | None:
        item = self._by_id.get(str(lexeme_id))
        return deepcopy(item) if item is not None else None

    @staticmethod
    def _context_value_matches(expected: Any, actual: Any) -> bool:
        if isinstance(expected, list):
            return any(FrozenRenderIndex._context_value_matches(item, actual) for item in expected)
        if isinstance(expected, Mapping):
            if not isinstance(actual, Mapping):
                return False
            return all(
                key in actual
                and FrozenRenderIndex._context_value_matches(value, actual[key])
                for key, value in expected.items()
            )
        return actual == expected

    @classmethod
    def _condition_matches(
        cls, condition: Mapping[str, Any], context: Mapping[str, Any]
    ) -> bool:
        if not condition:
            return True
        for key, expected in condition.items():
            if key not in context:
                return False
            if not cls._context_value_matches(expected, context[key]):
                return False
        return True

    @staticmethod
    def _explicit_concept_id(
        concept_id: str | None,
        mention: Mapping[str, Any] | str | int | None,
        concept: Mapping[str, Any] | str | None,
    ) -> str | None:
        candidate = concept_id
        if isinstance(concept, Mapping):
            candidate = str(concept.get("concept_id") or concept.get("id") or candidate or "")
            if concept.get("reliable") is False or concept.get("status") == "uncertain":
                return None
        elif concept is not None:
            candidate = str(concept)
        if isinstance(mention, Mapping):
            if (
                mention.get("reliable") is False
                or mention.get("status") == "uncertain"
                or mention.get("role") == "uncertain"
                or float(mention.get("confidence", 1.0) or 0.0) < 0.8
            ):
                return None
            candidate = str(mention.get("concept_id") or candidate or "")
        return str(candidate).strip() if candidate else None

    def _select_concept(
        self,
        lexeme: Mapping[str, Any],
        concept_id: str | None,
        mention: Mapping[str, Any] | str | int | None,
        concept: Mapping[str, Any] | str | None,
    ) -> Mapping[str, Any] | None:
        concepts = list(lexeme.get("concepts", []) or [])
        explicit = self._explicit_concept_id(concept_id, mention, concept)
        if explicit:
            canonical = self._redirects.get(explicit, explicit)
            for item in concepts:
                if (
                    str(item.get("id") or "") == canonical
                    and bool(item.get("binding_reliable"))
                    and str(item.get("binding_role") or "") != "uncertain"
                ):
                    return item
            return None
        reliable = [
            item
            for item in concepts
            if bool(item.get("binding_reliable"))
            and str(item.get("binding_role") or "") != "uncertain"
        ]
        return reliable[0] if len(reliable) == 1 else None

    @staticmethod
    def _target_candidates(
        subject: Mapping[str, Any], subject_type: str
    ) -> list[_Candidate]:
        subject_id = str(
            subject.get("lexeme_id") or subject.get("id") or ""
            if subject_type == "lexeme"
            else subject.get("id") or ""
        )
        status = str(subject.get("status") or "")
        locked = bool(subject.get("locked"))
        created_version = int(subject.get("created_version") or 0)
        verified = str(subject.get("verified_target") or "").strip()
        working = str(subject.get("working_target") or "").strip()
        default = str(subject.get("default_target") or "").strip()
        candidates: list[_Candidate] = []
        if subject_type == "concept":
            if verified:
                candidates.append(
                    _Candidate(2, verified, subject_type, subject_id, "verified_target", status=status, locked=locked, created_version=created_version)
                )
            elif (locked or status == "verified") and default:
                candidates.append(
                    _Candidate(2, default, subject_type, subject_id, "default_target", status=status, locked=locked, created_version=created_version)
                )
            if working:
                candidates.append(
                    _Candidate(4, working, subject_type, subject_id, "working_target", status=status, locked=locked, created_version=created_version)
                )
        else:
            if verified:
                candidates.append(
                    _Candidate(3, verified, subject_type, subject_id, "verified_target", status=status, locked=locked, created_version=created_version)
                )
            elif locked and default:
                candidates.append(
                    _Candidate(3, default, subject_type, subject_id, "default_target", status=status, locked=locked, created_version=created_version)
                )
            if working:
                candidates.append(
                    _Candidate(5, working, subject_type, subject_id, "working_target", status=status, locked=locked, created_version=created_version)
                )
            elif default:
                candidates.append(
                    _Candidate(5, default, subject_type, subject_id, "default_target", status=status, locked=locked, created_version=created_version)
                )
        return candidates

    def _rule_candidates(
        self,
        subject: Mapping[str, Any],
        subject_type: str,
        context: Mapping[str, Any],
    ) -> list[_Candidate]:
        subject_id = str(
            subject.get("lexeme_id") or subject.get("id") or ""
            if subject_type == "lexeme"
            else subject.get("id") or ""
        )
        candidates: list[_Candidate] = []
        for rule in self._rules_for_context(subject, subject_type, context):
            owner_type = str(rule.get("subject_type") or subject_type)
            if owner_type != subject_type:
                continue
            target = str(rule.get("target") or "").strip()
            condition = rule.get("condition") or {}
            if not target or not isinstance(condition, Mapping):
                continue
            if not self._condition_matches(condition, context):
                continue
            locked = bool(rule.get("locked"))
            status = str(rule.get("status") or "")
            if locked and condition:
                layer = 1
            elif subject_type == "concept":
                layer = 2 if locked or status == "verified" else 4
            else:
                layer = 3 if locked or status == "verified" else 5
            candidates.append(
                _Candidate(
                    layer,
                    target,
                    subject_type,
                    subject_id,
                    "rule",
                    priority=int(rule.get("priority") or 0),
                    status=status,
                    locked=locked,
                    created_version=int(rule.get("created_version") or 0),
                    rule_id=str(rule.get("id") or ""),
                    condition=deepcopy(dict(condition)),
                )
            )
        return candidates

    @staticmethod
    def _fingerprint(
        lexeme_id: str,
        concept_id: str | None,
        winner: _Candidate | None,
    ) -> str:
        payload: Dict[str, Any] = {
            "lexeme_id": lexeme_id,
            "layer": winner.layer if winner else 6,
        }
        if winner is not None:
            if winner.subject_type == "concept":
                payload["concept_id"] = concept_id or winner.subject_id
            payload["winner"] = {
                "subject_type": winner.subject_type,
                "subject_id": winner.subject_id,
                "target": winner.target,
                "rule_id": winner.rule_id,
                "condition": deepcopy(winner.condition or {}),
                "priority": winner.priority,
                "locked": winner.locked,
            }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def matched_renderings(
        self,
        text: str,
        *,
        block: Mapping[str, Any] | str | None = None,
        block_id: str | None = None,
        paragraph: Mapping[str, Any] | str | None = None,
        paragraph_id: str | None = None,
        paragraph_index: int | None = None,
        speaker: Mapping[str, Any] | str | None = None,
        speaker_id: str | None = None,
        thread: Mapping[str, Any] | str | None = None,
        thread_id: str | None = None,
        mention: Mapping[str, Any] | str | int | None = None,
        mention_context: Mapping[str, Any] | str | int | None = None,
        concept_id: str | None = None,
        concept: Mapping[str, Any] | str | None = None,
        concept_context: Mapping[str, Any] | str | None = None,
        context: Mapping[str, Any] | str | None = None,
        occurrence_contexts: Sequence[Mapping[str, Any]] | None = None,
    ) -> list[MatchedRendering]:
        common: Dict[str, Any] = {}
        if isinstance(context, Mapping):
            common.update(context)
        elif context is not None:
            common["context"] = context
        if block is not None:
            common["block"] = block
            if isinstance(block, Mapping):
                for key, value in block.items():
                    common.setdefault(str(key), value)
                block_id = str(block.get("block_id") or block.get("id") or block_id or "")
            else:
                block_id = str(block)
        if paragraph is not None:
            common["paragraph"] = paragraph
            if isinstance(paragraph, Mapping):
                for key, value in paragraph.items():
                    common.setdefault(str(key), value)
                paragraph_id = str(
                    paragraph.get("paragraph_id") or paragraph.get("id") or paragraph_id or ""
                )
                if paragraph_index is None and paragraph.get("index") is not None:
                    paragraph_index = int(paragraph["index"])
            else:
                paragraph_id = str(paragraph)
        if isinstance(speaker, Mapping):
            common["speaker"] = speaker
            for key, value in speaker.items():
                common.setdefault(f"speaker_{key}", value)
            speaker_id = str(speaker.get("speaker_id") or speaker.get("id") or speaker_id or "")
        if isinstance(thread, Mapping):
            common["thread"] = thread
            for key, value in thread.items():
                common.setdefault(f"thread_{key}", value)
            thread_id = str(thread.get("thread_id") or thread.get("id") or thread_id or "")
        mention = mention if mention is not None else mention_context
        concept = concept if concept is not None else concept_context
        for key, value in (
            ("block_id", block_id),
            ("paragraph_id", paragraph_id),
            ("paragraph", paragraph_id),
            ("paragraph_index", paragraph_index),
            ("speaker", speaker if not isinstance(speaker, Mapping) else None),
            ("speaker_id", speaker_id),
            ("thread", thread if not isinstance(thread, Mapping) else None),
            ("thread_id", thread_id),
        ):
            if value is not None:
                common[key] = value
        if isinstance(mention, Mapping):
            for key, value in mention.items():
                common.setdefault(str(key), value)
            if "id" in mention:
                common.setdefault("mention_id", mention["id"])
        elif mention is not None:
            common["mention_id"] = mention

        matches: list[MatchedRendering] = []
        for lexeme_id, matched_form, start, end in self._matcher.iter_matches(text):
            lexeme = self._by_id.get(lexeme_id)
            if lexeme is None:
                continue
            occurrence_context = dict(common)
            specific_context: Mapping[str, Any] | None = None
            exact_contexts = [
                item
                for item in occurrence_contexts or ()
                if str(item.get("lexeme_id") or "") == lexeme_id
                and item.get("start_offset") is not None
                and item.get("end_offset") is not None
                and int(item["start_offset"]) == start
                and int(item["end_offset"]) == end
            ]
            if exact_contexts:
                specific_context = exact_contexts[0]
            else:
                form_contexts = [
                    item
                    for item in occurrence_contexts or ()
                    if str(item.get("lexeme_id") or "") == lexeme_id
                    and item.get("start_offset") is None
                    and _normalized(str(item.get("source_form") or ""))
                    == _normalized(matched_form)
                ]
                if len(form_contexts) == 1:
                    specific_context = form_contexts[0]
            if specific_context is not None:
                occurrence_context.update(specific_context)
            occurrence_context.update(
                {
                    "lexeme_id": lexeme_id,
                    "matched_form": matched_form,
                    "source_form": matched_form,
                    "start_offset": start,
                    "end_offset": end,
                    "occurrence_offset": start,
                    "occurrence": {
                        "start_offset": start,
                        "end_offset": end,
                        "matched_form": matched_form,
                        "lexeme_id": lexeme_id,
                    },
                }
            )
            left = text[:start].rstrip()
            right = text[end:].lstrip()
            master_prefix = re.search(
                r"\b(?:master|mistress|lord|lady|sir|madam|doctor|captain)$",
                left,
                re.IGNORECASE,
            )
            comma_address = left.endswith(",") and (
                not right or right[0] in ",.!?;:"
            )
            leading_address = (
                not left
                or left[-1] in "“\"'‘(["
            ) and bool(right) and right[0] in ",.!?;:"
            if master_prefix or comma_address or leading_address:
                occurrence_context["discourse_function"] = "vocative"
                occurrence_context["usage"] = "direct_address"
            else:
                self_identification = re.search(
                    r"\b(?:i am|i'm|call me)\s+(?:an?\s+)?$",
                    left,
                    re.IGNORECASE,
                )
                if self_identification:
                    occurrence_context.setdefault(
                        "usage", "self_identification"
                    )
            if matched_form.casefold().endswith("s"):
                occurrence_context.setdefault("grammatical_number", "plural")
                occurrence_context.setdefault("usage", "group_reference")
            occurrence_mention = (
                specific_context.get("mention")
                if specific_context is not None
                and isinstance(specific_context.get("mention"), Mapping)
                else mention
            )
            occurrence_concept = (
                specific_context.get("concept")
                if specific_context is not None
                and isinstance(specific_context.get("concept"), (Mapping, str))
                else concept
            )
            occurrence_concept_id = concept_id
            if specific_context is not None and specific_context.get("concept_id"):
                occurrence_concept_id = str(specific_context["concept_id"])
            selected = self._select_concept(
                lexeme,
                occurrence_concept_id,
                occurrence_mention,
                occurrence_concept,
            )
            selected_id = str(selected.get("id")) if selected is not None else None
            if selected_id:
                occurrence_context["concept_id"] = selected_id
            candidates = self._target_candidates(lexeme, "lexeme")
            candidates.extend(self._rule_candidates(lexeme, "lexeme", occurrence_context))
            if selected is not None:
                candidates.extend(self._target_candidates(selected, "concept"))
                candidates.extend(
                    self._rule_candidates(selected, "concept", occurrence_context)
                )
            winner = min(candidates, key=lambda item: item.sort_key) if candidates else None
            matches.append(
                MatchedRendering(
                    lexeme_id=lexeme_id,
                    concept_id=selected_id,
                    matched_form=matched_form,
                    start_offset=start,
                    end_offset=end,
                    rendered_target=winner.target if winner else "",
                    applied_rule_ids=(winner.rule_id,) if winner and winner.rule_id else (),
                    dependency_fingerprint=self._fingerprint(
                        lexeme_id, selected_id, winner
                    ),
                )
            )
        return matches

    def matched_concepts(self, text: str, **context: Any) -> list[Dict[str, Any]]:
        # Legacy snapshots were concept-rooted. Preserve their exact return shape.
        if self._snapshot and not any("lexeme_id" in item for item in self._snapshot):
            return [
                deepcopy(self._by_id[concept_id])
                for concept_id in self._matcher.scan(text)
                if concept_id in self._by_id
            ]
        concepts: list[Dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for match in self.matched_renderings(text, **context):
            lexeme = self._by_id[match.lexeme_id]
            selected = next(
                (
                    item
                    for item in lexeme.get("concepts", []) or []
                    if str(item.get("id") or "") == match.concept_id
                ),
                None,
            )
            if selected is None:
                selected = next(iter(lexeme.get("concepts", []) or []), None)
            identity_id = str(
                (selected or {}).get("id") or lexeme.get("lexeme_id") or lexeme.get("id")
            )
            key = (identity_id, match.rendered_target)
            if key in seen:
                continue
            seen.add(key)
            item = deepcopy(dict(selected or {}))
            verified_target = str(lexeme.get("verified_target") or "").strip()
            if selected is not None:
                verified_target = str(
                    selected.get("verified_target")
                    or (
                        selected.get("default_target")
                        if selected.get("locked") or selected.get("status") == "verified"
                        else ""
                    )
                    or verified_target
                ).strip()
            strength = (
                "verified"
                if match.rendered_target and match.rendered_target == verified_target
                else "working" if match.rendered_target else "unset"
            )
            item.update(
                {
                    "id": identity_id,
                    "lexeme_id": match.lexeme_id,
                    "source": str(
                        (selected or {}).get("source")
                        or lexeme.get("source")
                        or match.matched_form
                    ),
                    "forms": deepcopy(list(lexeme.get("forms", []) or [])),
                    "default_target": match.rendered_target,
                    "target_strength": strength,
                    "rules": deepcopy(
                        list(
                            lexeme.get("lexeme_rules", lexeme.get("rules", []))
                            or []
                        )
                        + list((selected or {}).get("rules", []) or [])
                    ),
                    "term_profile": deepcopy(
                        (selected or {}).get("term_profile")
                        or lexeme.get("term_profile")
                        or {}
                    ),
                }
            )
            concepts.append(item)
        return concepts

    def __len__(self) -> int:
        return len(self._snapshot)

    @overload
    def __getitem__(self, index: int) -> Mapping[str, Any]: ...

    @overload
    def __getitem__(self, index: slice) -> tuple[Dict[str, Any], ...]: ...

    def __getitem__(self, index: int | slice):
        return deepcopy(self._snapshot[index])

    def __iter__(self) -> Iterator[Mapping[str, Any]]:
        return iter(deepcopy(self._snapshot))


# The old name remains an API-compatible alias, while the semantics are lexeme-rooted.
FrozenConceptIndex = FrozenRenderIndex


class ConceptMatcherCache:
    _lock = RLock()
    _cache: Dict[str, AhoConceptMatcher] = {}
    _builds = 0
    _max_entries = 8

    @classmethod
    def get(
        cls, signature: str, snapshot: Sequence[Mapping[str, Any]]
    ) -> AhoConceptMatcher:
        with cls._lock:
            cached = cls._cache.get(signature)
            if cached is not None:
                return cached
            matcher = AhoConceptMatcher.from_snapshot(snapshot)
            cls._cache[signature] = matcher
            cls._builds += 1
            while len(cls._cache) > cls._max_entries:
                cls._cache.pop(next(iter(cls._cache)))
            return matcher

    @classmethod
    def build_count(cls) -> int:
        with cls._lock:
            return cls._builds

    @classmethod
    def clear(cls) -> None:
        with cls._lock:
            cls._cache.clear()
            cls._builds = 0
