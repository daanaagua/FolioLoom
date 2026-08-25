import assert from "node:assert/strict";
import test from "node:test";

import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import {
  buildConceptOccurrenceIndex,
} from "../src/knowledge/concept-occurrence-index.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import type { SourceLanguageProfile } from "../src/language/types.js";

test("concept occurrence index scans and segments every block once for a large concept batch", () => {
  const concepts = Array.from({ length: 100 }, (_, index) =>
    conceptFromAnchor({
      sourceForm: `Term${index.toString().padStart(3, "0")}`,
      target: `术语${index}`,
      mode: "stable",
      semanticClass: "technical_term",
      confidence: 0.95,
    }));
  const blocks = Array.from({ length: 25 }, (_, index) => ({
    blockId: `block-${index}`,
    sourceText: [
      `Term${index.toString().padStart(3, "0")}`,
      `Term${(index + 25).toString().padStart(3, "0")}`,
      `Term${(index + 50).toString().padStart(3, "0")}`,
    ].join(" met "),
  }));
  const blockTexts = new Set(blocks.map((block) => block.sourceText));
  const base = getSourceLanguageProfile("en");
  let blockNormalizations = 0;
  let blockSegmentations = 0;
  const profile: SourceLanguageProfile = {
    ...base,
    normalizeSourceLiteral(text) {
      if (blockTexts.has(text)) blockNormalizations += 1;
      return base.normalizeSourceLiteral(text);
    },
    segment(text) {
      if (blockTexts.has(text)) blockSegmentations += 1;
      return base.segment(text);
    },
  };

  const occurrences = buildConceptOccurrenceIndex(blocks, concepts, profile);

  assert.equal(blockNormalizations, blocks.length);
  assert.equal(blockSegmentations, blocks.length);
  assert.equal(occurrences.length, 75);
  assert.deepEqual(occurrences[0]?.sourceSpans, [{
    start: 0,
    end: 7,
    sourceForm: "Term000",
  }]);
});

test("concept occurrence index groups repeated exact spans by concept and block", () => {
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });
  const occurrences = buildConceptOccurrenceIndex([{
    blockId: "block-role",
    sourceText: "Der Prokurist sprach mit dem Prokurist.",
  }], [concept], getSourceLanguageProfile("de"));

  assert.deepEqual(occurrences, [{
    conceptId: concept.conceptId,
    blockId: "block-role",
    sourceSpans: [{
      start: 4,
      end: 13,
      sourceForm: "Prokurist",
    }, {
      start: 29,
      end: 38,
      sourceForm: "Prokurist",
    }],
  }]);
});

test("concept occurrence index does not broaden a short word to embedded substrings", () => {
  const concept = conceptFromAnchor({
    sourceForm: "AI",
    target: "人工智能",
    mode: "stable",
    semanticClass: "technical_term",
    confidence: 0.95,
  });
  const sourceText = "AI acted; claim, appraised, waits, and brain are ordinary words.";
  const occurrences = buildConceptOccurrenceIndex([{
    blockId: "block-ai",
    sourceText,
  }], [concept], getSourceLanguageProfile("en"));

  assert.deepEqual(occurrences, [{
    conceptId: concept.conceptId,
    blockId: "block-ai",
    sourceSpans: [{
      start: 0,
      end: 2,
      sourceForm: "AI",
    }],
  }]);
});

test("concept occurrence index does not broaden a possessive source form to its base lemma", () => {
  const concept = conceptFromAnchor({
    sourceForm: "EARTH’S",
    target: "地球的",
    mode: "stable",
    semanticClass: "proper_name",
    confidence: 0.95,
  });
  const occurrences = buildConceptOccurrenceIndex([{
    blockId: "block-base",
    sourceText: "Earth is distant.",
  }, {
    blockId: "block-possessive",
    sourceText: "Earth’s remaining children and EARTH'S orbit.",
  }], [concept], getSourceLanguageProfile("en"));

  assert.deepEqual(occurrences, [{
    conceptId: concept.conceptId,
    blockId: "block-possessive",
    sourceSpans: [{
      start: 0,
      end: 7,
      sourceForm: "Earth’s",
    }, {
      start: 31,
      end: 38,
      sourceForm: "EARTH'S",
    }],
  }]);
});

