import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";

import {
  KnowledgeImportService,
  type KnowledgeImportStorageAdapter,
  type PreparedImportRecord,
  type StageBatchInput,
} from "../src/knowledge-import/knowledge-import-service.js";
import {
  LosslessKnowledgeImportStorageAdapter,
} from "../src/knowledge-import/lossless-knowledge-import-storage.js";
import type {
  CommittedImportReport,
  ImportFieldMapping,
  ImportSelection,
  RolledBackImportReport,
  StagedImportReport,
} from "../src/knowledge-import/types.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { blockId } from "../src/source/block-builder.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
  type FaultCheckpoint,
  type FaultInjector,
} from "../src/storage/lossless-book-store.js";

function termSelection(recordPathId?: string): ImportSelection {
  return {
    objectType: "term",
    scope: "book",
    ...(recordPathId === undefined ? {} : { recordPathId }),
  };
}

function mapField(targetField: string, sourceColumn: string): ImportFieldMapping {
  return {
    targetField,
    sourceColumn,
    confidence: "high",
    confirmed: true,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function importSource(): CertifiedSourceInput {
  return {
    sourceVersion: "source-import",
    rawSha256: sha256("source"),
    canonicalSha256: sha256("source"),
    canonicalChars: 6,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "test",
    ranges: [{
      rangeId: "range-import",
      canonicalStart: 0,
      canonicalEnd: 6,
      originKind: "text",
      originRef: "source.txt",
      transformation: "identity",
    }],
  };
}

function importFixture(
  directory: string,
  injector?: FaultInjector,
): {
  readonly runId: string;
  readonly store: LosslessBookStore;
  readonly service: KnowledgeImportService;
} {
  const runId = "run-import";
  const store = new LosslessBookStore(join(directory, "book.db"), injector);
  store.registerSource(importSource());
  store.replaceDerivedPlan("source-import", {
    blocks: [{
      id: blockId("source-import", 0, 6, "source"),
      sourceVersion: "source-import",
      canonicalStart: 0,
      canonicalEnd: 6,
      sourceText: "source",
      sourceHash: sha256("source"),
      globalIndex: 0,
      tokenCount: 1,
      structureId: null,
      structureTitle: null,
    }],
    annotations: [],
  });
  const snapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion: "source-import",
    protocolVersion: "test",
    modelId: "test",
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
  });
  return {
    runId,
    store,
    service: new KnowledgeImportService({
      storage: new LosslessKnowledgeImportStorageAdapter(store, runId),
    }),
  };
}

async function stageTerms(
  service: KnowledgeImportService,
  path: string,
  expected: {
    readonly generation: number;
    readonly snapshotId: string;
  } = {
    generation: 0,
    snapshotId: createKnowledgeSnapshot("run-import", []).id,
  },
): Promise<StagedImportReport> {
  const pending = service.registerPending(path);
  const inspection = await service.inspect({
    pendingImportId: pending.pendingImportId,
    operationId: randomUUID(),
  });
  assert.equal(inspection.status, "ready");
  if (inspection.status !== "ready") assert.fail("expected ready import");
  const recordPathId = inspection.inspection.recordPaths[0]?.id;
  assert.ok(recordPathId);
  return service.stage({
    pendingImportId: pending.pendingImportId,
    operationId: randomUUID(),
    expectedGeneration: expected.generation,
    expectedSnapshotId: expected.snapshotId,
    selection: termSelection(recordPathId),
    fields: {
      source: mapField("source", "source"),
      target: mapField("target", "target"),
    },
  });
}

async function stageTermsFromAnyFormat(
  fixture: ReturnType<typeof importFixture>,
  path: string,
): Promise<StagedImportReport> {
  const pending = fixture.service.registerPending(path);
  const inspection = await fixture.service.inspect({
    pendingImportId: pending.pendingImportId,
    operationId: randomUUID(),
  });
  assert.equal(inspection.status, "ready");
  if (inspection.status !== "ready") assert.fail("expected ready import");
  const descriptor = inspection.inspection;
  const sample = descriptor.sample[0];
  assert.ok(sample);
  const entries = Object.entries(sample.values);
  const sourceColumn = entries.find(([, value]) => value === "Archon")?.[0];
  const targetColumn = entries.find(([, value]) => value === "执政官")?.[0];
  assert.ok(sourceColumn);
  assert.ok(targetColumn);
  const sheet = descriptor.sheets[0];
  const selection: ImportSelection = sheet === undefined
    ? termSelection(descriptor.recordPaths[0]?.id)
    : {
        objectType: "term",
        scope: "book",
        sheetId: sheet.id,
        headerRow: sheet.suggestedHeaderRows[0] ?? 1,
      };
  return fixture.service.stage({
    pendingImportId: pending.pendingImportId,
    operationId: randomUUID(),
    expectedGeneration: 0,
    expectedSnapshotId: createKnowledgeSnapshot(fixture.runId, []).id,
    selection,
    fields: {
      source: mapField("source", sourceColumn),
      target: mapField("target", targetColumn),
    },
  });
}

