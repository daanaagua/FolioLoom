import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { PiRuntime } from "../src/agents/pi-runtime.js";
import { RecoveryAgent, recoveryAgentPrompt } from "../src/agents/recovery-agent.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import {
  INCIDENT_CODES,
  RECOVERY_RULES,
} from "../src/recovery/registry.js";
import { RecoveryEngine } from "../src/recovery/recovery-engine.js";
import type {
  IncidentCode,
  RecoveryAudit,
  RecoveryIncident,
  RecoveryKernel,
  RecoveryPlanner,
  RecoveryShadow,
  RecoveryStrategy,
} from "../src/recovery/types.js";
import { RecoveryTools } from "../src/tools/recovery-tools.js";

function incident(code: IncidentCode): RecoveryIncident {
  return {
    incidentId: `incident-${code.toLowerCase()}`,
    code,
    runId: "run-old",
    stage: "preflight_blocked",
    range: { start: 0, end: 5 },
    invariant: "lossless source and run lineage must remain provable",
    sourceExcerpt: "Alpha",
    structureAnnotations: [{ kind: "prose", start: 0, end: 5 }],
    attemptedStrategies: [],
    suggestedAction: "apply one registered recovery policy",
  };
}

class FixtureKernel implements RecoveryKernel {
  readonly calls: string[] = [];
  readonly rawHash = "raw-source-hash";
  readonly completedTranslation = "已完成译文";
  readonly oldRun = { runId: "run-old", immutable: true };
  auditOk = true;
  promotedStrategy: RecoveryStrategy | null = null;
  createFailure: Error | null = null;

  async createShadow(
    value: RecoveryIncident,
    strategy: RecoveryStrategy,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<RecoveryShadow> {
    if (this.createFailure !== null) {
      throw this.createFailure;
    }
    this.calls.push(`create:${strategy}`);
    return {
      recoveryId: `recovery-${value.incidentId}`,
      shadowId: `shadow-${value.incidentId}`,
      runId: value.runId,
      beforeHash: "active-before",
      strategy,
      parameters,
    };
  }

  async applyStrategy(shadow: RecoveryShadow): Promise<{
    afterHash: string;
    result: Readonly<Record<string, unknown>>;
  }> {
    this.calls.push(`apply:${shadow.strategy}`);
    return { afterHash: "shadow-after", result: { rebuilt: true } };
  }

  async auditShadow(
    shadow: RecoveryShadow,
    requiredAudits: readonly string[],
  ): Promise<RecoveryAudit> {
    this.calls.push(`audit:${shadow.strategy}`);
    return {
      ok: this.auditOk,
      checks: Object.fromEntries(requiredAudits.map((name) => [name, this.auditOk])),
      incidentCodes: this.auditOk ? [] : ["AUDIT_FAILED"],
    };
  }

  async promoteRecovery(shadow: RecoveryShadow): Promise<void> {
    this.calls.push(`promote:${shadow.strategy}`);
    this.promotedStrategy = shadow.strategy;
  }

  async discardRecovery(shadow: RecoveryShadow, reason: string): Promise<void> {
    this.calls.push(`discard:${shadow.strategy}:${reason}`);
  }

  async quarantineRecovery(value: RecoveryIncident, reason: string): Promise<void> {
    this.calls.push(`quarantine:${value.code}:${reason}`);
  }
}

test("the incident registry has exactly one recovery rule for every incident code", () => {
  assert.deepEqual(
    Object.keys(RECOVERY_RULES).sort(),
    [...INCIDENT_CODES].sort(),
  );
  for (const code of INCIDENT_CODES) {
    const rule = RECOVERY_RULES[code];
    assert.ok(rule);
    assert.ok(rule.maxAttempts === 0 || rule.maxAttempts === 1);
    if (rule.deterministic !== null) {
      assert.ok(rule.allowed.includes(rule.deterministic));
    }
  }
});

test("a source span gap uses flat deterministic rebuild before any Pi call", async () => {
  const kernel = new FixtureKernel();
  let plannerCalls = 0;
  const planner: RecoveryPlanner = {
    plan: async () => {
      plannerCalls += 1;
      throw new Error("deterministic recovery must not call Pi");
    },
  };
  const result = await new RecoveryEngine({ kernel, planner }).recover(
    incident("SOURCE_SPAN_GAP"),
  );

  assert.equal(result.strategy, "flat_partition_rebuild");
  assert.equal(result.status, "resumed");
  assert.equal(result.attempts, 1);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.audit.ok, true);
  assert.equal(plannerCalls, 0);
  assert.deepEqual(kernel.calls, [
    "create:flat_partition_rebuild",
    "apply:flat_partition_rebuild",
    "audit:flat_partition_rebuild",
    "promote:flat_partition_rebuild",
  ]);
});

