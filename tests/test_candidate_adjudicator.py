import json
import re
from dataclasses import replace

import pytest
from pydantic import ValidationError

from src.core.v4.adjudicator import V4Adjudicator
from src.core.v4.candidate_clusters import (
    CandidateCluster,
    CandidateClusterBuilder,
    CandidateContext,
)
from src.core.v4.lexical_index import LexicalCandidate
from src.core.v4.models import AdjudicationDecision, AdjudicationResponse


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def chat(self, **kwargs):
        self.requests.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return json.dumps(response)


class SchemaAwareFakeLLM:
    """Mimic a provider that guesses field synonyms unless fully constrained."""

    _FORBIDDEN_KEYS = (
        "decision",
        "action",
        "selected_id",
        "alternative_id",
        "span_id",
    )

    def __init__(self, *, fail_first=False, ordinary_noise=False, weak_evidence=False):
        self.fail_first = fail_first
        self.ordinary_noise = ordinary_noise
        self.weak_evidence = weak_evidence
        self.requests = []

    @classmethod
    def _has_contract(cls, text):
        normalized = " ".join(text.lower().split())
        exact_fields = (
            "cluster_id",
            "verdict",
            "selected_ids",
            "entity_kind",
            "confidence",
            "reason",
        )
        schema_template = re.search(
            r'\{"decisions":\[\{"cluster_id":"k01","verdict":"promote",'
            r'"selected_ids":\["k01a"\],"entity_kind":"person",'
            r'"confidence":0\.95,"reason":"[^"\\]*"\}\]\}',
            normalized,
        )
        return all(
            (
                "exactly these six keys" in normalized,
                all(field in normalized for field in exact_fields),
                all(
                    verdict in normalized
                    for verdict in ("promote", "reject", "split", "supersede", "defer")
                ),
                all(
                    kind in normalized
                    for kind in (
                        "person",
                        "place",
                        "organization",
                        "group",
                        "item",
                        "concept",
                        "unit",
                        "title",
                        "event",
                        "species",
                        "technology",
                        "work",
                        "artwork",
                        "personification",
                        "role",
                        "unknown_named_entity",
                    )
                ),
                "promote: selected_ids has exactly one" in normalized,
                "reject/defer: selected_ids is []" in normalized,
                "split: selected_ids has two or more" in normalized,
                "supersede: selected_ids has exactly one" in normalized,
                all(f'"{key}"' in normalized for key in cls._FORBIDDEN_KEYS),
                "forbidden" in normalized,
                schema_template is not None,
            )
        )

    @staticmethod
    def _has_semantic_gate(text):
        normalized = " ".join(text.lower().split())
        return all(
            phrase in normalized
            for phrase in (
                "ordinary verbs",
                "ordinary nouns",
                "function words",
                "fragment noise",
                "reject",
                "named entities",
                "fictional terms",
                "stable translation across the book",
                "weak evidence",
                "defer",
            )
        )

    def chat(self, **kwargs):
        self.requests.append(kwargs)
        messages = kwargs["messages"]
        contract_text = messages[0]["content"]
        if len(messages) > 2:
            contract_text = messages[-1]["content"]
        has_protocol = self._has_contract(contract_text)
        has_semantics = self._has_semantic_gate(messages[0]["content"])
        if self.fail_first and len(self.requests) == 1:
            has_protocol = False
        if not has_protocol:
            return json.dumps(
                {
                    "decision": [
                        {
                            "cluster": "K01",
                            "action": "promote",
                            "selected_id": "K01A",
                            "type": "person",
                        }
                    ]
                }
            )
        if self.ordinary_noise and has_semantics:
            verdict = "reject"
        elif self.weak_evidence and has_semantics:
            verdict = "defer"
        else:
            verdict = "promote"
        return json.dumps(
            {
                "decisions": [
                    {
                        "cluster_id": "K01",
                        "verdict": verdict,
                        "selected_ids": (
                            [] if verdict in {"reject", "defer"} else ["K01A"]
                        ),
                        "entity_kind": (
                            "unknown_named_entity" if verdict == "defer"
                            else "concept" if verdict == "reject"
                            else "person"
                        ),
                        "confidence": 0.95,
                        "reason": (
                            "ordinary lexical noise" if verdict == "reject"
                            else "weak evidence" if verdict == "defer"
                            else ""
                        ),
                    }
                ]
            }
        )


