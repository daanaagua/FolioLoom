import json
import hashlib
import time
from contextlib import closing

import pytest

from src.core.v4.database import KnowledgeSnapshotError, V4Database, stable_id
from src.core.v4.matcher import (
    AhoConceptMatcher,
    ConceptMatcherCache,
    FrozenConceptIndex,
)
from src.core.v4 import matcher as matcher_module
from src.core.v4.models import TranslationOutcome, V4BlockStatus
from src.core.v4.revalidation import RevalidationPlanner


def _db(tmp_path, texts):
    root = tmp_path / "book"
    root.mkdir()
    db = V4Database(root)
    edition = db.ensure_source_edition("raw", "normalized", "test", "source.txt")
    db.upsert_blocks(
        edition,
        [
            {
                "id": f"block_{index}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": text,
                "source_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "token_count": len(text.split()),
                "status": "ready",
            }
            for index, text in enumerate(texts)
        ],
    )
    return db


def _render_signature(snapshot):
    raw = json.dumps(
        snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _render_snapshot(
    *,
    concept_verified="大执政官",
    lexeme_verified="督政官",
    concept_working="首席",
    lexeme_working="执政官",
):
    return [
        {
            "id": "lex-archon",
            "lexeme_id": "lex-archon",
            "source": "Archon",
            "forms": ["Archon", "ARCHON"],
            "default_target": "旧执政官",
            "working_target": lexeme_working,
            "verified_target": lexeme_verified,
            "status": "verified" if lexeme_verified else "provisional",
            "locked": False,
            "created_version": 1,
            "rules": [],
            "concepts": [
                {
                    "id": "concept-archon",
                    "kind": "title",
                    "source": "Archon",
                    "default_target": "",
                    "working_target": concept_working,
                    "verified_target": concept_verified,
                    "status": "verified",
                    "locked": False,
                    "created_version": 2,
                    "binding_role": "primary",
                    "binding_status": "verified",
                    "binding_confidence": 1.0,
                    "binding_reliable": True,
                    "redirect_source_ids": [],
                    "rules": [
                        {
                            "id": "locked-vocative",
                            "condition": {
                                "block_id": "b-vocative",
                                "speaker": "Severian",
                                "thread_id": "court",
                                "start_offset": 0,
                                "end_offset": 6,
                            },
                            "target": "阁下",
                            "priority": 100,
                            "status": "verified",
                            "locked": True,
                            "created_version": 3,
                        },
                        {
                            "id": "empty-locked-rule",
                            "condition": {"block_id": "b-vocative"},
                            "target": "",
                            "priority": 999,
                            "status": "verified",
                            "locked": True,
                            "created_version": 4,
                        },
                    ],
                }
            ],
        }
    ]


def _compile_render(snapshot):
    return matcher_module.FrozenRenderIndex.compile(snapshot, _render_signature)


def test_frozen_render_index_applies_six_layers_and_locked_conditions_exactly():
    vocative = _compile_render(_render_snapshot())
    matched = vocative.matched_renderings(
        "Archon entered.",
        block_id="b-vocative",
        speaker="Severian",
        thread_id="court",
    )[0]
    assert matched.rendered_target == "阁下"
    assert matched.applied_rule_ids == ("locked-vocative",)

    ordinary = vocative.matched_renderings(
        "Archon entered.",
        block_id="b-tavern",
        speaker="Innkeeper",
        thread_id="tavern",
    )[0]
    assert ordinary.rendered_target == "大执政官"
    assert ordinary.applied_rule_ids == ()

    verified_lexeme = _compile_render(_render_snapshot(concept_verified=""))
    assert verified_lexeme.matched_renderings("Archon")[0].rendered_target == "督政官"

    working_concept = _compile_render(
        _render_snapshot(concept_verified="", lexeme_verified="")
    )
    assert working_concept.matched_renderings("Archon")[0].rendered_target == "首席"

    working_lexeme = _compile_render(
        _render_snapshot(
            concept_verified="", lexeme_verified="", concept_working=""
        )
    )
    assert working_lexeme.matched_renderings("Archon")[0].rendered_target == "执政官"

    unconstrained = _compile_render(
        _render_snapshot(
            concept_verified="",
            lexeme_verified="",
            concept_working="",
            lexeme_working="",
        )
    )
    unconstrained_match = unconstrained.matched_renderings("Archon")[0]
    assert unconstrained_match.rendered_target == "旧执政官"

    no_target = _render_snapshot(
        concept_verified="",
        lexeme_verified="",
        concept_working="",
        lexeme_working="",
    )
    no_target[0]["default_target"] = ""
    assert _compile_render(no_target).matched_renderings("Archon")[0].rendered_target == ""


def test_matcher_infers_vocative_from_local_punctuation_and_master_prefix():
    snapshot = _render_snapshot(
        concept_verified="",
        lexeme_verified="",
        concept_working="拷问官",
        lexeme_working="",
    )
    snapshot[0]["concepts"][0]["rules"] = [
        {
            "id": "vocative-role",
            "condition": {"discourse_function": "vocative"},
            "target": "拷问官阁下",
            "priority": 100,
            "status": "provisional",
            "locked": False,
            "created_version": 3,
        }
    ]
    index = _compile_render(snapshot)

    direct = index.matched_renderings("No more do I, Archon.")[0]
    titled = index.matched_renderings("What is your name, Master Archon?")[0]
    ordinary = index.matched_renderings("The Archon waited.")[0]

    assert direct.rendered_target == "拷问官阁下"
    assert titled.rendered_target == "拷问官阁下"
    assert ordinary.rendered_target == "拷问官"


def test_render_matches_preserve_offsets_identity_uncertain_fallback_and_fingerprint():
    snapshot = _render_snapshot(concept_verified="", lexeme_verified="")
    index = _compile_render(snapshot)
    matches = index.matched_renderings("ARCHON met Archon.")

    assert len(matches) == 2
    assert isinstance(matches[0], matcher_module.MatchedRendering)
    assert (
        matches[0].lexeme_id,
        matches[0].concept_id,
        matches[0].matched_form,
        matches[0].start_offset,
        matches[0].end_offset,
        matches[0].rendered_target,
    ) == ("lex-archon", "concept-archon", "ARCHON", 0, 6, "首席")
    assert matches[0].dependency_fingerprint == matches[1].dependency_fingerprint

    snapshot[0]["concepts"][0]["binding_role"] = "uncertain"
    snapshot[0]["concepts"][0]["binding_reliable"] = False
    uncertain = _compile_render(snapshot).matched_renderings(
        "Archon", mention={"concept_id": "concept-archon", "status": "uncertain"}
    )[0]
    assert uncertain.concept_id is None
    assert uncertain.rendered_target == "执政官"

    changed = _render_snapshot(concept_verified="", lexeme_verified="")
    changed[0]["working_target"] = "执政者"
    changed_match = _compile_render(changed).matched_renderings("Archon")[0]
    assert changed_match.dependency_fingerprint == matches[0].dependency_fingerprint

    changed[0]["concepts"][0]["working_target"] = "大人"
    concept_changed = _compile_render(changed).matched_renderings("Archon")[0]
    assert concept_changed.dependency_fingerprint != matches[0].dependency_fingerprint


def test_frozen_concept_index_remains_a_sequence_and_matched_concepts_compatibility():
    snapshot = _render_snapshot(concept_verified="", lexeme_verified="")
    index = FrozenConceptIndex.compile(snapshot, _render_signature)

    assert isinstance(index, matcher_module.FrozenRenderIndex)
    assert len(index) == 1
    assert index[0]["lexeme_id"] == "lex-archon"
    concepts = index.matched_concepts("The Archon spoke.")
    assert concepts[0]["id"] == "concept-archon"
    assert concepts[0]["default_target"] == "首席"


def test_database_render_snapshot_is_canonical_bounded_and_redirect_aware(tmp_path):
    db = _db(tmp_path, ["Archon spoke."])
    retired_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    canonical_id = "concept-archon-office"
    with db.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (retired_id,)
        ).fetchone()[0]
        connection.execute(
            """UPDATE lexemes SET working_target='执政官'
                 WHERE id=?""",
            (lexeme_id,),
        )
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, default_target, working_target,
                   verified_target, description, status, scope, locked,
                   primary_lexeme_id, created_version, created_at)
               VALUES(?, 'title', 'Archon', '大执政官', '', '大执政官', 'office',
                      'verified', 'book', 0, ?, ?, 'now')""",
            (canonical_id, lexeme_id, version),
        )
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, ?, 'primary', 1.0, 'verified', ?, 'now')""",
            (canonical_id, lexeme_id, version),
        )
        connection.execute(
            "UPDATE concepts SET status='retired', retired_version=? WHERE id=?",
            (version, retired_id),
        )
        connection.execute(
            """INSERT INTO concept_redirects(
                   retired_concept_id, canonical_concept_id, reason,
                   knowledge_version, created_at)
               VALUES(?, ?, 'same lexeme', ?, 'now')""",
            (retired_id, canonical_id, version),
        )
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at)
               VALUES('archon-vocative', ?, ?, '阁下', 100, 'verified',
                      'book', 1, ?, 'now')""",
            (
                canonical_id,
                json.dumps(
                    {"block_id": "block_0", "speaker": "Severian"},
                    separators=(",", ":"),
                ),
                version,
            ),
        )
        connection.execute(
            """INSERT INTO lexemes(
                   id, language, normalized_form, canonical_form, default_target,
                   working_target, status, locked, created_version,
                   retired_version, created_at)
               VALUES('retired-lexeme', 'en', 'ghost', 'Ghost', '幽灵', '幽灵',
                      'provisional', 0, ?, ?, 'now')""",
            (version, version),
        )
        connection.execute(
            """INSERT INTO source_forms(
                   lexeme_id, form, normalized_form, grammar_json)
               VALUES('retired-lexeme', 'Ghost', 'ghost', '{}')"""
        )

    first = db.render_snapshot()
    second = db.render_snapshot()
    assert first == second
    assert db.target_snapshot_signature(first) == db.target_snapshot_signature(second)
    encoded = json.dumps(first, ensure_ascii=False, sort_keys=True)
    assert "source_text" not in encoded
    assert "retired-lexeme" not in encoded
    assert len(first) == 1
    assert [item["id"] for item in first[0]["concepts"]] == [canonical_id]
    assert first[0]["concepts"][0]["redirect_source_ids"] == [retired_id]

    index = matcher_module.FrozenRenderIndex.compile(
        first, db.target_snapshot_signature
    )
    ordinary = index.matched_renderings(
        "Archon spoke.", block_id="block_0", speaker="Innkeeper"
    )[0]
    vocative = index.matched_renderings(
        "Archon spoke.",
        block_id="block_0",
        speaker="Severian",
        concept_id=retired_id,
    )[0]
    assert ordinary.rendered_target == "大执政官"
    assert vocative.concept_id == canonical_id
    assert vocative.rendered_target == "阁下"
    assert vocative.applied_rule_ids == ("archon-vocative",)


def test_concept_rules_are_attached_to_every_active_lexeme_binding(tmp_path):
    db = _db(tmp_path, ["Archon met the Magistrate."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        primary = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
        connection.execute(
            """UPDATE concepts SET status='verified', verified_target='CON'
                 WHERE id=?""",
            (concept_id,),
        )
        connection.execute(
            """UPDATE concept_lexemes SET status='verified', confidence=1.0
                 WHERE concept_id=? AND lexeme_id=?""",
            (concept_id, primary),
        )
        connection.execute(
            """INSERT INTO lexemes(
                   id, language, normalized_form, canonical_form,
                   created_version, created_at)
               VALUES('lex-magistrate', 'en', 'magistrate', 'Magistrate', ?, 'now')""",
            (version,),
        )
        connection.execute(
            """INSERT INTO source_forms(
                   lexeme_id, form, normalized_form, grammar_json)
               VALUES('lex-magistrate', 'Magistrate', 'magistrate', '{}')"""
        )
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, 'lex-magistrate', 'alias', 1.0, 'verified', ?, 'now')""",
            (concept_id, version),
        )
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at)
               VALUES('shared-rule', ?, '{}', 'RULE', 100, 'verified',
                      'book', 1, ?, 'now')""",
            (concept_id, version),
        )

    _, frozen, _ = db.freeze_translation_knowledge()
    assert [item.rendered_target for item in frozen.matched_renderings(
        "Archon met the Magistrate."
    )] == ["RULE", "RULE"]


def test_locked_usage_decision_is_frozen_as_exact_highest_layer_rule(tmp_path):
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
        connection.execute(
            """UPDATE concepts SET verified_target='ORDINARY', status='verified'
                 WHERE id=?""",
            (concept_id,),
        )
        connection.execute(
            """UPDATE concept_lexemes SET status='verified', confidence=1.0
                 WHERE concept_id=? AND lexeme_id=?""",
            (concept_id, lexeme_id),
        )
        evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at)
               VALUES('block_0', 'P000', 'test', 'Archon', 'Archon',
                      ?, 1.0, 'test', NULL, 'now')""",
            (json.dumps({"speaker_id": "sev", "thread_id": "court"}),),
        ).lastrowid
        mention_id = connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id)
               VALUES('block_0', 'P000', 'Archon', 'archon', 'vocative', ?, ?, ?)""",
            (lexeme_id, concept_id, evidence_id),
        ).lastrowid
        connection.execute(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES(?, 'block_0', 0, 6, 'Archon', 'hash-0', 'now')""",
            (lexeme_id,),
        )
        usage_id = connection.execute(
            """INSERT INTO usage_decisions(
                   mention_id, rendering, status, scope, locked,
                   created_version, created_at)
               VALUES(?, 'VOCATIVE', 'verified', 'occurrence', 1, ?, 'now')""",
            (mention_id, version),
        ).lastrowid
        connection.execute(
            """INSERT INTO usage_decisions(
                   mention_id, rendering, status, scope, locked,
                   created_version, retired_version, created_at)
               VALUES(?, 'RETIRED', 'verified', 'occurrence', 1, ?, ?, 'now')""",
            (mention_id, version, version),
        )

    _, frozen, _ = db.freeze_translation_knowledge()
    ordinary = frozen.matched_renderings("Archon spoke.", block_id="block_0")[0]
    contexts = db.rendering_contexts_for_blocks(["block_0"])["block_0"]
    contextual = frozen.matched_renderings(
        "Archon spoke.", block_id="block_0", occurrence_contexts=contexts
    )[0]

    assert ordinary.rendered_target == "ORDINARY"
    assert contextual.rendered_target == "VOCATIVE"
    assert contextual.applied_rule_ids == (f"usage:{usage_id}",)
    assert contextual.dependency_fingerprint != ordinary.dependency_fingerprint


