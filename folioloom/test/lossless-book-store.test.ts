import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import type { BookWindowPlan } from "../src/fullbook/types.js";
import { CommitCoordinator } from "../src/fullbook/commit-coordinator.js";
import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import {
  expectedTermOccurrences,
  type TermUsageSubmission,
} from "../src/knowledge/term-usage.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { blockId } from "../src/source/block-builder.js";
import type { LosslessBlock } from "../src/source/types.js";
import { BookStore } from "../src/storage/book-store.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
  type TranslationRunMeta,
  type WindowStageInput,
} from "../src/storage/lossless-book-store.js";

const CANONICAL_SOURCE = "Alpha.Beta.";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "v5-lossless-store-")), "book-v2.db");
}

function databaseShape(path: string): {
  journalMode: string;
  userVersion: number;
  tables: string[];
} {
  const database = new DatabaseSync(path);
  const journalMode = (database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  const userVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tables = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map((row) => row.name);
  database.close();
  return { journalMode, userVersion, tables };
}

function sourceInput(sourceVersion = "source-v1"): CertifiedSourceInput {
  return {
    sourceVersion,
    rawSha256: sha256(CANONICAL_SOURCE),
    canonicalSha256: sha256(CANONICAL_SOURCE),
    canonicalChars: 11,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    sourceLanguageProfileVersion: "source-language-profile-1",
    sourceLanguageCompatibilityMode: false,
    ranges: [{
      rangeId: "range-0",
      canonicalStart: 0,
      canonicalEnd: 11,
      originKind: "text",
      originRef: "original.txt",
      transformation: "newline-normalization",
    }],
  };
}

test("registered certified source rejects language profile drift", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  try {
    const source = sourceInput();
    store.registerSource(source);
    assert.throws(() => store.registerSource({
      ...source,
      sourceLanguage: "fr",
    }), /already identifies a different source/);
    assert.throws(() => store.registerSource({
      ...source,
      sourceLanguageProfileVersion: "source-language-profile-2",
    }), /already identifies a different source/);
  } finally {
    store.close();
  }
});

function blocks(sourceVersion = "source-v1"): LosslessBlock[] {
  const firstText = "Alpha.";
  const secondText = "Beta.";
  return [{
    id: blockId(sourceVersion, 0, 6, firstText),
    sourceVersion,
    canonicalStart: 0,
    canonicalEnd: 6,
    sourceText: firstText,
    sourceHash: sha256(firstText),
    globalIndex: 0,
    tokenCount: 2,
    structureId: null,
    structureTitle: null,
  }, {
    id: blockId(sourceVersion, 6, 11, secondText),
    sourceVersion,
    canonicalStart: 6,
    canonicalEnd: 11,
    sourceText: secondText,
    sourceHash: sha256(secondText),
    globalIndex: 1,
    tokenCount: 2,
    structureId: null,
    structureTitle: null,
  }];
}

function windowsTogether(): BookWindowPlan[] {
  const [first, second] = blocks();
  return [{
    windowId: "window-0",
    ordinal: 0,
    chapterId: "chapter-0",
    chapterTitle: "One",
    blockIds: [first!.id, second!.id],
    globalIndexes: [0, 1],
    sourceTokens: 4,
    sourceChars: 11,
    oversized: false,
  }];
}

function windowsApart(): BookWindowPlan[] {
  const [first, second] = blocks();
  return [{
    ...windowsTogether()[0]!,
    blockIds: [first!.id],
    globalIndexes: [0],
    sourceTokens: 2,
    sourceChars: 6,
  }, {
    windowId: "window-1",
    ordinal: 1,
    chapterId: "chapter-0",
    chapterTitle: "One",
    blockIds: [second!.id],
    globalIndexes: [1],
    sourceTokens: 2,
    sourceChars: 5,
    oversized: false,
  }];
}

function runMeta(modelId: string, suffix: string): TranslationRunMeta {
  return {
    runId: `run-${suffix}`,
    sourceVersion: "source-v1",
    protocolVersion: "lossless-v5-1",
    modelId,
    initialSnapshotId: `snapshot-${suffix}`,
    metadata: { fixture: suffix },
  };
}

function initialize(
  store: LosslessBookStore,
  meta = runMeta("model-a", "a"),
  windows = windowsTogether(),
): string {
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });
  const runId = store.createTranslationRun(meta);
  store.initializeWindowPlan(runId, windows);
  return runId;
}

test("provider response evidence is durable, compressed, and raw-body deduplicated", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  try {
    const runId = initialize(store);
    const assistantMessage = {
      role: "assistant",
      provider: "fixture",
      model: "fixture-model",
      api: "fixture-api",
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 15,
      },
      content: [{
        type: "toolCall",
        name: "finalize_translation_batch",
        arguments: { windows: [{ windowId: "window-0" }] },
      }],
    };
    const input = {
      runId,
      requestId: "request-0",
      snapshotId: "snapshot-a",
      phase: "translation" as const,
      modelCallOrdinal: 1,
      requestHash: "a".repeat(64),
      responseProtocol: "typed_tool" as const,
      executionUnitId: "paragraph-unit-0",
      assistantMessage,
    };
    store.appendProviderResponseEvidence(input);
    store.appendProviderResponseEvidence({
      ...input,
      requestId: "request-replay",
    });

    const database = new DatabaseSync(path);
    const rows = database.prepare(`
      SELECT payload_json FROM events
      WHERE run_id=? AND kind='provider_response_evidence'
      ORDER BY sequence
    `).all(runId) as unknown as Array<{ payload_json: string }>;
    database.close();
    assert.equal(rows.length, 2);
    const metadata = rows.map((row) =>
      JSON.parse(row.payload_json) as {
        locator: string;
        responseHash: string;
        requestId: string;
      });
    assert.equal(metadata[0]?.locator, metadata[1]?.locator);
    assert.equal(metadata[0]?.responseHash, metadata[1]?.responseHash);
    assert.notEqual(metadata[0]?.requestId, metadata[1]?.requestId);

    const locator = metadata[0]?.locator;
    assert.ok(locator);
    const evidencePath = join(dirname(path), ...locator.split("/"));
    assert.equal(existsSync(evidencePath), true);
    const envelope = JSON.parse(
      gunzipSync(readFileSync(evidencePath)).toString("utf8"),
    ) as {
      schema: string;
      responseHash: string;
      assistantMessage: typeof assistantMessage;
    };
    assert.equal(
      envelope.schema,
      "folioloom-provider-response-evidence-1",
    );
    assert.equal(envelope.responseHash, metadata[0]?.responseHash);
    assert.deepEqual(envelope.assistantMessage, assistantMessage);
  } finally {
    store.close();
  }
});

function validStage(
  runId = "run-a",
  windowId = "window-0",
  snapshotId = "snapshot-a",
): WindowStageInput {
  const [first, second] = blocks();
  return {
    runId,
    windowId,
    snapshotId,
    status: "completed",
    translations: [{ blockId: first!.id, sourceHash: first!.sourceHash, text: "阿尔法。" }, {
      blockId: second!.id,
      sourceHash: second!.sourceHash,
      text: "贝塔。",
    }],
    knowledgeCandidates: [{
      recordId: "knowledge-0",
      normalizedSubject: "alpha",
      kind: "term",
      payload: { target: "阿尔法" },
    }],
    styleTail: "阿尔法。贝塔。",
    budget: { modelCalls: 1 },
    warnings: [],
  };
}

