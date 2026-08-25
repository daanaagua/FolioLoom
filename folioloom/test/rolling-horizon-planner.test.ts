import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { optimizationPolicy } from "../src/fullbook/optimization-policy.js";
import {
  planRollingHorizon,
  type RollingPlannerInput,
  type TaskExecutionVariant,
} from "../src/fullbook/rolling-horizon-planner.js";
import {
  buildTaskGraph,
  type SchedulerTask,
} from "../src/fullbook/task-graph.js";
import { assessTaskRisk } from "../src/fullbook/task-risk.js";

const LOW_RISK = assessTaskRisk({
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

function task(
  taskId: string,
  ordinal: number,
  dependencyIds: readonly string[] = [],
  risk = LOW_RISK,
): SchedulerTask {
  return {
    taskId,
    type: "translate",
    ordinal,
    dependencyIds,
    readResources: [`window:${taskId}`],
    writeResources: [`snapshot:${taskId}`],
    sourceTokens: 100,
    risk,
  };
}

function variant(
  taskId: string,
  variantId: string,
  options: {
    readonly duration?: number;
    readonly tokens?: number;
    readonly failure?: number;
    readonly context?: "lean" | "balanced" | "rich";
    readonly effort?: string;
    readonly effortRank?: number;
    readonly validators?: readonly string[];
  } = {},
): TaskExecutionVariant {
  const duration = options.duration ?? 100;
  const tokens = options.tokens ?? 100;
  return {
    variantId,
    taskId,
    contextProfile: options.context ?? "lean",
    effort: options.effort ?? "low",
    effortRank: options.effortRank ?? 2,
    protocol: "typed_tool",
    validators: options.validators ?? ["structure"],
    predicted: {
      p50DurationMs: Math.floor(duration * 0.8),
      p90DurationMs: duration,
      inputTokens: Math.floor(tokens * 0.7),
      outputTokens: tokens - Math.floor(tokens * 0.7),
      totalTokens: tokens,
      failureProbability: options.failure ?? 0.02,
      confidence: 0.8,
    },
  };
}

function plannerFixture(
  taskCount: number,
  profile: "economy" | "balanced" | "speed" = "balanced",
): RollingPlannerInput {
  const tasks = Array.from({ length: taskCount }, (_, index) =>
    task(`task-${String(index).padStart(2, "0")}`, index));
  const variants = tasks.map((item, index) =>
    variant(item.taskId, `variant-${item.taskId}`, {
      duration: 80 + (index % 4) * 20,
      tokens: 100,
      failure: (index % 3) * 0.01,
    }));
  return {
    graph: buildTaskGraph(tasks),
    completedTaskIds: [],
    running: [],
    variants,
    policy: optimizationPolicy(profile),
    runBaselineTotalTokens: taskCount * 100,
    actualRunTokens: 0,
    runningReservedTokens: 0,
    horizonBaselineTokens: taskCount * 100,
    maxConcurrency: 2,
    maxInFlightTokens: 10_000,
  };
}

interface BruteLabel {
  readonly elapsedMs: number;
  readonly tokens: number;
  readonly reworkMs: number;
  readonly actions: readonly {
    readonly id: string;
    readonly dispatch: readonly { taskId: string; variantId: string }[];
  }[];
}

function bruteForceSchedule(input: RollingPlannerInput): {
  readonly objective: number;
  readonly firstDispatch: readonly { taskId: string; variantId: string }[];
} {
  const tasks = input.graph.tasks;
  const indexById = new Map(tasks.map((item, index) => [item.taskId, index]));
  const variantByTask = new Map(
    input.variants.map((item) => [item.taskId, item]),
  );
  const fullMask = (1 << tasks.length) - 1;
  const baselineWallTimeMs = tasks.reduce(
    (total, item) =>
      total + variantByTask.get(item.taskId)!.predicted.p90DurationMs,
    0,
  );
  const memo = new Map<number, BruteLabel>();

  function objective(label: BruteLabel): number {
    return input.policy.objectiveWeights.time
      * (label.elapsedMs / Math.max(1, baselineWallTimeMs))
      + input.policy.objectiveWeights.tokens
        * (label.tokens / Math.max(1, input.horizonBaselineTokens))
      + input.policy.objectiveWeights.rework
        * (label.reworkMs / Math.max(1, baselineWallTimeMs));
  }

  function actionKey(actions: BruteLabel["actions"]): string {
    return actions.map((action) => action.id).join("|");
  }

  function better(left: BruteLabel, right: BruteLabel | undefined): boolean {
    if (right === undefined) return true;
    return objective(left) < objective(right)
      || (objective(left) === objective(right)
        && (left.tokens < right.tokens
          || (left.tokens === right.tokens
            && actionKey(left.actions) < actionKey(right.actions))));
  }

  function solve(mask: number): BruteLabel {
    if (mask === fullMask) {
      return { elapsedMs: 0, tokens: 0, reworkMs: 0, actions: [] };
    }
    const cached = memo.get(mask);
    if (cached !== undefined) return cached;
    const ready = tasks.filter((item) => {
      const bit = 1 << indexById.get(item.taskId)!;
      return (mask & bit) === 0
        && item.dependencyIds.every((dependencyId) =>
          (mask & (1 << indexById.get(dependencyId)!)) !== 0);
    });
    const batches: SchedulerTask[][] = ready.map((item) => [item]);
    for (let left = 0; left < ready.length; left += 1) {
      for (let right = left + 1; right < ready.length; right += 1) {
        if (input.graph.tasksCompatible(
          ready[left]!.taskId,
          ready[right]!.taskId,
        )) {
          batches.push([ready[left]!, ready[right]!]);
        }
      }
    }
    let best: BruteLabel | undefined;
    for (const batch of batches) {
      const selected = batch.map((item) => variantByTask.get(item.taskId)!);
      const nextMask = batch.reduce(
        (value, item) => value | (1 << indexById.get(item.taskId)!),
        mask,
      );
      const suffix = solve(nextMask);
      const dispatch = selected
        .map((item) => ({ taskId: item.taskId, variantId: item.variantId }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId, "en"));
      const batchId = dispatch
        .map((item) => `${item.taskId}@${item.variantId}`)
        .join("+");
      const candidate: BruteLabel = {
        elapsedMs: Math.max(
          ...selected.map((item) => item.predicted.p90DurationMs),
        ) + suffix.elapsedMs,
        tokens: selected.reduce(
          (total, item) => total + item.predicted.totalTokens,
          suffix.tokens,
        ),
        reworkMs: selected.reduce(
          (total, item) =>
            total + item.predicted.failureProbability
              * item.predicted.p90DurationMs,
          suffix.reworkMs,
        ),
        actions: [{ id: batchId, dispatch }, ...suffix.actions],
      };
      if (better(candidate, best)) best = candidate;
    }
    assert.ok(best);
    memo.set(mask, best);
    return best;
  }

  const best = solve(0);
  return {
    objective: objective(best),
    firstDispatch: best.actions[0]?.dispatch ?? [],
  };
}

test("subset planner matches brute force for eight tasks", () => {
  const input = plannerFixture(8);
  const expected = bruteForceSchedule(input);
  const actual = planRollingHorizon(input);

  assert.equal(actual.objective, expected.objective);
  assert.deepEqual(actual.firstDispatch, expected.firstDispatch);
});

test("speed mode never exceeds its cumulative token envelope", () => {
  const tasks = [task("a", 0), task("b", 1), task("c", 2)];
  const input: RollingPlannerInput = {
    ...plannerFixture(3, "speed"),
    graph: buildTaskGraph(tasks),
    variants: tasks.flatMap((item) => [
      variant(item.taskId, `fast-${item.taskId}`, {
        duration: 20,
        tokens: 150,
      }),
      variant(item.taskId, `safe-${item.taskId}`, {
        duration: 100,
        tokens: 100,
      }),
    ]),
    runBaselineTotalTokens: 300,
    horizonBaselineTokens: 300,
  };

  const result = planRollingHorizon(input);

  assert.ok(result.predictedTotalTokens <= result.allowedTotalTokens);
  assert.equal(result.allowedTotalTokens, 360);
});

test("risk gates remove lean effort and missing-validator variants", () => {
  const highRisk = assessTaskRisk({
    sourceTokens: 300,
    entityMentions: 2,
    pronounMentions: 0,
    relationKinds: ["control"],
    remoteEvidenceDistance: 10,
    lockedTermOccurrences: 1,
    needsRevalidate: false,
    priorRepairs: 0,
    sourceAnomalies: 0,
  });
  const riskyTask = task("risky", 0, [], highRisk);
  const input: RollingPlannerInput = {
    ...plannerFixture(1),
    graph: buildTaskGraph([riskyTask]),
    variants: [
      variant("risky", "invalid-attractive", {
        duration: 1,
        tokens: 1,
        context: "lean",
        effortRank: 2,
        validators: ["structure"],
      }),
      variant("risky", "valid-rich", {
        duration: 100,
        tokens: 100,
        context: "rich",
        effort: "high",
        effortRank: 4,
        validators: [
          "structure",
          "terminology",
          "cross_block",
          "knowledge_coverage",
        ],
      }),
    ],
  };

  assert.deepEqual(planRollingHorizon(input).firstDispatch, [{
    taskId: "risky",
    variantId: "valid-rich",
  }]);
});

test("running reservations keep their slots and unlock successors by event", () => {
  const tasks = [
    task("running", 0),
    task("independent", 1),
    task("successor", 2, ["running"]),
  ];
  const input: RollingPlannerInput = {
    ...plannerFixture(3),
    graph: buildTaskGraph(tasks),
    running: [{
      taskId: "running",
      variantId: "running-variant",
      remainingP90DurationMs: 60,
      reservedTokens: 90,
    }],
    variants: [
      variant("independent", "independent-variant", {
        duration: 100,
        tokens: 100,
      }),
      variant("successor", "successor-variant", {
        duration: 50,
        tokens: 100,
      }),
    ],
    runningReservedTokens: 90,
    maxConcurrency: 2,
    maxInFlightTokens: 200,
    runBaselineTotalTokens: 400,
  };

  const result = planRollingHorizon(input);

  assert.deepEqual(result.firstDispatch, [{
    taskId: "independent",
    variantId: "independent-variant",
  }]);
  assert.ok(result.actions.some((action) =>
    action.dispatch.some((item) => item.taskId === "successor")
    && action.startOffsetMs === 60));
  assert.equal(result.predictedWallTimeMs, 110);
});

test("a full initial reservation produces no immediate dispatch", () => {
  const tasks = [task("running", 0), task("after", 1, ["running"])];
  const input: RollingPlannerInput = {
    ...plannerFixture(2),
    graph: buildTaskGraph(tasks),
    running: [{
      taskId: "running",
      variantId: "running-variant",
      remainingP90DurationMs: 25,
      reservedTokens: 50,
    }],
    variants: [variant("after", "after-variant")],
    runningReservedTokens: 50,
    maxConcurrency: 1,
    runBaselineTotalTokens: 250,
  };

  const result = planRollingHorizon(input);

  assert.deepEqual(result.firstDispatch, []);
  assert.equal(result.actions[0]?.startOffsetMs, 25);
});

test("planner output is deterministic", () => {
  const fixture = plannerFixture(12);
  assert.deepEqual(
    planRollingHorizon(fixture),
    planRollingHorizon({
      ...fixture,
      variants: [...fixture.variants].reverse(),
    }),
  );
});

test("horizon planning reads direct edges without rescanning the full frontier", () => {
  const tasks = Array.from({ length: 12 }, (_, index) =>
    task(`edge-${index}`, index, index === 0 ? [] : [`edge-${index - 1}`]));
  const baseGraph = buildTaskGraph(tasks);
  let readyScans = 0;
  const graph = {
    ...baseGraph,
    readyTaskIds(completedTaskIds: readonly string[]) {
      readyScans += 1;
      return baseGraph.readyTaskIds(completedTaskIds);
    },
  };
  const fixture = plannerFixture(12);

  planRollingHorizon({
    ...fixture,
    graph,
    variants: tasks.map((item) =>
      variant(item.taskId, `variant-${item.taskId}`)),
  });

  assert.equal(readyScans, 0);
});

test("deadline returns a bounded feasible first action", () => {
  let tick = 0;
  const fixture = plannerFixture(12);
  const result = planRollingHorizon({
    ...fixture,
    policy: {
      ...fixture.policy,
      planningDeadlineMs: 1,
    },
    clock: () => {
      tick += 10;
      return tick;
    },
  });

  assert.equal(result.planningStatus, "bounded");
  assert.equal(result.deadlineReached, true);
  assert.ok(result.firstDispatch.length > 0);
});

test("no legal hard-gated variant returns fallback", () => {
  const highRisk = assessTaskRisk({
    sourceTokens: 100,
    entityMentions: 2,
    pronounMentions: 0,
    relationKinds: ["timeline"],
    remoteEvidenceDistance: 0,
    lockedTermOccurrences: 0,
    needsRevalidate: false,
    priorRepairs: 0,
    sourceAnomalies: 0,
  });
  const onlyTask = task("only", 0, [], highRisk);
  const fixture = plannerFixture(1);
  const result = planRollingHorizon({
    ...fixture,
    graph: buildTaskGraph([onlyTask]),
    variants: [variant("only", "too-lean")],
  });

  assert.equal(result.planningStatus, "fallback");
  assert.deepEqual(result.firstDispatch, []);
});

test("a legal first action remains bounded when a later task has no variant", () => {
  const highRisk = assessTaskRisk({
    sourceTokens: 100,
    entityMentions: 2,
    pronounMentions: 0,
    relationKinds: ["timeline"],
    remoteEvidenceDistance: 0,
    lockedTermOccurrences: 0,
    needsRevalidate: false,
    priorRepairs: 0,
    sourceAnomalies: 0,
  });
  const tasks = [
    task("legal", 0),
    task("blocked", 1, [], highRisk),
  ];
  const fixture = plannerFixture(2);
  const result = planRollingHorizon({
    ...fixture,
    graph: buildTaskGraph(tasks),
    variants: [
      variant("legal", "legal-variant"),
      variant("blocked", "blocked-lean"),
    ],
  });

  assert.equal(result.planningStatus, "bounded");
  assert.equal(result.deadlineReached, false);
  assert.deepEqual(result.firstDispatch, [{
    taskId: "legal",
    variantId: "legal-variant",
  }]);
});

test("twelve-task planning stays below fifty milliseconds", () => {
  const fixture = plannerFixture(12);
  planRollingHorizon(fixture);
  const started = performance.now();
  planRollingHorizon(fixture);
  assert.ok(performance.now() - started < 50);
});

test("sixteen-task planning stays below two hundred fifty milliseconds", () => {
  const fixture = plannerFixture(16, "speed");
  planRollingHorizon(fixture);
  const started = performance.now();
  planRollingHorizon(fixture);
  assert.ok(performance.now() - started < 250);
});