@pytest.mark.parametrize(
    ("scope", "expected"),
    [
        ("occurrence", ["USAGE_TARGET", "ORDINARY", "ORDINARY"]),
        ("speaker", ["USAGE_TARGET", "USAGE_TARGET", "ORDINARY"]),
        ("thread", ["USAGE_TARGET", "USAGE_TARGET", "ORDINARY"]),
    ],
)
def test_usage_scope_controls_cross_block_context_without_origin_narrowing(
    tmp_path, scope, expected
):
    db = _db(tmp_path, ["Archon spoke.", "Archon waited.", "Archon left."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
        connection.execute(
            """UPDATE concepts SET verified_target='ORDINARY', status='verified'
                 WHERE id=?""",
            (concept_id,),
        )
        connection.execute(
            """UPDATE concept_lexemes SET status='verified', confidence=1.0
                 WHERE concept_id=? AND lexeme_id=?""",
            (concept_id, lexeme_id),
        )
        mention_ids = []
        for index in range(3):
            payload = {
                "speaker_id": "sev" if index < 2 else "other",
                "thread_id": "court" if index < 2 else "other-thread",
                "start_offset": 0,
                "end_offset": 6,
            }
            evidence_id = connection.execute(
                """INSERT INTO evidence(
                       block_id, paragraph_id, kind, source_form, evidence_quote,
                       payload_json, confidence, extractor, run_id, created_at)
                   VALUES(?, 'P000', 'test', 'Archon', 'Archon', ?, 1.0,
                          'test', NULL, 'now')""",
                (f"block_{index}", json.dumps(payload)),
            ).lastrowid
            mention_id = connection.execute(
                """INSERT INTO mentions(
                       block_id, paragraph_id, source_form, normalized_form,
                       discourse_function, lexeme_id, concept_id, evidence_id)
                   VALUES(?, 'P000', 'Archon', 'archon', 'referential', ?, ?, ?)""",
                (f"block_{index}", lexeme_id, concept_id, evidence_id),
            ).lastrowid
            mention_ids.append(mention_id)
            connection.execute(
                """INSERT INTO form_occurrences(
                       lexeme_id, block_id, start_offset, end_offset,
                       source_form, source_hash, created_at)
                   VALUES(?, ?, 0, 6, 'Archon', ?, 'now')""",
                (
                    lexeme_id,
                    f"block_{index}",
                    connection.execute(
                        "SELECT source_hash FROM blocks WHERE id=?",
                        (f"block_{index}",),
                    ).fetchone()[0],
                ),
            )
        usage_id = connection.execute(
            """INSERT INTO usage_decisions(
                   mention_id, rendering, status, scope, locked,
                   created_version, created_at)
               VALUES(?, 'USAGE_TARGET', 'verified', ?, 1, ?, 'now')""",
            (mention_ids[0], scope, version),
        ).lastrowid

    _, frozen, _ = db.freeze_translation_knowledge()
    contexts = db.rendering_contexts_for_blocks(
        [f"block_{index}" for index in range(3)]
    )
    matches = [
        frozen.matched_renderings(
            "Archon",
            block_id=f"block_{index}",
            occurrence_contexts=contexts[f"block_{index}"],
        )[0]
        for index in range(3)
    ]

    assert [match.rendered_target for match in matches] == expected
    assert matches[0].applied_rule_ids == (f"usage:{usage_id}",)
    if scope in {"speaker", "thread"}:
        assert matches[1].applied_rule_ids == (f"usage:{usage_id}",)
        assert (
            matches[0].dependency_fingerprint
            == matches[1].dependency_fingerprint
        )
    else:
        assert matches[1].applied_rule_ids == ()
    assert matches[2].applied_rule_ids == ()


@pytest.mark.parametrize("scope", ["speaker", "thread"])
def test_usage_scope_without_required_persisted_context_is_not_compiled(
    tmp_path, scope
):
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
        evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at)
               VALUES('block_0', 'P000', 'test', 'Archon', 'Archon', '{}',
                      1.0, 'test', NULL, 'now')"""
        ).lastrowid
        mention_id = connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id)
               VALUES('block_0', 'P000', 'Archon', 'archon', 'referential',
                      ?, ?, ?)""",
            (lexeme_id, concept_id, evidence_id),
        ).lastrowid
        connection.execute(
            """INSERT INTO usage_decisions(
                   mention_id, rendering, status, scope, locked,
                   created_version, created_at)
               VALUES(?, 'MUST_NOT_APPLY', 'verified', ?, 1, ?, 'now')""",
            (mention_id, scope, version),
        )

    snapshot = db.render_snapshot()
    assert all(
        not str(rule.get("id") or "").startswith("usage:")
        for lexeme in snapshot
        for rule in lexeme.get("lexeme_rules", [])
    )