function alphaConcept() {
  return conceptFromAnchor({
    sourceForm: "Alpha",
    target: "阿尔法",
    mode: "contextual",
    semanticClass: "technical_term",
    confidence: 0.95,
  });
}

function alphaUsage(
  targetSurface = "阿尔法",
  concept = alphaConcept(),
): TermUsageSubmission {
  const [first] = blocks();
  const occurrence = expectedTermOccurrences(
    [{ id: first!.id, sourceText: first!.sourceText }],
    [concept],
    getSourceLanguageProfile("en"),
  )[0]!;
  return {
    occurrenceId: occurrence.occurrenceId,
    blockId: occurrence.blockId,
    conceptId: occurrence.conceptId,
    sourceForm: occurrence.sourceForm,
    sourceStart: occurrence.sourceStart,
    sourceEnd: occurrence.sourceEnd,
    discourseRole: "narrative",
    targetSurface,
  };
}

function createStaleConceptTask(
  store: LosslessBookStore,
  current = reviseConcept(alphaConcept(), {
    canonicalTarget: "阿法",
    allowedRealizations: ["阿法"],
  }),
) {
  const initialSnapshot = createKnowledgeSnapshot("run-a", []);
  const runId = initialize(store, {
    ...runMeta("model-a", "a"),
    initialSnapshotId: initialSnapshot.id,
    initialSnapshot,
  }, windowsApart());
  const previous = alphaConcept();
  const [first, second] = blocks();
  store.upsertLexicalConcepts(runId, [previous]);
  store.claimWindow(runId, "window-0");
  store.stageWindow({
    ...validStage(runId, "window-0", initialSnapshot.id),
    translations: [{
      blockId: first!.id,
      sourceHash: first!.sourceHash,
      text: "阿尔法。",
    }],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [alphaUsage("阿尔法", previous)],
      concepts: [previous],
    },
  });
  store.promoteStagedWindow(runId, "window-0");

  const candidate = {
    recordId: "knowledge-current-alpha",
    normalizedSubject: current.normalizedSubject,
    kind: "lexical_concept",
    payload: current,
  };
  store.claimWindow(runId, "window-1");
  store.stageWindow({
    ...validStage(runId, "window-1", initialSnapshot.id),
    translations: [{
      blockId: second!.id,
      sourceHash: second!.sourceHash,
      text: "贝塔。",
    }],
    knowledgeCandidates: [candidate],
    conceptBindings: { usages: [], concepts: [] },
  });
  const knowledge = new KnowledgeStore(store.knowledgeRevisions(runId));
  const appendedRevisions = knowledge.reconcileCandidates(
    [candidate],
    "window-1",
  );
  const currentSnapshot = store.latestKnowledgeSnapshot(runId);
  const nextSnapshot = createKnowledgeSnapshot(
    runId,
    knowledge.projectableRevisions(),
    currentSnapshot.id,
  );
  store.promoteStagedWindow({
    runId,
    windowId: "window-1",
    ordinal: 1,
    snapshotId: currentSnapshot.id,
    candidates: [candidate],
    appendedRevisions,
    nextSnapshot,
  });
  return {
    runId,
    first: first!,
    previous,
    current,
    nextSnapshot,
  };
}

test("schema v3 enables foreign keys and WAL and creates every audit table", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  assert.deepEqual(store.databaseSettings(), { foreignKeys: true, journalMode: "wal" });
  store.close();
  const database = new DatabaseSync(path);
  assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  const names = (database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map((row) => row.name);
  for (const name of [
    "source_versions", "source_ranges", "structure_annotations", "logical_blocks",
    "translation_runs", "window_plans", "window_membership", "translations",
    "knowledge_candidates", "knowledge_records", "knowledge_snapshots", "migration_candidates",
    "recovery_runs", "events", "lossless_schema_meta", "knowledge_state",
    "book_knowledge_state", "book_knowledge_revisions", "project_knowledge_state",
    "project_knowledge_revisions", "knowledge_block_impacts", "knowledge_import_batches",
    "knowledge_import_rows",
  ]) {
    assert.ok(names.includes(name), `missing table ${name}`);
  }
  database.close();
});

test("read-only store refuses a missing path without creating a database", () => {
  const path = fixturePath();
  assert.equal(existsSync(path), false);
  assert.throws(
    () => LosslessBookStore.openReadOnly(path),
    /unable to open database file|no such file/i,
  );
  assert.equal(existsSync(path), false);
});

test("read-only store preserves schema and exposes run status", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  writable.close();
  const before = databaseShape(path);

  const readOnly = LosslessBookStore.openReadOnly(path);
  assert.equal(readOnly.listTranslationRuns()[0]?.runId, runId);
  assert.equal(readOnly.statusSummary(runId).totalWindows, 1);
  readOnly.close();

  assert.deepEqual(databaseShape(path), before);
});

test("read-only store does not create WAL sidecars beside the project database", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  writable.close();
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  rmSync(walPath, { force: true });
  rmSync(shmPath, { force: true });
  assert.equal(existsSync(walPath), false);
  assert.equal(existsSync(shmPath), false);

  const readOnly = LosslessBookStore.openReadOnly(path);
  assert.equal(readOnly.statusSummary(runId).totalWindows, 1);
  readOnly.close();

  assert.equal(existsSync(walPath), false);
  assert.equal(existsSync(shmPath), false);
});

test("read-only store reads the newest state held in the source WAL", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  try {
    assert.equal(existsSync(`${path}-wal`), true);

    const readOnly = LosslessBookStore.openReadOnly(path);
    try {
      assert.equal(readOnly.listTranslationRuns()[0]?.runId, runId);
      assert.equal(readOnly.statusSummary(runId).totalWindows, 1);
    } finally {
      readOnly.close();
    }
  } finally {
    writable.close();
  }
});

test("read-only snapshot cleanup survives rapid GUI-style reopen cycles", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const readOnly = LosslessBookStore.openReadOnly(path);
      assert.equal(readOnly.listTranslationRuns()[0]?.runId, runId);
      assert.doesNotThrow(() => readOnly.close());
    }
  } finally {
    writable.close();
  }
});

test("read-only store rejects mutations", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  writable.close();

  const readOnly = LosslessBookStore.openReadOnly(path);
  assert.throws(() => readOnly.claimWindow(runId, "window-0"), /readonly|read-only/i);
  readOnly.close();
});

