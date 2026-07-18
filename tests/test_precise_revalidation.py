import hashlib
import json
import re
import sqlite3
from collections.abc import Sequence
from contextlib import closing, contextmanager
from dataclasses import replace
from decimal import Decimal

import pytest

from src.core.v4.context import ContextBuilder
from src.core.v4.database import KnowledgeSnapshotError, V4Database, render_fingerprint
from src.core.v4.pipeline import V4TranslationPipeline
from src.core.v4.revalidation import (
    MAX_CHANGE_IDS,
    MAX_RESULT_BYTES,
    PlanningBudgetError,
    RevalidationPlanner,
    RevalidationRunner,
)
from src.core.v4.repairer import V4Repairer
import src.core.v4.models as v4_models
from src.core.v4.coreference import cache_key, semantic_cache_key
from src.core.v4.models import (
    CoreferenceCase,
    CoreferenceConceptAnchor,
    CoreferenceMention,
    CoreferenceTypeObservation,
    Island,
    RenderingMatchSnapshot,
    TranslationOutcome,
    V4BlockStatus,
)


def _database(tmp_path, texts):
    root = tmp_path / "book"
    root.mkdir(parents=True)
    database = V4Database(root)
    edition = database.ensure_source_edition("raw", "normalized", "test", "source.txt")
    database.upsert_blocks(
        edition,
        [
            {
                "id": f"block-{index}",
                "chapter_id": "chapter-1",
                "chapter_title": "One",
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
    return database


def _match(
    lexeme_id,
    matched_form,
    start,
    end,
    target,
    *,
    concept_id=None,
    rule_ids=(),
    fingerprint="winner-fingerprint",
):
    return RenderingMatchSnapshot(
        lexeme_id=lexeme_id,
        concept_id=concept_id,
        matched_form=matched_form,
        start_offset=start,
        end_offset=end,
        rendered_target=target,
        applied_rule_ids=tuple(rule_ids),
        dependency_fingerprint=fingerprint,
    )


def _insert_revalidation_change(
    database,
    *,
    subject_type="lexeme",
    subject_id="lexeme-test",
    impact=1,
    old_fingerprint="old-fingerprint",
    new_fingerprint="new-fingerprint",
    change_kind="target",
    payload=None,
):
    with database.transaction() as connection:
        version = database.create_knowledge_version(
            f"revalidation test {subject_type}:{subject_id}", connection
        )
        return int(
            connection.execute(
                """INSERT INTO knowledge_changes(
                       knowledge_version, subject_type, subject_id, change_kind,
                       old_fingerprint, new_fingerprint, impact_level,
                       payload_json, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'now')""",
                (
                    version,
                    subject_type,
                    subject_id,
                    change_kind,
                    old_fingerprint,
                    new_fingerprint,
                    impact,
                    json.dumps(payload or {}, sort_keys=True),
                ),
            ).lastrowid
        )


def _insert_revalidation_translation(
    database,
    block_id,
    *,
    pipeline="parallel_v4",
    translation_status="completed",
    block_status="completed",
    active=1,
    dependency=None,
):
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET status=? WHERE id=?", (block_status, block_id)
        )
        source_text = str(
            connection.execute(
                "SELECT source_text FROM blocks WHERE id=?", (block_id,)
            ).fetchone()[0]
        )
        version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        translation_id = int(
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, status,
                       final_translation, active, created_at)
                   VALUES(?, ?, ?, ?, 'translated', ?, 'now')""",
                (block_id, pipeline, version, translation_status, active),
            ).lastrowid
        )
        if dependency is not None:
            dependency_type, dependency_id, fingerprint = dependency
            connection.execute(
                """INSERT INTO dependencies(
                       translation_id, dependency_type, dependency_id,
                       knowledge_version, dependency_fingerprint,
                       matched_form, source_spans_json)
                   VALUES(?, ?, ?, ?, ?, ?, ?)""",
                (
                    translation_id,
                    dependency_type,
                    dependency_id,
                    version,
                    fingerprint,
                    source_text,
                    json.dumps([[0, len(source_text)]]),
                ),
            )
    return translation_id


def _coreference_semantic_case():
    observation = CoreferenceTypeObservation(
        observation_id=1,
        kind="person",
        confidence=0.9,
        source="human",
        evidence_id=7,
    )
    mention = CoreferenceMention(
        mention_id=3,
        request_id="M001",
        lexeme_id="lex-1",
        evidence_id=7,
        block_id="block-1",
        paragraph_id="P000",
        block_kind="prose",
        source_hash="source-hash",
        source_edition_hash="edition-hash",
        source_form="Archon",
        discourse_function="vocative",
        context="Archon spoke.",
        context_source="paragraph",
        start_offset=0,
        end_offset=6,
        type_observations=(observation,),
        concept_anchor_ids=("concept-1",),
    )
    anchor = CoreferenceConceptAnchor(
        concept_id="concept-1",
        kind="person",
        canonical_source="Archon",
        status="verified",
        role="primary",
        anchor_mention_id=3,
        evidence_id=7,
    )
    return CoreferenceCase(
        case_id="R001",
        mention_set_id="mention-set-1",
        knowledge_version=1,
        lexeme_id="lex-1",
        language="en",
        normalized_form="archon",
        canonical_form="Archon",
        mentions=(mention,),
        type_observations=(observation,),
        concept_anchors=(anchor,),
    )


def test_coreference_semantic_cache_ignores_global_version_but_not_case_evidence():
    case = _coreference_semantic_case()
    models = ("model-a", "model-b")
    original = semantic_cache_key(case, models)
    changed_version = replace(case, knowledge_version=99)
    assert semantic_cache_key(changed_version, models) == original
    assert cache_key(changed_version, models) != cache_key(case, models)

    mention = case.mentions[0]
    observation = case.type_observations[0]
    anchor = case.concept_anchors[0]
    variants = (
        replace(case, mentions=(replace(mention, evidence_id=8),)),
        replace(case, mentions=(replace(mention, source_hash="changed"),)),
        replace(case, mentions=(replace(mention, context="changed context"),)),
        replace(case, type_observations=(replace(observation, kind="place"),)),
        replace(case, concept_anchors=(replace(anchor, role="alias"),)),
    )
    assert all(semantic_cache_key(value, models) != original for value in variants)


def test_render_fingerprint_ignores_metadata_but_tracks_render_semantics():
    base = {
        "working_target": "执政官",
        "status": "provisional",
        "description": "old prose",
        "kind": "title",
        "evidence_count": 1,
        "created_at": "yesterday",
        "rules": [
            {
                "id": "rule-1",
                "condition": {"speaker": "A", "discourse_function": "vocative"},
                "target": "阁下",
                "priority": 20,
                "locked": False,
                "status": "provisional",
            }
        ],
    }
    metadata_only = {
        **base,
        "description": "new prose",
        "kind": "person",
        "evidence_count": 99,
        "created_at": "today",
    }
    reordered = {
        **metadata_only,
        "rules": [
            {
                "target": "阁下",
                "locked": False,
                "priority": 20,
                "condition": {"discourse_function": "vocative", "speaker": "A"},
                "id": "rule-1",
                "status": "provisional",
            }
        ],
    }
    assert render_fingerprint("lexeme", "lex-1", base) == render_fingerprint(
        "lexeme", "lex-1", reordered
    )
    changed_rule_id = json.loads(json.dumps(base, ensure_ascii=False))
    changed_rule_id["rules"][0]["id"] = "replacement-rule-id"
    assert render_fingerprint("lexeme", "lex-1", base) == render_fingerprint(
        "lexeme", "lex-1", changed_rule_id
    )
    assert render_fingerprint("lexeme", "lex-1", base) != render_fingerprint(
        "lexeme", "lex-1", {**base, "working_target": "总督"}
    )
    changed_rule = json.loads(json.dumps(base, ensure_ascii=False))
    changed_rule["rules"][0]["condition"]["speaker"] = "B"
    assert render_fingerprint("lexeme", "lex-1", base) != render_fingerprint(
        "lexeme", "lex-1", changed_rule
    )


def test_render_fingerprint_has_clear_type_depth_and_size_limits():
    with pytest.raises(ValueError, match="subject_type"):
        render_fingerprint("", "lex-1", {})
    with pytest.raises(TypeError, match="mapping"):
        render_fingerprint("lexeme", "lex-1", [])
    nested = {}
    cursor = nested
    for _ in range(20):
        cursor["condition"] = {}
        cursor = cursor["condition"]
    with pytest.raises(ValueError, match="depth"):
        render_fingerprint("lexeme", "lex-1", nested)
    with pytest.raises(ValueError, match="string"):
        render_fingerprint("lexeme", "lex-1", {"working_target": "x" * 5000})


def test_claim_fingerprint_tracks_prompt_semantics_but_not_metadata():
    base = {
        "exists": True,
        "active": True,
        "accepted": True,
        "kind": "translation_constraint",
        "statement": "Keep the title neutral.",
        "subject_form": "Archon",
        "scope": "book",
        "reveal_global_index": 7,
        "locked": False,
        "high_impact_constraint": False,
        "confidence": 0.8,
        "evidence_count": 1,
        "created_at": "old",
    }
    metadata = {
        **base,
        "confidence": 0.1,
        "evidence_count": 999,
        "created_at": "new",
    }
    assert render_fingerprint("claim", "claim-1", base) == render_fingerprint(
        "claim", "claim-1", metadata
    )
    assert render_fingerprint("claim", "claim-1", base) != render_fingerprint(
        "claim", "claim-1", {**base, "statement": "Use a different title."}
    )
    assert render_fingerprint("claim", "claim-1", base) != render_fingerprint(
        "claim", "claim-1", {**base, "accepted": False}
    )


def test_non_prompt_claims_share_one_semantic_state_and_create_has_no_render_impact(
    tmp_path,
):
    inactive_states = (
        {},
        {
            "exists": True,
            "active": True,
            "accepted": False,
            "kind": "translation_constraint",
            "statement": "P" * 200_000,
            "subject_form": "Archon",
            "scope": "book",
            "reveal_global_index": 999,
            "locked": True,
            "high_impact_constraint": True,
        },
        {
            "exists": True,
            "active": False,
            "accepted": True,
            "kind": "translation_constraint",
            "statement": "RETIRED CONTENT B",
            "subject_form": "Other",
            "scope": "occurrence",
            "reveal_global_index": 1,
            "locked": True,
            "high_impact_constraint": True,
        },
    )
    fingerprints = {
        render_fingerprint("claim", "claim-inactive", state)
        for state in inactive_states
    }
    assert len(fingerprints) == 1

    database = _database(tmp_path, ["Archon spoke."])
    claim_id = database.create_claim(
        kind="translation_constraint",
        statement="PROPOSED CONTENT A",
        reveal_global_index=0,
        subject_form="Archon",
        high_impact=True,
    )
    block = database.list_blocks()[0]
    frozen = database.freeze_render_bundle([block.id])
    assert frozen.claims_by_block[block.id] == ()
    with closing(database.connect()) as connection:
        changes = connection.execute(
            """SELECT change_kind, impact_level FROM knowledge_changes
               WHERE subject_type='claim' AND subject_id=?""",
            (claim_id,),
        ).fetchall()
    assert [tuple(row) for row in changes] in ([], [("metadata", 0)])


def test_frozen_claim_query_never_materializes_unbounded_text(tmp_path, monkeypatch):
    database = _database(tmp_path, ["Archon spoke."])
    version = database.current_knowledge_version()
    oversized = "x" * 200_000
    with database.transaction() as connection:
        connection.execute(
            """INSERT INTO claims(
                   id, kind, statement, subject_form, status, scope, confidence,
                   reveal_global_index, high_impact, locked, created_version, created_at
               ) VALUES(
                   'oversized-claim', 'translation_constraint', ?, 'Archon',
                   'verified', 'book', 1.0, 0, 0, 1, ?, 'now'
               )""",
            (oversized, version),
        )

    traced_sql = []
    materialized_lengths = []
    original_connect = database.connect

    def monitored_connect():
        connection = original_connect()
        connection.set_trace_callback(traced_sql.append)

        def bounded_row_factory(cursor, values):
            columns = [item[0] for item in cursor.description]
            row = dict(zip(columns, values))
            if "statement_length" in row:
                materialized_lengths.append(
                    (len(row["statement"]), int(row["statement_length"]))
                )
            return sqlite3.Row(cursor, values)

        connection.row_factory = bounded_row_factory
        return connection

    monkeypatch.setattr(database, "connect", monitored_connect)
    block = database.list_blocks()[0]
    with pytest.raises(KnowledgeSnapshotError, match="claim statement"):
        database.freeze_render_bundle([block.id])

    assert materialized_lengths == [(4097, len(oversized))]
    claim_select = next(
        sql
        for sql in traced_sql
        if "FROM claims" in sql and "translation_constraint" in sql
    )
    assert "SELECT *" not in claim_select.upper()
    assert "SUBSTR(statement" in claim_select


def test_claim_create_verify_and_human_resolution_record_semantic_changes(tmp_path):
    database = _database(tmp_path, ["Archon spoke."])
    locked_id = database.create_claim(
        kind="translation_constraint",
        statement="LOCKED",
        reveal_global_index=0,
        subject_form="Archon",
        status="verified",
        locked=True,
    )
    repeated_version = database.current_knowledge_version()
    assert database.create_claim(
        kind="translation_constraint",
        statement="LOCKED",
        reveal_global_index=0,
        subject_form="Archon",
        status="verified",
        locked=True,
    ) == locked_id
    assert database.current_knowledge_version() == repeated_version

    claim_id = database.create_claim(
        kind="translation_constraint",
        statement="PROPOSED",
        reveal_global_index=0,
        subject_form="Archon",
    )
    task = next(
        item
        for item in database.list_verification_tasks()
        if item["subject_id"] == claim_id
    )
    database.start_run("verify-claim", "verify", {})
    assert database.commit_verification_result(
        "verify-claim",
        task,
        [
            {"parsed": {"verdict": "support", "rationale": "yes"}},
            {"parsed": {"verdict": "support", "rationale": "yes"}},
        ],
    ) == "verified"
    with closing(database.connect()) as connection:
        locked_change = connection.execute(
            """SELECT impact_level FROM knowledge_changes
               WHERE subject_type='claim' AND subject_id=? ORDER BY id DESC LIMIT 1""",
            (locked_id,),
        ).fetchone()
        verified_changes = connection.execute(
            """SELECT impact_level FROM knowledge_changes
               WHERE subject_type='claim' AND subject_id=? ORDER BY id""",
            (claim_id,),
        ).fetchall()
    assert locked_change[0] == 3
    assert verified_changes[-1][0] == 2


def test_claim_mutation_failure_rolls_back_state_and_version(tmp_path, monkeypatch):
    database = _database(tmp_path, ["Archon"])
    claim_id = database.create_claim(
        kind="translation_constraint",
        statement="PROPOSED",
        reveal_global_index=0,
    )
    task = next(
        item
        for item in database.list_verification_tasks()
        if item["subject_id"] == claim_id
    )
    database.start_run("verify-failure", "verify", {})
    before = database.current_knowledge_version()
    monkeypatch.setattr(
        database,
        "record_render_change",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("change failed")),
    )
    with pytest.raises(RuntimeError, match="change failed"):
        database.commit_verification_result(
            "verify-failure",
            task,
            [
                {"parsed": {"verdict": "support", "rationale": "yes"}},
                {"parsed": {"verdict": "support", "rationale": "yes"}},
            ],
        )
    assert database.current_knowledge_version() == before
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT status FROM claims WHERE id=?", (claim_id,)
        ).fetchone()[0] == "proposed"
        assert connection.execute(
            "SELECT COUNT(*) FROM verification_votes WHERE task_id=?", (task["id"],)
        ).fetchone()[0] == 0


@pytest.mark.parametrize(
    ("old", "new", "kind", "expected"),
    [
        ({"description": "a"}, {"description": "b"}, "description", 0),
        ({"working_target": "A"}, {"working_target": "B"}, "description", 1),
        ({"working_target": "A"}, {"working_target": "B"}, "target", 1),
        (
            {"working_target": "A"},
            {"working_target": "A", "rules": [{"id": "r", "condition": {"speaker": "x"}, "target": "B"}]},
            "rendering_rule",
            2,
        ),
        (
            {"working_target": "A", "locked": False},
            {"working_target": "B", "locked": True},
            "human_lock",
            3,
        ),
    ],
)
def test_record_render_change_derives_impact_and_reuses_one_version(
    tmp_path, old, new, kind, expected
):
    database = _database(tmp_path, ["text"])
    before = database.current_knowledge_version()
    with database.transaction() as connection:
        result = database.record_render_change(
            connection,
            subject_type="lexeme",
            subject_id="lex-1",
            old_state=old,
            new_state=new,
            change_kind=kind,
            reason="test change",
            record_metadata=True,
        )
    if old == new or expected == 0 and render_fingerprint("lexeme", "lex-1", old) == render_fingerprint("lexeme", "lex-1", new):
        assert result["knowledge_version"] == before + 1
    else:
        assert result["knowledge_version"] == before + 1
    assert result["impact_level"] == expected
    with closing(database.connect()) as connection:
        change = connection.execute("SELECT * FROM knowledge_changes").fetchone()
        assert int(change["knowledge_version"]) == result["knowledge_version"]
        assert int(change["impact_level"]) == expected
        assert connection.execute("SELECT COUNT(*) FROM revalidation_tasks").fetchone()[0] == 0


def test_repeat_equal_render_change_creates_no_version_or_change(tmp_path):
    database = _database(tmp_path, ["text"])
    before = database.current_knowledge_version()
    state = {"working_target": "A", "description": "same"}
    with database.transaction() as connection:
        result = database.record_render_change(
            connection,
            subject_type="lexeme",
            subject_id="lex-1",
            old_state=state,
            new_state=dict(state),
            change_kind="target",
            reason="repeat",
        )
    assert result["changed"] is False
    assert result["knowledge_version"] is None
    assert database.current_knowledge_version() == before
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM knowledge_changes").fetchone()[0] == 0


def test_record_render_change_derives_kind_and_impact_instead_of_trusting_label(
    tmp_path
):
    database = _database(tmp_path, ["text"])
    version = database.current_knowledge_version()
    with database.transaction() as connection:
        target = database.record_render_change(
            connection,
            subject_type="lexeme",
            subject_id="lex-1",
            old_state={"working_target": "A"},
            new_state={"working_target": "B"},
            change_kind="human_lock",
            reason="forged label",
            knowledge_version=version,
        )
        rule = database.record_render_change(
            connection,
            subject_type="lexeme",
            subject_id="lex-2",
            old_state={"working_target": "A", "rules": []},
            new_state={
                "working_target": "A",
                "rules": [
                    {
                        "condition": {"speaker": "A"},
                        "target": "B",
                        "priority": 1,
                    }
                ],
            },
            change_kind="target",
            reason="downgraded label",
            knowledge_version=version,
        )
    assert (target["change_kind"], target["impact_level"]) == ("target", 1)
    assert (rule["change_kind"], rule["impact_level"]) == (
        "rendering_rule",
        2,
    )


def test_record_render_change_rejects_old_version_and_reuses_exact_duplicate(
    tmp_path
):
    database = _database(tmp_path, ["text"])
    old_version = database.current_knowledge_version()
    with database.transaction() as connection:
        current_version = database.create_knowledge_version("new current", connection)
        with pytest.raises(ValueError, match="current knowledge version"):
            database.record_render_change(
                connection,
                subject_type="lexeme",
                subject_id="lex-old",
                old_state={"working_target": "A"},
                new_state={"working_target": "B"},
                change_kind="target",
                reason="stale",
                knowledge_version=old_version,
            )
        first = database.record_render_change(
            connection,
            subject_type="lexeme",
            subject_id="lex-current",
            old_state={"working_target": "A"},
            new_state={"working_target": "B"},
            change_kind="human_lock",
            reason="first",
            knowledge_version=current_version,
        )
        repeated = database.record_render_change(
            connection,
            subject_type="lexeme",
            subject_id="lex-current",
            old_state={"working_target": "A"},
            new_state={"working_target": "B"},
            change_kind="target",
            reason="repeat",
            knowledge_version=current_version,
        )
    assert repeated["change_id"] == first["change_id"]
    with closing(database.connect()) as connection:
        assert connection.execute(
            """SELECT COUNT(*) FROM knowledge_changes
               WHERE knowledge_version=? AND subject_id='lex-current'""",
            (current_version,),
        ).fetchone()[0] == 1


def test_working_target_uses_its_write_version_for_one_render_change(tmp_path):
    database = _database(tmp_path, ["Archon"])
    concept_id = database.import_legacy_concept("Archon", "", "title", "office")
    result = database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "执政官", "rules": []}]
    )
    with closing(database.connect()) as connection:
        changes = connection.execute(
            "SELECT * FROM knowledge_changes WHERE knowledge_version=? ORDER BY id",
            (result["knowledge_version"],),
        ).fetchall()
        versions = connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions WHERE id=?",
            (result["knowledge_version"],),
        ).fetchone()[0]
    assert versions == 1
    assert len(changes) == 1
    assert changes[0]["knowledge_version"] == result["knowledge_version"]
    assert changes[0]["subject_type"] == "lexeme"
    assert changes[0]["impact_level"] == 1


def test_working_rule_change_is_impact_two_and_failure_rolls_back(tmp_path, monkeypatch):
    database = _database(tmp_path, ["Archon"])
    concept_id = database.import_legacy_concept("Archon", "", "title", "office")
    first = database.apply_working_target_decisions(
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
    with closing(database.connect()) as connection:
        impact = connection.execute(
            "SELECT impact_level FROM knowledge_changes WHERE knowledge_version=?",
            (first["knowledge_version"],),
        ).fetchone()[0]
    assert impact == 2
    before_version = database.current_knowledge_version()
    with closing(database.connect()) as connection:
        before_target = connection.execute(
            "SELECT working_target FROM lexemes WHERE id=(SELECT primary_lexeme_id FROM concepts WHERE id=?)",
            (concept_id,),
        ).fetchone()[0]

    monkeypatch.setattr(
        database,
        "record_render_change",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("change failed")),
    )
    with pytest.raises(RuntimeError, match="change failed"):
        database.apply_working_target_decisions(
            [{"concept_id": concept_id, "target": "总督", "rules": []}]
        )
    assert database.current_knowledge_version() == before_version
    with closing(database.connect()) as connection:
        after_target = connection.execute(
            "SELECT working_target FROM lexemes WHERE id=(SELECT primary_lexeme_id FROM concepts WHERE id=?)",
            (concept_id,),
        ).fetchone()[0]
    assert after_target == before_target


def test_human_lock_is_impact_three_and_exact_repeat_is_noop(tmp_path):
    database = _database(tmp_path, ["Archon"])
    first = database.lock_concept_translation("Archon", "执政官")
    version = database.current_knowledge_version()
    repeated = database.lock_concept_translation("Archon", "执政官")
    assert repeated["knowledge_version"] is None
    assert database.current_knowledge_version() == version
    with closing(database.connect()) as connection:
        changes = connection.execute(
            "SELECT * FROM knowledge_changes WHERE subject_id=? ORDER BY id",
            (first["concept_id"],),
        ).fetchall()
    assert len(changes) == 1
    assert changes[0]["impact_level"] == 3


def test_coreference_fallback_target_records_one_change_and_repeat_is_noop(tmp_path):
    database = _database(tmp_path, ["Archon"])
    concept_id = database.import_legacy_concept(
        "Archon", "执政官", "title", "office"
    )
    with closing(database.connect()) as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
    before = database.current_knowledge_version()
    result = database.apply_coreference_fallback(lexeme_id, [])
    assert result["changed"] is True
    assert result["knowledge_version"] == before + 1
    repeated = database.apply_coreference_fallback(lexeme_id, [])
    assert repeated["changed"] is False
    assert repeated["knowledge_version"] is None
    with closing(database.connect()) as connection:
        changes = connection.execute(
            "SELECT * FROM knowledge_changes WHERE subject_type='lexeme' AND subject_id=?",
            (lexeme_id,),
        ).fetchall()
    assert len(changes) == 1
    assert changes[0]["knowledge_version"] == result["knowledge_version"]
    assert changes[0]["impact_level"] == 1


def test_commit_aggregates_exact_lexeme_concept_rule_and_claim_dependencies(tmp_path):
    text = "Archon met ARCHON."
    database = _database(tmp_path, [text])
    database.start_run("run-1", "translate", {})
    block = database.list_blocks()[0]
    first_start = text.index("Archon")
    second_start = text.index("ARCHON")
    matches = (
        _match("lex-1", "Archon", first_start, first_start + 6, "执政官", concept_id="concept-1", rule_ids=("rule-1",)),
        _match("lex-1", "ARCHON", second_start, second_start + 6, "阁下", concept_id="concept-1", rule_ids=("rule-2",), fingerprint="winner-2"),
    )
    database.commit_translation_batch(
        "run-1",
        [
            TranslationOutcome(
                block=block,
                knowledge_version=database.current_knowledge_version(),
                status=V4BlockStatus.COMPLETED.value,
                final_translation="译文",
                matched_renderings=matches,
                claim_dependencies=[
                    v4_models.ClaimDependencySnapshot("claim-1", "a" * 64),
                    v4_models.ClaimDependencySnapshot("claim-1", "a" * 64),
                ],
            )
        ],
    )
    with closing(database.connect()) as connection:
        rows = connection.execute(
            "SELECT * FROM dependencies ORDER BY dependency_type, dependency_id"
        ).fetchall()
    assert [(row["dependency_type"], row["dependency_id"]) for row in rows] == [
        ("claim", "claim-1"),
        ("concept", "concept-1"),
        ("lexeme", "lex-1"),
        ("rule", "rule-1"),
        ("rule", "rule-2"),
    ]
    lexeme = next(row for row in rows if row["dependency_type"] == "lexeme")
    assert lexeme["occurrence_count"] == 2
    assert json.loads(lexeme["source_spans_json"]) == [[0, 6], [11, 17]]
    assert json.loads(lexeme["applied_rule_ids_json"]) == ["rule-1", "rule-2"]
    assert lexeme["matched_form"] == "ARCHON"
    assert "target_count" in lexeme["rendered_target"]
    assert len(lexeme["dependency_fingerprint"]) == 64


def test_frozen_claim_dependency_keeps_semantic_fingerprint_after_same_id_mutates(
    tmp_path
):
    snapshot_type = getattr(v4_models, "ClaimDependencySnapshot", None)
    assert snapshot_type is not None, "ClaimDependencySnapshot must be public"
    database = _database(tmp_path, ["Archon spoke."])
    claim_id = database.create_claim(
        kind="translation_constraint",
        statement="OLD STATEMENT",
        reveal_global_index=0,
        subject_form="Archon",
        status="verified",
        locked=True,
    )
    block = database.list_blocks()[0]
    frozen = database.freeze_render_bundle([block.id])
    frozen_claim = frozen.claims_by_block[block.id][0]
    assert re.fullmatch(r"[0-9a-f]{64}", frozen_claim["semantic_fingerprint"])
    dependency = snapshot_type(
        claim_id=claim_id,
        semantic_fingerprint=frozen_claim["semantic_fingerprint"],
    )
    database.start_run(
        "run-claim-fingerprint",
        "translate",
        {
            "frozen_knowledge_version": frozen.knowledge_version,
            "target_snapshot_signature": frozen.signature,
        },
        knowledge_version=frozen.knowledge_version,
    )
    database.commit_translation_batch(
        "run-claim-fingerprint",
        [
            TranslationOutcome(
                block=block,
                knowledge_version=frozen.knowledge_version,
                status=V4BlockStatus.COMPLETED.value,
                claim_dependencies=(dependency,),
            )
        ],
    )
    with database.transaction() as connection:
        version = database.create_knowledge_version("update claim statement", connection)
        old_state = database._claim_state_for_subject(connection, claim_id)
        connection.execute(
            "UPDATE claims SET statement='NEW STATEMENT' WHERE id=?", (claim_id,)
        )
        database.record_render_change(
            connection,
            subject_type="claim",
            subject_id=claim_id,
            old_state=old_state,
            new_state=database._claim_state_for_subject(connection, claim_id),
            change_kind="metadata",
            reason="update claim statement",
            knowledge_version=version,
        )
    next_bundle = database.freeze_render_bundle([block.id])
    assert next_bundle.claims_by_block[block.id][0][
        "semantic_fingerprint"
    ] != frozen_claim["semantic_fingerprint"]
    with closing(database.connect()) as connection:
        stored = connection.execute(
            """SELECT dependency_fingerprint FROM dependencies
               WHERE dependency_type='claim' AND dependency_id=?""",
            (claim_id,),
        ).fetchone()[0]
    assert stored == frozen_claim["semantic_fingerprint"]


def test_translation_commit_rejects_unknown_and_run_mismatched_versions(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    block = database.list_blocks()[0]
    database.start_run("run-version", "translate", {})
    unknown = TranslationOutcome(
        block=block,
        knowledge_version=999999,
        status=V4BlockStatus.COMPLETED.value,
        matched_renderings=(_match("lex-a", "Alpha", 0, 5, "A"),),
    )
    with pytest.raises(ValueError, match="knowledge version"):
        database.commit_translation_batch("run-version", [unknown])

    run_version = database.current_knowledge_version()
    database.create_claim(
        kind="interpretation_hypothesis",
        statement="newer",
        reveal_global_index=0,
    )
    mismatched = replace(unknown, knowledge_version=database.current_knowledge_version())
    assert mismatched.knowledge_version != run_version
    with pytest.raises(ValueError, match="run.*knowledge version|knowledge version.*run"):
        database.commit_translation_batch("run-version", [mismatched])
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM translation_versions"
        ).fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM dependencies").fetchone()[0] == 0


def test_translation_commit_rejects_inconsistent_run_bundle_config(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    block = database.list_blocks()[0]
    version = database.current_knowledge_version()
    database.start_run(
        "run-bad-bundle",
        "translate",
        {
            "frozen_knowledge_version": version + 1,
            "target_snapshot_signature": "0" * 64,
        },
        knowledge_version=version,
    )
    with pytest.raises(ValueError, match="bundle|frozen"):
        database.commit_translation_batch(
            "run-bad-bundle",
            [
                TranslationOutcome(
                    block=block,
                    knowledge_version=version,
                    status=V4BlockStatus.COMPLETED.value,
                    matched_renderings=(
                        _match("lex-a", "Alpha", 0, 5, "A"),
                    ),
                )
            ],
        )


def test_translation_commit_snapshots_inputs_before_transaction_and_rejects_duck_matches(
    tmp_path, monkeypatch
):
    database = _database(tmp_path, ["Alpha"])
    block = database.list_blocks()[0]
    database.start_run("run-snapshot", "translate", {})
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        final_translation="SAFE",
    )
    original_transaction = database.transaction

    @contextmanager
    def mutate_after_entry_snapshot():
        outcome.final_translation = "EVIL"
        with original_transaction() as connection:
            yield connection

    monkeypatch.setattr(database, "transaction", mutate_after_entry_snapshot)
    database.commit_translation_batch("run-snapshot", [outcome])
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT final_translation FROM translation_versions"
        ).fetchone()[0] == "SAFE"

    class EvilDuck:
        @property
        def lexeme_id(self):
            raise AssertionError("getter must never run")

    second = _database(tmp_path / "duck", ["Alpha"])
    second.start_run("run-duck", "translate", {})
    evil = TranslationOutcome(
        block=second.list_blocks()[0],
        knowledge_version=second.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        matched_renderings=(EvilDuck(),),
    )
    with pytest.raises(ValueError, match="RenderingMatchSnapshot|mapping|snapshot"):
        second.commit_translation_batch("run-duck", [evil])


def test_translation_proposals_record_one_shared_semantic_change_and_repeat_noop(
    tmp_path
):
    database = _database(tmp_path, ["NovelTerm appeared."])
    database.start_run("proposal-run", "translate", {})
    block = database.list_blocks()[0]
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        term_proposals=[
            {
                "src": "NovelTerm",
                "tgt": "NOVEL",
                "type": "concept",
                "context": "term",
            }
        ],
    )
    result = database.commit_translation_proposals(
        "proposal-run", [outcome], return_change_ids=True
    )
    version = result["knowledge_version"]
    assert version is not None
    assert result["change_ids"] == sorted(set(result["change_ids"]))
    assert len(result["change_ids"]) == 1
    with closing(database.connect()) as connection:
        changes = connection.execute(
            "SELECT impact_level FROM knowledge_changes WHERE knowledge_version=?",
            (version,),
        ).fetchall()
        before = (
            connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone()[0],
            connection.execute("SELECT COUNT(*) FROM knowledge_changes").fetchone()[0],
        )
        assert connection.execute(
            "SELECT COUNT(*) FROM dependencies WHERE dependency_type='concept'"
        ).fetchone()[0] == 0
    assert [row[0] for row in changes] == [2]
    assert database.commit_translation_proposals(
        "proposal-run", [outcome], return_change_ids=True
    ) == {"knowledge_version": None, "change_ids": []}
    with closing(database.connect()) as connection:
        after = (
            connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone()[0],
            connection.execute("SELECT COUNT(*) FROM knowledge_changes").fetchone()[0],
        )
    assert after == before


def test_translation_proposal_target_only_change_is_impact_one(tmp_path):
    database = _database(tmp_path, ["Archon"])
    concept_id = database.import_legacy_concept("Archon", "", "title", "office")
    with database.transaction() as connection:
        connection.execute("UPDATE concepts SET status='verified' WHERE id=?", (concept_id,))
    database.start_run("proposal-target", "translate", {})
    block = database.list_blocks()[0]
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        term_proposals=[{"src": "Archon", "tgt": "ARCHON", "type": "title"}],
    )
    version = database.commit_translation_proposals("proposal-target", [outcome])
    with closing(database.connect()) as connection:
        row = connection.execute(
            """SELECT impact_level FROM knowledge_changes
               WHERE knowledge_version=? AND subject_id=?""",
            (version, concept_id),
        ).fetchone()
    assert row[0] == 1


def test_k0_claim_and_prior_materialization_are_hard_bounded(tmp_path):
    claims_db = _database(tmp_path / "claims", ["Archon"])
    version = claims_db.current_knowledge_version()
    with claims_db.transaction() as connection:
        connection.executemany(
            """INSERT INTO claims(
                   id, kind, statement, subject_form, status, scope, confidence,
                   reveal_global_index, high_impact, locked, created_version, created_at)
               VALUES(?, 'translation_constraint', ?, '', 'verified', 'book',
                      1.0, 0, 0, 0, ?, 'now')""",
            [(f"claim-{index:04d}", f"statement {index}", version) for index in range(1000)],
        )
    with pytest.raises(KnowledgeSnapshotError, match="claim|limit|bound"):
        claims_db.freeze_render_bundle(["block-0"])

    prior_db = _database(
        tmp_path / "prior",
        ["scape " + ("x" * 10000), "The scape opened."],
    )
    prior_db.import_legacy_concept("scape", "SCAPE", "concept", "world")
    bundle = prior_db.freeze_render_bundle(["block-1"])
    evidence = bundle.prior_concept_evidence_by_block["block-1"]
    assert len(evidence) <= 2
    assert sum(len(item["source_text"]) for item in evidence) <= 3600


def test_spans_are_bounded_but_occurrence_count_is_complete_and_commit_is_idempotent(tmp_path):
    text = " ".join(["Term"] * 1000)
    database = _database(tmp_path, [text])
    database.start_run("run-scale", "translate", {})
    block = database.list_blocks()[0]
    matches = tuple(
        _match("lex-term", "Term", start, start + 4, "术语")
        for start in range(0, len(text), 5)
    )
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        matched_renderings=matches,
    )
    database.commit_translation_batch("run-scale", [outcome])
    database.commit_translation_batch("run-scale", [outcome])
    with closing(database.connect()) as connection:
        translations = connection.execute("SELECT COUNT(*) FROM translation_versions").fetchone()[0]
        row = connection.execute("SELECT * FROM dependencies").fetchone()
    assert translations == 1
    assert row["occurrence_count"] == 1000
    assert len(json.loads(row["source_spans_json"])) == 128


def test_unicode_combination_span_is_valid_and_defaults_are_immutable(tmp_path):
    text = "Cafe\u0301"
    database = _database(tmp_path, [text])
    database.start_run("run-unicode", "translate", {})
    block = database.list_blocks()[0]
    empty = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
    )
    assert empty.matched_renderings == ()
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        matched_renderings=(
            _match("lex-cafe", text, 0, len(text), "咖啡馆"),
        ),
    )
    database.commit_translation_batch("run-unicode", [outcome])
    with closing(database.connect()) as connection:
        row = connection.execute("SELECT source_spans_json FROM dependencies").fetchone()
    assert json.loads(row[0]) == [[0, 5]]


def test_source_or_span_drift_rolls_back_entire_batch(tmp_path):
    database = _database(tmp_path, ["Alpha", "Beta"])
    database.start_run("run-drift", "translate", {})
    first, second = database.list_blocks()
    outcomes = [
        TranslationOutcome(
            block=first,
            knowledge_version=database.current_knowledge_version(),
            status=V4BlockStatus.COMPLETED.value,
            matched_renderings=(_match("lex-a", "Alpha", 0, 5, "甲"),),
        ),
        TranslationOutcome(
            block=second,
            knowledge_version=database.current_knowledge_version(),
            status=V4BlockStatus.COMPLETED.value,
            matched_renderings=(_match("lex-b", "WRONG", 0, 4, "乙"),),
        ),
    ]
    with pytest.raises(ValueError, match="span|source"):
        database.commit_translation_batch("run-drift", outcomes)
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM translation_versions").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM dependencies").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0] == 0


def test_source_text_must_still_match_its_real_sha256(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    database.start_run("run-hash-drift", "translate", {})
    original = database.list_blocks()[0]
    changed_text = "Omega"
    changed_block = replace(original, source_text=changed_text)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET source_text=? WHERE id=?",
            (changed_text, original.id),
        )
    with pytest.raises(ValueError, match="hash"):
        database.commit_translation_batch(
            "run-hash-drift",
            [
                TranslationOutcome(
                    block=changed_block,
                    knowledge_version=database.current_knowledge_version(),
                    status=V4BlockStatus.COMPLETED.value,
                    matched_renderings=(
                        _match("lex-o", changed_text, 0, len(changed_text), "Omega"),
                    ),
                )
            ],
        )


@pytest.mark.parametrize(
    "forged_hash",
    [
        hashlib.sha256(b"Alpha").hexdigest().upper(),
        "not-a-sha256",
        "0" * 64,
    ],
)
def test_exact_dependencies_require_authentic_lowercase_source_hash(
    tmp_path, forged_hash
):
    database = _database(tmp_path, ["Alpha"])
    database.start_run("run-forged-hash", "translate", {})
    original = database.list_blocks()[0]
    forged_block = replace(original, source_hash=forged_hash)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET source_hash=? WHERE id=?",
            (forged_hash, original.id),
        )

    with pytest.raises(ValueError, match="hash"):
        database.commit_translation_batch(
            "run-forged-hash",
            [
                TranslationOutcome(
                    block=forged_block,
                    knowledge_version=database.current_knowledge_version(),
                    status=V4BlockStatus.COMPLETED.value,
                    matched_renderings=(
                        _match("lex-a", "Alpha", 0, 5, "A"),
                    ),
                )
            ],
        )
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM translation_versions"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM dependencies"
        ).fetchone()[0] == 0


def test_translation_proposals_do_not_backfill_false_exact_dependencies(tmp_path):
    database = _database(tmp_path, ["NovelTerm appeared."])
    database.start_run("run-proposal", "translate", {})
    block = database.list_blocks()[0]
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        term_proposals=[
            {"src": "NovelTerm", "tgt": "新术语", "type": "concept", "context": "term"}
        ],
    )
    database.commit_translation_batch("run-proposal", [outcome])
    database.commit_translation_proposals("run-proposal", [outcome])
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM dependencies WHERE dependency_type='concept'"
        ).fetchone()[0] == 0


def test_replacement_keeps_historical_dependencies_on_old_translation(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    block = database.list_blocks()[0]
    outcomes_by_run = {}
    for ordinal, target in enumerate(("甲", "阿尔法"), start=1):
        run_id = f"run-{ordinal}"
        database.start_run(run_id, "translate", {})
        outcome = TranslationOutcome(
                    block=block,
                    knowledge_version=database.current_knowledge_version(),
                    status=V4BlockStatus.COMPLETED.value,
                    matched_renderings=(
                        _match("lex-a", "Alpha", 0, 5, target, fingerprint=f"winner-{ordinal}"),
                    ),
                )
        outcomes_by_run[run_id] = outcome
        database.commit_translation_batch(run_id, [outcome])
    database.commit_translation_batch("run-1", [outcomes_by_run["run-1"]])
    with closing(database.connect()) as connection:
        translations = connection.execute(
            "SELECT id, active FROM translation_versions ORDER BY id"
        ).fetchall()
        dependencies = connection.execute(
            "SELECT translation_id, rendered_target FROM dependencies ORDER BY translation_id"
        ).fetchall()
    assert [row["active"] for row in translations] == [0, 1]
    assert [row["translation_id"] for row in dependencies] == [
        translations[0]["id"],
        translations[1]["id"],
    ]
    assert [row["rendered_target"] for row in dependencies] == ["甲", "阿尔法"]


def test_merge_only_rewrites_active_translation_dependency_rows(tmp_path):
    database = _database(tmp_path, ["scape"])
    canonical_id = database.import_legacy_concept(
        "scape", "SCAPE", "concept", "canonical"
    )
    old_id = database.import_legacy_concept(
        "scapes", "SCAPES", "concept", "plural"
    )
    version = database.current_knowledge_version()
    with database.transaction() as connection:
        inactive_translation = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at)
               VALUES('block-0', 'parallel_v4', ?, 'completed', 'old', 0, 'old')""",
            (version,),
        ).lastrowid
        active_translation = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at)
               VALUES('block-0', 'parallel_v4', ?, 'completed', 'new', 1, 'new')""",
            (version,),
        ).lastrowid
        connection.executemany(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version, dependency_fingerprint, matched_form,
                   occurrence_count, rendered_target, applied_rule_ids_json,
                   source_spans_json)
               VALUES(?, 'concept', ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    inactive_translation,
                    old_id,
                    version,
                    "historical-fingerprint",
                    "scapes",
                    7,
                    "HISTORICAL",
                    '["historical-rule"]',
                    "[[11,17]]",
                ),
                (
                    active_translation,
                    canonical_id,
                    version,
                    "active-canonical",
                    "scape",
                    1,
                    "SCAPE",
                    "[]",
                    "[[0,5]]",
                ),
                (
                    active_translation,
                    old_id,
                    version,
                    "active-old",
                    "scapes",
                    2,
                    "SCAPES",
                    "[]",
                    "[[6,12]]",
                ),
            ],
        )
        inactive_before = tuple(
            connection.execute(
                "SELECT * FROM dependencies WHERE translation_id=?",
                (inactive_translation,),
            ).fetchone()
        )

    database.merge_concept_forms("scape", ["scapes"])

    with closing(database.connect()) as connection:
        inactive_after = tuple(
            connection.execute(
                "SELECT * FROM dependencies WHERE translation_id=?",
                (inactive_translation,),
            ).fetchone()
        )
        active_rows = connection.execute(
            """SELECT dependency_id, occurrence_count FROM dependencies
               WHERE translation_id=? AND dependency_type='concept'""",
            (active_translation,),
        ).fetchall()
    assert inactive_after == inactive_before
    assert [tuple(row) for row in active_rows] == [(canonical_id, 3)]


def test_rule_rebuild_metadata_does_not_raise_target_change_impact(tmp_path):
    database = _database(tmp_path, ["Archon"])
    concept_id = database.import_legacy_concept(
        "Archon", "", "title", "office"
    )
    rule = {"condition": {"speaker": "A"}, "target": "HONORIFIC"}
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "A", "rules": [rule]}]
    )
    second = database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "B", "rules": [rule]}]
    )
    with closing(database.connect()) as connection:
        change = connection.execute(
            """SELECT impact_level, change_kind FROM knowledge_changes
               WHERE knowledge_version=?""",
            (second["knowledge_version"],),
        ).fetchone()
    assert tuple(change) == (1, "target")


def test_synonymous_rule_id_and_version_rebuild_has_same_state_fingerprint(tmp_path):
    database = _database(tmp_path, ["Archon"])
    concept_id = database.import_legacy_concept("Archon", "", "title", "office")
    database.apply_working_target_decisions(
        [
            {
                "concept_id": concept_id,
                "target": "A",
                "rules": [
                    {"condition": {"speaker": "A"}, "target": "HONORIFIC"}
                ],
            }
        ]
    )
    with database.transaction() as connection:
        lexeme_id = connection.execute(
            "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0]
        old_state = database._render_state_for_subject(
            connection, "lexeme", lexeme_id
        )
        row = connection.execute(
            """SELECT * FROM rendering_rules
               WHERE lexeme_id=? AND retired_version IS NULL""",
            (lexeme_id,),
        ).fetchone()
        connection.execute(
            "UPDATE rendering_rules SET retired_version=created_version WHERE id=?",
            (row["id"],),
        )
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, lexeme_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at)
               VALUES('replacement-rule', ?, ?, ?, ?, 'legacy_provisional',
                      ?, ?, ?, 'replacement-time')""",
            (
                lexeme_id,
                row["condition_json"],
                row["target"],
                row["priority"],
                row["scope"],
                row["locked"],
                row["created_version"],
            ),
        )
        new_state = database._render_state_for_subject(
            connection, "lexeme", lexeme_id
        )

    assert old_state["rendering_rules_sha256"] == new_state[
        "rendering_rules_sha256"
    ]
    assert render_fingerprint("lexeme", lexeme_id, old_state) == render_fingerprint(
        "lexeme", lexeme_id, new_state
    )


