import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  runtimeObservationProfileKey,
  type NormalizedRuntimeUsage,
  type RuntimeObservation,
  type RuntimeObservationStatus,
  type RuntimeProtocol,
  type RuntimeTaskType,
} from "../fullbook/runtime-telemetry.js";
import type {
  OptimizationProfile,
  SchedulerMode,
} from "../fullbook/optimization-policy.js";

const SCHEMA_VERSION = 1;

type JsonPrimitive = boolean | number | string | null;
export type StructuredValue =
  | JsonPrimitive
  | readonly StructuredValue[]
  | { readonly [key: string]: StructuredValue };

export interface SchedulerDecisionPrediction {
  readonly durationMs: number;
  readonly totalTokens: number;
}

export interface SchedulerDecisionSelection {
  readonly taskIds: readonly string[];
  readonly concurrency: number;
}

export interface SchedulerDecisionRecord {
  readonly decisionId: string;
  readonly runId: string;
  readonly mode: SchedulerMode;
  readonly profile: OptimizationProfile;
  readonly predicted: SchedulerDecisionPrediction;
  readonly selected: SchedulerDecisionSelection;
  readonly createdAt: string;
}

interface ObservationRow {
  observation_id: string;
  request_id: string;
  features_json: string;
  usage_json: string;
  duration_ms: number;
  status: string;
  observed_at: string;
}

interface ObservationFeatures {
  modelId: string;
  languageProfileId: string;
  taskType: RuntimeTaskType;
  protocol: RuntimeProtocol;
  effort: string;
  inputEstimate: number;
  outputEstimate: number;
  sourceTokens: number;
  contextProfile: "lean" | "balanced" | "rich";
  concurrency: number;
  cacheHitRatio: number;
  riskScore: number;
}

export class RuntimeProfileStoreCorruptError extends Error {
  readonly code = "RUNTIME_PROFILE_CORRUPT" as const;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeProfileStoreCorruptError";
  }
}

function one<T>(statement: StatementSync, ...values: any[]): T | undefined {
  return statement.get(...values) as unknown as T | undefined;
}

function all<T>(statement: StatementSync, ...values: any[]): T[] {
  return statement.all(...values) as unknown as T[];
}

function nonempty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty printable string`);
  }
  return normalized;
}

function nonnegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function boundedRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between zero and one`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function decisionIdentifier(value: string, label: string): string {
  const normalized = nonempty(value, label);
  if (normalized.length > 256
    || !/^[a-z0-9][a-z0-9._:/-]*$/u.test(normalized)) {
    throw new TypeError(`${label} must be a bounded scheduler identifier`);
  }
  return normalized;
}

function timestamp(value: string, label: string): string {
  const normalized = nonempty(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new TypeError(`${label} must be an ISO-compatible timestamp`);
  }
  return normalized;
}

