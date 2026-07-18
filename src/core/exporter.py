"""Export completed translation projects to plain text and EPUB 3."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Iterable, List, Sequence
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

import yaml

from .schemas import Chapter, ChunkStatus


@dataclass
class ExportResult:
    txt_path: Path
    epub_path: Path
    chapter_count: int
    chunk_count: int


class BookExporter:
    def __init__(self, project):
        self.project = project

    def _metadata(self) -> dict:
        metadata = {
            "title": self.project.book_id,
            "author": "",
            "language": "zh-CN",
        }
        if self.project.config_file.exists():
            data = yaml.safe_load(self.project.config_file.read_text(encoding="utf-8")) or {}
            metadata.update({key: data[key] for key in metadata if data.get(key)})
        return metadata

    def _chapters(self) -> List[Chapter]:
        chapters = []
        for chapter_file in sorted(self.project.memory.chapters_dir.glob("*.json")):
            chapter = self.project.memory.load_chapter(chapter_file.stem)
            if chapter:
                chapters.append(chapter)
        return chapters

    @staticmethod
    def _missing_chunks(chapters: Sequence[Chapter]) -> List[str]:
        missing = []
        for chapter in chapters:
            for chunk in chapter.chunks:
                finished = chunk.status in {ChunkStatus.COMPLETED, ChunkStatus.HUMAN_REVIEW}
                if not finished or not (chunk.final_translation or "").strip():
                    missing.append(chunk.id)
        return missing

    @staticmethod
    def _chapter_translation(chapter: Chapter) -> str:
        return "\n\n".join(
            (chunk.final_translation or "").strip()
            for chunk in chapter.chunks
            if (chunk.final_translation or "").strip()
        ).strip()

    @staticmethod
    def _safe_stem(title: str) -> str:
        safe = re.sub(r'[<>:"/\\|?*]+', "_", title).strip().strip(".")
        return safe or "translation"

    def export(self, output_dir: str | Path | None = None, require_complete: bool = True) -> ExportResult:
        chapters = self._chapters()
        if not chapters:
            raise ValueError("项目中没有章节")
        missing = self._missing_chunks(chapters)
        if missing and require_complete:
            preview = ", ".join(missing[:10])
            suffix = "..." if len(missing) > 10 else ""
            raise ValueError(f"仍有 {len(missing)} 个文本块未完成：{preview}{suffix}")

        metadata = self._metadata()
        target_dir = Path(output_dir) if output_dir else self.project.root_dir / "exports"
        target_dir.mkdir(parents=True, exist_ok=True)
        stem = self._safe_stem(metadata["title"])
        txt_path = target_dir / f"{stem}_zh.txt"
        epub_path = target_dir / f"{stem}_zh.epub"

        self._write_txt(txt_path, metadata, chapters)
        self._write_epub(epub_path, metadata, chapters)
        return ExportResult(
            txt_path=txt_path,
            epub_path=epub_path,
            chapter_count=len(chapters),
            chunk_count=sum(len(chapter.chunks) for chapter in chapters),
        )

    def _write_txt(self, path: Path, metadata: dict, chapters: Sequence[Chapter]) -> None:
        parts = [metadata["title"]]
        if metadata.get("author"):
            parts.append(f"作者：{metadata['author']}")
        parts.append("")
        for index, chapter in enumerate(chapters, start=1):
            heading = chapter.title or f"第{index}章"
            parts.extend([heading, "", self._chapter_translation(chapter), ""])
        path.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8-sig")

    @staticmethod
    def _paragraphs_to_xhtml(text: str) -> str:
        paragraphs = re.split(r"\n\s*\n", text.strip()) if text.strip() else []
        rendered = []
        for paragraph in paragraphs:
            escaped = escape(paragraph.strip()).replace("\n", "<br/>")
            if escaped:
                rendered.append(f"<p>{escaped}</p>")
        return "\n".join(rendered)

    def _write_epub(self, path: Path, metadata: dict, chapters: Sequence[Chapter]) -> None:
        identifier = f"urn:uuid:{uuid4()}"
        modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        chapter_items = []
        spine_items = []
        nav_items = []
        chapter_docs = []

        for index, chapter in enumerate(chapters, start=1):
            item_id = f"chapter-{index:03d}"
            filename = f"chapter-{index:03d}.xhtml"
            heading = chapter.title or f"第{index}章"
            chapter_items.append(
                f'<item id="{item_id}" href="{filename}" media-type="application/xhtml+xml"/>'
            )
            spine_items.append(f'<itemref idref="{item_id}"/>')
            nav_items.append(f'<li><a href="{filename}">{escape(heading)}</a></li>')
            chapter_docs.append((filename, self._chapter_xhtml(metadata, heading, chapter)))

        creator = escape(metadata.get("author") or "")
        content_opf = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">{identifier}</dc:identifier>
    <dc:title>{escape(metadata["title"])}</dc:title>
    <dc:creator>{creator}</dc:creator>
    <dc:language>{escape(metadata.get("language") or "zh-CN")}</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    {''.join(chapter_items)}
  </manifest>
  <spine>
    {''.join(spine_items)}
  </spine>
</package>'''
        nav_xhtml = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>{''.join(nav_items)}</ol></nav></body>
</html>'''
        container_xml = '''<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>'''
        css = "body{font-family:serif;line-height:1.75;margin:5%;}h1{text-align:center;}p{text-indent:2em;margin:.6em 0;}"

        with ZipFile(path, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
            archive.writestr("META-INF/container.xml", container_xml, compress_type=ZIP_DEFLATED)
            archive.writestr("OEBPS/content.opf", content_opf, compress_type=ZIP_DEFLATED)
            archive.writestr("OEBPS/nav.xhtml", nav_xhtml, compress_type=ZIP_DEFLATED)
            archive.writestr("OEBPS/style.css", css, compress_type=ZIP_DEFLATED)
            for filename, document in chapter_docs:
                archive.writestr(f"OEBPS/{filename}", document, compress_type=ZIP_DEFLATED)

    def _chapter_xhtml(self, metadata: dict, heading: str, chapter: Chapter) -> str:
        body = self._paragraphs_to_xhtml(self._chapter_translation(chapter))
        return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>{escape(heading)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section><h1>{escape(heading)}</h1>{body}</section></body>
</html>'''

