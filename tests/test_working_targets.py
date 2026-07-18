import hashlib
import json
from contextlib import closing

import pytest
from pydantic import ValidationError

from src.agents.glossary_manager import GlossaryManager
from src.core.schemas import Glossary, GlossaryItem, GlossaryRule, TermCategory, TermStatus
from src.core.translator import TranslationConfig, TranslationEngine
from src.core.v4.context import ContextBuilder
from src.core.v4.database import KnowledgeSnapshotError, V4Database
from src.core.v4.models import (
    RenderingMatchSnapshot,
    TranslationOutcome,
    V4BlockStatus,
    WorkingTargetDecision,
    WorkingTargetResponse,
    WorkingTargetRule,
)
from src.core.v4.pipeline import V4TranslationPipeline
from src.core.v4.pipeline import V4PipelineConfig
from src.core.v4.revalidation import RevalidationPlanner
from src.core.v4.target_resolver import TargetResolver


class FakeTargetLLM:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def get_model(self, purpose):
        return "fake-target"

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class SchemaAwareTargetLLM:
    """Use a valid target response only when the nested wire schema is explicit."""

    def __init__(self, *, fail_first=False):
        self.fail_first = fail_first
        self.calls = []

    @staticmethod
    def has_contract(text):
        normalized = " ".join(text.lower().split())
        template = (
            '{"decisions":[{"concept_id":"q01","working_target":"示例译名",'
            '"semantic_core":"非剧透的核心含义",'
            '"contrast_sources":["executioner"],'
            '"rules":[{"condition":{"discourse_function":"vocative"},'
            '"target":"阁下"}],"confidence":0.95}]}'
        )
        return all(
            (
                "exactly these six keys" in normalized,
                template in normalized,
                "each rule object has exactly these two keys" in normalized,
                "concept_id" in normalized,
                "working_target" in normalized,
                "semantic_core" in normalized,
                "contrast_sources" in normalized,
                "rules" in normalized,
                "condition" in normalized,
                "target" in normalized,
                "confidence" in normalized,
                "do not use" in normalized,
                '"translation"' in normalized,
                '"rule"' in normalized,
            )
        )

    def get_model(self, purpose):
        return "schema-aware-target"

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        messages = kwargs["messages"]
        contract_text = messages[0]["content"]
        if len(messages) > 2:
            contract_text = messages[-1]["content"]
        valid = self.has_contract(contract_text)
        if self.fail_first and len(self.calls) == 1:
            valid = False
        if not valid:
            return _response(
                {
                    "concept_id": "Q01",
                    "translation": "示例译名",
                    "rule": {"when": "vocative", "translation": "阁下"},
                    "confidence": 0.95,
                }
            )
        return _response(
            {
                "concept_id": "Q01",
                "working_target": "示例译名",
                "semantic_core": "非剧透的核心含义",
                "contrast_sources": ["executioner"],
                "rules": [
                    {
                        "condition": {"discourse_function": "vocative"},
                        "target": "阁下",
                    }
                ],
                "confidence": 0.95,
            }
        )


def _database(tmp_path, sources):
    root = tmp_path / "book"
    root.mkdir()
    database = V4Database(root)
    edition = database.ensure_source_edition("raw", "normalized", "test", "source.txt")
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"block_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": source,
                "source_hash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                "token_count": len(source.split()),
                "status": "ready",
            }
            for index, source in enumerate(sources)
        ],
    )
    return database


def _plan_newer_changes_for_active_translation(database):
    with database.transaction() as connection:
        translation = connection.execute(
            """SELECT tv.id, tv.knowledge_version, b.source_text
               FROM translation_versions tv JOIN blocks b ON b.id=tv.block_id
               WHERE tv.pipeline='parallel_v4' AND tv.active=1
               ORDER BY tv.id LIMIT 1"""
        ).fetchone()
        changes = connection.execute(
            """SELECT id, subject_type, subject_id, old_fingerprint
               FROM knowledge_changes
               WHERE knowledge_version>? AND impact_level>0
                 AND old_fingerprint<>new_fingerprint
               ORDER BY id""",
            (translation["knowledge_version"],),
        ).fetchall()
        for change in changes:
            connection.execute(
                """INSERT OR IGNORE INTO dependencies(
                       translation_id, dependency_type, dependency_id,
                       knowledge_version, dependency_fingerprint,
                       matched_form, source_spans_json)
                   VALUES(?, ?, ?, ?, ?, ?, ?)""",
                (
                    translation["id"],
                    change["subject_type"],
                    change["subject_id"],
                    translation["knowledge_version"],
                    change["old_fingerprint"],
                    translation["source_text"],
                    json.dumps([[0, len(translation["source_text"])]]),
                ),
            )
    return RevalidationPlanner(database).plan([int(row["id"]) for row in changes])


def _seed_concept(database, source, *, kind="person", blocks=None):
    concept_id = database.import_legacy_concept(source, "", kind, f"{source} description")
    selected = blocks or database.list_blocks()
    with database.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()[0]
        for block in selected:
            evidence_id = connection.execute(
                """INSERT INTO evidence(
                       block_id, paragraph_id, kind, source_form, evidence_quote,
                       payload_json, confidence, extractor, run_id, created_at
                   ) VALUES(?, 'P000', 'test', ?, ?, '{}', 1.0, 'test', NULL, 'now')""",
                (block.id, source, source),
            ).lastrowid
            connection.execute(
                """INSERT INTO mentions(
                       block_id, paragraph_id, source_form, normalized_form,
                       discourse_function, lexeme_id, concept_id, evidence_id
                   ) VALUES(?, 'P000', ?, lower(?), 'referential', ?, ?, ?)""",
                (block.id, source, source, lexeme_id, concept_id, evidence_id),
            )
    return concept_id


def _response(*decisions):
    normalized = []
    for decision in decisions:
        item = dict(decision)
        item.setdefault("semantic_core", "词汇的非剧透核心含义。")
        item.setdefault("contrast_sources", [])
        item.setdefault("rules", [])
        normalized.append(item)
    return json.dumps({"decisions": normalized}, ensure_ascii=False)


def test_working_targets_default_to_lexeme_subject_and_keep_concept_override_empty(
    tmp_path,
):
    database = _database(tmp_path, ["Archon spoke.", "The Archon waited."])
    concept_id = _seed_concept(database, "Archon", kind="title")

    candidates = database.working_target_candidates()
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate["subject_type"] == "lexeme"
    assert candidate["subject_id"] == candidate["lexeme_id"]
    assert candidate["concept_id"] == concept_id

    applied = database.apply_working_target_decisions(
        [
            {
                "concept_id": concept_id,
                "target": "执政官",
                "rules": [
                    {
                        "condition": {"discourse_function": "vocative"},
                        "target": "阁下",
                    }
                ],
            }
        ]
    )
    assert applied["subjects"] == [
        {"subject_type": "lexeme", "subject_id": candidate["lexeme_id"]}
    ]
    with closing(database.connect()) as connection:
        lexeme = connection.execute(
            """SELECT working_target, verified_target, locked FROM lexemes
                 WHERE id=?""",
            (candidate["lexeme_id"],),
        ).fetchone()
        concept = connection.execute(
            """SELECT working_target, verified_target, status FROM concepts WHERE id=?""",
            (concept_id,),
        ).fetchone()
        rules = connection.execute(
            """SELECT lexeme_id, concept_id, target FROM rendering_rules
                 WHERE retired_version IS NULL AND target='阁下'"""
        ).fetchall()
    assert tuple(lexeme) == ("执政官", "", 0)
    # The legacy concept column remains a read-compatible mirror, but the
    # provisional concept is not a reliable override in the render snapshot.
    assert tuple(concept) == ("执政官", "", "legacy_provisional")
    rendered = database.freeze_translation_knowledge()[1].matched_renderings(
        "Archon", mention={"concept_id": concept_id, "status": "uncertain"}
    )[0]
    assert rendered.concept_id is None
    assert rendered.rendered_target == "执政官"
    assert [tuple(row) for row in rules] == [
        (candidate["lexeme_id"], None, "阁下")
    ]

    repeated = database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "执政官", "rules": [
            {"condition": {"discourse_function": "vocative"}, "target": "阁下"}
        ]}]
    )
    assert repeated["changed"] == 0


