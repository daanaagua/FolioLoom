import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BookWindowPlan } from "../src/fullbook/types.js";
import {
  KnowledgeQueryService,
  type KnowledgeRecordPageQuery,
  type KnowledgeQueryRecord,
  type KnowledgeQuerySource,
} from "../src/knowledge/knowledge-query.js";
import { sourceFormsFromRevision } from "../src/knowledge/knowledge-source-forms.js";
import { KnowledgeStore } from "../src/knowledge/knowledge-store.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { blockId } from "../src/source/block-builder.js";
import type { LosslessBlock } from "../src/source/types.js";
import {
  LosslessBookStore,
  type CertifiedSourceInput,
} from "../src/storage/lossless-book-store.js";

function revision(
  normalizedSubject: string,
  kind: string,
  payload: unknown,
  alternatives: readonly unknown[] = [payload],
) {
  return new KnowledgeStore().appendRevision({
    normalizedSubject,
    kind,
    payload,
    alternatives,
    status: "active",
    authority: {
      origin: "manual",
      scope: "book",
      ownedFields: ["/target"],
    },
  });
}

function record(
  id: string,
  normalizedSubject: string,
  objectType: KnowledgeQueryRecord["objectType"] = "term",
  overrides: Partial<KnowledgeQueryRecord> = {},
): KnowledgeQueryRecord {
  const current = revision(
    normalizedSubject,
    objectType === "term" ? "term_sense" : "entity_identity",
    {
      sourceForm: normalizedSubject,
      target: `${normalizedSubject}-translated`,
    },
  );
  return {
    id,
    objectType,
    revision: current,
    scopeRevision: { scope: "book", revision: current.revision },
    evidence: [],
    history: [current],
    impacts: [],
    ...overrides,
  };
}

class FixtureSource implements KnowledgeQuerySource {
  constructor(
    readonly generation: string,
    readonly records: readonly KnowledgeQueryRecord[],
  ) {}

  listKnowledgeRecords(): readonly KnowledgeQueryRecord[] {
    return this.records;
  }

  knowledgeRecord(id: string): KnowledgeQueryRecord | undefined {
    return this.records.find((item) => item.id === id);
  }
}

class PagedFixtureSource implements KnowledgeQuerySource {
  legacyListCalls = 0;
  readonly requests: KnowledgeRecordPageQuery[] = [];

  constructor(
    readonly generation: string,
    readonly records: readonly KnowledgeQueryRecord[],
  ) {}

  listKnowledgeRecords(): readonly KnowledgeQueryRecord[] {
    this.legacyListCalls += 1;
    throw new Error("legacy full materialization must not be used");
  }

  queryKnowledgeRecords(
    request: KnowledgeRecordPageQuery,
  ): readonly KnowledgeQueryRecord[] {
    this.requests.push(request);
    const after = request.after;
    return this.records
      .filter((item) => after === undefined
        || item.revision.normalizedSubject > after.normalizedSubject
        || (
          item.revision.normalizedSubject === after.normalizedSubject
          && (
            item.revision.kind > after.kind
            || (item.revision.kind === after.kind && item.id > after.id)
          )
        ))
      .slice(0, request.limit);
  }

