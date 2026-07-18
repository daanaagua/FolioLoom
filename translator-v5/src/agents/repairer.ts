import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { ProvisionalSnapshot } from "../domain/provisional-snapshot.js";
import type { V4Block } from "../domain/types.js";
import type { BudgetLedger } from "../kernel/budget.js";
import {
  CandidateCollector,
  type TranslationCandidate,
} from "../tools/candidate-collector.js";
import {
  RepairTools,
  type ValidationFailure,
} from "../tools/repair-tools.js";
import { PiRuntime, type PiRunResult } from "./pi-runtime.js";

interface RepairInput {
  blocks: readonly V4Block[];
  failedCandidate: TranslationCandidate;
  failures: readonly ValidationFailure[];
  snapshot: ProvisionalSnapshot;
  collector: CandidateCollector;
  budget: BudgetLedger;
  model: Model<any>;
  streamFn: StreamFn;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface RepairOutcome {
  candidate?: TranslationCandidate;
  run: PiRunResult;
}

export interface BatchRepairInput {
  blocks: readonly V4Block[];
  failedCandidate: TranslationCandidate;
  failures: readonly ValidationFailure[];
  budget: BudgetLedger;
  model: Model<any>;
  streamFn: StreamFn;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export class Repairer {
  constructor(private readonly runtime: PiRuntime) {}

  async repair(input: RepairInput): Promise<RepairOutcome> {
    const before = input.collector.translations().length;
    const tools = new RepairTools({
      budget: input.budget,
      targetBlocks: input.blocks,
      failures: input.failures,
      collector: input.collector,
    });
    const prompt = [
      "VALIDATION FAILURES",
      JSON.stringify(input.failures),
      "SOURCE BLOCKS",
      input.blocks.map((block) =>
        `[${block.id}]\n${block.sourceText}`,
      ).join("\n\n"),
      "FAILED CANDIDATE",
      JSON.stringify(input.failedCandidate.translations),
      "NECESSARY PROVISIONAL FACTS",
      JSON.stringify([
        ...input.snapshot.narrativeFacts,
        ...input.snapshot.translatorFacts,
      ]),
      "Submit only corrected or newly supplied blocks with submit_repaired_translation; the kernel merges the patch by block ID.",
    ].join("\n\n");
    const run = await this.runtime.run({
      systemPrompt: [
        "Repair a Chinese literary translation only for the typed validation failures.",
        "Preserve all unaffected meaning and paragraph structure.",
        "Do not explain. Call submit_repaired_translation exactly once with the smallest sufficient block patch.",
      ].join("\n"),
      prompt,
      phase: "repair",
      model: input.model,
      tools: tools.specs().filter((tool) =>
        tool.name === "submit_repaired_translation"),
      budget: input.budget,
      terminateTools: ["submit_repaired_translation"],
      maxTurns: 1,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
    }, input.streamFn);
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
