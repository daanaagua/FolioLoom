import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { BookWindowPlan } from "../src/fullbook/types.js";
import { validateKnowledgeCommand } from "../src/knowledge/knowledge-commands.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { auditLosslessBookStore } from "../src/report.js";
import { blockId } from "../src/source/block-builder.js";
import type { LosslessBlock } from "../src/source/types.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
  type FaultCheckpoint,
} from "../src/storage/lossless-book-store.js";

const SOURCE = "Archon.";

interface KnowledgeStateView {
  readonly generation: number;
  readonly snapshotId: string;
  readonly appliedBookGeneration: number;
  readonly appliedProjectGeneration: number;
}

interface KnowledgeCommitResult {
  readonly generation: number;
  readonly snapshotId: string;
}

interface KnowledgeCommandCapableStore {
  knowledgeState(runId: string): KnowledgeStateView;
  commitKnowledgeCommands(input: unknown): KnowledgeCommitResult;
  syncScopedKnowledge(runId: string): {
    readonly changed: boolean;
    readonly generation: number;
    readonly snapshotId: string;
    readonly appliedBookGeneration: number;
    readonly appliedProjectGeneration: number;
  };
}

function commandStore(store: LosslessBookStore): KnowledgeCommandCapableStore {
  return store as unknown as KnowledgeCommandCapableStore;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "folioloom-knowledge-command-")), "book.db");
}

function sourceInput(sourceVersion = "source-v1"): CertifiedSourceInput {
  return {
    sourceVersion,
    rawSha256: sha256(`${sourceVersion}:${SOURCE}`),
    canonicalSha256: sha256(SOURCE),
    canonicalChars: SOURCE.length,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    sourceLanguageProfileVersion: "source-language-profile-1",
    sourceLanguageCompatibilityMode: false,
    ranges: [{
      rangeId: `range-${sourceVersion}`,
      canonicalStart: 0,
      canonicalEnd: SOURCE.length,
      originKind: "text",
      originRef: `${sourceVersion}.txt`,
      transformation: "identity",
    }],
  };
}

function sourceBlocks(sourceVersion = "source-v1"): LosslessBlock[] {
  return [{
    id: blockId(sourceVersion, 0, SOURCE.length, SOURCE),
    sourceVersion,
    canonicalStart: 0,
    canonicalEnd: SOURCE.length,
    sourceText: SOURCE,
    sourceHash: sha256(SOURCE),
    globalIndex: 0,
    tokenCount: 2,
    structureId: null,
    structureTitle: null,
  }];
}

function windowPlan(sourceVersion = "source-v1"): BookWindowPlan[] {
  const [block] = sourceBlocks(sourceVersion);
  return [{
    windowId: "window-0",
    ordinal: 0,
    chapterId: "chapter-0",
    chapterTitle: "One",
    blockIds: [block!.id],
    globalIndexes: [0],
    sourceTokens: 2,
    sourceChars: SOURCE.length,
    oversized: false,
  }];
}

function createRun(
  store: LosslessBookStore,
  runId = "run-a",
  sourceVersion = "source-v1",
): string {
  const snapshot = createKnowledgeSnapshot(runId, []);
  return store.createTranslationRun({
    runId,
    sourceVersion,
    protocolVersion: "lossless-v5-test",
    modelId: "fixture-model",
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
  });
}

function initializedStore(
  withWindow = false,
  failAt?: FaultCheckpoint,
): {
  readonly store: LosslessBookStore;
  readonly runId: string;
  readonly path: string;
} {
  const path = fixturePath();
  const store = new LosslessBookStore(path, failAt === undefined
    ? undefined
    : {
        checkpoint(name) {
          if (name === failAt) {
            throw new Error(`injected ${name}`);
          }
        },
      });
  store.registerSource(sourceInput());
  store.replaceDerivedPlan("source-v1", {
    blocks: sourceBlocks(),
    annotations: [],
  });
  const runId = createRun(store);
  if (withWindow) {
    store.initializeWindowPlan(runId, windowPlan());
  }
  return { store, runId, path };
}

