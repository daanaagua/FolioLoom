import { createHash } from "node:crypto";

import type { V4Block } from "../domain/types.js";
import {
  ALLOWED_QUESTION_KINDS,
  type ResearchQuestion,
} from "../tools/candidate-collector.js";
import type { SubjectRef } from "../tools/research-tools.js";

interface QuestionScoutOptions {
  targetBlocks: readonly V4Block[];
  subjects: readonly SubjectRef[];
  mandatoryQuestions: readonly ResearchQuestion[];
}

function forcedId(subjectId: string): string {
  return `q-forced-${createHash("sha256").update(subjectId).digest("hex").slice(0, 12)}`;
}

/** Prompt policy and deterministic mandatory-question gate for local research. */
export class QuestionScout {
  readonly #targetBlocks: readonly V4Block[];
  readonly #subjects: readonly SubjectRef[];
  readonly #mandatoryQuestions: readonly ResearchQuestion[];

  constructor(options: QuestionScoutOptions) {
    this.#targetBlocks = options.targetBlocks.map((block) => ({ ...block }));
    this.#subjects = options.subjects.map((subject) => ({
      subjectId: subject.subjectId,
      forms: [...subject.forms],
    }));
    this.#mandatoryQuestions = options.mandatoryQuestions.map((question) => ({
      ...question,
      mandatory: true,
      subjectIds: [...question.subjectIds],
    }));
    this.#validateKinds(this.#mandatoryQuestions);
  }

  static forcedQuestionsForUnresolvedNames(
    subjects: readonly SubjectRef[],
  ): ResearchQuestion[] {
    return subjects.map((subject) => ({
      questionId: forcedId(subject.subjectId),
      kind: "entity_identity",
      prompt: `Resolve the local identity and reference of ${subject.forms.join(" / ")}.`,
      subjectIds: [subject.subjectId],
      channel: "narrative_before_target",
      impact: "high",
      mandatory: true,
    }));
  }

  mandatoryQuestions(): ResearchQuestion[] {
    return this.#mandatoryQuestions.map((question) => ({
      ...question,
      subjectIds: [...question.subjectIds],
    }));
  }

  systemPrompt(): string {
    return [
      "You are the question-scout and evidence-resolver for a literary translation.",
      "Use only the supplied typed tools. Never request shell, files, SQL, or arbitrary browsing.",
      `Allowed question kinds: ${ALLOWED_QUESTION_KINDS.join(", ")}.`,
      "Your first action must call submit_questions for newly discovered translation-critical ambiguities.",
      "Submit at most four additional questions; prefer zero. Ask only when the answer can materially change Chinese wording.",
      "Do not ask for themes, literary allusions, authorial intent, or general lore that is unnecessary for this passage.",
      "Do not remove or redefine mandatory questions. Retrieve only evidence needed for those questions.",
      "Every high-impact question must end resolved with issued evidence or explicitly unresolved.",
      "translator_global evidence may guide translation but must never be stated as narrator-visible knowledge.",
    ].join("\n");
  }

  prompt(): string {
    const blocks = this.#targetBlocks.map((block) =>
      `[${block.id} | global=${block.globalIndex}]\n${block.sourceText}`,
    ).join("\n\n");
    const subjects = this.#subjects.map((subject) =>
      `${subject.subjectId}: ${subject.forms.join(" | ")}`,
    ).join("\n");
    const mandatory = this.#mandatoryQuestions.map((question) =>
      `${question.questionId}: ${question.prompt}`,
    ).join("\n") || "(none)";
    return [
      "TARGET BLOCKS",
      blocks,
      "KNOWN SUBJECT IDS",
      subjects,
      "MANDATORY QUESTIONS",
      mandatory,
      "Submit zero to four additional questions. Do not research here; a separate resolver receives accepted questions.",
    ].join("\n\n");
  }

  resolverSearchPrompt(
    questions: readonly ResearchQuestion[],
    remainingToolCalls: number,
    remainingEvidenceChars: number,
  ): string {
    return [
      "REGISTERED QUESTIONS",
      JSON.stringify(questions),
      "KNOWN SUBJECT IDS",
      this.#subjects.map((subject) =>
        `${subject.subjectId}: ${subject.forms.join(" | ")}`,
      ).join("\n"),
      `REMAINING TOOL CALLS: ${remainingToolCalls}`,
      `REMAINING OFF-TARGET EVIDENCE CHARACTERS: ${remainingEvidenceChars}`,
      "SEARCH PHASE ONLY: perform at most six targeted lookup/search/context calls.",
      "Do not submit resolutions in this phase. A separate finalizer receives every issued evidence record.",
    ].join("\n\n");
  }

  assertSubmissionGate(
    toolNames: readonly string[],
    questions: readonly ResearchQuestion[],
  ): boolean {
    this.#validateKinds(questions);
    const submittedIds = new Set(questions.map((question) => question.questionId));
    for (const mandatory of this.#mandatoryQuestions) {
      if (!submittedIds.has(mandatory.questionId)) {
        throw new Error(`mandatory question was removed: ${mandatory.questionId}`);
      }
    }
    return toolNames.includes("submit_questions");
  }

  #validateKinds(questions: readonly ResearchQuestion[]): void {
    for (const question of questions) {
      if (!ALLOWED_QUESTION_KINDS.includes(
        question.kind as typeof ALLOWED_QUESTION_KINDS[number],
      )) {
        throw new Error(`unsupported question kind: ${question.kind}`);
      }
    }
  }
}
