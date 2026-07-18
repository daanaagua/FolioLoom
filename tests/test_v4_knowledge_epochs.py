import hashlib
from contextlib import closing

from src.core.v4.database import V4Database
from src.core.v4.knowledge_epochs import KnowledgeEpochCoordinator
from src.core.v4.models import (
    RenderingMatchSnapshot,
    TranslationOutcome,
    V4BlockStatus,
)


def _database(tmp_path):
    root = tmp_path / "book"
    root.mkdir()
    database = V4Database(root)
    edition = database.ensure_source_edition("raw", "normalized", "test", "source.txt")
    text = "Alpha met Beta and Gamma."
    database.upsert_blocks(
        edition,
        [
            {
                "id": "block-0",
                "chapter_id": "chapter-1",
                "chapter_title": "One",
                "chapter_index": 0,
                "block_index": 0,
                "global_index": 0,
                "block_type": "prose",
                "source_text": text,
                "source_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "token_count": 5,
                "status": "ready",
            }
        ],
    )
    return database


def _outcome(database, source, target):
    block = database.get_block_by_identifier("block-0")
    return TranslationOutcome(
        block=block,
        knowledge_version=database.current_knowledge_version(),
        status=V4BlockStatus.COMPLETED.value,
        term_proposals=[
            {"src": source, "tgt": target, "type": "person", "context": block.source_text}
        ],
    )


def _seed_active_translation(database):
    concept_id = database.import_legacy_concept("Alpha", "", "person", "test")
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "旧译名", "rules": []}]
    )
    block = database.get_block_by_identifier("block-0")
    bundle = database.freeze_render_bundle([block.id])
    matches = bundle.index.matched_renderings(
        block.source_text,
        block_id=block.id,
        occurrence_contexts=list(bundle.contexts_by_block[block.id]),
    )
    assert matches
    run_id = "seed-translation"
    database.start_run(run_id, "translate", {}, knowledge_version=bundle.knowledge_version)
    database.commit_translation_batch(
        run_id,
        [
            TranslationOutcome(
                block=block,
                knowledge_version=bundle.knowledge_version,
                status=V4BlockStatus.COMPLETED.value,
                draft_translation="旧译名出现。",
                final_translation="旧译名出现。",
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
        ],
    )
    database.finish_run(run_id, "completed")
    return concept_id


def test_epoch_checkpoint_is_persisted_idempotent_and_bounded(tmp_path, monkeypatch):
    database = _database(tmp_path)
    run_id = "epoch-run"
    database.start_run(run_id, "translate", {"knowledge_epoch_mode": True})
    calls = {"count": 0}
    original = database.commit_translation_proposals

    def counted(*args, **kwargs):
        calls["count"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(database, "commit_translation_proposals", counted)
    coordinator = KnowledgeEpochCoordinator(
        database,
        ["block-0"],
        max_knowledge_epochs=2,
    )

    epoch = coordinator.freeze()
    assert epoch.ordinal == 0
    assert epoch.knowledge_version == database.current_knowledge_version()
    assert coordinator.stage(run_id, [_outcome(database, "Alpha", "阿尔法")]) == 1
    first = coordinator.checkpoint(run_id)

    assert first.applied is True
    assert first.capped is False
    assert first.reused is False
    assert first.epoch.ordinal == 1
    assert calls["count"] == 1
    resumed = KnowledgeEpochCoordinator(
        database,
        ["block-0"],
        max_knowledge_epochs=2,
    )
    assert resumed.stage(run_id, [_outcome(database, "Alpha", "阿尔法")]) == 0
    repeated = resumed.checkpoint(run_id)
    assert repeated.reused is True
    assert calls["count"] == 1

    assert resumed.stage(run_id, [_outcome(database, "Beta", "贝塔")]) == 1
    capped = resumed.checkpoint(run_id)
    assert capped.applied is False
    assert capped.capped is True
    assert capped.deferred_proposals == 1
    assert calls["count"] == 1
    with closing(database.connect()) as connection:
        sources = {
            row[0]
            for row in connection.execute(
                "SELECT canonical_source FROM concepts WHERE retired_version IS NULL"
            )
        }
    assert "Alpha" in sources
    assert "Beta" not in sources


def test_epoch_checkpoint_only_pauses_when_both_flags_are_explicit(tmp_path):
    database = _database(tmp_path)
    run_id = "interactive-no-pause"
    database.start_run(run_id, "translate", {"knowledge_epoch_mode": True})
    coordinator = KnowledgeEpochCoordinator(
        database,
        ["block-0"],
        decision_mode="interactive",
        pause_on_review=False,
    )

    coordinator.freeze()
    coordinator.stage(run_id, [_outcome(database, "Gamma", "伽马")])
    result = coordinator.checkpoint(run_id)

    assert result.applied is True
    assert result.paused is False
    with closing(database.connect()) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM human_queue WHERE kind='translation_proposal'"
        ).fetchone()[0] == 1


def test_epoch_checkpoint_includes_change_committed_before_writer_lock(
    tmp_path,
):
    database = _database(tmp_path)
    concept_id = _seed_active_translation(database)
    run_id = "high-water-race"
    database.start_run(run_id, "translate", {"knowledge_epoch_mode": True})
    coordinator = KnowledgeEpochCoordinator(database, ["block-0"])
    coordinator.freeze()
    database.apply_working_target_decisions(
        [{"concept_id": concept_id, "target": "新译名", "rules": []}]
    )

    result = coordinator.checkpoint(run_id)

    with closing(database.connect()) as connection:
        change_id = int(
            connection.execute(
                "SELECT MAX(id) FROM knowledge_changes"
            ).fetchone()[0]
        )
    assert result.change_ids == (change_id,)
    assert result.planned_tasks == 1
    assert database.status_summary()["needs_revalidate"] == 1
    repeated = coordinator.checkpoint(run_id)
    assert repeated.reused is True
    assert repeated.change_ids == (change_id,)
