import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { ProvisionalSnapshot } from "../domain/provisional-snapshot.js";
import type { StableTerm, V4Block } from "../domain/types.js";
import type { BudgetLedger } from "../kernel/budget.js";
import { sourceTextForTranslation } from "../source/layout-separators.js";
import {
  CandidateCollector,
  type TranslationCandidate,
} from "../tools/candidate-collector.js";
import {
  RepairTools,
  type ValidationFailure,
} from "../tools/repair-tools.js";
import { PARAGRAPH_INTEGRITY_INSTRUCTIONS } from "./paragraph-integrity.js";
import { applyEpubRepairValues, prepareEpubRepairPlan } from "../tools/epub-repair-patch.js";
import {
  PiRuntime,
  ModelProviderError,
  type PiAssistantResponseObservation,
  type PiRunResult,
} from "./pi-runtime.js";

interface RepairInput {
  stableTerms?: readonly StableTerm[];
  blocks: readonly V4Block[];
  failedCandidate: TranslationCandidate;
  failures: readonly ValidationFailure[];
  snapshot: ProvisionalSnapshot;
  collector: CandidateCollector;
  budget: BudgetLedger;
  model: Model<any>;
  streamFn: StreamFn;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  deadlineMs?: number;
  onAssistantResponse?: (
    observation: PiAssistantResponseObservation,
  ) => void | Promise<void>;
}

export interface RepairOutcome {
  candidate?: TranslationCandidate;
  run: PiRunResult;
}

export interface BatchRepairInput {
  stableTerms?: readonly StableTerm[];
  blocks: readonly V4Block[];
  failedCandidate: TranslationCandidate;
  failures: readonly ValidationFailure[];
  budget: BudgetLedger;
  model: Model<any>;
  streamFn: StreamFn;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  deadlineMs?: number;
  onAssistantResponse?: (
    observation: PiAssistantResponseObservation,
  ) => void | Promise<void>;
}

export class Repairer {
  constructor(private readonly runtime: PiRuntime) {}

