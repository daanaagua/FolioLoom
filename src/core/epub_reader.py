"""Minimal EPUB reader used by the translation preprocessor.

The implementation intentionally relies only on the Python standard library.
It follows the EPUB container -> OPF manifest -> spine order and extracts
paragraph-preserving plain text from XHTML documents.
"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, List, Optional
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


@dataclass
class EpubSection:
    title: str
    text: str
    source_path: str


@dataclass
class EpubDocument:
    title: str
    author: str
    sections: List[EpubSection]


class _XhtmlTextParser(HTMLParser):
    BLOCK_TAGS = {
        "address", "article", "aside", "blockquote", "div", "figcaption",
        "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li",
        "main", "p", "section", "table", "tr",
    }
    SKIP_TAGS = {"script", "style", "svg", "math", "nav"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: List[str] = []
        self._skip_depth = 0
        self._body_depth = 0
        self._heading_tag: Optional[str] = None
        self._heading_parts: List[str] = []
        self.headings: List[str] = []

    def _newline(self) -> None:
        if self._parts and not self._parts[-1].endswith("\n"):
            self._parts.append("\n")

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag == "body":
            self._body_depth += 1
            return
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth or self._body_depth == 0:
            return
        if tag in self.BLOCK_TAGS:
            self._newline()
        if tag == "br":
            self._newline()
        if tag in {"h1", "h2", "h3"} and self._heading_tag is None:
            self._heading_tag = tag
            self._heading_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "body":
            self._body_depth = max(0, self._body_depth - 1)
            return
        if tag in self.SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if self._heading_tag == tag:
            heading = " ".join("".join(self._heading_parts).split())
            if heading:
                self.headings.append(heading)
            self._heading_tag = None
            self._heading_parts = []
        if tag in self.BLOCK_TAGS:
            self._newline()

    def handle_data(self, data: str) -> None:
        if self._skip_depth or self._body_depth == 0:
            return
        normalized = " ".join(data.split())
        if not normalized:
            return
        if self._parts and not self._parts[-1].endswith((" ", "\n")):
            self._parts.append(" ")
        self._parts.append(normalized)
        if self._heading_tag:
            self._heading_parts.append(normalized)

    def get_text(self) -> str:
        text = "".join(self._parts)
        lines = [" ".join(line.split()) for line in text.splitlines()]
        compact: List[str] = []
        for line in lines:
            if line:
                compact.append(line)
            elif compact and compact[-1] != "":
                compact.append("")
        return "\n\n".join(line for line in compact if line).strip()


class EpubReader:
    """Read EPUB metadata and spine-ordered textual sections."""

    CONTENT_MEDIA_TYPES = {"application/xhtml+xml", "text/html"}
    NON_CONTENT_TITLES = {
        "cover", "title", "title page", "titlepage", "copyright", "contents",
        "table of contents", "toc", "annotation",
    }

    @staticmethod
    def _local_name(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    @classmethod
    def _first_text(cls, root: ET.Element, local_name: str) -> str:
        for node in root.iter():
            if cls._local_name(node.tag) == local_name and node.text:
                return " ".join(node.text.split())
        return ""

    @classmethod
    def _find_rootfile(cls, archive: ZipFile) -> str:
        try:
            container = ET.fromstring(archive.read("META-INF/container.xml"))
        except KeyError as exc:
            raise ValueError("EPUB 缺少 META-INF/container.xml") from exc
        for node in container.iter():
            if cls._local_name(node.tag) == "rootfile":
                path = node.attrib.get("full-path")
                if path:
                    return path
        raise ValueError("EPUB container.xml 中没有 rootfile")

    @staticmethod
    def _decode_xhtml(raw: bytes) -> str:
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "windows-1252"):
            try:
                return raw.decode(encoding)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="replace")

    @classmethod
    def read(cls, file_path: str | Path) -> EpubDocument:
        path = Path(file_path)
        try:
            archive = ZipFile(path)
        except BadZipFile as exc:
            raise ValueError(f"不是有效的 EPUB/ZIP 文件: {path}") from exc

        with archive:
            opf_path = cls._find_rootfile(archive)
            try:
                opf_root = ET.fromstring(archive.read(opf_path))
            except KeyError as exc:
                raise ValueError(f"EPUB 缺少 OPF 文件: {opf_path}") from exc

            title = cls._first_text(opf_root, "title") or path.stem
            author = cls._first_text(opf_root, "creator")
            opf_dir = str(PurePosixPath(opf_path).parent)
            if opf_dir == ".":
                opf_dir = ""

            manifest: Dict[str, Dict[str, str]] = {}
            for node in opf_root.iter():
                if cls._local_name(node.tag) != "item":
                    continue
                item_id = node.attrib.get("id")
                href = node.attrib.get("href")
                if item_id and href:
                    manifest[item_id] = {
                        "href": href,
                        "media_type": node.attrib.get("media-type", ""),
                        "properties": node.attrib.get("properties", ""),
                    }

            spine: List[tuple[str, bool]] = []
            for node in opf_root.iter():
                if cls._local_name(node.tag) == "itemref":
                    idref = node.attrib.get("idref")
                    if idref:
                        spine.append((idref, node.attrib.get("linear", "yes") != "no"))

            sections: List[EpubSection] = []
            for idref, linear in spine:
                item = manifest.get(idref)
                if not item or not linear:
                    continue
                if item["media_type"] not in cls.CONTENT_MEDIA_TYPES:
                    continue
                if "nav" in item["properties"].split():
                    continue

                content_path = str(PurePosixPath(opf_dir) / item["href"])
                try:
                    raw = archive.read(content_path)
                except KeyError:
                    continue
                parser = _XhtmlTextParser()
                parser.feed(cls._decode_xhtml(raw))
                text = parser.get_text()
                if len(text) < 40:
                    continue
                section_title = parser.headings[0] if parser.headings else PurePosixPath(item["href"]).stem
                if section_title.strip().lower() in cls.NON_CONTENT_TITLES:
                    continue
                sections.append(EpubSection(section_title, text, content_path))

            if not sections:
                raise ValueError("EPUB 书脊中没有可读取的正文 XHTML")
            return EpubDocument(title=title, author=author, sections=sections)

    @classmethod
    def to_chapter_marked_text(cls, document: EpubDocument) -> str:
        """Convert sections to text with stable chapter markers.

        Numeric headings keep their original number. Other narrative sections
        receive a sequential marker while preserving their displayed heading.
        """
        rendered: List[str] = []
        fallback_index = 1
        for section in document.sections:
            heading = section.title.strip()
            if heading.isdigit():
                chapter_number = int(heading)
                fallback_index = max(fallback_index, chapter_number + 1)
            else:
                chapter_number = fallback_index
                fallback_index += 1

            body = section.text
            body_lines = body.splitlines()
            if body_lines and body_lines[0].strip().casefold() == heading.casefold():
                body = "\n".join(body_lines[1:]).strip()
            display_heading = "" if heading.isdigit() else heading
            rendered.append(
                f"Chapter {chapter_number}\n\n{display_heading}\n\n{body}".strip()
            )
        return "\n\n".join(rendered)
