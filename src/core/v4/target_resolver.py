"""Resolve provisional book-wide translations through bounded local aliases."""

from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Sequence
from uuid import uuid4

from .models import WorkingTargetResponse, WorkingTargetRule


TARGET_PROTOCOL = """CANONICAL WORKING-TARGET JSON PROTOCOL
The root object has exactly one key, "decisions". Its value is an array with one
object for every supplied concept. Each decision object has exactly these six keys:
"concept_id", "working_target", "semantic_core", "contrast_sources", "rules",
"confidence".
"concept_id" must be the supplied local Qxx alias. "working_target" must be a
non-empty Chinese string. "semantic_core" must be a concise, non-spoiling Chinese
description of the lexical meaning and boundaries relevant to translation.
"contrast_sources" must be an array of at most twelve English source forms that
the translation must keep semantically distinct; use [] when none are visible in
the supplied evidence. "confidence" must be a number from 0 through 1. "rules"
must be an array containing no more than six rule objects. Each rule object has
exactly these two keys: "condition", "target". "condition" must be a non-empty
JSON object whose concrete contextual property names and values are strings;
"target" must be a non-empty Chinese string.

This is a complete one-decision JSON template (use [] for rules when none apply):
{"decisions":[{"concept_id":"Q01","working_target":"示例译名","semantic_core":"非剧透的核心含义","contrast_sources":["executioner"],"rules":[{"condition":{"discourse_function":"vocative"},"target":"阁下"}],"confidence":0.95}]}

Do not use synonym keys such as "translation", "rule", "when", "id", or
"default_target". Never copy or invent an identifier. Do not return Markdown,
prose, schema commentary, or any keys other than the canonical keys above.
"""


TARGET_SYSTEM = f"""You choose provisional Chinese working translations for recurring
fictional names and terms. The main target must be a non-empty, stable book-wide
rendering. Add a contextual rule only when the same source form genuinely needs a
different Chinese rendering in a clearly expressible local condition. The semantic
core must preserve lexical distinctions without revealing later identities, twists,
or plot outcomes. Write both the working target and semantic core in natural
Simplified Chinese. The semantic core may state only the direct lexical denotation:
do not add character affiliations, aliases, organizations, story facts, or nearby
proper nouns merely because they occur in the same sentence. Contrast sources are
lexical neighbors, not story interpretations.
Any baseline_translations in the payload are non-authoritative stylistic evidence:
mine them for established Chinese wording, but keep a baseline term only when it
fits the English lexical core and the explicit contrast evidence.
For a recurring role, rank, or institutional profession, translate the occupational
identity established by the contexts; do not fall back to a generic action noun
when the evidence shows a formal office, guild, or social category. In those formal
contexts prefer an idiomatic Chinese occupational title over a raw agentive “X者”
calque. Do not invent Japanese-style or hybrid pseudo-titles, and do not add official
rank markers not supported by the evidence.

{TARGET_PROTOCOL}"""


TARGET_REVIEW_SYSTEM = f"""You are an independent bilingual lexicographic and
Chinese-register reviewer for a literary translation system. Review every supplied
proposal and return a complete corrected decision. The English source form is the
primary evidence: context may select its sense and register, but may not replace it
with an adjacent occupation, rank, object, or action. Back-translate every proposed
Chinese target. If its ordinary English equivalent is a different lexical item,
correct it and list that rejected English neighbor in contrast_sources. Preserve
every explicit lexical contrast in the evidence, such as jailer versus guard,
physician versus surgeon, or interrogator versus executioner.

For each recurring formal role, working_target is the neutral narrative occupational
noun. The evidence may contain self-identification, titles, or direct address. When
natural Chinese would name the role differently in direct address, add a rule whose
condition is {{"discourse_function":"vocative"}} and whose target is the idiomatic
address form. If self-identification alone requires a distinct form, use
{{"usage":"self_identification"}}. Prefer these concrete conditions over a vague
"formal context" label. Do not omit a necessary register rule merely to enforce
word-for-word consistency, and do not invent one when Chinese usage does not require
it.

semantic_core must be one short dictionary-style definition of what the source
lexeme denotes or what the role does. It must never state who employs the referent:
remove every affiliation, organization, alias, proper name, character fact, and plot
fact, including generic claims that the person belongs to an organization. Use
natural Simplified Chinese. Baseline translations are non-authoritative stylistic
evidence: prefer an idiomatic baseline term when it preserves the verified lexical
distinctions, but never copy surrounding baseline prose or inherit its factual
mistakes. Retain a correct proposal unchanged.

{TARGET_PROTOCOL}"""


