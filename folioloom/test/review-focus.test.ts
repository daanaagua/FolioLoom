import assert from "node:assert/strict";
import test from "node:test";
import { reviewFocus } from "../src/fullbook/review-focus.js";
import { paragraphEvidenceReferences } from "../src/domain/evidence-reference.js";
import { supervisorPrompt, type SupervisorInput } from "../src/agents/supervisor.js";
import { fauxProvider } from "@earendil-works/pi-ai";

test("changed term dependencies include differently cased source occurrences", () => {
  const sources = [{ blockId: "b", globalIndex: 0, sourceText: "He waited.\n\nSecond.\n\nThird.\n\nFourth.\n\nFifth.\n\nLast." }];
  const before = [{ blockId: "b", text: "他等着。\n\n二。\n\n三。\n\n四。\n\n五。\n\n六。" }];
  const candidate = [{ blockId: "b", text: before[0]!.text.replace("五", "伍") }];
  const focus = reviewFocus(sources, candidate, before, [{ sourceForm: "he", target: "旅人" }], [{ sourceForm: "he", target: "他" }], []);
  assert.ok(focus?.sourceIds.includes(paragraphEvidenceReferences("source", "b", sources[0]!.sourceText)[0]!.id));
});

test("delta review cannot guess between repeated issue quotes or drop an unlocated issue", () => {
  const text = "Repeated line.\n\nSecond.\n\nThird.\n\nFourth.\n\nRepeated line.\n\nLast.";
  const source = [{ blockId: "b", globalIndex: 0, sourceText: text }];
  const before = [{ blockId: "b", text: "一。\n\n二。\n\n三。\n\n四。\n\n五。\n\n六。" }];
  const candidate = [{ blockId: "b", text: before[0]!.text.replace("三", "叁") }];
  assert.equal(reviewFocus(source, candidate, before, [], [], [], [{ blockId: "b", sourceQuote: "Repeated line." }]), undefined);
  assert.equal(reviewFocus(source, candidate, before, [], [], [], [{ blockId: "b", sourceQuote: "Second." },
    { blockId: "b", sourceQuote: "Unknown quotation." }]), undefined);
  const refs = paragraphEvidenceReferences("source", "b", text);
  const focus = reviewFocus(source, candidate, before, [], [], [], [{ blockId: "b", sourceQuote: "Repeated line.", sourceRef: refs[4]!.id }]);
  assert.ok(focus?.sourceIds.includes(refs[4]!.id));
  assert.ok(!focus?.sourceIds.includes(refs[0]!.id));
});

test("delta review presents complete paired paragraphs rather than asymmetric reference tails", () => {
  const source = Array.from({ length: 8 }, (_, i) => `Speaker ${i} paused. This is the complete statement of speaker ${i}, including its final answer.`);
  const old = Array.from({ length: 8 }, (_, i) => `说话人${i}停了一下。“这是说话人${i}的完整回答，没有遗漏最后一句。”`);
  const target = old.map((text, i) => i === 3 ? text.replace("停了一下", "稍作停顿") : text);
  const sources = [{ blockId: "b", globalIndex: 0, sourceText: source.join("\n\n") }];
  const candidate = [{ blockId: "b", text: target.join("\n\n") }];
  const focus = reviewFocus(sources, candidate, [{ blockId: "b", text: old.join("\n\n") }], [], [], []);
  assert.ok(focus);
  const faux = fauxProvider();
  const input: SupervisorInput = { event: "review", windows: [{ windowId: "w", ordinal: 0, blockIds: ["b"] }],
    sources, candidate, reviewFocus: focus, terms: [], model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) };
  const data = JSON.parse(supervisorPrompt(input));
  const sourceIndices = data.source[0].evidence.map((r: {text:string}) => source.indexOf(r.text));
  const targetIndices = data.candidate[0].evidence.map((r: {text:string}) => target.indexOf(r.text));
  assert.ok(sourceIndices.every((i:number) => i >= 0), "every visible source reference is a complete paragraph");
  assert.ok(targetIndices.every((i:number) => i >= 0), "every visible target reference is a complete paragraph");
  assert.deepEqual(sourceIndices, [2, 3, 4]);
  assert.deepEqual(targetIndices, sourceIndices, "both languages expose exactly the same paragraph positions");
});

test("full review never silently drops the source tail while showing the complete candidate", () => {
  const faux = fauxProvider();
  const source = "A complete paragraph. ".repeat(330) + "The final answer is present.";
  const input: SupervisorInput = { event: "review", windows: [{ windowId: "w", ordinal: 0, blockIds: ["b"] }],
    sources: [{ blockId: "b", globalIndex: 0, sourceText: source }], candidate: [{ blockId: "b", text: "完整译文。" }],
    terms: [], model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) };
  const data = JSON.parse(supervisorPrompt(input));
  assert.ok(data.source[0].evidence.map((r:{text:string})=>r.text).join("").includes("The final answer is present."));
});

test("delta review shares semantic paragraph coordinates with fragment execution", () => {
  const sourceText = "First paragraph.\r\n\r\nSecond paragraph.\r\n\r\n";
  const candidate = [{ blockId: "b", text: "第一段。\n\n修正第二段。" }];
  const before = [{ blockId: "b", text: "第一段。\n\n第二段。\n\n" }];
  assert.ok(reviewFocus([{ blockId: "b", globalIndex: 0, sourceText }], candidate, before, [], [], []));
  assert.equal(reviewFocus([{ blockId: "b", globalIndex: 0, sourceText }],
    [{ blockId: "b", text: "两个段落被合并了。" }], before, [], [], []), undefined);
});

test("delta review selects changed paragraph and neighbors, not unrelated prose", () => {
  const sourceText = Array.from({ length: 9 }, (_, i) => `Paragraph ${i}. ${"A quiet day. ".repeat(35)}`).join("\n\n");
  const before = Array.from({ length: 9 }, (_, i) => `第${i}段。${"平静的一天。".repeat(60)}`).join("\n\n");
  const sources = [{ blockId: "b", globalIndex: 0, sourceText }];
  const candidate = [{ blockId: "b", text: before.replace("第4段", "第四段") }];
  const focus = reviewFocus(sources, candidate, [{ blockId: "b", text: before }], [], [], []);
  assert.ok(focus);
  assert.ok(focus.sourceIds.length < paragraphEvidenceReferences("source", "b", sourceText).length);
  assert.ok(!focus.sourceIds.includes(paragraphEvidenceReferences("source", "b", sourceText)[0]!.id));
  assert.equal(reviewFocus(sources, candidate, [{ blockId: "b", text: "结构改变" }], [], [], []), undefined);
  const open = reviewFocus(sources, candidate, [{ blockId: "b", text: before }], [], [], [], [{ blockId: "b", sourceQuote: "Paragraph 0." }]);
  assert.ok(open?.sourceIds.includes(paragraphEvidenceReferences("source", "b", sourceText)[0]!.id), "unchanged outstanding issues cannot disappear from a delta review");
});