function currentImportState(
  fixture: ReturnType<typeof importFixture>,
): { generation: number; snapshotId: string } {
  return fixture.store.knowledgeState(fixture.runId);
}

function commitBatch(
  fixture: ReturnType<typeof importFixture>,
  batchId: string,
): Promise<CommittedImportReport> {
  const state = currentImportState(fixture);
  return fixture.service.commit({
    batchId,
    operationId: randomUUID(),
    expectedGeneration: state.generation,
    expectedSnapshotId: state.snapshotId,
  });
}

function rollbackBatch(
  fixture: ReturnType<typeof importFixture>,
  batchId: string,
): Promise<RolledBackImportReport> {
  const state = currentImportState(fixture);
  return fixture.service.rollback({
    batchId,
    operationId: randomUUID(),
    expectedGeneration: state.generation,
    expectedSnapshotId: state.snapshotId,
  });
}

async function withTempDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "folioloom-import-service-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("keeps absolute paths private while inspecting and suggesting a JSON mapping", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "执政官" },
      { source: "Autarch", target: "独裁官" },
    ]), "utf8");
    const service = new KnowledgeImportService();
    const pending = service.registerPending(path);
    assert.equal(pending.fileName, "terms.json");
    assert.equal(JSON.stringify(pending).includes(directory), false);

    const inspected = await service.inspect({
      pendingImportId: pending.pendingImportId,
      operationId: randomUUID(),
    });
    assert.equal(inspected.status, "ready");
    if (inspected.status !== "ready") assert.fail("expected a ready inspection");
    assert.equal(JSON.stringify(inspected).includes(directory), false);
    assert.equal(inspected.inspection.sample.length, 2);
    const recordPathId = inspected.inspection.recordPaths[0]?.id;
    assert.ok(recordPathId);

    const suggestion = await service.suggestMapping(
      pending.pendingImportId,
      termSelection(recordPathId),
    );
    assert.equal(suggestion.fields.source?.sourceColumn, "source");
    assert.equal(suggestion.fields.target?.sourceColumn, "target");
    assert.equal(suggestion.fields.source?.confirmed, true);
  });
});

test("expires pending IDs and enforces the four-file cap without evicting live entries", async () => {
  let now = 1_000;
  const service = new KnowledgeImportService({ now: () => now });
  const fixtureRoot = join(tmpdir(), "folioloom-knowledge-import-cap");
  const ids = Array.from({ length: 4 }, (_item, index) =>
    service.registerPending(join(fixtureRoot, `terms-${index}.json`)).pendingImportId);
  assert.equal(new Set(ids).size, 4);
  assert.throws(
    () => service.registerPending(join(fixtureRoot, "terms-4.json")),
    /KNOWLEDGE_IMPORT_PENDING_LIMIT/u,
  );

  now += 15 * 60 * 1_000 + 1;
  const replacement = service.registerPending(join(fixtureRoot, "replacement.json"));
  await assert.rejects(
    () => service.inspect({
      pendingImportId: ids[0] as string,
      operationId: randomUUID(),
    }),
    /KNOWLEDGE_IMPORT_PENDING_UNKNOWN_OR_EXPIRED/u,
  );
  assert.doesNotThrow(() => service.cancelPendingImport(replacement.pendingImportId));
  assert.doesNotThrow(() => service.cancelPendingImport(replacement.pendingImportId));
});

test("rejects relative paths and duplicate active operation IDs", async () => {
  const service = new KnowledgeImportService();
  assert.throws(
    () => service.registerPending("terms.json"),
    /KNOWLEDGE_IMPORT_PATH_INVALID/u,
  );

  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([{ source: "Archon", target: "执政官" }]), "utf8");
    const pending = service.registerPending(path);
    const operationId = randomUUID();
    const first = service.inspect({
      pendingImportId: pending.pendingImportId,
      operationId,
    });
    await assert.rejects(
      () => service.inspect({
        pendingImportId: pending.pendingImportId,
        operationId,
      }),
      /KNOWLEDGE_IMPORT_OPERATION_ACTIVE/u,
    );
    await first;
  });
});

