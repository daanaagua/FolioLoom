import assert from "node:assert/strict";
import test from "node:test";
import { assertDirectNamesCompatible, directParagraphs, parseDirectResponse } from "../src/fullbook/direct-translation.js";

test("naming comparison accepts only outer decoration and source-attested possessive grammar", () => {
  assert.doesNotThrow(() => assertDirectNamesCompatible([{ source: "Records", target: "《档案》" }], [{ source: "Records", target: "档案" }]));
  assert.doesNotThrow(() => assertDirectNamesCompatible([{ source: "Mira’s", target: "米拉的" }], [{ source: "Mira’s", target: "米拉" }]));
  assert.throws(() => assertDirectNamesCompatible([{ source: "Mira", target: "米拉的" }], [{ source: "Mira", target: "米拉" }]), /DIRECT_NAMING_CONFLICT/u);
  assert.throws(() => assertDirectNamesCompatible([{ source: "Records", target: "档案外传" }], [{ source: "Records", target: "档案" }]), /DIRECT_NAMING_CONFLICT/u);
});

test("typed naming admits attested entities and contextual terms, not ordinary or unsupported assertions", () => {
  const paragraphs = directParagraphs([{ id: "b1", globalIndex: 0, sourceText: "Mira carried a varnet through the lower hall." }] as never);
  const row = (source: string, target: string, kind: string, scope: string, quote = source) => ({ source, target, kind, scope, sense: "a fictional navigation device", evidence: { paragraphId: "p0_0", quote } });
  const result = parseDirectResponse(JSON.stringify({ paragraphs: [["p0_0", "米拉带着一件瓦内特穿过下层大厅。"]], names: [
    row("Mira", "米拉", "person", "book"), row("varnet", "瓦内特", "term", "context"),
    row("lower hall", "下层大厅", "ordinary", "book"), row("Mira", "米拉", "person", "book", "invented evidence"),
  ] }), paragraphs, [], "typed" as never);
  assert.equal(result.names.length, 2);
  assert.equal((result.names[0] as any).policy, "locked");
  assert.equal((result.names[1] as any).policy, "preferred");
  assert.doesNotThrow(() => assertDirectNamesCompatible([{ ...result.names[1]!, target: "导航器" }], result.names));
  assert.equal(result.paragraphs[0]![1], "米拉带着一件瓦内特穿过下层大厅。");
});