test("schema v3 refuses to migrate a legacy BookStore database in place", () => {
  const path = fixturePath();
  const legacy = new BookStore(path);
  legacy.close();
  const before = databaseShape(path);
  assert.throws(() => new LosslessBookStore(path), /legacy.*new database/i);
  assert.deepEqual(databaseShape(path), before);
  const database = new DatabaseSync(path);
  const v2Table = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='source_versions'
  `).get();
  assert.equal(v2Table, undefined);
  database.close();
});

test("schema v3 rejects unknown and partial databases without changing journal, tables, or version", () => {
  for (const [kind, initializeDatabase] of [
    ["unknown", (database: DatabaseSync) => {
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=99; CREATE TABLE unrelated(value TEXT)");
    }],
    ["partial", (database: DatabaseSync) => {
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=2; CREATE TABLE source_versions(source_version TEXT)");
    }],
  ] as const) {
    const path = fixturePath();
    const database = new DatabaseSync(path);
    initializeDatabase(database);
    database.close();
    const before = databaseShape(path);
    assert.throws(() => new LosslessBookStore(path), new RegExp(`${kind}|schema`, "i"));
    assert.deepEqual(databaseShape(path), before);
  }
});

test("source and derived plan registration are idempotent but never overwrite mismatched data", () => {
  const store = new LosslessBookStore(fixturePath());
  assert.equal(store.registerSource(sourceInput()), "source-v1");
  assert.equal(store.registerSource(sourceInput()), "source-v1");
  assert.throws(() => store.registerSource({
    ...sourceInput(),
    canonicalSha256: "changed",
  }), /source version.*different source/i);

  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });
  assert.throws(() => store.replaceDerivedPlan("source-v1", {
    blocks: [{ ...blocks()[0]!, sourceHash: "changed" }, blocks()[1]!],
    annotations: [],
  }), /source hash|derived plan.*different/i);
  assert.throws(() => store.replaceDerivedPlan("source-v1", {
    blocks: blocks("source-v2"), annotations: [],
  }), /block.*source version/i);
  store.close();
});

test("derived plan identity does not silently reuse a legacy token estimate", () => {
  const store = new LosslessBookStore(fixturePath());
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });

  assert.throws(() => store.replaceDerivedPlan("source-v1", {
    estimatorVersion: "weighted-unicode-v1",
    blocks: blocks().map((block) => ({
      ...block,
      estimatorVersion: "weighted-unicode-v1",
    })),
    annotations: [],
  }), /different data|estimator version/i);
  store.close();
});

test("first derived plan registration verifies block hashes, ids, and reconstructed canonical hash", () => {
  const canonical = "Alpha.";
  const sourceVersion = "source-certified";
  const input: CertifiedSourceInput = {
    ...sourceInput(sourceVersion),
    rawSha256: sha256(canonical),
    canonicalSha256: sha256(canonical),
    canonicalChars: 6,
    ranges: [{
      ...sourceInput(sourceVersion).ranges[0]!,
      canonicalEnd: 6,
    }],
  };
  const good: LosslessBlock = {
    id: blockId(sourceVersion, 0, 6, canonical),
    sourceVersion,
    canonicalStart: 0,
    canonicalEnd: 6,
    sourceText: canonical,
    sourceHash: sha256(canonical),
    globalIndex: 0,
    tokenCount: 2,
    structureId: null,
    structureTitle: null,
  };
  const cases: Array<[string, LosslessBlock, RegExp]> = [
    ["different-text", {
      ...good,
      id: blockId(sourceVersion, 0, 6, "Omega!"),
      sourceText: "Omega!",
      sourceHash: sha256("Omega!"),
    }, /canonical.*hash/i],
    ["wrong-hash", { ...good, sourceHash: "0".repeat(64) }, /source hash/i],
    ["fake-id", { ...good, id: "block-fake" }, /block id/i],
  ];
  for (const [suffix, candidate, pattern] of cases) {
    const path = fixturePath();
    const store = new LosslessBookStore(path);
    store.registerSource({ ...input, sourceVersion: `${sourceVersion}-${suffix}` });
    const rebased = {
      ...candidate,
      sourceVersion: `${sourceVersion}-${suffix}`,
      ...(suffix === "fake-id" ? {} : {
        id: blockId(
          `${sourceVersion}-${suffix}`,
          candidate.canonicalStart,
          candidate.canonicalEnd,
          candidate.sourceText,
        ),
      }),
    };
    let error: unknown;
    try {
      store.replaceDerivedPlan(`${sourceVersion}-${suffix}`, { blocks: [rebased], annotations: [] });
    } catch (caught) {
      error = caught;
    }
    store.close();
    assert.match(error instanceof Error ? error.message : "", pattern);
    const database = new DatabaseSync(path);
    const source = database.prepare(`
      SELECT plan_fingerprint FROM source_versions WHERE source_version=?
    `).get(`${sourceVersion}-${suffix}`) as { plan_fingerprint: string | null };
    assert.equal(source.plan_fingerprint, null);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM logical_blocks").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM structure_annotations").get() as { count: number }).count, 0);
    database.close();
  }
});

test("window initialization requires complete unique continuous membership and rolls back failures", () => {
  const store = new LosslessBookStore(fixturePath());
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });

  const [first, second] = blocks();
  const invalidPlans: Array<[string, BookWindowPlan[], RegExp]> = [
    ["gap", [{ ...windowsApart()[0]!, ordinal: 1 }, windowsApart()[1]!], /ordinal.*continuous/i],
    ["missing", [windowsApart()[0]!], /complete.*membership/i],
    ["duplicate", [{ ...windowsTogether()[0]!, blockIds: [first!.id, first!.id], globalIndexes: [0, 0] }], /duplicate.*block/i],
    ["unknown", [{ ...windowsTogether()[0]!, blockIds: [first!.id, "block-x"], globalIndexes: [0, 2] }], /unknown block/i],
    ["reversed", [{ ...windowsApart()[0]!, blockIds: [second!.id], globalIndexes: [1], sourceChars: 5 }, {
      ...windowsApart()[1]!, blockIds: [first!.id], globalIndexes: [0], sourceChars: 6,
    }], /source order/i],
  ];
  for (const [suffix, invalid, pattern] of invalidPlans) {
    const runId = store.createTranslationRun(runMeta("model-a", suffix));
    assert.throws(() => store.initializeWindowPlan(runId, invalid), pattern);
    assert.equal(store.auditRows(runId).windows.length, 0);
  }

  const runId = store.createTranslationRun(runMeta("model-a", "ok"));
  store.initializeWindowPlan(runId, windowsApart());
  assert.deepEqual(store.auditRows(runId).windows.map((item) => item.ordinal), [0, 1]);
  store.close();
});

test("database constraints reject cross-window membership and mismatched source hashes", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  initialize(store, runMeta("model-a", "db"), windowsApart());
  store.registerSource(sourceInput("source-v2"));
  store.replaceDerivedPlan("source-v2", { blocks: blocks("source-v2"), annotations: [] });
  store.close();

  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  const [first] = blocks();
  assert.throws(() => database.prepare(`
    INSERT INTO window_membership(run_id, window_id, source_version, block_id, position)
    VALUES('run-db', 'window-1', 'source-v1', ?, 1)
  `).run(first!.id), /unique constraint/i);
  assert.throws(() => database.prepare(`
    INSERT INTO translations(
      run_id, window_id, source_version, block_id, version, source_hash,
      text, result_status, stage_state, active, snapshot_id
    ) VALUES('run-db', 'window-0', 'source-v1', ?, 1, 'wrong',
      '错误', 'completed', 'staged', 0, 'snapshot-db')
  `).run(first!.id), /foreign key constraint/i);
  assert.throws(() => database.prepare(`
    INSERT INTO translations(
      run_id, window_id, source_version, block_id, version, source_hash,
      text, result_status, stage_state, active, snapshot_id
    ) VALUES('run-db', 'window-0', 'source-v2', ?, 1, ?,
      '错误', 'completed', 'staged', 0, 'snapshot-db')
  `).run(first!.id, first!.sourceHash), /foreign key constraint/i);
  database.close();
});

test("claimWindow atomically changes only one pending window in its run", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store, runMeta("model-a", "a"), windowsApart());
  initialize(store, runMeta("model-b", "b"), windowsApart());
  assert.equal(store.claimWindow("run-a", "window-0").attemptCount, 1);
  assert.throws(() => store.claimWindow("run-a", "window-0"), /not pending/i);
  assert.equal(store.claimWindow("run-b", "window-0").attemptCount, 1);
  assert.equal(store.auditRows("run-a").windows[0]?.status, "running");
  assert.equal(store.auditRows("run-b").windows[0]?.status, "running");
  store.close();
});

test("stage writes only inactive rows and promote commits the complete window atomically", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store);
  store.claimWindow("run-a", "window-0");
  store.stageWindow({ ...validStage(), knowledgeCandidates: [] });
  assert.equal(store.activeTranslations("run-a").length, 0);
  assert.equal(store.knowledgeHistory("run-a").length, 0);
  assert.equal(store.auditRows("run-a").windows[0]?.status, "staged");

  store.promoteStagedWindow("run-a", "window-0");
  assert.deepEqual(store.activeTranslations("run-a").map((item) => item.blockId), blocks().map((item) => item.id));
  assert.equal(store.knowledgeHistory("run-a").length, 0);
  assert.equal(store.auditRows("run-a").windows[0]?.status, "completed");
  store.close();
});

test("lexical concept revisions and occurrence replacement are idempotent", () => {
  const store = new LosslessBookStore(fixturePath());
  const runId = initialize(store);
  const concept = alphaConcept();
  const firstChanges = store.upsertLexicalConcepts(runId, [concept]);
  assert.deepEqual(firstChanges.map((change) => ({
    revision: change.revision,
    renderChanged: change.renderChanged,
  })), [{ revision: 1, renderChanged: true }]);

  const [first] = blocks();
  const occurrence = {
    conceptId: concept.conceptId,
    blockId: first!.id,
    sourceSpans: [{
      start: 0,
      end: 5,
      sourceForm: "Alpha",
    }],
  };
  store.replaceConceptOccurrences(runId, concept.conceptId, [occurrence]);
  store.replaceConceptOccurrences(runId, concept.conceptId, [occurrence]);
  assert.deepEqual(store.conceptOccurrences(runId, concept.conceptId), [{
    ...occurrence,
    sourceVersion: "source-v1",
  }]);

  const confidenceOnly = reviseConcept(concept, { confidence: 0.99 });
  const secondChanges = store.upsertLexicalConcepts(runId, [confidenceOnly]);
  assert.deepEqual(secondChanges.map((change) => ({
    revision: change.revision,
    renderChanged: change.renderChanged,
  })), [{ revision: 2, renderChanged: false }]);
  assert.deepEqual(store.upsertLexicalConcepts(runId, [confidenceOnly]), []);
  assert.equal(
    store.activeLexicalConcept(runId, concept.conceptId)?.revision,
    2,
  );
  assert.equal(
    store.conceptOccurrences(runId, concept.conceptId).length,
    1,
  );
  store.close();
});

test("translation concept bindings follow the staged translation version", () => {
  const store = new LosslessBookStore(fixturePath());
  const runId = initialize(store);
  const concept = alphaConcept();
  store.upsertLexicalConcepts(runId, [concept]);
  store.claimWindow(runId, "window-0");
  const [first, second] = blocks();
  store.stageWindow({
    ...validStage(),
    translations: [
      {
        blockId: first!.id,
        sourceHash: first!.sourceHash,
        text: "阿尔法。",
      },
      {
        blockId: second!.id,
        sourceHash: second!.sourceHash,
        text: "贝塔。",
      },
    ],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [alphaUsage()],
      concepts: [concept],
    },
  });
  assert.deepEqual(
    store.activeTranslationBindings(runId, first!.id),
    [],
  );

  store.promoteStagedWindow(runId, "window-0");
  const bindings = store.activeTranslationBindings(runId, first!.id);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.conceptId, concept.conceptId);
  assert.equal(bindings[0]?.appliedRevisionId, concept.revisionId);
  assert.equal(bindings[0]?.validationStatus, "clean");
  assert.deepEqual(bindings[0]?.termUsages, [alphaUsage()]);
  assert.deepEqual(
    store.activeTranslationBindings(runId, second!.id),
    [],
  );
  store.close();
});

test("contextual occurrences keep clean coverage when the receipt is omitted", () => {
  const store = new LosslessBookStore(fixturePath());
  const runId = initialize(store);
  const concept = alphaConcept();
  const [first, second] = blocks();
  store.upsertLexicalConcepts(runId, [concept]);
  store.claimWindow(runId, "window-0");
  store.stageWindow({
    ...validStage(),
    translations: [
      {
        blockId: first!.id,
        sourceHash: first!.sourceHash,
        text: "A contextually valid rendering.",
      },
      {
        blockId: second!.id,
        sourceHash: second!.sourceHash,
        text: "Beta.",
      },
    ],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [],
      concepts: [concept],
    },
  });
  store.promoteStagedWindow(runId, "window-0");

  const [binding] = store.activeTranslationBindings(runId, first!.id);
  assert.equal(binding?.conceptId, concept.conceptId);
  assert.equal(binding?.appliedRevisionId, concept.revisionId);
  assert.equal(binding?.validationStatus, "clean");
  assert.deepEqual(binding?.termUsages, []);
  assert.deepEqual(store.auditState(runId).missingConceptBindings, []);
  store.close();
});

test("promotion retries a staged translation whose term surface became obsolete", () => {
  const store = new LosslessBookStore(fixturePath());
  const runId = initialize(store);
  const previous = alphaConcept();
  const current = reviseConcept(previous, {
    canonicalTarget: "阿法",
    allowedRealizations: ["阿法"],
  });
  store.upsertLexicalConcepts(runId, [previous]);
  store.claimWindow(runId, "window-0");
  const [first, second] = blocks();
  store.stageWindow({
    ...validStage(),
    translations: [
      {
        blockId: first!.id,
        sourceHash: first!.sourceHash,
        text: "阿尔法。",
      },
      {
        blockId: second!.id,
        sourceHash: second!.sourceHash,
        text: "贝塔。",
      },
    ],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [alphaUsage("阿尔法", previous)],
      concepts: [previous],
    },
  });
  store.upsertLexicalConcepts(runId, [current]);

  assert.equal(
    store.promoteStagedWindow(runId, "window-0"),
    "retry_latest_snapshot",
  );
  assert.equal(store.activeTranslations(runId).length, 0);
  assert.equal(store.auditRows(runId).windows[0]?.status, "pending");
  assert.deepEqual(store.activeTranslationBindings(runId, first!.id), []);
  store.close();
});

test("promotion adopts the latest concept revision when its surfaces remain allowed", () => {
  const store = new LosslessBookStore(fixturePath());
  const runId = initialize(store);
  const previous = conceptFromAnchor({
    sourceForm: "Alpha",
    target: "阿尔法",
    mode: "contextual",
    semanticClass: "technical_term",
    confidence: 0.95,
    allowedRealizations: ["阿尔法", "阿尔法先生"],
  });
  const current = reviseConcept(previous, {
    canonicalTarget: "阿尔法先生",
    allowedRealizations: ["阿尔法", "阿尔法先生"],
  });
  store.upsertLexicalConcepts(runId, [previous]);
  store.claimWindow(runId, "window-0");
  const [first, second] = blocks();
  store.stageWindow({
    ...validStage(),
    translations: [
      {
        blockId: first!.id,
        sourceHash: first!.sourceHash,
        text: "阿尔法先生。",
      },
      {
        blockId: second!.id,
        sourceHash: second!.sourceHash,
        text: "贝塔。",
      },
    ],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [alphaUsage("阿尔法先生", previous)],
      concepts: [previous],
    },
  });
  store.upsertLexicalConcepts(runId, [current]);

  assert.equal(
    store.promoteStagedWindow(runId, "window-0"),
    "promoted",
  );
  const [binding] = store.activeTranslationBindings(runId, first!.id);
  assert.equal(binding?.appliedRevisionId, current.revisionId);
  assert.equal(
    binding?.appliedRenderFingerprint,
    current.renderFingerprint,
  );
  assert.equal(binding?.validatedRevisionId, current.revisionId);
  store.close();
});

test("concept promotion creates one sparse task only for an active stale binding", () => {
  const store = new LosslessBookStore(fixturePath());
  const initialSnapshot = createKnowledgeSnapshot("run-a", []);
  const runId = initialize(store, {
    ...runMeta("model-a", "a"),
    initialSnapshotId: initialSnapshot.id,
    initialSnapshot,
  }, windowsApart());
  const previous = alphaConcept();
  const current = reviseConcept(previous, {
    canonicalTarget: "阿法",
    allowedRealizations: ["阿法"],
  });
  store.upsertLexicalConcepts(runId, [previous]);
  const [first, second] = blocks();

  store.claimWindow(runId, "window-0");
  store.stageWindow({
    ...validStage(runId, "window-0", initialSnapshot.id),
    translations: [{
      blockId: first!.id,
      sourceHash: first!.sourceHash,
      text: "阿尔法。",
    }],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [alphaUsage("阿尔法", previous)],
      concepts: [previous],
    },
  });
  store.promoteStagedWindow(runId, "window-0");

  const candidate = {
    recordId: "knowledge-current-alpha",
    normalizedSubject: current.normalizedSubject,
    kind: "lexical_concept",
    payload: current,
  };
  store.claimWindow(runId, "window-1");
  store.stageWindow({
    ...validStage(runId, "window-1", initialSnapshot.id),
    translations: [{
      blockId: second!.id,
      sourceHash: second!.sourceHash,
      text: "贝塔。",
    }],
    knowledgeCandidates: [candidate],
    conceptBindings: { usages: [], concepts: [] },
  });
  const knowledge = new KnowledgeStore(store.knowledgeRevisions(runId));
  const appendedRevisions = knowledge.reconcileCandidates(
    [candidate],
    "window-1",
  );
  const currentSnapshot = store.latestKnowledgeSnapshot(runId);
  const nextSnapshot = createKnowledgeSnapshot(
    runId,
    knowledge.projectableRevisions(),
    currentSnapshot.id,
  );
  store.promoteStagedWindow({
    runId,
    windowId: "window-1",
    ordinal: 1,
    snapshotId: currentSnapshot.id,
    candidates: [candidate],
    appendedRevisions,
    nextSnapshot,
  });

  const tasks = store.revalidationTasks(runId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.blockId, first!.id);
  assert.deepEqual(tasks[0]?.conceptIds, [current.conceptId]);
  assert.equal(tasks[0]?.status, "pending");
  assert.equal(
    store.activeTranslationBindings(runId, first!.id)[0]?.validationStatus,
    "stale",
  );
  assert.equal(
    store.activeTranslationBindings(runId, second!.id).length,
    0,
  );
  store.close();
});

test("concept promotion backfills one sparse task for an earlier unbound occurrence", () => {
  const store = new LosslessBookStore(fixturePath());
  const initialSnapshot = createKnowledgeSnapshot("run-a", []);
  const runId = initialize(store, {
    ...runMeta("model-a", "a"),
    initialSnapshotId: initialSnapshot.id,
    initialSnapshot,
  }, windowsApart());
  const concept = alphaConcept();
  const [first, second] = blocks();

  store.claimWindow(runId, "window-0");
  store.stageWindow({
    ...validStage(runId, "window-0", initialSnapshot.id),
    translations: [{
      blockId: first!.id,
      sourceHash: first!.sourceHash,
      text: "较早完成但还不知道 Alpha 是术语的译文。",
    }],
    knowledgeCandidates: [],
    conceptBindings: { usages: [], concepts: [] },
  });
  store.promoteStagedWindow(runId, "window-0");
  assert.deepEqual(store.activeTranslationBindings(runId, first!.id), []);

  const candidate = {
    recordId: "knowledge-new-alpha",
    normalizedSubject: concept.normalizedSubject,
    kind: "lexical_concept",
    payload: concept,
  };
  store.claimWindow(runId, "window-1");
  store.stageWindow({
    ...validStage(runId, "window-1", initialSnapshot.id),
    translations: [{
      blockId: second!.id,
      sourceHash: second!.sourceHash,
      text: "贝塔。",
    }],
    knowledgeCandidates: [candidate],
    conceptBindings: { usages: [], concepts: [] },
  });
  const knowledge = new KnowledgeStore(store.knowledgeRevisions(runId));
  const appendedRevisions = knowledge.reconcileCandidates(
    [candidate],
    "window-1",
  );
  const currentSnapshot = store.latestKnowledgeSnapshot(runId);
  const nextSnapshot = createKnowledgeSnapshot(
    runId,
    knowledge.projectableRevisions(),
    currentSnapshot.id,
  );
  store.promoteStagedWindow({
    runId,
    windowId: "window-1",
    ordinal: 1,
    snapshotId: currentSnapshot.id,
    candidates: [candidate],
    appendedRevisions,
    nextSnapshot,
  });

  assert.equal(store.revalidationTasks(runId).length, 1);
  assert.equal(store.revalidationTasks(runId)[0]?.blockId, first!.id);
  const [binding] = store.activeTranslationBindings(runId, first!.id);
  assert.equal(binding?.conceptId, concept.conceptId);
  assert.equal(binding?.validationStatus, "stale");
  assert.deepEqual(binding?.termUsages, []);

  const firstBackfill = store.ensureConceptCoverageRevalidationTasks(
    runId,
    nextSnapshot.id,
  );
  const secondBackfill = store.ensureConceptCoverageRevalidationTasks(
    runId,
    nextSnapshot.id,
  );
  assert.equal(firstBackfill.tasksCreated, 0);
  assert.equal(secondBackfill.tasksCreated, 0);
  assert.equal(store.revalidationTasks(runId).length, 1);
  store.close();
});

test("coverage reconciliation retires legacy tasks whose exact source occurrence vanished", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  const current = reviseConcept(alphaConcept(), {
    sourceForms: ["Alpha's"],
    canonicalTarget: "阿尔法的",
    allowedRealizations: ["阿尔法的"],
  });
  const fixture = createStaleConceptTask(store, current);
  const [binding] = store.activeTranslationBindings(fixture.runId, fixture.first.id);
  assert.ok(binding);
  assert.equal(store.revalidationTasks(fixture.runId).length, 0);

  const legacyTaskId = "revalidation-legacy-possessive-projection";
  const database = new DatabaseSync(path);
  database.prepare(`
    INSERT INTO knowledge_revalidation_tasks(
      task_id, run_id, translation_id, block_id, change_set_hash,
      from_snapshot_id, to_snapshot_id, concept_ids_json, status
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    legacyTaskId,
    fixture.runId,
    binding.translationId,
    fixture.first.id,
    sha256("legacy-possessive-projection"),
    fixture.nextSnapshot.parentSnapshotId,
    fixture.nextSnapshot.id,
    JSON.stringify([current.conceptId]),
  );
  database.close();

  store.ensureConceptCoverageRevalidationTasks(
    fixture.runId,
    fixture.nextSnapshot.id,
  );

  assert.deepEqual(store.conceptOccurrences(fixture.runId, current.conceptId), []);
  assert.deepEqual(
    store.activeTranslationBindings(fixture.runId, fixture.first.id),
    [],
  );
  const legacyTask = store.revalidationTasks(fixture.runId)
    .find((task) => task.taskId === legacyTaskId);
  assert.equal(legacyTask?.status, "resolved_noop");
  assert.deepEqual(legacyTask?.result, {
    reason: "source_occurrence_obsolete",
  });
  store.close();
});

