import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_KOREAN_FULL_TARGET_SCALARS,
  BENCHMARK_PILOT_TARGET_SCALARS,
  benchmarkReport,
  createOfflineBenchmarkPlan,
  executeCjkBenchmark,
  readBenchmarkEnvironment,
  selectBenchmarkSample,
} from "../src/benchmark/cjk-benchmark.js";

test("benchmark selects complete paragraphs and reports hashes without prose", () => {
  const fixtureText = [
    "fixture secret sentence.",
    "A second complete sentence.",
    "",
    "A separate paragraph ends here.",
    "",
    "One final paragraph for the fixture.",
  ].join("\n");
  const sample = selectBenchmarkSample(fixtureText, 64, { language: "ko" });
  const report = benchmarkReport(sample, {
    model: "deepseek-v4-flash",
    effort: "high",
    usage: { inputTokens: 120, outputTokens: 90 },
    rawResponse: fixtureText,
    apiKey: "fixture-api-key",
  });

  assert.ok(sample.scalarCount <= 64 + 5_000);
  assert.match(sample.text, /(?:\n|[.!?。！？])$/u);
  assert.equal("text" in report, false);
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.match(report.sampleSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(report), /fixture secret sentence/u);
  assert.doesNotMatch(JSON.stringify(report), /fixture-api-key/u);
});

test("benchmark prefers the first complete paragraph after its target over a later open quote", () => {
  const source = `前言。\n\n${"甲".repeat(18)}。\n\n\"${"乙".repeat(18)}. 仍在同一引语中\"\n\n结尾。`;
  const sample = selectBenchmarkSample(source, 20, {
    language: "ko",
    maxOvershootScalars: 26,
  });

  assert.equal(sample.selectionBoundary, "paragraph");
  assert.ok(sample.text.endsWith("。\n\n"));
  assert.equal(sample.text.includes("\""), false);
});

test("benchmark normalizes a UTF-8 BOM and uses Unicode scalar coordinates", () => {
  const sample = selectBenchmarkSample("\uFEFFA😀。\n\nB。", 100, { language: "ja" });

  assert.equal(sample.text, "A😀。\n\nB。");
  assert.equal(sample.sourceScalarCount, 7);
  assert.equal(sample.scalarCount, 7);
  assert.equal(sample.canonicalStart, 0);
  assert.equal(sample.canonicalEnd, 7);
  assert.equal(sample.sourceSha256, selectBenchmarkSample("A😀。\n\nB。", 100, {
    language: "ja",
  }).sourceSha256);
});

test("Korean formal sampling stays near the 200k scalar ceiling at whole boundaries", () => {
  const paragraph = `${"가".repeat(999)}.\n\n`;
  const source = paragraph.repeat(250);
  const sample = selectBenchmarkSample(source, BENCHMARK_KOREAN_FULL_TARGET_SCALARS, {
    language: "ko",
  });

  assert.ok(sample.scalarCount <= BENCHMARK_KOREAN_FULL_TARGET_SCALARS + 5_000);
  assert.ok(sample.scalarCount >= BENCHMARK_KOREAN_FULL_TARGET_SCALARS - 5_000);
  assert.equal(sample.text.endsWith("\n"), true);
  assert.equal(sample.selectionBoundary, "paragraph");
});

test("Japanese formal mode keeps the whole canonical source even above the pilot cap", () => {
  const source = "あいうえお。\n\n".repeat(BENCHMARK_PILOT_TARGET_SCALARS);
  const sample = selectBenchmarkSample(source, BENCHMARK_PILOT_TARGET_SCALARS, {
    language: "ja",
    wholeSource: true,
  });

  assert.equal(sample.selection, "whole_source");
  assert.equal(sample.scalarCount, sample.sourceScalarCount);
  assert.ok(sample.scalarCount > BENCHMARK_PILOT_TARGET_SCALARS);
});