  knowledgeRecord(id: string): KnowledgeQueryRecord | undefined {
    return this.records.find((item) => item.id === id);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface StoreQueryFixture {
  readonly store: LosslessBookStore;
  readonly runId: string;
  readonly sourceVersion: string;
  readonly blocks: readonly LosslessBlock[];
}

function storeQueryFixture(
  sourceTexts: readonly string[],
  options: {
    readonly language?: string;
    readonly translatedIndexes?: readonly number[];
  } = {},
): StoreQueryFixture {
  const sourceVersion = `source-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const canonical = sourceTexts.join("");
  let offset = 0;
  const blocks = sourceTexts.map((sourceText, globalIndex): LosslessBlock => {
    const canonicalStart = offset;
    offset += [...sourceText].length;
    return {
      id: blockId(
        sourceVersion,
        canonicalStart,
        offset,
        sourceText,
      ),
      sourceVersion,
      canonicalStart,
      canonicalEnd: offset,
      sourceText,
      sourceHash: sha256(sourceText),
      globalIndex,
      tokenCount: Math.max(1, sourceText.split(/\s+/u).length),
      structureId: null,
      structureTitle: null,
    };
  });
  const path = join(
    mkdtempSync(join(tmpdir(), "folioloom-knowledge-query-store-")),
    "book.db",
  );
  const store = new LosslessBookStore(path);
  const source: CertifiedSourceInput = {
    sourceVersion,
    rawSha256: sha256(canonical),
    canonicalSha256: sha256(canonical),
    canonicalChars: [...canonical].length,
    coordinateUnit: "unicode_scalar",
    sourceFormat: "txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: options.language ?? "en",
    sourceLanguageProfileVersion: "source-language-profile-5",
    sourceLanguageCompatibilityMode: false,
    ranges: [{
      rangeId: "range-0",
      canonicalStart: 0,
      canonicalEnd: [...canonical].length,
      originKind: "text",
      originRef: "fixture.txt",
      transformation: "identity",
    }],
  };
  store.registerSource(source);
  store.replaceDerivedPlan(sourceVersion, { blocks, annotations: [] });
  const snapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion,
    protocolVersion: "lossless-v5-test",
    modelId: "fixture-model",
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
  });
  const windows: BookWindowPlan[] = blocks.map((block, ordinal) => ({
    windowId: `window-${ordinal}`,
    ordinal,
    chapterId: "chapter-0",
    chapterTitle: "Fixture",
    blockIds: [block.id],
    globalIndexes: [block.globalIndex],
    sourceTokens: block.tokenCount,
    sourceChars: [...block.sourceText].length,
    oversized: false,
  }));
  store.initializeWindowPlan(runId, windows);
  for (const index of options.translatedIndexes ?? []) {
    const block = blocks[index] as LosslessBlock;
    const windowId = `window-${index}`;
    store.claimWindow(runId, windowId);
    store.stageWindow({
      runId,
      windowId,
      snapshotId: snapshot.id,
      status: "completed",
      translations: [{
        blockId: block.id,
        sourceHash: block.sourceHash,
        text: `译文 ${index}`,
      }],
      knowledgeCandidates: [],
      styleTail: "",
      budget: {},
      warnings: [],
    });
    store.promoteStagedWindow(runId, windowId);
  }
  return { store, runId, sourceVersion, blocks };
}

function commitKnowledge(
  fixture: StoreQueryFixture,
  commands: readonly unknown[],
): void {
  const state = fixture.store.knowledgeState(fixture.runId);
  fixture.store.commitKnowledgeCommands({
    requestId: randomUUID(),
    runId: fixture.runId,
    expectedGeneration: state.generation,
    expectedSnapshotId: state.snapshotId,
    commands,
  });
}

function termCommand(
  normalizedSubject: string,
  sourceForm: string,
  evidence: readonly unknown[] = [],
): unknown {
  return {
    type: "upsert",
    objectType: "term",
    normalizedSubject,
    kind: "lexical_anchor",
    expectedRevision: null,
    expectedScopeRevision: null,
    fieldPatch: {
      sourceForm,
      canonicalSource: normalizedSubject,
      target: `${normalizedSubject}-translated`,
      locked: true,
      policy: "locked",
      note: "fixture",
    },
    ownedFields: ["/target", "/locked", "/policy", "/note"],
    scope: "book",
    evidence,
    origin: "manual",
  };
}

test("extracts only explicit source forms from payloads and alternatives", () => {
  const item = revision(
    "entity-alias:piaton",
    "entity_alias_link",
    {
      sourceForm: "Piaton",
      subjectForms: ["The slave"],
      fact: "Typhon appears in prose but must not become a source form.",
    },
    [{
      canonicalSource: "Piaton",
      normalizedForms: ["piaton"],
      note: "The heart is controlled by Piaton.",
    }],
  );

  assert.deepEqual(sourceFormsFromRevision(item), [
    "Piaton",
    "The slave",
    "piaton",
  ]);
});

test("uses an opaque stable cursor without duplicates after equal labels", () => {
  const source = new FixtureSource("generation-1", [
    record("record-2", "archon"),
    record("record-1", "archon"),
    record("record-3", "piaton"),
  ]);
  const service = new KnowledgeQueryService(source);

  const first = service.list({ limit: 2 });
  const second = service.list({
    limit: 2,
    cursor: first.nextCursor ?? undefined,
  });

  assert.deepEqual(first.items.map((item) => item.id), ["record-1", "record-2"]);
  assert.deepEqual(second.items.map((item) => item.id), ["record-3"]);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.id)).size,
    3,
  );
  assert.match(first.nextCursor ?? "", /^[A-Za-z0-9_-]+$/u);
});

test("uses SQLite-compatible UTF-8 ordering for supplementary-plane cursors", () => {
  const source = new FixtureSource("generation-1", [
    record("record-supplementary", "\u{10000}"),
    record("record-private-use", "\uE000"),
  ]);
  const service = new KnowledgeQueryService(source);

  const first = service.list({ limit: 1 });
  const second = service.list({
    limit: 1,
    cursor: first.nextCursor ?? undefined,
  });

  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.normalizedSubject),
    ["\uE000", "\u{10000}"],
  );
});

test("pushes normalized filters and seek pagination into a paged query source", () => {
  const source = new PagedFixtureSource("generation-1", [
    record("record-1", "archon"),
    record("record-2", "archon"),
    record("record-3", "archpriest"),
  ]);
  const service = new KnowledgeQueryService(source);

  const first = service.list({
    search: "  ARCH  ",
    objectTypes: ["term", "term"],
    statuses: ["active"],
    origins: ["manual"],
    scopes: ["book"],
    limit: 2,
  });
  assert.deepEqual(first.items.map((item) => item.id), [
    "record-1",
    "record-2",
  ]);
  assert.ok(first.nextCursor);
  assert.equal(source.legacyListCalls, 0);
  assert.deepEqual(source.requests[0], {
    search: "arch",
    objectTypes: ["term"],
    statuses: ["active"],
    origins: ["manual"],
    scopes: ["book"],
    limit: 3,
  });

  const second = service.list({
    search: "arch",
    objectTypes: ["term"],
    statuses: ["active"],
    origins: ["manual"],
    scopes: ["book"],
    cursor: first.nextCursor ?? undefined,
    limit: 2,
  });
  assert.deepEqual(second.items.map((item) => item.id), ["record-3"]);
  assert.deepEqual(source.requests[1]?.after, {
    normalizedSubject: "archon",
    kind: "term_sense",
    id: "record-2",
  });
  assert.equal(source.legacyListCalls, 0);
});

test("binds cursors to normalized filters and source generation", () => {
  const records = [
    record("record-a", "archon"),
    record("record-b", "autarch"),
  ];
  const firstService = new KnowledgeQueryService(
    new FixtureSource("generation-1", records),
  );
  const first = firstService.list({
    search: "  ARCH  ",
    objectTypes: ["term"],
    limit: 1,
  });
  assert.ok(first.nextCursor);

  assert.doesNotThrow(() => firstService.list({
    search: "arch",
    objectTypes: ["term", "term"],
    cursor: first.nextCursor ?? undefined,
    limit: 1,
  }));
  assert.throws(
    () => firstService.list({
      search: "aut",
      objectTypes: ["term"],
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    }),
    /KNOWLEDGE_CURSOR_INVALID/u,
  );
  assert.throws(
    () => new KnowledgeQueryService(
      new FixtureSource("generation-2", records),
    ).list({
      search: "arch",
      objectTypes: ["term"],
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    }),
    /KNOWLEDGE_CURSOR_INVALID/u,
  );
});

test("strictly rejects malformed and non-canonical cursors", () => {
  const service = new KnowledgeQueryService(
    new FixtureSource("generation-1", [record("record-a", "archon")]),
  );

  for (const cursor of [
    "",
    "not+base64url",
    Buffer.from("{}", "utf8").toString("base64url"),
    `${Buffer.from("{}", "utf8").toString("base64url")}A`,
  ]) {
    assert.throws(
      () => service.list({ limit: 1, cursor }),
      /KNOWLEDGE_CURSOR_INVALID/u,
    );
  }
});

test("filters semantic list rows and returns detail lazily", () => {
  const term = record("term-1", "archon", "term", {
    evidence: [{
      kind: "source_block",
      blockId: "block-4",
      quote: "The Archon entered.",
    }],
    impacts: [{
      blockId: "block-4",
      globalIndex: 4,
      sourceVersion: "source-v1",
      status: "pending",
      reason: "explicit_source_form_match",
      sourceExcerpt: "The Archon entered.",
    }],
  });
  const entity = record("entity-1", "piaton", "entity", {
    revision: new KnowledgeStore().appendRevision({
      normalizedSubject: "piaton",
      kind: "entity_identity",
      payload: { canonicalName: "Piaton" },
      status: "needs_revalidate",
      authority: {
        origin: "import",
        scope: "project",
        ownedFields: ["/canonicalName"],
      },
    }),
    scopeRevision: { scope: "project", revision: 7 },
  });
  const service = new KnowledgeQueryService(
    new FixtureSource("generation-1", [entity, term]),
  );

  const page = service.list({
    objectTypes: ["entity"],
    statuses: ["needs_revalidate"],
    origins: ["import"],
    scopes: ["project"],
    search: "PIA",
    limit: 20,
  });
  assert.deepEqual(page.items.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    objectType: item.objectType,
    origin: item.origin,
    scope: item.scope,
  })), [{
    id: "entity-1",
    displayName: "Piaton",
    objectType: "entity",
    origin: "import",
    scope: "project",
  }]);

  const detail = service.detail("term-1");
  assert.equal(detail.current.id, "term-1");
  assert.deepEqual(detail.sourceForms, ["archon"]);
  assert.equal(detail.evidence[0]?.quote, "The Archon entered.");
  assert.deepEqual(detail.impacts.map((item) => item.globalIndex), [4]);
  assert.throws(() => service.detail("missing"), /KNOWLEDGE_NOT_FOUND/u);
});

test("adapts a run into a stable query generation with catalog history and exact evidence", () => {
  const fixture = storeQueryFixture(["The Archon entered."], {
    translatedIndexes: [0],
  });
  try {
    const [block] = fixture.blocks;
    commitKnowledge(fixture, [termCommand("archon", "Archon", [{
      kind: "source_block",
      blockId: block!.id,
      canonicalStart: block!.canonicalStart + 4,
      canonicalEnd: block!.canonicalStart + 10,
      quote: "Archon",
    }])]);

    const source = fixture.store.knowledgeQuerySource(fixture.runId);
    assert.equal(typeof source.queryKnowledgeRecords, "function");
    const service = new KnowledgeQueryService(source);
    const page = service.list({ limit: 20 });
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0]?.scopeRevision, {
      scope: "book",
      revision: 1,
    });

    const detail = service.detail(page.items[0]!.id);
    assert.equal(detail.current.objectType, "term");
    assert.equal(detail.history.length, 1);
    assert.deepEqual(detail.evidence, [{
      kind: "source_block",
      blockId: block!.id,
      canonicalStart: block!.canonicalStart + 4,
      canonicalEnd: block!.canonicalStart + 10,
      quote: "Archon",
    }]);
    assert.deepEqual(detail.impacts.map((impact) => ({
      globalIndex: impact.globalIndex,
      excerpt: impact.sourceExcerpt,
    })), [{
      globalIndex: 0,
      excerpt: "The Archon entered.",
    }]);

    commitKnowledge(fixture, [{
      ...termCommand("autarch", "Autarch") as Record<string, unknown>,
      expectedRevision: null,
      expectedScopeRevision: null,
    }]);
    assert.throws(
      () => source.listKnowledgeRecords(),
      /KNOWLEDGE_QUERY_SOURCE_STALE/u,
    );
    assert.notEqual(
      source.generation,
      fixture.store.knowledgeQuerySource(fixture.runId).generation,
    );
  } finally {
    fixture.store.close();
  }
});

test("pushes store search, filters, and seek cursors into SQLite", () => {
  const fixture = storeQueryFixture(["The Archon met the Autarch."]);
  try {
    commitKnowledge(fixture, [
      termCommand("archon", "Archon"),
      termCommand("autarch", "Autarch"),
      {
        type: "upsert",
        objectType: "memory",
        normalizedSubject: "memory:archon-audience",
        kind: "narrative_memory",
        expectedRevision: null,
        expectedScopeRevision: null,
        fieldPatch: {
          summary: "The audience happened before dawn.",
        },
        ownedFields: ["/summary"],
        scope: "book",
        evidence: [],
        origin: "manual",
      },
    ]);
    const service = new KnowledgeQueryService(
      fixture.store.knowledgeQuerySource(fixture.runId),
    );
    const first = service.list({
      search: " ARCH ",
      objectTypes: ["term"],
      statuses: ["active"],
      origins: ["manual"],
      scopes: ["book"],
      limit: 1,
    });
    assert.deepEqual(
      first.items.map((item) => item.normalizedSubject),
      ["archon"],
    );
    assert.ok(first.nextCursor);

    const second = service.list({
      search: "arch",
      objectTypes: ["term"],
      statuses: ["active"],
      origins: ["manual"],
      scopes: ["book"],
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    assert.deepEqual(
      second.items.map((item) => item.normalizedSubject),
      ["autarch"],
    );
    assert.equal(second.nextCursor, null);
  } finally {
    fixture.store.close();
  }
});

test("pushes exact lookup, bounded relations, and diagnostics into SQLite", () => {
  const fixture = storeQueryFixture(["Piaton shared Typhon's body."], {
    translatedIndexes: [0],
  });
  try {
    commitKnowledge(fixture, [
      {
        type: "upsert",
        objectType: "entity",
        normalizedSubject: "piaton",
        kind: "entity_identity",
        expectedRevision: null,
        expectedScopeRevision: null,
        fieldPatch: {
          canonicalName: "Piaton",
          targetName: "皮亚顿",
          entityType: "person",
        },
        ownedFields: ["/canonicalName", "/targetName", "/entityType"],
        scope: "book",
        evidence: [],
        origin: "manual",
      },
      {
        type: "upsert",
        objectType: "relation",
        normalizedSubject: "relation:piaton-typhon",
        kind: "entity_relation",
        expectedRevision: null,
        expectedScopeRevision: null,
        fieldPatch: {
          fromEntityId: "piaton",
          relationType: "shares_body_with",
          toEntityId: "typhon",
        },
        ownedFields: ["/fromEntityId", "/relationType", "/toEntityId"],
        scope: "book",
        evidence: [],
        origin: "manual",
      },
    ]);
    const source = fixture.store.knowledgeQuerySource(fixture.runId);
    assert.equal(typeof source.knowledgeRecordBySubject, "function");
    assert.equal(typeof source.relatedKnowledgeRecords, "function");
    assert.equal(typeof source.knowledgeDiagnostics, "function");

    const entity = source.knowledgeRecordBySubject?.(
      "piaton",
      "entity_identity",
    );
    assert.equal(entity?.revision.normalizedSubject, "piaton");
    assert.deepEqual(
      source.relatedKnowledgeRecords?.(["piaton", entity!.id], 20)
        .map((item) => item.revision.normalizedSubject),
      ["relation:piaton-typhon"],
    );
    assert.deepEqual(source.knowledgeDiagnostics?.(), {
      countsByType: {
        entity: 1,
        relation: 1,
      },
      countsByStatus: {
        active: 2,
      },
      pendingImpacts: 0,
    });
  } finally {
    fixture.store.close();
  }
});

test("writes impacts only for active translations that conservatively match explicit forms", () => {
  const fixture = storeQueryFixture([
    "The Archon entered.",
    "An architectural archway stood empty.",
    "Later the Archon departed.",
  ], {
    translatedIndexes: [0, 1],
  });
  try {
    commitKnowledge(fixture, [
      termCommand("archon", "Archon"),
      {
        type: "upsert",
        objectType: "memory",
        normalizedSubject: "memory:unmatched-prose",
        kind: "narrative_memory",
        expectedRevision: null,
        expectedScopeRevision: null,
        fieldPatch: {
          summary: "The Archon entered, but this prose is not a source form.",
        },
        ownedFields: ["/summary"],
        scope: "book",
        evidence: [],
        origin: "manual",
      },
      termCommand("arch", "arch"),
    ]);

    const service = new KnowledgeQueryService(
      fixture.store.knowledgeQuerySource(fixture.runId),
    );
    const page = service.list({ limit: 20 });
    const bySubject = new Map(page.items.map((item) => [
      item.normalizedSubject,
      service.detail(item.id),
    ]));
    assert.deepEqual(
      bySubject.get("archon")?.impacts.map((impact) => impact.globalIndex),
      [0],
    );
    assert.deepEqual(bySubject.get("memory:unmatched-prose")?.impacts, []);
    assert.deepEqual(bySubject.get("arch")?.impacts, []);
  } finally {
    fixture.store.close();
  }
});

test("uses the registered CJK language profile when matching explicit source forms", () => {
  const fixture = storeQueryFixture([
    "\ud53c\uc544\ud1a4\uc740 \uc785\uc220\uc744 \uc6c0\uc9c1\uc600\ub2e4.",
  ], {
    language: "ko",
    translatedIndexes: [0],
  });
  try {
    commitKnowledge(fixture, [termCommand("piaton", "\ud53c\uc544\ud1a4")]);
    const service = new KnowledgeQueryService(
      fixture.store.knowledgeQuerySource(fixture.runId),
    );
    const item = service.list({ limit: 20 }).items[0]!;
    assert.deepEqual(
      service.detail(item.id).impacts.map((impact) => impact.globalIndex),
      [0],
    );
  } finally {
    fixture.store.close();
  }
});

test("rejects source evidence whose quote does not exactly match its certified range", () => {
  const fixture = storeQueryFixture(["The Archon entered."], {
    translatedIndexes: [0],
  });
  try {
    const [block] = fixture.blocks;
    commitKnowledge(fixture, [termCommand("archon", "Archon", [{
      kind: "source_block",
      blockId: block!.id,
      canonicalStart: block!.canonicalStart + 4,
      canonicalEnd: block!.canonicalStart + 10,
      quote: "Autarch",
    }])]);
    const service = new KnowledgeQueryService(
      fixture.store.knowledgeQuerySource(fixture.runId),
    );
    const item = service.list({ limit: 20 }).items[0]!;
    assert.throws(
      () => service.detail(item.id),
      /KNOWLEDGE_EVIDENCE_POSITION_MISMATCH/u,
    );
  } finally {
    fixture.store.close();
  }
});
