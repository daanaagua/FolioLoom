import assert from "node:assert/strict";
import test from "node:test";

import { simplifyChineseTranslation } from "../src/style/chinese-script-normalization.js";

test("simplified Chinese characters are not reinterpreted as Japanese shorthand", () => {
  const text = "予以答复，仍欠三元；赊欠与赐予应保持原样。";
  assert.equal(simplifyChineseTranslation(text), text);
  assert.equal(simplifyChineseTranslation(text, ["三元"]), text);
});

test("mixed-script normalization is idempotent without corrupting Chinese words", () => {
  const text = "賒欠與賜予，沢黒竜，谨愼地硏究。";
  const expected = "赊欠与赐予，泽黑龙，谨慎地研究。";
  assert.equal(simplifyChineseTranslation(text), expected);
  assert.equal(simplifyChineseTranslation(expected), expected);
});

test("traditional Chinese prose is normalized to simplified Chinese", () => {
  assert.equal(
    simplifyChineseTranslation("黑殺隊的訓練結束了，後來……"),
    "黑杀队的训练结束了，后来……",
  );
});

test("generic Chinese orthography normalizes cross-locale variant glyphs", () => {
  assert.equal(
    simplifyChineseTranslation("谨愼地硏究，双腿轻轻晄动"),
    "谨慎地研究，双腿轻轻晃动",
  );
});

test("locked variant orthography remains byte-identical", () => {
  assert.equal(
    simplifyChineseTranslation("谨愼地硏究，双腿轻轻晄动", ["硏究"]),
    "谨慎地硏究，双腿轻轻晃动",
  );
});

test("locked target forms survive script normalization verbatim", () => {
  assert.equal(
    simplifyChineseTranslation("龍與後來的龍同行。", ["龍"]),
    "龍与后来的龍同行。",
  );
});

test("Japanese-compatible Hanja is fully normalized through traditional Chinese", () => {
  assert.equal(
    simplifyChineseTranslation("\u885B\u58EB\u8207\u8987\u4E3B\uFF0C\u98DC\u8EAB\u4EE5\u5F8C\u654E\u5C0E\u69EA\u8981\uFF0C\u6CA2\u9ED2\u7ADC"),
    "\u536B\u58EB\u4E0E\u9738\u4E3B\uFF0C\u7FFB\u8EAB\u4EE5\u540E\u6559\u5BFC\u6982\u8981\uFF0C\u6CFD\u9ED1\u9F99",
  );
});
