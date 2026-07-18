"""SQLite storage and the single-writer commit surface for parallel_v4."""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import re
import secrets
import sqlite3
import unicodedata
import uuid
from copy import deepcopy
from contextlib import closing, contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from types import MappingProxyType
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence

from .audit_archive import (
    AuditArchive,
    AuditArchiveTransaction,
    AuditLocator,
    StorageBudget,
)
from .models import (
    ClaimDependencySnapshot,
    FormOccurrence,
    NarrativeDependencySnapshot,
    RenderingMatchSnapshot,
    RevalidationClaim,
    ScanOutcome,
    TranslationOutcome,
    V4Block,
    V4BlockStatus,
    WorkingTargetRule,
)
from .matcher import FrozenRenderIndex
from .schema_v9 import (
    SCHEMA_VERSION,
    SchemaUpgradeRequired,
    assert_schema9_or_empty,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_id(prefix: str, value: str, length: int = 16) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}_{digest}"


def normalize_english_form(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).translate(
        str.maketrans(
            {
                "’": "'", "‘": "'", "`": "'", "´": "'",
                "“": '"', "”": '"', "«": '"', "»": '"',
                "–": "-", "—": "-", "−": "-", "\u00a0": " ",
            }
        )
    )
    normalized = " ".join(normalized.strip().casefold().split())
    if normalized.endswith("'s") or normalized.endswith("’s"):
        normalized = normalized[:-2]
    elif normalized.endswith("'") or normalized.endswith("’"):
        normalized = normalized[:-1]
    return normalized


def _conservative_english_inflection_forms(value: str) -> set[str]:
    """Return only mechanically safe single-word English noun forms."""

    base = normalize_english_form(value)
    if not re.fullmatch(r"[a-z][a-z-]{2,}", base):
        return {base} if base else set()
    forms = {base}
    if re.search(r"[^aeiou]y$", base):
        forms.add(f"{base[:-1]}ies")
    elif base.endswith(("s", "x", "z", "ch", "sh")):
        forms.add(f"{base}es")
    else:
        forms.add(f"{base}s")
    return forms


_RENDER_MAX_DEPTH = 12
_RENDER_MAX_NODES = 2_048
_RENDER_MAX_STRING_CHARS = 4_096
_RENDER_MAX_INPUT_BYTES = 64 * 1024
_RENDER_METADATA_CHANGE_KINDS = {
    "description",
    "kind",
    "type",
    "evidence",
    "evidence_count",
    "observation",
    "metadata",
}
_RENDER_STRUCTURAL_CHANGE_KINDS = {
    "rendering_rule",
    "usage_rule",
    "condition_rule",
    "concept_merge",
    "concept_split",
    "concept_redirect",
    "concept_form_aliases",
    "subject_link",
    "effective_subject_link",
}
_RENDER_LOCK_CHANGE_KINDS = {
    "human_lock",
    "lock",
    "high_impact_constraint",
    "reveal_boundary",
}
MAX_DEPENDENCY_SPANS = 128
MAX_TRANSLATION_MATCHES = 100_000
MAX_DEPENDENCY_FORMS = 64
MAX_DEPENDENCY_TARGETS = 32
MAX_DEPENDENCY_RULE_IDS = 128
MAX_RENDER_STATE_RULES = 4
MAX_DEPENDENCY_DISTINCT_VALUES = 256
MAX_FROZEN_CLAIMS = 256
MAX_FROZEN_CLAIM_BYTES = 128 * 1024
MAX_FROZEN_CLAIMS_PER_BLOCK = 128
MAX_FROZEN_CLAIM_ID_CHARS = 256
MAX_FROZEN_CLAIM_KIND_CHARS = 64
MAX_FROZEN_CLAIM_STATUS_CHARS = 32
MAX_FROZEN_CLAIM_SCOPE_CHARS = 32
MAX_FROZEN_CLAIM_TEXT_CHARS = 4_096
MAX_PRIOR_CONCEPTS_PER_BLOCK = 128
MAX_PRIOR_CONCEPT_PAIRS = 4096
MAX_PRIOR_CANDIDATES_PER_CONCEPT = 8
MAX_PRIOR_CANDIDATES_TOTAL = 4_096
MAX_PRIOR_CANDIDATE_CHARS = 4_096
MAX_TRANSLATION_AUDIT_NODES = 32_768
MAX_TRANSLATION_AUDIT_STRING_CHARS = 4 * 1024 * 1024
MAX_TRANSLATION_AUDIT_BYTES = 16 * 1024 * 1024


def _validate_render_value(value: Any) -> None:
    """Reject unbounded or non-JSON render state before semantic filtering."""

    nodes = 0
    total_bytes = 0
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > _RENDER_MAX_NODES:
            raise ValueError(f"render state exceeds {_RENDER_MAX_NODES} nodes")
        if depth > _RENDER_MAX_DEPTH:
            raise ValueError(f"render state exceeds depth {_RENDER_MAX_DEPTH}")
        if isinstance(current, Mapping):
            if len(current) > 512:
                raise ValueError("render state mapping is too large")
            for key, item in current.items():
                if not isinstance(key, str):
                    raise TypeError("render state mapping keys must be strings")
                if len(key) > 128:
                    raise ValueError("render state key string is too long")
                total_bytes += len(key.encode("utf-8"))
                stack.append((item, depth + 1))
        elif isinstance(current, (list, tuple)):
            if len(current) > _RENDER_MAX_NODES:
                raise ValueError("render state sequence is too large")
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, str):
            if len(current) > _RENDER_MAX_STRING_CHARS:
                raise ValueError("render state string is too long")
            total_bytes += len(current.encode("utf-8"))
        elif isinstance(current, float):
            if not math.isfinite(current):
                raise ValueError("render state numbers must be finite")
        elif current is None or isinstance(current, (bool, int)):
            pass
        else:
            raise TypeError(
                f"render state contains unsupported type: {type(current).__name__}"
            )
        if total_bytes > _RENDER_MAX_INPUT_BYTES:
            raise ValueError(
                f"render state exceeds {_RENDER_MAX_INPUT_BYTES} UTF-8 bytes"
            )


def _validate_translation_audit_value(value: Any) -> int:
    """Validate a copied audit payload with explicit production-sized bounds."""

    nodes = 0
    total_bytes = 0
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > MAX_TRANSLATION_AUDIT_NODES:
            raise ValueError("translation audit payload has too many nodes")
        if depth > 24:
            raise ValueError("translation audit payload is too deeply nested")
        if isinstance(current, Mapping):
            if len(current) > 4_096:
                raise ValueError("translation audit mapping is too large")
            for key, item in current.items():
                if not isinstance(key, str) or len(key) > 1_024:
                    raise ValueError("translation audit mapping key is invalid")
                total_bytes += len(key.encode("utf-8"))
                stack.append((item, depth + 1))
        elif isinstance(current, (list, tuple)):
            if len(current) > MAX_TRANSLATION_AUDIT_NODES:
                raise ValueError("translation audit sequence is too large")
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, str):
            if len(current) > MAX_TRANSLATION_AUDIT_STRING_CHARS:
                raise ValueError("translation audit string is too long")
            total_bytes += len(current.encode("utf-8"))
        elif isinstance(current, float):
            if not math.isfinite(current):
                raise ValueError("translation audit number must be finite")
        elif current is None or isinstance(current, (bool, int)):
            pass
        else:
            raise TypeError(
                "translation audit contains unsupported type: "
                f"{type(current).__name__}"
            )
        if total_bytes > MAX_TRANSLATION_AUDIT_BYTES:
            raise ValueError("translation audit payload exceeds 16 MiB")
    return total_bytes


def _canonical_render_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _canonical_render_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        items = [_canonical_render_value(item) for item in value]
        return sorted(
            items,
            key=lambda item: json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ),
        )
    return value


def _effective_target_summary(subject_type: str, state: Mapping[str, Any]) -> Dict[str, Any]:
    explicit = str(state.get("effective_target") or "").strip()
    verified = str(state.get("verified_target") or "").strip()
    working = str(state.get("working_target") or "").strip()
    default = str(state.get("default_target") or state.get("target") or "").strip()
    locked = bool(state.get("locked"))
    status = str(state.get("status") or "")
    if explicit:
        return {"target": explicit, "tier": str(state.get("effective_tier") or "effective")}
    if verified:
        return {"target": verified, "tier": "verified"}
    if (locked or status == "verified") and default:
        return {"target": default, "tier": "locked_verified"}
    if working:
        return {"target": working, "tier": "working"}
    if subject_type == "lexeme" and default:
        return {"target": default, "tier": "default"}
    return {"target": "", "tier": "unset"}


def _effective_rule_summary(
    rule: Mapping[str, Any], default_subject_type: str, default_subject_id: str
) -> Dict[str, Any]:
    condition = rule.get("condition", rule.get("condition_json", {}))
    if isinstance(condition, str):
        try:
            condition = json.loads(condition or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("render rule condition_json is invalid") from exc
    if not isinstance(condition, Mapping):
        raise TypeError("render rule condition must be a mapping")
    locked = bool(rule.get("locked"))
    status = str(rule.get("status") or "")
    explicit_tier = str(
        rule.get("effective_tier") or rule.get("tier") or ""
    ).strip()
    tier = explicit_tier or (
        "locked" if locked else "verified" if status == "verified" else "provisional"
    )
    return {
        "subject_type": str(rule.get("subject_type") or default_subject_type),
        "subject_id": str(
            rule.get("subject_id")
            or rule.get(f"{default_subject_type}_id")
            or default_subject_id
        ),
        "target": str(rule.get("target") or "").strip(),
        "condition": _canonical_render_value(condition),
        "priority": int(rule.get("priority") or 0),
        "locked": locked,
        "tier": tier,
        "scope": str(rule.get("scope") or "book"),
    }


def _render_semantic_summary(
    subject_type: str, subject_id: str, state: Mapping[str, Any]
) -> Dict[str, Any]:
    if subject_type == "claim":
        exists = bool(state.get("exists", bool(state)))
        active = exists and bool(state.get("active", not state.get("retired")))
        accepted = active and bool(
            state.get("accepted", str(state.get("status") or "") == "verified")
        )
        kind = str(state.get("kind") or "") if exists else ""
        prompt_effective = bool(
            active and accepted and kind == "translation_constraint"
        )
        if not prompt_effective:
            return {"prompt_effective": False}
        return {
            "prompt_effective": True,
            "statement": str(state.get("statement") or ""),
            "subject_form": str(state.get("subject_form") or ""),
            "scope": str(state.get("scope") or ""),
            "reveal_global_index": int(state.get("reveal_global_index") or 0),
            "reveal_boundary": bool(
                state.get("reveal_boundary") or kind == "reveal_boundary"
            ),
            "locked": bool(state.get("locked")),
            "high_impact_constraint": bool(
                state.get("high_impact_constraint") or state.get("high_impact")
            ),
        }
    retired = bool(state.get("retired"))
    rules_value = state.get("rules", state.get("rendering_rules", ())) or ()
    if not isinstance(rules_value, (list, tuple)):
        raise TypeError("render state rules must be a sequence")
    rules = []
    for rule in rules_value:
        if not isinstance(rule, Mapping):
            raise TypeError("render state rule entries must be mappings")
        rules.append(_effective_rule_summary(rule, subject_type, subject_id))
    rules.sort(
        key=lambda item: json.dumps(
            item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    )
    forms_value = state.get("forms", state.get("source_forms", ())) or ()
    if isinstance(forms_value, str):
        forms_value = (forms_value,)
    if not isinstance(forms_value, (list, tuple)):
        raise TypeError("render state forms must be a sequence")
    forms = sorted({str(value) for value in forms_value if str(value)})
    summary: Dict[str, Any] = {
        "subject_type": str(state.get("effective_subject_type") or subject_type),
        "subject_id": str(state.get("effective_subject_id") or subject_id),
        "active": not retired,
        "effective_target": (
            {"target": "", "tier": "retired"}
            if retired
            else _effective_target_summary(subject_type, state)
        ),
        "locked": bool(state.get("locked")),
        "high_impact_constraint": bool(
            state.get("high_impact_constraint")
            or state.get("reveal_boundary")
            or state.get("constraint_high_impact")
        ),
        "rules": [] if retired else rules,
        "forms": [] if retired else forms,
    }
    profile = state.get("term_profile") or {}
    if not retired and isinstance(profile, Mapping) and profile:
        contrast_sources = profile.get("contrast_sources") or ()
        if isinstance(contrast_sources, str):
            contrast_sources = (contrast_sources,)
        summary["term_profile"] = _canonical_render_value(
            {
                "semantic_core": str(profile.get("semantic_core") or ""),
                "contrast_sources": sorted(
                    {
                        str(value)
                        for value in contrast_sources
                        if str(value)
                    }
                ),
                "status": str(profile.get("status") or "provisional"),
                "locked": bool(profile.get("locked")),
            }
        )
    if state.get("rendering_rules_sha256"):
        summary["rendering_rules_sha256"] = str(
            state["rendering_rules_sha256"]
        )
        summary["rendering_rule_count"] = int(
            state.get("rendering_rule_count") or 0
        )
    links: Dict[str, Any] = {}
    for key in (
        "primary_lexeme_id",
        "effective_subject_link",
        "canonical_concept_id",
        "redirect_winner_id",
        "binding_role",
        "binding_reliable",
        "scope",
    ):
        if key in state and state[key] not in (None, ""):
            links[key] = state[key]
    if links:
        summary["links"] = _canonical_render_value(links)
    return summary


def render_fingerprint(
    subject_type: str, subject_id: str, state: Mapping[str, Any]
) -> str:
    """Hash only effective prompt/matching semantics from a bounded state."""

    if not isinstance(subject_type, str) or not subject_type.strip():
        raise ValueError("render fingerprint subject_type cannot be empty")
    if not isinstance(subject_id, str) or not subject_id.strip():
        raise ValueError("render fingerprint subject_id cannot be empty")
    if not isinstance(state, Mapping):
        raise TypeError("render fingerprint state must be a mapping")
    normalized_subject_type = subject_type.strip()
    normalized_subject_id = subject_id.strip()
    if normalized_subject_type != "claim":
        _validate_render_value(state)
    summary = _render_semantic_summary(
        normalized_subject_type, normalized_subject_id, state
    )
    _validate_render_value(summary)
    raw = json.dumps(
        {
            "subject_type": normalized_subject_type,
            "subject_id": normalized_subject_id,
            "semantic": summary,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if len(raw.encode("utf-8")) > _RENDER_MAX_INPUT_BYTES:
        raise ValueError("effective render summary exceeds size limit")
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _derive_render_change(
    old_summary: Mapping[str, Any],
    new_summary: Mapping[str, Any],
) -> tuple[str, int]:
    """Derive the persisted kind/impact solely from semantic before/after state."""

    if old_summary == new_summary:
        return "metadata", 0
    if (
        "prompt_effective" in old_summary
        or "prompt_effective" in new_summary
    ):
        high_impact = any(
            bool(summary.get(key))
            for summary in (old_summary, new_summary)
            for key in ("locked", "high_impact_constraint", "reveal_boundary")
        )
        reveal_changed = old_summary.get("reveal_global_index") != new_summary.get(
            "reveal_global_index"
        ) and bool(old_summary.get("exists") and new_summary.get("exists"))
        return (
            ("claim_lock", 3)
            if high_impact or reveal_changed
            else ("claim_constraint", 2)
        )
    old_locked = bool(old_summary.get("locked"))
    new_locked = bool(new_summary.get("locked"))
    old_high = bool(old_summary.get("high_impact_constraint"))
    new_high = bool(new_summary.get("high_impact_constraint"))
    if (
        old_locked != new_locked
        or old_high != new_high
        or ((old_locked or new_locked) and old_summary != new_summary)
    ):
        return "human_lock", 3
    if old_summary.get("rules") != new_summary.get("rules"):
        return "rendering_rule", 2
    if old_summary.get("rendering_rules_sha256") != new_summary.get(
        "rendering_rules_sha256"
    ):
        return "rendering_rule", 2
    if old_summary.get("links") != new_summary.get("links"):
        return "subject_link", 2
    if old_summary.get("forms") != new_summary.get("forms"):
        return "source_form", 2
    if old_summary.get("active") != new_summary.get("active"):
        return "subject_link", 2
    if (
        old_summary.get("subject_id") != new_summary.get("subject_id")
        or old_summary.get("subject_type") != new_summary.get("subject_type")
    ):
        return "concept_redirect", 2
    if old_summary.get("term_profile") != new_summary.get("term_profile"):
        return "term_profile", 1
    return "target", 1


def _bounded_dependency_values(values: Iterable[str], limit: int) -> Dict[str, Any]:
    ordered = sorted(set(values))
    digest = hashlib.sha256(
        json.dumps(
            ordered, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    return {
        "values": ordered[:limit],
        "count": len(ordered),
        "omitted": max(0, len(ordered) - limit),
        "sha256": digest,
    }


def _dependency_row(
    dependency_type: str,
    dependency_id: str,
    matches: Sequence[Any],
) -> tuple[str, str, int, str, str, str]:
    forms: set[str] = set()
    targets: set[str] = set()
    winner_rows: set[str] = set()
    rule_id_set: set[str] = set()
    span_heap: list[tuple[int, int]] = []
    retained_spans: set[tuple[int, int]] = set()
    for match in matches:
        form = str(match.matched_form)
        target = str(match.rendered_target or "")
        current_rule_ids = sorted(
            {str(value) for value in tuple(match.applied_rule_ids or ())}
        )
        winner = json.dumps(
            {
                "winner_fingerprint": str(match.dependency_fingerprint or ""),
                "rendered_target": target,
                "applied_rule_ids": current_rule_ids,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        for collection, value, label in (
            (forms, form, "matched forms"),
            (targets, target, "rendered targets"),
            (winner_rows, winner, "winner semantics"),
        ):
            if (
                value not in collection
                and len(collection) >= MAX_DEPENDENCY_DISTINCT_VALUES
            ):
                raise ValueError(
                    f"dependency {dependency_type}:{dependency_id} exceeds distinct {label} limit"
                )
            collection.add(value)
        rule_id_set.update(current_rule_ids)
        span = (int(match.start_offset), int(match.end_offset))
        if span in retained_spans:
            continue
        if len(span_heap) < MAX_DEPENDENCY_SPANS:
            heapq.heappush(span_heap, (-span[0], -span[1]))
            retained_spans.add(span)
            continue
        largest = (-span_heap[0][0], -span_heap[0][1])
        if span < largest:
            removed = heapq.heapreplace(span_heap, (-span[0], -span[1]))
            retained_spans.remove((-removed[0], -removed[1]))
            retained_spans.add(span)
    form_summary = _bounded_dependency_values(forms, MAX_DEPENDENCY_FORMS)
    target_summary = _bounded_dependency_values(targets, MAX_DEPENDENCY_TARGETS)
    rule_ids = sorted(rule_id_set)
    if len(rule_ids) > MAX_DEPENDENCY_RULE_IDS:
        raise ValueError(
            f"dependency {dependency_type}:{dependency_id} exceeds rule ID limit"
        )
    fingerprint_payload = {
        "dependency_type": dependency_type,
        "dependency_id": dependency_id,
        "matched_forms": form_summary,
        "winners": [json.loads(row) for row in sorted(winner_rows)],
    }
    dependency_fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    representative = min(
        forms,
        key=lambda value: (
            unicodedata.normalize("NFKC", value).casefold(),
            value,
        ),
    )
    if target_summary["count"] == 1:
        rendered_target = str(target_summary["values"][0])
    else:
        rendered_target = json.dumps(
            {
                "target_count": target_summary["count"],
                "targets": target_summary["values"],
                "omitted_targets": target_summary["omitted"],
                "targets_sha256": target_summary["sha256"],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    spans = sorted(retained_spans)
    return (
        dependency_fingerprint,
        representative,
        len(matches),
        rendered_target,
        json.dumps(rule_ids, ensure_ascii=False, separators=(",", ":")),
        json.dumps(spans, ensure_ascii=False, separators=(",", ":")),
    )


class StaleCandidateSnapshot(RuntimeError):
    """The pending candidate set changed while clusters were being built."""


class StaleAdjudicationCommit(RuntimeError):
    """Another run already committed an active decision for this cluster."""


class StaleAdjudicationLease(RuntimeError):
    """The candidate/source snapshot changed after the model lease was claimed."""


class KnowledgeSnapshotError(RuntimeError):
    """Persisted rendering knowledge cannot be decoded safely."""

    def __init__(self, rule_id: str, detail: str):
        self.rule_id = rule_id
        self.detail = detail
        super().__init__(f"invalid rendering rule {rule_id}: {detail}")


@dataclass(frozen=True)
class FrozenRenderBundle:
    knowledge_version: int
    index: FrozenRenderIndex
    contexts_by_block: Mapping[str, tuple[Mapping[str, Any], ...]]
    claims_by_block: Mapping[str, tuple[Mapping[str, Any], ...]]
    prior_concept_evidence_by_block: Mapping[
        str, tuple[Mapping[str, Any], ...]
    ]
    signature: str
    render_signature: str
    block_ids: tuple[str, ...]


@dataclass(frozen=True)
class _TranslationCommitSnapshot:
    block: V4Block
    knowledge_version: int
    memory_version: int
    snapshot_id: str
    context_hash: str
    style_snapshot_id: str
    style_anchor_id: str
    discourse_state_hash: str
    status: str
    draft_translation: str
    final_translation: str
    analysis: str
    semantic_obligations: str
    memory_summary: str
    warnings: tuple[Any, ...]
    matched_concept_ids: tuple[str, ...]
    matched_renderings: tuple[RenderingMatchSnapshot, ...]
    claim_dependencies: tuple[ClaimDependencySnapshot, ...]
    narrative_dependencies: tuple[NarrativeDependencySnapshot, ...]
    audit_calls: tuple[Mapping[str, Any], ...]
    error: str | None


def _immutable_render_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType(
            {str(key): _immutable_render_value(item) for key, item in value.items()}
        )
    if isinstance(value, list):
        return tuple(_immutable_render_value(item) for item in value)
    if isinstance(value, tuple):
        return tuple(_immutable_render_value(item) for item in value)
    return value


def _copy_render_value(value: Any) -> Any:
    """Copy JSON-like input without changing sequence order."""

    if isinstance(value, Mapping):
        return {str(key): _copy_render_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_copy_render_value(item) for item in value]
    return value


def _mutable_render_value(value: Any) -> Any:
    """Thaw an immutable commit snapshot into JSON-serializable containers."""

    if isinstance(value, Mapping):
        return {str(key): _mutable_render_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_mutable_render_value(item) for item in value]
    return value


def _strict_snapshot_mapping(
    value: Mapping[str, Any], *, allowed: set[str], required: set[str], label: str
) -> Dict[str, Any]:
    raw = dict(value)
    keys = set(raw)
    if not required <= keys or not keys <= allowed:
        raise ValueError(f"{label} mapping fields are invalid")
    _validate_render_value(raw)
    return raw


def _snapshot_render_match(value: Any) -> RenderingMatchSnapshot:
    if type(value) is RenderingMatchSnapshot:
        return value
    if not isinstance(value, Mapping):
        raise ValueError(
            "translation matches must be RenderingMatchSnapshot or strict mapping"
        )
    raw = _strict_snapshot_mapping(
        value,
        allowed={
            "lexeme_id",
            "concept_id",
            "matched_form",
            "start_offset",
            "end_offset",
            "rendered_target",
            "applied_rule_ids",
            "dependency_fingerprint",
        },
        required={
            "lexeme_id",
            "matched_form",
            "start_offset",
            "end_offset",
            "rendered_target",
        },
        label="RenderingMatchSnapshot",
    )
    raw_rule_ids = raw.get("applied_rule_ids", ()) or ()
    if isinstance(raw_rule_ids, (str, bytes)) or not isinstance(
        raw_rule_ids, (list, tuple)
    ):
        raise ValueError("translation match rule IDs must be a sequence")
    return RenderingMatchSnapshot(
        lexeme_id=str(raw["lexeme_id"]),
        concept_id=(
            str(raw["concept_id"]) if raw.get("concept_id") is not None else None
        ),
        matched_form=str(raw["matched_form"]),
        start_offset=int(raw["start_offset"]),
        end_offset=int(raw["end_offset"]),
        rendered_target=str(raw["rendered_target"]),
        applied_rule_ids=tuple(str(item) for item in raw_rule_ids),
        dependency_fingerprint=str(raw.get("dependency_fingerprint") or ""),
    )


def _snapshot_claim_dependency(value: Any) -> ClaimDependencySnapshot:
    if type(value) is ClaimDependencySnapshot:
        return value
    if not isinstance(value, Mapping):
        raise ValueError(
            "claim dependencies must be ClaimDependencySnapshot or strict mapping"
        )
    raw = _strict_snapshot_mapping(
        value,
        allowed={"claim_id", "semantic_fingerprint"},
        required={"claim_id", "semantic_fingerprint"},
        label="ClaimDependencySnapshot",
    )
    return ClaimDependencySnapshot(
        claim_id=str(raw["claim_id"]),
        semantic_fingerprint=str(raw["semantic_fingerprint"]),
    )


def _snapshot_narrative_dependency(
    value: Any,
) -> NarrativeDependencySnapshot:
    if type(value) is NarrativeDependencySnapshot:
        return value
    if not isinstance(value, Mapping):
        raise ValueError(
            "narrative dependencies must be NarrativeDependencySnapshot "
            "or strict mapping"
        )
    raw = _strict_snapshot_mapping(
        value,
        allowed={"memory_id", "semantic_fingerprint"},
        required={"memory_id", "semantic_fingerprint"},
        label="NarrativeDependencySnapshot",
    )
    return NarrativeDependencySnapshot(
        memory_id=str(raw["memory_id"]),
        semantic_fingerprint=str(raw["semantic_fingerprint"]),
    )


def _snapshot_translation_outcome(value: Any) -> _TranslationCommitSnapshot:
    if not isinstance(value, TranslationOutcome):
        raise TypeError("translation batch entries must be TranslationOutcome")
    block = value.block
    if type(block) is not V4Block:
        raise TypeError("translation outcome block must be V4Block")
    knowledge_version = value.knowledge_version
    if isinstance(knowledge_version, bool) or not isinstance(knowledge_version, int):
        raise ValueError("translation knowledge version must be an integer")
    raw_matches = value.matched_renderings
    if not isinstance(raw_matches, (list, tuple)):
        raise ValueError("translation matches must be a bounded sequence")
    if len(raw_matches) > MAX_TRANSLATION_MATCHES:
        raise ValueError(
            f"translation match snapshot exceeds {MAX_TRANSLATION_MATCHES} entries"
        )
    raw_claims = value.claim_dependencies
    if not isinstance(raw_claims, (list, tuple)) or len(raw_claims) > MAX_FROZEN_CLAIMS:
        raise ValueError("claim dependency snapshot is not a bounded sequence")
    raw_narrative = value.narrative_dependencies
    if (
        not isinstance(raw_narrative, (list, tuple))
        or len(raw_narrative) > MAX_FROZEN_CLAIMS
    ):
        raise ValueError(
            "narrative dependency snapshot is not a bounded sequence"
        )
    memory_version = value.memory_version
    if isinstance(memory_version, bool) or not isinstance(memory_version, int):
        raise ValueError("translation memory version must be an integer")
    if memory_version < 1:
        raise ValueError("translation memory version must be positive")
    snapshot_id = str(value.snapshot_id or "")
    context_hash = str(value.context_hash or "")
    style_snapshot_id = str(value.style_snapshot_id or "")
    style_anchor_id = str(value.style_anchor_id or "")
    discourse_state_hash = str(value.discourse_state_hash or "")
    for label, raw_value, allow_empty in (
        ("snapshot_id", snapshot_id, True),
        ("context_hash", context_hash, True),
        ("style_snapshot_id", style_snapshot_id, True),
        ("style_anchor_id", style_anchor_id, True),
        ("discourse_state_hash", discourse_state_hash, True),
    ):
        if len(raw_value) > 256:
            raise ValueError(f"translation {label} is too long")
        if not allow_empty and not raw_value:
            raise ValueError(f"translation {label} cannot be empty")
    raw_concepts = value.matched_concept_ids
    if not isinstance(raw_concepts, (list, tuple)) or len(raw_concepts) > 4096:
        raise ValueError("matched concept IDs are not a bounded sequence")
    raw_warnings = value.warnings
    if not isinstance(raw_warnings, (list, tuple)) or len(raw_warnings) > 1024:
        raise ValueError("translation warnings are not a bounded sequence")
    warnings = _copy_render_value(raw_warnings)
    _validate_render_value(warnings)
    raw_audits = value.audit_calls
    if not isinstance(raw_audits, (list, tuple)) or len(raw_audits) > 128:
        raise ValueError("translation audit calls are not a bounded sequence")
    audits: list[Mapping[str, Any]] = []
    audit_bytes = 0
    for audit in raw_audits:
        if not isinstance(audit, Mapping):
            raise ValueError("translation audit calls must be mappings")
        copied = _copy_render_value(audit)
        audit_bytes += _validate_translation_audit_value(copied)
        if audit_bytes > MAX_TRANSLATION_AUDIT_BYTES:
            raise ValueError("translation audit snapshot exceeds 16 MiB")
        audits.append(_immutable_render_value(copied))
    return _TranslationCommitSnapshot(
        block=block,
        knowledge_version=knowledge_version,
        memory_version=memory_version,
        snapshot_id=snapshot_id,
        context_hash=context_hash,
        style_snapshot_id=style_snapshot_id,
        style_anchor_id=style_anchor_id,
        discourse_state_hash=discourse_state_hash,
        status=str(value.status),
        draft_translation=str(value.draft_translation),
        final_translation=str(value.final_translation),
        analysis=str(value.analysis),
        semantic_obligations=str(value.semantic_obligations),
        memory_summary=str(value.memory_summary),
        warnings=tuple(warnings),
        matched_concept_ids=tuple(str(item) for item in raw_concepts),
        matched_renderings=tuple(_snapshot_render_match(item) for item in raw_matches),
        claim_dependencies=tuple(
            _snapshot_claim_dependency(item) for item in raw_claims
        ),
        narrative_dependencies=tuple(
            _snapshot_narrative_dependency(item)
            for item in raw_narrative
        ),
        audit_calls=tuple(audits),
        error=str(value.error) if value.error is not None else None,
    )


def _safe_rule_condition(raw: Any, rule_id: str) -> Dict[str, Any]:
    text = str(raw or "{}")
    try:
        if len(text.encode("utf-8")) > 16 * 1024:
            raise ValueError("condition JSON exceeds 16 KiB")

        def reject_constant(_value: str) -> None:
            raise ValueError("non-finite JSON number")

        value = json.loads(text, parse_constant=reject_constant)
    except (json.JSONDecodeError, RecursionError, MemoryError, OverflowError, ValueError) as exc:
        raise KnowledgeSnapshotError(rule_id, str(exc)[:160]) from exc
    if not isinstance(value, dict):
        raise KnowledgeSnapshotError(rule_id, "condition JSON root must be an object")
    nodes = 0
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > 256:
            raise KnowledgeSnapshotError(rule_id, "condition JSON exceeds 256 nodes")
        if depth > 16:
            raise KnowledgeSnapshotError(rule_id, "condition JSON exceeds depth 16")
        if isinstance(current, dict):
            if len(current) > 128:
                raise KnowledgeSnapshotError(rule_id, "condition object is too large")
            for key, item in current.items():
                if not isinstance(key, str) or len(key) > 512:
                    raise KnowledgeSnapshotError(rule_id, "condition key is too long")
                stack.append((item, depth + 1))
        elif isinstance(current, list):
            if len(current) > 128:
                raise KnowledgeSnapshotError(rule_id, "condition list is too large")
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, str):
            if len(current) > 512:
                raise KnowledgeSnapshotError(rule_id, "condition string is too long")
        elif isinstance(current, float):
            if not math.isfinite(current):
                raise KnowledgeSnapshotError(rule_id, "condition number is not finite")
        elif current is None or isinstance(current, (bool, int)):
            continue
        else:
            raise KnowledgeSnapshotError(rule_id, "condition contains unsupported data")
    return value


class ConceptAnchorConflictError(RuntimeError, ValueError):
    """An immutable mention anchor prevents safe concept creation."""


class ConceptMergeConflictError(RuntimeError, ValueError):
    """Protected knowledge makes an otherwise authorized merge unsafe."""


MAX_COREFERENCE_FALLBACK_CANDIDATES = 16
MAX_COREFERENCE_FALLBACK_SOURCES = 8
MAX_COREFERENCE_FALLBACK_TEXT_CHARS = 120
MAX_CONCEPT_REDIRECT_DEPTH = 64
MAX_MERGE_AUDIT_IDS = 64
MAX_RULE_CONFLICT_IDS = 64
MAX_RULE_CONFLICT_TARGETS = 32
MAX_RULE_CONFLICT_CONDITION_CHARS = 2_048
MAX_AUTHORIZED_CONCEPT_IDS = 16
MAX_AUTHORIZED_CONCEPT_ID_CHARS = 256
HUMAN_CONCEPT_FORM_REDIRECT_PREFIX = (
    "human concept-form merge authorization audit:"
)


class V4Database:
    """All writes happen through this object on the coordinator thread."""

    def __init__(self, project_root: str | Path):
        self.project_root = Path(project_root)
        self.root = self.project_root / "artifacts" / "parallel_v4"
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "book.db"
        assert_schema9_or_empty(self.path)
        self.audit_archive = AuditArchive(self.root / "audit")
        self._audit_transactions: Dict[int, AuditArchiveTransaction] = {}
        self._audit_transactions_lock = RLock()
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        audit_transaction = self.audit_archive.begin()
        registered = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            with self._audit_transactions_lock:
                self._audit_transactions[id(connection)] = audit_transaction
            registered = True
            yield connection
            self._check_storage_budget(connection)
            connection.commit()
            audit_transaction.commit()
        except Exception:
            try:
                connection.rollback()
            finally:
                audit_transaction.rollback()
            raise
        finally:
            if registered:
                with self._audit_transactions_lock:
                    self._audit_transactions.pop(id(connection), None)
            connection.close()

    @contextmanager
    def _write(
        self, connection: sqlite3.Connection | None
    ) -> Iterator[sqlite3.Connection]:
        if connection is not None:
            if not connection.in_transaction:
                raise ValueError(
                    "external connection requires an active transaction"
                )
            yield connection
            return
        with self.transaction() as owned:
            yield owned

    @staticmethod
    @contextmanager
    def _method_savepoint(
        connection: sqlite3.Connection,
        prefix: str,
    ) -> Iterator[None]:
        name = f"{prefix}_{uuid.uuid4().hex}"
        connection.execute(f"SAVEPOINT {name}")
        try:
            yield
            connection.execute(f"RELEASE SAVEPOINT {name}")
        except BaseException:
            try:
                connection.execute(f"ROLLBACK TO SAVEPOINT {name}")
            except sqlite3.Error:
                pass
            try:
                connection.execute(f"RELEASE SAVEPOINT {name}")
            except sqlite3.Error:
                pass
            raise

    @staticmethod
    def _require_active_transaction(connection: sqlite3.Connection) -> None:
        if not connection.in_transaction:
            raise ValueError(
                "external database connection requires an active transaction"
            )

    @staticmethod
    def _human_concept_form_redirect_is_authorized(
        connection: sqlite3.Connection,
        redirect: sqlite3.Row,
        retired_concept_id: str,
    ) -> bool:
        reason = str(redirect["reason"] or "")
        if not reason.startswith(HUMAN_CONCEPT_FORM_REDIRECT_PREFIX):
            return False
        suffix = reason[len(HUMAN_CONCEPT_FORM_REDIRECT_PREFIX) :]
        match = re.match(r"(\d+)(?:\b|:)", suffix)
        if match is None:
            return False
        audit = connection.execute(
            """SELECT request_json, parsed_json FROM audit_calls
               WHERE id=?
                 AND purpose='human_concept_form_merge_authorization'
                 AND model='none' AND accepted=1""",
            (int(match.group(1)),),
        ).fetchone()
        if audit is None:
            return False
        try:
            request = json.loads(str(audit["request_json"] or "{}"))
            parsed = json.loads(str(audit["parsed_json"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return False
        concept_ids = request.get("concept_ids")
        return (
            request.get("actor_type") == "human"
            and request.get("call_type")
            == "human_concept_form_merge_authorization"
            and isinstance(concept_ids, list)
            and retired_concept_id in concept_ids
            and parsed.get("authorized") is True
            and parsed.get("canonical_concept_id")
            == str(redirect["canonical_concept_id"])
        )

    @staticmethod
    def _active_canonical_concept(
        connection: sqlite3.Connection,
        concept_id: str,
        *,
        expected_lexeme_id: str | None = None,
    ) -> tuple[str | None, bool]:
        """Follow retired-concept redirects to one active canonical concept."""

        current = concept_id
        visited: set[str] = set()
        redirected = False
        chain_lexeme_id = expected_lexeme_id
        allow_next_cross_lexeme = False
        human_form_redirect = False
        for _ in range(MAX_CONCEPT_REDIRECT_DEPTH + 1):
            if current in visited:
                return (None, redirected)
            visited.add(current)
            concept = connection.execute(
                """SELECT primary_lexeme_id, retired_version
                   FROM concepts WHERE id=?""",
                (current,),
            ).fetchone()
            if concept is None:
                return (None, redirected)
            row_lexeme_id = str(concept["primary_lexeme_id"] or "").strip() or None
            if chain_lexeme_id is None:
                chain_lexeme_id = row_lexeme_id
            elif row_lexeme_id != chain_lexeme_id:
                if not allow_next_cross_lexeme:
                    return (None, redirected)
                chain_lexeme_id = row_lexeme_id
                allow_next_cross_lexeme = False
            else:
                allow_next_cross_lexeme = False
            if concept["retired_version"] is None:
                if expected_lexeme_id is not None:
                    primary_ids = {
                        str(row["lexeme_id"])
                        for row in connection.execute(
                            """SELECT lexeme_id FROM concept_lexemes
                               WHERE concept_id=? AND role='primary'
                                     AND retired_version IS NULL""",
                            (current,),
                        ).fetchall()
                    }
                    if human_form_redirect:
                        alias_link = connection.execute(
                            """SELECT 1 FROM concept_lexemes
                               WHERE concept_id=? AND lexeme_id=?
                                 AND role='alias' AND retired_version IS NULL""",
                            (current, expected_lexeme_id),
                        ).fetchone()
                        if alias_link is None:
                            return (None, redirected)
                    elif (
                        str(concept["primary_lexeme_id"] or "")
                        != expected_lexeme_id
                        or primary_ids != {expected_lexeme_id}
                    ):
                        return (None, redirected)
                return (current, redirected)
            redirect = connection.execute(
                """SELECT canonical_concept_id, reason, knowledge_version
                   FROM concept_redirects
                   WHERE retired_concept_id=?""",
                (current,),
            ).fetchone()
            if redirect is None:
                return (None, redirected)
            allow_next_cross_lexeme = (
                V4Database._human_concept_form_redirect_is_authorized(
                    connection, redirect, current
                )
            )
            human_form_redirect = human_form_redirect or allow_next_cross_lexeme
            current = str(redirect["canonical_concept_id"])
            redirected = True
        return (None, redirected)

    def resolve_concept_id(
        self,
        concept_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> str:
        """Resolve one historical concept identity to an active canonical row."""

        if not isinstance(concept_id, str) or not concept_id.strip():
            raise ValueError("concept_id cannot be empty")
        normalized_id = concept_id.strip()
        if connection is None:
            with closing(self.connect()) as owned_connection:
                owned_connection.execute("BEGIN")
                return self.resolve_concept_id(
                    normalized_id,
                    connection=owned_connection,
                )
        self._require_active_transaction(connection)

        current = normalized_id
        visited: set[str] = set()
        expected_lexeme_id: str | None = None
        allow_next_cross_lexeme = False
        for depth in range(MAX_CONCEPT_REDIRECT_DEPTH + 1):
            if current in visited:
                raise ValueError(
                    f"concept redirect cycle detected at {current}"
                )
            visited.add(current)
            row = connection.execute(
                """SELECT id, primary_lexeme_id, retired_version
                   FROM concepts WHERE id=?""",
                (current,),
            ).fetchone()
            if row is None:
                if depth == 0:
                    raise KeyError(f"concept does not exist: {normalized_id}")
                raise ValueError(
                    f"dangling concept redirect target: {current}"
                )
            row_lexeme = str(row["primary_lexeme_id"] or "").strip() or None
            if expected_lexeme_id is None:
                expected_lexeme_id = row_lexeme
            elif row_lexeme is not None and row_lexeme != expected_lexeme_id:
                if not allow_next_cross_lexeme:
                    raise ValueError(
                        "cross-lexeme concept redirect chain is invalid: "
                        f"{normalized_id} -> {current}"
                    )
                expected_lexeme_id = row_lexeme
                allow_next_cross_lexeme = False
            else:
                allow_next_cross_lexeme = False
            if row["retired_version"] is None:
                return current
            if depth == MAX_CONCEPT_REDIRECT_DEPTH:
                raise ValueError(
                    "concept redirect depth exceeds "
                    f"{MAX_CONCEPT_REDIRECT_DEPTH}: {normalized_id}"
                )
            redirect = connection.execute(
                """SELECT canonical_concept_id, reason, knowledge_version
                   FROM concept_redirects
                   WHERE retired_concept_id=?""",
                (current,),
            ).fetchone()
            if redirect is None:
                raise ValueError(
                    f"dangling concept redirect chain at retired concept: {current}"
                )
            target = str(redirect["canonical_concept_id"] or "").strip()
            if not target:
                raise ValueError(
                    f"dangling concept redirect target from: {current}"
                )
            if target == current:
                raise ValueError(f"self concept redirect detected: {current}")
            allow_next_cross_lexeme = (
                self._human_concept_form_redirect_is_authorized(
                    connection, redirect, current
                )
            )
            current = target
        raise ValueError(
            f"concept redirect depth exceeds {MAX_CONCEPT_REDIRECT_DEPTH}: {normalized_id}"
        )

    @staticmethod
    def _canonical_json_text(raw: Any, *, field: str) -> str:
        try:
            value = json.loads(str(raw))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid {field} JSON") from exc
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _decoded_json_array(raw: Any, *, field: str) -> list[Any]:
        try:
            value = json.loads(str(raw or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid {field} JSON") from exc
        if not isinstance(value, list):
            raise ValueError(f"{field} must be a JSON array")
        return value

    @staticmethod
    def _stable_json_union(values: Iterable[Any]) -> list[Any]:
        unique: dict[str, Any] = {}
        for value in values:
            encoded = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            unique.setdefault(encoded, value)
        return [unique[key] for key in sorted(unique)]

    @staticmethod
    def _merged_text(values: Iterable[Any]) -> str:
        unique = sorted(
            {
                str(value).strip()
                for value in values
                if str(value or "").strip()
            }
        )
        if not unique:
            return ""
        if len(unique) == 1:
            return unique[0]
        return json.dumps(unique, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _merge_fingerprints(values: Iterable[Any]) -> str:
        unique = sorted(
            {
                str(value).strip()
                for value in values
                if str(value or "").strip()
            }
        )
        if not unique:
            return ""
        if len(unique) == 1:
            return unique[0]
        payload = json.dumps(
            unique,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return f"merged:{hashlib.sha256(payload).hexdigest()}"

    def _authorized_merge_decision(
        self,
        connection: sqlite3.Connection,
        decision_id: str,
        concept_ids: set[str],
        lexeme_id: str,
    ) -> sqlite3.Row:
        decision = connection.execute(
            """SELECT * FROM coreference_decisions
               WHERE id=? AND relation='same' AND retired_version IS NULL""",
            (decision_id,),
        ).fetchone()
        if decision is None:
            raise ConceptMergeConflictError(
                "merge decision_id must reference an active same coreference decision"
            )
        if str(decision["lexeme_id"]) != lexeme_id:
            raise ConceptMergeConflictError(
                "merge decision lexeme does not match the concepts"
            )
        authorized: set[str] = set()
        for side in ("left", "right"):
            if decision[f"{side}_anchor_type"] != "concept":
                continue
            anchor_id = str(decision[f"{side}_anchor_id"])
            try:
                authorized.add(
                    self.resolve_concept_id(anchor_id, connection=connection)
                )
            except (KeyError, ValueError):
                continue
        try:
            votes = self._decoded_json_array(
                decision["votes_json"], field="coreference decision votes_json"
            )
        except ValueError as exc:
            raise ConceptMergeConflictError(
                "merge decision has invalid frozen authorization votes"
            ) from exc
        frozen_ids: set[str] = set()
        for vote in votes:
            if not isinstance(vote, dict) or "authorized_concept_ids" not in vote:
                continue
            snapshot = vote["authorized_concept_ids"]
            if not isinstance(snapshot, list) or len(snapshot) > MAX_AUTHORIZED_CONCEPT_IDS:
                raise ConceptMergeConflictError(
                    "merge decision frozen authorization is invalid or unbounded"
                )
            for value in snapshot:
                if (
                    not isinstance(value, str)
                    or not value.strip()
                    or len(value.strip()) > MAX_AUTHORIZED_CONCEPT_ID_CHARS
                ):
                    raise ConceptMergeConflictError(
                        "merge decision frozen authorization contains an invalid concept ID"
                    )
                frozen_ids.add(value.strip())
        if len(frozen_ids) > MAX_AUTHORIZED_CONCEPT_IDS:
            raise ConceptMergeConflictError(
                "merge decision frozen authorization is unbounded"
            )
        for frozen_id in sorted(frozen_ids):
            try:
                authorized.add(
                    self.resolve_concept_id(frozen_id, connection=connection)
                )
            except (KeyError, ValueError):
                continue
        members = self._decoded_json_array(
            decision["anchor_members_json"],
            field="anchor_members_json",
        )
        member_ids = sorted(
            {
                int(value)
                for value in members
                if isinstance(value, int) and not isinstance(value, bool)
                or isinstance(value, str) and value.strip().isdigit()
            }
        )
        if member_ids:
            placeholders = ",".join("?" for _ in member_ids)
            anchor_rows = connection.execute(
                f"""SELECT id FROM concepts
                     WHERE anchor_mention_id IN ({placeholders})
                       AND primary_lexeme_id=?""",
                (*member_ids, lexeme_id),
            ).fetchall()
            for row in anchor_rows:
                try:
                    authorized.add(
                        self.resolve_concept_id(
                            str(row["id"]),
                            connection=connection,
                        )
                    )
                except (KeyError, ValueError):
                    continue
        if not concept_ids <= authorized:
            missing = sorted(concept_ids - authorized)
            raise ConceptMergeConflictError(
                "same decision does not authorize every merge concept: "
                + ", ".join(missing[:8])
            )
        return decision

    @staticmethod
    def _reject_locked_concept_conflicts(
        rows: Sequence[sqlite3.Row],
    ) -> None:
        locked_rows = [row for row in rows if bool(row["locked"])]
        locked_targets = {
            str(
                row["verified_target"]
                or row["working_target"]
                or row["default_target"]
                or ""
            ).strip()
            for row in locked_rows
            if str(
                row["verified_target"]
                or row["working_target"]
                or row["default_target"]
                or ""
            ).strip()
        }
        if len(locked_targets) > 1:
            raise ConceptMergeConflictError(
                "locked concepts have conflicting translations"
            )
        if len({str(row["kind"]) for row in locked_rows}) > 1:
            raise ConceptMergeConflictError(
                "locked concepts have conflicting kinds"
            )

    def _reject_protected_merge_conflicts(
        self,
        connection: sqlite3.Connection,
        rows: Sequence[sqlite3.Row],
        concept_ids: set[str],
        lexeme_id: str,
    ) -> None:
        self._reject_locked_concept_conflicts(rows)
        protected = connection.execute(
            """SELECT * FROM coreference_decisions
               WHERE lexeme_id=? AND retired_version IS NULL
                 AND relation!='same' AND (locked=1 OR decision_source='human')
               ORDER BY id""",
            (lexeme_id,),
        ).fetchall()
        if not protected:
            return
        all_member_ids: set[int] = set()
        decoded_members: dict[str, set[int]] = {}
        for decision in protected:
            members = {
                int(value)
                for value in self._decoded_json_array(
                    decision["anchor_members_json"],
                    field="anchor_members_json",
                )
                if isinstance(value, int) and not isinstance(value, bool)
                or isinstance(value, str) and value.strip().isdigit()
            }
            decoded_members[str(decision["id"])] = members
            all_member_ids.update(members)
        member_concepts: dict[int, str] = {}
        if all_member_ids:
            ordered_members = sorted(all_member_ids)
            placeholders = ",".join("?" for _ in ordered_members)
            for row in connection.execute(
                f"""SELECT id, concept_id FROM mentions
                     WHERE id IN ({placeholders}) AND concept_id IS NOT NULL""",
                ordered_members,
            ).fetchall():
                try:
                    member_concepts[int(row["id"])] = self.resolve_concept_id(
                        str(row["concept_id"]), connection=connection
                    )
                except (KeyError, ValueError):
                    continue
        for decision in protected:
            identities: set[str] = set()
            for side in ("left", "right"):
                if decision[f"{side}_anchor_type"] != "concept":
                    continue
                try:
                    identities.add(
                        self.resolve_concept_id(
                            str(decision[f"{side}_anchor_id"]),
                            connection=connection,
                        )
                    )
                except (KeyError, ValueError):
                    continue
            identities.update(
                member_concepts[member_id]
                for member_id in decoded_members[str(decision["id"])]
                if member_id in member_concepts
            )
            overlap = identities & concept_ids
            if overlap and (
                str(decision["relation"]) in {"uncertain", "non_entity"}
                or len(overlap) >= 2
            ):
                raise ConceptMergeConflictError(
                    "protected human/locked coreference decision conflicts with merge: "
                    f"{decision['id']}"
                )

    def merge_concepts(
        self,
        concept_ids: Sequence[str],
        *,
        reason: str,
        decision_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> Dict[str, Any]:
        """Atomically merge active same-lexeme concepts through redirects."""

        return self._merge_concepts_authorized(
            concept_ids,
            reason=reason,
            decision_id=decision_id,
            connection=connection,
            human_authorized_cross_lexeme=False,
            preferred_canonical_id=None,
        )

    def _merge_concepts_authorized(
        self,
        concept_ids: Sequence[str],
        *,
        reason: str,
        decision_id: str,
        connection: sqlite3.Connection | None,
        human_authorized_cross_lexeme: bool,
        preferred_canonical_id: str | None,
    ) -> Dict[str, Any]:
        """Private primitive shared by decision and explicit-human merge APIs."""

        if isinstance(concept_ids, (str, bytes)):
            raise ValueError("merge_concepts requires a sequence of concept IDs")
        raw_ids = list(concept_ids)
        if len(raw_ids) < 2:
            raise ValueError("merge_concepts requires at least two concept IDs")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("merge reason cannot be empty")
        if not isinstance(decision_id, str) or not decision_id.strip():
            raise ValueError("merge decision_id cannot be empty")
        normalized_raw: list[str] = []
        for value in raw_ids:
            if not isinstance(value, str) or not value.strip():
                raise ValueError("merge concept IDs cannot be empty")
            normalized_raw.append(value.strip())
        reason = reason.strip()
        decision_id = decision_id.strip()
        if connection is None:
            with self.transaction() as owned_connection:
                return self._merge_concepts_authorized(
                    normalized_raw,
                    reason=reason,
                    decision_id=decision_id,
                    connection=owned_connection,
                    human_authorized_cross_lexeme=human_authorized_cross_lexeme,
                    preferred_canonical_id=preferred_canonical_id,
                )
        self._require_active_transaction(connection)
        with self._method_savepoint(connection, "merge_concepts"):
            try:
                resolved_ids = sorted(
                    {
                        self.resolve_concept_id(value, connection=connection)
                        for value in normalized_raw
                    }
                )
            except (KeyError, ValueError) as exc:
                raise ConceptMergeConflictError(
                    "merge concept identity changed or cannot be resolved"
                ) from exc
            placeholders = ",".join("?" for _ in resolved_ids)
            rows = connection.execute(
                f"""WITH mention_counts AS (
                         SELECT concept_id, COUNT(*) AS count
                         FROM mentions WHERE concept_id IN ({placeholders})
                         GROUP BY concept_id
                     ), dependency_counts AS (
                         SELECT dependency_id, COUNT(*) AS count
                         FROM dependencies
                         WHERE dependency_type='concept'
                           AND dependency_id IN ({placeholders})
                         GROUP BY dependency_id
                     )
                     SELECT c.*,
                            COALESCE(m.count, 0) AS mention_count,
                            COALESCE(d.count, 0) AS dependency_count,
                            (
                                SELECT semantic_core FROM term_profiles tp
                                WHERE tp.subject_type='concept'
                                  AND tp.subject_id=c.id
                                  AND tp.retired_version IS NULL
                                ORDER BY tp.created_version DESC LIMIT 1
                            ) AS profile_semantic_core,
                            (
                                SELECT contrast_sources_json FROM term_profiles tp
                                WHERE tp.subject_type='concept'
                                  AND tp.subject_id=c.id
                                  AND tp.retired_version IS NULL
                                ORDER BY tp.created_version DESC LIMIT 1
                            ) AS profile_contrast_sources_json,
                            (
                                SELECT status FROM term_profiles tp
                                WHERE tp.subject_type='concept'
                                  AND tp.subject_id=c.id
                                  AND tp.retired_version IS NULL
                                ORDER BY tp.created_version DESC LIMIT 1
                            ) AS profile_status,
                            (
                                SELECT locked FROM term_profiles tp
                                WHERE tp.subject_type='concept'
                                  AND tp.subject_id=c.id
                                  AND tp.retired_version IS NULL
                                ORDER BY tp.created_version DESC LIMIT 1
                            ) AS profile_locked,
                            (
                                SELECT created_version FROM term_profiles tp
                                WHERE tp.subject_type='concept'
                                  AND tp.subject_id=c.id
                                  AND tp.retired_version IS NULL
                                ORDER BY tp.created_version DESC LIMIT 1
                            ) AS profile_created_version
                     FROM concepts c
                     LEFT JOIN mention_counts m ON m.concept_id=c.id
                     LEFT JOIN dependency_counts d ON d.dependency_id=c.id
                     WHERE c.id IN ({placeholders})
                       AND c.retired_version IS NULL
                     ORDER BY c.id""",
                (*resolved_ids, *resolved_ids, *resolved_ids),
            ).fetchall()
            if len(rows) != len(resolved_ids):
                raise ConceptMergeConflictError(
                    "merge requires active canonical concepts"
                )
            lexeme_ids = {
                str(row["primary_lexeme_id"] or "").strip() for row in rows
            }
            if human_authorized_cross_lexeme:
                if preferred_canonical_id not in resolved_ids:
                    raise ValueError(
                        "human concept-form merge canonical concept is not active"
                    )
                if "" in lexeme_ids:
                    raise ValueError(
                        "human concept-form merge requires active primary lexemes"
                    )
                lexeme_id = str(
                    next(
                        row["primary_lexeme_id"]
                        for row in rows
                        if str(row["id"]) == preferred_canonical_id
                    )
                )
            else:
                if len(lexeme_ids) != 1 or not next(iter(lexeme_ids), ""):
                    raise ConceptMergeConflictError(
                        "merge concepts must belong to one active lexeme"
                    )
                lexeme_id = next(iter(lexeme_ids))
                linked = {
                    str(row["concept_id"])
                    for row in connection.execute(
                        f"""SELECT concept_id FROM concept_lexemes
                             WHERE concept_id IN ({placeholders})
                               AND lexeme_id=? AND role='primary'
                               AND retired_version IS NULL""",
                        (*resolved_ids, lexeme_id),
                    ).fetchall()
                }
                if linked != set(resolved_ids):
                    raise ConceptMergeConflictError(
                        "merge concepts must have active primary links to the same lexeme"
                    )
                self._authorized_merge_decision(
                    connection,
                    decision_id,
                    set(resolved_ids),
                    lexeme_id,
                )
            if len(resolved_ids) < 2:
                current_version = int(
                    connection.execute(
                        "SELECT MAX(id) FROM knowledge_versions"
                    ).fetchone()[0]
                )
                canonical_id = resolved_ids[0]
                return {
                    "canonical_id": canonical_id,
                    "merged_concept_ids": [],
                    "changed": False,
                    "change_ids": [],
                    "knowledge_version": current_version,
                    "decision_id": decision_id,
                    "reason": reason,
                    "selection_key": {
                        "criterion": "already_canonical",
                        "concept_id": canonical_id,
                    },
                    "rule_conflicts": 0,
                }
            if human_authorized_cross_lexeme:
                self._reject_locked_concept_conflicts(rows)
            else:
                self._reject_protected_merge_conflicts(
                    connection,
                    rows,
                    set(resolved_ids),
                    lexeme_id,
                )

            def effective_target(row: sqlite3.Row) -> str:
                return str(
                    row["verified_target"]
                    or row["working_target"]
                    or row["default_target"]
                    or ""
                ).strip()

            def selection_values(row: sqlite3.Row) -> tuple[Any, ...]:
                verified = bool(str(row["verified_target"] or "").strip()) or (
                    str(row["status"]) == "verified"
                )
                references = int(row["mention_count"]) + int(
                    row["dependency_count"]
                )
                return (
                    bool(row["locked"]),
                    verified,
                    bool(effective_target(row)),
                    references,
                    str(row["created_at"]),
                    str(row["id"]),
                )

            ranked = sorted(
                rows,
                key=lambda row: (
                    -int(selection_values(row)[0]),
                    -int(selection_values(row)[1]),
                    -int(selection_values(row)[2]),
                    -int(selection_values(row)[3]),
                    selection_values(row)[4],
                    selection_values(row)[5],
                ),
            )
            if human_authorized_cross_lexeme:
                ranked = sorted(
                    ranked,
                    key=lambda row: str(row["id"]) != preferred_canonical_id,
                )
            canonical = ranked[0]
            runner_up = ranked[1]
            canonical_values = selection_values(canonical)
            runner_values = selection_values(runner_up)
            criteria = (
                "locked",
                "verified",
                "target",
                "references",
                "created_at",
                "unicode_id",
            )
            criterion = (
                "human_canonical_source"
                if human_authorized_cross_lexeme
                else next(
                    (
                        name
                        for index, name in enumerate(criteria)
                        if canonical_values[index] != runner_values[index]
                    ),
                    "unicode_id",
                )
            )
            canonical_id = str(canonical["id"])
            merged_ids = sorted(set(resolved_ids) - {canonical_id})
            old_render_states = {
                concept_id: self._render_state_for_subject(
                    connection, "concept", concept_id
                )
                for concept_id in resolved_ids
            }
            merged_placeholders = ",".join("?" for _ in merged_ids)
            version = self.create_knowledge_version(
                f"merge concepts: {reason}", connection
            )
            now = utc_now()

            active_profiles: list[dict[str, Any]] = []
            for row in rows:
                if row["profile_created_version"] is None:
                    continue
                active_profiles.append(
                    {
                        "subject_id": str(row["id"]),
                        "semantic_core": str(
                            row["profile_semantic_core"] or ""
                        ).strip(),
                        "contrast_sources": self._decoded_json_array(
                            row["profile_contrast_sources_json"] or "[]",
                            field="term profile contrast sources",
                        ),
                        "status": str(
                            row["profile_status"] or "provisional"
                        ),
                        "locked": bool(row["profile_locked"]),
                        "created_version": int(row["profile_created_version"]),
                    }
                )
            if active_profiles:
                canonical_profiles = [
                    profile
                    for profile in active_profiles
                    if profile["subject_id"] == canonical_id
                ]
                preferred_profile = (
                    canonical_profiles[0]
                    if canonical_profiles
                    else sorted(
                        active_profiles,
                        key=lambda profile: (
                            -int(profile["locked"]),
                            -int(profile["status"] == "verified"),
                            -int(profile["created_version"]),
                            profile["subject_id"],
                        ),
                    )[0]
                )
                merged_contrasts = sorted(
                    {
                        str(value).strip()
                        for profile in active_profiles
                        for value in profile["contrast_sources"]
                        if str(value).strip()
                    },
                    key=str.casefold,
                )
                merged_status = (
                    "verified"
                    if any(
                        profile["status"] == "verified"
                        for profile in active_profiles
                    )
                    else preferred_profile["status"]
                )
                merged_locked = any(
                    profile["locked"] for profile in active_profiles
                )
                connection.execute(
                    f"""UPDATE term_profiles SET retired_version=?
                         WHERE subject_type='concept'
                           AND subject_id IN ({placeholders})
                           AND retired_version IS NULL""",
                    (version, *resolved_ids),
                )
                connection.execute(
                    """INSERT INTO term_profiles(
                           subject_type, subject_id, semantic_core,
                           contrast_sources_json, status, locked,
                           created_version, created_at)
                       VALUES('concept', ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        canonical_id,
                        preferred_profile["semantic_core"],
                        json.dumps(
                            merged_contrasts,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                        merged_status,
                        int(merged_locked),
                        version,
                        now,
                    ),
                )

            rule_rows = connection.execute(
                f"""SELECT * FROM rendering_rules
                     WHERE concept_id IN ({placeholders})
                       AND retired_version IS NULL
                     ORDER BY id""",
                resolved_ids,
            ).fetchall()
            rules_by_condition: dict[str, list[sqlite3.Row]] = {}
            normalized_conditions: dict[str, str] = {}
            for row in rule_rows:
                normalized = self._canonical_json_text(
                    row["condition_json"], field="rendering rule condition"
                )
                normalized_conditions[str(row["id"])] = normalized
                rules_by_condition.setdefault(normalized, []).append(row)
            rule_mapping: dict[str, str] = {}
            rule_survivors: set[str] = set()
            retired_rule_ids: set[str] = set()
            conflicts: list[dict[str, Any]] = []
            for condition, condition_rows in sorted(rules_by_condition.items()):
                targets = {str(row["target"]) for row in condition_rows}
                if len(targets) > 1:
                    ids = sorted(str(row["id"]) for row in condition_rows)
                    retired_rule_ids.update(ids)
                    conflict_material = json.dumps(
                        [
                            (
                                str(row["id"]),
                                str(row["target"]),
                                int(row["priority"]),
                            )
                            for row in sorted(
                                condition_rows, key=lambda item: str(item["id"])
                            )
                        ],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    conflicts.append(
                        {
                            "condition": condition,
                            "condition_sha256": hashlib.sha256(
                                condition.encode("utf-8")
                            ).hexdigest(),
                            "conflict_digest": hashlib.sha256(
                                (condition + "\n" + conflict_material).encode("utf-8")
                            ).hexdigest(),
                            "ids": ids,
                            "targets": sorted(targets),
                        }
                    )
                    continue
                exact: dict[tuple[str, str, int], list[sqlite3.Row]] = {}
                for row in condition_rows:
                    exact.setdefault(
                        (condition, str(row["target"]), int(row["priority"])),
                        [],
                    ).append(row)
                for duplicates in exact.values():
                    winner = min(
                        duplicates,
                        key=lambda row: (
                            -int(bool(row["locked"])),
                            str(row["created_at"]),
                            str(row["id"]),
                        ),
                    )
                    winner_id = str(winner["id"])
                    rule_survivors.add(winner_id)
                    for duplicate in duplicates:
                        duplicate_id = str(duplicate["id"])
                        if duplicate_id == winner_id:
                            continue
                        retired_rule_ids.add(duplicate_id)
                        rule_mapping[duplicate_id] = winner_id

            dependency_rows = connection.execute(
                f"""SELECT d.* FROM dependencies d
                     JOIN translation_versions tv ON tv.id=d.translation_id
                     WHERE d.dependency_type='concept'
                       AND d.dependency_id IN ({placeholders})
                       AND tv.active=1
                     ORDER BY d.translation_id, d.id""",
                resolved_ids,
            ).fetchall()
            dependency_groups: dict[int, list[sqlite3.Row]] = {}
            for row in dependency_rows:
                dependency_groups.setdefault(int(row["translation_id"]), []).append(row)
            dependency_plan: list[tuple[Any, ...]] = []
            for translation_id, group in sorted(dependency_groups.items()):
                winner = min(
                    group,
                    key=lambda row: (
                        str(row["dependency_id"]) != canonical_id,
                        int(row["id"]),
                    ),
                )
                applied_values: list[Any] = []
                span_values: list[Any] = []
                for row in group:
                    for rule_id in self._decoded_json_array(
                        row["applied_rule_ids_json"],
                        field="applied_rule_ids_json",
                    ):
                        normalized_rule_id = rule_mapping.get(str(rule_id), str(rule_id))
                        applied_values.append(normalized_rule_id)
                    span_values.extend(
                        self._decoded_json_array(
                            row["source_spans_json"],
                            field="source_spans_json",
                        )
                    )
                dependency_plan.append(
                    (
                        int(winner["id"]),
                        translation_id,
                        canonical_id,
                        version,
                        self._merge_fingerprints(
                            row["dependency_fingerprint"] for row in group
                        ),
                        self._merged_text(row["matched_form"] for row in group),
                        sum(int(row["occurrence_count"] or 0) for row in group),
                        self._merged_text(row["rendered_target"] for row in group),
                        json.dumps(
                            self._stable_json_union(applied_values),
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                        json.dumps(
                            self._stable_json_union(span_values),
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                    )
                )

            dependency_temp = f"merge_dependency_{uuid.uuid4().hex}"
            dependency_member_temp = f"merge_dependency_member_{uuid.uuid4().hex}"
            connection.execute(
                f"""CREATE TEMP TABLE {dependency_temp}(
                       winner_id INTEGER PRIMARY KEY,
                       translation_id INTEGER NOT NULL,
                       dependency_id TEXT NOT NULL,
                       knowledge_version INTEGER NOT NULL,
                       dependency_fingerprint TEXT NOT NULL,
                       matched_form TEXT NOT NULL,
                       occurrence_count INTEGER NOT NULL,
                       rendered_target TEXT NOT NULL,
                       applied_rule_ids_json TEXT NOT NULL,
                       source_spans_json TEXT NOT NULL)"""
            )
            connection.execute(
                f"""CREATE TEMP TABLE {dependency_member_temp}(
                       dependency_row_id INTEGER PRIMARY KEY)"""
            )
            if dependency_plan:
                connection.executemany(
                    f"INSERT INTO {dependency_temp} VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    dependency_plan,
                )
                connection.executemany(
                    f"INSERT INTO {dependency_member_temp} VALUES(?)",
                    [(int(row["id"]),) for row in dependency_rows],
                )
                connection.execute(
                    f"""DELETE FROM dependencies
                         WHERE id IN (
                                   SELECT dependency_row_id
                                   FROM {dependency_member_temp}
                               )
                           AND id NOT IN (SELECT winner_id FROM {dependency_temp})""",
                )
                connection.execute(
                    f"""UPDATE dependencies
                         SET dependency_id=(SELECT dependency_id FROM {dependency_temp}
                                            WHERE winner_id=dependencies.id),
                             knowledge_version=(SELECT knowledge_version FROM {dependency_temp}
                                                WHERE winner_id=dependencies.id),
                             dependency_fingerprint=(SELECT dependency_fingerprint FROM {dependency_temp}
                                                     WHERE winner_id=dependencies.id),
                             matched_form=(SELECT matched_form FROM {dependency_temp}
                                           WHERE winner_id=dependencies.id),
                             occurrence_count=(SELECT occurrence_count FROM {dependency_temp}
                                               WHERE winner_id=dependencies.id),
                             rendered_target=(SELECT rendered_target FROM {dependency_temp}
                                              WHERE winner_id=dependencies.id),
                             applied_rule_ids_json=(SELECT applied_rule_ids_json FROM {dependency_temp}
                                                    WHERE winner_id=dependencies.id),
                             source_spans_json=(SELECT source_spans_json FROM {dependency_temp}
                                               WHERE winner_id=dependencies.id)
                         WHERE id IN (SELECT winner_id FROM {dependency_temp})"""
                )
            connection.execute(f"DROP TABLE {dependency_member_temp}")
            connection.execute(f"DROP TABLE {dependency_temp}")

            connection.execute(
                f"UPDATE mentions SET concept_id=? WHERE concept_id IN ({merged_placeholders})",
                (canonical_id, *merged_ids),
            )
            connection.execute(
                f"""UPDATE candidate_resolutions SET concept_id=?
                     WHERE concept_id IN ({merged_placeholders})
                       AND adjudication_id IN (
                           SELECT id FROM candidate_adjudications WHERE active=1)""",
                (canonical_id, *merged_ids),
            )
            connection.execute(
                f"""UPDATE concept_type_observations SET concept_id=?
                     WHERE concept_id IN ({merged_placeholders})
                       AND retired_version IS NULL""",
                (canonical_id, *merged_ids),
            )

            active_links = connection.execute(
                f"""SELECT * FROM concept_lexemes
                     WHERE concept_id IN ({placeholders})
                       AND retired_version IS NULL
                     ORDER BY lexeme_id, role, concept_id, created_at""",
                resolved_ids,
            ).fetchall()

            def transferred_role(row: sqlite3.Row) -> str:
                role = str(row["role"])
                if (
                    human_authorized_cross_lexeme
                    and str(row["concept_id"]) != canonical_id
                    and str(row["lexeme_id"]) != lexeme_id
                    and role == "primary"
                ):
                    return "alias"
                return role

            canonical_link_keys = {
                (str(row["lexeme_id"]), str(row["role"]))
                for row in active_links
                if str(row["concept_id"]) == canonical_id
            }
            transfer_links: dict[tuple[str, str], sqlite3.Row] = {}
            for row in active_links:
                if str(row["concept_id"]) == canonical_id:
                    continue
                key = (str(row["lexeme_id"]), transferred_role(row))
                if key in canonical_link_keys:
                    continue
                previous = transfer_links.get(key)
                if previous is None or (
                    -int(str(row["status"]) == "verified"),
                    -float(row["confidence"]),
                    -int(row["evidence_id"] is not None),
                    str(row["created_at"]),
                    str(row["concept_id"]),
                ) < (
                    -int(str(previous["status"]) == "verified"),
                    -float(previous["confidence"]),
                    -int(previous["evidence_id"] is not None),
                    str(previous["created_at"]),
                    str(previous["concept_id"]),
                ):
                    transfer_links[key] = row
            if transfer_links:
                connection.executemany(
                    """INSERT INTO concept_lexemes(
                           concept_id, lexeme_id, role, confidence, status,
                           evidence_id, created_version, created_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                    [
                        (
                            canonical_id,
                            row["lexeme_id"],
                            transferred_role(row),
                            row["confidence"],
                            row["status"],
                            row["evidence_id"],
                            version,
                            now,
                        )
                        for _, row in sorted(transfer_links.items())
                    ],
                )
            connection.execute(
                f"""UPDATE concept_lexemes SET retired_version=?
                     WHERE concept_id IN ({merged_placeholders})
                       AND retired_version IS NULL""",
                (version, *merged_ids),
            )

            rule_temp = f"merge_rule_{uuid.uuid4().hex}"
            connection.execute(
                f"""CREATE TEMP TABLE {rule_temp}(
                       id TEXT PRIMARY KEY,
                       retire INTEGER NOT NULL,
                       concept_id TEXT,
                       condition_json TEXT)"""
            )
            rule_plan = [
                (
                    str(row["id"]),
                    int(str(row["id"]) in retired_rule_ids),
                    canonical_id if str(row["id"]) in rule_survivors else None,
                    normalized_conditions[str(row["id"])]
                    if str(row["id"]) in rule_survivors
                    else None,
                )
                for row in rule_rows
            ]
            if rule_plan:
                connection.executemany(
                    f"INSERT INTO {rule_temp} VALUES(?, ?, ?, ?)",
                    rule_plan,
                )
                connection.execute(
                    f"""UPDATE rendering_rules
                         SET retired_version=CASE
                                 WHEN (SELECT retire FROM {rule_temp}
                                       WHERE id=rendering_rules.id)=1
                                 THEN ? ELSE retired_version END,
                             concept_id=COALESCE(
                                 (SELECT concept_id FROM {rule_temp}
                                  WHERE id=rendering_rules.id), concept_id),
                             condition_json=COALESCE(
                                 (SELECT condition_json FROM {rule_temp}
                                  WHERE id=rendering_rules.id), condition_json)
                         WHERE id IN (SELECT id FROM {rule_temp})""",
                    (version,),
                )
            connection.execute(f"DROP TABLE {rule_temp}")

            existing_conflicts = {
                str(row[0])
                for row in connection.execute(
                    """SELECT json_extract(payload_json, '$.conflict_digest')
                       FROM human_queue
                       WHERE kind='render_rule_conflict' AND status='open'"""
                ).fetchall()
                if row[0]
            }
            queue_rows: list[tuple[str, str]] = []
            for conflict in conflicts:
                if conflict["conflict_digest"] in existing_conflicts:
                    continue
                condition = str(conflict["condition"])
                condition_payload: Any
                if len(condition) <= MAX_RULE_CONFLICT_CONDITION_CHARS:
                    condition_payload = json.loads(condition)
                else:
                    condition_payload = {
                        "sha256": conflict["condition_sha256"],
                        "preview": condition[:MAX_RULE_CONFLICT_CONDITION_CHARS],
                        "truncated": True,
                    }
                payload = {
                    "canonical_concept_id": canonical_id,
                    "decision_id": decision_id,
                    "condition": condition_payload,
                    "condition_sha256": conflict["condition_sha256"],
                    "conflict_digest": conflict["conflict_digest"],
                    "rule_count": len(conflict["ids"]),
                    "rule_ids": conflict["ids"][:MAX_RULE_CONFLICT_IDS],
                    "omitted_rule_ids": max(
                        0, len(conflict["ids"]) - MAX_RULE_CONFLICT_IDS
                    ),
                    "targets": [
                        target[:512]
                        for target in conflict["targets"][:MAX_RULE_CONFLICT_TARGETS]
                    ],
                    "target_count": len(conflict["targets"]),
                    "omitted_targets": max(
                        0,
                        len(conflict["targets"]) - MAX_RULE_CONFLICT_TARGETS,
                    ),
                }
                queue_rows.append(
                    (
                        json.dumps(
                            payload,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        now,
                    )
                )
            if queue_rows:
                connection.executemany(
                    """INSERT INTO human_queue(
                           block_id, kind, severity, status, payload_json, created_at)
                       VALUES(NULL, 'render_rule_conflict', 'warning', 'open', ?, ?)""",
                    queue_rows,
                )

            connection.executemany(
                """INSERT INTO concept_redirects(
                       retired_concept_id, canonical_concept_id, reason,
                       knowledge_version, created_at)
                   VALUES(?, ?, ?, ?, ?)""",
                [
                    (old_id, canonical_id, reason, version, now)
                    for old_id in merged_ids
                ],
            )
            connection.execute(
                f"""UPDATE concepts SET status='merged', retired_version=?
                     WHERE id IN ({merged_placeholders})
                       AND retired_version IS NULL""",
                (version, *merged_ids),
            )

            merged_digest = hashlib.sha256(
                json.dumps(
                    merged_ids,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            canonical_payload = {
                "canonical_id": canonical_id,
                "decision_id": decision_id,
                "authorization_type": (
                    "human_concept_form"
                    if human_authorized_cross_lexeme
                    else "coreference_decision"
                ),
                "reason": reason[:2_000],
                "merged_concept_ids": merged_ids[:MAX_MERGE_AUDIT_IDS],
                "merged_count": len(merged_ids),
                "omitted_concept_ids": max(
                    0, len(merged_ids) - MAX_MERGE_AUDIT_IDS
                ),
                "merged_ids_sha256": merged_digest,
                "dependency_count": len(dependency_groups),
                "rule_conflict_count": len(conflicts),
                "rule_redirect_count": len(rule_mapping),
                "selection_criterion": criterion,
            }
            canonical_new_state = self._render_state_for_subject(
                connection, "concept", canonical_id
            )
            canonical_new_state["effective_subject_link"] = (
                f"merge:{canonical_id}:{merged_digest}"
            )
            change_ids: list[int] = []
            change = self.record_render_change(
                connection,
                subject_type="concept",
                subject_id=canonical_id,
                old_state=old_render_states[canonical_id],
                new_state=canonical_new_state,
                change_kind="concept_merge",
                reason=f"{reason}; decision={decision_id}",
                knowledge_version=version,
            )
            if change["change_id"] is not None:
                change_ids.append(int(change["change_id"]))
            for old_id in merged_ids:
                change = self.record_render_change(
                    connection,
                    subject_type="concept",
                    subject_id=old_id,
                    old_state=old_render_states[old_id],
                    new_state=self._render_state_for_subject(
                        connection, "concept", old_id
                    ),
                    change_kind="concept_redirect",
                    reason=f"{reason}; canonical={canonical_id}",
                    knowledge_version=version,
                )
                if change["change_id"] is not None:
                    change_ids.append(int(change["change_id"]))
            self.record_audit_call(
                run_id=None,
                block_id=None,
                purpose="concept_merge",
                model="none",
                knowledge_version=version,
                request={
                    "actor_type": (
                        "human"
                        if human_authorized_cross_lexeme
                        else "deterministic"
                    ),
                    "decision_id": decision_id,
                    "merged_ids_sha256": merged_digest,
                },
                raw_response="",
                parsed=canonical_payload,
                accepted=True,
                attempts=1,
                elapsed_ms=0,
                error=None,
                connection=connection,
                archive_payload=False,
            )
            return {
                "canonical_id": canonical_id,
                "merged_concept_ids": merged_ids,
                "changed": True,
                "change_ids": sorted(set(change_ids)),
                "knowledge_version": version,
                "decision_id": decision_id,
                "reason": reason,
                "selection_key": {
                    "criterion": criterion,
                    "locked": canonical_values[0],
                    "verified": canonical_values[1],
                    "has_target": canonical_values[2],
                    "reference_count": canonical_values[3],
                    "created_at": canonical_values[4],
                    "concept_id": canonical_id,
                },
                "rule_conflicts": len(conflicts),
            }

    def _audit_transaction_for(
        self, connection: sqlite3.Connection
    ) -> AuditArchiveTransaction:
        with self._audit_transactions_lock:
            transaction = self._audit_transactions.get(id(connection))
        if transaction is None:
            raise RuntimeError(
                "accepted audit persistence requires a managed database transaction"
            )
        return transaction

    @staticmethod
    def _source_bytes(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            """SELECT COALESCE(SUM(LENGTH(CAST(b.source_text AS BLOB))), 0)
               FROM blocks b
               JOIN source_editions s ON s.id=b.source_edition_id
               WHERE s.active=1"""
        ).fetchone()
        return int(row[0] or 0)

    @staticmethod
    def _active_database_bytes(connection: sqlite3.Connection) -> int:
        page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        return page_count * page_size

    def _check_storage_budget(self, connection: sqlite3.Connection) -> None:
        StorageBudget(self._source_bytes(connection)).check(
            self._active_database_bytes(connection)
        )

    @staticmethod
    def _associate_schema8_lexeme(
        connection: sqlite3.Connection,
        lexeme_id: str,
        concept_id: str,
        *,
        knowledge_version: int | None = None,
        created_at: str | None = None,
    ) -> None:
        """Associate an existing lexeme without deriving it from a surface form."""

        concept = connection.execute(
            """SELECT created_version, primary_lexeme_id
               FROM concepts WHERE id=?""",
            (concept_id,),
        ).fetchone()
        if concept is None:
            raise KeyError(f"concept does not exist: {concept_id}")
        if knowledge_version is None:
            knowledge_version = int(concept["created_version"])
        now = created_at or utc_now()
        connection.execute(
            """UPDATE concepts
               SET primary_lexeme_id=COALESCE(primary_lexeme_id, ?)
               WHERE id=?""",
            (lexeme_id, concept_id),
        )
        primary_lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()[0]
        role = "primary" if primary_lexeme_id == lexeme_id else "alias"
        connection.execute(
            """INSERT OR IGNORE INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, ?, ?, 1.0, 'provisional', ?, ?)""",
            (concept_id, lexeme_id, role, knowledge_version, now),
        )

    def _ensure_lexeme_record(
        self,
        connection: sqlite3.Connection,
        source_form: str,
        *,
        language: str,
        knowledge_version: int | None = None,
        created_at: str | None = None,
    ) -> tuple[str, str]:
        if not isinstance(language, str) or not language.strip():
            raise ValueError("lexeme language cannot be empty")
        if not isinstance(source_form, str) or not source_form:
            raise ValueError("lexeme source form cannot be empty")
        normalized = normalize_english_form(source_form)
        if not normalized:
            raise ValueError("lexeme normalized form cannot be empty")
        lexeme_id = stable_id("lexeme", f"{language}:{normalized}")
        if knowledge_version is None:
            knowledge_version = int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
        connection.execute(
            """INSERT OR IGNORE INTO lexemes(
                   id, language, normalized_form, canonical_form,
                   created_version, created_at)
               VALUES(?, ?, ?, ?, ?, ?)""",
            (
                lexeme_id,
                language,
                normalized,
                source_form,
                knowledge_version,
                created_at or utc_now(),
            ),
        )
        active = connection.execute(
            """SELECT id FROM lexemes
               WHERE language=? AND normalized_form=?
                     AND retired_version IS NULL""",
            (language, normalized),
        ).fetchone()
        if active is None or str(active[0]) != lexeme_id:
            raise RuntimeError(
                "active lexeme violates the stable ownership identity"
            )
        return lexeme_id, normalized

    def ensure_lexeme(
        self,
        source_form: str,
        *,
        language: str = "en",
        connection: sqlite3.Connection | None = None,
    ) -> str:
        if connection is None:
            with self.transaction() as owned_connection:
                return self.ensure_lexeme(
                    source_form,
                    language=language,
                    connection=owned_connection,
                )
        self._require_active_transaction(connection)
        lexeme_id, normalized = self._ensure_lexeme_record(
            connection,
            source_form,
            language=language,
        )
        connection.execute(
            """INSERT OR IGNORE INTO source_forms(
                   lexeme_id, form, normalized_form, grammar_json)
               VALUES(?, ?, ?, '{}')""",
            (lexeme_id, source_form, normalized),
        )
        return lexeme_id

    def ensure_concept_for_anchor(
        self,
        lexeme_id: str,
        anchor_mention_id: int,
        *,
        kind: str = "concept",
        connection: sqlite3.Connection | None = None,
    ) -> str:
        """Return the stable active concept owned by one immutable mention anchor."""

        if connection is not None:
            self._require_active_transaction(connection)
        if not isinstance(lexeme_id, str) or not lexeme_id.strip():
            raise ValueError("concept anchor lexeme_id cannot be empty")
        if (
            not isinstance(anchor_mention_id, int)
            or isinstance(anchor_mention_id, bool)
            or anchor_mention_id <= 0
        ):
            raise ValueError("concept anchor mention id must be a positive integer")
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("concept kind cannot be empty")
        if connection is None:
            with self.transaction() as owned_connection:
                return self.ensure_concept_for_anchor(
                    lexeme_id,
                    anchor_mention_id,
                    kind=kind,
                    connection=owned_connection,
                )

        mention = connection.execute(
            """SELECT m.lexeme_id, m.concept_id
               FROM mentions m
               JOIN blocks b ON b.id=m.block_id
               JOIN source_editions se
                 ON se.id=b.source_edition_id AND se.active=1
               JOIN lexemes l
                 ON l.id=m.lexeme_id AND l.retired_version IS NULL
               WHERE m.id=?""",
            (anchor_mention_id,),
        ).fetchone()
        if mention is None:
            exists = connection.execute(
                "SELECT 1 FROM mentions WHERE id=?", (anchor_mention_id,)
            ).fetchone()
            if exists is None:
                raise KeyError(f"mention does not exist: {anchor_mention_id}")
            raise ValueError(
                f"mention is not part of the active source edition: "
                f"{anchor_mention_id}"
            )
        if str(mention["lexeme_id"]) != lexeme_id:
            raise ValueError("anchor mention must belong to the requested lexeme")

        concept_id = stable_id(
            "concept", f"{lexeme_id}:{anchor_mention_id}"
        )
        existing = connection.execute(
            """SELECT id, primary_lexeme_id, anchor_mention_id, retired_version
               FROM concepts WHERE id=?""",
            (concept_id,),
        ).fetchone()
        competing_owners = [
            str(row["id"])
            for row in connection.execute(
                """SELECT id FROM concepts
                   WHERE anchor_mention_id=? AND id!=?
                   ORDER BY id""",
                (anchor_mention_id, concept_id),
            ).fetchall()
        ]
        if competing_owners:
            raise ConceptAnchorConflictError(
                f"concept anchor collision for mention {anchor_mention_id}: "
                f"{', '.join(competing_owners)}"
            )
        if existing is not None:
            if existing["retired_version"] is not None:
                raise ConceptAnchorConflictError(
                    f"stable anchor concept is retired and cannot be revived: "
                    f"{concept_id}"
                )
            if (
                str(existing["primary_lexeme_id"] or "") != lexeme_id
                or existing["anchor_mention_id"] != anchor_mention_id
            ):
                raise ConceptAnchorConflictError(
                    f"stable concept id collision violates immutable anchor: "
                    f"{concept_id}"
                )
            if mention["concept_id"] is not None:
                bound_id = str(mention["concept_id"])
                bound_canonical = bound_id
                if bound_id != concept_id:
                    bound_canonical, _ = self._active_canonical_concept(
                        connection,
                        bound_id,
                        expected_lexeme_id=lexeme_id,
                    )
                if bound_canonical != concept_id:
                    raise ConceptAnchorConflictError(
                        "anchor mention binding disagrees with its immutable "
                        f"concept owner: {anchor_mention_id}"
                    )
        else:
            if mention["concept_id"] is not None:
                raise ConceptAnchorConflictError(
                    f"anchor mention already belongs to a different concept: "
                    f"{mention['concept_id']}"
                )

        conflicting_primary = connection.execute(
            """SELECT lexeme_id FROM concept_lexemes
               WHERE concept_id=? AND role='primary'
                     AND retired_version IS NULL AND lexeme_id!=?
               ORDER BY lexeme_id LIMIT 1""",
            (concept_id, lexeme_id),
        ).fetchone()
        if conflicting_primary is not None:
            raise ConceptAnchorConflictError(
                f"stable concept primary lexeme collision: {concept_id}"
            )
        active_link = connection.execute(
            """SELECT 1 FROM concept_lexemes
               WHERE concept_id=? AND lexeme_id=? AND role='primary'
                     AND retired_version IS NULL""",
            (concept_id, lexeme_id),
        ).fetchone()
        retired_link = connection.execute(
            """SELECT 1 FROM concept_lexemes
               WHERE concept_id=? AND lexeme_id=? AND role='primary'
                     AND retired_version IS NOT NULL""",
            (concept_id, lexeme_id),
        ).fetchone()
        if existing is not None and active_link is None and retired_link is not None:
            raise ConceptAnchorConflictError(
                f"retired concept/lexeme ownership cannot be revived: {concept_id}"
            )

        lexeme = connection.execute(
            """SELECT canonical_form FROM lexemes
               WHERE id=? AND retired_version IS NULL""",
            (lexeme_id,),
        ).fetchone()
        if lexeme is None:
            raise KeyError(f"active lexeme does not exist: {lexeme_id}")
        version = int(
            connection.execute(
                "SELECT MAX(id) FROM knowledge_versions"
            ).fetchone()[0]
        )
        with self._method_savepoint(connection, "concept_anchor"):
            if existing is None:
                connection.execute(
                    """INSERT INTO concepts(
                           id, kind, canonical_source, primary_lexeme_id,
                           anchor_mention_id, created_version, created_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?)""",
                    (
                        concept_id,
                        kind.strip(),
                        str(lexeme["canonical_form"]),
                        lexeme_id,
                        anchor_mention_id,
                        version,
                        utc_now(),
                    ),
                )
            if active_link is None:
                connection.execute(
                    """INSERT INTO concept_lexemes(
                           concept_id, lexeme_id, role, confidence, status,
                           created_version, created_at)
                       VALUES(?, ?, 'primary', 1.0, 'provisional', ?, ?)""",
                    (concept_id, lexeme_id, version, utc_now()),
                )
        return concept_id

    def bind_mentions(
        self,
        concept_id: str,
        mention_ids: Sequence[int],
        *,
        connection: sqlite3.Connection | None = None,
    ) -> int:
        """Bind active same-lexeme mentions without overriding protected identity."""

        if connection is not None:
            self._require_active_transaction(connection)
        if not isinstance(concept_id, str) or not concept_id.strip():
            raise ValueError("concept_id cannot be empty")
        if isinstance(mention_ids, (str, bytes)):
            raise ValueError("mention_ids must be a sequence of integers")
        raw_ids = tuple(mention_ids)
        if any(
            not isinstance(value, int)
            or isinstance(value, bool)
            or value <= 0
            for value in raw_ids
        ):
            raise ValueError("mention_ids must contain positive integers")
        ordered_ids = tuple(sorted(set(raw_ids)))
        if connection is None:
            with self.transaction() as owned_connection:
                return self.bind_mentions(
                    concept_id,
                    ordered_ids,
                    connection=owned_connection,
                )

        requested_concept_id = concept_id
        requested_target = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()
        if requested_target is None:
            raise KeyError(f"concept does not exist: {concept_id}")
        expected_lexeme_id = str(requested_target["primary_lexeme_id"] or "")
        canonical_id, _ = self._active_canonical_concept(
            connection,
            concept_id,
            expected_lexeme_id=expected_lexeme_id,
        )
        if canonical_id is None:
            raise ValueError(
                f"concept redirect has no active canonical target: {concept_id}"
            )
        concept_id = canonical_id
        target = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()
        assert target is not None
        lexeme_id = str(target["primary_lexeme_id"] or "")
        active_primary = connection.execute(
            """SELECT lexeme_id FROM concept_lexemes
               WHERE concept_id=? AND role='primary'
                     AND retired_version IS NULL
               ORDER BY lexeme_id""",
            (concept_id,),
        ).fetchall()
        primary_ids = {str(row["lexeme_id"]) for row in active_primary}
        if not lexeme_id or primary_ids != {lexeme_id}:
            raise RuntimeError(
                f"active concept does not have one stable primary lexeme: {concept_id}"
            )
        if not ordered_ids:
            return 0

        placeholders = ",".join("?" for _ in ordered_ids)
        rows = connection.execute(
            f"""SELECT m.id, m.lexeme_id, m.concept_id
                FROM mentions m
                JOIN blocks b ON b.id=m.block_id
                JOIN source_editions se
                  ON se.id=b.source_edition_id AND se.active=1
                JOIN lexemes l
                  ON l.id=m.lexeme_id AND l.retired_version IS NULL
                WHERE m.id IN ({placeholders})
                ORDER BY m.id""",
            ordered_ids,
        ).fetchall()
        found_ids = {int(row["id"]) for row in rows}
        missing = sorted(set(ordered_ids) - found_ids)
        if missing:
            raise ValueError(
                f"mentions must exist in the active source edition: {missing}"
            )
        if any(str(row["lexeme_id"]) != lexeme_id for row in rows):
            raise ValueError("all mentions must belong to the same lexeme as concept")

        protected_decisions = connection.execute(
            """SELECT left_anchor_type, left_anchor_id,
                      right_anchor_type, right_anchor_id,
                      anchor_members_json
               FROM coreference_decisions
               WHERE lexeme_id=? AND retired_version IS NULL
                     AND relation IN ('different', 'non_entity')
                     AND (locked=1 OR decision_source='human')
               ORDER BY id""",
            (lexeme_id,),
        ).fetchall()

        def member_ids(value: Any) -> set[int]:
            try:
                decoded = json.loads(str(value or "[]"))
            except (TypeError, ValueError, json.JSONDecodeError):
                return set()
            found: set[int] = set()

            def collect(item: Any) -> None:
                if isinstance(item, bool):
                    return
                if isinstance(item, int):
                    found.add(item)
                elif isinstance(item, str) and item.isdigit():
                    found.add(int(item))
                elif isinstance(item, dict):
                    for key in ("mention_id", "id", "members", "mention_ids"):
                        if key in item:
                            collect(item[key])
                elif isinstance(item, (list, tuple)):
                    for nested in item:
                        collect(nested)

            collect(decoded)
            return found

        requested_mention_set_id = stable_id(
            "mention-set", ":".join(str(value) for value in ordered_ids)
        )
        protected_members: list[tuple[set[str], set[int]]] = []
        for row in protected_decisions:
            anchors: set[str] = set()
            for side in ("left", "right"):
                anchor_id = str(row[f"{side}_anchor_id"])
                anchors.add(anchor_id)
                if row[f"{side}_anchor_type"] == "concept":
                    canonical, _ = self._active_canonical_concept(
                        connection,
                        anchor_id,
                        expected_lexeme_id=lexeme_id,
                    )
                    if canonical is not None:
                        anchors.add(canonical)
            protected_members.append(
                (anchors, member_ids(row["anchor_members_json"]))
            )
        requested_identities = {requested_concept_id, concept_id}
        for row in rows:
            if row["concept_id"] is None:
                continue
            current_id = str(row["concept_id"])
            requested_identities.add(current_id)
            current_canonical, _ = self._active_canonical_concept(
                connection,
                current_id,
                expected_lexeme_id=lexeme_id,
            )
            if current_canonical is not None:
                requested_identities.add(current_canonical)
        if any(
            requested_mention_set_id in anchors
            or bool(set(ordered_ids) & members)
            or bool(requested_identities & anchors)
            for anchors, members in protected_members
        ):
            return 0

        anchor_owners = connection.execute(
            f"""SELECT id, anchor_mention_id FROM concepts
                WHERE retired_version IS NULL
                  AND anchor_mention_id IN ({placeholders})
                ORDER BY id""",
            ordered_ids,
        ).fetchall()
        for owner in anchor_owners:
            owner_id = str(owner["id"])
            owner_canonical, _ = self._active_canonical_concept(
                connection,
                owner_id,
                expected_lexeme_id=lexeme_id,
            )
            if owner_canonical != concept_id:
                raise ValueError(
                    "cannot rebind an immutable concept anchor mention: "
                    f"{owner['anchor_mention_id']}"
                )
        bindable: list[int] = []
        for row in rows:
            mention_id = int(row["id"])
            current_id = (
                str(row["concept_id"])
                if row["concept_id"] is not None
                else None
            )
            current_canonical = current_id
            if current_id is not None:
                resolved_current, _ = self._active_canonical_concept(
                    connection,
                    current_id,
                    expected_lexeme_id=lexeme_id,
                )
                current_canonical = resolved_current or current_id
            if current_id == concept_id:
                continue
            protected_pair = {
                value
                for value in (current_canonical, concept_id)
                if value is not None
            }
            if any(
                requested_mention_set_id in anchors
                or (
                    len(protected_pair) == 2
                    and protected_pair <= anchors
                )
                or mention_id in members
                for anchors, members in protected_members
            ):
                continue
            if current_id is not None:
                current = connection.execute(
                    """SELECT status, locked, retired_version
                       FROM concepts WHERE id=?""",
                    (current_id,),
                ).fetchone()
                if current is None:
                    continue
                if current["retired_version"] is None:
                    if bool(current["locked"]) or str(current["status"]) == "verified":
                        continue
                else:
                    current_canonical, _ = self._active_canonical_concept(
                        connection,
                        current_id,
                        expected_lexeme_id=lexeme_id,
                    )
                    if current_canonical != concept_id:
                        continue
            bindable.append(mention_id)

        with self._method_savepoint(connection, "bind_mentions"):
            changed = 0
            for mention_id in bindable:
                cursor = connection.execute(
                    """UPDATE mentions SET concept_id=?
                       WHERE id=? AND concept_id IS NOT ?""",
                    (concept_id, mention_id, concept_id),
                )
                changed += cursor.rowcount
        return changed

    def apply_coreference_fallback(
        self,
        lexeme_id: str,
        mention_ids: Sequence[int],
        *,
        connection: sqlite3.Connection | None = None,
    ) -> Dict[str, Any]:
        """Choose and persist one conservative lexeme-level working target.

        Existing lexeme/concept targets are evidence only.  Affected blocks vote
        through their currently bound concepts, and no concept identity is
        created or changed by this fallback.
        """

        if connection is not None:
            self._require_active_transaction(connection)
        if not isinstance(lexeme_id, str) or not lexeme_id.strip():
            raise ValueError("fallback lexeme_id cannot be empty")
        if isinstance(mention_ids, (str, bytes)):
            raise ValueError("fallback mention_ids must be integer ids")
        raw_ids = tuple(mention_ids)
        if any(
            not isinstance(value, int)
            or isinstance(value, bool)
            or value <= 0
            for value in raw_ids
        ):
            raise ValueError("fallback mention_ids must be positive integers")
        ordered_ids = tuple(sorted(set(raw_ids)))
        if connection is None:
            with self.transaction() as owned_connection:
                return self.apply_coreference_fallback(
                    lexeme_id,
                    ordered_ids,
                    connection=owned_connection,
                )

        lexeme = connection.execute(
            """SELECT default_target, working_target, verified_target,
                      status, locked, retired_version
               FROM lexemes WHERE id=?""",
            (lexeme_id,),
        ).fetchone()
        if lexeme is None or lexeme["retired_version"] is not None:
            raise ValueError(f"fallback requires an active lexeme: {lexeme_id}")
        old_render_state = self._render_state_for_subject(
            connection, "lexeme", lexeme_id
        )

        placeholders = ",".join("?" for _ in ordered_ids)
        if ordered_ids:
            active_mentions = connection.execute(
                f"""SELECT m.id, m.lexeme_id
                    FROM mentions m
                    JOIN blocks b ON b.id=m.block_id
                    JOIN source_editions se
                      ON se.id=b.source_edition_id AND se.active=1
                    JOIN lexemes l
                      ON l.id=m.lexeme_id AND l.retired_version IS NULL
                    WHERE m.id IN ({placeholders})
                    ORDER BY m.id""",
                ordered_ids,
            ).fetchall()
            active_by_id = {
                int(row["id"]): str(row["lexeme_id"])
                for row in active_mentions
            }
            if set(active_by_id) != set(ordered_ids):
                raise ValueError(
                    "fallback mentions must exist in the active source edition"
                )
            if any(value != lexeme_id for value in active_by_id.values()):
                raise ValueError(
                    "fallback mentions must belong to the requested lexeme"
                )

        candidates: Dict[str, Dict[str, Any]] = {}

        def add_candidate(
            target: Any,
            *,
            source: str,
            locked: bool = False,
            verified: bool = False,
            block_id: str | None = None,
        ) -> None:
            value = str(target or "").strip()
            if not value:
                return
            candidate = candidates.setdefault(
                value,
                {
                    "target": value,
                    "locked": False,
                    "verified": False,
                    "sources": set(),
                    "existing_sources": set(),
                    "blocks": set(),
                },
            )
            candidate["locked"] = candidate["locked"] or bool(locked)
            candidate["verified"] = candidate["verified"] or bool(verified)
            candidate["sources"].add(source)
            if block_id:
                candidate["blocks"].add(block_id)
            else:
                candidate["existing_sources"].add(source)

        lexeme_locked = bool(lexeme["locked"])
        lexeme_verified = str(lexeme["status"]) == "verified"
        for field in ("default_target", "working_target", "verified_target"):
            add_candidate(
                lexeme[field],
                source=f"lexeme.{field}",
                locked=lexeme_locked,
                verified=(field == "verified_target"),
            )

        mention_clause = (
            f"OR m.id IN ({placeholders})" if ordered_ids else ""
        )
        concept_parameters: tuple[Any, ...] = (
            lexeme_id,
            *ordered_ids,
        )
        concept_rows = connection.execute(
            f"""SELECT DISTINCT c.id, c.default_target, c.working_target,
                       c.verified_target, c.status, c.locked
                FROM concepts c
                LEFT JOIN concept_lexemes cl
                  ON cl.concept_id=c.id AND cl.retired_version IS NULL
                LEFT JOIN mentions m ON m.concept_id=c.id
                WHERE c.retired_version IS NULL
                  AND (cl.lexeme_id=? {mention_clause})
                ORDER BY c.id""",
            concept_parameters,
        ).fetchall()
        for row in concept_rows:
            concept_locked = bool(row["locked"])
            for field in ("default_target", "working_target", "verified_target"):
                add_candidate(
                    row[field],
                    source=f"concept:{row['id']}.{field}",
                    locked=concept_locked,
                    verified=(field == "verified_target"),
                )

        if ordered_ids:
            block_rows = connection.execute(
                f"""SELECT DISTINCT m.block_id, c.id AS concept_id,
                           c.default_target, c.working_target,
                           c.verified_target, c.status, c.locked
                    FROM mentions m
                    JOIN concepts c ON c.id=m.concept_id
                    WHERE m.id IN ({placeholders})
                      AND c.retired_version IS NULL
                    ORDER BY m.block_id, c.id""",
                ordered_ids,
            ).fetchall()
            for row in block_rows:
                target = (
                    str(row["verified_target"] or "").strip()
                    or str(row["working_target"] or "").strip()
                    or str(row["default_target"] or "").strip()
                )
                add_candidate(
                    target,
                    source=f"block:{row['block_id']}:concept:{row['concept_id']}",
                    locked=bool(row["locked"]),
                    verified=bool(row["verified_target"]),
                    block_id=str(row["block_id"]),
                )

        ranked: list[Dict[str, Any]] = []
        for candidate in candidates.values():
            support_count = len(candidate["existing_sources"])
            block_votes = len(candidate["blocks"])
            ranked.append(
                {
                    "target": candidate["target"],
                    "locked": bool(candidate["locked"]),
                    "verified": bool(candidate["verified"]),
                    "consistent": support_count >= 2,
                    "support_count": support_count,
                    "block_votes": block_votes,
                    "sources": sorted(candidate["sources"]),
                }
            )
        ranked.sort(
            key=lambda item: (
                -int(item["locked"]),
                -int(item["verified"]),
                -int(item["consistent"]),
                -int(item["block_votes"]),
                item["target"],
            )
        )
        selected_candidate = ranked[0] if ranked else None
        selected = str(selected_candidate["target"]) if selected_candidate else ""
        if not ranked:
            reason = "no_candidate"
        elif ranked[0]["locked"]:
            reason = "locked"
        elif ranked[0]["verified"]:
            reason = "verified"
        elif ranked[0]["consistent"]:
            reason = "existing_consistent"
        elif ranked[0]["block_votes"]:
            reason = "affected_block_majority"
        else:
            reason = "unicode_order"

        changed = False
        knowledge_version: int | None = None
        change_ids: list[int] = []
        if (
            selected
            and not lexeme_locked
            and not lexeme_verified
            and not str(lexeme["verified_target"] or "").strip()
            and (
                str(lexeme["default_target"] or "").strip() != selected
                or str(lexeme["working_target"] or "").strip() != selected
            )
        ):
            with self._method_savepoint(connection, "coreference_fallback_target"):
                cursor = connection.execute(
                    """UPDATE lexemes
                       SET default_target=?, working_target=?
                       WHERE id=? AND retired_version IS NULL AND locked=0
                         AND status!='verified' AND verified_target=''""",
                    (selected, selected, lexeme_id),
                )
                changed = bool(cursor.rowcount)
                if changed:
                    knowledge_version = self.create_knowledge_version(
                        f"coreference fallback target: {lexeme_id}", connection
                    )
                    change = self.record_render_change(
                        connection,
                        subject_type="lexeme",
                        subject_id=lexeme_id,
                        old_state=old_render_state,
                        new_state=self._render_state_for_subject(
                            connection, "lexeme", lexeme_id
                        ),
                        change_kind="target",
                        reason=f"coreference fallback target: {lexeme_id}",
                        knowledge_version=knowledge_version,
                    )
                    if change["change_id"] is not None:
                        change_ids.append(int(change["change_id"]))
        digest = hashlib.sha256()
        for candidate in ranked:
            digest.update(
                json.dumps(
                    candidate,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
            digest.update(b"\n")

        def bounded_text(value: Any) -> str:
            text = str(value)
            if len(text) <= MAX_COREFERENCE_FALLBACK_TEXT_CHARS:
                return text
            return text[: MAX_COREFERENCE_FALLBACK_TEXT_CHARS - 1] + "…"

        bounded_candidates: list[Dict[str, Any]] = []
        truncated = len(ranked) > MAX_COREFERENCE_FALLBACK_CANDIDATES
        for candidate in ranked[:MAX_COREFERENCE_FALLBACK_CANDIDATES]:
            all_sources = list(candidate["sources"])
            bounded_sources = [
                bounded_text(source)
                for source in all_sources[:MAX_COREFERENCE_FALLBACK_SOURCES]
            ]
            target = bounded_text(candidate["target"])
            target_truncated = target != candidate["target"]
            source_text_truncated = any(
                source != bounded
                for source, bounded in zip(all_sources, bounded_sources)
            )
            truncated = (
                truncated
                or len(all_sources) > MAX_COREFERENCE_FALLBACK_SOURCES
                or target_truncated
                or source_text_truncated
            )
            bounded_candidates.append(
                {
                    "target": target,
                    "target_sha256": hashlib.sha256(
                        str(candidate["target"]).encode("utf-8")
                    ).hexdigest(),
                    "locked": bool(candidate["locked"]),
                    "verified": bool(candidate["verified"]),
                    "consistent": bool(candidate["consistent"]),
                    "support_count": int(candidate["support_count"]),
                    "block_votes": int(candidate["block_votes"]),
                    "sources": bounded_sources,
                    "total_sources": len(all_sources),
                    "omitted_sources": max(
                        0, len(all_sources) - MAX_COREFERENCE_FALLBACK_SOURCES
                    ),
                }
            )

        return {
            "source": "fallback",
            "selected": bounded_text(selected),
            "selected_sha256": hashlib.sha256(
                selected.encode("utf-8")
            ).hexdigest(),
            "reason": reason,
            "changed": changed,
            "knowledge_version": knowledge_version,
            "change_ids": sorted(set(change_ids)),
            "candidates": bounded_candidates,
            "total_candidates": len(ranked),
            "omitted_candidates": max(
                0, len(ranked) - MAX_COREFERENCE_FALLBACK_CANDIDATES
            ),
            "selected_block_votes": (
                int(selected_candidate["block_votes"])
                if selected_candidate is not None
                else 0
            ),
            "selected_support_count": (
                int(selected_candidate["support_count"])
                if selected_candidate is not None
                else 0
            ),
            "payload_hash": digest.hexdigest(),
            "truncated": truncated,
        }

    def record_type_observation(
        self,
        lexeme_id: str,
        kind: str,
        *,
        confidence: float,
        source: str,
        mention_id: int | None = None,
        concept_id: str | None = None,
        evidence_id: int | None = None,
        adjudication_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> int:
        if connection is not None:
            self._require_active_transaction(connection)
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("type observation kind cannot be empty")
        if not isinstance(source, str) or not source.strip():
            raise ValueError("type observation source cannot be empty")
        try:
            confidence = float(confidence)
        except (TypeError, ValueError) as exc:
            raise ValueError("type observation confidence must be numeric") from exc
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("type observation confidence must be between 0 and 1")
        if connection is None:
            with self.transaction() as owned_connection:
                return self.record_type_observation(
                    lexeme_id,
                    kind,
                    confidence=confidence,
                    source=source,
                    mention_id=mention_id,
                    concept_id=concept_id,
                    evidence_id=evidence_id,
                    adjudication_id=adjudication_id,
                    connection=owned_connection,
                )
        existing = connection.execute(
            """SELECT id FROM concept_type_observations
               WHERE lexeme_id=? AND kind=? AND confidence=? AND source=?
                     AND mention_id IS ? AND concept_id IS ?
                     AND evidence_id IS ? AND adjudication_id IS ?
                     AND retired_version IS NULL
               ORDER BY id LIMIT 1""",
            (
                lexeme_id,
                kind,
                confidence,
                source,
                mention_id,
                concept_id,
                evidence_id,
                adjudication_id,
            ),
        ).fetchone()
        if existing is not None:
            return int(existing[0])
        version = int(
            connection.execute(
                "SELECT MAX(id) FROM knowledge_versions"
            ).fetchone()[0]
        )
        cursor = connection.execute(
            """INSERT INTO concept_type_observations(
                   concept_id, lexeme_id, mention_id, evidence_id, kind,
                   confidence, source, adjudication_id, created_version,
                   created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                concept_id,
                lexeme_id,
                mention_id,
                evidence_id,
                kind,
                confidence,
                source,
                adjudication_id,
                version,
                utc_now(),
            ),
        )
        return int(cursor.lastrowid)

    def record_form_occurrences(
        self,
        rows: Sequence[FormOccurrence],
        *,
        connection: sqlite3.Connection | None = None,
    ) -> int:
        if connection is not None:
            self._require_active_transaction(connection)
        rows = tuple(rows)
        if connection is None:
            with self.transaction() as owned_connection:
                return self.record_form_occurrences(
                    rows,
                    connection=owned_connection,
                )
        if not rows:
            return 0

        blocks: dict[str, Any] = {}
        active_lexemes: set[str] = set()
        for occurrence in rows:
            lexeme_id = occurrence.lexeme_id
            if not isinstance(lexeme_id, str) or not lexeme_id.strip():
                raise ValueError("form occurrence lexeme_id cannot be empty")
            if lexeme_id not in active_lexemes:
                active_lexeme = connection.execute(
                    """SELECT 1 FROM lexemes
                       WHERE id=? AND retired_version IS NULL""",
                    (lexeme_id,),
                ).fetchone()
                if active_lexeme is None:
                    raise KeyError(f"active lexeme does not exist: {lexeme_id}")
                active_lexemes.add(lexeme_id)
            block = blocks.get(occurrence.block_id)
            if block is None:
                block = connection.execute(
                    """SELECT b.source_text, b.source_hash, s.active
                       FROM blocks b
                       JOIN source_editions s ON s.id=b.source_edition_id
                       WHERE b.id=?""",
                    (occurrence.block_id,),
                ).fetchone()
                if block is None:
                    raise KeyError(f"block does not exist: {occurrence.block_id}")
                blocks[occurrence.block_id] = block
            if int(block[2]) != 1:
                raise ValueError(
                    f"block is not part of the active source edition: "
                    f"{occurrence.block_id}"
                )
            if str(block[1]) != occurrence.source_hash:
                raise ValueError(
                    f"source hash does not match block: {occurrence.block_id}"
                )
            start = occurrence.start_offset
            end = occurrence.end_offset
            source_text = str(block[0])
            if (
                not isinstance(start, int)
                or isinstance(start, bool)
                or not isinstance(end, int)
                or isinstance(end, bool)
                or not 0 <= start < end <= len(source_text)
            ):
                raise ValueError(
                    f"invalid half-open occurrence offsets for block: "
                    f"{occurrence.block_id}"
                )
            if source_text[start:end] != occurrence.source_form:
                raise ValueError(
                    f"source form does not match block slice: {occurrence.block_id}"
                )

        with self._method_savepoint(connection, "form_occurrences"):
            inserted = 0
            now = utc_now()
            for occurrence in rows:
                cursor = connection.execute(
                    """INSERT INTO form_occurrences(
                           lexeme_id, block_id, start_offset, end_offset,
                           source_form, source_hash, created_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(
                           lexeme_id, block_id, start_offset, end_offset
                       ) DO NOTHING""",
                    (
                        occurrence.lexeme_id,
                        occurrence.block_id,
                        occurrence.start_offset,
                        occurrence.end_offset,
                        occurrence.source_form,
                        occurrence.source_hash,
                        now,
                    ),
                )
                inserted += cursor.rowcount
        return inserted

    def _ensure_schema8_lexeme(
        self,
        connection: sqlite3.Connection,
        source_form: str,
        *,
        normalized_form: str | None = None,
        concept_id: str | None = None,
        knowledge_version: int | None = None,
        created_at: str | None = None,
    ) -> str:
        """Create neutral schema-8 ownership for legacy write paths."""

        normalized = normalize_english_form(source_form)
        if normalized_form is not None and normalized_form != normalized:
            raise ValueError("schema8 lexeme normalization does not match source form")
        if knowledge_version is None:
            knowledge_version = int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
        now = created_at or utc_now()
        lexeme_id, _ = self._ensure_lexeme_record(
            connection,
            source_form,
            language="en",
            knowledge_version=knowledge_version,
            created_at=now,
        )
        if concept_id is not None:
            self._associate_schema8_lexeme(
                connection,
                lexeme_id,
                concept_id,
                knowledge_version=knowledge_version,
                created_at=now,
            )
        return lexeme_id

    def initialize(self) -> None:
        with closing(self.connect()) as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS source_editions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    raw_sha256 TEXT NOT NULL,
                    normalized_sha256 TEXT NOT NULL,
                    parser_version TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    UNIQUE(normalized_sha256, parser_version)
                );

                CREATE TABLE IF NOT EXISTS blocks (
                    id TEXT PRIMARY KEY,
                    legacy_id TEXT NOT NULL,
                    source_edition_id INTEGER NOT NULL REFERENCES source_editions(id),
                    chapter_id TEXT NOT NULL,
                    chapter_title TEXT NOT NULL,
                    chapter_index INTEGER NOT NULL,
                    block_index INTEGER NOT NULL,
                    global_index INTEGER NOT NULL,
                    block_type TEXT NOT NULL DEFAULT 'prose',
                    source_text TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    token_count INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending',
                    last_error TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source_edition_id, chapter_id, block_index)
                );
                CREATE INDEX IF NOT EXISTS idx_blocks_order
                    ON blocks(source_edition_id, global_index);

                CREATE TABLE IF NOT EXISTS knowledge_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    parent_id INTEGER REFERENCES knowledge_versions(id),
                    reason TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    stage TEXT NOT NULL,
                    status TEXT NOT NULL,
                    knowledge_version INTEGER,
                    config_json TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    error TEXT
                );

                CREATE TABLE IF NOT EXISTS audit_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT REFERENCES runs(id),
                    block_id TEXT REFERENCES blocks(id),
                    purpose TEXT NOT NULL,
                    model TEXT NOT NULL,
                    knowledge_version INTEGER,
                    request_json TEXT NOT NULL,
                    raw_response TEXT NOT NULL,
                    parsed_json TEXT,
                    accepted INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 1,
                    elapsed_ms INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    archive_relative_path TEXT,
                    archive_offset INTEGER,
                    archive_compressed_length INTEGER,
                    archive_sha256 TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS evidence (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    paragraph_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    source_form TEXT,
                    evidence_quote TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    extractor TEXT NOT NULL,
                    run_id TEXT REFERENCES runs(id),
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_evidence_block ON evidence(block_id);

                CREATE TABLE IF NOT EXISTS lexical_candidates (
                    id TEXT PRIMARY KEY,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    paragraph_id TEXT NOT NULL,
                    start_offset INTEGER NOT NULL,
                    end_offset INTEGER NOT NULL,
                    original_text TEXT NOT NULL,
                    normalized_text TEXT NOT NULL,
                    left_context TEXT NOT NULL DEFAULT '',
                    right_context TEXT NOT NULL DEFAULT '',
                    extraction_reason TEXT NOT NULL,
                    book_frequency INTEGER NOT NULL DEFAULT 1,
                    risk_flags_json TEXT NOT NULL DEFAULT '[]',
                    model_status TEXT NOT NULL DEFAULT 'pending',
                    resolution_status TEXT NOT NULL DEFAULT 'pending',
                    selected INTEGER NOT NULL DEFAULT 0,
                    run_id TEXT REFERENCES runs(id),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(block_id, start_offset, end_offset, normalized_text)
                );
                CREATE INDEX IF NOT EXISTS idx_lexical_candidates_block
                    ON lexical_candidates(block_id, selected, model_status);
                CREATE INDEX IF NOT EXISTS idx_lexical_candidates_normalized
                    ON lexical_candidates(normalized_text);

                CREATE TABLE IF NOT EXISTS candidate_clusters (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    risk_flags_json TEXT NOT NULL DEFAULT '[]',
                    affected_blocks_json TEXT NOT NULL DEFAULT '[]',
                    affected_block_count INTEGER NOT NULL DEFAULT 0,
                    ordinal INTEGER NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending',
                    lease_run_id TEXT REFERENCES runs(id),
                    lease_acquired_at TEXT,
                    lease_snapshot_hash TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(run_id, id)
                );
                CREATE INDEX IF NOT EXISTS idx_candidate_clusters_order
                    ON candidate_clusters(run_id, ordinal, id);

                CREATE TABLE IF NOT EXISTS candidate_cluster_members (
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    cluster_id TEXT NOT NULL REFERENCES candidate_clusters(id)
                        ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL REFERENCES lexical_candidates(id),
                    role TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    context_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(cluster_id, candidate_id)
                );
                CREATE INDEX IF NOT EXISTS idx_candidate_cluster_members_candidate
                    ON candidate_cluster_members(candidate_id, run_id, cluster_id);
                CREATE INDEX IF NOT EXISTS idx_candidate_cluster_members_cluster
                    ON candidate_cluster_members(run_id, cluster_id, ordinal);

                CREATE TABLE IF NOT EXISTS concepts (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    canonical_source TEXT NOT NULL,
                    default_target TEXT NOT NULL DEFAULT '',
                    working_target TEXT NOT NULL DEFAULT '',
                    verified_target TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'provisional',
                    scope TEXT NOT NULL DEFAULT 'book',
                    locked INTEGER NOT NULL DEFAULT 0,
                    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                    retired_version INTEGER REFERENCES knowledge_versions(id),
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_concepts_active_source
                    ON concepts(canonical_source, retired_version, locked);

                CREATE TABLE IF NOT EXISTS candidate_adjudications (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    cluster_id TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    selected_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                    entity_kind TEXT NOT NULL DEFAULT '',
                    confidence REAL NOT NULL DEFAULT 0.0,
                    reason TEXT NOT NULL DEFAULT '',
                    rounds INTEGER NOT NULL DEFAULT 1,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    superseded_at TEXT,
                    FOREIGN KEY(cluster_id)
                        REFERENCES candidate_clusters(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS candidate_resolutions (
                    id TEXT PRIMARY KEY,
                    adjudication_id TEXT NOT NULL REFERENCES candidate_adjudications(id)
                        ON DELETE CASCADE,
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    cluster_id TEXT NOT NULL,
                    candidate_id TEXT REFERENCES lexical_candidates(id),
                    concept_id TEXT REFERENCES concepts(id),
                    evidence_id INTEGER REFERENCES evidence(id),
                    decision TEXT NOT NULL,
                    ordinal INTEGER NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    UNIQUE(adjudication_id, ordinal),
                    FOREIGN KEY(cluster_id)
                        REFERENCES candidate_clusters(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_cluster
                    ON candidate_resolutions(run_id, cluster_id, ordinal);
                CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_candidate
                    ON candidate_resolutions(candidate_id, decision);
                CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_concept
                    ON candidate_resolutions(concept_id, decision);

                CREATE TABLE IF NOT EXISTS source_forms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
                    form TEXT NOT NULL,
                    normalized_form TEXT NOT NULL,
                    grammar_json TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(lexeme_id, normalized_form, form)
                );
                CREATE INDEX IF NOT EXISTS idx_source_forms_normalized
                    ON source_forms(normalized_form);

                CREATE TABLE IF NOT EXISTS mentions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    paragraph_id TEXT NOT NULL,
                    source_form TEXT NOT NULL,
                    normalized_form TEXT NOT NULL,
                    discourse_function TEXT NOT NULL,
                    lexeme_id TEXT NOT NULL REFERENCES lexemes(id),
                    concept_id TEXT REFERENCES concepts(id),
                    evidence_id INTEGER NOT NULL REFERENCES evidence(id),
                    UNIQUE(block_id, paragraph_id, source_form, evidence_id)
                );

                CREATE TABLE IF NOT EXISTS rendering_rules (
                    id TEXT PRIMARY KEY,
                    concept_id TEXT NOT NULL REFERENCES concepts(id),
                    condition_json TEXT NOT NULL,
                    target TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'provisional',
                    scope TEXT NOT NULL DEFAULT 'book',
                    locked INTEGER NOT NULL DEFAULT 0,
                    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                    retired_version INTEGER REFERENCES knowledge_versions(id),
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS usage_decisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mention_id INTEGER NOT NULL REFERENCES mentions(id),
                    rendering TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'provisional',
                    scope TEXT NOT NULL DEFAULT 'occurrence',
                    locked INTEGER NOT NULL DEFAULT 0,
                    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                    retired_version INTEGER REFERENCES knowledge_versions(id),
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS translation_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    pipeline TEXT NOT NULL,
                    run_id TEXT REFERENCES runs(id),
                    knowledge_version INTEGER,
                    status TEXT NOT NULL,
                    draft_translation TEXT NOT NULL DEFAULT '',
                    final_translation TEXT NOT NULL DEFAULT '',
                    analysis TEXT NOT NULL DEFAULT '',
                    semantic_obligations TEXT NOT NULL DEFAULT '',
                    memory_summary TEXT NOT NULL DEFAULT '',
                    warnings_json TEXT NOT NULL DEFAULT '[]',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_translation_active
                    ON translation_versions(block_id, pipeline, active);

                CREATE TABLE IF NOT EXISTS dependencies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    translation_id INTEGER NOT NULL REFERENCES translation_versions(id),
                    dependency_type TEXT NOT NULL,
                    dependency_id TEXT NOT NULL,
                    knowledge_version INTEGER NOT NULL,
                    UNIQUE(translation_id, dependency_type, dependency_id)
                );
                CREATE INDEX IF NOT EXISTS idx_dependencies_reverse
                    ON dependencies(dependency_type, dependency_id);

                CREATE TABLE IF NOT EXISTS human_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    block_id TEXT REFERENCES blocks(id),
                    kind TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'open',
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                );

                CREATE TABLE IF NOT EXISTS baseline_documents (
                    id TEXT PRIMARY KEY,
                    source_edition_id INTEGER NOT NULL REFERENCES source_editions(id),
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_sha256 TEXT NOT NULL,
                    paragraph_count INTEGER NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    UNIQUE(source_edition_id, name, file_sha256)
                );
                CREATE INDEX IF NOT EXISTS idx_baseline_documents_active
                    ON baseline_documents(source_edition_id, active, name);

                CREATE TABLE IF NOT EXISTS source_paragraphs (
                    source_edition_id INTEGER NOT NULL REFERENCES source_editions(id),
                    paragraph_index INTEGER NOT NULL,
                    source_text TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    char_start INTEGER NOT NULL,
                    char_end INTEGER NOT NULL,
                    PRIMARY KEY(source_edition_id, paragraph_index)
                );

                CREATE TABLE IF NOT EXISTS baseline_paragraphs (
                    baseline_document_id TEXT NOT NULL REFERENCES baseline_documents(id),
                    paragraph_index INTEGER NOT NULL,
                    target_text TEXT NOT NULL,
                    target_hash TEXT NOT NULL,
                    PRIMARY KEY(baseline_document_id, paragraph_index)
                );

                CREATE TABLE IF NOT EXISTS block_baseline_links (
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    baseline_document_id TEXT NOT NULL REFERENCES baseline_documents(id),
                    paragraph_index INTEGER NOT NULL,
                    ordinal INTEGER NOT NULL,
                    overlap_start INTEGER NOT NULL,
                    overlap_end INTEGER NOT NULL,
                    partial_start INTEGER NOT NULL DEFAULT 0,
                    partial_end INTEGER NOT NULL DEFAULT 0,
                    alignment_status TEXT NOT NULL DEFAULT 'exact',
                    PRIMARY KEY(block_id, baseline_document_id, paragraph_index)
                );
                CREATE INDEX IF NOT EXISTS idx_block_baseline_links
                    ON block_baseline_links(block_id, baseline_document_id, ordinal);

                CREATE TABLE IF NOT EXISTS claims (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    statement TEXT NOT NULL,
                    subject_form TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'proposed',
                    scope TEXT NOT NULL DEFAULT 'book',
                    confidence REAL NOT NULL DEFAULT 0.5,
                    reveal_global_index INTEGER NOT NULL,
                    high_impact INTEGER NOT NULL DEFAULT 0,
                    locked INTEGER NOT NULL DEFAULT 0,
                    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                    retired_version INTEGER REFERENCES knowledge_versions(id),
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_claims_reveal
                    ON claims(status, reveal_global_index);

                CREATE TABLE IF NOT EXISTS claim_evidence (
                    claim_id TEXT NOT NULL REFERENCES claims(id),
                    evidence_id INTEGER NOT NULL REFERENCES evidence(id),
                    PRIMARY KEY(claim_id, evidence_id)
                );

                CREATE TABLE IF NOT EXISTS verification_tasks (
                    id TEXT PRIMARY KEY,
                    subject_type TEXT NOT NULL,
                    subject_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'open',
                    required_votes INTEGER NOT NULL DEFAULT 2,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_verification_tasks_status
                    ON verification_tasks(status, created_at);

                CREATE TABLE IF NOT EXISTS verification_votes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL REFERENCES verification_tasks(id),
                    verifier_index INTEGER NOT NULL,
                    verdict TEXT NOT NULL,
                    rationale TEXT NOT NULL,
                    evidence_json TEXT NOT NULL DEFAULT '[]',
                    audit_call_id INTEGER REFERENCES audit_calls(id),
                    created_at TEXT NOT NULL,
                    UNIQUE(task_id, verifier_index)
                );

                CREATE TABLE IF NOT EXISTS annotations (
                    id TEXT PRIMARY KEY,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    paragraph_index INTEGER NOT NULL,
                    body TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'proposed',
                    source TEXT NOT NULL DEFAULT 'human',
                    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_annotations_block
                    ON annotations(block_id, status, paragraph_index);

                CREATE TABLE IF NOT EXISTS repair_tasks (
                    id TEXT PRIMARY KEY,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    status TEXT NOT NULL DEFAULT 'open',
                    issues_json TEXT NOT NULL,
                    requested_at TEXT NOT NULL,
                    resolved_at TEXT,
                    translation_id INTEGER REFERENCES translation_versions(id)
                );

                CREATE TABLE IF NOT EXISTS comparison_votes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    block_id TEXT NOT NULL UNIQUE REFERENCES blocks(id),
                    candidate_a_origin TEXT NOT NULL,
                    candidate_b_origin TEXT NOT NULL,
                    candidate_a_hash TEXT NOT NULL DEFAULT '',
                    candidate_b_hash TEXT NOT NULL DEFAULT '',
                    choice TEXT NOT NULL,
                    selected_origin TEXT,
                    blinded INTEGER NOT NULL DEFAULT 1,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_comparison_votes_choice
                    ON comparison_votes(choice, updated_at);

                CREATE TABLE IF NOT EXISTS comparison_vote_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    original_vote_id INTEGER NOT NULL,
                    block_id TEXT NOT NULL REFERENCES blocks(id),
                    candidate_a_origin TEXT NOT NULL,
                    candidate_b_origin TEXT NOT NULL,
                    candidate_a_hash TEXT NOT NULL DEFAULT '',
                    candidate_b_hash TEXT NOT NULL DEFAULT '',
                    choice TEXT NOT NULL,
                    selected_origin TEXT,
                    blinded INTEGER NOT NULL DEFAULT 1,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    archived_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_comparison_vote_history_block
                    ON comparison_vote_history(block_id, archived_at);
                """
            )
            if connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone()[0] == 0:
                connection.execute(
                    "INSERT INTO knowledge_versions(parent_id, reason, created_at) VALUES(NULL, ?, ?)",
                    ("initialize parallel_v4", utc_now()),
                )
            self._migrate_candidate_cluster_schema(connection)
            self._migrate_candidate_adjudication_schema(connection)
            self._migrate_audit_call_schema(connection)
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(blocks)").fetchall()
            }
            if "legacy_id" not in columns:
                connection.execute("ALTER TABLE blocks ADD COLUMN legacy_id TEXT NOT NULL DEFAULT ''")
                connection.execute("UPDATE blocks SET legacy_id=id WHERE legacy_id=''")
            claim_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(claims)").fetchall()
            }
            if "subject_form" not in claim_columns:
                connection.execute(
                    "ALTER TABLE claims ADD COLUMN subject_form TEXT NOT NULL DEFAULT ''"
                )
            translation_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(translation_versions)"
                ).fetchall()
            }
            if "semantic_obligations" not in translation_columns:
                connection.execute(
                    """ALTER TABLE translation_versions
                       ADD COLUMN semantic_obligations TEXT NOT NULL DEFAULT ''"""
                )
            vote_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(comparison_votes)"
                ).fetchall()
            }
            if "candidate_a_hash" not in vote_columns:
                connection.execute(
                    "ALTER TABLE comparison_votes ADD COLUMN candidate_a_hash TEXT NOT NULL DEFAULT ''"
                )
            if "candidate_b_hash" not in vote_columns:
                connection.execute(
                    "ALTER TABLE comparison_votes ADD COLUMN candidate_b_hash TEXT NOT NULL DEFAULT ''"
                )
            lexical_columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(lexical_candidates)"
                ).fetchall()
            }
            if "risk_flags_json" not in lexical_columns:
                connection.execute(
                    """ALTER TABLE lexical_candidates
                       ADD COLUMN risk_flags_json TEXT NOT NULL DEFAULT '[]'"""
                )
            if "resolution_status" not in lexical_columns:
                connection.execute(
                    """ALTER TABLE lexical_candidates
                       ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'pending'"""
                )
            concept_columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(concepts)").fetchall()
            }
            if "working_target" not in concept_columns:
                connection.execute(
                    """ALTER TABLE concepts
                       ADD COLUMN working_target TEXT NOT NULL DEFAULT ''"""
                )
            if "verified_target" not in concept_columns:
                connection.execute(
                    """ALTER TABLE concepts
                       ADD COLUMN verified_target TEXT NOT NULL DEFAULT ''"""
                )
            connection.execute(
                """UPDATE concepts
                   SET working_target=CASE
                           WHEN working_target='' THEN default_target
                           ELSE working_target END,
                       verified_target=CASE
                           WHEN verified_target='' THEN default_target
                           ELSE verified_target END
                   WHERE locked=1 AND default_target!=''"""
            )
            connection.execute(
                """CREATE INDEX IF NOT EXISTS idx_lexical_candidates_resolution
                   ON lexical_candidates(resolution_status, block_id, id)"""
            )
            connection.execute(
                """CREATE INDEX IF NOT EXISTS idx_lexical_candidates_pending
                   ON lexical_candidates(resolution_status, block_id, updated_at, id)"""
            )
            legacy_votes = connection.execute(
                """SELECT * FROM comparison_votes
                   WHERE candidate_a_hash='' OR candidate_b_hash=''"""
            ).fetchall()
            for legacy_vote in legacy_votes:
                self._archive_comparison_vote(
                    connection, legacy_vote, utc_now()
                )
            connection.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
            connection.commit()

    def _migrate_candidate_cluster_schema(
        self, connection: sqlite3.Connection
    ) -> None:
        columns = {
            row["name"]
            for row in connection.execute(
                "PRAGMA table_info(candidate_clusters)"
            ).fetchall()
        }
        additions = {
            "state": "TEXT NOT NULL DEFAULT 'pending'",
            "lease_run_id": "TEXT REFERENCES runs(id)",
            "lease_acquired_at": "TEXT",
            "lease_snapshot_hash": "TEXT",
        }
        for name, declaration in additions.items():
            if name not in columns:
                connection.execute(
                    f"ALTER TABLE candidate_clusters ADD COLUMN {name} {declaration}"
                )
        connection.execute(
            """UPDATE candidate_clusters
               SET state=CASE
                   WHEN EXISTS(
                       SELECT 1 FROM candidate_adjudications ca
                       WHERE ca.cluster_id=candidate_clusters.id
                   ) THEN 'adjudicated'
                   WHEN state NOT IN ('pending', 'leased', 'adjudicated', 'stale')
                       THEN 'pending'
                   ELSE state END"""
        )
        connection.execute(
            """UPDATE candidate_clusters
               SET lease_run_id=NULL, lease_acquired_at=NULL,
                   lease_snapshot_hash=NULL
               WHERE state!='leased'"""
        )
        connection.execute(
            """CREATE INDEX IF NOT EXISTS idx_candidate_clusters_state
               ON candidate_clusters(state, id, ordinal)"""
        )
        connection.execute(
            """CREATE INDEX IF NOT EXISTS idx_candidate_clusters_lease
               ON candidate_clusters(lease_run_id, state, lease_acquired_at)"""
        )

    @staticmethod
    def _candidate_adjudication_table_sql() -> str:
        return """CREATE TABLE candidate_adjudications (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id),
            cluster_id TEXT NOT NULL,
            verdict TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            selected_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
            entity_kind TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 0.0,
            reason TEXT NOT NULL DEFAULT '',
            rounds INTEGER NOT NULL DEFAULT 1,
            payload_json TEXT NOT NULL DEFAULT '{}',
            knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            superseded_at TEXT,
            FOREIGN KEY(cluster_id)
                REFERENCES candidate_clusters(id) ON DELETE CASCADE
        )"""

    @staticmethod
    def _candidate_resolution_table_sql() -> str:
        return """CREATE TABLE candidate_resolutions (
            id TEXT PRIMARY KEY,
            adjudication_id TEXT NOT NULL REFERENCES candidate_adjudications(id)
                ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs(id),
            cluster_id TEXT NOT NULL,
            candidate_id TEXT REFERENCES lexical_candidates(id),
            lexeme_id TEXT REFERENCES lexemes(id),
            concept_id TEXT REFERENCES concepts(id),
            evidence_id INTEGER REFERENCES evidence(id),
            decision TEXT NOT NULL,
            ordinal INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(adjudication_id, ordinal),
            FOREIGN KEY(cluster_id)
                REFERENCES candidate_clusters(id) ON DELETE CASCADE
        )"""

    def _migrate_candidate_adjudication_schema(
        self, connection: sqlite3.Connection
    ) -> None:
        columns = {
            row["name"]
            for row in connection.execute(
                "PRAGMA table_info(candidate_adjudications)"
            ).fetchall()
        }
        additions = {
            "payload_hash": "TEXT NOT NULL DEFAULT ''",
            "knowledge_version": "INTEGER REFERENCES knowledge_versions(id)",
            "active": "INTEGER NOT NULL DEFAULT 1",
            "superseded_at": "TEXT",
        }
        missing_columns = set(additions).difference(columns)
        for name, declaration in additions.items():
            if name not in columns:
                connection.execute(
                    f"ALTER TABLE candidate_adjudications ADD COLUMN {name} {declaration}"
                )

        valid_versions = {
            int(row[0])
            for row in connection.execute("SELECT id FROM knowledge_versions")
        }
        fallback_version = max(valid_versions)
        rows = connection.execute(
            """SELECT ca.id, ca.run_id, ca.cluster_id, ca.payload_json,
                      ca.payload_hash, ca.knowledge_version, ca.active, ca.created_at,
                      ca.updated_at, ca.superseded_at, r.knowledge_version run_version
               FROM candidate_adjudications ca
               LEFT JOIN runs r ON r.id=ca.run_id
               ORDER BY ca.cluster_id, ca.updated_at DESC,
                        ca.created_at DESC, ca.id DESC"""
        ).fetchall()
        active_clusters: set[str] = set()
        for row in rows:
            raw_payload = row["payload_json"] or "{}"
            try:
                payload = json.loads(raw_payload)
            except (TypeError, ValueError):
                payload = {"legacy_payload": str(raw_payload)}
            canonical_payload = json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            payload_hash = row["payload_hash"]
            if "payload_hash" in missing_columns or not payload_hash:
                payload_hash = hashlib.sha256(
                    canonical_payload.encode("utf-8")
                ).hexdigest()
            knowledge_version = row["knowledge_version"]
            if knowledge_version not in valid_versions:
                matched_version = connection.execute(
                    """SELECT id FROM knowledge_versions
                       WHERE reason=?
                       ORDER BY
                           CASE WHEN julianday(created_at) IS NULL
                                  OR julianday(?) IS NULL THEN 1 ELSE 0 END,
                           abs(julianday(created_at) - julianday(?)),
                           id DESC
                       LIMIT 1""",
                    (
                        f"candidate adjudication {row['run_id']}",
                        row["updated_at"],
                        row["updated_at"],
                    ),
                ).fetchone()
                if matched_version is not None:
                    knowledge_version = int(matched_version["id"])
            if knowledge_version not in valid_versions:
                knowledge_version = row["run_version"]
            if knowledge_version not in valid_versions:
                knowledge_version = fallback_version
            cluster_key = str(row["cluster_id"])
            requested_active = (
                True if "active" in missing_columns else bool(row["active"])
            )
            active = int(requested_active and cluster_key not in active_clusters)
            if active:
                active_clusters.add(cluster_key)
            superseded_at = row["superseded_at"]
            if (
                not active
                and superseded_at is None
            ):
                superseded_at = row["updated_at"] or row["created_at"] or utc_now()
            connection.execute(
                """UPDATE candidate_adjudications
                   SET payload_hash=?, knowledge_version=?, active=?, superseded_at=?
                   WHERE id=?""",
                (
                    payload_hash,
                    int(knowledge_version),
                    active,
                    superseded_at,
                    row["id"],
                ),
            )

        has_legacy_unique = False
        for index in connection.execute(
            "PRAGMA index_list(candidate_adjudications)"
        ).fetchall():
            if not bool(index["unique"]) or bool(index["partial"]):
                continue
            index_columns = tuple(
                row["name"]
                for row in connection.execute(
                    f"PRAGMA index_info('{index['name']}')"
                ).fetchall()
            )
            if index_columns == ("run_id", "cluster_id"):
                has_legacy_unique = True
                break

        if has_legacy_unique:
            connection.execute(
                "ALTER TABLE candidate_resolutions RENAME TO legacy_candidate_resolutions"
            )
            connection.execute(
                "ALTER TABLE candidate_adjudications RENAME TO legacy_candidate_adjudications"
            )
            connection.execute(self._candidate_adjudication_table_sql())
            connection.execute(self._candidate_resolution_table_sql())
            connection.execute(
                """INSERT INTO candidate_adjudications(
                       id, run_id, cluster_id, verdict, payload_hash,
                       selected_candidate_ids_json, entity_kind, confidence,
                       reason, rounds, payload_json, knowledge_version, active,
                       created_at, updated_at, superseded_at)
                   SELECT id, run_id, cluster_id, verdict, payload_hash,
                          selected_candidate_ids_json, entity_kind, confidence,
                          reason, rounds, payload_json, knowledge_version, active,
                          created_at, updated_at, superseded_at
                   FROM legacy_candidate_adjudications"""
            )
            connection.execute(
                """INSERT INTO candidate_resolutions(
                       id, adjudication_id, run_id, cluster_id, candidate_id,
                       lexeme_id, concept_id, evidence_id, decision, ordinal,
                       payload_json, created_at)
                   SELECT id, adjudication_id, run_id, cluster_id, candidate_id,
                          lexeme_id, concept_id, evidence_id, decision, ordinal,
                          payload_json, created_at
                   FROM legacy_candidate_resolutions"""
            )
            connection.execute("DROP TABLE legacy_candidate_resolutions")
            connection.execute("DROP TABLE legacy_candidate_adjudications")

        connection.execute("DROP INDEX IF EXISTS idx_candidate_adjudications_cluster")
        connection.execute("DROP INDEX IF EXISTS idx_candidate_adjudications_active")
        connection.execute(
            """CREATE INDEX idx_candidate_adjudications_cluster
               ON candidate_adjudications(cluster_id, active, created_at)"""
        )
        connection.execute(
            """CREATE UNIQUE INDEX idx_candidate_adjudications_active
               ON candidate_adjudications(cluster_id) WHERE active=1"""
        )
        connection.execute(
            """CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_cluster
               ON candidate_resolutions(run_id, cluster_id, ordinal)"""
        )
        connection.execute(
            """CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_candidate
               ON candidate_resolutions(candidate_id, decision)"""
        )
        connection.execute(
            """CREATE INDEX IF NOT EXISTS idx_candidate_resolutions_concept
               ON candidate_resolutions(concept_id, decision)"""
        )

    @staticmethod
    def _migrate_audit_call_schema(connection: sqlite3.Connection) -> None:
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(audit_calls)").fetchall()
        }
        additions = {
            "archive_relative_path": "TEXT",
            "archive_offset": "INTEGER",
            "archive_compressed_length": "INTEGER",
            "archive_sha256": "TEXT",
        }
        for name, declaration in additions.items():
            if name not in columns:
                connection.execute(
                    f"ALTER TABLE audit_calls ADD COLUMN {name} {declaration}"
                )

    def current_knowledge_version(
        self, connection: sqlite3.Connection | None = None
    ) -> int:
        if connection is not None:
            return int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
        with closing(self.connect()) as owned:
            return int(
                owned.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )

    def active_source_edition_id(self) -> int:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT id FROM source_editions WHERE active=1 ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row is None:
                raise ValueError("尚未迁移活动来源版本")
            return int(row["id"])

    def create_knowledge_version(self, reason: str, connection: sqlite3.Connection) -> int:
        parent = connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        cursor = connection.execute(
            "INSERT INTO knowledge_versions(parent_id, reason, created_at) VALUES(?, ?, ?)",
            (parent, reason, utc_now()),
        )
        return int(cursor.lastrowid)

    def record_render_change(
        self,
        connection: sqlite3.Connection,
        *,
        subject_type: str,
        subject_id: str,
        old_state: Mapping[str, Any],
        new_state: Mapping[str, Any],
        change_kind: str,
        reason: str,
        knowledge_version: int | None = None,
        record_metadata: bool = False,
    ) -> Dict[str, Any]:
        """Persist one bounded render delta in the caller's transaction."""

        self._require_active_transaction(connection)
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("render change reason cannot be empty")
        old_fingerprint = render_fingerprint(subject_type, subject_id, old_state)
        new_fingerprint = render_fingerprint(subject_type, subject_id, new_state)
        old_summary = _render_semantic_summary(subject_type, subject_id, old_state)
        new_summary = _render_semantic_summary(subject_type, subject_id, new_state)
        semantic_changed = old_fingerprint != new_fingerprint
        metadata_changed = False
        ineffective_claim = (
            subject_type == "claim"
            and not bool(old_summary.get("prompt_effective"))
            and not bool(new_summary.get("prompt_effective"))
        )
        if not semantic_changed and record_metadata and not ineffective_claim:
            raw_old = json.dumps(
                _canonical_render_value(old_state),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            raw_new = json.dumps(
                _canonical_render_value(new_state),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            metadata_changed = raw_old != raw_new
        version = knowledge_version
        if version is not None:
            version = int(version)
            version_row = connection.execute(
                """SELECT id, (SELECT MAX(id) FROM knowledge_versions) current_id
                   FROM knowledge_versions WHERE id=?""",
                (version,),
            ).fetchone()
            if version_row is None:
                raise ValueError(f"unknown knowledge version: {version}")
            if version != int(version_row["current_id"]):
                raise ValueError(
                    "render change knowledge_version must be the current knowledge version"
                )
        if not semantic_changed and (not record_metadata or not metadata_changed):
            return {
                "changed": False,
                "semantic_changed": False,
                "knowledge_version": None,
                "impact_level": 0,
                "change_kind": "metadata",
                "change_id": None,
                "old_fingerprint": old_fingerprint,
                "new_fingerprint": new_fingerprint,
            }
        derived_kind, impact = (
            _derive_render_change(old_summary, new_summary)
            if semantic_changed
            else ("metadata", 0)
        )
        if version is None:
            version = self.create_knowledge_version(reason.strip()[:512], connection)
        payload = {
            "old": old_summary,
            "new": new_summary,
            "reason": reason.strip()[:512],
            "semantic_changed": semantic_changed,
        }
        payload_json = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        if len(payload_json.encode("utf-8")) > _RENDER_MAX_INPUT_BYTES:
            raise ValueError("render change payload exceeds size limit")
        existing = connection.execute(
            """SELECT id FROM knowledge_changes
               WHERE knowledge_version=? AND subject_type=? AND subject_id=?
                 AND change_kind=? AND old_fingerprint=? AND new_fingerprint=?
               ORDER BY id LIMIT 1""",
            (
                version,
                subject_type.strip(),
                subject_id.strip(),
                derived_kind,
                old_fingerprint,
                new_fingerprint,
            ),
        ).fetchone()
        if existing is not None:
            return {
                "changed": True,
                "semantic_changed": semantic_changed,
                "knowledge_version": int(version),
                "impact_level": impact,
                "change_kind": derived_kind,
                "change_id": int(existing["id"]),
                "old_fingerprint": old_fingerprint,
                "new_fingerprint": new_fingerprint,
                "reused": True,
            }
        cursor = connection.execute(
            """INSERT INTO knowledge_changes(
                   knowledge_version, subject_type, subject_id, change_kind,
                   old_fingerprint, new_fingerprint, impact_level,
                   payload_json, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                version,
                subject_type.strip(),
                subject_id.strip(),
                derived_kind,
                old_fingerprint,
                new_fingerprint,
                impact,
                payload_json,
                utc_now(),
            ),
        )
        return {
            "changed": True,
            "semantic_changed": semantic_changed,
            "knowledge_version": int(version),
            "impact_level": impact,
            "change_kind": derived_kind,
            "change_id": int(cursor.lastrowid),
            "old_fingerprint": old_fingerprint,
            "new_fingerprint": new_fingerprint,
        }

    def _render_state_for_subject(
        self,
        connection: sqlite3.Connection,
        subject_type: str,
        subject_id: str,
    ) -> Dict[str, Any]:
        if subject_type not in {"lexeme", "concept"}:
            raise ValueError("render state supports lexeme or concept subjects")
        table = "lexemes" if subject_type == "lexeme" else "concepts"
        scope_expression = "scope" if subject_type == "concept" else "'book' AS scope"
        description_expression = (
            "description" if subject_type == "concept" else "'' AS description"
        )
        row = connection.execute(
            f"""SELECT default_target, working_target, verified_target,
                       status, locked, {scope_expression}, {description_expression},
                       retired_version,
                       (
                           SELECT semantic_core FROM term_profiles tp
                           WHERE tp.subject_type=? AND tp.subject_id={table}.id
                             AND tp.retired_version IS NULL
                           ORDER BY tp.locked DESC, tp.created_version DESC
                           LIMIT 1
                       ) profile_semantic_core,
                       (
                           SELECT contrast_sources_json FROM term_profiles tp
                           WHERE tp.subject_type=? AND tp.subject_id={table}.id
                             AND tp.retired_version IS NULL
                           ORDER BY tp.locked DESC, tp.created_version DESC
                           LIMIT 1
                       ) profile_contrast_sources_json,
                       (
                           SELECT status FROM term_profiles tp
                           WHERE tp.subject_type=? AND tp.subject_id={table}.id
                             AND tp.retired_version IS NULL
                           ORDER BY tp.locked DESC, tp.created_version DESC
                           LIMIT 1
                       ) profile_status,
                       (
                           SELECT locked FROM term_profiles tp
                           WHERE tp.subject_type=? AND tp.subject_id={table}.id
                             AND tp.retired_version IS NULL
                           ORDER BY tp.locked DESC, tp.created_version DESC
                           LIMIT 1
                       ) profile_locked
                  FROM {table} WHERE id=?""",
            (subject_type, subject_type, subject_type, subject_type, subject_id),
        ).fetchone()
        if row is None:
            return {}
        state: Dict[str, Any] = {
            "default_target": str(row["default_target"] or ""),
            "working_target": str(row["working_target"] or ""),
            "verified_target": str(row["verified_target"] or ""),
            "status": str(row["status"] or ""),
            "locked": bool(row["locked"]),
            "scope": str(row["scope"] or "book"),
            "description": str(row["description"] or ""),
        }
        try:
            raw_contrasts = json.loads(
                str(row["profile_contrast_sources_json"] or "[]")
            )
        except json.JSONDecodeError as exc:
            raise ValueError("term profile contrast_sources_json is invalid") from exc
        if not isinstance(raw_contrasts, list):
            raise ValueError("term profile contrast_sources_json must be a list")
        profile = {
            "semantic_core": str(row["profile_semantic_core"] or "").strip(),
            "contrast_sources": list(
                self._normalized_contrast_sources(raw_contrasts)
            ),
            "status": str(row["profile_status"] or "provisional"),
            "locked": bool(row["profile_locked"]),
        }
        if profile["semantic_core"] or profile["contrast_sources"]:
            state["term_profile"] = profile
        subject_column = f"{subject_type}_id"
        all_rule_summaries: list[Dict[str, Any]] = []
        rule_digest = hashlib.sha256()
        for rule in connection.execute(
            f"""SELECT id, condition_json, target, priority, status,
                       scope, locked
                  FROM rendering_rules
                  WHERE {subject_column}=? AND retired_version IS NULL
                  ORDER BY id""",
            (subject_id,),
        ):
            raw_summary = {
                "subject_type": subject_type,
                "subject_id": subject_id,
                "condition": _safe_rule_condition(
                    rule["condition_json"], str(rule["id"])
                ),
                "target": str(rule["target"]),
                "priority": int(rule["priority"]),
                "status": str(rule["status"]),
                "scope": str(rule["scope"]),
                "locked": bool(rule["locked"]),
            }
            summary = _effective_rule_summary(
                raw_summary, subject_type, subject_id
            )
            all_rule_summaries.append(summary)
        all_rule_summaries.sort(
            key=lambda item: json.dumps(
                item,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        for summary in all_rule_summaries:
            signature = json.dumps(
                summary,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            rule_digest.update(len(signature).to_bytes(8, "big"))
            rule_digest.update(signature)
        state["rendering_rule_count"] = len(all_rule_summaries)
        state["rendering_rules_sha256"] = rule_digest.hexdigest()
        state["rules"] = all_rule_summaries[:MAX_RENDER_STATE_RULES]
        if subject_type == "lexeme":
            state["forms"] = [
                str(form["form"])
                for form in connection.execute(
                    "SELECT form FROM source_forms WHERE lexeme_id=? ORDER BY form",
                    (subject_id,),
                ).fetchall()
            ]
        else:
            concept = connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?",
                (subject_id,),
            ).fetchone()
            primary_lexeme_id = str(concept["primary_lexeme_id"] or "")
            if primary_lexeme_id:
                state["primary_lexeme_id"] = primary_lexeme_id
            active_links = connection.execute(
                """SELECT lexeme_id, role FROM concept_lexemes
                   WHERE concept_id=? AND retired_version IS NULL
                   ORDER BY lexeme_id, role""",
                (subject_id,),
            ).fetchall()
            state["effective_subject_link"] = [
                {"lexeme_id": str(link["lexeme_id"]), "role": str(link["role"])}
                for link in active_links
            ]
            linked_lexeme_ids = list(
                dict.fromkeys(str(link["lexeme_id"]) for link in active_links)
            )
            if linked_lexeme_ids:
                placeholders = ",".join("?" for _ in linked_lexeme_ids)
                state["forms"] = [
                    str(form["form"])
                    for form in connection.execute(
                        f"""SELECT DISTINCT form FROM source_forms
                            WHERE lexeme_id IN ({placeholders}) ORDER BY form""",
                        linked_lexeme_ids,
                    ).fetchall()
                ]
        redirect = connection.execute(
            """SELECT canonical_concept_id FROM concept_redirects
               WHERE retired_concept_id=?""",
            (subject_id,),
        ).fetchone()
        if redirect is not None:
            state["redirect_winner_id"] = str(redirect["canonical_concept_id"])
            state["effective_subject_id"] = str(redirect["canonical_concept_id"])
        if row["retired_version"] is not None:
            state["retired"] = True
        return state

    def _claim_state_for_subject(
        self, connection: sqlite3.Connection, claim_id: str
    ) -> Dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM claims WHERE id=?", (str(claim_id),)
        ).fetchone()
        if row is None:
            return {}
        return self._claim_state_from_row(row)

    @staticmethod
    def _claim_state_from_row(row: Mapping[str, Any]) -> Dict[str, Any]:
        return {
            "exists": True,
            "active": row["retired_version"] is None,
            "accepted": str(row["status"]) == "verified",
            "kind": str(row["kind"]),
            "statement": str(row["statement"]),
            "subject_form": str(row["subject_form"]),
            "scope": str(row["scope"]),
            "reveal_global_index": int(row["reveal_global_index"]),
            "reveal_boundary": str(row["kind"]) == "reveal_boundary",
            "locked": bool(row["locked"]),
            "high_impact_constraint": bool(row["high_impact"]),
            # Metadata is retained only so record_metadata can audit it at impact 0.
            "confidence": float(row["confidence"]),
        }

    def ensure_source_edition(
        self,
        raw_sha256: str,
        normalized_sha256: str,
        parser_version: str,
        source_path: str,
    ) -> int:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT id FROM source_editions WHERE normalized_sha256=? AND parser_version=?",
                (normalized_sha256, parser_version),
            ).fetchone()
            if row:
                connection.execute(
                    "UPDATE source_editions SET active=CASE WHEN id=? THEN 1 ELSE 0 END",
                    (int(row["id"]),),
                )
                return int(row["id"])
            connection.execute("UPDATE source_editions SET active=0")
            cursor = connection.execute(
                """INSERT INTO source_editions(
                       raw_sha256, normalized_sha256, parser_version, source_path, active, created_at
                   ) VALUES(?, ?, ?, ?, 1, ?)""",
                (raw_sha256, normalized_sha256, parser_version, source_path, utc_now()),
            )
            return int(cursor.lastrowid)

    def upsert_blocks(self, source_edition_id: int, blocks: Sequence[Dict[str, Any]]) -> None:
        with self.transaction() as connection:
            for item in blocks:
                connection.execute(
                    """INSERT INTO blocks(
                           id, legacy_id, source_edition_id, chapter_id, chapter_title, chapter_index,
                           block_index, global_index, block_type, source_text, source_hash,
                           token_count, status, updated_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                           legacy_id=excluded.legacy_id,
                           chapter_title=excluded.chapter_title,
                           chapter_index=excluded.chapter_index,
                           block_index=excluded.block_index,
                           global_index=excluded.global_index,
                           block_type=excluded.block_type,
                           source_text=excluded.source_text,
                           source_hash=excluded.source_hash,
                           token_count=excluded.token_count,
                           updated_at=excluded.updated_at""",
                    (
                        item["id"], item.get("legacy_id", item["id"]), source_edition_id, item["chapter_id"],
                        item["chapter_title"], item["chapter_index"], item["block_index"],
                        item["global_index"], item["block_type"], item["source_text"],
                        item["source_hash"], item.get("token_count", 0),
                        item.get("status", V4BlockStatus.PENDING.value), utc_now(),
                    ),
                )

    @staticmethod
    def _row_to_block(row: sqlite3.Row) -> V4Block:
        return V4Block(
            id=row["id"], source_edition_id=row["source_edition_id"],
            chapter_id=row["chapter_id"], chapter_index=row["chapter_index"],
            block_index=row["block_index"], global_index=row["global_index"],
            block_type=row["block_type"], source_text=row["source_text"],
            source_hash=row["source_hash"], token_count=row["token_count"],
            status=row["status"], legacy_id=row["legacy_id"],
        )

    def list_blocks(self, statuses: Optional[Sequence[str]] = None) -> List[V4Block]:
        query = "SELECT * FROM blocks WHERE source_edition_id=(SELECT id FROM source_editions WHERE active=1)"
        params: List[Any] = []
        if statuses:
            query += " AND status IN (" + ",".join("?" for _ in statuses) + ")"
            params.extend(statuses)
        query += " ORDER BY global_index"
        with closing(self.connect()) as connection:
            return [self._row_to_block(row) for row in connection.execute(query, params)]

    def set_block_status(self, block_id: str, status: str, error: Optional[str] = None) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE blocks SET status=?, last_error=?, updated_at=? WHERE id=?",
                (status, error, utc_now(), block_id),
            )

    def start_run(
        self,
        run_id: str,
        stage: str,
        config: Dict[str, Any],
        knowledge_version: Optional[int] = None,
    ) -> None:
        with self.transaction() as connection:
            version = (
                int(knowledge_version)
                if knowledge_version is not None
                else int(
                    connection.execute(
                        "SELECT MAX(id) FROM knowledge_versions"
                    ).fetchone()[0]
                )
            )
            if connection.execute(
                "SELECT 1 FROM knowledge_versions WHERE id=?", (version,)
            ).fetchone() is None:
                raise ValueError(f"unknown knowledge version: {version}")
            connection.execute(
                """INSERT INTO runs(id, stage, status, knowledge_version, config_json, started_at)
                   VALUES(?, ?, 'running', ?, ?, ?)""",
                (run_id, stage, version, json.dumps(config, ensure_ascii=False), utc_now()),
            )

    def finish_run(self, run_id: str, status: str, error: Optional[str] = None) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?",
                (status, utc_now(), error, run_id),
            )

    def load_knowledge_epoch_state(
        self,
        run_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> Dict[str, Any]:
        if connection is not None:
            row = connection.execute(
                "SELECT config_json FROM runs WHERE id=?", (run_id,)
            ).fetchone()
        else:
            with closing(self.connect()) as owned:
                row = owned.execute(
                    "SELECT config_json FROM runs WHERE id=?", (run_id,)
                ).fetchone()
        if row is None:
            raise ValueError(f"unknown translation run: {run_id}")
        try:
            config = json.loads(str(row["config_json"] or "{}"))
        except json.JSONDecodeError as exc:
            raise ValueError("translation run config is invalid") from exc
        if not isinstance(config, dict):
            raise ValueError("translation run config must be a mapping")
        state = config.get("knowledge_epoch_state") or {}
        if not isinstance(state, dict):
            raise ValueError("knowledge epoch state must be a mapping")
        return deepcopy(state)

    def save_knowledge_epoch_state(
        self,
        run_id: str,
        state: Mapping[str, Any],
        *,
        knowledge_version: Optional[int] = None,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        with self._write(connection) as active:
            row = active.execute(
                "SELECT config_json, knowledge_version FROM runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise ValueError(f"unknown translation run: {run_id}")
            try:
                config = json.loads(str(row["config_json"] or "{}"))
            except json.JSONDecodeError as exc:
                raise ValueError("translation run config is invalid") from exc
            if not isinstance(config, dict):
                raise ValueError("translation run config must be a mapping")
            version = (
                int(knowledge_version)
                if knowledge_version is not None
                else int(row["knowledge_version"])
            )
            if active.execute(
                "SELECT 1 FROM knowledge_versions WHERE id=?", (version,)
            ).fetchone() is None:
                raise ValueError(f"unknown knowledge version: {version}")
            config["knowledge_epoch_state"] = deepcopy(dict(state))
            active.execute(
                "UPDATE runs SET knowledge_version=?, config_json=? WHERE id=?",
                (
                    version,
                    json.dumps(config, ensure_ascii=False, sort_keys=True),
                    run_id,
                ),
            )

    def knowledge_change_ids_after(
        self,
        knowledge_version: int,
        connection: sqlite3.Connection | None = None,
    ) -> List[int]:
        if type(knowledge_version) is not int or knowledge_version < 0:
            raise ValueError("knowledge_version must be a non-negative integer")
        if connection is not None:
            return [
                int(row[0])
                for row in connection.execute(
                    """SELECT id FROM knowledge_changes
                       WHERE knowledge_version>? ORDER BY knowledge_version, id""",
                    (knowledge_version,),
                )
            ]
        with closing(self.connect()) as owned:
            return [
                int(row[0])
                for row in owned.execute(
                    """SELECT id FROM knowledge_changes
                       WHERE knowledge_version>? ORDER BY knowledge_version, id""",
                    (knowledge_version,),
                )
            ]

    def knowledge_change_ids_between(
        self,
        after_version: int,
        through_version: int,
        connection: sqlite3.Connection | None = None,
    ) -> List[int]:
        if (
            type(after_version) is not int
            or type(through_version) is not int
            or after_version < 0
            or through_version < after_version
        ):
            raise ValueError("knowledge change version bounds are invalid")
        if connection is not None:
            return [
                int(row[0])
                for row in connection.execute(
                    """SELECT id FROM knowledge_changes
                       WHERE knowledge_version>? AND knowledge_version<=?
                       ORDER BY knowledge_version, id""",
                    (after_version, through_version),
                )
            ]
        with closing(self.connect()) as owned:
            return [
                int(row[0])
                for row in owned.execute(
                    """SELECT id FROM knowledge_changes
                       WHERE knowledge_version>? AND knowledge_version<=?
                       ORDER BY knowledge_version, id""",
                    (after_version, through_version),
                )
            ]

    def fail_run_for_invalid_snapshot(
        self,
        run_id: str,
        stage: str,
        config: Dict[str, Any],
        error: KnowledgeSnapshotError,
    ) -> None:
        """Fail safely and create one blocking review for corrupt persisted knowledge."""

        with self.transaction() as connection:
            version = int(
                connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
            )
            connection.execute(
                """INSERT OR IGNORE INTO runs(
                       id, stage, status, knowledge_version, config_json,
                       started_at, finished_at, error
                   ) VALUES(?, ?, 'failed', ?, ?, ?, ?, ?)""",
                (
                    run_id,
                    stage,
                    version,
                    json.dumps(config, ensure_ascii=False),
                    utc_now(),
                    utc_now(),
                    str(error),
                ),
            )
            connection.execute(
                "UPDATE runs SET status='failed', finished_at=?, error=? WHERE id=?",
                (utc_now(), str(error), run_id),
            )
            exists = connection.execute(
                """SELECT 1 FROM human_queue
                   WHERE kind='knowledge_snapshot_invalid' AND status='open'
                     AND json_extract(payload_json, '$.rule_id')=?""",
                (error.rule_id,),
            ).fetchone()
            if exists is None:
                connection.execute(
                    """INSERT INTO human_queue(
                           block_id, kind, severity, payload_json, created_at
                       ) VALUES(NULL, 'knowledge_snapshot_invalid', 'blocking', ?, ?)""",
                    (
                        json.dumps(
                            {
                                "rule_id": error.rule_id,
                                "detail": error.detail,
                                "run_id": run_id,
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        utc_now(),
                    ),
                )

    def record_audit_call(
        self,
        run_id: str,
        block_id: Optional[str],
        purpose: str,
        model: str,
        knowledge_version: int,
        request: Dict[str, Any],
        raw_response: str,
        parsed: Optional[Dict[str, Any]],
        accepted: bool,
        attempts: int,
        elapsed_ms: int,
        error: Optional[str],
        connection: Optional[sqlite3.Connection] = None,
        archive_payload: bool = True,
    ) -> int:
        if connection is None:
            with self.transaction() as owned_connection:
                return self.record_audit_call(
                    run_id=run_id,
                    block_id=block_id,
                    purpose=purpose,
                    model=model,
                    knowledge_version=knowledge_version,
                    request=request,
                    raw_response=raw_response,
                    parsed=parsed,
                    accepted=accepted,
                    attempts=attempts,
                    elapsed_ms=elapsed_ms,
                    error=error,
                    connection=owned_connection,
                    archive_payload=archive_payload,
                )
        assert connection is not None
        archive_eligible = (
            archive_payload
            and accepted
            and not error
            and not self._is_human_audit(purpose, model, request, parsed)
        )
        locator: Optional[AuditLocator] = None
        request_json = json.dumps(request, ensure_ascii=False)
        stored_response = raw_response
        parsed_json = (
            json.dumps(parsed, ensure_ascii=False) if parsed is not None else None
        )
        if archive_eligible:
            locator = self._audit_transaction_for(connection).append(
                run_id,
                {
                    "request": request,
                    "raw_response": raw_response,
                    "parsed": parsed,
                },
                stage=purpose,
            )
            request_json = "{}"
            stored_response = ""
            parsed_json = None
        cursor = connection.execute(
            """INSERT INTO audit_calls(
                   run_id, block_id, purpose, model, knowledge_version, request_json,
                   raw_response, parsed_json, accepted, attempts, elapsed_ms, error,
                   archive_relative_path, archive_offset, archive_compressed_length,
                   archive_sha256, created_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id, block_id, purpose, model, knowledge_version,
                request_json, stored_response, parsed_json,
                int(accepted), attempts, elapsed_ms, error,
                locator.relative_path if locator else None,
                locator.offset if locator else None,
                locator.compressed_length if locator else None,
                locator.sha256 if locator else None,
                utc_now(),
            ),
        )
        return int(cursor.lastrowid)

    def read_audit_payload(self, audit_call_id: int) -> Dict[str, Any]:
        """Return one full archived or inline audit payload by SQL identity."""
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM audit_calls WHERE id=?", (int(audit_call_id),)
            ).fetchone()
        if row is None:
            raise KeyError(f"audit call does not exist: {audit_call_id}")
        if row["archive_relative_path"]:
            return self.audit_archive.read(
                AuditLocator(
                    relative_path=str(row["archive_relative_path"]),
                    offset=int(row["archive_offset"]),
                    compressed_length=int(row["archive_compressed_length"]),
                    sha256=str(row["archive_sha256"]),
                )
            )
        return {
            "request": json.loads(row["request_json"]),
            "raw_response": str(row["raw_response"]),
            "parsed": (
                json.loads(row["parsed_json"])
                if row["parsed_json"] is not None
                else None
            ),
        }

    @staticmethod
    def _is_human_audit(
        purpose: str,
        model: str,
        request: Dict[str, Any],
        parsed: Optional[Dict[str, Any]],
    ) -> bool:
        values = [
            purpose,
            model,
            request.get("provider"),
            request.get("call_type"),
            request.get("actor_type"),
            (parsed or {}).get("provider"),
            (parsed or {}).get("call_type"),
            (parsed or {}).get("actor_type"),
        ]
        for value in values:
            normalized = str(value or "").strip().casefold()
            tokens = set(re.findall(r"[a-z0-9]+", normalized))
            if {"human", "manual"} & tokens:
                return True
        return False

    @classmethod
    def _audit_row_is_human(cls, row: sqlite3.Row) -> bool:
        """Classify persisted audits with the same policy used at write time."""

        try:
            request = json.loads(row["request_json"] or "{}")
            parsed = (
                json.loads(row["parsed_json"])
                if row["parsed_json"] is not None
                else None
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            # A destructive reset must preserve an audit it cannot classify.
            return True
        if not isinstance(request, dict) or (
            parsed is not None and not isinstance(parsed, dict)
        ):
            return True
        return cls._is_human_audit(
            str(row["purpose"] or ""),
            str(row["model"] or ""),
            request,
            parsed,
        )

    @staticmethod
    def _audit_fields(
        mode: str,
        request: Dict[str, Any],
        raw_response: str,
        parsed: Optional[Dict[str, Any]],
    ) -> tuple[Dict[str, Any], str, Optional[Dict[str, Any]]]:
        if mode not in {"full", "response", "minimal"}:
            raise ValueError("audit_mode 必须是 full、response 或 minimal")
        return request, raw_response, parsed

    def commit_scan_batch(
        self,
        run_id: str,
        outcomes: Sequence[ScanOutcome],
        model: str,
        audit_mode: str = "full",
    ) -> int:
        """Commit worker results in deterministic block order and create one version."""
        ordered = sorted(outcomes, key=lambda item: item.block.global_index)
        with self.transaction() as connection:
            version = (
                self.create_knowledge_version(f"scan batch {run_id}", connection)
                if any(outcome.response is not None for outcome in ordered)
                else int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            )
            for outcome in ordered:
                for candidate in outcome.lexical_candidates:
                    connection.execute(
                        """INSERT INTO lexical_candidates(
                               id, block_id, paragraph_id, start_offset, end_offset,
                               original_text, normalized_text, left_context, right_context,
                               extraction_reason, book_frequency, risk_flags_json,
                               model_status, resolution_status, selected, run_id,
                               created_at, updated_at
                           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET
                               paragraph_id=excluded.paragraph_id,
                               start_offset=excluded.start_offset,
                               end_offset=excluded.end_offset,
                               original_text=excluded.original_text,
                               normalized_text=excluded.normalized_text,
                               left_context=excluded.left_context,
                               right_context=excluded.right_context,
                               extraction_reason=excluded.extraction_reason,
                               book_frequency=excluded.book_frequency,
                               risk_flags_json=excluded.risk_flags_json,
                               model_status=CASE
                                   WHEN lexical_candidates.resolution_status='pending'
                                   THEN excluded.model_status
                                   ELSE lexical_candidates.model_status END,
                               resolution_status=CASE
                                   WHEN lexical_candidates.resolution_status='pending'
                                   THEN excluded.resolution_status
                                   ELSE lexical_candidates.resolution_status END,
                               selected=CASE
                                   WHEN lexical_candidates.resolution_status='pending'
                                   THEN excluded.selected
                                   ELSE lexical_candidates.selected END,
                               run_id=excluded.run_id,
                               updated_at=excluded.updated_at""",
                        (
                            candidate["id"], outcome.block.id, candidate["paragraph_id"],
                            int(candidate["start_offset"]), int(candidate["end_offset"]),
                            candidate["original_text"], candidate["normalized_text"],
                            candidate.get("left_context", ""),
                            candidate.get("right_context", ""),
                            candidate["extraction_reason"],
                            int(candidate.get("book_frequency", 1)),
                            (
                                candidate.get("risk_flags_json")
                                if isinstance(candidate.get("risk_flags_json"), str)
                                else json.dumps(
                                    candidate.get("risk_flags", []),
                                    ensure_ascii=False,
                                    sort_keys=True,
                                )
                            ),
                            candidate.get("model_status", "pending"),
                            candidate.get("resolution_status", "pending"),
                            int(bool(candidate.get("selected"))),
                            run_id, utc_now(), utc_now(),
                        ),
                    )
                parsed = outcome.response.model_dump(mode="json") if outcome.response else None
                calls = outcome.audit_calls
                if not calls and outcome.attempts:
                    calls = [
                        {
                            "request": outcome.request_payload,
                            "raw_response": outcome.raw_response,
                            "parsed": parsed,
                            "accepted": outcome.response is not None,
                            "attempts": outcome.attempts,
                            "elapsed_ms": outcome.elapsed_ms,
                            "error": outcome.error,
                        }
                    ]
                for call in calls:
                    audit_request, audit_raw, audit_parsed = self._audit_fields(
                        audit_mode,
                        dict(call.get("request") or {}),
                        str(call.get("raw_response") or ""),
                        call.get("parsed"),
                    )
                    self.record_audit_call(
                        run_id, outcome.block.id, "scan", model, version,
                        audit_request, audit_raw, audit_parsed,
                        bool(call.get("accepted")),
                        int(call.get("attempts") or 1), int(call.get("elapsed_ms") or 0),
                        call.get("error"), connection,
                    )
                if not outcome.response:
                    connection.execute(
                        "UPDATE blocks SET status=?, last_error=?, updated_at=? WHERE id=?",
                        (V4BlockStatus.FAILED_RETRYABLE.value, outcome.error, utc_now(), outcome.block.id),
                    )
                    continue
                for mention in outcome.response.mentions:
                    payload = mention.model_dump(mode="json")
                    cursor = connection.execute(
                        """INSERT INTO evidence(
                               block_id, paragraph_id, kind, source_form, evidence_quote,
                               payload_json, confidence, extractor, run_id, created_at
                           ) VALUES(?, ?, 'mention', ?, ?, ?, ?, 'scan_v4_2', ?, ?)""",
                        (
                            outcome.block.id, mention.paragraph_id, mention.source_form,
                            mention.evidence_quote, json.dumps(payload, ensure_ascii=False),
                            mention.confidence, run_id, utc_now(),
                        ),
                    )
                    evidence_id = int(cursor.lastrowid)
                    normalized_form = normalize_english_form(
                        mention.canonical_form or mention.source_form
                    )
                    lexeme_id = self._ensure_schema8_lexeme(
                        connection,
                        mention.canonical_form or mention.source_form,
                        normalized_form=normalized_form,
                        knowledge_version=version,
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO mentions(
                               block_id, paragraph_id, source_form, normalized_form,
                               discourse_function, lexeme_id, evidence_id
                           ) VALUES(?, ?, ?, ?, ?, ?, ?)""",
                        (
                            outcome.block.id, mention.paragraph_id, mention.source_form,
                            normalized_form, mention.discourse_function, lexeme_id,
                            evidence_id,
                        ),
                    )
                for ambiguity in outcome.response.ambiguities:
                    cursor = connection.execute(
                        """INSERT INTO evidence(
                               block_id, paragraph_id, kind, evidence_quote, payload_json,
                               confidence, extractor, run_id, created_at
                           ) VALUES(?, ?, 'ambiguity', ?, ?, ?, 'scan_v4', ?, ?)""",
                        (
                            outcome.block.id, ambiguity.paragraph_id, ambiguity.evidence_quote,
                            json.dumps(ambiguity.model_dump(mode="json"), ensure_ascii=False),
                            ambiguity.confidence, run_id, utc_now(),
                        ),
                    )
                    evidence_id = int(cursor.lastrowid)
                    claim_id = stable_id(
                        "claim",
                        (
                            f"translation_constraint:{outcome.block.id}:"
                            f"{ambiguity.paragraph_id}:{ambiguity.constraint}"
                        ),
                    )
                    old_claim_state = self._claim_state_for_subject(
                        connection, claim_id
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO claims(
                               id, kind, statement, subject_form, status, scope,
                               confidence, reveal_global_index, high_impact, locked,
                               created_version, created_at
                           ) VALUES(?, 'translation_constraint', ?, ?, 'proposed',
                                    'occurrence', ?, ?, 0, 0, ?, ?)""",
                        (
                            claim_id,
                            ambiguity.constraint,
                            ambiguity.evidence_quote,
                            ambiguity.confidence,
                            outcome.block.global_index,
                            version,
                            utc_now(),
                        ),
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO claim_evidence(claim_id, evidence_id)
                           VALUES(?, ?)""",
                        (claim_id, evidence_id),
                    )
                    self.record_render_change(
                        connection,
                        subject_type="claim",
                        subject_id=claim_id,
                        old_state=old_claim_state,
                        new_state=self._claim_state_for_subject(
                            connection, claim_id
                        ),
                        change_kind="claim",
                        reason=f"scan ambiguity claim {claim_id}",
                        knowledge_version=version,
                        record_metadata=True,
                    )
                    verification_payload = {
                        "kind": "translation_constraint",
                        "statement": ambiguity.constraint,
                        "subject_form": ambiguity.evidence_quote,
                        "reveal_global_index": outcome.block.global_index,
                        "evidence": [
                            {
                                "block": outcome.block.id,
                                "paragraph_id": ambiguity.paragraph_id,
                                "evidence_quote": ambiguity.evidence_quote,
                            }
                        ],
                    }
                    task_id = stable_id("verify", f"claim:{claim_id}", length=24)
                    connection.execute(
                        """INSERT OR IGNORE INTO verification_tasks(
                               id, subject_type, subject_id, payload_json, status,
                               required_votes, created_at
                           ) VALUES(?, 'claim', ?, ?, 'open', 2, ?)""",
                        (
                            task_id,
                            claim_id,
                            json.dumps(
                                verification_payload, ensure_ascii=False, sort_keys=True
                            ),
                            utc_now(),
                        ),
                    )
                connection.execute(
                    "UPDATE blocks SET status=?, last_error=NULL, updated_at=? WHERE id=?",
                    (V4BlockStatus.SCANNED.value, utc_now(), outcome.block.id),
                )
            return version

    def commit_candidate_index_batch(
        self, run_id: str, outcomes: Sequence[ScanOutcome]
    ) -> Dict[str, int]:
        """Atomically persist deterministic candidates and block scan states.

        This deliberately creates neither a knowledge version nor model audit rows:
        candidate indexing is local evidence collection, not a knowledge decision.
        """
        ordered = sorted(outcomes, key=lambda item: item.block.global_index)
        indexed = failed = lexical_count = 0
        with self.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM runs WHERE id=?", (run_id,)
            ).fetchone() is None:
                raise ValueError(f"unknown run: {run_id}")
            for outcome in ordered:
                if outcome.error is not None or outcome.response is None:
                    connection.execute(
                        """UPDATE blocks
                           SET status=CASE
                                   WHEN status IN (?, ?) THEN ? ELSE status END,
                               last_error=CASE
                                   WHEN status IN (?, ?) THEN ? ELSE last_error END,
                               updated_at=CASE
                                   WHEN status IN (?, ?) THEN ? ELSE updated_at END
                           WHERE id=?""",
                        (
                            V4BlockStatus.PENDING.value,
                            V4BlockStatus.FAILED_RETRYABLE.value,
                            V4BlockStatus.FAILED_RETRYABLE.value,
                            V4BlockStatus.PENDING.value,
                            V4BlockStatus.FAILED_RETRYABLE.value,
                            outcome.error or "candidate indexing failed",
                            V4BlockStatus.PENDING.value,
                            V4BlockStatus.FAILED_RETRYABLE.value,
                            utc_now(),
                            outcome.block.id,
                        ),
                    )
                    failed += 1
                    continue
                indexed_candidates = [
                    dict(candidate) for candidate in outcome.lexical_candidates
                ]
                incoming_ids = sorted(
                    {str(candidate["id"]) for candidate in indexed_candidates}
                )
                existing_by_id: Dict[str, sqlite3.Row] = {}
                if incoming_ids:
                    placeholders = ",".join("?" for _ in incoming_ids)
                    existing_by_id = {
                        row["id"]: row
                        for row in connection.execute(
                            f"""SELECT lc.id, lc.block_id, lc.paragraph_id,
                                       lc.start_offset, lc.end_offset,
                                       lc.original_text, lc.normalized_text,
                                       MAX(CASE WHEN cc.state='leased' THEN 1 ELSE 0 END)
                                           AS leased
                                FROM lexical_candidates lc
                                LEFT JOIN candidate_cluster_members cm
                                  ON cm.candidate_id=lc.id
                                LEFT JOIN candidate_clusters cc ON cc.id=cm.cluster_id
                                WHERE lc.id IN ({placeholders})
                                GROUP BY lc.id""",
                            incoming_ids,
                        ).fetchall()
                    }
                for candidate in indexed_candidates:
                    base_id = str(candidate["id"])
                    existing = existing_by_id.get(base_id)
                    if existing is None or not bool(existing["leased"]):
                        continue
                    identity = (
                        outcome.block.id,
                        str(candidate["paragraph_id"]),
                        int(candidate["start_offset"]),
                        int(candidate["end_offset"]),
                        str(candidate["original_text"]),
                        str(candidate["normalized_text"]),
                    )
                    existing_identity = (
                        existing["block_id"],
                        existing["paragraph_id"],
                        int(existing["start_offset"]),
                        int(existing["end_offset"]),
                        existing["original_text"],
                        existing["normalized_text"],
                    )
                    if identity != existing_identity:
                        encoded_identity = json.dumps(
                            [base_id, *identity],
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        candidate["id"] = "cand_" + hashlib.sha256(
                            encoded_identity.encode("utf-8")
                        ).hexdigest()[:20]
                current_candidate_ids = {
                    str(candidate["id"]) for candidate in indexed_candidates
                }
                self._remove_stale_pending_candidates(
                    connection, outcome.block.id, current_candidate_ids
                )
                for candidate in indexed_candidates:
                    risk_flags = candidate.get("risk_flags_json")
                    if not isinstance(risk_flags, str):
                        risk_flags = json.dumps(
                            candidate.get("risk_flags", []),
                            ensure_ascii=False,
                            sort_keys=True,
                        )
                    now = utc_now()
                    connection.execute(
                        """INSERT INTO lexical_candidates(
                               id, block_id, paragraph_id, start_offset, end_offset,
                               original_text, normalized_text, left_context, right_context,
                               extraction_reason, book_frequency, risk_flags_json,
                               model_status, resolution_status, selected, run_id,
                               created_at, updated_at
                           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
                                    'pending', 0, ?, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET
                               paragraph_id=excluded.paragraph_id,
                               start_offset=excluded.start_offset,
                               end_offset=excluded.end_offset,
                               original_text=excluded.original_text,
                               normalized_text=excluded.normalized_text,
                               left_context=excluded.left_context,
                               right_context=excluded.right_context,
                               extraction_reason=excluded.extraction_reason,
                               book_frequency=excluded.book_frequency,
                               risk_flags_json=excluded.risk_flags_json,
                               model_status=CASE
                                   WHEN lexical_candidates.resolution_status='pending'
                                   THEN 'pending' ELSE lexical_candidates.model_status END,
                               selected=CASE
                                   WHEN lexical_candidates.resolution_status='pending'
                                   THEN 0 ELSE lexical_candidates.selected END,
                                run_id=CASE
                                    WHEN lexical_candidates.resolution_status='pending'
                                    THEN excluded.run_id ELSE lexical_candidates.run_id END,
                                updated_at=CASE
                                    WHEN lexical_candidates.paragraph_id=excluded.paragraph_id
                                     AND lexical_candidates.start_offset=excluded.start_offset
                                     AND lexical_candidates.end_offset=excluded.end_offset
                                     AND lexical_candidates.original_text=excluded.original_text
                                     AND lexical_candidates.normalized_text=excluded.normalized_text
                                     AND lexical_candidates.left_context=excluded.left_context
                                     AND lexical_candidates.right_context=excluded.right_context
                                     AND lexical_candidates.risk_flags_json=excluded.risk_flags_json
                                    THEN lexical_candidates.updated_at
                                    ELSE excluded.updated_at END""",
                        (
                            candidate["id"],
                            outcome.block.id,
                            candidate["paragraph_id"],
                            int(candidate["start_offset"]),
                            int(candidate["end_offset"]),
                            candidate["original_text"],
                            candidate["normalized_text"],
                            candidate.get("left_context", ""),
                            candidate.get("right_context", ""),
                            candidate["extraction_reason"],
                            int(candidate.get("book_frequency", 1)),
                            risk_flags,
                            run_id,
                            now,
                            now,
                        ),
                    )
                    lexical_count += 1
                is_front_matter = bool(
                    outcome.request_payload.get("front_matter", False)
                )
                status = (
                    V4BlockStatus.READY.value
                    if is_front_matter
                    else V4BlockStatus.SCANNED.value
                )
                connection.execute(
                    """UPDATE blocks
                       SET status=CASE
                               WHEN status IN (?, ?) THEN ? ELSE status END,
                           last_error=CASE
                               WHEN status IN (?, ?) THEN NULL ELSE last_error END,
                           updated_at=CASE
                               WHEN status IN (?, ?) THEN ? ELSE updated_at END
                       WHERE id=?""",
                    (
                        V4BlockStatus.PENDING.value,
                        V4BlockStatus.FAILED_RETRYABLE.value,
                        status,
                        V4BlockStatus.PENDING.value,
                        V4BlockStatus.FAILED_RETRYABLE.value,
                        V4BlockStatus.PENDING.value,
                        V4BlockStatus.FAILED_RETRYABLE.value,
                        utc_now(),
                        outcome.block.id,
                    ),
                )
                indexed += 1
        return {"indexed": indexed, "failed": failed, "candidates": lexical_count}

    def advance_prepared_blocks(
        self, block_ids: Optional[Sequence[str]] = None
    ) -> Dict[str, int]:
        """Move only provably complete scanned blocks into the translation queue.

        A supplied scope is the successful block set from one local scan run.
        Standalone target resolution may omit it to reconsider all still-scanned
        blocks, but every block is checked against the same persisted invariants.
        """

        scoped_ids = tuple(sorted({str(block_id) for block_id in block_ids or ()}))
        if block_ids is not None and not scoped_ids:
            return {"ready": 0, "blocked": 0}
        with self.transaction() as connection:
            scope_join = ""
            if block_ids is not None:
                connection.execute(
                    "CREATE TEMP TABLE preparation_scope(block_id TEXT PRIMARY KEY)"
                )
                connection.executemany(
                    "INSERT INTO preparation_scope(block_id) VALUES(?)",
                    ((block_id,) for block_id in scoped_ids),
                )
                scope_join = "JOIN preparation_scope ps ON ps.block_id=b.id"

            scanned_rows = connection.execute(
                f"""SELECT b.id
                    FROM blocks b
                    JOIN source_editions se
                      ON se.id=b.source_edition_id AND se.active=1
                    {scope_join}
                    WHERE b.status=?
                    ORDER BY b.global_index, b.id""",
                (V4BlockStatus.SCANNED.value,),
            ).fetchall()
            scanned_ids = [str(row["id"]) for row in scanned_rows]
            if not scanned_ids:
                return {"ready": 0, "blocked": 0}

            ready_rows = connection.execute(
                f"""SELECT b.id
                    FROM blocks b
                    JOIN source_editions se
                      ON se.id=b.source_edition_id AND se.active=1
                    {scope_join}
                    WHERE b.status=?
                      AND b.last_error IS NULL
                      AND NOT EXISTS(
                          SELECT 1 FROM lexical_candidates lc
                          WHERE lc.block_id=b.id
                            AND lc.resolution_status NOT IN (
                                'promoted', 'rejected', 'superseded', 'deferred'
                            )
                      )
                      AND NOT EXISTS(
                          SELECT 1
                          FROM lexical_candidates lc
                          JOIN candidate_cluster_members cm
                            ON cm.candidate_id=lc.id
                          JOIN candidate_clusters cc ON cc.id=cm.cluster_id
                          WHERE lc.block_id=b.id
                            AND cc.state IN ('pending', 'leased', 'stale')
                      )
                      AND NOT EXISTS(
                          SELECT 1
                          FROM lexical_candidates lc
                          JOIN candidate_cluster_members cm
                            ON cm.candidate_id=lc.id
                          JOIN candidate_adjudications ca
                            ON ca.cluster_id=cm.cluster_id AND ca.active=1
                          WHERE lc.block_id=b.id
                            AND ca.reason='model_protocol_failure'
                      )
                      AND NOT EXISTS(
                          SELECT 1
                          FROM lexical_candidates lc
                          JOIN candidate_resolutions cr
                            ON cr.candidate_id=lc.id
                          JOIN candidate_adjudications ca
                            ON ca.id=cr.adjudication_id AND ca.active=1
                          JOIN human_queue hq
                            ON hq.kind='working_target_required'
                           AND hq.status='open'
                           AND json_extract(hq.payload_json, '$.concept_id')=
                               cr.concept_id
                          WHERE lc.block_id=b.id
                            AND cr.concept_id IS NOT NULL
                      )
                      AND NOT EXISTS(
                          SELECT 1
                          FROM mentions m
                          JOIN human_queue hq
                            ON hq.kind='working_target_required'
                           AND hq.status='open'
                           AND json_extract(hq.payload_json, '$.concept_id')=
                               m.concept_id
                          WHERE m.block_id=b.id AND m.concept_id IS NOT NULL
                      )
                      AND NOT EXISTS(
                          SELECT 1 FROM human_queue hq
                          WHERE hq.block_id=b.id AND hq.status='open'
                            AND hq.severity='blocking'
                      )
                    ORDER BY b.global_index, b.id""",
                (V4BlockStatus.SCANNED.value,),
            ).fetchall()
            ready_ids = [str(row["id"]) for row in ready_rows]
            now = utc_now()
            connection.executemany(
                """UPDATE blocks SET status=?, last_error=NULL, updated_at=?
                   WHERE id=? AND status=?""",
                (
                    (
                        V4BlockStatus.READY.value,
                        now,
                        block_id,
                        V4BlockStatus.SCANNED.value,
                    )
                    for block_id in ready_ids
                ),
            )
            return {
                "ready": len(ready_ids),
                "blocked": len(scanned_ids) - len(ready_ids),
            }

    @staticmethod
    def _remove_stale_pending_candidates(
        connection: sqlite3.Connection,
        block_id: str,
        current_candidate_ids: set[str],
    ) -> None:
        params: List[Any] = [block_id]
        current_clause = ""
        if current_candidate_ids:
            placeholders = ",".join("?" for _ in current_candidate_ids)
            current_clause = f" AND lc.id NOT IN ({placeholders})"
            params.extend(sorted(current_candidate_ids))
        rows = connection.execute(
            """SELECT lc.id
               FROM lexical_candidates lc
               WHERE lc.block_id=? AND lc.resolution_status='pending'"""
            + current_clause
            + """
                 AND NOT EXISTS(
                     SELECT 1 FROM candidate_resolutions cr
                     WHERE cr.candidate_id=lc.id
                 )
                 AND NOT EXISTS(
                     SELECT 1
                     FROM candidate_cluster_members cm
                     JOIN candidate_clusters cc ON cc.id=cm.cluster_id
                     WHERE cm.candidate_id=lc.id
                       AND (
                           cc.state!='pending'
                           OR EXISTS(
                               SELECT 1 FROM candidate_adjudications ca
                               WHERE ca.cluster_id=cc.id
                           )
                       )
                 )
               ORDER BY lc.id""",
            params,
        ).fetchall()
        stale_ids = [row["id"] for row in rows]
        if not stale_ids:
            return
        placeholders = ",".join("?" for _ in stale_ids)
        connection.execute(
            f"""DELETE FROM candidate_clusters
                WHERE state='pending'
                  AND NOT EXISTS(
                      SELECT 1 FROM candidate_adjudications ca
                      WHERE ca.cluster_id=candidate_clusters.id
                  )
                  AND id IN (
                      SELECT cluster_id FROM candidate_cluster_members
                      WHERE candidate_id IN ({placeholders})
                  )""",
            stale_ids,
        )
        connection.execute(
            f"DELETE FROM lexical_candidates WHERE id IN ({placeholders})",
            stale_ids,
        )

    @staticmethod
    def _safe_string_tuple_json(value: Any) -> tuple[str, ...]:
        """Parse bounded string-list JSON without trusting malformed storage."""
        try:
            parsed = json.loads(value) if isinstance(value, str) else value
        except (TypeError, ValueError):
            return ()
        if not isinstance(parsed, list) or any(
            not isinstance(item, str) for item in parsed
        ):
            return ()
        return tuple(sorted(set(parsed)))

    @classmethod
    def _row_to_lexical_candidate(cls, row: sqlite3.Row) -> Any:
        from .lexical_index import LexicalCandidate

        return LexicalCandidate(
            id=row["id"],
            block_id=row["block_id"],
            paragraph_id=row["paragraph_id"],
            start_offset=int(row["start_offset"]),
            end_offset=int(row["end_offset"]),
            original_text=row["original_text"],
            normalized_text=row["normalized_text"],
            left_context=row["left_context"] or "",
            right_context=row["right_context"] or "",
            extraction_reason=row["extraction_reason"],
            book_frequency=int(row["book_frequency"] or 1),
            score=0,
            risk_flags=cls._safe_string_tuple_json(row["risk_flags_json"]),
        )

    @staticmethod
    def _pending_lexical_rows(
        connection: sqlite3.Connection,
    ) -> List[sqlite3.Row]:
        return connection.execute(
            """SELECT lc.* FROM lexical_candidates lc
               JOIN blocks b ON b.id=lc.block_id
               WHERE lc.resolution_status='pending'
                 AND b.source_edition_id=(
                     SELECT id FROM source_editions WHERE active=1
                 )
                 AND NOT EXISTS (
                     SELECT 1
                     FROM candidate_cluster_members cm
                     JOIN candidate_adjudications ca
                       ON ca.cluster_id=cm.cluster_id
                     WHERE cm.candidate_id=lc.id AND ca.active=1
                 )
                 AND substr(
                       b.source_text,
                       lc.start_offset + 1,
                       lc.end_offset - lc.start_offset
                     )=lc.original_text
               ORDER BY b.global_index, lc.start_offset, lc.end_offset, lc.id"""
        ).fetchall()

    @staticmethod
    def _candidate_snapshot_token(rows: Sequence[sqlite3.Row]) -> str:
        payload = [
            [row["id"], row["updated_at"], row["resolution_status"]]
            for row in rows
        ]
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def load_pending_candidate_snapshot(self) -> tuple[str, List[Any]]:
        """Read candidates and their CAS token from one SQLite snapshot."""
        with closing(self.connect()) as connection:
            rows = self._pending_lexical_rows(connection)
        return (
            self._candidate_snapshot_token(rows),
            [self._row_to_lexical_candidate(row) for row in rows],
        )

    def load_pending_lexical_candidates(self) -> List[Any]:
        """Return every unresolved, unclaimed local candidate."""
        return self.load_pending_candidate_snapshot()[1]

    @staticmethod
    def _candidate_cluster_members(cluster: Any) -> List[Dict[str, Any]]:
        from .candidate_clusters import CandidateClusterBuilder

        members: Dict[str, Dict[str, Any]] = {}
        alternatives_by_key = {
            CandidateClusterBuilder._alternative_equivalence_key(alternative): alternative.id
            for alternative in cluster.alternatives
        }
        for candidate in tuple(getattr(cluster, "members", ()) or ()):
            representative_id = alternatives_by_key.get(
                CandidateClusterBuilder._alternative_equivalence_key(candidate)
            )
            members[candidate.id] = {
                "candidate_id": candidate.id,
                "role": "support",
                "block_id": candidate.block_id,
                "context": {
                    "representative_candidate_id": representative_id,
                    "support_member": True,
                },
            }
        for alternative in cluster.alternatives:
            existing = members.get(alternative.id)
            members[alternative.id] = {
                "candidate_id": alternative.id,
                "role": "alternative",
                "block_id": alternative.block_id,
                "context": {
                    **(existing["context"] if existing else {}),
                    "representative_candidate_id": alternative.id,
                    "support_member": True,
                },
            }
        for context in cluster.contexts:
            existing = members.get(context.candidate_id)
            existing_context = dict(existing["context"]) if existing else {}
            payload = {
                "candidate_id": context.candidate_id,
                "role": (
                    "both"
                    if existing and existing["role"] == "alternative"
                    else "context"
                ),
                "block_id": context.block_id,
                "context": {
                    **existing_context,
                    "block_id": context.block_id,
                    "paragraph_id": context.paragraph_id,
                    "original_text": context.original_text,
                    "left_context": context.left_context,
                    "right_context": context.right_context,
                    "risk_flags": list(context.risk_flags),
                },
            }
            members[context.candidate_id] = payload
        return [members[candidate_id] for candidate_id in sorted(members)]

    def persist_candidate_clusters(
        self, run_id: str, clusters: Sequence[Any]
    ) -> Dict[str, int]:
        """Persist bounded cluster decisions without removing source occurrences."""
        with self.transaction() as connection:
            return self._persist_candidate_clusters(connection, run_id, clusters)

    def _persist_candidate_clusters(
        self,
        connection: sqlite3.Connection,
        run_id: str,
        clusters: Sequence[Any],
    ) -> Dict[str, int]:
        ordered = sorted(clusters, key=lambda cluster: cluster.id)
        if len({cluster.id for cluster in ordered}) != len(ordered):
            raise ValueError("duplicate candidate cluster id")
        member_count = 0
        if connection.execute(
            "SELECT 1 FROM runs WHERE id=?", (run_id,)
        ).fetchone() is None:
            raise ValueError(f"unknown run: {run_id}")
        for ordinal, cluster in enumerate(ordered):
            members = self._candidate_cluster_members(cluster)
            if not members:
                raise ValueError(f"candidate cluster has no members: {cluster.id}")
            candidate_ids = [member["candidate_id"] for member in members]
            placeholders = ",".join("?" for _ in candidate_ids)
            existing_ids = {
                row[0]
                for row in connection.execute(
                    f"SELECT id FROM lexical_candidates WHERE id IN ({placeholders})",
                    candidate_ids,
                ).fetchall()
            }
            missing = sorted(set(candidate_ids) - existing_ids)
            if missing:
                raise ValueError(
                    f"unknown lexical candidate(s) in cluster {cluster.id}: {', '.join(missing)}"
                )
            block_ids = sorted({member["block_id"] for member in members})
            now = utc_now()
            connection.execute(
                """INSERT INTO candidate_clusters(
                           run_id, id, risk_flags_json, affected_blocks_json,
                           affected_block_count, ordinal, created_at, updated_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                           run_id=excluded.run_id,
                           risk_flags_json=excluded.risk_flags_json,
                           affected_blocks_json=excluded.affected_blocks_json,
                           affected_block_count=excluded.affected_block_count,
                           ordinal=excluded.ordinal,
                           updated_at=excluded.updated_at""",
                (
                    run_id,
                    cluster.id,
                    json.dumps(
                        sorted(set(cluster.risk_flags)),
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    json.dumps(
                        block_ids,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    int(cluster.affected_blocks),
                    ordinal,
                    now,
                    now,
                ),
            )
            connection.execute(
                "DELETE FROM candidate_cluster_members WHERE cluster_id=?",
                (cluster.id,),
            )
            for member_ordinal, member in enumerate(members):
                connection.execute(
                    """INSERT INTO candidate_cluster_members(
                               run_id, cluster_id, candidate_id, role, ordinal,
                               context_json, created_at
                           ) VALUES(?, ?, ?, ?, ?, ?, ?)""",
                    (
                        run_id,
                        cluster.id,
                        member["candidate_id"],
                        member["role"],
                        member_ordinal,
                        json.dumps(
                            member["context"],
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        now,
                    ),
                )
            member_count += len(members)
        return {"clusters": len(ordered), "members": member_count}

    def replace_pending_candidate_clusters(
        self,
        run_id: str,
        clusters: Sequence[Any],
        *,
        expected_snapshot_token: Optional[str] = None,
    ) -> Dict[str, int]:
        """Atomically rebuild undecided clusters while preserving all history."""
        with self.transaction() as connection:
            if expected_snapshot_token is not None:
                current_rows = self._pending_lexical_rows(connection)
                current_token = self._candidate_snapshot_token(current_rows)
                if current_token != expected_snapshot_token:
                    raise StaleCandidateSnapshot(
                        "pending candidate snapshot changed during clustering"
                    )
            stale_candidate_ids = [
                row["candidate_id"]
                for row in connection.execute(
                    """SELECT DISTINCT cm.candidate_id
                       FROM candidate_cluster_members cm
                       JOIN candidate_clusters cc ON cc.id=cm.cluster_id
                       WHERE cc.state='stale'
                         AND NOT EXISTS(
                             SELECT 1 FROM candidate_adjudications ca
                             WHERE ca.cluster_id=cc.id
                         )
                       ORDER BY cm.candidate_id"""
                ).fetchall()
            ]
            refreshed_clusters = []
            for cluster in clusters:
                proposed = cluster
                seen_ids = set()
                while True:
                    collision = connection.execute(
                        """SELECT state, lease_snapshot_hash
                           FROM candidate_clusters
                           WHERE id=? AND state IN ('leased', 'stale')""",
                        (proposed.id,),
                    ).fetchone()
                    if collision is None:
                        refreshed_clusters.append(proposed)
                        break
                    incoming_hash = self._incoming_candidate_cluster_snapshot(
                        connection, proposed
                    )
                    if (
                        collision["state"] == "leased"
                        and collision["lease_snapshot_hash"] == incoming_hash
                    ):
                        break
                    if proposed.id in seen_ids:
                        raise ValueError("candidate cluster refresh generation cycle")
                    seen_ids.add(proposed.id)
                    refreshed_id = stable_id(
                        "cluster",
                        f"refreshed:{proposed.id}:{incoming_hash}",
                        length=20,
                    )
                    proposed = replace(proposed, id=refreshed_id)
            connection.execute(
                """DELETE FROM candidate_clusters
                   WHERE state IN ('pending', 'stale')
                     AND NOT EXISTS (
                       SELECT 1 FROM candidate_adjudications ca
                       WHERE ca.cluster_id=candidate_clusters.id
                   )"""
            )
            latest_history: Dict[str, str] = {}
            for row in connection.execute(
                """SELECT cluster_id, id
                   FROM candidate_adjudications
                   ORDER BY cluster_id, created_at DESC, id DESC"""
            ).fetchall():
                latest_history.setdefault(row["cluster_id"], row["id"])
            safe_clusters = []
            for cluster in refreshed_clusters:
                reopened_id = cluster.id
                member_ids = sorted(
                    member["candidate_id"]
                    for member in self._candidate_cluster_members(cluster)
                )
                seen_ids = set()
                while reopened_id in latest_history:
                    if reopened_id in seen_ids:
                        raise ValueError("candidate cluster generation cycle")
                    seen_ids.add(reopened_id)
                    reopened_id = stable_id(
                        "cluster",
                        "reopened:"
                        + reopened_id
                        + ":"
                        + latest_history[reopened_id]
                        + ":"
                        + "|".join(member_ids),
                        length=20,
                    )
                safe_clusters.append(
                    cluster
                    if reopened_id == cluster.id
                    else replace(cluster, id=reopened_id)
                )
            summary = self._persist_candidate_clusters(
                connection, run_id, safe_clusters
            )
            if stale_candidate_ids:
                placeholders = ",".join("?" for _ in stale_candidate_ids)
                connection.execute(
                    f"""DELETE FROM lexical_candidates
                        WHERE id IN ({placeholders})
                          AND resolution_status='pending'
                          AND NOT EXISTS(
                              SELECT 1 FROM candidate_resolutions cr
                              WHERE cr.candidate_id=lexical_candidates.id
                          )
                          AND NOT EXISTS(
                              SELECT 1 FROM candidate_cluster_members cm
                              WHERE cm.candidate_id=lexical_candidates.id
                          )""",
                    stale_candidate_ids,
                )
            return summary

    def load_pending_candidate_clusters(
        self, max_clusters: Optional[int] = None
    ) -> List[Any]:
        """Bulk-rehydrate never-adjudicated pending clusters."""
        query = """SELECT cc.* FROM candidate_clusters cc
                   WHERE cc.state='pending'
                     AND NOT EXISTS (
                       SELECT 1 FROM candidate_adjudications ca
                       WHERE ca.cluster_id=cc.id
                   )
                     AND EXISTS (
                       SELECT 1
                       FROM candidate_cluster_members cm
                       JOIN lexical_candidates lc ON lc.id=cm.candidate_id
                       JOIN blocks b ON b.id=lc.block_id
                       WHERE cm.cluster_id=cc.id
                         AND cm.role IN ('alternative', 'both')
                         AND lc.resolution_status='pending'
                         AND b.source_edition_id=(
                             SELECT id FROM source_editions WHERE active=1
                         )
                   )
                   ORDER BY cc.id"""
        params: List[Any] = []
        if max_clusters is not None:
            query += " LIMIT ?"
            params.append(max(0, int(max_clusters)))
        with closing(self.connect()) as connection:
            cluster_rows = connection.execute(query, params).fetchall()
            return self._hydrate_candidate_clusters(connection, cluster_rows)

    def _hydrate_candidate_clusters(
        self,
        connection: sqlite3.Connection,
        cluster_rows: Sequence[sqlite3.Row],
    ) -> List[Any]:
        from .candidate_clusters import CandidateCluster, CandidateContext

        if not cluster_rows:
            return []
        cluster_ids = [row["id"] for row in cluster_rows]
        placeholders = ",".join("?" for _ in cluster_ids)
        member_rows = connection.execute(
            f"""SELECT cm.cluster_id, cm.role, cm.ordinal, cm.context_json, lc.*
                FROM candidate_cluster_members cm
                JOIN lexical_candidates lc ON lc.id=cm.candidate_id
                WHERE cm.cluster_id IN ({placeholders})
                ORDER BY cm.cluster_id, cm.ordinal, lc.id""",
            cluster_ids,
        ).fetchall()
        members_by_cluster: Dict[str, List[sqlite3.Row]] = {}
        for member in member_rows:
            members_by_cluster.setdefault(member["cluster_id"], []).append(member)
        clusters: List[Any] = []
        for cluster_row in cluster_rows:
            alternatives = []
            contexts = []
            complete_members = []
            for member in members_by_cluster.get(cluster_row["id"], []):
                candidate = self._row_to_lexical_candidate(member)
                role = member["role"]
                try:
                    context_data = json.loads(member["context_json"] or "{}")
                except (TypeError, ValueError):
                    context_data = {}
                if not isinstance(context_data, dict):
                    context_data = {}
                if role in {"alternative", "both"} or bool(
                    context_data.get("support_member")
                ):
                    complete_members.append(candidate)
                if (
                    role in {"alternative", "both"}
                    and member["resolution_status"] == "pending"
                ):
                    alternatives.append(candidate)
                if role not in {"context", "both"}:
                    continue

                def context_string(field: str, fallback: str) -> str:
                    value = context_data.get(field, fallback)
                    return value if isinstance(value, str) else fallback

                contexts.append(
                    CandidateContext(
                        candidate_id=candidate.id,
                        block_id=context_string("block_id", candidate.block_id),
                        paragraph_id=context_string(
                            "paragraph_id", candidate.paragraph_id
                        ),
                        original_text=context_string(
                            "original_text", candidate.original_text
                        ),
                        left_context=context_string(
                            "left_context", candidate.left_context
                        ),
                        right_context=context_string(
                            "right_context", candidate.right_context
                        ),
                        risk_flags=self._safe_string_tuple_json(
                            context_data.get("risk_flags", [])
                        ),
                    )
                )
            if not alternatives:
                continue
            clusters.append(
                CandidateCluster(
                    id=cluster_row["id"],
                    alternatives=tuple(alternatives),
                    contexts=tuple(contexts),
                    risk_flags=self._safe_string_tuple_json(
                        cluster_row["risk_flags_json"]
                    ),
                    affected_blocks=int(cluster_row["affected_block_count"] or 0),
                    members=tuple(complete_members),
                )
            )
        return clusters

    @staticmethod
    def _candidate_cluster_snapshot_digest(
        cluster_id: str,
        risk_flags_json: str,
        affected_blocks_json: str,
        affected_block_count: int,
        members: Sequence[Dict[str, Any]],
    ) -> str:
        payload = {
            "cluster_id": cluster_id,
            "risk_flags_json": risk_flags_json,
            "affected_blocks_json": affected_blocks_json,
            "affected_block_count": int(affected_block_count),
            "members": list(members),
        }
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @staticmethod
    def _candidate_lexical_snapshot(member: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": member["lexical_id"],
            "block_id": member["block_id"],
            "paragraph_id": member["paragraph_id"],
            "start_offset": int(member["start_offset"]),
            "end_offset": int(member["end_offset"]),
            "original_text": member["original_text"],
            "normalized_text": member["normalized_text"],
            "left_context": member["left_context"],
            "right_context": member["right_context"],
            "risk_flags_json": member["lexical_risk_flags_json"],
            "updated_at": member["lexical_updated_at"],
            "source_hash": member["source_hash"],
            "source_edition_id": int(member["source_edition_id"]),
        }

    def _incoming_candidate_cluster_snapshot(
        self, connection: sqlite3.Connection, cluster: Any
    ) -> str:
        members = self._candidate_cluster_members(cluster)
        candidate_ids = [member["candidate_id"] for member in members]
        if not candidate_ids:
            raise ValueError(f"candidate cluster has no members: {cluster.id}")
        placeholders = ",".join("?" for _ in candidate_ids)
        lexical_by_id = {
            row["lexical_id"]: row
            for row in connection.execute(
                f"""SELECT lc.id AS lexical_id, lc.block_id, lc.paragraph_id,
                           lc.start_offset, lc.end_offset, lc.original_text,
                           lc.normalized_text, lc.left_context, lc.right_context,
                           lc.risk_flags_json AS lexical_risk_flags_json,
                           lc.updated_at AS lexical_updated_at,
                           b.source_hash, b.source_edition_id
                    FROM lexical_candidates lc
                    JOIN blocks b ON b.id=lc.block_id
                    WHERE lc.id IN ({placeholders})""",
                candidate_ids,
            ).fetchall()
        }
        payload_members: List[Dict[str, Any]] = []
        for ordinal, member in enumerate(members):
            item: Dict[str, Any] = {
                "candidate_id": member["candidate_id"],
                "role": member["role"],
                "ordinal": ordinal,
                "context_json": json.dumps(
                    member["context"],
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            }
            lexical = lexical_by_id.get(member["candidate_id"])
            if lexical is None:
                raise ValueError(
                    f"unknown lexical candidate: {member['candidate_id']}"
                )
            item["lexical"] = self._candidate_lexical_snapshot(lexical)
            payload_members.append(item)
        affected_blocks = sorted({member["block_id"] for member in members})
        return self._candidate_cluster_snapshot_digest(
            cluster.id,
            json.dumps(
                sorted(set(cluster.risk_flags)),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            json.dumps(
                affected_blocks,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            int(cluster.affected_blocks),
            payload_members,
        )

    @staticmethod
    def _candidate_cluster_lease_snapshot(
        connection: sqlite3.Connection, cluster_id: str
    ) -> tuple[str, bool]:
        """Hash exactly the persisted candidate/source view leased to the model."""
        cluster = connection.execute(
            """SELECT id, risk_flags_json, affected_blocks_json,
                      affected_block_count
               FROM candidate_clusters WHERE id=?""",
            (cluster_id,),
        ).fetchone()
        if cluster is None:
            raise ValueError(f"unknown candidate cluster: {cluster_id}")
        members = connection.execute(
            """SELECT cm.candidate_id, cm.role, cm.ordinal, cm.context_json,
                      lc.id AS lexical_id, lc.block_id, lc.paragraph_id,
                      lc.start_offset, lc.end_offset, lc.original_text,
                      lc.normalized_text, lc.left_context, lc.right_context,
                      lc.risk_flags_json AS lexical_risk_flags_json,
                      lc.updated_at AS lexical_updated_at,
                      b.source_hash, b.source_edition_id, b.source_text
               FROM candidate_cluster_members cm
               JOIN lexical_candidates lc ON lc.id=cm.candidate_id
               JOIN blocks b ON b.id=lc.block_id
               WHERE cm.cluster_id=?
               ORDER BY cm.ordinal, cm.candidate_id""",
            (cluster_id,),
        ).fetchall()
        payload_members: List[Dict[str, Any]] = []
        source_slices_current = True
        for member in members:
            item: Dict[str, Any] = {
                "candidate_id": member["candidate_id"],
                "role": member["role"],
                "ordinal": int(member["ordinal"]),
                "context_json": member["context_json"],
            }
            start = int(member["start_offset"])
            end = int(member["end_offset"])
            source_text = member["source_text"] or ""
            original_text = member["original_text"]
            source_slices_current = source_slices_current and (
                0 <= start <= end <= len(source_text)
                and source_text[start:end] == original_text
            )
            if member["role"] in {"context", "both"}:
                try:
                    leased_context = json.loads(member["context_json"] or "{}")
                except (TypeError, ValueError):
                    leased_context = {}
                if isinstance(leased_context, dict):
                    leased_original = leased_context.get("original_text")
                    if isinstance(leased_original, str):
                        source_slices_current = source_slices_current and (
                            leased_original == original_text
                        )
            item["lexical"] = V4Database._candidate_lexical_snapshot(member)
            payload_members.append(item)
        return (
            V4Database._candidate_cluster_snapshot_digest(
                cluster["id"],
                cluster["risk_flags_json"],
                cluster["affected_blocks_json"],
                int(cluster["affected_block_count"]),
                payload_members,
            ),
            source_slices_current,
        )

    @staticmethod
    def _leased_cluster_has_pending_replacement(
        connection: sqlite3.Connection, cluster_id: str
    ) -> bool:
        return connection.execute(
            """SELECT 1
               FROM candidate_cluster_members old_cm
               JOIN lexical_candidates old_lc ON old_lc.id=old_cm.candidate_id
               JOIN candidate_clusters replacement ON replacement.state='pending'
               JOIN candidate_cluster_members new_cm
                 ON new_cm.cluster_id=replacement.id
                AND new_cm.role IN ('alternative', 'both')
               JOIN lexical_candidates new_lc ON new_lc.id=new_cm.candidate_id
               WHERE old_cm.cluster_id=?
                 AND old_cm.role IN ('alternative', 'both')
                 AND replacement.id!=?
                 AND old_lc.block_id=new_lc.block_id
                 AND old_lc.paragraph_id=new_lc.paragraph_id
                 AND old_lc.start_offset < new_lc.end_offset
                 AND new_lc.start_offset < old_lc.end_offset
               LIMIT 1""",
            (cluster_id, cluster_id),
        ).fetchone() is not None

    def _release_or_stale_cluster_leases(
        self,
        connection: sqlite3.Connection,
        cluster_ids: Sequence[str],
    ) -> int:
        now = utc_now()
        released = 0
        for cluster_id in cluster_ids:
            lease = connection.execute(
                """SELECT lease_snapshot_hash FROM candidate_clusters
                   WHERE id=? AND state='leased'""",
                (cluster_id,),
            ).fetchone()
            if lease is None:
                continue
            current_hash, source_current = self._candidate_cluster_lease_snapshot(
                connection, cluster_id
            )
            replacement_exists = self._leased_cluster_has_pending_replacement(
                connection, cluster_id
            )
            next_state = "pending"
            if (
                not lease["lease_snapshot_hash"]
                or lease["lease_snapshot_hash"] != current_hash
                or not source_current
                or replacement_exists
            ):
                next_state = "stale"
            cursor = connection.execute(
                """UPDATE candidate_clusters
                   SET state=?, lease_run_id=NULL, lease_acquired_at=NULL,
                       lease_snapshot_hash=NULL, updated_at=?
                   WHERE id=? AND state='leased'""",
                (next_state, now, cluster_id),
            )
            released += int(cursor.rowcount)
        return released

    def claim_pending_candidate_clusters(
        self, run_id: str, limit: int = 12
    ) -> List[Any]:
        """Atomically lease at most twelve clusters to one adjudication run."""
        bounded_limit = max(0, min(int(limit), 12))
        if bounded_limit == 0:
            return []
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT stage, status FROM runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None or run["stage"] != "adjudicate" or run["status"] != "running":
                raise ValueError(f"run is not a running adjudication: {run_id}")
            cluster_rows = connection.execute(
                """SELECT cc.* FROM candidate_clusters cc
                   WHERE cc.state='pending'
                     AND NOT EXISTS(
                         SELECT 1 FROM candidate_adjudications ca
                         WHERE ca.cluster_id=cc.id
                     )
                     AND EXISTS(
                         SELECT 1
                         FROM candidate_cluster_members cm
                         JOIN lexical_candidates lc ON lc.id=cm.candidate_id
                         JOIN blocks b ON b.id=lc.block_id
                         WHERE cm.cluster_id=cc.id
                           AND cm.role IN ('alternative', 'both')
                           AND lc.resolution_status='pending'
                           AND b.source_edition_id=(
                               SELECT id FROM source_editions WHERE active=1
                           )
                     )
                   ORDER BY cc.id
                   LIMIT ?""",
                (bounded_limit,),
            ).fetchall()
            if not cluster_rows:
                return []
            now = utc_now()
            for cluster_row in cluster_rows:
                snapshot_hash, _source_current = (
                    self._candidate_cluster_lease_snapshot(
                        connection, cluster_row["id"]
                    )
                )
                cursor = connection.execute(
                    """UPDATE candidate_clusters
                       SET state='leased', lease_run_id=?, lease_acquired_at=?,
                           lease_snapshot_hash=?, updated_at=?
                       WHERE state='pending' AND id=?""",
                    (run_id, now, snapshot_hash, now, cluster_row["id"]),
                )
                if cursor.rowcount != 1:
                    raise StaleCandidateSnapshot("candidate cluster lease race")
            return self._hydrate_candidate_clusters(connection, cluster_rows)

    def has_claimable_candidate_clusters(self) -> bool:
        with closing(self.connect()) as connection:
            return connection.execute(
                """SELECT 1 FROM candidate_clusters cc
                   WHERE cc.state='pending'
                     AND NOT EXISTS(
                         SELECT 1 FROM candidate_adjudications ca
                         WHERE ca.cluster_id=cc.id
                     )
                     AND EXISTS(
                         SELECT 1
                         FROM candidate_cluster_members cm
                         JOIN lexical_candidates lc ON lc.id=cm.candidate_id
                         JOIN blocks b ON b.id=lc.block_id
                         WHERE cm.cluster_id=cc.id
                           AND cm.role IN ('alternative', 'both')
                           AND lc.resolution_status='pending'
                           AND b.source_edition_id=(
                               SELECT id FROM source_editions WHERE active=1
                           )
                     )
                   LIMIT 1"""
            ).fetchone() is not None

    def release_adjudication_leases(self, run_id: str) -> int:
        with self.transaction() as connection:
            cluster_ids = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM candidate_clusters
                       WHERE state='leased' AND lease_run_id=?
                         AND NOT EXISTS(
                             SELECT 1 FROM candidate_adjudications ca
                             WHERE ca.cluster_id=candidate_clusters.id
                         )
                       ORDER BY id""",
                    (run_id,),
                ).fetchall()
            ]
            return self._release_or_stale_cluster_leases(connection, cluster_ids)

    def recover_stale_candidate_leases(self, max_age_seconds: int = 3600) -> int:
        """Explicitly recover abandoned leases without touching active decisions."""
        cutoff_seconds = max(0, int(max_age_seconds))
        with self.transaction() as connection:
            cluster_ids = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM candidate_clusters
                       WHERE state='leased'
                         AND NOT EXISTS(
                             SELECT 1 FROM candidate_adjudications ca
                             WHERE ca.cluster_id=candidate_clusters.id
                         )
                         AND (
                             NOT EXISTS(
                                 SELECT 1 FROM runs r
                                 WHERE r.id=candidate_clusters.lease_run_id
                                   AND r.status='running'
                             )
                             OR julianday(lease_acquired_at) <=
                                julianday(?) - (? / 86400.0)
                         )
                       ORDER BY id""",
                    (utc_now(), cutoff_seconds),
                ).fetchall()
            ]
            return self._release_or_stale_cluster_leases(connection, cluster_ids)

    def finalize_adjudication_run(
        self, run_id: str, status: str, error: Optional[str] = None
    ) -> None:
        if status not in {"completed", "completed_with_errors", "failed"}:
            raise ValueError(f"invalid adjudication run status: {status}")
        with self.transaction() as connection:
            cluster_ids = [
                row["id"]
                for row in connection.execute(
                    """SELECT id FROM candidate_clusters
                       WHERE state='leased' AND lease_run_id=?
                         AND NOT EXISTS(
                             SELECT 1 FROM candidate_adjudications ca
                             WHERE ca.cluster_id=candidate_clusters.id
                         )
                       ORDER BY id""",
                    (run_id,),
                ).fetchall()
            ]
            self._release_or_stale_cluster_leases(connection, cluster_ids)
            connection.execute(
                """UPDATE runs SET status=?, finished_at=?, error=?
                   WHERE id=? AND stage='adjudicate'""",
                (status, utc_now(), error, run_id),
            )

    def source_texts_for_candidate_clusters(
        self, clusters: Sequence[Any]
    ) -> Dict[str, str]:
        block_ids = sorted(
            {
                candidate.block_id
                for cluster in clusters
                for candidate in cluster.alternatives
            }
        )
        if not block_ids:
            return {}
        placeholders = ",".join("?" for _ in block_ids)
        with closing(self.connect()) as connection:
            return {
                row["id"]: row["source_text"]
                for row in connection.execute(
                    f"SELECT id, source_text FROM blocks WHERE id IN ({placeholders})",
                    block_ids,
                ).fetchall()
            }

    @staticmethod
    def _adjudication_value(result: Any, field: str, default: Any = None) -> Any:
        if isinstance(result, dict):
            return result.get(field, default)
        return getattr(result, field, default)

    @staticmethod
    def _cluster_member_is_selected(
        member: sqlite3.Row, selected_ids: set[str]
    ) -> bool:
        return str(member["id"]) in selected_ids

    @staticmethod
    def _active_adjudication_matches(
        connection: sqlite3.Connection,
        adjudication_id: str,
        result: Dict[str, Any],
        members: Sequence[sqlite3.Row],
    ) -> bool:
        resolution_rows = connection.execute(
            """SELECT candidate_id, decision, lexeme_id, concept_id, evidence_id
               FROM candidate_resolutions WHERE adjudication_id=?""",
            (adjudication_id,),
        ).fetchall()
        member_ids = {str(row["id"]) for row in members}
        resolution_candidate_ids = [
            str(row["candidate_id"]) for row in resolution_rows
        ]
        if (
            len(resolution_rows) != len(members)
            or len(set(resolution_candidate_ids)) != len(resolution_candidate_ids)
            or set(resolution_candidate_ids) != member_ids
        ):
            return False
        resolutions = {
            str(row["candidate_id"]): row
            for row in resolution_rows
        }
        selected = set(result["selected_ids"])
        selected_evidence_ids = [
            resolutions[candidate_id]["evidence_id"] for candidate_id in selected
        ]
        if any(evidence_id is None for evidence_id in selected_evidence_ids) or len(
            set(selected_evidence_ids)
        ) != len(selected_evidence_ids):
            return False
        chain_rows_by_candidate: Dict[str, List[sqlite3.Row]] = {
            candidate_id: [] for candidate_id in selected
        }
        for row in connection.execute(
            """SELECT cr.candidate_id,
                      e.block_id AS evidence_block_id,
                      e.paragraph_id AS evidence_paragraph_id,
                      e.kind AS evidence_kind,
                      e.source_form AS evidence_source_form,
                      e.evidence_quote,
                      e.payload_json AS evidence_payload_json,
                      e.confidence AS evidence_confidence,
                      e.extractor AS evidence_extractor,
                      e.run_id AS evidence_run_id,
                      ca.run_id AS adjudication_run_id,
                      m.id AS mention_id,
                      m.block_id AS mention_block_id,
                      m.paragraph_id AS mention_paragraph_id,
                      m.source_form AS mention_source_form,
                      m.normalized_form AS mention_normalized_form,
                      m.discourse_function,
                      m.concept_id AS mention_concept_id,
                      cto.id AS observation_id,
                      cto.mention_id AS observation_mention_id,
                      cto.kind AS observation_kind,
                      cto.confidence AS observation_confidence,
                      cto.source AS observation_source,
                      cto.concept_id AS observation_concept_id,
                      cto.retired_version AS observation_retired_version
               FROM candidate_resolutions cr
               JOIN candidate_adjudications ca ON ca.id=cr.adjudication_id
               LEFT JOIN evidence e ON e.id=cr.evidence_id
               LEFT JOIN concept_type_observations cto
                 ON cto.adjudication_id=cr.adjudication_id
                    AND cto.lexeme_id=cr.lexeme_id
                    AND cto.evidence_id=cr.evidence_id
               LEFT JOIN mentions m
                 ON m.evidence_id=cr.evidence_id AND m.lexeme_id=cr.lexeme_id
               WHERE cr.adjudication_id=?""",
            (adjudication_id,),
        ).fetchall():
            candidate_id = str(row["candidate_id"])
            if candidate_id in chain_rows_by_candidate:
                chain_rows_by_candidate[candidate_id].append(row)
        active_observation_ids = {
            int(row["id"])
            for row in connection.execute(
                """SELECT id FROM concept_type_observations
                   WHERE adjudication_id=? AND source='candidate_adjudication'
                         AND retired_version IS NULL""",
                (adjudication_id,),
            ).fetchall()
        }
        consumed_mention_ids: set[int] = set()
        consumed_observation_ids: set[int] = set()
        for member in members:
            candidate_id = str(member["id"])
            resolution = resolutions[candidate_id]
            if V4Database._cluster_member_is_selected(member, selected):
                expected_lexeme_id = stable_id(
                    "lexeme",
                    f"en:{normalize_english_form(member['original_text'])}",
                )
                if (
                    resolution["decision"] != result["verdict"]
                    or resolution["lexeme_id"] != expected_lexeme_id
                    or resolution["concept_id"] is not None
                    or resolution["evidence_id"] is None
                    or member["resolution_status"] != "promoted"
                    or member["model_status"] != "accepted"
                    or not member["selected"]
                ):
                    return False
                chain_rows = chain_rows_by_candidate.get(str(candidate_id), [])
                if len(chain_rows) != 1:
                    return False
                chain = chain_rows[0]
                normalized_form = normalize_english_form(member["original_text"])
                if (
                    chain["evidence_block_id"] != member["block_id"]
                    or chain["evidence_paragraph_id"] != member["paragraph_id"]
                    or chain["evidence_kind"] != "candidate_adjudication"
                    or chain["evidence_source_form"] != member["original_text"]
                    or chain["evidence_quote"] != member["original_text"]
                    or chain["evidence_payload_json"] != result["payload_json"]
                    or chain["evidence_confidence"] != result["confidence"]
                    or chain["evidence_extractor"] != "candidate_adjudication"
                    or chain["evidence_run_id"] != chain["adjudication_run_id"]
                    or chain["mention_id"] is None
                    or chain["mention_block_id"] != member["block_id"]
                    or chain["mention_paragraph_id"] != member["paragraph_id"]
                    or chain["mention_source_form"] != member["original_text"]
                    or chain["mention_normalized_form"] != normalized_form
                    or chain["discourse_function"] != "referential"
                    or chain["mention_concept_id"] is not None
                    or chain["observation_id"] is None
                    or chain["observation_mention_id"] != chain["mention_id"]
                    or chain["observation_kind"] != result["entity_kind"]
                    or chain["observation_confidence"] != result["confidence"]
                    or chain["observation_source"] != "candidate_adjudication"
                    or chain["observation_concept_id"] is not None
                    or chain["observation_retired_version"] is not None
                ):
                    return False
                mention_id = int(chain["mention_id"])
                observation_id = int(chain["observation_id"])
                if (
                    mention_id in consumed_mention_ids
                    or observation_id in consumed_observation_ids
                ):
                    return False
                consumed_mention_ids.add(mention_id)
                consumed_observation_ids.add(observation_id)
                occurrence = connection.execute(
                    """SELECT 1 FROM form_occurrences
                       WHERE lexeme_id=? AND block_id=? AND start_offset=?
                             AND end_offset=? AND source_form=? AND source_hash=?""",
                    (
                        resolution["lexeme_id"],
                        member["block_id"],
                        member["start_offset"],
                        member["end_offset"],
                        member["original_text"],
                        member["block_source_hash"],
                    ),
                ).fetchone()
                if occurrence is None:
                    return False
            else:
                expected = (
                    "deferred"
                    if result["verdict"] == "defer"
                    else "superseded"
                    if result["verdict"] == "supersede"
                    else "rejected"
                )
                if (
                    resolution["decision"] != expected
                    or resolution["lexeme_id"] is not None
                    or resolution["concept_id"] is not None
                    or resolution["evidence_id"] is not None
                    or member["resolution_status"] != expected
                    or member["model_status"] != expected
                    or member["selected"]
                ):
                    return False
        return consumed_observation_ids == active_observation_ids

    def commit_adjudications(
        self,
        run_id: str,
        results: Sequence[Any],
        *,
        audit_attempts: Sequence[Any] = (),
        require_lease: bool = False,
        finalize_run_status: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Atomically persist adjudications as lexeme-owned span/type evidence."""
        ordered = sorted(
            results,
            key=lambda result: str(self._adjudication_value(result, "cluster_id", "")),
        )
        cluster_ids = [
            str(self._adjudication_value(result, "cluster_id", ""))
            for result in ordered
        ]
        if not all(cluster_ids) or len(set(cluster_ids)) != len(cluster_ids):
            raise ValueError("adjudication results require unique cluster ids")
        valid_verdicts = {"promote", "split", "supersede", "reject", "defer"}
        with self.transaction() as connection:
            if connection.execute("SELECT 1 FROM runs WHERE id=?", (run_id,)).fetchone() is None:
                raise ValueError(f"unknown run: {run_id}")
            cluster_members: Dict[str, List[sqlite3.Row]] = {}
            for cluster_id in cluster_ids:
                cluster_row = connection.execute(
                    """SELECT state, lease_run_id, lease_snapshot_hash
                       FROM candidate_clusters
                       WHERE id=?""",
                    (cluster_id,),
                ).fetchone()
                if cluster_row is None:
                    raise ValueError(f"unknown candidate cluster: {cluster_id}")
                if require_lease and (
                    cluster_row["state"] != "leased"
                    or cluster_row["lease_run_id"] != run_id
                ):
                    raise StaleAdjudicationCommit(
                        f"cluster lease is not owned by {run_id}: {cluster_id}"
                    )
                if require_lease:
                    current_snapshot_hash, source_current = (
                        self._candidate_cluster_lease_snapshot(
                            connection, cluster_id
                        )
                    )
                    if (
                        not cluster_row["lease_snapshot_hash"]
                        or cluster_row["lease_snapshot_hash"]
                        != current_snapshot_hash
                        or not source_current
                    ):
                        raise StaleAdjudicationLease(
                            f"candidate/source lease snapshot changed: {cluster_id}"
                        )
                rows = connection.execute(
                    """SELECT lc.*, cm.role AS member_role,
                              cm.context_json AS member_context_json,
                              b.source_hash AS block_source_hash
                       FROM candidate_cluster_members cm
                       JOIN lexical_candidates lc ON lc.id=cm.candidate_id
                       JOIN blocks b ON b.id=lc.block_id
                       WHERE cm.cluster_id=?
                         AND (
                             cm.role IN ('alternative', 'both')
                             OR json_extract(
                                 cm.context_json, '$.support_member'
                             )=1
                         )
                       ORDER BY cm.ordinal, lc.id""",
                    (cluster_id,),
                ).fetchall()
                if not rows:
                    raise ValueError(
                        f"candidate cluster has no persisted alternatives: {cluster_id}"
                    )
                cluster_members[cluster_id] = list(rows)

            for audit in audit_attempts:
                messages = self._adjudication_value(audit, "messages", ())
                parsed = self._adjudication_value(audit, "parsed")
                self.record_audit_call(
                    run_id=run_id,
                    block_id=None,
                    purpose="candidate_adjudication",
                    model=str(self._adjudication_value(audit, "model", "unknown")),
                    knowledge_version=int(
                        self._adjudication_value(audit, "knowledge_version", 0)
                    ),
                    request={
                        "messages": [dict(message) for message in messages],
                        "audit_mode": str(
                            self._adjudication_value(audit, "audit_mode", "full")
                        ),
                    },
                    raw_response=str(
                        self._adjudication_value(audit, "raw_response", "") or ""
                    ),
                    parsed=dict(parsed) if parsed is not None else None,
                    accepted=bool(
                        self._adjudication_value(audit, "accepted", False)
                    ),
                    attempts=max(
                        1, int(self._adjudication_value(audit, "attempt", 1))
                    ),
                    elapsed_ms=max(
                        0, int(self._adjudication_value(audit, "elapsed_ms", 0))
                    ),
                    error=self._adjudication_value(audit, "error"),
                    connection=connection,
                )

            normalized_results: List[Dict[str, Any]] = []
            for result, cluster_id in zip(ordered, cluster_ids):
                verdict = str(self._adjudication_value(result, "verdict", ""))
                reason = str(self._adjudication_value(result, "reason", "") or "")
                selected_ids = tuple(
                    str(value)
                    for value in self._adjudication_value(
                        result, "selected_candidate_ids", ()
                    )
                )
                if verdict not in valid_verdicts:
                    raise ValueError(f"invalid adjudication verdict: {verdict}")
                if len(set(selected_ids)) != len(selected_ids):
                    raise ValueError(f"duplicate selected candidate in cluster {cluster_id}")
                selected_id_set = set(selected_ids)
                representative_rows = [
                    row
                    for row in cluster_members[cluster_id]
                    if row["member_role"] in {"alternative", "both"}
                ]
                representative_ids = {row["id"] for row in representative_rows}
                missing = sorted(selected_id_set - representative_ids)
                if missing:
                    raise ValueError(
                        f"selected candidate(s) are not alternatives in cluster "
                        f"{cluster_id}: {', '.join(missing)}"
                    )
                selected_rows = [
                    row
                    for row in representative_rows
                    if row["id"] in selected_id_set
                ]
                if reason == "missing_span" and verdict != "defer":
                    raise ValueError("missing_span requires defer")
                if verdict == "promote" and len(selected_rows) != 1:
                    raise ValueError("promote requires exactly one candidate")
                if verdict in {"reject", "defer"} and selected_rows:
                    raise ValueError(f"{verdict} cannot select candidates")
                if verdict == "split":
                    if len(selected_rows) < 2:
                        raise ValueError("split requires at least two candidates")
                    if any(
                        left["block_id"] == right["block_id"]
                        and left["start_offset"] < right["end_offset"]
                        and right["start_offset"] < left["end_offset"]
                        for index, left in enumerate(selected_rows)
                        for right in selected_rows[index + 1 :]
                    ):
                        raise ValueError("split candidates overlap")
                if verdict == "supersede":
                    if len(selected_rows) != 1:
                        raise ValueError("supersede requires exactly one candidate")
                    selected_row = selected_rows[0]
                    if not any(
                        other["id"] not in selected_id_set
                        and selected_row["block_id"] == other["block_id"]
                        and selected_row["start_offset"] <= other["start_offset"]
                        and other["end_offset"] <= selected_row["end_offset"]
                        for other in representative_rows
                    ):
                        raise ValueError(
                            "supersede candidate does not contain an unselected alternative"
                        )
                normalized = {
                    "cluster_id": cluster_id,
                    "verdict": verdict,
                    "selected_ids": tuple(sorted(selected_ids)),
                    "entity_kind": str(
                        self._adjudication_value(result, "entity_kind", "") or "concept"
                    ),
                    "confidence": float(
                        self._adjudication_value(result, "confidence", 0.0)
                    ),
                    "reason": reason,
                    "rounds": max(
                        1, int(self._adjudication_value(result, "rounds", 1) or 1)
                    ),
                }
                payload = {
                    "cluster_id": cluster_id,
                    "verdict": verdict,
                    "selected_candidate_ids": list(normalized["selected_ids"]),
                    "entity_kind": normalized["entity_kind"],
                    "confidence": normalized["confidence"],
                    "reason": normalized["reason"],
                    "rounds": normalized["rounds"],
                }
                payload_json = json.dumps(
                    payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                normalized["payload"] = payload
                normalized["payload_json"] = payload_json
                normalized["payload_hash"] = hashlib.sha256(
                    payload_json.encode("utf-8")
                ).hexdigest()
                normalized["active"] = connection.execute(
                    """SELECT id, run_id, payload_hash, knowledge_version
                       FROM candidate_adjudications
                       WHERE cluster_id=? AND active=1""",
                    (cluster_id,),
                ).fetchone()
                if (
                    normalized["active"] is not None
                    and normalized["active"]["run_id"] != run_id
                ):
                    raise StaleAdjudicationCommit(
                        f"cluster already has an active adjudication: {cluster_id}"
                    )
                normalized["state_matches"] = bool(
                    normalized["active"]
                    and self._active_adjudication_matches(
                        connection,
                        normalized["active"]["id"],
                        normalized,
                        cluster_members[cluster_id],
                    )
                )
                normalized_results.append(normalized)

            changed_results = [
                result
                for result in normalized_results
                if result["active"] is None
                or result["active"]["payload_hash"] != result["payload_hash"]
                or not result["state_matches"]
            ]
            if not changed_results:
                version = (
                    max(int(result["active"]["knowledge_version"]) for result in normalized_results)
                    if normalized_results
                    else int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
                )
                self._complete_committed_clusters(
                    connection,
                    run_id,
                    cluster_ids,
                    finalize_run_status=finalize_run_status,
                )
                return {
                    "knowledge_version": version,
                    "adjudications": len(normalized_results),
                    "concept_ids": [],
                    "changed": 0,
                }

            version = self.create_knowledge_version(
                f"candidate adjudication {run_id}", connection
            )
            for result in changed_results:
                cluster_id = result["cluster_id"]
                now = utc_now()
                previous_concept_ids: List[str] = []
                if result["active"] is not None:
                    previous_concept_ids = [
                        row[0]
                        for row in connection.execute(
                            """SELECT DISTINCT concept_id FROM candidate_resolutions
                               WHERE adjudication_id=? AND concept_id IS NOT NULL""",
                            (result["active"]["id"],),
                        ).fetchall()
                    ]
                    connection.execute(
                        """UPDATE candidate_adjudications
                           SET active=0, superseded_at=?, updated_at=? WHERE id=?""",
                        (now, now, result["active"]["id"]),
                    )
                adjudication_id = stable_id(
                    "adjud",
                    f"{run_id}:{cluster_id}:{version}:{result['payload_hash']}",
                    length=24,
                )
                connection.execute(
                    """INSERT INTO candidate_adjudications(
                           id, run_id, cluster_id, verdict, payload_hash,
                           selected_candidate_ids_json, entity_kind, confidence,
                           reason, rounds, payload_json, knowledge_version,
                           active, created_at, updated_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                    (
                        adjudication_id,
                        run_id,
                        cluster_id,
                        result["verdict"],
                        result["payload_hash"],
                        json.dumps(result["selected_ids"], ensure_ascii=False),
                        result["entity_kind"],
                        result["confidence"],
                        result["reason"],
                        result["rounds"],
                        result["payload_json"],
                        version,
                        now,
                        now,
                    ),
                )

                selected = set(result["selected_ids"])
                member_rows = cluster_members[cluster_id]
                for ordinal, candidate in enumerate(member_rows):
                    candidate_id = candidate["id"]
                    candidate_lexeme_id: Optional[str] = None
                    evidence_id: Optional[int] = None
                    if self._cluster_member_is_selected(candidate, selected):
                        normalized_form = normalize_english_form(candidate["original_text"])
                        candidate_lexeme_id = self.ensure_lexeme(
                            candidate["original_text"],
                            connection=connection,
                        )
                        cursor = connection.execute(
                            """INSERT INTO evidence(
                                   block_id, paragraph_id, kind, source_form,
                                   evidence_quote, payload_json, confidence,
                                   extractor, run_id, created_at
                               ) VALUES(?, ?, 'candidate_adjudication', ?, ?, ?, ?,
                                        'candidate_adjudication', ?, ?)""",
                            (
                                candidate["block_id"],
                                candidate["paragraph_id"],
                                candidate["original_text"],
                                candidate["original_text"],
                                result["payload_json"],
                                result["confidence"],
                                run_id,
                                now,
                            ),
                        )
                        evidence_id = int(cursor.lastrowid)
                        mention_cursor = connection.execute(
                            """INSERT INTO mentions(
                                   block_id, paragraph_id, source_form,
                                   normalized_form, discourse_function,
                                   lexeme_id, concept_id, evidence_id
                               ) VALUES(?, ?, ?, ?, 'referential', ?, NULL, ?)""",
                            (
                                candidate["block_id"],
                                candidate["paragraph_id"],
                                candidate["original_text"],
                                normalized_form,
                                candidate_lexeme_id,
                                evidence_id,
                            ),
                        )
                        mention_id = int(mention_cursor.lastrowid)
                        self.record_form_occurrences(
                            [
                                FormOccurrence(
                                    lexeme_id=candidate_lexeme_id,
                                    block_id=str(candidate["block_id"]),
                                    start_offset=int(candidate["start_offset"]),
                                    end_offset=int(candidate["end_offset"]),
                                    source_form=str(candidate["original_text"]),
                                    source_hash=str(candidate["block_source_hash"]),
                                )
                            ],
                            connection=connection,
                        )
                        self.record_type_observation(
                            candidate_lexeme_id,
                            result["entity_kind"],
                            confidence=result["confidence"],
                            source="candidate_adjudication",
                            mention_id=mention_id,
                            evidence_id=evidence_id,
                            adjudication_id=adjudication_id,
                            connection=connection,
                        )
                        connection.execute(
                            """UPDATE lexical_candidates
                               SET resolution_status='promoted', model_status='accepted',
                                   selected=1, updated_at=?
                               WHERE id=?""",
                            (now, candidate_id),
                        )
                        member_decision = result["verdict"]
                    else:
                        if result["verdict"] == "defer":
                            status = "deferred"
                        elif result["verdict"] == "supersede":
                            status = "superseded"
                        else:
                            status = "rejected"
                        connection.execute(
                            """UPDATE lexical_candidates
                               SET resolution_status=?, model_status=?, selected=0,
                                   updated_at=? WHERE id=?""",
                            (status, status, now, candidate_id),
                        )
                        member_decision = status
                    resolution_id = stable_id(
                        "resolution",
                        f"{adjudication_id}:{ordinal}:{candidate_id}",
                        length=24,
                    )
                    connection.execute(
                        """INSERT INTO candidate_resolutions(
                               id, adjudication_id, run_id, cluster_id, candidate_id,
                               lexeme_id, concept_id, evidence_id, decision, ordinal,
                               payload_json, created_at
                            ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)""",
                        (
                            resolution_id,
                            adjudication_id,
                            run_id,
                            cluster_id,
                            candidate_id,
                            candidate_lexeme_id,
                            evidence_id,
                            member_decision,
                            ordinal,
                            result["payload_json"],
                            now,
                        ),
                    )
                for previous_concept_id in previous_concept_ids:
                    connection.execute(
                        """UPDATE concepts SET status='retired', retired_version=?
                           WHERE id=? AND locked=0 AND retired_version IS NULL
                             AND default_target='' AND working_target=''
                             AND verified_target=''
                             AND NOT EXISTS(
                                 SELECT 1 FROM candidate_resolutions cr
                                 JOIN candidate_adjudications ca
                                   ON ca.id=cr.adjudication_id
                                 WHERE cr.concept_id=concepts.id AND ca.active=1)
                             AND NOT EXISTS(
                                 SELECT 1 FROM mentions m JOIN evidence e
                                   ON e.id=m.evidence_id
                                 WHERE m.concept_id=concepts.id
                                   AND e.extractor!='candidate_adjudication')
                             AND NOT EXISTS(
                                 SELECT 1 FROM rendering_rules rr
                                 WHERE rr.concept_id=concepts.id
                                   AND rr.retired_version IS NULL)""",
                        (version, previous_concept_id),
                    )
            self._complete_committed_clusters(
                connection,
                run_id,
                cluster_ids,
                finalize_run_status=finalize_run_status,
            )
            return {
                "knowledge_version": version,
                "adjudications": len(changed_results),
                "concept_ids": [],
                "changed": len(changed_results),
            }

    @staticmethod
    def _complete_committed_clusters(
        connection: sqlite3.Connection,
        run_id: str,
        cluster_ids: Sequence[str],
        *,
        finalize_run_status: Optional[str],
    ) -> None:
        if cluster_ids:
            placeholders = ",".join("?" for _ in cluster_ids)
            connection.execute(
                f"""UPDATE candidate_clusters
                    SET state='adjudicated', lease_run_id=NULL,
                        lease_acquired_at=NULL, lease_snapshot_hash=NULL,
                        updated_at=?
                    WHERE id IN ({placeholders})""",
                [utc_now(), *cluster_ids],
            )
        if finalize_run_status is not None:
            if finalize_run_status not in {"completed", "completed_with_errors"}:
                raise ValueError(
                    f"invalid adjudication final status: {finalize_run_status}"
                )
            connection.execute(
                """UPDATE runs SET status=?, finished_at=?, error=NULL
                   WHERE id=? AND stage='adjudicate'""",
                (finalize_run_status, utc_now(), run_id),
            )

    @staticmethod
    def _scan_evidence_where(alias: str = "e") -> str:
        return (
            f"({alias}.extractor LIKE 'scan_%' "
            f"OR {alias}.extractor='candidate_adjudication')"
        )

    def _prepare_scan_reset_selection(self, connection: sqlite3.Connection) -> None:
        evidence_where = self._scan_evidence_where("e")
        statements = (
            """CREATE TEMP TABLE reset_scan_audit_runs AS
               SELECT id FROM runs
               WHERE stage IN (
                   'scan', 'candidate_adjudication', 'adjudicate', 'working_target'
               )""",
            """CREATE TEMP TABLE reset_scan_blocks AS
               SELECT b.id FROM blocks b
               WHERE (b.status!='pending' OR b.last_error IS NOT NULL)
                 AND NOT EXISTS(
                     SELECT 1 FROM translation_versions t WHERE t.block_id=b.id)""",
            """CREATE TEMP TABLE reset_protected_type_observations AS
               SELECT cto.id FROM concept_type_observations cto
               LEFT JOIN concepts c ON c.id=cto.concept_id
               WHERE cto.source!='candidate_adjudication'
                  OR COALESCE(c.locked, 0)=1""",
            """CREATE TEMP TABLE reset_protected_adjudications AS
               SELECT DISTINCT cto.adjudication_id AS id
               FROM concept_type_observations cto
               WHERE cto.id IN (
                         SELECT id FROM reset_protected_type_observations)
                 AND cto.adjudication_id IS NOT NULL""",
            """CREATE TEMP TABLE reset_protected_clusters AS
               SELECT DISTINCT ca.cluster_id AS id
               FROM candidate_adjudications ca
               WHERE ca.id IN (SELECT id FROM reset_protected_adjudications)""",
            """CREATE TEMP TABLE reset_protected_candidates AS
               SELECT cm.candidate_id AS id
               FROM candidate_cluster_members cm
               WHERE cm.cluster_id IN (SELECT id FROM reset_protected_clusters)
               UNION
               SELECT cr.candidate_id AS id FROM candidate_resolutions cr
               WHERE cr.adjudication_id IN (
                         SELECT id FROM reset_protected_adjudications)
                 AND cr.candidate_id IS NOT NULL""",
            """CREATE TEMP TABLE reset_scan_candidate_adjudications AS
               SELECT id FROM candidate_adjudications
               WHERE id NOT IN (SELECT id FROM reset_protected_adjudications)""",
            """CREATE TEMP TABLE reset_scan_candidate_resolutions AS
               SELECT id FROM candidate_resolutions
               WHERE adjudication_id IN (
                   SELECT id FROM reset_scan_candidate_adjudications)""",
            """CREATE TEMP TABLE reset_scan_candidate_clusters AS
               SELECT id FROM candidate_clusters
               WHERE id NOT IN (SELECT id FROM reset_protected_clusters)""",
            """CREATE TEMP TABLE reset_scan_candidate_cluster_members AS
               SELECT cluster_id, candidate_id FROM candidate_cluster_members
               WHERE cluster_id IN (SELECT id FROM reset_scan_candidate_clusters)""",
            """CREATE TEMP TABLE reset_scan_lexical_candidates AS
               SELECT id FROM lexical_candidates
               WHERE id NOT IN (SELECT id FROM reset_protected_candidates)""",
            """CREATE TEMP TABLE reset_protected_mentions AS
               SELECT DISTINCT m.id FROM mentions m
               JOIN usage_decisions ud ON ud.mention_id=m.id
               WHERE ud.locked=1 OR ud.status='verified'
               UNION
               SELECT cto.mention_id FROM concept_type_observations cto
               WHERE cto.id IN (
                         SELECT id FROM reset_protected_type_observations)
                 AND cto.mention_id IS NOT NULL""",
            """CREATE TEMP TABLE reset_protected_evidence AS
               SELECT ce.evidence_id FROM claim_evidence ce
               JOIN claims c ON c.id=ce.claim_id
               WHERE c.locked=1
               UNION
               SELECT m.evidence_id FROM mentions m
               WHERE m.id IN (SELECT id FROM reset_protected_mentions)
               UNION
               SELECT cto.evidence_id FROM concept_type_observations cto
               WHERE cto.id IN (
                         SELECT id FROM reset_protected_type_observations)
                 AND cto.evidence_id IS NOT NULL
               UNION
               SELECT cr.evidence_id FROM candidate_resolutions cr
               WHERE cr.adjudication_id IN (
                         SELECT id FROM reset_protected_adjudications)
                 AND cr.evidence_id IS NOT NULL""",
            f"""CREATE TEMP TABLE reset_protected_concepts AS
                 SELECT id FROM concepts WHERE locked=1
                 UNION SELECT m.concept_id FROM mentions m
                       WHERE m.id IN (SELECT id FROM reset_protected_mentions)
                         AND m.concept_id IS NOT NULL
                 UNION SELECT cto.concept_id FROM concept_type_observations cto
                       WHERE cto.id IN (
                                 SELECT id FROM reset_protected_type_observations)
                         AND cto.concept_id IS NOT NULL
                 UNION SELECT DISTINCT m.concept_id FROM mentions m
                       JOIN evidence e ON e.id=m.evidence_id
                       WHERE m.concept_id IS NOT NULL AND NOT {evidence_where}
                 UNION SELECT concept_id FROM rendering_rules
                       WHERE locked=1 OR status='verified'""",
            f"""CREATE TEMP TABLE reset_scan_evidence AS
                 SELECT e.id FROM evidence e WHERE {evidence_where}
                   AND e.id NOT IN (SELECT evidence_id FROM reset_protected_evidence)
                   AND NOT EXISTS(
                       SELECT 1 FROM mentions m
                       WHERE m.evidence_id=e.id
                         AND m.id IN (SELECT id FROM reset_protected_mentions))""",
            """CREATE TEMP TABLE reset_scan_mentions AS
               SELECT m.id FROM mentions m
               WHERE m.evidence_id IN (SELECT id FROM reset_scan_evidence)
                 AND m.id NOT IN (SELECT id FROM reset_protected_mentions)""",
            """CREATE TEMP TABLE reset_scan_claims AS
               SELECT DISTINCT c.id FROM claims c
               JOIN claim_evidence ce ON ce.claim_id=c.id
               WHERE c.locked=0
                 AND ce.evidence_id IN (SELECT id FROM reset_scan_evidence)""",
            """CREATE TEMP TABLE reset_scan_concepts AS
               SELECT DISTINCT c.id FROM concepts c
               WHERE c.locked=0
                 AND c.id NOT IN (SELECT id FROM reset_protected_concepts)
                  AND (EXISTS(SELECT 1 FROM candidate_resolutions cr
                              WHERE cr.concept_id=c.id
                                AND cr.id IN (
                                    SELECT id FROM reset_scan_candidate_resolutions))
                      OR EXISTS(SELECT 1 FROM mentions m JOIN evidence e
                                ON e.id=m.evidence_id
                                WHERE m.concept_id=c.id
                                  AND (e.extractor LIKE 'scan_%'
                                        OR e.extractor='candidate_adjudication')))""",
            """CREATE TEMP TABLE reset_scan_type_observations AS
               SELECT cto.id FROM concept_type_observations cto
               LEFT JOIN concepts c ON c.id=cto.concept_id
               WHERE cto.source='candidate_adjudication'
                 AND COALESCE(c.locked, 0)=0
                 AND cto.id NOT IN (
                     SELECT id FROM reset_protected_type_observations)""",
            """CREATE TEMP TABLE reset_scan_lexemes AS
               SELECT DISTINCT l.id FROM lexemes l
               WHERE (
                   EXISTS(SELECT 1 FROM candidate_resolutions cr
                          WHERE cr.lexeme_id=l.id
                            AND cr.id IN (
                                SELECT id FROM reset_scan_candidate_resolutions))
                   OR EXISTS(SELECT 1 FROM mentions m
                             WHERE m.lexeme_id=l.id
                               AND m.id IN (SELECT id FROM reset_scan_mentions))
                   OR EXISTS(SELECT 1 FROM concept_type_observations cto
                             WHERE cto.lexeme_id=l.id
                               AND cto.id IN (
                                   SELECT id FROM reset_scan_type_observations)))
                 AND NOT EXISTS(
                     SELECT 1 FROM concepts c
                     WHERE c.primary_lexeme_id=l.id
                       AND c.id NOT IN (SELECT id FROM reset_scan_concepts))
                 AND NOT EXISTS(
                     SELECT 1 FROM concept_lexemes cl
                     WHERE cl.lexeme_id=l.id
                       AND cl.concept_id NOT IN (SELECT id FROM reset_scan_concepts))
                 AND NOT EXISTS(
                     SELECT 1 FROM mentions m
                     WHERE m.lexeme_id=l.id
                       AND m.id NOT IN (SELECT id FROM reset_scan_mentions))
                 AND NOT EXISTS(
                     SELECT 1 FROM form_occurrences fo
                     WHERE fo.lexeme_id=l.id)
                 AND NOT EXISTS(
                     SELECT 1 FROM concept_type_observations cto
                     WHERE cto.lexeme_id=l.id
                       AND cto.id NOT IN (
                           SELECT id FROM reset_scan_type_observations))""",
            """CREATE TEMP TABLE reset_scan_usage_decisions AS
               SELECT ud.id FROM usage_decisions ud
               WHERE ud.mention_id IN (SELECT id FROM reset_scan_mentions)
                 AND ud.locked=0 AND ud.status!='verified'""",
            """CREATE TEMP TABLE reset_scan_claim_evidence AS
               SELECT ce.claim_id, ce.evidence_id FROM claim_evidence ce
               WHERE ce.evidence_id IN (SELECT id FROM reset_scan_evidence)
                  OR ce.claim_id IN (SELECT id FROM reset_scan_claims)
               EXCEPT
               SELECT ce.claim_id, ce.evidence_id FROM claim_evidence ce
               JOIN claims c ON c.id=ce.claim_id WHERE c.locked=1""",
            """CREATE TEMP TABLE reset_scan_source_forms AS
               SELECT sf.id FROM source_forms sf
               WHERE sf.lexeme_id IN (SELECT id FROM reset_scan_lexemes)
                  OR (EXISTS(
                   SELECT 1 FROM concept_lexemes cl
                   WHERE cl.lexeme_id=sf.lexeme_id
                     AND cl.concept_id IN (SELECT id FROM reset_scan_concepts))
                 AND NOT EXISTS(
                   SELECT 1 FROM concept_lexemes cl
                   WHERE cl.lexeme_id=sf.lexeme_id
                     AND cl.concept_id NOT IN (SELECT id FROM reset_scan_concepts)
                     AND cl.retired_version IS NULL))""",
            """CREATE TEMP TABLE reset_scan_rendering_rules AS
               SELECT id FROM rendering_rules
               WHERE concept_id IN (SELECT id FROM reset_scan_concepts)""",
            """CREATE TEMP TABLE reset_scan_verification_tasks AS
               SELECT id FROM verification_tasks
               WHERE (subject_type='claim'
                      AND subject_id IN (SELECT id FROM reset_scan_claims))
                  OR (subject_type='concept'
                      AND subject_id IN (SELECT id FROM reset_scan_concepts))""",
            """CREATE TEMP TABLE reset_scan_verification_votes AS
               SELECT id FROM verification_votes
               WHERE task_id IN (SELECT id FROM reset_scan_verification_tasks)""",
        )
        for statement in statements:
            connection.execute(statement)
        connection.execute(
            "CREATE TEMP TABLE reset_scan_audit_calls(id INTEGER PRIMARY KEY)"
        )
        rows = connection.execute(
            """SELECT id, purpose, model, request_json, parsed_json
               FROM audit_calls
               WHERE run_id IN (SELECT id FROM reset_scan_audit_runs)
               ORDER BY id"""
        ).fetchall()
        connection.executemany(
            "INSERT INTO reset_scan_audit_calls(id) VALUES(?)",
            [
                (int(row["id"]),)
                for row in rows
                if not self._audit_row_is_human(row)
            ],
        )
        connection.execute(
            """CREATE TEMP TABLE reset_scan_runs AS
               SELECT r.id FROM runs r
               WHERE r.id IN (SELECT id FROM reset_scan_audit_runs)
                 AND NOT EXISTS(
                     SELECT 1 FROM audit_calls a
                     WHERE a.run_id=r.id
                       AND a.id NOT IN (SELECT id FROM reset_scan_audit_calls))
                 AND NOT EXISTS(
                     SELECT 1 FROM evidence e
                     WHERE e.run_id=r.id
                       AND e.id NOT IN (SELECT id FROM reset_scan_evidence))
                 AND NOT EXISTS(
                     SELECT 1 FROM translation_versions t WHERE t.run_id=r.id)"""
        )

    @staticmethod
    def _scan_reset_queries() -> Dict[str, str]:
        return {
            "audit_calls": """SELECT id,run_id,purpose,model,request_json,
                                      raw_response,parsed_json,accepted,attempts,
                                      elapsed_ms,error,archive_relative_path,
                                      archive_offset,archive_compressed_length,
                                      archive_sha256,created_at
                               FROM audit_calls
                               WHERE id IN (SELECT id FROM reset_scan_audit_calls)
                               ORDER BY id""",
            "runs": "SELECT id,stage,status,started_at,finished_at FROM runs WHERE id IN (SELECT id FROM reset_scan_runs) ORDER BY id",
            "blocks_reset": "SELECT id,status,last_error,updated_at FROM blocks WHERE id IN (SELECT id FROM reset_scan_blocks) ORDER BY id",
            "lexical_candidates": "SELECT id,updated_at,resolution_status,selected FROM lexical_candidates WHERE id IN (SELECT id FROM reset_scan_lexical_candidates) ORDER BY id",
            "candidate_clusters": "SELECT id,run_id,updated_at FROM candidate_clusters WHERE id IN (SELECT id FROM reset_scan_candidate_clusters) ORDER BY id",
            "candidate_cluster_members": """SELECT cluster_id,candidate_id,role
                FROM candidate_cluster_members m WHERE EXISTS(
                    SELECT 1 FROM reset_scan_candidate_cluster_members r
                    WHERE r.cluster_id=m.cluster_id AND r.candidate_id=m.candidate_id)
                ORDER BY cluster_id,candidate_id""",
            "candidate_adjudications": "SELECT id,active,payload_hash,updated_at FROM candidate_adjudications WHERE id IN (SELECT id FROM reset_scan_candidate_adjudications) ORDER BY id",
            "candidate_resolutions": "SELECT id,adjudication_id,decision FROM candidate_resolutions WHERE id IN (SELECT id FROM reset_scan_candidate_resolutions) ORDER BY id",
            "concept_type_observations": "SELECT id,lexeme_id,mention_id,evidence_id,adjudication_id FROM concept_type_observations WHERE id IN (SELECT id FROM reset_scan_type_observations) ORDER BY id",
            "usage_decisions": "SELECT id,mention_id,status,locked,created_at FROM usage_decisions WHERE id IN (SELECT id FROM reset_scan_usage_decisions) ORDER BY id",
            "mentions": "SELECT id,evidence_id,concept_id FROM mentions WHERE id IN (SELECT id FROM reset_scan_mentions) ORDER BY id",
            "evidence": "SELECT id,extractor,created_at FROM evidence WHERE id IN (SELECT id FROM reset_scan_evidence) ORDER BY id",
            "claim_evidence": "SELECT claim_id,evidence_id FROM reset_scan_claim_evidence ORDER BY claim_id,evidence_id",
            "claims": "SELECT id,status,created_at FROM claims WHERE id IN (SELECT id FROM reset_scan_claims) ORDER BY id",
            "source_forms": "SELECT id,lexeme_id,normalized_form FROM source_forms WHERE id IN (SELECT id FROM reset_scan_source_forms) ORDER BY id",
            "lexemes": "SELECT id,normalized_form,created_version FROM lexemes WHERE id IN (SELECT id FROM reset_scan_lexemes) ORDER BY id",
            "rendering_rules": "SELECT id,concept_id,status,locked FROM rendering_rules WHERE id IN (SELECT id FROM reset_scan_rendering_rules) ORDER BY id",
            "verification_votes": "SELECT id,task_id,verdict FROM verification_votes WHERE id IN (SELECT id FROM reset_scan_verification_votes) ORDER BY id",
            "verification_tasks": "SELECT id,subject_type,subject_id,status FROM verification_tasks WHERE id IN (SELECT id FROM reset_scan_verification_tasks) ORDER BY id",
            "concepts": "SELECT id,status,retired_version FROM concepts WHERE id IN (SELECT id FROM reset_scan_concepts) ORDER BY id",
        }

    def _scan_reset_preview(
        self, connection: sqlite3.Connection
    ) -> Dict[str, Any]:
        self._prepare_scan_reset_selection(connection)
        queries = self._scan_reset_queries()
        preview: Dict[str, Any] = {}
        row_digests: Dict[str, str] = {}
        for table, query in queries.items():
            row_hasher = hashlib.sha256()
            count = 0
            for row in connection.execute(query):
                count += 1
                row_hasher.update(
                    json.dumps(list(row), ensure_ascii=False, separators=(",", ":")).encode(
                        "utf-8"
                    )
                )
            preview[table] = count
            row_digests[table] = row_hasher.hexdigest()
        retained_queries = {
            "preserved_source_editions": "SELECT COUNT(*) FROM source_editions",
            "preserved_blocks": "SELECT COUNT(*) FROM blocks",
            "preserved_source_paragraphs": "SELECT COUNT(*) FROM source_paragraphs",
            "preserved_baseline_documents": "SELECT COUNT(*) FROM baseline_documents",
            "preserved_baseline_paragraphs": "SELECT COUNT(*) FROM baseline_paragraphs",
            "preserved_block_baseline_links": "SELECT COUNT(*) FROM block_baseline_links",
            "preserved_locked_concepts": """SELECT COUNT(*) FROM concepts
                WHERE locked=1 AND retired_version IS NULL""",
            "preserved_locked_usage_decisions": """SELECT COUNT(*) FROM usage_decisions
                WHERE locked=1 OR status='verified'""",
        }
        preview.update(
            {
                key: int(connection.execute(query).fetchone()[0])
                for key, query in retained_queries.items()
            }
        )
        hasher = hashlib.sha256()
        hasher.update(
            json.dumps(preview, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        for table, digest in row_digests.items():
            hasher.update(table.encode("utf-8"))
            hasher.update(digest.encode("ascii"))
        preview["token"] = hasher.hexdigest()
        return preview

    def preview_scan_reset(self) -> Dict[str, Any]:
        """Return a snapshot-bound destructive-reset preview and confirmation token."""
        with closing(self.connect()) as connection:
            connection.execute("BEGIN")
            try:
                preview = self._scan_reset_preview(connection)
                connection.commit()
                return preview
            except Exception:
                connection.rollback()
                raise

    def reset_scan_derivatives(self, expected_token: str) -> Dict[str, int]:
        """Clear model-derived scan state only when the preview snapshot still matches."""
        if not expected_token:
            raise ValueError("scan reset requires a non-empty preview token")
        with self.transaction() as connection:
            preview = self._scan_reset_preview(connection)
            if preview["token"] != expected_token:
                raise ValueError(
                    "scan reset token mismatch; request a fresh preview before retrying"
                )
            deleted: Dict[str, int] = {}
            connection.execute(
                "DELETE FROM audit_calls WHERE id IN (SELECT id FROM reset_scan_audit_calls)"
            )
            deletion_statements = (
                ("verification_votes", "DELETE FROM verification_votes WHERE id IN (SELECT id FROM reset_scan_verification_votes)"),
                ("verification_tasks", "DELETE FROM verification_tasks WHERE id IN (SELECT id FROM reset_scan_verification_tasks)"),
                ("concept_type_observations", "DELETE FROM concept_type_observations WHERE id IN (SELECT id FROM reset_scan_type_observations)"),
                ("candidate_resolutions", "DELETE FROM candidate_resolutions WHERE id IN (SELECT id FROM reset_scan_candidate_resolutions)"),
                ("candidate_adjudications", "DELETE FROM candidate_adjudications WHERE id IN (SELECT id FROM reset_scan_candidate_adjudications)"),
                ("candidate_cluster_members", """DELETE FROM candidate_cluster_members AS m WHERE EXISTS(
                    SELECT 1 FROM reset_scan_candidate_cluster_members r
                    WHERE r.cluster_id=m.cluster_id AND r.candidate_id=m.candidate_id)"""),
                ("candidate_clusters", "DELETE FROM candidate_clusters WHERE id IN (SELECT id FROM reset_scan_candidate_clusters)"),
                ("usage_decisions", "DELETE FROM usage_decisions WHERE id IN (SELECT id FROM reset_scan_usage_decisions)"),
                ("mentions", "DELETE FROM mentions WHERE id IN (SELECT id FROM reset_scan_mentions)"),
                ("claim_evidence", """DELETE FROM claim_evidence WHERE EXISTS(
                    SELECT 1 FROM reset_scan_claim_evidence r
                    WHERE r.claim_id=claim_evidence.claim_id
                      AND r.evidence_id=claim_evidence.evidence_id)"""),
                ("claims", "DELETE FROM claims WHERE id IN (SELECT id FROM reset_scan_claims)"),
                ("rendering_rules", "DELETE FROM rendering_rules WHERE id IN (SELECT id FROM reset_scan_rendering_rules)"),
                ("source_forms", "DELETE FROM source_forms WHERE id IN (SELECT id FROM reset_scan_source_forms)"),
            )
            for key, statement in deletion_statements:
                deleted[key] = connection.execute(statement).rowcount
            connection.execute(
                """UPDATE mentions SET concept_id=NULL
                   WHERE concept_id IN (SELECT id FROM reset_scan_concepts)"""
            )
            connection.execute(
                """DELETE FROM concept_lexemes
                   WHERE concept_id IN (SELECT id FROM reset_scan_concepts)"""
            )
            deleted["concepts"] = connection.execute(
                "DELETE FROM concepts WHERE id IN (SELECT id FROM reset_scan_concepts)"
            ).rowcount
            deleted["evidence"] = connection.execute(
                "DELETE FROM evidence WHERE id IN (SELECT id FROM reset_scan_evidence)"
            ).rowcount
            deleted["lexemes"] = connection.execute(
                "DELETE FROM lexemes WHERE id IN (SELECT id FROM reset_scan_lexemes)"
            ).rowcount
            deleted["lexical_candidates"] = connection.execute(
                "DELETE FROM lexical_candidates WHERE id IN (SELECT id FROM reset_scan_lexical_candidates)"
            ).rowcount
            deleted["blocks_reset"] = connection.execute(
                """UPDATE blocks SET status=?, last_error=NULL, updated_at=?
                   WHERE id IN (SELECT id FROM reset_scan_blocks)""",
                (
                    V4BlockStatus.PENDING.value,
                    utc_now(),
                ),
            ).rowcount
            connection.execute(
                """DELETE FROM runs
                   WHERE id IN (SELECT id FROM reset_scan_runs)
                     AND NOT EXISTS(SELECT 1 FROM audit_calls a WHERE a.run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM lexical_candidates l WHERE l.run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM candidate_clusters c
                                    WHERE c.run_id=runs.id OR c.lease_run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM candidate_cluster_members m
                                    WHERE m.run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM candidate_adjudications a
                                    WHERE a.run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM candidate_resolutions r
                                    WHERE r.run_id=runs.id)
                     AND NOT EXISTS(SELECT 1 FROM translation_versions t
                                    WHERE t.run_id=runs.id)"""
            )
            return deleted

    def source_block_count(self) -> int:
        with closing(self.connect()) as connection:
            return int(connection.execute("SELECT COUNT(*) FROM blocks").fetchone()[0])

    def locked_concept_count(self) -> int:
        with closing(self.connect()) as connection:
            return int(
                connection.execute(
                    "SELECT COUNT(*) FROM concepts WHERE locked=1 AND retired_version IS NULL"
                ).fetchone()[0]
            )

    def reconcile_exact_forms(self, reason: str = "reconcile exact English forms") -> int:
        """Conservative reconciliation: never infer aliases or identities."""
        with self.transaction() as connection:
            rows = connection.execute(
                """SELECT m.id mention_id, m.source_form, m.normalized_form,
                          m.discourse_function, m.lexeme_id,
                          e.payload_json, e.confidence
                   FROM mentions m JOIN evidence e ON e.id=m.evidence_id
                   WHERE m.concept_id IS NULL
                   ORDER BY m.normalized_form, m.id"""
            ).fetchall()
            version = (
                self.create_knowledge_version(reason, connection)
                if rows
                else int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            )
            for row in rows:
                payload = json.loads(row["payload_json"])
                concept_id = stable_id("concept", row["normalized_form"])
                connection.execute(
                    """INSERT OR IGNORE INTO concepts(
                           id, kind, canonical_source, default_target, description,
                           status, scope, locked, created_version, created_at
                       ) VALUES(?, ?, ?, ?, ?, 'provisional', 'book', 0, ?, ?)""",
                    (
                        concept_id, payload.get("category", "concept"),
                        payload.get("canonical_form") or row["source_form"],
                        "", payload.get("description", ""),
                        version, utc_now(),
                    ),
                )
                lexeme_id = str(row["lexeme_id"])
                self._associate_schema8_lexeme(
                    connection,
                    lexeme_id,
                    concept_id,
                    knowledge_version=version,
                )
                connection.execute(
                    """INSERT OR IGNORE INTO source_forms(
                           lexeme_id, form, normalized_form, grammar_json
                       ) VALUES(?, ?, ?, '{}')""",
                    (
                        lexeme_id,
                        row["source_form"],
                        normalize_english_form(row["source_form"]),
                    ),
                )
                connection.execute(
                    "UPDATE mentions SET concept_id=? WHERE id=?",
                    (concept_id, row["mention_id"]),
                )
            connection.execute(
                "UPDATE blocks SET status=?, updated_at=? WHERE status=?",
                (V4BlockStatus.READY.value, utc_now(), V4BlockStatus.SCANNED.value),
            )
            concept_rows = connection.execute(
                """SELECT c.id, c.canonical_source, c.default_target, c.locked,
                          COUNT(DISTINCT m.block_id) affected_blocks,
                          COUNT(DISTINCT CASE
                              WHEN json_extract(e.payload_json, '$.suggested_target') != ''
                              THEN json_extract(e.payload_json, '$.suggested_target') END
                          ) target_count
                   FROM concepts c
                   JOIN mentions m ON m.concept_id=c.id
                   JOIN evidence e ON e.id=m.evidence_id
                   WHERE c.retired_version IS NULL
                   GROUP BY c.id"""
            ).fetchall()
            for concept in concept_rows:
                target_votes = connection.execute(
                    """SELECT json_extract(e.payload_json, '$.suggested_target') target,
                              COUNT(DISTINCT m.block_id) block_count
                       FROM mentions m JOIN evidence e ON e.id=m.evidence_id
                       WHERE m.concept_id=?
                         AND COALESCE(json_extract(e.payload_json, '$.suggested_target'), '')!=''
                       GROUP BY target ORDER BY block_count DESC, target""",
                    (concept["id"],),
                ).fetchall()
                current_target = str(concept["default_target"] or "")
                high_impact = (
                    int(concept["affected_blocks"]) >= 3
                    or int(concept["target_count"]) > 1
                    or bool(concept["locked"])
                )
                if not high_impact or not target_votes:
                    continue
                evidence_rows = connection.execute(
                    """SELECT e.evidence_quote, e.payload_json, b.legacy_id
                       FROM mentions m
                       JOIN evidence e ON e.id=m.evidence_id
                       JOIN blocks b ON b.id=m.block_id
                       WHERE m.concept_id=? ORDER BY b.global_index, e.id LIMIT 20""",
                    (concept["id"],),
                ).fetchall()
                payload = {
                    "source": concept["canonical_source"],
                    "target": current_target,
                    "target_candidates": [
                        {
                            "target": row["target"],
                            "block_count": int(row["block_count"]),
                        }
                        for row in target_votes
                    ],
                    "affected_blocks": int(concept["affected_blocks"]),
                    "target_conflict": int(concept["target_count"]) > 1,
                    "evidence": [dict(row) for row in evidence_rows],
                }
                task_id = stable_id(
                    "verify",
                    f"concept:{concept['id']}:{json.dumps(payload, sort_keys=True)}",
                    length=24,
                )
                connection.execute(
                    """INSERT OR IGNORE INTO verification_tasks(
                           id, subject_type, subject_id, payload_json, status,
                           required_votes, created_at
                       ) VALUES(?, 'concept', ?, ?, 'open', 2, ?)""",
                    (
                        task_id,
                        concept["id"],
                        json.dumps(payload, ensure_ascii=False, sort_keys=True),
                        utc_now(),
                    ),
                )
            return version

    def import_legacy_concept(
        self,
        source: str,
        target: str,
        kind: str,
        description: str,
        status: str = "legacy_provisional",
        return_change_ids: bool = False,
    ) -> str | Dict[str, Any]:
        normalized = normalize_english_form(source)
        concept_id = stable_id("concept", normalized)
        with self.transaction() as connection:
            lexeme_id = stable_id("lexeme", f"en:{normalized}")
            rule_id = (
                stable_id("rule", f"{concept_id}:default:{target}")
                if target
                else ""
            )
            concept_exists = connection.execute(
                """SELECT 1 FROM concepts
                   WHERE id=? AND retired_version IS NULL""",
                (concept_id,),
            ).fetchone() is not None
            lexeme_exists = connection.execute(
                """SELECT 1 FROM lexemes
                   WHERE id=? AND retired_version IS NULL""",
                (lexeme_id,),
            ).fetchone() is not None
            form_exists = connection.execute(
                """SELECT 1 FROM source_forms
                   WHERE lexeme_id=? AND form=? AND normalized_form=?""",
                (lexeme_id, source, normalized),
            ).fetchone() is not None
            link_exists = connection.execute(
                """SELECT 1 FROM concept_lexemes
                   WHERE concept_id=? AND lexeme_id=?
                     AND retired_version IS NULL""",
                (concept_id, lexeme_id),
            ).fetchone() is not None
            rule_exists = not target or connection.execute(
                """SELECT 1 FROM rendering_rules
                   WHERE id=? AND concept_id=? AND condition_json='{}'
                     AND target=? AND priority=0 AND status=?
                     AND scope='book' AND locked=0
                     AND retired_version IS NULL""",
                (rule_id, concept_id, target, status),
            ).fetchone() is not None
            if all(
                (
                    concept_exists,
                    lexeme_exists,
                    form_exists,
                    link_exists,
                    rule_exists,
                )
            ):
                return (
                    {"concept_id": concept_id, "change_ids": []}
                    if return_change_ids
                    else concept_id
                )
            old_state = self._render_state_for_subject(
                connection, "concept", concept_id
            )
            version = self.create_knowledge_version(
                f"import legacy concept: {source}", connection
            )
            now = utc_now()
            connection.execute(
                """INSERT OR IGNORE INTO concepts(
                       id, kind, canonical_source, default_target, description,
                       status, scope, locked, created_version, created_at
                   ) VALUES(?, ?, ?, ?, ?, ?, 'book', 0, ?, ?)""",
                (
                    concept_id,
                    kind,
                    source,
                    target,
                    description,
                    status,
                    version,
                    now,
                ),
            )
            lexeme_id = self._ensure_schema8_lexeme(
                connection,
                source,
                normalized_form=normalized,
                concept_id=concept_id,
                knowledge_version=version,
                created_at=now,
            )
            connection.execute(
                """INSERT OR IGNORE INTO source_forms(
                       lexeme_id, form, normalized_form, grammar_json
                   ) VALUES(?, ?, ?, '{}')""",
                (lexeme_id, source, normalized),
            )
            if target:
                connection.execute(
                    """INSERT OR IGNORE INTO rendering_rules(
                           id, concept_id, condition_json, target, priority, status,
                           scope, locked, created_version, created_at
                       ) VALUES(?, ?, '{}', ?, 0, ?, 'book', 0, ?, ?)""",
                    (rule_id, concept_id, target, status, version, now),
                )
            new_state = self._render_state_for_subject(
                connection, "concept", concept_id
            )
            change = self.record_render_change(
                connection,
                subject_type="concept",
                subject_id=concept_id,
                old_state=old_state,
                new_state=new_state,
                change_kind="rendering_rule" if target else "concept_import",
                reason=f"import legacy concept: {source}",
                knowledge_version=version,
            )
            change_ids = (
                [int(change["change_id"])]
                if change["change_id"] is not None
                else []
            )
            self.record_audit_call(
                run_id=None,
                block_id=None,
                purpose="legacy_concept_import",
                model="none",
                knowledge_version=version,
                request={
                    "source": source,
                    "target": target,
                    "kind": kind,
                    "status": status,
                },
                raw_response="",
                parsed={"concept_id": concept_id, "lexeme_id": lexeme_id},
                accepted=True,
                attempts=1,
                elapsed_ms=0,
                error=None,
                connection=connection,
                archive_payload=False,
            )
        if return_change_ids:
            return {"concept_id": concept_id, "change_ids": change_ids}
        return concept_id

    def lock_concept_translation(
        self,
        source: str,
        target: str,
        kind: str = "concept",
        description: str = "",
    ) -> Dict[str, Any]:
        """人工确认一个全书级译名，并使依赖旧译名的V4译文失效。"""
        source = source.strip()
        target = target.strip()
        if not source or not target:
            raise ValueError("人工锁定术语时source和target均不能为空")
        normalized = normalize_english_form(source)
        concept_id = stable_id("concept", normalized)
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM concepts WHERE id=? AND retired_version IS NULL",
                (concept_id,),
            ).fetchone()
            old_state = self._render_state_for_subject(
                connection, "concept", concept_id
            )
            rule_id = stable_id("rule", f"{concept_id}:human-default:{target}")
            exact_rule = connection.execute(
                """SELECT 1 FROM rendering_rules
                   WHERE id=? AND concept_id=? AND condition_json='{}'
                     AND target=? AND priority=100 AND status='verified'
                     AND scope='book' AND locked=1
                     AND retired_version IS NULL""",
                (rule_id, concept_id, target),
            ).fetchone() is not None
            exact_description = (
                not description
                or str(old_state.get("description") or "") == description
            )
            if (
                existing is not None
                and bool(old_state.get("locked"))
                and str(old_state.get("default_target") or "") == target
                and str(old_state.get("working_target") or "") == target
                and str(old_state.get("verified_target") or "") == target
                and exact_rule
                and source in old_state.get("forms", [])
                and exact_description
            ):
                return {
                    "concept_id": concept_id,
                    "source": source,
                    "target": target,
                    "knowledge_version": None,
                    "affected_translations": 0,
                    "change_ids": [],
                }
            version = self.create_knowledge_version(
                f"human lock concept translation: {source}", connection
            )
            if existing is None:
                connection.execute(
                    """INSERT INTO concepts(
                           id, kind, canonical_source, default_target,
                           working_target, verified_target, description,
                           status, scope, locked, created_version, created_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, 'verified', 'book', 1, ?, ?)""",
                    (
                        concept_id,
                        kind,
                        source,
                        target,
                        target,
                        target,
                        description,
                        version,
                        utc_now(),
                    ),
                )
            else:
                connection.execute(
                    """UPDATE concepts SET default_target=?, working_target=?,
                           verified_target=?,
                           description=CASE WHEN ?!='' THEN ? ELSE description END,
                           status='verified', locked=1
                        WHERE id=?""",
                    (target, target, target, description, description, concept_id),
                )
            lexeme_id = self._ensure_schema8_lexeme(
                connection,
                source,
                normalized_form=normalized,
                concept_id=concept_id,
                knowledge_version=version,
            )
            connection.execute(
                """INSERT OR IGNORE INTO source_forms(
                       lexeme_id, form, normalized_form, grammar_json
                   ) VALUES(?, ?, ?, '{}')""",
                (lexeme_id, source, normalized),
            )
            connection.execute(
                """UPDATE rendering_rules SET retired_version=?
                   WHERE concept_id=? AND retired_version IS NULL AND target!=?""",
                (version, concept_id, target),
            )
            connection.execute(
                """INSERT INTO rendering_rules(
                       id, concept_id, condition_json, target, priority, status,
                       scope, locked, created_version, retired_version, created_at
                   ) VALUES(?, ?, '{}', ?, 100, 'verified', 'book', 1, ?, NULL, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       target=excluded.target, priority=100, status='verified',
                       scope='book', locked=1, retired_version=NULL""",
                (rule_id, concept_id, target, version, utc_now()),
            )
            new_state = self._render_state_for_subject(
                connection, "concept", concept_id
            )
            semantic_changed = render_fingerprint(
                "concept", concept_id, old_state
            ) != render_fingerprint("concept", concept_id, new_state)
            change = self.record_render_change(
                connection,
                subject_type="concept",
                subject_id=concept_id,
                old_state=old_state,
                new_state=new_state,
                change_kind="human_lock" if semantic_changed else "description",
                reason=f"human lock concept translation: {source}",
                knowledge_version=version,
                record_metadata=True,
            )
            change_ids = (
                [int(change["change_id"])]
                if change["change_id"] is not None
                else []
            )
            connection.execute(
                """UPDATE verification_tasks
                   SET status='resolved', resolved_at=?
                   WHERE subject_type='concept' AND subject_id=?
                     AND status IN ('open','needs_human')""",
                (utc_now(), concept_id),
            )
        return {
            "concept_id": concept_id,
            "source": source,
            "target": target,
            "knowledge_version": version,
            "affected_translations": 0,
            "change_ids": change_ids,
        }

    def merge_concept_forms(
        self,
        canonical_source: str,
        aliases: Sequence[str],
    ) -> Dict[str, Any]:
        """Human-confirmed merge of inflections or spelling variants.

        Automatic reconciliation intentionally remains exact-only.  This method
        supplies the explicit human decision needed to join forms such as a
        singular and plural without teaching the scanner unsafe alias guesses.
        """
        canonical_source = canonical_source.strip()
        alias_values = list(
            dict.fromkeys(value.strip() for value in aliases if value.strip())
        )
        if not canonical_source or not alias_values:
            raise ValueError("合并概念词形时必须提供核心词形和至少一个别名")
        canonical_id = stable_id(
            "concept", normalize_english_form(canonical_source)
        )
        alias_ids = [
            stable_id("concept", normalize_english_form(alias))
            for alias in alias_values
        ]
        with self.transaction() as connection:
            canonical = connection.execute(
                """SELECT id FROM concepts
                   WHERE id=? AND retired_version IS NULL""",
                (canonical_id,),
            ).fetchone()
            if canonical is None:
                raise KeyError(f"canonical concept does not exist: {canonical_source}")
            old_canonical_render_state = self._render_state_for_subject(
                connection, "concept", canonical_id
            )

            current_version = int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
            active_ids = [canonical_id]
            preparation_plan: list[dict[str, Any]] = []
            for alias, alias_id in zip(alias_values, alias_ids):
                normalized_alias = normalize_english_form(alias)
                lexeme_id = stable_id("lexeme", f"en:{normalized_alias}")
                alias_row = connection.execute(
                    "SELECT retired_version FROM concepts WHERE id=?",
                    (alias_id,),
                ).fetchone()
                if alias_row is not None:
                    try:
                        active_alias_id = self.resolve_concept_id(
                            alias_id,
                            connection=connection,
                        )
                    except (KeyError, ValueError) as exc:
                        raise ConceptMergeConflictError(
                            "human concept-form alias cannot resolve to an active identity"
                        ) from exc
                    if active_alias_id != canonical_id:
                        active_ids.append(active_alias_id)
                    needs_link = False
                else:
                    needs_link = connection.execute(
                        """SELECT 1 FROM concept_lexemes
                           WHERE concept_id=? AND lexeme_id=?
                             AND retired_version IS NULL""",
                        (canonical_id, lexeme_id),
                    ).fetchone() is None
                preparation_plan.append(
                    {
                        "alias": alias,
                        "normalized": normalized_alias,
                        "lexeme_id": lexeme_id,
                        "needs_lexeme": connection.execute(
                            """SELECT 1 FROM lexemes
                               WHERE id=? AND retired_version IS NULL""",
                            (lexeme_id,),
                        ).fetchone()
                        is None,
                        "needs_source_form": connection.execute(
                            """SELECT 1 FROM source_forms
                               WHERE lexeme_id=? AND form=? AND normalized_form=?""",
                            (lexeme_id, alias, normalized_alias),
                        ).fetchone()
                        is None,
                        "needs_link": needs_link,
                    }
                )

            active_ids = list(dict.fromkeys(active_ids))
            preparation_changed = any(
                plan["needs_lexeme"]
                or plan["needs_source_form"]
                or plan["needs_link"]
                for plan in preparation_plan
            )
            preparation_version = current_version
            if preparation_changed:
                preparation_version = self.create_knowledge_version(
                    f"human prepare concept forms: {canonical_source}",
                    connection,
                )
            for plan in preparation_plan:
                lexeme_id = self._ensure_schema8_lexeme(
                    connection,
                    plan["alias"],
                    normalized_form=plan["normalized"],
                    knowledge_version=preparation_version,
                )
                connection.execute(
                    """INSERT OR IGNORE INTO source_forms(
                           lexeme_id, form, normalized_form, grammar_json
                       ) VALUES(?, ?, ?, '{}')""",
                    (lexeme_id, plan["alias"], plan["normalized"]),
                )
                if plan["needs_link"]:
                    self._associate_schema8_lexeme(
                        connection,
                        lexeme_id,
                        canonical_id,
                        knowledge_version=preparation_version,
                    )

            needs_merge = len(active_ids) >= 2
            if not preparation_changed and not needs_merge:
                return {
                    "canonical_id": canonical_id,
                    "canonical_source": canonical_source,
                    "aliases": alias_values,
                    "merged_concept_ids": [],
                    "changed": False,
                    "change_ids": [],
                    "knowledge_version": current_version,
                    "authorization_audit_id": None,
                    "decision_id": None,
                    "reason": "human concept-form merge already canonical",
                    "selection_key": {
                        "criterion": "already_canonical",
                        "concept_id": canonical_id,
                    },
                    "rule_conflicts": 0,
                    "affected_translations": 0,
                }

            affected_translations = 0
            if needs_merge:
                placeholders = ",".join("?" for _ in active_ids[1:])
                affected_translations = int(
                    connection.execute(
                        f"""SELECT COUNT(DISTINCT translation_id) FROM dependencies
                             WHERE dependency_type='concept'
                               AND dependency_id IN ({placeholders})""",
                        active_ids[1:],
                    ).fetchone()[0]
                )
            authorization_id = self.record_audit_call(
                run_id=None,
                block_id=None,
                purpose="human_concept_form_merge_authorization",
                model="none",
                knowledge_version=preparation_version,
                request={
                    "actor_type": "human",
                    "call_type": "human_concept_form_merge_authorization",
                    "canonical_source": canonical_source,
                    "concept_ids": active_ids,
                    "aliases": alias_values,
                },
                raw_response="",
                parsed={
                    "actor_type": "human",
                    "authorized": True,
                    "canonical_concept_id": canonical_id,
                },
                accepted=True,
                attempts=1,
                elapsed_ms=0,
                error=None,
                connection=connection,
                archive_payload=False,
            )
            change_ids: list[int] = []
            if preparation_changed:
                change = self.record_render_change(
                    connection,
                    subject_type="concept",
                    subject_id=canonical_id,
                    old_state=old_canonical_render_state,
                    new_state=self._render_state_for_subject(
                        connection, "concept", canonical_id
                    ),
                    change_kind="concept_form_aliases",
                    reason=f"human prepare concept forms: {canonical_source}",
                    knowledge_version=preparation_version,
                )
                if change["change_id"] is not None:
                    change_ids.append(int(change["change_id"]))
            if not needs_merge:
                return {
                    "canonical_id": canonical_id,
                    "canonical_source": canonical_source,
                    "aliases": alias_values,
                    "merged_concept_ids": [],
                    "changed": True,
                    "knowledge_version": preparation_version,
                    "authorization_audit_id": authorization_id,
                    "decision_id": None,
                    "reason": "human prepare concept form aliases",
                    "selection_key": {
                        "criterion": "human_alias_preparation",
                        "concept_id": canonical_id,
                    },
                    "rule_conflicts": 0,
                    "affected_translations": 0,
                    "change_ids": sorted(set(change_ids)),
                }
            reason = (
                f"{HUMAN_CONCEPT_FORM_REDIRECT_PREFIX}{authorization_id}: "
                f"{canonical_source}"
            )
            result = self._merge_concepts_authorized(
                active_ids,
                reason=reason,
                decision_id=f"human-audit:{authorization_id}",
                connection=connection,
                human_authorized_cross_lexeme=True,
                preferred_canonical_id=canonical_id,
            )
            return {
                **result,
                "canonical_source": canonical_source,
                "aliases": alias_values,
                "authorization_audit_id": authorization_id,
                "affected_translations": affected_translations,
                "change_ids": sorted(
                    set(change_ids) | set(result.get("change_ids") or [])
                ),
            }

    def import_legacy_translation(
        self,
        block_id: str,
        status: str,
        draft: str,
        final: str,
        analysis: str,
        warnings: Sequence[str],
    ) -> None:
        if not final:
            return
        with self.transaction() as connection:
            existing = connection.execute(
                """SELECT 1 FROM translation_versions
                   WHERE block_id=? AND pipeline='serial_v3' AND active=1""",
                (block_id,),
            ).fetchone()
            if existing:
                return
            version = int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, status, draft_translation,
                       final_translation, analysis, warnings_json, active, created_at
                   ) VALUES(?, 'serial_v3', ?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    block_id, version, status, draft, final,
                    analysis, json.dumps(list(warnings), ensure_ascii=False), utc_now(),
                ),
            )

    @staticmethod
    def _representative_paragraph(
        source_text: str,
        source_form: str,
        *,
        match_forms: Sequence[str] | None = None,
    ) -> str:
        paragraphs = [
            part.strip()
            for part in re.split(r"\n\s*\n", source_text or "")
            if part.strip()
        ]
        forms = list(match_forms or (source_form,))
        for paragraph in paragraphs:
            if any(
                re.search(
                    rf"(?<!\w){re.escape(form)}(?!\w)",
                    paragraph,
                    re.I,
                )
                for form in forms
            ):
                return paragraph[:1200]
        return (paragraphs[0] if paragraphs else source_text)[:1200]

    @staticmethod
    def _target_context_signal(text: str) -> int:
        normalized = f" {re.sub(r'\s+', ' ', text).casefold()} "
        weighted_markers = (
            (" no ", 4),
            (" not ", 3),
            (" rather ", 3),
            (" but ", 2),
            (" instead ", 2),
            (" unlike ", 2),
            (" different ", 2),
            (" called ", 1),
            (" means ", 1),
            (" i am a ", 1),
            (" are you a ", 1),
        )
        return sum(weight for marker, weight in weighted_markers if marker in normalized)

    @staticmethod
    def _target_definition_signal(
        text: str, match_forms: Sequence[str]
    ) -> int:
        normalized = re.sub(r"\s+", " ", text).casefold()
        speakers = r"(?:i am|i'm|are you|is he|is she|he is|she is)"
        for form in match_forms:
            if re.search(
                rf"\b{speakers}\s+(?:an?\s+)?{re.escape(form.casefold())}\b",
                normalized,
            ):
                return 1
        return 0

    @staticmethod
    def _target_vocative_signal(
        text: str, match_forms: Sequence[str]
    ) -> int:
        normalized = re.sub(r"\s+", " ", text)
        for form in match_forms:
            escaped = re.escape(form)
            if re.search(
                rf",\s*{escaped}\s*[,.:;!?]",
                normalized,
                re.IGNORECASE,
            ) or re.search(
                rf"\b(?:Master|Mistress|Lord|Lady|Sir|Madam|Doctor|Captain)"
                rf"\s+{escaped}\b",
                normalized,
                re.IGNORECASE,
            ):
                return 1
        return 0

    def working_target_candidates(self) -> List[Dict[str, Any]]:
        """Return active targetless lexemes that need one book-wide rendering."""

        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT l.id lexeme_id, l.canonical_form, l.default_target,
                          l.working_target, l.verified_target, l.status, l.locked,
                          c.id concept_id, c.description,
                          COALESCE(
                              c.kind,
                              (
                                  SELECT cto.kind
                                  FROM concept_type_observations cto
                                  WHERE cto.lexeme_id=l.id
                                    AND cto.retired_version IS NULL
                                  ORDER BY cto.confidence DESC, cto.id
                                  LIMIT 1
                              ),
                              'concept'
                          ) resolved_kind,
                          c.verified_target concept_verified_target,
                          c.locked concept_locked,
                          COUNT(m.id) mention_count,
                          COUNT(DISTINCT m.block_id) mentioned_blocks,
                          COALESCE((
                              SELECT MAX(cc.affected_block_count)
                              FROM candidate_resolutions cr
                              JOIN candidate_adjudications ca
                                ON ca.id=cr.adjudication_id AND ca.active=1
                              JOIN candidate_clusters cc ON cc.id=cr.cluster_id
                              WHERE cr.lexeme_id=l.id
                          ), 0) cluster_blocks
                   FROM lexemes l
                   LEFT JOIN mentions m ON m.lexeme_id=l.id
                   LEFT JOIN concepts c ON c.id=(
                       SELECT c2.id FROM concepts c2
                       WHERE c2.retired_version IS NULL
                         AND c2.primary_lexeme_id=l.id
                       ORDER BY c2.locked DESC,
                                CASE WHEN c2.status='verified' THEN 1 ELSE 0 END DESC,
                                c2.id LIMIT 1
                   )
                   WHERE l.retired_version IS NULL
                   GROUP BY l.id
                   ORDER BY lower(l.normalized_form), l.id"""
            ).fetchall()
            candidates: List[Dict[str, Any]] = []
            for row in rows:
                working = str(row["working_target"] or "").strip()
                verified = str(row["verified_target"] or "").strip()
                effective = verified or working or str(
                    row["default_target"] or ""
                ).strip()
                if (
                    verified
                    or bool(row["locked"])
                    or str(row["concept_verified_target"] or "").strip()
                    or bool(row["concept_locked"])
                ):
                    continue
                affected_blocks = max(
                    int(row["mentioned_blocks"] or 0),
                    int(row["cluster_blocks"] or 0),
                )
                repeated = int(row["mention_count"] or 0) >= 2 or affected_blocks >= 2
                high_impact = affected_blocks >= 3
                required = repeated or high_impact
                if effective or not required:
                    continue
                lexeme_id = str(row["lexeme_id"])
                concept_id = str(row["concept_id"] or "")
                candidates.append(
                    {
                        "subject_type": "lexeme",
                        "subject_id": lexeme_id,
                        "lexeme_id": lexeme_id,
                        # Kept for old model/audit/queue readers.
                        "concept_id": concept_id,
                        "source": str(row["canonical_form"]),
                        "kind": str(row["resolved_kind"] or "concept"),
                        "description": str(row["description"] or ""),
                        "contexts": [],
                        "context_block_ids": [],
                        "affected_blocks": affected_blocks,
                        "high_impact": high_impact,
                    }
                )
            if not candidates:
                return []

            lexeme_ids = [item["lexeme_id"] for item in candidates]
            placeholders = ",".join("?" for _ in lexeme_ids)
            requested_forms: list[dict[str, str]] = []
            for item in candidates:
                forms = {normalize_english_form(item["source"])}
                if str(item.get("kind") or "").casefold() == "role":
                    forms.update(
                        _conservative_english_inflection_forms(item["source"])
                    )
                requested_forms.extend(
                    {
                        "lexeme_id": item["lexeme_id"],
                        "normalized_form": form,
                    }
                    for form in sorted(forms)
                    if form
                )
            context_rows = connection.execute(
                f"""WITH requested_forms AS (
                           SELECT json_extract(value, '$.lexeme_id') lexeme_id,
                                  json_extract(value, '$.normalized_form')
                                      normalized_form
                           FROM json_each(?)
                       ),
                       occurrence_blocks AS (
                           SELECT m.lexeme_id, b.id block_id, b.source_text,
                                  b.global_index
                           FROM mentions m JOIN blocks b ON b.id=m.block_id
                           WHERE m.lexeme_id IN ({placeholders})
                           UNION
                           SELECT rf.lexeme_id, b.id block_id, b.source_text,
                                  b.global_index
                           FROM requested_forms rf
                           JOIN lexical_candidates lc
                             ON lower(lc.normalized_text)=rf.normalized_form
                           JOIN blocks b ON b.id=lc.block_id
                       ),
                       scored AS (
                           SELECT lexeme_id, block_id, source_text, global_index,
                                  (
                                      CASE WHEN lower(' ' || source_text || ' ')
                                                LIKE '% no %'
                                           THEN 4 ELSE 0 END
                                      + CASE WHEN lower(' ' || source_text || ' ')
                                                  LIKE '% not %'
                                             THEN 3 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%rather%'
                                             THEN 3 ELSE 0 END
                                      + CASE WHEN lower(' ' || source_text || ' ')
                                                  LIKE '% but %'
                                             THEN 2 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%instead%'
                                             THEN 2 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%unlike%'
                                             THEN 2 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%different%'
                                             THEN 2 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%called%'
                                             THEN 1 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%means%'
                                             THEN 1 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%i am a %'
                                             THEN 1 ELSE 0 END
                                      + CASE WHEN lower(source_text)
                                                  LIKE '%are you a %'
                                             THEN 1 ELSE 0 END
                                  ) signal_score
                           FROM occurrence_blocks
                       ),
                       ranked AS (
                           SELECT lexeme_id, block_id, source_text, global_index,
                                  signal_score,
                                  ROW_NUMBER() OVER (
                                      PARTITION BY lexeme_id
                                      ORDER BY global_index, block_id
                                  ) occurrence_rank,
                                  ROW_NUMBER() OVER (
                                      PARTITION BY lexeme_id
                                      ORDER BY signal_score DESC,
                                               global_index, block_id
                                  ) signal_rank
                           FROM scored
                       )
                       SELECT lexeme_id, block_id, source_text, global_index,
                              signal_score, occurrence_rank, signal_rank
                       FROM ranked
                       WHERE occurrence_rank=1 OR signal_rank<=12
                       ORDER BY lexeme_id,
                                CASE WHEN occurrence_rank=1 THEN 0 ELSE 1 END,
                                signal_score DESC, global_index, block_id""",
                (
                    json.dumps(
                        requested_forms,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    *lexeme_ids,
                ),
            ).fetchall()
            candidates_by_id = {
                item["lexeme_id"]: item for item in candidates
            }
            context_pool: dict[str, list[dict[str, Any]]] = {
                lexeme_id: [] for lexeme_id in candidates_by_id
            }
            for row in context_rows:
                candidate = candidates_by_id[str(row["lexeme_id"])]
                match_forms = (
                    sorted(
                        _conservative_english_inflection_forms(
                            candidate["source"]
                        )
                    )
                    if str(candidate.get("kind") or "").casefold() == "role"
                    else [candidate["source"]]
                )
                paragraph = self._representative_paragraph(
                    str(row["source_text"]),
                    candidate["source"],
                    match_forms=match_forms,
                )
                context_pool[candidate["lexeme_id"]].append(
                    {
                        "block_id": str(row["block_id"]),
                        "global_index": int(row["global_index"]),
                        "paragraph": paragraph,
                        "signal_score": self._target_context_signal(paragraph),
                        "definition_score": self._target_definition_signal(
                            paragraph, match_forms
                        ),
                        "vocative_score": self._target_vocative_signal(
                            paragraph, match_forms
                        ),
                    }
                )
            for lexeme_id, pool in context_pool.items():
                if not pool:
                    continue
                earliest = min(
                    pool,
                    key=lambda item: (
                        item["global_index"],
                        item["block_id"],
                    ),
                )
                selected = [earliest]
                seen_blocks = {earliest["block_id"]}
                seen_paragraphs = {earliest["paragraph"]}
                ranked_definition = sorted(
                    pool,
                    key=lambda value: (
                        -int(value["definition_score"]),
                        -int(value["signal_score"]),
                        value["global_index"],
                        value["block_id"],
                    ),
                )
                if (
                    ranked_definition
                    and ranked_definition[0]["definition_score"]
                ):
                    item = ranked_definition[0]
                    if item["block_id"] not in seen_blocks:
                        selected.append(item)
                        seen_blocks.add(item["block_id"])
                        seen_paragraphs.add(item["paragraph"])
                ranked_vocative = sorted(
                    pool,
                    key=lambda value: (
                        -int(value["vocative_score"]),
                        -int(value["signal_score"]),
                        value["global_index"],
                        value["block_id"],
                    ),
                )
                if ranked_vocative and ranked_vocative[0]["vocative_score"]:
                    item = ranked_vocative[0]
                    if item["block_id"] not in seen_blocks:
                        selected.append(item)
                        seen_blocks.add(item["block_id"])
                        seen_paragraphs.add(item["paragraph"])
                for item in sorted(
                    pool,
                    key=lambda value: (
                        -int(value["signal_score"]),
                        value["global_index"],
                        value["block_id"],
                    ),
                ):
                    if (
                        item["block_id"] in seen_blocks
                        or item["paragraph"] in seen_paragraphs
                    ):
                        continue
                    selected.append(item)
                    seen_blocks.add(item["block_id"])
                    seen_paragraphs.add(item["paragraph"])
                    if len(selected) >= 4:
                        break
                candidate = candidates_by_id[lexeme_id]
                candidate["context_block_ids"] = [
                    item["block_id"] for item in selected
                ]
                candidate["contexts"] = [
                    item["paragraph"] for item in selected
                ]

            block_ids = list(
                dict.fromkeys(
                    block_id
                    for item in candidates
                    for block_id in item["context_block_ids"]
                )
            )
            references: Dict[str, str] = {}
            if block_ids:
                block_placeholders = ",".join("?" for _ in block_ids)
                baseline_rows = connection.execute(
                    f"""SELECT l.block_id, d.id document_id, d.name,
                               d.created_at, p.target_text, l.ordinal,
                               l.partial_start, l.partial_end, l.alignment_status
                        FROM block_baseline_links l
                        JOIN baseline_documents d
                          ON d.id=l.baseline_document_id AND d.active=1
                        JOIN baseline_paragraphs p
                          ON p.baseline_document_id=l.baseline_document_id
                         AND p.paragraph_index=l.paragraph_index
                        WHERE l.block_id IN ({block_placeholders})
                        ORDER BY l.block_id, d.created_at DESC, d.id, l.ordinal""",
                    block_ids,
                ).fetchall()
                documents: Dict[tuple[str, str], Dict[str, Any]] = {}
                document_order: Dict[str, List[str]] = {}
                for row in baseline_rows:
                    block_id = str(row["block_id"])
                    document_id = str(row["document_id"])
                    key = (block_id, document_id)
                    if key not in documents:
                        documents[key] = {"parts": [], "exact": True}
                        document_order.setdefault(block_id, []).append(document_id)
                    documents[key]["parts"].append(str(row["target_text"] or ""))
                    if (
                        bool(row["partial_start"])
                        or bool(row["partial_end"])
                        or str(row["alignment_status"]) != "exact"
                    ):
                        documents[key]["exact"] = False
                for block_id, ordered_documents in document_order.items():
                    for document_id in ordered_documents:
                        document = documents[(block_id, document_id)]
                        text = "\n\n".join(document["parts"]).strip()
                        if document["exact"] and text:
                            references[block_id] = text
                            break

                missing = [item for item in block_ids if item not in references]
                if missing:
                    missing_placeholders = ",".join("?" for _ in missing)
                    for row in connection.execute(
                        f"""SELECT block_id, final_translation FROM (
                                   SELECT block_id, final_translation,
                                          ROW_NUMBER() OVER (
                                              PARTITION BY block_id ORDER BY id DESC
                                          ) version_rank
                                   FROM translation_versions
                                   WHERE block_id IN ({missing_placeholders})
                                     AND pipeline='serial_v3' AND active=1
                                     AND final_translation!=''
                               ) WHERE version_rank=1""",
                        missing,
                    ).fetchall():
                        references[str(row["block_id"])] = str(
                            row["final_translation"]
                        ).strip()

            for candidate in candidates:
                baselines: List[str] = []
                for block_id in candidate.pop("context_block_ids"):
                    text = references.get(block_id, "").strip()
                    if text and text not in baselines:
                        baselines.append(text[:1600])
                    if len(baselines) >= 3:
                        break
                candidate["baseline_translations"] = baselines
            return candidates

    def enqueue_working_target_review(
        self, subject_ids: Sequence[str], error: str
    ) -> int:
        queued = 0
        with self.transaction() as connection:
            for requested_id in dict.fromkeys(str(value) for value in subject_ids):
                concept = connection.execute(
                    """SELECT id, canonical_source, kind, primary_lexeme_id
                       FROM concepts
                       WHERE id=? AND retired_version IS NULL""",
                    (requested_id,),
                ).fetchone()
                lexeme = connection.execute(
                    """SELECT id, canonical_form FROM lexemes
                       WHERE id=? AND retired_version IS NULL""",
                    (requested_id,),
                ).fetchone()
                if lexeme is not None:
                    representative = connection.execute(
                        """SELECT id, canonical_source, kind, primary_lexeme_id
                           FROM concepts
                           WHERE primary_lexeme_id=? AND retired_version IS NULL
                           ORDER BY locked DESC,
                                    CASE WHEN status='verified' THEN 1 ELSE 0 END DESC,
                                    id LIMIT 1""",
                        (requested_id,),
                    ).fetchone()
                    concept = representative
                    subject_type = "lexeme"
                    subject_id = requested_id
                    source = str(lexeme["canonical_form"])
                elif concept is not None:
                    subject_type = "concept"
                    subject_id = requested_id
                    source = str(concept["canonical_source"])
                else:
                    continue
                concept_id = str(concept["id"] or "") if concept is not None else ""
                exists = connection.execute(
                    """SELECT 1 FROM human_queue
                       WHERE kind='working_target_required' AND status='open'
                         AND (
                             json_extract(payload_json, '$.subject_id')=?
                             OR (?!='' AND json_extract(payload_json, '$.concept_id')=?)
                         )""",
                    (subject_id, concept_id, concept_id),
                ).fetchone()
                if exists:
                    continue
                payload = {
                    "subject_type": subject_type,
                    "subject_id": subject_id,
                    "concept_id": concept_id,
                    "lexeme_id": (
                        subject_id
                        if subject_type == "lexeme"
                        else str(concept["primary_lexeme_id"] or "")
                    ),
                    "source": source,
                    "kind": str(concept["kind"] or "concept") if concept else "concept",
                    "error": error[:1000],
                }
                connection.execute(
                    """INSERT INTO human_queue(
                           block_id, kind, severity, payload_json, created_at
                       ) VALUES(NULL, 'working_target_required', 'blocking', ?, ?)""",
                    (json.dumps(payload, ensure_ascii=False, sort_keys=True), utc_now()),
                )
                queued += 1
        return queued

    @staticmethod
    def _normalized_working_rules(rules: Sequence[Dict[str, Any]]) -> tuple[str, ...]:
        normalized = []
        for rule in rules:
            condition = rule.get("condition") or {}
            target = str(rule.get("target") or "").strip()
            normalized.append(
                json.dumps(
                    {"condition": condition, "target": target},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        return tuple(sorted(normalized))

    @staticmethod
    def _normalized_contrast_sources(values: Sequence[Any]) -> tuple[str, ...]:
        by_key: Dict[str, str] = {}
        for raw in values:
            value = str(raw).strip()
            if not value or len(value) > 120:
                raise ValueError(
                    "contrast sources must be non-empty and at most 120 characters"
                )
            by_key.setdefault(value.casefold(), value)
        return tuple(by_key[key] for key in sorted(by_key))

    @staticmethod
    def _term_profile_from_row(row: Optional[sqlite3.Row]) -> Dict[str, Any]:
        if row is None:
            return {
                "semantic_core": "",
                "contrast_sources": [],
                "status": "provisional",
                "locked": False,
            }
        try:
            raw_contrasts = json.loads(str(row["contrast_sources_json"] or "[]"))
        except json.JSONDecodeError as exc:
            raise ValueError("term profile contrast_sources_json is invalid") from exc
        if not isinstance(raw_contrasts, list):
            raise ValueError("term profile contrast_sources_json must be a list")
        contrasts = list(V4Database._normalized_contrast_sources(raw_contrasts))
        return {
            "semantic_core": str(row["semantic_core"] or "").strip(),
            "contrast_sources": contrasts,
            "status": str(row["status"] or "provisional"),
            "locked": bool(row["locked"]),
        }

    def _active_term_profile(
        self,
        connection: sqlite3.Connection,
        subject_type: str,
        subject_id: str,
    ) -> Dict[str, Any]:
        row = connection.execute(
            """SELECT semantic_core, contrast_sources_json, status, locked
               FROM term_profiles
               WHERE subject_type=? AND subject_id=?
                 AND retired_version IS NULL
               ORDER BY locked DESC, created_version DESC
               LIMIT 1""",
            (subject_type, subject_id),
        ).fetchone()
        return self._term_profile_from_row(row)

    def _invalidate_working_target_dependents(
        self,
        connection: sqlite3.Connection,
        subjects: Sequence[Dict[str, str]],
    ) -> int:
        """Compatibility shim; task planning is explicit in RevalidationPlanner."""

        self._require_active_transaction(connection)
        return 0

    def apply_working_target_decisions(
        self, decisions: Sequence[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Install working renderings on lexemes unless a reliable concept is explicit."""

        validated: List[Dict[str, Any]] = []
        for decision in decisions:
            raw_rules = list(decision.get("rules") or [])
            if len(raw_rules) > 6:
                raise ValueError("working targets allow at most six rendering rules")
            item = dict(decision)
            item["semantic_core"] = str(
                decision.get("semantic_core") or ""
            ).strip()
            if len(item["semantic_core"]) > 600:
                raise ValueError("semantic_core must be at most 600 characters")
            item["contrast_sources"] = list(
                self._normalized_contrast_sources(
                    list(decision.get("contrast_sources") or [])
                )
            )
            item["rules"] = [
                WorkingTargetRule.model_validate(rule).model_dump()
                for rule in raw_rules
            ]
            validated.append(item)
        ordered = sorted(
            validated,
            key=lambda item: (
                str(item.get("subject_type") or "lexeme"),
                str(
                    item.get("subject_id")
                    or item.get("lexeme_id")
                    or item.get("concept_id")
                    or ""
                ),
            ),
        )
        with self.transaction() as connection:
            changed: List[Dict[str, Any]] = []
            processed: List[Dict[str, str]] = []
            queue_ids: set[str] = set()
            resolved = 0
            for decision in ordered:
                target = str(decision.get("target") or "").strip()
                rules = list(decision.get("rules") or [])
                if not target:
                    raise ValueError("working target decisions require a non-empty target")
                requested_type = str(decision.get("subject_type") or "lexeme")
                if requested_type not in {"lexeme", "concept"}:
                    raise ValueError(
                        "working target subject_type must be lexeme or concept"
                    )
                legacy_concept_id = str(decision.get("concept_id") or "").strip()
                if legacy_concept_id:
                    queue_ids.add(legacy_concept_id)
                if requested_type == "concept":
                    raw_id = str(
                        decision.get("subject_id") or legacy_concept_id or ""
                    ).strip()
                    if not raw_id:
                        raise ValueError("concept working target requires subject_id")
                    subject_id = self.resolve_concept_id(
                        raw_id, connection=connection
                    )
                    subject_type = "concept"
                    row = connection.execute(
                        """SELECT id, working_target, verified_target, locked
                           FROM concepts
                           WHERE id=? AND retired_version IS NULL""",
                        (subject_id,),
                    ).fetchone()
                    reliable_different = connection.execute(
                        """SELECT 1
                           FROM concepts c
                           WHERE c.id=? AND (
                               EXISTS(
                                   SELECT 1 FROM coreference_decisions cd
                                   WHERE cd.retired_version IS NULL
                                     AND cd.lexeme_id=c.primary_lexeme_id
                                     AND cd.relation='different'
                                     AND (cd.locked=1 OR cd.decision_source='human')
                                     AND (
                                         (cd.left_anchor_type='concept'
                                          AND cd.left_anchor_id=c.id)
                                         OR
                                         (cd.right_anchor_type='concept'
                                          AND cd.right_anchor_id=c.id)
                                     )
                               )
                               OR EXISTS(
                                   SELECT 1 FROM concept_type_observations cto
                                   WHERE cto.concept_id=c.id
                                     AND cto.retired_version IS NULL
                                     AND cto.source IN ('human','verified')
                               )
                           )""",
                        (subject_id,),
                    ).fetchone()
                    if reliable_different is None:
                        raise ValueError(
                            "concept override requires reliable different concept evidence"
                        )
                    queue_ids.add(subject_id)
                else:
                    raw_lexeme_id = str(
                        decision.get("subject_id")
                        or decision.get("lexeme_id")
                        or ""
                    ).strip()
                    if not raw_lexeme_id and legacy_concept_id:
                        canonical = self.resolve_concept_id(
                            legacy_concept_id, connection=connection
                        )
                        concept = connection.execute(
                            """SELECT primary_lexeme_id, verified_target, locked
                               FROM concepts
                               WHERE id=? AND retired_version IS NULL""",
                            (canonical,),
                        ).fetchone()
                        if concept is None or not str(concept["primary_lexeme_id"] or ""):
                            raise KeyError(f"active concept has no primary lexeme: {canonical}")
                        if bool(concept["locked"]) or str(
                            concept["verified_target"] or ""
                        ).strip():
                            continue
                        raw_lexeme_id = str(concept["primary_lexeme_id"])
                        queue_ids.add(canonical)
                    if not raw_lexeme_id:
                        raise ValueError("lexeme working target requires subject_id")
                    subject_type = "lexeme"
                    subject_id = raw_lexeme_id
                    row = connection.execute(
                        """SELECT l.id, l.working_target, l.verified_target,
                                  l.locked, l.canonical_form,
                                  COALESCE(
                                      (
                                          SELECT c.kind FROM concepts c
                                          WHERE c.primary_lexeme_id=l.id
                                            AND c.retired_version IS NULL
                                          ORDER BY c.locked DESC,
                                                   CASE WHEN c.status='verified'
                                                        THEN 1 ELSE 0 END DESC,
                                                   c.id
                                          LIMIT 1
                                      ),
                                      (
                                          SELECT cto.kind
                                          FROM concept_type_observations cto
                                          WHERE cto.lexeme_id=l.id
                                            AND cto.retired_version IS NULL
                                          ORDER BY cto.confidence DESC, cto.id
                                          LIMIT 1
                                      ),
                                      'concept'
                                  ) resolved_kind
                           FROM lexemes l
                           WHERE l.id=? AND l.retired_version IS NULL""",
                        (subject_id,),
                    ).fetchone()
                    queue_ids.add(subject_id)
                if row is None:
                    raise KeyError(f"active {subject_type} not found: {subject_id}")
                if bool(row["locked"]) or str(row["verified_target"] or "").strip():
                    continue
                resolved += 1
                subject_ref = {
                    "subject_type": subject_type,
                    "subject_id": subject_id,
                }
                processed.append(subject_ref)
                subject_column = f"{subject_type}_id"
                existing_rules = [
                    {
                        "condition": json.loads(row["condition_json"]),
                        "target": row["target"],
                    }
                    for row in connection.execute(
                        f"""SELECT condition_json, target FROM rendering_rules
                           WHERE {subject_column}=? AND retired_version IS NULL
                             AND locked=0 AND status='provisional'""",
                        (subject_id,),
                    ).fetchall()
                ]
                existing_profile = self._active_term_profile(
                    connection, subject_type, subject_id
                )
                semantic_core = str(decision.get("semantic_core") or "").strip()
                contrast_sources = list(
                    decision.get("contrast_sources") or []
                )
                if existing_profile["locked"]:
                    semantic_core = str(existing_profile["semantic_core"])
                    contrast_sources = list(
                        existing_profile["contrast_sources"]
                    )
                observed_forms: list[dict[str, str]] = []
                if (
                    subject_type == "lexeme"
                    and str(row["resolved_kind"] or "").casefold() == "role"
                ):
                    base_form = normalize_english_form(
                        str(row["canonical_form"] or "")
                    )
                    variant_forms = sorted(
                        _conservative_english_inflection_forms(base_form)
                        - {base_form}
                    )
                    if variant_forms:
                        variant_placeholders = ",".join(
                            "?" for _ in variant_forms
                        )
                        existing_forms = {
                            str(item["normalized_form"])
                            for item in connection.execute(
                                """SELECT normalized_form FROM source_forms
                                   WHERE lexeme_id=?""",
                                (subject_id,),
                            ).fetchall()
                        }
                        occupied_forms = {
                            str(item["normalized_form"])
                            for item in connection.execute(
                                f"""SELECT normalized_form FROM lexemes
                                     WHERE normalized_form IN (
                                         {variant_placeholders}
                                     )
                                       AND id!=? AND retired_version IS NULL""",
                                (*variant_forms, subject_id),
                            ).fetchall()
                        }
                        for item in connection.execute(
                            f"""SELECT original_text, normalized_text
                                 FROM lexical_candidates
                                 WHERE lower(normalized_text) IN (
                                     {variant_placeholders}
                                 )
                                 ORDER BY lower(normalized_text), id""",
                            variant_forms,
                        ).fetchall():
                            normalized_form = normalize_english_form(
                                str(item["normalized_text"] or "")
                            )
                            if (
                                normalized_form in existing_forms
                                or normalized_form in occupied_forms
                                or normalized_form
                                not in set(variant_forms)
                            ):
                                continue
                            observed_forms.append(
                                {
                                    "form": str(item["original_text"]),
                                    "normalized_form": normalized_form,
                                }
                            )
                            existing_forms.add(normalized_form)
                if (
                    str(row["working_target"] or "") == target
                    and self._normalized_working_rules(existing_rules)
                    == self._normalized_working_rules(rules)
                    and str(existing_profile["semantic_core"]) == semantic_core
                    and list(existing_profile["contrast_sources"])
                    == contrast_sources
                    and not observed_forms
                ):
                    continue
                changed.append(
                    {
                        **subject_ref,
                        "legacy_concept_id": legacy_concept_id,
                        "target": target,
                        "semantic_core": semantic_core,
                        "contrast_sources": contrast_sources,
                        "profile_locked": bool(existing_profile["locked"]),
                        "observed_forms": observed_forms,
                        "rules": rules,
                        "old_state": self._render_state_for_subject(
                            connection, subject_type, subject_id
                        ),
                    }
                )

            resolved_at = utc_now()
            for queue_id in sorted(queue_ids):
                connection.execute(
                    """UPDATE human_queue
                       SET status='resolved', resolved_at=?
                       WHERE kind='working_target_required' AND status='open'
                         AND (
                             json_extract(payload_json, '$.concept_id')=?
                             OR json_extract(payload_json, '$.subject_id')=?
                             OR json_extract(payload_json, '$.lexeme_id')=?
                         )""",
                    (resolved_at, queue_id, queue_id, queue_id),
                )

            if not changed:
                return {
                    "resolved": resolved,
                    "changed": 0,
                    "knowledge_version": None,
                    "affected_blocks": 0,
                    "subjects": processed,
                    "change_ids": [],
                }
            version = self.create_knowledge_version(
                "resolve provisional working translations", connection
            )
            change_ids: list[int] = []
            for decision in changed:
                subject_type = decision["subject_type"]
                subject_id = decision["subject_id"]
                table = "lexemes" if subject_type == "lexeme" else "concepts"
                subject_column = f"{subject_type}_id"
                connection.execute(
                    f"""UPDATE {table}
                       SET working_target=?, default_target=?
                       WHERE id=? AND locked=0 AND verified_target=''""",
                    (decision["target"], decision["target"], subject_id),
                )
                if subject_type == "lexeme" and decision["legacy_concept_id"]:
                    # Compatibility mirror only. Rendering treats it as a concept
                    # override solely when independent reliable concept evidence exists.
                    connection.execute(
                        """UPDATE concepts
                           SET working_target=?, default_target=?
                           WHERE id=? AND primary_lexeme_id=? AND locked=0
                             AND verified_target=''""",
                        (
                            decision["target"],
                            decision["target"],
                            decision["legacy_concept_id"],
                            subject_id,
                        ),
                    )
                if subject_type == "lexeme":
                    connection.executemany(
                        """INSERT OR IGNORE INTO source_forms(
                               lexeme_id, form, normalized_form, grammar_json)
                           VALUES(?, ?, ?, ?)""",
                        [
                            (
                                subject_id,
                                form["form"],
                                form["normalized_form"],
                                json.dumps(
                                    {
                                        "inferred": "safe_english_inflection",
                                        "observed": True,
                                    },
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                ),
                            )
                            for form in decision["observed_forms"]
                        ],
                    )
                connection.execute(
                    f"""UPDATE rendering_rules SET retired_version=?
                       WHERE {subject_column}=? AND retired_version IS NULL AND locked=0""",
                    (version, subject_id),
                )
                for ordinal, rule in enumerate(decision["rules"]):
                    condition = rule.get("condition") or {}
                    target = str(rule.get("target") or "").strip()
                    if not condition or not target:
                        raise ValueError("working rendering rules cannot be empty")
                    condition_json = json.dumps(
                        condition, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                    )
                    rule_id = stable_id(
                        "rule",
                        f"working:{subject_type}:{subject_id}:{version}:{ordinal}:{condition_json}:{target}",
                        length=24,
                    )
                    connection.execute(
                        f"""INSERT INTO rendering_rules(
                               id, {subject_column}, condition_json, target, priority,
                               status, scope, locked, created_version, created_at
                           ) VALUES(?, ?, ?, ?, ?, 'provisional', 'book', 0, ?, ?)""",
                        (
                            rule_id,
                            subject_id,
                            condition_json,
                            target,
                            50 - ordinal,
                            version,
                            utc_now(),
                        ),
                    )
                if not decision["profile_locked"]:
                    connection.execute(
                        """UPDATE term_profiles SET retired_version=?
                           WHERE subject_type=? AND subject_id=?
                             AND retired_version IS NULL AND locked=0""",
                        (version, subject_type, subject_id),
                    )
                    if (
                        decision["semantic_core"]
                        or decision["contrast_sources"]
                    ):
                        connection.execute(
                            """INSERT INTO term_profiles(
                                   subject_type, subject_id, semantic_core,
                                   contrast_sources_json, status, locked,
                                   created_version, created_at
                               ) VALUES(?, ?, ?, ?, 'provisional', 0, ?, ?)""",
                            (
                                subject_type,
                                subject_id,
                                decision["semantic_core"],
                                json.dumps(
                                    decision["contrast_sources"],
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                ),
                                version,
                                utc_now(),
                            ),
                        )
                new_state = self._render_state_for_subject(
                    connection, subject_type, subject_id
                )
                if decision["old_state"].get("rules") != new_state.get("rules"):
                    change_kind = "rendering_rule"
                elif (
                    decision["old_state"].get("working_target")
                    != new_state.get("working_target")
                ):
                    change_kind = "target"
                else:
                    change_kind = "term_profile"
                change = self.record_render_change(
                    connection,
                    subject_type=subject_type,
                    subject_id=subject_id,
                    old_state=decision["old_state"],
                    new_state=new_state,
                    change_kind=change_kind,
                    reason="resolve provisional working translations",
                    knowledge_version=version,
                )
                if change["change_id"] is not None:
                    change_ids.append(int(change["change_id"]))
            affected = self._invalidate_working_target_dependents(
                connection,
                [
                    {
                        "subject_type": item["subject_type"],
                        "subject_id": item["subject_id"],
                    }
                    for item in changed
                ]
                + [
                    {
                        "subject_type": "concept",
                        "subject_id": item["legacy_concept_id"],
                    }
                    for item in changed
                    if item["legacy_concept_id"]
                ],
            )
            return {
                "resolved": resolved,
                "changed": len(changed),
                "knowledge_version": version,
                "affected_blocks": affected,
                "subjects": [
                    {
                        "subject_type": item["subject_type"],
                        "subject_id": item["subject_id"],
                    }
                    for item in changed
                ],
                "change_ids": sorted(set(change_ids)),
            }

    def _concept_snapshot_from_connection(
        self, connection: sqlite3.Connection
    ) -> List[Dict[str, Any]]:
        rows = connection.execute(
            """SELECT c.id, c.kind, c.canonical_source, c.default_target,
                      c.working_target, c.verified_target, c.description,
                      c.status, c.locked, sf.form, sf.normalized_form
               FROM concepts c
               JOIN concept_lexemes cl
                 ON cl.concept_id=c.id AND cl.retired_version IS NULL
               JOIN source_forms sf ON sf.lexeme_id=cl.lexeme_id
               JOIN knowledge_versions kv ON kv.id=c.created_version
               WHERE c.retired_version IS NULL
                 AND NOT (
                     kv.reason LIKE 'translation proposals %'
                     AND c.status='provisional' AND c.locked=0
                     AND c.working_target='' AND c.verified_target=''
                 )
               ORDER BY lower(c.canonical_source), c.id, lower(sf.form), sf.id"""
        ).fetchall()
        concepts: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            working = str(row["working_target"] or "").strip()
            verified = str(row["verified_target"] or "").strip()
            locked_fallback = (
                str(row["default_target"] or "").strip()
                if bool(row["locked"])
                else ""
            )
            effective = verified or working or locked_fallback
            item = concepts.setdefault(
                str(row["id"]),
                {
                    "id": str(row["id"]),
                    "kind": str(row["kind"]),
                    "source": str(row["canonical_source"]),
                    "working_target": working,
                    "verified_target": verified,
                    "default_target": effective,
                    "target_strength": (
                        "verified"
                        if verified or (bool(row["locked"]) and effective)
                        else "working" if working else "unset"
                    ),
                    "description": str(row["description"] or ""),
                    "status": str(row["status"]),
                    "locked": bool(row["locked"]),
                    "forms": [],
                    "rules": [],
                    "verification_pending": False,
                },
            )
            item["forms"].append(str(row["form"]))
        if not concepts:
            return []
        placeholders = ",".join("?" for _ in concepts)
        for pending in connection.execute(
            f"""SELECT DISTINCT subject_id FROM verification_tasks
                WHERE subject_type='concept' AND status IN ('open','needs_human')
                  AND subject_id IN ({placeholders})""",
            list(concepts),
        ).fetchall():
            concept = concepts[str(pending["subject_id"])]
            if not concept["locked"]:
                concept["verification_pending"] = True
        for row in connection.execute(
            f"""SELECT id, concept_id, condition_json, target, priority,
                       status, locked
                FROM rendering_rules
                WHERE retired_version IS NULL AND concept_id IN ({placeholders})
                ORDER BY priority DESC, id""",
            list(concepts),
        ).fetchall():
            target = str(row["target"] or "").strip()
            if not target:
                continue
            rule_id = str(row["id"])
            condition = _safe_rule_condition(row["condition_json"], rule_id)
            concepts[str(row["concept_id"])]["rules"].append(
                {
                    "id": rule_id,
                    "condition": condition,
                    "target": target,
                    "priority": int(row["priority"]),
                    "status": str(row["status"]),
                    "locked": bool(row["locked"]),
                }
            )
        return list(concepts.values())

    def _render_snapshot_from_connection(
        self, connection: sqlite3.Connection
    ) -> List[Dict[str, Any]]:
        """Build the bounded lexeme-rooted rendering state with bulk SQL only."""

        rows = connection.execute(
            """SELECT l.id, l.language, l.normalized_form, l.canonical_form,
                      l.default_target, l.working_target, l.verified_target,
                      l.status, l.locked, l.created_version, l.created_at,
                      COALESCE(
                          (
                              SELECT cto.kind
                              FROM concept_type_observations cto
                              WHERE cto.lexeme_id=l.id
                                AND cto.retired_version IS NULL
                              ORDER BY
                                  CASE cto.source
                                      WHEN 'human' THEN 0
                                      WHEN 'verified' THEN 1
                                      ELSE 2
                                  END,
                                  cto.confidence DESC,
                                  cto.created_version DESC,
                                  cto.id DESC
                              LIMIT 1
                          ),
                          'concept'
                      ) resolved_kind,
                      sf.form, sf.normalized_form source_normalized_form
               FROM lexemes l
               LEFT JOIN source_forms sf ON sf.lexeme_id=l.id
               WHERE l.retired_version IS NULL
               ORDER BY lower(l.normalized_form), l.id,
                        lower(COALESCE(sf.form, l.canonical_form)),
                        COALESCE(sf.form, l.canonical_form), sf.id"""
        ).fetchall()
        lexemes: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            lexeme_id = str(row["id"])
            item = lexemes.setdefault(
                lexeme_id,
                {
                    "id": lexeme_id,
                    "lexeme_id": lexeme_id,
                    "language": str(row["language"]),
                    "normalized_form": str(row["normalized_form"]),
                    "source": str(row["canonical_form"]),
                    "kind": str(row["resolved_kind"] or "concept"),
                    "forms": [],
                    "default_target": str(row["default_target"] or "").strip(),
                    "working_target": str(row["working_target"] or "").strip(),
                    "verified_target": str(row["verified_target"] or "").strip(),
                    "status": str(row["status"]),
                    "locked": bool(row["locked"]),
                    "created_version": int(row["created_version"]),
                    "created_at": str(row["created_at"]),
                    "lexeme_rules": [],
                    # Stable flattened compatibility view; ownership remains explicit.
                    "rules": [],
                    "concepts": [],
                },
            )
            form = str(row["form"] or row["canonical_form"] or "").strip()
            if form and form not in item["forms"]:
                item["forms"].append(form)
        if not lexemes:
            return []

        term_profiles: Dict[tuple[str, str], Dict[str, Any]] = {}
        for row in connection.execute(
            """SELECT subject_type, subject_id, semantic_core,
                      contrast_sources_json, status, locked
               FROM term_profiles
               WHERE retired_version IS NULL
               ORDER BY subject_type, subject_id, locked DESC,
                        created_version DESC"""
        ).fetchall():
            key = (str(row["subject_type"]), str(row["subject_id"]))
            term_profiles.setdefault(key, self._term_profile_from_row(row))
        for lexeme_id, lexeme in lexemes.items():
            profile = term_profiles.get(("lexeme", lexeme_id))
            if profile is not None:
                lexeme["term_profile"] = profile

        concept_rows = connection.execute(
            """SELECT c.id, c.kind, c.canonical_source, c.default_target,
                      c.working_target, c.verified_target, c.description,
                      c.status, c.locked, c.created_version, c.created_at,
                      c.primary_lexeme_id, cl.lexeme_id, cl.role,
                      cl.confidence, cl.status binding_status,
                      kv.reason created_reason,
                      CASE WHEN c.locked=1 OR c.status='verified'
                                  OR c.verified_target!=''
                                  OR EXISTS(
                                      SELECT 1 FROM coreference_decisions cd
                                      WHERE cd.retired_version IS NULL
                                        AND cd.lexeme_id=cl.lexeme_id
                                        AND cd.relation='different'
                                        AND (cd.locked=1 OR cd.decision_source='human')
                                        AND (
                                            (cd.left_anchor_type='concept'
                                             AND cd.left_anchor_id=c.id)
                                            OR
                                            (cd.right_anchor_type='concept'
                                             AND cd.right_anchor_id=c.id)
                                        )
                                  )
                                  OR EXISTS(
                                      SELECT 1 FROM concept_type_observations cto
                                      WHERE cto.retired_version IS NULL
                                        AND cto.concept_id=c.id
                                        AND cto.source IN ('human','verified')
                                  )
                           THEN 1 ELSE 0 END concept_reliable,
                      CASE WHEN EXISTS(
                                      SELECT 1 FROM coreference_decisions cd
                                      WHERE cd.retired_version IS NULL
                                        AND cd.lexeme_id=cl.lexeme_id
                                        AND cd.relation='different'
                                        AND (cd.locked=1 OR cd.decision_source='human')
                                        AND (
                                            (cd.left_anchor_type='concept'
                                             AND cd.left_anchor_id=c.id)
                                            OR
                                            (cd.right_anchor_type='concept'
                                             AND cd.right_anchor_id=c.id)
                                        )
                                  )
                                  OR EXISTS(
                                      SELECT 1 FROM concept_type_observations cto
                                      WHERE cto.retired_version IS NULL
                                        AND cto.concept_id=c.id
                                        AND cto.source IN ('human','verified')
                                  )
                           THEN 1 ELSE 0 END different_evidence
                      ,CASE WHEN EXISTS(
                           SELECT 1 FROM verification_tasks vt
                           WHERE vt.subject_type='concept' AND vt.subject_id=c.id
                             AND vt.status IN ('open','needs_human')
                       ) THEN 1 ELSE 0 END verification_pending
               FROM concept_lexemes cl
               JOIN concepts c ON c.id=cl.concept_id
               JOIN knowledge_versions kv ON kv.id=c.created_version
               JOIN lexemes l ON l.id=cl.lexeme_id
               WHERE cl.retired_version IS NULL
                 AND c.retired_version IS NULL
                 AND l.retired_version IS NULL
               ORDER BY cl.lexeme_id, c.id, cl.role, cl.created_version"""
        ).fetchall()
        concepts_by_id: Dict[str, List[Dict[str, Any]]] = {}
        for row in concept_rows:
            lexeme_id = str(row["lexeme_id"])
            if lexeme_id not in lexemes:
                continue
            concept_reliable = bool(row["concept_reliable"])
            binding_reliable = (
                str(row["role"]) != "uncertain"
                and float(row["confidence"] or 0.0) >= 0.8
                and (
                    str(row["binding_status"]) == "verified"
                    or concept_reliable
                )
            )
            concept = {
                "id": str(row["id"]),
                "kind": str(row["kind"]),
                "source": str(row["canonical_source"]),
                "default_target": str(row["default_target"] or "").strip(),
                "working_target": str(row["working_target"] or "").strip(),
                "verified_target": str(row["verified_target"] or "").strip(),
                "description": str(row["description"] or ""),
                "status": str(row["status"]),
                "locked": bool(row["locked"]),
                "created_version": int(row["created_version"]),
                "created_at": str(row["created_at"]),
                "primary_lexeme_id": str(row["primary_lexeme_id"] or ""),
                "binding_lexeme_id": lexeme_id,
                "binding_role": str(row["role"]),
                "binding_status": str(row["binding_status"]),
                "binding_confidence": float(row["confidence"]),
                "binding_reliable": binding_reliable,
                "concept_reliable": concept_reliable,
                "different_evidence": bool(row["different_evidence"]),
                "verification_pending": (
                    bool(row["verification_pending"]) and not bool(row["locked"])
                ),
                "_created_reason": str(row["created_reason"] or ""),
                "redirect_source_ids": [],
                "rules": [],
            }
            profile = term_profiles.get(("concept", str(row["id"])))
            if profile is not None:
                concept["term_profile"] = profile
            lexemes[lexeme_id]["concepts"].append(concept)
            concepts_by_id.setdefault(str(row["id"]), []).append(concept)

        redirect_rows = connection.execute(
            """SELECT retired_concept_id, canonical_concept_id
               FROM concept_redirects
               ORDER BY retired_concept_id"""
        ).fetchall()
        redirects = {
            str(row["retired_concept_id"]): str(row["canonical_concept_id"])
            for row in redirect_rows
        }
        for source_id in sorted(redirects):
            current = source_id
            visited: set[str] = set()
            for _ in range(MAX_CONCEPT_REDIRECT_DEPTH + 1):
                if current in visited:
                    break
                visited.add(current)
                target = redirects.get(current)
                if target is None:
                    concepts = concepts_by_id.get(current, [])
                    if source_id != current:
                        for concept in concepts:
                            concept["redirect_source_ids"].append(source_id)
                    break
                current = target

        rule_rows = connection.execute(
            """SELECT rr.id, rr.lexeme_id, rr.concept_id, rr.condition_json,
                      rr.target, rr.priority, rr.status, rr.scope, rr.locked,
                      rr.created_version, rr.created_at
               FROM rendering_rules rr
               LEFT JOIN lexemes l ON l.id=rr.lexeme_id
               LEFT JOIN concepts c ON c.id=rr.concept_id
               WHERE rr.retired_version IS NULL
                 AND (
                     (rr.lexeme_id IS NOT NULL AND l.retired_version IS NULL)
                     OR
                     (rr.concept_id IS NOT NULL AND c.retired_version IS NULL)
                 )
               ORDER BY rr.priority DESC, rr.locked DESC, rr.status DESC,
                        rr.created_version DESC, rr.id"""
        ).fetchall()
        for row in rule_rows:
            rule_id = str(row["id"])
            condition = _safe_rule_condition(row["condition_json"], rule_id)
            rule = {
                "id": rule_id,
                "condition": condition,
                "target": str(row["target"] or "").strip(),
                "priority": int(row["priority"]),
                "status": str(row["status"]),
                "scope": str(row["scope"]),
                "locked": bool(row["locked"]),
                "created_version": int(row["created_version"]),
                "created_at": str(row["created_at"]),
            }
            if row["lexeme_id"] is not None:
                rule["subject_type"] = "lexeme"
                rule["subject_id"] = str(row["lexeme_id"])
                lexeme = lexemes.get(str(row["lexeme_id"]))
                if lexeme is not None:
                    lexeme["lexeme_rules"].append(rule)
                    lexeme["rules"].append(rule)
            else:
                rule["subject_type"] = "concept"
                rule["subject_id"] = str(row["concept_id"])
                concepts = concepts_by_id.get(str(row["concept_id"]), [])
                for concept in concepts:
                    concept["rules"].append(rule)
                    owner = lexemes.get(str(concept["binding_lexeme_id"]))
                    if owner is not None:
                        owner["rules"].append(rule)

        usage_rows = connection.execute(
            """SELECT ud.id, ud.rendering, ud.status, ud.scope, ud.locked,
                      ud.created_version, ud.created_at,
                      m.id mention_id, m.block_id, m.paragraph_id,
                      m.source_form, m.discourse_function, m.lexeme_id,
                      m.concept_id, e.payload_json,
                      fo.start_offset, fo.end_offset
               FROM usage_decisions ud
               JOIN mentions m ON m.id=ud.mention_id
               JOIN evidence e ON e.id=m.evidence_id
               JOIN lexemes l ON l.id=m.lexeme_id
               LEFT JOIN form_occurrences fo
                 ON fo.block_id=m.block_id
                AND fo.lexeme_id=m.lexeme_id
                AND fo.source_form=m.source_form
               WHERE ud.retired_version IS NULL
                 AND l.retired_version IS NULL
                 AND ud.locked=1
                 AND ud.scope IN ('occurrence','speaker','thread')
               ORDER BY ud.id, fo.start_offset, fo.end_offset"""
        ).fetchall()
        usage_groups: Dict[int, List[sqlite3.Row]] = {}
        for row in usage_rows:
            usage_groups.setdefault(int(row["id"]), []).append(row)
        for usage_id in sorted(usage_groups):
            grouped_rows = usage_groups[usage_id]
            row = grouped_rows[0]
            target = str(row["rendering"] or "").strip()
            lexeme_id = str(row["lexeme_id"])
            lexeme = lexemes.get(lexeme_id)
            if not target or lexeme is None:
                continue
            try:
                payload = json.loads(str(row["payload_json"] or "{}"))
            except (json.JSONDecodeError, TypeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            spans = sorted(
                {
                    (int(value["start_offset"]), int(value["end_offset"]))
                    for value in grouped_rows
                    if value["start_offset"] is not None
                }
            )
            payload_span: tuple[int, int] | None = None
            try:
                if (
                    payload.get("start_offset") is not None
                    and payload.get("end_offset") is not None
                ):
                    payload_span = (
                        int(payload["start_offset"]),
                        int(payload["end_offset"]),
                    )
            except (TypeError, ValueError):
                payload_span = None
            span = payload_span or (spans[0] if len(spans) == 1 else None)
            scope = str(row["scope"])
            if scope == "occurrence":
                if span is None:
                    continue
                condition: Dict[str, Any] = {
                    "mention_id": int(row["mention_id"]),
                    "block_id": str(row["block_id"]),
                    "paragraph_id": str(row["paragraph_id"]),
                    "discourse_function": str(row["discourse_function"]),
                    "start_offset": span[0],
                    "end_offset": span[1],
                }
            elif scope == "speaker":
                speaker_id = str(payload.get("speaker_id") or "").strip()
                if not speaker_id:
                    continue
                condition = {"speaker_id": speaker_id}
            elif scope == "thread":
                thread_id = str(payload.get("thread_id") or "").strip()
                if not thread_id:
                    continue
                condition = {"thread_id": thread_id}
            else:
                continue
            rule = {
                "id": f"usage:{usage_id}",
                "condition": condition,
                "target": target,
                "priority": 1_000_000,
                "status": str(row["status"]),
                "scope": str(row["scope"]),
                "locked": True,
                "created_version": int(row["created_version"]),
                "created_at": str(row["created_at"]),
                "subject_type": "lexeme",
                "subject_id": lexeme_id,
            }
            lexeme["lexeme_rules"].append(rule)
            lexeme["rules"].append(rule)

        for lexeme in lexemes.values():
            lexeme["forms"].sort(key=lambda value: (value.casefold(), value))
            lexeme["concepts"].sort(key=lambda item: str(item["id"]))
            for concept in lexeme["concepts"]:
                concept["redirect_source_ids"].sort()
            primary = next(
                (
                    concept
                    for concept in lexeme["concepts"]
                    if concept["primary_lexeme_id"] == lexeme["lexeme_id"]
                    and concept["binding_role"] == "primary"
                ),
                None,
            )
            if primary is not None:
                # ``id`` is the legacy concept-facing identity; lexeme ownership
                # remains explicit and authoritative in ``lexeme_id``.
                lexeme["id"] = primary["id"]
        filtered: List[Dict[str, Any]] = []
        for lexeme in lexemes.values():
            concepts = list(lexeme["concepts"])
            created_reasons = [
                str(concept.pop("_created_reason", "")) for concept in concepts
            ]
            proposal_only = bool(concepts) and all(
                reason.startswith("translation proposals ")
                and concept["status"] == "provisional"
                and not concept["locked"]
                and not concept["working_target"]
                and not concept["verified_target"]
                for reason, concept in zip(created_reasons, concepts)
            )
            if (
                proposal_only
                and not lexeme["working_target"]
                and not lexeme["verified_target"]
                and not lexeme["locked"]
            ):
                continue
            filtered.append(lexeme)
        return filtered

    def render_snapshot(self) -> List[Dict[str, Any]]:
        """Return stable, JSON-friendly active rendering knowledge."""

        connection = self.connect()
        try:
            connection.execute("BEGIN")
            return self._render_snapshot_from_connection(connection)
        finally:
            connection.rollback()
            connection.close()

    def rendering_contexts_for_block(self, block_id: str) -> List[Dict[str, Any]]:
        """Return persisted occurrence evidence used by rendering conditions."""

        return self.rendering_contexts_for_blocks([block_id]).get(str(block_id), [])

    def rendering_contexts_for_blocks(
        self, block_ids: Sequence[str]
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Batch-load immutable rendering contexts with one bounded SQL query."""

        ordered_ids = list(dict.fromkeys(str(value) for value in block_ids))
        with closing(self.connect()) as connection:
            return self._rendering_contexts_for_blocks_from_connection(
                connection, ordered_ids
            )

    def _rendering_contexts_for_blocks_from_connection(
        self,
        connection: sqlite3.Connection,
        block_ids: Sequence[str],
    ) -> Dict[str, List[Dict[str, Any]]]:
        ordered_ids = list(dict.fromkeys(str(value) for value in block_ids))
        grouped: Dict[str, List[Dict[str, Any]]] = {
            block_id: [] for block_id in ordered_ids
        }
        if not ordered_ids:
            return grouped
        placeholders = ",".join("?" for _ in ordered_ids)
        rows = connection.execute(
            f"""SELECT m.id mention_id, m.block_id, m.lexeme_id, m.concept_id,
                       m.evidence_id,
                           m.paragraph_id, m.source_form, m.discourse_function,
                           e.confidence, e.payload_json,
                           fo.start_offset, fo.end_offset
                    FROM mentions m
                    JOIN evidence e ON e.id=m.evidence_id
                    LEFT JOIN form_occurrences fo
                      ON fo.block_id=m.block_id
                     AND fo.lexeme_id=m.lexeme_id
                     AND fo.source_form=m.source_form
                    WHERE m.block_id IN ({placeholders})
                      AND e.kind!='translation_term'
                      AND e.extractor!='translate_v4'
                    ORDER BY m.block_id, m.id, fo.start_offset, fo.end_offset""",
            ordered_ids,
        ).fetchall()
        seen: Dict[str, set[str]] = {block_id: set() for block_id in ordered_ids}
        for row in rows:
            block_id = str(row["block_id"])
            try:
                payload = json.loads(str(row["payload_json"] or "{}"))
            except (json.JSONDecodeError, TypeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            payload_start = payload.get("start_offset")
            payload_end = payload.get("end_offset")
            try:
                payload_span = (
                    (int(payload_start), int(payload_end))
                    if payload_start is not None and payload_end is not None
                    else None
                )
            except (TypeError, ValueError):
                payload_span = None
            row_span = (
                (int(row["start_offset"]), int(row["end_offset"]))
                if row["start_offset"] is not None
                else None
            )
            if (
                payload_span is not None
                and row_span is not None
                and payload_span != row_span
            ):
                continue
            span = payload_span or row_span
            concept_id = str(row["concept_id"] or "")
            confidence = float(row["confidence"] or 0.0)
            context: Dict[str, Any] = {
                "block_id": block_id,
                "lexeme_id": str(row["lexeme_id"]),
                "source_form": str(row["source_form"]),
                "mention_id": int(row["mention_id"]),
                "evidence_id": int(row["evidence_id"]),
                "paragraph_id": str(row["paragraph_id"]),
                "paragraph": str(row["paragraph_id"]),
                "discourse_function": str(row["discourse_function"]),
                "mention": {
                    "id": int(row["mention_id"]),
                    "concept_id": concept_id,
                    "confidence": confidence,
                    "reliable": bool(concept_id) and confidence >= 0.8,
                },
            }
            if concept_id:
                context["concept_id"] = concept_id
            if span is not None:
                context["start_offset"], context["end_offset"] = span
            for key in ("speaker", "speaker_id", "thread", "thread_id"):
                if payload.get(key) not in (None, ""):
                    context[key] = payload[key]
            signature = json.dumps(
                context, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            if signature not in seen[block_id]:
                seen[block_id].add(signature)
                grouped[block_id].append(context)
        return grouped

    def concept_snapshot(self) -> List[Dict[str, Any]]:
        """Materialize active rendering state from one SQLite read snapshot."""

        connection = self.connect()
        try:
            connection.execute("BEGIN")
            return self._concept_snapshot_from_connection(connection)
        finally:
            connection.rollback()
            connection.close()

    def freeze_translation_knowledge(
        self,
    ) -> tuple[int, FrozenRenderIndex, str]:
        """Atomically freeze version and lexeme/concept rendering state."""

        connection = self.connect()
        try:
            connection.execute("BEGIN")
            version = int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
            # Preserve the historical read hook and its single-transaction view.
            self._concept_snapshot_from_connection(connection)
            snapshot = self._render_snapshot_from_connection(connection)
            frozen = FrozenRenderIndex.compile(
                snapshot, self.target_snapshot_signature
            )
            return version, frozen, frozen.signature
        finally:
            connection.rollback()
            connection.close()

    @staticmethod
    def _render_bundle_signature(
        knowledge_version: int,
        render_signature: str,
        contexts_by_block: Mapping[str, Sequence[Mapping[str, Any]]],
        claims_by_block: Mapping[str, Sequence[Mapping[str, Any]]],
        prior_concept_evidence_by_block: Mapping[
            str, Sequence[Mapping[str, Any]]
        ],
    ) -> str:
        payload = {
            "render_signature": str(render_signature),
            "contexts": {
                str(block_id): [dict(context) for context in contexts_by_block[block_id]]
                for block_id in sorted(contexts_by_block)
            },
            "claims": {
                str(block_id): [dict(claim) for claim in claims_by_block[block_id]]
                for block_id in sorted(claims_by_block)
            },
            "prior_concept_evidence": {
                str(block_id): [
                    dict(item)
                    for item in prior_concept_evidence_by_block[block_id]
                ]
                for block_id in sorted(prior_concept_evidence_by_block)
            },
        }
        raw = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _frozen_context_knowledge_from_connection(
        self,
        connection: sqlite3.Connection,
        block_ids: Sequence[str],
        index: FrozenRenderIndex,
        *,
        max_prior_chars: int = 3600,
        max_paragraphs_per_concept: int = 2,
    ) -> tuple[Dict[str, List[Dict[str, Any]]], Dict[str, List[Dict[str, Any]]]]:
        """Batch-load claims and grounded prior evidence from the K0 snapshot."""

        ordered_ids = list(dict.fromkeys(str(value) for value in block_ids))
        claims_by_block: Dict[str, List[Dict[str, Any]]] = {
            block_id: [] for block_id in ordered_ids
        }
        prior_by_block: Dict[str, List[Dict[str, Any]]] = {
            block_id: [] for block_id in ordered_ids
        }
        if not ordered_ids:
            return claims_by_block, prior_by_block
        placeholders = ",".join("?" for _ in ordered_ids)
        block_rows = connection.execute(
            f"""SELECT id, legacy_id, source_edition_id, global_index, source_text
                FROM blocks WHERE id IN ({placeholders})""",
            ordered_ids,
        ).fetchall()
        blocks = {str(row["id"]): row for row in block_rows}
        if len(blocks) != len(ordered_ids):
            raise KeyError("frozen context references a missing source block")

        maximum_reveal = max(int(row["global_index"]) for row in block_rows)
        claim_rows = connection.execute(
            """SELECT SUBSTR(id, 1, ?) id, LENGTH(id) id_length,
                      SUBSTR(kind, 1, ?) kind, LENGTH(kind) kind_length,
                      SUBSTR(statement, 1, ?) statement,
                      LENGTH(statement) statement_length,
                      SUBSTR(subject_form, 1, ?) subject_form,
                      LENGTH(subject_form) subject_form_length,
                      SUBSTR(status, 1, ?) status, LENGTH(status) status_length,
                      SUBSTR(scope, 1, ?) scope, LENGTH(scope) scope_length,
                      confidence, reveal_global_index, high_impact, locked,
                      retired_version
               FROM claims
               WHERE retired_version IS NULL
                 AND kind='translation_constraint'
                 AND status='verified'
                 AND reveal_global_index<=?
               ORDER BY locked DESC, confidence DESC, id
               LIMIT ?""",
            (
                MAX_FROZEN_CLAIM_ID_CHARS + 1,
                MAX_FROZEN_CLAIM_KIND_CHARS + 1,
                MAX_FROZEN_CLAIM_TEXT_CHARS + 1,
                MAX_FROZEN_CLAIM_TEXT_CHARS + 1,
                MAX_FROZEN_CLAIM_STATUS_CHARS + 1,
                MAX_FROZEN_CLAIM_SCOPE_CHARS + 1,
                maximum_reveal,
                MAX_FROZEN_CLAIMS + 1,
            ),
        ).fetchall()
        if len(claim_rows) > MAX_FROZEN_CLAIMS:
            raise KnowledgeSnapshotError(
                "claims", f"claim limit exceeds {MAX_FROZEN_CLAIMS}"
            )
        claim_payloads: Dict[str, Dict[str, Any]] = {}
        claim_bytes = 0
        for row in claim_rows:
            for field, limit in (
                ("id", MAX_FROZEN_CLAIM_ID_CHARS),
                ("kind", MAX_FROZEN_CLAIM_KIND_CHARS),
                ("statement", MAX_FROZEN_CLAIM_TEXT_CHARS),
                ("subject_form", MAX_FROZEN_CLAIM_TEXT_CHARS),
                ("status", MAX_FROZEN_CLAIM_STATUS_CHARS),
                ("scope", MAX_FROZEN_CLAIM_SCOPE_CHARS),
            ):
                if int(row[f"{field}_length"]) > limit:
                    raise KnowledgeSnapshotError(
                        "claims",
                        f"claim {field} exceeds {limit} characters",
                    )
            claim_id = str(row["id"])
            state = self._claim_state_from_row(row)
            payload = {
                "id": claim_id,
                "statement": str(row["statement"]),
                "subject_form": str(row["subject_form"]),
                "scope": str(row["scope"]),
                "reveal_global_index": int(row["reveal_global_index"]),
                "locked": bool(row["locked"]),
                "high_impact": bool(row["high_impact"]),
                "semantic_fingerprint": render_fingerprint(
                    "claim", claim_id, state
                ),
            }
            claim_bytes += len(
                json.dumps(
                    payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
            if claim_bytes > MAX_FROZEN_CLAIM_BYTES:
                raise KnowledgeSnapshotError(
                    "claims",
                    f"claim payload exceeds {MAX_FROZEN_CLAIM_BYTES} UTF-8 bytes",
                )
            claim_payloads[claim_id] = payload
        occurrence_blocks: Dict[str, set[str]] = {}
        if claim_rows:
            claim_ids = [str(row["id"]) for row in claim_rows]
            claim_placeholders = ",".join("?" for _ in claim_ids)
            for row in connection.execute(
                f"""SELECT ce.claim_id, e.block_id
                    FROM claim_evidence ce
                    JOIN evidence e ON e.id=ce.evidence_id
                    WHERE ce.claim_id IN ({claim_placeholders})""",
                claim_ids,
            ):
                occurrence_blocks.setdefault(str(row["claim_id"]), set()).add(
                    str(row["block_id"])
                )
        for block_id in ordered_ids:
            block = blocks[block_id]
            source_lower = str(block["source_text"]).lower()
            reveal_index = int(block["global_index"])
            matched_claims = [
                claim_payloads[str(claim["id"])]
                for claim in claim_rows
                if int(claim["reveal_global_index"]) <= reveal_index
                and (
                    (
                        str(claim["scope"]) == "occurrence"
                        and block_id
                        in occurrence_blocks.get(str(claim["id"]), set())
                    )
                    or (
                        str(claim["scope"]) != "occurrence"
                        and (
                            not str(claim["subject_form"])
                            or str(claim["subject_form"]).lower() in source_lower
                        )
                    )
                )
            ]
            if len(matched_claims) > MAX_FROZEN_CLAIMS_PER_BLOCK:
                raise KnowledgeSnapshotError(
                    "claims",
                    f"block {block_id} claim limit exceeds "
                    f"{MAX_FROZEN_CLAIMS_PER_BLOCK}",
                )
            claims_by_block[block_id] = matched_claims

        concepts_by_block: Dict[str, List[Dict[str, Any]]] = {}
        remaining_pairs = MAX_PRIOR_CONCEPT_PAIRS
        for block_id in ordered_ids:
            block_concepts = index.matched_concepts(
                str(blocks[block_id]["source_text"])
            )
            take = min(MAX_PRIOR_CONCEPTS_PER_BLOCK, remaining_pairs)
            concepts_by_block[block_id] = list(block_concepts[:take])
            remaining_pairs -= len(concepts_by_block[block_id])
        concept_pairs = [
            (block_id, str(concept["id"]))
            for block_id in ordered_ids
            for concept in concepts_by_block[block_id]
        ]
        if not concept_pairs or max_prior_chars <= 0 or max_paragraphs_per_concept <= 0:
            return claims_by_block, prior_by_block

        forms_by_pair: Dict[tuple[str, str], tuple[str, ...]] = {}
        for block_id in ordered_ids:
            for concept in concepts_by_block[block_id]:
                forms = tuple(
                    sorted(
                        {
                            str(form).strip()
                            for form in concept.get("forms", ())
                            if str(form).strip()
                        },
                        key=len,
                        reverse=True,
                    )
                )
                if len(forms) > MAX_DEPENDENCY_FORMS or sum(
                    len(form.encode("utf-8")) for form in forms
                ) > _RENDER_MAX_INPUT_BYTES:
                    raise KnowledgeSnapshotError(
                        "prior_evidence",
                        f"concept {concept['id']} source forms exceed bounds",
                    )
                forms_by_pair[(block_id, str(concept["id"]))] = forms

        encoded_pairs = json.dumps(
            concept_pairs, ensure_ascii=False, separators=(",", ":")
        )
        candidate_rows = connection.execute(
            """WITH pairs AS (
                   SELECT CAST(json_extract(value, '$[0]') AS TEXT) block_id,
                          CAST(json_extract(value, '$[1]') AS TEXT) concept_id
                   FROM json_each(?)
               ), candidate_blocks AS (
                   SELECT pairs.block_id target_block_id,
                          pairs.concept_id,
                          c.canonical_source concept_source,
                          prior.id prior_id,
                          prior.legacy_id,
                          prior.global_index,
                          SUBSTR(prior.source_text, 1, ?) source_text
                   FROM pairs
                   JOIN blocks target ON target.id=pairs.block_id
                   JOIN concepts c ON c.id=pairs.concept_id
                   JOIN blocks prior
                     ON prior.source_edition_id=target.source_edition_id
                    AND prior.global_index<target.global_index
                   WHERE EXISTS (
                       SELECT 1
                       FROM concept_lexemes cl
                       JOIN source_forms sf ON sf.lexeme_id=cl.lexeme_id
                       WHERE cl.concept_id=pairs.concept_id
                         AND cl.retired_version IS NULL
                         AND INSTR(LOWER(prior.source_text), LOWER(sf.form))>0
                   )
               ), ranked AS (
                   SELECT candidate_blocks.*,
                          ROW_NUMBER() OVER (
                              PARTITION BY target_block_id, concept_id
                              ORDER BY global_index, prior_id
                          ) first_rank,
                          ROW_NUMBER() OVER (
                              PARTITION BY target_block_id, concept_id
                              ORDER BY global_index DESC, prior_id DESC
                          ) last_rank
                   FROM candidate_blocks
               )
               SELECT target_block_id, concept_id, concept_source,
                      legacy_id, global_index, source_text
               FROM ranked
               WHERE first_rank<=? OR last_rank<=?
               ORDER BY target_block_id, concept_id, global_index, prior_id
               LIMIT ?""",
            (
                encoded_pairs,
                MAX_PRIOR_CANDIDATE_CHARS + 1,
                MAX_PRIOR_CANDIDATES_PER_CONCEPT,
                MAX_PRIOR_CANDIDATES_PER_CONCEPT,
                MAX_PRIOR_CANDIDATES_TOTAL + 1,
            ),
        ).fetchall()

        if len(candidate_rows) > MAX_PRIOR_CANDIDATES_TOTAL:
            raise KnowledgeSnapshotError(
                "prior_evidence",
                f"prior candidate limit exceeds {MAX_PRIOR_CANDIDATES_TOTAL}",
            )

        candidates_by_pair: Dict[tuple[str, str], List[Dict[str, Any]]] = {}
        for row in candidate_rows:
            pair = (str(row["target_block_id"]), str(row["concept_id"]))
            forms = forms_by_pair.get(pair, ())
            source_text = str(row["source_text"])
            if len(source_text) > MAX_PRIOR_CANDIDATE_CHARS:
                source_text = source_text[:MAX_PRIOR_CANDIDATE_CHARS]
            candidate = {
                "target_block_id": pair[0],
                "concept_id": pair[1],
                "concept_source": str(row["concept_source"]),
                "legacy_id": str(row["legacy_id"]),
                "global_index": int(row["global_index"]),
                "source_text": source_text,
            }
            patterns = tuple(
                re.compile(rf"(?<!\w){re.escape(form)}(?!\w)", re.IGNORECASE)
                for form in forms
            )
            for paragraph_index, paragraph in enumerate(
                part.strip()
                for part in re.split(
                    r"\n\s*\n", str(candidate["source_text"]).strip()
                )
                if part.strip()
            ):
                if any(pattern.search(paragraph) for pattern in patterns):
                    candidates_by_pair.setdefault(
                        (
                            str(candidate["target_block_id"]),
                            str(candidate["concept_id"]),
                        ),
                        [],
                    ).append(
                        {
                            "concept_id": str(candidate["concept_id"]),
                            "concept_source": str(candidate["concept_source"]),
                            "legacy_id": str(candidate["legacy_id"]),
                            "global_index": int(candidate["global_index"]),
                            "paragraph_id": f"P{paragraph_index:03d}",
                            "source_text": paragraph,
                        }
                    )

        for block_id in ordered_ids:
            results: List[Dict[str, Any]] = []
            seen_paragraphs: set[tuple[int, int]] = set()
            used_chars = 0
            exhausted = False
            for concept in concepts_by_block[block_id]:
                matches = sorted(
                    candidates_by_pair.get((block_id, str(concept["id"])), []),
                    key=lambda item: (
                        int(item["global_index"]), str(item["paragraph_id"])
                    ),
                )
                if not matches:
                    continue
                selected = [matches[0]]
                for candidate in reversed(matches[1:]):
                    if len(selected) >= max_paragraphs_per_concept:
                        break
                    selected.append(candidate)
                selected.sort(
                    key=lambda item: (
                        int(item["global_index"]), str(item["paragraph_id"])
                    )
                )
                for item in selected:
                    paragraph_key = (
                        int(item["global_index"]),
                        int(str(item["paragraph_id"])[1:]),
                    )
                    if paragraph_key in seen_paragraphs:
                        continue
                    remaining_chars = max_prior_chars - used_chars
                    if remaining_chars <= 0:
                        exhausted = True
                        break
                    bounded_item = dict(item)
                    bounded_item["source_text"] = str(item["source_text"])[
                        :remaining_chars
                    ]
                    added_chars = len(str(bounded_item["source_text"]))
                    if not added_chars:
                        exhausted = True
                        break
                    results.append(bounded_item)
                    seen_paragraphs.add(paragraph_key)
                    used_chars += added_chars
                    if used_chars >= max_prior_chars:
                        exhausted = True
                        break
                if exhausted:
                    break
            prior_by_block[block_id] = results
        return claims_by_block, prior_by_block

    def freeze_render_bundle(
        self, block_ids: Sequence[str]
    ) -> FrozenRenderBundle:
        """Freeze rendering knowledge and source contexts in one SQLite snapshot."""

        ordered_ids = tuple(dict.fromkeys(str(value) for value in block_ids))
        connection = self.connect()
        try:
            connection.execute("BEGIN")
            version = int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
            self._concept_snapshot_from_connection(connection)
            snapshot = self._render_snapshot_from_connection(connection)
            index = FrozenRenderIndex.compile(snapshot, self.target_snapshot_signature)
            contexts = self._rendering_contexts_for_blocks_from_connection(
                connection, ordered_ids
            )
            claims, prior_evidence = self._frozen_context_knowledge_from_connection(
                connection, ordered_ids, index
            )
            signature = self._render_bundle_signature(
                version, index.signature, contexts, claims, prior_evidence
            )
            immutable_contexts = MappingProxyType(
                {
                    block_id: tuple(
                        _immutable_render_value(context)
                        for context in contexts.get(block_id, [])
                    )
                    for block_id in ordered_ids
                }
            )
            immutable_claims = MappingProxyType(
                {
                    block_id: tuple(
                        _immutable_render_value(claim)
                        for claim in claims.get(block_id, [])
                    )
                    for block_id in ordered_ids
                }
            )
            immutable_prior_evidence = MappingProxyType(
                {
                    block_id: tuple(
                        _immutable_render_value(item)
                        for item in prior_evidence.get(block_id, [])
                    )
                    for block_id in ordered_ids
                }
            )
            return FrozenRenderBundle(
                knowledge_version=version,
                index=index,
                contexts_by_block=immutable_contexts,
                claims_by_block=immutable_claims,
                prior_concept_evidence_by_block=immutable_prior_evidence,
                signature=signature,
                render_signature=index.signature,
                block_ids=ordered_ids,
            )
        finally:
            connection.rollback()
            connection.close()

    def render_bundle_signature(self, block_ids: Sequence[str]) -> str:
        """Read the current combined render/context signature atomically."""

        ordered_ids = tuple(dict.fromkeys(str(value) for value in block_ids))
        connection = self.connect()
        try:
            connection.execute("BEGIN")
            version = int(
                connection.execute(
                    "SELECT MAX(id) FROM knowledge_versions"
                ).fetchone()[0]
            )
            snapshot = self._render_snapshot_from_connection(connection)
            index = FrozenRenderIndex.compile(snapshot, self.target_snapshot_signature)
            render_signature = index.signature
            contexts = self._rendering_contexts_for_blocks_from_connection(
                connection, ordered_ids
            )
            claims, prior_evidence = self._frozen_context_knowledge_from_connection(
                connection, ordered_ids, index
            )
            return self._render_bundle_signature(
                version, render_signature, contexts, claims, prior_evidence
            )
        finally:
            connection.rollback()
            connection.close()

    @staticmethod
    def target_snapshot_signature(snapshot: Sequence[Dict[str, Any]]) -> str:
        payload = sorted(
            (deepcopy(dict(item)) for item in snapshot),
            key=lambda item: str(item.get("lexeme_id") or item.get("id") or ""),
        )
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def concepts_for_text(
        self,
        text: str,
        concept_snapshot: Optional[Sequence[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        if isinstance(concept_snapshot, FrozenRenderIndex):
            return concept_snapshot.matched_concepts(text)
        snapshot = (
            list(concept_snapshot)
            if concept_snapshot is not None
            else self.render_snapshot()
        )
        signature = self.target_snapshot_signature(snapshot)
        return FrozenRenderIndex.compile(
            snapshot, lambda _snapshot: signature
        ).matched_concepts(text)

    def finish_translation_run_atomically(
        self,
        run_id: str,
        expected_signature: str,
        desired_status: str,
        error: Optional[str] = None,
        force_revalidate: bool = False,
        context_block_ids: Optional[Sequence[str]] = None,
    ) -> tuple[str, bool]:
        """Finalize after validating that the current knowledge snapshot is readable."""

        with self.transaction() as connection:
            self._concept_snapshot_from_connection(connection)
            snapshot = self._render_snapshot_from_connection(connection)
            index = FrozenRenderIndex.compile(snapshot, self.target_snapshot_signature)
            if context_block_ids is not None:
                self._rendering_contexts_for_blocks_from_connection(
                    connection, context_block_ids
                )
                self._frozen_context_knowledge_from_connection(
                    connection, context_block_ids, index
                )
            connection.execute(
                "UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?",
                (desired_status, utc_now(), error, run_id),
            )
            return desired_status, False

    def invalidate_translation_run(self, run_id: str) -> int:
        """Legacy no-op; revalidation requires explicit knowledge change IDs."""

        return 0

    def prior_concept_source_evidence(
        self,
        block: V4Block,
        concepts: Sequence[Dict[str, Any]],
        max_chars: int = 3600,
        max_paragraphs_per_concept: int = 2,
    ) -> List[Dict[str, Any]]:
        """Retrieve grounded prior paragraphs for concepts used by the current block.

        The earliest occurrence often defines a coined term; the latest occurrence
        shows its current use.  Keeping both is more reliable than asking a rolling
        plot summary to preserve every world-mechanism detail.
        """
        import re

        if not concepts or max_chars <= 0 or max_paragraphs_per_concept <= 0:
            return []
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT legacy_id, global_index, source_text
                   FROM blocks
                   WHERE source_edition_id=? AND global_index<?
                   ORDER BY global_index""",
                (block.source_edition_id, block.global_index),
            ).fetchall()

        results: List[Dict[str, Any]] = []
        seen_paragraphs: set[tuple[int, int]] = set()
        used_chars = 0
        for concept in concepts:
            forms = sorted(
                {str(form).strip() for form in concept.get("forms", []) if str(form).strip()},
                key=len,
                reverse=True,
            )
            if not forms:
                continue
            patterns = [
                re.compile(rf"(?<!\w){re.escape(form)}(?!\w)", re.IGNORECASE)
                for form in forms
            ]
            matches: List[Dict[str, Any]] = []
            for row in rows:
                paragraphs = [
                    part.strip()
                    for part in re.split(r"\n\s*\n", row["source_text"].strip())
                    if part.strip()
                ]
                for paragraph_index, paragraph in enumerate(paragraphs):
                    if any(pattern.search(paragraph) for pattern in patterns):
                        matches.append(
                            {
                                "concept_id": concept["id"],
                                "concept_source": concept["source"],
                                "legacy_id": row["legacy_id"],
                                "global_index": int(row["global_index"]),
                                "paragraph_id": f"P{paragraph_index:03d}",
                                "source_text": paragraph,
                            }
                        )
            if not matches:
                continue
            selected = [matches[0]]
            for candidate in reversed(matches[1:]):
                if len(selected) >= max_paragraphs_per_concept:
                    break
                selected.append(candidate)
            selected.sort(key=lambda item: (item["global_index"], item["paragraph_id"]))
            for item in selected:
                paragraph_key = (item["global_index"], int(item["paragraph_id"][1:]))
                if paragraph_key in seen_paragraphs:
                    continue
                added_chars = len(item["source_text"])
                if results and used_chars + added_chars > max_chars:
                    return results
                results.append(item)
                seen_paragraphs.add(paragraph_key)
                used_chars += added_chars
        return results

    def commit_translation_batch(
        self,
        run_id: str | None,
        outcomes: Sequence[TranslationOutcome],
        pipeline: str = "parallel_v4",
        audit_mode: str = "full",
        connection: sqlite3.Connection | None = None,
    ) -> None:
        if isinstance(outcomes, (str, bytes)) or not isinstance(outcomes, Sequence):
            raise TypeError("translation outcomes must be a sequence")
        ordered = sorted(
            (_snapshot_translation_outcome(outcome) for outcome in outcomes),
            key=lambda item: item.block.global_index,
        )
        with self._write(connection) as connection:
            versions = sorted({outcome.knowledge_version for outcome in ordered})
            if versions:
                placeholders = ",".join("?" for _ in versions)
                existing_versions = {
                    int(row[0])
                    for row in connection.execute(
                        f"SELECT id FROM knowledge_versions WHERE id IN ({placeholders})",
                        versions,
                    ).fetchall()
                }
                missing_versions = set(versions) - existing_versions
                if missing_versions:
                    raise ValueError(
                        f"unknown translation knowledge version: {min(missing_versions)}"
                    )
            if run_id:
                run = connection.execute(
                    "SELECT knowledge_version, config_json FROM runs WHERE id=?",
                    (run_id,),
                ).fetchone()
                if run is None:
                    raise ValueError(f"unknown translation run: {run_id}")
                run_version = int(run["knowledge_version"])
                if any(
                    outcome.knowledge_version != run_version for outcome in ordered
                ):
                    raise ValueError(
                        "translation outcome knowledge version does not match run knowledge version"
                    )
                try:
                    run_config = json.loads(str(run["config_json"] or "{}"))
                except json.JSONDecodeError as exc:
                    raise ValueError("translation run bundle config is invalid") from exc
                if not isinstance(run_config, dict):
                    raise ValueError("translation run bundle config must be a mapping")
                has_frozen_version = "frozen_knowledge_version" in run_config
                has_bundle_signature = "target_snapshot_signature" in run_config
                epoch_mode = bool(run_config.get("knowledge_epoch_mode"))
                if epoch_mode and has_bundle_signature:
                    raise ValueError(
                        "knowledge epoch runs may not use a global target signature"
                    )
                if not epoch_mode and (has_frozen_version or has_bundle_signature):
                    if not (has_frozen_version and has_bundle_signature):
                        raise ValueError("translation run frozen bundle config is incomplete")
                    try:
                        frozen_version = int(run_config["frozen_knowledge_version"])
                    except (TypeError, ValueError) as exc:
                        raise ValueError(
                            "translation run frozen bundle version is invalid"
                        ) from exc
                    signature = str(run_config["target_snapshot_signature"])
                    if frozen_version != run_version or re.fullmatch(
                        r"[0-9a-f]{64}", signature
                    ) is None:
                        raise ValueError(
                            "translation run frozen bundle version/signature is inconsistent"
                        )
            block_ids = list(dict.fromkeys(outcome.block.id for outcome in ordered))
            source_rows: Dict[str, sqlite3.Row] = {}
            if block_ids:
                placeholders = ",".join("?" for _ in block_ids)
                source_rows = {
                    str(row["id"]): row
                    for row in connection.execute(
                        f"""SELECT b.id, b.source_text, b.source_hash
                              FROM blocks b
                              JOIN source_editions se
                                ON se.id=b.source_edition_id AND se.active=1
                              WHERE b.id IN ({placeholders})""",
                        block_ids,
                    ).fetchall()
                }
            if len(source_rows) != len(block_ids):
                raise ValueError("translation batch references a non-active source block")
            for outcome in ordered:
                existing_active = connection.execute(
                    """SELECT id FROM translation_versions
                       WHERE block_id=? AND pipeline=? AND run_id=?""",
                    (outcome.block.id, pipeline, run_id),
                ).fetchone()
                if existing_active is not None:
                    continue
                source_row = source_rows[outcome.block.id]
                source_text = str(source_row["source_text"])
                if (
                    str(source_row["source_hash"]) != str(outcome.block.source_hash)
                    or source_text != str(outcome.block.source_text)
                ):
                    raise ValueError(
                        f"translation source drift for block {outcome.block.id}"
                    )
                stored_source_hash = str(source_row["source_hash"])
                if re.fullmatch(r"[0-9a-f]{64}", stored_source_hash) and (
                    hashlib.sha256(source_text.encode("utf-8")).hexdigest()
                    != stored_source_hash
                ):
                    raise ValueError(
                        f"translation source hash drift for block {outcome.block.id}"
                    )
                matches = tuple(outcome.matched_renderings or ())
                if matches:
                    computed_source_hash = hashlib.sha256(
                        source_text.encode("utf-8")
                    ).hexdigest()
                    if (
                        re.fullmatch(r"[0-9a-f]{64}", stored_source_hash) is None
                        or stored_source_hash != computed_source_hash
                        or re.fullmatch(
                            r"[0-9a-f]{64}", str(outcome.block.source_hash)
                        )
                        is None
                        or str(outcome.block.source_hash) != computed_source_hash
                    ):
                        raise ValueError(
                            f"translation source hash drift for block {outcome.block.id}"
                        )
                if len(matches) > MAX_TRANSLATION_MATCHES:
                    raise ValueError(
                        f"translation match snapshot exceeds {MAX_TRANSLATION_MATCHES} entries"
                    )
                dependency_groups: Dict[tuple[str, str], List[Any]] = {}
                for match in matches:
                    lexeme_id = str(match.lexeme_id or "").strip()
                    concept_id = str(match.concept_id or "").strip()
                    matched_form = str(match.matched_form or "")
                    rendered_target = str(match.rendered_target or "")
                    fingerprint = str(match.dependency_fingerprint or "")
                    start = int(match.start_offset)
                    end = int(match.end_offset)
                    if not lexeme_id or len(lexeme_id) > 256:
                        raise ValueError("translation match lexeme_id is invalid")
                    if len(concept_id) > 256:
                        raise ValueError("translation match concept_id is too long")
                    if len(matched_form) > _RENDER_MAX_STRING_CHARS:
                        raise ValueError("translation match form is too long")
                    if len(rendered_target) > _RENDER_MAX_STRING_CHARS:
                        raise ValueError("translation rendered target is too long")
                    if len(fingerprint) > 256:
                        raise ValueError("translation dependency fingerprint is too long")
                    if not 0 <= start < end <= len(source_text):
                        raise ValueError(
                            f"translation match span is outside block {outcome.block.id}"
                        )
                    source_form = source_text[start:end]
                    if (
                        unicodedata.normalize("NFKC", source_form)
                        != unicodedata.normalize("NFKC", matched_form)
                    ):
                        raise ValueError(
                            f"translation match source span drift for block {outcome.block.id}"
                        )
                    raw_rule_ids = match.applied_rule_ids or ()
                    if isinstance(raw_rule_ids, (str, bytes)):
                        raise ValueError("translation match rule IDs must be a sequence")
                    rule_ids = tuple(str(value).strip() for value in raw_rule_ids)
                    if (
                        len(rule_ids) > MAX_DEPENDENCY_RULE_IDS
                        or any(not value or len(value) > 256 for value in rule_ids)
                    ):
                        raise ValueError("translation match rule IDs are invalid")
                    dependency_groups.setdefault(("lexeme", lexeme_id), []).append(match)
                    if concept_id:
                        dependency_groups.setdefault(("concept", concept_id), []).append(match)
                    for rule_id in sorted(set(rule_ids)):
                        dependency_groups.setdefault(("rule", rule_id), []).append(match)
                narrative_dependency_rows: List[tuple[str, str]] = []
                if outcome.snapshot_id:
                    snapshot_row = connection.execute(
                        """SELECT * FROM narrative_snapshots WHERE id=?""",
                        (outcome.snapshot_id,),
                    ).fetchone()
                    if snapshot_row is None:
                        raise ValueError(
                            "translation narrative snapshot does not exist"
                        )
                    if (
                        str(snapshot_row["block_id"]) != outcome.block.id
                        or int(snapshot_row["knowledge_version"])
                        != outcome.knowledge_version
                        or int(snapshot_row["memory_version"])
                        != outcome.memory_version
                    ):
                        raise ValueError(
                            "translation narrative snapshot version mismatch"
                        )
                    visible_memory_ids = {
                        str(value)
                        for value in json.loads(
                            snapshot_row["visible_memory_ids_json"] or "[]"
                        )
                    }
                    expected_discourse_hash = hashlib.sha256(
                        str(snapshot_row["discourse_state_json"]).encode(
                            "utf-8"
                        )
                    ).hexdigest()
                    if (
                        outcome.discourse_state_hash
                        != expected_discourse_hash
                    ):
                        raise ValueError(
                            "translation discourse state hash mismatch"
                        )
                    if re.fullmatch(
                        r"[0-9a-f]{64}", outcome.context_hash
                    ) is None:
                        raise ValueError(
                            "translation context hash is invalid"
                        )
                    for dependency in outcome.narrative_dependencies:
                        memory_id = str(dependency.memory_id).strip()
                        fingerprint = str(
                            dependency.semantic_fingerprint
                        ).strip()
                        if memory_id not in visible_memory_ids:
                            raise ValueError(
                                "translation narrative dependency is not visible"
                            )
                        row = connection.execute(
                            """SELECT semantic_fingerprint
                               FROM narrative_memories WHERE id=?""",
                            (memory_id,),
                        ).fetchone()
                        if (
                            row is None
                            or str(row["semantic_fingerprint"])
                            != fingerprint
                        ):
                            raise ValueError(
                                "translation narrative dependency fingerprint mismatch"
                            )
                        narrative_dependency_rows.append(
                            (memory_id, fingerprint)
                        )
                elif outcome.narrative_dependencies:
                    raise ValueError(
                        "translation narrative dependencies require a snapshot"
                    )
                if outcome.style_snapshot_id:
                    style_exists = connection.execute(
                        "SELECT 1 FROM style_snapshots WHERE id=?",
                        (outcome.style_snapshot_id,),
                    ).fetchone()
                    if style_exists is None:
                        raise ValueError(
                            "translation style snapshot does not exist"
                        )
                if pipeline == "parallel_v4":
                    previous_vote = connection.execute(
                        "SELECT * FROM comparison_votes WHERE block_id=?",
                        (outcome.block.id,),
                    ).fetchone()
                    if previous_vote is not None:
                        self._archive_comparison_vote(
                            connection, previous_vote, utc_now()
                        )
                connection.execute(
                    "UPDATE translation_versions SET active=0 WHERE block_id=? AND pipeline=? AND active=1",
                    (outcome.block.id, pipeline),
                )
                cursor = connection.execute(
                    """INSERT INTO translation_versions(
                           block_id, pipeline, run_id, knowledge_version, status,
                           draft_translation, final_translation, analysis,
                           semantic_obligations, memory_summary, warnings_json,
                           memory_version, snapshot_id, context_hash,
                           style_snapshot_id, discourse_state_hash,
                           active, created_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                ?, 1, ?)""",
                    (
                        outcome.block.id, pipeline, run_id, outcome.knowledge_version,
                        outcome.status, outcome.draft_translation, outcome.final_translation,
                        outcome.analysis, outcome.semantic_obligations,
                        outcome.memory_summary,
                        json.dumps(
                            _mutable_render_value(outcome.warnings),
                            ensure_ascii=False,
                        ),
                        outcome.memory_version,
                        outcome.snapshot_id or None,
                        outcome.context_hash,
                        outcome.style_snapshot_id or None,
                        outcome.discourse_state_hash,
                        utc_now(),
                    ),
                )
                translation_id = int(cursor.lastrowid)
                dependency_rows: List[tuple[Any, ...]] = []
                for (dependency_type, dependency_id), group in sorted(
                    dependency_groups.items()
                ):
                    details = _dependency_row(
                        dependency_type, dependency_id, group
                    )
                    dependency_rows.append(
                        (
                            translation_id,
                            dependency_type,
                            dependency_id,
                            outcome.knowledge_version,
                            *details,
                        )
                    )
                if not matches:
                    for concept_id in sorted(set(outcome.matched_concept_ids)):
                        concept_id = str(concept_id).strip()
                        if not concept_id or len(concept_id) > 256:
                            raise ValueError("legacy concept dependency ID is invalid")
                        fingerprint = hashlib.sha256(
                            json.dumps(
                                {
                                    "dependency_type": "concept",
                                    "dependency_id": concept_id,
                                },
                                sort_keys=True,
                                separators=(",", ":"),
                            ).encode("utf-8")
                        ).hexdigest()
                        dependency_rows.append(
                            (
                                translation_id,
                                "concept",
                                concept_id,
                                outcome.knowledge_version,
                                fingerprint,
                                "",
                                0,
                                "",
                                "[]",
                                "[]",
                            )
                        )
                claim_snapshots = {
                    (snapshot.claim_id, snapshot.semantic_fingerprint)
                    for snapshot in outcome.claim_dependencies
                }
                for claim_id, fingerprint in sorted(claim_snapshots):
                    claim_id = str(claim_id).strip()
                    if not claim_id or len(claim_id) > 256:
                        raise ValueError("claim dependency ID is invalid")
                    if re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
                        raise ValueError("claim dependency fingerprint is invalid")
                    dependency_rows.append(
                        (
                            translation_id,
                            "claim",
                            claim_id,
                            outcome.knowledge_version,
                            fingerprint,
                            "",
                            0,
                            "",
                            "[]",
                            "[]",
                        )
                    )
                for memory_id, fingerprint in sorted(
                    set(narrative_dependency_rows)
                ):
                    dependency_rows.append(
                        (
                            translation_id,
                            "narrative_memory",
                            memory_id,
                            outcome.knowledge_version,
                            fingerprint,
                            "",
                            0,
                            "",
                            "[]",
                            "[]",
                        )
                    )
                if outcome.style_anchor_id:
                    dependency_rows.append(
                        (
                            translation_id,
                            "style_anchor",
                            outcome.style_anchor_id,
                            outcome.knowledge_version,
                            hashlib.sha256(
                                outcome.style_anchor_id.encode("utf-8")
                            ).hexdigest(),
                            "",
                            0,
                            "",
                            "[]",
                            "[]",
                        )
                    )
                if outcome.snapshot_id:
                    dependency_rows.extend(
                        [
                            (
                                translation_id,
                                "narrative_snapshot",
                                outcome.snapshot_id,
                                outcome.knowledge_version,
                                str(snapshot_row["snapshot_hash"]),
                                "",
                                0,
                                "",
                                "[]",
                                "[]",
                            ),
                            (
                                translation_id,
                                "discourse_state",
                                outcome.snapshot_id,
                                outcome.knowledge_version,
                                outcome.discourse_state_hash,
                                "",
                                0,
                                "",
                                "[]",
                                "[]",
                            ),
                        ]
                    )
                if outcome.style_snapshot_id:
                    style_row = connection.execute(
                        """SELECT state_hash FROM style_snapshots WHERE id=?""",
                        (outcome.style_snapshot_id,),
                    ).fetchone()
                    dependency_rows.append(
                        (
                            translation_id,
                            "style_snapshot",
                            outcome.style_snapshot_id,
                            outcome.knowledge_version,
                            str(style_row["state_hash"]),
                            "",
                            0,
                            "",
                            "[]",
                            "[]",
                        )
                    )
                if dependency_rows:
                    connection.executemany(
                        """INSERT INTO dependencies(
                               translation_id, dependency_type, dependency_id,
                               knowledge_version, dependency_fingerprint,
                               matched_form, occurrence_count, rendered_target,
                               applied_rule_ids_json, source_spans_json)
                           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        dependency_rows,
                    )
                for audit in outcome.audit_calls:
                    thawed_audit = _mutable_render_value(audit)
                    audit_request, audit_raw, audit_parsed = self._audit_fields(
                        audit_mode,
                        dict(thawed_audit.get("request") or {}),
                        str(thawed_audit.get("raw_response") or ""),
                        thawed_audit.get("parsed"),
                    )
                    self.record_audit_call(
                        run_id=run_id,
                        block_id=outcome.block.id,
                        purpose=str(thawed_audit.get("purpose") or "translate"),
                        model=str(thawed_audit.get("model") or "unknown"),
                        knowledge_version=outcome.knowledge_version,
                        request=audit_request,
                        raw_response=audit_raw,
                        parsed=audit_parsed,
                        accepted=bool(
                            thawed_audit.get(
                                "accepted",
                                outcome.status
                                in {
                                    V4BlockStatus.COMPLETED.value,
                                    V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                                },
                            )
                        ),
                        attempts=int(thawed_audit.get("attempts") or 1),
                        elapsed_ms=int(thawed_audit.get("elapsed_ms") or 0),
                        error=thawed_audit.get("error") or outcome.error,
                        connection=connection,
                    )
                connection.execute(
                    "UPDATE blocks SET status=?, last_error=?, updated_at=? WHERE id=?",
                    (outcome.status, outcome.error, utc_now(), outcome.block.id),
                )
                if outcome.status == V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value:
                    connection.execute(
                        """INSERT INTO human_queue(
                               block_id, kind, severity, payload_json, created_at
                           ) VALUES(?, 'context_overflow', 'blocking', ?, ?)""",
                        (
                            outcome.block.id,
                            json.dumps({"error": outcome.error}, ensure_ascii=False),
                            utc_now(),
                        ),
                    )

    def commit_translation_proposals(
        self,
        run_id: str,
        outcomes: Sequence[TranslationOutcome],
        enqueue_review: bool = False,
        return_change_ids: bool = False,
        connection: sqlite3.Connection | None = None,
    ) -> Optional[int] | Dict[str, Any]:
        proposals = [
            (outcome, "term", payload)
            for outcome in outcomes
            for payload in outcome.term_proposals
            if payload.get("src")
        ] + [
            (outcome, "relation", payload)
            for outcome in outcomes
            for payload in outcome.relation_proposals
        ]
        if not proposals:
            return (
                {"knowledge_version": None, "change_ids": []}
                if return_change_ids
                else None
            )
        proposals.sort(key=lambda item: (item[0].block.global_index, item[1], json.dumps(item[2], sort_keys=True)))
        with self._write(connection) as connection:
            material_terms: Dict[str, tuple[str, str]] = {}
            for _, kind, payload in proposals:
                if kind != "term":
                    continue
                source = str(payload.get("src") or "").strip()
                normalized = normalize_english_form(source)
                target = str(payload.get("tgt") or "").strip()
                concept_id = stable_id("concept", normalized)
                existing = connection.execute(
                    """SELECT default_target, locked FROM concepts
                       WHERE id=? AND retired_version IS NULL""",
                    (concept_id,),
                ).fetchone()
                if existing is None or (
                    target
                    and str(existing["default_target"] or "") != target
                    and not bool(existing["locked"])
                ):
                    material_terms[concept_id] = (source, target)
            version = (
                self.create_knowledge_version(f"translation proposals {run_id}", connection)
                if material_terms
                else int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            )
            has_novel_proposal = False
            changed_concepts: set[str] = set()
            change_ids: list[int] = []
            old_render_states: Dict[str, Dict[str, Any]] = {}
            proposed_concepts: set[str] = set()
            seen_proposal_keys: set[tuple[str, str, str]] = set()
            for outcome, kind, payload in proposals:
                payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
                if kind == "term":
                    source = str(payload.get("src") or "").strip()
                    normalized = normalize_english_form(source)
                    concept_id = stable_id("concept", normalized)
                    proposed_concepts.add(concept_id)
                    target = str(payload.get("tgt") or "").strip()
                    quote = source if source in outcome.block.source_text else source
                    existing_concept = connection.execute(
                        """SELECT default_target, locked FROM concepts
                           WHERE id=? AND retired_version IS NULL""",
                        (concept_id,),
                    ).fetchone()
                    existing_evidence = connection.execute(
                        """SELECT 1 FROM evidence
                           WHERE kind='translation_term'
                             AND LOWER(source_form)=LOWER(?) AND payload_json=? LIMIT 1""",
                        (source, payload_json),
                    ).fetchone()
                    proposal_key = ("term", concept_id, target)
                    changes_decision = (
                        existing_concept is None
                        or (
                            bool(target)
                            and existing_concept["default_target"] != target
                            and not bool(existing_concept["locked"])
                        )
                    )
                    novel = (
                        changes_decision
                        and proposal_key not in seen_proposal_keys
                        and existing_evidence is None
                    )
                    seen_proposal_keys.add(proposal_key)
                    has_novel_proposal = has_novel_proposal or novel
                    if concept_id in material_terms:
                        old_render_states.setdefault(
                            concept_id,
                            self._render_state_for_subject(
                                connection, "concept", concept_id
                            ),
                        )
                    cursor = connection.execute(
                        """INSERT INTO evidence(
                               block_id, paragraph_id, kind, source_form, evidence_quote,
                               payload_json, confidence, extractor, run_id, created_at
                           ) VALUES(?, 'P000', 'translation_term', ?, ?, ?, 0.5,
                                    'translate_v4', ?, ?)""",
                        (
                            outcome.block.id, source, quote,
                            payload_json, run_id, utc_now(),
                        ),
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO concepts(
                               id, kind, canonical_source, default_target, description,
                               status, scope, locked, created_version, created_at
                           ) VALUES(?, ?, ?, ?, ?, 'provisional', 'book', 0, ?, ?)""",
                        (
                            concept_id, payload.get("type") or "concept", source,
                            payload.get("tgt") or "", payload.get("context") or "",
                            version, utc_now(),
                        ),
                    )
                    if target:
                        connection.execute(
                            """UPDATE concepts
                               SET default_target=?
                               WHERE id=? AND locked=0""",
                            (target, concept_id),
                        )
                    if concept_id in material_terms:
                        changed_concepts.add(concept_id)
                    lexeme_id = self._ensure_schema8_lexeme(
                        connection,
                        source,
                        normalized_form=normalized,
                        concept_id=concept_id,
                        knowledge_version=version,
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO source_forms(
                               lexeme_id, form, normalized_form, grammar_json
                           ) VALUES(?, ?, ?, '{}')""",
                        (lexeme_id, source, normalized),
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO mentions(
                               block_id, paragraph_id, source_form, normalized_form,
                               discourse_function, lexeme_id, concept_id, evidence_id
                           ) VALUES(?, 'P000', ?, ?, 'unknown', ?, ?, ?)""",
                        (
                            outcome.block.id,
                            source,
                            normalized,
                            lexeme_id,
                            concept_id,
                            int(cursor.lastrowid),
                        ),
                    )
                else:
                    quote = str(payload.get("context") or payload.get("sub") or "relation")
                    existing_evidence = connection.execute(
                        """SELECT 1 FROM evidence
                           WHERE kind='translation_relation' AND payload_json=? LIMIT 1""",
                        (payload_json,),
                    ).fetchone()
                    proposal_key = ("relation", payload_json, "")
                    novel = proposal_key not in seen_proposal_keys and existing_evidence is None
                    seen_proposal_keys.add(proposal_key)
                    has_novel_proposal = has_novel_proposal or novel
                    connection.execute(
                        """INSERT INTO evidence(
                               block_id, paragraph_id, kind, evidence_quote, payload_json,
                               confidence, extractor, run_id, created_at
                           ) VALUES(?, 'P000', 'translation_relation', ?, ?, 0.5,
                                    'translate_v4', ?, ?)""",
                        (
                            outcome.block.id,
                            quote, payload_json, run_id, utc_now(),
                        ),
                    )
                if enqueue_review and novel:
                    connection.execute(
                        """INSERT INTO human_queue(
                               block_id, kind, severity, payload_json, created_at
                           ) VALUES(?, 'translation_proposal', 'review', ?, ?)""",
                        (
                            outcome.block.id,
                            json.dumps(
                                {"proposal_kind": kind, "payload": payload},
                                ensure_ascii=False,
                            ),
                            utc_now(),
                        ),
                    )
            for concept_id in sorted(changed_concepts):
                change = self.record_render_change(
                    connection,
                    subject_type="concept",
                    subject_id=concept_id,
                    old_state=old_render_states.get(concept_id, {}),
                    new_state=self._render_state_for_subject(
                        connection, "concept", concept_id
                    ),
                    change_kind="proposal",
                    reason=f"translation proposals {run_id}",
                    knowledge_version=version,
                )
                if change["change_id"] is not None:
                    change_ids.append(int(change["change_id"]))
            if proposed_concepts:
                for concept_id in sorted(proposed_concepts):
                    concept = connection.execute(
                        """SELECT id, canonical_source, default_target, locked
                           FROM concepts WHERE id=? AND retired_version IS NULL""",
                        (concept_id,),
                    ).fetchone()
                    if concept is None or not concept["default_target"]:
                        continue
                    affected_blocks = int(
                        connection.execute(
                            """SELECT COUNT(DISTINCT occurrence.block_id)
                               FROM form_occurrences occurrence
                               JOIN concept_lexemes ownership
                                 ON ownership.lexeme_id=occurrence.lexeme_id
                                AND ownership.retired_version IS NULL
                               JOIN blocks block ON block.id=occurrence.block_id
                               JOIN source_editions edition
                                 ON edition.id=block.source_edition_id
                                AND edition.active=1
                               WHERE ownership.concept_id=?""",
                            (concept_id,),
                        ).fetchone()[0]
                    )
                    targets = {
                        row["target"]
                        for row in connection.execute(
                            """SELECT target FROM rendering_rules
                               WHERE concept_id=? AND retired_version IS NULL AND target!=''""",
                            (concept_id,),
                        )
                    }
                    for row in connection.execute(
                        """SELECT payload_json FROM evidence
                           WHERE kind='translation_term' AND source_form IS NOT NULL"""
                    ):
                        candidate = json.loads(row["payload_json"])
                        if normalize_english_form(str(candidate.get("src") or "")) == normalize_english_form(
                            concept["canonical_source"]
                        ) and candidate.get("tgt"):
                            targets.add(str(candidate["tgt"]))
                    high_impact = (
                        affected_blocks >= 3
                        or len(targets) > 1
                        or bool(concept["locked"])
                    )
                    if not high_impact:
                        continue
                    evidence_payload = [
                        {
                            "legacy_id": outcome.block.id,
                            "evidence_quote": str(payload.get("src") or ""),
                            "payload": payload,
                        }
                        for outcome, kind, payload in proposals
                        if kind == "term"
                        and normalize_english_form(str(payload.get("src") or ""))
                        == normalize_english_form(concept["canonical_source"])
                    ]
                    task_payload = {
                        "source": concept["canonical_source"],
                        "target": concept["default_target"],
                        "affected_blocks": affected_blocks,
                        "target_conflict": len(targets) > 1,
                        "evidence": evidence_payload,
                    }
                    task_id = stable_id(
                        "verify",
                        f"concept:{concept_id}:{json.dumps(task_payload, sort_keys=True)}",
                        length=24,
                    )
                    connection.execute(
                        """INSERT OR IGNORE INTO verification_tasks(
                               id, subject_type, subject_id, payload_json, status,
                               required_votes, created_at
                           ) VALUES(?, 'concept', ?, ?, 'open', 2, ?)""",
                        (
                            task_id,
                            concept_id,
                            json.dumps(task_payload, ensure_ascii=False, sort_keys=True),
                            utc_now(),
                        ),
                    )
            result_version = version if has_novel_proposal else None
            if return_change_ids:
                return {
                    "knowledge_version": result_version,
                    "change_ids": sorted(set(change_ids)) if has_novel_proposal else [],
                }
            return result_version

    def active_translations(self, pipeline: str = "parallel_v4") -> Dict[str, Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT * FROM translation_versions
                   WHERE pipeline=? AND active=1 ORDER BY block_id""",
                (pipeline,),
            ).fetchall()
            return {row["block_id"]: dict(row) for row in rows}

    def list_baseline_documents(self) -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT * FROM baseline_documents
                   WHERE source_edition_id=(SELECT id FROM source_editions WHERE active=1)
                   ORDER BY active DESC, created_at DESC"""
            ).fetchall()
            return [dict(row) for row in rows]

    def baseline_for_block(
        self,
        block_id: str,
        baseline_name: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            params: List[Any] = [block_id]
            name_clause = ""
            if baseline_name:
                name_clause = " AND d.name=?"
                params.append(baseline_name)
            document = connection.execute(
                f"""SELECT d.* FROM baseline_documents d
                    JOIN block_baseline_links l ON l.baseline_document_id=d.id
                    WHERE l.block_id=? AND d.active=1{name_clause}
                    ORDER BY d.created_at DESC LIMIT 1""",
                params,
            ).fetchone()
            if document is None:
                return None
            paragraphs = connection.execute(
                """SELECT p.paragraph_index, p.target_text, l.partial_start,
                          l.partial_end, l.alignment_status
                   FROM block_baseline_links l
                   JOIN baseline_paragraphs p
                     ON p.baseline_document_id=l.baseline_document_id
                    AND p.paragraph_index=l.paragraph_index
                   WHERE l.block_id=? AND l.baseline_document_id=?
                   ORDER BY l.ordinal""",
                (block_id, document["id"]),
            ).fetchall()
            return {
                "document": dict(document),
                "paragraphs": [dict(row) for row in paragraphs],
                "text": "\n\n".join(row["target_text"] for row in paragraphs),
                "has_partial_boundary": any(
                    row["partial_start"] or row["partial_end"] for row in paragraphs
                ),
                "has_ambiguous_alignment": any(
                    row["alignment_status"] != "exact" for row in paragraphs
                ),
            }

    def comparison_reference_for_block(
        self,
        block_id: str,
        baseline_name: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """返回与当前文本块严格对齐的外部基线或串行译文。"""
        baseline = self.baseline_for_block(block_id, baseline_name)
        if (
            baseline
            and not baseline.get("has_partial_boundary")
            and not baseline.get("has_ambiguous_alignment")
            and str(baseline.get("text") or "").strip()
        ):
            return {
                "origin": baseline["document"]["name"],
                "text": str(baseline["text"]).strip(),
            }
        with closing(self.connect()) as connection:
            row = connection.execute(
                """SELECT final_translation FROM translation_versions
                   WHERE block_id=? AND pipeline='serial_v3' AND active=1
                     AND final_translation!=''
                   ORDER BY id DESC LIMIT 1""",
                (block_id,),
            ).fetchone()
        if row is None:
            return None
        return {"origin": "serial_v3", "text": row["final_translation"].strip()}

    def create_claim(
        self,
        kind: str,
        statement: str,
        reveal_global_index: int,
        subject_form: str = "",
        scope: str = "book",
        confidence: float = 0.5,
        high_impact: bool = False,
        status: str = "proposed",
        locked: bool = False,
        return_change_ids: bool = False,
    ) -> str | Dict[str, Any]:
        if kind not in {
            "translation_constraint",
            "temporal_constraint",
            "identity_hypothesis",
            "reveal_boundary",
            "interpretation_hypothesis",
        }:
            raise ValueError("不支持的claim类型")
        if scope not in {"book", "occurrence"}:
            raise ValueError("claim scope必须是book或occurrence")
        if status not in {"proposed", "disputed", "verified", "rejected"}:
            raise ValueError("不支持的claim状态")
        if status == "verified" and not locked:
            raise ValueError("直接创建verified claim时必须同时人工锁定")
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("claim confidence必须位于0到1之间")
        if reveal_global_index < 0:
            raise ValueError("reveal_global_index不能为负数")
        high_impact = high_impact or kind in {
            "temporal_constraint",
            "identity_hypothesis",
            "reveal_boundary",
        }
        claim_id = stable_id(
            "claim",
            f"{kind}:{scope}:{reveal_global_index}:{subject_form}:{statement}",
            length=24,
        )
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT * FROM claims WHERE id=?", (claim_id,)
            ).fetchone()
            if existing is not None and (
                str(existing["kind"]) == kind
                and str(existing["statement"]) == statement
                and str(existing["subject_form"]) == subject_form
                and str(existing["status"]) == status
                and str(existing["scope"]) == scope
                and float(existing["confidence"]) == float(confidence)
                and int(existing["reveal_global_index"]) == reveal_global_index
                and bool(existing["high_impact"]) == bool(high_impact)
                and bool(existing["locked"]) == bool(locked)
                and existing["retired_version"] is None
            ):
                return (
                    {"claim_id": claim_id, "change_ids": []}
                    if return_change_ids
                    else claim_id
                )
            old_state = self._claim_state_for_subject(connection, claim_id)
            version = self.create_knowledge_version("create claim", connection)
            if existing is None:
                connection.execute(
                    """INSERT INTO claims(
                       id, kind, statement, subject_form, status, scope, confidence,
                       reveal_global_index, high_impact, locked, created_version, created_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        claim_id,
                        kind,
                        statement,
                        subject_form,
                        status,
                        scope,
                        confidence,
                        reveal_global_index,
                        int(high_impact),
                        int(locked),
                        version,
                        utc_now(),
                    ),
                )
            else:
                connection.execute(
                    """UPDATE claims SET status=?, confidence=?, high_impact=?,
                              locked=?, retired_version=NULL
                       WHERE id=?""",
                    (
                        status,
                        confidence,
                        int(high_impact),
                        int(locked),
                        claim_id,
                    ),
                )
            new_state = self._claim_state_for_subject(connection, claim_id)
            change = self.record_render_change(
                connection,
                subject_type="claim",
                subject_id=claim_id,
                old_state=old_state,
                new_state=new_state,
                change_kind="claim",
                reason="create claim",
                knowledge_version=version,
                record_metadata=True,
            )
            change_ids = (
                [int(change["change_id"])]
                if change["change_id"] is not None
                else []
            )
            if (high_impact or kind == "translation_constraint") and status in {
                "proposed",
                "disputed",
            }:
                task_id = stable_id("verify", f"claim:{claim_id}", length=24)
                connection.execute(
                    """INSERT OR IGNORE INTO verification_tasks(
                           id, subject_type, subject_id, payload_json, status,
                           required_votes, created_at
                       ) VALUES(?, 'claim', ?, ?, 'open', 2, ?)""",
                    (
                        task_id,
                        claim_id,
                        json.dumps(
                            {
                                "kind": kind,
                                "statement": statement,
                                "subject_form": subject_form,
                                "reveal_global_index": reveal_global_index,
                                "evidence": [],
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        utc_now(),
                    ),
                )
        if return_change_ids:
            return {"claim_id": claim_id, "change_ids": change_ids}
        return claim_id

    def list_claims(self, include_retired: bool = False) -> List[Dict[str, Any]]:
        query = "SELECT * FROM claims"
        if not include_retired:
            query += " WHERE retired_version IS NULL"
        query += " ORDER BY reveal_global_index, created_at"
        with closing(self.connect()) as connection:
            return [dict(row) for row in connection.execute(query)]

    def claims_for_block(self, block: V4Block) -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT DISTINCT c.*
                   FROM claims c
                   LEFT JOIN claim_evidence ce ON ce.claim_id=c.id
                   LEFT JOIN evidence e ON e.id=ce.evidence_id
                   WHERE c.retired_version IS NULL
                     AND c.kind='translation_constraint'
                     AND c.status='verified'
                     AND c.reveal_global_index<=?
                     AND (
                         (c.scope='occurrence' AND e.block_id=?)
                         OR
                         (c.scope!='occurrence' AND (
                             c.subject_form='' OR INSTR(LOWER(?), LOWER(c.subject_form))>0
                         ))
                     )
                   ORDER BY c.locked DESC, c.confidence DESC, c.id""",
                (block.global_index, block.id, block.source_text),
            ).fetchall()
            return [dict(row) for row in rows]

    def list_verification_tasks(self, status: str = "open") -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            return [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM verification_tasks WHERE status=? ORDER BY created_at, id",
                    (status,),
                )
            ]

    def get_block_by_identifier(self, identifier: str) -> V4Block:
        with closing(self.connect()) as connection:
            row = connection.execute(
                """SELECT * FROM blocks
                   WHERE source_edition_id=(SELECT id FROM source_editions WHERE active=1)
                     AND (id=? OR legacy_id=?) LIMIT 1""",
                (identifier, identifier),
            ).fetchone()
            if row is None:
                raise KeyError(f"文本块不存在: {identifier}")
            return self._row_to_block(row)

    def review_blocks(self, limit: int = 500) -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT b.id, b.legacy_id, b.chapter_title, b.global_index,
                          b.status, tv.status translation_status, tv.warnings_json,
                          cv.choice comparison_choice
                   FROM blocks b
                   LEFT JOIN translation_versions tv
                     ON tv.block_id=b.id AND tv.pipeline='parallel_v4' AND tv.active=1
                   LEFT JOIN comparison_votes cv ON cv.block_id=b.id
                   WHERE b.source_edition_id=(SELECT id FROM source_editions WHERE active=1)
                   ORDER BY CASE
                       WHEN tv.status='completed_with_warnings' THEN 0
                       WHEN b.status IN ('incomplete_requires_human','failed_retryable',
                                         'failed_terminal','needs_revalidate') THEN 1
                       ELSE 2 END,
                       b.global_index LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]

    def get_review_block(self, identifier: str) -> Dict[str, Any]:
        block = self.get_block_by_identifier(identifier)
        with closing(self.connect()) as connection:
            row = connection.execute(
                """SELECT b.*, v4.status v4_status, v4.final_translation v4_translation,
                          v4.draft_translation, v4.warnings_json,
                          serial.final_translation serial_translation
                   FROM blocks b
                   LEFT JOIN translation_versions v4
                     ON v4.block_id=b.id AND v4.pipeline='parallel_v4' AND v4.active=1
                   LEFT JOIN translation_versions serial
                     ON serial.block_id=b.id AND serial.pipeline='serial_v3' AND serial.active=1
                   WHERE b.id=?""",
                (block.id,),
            ).fetchone()
            evidence = [
                dict(item)
                for item in connection.execute(
                    """SELECT paragraph_id, kind, source_form, evidence_quote,
                              payload_json, confidence
                       FROM evidence WHERE block_id=? ORDER BY id""",
                    (block.id,),
                )
            ]
            annotations = [
                dict(item)
                for item in connection.execute(
                    "SELECT * FROM annotations WHERE block_id=? ORDER BY paragraph_index, created_at",
                    (block.id,),
                )
            ]
        baseline = self.baseline_for_block(block.id)
        result = dict(row) if row else {}
        result["evidence"] = evidence
        result["annotations"] = annotations
        result["baseline"] = baseline
        return result

    def add_annotation(
        self,
        block_identifier: str,
        paragraph_index: int,
        body: str,
        status: str = "proposed",
        source: str = "human",
    ) -> str:
        body = body.strip()
        if not body:
            raise ValueError("注释正文不能为空")
        if paragraph_index < 0:
            raise ValueError("paragraph_index不能为负数")
        if status not in {"proposed", "approved", "rejected"}:
            raise ValueError("不支持的注释状态")
        block = self.get_block_by_identifier(block_identifier)
        annotation_id = stable_id(
            "annotation",
            f"{block.id}:{paragraph_index}:{body}:{source}",
            length=24,
        )
        with self.transaction() as connection:
            version = int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            connection.execute(
                """INSERT OR IGNORE INTO annotations(
                       id, block_id, paragraph_index, body, status, source,
                       created_version, created_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    annotation_id,
                    block.id,
                    paragraph_index,
                    body,
                    status,
                    source,
                    version,
                    utc_now(),
                ),
            )
        return annotation_id

    def list_annotations(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        query = """SELECT a.*, b.legacy_id FROM annotations a
                   JOIN blocks b ON b.id=a.block_id"""
        params: List[Any] = []
        if status:
            query += " WHERE a.status=?"
            params.append(status)
        query += " ORDER BY b.global_index, a.paragraph_index, a.created_at"
        with closing(self.connect()) as connection:
            return [dict(row) for row in connection.execute(query, params)]

    @staticmethod
    def _archive_comparison_vote(
        connection: sqlite3.Connection,
        vote: sqlite3.Row,
        archived_at: str,
    ) -> None:
        connection.execute(
            """INSERT INTO comparison_vote_history(
                   original_vote_id, block_id, candidate_a_origin,
                   candidate_b_origin, candidate_a_hash, candidate_b_hash,
                   choice, selected_origin, blinded, note, created_at,
                   updated_at, archived_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                vote["id"],
                vote["block_id"],
                vote["candidate_a_origin"],
                vote["candidate_b_origin"],
                vote["candidate_a_hash"],
                vote["candidate_b_hash"],
                vote["choice"],
                vote["selected_origin"],
                vote["blinded"],
                vote["note"],
                vote["created_at"],
                vote["updated_at"],
                archived_at,
            ),
        )
        connection.execute(
            "DELETE FROM comparison_votes WHERE id=?", (vote["id"],)
        )

    def record_comparison_vote(
        self,
        block_identifier: str,
        choice: str,
        candidate_a_origin: str,
        candidate_b_origin: str,
        candidate_a_hash: str = "",
        candidate_b_hash: str = "",
        blinded: bool = True,
        note: str = "",
    ) -> Dict[str, Any]:
        if choice not in {"A", "B", "tie", "neither"}:
            raise ValueError("盲评选择必须是A、B、tie或neither")
        block = self.get_block_by_identifier(block_identifier)
        selected_origin = {
            "A": candidate_a_origin,
            "B": candidate_b_origin,
        }.get(choice)
        now = utc_now()
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT * FROM comparison_votes WHERE block_id=?", (block.id,)
            ).fetchone()
            if existing is not None and (
                existing["candidate_a_hash"] != candidate_a_hash
                or existing["candidate_b_hash"] != candidate_b_hash
            ):
                self._archive_comparison_vote(
                    connection, existing, now
                )
            connection.execute(
                """INSERT INTO comparison_votes(
                       block_id, candidate_a_origin, candidate_b_origin,
                       candidate_a_hash, candidate_b_hash, choice, selected_origin,
                       blinded, note, created_at, updated_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(block_id) DO UPDATE SET
                       candidate_a_origin=excluded.candidate_a_origin,
                       candidate_b_origin=excluded.candidate_b_origin,
                       candidate_a_hash=excluded.candidate_a_hash,
                       candidate_b_hash=excluded.candidate_b_hash,
                       choice=excluded.choice,
                       selected_origin=excluded.selected_origin,
                       blinded=excluded.blinded,
                       note=excluded.note,
                       updated_at=excluded.updated_at""",
                (
                    block.id,
                    candidate_a_origin,
                    candidate_b_origin,
                    candidate_a_hash,
                    candidate_b_hash,
                    choice,
                    selected_origin,
                    int(blinded),
                    note.strip(),
                    now,
                    now,
                ),
            )
        return self.comparison_vote_for_block(
            block.id, candidate_a_hash, candidate_b_hash
        ) or {}

    def comparison_vote_for_block(
        self,
        block_identifier: str,
        candidate_a_hash: Optional[str] = None,
        candidate_b_hash: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        block = self.get_block_by_identifier(block_identifier)
        with closing(self.connect()) as connection:
            if candidate_a_hash is None or candidate_b_hash is None:
                row = connection.execute(
                    "SELECT * FROM comparison_votes WHERE block_id=?", (block.id,)
                ).fetchone()
            else:
                row = connection.execute(
                    """SELECT * FROM comparison_votes
                       WHERE block_id=? AND candidate_a_hash=? AND candidate_b_hash=?""",
                    (block.id, candidate_a_hash, candidate_b_hash),
                ).fetchone()
            return dict(row) if row else None

    def list_comparison_votes(self) -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT v.*, b.legacy_id, b.global_index
                   FROM comparison_votes v JOIN blocks b ON b.id=v.block_id
                   ORDER BY b.global_index"""
            ).fetchall()
            return [dict(row) for row in rows]

    def list_comparison_vote_history(self) -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT v.*, b.legacy_id, b.global_index
                   FROM comparison_vote_history v JOIN blocks b ON b.id=v.block_id
                   ORDER BY v.archived_at, b.global_index"""
            ).fetchall()
            return [dict(row) for row in rows]

    def resolve_annotation(self, annotation_id: str, action: str) -> Dict[str, Any]:
        if action not in {"approve", "reject"}:
            raise ValueError("action必须是approve或reject")
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT status FROM annotations WHERE id=?",
                (annotation_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"注释不存在: {annotation_id}")
            status = "approved" if action == "approve" else "rejected"
            connection.execute(
                "UPDATE annotations SET status=?, resolved_at=? WHERE id=?",
                (status, utc_now(), annotation_id),
            )
            return {"id": annotation_id, "status": status}

    @staticmethod
    def _revalidation_canonical(value: Any) -> str:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )

    @classmethod
    def _revalidation_base_result(cls, raw: Any) -> Dict[str, Any]:
        if isinstance(raw, Mapping):
            result = deepcopy(dict(raw))
        else:
            try:
                result = json.loads(str(raw or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                raise ValueError("revalidation task result is invalid JSON") from None
        if not isinstance(result, dict):
            raise ValueError("revalidation task result must be an object")
        result.pop("_lease", None)
        return result

    @staticmethod
    def _revalidation_summary(value: Any) -> Dict[str, Any]:
        """Keep only render-effective, bounded target/rule fields."""
        if not isinstance(value, dict):
            return {}
        allowed = {
            "default_target",
            "working_target",
            "verified_target",
            "target",
            "targets",
            "rules",
            "locked",
            "scope",
            "prompt_effective",
            "statement",
        }
        result: Dict[str, Any] = {}
        for key in sorted(allowed & set(value)):
            item = value[key]
            if isinstance(item, str):
                result[key] = item[:1024]
            elif isinstance(item, (bool, int, float)) or item is None:
                result[key] = item
            elif isinstance(item, list):
                bounded = []
                for entry in item[:32]:
                    if isinstance(entry, dict):
                        bounded.append(
                            {
                                str(k)[:64]: (
                                    str(v)[:1024]
                                    if not isinstance(v, (bool, int, float))
                                    else v
                                )
                                for k, v in list(sorted(entry.items()))[:16]
                            }
                        )
                    elif isinstance(entry, (str, bool, int, float)):
                        bounded.append(entry[:1024] if isinstance(entry, str) else entry)
                result[key] = bounded
        return result

    @staticmethod
    def _revalidation_spans(raw: Any, source_length: int) -> List[Dict[str, int]]:
        try:
            values = json.loads(str(raw or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        spans: set[tuple[int, int]] = set()
        if isinstance(values, list):
            for value in values[:128]:
                if (
                    isinstance(value, list)
                    and len(value) == 2
                    and type(value[0]) is int
                    and type(value[1]) is int
                    and 0 <= value[0] < value[1] <= source_length
                ):
                    spans.add((value[0], value[1]))
        return [{"start": start, "end": end} for start, end in sorted(spans)]

    def _revalidation_payload(
        self, connection: sqlite3.Connection, task: sqlite3.Row
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        current = connection.execute(
            """SELECT tv.*, b.source_text, b.source_hash, b.block_type,
                      b.source_edition_id, edition.active source_edition_active
               FROM translation_versions tv
               JOIN blocks b ON b.id=tv.block_id
               JOIN source_editions edition ON edition.id=b.source_edition_id
               WHERE tv.id=? AND tv.block_id=?""",
            (task["translation_id"], task["block_id"]),
        ).fetchone()
        if current is None or int(current["active"]) != 1:
            raise ValueError("revalidation translation is no longer active")
        if str(current["pipeline"]) != "parallel_v4" or int(
            current["source_edition_active"]
        ) != 1:
            raise ValueError("revalidation translation is outside the active source")
        if (
            current["knowledge_version"] is None
            or int(current["knowledge_version"])
            != int(task["from_knowledge_version"])
        ):
            raise ValueError(
                "translation knowledge version does not match revalidation task"
            )
        change_domain = str(task["change_domain"] or "knowledge")
        if change_domain not in {"knowledge", "memory"}:
            raise ValueError("revalidation task change domain is invalid")
        if change_domain == "memory" and (
            current["memory_version"] is None
            or task["from_memory_version"] is None
            or int(current["memory_version"])
            != int(task["from_memory_version"])
        ):
            raise ValueError(
                "translation memory version does not match revalidation task"
            )
        base = self._revalidation_base_result(task["result_json"])
        change_ids = base.get("change_ids")
        if not isinstance(change_ids, list) or not change_ids:
            raise ValueError("revalidation task has no bounded change set")
        rows: Dict[int, sqlite3.Row] = {}
        placeholders = ",".join("?" for _ in change_ids)
        change_table = (
            "memory_changes"
            if change_domain == "memory"
            else "knowledge_changes"
        )
        for row in connection.execute(
            f"""SELECT * FROM {change_table}
                 WHERE id IN ({placeholders}) ORDER BY id""",
            tuple(change_ids),
        ).fetchall():
            rows[int(row["id"])] = row
        if set(rows) != set(change_ids):
            raise ValueError("revalidation task references unknown changes")
        dependencies = connection.execute(
            "SELECT * FROM dependencies WHERE translation_id=? ORDER BY id",
            (task["translation_id"],),
        ).fetchall()
        source_text = str(current["source_text"])
        reason_by_id = {
            int(reason["change_id"]): reason
            for reason in base.get("reasons", [])
            if isinstance(reason, dict) and type(reason.get("change_id")) is int
        }
        subject_aliases: Dict[tuple[str, str], str] = {}
        cases: List[Dict[str, Any]] = []
        for ordinal, change_id in enumerate(change_ids[:64], 1):
            row = rows[int(change_id)]
            try:
                change_payload = json.loads(str(row["payload_json"] or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                change_payload = {}
            if not isinstance(change_payload, dict):
                change_payload = {}
            memory_summary: Dict[str, Any] = {}
            if change_domain == "memory":
                memory = connection.execute(
                    """SELECT memory_type, statement, truth_status, visibility,
                              status, high_impact
                       FROM narrative_memories WHERE id=?""",
                    (row["subject_id"],),
                ).fetchone()
                if memory is not None:
                    memory_summary = {
                        "memory_type": str(memory["memory_type"]),
                        "statement": str(memory["statement"])[:4096],
                        "truth_status": str(memory["truth_status"]),
                        "visibility": str(memory["visibility"]),
                        "status": str(memory["status"]),
                        "high_impact": bool(memory["high_impact"]),
                    }
            reason = reason_by_id.get(int(change_id), {})
            raw_subjects = reason.get("subjects", [])
            if not raw_subjects:
                raw_subjects = [
                    {
                        "subject_type": str(row["subject_type"]),
                        "subject_id": str(row["subject_id"]),
                    }
                ]
            subjects = []
            spans: set[tuple[int, int]] = set()
            for raw_subject in raw_subjects[:128]:
                if not isinstance(raw_subject, dict):
                    continue
                subject = (
                    str(raw_subject.get("subject_type") or "")[:64],
                    str(raw_subject.get("subject_id") or "")[:256],
                )
                if not all(subject):
                    continue
                alias = subject_aliases.setdefault(
                    subject, f"S{len(subject_aliases) + 1:03d}"
                )
                subjects.append(
                    {"subject_alias": alias, "subject_type": subject[0]}
                )
                for dependency in dependencies:
                    if (
                        str(dependency["dependency_type"]) == subject[0]
                        and str(dependency["dependency_id"]) == subject[1]
                    ):
                        for span in self._revalidation_spans(
                            dependency["source_spans_json"], len(source_text)
                        ):
                            spans.add((span["start"], span["end"]))
            cases.append(
                {
                    "case_alias": f"C{ordinal:03d}",
                    "impact_level": int(row["impact_level"]),
                    "change_kind": str(row["change_kind"])[:128],
                    "reason": str(change_payload.get("reason") or "")[:512],
                    "subjects": subjects,
                    "spans": [
                        {"start": start, "end": end}
                        for start, end in sorted(spans)
                    ],
                    "old": self._revalidation_summary(change_payload.get("old")),
                    "new": self._revalidation_summary(change_payload.get("new")),
                    "memory": memory_summary,
                }
            )
        payload = {
            "task_alias": "T001",
            "change_domain": change_domain,
            "coverage_complete": len(change_ids) <= 64,
            "omitted_case_count": max(0, len(change_ids) - 64),
            "impact_level": int(task["impact_level"]),
            "from_knowledge_version": int(task["from_knowledge_version"]),
            "to_knowledge_version": int(task["to_knowledge_version"]),
            "block": {
                "source_text": source_text,
                "source_hash": str(current["source_hash"]),
                "block_type": str(current["block_type"]),
            },
            "active_translation": {
                "text": str(current["final_translation"]),
                "knowledge_version": int(current["knowledge_version"]),
            },
            "cases": cases,
        }
        if change_domain == "memory":
            payload.update(
                {
                    "from_memory_version": int(
                        task["from_memory_version"]
                    ),
                    "to_memory_version": int(task["to_memory_version"]),
                }
            )
        snapshot = {
            "task_id": str(task["id"]),
            "translation_id": int(task["translation_id"]),
            "block_id": str(task["block_id"]),
            "from_knowledge_version": int(task["from_knowledge_version"]),
            "to_knowledge_version": int(task["to_knowledge_version"]),
            "change_set_hash": str(task["change_set_hash"]),
            "impact_level": int(task["impact_level"]),
            "base_result_hash": hashlib.sha256(
                self._revalidation_canonical(base).encode("utf-8")
            ).hexdigest(),
            "translation_hash": hashlib.sha256(
                str(current["final_translation"]).encode("utf-8")
            ).hexdigest(),
            "translation_knowledge_version": int(current["knowledge_version"]),
            "change_domain": change_domain,
            "from_memory_version": (
                int(task["from_memory_version"])
                if task["from_memory_version"] is not None
                else None
            ),
            "to_memory_version": (
                int(task["to_memory_version"])
                if task["to_memory_version"] is not None
                else None
            ),
            "translation_memory_version": (
                int(current["memory_version"])
                if current["memory_version"] is not None
                else None
            ),
            "translation_snapshot_id": str(
                current["snapshot_id"] or ""
            ),
            "source_hash": str(current["source_hash"]),
            "source_text_hash": hashlib.sha256(
                source_text.encode("utf-8")
            ).hexdigest(),
        }
        return payload, snapshot

    def _resolve_stale_revalidation_task(
        self,
        connection: sqlite3.Connection,
        task: sqlite3.Row,
        raw_result: Any,
    ) -> str:
        replacement = connection.execute(
            """SELECT id, knowledge_version
               FROM translation_versions
               WHERE block_id=? AND pipeline='parallel_v4' AND active=1 AND id<>?
               ORDER BY id DESC LIMIT 1""",
            (task["block_id"], task["translation_id"]),
        ).fetchone()
        result = self._revalidation_base_result(raw_result)
        if replacement is not None:
            action = "superseded_by_active_translation"
            replacement_id: Optional[int] = int(replacement["id"])
            result.update(
                {
                    "reason": action,
                    "replacement_translation_id": replacement_id,
                    "replacement_knowledge_version": (
                        int(replacement["knowledge_version"])
                        if replacement["knowledge_version"] is not None
                        else None
                    ),
                }
            )
        else:
            action = "stale_translation"
            replacement_id = None
            original = connection.execute(
                "SELECT knowledge_version FROM translation_versions WHERE id=?",
                (task["translation_id"],),
            ).fetchone()
            result.update(
                {
                    "reason": action,
                    "stale_translation_id": int(task["translation_id"]),
                    "stale_knowledge_version": (
                        int(original["knowledge_version"])
                        if original is not None
                        and original["knowledge_version"] is not None
                        else None
                    ),
                }
            )
        connection.execute(
            """UPDATE revalidation_tasks
               SET status='resolved_noop', action=?, result_json=?,
                   replacement_translation_id=?, error=NULL, resolved_at=?
               WHERE id=? AND status IN ('pending','validating')""",
            (
                action,
                self._revalidation_canonical(result),
                replacement_id,
                utc_now(),
                task["id"],
            ),
        )
        return action

    def _retire_stale_pending_revalidation_tasks(
        self, connection: sqlite3.Connection
    ) -> int:
        stale = connection.execute(
            """SELECT task.*
               FROM revalidation_tasks task
               LEFT JOIN translation_versions original
                 ON original.id=task.translation_id
               WHERE task.status='pending'
                 AND (
                     original.id IS NULL OR original.active<>1
                     OR original.pipeline<>'parallel_v4'
                     OR original.block_id<>task.block_id
                     OR original.knowledge_version IS NULL
                     OR original.knowledge_version<>task.from_knowledge_version
                     OR (
                         task.change_domain='memory'
                         AND (
                             original.memory_version IS NULL
                             OR task.from_memory_version IS NULL
                             OR original.memory_version
                                <>task.from_memory_version
                         )
                     )
                 )
               ORDER BY task.created_at, task.id"""
        ).fetchall()
        for task in stale:
            self._resolve_stale_revalidation_task(
                connection, task, task["result_json"]
            )
        return len(stale)

    @staticmethod
    def _freeze_revalidation(value: Any) -> Any:
        if isinstance(value, dict):
            return MappingProxyType(
                {
                    str(key): V4Database._freeze_revalidation(item)
                    for key, item in value.items()
                }
            )
        if isinstance(value, list):
            return tuple(V4Database._freeze_revalidation(item) for item in value)
        return value

    @staticmethod
    def _lease_is_expired(lease: Any, now: datetime) -> bool:
        if not isinstance(lease, dict):
            return True
        try:
            expires = datetime.fromisoformat(str(lease["expires_at"]))
        except (KeyError, TypeError, ValueError):
            return True
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires <= now

    def _requeue_expired_revalidation_tasks(
        self, connection: sqlite3.Connection, now: datetime
    ) -> int:
        count = 0
        for row in connection.execute(
            "SELECT id, result_json FROM revalidation_tasks WHERE status='validating'"
        ).fetchall():
            try:
                result = json.loads(str(row["result_json"] or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                result = {}
            lease = result.get("_lease") if isinstance(result, dict) else None
            if not self._lease_is_expired(lease, now):
                continue
            if not isinstance(result, dict):
                result = {}
            result.pop("_lease", None)
            cursor = connection.execute(
                """UPDATE revalidation_tasks
                   SET status='pending', action='', result_json=?, error=NULL,
                       resolved_at=NULL, replacement_translation_id=NULL
                   WHERE id=? AND status='validating'""",
                (self._revalidation_canonical(result), row["id"]),
            )
            count += int(cursor.rowcount)
        return count

    def requeue_expired_revalidation_tasks(self) -> int:
        with self.transaction() as connection:
            return self._requeue_expired_revalidation_tasks(
                connection, datetime.now(timezone.utc)
            )

    def claim_revalidation_task(
        self,
        owner: str,
        lease_seconds: int = 300,
        exclude_task_ids: Sequence[str] = (),
    ) -> Optional[RevalidationClaim]:
        owner = str(owner).strip()
        if not owner or len(owner) > 128:
            raise ValueError("revalidation lease owner is invalid")
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 86_400:
            raise ValueError("revalidation lease_seconds is invalid")
        excluded = tuple(str(value) for value in exclude_task_ids)
        claim_data: Optional[tuple[Any, ...]] = None
        with self.transaction() as connection:
            now = datetime.now(timezone.utc)
            self._requeue_expired_revalidation_tasks(connection, now)
            self._retire_stale_pending_revalidation_tasks(connection)
            sql = "SELECT * FROM revalidation_tasks WHERE status='pending'"
            params: List[Any] = []
            if excluded:
                sql += f" AND id NOT IN ({','.join('?' for _ in excluded)})"
                params.extend(excluded)
            sql += " ORDER BY impact_level DESC, created_at, id LIMIT 1"
            task = connection.execute(sql, tuple(params)).fetchone()
            if task is None:
                return None
            payload, snapshot = self._revalidation_payload(connection, task)
            payload_bytes = self._revalidation_canonical(payload).encode("utf-8")
            if len(payload_bytes) > 64 * 1024:
                payload = {
                    "task_alias": "T001",
                    "impact_level": int(task["impact_level"]),
                    "coverage_complete": False,
                    "coverage_error": "validator_payload_byte_budget",
                    "cases": [],
                }
                payload_bytes = self._revalidation_canonical(payload).encode("utf-8")
            payload_hash = hashlib.sha256(payload_bytes).hexdigest()
            snapshot_hash = hashlib.sha256(
                self._revalidation_canonical(snapshot).encode("utf-8")
            ).hexdigest()
            token = secrets.token_urlsafe(32)
            expires_at = (now + timedelta(seconds=lease_seconds)).isoformat()
            result = self._revalidation_base_result(task["result_json"])
            result["_lease"] = {
                "owner": owner,
                "expires_at": expires_at,
                "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
                "payload_hash": payload_hash,
                "snapshot_hash": snapshot_hash,
                "snapshot": snapshot,
            }
            cursor = connection.execute(
                """UPDATE revalidation_tasks
                   SET status='validating', attempts=attempts+1, result_json=?
                   WHERE id=? AND status='pending'""",
                (self._revalidation_canonical(result), task["id"]),
            )
            if cursor.rowcount != 1:
                return None
            claim_data = (
                str(task["id"]),
                token,
                owner,
                expires_at,
                snapshot,
                payload,
                payload_bytes,
                payload_hash,
            )
        assert claim_data is not None
        return RevalidationClaim(
            task_id=claim_data[0],
            lease_token=claim_data[1],
            owner=claim_data[2],
            expires_at=claim_data[3],
            task_snapshot=self._freeze_revalidation(claim_data[4]),
            payload=self._freeze_revalidation(claim_data[5]),
            payload_bytes=claim_data[6],
            payload_hash=claim_data[7],
        )

    def _validated_revalidation_lease(
        self,
        connection: sqlite3.Connection,
        claim: RevalidationClaim,
    ) -> tuple[sqlite3.Row, Dict[str, Any], Optional[str]]:
        task = connection.execute(
            "SELECT * FROM revalidation_tasks WHERE id=?", (claim.task_id,)
        ).fetchone()
        if task is None or str(task["status"]) != "validating":
            raise ValueError("revalidation lease is not active")
        try:
            stored = json.loads(str(task["result_json"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            raise ValueError("revalidation lease state is invalid") from None
        lease = stored.get("_lease") if isinstance(stored, dict) else None
        token_hash = hashlib.sha256(claim.lease_token.encode("utf-8")).hexdigest()
        if (
            not isinstance(lease, dict)
            or str(lease.get("owner")) != claim.owner
            or not secrets.compare_digest(str(lease.get("token_hash") or ""), token_hash)
            or self._lease_is_expired(lease, datetime.now(timezone.utc))
        ):
            raise ValueError("revalidation lease token, owner, or expiry is invalid")
        if str(lease.get("payload_hash")) != claim.payload_hash:
            return task, stored, "revalidation lease payload changed"
        try:
            _, current_snapshot = self._revalidation_payload(connection, task)
        except ValueError as exc:
            return task, stored, str(exc)
        current_hash = hashlib.sha256(
            self._revalidation_canonical(current_snapshot).encode("utf-8")
        ).hexdigest()
        if current_hash != str(lease.get("snapshot_hash")):
            return task, stored, "revalidation lease snapshot changed"
        return task, stored, None

    def _record_revalidation_audits(
        self,
        connection: sqlite3.Connection,
        task: sqlite3.Row,
        run_id: Optional[str],
        audits: Sequence[Mapping[str, Any]],
    ) -> List[int]:
        audit_ids: List[int] = []
        for audit in audits:
            audit_ids.append(self.record_audit_call(
                run_id=run_id,  # type: ignore[arg-type]
                block_id=str(task["block_id"]),
                purpose=str(audit.get("purpose") or "revalidate"),
                model=str(audit.get("model") or "unknown")[:256],
                knowledge_version=int(task["to_knowledge_version"]),
                request=dict(audit.get("request") or {}),
                raw_response=str(audit.get("raw_response") or "")[:16_384],
                parsed=(dict(audit["parsed"]) if isinstance(audit.get("parsed"), Mapping) else None),
                accepted=bool(audit.get("accepted")),
                attempts=max(1, int(audit.get("attempts") or 1)),
                elapsed_ms=max(0, int(audit.get("elapsed_ms") or 0)),
                error=(str(audit.get("error"))[:1024] if audit.get("error") else None),
                connection=connection,
                archive_payload=False,
            ))
        return audit_ids

    @staticmethod
    def _revalidation_target(summary: Any) -> str:
        if not isinstance(summary, dict):
            return ""
        for key in ("verified_target", "working_target", "default_target", "target"):
            target = str(summary.get(key) or "").strip()
            if target:
                return target
        rules = summary.get("rules")
        if isinstance(rules, list):
            for rule in rules:
                if isinstance(rule, dict) and str(rule.get("target") or "").strip():
                    return str(rule["target"]).strip()
        return ""

    def _insert_revalidation_retranslation(
        self,
        connection: sqlite3.Connection,
        task: sqlite3.Row,
        outcome: TranslationOutcome,
        run_id: Optional[str],
    ) -> int:
        frozen = _snapshot_translation_outcome(outcome)
        current_version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        current_memory_version = int(
            connection.execute("SELECT MAX(id) FROM memory_versions").fetchone()[0]
        )
        change_domain = str(task["change_domain"] or "knowledge")
        if (
            frozen.block.id != str(task["block_id"])
            or frozen.knowledge_version != current_version
            or frozen.knowledge_version < int(task["to_knowledge_version"])
            or frozen.memory_version != current_memory_version
            or (
                change_domain == "memory"
                and (
                    task["to_memory_version"] is None
                    or frozen.memory_version
                    < int(task["to_memory_version"])
                    or not frozen.snapshot_id
                )
            )
            or frozen.status
            not in {
                V4BlockStatus.COMPLETED.value,
                V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
            }
            or not frozen.final_translation.strip()
        ):
            raise ValueError("revalidation retranslation outcome is inconsistent")
        source = connection.execute(
            """SELECT b.source_text, b.source_hash
               FROM blocks b
               JOIN source_editions edition
                 ON edition.id=b.source_edition_id AND edition.active=1
               WHERE b.id=?""",
            (task["block_id"],),
        ).fetchone()
        if source is None:
            raise ValueError("revalidation retranslation source is inactive")
        source_text = str(source["source_text"])
        if (
            source_text != frozen.block.source_text
            or str(source["source_hash"]) != frozen.block.source_hash
        ):
            raise ValueError("revalidation retranslation source drifted")
        stored_source_hash = str(source["source_hash"])
        computed_source_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()
        if re.fullmatch(r"[0-9a-f]{64}", stored_source_hash) and (
            stored_source_hash != computed_source_hash
        ):
            raise ValueError("revalidation retranslation source hash drifted")
        previous = connection.execute(
            """SELECT id FROM translation_versions
               WHERE id=? AND block_id=? AND pipeline='parallel_v4' AND active=1""",
            (task["translation_id"], task["block_id"]),
        ).fetchone()
        if previous is None:
            raise ValueError("revalidation retranslation active translation changed")

        snapshot_row: sqlite3.Row | None = None
        visible_memory_ids: set[str] = set()
        narrative_dependency_rows: list[tuple[str, str]] = []
        if frozen.snapshot_id:
            snapshot_row = connection.execute(
                "SELECT * FROM narrative_snapshots WHERE id=?",
                (frozen.snapshot_id,),
            ).fetchone()
            if snapshot_row is None:
                raise ValueError(
                    "revalidation narrative snapshot does not exist"
                )
            if (
                str(snapshot_row["block_id"]) != str(task["block_id"])
                or int(snapshot_row["knowledge_version"])
                != frozen.knowledge_version
                or int(snapshot_row["memory_version"])
                != frozen.memory_version
            ):
                raise ValueError(
                    "revalidation narrative snapshot version mismatch"
                )
            visible_memory_ids = {
                str(value)
                for value in json.loads(
                    snapshot_row["visible_memory_ids_json"] or "[]"
                )
            }
            expected_discourse_hash = hashlib.sha256(
                str(snapshot_row["discourse_state_json"]).encode("utf-8")
            ).hexdigest()
            if frozen.discourse_state_hash != expected_discourse_hash:
                raise ValueError(
                    "revalidation discourse state hash mismatch"
                )
            if re.fullmatch(r"[0-9a-f]{64}", frozen.context_hash) is None:
                raise ValueError(
                    "revalidation context hash is invalid"
                )
            for dependency in frozen.narrative_dependencies:
                memory_id = str(dependency.memory_id).strip()
                fingerprint = str(
                    dependency.semantic_fingerprint
                ).strip()
                if memory_id not in visible_memory_ids:
                    raise ValueError(
                        "revalidation narrative dependency is not visible"
                    )
                row = connection.execute(
                    """SELECT semantic_fingerprint
                       FROM narrative_memories WHERE id=?""",
                    (memory_id,),
                ).fetchone()
                if (
                    row is None
                    or str(row["semantic_fingerprint"]) != fingerprint
                ):
                    raise ValueError(
                        "revalidation narrative dependency fingerprint mismatch"
                    )
                narrative_dependency_rows.append(
                    (memory_id, fingerprint)
                )
        elif frozen.narrative_dependencies:
            raise ValueError(
                "revalidation narrative dependencies require a snapshot"
            )
        style_state_hash = ""
        if frozen.style_snapshot_id:
            style_row = connection.execute(
                "SELECT state_hash FROM style_snapshots WHERE id=?",
                (frozen.style_snapshot_id,),
            ).fetchone()
            if style_row is None:
                raise ValueError(
                    "revalidation style snapshot does not exist"
                )
            style_state_hash = str(style_row["state_hash"])

        dependency_groups: Dict[tuple[str, str], List[RenderingMatchSnapshot]] = {}
        for match in frozen.matched_renderings:
            lexeme_id = str(match.lexeme_id or "").strip()
            concept_id = str(match.concept_id or "").strip()
            start = int(match.start_offset)
            end = int(match.end_offset)
            if not lexeme_id or len(lexeme_id) > 256:
                raise ValueError("retranslation match lexeme_id is invalid")
            if len(concept_id) > 256 or len(str(match.dependency_fingerprint)) > 256:
                raise ValueError("retranslation dependency identity is invalid")
            if not 0 <= start < end <= len(source_text):
                raise ValueError("retranslation match span is outside the source block")
            if unicodedata.normalize("NFKC", source_text[start:end]) != unicodedata.normalize(
                "NFKC", str(match.matched_form)
            ):
                raise ValueError("retranslation match source span drifted")
            raw_rule_ids = match.applied_rule_ids or ()
            if isinstance(raw_rule_ids, (str, bytes)):
                raise ValueError("retranslation match rule IDs must be a sequence")
            rule_ids = tuple(str(value).strip() for value in raw_rule_ids)
            if (
                len(rule_ids) > MAX_DEPENDENCY_RULE_IDS
                or any(not value or len(value) > 256 for value in rule_ids)
            ):
                raise ValueError("retranslation match rule IDs are invalid")
            dependency_groups.setdefault(("lexeme", lexeme_id), []).append(match)
            if concept_id:
                dependency_groups.setdefault(("concept", concept_id), []).append(match)
            for rule_id in sorted(set(rule_ids)):
                dependency_groups.setdefault(("rule", rule_id), []).append(match)

        cursor = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, run_id, knowledge_version, status,
                   draft_translation, final_translation, analysis,
                   semantic_obligations, memory_summary, warnings_json,
                   validation_status, validated_knowledge_version,
                   memory_version, snapshot_id, context_hash,
                   style_snapshot_id, discourse_state_hash,
                   active, created_at)
               VALUES(?, 'parallel_v4', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      'clean', ?, ?, ?, ?, ?, ?, 0, ?)""",
            (
                task["block_id"],
                run_id,
                frozen.knowledge_version,
                frozen.status,
                frozen.draft_translation or frozen.final_translation,
                frozen.final_translation,
                frozen.analysis,
                frozen.semantic_obligations,
                frozen.memory_summary,
                json.dumps(_mutable_render_value(frozen.warnings), ensure_ascii=False),
                frozen.knowledge_version,
                frozen.memory_version,
                frozen.snapshot_id or None,
                frozen.context_hash,
                frozen.style_snapshot_id or None,
                frozen.discourse_state_hash,
                utc_now(),
            ),
        )
        replacement_id = int(cursor.lastrowid)
        dependency_rows: List[tuple[Any, ...]] = []
        for (dependency_type, dependency_id), group in sorted(
            dependency_groups.items()
        ):
            dependency_rows.append(
                (
                    replacement_id,
                    dependency_type,
                    dependency_id,
                    frozen.knowledge_version,
                    *_dependency_row(dependency_type, dependency_id, group),
                )
            )
        if not frozen.matched_renderings:
            for concept_id in sorted(set(frozen.matched_concept_ids)):
                concept_id = str(concept_id).strip()
                if not concept_id or len(concept_id) > 256:
                    raise ValueError("legacy retranslation concept ID is invalid")
                fingerprint = hashlib.sha256(
                    json.dumps(
                        {
                            "dependency_type": "concept",
                            "dependency_id": concept_id,
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ).hexdigest()
                dependency_rows.append(
                    (
                        replacement_id,
                        "concept",
                        concept_id,
                        frozen.knowledge_version,
                        fingerprint,
                        "",
                        0,
                        "",
                        "[]",
                        "[]",
                    )
                )
        for claim_id, fingerprint in sorted(
            {
                (snapshot.claim_id, snapshot.semantic_fingerprint)
                for snapshot in frozen.claim_dependencies
            }
        ):
            claim_id = str(claim_id).strip()
            if not claim_id or len(claim_id) > 256:
                raise ValueError("retranslation claim dependency ID is invalid")
            if re.fullmatch(r"[0-9a-f]{64}", str(fingerprint)) is None:
                raise ValueError("retranslation claim dependency fingerprint is invalid")
            dependency_rows.append(
                (
                    replacement_id,
                    "claim",
                    claim_id,
                    frozen.knowledge_version,
                    str(fingerprint),
                    "",
                    0,
                    "",
                    "[]",
                    "[]",
                )
            )
        for memory_id, fingerprint in sorted(
            set(narrative_dependency_rows)
        ):
            dependency_rows.append(
                (
                    replacement_id,
                    "narrative_memory",
                    memory_id,
                    frozen.knowledge_version,
                    fingerprint,
                    "",
                    0,
                    "",
                    "[]",
                    "[]",
                )
            )
        if snapshot_row is not None:
            dependency_rows.extend(
                [
                    (
                        replacement_id,
                        "narrative_snapshot",
                        frozen.snapshot_id,
                        frozen.knowledge_version,
                        str(snapshot_row["snapshot_hash"]),
                        "",
                        0,
                        "",
                        "[]",
                        "[]",
                    ),
                    (
                        replacement_id,
                        "discourse_state",
                        frozen.snapshot_id,
                        frozen.knowledge_version,
                        frozen.discourse_state_hash,
                        "",
                        0,
                        "",
                        "[]",
                        "[]",
                    ),
                ]
            )
        if frozen.style_snapshot_id:
            dependency_rows.append(
                (
                    replacement_id,
                    "style_snapshot",
                    frozen.style_snapshot_id,
                    frozen.knowledge_version,
                    style_state_hash,
                    "",
                    0,
                    "",
                    "[]",
                    "[]",
                )
            )
        if dependency_rows:
            connection.executemany(
                """INSERT INTO dependencies(
                       translation_id, dependency_type, dependency_id,
                       knowledge_version, dependency_fingerprint,
                       matched_form, occurrence_count, rendered_target,
                       applied_rule_ids_json, source_spans_json)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                dependency_rows,
            )
        deactivated = connection.execute(
            "UPDATE translation_versions SET active=0 WHERE id=? AND active=1",
            (task["translation_id"],),
        )
        if deactivated.rowcount != 1:
            raise ValueError("revalidation retranslation lost active translation CAS")
        activated = connection.execute(
            "UPDATE translation_versions SET active=1 WHERE id=? AND active=0",
            (replacement_id,),
        )
        if activated.rowcount != 1:
            raise ValueError("revalidation retranslation activation failed")
        connection.execute(
            "UPDATE blocks SET status=?, last_error=NULL, updated_at=? WHERE id=?",
            (frozen.status, utc_now(), task["block_id"]),
        )
        return replacement_id

    def commit_revalidation_resolution(
        self,
        claim: RevalidationClaim,
        *,
        status: str,
        action: str,
        result: Mapping[str, Any],
        outcome: Optional[TranslationOutcome] = None,
        audits: Sequence[Mapping[str, Any]] = (),
        run_id: Optional[str] = None,
    ) -> Optional[int]:
        allowed = {
            "resolved_noop",
            "resolved_patch",
            "resolved_retranslate",
            "completed_with_warning",
        }
        if status not in allowed:
            raise ValueError("invalid revalidation terminal status")
        if status in {"resolved_patch", "resolved_retranslate"} and outcome is None:
            raise ValueError(f"{status} requires a full translation outcome")
        if status not in {"resolved_patch", "resolved_retranslate"} and outcome is not None:
            raise ValueError("this revalidation status may not insert a translation outcome")
        stale_error: Optional[str] = None
        replacement_id: Optional[int] = None
        with self.transaction() as connection:
            task, stored, stale_error = self._validated_revalidation_lease(
                connection, claim
            )
            if stale_error:
                self._resolve_stale_revalidation_task(
                    connection, task, stored
                )
            else:
                audit_ids = self._record_revalidation_audits(
                    connection,
                    task,
                    run_id,
                    tuple(audits) + tuple(outcome.audit_calls if outcome else ()),
                )
                if outcome is not None and status == "resolved_retranslate":
                    replacement_id = self._insert_revalidation_retranslation(
                        connection, task, outcome, run_id
                    )
                elif outcome is not None:
                    if (
                        outcome.block.id != str(task["block_id"])
                        or outcome.knowledge_version != int(task["to_knowledge_version"])
                        or outcome.status
                        not in {
                            V4BlockStatus.COMPLETED.value,
                            V4BlockStatus.COMPLETED_WITH_WARNINGS.value,
                        }
                        or not outcome.final_translation.strip()
                    ):
                        raise ValueError("revalidation patch outcome is inconsistent")
                    previous = connection.execute(
                        """SELECT * FROM translation_versions
                           WHERE id=? AND block_id=? AND pipeline='parallel_v4'
                             AND active=1""",
                        (task["translation_id"], task["block_id"]),
                    ).fetchone()
                    if previous is None:
                        raise ValueError("revalidation patch active translation changed")
                    cursor = connection.execute(
                        """INSERT INTO translation_versions(
                               block_id, pipeline, run_id, knowledge_version, status,
                               draft_translation, final_translation, analysis,
                               semantic_obligations, memory_summary, warnings_json,
                               active, created_at)
                           VALUES(?, 'parallel_v4', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
                        (
                            task["block_id"],
                            run_id,
                            task["to_knowledge_version"],
                            outcome.status,
                            outcome.draft_translation or outcome.final_translation,
                            outcome.final_translation,
                            outcome.analysis,
                            outcome.semantic_obligations,
                            outcome.memory_summary,
                            json.dumps(outcome.warnings, ensure_ascii=False),
                            utc_now(),
                        ),
                    )
                    replacement_id = int(cursor.lastrowid)
                    base = self._revalidation_base_result(task["result_json"])
                    change_ids = tuple(int(value) for value in base.get("change_ids", ()))
                    changes: Dict[tuple[str, str], sqlite3.Row] = {}
                    changes_by_id: Dict[int, sqlite3.Row] = {}
                    if change_ids:
                        placeholders = ",".join("?" for _ in change_ids)
                        for row in connection.execute(
                            f"SELECT * FROM knowledge_changes WHERE id IN ({placeholders})",
                            change_ids,
                        ).fetchall():
                            changes_by_id[int(row["id"])] = row
                            changes[(str(row["subject_type"]), str(row["subject_id"]))] = row
                    inserted_dependencies: set[tuple[str, str]] = set()
                    for dependency in connection.execute(
                        "SELECT * FROM dependencies WHERE translation_id=? ORDER BY id",
                        (task["translation_id"],),
                    ).fetchall():
                        change = changes.get(
                            (
                                str(dependency["dependency_type"]),
                                str(dependency["dependency_id"]),
                            )
                        )
                        fingerprint = str(dependency["dependency_fingerprint"] or "")
                        rendered_target = str(dependency["rendered_target"] or "")
                        if change is not None:
                            fingerprint = str(change["new_fingerprint"] or "")
                            try:
                                change_payload = json.loads(str(change["payload_json"] or "{}"))
                            except (TypeError, ValueError, json.JSONDecodeError):
                                change_payload = {}
                            target = self._revalidation_target(
                                change_payload.get("new") if isinstance(change_payload, dict) else {}
                            )
                            if target:
                                rendered_target = target
                        connection.execute(
                            """INSERT INTO dependencies(
                                   translation_id, dependency_type, dependency_id,
                                   knowledge_version, dependency_fingerprint,
                                   matched_form, occurrence_count, rendered_target,
                                   applied_rule_ids_json, source_spans_json)
                               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (
                                replacement_id,
                                dependency["dependency_type"],
                                dependency["dependency_id"],
                                task["to_knowledge_version"],
                                fingerprint,
                                dependency["matched_form"],
                                dependency["occurrence_count"],
                                rendered_target,
                                dependency["applied_rule_ids_json"],
                                dependency["source_spans_json"],
                            ),
                        )
                        inserted_dependencies.add(
                            (
                                str(dependency["dependency_type"]),
                                str(dependency["dependency_id"]),
                            )
                        )
                    frozen_payload = json.loads(claim.payload_bytes.decode("utf-8"))
                    source_text = str(frozen_payload["block"]["source_text"])
                    reasons = {
                        int(reason["change_id"]): reason
                        for reason in base.get("reasons", ())
                        if isinstance(reason, dict)
                        and type(reason.get("change_id")) is int
                    }
                    cases = frozen_payload.get("cases") or []
                    for ordinal, change_id in enumerate(change_ids):
                        change = changes_by_id.get(change_id)
                        if change is None:
                            raise ValueError("revalidation patch change set drifted")
                        case = cases[ordinal] if ordinal < len(cases) else {}
                        spans = case.get("spans") if isinstance(case, dict) else []
                        normalized_spans = [
                            [int(span["start"]), int(span["end"])]
                            for span in (spans or ())
                            if isinstance(span, dict)
                            and type(span.get("start")) is int
                            and type(span.get("end")) is int
                            and 0 <= span["start"] < span["end"] <= len(source_text)
                        ]
                        reason = reasons.get(change_id, {})
                        subjects = reason.get("subjects") or [
                            {
                                "subject_type": change["subject_type"],
                                "subject_id": change["subject_id"],
                            }
                        ]
                        try:
                            change_payload = json.loads(str(change["payload_json"] or "{}"))
                        except (TypeError, ValueError, json.JSONDecodeError):
                            change_payload = {}
                        rendered_target = self._revalidation_target(
                            change_payload.get("new")
                            if isinstance(change_payload, dict)
                            else {}
                        )
                        for subject in subjects:
                            if not isinstance(subject, dict):
                                continue
                            key = (
                                str(subject.get("subject_type") or ""),
                                str(subject.get("subject_id") or ""),
                            )
                            if not all(key) or key in inserted_dependencies:
                                continue
                            matched_form = (
                                source_text[normalized_spans[0][0] : normalized_spans[0][1]]
                                if normalized_spans
                                else ""
                            )
                            connection.execute(
                                """INSERT INTO dependencies(
                                       translation_id, dependency_type, dependency_id,
                                       knowledge_version, dependency_fingerprint,
                                       matched_form, occurrence_count, rendered_target,
                                       applied_rule_ids_json, source_spans_json)
                                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)""",
                                (
                                    replacement_id,
                                    key[0],
                                    key[1],
                                    task["to_knowledge_version"],
                                    change["new_fingerprint"],
                                    matched_form,
                                    len(normalized_spans),
                                    rendered_target,
                                    self._revalidation_canonical(normalized_spans),
                                ),
                            )
                            inserted_dependencies.add(key)
                    deactivated = connection.execute(
                        """UPDATE translation_versions SET active=0
                           WHERE id=? AND active=1""",
                        (task["translation_id"],),
                    )
                    if deactivated.rowcount != 1:
                        raise ValueError("revalidation patch lost active translation CAS")
                    connection.execute(
                        "UPDATE translation_versions SET active=1 WHERE id=? AND active=0",
                        (replacement_id,),
                    )
                if status == "completed_with_warning":
                    warned = connection.execute(
                        """UPDATE translation_versions
                           SET validation_status='warning_stale',
                               validated_knowledge_version=?
                           WHERE id=? AND block_id=? AND pipeline='parallel_v4'
                             AND active=1""",
                        (
                            task["to_knowledge_version"],
                            task["translation_id"],
                            task["block_id"],
                        ),
                    )
                    if warned.rowcount != 1:
                        raise ValueError("warning fallback lost active translation CAS")
                final_result = self._revalidation_base_result(task["result_json"])
                final_result.update(dict(result))
                final_result["payload_hash"] = claim.payload_hash
                if status == "completed_with_warning":
                    final_result["stale_change_ids"] = sorted(
                        int(value) for value in final_result.get("change_ids", ())
                    )
                    final_result["last_audit_call_id"] = (
                        audit_ids[-1] if audit_ids else None
                    )
                cursor = connection.execute(
                    """UPDATE revalidation_tasks
                       SET status=?, action=?, result_json=?,
                           replacement_translation_id=?, error=NULL, resolved_at=?
                       WHERE id=? AND status='validating'""",
                    (
                        status,
                        action,
                        self._revalidation_canonical(final_result),
                        replacement_id,
                        utc_now(),
                        claim.task_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise ValueError("revalidation terminal commit lost lease CAS")
        if stale_error:
            raise ValueError(stale_error)
        return replacement_id

    def complete_with_warning(
        self,
        claim: RevalidationClaim,
        *,
        error_category: str,
        attempts: int,
        error: str,
        audits: Sequence[Mapping[str, Any]] = (),
        run_id: Optional[str] = None,
    ) -> None:
        if error_category not in {"protocol", "structure", "external", "budget", "context"}:
            raise ValueError("invalid revalidation warning category")
        if type(attempts) is not int or attempts < 1:
            raise ValueError("warning fallback attempts must be a positive integer")
        stale_change_ids = sorted(
            {
                int(case["change_id"])
                for case in claim.payload.get("cases", ())
                if isinstance(case, Mapping) and type(case.get("change_id")) is int
            }
        )
        self.commit_revalidation_resolution(
            claim,
            status="completed_with_warning",
            action="warning_fallback",
            result={
                "reason": "retranslation_attempts_exhausted",
                "error_category": error_category,
                "attempts": attempts,
                "error": str(error)[:1024],
                "stale_change_ids": stale_change_ids,
            },
            audits=audits,
            run_id=run_id,
        )

    def unfinished_revalidation_count(self) -> int:
        with closing(self.connect()) as connection:
            return int(
                connection.execute(
                    """SELECT COUNT(*) FROM revalidation_tasks
                       WHERE status IN ('pending', 'validating')"""
                ).fetchone()[0]
            )

    def warning_revalidation_count(self) -> int:
        with closing(self.connect()) as connection:
            return int(
                connection.execute(
                    """SELECT COUNT(*) FROM revalidation_tasks
                       WHERE status='completed_with_warning'"""
                ).fetchone()[0]
            )

    def fail_revalidation_task(
        self,
        claim: RevalidationClaim,
        error: str,
        *,
        audits: Sequence[Mapping[str, Any]] = (),
        run_id: Optional[str] = None,
    ) -> None:
        self.complete_with_warning(
            claim,
            error_category="protocol",
            attempts=1,
            error=error,
            audits=audits,
            run_id=run_id,
        )

    def request_repair(self, block_identifier: str, issues: Sequence[str]) -> str:
        block = self.get_block_by_identifier(block_identifier)
        issue_list = [str(issue) for issue in issues if str(issue).strip()]
        task_id = stable_id(
            "repair",
            f"{block.id}:{json.dumps(issue_list, ensure_ascii=False, sort_keys=True)}",
            length=24,
        )
        with self.transaction() as connection:
            connection.execute(
                """INSERT OR IGNORE INTO repair_tasks(
                       id, block_id, status, issues_json, requested_at
                   ) VALUES(?, ?, 'open', ?, ?)""",
                (task_id, block.id, json.dumps(issue_list, ensure_ascii=False), utc_now()),
            )
        return task_id

    def list_repair_tasks(self, status: str = "open") -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            return [
                dict(row)
                for row in connection.execute(
                    """SELECT r.*, b.legacy_id FROM repair_tasks r
                       JOIN blocks b ON b.id=r.block_id
                       WHERE r.status=? ORDER BY r.requested_at""",
                    (status,),
                )
            ]

    def commit_repair_result(
        self,
        run_id: str,
        task_id: str,
        final_translation: str,
        audit: Dict[str, Any],
    ) -> int:
        """Commit one repaired translation as a new active version."""
        with self.transaction() as connection:
            task = connection.execute(
                "SELECT * FROM repair_tasks WHERE id=?", (task_id,)
            ).fetchone()
            if task is None:
                raise KeyError(f"修复任务不存在: {task_id}")
            if task["status"] != "open":
                raise ValueError(f"修复任务已处理: {task_id}")
            previous = connection.execute(
                """SELECT * FROM translation_versions
                   WHERE block_id=? AND pipeline='parallel_v4' AND active=1""",
                (task["block_id"],),
            ).fetchone()
            if previous is None:
                raise ValueError("当前文本块没有活动译文版本")
            version = int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            connection.execute(
                """UPDATE translation_versions SET active=0
                   WHERE block_id=? AND pipeline='parallel_v4' AND active=1""",
                (task["block_id"],),
            )
            cursor = connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, run_id, knowledge_version, status,
                       draft_translation, final_translation, analysis,
                       semantic_obligations, memory_summary, warnings_json,
                       active, created_at
                    ) VALUES(?, 'parallel_v4', ?, ?, 'completed', ?, ?, ?, ?, ?, '[]', 1, ?)""",
                (
                    task["block_id"],
                    run_id,
                    version,
                    previous["draft_translation"],
                    final_translation,
                    previous["analysis"],
                    previous["semantic_obligations"],
                    previous["memory_summary"],
                    utc_now(),
                ),
            )
            translation_id = int(cursor.lastrowid)
            connection.execute(
                """INSERT OR IGNORE INTO dependencies(
                       translation_id, dependency_type, dependency_id, knowledge_version
                   ) SELECT ?, dependency_type, dependency_id, ?
                     FROM dependencies WHERE translation_id=?""",
                (translation_id, version, previous["id"]),
            )
            self.record_audit_call(
                run_id=run_id,
                block_id=task["block_id"],
                purpose="repair",
                model=str(audit.get("model") or "unknown"),
                knowledge_version=version,
                request=dict(audit.get("request") or {}),
                raw_response=str(audit.get("raw_response") or ""),
                parsed=audit.get("parsed"),
                accepted=True,
                attempts=int(audit.get("attempts") or 1),
                elapsed_ms=int(audit.get("elapsed_ms") or 0),
                error=None,
                connection=connection,
            )
            connection.execute(
                "UPDATE blocks SET status='completed', last_error=NULL, updated_at=? WHERE id=?",
                (utc_now(), task["block_id"]),
            )
            connection.execute(
                """UPDATE repair_tasks
                   SET status='completed', resolved_at=?, translation_id=? WHERE id=?""",
                (utc_now(), translation_id, task_id),
            )
            return translation_id

    def commit_repair_failure(
        self,
        task_id: str,
        error: str,
        run_id: Optional[str] = None,
        audit: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Keep the current translation active and route a failed repair to humans."""
        with self.transaction() as connection:
            task = connection.execute(
                "SELECT * FROM repair_tasks WHERE id=?", (task_id,)
            ).fetchone()
            if task is None:
                raise KeyError(f"修复任务不存在: {task_id}")
            if task["status"] != "open":
                return
            version = int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            if audit is not None and run_id:
                self.record_audit_call(
                    run_id=run_id,
                    block_id=task["block_id"],
                    purpose="repair",
                    model=str(audit.get("model") or "unknown"),
                    knowledge_version=version,
                    request=dict(audit.get("request") or {}),
                    raw_response=str(audit.get("raw_response") or ""),
                    parsed=audit.get("parsed"),
                    accepted=False,
                    attempts=int(audit.get("attempts") or 1),
                    elapsed_ms=int(audit.get("elapsed_ms") or 0),
                    error=error,
                    connection=connection,
                )
            connection.execute(
                "UPDATE repair_tasks SET status='needs_human', resolved_at=? WHERE id=?",
                (utc_now(), task_id),
            )
            connection.execute(
                """INSERT INTO human_queue(
                       block_id, kind, severity, payload_json, created_at
                   ) VALUES(?, 'repair_failed', 'high', ?, ?)""",
                (
                    task["block_id"],
                    json.dumps(
                        {
                            "repair_task_id": task_id,
                            "issues": json.loads(task["issues_json"]),
                            "error": error,
                        },
                        ensure_ascii=False,
                    ),
                    utc_now(),
                ),
            )

    def commit_verification_result(
        self,
        run_id: str,
        task: Dict[str, Any],
        votes: Sequence[Dict[str, Any]],
        return_change_ids: bool = False,
    ) -> str | Dict[str, Any]:
        with self.transaction() as connection:
            current = connection.execute(
                "SELECT status FROM verification_tasks WHERE id=?",
                (task["id"],),
            ).fetchone()
            if current is None:
                raise KeyError(f"核验任务不存在: {task['id']}")
            if current["status"] != "open":
                current_status = str(current["status"])
                return (
                    {"status": current_status, "change_ids": []}
                    if return_change_ids
                    else current_status
                )
            change_ids: list[int] = []
            version = int(connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0])
            for index, vote in enumerate(votes, start=1):
                audit_id = self.record_audit_call(
                    run_id=run_id,
                    block_id=None,
                    purpose="verify",
                    model=str(vote.get("model") or "unknown"),
                    knowledge_version=version,
                    request=dict(vote.get("request") or {}),
                    raw_response=str(vote.get("raw_response") or ""),
                    parsed=vote.get("parsed"),
                    accepted=bool(vote.get("accepted")),
                    attempts=int(vote.get("attempts") or 1),
                    elapsed_ms=int(vote.get("elapsed_ms") or 0),
                    error=vote.get("error"),
                    connection=connection,
                )
                parsed = vote.get("parsed") or {
                    "verdict": "uncertain",
                    "rationale": vote.get("error") or "核验输出无效",
                    "evidence_quotes": [],
                }
                connection.execute(
                    """INSERT INTO verification_votes(
                           task_id, verifier_index, verdict, rationale, evidence_json,
                           audit_call_id, created_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?)""",
                    (
                        task["id"],
                        index,
                        parsed["verdict"],
                        parsed["rationale"],
                        json.dumps(parsed.get("evidence_quotes") or [], ensure_ascii=False),
                        audit_id,
                        utc_now(),
                    ),
                )
            supported = (
                len(votes) >= int(task.get("required_votes") or 2)
                and all((vote.get("parsed") or {}).get("verdict") == "support" for vote in votes)
            )
            if supported:
                old_render_state = (
                    self._render_state_for_subject(
                        connection, "concept", str(task["subject_id"])
                    )
                    if task["subject_type"] == "concept"
                    else None
                )
                old_claim_state = (
                    self._claim_state_for_subject(
                        connection, str(task["subject_id"])
                    )
                    if task["subject_type"] == "claim"
                    else None
                )
                version = self.create_knowledge_version(
                    f"double verification {task['id']}", connection
                )
                if task["subject_type"] == "concept":
                    connection.execute(
                        """UPDATE concepts SET status='verified',
                               verified_target=CASE
                                   WHEN verified_target!='' THEN verified_target
                                   WHEN working_target!='' THEN working_target
                                   ELSE default_target END
                           WHERE id=? AND locked=0""",
                        (task["subject_id"],),
                    )
                    connection.execute(
                        "UPDATE rendering_rules SET status='verified' WHERE concept_id=? AND locked=0",
                        (task["subject_id"],),
                    )
                    new_render_state = self._render_state_for_subject(
                        connection, "concept", str(task["subject_id"])
                    )
                    change = self.record_render_change(
                        connection,
                        subject_type="concept",
                        subject_id=str(task["subject_id"]),
                        old_state=old_render_state or {},
                        new_state=new_render_state,
                        change_kind=(
                            "rendering_rule"
                            if (old_render_state or {}).get("rules")
                            != new_render_state.get("rules")
                            else "target"
                        ),
                        reason=f"double verification {task['id']}",
                        knowledge_version=version,
                    )
                    if change["change_id"] is not None:
                        change_ids.append(int(change["change_id"]))
                elif task["subject_type"] == "claim":
                    connection.execute(
                        "UPDATE claims SET status='verified' WHERE id=? AND locked=0",
                        (task["subject_id"],),
                    )
                    change = self.record_render_change(
                        connection,
                        subject_type="claim",
                        subject_id=str(task["subject_id"]),
                        old_state=old_claim_state or {},
                        new_state=self._claim_state_for_subject(
                            connection, str(task["subject_id"])
                        ),
                        change_kind="claim",
                        reason=f"double verification {task['id']}",
                        knowledge_version=version,
                    )
                    if change["change_id"] is not None:
                        change_ids.append(int(change["change_id"]))
                status = "verified"
            else:
                status = "needs_human"
                payload = {
                    "verification_task_id": task["id"],
                    "subject_type": task["subject_type"],
                    "subject_id": task["subject_id"],
                    "proposal": json.loads(task["payload_json"]),
                    "votes": [vote.get("parsed") for vote in votes],
                }
                connection.execute(
                    """INSERT INTO human_queue(
                           block_id, kind, severity, payload_json, created_at
                       ) VALUES(NULL, 'high_impact_verification', 'high', ?, ?)""",
                    (json.dumps(payload, ensure_ascii=False), utc_now()),
                )
            connection.execute(
                "UPDATE verification_tasks SET status=?, resolved_at=? WHERE id=?",
                (status, utc_now(), task["id"]),
            )
            if return_change_ids:
                return {"status": status, "change_ids": sorted(set(change_ids))}
            return status

    def list_human_queue(self, status: str = "open") -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT h.*, b.legacy_id
                   FROM human_queue h LEFT JOIN blocks b ON b.id=h.block_id
                   WHERE h.status=? ORDER BY h.id""",
                (status,),
            ).fetchall()
            return [dict(row) for row in rows]

    def resolve_human_item(self, item_id: int, action: str) -> Dict[str, Any]:
        if action not in {"accept", "reject", "retry"}:
            raise ValueError("action 必须是 accept、reject 或 retry")
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM human_queue WHERE id=?",
                (item_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"人工队列项不存在: {item_id}")
            if row["status"] != "open":
                raise ValueError(f"人工队列项 {item_id} 已处理: {row['status']}")
            change_ids: list[int] = []
            if action == "retry":
                if row["kind"] == "context_overflow" and row["block_id"]:
                    connection.execute(
                        "UPDATE blocks SET status=?, last_error=NULL, updated_at=? WHERE id=?",
                        (V4BlockStatus.READY.value, utc_now(), row["block_id"]),
                    )
                elif row["kind"] == "repair_failed":
                    payload = json.loads(row["payload_json"])
                    task_id = payload.get("repair_task_id")
                    if not task_id:
                        raise ValueError("修复失败队列项缺少repair_task_id")
                    connection.execute(
                        """UPDATE repair_tasks SET status='open', resolved_at=NULL
                           WHERE id=? AND status='needs_human'""",
                        (task_id,),
                    )
                else:
                    raise ValueError("只有 context_overflow 或 repair_failed 队列项可以重试")
                connection.execute(
                    "UPDATE human_queue SET status='retried', resolved_at=? WHERE id=?",
                    (utc_now(), item_id),
                )
                return {
                    "id": item_id,
                    "status": "retried",
                    "knowledge_version": None,
                    "affected_translations": 0,
                    "change_ids": [],
                }
            if row["kind"] == "high_impact_verification":
                payload = json.loads(row["payload_json"])
                subject_type = payload.get("subject_type")
                subject_id = payload.get("subject_id")
                old_render_state = (
                    self._render_state_for_subject(
                        connection, "concept", str(subject_id)
                    )
                    if subject_type == "concept"
                    else None
                )
                old_claim_state = (
                    self._claim_state_for_subject(connection, str(subject_id))
                    if subject_type == "claim"
                    else None
                )
                version = self.create_knowledge_version(
                    f"human {action} high impact item {item_id}", connection
                )
                if subject_type == "concept":
                    if action == "accept":
                        replacement_target = str(
                            (payload.get("proposal") or {}).get("target") or ""
                        ).strip()
                        connection.execute(
                            """UPDATE concepts SET
                                   default_target=CASE WHEN ?!='' THEN ? ELSE default_target END,
                                   working_target=CASE WHEN ?!='' THEN ? ELSE working_target END,
                                   verified_target=CASE WHEN ?!='' THEN ?
                                       WHEN verified_target!='' THEN verified_target
                                       WHEN working_target!='' THEN working_target
                                       ELSE default_target END,
                                   status='verified', locked=1 WHERE id=?""",
                            (
                                replacement_target,
                                replacement_target,
                                replacement_target,
                                replacement_target,
                                replacement_target,
                                replacement_target,
                                subject_id,
                            ),
                        )
                        if replacement_target:
                            connection.execute(
                                """UPDATE rendering_rules SET retired_version=?
                                   WHERE concept_id=? AND retired_version IS NULL AND locked=0""",
                                (version, subject_id),
                            )
                            rule_id = stable_id(
                                "rule",
                                f"{subject_id}:human-default:{replacement_target}",
                            )
                            connection.execute(
                                """INSERT OR IGNORE INTO rendering_rules(
                                       id, concept_id, condition_json, target, priority,
                                       status, scope, locked, created_version, created_at
                                   ) VALUES(?, ?, '{}', ?, 100, 'verified', 'book', 1, ?, ?)""",
                                (
                                    rule_id,
                                    subject_id,
                                    replacement_target,
                                    version,
                                    utc_now(),
                                ),
                            )
                        else:
                            connection.execute(
                                """UPDATE rendering_rules
                                   SET status='verified', locked=1 WHERE concept_id=?""",
                                (subject_id,),
                            )
                    else:
                        connection.execute(
                            """UPDATE concepts SET status='rejected', retired_version=?
                               WHERE id=? AND locked=0""",
                            (version, subject_id),
                        )
                    new_render_state = self._render_state_for_subject(
                        connection, "concept", str(subject_id)
                    )
                    change = self.record_render_change(
                        connection,
                        subject_type="concept",
                        subject_id=str(subject_id),
                        old_state=old_render_state or {},
                        new_state=new_render_state,
                        change_kind=(
                            "human_lock"
                            if action == "accept"
                            else "high_impact_constraint"
                        ),
                        reason=f"human {action} high impact item {item_id}",
                        knowledge_version=version,
                    )
                    if change["change_id"] is not None:
                        change_ids.append(int(change["change_id"]))
                elif subject_type == "claim":
                    if action == "accept":
                        replacement_statement = str(
                            (payload.get("proposal") or {}).get("statement") or ""
                        ).strip()
                        connection.execute(
                            """UPDATE claims SET
                                   statement=CASE WHEN ?!='' THEN ? ELSE statement END,
                                   status='verified', locked=1 WHERE id=?""",
                            (replacement_statement, replacement_statement, subject_id),
                        )
                    else:
                        connection.execute(
                            """UPDATE claims SET status='rejected', retired_version=?
                               WHERE id=? AND locked=0""",
                            (version, subject_id),
                        )
                    change = self.record_render_change(
                        connection,
                        subject_type="claim",
                        subject_id=str(subject_id),
                        old_state=old_claim_state or {},
                        new_state=self._claim_state_for_subject(
                            connection, str(subject_id)
                        ),
                        change_kind="claim",
                        reason=f"human {action} high impact item {item_id}",
                        knowledge_version=version,
                    )
                    if change["change_id"] is not None:
                        change_ids.append(int(change["change_id"]))
                resolved_status = "accepted" if action == "accept" else "rejected"
                connection.execute(
                    "UPDATE human_queue SET status=?, resolved_at=? WHERE id=?",
                    (resolved_status, utc_now(), item_id),
                )
                return {
                    "id": item_id,
                    "status": resolved_status,
                    "knowledge_version": version,
                    "affected_translations": 0,
                    "change_ids": sorted(set(change_ids)),
                }
            if row["kind"] != "translation_proposal":
                raise ValueError("该队列项不是可接受或拒绝的知识建议")
            payload = json.loads(row["payload_json"])
            proposal_kind = payload.get("proposal_kind")
            proposal = payload.get("payload") or {}
            version: Optional[int] = None
            if proposal_kind == "term" and proposal.get("src"):
                source = str(proposal["src"]).strip()
                target = str(proposal.get("tgt") or "").strip()
                concept_id = stable_id("concept", normalize_english_form(source))
                concept = connection.execute(
                    """SELECT c.*, kv.reason created_reason
                       FROM concepts c JOIN knowledge_versions kv ON kv.id=c.created_version
                       WHERE c.id=? AND c.retired_version IS NULL""",
                    (concept_id,),
                ).fetchone()
                old_render_state = self._render_state_for_subject(
                    connection, "concept", concept_id
                )
                if action == "accept":
                    version = self.create_knowledge_version(
                        f"human accept queue item {item_id}", connection
                    )
                    if concept is None:
                        connection.execute(
                            """INSERT INTO concepts(
                                   id, kind, canonical_source, default_target,
                                   working_target, verified_target, description,
                                   status, scope, locked, created_version, created_at
                               ) VALUES(?, ?, ?, ?, ?, ?, ?, 'verified', 'book', 1, ?, ?)""",
                            (
                                concept_id,
                                proposal.get("type") or "concept",
                                source,
                                target,
                                target,
                                target,
                                proposal.get("context") or "",
                                version,
                                utc_now(),
                            ),
                        )
                        lexeme_id = self._ensure_schema8_lexeme(
                            connection,
                            source,
                            normalized_form=normalize_english_form(source),
                            concept_id=concept_id,
                            knowledge_version=version,
                        )
                        connection.execute(
                            """INSERT INTO source_forms(
                                   lexeme_id, form, normalized_form, grammar_json
                               ) VALUES(?, ?, ?, '{}')""",
                            (lexeme_id, source, normalize_english_form(source)),
                        )
                    else:
                        connection.execute(
                            """UPDATE concepts SET default_target=?, working_target=?,
                                      verified_target=?, status='verified', locked=1
                               WHERE id=?""",
                            (target, target, target, concept_id),
                        )
                    if target:
                        rule_id = stable_id("rule", f"{concept_id}:human-default:{target}")
                        connection.execute(
                            """INSERT OR IGNORE INTO rendering_rules(
                                   id, concept_id, condition_json, target, priority, status,
                                   scope, locked, created_version, created_at
                               ) VALUES(?, ?, '{}', ?, 100, 'verified', 'book', 1, ?, ?)""",
                            (rule_id, concept_id, target, version, utc_now()),
                        )
                elif (
                    concept is not None
                    and str(concept["created_reason"]).startswith("translation proposals")
                    and not concept["locked"]
                ):
                    version = self.create_knowledge_version(
                        f"human reject queue item {item_id}", connection
                    )
                    connection.execute(
                        "UPDATE concepts SET status='rejected', retired_version=? WHERE id=?",
                        (version, concept_id),
                    )
                if version is not None:
                    new_render_state = self._render_state_for_subject(
                        connection, "concept", concept_id
                    )
                    change = self.record_render_change(
                        connection,
                        subject_type="concept",
                        subject_id=concept_id,
                        old_state=old_render_state,
                        new_state=new_render_state,
                        change_kind=(
                            "human_lock"
                            if action == "accept"
                            else "high_impact_constraint"
                        ),
                        reason=f"human {action} queue item {item_id}",
                        knowledge_version=version,
                    )
                    if change["change_id"] is not None:
                        change_ids.append(int(change["change_id"]))
            resolved_status = "accepted" if action == "accept" else "rejected"
            connection.execute(
                "UPDATE human_queue SET status=?, resolved_at=? WHERE id=?",
                (resolved_status, utc_now(), item_id),
            )
            return {
                "id": item_id,
                "status": resolved_status,
                "knowledge_version": version,
                "affected_translations": 0,
                "change_ids": sorted(set(change_ids)),
            }

    def amend_human_item(self, item_id: int, replacement: str) -> Dict[str, Any]:
        replacement = replacement.strip()
        if not replacement:
            raise ValueError("修改内容不能为空")
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM human_queue WHERE id=? AND status='open'",
                (item_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"待处理人工队列项不存在: {item_id}")
            payload = json.loads(row["payload_json"])
            if row["kind"] == "translation_proposal":
                proposal = payload.get("payload") or {}
                if payload.get("proposal_kind") != "term":
                    raise ValueError("只有术语建议支持编辑后接受")
                proposal["tgt"] = replacement
                payload["payload"] = proposal
            elif row["kind"] == "high_impact_verification":
                proposal = payload.get("proposal") or {}
                if payload.get("subject_type") == "concept":
                    proposal["target"] = replacement
                elif payload.get("subject_type") == "claim":
                    proposal["statement"] = replacement
                else:
                    raise ValueError("不支持编辑该高影响建议")
                payload["proposal"] = proposal
            else:
                raise ValueError("该队列项不支持编辑")
            connection.execute(
                "UPDATE human_queue SET payload_json=? WHERE id=?",
                (json.dumps(payload, ensure_ascii=False), item_id),
            )
            return {"id": item_id, "payload": payload, "change_ids": []}

    def export_rows(self, pipeline: str = "parallel_v4") -> List[Dict[str, Any]]:
        with closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT b.*, tv.status translation_status, tv.draft_translation,
                          tv.final_translation, tv.analysis, tv.memory_summary,
                          tv.warnings_json, tv.validation_status,
                          tv.validated_knowledge_version,
                          tv.validation_fingerprint,
                          (SELECT task.id FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_task_id,
                          (SELECT task.status FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_task_status,
                          (SELECT task.action FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_task_action,
                          (SELECT task.from_knowledge_version
                             FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_from_knowledge_version,
                          (SELECT task.to_knowledge_version
                             FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_to_knowledge_version,
                          (SELECT task.result_json FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_result_json,
                          (SELECT task.error FROM revalidation_tasks task
                            WHERE task.translation_id=tv.id
                            ORDER BY task.created_at DESC, task.id DESC LIMIT 1)
                              revalidation_error
                   FROM blocks b
                   LEFT JOIN translation_versions tv
                     ON tv.block_id=b.id AND tv.pipeline=? AND tv.active=1
                   WHERE b.source_edition_id=(SELECT id FROM source_editions WHERE active=1)
                   ORDER BY b.global_index""",
                (pipeline,),
            ).fetchall()
            return [dict(row) for row in rows]

    def inspect_narrative_memory(
        self,
        *,
        block_id: str | None = None,
        subject_id: str | None = None,
        memory_type: str | None = None,
        limit: int = 200,
    ) -> Dict[str, Any]:
        from .narrative_memory import NarrativeMemoryStore

        return NarrativeMemoryStore(self).inspect(
            block_id=block_id,
            subject_id=subject_id,
            memory_type=memory_type,
            limit=limit,
        )

    def status_summary(self) -> Dict[str, Any]:
        with closing(self.connect()) as connection:
            summary = {
                (
                    "legacy_needs_revalidate"
                    if row["status"] == V4BlockStatus.NEEDS_REVALIDATE.value
                    else row["status"]
                ): int(row["count"])
                for row in connection.execute(
                    """SELECT status, COUNT(*) count FROM blocks
                       WHERE source_edition_id=(SELECT id FROM source_editions WHERE active=1)
                       GROUP BY status ORDER BY status"""
                )
            }
            for block_status in V4BlockStatus:
                key = (
                    "legacy_needs_revalidate"
                    if block_status is V4BlockStatus.NEEDS_REVALIDATE
                    else block_status.value
                )
                summary.setdefault(key, 0)
            derived = connection.execute(
                """SELECT COUNT(DISTINCT tv.block_id) block_count,
                          COUNT(DISTINCT task.translation_id) translation_count
                   FROM revalidation_tasks task
                   JOIN translation_versions tv
                     ON tv.id=task.translation_id AND tv.active=1
                   JOIN blocks b ON b.id=tv.block_id
                   JOIN source_editions edition
                     ON edition.id=b.source_edition_id AND edition.active=1
                   WHERE task.status IN ('pending','validating')"""
            ).fetchone()
            summary["needs_revalidate"] = int(derived["block_count"])
            summary["needs_revalidate_translations"] = int(
                derived["translation_count"]
            )
            summary["active_lexemes"] = int(
                connection.execute(
                    "SELECT COUNT(*) FROM lexemes WHERE retired_version IS NULL"
                ).fetchone()[0]
            )
            summary["active_concepts"] = int(
                connection.execute(
                    "SELECT COUNT(*) FROM concepts WHERE retired_version IS NULL"
                ).fetchone()[0]
            )
            summary["lexemes"] = summary["active_lexemes"]
            summary["concepts"] = summary["active_concepts"]

            coreference = {
                (str(row["decision_source"]), str(row["relation"])): int(
                    row["count"]
                )
                for row in connection.execute(
                    """SELECT decision_source, relation, COUNT(*) count
                       FROM coreference_decisions
                       WHERE retired_version IS NULL
                       GROUP BY decision_source, relation"""
                )
            }
            summary["coreference_deterministic_merges"] = coreference.get(
                ("deterministic", "same"), 0
            )
            summary["coreference_model_merges"] = coreference.get(
                ("dual_model", "same"), 0
            )
            for relation in ("different", "non_entity", "uncertain"):
                summary[f"coreference_{relation}"] = sum(
                    count
                    for (source, value), count in coreference.items()
                    if value == relation
                )
            summary["coreference_model_calls"] = int(
                connection.execute(
                    """SELECT COUNT(*) FROM audit_calls
                       WHERE purpose IN ('coreference', 'dual_model_coreference')"""
                ).fetchone()[0]
            )
            summary["coreference_conflicts"] = coreference.get(
                ("dual_model", "uncertain"), 0
            )
            summary["coreference_protocol_failures"] = int(
                connection.execute(
                    """SELECT COUNT(*) FROM audit_calls
                       WHERE purpose IN ('coreference', 'dual_model_coreference')
                         AND accepted=0 AND error IS NOT NULL"""
                ).fetchone()[0]
            )
            summary["coreference_fallbacks"] = int(
                connection.execute(
                    "SELECT COUNT(*) FROM audit_calls WHERE purpose='coreference_fallback'"
                ).fetchone()[0]
            )
            for short_name in (
                "deterministic_merges",
                "model_merges",
                "different",
                "non_entity",
                "uncertain",
                "model_calls",
                "conflicts",
                "protocol_failures",
                "fallbacks",
            ):
                summary[short_name] = summary[f"coreference_{short_name}"]

            revalidation_statuses = (
                "pending",
                "validating",
                "resolved_noop",
                "resolved_patch",
                "resolved_retranslate",
                "completed_with_warning",
            )
            status_counts = {
                str(row["status"]): int(row["count"])
                for row in connection.execute(
                    "SELECT status, COUNT(*) count FROM revalidation_tasks GROUP BY status"
                )
            }
            for status in revalidation_statuses:
                summary[f"revalidation_{status}"] = status_counts.get(status, 0)
            for status in (
                "resolved_noop",
                "resolved_patch",
                "resolved_retranslate",
                "completed_with_warning",
            ):
                summary[status] = summary[f"revalidation_{status}"]
            impact_counts = {
                int(row["impact_level"]): int(row["count"])
                for row in connection.execute(
                    """SELECT impact_level, COUNT(*) count
                       FROM revalidation_tasks GROUP BY impact_level"""
                )
            }
            for impact in range(4):
                summary[f"revalidation_impact_{impact}"] = impact_counts.get(
                    impact, 0
                )
                summary[f"impact_{impact}"] = summary[
                    f"revalidation_impact_{impact}"
                ]
            summary["warning_stale"] = int(
                connection.execute(
                    """SELECT COUNT(*) FROM translation_versions
                       WHERE active=1 AND pipeline='parallel_v4'
                         AND validation_status='warning_stale'"""
                ).fetchone()[0]
            )

            summary["current_knowledge_epoch"] = 0
            summary["knowledge_epoch"] = 0
            summary["staged_proposals"] = 0
            summary["frozen_proposals"] = 0
            epoch_row = connection.execute(
                """SELECT config_json FROM runs
                   WHERE stage='translate' ORDER BY started_at DESC, id DESC LIMIT 1"""
            ).fetchone()
            if epoch_row is not None:
                try:
                    run_config = json.loads(str(epoch_row["config_json"] or "{}"))
                    epoch_state = run_config.get("knowledge_epoch_state") or {}
                    summary["current_knowledge_epoch"] = int(
                        epoch_state.get("ordinal") or 0
                    )
                    summary["knowledge_epoch"] = summary[
                        "current_knowledge_epoch"
                    ]
                    summary["staged_proposals"] = sum(
                        len(entry.get("term_proposals") or ())
                        + len(entry.get("relation_proposals") or ())
                        for entry in epoch_state.get("staged") or ()
                        if isinstance(entry, dict)
                    )
                    summary["frozen_proposals"] = int(
                        epoch_state.get("deferred_proposals") or 0
                    )
                except (TypeError, ValueError, json.JSONDecodeError):
                    pass

            optional_severities = ("warning", "review", "low")
            placeholders = ",".join("?" for _ in optional_severities)
            summary["optional_human_queue"] = int(
                connection.execute(
                    f"""SELECT COUNT(*) FROM human_queue
                        WHERE status='open' AND severity IN ({placeholders})""",
                    optional_severities,
                ).fetchone()[0]
            )
            summary["blocking_human_queue"] = int(
                connection.execute(
                    f"""SELECT COUNT(*) FROM human_queue
                        WHERE status='open' AND severity NOT IN ({placeholders})""",
                    optional_severities,
                ).fetchone()[0]
            )
            summary["open_human_queue"] = (
                summary["optional_human_queue"]
                + summary["blocking_human_queue"]
            )
            summary["knowledge_version"] = int(
                connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
            )
            summary["memory_version"] = int(
                connection.execute(
                    "SELECT COALESCE(MAX(id), 1) FROM memory_versions"
                ).fetchone()[0]
            )
            summary["premap_cursor"] = int(
                connection.execute(
                    """SELECT COALESCE(MAX(block.global_index), -1)
                       FROM premap_results premap
                       JOIN blocks block ON block.id=premap.block_id
                       JOIN source_editions edition
                         ON edition.id=block.source_edition_id
                        AND edition.active=1
                       WHERE premap.snapshot_id IS NOT NULL"""
                ).fetchone()[0]
            )
            summary["translation_cursor"] = int(
                connection.execute(
                    """SELECT COALESCE(MAX(block.global_index), -1)
                       FROM translation_versions translation
                       JOIN blocks block ON block.id=translation.block_id
                       JOIN source_editions edition
                         ON edition.id=block.source_edition_id
                        AND edition.active=1
                       WHERE translation.pipeline='parallel_v4'
                         AND translation.active=1"""
                ).fetchone()[0]
            )
            premap_calls = int(
                connection.execute(
                    """SELECT COUNT(*) FROM audit_calls
                       WHERE purpose='narrative_premap'"""
                ).fetchone()[0]
            )
            premap_hits = int(
                connection.execute(
                    """SELECT COUNT(*) FROM audit_calls
                       WHERE purpose='narrative_premap_cache_hit'"""
                ).fetchone()[0]
            )
            premap_total = premap_calls + premap_hits
            summary["premap_cache_hits"] = premap_hits
            summary["premap_model_calls"] = premap_calls
            summary["premap_cache_hit_rate"] = (
                round(premap_hits / premap_total, 6)
                if premap_total
                else 0.0
            )
            summary["degraded_premap_blocks"] = int(
                connection.execute(
                    """SELECT COUNT(DISTINCT block_id) FROM premap_results
                       WHERE status='degraded'"""
                ).fetchone()[0]
            )
            summary["unresolved_narrative_references"] = int(
                connection.execute(
                    """SELECT COALESCE(SUM(
                           json_array_length(
                               json_extract(snapshot.discourse_state_json,
                                            '$.unresolved_references')
                           )
                       ), 0)
                       FROM narrative_snapshots snapshot
                       WHERE snapshot.id=(
                           SELECT latest.id FROM narrative_snapshots latest
                           WHERE latest.block_id=snapshot.block_id
                           ORDER BY latest.memory_version DESC,
                                    latest.knowledge_version DESC,
                                    latest.created_at DESC, latest.id DESC
                           LIMIT 1
                       )"""
                ).fetchone()[0]
            )
            summary["disputed_narrative_memories"] = int(
                connection.execute(
                    """SELECT COUNT(*) FROM narrative_memories
                       WHERE status='disputed' OR truth_status='disputed'"""
                ).fetchone()[0]
            )
            summary["memory_revalidation_tasks"] = int(
                connection.execute(
                    """SELECT COUNT(*) FROM revalidation_tasks
                       WHERE change_domain='memory'"""
                ).fetchone()[0]
            )
            volatility_counts = {"low": 0, "medium": 0, "high": 0}
            for row in connection.execute(
                """SELECT CAST(json_extract(
                              validation_json, '$.metrics.volatility'
                           ) AS INTEGER) volatility
                   FROM premap_results
                   WHERE json_type(
                       validation_json, '$.metrics.volatility'
                   ) IS NOT NULL"""
            ):
                volatility = int(row["volatility"])
                bucket = (
                    "high"
                    if volatility >= 65
                    else "medium" if volatility >= 35 else "low"
                )
                volatility_counts[bucket] += 1
            for bucket, count in volatility_counts.items():
                summary[f"narrative_volatility_{bucket}"] = count
            return summary

    def review_warning_sections(self) -> Dict[str, List[Dict[str, Any]]]:
        """Return advisory schema-8 queues separately from blocking workflow state."""

        with closing(self.connect()) as connection:
            uncertain = [
                dict(row)
                for row in connection.execute(
                    """SELECT decision.*, lexeme.canonical_form
                       FROM coreference_decisions decision
                       JOIN lexemes lexeme ON lexeme.id=decision.lexeme_id
                       WHERE decision.retired_version IS NULL
                         AND decision.relation='uncertain'
                       ORDER BY decision.created_at, decision.id"""
                )
            ]
            render_conflicts = []
            for row in connection.execute(
                """SELECT queue.*, block.legacy_id
                   FROM human_queue queue
                   LEFT JOIN blocks block ON block.id=queue.block_id
                   WHERE queue.status='open'
                     AND queue.kind IN ('render_rule_conflict', 'schema8_target_conflict')
                   ORDER BY queue.id"""
            ):
                item = dict(row)
                item["payload"] = json.loads(item.pop("payload_json") or "{}")
                render_conflicts.append(item)
            stale = []
            for row in connection.execute(
                """SELECT block.id block_id, block.legacy_id,
                          translation.id translation_id,
                          translation.knowledge_version old_knowledge_version,
                          task.id task_id, task.status task_status,
                          task.action, task.from_knowledge_version,
                          task.to_knowledge_version, task.result_json, task.error
                   FROM translation_versions translation
                   JOIN blocks block ON block.id=translation.block_id
                   LEFT JOIN revalidation_tasks task ON task.id=(
                       SELECT latest.id FROM revalidation_tasks latest
                       WHERE latest.translation_id=translation.id
                       ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
                   )
                   WHERE translation.active=1
                     AND translation.pipeline='parallel_v4'
                     AND translation.validation_status='warning_stale'
                   ORDER BY block.global_index"""
            ):
                item = dict(row)
                item["result"] = json.loads(item.pop("result_json") or "{}")
                stale.append(item)
            return {
                "uncertain_coreference": uncertain,
                "render_conflicts": render_conflicts,
                "warning_stale": stale,
            }