def test_target_candidate_recovers_role_kind_and_unselected_exact_contexts(tmp_path):
    database = _database(
        tmp_path,
        [
            "I am a torturer.",
            "The torturer waited.",
            "The torturer's apprentice returned.",
        ],
    )
    lexeme_id = database.ensure_lexeme("torturer")
    blocks = database.list_blocks()
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        for index, block in enumerate(blocks[:2]):
            evidence_id = connection.execute(
                """INSERT INTO evidence(
                       block_id, paragraph_id, kind, source_form, evidence_quote,
                       payload_json, confidence, extractor, created_at)
                   VALUES(?, 'P000', 'test', 'torturer', 'torturer', '{}',
                          1.0, 'test', 'now')""",
                (block.id,),
            ).lastrowid
            mention_id = connection.execute(
                """INSERT INTO mentions(
                       block_id, paragraph_id, source_form, normalized_form,
                       discourse_function, lexeme_id, concept_id, evidence_id)
                   VALUES(?, 'P000', 'torturer', 'torturer', 'referential',
                          ?, NULL, ?)""",
                (block.id, lexeme_id, evidence_id),
            ).lastrowid
            if index == 0:
                connection.execute(
                    """INSERT INTO concept_type_observations(
                           concept_id, lexeme_id, mention_id, evidence_id, kind,
                           confidence, source, created_version, created_at)
                       VALUES(NULL, ?, ?, ?, 'role', 0.96,
                              'candidate_adjudication', ?, 'now')""",
                    (lexeme_id, mention_id, evidence_id, version),
                )
        third = blocks[2]
        start = third.source_text.index("torturer")
        connection.execute(
            """INSERT INTO lexical_candidates(
                   id, block_id, paragraph_id, start_offset, end_offset,
                   original_text, normalized_text, left_context, right_context,
                   extraction_reason, book_frequency, model_status, selected,
                   created_at, updated_at, risk_flags_json, resolution_status)
               VALUES('candidate-extra-context', ?, 'P000', ?, ?,
                      'torturer', 'torturer', 'The', 'apprentice returned',
                      'rare_or_repeated', 96, 'rejected', 0, 'now', 'now',
                      '[]', 'rejected')""",
            (third.id, start, start + len("torturer")),
        )

    candidate = database.working_target_candidates()[0]

    assert candidate["subject_id"] == lexeme_id
    assert candidate["kind"] == "role"
    assert any("apprentice returned" in context for context in candidate["contexts"])

    database.apply_working_target_decisions(
        [
            {
                "subject_type": "lexeme",
                "subject_id": lexeme_id,
                "target": "拷问官",
                "semantic_core": "以拷问为正式职业身份的人。",
                "contrast_sources": ["executioner"],
                "rules": [],
            }
        ]
    )
    bundle = database.freeze_render_bundle([blocks[0].id])
    rendered_lexeme = bundle.index.get_lexeme(lexeme_id)
    assert rendered_lexeme["kind"] == "role"

    glossary = V4TranslationPipeline(database, lambda: None)._glossary_for(
        blocks[:1],
        concept_snapshot=bundle.index,
        rendering_contexts_by_block=bundle.contexts_by_block,
    )
    assert glossary.glossary.items[0].category == TermCategory.ROLE
    assert "[职业身份]" in TranslationEngine._render_glossary_term(
        glossary.glossary.items[0]
    )


def test_target_contexts_keep_a_later_explicit_lexical_contrast(tmp_path):
    database = _database(
        tmp_path,
        [
            "The torturer entered the room.",
            "I am a torturer.",
            "The torturer opened the door.",
            (
                "I was no carnifex, but a journeyman of the torturers' guild. "
                "The city had sent for an executioner, a headsman."
            ),
            "The torturer returned before dawn.",
            "No more do I, Torturer. No more does anyone.",
        ],
    )
    _seed_concept(database, "torturer", kind="role")

    contexts = database.working_target_candidates()[0]["contexts"]

    assert len(contexts) == 4
    assert any(
        "no carnifex" in context
        and "executioner" in context
        and "headsman" in context
        for context in contexts
    )
    assert any("No more do I, Torturer." in context for context in contexts)


def test_role_target_absorbs_an_observed_safe_plural_form(tmp_path):
    database = _database(
        tmp_path,
        ["I am a torturer.", "The torturers gathered in the tower."],
    )
    concept_id = _seed_concept(
        database,
        "torturer",
        kind="role",
        blocks=database.list_blocks()[:1],
    )
    with database.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?",
            (concept_id,),
        ).fetchone()[0]
        block = database.list_blocks()[1]
        start = block.source_text.index("torturers")
        connection.execute(
            """INSERT INTO lexical_candidates(
                   id, block_id, paragraph_id, start_offset, end_offset,
                   original_text, normalized_text, left_context, right_context,
                   extraction_reason, book_frequency, model_status, selected,
                   created_at, updated_at, risk_flags_json, resolution_status)
               VALUES('candidate-observed-plural', ?, 'P000', ?, ?,
                      'torturers', 'torturers', 'The', 'gathered in the tower',
                      'rare_or_repeated', 12, 'rejected', 0, 'now', 'now',
                      '[]', 'rejected')""",
            (block.id, start, start + len("torturers")),
        )

    database.apply_working_target_decisions(
        [
            {
                "subject_type": "lexeme",
                "subject_id": lexeme_id,
                "concept_id": concept_id,
                "target": "刑讯者",
                "semantic_core": "专司拷问以获取口供或实施惩罚的人。",
                "contrast_sources": ["executioner"],
                "rules": [],
            }
        ]
    )

    with closing(database.connect()) as connection:
        forms = connection.execute(
            """SELECT form, normalized_form, grammar_json
               FROM source_forms WHERE lexeme_id=?
               ORDER BY normalized_form""",
            (lexeme_id,),
        ).fetchall()
    assert ("torturers", "torturers") in {
        (row["form"], row["normalized_form"]) for row in forms
    }
    matched = database.freeze_translation_knowledge()[1].matched_renderings(
        "The torturers gathered."
    )
    assert len(matched) == 1
    assert matched[0].rendered_target == "刑讯者"