def candidate(
    candidate_id,
    source,
    start,
    end,
    *,
    block_id="block-1",
    risk_flags=(),
):
    return LexicalCandidate(
        id=candidate_id,
        block_id=block_id,
        paragraph_id="P000",
        start_offset=start,
        end_offset=end,
        original_text=source[start:end],
        normalized_text=source[start:end],
        left_context="",
        right_context="",
        extraction_reason="test",
        book_frequency=1,
        score=1,
        risk_flags=tuple(risk_flags),
    )


def cluster(cluster_id, alternatives, *, risk_flags=(), affected_blocks=1):
    first = alternatives[0]
    return CandidateCluster(
        id=cluster_id,
        alternatives=tuple(alternatives),
        contexts=(
            CandidateContext(
                candidate_id=first.id,
                block_id=first.block_id,
                paragraph_id=first.paragraph_id,
                original_text=first.original_text,
                left_context=first.left_context,
                right_context=first.right_context,
                risk_flags=first.risk_flags,
            ),
        ),
        risk_flags=tuple(risk_flags),
        affected_blocks=affected_blocks,
    )


def batch(*clusters):
    return CandidateClusterBuilder().batch(clusters)[0]


def response(cluster_id="K01", verdict="promote", selected_ids=None, **overrides):
    decision = {
        "cluster_id": cluster_id,
        "verdict": verdict,
        "selected_ids": [f"{cluster_id}A"] if selected_ids is None else selected_ids,
        "entity_kind": "person",
        "confidence": 0.96,
    }
    decision.update(overrides)
    return {"decisions": [decision]}


def user_payload(request):
    return json.loads(request["messages"][1]["content"])


def test_strict_response_contract_rejects_extra_fields_and_illegal_values():
    role = AdjudicationDecision.model_validate(
        {
            "cluster_id": "K01",
            "verdict": "promote",
            "selected_ids": ["K01A"],
            "entity_kind": "role",
            "confidence": 0.98,
            "reason": "recurring translation-sensitive profession",
        }
    )
    assert role.entity_kind == "role"

    with pytest.raises(ValidationError):
        AdjudicationDecision.model_validate(
            {
                "cluster_id": "cluster-long-id",
                "verdict": "promote",
                "selected_ids": ["K01A"],
                "entity_kind": "character",
                "confidence": 2,
                "extra": True,
            }
        )
    with pytest.raises(ValidationError):
        AdjudicationResponse.model_validate(
            {
                "decisions": [
                    {
                        "cluster_id": "K01",
                        "verdict": "promote",
                        "selected_ids": ["K01A"] * 5,
                        "entity_kind": "person",
                        "confidence": 0.9,
                    }
                ]
            }
        )


def test_semantic_gate_keeps_translation_sensitive_recurring_roles():
    source = "The torturer waited. Another torturer entered."
    item = cluster(
        "cluster-role",
        [candidate("candidate-role", source, 4, 12)],
        affected_blocks=2,
    )
    llm = FakeLLM(
        [
            response(
                entity_kind="role",
                confidence=0.97,
                reason="recurring profession with book-wide terminology",
            )
        ]
    )

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].entity_kind == "role"
    system = llm.requests[0]["messages"][0]["content"].lower()
    assert "recurring roles" in system
    assert "profession" in system
    assert "common noun" in system
    assert "not by itself a reason to reject" in system


def test_initial_and_retry_prompts_repeat_the_complete_canonical_protocol():
    source = "Viya waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 4)])
    llm = SchemaAwareFakeLLM(fail_first=True)

    result = V4Adjudicator(llm, max_attempts=2).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "promote"
    assert len(llm.requests) == 2
    assert SchemaAwareFakeLLM._has_contract(
        llm.requests[0]["messages"][0]["content"]
    )
    assert SchemaAwareFakeLLM._has_contract(
        llm.requests[1]["messages"][-1]["content"]
    )
    assert "previous" in llm.requests[1]["messages"][-1]["content"].lower()


def test_retry_does_not_discard_validation_detail_after_the_first_500_characters():
    source = "Viya waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 4)])
    marker = "TAIL_VALIDATION_MARKER"
    llm = FakeLLM([ValueError("x" * 700 + marker), response()])

    result = V4Adjudicator(llm, max_attempts=2).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "promote"
    assert marker in llm.requests[1]["messages"][-1]["content"]