test("Recovery Pi may choose one registered strategy without mutating protected state", async () => {
  const kernel = new FixtureKernel();
  const before = structuredClone({
    rawHash: kernel.rawHash,
    completedTranslation: kernel.completedTranslation,
    oldRun: kernel.oldRun,
  });
  let plannerCalls = 0;
  const planner: RecoveryPlanner = {
    plan: async ({ rule }) => {
      plannerCalls += 1;
      assert.deepEqual(rule.allowed, [
        "rebuild_window_membership",
        "replan_affected_windows",
      ]);
      return {
        terminal: true,
        strategy: "rebuild_window_membership",
        parameters: {},
        modelCalls: 1,
        toolNames: [
          "inspect_incident",
          "choose_recovery_strategy",
          "submit_recovery_result",
        ],
      };
    },
  };

  const result = await new RecoveryEngine({ kernel, planner }).recover(
    incident("BLOCK_MEMBERSHIP_INVALID"),
  );

  assert.equal(plannerCalls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.status, "resumed");
  assert.equal(result.strategy, "rebuild_window_membership");
  assert.deepEqual({
    rawHash: kernel.rawHash,
    completedTranslation: kernel.completedTranslation,
    oldRun: kernel.oldRun,
  }, before);
});

test("audit failure discards the shadow and quarantines without promotion", async () => {
  const kernel = new FixtureKernel();
  kernel.auditOk = false;
  const result = await new RecoveryEngine({ kernel }).recover(
    incident("RUNNING_AFTER_CRASH"),
  );

  assert.equal(result.status, "quarantined");
  assert.equal(result.audit.ok, false);
  assert.equal(kernel.promotedStrategy, null);
  assert.ok(kernel.calls.some((call) => call.startsWith("discard:")));
  assert.ok(kernel.calls.some((call) => call.startsWith("quarantine:")));
});

test("incidents without an allowed strategy never call a model", async () => {
  const kernel = new FixtureKernel();
  let plannerCalls = 0;
  const result = await new RecoveryEngine({
    kernel,
    planner: {
      plan: async () => {
        plannerCalls += 1;
        throw new Error("model must not start");
      },
    },
  }).recover(incident("ENCODING_AMBIGUOUS"));

  assert.equal(plannerCalls, 0);
  assert.equal(result.status, "quarantined");
  assert.equal(result.attempts, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.strategy, null);
});