def test_explicit_concept_override_requires_reliable_different_evidence(tmp_path):
    database = _database(tmp_path, ["Archon spoke.", "The Archon waited."])
    concept_id = _seed_concept(database, "Archon", kind="title")

    with pytest.raises(ValueError, match="reliable different concept evidence"):
        database.apply_working_target_decisions(
            [
                {
                    "subject_type": "concept",
                    "subject_id": concept_id,
                    "target": "首席执政官",
                    "rules": [],
                }
            ]
        )

    version = database.current_knowledge_version()
    with database.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('different-archon', ?, 'concept', ?, 'mention_set', 'other',
                      'different', 'human', 1.0, 1, '[]', '[]', '[]',
                      'different-archon-hash', ?, 'now')""",
            (lexeme_id, concept_id, version),
        )

    applied = database.apply_working_target_decisions(
        [
            {
                "subject_type": "concept",
                "subject_id": concept_id,
                "target": "首席执政官",
                "rules": [],
            }
        ]
    )
    assert applied["subjects"] == [
        {"subject_type": "concept", "subject_id": concept_id}
    ]
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT working_target FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0] == "首席执政官"


def test_target_resolver_preserves_legacy_wire_alias_but_emits_lexeme_subject(tmp_path):
    database = _database(tmp_path, ["Severian waited.", "Severian returned."])
    concept_id = _seed_concept(database, "Severian")
    candidate = database.working_target_candidates()[0]
    resolver = TargetResolver(
        database,
        FakeTargetLLM(
            [
                _response(
                    {
                        "concept_id": "Q01",
                        "working_target": "塞万里安",
                        "semantic_core": "人物姓名。",
                        "contrast_sources": [],
                        "rules": [],
                        "confidence": 0.99,
                    }
                )
            ]
        ),
    )

    decisions, error = resolver._call_batch([candidate])
    assert error == ""
    assert decisions == [
        {
            "subject_type": "lexeme",
            "subject_id": candidate["lexeme_id"],
            "lexeme_id": candidate["lexeme_id"],
            "concept_id": concept_id,
            "target": "塞万里安",
            "semantic_core": "人物姓名。",
            "rules": [],
            "confidence": 0.99,
        }
    ]


def test_working_target_models_are_strict_and_bounded():
    rule = WorkingTargetRule(condition={"discourse_function": "vocative"}, target="阁下")
    decision = WorkingTargetDecision(
        concept_id="Q01",
        working_target="塞万里安",
        semantic_core="人物姓名。",
        contrast_sources=[],
        rules=[rule],
        confidence=0.9,
    )
    assert WorkingTargetResponse(decisions=[decision]).decisions[0].working_target == "塞万里安"

    with pytest.raises(ValidationError):
        WorkingTargetDecision(concept_id="concept-long-id", working_target="塞万里安", confidence=1)
    with pytest.raises(ValidationError):
        WorkingTargetDecision(concept_id="Q01", working_target=" ", confidence=1)
    with pytest.raises(ValidationError):
        WorkingTargetRule(condition={}, target="阁下")
    with pytest.raises(ValidationError):
        WorkingTargetRule(condition={"use": "vocative"}, target="")
    with pytest.raises(ValidationError):
        WorkingTargetDecision(
            concept_id="Q01",
            working_target="塞万里安",
            rules=[rule] * 7,
            confidence=1,
        )
    with pytest.raises(ValidationError):
        WorkingTargetResponse(decisions=[decision] * 25)
    with pytest.raises(ValidationError):
        WorkingTargetResponse.model_validate(
            {"decisions": [], "unexpected": True}
        )
    with pytest.raises(ValidationError):
        WorkingTargetResponse.model_validate(
            {
                "decisions": [
                    {
                        "concept_id": "Q01",
                        "working_target": "塞万里安",
                        "rules": [],
                        "confidence": 0.9,
                    }
                ]
            }
        )


def test_target_initial_and_retry_prompts_repeat_the_exact_nested_protocol():
    llm = SchemaAwareTargetLLM(fail_first=True)
    resolver = TargetResolver(object(), llm, max_attempts=2)

    decisions, error = resolver._call_batch(
        [
            {
                "concept_id": "stable-concept-id",
                "source": "Archon",
                "kind": "title",
                "description": "a recurring office",
                "contexts": ["Archon, I beg you."],
                "baseline_translations": [],
            }
        ]
    )

    assert error == ""
    assert decisions == [
        {
            "concept_id": "stable-concept-id",
            "target": "示例译名",
            "semantic_core": "非剧透的核心含义",
            "contrast_sources": ["executioner"],
            "rules": [
                {
                    "condition": {"discourse_function": "vocative"},
                    "target": "阁下",
                }
            ],
            "confidence": 0.95,
        }
    ]
    assert len(llm.calls) == 2
    assert SchemaAwareTargetLLM.has_contract(llm.calls[0]["messages"][0]["content"])
    assert SchemaAwareTargetLLM.has_contract(llm.calls[1]["messages"][-1]["content"])
    system = " ".join(llm.calls[0]["messages"][0]["content"].lower().split())
    assert "institutional profession" in system
    assert "generic action noun" in system
    assert "idiomatic chinese occupational title" in system
    assert "simplified chinese" in system
    assert "nearby proper nouns" in system
    assert "non-authoritative stylistic evidence" in system


def test_target_payload_keeps_three_baselines_for_distinct_register_contexts():
    _aliases, payload = TargetResolver._aliased_batch(
        [
            {
                "concept_id": "stable-concept-id",
                "source": "torturer",
                "kind": "role",
                "contexts": [
                    "a torturer waited",
                    "I am a torturer",
                    "Master Torturer?",
                    "not an executioner",
                ],
                "baseline_translations": [
                    "一名拷问官在等待。",
                    "我是拷问官。",
                    "拷问官大人？",
                ],
            }
        ]
    )

    assert payload["concepts"][0]["baseline_translations"] == [
        "一名拷问官在等待。",
        "我是拷问官。",
        "拷问官大人？",
    ]


def test_role_vocative_rule_is_recovered_from_aligned_baseline_wording():
    response = _response(
        {
            "concept_id": "Q01",
            "working_target": "拷问官",
            "semantic_core": "执行拷问和刑罚的人。",
            "contrast_sources": ["executioner"],
            "rules": [],
            "confidence": 0.95,
        }
    )
    llm = FakeTargetLLM([response, response])
    resolver = TargetResolver(object(), llm, max_attempts=1)

    decisions, error = resolver._call_batch(
        [
            {
                "concept_id": "stable-concept-id",
                "source": "torturer",
                "kind": "role",
                "contexts": [
                    "I am a torturer.",
                    "What is your name, Master Torturer?",
                ],
                "baseline_translations": [
                    "我是拷问官。",
                    "你叫什么名字，拷问官大人？",
                ],
            }
        ]
    )

    assert error == ""
    assert decisions[0]["rules"] == [
        {
            "condition": {"discourse_function": "vocative"},
            "target": "拷问官大人",
        }
    ]


def test_target_resolver_retries_semantic_core_with_unlicensed_story_name():
    llm = FakeTargetLLM(
        [
            _response(
                {
                    "concept_id": "Q01",
                    "working_target": "拷问士",
                    "semantic_core": "正式刑讯职业，亦称为 Vodalarius。",
                    "contrast_sources": ["executioner"],
                    "confidence": 0.9,
                }
            ),
            _response(
                {
                    "concept_id": "Q01",
                    "working_target": "刽子手",
                    "semantic_core": "以刑讯、拷问为职责的正式职业身份。",
                    "contrast_sources": [],
                    "confidence": 0.92,
                }
            ),
            _response(
                {
                    "concept_id": "Q01",
                    "working_target": "刑讯者",
                    "semantic_core": "专司拷问以获取口供或实施惩罚的人。",
                    "contrast_sources": ["executioner", "headsman", "carnifex"],
                    "rules": [
                        {
                            "condition": {"discourse_function": "vocative"},
                            "target": "刑讯官",
                        }
                    ],
                    "confidence": 0.95,
                }
            ),
        ]
    )
    resolver = TargetResolver(object(), llm, max_attempts=2)

    decisions, error = resolver._call_batch(
        [
            {
                "concept_id": "stable-concept-id",
                "source": "torturer",
                "kind": "role",
                "contexts": [
                    "I am a torturer. I am also a Vodalarius.",
                    "the torturer's apprentice",
                ],
            }
        ]
    )

    assert error == ""
    assert decisions[0]["target"] == "刑讯者"
    assert decisions[0]["semantic_core"] == "专司拷问以获取口供或实施惩罚的人。"
    assert decisions[0]["contrast_sources"] == [
        "executioner",
        "headsman",
        "carnifex",
    ]
    assert decisions[0]["rules"] == [
        {
            "condition": {"discourse_function": "vocative"},
            "target": "刑讯官",
        }
    ]
    assert len(llm.calls) == 3
    assert "Vodalarius" in llm.calls[1]["messages"][-1]["content"]
    review_system = " ".join(
        llm.calls[2]["messages"][0]["content"].lower().split()
    )
    assert "independent bilingual lexicographic" in review_system
    assert "discourse_function" in review_system


def test_target_retry_keeps_validation_detail_beyond_the_first_500_characters():
    marker = "TAIL_TARGET_VALIDATION_MARKER"
    llm = FakeTargetLLM(
        [
            ValueError("x" * 700 + marker),
            _response(
                {
                    "concept_id": "Q01",
                    "working_target": "执政官",
                    "rules": [],
                    "confidence": 0.95,
                }
            ),
        ]
    )
    resolver = TargetResolver(object(), llm, max_attempts=2)

    decisions, error = resolver._call_batch(
        [
            {
                "concept_id": "stable-concept-id",
                "source": "Archon",
                "kind": "title",
            }
        ]
    )

    assert error == ""
    assert decisions[0]["target"] == "执政官"
    assert marker in llm.calls[1]["messages"][-1]["content"]


def test_standalone_target_resolution_advances_safe_scanned_blocks(tmp_path):
    database = _database(tmp_path, ["nothing requires a target"])
    with database.transaction() as connection:
        connection.execute("UPDATE blocks SET status='scanned'")

    result = TargetResolver(database, FakeTargetLLM([])).run()

    assert result["prepared_blocks"] == {"ready": 1, "blocked": 0}
    assert database.list_blocks()[0].status == "ready"


def test_target_resolution_error_keeps_affected_scanned_blocks_blocked(tmp_path):
    database = _database(
        tmp_path,
        [
            "Severian waited.",
            "Severian entered.",
            "Severian answered.",
        ],
    )
    _seed_concept(database, "Severian")
    with database.transaction() as connection:
        connection.execute("UPDATE blocks SET status='scanned'")

    result = TargetResolver(
        database,
        FakeTargetLLM([RuntimeError("provider unavailable")]),
        max_attempts=1,
    ).run()

    assert result["queued"] == 1
    assert result["prepared_blocks"] == {"ready": 0, "blocked": 3}
    assert {block.status for block in database.list_blocks()} == {"scanned"}


def test_resolver_assigns_one_working_target_to_four_occurrences(tmp_path):
    database = _database(
        tmp_path,
        [
            "Severian waited at the gate.",
            "Severian entered the tower.",
            "Severian spoke to the guard.",
            "Severian left before dawn.",
        ],
    )
    concept_id = _seed_concept(database, "Severian")
    llm = FakeTargetLLM(
        [
            _response(
                {
                    "concept_id": "Q01",
                    "working_target": "塞万里安",
                    "rules": [],
                    "confidence": 0.98,
                }
            )
        ]
    )

    result = TargetResolver(database, llm, max_attempts=1).run()

    assert result["resolved"] == 1
    assert result["queued"] == 0
    with closing(database.connect()) as connection:
        row = connection.execute(
            """SELECT working_target, verified_target, locked
               FROM concepts WHERE id=?""",
            (concept_id,),
        ).fetchone()
    assert tuple(row) == ("塞万里安", "", 0)
    for block in database.list_blocks():
        concept = database.concepts_for_text(block.source_text)[0]
        assert concept["default_target"] == "塞万里安"
        assert concept["working_target"] == "塞万里安"
        assert concept["verified_target"] == ""
        assert concept["target_strength"] == "working"

    payload = json.loads(llm.calls[0]["messages"][-1]["content"])
    assert len(payload["concepts"]) == 1
    assert payload["concepts"][0]["concept_id"] == "Q01"
    assert concept_id not in llm.calls[0]["messages"][-1]["content"]
    assert len(payload["concepts"][0]["contexts"]) <= 4
    assert len(payload["concepts"][0]["baseline_translations"]) <= 2


def test_resolver_full_audit_persists_the_complete_aliased_exchange(tmp_path):
    database = _database(
        tmp_path,
        [
            "Severian waited at the gate.",
            "Severian entered the tower.",
            "Severian spoke to the guard.",
        ],
    )
    _seed_concept(database, "Severian")
    llm = FakeTargetLLM(
        [
            _response(
                {
                    "concept_id": "Q01",
                    "working_target": "塞万里安",
                    "rules": [],
                    "confidence": 0.98,
                }
            )
        ]
    )

    result = TargetResolver(
        database,
        llm,
        max_attempts=1,
        audit_mode="full",
    ).run()

    with closing(database.connect()) as connection:
        audit = connection.execute(
            "SELECT id, purpose, accepted FROM audit_calls WHERE run_id=?",
            (result["run_id"],),
        ).fetchone()
    assert tuple(audit)[1:] == ("working_target", 1)
    payload = database.read_audit_payload(audit["id"])
    assert payload["request"]["messages"][1]["content"]
    assert json.loads(payload["raw_response"])["decisions"][0]["concept_id"] == "Q01"


def test_verified_and_locked_targets_are_never_overwritten(tmp_path):
    database = _database(tmp_path, ["Severian waited.", "Severian spoke."])
    concept_id = _seed_concept(database, "Severian")
    with database.transaction() as connection:
        connection.execute(
            """UPDATE concepts SET default_target='终稿', working_target='工作稿',
                      verified_target='审定稿', locked=0 WHERE id=?""",
            (concept_id,),
        )
    llm = FakeTargetLLM([])
    assert TargetResolver(database, llm).run()["resolved"] == 0
    assert llm.calls == []
    concept = database.concepts_for_text("Severian")[0]
    assert concept["default_target"] == "审定稿"
    assert concept["target_strength"] == "verified"

    locked = database.lock_concept_translation("Drotte", "德罗特", kind="person")
    with database.transaction() as connection:
        before = connection.execute(
            "SELECT working_target, verified_target FROM concepts WHERE id=?",
            (locked["concept_id"],),
        ).fetchone()
    applied = database.apply_working_target_decisions(
        [{"concept_id": locked["concept_id"], "target": "错误", "rules": []}]
    )
    with database.transaction() as connection:
        after = connection.execute(
            "SELECT working_target, verified_target FROM concepts WHERE id=?",
            (locked["concept_id"],),
        ).fetchone()
    assert tuple(after) == tuple(before) == ("德罗特", "德罗特")
    assert applied["changed"] == 0


def test_resolver_retries_unknown_alias_and_accepts_reordered_decisions(tmp_path):
    database = _database(
        tmp_path,
        ["Drotte met Severian.", "Drotte followed Severian."],
    )
    drotte_id = _seed_concept(database, "Drotte")
    severian_id = _seed_concept(database, "Severian")
    invalid = _response(
        {"concept_id": "Q03", "working_target": "错误", "rules": [], "confidence": 1}
    )
    valid = _response(
        {"concept_id": "Q02", "working_target": "塞万里安", "rules": [], "confidence": 0.9},
        {"concept_id": "Q01", "working_target": "德罗特", "rules": [], "confidence": 0.9},
    )
    llm = FakeTargetLLM([invalid, valid])

    result = TargetResolver(database, llm, max_attempts=2).run()

    assert result["resolved"] == 2
    assert len(llm.calls) == 2
    with closing(database.connect()) as connection:
        targets = {
            row["id"]: row["working_target"]
            for row in connection.execute(
                "SELECT id, working_target FROM concepts WHERE id IN (?, ?)",
                (drotte_id, severian_id),
            )
        }
    assert targets[drotte_id] == "德罗特"
    assert targets[severian_id] == "塞万里安"


@pytest.mark.parametrize(
    "responses",
    [
        [_response()],
        [RuntimeError("network unavailable")],
    ],
)
def test_missing_alias_or_model_failure_goes_to_human_queue(tmp_path, responses):
    database = _database(tmp_path, ["Severian waited.", "Severian spoke."])
    concept_id = _seed_concept(database, "Severian")

    result = TargetResolver(
        database, FakeTargetLLM(responses), max_attempts=1
    ).run()

    assert result["resolved"] == 0
    assert result["queued"] == 1
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT working_target FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0] == ""
    queued = database.list_human_queue()
    assert len(queued) == 1
    assert queued[0]["kind"] == "working_target_required"


def test_success_closes_only_matching_working_target_queue_items(tmp_path):
    database = _database(tmp_path, ["Severian waited.", "Severian spoke."])
    concept_id = _seed_concept(database, "Severian")
    other_id = database.import_legacy_concept("Other", "", "person", "other")
    database.enqueue_working_target_review([concept_id], "first failure")
    database.enqueue_working_target_review([concept_id], "same failure again")
    with database.transaction() as connection:
        connection.execute(
            """INSERT INTO human_queue(
                   block_id, kind, severity, payload_json, created_at
               ) VALUES(NULL, 'working_target_required', 'blocking', ?, 'now')""",
            (json.dumps({"concept_id": other_id}),),
        )
        connection.execute(
            """INSERT INTO human_queue(
                   block_id, kind, severity, payload_json, created_at
               ) VALUES(NULL, 'unrelated', 'review', ?, 'now')""",
            (json.dumps({"concept_id": concept_id}),),
        )
    assert len(database.list_human_queue()) == 3

    result = TargetResolver(
        database,
        FakeTargetLLM(
            [
                _response(
                    {
                        "concept_id": "Q01",
                        "working_target": "塞万里安",
                        "rules": [],
                        "confidence": 0.9,
                    }
                )
            ]
        ),
        max_attempts=1,
    ).run()

    assert result["resolved"] == 1
    with closing(database.connect()) as connection:
        rows = connection.execute(
            "SELECT kind, status, payload_json, resolved_at FROM human_queue ORDER BY id"
        ).fetchall()
    matching = [
        row for row in rows
        if row["kind"] == "working_target_required"
        and json.loads(row["payload_json"])["concept_id"] == concept_id
    ]
    assert len(matching) == 1
    assert matching[0]["status"] == "resolved"
    assert matching[0]["resolved_at"] is not None
    assert rows[1]["status"] == "open"
    assert rows[2]["status"] == "open"


def test_single_low_impact_concept_is_not_required_by_verification_queue(tmp_path):
    database = _database(tmp_path, ["Scape shimmered once."])
    concept_id = _seed_concept(
        database, "Scape", kind="concept", blocks=database.list_blocks()[:1]
    )
    with database.transaction() as connection:
        connection.execute(
            """INSERT INTO verification_tasks(
                   id, subject_type, subject_id, payload_json, status,
                   required_votes, created_at
               ) VALUES('ordinary-verify', 'concept', ?, '{}', 'open', 2, 'now')""",
            (concept_id,),
        )

    assert database.working_target_candidates() == []
    llm = FakeTargetLLM([])
    assert TargetResolver(database, llm).run()["resolved"] == 0
    assert llm.calls == []


def test_single_low_impact_concept_ignores_candidate_high_impact_flag(tmp_path):
    database = _database(tmp_path, ["Scape shimmered once."])
    concept_id = _seed_concept(
        database, "Scape", kind="concept", blocks=database.list_blocks()[:1]
    )
    database.start_run("risk-run", "adjudicate", {})
    version = database.current_knowledge_version()
    with database.transaction() as connection:
        connection.execute(
            """INSERT INTO candidate_clusters(
                   id, run_id, risk_flags_json, affected_blocks_json,
                   affected_block_count, ordinal, state, created_at, updated_at
               ) VALUES('risk-cluster', 'risk-run', '["high_impact"]',
                        '["block_000"]', 1, 0, 'adjudicated', 'now', 'now')"""
        )
        connection.execute(
            """INSERT INTO candidate_adjudications(
                   id, run_id, cluster_id, verdict, payload_hash,
                   selected_candidate_ids_json, entity_kind, confidence, reason,
                   rounds, payload_json, knowledge_version, active, created_at,
                   updated_at
               ) VALUES('risk-adjudication', 'risk-run', 'risk-cluster', 'promote',
                        'hash', '[]', 'concept', 1.0, '', 1, '{}', ?, 1,
                        'now', 'now')""",
            (version,),
        )
        connection.execute(
            """INSERT INTO candidate_resolutions(
                   id, adjudication_id, run_id, cluster_id, candidate_id,
                   concept_id, evidence_id, decision, ordinal, payload_json,
                   created_at
               ) VALUES('risk-resolution', 'risk-adjudication', 'risk-run',
                        'risk-cluster', NULL, ?, NULL, 'promote', 0, '{}', 'now')""",
            (concept_id,),
        )

    assert database.working_target_candidates() == []


def test_resolver_batches_at_24_and_bounds_context_and_baseline_payloads(tmp_path):
    names = [f"Name{index:02d}" for index in range(25)]
    source = " ".join(names)
    database = _database(tmp_path, [source, source])
    for name in names:
        _seed_concept(database, name)
    responses = []
    for count in (24, 1):
        responses.append(
            _response(
                *[
                    {
                        "concept_id": f"Q{index:02d}",
                        "working_target": f"译名{index}",
                        "rules": [],
                        "confidence": 0.8,
                    }
                    for index in range(1, count + 1)
                ]
            )
        )
    llm = FakeTargetLLM(responses)

    result = TargetResolver(database, llm, max_attempts=1).run()

    assert result["resolved"] == 25
    payloads = [json.loads(call["messages"][-1]["content"]) for call in llm.calls]
    assert [len(payload["concepts"]) for payload in payloads] == [24, 1]
    assert all(
        len(item["contexts"]) <= 4 and len(item["baseline_translations"]) <= 3
        for payload in payloads
        for item in payload["concepts"]
    )


def test_rules_render_cleanly_and_working_apply_is_idempotent(tmp_path):
    database = _database(tmp_path, ["Archon spoke.", "Archon listened."])
    concept_id = _seed_concept(database, "Archon", kind="title")
    decision = {
        "concept_id": concept_id,
        "target": "执政官",
        "rules": [
            {
                "condition": {"discourse_function": "vocative"},
                "target": "阁下",
            }
        ],
    }
    first = database.apply_working_target_decisions([decision])
    version_count = database.current_knowledge_version()
    second = database.apply_working_target_decisions([decision])

    assert first["changed"] == 1
    assert second["changed"] == 0
    assert second["knowledge_version"] is None
    assert database.current_knowledge_version() == version_count
    concept = database.concepts_for_text("Archon")[0]
    assert concept["rules"][0]["target"] == "阁下"
    rendered = ContextBuilder._render_concepts([concept])
    assert "核心译名: 执政官" in rendered
    assert "工作译名" in rendered
    assert "→ 阁下" in rendered
    assert "->  " not in rendered
    assert "→  " not in rendered

    glossary = V4TranslationPipeline(database, lambda: None)._glossary_for(
        database.list_blocks()[:1]
    )
    assert glossary.glossary.items[0].default_target == "执政官"
    assert glossary.glossary.items[0].status == TermStatus.WORKING
    assert glossary.glossary.items[0].rules[0].target == "阁下"


def test_working_target_profile_is_atomic_idempotent_and_rendered(tmp_path):
    database = _database(
        tmp_path,
        [
            "I am a torturer.",
            "The torturer spoke.",
            "The torturer returned.",
        ],
    )
    concept_id = _seed_concept(database, "torturer", kind="role")
    lexeme_id = database.working_target_candidates()[0]["lexeme_id"]
    decision = {
        "subject_type": "lexeme",
        "subject_id": lexeme_id,
        "concept_id": concept_id,
        "target": "拷问者",
        "semantic_core": "行会职业身份；不自动等同于执行死刑者。",
        "contrast_sources": ["executioner", "headsman", "carnifex"],
        "rules": [
            {
                "condition": {"discourse_function": "vocative"},
                "target": "拷问官",
            }
        ],
    }

    first = database.apply_working_target_decisions([decision])
    version = database.current_knowledge_version()
    repeated = database.apply_working_target_decisions([decision])

    assert first["changed"] == 1
    assert repeated["changed"] == 0
    assert repeated["knowledge_version"] is None
    assert database.current_knowledge_version() == version

    with closing(database.connect()) as connection:
        profile = connection.execute(
            """SELECT semantic_core, contrast_sources_json
               FROM term_profiles
               WHERE subject_type='lexeme' AND subject_id=?
                 AND retired_version IS NULL""",
            (lexeme_id,),
        ).fetchone()
    assert tuple(profile) == (
        "行会职业身份；不自动等同于执行死刑者。",
        '["carnifex","executioner","headsman"]',
    )

    snapshot = database.render_snapshot()
    lexeme = next(item for item in snapshot if item["lexeme_id"] == lexeme_id)
    assert lexeme["term_profile"] == {
        "semantic_core": "行会职业身份；不自动等同于执行死刑者。",
        "contrast_sources": ["carnifex", "executioner", "headsman"],
        "status": "provisional",
        "locked": False,
    }

    concept = database.concepts_for_text("A torturer waited.")[0]
    rendered = ContextBuilder._render_concepts([concept])
    assert "语义边界: 行会职业身份；不自动等同于执行死刑者。" in rendered
    assert "须与以下原文词保持区别: carnifex、executioner、headsman" in rendered

    glossary = V4TranslationPipeline(database, lambda: None)._glossary_for(
        database.list_blocks()[:1]
    )
    description = glossary.glossary.items[0].description
    assert "行会职业身份；不自动等同于执行死刑者。" in description
    assert "carnifex、executioner、headsman" in description


def test_profile_only_change_records_render_change_for_revalidation(tmp_path):
    database = _database(
        tmp_path,
        ["I am a torturer.", "The torturer returned."],
    )
    concept_id = _seed_concept(database, "torturer", kind="role")
    lexeme_id = database.working_target_candidates()[0]["lexeme_id"]
    base = {
        "subject_type": "lexeme",
        "subject_id": lexeme_id,
        "concept_id": concept_id,
        "target": "拷问官",
        "semantic_core": "以刑讯、拷问为职责的正式职业身份。",
        "contrast_sources": ["executioner"],
        "rules": [],
    }
    database.apply_working_target_decisions([base])

    changed = database.apply_working_target_decisions(
        [
            {
                **base,
                "semantic_core": "以刑讯、审问为职责的正式职业身份；不是刽子手。",
            }
        ]
    )

    assert changed["changed"] == 1
    assert len(changed["change_ids"]) == 1
    with closing(database.connect()) as connection:
        row = connection.execute(
            """SELECT subject_type, subject_id, change_kind
               FROM knowledge_changes WHERE id=?""",
            (changed["change_ids"][0],),
        ).fetchone()
    assert tuple(row) == ("lexeme", lexeme_id, "term_profile")


def test_empty_effective_target_is_context_only_and_never_a_glossary_item(tmp_path):
    database = _database(tmp_path, ["Archon spoke."])
    _seed_concept(database, "Archon", kind="title")
    concept = database.concepts_for_text("Archon")[0]
    rendered = ContextBuilder._render_concepts([concept])
    assert "核心译名: （未定）" in rendered
    assert "→  " not in rendered

    glossary = V4TranslationPipeline(database, lambda: None)._glossary_for(
        database.list_blocks()
    )
    assert glossary.glossary.items == []


def test_target_change_records_change_then_planner_targets_only_active_translation(tmp_path):
    database = _database(
        tmp_path,
        ["Severian waited.", "Severian returned.", "No name here."],
    )
    blocks = database.list_blocks()
    concept_id = _seed_concept(database, "Severian", blocks=blocks[:2])
    with database.transaction() as connection:
        old_id = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at
               ) VALUES(?, 'parallel_v4', 1, 'completed', '旧稿', 0, 'now')""",
            (blocks[0].id,),
        ).lastrowid
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id, knowledge_version
               ) VALUES(?, 'concept', ?, 1)""",
            (old_id, concept_id),
        )
        connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at
               ) VALUES(?, 'parallel_v4', 1, 'completed', '现稿', 1, 'now')""",
            (blocks[0].id,),
        )
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id, knowledge_version,
                   dependency_fingerprint, matched_form, source_spans_json)
               SELECT id, 'concept', ?, 1, 'old-fingerprint', ?, ?
               FROM translation_versions
               WHERE block_id=? AND pipeline='parallel_v4' AND active=1""",
            (
                concept_id,
                blocks[0].source_text,
                json.dumps([[0, len(blocks[0].source_text)]]),
                blocks[0].id,
            ),
        )
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id, knowledge_version,
                   dependency_fingerprint, matched_form, source_spans_json)
               SELECT tv.id, 'lexeme', c.primary_lexeme_id, 1, 'old-fingerprint', ?, ?
               FROM translation_versions tv JOIN concepts c ON c.id=?
               WHERE tv.block_id=? AND tv.pipeline='parallel_v4' AND tv.active=1""",
            (
                blocks[0].source_text,
                json.dumps([[0, len(blocks[0].source_text)]]),
                concept_id,
                blocks[0].id,
            ),
        )
        connection.execute(
            "UPDATE blocks SET status='completed' WHERE id=?", (blocks[0].id,)
        )

    result = database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "塞万里安", "rules": []}]
    )

    assert result["change_ids"] == sorted(set(result["change_ids"]))
    planned = RevalidationPlanner(database).plan(result["change_ids"])

    assert result["affected_blocks"] == 0
    assert planned["planned"] == 1
    active = database.active_translations()
    assert active[blocks[0].id]["status"] == "completed"
    assert database.get_block_by_identifier(blocks[0].id).status == "completed"
    assert database.get_block_by_identifier(blocks[1].id).status == "ready"
    assert database.get_block_by_identifier(blocks[2].id).status == "ready"


