import json
import threading
import time
from contextlib import closing

import pytest

from src.core.v4 import database as database_module
from src.core.v4.adjudicator import (
    AdjudicationAuditAttempt,
    AdjudicationResult,
    V4Adjudicator,
)
from src.core.v4.candidate_clusters import CandidateCluster
from src.core.v4.database import (
    StaleAdjudicationCommit,
    V4Database,
)
from src.core.v4.lexical_index import LexicalCandidate
from src.core.v4.models import ScanOutcome, ScanResponse
from src.core.v4.scanner import V4Scanner


class ExplodingLLM:
    def __init__(self):
        self.calls = 0

    def chat(self, **_kwargs):
        self.calls += 1
        raise AssertionError("local indexing must not call the model")

    def get_model(self, _purpose):
        self.calls += 1
        raise AssertionError("local indexing must not inspect model configuration")


class PromotingLLM:
    def __init__(self, verdict="promote"):
        self.verdict = verdict
        self.calls = 0
        self.payloads = []

    def chat(self, *, messages, **_kwargs):
        self.calls += 1
        payload = json.loads(messages[-1]["content"])
        self.payloads.append(payload)
        decisions = []
        for cluster in payload["clusters"]:
            selected = []
            if self.verdict == "promote":
                selected = [
                    min(
                        cluster["alternatives"],
                        key=lambda item: (item["text"].casefold(), item["text"]),
                    )["id"]
                ]
            decisions.append(
                {
                    "cluster_id": cluster["cluster_id"],
                    "verdict": self.verdict,
                    "selected_ids": selected,
                    "entity_kind": "person",
                    "confidence": 0.99,
                    "reason": "",
                }
            )
        return json.dumps({"decisions": decisions})


class FailSecondBatchLLM(PromotingLLM):
    def __init__(self):
        super().__init__()
        self.batch_sizes = []

    def chat(self, *, messages, **kwargs):
        payload = json.loads(messages[-1]["content"])
        self.batch_sizes.append(len(payload["clusters"]))
        if self.calls == 1:
            self.calls += 1
            return "{}"
        return super().chat(messages=messages, **kwargs)


class ConcurrentPromotingFactory:
    def __init__(self, expected_concurrency):
        self.barrier = threading.Barrier(expected_concurrency)
        self.lock = threading.Lock()
        self.active = 0
        self.peak = 0
        self.call_index = 0
        self.batch_sizes = []

    def __call__(self):
        return ConcurrentPromotingLLM(self)


class ConcurrentPromotingLLM(PromotingLLM):
    def __init__(self, tracker):
        super().__init__()
        self.tracker = tracker

    def chat(self, *, messages, **kwargs):
        payload = json.loads(messages[-1]["content"])
        with self.tracker.lock:
            index = self.tracker.call_index
            self.tracker.call_index += 1
            self.tracker.active += 1
            self.tracker.peak = max(self.tracker.peak, self.tracker.active)
            self.tracker.batch_sizes.append(len(payload["clusters"]))
        try:
            self.tracker.barrier.wait(timeout=3)
            time.sleep((4 - index) * 0.01)
            return super().chat(messages=messages, **kwargs)
        finally:
            with self.tracker.lock:
                self.tracker.active -= 1


class RateLimitSignal(RuntimeError):
    status_code = 429


class OneRateLimitFactory:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = 0

    def __call__(self):
        return OneRateLimitLLM(self)


class OneRateLimitLLM(PromotingLLM):
    def __init__(self, tracker):
        super().__init__()
        self.tracker = tracker

    def chat(self, *, messages, **kwargs):
        with self.tracker.lock:
            call_index = self.tracker.calls
            self.tracker.calls += 1
        if call_index == 0:
            raise RateLimitSignal("too many requests")
        return super().chat(messages=messages, **kwargs)


def make_database(tmp_path, texts):
    db = V4Database(tmp_path / "book")
    edition = db.ensure_source_edition("raw", "normalized", "test", "source.txt")
    db.upsert_blocks(
        edition,
        [
            {
                "id": f"block-{index}",
                "legacy_id": f"v01_ch01_{index:03d}",
                "chapter_id": "ch01",
                "chapter_title": "I",
                "chapter_index": 0,
                "block_index": index,
                "global_index": index,
                "block_type": "prose",
                "source_text": source,
                "source_hash": f"hash-{index}",
                "token_count": len(source.split()),
                "status": "pending",
            }
            for index, source in enumerate(texts)
        ],
    )
    return db


def make_candidate_cluster_database(tmp_path, count):
    names = [f"Name{index:03d}" for index in range(count)]
    source = " ".join(names)
    db = make_database(tmp_path, [source])
    block = db.list_blocks()[0]
    candidates = []
    cursor = 0
    for index, name in enumerate(names):
        start = source.index(name, cursor)
        end = start + len(name)
        cursor = end
        candidates.append(
            LexicalCandidate(
                id=f"candidate-{index:03d}",
                block_id=block.id,
                paragraph_id="P000",
                start_offset=start,
                end_offset=end,
                original_text=name,
                normalized_text=name,
                left_context="",
                right_context="",
                extraction_reason="test",
                book_frequency=1,
                score=0,
            )
        )
    db.start_run("scan-many", "scan", {})
    db.commit_candidate_index_batch(
        "scan-many",
        [
            ScanOutcome(
                block=block,
                response=ScanResponse(),
                lexical_candidates=[item.storage_payload() for item in candidates],
            )
        ],
    )
    db.persist_candidate_clusters(
        "scan-many",
        [
            CandidateCluster(
                id=f"cluster-{index:03d}",
                alternatives=(candidate,),
                contexts=(),
                risk_flags=(),
                affected_blocks=1,
            )
            for index, candidate in enumerate(candidates)
        ],
    )
    db.finish_run("scan-many", "completed")
    return db


