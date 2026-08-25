import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskGraph,
  TaskGraphIntegrityError,
  type SchedulerTask,
} from "../src/fullbook/task-graph.js";
import { assessTaskRisk } from "../src/fullbook/task-risk.js";

const LOW_RISK = assessTaskRisk({
  sourceTokens: 120,
  entityMentions: 0,
  pronounMentions: 0,
  relationKinds: [],
  remoteEvidenceDistance: 0,
  lockedTermOccurrences: 0,
  needsRevalidate: false,
  priorRepairs: 0,
  sourceAnomalies: 0,
});

function schedulerTask(
  taskId: string,
  ordinal: number,
  options: {
    readonly dependencies?: readonly string[];
    readonly reads?: readonly string[];
    readonly writes?: readonly string[];
  } = {},
): SchedulerTask {
  return {
    taskId,
    type: "revalidate",
    ordinal,
    dependencyIds: options.dependencies ?? [],
    readResources: options.reads ?? [`window:${taskId}`],
    writeResources: options.writes ?? [`snapshot:${taskId}`],
    sourceTokens: 120,
    risk: LOW_RISK,
  };
}

test("independent revalidation tasks are ready together", () => {
  const graph = buildTaskGraph([
    schedulerTask("a", 0, {
      reads: ["window:a"],
      writes: ["concept:a"],
    }),
    schedulerTask("b", 1, {
      reads: ["window:b"],
      writes: ["concept:b"],
    }),
  ]);

  assert.deepEqual(graph.readyTaskIds([]), ["a", "b"]);
});

test("same concept writes create an ordering edge", () => {
  const graph = buildTaskGraph([
    schedulerTask("b", 1, { writes: ["concept:x"] }),
    schedulerTask("a", 0, { writes: ["concept:x"] }),
  ]);

  assert.deepEqual(graph.readyTaskIds([]), ["a"]);
  assert.deepEqual(graph.readyTaskIds(["a"]), ["b"]);
  assert.equal(graph.tasksCompatible("a", "b"), false);
});

test("write-read conflicts order tasks while shared reads remain compatible", () => {
  const graph = buildTaskGraph([
    schedulerTask("writer", 0, {
      reads: [],
      writes: ["snapshot:shared"],
    }),
    schedulerTask("reader", 1, {
      reads: ["snapshot:shared"],
      writes: [],
    }),
    schedulerTask("other-reader", 2, {
      reads: ["window:shared"],
      writes: [],
    }),
    schedulerTask("second-reader", 3, {
      reads: ["window:shared"],
      writes: [],
    }),
  ]);

  assert.deepEqual(graph.readyTaskIds([]), [
    "writer",
    "other-reader",
    "second-reader",
  ]);
  assert.equal(graph.tasksCompatible("writer", "reader"), false);
  assert.equal(
    graph.tasksCompatible("other-reader", "second-reader"),
    true,
  );
  assert.deepEqual(graph.predecessorTaskIds("reader"), ["writer"]);
});

test("explicit ancestors are incompatible without a shared resource", () => {
  const graph = buildTaskGraph([
    schedulerTask("first", 0, { reads: [], writes: [] }),
    schedulerTask("second", 1, {
      dependencies: ["first"],
      reads: [],
      writes: [],
    }),
  ]);

  assert.equal(graph.tasksCompatible("first", "second"), false);
  assert.deepEqual(graph.readyTaskIds([]), ["first"]);
});

test("horizon follows the critical path and includes newly unlocked tasks", () => {
  const graph = buildTaskGraph([
    schedulerTask("short", 4, { reads: [], writes: [] }),
    schedulerTask("chain-a", 1, { reads: [], writes: [] }),
    schedulerTask("chain-b", 2, {
      dependencies: ["chain-a"],
      reads: [],
      writes: [],
    }),
    schedulerTask("chain-c", 3, {
      dependencies: ["chain-b"],
      reads: [],
      writes: [],
    }),
  ]);

  assert.deepEqual(
    graph.horizon([], 3).map((task) => task.taskId),
    ["chain-a", "chain-b", "chain-c"],
  );
});

test("task graph ordering is deterministic across input order", () => {
  const tasks = [
    schedulerTask("c", 1, { reads: [], writes: [] }),
    schedulerTask("a", 0, { reads: [], writes: [] }),
    schedulerTask("b", 1, { reads: [], writes: [] }),
  ];

  assert.deepEqual(
    buildTaskGraph(tasks).tasks.map((task) => task.taskId),
    buildTaskGraph([...tasks].reverse()).tasks.map((task) => task.taskId),
  );
  assert.deepEqual(buildTaskGraph(tasks).readyTaskIds([]), ["a", "b", "c"]);
});

test("cycles and missing dependencies are integrity incidents", () => {
  assert.throws(
    () => buildTaskGraph([
      schedulerTask("a", 0, {
        dependencies: ["b"],
        reads: [],
        writes: [],
      }),
      schedulerTask("b", 1, {
        dependencies: ["a"],
        reads: [],
        writes: [],
      }),
    ]),
    (error: unknown) => error instanceof TaskGraphIntegrityError
      && /TASK_GRAPH_INVALID.*a.*b/u.test(error.message),
  );
  assert.throws(
    () => buildTaskGraph([
      schedulerTask("a", 0, {
        dependencies: ["missing"],
        reads: [],
        writes: [],
      }),
    ]),
    /TASK_GRAPH_INVALID.*missing/u,
  );
});

test("reverse explicit dependencies cannot bypass stable conflict ordering", () => {
  assert.throws(
    () => buildTaskGraph([
      schedulerTask("early", 0, {
        dependencies: ["late"],
        writes: ["concept:x"],
      }),
      schedulerTask("late", 1, { writes: ["concept:x"] }),
    ]),
    /TASK_GRAPH_INVALID.*early.*late/u,
  );
});

test("invalid task ids, duplicate ids, and malformed resource keys are rejected", () => {
  assert.throws(
    () => buildTaskGraph([
      schedulerTask("duplicate", 0),
      schedulerTask("duplicate", 1),
    ]),
    /TASK_GRAPH_INVALID.*duplicate/u,
  );
  assert.throws(
    () => buildTaskGraph([
      schedulerTask("bad-resource", 0, { reads: ["entity:x"] }),
    ]),
    /TASK_GRAPH_INVALID.*resource/u,
  );
  assert.throws(
    () => buildTaskGraph([
      schedulerTask("", 0),
    ]),
    /TASK_GRAPH_INVALID.*taskId/u,
  );
});