test("revalidation noop advances the binding without creating a translation version", () => {
  const store = new LosslessBookStore(fixturePath());
  const fixture = createStaleConceptTask(store, reviseConcept(alphaConcept(), {
    canonicalTarget: "阿尔法先生",
    allowedRealizations: ["阿尔法", "阿尔法先生"],
  }));
  const task = store.claimNextRevalidationTask(fixture.runId, 2);
  assert.ok(task);
  const work = store.revalidationWorkItem(fixture.runId, task.taskId);
  assert.equal(work.translation.version, 1);
  assert.equal(work.concepts[0]?.appliedConcept.revisionId, fixture.previous.revisionId);
  assert.equal(work.concepts[0]?.currentConcept.revisionId, fixture.current.revisionId);

  store.resolveRevalidationNoop(fixture.runId, task.taskId, {
    reason: "surface_still_allowed",
  });

  assert.equal(store.activeTranslations(fixture.runId)[0]?.version, 1);
  const [binding] = store.activeTranslationBindings(
    fixture.runId,
    fixture.first.id,
  );
  assert.equal(binding?.appliedRevisionId, fixture.current.revisionId);
  assert.equal(binding?.validationStatus, "clean");
  assert.equal(store.revalidationTasks(fixture.runId)[0]?.status, "resolved_noop");
  store.close();
});

