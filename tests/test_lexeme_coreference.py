from contextlib import closing
from dataclasses import FrozenInstanceError, replace
import json
import sqlite3

import pytest

from src.core.v4 import models as v4_models
from src.core.v4 import coreference as coreference_module
from src.core.v4.coreference import CoreferenceCoordinator, CoreferenceProtocolError
from src.core.v4.database import (
    ConceptMergeConflictError,
    V4Database,
    normalize_english_form,
    stable_id,
)


def _db(tmp_path, source_text="Briah met BRIAH.", source_hash="hash-1"):
    root = tmp_path / "book"
    root.mkdir()
    database = V4Database(root)
    edition = database.ensure_source_edition(
        "raw-1", "normalized-1", "test", "source.txt"
    )
    database.upsert_blocks(
        edition,
        [
            {
                "id": "block-1",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": source_text,
                "source_hash": source_hash,
                "token_count": len(source_text.split()),
                "status": "ready",
            }
        ],
    )
    return database


def _require_method(database, name):
    method = getattr(database, name, None)
    assert method is not None, f"V4Database.{name} public API is missing"
    return method


def _occurrence(**values):
    model = getattr(v4_models, "FormOccurrence", None)
    assert model is not None, "FormOccurrence public model is missing"
    return model(**values)


def test_lexeme_persistence_models_are_immutable_public_contracts():
    model_values = {
        "LexemeRef": {
            "id": "lexeme-1",
            "language": "en",
            "normalized_form": "briah",
            "canonical_form": "Briah",
        },
        "TypeObservation": {
            "lexeme_id": "lexeme-1",
            "kind": "place",
            "confidence": 0.8,
            "source": "scanner",
        },
        "FormOccurrence": {
            "lexeme_id": "lexeme-1",
            "block_id": "block-1",
            "start_offset": 0,
            "end_offset": 5,
            "source_form": "Briah",
            "source_hash": "hash-1",
        },
    }

    for name, values in model_values.items():
        model = getattr(v4_models, name, None)
        assert model is not None, f"{name} public model is missing"
        instance = model(**values)
        with pytest.raises(FrozenInstanceError):
            setattr(instance, next(iter(values)), "changed")


def test_ensure_lexeme_reuses_stable_id_and_preserves_exact_surface_forms(tmp_path):
    database = _db(tmp_path)
    ensure_lexeme = _require_method(database, "ensure_lexeme")

    first = ensure_lexeme("Briah", language="en")
    repeated = ensure_lexeme("Briah", language="en")
    recased = ensure_lexeme("BRIAH", language="en")
    recased_repeated = ensure_lexeme("BRIAH", language="en")

    expected = stable_id("lexeme", f"en:{normalize_english_form('Briah')}")
    assert first == repeated == recased == recased_repeated == expected
    with closing(database.connect()) as connection:
        lexemes = connection.execute(
            """SELECT id, canonical_form, default_target, working_target,
                      verified_target, status, locked
               FROM lexemes
               WHERE language='en' AND normalized_form='briah'
                     AND retired_version IS NULL"""
        ).fetchall()
        forms = connection.execute(
            """SELECT lexeme_id, form, normalized_form
               FROM source_forms WHERE lexeme_id=? ORDER BY form""",
            (first,),
        ).fetchall()
        concept_count = connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]

    assert len(lexemes) == 1
    assert dict(lexemes[0]) == {
        "id": expected,
        "canonical_form": "Briah",
        "default_target": "",
        "working_target": "",
        "verified_target": "",
        "status": "provisional",
        "locked": 0,
    }
    assert [tuple(row) for row in forms] == [
        (expected, "BRIAH", "briah"),
        (expected, "Briah", "briah"),
    ]
    assert concept_count == 0


def test_ensure_lexeme_rejects_empty_language_and_normalized_form(tmp_path):
    database = _db(tmp_path)
    ensure_lexeme = _require_method(database, "ensure_lexeme")

    with pytest.raises(ValueError):
        ensure_lexeme("Briah", language="")
    with pytest.raises(ValueError):
        ensure_lexeme("   ", language="en")


def test_type_observations_coexist_without_creating_or_splitting_concepts(tmp_path):
    database = _db(tmp_path)
    ensure_lexeme = _require_method(database, "ensure_lexeme")
    record = _require_method(database, "record_type_observation")
    lexeme_id = ensure_lexeme("Briah")

    place_id = record(
        lexeme_id,
        "place",
        confidence=0.8,
        source="scanner",
    )
    repeated_place_id = record(
        lexeme_id,
        "place",
        confidence=0.8,
        source="scanner",
    )
    concept_observation_id = record(
        lexeme_id,
        "concept",
        confidence=0.6,
        source="heuristic",
    )

    with closing(database.connect()) as connection:
        observations = connection.execute(
            """SELECT id, lexeme_id, concept_id, kind, confidence, source
               FROM concept_type_observations
               WHERE lexeme_id=? ORDER BY id""",
            (lexeme_id,),
        ).fetchall()
        concept_count = connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]

    assert place_id == repeated_place_id
    assert concept_observation_id != place_id
    assert [tuple(row) for row in observations] == [
        (place_id, lexeme_id, None, "place", 0.8, "scanner"),
        (concept_observation_id, lexeme_id, None, "concept", 0.6, "heuristic"),
    ]
    assert concept_count == 0


def test_retired_type_observation_does_not_satisfy_idempotent_replay(tmp_path):
    database = _db(tmp_path)
    lexeme_id = database.ensure_lexeme("Briah")
    first_id = database.record_type_observation(
        lexeme_id,
        "place",
        confidence=0.8,
        source="scanner",
    )
    with database.transaction() as connection:
        retired_version = database.create_knowledge_version(
            "retire type observation",
            connection,
        )
        connection.execute(
            """UPDATE concept_type_observations SET retired_version=?
               WHERE id=?""",
            (retired_version, first_id),
        )

    replay_id = database.record_type_observation(
        lexeme_id,
        "place",
        confidence=0.8,
        source="scanner",
    )

    assert replay_id != first_id
    with closing(database.connect()) as connection:
        observations = connection.execute(
            """SELECT id, retired_version FROM concept_type_observations
               WHERE lexeme_id=? ORDER BY id""",
            (lexeme_id,),
        ).fetchall()
    assert [tuple(row) for row in observations] == [
        (first_id, retired_version),
        (replay_id, None),
    ]


@pytest.mark.parametrize(
    ("kind", "confidence", "source"),
    [
        ("", 0.5, "scanner"),
        ("place", -0.01, "scanner"),
        ("place", 1.01, "scanner"),
        ("place", 0.5, ""),
    ],
)
def test_type_observation_validates_kind_confidence_and_source(
    tmp_path, kind, confidence, source
):
    database = _db(tmp_path)
    ensure_lexeme = _require_method(database, "ensure_lexeme")
    record = _require_method(database, "record_type_observation")
    lexeme_id = ensure_lexeme("Briah")

    with pytest.raises(ValueError):
        record(
            lexeme_id,
            kind,
            confidence=confidence,
            source=source,
        )


def test_occurrence_batch_prevalidation_rolls_back_all_rows_on_bad_offset(tmp_path):
    database = _db(tmp_path)
    lexeme_id = _require_method(database, "ensure_lexeme")("Briah")
    record = _require_method(database, "record_form_occurrences")
    valid = _occurrence(
        lexeme_id=lexeme_id,
        block_id="block-1",
        start_offset=0,
        end_offset=5,
        source_form="Briah",
        source_hash="hash-1",
    )
    bad_offset = _occurrence(
        lexeme_id=lexeme_id,
        block_id="block-1",
        start_offset=9,
        end_offset=14,
        source_form="BRIAH",
        source_hash="hash-1",
    )

    with pytest.raises(ValueError):
        record([valid, bad_offset])

    with closing(database.connect()) as connection:
        count = connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0]
    assert count == 0


def test_occurrence_rejects_missing_inactive_or_source_hash_mismatched_block(tmp_path):
    database = _db(tmp_path)
    lexeme_id = _require_method(database, "ensure_lexeme")("Briah")
    record = _require_method(database, "record_form_occurrences")

    def row(block_id="block-1", source_hash="hash-1"):
        return _occurrence(
            lexeme_id=lexeme_id,
            block_id=block_id,
            start_offset=0,
            end_offset=5,
            source_form="Briah",
            source_hash=source_hash,
        )

    with pytest.raises((KeyError, ValueError)):
        record([row(block_id="missing")])
    with pytest.raises(ValueError):
        record([row(source_hash="stale-hash")])

    database.ensure_source_edition(
        "raw-2", "normalized-2", "test", "replacement.txt"
    )
    with pytest.raises(ValueError):
        record([row()])

    with closing(database.connect()) as connection:
        count = connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0]
    assert count == 0


def test_identical_occurrence_replay_is_idempotent(tmp_path):
    database = _db(tmp_path)
    lexeme_id = _require_method(database, "ensure_lexeme")("Briah")
    record = _require_method(database, "record_form_occurrences")
    occurrence = _occurrence(
        lexeme_id=lexeme_id,
        block_id="block-1",
        start_offset=0,
        end_offset=5,
        source_form="Briah",
        source_hash="hash-1",
    )

    assert record([occurrence]) == 1
    assert record([occurrence]) == 0

    with closing(database.connect()) as connection:
        rows = connection.execute(
            """SELECT lexeme_id, block_id, start_offset, end_offset,
                      source_form, source_hash
               FROM form_occurrences"""
        ).fetchall()
    assert [tuple(row) for row in rows] == [
        (lexeme_id, "block-1", 0, 5, "Briah", "hash-1")
    ]


def test_occurrence_batch_failure_is_atomic_inside_caught_outer_transaction(tmp_path):
    database = _db(tmp_path)
    lexeme_id = database.ensure_lexeme("Briah")
    valid = _occurrence(
        lexeme_id=lexeme_id,
        block_id="block-1",
        start_offset=0,
        end_offset=5,
        source_form="Briah",
        source_hash="hash-1",
    )
    missing_lexeme = _occurrence(
        lexeme_id="lexeme_missing",
        block_id="block-1",
        start_offset=10,
        end_offset=15,
        source_form="BRIAH",
        source_hash="hash-1",
    )

    with database.transaction() as connection:
        preserved_before = database.ensure_lexeme(
            "Preserved Before",
            connection=connection,
        )
        with pytest.raises(KeyError):
            database.record_form_occurrences(
                [valid, missing_lexeme],
                connection=connection,
            )
        preserved_after = database.ensure_lexeme(
            "Preserved After",
            connection=connection,
        )

    with closing(database.connect()) as connection:
        count = connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0]
        preserved_ids = {
            str(row[0])
            for row in connection.execute(
                "SELECT id FROM lexemes WHERE id IN (?, ?)",
                (preserved_before, preserved_after),
            )
        }
    assert count == 0
    assert preserved_ids == {preserved_before, preserved_after}


@pytest.mark.parametrize("invalid_lexeme_id", [None, ""])
def test_occurrence_batch_rejects_empty_lexeme_without_partial_writes(
    tmp_path, invalid_lexeme_id
):
    database = _db(tmp_path)
    lexeme_id = database.ensure_lexeme("Briah")
    valid = _occurrence(
        lexeme_id=lexeme_id,
        block_id="block-1",
        start_offset=0,
        end_offset=5,
        source_form="Briah",
        source_hash="hash-1",
    )
    invalid = _occurrence(
        lexeme_id=invalid_lexeme_id,
        block_id="block-1",
        start_offset=10,
        end_offset=15,
        source_form="BRIAH",
        source_hash="hash-1",
    )

    with database.transaction() as connection:
        with pytest.raises(ValueError):
            database.record_form_occurrences(
                [valid, invalid],
                connection=connection,
            )

    with closing(database.connect()) as connection:
        count = connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0]
    assert count == 0


@pytest.mark.parametrize(
    "api_name",
    ["ensure_lexeme", "record_type_observation", "record_form_occurrences"],
)
def test_persistence_api_rejects_external_connection_without_active_transaction(
    tmp_path, api_name
):
    database = _db(tmp_path)
    lexeme_id = database.ensure_lexeme("Briah")

    def counts():
        with closing(database.connect()) as inspection:
            return tuple(
                inspection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in (
                    "lexemes",
                    "source_forms",
                    "concept_type_observations",
                    "form_occurrences",
                )
            )

    before = counts()
    connection = database.connect()
    assert not connection.in_transaction
    try:
        with pytest.raises(ValueError, match=r"(?i)active transaction|transaction"):
            if api_name == "ensure_lexeme":
                database.ensure_lexeme("Raw Connection", connection=connection)
            elif api_name == "record_type_observation":
                database.record_type_observation(
                    lexeme_id,
                    "place",
                    confidence=0.8,
                    source="scanner",
                    connection=connection,
                )
            else:
                database.record_form_occurrences(
                    [
                        _occurrence(
                            lexeme_id=lexeme_id,
                            block_id="block-1",
                            start_offset=0,
                            end_offset=5,
                            source_form="Briah",
                            source_hash="hash-1",
                        )
                    ],
                    connection=connection,
                )
        assert not connection.in_transaction
        connection.rollback()
    finally:
        connection.close()

    assert counts() == before


def test_persistence_apis_join_the_callers_transaction(tmp_path):
    database = _db(tmp_path)
    ensure_lexeme = _require_method(database, "ensure_lexeme")
    record_type = _require_method(database, "record_type_observation")
    record_occurrences = _require_method(database, "record_form_occurrences")

    with pytest.raises(RuntimeError):
        with database.transaction() as connection:
            lexeme_id = ensure_lexeme("Briah", connection=connection)
            record_type(
                lexeme_id,
                "place",
                confidence=0.8,
                source="scanner",
                connection=connection,
            )
            record_occurrences(
                [
                    _occurrence(
                        lexeme_id=lexeme_id,
                        block_id="block-1",
                        start_offset=0,
                        end_offset=5,
                        source_form="Briah",
                        source_hash="hash-1",
                    )
                ],
                connection=connection,
            )
            raise RuntimeError("force caller rollback")

    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM source_forms").fetchone()[0] == 0
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM concept_type_observations"
            ).fetchone()[0]
            == 0
        )
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] == 0


def _insert_coreference_mention(
    database,
    lexeme_id,
    *,
    paragraph_id,
    evidence_quote,
    kind=None,
    source_form="Briah",
    block_id="block-1",
):
    with database.transaction() as connection:
        cursor = connection.execute(
            """INSERT INTO evidence(
                   block_id, paragraph_id, kind, source_form, evidence_quote,
                   payload_json, confidence, extractor, created_at)
               VALUES(?, ?, 'scan', ?, ?, '{}', 0.9,
                      'test', '2000-01-01T00:00:00+00:00')""",
            (block_id, paragraph_id, source_form, evidence_quote),
        )
        evidence_id = int(cursor.lastrowid)
        cursor = connection.execute(
            """INSERT INTO mentions(
                   block_id, paragraph_id, source_form, normalized_form,
                   discourse_function, lexeme_id, evidence_id)
               VALUES(?, ?, ?, ?, 'referential', ?, ?)""",
            (
                block_id,
                paragraph_id,
                source_form,
                normalize_english_form(source_form),
                lexeme_id,
                evidence_id,
            ),
        )
        mention_id = int(cursor.lastrowid)
        if kind is not None:
            database.record_type_observation(
                lexeme_id,
                kind,
                confidence=0.9,
                source="test",
                mention_id=mention_id,
                evidence_id=evidence_id,
                connection=connection,
            )
    return mention_id, evidence_id


def _coreference_case(tmp_path, *, count=2, long_context=False):
    database = _db(tmp_path, source_text="Briah.\n\nBriah again.")
    lexeme_id = database.ensure_lexeme("Briah")
    mention_ids = []
    evidence_ids = []
    for index in range(count):
        quote = (
            (f"context-{index}-" + ("x" * 2_000))
            if long_context
            else f"Briah context {index}"
        )
        mention_id, evidence_id = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=f"P{index + 1:03d}",
            evidence_quote=quote,
            kind="person" if index % 2 == 0 else "place",
        )
        mention_ids.append(mention_id)
        evidence_ids.append(evidence_id)
    cases = CoreferenceCoordinator(database).freeze_cases()
    assert len(cases) == 1
    return database, lexeme_id, tuple(mention_ids), tuple(evidence_ids), cases[0]


@pytest.mark.parametrize(
    "relation", ["same", "different", "uncertain", "non_entity"]
)
def test_coreference_protocol_accepts_only_the_four_relations(tmp_path, relation):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)
    aliases = [mention.request_id for mention in case.mentions]

    response = coordinator.parse_response(
        {
            "votes": [
                {
                    "case_id": case.case_id,
                    "relation": relation,
                    "mention_ids": aliases,
                    "confidence": 0.8,
                    "rationale": "bounded rationale",
                }
            ]
        },
        [case],
    )

    assert response.votes[0].relation == relation


@pytest.mark.parametrize(
    "mutate",
    [
        lambda vote: vote.update(case_id="R999"),
        lambda vote: vote.pop("mention_ids"),
        lambda vote: vote.update(mention_ids=[]),
        lambda vote: vote.update(mention_ids=["M999"]),
        lambda vote: vote.update(mention_ids=["M001", "M001"]),
        lambda vote: vote.update(unexpected=True),
        lambda vote: vote.update(relation="maybe"),
    ],
)
def test_coreference_protocol_rejects_unknown_omitted_or_extra_values(
    tmp_path, mutate
):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)
    vote = {
        "case_id": case.case_id,
        "relation": "same",
        "mention_ids": [mention.request_id for mention in case.mentions],
        "confidence": 0.8,
        "rationale": "bounded rationale",
    }
    mutate(vote)

    with pytest.raises(CoreferenceProtocolError):
        coordinator.parse_response({"votes": [vote]}, [case])


def test_coreference_protocol_revalidates_an_existing_response_instance(tmp_path):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)
    response = v4_models.CoreferenceResponse.model_validate(
        {
            "votes": [
                {
                    "case_id": case.case_id,
                    "relation": "same",
                    "mention_ids": [
                        mention.request_id for mention in case.mentions
                    ],
                    "confidence": 0.8,
                    "rationale": "bounded rationale",
                }
            ]
        }
    )
    response.votes[0].relation = "maybe"

    with pytest.raises(CoreferenceProtocolError):
        coordinator.parse_response(response, [case])


