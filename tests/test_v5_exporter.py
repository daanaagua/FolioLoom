from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import pytest

import main as cli
from src.core.v5_exporter import V5BookExporter


SCHEMA_MARKER = "deepnovel-lossless-book-store-v2-knowledge-history"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _project(tmp_path: Path):
    root = tmp_path / "projects" / "sample"
    root.mkdir(parents=True)
    (root / "config.yaml").write_text(
        "title: Sample Book\nauthor: Example Author\nlanguage: zh-CN\n",
        encoding="utf-8",
    )
    return SimpleNamespace(
        book_id="sample",
        root_dir=root,
        config_file=root / "config.yaml",
    )


def _store(
    project,
    *,
    run_ids: tuple[str, ...] = ("run-a",),
    missing_last: bool = False,
    corrupt_translation_hash: bool = False,
    quarantined: tuple[str, ...] = (),
) -> Path:
    path = project.root_dir / "artifacts" / "translator_v5" / "book.db"
    path.parent.mkdir(parents=True)
    blocks = [
        ("b1", 0, "Source one."),
        ("b2", 1, "Source two."),
        ("b3", 2, "Source three."),
    ]
    with sqlite3.connect(path) as db:
        db.executescript(
            """
            PRAGMA user_version=2;
            CREATE TABLE lossless_schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE source_versions(
                source_version TEXT PRIMARY KEY,
                canonical_sha256 TEXT NOT NULL,
                canonical_chars INTEGER NOT NULL
            );
            CREATE TABLE logical_blocks(
                source_version TEXT NOT NULL,
                block_id TEXT NOT NULL,
                canonical_start INTEGER NOT NULL,
                canonical_end INTEGER NOT NULL,
                source_text TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                global_index INTEGER NOT NULL,
                token_count INTEGER NOT NULL,
                PRIMARY KEY(source_version, block_id)
            );
            CREATE TABLE translation_runs(
                run_id TEXT PRIMARY KEY,
                source_version TEXT NOT NULL,
                protocol_version TEXT NOT NULL,
                model_id TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE window_plans(
                run_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                source_version TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                chapter_id TEXT NOT NULL,
                chapter_title TEXT,
                status TEXT NOT NULL,
                PRIMARY KEY(run_id, window_id)
            );
            CREATE TABLE window_membership(
                run_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                source_version TEXT NOT NULL,
                block_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(run_id, window_id, block_id)
            );
            CREATE TABLE translations(
                translation_id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                source_version TEXT NOT NULL,
                block_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                source_hash TEXT NOT NULL,
                text TEXT NOT NULL,
                result_status TEXT NOT NULL,
                stage_state TEXT NOT NULL,
                active INTEGER NOT NULL,
                snapshot_id TEXT NOT NULL
            );
            """
        )
        db.execute(
            "INSERT INTO lossless_schema_meta VALUES('marker', ?)",
            (SCHEMA_MARKER,),
        )
        canonical = "".join(item[2] for item in blocks)
        db.execute(
            "INSERT INTO source_versions VALUES('source-v1', ?, ?)",
            (_hash(canonical), len(canonical)),
        )
        cursor = 0
        for block_id, global_index, source_text in blocks:
            end = cursor + len(source_text)
            db.execute(
                "INSERT INTO logical_blocks VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "source-v1",
                    block_id,
                    cursor,
                    end,
                    source_text,
                    _hash(source_text),
                    global_index,
                    3,
                ),
            )
            cursor = end
        for run_id in run_ids:
            status = "quarantined" if run_id in quarantined else (
                "running" if missing_last else "completed"
            )
            db.execute(
                "INSERT INTO translation_runs VALUES(?, 'source-v1', 'v5-book-3', ?, ?, ?)",
                (run_id, f"model-{run_id}", json.dumps({"fixture": run_id}), status),
            )
            windows = [
                (f"{run_id}-w1", 0, "ch-1", "第一章", ("b1", "b2")),
                (f"{run_id}-w2", 1, "ch-2", "第二章", ("b3",)),
            ]
            for window_id, ordinal, chapter_id, title, members in windows:
                db.execute(
                    "INSERT INTO window_plans VALUES(?, ?, 'source-v1', ?, ?, ?, 'completed')",
                    (run_id, window_id, ordinal, chapter_id, title),
                )
                for position, block_id in enumerate(members):
                    db.execute(
                        "INSERT INTO window_membership VALUES(?, ?, 'source-v1', ?, ?)",
                        (run_id, window_id, block_id, position),
                    )
            for block_id, global_index, source_text in blocks:
                if missing_last and block_id == "b3":
                    continue
                source_hash = _hash(source_text)
                if corrupt_translation_hash and block_id == "b1":
                    source_hash = "bad-hash"
                window_id = f"{run_id}-w1" if global_index < 2 else f"{run_id}-w2"
                db.execute(
                    """
                    INSERT INTO translations(
                        run_id, window_id, source_version, block_id, version,
                        source_hash, text, result_status, stage_state, active, snapshot_id
                    ) VALUES(?, ?, 'source-v1', ?, ?, ?, ?, 'completed', 'promoted', 1, 'snapshot-0')
                    """,
                    (
                        run_id,
                        window_id,
                        block_id,
                        global_index + 1,
                        source_hash,
                        f"{run_id}-译文-{global_index}",
                    ),
                )
    return path