@pytest.fixture
def database(tmp_path):
    db = V4Database(tmp_path / "book")
    edition = db.ensure_source_edition("raw", "normalized", "test", "source.txt")
    rows = [
        {
            "id": "front",
            "legacy_id": "v00_pre_000",
            "chapter_id": "pre",
            "chapter_title": "Preamble",
            "chapter_index": 0,
            "block_index": 0,
            "global_index": 0,
            "block_type": "frontmatter",
            "source_text": "THE COMPLETE BOOK",
            "source_hash": "front-hash",
            "token_count": 3,
            "status": "pending",
        },
        {
            "id": "prose-1",
            "legacy_id": "v01_ch01_000",
            "chapter_id": "ch01",
            "chapter_title": "I",
            "chapter_index": 1,
            "block_index": 0,
            "global_index": 1,
            "block_type": "prose",
            "source_text": "Severian waited beside the Corpse Door.",
            "source_hash": "prose-1-hash",
            "token_count": 6,
            "status": "pending",
        },
        {
            "id": "prose-2",
            "legacy_id": "v01_ch01_001",
            "chapter_id": "ch01",
            "chapter_title": "I",
            "chapter_index": 1,
            "block_index": 1,
            "global_index": 2,
            "block_type": "prose",
            "source_text": "Severian crossed the Old Yard.",
            "source_hash": "prose-2-hash",
            "token_count": 5,
            "status": "pending",
        },
    ]
    db.upsert_blocks(edition, rows)
    return db


def test_scan_project_is_local_indexes_candidates_and_frontmatter_atomically(database):
    llm = ExplodingLLM()
    result = V4Scanner(database, llm).scan_project(max_blocks=2)

    assert result["indexed"] == 2
    assert result["clusters"] > 0
    assert result["run_id"].startswith("scan_")
    assert llm.calls == 0
    with closing(database.connect()) as connection:
        statuses = dict(connection.execute("SELECT id, status FROM blocks"))
        assert statuses["front"] == "ready"
        assert statuses["prose-1"] == "scanned"
        assert connection.execute("SELECT COUNT(*) FROM lexical_candidates").fetchone()[0] > 0
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM candidate_adjudications").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM lexical_candidates WHERE block_id='front'"
        ).fetchone()[0] == 0

    database.reconcile_exact_forms()
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0


