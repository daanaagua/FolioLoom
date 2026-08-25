import assert from "node:assert/strict";
import test from "node:test";

import { getSourceLanguageProfile } from "../src/language/profiles.js";
import {
  WeightedTokenEstimator,
} from "../src/source/token-estimator.js";

test("CJK is conservatively denser than Latin", () => {
  const estimator = new WeightedTokenEstimator();
  const japanese = getSourceLanguageProfile("ja");
  const korean = getSourceLanguageProfile("ko");
  const english = getSourceLanguageProfile("en");

  assert.ok(estimator.estimateText("彼は学校へ行く。".repeat(100), japanese).tokens > 500);
  assert.ok(estimator.estimateText("그는 학교에 간다.".repeat(100), korean).tokens > 500);
  assert.ok(estimator.estimateText("He goes to school. ".repeat(100), english).tokens < 700);
});

test("calibration is bounded and scoped to a model/profile pair", () => {
  const estimator = new WeightedTokenEstimator();
  const japanese = getSourceLanguageProfile("ja");
  const english = getSourceLanguageProfile("en");
  const text = "彼は学校へ行く。".repeat(10);
  const base = estimator.estimateText(text, japanese).tokens;

  estimator.observeUsage({
    modelId: "model-a",
    profile: japanese,
    estimatedTokens: base,
    actualInputTokens: base * 10,
  });

  const calibrated = estimator.estimateText(text, japanese, { modelId: "model-a" });
  const otherModel = estimator.estimateText(text, japanese, { modelId: "model-b" });
  const otherProfile = estimator.estimateText(text, english, { modelId: "model-a" });

  assert.ok(calibrated.tokens > base);
  assert.ok(calibrated.tokens < base * 2);
  assert.equal(otherModel.tokens, base);
  assert.equal(otherProfile.tokens, base);
});

test("JSON estimation measures the serialized request shape", () => {
  const estimator = new WeightedTokenEstimator();
  const profile = getSourceLanguageProfile("en");
  const payload = { term: "Piaton", aliases: ["the slave", "the second head"] };

  assert.equal(
    estimator.estimateJson(payload, profile).tokens,
    estimator.estimateText(JSON.stringify(payload), profile).tokens,
  );
});

test("cursor finds a bounded source range from one prefix index", () => {
  const estimator = new WeightedTokenEstimator();
  const profile = getSourceLanguageProfile("ko");
  const source = "\uadf8\ub294 \ud559\uad50\uc5d0 \uac04\ub2e4.".repeat(200);
  const cursor = estimator.createCursor(source, profile);
  const end = cursor.maximumEndWithinBudget(0, 64);

  assert.ok(end > 0 && end < source.length);
  assert.ok(cursor.estimateRangeUpperBound(0, end).tokens <= 64);
  assert.ok(cursor.estimateRangeUpperBound(0, end + 1).tokens > 64);
});
