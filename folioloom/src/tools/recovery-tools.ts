import type { BudgetLedger } from "../kernel/budget.js";
import { validateRecoveryParameters } from "../recovery/registry.js";
import type {
  RecoveryIncident,
  RecoveryRule,
  RecoveryStrategy,
} from "../recovery/types.js";
import {
  assertNotAborted,
  Type,
  type TypedToolSpec,
} from "./tool-spec.js";

const EMPTY_PARAMETERS = Object.freeze({}) as Readonly<Record<string, unknown>>;

interface RecoveryToolsOptions {
  readonly incident: RecoveryIncident;
  readonly rule: RecoveryRule;
  readonly budget: BudgetLedger;
}

export interface SubmittedRecoveryChoice {
  readonly strategy: RecoveryStrategy;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export class RecoveryTools {
  readonly #incident: RecoveryIncident;
  readonly #rule: RecoveryRule;
  readonly #budget: BudgetLedger;
  #selected: RecoveryStrategy | null = null;
  #submitted: SubmittedRecoveryChoice | null = null;

  constructor(options: RecoveryToolsOptions) {
    this.#incident = structuredClone(options.incident);
    this.#rule = options.rule;
    this.#budget = options.budget;
  }

  selectedStrategy(): RecoveryStrategy | null {
    return this.#selected;
  }

  submission(): SubmittedRecoveryChoice | null {
    return this.#submitted === null ? null : structuredClone(this.#submitted);
  }

  async inspectIncident(
    _args: Record<string, never> = {},
    signal?: AbortSignal,
  ): Promise<Omit<RecoveryIncident, "sourceExcerpt" | "structureAnnotations">> {
    assertNotAborted(signal);
    this.#budget.consume("recoveryToolCalls", 1);
    const { sourceExcerpt: _sourceExcerpt, structureAnnotations: _annotations, ...report } =
      this.#incident;
    return structuredClone(report);
  }

  async inspectSourceSpan(
    _args: Record<string, never> = {},
    signal?: AbortSignal,
  ): Promise<{ range: RecoveryIncident["range"]; excerpt: string }> {
    assertNotAborted(signal);
    this.#budget.consume("recoveryToolCalls", 1);
    return {
      range: structuredClone(this.#incident.range),
      excerpt: this.#incident.sourceExcerpt.slice(0, 2_000),
    };
  }

  async inspectStructureAnnotations(
    _args: Record<string, never> = {},
    signal?: AbortSignal,
  ): Promise<{ annotations: RecoveryIncident["structureAnnotations"] }> {
    assertNotAborted(signal);
    this.#budget.consume("recoveryToolCalls", 1);
    return { annotations: structuredClone(this.#incident.structureAnnotations) };
  }

  async chooseRecoveryStrategy(
    args: { strategy: RecoveryStrategy },
    signal?: AbortSignal,
  ): Promise<{ accepted: true; strategy: RecoveryStrategy }> {
    assertNotAborted(signal);
    if (!this.#rule.allowed.includes(args.strategy)) {
      throw new Error(
        `recovery strategy ${String(args.strategy)} is not allowed for ${this.#incident.code}`,
      );
    }
    if (this.#selected !== null) {
      throw new Error("a recovery strategy has already been chosen");
    }
    this.#budget.consume("recoveryToolCalls", 1);
    this.#selected = args.strategy;
    return { accepted: true, strategy: args.strategy };
  }

  async submitRecoveryResult(
    args: { parameters?: unknown },
    signal?: AbortSignal,
  ): Promise<{ accepted: true; strategy: RecoveryStrategy }> {
    assertNotAborted(signal);
    if (this.#selected === null) {
      throw new Error("choose_recovery_strategy must succeed before submission");
    }
    if (this.#submitted !== null) {
      throw new Error("a recovery result has already been submitted");
    }
    this.#budget.consume("recoveryToolCalls", 1);
    const strategy = this.#selected;
    this.#submitted = {
      strategy,
      parameters: validateRecoveryParameters(
        this.#rule,
        strategy,
        args.parameters ?? EMPTY_PARAMETERS,
      ),
    };
    return { accepted: true, strategy };
  }

  specs(): TypedToolSpec[] {
    if (this.#rule.allowed.length === 0) {
      return [];
    }
    const strategySchema = Type.Union(
      this.#rule.allowed.map((strategy) => Type.Literal(strategy)),
    );
    const parameterSchemas = this.#rule.allowed.map((strategy) => {
      const policy = this.#rule.parameterPolicies[strategy];
      if (policy === undefined) {
        throw new Error(`missing parameter policy for ${strategy}`);
      }
      return Type.Object(Object.fromEntries(
        Object.entries(policy.properties).map(([name, constraint]) => [
          name,
          Type.Integer({ minimum: constraint.minimum, maximum: constraint.maximum }),
        ]),
      ), { additionalProperties: false });
    });
    return [
      {
        name: "inspect_incident",
        label: "Inspect recovery incident",
        description: "Read the structured incident report without source or storage write access.",
        phase: "recovery",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: (args, signal) => this.inspectIncident(
          args as Record<string, never>, signal,
        ),
      },
      {
        name: "inspect_source_span",
        label: "Inspect local source span",
        description: "Read only the bounded source excerpt attached to this incident.",
        phase: "recovery",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: (args, signal) => this.inspectSourceSpan(
          args as Record<string, never>, signal,
        ),
      },
      {
        name: "inspect_structure_annotations",
        label: "Inspect structure annotations",
        description: "Read only the bounded structure annotations attached to this incident.",
        phase: "recovery",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: (args, signal) => this.inspectStructureAnnotations(
          args as Record<string, never>, signal,
        ),
      },
      {
        name: "choose_recovery_strategy",
        label: "Choose registered recovery strategy",
        description: "Choose exactly one strategy from the current incident registry enum.",
        phase: "recovery",
        parameters: Type.Object({ strategy: strategySchema }, { additionalProperties: false }),
        execute: (args, signal) => this.chooseRecoveryStrategy(
          args as { strategy: RecoveryStrategy }, signal,
        ),
      },
      {
        name: "submit_recovery_result",
        label: "Submit recovery result",
        description: "Submit bounded parameters for the previously chosen registered strategy.",
        phase: "recovery",
        parameters: Type.Object({
          parameters: Type.Optional(Type.Union(parameterSchemas)),
        }, { additionalProperties: false }),
        execute: (args, signal) => this.submitRecoveryResult(
          args as { parameters?: unknown }, signal,
        ),
      },
    ];
  }
}