def test_verification_pending_keeps_the_working_target_visible(tmp_path):
    database = _database(tmp_path, ["Severian waited.", "Severian spoke."])
    concept_id = _seed_concept(database, "Severian")
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "塞万里安", "rules": []}]
    )
    with database.transaction() as connection:
        connection.execute(
            """INSERT INTO verification_tasks(
                   id, subject_type, subject_id, payload_json, status,
                   required_votes, created_at
               ) VALUES('verify-working', 'concept', ?, '{}', 'open', 2, 'now')""",
            (concept_id,),
        )

    concept = database.concepts_for_text("Severian")[0]

    assert concept["verification_pending"] is True
    assert concept["default_target"] == "塞万里安"
    assert "塞万里安（工作译名）" in ContextBuilder._render_concepts([concept])


class CaptureLLM:
    def __init__(self):
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        return iter(())


def test_serial_translator_filters_empty_glossary_arrows_and_rules(tmp_path):
    manager = GlossaryManager(str(tmp_path / "glossary"))
    manager.glossary = Glossary(
        items=[
            GlossaryItem(
                id="empty-src",
                src="",
                default_target="空源",
                category=TermCategory.CONCEPT,
                status=TermStatus.VERIFIED,
            ),
            GlossaryItem(
                id="empty-target",
                src="Archon",
                default_target="",
                category=TermCategory.CONCEPT,
                status=TermStatus.VERIFIED,
            ),
            GlossaryItem(
                id="valid",
                src="Archon",
                default_target="执政官",
                category=TermCategory.CONCEPT,
                status=TermStatus.PENDING,
                rules=[
                    GlossaryRule(condition="vocative", target=""),
                    GlossaryRule(condition="direct address", target="阁下"),
                ],
            ),
            GlossaryItem(
                id="working",
                src="Severian",
                default_target="塞万里安",
                category=TermCategory.PERSON,
                status=TermStatus.WORKING,
            ),
            GlossaryItem(
                id="verified",
                src="Thecla",
                default_target="泰克拉",
                category=TermCategory.PERSON,
                status=TermStatus.VERIFIED,
            ),
            GlossaryItem(
                id="role",
                src="torturer",
                default_target="拷问官",
                category=TermCategory.ROLE,
                status=TermStatus.WORKING,
                description="负责审讯和施刑的职业；区别于 executioner。",
            ),
        ]
    )
    manager._build_patterns()
    llm = CaptureLLM()
    engine = TranslationEngine(
        llm,
        manager,
        config=TranslationConfig(enable_polish=True),
    )

    engine._draft_translate("Archon spoke to Severian, Thecla, and a torturer.")
    engine._polish_translate(
        "Archon spoke to Severian, Thecla, and a torturer.",
        "执政官向塞万里安、泰克拉与一名拷问官发言。",
    )

    prompts = "\n".join(call["messages"][0]["content"] for call in llm.calls)
    assert "Archon -> 执政官" in prompts
    assert "direct address" in prompts and "阁下" in prompts
    assert "vocative" not in prompts
    assert "-> \n" not in prompts
    assert "-  ->" not in prompts
    assert "人工核验硬约束" in prompts
    assert "本轮全书工作译名，必须统一使用，仅明确rendering rule可覆盖；不代表人工核验" in prompts
    assert "Severian -> 塞万里安" in prompts
    assert "职业身份条目允许按中文句法补足群体、行会或敬称关系" in prompts
    assert "[职业身份] torturer -> 拷问官" in prompts


