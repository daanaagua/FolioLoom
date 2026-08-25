import assert from "node:assert/strict";
import test from "node:test";

import {
  getSourceLanguageProfile,
  supportedSourceLanguageIds,
} from "../src/language/profiles.js";
import { detectLanguage } from "../src/source/language-detector.js";
import { annotateStructure } from "../src/source/structure-annotator.js";

test("language profile registry resolves supported ids deterministically", () => {
  assert.deepEqual(supportedSourceLanguageIds(), [
    "de", "en", "es", "fr", "ja", "ko", "ru", "und",
  ]);
  assert.equal(getSourceLanguageProfile("en-US").id, "en");
  assert.equal(getSourceLanguageProfile("fr").id, "fr");
  assert.equal(getSourceLanguageProfile("ko-KR").id, "ko");
  assert.equal(getSourceLanguageProfile("unknown").id, "und");
  assert.equal(getSourceLanguageProfile("EN"), getSourceLanguageProfile("en"));
});

test("English alias cues reject an ordinary transitive call", () => {
  const english = getSourceLanguageProfile("en");

  assert.equal(english.hasExplicitEntityNamingCue("John called Peter."), false);
  assert.equal(
    english.hasExplicitEntityNamingCue(
      "Loukianos, whom they called Lucian the Scoffer, laughed.",
    ),
    true,
  );
});

test("Korean is detected independently of undetermined text", () => {
  const source = "\ud55c\uad6d\uc5b4 \ubb38\uc7a5\uc785\ub2c8\ub2e4. \uc774\uac83\uc740 \uc790\uc5f0\uc2a4\ub7ec\uc6b4 \ud14c\uc2a4\ud2b8\uc785\ub2c8\ub2e4. ".repeat(8);
  const detected = detectLanguage(source);

  assert.equal(detected?.id, "ko");
  assert.ok((detected?.confidence ?? 0) >= 0.8);
});

test("German, French and Spanish survive short English publishing front matter", () => {
  const frontMatter = [
    "Copyright notice. All rights reserved.",
    "This ebook may not be redistributed without permission.",
  ].join("\n");
  const fixtures = [
    ["de", "Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt. Er lag auf seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, seinen gewölbten Bauch."],
    ["fr", "Lorsque Gregor Samsa s’éveilla un matin au sortir de rêves agités, il se retrouva dans son lit changé en un énorme insecte. Il était couché sur son dos dur, et il voyait son ventre bombé."],
    ["es", "Al despertar Gregorio Samsa una mañana, tras un sueño intranquilo, se encontró en su cama convertido en un monstruoso insecto. Estaba echado sobre el duro caparazón de su espalda y veía su vientre abombado."],
  ] as const;
  for (const [language, prose] of fixtures) {
    const detected = detectLanguage(`${frontMatter}\n\n${prose.repeat(8)}`);
    assert.equal(detected?.id, language);
    assert.ok((detected?.confidence ?? 0) >= 0.7);
  }
  assert.equal(detectLanguage("Copyright notice. All rights reserved."), undefined);
});

test("German French and Spanish profiles recognize common chapter conventions", () => {
  const german = getSourceLanguageProfile("de");
  const french = getSourceLanguageProfile("fr");
  const spanish = getSourceLanguageProfile("es");
  for (const heading of ["KAPITEL 1", "1. Kapitel", "Erstes Kapitel", "I."]) {
    assert.equal(german.detectStructureHeading(heading)?.kind, "chapter_heading", heading);
  }
  for (const heading of ["CHAPITRE I", "PREMIER CHAPITRE", "I."]) {
    assert.equal(french.detectStructureHeading(heading)?.kind, "chapter_heading", heading);
  }
  for (const heading of ["CAPÍTULO I", "CAPITULO 1", "PRIMER CAPÍTULO", "I."]) {
    assert.equal(spanish.detectStructureHeading(heading)?.kind, "chapter_heading", heading);
  }
});

test("standalone Latin chapter numerals require blank-line layout evidence", () => {
  const german = getSourceLanguageProfile("de");
  const inline = annotateStructure(
    "Vorbemerkung.\nI.\nAls Gregor Samsa erwachte.",
    "source-de-inline",
    german,
  );
  const isolated = annotateStructure(
    "Vorbemerkung.\n\nI.\n\nAls Gregor Samsa erwachte.",
    "source-de-isolated",
    german,
  );
  assert.equal(inline.length, 0);
  assert.deepEqual(isolated.map((annotation) => annotation.title), ["I."]);
});

