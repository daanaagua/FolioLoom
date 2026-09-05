import assert from "node:assert/strict";
import test from "node:test";

import type { StableTerm } from "../src/domain/types.js";
import { resolveStableTermsForBlocks } from "../src/knowledge/stable-term-resolver.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { stableTermsFromKnowledge } from "../src/knowledge/stable-terms-from-knowledge.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { performance } from "node:perf_hooks";

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

test("projects a durable multi-form rule through the actual request resolver", () => {
  const knowledge = new KnowledgeStore();
  const payload = { ruleId: "captain", conceptId: "captain", sourceForms: ["Captain", "Skipper"],
    target: "船长", allowedTargets: ["船长"], policy: "locked", selector: { kind: "whole_book" }, priority: 0 };
  const revision = knowledge.appendRevision({ normalizedSubject: "captain", kind: "term_rendering_rule:captain",
    payload, alternatives: [payload], status: "active", authority: { origin: "manual", scope: "book", ownedFields: ["/target"] } });
  const result = resolveStableTermsForBlocks(stableTermsFromKnowledge([revision]),
    [{ sourceVersion: "s", blockId: "b", globalIndex: 0 }], getSourceLanguageProfile("en"));
  assert.deepEqual(result.map((term) => term.sourceForm).sort(), ["Captain", "Skipper"]);
});

test("resolves a large candidate vocabulary without repeatedly normalizing the complete rule table", () => {
  const terms: StableTerm[] = Array.from({ length: 2000 }, (_, index) => ({
    ...glossary, origin: "knowledge", conceptId: `concept-${index}`, lexemeId: `form-${index}`,
    sourceForm: `Name${index}`, canonicalSource: `Name${index}`,
  }));
  const blocks = Array.from({ length: 8 }, (_, index) => ({ sourceVersion: "s", blockId: `b-${index}`, globalIndex: index }));
  const start = performance.now();
  const result = resolveStableTermsForBlocks(terms, blocks, getSourceLanguageProfile("en"));
  assert.equal(result.length, terms.length);
  assert.ok(performance.now() - start < 5000, "2,000 candidates / 8 blocks must resolve within a generous 5s budget");
});

test("shadows only the winning spelling of a multi-form rule", () => {
  const primary: StableTerm = { ...glossary, ruleId: "base" };
  const alias: StableTerm = { ...primary, sourceForm: "Sev", lexemeId: "alias" };
  const blocks = [0, 1].map((index) => ({
    sourceVersion: "source-v1", blockId: `block-${index}`, globalIndex: index,
  }));
  const result = resolveStableTermsForBlocks([primary, alias, override], blocks,
    getSourceLanguageProfile("en"));
  assert.deepEqual(result.find((term) => term.ruleId === "base" && term.sourceForm === "Severian")
    ?.applicableBlockIds, ["block-0"]);
  assert.equal(result.find((term) => term.sourceForm === "Sev")?.applicableBlockIds, undefined);
  assert.deepEqual(result.find((term) => term.ruleId === "concealed")?.applicableBlockIds, ["block-1"]);
});

test("still rejects incompatible metadata sharing a rule ID", () => {
  assert.throws(() => resolveStableTermsForBlocks([
    { ...glossary, ruleId: "same" },
    { ...glossary, ruleId: "same", sourceForm: "Sev", lexemeId: "alias", target: "另一个人" },
  ], [{ sourceVersion: "s", blockId: "b", globalIndex: 0 }], getSourceLanguageProfile("en")),
  /TERM_RULE_ID_CONFLICT/);
});
