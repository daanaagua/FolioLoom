import type {
  EvidenceHit,
  StableTerm,
  VisibilityChannel,
} from "../domain/types.js";
import { EvidenceIndex } from "../index/evidence-index.js";
import { BudgetLedger } from "../kernel/budget.js";
import {
  CandidateCollector,
  ALLOWED_QUESTION_KINDS,
  type ResearchQuestion,
  type ResolutionCandidate,
} from "./candidate-collector.js";
import {
  assertNotAborted,
  Type,
  type TypedToolSpec,
} from "./tool-spec.js";

export interface SubjectRef {
  subjectId: string;
  forms: string[];
}

interface ResearchToolsOptions {
  budget: BudgetLedger;
  evidenceIndex: EvidenceIndex;
  targetGlobalIndex: number;
  targetBlockIndexes?: readonly number[];
  subjects: readonly SubjectRef[];
  stableTerms?: readonly StableTerm[];
  questions?: readonly ResearchQuestion[];
  collector: CandidateCollector;
}

interface SearchResult {
  hits: EvidenceHit[];
  clipped: boolean;
}

interface IssuedEvidence {
  hit: EvidenceHit;
  channel: VisibilityChannel;
}

const VisibilitySchema = Type.Union([
  Type.Literal("narrative_before_target"),
  Type.Literal("translator_global"),
]);

const ResolutionSchema = Type.Object({
  questionId: Type.String(),
  verdict: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  evidenceIds: Type.Array(Type.String()),
  unresolved: Type.String(),
});

interface FinishResearchArgs {
  resolutions?: ResolutionCandidate[];
  unresolvedQuestionIds: string[];
}

