import assert from "node:assert/strict";
import test from "node:test";
import { lexicalReviewHints } from "../src/knowledge/lexical-review-hints.js";

test("legacy low-confidence ordinary decisions expose all occurrences as review hints without becoming terminology", () => {
  const revisions = [{ kind: "lexical_anchor_decision", status: "contextual", payload: { sourceForm: "tallyrod",
    target: "木柱", confidence: 0.55, semanticClass: "ordinary_word" } }];
  const sources = Array.from({ length: 6 }, (_, i) => ({ blockId: `b${i}`, sourceText: "he held his tallyrod." }));
  const translations = sources.map((s, i) => ({ blockId: s.blockId, text: i < 3 ? "他拿着筹杆。" : "他拿着木棒。" }));
  const original = JSON.stringify({ revisions, sources, translations });
  const hints = lexicalReviewHints({ revisions, sources, translations, scopeBlockIds: ["b3", "b4"] });
  assert.equal(hints.length, 1);
  assert.equal(hints[0]?.occurrences.length, 6);
  assert.equal(hints[0]?.classification, "ordinary_word");
  assert.doesNotMatch(JSON.stringify(hints), /confidence/);
  assert.equal(hints[0]?.readOnly, true);
  assert.ok(hints[0]!.examples.some(e => e.blockId === "b3" || e.blockId === "b4"));
  assert.ok(hints[0]!.examples.some(e => e.blockId !== "b3" && e.blockId !== "b4"));
  assert.ok(hints[0]!.examples.length <= 4);
  assert.deepEqual(lexicalReviewHints({ revisions, sources, translations, scopeBlockIds: ["outside"] }), []);
  assert.equal(JSON.stringify({ revisions, sources, translations }), original);
});

test("lexical hints reject unpaired text and ungrounded proposed forms", () => {
  for (const [confidence, sourceForm, text] of [[0.55, "invented", "筹杆。"], [0.55, "tallyrod", "筹杆。\n\n另起一段。"]] as const) {
    const sources = Array.from({ length: 6 }, (_, i) => ({ blockId: `b${i}`, sourceText: "his tallyrod fell." }));
    assert.deepEqual(lexicalReviewHints({ revisions: [{ kind: "lexical_anchor_decision", status: "contextual",
      payload: { sourceForm, target: "木柱", confidence, semanticClass: "ordinary_word" } }], sources,
      translations: sources.map(s => ({ blockId: s.blockId, text })), scopeBlockIds: ["b0"] }), []);
  }
});

test("mixed reference surfaces outrank frequent unchanged words within the same six-hint budget", () => {
  const words = ["cards", "gods", "well", "snow", "glass", "table", "bird"];
  const revisions = [...words, "tallyrod"].map(sourceForm => ({ kind: "lexical_anchor_decision", status: "contextual",
    payload: { sourceForm, semanticClass: "ordinary_word", target: sourceForm === "tallyrod" ? "筹杆" : "常见译法" } }));
  const sources = Array.from({ length: 6 }, (_, i) => ({ blockId: `b${i}`, sourceText: `${words.join(" ")} ${words.join(" ")} his tallyrod.` }));
  const translations = sources.map((s, i) => ({ blockId: s.blockId, text: `常见译法，他的${i < 3 ? "筹杆" : "木棒"}。` }));
  const hints = lexicalReviewHints({ revisions, sources, translations, scopeBlockIds: ["b0"] });
  assert.equal(hints.length, 6);
  assert.equal(hints[0]?.sourceForm, "tallyrod");
  assert.equal(hints[0]?.occurrences.length, 6);
});
