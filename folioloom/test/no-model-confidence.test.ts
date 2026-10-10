import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LexicalAnchorer, prepareLexicalAnchorRequest } from "../src/agents/lexical-anchorer.js";
import { PiRuntime } from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { createLexicalPreference, readLexicalPreference } from "../src/knowledge/lexical-preference.js";
import { conceptFromAnchor } from "../src/knowledge/lexical-concept.js";
import { sanitizeTranslationMemoryCandidates } from "../src/tools/candidate-collector.js";
import { projectNarrativeMemories } from "../src/fullbook/memory-projection.js";
import type { V4Block } from "../src/domain/types.js";
import { canonicalJson } from "../src/knowledge/knowledge-store.js";
import { projectKnowledgeForTranslation } from "../src/knowledge/translation-knowledge-projection.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

test("lexical schemas and prompts never solicit a model confidence score", () => {
  for (const protocol of ["typed_tool", "framed_text"] as const) {
    const prepared = prepareLexicalAnchorRequest({ candidates: [], stableTerms: [] }, protocol);
    assert.doesNotMatch(JSON.stringify(prepared), /confidence/i);
  }
});

test("score-free and legacy low-score anchors preserve contextual variants equally", async () => {
  const results = [];
  for (const legacy of [false, true]) {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", { anchors: [{
      sourceForm: "Claw", target: "宝爪", mode: "contextual", semanticClass: "technical_term",
      meaning: "a sacred relic", usageScope: "the same relic; reverent wording may vary", allowedTargets: ["神爪"],
      ...(legacy ? { confidence: 0.1 } : {}),
    }] }), { stopReason: "toolUse" })]);
    results.push(await new LexicalAnchorer(new PiRuntime()).run({
      candidates: [{ sourceForm: "Claw", corpusFrequency: 3, currentWaveOccurrences: 2, documentFrequency: 1,
        contexts: ["The Claw shone. He venerated the Claw."] }], stableTerms: [],
      model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), budget: new BudgetLedger(),
    }));
  }
  assert.deepEqual(results[0]!.anchors, results[1]!.anchors);
  assert.deepEqual(results[0]!.terms, results[1]!.terms);
  const term = results[0]!.terms[0]!;
  assert.equal(term.policy, "contextual");
  assert.equal(term.locked, false);
  assert.deepEqual(term.allowedTargets, ["宝爪", "神爪"]);
  assert.doesNotMatch(JSON.stringify({ anchors: results[0]!.anchors, term }), /confidence/);
});

test("new preference and concept identities do not depend on obsolete self-scores", () => {
  const input = { sourceForm: "Claw", target: "宝爪", mode: "contextual" as const, semanticClass: "technical_term" as const,
    contexts: ["The Claw shone."], meaning: "a sacred relic", usageScope: "same relic", allowedTargets: ["神爪"] };
  const term = createLexicalPreference(input);
  assert.deepEqual(createLexicalPreference({ ...input, confidence: 0.1 }), term);
  assert.deepEqual(readLexicalPreference({ ...term, preference: { ...term.preference, confidence: 0.1 } }), term);
  assert.deepEqual(conceptFromAnchor(input), conceptFromAnchor({ ...input, confidence: 0.1 }));
  assert.doesNotMatch(JSON.stringify(term), /confidence/);
});

test("translation memory accepts grounded shape without self-rating and ignores legacy scores", () => {
  const candidate = { kind: "local_continuity", subjectForms: ["Claw"], fact: "The Claw is a sacred relic." };
  assert.deepEqual(sanitizeTranslationMemoryCandidates([candidate, { ...candidate, confidence: 0.1 }]), {
    candidates: [candidate, candidate], warnings: [],
  });
});

test("legacy low-score memories remain subject- and visibility-scoped but are not score-gated", () => {
  const block = { id: "b", sourceText: "The Claw shone.", globalIndex: 10 } as V4Block;
  const memory = { questionId: "q", kind: "term_sense", subjectIds: ["claw"], verdict: "a sacred relic", confidence: 0.1,
    channel: "narrative_before_target" as const, visibleFromGlobalIndex: 9, evidenceIds: ["ev"] };
  const projected = projectNarrativeMemories([memory, { ...memory, questionId: "future", visibleFromGlobalIndex: 11 }],
    [block], [{ subjectId: "claw", forms: ["Claw"] }]);
  assert.deepEqual(projected.map(m => m.questionId), ["q"]);
  assert.doesNotMatch(JSON.stringify(projected), /confidence/);
});

test("authentic legacy preference revision IDs survive a score-free read without mutating the journal", () => {
  const term = createLexicalPreference({ sourceForm: "Claw", target: "宝爪", mode: "contextual",
    contexts: ["The Claw shone."], meaning: "a relic", usageScope: "same relic", allowedTargets: ["神爪"] });
  const preference = { ...term.preference, confidence: 0.1 };
  const revisionId = `preference-${createHash("sha256").update(canonicalJson({ renderFingerprint: term.renderFingerprint, preference }))
    .digest("hex").slice(0, 24)}`;
  const legacy = { ...term, preference, revisionId }, original = JSON.stringify(legacy);
  const restored = readLexicalPreference(legacy)!;
  assert.equal(restored.revisionId, revisionId);
  assert.equal(restored.renderFingerprint, term.renderFingerprint);
  assert.equal(restored.policy, "contextual");
  assert.deepEqual(restored.allowedTargets, ["宝爪", "神爪"]);
  assert.doesNotMatch(JSON.stringify(restored), /confidence/);
  assert.equal(JSON.stringify(legacy), original);
});

test("legacy scores are absent from knowledge wire copies and never change selection", () => {
  const revision = { revisionId: "r", revision: 1, normalizedSubject: "claw", kind: "term_sense", status: "active",
    payload: { subjectForms: ["Claw"], fact: "A sacred relic.", confidence: 0.1 }, alternatives: [{ confidence: 0.9, fact: "a relic" }] };
  const original = JSON.stringify(revision);
  const project = (value: typeof revision) => projectKnowledgeForTranslation([value], ["The Claw shone."], getSourceLanguageProfile("en"));
  const projected = project(revision);
  assert.equal(projected.revisions.length, 1);
  assert.equal(projected.revisions[0]?.revisionId, "r");
  assert.doesNotMatch(JSON.stringify(projected), /confidence/);
  assert.deepEqual(projected, project({ ...revision, payload: { ...revision.payload, confidence: 0.99 } }));
  assert.equal(JSON.stringify(revision), original);
});
