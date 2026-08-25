import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { CatalogKnowledgeDocument } from "../src/knowledge/knowledge-commands.js";
import {
  GlobalKnowledgeStore,
  type GlobalKnowledgeRevision,
} from "../src/knowledge/global-knowledge-store.js";

function fixture(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-global-knowledge-"));
  return {
    directory,
    path: join(directory, "global-knowledge.db"),
  };
}

function term(
  normalizedSubject: string,
  target: string,
): CatalogKnowledgeDocument {
  const payload = {
    sourceForm: normalizedSubject,
    canonicalSource: normalizedSubject.toLocaleLowerCase("en-US"),
    target,
    policy: "locked",
    locked: true,
  } as const;
  return {
    objectType: "term",
    normalizedSubject,
    kind: "lexical_anchor",
    payload,
    alternatives: [payload],
    status: "active",
    authority: {
      origin: "manual",
      scope: "book",
      ownedFields: ["/locked", "/policy", "/target"],
      provenance: {
        catalog: "book",
        catalogRevisionId: "run-secret-catalog-revision",
        globalRevisionId: "old-global-revision",
      },
    },
    evidence: [{
      kind: "source_window",
      sourceWindowId: "run-secret-window",
      canonicalStart: 3,
      canonicalEnd: 9,
      quote: "C:\\secret-project\\book.txt",
    }],
  };
}

function style(
  normalizedSubject: string,
  dialogueRegister: string,
): CatalogKnowledgeDocument {
  const payload = { dialogueRegister } as const;
  return {
    objectType: "style",
    normalizedSubject,
    kind: "style_directive",
    payload,
    alternatives: [payload],
    status: "active",
    authority: {
      origin: "manual",
      scope: "project",
      ownedFields: ["/dialogueRegister"],
    },
    evidence: [],
  };
}

function forbidden(
  objectType: "entity" | "alias" | "relation" | "memory",
): CatalogKnowledgeDocument {
  const payloadByType = {
    entity: { canonicalName: "Piaton" },
    alias: { alias: "the slave", entityId: "piaton" },
    relation: {
      fromEntityId: "typhon",
      relationType: "shares_body_with",
      toEntityId: "piaton",
    },
    memory: { summary: "Piaton controls the shared body's heartbeat." },
  } as const;
  const payload = payloadByType[objectType];
  return {
    objectType,
    normalizedSubject: `forbidden-${objectType}`,
    kind: `${objectType}_fact`,
    payload,
    alternatives: [payload],
    status: "active",
    authority: {
      origin: "manual",
      scope: "book",
      ownedFields: [],
    },
    evidence: [],
  };
}

function targetOf(revision: GlobalKnowledgeRevision): unknown {
  return (revision.document.payload as { readonly target?: unknown }).target;
}

