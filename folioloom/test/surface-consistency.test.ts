import assert from "node:assert/strict";
import test from "node:test";
import { surfaceMentions, groundSurfaceUsages, surfaceObservations, readSurfaceObservations, surfaceConsistencyEvidence, reconsiderSurfaceCandidates } from "../src/knowledge/surface-consistency.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { stableTermsFromKnowledge } from "../src/knowledge/stable-terms-from-knowledge.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { projectKnowledgeForTranslation } from "../src/knowledge/translation-knowledge-projection.js";

const profile = getSourceLanguageProfile("en");
const source = [{ blockId: "b1", sourceText: "They called her Copper. Copper waited at the gate." }];
const anchors = [{ sourceForm: "Copper", target: "铜铃", mode: "stable" as const, semanticClass: "unclassified" as const,
  proposedSemanticClass: "proper_name" as const, confidence: 0.55 }];
const candidates = [{ sourceForm: "Copper", likelyProperName: true, corpusFrequency: 4, contexts: [source[0]!.sourceText] }];
test("actual per-occurrence receipts retain novel and conflicting renderings without locks", () => {
  const mentions = surfaceMentions(source, anchors, [], profile);
  assert.equal(mentions.length, 2);
  const translations = [{ blockId: "b1", text: "人们叫她小铜。铜妹在门口等待。" }];
  const usages = groundSurfaceUsages(mentions, mentions.map((m, i) => ({ occurrenceId: m.occurrenceId, targetSurface: i ? "铜妹" : "小铜" })), translations);
  const records = surfaceObservations({ windowId: "w1", sources: source, translations, candidates, anchors, previous: [], profile, usages });
  assert.deepEqual(records.map(r => (r.payload as any).observedTarget), ["小铜", "铜妹"]);
  assert.equal(surfaceConsistencyEvidence({ sources: source, translations, observations: records.map(r => r.payload as any), terms: [], profile }).length, 1);
});

test("surface receipts reject invented IDs and unrelated target paragraphs", () => {
  const sources = [{ blockId: "b1", sourceText: "Copper waited.\n\nThe bell rang." }];
  const mentions = surfaceMentions(sources, anchors, [], profile);
  const translations = [{ blockId: "b1", text: "她等着。\n\n铜铃响了。" }];
  assert.deepEqual(groundSurfaceUsages(mentions, [{ occurrenceId: mentions[0]!.occurrenceId, targetSurface: "铜铃" }, { occurrenceId: "invented", targetSurface: "她" }], translations), []);
});

test("partial receipts leave uncovered occurrences unknown and stale receipt quotes cannot migrate", () => {
  const mentions = surfaceMentions(source, anchors, [], profile);
  const translations = [{ blockId: "b1", text: "人们叫她小铜。铜妹在门口等待。" }];
  const usages = groundSurfaceUsages(mentions, [{ occurrenceId: mentions[0]!.occurrenceId, targetSurface: "小铜" }], translations);
  const records = surfaceObservations({ windowId: "w1", sources: source, translations, candidates, anchors, previous: [], profile, usages });
  assert.deepEqual(records.map(r => (r.payload as any).observedTarget), ["小铜", null]);
  assert.equal(surfaceConsistencyEvidence({ sources: source, translations, observations: records.map(r => r.payload as any), terms: [], profile }).length, 1);
  const memory = readSurfaceObservations(records.map(r => ({ ...r, status: "provisional" })), [{ blockId: "b1", text: "她等着。\n\n别处提到了小铜。" }]);
  assert.equal(memory[0]?.observedTarget, null);
});

test("unknown realizations can be reconsidered and frequency alone does not collect ordinary words", () => {
  const previous = observations().map(r => ({ ...(r.payload as any), observedTarget: null, targetQuote: "" }));
  assert.equal(reconsiderSurfaceCandidates(candidates, previous, [{ blockId: "b2", sourceText: "Copper returned." }], profile).length, 1);
  assert.equal(surfaceObservations({ windowId: "w1", sources: [{ blockId: "b1", sourceText: "Thus he waited." }], translations: [{ blockId: "b1", text: "于是他等着。" }], candidates: [{ sourceForm: "Thus", contexts: [], corpusFrequency: 9 }], anchors: [], previous: [], profile }).length, 0);
});
function observations() {
  return surfaceObservations({ windowId: "w1", sources: source, translations: [{ blockId: "b1", text: "人们叫她铜铃。铜铃在门口等待。" }],
    candidates, anchors, previous: [], profile });
}

