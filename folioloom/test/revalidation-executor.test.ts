import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { ModelProviderError } from "../src/agents/pi-runtime.js";
import { BudgetExceeded } from "../src/kernel/budget.js";
import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import {
  executeRevalidationTasks,
  planRevalidationTasks,
  type RevalidationExecutionStore,
} from "../src/fullbook/revalidation-executor.js";
import type {
  KnowledgeRevalidationTask,
  RevalidationWorkItem,
} from "../src/storage/lossless-book-store.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface FixtureTask {
  readonly taskId: string;
  readonly conceptId: string;
  readonly translationId: number;
}

function fixtureStore(
  definitions: readonly FixtureTask[],
): {
  readonly store: RevalidationExecutionStore;
  readonly deferred: string[];
  readonly replacements: string[];
  readonly task: (taskId: string) => KnowledgeRevalidationTask;
  readonly warnings: string[];
} {
  const conceptsByTaskId = new Map(definitions.map((definition) => {
    const applied = conceptFromAnchor({
      sourceForm: `term-${definition.conceptId}`,
      target: "旧译名",
      mode: "contextual",
      semanticClass: "role",
      confidence: 1,
    });
    return [definition.taskId, {
      applied,
      current: reviseConcept(applied, {
        canonicalTarget: "新译名",
        allowedRealizations: ["新译名"],
        policy: "locked",
      }),
    }] as const;
  }));
  const tasks = new Map<string, KnowledgeRevalidationTask>(
    definitions.map((definition) => [definition.taskId, {
      taskId: definition.taskId,
      runId: "run-0",
      translationId: definition.translationId,
      blockId: `block-${definition.translationId}`,
      changeSetHash: "a".repeat(64),
      fromSnapshotId: "snapshot-old",
      toSnapshotId: "snapshot-new",
      conceptIds: [conceptsByTaskId.get(definition.taskId)!.applied.conceptId],
      status: "pending",
      attempts: 0,
      result: {},
      replacementTranslationId: null,
    }]),
  );
  const replacements: string[] = [];
  const deferredTasks: string[] = [];
  const warnings: string[] = [];

  function workItem(task: KnowledgeRevalidationTask): RevalidationWorkItem {
    const definition = definitions.find((item) => item.taskId === task.taskId)!;
    const { applied, current } = conceptsByTaskId.get(task.taskId)!;
    return {
      task,
      translation: {
        translationId: task.translationId,
        runId: task.runId,
        windowId: `window-${task.translationId}`,
        blockId: task.blockId,
        sourceVersion: "source-0",
        sourceHash: "source-hash",
        text: "旧译名",
        status: "completed",
        version: 1,
        snapshotId: "snapshot-old",
      },
      source: {
        blockId: task.blockId,
        sourceVersion: "source-0",
        sourceHash: "source-hash",
        sourceText: `term-${definition.conceptId}`,
        globalIndex: task.translationId,
        tokenCount: 10,
      },
      window: {
        windowId: `window-${task.translationId}`,
        ordinal: task.translationId,
        chapterId: "chapter-0",
        chapterTitle: "One",
        blockIds: [task.blockId],
        globalIndexes: [task.translationId],
        sourceTokens: 10,
        sourceChars: 10,
        oversized: false,
        status: "completed",
        attemptCount: 1,
        snapshotId: "snapshot-old",
        budget: {},
        warnings: [],
        lastError: "",
      },
      concepts: [{
        conceptId: task.conceptIds[0]!,
        appliedConcept: { ...applied, revision: 1 },
        currentConcept: { ...current, revision: 2 },
        termUsages: [{
          occurrenceId: `occurrence-${task.taskId}`,
          blockId: task.blockId,
          conceptId: task.conceptIds[0]!,
          sourceForm: `term-${definition.conceptId}`,
          sourceStart: 0,
          sourceEnd: `term-${definition.conceptId}`.length,
          discourseRole: "narrative",
          targetSurface: "旧译名",
        }],
      }],
    };
  }

  const store: RevalidationExecutionStore = {
    revalidationTasks() {
      return [...tasks.values()].map((task) => ({ ...task }));
    },
    claimRevalidationTask(_runId, taskId, maxAttempts, expectedAttempts) {
      const task = tasks.get(taskId);
      if (task === undefined
        || (task.status !== "pending" && task.status !== "validating")
        || task.attempts >= maxAttempts
        || task.attempts !== expectedAttempts) {
        return undefined;
      }
      const claimed: KnowledgeRevalidationTask = {
        ...task,
        status: "validating",
        attempts: task.attempts + 1,
      };
      tasks.set(taskId, claimed);
      return { ...claimed };
    },
    revalidationWorkItem(_runId, taskId) {
      return workItem(tasks.get(taskId)!);
    },
    resolveRevalidationNoop(_runId, taskId) {
      const task = tasks.get(taskId)!;
      tasks.set(taskId, { ...task, status: "resolved_noop" });
    },
    replaceTranslationForRevalidation(input) {
      replacements.push(input.taskId);
      const task = tasks.get(input.taskId)!;
      tasks.set(input.taskId, {
        ...task,
        status: input.action === "repair"
          ? "resolved_repair"
          : "resolved_retranslate",
      });
      return task.translationId + 100;
    },
    deferRevalidationTask(_runId, taskId) {
      deferredTasks.push(taskId);
      const task = tasks.get(taskId)!;
      tasks.set(taskId, {
        ...task,
        status: "pending",
        attempts: task.attempts - 1,
      });
    },
    completeRevalidationWithWarning(_runId, taskId) {
      warnings.push(taskId);
      const task = tasks.get(taskId)!;
      tasks.set(taskId, { ...task, status: "completed_with_warning" });
    },
  };
  return {
    store,
    deferred: deferredTasks,
    replacements,
    task: (taskId: string) => ({ ...tasks.get(taskId)! }),
    warnings,
  };
}