def test_legacy_import_creates_one_version_change_and_audit_then_replays_noop(
    tmp_path, monkeypatch
):
    database = _database(tmp_path, ["Archon"])
    before = database.current_knowledge_version()
    concept_id = database.import_legacy_concept(
        "Archon", "ARCHON", "title", "office"
    )
    created_version = database.current_knowledge_version()
    assert created_version == before + 1
    with closing(database.connect()) as connection:
        concept = connection.execute(
            "SELECT created_version FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()
        lexeme = connection.execute(
            """SELECT created_version FROM lexemes
               WHERE id=(SELECT primary_lexeme_id FROM concepts WHERE id=?)""",
            (concept_id,),
        ).fetchone()
        rule = connection.execute(
            "SELECT created_version FROM rendering_rules WHERE concept_id=?",
            (concept_id,),
        ).fetchone()
        changes = connection.execute(
            "SELECT impact_level FROM knowledge_changes WHERE knowledge_version=?",
            (created_version,),
        ).fetchall()
        audits = connection.execute(
            "SELECT purpose FROM audit_calls WHERE knowledge_version=?",
            (created_version,),
        ).fetchall()
        counts_before = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "knowledge_versions",
                "knowledge_changes",
                "audit_calls",
                "concepts",
                "lexemes",
                "rendering_rules",
            )
        }
    assert concept[0] == lexeme[0] == rule[0] == created_version
    assert [row[0] for row in changes] == [2]
    assert [row[0] for row in audits] == ["legacy_concept_import"]

    assert (
        database.import_legacy_concept("Archon", "ARCHON", "title", "office")
        == concept_id
    )
    with closing(database.connect()) as connection:
        counts_after = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in counts_before
        }
    assert counts_after == counts_before

    failure_root = tmp_path / "failure"
    failure_root.mkdir()
    failing = _database(failure_root, ["Other"])
    failing_before = failing.current_knowledge_version()
    monkeypatch.setattr(
        failing,
        "record_audit_call",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("audit failed")),
    )
    with pytest.raises(RuntimeError, match="audit failed"):
        failing.import_legacy_concept("Other", "OTHER", "title", "other")
    assert failing.current_knowledge_version() == failing_before
    with closing(failing.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts WHERE canonical_source='Other'"
        ).fetchone()[0] == 0


