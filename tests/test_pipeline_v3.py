import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

from src.agents.glossary_manager import GlossaryManager
from src.core.epub_reader import EpubReader
from src.core.exporter import BookExporter
from src.core.history import TranslationMemory
from src.core.preprocessor import TextPreprocessor
from src.core.schemas import Chapter, ChunkStatus, TextChunk
from src.core.text_normalization import normalize_chinese_quote_style
from src.core.translator import TranslationConfig, TranslationEngine


def _write_test_epub(path: Path) -> None:
    container = """<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="book/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>"""
    opf = """<?xml version="1.0" encoding="utf-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Test Book</dc:title><dc:creator>Test Author</dc:creator>
      </metadata>
      <manifest>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>"""
    c1 = """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ignored</title></head>
    <body><h1>1</h1><p>First paragraph contains several useful words.</p><p>Second paragraph also contains useful words.</p></body></html>"""
    c2 = """<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Afterword</h1>
    <p>Closing text is long enough for this content section.</p></body></html>"""
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("book/content.opf", opf)
        archive.writestr("book/c1.xhtml", c1)
        archive.writestr("book/c2.xhtml", c2)


class FakeLLM:
    def __init__(self):
        self.calls = []

    def chat(self, messages, purpose, **kwargs):
        self.calls.append((purpose, messages, kwargs))
        if purpose == "draft":
            response = """<response>
            <analysis>注意观察者视角。</analysis>
            <translation>第一层译文。</translation>
            <memory_summary>人物抵达观测站，尚不知道信号来源。</memory_summary>
            <new_terms></new_terms><relations></relations></response>"""
        else:
            response = "<final_translation>最终译文。</final_translation>"
        return iter([("content", response)])


class RetryingPolishLLM:
    def __init__(self, retry_succeeds=True):
        self.calls = []
        self.retry_succeeds = retry_succeeds

    def chat(self, messages, purpose, **kwargs):
        self.calls.append((purpose, messages, kwargs))
        if purpose == "draft":
            response = """<response><analysis>无。</analysis>
            <translation>第一段完整初稿。\n\n第二段完整初稿。</translation>
            <memory_summary>摘要。</memory_summary>
            <new_terms></new_terms><relations></relations></response>"""
        elif len([call for call in self.calls if call[0] == "polish"]) == 1:
            response = "<final_translation>只有第一段。</final_translation>"
        elif self.retry_succeeds:
            response = "<final_translation>第一段完整定稿。\n\n第二段完整定稿。</final_translation>"
        else:
            response = "<final_translation>仍然只有一段。</final_translation>"
        return iter([("content", response)])