test("revalidation claims an exact planned task with compare-and-swap attempts", () => {
  const store = new LosslessBookStore(fixturePath());
  const fixture = createStaleConceptTask(store);
  const pending = store.revalidationTasks(fixture.runId)[0];
  assert.ok(pending);

  assert.equal(
    store.claimRevalidationTask(fixture.runId, "missing-task", 2),
    undefined,
  );
  const claimed = store.claimRevalidationTask(
    fixture.runId,
    pending.taskId,
    2,
    pending.attempts,
  );
  assert.equal(claimed?.taskId, pending.taskId);
  assert.equal(claimed?.attempts, 1);
  assert.equal(
    store.claimRevalidationTask(
      fixture.runId,
      pending.taskId,
      2,
      pending.attempts,
    ),
    undefined,
  );
  assert.equal(
    store.claimRevalidationTask(
      fixture.runId,
      pending.taskId,
      1,
      claimed.attempts,
    ),
    undefined,
  );
  store.close();
});

test("external provider failure defers revalidation without consuming a quality attempt", () => {
  const store = new LosslessBookStore(fixturePath());
  const fixture = createStaleConceptTask(store);
  const pending = store.revalidationTasks(fixture.runId)[0];
  assert.ok(pending);
  const claimed = store.claimRevalidationTask(
    fixture.runId,
    pending.taskId,
    2,
    pending.attempts,
  );
  assert.equal(claimed?.status, "validating");
  assert.equal(claimed?.attempts, 1);

  store.deferRevalidationTask(fixture.runId, pending.taskId, {
    code: "PROVIDER_BUSY",
  });

  const deferred = store.revalidationTasks(fixture.runId)[0];
  assert.equal(deferred?.status, "pending");
  assert.equal(deferred?.attempts, 0);
  const reclaimed = store.claimRevalidationTask(
    fixture.runId,
    pending.taskId,
    2,
    0,
  );
  assert.equal(reclaimed?.attempts, 1);
  store.close();
});

