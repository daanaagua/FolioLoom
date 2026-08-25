import type { TaskRiskAssessment } from "./task-risk.js";

export type SchedulerTaskType =
  | "translate"
  | "lexical_anchor"
  | "revalidate"
  | "validate";

export interface SchedulerTask {
  readonly taskId: string;
  readonly type: SchedulerTaskType;
  readonly ordinal: number;
  readonly dependencyIds: readonly string[];
  readonly readResources: readonly string[];
  readonly writeResources: readonly string[];
  readonly sourceTokens: number;
  readonly risk: TaskRiskAssessment;
}

export interface SchedulerTaskGraph {
  readonly tasks: readonly SchedulerTask[];
  readyTaskIds(completedTaskIds: readonly string[]): readonly string[];
  horizon(
    completedTaskIds: readonly string[],
    limit?: number,
  ): readonly SchedulerTask[];
  predecessorTaskIds(taskId: string): readonly string[];
  tasksCompatible(leftTaskId: string, rightTaskId: string): boolean;
}

const TASK_TYPES = new Set<SchedulerTaskType>([
  "translate",
  "lexical_anchor",
  "revalidate",
  "validate",
]);

const RESOURCE_KEY = /^(?:window|concept|snapshot):\S+$/u;
const DEFAULT_HORIZON_LIMIT = 12;
const MAX_HORIZON_LIMIT = 16;

export class TaskGraphIntegrityError extends Error {
  readonly code = "TASK_GRAPH_INVALID";

  constructor(detail: string) {
    super(`TASK_GRAPH_INVALID: ${detail}`);
    this.name = "TaskGraphIntegrityError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTask(left: SchedulerTask, right: SchedulerTask): number {
  return left.ordinal - right.ordinal
    || compareText(left.taskId, right.taskId);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.trim().length === 0
    || /\s/u.test(value)) {
    throw new TaskGraphIntegrityError(`${label} must be a nonempty identifier`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TaskGraphIntegrityError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function sortedUniqueIdentifiers(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TaskGraphIntegrityError(`${label} must be an array`);
  }
  const result = value.map((item, index) =>
    identifier(item, `${label}[${index}]`));
  const unique = new Set(result);
  if (unique.size !== result.length) {
    throw new TaskGraphIntegrityError(`${label} contains duplicate identifiers`);
  }
  return Object.freeze([...unique].sort(compareText));
}

function resourceKeys(value: unknown, label: string): readonly string[] {
  const resources = sortedUniqueIdentifiers(value, label);
  for (const resource of resources) {
    if (!RESOURCE_KEY.test(resource)) {
      throw new TaskGraphIntegrityError(
        `${label} contains malformed resource key ${resource}`,
      );
    }
  }
  return resources;
}

function validatedTask(raw: SchedulerTask): SchedulerTask {
  if (raw === null || typeof raw !== "object") {
    throw new TaskGraphIntegrityError("task must be an object");
  }
  const taskId = identifier(raw.taskId, "taskId");
  if (!TASK_TYPES.has(raw.type)) {
    throw new TaskGraphIntegrityError(
      `task ${taskId} has unsupported type ${String(raw.type)}`,
    );
  }
  const dependencyIds = sortedUniqueIdentifiers(
    raw.dependencyIds,
    `task ${taskId} dependencyIds`,
  );
  if (dependencyIds.includes(taskId)) {
    throw new TaskGraphIntegrityError(`task ${taskId} depends on itself`);
  }
  return Object.freeze({
    taskId,
    type: raw.type,
    ordinal: integer(raw.ordinal, `task ${taskId} ordinal`),
    dependencyIds,
    readResources: resourceKeys(
      raw.readResources,
      `task ${taskId} readResources`,
    ),
    writeResources: resourceKeys(
      raw.writeResources,
      `task ${taskId} writeResources`,
    ),
    sourceTokens: integer(raw.sourceTokens, `task ${taskId} sourceTokens`),
    risk: raw.risk,
  });
}

function intersects(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  const [smaller, larger] = left.size <= right.size
    ? [left, right]
    : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) return true;
  }
  return false;
}

function tasksHaveResourceConflict(
  left: SchedulerTask,
  right: SchedulerTask,
): boolean {
  const leftReads = new Set(left.readResources);
  const leftWrites = new Set(left.writeResources);
  const rightReads = new Set(right.readResources);
  const rightWrites = new Set(right.writeResources);
  return intersects(leftWrites, rightWrites)
    || intersects(leftWrites, rightReads)
    || intersects(rightWrites, leftReads);
}

function addEdge(
  predecessorId: string,
  successorId: string,
  outgoing: Map<string, Set<string>>,
  incoming: Map<string, Set<string>>,
): void {
  outgoing.get(predecessorId)!.add(successorId);
  incoming.get(successorId)!.add(predecessorId);
}

function topologicalOrder(
  tasks: readonly SchedulerTask[],
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  incoming: ReadonlyMap<string, ReadonlySet<string>>,
  taskById: ReadonlyMap<string, SchedulerTask>,
): readonly string[] {
  const remainingIncoming = new Map(
    [...incoming].map(([taskId, values]) => [taskId, values.size]),
  );
  const ready = tasks
    .filter((task) => remainingIncoming.get(task.taskId) === 0)
    .sort(compareTask);
  const result: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    result.push(current.taskId);
    for (const successorId of outgoing.get(current.taskId) ?? []) {
      const count = remainingIncoming.get(successorId)! - 1;
      remainingIncoming.set(successorId, count);
      if (count === 0) {
        ready.push(taskById.get(successorId)!);
        ready.sort(compareTask);
      }
    }
  }
  if (result.length !== tasks.length) {
    const involved = tasks
      .filter((task) => (remainingIncoming.get(task.taskId) ?? 0) > 0)
      .map((task) => task.taskId)
      .sort(compareText);
    throw new TaskGraphIntegrityError(
      `dependency cycle involves ${involved.join(", ")}`,
    );
  }
  return Object.freeze(result);
}

