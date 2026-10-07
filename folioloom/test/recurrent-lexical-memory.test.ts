import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LexicalAnchorer } from "../src/agents/lexical-anchorer.js";
import { PiRuntime } from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { groundSurfaceUsages, readSurfaceObservations, surfaceMentions, surfaceObservations, surfaceConsistencyEvidence } from "../src/knowledge/surface-consistency.js";
const profile = getSourceLanguageProfile("en");

test("a weak ordinary classification of a recurrent noun retains grounded continuity observations, not a hard term", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", { anchors: [{ sourceForm: "tallyrod",
    target: "木柱", mode: "contextual", semanticClass: "ordinary_word", confidence: 0.55 }] }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({ candidates: [{ sourceForm: "tallyrod", discoveryKind: "recurrent_noun",
    corpusFrequency: 6, currentWaveOccurrences: 3, contexts: ["the tallyrod fell.", "he held his tallyrod."] }], stableTerms: [],
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), budget: new BudgetLedger() });
  assert.equal(outcome.anchors[0]?.discoveryKind, "recurrent_noun");
  assert.equal(outcome.anchors[0]?.semanticClass, "ordinary_word");
  assert.equal(outcome.terms.length, 0, "low confidence does not silently become a preferred or locked term");
  const source = { blockId: "b1", sourceText: "the tallyrod fell.\n\nhe held his tallyrod." };
  const translation = { blockId: "b1", text: "筹杆掉了。\n\n他拿着筹杆。" };
  const mentions = surfaceMentions([source], outcome.anchors, [], profile);
  assert.equal(mentions.length, 2);
  const usages = groundSurfaceUsages(mentions, mentions.map(m => ({ occurrenceId: m.occurrenceId, targetSurface: "筹杆" })), [translation]);
  const records = surfaceObservations({ windowId: "w1", sources: [source], translations: [translation], candidates: [],
    anchors: outcome.anchors, previous: [], usages, profile });
  assert.equal(records.length, 2);
  const memory = readSurfaceObservations(JSON.parse(JSON.stringify(records.map(r => ({ ...r, status: "provisional" })))), [translation]);
  const next = { blockId: "b2", sourceText: "his tallyrod struck the floor." };
  const resumedMentions = surfaceMentions([next], [], memory, profile);
  assert.equal(resumedMentions.length, 1);
  assert.equal(resumedMentions[0]?.preferredTarget, "筹杆");
  const changed = { blockId: "b2", text: "他的木棒敲到地上。" };
  const changedUsages = groundSurfaceUsages(resumedMentions, [{ occurrenceId: resumedMentions[0]!.occurrenceId, targetSurface: "木棒" }], [changed]);
  const nextRecords = surfaceObservations({ windowId: "w2", sources: [next], translations: [changed], candidates: [],
    anchors: [], previous: memory, usages: changedUsages, profile });
  const evidence = surfaceConsistencyEvidence({ sources: [next], translations: [changed], terms: [], profile,
    observations: [...memory, ...readSurfaceObservations(nextRecords.map(r => ({ ...r, status: "provisional" })))] });
  assert.equal(evidence.length, 1, "changed actual renderings reach semantic review without forcing a spelling");
  assert.equal(surfaceMentions([{ blockId: "b3", sourceText: "his tallyrod fell." }], [],
    [...memory, ...readSurfaceObservations(nextRecords.map(r => ({ ...r, status: "provisional" })))], profile)[0]?.preferredTarget,
    undefined, "multiple actual renderings remain evidence to inspect, not an arbitrarily forced global preference");
});

test("ordinary classifications without recurrent discovery evidence do not track every common word", () => {
  assert.equal(surfaceMentions([{ blockId: "b", sourceText: "his hand moved." }], [{ sourceForm: "hand", target: "手",
    mode: "contextual", confidence: 0.55, semanticClass: "ordinary_word" }], [], profile).length, 0);
});