def test_full_translation_context_is_frozen_at_k0_and_mixed_bundle_is_rejected(
    tmp_path
):
    database = _database(
        tmp_path,
        ["Old scape evidence.", "Nothing here.", "The scape opened."],
    )
    database.import_legacy_concept("scape", "SCAPE", "concept", "world")
    current = database.list_blocks()[2]
    frozen = database.freeze_render_bundle([current.id])

    claim_id = database.create_claim(
        kind="translation_constraint",
        statement="NEW CLAIM",
        reveal_global_index=current.global_index,
        subject_form="scape",
        status="verified",
        locked=True,
    )
    changed_prior = "New scape evidence."
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET source_text=?, source_hash=? WHERE id='block-0'",
            (
                changed_prior,
                hashlib.sha256(changed_prior.encode("utf-8")).hexdigest(),
            ),
        )
    next_bundle = database.freeze_render_bundle([current.id])

    assert frozen.knowledge_version < next_bundle.knowledge_version
    assert frozen.claims_by_block[current.id] == ()
    assert [item["id"] for item in next_bundle.claims_by_block[current.id]] == [
        claim_id
    ]
    assert frozen.prior_concept_evidence_by_block[current.id][0][
        "source_text"
    ] == "Old scape evidence."
    assert next_bundle.prior_concept_evidence_by_block[current.id][0][
        "source_text"
    ] == changed_prior
    assert frozen.signature != next_bundle.signature

    old_packet = ContextBuilder(database, 5000).build(
        current,
        knowledge_version=frozen.knowledge_version,
        concept_snapshot=frozen.index,
        frozen_claims=frozen.claims_by_block[current.id],
        frozen_prior_concept_evidence=(
            frozen.prior_concept_evidence_by_block[current.id]
        ),
    )
    assert old_packet.knowledge_version == frozen.knowledge_version
    assert old_packet.matched_claim_ids == []
    assert "NEW CLAIM" not in old_packet.rendered
    assert "Old scape evidence." in old_packet.rendered
    assert changed_prior not in old_packet.rendered
    with pytest.raises(RuntimeError, match="frozen claims"):
        ContextBuilder(database, 5000).build(
            current,
            knowledge_version=frozen.knowledge_version,
            concept_snapshot=frozen.index,
        )

    pipeline = V4TranslationPipeline(database, lambda: None)
    pipeline._active_render_bundle = frozen
    database.import_legacy_concept("other", "OTHER", "concept", "other")
    mixed_bundle = database.freeze_render_bundle([current.id])
    with pytest.raises(RuntimeError, match="exact frozen render bundle"):
        pipeline._translate_island(
            Island(id="mixed", blocks=[current]),
            frozen.knowledge_version,
            mixed_bundle.index,
        )


