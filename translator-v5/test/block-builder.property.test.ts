import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { auditLosslessBookStore } from "../src/report.js";
import { auditSourceCoverage } from "../src/source/auditor.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import { annotateStructure } from "../src/source/structure-annotator.js";
import { scalarLength, scalarSlice } from "../src/source/types.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function generatedSource(sample: number): string {
  const random = xorshift32(0x9e37_79b9 ^ sample);
  const newline = ["\n", "\r\n", "\r"][random() % 3] as string;
  const volume = `Book ${(random() % 3) + 1}`;
  const chapter = random() % 5 === 0 ? "Chapter" : "Chapter I";
  const unicode = ["烟雾😀", "naïve café", "Ωρίων", "𐍈music"][
    random() % 4
  ] as string;
  const tinyCount = (random() % 8) + 1;
  const tiny = Array.from(
    { length: tinyCount },
    (_unused, index) => `${index % 2 === 0 ? chapter : "Chapter I"}${newline}${unicode} ${index}.`,
  );
  const long = sample % 20 === 0
    ? `${newline}${newline}${"Long paragraph 😀. ".repeat(300)}`
    : "";
  return [volume, ...tiny, volume].join(`${newline}${newline}`) + long;
}

test("property: 240 fixed-seed books have unique scalar blocks with exact reconstruction", () => {
  for (let sample = 0; sample < 240; sample += 1) {
    const source = generatedSource(sample);
    const sourceVersion = `source-${sample}`;
    const annotations = annotateStructure(source, sourceVersion);
    const blocks = buildLosslessBlocks(source, annotations, {
      maxSourceTokens: (sample % 31) + 1,
      sourceVersion,
    });
    const report = auditSourceCoverage(source, blocks, { sourceVersion });

    assert.equal(report.ok, true, `sample ${sample}: ${JSON.stringify(report.incidents)}`);
    assert.equal(blocks.map((block) => block.sourceText).join(""), source);
    assert.equal(new Set(blocks.map((block) => block.id)).size, blocks.length);
    assert.equal(blocks[0]?.canonicalStart, 0);
    assert.equal(blocks.at(-1)?.canonicalEnd, scalarLength(source));
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      assert.equal(block.globalIndex, index);
      assert.equal(
        block.sourceText,
        scalarSlice(source, block.canonicalStart, block.canonicalEnd),
      );
      if (index > 0) {
        assert.equal(block.canonicalStart, blocks[index - 1]?.canonicalEnd);
      }
    }
  }
});

test("property: emoji ranges stay Unicode-scalar while slices reconstruct exact UTF-16 text", () => {
  const source = "Chapter I\n\nA😀B.\n\nChapter I\n\nC𐍈D.";
  const annotations = annotateStructure(source, "emoji-source");
  const blocks = buildLosslessBlocks(source, annotations, {
    maxSourceTokens: 2,
    sourceVersion: "emoji-source",
  });

  assert.equal(blocks.at(-1)?.canonicalEnd, scalarLength(source));
  assert.notEqual(scalarLength(source), source.length);
  assert.equal(blocks.map((block) => block.sourceText).join(""), source);
  assert.equal(auditSourceCoverage(source, blocks, { sourceVersion: "emoji-source" }).ok, true);
});

test("property: block ids do not depend on structure titles", () => {
  const source = "Chapter I\n\nAlpha.\n\nChapter I\n\nBeta.";
  const annotations = annotateStructure(source, "stable-source");
  const renamed = annotations.map((annotation) => ({
    ...annotation,
    title: `renamed-${annotation.title}`,
  }));
  const options = { maxSourceTokens: 4, sourceVersion: "stable-source" };

  assert.deepEqual(
    buildLosslessBlocks(source, annotations, options).map((block) => block.id),
    buildLosslessBlocks(source, renamed, options).map((block) => block.id),
  );
});