def test_lexeme_winner_fingerprint_ignores_nonwinning_selected_concept():
    snapshot = _render_snapshot(
        concept_verified="", concept_working="", lexeme_verified="LEXEME"
    )
    first = snapshot[0]["concepts"][0]
    second = json.loads(json.dumps(first, ensure_ascii=False))
    second["id"] = "concept-other"
    snapshot[0]["concepts"].append(second)
    index = _compile_render(snapshot)

    selected_first = index.matched_renderings(
        "Archon", mention={"concept_id": first["id"], "confidence": 1.0}
    )[0]
    selected_second = index.matched_renderings(
        "Archon", mention={"concept_id": second["id"], "confidence": 1.0}
    )[0]

    assert selected_first.concept_id != selected_second.concept_id
    assert selected_first.rendered_target == selected_second.rendered_target == "LEXEME"
    assert (
        selected_first.dependency_fingerprint
        == selected_second.dependency_fingerprint
    )


def test_render_snapshot_and_compile_use_constant_query_count(tmp_path):
    db = _db(tmp_path, ["Name1999 spoke."])
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        for index in range(200):
            source = f"Name{index}"
            lexeme_id = f"lex-{index:04d}"
            connection.execute(
                """INSERT INTO lexemes(
                       id, language, normalized_form, canonical_form,
                       working_target, created_version, created_at)
                   VALUES(?, 'en', lower(?), ?, ?, ?, 'now')""",
                (lexeme_id, source, source, f"译名{index}", version),
            )
            connection.execute(
                """INSERT INTO source_forms(
                       lexeme_id, form, normalized_form, grammar_json)
                   VALUES(?, ?, lower(?), '{}')""",
                (lexeme_id, source, source),
            )

    statements = []
    original_connect = db.connect

    def traced_connect():
        connection = original_connect()
        connection.set_trace_callback(statements.append)
        return connection

    db.connect = traced_connect
    snapshot = db.render_snapshot()
    index = matcher_module.FrozenRenderIndex.compile(
        snapshot, db.target_snapshot_signature
    )
    assert index.matched_renderings("Name199 and Name1")
    selects = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]
    assert len(selects) <= 6


