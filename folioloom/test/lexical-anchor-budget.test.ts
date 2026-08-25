import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareLexicalAnchorRequest,
  type AnchorCandidate,
} from "../src/agents/lexical-anchorer.js";
import { assessLexicalAnchorAttempt } from "../src/fullbook/lexical-anchor-budget.js";
import type { TranslationRuntime } from "../src/fullbook/types.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { WeightedTokenEstimator } from "../src/source/token-estimator.js";

function candidates(): AnchorCandidate[] {
  return Array.from({ length: 16 }, (_, index) => ({
    sourceForm: `Candidate-${index}`,
    likelyProperName: true,
    contexts: [
      `Candidate-${index} appeared in a compact but fully serialized concordance.`,
      `Later Candidate-${index} returned beside another named figure.`,
    ],
    corpusFrequency: 4,
    currentWaveOccurrences: 2,
    documentFrequency: 2,
    morphologyDiversity: 1,
  }));
}

function runtime(): TranslationRuntime {
  return {
    model: {
      id: "deepseek-v4-flash",
      contextWindow: 131_072,
      maxTokens: 37_200,
    },
    effort: "high",
    thinkingLevel: "high",
  } as unknown as TranslationRuntime;
}

test("lexical anchor preparation exposes the exact prompt and provider tool schema", () => {
  const input = {
    candidates: candidates(),
    stableTerms: [],
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  };
  const structured = prepareLexicalAnchorRequest(input, "typed_tool");
  const framed = prepareLexicalAnchorRequest(input, "framed_text");

  assert.match(structured.prompt, /Candidate-15/u);
  assert.match(structured.serializedToolSchemas, /submit_lexical_anchors/u);
  assert.equal(structured.toolSchemaPayload.length, 1);
  assert.equal(framed.serializedToolSchemas, "[]");
  assert.ok(framed.fallbackProtocol !== undefined);
});

test("sixteen-candidate anchor budget replaces the old 1,920-token constant", () => {
  const budget = assessLexicalAnchorAttempt({
    candidates: candidates(),
    stableTerms: [],
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  }, runtime(), new WeightedTokenEstimator(), "typed_tool");

  assert.ok(budget.totalReserved > 1_920);
  assert.ok(budget.assessment.reasoningUpperBound >= 18_958);
  assert.deepEqual(
    budget.assessment.components.map((component) => component.kind),
    ["system", "request", "tool_schemas"],
  );
  assert.ok(
    budget.assessment.visibleOutputUpperBound
      + budget.assessment.reasoningUpperBound
      <= runtime().model.maxTokens,
  );
});
