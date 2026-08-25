import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RequestBudgeter,
  type RequestTokenEstimator,
} from "../src/fullbook/request-budgeter.js";
import {
  outputReserveTokens,
  reasoningReserveTokens,
} from "../src/fullbook/execution-worker.js";
import type { TranslationRuntime } from "../src/fullbook/types.js";
import type { PhysicalRequestPlan } from "../src/fullbook/types.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { WeightedTokenEstimator } from "../src/source/token-estimator.js";
import type { LosslessBlock } from "../src/source/types.js";

function block(id: string, index: number, sourceText: string): LosslessBlock {
  return {
    id,
    sourceVersion: "source-v1",
    canonicalStart: index * 100,
    canonicalEnd: index * 100 + sourceText.length,
    sourceText,
    sourceHash: createHash("sha256").update(sourceText).digest("hex"),
    globalIndex: index,
    tokenCount: 10,
    structureId: null,
    structureTitle: null,
  };
}

function fixture() {
  const blocks = [
    block("block-0", 0, "First source paragraph that must be budgeted."),
    block("block-1", 1, "Second source paragraph that must be budgeted."),
  ];
  const request: PhysicalRequestPlan = {
    requestId: "request-budget-fixture",
    sourceTokens: 20,
    windows: blocks.map((item, ordinal) => ({
      windowId: `window-${ordinal}`,
      ordinal,
      chapterId: "chapter-0",
      chapterTitle: null,
      blockIds: [item.id],
      globalIndexes: [ordinal],
      sourceTokens: item.tokenCount,
      sourceChars: item.sourceText.length,
      oversized: false,
    })),
  };
  return {
    request,
    blocks,
    stableTerms: [{
      conceptId: "archon",
      lexemeId: "archon-lexeme",
      sourceForm: "Archon",
      canonicalSource: "Archon",
      target: "执政官",
      locked: true,
    }],
    snapshot: {
      id: "snapshot-budget-fixture",
      revisions: [{ id: "memory-1", fact: "A remembered fact with useful context." }],
    },
    sourceLanguageProfile: getSourceLanguageProfile("en"),
    entityLinkWarnings: ["Alias evidence remains unresolved."],
    styleState: { register: "literary restraint" },
    previousActiveTail: "A prior stylistic tail.",
  };
}

class CharacterEstimator implements RequestTokenEstimator {
  textCalls = 0;
  jsonCalls = 0;

  estimateText(text: string) {
    this.textCalls += 1;
    return {
      tokens: Math.max(1, [...text].length),
      uncertainty: 2,
      estimatorVersion: "fixture-estimator-1",
    };
  }

  estimateJson(value: unknown) {
    this.jsonCalls += 1;
    return {
      tokens: Math.max(1, [...JSON.stringify(value)].length),
      uncertainty: 3,
      estimatorVersion: "fixture-estimator-1",
    };
  }
}

test("complete request budgeting includes every serialized input, output, reasoning, and safety reserve", () => {
  const estimator = new CharacterEstimator();
  const budget = new RequestBudgeter(estimator, {
    contextWindowTokens: 180,
    outputTokens: 40,
    reasoningReserveTokens: 30,
    safetyMarginTokens: 20,
  }).assess(fixture());

  assert.deepEqual(budget.components.map((component) => component.kind), [
    "system",
    "request",
    "memory",
    "source",
    "terms",
    "style",
    "protocol",
    "tool_schemas",
  ]);
  assert.ok(budget.components.find((component) => component.kind === "source")?.tokens ?? 0 > 0);
  assert.ok(budget.components.find((component) => component.kind === "terms")?.tokens ?? 0 > 0);
  assert.ok(budget.components.find((component) => component.kind === "memory")?.tokens ?? 0 > 0);
  assert.ok(budget.components.find((component) => component.kind === "style")?.tokens ?? 0 > 0);
  assert.ok(budget.components.find((component) => component.kind === "tool_schemas")?.tokens ?? 0 > 0);
  assert.equal(budget.outputTokens, 40);
  assert.equal(budget.reasoningReserveTokens, 30);
  assert.equal(budget.safetyMarginTokens, 20);
  assert.ok(budget.totalReserved > (budget.components.find((component) => component.kind === "source")?.tokens ?? 0));
  assert.equal(budget.decision, "split_request");
  assert.ok(estimator.textCalls > 0);
  assert.ok(estimator.jsonCalls > 0);
});

test("an oversized single logical window is marked for further window splitting rather than scheduler backoff", () => {
  const estimator = new CharacterEstimator();
  const input = fixture();
  input.request.windows.splice(1, 1);
  input.blocks = input.blocks.slice(0, 1);
  input.request.windows[0]!.blockIds = ["block-0"];
  const budget = new RequestBudgeter(estimator, {
    contextWindowTokens: 120,
    outputTokens: 40,
    reasoningReserveTokens: 30,
    safetyMarginTokens: 20,
  }).assess(input);

  assert.equal(budget.decision, "split_window");
  assert.equal(budget.fits, false);
});

test("complete-request budgeting remains compatible with a text-only source token estimator", () => {
  const budget = new RequestBudgeter(new WeightedTokenEstimator(), {
    contextWindowTokens: 10_000,
    outputTokens: 400,
    reasoningReserveTokens: 200,
    safetyMarginTokens: 100,
  }).assess(fixture());

  assert.equal(budget.fits, true);
  assert.equal(budget.decision, "accepted");
  assert.ok(budget.components.some((component) => component.kind === "tool_schemas"));
});

test("request budgeting applies usage calibration only to the matching model scope", () => {
  const estimator = new WeightedTokenEstimator();
  estimator.observeUsage({
    modelId: "model-a",
    profile: fixture().sourceLanguageProfile,
    estimatedTokens: 100,
    actualInputTokens: 125,
  });
  const options = {
    contextWindowTokens: 10_000,
    outputTokens: 400,
    reasoningReserveTokens: 200,
    safetyMarginTokens: 100,
  } as const;

  const calibrated = new RequestBudgeter(estimator, {
    ...options,
    modelId: "model-a",
  }).assess(fixture());
  const unrelated = new RequestBudgeter(estimator, {
    ...options,
    modelId: "model-b",
  }).assess(fixture());

  assert.ok(calibrated.inputTokens > unrelated.inputTokens);
  assert.equal(
    new RequestBudgeter(estimator, options).assess(fixture()).inputTokens,
    unrelated.inputTokens,
  );
});

test("high-effort cold start reserves the observed DeepSeek reasoning envelope", () => {
  const runtime = {
    model: {
      id: "deepseek-v4-flash",
      maxTokens: 37_200,
    },
    effort: "high",
    thinkingLevel: "high",
  } as unknown as TranslationRuntime;

  assert.ok(reasoningReserveTokens(runtime) >= 18_958);
  assert.ok(reasoningReserveTokens(runtime) <= runtime.model.maxTokens);
});

test("visible output plus reasoning never exceeds model completion capacity", () => {
  const runtime = {
    model: {
      id: "deepseek-v4-flash",
      maxTokens: 37_200,
    },
    effort: "max",
    thinkingLevel: "high",
  } as unknown as TranslationRuntime;
  const request = {
    requestId: "completion-cap",
    sourceTokens: 100_000,
    windows: [],
  };

  assert.ok(
    outputReserveTokens(request, runtime) + reasoningReserveTokens(runtime)
      <= runtime.model.maxTokens,
  );
});