def test_aho_matcher_preserves_word_boundaries_case_and_nfkc():
    snapshot = [
        {"id": "archon", "forms": ["Archon"]},
        {"id": "fullwidth", "forms": ["Ａｅｔａ"]},
    ]
    matcher = AhoConceptMatcher.from_snapshot(snapshot)

    assert matcher.match("ARCHON met Aeta.") == ("archon", "fullwidth")
    assert matcher.match("Archoness XArchon Archon_2") == ()


def test_nfkc_grapheme_matching_preserves_original_cluster_spans():
    matcher = AhoConceptMatcher(
        {
            "Å": ["ring"],
            "A": ["plain"],
            "ffi": ["ligature"],
            "f": ["partial"],
        }
    )

    assert matcher.iter_matches("A\u030A") == (("ring", "A\u030A", 0, 2),)
    assert matcher.iter_matches("\ufb03") == (("ligature", "\ufb03", 0, 1),)

    hangul = AhoConceptMatcher({"각": ["full"], "가": ["partial"]})
    assert hangul.iter_matches("가\u11A8") == (("full", "가\u11A8", 0, 2),)
    assert hangul.iter_matches("\u1100\u1161\u11A8") == (
        ("full", "\u1100\u1161\u11A8", 0, 3),
    )


def test_matcher_cache_builds_once_for_one_signature():
    ConceptMatcherCache.clear()
    snapshot = [
        {"id": f"c{index}", "forms": [f"Name{index}"]}
        for index in range(2000)
    ]

    first = ConceptMatcherCache.get("same-version", snapshot)
    second = ConceptMatcherCache.get("same-version", list(reversed(snapshot)))

    assert first is second
    assert ConceptMatcherCache.build_count() == 1
    assert first.match("Name1999 and Name1") == ("c1", "c1999")


