import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditSourceCoverage } from "../src/source/auditor.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import {
  SourceIntegrityError,
  SourceLedger,
} from "../src/source/source-ledger.js";
import { annotateStructure } from "../src/source/structure-annotator.js";
import { scalarLength } from "../src/source/types.js";

function sha256(payload: string | Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

interface LedgerFixture {
  directory: string;
  manifestPath: string;
  rawPath: string;
  canonicalPath: string;
}

interface LedgerFixtureOptions {
  raw?: Buffer;
  sourceFormat?: string;
  encoding?: string;
  extractor?: string;
  canonicalSegments?: readonly Record<string, unknown>[];
  excludedRawRanges?: readonly Record<string, unknown>[];
  sourceLanguage?: string;
}

function ledgerFixture(
  source: string,
  options: LedgerFixtureOptions = {},
): LedgerFixture {
  const directory = mkdtempSync(join(tmpdir(), "v5-source-ledger-"));
  const rawPath = join(directory, "original.txt");
  const canonicalPath = join(directory, "source.txt");
  const manifestPath = join(directory, "source_manifest.json");
  const raw = options.raw ?? Buffer.from(source, "utf8");
  const canonical = Buffer.from(source, "utf8");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, canonical);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: raw.length,
    raw_sha256: sha256(raw),
    source_format: options.sourceFormat ?? ".txt",
    encoding: options.encoding ?? "utf-8",
    extractor: options.extractor ?? "plain-text-v1",
    ...(options.sourceLanguage === undefined
      ? {}
      : { sourceLanguage: options.sourceLanguage }),
    canonical_path: "source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: sha256(canonical),
    canonical_segments: options.canonicalSegments ?? [{
      canonical_start: 0,
      canonical_end: scalarLength(source),
      origin_kind: "decoded_bytes",
      origin_ref: "source/original.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: options.excludedRawRanges ?? [],
  }), "utf8");
  return { directory, manifestPath, rawPath, canonicalPath };
}

function mutateManifest(
  fixture: LedgerFixture,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const manifest = JSON.parse(
    readFileSync(fixture.manifestPath, "utf8"),
  ) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(fixture.manifestPath, JSON.stringify(manifest), "utf8");
}

function expectIntegrityCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => (
    error instanceof SourceIntegrityError && error.code === code
  ));
}

