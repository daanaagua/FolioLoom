import assert from "node:assert/strict";
import test from "node:test";

import { createTermRenderingRule } from "../src/knowledge/term-rendering-rule.js";
import { planTermRetrofit } from "../src/knowledge/term-retrofit.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

const rule = createTermRenderingRule({
  ruleId: "prokurist-late",
  conceptId: "role-prokurist",
  sourceForms: ["Prokurist"],
  target: "公司代表",
  allowedTargets: ["公司代表"],
  policy: "locked",
  selector: {
    kind: "block_range",
    sourceVersion: "source-v1",
    startBlockId: "block-1",
    endBlockId: "block-3",
    startGlobalIndex: 1,
    endGlobalIndex: 3,
  },
  priority: 0,
  authorityRank: 60,
});

test("plans only receipt-backed unique surfaces as local repairs", () => {
  const plan = planTermRetrofit({
    runId: "run-a",
    ruleRevisionId: "a".repeat(64),
    baseGeneration: 4,
    baseSnapshotId: "snapshot-4",
    rule,
    blocks: [{
      blockId: "block-0",
      sourceVersion: "source-v1",
      globalIndex: 0,
      sourceText: "Der Prokurist kam.",
      translationId: 10,
      translationText: "主事来了。",
      termUsages: [{
        occurrenceId: "outside",
        blockId: "block-0",
        conceptId: "old-prokurist",
        sourceForm: "Prokurist",
        sourceStart: 4,
        sourceEnd: 13,
        discourseRole: "narrative",
        targetSurface: "主事",
      }],
    }, {
      blockId: "block-1",
      sourceVersion: "source-v1",
      globalIndex: 1,
      sourceText: "Der Prokurist kam. Der Prokurist sprach.",
      translationId: 11,
      translationText: "主事来了。主事开口了。",
      termUsages: [{
        occurrenceId: "one",
        blockId: "block-1",
        conceptId: "old-prokurist",
        sourceForm: "Prokurist",
        sourceStart: 4,
        sourceEnd: 13,
        discourseRole: "narrative",
        targetSurface: "主事",
      }, {
        occurrenceId: "two",
        blockId: "block-1",
        conceptId: "old-prokurist",
        sourceForm: "Prokurist",
        sourceStart: 19,
        sourceEnd: 28,
        discourseRole: "narrative",
        targetSurface: "主事",
      }],
    }, {
      blockId: "block-2",
      sourceVersion: "source-v1",
      globalIndex: 2,
      sourceText: "Der Prokurist wartete.",
      translationId: 12,
      translationText: "那位职员等着。",
      termUsages: [],
    }, {
      blockId: "block-3",
      sourceVersion: "source-v1",
      globalIndex: 3,
      sourceText: "Der Prokurist ging.",
      translationId: 13,
      translationText: "主事和另一位主事离开了。",
      termUsages: [{
        occurrenceId: "ambiguous",
        blockId: "block-3",
        conceptId: "old-prokurist",
        sourceForm: "Prokurist",
        sourceStart: 4,
        sourceEnd: 13,
        discourseRole: "narrative",
        targetSurface: "主事",
      }],
    }],
    profile: getSourceLanguageProfile("de"),
  });

  assert.deepEqual(plan.items.map((item) => ({
    blockId: item.blockId,
    classification: item.classification,
    replacementText: item.replacementText,
  })), [{
    blockId: "block-1",
    classification: "local_repair",
    replacementText: "公司代表来了。公司代表开口了。",
  }, {
    blockId: "block-2",
    classification: "model_retranslate",
    replacementText: undefined,
  }, {
    blockId: "block-3",
    classification: "model_retranslate",
    replacementText: undefined,
  }]);
  assert.equal(plan.summary.localRepair, 1);
  assert.equal(plan.summary.modelRetranslate, 2);
  assert.match(plan.planHash, /^[0-9a-f]{64}$/u);
});

test("classifies an already compliant translated block as noop", () => {
  const plan = planTermRetrofit({
    runId: "run-a",
    ruleRevisionId: "b".repeat(64),
    baseGeneration: 5,
    baseSnapshotId: "snapshot-5",
    rule,
    blocks: [{
      blockId: "block-1",
      sourceVersion: "source-v1",
      globalIndex: 1,
      sourceText: "Der Prokurist kam.",
      translationId: 20,
      translationText: "公司代表来了。",
      termUsages: [{
        occurrenceId: "compliant",
        blockId: "block-1",
        conceptId: "rule-prokurist",
        sourceForm: "Prokurist",
        sourceStart: 4,
        sourceEnd: 13,
        discourseRole: "narrative",
        targetSurface: "公司代表",
      }],
    }],
    profile: getSourceLanguageProfile("de"),
  });
  assert.equal(plan.items[0]?.classification, "noop");
});

test("never performs a local string repair across two concepts sharing one source form", () => {
  const common = {
    blockId: "block-1",
    sourceForm: "Prokurist",
    sourceStart: 4,
    sourceEnd: 13,
    discourseRole: "narrative" as const,
    targetSurface: "主事",
  };
  const plan = planTermRetrofit({
    runId: "run-a",
    ruleRevisionId: "c".repeat(64),
    baseGeneration: 6,
    baseSnapshotId: "snapshot-6",
    rule,
    blocks: [{
      blockId: "block-1",
      sourceVersion: "source-v1",
      globalIndex: 1,
      sourceText: "Der Prokurist kam.",
      translationId: 21,
      translationText: "主事见到了另一位主事。",
      termUsages: [{
        ...common,
        occurrenceId: "company-role",
        conceptId: "company-prokurist",
      }, {
        ...common,
        occurrenceId: "legal-role",
        conceptId: "legal-prokurist",
      }],
    }],
    profile: getSourceLanguageProfile("de"),
  });

  assert.equal(plan.items[0]?.classification, "model_retranslate");
  assert.equal(
    plan.items[0]?.reason,
    "source_form_has_multiple_concept_receipts",
  );
  assert.equal(plan.items[0]?.replacementText, undefined);
});
