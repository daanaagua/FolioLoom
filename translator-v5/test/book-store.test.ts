import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { V4Block } from "../src/domain/types.js";
import { BookStore } from "../src/storage/book-store.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";

function block(index: number): V4Block {
  return {
    id: `block-${index}`,
    legacyId: `legacy-${index}`,
    chapterId: "ch1",
    chapterTitle: "One",
    globalIndex: index,
    blockIndex: index,
    sourceText: `Source ${index}`,
    sourceHash: `hash-${index}`,
    tokenCount: 10,
  };
}

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "v5-book-store-")), "book.db");
}

function initialize(store: BookStore, blocks = [block(0), block(1)]): void {
  store.initializePlan({
    sourceDbPath: "C:/source/book.db",
    sourceFingerprint: "fingerprint-1",
    protocolVersion: "v5-book-1",
    modelId: "deepseek-v4-flash",
    blocks,
    windows: planBookWindows(blocks, { maxBlocks: 1 }),
  });
}

test("book store atomically commits a window and resumes completed state", () => {
  const path = fixturePath();
  const first = new BookStore(path);
  initialize(first);
  const window = first.pendingWindows()[0];
  assert.ok(window);
  assert.equal(first.claimWindow(window.windowId).attemptCount, 1);
  first.commitWindow({
    windowId: window.windowId,
    status: "completed",
    translations: [{
      blockId: "block-0",
      sourceHash: "hash-0",
      text: "译文零。",
    }],
    lexicalAnchors: [{
      sourceForm: "Smoky",
      target: "斯莫基",
      mode: "stable",
      confidence: 0.97,
    }],
    narrativeMemories: [{
      questionId: "q-smoky",
      kind: "entity_identity",
      subjectIds: ["subject-smoky"],
      verdict: "Smoky is a person",
      confidence: 0.96,
      channel: "narrative_before_target",
      visibleFromGlobalIndex: 1,
      evidenceIds: ["ev-1"],
    }],
    styleTail: "译文零。",
    budget: { modelCalls: 9 },
    warnings: [],
  });
  first.close();

  const reopened = new BookStore(path);
  initialize(reopened);
  assert.equal(reopened.statusSummary().completedWindows, 1);
  assert.deepEqual(reopened.activeTranslations(), [{
    blockId: "block-0",
    globalIndex: 0,
    chapterId: "ch1",
    chapterTitle: "One",
    sourceText: "Source 0",
    sourceHash: "hash-0",
    text: "译文零。",
    status: "completed",
  }]);
  assert.equal(reopened.loadStyleTail(), "译文零。");
  assert.equal(reopened.loadLexicalAnchors()[0]?.target, "斯莫基");
  assert.equal(reopened.loadNarrativeMemories()[0]?.questionId, "q-smoky");
  reopened.close();
});

test("book store recovers interrupted running windows as pending", () => {
  const path = fixturePath();
  const first = new BookStore(path);
  initialize(first);
  const window = first.pendingWindows()[0];
  assert.ok(window);
  first.claimWindow(window.windowId);
  first.close();

  const reopened = new BookStore(path);
  initialize(reopened);
  assert.equal(reopened.pendingWindows()[0]?.status, "pending");
  assert.equal(reopened.pendingWindows()[0]?.attemptCount, 1);
  reopened.close();
});

test("book store records retryable and terminal window failures", () => {
  const path = fixturePath();
  const store = new BookStore(path);
  initialize(store);
  const window = store.pendingWindows()[0];
  assert.ok(window);
  store.claimWindow(window.windowId);
  store.failWindow(window.windowId, {
    error: "no submission",
    retry: true,
    budget: { modelCalls: 3 },
    warnings: ["first attempt"],
  });
  assert.equal(store.window(window.windowId)?.status, "pending");
  assert.equal(store.claimWindow(window.windowId).attemptCount, 2);
  store.failWindow(window.windowId, {
    error: "no submission again",
    retry: false,
    budget: { modelCalls: 4 },
    warnings: ["manual review"],
  });
  assert.equal(store.window(window.windowId)?.status, "human_required");
  assert.equal(store.statusSummary().humanRequiredWindows, 1);
  store.close();
});

test("book store rejects source changes and leaves failed commits unmodified", () => {
  const path = fixturePath();
  const store = new BookStore(path);
  initialize(store);
  const window = store.pendingWindows()[0];
  assert.ok(window);
  store.claimWindow(window.windowId);
  assert.throws(() => store.commitWindow({
    windowId: window.windowId,
    status: "completed",
    translations: [{ blockId: "block-0", sourceHash: "changed", text: "错误。" }],
    lexicalAnchors: [],
    narrativeMemories: [],
    styleTail: "错误。",
    budget: {},
    warnings: [],
  }), /source hash mismatch/u);
  assert.deepEqual(store.activeTranslations(), []);
  assert.equal(store.window(window.windowId)?.status, "running");
  assert.throws(() => store.initializePlan({
    sourceDbPath: "C:/source/book.db",
    sourceFingerprint: "fingerprint-2",
    protocolVersion: "v5-book-1",
    modelId: "deepseek-v4-flash",
    blocks: [block(0), block(1)],
    windows: planBookWindows([block(0), block(1)], { maxBlocks: 1 }),
  }), /source fingerprint mismatch/u);
  store.close();
});

test("book store never overwrites stored blocks under a reused fingerprint", () => {
  const path = fixturePath();
  const store = new BookStore(path);
  initialize(store);
  const changed = { ...block(0), sourceText: "Changed", sourceHash: "changed" };
  assert.throws(() => store.initializePlan({
    sourceDbPath: "C:/source/book.db",
    sourceFingerprint: "fingerprint-1",
    protocolVersion: "v5-book-1",
    modelId: "deepseek-v4-flash",
    blocks: [changed, block(1)],
    windows: planBookWindows([changed, block(1)], { maxBlocks: 1 }),
  }), /stored source hash mismatch/u);
  store.close();
});