test("three-million-character occurrence indexing stays one-pass and revision-stable", (t) => {
  const heapBefore = process.memoryUsage().heapUsed;
  let observedHeap = heapBefore;
  const concepts = Array.from({ length: 1_000 }, (_, index) =>
    conceptFromAnchor({
      sourceForm: `ScaleTerm${index.toString().padStart(4, "0")}`,
      target: `术语${index}`,
      mode: "stable",
      semanticClass: "technical_term",
      confidence: 0.9,
    }));
  const impactForm = "ScaleTerm0999";
  const blocks = Array.from({ length: 600 }, (_, index) => {
    const localForm = `ScaleTerm${index.toString().padStart(4, "0")}`;
    const prefix = index < 10
      ? `${localForm} ${impactForm} `
      : `${localForm} `;
    return {
      blockId: `scale-block-${index.toString().padStart(3, "0")}`,
      sourceText: `${prefix}${"x".repeat(5_000 - prefix.length)}`,
    };
  });
  assert.equal(
    blocks.reduce((sum, block) => sum + block.sourceText.length, 0),
    3_000_000,
  );

  const blockTexts = new Set(blocks.map((block) => block.sourceText));
  const base = getSourceLanguageProfile("en");
  let normalizedBlocks = 0;
  let segmentedBlocks = 0;
  const measuredProfile: SourceLanguageProfile = {
    ...base,
    normalizeSourceLiteral(text) {
      if (blockTexts.has(text)) normalizedBlocks += 1;
      return base.normalizeSourceLiteral(text);
    },
    segment(text) {
      if (blockTexts.has(text)) segmentedBlocks += 1;
      return base.segment(text);
    },
  };
  const firstRows = buildConceptOccurrenceIndex(
    blocks,
    concepts,
    measuredProfile,
  );
  observedHeap = Math.max(observedHeap, process.memoryUsage().heapUsed);
  assert.equal(normalizedBlocks, 600);
  assert.equal(segmentedBlocks, 600);
  assert.equal(firstRows.length, 610);

  const rowKeys = new Set(firstRows.map((row) =>
    `${row.conceptId}\0${row.blockId}`));
  const impactIndex = concepts.findIndex((concept) =>
    concept.sourceForms.includes(impactForm));
  assert.notEqual(impactIndex, -1);
  let impact = concepts[impactIndex]!;
  const rowsAfterFirstRevision = rowKeys.size;
  for (let revision = 0; revision < 10; revision += 1) {
    impact = reviseConcept(impact, {
      confidence: 0.8 + revision / 100,
    });
    for (const key of [...rowKeys]) {
      if (key.startsWith(`${impact.conceptId}\0`)) rowKeys.delete(key);
    }
    for (const row of buildConceptOccurrenceIndex(blocks, [impact], base)) {
      rowKeys.add(`${row.conceptId}\0${row.blockId}`);
    }
    observedHeap = Math.max(observedHeap, process.memoryUsage().heapUsed);
  }
  assert.equal(rowKeys.size, rowsAfterFirstRevision);
  const observedHeapDelta = Math.max(0, observedHeap - heapBefore);
  assert.ok(observedHeapDelta < 512 * 1024 * 1024);
  t.diagnostic(JSON.stringify({
    sourceCharacters: 3_000_000,
    blocks: 600,
    concepts: 1_000,
    occurrenceRows: firstRows.length,
    revisions: 10,
    rowsAfterRevisions: rowKeys.size,
    observedHeapDeltaBytes: observedHeapDelta,
  }));
});