def test_compiled_rule_buckets_avoid_scanning_all_contextual_rules(monkeypatch):
    snapshot = _render_snapshot(
        concept_verified="", concept_working="", lexeme_verified=""
    )
    snapshot[0]["lexeme_rules"] = [
        {
            "id": f"speaker-{index}",
            "subject_type": "lexeme",
            "condition": {
                "speaker_id": "shared-speaker",
                "thread_id": f"thread-{index}",
            },
            "target": f"TARGET-{index}",
            "priority": index,
            "status": "verified",
            "locked": True,
            "created_version": 1,
        }
        for index in range(500)
    ]
    index = _compile_render(snapshot)
    checks = {"count": 0}
    original = matcher_module.FrozenRenderIndex._condition_matches

    def counted(condition, context):
        checks["count"] += 1
        return original(condition, context)

    monkeypatch.setattr(
        matcher_module.FrozenRenderIndex,
        "_condition_matches",
        staticmethod(counted),
    )

    matched = index.matched_renderings(
        "Archon", speaker_id="shared-speaker", thread_id="thread-321"
    )[0]

    assert matched.rendered_target == "TARGET-321"
    assert checks["count"] < 20

    checks["count"] = 0
    source = " ".join("Archon" for _ in range(1000))
    started = time.perf_counter()
    repeated = index.matched_renderings(
        source, speaker_id="shared-speaker", thread_id="thread-321"
    )
    elapsed = time.perf_counter() - started

    assert len(repeated) == 1000
    assert checks["count"] <= 1000
    assert elapsed < 2.0


