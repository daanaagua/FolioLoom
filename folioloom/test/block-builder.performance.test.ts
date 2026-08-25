import assert from "node:assert/strict";
import test from "node:test";

import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import type {
  TokenEstimate,
  TokenEstimator,
  UsageObservation,
} from "../src/source/token-estimator.js";

class CountingKoreanEstimator implements TokenEstimator {
  readonly id = "counting-korean";
  readonly version = "counting-korean-v1";
  calls = 0;
  estimatedCharacters = 0;

  estimateText(text: string): TokenEstimate {
    this.calls += 1;
    this.estimatedCharacters += text.length;
    return {
      tokens: text.length,
      uncertainty: 0,
      estimatorVersion: this.version,
      calibrationFactor: 1,
    };
  }

  observeUsage(_sample: UsageObservation): void {}
}

test("generic estimators receive bounded linear work for a large Korean source", () => {
  const source = "\uadf8\ub294 \ud559\uad50\uc5d0 \uac04\ub2e4.".repeat(10_000);
  const estimator = new CountingKoreanEstimator();
  const blocks = buildLosslessBlocks(source, [], {
    maxSourceTokens: 64,
    sourceVersion: "large-ko-v1",
    languageProfile: getSourceLanguageProfile("ko"),
    tokenEstimator: estimator,
  });

  assert.equal(blocks.map((block) => block.sourceText).join(""), source);
  assert.ok(
    estimator.calls < blocks.length * 14,
    `expected bounded estimator calls, got ${estimator.calls} for ${blocks.length} blocks`,
  );
  assert.ok(
    estimator.estimatedCharacters < source.length * 40,
    `expected linear estimator input, got ${estimator.estimatedCharacters} for ${source.length}`,
  );
});
