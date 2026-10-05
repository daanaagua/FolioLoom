import assert from "node:assert/strict";
import test from "node:test";
import { hasChangedIssueEvidence } from "../src/domain/quality-closure.js";

test("issue-local edit alignment distinguishes boundary insertions from unrelated edits", () => {
  const before = "开头很长。守卫能离开。结尾也很长。";
  assert.equal(hasChangedIssueEvidence("能离开", before.replace("能离开", "不能离开"), before), true);
  assert.equal(hasChangedIssueEvidence("能离开", "新开头。守卫能离开。新结尾。", before), false);
  assert.equal(hasChangedIssueEvidence("能离开", before, before), false);
  assert.equal(hasChangedIssueEvidence("能离开", before.replace("能离开", "不能离开")), false);
  assert.equal(hasChangedIssueEvidence("能离开", "能离开。不能离开。", "能离开。能离开。"), false);
  assert.equal(hasChangedIssueEvidence("", before, before), false);
});