def test_fingerprint_ignores_nonsemantic_rule_rebuild_metadata():
    snapshot = _render_snapshot()
    first = _compile_render(snapshot).matched_renderings(
        "Archon",
        block_id="b-vocative",
        speaker="Severian",
        thread_id="court",
    )[0]
    rebuilt = json.loads(json.dumps(snapshot, ensure_ascii=False))
    rebuilt_rule = rebuilt[0]["concepts"][0]["rules"][0]
    rebuilt_rule["created_version"] = 999
    rebuilt_rule["status"] = "provisional"
    second = _compile_render(rebuilt).matched_renderings(
        "Archon",
        block_id="b-vocative",
        speaker="Severian",
        thread_id="court",
    )[0]
    changed = json.loads(json.dumps(rebuilt, ensure_ascii=False))
    changed[0]["concepts"][0]["rules"][0]["priority"] = 101
    third = _compile_render(changed).matched_renderings(
        "Archon",
        block_id="b-vocative",
        speaker="Severian",
        thread_id="court",
    )[0]

    assert first.dependency_fingerprint == second.dependency_fingerprint
    assert third.dependency_fingerprint != second.dependency_fingerprint


def test_freeze_render_bundle_keeps_snapshot_and_contexts_at_one_k0(tmp_path):
    db = _db(tmp_path, ["Archon spoke."])
    first_id = db.import_legacy_concept("Archon", "", "title", "first")
    version = db.current_knowledge_version()
    second_id = "concept-second"
    with db.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (first_id,)
        ).fetchone()[0]
        connection.execute(
            """UPDATE concepts SET verified_target='FIRST', status='verified'
                 WHERE id=?""",
            (first_id,),
        )
        connection.execute(
            """UPDATE concept_lexemes SET status='verified', confidence=1.0
                 WHERE concept_id=?""",
            (first_id,),
        )
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, verified_target, description,
                   status, scope, locked, primary_lexeme_id,
                   created_version, created_at)
               VALUES(?, 'title', 'Archon', 'SECOND', 'second', 'verified',
                      'book', 0, ?, ?, 'now')""",
            (second_id, lexeme_id, version),
        )
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, ?, 'alias', 1.0, 'verified', ?, 'now')""",
            (second_id, lexeme_id, version),
        )
        evidence_id = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, run_id, created_at)
               VALUES('block_0', 'P000', 'test', 'Archon', 'Archon',
                      '{"speaker_id":"sev"}', 1.0, 'test', NULL, 'now')"""
        ).lastrowid
        mention_id = connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, concept_id, evidence_id)
               VALUES('block_0', 'P000', 'Archon', 'archon', 'referential',
                      ?, ?, ?)""",
            (lexeme_id, first_id, evidence_id),
        ).lastrowid
        connection.execute(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES(?, 'block_0', 0, 6, 'Archon', 'hash-0', 'now')""",
            (lexeme_id,),
        )

    frozen = db.freeze_render_bundle(["block_0"])
    with db.transaction() as connection:
        connection.execute(
            "UPDATE mentions SET concept_id=? WHERE id=?", (second_id, mention_id)
        )
    next_bundle = db.freeze_render_bundle(["block_0"])
    frozen_match = frozen.index.matched_renderings(
        "Archon",
        block_id="block_0",
        occurrence_contexts=frozen.contexts_by_block["block_0"],
    )[0]
    next_match = next_bundle.index.matched_renderings(
        "Archon",
        block_id="block_0",
        occurrence_contexts=next_bundle.contexts_by_block["block_0"],
    )[0]

    assert frozen_match.rendered_target == "FIRST"
    assert next_match.rendered_target == "SECOND"
    assert frozen.signature != next_bundle.signature
    assert frozen.contexts_by_block["block_0"][0]["evidence_id"] == evidence_id
    with pytest.raises(TypeError):
        frozen.contexts_by_block["block_0"] = ()


@pytest.mark.parametrize(
    "condition_json",
    [
        "[]",
        '{"value":NaN}',
        json.dumps({"value": "x" * 513}),
        "[" * 2000 + "]" * 2000,
    ],
)
def test_snapshot_rejects_unsafe_condition_json_with_typed_error(
    tmp_path, condition_json
):
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at)
               VALUES('unsafe-condition', ?, ?, 'TARGET', 1, 'verified',
                      'book', 1, ?, 'now')""",
            (concept_id, condition_json, version),
        )

    with pytest.raises(KnowledgeSnapshotError, match="unsafe-condition") as error:
        db.freeze_translation_knowledge()
    assert len(str(error.value)) < 300