def _target_retry_message(last_error: str) -> str:
    return (
        "The previous answer failed strict validation. Correct the complete answer "
        "and return it again. The full validator report follows:\n"
        f"{last_error}\n\n{TARGET_PROTOCOL}"
    )


class TargetResolutionProtocolError(ValueError):
    """The model response cannot be safely mapped to the current concept batch."""


class TargetResolver:
    def __init__(
        self,
        database: Any,
        llm: Any,
        max_attempts: int = 2,
        max_tokens: int = 8192,
        audit_mode: str = "full",
    ):
        if audit_mode not in {"full", "response", "minimal"}:
            raise ValueError("audit_mode must be full, response, or minimal")
        self.database = database
        self.llm = llm
        self.max_attempts = max(1, int(max_attempts))
        self.max_tokens = max(1, int(max_tokens))
        self.audit_mode = audit_mode

    @staticmethod
    def _clean_json(raw: str) -> str:
        text = str(raw).strip()
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        return text.strip()

    @staticmethod
    def _aliased_batch(
        concepts: Sequence[Dict[str, Any]],
    ) -> tuple[Dict[str, Dict[str, str]], Dict[str, Any]]:
        if not concepts or len(concepts) > 24:
            raise ValueError("a target-resolution batch must contain 1..24 concepts")
        alias_map: Dict[str, Dict[str, str]] = {}
        public = []
        for index, concept in enumerate(concepts, start=1):
            alias = f"Q{index:02d}"
            subject_type = str(concept.get("subject_type") or "lexeme")
            legacy = "subject_type" not in concept and "lexeme_id" not in concept
            subject_id = str(
                concept.get("subject_id")
                or concept.get("lexeme_id")
                or concept.get("concept_id")
            )
            alias_map[alias] = {
                "subject_type": subject_type,
                "subject_id": subject_id,
                "lexeme_id": str(concept.get("lexeme_id") or ""),
                "concept_id": str(concept.get("concept_id") or ""),
                "source": str(concept.get("source") or ""),
                "legacy": "1" if legacy else "0",
            }
            public.append(
                {
                    "concept_id": alias,
                    "subject_type": subject_type,
                    "source": concept["source"],
                    "kind": concept["kind"],
                    "description": concept.get("description") or "",
                    "contexts": list(concept.get("contexts") or [])[:4],
                    "baseline_translations": list(
                        concept.get("baseline_translations") or []
                    )[:3],
                }
            )
        return alias_map, {"concepts": public}

    @staticmethod
    def _resolve_response(
        parsed: WorkingTargetResponse,
        alias_map: Dict[str, Dict[str, str]],
    ) -> List[Dict[str, Any]]:
        decisions: Dict[str, Any] = {}
        for decision in parsed.decisions:
            alias = decision.concept_id
            if alias in decisions:
                raise TargetResolutionProtocolError(f"duplicate alias: {alias}")
            if alias not in alias_map:
                raise TargetResolutionProtocolError(f"unknown alias: {alias}")
            decisions[alias] = decision
        if set(decisions) != set(alias_map):
            raise TargetResolutionProtocolError("missing working-target alias")
        resolved: List[Dict[str, Any]] = []
        for alias in sorted(alias_map):
            decision = decisions[alias]
            allowed_latin = {
                token.casefold()
                for token in re.findall(
                    r"[A-Za-z][A-Za-z0-9_-]*",
                    alias_map[alias].get("source", ""),
                )
            }
            unexpected_latin = sorted(
                {
                    token
                    for token in re.findall(
                        r"[A-Za-z][A-Za-z0-9_-]*",
                        decision.semantic_core,
                    )
                    if token.casefold() not in allowed_latin
                },
                key=str.casefold,
            )
            if unexpected_latin:
                raise TargetResolutionProtocolError(
                    "semantic_core contains unsupported Latin story/name token(s) "
                    f"not licensed by the source form: {', '.join(unexpected_latin)}"
                )
            profile = {}
            if decision.semantic_core:
                profile["semantic_core"] = decision.semantic_core
            if decision.contrast_sources:
                profile["contrast_sources"] = list(decision.contrast_sources)
            resolved.append(
                (
                    {
                    "concept_id": alias_map[alias]["concept_id"],
                        "target": decision.working_target,
                        **profile,
                        "rules": [rule.model_dump() for rule in decision.rules],
                        "confidence": decision.confidence,
                    }
                    if alias_map[alias]["legacy"] == "1"
                    else {
                        **{
                            key: value
                            for key, value in alias_map[alias].items()
                            if key not in {"legacy", "source"}
                        },
                        "target": decision.working_target,
                        **profile,
                        "rules": [rule.model_dump() for rule in decision.rules],
                        "confidence": decision.confidence,
                    }
                )
            )
        return resolved

    def _call_batch(
        self,
        concepts: Sequence[Dict[str, Any]],
        *,
        run_id: str | None = None,
        knowledge_version: int | None = None,
    ) -> tuple[List[Dict[str, Any]] | None, str]:
        alias_map, payload = self._aliased_batch(concepts)
        base_messages = [
            {"role": "system", "content": TARGET_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        last_error = ""
        for _attempt in range(1, self.max_attempts + 1):
            messages = list(base_messages)
            if last_error:
                messages.append(
                    {
                        "role": "user",
                        "content": _target_retry_message(last_error),
                    }
                )
            started = time.perf_counter()
            raw = ""
            parsed_payload = None
            try:
                raw = self.llm.chat(
                    messages=messages,
                    purpose="working_target",
                    temperature=0.0,
                    max_tokens=self.max_tokens,
                    json_mode=True,
                    stream=False,
                )
                parsed = WorkingTargetResponse.model_validate_json(
                    self._clean_json(raw)
                )
                parsed_payload = parsed.model_dump(mode="json")
                decisions = self._resolve_response(parsed, alias_map)
            except Exception as exc:
                last_error = str(exc)
                if run_id:
                    self._record_audit_attempt(
                        run_id,
                        messages,
                        raw,
                        parsed_payload,
                        accepted=False,
                        attempt=_attempt,
                        elapsed_ms=int((time.perf_counter() - started) * 1000),
                        error=last_error,
                        knowledge_version=knowledge_version,
                    )
                continue
            if run_id:
                self._record_audit_attempt(
                    run_id,
                    messages,
                    raw,
                    parsed_payload,
                    accepted=True,
                    attempt=_attempt,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                    error=None,
                    knowledge_version=knowledge_version,
                )
            combined = parsed
            reviewed = self._review_role_decisions(
                alias_map=alias_map,
                payload=payload,
                parsed=parsed,
                run_id=run_id,
                knowledge_version=knowledge_version,
            )
            if reviewed is not None:
                replacement = {
                    decision.concept_id: decision
                    for decision in reviewed.decisions
                }
                combined = WorkingTargetResponse(
                    decisions=[
                        replacement.get(decision.concept_id, decision)
                        for decision in parsed.decisions
                    ]
                )
            combined = self._augment_role_vocatives(combined, payload)
            decisions = self._resolve_response(combined, alias_map)
            return decisions, ""
        return None, last_error or "model protocol failure"

    @staticmethod
    def _augment_role_vocatives(
        parsed: WorkingTargetResponse,
        payload: Dict[str, Any],
    ) -> WorkingTargetResponse:
        concepts = {
            str(concept["concept_id"]): concept
            for concept in payload.get("concepts") or []
        }
        decisions = []
        for decision in parsed.decisions:
            concept = concepts.get(decision.concept_id) or {}
            if str(concept.get("kind") or "").casefold() != "role":
                decisions.append(decision)
                continue
            source = str(concept.get("source") or "").strip()
            escaped_source = re.escape(source)
            contexts = [
                str(value)
                for value in concept.get("contexts") or []
                if str(value).strip()
            ]
            has_vocative = any(
                re.search(
                    rf",\s*{escaped_source}\s*[,.:;!?]",
                    context,
                    re.IGNORECASE,
                )
                or re.search(
                    rf"\b(?:Master|Mistress|Lord|Lady|Sir|Madam|Doctor|Captain)"
                    rf"\s+{escaped_source}\b",
                    context,
                    re.IGNORECASE,
                )
                for context in contexts
            )
            if not has_vocative:
                decisions.append(decision)
                continue
            aligned_target = ""
            target_pattern = re.compile(
                re.escape(decision.working_target)
                + r"(?:大人|阁下|先生|女士)"
            )
            for baseline in concept.get("baseline_translations") or []:
                match = target_pattern.search(str(baseline))
                if match:
                    aligned_target = match.group(0)
                    break
            if not aligned_target:
                decisions.append(decision)
                continue
            rules = [
                rule
                for rule in decision.rules
                if rule.condition.get("discourse_function") != "vocative"
            ]
            if len(rules) >= 6:
                decisions.append(decision)
                continue
            rules.append(
                WorkingTargetRule(
                    condition={"discourse_function": "vocative"},
                    target=aligned_target,
                )
            )
            decisions.append(decision.model_copy(update={"rules": rules}))
        return WorkingTargetResponse(decisions=decisions)

    def _review_role_decisions(
        self,
        *,
        alias_map: Dict[str, Dict[str, str]],
        payload: Dict[str, Any],
        parsed: WorkingTargetResponse,
        run_id: str | None,
        knowledge_version: int | None,
    ) -> WorkingTargetResponse | None:
        role_aliases = {
            str(concept["concept_id"])
            for concept in payload["concepts"]
            if str(concept.get("kind") or "").casefold() == "role"
        }
        if not role_aliases:
            return None
        proposals = {
            decision.concept_id: decision.model_dump(mode="json")
            for decision in parsed.decisions
        }
        review_payload = {
            "concepts": [
                {
                    **concept,
                    "proposal": proposals[str(concept["concept_id"])],
                }
                for concept in payload["concepts"]
                if str(concept["concept_id"]) in role_aliases
            ]
        }
        review_alias_map = {
            alias: alias_map[alias] for alias in sorted(role_aliases)
        }
        base_messages = [
            {"role": "system", "content": TARGET_REVIEW_SYSTEM},
            {
                "role": "user",
                "content": json.dumps(review_payload, ensure_ascii=False),
            },
        ]
        last_error = ""
        for attempt in range(1, self.max_attempts + 1):
            messages = list(base_messages)
            if last_error:
                messages.append(
                    {
                        "role": "user",
                        "content": _target_retry_message(last_error),
                    }
                )
            started = time.perf_counter()
            raw = ""
            parsed_payload = None
            try:
                raw = self.llm.chat(
                    messages=messages,
                    purpose="working_target",
                    temperature=0.0,
                    max_tokens=self.max_tokens,
                    json_mode=True,
                    stream=False,
                )
                reviewed = WorkingTargetResponse.model_validate_json(
                    self._clean_json(raw)
                )
                parsed_payload = reviewed.model_dump(mode="json")
                self._resolve_response(reviewed, review_alias_map)
            except Exception as exc:
                last_error = str(exc)
                if run_id:
                    self._record_audit_attempt(
                        run_id,
                        messages,
                        raw,
                        parsed_payload,
                        accepted=False,
                        attempt=attempt,
                        elapsed_ms=int(
                            (time.perf_counter() - started) * 1000
                        ),
                        error=last_error,
                        knowledge_version=knowledge_version,
                        purpose="working_target_review",
                    )
                continue
            if run_id:
                self._record_audit_attempt(
                    run_id,
                    messages,
                    raw,
                    parsed_payload,
                    accepted=True,
                    attempt=attempt,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                    error=None,
                    knowledge_version=knowledge_version,
                    purpose="working_target_review",
                )
            return reviewed
        return None

    def _record_audit_attempt(
        self,
        run_id: str,
        messages: Sequence[Dict[str, str]],
        raw_response: str,
        parsed: Dict[str, Any] | None,
        *,
        accepted: bool,
        attempt: int,
        elapsed_ms: int,
        error: str | None,
        knowledge_version: int | None,
        purpose: str = "working_target",
    ) -> None:
        version = (
            int(knowledge_version)
            if knowledge_version is not None
            else int(self.database.current_knowledge_version())
        )
        try:
            model = self.llm.get_model("working_target")
        except (AttributeError, KeyError, TypeError):
            model = type(self.llm).__name__
        self.database.record_audit_call(
            run_id=run_id,
            block_id=None,
            purpose=purpose,
            model=str(model),
            knowledge_version=version,
            request={"messages": list(messages), "audit_mode": self.audit_mode},
            raw_response=str(raw_response or ""),
            parsed=parsed,
            accepted=accepted,
            attempts=attempt,
            elapsed_ms=elapsed_ms,
            error=error,
        )

    def run(
        self,
        max_concepts: int | None = None,
        *,
        prepared_block_ids: Sequence[str] | None = None,
    ) -> Dict[str, Any]:
        candidates = self.database.working_target_candidates()
        if max_concepts is not None:
            candidates = candidates[: max(0, int(max_concepts))]
        run_id = f"target_{uuid4().hex}"
        self.database.start_run(
            run_id,
            "working_target",
            {
                "max_concepts": max_concepts,
                "batch_size": 24,
                "max_attempts": self.max_attempts,
                "subject_type": "lexeme",
            },
        )
        knowledge_version = int(self.database.current_knowledge_version())
        resolved = queued = changed = 0
        last_version = None
        affected_blocks = 0
        change_ids: set[int] = set()
        try:
            for start in range(0, len(candidates), 24):
                batch = candidates[start : start + 24]
                decisions, error = self._call_batch(
                    batch,
                    run_id=run_id,
                    knowledge_version=knowledge_version,
                )
                if decisions is None:
                    self.database.enqueue_working_target_review(
                        [item["subject_id"] for item in batch], error
                    )
                    queued += len(batch)
                    continue
                applied = self.database.apply_working_target_decisions(decisions)
                resolved += int(applied["resolved"])
                changed += int(applied["changed"])
                affected_blocks += int(applied["affected_blocks"])
                change_ids.update(int(value) for value in applied["change_ids"])
                if applied["knowledge_version"] is not None:
                    last_version = applied["knowledge_version"]
            status = "completed_with_errors" if queued else "completed"
            self.database.finish_run(run_id, status)
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc))
            raise
        preparation = self.database.advance_prepared_blocks(prepared_block_ids)
        return {
            "run_id": run_id,
            "resolved": resolved,
            "queued": queued,
            "changed": changed,
            "knowledge_version": last_version,
            "affected_blocks": affected_blocks,
            "subject_type": "lexeme",
            "prepared_blocks": preparation,
            "change_ids": sorted(change_ids),
        }