function termCommand(
  target: string,
  scope: "book" | "project" = "book",
  options: {
    readonly normalizedSubject?: string;
    readonly sourceForm?: string;
    readonly expectedRevision?: number | null;
    readonly expectedScopeRevision?: {
      readonly scope: "book" | "project";
      readonly revision: number;
    } | null;
  } = {},
): unknown {
  const normalizedSubject = options.normalizedSubject ?? "archon";
  return {
    type: "upsert",
    objectType: "term",
    normalizedSubject,
    kind: "lexical_anchor",
    expectedRevision: options.expectedRevision ?? null,
    expectedScopeRevision: options.expectedScopeRevision ?? null,
    fieldPatch: {
      sourceForm: options.sourceForm ?? "Archon",
      canonicalSource: normalizedSubject,
      target,
      locked: true,
      policy: "locked",
      note: "direct address",
    },
    ownedFields: ["/target", "/locked", "/policy", "/note"],
    scope,
    evidence: [],
    origin: "manual",
  };
}

function requestForCommands(
  store: KnowledgeCommandCapableStore,
  runId: string,
  commands: readonly unknown[],
  requestId = randomUUID(),
): unknown {
  const state = store.knowledgeState(runId);
  return {
    requestId,
    runId,
    expectedGeneration: state.generation,
    expectedSnapshotId: state.snapshotId,
    commands,
  };
}

function commitRequest(
  store: KnowledgeCommandCapableStore,
  runId: string,
  target: string,
  requestId = randomUUID(),
): unknown {
  const state = store.knowledgeState(runId);
  return {
    requestId,
    runId,
    expectedGeneration: state.generation,
    expectedSnapshotId: state.snapshotId,
    commands: [termCommand(target)],
  };
}

test("commits one user revision, snapshot and generation atomically", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    const before = store.knowledgeState(fixture.runId);
    const result = store.commitKnowledgeCommands(
      commitRequest(store, fixture.runId, "阁下"),
    );

    assert.equal(result.generation, before.generation + 1);
    assert.equal(fixture.store.latestKnowledgeSnapshot(fixture.runId).id, result.snapshotId);
    assert.equal(
      fixture.store.knowledgeRevisions(fixture.runId).at(-1)?.authority?.origin,
      "manual",
    );
  } finally {
    fixture.store.close();
  }
});

test("rejects a stale editor without overwriting the newer revision", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    const stale = commitRequest(store, fixture.runId, "执政官");
    store.commitKnowledgeCommands(stale);
    assert.throws(
      () => store.commitKnowledgeCommands({
        ...(stale as Record<string, unknown>),
        requestId: randomUUID(),
        commands: [termCommand("阁下")],
      }),
      /KNOWLEDGE_GENERATION_CONFLICT/u,
    );
    assert.equal(
      (fixture.store.knowledgeRevisions(fixture.runId).at(-1)?.payload as { target: string }).target,
      "执政官",
    );
  } finally {
    fixture.store.close();
  }
});

test("replays the same request id without creating another revision", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    const request = commitRequest(store, fixture.runId, "阁下", randomUUID());
    const first = store.commitKnowledgeCommands(request);
    const revisions = fixture.store.knowledgeRevisions(fixture.runId).length;
    const second = store.commitKnowledgeCommands(request);
    assert.deepEqual(second, first);
    assert.equal(fixture.store.knowledgeRevisions(fixture.runId).length, revisions);
  } finally {
    fixture.store.close();
  }
});

test("rejects reuse of a request id with different canonical input", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    const requestId = randomUUID();
    store.commitKnowledgeCommands(
      commitRequest(store, fixture.runId, "阁下", requestId),
    );
    assert.throws(
      () => store.commitKnowledgeCommands({
        ...commitRequest(store, fixture.runId, "执政官", requestId) as Record<
          string,
          unknown
        >,
        expectedGeneration: 0,
        expectedSnapshotId: createKnowledgeSnapshot(fixture.runId, []).id,
      }),
      /KNOWLEDGE_REQUEST_REUSE_CONFLICT/u,
    );
  } finally {
    fixture.store.close();
  }
});

test("rejects edits while a translation window is running", () => {
  const fixture = initializedStore(true);
  try {
    fixture.store.claimWindow(fixture.runId, "window-0");
    const store = commandStore(fixture.store);
    assert.throws(
      () => store.commitKnowledgeCommands(commitRequest(store, fixture.runId, "阁下")),
      /KNOWLEDGE_EDIT_BUSY/u,
    );
  } finally {
    fixture.store.close();
  }
});

