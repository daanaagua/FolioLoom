"""Deterministic local candidate indexing for the parallel v4 pipeline."""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Sequence
from uuid import uuid4

from .candidate_clusters import CandidateClusterBuilder
from .database import StaleCandidateSnapshot, V4Database
from .lexical_index import LexicalCandidateExtractor
from .models import ScanOutcome, ScanResponse, V4Block, V4BlockStatus


SCAN_SCHEMA_VERSION = "scan-v5-local-candidate-index"


def paragraph_map(source_text: str) -> Dict[str, str]:
    paragraphs = [
        part.strip()
        for part in re.split(r"\n\s*\n", source_text.strip())
        if part.strip()
    ]
    return {f"P{index:03d}": paragraph for index, paragraph in enumerate(paragraphs)}


def render_numbered_source(source_text: str) -> str:
    """Legacy diagnostic renderer retained for imported v4.1 responses."""
    return "\n\n".join(
        f"[{paragraph_id}]\n{text}"
        for paragraph_id, text in paragraph_map(source_text).items()
    )


class ScanProtocolError(ValueError):
    pass


class V4Scanner:
    """Index reversible lexical candidates without accessing an LLM."""

    def __init__(
        self,
        database: V4Database,
        llm_manager=None,
        max_attempts: int = 3,
        temperature: float = 0.0,
        max_tokens: int = 8192,
        audit_mode: str = "full",
        max_candidates_per_block: int = 80,
        context_words: int = 4,
    ):
        self.database = database
        # Kept only so existing construction sites remain source-compatible.
        self.llm = llm_manager
        self.max_attempts = max(1, max_attempts)
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.audit_mode = audit_mode
        self.extractor = LexicalCandidateExtractor(
            database.list_blocks(),
            max_candidates=max_candidates_per_block,
            context_words=context_words,
        )

    @staticmethod
    def _clean_json(raw: str) -> str:
        """Legacy JSON-fence cleanup retained for imported scan artifacts."""
        cleaned = raw.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        elif cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        return cleaned.strip()

    @staticmethod
    def _validate_evidence(response: ScanResponse, paragraphs: Dict[str, str]) -> None:
        """Legacy validator retained for imported v4.1 scan responses."""
        for item in [*response.mentions, *response.ambiguities]:
            paragraph = paragraphs.get(item.paragraph_id)
            if paragraph is None:
                raise ScanProtocolError(f"unknown paragraph id: {item.paragraph_id}")
            quote = " ".join(item.evidence_quote.split())
            normalized_paragraph = " ".join(paragraph.split())
            if quote not in normalized_paragraph:
                raise ScanProtocolError(
                    f"evidence is not in {item.paragraph_id}: {item.evidence_quote!r}"
                )

    @staticmethod
    def _repair_unique_evidence_locations(
        response: ScanResponse, paragraphs: Dict[str, str]
    ) -> None:
        """Legacy repair retained for imported v4.1 scan responses."""
        normalized_paragraphs = {
            paragraph_id: " ".join(paragraph.split())
            for paragraph_id, paragraph in paragraphs.items()
        }
        for item in [*response.mentions, *response.ambiguities]:
            quote = " ".join(item.evidence_quote.split())
            if quote in normalized_paragraphs.get(item.paragraph_id, ""):
                continue
            matches = [
                paragraph_id
                for paragraph_id, paragraph in normalized_paragraphs.items()
                if quote in paragraph
            ]
            if len(matches) == 1:
                item.paragraph_id = matches[0]

    @staticmethod
    def _is_front_matter(block: V4Block) -> bool:
        legacy = getattr(block, "legacy_id", "").casefold()
        return (
            "_pre_" in legacy
            or legacy.startswith("v00_")
            or block.block_type.casefold()
            in {"frontmatter", "copyright", "title_page"}
        )

    @staticmethod
    def _sanitize_candidate_response(data: object) -> Dict[str, object]:
        """Legacy response normalization; never called by local indexing."""
        if not isinstance(data, dict):
            raise ScanProtocolError("top level must be a JSON object")
        raw_mentions = data.get("mentions", [])
        if not isinstance(raw_mentions, list):
            raise ScanProtocolError("mentions must be a list")
        category_aliases = {
            "institution": "organization",
            "location": "place",
            "object": "item",
            "role": "title",
            "book": "work",
            "race": "species",
        }
        discourse_aliases = {
            "reference": "referential",
            "address": "vocative",
            "institution": "institutional",
        }
        mentions = []
        for raw in raw_mentions:
            if not isinstance(raw, dict):
                continue
            item = dict(raw)
            category = str(item.get("category") or "concept").casefold()
            discourse = str(
                item.get("discourse_function") or "referential"
            ).casefold()
            item["category"] = category_aliases.get(category, category)
            item["discourse_function"] = discourse_aliases.get(
                discourse, discourse
            )
            for field in ("suggested_target", "description"):
                if item.get(field) is None:
                    item[field] = ""
            if item.get("canonical_candidate_id") in {"", "null", "None"}:
                item["canonical_candidate_id"] = None
            mentions.append(item)
        return {"mentions": mentions}

    @staticmethod
    def _deterministic_canonical_form(
        original_text: str, normalized_text: str, category: str
    ) -> str:
        """Legacy conservative morphology helper for imported decisions."""
        words = normalized_text.split()
        title_prefixes = {
            "master", "brother", "father", "mother", "saint", "holy",
            "lord", "lady", "doctor", "captain", "general", "chatelaine",
        }
        if (
            category == "person"
            and len(words) >= 2
            and words[0].casefold() in title_prefixes
        ):
            return " ".join(words[1:])
        if re.search(r"['’]s$", original_text, flags=re.I):
            return normalized_text
        if category in {"title", "group", "species", "concept"} and len(words) == 1:
            word = words[0]
            lower = word.casefold()
            if lower.endswith("ies") and len(word) > 4:
                return word[:-3] + ("Y" if word[-3:].isupper() else "y")
            if (
                lower.endswith("s")
                and not lower.endswith(("ss", "us", "is", "ses"))
                and len(word) > 4
            ):
                return word[:-1]
        return ""

    def scan_block(self, block: V4Block) -> ScanOutcome:
        """Build the local lattice for one block without model calls."""
        front_matter = self._is_front_matter(block)
        candidates = [] if front_matter else self.extractor.extract(block)
        return ScanOutcome(
            block=block,
            response=ScanResponse(mentions=[], ambiguities=[]),
            request_payload={
                "schema_version": SCAN_SCHEMA_VERSION,
                "local_index": True,
                "front_matter": front_matter,
            },
            attempts=0,
            elapsed_ms=0,
            lexical_candidates=[candidate.storage_payload() for candidate in candidates],
        )

    def scan_project(
        self,
        initial_workers: int = 2,
        max_workers: int = 4,
        max_blocks: Optional[int] = None,
        block_ids: Optional[Sequence[str]] = None,
    ) -> Dict[str, int | str]:
        if block_ids is None:
            blocks = self.database.list_blocks(
                [V4BlockStatus.PENDING.value, V4BlockStatus.FAILED_RETRYABLE.value]
            )
        else:
            blocks = []
            seen_block_ids = set()
            for identifier in block_ids:
                block = self.database.get_block_by_identifier(str(identifier))
                if block.id in seen_block_ids:
                    continue
                seen_block_ids.add(block.id)
                blocks.append(block)
        if max_blocks is not None:
            blocks = blocks[:max_blocks]
        run_id = f"scan_{uuid4().hex}"
        config = {
            "initial_workers": initial_workers,
            "max_workers": max_workers,
            "max_blocks": max_blocks,
            "block_ids": [block.id for block in blocks] if block_ids is not None else None,
            "schema_version": SCAN_SCHEMA_VERSION,
            "mode": "local_candidate_index",
        }
        self.database.start_run(run_id, "scan", config)
        workers = max(1, min(initial_workers, max_workers))
        indexed = failed = 0
        indexed_block_ids: List[str] = []
        cluster_count = 0
        try:
            cursor = 0
            while cursor < len(blocks):
                wave = blocks[cursor : cursor + workers]
                outcomes: List[ScanOutcome] = []
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    futures = {
                        executor.submit(self.scan_block, block): block for block in wave
                    }
                    for future in as_completed(futures):
                        outcomes.append(future.result())
                summary = self.database.commit_candidate_index_batch(
                    run_id, outcomes
                )
                indexed += summary["indexed"]
                failed += summary["failed"]
                indexed_block_ids.extend(
                    outcome.block.id
                    for outcome in outcomes
                    if outcome.error is None and outcome.response is not None
                )
                if summary["failed"]:
                    workers = max(1, workers - 1)
                elif workers < max_workers:
                    workers += 1
                cursor += len(wave)

            # One bounded Python materialization is intentionally done only once
            # per successful scan pass. Candidates are compact dataclasses backed
            # by SQLite; CAS retries occur only when another coordinator changes
            # the pending set while this final clustering pass is running.
            for snapshot_attempt in range(3):
                snapshot_token, all_pending = (
                    self.database.load_pending_candidate_snapshot()
                )
                clusters = CandidateClusterBuilder().build(all_pending)
                try:
                    cluster_count = self.database.replace_pending_candidate_clusters(
                        run_id,
                        clusters,
                        expected_snapshot_token=snapshot_token,
                    )["clusters"]
                    break
                except StaleCandidateSnapshot:
                    if snapshot_attempt == 2:
                        raise
            status = "completed" if not failed else "completed_with_errors"
            self.database.finish_run(run_id, status)
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc))
            raise
        successful_block_ids = set(indexed_block_ids)
        return {
            "run_id": run_id,
            "indexed": indexed,
            "clusters": cluster_count,
            "completed": indexed,
            "failed": failed,
            "final_workers": workers,
            "block_ids": [
                block.id for block in blocks if block.id in successful_block_ids
            ],
        }
