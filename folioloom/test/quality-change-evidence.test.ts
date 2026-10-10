import assert from "node:assert/strict";
import test from "node:test";
import { assertQualityClosure, hasChangedIssueEvidence, type QualityClosure } from "../src/domain/quality-closure.js";

test("issue-local edit alignment distinguishes boundary insertions from unrelated edits", () => {
  const before = "开头很长。守卫能离开。结尾也很长。";
  assert.equal(hasChangedIssueEvidence("能离开", before.replace("能离开", "不能离开"), before), true);
  assert.equal(hasChangedIssueEvidence("能离开", "新开头。守卫能离开。新结尾。", before), false);
  assert.equal(hasChangedIssueEvidence("能离开", before, before), false);
  assert.equal(hasChangedIssueEvidence("能离开", before.replace("能离开", "不能离开")), false);
  assert.equal(hasChangedIssueEvidence("能离开", "能离开。不能离开。", "能离开。能离开。"), false);
  assert.equal(hasChangedIssueEvidence("", before, before), false);
});

test("grounded closure accepts semantic latitude while retaining legacy receipt and candidate checks", () => {
  const prior = [{ issueId: "name", blockId: "b", sourceQuote: "The short name.", targetQuote: "简称。", problem: "Check wording." }];
  const closure: QualityClosure = { policy: "issue-closure-2", candidateHash: "candidate", decisionId: "decision",
    dispositions: [{ issueId: "name", status: "variant", sourceRef: "s", targetRef: "t", sourceQuote: "The short name.", targetQuote: "简称。", note: "Appropriate in context." }] };
  assert.doesNotThrow(() => assertQualityClosure(prior, closure, "candidate"));
  assert.throws(() => assertQualityClosure(prior, { ...closure, policy: "issue-closure-1" }, "candidate"), /verification/u);
  assert.doesNotThrow(() => assertQualityClosure(prior, { ...closure, policy: "issue-closure-1", verificationDecisionId: "old-verification" }, "candidate"));
  assert.throws(() => assertQualityClosure(prior, closure, "different"), /candidate/u);
  assert.throws(() => assertQualityClosure(prior, { ...closure, dispositions: [{ ...closure.dispositions[0]!, targetRef: "" }] }, "candidate"), /grounded/u);
});