test("offline plan has both 20k pilots and the Japanese-whole/Korean-capped formal runs", () => {
  const plan = createOfflineBenchmarkPlan({
    japaneseSource: "あ。\n\n".repeat(BENCHMARK_PILOT_TARGET_SCALARS),
    koreanSource: "가.\n\n".repeat(BENCHMARK_KOREAN_FULL_TARGET_SCALARS),
    configSha256: "a".repeat(64),
    authConfigured: true,
  });

  assert.deepEqual(plan.runs.map((run) => [run.phase, run.language]), [
    ["pilot", "ja"],
    ["pilot", "ko"],
    ["formal", "ja"],
    ["formal", "ko"],
  ]);
  assert.equal(plan.runs[0]?.sample.scalarCount <= BENCHMARK_PILOT_TARGET_SCALARS + 5_000, true);
  assert.equal(plan.runs[2]?.sample.selection, "whole_source");
  assert.equal(plan.runs[3]?.sample.scalarCount <= BENCHMARK_KOREAN_FULL_TARGET_SCALARS + 5_000, true);
  assert.deepEqual(plan.runs[0]?.plannedVariants, [
    { translationMode: "quality", reasoningEffort: "high" },
    { translationMode: "fast", reasoningEffort: "off" },
  ]);
  assert.deepEqual(plan.runs[2]?.plannedVariants, [
    { translationMode: "fast", reasoningEffort: "off" },
  ]);
  assert.doesNotMatch(JSON.stringify(plan), /あ。|가\./u);
});

test("benchmark environment reports every missing required variable without revealing values", () => {
  assert.throws(
    () => readBenchmarkEnvironment({ FOLIOLOOM_JA_SOURCE: "ja.txt" }),
    /Missing required benchmark environment variables: FOLIOLOOM_KO_SOURCE, BENCH_CONFIG, OPENCODE_AUTH, BENCH_OUTPUT/u,
  );
});

test("report redaction rejects prose-shaped labels and arbitrary metric keys", () => {
  const sample = selectBenchmarkSample("가.\n\n다.", 10, { language: "ko" });
  const apiLikeValue = "sk-1234567890abcdef";
  const serialized = JSON.stringify(benchmarkReport(sample, {
    model: apiLikeValue,
    effort: "fixture secret sentence",
    throughput: { fixture_secret_sentence: 9, sourceScalarsPerSecond: 12 },
  }));

  assert.doesNotMatch(serialized, /fixture secret sentence/u);
  assert.doesNotMatch(serialized, /fixture_secret_sentence/u);
  assert.doesNotMatch(serialized, new RegExp(apiLikeValue, "u"));
  assert.match(serialized, /sourceScalarsPerSecond/u);
});

test("benchmark execution is dry by default and requires an explicit adapter for its six controlled jobs", async () => {
  const input = {
    japaneseSource: "秘密の本文。\n\n次の段落。",
    koreanSource: "비밀 본문이다.\n\n다음 문단이다.",
    configSha256: "b".repeat(64),
    authConfigured: true,
  };
  const invoked: string[] = [];
  const adapter = {
    async execute(request: { runId: string; reasoningEffort: string }): Promise<Record<string, unknown>> {
      invoked.push(`${request.runId}:${request.reasoningEffort}`);
      return {
        model: "deepseek-v4-flash",
        effort: request.reasoningEffort,
        requests: 1,
        rawResponse: input.japaneseSource,
      };
    },
  };

  const dryRun = await executeCjkBenchmark(input, adapter);
  assert.equal(dryRun.execution, "dry_run");
  assert.equal(dryRun.plannedRequestCount, 6);
  assert.deepEqual(invoked, []);

  const executed = await executeCjkBenchmark(input, adapter, { dryRun: false });
  assert.equal(executed.execution, "executed");
  assert.deepEqual(invoked, [
    "pilot-ja-quality:high",
    "pilot-ja-fast:off",
    "pilot-ko-quality:high",
    "pilot-ko-fast:off",
    "formal-ja-fast:off",
    "formal-ko-fast:off",
  ]);
  assert.equal(executed.reports.length, 6);
  assert.doesNotMatch(JSON.stringify(executed), /秘密の本文|비밀 본문|rawResponse/u);
});
