import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopKnowledgeService } from "../src/desktop/desktop-knowledge-service.js";
import { DesktopProjectService } from "../src/desktop/desktop-project-service.js";
import type {
  DesktopKnowledgeMutationRequest,
  DesktopProjectRequest,
  DesktopResult,
} from "../src/desktop/contracts.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { GlobalKnowledgeStore } from "../src/knowledge/global-knowledge-store.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

const SOURCE = "Chapter I\n\nThe Archon entered.\n";

interface Fixture {
  readonly directory: string;
  readonly manifestPath: string;
  readonly storePath: string;
  readonly runId: string;
  readonly globals: GlobalKnowledgeStore;
  readonly request: DesktopProjectRequest;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unwrap<T>(result: DesktopResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
  return result.value;
}

function createFixture(options: { readonly seedTerm?: boolean } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-knowledge-"));
  const rawPath = join(directory, "original.txt");
  const canonicalPath = join(directory, "source.txt");
  const manifestPath = join(directory, "source_manifest.json");
  const storePath = join(directory, "book.db");
  const source = Buffer.from(SOURCE, "utf8");
  writeFileSync(rawPath, source);
  writeFileSync(canonicalPath, source);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: source.length,
    raw_sha256: sha256(source),
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    canonical_path: "source.txt",
    canonical_chars: [...SOURCE].length,
    canonical_sha256: sha256(source),
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: [...SOURCE].length,
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      transformation: "decode+newline-normalize",
      raw_start: 0,
      raw_end: source.length,
    }],
    excluded_raw_ranges: [],
  }), "utf8");

  const context = BookContext.openLossless({ manifestPath });
  const certifiedSource = context.certifiedSource!;
  const blocks = context.losslessBlocks;
  const annotations = context.annotations;
  context.close();

  const runId = "desktop-knowledge-run";
  const store = new LosslessBookStore(storePath);
  store.registerSource(certifiedSource);
  store.replaceDerivedPlan(certifiedSource.sourceVersion, { blocks, annotations });
  const snapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion: certifiedSource.sourceVersion,
    protocolVersion: "lossless-v5-test",
    modelId: "fixture-model",
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
  });
  if (options.seedTerm !== false) {
    const state = store.knowledgeState(runId);
    store.commitKnowledgeCommands({
      requestId: randomUUID(),
      runId,
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
          target: "执政官",
          locked: true,
          policy: "locked",
        },
        ownedFields: ["/target", "/locked", "/policy"],
        scope: "book",
        evidence: [],
        origin: "manual",
      }],
    });
  }
  store.close();

  return {
    directory,
    manifestPath,
    storePath,
    runId,
    globals: new GlobalKnowledgeStore(join(directory, "global.db")),
    request: { manifestPath, storePath, runId },
  };
}

function cleanup(fixture: Fixture): void {
  fixture.globals.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

test("resolves the store and run only from the current trusted project", () => {
  const fixture = createFixture();
  try {
    const service = new DesktopKnowledgeService(
      new DesktopProjectService(),
      fixture.globals,
      () => fixture.request,
    );
    const page = unwrap(service.list({ limit: 50 }));
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.displayName, "Archon");
    assert.equal(JSON.stringify(page).includes("book.db"), false);
    assert.equal(JSON.stringify(page).includes(fixture.directory), false);
  } finally {
    cleanup(fixture);
  }
});

