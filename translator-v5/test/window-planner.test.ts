import assert from "node:assert/strict";
import test from "node:test";

import type { V4Block } from "../src/domain/types.js";
import type {
  BookWindowPlan,
  BookWindowStatus,
} from "../src/fullbook/types.js";
import { packPhysicalRequests } from "../src/fullbook/request-batcher.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import { annotateStructure } from "../src/source/structure-annotator.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import type { LosslessBlock } from "../src/source/types.js";
import {
  nextConcurrency,
  planBookWindows,
} from "../src/fullbook/window-planner.js";

function block(
  globalIndex: number,
  chapterId: string,
  tokenCount: number,
): V4Block {
  return {
    id: `block-${globalIndex}`,
    legacyId: `legacy-${globalIndex}`,
    chapterId,
    chapterTitle: chapterId.toUpperCase(),
    globalIndex,
    blockIndex: globalIndex,
    sourceText: `Source ${globalIndex}`,
    sourceHash: `hash-${globalIndex}`,
    tokenCount,
  };
}

function losslessBlock(
  globalIndex: number,
  structureId: string | null,
  tokenCount: number,
  structureTitle = structureId?.toUpperCase() ?? null,
): LosslessBlock {
  return {
    id: `lossless-block-${globalIndex}`,
    sourceVersion: "source-v1",
    canonicalStart: globalIndex * 2,
    canonicalEnd: globalIndex * 2 + 2,
    sourceText: "😀x",
    sourceHash: `lossless-hash-${globalIndex}`,
    globalIndex,
    tokenCount,
    structureId,
    structureTitle,
  };
}

type StatefulWindow = BookWindowPlan & { status: BookWindowStatus };

function window(
  ordinal: number,
  sourceTokens: number,
  status: BookWindowStatus = "pending",
): StatefulWindow {
  return {
    windowId: `logical-window-${ordinal}`,
    ordinal,
    chapterId: `chapter-${ordinal}`,
    chapterTitle: `Chapter ${ordinal}`,
    blockIds: [`block-${ordinal}`],
    globalIndexes: [ordinal],
    sourceTokens,
    sourceChars: sourceTokens * 4,
    oversized: false,
    status,
  };
}

test("window plan is stable, chapter-bounded, and size-bounded", () => {
  const blocks = [
    block(0, "ch1", 4),
    block(1, "ch1", 4),
    block(2, "ch1", 4),
    block(3, "ch2", 20),
    block(4, "ch2", 3),
  ];
  const options = { maxSourceTokens: 10, maxBlocks: 2, protocolVersion: "v5-book-1" };
  const first = planBookWindows(blocks, options);
  const second = planBookWindows([...blocks].reverse(), options);

  assert.deepEqual(
    first.map((window) => window.blockIds),
    [["block-0", "block-1"], ["block-2"], ["block-3"], ["block-4"]],
  );
  assert.deepEqual(
    first.map((window) => window.chapterId),
    ["ch1", "ch1", "ch2", "ch2"],
  );
  assert.equal(first[2]?.oversized, true);
  assert.deepEqual(first.map((window) => window.windowId), second.map((window) => window.windowId));
});

test("window plan rejects duplicate or discontinuous global indexes", () => {
  assert.throws(
    () => planBookWindows([block(0, "ch1", 1), block(0, "ch1", 1)]),
    /duplicate global index/u,
  );
  assert.throws(
    () => planBookWindows([block(0, "ch1", 1), block(2, "ch1", 1)]),
    /continuous global indexes/u,
  );
});

test("production defaults keep model generations bounded", () => {
  const windows = planBookWindows([
    block(0, "ch1", 1_000),
    block(1, "ch1", 1_000),
    block(2, "ch1", 1_000),
    block(3, "ch1", 1_000),
  ]);

  assert.deepEqual(
    windows.map((window) => window.blockIds),
    [["block-0", "block-1"], ["block-2", "block-3"]],
  );
  assert.ok(windows.every((window) => window.blockIds.length <= 3));
});

