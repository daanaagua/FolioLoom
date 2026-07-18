import json
import io
import hashlib
import tempfile
import unittest
from contextlib import closing
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, patch

from src.core.history import TranslationMemory
from src.core.schemas import Chapter, ChunkStatus, TermStatus, TextChunk
from src.core.translator import TranslationEngine
from src.core.v4.context import ContextBuilder, ContextOverflow
from src.core.v4.database import V4Database
from src.core.v4.exporter import ParallelV4BookExporter
from src.core.v4.migration import V4Migrator
from src.core.v4.models import ScanOutcome, ScanResponse, TranslationOutcome, V4BlockStatus
from src.core.v4.pipeline import V4PipelineConfig, V4TranslationPipeline
from src.core.v4.revalidation import RevalidationPlanner
from src.core.v4.scanner import ScanProtocolError, V4Scanner
from src.core.v4.semantic_mapper import SemanticMapper
from src.core.v4.validation import V4Validator


class FakeScanLLM:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = 0

    def get_model(self, purpose):
        return "fake-scan"

    def chat(self, **kwargs):
        self.calls += 1
        return next(self.responses)


class FakeTranslationLLM:
    def __init__(self, counter=None):
        self.counter = counter if counter is not None else {"calls": 0}

    def get_model(self, purpose):
        return f"fake-{purpose}"

    def chat(self, messages, purpose="draft", stream=False, **kwargs):
        self.counter["calls"] += 1
        source = messages[-1]["content"].split("<text_to_translate>\n", 1)[-1].split(
            "\n</text_to_translate>", 1
        )[0]
        paragraphs = [part.strip() for part in source.split("\n\n") if part.strip()]
        translated = "\n\n".join(f"译文：{part}" for part in paragraphs)
        payload = json.dumps(
            {
                "analysis": "保持信息",
                "translation": translated,
                "memory_summary": "本岛继续",
                "new_terms": [
                    {"src": "Archon", "tgt": "执政官", "type": "title", "context": "职衔"}
                ]
                if "Archon" in source
                else [],
                "relations": [],
            },
            ensure_ascii=False,
        )

        def generator():
            yield ("content", payload)

        return generator() if stream else payload


class BrokenTranslationLLM:
    def get_model(self, purpose):
        return f"broken-{purpose}"

    def chat(self, *, stream=False, **_kwargs):
        def generator():
            yield ("content", "this is not a structured translation response")

        return generator() if stream else "this is not a structured translation response"


class FakePreparationLLM:
    def get_model(self, purpose):
        return f"fake-{purpose}"

    @staticmethod
    def _payload(messages):
        for message in reversed(messages):
            try:
                return json.loads(message["content"])
            except (KeyError, TypeError, json.JSONDecodeError):
                continue
        raise AssertionError("preparation request did not contain JSON")

    def chat(self, *, messages, purpose, **_kwargs):
        payload = self._payload(messages)
        if purpose == "candidate_adjudication":
            return json.dumps(
                {
                    "decisions": [
                        {
                            "cluster_id": cluster["cluster_id"],
                            "verdict": "promote",
                            "selected_ids": [cluster["alternatives"][0]["id"]],
                            "entity_kind": "person",
                            "confidence": 0.99,
                            "reason": "",
                        }
                        for cluster in payload["clusters"]
                    ]
                }
            )
        if purpose == "working_target":
            return json.dumps(
                {
                    "decisions": [
                        {
                            "concept_id": concept["concept_id"],
                            "working_target": "固定译名",
                            "rules": [],
                            "confidence": 0.99,
                        }
                        for concept in payload["concepts"]
                    ]
                },
                ensure_ascii=False,
            )
        raise AssertionError(f"unexpected preparation purpose: {purpose}")


class FakeReferencePolishLLM:
    def __init__(self):
        self.calls = []

    def get_model(self, purpose):
        return f"fake-{purpose}"

    def chat(self, messages, purpose="draft", stream=False, **kwargs):
        self.calls.append({"purpose": purpose, "messages": messages})
        if purpose == "draft":
            payload = json.dumps(
                {
                    "analysis": "FIRST_LAYER_SELF_EVALUATION",
                    "semantic_obligations": (
                        "同一事件在不同感知层中呈现；保持暗示，不得直接宣布等同。"
                    ),
                    "translation": "这是完整的第一层译文。",
                    "memory_summary": "阿尔法开始。",
                    "new_terms": [],
                    "relations": [],
                },
                ensure_ascii=False,
            )
        else:
            payload = "「这是综合两稿后的完整译文。」"

        def generator():
            yield ("content", payload)

        return generator() if stream else payload