def test_adjudication_prompt_rejects_ordinary_lexical_noise_and_defers_weak_evidence():
    source = "walked onward."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 6)])
    llm = SchemaAwareFakeLLM(ordinary_noise=True)

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "reject"
    assert SchemaAwareFakeLLM._has_semantic_gate(
        llm.requests[0]["messages"][0]["content"]
    )

    weak_source = "Night waited."
    weak_item = cluster(
        "cluster-weak", [candidate("candidate-weak", weak_source, 0, 5)]
    )
    weak_llm = SchemaAwareFakeLLM(weak_evidence=True)
    weak_result = V4Adjudicator(weak_llm, max_attempts=1).adjudicate(
        batch(weak_item), {"block-1": weak_source}
    )

    assert weak_result[0].verdict == "defer"
    assert weak_result[0].reason == "weak evidence"


def test_unknown_alias_never_promotes_after_protocol_failure():
    source = "Alpha waited."
    item = cluster("stable-cluster", [candidate("candidate-long-id", source, 0, 5)])
    llm = FakeLLM([response(selected_ids=["K01D"])])

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"
    payload = user_payload(llm.requests[0])
    rendered = json.dumps(payload)
    assert "stable-cluster" not in rendered
    assert "candidate-long-id" not in rendered


def test_cross_cluster_alias_invalidates_the_whole_batch():
    sources = {"block-1": "Alpha waited.", "block-2": "Beta waited."}
    clusters = (
        cluster("cluster-a", [candidate("candidate-a", sources["block-1"], 0, 5)]),
        cluster(
            "cluster-b",
            [candidate("candidate-b", sources["block-2"], 0, 4, block_id="block-2")],
        ),
    )
    llm = FakeLLM(
        [
            {
                "decisions": [
                    response("K01", selected_ids=["K02A"])["decisions"][0],
                    response("K02")["decisions"][0],
                ]
            }
        ]
    )

    results = V4Adjudicator(llm, max_attempts=1).adjudicate(batch(*clusters), sources)

    assert {result.verdict for result in results} == {"defer"}
    assert {result.reason for result in results} == {"model_protocol_failure"}


