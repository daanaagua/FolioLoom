import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import { runTranslationBatch } from "../src/agents/translation-batch.js";
import type { PhysicalRequestPlan } from "../src/fullbook/types.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { canonicalJson } from "../src/knowledge/knowledge-store.js";
import type { LosslessBlock } from "../src/source/types.js";
import { createBookStyleConstitution, composeEffectiveStyle } from "../src/style/effective-style.js";
import { projectEffectiveStyle } from "../src/style/style-projection.js";

function block(id: string, index: number, text: string): LosslessBlock {
  return {
    id,
    sourceVersion: "source-v1",
    canonicalStart: index * 10,
    canonicalEnd: index * 10 + text.length,
    sourceText: text,
    sourceHash: createHash("sha256").update(text).digest("hex"),
    globalIndex: index,
    tokenCount: 2,
    structureId: null,
    structureTitle: null,
  };
}

const blocks = [block("block-0", 0, "Alpha."), block("block-1", 1, "Beta.")];
const request: PhysicalRequestPlan = {
  requestId: "request-0",
  sourceTokens: 4,
  windows: blocks.map((item, ordinal) => ({
    windowId: `window-${ordinal}`,
    ordinal,
    chapterId: "chapter-0",
    chapterTitle: null,
    blockIds: [item.id],
    globalIndexes: [ordinal],
    sourceTokens: item.tokenCount,
    sourceChars: item.sourceText.length,
    oversized: false,
  })),
};

function promptText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message?.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
}

test("batch isolates one malformed logical window without discarding its valid sibling", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: "window-0",
      translations: [{ blockId: "block-0", text: "阿尔法。" }],
      notes: [],
    }, {
      windowId: "window-1",
      translations: [{ blockId: "block-1", text: "" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[1]?.status, "failed");
  assert.match(result.windows[1]?.error ?? "", /empty/i);
});

test("batch prompt includes the current knowledge snapshot revisions behind one sentinel", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: request.windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blockIds.map((blockId) => ({ blockId, text: `translated ${blockId}` })),
      notes: [],
    })) },
  ), { stopReason: "toolUse" })]);
  const revisions = [{
    id: "knowledge-revision-1",
    kind: "character",
    normalizedSubject: "alice",
    revision: 1,
    status: "active",
    payload: { canonicalName: "爱丽丝" },
  }];

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  const prompt = (result.run.messages[0] as {
    content?: Array<{ type: string; text?: string }>;
  }).content?.[0]?.text ?? "";
  assert.equal(prompt.match(/KNOWLEDGE SNAPSHOT REVISIONS/g)?.length, 1);
  assert.ok(prompt.includes(canonicalJson(revisions)));
});

test("batch rejects unknown and duplicate outer window identities without erasing a valid window", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: "window-0",
      translations: [{ blockId: "block-0", text: "阿尔法。" }],
      notes: [],
    }, {
      windowId: "window-1",
      translations: [{ blockId: "block-1", text: "贝塔。" }],
      notes: [],
    }, {
      windowId: "window-1",
      translations: [{ blockId: "block-1", text: "重复贝塔。" }],
      notes: [],
    }, {
      windowId: "unknown-window",
      translations: [{ blockId: "block-1", text: "未知。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(result.windows[0]?.status, "completed");
  assert.match(result.windows[1]?.error ?? "", /duplicate windowId/i);
  assert.deepEqual(result.responseErrors, ["unknown windowId: unknown-window"]);
  assert.deepEqual(result.run.toolNames, ["finalize_translation_batch"]);
});

test("batch reports a missing outer window only as that logical window failure", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: "window-0",
      translations: [{ blockId: "block-0", text: "阿尔法。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });
  assert.equal(result.windows[0]?.status, "completed");
  assert.match(result.windows[1]?.error ?? "", /missing window submission/i);
});

test("batch accepts only the first terminating submission in one model session", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall("finalize_translation_batch", { windows: [{
      windowId: "window-0",
      translations: [{ blockId: "block-0", text: "阿尔法。" }],
      notes: [],
    }, {
      windowId: "window-1",
      translations: [{ blockId: "block-1", text: "贝塔。" }],
      notes: [],
    }] }),
    fauxToolCall("finalize_translation_batch", { windows: [] }),
  ], { stopReason: "toolUse" })]);
  const budget = new BudgetLedger();
  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget,
  });
  assert.deepEqual(result.windows.map((window) => window.status), ["completed", "completed"]);
  assert.ok(result.responseErrors.some((error) => /multiple terminating/i.test(error)));
  assert.equal(budget.snapshot().translationToolCalls, 1);
});