def test_epoch_config_normalizes_legacy_unattended_and_requires_explicit_pause():
    legacy = V4PipelineConfig(decision_mode="unattended")

    assert legacy.decision_mode == "auto"
    assert legacy.pause_on_review is False
    assert legacy.unattended_failure_policy == "finish_with_warnings"
    assert legacy.max_knowledge_epochs == 3


class RecordingPipeline(V4TranslationPipeline):
    def __init__(self, *args, change_target=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.seen = []
        self.change_target = change_target

    def _translate_island(self, island, knowledge_version, concept_snapshot):
        glossary = self._glossary_for(
            island.blocks, concept_snapshot=concept_snapshot
        )
        targets = [item.default_target for item in glossary.glossary.items]
        self.seen.append((knowledge_version, targets))
        if self.change_target and len(self.seen) == 1:
            self.database.apply_working_target_decisions([self.change_target])
        outcomes = []
        for block in island.blocks:
            contexts = self._active_render_bundle.contexts_by_block.get(block.id, ())
            matches = concept_snapshot.matched_renderings(
                block.source_text,
                block_id=block.id,
                occurrence_contexts=list(contexts),
            )
            outcomes.append(
                TranslationOutcome(
                    block=block,
                    knowledge_version=knowledge_version,
                    status=V4BlockStatus.COMPLETED.value,
                    draft_translation="译稿完整。",
                    final_translation="译稿完整。",
                    matched_renderings=tuple(
                        RenderingMatchSnapshot(
                            lexeme_id=match.lexeme_id,
                            concept_id=match.concept_id,
                            matched_form=match.matched_form,
                            start_offset=match.start_offset,
                            end_offset=match.end_offset,
                            rendered_target=match.rendered_target,
                            applied_rule_ids=tuple(match.applied_rule_ids),
                            dependency_fingerprint=match.dependency_fingerprint,
                        )
                        for match in matches
                    ),
                )
            )
        return outcomes


def test_epoch_without_changes_reuses_one_frozen_snapshot(tmp_path, monkeypatch):
    database = _database(
        tmp_path, ["Severian waited long enough.", "Severian returned home."]
    )
    concept_id = _seed_concept(database, "Severian")
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "塞万里安", "rules": []}]
    )
    bumps = {"count": 0}
    freezes = {"count": 0}
    original_freeze = database.freeze_render_bundle

    def counted_freeze(block_ids):
        freezes["count"] += 1
        return original_freeze(block_ids)

    def unrelated_version(*_args, **_kwargs):
        bumps["count"] += 1
        with database.transaction() as connection:
            database.create_knowledge_version("unrelated", connection)
        return None

    monkeypatch.setattr(database, "commit_translation_proposals", unrelated_version)
    monkeypatch.setattr(database, "freeze_render_bundle", counted_freeze)
    pipeline = RecordingPipeline(
        database,
        lambda: None,
        config=V4PipelineConfig(
            island_size=1,
            initial_workers=1,
            max_workers=1,
            enable_polish=False,
        ),
    )

    result = pipeline.run()

    assert result["status"] == "completed"
    assert len(pipeline.seen) == 2
    assert pipeline.seen[0][0] == pipeline.seen[1][0]
    assert pipeline.seen[0][1] == pipeline.seen[1][1] == ["塞万里安"]
    assert bumps["count"] == 0
    assert freezes["count"] == 1
    with closing(database.connect()) as connection:
        run = connection.execute(
            "SELECT knowledge_version, config_json FROM runs WHERE id=?",
            (result["run_id"],),
        ).fetchone()
    config = json.loads(run["config_json"])
    assert run["knowledge_version"] == result["frozen_knowledge_version"]
    assert config["frozen_knowledge_version"] == result["frozen_knowledge_version"]
    assert config["knowledge_epoch_mode"] is True
    assert "target_snapshot_signature" not in config