test("rolls back a prior payload by appending a new revision", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    store.commitKnowledgeCommands(commitRequest(store, fixture.runId, "执政官"));
    store.commitKnowledgeCommands(requestForCommands(store, fixture.runId, [
      termCommand("阁下", "book", {
        expectedRevision: 1,
        expectedScopeRevision: { scope: "book", revision: 1 },
      }),
    ]));
    store.commitKnowledgeCommands(requestForCommands(store, fixture.runId, [{
      type: "rollback",
      normalizedSubject: "archon",
      kind: "lexical_anchor",
      expectedRevision: 2,
      expectedScopeRevision: { scope: "book", revision: 2 },
      targetRevision: 1,
    }]));

    const revisions = fixture.store.knowledgeRevisions(fixture.runId);
    assert.equal(revisions.length, 3);
    assert.equal(
      (revisions.at(-1)?.payload as { target: string }).target,
      "执政官",
    );
    assert.equal(revisions.at(-1)?.authority?.origin, "rollback");
  } finally {
    fixture.store.close();
  }
});

test("rolls back revision, catalog, snapshot, generation and event together", () => {
  const fixture = initializedStore(false, "knowledge_command_before_commit");
  const before = fixture.store.auditState(fixture.runId);
  const beforeState = commandStore(fixture.store).knowledgeState(fixture.runId);
  try {
    assert.throws(
      () => commandStore(fixture.store).commitKnowledgeCommands(
        commitRequest(
          commandStore(fixture.store),
          fixture.runId,
          "阁下",
        ),
      ),
      /injected knowledge_command_before_commit/u,
    );
    assert.deepEqual(fixture.store.auditState(fixture.runId), before);
    assert.deepEqual(
      commandStore(fixture.store).knowledgeState(fixture.runId),
      beforeState,
    );
  } finally {
    fixture.store.close();
  }
  const reopened = new LosslessBookStore(fixture.path);
  try {
    const nextRun = createRun(reopened, "run-after-fault");
    assert.equal(reopened.latestKnowledgeSnapshot(nextRun).revisions.length, 0);
  } finally {
    reopened.close();
  }
});

test("seeds a later run from current book knowledge", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    store.commitKnowledgeCommands(commitRequest(store, fixture.runId, "阁下"));
    const nextRun = createRun(fixture.store, "run-b");
    const seeded = fixture.store.latestKnowledgeSnapshot(nextRun).revisions;
    assert.equal((seeded[0]?.payload as { target: string }).target, "阁下");
    assert.equal(seeded[0]?.authority?.scope, "book");
  } finally {
    fixture.store.close();
  }
});

test("seeds a different source version only from project knowledge", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    store.commitKnowledgeCommands(requestForCommands(store, fixture.runId, [
      termCommand("执政官", "project"),
    ]));
    store.commitKnowledgeCommands(requestForCommands(store, fixture.runId, [
      termCommand("皮亚顿", "book", {
        normalizedSubject: "piaton",
        sourceForm: "Piaton",
      }),
    ]));

    fixture.store.registerSource(sourceInput("source-v2"));
    fixture.store.replaceDerivedPlan("source-v2", {
      blocks: sourceBlocks("source-v2"),
      annotations: [],
    });
    const nextRun = createRun(fixture.store, "run-source-v2", "source-v2");
    const subjects = fixture.store.latestKnowledgeSnapshot(nextRun).revisions
      .map((revision) => revision.normalizedSubject);
    assert.deepEqual(subjects, ["archon"]);
  } finally {
    fixture.store.close();
  }
});

test("rejects a mutation when its run has not synchronized newer catalog generations", () => {
  const fixture = initializedStore();
  try {
    const staleRun = createRun(fixture.store, "run-stale");
    const current = commandStore(fixture.store);
    current.commitKnowledgeCommands(
      commitRequest(current, fixture.runId, "阁下"),
    );
    const stale = commandStore(fixture.store);
    assert.throws(
      () => stale.commitKnowledgeCommands(requestForCommands(
        stale,
        staleRun,
        [termCommand("皮亚顿", "book", {
          normalizedSubject: "piaton",
          sourceForm: "Piaton",
        })],
      )),
      /KNOWLEDGE_SCOPE_GENERATION_CONFLICT/u,
    );
    assert.deepEqual(
      fixture.store.latestKnowledgeSnapshot(staleRun).revisions,
      [],
    );
    assert.equal(stale.knowledgeState(staleRun).appliedBookGeneration, 0);
  } finally {
    fixture.store.close();
  }
});