test("lossless source ledger verifies hashes and keeps Unicode scalar coordinates", () => {
  const fixture = ledgerFixture("A😀\nB");
  try {
    const ledger = SourceLedger.open(fixture.manifestPath);
    assert.equal(ledger.sourceText, "A😀\nB");
    const canonicalHash = sha256(Buffer.from("A😀\nB"));
    assert.equal(ledger.sourceVersion, sha256(JSON.stringify([
      ["schema_version", "v5-source-ledger-1"],
      ["raw_sha256", canonicalHash],
      ["canonical_sha256", canonicalHash],
      ["source_format", ".txt"],
      ["encoding", "utf-8"],
      ["extractor", "plain-text-v1"],
      ["canonical_segments", [[
        ["canonical_start", 0],
        ["canonical_end", 4],
        ["origin_kind", "decoded_bytes"],
        ["origin_ref", "source/original.txt"],
        ["transformation", "decode+newline-normalize"],
        ["raw_start", 0],
        ["raw_end", Buffer.byteLength("A😀\nB")],
      ]]],
      ["excluded_raw_ranges", []],
    ])));
    assert.equal(ledger.canonicalChars, 4);
    assert.equal(ledger.slice(1, 2), "😀");
    assert.deepEqual(
      ledger.canonicalSegments.map((segment) => [segment.canonicalStart, segment.canonicalEnd]),
      [[0, 4]],
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("lossless source version includes raw payload and extraction provenance", () => {
  const source = "Same canonical text.\n";
  const first = ledgerFixture(source, {
    raw: Buffer.from("epub-container-one"),
    sourceFormat: ".epub",
    encoding: "container",
    extractor: "epub-spine-v1",
    excludedRawRanges: [{
      raw_start: 0,
      raw_end: Buffer.byteLength("epub-container-one"),
      policy: "EPUB_NON_SPINE_DATA",
    }],
  });
  const second = ledgerFixture(source, {
    raw: Buffer.from("epub-container-two"),
    sourceFormat: ".epub",
    encoding: "container",
    extractor: "epub-spine-v1",
    excludedRawRanges: [{
      raw_start: 0,
      raw_end: Buffer.byteLength("epub-container-two"),
      policy: "EPUB_NON_SPINE_DATA",
    }],
  });
  const third = ledgerFixture(source, {
    raw: Buffer.from("epub-container-one"),
    sourceFormat: ".epub",
    encoding: "container",
    extractor: "epub-spine-v2",
    excludedRawRanges: [{
      raw_start: 0,
      raw_end: Buffer.byteLength("epub-container-one"),
      policy: "EPUB_NON_SPINE_DATA",
    }],
  });
  try {
    const firstLedger = SourceLedger.open(first.manifestPath);
    const secondLedger = SourceLedger.open(second.manifestPath);
    const thirdLedger = SourceLedger.open(third.manifestPath);
    assert.notEqual(firstLedger.sourceVersion, secondLedger.sourceVersion);
    assert.notEqual(firstLedger.sourceVersion, thirdLedger.sourceVersion);
    assert.equal(
      SourceLedger.open(first.manifestPath).sourceVersion,
      firstLedger.sourceVersion,
    );

    const firstBlocks = buildLosslessBlocks(
      firstLedger,
      annotateStructure(firstLedger, firstLedger.sourceVersion),
    );
    const secondBlocks = buildLosslessBlocks(
      secondLedger,
      annotateStructure(secondLedger, secondLedger.sourceVersion),
    );
    assert.notDeepEqual(
      firstBlocks.map((block) => block.id),
      secondBlocks.map((block) => block.id),
    );
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
    rmSync(second.directory, { recursive: true, force: true });
    rmSync(third.directory, { recursive: true, force: true });
  }
});

test("source language profile participates in new source identity", () => {
  const english = ledgerFixture("Same source.", { sourceLanguage: "en" });
  const french = ledgerFixture("Same source.", { sourceLanguage: "fr" });
  try {
    const englishLedger = SourceLedger.open(english.manifestPath);
    const frenchLedger = SourceLedger.open(french.manifestPath);
    assert.equal(englishLedger.sourceLanguage, "en");
    assert.equal(frenchLedger.sourceLanguage, "fr");
    assert.equal(englishLedger.sourceLanguageCompatibilityMode, false);
    assert.notEqual(englishLedger.sourceVersion, frenchLedger.sourceVersion);
    assert.equal(englishLedger.languageProfile.id, "en");
    assert.equal(frenchLedger.languageProfile.id, "fr");
  } finally {
    rmSync(english.directory, { recursive: true, force: true });
    rmSync(french.directory, { recursive: true, force: true });
  }
});

test("legacy manifest keeps its old identity while loading English compatibility", () => {
  const fixture = ledgerFixture("Legacy source.");
  try {
    const before = SourceLedger.open(fixture.manifestPath);
    assert.equal(before.sourceLanguage, "en");
    assert.equal(before.languageProfile.id, "en");
    assert.equal(before.sourceLanguageCompatibilityMode, true);

    mutateManifest(fixture, (manifest) => {
      manifest.sourceLanguage = "en";
    });
    const explicit = SourceLedger.open(fixture.manifestPath);
    assert.notEqual(before.sourceVersion, explicit.sourceVersion);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("lossless source version includes validated lineage without JSON field-order drift", () => {
  const source = "Canonical text.";
  const raw = Buffer.from("same-container-payload");
  const segment = {
    canonical_start: 0,
    canonical_end: scalarLength(source),
    origin_kind: "container_member",
    origin_ref: "OPS/chapter-1.xhtml",
    transformation: "extract-text",
  };
  const common = {
    raw,
    sourceFormat: ".epub",
    encoding: "container",
    extractor: "epub-spine-v1",
  };
  const baseline = ledgerFixture(source, {
    ...common,
    canonicalSegments: [segment],
    excludedRawRanges: [{
      raw_start: 0,
      raw_end: raw.length,
      policy: "EPUB_NON_SPINE_DATA",
    }],
  });
  const changedSegment = ledgerFixture(source, {
    ...common,
    canonicalSegments: [{
      ...segment,
      origin_ref: "OPS/chapter-2.xhtml",
    }],
    excludedRawRanges: [{
      raw_start: 0,
      raw_end: raw.length,
      policy: "EPUB_NON_SPINE_DATA",
    }],
  });
  const changedExclusion = ledgerFixture(source, {
    ...common,
    canonicalSegments: [segment],
    excludedRawRanges: [
      {
        raw_start: 0,
        raw_end: 4,
        policy: "EPUB_NON_SPINE_DATA",
      },
      {
        raw_start: 4,
        raw_end: raw.length,
        policy: "EPUB_NON_SPINE_DATA",
      },
    ],
  });
  const reorderedFields = ledgerFixture(source, {
    ...common,
    canonicalSegments: [{
      transformation: "extract-text",
      origin_ref: "OPS/chapter-1.xhtml",
      origin_kind: "container_member",
      canonical_end: scalarLength(source),
      canonical_start: 0,
    }],
    excludedRawRanges: [{
      policy: "EPUB_NON_SPINE_DATA",
      raw_end: raw.length,
      raw_start: 0,
    }],
  });
  try {
    const baselineVersion = SourceLedger.open(baseline.manifestPath).sourceVersion;
    assert.notEqual(
      baselineVersion,
      SourceLedger.open(changedSegment.manifestPath).sourceVersion,
    );
    assert.notEqual(
      baselineVersion,
      SourceLedger.open(changedExclusion.manifestPath).sourceVersion,
    );
    assert.equal(
      baselineVersion,
      SourceLedger.open(reorderedFields.manifestPath).sourceVersion,
    );
  } finally {
    rmSync(baseline.directory, { recursive: true, force: true });
    rmSync(changedSegment.directory, { recursive: true, force: true });
    rmSync(changedExclusion.directory, { recursive: true, force: true });
    rmSync(reorderedFields.directory, { recursive: true, force: true });
  }
});

test("lossless source ledger rejects a manifest member that escapes through a symlink", () => {
  const fixture = ledgerFixture("Alpha.");
  const outside = mkdtempSync(join(tmpdir(), "v5-source-outside-"));
  try {
    writeFileSync(
      join(outside, "original.txt"),
      readFileSync(fixture.rawPath),
    );
    symlinkSync(
      outside,
      join(fixture.directory, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    mutateManifest(fixture, (manifest) => {
      manifest.raw_path = "escape/original.txt";
    });

    expectIntegrityCode(
      () => SourceLedger.open(fixture.manifestPath),
      "MANIFEST_PATH_INVALID",
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("lossless source ledger rejects raw and canonical tampering with stable codes", () => {
  const rawFixture = ledgerFixture("Alpha.");
  const canonicalFixture = ledgerFixture("Beta.");
  try {
    writeFileSync(rawFixture.rawPath, "Omega!", "utf8");
    expectIntegrityCode(
      () => SourceLedger.open(rawFixture.manifestPath),
      "RAW_HASH_MISMATCH",
    );

    writeFileSync(canonicalFixture.canonicalPath, "Zeta!", "utf8");
    expectIntegrityCode(
      () => SourceLedger.open(canonicalFixture.manifestPath),
      "CANONICAL_HASH_MISMATCH",
    );
  } finally {
    rmSync(rawFixture.directory, { recursive: true, force: true });
    rmSync(canonicalFixture.directory, { recursive: true, force: true });
  }
});

test("lossless source ledger rejects segment gaps and unknown exclusion policies", () => {
  const gapFixture = ledgerFixture("Alpha.");
  const policyFixture = ledgerFixture("Beta.");
  try {
    mutateManifest(gapFixture, (manifest) => {
      manifest.canonical_segments = [{
        canonical_start: 1,
        canonical_end: 6,
        origin_kind: "decoded_bytes",
        origin_ref: "source/original.txt",
        transformation: "decode+newline-normalize",
      }];
    });
    expectIntegrityCode(
      () => SourceLedger.open(gapFixture.manifestPath),
      "CANONICAL_SEGMENTS_INVALID",
    );

    mutateManifest(policyFixture, (manifest) => {
      manifest.excluded_raw_ranges = [{
        raw_start: 0,
        raw_end: 1,
        policy: "free-form exclusion",
      }];
    });
    expectIntegrityCode(
      () => SourceLedger.open(policyFixture.manifestPath),
      "EXCLUDED_POLICY_UNKNOWN",
    );
  } finally {
    rmSync(gapFixture.directory, { recursive: true, force: true });
    rmSync(policyFixture.directory, { recursive: true, force: true });
  }
});

test("lossless blocks cover canonical source exactly once despite duplicate chapter names", () => {
  const source = "Book One\n\nChapter I\n\nAlpha.\n\nBook Two\n\nChapter I\n\nBeta.";
  const annotations = annotateStructure(source, "source-v1");
  const blocks = buildLosslessBlocks(source, annotations, { maxSourceTokens: 8 });
  const report = auditSourceCoverage(source, blocks);
  assert.equal(report.ok, true);
  assert.equal(blocks.map((item) => item.sourceText).join(""), source);
  assert.equal(new Set(blocks.map((item) => item.id)).size, blocks.length);
  assert.equal(
    annotations.filter((item) => item.kind === "chapter_heading").length,
    2,
  );
});

test("auditor reports the exact first gap without using chapter ids", () => {
  const source = "Alpha.\n\nBeta.";
  const blocks = buildLosslessBlocks(source, [], { maxSourceTokens: 100 });
  const report = auditSourceCoverage(source, [{ ...blocks[0]!, canonicalEnd: 5 }]);
  assert.equal(report.ok, false);
  assert.equal(report.incidents[0]?.code, "SOURCE_SPAN_GAP");
  assert.equal(report.incidents[0]?.start, 5);
});

test("auditor independently detects overlap and source hash tampering", () => {
  const source = "Alpha.\n\nBeta.";
  const blocks = buildLosslessBlocks(source, [], { maxSourceTokens: 2 });
  assert.ok(blocks.length >= 2);
  const overlap = blocks.map((block, index) => index === 1
    ? { ...block, canonicalStart: block.canonicalStart - 1 }
    : block);
  const overlapReport = auditSourceCoverage(source, overlap);
  assert.equal(overlapReport.ok, false);
  assert.equal(overlapReport.incidents[0]?.code, "SOURCE_SPAN_OVERLAP");

  const tampered = blocks.map((block, index) => index === 0
    ? { ...block, sourceHash: "0".repeat(64) }
    : block);
  assert.ok(
    auditSourceCoverage(source, tampered).incidents.some(
      (incident) => incident.code === "SOURCE_HASH_MISMATCH",
    ),
  );
});

test("auditor rejects a zero-length ghost block as an invalid source span", () => {
  const source = "Alpha.\n\nBeta.";
  const blocks = buildLosslessBlocks(source, [], { maxSourceTokens: 100 });
  const ghost = {
    ...blocks[0]!,
    canonicalEnd: blocks[0]!.canonicalStart,
    sourceText: "",
    sourceHash: sha256(""),
  };
  const report = auditSourceCoverage(source, [ghost]);

  assert.equal(report.ok, false);
  assert.equal(report.incidents[0]?.code, "SOURCE_SPAN_INVALID");
  assert.equal(report.incidents[0]?.start, report.incidents[0]?.end);
});