test("cancels staging through an AbortSignal and never exposes partial adapter state", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "执政官" },
      { source: "Autarch", target: "独裁官" },
    ]), "utf8");
    let entered: (() => void) | undefined;
    const reachedAdapter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let visibleRows = 0;
    const adapter: KnowledgeImportStorageAdapter = {
      async stageBatch(input: StageBatchInput): Promise<StagedImportReport> {
        const transactionRows = [];
        for await (const record of input.records) transactionRows.push(record);
        entered?.();
        await new Promise<void>((resolve, reject) => {
          const cancel = (): void => reject(new Error("adapter aborted"));
          if (input.signal.aborted) {
            cancel();
            return;
          }
          input.signal.addEventListener("abort", cancel, { once: true });
        });
        visibleRows = transactionRows.length;
        throw new Error("unreachable");
      },
    };
    const service = new KnowledgeImportService({ storage: adapter });
    const pending = service.registerPending(path);
    const inspected = await service.inspect({
      pendingImportId: pending.pendingImportId,
      operationId: randomUUID(),
    });
    assert.equal(inspected.status, "ready");
    if (inspected.status !== "ready") assert.fail("expected a ready inspection");
    const recordPathId = inspected.inspection.recordPaths[0]?.id;
    assert.ok(recordPathId);
    const operationId = randomUUID();
    const staging = service.stage({
      pendingImportId: pending.pendingImportId,
      operationId,
      expectedGeneration: 0,
      expectedSnapshotId: "snapshot-0",
      selection: termSelection(recordPathId),
      fields: {
        source: mapField("source", "source"),
        target: mapField("target", "target"),
      },
    });
    await reachedAdapter;
    service.cancelOperation({ operationId });
    await assert.rejects(() => staging, /KNOWLEDGE_IMPORT_CANCELLED/u);
    assert.equal(visibleRows, 0);
    assert.doesNotThrow(() => service.cancelOperation({ operationId }));
  });
});

test("prepares normalized records for an atomic adapter without disclosing the source path", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "执政官" },
    ]), "utf8");
    const observed: StageBatchInput[] = [];
    const adapter: KnowledgeImportStorageAdapter = {
      async stageBatch(input) {
        const rows: PreparedImportRecord[] = [];
        for await (const row of input.records) rows.push(row);
        observed.push({ ...input, records: {
          async *[Symbol.asyncIterator]() {
            yield* rows;
          },
        } });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.state, "normalized");
        if (rows[0]?.state !== "normalized") assert.fail("expected a normalized row");
        assert.equal(rows[0].record.command.normalizedSubject, "Archon");
        return {
          batchId: input.batchId,
          counts: { ready: 1, merge: 0, conflict: 0, invalid: 0, skipped: 0 },
          unresolved: 0,
          rows: [],
        };
      },
    };
    const service = new KnowledgeImportService({ storage: adapter });
    const pending = service.registerPending(path);
    const inspected = await service.inspect({
      pendingImportId: pending.pendingImportId,
      operationId: randomUUID(),
    });
    assert.equal(inspected.status, "ready");
    if (inspected.status !== "ready") assert.fail("expected a ready inspection");
    const recordPathId = inspected.inspection.recordPaths[0]?.id;
    assert.ok(recordPathId);
    const report = await service.stage({
      pendingImportId: pending.pendingImportId,
      operationId: randomUUID(),
      expectedGeneration: 0,
      expectedSnapshotId: "snapshot-0",
      selection: termSelection(recordPathId),
      fields: {
        source: mapField("source", "source"),
        target: mapField("target", "target"),
      },
    });
    assert.equal(report.counts.ready, 1);
    assert.equal(observed.length, 1);
    assert.equal(JSON.stringify({
      batchId: observed[0]?.batchId,
      sourceName: observed[0]?.sourceName,
      sourceFormat: observed[0]?.sourceFormat,
    }).includes(directory), false);
  });
});