test("rejects unknown semantic fields instead of silently dropping them", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    const command = termCommand("阁下") as Record<string, unknown>;
    command.fieldPatch = {
      ...(command.fieldPatch as Record<string, unknown>),
      sql: "DROP TABLE knowledge_records",
    };
    assert.throws(
      () => store.commitKnowledgeCommands(requestForCommands(
        store,
        fixture.runId,
        [command],
      )),
      /unknown field: sql/u,
    );
    assert.equal(fixture.store.knowledgeRevisions(fixture.runId).length, 0);
  } finally {
    fixture.store.close();
  }
});

test("rejects semantically invalid fields for every knowledge object type", () => {
  const base = {
    type: "upsert",
    expectedRevision: null,
    expectedScopeRevision: null,
    ownedFields: [],
    scope: "book",
    evidence: [],
    origin: "manual",
  } as const;
  for (const command of [
    {
      ...base,
      objectType: "term",
      normalizedSubject: "archon",
      kind: "lexical_anchor",
      fieldPatch: { target: null },
    },
    {
      ...base,
      objectType: "entity",
      normalizedSubject: "piaton",
      kind: "entity",
      fieldPatch: { canonicalName: 42 },
    },
    {
      ...base,
      objectType: "alias",
      normalizedSubject: "the-slave",
      kind: "entity_alias_link",
      fieldPatch: { alias: "the slave", entityId: "" },
    },
    {
      ...base,
      objectType: "relation",
      normalizedSubject: "typhon-piaton",
      kind: "relation",
      fieldPatch: {
        fromEntityId: "typhon",
        relationType: false,
        toEntityId: "piaton",
      },
    },
    {
      ...base,
      objectType: "memory",
      normalizedSubject: "piaton-heart",
      kind: "narrative_memory",
      fieldPatch: { summary: ["not", "text"] },
    },
    {
      ...base,
      objectType: "style",
      normalizedSubject: "book-style",
      kind: "style_directive",
      fieldPatch: { technicalProse: true },
    },
  ]) {
    assert.throws(
      () => validateKnowledgeCommand(command),
      /must be|invalid/u,
      command.objectType,
    );
  }
});

test("rejects an empty command batch without changing durable state", () => {
  const fixture = initializedStore();
  try {
    const store = commandStore(fixture.store);
    const state = store.knowledgeState(fixture.runId);
    assert.throws(
      () => store.commitKnowledgeCommands({
        requestId: randomUUID(),
        runId: fixture.runId,
        expectedGeneration: state.generation,
        expectedSnapshotId: state.snapshotId,
        commands: [],
      }),
      /commands must not be empty/u,
    );
    assert.deepEqual(store.knowledgeState(fixture.runId), state);
  } finally {
    fixture.store.close();
  }
});

test("audits manual knowledge snapshots without requiring a producing window", () => {
  const fixture = initializedStore(true);
  try {
    const store = commandStore(fixture.store);
    store.commitKnowledgeCommands(commitRequest(store, fixture.runId, "阁下"));
    const audit = auditLosslessBookStore(fixture.store, fixture.runId);
    assert.equal(
      audit.incidentCodes.includes("KNOWLEDGE_HISTORY_INVALID"),
      false,
    );
    assert.equal(
      audit.incidentCodes.includes("SNAPSHOT_LINEAGE_INVALID"),
      false,
    );
  } finally {
    fixture.store.close();
  }
});

test("detects authority column drift from the canonical revision payload", () => {
  const fixture = initializedStore();
  const store = commandStore(fixture.store);
  store.commitKnowledgeCommands(commitRequest(store, fixture.runId, "阁下"));
  fixture.store.close();

  const database = new DatabaseSync(fixture.path);
  database.prepare(`
    UPDATE knowledge_records SET owned_fields_json='[]' WHERE run_id=?
  `).run(fixture.runId);
  database.close();

  const reopened = new LosslessBookStore(fixture.path);
  try {
    assert.throws(
      () => reopened.knowledgeRevisions(fixture.runId),
      /corrupt knowledge authority/u,
    );
  } finally {
    reopened.close();
  }
});

