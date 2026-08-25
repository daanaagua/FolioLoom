import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { ProvisionalSnapshot } from "../domain/provisional-snapshot.js";
import type { StableTerm, V4Block } from "../domain/types.js";
import type { EvidenceIndex } from "../index/evidence-index.js";
import type { NarrativeMemoryRecord } from "../fullbook/types.js";
import type { BudgetLedger } from "../kernel/budget.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import {
  SIMPLIFIED_CHINESE_SCRIPT_REQUIREMENT,
  targetLanguageLabel,
} from "../language/target.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  normalizeChineseQuoteTexts,
  normalizeChineseQuoteTextsAgainstSource,
} from "../style/chinese-quote-normalization.js";
import { simplifyChineseTranslation } from "../style/chinese-script-normalization.js";
import {
  normalizeTranslatedSceneSeparators,
  sourceTextForTranslation,
} from "../source/layout-separators.js";
import type {
  CandidateCollector,
  ResolutionCandidate,
  TranslationCandidate,
} from "../tools/candidate-collector.js";
import {
  TranslationTools,
  type StyleState,
} from "../tools/translation-tools.js";
import {
  TranslationValidator,
  type TranslationValidation,
} from "../validators/translation-validator.js";
import { PARAGRAPH_INTEGRITY_INSTRUCTIONS } from "./paragraph-integrity.js";
import type { PiRunResult } from "./pi-runtime.js";
import { PiRuntime } from "./pi-runtime.js";
import { Repairer } from "./repairer.js";

const MIN_TRANSLATION_FACT_CONFIDENCE = 0.9;

export interface TranslationIsland {
  islandId: string;
  chapterId: string;
  chapterTitle: string | null;
  blocks: V4Block[];
}

export interface TranslateIslandInput {
  island: TranslationIsland;
  model: Model<any>;
  streamFn: StreamFn;
  budget: BudgetLedger;
  collector: CandidateCollector;
  stableTerms: readonly StableTerm[];
  snapshot: ProvisionalSnapshot;
  styleState: StyleState;
  previousActiveTail: string;
  sourceLanguageProfile?: SourceLanguageProfile;
  signal?: AbortSignal;
  deadlineMs?: number;
  evidenceIndex?: EvidenceIndex;
}

export interface TranslationOutcome {
  island: TranslationIsland;
  initialPrompt: string;
  usedResolutionIds: string[];
  candidate?: TranslationCandidate;
  validation: TranslationValidation;
  run: PiRunResult;
  repairRuns: PiRunResult[];
  repaired: boolean;
  humanRequired: boolean;
  durableMemories: NarrativeMemoryRecord[];
}

