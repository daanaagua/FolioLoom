import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { analyzeSourceAnomalies } from "../src/source/anomaly-report.js";

test("source anomaly report is deterministic, bounded, and never mutates source text", () => {
  const longLine = "x".repeat(2_100);
  const source = [
    "THE DRAGON WAITING",
    "John M. Ford",
    "Ma- chiavelli crossed the room.\u0007",
    "THE DRAGON WAITING",
    "A replacement: \uFFFD",
    longLine,
  ].join("\n");
  const before = createHash("sha256").update(source).digest("hex");

  const first = analyzeSourceAnomalies(source, { maxSamplesPerCode: 2 });
  const second = analyzeSourceAnomalies(source, { maxSamplesPerCode: 2 });

  assert.deepEqual(first, second);
  assert.equal(createHash("sha256").update(source).digest("hex"), before);
  assert.deepEqual(first.findings.map((finding) => finding.code), [
    "CONTROL_CHARACTER",
    "EXTREME_LONG_LINE",
    "REPEATED_FRONTMATTER_LINE",
    "REPLACEMENT_CHARACTER",
    "SPACED_HYPHENATION",
  ]);
  assert.equal(first.counts.SPACED_HYPHENATION, 1);
  assert.equal(first.counts.REPLACEMENT_CHARACTER, 1);
  assert.equal(first.counts.CONTROL_CHARACTER, 1);
  assert.equal(first.counts.REPEATED_FRONTMATTER_LINE, 1);
  assert.equal(first.counts.EXTREME_LONG_LINE, 1);
  assert.ok(first.findings.every((finding) => finding.samples.length <= 2));
  assert.ok(first.findings.flatMap((finding) => finding.samples)
    .every((sample) => sample.scalarStart >= 0 && sample.excerpt.length <= 180));
});

test("source anomaly report leaves normal literary prose clean", () => {
  const report = analyzeSourceAnomalies(
    "A short first paragraph.\n\nA second paragraph with ordinary punctuation.",
  );
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.counts, {
    CONTROL_CHARACTER: 0,
    EXTREME_LONG_LINE: 0,
    REPEATED_FRONTMATTER_LINE: 0,
    REPLACEMENT_CHARACTER: 0,
    SPACED_HYPHENATION: 0,
  });
});
