import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import {
  BookRequestCapacityError,
  drainKnowledgeRevalidationTasks,
  planningProtocols,
  runBook,
  schedulableTranslationExecutions,
  type LosslessBookRunResult,
  windowOptionsForRunMode,
} from "../src/fullbook/book-runner.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { loadGlossary } from "../src/glossary/glossary-profile.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import { SourceLedger } from "../src/source/source-ledger.js";
import { annotateStructure } from "../src/source/structure-annotator.js";
import { BookStore } from "../src/storage/book-store.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { RuntimeProfileStore } from "../src/storage/runtime-profile-store.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import { BudgetExceeded } from "../src/kernel/budget.js";
import { scalarLength } from "../src/source/types.js";
import {
  WeightedTokenEstimator,
  type UsageObservation,
} from "../src/source/token-estimator.js";
import {
  executionBudgetLimits,
} from "../src/fullbook/execution-worker.js";
import type { LedgerEvent } from "../src/fullbook/token-ledger.js";

class TrackingTokenEstimator extends WeightedTokenEstimator {
  readonly observations: UsageObservation[] = [];

  override observeUsage(sample: UsageObservation): void {
    this.observations.push(sample);
    super.observeUsage(sample);
  }
}

test("paragraph execution budgets cover the admitted direct and one refinement graph", () => {
  const typed = (refinementCount = 0, planId = "plan-a") => ({
    input: { responseProtocol: "typed_tool" },
    paragraphPlan: { planId },
    paragraphRefinements: Array.from(
      { length: refinementCount },
      () => ({ input: { responseProtocol: "typed_tool" } }),
    ),
  });
  const limits = executionBudgetLimits([
    typed(6),
    typed(),
    typed(),
    typed(),
    typed(),
  ] as never);

  assert.deepEqual(limits, {
    translationTurns: 22,
    translationToolCalls: 25,
    modelCalls: 25,
    repairTurns: 3,
  });

  const twoPlans = executionBudgetLimits([
    typed(2, "plan-a"),
    typed(3, "plan-b"),
    typed(0, "plan-b"),
  ] as never);
  assert.deepEqual(twoPlans, {
    translationTurns: 16,
    translationToolCalls: 19,
    modelCalls: 20,
    repairTurns: 3,
  });
});

test("active replanning retains a risk-gated legacy execution when context profiles are infeasible", () => {
  const refreshed = {
    variant: {
      variantId: "task-a:context-rich",
      taskId: "task-a",
    },
  } as never;
  const legacy = {
    variant: {
      variantId: "task-b:baseline",
      taskId: "task-b",
    },
  } as never;
  const schedulable = schedulableTranslationExecutions(
    new Map([["task-a:context-rich", refreshed]]),
    new Map([["task-b", legacy]]),
    new Set(["task-a", "task-b"]),
  );

  assert.deepEqual([...schedulable.keys()].sort(), [
    "task-a:context-rich",
    "task-b:baseline",
  ]);
});

function losslessFixture(source: string, sourceLanguage = "en") {
  const directory = mkdtempSync(join(tmpdir(), "v5-lossless-runner-"));
  const rawPath = join(directory, "original.txt");
  const canonicalPath = join(directory, "source.txt");
  const manifestPath = join(directory, "source_manifest.json");
  const raw = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, raw);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: raw.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage,
    canonical_path: "source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: scalarLength(source),
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  const ledger = SourceLedger.open(manifestPath);
  const blocks = buildLosslessBlocks(
    ledger,
    annotateStructure(ledger, ledger.sourceVersion),
    { sourceVersion: ledger.sourceVersion },
  );
  const windows = planBookWindows(blocks, {
    maxBlocks: 1,
    maxSourceTokens: 100,
    protocolVersion: "lossless-v5-1",
  });
  const faux = fauxProvider();
  return {
    canonicalPath,
    faux,
    submission: {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blockIds.map((blockId) => ({
          blockId,
          text: "这是完整的中文译文。",
        })),
        notes: [],
      })),
    },
    options: {
      manifestPath,
      storePath: join(directory, "book-v2.db"),
      runMeta: { runId: "run-lossless", protocolVersion: "lossless-v5-1" },
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
      tinyWindowTokens: 32,
      maxRequestTokens: 100,
      maxWindowsPerRequest: 4,
      maxConcurrency: 2,
      hardDeadlineMs: 30_000,
    },
  };
}

function privateDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

test("fast mode uses larger bounded windows unless the caller supplies tighter limits", () => {
  assert.deepEqual(windowOptionsForRunMode("fast"), {
    targetSourceTokens: 3_200,
    maxSourceTokens: 4_800,
    maxBlocks: 4,
  });
  assert.deepEqual(windowOptionsForRunMode("fast", { maxSourceTokens: 900 }), {
    targetSourceTokens: 900,
    maxSourceTokens: 900,
    maxBlocks: 4,
  });
  assert.deepEqual(windowOptionsForRunMode("quality", {}), {});
});

test("quality retry rounds return to typed-tool instead of repeating framed protocol", () => {
  assert.deepEqual(planningProtocols("typed_tool", 0), [
    "typed_tool",
    "framed_text",
  ]);
  assert.deepEqual(planningProtocols("typed_tool", 1), ["typed_tool"]);
  assert.deepEqual(planningProtocols("framed_text", 1), ["framed_text"]);
});

function revalidationQueueFixture(input: {
  readonly currentTarget: string;
  readonly allowedTargets: readonly string[];
  readonly policy?: "locked" | "preferred" | "contextual";
}) {
  const previous = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "秘书主任",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });
  const current = reviseConcept(previous, {
    canonicalTarget: input.currentTarget,
    allowedRealizations: input.allowedTargets,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
  let terminal = false;
  let claimed = false;
  const calls = {
    noop: 0,
    replace: [] as Array<"repair" | "retranslate">,
    warning: 0,
  };
  const task = {
    taskId: "task-0",
    runId: "run-0",
    translationId: 1,
    blockId: "block-0",
    changeSetHash: "a".repeat(64),
    fromSnapshotId: "snapshot-old",
    toSnapshotId: "snapshot-new",
    conceptIds: [current.conceptId],
    status: "validating" as const,
    attempts: 1,
    result: {},
    replacementTranslationId: null,
  };
  const store = {
    claimNextRevalidationTask() {
      if (terminal || claimed) return undefined;
      claimed = true;
      return task;
    },
    revalidationWorkItem() {
      return {
        task,
        translation: {
          translationId: 1,
          runId: "run-0",
          windowId: "window-0",
          blockId: "block-0",
          sourceVersion: "source-0",
          sourceHash: "source-hash",
          text: "秘书主任。",
          status: "completed" as const,
          version: 1,
          snapshotId: "snapshot-old",
        },
        source: {
          blockId: "block-0",
          sourceVersion: "source-0",
          sourceHash: "source-hash",
          sourceText: "Prokurist.",
          globalIndex: 0,
          tokenCount: 3,
        },
        window: {
          windowId: "window-0",
          ordinal: 0,
          chapterId: "chapter-0",
          chapterTitle: "One",
          blockIds: ["block-0"],
          globalIndexes: [0],
          sourceTokens: 3,
          sourceChars: 10,
          oversized: false,
          status: "completed" as const,
          attemptCount: 1,
          snapshotId: "snapshot-old",
          budget: {},
          warnings: [],
          lastError: "",
        },
        concepts: [{
          conceptId: current.conceptId,
          appliedConcept: { ...previous, revision: 1 },
          currentConcept: { ...current, revision: 2 },
          termUsages: [{
            occurrenceId: "occurrence-0",
            blockId: "block-0",
            conceptId: current.conceptId,
            sourceForm: "Prokurist",
            sourceStart: 0,
            sourceEnd: 9,
            discourseRole: "narrative" as const,
            targetSurface: "秘书主任",
          }],
        }],
      };
    },
    resolveRevalidationNoop() {
      calls.noop += 1;
      terminal = true;
    },
    replaceTranslationForRevalidation(replacement: { action: "repair" | "retranslate" }) {
      calls.replace.push(replacement.action);
      terminal = true;
      return 2;
    },
    completeRevalidationWithWarning() {
      calls.warning += 1;
      terminal = true;
    },
  };
  return { store, calls, current };
}

test("revalidation noop uses durable receipts without a model call", async () => {
  const fixture = revalidationQueueFixture({
    currentTarget: "主事",
    allowedTargets: ["主事", "秘书主任"],
  });
  let modelCalls = 0;
  const result = await drainKnowledgeRevalidationTasks({
    store: fixture.store as never,
    runId: "run-0",
    maxAttempts: 1,
    translate: async () => {
      modelCalls += 1;
      throw new Error("noop must not call the model");
    },
    isExpectedFailure: () => false,
  });
  assert.equal(modelCalls, 0);
  assert.equal(fixture.calls.noop, 1);
  assert.deepEqual(result, {
    claimed: 1,
    noop: 1,
    repaired: 0,
    retranslated: 0,
    warning: 0,
    modelCalls: 0,
    modelDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    tokenUsageComplete: true,
    wallTimeMs: result.wallTimeMs,
  });
  assert.ok(result.wallTimeMs >= 0);
});

test("revalidation runs one targeted repair or full block translation from its action", async () => {
  for (const [fixture, expected] of [
    [revalidationQueueFixture({
      currentTarget: "主事",
      allowedTargets: ["主事"],
    }), "repair"],
    [revalidationQueueFixture({
      currentTarget: "主事",
      allowedTargets: ["主事"],
      policy: "locked",
    }), "retranslate"],
  ] as const) {
    const result = await drainKnowledgeRevalidationTasks({
      store: fixture.store as never,
      runId: "run-0",
      maxAttempts: 1,
      translate: async (_work, action) => ({
        snapshotId: "snapshot-new",
        text: "主事。",
        resultStatus: "completed" as const,
        termUsages: [],
        concepts: [fixture.current],
        result: { action },
      }),
      isExpectedFailure: () => false,
    });
    assert.deepEqual(fixture.calls.replace, [expected]);
    assert.equal(result.modelCalls, 1);
  }
});

test("expected revalidation failure preserves the old version and continues as warning", async () => {
  const fixture = revalidationQueueFixture({
    currentTarget: "主事",
    allowedTargets: ["主事"],
  });
  const result = await drainKnowledgeRevalidationTasks({
    store: fixture.store as never,
    runId: "run-0",
    maxAttempts: 1,
    translate: async () => {
      throw new BudgetExceeded("modelCalls", 1, 2);
    },
    isExpectedFailure: (error) => error instanceof BudgetExceeded,
  });
  assert.equal(fixture.calls.warning, 1);
  assert.equal(result.warning, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.tokenUsageComplete, false);
});

test("revalidation monitoring reports only the incremental model time and tokens", async () => {
  const fixture = revalidationQueueFixture({
    currentTarget: "manager",
    allowedTargets: ["manager"],
  });
  const result = await drainKnowledgeRevalidationTasks({
    store: fixture.store as never,
    runId: "run-0",
    maxAttempts: 1,
    translate: async (_work, action) => ({
      snapshotId: "snapshot-new",
      text: "manager",
      resultStatus: "completed" as const,
      termUsages: [],
      concepts: [fixture.current],
      result: { action },
      telemetry: {
        modelCalls: 2,
        modelDurationMs: 125,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 600,
        cacheWriteTokens: 50,
        reasoningTokens: 75,
        totalTokens: 1_325,
      },
    }),
    isExpectedFailure: () => false,
  });

  assert.equal(result.modelCalls, 2);
  assert.equal(result.modelDurationMs, 125);
  assert.equal(result.inputTokens, 1_000);
  assert.equal(result.outputTokens, 200);
  assert.equal(result.cacheReadTokens, 600);
  assert.equal(result.cacheWriteTokens, 50);
  assert.equal(result.reasoningTokens, 75);
  assert.equal(result.totalTokens, 1_325);
  assert.equal(result.tokenUsageComplete, true);
});

test("fast mode keeps its default physical request limit aligned with a legal 4,800-token window", async () => {
  const fixture = losslessFixture([
    "가".repeat(2_000),
    "나".repeat(2_000),
    "다".repeat(2_000),
  ].join("\n\n"));
  fixture.faux.setResponses(Array.from({ length: 8 }, () => losslessBatchResponse));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: {},
    maxRequestTokens: undefined,
    maxConcurrency: 4,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.pendingWindows, 0);
  assert.equal(result.status.completedWindows + result.status.warningWindows, result.status.totalWindows);
});

test("clean fast waves prepare two scheduler horizons without exceeding runtime concurrency", async () => {
  const fixture = losslessFixture([
    "BOOK ONE", "CHAPTER ONE", "BOOK TWO", "CHAPTER TWO",
    "BOOK THREE", "CHAPTER THREE", "BOOK FOUR", "CHAPTER FOUR",
  ].join("\n\n"));
  assert.ok(fixture.submission.windows.length >= 4);
  fixture.faux.setResponses(Array.from(
    { length: fixture.submission.windows.length },
    () => losslessBatchResponse,
  ));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.waves[0]?.windowIds.length, 4);
  assert.ok(result.waves.every((wave) => wave.windowIds.length <= 4));
  assert.equal(result.status.completedWindows, result.status.totalWindows);
});

test("fast waves fall back to one scheduler horizon after a retry", async () => {
  const fixture = losslessFixture([
    "BOOK ONE", "CHAPTER ONE", "BOOK TWO", "CHAPTER TWO",
    "BOOK THREE", "CHAPTER THREE", "BOOK FOUR", "CHAPTER FOUR",
  ].join("\n\n"));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", { windows: [] }), {
      stopReason: "toolUse",
    }),
    ...Array.from({ length: fixture.submission.windows.length + 2 }, () => losslessBatchResponse),
  ]);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.deepEqual(result.waves.map((wave) => wave.windowIds.length), [4, 2, 2]);
  assert.equal(result.status.completedWindows, result.status.totalWindows);
});

test("a missing framed submission is retried as smaller lossless block fragments", async () => {
  const fixture = losslessFixture([
    "the ".repeat(1_700),
    "and ".repeat(1_700),
  ].join("\n\n"));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);
  fixture.faux.setResponses([
    fauxAssistantMessage("I could not submit the structured result."),
    ...Array.from({ length: 10 }, () => losslessBatchResponse),
  ]);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    maxRequestTokens: 4_000,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows + result.status.warningWindows, result.status.totalWindows);
  assert.ok(result.windows.some((window) => window.blockIds.length >= 2));
  assert.ok(result.windows.every((window) => window.attemptCount === 1));
  assert.ok(fixture.faux.state.callCount >= 3);
  assert.ok(fixture.faux.state.callCount <= 6);
});

