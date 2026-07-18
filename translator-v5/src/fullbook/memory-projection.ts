import type {
  ProvisionalFact,
  ProvisionalSnapshot,
} from "../domain/provisional-snapshot.js";
import type { V4Block } from "../domain/types.js";
import type { SubjectRef } from "../tools/research-tools.js";
import type { ResearchQuestion } from "../tools/candidate-collector.js";
import type { NarrativeMemoryRecord } from "./types.js";

const MIN_DURABLE_CONFIDENCE = 0.9;
const DEFAULT_TAIL_CHARS = 1_600;

export function boundedActiveTail(
  value: string,
  maximumCharacters = DEFAULT_TAIL_CHARS,
): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
    throw new TypeError("maximumCharacters must be a non-negative integer");
  }
  return value.slice(-maximumCharacters);
}

export function projectNarrativeMemories(
  memories: readonly NarrativeMemoryRecord[],
  targetBlocks: readonly V4Block[],
  subjects: readonly SubjectRef[],
): NarrativeMemoryRecord[] {
  if (targetBlocks.length === 0) {
    return [];
  }
  const source = targetBlocks.map((block) => block.sourceText).join("\n").toLocaleLowerCase();
  const activeSubjects = new Set(subjects
    .filter((subject) => subject.forms.some((form) =>
      form.trim().length > 0 && source.includes(form.toLocaleLowerCase())))
    .map((subject) => subject.subjectId));
  const targetStart = Math.min(...targetBlocks.map((block) => block.globalIndex));
  return memories
    .filter((memory) =>
      memory.confidence >= MIN_DURABLE_CONFIDENCE
      && memory.subjectIds.some((subjectId) => activeSubjects.has(subjectId))
      && (memory.channel === "translator_global"
        || memory.visibleFromGlobalIndex <= targetStart))
    .sort((left, right) =>
      left.visibleFromGlobalIndex - right.visibleFromGlobalIndex
      || left.questionId.localeCompare(right.questionId))
    .map((memory) => ({
      ...memory,
      subjectIds: [...memory.subjectIds],
      evidenceIds: [...memory.evidenceIds],
    }));
}

export function mergeProjectedMemories(
  snapshot: ProvisionalSnapshot,
  projected: readonly NarrativeMemoryRecord[],
): ProvisionalSnapshot {
  const existing = new Set(snapshot.questions.map((question) => question.questionId));
  const additions = projected.filter((memory) => !existing.has(memory.questionId));
  const questions: ResearchQuestion[] = additions.map((memory) => ({
    questionId: memory.questionId,
    kind: memory.kind as ResearchQuestion["kind"],
    prompt: `Persisted evidence-bound fact for ${memory.subjectIds.join(" / ")}.`,
    subjectIds: [...memory.subjectIds],
    channel: memory.channel,
    impact: "high",
    mandatory: false,
  }));
  const facts: ProvisionalFact[] = additions.map((memory) => ({
    questionId: memory.questionId,
    kind: memory.kind,
    verdict: memory.verdict,
    confidence: memory.confidence,
    evidenceIds: [...memory.evidenceIds],
    channel: memory.channel,
  }));
  return {
    ...snapshot,
    targetScope: {
      blockIds: [...snapshot.targetScope.blockIds],
      globalIndexes: [...snapshot.targetScope.globalIndexes],
    },
    coverage: {
      completePrefix: false,
      indexedGlobalIndexes: [...snapshot.coverage.indexedGlobalIndexes],
    },
    questions: [...snapshot.questions, ...questions],
    narrativeFacts: [
      ...snapshot.narrativeFacts,
      ...facts.filter((fact) => fact.channel === "narrative_before_target"),
    ],
    translatorFacts: [
      ...snapshot.translatorFacts,
      ...facts.filter((fact) => fact.channel === "translator_global"),
    ],
    unresolved: [...snapshot.unresolved],
    evidence: snapshot.evidence.map((item) => ({ ...item })),
    evidenceIds: [...new Set([
      ...snapshot.evidenceIds,
      ...additions.flatMap((memory) => memory.evidenceIds),
    ])].sort(),
    sourceHashes: { ...snapshot.sourceHashes },
  };
}

export function memoriesFromSnapshot(
  snapshot: ProvisionalSnapshot,
): NarrativeMemoryRecord[] {
  const questionById = new Map(
    snapshot.questions.map((question) => [question.questionId, question]),
  );
  const nextGlobalIndex = Math.max(...snapshot.targetScope.globalIndexes) + 1;
  return [...snapshot.narrativeFacts, ...snapshot.translatorFacts]
    .filter((fact) => fact.confidence >= MIN_DURABLE_CONFIDENCE)
    .flatMap((fact): NarrativeMemoryRecord[] => {
      const question = questionById.get(fact.questionId);
      if (question === undefined || question.subjectIds.length === 0) {
        return [];
      }
      return [{
        questionId: fact.questionId,
        kind: fact.kind,
        subjectIds: [...question.subjectIds],
        verdict: fact.verdict,
        confidence: fact.confidence,
        channel: fact.channel,
        visibleFromGlobalIndex: fact.channel === "narrative_before_target"
          ? nextGlobalIndex
          : 0,
        evidenceIds: [...fact.evidenceIds],
      }];
    });
}
