import assert from "node:assert/strict";
import test from "node:test";

import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import {
  completeTermUsagesFromTarget,
  conceptsFromStableTerms,
  expectedTermOccurrences,
  termReceiptSurfaceAccepted,
  termSurfaceAllowed,
  validateTermUsages,
  type TermUsageSubmission,
} from "../src/knowledge/term-usage.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

const prokurist = conceptFromAnchor({
  sourceForm: "Prokurist",
  target: "主事",
  mode: "contextual",
  semanticClass: "role",
  confidence: 0.95,
});

const blocks = [{
  id: "block-0",
  sourceText: "Der Prokurist kam. Der Prokurist sprach.",
}, {
  id: "block-1",
  sourceText: "Gregor antwortete dem Prokurist.",
}];

test("scoped stable terms create receipts only for their resolved blocks", () => {
  const concepts = conceptsFromStableTerms([{
    conceptId: "term-default",
    lexemeId: "term-default-form",
    sourceForm: "Prokurist",
    canonicalSource: "Prokurist",
    target: "主事",
    locked: true,
    policy: "locked",
    semanticClass: "role",
    allowedTargets: ["主事"],
    revisionId: "a".repeat(64),
    renderFingerprint: "b".repeat(64),
    applicableBlockIds: ["block-0"],
  }, {
    conceptId: "term-late",
    lexemeId: "term-late-form",
    sourceForm: "Prokurist",
    canonicalSource: "Prokurist",
    target: "公司代表",
    locked: true,
    policy: "locked",
    semanticClass: "role",
    allowedTargets: ["公司代表"],
    revisionId: "c".repeat(64),
    renderFingerprint: "d".repeat(64),
    applicableBlockIds: ["block-1"],
  }]);
  const expected = expectedTermOccurrences(
    blocks,
    concepts,
    getSourceLanguageProfile("de"),
  );

  assert.deepEqual(expected.map((item) => ({
    blockId: item.blockId,
    conceptId: item.conceptId,
    target: item.canonicalTarget,
  })), [
    { blockId: "block-0", conceptId: "term-default", target: "主事" },
    { blockId: "block-0", conceptId: "term-default", target: "主事" },
    { blockId: "block-1", conceptId: "term-late", target: "公司代表" },
  ]);
});

test("nonlocked term receipts record compact actual surfaces without creating a hard lock", () => {
  assert.equal(termReceiptSurfaceAccepted({
    policy: "preferred",
    allowedRealizations: ["布林"],
  }, "布林号"), true);
  assert.equal(termReceiptSurfaceAccepted({
    policy: "preferred",
    allowedRealizations: ["布林"],
  }, "布林2号"), true);
  assert.equal(termReceiptSurfaceAccepted({
    policy: "preferred",
    allowedRealizations: ["栉足蛛属"],
  }, "栉足蛛"), true);
  assert.equal(termReceiptSurfaceAccepted({
    policy: "preferred",
    allowedRealizations: ["栉足蛛属"],
  }, "疣蛛"), true);
  assert.equal(termReceiptSurfaceAccepted({
    policy: "contextual",
    allowedRealizations: ["主事"],
  }, "公司代表"), true);
  assert.equal(termReceiptSurfaceAccepted({
    policy: "preferred",
    allowedRealizations: ["布林"],
  }, "包含 空格"), false);
  assert.equal(termReceiptSurfaceAccepted({
    policy: "locked",
    allowedRealizations: ["布林"],
  }, "布林号"), false);
  assert.equal(termSurfaceAllowed({
    policy: "preferred",
    allowedRealizations: ["布林"],
  }, "布林号"), false);
});

function submission(
  occurrence: ReturnType<typeof expectedTermOccurrences>[number],
  targetSurface = "主事",
): TermUsageSubmission {
  return {
    occurrenceId: occurrence.occurrenceId,
    blockId: occurrence.blockId,
    conceptId: occurrence.conceptId,
    sourceForm: occurrence.sourceForm,
    sourceStart: occurrence.sourceStart,
    sourceEnd: occurrence.sourceEnd,
    discourseRole: "narrative",
    targetSurface,
  };
}

test("term usage rejects a disallowed target without hiding it behind missing receipts", () => {
  const lockedProkurist = reviseConcept(prokurist, { policy: "locked" });
  const expected = expectedTermOccurrences(
    blocks,
    [lockedProkurist],
    getSourceLanguageProfile("de"),
  );
  assert.equal(expected.length, 3);

  assert.deepEqual(validateTermUsages(expected, [
    submission(expected[0]!, "秘书主任"),
  ], new Map([
    ["block-0", "秘书主任来了。他随后开口。"],
    ["block-1", "格里高尔作了回答。"],
  ])), [{
    code: "TERM_USAGE_TARGET_NOT_ALLOWED",
    occurrenceId: expected[0]!.occurrenceId,
  }]);
});