  async repair(input: RepairInput): Promise<RepairOutcome> {
    const before = input.collector.translations().length;
    const epubPlan = prepareEpubRepairPlan(input.blocks, input.failedCandidate, input.failures);
    const submitTool = "submit_repaired_translation";
    const tools = new RepairTools({
      budget: input.budget,
      targetBlocks: input.blocks,
      failures: input.failures,
      collector: input.collector,
    });
    const prompt = [
      "VALIDATION FAILURES",
      JSON.stringify(input.failures),
      ...(epubPlan ? ["EPUB REPAIR CONTEXT", JSON.stringify(epubPlan.paragraphs),
        "ORDERED TEXT SLOTS (one-based position, source text, current translation)",
        JSON.stringify(epubPlan.slots.map((slot, index) => [index + 1, slot.sourceText, slot.expectedText])),
        `Return exactly one JSON array of ${epubPlan.slots.length} values in the issued order. Each value is a replacement string or null to keep that slot unchanged. Include every position, including unchanged positions. Do not return objects, field names, IDs, hashes, notes, Markdown fences or explanations.`,
        "Only listed slots may be changed. Read neighboring paragraphs as context only. For a sentence spanning slots, return all necessary slot edits together; preserve the semantic ownership of emphasis and inline formatting. Never output markers, new paragraphs or a replacement block."] : [
      "SOURCE BLOCKS", input.blocks.map((block) =>
        `[${block.id}]\n${sourceTextForTranslation(block.sourceText)}`,
      ).join("\n\n"),
      "FAILED CANDIDATE",
      JSON.stringify(input.failedCandidate.translations)]),
      "ESTABLISHED TERMINOLOGY",
      JSON.stringify((input.stableTerms ?? []).filter(term => !term.applicableBlockIds || input.blocks.some(b => term.applicableBlockIds!.includes(b.id))).map(term => ({
        sourceForm: term.sourceForm, target: term.target, locked: term.locked, policy: term.policy,
        allowedTargets: term.allowedTargets, semanticClass: term.semanticClass, applicableBlockIds: term.applicableBlockIds,
      }))),
      "NECESSARY PROVISIONAL FACTS",
      JSON.stringify([
        ...input.snapshot.narrativeFacts,
        ...input.snapshot.translatorFacts,
      ]),
      epubPlan ? "Return the complete ordered string/null array in one response."
        : "Submit only corrected or newly supplied blocks with submit_repaired_translation; the kernel merges the patch by block ID.",
    ].join("\n\n");
    const run = await this.runtime.run({
      systemPrompt: [
        "Repair a Chinese literary translation only for the typed validation failures.",
        "Preserve all unaffected meaning and paragraph structure.",
        "Retain established names and terminology throughout the corrected blocks. Never override locked targets or scoped allowed forms; soft terms remain contextual, not blanket literal substitutions.",
        ...PARAGRAPH_INTEGRITY_INSTRUCTIONS,
        epubPlan ? "Do not explain. Output only the ordered JSON array of string/null values; the host owns all metadata and formatting."
          : `Do not explain. Call ${submitTool} exactly once with the smallest sufficient patch.`,
      ].join("\n"),
      prompt,
      phase: "repair",
      model: input.model,
      tools: epubPlan ? [] : tools.specs().filter((tool) =>
        tool.name === submitTool),
      budget: input.budget,
      terminateTools: [submitTool],
      maxTurns: 1,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
      thinkingLevel: input.thinkingLevel,
      onAssistantResponse: input.onAssistantResponse,
    }, input.streamFn);
    if (epubPlan) {
      try {
        input.signal?.throwIfAborted();
        const responses = run.providerResponses ?? run.messages.filter(m => m.role === "assistant");
        const response = responses.at(-1);
        if (run.stopReason !== "stop" || run.deadlineExceeded || run.turnLimitReached || responses.length !== 1
          || !response || response.content.some(c => c.type === "toolCall")) throw new Error("incomplete EPUB repair response");
        const text = response.content.filter(c => c.type === "text").map(c => c.text).join("");
        const repaired = applyEpubRepairValues(epubPlan, input.failedCandidate, JSON.parse(text));
        input.budget.consume("translationToolCalls", 1);
        input.collector.addTranslation(repaired);
        return { candidate: repaired, run };
      } catch (error) {
        throw new ModelProviderError(`invalid EPUB repair values: ${error instanceof Error ? error.message : String(error)}`,
          "protocol", false).withRun(run);
      }
    }
    const patch = input.collector.translations().slice(before).at(-1);
    return {
      candidate: patch === undefined
        ? undefined
        : mergeRepairPatch(input.blocks, input.failedCandidate, patch),
      run,
    };
  }

  async repairBatch(input: BatchRepairInput): Promise<RepairOutcome> {
    const collector = new CandidateCollector();
    const sourceHashes = Object.fromEntries(input.blocks.map((block) => [
      `block:${block.id}`,
      block.sourceHash,
    ]));
    return this.repair({
      ...input,
      collector,
      snapshot: {
        schemaVersion: "v5-provisional-1",
        protocolHash: "lossless-batch-repair",
        modelHash: `${input.model.provider}:${input.model.id}`,
        targetScope: {
          blockIds: input.blocks.map((block) => block.id),
          globalIndexes: input.blocks.map((block) => block.globalIndex),
        },
        coverage: {
          completePrefix: false,
          indexedGlobalIndexes: input.blocks.map((block) => block.globalIndex),
        },
        questions: [],
        narrativeFacts: [],
        translatorFacts: [],
        unresolved: [],
        evidence: [],
        evidenceIds: [],
        sourceHashes,
      },
    });
  }
}

function mergeRepairPatch(
  blocks: readonly V4Block[],
  failedCandidate: TranslationCandidate,
  patch: TranslationCandidate,
): TranslationCandidate {
  const originalById = new Map(
    failedCandidate.translations.map((translation) => [translation.blockId, translation]),
  );
  const patchById = new Map(
    patch.translations.map((translation) => [translation.blockId, translation]),
  );
  return {
    translations: blocks.flatMap((block) => {
      const translation = patchById.get(block.id) ?? originalById.get(block.id);
      return translation === undefined ? [] : [{ ...translation }];
    }),
    notes: [...patch.notes],
    repaired: true,
  };
}