def test_revalidation_planner_enforces_translation_and_block_hard_conditions(tmp_path):
    database = _database(
        tmp_path,
        ["ready", "no active", "serial only", "parallel active"],
    )
    _insert_revalidation_translation(
        database,
        "block-0",
        block_status="ready",
        dependency=("concept", "concept-hard", "old-fingerprint"),
    )
    _insert_revalidation_translation(
        database,
        "block-1",
        active=0,
        dependency=("concept", "concept-hard", "old-fingerprint"),
    )
    _insert_revalidation_translation(
        database,
        "block-2",
        pipeline="serial_v3",
        dependency=("concept", "concept-hard", "old-fingerprint"),
    )
    valid_translation = _insert_revalidation_translation(
        database,
        "block-3",
        dependency=("concept", "concept-hard", "old-fingerprint"),
    )
    change_id = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-hard"
    )

    result = RevalidationPlanner(database).plan([change_id])

    assert result["planned"] == 1
    with closing(database.connect()) as connection:
        tasks = connection.execute(
            "SELECT * FROM revalidation_tasks ORDER BY translation_id"
        ).fetchall()
        block_statuses = dict(connection.execute("SELECT id, status FROM blocks"))
    assert [row["translation_id"] for row in tasks] == [valid_translation]
    assert tasks[0]["status"] == "pending"
    assert tasks[0]["attempts"] == 0
    assert tasks[0]["action"] == ""
    assert block_statuses == {
        "block-0": "ready",
        "block-1": "completed",
        "block-2": "completed",
        "block-3": "completed",
    }