test("Japanese and Korean profiles expose headings, sentence boundaries, and bounded candidates", () => {
  const japanese = getSourceLanguageProfile("ja");
  const korean = getSourceLanguageProfile("ko");
  const japaneseVolume = "\u7532\u6e90\u4e00\u5200\u6d41\u306e\u5dfb";
  const japaneseChapter = "\u7b2c\u5341\u4e8c\u7ae0";
  const koreanChapter = "\uc81c2\uc7a5";
  const koreanVolume = "\uc81c1\uad8c";

  assert.equal(japanese.detectStructureHeading(japaneseVolume)?.kind, "volume_heading");
  assert.equal(japanese.detectStructureHeading(japaneseChapter)?.kind, "chapter_heading");
  assert.equal(japanese.detectStructureHeading("一")?.kind, "chapter_heading");
  assert.equal(japanese.detectStructureHeading("二十三")?.kind, "chapter_heading");
  assert.equal(korean.detectStructureHeading(koreanChapter)?.kind, "chapter_heading");
  assert.equal(korean.detectStructureHeading(koreanVolume)?.kind, "volume_heading");
  assert.equal(korean.detectStructureHeading("제12화")?.kind, "chapter_heading");
  assert.equal(korean.detectStructureHeading("12회")?.kind, "chapter_heading");
  assert.equal(korean.detectStructureHeading("■ 운명의 시작 □")?.kind, "chapter_heading");
  assert.deepEqual(
    annotateStructure(`${japaneseChapter}\n${japaneseVolume}`, "source-ja", japanese)
      .map((annotation) => annotation.kind),
    ["chapter_heading", "volume_heading"],
  );

  const japaneseText = "\u5f7c\u306f\u7b11\u3063\u305f\u3002\u305d\u3057\u3066\u53bb\u3063\u305f\u3002";
  const japaneseFirstEnd = [...japaneseText.slice(0, japaneseText.indexOf("\u3002") + 1)].length;
  const koreanText = "\uccab \ubb38\uc7a5\uc774\ub2e4. \ub2e4\uc74c \ubb38\uc7a5\uc774\ub2e4.";
  const koreanFirstEnd = [...koreanText.slice(0, koreanText.indexOf(".") + 1)].length;
  assert.ok(japanese.collectBoundaryCandidates(japaneseText)
    .some((candidate) => candidate.kind === "sentence" && candidate.scalarOffset === japaneseFirstEnd));
  assert.ok(korean.collectBoundaryCandidates(koreanText)
    .some((candidate) => candidate.kind === "sentence" && candidate.scalarOffset === koreanFirstEnd));

  const japaneseCandidates = japanese.collectAnchorCandidates({
    targetTexts: ["\u30a2\u30ab\u30cd\u306f\u971c\u5cf6\u57ce\u3078\u5411\u304b\u3063\u305f\u3002\u30a2\u30ab\u30cd\u306f\u57ce\u4e3b\u3068\u8a71\u3057\u305f\u3002"],
    corpusTexts: ["\u30a2\u30ab\u30cd\u306f\u971c\u5cf6\u57ce\u3078\u5411\u304b\u3063\u305f\u3002\u30a2\u30ab\u30cd\u306f\u57ce\u4e3b\u3068\u8a71\u3057\u305f\u3002"],
  });
  const koreanCandidates = korean.collectAnchorCandidates({
    targetTexts: ["\ub77c\uc628 \uc7a5\uad70\uc740 \uc131\uc73c\ub85c \ud5a5\ud588\ub2e4. \ub77c\uc628 \uc7a5\uad70\uc740 \uc131\uc8fc\ub97c \ub9cc\ub0ac\ub2e4."],
    corpusTexts: ["\ub77c\uc628 \uc7a5\uad70\uc740 \uc131\uc73c\ub85c \ud5a5\ud588\ub2e4. \ub77c\uc628 \uc7a5\uad70\uc740 \uc131\uc8fc\ub97c \ub9cc\ub0ac\ub2e4."],
  });
  assert.ok(japaneseCandidates.some((candidate) => candidate.sourceForm === "\u30a2\u30ab\u30cd"));
  assert.ok(koreanCandidates.some((candidate) => candidate.sourceForm === "\ub77c\uc628"));
  assert.ok(japaneseCandidates.length <= 24);
  assert.ok(koreanCandidates.length <= 24);
});

test("structure annotation requires layout evidence for ambiguous Japanese numeral headings", () => {
  const japanese = getSourceLanguageProfile("ja");
  const inline = annotateStructure(
    ["彼は一とだけ答えた。", "一", "それから歩き去った。"].join("\n"),
    "source-ja-inline-number",
    japanese,
  );
  const isolated = annotateStructure(
    ["前の節。", "", "　一", "", "次の節。"].join("\n"),
    "source-ja-isolated-number",
    japanese,
  );

  assert.equal(inline.length, 0);
  assert.deepEqual(isolated.map((annotation) => annotation.title), ["一"]);
});