test("detects catalog content drift from its content-addressed revision id", () => {
  const fixture = initializedStore();
  const store = commandStore(fixture.store);
  store.commitKnowledgeCommands(commitRequest(store, fixture.runId, "阁下"));
  fixture.store.close();

  const database = new DatabaseSync(fixture.path);
  const row = database.prepare(`
    SELECT document_json FROM book_knowledge_revisions WHERE active=1
  `).get() as { document_json: string };
  const document = JSON.parse(row.document_json) as {
    payload: { target: string };
  };
  document.payload.target = "被篡改";
  database.prepare(`
    UPDATE book_knowledge_revisions SET document_json=? WHERE active=1
  `).run(JSON.stringify(document));
  database.close();

  const reopened = new LosslessBookStore(fixture.path);
  try {
    assert.throws(
      () => createRun(reopened, "run-catalog-tamper"),
      /corrupt catalog knowledge revision/u,
    );
  } finally {
    reopened.close();
  }
});

test("synchronizes book and project catalog changes into one stale-run snapshot", () => {
  const fixture = initializedStore();
  try {
    const staleRun = createRun(fixture.store, "run-stale-sync");
    const current = commandStore(fixture.store);
    current.commitKnowledgeCommands(
      commitRequest(current, fixture.runId, "阁下"),
    );
    current.commitKnowledgeCommands(requestForCommands(current, fixture.runId, [
      termCommand("皮亚顿", "project", {
        normalizedSubject: "piaton",
        sourceForm: "Piaton",
      }),
    ]));

    const stale = commandStore(fixture.store);
    const before = stale.knowledgeState(staleRun);
    const synced = stale.syncScopedKnowledge(staleRun);
    const after = stale.knowledgeState(staleRun);
    assert.equal(synced.changed, true);
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.appliedBookGeneration, 1);
    assert.equal(after.appliedProjectGeneration, 1);
    assert.deepEqual(
      fixture.store.latestKnowledgeSnapshot(staleRun).revisions
        .map((revision) => revision.normalizedSubject),
      ["archon", "piaton"],
    );

    const noOp = stale.syncScopedKnowledge(staleRun);
    assert.equal(noOp.changed, false);
    assert.deepEqual(stale.knowledgeState(staleRun), after);
  } finally {
    fixture.store.close();
  }
});

test("synchronizes project knowledge across source versions without book leakage", () => {
  const fixture = initializedStore();
  try {
    fixture.store.registerSource(sourceInput("source-v2"));
    fixture.store.replaceDerivedPlan("source-v2", {
      blocks: sourceBlocks("source-v2"),
      annotations: [],
    });
    const otherSourceRun = createRun(
      fixture.store,
      "run-other-source-sync",
      "source-v2",
    );
    const current = commandStore(fixture.store);
    current.commitKnowledgeCommands(requestForCommands(current, fixture.runId, [
      termCommand("执政官", "project"),
    ]));
    current.commitKnowledgeCommands(requestForCommands(current, fixture.runId, [
      termCommand("皮亚顿", "book", {
        normalizedSubject: "piaton",
        sourceForm: "Piaton",
      }),
    ]));

    const other = commandStore(fixture.store);
    other.syncScopedKnowledge(otherSourceRun);
    assert.deepEqual(
      fixture.store.latestKnowledgeSnapshot(otherSourceRun).revisions
        .map((revision) => revision.normalizedSubject),
      ["archon"],
    );
    assert.equal(
      other.knowledgeState(otherSourceRun).appliedBookGeneration,
      0,
    );
    assert.equal(
      other.knowledgeState(otherSourceRun).appliedProjectGeneration,
      1,
    );
  } finally {
    fixture.store.close();
  }
});

test("synchronization supersedes catalog knowledge that no longer exists", () => {
  const fixture = initializedStore();
  const runId = "run-catalog-removal";
  try {
    const store = commandStore(fixture.store);
    store.commitKnowledgeCommands(requestForCommands(store, fixture.runId, [
      termCommand("project target", "project"),
    ]));
    createRun(fixture.store, runId);
  } finally {
    fixture.store.close();
  }

  const database = new DatabaseSync(fixture.path);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE project_knowledge_revisions SET active=0
      WHERE record_id IN (
        SELECT record_id FROM project_knowledge_revisions WHERE active=1
      )
    `).run();
    database.prepare(`
      UPDATE project_knowledge_state
      SET generation=generation+1, updated_at=datetime('now')
      WHERE singleton=1
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  const reopened = new LosslessBookStore(fixture.path);
  try {
    const before = reopened.knowledgeState(runId);
    const result = reopened.syncScopedKnowledge(runId);
    assert.equal(result.generation, before.generation + 1);
    const latest = reopened.knowledgeRevisions(runId).at(-1);
    assert.equal(latest?.status, "superseded");
    assert.equal(
      reopened.latestKnowledgeSnapshot(runId).revisions.length,
      0,
    );
  } finally {
    reopened.close();
  }
});

