import assert from "node:assert/strict";
import test from "node:test";

import { projectAttentionItems } from "../src/desktop/desktop-attention.js";
import type { PersistedLosslessWindow } from "../src/storage/lossless-book-store.js";

function windowWith(
  lastError: string,
  overrides: Partial<PersistedLosslessWindow> = {},
): PersistedLosslessWindow {
  return {
    windowId: "window-7",
    ordinal: 6,
    chapterId: "chapter-2",
    chapterTitle: "第二章",
    blockIds: ["block-7"],
    globalIndexes: [6],
    sourceTokens: 900,
    sourceChars: 3_600,
    oversized: false,
    status: "human_required",
    attemptCount: 3,
    snapshotId: null,
    budget: { modelCalls: 3 },
    warnings: [],
    lastError,
    ...overrides,
  };
}

test("attention projection classifies failures without exposing raw private payloads", () => {
  const items = projectAttentionItems([
    windowWith("external model provider stream timeout at D:\\private\\book.txt"),
    windowWith(
      "framed response protocol rejected manuscript fragment: SECRET SOURCE TEXT",
      { windowId: "window-8", ordinal: 7 },
    ),
    windowWith("not relevant", {
      windowId: "window-9",
      ordinal: 8,
      status: "pending",
    }),
  ]);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.category), ["provider", "protocol"]);
  assert.equal(items[0]?.code, "ATTENTION_PROVIDER_UNAVAILABLE");
  assert.equal(items[0]?.location, "第二章 · 第 7 个文本块");
  assert.equal(items[0]?.retryable, true);
  assert.equal(items[1]?.code, "ATTENTION_RESPONSE_PROTOCOL");
  assert.doesNotMatch(JSON.stringify(items), /private|book\.txt|SECRET SOURCE TEXT/u);
});