test("a tx8-shaped single block runs typed paragraph fragments before any framed fallback", async () => {
  const sourceParagraphs = Array.from(
    { length: 23 },
    (_, index) =>
      `the quiet mechanism continued its ordinary movement through source paragraph ${index + 1}.`,
  );
  const fixture = losslessFixture(sourceParagraphs.join("\n\n"));
  const observedUnits: string[] = [];
  const observedProtocols: string[] = [];
  const fragmentResponse = (context: Context) => {
    const prompt = userText(context);
    observedProtocols.push(
      prompt.includes("EXACT FRAME PAIRS") ? "framed_text" : "typed_tool",
    );
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    assert.ok(match?.[1], prompt.slice(0, 800));
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    const sourceParagraphs = window.blocks[0]?.paragraphs ?? [];
    observedUnits.push(JSON.stringify(sourceParagraphs));
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: sourceParagraphs.map((_, index) => ({
            text: `这是第${index + 1}段完整译文，保留了当前源段落的全部普通信息与动作。`,
          })),
        })),
      }],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses(
    Array.from({ length: 8 }, () => fragmentResponse),
  );
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows + result.status.warningWindows, 1);
  assert.equal(observedUnits.length, 3);
  assert.equal(new Set(observedUnits).size, 3);
  assert.deepEqual(observedProtocols, [
    "typed_tool",
    "typed_tool",
    "typed_tool",
  ]);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const translation = store.activeTranslations("run-lossless")[0]?.text ?? "";
    assert.equal(
      translation.split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u).length,
      23,
    );
    const translationReservations = store.loadTokenLedgerEvents("run-lossless")
      .filter((event) =>
        event.type === "reserved" && event.purpose === "translate");
    assert.equal(translationReservations.length, 1);
  } finally {
    store.close();
  }
});

test("a high-risk block inside a multi-block window is fragmented without losing its siblings", async () => {
  const sourceParagraphs = Array.from(
    { length: 14 },
    (_, index) =>
      `the quiet mechanism preserves the complete source heading paragraph ${index + 1}.`,
  );
  const fixture = losslessFixture([
    sourceParagraphs.join("\n\n"),
    "the following ordinary source block preserves its complete narrative details.",
  ].join("[[]]"));
  let paragraphCalls = 0;
  let ordinaryCalls = 0;
  const response = (context: Context) => {
    const prompt = userText(context);
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    if (match?.[1] === undefined) {
      ordinaryCalls += 1;
      return losslessBatchResponse(context);
    }
    paragraphCalls += 1;
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    const block = window.blocks[0]!;
    if (block.paragraphs.length === 1) {
      return fauxAssistantMessage(fauxToolCall(
        "finalize_paragraph_fragment",
        {
          text: "这是完整的单段译文，保留当前源段落的全部普通信息。",
        },
      ), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: block.paragraphs.map((_, index) => ({
            text: `这是第${index + 1}段完整标题译文，保留当前源段落的全部信息。`,
          })),
        })),
      }],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses(Array.from({ length: 8 }, () => response));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.blockIds.length, 2);
  assert.equal(result.status.humanRequiredWindows, 0, JSON.stringify(result.windows));
  assert.equal(result.status.completedWindows + result.status.warningWindows, 1);
  assert.equal(paragraphCalls, 2);
  assert.equal(ordinaryCalls, 1);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const translations = store.activeTranslations("run-lossless");
    assert.equal(translations.length, 2);
    assert.equal(
      translations[0]?.text.split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u).length,
      14,
    );
  } finally {
    store.close();
  }
});

test("each paragraph plan refines only failed nodes without forcing scalar leaves", async () => {
  const highRiskBlock = (label: string) => Array.from(
    { length: 13 },
    (_, index) =>
      `the ${label} mechanism preserves complete source paragraph ${index + 1}.`,
  ).join("\n\n");
  const fixture = losslessFixture([
    highRiskBlock("first"),
    highRiskBlock("second"),
    "the ordinary sibling preserves all of its complete narrative details.",
  ].join("[[]]"));
  const collapseAttemptsByBlock = new Map<string, number>();
  const singleParagraphCallsByBlock = new Map<string, number>();
  const response = (context: Context) => {
    const prompt = userText(context);
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    if (match?.[1] === undefined) {
      return losslessBatchResponse(context);
    }
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    const block = window.blocks[0]!;
    if (block.paragraphs.length === 1) {
      singleParagraphCallsByBlock.set(
        block.blockId,
        (singleParagraphCallsByBlock.get(block.blockId) ?? 0) + 1,
      );
    }
    const collapseAttempts = collapseAttemptsByBlock.get(block.blockId) ?? 0;
    const collapse = block.paragraphs.length > 1 && collapseAttempts < 2;
    if (collapse) {
      collapseAttemptsByBlock.set(block.blockId, collapseAttempts + 1);
    }
    const paragraphs = collapse
      ? block.paragraphs.slice(0, 1)
      : block.paragraphs;
    if (block.paragraphs.length === 1) {
      return fauxAssistantMessage(fauxToolCall(
        "finalize_paragraph_fragment",
        {
          text: "这是完整的单段补正译文，保留当前源段落的全部信息与动作。",
        },
      ), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: [{
          blockId: block.blockId,
          paragraphs: paragraphs.map((_, index) => ({
            text: `这是第${index + 1}段完整译文，保留当前源段落的全部信息与动作。`,
          })),
        }],
      }],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses(Array.from({ length: 40 }, () => response));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 3, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.blockIds.length, 3);
  assert.equal(result.status.humanRequiredWindows, 0, JSON.stringify(result.windows));
  assert.equal(collapseAttemptsByBlock.size, 2);
  assert.ok([...collapseAttemptsByBlock.values()].every((count) => count === 2));
  assert.equal(singleParagraphCallsByBlock.size, 0);
});

test("failed paragraph units refine by local bisection without replaying valid siblings", async () => {
  const sourceParagraphs = Array.from(
    { length: 14 },
    (_, index) =>
      `ordinary source paragraph ${index + 1} preserves its complete sequence of actions, causes, and narrative details.`,
  );
  const fixture = losslessFixture(sourceParagraphs.join("\n\n"));
  const requestedParagraphOrdinals: number[][] = [];
  const collapsed = (requestContext: Context) => {
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(
        userText(requestContext),
      );
    assert.ok(match?.[1]);
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{ paragraphId: string; ordinal: number }>;
      }>;
    }>;
    const ordinals = windows[0]?.blocks[0]?.paragraphs.map((paragraph) =>
      Number.parseInt(paragraph.paragraphId.split(":").at(-1) ?? "", 10)) ?? [];
    requestedParagraphOrdinals.push(ordinals);
    if (ordinals.length <= 1 || ordinals[0] !== 0) {
      return valid(requestContext);
    }
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: [{ text: "过短。" }],
        })),
      })),
    }), { stopReason: "toolUse" });
  };
  const valid = (requestContext: Context) => {
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(
        userText(requestContext),
      );
    assert.ok(match?.[1]);
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    const block = window.blocks[0]!;
    if (block.paragraphs.length === 1) {
      return fauxAssistantMessage(fauxToolCall(
        "finalize_paragraph_fragment",
        {
          text: "这是完整的单段译文，保留当前源段落的全部动作、因果、人物关系、时间顺序与叙述细节，没有遗漏任何场景信息，并保持表达清晰连贯。",
        },
      ), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: [{
          blockId: block.blockId,
          paragraphs: block.paragraphs.map((_, index) => ({
            text: `这是第 ${index + 1} 段完整译文，保留当前源段落的全部动作、因果、人物关系、时间顺序与叙述细节，没有遗漏任何场景信息，并保持表达清晰连贯。`,
          })),
        }],
      }],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses(Array.from({ length: 16 }, () => collapsed));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.deepEqual(requestedParagraphOrdinals, [
    [0, 1, 2, 3, 4, 5, 6],
    [0, 1, 2, 3, 4, 5, 6],
    [0, 1, 2],
    [0, 1, 2],
    [0],
    [1, 2],
    [3, 4, 5, 6],
    [7, 8, 9, 10, 11, 12, 13],
  ]);
  assert.equal(fixture.faux.state.callCount, 8);
  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows + result.status.warningWindows, 1);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const ledgerEvents = store.loadTokenLedgerEvents("run-lossless");
    assert.equal(ledgerEvents.filter((event) =>
      event.type === "reserved"
      && event.purpose === "paragraph_fragment").length, 2);
    const translationBaseline = ledgerEvents
      .reduce((total, event) =>
        event.type === "baseline_added"
        && event.source === "translate_horizon"
          ? total + event.baselineTokens
          : total, 0);
    const legalReservations = ledgerEvents
      .reduce((total, event) =>
        event.type === "reserved"
        && (event.purpose === "translate"
          || event.purpose === "paragraph_fragment")
          ? total + event.predictedTokens
          : total, 0);
    assert.ok(
      translationBaseline >= legalReservations,
      `${translationBaseline} must cover ${legalReservations}`,
    );
    assert.equal(
      store.activeTranslations("run-lossless")[0]?.text
        .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u).length,
      14,
    );
  } finally {
    store.close();
  }
});

test("an already-fragmented structural failure never falls back to whole-block framed text", async () => {
  const sourceParagraphs = Array.from(
    { length: 14 },
    (_, index) =>
      `the quiet mechanism preserves every source detail in paragraph ${index + 1}.`,
  );
  const fixture = losslessFixture(sourceParagraphs.join("\n\n"));
  const protocols: string[] = [];
  const missingSubmission = (context: Context) => {
    protocols.push(
      userText(context).includes("EXACT FRAME PAIRS")
        ? "framed_text"
        : "typed_tool",
    );
    return fauxAssistantMessage("No terminating submission was produced.");
  };
  const fragmentResponse = (context: Context) => {
    const prompt = userText(context);
    protocols.push(
      prompt.includes("EXACT FRAME PAIRS") ? "framed_text" : "typed_tool",
    );
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    assert.ok(match?.[1], prompt.slice(0, 800));
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    const block = window.blocks[0]!;
    if (block.paragraphs.length === 1) {
      return fauxAssistantMessage(fauxToolCall(
        "finalize_paragraph_fragment",
        {
          text: "这是完整的单段译文，保留当前源段落的全部普通信息。",
        },
      ), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: block.paragraphs.map((_, index) => ({
              text: `这是第 ${index + 1} 段完整译文，保留当前源段落的全部普通信息。`,
          })),
        })),
      }],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses([
    missingSubmission,
    ...Array.from({ length: 8 }, () => fragmentResponse),
  ]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(protocols.length, 4);
  assert.ok(protocols.every((protocol) => protocol === "typed_tool"));
  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows + result.status.warningWindows, 1);
});

test("shape collapse on a smaller single block routes to typed fragments, not framed text", async () => {
  const sourceParagraphs = Array.from(
    { length: 8 },
    (_, index) =>
      `the ordinary apparatus preserves all details in source paragraph ${index + 1}.`,
  );
  const fixture = losslessFixture(sourceParagraphs.join("\n\n"));
  const protocols: string[] = [];
  const collapsed = (context: Context) => {
    protocols.push(
      userText(context).includes("EXACT FRAME PAIRS")
        ? "framed_text"
        : "typed_tool",
    );
    const windows = promptBatchWindows(context);
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          text: "过短。",
        })),
        notes: [],
      })),
    }), { stopReason: "toolUse" });
  };
  const fragmentResponse = (context: Context) => {
    const prompt = userText(context);
    protocols.push(
      prompt.includes("EXACT FRAME PAIRS") ? "framed_text" : "typed_tool",
    );
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    assert.ok(match?.[1], prompt.slice(0, 800));
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: block.paragraphs.map((_, index) => ({
              text: `这是恢复后的第${index + 1}段完整译文，包含源段落全部信息。`,
          })),
        })),
      }],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses([
    collapsed,
    fragmentResponse,
    fragmentResponse,
  ]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows + result.status.warningWindows, 1);
  assert.deepEqual(protocols, ["typed_tool", "typed_tool"]);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const events = store.loadTokenLedgerEvents("run-lossless");
    const reservations = events.filter((event) =>
      event.type === "reserved" && event.purpose === "paragraph_fragment");
    assert.equal(reservations.length, 1);
    const reservation = reservations[0];
    assert.ok(reservation?.type === "reserved");
    const requestId = reservation.requestId;
    assert.equal(events.filter((event) =>
      event.type === "dispatched" && event.requestId === requestId).length, 1);
    assert.equal(events.filter((event) =>
      event.type === "settled" && event.requestId === requestId).length, 1);
  } finally {
    store.close();
  }
});

test("resumed paragraph recovery allocates a fresh ledger attempt after a terminal prior attempt", async () => {
  const sourceParagraphs = Array.from(
    { length: 8 },
    (_, index) =>
      `the ordinary apparatus preserves all details in source paragraph ${index + 1}.`,
  );
  const fixture = losslessFixture(sourceParagraphs.join("\n\n"));
  const collapsed = (context: Context) => {
    const windows = promptBatchWindows(context);
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          text: "过短。",
        })),
        notes: [],
      })),
    }), { stopReason: "toolUse" });
  };
  const fragmentResponse = (context: Context) => {
    const prompt = userText(context);
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    assert.ok(match?.[1], prompt.slice(0, 800));
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{ sourceText: string }>;
      }>;
    }>;
    const window = windows[0]!;
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: block.paragraphs.map((_, index) => ({
            text: `这是恢复后的第 ${index + 1} 段完整译文，包含源段落全部信息。`,
          })),
        })),
      }],
    }), { stopReason: "toolUse" });
  };
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );
  const run = async (maxAttempts: number) => runBook({
    ...fixture.options,
    model,
    streamFn,
    maxAttempts,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  fixture.faux.setResponses([
    collapsed,
    fragmentResponse,
    fragmentResponse,
  ]);
  const first = await run(1);
  assert.equal(first.status.completedWindows + first.status.warningWindows, 1);

  const database = new DatabaseSync(fixture.options.storePath);
  try {
    database.prepare(`
      UPDATE window_plans
      SET status='pending', result_status=NULL, snapshot_id=NULL,
          last_error='simulated interrupted replay', updated_at=datetime('now')
      WHERE run_id=?
    `).run("run-lossless");
    database.prepare(`
      UPDATE translation_runs SET status='running' WHERE run_id=?
    `).run("run-lossless");
  } finally {
    database.close();
  }

  fixture.faux.setResponses([
    collapsed,
    fragmentResponse,
    fragmentResponse,
  ]);
  const resumed = await run(2);
  assert.equal(resumed.status.humanRequiredWindows, 0, JSON.stringify(resumed.windows));
  assert.equal(
    resumed.status.completedWindows + resumed.status.warningWindows,
    1,
  );

  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const paragraphReservations = store
      .loadTokenLedgerEvents("run-lossless")
      .filter((event): event is Extract<LedgerEvent, { type: "reserved" }> =>
        event.type === "reserved"
        && event.purpose === "paragraph_fragment");
    assert.equal(paragraphReservations.length, 2);
    assert.equal(
      new Set(paragraphReservations.map((event) => event.requestId)).size,
      2,
    );
    assert.match(paragraphReservations[1]!.requestId, /:recovery-1$/u);
  } finally {
    store.close();
  }
});

