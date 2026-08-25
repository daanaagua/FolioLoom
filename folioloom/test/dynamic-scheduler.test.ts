import assert from "node:assert/strict";
import test from "node:test";

import {
  DynamicScheduler,
  type DynamicSchedulerOptions,
} from "../src/fullbook/dynamic-scheduler.js";
import { optimizationPolicy } from "../src/fullbook/optimization-policy.js";
import {
  planRollingHorizon,
  type RollingPlannerInput,
  type RollingPlannerResult,
} from "../src/fullbook/rolling-horizon-planner.js";
import { OnlineRuntimeCostModel } from "../src/fullbook/runtime-cost-model.js";
import {
  buildTaskGraph,
  TaskGraphIntegrityError,
} from "../src/fullbook/task-graph.js";
import { assessTaskRisk } from "../src/fullbook/task-risk.js";

const RISK = assessTaskRisk({
  sourceTokens: 100,
  entityMentions: 0,
  pronounMentions: 0,
  relationKinds: [],
  remoteEvidenceDistance: 0,
  lockedTermOccurrences: 0,
  needsRevalidate: false,
  priorRepairs: 0,
  sourceAnomalies: 0,
});

function plannerInput(): RollingPlannerInput {
  const tasks = ["task-a", "task-b"].map((taskId, ordinal) => ({
    taskId,
    type: "translate" as const,
    ordinal,
    dependencyIds: [],
    readResources: [`window:${taskId}`],
    writeResources: [`snapshot:${taskId}`],
    sourceTokens: 100,
    risk: RISK,
  }));
  return {
    graph: buildTaskGraph(tasks),
    completedTaskIds: [],
    running: [],
    variants: tasks.map((task, index) => ({
      variantId: `variant-${task.taskId}`,
      taskId: task.taskId,
      contextProfile: index === 0 ? "lean" as const : "rich" as const,
      effort: index === 0 ? "low" : "high",
      effortRank: index === 0 ? 2 : 4,
      protocol: "typed_tool" as const,
      validators: ["structure"],
      predicted: {
        p50DurationMs: 80,
        p90DurationMs: 100,
        inputTokens: 70,
        outputTokens: 30,
        totalTokens: 100,
        failureProbability: 0.02,
        confidence: 0.8,
      },
    })),
    policy: optimizationPolicy("balanced"),
    runBaselineTotalTokens: 200,
    actualRunTokens: 0,
    runningReservedTokens: 0,
    horizonBaselineTokens: 200,
    maxConcurrency: 2,
    maxInFlightTokens: 1_000,
  };
}

function plannedResult(): RollingPlannerResult {
  return {
    planningStatus: "optimal",
    deadlineReached: false,
    firstDispatch: [{
      taskId: "task-b",
      variantId: "variant-task-b",
    }],
    actions: [{
      actionId: "task-b@variant-task-b",
      startOffsetMs: 0,
      p90DurationMs: 100,
      totalTokens: 100,
      expectedReworkMs: 2,
      dispatch: [{
        taskId: "task-b",
        variantId: "variant-task-b",
      }],
    }],
    objective: 1,
    predictedWallTimeMs: 100,
    predictedTotalTokens: 100,
    predictedExpectedReworkMs: 2,
    allowedTotalTokens: 220,
    horizonTaskIds: ["task-a", "task-b"],
  };
}

function schedulerOptions(
  overrides: Partial<DynamicSchedulerOptions> = {},
): DynamicSchedulerOptions {
  return {
    mode: "shadow",
    profile: "balanced",
    planner: () => plannedResult(),
    costModel: OnlineRuntimeCostModel.coldStart("test:de"),
    ...overrides,
  };
}

test("off mode delegates legacy dispatch without invoking the planner", () => {
  let plannerCalls = 0;
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "off",
    planner: () => {
      plannerCalls += 1;
      return plannedResult();
    },
  }));

  const result = scheduler.dispatch(plannerInput(), {
    legacyTaskIds: ["task-a"],
  });

  assert.equal(plannerCalls, 0);
  assert.equal(result.planningStatus, "disabled");
  assert.deepEqual(result.dispatchedTaskIds, ["task-a"]);
  assert.equal(result.validatorsSkipped, 0);
});

test("shadow mode records a decision but delegates the legacy dispatch", () => {
  const scheduler = new DynamicScheduler(schedulerOptions());

  const result = scheduler.dispatch(plannerInput(), {
    legacyTaskIds: ["task-a"],
  });

  assert.equal(result.planningStatus, "shadow");
  assert.deepEqual(result.dispatchedTaskIds, ["task-a"]);
  assert.deepEqual(result.shadowDecision, plannedResult());
  assert.equal(result.predictedWallTimeMs, 100);
  assert.equal(result.predictedTokens, 100);
  assert.deepEqual(result.contextProfiles, {
    lean: 0,
    balanced: 0,
    rich: 1,
  });
});

test("active mode dispatches the planner first batch", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
  }));

  const result = scheduler.dispatch(plannerInput(), {
    legacyTaskIds: ["task-a"],
  });

  assert.equal(result.planningStatus, "optimal");
  assert.deepEqual(result.dispatchedTaskIds, ["task-b"]);
  assert.equal(result.shadowDecision, undefined);
});