def test_coreference_protocol_revalidates_nested_vote_instances(tmp_path):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)
    vote = v4_models.CoreferenceVote.model_validate(
        {
            "case_id": case.case_id,
            "relation": "same",
            "mention_ids": [mention.request_id for mention in case.mentions],
            "confidence": 0.8,
            "rationale": "bounded rationale",
        }
    )
    object.__setattr__(vote, "relation", "maybe")

    with pytest.raises(CoreferenceProtocolError):
        coordinator.parse_response({"votes": [vote]}, [case])


def test_frozen_coreference_payload_is_identical_for_both_models_and_runtime_free(
    tmp_path,
):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)

    left = coordinator.payload_bytes(case)
    right = coordinator.payload_bytes(case)
    payload = json.loads(left)

    assert left == right
    assert coordinator.model_payloads(case, ["model-b", "model-a"]) == (left, left)
    assert "run_id" not in left.decode("utf-8")
    assert "created_at" not in left.decode("utf-8")
    assert "timestamp" not in left.decode("utf-8")
    assert payload["protocol_version"] == coreference_module.COREFERENCE_PROTOCOL_VERSION


def test_coreference_high_frequency_selection_is_bounded_and_stable(tmp_path):
    database, _, real_ids, _, first_case = _coreference_case(tmp_path, count=12)
    coordinator = CoreferenceCoordinator(database)

    second_case = coordinator.freeze_cases()[0]
    selected_ids = [mention.mention_id for mention in first_case.mentions]

    assert first_case == second_case
    assert len(selected_ids) == 8
    assert real_ids[0] in selected_ids
    assert real_ids[-1] in selected_ids
    assert len(set(selected_ids)) == len(selected_ids)
    payload = json.loads(coordinator.payload_bytes(first_case))["case"]
    assert {
        item["mention_id"]
        for item in payload["type_observations"]
        if item["mention_id"] is not None
    } <= set(selected_ids)


def test_coreference_max_cases_only_materializes_selected_lexeme_details(
    tmp_path, monkeypatch
):
    database = _db(tmp_path)
    alpha_id = database.ensure_lexeme("Alpha")
    zulu_id = database.ensure_lexeme("Zulu")
    for lexeme_id, source_form in ((alpha_id, "Alpha"), (zulu_id, "Zulu")):
        for index in range(2):
            _insert_coreference_mention(
                database,
                lexeme_id,
                paragraph_id=f"P{index + 1:03d}",
                evidence_quote=f"{source_form} context {index}",
                kind="person",
                source_form=source_form,
            )

    statements = []
    real_connect = database.connect

    def traced_connect():
        connection = real_connect()
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(database, "connect", traced_connect)
    cases = CoreferenceCoordinator(database).freeze_cases(max_cases=1)

    assert [case.lexeme_id for case in cases] == [alpha_id]
    detail_queries = [
        statement
        for statement in statements
        if "SELECT m.id AS mention_id" in statement
    ]
    assert len(detail_queries) == 1
    assert alpha_id in detail_queries[0]
    assert zulu_id not in detail_queries[0]
    assert all(
        zulu_id not in statement
        for statement in statements
        if "SELECT o.id AS observation_id" in statement
        or "SELECT cl.lexeme_id" in statement
        or "SELECT DISTINCT m.lexeme_id" in statement
    )


def test_coreference_zero_max_cases_skips_snapshot_detail_queries(
    tmp_path, monkeypatch
):
    database = _db(tmp_path)
    connect_calls = 0
    real_connect = database.connect

    def counted_connect():
        nonlocal connect_calls
        connect_calls += 1
        return real_connect()

    monkeypatch.setattr(database, "connect", counted_connect)

    assert CoreferenceCoordinator(database).freeze_cases(max_cases=0) == ()
    assert connect_calls == 0


def test_frozen_payload_keeps_real_ids_hashes_types_anchors_and_bounded_context(
    tmp_path,
):
    database, lexeme_id, mention_ids, evidence_ids, case = _coreference_case(
        tmp_path, long_context=True
    )
    coordinator = CoreferenceCoordinator(database)
    payload = json.loads(coordinator.payload_bytes(case))["case"]

    assert payload["knowledge_version"] == database.current_knowledge_version()
    assert payload["lexeme"]["id"] == lexeme_id
    assert payload["mention_set_id"] == stable_id(
        "mention-set", ":".join(sorted(str(value) for value in mention_ids))
    )
    assert [item["mention_id"] for item in payload["mentions"]] == list(mention_ids)
    assert [item["evidence_id"] for item in payload["mentions"]] == list(evidence_ids)
    assert all(item["block_id"] == "block-1" for item in payload["mentions"])
    assert all(item["source_hash"] == "hash-1" for item in payload["mentions"])
    assert all(item["request_id"].startswith("M") for item in payload["mentions"])
    all_kinds = {
        item["kind"]
        for item in payload["type_observations"]
    } | {
        item["kind"]
        for mention in payload["mentions"]
        for item in mention["type_observations"]
    }
    assert all_kinds == {
        "person",
        "place",
    }
    assert sum(len(item["context"]) for item in payload["mentions"]) <= 3_200
    assert all(len(item["context"]) <= 400 for item in payload["mentions"])


def test_coreference_payload_has_a_fixed_budget_for_large_metadata(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(
        tmp_path, count=8
    )
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        for index in range(20):
            suffix = f"{index:03d}"
            for mention_id, evidence_id in zip(mention_ids, evidence_ids):
                database.record_type_observation(
                    lexeme_id,
                    f"kind-{suffix}-" + ("🧪" * 5_000),
                    confidence=0.6,
                    source=f"mention-source-{suffix}-" + ("🧪" * 5_000),
                    mention_id=mention_id,
                    evidence_id=evidence_id,
                    connection=connection,
                )
            database.record_type_observation(
                lexeme_id,
                f"lexeme-kind-{suffix}-" + ("🧪" * 5_000),
                confidence=0.5,
                source=f"lexeme-source-{suffix}-" + ("🧪" * 5_000),
                connection=connection,
            )
            concept_id = f"concept-budget-{suffix}"
            connection.execute(
                """INSERT INTO concepts(
                       id, kind, canonical_source, primary_lexeme_id,
                       created_version, created_at)
                   VALUES(?, ?, ?, ?, ?, '2000-01-01T00:00:00+00:00')""",
                (
                    concept_id,
                    f"anchor-kind-{suffix}-" + ("🧪" * 5_000),
                    f"anchor-source-{suffix}-" + ("🧪" * 5_000),
                    lexeme_id,
                    version,
                ),
            )
            connection.execute(
                """INSERT INTO concept_lexemes(
                       concept_id, lexeme_id, role, confidence, status,
                       created_version, created_at)
                   VALUES(?, ?, 'primary', 1.0, 'provisional', ?,
                          '2000-01-01T00:00:00+00:00')""",
                (concept_id, lexeme_id, version),
            )

    coordinator = CoreferenceCoordinator(database)
    first_case = coordinator.freeze_cases()[0]
    second_case = coordinator.freeze_cases()[0]
    frozen = coordinator.payload_bytes(first_case)
    payload = json.loads(frozen)["case"]

    assert first_case == second_case
    assert len(frozen) <= coreference_module.MAX_CASE_PAYLOAD_BYTES
    assert len(payload["type_observations"]) <= (
        coreference_module.MAX_LEXEME_TYPE_OBSERVATIONS
    )
    assert all(
        len(mention["type_observations"])
        <= coreference_module.MAX_MENTION_TYPE_OBSERVATIONS
        for mention in payload["mentions"]
    )
    assert len(payload["concept_anchors"]) <= (
        coreference_module.MAX_CONCEPT_ANCHORS
    )
    assert all(
        len(item["source"])
        <= coreference_module.MAX_OBSERVATION_SOURCE_CHARS
        for item in payload["type_observations"]
    )
    assert all(
        len(item["source"])
        <= coreference_module.MAX_OBSERVATION_SOURCE_CHARS
        for mention in payload["mentions"]
        for item in mention["type_observations"]
    )
    assert all(
        len(item["canonical_source"])
        <= coreference_module.MAX_FREE_TEXT_CHARS
        for item in payload["concept_anchors"]
    )
    assert [item["mention_id"] for item in payload["mentions"]] == list(
        mention_ids
    )
    nested_kinds = {
        item["kind"]
        for mention in payload["mentions"]
        for item in mention["type_observations"]
    }
    assert {"person", "place"} <= nested_kinds
    assert any(kind.startswith("kind-019-") for kind in nested_kinds)


def test_coreference_payload_budget_accepts_worst_case_multibyte_text(tmp_path):
    _, _, _, _, case = _coreference_case(tmp_path, count=8)
    marker = "🧪" * 5_000
    observation_id = 10_000
    mentions = []
    for mention in case.mentions:
        observations = []
        for _ in range(coreference_module.MAX_MENTION_TYPE_OBSERVATIONS):
            observation_id += 1
            observations.append(
                v4_models.CoreferenceTypeObservation(
                    observation_id=observation_id,
                    kind=marker,
                    confidence=0.5,
                    source=marker,
                    mention_id=mention.mention_id,
                    evidence_id=mention.evidence_id,
                )
            )
        mentions.append(
            replace(
                mention,
                block_kind=marker,
                source_form=marker,
                discourse_function=marker,
                context=marker,
                context_source=marker,
                type_observations=tuple(observations),
            )
        )
    lexeme_observations = tuple(
        v4_models.CoreferenceTypeObservation(
            observation_id=20_000 + index,
            kind=marker,
            confidence=0.5,
            source=marker,
        )
        for index in range(coreference_module.MAX_LEXEME_TYPE_OBSERVATIONS)
    )
    anchors = tuple(
        v4_models.CoreferenceConceptAnchor(
            concept_id=f"concept-multibyte-{index}",
            kind=marker,
            canonical_source=marker,
            status=marker,
            role="primary",
        )
        for index in range(coreference_module.MAX_CONCEPT_ANCHORS)
    )
    worst_case = replace(
        case,
        language=marker,
        normalized_form=marker,
        canonical_form=marker,
        mentions=tuple(mentions),
        type_observations=lexeme_observations,
        concept_anchors=anchors,
    )

    frozen = CoreferenceCoordinator.payload_bytes(worst_case)

    assert len(frozen) <= coreference_module.MAX_CASE_PAYLOAD_BYTES


def test_coreference_payload_carries_each_existing_concept_anchor_once(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, primary_lexeme_id,
                   anchor_mention_id, created_version, created_at)
               VALUES('concept-briah', 'person', 'Briah', ?, ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, mention_ids[0], version),
        )
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, created_at)
               VALUES('concept-briah', ?, 'primary', 1.0, 'provisional', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, version),
        )
        connection.execute(
            "UPDATE mentions SET concept_id='concept-briah' WHERE id=?",
            (mention_ids[0],),
        )

    case = CoreferenceCoordinator(database).freeze_cases()[0]
    payload = json.loads(CoreferenceCoordinator.payload_bytes(case))["case"]

    assert [item["concept_id"] for item in payload["concept_anchors"]] == [
        "concept-briah"
    ]
    assert payload["concept_anchors"][0]["role"] == "primary"
    assert payload["mentions"][0]["concept_anchor_ids"] == ["concept-briah"]


def test_coreference_anchor_budget_prioritizes_selected_mention_binding(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        for index in range(coreference_module.MAX_CONCEPT_ANCHORS):
            concept_id = f"concept-a-{index:03d}"
            connection.execute(
                """INSERT INTO concepts(
                       id, kind, canonical_source, primary_lexeme_id,
                       anchor_mention_id, created_version, created_at)
                   VALUES(?, 'person', ?, ?, ?, ?,
                          '2000-01-01T00:00:00+00:00')""",
                (concept_id, concept_id, lexeme_id, mention_ids[1], version),
            )
            connection.execute(
                """INSERT INTO concept_lexemes(
                       concept_id, lexeme_id, role, confidence, status,
                       created_version, created_at)
                   VALUES(?, ?, 'primary', 1.0, 'provisional', ?,
                          '2000-01-01T00:00:00+00:00')""",
                (concept_id, lexeme_id, version),
            )
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, primary_lexeme_id,
                   created_version, created_at)
               VALUES('concept-z-direct', 'person', 'direct', ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, version),
        )
        connection.execute(
            "UPDATE mentions SET concept_id='concept-z-direct' WHERE id=?",
            (mention_ids[0],),
        )

    case = CoreferenceCoordinator(database).freeze_cases()[0]
    payload = json.loads(CoreferenceCoordinator.payload_bytes(case))["case"]

    anchors_by_id = {
        item["concept_id"]: item for item in payload["concept_anchors"]
    }
    assert anchors_by_id["concept-z-direct"]["role"] == "mention"
    assert payload["mentions"][0]["concept_anchor_ids"] == [
        "concept-z-direct"
    ]


def test_coreference_payload_does_not_emit_dangling_retired_anchor_ids(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    with database.transaction() as connection:
        created_version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, primary_lexeme_id,
                   anchor_mention_id, created_version, created_at)
               VALUES('retired-briah', 'person', 'Briah', ?, ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, mention_ids[0], created_version),
        )
        connection.execute(
            "UPDATE mentions SET concept_id='retired-briah' WHERE id=?",
            (mention_ids[0],),
        )
        retired_version = database.create_knowledge_version(
            "retire test concept", connection
        )
        connection.execute(
            "UPDATE concepts SET retired_version=? WHERE id='retired-briah'",
            (retired_version,),
        )

    case = CoreferenceCoordinator(database).freeze_cases()[0]
    payload = json.loads(CoreferenceCoordinator.payload_bytes(case))["case"]

    assert payload["concept_anchors"] == []
    assert payload["mentions"][0]["concept_anchor_ids"] == []


def _set_evidence_payload(database, evidence_ids, payload):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    with database.transaction() as connection:
        for evidence_id in evidence_ids:
            connection.execute(
                "UPDATE evidence SET payload_json=? WHERE id=?",
                (encoded, evidence_id),
            )


def _insert_test_concept(
    database,
    lexeme_id,
    concept_id,
    *,
    anchor_mention_id=None,
    kind="person",
    locked=False,
    status="provisional",
    retired=False,
):
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        retired_version = None
        if retired:
            retired_version = database.create_knowledge_version(
                f"retire {concept_id}", connection
            )
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, status, locked,
                   primary_lexeme_id, anchor_mention_id, created_version,
                   retired_version, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                concept_id,
                kind,
                concept_id,
                status,
                int(locked),
                lexeme_id,
                anchor_mention_id,
                version,
                retired_version,
            ),
        )
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status,
                   created_version, retired_version, created_at)
               VALUES(?, ?, 'primary', 1.0, ?, ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (concept_id, lexeme_id, status, version, retired_version),
        )


def _bind_test_mention(database, mention_id, concept_id):
    with database.transaction() as connection:
        connection.execute(
            "UPDATE mentions SET concept_id=? WHERE id=?",
            (concept_id, mention_id),
        )


def _insert_test_redirects(database, pairs):
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        for retired_id, canonical_id in pairs:
            connection.execute(
                """INSERT INTO concept_redirects(
                       retired_concept_id, canonical_concept_id, reason,
                       knowledge_version, created_at)
                   VALUES(?, ?, 'test redirect', ?,
                          '2000-01-01T00:00:00+00:00')""",
                (retired_id, canonical_id, version),
            )


def _insert_locked_coreference_decision(
    database,
    lexeme_id,
    mention_ids,
    left_concept_id,
    right_concept_id,
    *,
    relation="different",
):
    marker = ":".join(str(value) for value in sorted(mention_ids))
    payload = f"human:{relation}:{left_concept_id}:{right_concept_id}:{marker}"
    mention_set_id = stable_id("mention-set", marker)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
                   VALUES(?, ?, 'concept', ?, 'mention_set', ?, ?, 'human', 1.0,
                      1, '[]', '[]', '[]', ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                stable_id("coref", payload, length=24),
                lexeme_id,
                left_concept_id,
                mention_set_id,
                relation,
                payload,
                version,
            ),
        )


def _insert_same_coreference_decision(
    database,
    lexeme_id,
    mention_ids,
    concept_ids,
    *,
    decision_id="coref-authorized-merge",
    relation="same",
    retired=False,
):
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        retired_version = (
            database.create_knowledge_version("retire merge decision", connection)
            if retired
            else None
        )
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, retired_version, created_at)
               VALUES(?, ?, 'concept', ?, 'concept', ?, ?, 'human', 1.0, 1,
                      '[]', '[]', ?, ?, ?, ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                decision_id,
                lexeme_id,
                concept_ids[0],
                concept_ids[-1],
                relation,
                json.dumps(sorted(mention_ids)),
                f"payload:{decision_id}",
                version,
                retired_version,
            ),
        )
    return decision_id


def _prepare_authorized_merge(tmp_path, concept_ids=("concept-a", "concept-b")):
    database, lexeme_id, mention_ids, evidence_ids, case = _coreference_case(
        tmp_path, count=max(2, len(concept_ids))
    )
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
        )
        _bind_test_mention(database, mention_id, concept_id)
    decision_id = _insert_same_coreference_decision(
        database,
        lexeme_id,
        mention_ids,
        concept_ids,
    )
    return database, lexeme_id, mention_ids, evidence_ids, case, decision_id


def test_resolve_concept_redirect_is_read_only_and_follows_multiple_hops(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path, count=3)
    concept_ids = ("concept-oldest", "concept-middle", "concept-canonical")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
            retired=concept_id != concept_ids[-1],
        )
    _insert_test_redirects(
        database,
        [(concept_ids[0], concept_ids[1]), (concept_ids[1], concept_ids[2])],
    )
    resolve = _require_method(database, "resolve_concept_id")
    with closing(database.connect()) as connection:
        before = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("knowledge_versions", "concept_redirects", "audit_calls")
        }

    assert resolve(concept_ids[2]) == concept_ids[2]
    assert resolve(concept_ids[0]) == concept_ids[2]
    assert resolve(concept_ids[0]) == concept_ids[2]

    with closing(database.connect()) as connection:
        after = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in before
        }
    assert after == before