test("persists staged rows, pages them and discards them without changing knowledge", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "Magistrate" },
      { source: "Autarch", target: "Sovereign" },
    ]), "utf8");
    const fixture = importFixture(directory);
    try {
      const before = currentImportState(fixture);
      const staged = await stageTerms(fixture.service, path);
      assert.deepEqual(staged.counts, {
        ready: 2,
        merge: 0,
        conflict: 0,
        invalid: 0,
        skipped: 0,
      });
      assert.equal(staged.unresolved, 0);
      assert.equal((await fixture.service.listStaged()).length, 1);
      const firstPage = await fixture.service.getStaged({
        batchId: staged.batchId,
        limit: 1,
      });
      assert.equal(firstPage.rows.length, 1);
      assert.ok(firstPage.nextCursor);
      const secondPage = await fixture.service.getStaged({
        batchId: staged.batchId,
        cursor: firstPage.nextCursor,
        limit: 1,
      });
      assert.equal(secondPage.rows.length, 1);

      await fixture.service.discardStaged({ batchId: staged.batchId });
      assert.equal((await fixture.service.listStaged()).length, 0);
      assert.deepEqual(currentImportState(fixture), before);
      await assert.rejects(
        fixture.service.getStaged({
          batchId: staged.batchId,
          limit: 100,
        }),
        /KNOWLEDGE_IMPORT_BATCH_NOT_STAGED/u,
      );

      const restaged = await stageTerms(fixture.service, path);
      assert.notEqual(restaged.batchId, staged.batchId);
      assert.deepEqual(restaged.counts, {
        ready: 2,
        merge: 0,
        conflict: 0,
        invalid: 0,
        skipped: 0,
      });
    } finally {
      fixture.store.close();
    }
  });
});

test("requires explicit decisions for conflicts and invalid rows before commit", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = importFixture(directory);
    try {
      const state = fixture.store.knowledgeState(fixture.runId);
      fixture.store.commitKnowledgeCommands({
        requestId: randomUUID(),
        runId: fixture.runId,
        expectedGeneration: state.generation,
        expectedSnapshotId: state.snapshotId,
        commands: [{
          type: "upsert",
          objectType: "term",
          normalizedSubject: "Archon",
          kind: "lexical_anchor",
          expectedRevision: null,
          expectedScopeRevision: null,
          fieldPatch: {
            sourceForm: "Archon",
            canonicalSource: "Archon",
            target: "Existing",
          },
          ownedFields: ["/sourceForm", "/canonicalSource", "/target"],
          scope: "book",
          evidence: [],
          origin: "manual",
        }],
      });
      const conflictPath = join(directory, "conflict.json");
      await writeFile(conflictPath, JSON.stringify([
        { source: "Archon", target: "Imported" },
      ]), "utf8");
      const pending = fixture.service.registerPending(conflictPath);
      const inspected = await fixture.service.inspect({
        pendingImportId: pending.pendingImportId,
        operationId: randomUUID(),
      });
      assert.equal(inspected.status, "ready");
      if (inspected.status !== "ready") assert.fail("expected ready import");
      const recordPathId = inspected.inspection.recordPaths[0]?.id;
      assert.ok(recordPathId);
      const current = currentImportState(fixture);
      const staged = await fixture.service.stage({
        pendingImportId: pending.pendingImportId,
        operationId: randomUUID(),
        expectedGeneration: current.generation,
        expectedSnapshotId: current.snapshotId,
        selection: termSelection(recordPathId),
        fields: {
          source: mapField("source", "source"),
          target: mapField("target", "target"),
        },
      });
      assert.equal(staged.counts.conflict, 1);
      assert.equal(staged.unresolved, 1);
      await assert.rejects(
        () => commitBatch(fixture, staged.batchId),
        /KNOWLEDGE_IMPORT_CONFLICTS_UNRESOLVED/u,
      );
      const rowOrdinal = staged.rows[0]?.ordinal;
      assert.notEqual(rowOrdinal, undefined);
      const decided = await fixture.service.setDecisions({
        batchId: staged.batchId,
        decisions: [{
          rowOrdinal: rowOrdinal as number,
          decision: { action: "use_imported" },
        }],
      });
      assert.equal(decided.unresolved, 0);
      const committed = await commitBatch(fixture, staged.batchId);
      assert.equal(committed.updated, 1);
      assert.equal(committed.committed, 1);
      assert.equal(
        (fixture.store.knowledgeRevisions(fixture.runId).at(-1)?.payload as {
          target?: string;
        }).target,
        "Imported",
      );

      const invalidPath = join(directory, "invalid.json");
      await writeFile(invalidPath, JSON.stringify([
        { source: "NoTarget", target: null },
      ]), "utf8");
      const invalid = await (async () => {
        const invalidPending = fixture.service.registerPending(invalidPath);
        const invalidInspection = await fixture.service.inspect({
          pendingImportId: invalidPending.pendingImportId,
          operationId: randomUUID(),
        });
        assert.equal(invalidInspection.status, "ready");
        if (invalidInspection.status !== "ready") assert.fail("expected ready");
        const invalidPathId = invalidInspection.inspection.recordPaths[0]?.id;
        assert.ok(invalidPathId);
        const stateAfterCommit = currentImportState(fixture);
        return fixture.service.stage({
          pendingImportId: invalidPending.pendingImportId,
          operationId: randomUUID(),
          expectedGeneration: stateAfterCommit.generation,
          expectedSnapshotId: stateAfterCommit.snapshotId,
          selection: termSelection(invalidPathId),
          fields: {
            source: mapField("source", "source"),
            target: mapField("target", "target"),
          },
        });
      })();
      assert.equal(invalid.counts.invalid, 1);
      await assert.rejects(
        () => commitBatch(fixture, invalid.batchId),
        /KNOWLEDGE_IMPORT_CONFLICTS_UNRESOLVED/u,
      );
      await fixture.service.setDecisions({
        batchId: invalid.batchId,
        decisions: [{
          rowOrdinal: invalid.rows[0]!.ordinal,
          decision: { action: "skip" },
        }],
      });
      const skipped = await commitBatch(fixture, invalid.batchId);
      assert.equal(skipped.invalid, 1);
      assert.equal(skipped.skipped, 1);
      assert.equal(skipped.committed, 0);
    } finally {
      fixture.store.close();
    }
  });
});

