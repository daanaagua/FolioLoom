import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { BudgetLedger } from "../kernel/budget.js";
import { projectRecoveryRule } from "../recovery/registry.js";
import type {
  RecoveryIncident,
  RecoveryPlanResult,
  RecoveryPlanner,
  RecoveryPlanningInput,
  RecoveryRule,
} from "../recovery/types.js";
import { RecoveryTools } from "../tools/recovery-tools.js";
import { PiRuntime } from "./pi-runtime.js";

interface RecoveryAgentDependencies {
  readonly model: Model<any>;
  readonly streamFn: StreamFn;
  readonly budget: BudgetLedger;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

function ruleProjection(rule: RecoveryRule): Readonly<Record<string, unknown>> {
  return {
    allowedStrategies: [...rule.allowed],
    maxAttempts: rule.maxAttempts,
    requiredAudits: [...rule.requiredAudits],
    parameterPolicies: rule.parameterPolicies,
    requiresHuman: rule.requiresHuman === true,
  };
}

export function recoveryAgentPrompt(incident: RecoveryIncident): string {
  const rule = projectRecoveryRule(incident.code, incident.attemptedStrategies);
  return [
    "STRUCTURED INCIDENT",
    JSON.stringify({
      incidentId: incident.incidentId,
      code: incident.code,
      runId: incident.runId,
      stage: incident.stage,
      range: incident.range,
      invariant: incident.invariant,
      attemptedStrategies: incident.attemptedStrategies,
      suggestedAction: incident.suggestedAction,
    }),
    "REGISTERED RECOVERY BOUNDS",
    JSON.stringify(ruleProjection(rule)),
    "Inspect only the supplied local evidence. Choose one registered strategy, then submit once.",
  ].join("\n\n");
}

export class RecoveryAgent implements RecoveryPlanner {
  constructor(
    private readonly runtime: PiRuntime,
    private readonly dependencies: RecoveryAgentDependencies,
  ) {}

  async plan(input: RecoveryPlanningInput): Promise<RecoveryPlanResult> {
    const registered = projectRecoveryRule(
      input.incident.code,
      input.incident.attemptedStrategies,
    );
    if (registered.allowed.length === 0 || registered.maxAttempts === 0) {
      throw new Error(`Recovery Pi is disabled for ${input.incident.code}`);
    }
    if (JSON.stringify(ruleProjection(input.rule)) !== JSON.stringify(ruleProjection(registered))) {
      throw new Error(`recovery rule projection mismatch for ${input.incident.code}`);
    }
    const tools = new RecoveryTools({
      incident: input.incident,
      rule: registered,
      budget: this.dependencies.budget,
    });
    const run = await this.runtime.run({
      systemPrompt: [
        "Plan one bounded engineering recovery trial.",
        "You have read-only inspection tools, one registry-enumerated choice, and one submit tool.",
        "Never request source, translation, file, SQL, shell, hash, exclusion, audit, or budget mutation.",
        "Do not explain or retry. A response without submit_recovery_result is terminal quarantine.",
      ].join(" "),
      prompt: recoveryAgentPrompt(input.incident),
      phase: "recovery",
      model: this.dependencies.model,
      tools: tools.specs(),
      budget: this.dependencies.budget,
      terminateTools: ["submit_recovery_result"],
      maxTurns: 1,
      signal: this.dependencies.signal,
      deadlineMs: this.dependencies.deadlineMs,
    }, this.dependencies.streamFn);
    const submission = tools.submission();
    return {
      terminal: submission !== null,
      ...(submission === null ? {} : { strategy: submission.strategy }),
      parameters: submission?.parameters ?? {},
      modelCalls: run.modelCalls,
      toolNames: run.toolNames,
    };
  }
}