@pytest.mark.parametrize("invalid", ["missing", "dangling", "cycle", "cross_lexeme", "depth"])
def test_resolve_concept_redirect_rejects_invalid_graphs(tmp_path, invalid):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    resolve = _require_method(database, "resolve_concept_id")
    if invalid == "missing":
        with pytest.raises(KeyError, match="does not exist"):
            resolve("concept-missing")
        return
    if invalid == "cross_lexeme":
        old_id = "concept-cross-old"
        new_id = "concept-cross-new"
        _insert_test_concept(
            database, lexeme_id, old_id, anchor_mention_id=mention_ids[0], retired=True
        )
        other_lexeme = database.ensure_lexeme("Elsewhere")
        _insert_test_concept(database, other_lexeme, new_id)
        _insert_test_redirects(database, [(old_id, new_id)])
        with pytest.raises(ValueError, match="cross-lexeme"):
            resolve(old_id)
        return
    if invalid == "depth":
        ids = [f"concept-depth-{index:03d}" for index in range(67)]
        with database.transaction() as connection:
            version = connection.execute(
                "SELECT MAX(id) FROM knowledge_versions"
            ).fetchone()[0]
            connection.executemany(
                """INSERT INTO concepts(
                       id, kind, canonical_source, primary_lexeme_id,
                       created_version, retired_version, created_at)
                   VALUES(?, 'person', ?, ?, ?, ?,
                          '2000-01-01T00:00:00+00:00')""",
                [
                    (concept_id, concept_id, lexeme_id, version, None if index == 66 else version)
                    for index, concept_id in enumerate(ids)
                ],
            )
            connection.executemany(
                """INSERT INTO concept_redirects(
                       retired_concept_id, canonical_concept_id, reason,
                       knowledge_version, created_at)
                   VALUES(?, ?, 'depth test', ?,
                          '2000-01-01T00:00:00+00:00')""",
                [(ids[index], ids[index + 1], version) for index in range(66)],
            )
        with pytest.raises(ValueError, match="depth"):
            resolve(ids[0])
        return

    first = "concept-invalid-first"
    second = "concept-invalid-second"
    _insert_test_concept(
        database, lexeme_id, first, anchor_mention_id=mention_ids[0], retired=True
    )
    if invalid == "dangling":
        with pytest.raises(ValueError, match="dangling"):
            resolve(first)
        return
    _insert_test_concept(
        database, lexeme_id, second, anchor_mention_id=mention_ids[1], retired=True
    )
    _insert_test_redirects(database, [(first, second), (second, first)])
    with pytest.raises(ValueError, match="cycle"):
        resolve(first)


@pytest.mark.parametrize(
    ("criterion", "expected"),
    [
        ("locked", "concept-z"),
        ("verified", "concept-z"),
        ("target", "concept-z"),
        ("references", "concept-z"),
        ("created_at", "concept-z"),
        ("unicode_id", "concept-a"),
    ],
)
def test_merge_concept_redirect_canonical_tie_breaks_ignore_input_order(
    tmp_path, criterion, expected
):
    chosen = []
    for suffix, reverse in (("forward", False), ("reverse", True)):
        root = tmp_path / suffix
        root.mkdir()
        concept_ids = ("concept-a", "concept-z")
        database, _, mention_ids, _, _, decision_id = _prepare_authorized_merge(
            root, concept_ids
        )
        with database.transaction() as connection:
            if criterion == "locked":
                connection.execute("UPDATE concepts SET locked=1 WHERE id='concept-z'")
            elif criterion == "verified":
                connection.execute(
                    "UPDATE concepts SET status='verified' WHERE id='concept-z'"
                )
            elif criterion == "target":
                connection.execute(
                    "UPDATE concepts SET working_target='译名' WHERE id='concept-z'"
                )
            elif criterion == "references":
                connection.execute(
                    "UPDATE mentions SET concept_id='concept-z' WHERE id=?",
                    (mention_ids[0],),
                )
            elif criterion == "created_at":
                connection.execute(
                    "UPDATE concepts SET created_at='1999-01-01T00:00:00+00:00' "
                    "WHERE id='concept-z'"
                )
        ordered = tuple(reversed(concept_ids)) if reverse else concept_ids
        result = database.merge_concepts(
            ordered, reason=f"test {criterion}", decision_id=decision_id
        )
        chosen.append(result["canonical_id"])
        assert result["selection_key"]["criterion"] == criterion
        assert database.merge_concepts(
            tuple(reversed(ordered)),
            reason=f"replay {criterion}",
            decision_id=decision_id,
        )["changed"] is False
    assert chosen == [expected, expected]


def test_merge_concept_redirect_moves_active_associations_and_preserves_history(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, _, decision_id = (
        _prepare_authorized_merge(tmp_path)
    )
    canonical_id, old_id = "concept-a", "concept-b"
    alias_lexeme = database.ensure_lexeme("Briah-title")
    database.start_run("merge-run", "adjudicate", {})
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO concept_lexemes(
                   concept_id, lexeme_id, role, confidence, status, evidence_id,
                   created_version, created_at)
               VALUES(?, ?, 'title', 0.8, 'verified', ?, ?,
                      '2001-01-01T00:00:00+00:00')""",
            (old_id, alias_lexeme, evidence_ids[1], version),
        )
        connection.execute(
            """INSERT INTO concept_type_observations(
                   concept_id, lexeme_id, mention_id, evidence_id, kind,
                   confidence, source, created_version, created_at)
               VALUES(?, ?, ?, ?, 'person', 0.9, 'merge-test', ?,
                      '2001-01-01T00:00:00+00:00')""",
            (old_id, lexeme_id, mention_ids[1], evidence_ids[1], version),
        )
        retired_observation = connection.execute(
            """INSERT INTO concept_type_observations(
                   concept_id, lexeme_id, mention_id, evidence_id, kind,
                   confidence, source, created_version, retired_version, created_at)
               VALUES(?, ?, ?, ?, 'place', 0.5, 'historical', ?, ?,
                      '1999-01-01T00:00:00+00:00')""",
            (old_id, lexeme_id, mention_ids[1], evidence_ids[1], version, version),
        ).lastrowid
        connection.execute(
            """INSERT INTO candidate_clusters(
                   id, run_id, ordinal, created_at, updated_at)
               VALUES('merge-cluster', 'merge-run', 0,
                      '2001-01-01T00:00:00+00:00',
                      '2001-01-01T00:00:00+00:00')"""
        )
        connection.execute(
            """INSERT INTO candidate_adjudications(
                   id, run_id, cluster_id, verdict, payload_hash,
                   knowledge_version, active, created_at, updated_at)
               VALUES('merge-adjudication', 'merge-run', 'merge-cluster',
                      'entity', 'merge-payload', ?, 1,
                      '2001-01-01T00:00:00+00:00',
                      '2001-01-01T00:00:00+00:00')""",
            (version,),
        )
        connection.execute(
            """INSERT INTO candidate_resolutions(
                   id, adjudication_id, run_id, cluster_id, lexeme_id,
                   concept_id, evidence_id, decision, ordinal, created_at)
               VALUES('merge-resolution', 'merge-adjudication', 'merge-run',
                      'merge-cluster', ?, ?, ?, 'create', 0,
                      '2001-01-01T00:00:00+00:00')""",
            (lexeme_id, old_id, evidence_ids[1]),
        )
        old_audit = database.record_audit_call(
            run_id="merge-run",
            block_id=None,
            purpose="historical-human-note",
            model="manual",
            knowledge_version=version,
            request={"actor_type": "human", "concept_id": old_id},
            raw_response="old concept evidence",
            parsed={"actor_type": "human", "concept_id": old_id},
            accepted=True,
            attempts=1,
            elapsed_ms=0,
            error=None,
            connection=connection,
        )

    result = database.merge_concepts(
        [old_id, canonical_id], reason="same identity", decision_id=decision_id
    )

    assert result["canonical_id"] == canonical_id
    assert result["changed"] is True
    assert database.resolve_concept_id(old_id) == canonical_id
    with closing(database.connect()) as connection:
        assert {
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions WHERE id IN (?, ?)", mention_ids
            )
        } == {canonical_id}
        assert connection.execute(
            "SELECT concept_id FROM candidate_resolutions WHERE id='merge-resolution'"
        ).fetchone()[0] == canonical_id
        assert connection.execute(
            """SELECT concept_id FROM concept_type_observations
               WHERE source='merge-test'"""
        ).fetchone()[0] == canonical_id
        assert connection.execute(
            "SELECT concept_id FROM concept_type_observations WHERE id=?",
            (retired_observation,),
        ).fetchone()[0] == old_id
        title = connection.execute(
            """SELECT concept_id, confidence, status, evidence_id
               FROM concept_lexemes WHERE lexeme_id=? AND role='title'
                 AND retired_version IS NULL""",
            (alias_lexeme,),
        ).fetchone()
        old_primary = connection.execute(
            """SELECT retired_version FROM concept_lexemes
               WHERE concept_id=? AND lexeme_id=? AND role='primary'""",
            (old_id, lexeme_id),
        ).fetchone()[0]
        old_concept = connection.execute(
            "SELECT status, retired_version FROM concepts WHERE id=?", (old_id,)
        ).fetchone()
        changes = connection.execute(
            """SELECT change_kind FROM knowledge_changes
               WHERE knowledge_version=? ORDER BY id""",
            (result["knowledge_version"],),
        ).fetchall()
    assert tuple(title) == (canonical_id, 0.8, "verified", evidence_ids[1])
    assert old_primary == result["knowledge_version"]
    assert tuple(old_concept) == ("merged", result["knowledge_version"])
    assert {row[0] for row in changes} == {"subject_link"}
    assert database.read_audit_payload(old_audit)["raw_response"] == "old concept evidence"


def test_merge_concepts_transfers_active_term_profile_to_canonical(tmp_path):
    database, _, _, _, _, decision_id = _prepare_authorized_merge(tmp_path)
    canonical_id, old_id = "concept-a", "concept-b"
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO term_profiles(
                   subject_type, subject_id, semantic_core,
                   contrast_sources_json, status, locked,
                   created_version, created_at)
               VALUES('concept', ?, ?, ?, 'verified', 1, ?, 'now')""",
            (
                old_id,
                "以刑讯、拷问为职责的正式职业身份。",
                json.dumps(["executioner", "headsman"]),
                version,
            ),
        )

    result = database.merge_concepts(
        [old_id, canonical_id],
        reason="same identity",
        decision_id=decision_id,
    )

    assert result["canonical_id"] == canonical_id
    with closing(database.connect()) as connection:
        active = connection.execute(
            """SELECT subject_id, semantic_core, contrast_sources_json,
                      status, locked, created_version
               FROM term_profiles
               WHERE subject_type='concept' AND retired_version IS NULL"""
        ).fetchall()
        retired_old = connection.execute(
            """SELECT retired_version FROM term_profiles
               WHERE subject_type='concept' AND subject_id=?
               ORDER BY created_version DESC LIMIT 1""",
            (old_id,),
        ).fetchone()[0]
    assert [tuple(row) for row in active] == [
        (
            canonical_id,
            "以刑讯、拷问为职责的正式职业身份。",
            '["executioner","headsman"]',
            "verified",
            1,
            result["knowledge_version"],
        )
    ]
    assert retired_old == result["knowledge_version"]


