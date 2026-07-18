import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { main, parseArgs, resolveRunSelection } from "../src/cli.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { RECOVERY_RULES } from "../src/recovery/registry.js";
import {
  createStoreRecoveryIncident,
  StoreRecoveryKernel,
} from "../src/recovery/recovery-engine.js";
import { auditLosslessBookStore, bookArtifactFileNames } from "../src/report.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function sourceManifest(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "v5-cli-doctor-"));
  const payload = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(payload).digest("hex");
  writeFileSync(join(directory, "original.txt"), payload);
  writeFileSync(join(directory, "source.txt"), payload);
  const manifest = join(directory, "source_manifest.json");
  writeFileSync(manifest, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: payload.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    canonical_path: "source.txt",
    canonical_chars: [...source].length,
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: [...source].length,
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: 0,
      raw_end: payload.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  return manifest;
}

function auditStore(manifestPath: string, runId = "run-audit"): string {
  const storePath = join(dirname(manifestPath), "book.db");
  const context = BookContext.openLossless({ manifestPath });
  const store = new LosslessBookStore(storePath);
  try {
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    const initialSnapshot = createKnowledgeSnapshot(runId, []);
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "lossless-v5-1",
      modelId: "test-model",
      initialSnapshotId: initialSnapshot.id,
      initialSnapshot,
      metadata: { fixture: true },
    });
    store.initializeWindowPlan(runId, planBookWindows(context.losslessBlocks, {
      protocolVersion: "lossless-v5-1",
    }));
  } finally {
    store.close();
    context.close();
  }
  return storePath;
}

function addRun(storePath: string, manifestPath: string, runId: string): void {
  const context = BookContext.openLossless({ manifestPath });
  const store = new LosslessBookStore(storePath);
  try {
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    const initialSnapshot = createKnowledgeSnapshot(runId, []);
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "lossless-v5-1",
      modelId: "test-model",
      initialSnapshotId: initialSnapshot.id,
      initialSnapshot,
    });
    store.initializeWindowPlan(runId, planBookWindows(context.losslessBlocks, {
      protocolVersion: "lossless-v5-1",
    }));
  } finally {
    store.close();
    context.close();
  }
}

test("CLI parses lossless doctor without model configuration", () => {
  assert.deepEqual(parseArgs([
    "book", "doctor", "--manifest", "source_manifest.json",
  ]), {
    command: "book-doctor",
    manifest: resolve("source_manifest.json"),
  });
});

test("CLI parses lossless audit without model configuration", () => {
  assert.deepEqual(parseArgs([
    "book", "audit", "--store", "book.db", "--run", "run-1",
  ]), {
    command: "book-audit",
    store: resolve("book.db"),
    runId: "run-1",
  });
});

test("CLI parses formal lossless run and optional run selection", () => {
  const run = parseArgs([
    "book", "run",
    "--manifest", "source_manifest.json",
    "--v4-db", "legacy.db",
    "--store", "state.db",
    "--config", "config.yaml",
    "--run", "run-1",
    "--max-windows", "3",
  ]);
  assert.equal(run.command, "book-run");
  assert.equal(run.manifest, resolve("source_manifest.json"));
  assert.equal(run.legacyV4Db, resolve("legacy.db"));
  assert.equal(run.store, resolve("state.db"));
  assert.equal(run.runId, "run-1");
  assert.equal(run.maxWindows, 3);
  assert.equal(parseArgs([
    "book", "status", "--store", "state.db", "--run", "run-1",
  ]).runId, "run-1");
  assert.equal(parseArgs([
    "book", "export", "--store", "state.db", "--output", "out", "--run", "run-1",
  ]).runId, "run-1");
});