test("metadata-only lexical revisions advance active bindings without scheduling work", () => {
  const store = new LosslessBookStore(fixturePath());
  const current = reviseConcept(alphaConcept(), { confidence: 0.99 });
  const fixture = createStaleConceptTask(store, current);

  assert.deepEqual(store.revalidationTasks(fixture.runId), []);
  const [binding] = store.activeTranslationBindings(
    fixture.runId,
    fixture.first.id,
  );
  assert.equal(binding?.appliedRevisionId, current.revisionId);
  assert.equal(binding?.appliedRenderFingerprint, current.renderFingerprint);
  assert.equal(binding?.validatedRevisionId, current.revisionId);
  assert.equal(binding?.validationStatus, "clean");
  store.close();
});

test("revalidation replacement preserves history and activates version two", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  const fixture = createStaleConceptTask(store);
  const task = store.claimNextRevalidationTask(fixture.runId, 2);
  assert.ok(task);
  const usage = alphaUsage("阿法", fixture.current);

  const replacementId = store.replaceTranslationForRevalidation({
    runId: fixture.runId,
    taskId: task.taskId,
    snapshotId: fixture.nextSnapshot.id,
    action: "repair",
    text: "阿法。",
    resultStatus: "completed",
    termUsages: [usage],
    concepts: [fixture.current],
    result: { reason: "one_surface_conflict" },
  });

  assert.equal(store.activeTranslations(fixture.runId)[0]?.version, 2);
  assert.equal(store.activeTranslations(fixture.runId)[0]?.text, "阿法。");
  assert.equal(
    store.revalidationTasks(fixture.runId)[0]?.replacementTranslationId,
    replacementId,
  );
  assert.equal(store.revalidationTasks(fixture.runId)[0]?.status, "resolved_repair");
  const [binding] = store.activeTranslationBindings(
    fixture.runId,
    fixture.first.id,
  );
  assert.equal(binding?.appliedRevisionId, fixture.current.revisionId);
  assert.equal(binding?.validationStatus, "clean");
  store.close();

  const database = new DatabaseSync(path);
  const versions = database.prepare(`
    SELECT version, active FROM translations
    WHERE run_id=? AND block_id=? ORDER BY version
  `).all(fixture.runId, fixture.first.id) as unknown as Array<{
    version: number;
    active: number;
  }>;
  assert.deepEqual(versions.map((row) => ({ ...row })), [
    { version: 1, active: 0 },
    { version: 2, active: 1 },
  ]);
  database.close();
});

test("revalidation replacement preserves coverage when a contextual receipt is omitted", () => {
  const store = new LosslessBookStore(fixturePath());
  const fixture = createStaleConceptTask(store);
  const task = store.claimNextRevalidationTask(fixture.runId, 2);
  assert.ok(task);

  store.replaceTranslationForRevalidation({
    runId: fixture.runId,
    taskId: task.taskId,
    snapshotId: fixture.nextSnapshot.id,
    action: "repair",
    text: "另一种可接受的上下文译法。",
    resultStatus: "completed",
    termUsages: [],
    concepts: [fixture.current],
    result: { reason: "contextual_realization_without_receipt" },
  });

  const [binding] = store.activeTranslationBindings(
    fixture.runId,
    fixture.first.id,
  );
  assert.equal(binding?.conceptId, fixture.current.conceptId);
  assert.equal(binding?.appliedRevisionId, fixture.current.revisionId);
  assert.equal(binding?.appliedRenderFingerprint, fixture.current.renderFingerprint);
  assert.deepEqual(binding?.termUsages, []);
  assert.equal(binding?.validationStatus, "clean");
  assert.equal(binding?.validatedRevisionId, fixture.current.revisionId);
  store.close();
});

