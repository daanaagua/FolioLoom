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

test("weak lowercase technical terms retain grounded soft memory without concept promotion", () => {
  const sources = [{ blockId: "b1", sourceText: "The lyceum has a classroom. The lyceum closes at dusk." }];
  const proposals = [{ sourceForm: "lyceum", target: "学馆", mode: "contextual" as const, semanticClass: "unclassified" as const,
    proposedSemanticClass: "technical_term" as const, confidence: 0.65 }];
  const discovered = [{ sourceForm: "lyceum", contexts: [sources[0]!.sourceText], corpusFrequency: 4 }];
  const mentions = surfaceMentions(sources, proposals, [], profile);
  assert.equal(mentions.length, 2);
  const translations = [{ blockId: "b1", text: "学馆里有一间教室。学馆日落时闭门。" }];
  const usages = groundSurfaceUsages(mentions, mentions.map(m => ({ occurrenceId: m.occurrenceId, targetSurface: "学馆" })), translations);
  const records = surfaceObservations({ windowId: "w1", sources, translations, candidates: discovered, anchors: proposals,
    previous: [], profile, usages });
  const knowledge = new KnowledgeStore();
  knowledge.reconcileCandidates(records, "w1");
  const revisions = knowledge.projectableRevisions(), memory = readSurfaceObservations(revisions);
  assert.equal(memory.length, 2);
  assert.ok(memory.every(m => m.semanticClass === "technical_term" && m.observedTarget === "学馆" && m.confidence === undefined));
  assert.equal(stableTermsFromKnowledge(revisions).length, 0);
  const next = [{ blockId: "b2", sourceText: "The lyceum opened its doors." }];
  assert.equal(reconsiderSurfaceCandidates(discovered, memory, next, profile).length, 0);
  assert.equal(surfaceMentions(next, [], memory, profile)[0]?.preferredTarget, "学馆");
  assert.ok(projectKnowledgeForTranslation(revisions, next.map(s => s.sourceText), profile).revisions.length > 0);
  assert.equal(surfaceConsistencyEvidence({ sources: next, translations: [{ blockId: "b2", text: "学宫开门了。" }],
    observations: memory, terms: [], profile }).length, 1);
});

test("technical term observations require occurrence receipts and never infer a rendering from another paragraph", () => {
  const sources = [{ blockId: "b1", sourceText: "The lyceum opened.\n\nA separate lesson began." }];
  const proposals = [{ sourceForm: "lyceum", target: "学馆", mode: "stable" as const,
    proposedSemanticClass: "technical_term" as const, semanticClass: "unclassified" as const, confidence: 0.6 }];
  const records = surfaceObservations({ windowId: "w1", sources, translations: [{ blockId: "b1", text: "它开门了。\n\n学馆另开了一堂课。" }],
    candidates: [], anchors: proposals, previous: [], profile });
  assert.equal(records.length, 1);
  assert.equal((records[0]!.payload as any).observedTarget, null);
  assert.equal((records[0]!.payload as any).targetQuote, "");
});

test("multiple technical-term realizations remain contextual evidence, not a single forced preference", () => {
  const sources = [{ blockId: "b1", sourceText: "The lyceum opened.\n\nAfter lyceum, they left." }];
  const proposals = [{ sourceForm: "lyceum", target: "学馆", mode: "contextual" as const,
    proposedSemanticClass: "technical_term" as const, semanticClass: "unclassified" as const, confidence: 0.6 }];
  const translations = [{ blockId: "b1", text: "学馆开门了。\n\n授课结束后，他们离开了。" }];
  const mentions = surfaceMentions(sources, proposals, [], profile);
  assert.equal(mentions.length, 2);
  const usages = groundSurfaceUsages(mentions, mentions.map((m, i) => ({ occurrenceId: m.occurrenceId, targetSurface: i ? "授课" : "学馆" })), translations);
  const memory = surfaceObservations({ windowId: "w1", sources, translations, candidates: [], anchors: proposals,
    previous: [], profile, usages }).map(r => r.payload as any);
  assert.deepEqual(memory.map(m => m.observedTarget), ["学馆", "授课"]);
  assert.equal(surfaceMentions([{ blockId: "b2", sourceText: "After lyceum, they talked." }], [], memory, profile)[0]?.preferredTarget, undefined);
});

test("unknown surface evidence uses the matching complete paragraph, never the block prefix", () => {
  const sources = [{ blockId: "b2", sourceText: "An unrelated introduction.\n\nCopper waited by the gate.\n\nThe bell rang." }];
  const current = "开场与称呼无关。\n\n小铜在门边等着。" + "旁白仍在继续。".repeat(90) + "她没有离开😀。\n\n钟响了。";
  const evidence = surfaceConsistencyEvidence({ sources, translations: [{ blockId: "b2", text: current }],
    observations: observations().map(r => r.payload as any), terms: [], profile });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.sourceQuote, sources[0]!.sourceText.split("\n\n")[1]);
  assert.equal(evidence[0]!.currentTargetQuote, current.split("\n\n")[1]);
  const mismatched = surfaceConsistencyEvidence({ sources, translations: [{ blockId: "b2", text: "小铜。" }],
    observations: observations().map(r => r.payload as any), terms: [], profile });
  assert.equal(mismatched[0]!.currentTargetQuote, "", "unknown alignment must not pretend the first target is corresponding evidence");
});

test("fragment receipts ground only owned source occurrences in local target paragraphs", () => {
  const sources = [{ blockId: "b1", sourceText: "Copper waited.\n\nThe bell rang.\n\nCopper returned." }];
  const mentions = surfaceMentions(sources, anchors, [], profile);
  const start = sources[0]!.sourceText.lastIndexOf("Copper");
  const scope = { blockId: "b1", paragraphs: [{ ordinal: 2, utf16Start: start, utf16End: sources[0]!.sourceText.length }] };
  const usages = groundSurfaceUsages(mentions, mentions.map(m => ({ occurrenceId: m.occurrenceId, targetSurface: "铜铃" })),
    [{ blockId: "b1", text: "铜铃回来了。" }], scope);
  assert.deepEqual(usages.map(u => u.occurrenceId), [mentions[1]!.occurrenceId]);
  assert.equal(usages[0]?.paragraphIndex, 2, "persist global coordinates, not the fragment-local index");
});
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
  assert.equal(memory[0]?.confidence, undefined);
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