def test_concepts_for_text_deepcopies_nested_rules_and_reuses_matcher(tmp_path):
    ConceptMatcherCache.clear()
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    db.apply_working_target_decisions(
        [
            {
                "concept_id": concept_id,
                "target": "执政官",
                "rules": [
                    {
                        "condition": {"mode": "vocative"},
                        "target": "阁下",
                    }
                ],
            }
        ]
    )
    version, snapshot, signature = db.freeze_translation_knowledge()

    first = db.concepts_for_text("Archon", concept_snapshot=snapshot)
    first[0]["rules"][0]["condition"]["mode"] = "polluted"
    second = db.concepts_for_text("ARCHON", concept_snapshot=snapshot)

    assert version > 0 and signature
    assert second[0]["rules"][0]["condition"]["mode"] == "vocative"
    assert snapshot[0]["rules"][0]["condition"]["mode"] == "vocative"
    assert ConceptMatcherCache.build_count() == 0


def test_frozen_index_compiles_once_and_hot_matching_never_walks_vocabulary(
    tmp_path, monkeypatch
):
    db = _db(tmp_path, ["Name1999 spoke.", "Name1 waited.", "Nothing happened."])
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        for index in range(2000):
            concept_id = f"concept-{index:04d}"
            source = f"Name{index}"
            normalized = source.lower()
            lexeme_id = stable_id("lexeme", f"en:{normalized}")
            connection.execute(
                """INSERT INTO lexemes(
                       id, language, normalized_form, canonical_form,
                       default_target, working_target, created_version, created_at)
                   VALUES(?, 'en', ?, ?, ?, ?, ?, 'now')""",
                (lexeme_id, normalized, source, f"译名{index}", f"译名{index}", version),
            )
            connection.execute(
                """INSERT INTO concepts(
                       id, kind, canonical_source, default_target, working_target,
                       description, status, scope, locked, primary_lexeme_id,
                       created_version, created_at)
                   VALUES(?, 'person', ?, ?, ?, '', 'provisional', 'book', 0,
                          ?, ?, 'now')""",
                (
                    concept_id,
                    source,
                    f"译名{index}",
                    f"译名{index}",
                    lexeme_id,
                    version,
                ),
            )
            connection.execute(
                """INSERT INTO concept_lexemes(
                       concept_id, lexeme_id, role, confidence, status,
                       created_version, created_at)
                   VALUES(?, ?, 'primary', 1.0, 'provisional', ?, 'now')""",
                (concept_id, lexeme_id, version),
            )
            connection.execute(
                """INSERT INTO source_forms(
                       lexeme_id, form, normalized_form, grammar_json
                   ) VALUES(?, ?, ?, '{}')""",
                (lexeme_id, source, normalized),
            )

    counts = {"signature": 0, "snapshot": 0, "map": 0, "matcher": 0}
    original_signature = db.target_snapshot_signature
    original_snapshot = FrozenConceptIndex._deep_snapshot
    original_map = FrozenConceptIndex._build_map
    original_matcher = FrozenConceptIndex._build_matcher

    def counted_signature(snapshot):
        counts["signature"] += 1
        return original_signature(snapshot)

    def counted_snapshot(snapshot):
        counts["snapshot"] += 1
        return original_snapshot(snapshot)

    def counted_map(snapshot):
        counts["map"] += 1
        return original_map(snapshot)

    def counted_matcher(snapshot):
        counts["matcher"] += 1
        return original_matcher(snapshot)

    monkeypatch.setattr(db, "target_snapshot_signature", counted_signature)
    monkeypatch.setattr(FrozenConceptIndex, "_deep_snapshot", staticmethod(counted_snapshot))
    monkeypatch.setattr(FrozenConceptIndex, "_build_map", staticmethod(counted_map))
    monkeypatch.setattr(FrozenConceptIndex, "_build_matcher", staticmethod(counted_matcher))

    _, frozen, signature = db.freeze_translation_knowledge()
    assert isinstance(frozen, FrozenConceptIndex)
    assert frozen.signature == signature
    assert counts == {"signature": 1, "snapshot": 1, "map": 1, "matcher": 1}

    for block in db.list_blocks():
        db.concepts_for_text(block.source_text, concept_snapshot=frozen)
    assert counts == {"signature": 1, "snapshot": 1, "map": 1, "matcher": 1}