test("revalidation replacement promotes warning status across its whole window", () => {
  const store = new LosslessBookStore(fixturePath());
  const fixture = createStaleConceptTask(store);
  const task = store.claimNextRevalidationTask(fixture.runId, 2);
  assert.ok(task);

  store.replaceTranslationForRevalidation({
    runId: fixture.runId,
    taskId: task.taskId,
    snapshotId: fixture.nextSnapshot.id,
    action: "repair",
    text: `${fixture.current.canonicalTarget}.`,
    resultStatus: "completed_with_warnings",
    termUsages: [
      alphaUsage(fixture.current.canonicalTarget, fixture.current),
    ],
    concepts: [fixture.current],
    result: { reason: "replacement_warning" },
  });

  assert.equal(
    store.activeTranslations(fixture.runId)[0]?.status,
    "completed_with_warnings",
  );
  assert.equal(
    store.allWindows(fixture.runId)[0]?.status,
    "completed_with_warnings",
  );
  store.close();
});

test("failed revalidation retains the old active version and marks only its binding warning stale", () => {
  const store = new LosslessBookStore(fixturePath());
  const fixture = createStaleConceptTask(store);
  const task = store.claimNextRevalidationTask(fixture.runId, 2);
  assert.ok(task);

  store.completeRevalidationWithWarning(fixture.runId, task.taskId, {
    code: "PROVIDER_UNAVAILABLE",
  });

  const [active] = store.activeTranslations(fixture.runId);
  assert.equal(active?.version, 1);
  assert.equal(active?.text, "阿尔法。");
  assert.equal(
    store.activeTranslationBindings(fixture.runId, fixture.first.id)[0]
      ?.validationStatus,
    "warning_stale",
  );
  assert.equal(
    store.revalidationTasks(fixture.runId)[0]?.status,
    "completed_with_warning",
  );
  store.close();
});

test("staging translations and concept bindings rolls back as one transaction", () => {
  const path = fixturePath();
  let armed = false;
  const store = new LosslessBookStore(path, {
    checkpoint(name) {
      if (armed && name === "before_commit") {
        throw new Error("injected before_commit");
      }
    },
  });
  const runId = initialize(store);
  const concept = alphaConcept();
  store.upsertLexicalConcepts(runId, [concept]);
  store.claimWindow(runId, "window-0");
  const [first, second] = blocks();
  armed = true;
  assert.throws(() => store.stageWindow({
    ...validStage(),
    translations: [
      {
        blockId: first!.id,
        sourceHash: first!.sourceHash,
        text: "阿尔法。",
      },
      {
        blockId: second!.id,
        sourceHash: second!.sourceHash,
        text: "贝塔。",
      },
    ],
    knowledgeCandidates: [],
    conceptBindings: {
      usages: [alphaUsage()],
      concepts: [concept],
    },
  }), /injected before_commit/u);
  armed = false;
  assert.equal(store.auditRows(runId).windows[0]?.status, "running");
  store.close();

  const database = new DatabaseSync(path);
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM translations",
  ).get() as { count: number }).count, 0);
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM translation_concept_bindings",
  ).get() as { count: number }).count, 0);
  database.close();
});

test("conflicting staged candidates persist as two domain revisions while raw candidates stay separate", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });
  const runId = "run-history";
  const initialSnapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion: "source-v1",
    protocolVersion: "lossless-v5-1",
    modelId: "model-a",
    initialSnapshotId: initialSnapshot.id,
    initialSnapshot,
  });
  store.initializeWindowPlan(runId, windowsApart());
  store.bindWindowsToSnapshot(runId, ["window-0", "window-1"], initialSnapshot.id);
  const coordinator = new CommitCoordinator(runId, new KnowledgeStore(), {
    commitPromotion(promotion) {
      store.promoteStagedWindow(promotion);
    },
  }, initialSnapshot);
  coordinator.bindWindow({ ordinal: 0, windowId: "window-0", snapshot: initialSnapshot });
  coordinator.bindWindow({ ordinal: 1, windowId: "window-1", snapshot: initialSnapshot });

  const sourceBlocks = blocks();
  const candidates = [
    { recordId: "candidate-left", normalizedSubject: "alpha", kind: "term", payload: { target: "甲" } },
    { recordId: "candidate-right", normalizedSubject: "alpha", kind: "term", payload: { target: "乙" } },
  ];
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const windowId = `window-${ordinal}`;
    const candidate = candidates[ordinal]!;
    const sourceBlock = sourceBlocks[ordinal]!;
    store.claimWindow(runId, windowId);
    store.stageWindow({
      runId,
      windowId,
      snapshotId: initialSnapshot.id,
      status: "completed",
      translations: [{
        blockId: sourceBlock.id,
        sourceHash: sourceBlock.sourceHash,
        text: `译文-${ordinal}`,
      }],
      knowledgeCandidates: [candidate],
      styleTail: "",
      budget: {},
      warnings: [],
    });
    coordinator.stage({
      runId,
      windowId,
      ordinal,
      snapshotId: initialSnapshot.id,
      candidates: [candidate],
    });
    coordinator.promoteReady();
  }

  const history = store.knowledgeHistory(runId);
  assert.deepEqual(history.map((revision) => revision.revision), [1, 2]);
  assert.deepEqual(history.map((revision) => revision.status), ["active", "needs_revalidate"]);
  assert.deepEqual(
    store.latestKnowledgeSnapshot(runId).revisions,
    [history[1]],
  );
  assert.equal(
    store.knowledgeState(runId).generation,
    2,
    "each promoted model knowledge change advances the workbench generation",
  );
  store.close();

  const database = new DatabaseSync(path);
  const recordIds = database.prepare(`
    SELECT record_id FROM knowledge_records WHERE run_id=? ORDER BY revision
  `).all(runId) as unknown as Array<{ record_id: string }>;
  assert.equal(recordIds[0]?.record_id, recordIds[1]?.record_id);
  const rawCandidates = database.prepare(`
    SELECT candidate_id, stage_state FROM knowledge_candidates
    WHERE run_id=? ORDER BY candidate_id
  `).all(runId) as unknown as Array<{ candidate_id: string; stage_state: string }>;
  assert.deepEqual(rawCandidates.map((row) => ({ ...row })), [
    { candidate_id: "candidate-left", stage_state: "promoted" },
    { candidate_id: "candidate-right", stage_state: "promoted" },
  ]);
  database.close();
});

test("failed staging of a bad second block leaves no translation or knowledge row", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store);
  store.claimWindow("run-a", "window-0");
  const invalid = validStage();
  invalid.translations[1] = { ...invalid.translations[1]!, sourceHash: "wrong" };
  assert.throws(() => store.stageWindow(invalid), /source hash/i);
  assert.equal(store.activeTranslations("run-a").length, 0);
  assert.equal(store.knowledgeHistory("run-a").length, 0);
  assert.equal(store.auditRows("run-a").windows[0]?.status, "running");
  store.close();
});