def test_freeze_reads_version_and_targets_from_one_sqlite_snapshot(tmp_path, monkeypatch):
    database = _database(tmp_path, ["Severian waited.", "Severian spoke."])
    concept_id = _seed_concept(database, "Severian")
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "旧译名", "rules": []}]
    )
    old_version = database.current_knowledge_version()
    original_snapshot = database._concept_snapshot_from_connection
    changed = {"done": False}

    def change_between_reads(connection):
        if not changed["done"]:
            changed["done"] = True
            database.apply_working_target_decisions(
                [{"concept_id": concept_id, "target": "新译名", "rules": []}]
            )
        return original_snapshot(connection)

    monkeypatch.setattr(
        database, "_concept_snapshot_from_connection", change_between_reads
    )

    version, snapshot, signature = database.freeze_translation_knowledge()

    frozen = next(item for item in snapshot if item["id"] == concept_id)
    assert version == old_version
    assert frozen["default_target"] == "旧译名"
    assert signature == database.target_snapshot_signature(snapshot)
    assert database.current_knowledge_version() > version
    assert database.concepts_for_text("Severian")[0]["default_target"] == "新译名"


def test_midrun_target_change_commits_all_blocks_and_plans_only_dependent_block(tmp_path):
    database = _database(
        tmp_path, ["Severian waited long enough.", "Severian returned home."]
    )
    concept_id = _seed_concept(database, "Severian")
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "塞万里安", "rules": []}]
    )
    pipeline = RecordingPipeline(
        database,
        lambda: None,
        change_target={"concept_id": concept_id, "target": "塞维利安", "rules": []},
        config=V4PipelineConfig(
            island_size=1,
            initial_workers=1,
            max_workers=1,
            enable_polish=False,
        ),
    )

    result = pipeline.run()

    assert result["status"] == "completed"
    assert result["knowledge_stale"] is False
    assert len(pipeline.seen) == 2
    assert pipeline.seen[0][1] == ["塞万里安"]
    assert pipeline.seen[1][1] == ["塞维利安"]
    assert [block.status for block in database.list_blocks()] == ["completed", "completed"]
    assert set(database.active_translations()) == {"block_000", "block_001"}
    assert database.active_translations()["block_000"]["status"] == "completed"
    assert database.status_summary()["needs_revalidate"] == 1
    assert database.active_translations()["block_000"]["status"] == "completed"
    assert [block.status for block in database.list_blocks()] == ["completed", "completed"]
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks WHERE status='pending'"
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT status FROM runs WHERE id=?", (result["run_id"],)
        ).fetchone()[0] == result["status"]