test("binds case-equivalent imports to the existing canonical knowledge identity", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = importFixture(directory);
    try {
      const state = currentImportState(fixture);
      fixture.store.commitKnowledgeCommands({
        requestId: randomUUID(),
        runId: fixture.runId,
        expectedGeneration: state.generation,
        expectedSnapshotId: state.snapshotId,
        commands: [{
          type: "upsert",
          objectType: "term",
          normalizedSubject: "archon",
          kind: "lexical_anchor",
          expectedRevision: null,
          expectedScopeRevision: null,
          fieldPatch: {
            sourceForm: "Archon",
            canonicalSource: "archon",
            target: "Existing",
          },
          ownedFields: ["/sourceForm", "/canonicalSource", "/target"],
          scope: "book",
          evidence: [],
          origin: "manual",
        }],
      });
      const path = join(directory, "case-equivalent.json");
      await writeFile(path, JSON.stringify([
        { source: "Archon", target: "Imported" },
      ]), "utf8");
      let staged = await stageTerms(
        fixture.service,
        path,
        currentImportState(fixture),
      );
      assert.equal(staged.counts.conflict, 1);
      staged = await fixture.service.setDecisions({
        batchId: staged.batchId,
        decisions: [{
          rowOrdinal: staged.rows[0]!.ordinal,
          decision: { action: "use_imported" },
        }],
      });

      const committed = await commitBatch(fixture, staged.batchId);
      assert.equal(committed.updated, 1);
      const active = fixture.store.knowledgeRevisions(fixture.runId)
        .filter((revision) => revision.status === "active");
      assert.equal(active.at(-1)?.normalizedSubject, "archon");
      assert.equal(
        (active.at(-1)?.payload as { target?: string } | undefined)?.target,
        "Imported",
      );
    } finally {
      fixture.store.close();
    }
  });
});

test("merges aliases through the canonical identity selected during staging", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = importFixture(directory);
    try {
      const state = currentImportState(fixture);
      fixture.store.commitKnowledgeCommands({
        requestId: randomUUID(),
        runId: fixture.runId,
        expectedGeneration: state.generation,
        expectedSnapshotId: state.snapshotId,
        commands: [{
          type: "upsert",
          objectType: "term",
          normalizedSubject: "archon",
          kind: "lexical_anchor",
          expectedRevision: null,
          expectedScopeRevision: null,
          fieldPatch: {
            sourceForm: "Archon",
            canonicalSource: "archon",
            target: "Existing",
          },
          ownedFields: ["/sourceForm", "/canonicalSource", "/target"],
          scope: "book",
          evidence: [],
          origin: "manual",
        }],
      });
      const path = join(directory, "case-alias.json");
      await writeFile(path, JSON.stringify([
        { source: "ARCHON", target: "Imported" },
      ]), "utf8");
      let staged = await stageTerms(
        fixture.service,
        path,
        currentImportState(fixture),
      );
      staged = await fixture.service.setDecisions({
        batchId: staged.batchId,
        decisions: [{
          rowOrdinal: staged.rows[0]!.ordinal,
          decision: { action: "merge_as_alias" },
        }],
      });

      const committed = await commitBatch(fixture, staged.batchId);
      assert.equal(committed.merged, 1);
      const active = fixture.store.knowledgeRevisions(fixture.runId)
        .filter((revision) => revision.status === "active").at(-1);
      assert.equal(active?.normalizedSubject, "archon");
      assert.deepEqual(
        (active?.payload as { sourceForms?: readonly string[] } | undefined)
          ?.sourceForms,
        ["ARCHON", "Archon", "archon"],
      );
    } finally {
      fixture.store.close();
    }
  });
});