test("persists an edit and returns the newer generation after reopening", () => {
  const fixture = createFixture();
  try {
    const projects = new DesktopProjectService();
    const first = new DesktopKnowledgeService(projects, fixture.globals, () => fixture.request);
    const page = unwrap(first.list({ limit: 20 }));
    const item = page.items[0]!;
    const request: DesktopKnowledgeMutationRequest = {
      requestId: randomUUID(),
      expectedGeneration: page.generation,
      expectedSnapshotId: page.snapshotId,
      command: {
        type: "upsert",
        objectType: "term",
        normalizedSubject: item.normalizedSubject,
        kind: item.kind,
        expectedRevision: item.revision,
        expectedScopeRevision: item.scopeRevision,
        fieldPatch: { target: "阁下" },
        ownedFields: ["/target"],
        scope: "book",
        evidence: [],
        origin: "manual",
      },
    };
    const saved = unwrap(first.mutate(request));
    assert.equal(saved.generation, page.generation + 1);
    assert.equal(saved.detail.fields.target, "阁下");

    const reopened = new DesktopKnowledgeService(
      projects,
      fixture.globals,
      () => fixture.request,
    );
    const next = unwrap(reopened.list({ limit: 20 }));
    assert.equal(next.generation, saved.generation);
    assert.equal(unwrap(reopened.detail(item.id)).fields.target, "阁下");
  } finally {
    cleanup(fixture);
  }
});