@pytest.mark.parametrize(
    "bad_response",
    [
        response(selected_ids=["K01A", "K01A"]),
        {"decisions": []},
        {"decisions": [response()["decisions"][0], response()["decisions"][0]]},
    ],
)
def test_duplicate_alias_or_missing_or_duplicate_cluster_decision_is_rejected(bad_response):
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])

    result = V4Adjudicator(FakeLLM([bad_response]), max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"


def test_split_rejects_overlapping_source_spans():
    source = "Alpha Beta waited."
    whole = candidate("candidate-whole", source, 0, 10)
    alpha = candidate("candidate-alpha", source, 0, 5)
    item = cluster("cluster-a", [whole, alpha], risk_flags=("span_competition",))
    llm = FakeLLM(
        [response(verdict="split", selected_ids=["K01A", "K01B"])]
    )

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"


def test_split_rejects_same_block_overlap_even_when_paragraph_ids_disagree():
    source = "Alpha Beta waited."
    whole = candidate("candidate-whole", source, 0, 10)
    alpha = replace(
        candidate("candidate-alpha", source, 0, 5), paragraph_id="P999"
    )
    item = cluster("cluster-a", [whole, alpha], risk_flags=("span_competition",))

    llm = FakeLLM(
        [
            response(verdict="split", selected_ids=["K01A", "K01B"]),
            response(verdict="split", selected_ids=["K01A", "K01B"]),
        ]
    )

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"
    assert len(llm.requests) == 1


def test_supersede_requires_selected_existing_span_to_contain_replaced_span():
    source = "Alpha Beta waited."
    short = candidate("candidate-short", source, 0, 5)
    long = candidate("candidate-long", source, 0, 10)
    item = cluster("cluster-a", [short, long], risk_flags=("span_competition",))
    llm = FakeLLM(
        [response(verdict="supersede", selected_ids=["K01A"])]
    )

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"


def test_supersede_containment_uses_same_block_offsets_not_paragraph_label():
    source = "Alpha Beta waited."
    selected = candidate("candidate-selected", source, 0, 10)
    contained = replace(
        candidate("candidate-contained", source, 0, 5), paragraph_id="P999"
    )
    item = cluster(
        "cluster-a", [selected, contained], risk_flags=("span_competition",)
    )
    llm = FakeLLM(
        [
            response(verdict="supersede", selected_ids=["K01A"]),
            response(verdict="supersede", selected_ids=["K01B"]),
        ]
    )

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    assert result[0].verdict == "supersede"
    assert result[0].selected_candidate_ids == ("candidate-selected",)


def test_supersede_cannot_treat_equal_offsets_in_different_blocks_as_containment():
    sources = {"block-1": "Alpha Beta waited.", "block-2": "Alpha waited."}
    selected = candidate("candidate-selected", sources["block-1"], 0, 10)
    other_block = candidate(
        "candidate-other-block",
        sources["block-2"],
        0,
        5,
        block_id="block-2",
    )
    item = cluster(
        "cluster-a", [selected, other_block], risk_flags=("span_competition",)
    )
    llm = FakeLLM(
        [
            response(verdict="supersede", selected_ids=["K01A"]),
            response(verdict="supersede", selected_ids=["K01B"]),
        ]
    )

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(batch(item), sources)

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"
    assert len(llm.requests) == 1


def test_legal_split_and_supersede_survive_realiased_independent_review():
    split_source = "Alpha and Beta waited."
    alpha = candidate("candidate-alpha", split_source, 0, 5)
    beta = candidate("candidate-beta", split_source, 10, 14)
    split_cluster = cluster(
        "cluster-split", [alpha, beta], risk_flags=("span_competition",)
    )
    split_llm = FakeLLM(
        [
            response(verdict="split", selected_ids=["K01A", "K01B"]),
            response(verdict="split", selected_ids=["K01A", "K01B"]),
        ]
    )

    split_result = V4Adjudicator(split_llm).adjudicate(
        batch(split_cluster), {"block-1": split_source}
    )

    supersede_source = "Alpha Beta waited."
    short = candidate("candidate-short", supersede_source, 0, 5)
    long = candidate("candidate-long", supersede_source, 0, 10)
    supersede_cluster = cluster(
        "cluster-supersede", [short, long], risk_flags=("span_competition",)
    )
    supersede_llm = FakeLLM(
        [
            response(verdict="supersede", selected_ids=["K01B"]),
            response(verdict="supersede", selected_ids=["K01A"]),
        ]
    )

    supersede_result = V4Adjudicator(supersede_llm).adjudicate(
        batch(supersede_cluster), {"block-1": supersede_source}
    )

    assert split_result[0].verdict == "split"
    assert set(split_result[0].selected_candidate_ids) == {
        "candidate-alpha",
        "candidate-beta",
    }
    assert supersede_result[0].verdict == "supersede"
    assert supersede_result[0].selected_candidate_ids == ("candidate-long",)


def test_supersede_can_ignore_a_different_partially_overlapping_alternative():
    source = "Alpha Beta Gamma waited."
    selected = candidate("candidate-selected", source, 0, 10)
    contained = candidate("candidate-contained", source, 0, 5)
    partial = candidate("candidate-partial", source, 6, 16)
    item = cluster(
        "cluster-a",
        [selected, contained, partial],
        risk_flags=("span_competition",),
    )
    llm = FakeLLM(
        [
            response(verdict="supersede", selected_ids=["K01A"]),
            response(verdict="supersede", selected_ids=["K01B"]),
        ]
    )

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    assert result[0].verdict == "supersede"
    assert result[0].selected_candidate_ids == ("candidate-selected",)


@pytest.mark.parametrize("verdict", ["reject", "defer"])
def test_reject_and_defer_cannot_carry_selected_spans(verdict):
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])

    result = V4Adjudicator(
        FakeLLM([response(verdict=verdict, selected_ids=[])]), max_attempts=1
    ).adjudicate(batch(item), {"block-1": source})
    invalid = V4Adjudicator(
        FakeLLM([response(verdict=verdict, selected_ids=["K01A"])]), max_attempts=1
    ).adjudicate(batch(item), {"block-1": source})

    assert result[0].verdict == verdict
    assert invalid[0].reason == "model_protocol_failure"


def test_missing_span_is_only_accepted_as_an_explicit_defer_reason():
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])
    invalid = response(reason="missing_span")
    valid = response(
        verdict="defer",
        selected_ids=[],
        entity_kind="unknown_named_entity",
        reason="missing_span",
    )

    invalid_result = V4Adjudicator(FakeLLM([invalid]), max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )
    valid_result = V4Adjudicator(FakeLLM([valid]), max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert invalid_result[0].reason == "model_protocol_failure"
    assert valid_result[0].verdict == "defer"
    assert valid_result[0].reason == "missing_span"


def test_bad_candidate_source_offsets_never_reach_promotion():
    source = "Alpha waited."
    bad = replace(candidate("candidate-a", source, 0, 5), start_offset=1, end_offset=6)
    item = cluster("cluster-a", [bad])
    llm = FakeLLM([response()])

    result = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"


def test_low_risk_legal_decision_is_accepted_without_a_second_round():
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])
    llm = FakeLLM([response()])

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    assert result[0].verdict == "promote"
    assert result[0].selected_candidate_ids == ("candidate-a",)
    assert result[0].rounds == 1
    assert len(llm.requests) == 1


