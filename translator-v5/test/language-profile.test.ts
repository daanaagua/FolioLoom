import assert from "node:assert/strict";
import test from "node:test";

import {
  getSourceLanguageProfile,
  supportedSourceLanguageIds,
} from "../src/language/profiles.js";

test("language profile registry resolves supported ids deterministically", () => {
  assert.deepEqual(supportedSourceLanguageIds(), [
    "de", "en", "es", "fr", "ja", "ru", "und",
  ]);
  assert.equal(getSourceLanguageProfile("en-US").id, "en");
  assert.equal(getSourceLanguageProfile("fr").id, "fr");
  assert.equal(getSourceLanguageProfile("unknown").id, "und");
  assert.equal(getSourceLanguageProfile("EN"), getSourceLanguageProfile("en"));
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
