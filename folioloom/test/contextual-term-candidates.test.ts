import assert from "node:assert/strict";
import test from "node:test";
import { collectWindowAnchorCandidates, prepareLexicalAnchorRequest } from "../src/agents/lexical-anchorer.js";
import type { V4Block } from "../src/domain/types.js";

const blocks = (texts: string[]): V4Block[] => texts.map((sourceText, globalIndex) => ({
  id: `b${globalIndex}`, legacyId: null, chapterId: "c1", chapterTitle: "Chapter 1",
  globalIndex, blockIndex: globalIndex, sourceText, sourceHash: "source", tokenCount: 100,
}));

test("parallel anchor discovery reserves bounded space for recurrent lowercase institutions", () => {
  const source = blocks([
    "Mira waited outside our consistory. Leon walked to the guildhall. The consistory's door was shut.",
    "Leon said our guildhall needed a roof. Mira returned to the consistory with Nera.",
    "Our consistory and your guildhall would remain open. Nera, Mira and Leon agreed.",
  ]);
  const candidates = collectWindowAnchorCandidates(source.slice(0, 1), source, []);
  for (const form of ["consistory", "guildhall", "Mira", "Leon"]) {
    assert.ok(candidates.some(c => c.sourceForm === form), form);
  }
  assert.ok(candidates.length <= 16);
  for (const c of candidates.filter(c => ["consistory", "guildhall"].includes(c.sourceForm))) {
    assert.notEqual(c.likelyProperName, true);
    assert.ok(c.contexts.every(s => s.includes(c.sourceForm)));
  }
});

test("contextual discovery preserves distinct source spellings and excludes established forms", () => {
  const source = blocks([
    "Mira visited our consistory and your consistary.",
    "The consistory and the consistary were open.",
    "Our consistory and our consistary held separate meetings.",
  ]);
  const candidates = collectWindowAnchorCandidates(source, source, []);
  assert.ok(candidates.some(c => c.sourceForm === "consistory"));
  assert.ok(candidates.some(c => c.sourceForm === "consistary"));
  const decided = collectWindowAnchorCandidates(source, source, [], ["consistory"]);
  assert.ok(!decided.some(c => c.sourceForm === "consistory"));
  assert.ok(decided.some(c => c.sourceForm === "consistary"));
});