test("stages and commits the same import idempotently", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "Magistrate" },
    ]), "utf8");
    const fixture = importFixture(directory);
    try {
      const firstStage = await stageTerms(fixture.service, path);
      const duplicateStage = await stageTerms(fixture.service, path);
      assert.equal(duplicateStage.batchId, firstStage.batchId);
      const firstCommit = await commitBatch(fixture, firstStage.batchId);
      await assert.rejects(
        stageTerms(fixture.service, path),
        /KNOWLEDGE_IMPORT_ALREADY_COMMITTED/u,
      );
      const revisionCount = fixture.store.knowledgeRevisions(fixture.runId).length;
      const replay = await fixture.service.commit({
        batchId: firstStage.batchId,
        operationId: randomUUID(),
        expectedGeneration: 0,
        expectedSnapshotId: createKnowledgeSnapshot(fixture.runId, []).id,
      });
      assert.deepEqual(replay, firstCommit);
      assert.equal(
        fixture.store.knowledgeRevisions(fixture.runId).length,
        revisionCount,
      );
    } finally {
      fixture.store.close();
    }
  });
});

test("four formats produce identical knowledge", async () => {
  await withTempDirectory(async (directory) => {
    const records = Array.from({ length: 20 }, (_item, index) => ({
      source: index === 0 ? "Archon" : `Term-${index.toString().padStart(2, "0")}`,
      target: index === 0 ? "执政官" : `术语-${index.toString().padStart(2, "0")}`,
    }));
    const formats = ["json", "yaml", "csv", "xlsx"] as const;
    const summaries: unknown[] = [];
    for (const format of formats) {
      const formatDirectory = join(directory, format);
      await mkdir(formatDirectory);
      const path = join(formatDirectory, `terms.${format}`);
      if (format === "json") {
        await writeFile(path, JSON.stringify(records), "utf8");
      } else if (format === "yaml") {
        await writeFile(path, [
          "records:",
          ...records.flatMap((record) => [
            `  - source: "${record.source}"`,
            `    target: "${record.target}"`,
          ]),
          "",
        ].join("\n"), "utf8");
      } else if (format === "csv") {
        await writeFile(path, [
          "source,target",
          ...records.map((record) => `${record.source},${record.target}`),
          "",
        ].join("\n"), "utf8");
      } else {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Terms");
        sheet.addRow(["source", "target"]);
        for (const record of records) {
          sheet.addRow([record.source, record.target]);
        }
        await workbook.xlsx.writeFile(path);
      }

      const fixture = importFixture(formatDirectory);
      try {
        const staged = await stageTermsFromAnyFormat(fixture, path);
        const committed = await commitBatch(fixture, staged.batchId);
        const revisions = fixture.store.knowledgeRevisions(fixture.runId);
        const snapshot = fixture.store.latestKnowledgeSnapshot(fixture.runId);
        summaries.push({
          counts: {
            added: committed.added,
            updated: committed.updated,
            merged: committed.merged,
            skipped: committed.skipped,
            invalid: committed.invalid,
            committed: committed.committed,
          },
          generation: committed.generation,
          snapshotId: committed.snapshotId,
          revisions,
          snapshot,
        });
      } finally {
        fixture.store.close();
      }
    }
    assert.equal(summaries.length, formats.length);
    for (const summary of summaries.slice(1)) {
      assert.deepEqual(summary, summaries[0]);
    }
  });
});

test("uses the complete source file hash even when changed columns are unmapped", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "Magistrate", privateNote: "first" },
    ]), "utf8");
    const fixture = importFixture(directory);
    try {
      const first = await stageTerms(fixture.service, path);
      await writeFile(path, JSON.stringify([
        { source: "Archon", target: "Magistrate", privateNote: "second" },
      ]), "utf8");
      const second = await stageTerms(fixture.service, path);
      assert.notEqual(second.batchId, first.batchId);
      assert.equal((await fixture.service.listStaged()).length, 2);
    } finally {
      fixture.store.close();
    }
  });
});