test("EPUB protocol-only forms are neither observed nor replayed as semantic memory", () => {
  const marked = [{ blockId: "b1", sourceText: "⟦E1.0.0⟧Copper waited.⟦/E1.0.0⟧" }];
  const output = surfaceObservations({ windowId: "w1", sources: marked, translations: [{ blockId: "b1", text: "铜铃等着。" }],
    candidates: [{ sourceForm: "E1.0.0", contexts: [marked[0]!.sourceText], corpusFrequency: 2 }], anchors: [], previous: [], profile });
  assert.equal(output.length, 0);
  const stale = { ...observations()[0]!, recordId: "stale-marker", normalizedSubject: "e1.0.0:b1",
    payload: { ...(observations()[0]!.payload as any), sourceForm: "E1.0.0", sourceQuote: marked[0]!.sourceText, observedTarget: null, targetQuote: "" } };
  const knowledge = new KnowledgeStore();
  knowledge.reconcileCandidates([stale], "w1");
  const revisions = knowledge.projectableRevisions();
  assert.equal(readSurfaceObservations(revisions).length, 0);
  assert.equal(projectKnowledgeForTranslation(revisions, [marked[0]!.sourceText], profile).revisions.length, 0);
});

test("weak name proposals remain durable provisional observations, never locked terms", () => {
  const records = observations();
  const knowledge = new KnowledgeStore();
  knowledge.reconcileCandidates(records, "w1");
  const revisions = knowledge.projectableRevisions();
  assert.equal(revisions[0]?.status, "provisional");
  assert.equal(stableTermsFromKnowledge(revisions).length, 0);
  const memory = readSurfaceObservations(revisions);
  assert.equal(memory[0]?.observedTarget, "铜铃");
  assert.equal(memory[0]?.confidence, 0.55);
  assert.equal(memory[0]?.semanticClass, "proper_name");
  assert.equal(memory[0]?.blockId, "b1");
});

test("proposals absent from the actual translation are unknown, not fabricated realizations", () => {
  const records = surfaceObservations({ windowId: "w1", sources: source, translations: [{ blockId: "b1", text: "她在门口等待。" }], candidates, anchors, previous: [], profile });
  assert.equal((records[0]!.payload as any).observedTarget, null);
});

test("source mentions detect drift even without a stable concept and respect scoped renderings", () => {
  const memory = observations().map(r => r.payload as any);
  const current = [{ blockId: "b2", sourceText: "Copper returned to the gate." }];
  const translations = [{ blockId: "b2", text: "小铜回到了门口。" }];
  const evidence = surfaceConsistencyEvidence({ sources: current, translations, observations: memory, terms: [], profile });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.sourceForm, "Copper");
  assert.equal(evidence[0]?.previous[0]?.target, "铜铃");
  assert.equal(surfaceConsistencyEvidence({ sources: current, translations: [{ blockId: "b2", text: "铜铃回到了门口。" }], observations: memory, terms: [], profile }).length, 0);
  assert.equal(surfaceConsistencyEvidence({ sources: current, translations, observations: memory,
    terms: [{ sourceForm: "Copper", target: "小铜", ruleId: "speaker-address", applicableBlockIds: ["b2"] }], profile }).length, 0);
  assert.equal(surfaceConsistencyEvidence({ sources: [{ blockId: "b2", sourceText: "The copper pot fell." }], translations, observations: memory, terms: [], profile }).length, 0);
});

test("contextual decisions are reconsidered on new naming evidence, not every repetition", () => {
  const previous = observations().map(r => r.payload as any);
  assert.equal(reconsiderSurfaceCandidates(candidates, previous, [{ blockId: "b2", sourceText: "Copper returned." }], profile).length, 0);
  const chosen = reconsiderSurfaceCandidates(candidates, previous, [{ blockId: "b2", sourceText: "Her real name was Elin, but everyone called her Copper." }], profile);
  assert.equal(chosen.length, 1);
  assert.ok(chosen[0]!.contexts.some(c => c.includes("Elin")));
});