test("batch projects bounded structured style and returns the same-call style observation", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: request.windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blockIds.map((blockId) => ({ blockId, text: `译文-${blockId}` })),
      notes: [],
      styleObservation: {
        voiceId: "narrator",
        activeRegister: "冷静克制",
        rhythm: "长短句交替",
        continuityNotes: ["不说明叙述者隐瞒的原因"],
      },
    })) },
  ), { stopReason: "toolUse" })]);
  const constitution = createBookStyleConstitution({ register: "准确、隽永" });
  const projections = Object.fromEntries(request.windows.map((window) => [
    window.windowId,
    projectEffectiveStyle(composeEffectiveStyle({
      constitution,
      voices: [{
        voiceId: "narrator",
        scope: "main_narrator",
        instruction: "克制回顾",
        confidence: 1,
      }],
      observations: [],
      currentOrdinal: window.ordinal,
      sourceText: blocks[window.ordinal]?.sourceText ?? "",
      defaultVoiceId: "narrator",
    })),
  ]));

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    effectiveStyleByWindow: projections,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  const prompt = (result.run.messages[0] as {
    content?: Array<{ type: string; text?: string }>;
  }).content?.[0]?.text ?? "";
  assert.match(prompt, /EFFECTIVE STYLE BY WINDOW/);
  assert.match(prompt, /全书文体宪章/);
  assert.doesNotMatch(prompt, /PREVIOUS ACTIVE TAIL/);
  assert.equal(result.windows[0]?.styleObservation?.activeRegister, "冷静克制");
});

test("batch validation repairs only the invalid block once and preserves its valid sibling", async () => {
  const faux = fauxProvider();
  const repairPrompts: string[] = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: "window-0",
        translations: [{ blockId: "block-0", text: "错误译文。" }],
        notes: [],
      }, {
        windowId: "window-1",
        translations: [{ blockId: "block-1", text: "贝塔。" }],
        notes: [],
      }],
    }), { stopReason: "toolUse" }),
    (context) => {
      repairPrompts.push(promptText(context));
      return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
        translations: [{ blockId: "block-0", text: "阿尔法。" }],
        notes: [],
      }), { stopReason: "toolUse" });
    },
  ]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [{
      conceptId: "alpha",
      lexemeId: "alpha-lexeme",
      sourceForm: "Alpha",
      canonicalSource: "Alpha",
      target: "阿尔法",
      locked: true,
    }],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(result.windows.map((window) => window.status), ["completed", "completed"]);
  assert.equal(result.windows[0]?.translations[0]?.text, "阿尔法。");
  assert.equal(result.windows[1]?.translations[0]?.text, "贝塔。");
  assert.match(repairPrompts[0] ?? "", /stable_term_mismatch/);
  assert.match(repairPrompts[0] ?? "", /block-0/);
  assert.doesNotMatch(repairPrompts[0] ?? "", /\[block-1\]/);
});

test("one invalid repair fails only that logical window and never triggers a second repair", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: "window-0",
        translations: [{ blockId: "block-0", text: "错误译文。" }],
        notes: [],
      }, {
        windowId: "window-1",
        translations: [{ blockId: "block-1", text: "贝塔。" }],
        notes: [],
      }],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: [{ blockId: "block-0", text: "仍然错误。" }],
      notes: [],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [{
      conceptId: "alpha",
      lexemeId: "alpha-lexeme",
      sourceForm: "Alpha",
      canonicalSource: "Alpha",
      target: "阿尔法",
      locked: true,
    }],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.windows[0]?.status, "failed");
  assert.match(result.windows[0]?.error ?? "", /stable_term_mismatch/);
  assert.equal(result.windows[1]?.status, "completed");
});