test("rejects a source file that changes after inspection", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "Magistrate" },
    ]), "utf8");
    const fixture = importFixture(directory);
    try {
      const pending = fixture.service.registerPending(path);
      const inspection = await fixture.service.inspect({
        pendingImportId: pending.pendingImportId,
        operationId: randomUUID(),
      });
      assert.equal(inspection.status, "ready");
      if (inspection.status !== "ready") assert.fail("expected ready import");
      const recordPathId = inspection.inspection.recordPaths[0]?.id;
      assert.ok(recordPathId);
      await writeFile(path, JSON.stringify([
        { source: "Archon", target: "Changed after inspection" },
      ]), "utf8");

      await assert.rejects(
        () => fixture.service.stage({
          pendingImportId: pending.pendingImportId,
          operationId: randomUUID(),
          expectedGeneration: 0,
          expectedSnapshotId: createKnowledgeSnapshot(
            fixture.runId,
            [],
          ).id,
          selection: termSelection(recordPathId),
          fields: {
            source: mapField("source", "source"),
            target: mapField("target", "target"),
          },
        }),
        /KNOWLEDGE_IMPORT_SOURCE_CHANGED/u,
      );
      assert.equal((await fixture.service.listStaged()).length, 0);
    } finally {
      fixture.store.close();
    }
  });
});

test("rolls back additions and updates as one idempotent batch", async () => {
  await withTempDirectory(async (directory) => {
    const additionPath = join(directory, "addition.json");
    await writeFile(additionPath, JSON.stringify([
      { source: "Archon", target: "Magistrate" },
    ]), "utf8");
    const fixture = importFixture(directory);
    try {
      const addition = await stageTerms(fixture.service, additionPath);
      await commitBatch(fixture, addition.batchId);
      const first = await rollbackBatch(fixture, addition.batchId);
      const historyCount = fixture.store.knowledgeRevisions(fixture.runId).length;
      assert.equal(
        fixture.store.knowledgeRevisions(fixture.runId).at(-1)?.status,
        "superseded",
      );
      assert.equal(
        fixture.store.latestKnowledgeSnapshot(fixture.runId).revisions.length,
        0,
      );
      const replay = await fixture.service.rollback({
        batchId: addition.batchId,
        operationId: randomUUID(),
        expectedGeneration: 0,
        expectedSnapshotId: "stale",
      });
      assert.deepEqual(replay, first);
      assert.equal(
        fixture.store.knowledgeRevisions(fixture.runId).length,
        historyCount,
      );

      const restaged = await stageTerms(
        fixture.service,
        additionPath,
        currentImportState(fixture),
      );
      assert.notEqual(restaged.batchId, addition.batchId);
      assert.equal(restaged.counts.ready, 1);
    } finally {
      fixture.store.close();
    }
  });
});

test("rollback restores the pre-import catalog value after an imported update", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = importFixture(directory);
    try {
      const state = currentImportState(fixture);
      fixture.store.commitKnowledgeCommands({
        requestId: randomUUID(),
        runId: fixture.runId,
        expectedGeneration: state.generation,
        expectedSnapshotId: state.snapshotId,
        commands: [{
          type: "upsert",
          objectType: "term",
          normalizedSubject: "Archon",
          kind: "lexical_anchor",
          expectedRevision: null,
          expectedScopeRevision: null,
          fieldPatch: {
            sourceForm: "Archon",
            canonicalSource: "Archon",
            target: "Original",
          },
          ownedFields: ["/sourceForm", "/canonicalSource", "/target"],
          scope: "book",
          evidence: [],
          origin: "manual",
        }],
      });
      const path = join(directory, "update.json");
      await writeFile(path, JSON.stringify([
        { source: "Archon", target: "Imported" },
      ]), "utf8");
      const pending = fixture.service.registerPending(path);
      const inspected = await fixture.service.inspect({
        pendingImportId: pending.pendingImportId,
        operationId: randomUUID(),
      });
      assert.equal(inspected.status, "ready");
      if (inspected.status !== "ready") assert.fail("expected ready");
      const recordPathId = inspected.inspection.recordPaths[0]?.id;
      assert.ok(recordPathId);
      const beforeStage = currentImportState(fixture);
      let staged = await fixture.service.stage({
        pendingImportId: pending.pendingImportId,
        operationId: randomUUID(),
        expectedGeneration: beforeStage.generation,
        expectedSnapshotId: beforeStage.snapshotId,
        selection: termSelection(recordPathId),
        fields: {
          source: mapField("source", "source"),
          target: mapField("target", "target"),
        },
      });
      staged = await fixture.service.setDecisions({
        batchId: staged.batchId,
        decisions: [{
          rowOrdinal: staged.rows[0]!.ordinal,
          decision: { action: "use_imported" },
        }],
      });
      assert.equal(staged.unresolved, 0);
      await commitBatch(fixture, staged.batchId);
      assert.equal(
        (fixture.store.knowledgeRevisions(fixture.runId).at(-1)?.payload as {
          target?: string;
        }).target,
        "Imported",
      );

      await rollbackBatch(fixture, staged.batchId);
      const restored = fixture.store.knowledgeRevisions(fixture.runId).at(-1);
      assert.equal(restored?.status, "active");
      assert.equal(restored?.authority?.origin, "rollback");
      assert.equal(
        (restored?.payload as { target?: string } | undefined)?.target,
        "Original",
      );
    } finally {
      fixture.store.close();
    }
  });
});