test("paragraph fragments retain bounded repair credits across independent units", async () => {
  const sourceParagraphs = [
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `the mechanism preserves every ordinary detail in source paragraph ${index + 1}.`,
    ),
    "the final paragraph closes the ordinary sequence without the protected term.",
  ];
  const fixture = losslessFixture(sourceParagraphs.join("\n\n"));
  const glossaryPath = join(dirname(fixture.canonicalPath), "glossary.json");
  writeFileSync(glossaryPath, JSON.stringify({
    schema: "folioloom-glossary-1",
    terms: [{
      source: "mechanism",
      target: "机械核心",
      policy: "locked",
    }],
  }), "utf8");
  const context = BookContext.openLossless({
    manifestPath: fixture.options.manifestPath,
  });
  const glossary = loadGlossary({
    glossaryPath,
    blocks: context.losslessBlocks,
    profile: context.languageProfile,
  });
  context.close();

  let repairParagraphCount = 0;
  let repairCalls = 0;
  const fragmentResponse = (
    requestContext: Context,
    includeLockedTarget: boolean,
  ) => {
    const prompt = userText(requestContext);
    const match =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    assert.ok(match?.[1], prompt.slice(0, 800));
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{
        blockId: string;
        paragraphs: Array<{
          paragraphId: string;
          ordinal: number;
          sourceText: string;
        }>;
      }>;
    }>;
    const window = windows[0]!;
    const paragraphs = window.blocks[0]?.paragraphs ?? [];
    repairParagraphCount = paragraphs.length;
    if (paragraphs.length === 1) {
      const block = window.blocks[0]!;
      return fauxAssistantMessage(fauxToolCall(
        "finalize_paragraph_fragment",
        {
          text: "这是足够完整且保留全部动作因果与叙述细节的单段中文译文。",
        },
      ), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          paragraphs: paragraphs.map((_, index) => ({
            text: `这是第${index + 1}段足够完整且保留全部动作因果与叙述细节的中文译文${
              includeLockedTarget ? "，其中明确写出机械核心" : ""
            }。`,
          })),
        })),
      }],
    }), { stopReason: "toolUse" });
  };
  const repairResponse = (requestContext: Context) => {
    repairCalls += 1;
    const blockIds = [...new Set([
      ...userText(requestContext).matchAll(/\[(block-[0-9a-f]+)\]/gu),
    ].map((match) => match[1]).filter(
      (value): value is string => value !== undefined,
    ))];
    return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: blockIds.map((blockId) => ({
        blockId,
        text: Array.from(
          { length: repairParagraphCount },
          (_, index) =>
            `这是第${index + 1}段修复后的完整中文译文，机械核心及其动作、因果和叙述细节均被保留。`,
        ).join("\n\n"),
      })),
      notes: [],
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses([
    (requestContext) => fragmentResponse(requestContext, false),
    repairResponse,
    (requestContext) => fragmentResponse(requestContext, false),
    repairResponse,
    (requestContext) => fragmentResponse(requestContext, true),
  ]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  const result = await runBook({
    ...fixture.options,
    glossary,
    model,
    streamFn,
    schedulerMode: "active",
    maxAttempts: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(repairCalls, 2);
  assert.equal(fixture.faux.state.callCount, 4);
  assert.equal(result.status.humanRequiredWindows, 0, JSON.stringify({
    status: result.status,
    windows: result.windows,
  }));
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    assert.equal(store.activeTranslations("run-lossless").length, 1);
  } finally {
    store.close();
  }
});

test("a degenerate multi-block translation is retried as isolated block fragments", async () => {
  const fixture = losslessFixture([
    "Alpha ".repeat(300),
    "Alpha ".repeat(300),
  ].join("[[]]"));
  const observedBlockGroups: string[][] = [];
  const degenerateFramedResponse = (context: Context) => {
    const prompt = userText(context);
    const windows = promptBatchWindows(context);
    observedBlockGroups.push(windows.flatMap((window) =>
      window.blocks.map((item) => item.blockId)));
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    const lines = windows.flatMap((window) => window.blocks.flatMap((item) => {
      const begin = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:BEGIN:${item.blockId}@@`));
      const end = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:END:${item.blockId}@@`));
      assert.ok(begin && end);
      return [begin, "摘要。", end];
    }));
    return fauxAssistantMessage(lines.join("\n"));
  };
  const degenerateRepairResponse = (context: Context) => {
    const ids = [...new Set([...userText(context).matchAll(/\[(block-[0-9a-f]+)\]/gu)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined))];
    return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: ids.map((blockId) => ({ blockId, text: "摘要。" })),
      notes: [],
    }), { stopReason: "toolUse" });
  };
  const validResponse = (context: Context) => {
    observedBlockGroups.push(promptBatchWindows(context).flatMap((window) =>
      window.blocks.map((item) => item.blockId)));
    return losslessBatchResponse(context);
  };
  fixture.faux.setResponses([
    degenerateFramedResponse,
    degenerateRepairResponse,
    validResponse,
    validResponse,
  ]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    maxRequestTokens: 4_000,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows, 1);
  assert.equal(result.windows[0]?.attemptCount, 1, JSON.stringify({
    windows: result.windows.map((window) => ({
      status: window.status,
      attemptCount: window.attemptCount,
      lastError: window.lastError,
    })),
    observedBlockGroups,
  }));
  assert.deepEqual(observedBlockGroups.map((items) => items.length), [2, 1, 1]);
});

test("a copied source-script multi-block translation is isolated before the outer retry", async () => {
  const fixture = losslessFixture([
    "\ubb35\ud5a5\uc740 \ucc9c\uc9c0\ubb38\uc73c\ub85c \uac78\uc5b4\uac14\ub2e4. ".repeat(50),
    "\uc124\uc57d\ubcbd\uc740 \uc625\uad00\ud328\uc5d0\uac8c \uc870\uc6a9\ud788 \ub2f5\ud588\ub2e4. ".repeat(50),
  ].join("[[]]"), "ko");
  const observedBlockGroups: string[][] = [];
  const copiedById = new Map<string, string>();
  const copiedResponse = (context: Context) => {
    const prompt = userText(context);
    const windows = promptBatchWindows(context);
    observedBlockGroups.push(windows.flatMap((window) => window.blocks.map((item) => item.blockId)));
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    const lines = windows.flatMap((window) => window.blocks.flatMap((item) => {
      assert.ok(item.sourceText);
      copiedById.set(item.blockId, item.sourceText);
      const begin = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:BEGIN:${item.blockId}@@`));
      const end = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:END:${item.blockId}@@`));
      assert.ok(begin && end);
      return [begin, item.sourceText, end];
    }));
    return fauxAssistantMessage(lines.join("\n"));
  };
  const copiedRepair = (context: Context) => {
    const ids = [...new Set([...userText(context).matchAll(/\[(block-[0-9a-f]+)\]/gu)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined))];
    return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: ids.map((blockId) => ({
        blockId,
        text: copiedById.get(blockId) ?? "\ubb35\ud5a5\uc740 \uadf8\ub300\ub85c \uc11c \uc788\uc5c8\ub2e4.",
      })),
      notes: [],
    }), { stopReason: "toolUse" });
  };
  const validResponse = (context: Context) => {
    const prompt = userText(context);
    const windows = promptBatchWindows(context);
    observedBlockGroups.push(windows.flatMap((window) =>
      window.blocks.map((item) => item.blockId)));
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    const lines = windows.flatMap((window) => window.blocks.flatMap((item) => {
      assert.ok(item.sourceText);
      const begin = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:BEGIN:${item.blockId}@@`));
      const end = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:END:${item.blockId}@@`));
      assert.ok(begin && end);
      const sentence = item.sourceText.includes("\ubb35\ud5a5")
        ? "墨香沿着山路走向天地门，叙事保留了沿途细节与行动因果。"
        : "薛若碧低声回答玉冠霸，译文完整保留了人物关系与现场变化。";
      const text = sentence.repeat(Math.ceil(Array.from(item.sourceText).length * 0.72 / Array.from(sentence).length));
      return [begin, text, end];
    }));
    return fauxAssistantMessage(lines.join("\n"));
  };
  fixture.faux.setResponses([
    copiedResponse,
    copiedRepair,
    ...Array.from({ length: 10 }, () => validResponse),
  ]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 2, maxSourceTokens: 4_000 },
    maxRequestTokens: 4_000,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0, JSON.stringify({
    observedBlockGroups,
    callCount: fixture.faux.state.callCount,
    windows: result.windows.map((window) => ({
      status: window.status,
      attemptCount: window.attemptCount,
      lastError: window.lastError,
    })),
  }));
  assert.equal(result.windows[0]?.attemptCount, 1, JSON.stringify(result.windows));
  assert.deepEqual(observedBlockGroups.map((items) => items.length), [2, 1, 1]);
});

