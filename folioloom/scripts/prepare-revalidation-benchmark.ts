import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export interface PrepareRevalidationBenchmarkOptions {
  readonly sourceStorePath: string;
  readonly outputStorePath: string;
  readonly runId: string;
  readonly taskCount: 5;
}

export interface PreparedRevalidationBenchmark {
  readonly outputStorePath: string;
  readonly sourceSha256Before: string;
  readonly sourceSha256After: string;
  readonly pendingTaskIds: readonly string[];
}

export type RevalidationBenchmarkErrorCode =
  | "BENCHMARK_INVALID_ARGUMENT"
  | "BENCHMARK_OUTPUT_EXISTS"
  | "BENCHMARK_PATH_COLLISION"
  | "BENCHMARK_SOURCE_MUTATED"
  | "BENCHMARK_TASK_COUNT";

export class RevalidationBenchmarkError extends Error {
  readonly code: RevalidationBenchmarkErrorCode;

  constructor(code: RevalidationBenchmarkErrorCode, message: string) {
    super(message);
    this.name = "RevalidationBenchmarkError";
    this.code = code;
  }
}

interface ResolvedRetranslationRow {
  readonly task_id: string;
  readonly translation_id: number;
  readonly block_id: string;
  readonly from_snapshot_id: string;
  readonly to_snapshot_id: string;
  readonly concept_ids_json: string;
}

function nonempty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_INVALID_ARGUMENT",
      `${label} must be nonempty`,
    );
  }
  return normalized;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => {
      hash.update(chunk);
    });
    input.on("error", rejectHash);
    input.on("end", resolveHash);
  });
  return hash.digest("hex");
}

function benchmarkIdentity(
  runId: string,
  sourceTaskId: string,
  translationId: number,
  ordinal: number,
): { taskId: string; changeSetHash: string } {
  const changeSetHash = createHash("sha256")
    .update([
      "folioloom-revalidation-benchmark-1",
      runId,
      sourceTaskId,
      String(translationId),
      String(ordinal),
    ].join("\0"), "utf8")
    .digest("hex");
  return {
    taskId: `benchmark-${changeSetHash.slice(0, 32)}`,
    changeSetHash,
  };
}

function conceptIds(json: string, taskId: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_INVALID_ARGUMENT",
      `resolved task ${taskId} has invalid concept ids`,
    );
  }
  if (!Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_INVALID_ARGUMENT",
      `resolved task ${taskId} has no usable concept ids`,
    );
  }
  return [...new Set(parsed)];
}

