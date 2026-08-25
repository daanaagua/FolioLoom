import { createHash } from "node:crypto";

import type {
  EvidenceHit,
  StableTerm,
  V4Block,
  VisibilityChannel,
} from "../domain/types.js";
import type { EvidenceIndex } from "../index/evidence-index.js";
import type { NarrativeMemoryRecord } from "../fullbook/types.js";
import { BudgetLedger } from "../kernel/budget.js";
import { sourceTextForTranslation } from "../source/layout-separators.js";
import { hasSemanticText } from "../text/semantic-text.js";
import {
  CandidateCollector,
  TRANSLATION_MEMORY_KINDS,
  type ResolutionCandidate,
  type TranslationCandidate,
  type TranslationMemoryCandidate,
} from "./candidate-collector.js";
import {
  assertNotAborted,
  Type,
  type TypedToolSpec,
} from "./tool-spec.js";

export interface StyleState {
  [key: string]: string;
}

interface TranslationToolsOptions {
  budget: BudgetLedger;
  targetBlocks: readonly V4Block[];
  collector: CandidateCollector;
  stableTerms: readonly StableTerm[];
  resolvedEvidence: readonly ResolutionCandidate[];
  styleState: StyleState;
  evidenceIndex?: EvidenceIndex;
  /** Kept only to prove candidate submission cannot invoke active-state commits. */
  commitActiveState?: () => void;
}

export class TranslationTools {
  readonly #budget: BudgetLedger;
  readonly #targetBlocks: readonly V4Block[];
  readonly #collector: CandidateCollector;
  readonly #stableTerms: readonly StableTerm[];
  readonly #resolvedEvidence: readonly ResolutionCandidate[];
  readonly #styleState: StyleState;
  readonly #evidenceIndex?: EvidenceIndex;
  readonly #usedResolutionIds = new Set<string>();
  readonly #durableMemories: NarrativeMemoryRecord[] = [];