def test_explicit_scan_indexes_translated_blocks_without_mutating_their_state(tmp_path):
    db = V4Database(tmp_path / "book")
    edition = db.ensure_source_edition("raw", "normalized", "test", "source.txt")
    protected_statuses = {
        2: "completed",
        3: "needs_revalidate",
        4: "completed_with_warnings",
    }
    rows = []
    for index in range(8):
        front_matter = index < 2
        rows.append(
            {
                "id": f"block-{index}",
                "legacy_id": f"v00_pre_{index:03d}" if front_matter else f"v01_ch01_{index:03d}",
                "chapter_id": "pre" if front_matter else "ch01",
                "chapter_title": "Preamble" if front_matter else "I",
                "chapter_index": 0 if front_matter else 1,
                "block_index": index,
                "global_index": index,
                "block_type": "frontmatter" if front_matter else "prose",
                "source_text": (
                    f"PUBLISHER PAGE {index}"
                    if front_matter
                    else f"Severian met Person{index}."
                ),
                "source_hash": f"hash-{index}",
                "token_count": 3,
                "status": protected_statuses.get(index, "pending"),
            }
        )
    db.upsert_blocks(edition, rows)
    with db.transaction() as connection:
        for index, status in protected_statuses.items():
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, status,
                       draft_translation, final_translation, active, created_at
                   ) VALUES(?, 'parallel_v4', 1, ?, ?, ?, 1, 'before')""",
                (f"block-{index}", status, f"draft-{index}", f"final-{index}"),
            )

    llm = ExplodingLLM()
    explicit_identifiers = [
        "block-0",
        "v00_pre_001",
        "block-2",
        "v01_ch01_003",
        "block-4",
        "block-5",
        "block-6",
        "block-7",
        "block-2",  # repeated CLI selectors must not duplicate work
    ]
    result = V4Scanner(db, llm).scan_project(
        block_ids=explicit_identifiers,
        max_blocks=8,
    )

    assert result["indexed"] == 8
    assert result["block_ids"] == [f"block-{index}" for index in range(8)]
    assert llm.calls == 0
    with closing(db.connect()) as connection:
        statuses = dict(
            connection.execute("SELECT id, status FROM blocks ORDER BY global_index")
        )
        candidate_blocks = {
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT block_id FROM lexical_candidates ORDER BY block_id"
            )
        }
        translations = connection.execute(
            """SELECT block_id, status, draft_translation, final_translation, active,
                      created_at
               FROM translation_versions ORDER BY block_id"""
        ).fetchall()
    assert statuses["block-0"] == "ready"
    assert statuses["block-1"] == "ready"
    assert statuses["block-2"] == "completed"
    assert statuses["block-3"] == "needs_revalidate"
    assert statuses["block-4"] == "completed_with_warnings"
    assert all(statuses[f"block-{index}"] == "scanned" for index in range(5, 8))
    assert not candidate_blocks.intersection({"block-0", "block-1"})
    assert {f"block-{index}" for index in range(2, 8)} <= candidate_blocks
    assert [tuple(row) for row in translations] == [
        (f"block-{index}", status, f"draft-{index}", f"final-{index}", 1, "before")
        for index, status in protected_statuses.items()
    ]


def test_default_scan_limit_still_selects_only_pending_or_retryable_blocks(tmp_path):
    db = make_database(tmp_path, ["Completed Name.", "Pending Name."])
    db.set_block_status("block-0", "completed")

    result = V4Scanner(db, ExplodingLLM()).scan_project(max_blocks=1)

    assert result["block_ids"] == ["block-1"]
    assert db.get_block_by_identifier("block-0").status == "completed"
    assert db.get_block_by_identifier("block-1").status == "scanned"


def test_candidate_commit_failure_does_not_overwrite_protected_block_state(tmp_path):
    db = make_database(tmp_path, ["Protected Name.", "Retryable Name."])
    protected, pending = db.list_blocks()
    db.set_block_status(protected.id, "completed")
    db.start_run("explicit-failure", "scan", {})

    result = db.commit_candidate_index_batch(
        "explicit-failure",
        [
            ScanOutcome(block=protected, response=None, error="protected failure"),
            ScanOutcome(block=pending, response=None, error="pending failure"),
        ],
    )

    assert result["failed"] == 2
    assert db.get_block_by_identifier(protected.id).status == "completed"
    assert db.get_block_by_identifier(pending.id).status == "failed_retryable"


def test_pending_cluster_loader_roundtrips_roles_contexts_and_offsets(database):
    scanner = V4Scanner(database, ExplodingLLM())
    scanner.scan_project(max_blocks=3)

    clusters = database.load_pending_candidate_clusters()
    assert clusters
    assert any(len(cluster.contexts) for cluster in clusters)
    assert any(cluster.affected_blocks == 2 for cluster in clusters)
    for cluster in clusters:
        alternative_ids = {item.id for item in cluster.alternatives}
        assert alternative_ids
        for alternative in cluster.alternatives:
            source = database.get_block_by_identifier(alternative.block_id).source_text
            assert (
                source[alternative.start_offset : alternative.end_offset]
                == alternative.original_text
            )
        with closing(database.connect()) as connection:
            roles = {
                row["candidate_id"]: row["role"]
                for row in connection.execute(
                    "SELECT candidate_id, role FROM candidate_cluster_members WHERE cluster_id=?",
                    (cluster.id,),
                )
            }
        assert all(roles[item.id] in {"alternative", "both"} for item in cluster.alternatives)
        assert all(
            context.candidate_id not in alternative_ids
            for context in cluster.contexts
            if roles[context.candidate_id] == "context"
        )

    with database.transaction() as connection:
        candidate_id = clusters[0].alternatives[0].id
        connection.execute(
            "UPDATE lexical_candidates SET risk_flags_json='not-json' WHERE id=?",
            (candidate_id,),
        )
    reloaded = database.load_pending_candidate_clusters()
    candidate = next(
        item
        for cluster in reloaded
        for item in cluster.alternatives
        if item.id == candidate_id
    )
    assert candidate.risk_flags == ()


def test_six_block_cluster_resolves_members_but_only_selected_candidate_writes_evidence(
    tmp_path,
):
    database = make_database(
        tmp_path,
        [f"Severian waited at marker {index}." for index in range(6)],
    )
    scanner = V4Scanner(database, ExplodingLLM())
    scanner.scan_project(max_blocks=6)

    cluster = next(
        item
        for item in database.load_pending_candidate_clusters()
        if item.texts == ("Severian",)
    )
    assert cluster.affected_blocks == 6
    assert len(cluster.contexts) <= 3
    assert len(cluster.alternatives) <= 4
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_cluster_members WHERE cluster_id=?",
            (cluster.id,),
        ).fetchone()[0] == 6

    llm = PromotingLLM()
    result = V4Adjudicator(llm, database=database, max_attempts=1).run()

    assert result["failed"] == 0
    assert all(
        "members" not in public_cluster
        for payload in llm.payloads
        for public_cluster in payload["clusters"]
    )
    with closing(database.connect()) as connection:
        assert connection.execute(
            """SELECT COUNT(*) FROM lexical_candidates
               WHERE original_text='Severian' AND resolution_status='pending'"""
        ).fetchone()[0] == 0
        assert connection.execute(
            """SELECT COUNT(*) FROM candidate_resolutions cr
                JOIN candidate_cluster_members cm ON cm.candidate_id=cr.candidate_id
                WHERE cm.cluster_id=?""",
            (cluster.id,),
        ).fetchone()[0] == 6
        assert connection.execute(
            """SELECT COUNT(*) FROM candidate_resolutions cr
               JOIN candidate_cluster_members cm ON cm.candidate_id=cr.candidate_id
               WHERE cm.cluster_id=? AND cr.decision='promote'
                     AND cr.lexeme_id IS NOT NULL AND cr.concept_id IS NULL""",
            (cluster.id,),
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*) FROM candidate_resolutions cr
               JOIN candidate_cluster_members cm ON cm.candidate_id=cr.candidate_id
               WHERE cm.cluster_id=? AND cm.role='context'
                     AND (cr.decision='promote' OR cr.lexeme_id IS NOT NULL)""",
            (cluster.id,),
        ).fetchone()[0] == 0
        assert connection.execute(
            """SELECT COUNT(DISTINCT m.id)
               FROM mentions m
               JOIN candidate_resolutions cr ON cr.evidence_id=m.evidence_id
               WHERE cr.cluster_id=? AND cr.decision='promote'""",
            (cluster.id,),
        ).fetchone()[0] == 1
        assert connection.execute(
            """SELECT COUNT(*)
               FROM candidate_resolutions cr
               JOIN lexical_candidates lc ON lc.id=cr.candidate_id
               JOIN form_occurrences fo
                 ON fo.lexeme_id=cr.lexeme_id AND fo.block_id=lc.block_id
                    AND fo.start_offset=lc.start_offset
                    AND fo.end_offset=lc.end_offset
               WHERE cr.cluster_id=? AND cr.decision='promote'""",
            (cluster.id,),
        ).fetchone()[0] == 1