test("rollback rejects a stale book or project catalog generation", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "terms.json");
    await writeFile(path, JSON.stringify([
      { source: "Archon", target: "Magistrate" },
    ]), "utf8");
    const fixture = importFixture(directory);
    try {
      const staged = await stageTerms(fixture.service, path);
      await commitBatch(fixture, staged.batchId);

      const secondRunId = "run-import-second";
      const secondSnapshot = createKnowledgeSnapshot(secondRunId, []);
      fixture.store.createTranslationRun({
        runId: secondRunId,
        sourceVersion: "source-import",
        protocolVersion: "test",
        modelId: "test",
        initialSnapshotId: secondSnapshot.id,
        initialSnapshot: secondSnapshot,
      });
      const secondState = fixture.store.knowledgeState(secondRunId);
      fixture.store.commitKnowledgeCommands({
        requestId: randomUUID(),
        runId: secondRunId,
        expectedGeneration: secondState.generation,
        expectedSnapshotId: secondState.snapshotId,
        commands: [{
          type: "upsert",
          objectType: "term",
          normalizedSubject: "Autarch",
          kind: "lexical_anchor",
          expectedRevision: null,
          expectedScopeRevision: null,
          fieldPatch: {
            sourceForm: "Autarch",
            canonicalSource: "Autarch",
            target: "Sovereign",
          },
          ownedFields: ["/sourceForm", "/canonicalSource", "/target"],
          scope: "project",
          evidence: [],
          origin: "manual",
        }],
      });

      await assert.rejects(
        () => rollbackBatch(fixture, staged.batchId),
        /KNOWLEDGE_SCOPE_GENERATION_CONFLICT/u,
      );
      assert.equal(
        fixture.store.knowledgeRevisions(fixture.runId).at(-1)?.status,
        "active",
      );
    } finally {
      fixture.store.close();
    }
  });
});

for (const checkpoint of [
  "knowledge_import_stage_before_commit",
  "knowledge_import_before_commit",
  "knowledge_import_rollback_before_commit",
] as const satisfies readonly FaultCheckpoint[]) {
  test(`keeps the whole import atomic after injected ${checkpoint}`, async () => {
    await withTempDirectory(async (directory) => {
      let armed = checkpoint === "knowledge_import_stage_before_commit";
      let injected = false;
      const fixture = importFixture(directory, {
        checkpoint(name) {
          if (armed && !injected && name === checkpoint) {
            injected = true;
            throw new Error(`injected ${name}`);
          }
        },
      });
      const path = join(directory, "terms.json");
      await writeFile(path, JSON.stringify([
        { source: "Archon", target: "Magistrate" },
      ]), "utf8");
      try {
        if (checkpoint === "knowledge_import_stage_before_commit") {
          await assert.rejects(
            () => stageTerms(fixture.service, path),
            /injected knowledge_import_stage_before_commit/u,
          );
          assert.equal((await fixture.service.listStaged()).length, 0);
          assert.equal(fixture.store.knowledgeRevisions(fixture.runId).length, 0);
          return;
        }
        const staged = await stageTerms(fixture.service, path);
        if (checkpoint === "knowledge_import_before_commit") {
          armed = true;
          const before = currentImportState(fixture);
          await assert.rejects(
            () => commitBatch(fixture, staged.batchId),
            /injected knowledge_import_before_commit/u,
          );
          assert.deepEqual(currentImportState(fixture), before);
          assert.equal(fixture.store.knowledgeRevisions(fixture.runId).length, 0);
          assert.equal((await fixture.service.listStaged()).length, 1);
          return;
        }
        await commitBatch(fixture, staged.batchId);
        armed = true;
        const before = currentImportState(fixture);
        const history = fixture.store.knowledgeRevisions(fixture.runId);
        await assert.rejects(
          () => rollbackBatch(fixture, staged.batchId),
          /injected knowledge_import_rollback_before_commit/u,
        );
        assert.deepEqual(currentImportState(fixture), before);
        assert.deepEqual(
          fixture.store.knowledgeRevisions(fixture.runId),
          history,
        );
      } finally {
        fixture.store.close();
      }
    });
  });
}