function createFixture(path: string, blockCount: number): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY, legacy_id TEXT, chapter_id TEXT, chapter_title TEXT,
      block_index INTEGER, global_index INTEGER, source_text TEXT,
      source_hash TEXT, token_count INTEGER
    );
    CREATE TABLE concepts (
      id TEXT PRIMARY KEY, canonical_source TEXT, default_target TEXT,
      working_target TEXT, verified_target TEXT, status TEXT, locked INTEGER,
      retired_version INTEGER
    );
    CREATE TABLE lexemes (
      id TEXT PRIMARY KEY, canonical_form TEXT, default_target TEXT,
      working_target TEXT, verified_target TEXT, status TEXT, locked INTEGER,
      retired_version INTEGER
    );
    CREATE TABLE concept_lexemes (
      concept_id TEXT, lexeme_id TEXT, status TEXT, retired_version INTEGER
    );
    CREATE TABLE source_forms (lexeme_id TEXT, form TEXT);
  `);
  const insert = database.prepare(`
    INSERT INTO blocks VALUES(?, ?, 'ch1', 'One', ?, ?, ?, ?, 12)
  `);
  for (let index = 0; index < blockCount; index += 1) {
    insert.run(
      `block-${index}`,
      `legacy-${index}`,
      index,
      index,
      `The person moved slowly through room ${index}.`,
      `hash-${index}`,
    );
  }
  database.close();
}

function userText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message && message.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
}

function dynamicResponse(context: Context) {
  const prompt = userText(context);
  if (prompt.includes("Submit zero to four additional questions")) {
    return fauxAssistantMessage(
      fauxToolCall("submit_questions", { questions: [] }),
      { stopReason: "toolUse" },
    );
  }
  const ids = [...prompt.matchAll(/\[(block-\d+)\]/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(ids.length > 0, prompt.slice(0, 300));
  return fauxAssistantMessage(fauxToolCall("finalize_translation", {
    translations: ids.map((blockId) => ({
      blockId,
      text: "这是对应文本块的完整中文译文，保留了原文全部信息。",
    })),
    notes: [],
  }), { stopReason: "toolUse" });
}

function losslessBatchResponse(context: Context) {
  const prompt = userText(context);
  const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  const windows = JSON.parse(match[1]) as Array<{
    windowId: string;
    blocks: Array<{ blockId: string; sourceText: string }>;
  }>;
  const termMatch = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(prompt);
  const terms = JSON.parse(termMatch?.[1] ?? "[]") as Array<{
    sourceForm: string;
    target: string;
  }>;
  const occurrenceMatch = /TERM OCCURRENCES\n\n(\[[^\n]*\])/u.exec(prompt);
  const occurrences = JSON.parse(occurrenceMatch?.[1] ?? "[]") as Array<{
    occurrenceId: string;
    blockId: string;
    conceptId: string;
    sourceForm: string;
    sourceStart: number;
    sourceEnd: number;
    canonicalTarget: string;
  }>;
  const submission = {
    windows: windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blocks.map((block) => {
        const prefix = [...block.blockId.slice(-8)].map((digit) => ({
          "0": "零", "1": "一", "2": "二", "3": "三",
          "4": "四", "5": "五", "6": "六", "7": "七",
          "8": "八", "9": "九", a: "甲", b: "乙", c: "丙",
          d: "丁", e: "戊", f: "己",
        })[digit] ?? "庚").join("");
        const relevantTargets = terms.filter((term) => block.sourceText.toLocaleLowerCase()
          .includes(term.sourceForm.toLocaleLowerCase()))
          .map((term) => term.target).join("、");
        const paragraphs = block.sourceText
          .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
          .filter((paragraph) => paragraph.trim().length > 0);
        return {
          blockId: block.blockId,
          text: paragraphs.map((paragraph, index) =>
            `${index === 0 ? `${prefix}${relevantTargets}` : "续"}${"完整译文".repeat(
              Math.max(1, Math.ceil([...paragraph].length / 12)),
            )}。`).join("\n\n"),
        };
      }),
      termUsages: occurrences
        .filter((occurrence) => window.blocks.some((block) =>
          block.blockId === occurrence.blockId))
        .map((occurrence) => ({
          occurrenceId: occurrence.occurrenceId,
          blockId: occurrence.blockId,
          conceptId: occurrence.conceptId,
          sourceForm: occurrence.sourceForm,
          sourceStart: occurrence.sourceStart,
          sourceEnd: occurrence.sourceEnd,
          discourseRole: "other",
          targetSurface: occurrence.canonicalTarget,
        })),
      notes: [],
    })),
  };
  if (prompt.includes("EXACT FRAME PAIRS")) {
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    const responseLines = submission.windows.flatMap((window) =>
      window.translations.flatMap((translation) => {
        const begin = promptLines.find((line) =>
          line.startsWith("@@FOLIOLOOM:")
          && line.endsWith(`:BEGIN:${translation.blockId}@@`));
        const end = promptLines.find((line) =>
          line.startsWith("@@FOLIOLOOM:")
          && line.endsWith(`:END:${translation.blockId}@@`));
        assert.ok(begin && end, `missing frame markers for ${translation.blockId}`);
        return [begin, translation.text, end];
      }));
    return fauxAssistantMessage(responseLines.join("\n"));
  }
  return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", submission), {
    stopReason: "toolUse",
  });
}

function promptBatchWindows(context: Context): Array<{
  windowId: string;
  blocks: Array<{ blockId: string; sourceText?: string }>;
}> {
  const prompt = userText(context);
  const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  return JSON.parse(match[1]) as Array<{
    windowId: string;
    blocks: Array<{ blockId: string; sourceText?: string }>;
  }>;
}

function lexicalAnchorResponse(
  context: Context,
  entityLink?: {
    sourceForms: string[];
    proposedTarget: string;
    evidenceQuote: string;
  },
) {
  const prompt = userText(context);
  const match = /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  const candidates = JSON.parse(match[1]) as Array<{ sourceForm: string }>;
  return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: candidates.map((candidate) => ({
      sourceForm: candidate.sourceForm,
      target: entityLink?.sourceForms.includes(candidate.sourceForm)
        ? entityLink.proposedTarget
        : `译-${candidate.sourceForm}`,
      mode: "stable",
      semanticClass: entityLink?.sourceForms.includes(candidate.sourceForm)
        ? "proper_name"
        : "technical_term",
      confidence: 0.95,
    })),
    entityLinks: entityLink === undefined ? [] : [{
      ...entityLink,
      evidenceKind: "explicit_naming",
      confidence: 0.98,
    }],
  }), { stopReason: "toolUse" });
}

function lexicalPreferredFallbackResponse(
  context: Context,
  targets: Readonly<Record<string, string>>,
) {
  const prompt = userText(context);
  const begin = /^@@FOLIOLOOM:LEXICAL-PREFERRED:[a-f0-9]+:BEGIN@@$/mu.exec(prompt)?.[0];
  const end = /^@@FOLIOLOOM:LEXICAL-PREFERRED:[a-f0-9]+:END@@$/mu.exec(prompt)?.[0];
  assert.ok(begin, prompt.slice(0, 1_000));
  assert.ok(end, prompt.slice(0, 1_000));
  return fauxAssistantMessage([
    begin,
    JSON.stringify(Object.entries(targets).map(([sourceForm, target]) => ({
      sourceForm,
      target,
      semanticClass: "proper_name",
      confidence: 0.95,
    }))),
    end,
  ].join("\n"));
}

test("completed waves remember contextual anchor decisions and free later slots for names", async () => {
  const diffuse = [
    "보이지", "정점", "있던", "빨리", "얘기", "제자", "교주님", "하지",
    "그들", "음식", "주십시오", "사부님", "선배님", "지나자", "아니", "보여",
  ];
  const commonText = diffuse.map((form) => `${form}는 ${form}가`).join(". ");
  const namedText = `${commonText}. 진양은 진양이 진양을 만났다. 옥관패는 옥관패가 옥관패를 들었다.`;
  const fixture = losslessFixture([
    commonText,
    commonText,
    namedText,
    namedText,
  ].join("[[]]"), "ko");
  const anchorWaves: string[][] = [];
  const response = (context: Context) => {
    const prompt = userText(context);
    if (prompt.includes("SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE")) {
      const match = /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u.exec(prompt);
      assert.ok(match?.[1]);
      const candidates = JSON.parse(match[1]) as Array<{ sourceForm: string }>;
      anchorWaves.push(candidates.map((candidate) => candidate.sourceForm));
      return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
        anchors: candidates.map((candidate) => ({
          sourceForm: candidate.sourceForm,
          target: "",
          mode: "contextual",
          semanticClass: "ordinary_word",
          confidence: 0.99,
        })),
        entityLinks: [],
      }), { stopReason: "toolUse" });
    }
    return losslessBatchResponse(context);
  };
  fixture.faux.setResponses(Array.from({ length: 12 }, () => response));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 1_000 },
    maxRequestTokens: 1_000,
    maxWindowsPerRequest: 1,
    maxConcurrency: 1,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0);
  assert.ok(anchorWaves.length >= 2, JSON.stringify(anchorWaves));
  assert.ok(anchorWaves[1]?.includes("진양"), JSON.stringify(anchorWaves));
  assert.ok(anchorWaves[1]?.includes("옥관패"), JSON.stringify(anchorWaves));
  assert.ok(anchorWaves[1]?.every((form) => !anchorWaves[0]?.includes(form)), JSON.stringify(anchorWaves));
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const decisions = store.knowledgeRevisions("run-lossless")
      .filter((revision) => revision.kind === "lexical_anchor_decision");
    assert.ok(decisions.length > 0);
    assert.ok(decisions.every((revision) => revision.status === "contextual"));
  } finally {
    store.close();
  }
});

test("completed waves persist a contextual role as one closed lexical concept", async () => {
  const source = [
    "Prokurist sprach mit Gregor.",
    "Gregor antwortete dem Prokurist.",
    "Der Prokurist beobachtete Gregor.",
  ].join(" ");
  const fixture = losslessFixture(source, "de");
  const response = (context: Context) => {
    const prompt = userText(context);
    if (prompt.includes("SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE")) {
      const match =
        /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u
          .exec(prompt);
      assert.ok(match?.[1]);
      const candidates = JSON.parse(match[1]) as Array<{ sourceForm: string }>;
      return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
        anchors: candidates.map((candidate) => candidate.sourceForm === "Prokurist"
          ? {
              sourceForm: candidate.sourceForm,
              target: "主事",
              mode: "contextual",
              semanticClass: "role",
              confidence: 0.95,
            }
          : {
              sourceForm: candidate.sourceForm,
              target: candidate.sourceForm === "Gregor" ? "格里高尔" : "",
              mode: candidate.sourceForm === "Gregor" ? "stable" : "contextual",
              semanticClass: candidate.sourceForm === "Gregor"
                ? "proper_name"
                : "ordinary_word",
              confidence: 0.95,
            }),
        entityLinks: [],
      }), { stopReason: "toolUse" });
    }
    return losslessBatchResponse(context);
  };
  fixture.faux.setResponses(Array.from({ length: 6 }, () => response));

  const result = await runBook(fixture.options as never);
  assert.equal(result.status.humanRequiredWindows, 0);

  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const prokurist = store.knowledgeRevisions("run-lossless")
      .filter((revision) => revision.normalizedSubject === "prokurist");
    assert.equal(prokurist.length, 1);
    assert.equal(prokurist[0]?.kind, "lexical_concept");
    assert.equal((prokurist[0]?.payload as { policy?: string }).policy, "contextual");
    assert.equal(
      (prokurist[0]?.payload as { canonicalTarget?: string }).canonicalTarget,
      "主事",
    );
    const conceptId = (prokurist[0]?.payload as { conceptId?: string }).conceptId;
    assert.ok(conceptId);
    assert.equal(
      store.activeLexicalConcept("run-lossless", conceptId)?.canonicalTarget,
      "主事",
    );
    assert.equal(
      store.conceptOccurrences("run-lossless", conceptId)
        .reduce((total, occurrence) =>
          total + occurrence.sourceSpans.length, 0),
      3,
    );
    const bindings = store.activeTranslations("run-lossless")
      .flatMap((translation) =>
        store.activeTranslationBindings("run-lossless", translation.blockId))
      .filter((binding) => binding.conceptId === conceptId);
    assert.ok(bindings.length > 0);
    assert.equal(
      bindings.reduce((total, binding) =>
        total + binding.termUsages.length, 0),
      3,
    );
  } finally {
    store.close();
  }
});

test("a stable anchor below the projection threshold is reconsidered in the next wave", async () => {
  const source = "Smoky met Edgewood. Smoky left Edgewood.";
  const fixture = losslessFixture(`${source}[[]]${source}`);
  const anchorWaves: string[][] = [];
  const response = (context: Context) => {
    const prompt = userText(context);
    if (prompt.includes("SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE")) {
      const match = /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u.exec(prompt);
      assert.ok(match?.[1]);
      const candidates = JSON.parse(match[1]) as Array<{ sourceForm: string }>;
      anchorWaves.push(candidates.map((candidate) => candidate.sourceForm));
      return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
        anchors: candidates.map((candidate) => ({
          sourceForm: candidate.sourceForm,
          target: `\u8bd1-${candidate.sourceForm}`,
          mode: "stable",
          semanticClass: "proper_name",
          confidence: 0.79,
        })),
        entityLinks: [],
      }), { stopReason: "toolUse" });
    }
    return losslessBatchResponse(context);
  };
  fixture.faux.setResponses(Array.from({ length: 8 }, () => response));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const runOptions = {
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 1_000 },
    maxRequestTokens: 1_000,
    maxWindowsPerRequest: 1,
    maxConcurrency: 1,
  };
  const first = await runBook({ ...runOptions, maxWindows: 1 } as never);
  assert.equal(first.status.completedWindows, 1);
  const result = await runBook(runOptions as never);

  assert.equal(result.status.completedWindows, 2);
  assert.equal(anchorWaves.length, 2, JSON.stringify(anchorWaves));
  assert.ok(anchorWaves[0]?.every((form) => anchorWaves[1]?.includes(form)));
});

test("adjacent physical requests cannot commit the same ungrounded long translation", async () => {
  const fixture = losslessFixture([
    "alpha river stone wind ".repeat(24),
    "beta forest cloud rain ".repeat(24),
  ].join("[[]]"));
  let translationCall = 0;
  const response = (context: Context) => {
    translationCall += 1;
    const prompt = userText(context);
    const windows = promptBatchWindows(context);
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    const responseLines = windows.flatMap((window) => window.blocks.flatMap((item) => {
      const begin = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:BEGIN:${item.blockId}@@`));
      const end = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:END:${item.blockId}@@`));
      assert.ok(begin && end);
      const text = translationCall <= 2
        ? "这是跨请求重复的同一段错误译文。".repeat(22)
        : translationCall === 3
          ? "晨光越过群山，旅人沿着石径缓缓走向远方。".repeat(18)
          : "夜潮拍打礁岸，渔船收起风帆驶入寂静港湾。".repeat(18);
      return [begin, text, end];
    }));
    return fauxAssistantMessage(responseLines.join("\n"));
  };
  fixture.faux.setResponses(Array.from({ length: 8 }, () => response));
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 1_000 },
    maxRequestTokens: 1_000,
    maxWindowsPerRequest: 1,
    maxConcurrency: 1,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0, JSON.stringify({
    translationCall,
    windows: result.windows.map((window) => ({
      status: window.status,
      attemptCount: window.attemptCount,
      lastError: window.lastError,
    })),
  }));
  assert.ok(translationCall >= 3, `expected a boundary retry, got ${translationCall} calls`);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    assert.equal(new Set(store.activeTranslations("run-lossless").map((item) => item.text)).size, 2);
  } finally {
    store.close();
  }
});

test("cross-window overlap after repair is isolated at immutable window boundaries", async () => {
  const fixture = losslessFixture([
    "alpha river stone wind ".repeat(24),
    "beta forest cloud rain ".repeat(24),
  ].join("[[]]"));
  const observedBlockGroups: string[][] = [];
  const duplicateResponse = (context: Context) => {
    const prompt = userText(context);
    const windows = promptBatchWindows(context);
    observedBlockGroups.push(windows.flatMap((window) =>
      window.blocks.map((item) => item.blockId)));
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    return fauxAssistantMessage(windows.flatMap((window) => window.blocks.flatMap((item) => {
      const begin = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:BEGIN:${item.blockId}@@`));
      const end = promptLines.find((line) =>
        line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:END:${item.blockId}@@`));
      assert.ok(begin && end);
      return [begin, "这是跨窗口重复的同一段错误译文。".repeat(22), end];
    })).join("\n"));
  };
  const duplicateRepair = (context: Context) => {
    const ids = [...new Set([...userText(context).matchAll(/\[(block-[0-9a-f]+)\]/gu)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined))];
    return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: ids.map((blockId) => ({
        blockId,
        text: "这是跨窗口重复的同一段错误译文。".repeat(22),
      })),
      notes: [],
    }), { stopReason: "toolUse" });
  };
  const validResponse = (context: Context) => {
    observedBlockGroups.push(promptBatchWindows(context).flatMap((window) =>
      window.blocks.map((item) => item.blockId)));
    return losslessBatchResponse(context);
  };
  fixture.faux.setResponses([
    duplicateResponse,
    duplicateRepair,
    validResponse,
    validResponse,
  ]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(fixture.faux.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 1_000 },
    tinyWindowTokens: 1_000,
    maxRequestTokens: 2_000,
    maxWindowsPerRequest: 2,
    maxConcurrency: 1,
    runtimeSet: {
      mode: "fast",
      primary: { model, streamFn, effort: "off", thinkingLevel: "off" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(result.status.humanRequiredWindows, 0, JSON.stringify(result.windows));
  assert.deepEqual(observedBlockGroups.map((items) => items.length), [2, 1, 1]);
});

test("wave anchor runs once and every physical request receives the same preferred alias targets", async () => {
  const fixture = losslessFixture(
    "Loukianos, whom they called Lucian the Scoffer, laughed.\n\nBOOK ONE",
  );
  const translationPrompts: string[] = [];
  fixture.faux.setResponses([
    (context) => lexicalAnchorResponse(context, {
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget: "卢基阿诺斯",
      evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
    }),
    (context) => {
      translationPrompts.push(userText(context));
      return losslessBatchResponse(context);
    },
    (context) => {
      translationPrompts.push(userText(context));
      return losslessBatchResponse(context);
    },
  ]);

  const result = await runBook({
    ...fixture.options,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
  } as never);

  assert.equal(fixture.faux.state.callCount, 3);
  assert.equal(result.status.modelCalls, 3);
  assert.equal(translationPrompts.length, 2);
  const projectedTerms = translationPrompts.map((prompt) => {
    const match = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(prompt);
    assert.ok(match?.[1]);
    return JSON.parse(match[1]) as Array<{
      sourceForm: string;
      target: string;
      conceptId: string;
      locked: boolean;
    }>;
  });
  assert.deepEqual(projectedTerms[0], projectedTerms[1]);
  const aliases = projectedTerms[0]!.filter((term) =>
    term.sourceForm === "Loukianos" || term.sourceForm === "Lucian");
  assert.equal(aliases.length, 2);
  assert.equal(new Set(aliases.map((term) => term.target)).size, 1);
  assert.equal(new Set(aliases.map((term) => term.conceptId)).size, 2);
  assert.ok(aliases.every((term) => term.locked === false));

  const store = new LosslessBookStore(fixture.options.storePath);
  const revisions = store.knowledgeRevisions("run-lossless");
  store.close();
  assert.equal(revisions.filter((revision) => revision.kind === "entity_alias_link").length, 1);
});

test("one source-authored Hanja candidate reaches translation without a model anchor round trip", async () => {
  const fixture = losslessFixture(
    "\uc625\uad00\ud328(\u7389\u51a0\u8987)\uac00 \uc654\ub2e4. \uc625\uad00\ud328\uac00 \ub2e4\uc2dc \uc654\ub2e4.",
    "ko",
  );
  fixture.faux.setResponses([(context) => {
    const prompt = userText(context);
    assert.doesNotMatch(prompt, /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE/u);
    const match = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(prompt);
    assert.ok(match?.[1]);
    const terms = JSON.parse(match[1]) as Array<{
      sourceForm: string;
      target: string;
      policy: string;
    }>;
    assert.deepEqual(
      terms.filter((term) => term.sourceForm === "\uc625\uad00\ud328")
        .map((term) => [term.target, term.policy]),
      [["\u7389\u51a0\u9738", "preferred"]],
    );
    return losslessBatchResponse(context);
  }]);

  const result = await runBook(fixture.options as never);

  assert.equal(result.status.completedWindows, 1);
  assert.equal(fixture.faux.state.callCount, 1);
});

test("failed wave promotes no anchor knowledge and resume reuses its cached anchor decision", async () => {
  const fixture = losslessFixture(
    "Loukianos, whom they called Lucian the Scoffer, laughed.",
  );
  fixture.faux.setResponses([
    (context) => lexicalAnchorResponse(context, {
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget: "卢基阿诺斯",
      evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
    }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "503: fixture provider unavailable",
    }),
  ]);

  await assert.rejects(runBook(fixture.options as never), /provider unavailable/i);
  const failedStore = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(failedStore.knowledgeRevisions("run-lossless"), []);
  failedStore.close();

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([losslessBatchResponse]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);

  assert.equal(resumedProvider.state.callCount, 1);
  assert.equal(resumed.status.completedWindows, 1);
  const recoveredStore = new LosslessBookStore(fixture.options.storePath);
  assert.equal(
    recoveredStore.knowledgeRevisions("run-lossless")
      .filter((revision) => revision.kind === "entity_alias_link").length,
    1,
  );
  recoveredStore.close();
});

test("two tiny logical windows use one physical model session and commit independently", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    fixture.submission,
  ), { stopReason: "toolUse" })]);

  const result = await runBook(fixture.options as never);

  assert.equal(fixture.faux.state.callCount, 1);
  assert.equal(result.status.completedWindows, 2);
  assert.equal(result.status.modelCalls, 1);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    assert.deepEqual(store.listTranslationRuns()[0]?.metadata, {
      sourceLanguageProfile: {
        id: "en",
        version: "source-language-profile-5",
        compatibilityMode: false,
      },
      sourceAnomalies: {
        schema: "v5-source-anomaly-1",
        counts: {
          CONTROL_CHARACTER: 0,
          EXTREME_LONG_LINE: 0,
          REPEATED_FRONTMATTER_LINE: 0,
          REPLACEMENT_CHARACTER: 0,
          SPACED_HYPHENATION: 0,
        },
        findings: [],
      },
      translationRuntime: {
        mode: "quality",
        primary: { modelId: "faux-1" },
        escalation: { modelId: "faux-1" },
      },
    });
    const scheduler = store.latestSchedulerSnapshot("run-lossless");
    assert.ok(scheduler);
    assert.equal(scheduler.inFlight, 0);
    assert.equal(scheduler.inFlightTokens, 0);
  } finally {
    store.close();
  }
});

test("token ledger persists across resume and export without options.scheduler", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses(Array.from({ length: 12 }, () => losslessBatchResponse));

  const first = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "balanced",
    maxWindows: 1,
    maxConcurrency: 1,
  });
  assert.equal(first.status.completedWindows, 1, JSON.stringify(first.status));
  assert.ok(first.scheduler.baselineTokens > 0, JSON.stringify(first.scheduler));
  assert.ok(first.scheduler.actualTokens > 0, JSON.stringify(first.scheduler));

  const storeAfterFirst = new LosslessBookStore(fixture.options.storePath);
  try {
    const persisted = storeAfterFirst.loadSchedulerMetrics("run-lossless");
    assert.ok(persisted);
    assert.equal(persisted.actualTokens, first.scheduler.actualTokens);
    assert.equal(persisted.baselineTokens, first.scheduler.baselineTokens);
  } finally {
    storeAfterFirst.close();
  }

  const second = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "balanced",
    maxConcurrency: 1,
  });
  assert.ok(second.scheduler.baselineTokens >= first.scheduler.baselineTokens);
  assert.ok(second.scheduler.actualTokens >= first.scheduler.actualTokens);
  assert.equal(second.status.completedWindows, 2);

  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const { writeLosslessBookArtifacts } = await import("../src/report.js");
    const { readFileSync } = await import("node:fs");
    const output = mkdtempSync(join(tmpdir(), "folioloom-ledger-export-"));
    const paths = writeLosslessBookArtifacts(store, "run-lossless", output);
    const metrics = JSON.parse(readFileSync(paths.metrics, "utf8")) as {
      scheduler: null | { tokenEnvelope: { actualTokens: number } };
    };
    assert.notEqual(metrics.scheduler, null);
    assert.equal(
      metrics.scheduler?.tokenEnvelope.actualTokens,
      second.scheduler.actualTokens,
    );
  } finally {
    store.close();
  }
});

test("lossless runner reports shadow scheduler metrics without changing legacy dispatch", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    fixture.submission,
  ), { stopReason: "toolUse" })]);
  const runtimeProfiles = new RuntimeProfileStore(join(
    dirname(fixture.options.storePath),
    "runtime-profiles.db",
  ));

  const result = await runBook({
    ...fixture.options,
    schedulerMode: "shadow",
    optimizationProfile: "balanced",
    runtimeProfileStore: runtimeProfiles,
  });

  assert.equal(fixture.faux.state.callCount, 1);
  assert.equal(result.status.completedWindows, 2);
  assert.equal(result.scheduler.mode, "shadow");
  assert.equal(result.scheduler.profile, "balanced");
  assert.equal(result.scheduler.planningStatus, "shadow");
  assert.equal(result.scheduler.decisions, 1);
  assert.equal(result.scheduler.fallbacks, 0);
  assert.ok(result.scheduler.baselineWallTimeMs > 0);
  assert.ok(result.scheduler.baselineTokens > 0);
  assert.equal(
    result.scheduler.allowedTokens,
    Math.floor(result.scheduler.baselineTokens * 1.1),
  );
  assert.ok(result.scheduler.predictedWallTimeMs > 0);
  assert.ok(result.scheduler.actualWallTimeMs >= 0);
  assert.ok(result.scheduler.predictedTokens > 0);
  assert.ok(result.scheduler.actualTokens >= 0);
  assert.equal(typeof result.scheduler.tokenUsageComplete, "boolean");
  assert.deepEqual(result.scheduler.effortCounts, { high: 1 });
  assert.deepEqual(result.scheduler.protocolCounts, {
    typed_tool: 1,
    framed_text: 0,
    local: 0,
  });
  assert.equal(result.scheduler.plannerDeadlines, 0);
  assert.equal(result.scheduler.throttles, 0);
  assert.equal(result.scheduler.recoveries, 0);
  assert.equal(
    runtimeProfiles.observationsForProfile("faux-1:en").length,
    1,
  );
  runtimeProfiles.close();
});

test("off and shadow preserve multilingual prompts, outputs, and validation", async (t) => {
  const fixtures = [
    ["en", "Same source."],
    ["de", "Das Fenster war offen."],
    ["ko", "\uccab \ubb38\uc7a5\uc774\ub2e4. \ub2e4\uc74c \ubb38\uc7a5\uc774\ub2e4."],
    ["ja", "\u5f7c\u306f\u7b11\u3063\u305f\u3002\u305d\u3057\u3066\u53bb\u3063\u305f\u3002"],
  ] as const;

  for (const [language, source] of fixtures) {
    await t.test(language, async () => {
      const run = async (schedulerMode: "off" | "shadow") => {
        const fixture = losslessFixture(source, language);
        const promptDigests: string[] = [];
        const promptCoverage: string[][] = [];
        fixture.faux.setResponses([(context) => {
          promptDigests.push(privateDigest(userText(context)));
          promptCoverage.push(promptBatchWindows(context).flatMap((window) =>
            window.blocks.map((block) => block.blockId)));
          return losslessBatchResponse(context);
        }]);
        try {
          const result = await runBook({
            ...fixture.options,
            schedulerMode,
            optimizationProfile: "balanced",
          });
          const store = new LosslessBookStore(fixture.options.storePath);
          try {
            const translations = store.activeTranslations(result.runId)
              .map((translation) => ({
                blockId: translation.blockId,
                text: translation.text,
                status: translation.status,
                version: translation.version,
              }));
            return {
              promptDigests,
              promptCoverage,
              translationDigest: privateDigest(translations),
              validation: {
                outcome: result.outcome,
                status: result.status,
                windows: result.windows.map((window) => ({
                  windowId: window.windowId,
                  blockIds: window.blockIds,
                  status: window.status,
                  warnings: window.warnings,
                  lastError: window.lastError,
                })),
              },
              scheduler: result.scheduler,
            };
          } finally {
            store.close();
          }
        } finally {
          rmSync(dirname(fixture.options.storePath), {
            recursive: true,
            force: true,
          });
        }
      };

      const off = await run("off");
      const shadow = await run("shadow");
      assert.deepEqual(shadow.promptCoverage, off.promptCoverage);
      assert.deepEqual(shadow.promptDigests, off.promptDigests);
      assert.equal(shadow.translationDigest, off.translationDigest);
      assert.deepEqual(shadow.validation, off.validation);
      assert.deepEqual(shadow.scheduler.contextProfiles, off.scheduler.contextProfiles);
      assert.equal(shadow.scheduler.actualTokens, off.scheduler.actualTokens);
      assert.equal(shadow.scheduler.baselineTokens, off.scheduler.baselineTokens);
      const offPredictionError = Math.abs(
        off.scheduler.baselineTokens - off.scheduler.actualTokens,
      );
      const shadowPredictionError = Math.abs(
        shadow.scheduler.predictedTokens - shadow.scheduler.actualTokens,
      );
      assert.ok(Number.isFinite(offPredictionError));
      assert.ok(Number.isFinite(shadowPredictionError));
      assert.equal(off.scheduler.mode, "off");
      assert.equal(off.scheduler.planningStatus, "disabled");
      assert.equal(shadow.scheduler.mode, "shadow");
      assert.equal(shadow.scheduler.planningStatus, "shadow");
      assert.ok(shadow.scheduler.decisions > 0);
    });
  }
});

test("low-risk windows use lean context while high-risk windows keep rich evidence", async () => {
  const fixture = losslessFixture("a quiet room.[[]]a damaged \uFFFD line.");
  fixture.faux.setResponses([
    losslessBatchResponse,
    losslessBatchResponse,
  ]);

  const result = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "balanced",
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
  });

  const orderedWindows = [...result.windows].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  assert.deepEqual(result.scheduler.contextProfiles, {
    [orderedWindows[0]!.windowId]: "lean",
    [orderedWindows[1]!.windowId]: "rich",
  });
});

test("active quality runs can select a lower legal effort variant", async () => {
  const fixture = losslessFixture("a quiet room.");
  const low = fauxProvider();
  const high = fauxProvider();
  low.setResponses([losslessBatchResponse]);
  high.setResponses([losslessBatchResponse]);
  const model = high.getModel();
  const highStream = high.provider.streamSimple.bind(high.provider);

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn: highStream,
    schedulerMode: "active",
    optimizationProfile: "economy",
    runtimeSet: {
      mode: "quality",
      primary: {
        model,
        streamFn: highStream,
        effort: "high",
        thinkingLevel: "high",
      },
      escalation: {
        model,
        streamFn: highStream,
        effort: "high",
        thinkingLevel: "high",
      },
      variants: [{
        model: low.getModel(),
        streamFn: low.provider.streamSimple.bind(low.provider),
        effort: "low",
        thinkingLevel: "low",
      }, {
        model,
        streamFn: highStream,
        effort: "high",
        thinkingLevel: "high",
      }],
    },
  });

  assert.equal(result.status.completedWindows, 1);
  assert.equal(low.state.callCount, 1);
  assert.equal(high.state.callCount, 0);
});

test("evidence at least twenty-four blocks away forces rich context", async () => {
  const fixture = losslessFixture(
    Array.from(
      { length: 25 },
      (_, index) => `plain segment ${index}.`,
    ).join("[[]]"),
  );
  fixture.faux.setResponses([losslessBatchResponse]);
  const first = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "balanced",
    maxWindows: 24,
    maxConcurrency: 1,
    tinyWindowTokens: 100,
    maxRequestTokens: 1_000,
    maxWindowsPerRequest: 24,
  });
  const ordered = [...first.windows].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const firstBlockId = ordered[0]?.blockIds[0];
  const remoteBlockId = ordered[24]?.blockIds[0];
  assert.ok(firstBlockId && remoteBlockId);
  commitManualKnowledge(
    fixture.options.storePath,
    "memory",
    "remote-memory",
    "narrative_memory",
    {
      summary: "synthetic prior state",
      startBlockId: firstBlockId,
      endBlockId: remoteBlockId,
    },
  );

  fixture.faux.setResponses([losslessBatchResponse]);
  const resumed = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "balanced",
    maxConcurrency: 1,
    tinyWindowTokens: 100,
    maxRequestTokens: 1_000,
    maxWindowsPerRequest: 24,
  });

  assert.ok(
    Object.values(resumed.scheduler.contextProfiles).includes("rich"),
    JSON.stringify(resumed.scheduler.contextProfiles),
  );
});

test("failed lossless doctor blocks every model call", async () => {
  const fixture = losslessFixture("Alpha.");
  writeFileSync(fixture.canonicalPath, "Corrupt.", "utf8");

  await assert.rejects(runBook(fixture.options as never), /HASH_MISMATCH/);
  assert.equal(fixture.faux.state.callCount, 0);
});

test("lossless runner feeds single-call provider usage back into model-scoped calibration", async () => {
  const fixture = losslessFixture("A plain sentence without named entities.");
  fixture.faux.setResponses([losslessBatchResponse]);
  const estimator = new TrackingTokenEstimator();

  const result = await runBook({
    ...fixture.options,
    tokenEstimator: estimator,
  } as never);

  assert.equal(result.status.completedWindows + result.status.warningWindows, 1);
  assert.equal(estimator.observations.length, 1);
  assert.equal(estimator.observations[0]?.modelId, fixture.faux.getModel().id);
  assert.equal(estimator.observations[0]?.profile.id, "en");
  assert.ok((estimator.observations[0]?.actualInputTokens ?? 0) > 0);
});

test("complete request admission rejects a tiny context before any provider call", async () => {
  const fixture = losslessFixture("The bell rings above the empty court.");
  const model = {
    ...fixture.faux.getModel(),
    contextWindow: 256,
    maxTokens: 128,
  };
  await assert.rejects(
    runBook({ ...fixture.options, model } as never),
    (error: unknown) => error instanceof BookRequestCapacityError,
  );
  assert.equal(fixture.faux.state.callCount, 0);
});

test("preflight splits one oversized logical window only at immutable block boundaries", async () => {
  const fixture = losslessFixture(`${"word ".repeat(3_000)}.`);
  const observedBlockGroups: string[][] = [];
  const observedRequestIds: string[] = [];
  fixture.faux.setResponses(Array.from({ length: 2 }, () => (context: Context) => {
    const prompt = userText(context);
    observedRequestIds.push(/PHYSICAL REQUEST ([^\n]+)/u.exec(prompt)?.[1] ?? "");
    observedBlockGroups.push(promptBatchWindows(context).flatMap((window) =>
      window.blocks.map((block) => block.blockId)));
    return losslessBatchResponse(context);
  }));
  const tokenEstimator = {
    estimateText(text: string) {
      return {
        tokens: text.startsWith("WINDOWS\n\n")
          ? (text.match(/"blockId"/gu)?.length ?? 0) * 900
          : 1,
        uncertainty: 0,
      };
    },
    estimateJson() {
      return { tokens: 0, uncertainty: 0 };
    },
    observeUsage() {},
  };
  const model = {
    ...fixture.faux.getModel(),
    contextWindow: 2_500,
    maxTokens: 128,
  };

  const result = await runBook({
    ...fixture.options,
    model,
    tokenEstimator,
    maxWindows: 1,
    maxRequestTokens: 5_000,
    maxInFlightTokens: 2_500,
    windowOptions: {
      maxBlocks: 4,
      targetSourceTokens: 5_000,
      maxSourceTokens: 5_000,
    },
  } as never);

  assert.equal(result.status.totalWindows, 1);
  assert.equal(result.status.completedWindows, 1);
  assert.equal(fixture.faux.state.callCount, 2);
  assert.deepEqual(observedBlockGroups.map((blocks) => blocks.length), [1, 2]);
  assert.equal(new Set(observedRequestIds).size, 2);
  const database = new DatabaseSync(fixture.options.storePath);
  try {
    const events = (database.prepare(`
      SELECT kind, COUNT(*) AS count FROM events
      WHERE run_id='run-lossless' AND kind IN ('window_claimed', 'window_staged', 'window_promoted')
      GROUP BY kind
    `).all() as Array<{ kind: string; count: number }>).map((row) => ({ ...row }));
    assert.deepEqual(events, [
      { kind: "window_claimed", count: 1 },
      { kind: "window_promoted", count: 1 },
      { kind: "window_staged", count: 1 },
    ]);
  } finally {
    database.close();
  }
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const state = store.auditState("run-lossless");
    const expected = state.memberships.map((membership) => membership.blockId);
    assert.deepEqual(observedBlockGroups.flat(), expected);
    assert.deepEqual(state.translations.map((translation) => translation.blockId), expected);
  } finally {
    store.close();
  }
});

test("runtime context overflow splits a physical batch before escalating its thinking", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const primary = fauxProvider();
  const escalation = fauxProvider();
  const observedBlockGroups: string[][] = [];
  const observedRequestIds: string[] = [];
  primary.setResponses([
    (context: Context) => {
      const prompt = userText(context);
      observedRequestIds.push(/PHYSICAL REQUEST ([^\n]+)/u.exec(prompt)?.[1] ?? "");
      observedBlockGroups.push(promptBatchWindows(context).flatMap((window) =>
        window.blocks.map((block) => block.blockId)));
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "input exceeds the context window",
      });
    },
    (context: Context) => {
      const prompt = userText(context);
      observedRequestIds.push(/PHYSICAL REQUEST ([^\n]+)/u.exec(prompt)?.[1] ?? "");
      observedBlockGroups.push(promptBatchWindows(context).flatMap((window) =>
        window.blocks.map((block) => block.blockId)));
      return losslessBatchResponse(context);
    },
    (context: Context) => {
      const prompt = userText(context);
      observedRequestIds.push(/PHYSICAL REQUEST ([^\n]+)/u.exec(prompt)?.[1] ?? "");
      observedBlockGroups.push(promptBatchWindows(context).flatMap((window) =>
        window.blocks.map((block) => block.blockId)));
      return losslessBatchResponse(context);
    },
  ]);
  const primaryModel = primary.getModel();
  const primaryStream = primary.provider.streamSimple.bind(primary.provider);

  const result = await runBook({
    ...fixture.options,
    model: primaryModel,
    streamFn: primaryStream,
    maxAttempts: 1,
    runtimeSet: {
      mode: "fast",
      primary: {
        model: primaryModel,
        streamFn: primaryStream,
        effort: "off",
        thinkingLevel: "off",
      },
      escalation: {
        model: escalation.getModel(),
        streamFn: escalation.provider.streamSimple.bind(escalation.provider),
        effort: "high",
        thinkingLevel: "high",
      },
    },
  } as never);

  assert.equal(result.status.completedWindows, 2);
  assert.equal(primary.state.callCount, 3);
  assert.equal(escalation.state.callCount, 0);
  assert.deepEqual(observedBlockGroups.map((blocks) => blocks.length), [2, 1, 1]);
  assert.equal(new Set(observedRequestIds).size, 3);
  const database = new DatabaseSync(fixture.options.storePath);
  try {
    const events = (database.prepare(`
      SELECT kind, COUNT(*) AS count FROM events
      WHERE run_id='run-lossless' AND kind IN ('window_claimed', 'window_staged', 'window_promoted')
      GROUP BY kind
    `).all() as Array<{ kind: string; count: number }>).map((row) => ({ ...row }));
    assert.deepEqual(events, [
      { kind: "window_claimed", count: 2 },
      { kind: "window_promoted", count: 2 },
      { kind: "window_staged", count: 2 },
    ]);
  } finally {
    database.close();
  }
});

test("a runtime context overflow for one indivisible block has a capacity error", async () => {
  const fixture = losslessFixture("the only quiet line.");
  fixture.faux.setResponses([fauxAssistantMessage([], {
    stopReason: "error",
    errorMessage: "input exceeds the context window",
  })]);

  await assert.rejects(
    runBook(fixture.options as never),
    (error: unknown) => error instanceof BookRequestCapacityError,
  );
  assert.equal(fixture.faux.state.callCount, 1);
});

test("lossless book aborts before selecting a new wave and reaches no provider call", async () => {
  const fixture = losslessFixture("The bell rings above the empty court.");
  const controller = new AbortController();
  controller.abort(new Error("test requested abort"));

  await assert.rejects(
    runBook({ ...fixture.options, signal: controller.signal } as never),
    /test requested abort/i,
  );
  assert.equal(fixture.faux.state.callCount, 0);
});

test("lossless book forwards cancellation into its active Pi request and commits no translation", async () => {
  const fixture = losslessFixture("The bell rings above the empty court.");
  const controller = new AbortController();
  let release!: () => void;
  const releaseProvider = new Promise<void>((resolveProvider) => { release = resolveProvider; });
  let entered!: () => void;
  const enteredProvider = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  let providerSignal: AbortSignal | undefined;
  fixture.faux.setResponses([async (context, options) => {
    providerSignal = options?.signal;
    entered();
    await releaseProvider;
    return losslessBatchResponse(context);
  }]);

  const running = runBook({ ...fixture.options, signal: controller.signal } as never);
  await enteredProvider;
  controller.abort(new Error("midflight abort"));
  assert.equal(providerSignal?.aborted, true);
  release();

  await assert.rejects(running, /midflight abort/i);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const status = store.statusSummary("run-lossless");
    assert.equal(status.completedWindows, 0);
    assert.equal(status.runningWindows, 1);
    assert.deepEqual(store.auditState("run-lossless").translations, []);
  } finally {
    store.close();
  }
});

test("lossless book forwards cancellation into its lexical-anchor Pi request", async () => {
  const fixture = losslessFixture("Loukianos, whom they called Lucian the Scoffer, laughed.");
  const controller = new AbortController();
  let release!: () => void;
  const releaseProvider = new Promise<void>((resolveProvider) => { release = resolveProvider; });
  let entered!: () => void;
  const enteredProvider = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  let providerSignal: AbortSignal | undefined;
  fixture.faux.setResponses([async (context, options) => {
    providerSignal = options?.signal;
    entered();
    await releaseProvider;
    return lexicalAnchorResponse(context, {
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget: "卢基阿诺斯",
      evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
    });
  }]);

  const running = runBook({ ...fixture.options, signal: controller.signal } as never);
  await enteredProvider;
  controller.abort(new Error("anchor abort"));
  assert.equal(providerSignal?.aborted, true);
  release();

  await assert.rejects(running, /anchor abort/i);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    assert.equal(store.statusSummary("run-lossless").pendingWindows, 1);
    assert.deepEqual(store.auditState("run-lossless").translations, []);
  } finally {
    store.close();
  }
});

test("lossless runner injects only glossary terms relevant to each physical request", async () => {
  const fixture = losslessFixture("BOOK ONE\n\nTyphon spoke.\n\nCHAPTER ONE\n\nSeverian listened.");
  const glossaryPath = join(dirname(fixture.canonicalPath), "glossary.json");
  writeFileSync(glossaryPath, JSON.stringify({
    Typhon: "提丰",
    Severian: "塞万里安",
  }), "utf8");
  const context = BookContext.openLossless({ manifestPath: fixture.options.manifestPath });
  const glossary = loadGlossary({
    glossaryPath,
    blocks: context.losslessBlocks,
    profile: context.languageProfile,
  });
  context.close();
  const prompts: string[] = [];
  fixture.faux.setResponses([
    (request) => {
      prompts.push(userText(request));
      return losslessBatchResponse(request);
    },
    (request) => {
      prompts.push(userText(request));
      return losslessBatchResponse(request);
    },
  ]);

  const result = await runBook({
    ...fixture.options,
    glossary,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 1,
  } as never);

  assert.equal(result.status.completedWindows, 2, JSON.stringify({
    status: result.status,
    windows: result.windows.map((window) => ({
      id: window.windowId,
      status: window.status,
    })),
    promptCount: prompts.length,
  }));
  assert.match(prompts[0] ?? "", /"sourceForm":"Typhon"/u);
  assert.doesNotMatch(prompts[0] ?? "", /"sourceForm":"Severian"/u);
  assert.match(prompts[1] ?? "", /"sourceForm":"Severian"/u);
  assert.doesNotMatch(prompts[1] ?? "", /"sourceForm":"Typhon"/u);
});

test("one malformed typed window preserves its valid sibling while framed fallback repairs only the failure", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const malformed = structuredClone(fixture.submission);
  malformed.windows[1]!.translations[0]!.text = "";
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      malformed,
    ), { stopReason: "toolUse" }),
    losslessBatchResponse,
  ]);

  const result = await runBook({ ...fixture.options, maxAttempts: 1 } as never);

  assert.equal(fixture.faux.state.callCount, 2);
  assert.equal(result.status.completedWindows, 2);
  assert.equal(result.status.humanRequiredWindows, 0);
  assert.deepEqual(result.windows.map((window) => window.status), [
    "completed",
    "completed",
  ]);
  const store = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(store.styleObservations("run-lossless").map((item) => item.ordinal), [0, 1]);
  store.close();
});

test("lossless provider errors stay retryable and never become human incidents", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage([], {
    stopReason: "error",
    errorMessage: "503: fixture provider unavailable",
  })]);

  await assert.rejects(runBook(fixture.options as never), /provider unavailable/i);
  assert.equal(fixture.faux.state.callCount, 1);
  const store = new LosslessBookStore(fixture.options.storePath);
  const status = store.statusSummary("run-lossless");
  store.close();
  assert.equal(status.humanRequiredWindows, 0);
  assert.equal(status.pendingWindows, 2);
});

test("fast mode retries an invalid physical request with only the escalation runtime", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const primary = fauxProvider();
  const escalation = fauxProvider();
  primary.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [] },
  ), { stopReason: "toolUse" })]);
  escalation.setResponses([losslessBatchResponse]);
  const primaryModel = primary.getModel();
  const primaryStream = primary.provider.streamSimple.bind(primary.provider);

  const result = await runBook({
    ...fixture.options,
    model: primaryModel,
    streamFn: primaryStream,
    runtimeSet: {
      mode: "fast",
      primary: {
        model: primaryModel,
        streamFn: primaryStream,
        effort: "off",
        thinkingLevel: "off",
      },
      escalation: {
        model: escalation.getModel(),
        streamFn: escalation.provider.streamSimple.bind(escalation.provider),
        effort: "high",
        thinkingLevel: "high",
      },
    },
  } as never);

  assert.equal(primary.state.callCount, 1);
  assert.equal(escalation.state.callCount, 1);
  assert.equal(result.status.completedWindows, 2);
});

test("fast mode rejects a lower-effort escalation runtime", async () => {
  const fixture = losslessFixture("the quiet room remained empty.");
  fixture.faux.setResponses([losslessBatchResponse]);
  const model = fixture.faux.getModel();
  const streamFn = fixture.faux.provider.streamSimple.bind(
    fixture.faux.provider,
  );

  await assert.rejects(
    runBook({
      ...fixture.options,
      model,
      streamFn,
      runtimeSet: {
        mode: "fast",
        primary: {
          model,
          streamFn,
          effort: "high",
          thinkingLevel: "high",
        },
        escalation: {
          model,
          streamFn,
          effort: "low",
          thinkingLevel: "low",
        },
      },
    }),
    /escalation runtime cannot use lower effort/u,
  );
  assert.equal(fixture.faux.state.callCount, 0);
});

test("failed low effort retries only its task with a token-legal escalation runtime", async () => {
  const fixture = losslessFixture("the quiet room remained empty.");
  const low = fauxProvider({
    models: [{ id: "faux-1", contextWindow: 1_000_000 }],
  });
  const high = fauxProvider({
    models: [{ id: "faux-1", contextWindow: 1_000_000 }],
  });
  const runtimeProfiles = new RuntimeProfileStore(join(
    dirname(fixture.options.storePath),
    "runtime-profiles.db",
  ));
  low.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [] },
  ), { stopReason: "toolUse" })]);
  high.setResponses([losslessBatchResponse]);
  const model = low.getModel();

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn: low.provider.streamSimple.bind(low.provider),
    schedulerMode: "active",
    optimizationProfile: "speed",
    runtimeProfileStore: runtimeProfiles,
    runtimeSet: {
      mode: "fast",
      primary: {
        model,
        streamFn: low.provider.streamSimple.bind(low.provider),
        effort: "low",
        thinkingLevel: "low",
      },
      escalation: {
        model: high.getModel(),
        streamFn: high.provider.streamSimple.bind(high.provider),
        effort: "high",
        thinkingLevel: "high",
      },
    },
  });

  assert.equal(low.state.callCount, 1);
  assert.equal(high.state.callCount, 1);
  assert.equal(result.status.completedWindows, 1);
  assert.deepEqual(Object.values(result.scheduler.contextProfiles), ["rich"]);
  assert.equal(result.scheduler.recoveries, 1);
  assert.deepEqual(
    runtimeProfiles.observationsForProfile("faux-1:en")
      .map((observation) => observation.status),
    ["failed", "success"],
  );
  runtimeProfiles.close();
});

test("retry rounds remain bounded without manufacturing a larger cumulative token envelope", async () => {
  const fixture = losslessFixture("the quiet room remained empty.");
  const low = fauxProvider();
  const high = fauxProvider();
  const invalid = fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [] },
  ), { stopReason: "toolUse" });
  low.setResponses([invalid]);
  high.setResponses(Array.from({ length: 8 }, () => invalid));
  const model = low.getModel();

  const result = await runBook({
    ...fixture.options,
    model,
    streamFn: low.provider.streamSimple.bind(low.provider),
    schedulerMode: "active",
    optimizationProfile: "balanced",
    maxAttempts: 8,
    runtimeSet: {
      mode: "fast",
      primary: {
        model,
        streamFn: low.provider.streamSimple.bind(low.provider),
        effort: "low",
        thinkingLevel: "low",
      },
      escalation: {
        model: high.getModel(),
        streamFn: high.provider.streamSimple.bind(high.provider),
        effort: "high",
        thinkingLevel: "high",
      },
    },
  });

  assert.equal(low.state.callCount, 1);
  assert.equal(high.state.callCount, 7);
  assert.equal(result.status.humanRequiredWindows, 1);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const events = store.loadTokenLedgerEvents("run-lossless");
    assert.equal(events.filter((event) =>
      event.type === "baseline_added"
      && event.source === "translate_horizon").length, 1);
    const status = store.statusSummary("run-lossless");
    assert.equal(status.pendingWindows, 0);
    assert.equal(status.runningWindows, 0);
    assert.equal(status.humanRequiredWindows, 1);
  } finally {
    store.close();
  }
});

test("quality mode falls back from a malformed typed payload to framed text before human review", async () => {
  const fixture = losslessFixture("One complete source paragraph without named entities.");
  const primary = fauxProvider();
  primary.setResponses([
    fauxAssistantMessage("I failed to call the finalizer."),
    losslessBatchResponse,
  ]);
  const primaryModel = primary.getModel();
  const primaryStream = primary.provider.streamSimple.bind(primary.provider);
  const runtime = {
    model: primaryModel,
    streamFn: primaryStream,
    effort: "high" as const,
    thinkingLevel: "high" as const,
  };

  const result = await runBook({
    ...fixture.options,
    model: primaryModel,
    streamFn: primaryStream,
    maxAttempts: 1,
    runtimeSet: {
      mode: "quality",
      primary: runtime,
      escalation: runtime,
    },
  } as never);

  assert.equal(primary.state.callCount, 2);
  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows, result.status.totalWindows);
});

test("provider protocol errors switch only the failed request to framed text", async () => {
  const fixture = losslessFixture("one quiet source paragraph.");
  const runtimeProfiles = new RuntimeProfileStore(join(
    dirname(fixture.options.storePath),
    "runtime-profiles.db",
  ));
  fixture.faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "malformed tool-call stream",
    }),
    losslessBatchResponse,
  ]);

  const result = await runBook({
    ...fixture.options,
    maxAttempts: 1,
    runtimeProfileStore: runtimeProfiles,
  });

  assert.equal(fixture.faux.state.callCount, 2);
  assert.equal(result.status.completedWindows, 1);
  assert.equal(result.status.humanRequiredWindows, 0);
  assert.deepEqual(
    runtimeProfiles.observationsForProfile("faux-1:en")
      .map((observation) => observation.status),
    ["protocol", "success"],
  );
  assert.equal(result.scheduler.tokenUsageComplete, true);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const events = store.loadTokenLedgerEvents("run-lossless");
    const recoverySettlement = events.find((event) =>
      event.type === "settled"
      && event.requestId.includes(":protocol_switch:"));
    assert.equal(recoverySettlement?.type, "settled");
    assert.equal(events.some((event) =>
      event.type === "released"
      && event.requestId.includes(":protocol_switch:")), false);
    assert.equal(
      events
        .filter((event) => event.type === "settled")
        .reduce((total, event) =>
          total + (event.type === "settled" ? event.actualTokens : 0), 0),
      result.scheduler.actualTokens,
    );
  } finally {
    store.close();
  }
  runtimeProfiles.close();
});

test("recovered request observations partition failure and success token usage", async () => {
  const fixture = losslessFixture("one quiet source paragraph.");
  const runtimeProfiles = new RuntimeProfileStore(join(
    dirname(fixture.options.storePath),
    "runtime-profiles.db",
  ));
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      { windows: [] },
    ), { stopReason: "toolUse" }),
    losslessBatchResponse,
  ]);

  const result = await runBook({
    ...fixture.options,
    maxAttempts: 1,
    runtimeProfileStore: runtimeProfiles,
  });
  const observations = runtimeProfiles.observationsForProfile("faux-1:en");

  assert.deepEqual(
    observations.map((observation) => observation.status),
    ["protocol", "success"],
  );
  assert.ok(observations.every((observation) => observation.usage.complete));
  assert.equal(
    observations.reduce(
      (total, observation) => total + observation.usage.totalTokens,
      0,
    ),
    result.scheduler.actualTokens,
  );
  runtimeProfiles.close();
});

test("fast mode resolves lexical anchors with one framed primary call and leaves high effort for escalation", async () => {
  const fixture = losslessFixture(
    "Loukianos, whom they called Lucian the Scoffer, laughed.\n\nBOOK ONE",
  );
  const primary = fauxProvider();
  const escalation = fauxProvider();
  primary.setResponses([
    (context) => lexicalPreferredFallbackResponse(context, {
      Loukianos: "卢基阿诺斯",
      Lucian: "卢基安",
    }),
    losslessBatchResponse,
    losslessBatchResponse,
  ]);
  const primaryModel = primary.getModel();
  const primaryStream = primary.provider.streamSimple.bind(primary.provider);

  const result = await runBook({
    ...fixture.options,
    model: primaryModel,
    streamFn: primaryStream,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    runtimeSet: {
      mode: "fast",
      primary: {
        model: primaryModel,
        streamFn: primaryStream,
        effort: "off",
        thinkingLevel: "off",
      },
      escalation: {
        model: escalation.getModel(),
        streamFn: escalation.provider.streamSimple.bind(escalation.provider),
        effort: "high",
        thinkingLevel: "high",
      },
    },
  } as never);

  assert.equal(primary.state.callCount, 3);
  assert.equal(escalation.state.callCount, 0);
  assert.equal(result.status.completedWindows, 2);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const anchorSettlement = store.loadTokenLedgerEvents("run-lossless")
      .find((event) =>
        event.type === "settled"
        && event.requestId.startsWith("anchor:"));
    assert.equal(anchorSettlement?.type, "settled");
    if (anchorSettlement?.type === "settled") {
      assert.equal(anchorSettlement.usageComplete, true);
      assert.ok(anchorSettlement.actualTokens > 0);
    }
  } finally {
    store.close();
  }
});

test("fast mode escalates only a failed framed lexical call and resumes translation on the primary runtime", async () => {
  const fixture = losslessFixture(
    "Loukianos, whom they called Lucian the Scoffer, laughed.\n\nBOOK ONE",
  );
  const primary = fauxProvider();
  const escalation = fauxProvider();
  primary.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "503: primary anchor unavailable",
    }),
    losslessBatchResponse,
    losslessBatchResponse,
  ]);
  escalation.setResponses([(context) => lexicalAnchorResponse(context, {
    sourceForms: ["Loukianos", "Lucian"],
    proposedTarget: "卢基阿诺斯",
    evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
  })]);
  const primaryModel = primary.getModel();
  const primaryStream = primary.provider.streamSimple.bind(primary.provider);

  const result = await runBook({
    ...fixture.options,
    model: primaryModel,
    streamFn: primaryStream,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    runtimeSet: {
      mode: "fast",
      primary: {
        model: primaryModel,
        streamFn: primaryStream,
        effort: "off",
        thinkingLevel: "off",
      },
      escalation: {
        model: escalation.getModel(),
        streamFn: escalation.provider.streamSimple.bind(escalation.provider),
        effort: "high",
        thinkingLevel: "high",
      },
    },
  } as never);

  assert.equal(primary.state.callCount, 3);
  assert.equal(escalation.state.callCount, 1);
  assert.equal(result.status.completedWindows, 2);
});

test("a framed preferred fallback preserves Korean names when structured anchor calls fail", async () => {
  const fixture = losslessFixture(
    "용천익 당주가 묵향을 만났다. 용천익은 묵향에게 다시 말했다.",
    "ko",
  );
  fixture.faux.setResponses([
    fauxAssistantMessage("The required structured tool call is unavailable."),
    (context) => lexicalPreferredFallbackResponse(context, {
      용천익: "龙天翼",
      묵향: "墨香",
    }),
    (context) => {
      const prompt = userText(context);
      const match = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(prompt);
      assert.ok(match?.[1]);
      const terms = JSON.parse(match[1]) as Array<{
        sourceForm: string;
        target: string;
        policy: string;
        locked: boolean;
      }>;
      assert.deepEqual(
        terms.filter((term) => term.sourceForm === "용천익" || term.sourceForm === "묵향")
          .map((term) => [term.sourceForm, term.target, term.policy, term.locked])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        [
          ["묵향", "墨香", "preferred", false],
          ["용천익", "龙天翼", "preferred", false],
        ],
      );
      return losslessBatchResponse(context);
    },
  ]);

  const result = await runBook(fixture.options as never);

  assert.equal(fixture.faux.state.callCount, 3);
  assert.equal(result.status.humanRequiredWindows, 0);
  assert.equal(result.status.completedWindows, result.status.totalWindows);
  assert.equal(
    (result as unknown as LosslessBookRunResult).scheduler.tokenUsageComplete,
    true,
  );
});

test("lossless runner resumes the same isolated run after increasing concurrency", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [fixture.submission.windows[0]] },
  ), { stopReason: "toolUse" })]);
  const first = await runBook({
    ...fixture.options,
    maxWindows: 1,
    maxConcurrency: 1,
  } as never);
  assert.equal(first.status.completedWindows, 1);
  assert.equal(first.status.pendingWindows, 1);

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [fixture.submission.windows[1]] },
  ), { stopReason: "toolUse" })]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);
  assert.equal(resumedProvider.state.callCount, 1);
  assert.equal(resumed.processedWindows, 1);
  assert.equal(resumed.status.completedWindows, 2);
  assert.deepEqual(resumed.windows.map((window) => window.status), ["completed", "completed"]);
});

test("lossless resume synchronizes newer book knowledge before the next wave", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE\n\nArchon returned.");
  fixture.faux.setResponses([losslessBatchResponse]);
  await runBook({ ...fixture.options, maxWindows: 1 } as never);

  const editor = new LosslessBookStore(fixture.options.storePath);
  try {
    const sourceVersion = editor.listTranslationRuns()
      .find((run) => run.runId === "run-lossless")!.sourceVersion;
    const editorRunId = "run-catalog-editor";
    const initialSnapshot = createKnowledgeSnapshot(editorRunId, []);
    editor.createTranslationRun({
      runId: editorRunId,
      sourceVersion,
      protocolVersion: "lossless-v5-1",
      modelId: "catalog-editor",
      initialSnapshotId: initialSnapshot.id,
      initialSnapshot,
    });
    const state = editor.knowledgeState(editorRunId);
    editor.commitKnowledgeCommands({
      requestId: "catalog-editor-archon",
      runId: editorRunId,
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
          target: "阁下",
          locked: true,
          policy: "locked",
        },
        ownedFields: ["/target", "/locked", "/policy"],
        scope: "book",
        evidence: [],
        origin: "manual",
      }],
    });
  } finally {
    editor.close();
  }

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([losslessBatchResponse]);
  await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);

  const reopened = new LosslessBookStore(fixture.options.storePath);
  try {
    const archon = reopened.latestKnowledgeSnapshot("run-lossless").revisions
      .find((revision) => revision.normalizedSubject === "archon");
    assert.equal((archon?.payload as { target?: string })?.target, "阁下");
    assert.equal(
      reopened.knowledgeState("run-lossless").appliedBookGeneration,
      1,
    );
  } finally {
    reopened.close();
  }
});

test("long multi-paragraph revalidation descends through the shared paragraph recovery topology", async () => {
  const longParagraphs = Array.from(
    { length: 5 },
    (_, index) => Array.from(
      { length: 8 },
      () =>
        `Prokurist beobachtete gregor im zimmer und bewahrte jedes wichtige detail des vorgangs ${index + 1}.`,
    ).join(" "),
  );
  const fixture = losslessFixture([
    longParagraphs.join("\n\n"),
    "ordinary tail marker preserves the final independent block.",
  ].join("[[]]"), "de");
  const glossaryPath = join(dirname(fixture.canonicalPath), "glossary.json");
  writeFileSync(glossaryPath, JSON.stringify({
    schema: "folioloom-glossary-1",
    terms: [{
      source: "Prokurist",
      target: "代理人",
      policy: "locked",
    }],
  }), "utf8");
  const fixtureContext = BookContext.openLossless({
    manifestPath: fixture.options.manifestPath,
  });
  const glossary = loadGlossary({
    glossaryPath,
    blocks: fixtureContext.losslessBlocks,
    profile: fixtureContext.languageProfile,
  });
  fixtureContext.close();
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "代理人",
    mode: "stable",
    semanticClass: "role",
    confidence: 0.99,
  });
  const conceptGlossary = {
    ...glossary,
    stableTerms: glossary.stableTerms.map((term) => ({
      ...term,
      conceptId: concept.conceptId,
      target: concept.canonicalTarget,
      locked: concept.policy === "locked",
      policy: concept.policy,
      semanticClass: concept.semanticClass,
      allowedTargets: concept.allowedRealizations,
      revisionId: concept.revisionId,
      renderFingerprint: concept.renderFingerprint,
    })),
  };
  fixture.faux.setResponses([losslessBatchResponse]);
  const first = await runBook({
    ...fixture.options,
    glossary: conceptGlossary,
    maxWindows: 1,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: {
        model: fixture.options.model,
        streamFn: fixture.options.streamFn,
        effort: "high",
        thinkingLevel: "high",
      },
      escalation: {
        model: fixture.options.model,
        streamFn: fixture.options.streamFn,
        effort: "high",
        thinkingLevel: "high",
      },
    },
  } as never);
  assert.equal(first.status.completedWindows, 1);

  const prepared = new LosslessBookStore(fixture.options.storePath);
  try {
    prepared.upsertLexicalConcepts(
      "run-lossless",
      [concept],
    );
    const database = new DatabaseSync(fixture.options.storePath);
    try {
      database.prepare(`
        DELETE FROM translation_concept_bindings
        WHERE translation_id IN (
          SELECT translation_id FROM translations
          WHERE run_id='run-lossless' AND active=1
        )
      `).run();
    } finally {
      database.close();
    }
    const coverage = prepared.ensureConceptCoverageRevalidationTasks(
      "run-lossless",
      prepared.latestKnowledgeSnapshot("run-lossless").id,
    );
    assert.ok(
      prepared.revalidationTasks("run-lossless").length > 0,
      `missing binding must schedule revalidation: ${JSON.stringify(coverage)}`,
    );
  } finally {
    prepared.close();
  }

  const promptTermUsages = (prompt: string, blockId: string) => {
    const match = /TERM OCCURRENCES\n\n(\[[^\n]*\])/u.exec(prompt);
    const occurrences = JSON.parse(match?.[1] ?? "[]") as Array<{
      occurrenceId: string;
      blockId: string;
      conceptId: string;
      sourceForm: string;
      sourceStart: number;
      sourceEnd: number;
      canonicalTarget: string;
    }>;
    return occurrences
      .filter((occurrence) => occurrence.blockId === blockId)
      .map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
        blockId: occurrence.blockId,
        conceptId: occurrence.conceptId,
        sourceForm: occurrence.sourceForm,
        sourceStart: occurrence.sourceStart,
        sourceEnd: occurrence.sourceEnd,
        discourseRole: "narrative",
        targetSurface: occurrence.canonicalTarget,
      }));
  };
  const resumedPrompts: string[] = [];
  const collapsedOrRecovered = (context: Context) => {
    const prompt = userText(context);
    resumedPrompts.push(prompt);
    if (prompt.includes("ordinary tail marker")) {
      return losslessBatchResponse(context);
    }
    const fragmentMatch =
      /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(prompt);
    if (fragmentMatch?.[1] !== undefined) {
      const windows = JSON.parse(fragmentMatch[1]) as Array<{
        windowId: string;
        blocks: Array<{
          blockId: string;
          paragraphs: Array<{ sourceText: string }>;
        }>;
      }>;
      const window = windows[0]!;
      const block = window.blocks[0]!;
      const termUsages = promptTermUsages(prompt, block.blockId);
      const requiredTargets = [...new Set(termUsages.map((usage) =>
        usage.targetSurface))].join("、");
      const translatedParagraphs = block.paragraphs.map(
        (paragraph, index) => ({
          text: `${requiredTargets}完成第 ${index + 1} 段译文，${"保留全部动作因果与叙述细节".repeat(
            Math.max(1, Math.ceil([...paragraph.sourceText].length / 24)),
          )}。`,
        }),
      );
      if (translatedParagraphs.length === 1) {
        return fauxAssistantMessage(fauxToolCall(
          "finalize_paragraph_fragment",
          { text: translatedParagraphs[0]!.text },
        ), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
        windows: [{
          windowId: window.windowId,
          translations: [{
            blockId: block.blockId,
            paragraphs: translatedParagraphs,
          }],
          termUsages,
        }],
      }), { stopReason: "toolUse" });
    }
    const windows = promptBatchWindows(context);
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((window) => {
        const termUsages = window.blocks.flatMap((block) =>
          promptTermUsages(prompt, block.blockId));
        return {
          windowId: window.windowId,
          translations: window.blocks.map((block) => ({
            blockId: block.blockId,
            text: `${
              [...new Set(termUsages.map((usage) => usage.targetSurface))]
                .join("、")
            }过短。`,
          })),
          termUsages,
          notes: [],
        };
      }),
    }), { stopReason: "toolUse" });
  };
  const resumedProvider = fauxProvider();
  resumedProvider.setResponses(
    Array.from({ length: 12 }, () => collapsedOrRecovered),
  );
  const model = resumedProvider.getModel();
  const streamFn = resumedProvider.provider.streamSimple.bind(
    resumedProvider.provider,
  );
  const resumed = await runBook({
    ...fixture.options,
    glossary: conceptGlossary,
    model,
    streamFn,
    maxAttempts: 2,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    maxRequestTokens: 4_000,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 4_000 },
    runtimeSet: {
      mode: "quality",
      primary: { model, streamFn, effort: "high", thinkingLevel: "high" },
      escalation: { model, streamFn, effort: "high", thinkingLevel: "high" },
    },
  } as never);

  assert.equal(resumed.status.humanRequiredWindows, 0);
  assert.equal(resumed.status.completedWindows, 2);
  assert.match(
    resumedPrompts[0] ?? "",
    /ordinary tail marker/u,
    "pending translation windows must finish before the final revalidation drain",
  );
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    const tasks = store.revalidationTasks("run-lossless");
    assert.ok(tasks.some((task) =>
      task.status === "resolved_retranslate"
      || task.status === "resolved_repair"), JSON.stringify(tasks));
    assert.ok(tasks.every((task) =>
      task.status !== "completed_with_warning"));
    const ledgerEvents = store.loadTokenLedgerEvents("run-lossless");
    const reservations = ledgerEvents.filter(
      (event): event is Extract<LedgerEvent, { type: "reserved" }> =>
        event.type === "reserved",
    );
    assert.ok(reservations.some((event) =>
      event.purpose === "revalidate"));
    assert.ok(reservations.some((event) =>
      event.purpose === "paragraph_fragment"));
    const revalidationBaseline = ledgerEvents.reduce(
      (total, event) =>
        event.type === "baseline_added" && event.source === "revalidate"
          ? total + event.baselineTokens
          : total,
      0,
    );
    const revalidationGraphReservations = reservations.reduce(
      (total, event) =>
        event.purpose === "revalidate"
        || event.purpose === "paragraph_fragment"
        || event.purpose === "repair"
          ? total + event.predictedTokens
          : total,
      0,
    );
    assert.ok(
      revalidationBaseline >= revalidationGraphReservations,
      `${revalidationBaseline} must cover ${revalidationGraphReservations}`,
    );
  } finally {
    store.close();
  }
});

function commitManualKnowledge(
  storePath: string,
  objectType: "term" | "memory" | "style",
  normalizedSubject: string,
  kind: string,
  fieldPatch: Record<string, string | boolean>,
): void {
  const store = new LosslessBookStore(storePath);
  try {
    const state = store.knowledgeState("run-lossless");
    store.commitKnowledgeCommands({
      requestId: `manual-${objectType}-${normalizedSubject}`,
      runId: "run-lossless",
      expectedGeneration: state.generation,
      expectedSnapshotId: state.snapshotId,
      commands: [{
        type: "upsert",
        objectType,
        normalizedSubject,
        kind,
        expectedRevision: null,
        expectedScopeRevision: null,
        fieldPatch,
        ownedFields: Object.keys(fieldPatch).map((field) => `/${field}`),
        scope: "book",
        evidence: [],
        origin: "manual",
      }],
    });
  } finally {
    store.close();
  }
}

test("lossless resume preserves a manually locked knowledge term in stable terms", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE\n\narchon greeted the steward.");
  fixture.faux.setResponses([losslessBatchResponse]);
  await runBook({ ...fixture.options, maxWindows: 1 } as never);
  commitManualKnowledge(
    fixture.options.storePath,
    "term",
    "archon",
    "lexical_anchor",
    {
      sourceForm: "Archon",
      canonicalSource: "Archon",
      target: "阁下",
      locked: true,
      policy: "locked",
      note: "人物面前的直接呼告",
    },
  );
  commitManualKnowledge(
    fixture.options.storePath,
    "term",
    "steward",
    "lexical_anchor",
    {
      sourceForm: "steward",
      canonicalSource: "steward",
      target: "总管",
      locked: false,
      policy: "preferred",
      note: "叙述中的默认职业称谓",
    },
  );

  const resumedProvider = fauxProvider();
  let resumedPrompt = "";
  resumedProvider.setResponses([(context) => {
    resumedPrompt = userText(context);
    return losslessBatchResponse(context);
  }]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);

  assert.equal(resumed.status.completedWindows, resumed.status.totalWindows);
  const termMatch = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(resumedPrompt);
  assert.ok(termMatch?.[1]);
  const terms = JSON.parse(termMatch[1]) as Array<{
    conceptId: string;
    lexemeId: string;
    sourceForm: string;
    canonicalSource: string;
    target: string;
    policy?: string;
    locked: boolean;
    note?: string;
    origin?: string;
  }>;
  const term = terms.find((candidate) => candidate.sourceForm === "Archon");
  assert.ok(term);
  assert.equal(term.conceptId, "user-archon");
  assert.match(term.lexemeId, /^user-/u);
  assert.equal(term.canonicalSource, "Archon");
  assert.equal(term.target, "阁下");
  assert.equal(term.locked, true);
  assert.equal(term.policy, "locked");
  assert.equal(term.note, "人物面前的直接呼告");
  assert.equal(term.origin, "knowledge");
  const preferred = terms.find((candidate) => candidate.sourceForm === "steward");
  assert.ok(preferred);
  assert.equal(preferred.target, "总管");
  assert.equal(preferred.locked, false);
  assert.equal(preferred.policy, "preferred");
  assert.equal(preferred.note, "叙述中的默认职业称谓");
});

test("lossless resume merges persisted style over caller style for the next wave", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE\n\nthe orbit was narrow.");
  fixture.faux.setResponses([losslessBatchResponse]);
  await runBook({
    ...fixture.options,
    maxWindows: 1,
    styleState: { technicalProse: "调用方原始要求" },
  } as never);
  commitManualKnowledge(
    fixture.options.storePath,
    "style",
    "book-style",
    "style_directive",
    {
      technicalProse: "先交代概念关系，再保持术语精确",
      dialogue: "对白".repeat(90),
      narrativeDistance: "保持疏离的回忆距离",
      dialogueRegister: "正式场合克制，私下自然",
    },
  );

  const resumedProvider = fauxProvider();
  let resumedPrompt = "";
  resumedProvider.setResponses([(context) => {
    resumedPrompt = userText(context);
    return losslessBatchResponse(context);
  }]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
    styleState: { technicalProse: "调用方原始要求" },
  } as never);

  assert.equal(resumed.status.completedWindows, resumed.status.totalWindows);
  assert.match(resumedPrompt, /先交代概念关系，再保持术语精确/u);
  assert.match(resumedPrompt, /保持疏离的回忆距离/u);
  assert.match(resumedPrompt, /正式场合克制，私下自然/u);
  assert.doesNotMatch(resumedPrompt, /调用方原始要求/u);
});

test("lossless resume uses bounded structured style evidence instead of a raw prior tail", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const longTranslation = "克制样例。";
  const firstWindow = structuredClone(fixture.submission.windows[0]!);
  firstWindow.translations[0]!.text = longTranslation;
  (firstWindow as typeof firstWindow & { styleObservation: unknown }).styleObservation = {
    voiceId: "narrator",
    activeRegister: "冷静克制",
    rhythm: "长句舒展，短句收束",
    continuityNotes: ["不要解释叙述者的保留"],
  };
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [firstWindow] },
  ), { stopReason: "toolUse" })]);
  const first = await runBook({ ...fixture.options, maxWindows: 1 } as never);
  assert.equal(first.status.completedWindows, 1);

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([(context) => {
    const prompt = userText(context);
    assert.match(prompt, /EFFECTIVE STYLE BY WINDOW/);
    assert.match(prompt, /全书文体宪章/);
    assert.match(prompt, /冷静克制/);
    assert.doesNotMatch(prompt, /PREVIOUS ACTIVE TAIL/);
    return losslessBatchResponse(context);
  }]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);

  assert.equal(resumed.status.completedWindows, 2);
  const store = new LosslessBookStore(fixture.options.storePath);
  const observations = store.styleObservations("run-lossless");
  store.close();
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map((item) => item.ordinal), [0, 1]);
});

test("lossless runner hydrates full knowledge history when resuming from a revision-two projection", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE\n\nCHAPTER ONE");
  assert.equal(fixture.submission.windows.length, 3);
  const responseWithMemory = (target: string) => (context: Context) => {
    const prompt = userText(context);
    const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
    assert.ok(match?.[1]);
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{ blockId: string }>;
    }>;
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          text: `译文-${target}`,
        })),
        notes: [],
        memoryCandidates: [{
          kind: "term_sense",
          subjectForms: ["Alpha"],
          fact: target,
          confidence: 0.9,
        }],
      })),
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses([
    responseWithMemory("甲"),
    responseWithMemory("乙"),
  ]);
  const first = await runBook({
    ...fixture.options,
    maxWindows: 2,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    tinyWindowTokens: 1,
  } as never);
  assert.equal(first.status.completedWindows, 2);
  const afterTwo = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(afterTwo.knowledgeRevisions("run-lossless").map((revision) => revision.revision), [1, 2]);
  assert.equal(afterTwo.latestKnowledgeSnapshot("run-lossless").revisions[0]?.revision, 2);
  afterTwo.close();

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([(context) => {
    const prompt = userText(context);
    const projectionMatch = /KNOWLEDGE SNAPSHOT PROJECTION\n\n(\{[\s\S]*\})\n\nWINDOWS/u.exec(prompt);
    assert.ok(projectionMatch?.[1]);
    const projection = JSON.parse(projectionMatch[1]) as {
      metadata: { total: number; projected: number; omitted: number };
      revisions: Array<{ normalizedSubject: string; revision: number; status: string }>;
    };
    assert.deepEqual(projection.metadata, {
      ...projection.metadata,
      total: 1,
      projected: 1,
      omitted: 0,
    });
    assert.deepEqual(projection.revisions.map((revision) => [
      revision.normalizedSubject,
      revision.revision,
      revision.status,
    ]), [
      ["alpha", 2, "needs_revalidate"],
    ]);
    return responseWithMemory("乙")(context);
  }]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    tinyWindowTokens: 1,
  } as never);
  assert.equal(resumed.status.completedWindows, 3);
  const recovered = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(
    recovered.knowledgeRevisions("run-lossless").map((revision) => revision.revision),
    [1, 2, 3],
  );
  recovered.close();
});

test("reverse physical completion still promotes lossless windows in ordinal order", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const completionOrder: number[] = [];
  fixture.faux.setResponses([
    async (context) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      completionOrder.push(0);
      return losslessBatchResponse(context);
    },
    async (context) => {
      completionOrder.push(1);
      return losslessBatchResponse(context);
    },
  ]);
  const result = await runBook({
    ...fixture.options,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
  } as never);

  assert.deepEqual(completionOrder, [1, 0]);
  assert.equal(result.status.completedWindows, 2);
  const database = new DatabaseSync(fixture.options.storePath);
  const promoted = (database.prepare(`
    SELECT payload_json FROM events WHERE kind='window_promoted' ORDER BY sequence
  `).all() as unknown as Array<{ payload_json: string }>).map((row) =>
    (JSON.parse(row.payload_json) as { windowId: string }).windowId);
  database.close();
  assert.deepEqual(promoted, result.windows.map((window) => window.windowId));
  const styleStore = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(styleStore.styleObservations("run-lossless").map((item) => item.ordinal), [0, 1]);
  styleStore.close();
});

test("dynamic completion order never changes promotion order", async () => {
  const fixture = losslessFixture("a quiet room.[[]]the empty court.");
  const completionOrder: number[] = [];
  fixture.faux.setResponses([
    async (context) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      completionOrder.push(0);
      return losslessBatchResponse(context);
    },
    async (context) => {
      completionOrder.push(1);
      return losslessBatchResponse(context);
    },
  ]);

  const result = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "speed",
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
  });

  assert.deepEqual(completionOrder, [1, 0]);
  const database = new DatabaseSync(fixture.options.storePath);
  const promoted = (database.prepare(`
    SELECT payload_json FROM events WHERE kind='window_promoted' ORDER BY sequence
  `).all() as unknown as Array<{ payload_json: string }>).map((row) =>
    (JSON.parse(row.payload_json) as { windowId: string }).windowId);
  database.close();
  assert.deepEqual(promoted, result.windows.map((window) => window.windowId));
  assert.equal(Object.keys(result.scheduler.contextProfiles).length, 2);
});

test("active scheduling replans after each physical request completes", async () => {
  const fixture = losslessFixture("a quiet room.[[]]the empty court.");
  fixture.faux.setResponses([
    losslessBatchResponse,
    losslessBatchResponse,
  ]);

  const result = await runBook({
    ...fixture.options,
    schedulerMode: "active",
    optimizationProfile: "balanced",
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 1,
  });

  assert.equal(result.status.completedWindows, 2);
  assert.equal(result.scheduler.decisions, 2);
  assert.equal(result.scheduler.fallbacks, 0);
});

test("book runner warms up, runs a parallel wave, and resumes without model calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-runner-"));
  const sourceDb = join(directory, "source.db");
  const storePath = join(directory, "state.db");
  createFixture(sourceDb, 4);
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 4 }, () => dynamicResponse));
  const first = await runBook({
    dbPath: sourceDb,
    storePath,
    outputDir: join(directory, "output"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
    warmupWindows: 2,
    maxConcurrency: 2,
    maxAttempts: 2,
    hardDeadlineMs: 30_000,
  });
  assert.deepEqual(first.waves.map((wave) => wave.concurrency), [1, 1, 2]);
  assert.equal(first.status.completedWindows, 4);
  assert.equal(first.status.modelCalls, 4);

  const noCalls = fauxProvider();
  noCalls.setResponses([]);
  const resumed = await runBook({
    dbPath: sourceDb,
    storePath,
    outputDir: join(directory, "output"),
    model: noCalls.getModel(),
    streamFn: noCalls.provider.streamSimple.bind(noCalls.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
    warmupWindows: 2,
    maxConcurrency: 2,
    maxAttempts: 2,
    hardDeadlineMs: 30_000,
  });
  assert.equal(resumed.processedWindows, 0);
  assert.equal(resumed.status.modelCalls, 4);
});

test("book runner retries a no-submit window with a fresh per-window budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-retry-"));
  const sourceDb = join(directory, "source.db");
  const storePath = join(directory, "state.db");
  createFixture(sourceDb, 1);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("No translation was submitted."),
    dynamicResponse,
  ]);
  const result = await runBook({
    dbPath: sourceDb,
    storePath,
    outputDir: join(directory, "output"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
    warmupWindows: 0,
    maxConcurrency: 1,
    maxAttempts: 2,
    hardDeadlineMs: 30_000,
  });
  const store = new BookStore(storePath);
  const window = store.window(store.pendingWindows()[0]?.windowId ?? "")
    ?? result.windows[0];
  assert.equal(result.status.completedWindows, 1);
  assert.equal(window?.attemptCount, 2);
  assert.equal(result.status.modelCalls, 2);
  store.close();
});

test("book runner aborts external provider failures without creating a human task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-provider-failure-"));
  const sourceDb = join(directory, "source.db");
  const storePath = join(directory, "state.db");
  createFixture(sourceDb, 1);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "401: authentication failed for fixture credential",
    }),
  ]);

  await assert.rejects(
    runBook({
      dbPath: sourceDb,
      storePath,
      outputDir: join(directory, "output"),
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
      maxAttempts: 2,
      hardDeadlineMs: 30_000,
    }),
    /authentication failed/i,
  );
  const store = new BookStore(storePath);
  assert.equal(store.statusSummary().humanRequiredWindows, 0);
  assert.equal(store.statusSummary().pendingWindows, 1);
  store.close();
});