def _lineage_path(txt_path: Path) -> Path:
    return txt_path.with_suffix(".lineage.json")


def test_schema_v2_export_selects_one_run_and_embeds_identical_lineage(tmp_path):
    project = _project(tmp_path)
    store = _store(project, run_ids=("run-a", "run-b"))

    result = V5BookExporter(project, database_path=store, run_id="run-a").export_v5()

    text = result.txt_path.read_text(encoding="utf-8-sig")
    assert "run-a-译文-0" in text
    assert "run-b" not in text
    lineage = json.loads(_lineage_path(result.txt_path).read_text(encoding="utf-8"))
    assert list(lineage) == [
        "schema",
        "runId",
        "sourceVersion",
        "protocolVersion",
        "modelId",
        "runMetadata",
        "complete",
        "missingBlockIds",
        "blocks",
    ]
    assert lineage["schema"] == "v5-book-lineage-1"
    assert lineage["runId"] == "run-a"
    assert lineage["runMetadata"] == {"fixture": "run-a"}
    assert lineage["complete"] is True
    assert [item["ordinal"] for item in lineage["blocks"]] == [0, 1, 2]
    assert [item["translationRevision"] for item in lineage["blocks"]] == [1, 2, 3]
    with ZipFile(result.epub_path) as archive:
        embedded = json.loads(archive.read("META-INF/v5-lineage.json"))
    assert embedded == lineage


def test_omitted_run_requires_one_non_quarantined_candidate(tmp_path):
    project = _project(tmp_path)
    store = _store(project, run_ids=("run-a", "run-b"))
    with pytest.raises(ValueError, match=r"--run-id|run ID|run_id"):
        V5BookExporter(project, database_path=store).export_v5()

    project_unique = _project(tmp_path / "unique")
    unique_store = _store(
        project_unique,
        run_ids=("run-a", "old-run"),
        quarantined=("old-run",),
    )
    result = V5BookExporter(project_unique, database_path=unique_store).export_v5()
    lineage = json.loads(_lineage_path(result.txt_path).read_text(encoding="utf-8"))
    assert lineage["runId"] == "run-a"


def test_strict_and_partial_exports_preserve_missing_lineage(tmp_path):
    project = _project(tmp_path)
    store = _store(project, missing_last=True)
    exporter = V5BookExporter(project, database_path=store, run_id="run-a")
    with pytest.raises(ValueError, match="1"):
        exporter.export_v5()

    result = exporter.export_v5(allow_incomplete=True)
    lineage = json.loads(_lineage_path(result.txt_path).read_text(encoding="utf-8"))
    assert lineage["complete"] is False
    assert lineage["missingBlockIds"] == ["b3"]
    assert lineage["blocks"][-1]["translationRevision"] is None


def test_export_rejects_stale_translation_and_legacy_schema(tmp_path):
    project = _project(tmp_path)
    stale = _store(project, corrupt_translation_hash=True)
    with pytest.raises(ValueError, match=r"hash|哈希"):
        V5BookExporter(project, database_path=stale, run_id="run-a").export_v5()
    with pytest.raises(ValueError, match=r"hash|哈希"):
        V5BookExporter(project, database_path=stale, run_id="run-a").export_v5(
            allow_incomplete=True
        )

    legacy_project = _project(tmp_path / "legacy")
    legacy_path = legacy_project.root_dir / "legacy.db"
    with sqlite3.connect(legacy_path) as db:
        db.execute("CREATE TABLE book_meta(key TEXT PRIMARY KEY, value TEXT)")
    with pytest.raises(ValueError, match=r"schema v2|Schema v2"):
        V5BookExporter(legacy_project, database_path=legacy_path, run_id="run-a").export_v5()


def test_export_v5_cli_routes_explicit_run(monkeypatch, tmp_path):
    project = _project(tmp_path)
    calls = {}

    class FakeExporter:
        def __init__(self, received, run_id=None):
            assert received is project
            calls["run_id"] = run_id

        def export_v5(self, output_dir=None, allow_incomplete=False):
            calls.update(output_dir=output_dir, allow_incomplete=allow_incomplete)
            return SimpleNamespace(txt_path=Path("draft.txt"), epub_path=Path("draft.epub"))

    monkeypatch.setattr(cli, "_load_project_or_error", lambda _book_id: project)
    monkeypatch.setattr(cli, "V5BookExporter", FakeExporter, raising=False)

    result = cli.main([
        "export-v5",
        "sample",
        "--run-id",
        "run-a",
        "--allow-incomplete",
        "--output-dir",
        "drafts",
    ])
    assert result == 0
    assert calls == {
        "run_id": "run-a",
        "output_dir": "drafts",
        "allow_incomplete": True,
    }