def test_midrun_unrelated_target_change_commits_both_blocks_without_task(tmp_path):
    database = _database(tmp_path, ["Severian waited.", "Archon spoke."])
    blocks = database.list_blocks()
    severian = _seed_concept(database, "Severian", blocks=[blocks[0]])
    archon = _seed_concept(database, "Archon", blocks=[blocks[1]])
    database.apply_working_target_decisions(
        [
            {"concept_id": severian, "target": "塞万里安", "rules": []},
            {"concept_id": archon, "target": "执政官", "rules": []},
        ]
    )
    pipeline = RecordingPipeline(
        database,
        lambda: None,
        change_target={"concept_id": archon, "target": "总督", "rules": []},
        config=V4PipelineConfig(
            island_size=1,
            initial_workers=1,
            max_workers=1,
            enable_polish=False,
        ),
    )

    result = pipeline.run()

    assert result["status"] == "completed"
    assert result["knowledge_stale"] is False
    assert len(pipeline.seen) == 2
    assert pipeline.seen[0][1] == ["塞万里安"]
    assert pipeline.seen[1][1] == ["总督"]
    assert set(database.active_translations()) == {"block_000", "block_001"}
    assert database.status_summary()["needs_revalidate"] == 0


def test_epoch_finalizer_plans_a_last_moment_block_dependency_change(tmp_path, monkeypatch):
    database = _database(tmp_path, ["Severian waited long enough."])
    concept_id = _seed_concept(database, "Severian")
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "塞万里安", "rules": []}]
    )
    pipeline = RecordingPipeline(
        database,
        lambda: None,
        config=V4PipelineConfig(
            island_size=1,
            initial_workers=1,
            max_workers=1,
            enable_polish=False,
        ),
    )
    original_finish = database.finish_translation_run_atomically

    def race_before_final_transaction(*args, **kwargs):
        database.apply_working_target_decisions(
            [{"concept_id": concept_id, "target": "塞维利安", "rules": []}]
        )
        return original_finish(*args, **kwargs)

    monkeypatch.setattr(
        database, "finish_translation_run_atomically", race_before_final_transaction
    )

    result = pipeline.run()

    assert result["status"] == "completed"
    assert result["knowledge_stale"] is False
    assert database.get_block_by_identifier("block_000").status == "completed"
    assert database.active_translations()["block_000"]["status"] == "completed"
    assert database.status_summary()["needs_revalidate"] == 1
    assert database.get_block_by_identifier("block_000").status == "completed"
    assert database.active_translations()["block_000"]["status"] == "completed"
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks WHERE status='pending'"
        ).fetchone()[0] == 1


