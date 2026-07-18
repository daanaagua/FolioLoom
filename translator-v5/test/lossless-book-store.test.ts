import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { BookWindowPlan } from "../src/fullbook/types.js";
import { CommitCoordinator } from "../src/fullbook/commit-coordinator.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
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

test("schema v2 enables foreign keys and WAL and creates every audit table", () => {
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
    "recovery_runs", "events", "lossless_schema_meta",
  ]) {
    assert.ok(names.includes(name), `missing table ${name}`);
  }
  database.close();
});

test("schema v2 refuses to migrate a legacy BookStore database in place", () => {
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

test("schema v2 rejects unknown and partial databases without changing journal, tables, or version", () => {
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
