import assert from "node:assert/strict";
import test from "node:test";
import { createLexicalPreference, readLexicalPreference } from "../src/knowledge/lexical-preference.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { stableTermsFromKnowledge } from "../src/knowledge/stable-terms-from-knowledge.js";
import { resolveStableTermsForBlocks } from "../src/knowledge/stable-term-resolver.js";
import { projectTranslationTerms } from "../src/knowledge/translation-term-projection.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { auditLexicalPreferences } from "../src/knowledge/lexical-preference-audit.js";

const preference = (meaning = "a counting implement", target = "筹杆") => createLexicalPreference({
  sourceForm: "tallyrod", target, meaning, usageScope: meaning, confidence: 0.65,
  contexts: ["Her tallyrod fell."], mode: "stable",
});
const profile = getSourceLanguageProfile("en");

test("separate lexical senses survive durable projection without competing hard rendering rules", () => {
  const memory = new KnowledgeStore();
  const senses = [preference(), preference("a named unit of debt", "筹债")];
  const revisions = senses.map(payload => memory.appendRevision({ normalizedSubject: "tallyrod",
    kind: `lexical_preference:${payload.preference!.senseId}`, payload, alternatives: [payload], status: "active" }));
  assert.notEqual(revisions[0]?.kind, revisions[1]?.kind);
  const terms = stableTermsFromKnowledge(JSON.parse(JSON.stringify(revisions)));
  assert.equal(terms.length, 1);
  assert.equal(terms[0]?.policy, "contextual");
  assert.equal(terms[0]?.locked, false);
  assert.deepEqual([...terms[0]!.allowedTargets!].sort(), ["筹债", "筹杆"].sort());
  assert.match(terms[0]!.note!, /counting implement/);
  assert.match(terms[0]!.note!, /unit of debt/);
  assert.equal(resolveStableTermsForBlocks(terms, [{ sourceVersion: "v1", blockId: "b", globalIndex: 0 }], profile).length, 1);
  const manual = { ...terms[0]!, conceptId: "manual", lexemeId: "manual", target: "数筹", allowedTargets: ["数筹"],
    policy: "locked" as const, locked: true, origin: "glossary" as const, authorityRank: 60 };
  assert.equal(resolveStableTermsForBlocks([...terms, manual], [{ sourceVersion: "v1", blockId: "b", globalIndex: 0 }], profile)[0]?.target, "数筹");
});

test("source-scoped preference is projected only for a relevant translation request", () => {
  const term = preference();
  const input = { blockIds: new Set(["b"]), occurrenceConceptIds: new Set<string>(), context: "A quiet room." };
  assert.equal(projectTranslationTerms([term], input).length, 0);
  assert.equal(projectTranslationTerms([term], { ...input, context: "Her tallyrod fell." }).length, 1);
  assert.equal(readLexicalPreference({ ...term, preference: { ...term.preference, evidenceQuotes: [] } }), undefined);
});

test("bounded preference metadata is idempotent when the clipping boundary lands on whitespace", () => {
  const term = createLexicalPreference({ sourceForm: "tallyrod", target: "筹杆", mode: "stable", confidence: 0.7,
    contexts: ["x".repeat(319) + " beyond the limit"], meaning: "y".repeat(239) + " more", usageScope: "same object" });
  assert.deepEqual(readLexicalPreference(JSON.parse(JSON.stringify(term))), term);
});

test("whole-source lexical audit covers six occurrences, flags differing paragraphs and never replaces prose", () => {
  const sources = Array.from({ length: 6 }, (_, i) => ({ blockId: `b${i}`, sourceText: "Her tallyrod fell.",
    globalIndex: i, sourceVersion: "v1" }));
  const translations = sources.map((s, i) => ({ blockId: s.blockId, text: i % 2 ? "她的木棒掉了下来。" : "她的筹杆掉了下来。" }));
  const before = JSON.stringify(translations);
  const result = auditLexicalPreferences({ sources, translations, terms: [preference()], profile });
  assert.equal(result.length, 6);
  assert.equal(result.filter(r => r.status === "preferred_surface_present").length, 3);
  assert.equal(result.filter(r => r.status === "variant_or_missing").length, 3);
  assert.equal(new Set(result.map(r => r.occurrenceId)).size, 6);
  assert.equal(JSON.stringify(translations), before);
});