test("promotion revalidates every staged row and rolls back after database tampering", () => {
  const path = fixturePath();
  const store = new LosslessBookStore(path);
  initialize(store);
  store.claimWindow("run-a", "window-0");
  store.stageWindow({ ...validStage(), knowledgeCandidates: [] });
  store.close();

  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`UPDATE translations SET text='' WHERE run_id='run-a' AND block_id=?`).run(blocks()[1]!.id);
  database.close();

  const reopened = new LosslessBookStore(path);
  const nextSnapshot = createKnowledgeSnapshot("run-a", [], "snapshot-a");
  assert.throws(
    () => reopened.promoteStagedWindow("run-a", "window-0", nextSnapshot),
    /empty.*translation/i,
  );
  assert.equal(reopened.activeTranslations("run-a").length, 0);
  assert.equal(reopened.knowledgeHistory("run-a").length, 0);
  assert.equal(reopened.auditRows("run-a").windows[0]?.status, "staged");
  assert.equal(reopened.auditRows("run-a").snapshotIds.includes(nextSnapshot.id), false);
  reopened.close();
});

test("store rejects cross-run windows and snapshots while allowing isolated active translations", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store, runMeta("model-a", "a"));
  initialize(store, runMeta("model-b", "b"));

  store.claimWindow("run-a", "window-0");
  assert.throws(() => store.stageWindow(validStage("run-b", "window-0", "snapshot-a")), /snapshot.*run/i);
  assert.throws(() => store.stageWindow(validStage("run-a", "missing", "snapshot-a")), /run.*window/i);
  store.stageWindow({
    ...validStage("run-a", "window-0", "snapshot-a"),
    knowledgeCandidates: [],
  });
  store.promoteStagedWindow("run-a", "window-0");

  store.claimWindow("run-b", "window-0");
  store.stageWindow({
    ...validStage("run-b", "window-0", "snapshot-b"),
    knowledgeCandidates: [],
  });
  store.promoteStagedWindow("run-b", "window-0");
  assert.equal(store.activeTranslations("run-a").length, 2);
  assert.equal(store.activeTranslations("run-b").length, 2);
  assert.equal(store.auditRows("run-a").modelId, "model-a");
  assert.equal(store.auditRows("run-b").modelId, "model-b");
  store.close();
});

test("resuming a run rejects protocol, model, metadata, and initial snapshot drift", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store, runMeta("model-a", "a"));
  assert.equal(store.createTranslationRun(runMeta("model-a", "a")), "run-a");
  assert.throws(
    () => store.createTranslationRun(runMeta("model-b", "a")),
    /metadata mismatch/i,
  );
  assert.throws(
    () => store.createTranslationRun({
      ...runMeta("model-a", "a"),
      protocolVersion: "changed-protocol",
    }),
    /metadata mismatch/i,
  );
  assert.throws(
    () => store.createTranslationRun({
      ...runMeta("model-a", "a"),
      metadata: { fixture: "changed" },
    }),
    /metadata mismatch/i,
  );
  assert.throws(
    () => store.createTranslationRun({
      ...runMeta("model-a", "a"),
      initialSnapshotId: "different-snapshot",
    }),
    /initial snapshot mismatch/i,
  );
  store.close();
});

test("resuming a run rejects a changed style profile hash", () => {
  const store = new LosslessBookStore(fixturePath());
  const meta = {
    ...runMeta("model-a", "style"),
    metadata: {
      fixture: "style",
      styleProfileHash: "style-one",
      styleProfileSource: { profile: true, cliPrompt: false },
    },
  };
  initialize(store, meta);
  assert.equal(store.createTranslationRun(meta), "run-style");
  assert.throws(() => store.createTranslationRun({
    ...meta,
    metadata: {
      ...meta.metadata,
      styleProfileHash: "style-two",
    },
  }), /metadata mismatch/i);
  store.close();
});

test("failWindow is run-scoped and records stable retry and terminal state", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store, runMeta("model-a", "a"), windowsApart());
  store.claimWindow("run-a", "window-0");
  assert.throws(() => store.failWindow("run-b", "window-0", {
    error: "wrong run", retry: true, budget: {}, warnings: [],
  }), /run.*window/i);
  store.failWindow("run-a", "window-0", {
    error: "temporary\nnetwork failure",
    retry: true,
    budget: { modelCalls: 1 },
    warnings: ["retry"],
  });
  assert.equal(store.auditRows("run-a").windows[0]?.status, "pending");
  assert.equal(store.auditRows("run-a").windows[0]?.lastError, "temporary\nnetwork failure");
  store.claimWindow("run-a", "window-0");
  store.failWindow("run-a", "window-0", {
    error: "terminal", retry: false, budget: {}, warnings: [],
  });
  assert.equal(store.auditRows("run-a").windows[0]?.status, "human_required");
  store.close();
});

test("public inputs reject unsafe integers, empty identifiers and non-serializable JSON", () => {
  const store = new LosslessBookStore(fixturePath());
  assert.throws(() => store.registerSource({ ...sourceInput(), canonicalChars: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/i);
  assert.throws(() => store.registerSource({ ...sourceInput(), sourceVersion: " " }), /sourceVersion.*nonempty/i);
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", { blocks: blocks(), annotations: [] });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => store.createTranslationRun({
    ...runMeta("model-a", "json"), metadata: cyclic,
  }), /JSON-serializable/i);
  store.close();
});

test("wave snapshot binding and ordinal promotion are enforced by one atomic store", () => {
  const store = new LosslessBookStore(fixturePath());
  initialize(store, runMeta("model-a", "a"), windowsApart());
  store.bindWindowsToSnapshot("run-a", ["window-0", "window-1"], "snapshot-a");
  store.claimWindow("run-a", "window-0");
  store.claimWindow("run-a", "window-1");
  const [first, second] = blocks();
  store.stageWindow({
    ...validStage("run-a", "window-0", "snapshot-a"),
    translations: [{ blockId: first!.id, sourceHash: first!.sourceHash, text: "阿尔法。" }],
    knowledgeCandidates: [],
  });
  store.stageWindow({
    ...validStage("run-a", "window-1", "snapshot-a"),
    translations: [{ blockId: second!.id, sourceHash: second!.sourceHash, text: "贝塔。" }],
    knowledgeCandidates: [],
  });

  const firstSnapshot = createKnowledgeSnapshot("run-a", [], "snapshot-a");
  assert.throws(
    () => store.promoteStagedWindow("run-a", "window-1", firstSnapshot),
    /earlier ordinal/i,
  );
  const foreignSnapshot = createKnowledgeSnapshot("run-b", [], "snapshot-a");
  assert.throws(
    () => store.promoteStagedWindow("run-a", "window-0", foreignSnapshot),
    /another run|run mismatch/i,
  );
  assert.equal(store.activeTranslations("run-a").length, 0);
  assert.equal(store.auditRows("run-a").windows[0]?.status, "staged");

  store.promoteStagedWindow("run-a", "window-0", firstSnapshot);
  const secondSnapshot = createKnowledgeSnapshot("run-a", [], firstSnapshot.id);
  store.promoteStagedWindow("run-a", "window-1", secondSnapshot);
  assert.deepEqual(
    store.auditRows("run-a").windows.map((window) => window.status),
    ["completed", "completed"],
  );
  assert.ok(store.auditRows("run-a").snapshotIds.includes(secondSnapshot.id));
  store.close();
});
