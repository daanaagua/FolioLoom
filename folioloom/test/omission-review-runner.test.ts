import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { buildOmissionReviewPlan } from "../src/fullbook/omission-review.js";
import { runOmissionReview, readOmissionReviewStatus } from "../src/fullbook/omission-review-runner.js";
import { createProviderRuntime } from "../src/providers/runtime.js";

const model = createProviderRuntime({ providerId: "deepseek", modelId: "deepseek-flash", reasoningEffort: "high" }, "fixture-secret").model;
const input = { runId: "run", sourceVersion: "source", sourceLanguage: "en", translations: [0, 1].map(i => ({ blockId: `b${i}`, globalIndex: i, chapterId: null, chapterTitle: null, sourceText: "She nodded. The door opened.", text: "门开了。" })) };
const plan = buildOmissionReviewPlan(input, { maxCandidates: 2, sampleCount: 2, seed: "fixed" });
const limits = { maxCalls: 1, maxTokens: 50000, maxOutputTokens: 1024 };
function response(text: string, totalTokens = 120): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    stopReason: "stop", timestamp: 0, usage: { input: 20, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const resultText = JSON.stringify({ verdict: "possible_omission", sourceQuote: "She nodded.", targetQuote: "门开了。", note: "The action is absent." });
test("status retains admission exhaustion even when no request fits the remaining token budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-admission-")), outputDirectory = join(dir, "review"); let calls = 0;
  try {
    const result = await runOmissionReview({ plan, currentInput: () => input, outputDirectory,
      limits: { ...limits, maxTokens: 1 }, model, streamFn: stream(response(resultText), () => calls++) });
    assert.equal(result.stoppedReason, "budget_exhausted");
    assert.equal(readOmissionReviewStatus(outputDirectory).stoppedReason, "budget_exhausted");
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function stream(message: AssistantMessage, onCall: () => void): StreamFn {
  return () => { onCall(); const events = createAssistantMessageEventStream(); queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(); }); return events; };
}

test("review limits persist across restart and changing a budget does not replenish it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-")), outputDirectory = join(dir, "review"); let calls = 0;
  const options = { plan, currentInput: () => input, outputDirectory, limits, model, streamFn: stream(response(resultText), () => calls++) };
  try {
    const first = await runOmissionReview(options); assert.equal(first.calls, 1); assert.equal(first.chargedTokens, 120); assert.equal(first.pending, 1);
    await runOmissionReview(options); assert.equal(calls, 1);
    await assert.rejects(runOmissionReview({ ...options, limits: { ...limits, maxCalls: 2 } }), /identity|budget/iu);
    assert.equal(readOmissionReviewStatus(outputDirectory).calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source or candidate drift is rejected before a provider call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-stale-")); let calls = 0;
  try {
    await assert.rejects(runOmissionReview({ plan, currentInput: () => ({ ...input, translations: input.translations.map(t => ({ ...t, text: "她点头了。门开了。" })) }), outputDirectory: join(dir, "review"), limits, model,
      streamFn: stream(response(resultText), () => calls++) }), /stale|changed/iu);
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown transport usage retains the reservation and stops instead of retrying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-network-")), outputDirectory = join(dir, "review"); let calls = 0;
  const options = { plan, currentInput: () => input, outputDirectory, limits: { ...limits, maxCalls: 2 }, model,
    streamFn: (() => { calls++; throw new Error("socket closed with private credential"); }) as StreamFn };
  try {
    const first = await runOmissionReview(options); assert.equal(first.unknownUsage, 1); assert.ok(first.chargedTokens > 1024);
    assert.equal(first.stoppedReason, "provider_error"); await runOmissionReview(options); assert.equal(calls, 1);
    assert.doesNotMatch(readFileSync(join(outputDirectory, "journal.jsonl"), "utf8"), /private credential/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a crash after dispatch is recovered as unknown and cannot silently repeat the call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-crash-")), outputDirectory = join(dir, "review"); let calls = 0;
  const options = { plan, currentInput: () => input, outputDirectory, limits, model, streamFn: stream(response(resultText), () => calls++) };
  try {
    await runOmissionReview(options);
    const journal = join(outputDirectory, "journal.jsonl"), rows = readFileSync(journal, "utf8").trim().split("\n");
    writeFileSync(journal, rows.slice(0, -1).join("\n") + "\n");
    const result = await runOmissionReview(options); assert.equal(result.unknownUsage, 1); assert.equal(result.stoppedReason, "interrupted"); assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid evidence consumes its actual usage but never becomes an accepted finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-evidence-"));
  try {
    const result = await runOmissionReview({ plan, currentInput: () => input, outputDirectory: join(dir, "review"), limits, model,
      streamFn: stream(response(resultText.replace("She nodded.", "She sang.")), () => {}) });
    assert.equal(result.chargedTokens, 120); assert.equal(result.stoppedReason, "invalid_response"); assert.equal(result.findings.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
