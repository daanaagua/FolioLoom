"""Deterministic post-translation checks for contextual term profiles."""

from __future__ import annotations

from typing import Any, Dict, Mapping, Sequence

from .matcher import FrozenRenderIndex
from .models import RenderingMatchSnapshot


class TermConsistencyValidator:
    """Check allowed target families without rewriting translated prose."""

    @staticmethod
    def _allowed_targets(
        lexeme: Mapping[str, Any],
        concept_id: str | None,
    ) -> list[str]:
        targets: set[str] = set()
        for key in ("verified_target", "working_target", "default_target"):
            target = str(lexeme.get(key) or "").strip()
            if target:
                targets.add(target)
        for rule in list(lexeme.get("lexeme_rules") or []) + list(
            lexeme.get("rules") or []
        ):
            target = str(rule.get("target") or "").strip()
            if target:
                targets.add(target)
        for concept in lexeme.get("concepts") or []:
            if concept_id and str(concept.get("id") or "") != concept_id:
                continue
            for key in ("verified_target", "working_target", "default_target"):
                target = str(concept.get(key) or "").strip()
                if target:
                    targets.add(target)
            for rule in concept.get("rules") or []:
                target = str(rule.get("target") or "").strip()
                if target:
                    targets.add(target)
        return sorted(targets)

    @staticmethod
    def _profile(
        lexeme: Mapping[str, Any],
        concept_id: str | None,
    ) -> Mapping[str, Any]:
        for concept in lexeme.get("concepts") or []:
            if concept_id and str(concept.get("id") or "") != concept_id:
                continue
            profile = concept.get("term_profile") or {}
            if profile:
                return profile
        return lexeme.get("term_profile") or {}

    @staticmethod
    def _source_forms(lexeme: Mapping[str, Any]) -> set[str]:
        values = [
            lexeme.get("source"),
            lexeme.get("normalized_form"),
            *(lexeme.get("forms") or []),
        ]
        return {
            str(value).strip().casefold()
            for value in values
            if str(value or "").strip()
        }

    @classmethod
    def validate(
        cls,
        *,
        source_text: str,
        final_translation: str,
        matches: Sequence[RenderingMatchSnapshot],
        render_index: FrozenRenderIndex,
    ) -> list[Dict[str, Any]]:
        del source_text  # Reserved for paragraph-level alignment in a later revision.
        grouped: Dict[
            tuple[str, str | None], list[RenderingMatchSnapshot]
        ] = {}
        for match in matches:
            grouped.setdefault(
                (
                    str(match.lexeme_id),
                    str(match.concept_id) if match.concept_id else None,
                ),
                [],
            ).append(match)

        warnings: list[Dict[str, Any]] = []
        lexemes: Dict[
            tuple[str, str | None], Mapping[str, Any]
        ] = {}
        profiles: Dict[
            tuple[str, str | None], Mapping[str, Any]
        ] = {}
        warned_rule_expectations: set[
            tuple[str, str | None, str, tuple[str, ...]]
        ] = set()

        for group_key in sorted(
            grouped, key=lambda item: (item[0], item[1] or "")
        ):
            lexeme_id, concept_id = group_key
            lexeme = render_index.get_lexeme(lexeme_id) or {}
            if not lexeme:
                continue
            for match in grouped[group_key]:
                expected_target = str(match.rendered_target or "").strip()
                applied_rule_ids = tuple(
                    sorted(
                        str(rule_id)
                        for rule_id in match.applied_rule_ids
                        if str(rule_id)
                    )
                )
                expectation_key = (
                    lexeme_id,
                    concept_id,
                    expected_target,
                    applied_rule_ids,
                )
                if (
                    not expected_target
                    or not applied_rule_ids
                    or expected_target in final_translation
                    or expectation_key in warned_rule_expectations
                ):
                    continue
                warned_rule_expectations.add(expectation_key)
                warning = {
                    "kind": "term_rule_target_missing",
                    "lexeme_id": lexeme_id,
                    "source": str(lexeme.get("source") or ""),
                    "matched_form": str(match.matched_form),
                    "start_offset": int(match.start_offset),
                    "end_offset": int(match.end_offset),
                    "expected_target": expected_target,
                    "applied_rule_ids": list(applied_rule_ids),
                }
                if concept_id:
                    warning["concept_id"] = concept_id
                warnings.append(warning)
            profile = cls._profile(lexeme, concept_id)
            if not profile:
                continue
            allowed = cls._allowed_targets(lexeme, concept_id)
            for match in grouped[group_key]:
                target = str(match.rendered_target or "").strip()
                if target and target not in allowed:
                    allowed.append(target)
            allowed.sort()
            lexemes[group_key] = lexeme
            profiles[group_key] = profile
            if allowed and not any(
                target in final_translation for target in allowed
            ):
                warning = {
                    "kind": "term_target_missing",
                    "lexeme_id": lexeme_id,
                    "source": str(lexeme.get("source") or ""),
                    "matched_forms": sorted(
                        {
                            str(match.matched_form)
                            for match in grouped[group_key]
                        }
                    ),
                    "allowed_targets": allowed,
                }
                if concept_id:
                    warning["concept_id"] = concept_id
                warnings.append(warning)

        warned_pairs: set[
            tuple[tuple[str, str | None], tuple[str, str | None]]
        ] = set()
        ordered_profiles = sorted(
            profiles, key=lambda item: (item[0], item[1] or "")
        )
        for left_key in ordered_profiles:
            contrast_sources = {
                str(value).strip().casefold()
                for value in profiles[left_key].get("contrast_sources") or []
                if str(value).strip()
            }
            if not contrast_sources:
                continue
            left_targets = {
                str(match.rendered_target or "").strip()
                for match in grouped[left_key]
                if str(match.rendered_target or "").strip()
            }
            for right_key in ordered_profiles:
                if right_key == left_key:
                    continue
                if not (
                    contrast_sources & cls._source_forms(lexemes[right_key])
                ):
                    continue
                pair = tuple(
                    sorted(
                        (left_key, right_key),
                        key=lambda item: (item[0], item[1] or ""),
                    )
                )
                if pair in warned_pairs:
                    continue
                right_targets = {
                    str(match.rendered_target or "").strip()
                    for match in grouped[right_key]
                    if str(match.rendered_target or "").strip()
                }
                collisions = sorted(left_targets & right_targets)
                if not collisions:
                    continue
                warned_pairs.add(pair)
                warnings.append(
                    {
                        "kind": "term_contrast_target_collision",
                        "left_lexeme_id": pair[0][0],
                        "left_concept_id": pair[0][1],
                        "right_lexeme_id": pair[1][0],
                        "right_concept_id": pair[1][1],
                        "shared_targets": collisions,
                    }
                )
        return warnings
