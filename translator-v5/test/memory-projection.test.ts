import assert from "node:assert/strict";
import test from "node:test";

import type { ProvisionalSnapshot } from "../src/domain/provisional-snapshot.js";
import type { V4Block } from "../src/domain/types.js";
import {
  boundedActiveTail,
  mergeProjectedMemories,
  memoriesFromSnapshot,
  projectNarrativeMemories,
} from "../src/fullbook/memory-projection.js";

const target: V4Block = {
  id: "block-10",
  legacyId: "legacy-10",
  chapterId: "ch1",
  chapterTitle: "One",
  globalIndex: 10,
  blockIndex: 0,
  sourceText: "Smoky returned.",
  sourceHash: "hash-10",
  tokenCount: 3,
};

function emptySnapshot(): ProvisionalSnapshot {
  return {
    schemaVersion: "v5-provisional-1",
    protocolHash: "protocol",
    modelHash: "model",
    targetScope: { blockIds: [target.id], globalIndexes: [10] },
    coverage: { completePrefix: false, indexedGlobalIndexes: [10] },
    questions: [],
    narrativeFacts: [],
    translatorFacts: [],
    unresolved: [],
    evidence: [],
    evidenceIds: [],
    sourceHashes: { [`block:${target.id}`]: target.sourceHash },
  };
}

test("memory projection is subject-matched, position-safe, and bounded", () => {
  const memories = [
    {
      questionId: "q-visible",
      kind: "entity_identity",
      subjectIds: ["smoky"],
      verdict: "Smoky is the same person.",
      confidence: 0.96,
      channel: "narrative_before_target" as const,
      visibleFromGlobalIndex: 8,
      evidenceIds: ["ev-visible"],
    },
    {
      questionId: "q-future",
      kind: "entity_identity",
      subjectIds: ["smoky"],
      verdict: "Future revelation.",
      confidence: 0.99,
      channel: "narrative_before_target" as const,
      visibleFromGlobalIndex: 12,
      evidenceIds: ["ev-future"],
    },
    {
      questionId: "q-other",
      kind: "entity_identity",
      subjectIds: ["alice"],
      verdict: "Alice fact.",
      confidence: 0.99,
      channel: "translator_global" as const,
      visibleFromGlobalIndex: 0,
      evidenceIds: ["ev-other"],
    },
  ];
  const projected = projectNarrativeMemories(memories, [target], [{
    subjectId: "smoky",
    forms: ["Smoky"],
  }]);
  assert.deepEqual(projected.map((item) => item.questionId), ["q-visible"]);
  const merged = mergeProjectedMemories(emptySnapshot(), projected);
  assert.deepEqual(merged.narrativeFacts.map((item) => item.questionId), ["q-visible"]);
  assert.equal(merged.questions[0]?.impact, "high");
  assert.equal(boundedActiveTail("甲".repeat(2_000)).length, 1_600);
});

test("high-confidence snapshot facts become position-scoped durable memories", () => {
  const snapshot = emptySnapshot();
  snapshot.questions.push({
    questionId: "q1",
    kind: "entity_identity",
    prompt: "Who is Smoky?",
    subjectIds: ["smoky"],
    channel: "narrative_before_target",
    impact: "high",
    mandatory: false,
  });
  snapshot.narrativeFacts.push({
    questionId: "q1",
    kind: "entity_identity",
    verdict: "Same person.",
    confidence: 0.95,
    evidenceIds: ["ev1"],
    channel: "narrative_before_target",
  });
  assert.deepEqual(memoriesFromSnapshot(snapshot), [{
    questionId: "q1",
    kind: "entity_identity",
    subjectIds: ["smoky"],
    verdict: "Same person.",
    confidence: 0.95,
    channel: "narrative_before_target",
    visibleFromGlobalIndex: 11,
    evidenceIds: ["ev1"],
  }]);
});