test("promotes a term and reopens the exact global revision", () => {
  const item = fixture();
  try {
    const first = new GlobalKnowledgeStore(item.path);
    const promoted = first.promote(term("Archon", "阁下"), {
      expectedRevision: null,
    });
    first.close();

    const reopened = new GlobalKnowledgeStore(item.path);
    assert.deepEqual(reopened.get(promoted.recordId), promoted);
    assert.deepEqual(
      reopened.get(promoted.recordId, promoted.revision),
      promoted,
    );
    reopened.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("permits only reusable terms and styles", () => {
  const item = fixture();
  try {
    const store = new GlobalKnowledgeStore(item.path);
    for (const objectType of ["entity", "alias", "relation", "memory"] as const) {
      assert.throws(
        () => store.promote(forbidden(objectType), { expectedRevision: null }),
        /GLOBAL_SCOPE_FORBIDDEN/u,
      );
    }
    assert.equal(
      store.promote(style("dialogue", "对话简洁而克制"), {
        expectedRevision: null,
      }).objectType,
      "style",
    );
    store.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("uses optimistic locking and preserves immutable historical revisions", () => {
  const item = fixture();
  try {
    const store = new GlobalKnowledgeStore(item.path);
    const original = store.promote(term("Archon", "阁下"), {
      expectedRevision: null,
    });
    const updated = store.promote(term("Archon", "执政官"), {
      recordId: original.recordId,
      expectedRevision: original.revision,
    });

    assert.equal(updated.revision, 2);
    assert.equal(updated.recordId, original.recordId);
    assert.notEqual(updated.revisionId, original.revisionId);
    assert.match(updated.revisionId, /^[0-9a-f]{64}$/u);
    assert.equal(targetOf(store.get(original.recordId, 1)!), "阁下");
    assert.equal(targetOf(store.get(original.recordId)!), "执政官");
    assert.throws(
      () => store.promote(term("Archon", "大人"), {
        recordId: original.recordId,
        expectedRevision: 1,
      }),
      /GLOBAL_KNOWLEDGE_CONFLICT/u,
    );

    const secondItem = fixture();
    try {
      const duplicateStore = new GlobalKnowledgeStore(secondItem.path);
      const duplicate = duplicateStore.promote(term("Archon", "阁下"), {
        expectedRevision: null,
      });
      assert.equal(duplicate.recordId, original.recordId);
      assert.equal(duplicate.revisionId, original.revisionId);
      duplicateStore.close();
    } finally {
      rmSync(secondItem.directory, { recursive: true, force: true });
    }
    store.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("paginates active revisions with opaque cursors and literal search", () => {
  const item = fixture();
  try {
    const store = new GlobalKnowledgeStore(item.path);
    const archon = store.promote(term("Archon", "阁下"), {
      expectedRevision: null,
    });
    store.promote(term("Piaton", "皮亚顿"), { expectedRevision: null });
    store.promote(style("dialogue", "对话简洁而克制"), {
      expectedRevision: null,
    });

    const first = store.list({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(typeof first.nextCursor, "string");
    const second = store.list({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(
      new Set([...first.items, ...second.items].map((entry) => entry.recordId))
        .size,
      3,
    );

    const searched = store.list({ search: "rch", limit: 20 });
    assert.deepEqual(
      searched.items.map((entry) => entry.recordId),
      [archon.recordId],
    );
    assert.equal(store.list({
      objectTypes: ["style"],
      limit: 20,
    }).items[0]?.objectType, "style");
    assert.throws(
      () => store.list({ limit: 20, cursor: "not-an-opaque-cursor" }),
      /GLOBAL_KNOWLEDGE_CURSOR_INVALID/u,
    );
    store.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("binds global list cursors to normalized filters and library generation", () => {
  const item = fixture();
  let store: GlobalKnowledgeStore | undefined;
  try {
    const currentStore = new GlobalKnowledgeStore(item.path);
    store = currentStore;
    currentStore.promote(term("Archon", "执政官"), { expectedRevision: null });
    currentStore.promote(term("Archoness", "女执政官"), { expectedRevision: null });
    currentStore.promote(style("arch-dialogue", "对话简洁"), {
      expectedRevision: null,
    });

    const first = currentStore.list({
      search: "  ARCH  ",
      objectTypes: ["term", "term"],
      limit: 1,
    });
    assert.ok(first.nextCursor);
    assert.doesNotThrow(() => currentStore.list({
      search: "arch",
      objectTypes: ["term"],
      cursor: first.nextCursor,
      limit: 1,
    }));
    assert.throws(
      () => currentStore.list({
        search: "dialogue",
        objectTypes: ["term"],
        cursor: first.nextCursor,
        limit: 1,
      }),
      /GLOBAL_KNOWLEDGE_CURSOR_INVALID/u,
    );
    assert.throws(
      () => currentStore.list({
        search: "arch",
        objectTypes: ["style"],
        cursor: first.nextCursor,
        limit: 1,
      }),
      /GLOBAL_KNOWLEDGE_CURSOR_INVALID/u,
    );

    currentStore.promote(term("Archer", "弓手"), { expectedRevision: null });
    assert.throws(
      () => currentStore.list({
        search: "arch",
        objectTypes: ["term"],
        cursor: first.nextCursor,
        limit: 1,
      }),
      /GLOBAL_KNOWLEDGE_CURSOR_INVALID/u,
    );
  } finally {
    store?.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("strips project evidence and provenance before persistence", () => {
  const item = fixture();
  try {
    const store = new GlobalKnowledgeStore(item.path);
    const promoted = store.promote(term("Archon", "阁下"), {
      expectedRevision: null,
    });
    assert.deepEqual(promoted.document.evidence, []);
    assert.equal(promoted.document.authority.scope, "global");
    assert.equal(promoted.document.authority.provenance, undefined);
    store.close();

    const database = new DatabaseSync(item.path, { readOnly: true });
    const persisted = database.prepare(`
      SELECT document_json
      FROM global_knowledge_revisions
    `).get() as { document_json: string };
    const eventPayloads = database.prepare(`
      SELECT payload_json
      FROM global_knowledge_events
      ORDER BY sequence
    `).all() as unknown as readonly { payload_json: string }[];
    const raw = `${persisted.document_json}\n${
      eventPayloads.map((row) => row.payload_json).join("\n")
    }`;
    assert.equal(raw.includes("C:\\secret-project"), false);
    assert.equal(raw.includes("run-secret"), false);
    assert.equal(raw.includes("sourceWindowId"), false);
    assert.equal(raw.includes("provenance"), false);
    database.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("records promoted, attached and unattached audit outcomes", () => {
  const item = fixture();
  try {
    const store = new GlobalKnowledgeStore(item.path);
    const promoted = store.promote(term("Archon", "阁下"), {
      expectedRevision: null,
    });
    store.recordAttached(promoted.recordId, promoted.revision);
    store.recordUnattached(promoted.recordId, promoted.revision);

    assert.deepEqual(
      store.listAuditEvents({
        recordId: promoted.recordId,
        limit: 20,
      }).items.map((event) => event.kind),
      ["promoted", "attached", "unattached"],
    );
    assert.throws(
      () => store.recordAttached(promoted.recordId, 999),
      /GLOBAL_KNOWLEDGE_REVISION_NOT_FOUND/u,
    );
    store.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("creates only strict global tables with database-enforced constraints", () => {
  const item = fixture();
  try {
    const store = new GlobalKnowledgeStore(item.path);
    store.close();
    const database = new DatabaseSync(item.path);
    try {
      const rows = database.prepare(`
        SELECT name, strict
        FROM pragma_table_list
        WHERE name LIKE 'global_knowledge_%'
        ORDER BY name
      `).all() as unknown as readonly { name: string; strict: number }[];
      const tables = rows.map((row) => ({
        name: row.name,
        strict: row.strict,
      }));
      assert.deepEqual(tables, [
        { name: "global_knowledge_events", strict: 1 },
        { name: "global_knowledge_revisions", strict: 1 },
      ]);
      assert.throws(() => database.prepare(`
        INSERT INTO global_knowledge_revisions(
          record_id, revision, revision_id, object_type,
          normalized_subject, document_json, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("bad", 1, "bad", "memory", "bad", "{}", 1));
    } finally {
      database.close();
    }
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});