function replacement(work: RevalidationWorkItem) {
  return {
    snapshotId: "snapshot-new",
    text: "新译名",
    resultStatus: "completed" as const,
    termUsages: [],
    concepts: work.concepts.map((concept) => concept.currentConcept),
    result: { fixture: true },
  };
}

test("independent revalidation tasks overlap in active mode", async () => {
  const fixture = fixtureStore([
    { taskId: "task-a", conceptId: "concept-a", translationId: 1 },
    { taskId: "task-b", conceptId: "concept-b", translationId: 2 },
  ]);
  const gate = deferred<void>();
  const started: string[] = [];

  const run = executeRevalidationTasks({
    store: fixture.store,
    runId: "run-0",
    maxAttempts: 1,
    maxConcurrency: 2,
    maxInFlightTokens: 100,
    translate: async (work) => {
      started.push(work.task.taskId);
      if (started.length === 2) gate.resolve();
      await gate.promise;
      return replacement(work);
    },
    isExpectedFailure: () => false,
  });

  await gate.promise;
  assert.deepEqual(started.sort(), ["task-a", "task-b"]);
  const report = await run;
  assert.equal(report.maximumObservedConcurrency, 2);
});

test("same concept revalidation tasks never overlap", async () => {
  const fixture = fixtureStore([
    { taskId: "task-a", conceptId: "concept-shared", translationId: 1 },
    { taskId: "task-b", conceptId: "concept-shared", translationId: 2 },
  ]);
  let active = 0;
  let maximum = 0;

  const report = await executeRevalidationTasks({
    store: fixture.store,
    runId: "run-0",
    maxAttempts: 1,
    maxConcurrency: 2,
    maxInFlightTokens: 100,
    translate: async (work) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return replacement(work);
    },
    isExpectedFailure: () => false,
  });

  assert.equal(maximum, 1);
  assert.equal(report.maximumObservedConcurrency, 1);
});

test("one warning does not roll back an unrelated successful replacement", async () => {
  const fixture = fixtureStore([
    { taskId: "task-a", conceptId: "concept-a", translationId: 1 },
    { taskId: "task-b", conceptId: "concept-b", translationId: 2 },
  ]);

  const report = await executeRevalidationTasks({
    store: fixture.store,
    runId: "run-0",
    maxAttempts: 1,
    maxConcurrency: 2,
    maxInFlightTokens: 100,
    translate: async (work) => {
      if (work.task.taskId === "task-b") {
        throw new BudgetExceeded("modelCalls", 1, 2);
      }
      return replacement(work);
    },
    isExpectedFailure: (error) => error instanceof BudgetExceeded,
  });

  assert.equal(report.retranslated, 1);
  assert.equal(report.warning, 1);
  assert.deepEqual(fixture.replacements, ["task-a"]);
  assert.deepEqual(fixture.warnings, ["task-b"]);
});

test("retryable provider failure defers the task and aborts the revalidation wave", async () => {
  const fixture = fixtureStore([
    { taskId: "task-a", conceptId: "concept-a", translationId: 1 },
    { taskId: "task-b", conceptId: "concept-b", translationId: 2 },
  ]);
  let calls = 0;

  await assert.rejects(executeRevalidationTasks({
    store: fixture.store,
    runId: "run-0",
    maxAttempts: 2,
    maxConcurrency: 1,
    maxInFlightTokens: 100,
    translate: async () => {
      calls += 1;
      throw new ModelProviderError(
        "model provider error: Connection error.",
        "busy",
        true,
      );
    },
    isExpectedFailure: (error) => error instanceof ModelProviderError,
    isRunBlockingFailure: (error) =>
      error instanceof ModelProviderError && error.retryable,
  }), /Connection error/u);

  assert.equal(calls, 1);
  assert.deepEqual(fixture.deferred, ["task-a"]);
  assert.deepEqual(fixture.warnings, []);
  assert.equal(fixture.task("task-a").status, "pending");
  assert.equal(fixture.task("task-a").attempts, 0);
  assert.equal(fixture.task("task-b").status, "pending");
});

