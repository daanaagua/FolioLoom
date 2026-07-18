import { createHash } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";

import type { EvidenceHit, V4Block, VisibilityChannel } from "./types.js";
import type {
  ResearchQuestion,
  ResolutionCandidate,
} from "../tools/candidate-collector.js";

export interface ProvisionalFact {
  questionId: string;
  kind: string;
  verdict: string;
  confidence: number;
  evidenceIds: string[];
  channel: VisibilityChannel;
}

export interface ProvisionalEvidence {
  evidenceId: string;
  blockId: string;
  globalIndex: number;
  paragraphIndex: number;
  sourceHash: string;
  channel: VisibilityChannel;
}

export interface ProvisionalSnapshot {
  schemaVersion: "v5-provisional-1";
  protocolHash: string;
  modelHash: string;
  targetScope: {
    blockIds: string[];
    globalIndexes: number[];
  };
  coverage: {
    completePrefix: false;
    indexedGlobalIndexes: number[];
  };
  questions: ResearchQuestion[];
  narrativeFacts: ProvisionalFact[];
  translatorFacts: ProvisionalFact[];
  unresolved: ResearchQuestion[];
  evidence: ProvisionalEvidence[];
  evidenceIds: string[];
  sourceHashes: Record<string, string>;
}

interface SnapshotInput {
  protocolVersion: string;
  systemPrompt: string;
  model: Model<any>;
  targetBlocks: readonly V4Block[];
  questions: readonly ResearchQuestion[];
  resolutions: readonly ResolutionCandidate[];
  unresolvedQuestionIds: readonly string[];
  evidence: readonly EvidenceHit[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function copyQuestion(question: ResearchQuestion): ResearchQuestion {
  return { ...question, subjectIds: [...question.subjectIds] };
}

export function buildProvisionalSnapshot(input: SnapshotInput): ProvisionalSnapshot {
  const questions = input.questions.map(copyQuestion);
  const byQuestion = new Map(questions.map((question) => [question.questionId, question]));
  const narrativeFacts: ProvisionalFact[] = [];
  const translatorFacts: ProvisionalFact[] = [];

  for (const resolution of input.resolutions) {
    const question = byQuestion.get(resolution.questionId);
    if (question === undefined) {
      throw new Error(`resolution references unknown question: ${resolution.questionId}`);
    }
    const fact: ProvisionalFact = {
      questionId: resolution.questionId,
      kind: question.kind,
      verdict: resolution.verdict,
      confidence: resolution.confidence,
      evidenceIds: [...resolution.evidenceIds],
      channel: question.channel,
    };
    if (question.channel === "narrative_before_target") {
      narrativeFacts.push(fact);
    } else {
      translatorFacts.push(fact);
    }
  }

  const unresolvedIds = new Set(input.unresolvedQuestionIds);
  const evidenceIds = [...new Set(input.resolutions.flatMap(
    (resolution) => resolution.evidenceIds,
  ))].sort();
  const evidenceByKey = new Map<string, ProvisionalEvidence>();
  for (const hit of input.evidence) {
    if (!evidenceIds.includes(hit.evidenceId)) {
      continue;
    }
    const key = `${hit.evidenceId}\0${hit.channel}`;
    evidenceByKey.set(key, {
      evidenceId: hit.evidenceId,
      blockId: hit.blockId,
      globalIndex: hit.globalIndex,
      paragraphIndex: hit.paragraphIndex,
      sourceHash: hit.sourceHash,
      channel: hit.channel,
    });
  }
  const evidence = [...evidenceByKey.values()].sort((left, right) =>
    left.globalIndex - right.globalIndex
    || left.paragraphIndex - right.paragraphIndex
    || left.evidenceId.localeCompare(right.evidenceId),
  );
  const sourceHashes: Record<string, string> = {};
  for (const block of input.targetBlocks) {
    sourceHashes[`block:${block.id}`] = block.sourceHash;
  }
  for (const item of evidence) {
    sourceHashes[`evidence:${item.evidenceId}`] = item.sourceHash;
  }
  const indexedGlobalIndexes = [...new Set([
    ...input.targetBlocks.map((block) => block.globalIndex),
    ...evidence.map((item) => item.globalIndex),
  ])].sort((left, right) => left - right);

  return {
    schemaVersion: "v5-provisional-1",
    protocolHash: digest(`${input.protocolVersion}\0${input.systemPrompt}`),
    modelHash: digest(`${input.model.provider}\0${input.model.id}`),
    targetScope: {
      blockIds: input.targetBlocks.map((block) => block.id),
      globalIndexes: input.targetBlocks.map((block) => block.globalIndex),
    },
    coverage: {
      completePrefix: false,
      indexedGlobalIndexes,
    },
    questions,
    narrativeFacts,
    translatorFacts,
    unresolved: questions.filter((question) => unresolvedIds.has(question.questionId)),
    evidence,
    evidenceIds,
    sourceHashes,
  };
}
