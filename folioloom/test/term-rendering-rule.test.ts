import assert from "node:assert/strict";
import test from "node:test";

import {
  createTermRenderingRule,
  resolveTermRenderingRule,
  ruleAppliesToBlock,
} from "../src/knowledge/term-rendering-rule.js";

const wholeBook = createTermRenderingRule({
  ruleId: "rule-default",
  conceptId: "entity-severian",
  sourceForms: ["Severian"],
  target: "塞维安",
  allowedTargets: ["塞维安"],
  policy: "locked",
  selector: { kind: "whole_book" },
  priority: 0,
  authorityRank: 30,
});

test("resolves a narrower range rule without changing entity identity", () => {
  const concealed = createTermRenderingRule({
    ruleId: "rule-concealed",
    conceptId: "entity-severian",
    entityId: "entity-severian",
    sourceForms: ["Severian"],
    target: "灰袍人",
    allowedTargets: ["灰袍人"],
    policy: "locked",
    selector: {
      kind: "block_range",
      sourceVersion: "source-v1",
      startBlockId: "block-2",
      endBlockId: "block-5",
      startGlobalIndex: 2,
      endGlobalIndex: 5,
    },
    priority: 0,
    authorityRank: 30,
  });

  assert.equal(resolveTermRenderingRule(
    [wholeBook, concealed],
    "severian",
    { sourceVersion: "source-v1", blockId: "block-3", globalIndex: 3 },
  )?.target, "灰袍人");
  assert.equal(resolveTermRenderingRule(
    [wholeBook, concealed],
    "severian",
    { sourceVersion: "source-v1", blockId: "block-7", globalIndex: 7 },
  )?.target, "塞维安");
  assert.equal(concealed.conceptId, wholeBook.conceptId);
});

test("validates source identity and inclusive range endpoints", () => {
  const rule = createTermRenderingRule({
    ruleId: "rule-range",
    conceptId: "concept-a",
    sourceForms: ["Archon"],
    target: "执政官",
    allowedTargets: ["执政官"],
    policy: "preferred",
    selector: {
      kind: "block_range",
      sourceVersion: "source-v1",
      startBlockId: "block-10",
      endBlockId: "block-12",
      startGlobalIndex: 10,
      endGlobalIndex: 12,
    },
    priority: 2,
    authorityRank: 40,
  });

  assert.equal(ruleAppliesToBlock(
    rule,
    { sourceVersion: "source-v1", blockId: "block-10", globalIndex: 10 },
  ), true);
  assert.equal(ruleAppliesToBlock(
    rule,
    { sourceVersion: "source-v1", blockId: "block-12", globalIndex: 12 },
  ), true);
  assert.equal(ruleAppliesToBlock(
    rule,
    { sourceVersion: "source-v2", blockId: "block-11", globalIndex: 11 },
  ), false);
  assert.throws(() => createTermRenderingRule({
    ...rule,
    ruleId: "invalid-range",
    selector: {
      kind: "block_range",
      sourceVersion: "source-v1",
      startBlockId: "block-10",
      endBlockId: "block-12",
      startGlobalIndex: 13,
      endGlobalIndex: 12,
    },
  }), /startGlobalIndex/u);
});

test("rejects equal-precedence overlapping rules with different targets", () => {
  const left = createTermRenderingRule({
    ...wholeBook,
    ruleId: "rule-left",
    target: "主事",
    allowedTargets: ["主事"],
  });
  const right = createTermRenderingRule({
    ...wholeBook,
    ruleId: "rule-right",
    target: "秘书主任",
    allowedTargets: ["秘书主任"],
  });

  assert.throws(() => resolveTermRenderingRule(
    [left, right],
    "Severian",
    { sourceVersion: "source-v1", blockId: "block-1", globalIndex: 1 },
  ), /TERM_RULE_CONFLICT/u);
});

test("manual authority wins over a higher-priority glossary seed", () => {
  const glossary = createTermRenderingRule({
    ...wholeBook,
    ruleId: "rule-glossary",
    target: "旧译",
    allowedTargets: ["旧译"],
    priority: 99,
    authorityRank: 20,
  });
  const manual = createTermRenderingRule({
    ...wholeBook,
    ruleId: "rule-manual",
    target: "新译",
    allowedTargets: ["新译"],
    priority: 0,
    authorityRank: 50,
  });

  assert.equal(resolveTermRenderingRule(
    [glossary, manual],
    "severian",
    { sourceVersion: "source-v1", blockId: "block-1", globalIndex: 1 },
  )?.target, "新译");
});