def test_revalidation_planner_rejects_unknown_and_skips_non_effective_changes(tmp_path):
    database = _database(tmp_path, ["valid"])
    translation_id = _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("lexeme", "lexeme-test", "old-fingerprint"),
    )
    zero = _insert_revalidation_change(database, impact=0)
    same = _insert_revalidation_change(
        database,
        old_fingerprint="same-fingerprint",
        new_fingerprint="same-fingerprint",
    )
    effective = _insert_revalidation_change(database)
    planner = RevalidationPlanner(database)

    assert planner.plan([])["planned"] == 0
    with pytest.raises(KeyError, match="unknown knowledge change"):
        planner.plan([effective, 999_999])
    with pytest.raises(ValueError, match="positive integers"):
        planner.plan([str(effective)])
    result = planner.plan([effective, zero, same, effective])

    assert result["planned"] == 1
    with closing(database.connect()) as connection:
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
    assert task["translation_id"] == translation_id
    assert json.loads(task["result_json"])["change_ids"] == [effective]


@pytest.mark.parametrize("bad_id", ["1", 1.0, Decimal("1"), True])
def test_revalidation_planner_rejects_non_integer_change_ids_atomically(
    tmp_path, bad_id
):
    database = _database(tmp_path, ["Alpha"])

    with pytest.raises(ValueError, match="positive integers"):
        RevalidationPlanner(database).plan([bad_id])

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks"
        ).fetchone()[0] == 0


def test_revalidation_planner_rejects_input_over_budget_before_writes(tmp_path):
    database = _database(tmp_path, ["Alpha"])

    with pytest.raises(PlanningBudgetError, match="planning budget"):
        RevalidationPlanner(database).plan(list(range(1, MAX_CHANGE_IDS + 2)))

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks"
        ).fetchone()[0] == 0


def test_revalidation_rejects_duplicate_raw_flood_before_database_access(
    tmp_path, monkeypatch
):
    database = _database(tmp_path, ["Alpha"])
    monkeypatch.setattr(
        database,
        "transaction",
        lambda: (_ for _ in ()).throw(
            AssertionError("input validation must not enter a database transaction")
        ),
    )

    with pytest.raises(PlanningBudgetError, match="raw change_ids"):
        RevalidationPlanner(database).plan([1] * 100_000)
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks"
        ).fetchone()[0] == 0


def test_revalidation_checks_raw_length_before_traversing_sequence(tmp_path):
    database = _database(tmp_path, ["Alpha"])

    class OversizedSequence(Sequence):
        def __len__(self):
            return 100_000

        def __getitem__(self, _index):
            raise AssertionError("oversized sequence must not be traversed")

    with pytest.raises(PlanningBudgetError, match="raw change_ids"):
        RevalidationPlanner(database).plan(OversizedSequence())


def test_revalidation_counts_duplicate_integer_bytes_before_deduplication(
    tmp_path, monkeypatch
):
    database = _database(tmp_path, ["Alpha"])
    monkeypatch.setattr(
        database,
        "transaction",
        lambda: (_ for _ in ()).throw(
            AssertionError("input validation must not enter a database transaction")
        ),
    )
    large_id = 10**100

    with pytest.raises(PlanningBudgetError, match="input byte budget"):
        RevalidationPlanner(database).plan([large_id] * MAX_CHANGE_IDS)


def test_revalidation_accepts_raw_boundary_for_duplicates_and_unique_ids():
    assert RevalidationPlanner._normalize_change_ids([1] * MAX_CHANGE_IDS) == [1]
    assert RevalidationPlanner._normalize_change_ids(
        list(range(1, MAX_CHANGE_IDS + 1))
    ) == list(range(1, MAX_CHANGE_IDS + 1))


def test_revalidation_rejects_iterators_before_consuming_them(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    consumed = {"value": False}

    def values():
        consumed["value"] = True
        yield 1

    with pytest.raises(TypeError, match="sequence"):
        RevalidationPlanner(database).plan(values())
    assert consumed["value"] is False


def test_revalidation_only_plans_changes_strictly_newer_than_translation(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    same_or_older = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-forward"
    )
    translation_id = _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-forward", "old-fingerprint"),
    )

    assert RevalidationPlanner(database).plan([same_or_older])["planned"] == 0

    newer = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-forward",
        new_fingerprint="newer-fingerprint",
    )
    assert RevalidationPlanner(database).plan([same_or_older, newer])["planned"] == 1
    with closing(database.connect()) as connection:
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
        translation_version = int(
            connection.execute(
                "SELECT knowledge_version FROM translation_versions WHERE id=?",
                (translation_id,),
            ).fetchone()[0]
        )
        newer_version = int(
            connection.execute(
                "SELECT knowledge_version FROM knowledge_changes WHERE id=?", (newer,)
            ).fetchone()[0]
        )
    assert task["from_knowledge_version"] == translation_version
    assert task["to_knowledge_version"] == newer_version
    assert task["from_knowledge_version"] < task["to_knowledge_version"]
    assert json.loads(task["result_json"])["change_ids"] == [newer]


def test_revalidation_requires_dependency_version_to_match_translation(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    translation_id = _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-version", "old-fingerprint"),
    )
    with database.transaction() as connection:
        connection.execute(
            "UPDATE dependencies SET knowledge_version=knowledge_version-1 WHERE translation_id=?",
            (translation_id,),
        )
    change_id = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-version"
    )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 0


def test_revalidation_requires_authentic_source_and_provable_dependency_spans(tmp_path):
    database = _database(
        tmp_path, ["uppercase", "malformed", "bad span", "valid"]
    )
    translations = [
        _insert_revalidation_translation(
            database,
            f"block-{index}",
            dependency=("concept", "concept-source", "old-fingerprint"),
        )
        for index in range(4)
    ]
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET source_hash=upper(source_hash) WHERE id='block-0'"
        )
        connection.execute(
            "UPDATE blocks SET source_hash='not-a-sha256' WHERE id='block-1'"
        )
        connection.execute(
            "UPDATE dependencies SET source_spans_json='[[0,2]]' WHERE translation_id=?",
            (translations[2],),
        )
    change_id = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-source"
    )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 1
    with closing(database.connect()) as connection:
        planned = connection.execute(
            "SELECT translation_id FROM revalidation_tasks"
        ).fetchall()
    assert [row[0] for row in planned] == [translations[3]]