test("contextual candidate quota cannot evict all names or turn pronoun contractions into anchors", () => {
  const source = blocks([
    "I'm with Mira. I'll ask Leon. I've seen our guildhall, our consistory and our observatory.",
    "I'm with Leon. I'll ask Mira. I've visited our guildhall, our consistory and our observatory.",
    "I'm with Mira. I'll ask Leon. I've repaired our guildhall, our consistory and our observatory.",
  ]);
  const candidates = collectWindowAnchorCandidates(source, source, []);
  assert.ok(candidates.some(c => c.sourceForm === "Mira"));
  assert.ok(candidates.some(c => c.sourceForm === "Leon"));
  assert.ok(!candidates.some(c => /^(?:I'm|I'll|I've)$/u.test(c.sourceForm)));
  assert.ok(candidates.filter(c => /^[a-z]/u.test(c.sourceForm)).length <= 4);
});

test("repeated determiner-adjective boilerplate does not create automatic noun anchors", () => {
  const source = blocks(Array.from({ length: 4 }, (_, i) => `the quiet mechanism preserves the complete source heading paragraph ${i}.`));
  const candidates = collectWindowAnchorCandidates(source, source, []);
  assert.ok(!candidates.some(c => ["quiet", "complete"].includes(c.sourceForm)));
});

test("demonstrative subjects followed by auxiliaries are not discovered as institutional nouns", () => {
  const source = blocks(Array.from({ length: 4 }, () => "Those were our consistory and our guildhall. These have always been separate."));
  const candidates = collectWindowAnchorCandidates(source, source, []);
  assert.ok(!candidates.some(c => ["were", "have", "been", "always"].includes(c.sourceForm)));
  assert.ok(candidates.some(c => c.sourceForm === "consistory"));
});

test("lexical instructions preserve source spellings and keep ordinary noun readings contextual", () => {
  const request = prepareLexicalAnchorRequest({ candidates: [], stableTerms: [] }, "typed_tool");
  assert.match(request.systemPrompt, /suspected.*(?:typo|OCR)/iu);
  assert.match(request.systemPrompt, /recurrent.*(?:institution|place)/iu);
});

test("ordinary people remain outside rare-noun discovery with inflected verb cues", () => {
  for (const person of ["person", "traveler", "traveller", "student", "teacher", "soldier", "stranger"]) {
    const source = blocks(Array.from({ length: 4 }, (_, i) => `The ${person} moved slowly through room ${i}.`));
    assert.equal(collectWindowAnchorCandidates(source.slice(0, 1), source, []).length, 0, person);
  }
});

test("repeated rare objects survive possessives, bounded modifiers, and inflected verb heads", () => {
  const source = blocks([
    "a worker carried an old tallyrod in one hand. the tallyrod flashed down.",
    "the guard held his tallyrod. the man struck with the tallyrod groaned.",
    "with his tallyrod, the worker pointed toward the gate.",
  ]);
  const candidates = collectWindowAnchorCandidates(source.slice(0, 1), source, []);
  const object = candidates.find(c => c.sourceForm === "tallyrod");
  assert.ok(object, "a repeated scene object is a candidate even without an institutional noun pattern");
  assert.equal(object.discoveryKind, "recurrent_noun");
  assert.equal(object.corpusFrequency, 5);
  assert.ok(candidates.length <= 16);
  assert.ok(candidates.filter(c => /^[a-z]/u.test(c.sourceForm)).length <= 4);
});

test("lowercase group nouns retain exact singular and plural candidates across compound modifiers", () => {
  const source = blocks([
    "a worn-out drem waited by the gate. there were a lot more drems around.",
    "We drems didn't join the gathering.",
    "all drems of whatever kind remained outside.",
  ]);
  const candidates = collectWindowAnchorCandidates(source.slice(0, 1), source, []);
  for (const [form, count] of [["drem", 1], ["drems", 3]] as const) {
    const candidate = candidates.find(c => c.sourceForm === form);
    assert.ok(candidate, `missing exact source form ${form}`);
    assert.equal(candidate.corpusFrequency, count, "related occurrences must not inflate exact-form evidence");
    assert.equal(candidate.currentWaveOccurrences, 1);
    assert.equal(candidate.morphologyDiversity, 2);
    assert.equal(candidate.discoveryKind, "recurrent_noun");
    assert.ok(candidate.contexts.every(q => new RegExp(`\\b${form}\\b`, "u").test(q)));
  }
  assert.ok(collectWindowAnchorCandidates(source.slice(1, 2), source, []).some(c => c.sourceForm === "drems"));
});

test("observed regular inflections support discovery without rewriting source spellings", () => {
  for (const [singular, plural] of [["drem", "drems"], ["nex", "nexes"], ["veldy", "veldies"]]) {
    const source = blocks([
      `a soot-stained ${singular} remained inside.`,
      `We ${plural} didn't enter.`,
      `all ${plural} of this kind stayed outside.`,
    ]);
    const candidates = collectWindowAnchorCandidates(source.slice(0, 1), source, []);
    const candidate = candidates.find(c => c.sourceForm === singular);
    assert.ok(candidate, singular);
    assert.equal(candidate.corpusFrequency, 1);
    assert.equal(candidate.sourceForm, singular);
    assert.ok(!candidates.some(c => c.sourceForm === plural), "a remote-only form is supporting context, not a current target");
    const request = prepareLexicalAnchorRequest({ candidates, stableTerms: [] }, "typed_tool");
    assert.match(request.prompt, new RegExp(`\\b${plural}\\b`, "u"), "the classifier sees the attested plural context");
  }
});

test("established inflections still support an undecided exact form without reopening established names", () => {
  const source = blocks(["a worn-out drem remained.", "We drems didn't leave.", "all drems of this kind remained."]);
  const candidates = collectWindowAnchorCandidates(source, source, [], ["drems"]);
  assert.ok(candidates.some(c => c.sourceForm === "drem"));
  assert.ok(!candidates.some(c => c.sourceForm === "drems"));
});

test("group and quantifier cues do not turn common people, verbs or modifiers into rare terms", () => {
  const source = blocks(Array.from({ length: 4 }, () =>
    "We teachers didn't leave. all students of this school stayed. more people stood outside. "
    + "we pass and we discuss. we work and we sleep. more quiet workers stood nearby. a worn-out worker remained."));
  const candidates = collectWindowAnchorCandidates(source, source, []);
  for (const form of ["teachers", "students", "people", "pass", "discuss", "work", "sleep", "quiet", "worn-out"]) {
    assert.ok(!candidates.some(c => c.sourceForm === form), form);
  }
  assert.ok(candidates.length <= 16);
  assert.ok(candidates.filter(c => /^[a-z]/u.test(c.sourceForm)).length <= 4);
});

test("similar spellings are not treated as inflections and repeated adjectives stay outside noun discovery", () => {
  const source = blocks([
    "a worn-out drem remained.", "all drams of this kind remained.", "We drams didn't leave.",
    "the luminous wall stood. the luminous door opened. the luminous roof remained.",
  ]);
  const candidates = collectWindowAnchorCandidates(source, source, []);
  assert.ok(!candidates.some(c => ["drem", "dram", "luminous"].includes(c.sourceForm)));
});

test("a low-frequency attested inflection gets bounded space beside frequent noun heads", () => {
  const source = blocks([
    "Mira waited. " + "the guildhall stood. the consistory stood. the observatory stood. the lyceum stood. ".repeat(4)
      + "a worn-out drem waited. there were more drems around.",
    "We drems didn't enter. all drems of this kind stayed outside.",
  ]);
  const candidates = collectWindowAnchorCandidates(source.slice(0, 1), source, []);
  assert.ok(candidates.some(c => c.sourceForm === "drem"), "frequent heads must not crowd out every inflection-supported singleton");
  assert.ok(candidates.some(c => c.sourceForm === "Mira"));
  assert.equal(candidates.filter(c => /^[a-z]/u.test(c.sourceForm)).length, 4);
});

test("explicit plural group evidence is not crowded out by an incidental singleton inflection", () => {
  const source = blocks([
    "the guildhall stood. the consistory stood. the observatory stood. ".repeat(4)
      + "the fists opened. more drems waited nearby.",
    "a fist opened. his fist remained. We drems didn't enter.",
    "a worn-out drem waited. all drems of this kind stayed outside.",
  ]);
  const candidates = collectWindowAnchorCandidates(source.slice(0, 1), source, []);
  assert.ok(candidates.some(c => c.sourceForm === "drems"));
  assert.ok(candidates.filter(c => /^[a-z]/u.test(c.sourceForm)).length <= 4);
});

test("quantifier-only boilerplate needs stronger noun evidence before spending a lexical call", () => {
  const source = blocks(Array.from({ length: 4 }, (_, i) =>
    `the ordinary apparatus preserves all details in source paragraph ${i}.`));
  assert.equal(collectWindowAnchorCandidates(source, source, []).length, 0);
});
