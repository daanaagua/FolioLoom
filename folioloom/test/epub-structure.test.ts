import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeEpubXhtml,
  rewriteEpubXhtml,
  type EpubXhtmlBlock,
} from "../src/source/epub-structure.js";

function translatedBlock(
  block: EpubXhtmlBlock,
  translations: readonly string[],
): string {
  assert.equal(block.slots.length, translations.length);
  return block.slots.map((slot, index) =>
    `${slot.openMarker}${translations[index] ?? ""}${slot.closeMarker}`).join("");
}

const XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Fixture</title></head>
<body>
  <section epub:type="chapter">
    <p id="return-1">Read <a epub:type="noteref" href="notes.xhtml#fn-1">this note</a>.</p>
    <p>Visit <a href="https://example.com/a?x=1&amp;y=2">the example</a>.</p>
  </section>
</body>
</html>`;

test("EPUB XHTML structural slots translate link labels without changing link attributes", () => {
  const analysis = analyzeEpubXhtml(XHTML, 0);
  assert.equal(analysis.blocks.length, 2);
  assert.match(analysis.canonicalText, /this note/u);

  const rewritten = rewriteEpubXhtml(XHTML, analysis, [
    translatedBlock(analysis.blocks[0]!, ["阅读 ", "这条注释", "。"]),
    translatedBlock(analysis.blocks[1]!, ["访问 ", "示例网站", "。"]),
  ]);

  assert.match(
    rewritten,
    /<p id="return-1">阅读 <a epub:type="noteref" href="notes\.xhtml#fn-1">这条注释<\/a>。<\/p>/u,
  );
  assert.match(
    rewritten,
    /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2">示例网站<\/a>/u,
  );
});

test("EPUB XHTML structural rewrite fails closed when a slot marker is missing", () => {
  const analysis = analyzeEpubXhtml(XHTML, 0);
  const valid = translatedBlock(analysis.blocks[0]!, ["阅读 ", "这条注释", "。"]);
  assert.throws(
    () => rewriteEpubXhtml(XHTML, analysis, [
      valid.replace(analysis.blocks[0]!.slots[1]!.openMarker, ""),
      translatedBlock(analysis.blocks[1]!, ["访问 ", "示例网站", "。"]),
    ]),
    /EPUB_STRUCTURAL_SLOT_MISMATCH/u,
  );
});
