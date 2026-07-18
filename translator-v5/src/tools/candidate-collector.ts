import type { VisibilityChannel } from "../domain/types.js";

export interface ResearchQuestion {
  questionId: string;
  kind: string;
  prompt: string;
  subjectIds: string[];
  channel: VisibilityChannel;
  impact?: "high" | "medium" | "low";
  mandatory?: boolean;
}

export const ALLOWED_QUESTION_KINDS = [
  "entity_identity",
  "entity_relation",
  "term_sense",
  "coreference",
  "narrative_visibility",
  "discourse_role",
  "local_continuity",
] as const;

export type QuestionKind = typeof ALLOWED_QUESTION_KINDS[number];

export interface ResolutionCandidate {
  questionId: string;
  verdict: string;
  confidence: number;
  evidenceIds: string[];
  unresolved: string;
}

export interface BlockTranslation {
  blockId: string;
  text: string;
}

export interface TranslationMemoryCandidate {
  kind: string;
  subjectForms: string[];
  fact: string;
  confidence: number;
}

export interface TranslationCandidate {
  translations: BlockTranslation[];
  notes: string[];
  memoryCandidates?: TranslationMemoryCandidate[];
  repaired: boolean;
}

function copyResolution(candidate: ResolutionCandidate): ResolutionCandidate {
  return {
    ...candidate,
    evidenceIds: [...candidate.evidenceIds],
  };
}

function copyTranslation(candidate: TranslationCandidate): TranslationCandidate {
  return {
    translations: candidate.translations.map((item) => ({ ...item })),
    notes: [...candidate.notes],
    memoryCandidates: candidate.memoryCandidates?.map((item) => ({
      ...item,
      subjectForms: [...item.subjectForms],
    })),
    repaired: candidate.repaired,
  };
}

/** Run-local write buffer. It has no reference to the active project database. */
export class CandidateCollector {
  readonly #questions = new Map<string, ResearchQuestion>();
  readonly #resolutions: ResolutionCandidate[] = [];
  readonly #translations: TranslationCandidate[] = [];
  #researchFinished = false;
  #unresolvedQuestionIds: string[] = [];

  addQuestions(questions: readonly ResearchQuestion[]): void {
    for (const question of questions) {
      if (this.#questions.has(question.questionId)) {
        throw new Error(`duplicate question: ${question.questionId}`);
      }
      this.#questions.set(question.questionId, {
        ...question,
        subjectIds: [...question.subjectIds],
      });
    }
  }

  questions(): ResearchQuestion[] {
    return [...this.#questions.values()].map((question) => ({
      ...question,
      subjectIds: [...question.subjectIds],
    }));
  }

  addResolution(candidate: ResolutionCandidate): void {
    if (this.#resolutions.some((item) => item.questionId === candidate.questionId)) {
      throw new Error(`duplicate resolution: ${candidate.questionId}`);
    }
    this.#resolutions.push(copyResolution(candidate));
  }

  resolutions(): ResolutionCandidate[] {
    return this.#resolutions.map(copyResolution);
  }

  finishResearch(unresolvedQuestionIds: readonly string[]): void {
    this.#researchFinished = true;
    this.#unresolvedQuestionIds = [...unresolvedQuestionIds];
  }

  researchStatus(): { finished: boolean; unresolvedQuestionIds: string[] } {
    return {
      finished: this.#researchFinished,
      unresolvedQuestionIds: [...this.#unresolvedQuestionIds],
    };
  }

  addTranslation(candidate: TranslationCandidate): void {
    this.#translations.push(copyTranslation(candidate));
  }

  translations(): TranslationCandidate[] {
    return this.#translations.map(copyTranslation);
  }
}
