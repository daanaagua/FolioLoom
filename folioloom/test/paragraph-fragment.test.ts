import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleParagraphFragmentCandidates,
  paragraphFragmentFirstRequired,
  planParagraphFragments,
  type ParagraphFragmentCandidate,
} from "../src/fullbook/paragraph-fragment.js";
import type { LosslessBlock } from "../src/source/types.js";

function block(
  sourceText: string,
  tokenCount = Math.max(1, Math.ceil(Array.from(sourceText).length / 4)),
): LosslessBlock {
  return {
    id: "block-0123456789abcdefabcd",
    sourceVersion: "source-v1",
    canonicalStart: 100,
    canonicalEnd: 100 + [...sourceText].length,
    sourceText,
    sourceHash: "a".repeat(64),
    globalIndex: 12,
    tokenCount,
    estimatorVersion: "test",
    structureId: "chapter-1",
    structureTitle: null,
  };
}

function acceptedCandidates(
  plan: ReturnType<typeof planParagraphFragments>,
): ParagraphFragmentCandidate[] {
  return plan.units.map((unit) => ({
    planId: plan.planId,
    executionUnitId: unit.executionUnitId,
    windowId: plan.windowId,
    blockId: plan.blockId,
    sourceHash: plan.sourceHash,
    snapshotId: plan.snapshotId,
    paragraphs: unit.paragraphs.map((paragraph) => ({
      paragraphId: paragraph.paragraphId,
      text: `译文 ${paragraph.ordinal + 1}`,
    })),
    termUsages: [],
    notes: [],
    memoryCandidates: [],
  }));
}

test("paragraph planner creates deterministic exact-cover units for tx8-shaped blocks", () => {
  const source = Array.from(
    { length: 23 },
    (_, index) => `Source paragraph ${index + 1}.`,
  ).join("\n\n");
  const first = planParagraphFragments({
    windowId: "window-tx8",
    block: block(source),
    snapshotId: "snapshot-1",
  });
  const second = planParagraphFragments({
    windowId: "window-tx8",
    block: block(source),
    snapshotId: "snapshot-1",
  });

  assert.equal(first.planId, second.planId);
  assert.deepEqual(
    first.units.map((unit) => unit.paragraphs.length),
    [8, 8, 7],
  );
  assert.deepEqual(
    first.units.flatMap((unit) => unit.paragraphs.map((paragraph) =>
      paragraph.paragraphId)),
    first.paragraphs.map((paragraph) => paragraph.paragraphId),
  );
  assert.equal(new Set(first.units.map((unit) => unit.executionUnitId)).size, 3);
});

test("paragraph planner treats certified scene separators as paragraph boundaries", () => {
  const plan = planParagraphFragments({
    windowId: "window-scene",
    block: block("First scene.[[]]Second scene.\n\nThird scene."),
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 2,
  });

  assert.deepEqual(
    plan.paragraphs.map((paragraph) => paragraph.sourceText),
    ["First scene.", "Second scene.", "Third scene."],
  );
  assert.equal(plan.units.length, 2);
});

test("paragraph planner bounds a unit by estimated source tokens as well as count", () => {
  const source = Array.from(
    { length: 8 },
    (_, index) => `${String(index)} ${"ordinary ".repeat(90)}`,
  ).join("\n\n");
  const sourceBlock = block(source, 1_451);
  const plan = planParagraphFragments({
    windowId: "window-source-budget",
    block: sourceBlock,
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 6,
    maxSourceTokens: 320,
  });

  assert.ok(plan.units.length > 2);
  assert.ok(plan.units.every((unit) =>
    unit.paragraphs.length === 1
    || Math.ceil(
      sourceBlock.tokenCount
      * unit.paragraphs.reduce(
        (total, paragraph, index) =>
          total
          + paragraph.scalarEnd
          - paragraph.scalarStart
          + (index === 0 ? 0 : 2),
        0,
      )
      / Array.from(source).length,
    ) <= 320));
  assert.deepEqual(
    plan.units.flatMap((unit) =>
      unit.paragraphs.map((paragraph) => paragraph.paragraphId)),
    plan.paragraphs.map((paragraph) => paragraph.paragraphId),
  );
});

test("fragment-first threshold is structural and not a token-only decision", () => {
  const thirteen = Array.from(
    { length: 13 },
    (_, index) => `Short ${index + 1}.`,
  ).join("\n\n");
  const twelve = Array.from(
    { length: 12 },
    (_, index) => `Short ${index + 1}.`,
  ).join("\n\n");

  assert.equal(paragraphFragmentFirstRequired(block(thirteen)), true);
  assert.equal(paragraphFragmentFirstRequired(block(twelve)), false);
});