def test_preparation_advances_only_fully_resolved_scanned_blocks(tmp_path):
    database = make_database(
        tmp_path,
        ["Severian waited.", "Abaia slept.", "nothing was capitalized."],
    )
    scan = V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=2)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE blocks SET status='scanned' WHERE id='block-2'"
        )
    adjudication = V4Adjudicator(
        PromotingLLM(), database=database, max_attempts=1
    ).run(max_clusters=1)
    assert adjudication["failed"] == 0

    with closing(database.connect()) as connection:
        concept_ids = [
            row[0]
            for row in connection.execute(
                "SELECT id FROM concepts WHERE retired_version IS NULL ORDER BY id"
            )
        ]
    for concept_id in concept_ids:
        database.apply_working_target_decisions(
            [
                {
                    "concept_id": concept_id,
                    "target": "固定译名",
                    "rules": [],
                    "confidence": 1.0,
                }
            ]
        )

    advanced = database.advance_prepared_blocks(scan["block_ids"])

    assert advanced == {"ready": 1, "blocked": 1}
    with closing(database.connect()) as connection:
        statuses = [
            row[0]
            for row in connection.execute(
                "SELECT status FROM blocks ORDER BY global_index"
            )
        ]
        assert statuses.count("ready") == 1
        assert statuses.count("scanned") == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM lexical_candidates WHERE resolution_status='pending'"
        ).fetchone()[0] > 0


def test_reindex_rebuilds_pending_clusters_without_duplicates(database):
    scanner = V4Scanner(database, ExplodingLLM())
    scanner.scan_project(max_blocks=3)
    with closing(database.connect()) as connection:
        first_ids = [
            row[0]
            for row in connection.execute(
                "SELECT id FROM candidate_clusters ORDER BY id"
            )
        ]
        connection.execute("UPDATE blocks SET status='pending'")
        connection.commit()

    scanner = V4Scanner(database, ExplodingLLM())
    scanner.scan_project(max_blocks=3)
    with closing(database.connect()) as connection:
        second_ids = [
            row[0]
            for row in connection.execute(
                "SELECT id FROM candidate_clusters ORDER BY id"
            )
        ]
        duplicate_memberships = connection.execute(
            """SELECT COUNT(*) FROM (
                   SELECT candidate_id, COUNT(*) n
                   FROM candidate_cluster_members
                   GROUP BY candidate_id HAVING n > 1
               )"""
        ).fetchone()[0]
    assert second_ids == first_ids
    assert duplicate_memberships == 0


def test_indexing_failure_does_not_partially_advance_a_wave(database, monkeypatch):
    scanner = V4Scanner(database, ExplodingLLM())

    def explode(_block):
        raise RuntimeError("extractor failed")

    monkeypatch.setattr(scanner.extractor, "extract", explode)
    with pytest.raises(RuntimeError, match="extractor failed"):
        scanner.scan_project(initial_workers=2, max_workers=2, max_blocks=2)
    with closing(database.connect()) as connection:
        statuses = dict(connection.execute("SELECT id, status FROM blocks"))
        run = connection.execute(
            "SELECT stage, status, error FROM runs ORDER BY started_at DESC, id DESC LIMIT 1"
        ).fetchone()
    assert statuses["front"] == "pending"
    assert statuses["prose-1"] == "pending"
    assert tuple(run) == ("scan", "failed", "extractor failed")


def test_adjudicator_run_calls_model_commits_lexemes_and_does_not_repeat(database):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=3)
    llm = PromotingLLM()
    pending_count = len(database.load_pending_candidate_clusters())
    result = V4Adjudicator(llm, database=database).run()

    assert result["adjudicated"] == pending_count
    assert result["concepts"] == 0
    first_call_count = llm.calls
    assert first_call_count >= 1
    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM lexemes").fetchone()[0] >= 1
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] >= 1
        assert connection.execute("SELECT COUNT(*) FROM form_occurrences").fetchone()[0] >= 1
        run = connection.execute(
            "SELECT stage, status FROM runs WHERE id=?", (result["run_id"],)
        ).fetchone()
        assert tuple(run) == ("adjudicate", "completed")

    second = V4Adjudicator(llm, database=database).run()
    assert second["adjudicated"] == 0
    assert llm.calls == first_call_count


def test_adjudicator_run_executes_four_batches_and_commits_in_order(
    tmp_path, monkeypatch
):
    db = make_candidate_cluster_database(tmp_path, 48)
    expected_ids = [cluster.id for cluster in db.load_pending_candidate_clusters()]
    tracker = ConcurrentPromotingFactory(expected_concurrency=4)
    commit_order = []
    write_threads = []
    original_commit = db.commit_adjudications

    def recording_commit(run_id, results, **kwargs):
        commit_order.append([result.cluster_id for result in results])
        write_threads.append(threading.get_ident())
        return original_commit(run_id, results, **kwargs)

    monkeypatch.setattr(db, "commit_adjudications", recording_commit)
    result = V4Adjudicator(
        tracker(),
        database=db,
        max_attempts=1,
        llm_factory=tracker,
    ).run(initial_workers=4, max_workers=4)

    assert result["adjudicated"] == 48
    assert tracker.peak == 4
    assert result["peak_workers"] == 4
    assert tracker.batch_sizes == [12, 12, 12, 12]
    assert commit_order == [
        expected_ids[start : start + 12] for start in range(0, 48, 12)
    ]
    assert set(write_threads) == {threading.get_ident()}