def test_revalidation_planner_uses_fresh_occurrences_without_regex_and_filters_stale(
    tmp_path, monkeypatch
):
    database = _database(tmp_path, ["NovelName appeared.", "NovelName vanished."])
    concept_id = database.import_legacy_concept("NovelName", "", "person", "new")
    with database.transaction() as connection:
        lexeme_id = str(
            connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
            ).fetchone()[0]
        )
        rows = connection.execute(
            "SELECT id, source_hash FROM blocks ORDER BY global_index"
        ).fetchall()
        connection.executemany(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES(?, ?, 0, 9, 'NovelName', ?, 'now')""",
            [
                (lexeme_id, rows[0]["id"], rows[0]["source_hash"]),
                (lexeme_id, rows[1]["id"], "stale-source-hash"),
            ],
        )
    valid_translation = _insert_revalidation_translation(database, "block-0")
    _insert_revalidation_translation(database, "block-1")
    change_id = _insert_revalidation_change(
        database,
        subject_type="lexeme",
        subject_id=lexeme_id,
        old_fingerprint="",
        new_fingerprint="new-lexeme-fingerprint",
        change_kind="source_form_added",
    )
    monkeypatch.setattr(
        re,
        "compile",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("planner must not compile whole-book regexes")
        ),
    )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 1
    with closing(database.connect()) as connection:
        tasks = connection.execute(
            "SELECT translation_id, result_json FROM revalidation_tasks"
        ).fetchall()
    assert [row["translation_id"] for row in tasks] == [valid_translation]
    payload = json.loads(tasks[0]["result_json"])
    assert payload["source_hash"] == hashlib.sha256(
        "NovelName appeared.".encode("utf-8")
    ).hexdigest()
    assert "NovelName appeared." not in tasks[0]["result_json"]


def test_revalidation_concept_occurrence_ignores_links_created_after_change(tmp_path):
    database = _database(tmp_path, ["Alias"])
    concept_id = database.import_legacy_concept(
        "Canonical", "Canonical", "person", "temporal"
    )
    with database.transaction() as connection:
        version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        connection.execute(
            """INSERT INTO lexemes(
                   id, language, normalized_form, canonical_form,
                   created_version, created_at)
               VALUES('lexeme-temporal-late', 'en', 'alias', 'Alias', ?, 'now')""",
            (version,),
        )
        block = connection.execute(
            "SELECT id, source_hash FROM blocks WHERE id='block-0'"
        ).fetchone()
        connection.execute(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES('lexeme-temporal-late', ?, 0, 5, 'Alias', ?, 'now')""",
            (block["id"], block["source_hash"]),
        )
    _insert_revalidation_translation(database, "block-0")
    change_id = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id=concept_id,
        new_fingerprint="concept-at-k4",
    )
    with database.transaction() as connection:
        late_version = database.create_knowledge_version("late link", connection)
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, 'lexeme-temporal-late', 'alias', 1.0, 'verified', ?, 'now')""",
            (concept_id, late_version),
        )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 0


def test_revalidation_concept_occurrence_uses_link_valid_at_historical_change(
    tmp_path,
):
    database = _database(tmp_path, ["Alias"])
    concept_id = database.import_legacy_concept(
        "Canonical", "Canonical", "person", "temporal"
    )
    with database.transaction() as connection:
        link_version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        connection.execute(
            """INSERT INTO lexemes(
                   id, language, normalized_form, canonical_form,
                   created_version, created_at)
               VALUES('lexeme-temporal-old', 'en', 'alias-old', 'Alias', ?, 'now')""",
            (link_version,),
        )
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES(?, 'lexeme-temporal-old', 'alias', 1.0, 'verified', ?, 'now')""",
            (concept_id, link_version),
        )
        block = connection.execute(
            "SELECT id, source_hash FROM blocks WHERE id='block-0'"
        ).fetchone()
        connection.execute(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES('lexeme-temporal-old', ?, 0, 5, 'Alias', ?, 'now')""",
            (block["id"], block["source_hash"]),
        )
    translation_id = _insert_revalidation_translation(database, "block-0")
    change_id = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id=concept_id,
        new_fingerprint="concept-before-retirement",
    )
    with database.transaction() as connection:
        retired_version = database.create_knowledge_version("retire link", connection)
        connection.execute(
            """UPDATE concept_lexemes SET retired_version=?
               WHERE concept_id=? AND lexeme_id='lexeme-temporal-old'""",
            (retired_version, concept_id),
        )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 1
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT translation_id FROM revalidation_tasks"
        ).fetchone()[0] == translation_id


def test_revalidation_pending_is_idempotent_and_merges_supersets_canonically(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-merge", "translation-fingerprint"),
    )
    first = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-merge",
        impact=1,
        new_fingerprint="new-one",
    )
    second = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-merge",
        impact=3,
        new_fingerprint="new-two",
    )
    planner = RevalidationPlanner(database)

    planner.plan([first])
    with closing(database.connect()) as connection:
        before = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
        before_tuple = (before["id"], before["attempts"], before["created_at"])
    planner.plan([first, first])
    planner.plan([second, first])
    with closing(database.connect()) as connection:
        merged_result_json = str(
            connection.execute("SELECT result_json FROM revalidation_tasks").fetchone()[0]
        )
    planner.plan([second, first])
    planner.plan([first])

    with closing(database.connect()) as connection:
        tasks = connection.execute("SELECT * FROM revalidation_tasks").fetchall()
    assert len(tasks) == 1
    task = tasks[0]
    assert (task["id"], task["attempts"], task["created_at"]) == before_tuple
    assert task["impact_level"] == 3
    assert json.loads(task["result_json"])["change_ids"] == [first, second]
    assert task["result_json"] == merged_result_json
    expected_hash = hashlib.sha256(
        json.dumps(
            {
                "change_ids": [first, second],
                "to_knowledge_version": task["to_knowledge_version"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert task["change_set_hash"] == expected_hash


def test_revalidation_pending_merge_preserves_occurrence_provenance(tmp_path):
    database = _database(tmp_path, ["NovelName"])
    concept_id = database.import_legacy_concept(
        "NovelName", "NovelName", "person", "provenance"
    )
    with database.transaction() as connection:
        lexeme_id = str(
            connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
            ).fetchone()[0]
        )
        block = connection.execute(
            "SELECT id, source_hash FROM blocks WHERE id='block-0'"
        ).fetchone()
        connection.execute(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES(?, ?, 0, 9, 'NovelName', ?, 'now')""",
            (lexeme_id, block["id"], block["source_hash"]),
        )
    translation_id = _insert_revalidation_translation(database, "block-0")
    occurrence_change = _insert_revalidation_change(
        database,
        subject_type="lexeme",
        subject_id=lexeme_id,
        new_fingerprint="occurrence-change",
        change_kind="source_form_added",
    )
    planner = RevalidationPlanner(database)
    assert planner.plan([occurrence_change])["planned"] == 1
    with database.transaction() as connection:
        translation = connection.execute(
            """SELECT tv.knowledge_version, b.source_text
               FROM translation_versions tv JOIN blocks b ON b.id=tv.block_id
               WHERE tv.id=?""",
            (translation_id,),
        ).fetchone()
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version, dependency_fingerprint,
                   matched_form, source_spans_json)
               VALUES(?, 'concept', 'concept-later-dependency', ?, 'old', ?, ?)""",
            (
                translation_id,
                translation["knowledge_version"],
                translation["source_text"],
                json.dumps([[0, len(translation["source_text"])]]),
            ),
        )
    dependency_change = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-later-dependency",
        new_fingerprint="dependency-change",
    )

    assert planner.plan([dependency_change])["merged"] == 1
    with closing(database.connect()) as connection:
        payload = json.loads(
            connection.execute("SELECT result_json FROM revalidation_tasks").fetchone()[0]
        )
    reasons = {reason["change_id"]: reason for reason in payload["reasons"]}
    assert reasons[occurrence_change]["via"] == ["occurrence"]
    assert reasons[dependency_change]["via"] == ["dependency"]
    assert reasons[occurrence_change]["subjects"] == [
        {"subject_id": lexeme_id, "subject_type": "lexeme"}
    ]


def test_revalidation_pending_merge_rejects_missing_old_provenance_atomically(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-protocol", "old"),
    )
    first = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-protocol"
    )
    planner = RevalidationPlanner(database)
    planner.plan([first])
    with database.transaction() as connection:
        payload = json.loads(
            connection.execute("SELECT result_json FROM revalidation_tasks").fetchone()[0]
        )
        payload["reasons"] = []
        connection.execute(
            "UPDATE revalidation_tasks SET result_json=?",
            (json.dumps(payload, sort_keys=True),),
        )
    with closing(database.connect()) as connection:
        before = tuple(connection.execute("SELECT * FROM revalidation_tasks").fetchone())
    second = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-protocol",
        new_fingerprint="newer",
    )

    with pytest.raises(ValueError, match="provenance"):
        planner.plan([second])

    with closing(database.connect()) as connection:
        after = tuple(connection.execute("SELECT * FROM revalidation_tasks").fetchone())
    assert after == before


def test_revalidation_validating_snapshot_is_immutable_with_pending_successor(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-validating", "translation-fingerprint"),
    )
    first = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-validating"
    )
    second = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-validating",
        new_fingerprint="newer-fingerprint",
    )
    planner = RevalidationPlanner(database)
    planner.plan([first])
    with database.transaction() as connection:
        connection.execute(
            "UPDATE revalidation_tasks SET status='validating' WHERE status='pending'"
        )
    with closing(database.connect()) as connection:
        validating_before = tuple(
            connection.execute(
                "SELECT * FROM revalidation_tasks WHERE status='validating'"
            ).fetchone()
        )

    planner.plan([first, second])

    with closing(database.connect()) as connection:
        validating_after = tuple(
            connection.execute(
                "SELECT * FROM revalidation_tasks WHERE status='validating'"
            ).fetchone()
        )
        pending = connection.execute(
            "SELECT * FROM revalidation_tasks WHERE status='pending'"
        ).fetchone()
    assert validating_after == validating_before
    assert json.loads(pending["result_json"])["change_ids"] == [second]


def test_revalidation_retires_inactive_pending_and_plans_replacement(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    old_translation = _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-replacement", "old"),
    )
    change_id = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-replacement"
    )
    planner = RevalidationPlanner(database)
    planner.plan([change_id])
    with database.transaction() as connection:
        connection.execute(
            "UPDATE translation_versions SET active=0 WHERE id=?", (old_translation,)
        )
        version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        source_text = str(
            connection.execute(
                "SELECT source_text FROM blocks WHERE id='block-0'"
            ).fetchone()[0]
        )
        new_translation = int(
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, status,
                       final_translation, active, created_at)
                   VALUES('block-0', 'parallel_v4', ?, 'completed', 'new', 1, 'new')""",
                (version,),
            ).lastrowid
        )
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version, dependency_fingerprint,
                   matched_form, source_spans_json)
               VALUES(?, 'concept', 'concept-replacement', ?, 'old', ?, ?)""",
            (
                new_translation,
                version,
                source_text,
                json.dumps([[0, len(source_text)]]),
            ),
        )

    replacement_change = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-replacement",
        new_fingerprint="replacement-new",
    )
    planner.plan([change_id, replacement_change])

    with closing(database.connect()) as connection:
        rows = connection.execute(
            "SELECT translation_id, status, result_json FROM revalidation_tasks ORDER BY translation_id"
        ).fetchall()
    assert [(row["translation_id"], row["status"]) for row in rows] == [
        (old_translation, "resolved_noop"),
        (new_translation, "pending"),
    ]
    assert json.loads(rows[0]["result_json"])["reason"] == "translation_inactive"
    assert json.loads(rows[1]["result_json"])["change_ids"] == [replacement_change]


def test_status_summary_derives_revalidation_without_overwriting_block_status(tmp_path):
    database = _database(tmp_path, ["Alpha", "Beta"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("claim", "claim-summary", "old"),
    )
    _insert_revalidation_translation(
        database,
        "block-1",
        dependency=("claim", "claim-summary", "old"),
    )
    change_id = _insert_revalidation_change(
        database, subject_type="claim", subject_id="claim-summary"
    )
    RevalidationPlanner(database).plan([change_id])

    summary = database.status_summary()

    assert summary["completed"] == 2
    assert summary["needs_revalidate"] == 2
    assert summary["needs_revalidate_translations"] == 2
    assert all(block.status == "completed" for block in database.list_blocks())


def test_revalidation_trigger_failure_rolls_back_all_task_changes(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-trigger", "old"),
    )
    first = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-trigger"
    )
    second = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-trigger",
        new_fingerprint="new-two",
    )
    planner = RevalidationPlanner(database)
    planner.plan([first])
    with closing(database.connect()) as connection:
        before = tuple(connection.execute("SELECT * FROM revalidation_tasks").fetchone())
    with database.transaction() as connection:
        connection.execute(
            """CREATE TRIGGER fail_revalidation_update
               BEFORE UPDATE ON revalidation_tasks
               BEGIN SELECT RAISE(ABORT, 'task update failed'); END"""
        )

    with pytest.raises(sqlite3.IntegrityError, match="task update failed"):
        planner.plan([second])

    with closing(database.connect()) as connection:
        after = tuple(connection.execute("SELECT * FROM revalidation_tasks").fetchone())
    assert after == before


def test_revalidation_does_not_trust_arbitrary_payload_subjects(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "forged-concept", "old"),
    )
    change_id = _insert_revalidation_change(
        database,
        subject_type="lexeme",
        subject_id="unrelated-lexeme",
        payload={"subject_type": "concept", "subject_id": "forged-concept"},
    )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 0
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks"
        ).fetchone()[0] == 0


def test_revalidation_expands_only_database_verified_concept_redirects(tmp_path):
    database = _database(tmp_path, ["real merge", "forged merge"])
    canonical_id = database.import_legacy_concept(
        "Canonical", "Canonical", "person", "canonical"
    )
    retired_id = database.import_legacy_concept(
        "Retired", "Retired", "person", "retired"
    )
    real_translation = _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", retired_id, "old-fingerprint"),
    )
    _insert_revalidation_translation(
        database,
        "block-1",
        dependency=("concept", "forged-concept", "old-fingerprint"),
    )
    with database.transaction() as connection:
        version = database.create_knowledge_version("verified merge", connection)
        connection.execute(
            "UPDATE concepts SET status='merged', retired_version=? WHERE id=?",
            (version, retired_id),
        )
        connection.execute(
            """INSERT INTO concept_redirects(
                   retired_concept_id, canonical_concept_id, reason,
                   knowledge_version, created_at)
               VALUES(?, ?, 'verified merge', ?, 'now')""",
            (retired_id, canonical_id, version),
        )
        change_id = int(
            connection.execute(
                """INSERT INTO knowledge_changes(
                       knowledge_version, subject_type, subject_id, change_kind,
                       old_fingerprint, new_fingerprint, impact_level,
                       payload_json, created_at)
                   VALUES(?, 'concept', ?, 'concept_merge', 'old', 'new', 1, ?, 'now')""",
                (
                    version,
                    canonical_id,
                    json.dumps(
                        {
                            "canonical_concept_id": canonical_id,
                            "merged_concept_ids": [retired_id, "forged-concept"],
                        },
                        sort_keys=True,
                    ),
                ),
            ).lastrowid
        )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 1
    with closing(database.connect()) as connection:
        tasks = connection.execute(
            "SELECT translation_id, result_json FROM revalidation_tasks"
        ).fetchall()
    assert [row["translation_id"] for row in tasks] == [real_translation]
    assert {
        (subject["subject_type"], subject["subject_id"])
        for subject in json.loads(tasks[0]["result_json"])["subjects"]
    } == {("concept", retired_id)}
    with database.transaction() as connection:
        translation = connection.execute(
            """SELECT tv.knowledge_version, b.source_text
               FROM translation_versions tv JOIN blocks b ON b.id=tv.block_id
               WHERE tv.id=?""",
            (real_translation,),
        ).fetchone()
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version, dependency_fingerprint,
                   matched_form, source_spans_json)
               VALUES(?, 'concept', 'concept-after-redirect', ?, 'old', ?, ?)""",
            (
                real_translation,
                translation["knowledge_version"],
                translation["source_text"],
                json.dumps([[0, len(translation["source_text"])]]),
            ),
        )
    later_change = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-after-redirect",
        new_fingerprint="later-change",
    )

    assert RevalidationPlanner(database).plan([later_change])["merged"] == 1
    with closing(database.connect()) as connection:
        merged_payload = json.loads(
            connection.execute("SELECT result_json FROM revalidation_tasks").fetchone()[0]
        )
    reasons = {
        reason["change_id"]: reason for reason in merged_payload["reasons"]
    }
    assert reasons[change_id]["subjects"] == [
        {"subject_id": retired_id, "subject_type": "concept"}
    ]