test("synchronization reveals a lower-scope replacement after an override disappears", () => {
  const fixture = initializedStore();
  const runId = "run-lower-scope-replacement";
  try {
    const store = commandStore(fixture.store);
    store.commitKnowledgeCommands(requestForCommands(store, fixture.runId, [
      termCommand("book target", "book"),
    ]));

    fixture.store.registerSource(sourceInput("source-v2"));
    fixture.store.replaceDerivedPlan("source-v2", {
      blocks: sourceBlocks("source-v2"),
      annotations: [],
    });
    const otherRunId = createRun(fixture.store, "run-project-source", "source-v2");
    const otherStore = commandStore(fixture.store);
    otherStore.commitKnowledgeCommands(requestForCommands(otherStore, otherRunId, [
      termCommand("project target", "project"),
    ]));
    createRun(fixture.store, runId);
  } finally {
    fixture.store.close();
  }

  const database = new DatabaseSync(fixture.path);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE project_knowledge_revisions SET active=0 WHERE active=1
    `).run();
    database.prepare(`
      UPDATE project_knowledge_state
      SET generation=generation+1, updated_at=datetime('now')
      WHERE singleton=1
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  const reopened = new LosslessBookStore(fixture.path);
  try {
    reopened.syncScopedKnowledge(runId);
    const latest = reopened.knowledgeRevisions(runId).at(-1);
    assert.equal(latest?.status, "active");
    assert.equal(latest?.authority?.scope, "book");
    assert.equal(
      (latest?.payload as { target?: string } | undefined)?.target,
      "book target",
    );
    assert.equal(
      (reopened.latestKnowledgeSnapshot(runId).revisions[0]?.payload as {
        target?: string;
      } | undefined)?.target,
      "book target",
    );
  } finally {
    reopened.close();
  }
});

test("rejects scoped synchronization while a translation window is running", () => {
  const fixture = initializedStore();
  try {
    const staleRun = createRun(fixture.store, "run-busy-sync");
    fixture.store.initializeWindowPlan(staleRun, windowPlan());
    const current = commandStore(fixture.store);
    current.commitKnowledgeCommands(
      commitRequest(current, fixture.runId, "阁下"),
    );
    fixture.store.claimWindow(staleRun, "window-0");
    const stale = commandStore(fixture.store);
    const before = stale.knowledgeState(staleRun);
    assert.throws(
      () => stale.syncScopedKnowledge(staleRun),
      /KNOWLEDGE_EDIT_BUSY/u,
    );
    assert.deepEqual(stale.knowledgeState(staleRun), before);
    assert.deepEqual(
      fixture.store.latestKnowledgeSnapshot(staleRun).revisions,
      [],
    );
  } finally {
    fixture.store.close();
  }
});

test("rolls back scoped synchronization atomically on commit failure", () => {
  const fixture = initializedStore();
  const staleRun = createRun(fixture.store, "run-fault-sync");
  const current = commandStore(fixture.store);
  current.commitKnowledgeCommands(
    commitRequest(current, fixture.runId, "阁下"),
  );
  const before = commandStore(fixture.store).knowledgeState(staleRun);
  fixture.store.close();

  const failing = new LosslessBookStore(fixture.path, {
    checkpoint(name) {
      if (name === "before_commit") {
        throw new Error("injected before_commit");
      }
    },
  });
  try {
    assert.throws(
      () => commandStore(failing).syncScopedKnowledge(staleRun),
      /injected before_commit/u,
    );
  } finally {
    failing.close();
  }

  const reopened = new LosslessBookStore(fixture.path);
  try {
    assert.deepEqual(commandStore(reopened).knowledgeState(staleRun), before);
    assert.deepEqual(reopened.latestKnowledgeSnapshot(staleRun).revisions, []);
  } finally {
    reopened.close();
  }
});