def test_adjudicator_halves_workers_after_rate_limit_then_recovers(tmp_path):
    db = make_candidate_cluster_database(tmp_path, 132)
    factory = OneRateLimitFactory()

    result = V4Adjudicator(
        factory(),
        database=db,
        max_attempts=1,
        llm_factory=factory,
    ).run(initial_workers=4, max_workers=4)

    assert result["worker_history"][:3] == [4, 2, 3]
    assert result["rate_limit_events"] == 1
    assert result["worker_reductions"] == 1
    assert result["failed"] == 12
    assert result["adjudicated"] == 132


def test_deferred_adjudication_is_active_but_creates_no_concept(database):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=3)
    llm = PromotingLLM(verdict="defer")
    result = V4Adjudicator(llm, database=database).run(max_clusters=1)

    assert result["adjudicated"] == 1
    assert result["concepts"] == 0
    assert result["failed"] == 0
    assert result["deferred"] == 1
    with closing(database.connect()) as connection:
        row = connection.execute(
            "SELECT verdict, active FROM candidate_adjudications WHERE run_id=?",
            (result["run_id"],),
        ).fetchone()
        assert tuple(row) == ("defer", 1)
        run = connection.execute(
            "SELECT status FROM runs WHERE id=?", (result["run_id"],)
        ).fetchone()
        assert run["status"] == "completed"
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0


def test_adjudicator_run_records_failed_stage(database, monkeypatch):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=3)

    def explode(*_args, **_kwargs):
        raise RuntimeError("storage failed")

    monkeypatch.setattr(database, "commit_adjudications", explode)
    with pytest.raises(RuntimeError, match="storage failed"):
        V4Adjudicator(PromotingLLM(), database=database).run(max_clusters=1)
    with closing(database.connect()) as connection:
        row = connection.execute(
            "SELECT stage, status, error FROM runs ORDER BY started_at DESC, id DESC LIMIT 1"
        ).fetchone()
    assert row["stage"] == "adjudicate"
    assert row["status"] == "failed"
    assert "storage failed" in row["error"]


def test_commit_adjudications_rolls_back_audits_with_decisions(database, monkeypatch):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=3)
    database.start_run("judge-atomic", "adjudicate", {})
    cluster = database.claim_pending_candidate_clusters("judge-atomic", 1)[0]
    decision = AdjudicationResult(
        cluster_id=cluster.id,
        verdict="reject",
        selected_candidate_ids=(),
        entity_kind="concept",
        confidence=0.99,
    )
    audit = AdjudicationAuditAttempt(
        messages=(
            {"role": "system", "content": "judge"},
            {"role": "user", "content": "bounded aliases"},
        ),
        raw_response='{"decisions":[]}',
        parsed={"decisions": []},
        accepted=True,
        attempt=1,
        elapsed_ms=12,
        error=None,
        error_kind=None,
        model="FakeModel",
        knowledge_version=0,
        audit_mode="full",
    )
    original_record = database.record_audit_call

    def record_then_fail(**kwargs):
        original_record(**kwargs)
        raise RuntimeError("forced adjudication failure")

    monkeypatch.setattr(database, "record_audit_call", record_then_fail)
    with pytest.raises(RuntimeError, match="forced adjudication failure"):
        database.commit_adjudications(
            "judge-atomic",
            [decision],
            audit_attempts=[audit],
            require_lease=True,
        )

    with closing(database.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications"
        ).fetchone()[0] == 0
        state = connection.execute(
            "SELECT state, lease_run_id FROM candidate_clusters WHERE id=?",
            (cluster.id,),
        ).fetchone()
    assert tuple(state) == ("leased", "judge-atomic")


