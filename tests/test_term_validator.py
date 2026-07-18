from src.core.v4.matcher import FrozenRenderIndex
from src.core.v4.models import RenderingMatchSnapshot
from src.core.v4.term_validator import TermConsistencyValidator


def _snapshot(*, same_target=False):
    executioner_target = "拷问者" if same_target else "处刑人"
    return [
        {
            "id": "lex-torturer",
            "lexeme_id": "lex-torturer",
            "language": "en",
            "normalized_form": "torturer",
            "source": "torturer",
            "forms": ["torturer", "torturers"],
            "default_target": "",
            "working_target": "拷问者",
            "verified_target": "",
            "status": "provisional",
            "locked": False,
            "created_version": 1,
            "lexeme_rules": [
                {
                    "id": "rule-vocative",
                    "condition": {"discourse_function": "vocative"},
                    "target": "拷问官",
                    "priority": 50,
                    "status": "provisional",
                    "locked": False,
                    "created_version": 1,
                }
            ],
            "rules": [],
            "concepts": [],
            "term_profile": {
                "semantic_core": "行会职业身份。",
                "contrast_sources": ["executioner"],
                "status": "provisional",
                "locked": False,
            },
        },
        {
            "id": "lex-executioner",
            "lexeme_id": "lex-executioner",
            "language": "en",
            "normalized_form": "executioner",
            "source": "executioner",
            "forms": ["executioner"],
            "default_target": "",
            "working_target": executioner_target,
            "verified_target": "",
            "status": "provisional",
            "locked": False,
            "created_version": 1,
            "lexeme_rules": [],
            "rules": [],
            "concepts": [],
            "term_profile": {
                "semantic_core": "执行死刑者。",
                "contrast_sources": ["torturer"],
                "status": "provisional",
                "locked": False,
            },
        },
    ]


def _index(*, same_target=False):
    snapshot = _snapshot(same_target=same_target)
    signature = f"term-validator-{int(same_target)}"
    return FrozenRenderIndex.compile(snapshot, lambda _value: signature)


def test_warns_when_translation_uses_no_allowed_target():
    index = _index()
    matches = (
        RenderingMatchSnapshot(
            lexeme_id="lex-torturer",
            concept_id=None,
            matched_form="torturer",
            start_offset=7,
            end_offset=15,
            rendered_target="拷问者",
            applied_rule_ids=(),
            dependency_fingerprint="fingerprint",
        ),
    )

    warnings = TermConsistencyValidator.validate(
        source_text="I am a torturer.",
        final_translation="我是个刽子手。",
        matches=matches,
        render_index=index,
    )

    assert warnings == [
        {
            "kind": "term_target_missing",
            "lexeme_id": "lex-torturer",
            "source": "torturer",
            "matched_forms": ["torturer"],
            "allowed_targets": ["拷问官", "拷问者"],
        }
    ]


def test_allows_a_contextual_variant_from_a_rendering_rule():
    index = _index()
    matches = tuple(
        RenderingMatchSnapshot(
            lexeme_id=match.lexeme_id,
            concept_id=match.concept_id,
            matched_form=match.matched_form,
            start_offset=match.start_offset,
            end_offset=match.end_offset,
            rendered_target=match.rendered_target,
            applied_rule_ids=match.applied_rule_ids,
            dependency_fingerprint=match.dependency_fingerprint,
        )
        for match in index.matched_renderings(
            "Torturer!",
            context={"discourse_function": "vocative"},
        )
    )

    assert TermConsistencyValidator.validate(
        source_text="Torturer!",
        final_translation="拷问官！",
        matches=matches,
        render_index=index,
    ) == []