function paragraphs(text: string): string[] {
  return text
    .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function sameParagraph(left: string, right: string): boolean {
  return left.replace(/\s+/gu, " ").trim() === right.replace(/\s+/gu, " ").trim();
}

/** Removes exact paragraph overlap introduced by context-bearing V4 block boundaries. */
export function trimExactBoundaryOverlaps(
  sourceBlocks: readonly V4Block[],
): V4Block[] {
  const result: V4Block[] = [];
  for (const sourceBlock of sourceBlocks) {
    const block = { ...sourceBlock };
    const previous = result.at(-1);
    if (previous !== undefined) {
      const previousParagraphs = paragraphs(previous.sourceText);
      const currentParagraphs = paragraphs(block.sourceText);
      const maximum = Math.min(previousParagraphs.length, currentParagraphs.length);
      let overlap = 0;
      for (let count = maximum; count >= 1; count -= 1) {
        const previousSuffix = previousParagraphs.slice(-count);
        const currentPrefix = currentParagraphs.slice(0, count);
        if (previousSuffix.every((paragraph, index) =>
          sameParagraph(paragraph, currentPrefix[index] as string))) {
          overlap = count;
          break;
        }
      }
      if (overlap > 0) {
        block.sourceText = currentParagraphs.slice(overlap).join("\n\n");
      }
    }
    result.push(block);
  }
  return result;
}

export function normalizeCandidateTypography(
  candidate: TranslationCandidate,
  _styleState: StyleState,
  preservedTargetForms: readonly string[] = [],
  sourceTextByBlockId: ReadonlyMap<string, string> = new Map(),
): TranslationCandidate {
  const targetTexts = candidate.translations.map((item) =>
    normalizeTranslatedSceneSeparators(
      item.text,
      sourceTextByBlockId.get(item.blockId),
    ));
  const sourceTexts = candidate.translations.map((item) =>
    sourceTextByBlockId.get(item.blockId));
  const normalizedTexts = sourceTexts.every((text): text is string => text !== undefined)
    ? normalizeChineseQuoteTextsAgainstSource(targetTexts, sourceTexts).texts
    : targetTexts.map((targetText, index) => {
      const sourceText = sourceTexts[index];
      return sourceText === undefined
        ? normalizeChineseQuoteTexts([targetText]).texts[0] ?? targetText
        : normalizeChineseQuoteTextsAgainstSource([targetText], [sourceText]).texts[0]
          ?? targetText;
    });
  return {
    ...candidate,
    notes: [...candidate.notes],
    translations: candidate.translations.map((translation, index) => ({
      ...translation,
      text: simplifyChineseTranslation(
        normalizedTexts[index] ?? translation.text,
        preservedTargetForms,
      ),
    })),
  };
}

export function splitIntoChapterIslands(
  sourceBlocks: readonly V4Block[],
): TranslationIsland[] {
  const blocks = [...sourceBlocks].sort((left, right) =>
    left.globalIndex - right.globalIndex || left.blockIndex - right.blockIndex,
  );
  const islands: TranslationIsland[] = [];
  for (const block of blocks) {
    const chapterId = block.chapterId ?? `chapter-at-${block.globalIndex}`;
    const current = islands.at(-1);
    if (current === undefined || current.chapterId !== chapterId) {
      islands.push({
        islandId: `${chapterId}:${block.globalIndex}`,
        chapterId,
        chapterTitle: block.chapterTitle,
        blocks: [{ ...block }],
      });
    } else {
      current.blocks.push({ ...block });
    }
  }
  return islands;
}

function factsAsResolutions(snapshot: ProvisionalSnapshot): ResolutionCandidate[] {
  return [...snapshot.narrativeFacts, ...snapshot.translatorFacts]
    .filter((fact) => fact.confidence >= MIN_TRANSLATION_FACT_CONFIDENCE)
    .map((fact) => ({
      questionId: fact.questionId,
      verdict: fact.verdict,
      confidence: fact.confidence,
      evidenceIds: [...fact.evidenceIds],
      unresolved: "",
    }));
}

function relevantTerms(
  blocks: readonly V4Block[],
  terms: readonly StableTerm[],
): StableTerm[] {
  const source = blocks.map((block) => block.sourceText).join("\n").toLocaleLowerCase();
  const seen = new Set<string>();
  return terms.filter((term) => {
    const match = source.includes(term.sourceForm.toLocaleLowerCase())
      || source.includes(term.canonicalSource.toLocaleLowerCase());
    const key = `${term.conceptId}\0${term.sourceForm}\0${term.target}`;
    if (!match || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function emptyCandidate(): TranslationCandidate {
  return { translations: [], notes: [], repaired: false };
}

export class Translator {
  readonly #validator = new TranslationValidator();
  readonly #repairer: Repairer;

  constructor(private readonly runtime: PiRuntime) {
    this.#repairer = new Repairer(runtime);
  }

  async translateIsland(input: TranslateIslandInput): Promise<TranslationOutcome> {
    const sourceLanguageProfile = input.sourceLanguageProfile
      ?? getSourceLanguageProfile("en");
    const terms = relevantTerms(input.island.blocks, input.stableTerms);
    const resolutions = factsAsResolutions(input.snapshot);
    const tools = new TranslationTools({
      budget: input.budget,
      targetBlocks: input.island.blocks,
      collector: input.collector,
      stableTerms: terms,
      resolvedEvidence: resolutions,
      styleState: input.styleState,
      evidenceIndex: input.evidenceIndex,
    });
    const before = input.collector.translations().length;
    const initialPrompt = this.#initialPrompt(input, terms);
    const run = await this.runtime.run({
      systemPrompt: [
        "Translate the complete source island into polished, accurate Chinese literary prose.",
        `The source language is ${sourceLanguageProfile.displayName} (${sourceLanguageProfile.id}); the target language is ${targetLanguageLabel()}.`,
        SIMPLIFIED_CHINESE_SCRIPT_REQUIREMENT,
        "Preserve meaning, ambiguity, paragraph structure, voice, and all block boundaries.",
        "When source text contains paired ⟦E…⟧ and ⟦/E…⟧ EPUB structural-slot markers, copy every marker byte-for-byte in the same order, translate only text inside each pair, and emit no prose outside those pairs in that paragraph.",
        ...PARAGRAPH_INTEGRITY_INSTRUCTIONS,
        "For supplied terms, locked=true must be reproduced exactly; policy=preferred is a default rendering, not a literal-in-every-context constraint.",
        "Use translator-global facts only to disambiguate wording; do not add facts unavailable to the narrator.",
        "Do not leave ordinary source-language prose words untranslated unless the stable terminology explicitly preserves them.",
        "If and only if a concrete ambiguity can change the Chinese wording, call request_translation_evidence with one to three literal source-language forms copied from the target island.",
        "Use narrative_before_target for narrator-visible context and translator_global only for silent lexical disambiguation. Do not research themes, allusions, or general lore.",
        "With finalize_translation, optionally submit up to four concise language-neutral memoryCandidates for explicit source-grounded facts likely to affect later wording. Use literal source-language subjectForms from this island; do not submit themes, predictions, interpretations, or low-confidence guesses.",
        "Use typed tools only. Submit every block exactly once with finalize_translation.",
      ].join("\n"),
      prompt: initialPrompt,
      phase: "translation",
      model: input.model,
      tools: tools.specs().filter((tool) =>
        tool.name === "retrieve_resolved_evidence"
        || (tool.name === "request_translation_evidence" && input.evidenceIndex !== undefined)
        || tool.name === "finalize_translation"),
      budget: input.budget,
      terminateTools: ["finalize_translation"],
      signal: input.signal,
      deadlineMs: input.deadlineMs,
    }, input.streamFn);

    const allowedLatinTokens = terms.flatMap((term) =>
      [...term.target.matchAll(/[A-Za-z][A-Za-z'-]+/gu)].map((match) => match[0]),
    );
    const requiredTerms = terms
      .filter((term) => term.locked)
      .map((term) => ({ sourceForm: term.sourceForm, target: term.target }));
    let candidate = input.collector.translations().slice(before).at(-1);
    const preservedTargetForms = terms.filter((term) => term.locked).map((term) => term.target);
    const sourceTextByBlockId = new Map(input.island.blocks.map((block) => [
      block.id,
      block.sourceText,
    ]));
    if (candidate !== undefined) {
      candidate = normalizeCandidateTypography(
        candidate,
        input.styleState,
        preservedTargetForms,
        sourceTextByBlockId,
      );
    }
    let validation = this.#validator.validate(
      input.island.blocks,
      candidate ?? emptyCandidate(),
      { allowedLatinTokens, requiredTerms, sourceLanguageProfile },
    );
    const repairRuns: PiRunResult[] = [];
    let repairAttempts = 0;
    while (!validation.valid
      && candidate !== undefined
      && repairAttempts < 3
      && input.budget.remaining("repairTurns") > 0) {
      const repair = await this.#repairer.repair({
        blocks: input.island.blocks,
        failedCandidate: candidate,
        failures: validation.failures,
        snapshot: input.snapshot,
        collector: input.collector,
        budget: input.budget,
        model: input.model,
        streamFn: input.streamFn,
        signal: input.signal,
        deadlineMs: input.deadlineMs,
      });
      repairAttempts += 1;
      repairRuns.push(repair.run);
      if (repair.candidate !== undefined) {
        candidate = normalizeCandidateTypography(
          repair.candidate,
          input.styleState,
          preservedTargetForms,
          sourceTextByBlockId,
        );
        validation = this.#validator.validate(
          input.island.blocks,
          candidate,
          { allowedLatinTokens, requiredTerms, sourceLanguageProfile },
        );
      }
    }
    return {
      island: input.island,
      initialPrompt,
      usedResolutionIds: tools.usedResolutionIds(),
      candidate,
      validation,
      run,
      repairRuns,
      repaired: candidate?.repaired ?? false,
      humanRequired: !validation.valid,
      durableMemories: tools.durableMemories(),
    };
  }

  #initialPrompt(input: TranslateIslandInput, terms: readonly StableTerm[]): string {
    const highImpactIds = new Set(input.snapshot.questions
      .filter((question) => question.impact === "high" || question.mandatory)
      .map((question) => question.questionId));
    const facts = [...input.snapshot.narrativeFacts, ...input.snapshot.translatorFacts]
      .filter((fact) =>
        highImpactIds.has(fact.questionId)
        && fact.confidence >= MIN_TRANSLATION_FACT_CONFIDENCE);
    return [
      `ISLAND ${input.island.islandId}`,
      `CHAPTER ${input.island.chapterId} ${input.island.chapterTitle ?? ""}`,
      `POSITION ${input.island.blocks[0]?.globalIndex}-${input.island.blocks.at(-1)?.globalIndex}`,
      `SOURCE LANGUAGE ${input.sourceLanguageProfile?.displayName ?? "English"} (${input.sourceLanguageProfile?.id ?? "en"})`,
      "SOURCE BLOCKS",
      input.island.blocks.map((block) =>
        `[${block.id}]\n${sourceTextForTranslation(block.sourceText)}`,
      ).join("\n\n"),
      "RELEVANT STABLE TERMS",
      terms.map((term) => `${term.sourceForm} => ${term.target}`).join("\n") || "(none)",
      "PREVIOUS ACTIVE TAIL",
      input.previousActiveTail || "(none)",
      "HIGH-IMPACT PROVISIONAL FACTS",
      JSON.stringify(facts),
      "STYLE STATE",
      JSON.stringify(input.styleState),
      "Translate all listed blocks. Retrieve a resolution only when its full evidence-bound wording is needed.",
    ].join("\n\n");
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("concurrency limit must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) {
          return;
        }
        results[index] = await worker(values[index] as T, index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