function knownCompletedIds(
  rawIds: readonly string[],
  taskById: ReadonlyMap<string, SchedulerTask>,
): ReadonlySet<string> {
  if (!Array.isArray(rawIds)) {
    throw new TaskGraphIntegrityError("completedTaskIds must be an array");
  }
  const completed = new Set<string>();
  for (const [index, rawId] of rawIds.entries()) {
    const taskId = identifier(rawId, `completedTaskIds[${index}]`);
    if (!taskById.has(taskId)) {
      throw new TaskGraphIntegrityError(
        `completed task does not exist: ${taskId}`,
      );
    }
    completed.add(taskId);
  }
  return completed;
}

function horizonLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_HORIZON_LIMIT;
  if (!Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > MAX_HORIZON_LIMIT) {
    throw new TaskGraphIntegrityError(
      `horizon limit must be from 1 through ${MAX_HORIZON_LIMIT}`,
    );
  }
  return resolved;
}

export function buildTaskGraph(
  rawTasks: readonly SchedulerTask[],
): SchedulerTaskGraph {
  if (!Array.isArray(rawTasks)) {
    throw new TaskGraphIntegrityError("tasks must be an array");
  }
  const tasks = Object.freeze(rawTasks.map(validatedTask).sort(compareTask));
  const taskById = new Map<string, SchedulerTask>();
  for (const task of tasks) {
    if (taskById.has(task.taskId)) {
      throw new TaskGraphIntegrityError(`duplicate taskId ${task.taskId}`);
    }
    taskById.set(task.taskId, task);
  }

  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const task of tasks) {
    outgoing.set(task.taskId, new Set());
    incoming.set(task.taskId, new Set());
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependencyIds) {
      if (!taskById.has(dependencyId)) {
        throw new TaskGraphIntegrityError(
          `task ${task.taskId} references missing dependency ${dependencyId}`,
        );
      }
      addEdge(dependencyId, task.taskId, outgoing, incoming);
    }
  }
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < tasks.length;
      rightIndex += 1
    ) {
      const right = tasks[rightIndex]!;
      if (tasksHaveResourceConflict(left, right)) {
        addEdge(left.taskId, right.taskId, outgoing, incoming);
      }
    }
  }

  const topological = topologicalOrder(tasks, outgoing, incoming, taskById);
  const ancestorsById = new Map<string, Set<string>>();
  for (const taskId of topological) {
    const ancestors = new Set<string>();
    for (const predecessorId of incoming.get(taskId) ?? []) {
      ancestors.add(predecessorId);
      for (const ancestorId of ancestorsById.get(predecessorId) ?? []) {
        ancestors.add(ancestorId);
      }
    }
    ancestorsById.set(taskId, ancestors);
  }
  const criticalPathById = new Map<string, number>();
  for (const taskId of [...topological].reverse()) {
    let length = 1;
    for (const successorId of outgoing.get(taskId) ?? []) {
      length = Math.max(
        length,
        1 + (criticalPathById.get(successorId) ?? 0),
      );
    }
    criticalPathById.set(taskId, length);
  }

  function readyTasks(completed: ReadonlySet<string>): SchedulerTask[] {
    return tasks.filter((task) =>
      !completed.has(task.taskId)
      && [...(incoming.get(task.taskId) ?? [])]
        .every((dependencyId) => completed.has(dependencyId)));
  }

  return Object.freeze({
    tasks,
    readyTaskIds(completedTaskIds: readonly string[]): readonly string[] {
      const completed = knownCompletedIds(completedTaskIds, taskById);
      return Object.freeze(
        readyTasks(completed).sort(compareTask).map((task) => task.taskId),
      );
    },
    horizon(
      completedTaskIds: readonly string[],
      limit?: number,
    ): readonly SchedulerTask[] {
      const completed = new Set(
        knownCompletedIds(completedTaskIds, taskById),
      );
      const selected: SchedulerTask[] = [];
      const resolvedLimit = horizonLimit(limit);
      while (selected.length < resolvedLimit) {
        const ready = readyTasks(completed).sort((left, right) =>
          (criticalPathById.get(right.taskId) ?? 0)
            - (criticalPathById.get(left.taskId) ?? 0)
          || compareTask(left, right));
        const next = ready[0];
        if (next === undefined) break;
        selected.push(next);
        completed.add(next.taskId);
      }
      return Object.freeze(selected);
    },
    predecessorTaskIds(taskId: string): readonly string[] {
      if (!taskById.has(taskId)) {
        throw new TaskGraphIntegrityError(
          `predecessors reference unknown task ${taskId}`,
        );
      }
      return Object.freeze(
        [...(incoming.get(taskId) ?? [])]
          .map((predecessorId) => taskById.get(predecessorId)!)
          .sort(compareTask)
          .map((task) => task.taskId),
      );
    },
    tasksCompatible(leftTaskId: string, rightTaskId: string): boolean {
      const left = taskById.get(leftTaskId);
      const right = taskById.get(rightTaskId);
      if (left === undefined || right === undefined) {
        throw new TaskGraphIntegrityError(
          `compatibility references unknown task ${left === undefined
            ? leftTaskId
            : rightTaskId}`,
        );
      }
      if (left.taskId === right.taskId) return false;
      if (ancestorsById.get(left.taskId)?.has(right.taskId)
        || ancestorsById.get(right.taskId)?.has(left.taskId)) {
        return false;
      }
      return !tasksHaveResourceConflict(left, right);
    },
  });
}