def test_merge_concept_redirect_combines_dependency_evidence_and_identical_rules(tmp_path):
    database, _, _, _, _, decision_id = _prepare_authorized_merge(tmp_path)
    canonical_id, old_id = "concept-a", "concept-b"
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        translation_id = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status,
                   final_translation, active, created_at)
               VALUES('block-1', 'parallel_v4', ?, 'completed', '译文', 1,
                      '2001-01-01T00:00:00+00:00')""",
            (version,),
        ).lastrowid
        connection.executemany(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority, status,
                   locked, created_version, created_at)
               VALUES(?, ?, ?, '同译', 10, 'verified', ?, ?, ?)""",
            [
                (
                    "rule-canonical",
                    canonical_id,
                    '{"chapter":1,"speaker":"A"}',
                    0,
                    version,
                    "2001-01-01T00:00:00+00:00",
                ),
                (
                    "rule-old-locked",
                    old_id,
                    '{ "speaker" : "A", "chapter" : 1 }',
                    1,
                    version,
                    "2002-01-01T00:00:00+00:00",
                ),
            ],
        )
        connection.executemany(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id,
                   knowledge_version, dependency_fingerprint, matched_form,
                   occurrence_count, rendered_target, applied_rule_ids_json,
                   source_spans_json)
               VALUES(?, 'concept', ?, ?, ?, ?, ?, '同译', ?, ?)""",
            [
                (
                    translation_id,
                    canonical_id,
                    version,
                    "fp-a",
                    "Briah",
                    1,
                    '["rule-canonical"]',
                    '[[0,5]]',
                ),
                (
                    translation_id,
                    old_id,
                    version,
                    "fp-b",
                    "BRIAH",
                    2,
                    '["rule-old-locked"]',
                    '[[10,15],[0,5]]',
                ),
            ],
        )

    result = database.merge_concepts(
        [canonical_id, old_id], reason="merge evidence", decision_id=decision_id
    )

    with closing(database.connect()) as connection:
        active_rules = connection.execute(
            """SELECT id, concept_id, condition_json FROM rendering_rules
               WHERE retired_version IS NULL ORDER BY id"""
        ).fetchall()
        retired = connection.execute(
            "SELECT retired_version FROM rendering_rules WHERE id='rule-canonical'"
        ).fetchone()[0]
        dependency = connection.execute(
            """SELECT dependency_id, occurrence_count, applied_rule_ids_json,
                      source_spans_json
               FROM dependencies WHERE translation_id=? AND dependency_type='concept'""",
            (translation_id,),
        ).fetchone()
    assert [tuple(row) for row in active_rules] == [
        (
            "rule-old-locked",
            result["canonical_id"],
            '{"chapter":1,"speaker":"A"}',
        )
    ]
    assert retired == result["knowledge_version"]
    assert dependency["dependency_id"] == result["canonical_id"]
    assert dependency["occurrence_count"] == 3
    assert json.loads(dependency["applied_rule_ids_json"]) == ["rule-old-locked"]
    assert json.loads(dependency["source_spans_json"]) == [[0, 5], [10, 15]]


def test_merge_concept_redirect_retires_conflicting_rules_and_queues_one_warning(tmp_path):
    database, _, _, _, _, decision_id = _prepare_authorized_merge(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.executemany(
            """INSERT INTO rendering_rules(
                   id, concept_id, condition_json, target, priority,
                   created_version, created_at)
               VALUES(?, ?, ?, ?, 10, ?,
                      '2001-01-01T00:00:00+00:00')""",
            [
                ("rule-a", "concept-a", '{"speaker":"A"}', "甲", version),
                ("rule-b", "concept-b", '{ "speaker" : "A" }', "乙", version),
            ],
        )

    first = database.merge_concepts(
        ["concept-a", "concept-b"], reason="rule conflict", decision_id=decision_id
    )
    second = database.merge_concepts(
        ["concept-b", "concept-a"], reason="replay", decision_id=decision_id
    )

    assert first["rule_conflicts"] == 1
    assert second["changed"] is False
    with closing(database.connect()) as connection:
        rules = connection.execute(
            "SELECT id, retired_version FROM rendering_rules ORDER BY id"
        ).fetchall()
        queue = connection.execute(
            """SELECT severity, status, payload_json FROM human_queue
               WHERE kind='render_rule_conflict'"""
        ).fetchall()
    assert {row["retired_version"] for row in rules} == {first["knowledge_version"]}
    assert len(queue) == 1
    assert tuple(queue[0])[:2] == ("warning", "open")
    payload = json.loads(queue[0]["payload_json"])
    assert payload["canonical_concept_id"] == first["canonical_id"]
    assert payload["decision_id"] == decision_id
    assert payload["rule_count"] == 2
    assert set(payload["targets"]) == {"甲", "乙"}


@pytest.mark.parametrize("bad_relation", ["different", "uncertain"])
def test_merge_concept_redirect_rejects_wrong_or_retired_decision(tmp_path, bad_relation):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-a", "concept-b")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(database, lexeme_id, concept_id, anchor_mention_id=mention_id)
        _bind_test_mention(database, mention_id, concept_id)
    decision_id = _insert_same_coreference_decision(
        database,
        lexeme_id,
        mention_ids,
        concept_ids,
        relation=bad_relation,
        retired=bad_relation == "uncertain",
    )

    with pytest.raises(ValueError, match="active same"):
        database.merge_concepts(
            concept_ids, reason="not authorized", decision_id=decision_id
        )
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM concept_redirects").fetchone()[0] == 0


def test_merge_concept_redirect_method_savepoint_rolls_back_every_write(tmp_path):
    database, _, mention_ids, _, _, decision_id = _prepare_authorized_merge(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        translation_id = connection.execute(
            """INSERT INTO translation_versions(
                   block_id, pipeline, knowledge_version, status, active, created_at)
               VALUES('block-1', 'parallel_v4', ?, 'completed', 1,
                      '2001-01-01T00:00:00+00:00')""",
            (version,),
        ).lastrowid
        connection.execute(
            """INSERT INTO dependencies(
                   translation_id, dependency_type, dependency_id, knowledge_version)
               VALUES(?, 'concept', 'concept-b', ?)""",
            (translation_id, version),
        )
        before = {
            "versions": connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone()[0],
            "audits": connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0],
        }
        connection.execute(
            """CREATE TEMP TRIGGER reject_merge_redirect
               BEFORE INSERT ON concept_redirects
               BEGIN
                   SELECT RAISE(ABORT, 'forced redirect failure');
               END"""
        )
        with pytest.raises(sqlite3.IntegrityError, match="forced redirect failure"):
            database.merge_concepts(
                ["concept-a", "concept-b"],
                reason="must roll back",
                decision_id=decision_id,
                connection=connection,
            )

    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM concept_redirects").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone()[0] == before["versions"]
        assert connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0] == before["audits"]
        assert connection.execute(
            "SELECT dependency_id FROM dependencies WHERE translation_id=?",
            (translation_id,),
        ).fetchone()[0] == "concept-b"
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions WHERE id IN (?, ?) ORDER BY id",
                mention_ids,
            )
        ] == ["concept-a", "concept-b"]
    assert not list(database.audit_archive.root.glob("*.jsonl.zst"))


def test_ensure_concept_for_anchor_is_stable_idempotent_and_anchor_immutable(
    tmp_path,
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    ensure = _require_method(database, "ensure_concept_for_anchor")

    first = ensure(lexeme_id, mention_ids[0], kind="person")
    replay = ensure(lexeme_id, mention_ids[0], kind="place")

    assert first == replay == stable_id(
        "concept", f"{lexeme_id}:{mention_ids[0]}"
    )
    with closing(database.connect()) as connection:
        concept = connection.execute(
            """SELECT kind, primary_lexeme_id, anchor_mention_id,
                      retired_version
               FROM concepts WHERE id=?""",
            (first,),
        ).fetchone()
        links = connection.execute(
            """SELECT role, COUNT(*) FROM concept_lexemes
               WHERE concept_id=? AND retired_version IS NULL GROUP BY role""",
            (first,),
        ).fetchall()

    assert tuple(concept) == ("person", lexeme_id, mention_ids[0], None)
    assert [tuple(row) for row in links] == [("primary", 1)]


def test_ensure_concept_for_anchor_rejects_inactive_mentions_and_collisions(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    expected = stable_id("concept", f"{lexeme_id}:{mention_ids[0]}")
    _insert_test_concept(
        database,
        lexeme_id,
        expected,
        anchor_mention_id=mention_ids[1],
    )

    with pytest.raises(RuntimeError, match="collision|anchor"):
        database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])

    other_root = tmp_path / "other"
    other_root.mkdir()
    other = _db(other_root, source_text="John")
    other_lexeme = other.ensure_lexeme("John")
    other_mention, _ = _insert_coreference_mention(
        other,
        other_lexeme,
        paragraph_id="P001",
        evidence_quote="John",
        source_form="John",
    )
    with other.transaction() as connection:
        connection.execute("UPDATE source_editions SET active=0")
    with pytest.raises(ValueError, match="active"):
        other.ensure_concept_for_anchor(other_lexeme, other_mention)


def test_ensure_concept_for_anchor_never_revives_retired_identity(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    expected = stable_id("concept", f"{lexeme_id}:{mention_ids[0]}")
    _insert_test_concept(
        database,
        lexeme_id,
        expected,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )

    with pytest.raises(ValueError, match="retired"):
        database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT retired_version FROM concepts WHERE id=?", (expected,)
        ).fetchone()[0] is not None


def test_ensure_concept_for_anchor_rejects_a_competing_owner_for_the_anchor(
    tmp_path,
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    expected = stable_id("concept", f"{lexeme_id}:{mention_ids[0]}")
    _insert_test_concept(
        database,
        lexeme_id,
        expected,
        anchor_mention_id=mention_ids[0],
    )
    _insert_test_concept(
        database,
        lexeme_id,
        "concept-competing-anchor-owner",
        anchor_mention_id=mention_ids[0],
    )

    with pytest.raises(RuntimeError, match="anchor collision"):
        database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])


def test_bind_mentions_rejects_a_batch_with_locked_conflicting_anchor_identity(
    tmp_path,
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    target = database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])
    locked = "concept-human-locked"
    _insert_test_concept(
        database,
        lexeme_id,
        locked,
        anchor_mention_id=mention_ids[1],
        locked=True,
        status="verified",
    )
    _bind_test_mention(database, mention_ids[1], locked)

    with pytest.raises(ValueError, match="immutable|anchor"):
        database.bind_mentions(target, mention_ids)
    with closing(database.connect()) as connection:
        bound = connection.execute(
            "SELECT id, concept_id FROM mentions ORDER BY id"
        ).fetchall()
    assert [tuple(row) for row in bound] == [
        (mention_ids[0], None),
        (mention_ids[1], locked),
    ]


def test_anchor_database_apis_require_active_explicit_transactions(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    with closing(database.connect()) as connection:
        with pytest.raises(ValueError, match="active transaction"):
            database.ensure_concept_for_anchor(
                lexeme_id, mention_ids[0], connection=connection
            )
        with pytest.raises(ValueError, match="active transaction"):
            database.bind_mentions(
                "missing-concept", mention_ids, connection=connection
            )


def test_anchor_database_apis_follow_caller_rollback_atomically(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_id = stable_id("concept", f"{lexeme_id}:{mention_ids[0]}")

    with pytest.raises(RuntimeError, match="caller rollback"):
        with database.transaction() as connection:
            assert database.ensure_concept_for_anchor(
                lexeme_id, mention_ids[0], connection=connection
            ) == concept_id
            assert database.bind_mentions(
                concept_id, mention_ids, connection=connection
            ) == 2
            raise RuntimeError("caller rollback")

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts WHERE id=?", (concept_id,)
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
def test_bind_mentions_validates_the_full_batch_before_writing(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    other_lexeme = database.ensure_lexeme("John")
    other_mention, _ = _insert_coreference_mention(
        database,
        other_lexeme,
        paragraph_id="P999",
        evidence_quote="John",
        source_form="John",
    )
    concept_id = database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])

    with pytest.raises(ValueError, match="same lexeme"):
        database.bind_mentions(concept_id, [mention_ids[0], other_mention])

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT concept_id FROM mentions WHERE id=?", (mention_ids[0],)
        ).fetchone()[0] is None


def test_deterministic_same_span_rule_binds_a_stable_anchor(tmp_path):
    database = _db(tmp_path, source_text="Briah")
    lexeme_id = database.ensure_lexeme("Briah")
    mention_ids = []
    evidence_ids = []
    for index in range(2):
        mention_id, evidence_id = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id="P001",
            evidence_quote="Briah",
            kind="person",
        )
        mention_ids.append(mention_id)
        evidence_ids.append(evidence_id)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"start_offset": 0, "end_offset": 5},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    result = CoreferenceCoordinator(database).resolve_deterministic(case)

    expected = stable_id("concept", f"{lexeme_id}:{mention_ids[0]}")
    assert result == ("same", "same_span")
    with closing(database.connect()) as connection:
        assert {
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions WHERE lexeme_id=?", (lexeme_id,)
            )
        } == {expected}


def test_deterministic_same_evidence_hash_retry_rule(tmp_path):
    database, _, _, evidence_ids, case = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "retry-evidence-001"},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "same",
        "same_evidence_hash_retry",
    )


def test_deterministic_unique_human_locked_concept_rule_reuses_human_fields(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_id = "concept-curated-briah"
    _insert_test_concept(
        database,
        lexeme_id,
        concept_id,
        anchor_mention_id=mention_ids[0],
        locked=True,
        status="verified",
    )
    with database.transaction() as connection:
        connection.execute(
            """UPDATE concepts
               SET verified_target='布里亚', description='human note'
               WHERE id=?""",
            (concept_id,),
        )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "same",
        "unique_human_locked_concept",
    )
    with closing(database.connect()) as connection:
        concept = connection.execute(
            """SELECT verified_target, description, locked, anchor_mention_id
               FROM concepts WHERE id=?""",
            (concept_id,),
        ).fetchone()
        bindings = connection.execute(
            "SELECT DISTINCT concept_id FROM mentions WHERE lexeme_id=?",
            (lexeme_id,),
        ).fetchall()
    assert tuple(concept) == ("布里亚", "human note", 1, mention_ids[0])
    assert [row[0] for row in bindings] == [concept_id]


def test_deterministic_exact_title_fingerprint_rule(tmp_path):
    database = _db(tmp_path, source_text="II The Fleshing")
    lexeme_id = database.ensure_lexeme("The Fleshing")
    with database.transaction() as connection:
        edition_id = connection.execute(
            "SELECT id FROM source_editions WHERE active=1"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO blocks(
                   id, legacy_id, source_edition_id, chapter_id, chapter_title,
                   chapter_index, block_index, global_index, block_type,
                   source_text, source_hash, token_count, status, updated_at)
               VALUES('block-title', 'block-title', ?, 'toc', 'Contents',
                      0, 1, 1, 'toc',
                      'II The Fleshing', 'hash-title', 3, 'ready',
                      '2000-01-01T00:00:00+00:00')""",
            (edition_id,),
        )
    evidence_ids = []
    for paragraph_id, block_id in (
        ("P001", "block-title"),
        ("P002", "block-1"),
    ):
        _, evidence_id = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=paragraph_id,
            evidence_quote="II — The Fleshing",
            kind="title",
            source_form="The Fleshing",
            block_id=block_id,
        )
        evidence_ids.append(evidence_id)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"title_fingerprint": "ii-the-fleshing"},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "same",
        "exact_title_fingerprint",
    )


def test_deterministic_title_fingerprint_requires_directory_and_body_evidence(
    tmp_path,
):
    database = _db(tmp_path, source_text="The Fleshing")
    lexeme_id = database.ensure_lexeme("The Fleshing")
    evidence_ids = []
    for paragraph_id in ("P001", "P002"):
        _, evidence_id = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=paragraph_id,
            evidence_quote="The Fleshing",
            kind="title",
            source_form="The Fleshing",
        )
        evidence_ids.append(evidence_id)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"title_fingerprint": "the-fleshing"},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        None,
        None,
    )


def test_deterministic_same_anchor_or_duplicate_subset_rule(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_id = database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])
    assert database.bind_mentions(concept_id, mention_ids) == 2
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "same",
        "same_anchor_or_duplicate_subset",
    )


def test_deterministic_duplicate_subset_reuses_the_prior_decision_concept(tmp_path):
    database, lexeme_id, mention_ids, _, case = _coreference_case(
        tmp_path, count=3
    )
    concept_id = "concept-prior-subset-anchor"
    _insert_test_concept(
        database,
        lexeme_id,
        concept_id,
        anchor_mention_id=mention_ids[2],
    )
    previous_set_id = stable_id(
        "mention-set", ":".join(sorted(str(value) for value in mention_ids))
    )
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-prior-subset', ?, 'concept', ?, 'mention_set', ?,
                      'same', 'deterministic', 1.0, 0, '[]', '[]', ?,
                      'prior-subset-payload', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                lexeme_id,
                concept_id,
                previous_set_id,
                json.dumps(sorted(mention_ids)),
                version,
            ),
        )
    subset_mentions = case.mentions[:2]
    subset = replace(
        case,
        mention_set_id=stable_id(
            "mention-set",
            ":".join(
                sorted(str(mention.mention_id) for mention in subset_mentions)
            ),
        ),
        mentions=subset_mentions,
    )

    assert CoreferenceCoordinator(database).resolve_deterministic(subset) == (
        "same",
        "same_anchor_or_duplicate_subset",
    )
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts WHERE retired_version IS NULL"
        ).fetchone()[0] == 1
        assert {
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions WHERE id IN (?, ?)",
                (mention_ids[0], mention_ids[1]),
            )
        } == {concept_id}


def test_deterministic_redirect_rule_uses_active_canonical_concept(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    retired_id = "concept-retired-briah"
    canonical_id = "concept-canonical-briah"
    _insert_test_concept(
        database,
        lexeme_id,
        retired_id,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    _insert_test_concept(
        database,
        lexeme_id,
        canonical_id,
        anchor_mention_id=mention_ids[1],
    )
    _bind_test_mention(database, mention_ids[0], retired_id)
    _bind_test_mention(database, mention_ids[1], canonical_id)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO concept_redirects(
                   retired_concept_id, canonical_concept_id, reason,
                   knowledge_version, created_at)
               VALUES(?, ?, 'duplicate', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (retired_id, canonical_id, version),
        )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    coordinator = CoreferenceCoordinator(database)
    assert coordinator.resolve_deterministic(case) == (
        "same",
        "redirect",
    )
    assert coordinator.resolve_deterministic(coordinator.freeze_cases()[0]) == (
        "same",
        "redirect",
    )
    with closing(database.connect()) as connection:
        bindings = connection.execute(
            "SELECT DISTINCT concept_id FROM mentions WHERE lexeme_id=?",
            (lexeme_id,),
        ).fetchall()
        decision_count = connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0]
        audit_count = connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0]
    assert [row[0] for row in bindings] == [canonical_id]
    assert (decision_count, audit_count) == (1, 1)


def test_deterministic_same_name_different_people_are_not_merged(tmp_path):
    database = _db(tmp_path, source_text="John met John.")
    lexeme_id = database.ensure_lexeme("John")
    mention_ids = []
    for index in range(2):
        mention_id, _ = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=f"P{index + 1:03d}",
            evidence_quote=f"John identity {index}",
            kind="person",
            source_form="John",
        )
        mention_ids.append(mention_id)
        concept_id = f"concept-john-{index}"
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
            locked=True,
            status="verified",
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        None,
        None,
    )
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0


def test_deterministic_locked_different_decision_wins_without_auto_same(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    left = "concept-left-briah"
    right = "concept-right-briah"
    for concept_id, mention_id in zip((left, right), mention_ids):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
        )
        _bind_test_mention(database, mention_id, concept_id)
    _insert_locked_coreference_decision(
        database, lexeme_id, mention_ids, left, right
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "different",
        "locked_decision",
    )
    assert database.bind_mentions(left, mention_ids) == 0
    with closing(database.connect()) as connection:
        sources = connection.execute(
            "SELECT decision_source, relation FROM coreference_decisions"
        ).fetchall()
        bindings = connection.execute(
            "SELECT concept_id FROM mentions ORDER BY id"
        ).fetchall()
    assert [tuple(row) for row in sources] == [("human", "different")]
    assert [row[0] for row in bindings] == [left, right]


def test_deterministic_locked_different_subset_blocks_an_expanded_same_case(
    tmp_path,
):
    database, lexeme_id, mention_ids, _, case = _coreference_case(
        tmp_path, count=3
    )
    concept_id = "concept-human-anchor"
    _insert_test_concept(
        database,
        lexeme_id,
        concept_id,
        anchor_mention_id=mention_ids[0],
        locked=True,
        status="verified",
    )
    _bind_test_mention(database, mention_ids[0], concept_id)
    protected_set_id = stable_id("mention-set", str(mention_ids[1]))
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-human-subset-different', ?, 'concept', ?,
                      'mention_set', ?, 'different', 'human', 1.0, 1,
                      '[]', '[]', ?, 'human-subset-different', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                lexeme_id,
                concept_id,
                protected_set_id,
                json.dumps([mention_ids[1]]),
                version,
            ),
        )

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "different",
        "locked_decision",
    )
    with closing(database.connect()) as connection:
        bindings = connection.execute(
            "SELECT concept_id FROM mentions ORDER BY id"
        ).fetchall()
        decisions = connection.execute(
            "SELECT relation, decision_source FROM coreference_decisions"
        ).fetchall()
    assert [row[0] for row in bindings] == [concept_id, None, None]
    assert [tuple(row) for row in decisions] == [("different", "human")]


def test_deterministic_same_rolls_back_if_any_member_cannot_be_bound(tmp_path):
    database, lexeme_id, mention_ids, _, case = _coreference_case(
        tmp_path, count=3
    )
    target = "concept-human-target"
    retired = "concept-retired-without-redirect"
    _insert_test_concept(
        database,
        lexeme_id,
        target,
        anchor_mention_id=mention_ids[0],
        locked=True,
        status="verified",
    )
    _insert_test_concept(
        database,
        lexeme_id,
        retired,
        anchor_mention_id=mention_ids[1],
        retired=True,
    )
    _bind_test_mention(database, mention_ids[0], target)
    _bind_test_mention(database, mention_ids[1], retired)

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        None,
        None,
    )
    with closing(database.connect()) as connection:
        bindings = connection.execute(
            "SELECT concept_id FROM mentions ORDER BY id"
        ).fetchall()
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
    assert [row[0] for row in bindings] == [target, retired, None]


def test_deterministic_rejects_a_forged_cross_lexeme_mention_set(tmp_path):
    database, _, _, _, case = _coreference_case(tmp_path)
    other_lexeme = database.ensure_lexeme("John")
    other_mention_id, _ = _insert_coreference_mention(
        database,
        other_lexeme,
        paragraph_id="P999",
        evidence_quote="John",
        source_form="John",
    )
    forged_mention = replace(
        case.mentions[1],
        mention_id=other_mention_id,
    )
    forged_mentions = (case.mentions[0], forged_mention)
    forged = replace(
        case,
        mention_set_id=stable_id(
            "mention-set",
            ":".join(
                sorted(str(mention.mention_id) for mention in forged_mentions)
            ),
        ),
        mentions=forged_mentions,
    )

    with pytest.raises(ValueError, match="one lexeme"):
        CoreferenceCoordinator(database).resolve_deterministic(forged)


def test_deterministic_external_connection_fails_before_partial_writes(tmp_path):
    database, _, _, evidence_ids, case = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "external-connection"},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    with closing(database.connect()) as connection:
        connection.execute("BEGIN")
        with pytest.raises(RuntimeError, match="managed database transaction"):
            CoreferenceCoordinator(database).resolve_deterministic(
                case, connection=connection
            )
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
        connection.rollback()