class PipelineTests(unittest.TestCase):
    def test_chinese_quote_normalization_preserves_word_apostrophes(self):
        text = "「'Everything is done.'」don't \"again\" «Never.»"
        self.assertEqual(
            normalize_chinese_quote_style(text),
            "“‘Everything is done.’”don't “again” “Never.”",
        )

    def test_epub_spine_and_chapter_markers(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            epub = Path(temp_dir) / "book.epub"
            _write_test_epub(epub)
            document = EpubReader.read(epub)
            self.assertEqual(document.title, "Test Book")
            self.assertEqual([s.title for s in document.sections], ["1", "Afterword"])
            text = EpubReader.to_chapter_marked_text(document)
            self.assertIn("Chapter 1", text)
            self.assertIn("Chapter 2\n\nAfterword", text)
            self.assertNotIn("<p>", text)

    def test_chunking_uses_requested_limit_without_overlap(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            epub = Path(temp_dir) / "book.epub"
            _write_test_epub(epub)
            book = TextPreprocessor(max_chunk_tokens=10, overlap_sentences=0).create_book(
                str(epub), "test", "Test"
            )
            self.assertEqual(len(book.chapters), 2)
            all_chunks = [chunk for chapter in book.chapters for chunk in chapter.chunks]
            self.assertTrue(all((chunk.token_count or 0) <= 10 for chunk in all_chunks))
            sources = " ".join(chunk.source_text for chunk in all_chunks)
            self.assertEqual(sources.count("First paragraph contains several useful words."), 1)

    def test_long_term_memory_is_cross_chapter_and_bounded(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            memory = TranslationMemory(Path(temp_dir))
            chapter = Chapter(
                id="ch01", title="Chapter 1", index=0, source_text="source", chunks=[]
            )
            chunk = TextChunk(
                id="ch01_000",
                chapter_id="ch01",
                index=0,
                source_text="original context",
                final_translation="译文上下文",
                memory_summary="这是自包含摘要",
                status=ChunkStatus.COMPLETED,
            )
            chapter.chunks = [chunk]
            memory.initialize_chapter(chapter)
            memory.update_long_term_memory(chunk, recent_chunks=2)
            next_chunk = TextChunk(
                id="ch02_000", chapter_id="ch02", index=0, source_text="next"
            )
            context = memory.get_context_for_chunk(next_chunk, recent_chunks=2)
            self.assertIn("这是自包含摘要", context)
            self.assertIn("译文上下文", context)
            state = json.loads(memory.long_term_memory_file.read_text(encoding="utf-8"))
            self.assertEqual(state["last_updated_chunk"], "ch01_000")

    def test_translation_engine_makes_exactly_two_calls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_llm = FakeLLM()
            glossary = GlossaryManager(str(Path(temp_dir) / "glossary"))
            engine = TranslationEngine(
                llm_manager=fake_llm,
                glossary_manager=glossary,
                prompts={},
                config=TranslationConfig(enable_polish=True),
            )
            chunk = TextChunk(
                id="ch01_000", chapter_id="ch01", index=0, source_text="Source."
            )
            result = engine.translate_chunk(chunk, memory_context="旧摘要")
            self.assertEqual([call[0] for call in fake_llm.calls], ["draft", "polish"])
            self.assertEqual(result.draft_translation, "第一层译文。")
            self.assertEqual(result.final_translation, "最终译文。")
            self.assertEqual(result.memory_summary, "人物抵达观测站，尚不知道信号来源。")
            self.assertEqual(result.status, ChunkStatus.COMPLETED)

    def test_independent_semantic_hint_reaches_both_translation_layers(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_llm = FakeLLM()
            engine = TranslationEngine(
                llm_manager=fake_llm,
                glossary_manager=GlossaryManager(str(Path(temp_dir) / "glossary")),
                prompts={},
                config=TranslationConfig(enable_polish=True),
            )
            hint = "同一离去动作在普通视角和拟景视角中连续呈现；只作强暗示。"
            result = engine.translate_chunk(
                TextChunk(
                    id="ch01_000",
                    chapter_id="ch01",
                    index=0,
                    source_text="Source.",
                ),
                semantic_obligations_hint=hint,
            )
            draft_prompt = fake_llm.calls[0][1][-1]["content"]
            polish_prompt = fake_llm.calls[1][1][-1]["content"]
            self.assertIn("<semantic_obligations_hint>", draft_prompt)
            self.assertIn(hint, draft_prompt)
            self.assertIn(hint, polish_prompt)
            self.assertEqual(result.semantic_obligations, hint)

    def test_truncated_polish_is_retried_and_complete_retry_is_used(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_llm = RetryingPolishLLM(retry_succeeds=True)
            engine = TranslationEngine(
                llm_manager=fake_llm,
                glossary_manager=GlossaryManager(str(Path(temp_dir) / "glossary")),
                config=TranslationConfig(enable_polish=True),
            )
            chunk = TextChunk(
                id="ch01_000",
                chapter_id="ch01",
                index=0,
                source_text="First paragraph.\n\nSecond paragraph.",
            )
            result = engine.translate_chunk(chunk)
            self.assertEqual([call[0] for call in fake_llm.calls], ["draft", "polish", "polish"])
            self.assertEqual(result.final_translation, "第一段完整定稿。\n\n第二段完整定稿。")
            self.assertEqual(result.polish_retry_count, 1)
            self.assertEqual(result.status, ChunkStatus.COMPLETED)

    def test_twice_truncated_polish_falls_back_to_complete_draft(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_llm = RetryingPolishLLM(retry_succeeds=False)
            engine = TranslationEngine(
                llm_manager=fake_llm,
                glossary_manager=GlossaryManager(str(Path(temp_dir) / "glossary")),
                config=TranslationConfig(enable_polish=True),
            )
            chunk = TextChunk(
                id="ch01_000",
                chapter_id="ch01",
                index=0,
                source_text="First paragraph.\n\nSecond paragraph.",
            )
            result = engine.translate_chunk(chunk)
            self.assertEqual(result.final_translation, "第一段完整初稿。\n\n第二段完整初稿。")
            self.assertEqual(result.status, ChunkStatus.HUMAN_REVIEW)
            self.assertIn("已回退到完整初稿", result.quality_warnings[-1])

    def test_afterword_bibliography_may_merge_wrapped_reference_lines(self):
        reference = (
            "Afterword\n\nIntroductory note about the references.\n\n"
            "A Book by A. Author,\n\nPublisher, 2000.\n\nTHE END"
        )
        candidate = (
            "Afterword\n\nIntroductory note about the references.\n\n"
            "A Book by A. Author, Publisher, 2000.\n\nTHE END"
        )
        problems = TranslationEngine._translation_shape_problems(
            reference,
            candidate,
            stage="第一层译稿",
            min_length_ratio=0.15,
        )
        self.assertEqual(problems, [])

    def test_exporter_writes_txt_and_valid_epub_and_rejects_incomplete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            memory = TranslationMemory(root)
            config_file = root / "config.yaml"
            config_file.write_text(
                "title: Incandescence\nauthor: Greg Egan\nlanguage: zh-CN\n",
                encoding="utf-8",
            )
            pending = TextChunk(
                id="ch01_000", chapter_id="ch01", index=0, source_text="Source."
            )
            chapter = Chapter(
                id="ch01", title="Chapter 1", index=0, source_text="Source.", chunks=[pending]
            )
            memory.initialize_chapter(chapter)
            project = SimpleNamespace(
                book_id="incandescence",
                root_dir=root,
                config_file=config_file,
                memory=memory,
            )
            exporter = BookExporter(project)
            with self.assertRaisesRegex(ValueError, "1 个文本块未完成"):
                exporter.export()

            pending.status = ChunkStatus.COMPLETED
            pending.final_translation = "第一段。\n\n第二段。"
            memory.save_chunk(pending)
            result = exporter.export()
            self.assertTrue(result.txt_path.exists())
            self.assertTrue(result.epub_path.exists())
            txt = result.txt_path.read_text(encoding="utf-8-sig")
            self.assertIn("作者：Greg Egan", txt)
            self.assertIn("第一段。", txt)
            with ZipFile(result.epub_path) as archive:
                self.assertEqual(archive.namelist()[0], "mimetype")
                self.assertEqual(archive.read("mimetype"), b"application/epub+zip")
                self.assertIn("OEBPS/chapter-001.xhtml", archive.namelist())
                self.assertIn("第一段".encode("utf-8"), archive.read("OEBPS/chapter-001.xhtml"))


if __name__ == "__main__":
    unittest.main()