def test_active_cluster_context_only_member_is_not_reclustered(tmp_path):
    db = make_database(tmp_path, ["Severian waited.", "Severian returned."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    cluster = next(
        item for item in db.load_pending_candidate_clusters() if item.affected_blocks == 2
    )
    alternative_ids = {item.id for item in cluster.alternatives}
    context_only_ids = {
        item.candidate_id for item in cluster.contexts
    } - alternative_ids
    assert context_only_ids

    db.start_run("judge-context", "adjudicate", {})
    db.commit_adjudications(
        "judge-context",
        [
            AdjudicationResult(
                cluster_id=cluster.id,
                verdict="promote",
                selected_candidate_ids=(cluster.alternatives[0].id,),
                entity_kind="person",
                confidence=0.99,
            )
        ],
    )
    db.finish_run("judge-context", "completed")
    with db.transaction() as connection:
        connection.execute("UPDATE blocks SET status='pending'")

    V4Scanner(db, ExplodingLLM()).scan_project()
    pending_ids = {item.id for item in db.load_pending_lexical_candidates()}
    assert not pending_ids.intersection(alternative_ids | context_only_ids)
    assert db.load_pending_candidate_clusters() == []
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM candidate_clusters").fetchone()[0] == 1


def test_inactive_history_reopens_as_stable_new_generation(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    historical = db.load_pending_candidate_clusters()[0]
    db.start_run("judge-old", "adjudicate", {})
    db.commit_adjudications(
        "judge-old",
        [
            AdjudicationResult(
                cluster_id=historical.id,
                verdict="reject",
                selected_candidate_ids=(),
                entity_kind="person",
                confidence=0.99,
            )
        ],
    )
    db.finish_run("judge-old", "completed")
    with db.transaction() as connection:
        connection.execute("UPDATE candidate_adjudications SET active=0")
        connection.execute(
            """UPDATE lexical_candidates
               SET resolution_status='pending', model_status='pending', selected=0"""
        )
        connection.execute("UPDATE blocks SET status='pending'")

    assert db.load_pending_candidate_clusters() == []
    V4Scanner(db, ExplodingLLM()).scan_project()
    reopened = db.load_pending_candidate_clusters()
    assert len(reopened) == 1
    assert reopened[0].id != historical.id
    first_generation_id = reopened[0].id
    with db.transaction() as connection:
        connection.execute("UPDATE blocks SET status='pending'")
    V4Scanner(db, ExplodingLLM()).scan_project()
    assert [item.id for item in db.load_pending_candidate_clusters()] == [
        first_generation_id
    ]
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM candidate_clusters").fetchone()[0] == 2


def test_pending_cluster_loader_never_returns_resolved_alternative(database):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=2)
    cluster = next(
        item
        for item in database.load_pending_candidate_clusters()
        if len(item.alternatives) >= 2
    )
    rejected_id = cluster.alternatives[-1].id
    with database.transaction() as connection:
        connection.execute(
            """UPDATE lexical_candidates
               SET resolution_status='rejected', model_status='rejected'
               WHERE id=?""",
            (rejected_id,),
        )
    loaded = next(
        item
        for item in database.load_pending_candidate_clusters()
        if item.id == cluster.id
    )
    assert rejected_id not in {item.id for item in loaded.alternatives}


def test_adjudicator_run_marks_second_batch_protocol_failure_completed_with_errors(
    tmp_path,
):
    names = [f"Name{chr(ord('A') + index)}" for index in range(13)]
    source = " ".join(names)
    db = make_database(tmp_path, [source])
    block = db.list_blocks()[0]
    candidates = []
    cursor = 0
    for index, name in enumerate(names):
        start = source.index(name, cursor)
        end = start + len(name)
        cursor = end
        candidates.append(
            LexicalCandidate(
                id=f"candidate-{index:02d}",
                block_id=block.id,
                paragraph_id="P000",
                start_offset=start,
                end_offset=end,
                original_text=name,
                normalized_text=name,
                left_context="",
                right_context="",
                extraction_reason="test",
                book_frequency=1,
                score=0,
            )
        )
    db.start_run("scan-thirteen", "scan", {})
    db.commit_candidate_index_batch(
        "scan-thirteen",
        [
            ScanOutcome(
                block=block,
                response=ScanResponse(),
                lexical_candidates=[item.storage_payload() for item in candidates],
            )
        ],
    )
    db.persist_candidate_clusters(
        "scan-thirteen",
        [
            CandidateCluster(
                id=f"cluster-{index:02d}",
                alternatives=(candidate,),
                contexts=(),
                risk_flags=(),
                affected_blocks=1,
            )
            for index, candidate in enumerate(candidates)
        ],
    )
    db.finish_run("scan-thirteen", "completed")

    llm = FailSecondBatchLLM()
    result = V4Adjudicator(llm, max_attempts=1, database=db).run()
    assert result["adjudicated"] == 13
    assert result["failed"] == 1
    assert result["deferred"] == 1
    with closing(db.connect()) as connection:
        run = connection.execute(
            "SELECT status FROM runs WHERE id=?", (result["run_id"],)
        ).fetchone()
        failures = connection.execute(
            """SELECT COUNT(*) FROM candidate_adjudications
               WHERE run_id=? AND reason='model_protocol_failure' AND active=1""",
            (result["run_id"],),
        ).fetchone()[0]
    assert run["status"] == "completed_with_errors"
    assert failures == 1
    assert llm.batch_sizes == [12, 1]


def test_global_active_adjudication_rejects_stale_cross_run_commit(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    cluster = db.load_pending_candidate_clusters()[0]
    decision = AdjudicationResult(
        cluster_id=cluster.id,
        verdict="promote",
        selected_candidate_ids=(cluster.alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )
    db.start_run("judge-one", "adjudicate", {})
    db.start_run("judge-two", "adjudicate", {})
    db.commit_adjudications("judge-one", [decision])
    with pytest.raises(StaleAdjudicationCommit, match="active"):
        db.commit_adjudications("judge-two", [decision])
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications WHERE active=1"
        ).fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] == 1


def test_claimed_cluster_survives_concurrent_scanner_rebuild(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    db.start_run("judge-lease", "adjudicate", {})
    claimed = db.claim_pending_candidate_clusters("judge-lease", 1)
    assert len(claimed) == 1
    member_ids = {item.id for item in claimed[0].alternatives}
    with db.transaction() as connection:
        connection.execute("UPDATE blocks SET status='pending'")
    V4Scanner(db, ExplodingLLM()).scan_project()
    with closing(db.connect()) as connection:
        row = connection.execute(
            "SELECT state, lease_run_id FROM candidate_clusters WHERE id=?",
            (claimed[0].id,),
        ).fetchone()
        persisted_ids = {
            item[0]
            for item in connection.execute(
                "SELECT candidate_id FROM candidate_cluster_members WHERE cluster_id=?",
                (claimed[0].id,),
            )
        }
    assert tuple(row) == ("leased", "judge-lease")
    assert persisted_ids.issuperset(member_ids)


def test_scanner_retries_stale_candidate_snapshot(database, monkeypatch):
    real_replace = database.replace_pending_candidate_clusters
    calls = 0

    def stale_once(run_id, clusters, *, expected_snapshot_token=None):
        nonlocal calls
        calls += 1
        if calls == 1:
            with database.transaction() as connection:
                connection.execute(
                    """UPDATE lexical_candidates
                       SET updated_at=updated_at || '-changed'
                       WHERE id=(SELECT id FROM lexical_candidates ORDER BY id LIMIT 1)"""
                )
        return real_replace(
            run_id,
            clusters,
            expected_snapshot_token=expected_snapshot_token,
        )

    monkeypatch.setattr(database, "replace_pending_candidate_clusters", stale_once)
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=2)
    assert calls == 2
    assert database.load_pending_candidate_clusters()


def test_frontmatter_reindex_removes_stale_pending_candidates_and_clusters(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    with db.transaction() as connection:
        connection.execute(
            """UPDATE blocks SET block_type='frontmatter', status='pending',
                                 legacy_id='v00_pre_000'"""
        )
    V4Scanner(db, ExplodingLLM()).scan_project()
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM lexical_candidates").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM candidate_clusters").fetchone()[0] == 0
        assert connection.execute("SELECT status FROM blocks").fetchone()[0] == "ready"


def test_cluster_loader_is_bulk_and_pending_indexes_are_used(database, monkeypatch):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=3)
    queries = []
    real_connect = database.connect

    def traced_connect():
        connection = real_connect()
        connection.set_trace_callback(queries.append)
        return connection

    monkeypatch.setattr(database, "connect", traced_connect)
    assert database.load_pending_candidate_clusters()
    member_selects = [
        query
        for query in queries
        if query.lstrip().upper().startswith("SELECT CM.CLUSTER_ID")
    ]
    assert len(member_selects) == 1
    with closing(real_connect()) as connection:
        cluster_plan = " ".join(
            row["detail"]
            for row in connection.execute(
                """EXPLAIN QUERY PLAN SELECT id FROM candidate_clusters
                   WHERE state='pending' ORDER BY id LIMIT 12"""
            )
        )
        lexical_plan = " ".join(
            row["detail"]
            for row in connection.execute(
                """EXPLAIN QUERY PLAN SELECT id FROM lexical_candidates
                   WHERE resolution_status='pending' AND block_id=?""",
                ("prose-1",),
            )
        )
    assert "idx_candidate_clusters_state" in cluster_plan
    assert any(
        index_name in lexical_plan
        for index_name in (
            "idx_lexical_candidates_pending",
            "idx_lexical_candidates_resolution",
        )
    )


def test_has_claimable_clusters_matches_claim_filter(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    assert db.has_claimable_candidate_clusters()

    with db.transaction() as connection:
        connection.execute(
            """UPDATE lexical_candidates
               SET resolution_status='rejected', model_status='rejected'"""
        )

    assert db.load_pending_candidate_clusters() == []
    assert not db.has_claimable_candidate_clusters()


def test_finish_run_failure_hook_cannot_leave_committed_run_running(
    database, monkeypatch
):
    V4Scanner(database, ExplodingLLM()).scan_project(max_blocks=2)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("normal adjudication finalization must be atomic")

    monkeypatch.setattr(database, "finish_run", forbidden)
    result = V4Adjudicator(PromotingLLM(), database=database).run(max_clusters=1)
    with closing(database.connect()) as connection:
        run = connection.execute(
            "SELECT status FROM runs WHERE id=?", (result["run_id"],)
        ).fetchone()
    assert run["status"] == "completed"


def test_stale_lease_cannot_commit_after_source_candidate_is_replaced(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    db.start_run("judge-old-source", "adjudicate", {})
    old_cluster = db.claim_pending_candidate_clusters("judge-old-source", 1)[0]
    old_decision = AdjudicationResult(
        cluster_id=old_cluster.id,
        verdict="promote",
        selected_candidate_ids=(old_cluster.alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )

    block_id = old_cluster.alternatives[0].block_id
    with db.transaction() as connection:
        connection.execute(
            """UPDATE blocks
               SET source_text='Valerian waited.', source_hash='hash-valerian',
                   status='pending'
               WHERE id=?""",
            (block_id,),
        )
    V4Scanner(db, ExplodingLLM()).scan_project()

    with pytest.raises(database_module.StaleAdjudicationLease, match="snapshot"):
        db.commit_adjudications(
            "judge-old-source", [old_decision], require_lease=True
        )
    with closing(db.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM concepts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM mentions").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_adjudications WHERE active=1"
        ).fetchone()[0] == 0

    db.finalize_adjudication_run("judge-old-source", "failed", "stale snapshot")
    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT state FROM candidate_clusters WHERE id=?", (old_cluster.id,)
        ).fetchone()[0] == "stale"
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_clusters WHERE state='pending'"
        ).fetchone()[0] == 1

    db.start_run("judge-current-source", "adjudicate", {})
    current = db.claim_pending_candidate_clusters("judge-current-source", 12)
    assert len(current) == 1
    assert {item.original_text for item in current[0].alternatives} == {"Valerian"}
    assert current[0].id != old_cluster.id


@pytest.mark.parametrize(
    "mutation",
    ["member_context", "candidate_risk", "source_hash"],
)
def test_lease_snapshot_covers_model_facing_context_and_source_metadata(
    tmp_path, mutation
):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    run_id = f"judge-{mutation}"
    db.start_run(run_id, "adjudicate", {})
    cluster = db.claim_pending_candidate_clusters(run_id, 1)[0]
    decision = AdjudicationResult(
        cluster_id=cluster.id,
        verdict="promote",
        selected_candidate_ids=(cluster.alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )
    with db.transaction() as connection:
        if mutation == "member_context":
            connection.execute(
                """UPDATE candidate_cluster_members
                   SET context_json='{"left_context":"changed"}'
                   WHERE cluster_id=?""",
                (cluster.id,),
            )
        elif mutation == "candidate_risk":
            connection.execute(
                """UPDATE lexical_candidates SET risk_flags_json='["changed"]'
                   WHERE id=?""",
                (cluster.alternatives[0].id,),
            )
        else:
            connection.execute(
                "UPDATE blocks SET source_hash='changed-source-hash' WHERE id=?",
                (cluster.alternatives[0].block_id,),
            )

    with pytest.raises(database_module.StaleAdjudicationLease, match="snapshot"):
        db.commit_adjudications(run_id, [decision], require_lease=True)


def test_unchanged_lease_snapshot_commits_normally(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    db.start_run("judge-unchanged", "adjudicate", {})
    cluster = db.claim_pending_candidate_clusters("judge-unchanged", 1)[0]
    decision = AdjudicationResult(
        cluster_id=cluster.id,
        verdict="promote",
        selected_candidate_ids=(cluster.alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )

    result = db.commit_adjudications(
        "judge-unchanged", [decision], require_lease=True
    )

    assert result["changed"] == 1


def test_context_risk_refresh_creates_new_generation_and_stales_old_lease(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    db.start_run("judge-waited", "adjudicate", {})
    old_cluster = db.claim_pending_candidate_clusters("judge-waited", 1)[0]
    old_decision = AdjudicationResult(
        cluster_id=old_cluster.id,
        verdict="promote",
        selected_candidate_ids=(old_cluster.alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )
    candidate_id = old_cluster.alternatives[0].id
    block_id = old_cluster.alternatives[0].block_id

    with db.transaction() as connection:
        connection.execute(
            """UPDATE blocks
               SET source_text='Severian rested.', source_hash='hash-rested',
                   status='pending'
               WHERE id=?""",
            (block_id,),
        )
    V4Scanner(db, ExplodingLLM()).scan_project()
    with db.transaction() as connection:
        connection.execute(
            """UPDATE lexical_candidates
               SET risk_flags_json='["new-risk"]', updated_at=updated_at || '-risk'
               WHERE id=?""",
            (candidate_id,),
        )
    V4Scanner(db, ExplodingLLM()).scan_project()

    with pytest.raises(database_module.StaleAdjudicationLease, match="snapshot"):
        db.commit_adjudications(
            "judge-waited", [old_decision], require_lease=True
        )
    db.finalize_adjudication_run("judge-waited", "failed", "stale snapshot")

    with closing(db.connect()) as connection:
        states = dict(connection.execute("SELECT id, state FROM candidate_clusters"))
    assert states[old_cluster.id] == "stale"
    refreshed_ids = [
        cluster_id for cluster_id, state in states.items() if state == "pending"
    ]
    assert len(refreshed_ids) == 1
    assert refreshed_ids[0] != old_cluster.id

    V4Scanner(db, ExplodingLLM()).scan_project()
    with closing(db.connect()) as connection:
        maintained_pending_ids = [
            row[0]
            for row in connection.execute(
                """SELECT id FROM candidate_clusters
                   WHERE state='pending' ORDER BY id"""
            )
        ]
    assert maintained_pending_ids == refreshed_ids

    db.start_run("judge-rested", "adjudicate", {})
    refreshed = db.claim_pending_candidate_clusters("judge-rested", 12)
    assert len(refreshed) == 1
    assert refreshed[0].id == refreshed_ids[0]
    assert all("waited" not in context.text.casefold() for context in refreshed[0].contexts)
    assert any("rested" in context.text.casefold() for context in refreshed[0].contexts)
    assert "new-risk" in {
        flag for item in refreshed[0].alternatives for flag in item.risk_flags
    }
    refreshed_decision = AdjudicationResult(
        cluster_id=refreshed[0].id,
        verdict="promote",
        selected_candidate_ids=(refreshed[0].alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )
    assert db.commit_adjudications(
        "judge-rested", [refreshed_decision], require_lease=True
    )["changed"] == 1


def test_unchanged_concurrent_rescan_reuses_leased_generation(tmp_path):
    db = make_database(tmp_path, ["Severian waited."])
    V4Scanner(db, ExplodingLLM()).scan_project()
    db.start_run("judge-stable-scan", "adjudicate", {})
    cluster = db.claim_pending_candidate_clusters("judge-stable-scan", 1)[0]
    decision = AdjudicationResult(
        cluster_id=cluster.id,
        verdict="promote",
        selected_candidate_ids=(cluster.alternatives[0].id,),
        entity_kind="person",
        confidence=0.99,
    )
    with db.transaction() as connection:
        connection.execute("UPDATE blocks SET status='pending'")

    V4Scanner(db, ExplodingLLM()).scan_project()

    with closing(db.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_clusters"
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM candidate_clusters WHERE state='pending'"
        ).fetchone()[0] == 0
    assert db.commit_adjudications(
        "judge-stable-scan", [decision], require_lease=True
    )["changed"] == 1