def test_deterministic_rerun_is_fully_idempotent_and_audited_without_model(
    tmp_path,
):
    database, lexeme_id, _, evidence_ids, _ = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "stable-retry"},
    )
    coordinator = CoreferenceCoordinator(database)
    first_case = coordinator.freeze_cases()[0]

    assert coordinator.resolve_deterministic(first_case) == (
        "same",
        "same_evidence_hash_retry",
    )
    assert coordinator.resolve_deterministic(coordinator.freeze_cases()[0]) == (
        "same",
        "same_evidence_hash_retry",
    )

    with closing(database.connect()) as connection:
        counts = {
            "concepts": connection.execute(
                "SELECT COUNT(*) FROM concepts WHERE retired_version IS NULL"
            ).fetchone()[0],
            "decisions": connection.execute(
                "SELECT COUNT(*) FROM coreference_decisions"
            ).fetchone()[0],
            "audits": connection.execute(
                """SELECT COUNT(*) FROM audit_calls
                   WHERE purpose='deterministic_coreference'"""
            ).fetchone()[0],
        }
        audit = connection.execute(
            """SELECT id, model, accepted FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()
        assert connection.execute(
            """SELECT COUNT(DISTINCT concept_id) FROM mentions
               WHERE lexeme_id=?""",
            (lexeme_id,),
        ).fetchone()[0] == 1

    assert counts == {"concepts": 1, "decisions": 1, "audits": 1}
    assert tuple(audit)[1:] == ("none", 1)
    payload = database.read_audit_payload(audit["id"])
    assert payload["parsed"]["actor_type"] == "deterministic"
    assert payload["parsed"]["rule"] == "same_evidence_hash_retry"


def test_coreference_type_observations_hide_retired_concept_ids(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    with database.transaction() as connection:
        created_version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO concepts(
                   id, kind, canonical_source, primary_lexeme_id,
                   created_version, created_at)
               VALUES('retired-observation-concept', 'organization', 'Briah',
                      ?, ?, '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, created_version),
        )
        database.record_type_observation(
            lexeme_id,
            "organization",
            confidence=0.7,
            source="retired-concept-test",
            mention_id=mention_ids[0],
            concept_id="retired-observation-concept",
            evidence_id=evidence_ids[0],
            connection=connection,
        )
        retired_version = database.create_knowledge_version(
            "retire observation concept", connection
        )
        connection.execute(
            """UPDATE concepts SET retired_version=?
               WHERE id='retired-observation-concept'""",
            (retired_version,),
        )

    case = CoreferenceCoordinator(database).freeze_cases()[0]
    payload = json.loads(CoreferenceCoordinator.payload_bytes(case))["case"]

    assert "retired-observation-concept" not in json.dumps(payload)
    assert all(
        item["concept_id"] is None for item in payload["type_observations"]
    )
    assert all(
        item["concept_id"] is None
        for mention in payload["mentions"]
        for item in mention["type_observations"]
    )


def test_coreference_cache_key_uses_payload_models_and_protocol_not_model_order(
    tmp_path, monkeypatch
):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)

    original = coordinator.cache_key(case, ["model-b", "model-a"])
    assert original == coordinator.cache_key(case, ["model-a", "model-b"])
    assert original != coordinator.cache_key(case, ["model-a", "model-c"])

    changed_case = replace(case, knowledge_version=case.knowledge_version + 1)
    assert original != coordinator.cache_key(changed_case, ["model-a", "model-b"])

    monkeypatch.setattr(coreference_module, "COREFERENCE_PROTOCOL_VERSION", "test-v2")
    assert original != coordinator.cache_key(case, ["model-a", "model-b"])


@pytest.mark.parametrize(
    "model_names",
    [
        ["", "model-b"],
        ["   ", "model-b"],
        ["model-a", "model-a"],
        [" model-a ", "model-a"],
    ],
)
def test_coreference_dual_model_names_must_be_nonempty_and_distinct(
    tmp_path, model_names
):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)

    with pytest.raises(ValueError):
        coordinator.cache_key(case, model_names)
    with pytest.raises(ValueError):
        coordinator.model_payloads(case, model_names)


def test_deterministic_method_savepoint_rolls_back_when_decision_insert_fails(
    tmp_path,
):
    database, _, _, evidence_ids, _ = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "savepoint-decision-failure"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    with database.transaction() as connection:
        connection.execute(
            """CREATE TEMP TRIGGER reject_deterministic_decision
               BEFORE INSERT ON coreference_decisions
               WHEN NEW.decision_source='deterministic'
               BEGIN
                   SELECT RAISE(ABORT, 'forced decision insert failure');
               END"""
        )
        with pytest.raises(
            sqlite3.IntegrityError, match="forced decision insert failure"
        ):
            coordinator.resolve_deterministic(case, connection=connection)

        assert connection.execute(
            "SELECT COUNT(*) FROM concepts"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 0


def test_deterministic_method_savepoint_rolls_back_when_audit_insert_fails(
    tmp_path,
):
    database, _, _, evidence_ids, _ = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "savepoint-audit-failure"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    with database.transaction() as connection:
        connection.execute(
            """CREATE TEMP TRIGGER reject_deterministic_audit
               BEFORE INSERT ON audit_calls
               WHEN NEW.purpose='deterministic_coreference'
               BEGIN
                   SELECT RAISE(ABORT, 'forced audit insert failure');
               END"""
        )
        with pytest.raises(
            sqlite3.IntegrityError, match="forced audit insert failure"
        ):
            coordinator.resolve_deterministic(case, connection=connection)

        for table in (
            "concepts",
            "concept_lexemes",
            "coreference_decisions",
            "audit_calls",
        ):
            assert connection.execute(
                f"SELECT COUNT(*) FROM {table}"
            ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
    assert not list(database.audit_archive.root.glob("*.jsonl.zst"))


def test_deterministic_conflicting_provisional_place_anchors_block_hash_merge(
    tmp_path,
):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    anchors = ("concept-place-left", "concept-place-right")
    for concept_id, mention_id in zip(anchors, mention_ids):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
            kind="place",
        )
        _bind_test_mention(database, mention_id, concept_id)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "same-place-evidence"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    assert coordinator._deterministic_relation(case) == (None, None)
    assert coordinator.resolve_deterministic(case) == (None, None)
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == list(anchors)
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0


def test_deterministic_rejects_foreign_lexeme_payload_anchor(tmp_path):
    database, _, _, evidence_ids, case = _coreference_case(tmp_path)
    foreign_lexeme = database.ensure_lexeme("John")
    foreign_mention, _ = _insert_coreference_mention(
        database,
        foreign_lexeme,
        paragraph_id="P999",
        evidence_quote="John",
        source_form="John",
    )
    foreign_concept = "concept-foreign-john"
    _insert_test_concept(
        database,
        foreign_lexeme,
        foreign_concept,
        anchor_mention_id=foreign_mention,
    )
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "forged-anchor"},
    )
    forged = replace(
        case,
        concept_anchors=(
            v4_models.CoreferenceConceptAnchor(
                concept_id=foreign_concept,
                kind="person",
                canonical_source="John",
                status="provisional",
                role="primary",
                anchor_mention_id=foreign_mention,
            ),
        ),
    )
    coordinator = CoreferenceCoordinator(database)

    with pytest.raises(CoreferenceProtocolError, match="anchor.*lexeme"):
        coordinator._deterministic_relation(forged)
    with pytest.raises(CoreferenceProtocolError, match="anchor.*lexeme"):
        coordinator.resolve_deterministic(forged)


def test_deterministic_rejects_mention_anchor_missing_from_case_payload(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, case = _coreference_case(
        tmp_path
    )
    concept_id = "concept-unlisted-anchor"
    _insert_test_concept(
        database,
        lexeme_id,
        concept_id,
        anchor_mention_id=mention_ids[0],
    )
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "unlisted-anchor"},
    )
    forged_mentions = (
        replace(case.mentions[0], concept_anchor_ids=(concept_id,)),
        case.mentions[1],
    )
    forged = replace(case, mentions=forged_mentions, concept_anchors=())
    coordinator = CoreferenceCoordinator(database)

    with pytest.raises(CoreferenceProtocolError, match="not present"):
        coordinator._deterministic_relation(forged)
    with pytest.raises(CoreferenceProtocolError, match="not present"):
        coordinator.resolve_deterministic(forged)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("kind", "forged-kind"),
        ("canonical_source", "forged source"),
        ("status", "verified"),
        ("role", "alias"),
        ("evidence_id", 999999),
    ],
)
def test_deterministic_rejects_forged_anchor_metadata(
    tmp_path, field, value
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_id = "concept-anchor-metadata"
    _insert_test_concept(
        database,
        lexeme_id,
        concept_id,
        anchor_mention_id=mention_ids[0],
    )
    _bind_test_mention(database, mention_ids[0], concept_id)
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]
    forged_anchor = replace(
        case.concept_anchors[0],
        **{field: value},
    )
    forged = replace(case, concept_anchors=(forged_anchor,))

    with pytest.raises(CoreferenceProtocolError, match="anchor"):
        coordinator._deterministic_relation(forged)
    with pytest.raises(CoreferenceProtocolError, match="anchor"):
        coordinator.resolve_deterministic(forged)


def test_deterministic_locked_non_entity_subset_blocks_expanded_hash_merge(
    tmp_path,
):
    database, lexeme_id, mention_ids, evidence_ids, case = _coreference_case(
        tmp_path, count=3
    )
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "protected-non-entity"},
    )
    protected_set_id = stable_id("mention-set", str(mention_ids[1]))
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-human-non-entity-subset', ?, 'mention_set', ?,
                      'mention_set', ?, 'non_entity', 'human', 1.0, 1,
                      '[]', '[]', ?, 'human-non-entity-subset', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                lexeme_id,
                protected_set_id,
                protected_set_id,
                json.dumps([mention_ids[1]]),
                version,
            ),
        )

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        "non_entity",
        "locked_decision",
    )
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT relation, decision_source FROM coreference_decisions"
            )
        ] == [("non_entity", "human")]


def _multihop_redirect_case(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    retired_a = "concept-redirect-a"
    retired_b = "concept-redirect-b"
    canonical_c = "concept-redirect-c"
    _insert_test_concept(
        database,
        lexeme_id,
        retired_a,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    _insert_test_concept(
        database,
        lexeme_id,
        retired_b,
        retired=True,
    )
    _insert_test_concept(
        database,
        lexeme_id,
        canonical_c,
        anchor_mention_id=mention_ids[1],
    )
    _bind_test_mention(database, mention_ids[0], retired_a)
    _bind_test_mention(database, mention_ids[1], canonical_c)
    _insert_test_redirects(
        database,
        ((retired_a, retired_b), (retired_b, canonical_c)),
    )
    return database, lexeme_id, mention_ids, retired_a, canonical_c


def test_deterministic_multihop_redirect_reuses_final_active_canonical(tmp_path):
    database, lexeme_id, _, _, canonical_id = _multihop_redirect_case(tmp_path)
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    assert coordinator.resolve_deterministic(case) == ("same", "redirect")
    with closing(database.connect()) as connection:
        assert {
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions WHERE lexeme_id=?",
                (lexeme_id,),
            )
        } == {canonical_id}


def test_bind_mentions_normalizes_multihop_redirect_source_to_canonical(tmp_path):
    database, lexeme_id, mention_ids, retired_id, canonical_id = (
        _multihop_redirect_case(tmp_path)
    )

    assert database.bind_mentions(retired_id, mention_ids) == 1
    with closing(database.connect()) as connection:
        assert {
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions WHERE lexeme_id=?",
                (lexeme_id,),
            )
        } == {canonical_id}


def test_bind_mentions_canonicalizes_protected_redirect_anchors(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    retired_id = "concept-protected-retired"
    canonical_id = "concept-protected-canonical"
    different_id = "concept-protected-different"
    _insert_test_concept(
        database,
        lexeme_id,
        retired_id,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    _insert_test_concept(database, lexeme_id, canonical_id)
    _insert_test_concept(
        database,
        lexeme_id,
        different_id,
        anchor_mention_id=mention_ids[1],
    )
    _bind_test_mention(database, mention_ids[0], retired_id)
    _bind_test_mention(database, mention_ids[1], different_id)
    _insert_test_redirects(database, [(retired_id, canonical_id)])
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-protected-redirect', ?, 'concept', ?,
                      'concept', ?, 'different', 'human', 1.0, 1,
                      '[]', '[]', '[]', 'protected-redirect', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, retired_id, different_id, version),
        )

    assert database.bind_mentions(canonical_id, mention_ids) == 0
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == [retired_id, different_id]


@pytest.mark.parametrize("cycle", [False, True], ids=["dangling", "cycle"])
def test_deterministic_invalid_redirect_graph_is_conservative(tmp_path, cycle):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    retired_a = "concept-invalid-redirect-a"
    retired_b = "concept-invalid-redirect-b"
    _insert_test_concept(
        database,
        lexeme_id,
        retired_a,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    _insert_test_concept(
        database,
        lexeme_id,
        retired_b,
        anchor_mention_id=mention_ids[1],
        retired=True,
    )
    _bind_test_mention(database, mention_ids[0], retired_a)
    _bind_test_mention(database, mention_ids[1], retired_b)
    redirects = [(retired_a, retired_b)]
    if cycle:
        redirects.append((retired_b, retired_a))
    _insert_test_redirects(database, redirects)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "invalid-redirect-graph"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    assert coordinator._deterministic_relation(case) == (None, None)
    assert coordinator.resolve_deterministic(case) == (None, None)
    with pytest.raises(ValueError, match="canonical"):
        database.bind_mentions(retired_a, mention_ids)
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == [retired_a, retired_b]
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0


def test_deterministic_title_rule_requires_explicit_fingerprints(tmp_path):
    database = _db(tmp_path, source_text="II The Fleshing")
    lexeme_id = database.ensure_lexeme("The Fleshing")
    with database.transaction() as connection:
        edition_id = connection.execute(
            "SELECT id FROM source_editions WHERE active=1"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO blocks(
                   id, legacy_id, source_edition_id, chapter_id, chapter_title,
                   chapter_index, block_index, global_index, block_type,
                   source_text, source_hash, token_count, status, updated_at)
               VALUES('block-title-no-fingerprint', 'block-title-no-fingerprint',
                      ?, 'toc', 'Contents', 0, 1, 1, 'toc',
                      'II The Fleshing', 'hash-title-no-fingerprint', 3,
                      'ready', '2000-01-01T00:00:00+00:00')""",
            (edition_id,),
        )
    for paragraph_id, block_id in (
        ("P001", "block-title-no-fingerprint"),
        ("P002", "block-1"),
    ):
        _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=paragraph_id,
            evidence_quote="II The Fleshing",
            kind="title",
            source_form="The Fleshing",
            block_id=block_id,
        )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        None,
        None,
    )