def test_revalidation_expands_only_verified_rule_and_lexeme_relationships(tmp_path):
    database = _database(
        tmp_path, ["actual lexeme", "forged lexeme", "actual rule", "forged rule"]
    )
    concept_id = database.import_legacy_concept(
        "Linked", "Linked", "person", "linked"
    )
    with database.transaction() as connection:
        lexeme_id = str(
            connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
            ).fetchone()[0]
        )
        version = int(
            connection.execute("SELECT MAX(id) FROM knowledge_versions").fetchone()[0]
        )
        connection.execute(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   scope, locked, created_version, created_at)
               VALUES('rule-linked', ?, '{}', 'Linked', 0, 'verified',
                      'book', 0, ?, 'now')""",
            (concept_id, version),
        )
    actual_lexeme = _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("lexeme", lexeme_id, "old-fingerprint"),
    )
    _insert_revalidation_translation(
        database,
        "block-1",
        dependency=("lexeme", "forged-lexeme", "old-fingerprint"),
    )
    actual_rule = _insert_revalidation_translation(
        database,
        "block-2",
        dependency=("rule", "rule-linked", "old-fingerprint"),
    )
    _insert_revalidation_translation(
        database,
        "block-3",
        dependency=("rule", "forged-rule", "old-fingerprint"),
    )
    change_id = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id=concept_id,
        change_kind="rule_alias_lexeme_update",
        payload={
            "lexeme_ids": [lexeme_id, "forged-lexeme"],
            "rule_ids": ["rule-linked", "forged-rule"],
        },
    )

    assert RevalidationPlanner(database).plan([change_id])["planned"] == 2
    with closing(database.connect()) as connection:
        planned = connection.execute(
            "SELECT translation_id FROM revalidation_tasks ORDER BY translation_id"
        ).fetchall()
    assert [row[0] for row in planned] == [actual_lexeme, actual_rule]


@pytest.mark.parametrize(
    ("corrupt_result", "expected_error"),
    [
        ("{", ValueError),
        (json.dumps({"change_ids": ["1"]}), ValueError),
        (
            json.dumps({"change_ids": list(range(1, MAX_CHANGE_IDS + 2))}),
            PlanningBudgetError,
        ),
        ("x" * (MAX_RESULT_BYTES + 1), PlanningBudgetError),
    ],
    ids=["invalid-json", "non-integer-id", "too-many-ids", "too-many-bytes"],
)
def test_revalidation_rejects_corrupt_pending_results_atomically(
    tmp_path, corrupt_result, expected_error
):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-corrupt", "old-fingerprint"),
    )
    first = _insert_revalidation_change(
        database, subject_type="concept", subject_id="concept-corrupt"
    )
    planner = RevalidationPlanner(database)
    planner.plan([first])
    with database.transaction() as connection:
        connection.execute(
            "UPDATE revalidation_tasks SET result_json=?", (corrupt_result,)
        )
    with closing(database.connect()) as connection:
        before = tuple(connection.execute("SELECT * FROM revalidation_tasks").fetchone())
    second = _insert_revalidation_change(
        database,
        subject_type="concept",
        subject_id="concept-corrupt",
        new_fingerprint="newer-fingerprint",
    )

    with pytest.raises(expected_error):
        planner.plan([second])

    with closing(database.connect()) as connection:
        after = tuple(connection.execute("SELECT * FROM revalidation_tasks").fetchone())
    assert after == before


def test_revalidation_rejects_oversized_final_result_atomically(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _insert_revalidation_translation(
        database,
        "block-0",
        dependency=("concept", "concept-result-budget", "old-fingerprint"),
    )
    change_ids = []
    with database.transaction() as connection:
        for index in range(257):
            version = database.create_knowledge_version(
                f"large result {index}", connection
            )
            change_ids.append(
                int(
                    connection.execute(
                        """INSERT INTO knowledge_changes(
                               knowledge_version, subject_type, subject_id,
                               change_kind, old_fingerprint, new_fingerprint,
                               impact_level, payload_json, created_at)
                           VALUES(?, 'concept', 'concept-result-budget', ?,
                                  'old-fingerprint', ?, 1, '{}', 'now')""",
                        (version, "large-" + ("x" * 400), f"new-{index}"),
                    ).lastrowid
                )
            )

    with pytest.raises(PlanningBudgetError, match="result exceeds byte budget"):
        RevalidationPlanner(database).plan(change_ids)

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM revalidation_tasks"
        ).fetchone()[0] == 0


def test_revalidation_scales_to_one_thousand_active_completed_translations(tmp_path):
    translated = _database(
        tmp_path / "translated", [f"Alpha {i}" for i in range(1_000)]
    )
    for index in range(1_000):
        _insert_revalidation_translation(
            translated,
            f"block-{index}",
            dependency=("concept", "concept-many", "old"),
        )
    change_id = _insert_revalidation_change(
        translated, subject_type="concept", subject_id="concept-many"
    )
    assert RevalidationPlanner(translated).plan([change_id])["planned"] == 1_000

    ready = _database(tmp_path / "ready", [f"Alpha {i}" for i in range(36)])
    ready_change = _insert_revalidation_change(
        ready, subject_type="concept", subject_id="concept-many"
    )
    assert RevalidationPlanner(ready).plan([ready_change])["planned"] == 0
    assert all(block.status == "ready" for block in ready.list_blocks())


def test_revalidation_planner_is_a_public_v4_entry_point():
    from src.core.v4 import RevalidationPlanner as PublicRevalidationPlanner

    assert PublicRevalidationPlanner is RevalidationPlanner


def test_revalidation_scale_uses_bounded_index_queries_for_ten_thousand_occurrences(
    tmp_path, monkeypatch
):
    texts = [f"Alpha {index}" for index in range(10_000)]
    database = _database(tmp_path, texts)
    concept_id = database.import_legacy_concept("Alpha", "", "person", "scale")
    with database.transaction() as connection:
        lexeme_id = str(
            connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
            ).fetchone()[0]
        )
        rows = connection.execute(
            "SELECT id, source_hash FROM blocks ORDER BY global_index"
        ).fetchall()
        connection.executemany(
            """INSERT INTO form_occurrences(
                   lexeme_id, block_id, start_offset, end_offset,
                   source_form, source_hash, created_at)
               VALUES(?, ?, 0, 5, 'Alpha', ?, 'now')""",
            [(lexeme_id, row["id"], row["source_hash"]) for row in rows],
        )
    change_id = _insert_revalidation_change(
        database,
        subject_type="lexeme",
        subject_id=lexeme_id,
        old_fingerprint="",
        new_fingerprint="new-scale-fingerprint",
        change_kind="source_form_added",
    )
    before_size = database.path.stat().st_size
    statements = []
    original_connect = database.connect

    def traced_connect():
        connection = original_connect()
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(database, "connect", traced_connect)

    result = RevalidationPlanner(database).plan([change_id])

    assert result["planned"] == 0
    assert len(statements) < 80
    assert database.path.stat().st_size <= before_size + 4096
    assert all(block.status == "ready" for block in database.list_blocks())


class _Task11LLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def chat(self, **kwargs):
        self.requests.append(kwargs["messages"])
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def get_model(self, purpose):
        return f"task11-{purpose}"


def _task11_response(action):
    return json.dumps(
        {
            "task": "T001",
            "cases": ["C001"],
            "action": action,
            "confidence": 0.9,
            "rationale": "bounded test rationale",
        }
    )


def _task11_task(
    database,
    *,
    impact=1,
    target="新译名",
    block_id="block-0",
    subject_id="lexeme-task11",
):
    translation_id = _insert_revalidation_translation(
        database,
        block_id,
        dependency=("lexeme", subject_id, "old-fingerprint"),
    )
    with database.transaction() as connection:
        connection.execute(
            """UPDATE translation_versions
               SET draft_translation='旧译名在这里', final_translation='旧译名在这里'
               WHERE id=?""",
            (translation_id,),
        )
        connection.execute(
            """UPDATE dependencies
               SET rendered_target='旧译名', occurrence_count=1
               WHERE translation_id=?""",
            (translation_id,),
        )
    change_id = _insert_revalidation_change(
        database,
        subject_id=subject_id,
        impact=impact,
        payload={
            "old": {"working_target": "旧译名", "rules": []},
            "new": {"working_target": target, "rules": []},
            "reason": "working target changed",
        },
    )
    assert RevalidationPlanner(database).plan([change_id])["planned"] == 1
    return translation_id


class _Task12Translator:
    def __init__(self, database, failure):
        self.database = database
        self.failure = failure
        self.calls = []

    def __call__(self, block):
        self.calls.append(block.id)
        if block.id == "block-0":
            if isinstance(self.failure, Exception):
                raise self.failure
            return TranslationOutcome(
                block=block,
                knowledge_version=self.database.current_knowledge_version(),
                status=self.failure[0],
                final_translation=self.failure[1],
                error=self.failure[2],
                audit_calls=[
                    {
                        "purpose": "draft",
                        "model": "task12-fake",
                        "request": {"block_id": block.id},
                        "raw_response": "bad response",
                        "accepted": False,
                        "attempts": 1,
                        "elapsed_ms": 1,
                        "error": self.failure[2],
                    }
                ],
            )
        return TranslationOutcome(
            block=block,
            knowledge_version=self.database.current_knowledge_version(),
            status=V4BlockStatus.COMPLETED.value,
            draft_translation=f"new {block.id}",
            final_translation=f"new {block.id}",
            matched_renderings=(
                RenderingMatchSnapshot(
                    lexeme_id=f"fresh-{block.id}",
                    concept_id=None,
                    matched_form=block.source_text,
                    start_offset=0,
                    end_offset=len(block.source_text),
                    rendered_target=f"new {block.id}",
                    dependency_fingerprint="fresh-fingerprint",
                ),
            ),
        )


@pytest.mark.parametrize(
    ("expected_category", "failure", "expected_attempts"),
    [
        (
            "protocol",
            (V4BlockStatus.FAILED_RETRYABLE.value, "", "protocol response invalid"),
            2,
        ),
        (
            "structure",
            (V4BlockStatus.COMPLETED.value, "", "translation structure is empty"),
            2,
        ),
        ("external", TimeoutError("translation timeout"), 2),
        (
            "budget",
            (V4BlockStatus.FAILED_RETRYABLE.value, "", "token budget exceeded"),
            1,
        ),
        (
            "context",
            (
                V4BlockStatus.INCOMPLETE_REQUIRES_HUMAN.value,
                "",
                "context window exceeded",
            ),
            1,
        ),
    ],
    ids=["protocol", "structure", "external", "budget", "context"],
)
def test_task12_warning_fallback_keeps_old_translation_and_continues_queue(
    tmp_path, expected_category, failure, expected_attempts
):
    database = _database(tmp_path, ["Alpha", "Beta"])
    old_ids = [
        _task11_task(
            database,
            impact=3,
            block_id=f"block-{index}",
            subject_id=f"lexeme-task12-{index}",
        )
        for index in range(2)
    ]
    translator = _Task12Translator(database, failure)

    summary = RevalidationRunner(
        database,
        translate_block_factory=lambda: translator,
        max_attempts=2,
    ).run()

    assert summary["status"] == "completed_with_warnings"
    assert summary["warnings"] == 1
    assert summary["retranslate"] == 1
    assert translator.calls.count("block-0") == expected_attempts
    assert translator.calls.count("block-1") == 1
    with closing(database.connect()) as connection:
        tasks = connection.execute(
            "SELECT * FROM revalidation_tasks ORDER BY block_id"
        ).fetchall()
        failed_result = json.loads(tasks[0]["result_json"])
        versions = connection.execute(
            """SELECT id, block_id, status, validation_status, active
               FROM translation_versions ORDER BY id"""
        ).fetchall()
        assert tasks[0]["status"] == "completed_with_warning"
        assert tasks[0]["action"] == "warning_fallback"
        assert failed_result["error_category"] == expected_category
        assert failed_result["attempts"] == expected_attempts
        assert failed_result["last_audit_call_id"] is not None
        assert failed_result["stale_change_ids"]
        assert tasks[1]["status"] == "resolved_retranslate"
        assert tasks[1]["replacement_translation_id"] is not None
        assert connection.execute(
            """SELECT dependency_id FROM dependencies
               WHERE translation_id=?""",
            (tasks[1]["replacement_translation_id"],),
        ).fetchone()[0] == "fresh-block-1"
        assert [
            (row["id"], row["validation_status"], row["active"])
            for row in versions
            if row["block_id"] == "block-0"
        ] == [(old_ids[0], "warning_stale", 1)]
        assert sum(row["active"] for row in versions if row["block_id"] == "block-1") == 1
        assert len(versions) == 3
        assert connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE severity='blocking'"
        ).fetchone()[0] == 0
        run = connection.execute(
            "SELECT status FROM runs WHERE stage='revalidation'"
        ).fetchone()
        assert run["status"] == "completed_with_warnings"


def test_task11_validation_matrix_and_independent_frozen_payloads(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _task11_task(database, impact=2)
    left = _Task11LLM([_task11_response("no_effect")])
    right = _Task11LLM([_task11_response("no_effect")])
    summary = RevalidationRunner(
        database,
        validator_factories=(lambda: left, lambda: right),
        max_attempts=1,
    ).run()
    assert summary == {
        "claimed": 1,
        "noop": 1,
        "patched": 0,
        "retranslate": 0,
        "warnings": 0,
        "protocol_failures": 0,
        "conflicts": 0,
        "unfinished": 0,
        "status": "completed",
    }
    assert left.requests[0][1]["content"] == right.requests[0][1]["content"]
    with closing(database.connect()) as connection:
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
        assert task["status"] == "resolved_noop"
        assert connection.execute(
            "SELECT COUNT(*) FROM translation_versions"
        ).fetchone()[0] == 1


def test_task11_protocol_exhaustion_escalates_without_human_queue(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _task11_task(database, impact=2)
    invalid = _Task11LLM(["{}", "{}"])
    other = _Task11LLM([_task11_response("patch_required")])
    summary = RevalidationRunner(
        database,
        validator_factories=(lambda: invalid, lambda: other),
        max_attempts=2,
    ).run()
    assert summary["retranslate"] == 0
    assert summary["warnings"] == 1
    assert summary["protocol_failures"] == 1
    with closing(database.connect()) as connection:
        task = connection.execute("SELECT status, action FROM revalidation_tasks").fetchone()
        assert tuple(task) == ("completed_with_warning", "warning_fallback")
        assert connection.execute(
            "SELECT validation_status FROM translation_versions WHERE active=1"
        ).fetchone()[0] == "warning_stale"
        assert connection.execute("SELECT COUNT(*) FROM human_queue").fetchone()[0] == 0


def test_task11_full_block_repair_validates_structure_and_target_hits(tmp_path):
    database = _database(tmp_path, ["Alpha\n\nBeta"])
    block = database.get_block_by_identifier("block-0")
    bad = _Task11LLM(
        [json.dumps({"paragraphs": ["只有一段"], "repair_notes": []})]
    )
    failed = V4Repairer(database, lambda: bad, max_attempts=1).repair_full_block(
        block,
        "旧译名在这里\n\n第二段旧译文",
        {"required_targets": ["新译名"]},
        issues=["replace stale target"],
        knowledge_version=database.current_knowledge_version(),
    )
    assert failed.status == "failed_retryable"
    good = _Task11LLM(
        [
            json.dumps(
                {
                    "paragraphs": ["新译名在这里", "第二段完整译文"],
                    "repair_notes": ["updated target"],
                }
            )
        ]
    )
    repaired = V4Repairer(database, lambda: good, max_attempts=1).repair_full_block(
        block,
        "旧译名在这里\n\n第二段旧译文",
        {"required_targets": ["新译名"]},
        issues=["replace stale target"],
        knowledge_version=database.current_knowledge_version(),
    )
    assert repaired.status == "completed"
    assert repaired.final_translation == "新译名在这里\n\n第二段完整译文"
    assert repaired.audit_calls[-1]["accepted"] is True


def test_task11_patch_commit_preserves_precise_dependencies(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    old_translation = _task11_task(database, impact=1)
    validator = _Task11LLM([_task11_response("patch_required")])
    repair = _Task11LLM(
        [json.dumps({"paragraphs": ["新译名完整译文"], "repair_notes": []})]
    )
    summary = RevalidationRunner(
        database,
        validator_factories=(lambda: validator,),
        repairer=V4Repairer(database, lambda: repair, max_attempts=1),
        max_attempts=1,
    ).run()
    assert summary["patched"] == 1
    with closing(database.connect()) as connection:
        versions = connection.execute(
            "SELECT id, active FROM translation_versions ORDER BY id"
        ).fetchall()
        assert [(row["id"], row["active"]) for row in versions] == [
            (old_translation, 0),
            (versions[1]["id"], 1),
        ]
        dependency = connection.execute(
            "SELECT * FROM dependencies WHERE translation_id=?",
            (versions[1]["id"],),
        ).fetchone()
        assert dependency["dependency_fingerprint"] == "new-fingerprint"
        assert dependency["rendered_target"] == "新译名"
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
        assert task["status"] == "resolved_patch"
        assert task["replacement_translation_id"] == versions[1]["id"]


def test_task11_lease_cas_expiry_and_completed_rerun(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    _task11_task(database, impact=1)
    claim = database.claim_revalidation_task("worker-a", lease_seconds=60)
    assert claim is not None
    assert database.claim_revalidation_task("worker-b", lease_seconds=60) is None
    with database.transaction() as connection:
        row = connection.execute("SELECT result_json FROM revalidation_tasks").fetchone()
        result = json.loads(row["result_json"])
        result["_lease"]["expires_at"] = "2000-01-01T00:00:00+00:00"
        connection.execute(
            "UPDATE revalidation_tasks SET result_json=?",
            (json.dumps(result, sort_keys=True, separators=(",", ":")),),
        )
    assert database.requeue_expired_revalidation_tasks() == 1
    replacement = database.claim_revalidation_task("worker-b", lease_seconds=60)
    assert replacement is not None
    assert replacement.lease_token != claim.lease_token
    with pytest.raises(ValueError, match="lease"):
        database.commit_revalidation_resolution(
            claim,
            status="resolved_noop",
            action="no_effect",
            result={"reason": "old lease"},
        )
    database.commit_revalidation_resolution(
        replacement,
        status="resolved_noop",
        action="no_effect",
        result={"reason": "fresh lease"},
    )
    model = _Task11LLM([_task11_response("no_effect")])
    summary = RevalidationRunner(
        database, validator_factories=(lambda: model,), max_attempts=1
    ).run()
    assert summary["claimed"] == 0
    assert model.requests == []


def test_task11_claim_retires_inactive_translation_superseded_by_active_version(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    old_translation = _task11_task(database, impact=1)
    with database.transaction() as connection:
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
        connection.execute(
            "UPDATE translation_versions SET active=0 WHERE id=?",
            (old_translation,),
        )
        replacement = int(
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, status,
                       draft_translation, final_translation, active, created_at)
                   VALUES('block-0', 'parallel_v4', ?, 'completed',
                          'replacement', 'replacement', 1, 'now')""",
                (task["to_knowledge_version"],),
            ).lastrowid
        )

    assert database.claim_revalidation_task("worker-a") is None
    assert database.claim_revalidation_task("worker-b") is None
    with closing(database.connect()) as connection:
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
    assert task["status"] == "resolved_noop"
    assert task["action"] == "superseded_by_active_translation"
    assert task["replacement_translation_id"] == replacement
    result = json.loads(task["result_json"])
    assert result["replacement_translation_id"] == replacement
    assert result["replacement_knowledge_version"] == task["to_knowledge_version"]
    assert "_lease" not in result