test("Korean boundary collection does not repeatedly rescan UTF-16 prefixes", () => {
  const source = new String("\uac00\n\n".repeat(512));
  let sliceCalls = 0;
  Object.defineProperty(source, "slice", {
    value(start?: number, end?: number): string {
      sliceCalls += 1;
      return String.prototype.slice.call(source, start, end);
    },
  });

  const candidates = getSourceLanguageProfile("ko")
    .collectBoundaryCandidates(source as unknown as string);

  assert.ok(candidates.filter((candidate) => candidate.kind === "paragraph").length >= 512);
  assert.equal(sliceCalls, 0);
});

test("Kana and Hangul prose residue is detected without treating Han alone as Japanese", () => {
  const japanese = getSourceLanguageProfile("ja");
  const korean = getSourceLanguageProfile("ko");

  assert.ok(japanese.detectSourceResidue("\u4e2d\u6587 \u30ab\u30ca\u30c8\u30b9\u30c8 \u304c\u6b8b\u3063\u305f")
    .some((finding) => finding.script === "kana"));
  assert.ok(korean.detectSourceResidue("\u4e2d\u6587 \ub77c\uc628\uc774 \ud55c\uad6d\uc5b4\ub85c \ub0a8\uc558\ub2e4")
    .some((finding) => finding.script === "hangul"));
  assert.deepEqual(japanese.detectSourceResidue("\u7eaf\u4e2d\u6587\u6c49\u5b57"), []);
});

test("Japanese residue detects kana split by kanji while honoring an explicit preserved form", () => {
  const japanese = getSourceLanguageProfile("ja");
  const translation = "他绕到背后，猛地使出一记拜み讨ち。";

  assert.ok(japanese.detectSourceResidue(translation)
    .some((finding) => finding.form.includes("み") && finding.form.includes("ち")));
  assert.deepEqual(japanese.detectSourceResidue(translation, {
    preservedSourceForms: ["拜み讨ち"],
  }), []);
});

test("CJK candidate projection remains capped at twenty-four even when callers request more", () => {
  const korean = getSourceLanguageProfile("ko");
  const names = Array.from({ length: 30 }, (_, index) => (
    `${String.fromCodePoint(0xac00 + index)}\uc628`
  )).flatMap((name) => [`${name}은`, `${name}을`]).join(" ");
  const candidates = korean.collectAnchorCandidates({
    targetTexts: [names],
    corpusTexts: [names],
    limit: 100,
  });

  assert.equal(candidates.length, 24);
});

test("Korean anchor candidates merge case particles and exclude predicate forms", () => {
  const korean = getSourceLanguageProfile("ko");
  const text = [
    "묵향은 마교의 본산에 들어갔다.",
    "묵향의 검은 묵향을 지켰고 마교를 뒤흔들었다.",
    "있다 되어 때문이다 버렸다 불리는 보는 많은 모든 없이.",
  ].join(" ");
  const candidates = korean.collectAnchorCandidates({
    targetTexts: [text],
    corpusTexts: [text],
  });
  const forms = candidates.map((candidate) => candidate.sourceForm);

  assert.ok(forms.includes("묵향"));
  assert.ok(forms.includes("마교"));
  assert.equal(forms.some((form) => ["묵향은", "묵향의", "묵향을", "마교의", "마교를"].includes(form)), false);
  assert.equal(forms.some((form) => [
    "있다", "되어", "때문이다", "버렸다", "불리는", "불리", "보는", "많은", "모든", "없이",
  ].includes(form)), false);
  assert.equal(candidates.find((candidate) => candidate.sourceForm === "묵향")?.currentWaveOccurrences, 3);
});

test("Korean candidate termhood keeps direct Han glosses but drops repeated bare predicates", () => {
  const korean = getSourceLanguageProfile("ko");
  const text = "극마(極魔)는 경지다. 극마(極魔)를 논했다. 보이지 않는 벽은 아직 보이지 않았다.";
  const forms = korean.collectAnchorCandidates({
    targetTexts: [text],
    corpusTexts: [text],
  }).map((candidate) => candidate.sourceForm);

  assert.ok(forms.includes("극마"));
  assert.equal(forms.includes("보이지"), false);
});

test("language profiles classify their own structure headings", () => {
  const english = getSourceLanguageProfile("en");
  const french = getSourceLanguageProfile("fr");

  assert.deepEqual(english.detectStructureHeading("BOOK THREE"), {
    kind: "volume_heading",
    title: "BOOK THREE",
    boundaryWeight: 100,
  });
  assert.equal(english.detectStructureHeading("CHAPTER XI")?.kind, "chapter_heading");
  assert.equal(french.detectStructureHeading("CHAPITRE PREMIER")?.kind, "chapter_heading");
  assert.equal(french.detectStructureHeading("LIVRE DEUXIÈME")?.kind, "volume_heading");
  assert.equal(english.detectStructureHeading("CHAPITRE PREMIER"), null);
});

