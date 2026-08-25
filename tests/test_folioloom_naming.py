from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys

import main as cli

from src.core.folioloom_exporter import FolioLoomBookExporter


def _project(root: Path):
    root.mkdir(parents=True)
    return SimpleNamespace(root_dir=root)


def test_folioloom_exporter_prefers_the_canonical_store_path(tmp_path):
    project = _project(tmp_path / "book")

    exporter = FolioLoomBookExporter(project)

    assert exporter.database_path == project.root_dir / "artifacts" / "folioloom" / "book.db"


def test_folioloom_exporter_reads_an_existing_legacy_store(tmp_path):
    project = _project(tmp_path / "book")
    legacy = project.root_dir / "artifacts" / "translator_v5" / "book.db"
    legacy.parent.mkdir(parents=True)
    legacy.touch()

    exporter = FolioLoomBookExporter(project)

    assert exporter.database_path == legacy


def test_export_folioloom_cli_is_the_primary_compatibility_safe_command(
    monkeypatch, tmp_path
):
    project = _project(tmp_path / "book")
    calls = {}

    class FakeExporter:
        def __init__(self, received, run_id=None):
            assert received is project
            calls["run_id"] = run_id

        def export_folioloom(self, output_dir=None, allow_incomplete=False):
            calls.update(
                output_dir=output_dir,
                allow_incomplete=allow_incomplete,
            )
            return SimpleNamespace(
                txt_path=Path("draft.txt"),
                epub_path=Path("draft.epub"),
            )

    monkeypatch.setattr(cli, "_load_project_or_error", lambda _book_id: project)
    monkeypatch.setattr(
        cli,
        "FolioLoomBookExporter",
        FakeExporter,
        raising=False,
    )

    result = cli.main(
        [
            "export-folioloom",
            "sample",
            "--run-id",
            "run-a",
            "--allow-incomplete",
            "--output-dir",
            "drafts",
        ]
    )

    assert result == 0
    assert calls == {
        "run_id": "run-a",
        "output_dir": "drafts",
        "allow_incomplete": True,
    }


def test_help_hides_the_legacy_v5_alias():
    result = subprocess.run(
        [sys.executable, "main.py", "--help"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )

    assert "export-folioloom" in result.stdout
    assert "export-v5" not in result.stdout