def test_task11_patch_rejects_claimed_translation_knowledge_version_drift(tmp_path):
    database = _database(tmp_path, ["Alpha"])
    old_translation = _task11_task(database, impact=1)
    claim = database.claim_revalidation_task("worker-a")
    assert claim is not None
    block = database.get_block_by_identifier("block-0")
    outcome = TranslationOutcome(
        block=block,
        knowledge_version=int(claim.task_snapshot["to_knowledge_version"]),
        status="completed",
        draft_translation="新译名完整译文",
        final_translation="新译名完整译文",
    )
    with database.transaction() as connection:
        connection.execute(
            "UPDATE translation_versions SET knowledge_version=? WHERE id=?",
            (claim.task_snapshot["to_knowledge_version"], old_translation),
        )

    with pytest.raises(ValueError, match="knowledge|snapshot|stale"):
        database.commit_revalidation_resolution(
            claim,
            status="resolved_patch",
            action="patch_required",
            result={"reason": "should not commit"},
            outcome=outcome,
        )
    with closing(database.connect()) as connection:
        versions = connection.execute(
            "SELECT id, active FROM translation_versions ORDER BY id"
        ).fetchall()
        task = connection.execute("SELECT * FROM revalidation_tasks").fetchone()
    assert [(row["id"], row["active"]) for row in versions] == [
        (old_translation, 1)
    ]
    assert task["status"] == "resolved_noop"
    assert task["action"] == "stale_translation"
    assert task["replacement_translation_id"] is None
    assert database.claim_revalidation_task("worker-b") is None