test("active mode never delegates a no-legal-plan result past the token envelope", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: planRollingHorizon,
  }));
  const exhausted = {
    ...plannerInput(),
    actualRunTokens: 220,
  };

  const result = scheduler.dispatch(exhausted, {
    legacyTaskIds: ["task-a", "task-b"],
  });

  assert.equal(result.planningStatus, "fallback");
  assert.equal(result.fallbackReason, "NO_LEGAL_PLAN");
  assert.deepEqual(result.dispatchedTaskIds, []);
  assert.deepEqual(result.dispatchedVariants, []);
  assert.deepEqual(result.contextProfiles, {
    lean: 0,
    balanced: 0,
    rich: 0,
  });
  assert.equal(result.validatorsSkipped, 0);
});

test("active mode does not delegate a cheaper legacy prefix when planned variants have no legal plan", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: planRollingHorizon,
  }));
  const input = plannerInput();
  const expensivePlannedVariants = input.variants.map((variant) => ({
    ...variant,
    predicted: {
      ...variant.predicted,
      totalTokens: 200,
    },
  }));
  const cheaperLegacyVariants = input.variants.map((variant) => ({
    ...variant,
    variantId: `legacy-${variant.taskId}`,
    predicted: {
      ...variant.predicted,
      totalTokens: 100,
    },
  }));

  const result = scheduler.dispatch({
    ...input,
    variants: expensivePlannedVariants,
    actualRunTokens: 70,
  }, {
    legacyTaskIds: ["task-a", "task-b"],
    legacyVariants: cheaperLegacyVariants,
  });

  assert.equal(result.planningStatus, "fallback");
  assert.equal(result.fallbackReason, "NO_LEGAL_PLAN");
  assert.deepEqual(result.dispatchedTaskIds, []);
  assert.deepEqual(result.dispatchedVariants, []);
  assert.equal(result.predictedTokens, 70);
});

test("planner failure falls back without skipping validation", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: () => {
      throw new Error("solver unavailable");
    },
  }));

  const result = scheduler.dispatch(plannerInput(), {
    legacyTaskIds: ["task-a"],
  });

  assert.equal(result.planningStatus, "fallback");
  assert.equal(result.fallbackReason, "PLANNER_FAILED");
  assert.deepEqual(result.dispatchedTaskIds, ["task-a"]);
  assert.equal(result.validatorsSkipped, 0);
});

test("planner failure cannot bypass an exhausted token envelope", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: () => {
      throw new Error("solver unavailable");
    },
  }));

  const result = scheduler.dispatch({
    ...plannerInput(),
    actualRunTokens: 220,
  }, {
    legacyTaskIds: ["task-a"],
  });

  assert.equal(result.planningStatus, "fallback");
  assert.equal(result.fallbackReason, "TOKEN_ENVELOPE_EXHAUSTED");
  assert.deepEqual(result.dispatchedTaskIds, []);
  assert.deepEqual(result.dispatchedVariants, []);
  assert.equal(result.validatorsSkipped, 0);
});

test("token-bounded planner fallback preserves the legacy task prefix", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: () => {
      throw new Error("solver unavailable");
    },
  }));
  const input = plannerInput();

  const result = scheduler.dispatch({
    ...input,
    variants: input.variants.map((variant) => ({
      ...variant,
      predicted: {
        ...variant.predicted,
        totalTokens: variant.taskId === "task-a" ? 200 : 100,
      },
    })),
    actualRunTokens: 70,
  }, {
    legacyTaskIds: ["task-a", "task-b"],
  });

  assert.equal(result.fallbackReason, "TOKEN_ENVELOPE_EXHAUSTED");
  assert.deepEqual(result.dispatchedTaskIds, []);
});

test("planner failure reserves the actual legacy variant rather than a cheaper planned variant", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: () => {
      throw new Error("solver unavailable");
    },
  }));
  const input = plannerInput();
  const planned = input.variants.find((variant) =>
    variant.taskId === "task-a")!;

  const result = scheduler.dispatch({
    ...input,
    actualRunTokens: 70,
  }, {
    legacyTaskIds: ["task-a"],
    legacyVariants: [{
      ...planned,
      variantId: "legacy-task-a",
      predicted: {
        ...planned.predicted,
        totalTokens: 200,
      },
    }],
  });

  assert.equal(result.fallbackReason, "TOKEN_ENVELOPE_EXHAUSTED");
  assert.deepEqual(result.dispatchedTaskIds, []);
});

test("shadow mode preserves legacy dispatch when planner failure exhausts its estimate", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "shadow",
    planner: () => {
      throw new Error("solver unavailable");
    },
  }));

  const result = scheduler.dispatch({
    ...plannerInput(),
    actualRunTokens: 220,
  }, {
    legacyTaskIds: ["task-a"],
  });

  assert.equal(result.planningStatus, "fallback");
  assert.equal(result.fallbackReason, "PLANNER_FAILED");
  assert.deepEqual(result.dispatchedTaskIds, ["task-a"]);
  assert.equal(result.validatorsSkipped, 0);
});

test("task graph integrity errors remain fatal", () => {
  const scheduler = new DynamicScheduler(schedulerOptions({
    mode: "active",
    planner: () => {
      throw new TaskGraphIntegrityError("cycle");
    },
  }));

  assert.throws(
    () => scheduler.dispatch(plannerInput(), {
      legacyTaskIds: ["task-a"],
    }),
    TaskGraphIntegrityError,
  );
});