  constructor(options: TranslationToolsOptions) {
    this.#budget = options.budget;
    this.#targetBlocks = options.targetBlocks.map((item) => ({ ...item }));
    this.#collector = options.collector;
    this.#stableTerms = options.stableTerms.map((item) => ({ ...item }));
    this.#resolvedEvidence = options.resolvedEvidence.map((item) => ({
      ...item,
      evidenceIds: [...item.evidenceIds],
    }));
    this.#styleState = { ...options.styleState };
    this.#evidenceIndex = options.evidenceIndex;
    // commitActiveState is intentionally not retained.
  }

  async getRequiredContext(
    _args: Record<string, never> = {},
    signal?: AbortSignal,
  ): Promise<{ blocks: V4Block[]; stableTerms: StableTerm[] }> {
    assertNotAborted(signal);
    this.#budget.consume("translationToolCalls", 1);
    return {
      blocks: this.#targetBlocks.map((item) => ({ ...item })),
      stableTerms: this.#stableTerms.map((item) => ({ ...item })),
    };
  }

  async inspectLocalContinuity(
    args: { blockId: string; radius: number },
    signal?: AbortSignal,
  ): Promise<{ blocks: V4Block[] }> {
    assertNotAborted(signal);
    const index = this.#targetBlocks.findIndex((item) => item.id === args.blockId);
    if (index < 0) {
      throw new Error(`unknown target block: ${args.blockId}`);
    }
    if (!Number.isSafeInteger(args.radius) || args.radius < 0 || args.radius > 2) {
      throw new TypeError("radius must be an integer from 0 to 2");
    }
    this.#budget.consume("translationToolCalls", 1);
    return {
      blocks: this.#targetBlocks
        .slice(Math.max(0, index - args.radius), index + args.radius + 1)
        .map((item) => ({ ...item })),
    };
  }

  async retrieveResolvedEvidence(
    args: { questionIds: string[] },
    signal?: AbortSignal,
  ): Promise<{ resolutions: ResolutionCandidate[] }> {
    assertNotAborted(signal);
    const ids = new Set(args.questionIds);
    this.#budget.consume("translationToolCalls", 1);
    const resolutions = this.#resolvedEvidence
        .filter((item) => ids.size === 0 || ids.has(item.questionId))
        .map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] }));
    for (const resolution of resolutions) {
      this.#usedResolutionIds.add(resolution.questionId);
    }
    return { resolutions };
  }

  async inspectStyleState(
    _args: Record<string, never> = {},
    signal?: AbortSignal,
  ): Promise<{ styleState: StyleState }> {
    assertNotAborted(signal);
    this.#budget.consume("translationToolCalls", 1);
    return { styleState: { ...this.#styleState } };
  }

  async requestTranslationEvidence(
    args: {
      question: string;
      sourceForms: string[];
      channel: VisibilityChannel;
    },
    signal?: AbortSignal,
  ): Promise<{ question: string; evidence: EvidenceHit[] }> {
    assertNotAborted(signal);
    if (this.#evidenceIndex === undefined) {
      throw new Error("on-demand evidence lookup is unavailable");
    }
    const question = args.question?.trim();
    if (typeof question !== "string" || question.length < 8 || question.length > 500) {
      throw new TypeError("question must contain 8 to 500 characters");
    }
    if (!Array.isArray(args.sourceForms)
      || args.sourceForms.length < 1
      || args.sourceForms.length > 3) {
      throw new TypeError("sourceForms must contain one to three literal forms");
    }
    const targetSource = this.#targetBlocks
      .map((block) => block.sourceText)
      .join("\n")
      .normalize("NFKC")
      .toLocaleLowerCase();
    const sourceForms = [...new Set(args.sourceForms.map((form) => form.trim()))];
    for (const form of sourceForms) {
      if (form.length < 2 || form.length > 120) {
        throw new TypeError("each source form must contain 2 to 120 characters");
      }
      if (!targetSource.includes(form.normalize("NFKC").toLocaleLowerCase())) {
        throw new Error(`source form is not present in the target island: ${form}`);
      }
    }
    if (args.channel !== "narrative_before_target"
      && args.channel !== "translator_global") {
      throw new TypeError(`unsupported evidence channel: ${String(args.channel)}`);
    }
    const hits = this.#evidenceIndex.searchMentions({
      terms: sourceForms,
      channel: args.channel,
      targetGlobalIndex: Math.min(...this.#targetBlocks.map((block) => block.globalIndex)),
      limit: 6,
    });
    let remainingChars = Math.min(
      3_600,
      this.#budget.remaining("evidenceChars"),
    );
    const evidence: EvidenceHit[] = [];
    for (const hit of hits) {
      if (remainingChars <= 0) {
        break;
      }
      const visibleQuote = sourceTextForTranslation(hit.quote);
      if (!hasSemanticText(visibleQuote)) {
        continue;
      }
      const quote = [...visibleQuote]
        .slice(0, Math.min(900, remainingChars))
        .join("");
      remainingChars -= [...quote].length;
      evidence.push({ ...hit, quote });
    }
    const evidenceChars = evidence.reduce((total, hit) => total + [...hit.quote].length, 0);
    this.#budget.consumeMany({
      translationToolCalls: 1,
      researchToolCalls: 1,
      evidenceChars,
    });
    return { question, evidence };
  }

  async finalizeTranslation(
    args: Omit<TranslationCandidate, "repaired">,
    signal?: AbortSignal,
  ): Promise<{ accepted: true }> {
    assertNotAborted(signal);
    this.#validateTranslations(args.translations);
    this.#budget.consume("translationToolCalls", 1);
    this.#collector.addTranslation({
      translations: args.translations,
      notes: Array.isArray(args.notes) ? args.notes : [],
      memoryCandidates: args.memoryCandidates ?? [],
      repaired: false,
    });
    this.#collectDurableMemories(args.memoryCandidates ?? []);
    return { accepted: true };
  }

  specs(): TypedToolSpec[] {
    const Empty = Type.Object({}, { additionalProperties: false });
    return [
      {
        name: "get_required_context",
        label: "Get required context",
        description: "Read immutable target source blocks and stable terminology.",
        phase: "translation",
        parameters: Empty,
        execute: (args, signal) => this.getRequiredContext(
          args as Record<string, never>, signal,
        ),
      },
      {
        name: "inspect_local_continuity",
        label: "Inspect local continuity",
        description: "Read neighboring target blocks with a radius no larger than two.",
        phase: "translation",
        parameters: Type.Object({
          blockId: Type.String(),
          radius: Type.Integer({ minimum: 0, maximum: 2 }),
        }),
        execute: (args, signal) => this.inspectLocalContinuity(
          args as { blockId: string; radius: number }, signal,
        ),
      },
      {
        name: "retrieve_resolved_evidence",
        label: "Retrieve resolved evidence",
        description: "Read provisional evidence-bound research resolutions.",
        phase: "translation",
        parameters: Type.Object({ questionIds: Type.Array(Type.String()) }),
        execute: (args, signal) => this.retrieveResolvedEvidence(
          args as { questionIds: string[] }, signal,
        ),
      },
      {
        name: "inspect_style_state",
        label: "Inspect style state",
        description: "Read the compact, deterministic style control state.",
        phase: "translation",
        parameters: Empty,
        execute: (args, signal) => this.inspectStyleState(
          args as Record<string, never>, signal,
        ),
      },
      {
        name: "request_translation_evidence",
        label: "Request translation evidence",
        description: "Search bounded, position-safe whole-book evidence for literal source-language forms that occur in this target island.",
        phase: "translation",
        parameters: Type.Object({
          question: Type.String(),
          sourceForms: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
          channel: Type.Union([
            Type.Literal("narrative_before_target"),
            Type.Literal("translator_global"),
          ]),
        }),
        execute: (args, signal) => this.requestTranslationEvidence(
          args as {
            question: string;
            sourceForms: string[];
            channel: VisibilityChannel;
          },
          signal,
        ),
      },
      {
        name: "finalize_translation",
        label: "Finalize translation",
        description: "Submit a complete run-local translation candidate for validation.",
        phase: "translation",
        parameters: Type.Object({
          translations: Type.Array(Type.Object({
            blockId: Type.String(),
            text: Type.String(),
          })),
          notes: Type.Array(Type.String()),
          memoryCandidates: Type.Optional(Type.Array(Type.Object({
            kind: Type.Union(
              TRANSLATION_MEMORY_KINDS.map((kind) => Type.Literal(kind)),
            ),
            subjectForms: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
            fact: Type.String(),
            confidence: Type.Number({ minimum: 0, maximum: 1 }),
          }), { maxItems: 4 })),
        }),
        execute: (args, signal) => this.finalizeTranslation(
          args as Omit<TranslationCandidate, "repaired">,
          signal,
        ),
      },
    ];
  }

  usedResolutionIds(): string[] {
    return [...this.#usedResolutionIds].sort();
  }

  durableMemories(): NarrativeMemoryRecord[] {
    return this.#durableMemories.map((memory) => ({
      ...memory,
      subjectIds: [...memory.subjectIds],
      evidenceIds: [...memory.evidenceIds],
    }));
  }

  #collectDurableMemories(
    candidates: readonly TranslationMemoryCandidate[],
  ): void {
    if (!Array.isArray(candidates) || candidates.length > 4) {
      throw new TypeError("memoryCandidates must contain at most four items");
    }
    if (this.#evidenceIndex === undefined) {
      return;
    }
    const targetIds = new Set(this.#targetBlocks.map((block) => block.id));
    const targetSource = this.#targetBlocks
      .map((block) => block.sourceText)
      .join("\n")
      .normalize("NFKC")
      .toLocaleLowerCase();
    const targetEnd = Math.max(...this.#targetBlocks.map((block) => block.globalIndex));
    for (const candidate of candidates) {
      if (!Number.isFinite(candidate.confidence)
        || candidate.confidence < 0 || candidate.confidence > 1) {
        throw new TypeError("memory confidence must be between zero and one");
      }
      if (candidate.confidence < 0.9) {
        continue;
      }
      const fact = candidate.fact?.trim();
      if (typeof fact !== "string" || fact.length < 8 || fact.length > 600) {
        throw new TypeError("memory fact must contain 8 to 600 characters");
      }
      const subjectForms = candidate.subjectForms;
      if (!Array.isArray(subjectForms)
        || subjectForms.length < 1
        || subjectForms.length > 3
        || subjectForms.some((form: unknown) => typeof form !== "string")) {
        throw new TypeError("memory subjectForms must contain one to three items");
      }
      const forms: string[] = [...new Set<string>(
        (subjectForms as string[]).map((form) => form.trim()),
      )];
      for (const form of forms) {
        if (form.length < 2
          || !targetSource.includes(form.normalize("NFKC").toLocaleLowerCase())) {
          throw new Error(`memory subject form is not present in the target island: ${form}`);
        }
      }
      const normalizedForms = new Set(forms.map((form) =>
        form.normalize("NFKC").toLocaleLowerCase()));
      const subjectIds = [...new Set(this.#stableTerms
        .filter((term) => normalizedForms.has(
          term.sourceForm.normalize("NFKC").toLocaleLowerCase(),
        ) || normalizedForms.has(
          term.canonicalSource.normalize("NFKC").toLocaleLowerCase(),
        ))
        .map((term) => term.conceptId))];
      if (subjectIds.length === 0) {
        continue;
      }
      const evidenceIds = this.#evidenceIndex.searchMentions({
        terms: forms,
        channel: "narrative_before_target",
        targetGlobalIndex: targetEnd,
        limit: 6,
      }).filter((hit) => targetIds.has(hit.blockId))
        .map((hit) => hit.evidenceId);
      if (evidenceIds.length === 0) {
        continue;
      }
      const questionId = `memory-${createHash("sha256")
        .update(candidate.kind)
        .update("\0")
        .update(subjectIds.join("\0"))
        .update("\0")
        .update(fact)
        .digest("hex")
        .slice(0, 20)}`;
      this.#durableMemories.push({
        questionId,
        kind: candidate.kind,
        subjectIds,
        verdict: fact,
        confidence: candidate.confidence,
        channel: "narrative_before_target",
        visibleFromGlobalIndex: targetEnd + 1,
        evidenceIds,
      });
    }
  }

  #validateTranslations(
    translations: readonly { blockId: string; text: string }[],
  ): void {
    if (!Array.isArray(translations) || translations.length === 0) {
      throw new TypeError("translations must not be empty");
    }
    const targetIds = new Set(this.#targetBlocks.map((item) => item.id));
    const seen = new Set<string>();
    for (const translation of translations) {
      if (!targetIds.has(translation.blockId)) {
        throw new Error(`unknown target block: ${translation.blockId}`);
      }
      if (seen.has(translation.blockId)) {
        throw new Error(`duplicate target block: ${translation.blockId}`);
      }
      if (typeof translation.text !== "string" || !hasSemanticText(translation.text)) {
        throw new TypeError(`empty translation: ${translation.blockId}`);
      }
      seen.add(translation.blockId);
    }
  }
}
