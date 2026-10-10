import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectPrompt, parseDirectResponse, directParagraphs, relevantDirectNames, type DirectNameCandidate } from "../src/fullbook/direct-translation.js";

const paragraphs = directParagraphs([{ id: "b1", globalIndex: 0, sourceText: "Mira waited.\n\nShe left." }] as never);
const candidates: DirectNameCandidate[] = [{ id: "n0", source: "Mira", examples: ["Mira waited."], occurrences: 2 }];

test("direct response has exact paragraph coverage and a bounded optional naming convention", () => {
  const result = parseDirectResponse(JSON.stringify({ paragraphs: [["p0_0", "米拉等候着。"], ["p0_1", "她离开了。"]], names: [["n0", "米拉"]] }), paragraphs, candidates);
  assert.deepEqual(result.translations, [{ blockId: "b1", text: "米拉等候着。\n\n她离开了。" }]);
  assert.deepEqual(result.names, [{ source: "Mira", target: "米拉" }]);
});

test("missing, duplicate, reordered, empty or invented paragraph rows cannot pass as a complete translation", () => {
  for (const rows of [[], [["p0_0", "米拉。"]], [["p0_0", "米拉。"], ["p0_0", "她。"]],
    [["p0_1", "她。"], ["p0_0", "米拉。"]], [["p0_0", ""], ["p0_1", "她。"]], [["p0_0", "米拉。"], ["outside", "她。"]]])
    assert.throws(() => parseDirectResponse(JSON.stringify({ paragraphs: rows }), paragraphs, candidates), /DIRECT_OUTPUT/u);
});

test("bad optional names are discarded without discarding valid translated text or scheduling analysis", () => {
  const result = parseDirectResponse(JSON.stringify({ paragraphs: [["p0_0", "米拉等候着。"], ["p0_1", "她离开了。"]],
    names: [["invented", "虚构"], ["n0", ""], ["n0", "x".repeat(160)]] }), paragraphs, candidates);
  assert.equal(result.translations.length, 1);
  assert.deepEqual(result.names, []);
});

test("EPUB slot changes are structural errors, not semantic review work", () => {
  const source = directParagraphs([{ id: "b1", globalIndex: 0, sourceText: "⟦E0.0.0⟧Mira⟦/E0.0.0⟧" }] as never);
  assert.throws(() => parseDirectResponse(JSON.stringify({ paragraphs: [["p0_0", "米拉"]] }), source, []), /DIRECT_OUTPUT/u);
});

test("direct prompt asks for translation and optional short names, without model planning or review", () => {
  const payload = JSON.parse(buildDirectPrompt({ paragraphs, candidates, names: [], neighbors: ["Before."], seed: true }));
  assert.equal(payload.paragraphs.length, 2);
  assert.equal(payload.namingCandidates[0].source, "Mira");
  assert.deepEqual(payload.readOnlyContext, ["Before."]);
  assert.equal(payload.task, "translate");
  assert.equal(payload.review, undefined);
  const scoped = JSON.parse(buildDirectPrompt({ paragraphs, candidates: [], neighbors: [], seed: false,
    names: [{ source: "Mira", target: "另一个名字", applicableBlockIds: ["outside"] }] }));
  assert.deepEqual(scoped.sharedNames, []);
});

test("learned names require literal source and aligned target evidence, not neighbors or substrings", () => {
  const result = parseDirectResponse(JSON.stringify({ paragraphs: [["p0_0", "米拉等候着。"], ["p0_1", "她离开了亚拉。"]],
    names: [["Mira", "米拉"], ["Mir", "米拉"], ["Mira", "亚拉"], ["Yara", "亚拉"]] }), paragraphs, [], true);
  assert.deepEqual(result.names, [{ source: "Mira", target: "米拉" }]);
  const scoped = relevantDirectNames([{ source: "Mira", target: "米拉" }, { source: "Yara", target: "亚拉" },
    { source: "Mira", target: "别名", applicableBlockIds: ["elsewhere"] }], paragraphs);
  assert.deepEqual(scoped, [{ source: "Mira", target: "米拉" }]);
});

test("one response cannot declare contradictory renderings for the same exact source form", () => {
  assert.throws(() => parseDirectResponse(JSON.stringify({ paragraphs: [["p0_0", "米拉又称蜜拉。"], ["p0_1", "她离开了。"]],
    names: [["Mira", "米拉"], ["Mira", "蜜拉"]] }), paragraphs, [], true), /DIRECT_NAMING_CONFLICT/u);
});