def test_drotte_and_roche_promote_vs_split_conflict_is_deferred():
    source = "Drotte and Roche waited."
    whole = candidate("candidate-whole", source, 0, 16, risk_flags=("coordination",))
    alpha = candidate("candidate-drotte", source, 0, 6)
    beta = candidate("candidate-roche", source, 11, 16)
    item = cluster(
        "cluster-a",
        [whole, alpha, beta],
        risk_flags=("coordination", "span_competition"),
    )
    llm = FakeLLM(
        [
            response(selected_ids=["K01A"]),
            response(verdict="split", selected_ids=["K01D", "K01C"]),
        ]
    )

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    assert result[0].verdict == "defer"
    assert result[0].reason == "independent_verdict_conflict"
    assert result[0].rounds == 2


def test_corpse_does_not_replace_the_full_corpse_door_span_after_review():
    source = "The Corpse Door opened."
    whole = candidate("candidate-door", source, 4, 15)
    subspan = candidate("candidate-corpse", source, 4, 10)
    item = cluster(
        "cluster-a",
        [whole, subspan],
        risk_flags=("span_competition",),
    )
    llm = FakeLLM(
        [
            response(selected_ids=["K01A"]),
            response(selected_ids=["K01B"]),
        ]
    )

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    assert result[0].verdict == "promote"
    assert result[0].selected_candidate_ids == ("candidate-door",)
    assert result[0].rounds == 2


def test_second_round_reverses_alternatives_and_regenerates_alias_mapping():
    source = "Alpha and Beta waited."
    whole = candidate("candidate-whole", source, 0, 14)
    alpha = candidate("candidate-alpha", source, 0, 5)
    beta = candidate("candidate-beta", source, 10, 14)
    item = cluster("cluster-a", [whole, alpha, beta], risk_flags=("coordination",))
    llm = FakeLLM(
        [
            response(selected_ids=["K01A"]),
            response(selected_ids=["K01B"]),
        ]
    )

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    first, second = map(user_payload, llm.requests)
    first_aliases = {
        alternative["id"]: alternative["text"]
        for alternative in first["clusters"][0]["alternatives"]
    }
    second_aliases = {
        alternative["id"]: alternative["text"]
        for alternative in second["clusters"][0]["alternatives"]
    }
    assert first_aliases["K01A"] == "Alpha and Beta"
    assert second_aliases["K01D"] == "Beta"
    assert second_aliases["K01B"] == "Alpha and Beta"
    assert result[0].verdict == "promote"
    assert result[0].selected_candidate_ids == ("candidate-whole",)
    assert result[0].rounds == 2


@pytest.mark.parametrize(
    ("alternative_count", "second_selected_alias"),
    [(1, "K01D"), (2, "K01B"), (3, "K01B"), (4, "K01D")],
)
def test_risk_review_changes_every_candidate_alias_mapping(
    alternative_count, second_selected_alias
):
    source = "Alpha Beta Gamma Delta waited."
    spans = [(0, 5), (6, 10), (11, 16), (17, 22)]
    alternatives = [
        candidate(f"candidate-{index}", source, start, end)
        for index, (start, end) in enumerate(spans[:alternative_count])
    ]
    item = cluster(
        "cluster-a",
        alternatives,
        affected_blocks=3,
    )
    llm = FakeLLM(
        [
            response(selected_ids=["K01A"]),
            response(selected_ids=[second_selected_alias]),
        ]
    )

    result = V4Adjudicator(llm).adjudicate(batch(item), {"block-1": source})

    first, second = map(user_payload, llm.requests)
    first_alias_by_text = {
        alternative["text"]: alternative["id"]
        for alternative in first["clusters"][0]["alternatives"]
    }
    second_alias_by_text = {
        alternative["text"]: alternative["id"]
        for alternative in second["clusters"][0]["alternatives"]
    }
    assert set(first_alias_by_text) == set(second_alias_by_text)
    assert all(
        first_alias_by_text[text] != second_alias_by_text[text]
        for text in first_alias_by_text
    )
    assert len(set(second_alias_by_text.values())) == alternative_count
    assert all(
        re.fullmatch(r"K01[A-D]", alias) for alias in second_alias_by_text.values()
    )
    assert result[0].verdict == "promote"
    assert result[0].selected_candidate_ids == ("candidate-0",)
    assert result[0].rounds == 2