function uniqueStrings(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  const result = values.map((value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${name} contains an invalid value`);
    }
    return value.trim();
  });
  return [...new Set(result)];
}

function validChannel(value: VisibilityChannel): void {
  if (value !== "narrative_before_target" && value !== "translator_global") {
    throw new TypeError(`invalid visibility channel: ${String(value)}`);
  }
}

export class ResearchTools {
  readonly #budget: BudgetLedger;
  readonly #evidenceIndex: EvidenceIndex;
  readonly #targetGlobalIndex: number;
  readonly #targetBlockIndexes: ReadonlySet<number>;
  readonly #subjects = new Map<string, SubjectRef>();
  readonly #stableTerms: readonly StableTerm[];
  readonly #questions = new Map<string, ResearchQuestion>();
  readonly #issuedEvidence = new Map<string, IssuedEvidence[]>();
  readonly #collector: CandidateCollector;

  constructor(options: ResearchToolsOptions) {
    this.#budget = options.budget;
    this.#evidenceIndex = options.evidenceIndex;
    this.#targetGlobalIndex = options.targetGlobalIndex;
    this.#targetBlockIndexes = new Set(
      options.targetBlockIndexes ?? [options.targetGlobalIndex],
    );
    this.#stableTerms = options.stableTerms ?? [];
    this.#collector = options.collector;
    for (const subject of options.subjects) {
      if (this.#subjects.has(subject.subjectId)) {
        throw new Error(`duplicate subject: ${subject.subjectId}`);
      }
      this.#subjects.set(subject.subjectId, {
        subjectId: subject.subjectId,
        forms: uniqueStrings(subject.forms, "subject forms"),
      });
    }
    if (options.questions !== undefined) {
      this.#validateQuestions(options.questions);
      this.#registerQuestions(options.questions);
      this.#collector.addQuestions(options.questions);
    }
  }

  async submitQuestions(
    args: { questions: ResearchQuestion[] },
    signal?: AbortSignal,
  ): Promise<{ acceptedQuestionIds: string[] }> {
    assertNotAborted(signal);
    this.#validateQuestions(args.questions);
    this.#budget.consume("researchToolCalls", 1);
    this.#registerQuestions(args.questions);
    this.#collector.addQuestions(args.questions);
    return { acceptedQuestionIds: args.questions.map((item) => item.questionId) };
  }

  async lookupSubjects(
    args: { forms: string[] },
    signal?: AbortSignal,
  ): Promise<{ matches: SubjectRef[] }> {
    assertNotAborted(signal);
    const forms = uniqueStrings(args.forms, "forms").map((item) => item.toLocaleLowerCase());
    this.#budget.consume("researchToolCalls", 1);
    const matches = [...this.#subjects.values()].filter((subject) =>
      subject.forms.some((form) => forms.includes(form.toLocaleLowerCase())),
    );
    return {
      matches: matches.map((subject) => ({
        subjectId: subject.subjectId,
        forms: [...subject.forms],
      })),
    };
  }

  async lookupTerms(
    args: { forms: string[] },
    signal?: AbortSignal,
  ): Promise<{ matches: StableTerm[] }> {
    assertNotAborted(signal);
    const forms = uniqueStrings(args.forms, "forms").map((item) => item.toLocaleLowerCase());
    this.#budget.consume("researchToolCalls", 1);
    return {
      matches: this.#stableTerms
        .filter((term) =>
          forms.includes(term.sourceForm.toLocaleLowerCase())
          || forms.includes(term.canonicalSource.toLocaleLowerCase()),
        )
        .map((term) => ({ ...term })),
    };
  }

  async searchMentions(
    args: {
      subjectIds: string[];
      channel: VisibilityChannel;
      limit: number;
    },
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    assertNotAborted(signal);
    const terms = this.#termsForSubjects(args.subjectIds);
    validChannel(args.channel);
    this.#budget.consume("researchToolCalls", 1);
    const hits = this.#evidenceIndex.searchMentions({
      terms,
      channel: args.channel,
      targetGlobalIndex: this.#targetGlobalIndex,
      limit: args.limit,
    });
    return this.#issueAndClip(hits, args.channel);
  }

  async searchCooccurrence(
    args: {
      subjectIds: string[];
      cues: string[];
      channel: VisibilityChannel;
      limit: number;
    },
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    assertNotAborted(signal);
    const terms = this.#termsForSubjects(args.subjectIds);
    const cues = uniqueStrings(args.cues, "cues");
    validChannel(args.channel);
    this.#budget.consume("researchToolCalls", 1);
    const hits = this.#evidenceIndex.searchCooccurrence({
      terms,
      cues,
      channel: args.channel,
      targetGlobalIndex: this.#targetGlobalIndex,
      limit: args.limit,
    });
    return this.#issueAndClip(hits, args.channel);
  }

  async getEvidenceContext(
    args: {
      evidenceIds: string[];
      channel: VisibilityChannel;
      beforeParagraphs: number;
      afterParagraphs: number;
    },
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    assertNotAborted(signal);
    const ids = uniqueStrings(args.evidenceIds, "evidenceIds");
    validChannel(args.channel);
    for (const id of ids) {
      if (!this.#wasIssued(id, args.channel)) {
        throw new Error(`unknown evidence for channel: ${id}`);
      }
    }
    this.#budget.consume("researchToolCalls", 1);
    const hits = this.#evidenceIndex.getContext({
      evidenceIds: ids,
      channel: args.channel,
      targetGlobalIndex: this.#targetGlobalIndex,
      beforeParagraphs: args.beforeParagraphs,
      afterParagraphs: args.afterParagraphs,
    });
    return this.#issueAndClip(hits, args.channel);
  }

  async submitResolution(
    args: ResolutionCandidate,
    signal?: AbortSignal,
  ): Promise<{ accepted: true }> {
    assertNotAborted(signal);
    this.#validateResolution(args);
    this.#budget.consume("researchToolCalls", 1);
    this.#collector.addResolution({ ...args, evidenceIds: [...args.evidenceIds] });
    return { accepted: true };
  }

  async finishResearch(
    args: FinishResearchArgs,
    signal?: AbortSignal,
  ): Promise<{ finished: true }> {
    assertNotAborted(signal);
    const resolutions = Array.isArray(args.resolutions) ? args.resolutions : [];
    if (resolutions.length > 4) {
      throw new TypeError("resolutions must contain at most 4 entries");
    }
    const resolutionIds = new Set<string>();
    for (const resolution of resolutions) {
      if (resolutionIds.has(resolution.questionId)) {
        throw new Error(`duplicate resolution: ${resolution.questionId}`);
      }
      resolutionIds.add(resolution.questionId);
      this.#validateResolution(resolution);
    }
    const ids = Array.isArray(args.unresolvedQuestionIds)
      ? [...new Set(args.unresolvedQuestionIds)]
      : [];
    for (const id of ids) {
      if (!this.#questions.has(id)) {
        throw new Error(`unknown question: ${id}`);
      }
      if (resolutionIds.has(id)) {
        throw new Error(`question cannot be both resolved and unresolved: ${id}`);
      }
    }
    this.#budget.consume("researchToolCalls", 1);
    for (const resolution of resolutions) {
      this.#collector.addResolution({
        ...resolution,
        evidenceIds: [...resolution.evidenceIds],
      });
    }
    this.#collector.finishResearch(ids);
    return { finished: true };
  }

  #validateResolution(args: ResolutionCandidate): void {
    const question = this.#questions.get(args.questionId);
    if (question === undefined) {
      throw new Error(`unknown question: ${args.questionId}`);
    }
    if (!Number.isFinite(args.confidence) || args.confidence < 0 || args.confidence > 1) {
      throw new TypeError("confidence must be between 0 and 1");
    }
    const evidenceIds = uniqueStrings(args.evidenceIds, "evidenceIds");
    for (const id of evidenceIds) {
      if (!this.#wasIssued(id, question.channel)) {
        throw new Error(`evidence visibility violation: ${id}`);
      }
    }
  }

  specs(): TypedToolSpec[] {
    return [
      {
        name: "submit_questions",
        label: "Submit questions",
        description: "Register bounded translation questions discovered in the target text.",
        phase: "research",
        parameters: Type.Object({ questions: Type.Array(Type.Object({
          questionId: Type.String(),
          kind: Type.String(),
          prompt: Type.String(),
          subjectIds: Type.Array(Type.String()),
          channel: VisibilitySchema,
          impact: Type.Optional(Type.Union([
            Type.Literal("high"),
            Type.Literal("medium"),
            Type.Literal("low"),
          ])),
          mandatory: Type.Optional(Type.Boolean()),
        }), { maxItems: 4 }) }),
        execute: (args, signal) => this.submitQuestions(
          args as { questions: ResearchQuestion[] },
          signal,
        ),
      },
      {
        name: "lookup_subjects",
        label: "Lookup subjects",
        description: "Resolve source forms to kernel-issued subject IDs.",
        phase: "research",
        parameters: Type.Object({ forms: Type.Array(Type.String()) }),
        execute: (args, signal) => this.lookupSubjects(
          args as { forms: string[] },
          signal,
        ),
      },
      {
        name: "lookup_terms",
        label: "Lookup terms",
        description: "Read stable source-to-target terminology decisions.",
        phase: "research",
        parameters: Type.Object({ forms: Type.Array(Type.String()) }),
        execute: (args, signal) => this.lookupTerms(
          args as { forms: string[] },
          signal,
        ),
      },
      {
        name: "search_mentions",
        label: "Search mentions",
        description: "Search indexed source paragraphs for known subjects.",
        phase: "research",
        parameters: Type.Object({
          subjectIds: Type.Array(Type.String()),
          channel: VisibilitySchema,
          limit: Type.Integer({ minimum: 1, maximum: 100 }),
        }),
        execute: (args, signal) => this.searchMentions(args as {
          subjectIds: string[];
          channel: VisibilityChannel;
          limit: number;
        }, signal),
      },
      {
        name: "search_cooccurrence",
        label: "Search co-occurrence",
        description: "Search paragraphs where known subjects and semantic cues co-occur.",
        phase: "research",
        parameters: Type.Object({
          subjectIds: Type.Array(Type.String()),
          cues: Type.Array(Type.String()),
          channel: VisibilitySchema,
          limit: Type.Integer({ minimum: 1, maximum: 100 }),
        }),
        execute: (args, signal) => this.searchCooccurrence(args as {
          subjectIds: string[];
          cues: string[];
          channel: VisibilityChannel;
          limit: number;
        }, signal),
      },
      {
        name: "get_evidence_context",
        label: "Get evidence context",
        description: "Expand only evidence IDs already issued in the same visibility channel.",
        phase: "research",
        parameters: Type.Object({
          evidenceIds: Type.Array(Type.String()),
          channel: VisibilitySchema,
          beforeParagraphs: Type.Integer({ minimum: 0, maximum: 10 }),
          afterParagraphs: Type.Integer({ minimum: 0, maximum: 10 }),
        }),
        execute: (args, signal) => this.getEvidenceContext(args as {
          evidenceIds: string[];
          channel: VisibilityChannel;
          beforeParagraphs: number;
          afterParagraphs: number;
        }, signal),
      },
      {
        name: "submit_resolution",
        label: "Submit resolution",
        description: "Submit a provisional, evidence-bound answer to a registered question.",
        phase: "research",
        parameters: ResolutionSchema,
        execute: (args, signal) => this.submitResolution(
          args as ResolutionCandidate,
          signal,
        ),
      },
      {
        name: "finish_research",
        label: "Finish research",
        description: "Atomically submit up to four evidence-bound resolutions, report unresolved questions, and terminate research.",
        phase: "research",
        parameters: Type.Object({
          resolutions: Type.Optional(Type.Array(ResolutionSchema, { maxItems: 4 })),
          unresolvedQuestionIds: Type.Array(Type.String()),
        }),
        execute: (args, signal) => this.finishResearch(
          args as FinishResearchArgs,
          signal,
        ),
      },
    ];
  }

  #termsForSubjects(subjectIds: readonly string[]): string[] {
    const ids = uniqueStrings(subjectIds, "subjectIds");
    const terms: string[] = [];
    for (const id of ids) {
      const subject = this.#subjects.get(id);
      if (subject === undefined) {
        throw new Error(`unknown subject: ${id}`);
      }
      terms.push(...subject.forms);
    }
    return [...new Set(terms)];
  }

  #validateQuestions(questions: readonly ResearchQuestion[]): void {
    if (!Array.isArray(questions) || questions.length > 4) {
      throw new TypeError("questions must contain at most 4 entries");
    }
    const seen = new Set<string>();
    for (const question of questions) {
      if (!question.questionId || seen.has(question.questionId) || this.#questions.has(question.questionId)) {
        throw new Error(`duplicate or invalid question: ${question.questionId}`);
      }
      seen.add(question.questionId);
      validChannel(question.channel);
      if (!ALLOWED_QUESTION_KINDS.includes(
        question.kind as typeof ALLOWED_QUESTION_KINDS[number],
      )) {
        throw new Error(`unsupported question kind: ${question.kind}`);
      }
      this.#termsForSubjects(question.subjectIds);
    }
  }

  #registerQuestions(questions: readonly ResearchQuestion[]): void {
    for (const question of questions) {
      this.#questions.set(question.questionId, {
        ...question,
        subjectIds: [...question.subjectIds],
      });
    }
  }

  #issueAndClip(hits: readonly EvidenceHit[], channel: VisibilityChannel): SearchResult {
    const returned: EvidenceHit[] = [];
    let clipped = false;
    let offTargetChars = 0;
    let remaining = this.#budget.remaining("evidenceChars");
    for (const hit of hits) {
      const offTarget = !this.#targetBlockIndexes.has(hit.globalIndex);
      if (offTarget && hit.quote.length > remaining) {
        clipped = true;
        continue;
      }
      if (offTarget) {
        offTargetChars += hit.quote.length;
        remaining -= hit.quote.length;
      }
      const issued = { ...hit, channel };
      returned.push(issued);
      const records = this.#issuedEvidence.get(hit.evidenceId) ?? [];
      records.push({ hit: issued, channel });
      this.#issuedEvidence.set(hit.evidenceId, records);
    }
    this.#budget.consume("evidenceChars", offTargetChars);
    return { hits: returned, clipped };
  }

  #wasIssued(evidenceId: string, channel: VisibilityChannel): boolean {
    return (this.#issuedEvidence.get(evidenceId) ?? [])
      .some((item) => item.channel === channel);
  }

  issuedEvidence(): EvidenceHit[] {
    const unique = new Map<string, EvidenceHit>();
    for (const records of this.#issuedEvidence.values()) {
      for (const record of records) {
        const key = `${record.hit.evidenceId}\0${record.channel}`;
        unique.set(key, { ...record.hit, channel: record.channel });
      }
    }
    return [...unique.values()].sort((left, right) =>
      left.globalIndex - right.globalIndex
      || left.paragraphIndex - right.paragraphIndex
      || left.evidenceId.localeCompare(right.evidenceId),
    );
  }

  subjects(): SubjectRef[] {
    return [...this.#subjects.values()].map((subject) => ({
      subjectId: subject.subjectId,
      forms: [...subject.forms],
    }));
  }
}
