import assert from "node:assert/strict";
import test from "node:test";
import { reviewFocus } from "../src/fullbook/review-focus.js";
import { evidenceReferences } from "../src/domain/evidence-reference.js";

test("delta review selects changed paragraph and neighbors, not unrelated prose", () => {
  const sourceText = Array.from({ length: 9 }, (_, i) => `Paragraph ${i}. ${"A quiet day. ".repeat(35)}`).join("\n\n");
  const before = Array.from({ length: 9 }, (_, i) => `第${i}段。${"平静的一天。".repeat(60)}`).join("\n\n");
  const sources = [{ blockId: "b", globalIndex: 0, sourceText }];
  const candidate = [{ blockId: "b", text: before.replace("第4段", "第四段") }];
  const focus = reviewFocus(sources, candidate, [{ blockId: "b", text: before }], [], [], []);
  assert.ok(focus);
  assert.ok(focus.sourceIds.length < evidenceReferences("source", "b", sourceText).length);
  assert.ok(!focus.sourceIds.includes(evidenceReferences("source", "b", sourceText)[0]!.id));
  assert.equal(reviewFocus(sources, candidate, [{ blockId: "b", text: "结构改变" }], [], [], []), undefined);
  const open = reviewFocus(sources, candidate, [{ blockId: "b", text: before }], [], [], [], [{ blockId: "b", sourceQuote: "Paragraph 0." }]);
  assert.ok(open?.sourceIds.includes(evidenceReferences("source", "b", sourceText)[0]!.id), "unchanged outstanding issues cannot disappear from a delta review");
});
