import hashlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from src.core.preprocessor import TextPreprocessor
from src.core.project_manager import ProjectManager


def _assert_contiguous_segments(text: str, segments: tuple[dict, ...]) -> None:
    cursor = 0
    for segment in segments:
        assert segment["canonical_start"] == cursor
        assert segment["canonical_end"] >= cursor
        cursor = segment["canonical_end"]
    assert cursor == len(text)


def _write_test_epub(path: Path) -> None:
    container = """<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="book/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>"""
    opf = """<?xml version="1.0" encoding="utf-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Ledger Test</dc:title></metadata>
      <manifest>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>"""
    c1 = """<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>1</h1>
    <p>First chapter has enough narrative text to remain in the EPUB spine.</p></body></html>"""
    c2 = """<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Afterword</h1>
    <p>Second chapter also has enough narrative text for ledger provenance.</p></body></html>"""
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("book/content.opf", opf)
        archive.writestr("book/c1.xhtml", c1)
        archive.writestr("book/c2.xhtml", c2)


def test_project_preserves_raw_source_and_writes_verified_manifest(tmp_path):
    original = tmp_path / "novel.txt"
    original.write_bytes(b"\xef\xbb\xbfBook One\r\n\r\nChapter I\r\nText.\r\n")

    project = ProjectManager(str(tmp_path / "projects")).create_project(
        "novel", str(original), overlap_sentences=0
    )

    manifest = json.loads(project.source_manifest_file.read_text(encoding="utf-8"))
    assert project.raw_source_file.read_bytes() == original.read_bytes()
    assert manifest["schema_version"] == "v5-source-ledger-1"
    assert manifest["coordinate_unit"] == "unicode_scalar"
    assert manifest["raw_sha256"] == hashlib.sha256(original.read_bytes()).hexdigest()
    assert manifest["canonical_sha256"] == hashlib.sha256(
        project.source_file.read_bytes()
    ).hexdigest()
    assert manifest["canonical_chars"] == len(
        project.source_file.read_text(encoding="utf-8")
    )
    assert manifest["canonical_segments"] == [
        {
            "canonical_start": 0,
            "canonical_end": manifest["canonical_chars"],
            "origin_kind": "decoded_bytes",
            "origin_ref": "source/original.txt",
            "raw_start": 3,
            "raw_end": len(original.read_bytes()),
            "transformation": "decode+newline-normalize",
        }
    ]
    assert manifest["excluded_raw_ranges"] == [
        {"raw_start": 0, "raw_end": 3, "policy": "UTF8_BOM"}
    ]


def test_plain_text_canonicalization_preserves_spaces_and_empty_lines(tmp_path):
    original = tmp_path / "spacing.md"
    original.write_bytes(b"  indented  \r\n\r\n\r\nTail \r")

    project = ProjectManager(str(tmp_path / "projects")).create_project(
        "spacing", str(original), overlap_sentences=0
    )

    assert project.source_file.read_bytes() == b"  indented  \n\n\nTail \n"
    manifest = json.loads(project.source_manifest_file.read_text(encoding="utf-8"))
    assert manifest["encoding"] == "utf-8"
    assert manifest["excluded_raw_ranges"] == []


def test_epub_and_docx_provenance_segments_are_contiguous_and_auditable(tmp_path):
    epub = tmp_path / "book.epub"
    _write_test_epub(epub)
    epub_document = TextPreprocessor().load_document(str(epub))

    _assert_contiguous_segments(epub_document.text, epub_document.canonical_segments)
    assert [segment["origin_ref"] for segment in epub_document.canonical_segments] == [
        "book/c1.xhtml",
        "book/c2.xhtml",
    ]
    assert {item["policy"] for item in epub_document.excluded_raw_ranges} == {
        "EPUB_NON_SPINE_DATA"
    }

    docx = pytest.importorskip("docx")
    document = docx.Document()
    document.add_paragraph("  First paragraph  ")
    document.add_paragraph("")
    document.add_paragraph("Second paragraph")
    docx_path = tmp_path / "book.docx"
    document.save(docx_path)

    docx_document = TextPreprocessor().load_document(str(docx_path))
    _assert_contiguous_segments(docx_document.text, docx_document.canonical_segments)
    assert docx_document.text == "  First paragraph  \n\n\n\nSecond paragraph"
    assert [segment["origin_ref"] for segment in docx_document.canonical_segments] == [
        "word/document.xml#paragraph=0",
        "word/document.xml#paragraph=1",
        "word/document.xml#paragraph=2",
    ]
    assert {item["policy"] for item in docx_document.excluded_raw_ranges} == {
        "DOCX_NON_DOCUMENT_DATA"
    }


def test_source_ledger_rejects_an_unknown_exclusion_policy(tmp_path):
    from src.core.source_ledger import create_source_ledger

    original = tmp_path / "novel.txt"
    original.write_text("Text.", encoding="utf-8")
    document = TextPreprocessor().load_document(str(original))
    invalid = replace(
        document,
        excluded_raw_ranges=(
            {"raw_start": 0, "raw_end": 1, "policy": "free-form reason"},
        ),
    )

    with pytest.raises(ValueError, match="unknown excluded raw range policy"):
        create_source_ledger(original, tmp_path / "project", invalid)