test("revalidation planner failure falls back to validated serial execution", async () => {
  const fixture = fixtureStore([
    { taskId: "task-a", conceptId: "concept-a", translationId: 1 },
    { taskId: "task-b", conceptId: "concept-b", translationId: 2 },
  ]);

  const report = await executeRevalidationTasks({
    store: fixture.store,
    runId: "run-0",
    maxAttempts: 1,
    maxConcurrency: 2,
    maxInFlightTokens: 100,
    planner: () => {
      throw new Error("planner unavailable");
    },
    translate: async (work) => replacement(work),
    isExpectedFailure: () => false,
  });

  assert.equal(report.retranslated, 2);
  assert.deepEqual(fixture.replacements, ["task-a", "task-b"]);
  assert.equal(report.maximumObservedConcurrency, 1);
});

test("Kafka scheduler replay beats half the serial baseline within the speed token envelope", () => {
  const replay = JSON.parse(readFileSync(join(
    import.meta.dirname,
    "fixtures",
    "scheduler",
    "kafka-revalidation.json",
  ), "utf8")) as {
    schema: string;
    tasks: Array<{
      id: string;
      durationMs: number;
      totalTokens: number;
      risk: number;
    }>;
    serialBaselineMs: number;
    maxConcurrency: number;
  };
  assert.equal(replay.schema, "folioloom-scheduler-replay-1");
  const tasks: KnowledgeRevalidationTask[] = replay.tasks.map((task, index) => ({
    taskId: task.id,
    runId: "replay",
    translationId: index + 1,
    blockId: `block-${task.id}`,
    changeSetHash: "a".repeat(64),
    fromSnapshotId: "snapshot-old",
    toSnapshotId: "snapshot-new",
    conceptIds: [`concept-${task.id}`],
    status: "pending",
    attempts: 0,
    result: {},
    replacementTranslationId: null,
  }));
  const byId = new Map(replay.tasks.map((task) => [task.id, task]));
  const baselineTokens = replay.tasks.reduce(
    (total, task) => total + task.totalTokens,
    0,
  );

  const planningStartedAt = performance.now();
  const { result } = planRevalidationTasks(tasks, {
    profile: "speed",
    maxConcurrency: replay.maxConcurrency,
    maxInFlightTokens: Math.floor(baselineTokens * 1.2),
    reservedTokensForTask: (task) => byId.get(task.taskId)!.totalTokens,
    predictionForTask: (task) => {
      const fixture = byId.get(task.taskId)!;
      return {
        p50DurationMs: fixture.durationMs,
        p90DurationMs: fixture.durationMs,
        inputTokens: fixture.totalTokens,
        outputTokens: 0,
        totalTokens: fixture.totalTokens,
        failureProbability: fixture.risk,
        confidence: 1,
      };
    },
  });
  const planningWallTimeMs = performance.now() - planningStartedAt;

  assert.ok(result.predictedWallTimeMs <= 246_000);
  assert.ok(result.predictedWallTimeMs < replay.serialBaselineMs / 2);
  assert.equal(result.horizonTaskIds.length, 5);
  const plannedTaskIds = result.actions.flatMap((action) =>
    action.dispatch.map((dispatch) => dispatch.taskId));
  assert.deepEqual(
    [...new Set(plannedTaskIds)].sort(),
    tasks.map((task) => task.taskId).sort(),
  );
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  for (const action of result.actions) {
    const writeResources = action.dispatch.flatMap((dispatch) => {
      const task = taskById.get(dispatch.taskId)!;
      return [
        `window:translation-${task.translationId}`,
        ...task.conceptIds.map((conceptId) => `concept:${conceptId}`),
      ];
    });
    assert.equal(
      new Set(writeResources).size,
      writeResources.length,
      `resource conflict in ${action.actionId}`,
    );
  }
  assert.ok(result.predictedTotalTokens <= result.allowedTotalTokens);
  assert.equal(result.allowedTotalTokens, Math.floor(baselineTokens * 1.2));
  assert.ok(planningWallTimeMs < 50, `planning took ${planningWallTimeMs} ms`);
});