def test_working_target_candidates_use_one_connection_for_contexts_and_baselines(
    tmp_path, monkeypatch
):
    database = _database(
        tmp_path, ["Severian waited.", "Severian returned.", "Severian spoke."]
    )
    _seed_concept(database, "Severian")
    original_connect = database.connect
    calls = {"count": 0}

    def counted_connect():
        calls["count"] += 1
        return original_connect()

    monkeypatch.setattr(database, "connect", counted_connect)

    assert database.working_target_candidates()
    assert calls["count"] == 1


def test_invalid_working_rule_is_rejected_before_any_write(tmp_path):
    database = _database(tmp_path, ["Archon spoke."])
    concept_id = _seed_concept(database, "Archon", kind="title")

    with pytest.raises(ValidationError):
        database.apply_working_target_decisions(
            [
                {
                    "concept_id": concept_id,
                    "target": "执政官",
                    "rules": [
                        {"condition": {"mode": {"nested": "invalid"}}, "target": "阁下"}
                    ],
                }
            ]
        )

    assert database.concepts_for_text("Archon")[0]["working_target"] == ""


def test_invalid_snapshot_fails_safely_and_enqueues_one_blocking_review(
    tmp_path, monkeypatch
):
    database = _database(tmp_path, ["Archon spoke."])
    error = KnowledgeSnapshotError("broken-rule", "invalid json")
    monkeypatch.setattr(
        database,
        "freeze_render_bundle",
        lambda _block_ids: (_ for _ in ()).throw(error),
    )
    pipeline = V4TranslationPipeline(database, lambda: (_ for _ in ()).throw(
        AssertionError("LLM must not run with an invalid knowledge snapshot")
    ))

    first = pipeline.run()
    second = pipeline.run()

    assert first["status"] == second["status"] == "failed"
    queued = database.list_human_queue()
    invalid = [item for item in queued if item["kind"] == "knowledge_snapshot_invalid"]
    assert len(invalid) == 1
    assert invalid[0]["severity"] == "blocking"
    assert json.loads(invalid[0]["payload_json"])["rule_id"] == "broken-rule"


def test_conceptless_lexemes_enqueue_distinct_working_target_reviews(tmp_path):
    database = _database(tmp_path, ["Alpha met Beta."])
    version = database.current_knowledge_version()
    with database.transaction() as connection:
        for lexeme_id, source in (("lex-alpha", "Alpha"), ("lex-beta", "Beta")):
            connection.execute(
                """INSERT INTO lexemes(
                       id, language, normalized_form, canonical_form,
                       created_version, created_at)
                   VALUES(?, 'en', lower(?), ?, ?, 'now')""",
                (lexeme_id, source, source, version),
            )

    assert database.enqueue_working_target_review(
        ["lex-alpha", "lex-beta"], "model failed"
    ) == 2