test("paragraph planner never splits a protected canonical source occurrence", () => {
  const source = Array.from(
    { length: 12 },
    (_, index) => `Source paragraph ${index + 1}.`,
  ).join("\n\n");
  const sourceBlock = block(source);
  const unprotected = planParagraphFragments({
    windowId: "window-protected",
    block: sourceBlock,
    snapshotId: "snapshot-1",
  });
  const left = unprotected.paragraphs[5];
  const right = unprotected.paragraphs[6];
  assert.ok(left !== undefined);
  assert.ok(right !== undefined);

  const protectedPlan = planParagraphFragments({
    windowId: "window-protected",
    block: sourceBlock,
    snapshotId: "snapshot-1",
    protectedSourceRanges: [{
      sourceStart: left.scalarEnd - 1,
      sourceEnd: right.scalarStart + 1,
    }],
  });

  assert.deepEqual(
    protectedPlan.units.map((unit) => unit.paragraphs.length),
    [5, 7],
  );
  assert.notEqual(protectedPlan.planId, unprotected.planId);
});

test("paragraph spans expose both scalar and UTF-16 coordinates", () => {
  const plan = planParagraphFragments({
    windowId: "window-unicode",
    block: block("😀 First.\n\nSecond."),
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 1,
  });

  assert.deepEqual(
    plan.paragraphs.map((paragraph) => ({
      scalarStart: paragraph.scalarStart,
      scalarEnd: paragraph.scalarEnd,
      utf16Start: paragraph.utf16Start,
      utf16End: paragraph.utf16End,
    })),
    [
      { scalarStart: 0, scalarEnd: 8, utf16Start: 0, utf16End: 9 },
      { scalarStart: 10, scalarEnd: 17, utf16Start: 11, utf16End: 18 },
    ],
  );
});

test("assembler restores one canonical block only after exact paragraph cover", () => {
  const plan = planParagraphFragments({
    windowId: "window-tx8",
    block: block("One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.\n\nSeven."),
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 3,
  });
  const assembled = assembleParagraphFragmentCandidates(
    plan,
    acceptedCandidates(plan).reverse(),
  );

  assert.deepEqual(assembled.translation, {
    blockId: plan.blockId,
    text: [
      "译文 1",
      "译文 2",
      "译文 3",
      "译文 4",
      "译文 5",
      "译文 6",
      "译文 7",
    ].join("\n\n"),
  });
});

test("assembler rejects missing, duplicate, reordered, or foreign paragraph identity", () => {
  const plan = planParagraphFragments({
    windowId: "window-tx8",
    block: block("One.\n\nTwo.\n\nThree."),
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 2,
  });
  const candidates = acceptedCandidates(plan);

  assert.throws(
    () => assembleParagraphFragmentCandidates(plan, candidates.slice(0, 1)),
    /execution unit exact cover/u,
  );

  assert.throws(
    () => assembleParagraphFragmentCandidates(plan, [
      candidates[0] as ParagraphFragmentCandidate,
      candidates[0] as ParagraphFragmentCandidate,
      candidates[1] as ParagraphFragmentCandidate,
    ]),
    /duplicate execution unit/u,
  );

  const reordered = structuredClone(candidates);
  reordered.at(-1)?.paragraphs.reverse();
  assert.throws(
    () => assembleParagraphFragmentCandidates(plan, reordered),
    /paragraph order/u,
  );

  const foreign = structuredClone(candidates);
  if (foreign[0]?.paragraphs[0] !== undefined) {
    foreign[0].paragraphs[0].paragraphId = "block-foreign:paragraph:0000";
  }
  assert.throws(
    () => assembleParagraphFragmentCandidates(plan, foreign),
    /paragraph exact cover/u,
  );
});

test("assembler rejects mixed plan, source, and snapshot lineage", () => {
  const plan = planParagraphFragments({
    windowId: "window-tx8",
    block: block("One.\n\nTwo.\n\nThree."),
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 2,
  });

  for (const field of ["planId", "sourceHash", "snapshotId"] as const) {
    const candidates = acceptedCandidates(plan);
    candidates[0] = { ...candidates[0] as ParagraphFragmentCandidate, [field]: "foreign" };
    assert.throws(
      () => assembleParagraphFragmentCandidates(plan, candidates),
      /fragment candidate lineage/u,
    );
  }
});