function manifestFor(source: string, label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `v5-acceptance-${label}-`));
  const hasBom = source.startsWith("\uFEFF");
  const canonical = hasBom ? source.slice(1) : source;
  const rawPayload = Buffer.from(source, "utf8");
  const canonicalPayload = Buffer.from(canonical, "utf8");
  const rawHash = createHash("sha256").update(rawPayload).digest("hex");
  const canonicalHash = createHash("sha256").update(canonicalPayload).digest("hex");
  writeFileSync(join(directory, "original.txt"), rawPayload);
  writeFileSync(join(directory, "source.txt"), canonicalPayload);
  const manifestPath = join(directory, "source_manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: rawPayload.length,
    raw_sha256: rawHash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    canonical_path: "source.txt",
    canonical_chars: scalarLength(canonical),
    canonical_sha256: canonicalHash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: scalarLength(canonical),
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: hasBom ? 3 : 0,
      raw_end: rawPayload.length,
      transformation: hasBom ? "strip-bom+decode" : "decode+newline-normalize",
    }],
    excluded_raw_ranges: hasBom
      ? [{ raw_start: 0, raw_end: 3, policy: "UTF8_BOM" }]
      : [],
  }), "utf8");
  return manifestPath;
}

const ACCEPTANCE_SHAPES = [
  ["no-chapters", "Unsectioned prose with no chapter heading.\n\nA second paragraph."],
  [
    "duplicate-volume-chapter",
    "BOOK ONE\n\nCHAPTER I\n\nAlpha.\n\nBOOK ONE\n\nCHAPTER I\n\nBeta.",
  ],
  [
    "thousand-short-chapters",
    Array.from({ length: 1_000 }, (_unused, index) =>
      `CHAPTER I\n\nShort chapter ${index}.`).join("\n\n"),
  ],
  ["hundred-thousand-char-paragraph", "L".repeat(100_000)],
  ["bom-unicode-controls", "\uFEFFHeading\u001F text \u202E bidirectional 😀 終.\n\nTail."],
  [
    "same-name-toc-and-body",
    "CONTENTS\n\nCHAPTER I — HOME\n\nCHAPTER I\n\nHOME\n\nThe body named HOME.",
  ],
  ["empty-title", "CHAPTER\n\n\n\nBody after an empty title line.\n\nCHAPTER\n\nTail."],
  ["repeated-paragraphs", Array.from({ length: 24 }, () => "Same paragraph.").join("\n\n")],
] as const;

test("property: eight acceptance shapes traverse ledger through schema audit with zero model calls", () => {
  for (const [label, source] of ACCEPTANCE_SHAPES) {
    const manifestPath = manifestFor(source, label);
    const context = BookContext.openLossless({ manifestPath });
    const store = new LosslessBookStore(join(dirname(manifestPath), `${label}.db`));
    const runId = `acceptance-${label}`;
    try {
      assert.equal(
        context.losslessBlocks.map((block) => block.sourceText).join(""),
        source.startsWith("\uFEFF") ? source.slice(1) : source,
      );
      store.registerSource(context.certifiedSource!);
      store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
        blocks: context.losslessBlocks,
        annotations: context.annotations,
      });
      const snapshot = createKnowledgeSnapshot(runId, []);
      store.createTranslationRun({
        runId,
        sourceVersion: context.sourceLedger.sourceVersion,
        protocolVersion: "v5-book-3",
        modelId: "zero-model-calls",
        initialSnapshotId: snapshot.id,
        initialSnapshot: snapshot,
        metadata: { acceptanceShape: label },
      });
      const windows = planBookWindows(context.losslessBlocks, {
        protocolVersion: "v5-book-3",
      });
      store.initializeWindowPlan(runId, windows);
      const audit = auditLosslessBookStore(store, runId);
      assert.deepEqual(audit.incidentCodes, [], label);
      assert.equal(audit.totalBlockCount, context.losslessBlocks.length, label);
      assert.equal(store.statusSummary(runId).totalWindows, windows.length, label);
      assert.equal(store.statusSummary(runId).modelCalls, 0, label);
    } finally {
      store.close();
      context.close();
    }
  }
});
