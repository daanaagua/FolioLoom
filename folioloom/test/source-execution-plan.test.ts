import assert from "node:assert/strict";
import test from "node:test";
import { planSourceExecution, sourceFrontier } from "../src/fullbook/source-execution-plan.js";

const blocks = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, sourceText: `A quiet road continued past the garden ${i}.` }));
const windows = blocks.map((b, ordinal) => ({ windowId: `w${ordinal}`, ordinal, chapterId: ordinal < 6 ? "a" : "b", blockIds: [b.id], sourceTokens: 400 }));

test("source planning fixes bounded frontiers before outputs and independently of execution concurrency", () => {
  const plan = planSourceExecution("source", windows, blocks);
  assert.deepEqual(plan.frontiers.map(f => f.windowIds), [["w0", "w1", "w2", "w3"], ["w4", "w5"], ["w6", "w7", "w8"]]);
  assert.deepEqual(sourceFrontier(plan, "w2"), ["w2", "w3"]);
  const unstructured = planSourceExecution("source", windows.map(w => ({ ...w, chapterId: `chapter-at-${w.ordinal}` })), blocks);
  assert.equal(unstructured.frontiers[0]!.windowIds.length, 4, "synthetic window chapter IDs are not source boundaries");
  const chapters = planSourceExecution("source", windows, blocks, [{ windowIds: ["w0", "w1", "w2"] },
    { windowIds: ["w3", "w4", "w5", "w6", "w7", "w8"] }]);
  assert.deepEqual(chapters.frontiers.map(f => f.windowIds.length), [3, 4, 2], "canonical source chapter scopes override storage fallback labels");
  assert.ok(plan.windows.every(w => w.reviewBlockIds.length === 0));
  assert.deepEqual(plan, planSourceExecution("source", windows, [...blocks].reverse()));
  assert.notEqual(plan.id, planSourceExecution("source", windows, blocks.map(b => ({ ...b, sourceText: b.sourceText + " Changed." }))).id);
});

test("source boundary risks request local review without changing complete chapter coverage policy", () => {
  const plan = planSourceExecution("source", windows, blocks.map((b, i) => i === 1 ? { ...b, sourceText: "He turned toward the" } : b));
  assert.deepEqual(plan.windows[1]!.reviewBlockIds, ["b1"]);
  assert.equal(plan.policy.semanticReview, "complete-chapter-with-boundary-checks");
  assert.throws(() => sourceFrontier(plan, "missing"), /outside source plan/u);
  assert.throws(() => planSourceExecution("source", windows, blocks.slice(1)), /missing source block/u);
  assert.throws(() => planSourceExecution("source", [...windows, windows[0]!], blocks), /window order/u);
});