test("segmentation and normalization are Unicode and language aware", () => {
  const english = getSourceLanguageProfile("en");
  const french = getSourceLanguageProfile("fr");

  assert.equal(english.normalizeSourceForm(" Lucian’s "), "lucian");
  assert.equal(french.normalizeSourceForm("L’ARCHONTE"), "archonte");
  assert.deepEqual(
    french.segment("L’archonte répond.")
      .filter((token) => token.isWordLike)
      .map((token) => token.value),
    ["L’archonte", "répond"],
  );
});

test("current-wave proper names remain candidates even at corpus frequency one", () => {
  const english = getSourceLanguageProfile("en");
  const input = {
    targetTexts: [
      "Loukianos of Samosata looked toward the door. Lucian the Scoffer laughed.",
    ],
    corpusTexts: [
      "Loukianos of Samosata looked toward the door. Lucian the Scoffer laughed.",
      "Another chapter mentions Typhon twice. Typhon waited.",
    ],
    establishedSourceForms: ["Typhon"],
    limit: 24,
  };

  const first = english.collectAnchorCandidates(input);
  const second = english.collectAnchorCandidates(input);
  assert.deepEqual(second, first);
  assert.ok(first.some((candidate) => candidate.sourceForm === "Loukianos"));
  assert.ok(first.some((candidate) => candidate.sourceForm === "Lucian"));
  assert.ok(!first.some((candidate) => candidate.sourceForm === "Typhon"));
  assert.ok(first.every((candidate) => candidate.contexts.length > 0));
});

test("candidate collection is deterministically capped", () => {
  const english = getSourceLanguageProfile("en");
  const names = Array.from({ length: 40 }, (_, index) => `Name${index}x`).join(" met ");
  const candidates = english.collectAnchorCandidates({
    targetTexts: [names],
    corpusTexts: [names],
    limit: 7,
  });
  assert.equal(candidates.length, 7);
  assert.deepEqual(
    candidates,
    [...candidates].sort((left, right) => right.score - left.score
      || left.sourceForm.localeCompare(right.sourceForm)),
  );
});

test("explicit alias evidence outranks case-ambiguous frontmatter vocabulary", () => {
  const english = getSourceLanguageProfile("en");
  const frontmatter = [
    "Part One. What follows is history. There was one King Richard.",
    "Richard, Duke of Gloucester. King Edward. Richard, Duke of York.",
    "Loukianos of Samosata, who was also known as Lucian the Scoffer, wrote a story.",
  ].join(" ");
  const body = [
    "what one finds there is up to the king and the duke.",
    "there was one road up and one road down.",
    "Richard met Edward. Richard met Edward.",
  ].join(" ");

  const candidates = english.collectAnchorCandidates({
    targetTexts: [frontmatter],
    corpusTexts: [frontmatter, body],
    limit: 12,
  });
  const forms = candidates.map((candidate) => candidate.sourceForm);

  assert.ok(forms.includes("Loukianos"));
  assert.ok(forms.includes("Lucian"));
  assert.ok(!forms.includes("What"));
  assert.ok(!forms.includes("There"));
  assert.ok(
    (candidates.find((candidate) => candidate.sourceForm === "Loukianos")?.score ?? 0)
      > (candidates.find((candidate) => candidate.sourceForm === "Richard")?.score ?? 0),
  );
});

test("residue findings reject prose but preserve declared forms and technical tokens", () => {
  const english = getSourceLanguageProfile("en");
  const findings = english.detectSourceResidue(
    "提丰 walked 向前。NASA 记录为 E=mc2，见 https://example.com。Lucian 沉默。",
    { preservedSourceForms: ["Lucian"] },
  );

  assert.deepEqual(findings.map((finding) => finding.form), ["walked"]);
  assert.equal(findings[0]?.code, "source_prose_residue");
});

test("French and generic profiles detect their source scripts conservatively", () => {
  const french = getSourceLanguageProfile("fr");
  const russian = getSourceLanguageProfile("ru");
  const japanese = getSourceLanguageProfile("ja");

  assert.ok(french.detectSourceResidue("他回答 bonjour puis 离开。")
    .some((finding) => finding.form === "bonjour"));
  assert.ok(russian.detectSourceResidue("他说 привет 然后离开。")
    .some((finding) => finding.form === "привет"));
  assert.ok(japanese.detectSourceResidue("他说 こんにちは 然后离开。")
    .some((finding) => finding.form === "こんにちは"));
});