test("one non-terminating Recovery Pi response immediately quarantines", async () => {
  const kernel = new FixtureKernel();
  let plannerCalls = 0;
  const result = await new RecoveryEngine({
    kernel,
    planner: {
      plan: async () => {
        plannerCalls += 1;
        return {
          terminal: false,
          parameters: {},
          modelCalls: 1,
          toolNames: ["inspect_incident"],
        };
      },
    },
  }).recover(incident("BLOCK_MEMBERSHIP_INVALID"));

  assert.equal(plannerCalls, 1);
  assert.equal(result.status, "quarantined");
  assert.equal(result.attempts, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(kernel.calls.some((call) => call.startsWith("create:")), false);
});

test("a recorded recovery strategy exhausts the incident instead of starting a new Pi round", async () => {
  const kernel = new FixtureKernel();
  let plannerCalls = 0;
  const value = incident("BLOCK_MEMBERSHIP_INVALID");
  const result = await new RecoveryEngine({
    kernel,
    planner: {
      plan: async () => {
        plannerCalls += 1;
        throw new Error("a second Recovery Pi round must not start");
      },
    },
  }).recover({
    ...value,
    attemptedStrategies: ["rebuild_window_membership"],
  });
  assert.equal(plannerCalls, 0);
  assert.equal(result.status, "quarantined");
  assert.equal(result.attempts, 0);
  assert.match(result.reason ?? "", /no_untried_recovery_strategy/);
});

test("shadow creation and Recovery Pi provider failures become structured quarantine", async () => {
  const createKernel = new FixtureKernel();
  createKernel.createFailure = new Error("shadow store unavailable");
  const createResult = await new RecoveryEngine({ kernel: createKernel }).recover(
    incident("RUNNING_AFTER_CRASH"),
  );
  assert.equal(createResult.status, "quarantined");
  assert.match(createResult.reason ?? "", /shadow store unavailable/);
  assert.ok(createKernel.calls.some((call) => call.startsWith("quarantine:")));

  const plannerKernel = new FixtureKernel();
  const plannerResult = await new RecoveryEngine({
    kernel: plannerKernel,
    planner: { plan: async () => { throw new Error("provider unavailable"); } },
  }).recover(incident("BLOCK_MEMBERSHIP_INVALID"));
  assert.equal(plannerResult.status, "quarantined");
  assert.match(plannerResult.reason ?? "", /provider unavailable/);
  assert.equal(plannerResult.attempts, 1);
  assert.equal(plannerKernel.calls.some((call) => call.startsWith("create:")), false);
});

test("recovery tools expose only read inspections, registered choice, and submit", async () => {
  const value = incident("BLOCK_MEMBERSHIP_INVALID");
  const tools = new RecoveryTools({
    incident: value,
    rule: RECOVERY_RULES[value.code],
    budget: new BudgetLedger(),
  });
  const specs = tools.specs();

  assert.deepEqual(specs.map((spec) => spec.name).sort(), [
    "choose_recovery_strategy",
    "inspect_incident",
    "inspect_source_span",
    "inspect_structure_annotations",
    "submit_recovery_result",
  ]);
  assert.equal(specs.some((spec) => [
    "write_file", "execute_sql", "shell", "bash", "read_file",
  ].includes(spec.name)), false);
  const chooseSchema = JSON.stringify(
    specs.find((spec) => spec.name === "choose_recovery_strategy")?.parameters,
  );
  for (const strategy of RECOVERY_RULES[value.code].allowed) {
    assert.match(chooseSchema, new RegExp(strategy));
  }
  await assert.rejects(
    tools.chooseRecoveryStrategy({ strategy: "flat_partition_rebuild" as RecoveryStrategy }),
    /not allowed/i,
  );
  await tools.chooseRecoveryStrategy({ strategy: "rebuild_window_membership" });
  await assert.rejects(
    tools.submitRecoveryResult({ parameters: { maxWindowBlocks: 12 } }),
    /parameter.*not allowed/i,
  );

  const bounded = new RecoveryTools({
    incident: value,
    rule: RECOVERY_RULES[value.code],
    budget: new BudgetLedger(),
  });
  await bounded.chooseRecoveryStrategy({ strategy: "replan_affected_windows" });
  await assert.rejects(
    bounded.submitRecoveryResult({ parameters: { maxWindowBlocks: 65 } }),
    /maxWindowBlocks.*between 1 and 64/i,
  );
  assert.deepEqual(
    await bounded.submitRecoveryResult({ parameters: { maxWindowBlocks: 12 } }),
    { accepted: true, strategy: "replan_affected_windows" },
  );
});

test("agent prompt and one-turn tools are projected from the same registry rule", async () => {
  const value = incident("BLOCK_MEMBERSHIP_INVALID");
  const prompt = recoveryAgentPrompt(value);
  for (const strategy of RECOVERY_RULES[value.code].allowed) {
    assert.match(prompt, new RegExp(strategy));
  }
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall("choose_recovery_strategy", {
      strategy: "replan_affected_windows",
    }),
    fauxToolCall("submit_recovery_result", {
      parameters: { maxWindowBlocks: 12 },
    }),
  ], { stopReason: "toolUse" })]);
  const agent = new RecoveryAgent(new PiRuntime(), {
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  const outcome = await agent.plan({
    incident: value,
    rule: RECOVERY_RULES[value.code],
  });

  assert.equal(outcome.terminal, true);
  assert.equal(outcome.strategy, "replan_affected_windows");
  assert.deepEqual(outcome.parameters, { maxWindowBlocks: 12 });
  assert.equal(outcome.modelCalls, 1);
  assert.equal(faux.state.callCount, 1);
});