test("planner balances text size but strongly prefers lossless structure boundaries", () => {
  const blocks = [
    losslessBlock(0, "structure-1", 700),
    losslessBlock(1, "structure-1", 700),
    losslessBlock(2, "structure-2", 700),
    losslessBlock(3, "structure-2", 700),
  ];
  const windows = planBookWindows(blocks, {
    targetSourceTokens: 1_600,
    maxSourceTokens: 2_600,
  });

  assert.deepEqual(windows.map((item) => item.blockIds.length), [2, 2]);
  assert.deepEqual(windows.map((item) => item.chapterId), ["structure-1", "structure-2"]);
  assert.deepEqual(windows.map((item) => item.sourceChars), [4, 4]);
});

test("planner pays a strong cost rather than crossing a lossless structure boundary", () => {
  const blocks = [
    losslessBlock(0, "structure-1", 400),
    losslessBlock(1, "structure-1", 400),
    losslessBlock(2, "structure-2", 400),
    losslessBlock(3, "structure-2", 400),
    losslessBlock(4, "structure-2", 400),
    losslessBlock(5, "structure-2", 400),
  ];
  const windows = planBookWindows(blocks, {
    targetSourceTokens: 1_200,
    maxSourceTokens: 1_600,
    maxBlocks: 6,
  });

  assert.deepEqual(windows.map((item) => item.blockIds.length), [2, 4]);
});

test("window ids do not depend on lossless structure title text", () => {
  const blocks = [
    losslessBlock(0, "structure-1", 700, "Chapter One"),
    losslessBlock(1, "structure-1", 700, "Chapter One"),
    losslessBlock(2, "structure-2", 700, "Chapter Two"),
    losslessBlock(3, "structure-2", 700, "Chapter Two"),
  ];
  const renamed = blocks.map((item) => ({
    ...item,
    structureTitle: `Renamed ${item.globalIndex}`,
  }));
  const options = { targetSourceTokens: 1_600, maxSourceTokens: 2_600 };

  assert.deepEqual(
    planBookWindows(blocks, options).map((item) => item.windowId),
    planBookWindows(renamed, options).map((item) => item.windowId),
  );
});

test("annotated short chapters retain positional boundaries through builder and planner", () => {
  const source = [
    "Chapter I", "", "Alpha.", "",
    "Chapter II", "", "Beta.", "",
    "Chapter III", "", "Gamma.",
  ].join("\n");
  const sourceVersion = "integrated-source-v1";
  const annotations = annotateStructure(source, sourceVersion);
  const chapterIds = annotations
    .filter((item) => item.kind === "chapter_heading")
    .map((item) => item.id);
  const blocks = buildLosslessBlocks(source, annotations, {
    maxSourceTokens: 1_000,
    sourceVersion,
  });
  const windows = planBookWindows(blocks, {
    targetSourceTokens: 100,
    maxSourceTokens: 1_000,
    maxBlocks: 10,
  });

  assert.equal(blocks.map((item) => item.sourceText).join(""), source);
  assert.deepEqual(blocks.map((item) => item.structureId), chapterIds);
  assert.deepEqual(windows.map((item) => item.blockIds.length), [1, 1, 1]);
  assert.deepEqual(windows.map((item) => item.chapterId), chapterIds);
});

test("structure annotation uses the selected source language profile", () => {
  const source = "LIVRE PREMIER\n\nCHAPITRE PREMIER\n\nLe texte.";
  const annotations = annotateStructure(
    source,
    "source-fr",
    getSourceLanguageProfile("fr"),
  );
  assert.deepEqual(annotations.map((item) => item.kind), [
    "volume_heading",
    "chapter_heading",
  ]);
  assert.equal(annotateStructure(
    source,
    "source-en",
    getSourceLanguageProfile("en"),
  ).length, 0);
});