function assertStructuredValue(
  value: unknown,
  label: string,
  depth = 0,
): asserts value is StructuredValue {
  if (depth > 16) {
    throw new TypeError(`${label} exceeds the structured value depth limit`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} numbers must be finite`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) {
      throw new TypeError(`${label} exceeds the structured value item limit`);
    }
    value.forEach((item, index) =>
      assertStructuredValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 4_096) {
      throw new TypeError(`${label} exceeds the structured value field limit`);
    }
    for (const [key, item] of entries) {
      nonempty(key, `${label} key`);
      assertStructuredValue(item, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new TypeError(`${label} must contain only structured JSON values`);
}

function parseStructuredValue(json: string, label: string): StructuredValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new RuntimeProfileStoreCorruptError(`${label} contains invalid JSON`);
  }
  try {
    assertStructuredValue(parsed, label);
  } catch (error) {
    throw new RuntimeProfileStoreCorruptError(
      error instanceof Error ? error.message : `${label} is invalid`,
    );
  }
  return parsed;
}

function stringifyStructuredValue(
  value: unknown,
  label: string,
): string {
  assertStructuredValue(value, label);
  return JSON.stringify(value);
}

function normalizeUsage(usage: NormalizedRuntimeUsage): NormalizedRuntimeUsage {
  return {
    inputTokens: nonnegativeSafeInteger(usage.inputTokens, "input tokens"),
    outputTokens: nonnegativeSafeInteger(usage.outputTokens, "output tokens"),
    cacheReadTokens: nonnegativeSafeInteger(usage.cacheReadTokens, "cache read tokens"),
    cacheWriteTokens: nonnegativeSafeInteger(usage.cacheWriteTokens, "cache write tokens"),
    reasoningTokens: nonnegativeSafeInteger(usage.reasoningTokens, "reasoning tokens"),
    totalTokens: nonnegativeSafeInteger(usage.totalTokens, "total tokens"),
    complete: Boolean(usage.complete),
  };
}

function normalizeObservation(
  observation: RuntimeObservation,
): RuntimeObservation {
  return {
    observationId: nonempty(observation.observationId, "observation id"),
    requestId: nonempty(observation.requestId, "request id"),
    modelId: nonempty(observation.modelId, "model id"),
    languageProfileId: nonempty(
      observation.languageProfileId,
      "language profile id",
    ),
    taskType: observation.taskType,
    protocol: observation.protocol,
    effort: nonempty(observation.effort, "effort"),
    inputEstimate: nonnegativeSafeInteger(
      observation.inputEstimate,
      "input estimate",
    ),
    outputEstimate: nonnegativeSafeInteger(
      observation.outputEstimate,
      "output estimate",
    ),
    sourceTokens: nonnegativeSafeInteger(observation.sourceTokens, "source tokens"),
    contextProfile: observation.contextProfile,
    concurrency: positiveSafeInteger(observation.concurrency, "concurrency"),
    cacheHitRatio: boundedRatio(observation.cacheHitRatio, "cache hit ratio"),
    riskScore: boundedRatio(observation.riskScore, "risk score"),
    durationMs: nonnegativeFinite(observation.durationMs, "duration"),
    usage: normalizeUsage(observation.usage),
    status: observation.status,
    observedAt: timestamp(observation.observedAt, "observed at"),
  };
}

function observationFeatures(
  observation: RuntimeObservation,
): ObservationFeatures {
  return {
    modelId: observation.modelId,
    languageProfileId: observation.languageProfileId,
    taskType: observation.taskType,
    protocol: observation.protocol,
    effort: observation.effort,
    inputEstimate: observation.inputEstimate,
    outputEstimate: observation.outputEstimate,
    sourceTokens: observation.sourceTokens,
    contextProfile: observation.contextProfile,
    concurrency: observation.concurrency,
    cacheHitRatio: observation.cacheHitRatio,
    riskScore: observation.riskScore,
  };
}

function isTaskType(value: unknown): value is RuntimeTaskType {
  return value === "translate"
    || value === "lexical_anchor"
    || value === "revalidate"
    || value === "validate";
}

function isProtocol(value: unknown): value is RuntimeProtocol {
  return value === "typed_tool"
    || value === "framed_text"
    || value === "local";
}

function isContextProfile(
  value: unknown,
): value is ObservationFeatures["contextProfile"] {
  return value === "lean" || value === "balanced" || value === "rich";
}

function isObservationStatus(value: unknown): value is RuntimeObservationStatus {
  return value === "success"
    || value === "throttled"
    || value === "timeout"
    || value === "context"
    || value === "protocol"
    || value === "failed";
}

function record(value: StructuredValue, label: string): Record<string, StructuredValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new RuntimeProfileStoreCorruptError(`${label} must be an object`);
  }
  return value as Record<string, StructuredValue>;
}

function observationFromRow(row: ObservationRow): RuntimeObservation {
  const rawFeatures = record(
    parseStructuredValue(row.features_json, "runtime observation features"),
    "runtime observation features",
  );
  const rawUsage = record(
    parseStructuredValue(row.usage_json, "runtime observation usage"),
    "runtime observation usage",
  );
  if (!isTaskType(rawFeatures.taskType)
    || !isProtocol(rawFeatures.protocol)
    || !isContextProfile(rawFeatures.contextProfile)
    || !isObservationStatus(row.status)) {
    throw new RuntimeProfileStoreCorruptError(
      "runtime observation contains an unknown enum value",
    );
  }
  try {
    return normalizeObservation({
      observationId: row.observation_id,
      requestId: row.request_id,
      modelId: rawFeatures.modelId as string,
      languageProfileId: rawFeatures.languageProfileId as string,
      taskType: rawFeatures.taskType,
      protocol: rawFeatures.protocol,
      effort: rawFeatures.effort as string,
      inputEstimate: rawFeatures.inputEstimate as number,
      outputEstimate: rawFeatures.outputEstimate as number,
      sourceTokens: rawFeatures.sourceTokens as number,
      contextProfile: rawFeatures.contextProfile,
      concurrency: rawFeatures.concurrency as number,
      cacheHitRatio: rawFeatures.cacheHitRatio as number,
      riskScore: rawFeatures.riskScore as number,
      durationMs: row.duration_ms,
      usage: {
        inputTokens: rawUsage.inputTokens as number,
        outputTokens: rawUsage.outputTokens as number,
        cacheReadTokens: rawUsage.cacheReadTokens as number,
        cacheWriteTokens: rawUsage.cacheWriteTokens as number,
        reasoningTokens: rawUsage.reasoningTokens as number,
        totalTokens: rawUsage.totalTokens as number,
        complete: rawUsage.complete as boolean,
      },
      status: row.status,
      observedAt: row.observed_at,
    });
  } catch (error) {
    throw new RuntimeProfileStoreCorruptError(
      error instanceof Error ? error.message : "runtime observation is invalid",
    );
  }
}

export class RuntimeProfileStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#database = new DatabaseSync(absolutePath);
    this.#database.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
    `);
    this.#createSchema();
  }

  appendObservation(observation: RuntimeObservation): void {
    const normalized = normalizeObservation(observation);
    const profileKey = runtimeObservationProfileKey(normalized);
    const features = observationFeatures(normalized);
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT OR IGNORE INTO runtime_observations(
          observation_id, profile_key, request_id, features_json, usage_json,
          duration_ms, status, observed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.observationId,
        profileKey,
        normalized.requestId,
        stringifyStructuredValue(features, "runtime observation features"),
        stringifyStructuredValue(normalized.usage, "runtime observation usage"),
        normalized.durationMs,
        normalized.status,
        normalized.observedAt,
      );
    });
  }

  observationsForProfile(profileKey: string): RuntimeObservation[] {
    const normalizedKey = nonempty(profileKey, "profile key");
    return all<ObservationRow>(this.#database.prepare(`
      SELECT observation_id, request_id, features_json, usage_json,
             duration_ms, status, observed_at
      FROM runtime_observations
      WHERE profile_key=?
      ORDER BY observed_at, observation_id
    `), normalizedKey).map(observationFromRow);
  }

  saveModelSnapshot(
    profileKey: string,
    snapshot: Readonly<Record<string, StructuredValue>>,
    updatedAt = new Date().toISOString(),
  ): void {
    const normalizedKey = nonempty(profileKey, "profile key");
    const snapshotJson = stringifyStructuredValue(snapshot, "runtime model snapshot");
    const normalizedTimestamp = timestamp(updatedAt, "snapshot updated at");
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO runtime_model_snapshots(
          profile_key, snapshot_json, updated_at
        ) VALUES(?, ?, ?)
        ON CONFLICT(profile_key) DO UPDATE SET
          snapshot_json=excluded.snapshot_json,
          updated_at=excluded.updated_at
      `).run(normalizedKey, snapshotJson, normalizedTimestamp);
    });
  }

  modelSnapshot<T extends StructuredValue = StructuredValue>(
    profileKey: string,
  ): T | undefined {
    const row = one<{ snapshot_json: string }>(
      this.#database.prepare(`
        SELECT snapshot_json FROM runtime_model_snapshots WHERE profile_key=?
      `),
      nonempty(profileKey, "profile key"),
    );
    if (row === undefined) {
      return undefined;
    }
    return parseStructuredValue(row.snapshot_json, "runtime model snapshot") as T;
  }

  appendDecision(decision: SchedulerDecisionRecord): void {
    const decisionId = decisionIdentifier(decision.decisionId, "decision id");
    const runId = decisionIdentifier(decision.runId, "run id");
    const createdAt = timestamp(decision.createdAt, "decision created at");
    const predictedJson = stringifyStructuredValue(
      {
        durationMs: nonnegativeFinite(
          decision.predicted.durationMs,
          "predicted scheduler duration",
        ),
        totalTokens: nonnegativeSafeInteger(
          decision.predicted.totalTokens,
          "predicted scheduler tokens",
        ),
      },
      "predicted scheduler projection",
    );
    const selectedJson = stringifyStructuredValue(
      {
        taskIds: decision.selected.taskIds.map((taskId, index) =>
          decisionIdentifier(taskId, `selected task id ${index}`)),
        concurrency: positiveSafeInteger(
          decision.selected.concurrency,
          "selected scheduler concurrency",
        ),
      },
      "selected scheduler projection",
    );
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT OR IGNORE INTO scheduler_decisions(
          decision_id, run_id, mode, profile, predicted_json, selected_json,
          created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        decisionId,
        runId,
        decision.mode,
        decision.profile,
        predictedJson,
        selectedJson,
        createdAt,
      );
    });
  }

  close(): void {
    this.#database.close();
  }

  #createSchema(): void {
    const row = one<{ user_version: number }>(
      this.#database.prepare("PRAGMA user_version"),
    );
    if (row !== undefined && row.user_version !== 0 && row.user_version !== SCHEMA_VERSION) {
      throw new Error(
        `unsupported runtime profile schema ${row.user_version}; expected ${SCHEMA_VERSION}`,
      );
    }
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS runtime_observations(
          observation_id TEXT PRIMARY KEY,
          profile_key TEXT NOT NULL,
          request_id TEXT NOT NULL,
          features_json TEXT NOT NULL CHECK(json_valid(features_json)),
          usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
          duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
          status TEXT NOT NULL,
          observed_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS runtime_observations_profile_order
        ON runtime_observations(profile_key, observed_at, observation_id);

        CREATE TABLE IF NOT EXISTS runtime_model_snapshots(
          profile_key TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS scheduler_decisions(
          decision_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          profile TEXT NOT NULL,
          predicted_json TEXT NOT NULL CHECK(json_valid(predicted_json)),
          selected_json TEXT NOT NULL CHECK(json_valid(selected_json)),
          created_at TEXT NOT NULL
        ) STRICT;
      `);
      this.#database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