test("CLI parses book recover with a strict structured incident", () => {
  assert.deepEqual(parseArgs([
    "book", "recover", "--store", "state.db", "--run", "run-1",
    "--incident", "RUNNING_AFTER_CRASH",
  ]), {
    command: "book-recover",
    store: resolve("state.db"),
    runId: "run-1",
    incidentCode: "RUNNING_AFTER_CRASH",
  });
  assert.throws(
    () => parseArgs(["book", "recover", "--store", "state.db", "--run", "run-1"]),
    /missing --incident/,
  );
  assert.throws(
    () => parseArgs([
      "book", "recover", "--store", "state.db", "--run", "run-1",
      "--incident", "NOT_REGISTERED",
    ]),
    /unknown recovery incident code/i,
  );
  assert.throws(
    () => parseArgs([
      "book", "recover", "--store", "state.db", "--run", "run-1",
      "--incident", "RUNNING_AFTER_CRASH", "--db", "source.db",
    ]),
    /unknown flag for book recover: --db/,
  );
  assert.throws(
    () => parseArgs([
      "book", "recover", "--store", "state.db", "--run", "run-1",
      "--incident", "SOURCE_SPAN_GAP",
    ]),
    /--manifest is required for SOURCE_SPAN_GAP recovery/,
  );
  assert.equal(parseArgs([
    "book", "recover", "--store", "state.db", "--run", "run-1",
    "--incident", "SOURCE_SPAN_GAP", "--manifest", "source.json",
  ]).manifest, resolve("source.json"));
});

test("CLI rejects duplicate, missing-value, and unknown flags", () => {
  assert.throws(
    () => parseArgs([
      "book", "doctor", "--manifest", "one.json", "--manifest", "two.json",
    ]),
    /duplicate flag: --manifest/,
  );
  assert.throws(
    () => parseArgs(["book", "doctor", "--manifest"]),
    /missing value for --manifest/,
  );
  assert.throws(
    () => parseArgs(["book", "doctor", "--manifest", "source.json", "--config", "x"]),
    /unknown flag for book doctor: --config/,
  );
});

test("legacy preview parsing remains compatible", () => {
  const preview = parseArgs([
    "preview", "--db", "source.db", "--config", "config.yaml",
    "--output", "out", "--global-index", "3-4", "--preflight-only",
  ]);
  assert.equal(preview.command, "preview");
  assert.deepEqual(preview.globalIndexes, [3, 4]);
  assert.equal(preview.preflightOnly, true);
});

test("run omission creates with zero, resumes one unfinished run, and rejects many", () => {
  const manifest = sourceManifest("Selection source.");
  const storePath = join(dirname(manifest), "selection.db");
  let store = new LosslessBookStore(storePath);
  assert.equal(resolveRunSelection(store, undefined, "run"), undefined);
  assert.throws(
    () => resolveRunSelection(store, undefined, "read"),
    /requires --run when the store contains 0 candidate runs/,
  );
  store.close();

  addRun(storePath, manifest, "run-one");
  store = new LosslessBookStore(storePath);
  assert.equal(resolveRunSelection(store, undefined, "run"), "run-one");
  assert.equal(resolveRunSelection(store, undefined, "read"), "run-one");
  store.close();

  addRun(storePath, manifest, "run-two");
  store = new LosslessBookStore(storePath);
  assert.throws(
    () => resolveRunSelection(store, undefined, "run"),
    /multiple unfinished runs.*--run/,
  );
  assert.throws(
    () => resolveRunSelection(store, undefined, "read"),
    /requires --run when the store contains 2 candidate runs/,
  );
  assert.equal(resolveRunSelection(store, "run-two", "read"), "run-two");
  store.close();
});

test("incomplete book artifacts use explicit partial names", () => {
  const partial = bookArtifactFileNames(false);
  assert.ok(Object.values(partial).every((name) => name.includes(".partial.")));
  const complete = bookArtifactFileNames(true);
  assert.ok(Object.values(complete).every((name) => !name.includes(".partial.")));
});

