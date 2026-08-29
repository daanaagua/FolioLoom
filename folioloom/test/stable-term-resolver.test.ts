import assert from "node:assert/strict";
import test from "node:test";

import type { StableTerm } from "../src/domain/types.js";
import { resolveStableTermsForBlocks } from "../src/knowledge/stable-term-resolver.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

const glossary: StableTerm = {
  conceptId: "glossary-severian",
  lexemeId: "glossary-severian-form",
  sourceForm: "Severian",
  canonicalSource: "Severian",
  target: "塞维安",
  locked: true,
  policy: "locked",
  origin: "glossary",
};

const override: StableTerm = {
  conceptId: "rule-concealed",
  baseConceptId: "entity-severian",
  ruleId: "concealed",
  lexemeId: "rule-concealed-form",
  sourceForm: "Severian",
  canonicalSource: "Severian",
  target: "灰袍人",
  allowedTargets: ["灰袍人"],
  locked: true,
  policy: "locked",
  origin: "knowledge",
  authorityRank: 60,
  priority: 0,
  applicability: {
    kind: "block_range",
    sourceVersion: "source-v1",
    startBlockId: "block-1",
    endBlockId: "block-1",
    startGlobalIndex: 1,
    endGlobalIndex: 1,
  },
};

test("resolves a manual range override per immutable source block", () => {
  const result = resolveStableTermsForBlocks(
    [glossary, override],
    [
      { sourceVersion: "source-v1", blockId: "block-0", globalIndex: 0 },
      { sourceVersion: "source-v1", blockId: "block-1", globalIndex: 1 },
    ],
    getSourceLanguageProfile("en"),
  );

  assert.deepEqual(result.map((term) => ({
    target: term.target,
    blockIds: term.applicableBlockIds,
  })), [
    { target: "塞维安", blockIds: ["block-0"] },
    { target: "灰袍人", blockIds: ["block-1"] },
  ]);
});

test("keeps only one equivalent winner when several blocks share a rule", () => {
  const result = resolveStableTermsForBlocks(
    [glossary],
    [
      { sourceVersion: "source-v1", blockId: "block-0", globalIndex: 0 },
      { sourceVersion: "source-v1", blockId: "block-1", globalIndex: 1 },
    ],
    getSourceLanguageProfile("en"),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.applicableBlockIds, undefined);
});
