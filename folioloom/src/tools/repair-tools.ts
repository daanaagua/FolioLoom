import type { V4Block } from "../domain/types.js";
import { BudgetLedger } from "../kernel/budget.js";
import { hasSemanticText } from "../text/semantic-text.js";
import {
  CandidateCollector,
  type TranslationCandidate,
} from "./candidate-collector.js";
import {
  assertNotAborted,
  Type,
  type TypedToolSpec,
} from "./tool-spec.js";

export interface ValidationFailure {
  code: string;
  blockId?: string;
  message: string;
  repairable: boolean;
}

interface RepairToolsOptions {
  budget: BudgetLedger;
  targetBlocks: readonly V4Block[];
  failures: readonly ValidationFailure[];
  collector: CandidateCollector;
}

export class RepairTools {
  readonly #budget: BudgetLedger;
  readonly #targetBlockIds: ReadonlySet<string>;
  readonly #failures: readonly ValidationFailure[];
  readonly #collector: CandidateCollector;

  constructor(options: RepairToolsOptions) {
    this.#budget = options.budget;
    this.#targetBlockIds = new Set(options.targetBlocks.map((item) => item.id));
    this.#failures = options.failures.map((item) => ({ ...item }));
    this.#collector = options.collector;
  }

  async inspectValidationFailures(
    _args: Record<string, never> = {},
    signal?: AbortSignal,
  ): Promise<{ failures: ValidationFailure[] }> {
    assertNotAborted(signal);
    this.#budget.consume("translationToolCalls", 1);
    return { failures: this.#failures.map((item) => ({ ...item })) };
  }

  async submitRepairedTranslation(
    args: Omit<TranslationCandidate, "repaired">,
    signal?: AbortSignal,
  ): Promise<{ accepted: true }> {
    assertNotAborted(signal);
    if (!Array.isArray(args.translations) || args.translations.length === 0) {
      throw new TypeError("translations must not be empty");
    }
    for (const translation of args.translations) {
      if (!this.#targetBlockIds.has(translation.blockId)) {
        throw new Error(`unknown target block: ${translation.blockId}`);
      }
      if (typeof translation.text !== "string" || !hasSemanticText(translation.text)) {
        throw new TypeError(`empty translation: ${translation.blockId}`);
      }
    }
    this.#budget.consume("translationToolCalls", 1);
    this.#collector.addTranslation({
      translations: args.translations,
      notes: Array.isArray(args.notes) ? args.notes : [],
      repaired: true,
    });
    return { accepted: true };
  }

  specs(): TypedToolSpec[] {
    return [
      {
        name: "inspect_validation_failures",
        label: "Inspect validation failures",
        description: "Read deterministic validation failures for the current candidate.",
        phase: "repair",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: (args, signal) => this.inspectValidationFailures(
          args as Record<string, never>, signal,
        ),
      },
      {
        name: "submit_repaired_translation",
        label: "Submit repaired translation",
        description: "Submit one run-local repaired translation candidate.",
        phase: "repair",
        parameters: Type.Object({
          translations: Type.Array(Type.Object({
            blockId: Type.String(),
            text: Type.String(),
          })),
          notes: Type.Array(Type.String()),
        }),
        execute: (args, signal) => this.submitRepairedTranslation(
          args as Omit<TranslationCandidate, "repaired">,
          signal,
        ),
      },
    ];
  }
}