def test_source_ledger_rejects_source_changed_after_document_load(tmp_path):
    from src.core.source_ledger import create_source_ledger

    original = tmp_path / "novel.txt"
    original.write_text("Original text.\r\n", encoding="utf-8", newline="")
    document = TextPreprocessor().load_document(str(original))
    original.write_text("Changed text.\n", encoding="utf-8", newline="")

    with pytest.raises(ValueError, match="source changed after document load"):
        create_source_ledger(original, tmp_path / "project", document)
    assert not (tmp_path / "project").exists()


def test_project_creation_rolls_back_if_initialization_fails(tmp_path, monkeypatch):
    import src.core.project_manager as project_manager_module

    original = tmp_path / "novel.txt"
    original.write_text("Text.", encoding="utf-8")

    def fail_project_initialization(*_args, **_kwargs):
        raise RuntimeError("injected initialization failure")

    monkeypatch.setattr(
        project_manager_module, "Project", fail_project_initialization
    )
    manager = project_manager_module.ProjectManager(str(tmp_path / "projects"))

    with pytest.raises(RuntimeError, match="injected initialization failure"):
        manager.create_project("novel", str(original))
    assert not (tmp_path / "projects" / "novel").exists()


def test_ambiguous_non_utf8_source_requires_explicit_encoding(tmp_path):
    original = tmp_path / "ambiguous.txt"
    original.write_bytes(b"\x80\x81\x82")
    projects = tmp_path / "projects"

    with pytest.raises(RuntimeError, match="ENCODING_AMBIGUOUS"):
        ProjectManager(str(projects)).create_project("ambiguous", str(original))

    assert not (projects / "ambiguous").exists()


def test_explicit_gbk_source_encoding_is_recorded_and_decoded(tmp_path):
    source_text = "\u7b2c\u4e00\u7ae0\r\n\r\n\u6b63\u6587\u3002\r\n"
    original = tmp_path / "novel.txt"
    original.write_bytes(source_text.encode("gbk"))

    assert TextPreprocessor().load_text(
        str(original), source_encoding="gbk"
    ) == source_text.replace("\r\n", "\n")
    project = ProjectManager(str(tmp_path / "projects")).create_project(
        "novel", str(original), source_encoding="gbk", overlap_sentences=0
    )

    manifest = json.loads(project.source_manifest_file.read_text(encoding="utf-8"))
    assert manifest["encoding"] == "gbk"
    assert project.raw_source_file.read_bytes() == original.read_bytes()
    assert project.source_file.read_text(encoding="utf-8") == source_text.replace(
        "\r\n", "\n"
    )


def test_init_cli_forwards_explicit_source_encoding(tmp_path, monkeypatch):
    import main as cli

    captured = {}

    class FakeProjectManager:
        def create_project(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(root_dir=tmp_path / "projects" / kwargs["book_id"])

    class FakeConfigLoader:
        @staticmethod
        def load_config():
            return {}

    monkeypatch.setattr(cli, "project_manager", FakeProjectManager())
    monkeypatch.setattr(cli, "config_loader", FakeConfigLoader())

    assert cli.main(
        ["init", "novel", str(tmp_path / "novel.txt"), "--encoding", "gbk"]
    ) == 0
    assert captured["source_encoding"] == "gbk"


def test_project_records_normalized_source_language_in_manifest_and_config(tmp_path):
    original = tmp_path / "roman.txt"
    original.write_text("Chapitre premier\n\nLe texte.", encoding="utf-8")

    project = ProjectManager(str(tmp_path / "projects")).create_project(
        "roman",
        str(original),
        source_language="fr-FR",
        overlap_sentences=0,
    )

    manifest = json.loads(project.source_manifest_file.read_text(encoding="utf-8"))
    config = project.config_file.read_text(encoding="utf-8")
    assert manifest["sourceLanguage"] == "fr"
    assert "source_language: fr" in config


def test_new_project_defaults_source_language_to_english(tmp_path):
    original = tmp_path / "novel.txt"
    original.write_text("Chapter One\n\nText.", encoding="utf-8")

    project = ProjectManager(str(tmp_path / "projects")).create_project(
        "novel", str(original), overlap_sentences=0
    )

    manifest = json.loads(project.source_manifest_file.read_text(encoding="utf-8"))
    assert manifest["sourceLanguage"] == "en"


@pytest.mark.parametrize("language", ["", "english", "en_US", "zh", "en-!"])
def test_invalid_or_unsupported_source_language_rolls_back(tmp_path, language):
    original = tmp_path / "novel.txt"
    original.write_text("Text.", encoding="utf-8")
    projects = tmp_path / "projects"

    with pytest.raises(ValueError, match="source language"):
        ProjectManager(str(projects)).create_project(
            "novel", str(original), source_language=language
        )

    assert not (projects / "novel").exists()


def test_init_cli_forwards_explicit_source_language(tmp_path, monkeypatch):
    import main as cli

    captured = {}

    class FakeProjectManager:
        def create_project(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(root_dir=tmp_path / "projects" / kwargs["book_id"])

    class FakeConfigLoader:
        @staticmethod
        def load_config():
            return {}

    monkeypatch.setattr(cli, "project_manager", FakeProjectManager())
    monkeypatch.setattr(cli, "config_loader", FakeConfigLoader())

    assert cli.main([
        "init",
        "roman",
        str(tmp_path / "roman.txt"),
        "--source-language",
        "fr",
    ]) == 0
    assert captured["source_language"] == "fr"
