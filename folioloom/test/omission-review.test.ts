import assert from "node:assert/strict";
import test from "node:test";
import { buildOmissionReviewPlan, parseOmissionReview, validateOmissionReviewPlan } from "../src/fullbook/omission-review.js";

const translation = (sourceText: string, text: string, blockId = "b") => ({ blockId, globalIndex: 0, chapterId: null, chapterTitle: null, sourceText, text });
const input = (translations: ReturnType<typeof translation>[]) => ({ runId: "run", sourceVersion: "source", sourceLanguage: "en", translations });

test("review scans structural failures separately and never labels heuristics as proven omissions", () => {
  const plan = buildOmissionReviewPlan(input([translation("The lamp went out.\n\nShe left.", "灯熄了。")]), { maxCandidates: 4, sampleCount: 1, seed: "fixed" });
  assert.equal(plan.scan.structuralIssues.length, 1);
  assert.equal(plan.candidates.length, 0);
  const suspicion = buildOmissionReviewPlan(input([translation("She carried 12 keys and 4 seals.", "她带着钥匙。")]), { maxCandidates: 4, sampleCount: 0, seed: "fixed" });
  assert.ok(suspicion.candidates[0]?.reasons.includes("number_difference"));
  assert.equal(suspicion.candidates[0]?.selection, "risk");
  validateOmissionReviewPlan(suspicion);
});

test("legitimate paraphrases remain reviewable without rejecting the translation", () => {
  const plan = buildOmissionReviewPlan(input([translation("No one was left behind.", "所有人都跟上了。")]), { maxCandidates: 2, sampleCount: 1, seed: "fixed" });
  assert.deepEqual(plan.scan.structuralIssues, []);
  const candidate = plan.candidates[0]!;
  assert.ok(candidate);
  const result = parseOmissionReview(JSON.stringify({ verdict: "adequate", sourceQuote: "No one was left behind.", targetQuote: "所有人都跟上了。", note: "The positive formulation preserves the meaning." }), candidate);
  assert.equal(result.verdict, "adequate");
});

test("unflagged deterministic samples can surface an omitted action without a length alarm", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...translation("She nodded. The door was open.", "门开着。", `b${i}`), globalIndex: i }));
  const options = { maxCandidates: 3, sampleCount: 2, seed: "audit-v1" };
  const a = buildOmissionReviewPlan(input(rows), options), b = buildOmissionReviewPlan(input(rows), options);
  assert.deepEqual(a, b); assert.equal(a.candidates.filter(c => c.selection === "sample").length, 2);
  const candidate = a.candidates[0]!;
  const issue = parseOmissionReview(JSON.stringify({ verdict: "possible_omission", sourceQuote: "She nodded.", targetQuote: "门开着。", note: "The nodding action is absent." }), candidate);
  assert.equal(issue.verdict, "possible_omission");
  assert.throws(() => parseOmissionReview(JSON.stringify({ ...issue, sourceQuote: "She smiled." }), candidate), /evidence/iu);
  assert.throws(() => parseOmissionReview(JSON.stringify({ ...issue, targetQuote: "不存在的译文" }), candidate), /evidence/iu);
});

test("plan identity binds source, translated candidate and sampling policy", () => {
  const a = buildOmissionReviewPlan(input([translation("She waited.", "她等着。")]), { maxCandidates: 2, sampleCount: 1, seed: "fixed" });
  const b = buildOmissionReviewPlan(input([translation("She waited.", "她耐心地等着。")]), a.options);
  assert.notEqual(a.fingerprint, b.fingerprint); assert.notEqual(a.planHash, b.planHash);
  assert.throws(() => validateOmissionReviewPlan({ ...a, candidates: [{ ...a.candidates[0]!, target: "Changed" }] }), /plan/iu);
  assert.throws(() => buildOmissionReviewPlan(input([]), { maxCandidates: 1, sampleCount: 2, seed: "fixed" }), /sample/iu);
});