function prepareCopiedStore(
  outputStorePath: string,
  runId: string,
  taskCount: 5,
): readonly string[] {
  const database = new DatabaseSync(outputStorePath);
  const pendingTaskIds: string[] = [];
  let transactionStarted = false;

  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const resolvedTasks = database.prepare(`
      SELECT
        resolved.task_id,
        replacement.translation_id,
        replacement.block_id,
        replacement.snapshot_id AS from_snapshot_id,
        resolved.to_snapshot_id,
        resolved.concept_ids_json
      FROM knowledge_revalidation_tasks AS resolved
      JOIN translations AS replacement
        ON replacement.translation_id=resolved.replacement_translation_id
      WHERE resolved.run_id=?
        AND resolved.status='resolved_retranslate'
        AND replacement.run_id=resolved.run_id
        AND replacement.block_id=resolved.block_id
        AND replacement.active=1
      ORDER BY resolved.resolved_at, resolved.created_at, resolved.task_id
      LIMIT ?
    `).all(runId, taskCount) as unknown as ResolvedRetranslationRow[];
    if (resolvedTasks.length !== taskCount) {
      throw new RevalidationBenchmarkError(
        "BENCHMARK_TASK_COUNT",
        `expected ${taskCount} eligible resolved retranslation tasks, found ${resolvedTasks.length}`,
      );
    }
    const updateBinding = database.prepare(`
      UPDATE translation_concept_bindings
      SET term_usages_json='[]',
          validation_status='stale',
          updated_at=datetime('now')
      WHERE translation_id=? AND concept_id=?
    `);
    const insertTask = database.prepare(`
      INSERT INTO knowledge_revalidation_tasks(
        task_id, run_id, translation_id, block_id, change_set_hash,
        from_snapshot_id, to_snapshot_id, concept_ids_json, status, attempts,
        result_json, replacement_translation_id, resolved_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '{}', NULL, NULL)
    `);
    for (const [ordinal, task] of resolvedTasks.entries()) {
      const taskConceptIds = conceptIds(task.concept_ids_json, task.task_id);
      for (const conceptId of taskConceptIds) {
        const updated = updateBinding.run(task.translation_id, conceptId);
        if (Number(updated.changes) !== 1) {
          throw new RevalidationBenchmarkError(
            "BENCHMARK_INVALID_ARGUMENT",
            `active replacement for ${task.task_id} is missing concept binding ${conceptId}`,
          );
        }
      }
      const identity = benchmarkIdentity(
        runId,
        task.task_id,
        task.translation_id,
        ordinal,
      );
      insertTask.run(
        identity.taskId,
        runId,
        task.translation_id,
        task.block_id,
        identity.changeSetHash,
        task.from_snapshot_id,
        task.to_snapshot_id,
        JSON.stringify(taskConceptIds),
      );
      pendingTaskIds.push(identity.taskId);
    }
    const pendingCount = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_revalidation_tasks
      WHERE run_id=? AND status='pending'
        AND task_id LIKE 'benchmark-%'
    `).get(runId) as { count: number }).count;
    if (pendingCount !== taskCount || pendingTaskIds.length !== taskCount) {
      throw new RevalidationBenchmarkError(
        "BENCHMARK_TASK_COUNT",
        `benchmark copy contains ${pendingCount} pending benchmark tasks instead of ${taskCount}`,
      );
    }
    database.exec("COMMIT");
    transactionStarted = false;
    return pendingTaskIds;
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK");
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function prepareRevalidationBenchmark(
  options: PrepareRevalidationBenchmarkOptions,
): Promise<PreparedRevalidationBenchmark> {
  if (options.taskCount !== 5) {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_INVALID_ARGUMENT",
      "taskCount must be exactly 5",
    );
  }
  const sourceStorePath = resolve(nonempty(options.sourceStorePath, "sourceStorePath"));
  const outputStorePath = resolve(nonempty(options.outputStorePath, "outputStorePath"));
  const runId = nonempty(options.runId, "runId");
  if (sourceStorePath === outputStorePath) {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_PATH_COLLISION",
      "source and output store paths must differ",
    );
  }
  if (existsSync(outputStorePath)) {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_OUTPUT_EXISTS",
      `benchmark output already exists: ${outputStorePath}`,
    );
  }

  const sourceSha256Before = await sha256File(sourceStorePath);
  copyFileSync(sourceStorePath, outputStorePath, constants.COPYFILE_EXCL);
  try {
    const pendingTaskIds = prepareCopiedStore(outputStorePath, runId, options.taskCount);
    const sourceSha256After = await sha256File(sourceStorePath);
    if (sourceSha256After !== sourceSha256Before) {
      throw new RevalidationBenchmarkError(
        "BENCHMARK_SOURCE_MUTATED",
        "source store bytes changed while preparing the benchmark copy",
      );
    }
    return {
      outputStorePath,
      sourceSha256Before,
      sourceSha256After,
      pendingTaskIds,
    };
  } catch (error) {
    rmSync(outputStorePath, { force: true });
    throw error;
  }
}

interface CliOptions {
  readonly sourceStorePath: string;
  readonly outputStorePath: string;
  readonly runId: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined
      || !["--source-store", "--output-store", "--run"].includes(flag)
      || values.has(flag)) {
      throw new RevalidationBenchmarkError(
        "BENCHMARK_INVALID_ARGUMENT",
        "usage: prepare-revalidation-benchmark --source-store <path> --output-store <path> --run <id>",
      );
    }
    values.set(flag, value);
  }
  if (values.size !== 3) {
    throw new RevalidationBenchmarkError(
      "BENCHMARK_INVALID_ARGUMENT",
      "usage: prepare-revalidation-benchmark --source-store <path> --output-store <path> --run <id>",
    );
  }
  return {
    sourceStorePath: values.get("--source-store")!,
    outputStorePath: values.get("--output-store")!,
    runId: values.get("--run")!,
  };
}

async function main(): Promise<void> {
  try {
    const options = parseCli(process.argv.slice(2));
    const result = await prepareRevalidationBenchmark({
      ...options,
      taskCount: 5,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof RevalidationBenchmarkError
      ? error.code
      : "BENCHMARK_PREPARATION_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ code, message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