class FakeSemanticLLM:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class ParallelV4Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "book"
        self.root.mkdir(parents=True)
        self.database = V4Database(self.root)
        self.edition = self.database.ensure_source_edition("raw", "normalized", "test", "source.txt")

    def tearDown(self):
        self.temp.cleanup()

    def add_blocks(self, texts, status="pending"):
        rows = []
        for index, source in enumerate(texts):
            rows.append(
                {
                    "id": f"ch01_{index:03d}",
                    "chapter_id": "ch01",
                    "chapter_title": "第一章",
                    "chapter_index": 0,
                    "block_index": index,
                    "global_index": index,
                    "block_type": "prose",
                    "source_text": source,
                    "source_hash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                    "token_count": len(source.split()),
                    "status": status,
                }
            )
        self.database.upsert_blocks(self.edition, rows)
        return self.database.list_blocks()

    def test_pipeline_glossary_uses_frozen_rendered_target_for_each_block_context(self):
        self.add_blocks(
            ["Archon, hear me.", "The Archon sat in the tavern."], status="ready"
        )
        concept_id = self.database.import_legacy_concept(
            "Archon", "", "title", "office"
        )
        self.database.apply_working_target_decisions(
            [{"concept_id": concept_id, "target": "执政官", "rules": []}]
        )
        version = self.database.current_knowledge_version()
        with self.database.transaction() as connection:
            lexeme_id = connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
            ).fetchone()[0]
            evidence_id = connection.execute(
                """INSERT INTO evidence(
                       block_id, paragraph_id, kind, source_form, evidence_quote,
                       payload_json, confidence, extractor, run_id, created_at)
                   VALUES('ch01_000', 'P000', 'test', 'Archon', 'Archon', ?,
                          1.0, 'test', NULL, 'now')""",
                (json.dumps({"speaker_id": "severian", "thread_id": "court"}),),
            ).lastrowid
            connection.execute(
                """INSERT INTO mentions(
                       block_id, paragraph_id, source_form, normalized_form,
                       discourse_function, lexeme_id, concept_id, evidence_id)
                   VALUES('ch01_000', 'P000', 'Archon', 'archon', 'vocative',
                          ?, ?, ?)""",
                (lexeme_id, concept_id, evidence_id),
            )
            connection.execute(
                """INSERT INTO form_occurrences(
                       lexeme_id, block_id, start_offset, end_offset,
                       source_form, source_hash, created_at)
                   VALUES(?, 'ch01_000', 0, 6, 'Archon', 'hash-0', 'now')""",
                (lexeme_id,),
            )
            connection.execute(
                """INSERT INTO rendering_rules(
                       id, lexeme_id, condition_json, target, priority, status,
                       scope, locked, created_version, created_at)
                   VALUES('archon-block-vocative', ?, ?, '阁下', 100, 'verified',
                          'book', 1, ?, 'now')""",
                (
                    lexeme_id,
                    json.dumps(
                        {
                            "block_id": "ch01_000",
                            "discourse_function": "vocative",
                            "speaker_id": "severian",
                            "thread_id": "court",
                            "start_offset": 0,
                            "end_offset": 6,
                        },
                        separators=(",", ":"),
                    ),
                    version,
                ),
            )
        _, frozen, _ = self.database.freeze_translation_knowledge()
        blocks = self.database.list_blocks()
        pipeline = V4TranslationPipeline(self.database, lambda: None)

        vocative = pipeline._glossary_for(
            [blocks[0]], concept_snapshot=frozen
        ).glossary.items
        tavern = pipeline._glossary_for(
            [blocks[1]], concept_snapshot=frozen
        ).glossary.items

        self.assertEqual([item.default_target for item in vocative], ["阁下"])
        self.assertEqual([item.default_target for item in tavern], ["执政官"])
        self.assertEqual(vocative[0].rules, [])

    def test_same_form_occurrence_targets_are_both_visible_in_final_glossary_prompt(self):
        block = self.add_blocks(
            ["Archon called; Archon answered."], status="ready"
        )[0]
        concept_id = self.database.import_legacy_concept(
            "Archon", "", "title", "office"
        )
        self.database.apply_working_target_decisions(
            [{"concept_id": concept_id, "target": "ORDINARY", "rules": []}]
        )
        version = self.database.current_knowledge_version()
        with self.database.transaction() as connection:
            lexeme_id = connection.execute(
                "SELECT primary_lexeme_id FROM concepts WHERE id=?", (concept_id,)
            ).fetchone()[0]
            for start, end, discourse in (
                (0, 6, "vocative"),
                (15, 21, "referential"),
            ):
                payload = json.dumps(
                    {"start_offset": start, "end_offset": end},
                    separators=(",", ":"),
                )
                evidence_id = connection.execute(
                    """INSERT INTO evidence(
                           block_id, paragraph_id, kind, source_form,
                           evidence_quote, payload_json, confidence, extractor,
                           run_id, created_at)
                       VALUES(?, 'P000', 'test', 'Archon', 'Archon', ?, 1.0,
                              'test', NULL, 'now')""",
                    (block.id, payload),
                ).lastrowid
                connection.execute(
                    """INSERT INTO mentions(
                           block_id, paragraph_id, source_form, normalized_form,
                           discourse_function, lexeme_id, concept_id, evidence_id)
                       VALUES(?, 'P000', 'Archon', 'archon', ?, ?, ?, ?)""",
                    (block.id, discourse, lexeme_id, concept_id, evidence_id),
                )
                connection.execute(
                    """INSERT OR IGNORE INTO form_occurrences(
                           lexeme_id, block_id, start_offset, end_offset,
                           source_form, source_hash, created_at)
                       VALUES(?, ?, ?, ?, 'Archon', ?, 'now')""",
                    (lexeme_id, block.id, start, end, block.source_hash),
                )
            connection.execute(
                """INSERT INTO rendering_rules(
                       id, lexeme_id, condition_json, target, priority, status,
                       scope, locked, created_version, created_at)
                   VALUES('archon-first-vocative', ?, ?, 'VOCATIVE', 100,
                          'verified', 'book', 1, ?, 'now')""",
                (
                    lexeme_id,
                    json.dumps(
                        {
                            "discourse_function": "vocative",
                            "start_offset": 0,
                            "end_offset": 6,
                        },
                        separators=(",", ":"),
                    ),
                    version,
                ),
            )

        _, frozen, _ = self.database.freeze_translation_knowledge()
        manager = V4TranslationPipeline(self.database, lambda: None)._glossary_for(
            [block], concept_snapshot=frozen
        )
        visible = manager.find_terms_in_text(
            block.source_text, status_filter=list(TermStatus)
        )
        rendered = "\n".join(
            TranslationEngine._render_glossary_term(item) for item in visible
        )

        self.assertEqual(len(visible), 2)
        self.assertIn("VOCATIVE", rendered)
        self.assertIn("ORDINARY", rendered)
        self.assertIn("0:6", rendered)
        self.assertIn("15:21", rendered)

    def test_island_prefetches_rendering_contexts_once(self):
        self.add_blocks([f"Block {index}." for index in range(5)], status="ready")
        original = self.database.freeze_render_bundle
        calls = []

        def counted(block_ids):
            calls.append(tuple(block_ids))
            return original(block_ids)

        self.database.freeze_render_bundle = counted
        pipeline = V4TranslationPipeline(
            self.database,
            lambda: FakeTranslationLLM(),
            config=V4PipelineConfig(
                island_size=5,
                initial_workers=1,
                max_workers=1,
                enable_polish=False,
                enable_semantic_mapper=False,
            ),
        )

        result = pipeline.run()

        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0]), 5)

    def test_failed_draft_does_not_emit_term_missing_warnings(self):
        block = self.add_blocks(["Archon spoke."], status="ready")[0]
        concept_id = self.database.import_legacy_concept(
            "Archon", "", "title", "office"
        )
        self.database.apply_working_target_decisions(
            [
                {
                    "concept_id": concept_id,
                    "target": "执政官",
                    "semantic_core": "正式政治职衔。",
                    "contrast_sources": [],
                    "rules": [],
                }
            ]
        )
        pipeline = V4TranslationPipeline(
            self.database,
            lambda: BrokenTranslationLLM(),
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                max_attempts=1,
                enable_polish=False,
                enable_semantic_mapper=False,
            ),
        )

        result = pipeline.run()

        self.assertEqual(result["failed_retryable"], 1)
        with closing(self.database.connect()) as connection:
            stored = connection.execute(
                """SELECT status, warnings_json FROM translation_versions
                   WHERE block_id=? AND pipeline='parallel_v4' AND active=1""",
                (block.id,),
            ).fetchone()
        self.assertEqual(stored["status"], "failed_retryable")
        self.assertEqual(json.loads(stored["warnings_json"]), [])

    def test_glossary_items_and_visible_characters_are_hard_bounded(self):
        source = " ".join(f"Name{index}" for index in range(500))
        block = self.add_blocks([source], status="ready")[0]
        version = self.database.current_knowledge_version()
        with self.database.transaction() as connection:
            for index in range(500):
                lexeme_id = f"lex-limit-{index:03d}"
                form = f"Name{index}"
                connection.execute(
                    """INSERT INTO lexemes(
                           id, language, normalized_form, canonical_form,
                           working_target, created_version, created_at)
                       VALUES(?, 'en', lower(?), ?, ?, ?, 'now')""",
                    (lexeme_id, form, form, f"TARGET-{index}", version),
                )
                connection.execute(
                    """INSERT INTO source_forms(
                           lexeme_id, form, normalized_form, grammar_json)
                       VALUES(?, ?, lower(?), '{}')""",
                    (lexeme_id, form, form),
                )
        _, frozen, _ = self.database.freeze_translation_knowledge()
        pipeline = V4TranslationPipeline(
            self.database,
            lambda: None,
            config=V4PipelineConfig(max_context_chars=1024),
        )

        manager = pipeline._glossary_for([block], concept_snapshot=frozen)
        visible = manager.find_terms_in_text(
            block.source_text, status_filter=list(TermStatus)
        )
        rendered = "\n".join(
            TranslationEngine._render_glossary_term(item) for item in visible
        )

        self.assertLessEqual(len(visible), 128)
        self.assertLessEqual(len(rendered), 1024)
        self.assertGreater(manager.render_limit_metadata["omitted"], 0)
        self.assertTrue(manager.render_warnings)

        captured = []
        original_commit = self.database.commit_translation_batch

        def capture_commit(run_id, outcomes, **kwargs):
            captured.extend(outcomes)
            return original_commit(run_id, outcomes, **kwargs)

        self.database.commit_translation_batch = capture_commit
        production = V4TranslationPipeline(
            self.database,
            lambda: FakeTranslationLLM(),
            config=V4PipelineConfig(
                max_context_chars=50000,
                island_size=1,
                initial_workers=1,
                max_workers=1,
                enable_polish=False,
                enable_semantic_mapper=False,
            ),
        )
        result = production.run()

        self.assertEqual(result["status"], "completed")
        self.assertTrue(captured[0].matched_renderings)
        self.assertEqual(captured[0].matched_renderings[0].matched_form, "Name0")
        warning = captured[0].quality_warnings[0]
        self.assertEqual(warning["kind"], "render_constraints_truncated")
        self.assertEqual(warning["total"], 500)
        self.assertEqual(warning["kept"], 128)
        self.assertEqual(warning["omitted"], 372)
        with closing(self.database.connect()) as connection:
            stored = json.loads(
                connection.execute(
                    """SELECT warnings_json FROM translation_versions
                       WHERE block_id=? AND active=1""",
                    (block.id,),
                ).fetchone()[0]
            )
            audit_ids = [
                int(row[0])
                for row in connection.execute(
                    """SELECT id FROM audit_calls
                       WHERE block_id=? AND accepted=1""",
                    (block.id,),
                ).fetchall()
            ]
            blocking = connection.execute(
                """SELECT COUNT(*) FROM human_queue
                   WHERE block_id=? AND severity='blocking'
                     AND kind='render_constraints_truncated'""",
                (block.id,),
            ).fetchone()[0]
        self.assertIn(warning, stored)
        audit_payloads = [
            self.database.read_audit_payload(audit_id).get("parsed") or {}
            for audit_id in audit_ids
        ]
        self.assertTrue(
            any(warning in payload.get("quality_warnings", []) for payload in audit_payloads)
        )
        self.assertEqual(blocking, 0)

    def test_local_scan_indexes_candidates_and_legacy_reconcile_is_conservative(self):
        blocks = self.add_blocks(["Archon spoke.", "archon waited.", "Archons gathered."])
        fake = FakeScanLLM([])
        scanner = V4Scanner(self.database, fake, max_attempts=1)
        candidate = next(
            item for item in scanner.extractor.extract(blocks[0])
            if item.normalized_text == "Archon"
        )
        outcome = scanner.scan_block(blocks[0])
        self.assertIsNotNone(outcome.response)
        self.assertEqual(outcome.response.mentions, [])
        self.assertEqual(fake.calls, 0)

        self.database.start_run("candidate-test", "scan", {})
        self.database.commit_candidate_index_batch("candidate-test", [outcome])
        self.database.finish_run("candidate-test", "completed")
        with closing(self.database.connect()) as connection:
            stored = connection.execute(
                "SELECT original_text, selected FROM lexical_candidates WHERE id=?",
                (candidate.id,),
            ).fetchone()
        self.assertEqual(stored["original_text"], "Archon")
        self.assertEqual(stored["selected"], 0)

        responses = []
        for form in ["Archon", "archon", "Archons"]:
            responses.append(
                ScanOutcome(
                    block=blocks[len(responses)],
                    response=ScanResponse.model_validate(
                        {
                            "mentions": [
                                {
                                    "paragraph_id": "P000",
                                    "source_form": form,
                                    "category": "title",
                                    "suggested_target": "执政官",
                                    "description": "职衔",
                                    "discourse_function": "referential",
                                    "evidence_quote": form,
                                    "confidence": 0.9,
                                }
                            ],
                            "ambiguities": [],
                        }
                    ),
                )
            )
        self.database.start_run("scan-test", "scan", {})
        self.database.commit_scan_batch("scan-test", list(reversed(responses)), "fake")
        self.database.finish_run("scan-test", "completed")
        self.database.reconcile_exact_forms()
        with closing(self.database.connect()) as connection:
            concepts = connection.execute(
                "SELECT source_form, concept_id FROM mentions ORDER BY id"
            ).fetchall()
            targets = {
                row["canonical_source"]: row["default_target"]
                for row in connection.execute(
                    "SELECT canonical_source, default_target FROM concepts"
                )
            }
        by_form = {}
        for row in concepts:
            by_form.setdefault(row["source_form"], row["concept_id"])
        self.assertEqual(by_form["Archon"], by_form["archon"])
        self.assertNotEqual(by_form["Archon"], by_form["Archons"])
        self.assertEqual(targets["Archon"], "")
        self.assertEqual(targets["Archons"], "")

    def test_scan_repairs_only_uniquely_mislocated_evidence(self):
        response = ScanResponse.model_validate(
            {
                "mentions": [
                    {
                        "paragraph_id": "P000",
                        "source_form": "Zak",
                        "evidence_quote": "Zak",
                    }
                ],
                "ambiguities": [],
            }
        )
        paragraphs = {"P000": "No name here.", "P001": "Zak answered."}
        V4Scanner._repair_unique_evidence_locations(response, paragraphs)
        self.assertEqual(response.mentions[0].paragraph_id, "P001")
        V4Scanner._validate_evidence(response, paragraphs)

        ambiguous = ScanResponse.model_validate(
            {
                "mentions": [
                    {
                        "paragraph_id": "P000",
                        "source_form": "Zak",
                        "evidence_quote": "Zak",
                    }
                ],
                "ambiguities": [],
            }
        )
        duplicate_paragraphs = {"P001": "Zak answered.", "P002": "Zak left."}
        V4Scanner._repair_unique_evidence_locations(ambiguous, duplicate_paragraphs)
        self.assertEqual(ambiguous.mentions[0].paragraph_id, "P000")
        with self.assertRaises(ScanProtocolError):
            V4Scanner._validate_evidence(ambiguous, duplicate_paragraphs)

    def test_local_candidate_index_preserves_exact_curly_punctuation(self):
        block = self.add_blocks(["The Witches’ Keep leaned behind the Old Yard."])[0]
        fake = FakeScanLLM([])
        scanner = V4Scanner(self.database, fake, max_attempts=1)
        candidate = next(
            item for item in scanner.extractor.extract(block)
            if item.normalized_text == "Witches Keep"
        )
        model_payload = candidate.model_payload()
        self.assertNotIn("’", model_payload["candidate"])
        self.assertNotIn("’", model_payload["context"])
        outcome = scanner.scan_block(block)
        self.assertIsNotNone(outcome.response)
        indexed = next(
            item
            for item in outcome.lexical_candidates
            if item["normalized_text"] == "Witches Keep"
        )
        self.assertEqual(indexed["original_text"], "Witches’ Keep")
        self.assertEqual(outcome.response.ambiguities, [])
        self.assertEqual(fake.calls, 0)

    def test_candidate_scan_canonicalizes_safe_title_and_inflection_forms(self):
        self.assertEqual(
            V4Scanner._deterministic_canonical_form(
                "Master Malrubius", "Master Malrubius", "person"
            ),
            "Malrubius",
        )
        self.assertEqual(
            V4Scanner._deterministic_canonical_form(
                "exultants", "exultants", "group"
            ),
            "exultant",
        )
        self.assertEqual(
            V4Scanner._deterministic_canonical_form(
                "Erebus’s", "Erebus", "place"
            ),
            "Erebus",
        )

    def test_context_only_injects_matched_terms_and_overflow_is_terminal_for_worker(self):
        blocks = self.add_blocks(["The Archon spoke.", "Nothing happened."], status="ready")
        self.database.import_legacy_concept("Archon", "执政官", "concept", "职衔")
        packet = ContextBuilder(self.database, max_context_chars=1000).build(blocks[0])
        self.assertIn("Archon", packet.rendered)
        other = ContextBuilder(self.database, max_context_chars=1000).build(blocks[1])
        self.assertNotIn("Archon", other.rendered)
        with self.assertRaises(ContextOverflow):
            ContextBuilder(self.database, max_context_chars=10).build(blocks[0])

        counter = {"calls": 0}
        result = V4TranslationPipeline(
            self.database,
            llm_factory=lambda: FakeTranslationLLM(counter),
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                max_context_chars=10,
                enable_polish=False,
                max_blocks=1,
            ),
        ).run()
        self.assertEqual(counter["calls"], 0)
        self.assertEqual(result["incomplete_requires_human"], 1)
        queued = self.database.list_human_queue()
        self.assertEqual(queued[0]["kind"], "context_overflow")
        retried = self.database.resolve_human_item(queued[0]["id"], "retry")
        self.assertEqual(retried["status"], "retried")

    def test_context_retrieves_grounded_prior_concept_evidence(self):
        blocks = self.add_blocks(
            [
                "The scape was rendered differently for every observer.\n\nNothing else.",
                "They waited without speaking.",
                "She entered the scape.",
            ],
            status="ready",
        )
        self.database.import_legacy_concept(
            "scape",
            "拟景",
            "concept",
            "由计算系统生成、可按观察者分别呈现的感知环境",
        )
        packet = ContextBuilder(self.database, max_context_chars=5000).build(blocks[2])
        self.assertIn("<prior_concept_evidence>", packet.rendered)
        self.assertIn(
            "The scape was rendered differently for every observer.",
            packet.rendered,
        )
        self.assertNotIn("They waited without speaking.", packet.rendered)

    def test_semantic_mapper_extracts_grounded_cross_layer_relation(self):
        source = (
            "As Lahl walked away across the mesa, Rakesh peeked at her version of the scape. "
            "A long, translucent, segmented creature pushed its way briskly through a dense carpet."
        )
        response = json.dumps(
            {
                "relations": [
                    {
                        "relation_type": "same_event_different_rendering",
                        "inference_strength": "strongly_implied",
                        "source_spans": [
                            "Lahl walked away across the mesa",
                            "A long, translucent, segmented creature pushed its way briskly",
                        ],
                        "translation_constraint": (
                            "后句是在拉凯什所见的拟景版本中延续前句的离去动作；"
                            "中文必须让对应关系可推知，但不得直接宣布两者等同。"
                        ),
                    }
                ]
            },
            ensure_ascii=False,
        )
        fake = FakeSemanticLLM(response)
        rendered = SemanticMapper(fake).map(source, "The scape differs by observer.")
        self.assertIn("same_event_different_rendering", rendered)
        self.assertIn("后句是在拉凯什所见的拟景版本中延续前句的离去动作", rendered)
        self.assertEqual(fake.calls[0]["purpose"], "semantic")
        self.assertTrue(fake.calls[0]["json_mode"])

    def test_semantic_mapper_rejects_ungrounded_source_spans(self):
        response = json.dumps(
            {
                "relations": [
                    {
                        "relation_type": "referential_link",
                        "inference_strength": "explicit",
                        "source_spans": ["Missing quote", "Another missing quote"],
                        "translation_constraint": "保留指代。",
                    }
                ]
            }
        )
        self.assertEqual(SemanticMapper(FakeSemanticLLM(response)).map("Actual source."), "")

    def test_human_can_merge_inflected_concept_forms(self):
        self.database.import_legacy_concept(
            "scape", "拟景", "concept", "计算生成的感知环境"
        )
        self.database.import_legacy_concept(
            "scapes", "虚拟场景", "concept", "scape的复数形式"
        )
        result = self.database.merge_concept_forms("scape", ["scapes"])
        self.assertEqual(result["aliases"], ["scapes"])
        matched = self.database.concepts_for_text("Several scapes were available.")
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["source"], "scape")
        self.assertIn("scapes", matched[0]["forms"])

    def test_parallel_pipeline_commits_at_barrier_and_can_export(self):
        self.add_blocks(["The Archon spoke.", "The hall answered."], status="ready")
        result = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=2,
                max_workers=2,
                enable_polish=False,
            ),
        ).run()
        self.assertEqual(result["completed"], 2)
        active = self.database.active_translations()
        self.assertEqual(len(active), 2)
        with closing(self.database.connect()) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM audit_calls").fetchone()[0], 2)
            self.assertGreater(connection.execute("SELECT COUNT(*) FROM evidence").fetchone()[0], 0)

        project = SimpleNamespace(
            root_dir=self.root,
            book_id="test-book",
            config_file=self.root / "config.yaml",
        )
        project.config_file.write_text("title: 测试书\nauthor: 测试者\n", encoding="utf-8")
        report = V4Validator(self.database).validate()
        self.assertEqual(report.high_count, 0)
        exported = ParallelV4BookExporter(project, self.database).export_v4()
        self.assertTrue(exported.txt_path.exists())
        self.assertTrue(exported.epub_path.exists())
        self.assertTrue(exported.quality_report_path.exists())

        second = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(enable_polish=False),
        ).run()
        self.assertEqual(second["completed"], 0)
        first_block = self.database.list_blocks()[0]
        self.database.record_comparison_vote(
            first_block.id,
            "A",
            "parallel_v4",
            "serial_v3",
            "old-v4-hash",
            "old-baseline-hash",
        )
        forced = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(enable_polish=False, force=True, max_blocks=1),
        ).run()
        self.assertEqual(forced["completed"], 1)
        self.assertIsNone(self.database.comparison_vote_for_block(first_block.id))
        self.assertEqual(len(self.database.list_comparison_vote_history()), 1)

    def test_polish_can_compare_exact_baseline_and_normalizes_quote_style(self):
        block = self.add_blocks(["Alpha begins."], status="ready")[0]
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO baseline_documents(
                       id, source_edition_id, name, kind, file_path, file_sha256,
                       paragraph_count, metadata_json, active, created_at
                   ) VALUES('baseline_test', ?, 'serial_v3', 'docx', 'baseline.docx',
                            'hash', 1, '{}', 1, 'now')""",
                (self.edition,),
            )
            connection.execute(
                """INSERT INTO baseline_paragraphs(
                       baseline_document_id, paragraph_index, target_text, target_hash
                   ) VALUES('baseline_test', 0, '旧译文供逐句查漏。', 'target-hash')"""
            )
            connection.execute(
                """INSERT INTO block_baseline_links(
                       block_id, baseline_document_id, paragraph_index, ordinal,
                       overlap_start, overlap_end, partial_start, partial_end,
                       alignment_status
                   ) VALUES(?, 'baseline_test', 0, 0, 0, 13, 0, 0, 'exact')""",
                (block.id,),
            )
        fake = FakeReferencePolishLLM()
        result = V4TranslationPipeline(
            self.database,
            llm_factory=lambda: fake,
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                use_baseline_reference=True,
            ),
        ).run()
        self.assertEqual(result["completed"], 1)
        polish = next(call for call in fake.calls if call["purpose"] == "polish")
        self.assertIn("旧译文供逐句查漏。", polish["messages"][-1]["content"])
        self.assertIn("逐句查漏和比较措辞", polish["messages"][-1]["content"])
        self.assertIn("同一事件在不同感知层中呈现", polish["messages"][-1]["content"])
        self.assertNotIn("FIRST_LAYER_SELF_EVALUATION", polish["messages"][-1]["content"])
        final = self.database.active_translations()[block.id]["final_translation"]
        self.assertEqual(final, "“这是综合两稿后的完整译文。”")
        with closing(self.database.connect()) as connection:
            accepted = connection.execute(
                """SELECT accepted FROM audit_calls
                   WHERE run_id=? AND purpose='polish'
                   ORDER BY id DESC LIMIT 1""",
                (result["run_id"],),
            ).fetchone()["accepted"]
        self.assertEqual(accepted, 1)

    def test_polish_falls_back_to_aligned_serial_translation(self):
        block = self.add_blocks(["Alpha begins."], status="ready")[0]
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO translation_versions(
                       block_id, pipeline, knowledge_version, status,
                       draft_translation, final_translation, active, created_at
                   ) VALUES(?, 'serial_v3', 1, 'completed', ?, ?, 1, 'now')""",
                (block.id, "串行旧稿供对照。", "串行旧稿供对照。"),
            )
        fake = FakeReferencePolishLLM()
        result = V4TranslationPipeline(
            self.database,
            llm_factory=lambda: fake,
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                use_baseline_reference=True,
            ),
        ).run()
        self.assertEqual(result["completed"], 1)
        polish = next(call for call in fake.calls if call["purpose"] == "polish")
        self.assertIn("串行旧稿供对照。", polish["messages"][-1]["content"])

    def test_force_run_can_target_specific_block_ids(self):
        blocks = self.add_blocks(["First block.", "Second block."], status="ready")
        initial = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(enable_polish=False),
        ).run()
        self.assertEqual(initial["completed"], 2)
        targeted = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(
                enable_polish=False,
                force=True,
                include_block_ids=(blocks[1].id,),
            ),
        ).run()
        self.assertEqual(targeted["completed"], 1)
        with closing(self.database.connect()) as connection:
            counts = {
                row["block_id"]: row["version_count"]
                for row in connection.execute(
                    """SELECT block_id, COUNT(*) version_count
                       FROM translation_versions GROUP BY block_id"""
                )
            }
        self.assertEqual(counts[blocks[0].id], 1)
        self.assertEqual(counts[blocks[1].id], 2)

    def test_interactive_mode_pauses_only_for_a_new_decision(self):
        self.add_blocks(["The Archon spoke.", "The Archon waited."], status="ready")
        first = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                enable_polish=False,
                decision_mode="interactive",
                pause_on_review=True,
            ),
        ).run()
        self.assertEqual(first["status"], "paused_for_review")
        self.assertEqual(first["remaining_islands"], 1)
        with closing(self.database.connect()) as connection:
            queue_count = connection.execute(
                "SELECT COUNT(*) FROM human_queue WHERE kind='translation_proposal'"
            ).fetchone()[0]
        self.assertEqual(queue_count, 1)
        with self.database.transaction() as connection:
            dependency = connection.execute(
                """SELECT tv.id translation_id, tv.knowledge_version,
                          c.id concept_id, b.source_text
                   FROM translation_versions tv JOIN blocks b ON b.id=tv.block_id
                   JOIN concepts c
                     ON c.canonical_source='Archon' AND c.retired_version IS NULL
                   WHERE tv.pipeline='parallel_v4' AND tv.active=1
                   ORDER BY tv.id LIMIT 1"""
            ).fetchone()
            connection.execute(
                """INSERT INTO dependencies(
                       translation_id, dependency_type, dependency_id,
                       knowledge_version, dependency_fingerprint,
                       matched_form, source_spans_json)
                   VALUES(?, 'concept', ?, ?, 'pre-accept-fingerprint', ?, ?)""",
                (
                    dependency["translation_id"],
                    dependency["concept_id"],
                    dependency["knowledge_version"],
                    dependency["source_text"],
                    json.dumps([[0, len(dependency["source_text"])]]),
                ),
            )
        decision = self.database.resolve_human_item(1, "accept")
        self.assertEqual(decision["affected_translations"], 0)
        with closing(self.database.connect()) as connection:
            concept = connection.execute(
                "SELECT status, locked FROM concepts WHERE canonical_source='Archon'"
            ).fetchone()
            change_ids = [
                row[0]
                for row in connection.execute(
                    "SELECT id FROM knowledge_changes WHERE knowledge_version=?",
                    (decision["knowledge_version"],),
                )
            ]
        self.assertEqual(concept["status"], "verified")
        self.assertEqual(concept["locked"], 1)
        active_before = self.database.active_translations()
        self.assertEqual(
            {row["status"] for row in active_before.values()}, {"completed"}
        )
        planned = RevalidationPlanner(self.database).plan(change_ids)
        self.assertEqual(planned["planned"], 1)
        self.assertEqual(self.database.status_summary()["needs_revalidate"], 1)
        self.assertEqual(
            {row["status"] for row in self.database.active_translations().values()},
            {"completed"},
        )

        second = V4TranslationPipeline(
            self.database,
            llm_factory=FakeTranslationLLM,
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                enable_polish=False,
                decision_mode="interactive",
            ),
        ).run()
        self.assertEqual(second["status"], "completed")

    def test_migration_is_idempotent_and_does_not_edit_legacy_chapter(self):
        root = Path(self.temp.name) / "legacy"
        root.mkdir()
        (root / "source.txt").write_text("The Archon spoke.", encoding="utf-8")
        (root / "glossary").mkdir()
        (root / "glossary" / "terms.json").write_text(
            json.dumps([{"src": "Archon", "default_target": "执政官"}]),
            encoding="utf-8",
        )
        memory = TranslationMemory(root)
        chapter = Chapter(
            id="ch01",
            title="Chapter One",
            index=0,
            source_text="The Archon spoke.",
            chunks=[
                TextChunk(
                    id="ch01_000",
                    chapter_id="ch01",
                    index=0,
                    source_text="The Archon spoke.",
                    status=ChunkStatus.COMPLETED,
                    draft_translation="执政官开口。",
                    final_translation="执政官开口。",
                )
            ],
        )
        memory.initialize_chapter(chapter)
        project = SimpleNamespace(
            root_dir=root,
            source_file=root / "source.txt",
            glossary_dir=root / "glossary",
            memory=memory,
        )
        chapter_file = next(memory.chapters_dir.glob("*.json"))
        before = chapter_file.read_bytes()
        first = V4Migrator(project).migrate()
        second = V4Migrator(project).migrate()
        self.assertEqual(first["blocks"], second["blocks"])
        self.assertEqual(before, chapter_file.read_bytes())
        with closing(V4Database(root).connect()) as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM translation_versions WHERE pipeline='serial_v3'"
            ).fetchone()[0]
            imported_lexeme = connection.execute(
                """SELECT working_target, locked FROM lexemes
                   WHERE normalized_form='archon'"""
            ).fetchone()
            concept_count = connection.execute(
                """SELECT COUNT(*) FROM concepts
                   WHERE canonical_source='Archon' AND retired_version IS NULL"""
            ).fetchone()[0]
        self.assertEqual(count, 1)
        self.assertEqual(tuple(imported_lexeme), ("执政官", 0))
        self.assertEqual(concept_count, 0)

        (root / "source.txt").write_text("The Archon changed.", encoding="utf-8")
        changed = chapter.model_copy(deep=True)
        changed.source_text = "The Archon changed."
        changed.chunks[0].source_text = "The Archon changed."
        changed.chunks[0].status = ChunkStatus.PENDING
        changed.chunks[0].final_translation = None
        memory.initialize_chapter(changed)
        V4Migrator(project).migrate()
        changed_database = V4Database(root)
        self.assertEqual(len(changed_database.list_blocks()), 1)
        with closing(changed_database.connect()) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM source_editions").fetchone()[0], 2)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM blocks").fetchone()[0], 2)

    def test_migration_orders_chapters_by_book_index_not_filename(self):
        root = Path(self.temp.name) / "chapter-order"
        root.mkdir()
        (root / "source.txt").write_text("First.\n\nSecond.", encoding="utf-8")
        (root / "glossary").mkdir()
        memory = TranslationMemory(root)
        memory.initialize_chapter(
            Chapter(
                id="z_first",
                title="First",
                index=0,
                source_text="First.",
                chunks=[TextChunk(id="z_first_000", chapter_id="z_first", index=0, source_text="First.")],
            )
        )
        memory.initialize_chapter(
            Chapter(
                id="a_second",
                title="Second",
                index=1,
                source_text="Second.",
                chunks=[TextChunk(id="a_second_000", chapter_id="a_second", index=0, source_text="Second.")],
            )
        )
        project = SimpleNamespace(
            root_dir=root,
            source_file=root / "source.txt",
            glossary_dir=root / "glossary",
            memory=memory,
        )
        V4Migrator(project).migrate()
        blocks = V4Database(root).list_blocks()
        self.assertEqual([block.source_text for block in blocks], ["First.", "Second."])