test("book doctor audits the lossless pipeline without constructing a provider", async () => {
  const output: string[] = [];
  let providerConstructions = 0;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    await main(["book", "doctor", "--manifest", sourceManifest("Alpha.\n\nBeta.")], {
      createModel: () => {
        providerConstructions += 1;
        throw new Error("provider must not be constructed");
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(providerConstructions, 0);
  const report = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
  assert.equal(report.schema, "v5-book-doctor-1");
  assert.equal(report.sourceChars, 13);
  assert.equal(report.coveredChars, 13);
  assert.deepEqual(report.incidentCodes, []);
  assert.equal(report.modelCallsAllowed, false);
  assert.deepEqual(report.sourceAnomalies, {
    schema: "v5-source-anomaly-1",
    counts: {
      CONTROL_CHARACTER: 0,
      EXTREME_LONG_LINE: 0,
      REPEATED_FRONTMATTER_LINE: 0,
      REPLACEMENT_CHARACTER: 0,
      SPACED_HYPHENATION: 0,
    },
    findings: [],
  });
  assert.ok(Number(report.blockCount) > 0);
  assert.ok(Number(report.windowCount) > 0);
});

test("book doctor manifest failures exit nonzero with structured stable errors", () => {
  const manifest = sourceManifest("Hash protected.");
  writeFileSync(join(dirname(manifest), "source.txt"), "Hash tampered!", "utf8");
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "book", "doctor", "--manifest", manifest,
  ], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const payloadText = result.stderr.split(/\r?\n/u)
    .find((line) => line.startsWith('{"schema":"v5-book-cli-error-1"'));
  assert.ok(payloadText);
  const payload = JSON.parse(payloadText) as Record<string, unknown>;
  assert.equal(payload.code, "CANONICAL_HASH_MISMATCH");
});

test("book audit recomputes persisted integrity and missing blocks without a provider", async () => {
  const manifest = sourceManifest("Alpha.\n\nBeta.");
  const storePath = auditStore(manifest);
  const database = new DatabaseSync(storePath);
  database.prepare("UPDATE logical_blocks SET source_text=? WHERE global_index=0")
    .run("Tampered source");
  database.close();
  const output: string[] = [];
  let providerConstructions = 0;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    await assert.rejects(
      main(["book", "audit", "--store", storePath, "--run", "run-audit"], {
        createModel: () => {
          providerConstructions += 1;
          throw new Error("provider must not be constructed");
        },
      }),
      /BOOK_AUDIT_FAILED/,
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(providerConstructions, 0);
  const report = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
  assert.equal(report.schema, "v5-book-store-audit-1");
  assert.equal(report.runId, "run-audit");
  assert.equal(report.protocolVersion, "lossless-v5-1");
  assert.equal(report.modelId, "test-model");
  assert.equal(report.complete, false);
  assert.ok(Number(report.missingBlockCount) > 0);
  assert.ok((report.incidentCodes as string[]).includes("SOURCE_HASH_MISMATCH"));
});

test("book recover returns a structured quarantine and does not construct a provider when no policy is allowed", async () => {
  const manifest = sourceManifest("Encoding must remain human-certified.");
  const storePath = auditStore(manifest, "run-recover");
  const output: string[] = [];
  let providerConstructions = 0;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    await main([
      "book", "recover", "--store", storePath, "--run", "run-recover",
      "--incident", "ENCODING_AMBIGUOUS",
    ], {
      createModel: () => {
        providerConstructions += 1;
        throw new Error("provider must not be constructed");
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(providerConstructions, 0);
  const result = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
  assert.equal(result.schema, "v5-book-recovery-1");
  assert.equal(result.incidentCode, "ENCODING_AMBIGUOUS");
  assert.equal(result.status, "quarantined");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.attempts, 0);
  const database = new DatabaseSync(storePath);
  const recovery = database.prepare(`
    SELECT state, strategy, before_hash, after_hash, parameters_json, result_json
    FROM recovery_runs WHERE run_id=?
  `).get("run-recover") as Record<string, unknown> | undefined;
  database.close();
  assert.equal(recovery?.state, "quarantined");
  assert.equal(recovery?.strategy, "none");
  assert.ok(typeof recovery?.before_hash === "string");
  assert.equal(recovery?.after_hash, null);
  assert.match(String(recovery?.parameters_json), /ENCODING_AMBIGUOUS/);
  assert.match(String(recovery?.result_json), /human_certification_required/);
  const quarantinedStore = new LosslessBookStore(storePath);
  assert.equal(
    quarantinedStore.listTranslationRuns().find((run) => run.runId === "run-recover")?.status,
    "quarantined",
  );
  quarantinedStore.close();
});

test("book recover promotes an audited interrupted-window shadow with zero Pi calls", async () => {
  const manifest = sourceManifest("Interrupted state must recover without touching source.");
  const storePath = auditStore(manifest, "run-interrupted");
  let store = new LosslessBookStore(storePath);
  const windowId = store.allWindows("run-interrupted")[0]?.windowId;
  assert.ok(windowId);
  store.claimWindow("run-interrupted", windowId);
  const sourceHashBefore = store.auditState("run-interrupted").canonicalSha256;
  store.close();

  const output: string[] = [];
  let providerConstructions = 0;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    await main([
      "book", "recover", "--store", storePath, "--run", "run-interrupted",
      "--incident", "RUNNING_AFTER_CRASH",
    ], {
      createModel: () => {
        providerConstructions += 1;
        throw new Error("deterministic recovery must not construct a provider");
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(providerConstructions, 0);
  const result = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
  assert.equal(result.status, "resumed");
  assert.equal(result.strategy, "reset_interrupted_windows");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.attempts, 1);

  store = new LosslessBookStore(storePath);
  assert.equal(store.allWindows("run-interrupted")[0]?.status, "pending");
  assert.equal(store.auditState("run-interrupted").canonicalSha256, sourceHashBefore);
  store.close();
  const database = new DatabaseSync(storePath);
  const recovery = database.prepare(`
    SELECT state, strategy, before_hash, after_hash, result_json
    FROM recovery_runs WHERE run_id=?
  `).get("run-interrupted") as Record<string, unknown> | undefined;
  database.close();
  assert.equal(recovery?.state, "resumed");
  assert.equal(recovery?.strategy, "reset_interrupted_windows");
  assert.ok(typeof recovery?.before_hash === "string");
  assert.ok(typeof recovery?.after_hash === "string");
  assert.match(String(recovery?.result_json), /completed_translations_unchanged/);
});

test("recovery promotion rolls back when formal state changes after shadow audit", async () => {
  const source = Array.from({ length: 8 }, (_, index) =>
    `${String.fromCharCode(65 + index)}${"x".repeat(4_999)}.`).join("\n\n");
  const manifest = sourceManifest(source);
  const storePath = auditStore(manifest, "run-race");
  const store = new LosslessBookStore(storePath);
  const windows = store.allWindows("run-race");
  assert.ok(windows.length >= 2);
  store.claimWindow("run-race", windows[0]!.windowId);
  const incident = createStoreRecoveryIncident(store, "run-race", "RUNNING_AFTER_CRASH");
  const kernel = new StoreRecoveryKernel(store, storePath);
  const shadow = await kernel.createShadow(incident, "reset_interrupted_windows", {});
  await kernel.applyStrategy(shadow);
  const audit = await kernel.auditShadow(
    shadow,
    RECOVERY_RULES.RUNNING_AFTER_CRASH.requiredAudits,
  );
  assert.equal(audit.ok, true);

  store.claimWindow("run-race", windows[1]!.windowId);
  await assert.rejects(
    kernel.promoteRecovery(shadow),
    /precondition changed after shadow audit/,
  );
  const after = store.allWindows("run-race");
  assert.equal(after.find((window) => window.windowId === windows[0]!.windowId)?.status, "running");
  assert.equal(after.find((window) => window.windowId === windows[1]!.windowId)?.status, "running");
  await kernel.discardRecovery(shadow, "fault_injection");
  store.close();
});

test("book recover rebuilds a source-gap plan without editing old source or translations", async () => {
  const manifest = sourceManifest("Alpha paragraph.\n\nBeta paragraph.");
  const storePath = auditStore(manifest, "run-source-gap");
  const database = new DatabaseSync(storePath);
  const oldBlock = database.prepare(`
    SELECT block_id, source_text FROM logical_blocks
    WHERE source_version=(SELECT source_version FROM translation_runs WHERE run_id=?)
    ORDER BY global_index LIMIT 1
  `).get("run-source-gap") as { block_id: string; source_text: string };
  database.prepare(`
    UPDATE logical_blocks SET canonical_start=1 WHERE block_id=?
  `).run(oldBlock.block_id);
  database.close();

  const output: string[] = [];
  let providerConstructions = 0;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    await main([
      "book", "recover", "--store", storePath, "--run", "run-source-gap",
      "--incident", "SOURCE_SPAN_GAP", "--manifest", manifest,
    ], {
      createModel: () => {
        providerConstructions += 1;
        throw new Error("deterministic source recovery must not construct a provider");
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(providerConstructions, 0);
  const result = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
  assert.equal(result.status, "resumed");
  assert.equal(result.strategy, "flat_partition_rebuild");
  assert.equal(result.modelCalls, 0);
  const recoveredRunId = String(result.replacementRunId);
  assert.match(recoveredRunId, /^recovery-run-/);
  assert.equal(result.runId, recoveredRunId);
  assert.equal(result.recoveredFromRunId, "run-source-gap");
  assert.match(String(result.replacementSourceVersion), /:recovery:/);

  const store = new LosslessBookStore(storePath);
  const oldState = store.auditState("run-source-gap");
  assert.equal(oldState.blocks[0]?.canonicalStart, 1);
  assert.equal(oldState.blocks[0]?.sourceText, oldBlock.source_text);
  const recoveredAudit = auditLosslessBookStore(store, recoveredRunId);
  assert.deepEqual(recoveredAudit.incidentCodes, []);
  assert.notEqual(recoveredAudit.sourceVersion, oldState.sourceVersion);
  assert.equal(recoveredAudit.sourceVersion.startsWith(`${oldState.sourceVersion}:recovery:`), true);
  assert.equal(
    store.listTranslationRuns().find((run) => run.runId === "run-source-gap")?.status,
    "quarantined",
  );
  assert.equal(resolveRunSelection(store, undefined, "run"), recoveredRunId);
  store.close();
});

test("lossless export writes partial names, missing IDs, and run metadata", async () => {
  const manifest = sourceManifest("Partial source.");
  const storePath = auditStore(manifest, "run-partial");
  const outputDirectory = join(dirname(manifest), "artifacts");
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    await main([
      "book", "export", "--store", storePath, "--run", "run-partial",
      "--output", outputDirectory, "--allow-incomplete",
    ]);
  } finally {
    console.log = originalLog;
  }
  const paths = JSON.parse(output.at(-1) ?? "") as Record<string, string>;
  assert.ok(Object.values(paths).every((path) => path.includes(".partial.")));
  const audit = JSON.parse(readFileSync(paths.audit!, "utf8")) as Record<string, unknown>;
  assert.equal(audit.complete, false);
  assert.ok(Number(audit.missingBlockCount) > 0);
  assert.ok(Array.isArray(audit.missingBlockIds));
  assert.equal((audit.runMetadata as Record<string, unknown>).fixture, true);
});

test("CLI parses full-book preflight, run, status, and export commands", () => {
  assert.equal(parseArgs([
    "book", "preflight", "--db", "source.db",
  ]).command, "book-preflight");
  const run = parseArgs([
    "book", "run",
    "--manifest", "source_manifest.json",
    "--store", "state.db",
    "--config", "config.yaml",
    "--max-windows", "3",
    "--max-concurrency", "2",
  ]);
  assert.equal(run.command, "book-run");
  assert.equal(run.maxWindows, 3);
  assert.equal(run.maxConcurrency, 2);
  assert.equal(parseArgs([
    "book", "status", "--store", "state.db",
  ]).command, "book-status");
  assert.equal(parseArgs([
    "book", "export", "--store", "state.db", "--output", "output",
    "--allow-incomplete",
  ]).command, "book-export");
});
