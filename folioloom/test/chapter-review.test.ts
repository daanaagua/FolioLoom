import assert from "node:assert/strict";
import test from "node:test";
import { planChapterReviews, chapterReviewCoverage, chapterReviewMetadata, type ChapterReviewCheckpoint } from "../src/fullbook/chapter-review.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import type { LosslessBlock } from "../src/source/types.js";
import type { SupervisionRecord } from "../src/domain/supervision.js";

function blocks(texts: string[]): LosslessBlock[] {
  let offset = 0;
  return texts.map((sourceText, globalIndex) => {
    const canonicalStart = offset;
    offset += Array.from(sourceText).length;
    return { id: `b${globalIndex}`, sourceVersion: "source", canonicalStart, canonicalEnd: offset, sourceText,
      sourceHash: "hash", globalIndex, tokenCount: 100, structureId: null, structureTitle: null };
  });
}

test("chapter review recognizes wrapped EPUB headings without rebuilding immutable source blocks", () => {
  const source = blocks(["⟦E0.0.0⟧Chapter 1⟦/E0.0.0⟧\n\nAn opening.\n\n",
    "An ending.\n\n⟦E1.0.0⟧Chapter 2⟦/E1.0.0⟧\n\nAnother opening.\n\n", "A conclusion."]);
  const before = structuredClone(source);
  const windows = source.map((b, ordinal) => ({ windowId: `w${ordinal}`, blockIds: [b.id] }));
  const scopes = planChapterReviews(source, windows, getSourceLanguageProfile("en"));
  assert.deepEqual(scopes.map(s => ({ title: s.title, windows: s.windowIds })), [
    { title: "Chapter 1", windows: ["w0", "w1"] }, { title: "Chapter 2", windows: ["w1", "w2"] },
  ]);
  assert.deepEqual(source, before);
  assert.deepEqual(planChapterReviews(source, windows, getSourceLanguageProfile("en")), scopes);
});

test("tiny chapters sharing one immutable window consume one chapter checkpoint", () => {
  const source = blocks(["Chapter 1\n\nFirst.\n\nChapter 2\n\nSecond."]);
  const scopes = planChapterReviews(source, [{ windowId: "w0", blockIds: ["b0"] }], getSourceLanguageProfile("en"));
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]!.title, "Chapter 1 / Chapter 2");
});

test("chapter coverage needs the atomically applied checkpoint, not just a model verdict", () => {
  const policy = chapterReviewMetadata([{ id: "a".repeat(64), title: "Chapter 1", windowIds: ["w0", "w1"] }]);
  const record: SupervisionRecord = { id: "decision", key: "key", event: "review", state: "completed",
    inputHash: "b".repeat(64), candidateHash: "c".repeat(64), windowIds: ["w0"],
    decision: { action: "accept", windowIds: ["w0"], reviewBlockIds: [], guidance: [], issues: [], reason: "Checked." },
    chapterReview: { scopeId: policy.scopes[0]!.id, title: "Chapter 1" } };
  assert.equal(chapterReviewCoverage(policy, [], [record])!.pendingScopes[0]!.windowIds.length, 2);
  const checkpoint: ChapterReviewCheckpoint = { schema: "chapter-review-checkpoint-1", scopeId: policy.scopes[0]!.id,
    windowIds: ["w0"], decisionId: record.id, candidateHash: record.candidateHash!, qualityItemIds: [] };
  assert.deepEqual(chapterReviewCoverage(policy, [checkpoint], [record])!.pendingScopes[0]!.windowIds, ["w1"]);
  assert.throws(() => chapterReviewCoverage(policy, [{ ...checkpoint, candidateHash: "d".repeat(64) }], [record]), /checkpoint/u);
  assert.throws(() => chapterReviewCoverage(policy, [checkpoint], []), /checkpoint/u);
  assert.equal(chapterReviewCoverage(undefined, [], []), undefined);
});
