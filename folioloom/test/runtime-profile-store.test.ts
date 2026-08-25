import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  normalizeRuntimeUsage,
  type RuntimeObservation,
} from "../src/fullbook/runtime-telemetry.js";
import {
  RuntimeProfileStore,
  RuntimeProfileStoreCorruptError,
  type SchedulerDecisionRecord,
} from "../src/storage/runtime-profile-store.js";

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "folioloom-runtime-profile-")), "profiles.db");
}

function observation(
  overrides: Partial<RuntimeObservation> = {},
): RuntimeObservation {
  return {
    observationId: "observation-1",
    requestId: "request-1",
    modelId: "deepseek-v4-flash",
    languageProfileId: "de",
    taskType: "translate",
    protocol: "typed_tool",
    effort: "high",
    inputEstimate: 1_000,
    outputEstimate: 600,
    sourceTokens: 800,
    contextProfile: "balanced",
    concurrency: 2,
    cacheHitRatio: 0.25,
    riskScore: 0.4,
    durationMs: 1_250,
    usage: normalizeRuntimeUsage({
      input: 900,
      output: 500,
      totalTokens: 1_400,
    }),
    status: "success",
    observedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

test("runtime profile store persists numeric telemetry without source or secrets", () => {
  const path = fixturePath();
  const unsafe = {
    ...observation(),
    apiSecret: "api-secret",
    sourceText: "Gregor Samsa",
  } as RuntimeObservation;
  const store = new RuntimeProfileStore(path);
  store.appendObservation(unsafe);
  store.close();

  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from("api-secret", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from("Gregor Samsa", "utf8")), false);
});

test("runtime profile store round trips observations by model and language profile", () => {
  const store = new RuntimeProfileStore(fixturePath());
  const expected = observation();
  store.appendObservation(expected);

  assert.deepEqual(
    store.observationsForProfile("deepseek-v4-flash:de"),
    [expected],
  );
  assert.deepEqual(store.observationsForProfile("deepseek-v4-flash:ko"), []);
  store.close();
});

test("runtime profile store uses WAL and supports two sequential writers", () => {
  const path = fixturePath();
  const first = new RuntimeProfileStore(path);
  const second = new RuntimeProfileStore(path);
  first.appendObservation(observation());
  second.appendObservation(observation({
    observationId: "observation-2",
    requestId: "request-2",
  }));

  assert.equal(first.observationsForProfile("deepseek-v4-flash:de").length, 2);
  first.close();
  second.close();

  const database = new DatabaseSync(path, { readOnly: true });
  const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(row.journal_mode.toLowerCase(), "wal");
  database.close();
});

test("duplicate observation identifiers are idempotent", () => {
  const store = new RuntimeProfileStore(fixturePath());
  store.appendObservation(observation());
  store.appendObservation(observation({ requestId: "changed-request" }));

  const rows = store.observationsForProfile("deepseek-v4-flash:de");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.requestId, "request-1");
  store.close();
});

test("runtime model snapshots round trip structured numeric state", () => {
  const store = new RuntimeProfileStore(fixturePath());
  const snapshot = {
    schemaVersion: 1,
    weights: [1, 2, 3],
    residualP90: 0.5,
  } as const;
  store.saveModelSnapshot(
    "deepseek-v4-flash:de",
    snapshot,
    "2026-07-27T00:00:00.000Z",
  );

  assert.deepEqual(store.modelSnapshot("deepseek-v4-flash:de"), snapshot);
  assert.equal(store.modelSnapshot("missing"), undefined);
  store.close();
});

test("corrupt runtime model snapshots return a deterministic error", () => {
  const path = fixturePath();
  const store = new RuntimeProfileStore(path);
  store.saveModelSnapshot(
    "deepseek-v4-flash:de",
    { schemaVersion: 1 },
    "2026-07-27T00:00:00.000Z",
  );
  store.close();

  const database = new DatabaseSync(path);
  database.exec("PRAGMA ignore_check_constraints=ON");
  database.prepare(`
    UPDATE runtime_model_snapshots SET snapshot_json='{' WHERE profile_key=?
  `).run("deepseek-v4-flash:de");
  database.close();

  const reopened = new RuntimeProfileStore(path);
  assert.throws(
    () => reopened.modelSnapshot("deepseek-v4-flash:de"),
    (error: unknown) => error instanceof RuntimeProfileStoreCorruptError
      && error.code === "RUNTIME_PROFILE_CORRUPT",
  );
  reopened.close();
});

test("scheduler decisions accept bounded structured projections", () => {
  const path = fixturePath();
  const store = new RuntimeProfileStore(path);
  store.appendDecision({
    decisionId: "decision-1",
    runId: "run-1",
    mode: "shadow",
    profile: "balanced",
    predicted: { durationMs: 1_200, totalTokens: 800 },
    selected: { taskIds: ["task-1"], concurrency: 2 },
    createdAt: "2026-07-27T00:00:00.000Z",
  });
  store.close();

  const database = new DatabaseSync(path, { readOnly: true });
  const row = database.prepare(`
    SELECT COUNT(*) AS count FROM scheduler_decisions
  `).get() as { count: number };
  assert.equal(row.count, 1);
  database.close();
});

test("scheduler decisions never persist unknown prose fields", () => {
  const path = fixturePath();
  const store = new RuntimeProfileStore(path);
  const decision = {
    decisionId: "decision-private",
    runId: "run-1",
    mode: "shadow",
    profile: "balanced",
    predicted: {
      durationMs: 1_200,
      totalTokens: 800,
      unsafe: "SECRET_SENTINEL",
    },
    selected: {
      taskIds: ["task-1"],
      concurrency: 2,
      unsafe: "SOURCE_SENTINEL",
    },
    createdAt: "2026-07-27T00:00:00.000Z",
  } as unknown as SchedulerDecisionRecord;

  store.appendDecision(decision);
  store.close();

  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from("SECRET_SENTINEL", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from("SOURCE_SENTINEL", "utf8")), false);
});