test("request batcher packs tiny logical windows without merging their identities", () => {
  const windows = [window(0, 1), window(1, 12), window(2, 2_000)];
  const requests = packPhysicalRequests(windows, {
    tinyWindowTokens: 64,
    maxRequestTokens: 2_600,
    maxWindowsPerRequest: 6,
  });

  assert.deepEqual(requests.map((item) => item.windows.length), [2, 1]);
  assert.equal(new Set(
    requests.flatMap((request) => request.windows.map((item) => item.windowId)),
  ).size, 3);
  assert.strictEqual(requests[0]?.windows[0], windows[0]);
  assert.strictEqual(requests[0]?.windows[1], windows[1]);
});

test("request batcher never batches non-contiguous or non-pending windows", () => {
  const requests = packPhysicalRequests([
    window(0, 10),
    window(2, 10),
    window(3, 10, "running"),
    window(4, 10),
  ], {
    tinyWindowTokens: 64,
    maxRequestTokens: 2_600,
    maxWindowsPerRequest: 6,
  });

  assert.deepEqual(requests.map((item) => item.windows.length), [1, 1, 1, 1]);
});

test("request batcher enforces token and window-count micro-batch limits", () => {
  const windows = [0, 1, 2, 3, 4].map((ordinal) => window(ordinal, 20));
  const tokenBound = packPhysicalRequests(windows, {
    tinyWindowTokens: 64,
    maxRequestTokens: 50,
    maxWindowsPerRequest: 6,
  });
  const countBound = packPhysicalRequests(windows, {
    tinyWindowTokens: 64,
    maxRequestTokens: 2_600,
    maxWindowsPerRequest: 2,
  });

  assert.deepEqual(tokenBound.map((item) => item.windows.length), [2, 2, 1]);
  assert.deepEqual(tokenBound.map((item) => item.sourceTokens), [40, 40, 20]);
  assert.deepEqual(countBound.map((item) => item.windows.length), [2, 2, 1]);
});

test("request batcher rejects one oversized logical window without rewriting it", () => {
  const oversized = {
    ...window(0, 2_601),
    oversized: true,
  };

  assert.throws(
    () => packPhysicalRequests([oversized], {
      tinyWindowTokens: 64,
      maxRequestTokens: 2_600,
      maxWindowsPerRequest: 6,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "REQUEST_SOURCE_TOKENS_EXCEEDED",
  );
  assert.equal(oversized.sourceTokens, 2_601);
  assert.deepEqual(oversized.blockIds, ["block-0"]);
});

test("request ids are deterministic, order-stable, and membership-sensitive", () => {
  const windows = [0, 1, 2].map((ordinal) => window(ordinal, 10));
  const options = {
    tinyWindowTokens: 64,
    maxRequestTokens: 2_600,
    maxWindowsPerRequest: 2,
  };
  const first = packPhysicalRequests(windows, options);
  const reordered = packPhysicalRequests([...windows].reverse(), options);
  const wider = packPhysicalRequests(windows, {
    ...options,
    maxWindowsPerRequest: 3,
  });

  assert.deepEqual(
    first.map((item) => [item.requestId, item.windows.map((entry) => entry.windowId)]),
    reordered.map((item) => [item.requestId, item.windows.map((entry) => entry.windowId)]),
  );
  assert.notEqual(first[0]?.requestId, wider[0]?.requestId);
});

test("adaptive concurrency warms up, accelerates, and backs off on risk", () => {
  const clean = {
    status: "completed" as const,
    modelCalls: 12,
    modelCallLimit: 20,
    repaired: false,
    deadlineExceeded: false,
  };
  assert.equal(nextConcurrency([], { warmupWindows: 2, maxConcurrency: 2 }), 1);
  assert.equal(nextConcurrency([clean], { warmupWindows: 2, maxConcurrency: 2 }), 1);
  assert.equal(nextConcurrency([clean, clean], { warmupWindows: 2, maxConcurrency: 2 }), 2);
  assert.equal(nextConcurrency([
    clean,
    clean,
    { ...clean, repaired: true },
  ], { warmupWindows: 2, maxConcurrency: 2 }), 1);
  assert.equal(nextConcurrency([
    clean,
    clean,
    { ...clean, modelCalls: 17 },
  ], { warmupWindows: 2, maxConcurrency: 2 }), 1);
});