def test_warns_when_a_matched_contextual_rule_target_is_absent():
    index = _index()
    lexeme = index.get_lexeme("lex-torturer")
    base_target = lexeme["working_target"]
    rule_target = lexeme["lexeme_rules"][0]["target"]
    matches = (
        RenderingMatchSnapshot(
            lexeme_id="lex-torturer",
            concept_id=None,
            matched_form="torturers",
            start_offset=4,
            end_offset=13,
            rendered_target=base_target,
            applied_rule_ids=(),
            dependency_fingerprint="plural",
        ),
        RenderingMatchSnapshot(
            lexeme_id="lex-torturer",
            concept_id=None,
            matched_form="Torturer",
            start_offset=20,
            end_offset=28,
            rendered_target=rule_target,
            applied_rule_ids=("rule-vocative",),
            dependency_fingerprint="vocative",
        ),
    )

    warnings = TermConsistencyValidator.validate(
        source_text="The torturers said, Torturer.",
        final_translation=f"{base_target}们向{base_target}说话。",
        matches=matches,
        render_index=index,
    )

    assert {
        "kind": "term_rule_target_missing",
        "lexeme_id": "lex-torturer",
        "source": "torturer",
        "matched_form": "Torturer",
        "start_offset": 20,
        "end_offset": 28,
        "expected_target": rule_target,
        "applied_rule_ids": ["rule-vocative"],
    } in warnings


def test_warns_when_contrast_terms_collapse_to_the_same_target():
    index = _index(same_target=True)
    source = "The torturer denied that he was an executioner."
    matches = tuple(
        RenderingMatchSnapshot(
            lexeme_id=match.lexeme_id,
            concept_id=match.concept_id,
            matched_form=match.matched_form,
            start_offset=match.start_offset,
            end_offset=match.end_offset,
            rendered_target=match.rendered_target,
            applied_rule_ids=match.applied_rule_ids,
            dependency_fingerprint=match.dependency_fingerprint,
        )
        for match in index.matched_renderings(source)
    )

    warnings = TermConsistencyValidator.validate(
        source_text=source,
        final_translation="那个拷问者否认自己是拷问者。",
        matches=matches,
        render_index=index,
    )

    assert any(
        warning["kind"] == "term_contrast_target_collision"
        for warning in warnings
    )


def test_same_lexeme_different_concepts_are_validated_independently():
    snapshot = [
        {
            "id": "lex-bank",
            "lexeme_id": "lex-bank",
            "language": "en",
            "normalized_form": "bank",
            "source": "bank",
            "forms": ["bank"],
            "default_target": "",
            "working_target": "",
            "verified_target": "",
            "status": "provisional",
            "locked": False,
            "created_version": 1,
            "lexeme_rules": [],
            "rules": [],
            "concepts": [
                {
                    "id": "concept-river-bank",
                    "default_target": "",
                    "working_target": "河岸",
                    "verified_target": "",
                    "rules": [],
                    "term_profile": {
                        "semantic_core": "河流边缘的陆地。",
                        "contrast_sources": [],
                        "status": "provisional",
                        "locked": False,
                    },
                },
                {
                    "id": "concept-financial-bank",
                    "default_target": "",
                    "working_target": "银行",
                    "verified_target": "",
                    "rules": [],
                    "term_profile": {
                        "semantic_core": "经营存贷款等业务的金融机构。",
                        "contrast_sources": [],
                        "status": "provisional",
                        "locked": False,
                    },
                },
            ],
        }
    ]
    index = FrozenRenderIndex.compile(snapshot, lambda _value: "bank-signature")
    matches = (
        RenderingMatchSnapshot(
            lexeme_id="lex-bank",
            concept_id="concept-river-bank",
            matched_form="bank",
            start_offset=4,
            end_offset=8,
            rendered_target="河岸",
            applied_rule_ids=(),
            dependency_fingerprint="river",
        ),
        RenderingMatchSnapshot(
            lexeme_id="lex-bank",
            concept_id="concept-financial-bank",
            matched_form="bank",
            start_offset=17,
            end_offset=21,
            rendered_target="银行",
            applied_rule_ids=(),
            dependency_fingerprint="finance",
        ),
    )

    warnings = TermConsistencyValidator.validate(
        source_text="The bank faced the bank.",
        final_translation="河岸对着另一处河岸。",
        matches=matches,
        render_index=index,
    )

    assert any(
        warning["kind"] == "term_target_missing"
        and warning["concept_id"] == "concept-financial-bank"
        and warning["allowed_targets"] == ["银行"]
        for warning in warnings
    )