def test_second_round_protocol_failure_conservatively_defers_only_risky_cluster():
    sources = {"block-1": "Alpha waited.", "block-2": "Beta waited."}
    low = cluster("cluster-a", [candidate("candidate-a", sources["block-1"], 0, 5)])
    risky = cluster(
        "cluster-b",
        [candidate("candidate-b", sources["block-2"], 0, 4, block_id="block-2")],
        affected_blocks=3,
    )
    first = {
        "decisions": [
            response("K01")["decisions"][0],
            response("K02")["decisions"][0],
        ]
    }
    llm = FakeLLM([first, {"decisions": []}])

    results = V4Adjudicator(llm, max_attempts=1).adjudicate(
        batch(low, risky), sources
    )
    by_cluster = {result.cluster_id: result for result in results}

    assert by_cluster["cluster-a"].verdict == "promote"
    assert by_cluster["cluster-b"].verdict == "defer"
    assert by_cluster["cluster-b"].reason == "model_protocol_failure"


def test_invalid_first_attempt_can_retry_with_the_same_local_aliases():
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])
    llm = FakeLLM([response(selected_ids=["K01D"]), response()])

    result = V4Adjudicator(llm, max_attempts=2).adjudicate(
        batch(item), {"block-1": source}
    )

    assert result[0].verdict == "promote"
    assert user_payload(llm.requests[0]) == user_payload(llm.requests[1])


def test_batch_outcome_buffers_audits_without_database_writes():
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])
    llm = FakeLLM([response()])

    outcome = V4Adjudicator(llm, max_attempts=1)._adjudicate_batch_outcome(
        3,
        (item,),
        {"block-1": source},
        knowledge_version=7,
    )

    assert outcome.batch_index == 3
    assert outcome.results[0].verdict == "promote"
    assert outcome.model_calls == 1
    assert len(outcome.audit_attempts) == 1
    assert outcome.audit_attempts[0].accepted is True
    assert outcome.audit_attempts[0].knowledge_version == 7
    assert outcome.audit_attempts[0].model == "FakeLLM"


def test_full_audit_records_each_adjudication_attempt_without_stable_ids():
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])
    llm = FakeLLM([response(selected_ids=["K01D"]), response()])

    class RecordingDatabase:
        def __init__(self):
            self.calls = []

        def current_knowledge_version(self):
            return 7

        def record_audit_call(self, **kwargs):
            self.calls.append(kwargs)
            return len(self.calls)

    database = RecordingDatabase()
    result = V4Adjudicator(
        llm,
        max_attempts=2,
        audit_mode="full",
    ).adjudicate(
        batch(item),
        {"block-1": source},
        run_id="adjudicate-run",
        database=database,
    )

    assert result[0].verdict == "promote"
    assert [call["accepted"] for call in database.calls] == [False, True]
    assert database.calls[0]["error"]
    assert database.calls[1]["parsed"]["decisions"][0]["cluster_id"] == "K01"
    assert database.calls[1]["purpose"] == "candidate_adjudication"
    assert database.calls[1]["knowledge_version"] == 7
    rendered_request = json.dumps(database.calls[1]["request"])
    assert "cluster-a" not in rendered_request
    assert "candidate-a" not in rendered_request


def test_request_order_is_deterministic_for_reversed_cluster_input():
    sources = {"block-1": "Alpha waited.", "block-2": "Beta waited."}
    first = cluster("cluster-a", [candidate("candidate-a", sources["block-1"], 0, 5)])
    second = cluster(
        "cluster-b",
        [candidate("candidate-b", sources["block-2"], 0, 4, block_id="block-2")],
    )
    both_decisions = {
        "decisions": [
            response("K01")["decisions"][0],
            response("K02")["decisions"][0],
        ]
    }
    forward_llm = FakeLLM([both_decisions])
    reverse_llm = FakeLLM([both_decisions])

    V4Adjudicator(forward_llm).adjudicate([first, second], sources)
    V4Adjudicator(reverse_llm).adjudicate([second, first], sources)

    assert user_payload(forward_llm.requests[0]) == user_payload(reverse_llm.requests[0])