def test_snapshot_signature_covers_all_prompt_and_matching_semantics(tmp_path):
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    db.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "执政官", "rules": []}]
    )
    _, snapshot, original = db.freeze_translation_knowledge()
    variants = []
    for field, value in (
        ("source", "Other"),
        ("kind", "person"),
        ("description", "changed"),
        ("status", "verified"),
        ("locked", True),
        ("working_target", "别名"),
        ("verified_target", "审定"),
        ("default_target", "有效"),
        ("verification_pending", True),
    ):
        changed = json.loads(json.dumps(list(snapshot), ensure_ascii=False))
        changed[0][field] = value
        variants.append(db.target_snapshot_signature(changed))
    changed_form = json.loads(json.dumps(list(snapshot), ensure_ascii=False))
    changed_form[0]["forms"].append("Archons")
    variants.append(db.target_snapshot_signature(changed_form))

    assert all(signature != original for signature in variants)


def test_commit_uses_only_frozen_outcome_concept_dependencies(tmp_path, monkeypatch):
    db = _db(tmp_path, ["Archon spoke."])
    archon = db.import_legacy_concept("Archon", "", "title", "office")
    other = db.import_legacy_concept("Other", "", "person", "other")
    block = db.list_blocks()[0]
    db.start_run("translate-run", "translate", {})
    monkeypatch.setattr(
        db,
        "concepts_for_text",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("live concept matching is forbidden during commit")
        ),
    )

    db.commit_translation_batch(
        "translate-run",
        [
            TranslationOutcome(
                block=block,
                knowledge_version=db.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                final_translation="译文。",
                matched_concept_ids=[other],
            )
        ],
    )

    with closing(db.connect()) as connection:
        dependencies = connection.execute(
            "SELECT dependency_id FROM dependencies WHERE dependency_type='concept'"
        ).fetchall()
    assert [row[0] for row in dependencies] == [other]
    assert archon != other


def test_bad_rule_json_raises_typed_snapshot_error(tmp_path):
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    version = db.current_knowledge_version()
    with db.transaction() as connection:
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at
               ) VALUES('broken-rule', ?, '{broken', '阁下', 1, 'provisional',
                        'book', 0, ?, 'now')""",
            (concept_id, version),
        )

    with pytest.raises(KnowledgeSnapshotError, match="broken-rule") as error:
        db.freeze_translation_knowledge()

    assert error.value.rule_id == "broken-rule"


def test_atomic_finish_validates_snapshot_without_global_invalidation_and_rolls_back(
    tmp_path, monkeypatch
):
    db = _db(tmp_path, ["Archon spoke."])
    concept_id = db.import_legacy_concept("Archon", "", "title", "office")
    db.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "旧译名", "rules": []}]
    )
    version, _, signature = db.freeze_translation_knowledge()
    block = db.list_blocks()[0]
    db.start_run("finish-run", "translate", {}, knowledge_version=version)
    db.commit_translation_batch(
        "finish-run",
        [
            TranslationOutcome(
                block=block,
                knowledge_version=version,
                status=V4BlockStatus.COMPLETED.value,
                final_translation="译文。",
                matched_concept_ids=[concept_id],
            )
        ],
    )
    with db.transaction() as connection:
        connection.execute(
            """UPDATE dependencies
               SET matched_form=?, source_spans_json=?
               WHERE translation_id=(
                   SELECT id FROM translation_versions
                   WHERE block_id=? AND pipeline='parallel_v4' AND active=1
               )""",
            (block.source_text, json.dumps([[0, len(block.source_text)]]), block.id),
        )
    original = db._concept_snapshot_from_connection
    change_ids = []

    def change_inside_finish(connection):
        old_state = db._render_state_for_subject(connection, "concept", concept_id)
        connection.execute(
            "UPDATE concepts SET working_target='新译名' WHERE id=?", (concept_id,)
        )
        changed_version = db.create_knowledge_version(
            "test changed knowledge during finish", connection
        )
        change = db.record_render_change(
            connection,
            subject_type="concept",
            subject_id=concept_id,
            old_state=old_state,
            new_state=db._render_state_for_subject(connection, "concept", concept_id),
            change_kind="target",
            reason="test changed knowledge during finish",
            knowledge_version=changed_version,
        )
        change_ids.append(change["change_id"])
        return original(connection)

    monkeypatch.setattr(db, "_concept_snapshot_from_connection", change_inside_finish)
    status, knowledge_stale = db.finish_translation_run_atomically(
        "finish-run", signature, "completed"
    )
    assert status == "completed"
    assert knowledge_stale is False
    assert db.active_translations()[block.id]["status"] == "completed"
    assert db.get_block_by_identifier(block.id).status == "completed"
    planned = RevalidationPlanner(db).plan(change_ids)
    assert planned["planned"] == 1
    assert db.status_summary()["needs_revalidate"] == 1
    assert db.active_translations()[block.id]["status"] == "completed"

    db.start_run("failure-run", "translate", {})
    monkeypatch.setattr(
        db,
        "_concept_snapshot_from_connection",
        lambda _connection: (_ for _ in ()).throw(RuntimeError("finish exploded")),
    )
    with pytest.raises(RuntimeError, match="finish exploded"):
        db.finish_translation_run_atomically("failure-run", signature, "completed")
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT status FROM runs WHERE id='failure-run'"
        ).fetchone()[0] == "running"