def test_deterministic_title_fingerprints_require_exact_payload_equality(tmp_path):
    database = _db(tmp_path, source_text="The Fleshing")
    lexeme_id = database.ensure_lexeme("The Fleshing")
    with database.transaction() as connection:
        edition_id = connection.execute(
            "SELECT id FROM source_editions WHERE active=1"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO blocks(
                   id, legacy_id, source_edition_id, chapter_id, chapter_title,
                   chapter_index, block_index, global_index, block_type,
                   source_text, source_hash, token_count, status, updated_at)
               VALUES('block-title-exact', 'block-title-exact', ?, 'toc',
                      'Contents', 0, 1, 1, 'toc', 'The Fleshing',
                      'hash-title-exact', 2, 'ready',
                      '2000-01-01T00:00:00+00:00')""",
            (edition_id,),
        )
    evidence_ids = []
    for paragraph_id, block_id in (
        ("P001", "block-title-exact"),
        ("P002", "block-1"),
    ):
        _, evidence_id = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=paragraph_id,
            evidence_quote="The Fleshing",
            kind="title",
            source_form="The Fleshing",
            block_id=block_id,
        )
        evidence_ids.append(evidence_id)
    with database.transaction() as connection:
        for evidence_id, fingerprint in zip(
            evidence_ids, ("Title-Key", "title-key")
        ):
            connection.execute(
                "UPDATE evidence SET payload_json=? WHERE id=?",
                (json.dumps({"title_fingerprint": fingerprint}), evidence_id),
            )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    assert CoreferenceCoordinator(database).resolve_deterministic(case) == (
        None,
        None,
    )


def test_deterministic_conflicting_active_anchors_ignore_prior_automatic_same(
    tmp_path,
):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    left_id = "concept-conflict-prior-left"
    right_id = "concept-conflict-prior-right"
    for concept_id, mention_id in zip((left_id, right_id), mention_ids):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
            kind="place",
        )
        _bind_test_mention(database, mention_id, concept_id)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-prior-automatic-same', ?, 'concept', ?,
                      'mention_set', ?, 'same', 'deterministic', 1.0, 0,
                      '[{"source":"deterministic","rule":"same_anchor_or_duplicate_subset"}]',
                      ?, ?, 'prior-automatic-same', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (
                lexeme_id,
                left_id,
                stable_id(
                    "mention-set",
                    ":".join(sorted(str(value) for value in mention_ids)),
                ),
                json.dumps(sorted(evidence_ids)),
                json.dumps(sorted(mention_ids)),
                version,
            ),
        )
    case = CoreferenceCoordinator(database).freeze_cases()[0]

    coordinator = CoreferenceCoordinator(database)
    assert coordinator._deterministic_relation(case) == (None, None)
    assert coordinator.resolve_deterministic(case) == (None, None)
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == [left_id, right_id]
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 0


def test_deterministic_validates_frozen_mention_identity_before_replay(tmp_path):
    database, lexeme_id, _, evidence_ids, _ = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"start_offset": 0, "end_offset": 5},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]
    assert coordinator.resolve_deterministic(case) == ("same", "same_span")
    forged = replace(
        case,
        mentions=(
            replace(case.mentions[0], evidence_id=evidence_ids[1]),
            case.mentions[1],
        ),
    )

    with pytest.raises(CoreferenceProtocolError, match="mention.*evidence"):
        coordinator._deterministic_relation(forged)
    with pytest.raises(CoreferenceProtocolError, match="mention.*evidence"):
        coordinator.resolve_deterministic(forged)
    assert case.mentions[0].lexeme_id == lexeme_id
    assert (case.mentions[0].start_offset, case.mentions[0].end_offset) == (0, 5)
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 1


def test_deterministic_anchor_selection_ignores_case_mention_order(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, case = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "order-independent-anchor"},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    reversed_case = replace(case, mentions=tuple(reversed(case.mentions)))

    assert CoreferenceCoordinator(database).resolve_deterministic(
        reversed_case
    ) == ("same", "same_evidence_hash_retry")
    expected = stable_id("concept", f"{lexeme_id}:{mention_ids[0]}")
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT concept_id FROM mentions ORDER BY concept_id"
            )
        ] == [expected]
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1


def test_deterministic_protected_redirect_identity_blocks_same(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    retired_id = "concept-protected-source"
    canonical_id = "concept-protected-target"
    _insert_test_concept(
        database,
        lexeme_id,
        retired_id,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    _insert_test_concept(database, lexeme_id, canonical_id)
    _bind_test_mention(database, mention_ids[0], retired_id)
    _insert_test_redirects(database, [(retired_id, canonical_id)])
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        connection.execute(
            """INSERT INTO coreference_decisions(
                   id, lexeme_id, left_anchor_type, left_anchor_id,
                   right_anchor_type, right_anchor_id, relation,
                   decision_source, confidence, locked, votes_json,
                   evidence_ids_json, anchor_members_json, payload_hash,
                   created_version, created_at)
               VALUES('coref-protected-source-target', ?, 'concept', ?,
                      'concept', ?, 'different', 'human', 1.0, 1,
                      '[]', '[]', '[]', 'protected-source-target', ?,
                      '2000-01-01T00:00:00+00:00')""",
            (lexeme_id, retired_id, canonical_id, version),
        )
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "protected-redirect-same"},
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    case = replace(
        case,
        concept_anchors=(),
        mentions=tuple(
            replace(mention, concept_anchor_ids=())
            for mention in case.mentions
        ),
    )

    coordinator = CoreferenceCoordinator(database)
    assert coordinator.resolve_deterministic(case) == (
        "different",
        "locked_decision",
    )
    assert database.bind_mentions(canonical_id, mention_ids) == 0
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == [retired_id, None]
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 0


def test_deterministic_cross_lexeme_redirect_is_conservative(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    retired_id = "concept-cross-lexeme-source"
    _insert_test_concept(
        database,
        lexeme_id,
        retired_id,
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    _bind_test_mention(database, mention_ids[0], retired_id)
    foreign_lexeme_id = database.ensure_lexeme("John")
    foreign_id = "concept-cross-lexeme-target"
    _insert_test_concept(database, foreign_lexeme_id, foreign_id)
    _insert_test_redirects(database, [(retired_id, foreign_id)])
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "cross-lexeme-redirect"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    assert coordinator._deterministic_relation(case) == (None, None)
    assert coordinator.resolve_deterministic(case) == (None, None)
    with pytest.raises(ValueError, match="canonical|lexeme"):
        database.bind_mentions(retired_id, mention_ids)
    with closing(database.connect()) as connection:
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == [retired_id, None]
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 0


def test_deterministic_cannot_hide_persisted_mention_anchor_owners(tmp_path):
    database, lexeme_id, mention_ids, evidence_ids, _ = _coreference_case(tmp_path)
    owners = ("concept-owner-left", "concept-owner-right")
    for concept_id, mention_id in zip(owners, mention_ids):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
            kind="place",
        )
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "hidden-persisted-anchor-owners"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]
    hidden = replace(
        case,
        concept_anchors=(),
        mentions=tuple(
            replace(mention, concept_anchor_ids=())
            for mention in case.mentions
        ),
    )

    assert coordinator._deterministic_relation(hidden) == (None, None)
    assert coordinator.resolve_deterministic(hidden) == (None, None)
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concepts"
        ).fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 0


def test_bind_mentions_rejects_another_active_concepts_immutable_anchor(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_a = database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])
    assert database.bind_mentions(concept_a, [mention_ids[0]]) == 1
    concept_b = database.ensure_concept_for_anchor(lexeme_id, mention_ids[1])

    with pytest.raises(ValueError, match="immutable|anchor"):
        database.bind_mentions(concept_b, [mention_ids[0]])

    assert database.ensure_concept_for_anchor(
        lexeme_id, mention_ids[0]
    ) == concept_a
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT concept_id FROM mentions WHERE id=?",
            (mention_ids[0],),
        ).fetchone()[0] == concept_a
        assert connection.execute(
            """SELECT anchor_mention_id FROM concepts
               WHERE id=?""",
            (concept_a,),
        ).fetchone()[0] == mention_ids[0]
        assert connection.execute(
            """SELECT anchor_mention_id FROM concepts
               WHERE id=?""",
            (concept_b,),
        ).fetchone()[0] == mention_ids[1]


def test_freeze_cases_batches_span_queries_before_mention_cap(
    tmp_path, monkeypatch
):
    database = _db(tmp_path, source_text="Briah " * 60)
    lexeme_id = database.ensure_lexeme("Briah")
    mention_ids = []
    for index in range(50):
        mention_id, _ = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=f"P{index + 1:03d}",
            evidence_quote=f"Briah context {index}",
            kind="person" if index % 2 == 0 else "place",
        )
        mention_ids.append(mention_id)

    statements = []
    real_connect = database.connect

    def traced_connect():
        connection = real_connect()
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(database, "connect", traced_connect)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    span_selects = [
        statement
        for statement in statements
        if statement.lstrip().casefold().startswith("select")
        and (
            "from candidate_resolutions" in statement.casefold()
            or "from form_occurrences" in statement.casefold()
        )
    ]

    assert len(case.mentions) == coreference_module.MAX_CASE_MENTIONS
    assert mention_ids[0] in {item.mention_id for item in case.mentions}
    assert mention_ids[-1] in {item.mention_id for item in case.mentions}
    assert len(span_selects) <= 2


def test_deterministic_uses_persisted_evidence_anchor_owners(tmp_path):
    database, lexeme_id, _, evidence_ids, _ = _coreference_case(tmp_path)
    owners = ("concept-evidence-left", "concept-evidence-right")
    for concept_id, evidence_id in zip(owners, evidence_ids):
        _insert_test_concept(database, lexeme_id, concept_id, kind="place")
        with database.transaction() as connection:
            connection.execute(
                """UPDATE concept_lexemes SET evidence_id=?
                   WHERE concept_id=? AND lexeme_id=?
                     AND retired_version IS NULL""",
                (evidence_id, concept_id, lexeme_id),
            )
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "hidden-evidence-anchor-owners"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]
    hidden = replace(
        case,
        concept_anchors=(),
        mentions=tuple(
            replace(mention, concept_anchor_ids=())
            for mention in case.mentions
        ),
    )

    assert coordinator._deterministic_relation(hidden) == (None, None)
    assert coordinator.resolve_deterministic(hidden) == (None, None)


def test_deterministic_ignores_unrelated_global_same_lexeme_anchors(tmp_path):
    database, lexeme_id, _, evidence_ids, _ = _coreference_case(tmp_path)
    _insert_test_concept(database, lexeme_id, "concept-unrelated-left")
    _insert_test_concept(database, lexeme_id, "concept-unrelated-right")
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "unrelated-global-anchors"},
    )
    coordinator = CoreferenceCoordinator(database)
    case = coordinator.freeze_cases()[0]

    assert len(case.concept_anchors) == 2
    assert coordinator._deterministic_relation(case) == (
        "same",
        "same_evidence_hash_retry",
    )


def test_repeated_anchor_ensure_rejects_disagreeing_mention_binding(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    owner = database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])
    conflicting = database.ensure_concept_for_anchor(lexeme_id, mention_ids[1])
    _bind_test_mention(database, mention_ids[0], conflicting)

    with pytest.raises(RuntimeError, match="binding|immutable|owner"):
        database.ensure_concept_for_anchor(lexeme_id, mention_ids[0])

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT concept_id FROM mentions WHERE id=?", (mention_ids[0],)
        ).fetchone()[0] == conflicting
        assert connection.execute(
            "SELECT anchor_mention_id FROM concepts WHERE id=?", (owner,)
        ).fetchone()[0] == mention_ids[0]


class _DualModelClient:
    def __init__(self, model, responses):
        self.model = model
        self.responses = iter(responses)
        self.calls = []

    def get_model(self, purpose):
        assert purpose == "coreference"
        return self.model

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        response = next(self.responses)
        if isinstance(response, BaseException):
            raise response
        return response


class _ExplosiveText:
    def __str__(self):
        raise TypeError("malicious __str__")

    def __repr__(self):
        raise TypeError("malicious __repr__")


class _ExplosiveError(Exception):
    def __str__(self):
        raise TypeError("malicious exception __str__")

    def __repr__(self):
        raise TypeError("malicious exception __repr__")


def _dual_model_response(case, relation, *, rationale=None):
    return json.dumps(
        {
            "votes": [
                {
                    "case_id": case.case_id,
                    "relation": relation,
                    "mention_ids": [
                        mention.request_id for mention in case.mentions
                    ],
                    "confidence": 0.9,
                    "rationale": rationale or f"vote-{relation}",
                }
            ]
        }
    )


def _dual_model_factory(model, responses, instances):
    def build():
        client = _DualModelClient(model, responses)
        instances.append(client)
        return client

    return build


def _dual_model_coordinator(database, case, left, right, *, max_attempts=2):
    clients_a = []
    clients_b = []
    coordinator = CoreferenceCoordinator(
        database,
        llm_factory_a=_dual_model_factory("model-a", left, clients_a),
        llm_factory_b=_dual_model_factory("model-b", right, clients_b),
        max_attempts=max_attempts,
    )
    return coordinator, clients_a, clients_b


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("same", "same", "same"),
        ("different", "different", "different"),
        ("non_entity", "non_entity", "non_entity"),
        ("uncertain", "uncertain", "uncertain"),
        ("same", "different", "uncertain"),
        ("same", "uncertain", "uncertain"),
    ],
)
def test_dual_model_relation_matrix_is_conservative(
    tmp_path, left, right, expected
):
    database, lexeme_id, mention_ids, _, case = _coreference_case(tmp_path)
    coordinator, clients_a, clients_b = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, left)],
        [_dual_model_response(case, right)],
    )

    relation, reason = coordinator.resolve_dual_model(case)

    assert relation == expected
    assert reason in {"model_agreement", "model_conflict", "model_uncertain"}
    assert len(clients_a) == len(clients_b) == 1
    assert len(clients_a[0].calls) == len(clients_b[0].calls) == 1
    with closing(database.connect()) as connection:
        decision = connection.execute(
            """SELECT relation, decision_source, locked, votes_json
               FROM coreference_decisions"""
        ).fetchone()
        concepts = connection.execute("SELECT id FROM concepts").fetchall()
        bindings = connection.execute(
            "SELECT concept_id FROM mentions ORDER BY id"
        ).fetchall()
        audits = connection.execute(
            """SELECT model, accepted, attempts, error
               FROM audit_calls WHERE purpose='dual_model_coreference'
               ORDER BY id"""
        ).fetchall()
        blocking = connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE severity='blocking'"
        ).fetchone()[0]
    assert tuple(decision)[:3] == (expected, "dual_model", 0)
    assert len(json.loads(decision["votes_json"])) >= 2
    assert [tuple(row)[:2] for row in audits] == [
        ("model-a", 1),
        ("model-b", 1),
    ]
    assert blocking == 0
    if expected == "same":
        assert len(concepts) == 1
        assert {row[0] for row in bindings} == {concepts[0][0]}
        assert concepts[0][0] == stable_id(
            "concept", f"{lexeme_id}:{mention_ids[0]}"
        )
    else:
        assert concepts == []
        assert [row[0] for row in bindings] == [None, None]


@pytest.mark.parametrize("both_fail", [False, True])
def test_dual_model_protocol_failure_retries_and_finishes_nonblocking(
    tmp_path, both_fail
):
    database, _, _, _, case = _coreference_case(tmp_path)
    failures = ["not-json", json.dumps({"votes": []})]
    right = failures if both_fail else [_dual_model_response(case, "same")]
    coordinator, clients_a, clients_b = _dual_model_coordinator(
        database, case, failures, right, max_attempts=2
    )

    assert coordinator.resolve_dual_model(case) == (
        "uncertain",
        "model_protocol_failure",
    )

    assert len(clients_a[0].calls) == 2
    assert len(clients_b[0].calls) == (2 if both_fail else 1)
    with closing(database.connect()) as connection:
        decision = connection.execute(
            "SELECT relation, votes_json FROM coreference_decisions"
        ).fetchone()
        audits = connection.execute(
            """SELECT model, accepted, attempts, raw_response, error
               FROM audit_calls WHERE purpose='dual_model_coreference'
               ORDER BY id"""
        ).fetchall()
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE severity='blocking'"
        ).fetchone()[0] == 0
        lexeme_target = connection.execute(
            """SELECT default_target, working_target FROM lexemes
               WHERE id=?""",
            (case.lexeme_id,),
        ).fetchone()
        fallback_audit = connection.execute(
            """SELECT parsed_json FROM audit_calls
               WHERE purpose='coreference_fallback'"""
        ).fetchone()
    votes = json.loads(decision["votes_json"])
    assert decision["relation"] == "uncertain"
    assert any(vote.get("reason") == "model_protocol_failure" for vote in votes)
    assert len(audits) == (4 if both_fail else 3)
    assert tuple(lexeme_target) == ("", "")
    assert json.loads(fallback_audit[0])["reason"] == "no_candidate"
    assert [row["attempts"] for row in audits if row["model"] == "model-a"] == [
        1,
        2,
    ]
    assert all(row["accepted"] == 0 for row in audits if row["model"] == "model-a")


@pytest.mark.parametrize(
    "bad_response",
    [
        {"votes": [{"not_json_serializable": object()}]},
        _ExplosiveText(),
        _ExplosiveError(),
    ],
    ids=["unserializable-mapping", "malicious-text", "malicious-error"],
)
def test_dual_model_unserializable_responses_are_bounded_protocol_failures(
    tmp_path, bad_response
):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator, clients_a, clients_b = _dual_model_coordinator(
        database,
        case,
        [bad_response, bad_response],
        [bad_response, bad_response],
        max_attempts=2,
    )

    assert coordinator.resolve_dual_model(case) == (
        "uncertain",
        "model_protocol_failure",
    )
    assert len(clients_a[0].calls) == len(clients_b[0].calls) == 2
    with closing(database.connect()) as connection:
        audits = connection.execute(
            """SELECT model, raw_response, parsed_json, error
               FROM audit_calls WHERE purpose='dual_model_coreference'
               ORDER BY id"""
        ).fetchall()
        decision = connection.execute(
            """SELECT relation, decision_source, votes_json
               FROM coreference_decisions"""
        ).fetchone()
    assert len(audits) == 4
    assert all(len(row["raw_response"]) <= 512 for row in audits)
    assert all(len(row["error"] or "") <= 2_000 for row in audits)
    terminal = [json.loads(row["parsed_json"]) for row in audits[1::2]]
    assert all(item["reason"] == "model_protocol_failure" for item in terminal)
    assert tuple(decision)[:2] == ("uncertain", "dual_model")
    assert any(
        vote.get("reason") == "model_protocol_failure"
        for vote in json.loads(decision["votes_json"])
    )


def test_dual_model_payloads_are_isolated_and_cached_without_recalling(tmp_path):
    database, _, _, _, case = _coreference_case(tmp_path)
    response_a = _dual_model_response(case, "different", rationale="A-SECRET")
    response_b = _dual_model_response(case, "different", rationale="B-SECRET")
    coordinator, clients_a, clients_b = _dual_model_coordinator(
        database, case, [response_a], [response_b]
    )

    first = coordinator.resolve_dual_model(case)
    frozen = coordinator.payload_bytes(case).decode("utf-8")

    assert first == ("different", "model_agreement")
    prompt_a = clients_a[0].calls[0]["messages"][-1]["content"]
    prompt_b = clients_b[0].calls[0]["messages"][-1]["content"]
    assert prompt_a == prompt_b == frozen
    assert "A-SECRET" not in prompt_b
    assert "B-SECRET" not in prompt_a

    cached_a = []
    cached_b = []
    cached = CoreferenceCoordinator(
        database,
        llm_factory_a=_dual_model_factory(
            "model-a", [AssertionError("must not call A")], cached_a
        ),
        llm_factory_b=_dual_model_factory(
            "model-b", [AssertionError("must not call B")], cached_b
        ),
        max_attempts=2,
    )
    assert cached.resolve_dual_model(case) == first
    assert cached_a and cached_b
    assert cached_a[0].calls == cached_b[0].calls == []
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='dual_model_coreference'"""
        ).fetchone()[0] == 2