test("returns stable errors when no current project exists", () => {
  const fixture = createFixture();
  try {
    const service = new DesktopKnowledgeService(
      new DesktopProjectService(),
      fixture.globals,
      () => undefined,
    );
    const result = service.list({ limit: 20 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DESKTOP_PROJECT_NOT_SELECTED");
      assert.equal(JSON.stringify(result).includes(fixture.directory), false);
    }
  } finally {
    cleanup(fixture);
  }
});

test("synchronizes newer scoped knowledge before opening a stale run read snapshot", () => {
  const fixture = createFixture();
  try {
    const store = new LosslessBookStore(fixture.storePath);
    const sourceVersion = store.listTranslationRuns()[0]!.sourceVersion;
    const staleRunId = "desktop-stale-run";
    const staleSnapshot = createKnowledgeSnapshot(staleRunId, []);
    store.createTranslationRun({
      runId: staleRunId,
      sourceVersion,
      protocolVersion: "lossless-v5-test",
      modelId: "fixture-model",
      initialSnapshotId: staleSnapshot.id,
      initialSnapshot: staleSnapshot,
    });
    const state = store.knowledgeState(fixture.runId);
    store.commitKnowledgeCommands({
      requestId: randomUUID(),
      runId: fixture.runId,
      expectedGeneration: state.generation,
      expectedSnapshotId: state.snapshotId,
      commands: [{
        type: "upsert",
        objectType: "term",
        normalizedSubject: "piaton",
        kind: "lexical_anchor",
        expectedRevision: null,
        expectedScopeRevision: null,
        fieldPatch: {
          sourceForm: "Piaton",
          target: "皮亚顿",
          locked: true,
          policy: "locked",
        },
        ownedFields: ["/target", "/locked", "/policy"],
        scope: "book",
        evidence: [],
        origin: "manual",
      }],
    });
    const staleBefore = store.knowledgeState(staleRunId);
    store.close();

    const service = new DesktopKnowledgeService(
      new DesktopProjectService(),
      fixture.globals,
      () => ({ ...fixture.request, runId: staleRunId }),
    );
    const page = unwrap(service.list({ limit: 20 }));
    assert.deepEqual(
      page.items.map((item) => item.normalizedSubject),
      ["archon", "piaton"],
    );
    assert.equal(page.generation, staleBefore.generation + 1);
  } finally {
    cleanup(fixture);
  }
});

test("promotes and attaches an immutable global snapshot without raising its authority", () => {
  const source = createFixture();
  const target = createFixture({ seedTerm: false });
  try {
    const sourceService = new DesktopKnowledgeService(
      new DesktopProjectService(),
      source.globals,
      () => source.request,
    );
    const sourcePage = unwrap(sourceService.list({ limit: 20 }));
    const promoted = unwrap(sourceService.promoteGlobal({
      requestId: randomUUID(),
      objectId: sourcePage.items[0]!.id,
      expectedGeneration: sourcePage.generation,
      expectedSnapshotId: sourcePage.snapshotId,
    }));
    assert.equal(promoted.detail.item.scope, "book");
    const globals = unwrap(sourceService.listGlobal({ limit: 20 }));
    assert.equal(globals.items.length, 1);
    const promotedAgain = unwrap(sourceService.promoteGlobal({
      requestId: randomUUID(),
      objectId: sourcePage.items[0]!.id,
      expectedGeneration: sourcePage.generation,
      expectedSnapshotId: sourcePage.snapshotId,
    }));
    assert.equal(promotedAgain.generation, promoted.generation);
    assert.equal(
      unwrap(sourceService.listGlobal({ limit: 20 })).items[0]!.revision,
      globals.items[0]!.revision,
    );

    const targetService = new DesktopKnowledgeService(
      new DesktopProjectService(),
      source.globals,
      () => target.request,
    );
    const targetPage = unwrap(targetService.list({ limit: 20 }));
    const attached = unwrap(targetService.attachGlobal({
      requestId: randomUUID(),
      recordId: globals.items[0]!.recordId,
      revision: globals.items[0]!.revision,
      expectedGeneration: targetPage.generation,
      expectedSnapshotId: targetPage.snapshotId,
    }));
    assert.equal(attached.detail.item.scope, "global");
    assert.equal(attached.detail.item.origin, "import");
    assert.equal(attached.generation, targetPage.generation + 1);
    const persisted = new LosslessBookStore(target.storePath);
    const active = persisted.knowledgeRevisions(target.runId).at(-1);
    persisted.close();
    assert.equal(active?.authority?.scope, "global");
    assert.equal(
      active?.authority?.provenance?.globalRevisionId,
      source.globals.get(
        globals.items[0]!.recordId,
        globals.items[0]!.revision,
      )?.revisionId,
    );
    const attachedAgain = unwrap(targetService.attachGlobal({
      requestId: randomUUID(),
      recordId: globals.items[0]!.recordId,
      revision: globals.items[0]!.revision,
      expectedGeneration: targetPage.generation,
      expectedSnapshotId: targetPage.snapshotId,
    }));
    assert.equal(attachedAgain.generation, attached.generation);
    const inheritedRunId = "desktop-global-inherited-run";
    const inheritanceStore = new LosslessBookStore(target.storePath);
    const sourceVersion = inheritanceStore.listTranslationRuns()[0]!.sourceVersion;
    const inheritedInitial = createKnowledgeSnapshot(inheritedRunId, []);
    inheritanceStore.createTranslationRun({
      runId: inheritedRunId,
      sourceVersion,
      protocolVersion: "lossless-v5-test",
      modelId: "fixture-model",
      initialSnapshotId: inheritedInitial.id,
      initialSnapshot: inheritedInitial,
    });
    const inherited = inheritanceStore.knowledgeRevisions(inheritedRunId).at(-1);
    inheritanceStore.close();
    assert.equal(inherited?.authority?.scope, "global");
    assert.equal(
      inherited?.authority?.provenance?.globalRevisionId,
      source.globals.get(
        globals.items[0]!.recordId,
        globals.items[0]!.revision,
      )?.revisionId,
    );

    const localOverride = unwrap(targetService.mutate({
      requestId: randomUUID(),
      expectedGeneration: attachedAgain.generation,
      expectedSnapshotId: attachedAgain.snapshotId,
      command: {
        type: "upsert",
        objectType: "term",
        normalizedSubject: attachedAgain.detail.item.normalizedSubject,
        kind: attachedAgain.detail.item.kind,
        expectedRevision: attachedAgain.detail.item.revision,
        expectedScopeRevision: attachedAgain.detail.item.scopeRevision,
        fieldPatch: { target: "本书译名" },
        ownedFields: ["/target"],
        scope: "book",
        evidence: [],
        origin: "manual",
      },
    }));
    assert.equal(localOverride.detail.item.scope, "book");
    assert.equal(localOverride.detail.fields.target, "本书译名");
    assert.equal(JSON.stringify(attached).includes(target.directory), false);
  } finally {
    cleanup(source);
    cleanup(target);
  }
});