class ParallelV4CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "book"
        self.root.mkdir(parents=True)
        self.project = SimpleNamespace(root_dir=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, *arguments):
        import main as cli_main

        output = io.StringIO()
        with (
            patch.object(cli_main.project_manager, "load_project", return_value=self.project),
            redirect_stdout(output),
        ):
            exit_code = cli_main.main(list(arguments))
        return exit_code, output.getvalue()

    def test_scan_v4_is_local_and_does_not_construct_an_llm(self):
        import main as cli_main

        calls = []

        class FakeScanner:
            def __init__(self, database, **kwargs):
                calls.append((database.project_root, kwargs))

            def scan_project(self, **kwargs):
                calls.append(kwargs)
                return {"indexed": 3, "clusters": 2, "failed": 0}

        with (
            patch.object(cli_main, "V4Migrator") as migrator,
            patch.object(cli_main, "V4Scanner", FakeScanner),
            patch.object(cli_main, "LLMManager", side_effect=AssertionError("local scan must not create an LLM")),
        ):
            exit_code, output = self.invoke(
                "scan-v4", "book", "--max-blocks", "3", "--max-attempts", "7",
                "--block", "block-2", "--block", "v01_ch01_003",
            )

        self.assertEqual(exit_code, 0)
        migrator.assert_called_once_with(self.project)
        self.assertEqual(calls[0], (self.root, {"max_attempts": 7}))
        self.assertEqual(calls[1]["max_blocks"], 3)
        self.assertEqual(calls[1]["block_ids"], ["block-2", "v01_ch01_003"])
        self.assertEqual(json.loads(output)["indexed"], 3)

    def test_prepare_v4_unknown_explicit_block_fails_before_constructing_an_llm(self):
        import main as cli_main

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(
                cli_main,
                "LLMManager",
                side_effect=AssertionError("unknown block must stop before model stages"),
            ) as llm_manager,
        ):
            exit_code, output = self.invoke(
                "prepare-v4", "book", "--block", "does-not-exist"
            )

        self.assertNotEqual(exit_code, 0)
        llm_manager.assert_not_called()
        result = json.loads(output)
        self.assertEqual(result["failed_stage"], "scan")
        self.assertIn("does-not-exist", result["stages"]["scan"]["error"])

    def test_prepare_cli_makes_scanned_prose_eligible_for_translation_pipeline(self):
        database = V4Database(self.root)
        edition = database.ensure_source_edition(
            "raw", "normalized", "test", "source.txt"
        )
        database.upsert_blocks(
            edition,
            [
                {
                    "id": "block-1",
                    "legacy_id": "v01_ch01_000",
                    "chapter_id": "ch01",
                    "chapter_title": "I",
                    "chapter_index": 0,
                    "block_index": 0,
                    "global_index": 0,
                    "block_type": "prose",
                    "source_text": "Severian waited.",
                    "source_hash": hashlib.sha256(
                        "Severian waited.".encode("utf-8")
                    ).hexdigest(),
                    "token_count": 2,
                    "status": "pending",
                }
            ],
        )
        preparation_llm = FakePreparationLLM()
        import main as cli_main

        with (
            patch.object(cli_main, "V4Migrator") as migrator,
            patch.object(cli_main, "LLMManager", return_value=preparation_llm),
            patch.object(
                cli_main.config_loader,
                "load_config",
                return_value={"llm": {}, "parallel_v4": {}},
            ),
        ):
            exit_code, output = self.invoke(
                "prepare-v4", "book", "--max-blocks", "1", "--max-attempts", "1"
            )

        self.assertEqual(exit_code, 0, output)
        migrator.assert_called_once_with(self.project)
        self.assertEqual(
            database.get_block_by_identifier("block-1").status, "ready", output
        )
        counter = {"calls": 0}
        translated = V4TranslationPipeline(
            database,
            llm_factory=lambda: FakeTranslationLLM(counter),
            config=V4PipelineConfig(
                island_size=1,
                initial_workers=1,
                max_workers=1,
                max_blocks=1,
                enable_polish=False,
            ),
        ).run()

        self.assertEqual(translated["completed"], 1)
        self.assertGreater(counter["calls"], 0)

    def test_prepare_v4_runs_stages_in_order_and_forwards_limits(self):
        import main as cli_main

        calls = []

        def stage(name, result):
            def invoke(project, args):
                calls.append(
                    (
                        name,
                        project.root_dir,
                        args.max_blocks,
                        args.max_clusters,
                        args.max_attempts,
                        args.audit_mode,
                        args.initial_workers,
                        args.max_workers,
                    )
                )
                return result

            return invoke

        with (
            patch.object(cli_main, "V4Migrator") as migrator,
            patch.object(cli_main, "_run_scan_v4", stage("scan", {"failed": 0})),
            patch.object(cli_main, "_run_adjudicate_v4", stage("adjudicate", {"failed": 0})),
            patch.object(cli_main, "_run_coreference_v4", stage("coreference", {"uncertain": 1})),
            patch.object(cli_main, "_run_resolve_targets_v4", stage("resolve", {"queued": 0})),
        ):
            exit_code, output = self.invoke(
                "prepare-v4",
                "book",
                "--max-blocks",
                "8",
                "--max-clusters",
                "13",
                "--max-attempts",
                "2",
                "--audit-mode",
                "full",
                "--initial-workers",
                "3",
                "--max-workers",
                "4",
            )

        self.assertEqual(exit_code, 0)
        migrator.assert_called_once_with(self.project)
        self.assertEqual(
            [item[0] for item in calls],
            ["scan", "adjudicate", "coreference", "resolve"],
        )
        self.assertTrue(all(item[2:] == (8, 13, 2, "full", 3, 4) for item in calls))
        self.assertEqual(json.loads(output)["status"], "completed")

    def test_prepare_v4_stops_after_first_failed_stage(self):
        import main as cli_main

        calls = []

        def failed_scan(project, args):
            calls.append("scan")
            return {"failed": 1}

        def must_not_run(project, args):
            calls.append("unexpected")
            return {"failed": 0}

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(cli_main, "_run_scan_v4", failed_scan),
            patch.object(cli_main, "_run_adjudicate_v4", must_not_run),
            patch.object(cli_main, "_run_coreference_v4", must_not_run),
            patch.object(cli_main, "_run_resolve_targets_v4", must_not_run),
        ):
            exit_code, output = self.invoke("prepare-v4", "book")

        self.assertEqual(exit_code, 1)
        self.assertEqual(calls, ["scan"])
        result = json.loads(output)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failed_stage"], "scan")

    def test_schema8_coreference_and_revalidation_commands_forward_bounded_options(self):
        import main as cli_main

        constructed = []

        class FakeCoreference:
            def __init__(self, database, **kwargs):
                constructed.append(("coreference", database.project_root, kwargs))

            def run(self, max_cases=None):
                constructed.append(("coreference-run", max_cases))
                return {"cases": 5, "uncertain": 2, "protocol_failures": 1}

        class FakeRevalidation:
            def __init__(self, database, **kwargs):
                constructed.append(("revalidate", database.project_root, kwargs))

            def run(self, max_tasks=None):
                constructed.append(("revalidate-run", max_tasks))
                return {"status": "completed_with_warnings", "warnings": 1, "unfinished": 0}

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(cli_main, "CoreferenceCoordinator", FakeCoreference),
            patch.object(cli_main, "RevalidationRunner", FakeRevalidation),
            patch.object(cli_main, "V4Repairer"),
            patch.object(cli_main, "V4TranslationPipeline"),
            patch.object(cli_main, "LLMManager", side_effect=lambda config: object()),
            patch.object(
                cli_main.config_loader,
                "load_config",
                return_value={"llm": {}, "parallel_v4": {}, "translation": {}},
            ),
            patch.object(cli_main.config_loader, "load_prompts", return_value={}),
        ):
            coref_code, _ = self.invoke(
                "coreference-v4", "book", "--max-cases", "5", "--max-attempts", "7"
            )
            revalidate_code, _ = self.invoke(
                "revalidate-v4", "book", "--max-tasks", "6", "--max-attempts", "8"
            )

        self.assertEqual((coref_code, revalidate_code), (0, 0))
        self.assertIn(("coreference-run", 5), constructed)
        self.assertIn(("revalidate-run", 6), constructed)
        self.assertEqual(
            next(item[2]["max_attempts"] for item in constructed if item[0] == "coreference"),
            7,
        )
        self.assertEqual(
            next(item[2]["max_attempts"] for item in constructed if item[0] == "revalidate"),
            8,
        )

    def test_translate_v4_exposes_epoch_policy_and_warning_exit_is_success(self):
        import main as cli_main

        captured = {}

        class FakePipeline:
            def __init__(self, **kwargs):
                captured["config"] = kwargs["config"]

            def run(self):
                return {
                    "completed": 0,
                    "completed_with_warnings": 1,
                    "failed_retryable": 0,
                    "incomplete_requires_human": 0,
                }

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(cli_main, "V4TranslationPipeline", FakePipeline),
            patch.object(
                cli_main.config_loader,
                "load_config",
                return_value={"llm": {}, "parallel_v4": {}, "translation": {}},
            ),
            patch.object(cli_main.config_loader, "load_prompts", return_value={}),
        ):
            exit_code, _ = self.invoke(
                "translate-v4",
                "book",
                "--decision-mode",
                "interactive",
                "--pause-on-review",
                "--max-knowledge-epochs",
                "4",
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["config"].decision_mode, "interactive")
        self.assertTrue(captured["config"].pause_on_review)
        self.assertEqual(captured["config"].max_knowledge_epochs, 4)
        self.assertTrue(captured["config"].enable_narrative_premap)
        self.assertTrue(captured["config"].dynamic_scheduling)
        self.assertEqual(
            captured["config"].unattended_failure_policy, "finish_with_warnings"
        )

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(cli_main, "V4TranslationPipeline", FakePipeline),
            patch.object(
                cli_main.config_loader,
                "load_config",
                return_value={"llm": {}, "parallel_v4": {}, "translation": {}},
            ),
            patch.object(cli_main.config_loader, "load_prompts", return_value={}),
        ):
            legacy_code, _ = self.invoke(
                "translate-v4", "book", "--decision-mode", "unattended"
            )
        self.assertEqual(legacy_code, 0)
        self.assertEqual(captured["config"].decision_mode, "auto")

    def test_narrative_cli_commands_construct_bounded_services(self):
        import main as cli_main

        calls = []

        class FakeDatabase:
            def __init__(self, root):
                self.root = root

            def get_block_by_identifier(self, identifier):
                return SimpleNamespace(id=f"resolved-{identifier}")

            def inspect_narrative_memory(self, **filters):
                calls.append(("inspect", filters))
                return {"memories": [], "snapshots": []}

        class FakePipeline:
            def __init__(self, **kwargs):
                calls.append(("pipeline", kwargs["config"]))

            def premap(self, *, block_ids=(), max_blocks=None):
                calls.append(("premap", tuple(block_ids), max_blocks))
                return {"premapped": 3}

            def rebuild_snapshots(self, *, from_index=0):
                calls.append(("rebuild", from_index))
                return {"rebuilt": 2}

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(cli_main, "V4Database", FakeDatabase),
            patch.object(cli_main, "V4TranslationPipeline", FakePipeline),
            patch.object(cli_main, "LLMManager", return_value=object()),
            patch.object(
                cli_main.config_loader,
                "load_config",
                return_value={
                    "llm": {},
                    "parallel_v4": {},
                    "translation": {},
                },
            ),
            patch.object(cli_main.config_loader, "load_prompts", return_value={}),
        ):
            premap_code, premap_output = self.invoke(
                "premap-v4",
                "book",
                "--max-blocks",
                "3",
                "--block",
                "v01_ch01_000",
            )
            inspect_code, inspect_output = self.invoke(
                "inspect-memory-v4",
                "book",
                "--block",
                "v01_ch01_000",
                "--subject",
                "concept-severian",
            )
            rebuild_code, rebuild_output = self.invoke(
                "rebuild-snapshots-v4",
                "book",
                "--from-index",
                "8",
            )

        self.assertEqual(
            (premap_code, inspect_code, rebuild_code), (0, 0, 0)
        )
        self.assertEqual(json.loads(premap_output)["premapped"], 3)
        self.assertIn("memories", json.loads(inspect_output))
        self.assertEqual(json.loads(rebuild_output)["rebuilt"], 2)
        self.assertIn(
            ("premap", ("resolved-v01_ch01_000",), 3), calls
        )
        self.assertIn(
            (
                "inspect",
                {
                    "block_id": "resolved-v01_ch01_000",
                    "subject_id": "concept-severian",
                    "memory_type": None,
                },
            ),
            calls,
        )
        self.assertIn(("rebuild", 8), calls)

    def test_migrate_v4_preview_and_confirmation_are_explicit(self):
        import main as cli_main

        database_path = self.root / "artifacts" / "parallel_v4" / "book.db"
        with patch.object(
            cli_main,
            "_preview_v4_migration",
            return_value={"status": "ready", "confirm_token": "t"},
        ) as preview:
            preview_code, preview_output = self.invoke("migrate-v4", "book", "--preview")
        self.assertEqual(preview_code, 0)
        preview.assert_called_once_with(database_path.resolve())
        self.assertEqual(json.loads(preview_output)["confirm_token"], "t")

        with patch.object(cli_main, "_inspect_v4_schema", return_value=8), patch.object(
            cli_main, "V4Migrator"
        ) as migrator:
            migrator.return_value.migrate.return_value = {"status": "migrated"}
            migrate_code, _ = self.invoke("migrate-v4", "book", "--confirm", "token")
        self.assertEqual(migrate_code, 0)
        migrator.assert_called_once_with(self.project, confirm_token="token")
        migrator.return_value.migrate.assert_called_once_with()

    def test_migrate_v4_schema7_confirmation_stops_at_schema8(self):
        import main as cli_main

        database_path = self.root / "artifacts" / "parallel_v4" / "book.db"
        with patch.object(
            cli_main, "_inspect_v4_schema", return_value=7
        ), patch.object(
            cli_main,
            "_confirm_schema7_to8",
            return_value={"status": "migrated", "schema_version": 8},
        ) as confirm, patch.object(cli_main, "V4Migrator") as migrator:
            code, output = self.invoke(
                "migrate-v4", "book", "--confirm", "schema7-token"
            )

        self.assertEqual(code, 0)
        confirm.assert_called_once_with(
            database_path.resolve(), "schema7-token"
        )
        migrator.assert_not_called()
        self.assertEqual(json.loads(output)["next_schema"], 9)

    def test_model_preparation_commands_forward_audit_and_attempt_limits(self):
        import main as cli_main

        constructed = []

        class FakeAdjudicator:
            def __init__(self, llm, **kwargs):
                constructed.append(("adjudicate", kwargs))

            def run(self, *, max_clusters=None, initial_workers=1, max_workers=1):
                constructed.append(
                    ("adjudicate-run", max_clusters, initial_workers, max_workers)
                )
                return {"adjudicated": 4, "failed": 0, "deferred": 1}

        class FakeResolver:
            def __init__(self, database, llm, **kwargs):
                constructed.append(("resolve", kwargs))

            def run(self, max_concepts=None):
                constructed.append(("resolve-run", max_concepts))
                return {"resolved": 3, "queued": 0}

        with (
            patch.object(cli_main, "V4Migrator"),
            patch.object(cli_main, "V4Adjudicator", FakeAdjudicator),
            patch.object(cli_main, "TargetResolver", FakeResolver),
            patch.object(cli_main, "LLMManager", return_value=object()),
            patch.object(cli_main.config_loader, "load_config", return_value={"llm": {}}),
        ):
            adjudicate_code, _ = self.invoke(
                "adjudicate-v4",
                "book",
                "--max-clusters",
                "4",
                "--max-attempts",
                "5",
                "--audit-mode",
                "response",
                "--initial-workers",
                "3",
                "--max-workers",
                "4",
            )
            resolve_code, _ = self.invoke(
                "resolve-targets-v4",
                "book",
                "--max-concepts",
                "3",
                "--max-attempts",
                "6",
                "--audit-mode",
                "minimal",
            )

        self.assertEqual((adjudicate_code, resolve_code), (0, 0))
        self.assertIn(
            (
                "adjudicate",
                {
                    "database": ANY,
                    "max_attempts": 5,
                    "audit_mode": "response",
                    "llm_factory": ANY,
                },
            ),
            constructed,
        )
        self.assertIn(("adjudicate-run", 4, 3, 4), constructed)
        self.assertIn(
            ("resolve", {"max_attempts": 6, "audit_mode": "minimal"}),
            constructed,
        )
        self.assertIn(("resolve-run", 3), constructed)

    def test_adjudication_cli_rejects_inverted_worker_limits_before_model(self):
        import main as cli_main

        with (
            patch.object(cli_main.project_manager, "load_project") as load_project,
            patch.object(cli_main, "LLMManager") as llm_manager,
        ):
            exit_code, output = self.invoke(
                "adjudicate-v4",
                "book",
                "--initial-workers",
                "4",
                "--max-workers",
                "2",
            )

        self.assertEqual(exit_code, 1)
        load_project.assert_not_called()
        llm_manager.assert_not_called()
        self.assertIn("initial_workers", json.loads(output)["error"])

    def test_preparation_cli_rejects_unsafe_negative_limits_before_loading_project(self):
        import main as cli_main

        invalid_commands = (
            ("scan-v4", "book", "--max-blocks", "-1"),
            ("prepare-v4", "book", "--max-blocks", "-1"),
            ("adjudicate-v4", "book", "--max-clusters", "-1"),
            ("prepare-v4", "book", "--max-clusters", "-1"),
            ("scan-v4", "book", "--max-attempts", "0"),
            ("adjudicate-v4", "book", "--max-attempts", "0"),
            ("resolve-targets-v4", "book", "--max-attempts", "0"),
            ("prepare-v4", "book", "--max-attempts", "0"),
        )
        for arguments in invalid_commands:
            with self.subTest(arguments=arguments):
                stderr = io.StringIO()
                with (
                    patch.object(cli_main.project_manager, "load_project") as load,
                    redirect_stderr(stderr),
                    self.assertRaises(SystemExit) as raised,
                ):
                    cli_main.main(list(arguments))
                self.assertNotEqual(raised.exception.code, 0)
                load.assert_not_called()
                self.assertIn("must be", stderr.getvalue())

    def test_reset_scan_v4_requires_current_preview_token_and_prints_clean_json(self):
        database = V4Database(self.root)
        edition = database.ensure_source_edition("raw", "normalized", "test", "source.txt")
        database.upsert_blocks(
            edition,
            [
                {
                    "id": "block-1",
                    "legacy_id": "ch01_000",
                    "chapter_id": "ch01",
                    "chapter_title": "One",
                    "chapter_index": 0,
                    "block_index": 0,
                    "global_index": 0,
                    "block_type": "prose",
                    "source_text": "Severian waited.",
                    "source_hash": hashlib.sha256(
                        "Severian waited.".encode("utf-8")
                    ).hexdigest(),
                    "token_count": 2,
                    "status": "pending",
                }
            ]
        )

        preview_code, preview_output = self.invoke("reset-scan-v4", "book", "--preview")
        preview = json.loads(preview_output)
        self.assertEqual(preview_code, 0)
        self.assertTrue(preview["token"])

        wrong_code, wrong_output = self.invoke(
            "reset-scan-v4", "book", "--confirm", "wrong"
        )
        self.assertEqual(wrong_code, 1)
        self.assertIn("token", wrong_output.casefold())

        confirm_code, confirm_output = self.invoke(
            "reset-scan-v4", "book", "--confirm", preview["token"]
        )
        self.assertEqual(confirm_code, 0)
        self.assertIn("blocks_reset", json.loads(confirm_output))

    def test_reset_scan_v4_clears_only_preparation_audit_runs(self):
        database = V4Database(self.root)
        for run_id, stage in (
            ("scan-run", "scan"),
            ("judge-run", "adjudicate"),
            ("target-run", "working_target"),
            ("translate-run", "translate"),
        ):
            database.start_run(run_id, stage, {})
            database.record_audit_call(
                run_id=run_id,
                block_id=None,
                purpose=stage,
                model="fake",
                knowledge_version=database.current_knowledge_version(),
                request={"run": run_id},
                raw_response="failure",
                parsed=None,
                accepted=False,
                attempts=1,
                elapsed_ms=1,
                error="test",
            )
            database.finish_run(run_id, "completed_with_errors")

        human_id = database.record_audit_call(
            run_id="scan-run",
            block_id=None,
            purpose="scan_review",
            model="human-reviewer",
            knowledge_version=database.current_knowledge_version(),
            request={"actor_type": "human", "note": "人工复核"},
            raw_response="人工全文",
            parsed={"actor_type": "human", "decision": "保留"},
            accepted=True,
            attempts=1,
            elapsed_ms=1,
            error=None,
        )
        locator = database.audit_archive.append(
            "scan-run",
            {
                "request": {"actor_type": "human"},
                "raw_response": "人工全文",
                "parsed": {"decision": "保留"},
            },
            stage="manual_review",
        )
        with database.transaction() as connection:
            connection.execute(
                """UPDATE audit_calls
                   SET archive_relative_path=?, archive_offset=?,
                       archive_compressed_length=?, archive_sha256=?
                   WHERE id=?""",
                (
                    locator.relative_path,
                    locator.offset,
                    locator.compressed_length,
                    locator.sha256,
                    human_id,
                ),
            )

        preview = database.preview_scan_reset()
        self.assertEqual(preview["audit_calls"], 3)
        self.assertEqual(preview["runs"], 2)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE audit_calls SET raw_response='人工全文更新' WHERE id=?",
                (human_id,),
            )
        database.reset_scan_derivatives(preview["token"])
        with closing(database.connect()) as connection:
            remaining = connection.execute(
                """SELECT r.stage, a.purpose, a.raw_response,
                          a.archive_relative_path, a.archive_sha256
                   FROM runs r JOIN audit_calls a ON a.run_id=r.id
                   ORDER BY r.stage, a.id"""
            ).fetchall()
        self.assertEqual(
            [tuple(row) for row in remaining],
            [
                (
                    "scan",
                    "scan_review",
                    "人工全文更新",
                    locator.relative_path,
                    locator.sha256,
                ),
                ("translate", "translate", "failure", None, None),
            ],
        )
        self.assertEqual(database.read_audit_payload(human_id)["raw_response"], "人工全文")


if __name__ == "__main__":
    unittest.main()