def test_dual_model_same_cache_does_not_turn_into_a_deterministic_replay(tmp_path):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )
    first = coordinator.resolve_dual_model(case)
    cached_a = []
    cached_b = []
    cached = CoreferenceCoordinator(
        database,
        llm_factory_a=_dual_model_factory(
            "model-a", [AssertionError("must not call A")], cached_a
        ),
        llm_factory_b=_dual_model_factory(
            "model-b", [AssertionError("must not call B")], cached_b
        ),
    )

    assert cached.resolve_dual_model(case) == first
    assert cached_a[0].calls == cached_b[0].calls == []
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='deterministic_coreference'"""
        ).fetchone()[0] == 0


def test_dual_model_locked_decision_wins_without_model_calls(tmp_path):
    database, lexeme_id, mention_ids, _, case = _coreference_case(tmp_path)
    left_id = "concept-human-left"
    right_id = "concept-human-right"
    _insert_test_concept(database, lexeme_id, left_id)
    _insert_test_concept(database, lexeme_id, right_id)
    _insert_locked_coreference_decision(
        database, lexeme_id, mention_ids, left_id, right_id
    )
    coordinator, clients_a, clients_b = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    assert coordinator.resolve_dual_model(case) == ("different", "locked_decision")
    assert clients_a == clients_b == []
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1


def test_dual_model_same_merges_multiple_active_anchors_through_redirect(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-left", "concept-right")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database, lexeme_id, concept_id, anchor_mention_id=mention_id
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    assert coordinator.resolve_dual_model(case) == ("same", "model_agreement")
    with closing(database.connect()) as connection:
        decision = connection.execute(
            """SELECT id, relation, votes_json FROM coreference_decisions
               WHERE decision_source='dual_model'"""
        ).fetchone()
        redirects = connection.execute(
            """SELECT retired_concept_id, canonical_concept_id
               FROM concept_redirects"""
        ).fetchall()
        bindings = connection.execute(
            "SELECT concept_id FROM mentions ORDER BY id"
        ).fetchall()
    assert decision["relation"] == "same"
    assert len(redirects) == 1
    canonical_id = redirects[0]["canonical_concept_id"]
    assert {row[0] for row in bindings} == {canonical_id}
    dual_vote = next(
        vote
        for vote in json.loads(decision["votes_json"])
        if vote.get("source") == "dual_model"
    )
    assert dual_vote["authorized_concept_ids"] == sorted(concept_ids)
    assert dual_vote["effect"] == {
        "bindings_changed": 1,
        "unified_identity": True,
    }
    assert database.resolve_concept_id(redirects[0]["retired_concept_id"]) == canonical_id


def test_dual_model_fallback_priority_and_unicode_tie_are_audited(tmp_path):
    database, lexeme_id, _, _, case = _coreference_case(tmp_path)
    candidates = [
        ("concept-unicode-high", "甲", False, "provisional"),
        ("concept-unicode-low", "乙", False, "provisional"),
        ("concept-verified", "验证名", False, "verified"),
        ("concept-locked", "锁定名", True, "provisional"),
    ]
    for concept_id, target, locked, status in candidates:
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            locked=locked,
            status=status,
        )
        with database.transaction() as connection:
            connection.execute(
                """UPDATE concepts SET default_target=?, working_target=?,
                          verified_target=CASE WHEN status='verified' THEN ? ELSE '' END
                   WHERE id=?""",
                (target, target, target, concept_id),
            )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "uncertain")],
        [_dual_model_response(case, "same")],
    )

    assert coordinator.resolve_dual_model(case) == (
        "uncertain",
        "model_uncertain",
    )

    with closing(database.connect()) as connection:
        lexeme = connection.execute(
            "SELECT default_target, working_target FROM lexemes WHERE id=?",
            (lexeme_id,),
        ).fetchone()
        decision = connection.execute(
            "SELECT votes_json FROM coreference_decisions"
        ).fetchone()
        fallback_audit = connection.execute(
            """SELECT parsed_json FROM audit_calls
               WHERE purpose='coreference_fallback'"""
        ).fetchone()
    assert tuple(lexeme) == ("锁定名", "锁定名")
    votes = json.loads(decision["votes_json"])
    fallback = next(vote for vote in votes if vote.get("source") == "fallback")
    assert fallback["selected"] == "锁定名"
    assert fallback["reason"] == "locked"
    unicode_rows = {
        row["target"]: row for row in fallback["candidates"]
        if row["target"] in {"甲", "乙"}
    }
    assert set(unicode_rows) == {"甲", "乙"}
    assert json.loads(fallback_audit[0])["selected"] == "锁定名"


def test_dual_model_fallback_unicode_order_is_nonblocking(tmp_path):
    database, lexeme_id, _, _, case = _coreference_case(tmp_path)
    for concept_id, target in (("concept-u1", "甲"), ("concept-u2", "乙")):
        _insert_test_concept(database, lexeme_id, concept_id)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE concepts SET default_target=? WHERE id=?",
                (target, concept_id),
            )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "uncertain")],
        [_dual_model_response(case, "uncertain")],
    )
    assert coordinator.resolve_dual_model(case)[0] == "uncertain"
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT working_target FROM lexemes WHERE id=?", (lexeme_id,)
        ).fetchone()[0] == "乙"
        assert connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE severity='blocking'"
        ).fetchone()[0] == 0


def _dual_model_fallback_block_votes(tmp_path):
    database = _db(tmp_path, source_text="Briah")
    edition_id = database.active_source_edition_id()
    database.upsert_blocks(
        edition_id,
        [
            {
                "id": f"block-{index}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index - 1,
                "global_index": index - 1,
                "block_type": "prose",
                "source_text": "Briah",
                "source_hash": f"hash-{index}",
                "token_count": 1,
                "status": "ready",
            }
            for index in (2, 3)
        ],
    )
    lexeme_id = database.ensure_lexeme("Briah")
    mention_ids = []
    for index in (1, 2, 3):
        mention_id, _ = _insert_coreference_mention(
            database,
            lexeme_id,
            paragraph_id=f"P{index:03d}",
            evidence_quote="Briah",
            block_id=f"block-{index}",
        )
        mention_ids.append(mention_id)
    for concept_id, target in (
        ("concept-majority", "多数名"),
        ("concept-minority", "少数名"),
    ):
        _insert_test_concept(database, lexeme_id, concept_id)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE concepts SET default_target=? WHERE id=?",
                (target, concept_id),
            )
    for mention_id in mention_ids[:2]:
        _bind_test_mention(database, mention_id, "concept-majority")
    _bind_test_mention(database, mention_ids[2], "concept-minority")
    return database, lexeme_id, tuple(mention_ids)


def test_dual_model_fallback_existing_consistency_precedes_block_majority(tmp_path):
    database, lexeme_id, mention_ids = _dual_model_fallback_block_votes(tmp_path)
    _insert_test_concept(database, lexeme_id, "concept-consistent")
    with database.transaction() as connection:
        connection.execute(
            """UPDATE concepts SET default_target='一致名', working_target='一致名'
               WHERE id='concept-consistent'"""
        )

    result = database.apply_coreference_fallback(lexeme_id, mention_ids)

    assert result["selected"] == "一致名"
    assert result["reason"] == "existing_consistent"
    majority = next(
        row for row in result["candidates"] if row["target"] == "多数名"
    )
    assert majority["block_votes"] == 2
    assert majority["consistent"] is False


def test_dual_model_fallback_verified_precedes_consistency(tmp_path):
    database, lexeme_id, mention_ids = _dual_model_fallback_block_votes(tmp_path)
    _insert_test_concept(database, lexeme_id, "concept-consistent")
    _insert_test_concept(
        database,
        lexeme_id,
        "concept-verified-choice",
        status="verified",
    )
    with database.transaction() as connection:
        connection.execute(
            """UPDATE concepts SET default_target='一致名', working_target='一致名'
               WHERE id='concept-consistent'"""
        )
        connection.execute(
            """UPDATE concepts SET verified_target='验证名'
               WHERE id='concept-verified-choice'"""
        )

    result = database.apply_coreference_fallback(lexeme_id, mention_ids)

    assert result["selected"] == "验证名"
    assert result["reason"] == "verified"


@pytest.mark.parametrize("owner", ["lexeme", "concept"])
def test_dual_model_fallback_only_verified_target_marks_verified(
    tmp_path, owner
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    if owner == "lexeme":
        with database.transaction() as connection:
            connection.execute(
                """UPDATE lexemes SET status='verified', default_target='old',
                          working_target='old', verified_target='verified'
                   WHERE id=?""",
                (lexeme_id,),
            )
    else:
        _insert_test_concept(
            database, lexeme_id, "concept-status-verified", status="verified"
        )
        with database.transaction() as connection:
            connection.execute(
                """UPDATE concepts SET default_target='old', working_target='old',
                          verified_target='verified'
                   WHERE id='concept-status-verified'"""
            )

    result = database.apply_coreference_fallback(lexeme_id, mention_ids)

    assert result["selected"] == "verified"
    assert result["reason"] == "verified"
    by_target = {item["target"]: item for item in result["candidates"]}
    assert by_target["old"]["verified"] is False
    assert by_target["verified"]["verified"] is True


def test_dual_model_fallback_block_majority_precedes_unicode_order(tmp_path):
    database, lexeme_id, mention_ids = _dual_model_fallback_block_votes(tmp_path)

    result = database.apply_coreference_fallback(lexeme_id, mention_ids)

    assert result["selected"] == "多数名"
    assert result["reason"] == "affected_block_majority"


def test_dual_model_fallback_rejects_cross_lexeme_mentions_atomically(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    john_lexeme_id = database.ensure_lexeme("John")
    john_mention_id, _ = _insert_coreference_mention(
        database,
        john_lexeme_id,
        paragraph_id="P099",
        evidence_quote="John",
        source_form="John",
    )
    with database.transaction() as connection:
        connection.execute(
            """UPDATE lexemes SET default_target='保留', working_target='保留'
               WHERE id=?""",
            (lexeme_id,),
        )
    with closing(database.connect()) as connection:
        audits_before = connection.execute(
            "SELECT COUNT(*) FROM audit_calls"
        ).fetchone()[0]

    with pytest.raises(ValueError, match="lexeme|mention"):
        database.apply_coreference_fallback(
            lexeme_id,
            [mention_ids[0], john_mention_id, mention_ids[0]],
        )

    with closing(database.connect()) as connection:
        target = connection.execute(
            """SELECT default_target, working_target FROM lexemes
               WHERE id=?""",
            (lexeme_id,),
        ).fetchone()
        audits_after = connection.execute(
            "SELECT COUNT(*) FROM audit_calls"
        ).fetchone()[0]
    assert tuple(target) == ("保留", "保留")
    assert audits_after == audits_before


def test_dual_model_fallback_keeps_large_candidate_evidence_bounded(tmp_path):
    database, lexeme_id, _, _, _ = _coreference_case(tmp_path)
    with database.transaction() as connection:
        version = connection.execute(
            "SELECT MAX(id) FROM knowledge_versions"
        ).fetchone()[0]
        for index in range(2_000):
            concept_id = f"concept-scale-{index:04d}"
            target = "WINNER" if index < 40 else f"候选-{index:04d}"
            connection.execute(
                """INSERT INTO concepts(
                       id, kind, canonical_source, default_target,
                       primary_lexeme_id, created_version, created_at)
                   VALUES(?, 'person', ?, ?, ?, ?,
                          '2000-01-01T00:00:00+00:00')""",
                (concept_id, concept_id, target, lexeme_id, version),
            )
            connection.execute(
                """INSERT INTO concept_lexemes(
                       concept_id, lexeme_id, role, confidence, status,
                       created_version, created_at)
                   VALUES(?, ?, 'primary', 1.0, 'provisional', ?,
                          '2000-01-01T00:00:00+00:00')""",
                (concept_id, lexeme_id, version),
            )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "uncertain")],
        [_dual_model_response(case, "uncertain")],
    )

    assert coordinator.resolve_dual_model(case)[0] == "uncertain"

    with closing(database.connect()) as connection:
        target = connection.execute(
            "SELECT working_target FROM lexemes WHERE id=?", (lexeme_id,)
        ).fetchone()[0]
        decision = connection.execute(
            """SELECT votes_json, LENGTH(CAST(votes_json AS BLOB)) AS bytes
               FROM coreference_decisions"""
        ).fetchone()
        fallback_audit = connection.execute(
            """SELECT parsed_json, LENGTH(CAST(parsed_json AS BLOB)) AS bytes
               FROM audit_calls WHERE purpose='coreference_fallback'"""
        ).fetchone()
        blocking = connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE severity='blocking'"
        ).fetchone()[0]
    votes = json.loads(decision["votes_json"])
    fallback = next(vote for vote in votes if vote.get("source") == "fallback")
    compact_audit = json.loads(fallback_audit["parsed_json"])
    assert target == fallback["selected"] == "WINNER"
    assert fallback["reason"] == "existing_consistent"
    assert fallback["total_candidates"] == 1_961
    assert fallback["omitted_candidates"] > 0
    assert len(fallback["candidates"]) <= 32
    assert max(len(item["sources"]) for item in fallback["candidates"]) <= 16
    assert fallback["payload_hash"]
    assert fallback["selected_block_votes"] == 0
    assert decision["bytes"] <= 64 * 1024
    assert fallback_audit["bytes"] <= 8 * 1024
    assert "candidates" not in compact_audit
    assert compact_audit["payload_hash"] == fallback["payload_hash"]
    assert blocking == 0


def test_dual_model_run_summary_is_exact_and_honors_max_cases(tmp_path):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator, clients_a, clients_b = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "different")],
        [_dual_model_response(case, "different")],
    )

    summary = coordinator.run(max_cases=1)

    assert summary == {
        "cases": 1,
        "deterministic_merges": 0,
        "model_merges": 0,
        "different": 1,
        "non_entity": 0,
        "uncertain": 0,
        "protocol_failures": 0,
        "fallbacks": 0,
        "change_ids": [],
    }
    assert len(clients_a[0].calls) == len(clients_b[0].calls) == 1


def test_dual_model_run_counts_only_an_actual_safe_single_anchor_binding(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_id = "concept-single-anchor"
    _insert_test_concept(
        database,
        lexeme_id,
        concept_id,
        anchor_mention_id=mention_ids[0],
    )
    _bind_test_mention(database, mention_ids[0], concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    summary = coordinator.run(max_cases=1)

    assert summary["model_merges"] == 1
    with closing(database.connect()) as connection:
        assert {
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        } == {concept_id}


def test_dual_model_run_counts_fresh_multi_anchor_redirect_merge(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-run-left", "concept-run-right")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database, lexeme_id, concept_id, anchor_mention_id=mention_id
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    summary = coordinator.run(max_cases=1)

    assert summary["model_merges"] == 1
    assert summary["deterministic_merges"] == 0
    with closing(database.connect()) as connection:
        bindings = [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ]
        assert len(set(bindings)) == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 1


def test_dual_model_run_cached_same_reports_zero_changes(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-cache-left", "concept-cache-right")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database, lexeme_id, concept_id, anchor_mention_id=mention_id
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    first, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )
    assert first.resolve_dual_model(case) == ("same", "model_agreement")
    cached_a = []
    cached_b = []
    cached = CoreferenceCoordinator(
        database,
        llm_factory_a=_dual_model_factory(
            "model-a", [AssertionError("must not call A")], cached_a
        ),
        llm_factory_b=_dual_model_factory(
            "model-b", [AssertionError("must not call B")], cached_b
        ),
    )

    summary = cached.run(max_cases=1)

    assert summary["model_merges"] == 0
    assert cached_a[0].calls == cached_b[0].calls == []


def test_dual_model_cached_same_compensates_a_previously_unfinished_redirect_merge(
    tmp_path, monkeypatch
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-cache-unfinished-left", "concept-cache-unfinished-right")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database, lexeme_id, concept_id, anchor_mention_id=mention_id
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    first, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )
    merge_concepts = database.merge_concepts

    def protected_once(*_args, **_kwargs):
        raise ConceptMergeConflictError("temporarily protected")

    monkeypatch.setattr(database, "merge_concepts", protected_once)
    assert first.resolve_dual_model(case) == ("same", "model_agreement")
    monkeypatch.setattr(database, "merge_concepts", merge_concepts)
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT id, votes_json FROM coreference_decisions"
        ).fetchone()
        legacy_votes = json.loads(row["votes_json"])
        for vote in legacy_votes:
            if vote.get("source") == "dual_model":
                vote.pop("authorized_concept_ids", None)
        connection.execute(
            "UPDATE coreference_decisions SET votes_json=? WHERE id=?",
            (json.dumps(legacy_votes, sort_keys=True), row["id"]),
        )
    cached_a = []
    cached_b = []
    cached = CoreferenceCoordinator(
        database,
        llm_factory_a=_dual_model_factory(
            "model-a", [AssertionError("must not call A")], cached_a
        ),
        llm_factory_b=_dual_model_factory(
            "model-b", [AssertionError("must not call B")], cached_b
        ),
    )

    summary = cached.run(max_cases=1)

    assert summary["model_merges"] == 1
    assert cached_a[0].calls == cached_b[0].calls == []
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(DISTINCT concept_id) FROM mentions"
        ).fetchone()[0] == 1


def test_dual_model_same_protected_merge_is_non_destructive_and_not_reported(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-protected-left", "concept-protected-right")
    for index, (concept_id, mention_id) in enumerate(zip(concept_ids, mention_ids)):
        _insert_test_concept(
            database,
            lexeme_id,
            concept_id,
            anchor_mention_id=mention_id,
            locked=True,
        )
        _bind_test_mention(database, mention_id, concept_id)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE concepts SET verified_target=? WHERE id=?",
                (f"locked-{index}", concept_id),
            )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    summary = coordinator.run(max_cases=1)

    assert summary["model_merges"] == 0
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 0
        assert [
            row[0]
            for row in connection.execute(
                "SELECT concept_id FROM mentions ORDER BY id"
            )
        ] == list(concept_ids)
        decision = connection.execute(
            """SELECT relation, votes_json FROM coreference_decisions
               WHERE decision_source='dual_model'"""
        ).fetchone()
    assert decision["relation"] == "same"
    effect = next(
        vote["effect"]
        for vote in json.loads(decision["votes_json"])
        if vote.get("source") == "dual_model"
    )
    assert effect["bindings_changed"] == 0
    assert effect["unified_identity"] is False


def test_dual_model_run_cached_uncertain_does_not_repeat_fallback(tmp_path):
    database, lexeme_id, _, _, case = _coreference_case(tmp_path)
    _insert_test_concept(database, lexeme_id, "concept-fallback-cached")
    with database.transaction() as connection:
        connection.execute(
            """UPDATE concepts SET default_target='候选译名'
               WHERE id='concept-fallback-cached'"""
        )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    first, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "uncertain")],
        [_dual_model_response(case, "uncertain")],
    )
    first_summary = first.run(max_cases=1)
    cached_a = []
    cached_b = []
    cached = CoreferenceCoordinator(
        database,
        llm_factory_a=_dual_model_factory(
            "model-a", [AssertionError("must not call A")], cached_a
        ),
        llm_factory_b=_dual_model_factory(
            "model-b", [AssertionError("must not call B")], cached_b
        ),
    )

    cached_summary = cached.run(max_cases=1)

    assert first_summary["uncertain"] == first_summary["fallbacks"] == 1
    assert cached_summary["uncertain"] == 1
    assert cached_summary["fallbacks"] == 0
    assert cached_a[0].calls == cached_b[0].calls == []


def test_dual_model_run_deterministic_merges_count_only_fresh_changes(tmp_path):
    database, _, _, evidence_ids, _ = _coreference_case(tmp_path)
    _set_evidence_payload(
        database,
        evidence_ids,
        {"evidence_hash": "deterministic-run-effect"},
    )
    first = CoreferenceCoordinator(database)

    first_summary = first.run(max_cases=1)
    replay_summary = CoreferenceCoordinator(database).run(max_cases=1)

    assert first_summary["deterministic_merges"] == 1
    assert replay_summary["deterministic_merges"] == 0


def test_dual_model_retired_anchor_collision_is_nonblocking_same(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    _insert_test_concept(
        database,
        lexeme_id,
        "concept-retired-anchor-owner",
        anchor_mention_id=mention_ids[0],
        retired=True,
    )
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    summary = coordinator.run(max_cases=1)

    assert summary["model_merges"] == 0
    with closing(database.connect()) as connection:
        decision = connection.execute(
            """SELECT relation, votes_json FROM coreference_decisions
               WHERE decision_source='dual_model'"""
        ).fetchone()
        assert connection.execute(
            """SELECT COUNT(*) FROM audit_calls
               WHERE purpose='dual_model_coreference'"""
        ).fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0
    resolution = next(
        vote
        for vote in json.loads(decision["votes_json"])
        if vote.get("source") == "dual_model"
    )
    assert decision["relation"] == "same"
    assert resolution["effect"]["bindings_changed"] == 0


def test_dual_model_unknown_anchor_runtime_error_rolls_back(tmp_path, monkeypatch):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    def fail_unknown(*_args, **_kwargs):
        raise RuntimeError("unknown anchor implementation failure")

    monkeypatch.setattr(database, "ensure_concept_for_anchor", fail_unknown)
    with pytest.raises(RuntimeError, match="unknown anchor implementation"):
        coordinator.resolve_dual_model(case)
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0] == 0


def test_dual_model_persistence_failure_rolls_back_decision_binding_and_audits(
    tmp_path, monkeypatch
):
    database, _, _, _, case = _coreference_case(tmp_path)
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )
    real_record = database.record_audit_call
    calls = 0

    def fail_second_audit(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("forced dual audit failure")
        return real_record(*args, **kwargs)

    monkeypatch.setattr(database, "record_audit_call", fail_second_audit)
    with pytest.raises(RuntimeError, match="forced dual audit failure"):
        coordinator.resolve_dual_model(case)

    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM mentions WHERE concept_id IS NOT NULL"
        ).fetchone()[0] == 0


def test_human_concept_form_merge_uses_redirects_and_readable_authorization(tmp_path):
    database = _db(tmp_path, source_text="Several scapes framed one scape.")
    database.import_legacy_concept("scape", "拟境", "concept", "canonical")
    database.import_legacy_concept("scapes", "虚拟场景", "concept", "plural")
    canonical_id = stable_id("concept", normalize_english_form("scape"))
    alias_id = stable_id("concept", normalize_english_form("scapes"))

    result = database.merge_concept_forms("scape", ["scapes"])

    assert result["canonical_id"] == canonical_id
    assert result["merged_concept_ids"] == [alias_id]
    assert database.resolve_concept_id(alias_id) == canonical_id
    with closing(database.connect()) as connection:
        redirect = connection.execute(
            """SELECT canonical_concept_id, reason, knowledge_version
               FROM concept_redirects WHERE retired_concept_id=?""",
            (alias_id,),
        ).fetchone()
        alias_link = connection.execute(
            """SELECT cl.role, l.normalized_form
               FROM concept_lexemes cl
               JOIN lexemes l ON l.id=cl.lexeme_id
               WHERE cl.concept_id=? AND cl.retired_version IS NULL
                 AND l.normalized_form='scapes'""",
            (canonical_id,),
        ).fetchone()
        authorization = connection.execute(
            """SELECT id FROM audit_calls
               WHERE purpose='human_concept_form_merge_authorization'
                 AND accepted=1 ORDER BY id DESC LIMIT 1"""
        ).fetchone()
        merge_audit = connection.execute(
            """SELECT id FROM audit_calls
               WHERE purpose='concept_merge' AND accepted=1
               ORDER BY id DESC LIMIT 1"""
        ).fetchone()
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()

    assert redirect is not None
    assert redirect["canonical_concept_id"] == canonical_id
    assert "human concept-form merge authorization audit:" in redirect["reason"]
    assert tuple(alias_link) == ("alias", "scapes")
    assert authorization is not None
    assert merge_audit is not None
    authorization_payload = database.read_audit_payload(int(authorization["id"]))
    merge_payload = database.read_audit_payload(int(merge_audit["id"]))
    assert authorization_payload["request"]["actor_type"] == "human"
    assert authorization_payload["parsed"]["canonical_concept_id"] == canonical_id
    assert merge_payload["parsed"]["canonical_id"] == canonical_id
    assert foreign_keys == []


def test_dual_same_unexpected_merge_value_error_rolls_back_everything(
    tmp_path, monkeypatch
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-unexpected-left", "concept-unexpected-right")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database, lexeme_id, concept_id, anchor_mention_id=mention_id
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    def fail_unexpected(*_args, **_kwargs):
        raise ValueError("unexpected injected merge bug")

    monkeypatch.setattr(database, "merge_concepts", fail_unexpected)
    with pytest.raises(ValueError, match="unexpected injected merge bug"):
        coordinator.resolve_dual_model(case)

    with closing(database.connect()) as connection:
        bindings = connection.execute(
            "SELECT id, concept_id FROM mentions ORDER BY id"
        ).fetchall()
        assert connection.execute(
            "SELECT COUNT(*) FROM coreference_decisions"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0] == 0
    assert [(row["id"], row["concept_id"]) for row in bindings] == list(
        zip(mention_ids, concept_ids)
    )


def test_dual_same_explicit_merge_conflict_is_conservative_without_fake_effect(
    tmp_path, monkeypatch
):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-protected-left", "concept-protected-right")
    for concept_id, mention_id in zip(concept_ids, mention_ids):
        _insert_test_concept(
            database, lexeme_id, concept_id, anchor_mention_id=mention_id
        )
        _bind_test_mention(database, mention_id, concept_id)
    case = CoreferenceCoordinator(database).freeze_cases()[0]
    coordinator, _, _ = _dual_model_coordinator(
        database,
        case,
        [_dual_model_response(case, "same")],
        [_dual_model_response(case, "same")],
    )

    def fail_protected(*_args, **_kwargs):
        raise ConceptMergeConflictError("protected merge")

    monkeypatch.setattr(database, "merge_concepts", fail_protected)
    summary = coordinator.run(max_cases=1)

    assert summary["model_merges"] == 0
    with closing(database.connect()) as connection:
        decision = connection.execute(
            "SELECT relation, votes_json FROM coreference_decisions"
        ).fetchone()
        bindings = connection.execute(
            "SELECT id, concept_id FROM mentions ORDER BY id"
        ).fetchall()
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls WHERE purpose='concept_merge'"
        ).fetchone()[0] == 0
    effect = next(
        vote["effect"]
        for vote in json.loads(decision["votes_json"])
        if vote.get("source") == "dual_model"
    )
    assert decision["relation"] == "same"
    assert effect == {"bindings_changed": 0, "unified_identity": False}
    assert [(row["id"], row["concept_id"]) for row in bindings] == list(
        zip(mention_ids, concept_ids)
    )


def test_human_alias_only_change_is_versioned_audited_and_idempotent(tmp_path):
    database = _db(tmp_path, source_text="Several scapes appeared.")
    database.import_legacy_concept("scape", "拟境", "concept", "canonical")
    canonical_id = stable_id("concept", normalize_english_form("scape"))
    alias_lexeme_id = stable_id("lexeme", "en:scapes")
    with closing(database.connect()) as connection:
        before_versions = connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0]
        before_audits = connection.execute(
            "SELECT COUNT(*) FROM audit_calls"
        ).fetchone()[0]

    first = database.merge_concept_forms("scape", ["scapes"])

    assert first["canonical_id"] == canonical_id
    assert first["canonical_source"] == "scape"
    assert first["aliases"] == ["scapes"]
    assert first["merged_concept_ids"] == []
    assert first["affected_translations"] == 0
    assert first["changed"] is True
    assert isinstance(first["authorization_audit_id"], int)
    with closing(database.connect()) as connection:
        after_first = {
            "versions": connection.execute(
                "SELECT COUNT(*) FROM knowledge_versions"
            ).fetchone()[0],
            "audits": connection.execute(
                "SELECT COUNT(*) FROM audit_calls"
            ).fetchone()[0],
            "changes": connection.execute(
                """SELECT COUNT(*) FROM knowledge_changes
                   WHERE change_kind='subject_link'"""
            ).fetchone()[0],
        }
        link = connection.execute(
            """SELECT role, created_version FROM concept_lexemes
               WHERE concept_id=? AND lexeme_id=?
                 AND retired_version IS NULL""",
            (canonical_id, alias_lexeme_id),
        ).fetchone()
        source_form = connection.execute(
            """SELECT form FROM source_forms
               WHERE lexeme_id=? AND normalized_form='scapes'""",
            (alias_lexeme_id,),
        ).fetchone()
    assert after_first == {
        "versions": before_versions + 1,
        "audits": before_audits + 1,
        "changes": 1,
    }
    assert tuple(link) == ("alias", first["knowledge_version"])
    assert source_form["form"] == "scapes"
    authorization = database.read_audit_payload(first["authorization_audit_id"])
    assert authorization["parsed"]["authorized"] is True
    assert authorization["parsed"]["canonical_concept_id"] == canonical_id

    replay = database.merge_concept_forms("scape", ["scapes"])

    assert replay["changed"] is False
    assert replay["authorization_audit_id"] is None
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0] == after_first["versions"]
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls"
        ).fetchone()[0] == after_first["audits"]
        assert connection.execute(
            """SELECT COUNT(*) FROM knowledge_changes
               WHERE change_kind='subject_link'"""
        ).fetchone()[0] == after_first["changes"]


def test_human_alias_preparation_rolls_back_with_later_concept_merge_failure(
    tmp_path, monkeypatch
):
    database = _db(tmp_path, source_text="Scape variants and scapes appeared.")
    database.import_legacy_concept("scape", "拟境", "concept", "canonical")
    database.import_legacy_concept("scapes", "虚拟场景", "concept", "plural")
    canonical_id = stable_id("concept", normalize_english_form("scape"))
    alias_id = stable_id("concept", normalize_english_form("scapes"))
    variant_lexeme_id = stable_id("lexeme", "en:scape variant")
    with closing(database.connect()) as connection:
        before = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "knowledge_versions",
                "audit_calls",
                "knowledge_changes",
                "lexemes",
                "source_forms",
                "concept_lexemes",
            )
        }

    def fail_after_preparation(*_args, **_kwargs):
        raise RuntimeError("injected merge failure after alias preparation")

    monkeypatch.setattr(
        database, "_merge_concepts_authorized", fail_after_preparation
    )
    with pytest.raises(RuntimeError, match="after alias preparation"):
        database.merge_concept_forms("scape", ["scape variant", "scapes"])

    with closing(database.connect()) as connection:
        after = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in before
        }
        assert connection.execute(
            "SELECT COUNT(*) FROM lexemes WHERE id=?", (variant_lexeme_id,)
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT retired_version FROM concepts WHERE id=?", (alias_id,)
        ).fetchone()[0] is None
        assert connection.execute(
            """SELECT COUNT(*) FROM concept_lexemes
               WHERE concept_id=? AND lexeme_id=? AND retired_version IS NULL""",
            (canonical_id, variant_lexeme_id),
        ).fetchone()[0] == 0
    assert after == before


def test_merge_authorization_does_not_follow_mutable_member_bindings(tmp_path):
    database, lexeme_id, mention_ids, _, _ = _coreference_case(tmp_path)
    concept_ids = ("concept-frozen-a", "concept-frozen-b", "concept-rebound-c")
    for concept_id in concept_ids:
        _insert_test_concept(database, lexeme_id, concept_id)
    _bind_test_mention(database, mention_ids[0], concept_ids[0])
    _bind_test_mention(database, mention_ids[1], concept_ids[1])
    decision_id = _insert_same_coreference_decision(
        database,
        lexeme_id,
        mention_ids,
        concept_ids[:2],
        decision_id="coref-frozen-member-authorization",
    )
    _bind_test_mention(database, mention_ids[1], concept_ids[2])
    with closing(database.connect()) as connection:
        before_versions = connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0]

    with pytest.raises(
        ConceptMergeConflictError,
        match="does not authorize every merge concept",
    ):
        database.merge_concepts(
            [concept_ids[0], concept_ids[2]],
            reason="must not trust mutable member bindings",
            decision_id=decision_id,
        )

    with closing(database.connect()) as connection:
        statuses = connection.execute(
            """SELECT id, retired_version FROM concepts
               WHERE id IN (?, ?, ?) ORDER BY id""",
            concept_ids,
        ).fetchall()
        bindings = connection.execute(
            "SELECT concept_id FROM mentions ORDER BY id"
        ).fetchall()
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0] == before_versions
    assert all(row["retired_version"] is None for row in statuses)
    assert [row["concept_id"] for row in bindings] == [
        concept_ids[0],
        concept_ids[2],
    ]


def test_human_alias_merge_follows_retired_alias_to_explicit_canonical(tmp_path):
    database = _db(tmp_path, source_text="Scapes crossed a landscape and a scape.")
    for source in ("scape", "landscape", "scapes"):
        database.import_legacy_concept(
            source,
            "拟境",
            "concept",
            f"legacy {source}",
        )
    ids = {
        source: stable_id("concept", normalize_english_form(source))
        for source in ("scape", "landscape", "scapes")
    }
    for source in ("scape", "landscape", "scapes"):
        database.lock_concept_translation(source, "拟境")

    first = database.merge_concept_forms("landscape", ["scapes"])
    with closing(database.connect()) as connection:
        before_second = {
            "versions": connection.execute(
                "SELECT COUNT(*) FROM knowledge_versions"
            ).fetchone()[0],
            "audits": connection.execute(
                "SELECT COUNT(*) FROM audit_calls"
            ).fetchone()[0],
            "redirects": connection.execute(
                "SELECT COUNT(*) FROM concept_redirects"
            ).fetchone()[0],
        }

    second = database.merge_concept_forms("scape", ["scapes"])

    assert first["changed"] is True
    assert second["changed"] is True
    assert second["canonical_id"] == ids["scape"]
    assert second["merged_concept_ids"] == [ids["landscape"]]
    assert isinstance(second["authorization_audit_id"], int)
    assert second["knowledge_version"] > first["knowledge_version"]
    assert database.resolve_concept_id(ids["scapes"]) == ids["scape"]
    assert database.resolve_concept_id(ids["landscape"]) == ids["scape"]
    with closing(database.connect()) as connection:
        redirects = connection.execute(
            """SELECT retired_concept_id, canonical_concept_id, reason
               FROM concept_redirects ORDER BY retired_concept_id"""
        ).fetchall()
        after_second = {
            "versions": connection.execute(
                "SELECT COUNT(*) FROM knowledge_versions"
            ).fetchone()[0],
            "audits": connection.execute(
                "SELECT COUNT(*) FROM audit_calls"
            ).fetchone()[0],
            "redirects": len(redirects),
        }
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert {
        (row["retired_concept_id"], row["canonical_concept_id"])
        for row in redirects
    } == {
        (ids["scapes"], ids["landscape"]),
        (ids["landscape"], ids["scape"]),
    }
    assert all(
        "human concept-form merge authorization audit:" in row["reason"]
        for row in redirects
    )
    assert after_second == {
        "versions": before_second["versions"] + 1,
        "audits": before_second["audits"] + 2,
        "redirects": before_second["redirects"] + 1,
    }

    replay = database.merge_concept_forms("scape", ["scapes"])

    assert replay["changed"] is False
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM knowledge_versions"
        ).fetchone()[0] == after_second["versions"]
        assert connection.execute(
            "SELECT COUNT(*) FROM audit_calls"
        ).fetchone()[0] == after_second["audits"]
        assert connection.execute(
            "SELECT COUNT(*) FROM concept_redirects"
        ).fetchone()[0] == after_second["redirects"]


def test_human_retired_alias_locked_identity_conflict_rolls_back(tmp_path):
    database = _db(tmp_path, source_text="Scapes crossed a landscape and a scape.")
    for source in ("scape", "landscape", "scapes"):
        database.import_legacy_concept(source, "拟境", "concept", source)
    ids = {
        source: stable_id("concept", normalize_english_form(source))
        for source in ("scape", "landscape", "scapes")
    }
    database.merge_concept_forms("landscape", ["scapes"])
    with database.transaction() as connection:
        connection.execute(
            "UPDATE concepts SET kind='place', locked=1 WHERE id=?",
            (ids["scape"],),
        )
        connection.execute(
            "UPDATE concepts SET kind='person', locked=1 WHERE id=?",
            (ids["landscape"],),
        )
    with closing(database.connect()) as connection:
        before = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "knowledge_versions",
                "audit_calls",
                "knowledge_changes",
                "concept_redirects",
            )
        }

    with pytest.raises(ConceptMergeConflictError, match="locked.*kinds"):
        database.merge_concept_forms("scape", ["scapes"])

    with closing(database.connect()) as connection:
        after = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in before
        }
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert after == before
    assert database.resolve_concept_id(ids["scapes"]) == ids["landscape"]
    assert database.resolve_concept_id(ids["landscape"]) == ids["landscape"]


def test_human_retired_alias_locked_target_conflict_rolls_back(tmp_path):
    database = _db(tmp_path, source_text="Scapes crossed a landscape and a scape.")
    database.import_legacy_concept("scape", "A", "concept", "explicit target")
    database.import_legacy_concept("landscape", "C", "concept", "alias target")
    database.import_legacy_concept("scapes", "C", "concept", "plural alias")
    ids = {
        source: stable_id("concept", normalize_english_form(source))
        for source in ("scape", "landscape", "scapes")
    }
    database.merge_concept_forms("landscape", ["scapes"])
    database.lock_concept_translation("scape", "A")
    database.lock_concept_translation("landscape", "C")
    with closing(database.connect()) as connection:
        before = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "knowledge_versions",
                "audit_calls",
                "knowledge_changes",
                "concept_redirects",
                "concept_lexemes",
                "lexemes",
                "source_forms",
            )
        }

    with pytest.raises(
        ConceptMergeConflictError,
        match="locked concepts have conflicting translations",
    ):
        database.merge_concept_forms("scape", ["scapes"])

    with closing(database.connect()) as connection:
        after = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in before
        }
        statuses = connection.execute(
            """SELECT id, retired_version FROM concepts
               WHERE id IN (?, ?) ORDER BY id""",
            (ids["scape"], ids["landscape"]),
        ).fetchall()
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert after == before
    assert all(row["retired_version"] is None for row in statuses)
    assert database.resolve_concept_id(ids["scapes"]) == ids["landscape"]
    assert database.resolve_concept_id(ids["landscape"]) == ids["landscape"]