test("term usage accepts an allowed base realization and a short contextual surface", () => {
  const expected = expectedTermOccurrences(
    blocks,
    [prokurist],
    getSourceLanguageProfile("de"),
  );
  const exact = expected.map((occurrence) => submission(occurrence));
  assert.deepEqual(validateTermUsages(expected, exact, new Map([
    ["block-0", "主事来了。主事随后开口。"],
    ["block-1", "格里高尔回答了主事。"],
  ])), []);

  const contextual = expected.map((occurrence) =>
    submission(occurrence, "主事先生"));
  assert.deepEqual(validateTermUsages(expected, contextual, new Map([
    ["block-0", "主事先生来了。主事先生随后开口。"],
    ["block-1", "格里高尔回答了主事先生。"],
  ])), []);
});

test("term usage rejects forged offsets and source forms", () => {
  const expected = expectedTermOccurrences(
    blocks,
    [prokurist],
    getSourceLanguageProfile("de"),
  );
  assert.deepEqual(validateTermUsages(expected, [{
    ...submission(expected[0]!),
    sourceStart: expected[0]!.sourceStart + 1,
  }], new Map([["block-0", "主事来了。"]])), [{
    code: "TERM_USAGE_SOURCE_MISMATCH",
    occurrenceId: expected[0]!.occurrenceId,
  }]);
  assert.deepEqual(validateTermUsages(expected, [{
    ...submission(expected[0]!),
    sourceForm: "Direktor",
  }], new Map([["block-0", "主事来了。"]])), [{
    code: "TERM_USAGE_SOURCE_MISMATCH",
    occurrenceId: expected[0]!.occurrenceId,
  }]);
});

test("term usage rejects a surface absent from the translated block", () => {
  const expected = expectedTermOccurrences(
    blocks,
    [prokurist],
    getSourceLanguageProfile("de"),
  );
  assert.deepEqual(validateTermUsages(expected, [
    submission(expected[0]!),
  ], new Map([["block-0", "公司代表来了。"]])), [{
    code: "TERM_USAGE_TARGET_NOT_FOUND",
    occurrenceId: expected[0]!.occurrenceId,
  }]);
});

test("term usage reports omitted and duplicate occurrence receipts deterministically", () => {
  const expected = expectedTermOccurrences(
    blocks,
    [prokurist],
    getSourceLanguageProfile("de"),
  );
  assert.deepEqual(validateTermUsages(expected, [], new Map()), []);
  const lockedExpected = expectedTermOccurrences(
    blocks,
    [reviseConcept(prokurist, { policy: "locked" })],
    getSourceLanguageProfile("de"),
  );
  assert.deepEqual(validateTermUsages(lockedExpected, [], new Map()), lockedExpected.map(
    (occurrence) => ({
      code: "TERM_USAGE_MISSING",
      occurrenceId: occurrence.occurrenceId,
    }),
  ));
  assert.deepEqual(validateTermUsages(expected, [
    submission(expected[0]!),
    submission(expected[0]!),
  ], new Map([["block-0", "主事来了。"]])), [{
    code: "TERM_USAGE_DUPLICATE",
    occurrenceId: expected[0]!.occurrenceId,
  }]);
});

test("deterministic completion fills only omitted receipts supported by target text", () => {
  const expected = expectedTermOccurrences(
    blocks,
    [prokurist],
    getSourceLanguageProfile("de"),
  );
  const targetByBlock = new Map([
    ["block-0", "主事来了。主事随后开口。"],
    ["block-1", "格里高尔回答了主事。"],
  ]);
  const completed = completeTermUsagesFromTarget(
    expected,
    [],
    targetByBlock,
  );
  assert.deepEqual(
    completed.map((item) => item.occurrenceId),
    expected.map((item) => item.occurrenceId),
  );
  assert.deepEqual(validateTermUsages(expected, completed, targetByBlock), []);

  const invalid = submission(expected[0]!, "秘书主任");
  const preserved = completeTermUsagesFromTarget(
    expected,
    [invalid],
    targetByBlock,
  );
  assert.equal(
    preserved.filter((item) =>
      item.occurrenceId === invalid.occurrenceId).length,
    1,
  );
  assert.deepEqual(
    validateTermUsages(expected, preserved, targetByBlock),
    [{
      code: "TERM_USAGE_TARGET_NOT_FOUND",
      occurrenceId: invalid.occurrenceId,
    }],
  );
});
