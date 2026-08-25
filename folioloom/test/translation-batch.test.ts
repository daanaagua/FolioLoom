import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import {
  runTranslationBatch,
  translationBatchSystemPrompt,
} from "../src/agents/translation-batch.js";
import { prepareTranslationRequest } from "../src/agents/translation-request.js";
import type { PhysicalRequestPlan } from "../src/fullbook/types.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
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

function singleWindowRequest(sourceBlocks: readonly LosslessBlock[]): PhysicalRequestPlan {
  return {
    requestId: "request-canonical-id-fixture",
    sourceTokens: sourceBlocks.reduce((total, item) => total + item.tokenCount, 0),
    windows: [{
      windowId: "window-canonical-id-fixture",
      ordinal: 0,
      chapterId: "chapter-0",
      chapterTitle: null,
      blockIds: sourceBlocks.map((item) => item.id),
      globalIndexes: sourceBlocks.map((item) => item.globalIndex),
      sourceTokens: sourceBlocks.reduce((total, item) => total + item.tokenCount, 0),
      sourceChars: sourceBlocks.reduce((total, item) => total + item.sourceText.length, 0),
      oversized: false,
    }],
  };
}

function promptText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message?.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
}

test("batch protocol states that user style requirements cannot override integrity rules", () => {
  const prompt = translationBatchSystemPrompt(getSourceLanguageProfile("en"));
  assert.match(prompt, /User style requirements may guide Chinese phrasing only/u);
  assert.match(
    prompt,
    /Return exactly one target paragraph for each source paragraph, in the same order/u,
  );
  assert.match(
    prompt,
    /Never move, duplicate, merge, or split content across paragraphs or blocks/u,
  );
  assert.match(
    prompt,
    /must never override source meaning, ambiguity, stable terminology, block boundaries, validation, or the typed-tool protocol/u,
  );
});

test("batch protocol names Korean sources rather than treating them as undetermined", () => {
  const prompt = translationBatchSystemPrompt(getSourceLanguageProfile("ko"));
  assert.match(prompt, /The source language is Korean \(ko\)/u);
  assert.match(prompt, /Simplified Chinese \(zh-Hans\)/u);
  assert.match(prompt, /Use simplified Chinese characters consistently/u);
});

test("batch runtime uses the same prepared prompt as complete-request budgeting", async () => {
  const prepared = prepareTranslationRequest({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
  });
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: request.windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blockIds.map((blockId) => ({ blockId, text: `translated ${blockId}` })),
      notes: [],
    })) },
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
  const prompt = (result.run.messages[0] as {
    content?: Array<{ type: string; text?: string }>;
  }).content?.[0]?.text ?? "";

  assert.equal(prompt, prepared.prompt);
  assert.deepEqual(result.run.toolNames, prepared.tools.map((tool) => tool.name));
});

test("batch canonicalizes unambiguous single-window metadata placed at the tool envelope", async () => {
  const sourceBlocks = [block("block-single-envelope", 0, "Alpha.")];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    {
      windows: [{
        windowId: sourceRequest.windows[0]!.windowId,
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "阿尔法。",
        }],
      }],
      termUsages: [],
      notes: ["metadata was emitted at the envelope"],
      memoryCandidates: [],
      styleObservation: {
        activeRegister: "克制",
      },
    },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-single-envelope", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.windows[0]?.status, "completed_with_warnings");
  assert.deepEqual(result.windows[0]?.termUsages, []);
  assert.deepEqual(result.windows[0]?.notes, ["metadata was emitted at the envelope"]);
  assert.deepEqual(result.windows[0]?.memoryCandidates, []);
  assert.equal(result.windows[0]?.styleObservation?.activeRegister, "克制");
});

test("batch never guesses tool-envelope metadata ownership across logical windows", async () => {
  const validWindows = request.windows.map((window) => ({
    windowId: window.windowId,
    translations: window.blockIds.map((blockId) => ({
      blockId,
      text: window.ordinal === 0 ? "阿尔法。" : "贝塔。",
    })),
  }));
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: validWindows,
      notes: ["ambiguous owner"],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: validWindows.map((window) => ({ ...window, notes: [] })),
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-ambiguous-envelope", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.ok(result.windows.every((window) => window.status === "completed"));
});

test("reserved knowledge kinds in optional memory are corrected before submission", async () => {
  const faux = fauxProvider();
  const validWindows = request.windows.map((window) => ({
    windowId: window.windowId,
    translations: window.blockIds.map((blockId) => ({
      blockId,
      text: window.ordinal === 0 ? "阿尔法。" : "贝塔。",
    })),
    notes: [],
  }));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: validWindows.map((window) => ({
        ...window,
        memoryCandidates: [{
          kind: "lexical_concept",
          subjectForms: ["Sentry Pod"],
          fact: "This is a generic continuity fact, not a lexical concept.",
          confidence: 0.95,
        }],
      })),
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: validWindows,
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.ok(result.windows.every((window) => window.status === "completed"));
  assert.ok(result.windows.every((window) => window.memoryCandidates.length === 0));
});

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

test("batch normalizes every forbidden double-quote glyph before initial validation", async () => {
  const quoteBlocks = [
    block(
      "block-0",
      0,
      "This deliberately long source passage gives the typography regression enough space.",
    ),
    blocks[1]!,
  ];
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: "window-0",
      translations: [{
        blockId: "block-0",
        text: "他说：\"阿尔法\"。‛乙。”‟丙。”〝丁〞„戊。”",
      }],
      notes: [],
    }, {
      windowId: "window-1",
      translations: [{ blockId: "block-1", text: "贝塔。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks: quoteBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[0]?.translations[0]?.text, "他说：“阿尔法”。“乙。”“丙。”“丁”“戊。”");
  assert.equal(/["‛‟〝〞„]/u.test(result.windows[0]?.translations[0]?.text ?? ""), false);
});

test("batch preserves model-produced scene paragraphs without extraction markers", async () => {
  const sourceBlocks = [block(
    "block-0",
    0,
    "A long first scene ends.[[]]A second scene begins.[[]]A third scene begins.",
  )];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: sourceRequest.windows[0]?.windowId,
      translations: [{ blockId: "block-0", text: "前一场景结束。\n\n后一场景开始。\n\n第三场景开始。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(
    result.windows[0]?.translations[0]?.text,
    "前一场景结束。\n\n后一场景开始。\n\n第三场景开始。",
  );
});

test("batch repairs long translated paragraphs duplicated across logical windows", async () => {
  const sourceBlocks = [
    block("block-0", 0, "가나다라마바사".repeat(100)),
    block("block-1", 1, "아자차카타파하".repeat(100)),
  ];
  const sourceRequest: PhysicalRequestPlan = {
    requestId: "request-cross-window-overlap",
    sourceTokens: 4,
    windows: sourceBlocks.map((item, ordinal) => ({
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
  const duplicated = "这是一段被错误复制到相邻逻辑窗口的完整中文内容".repeat(5);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: sourceRequest.windows.map((window, index) => ({
        windowId: window.windowId,
        translations: [{
          blockId: window.blockIds[0],
          text: `${index === 0 ? "甲" : "乙"}`.repeat(400) + `\n\n${duplicated}`,
        }],
        notes: [],
      })),
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: [
        { blockId: "block-0", text: "甲".repeat(500) },
        { blockId: "block-1", text: "乙".repeat(500) },
      ],
      notes: [],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(result.windows.map((window) => window.status), ["completed", "completed"]);
  assert.equal(result.windows[0]?.translations[0]?.text, "甲".repeat(500));
  assert.equal(result.windows[1]?.translations[0]?.text, "乙".repeat(500));
});

test("batch repairs a silently shortened Korean scene below the strict long-block band", async () => {
  const sourceBlocks = [
    block("block-0", 0, "가".repeat(401)),
    block("block-1", 1, "나".repeat(399)),
  ];
  const sourceRequest: PhysicalRequestPlan = {
    requestId: "request-short-korean-scene",
    sourceTokens: 4,
    windows: sourceBlocks.map((item, ordinal) => ({
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
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [
        {
          windowId: "window-0",
          translations: [{ blockId: "block-0", text: "甲".repeat(300) }],
          notes: [],
        },
        {
          windowId: "window-1",
          translations: [{ blockId: "block-1", text: "短" }],
          notes: [],
        },
      ],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: [{ blockId: "block-1", text: "乙".repeat(240) }],
      notes: [],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(result.windows.map((window) => window.status), ["completed", "completed"]);
  assert.equal(result.windows[1]?.translations[0]?.text, "乙".repeat(240));
});

test("batch normalizes traditional prose before validation and preserves locked targets", async () => {
  const sourceBlocks = [block("block-0", 0, "Dragon completed the training.")];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: sourceRequest.windows[0]?.windowId,
      translations: [{ blockId: "block-0", text: "龍完成了黑殺隊的訓練。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [{
      conceptId: "dragon",
      lexemeId: "dragon-lexeme",
      sourceForm: "Dragon",
      canonicalSource: "Dragon",
      target: "龍",
      locked: true,
    }],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[0]?.translations[0]?.text, "龍完成了黑杀队的训练。");
});

test("batch rejects one-character canonical block-id typos without local salvage", async () => {
  const expected = block("block-1f85f23a483f9edef746", 0, "Alpha.");
  const mistyped = "block-1f85a23a483f9edef746";
  const canonicalRequest = singleWindowRequest([expected]);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: canonicalRequest.windows[0]!.windowId,
      translations: [{ blockId: mistyped, text: "阿尔法。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request: canonicalRequest,
    blocks: [expected],
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.windows[0]?.status, "failed");
  assert.deepEqual(result.windows[0]?.translations, []);
  assert.match(result.windows[0]?.error ?? "", /unknown blockId/u);
  assert.deepEqual(result.responseErrors, []);
});

test("batch never corrects a submitted identifier that is a real other block", async () => {
  const expected = block("block-1f85f23a483f9edef746", 0, "Alpha.");
  const realOther = block("block-1f85a23a483f9edef746", 1, "Beta.");
  const canonicalRequest = singleWindowRequest([expected]);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [{
      windowId: canonicalRequest.windows[0]!.windowId,
      translations: [{ blockId: realOther.id, text: "阿尔法。" }],
      notes: [],
    }] },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request: canonicalRequest,
    blocks: [expected, realOther],
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(result.windows[0]?.status, "failed");
  assert.match(result.windows[0]?.error ?? "", /unknown blockId/i);
  assert.deepEqual(result.responseErrors, []);
});

test("batch rejects multi-character and ambiguous canonical block-id corrections", async () => {
  const expected = block("block-1f85f23a483f9edef746", 0, "Alpha.");
  const ambiguousOther = block("block-1f85a23a483f9edef747", 1, "Beta.");
  const canonicalRequest = singleWindowRequest([expected]);
  const cases = [
    {
      name: "a same-length non-hex identifier",
      submittedId: "block-1f85f23a483f9edef74g",
      inputBlocks: [expected],
    },
    {
      name: "two character differences",
      submittedId: "block-1f85a23a483f9edef747",
      inputBlocks: [expected],
    },
    {
      name: "two equally near real block identifiers",
      submittedId: "block-1f85a23a483f9edef746",
      inputBlocks: [expected, ambiguousOther],
    },
  ];

  for (const fixture of cases) {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      { windows: [{
        windowId: canonicalRequest.windows[0]!.windowId,
        translations: [{ blockId: fixture.submittedId, text: "阿尔法。" }],
        notes: [],
      }] },
    ), { stopReason: "toolUse" })]);

    const result = await runTranslationBatch({
      request: canonicalRequest,
      blocks: fixture.inputBlocks,
      stableTerms: [],
      snapshot: { id: "snapshot-0", revisions: [] },
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      budget: new BudgetLedger(),
    });

    assert.equal(result.windows[0]?.status, "failed", fixture.name);
    assert.match(result.windows[0]?.error ?? "", /unknown blockId/i, fixture.name);
    assert.deepEqual(result.responseErrors, [], fixture.name);
  }
});

test("batch prompt includes only the bounded current knowledge projection behind one sentinel", async () => {
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
    revisionId: "knowledge-revision-1",
    kind: "character",
    normalizedSubject: "alpha",
    revision: 1,
    status: "active",
    payload: {
      fact: "Alpha remains the same character in this scene.",
      subjectForms: ["Alpha"],
    },
    alternatives: [{
      fact: "Alpha remains the same character in this scene.",
      subjectForms: ["Alpha"],
    }],
    candidateIds: ["candidate-alpha"],
    sourceWindowIds: ["window-prior"],
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
  assert.equal(prompt.match(/KNOWLEDGE SNAPSHOT PROJECTION/g)?.length, 1);
  assert.match(prompt, /Alpha remains the same character/u);
  assert.doesNotMatch(prompt, /candidate-alpha|window-prior/u);
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

test("batch stops a malformed tool loop after one corrective turn", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("shell", { command: "ignored" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("shell", { command: "still ignored" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: request.windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blockIds.map((blockId) => ({ blockId, text: "不应抵达。" })),
        notes: [],
      })),
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(result.run.modelCalls, 2);
  assert.equal(result.repairRuns.length, 0);
  assert.equal(faux.state.callCount, 2);
  assert.equal(result.run.turnLimitReached, true);
  assert.ok(result.windows.every((window) => window.status === "failed"));
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
  const repairSystemPrompts: string[] = [];
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
      repairSystemPrompts.push(context.systemPrompt ?? "");
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
  assert.match(
    repairSystemPrompts[0] ?? "",
    /adjacent short display-only lines clearly form one title or heading/u,
  );
});

test("batch repairs a disallowed locked term surface and binds the repaired usage", async () => {
  const sourceBlocks = [block(
    "block-role",
    0,
    "Der Prokurist trat ein und erklärte Gregor ruhig, warum er am frühen Morgen gekommen war.",
  )];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const concept = reviseConcept(conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  }), { policy: "locked" });
  const stableTerms = [{
    conceptId: concept.conceptId,
    lexemeId: `${concept.conceptId}-lexeme`,
    sourceForm: concept.sourceForms[0]!,
    canonicalSource: concept.normalizedSubject,
    target: concept.canonicalTarget,
    locked: true,
    policy: concept.policy,
    semanticClass: concept.semanticClass,
    allowedTargets: concept.allowedRealizations,
    revisionId: concept.revisionId,
    renderFingerprint: concept.renderFingerprint,
  }];
  const prepared = prepareTranslationRequest({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms,
    snapshot: { id: "snapshot-role", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("de"),
  });
  const occurrence = prepared.expectedTermOccurrences[0]!;
  const repairPrompts: string[] = [];
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: sourceRequest.windows[0]!.windowId,
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "秘书主任走进屋来，平静地向格里高尔说明自己为何一大早赶到。",
        }],
        termUsages: [{
          occurrenceId: occurrence.occurrenceId,
          blockId: occurrence.blockId,
          conceptId: occurrence.conceptId,
          sourceForm: occurrence.sourceForm,
          sourceStart: occurrence.sourceStart,
          sourceEnd: occurrence.sourceEnd,
          discourseRole: "narrative",
          targetSurface: "秘书主任",
        }],
        notes: [],
      }],
    }), { stopReason: "toolUse" }),
    (context) => {
      repairPrompts.push(promptText(context));
      return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "主事走进屋来，平静地向格里高尔说明自己为何一大早赶到。",
        }],
        notes: [],
      }), { stopReason: "toolUse" });
    },
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms,
    snapshot: { id: "snapshot-role", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("de"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[0]?.termUsages[0]?.occurrenceId, occurrence.occurrenceId);
  assert.equal(result.windows[0]?.termUsages[0]?.targetSurface, "主事");
  assert.match(repairPrompts[0] ?? "", /TERM_USAGE_TARGET_NOT_ALLOWED/u);
  assert.match(repairPrompts[0] ?? "", /block-role/u);
});

test("batch deterministically completes an omitted valid term receipt without repair", async () => {
  const sourceBlocks = [block(
    "block-role-inferred",
    0,
    "Der Prokurist trat ein und erklärte ruhig den Grund seines Besuchs.",
  )];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });
  const stableTerms = [{
    conceptId: concept.conceptId,
    lexemeId: `${concept.conceptId}-lexeme`,
    sourceForm: concept.sourceForms[0]!,
    canonicalSource: concept.normalizedSubject,
    target: concept.canonicalTarget,
    locked: false,
    policy: concept.policy,
    semanticClass: concept.semanticClass,
    allowedTargets: concept.allowedRealizations,
    revisionId: concept.revisionId,
    renderFingerprint: concept.renderFingerprint,
  }];
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: sourceRequest.windows[0]!.windowId,
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "主事走进屋来，平静地说明了来访的缘由。",
        }],
        termUsages: [],
        notes: [],
      }],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms,
    snapshot: { id: "snapshot-role-inferred", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("de"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[0]?.termUsages.length, 1);
  assert.equal(result.windows[0]?.termUsages[0]?.targetSurface, "主事");
});

test("batch leaves an omitted soft term unbound when the target uses a natural variant", async () => {
  const sourceBlocks = [block(
    "block-role-soft-variant",
    0,
    "Der Prokurist trat ein und erklärte ruhig den Grund seines Besuchs.",
  )];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });
  const stableTerms = [{
    conceptId: concept.conceptId,
    lexemeId: `${concept.conceptId}-lexeme`,
    sourceForm: concept.sourceForms[0]!,
    canonicalSource: concept.normalizedSubject,
    target: concept.canonicalTarget,
    locked: false,
    policy: concept.policy,
    semanticClass: concept.semanticClass,
    allowedTargets: concept.allowedRealizations,
    revisionId: concept.revisionId,
    renderFingerprint: concept.renderFingerprint,
  }];
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: sourceRequest.windows[0]!.windowId,
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "公司代表走进屋来，平静地说明了来访的缘由。",
        }],
        termUsages: [],
        notes: [],
      }],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms,
    snapshot: { id: "snapshot-role-soft-variant", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("de"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.windows[0]?.status, "completed");
  assert.deepEqual(result.windows[0]?.termUsages, []);
});

test("batch normalizes a targeted repair before its final validation", async () => {
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
      translations: [{ blockId: "block-0", text: "他说：\"阿尔法\"。" }],
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
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[0]?.translations[0]?.text, "他说：“阿尔法”。");
  assert.equal(/["‛‟〝〞„]/u.test(result.windows[0]?.translations[0]?.text ?? ""), false);
  assert.equal(result.windows[1]?.status, "completed");
});

test("committed-boundary failures enter the targeted repair loop", async () => {
  const sourceBlocks = [block(
    "block-boundary",
    0,
    "The scout crossed the empty chamber and reported that the passage was clear.",
  )];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const repairPrompts: string[] = [];
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: [{
        windowId: sourceRequest.windows[0]!.windowId,
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "侦察员穿过空荡的舱室，报告通道安全。相邻块的整段译文被错误重复。",
        }],
        notes: [],
      }],
    }), { stopReason: "toolUse" }),
    (context) => {
      repairPrompts.push(promptText(context));
      return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
        translations: [{
          blockId: sourceBlocks[0]!.id,
          text: "侦察员穿过空荡的舱室，报告通道安全。",
        }],
        notes: [],
      }), { stopReason: "toolUse" });
    },
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-boundary", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    additionalValidationFailures: (window) =>
      window.translations[0]?.text.includes("相邻块的整段译文被错误重复")
        ? [{
            code: "cross_block_translation_overlap",
            blockId: sourceBlocks[0]!.id,
            message: "candidate repeats committed adjacent-block content",
            repairable: true,
          }]
        : [],
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(
    result.windows[0]?.translations[0]?.text,
    "侦察员穿过空荡的舱室，报告通道安全。",
  );
  assert.match(repairPrompts[0] ?? "", /cross_block_translation_overlap/u);
  assert.match(repairPrompts[0] ?? "", /committed adjacent-block content/u);
});

test("batch uses the explicit escalation runtime only for targeted repair", async () => {
  const primary = fauxProvider();
  const escalation = fauxProvider();
  primary.setResponses([fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
    windows: [{
      windowId: "window-0",
      translations: [{ blockId: "block-0", text: "错误译文。" }],
      notes: [],
    }, {
      windowId: "window-1",
      translations: [{ blockId: "block-1", text: "贝塔。" }],
      notes: [],
    }],
  }), { stopReason: "toolUse" })]);
  escalation.setResponses([fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
    translations: [{ blockId: "block-0", text: "阿尔法。" }],
    notes: [],
  }), { stopReason: "toolUse" })]);

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
    model: primary.getModel(),
    streamFn: primary.provider.streamSimple.bind(primary.provider),
    thinkingLevel: "off",
    repairRuntime: {
      model: escalation.getModel(),
      streamFn: escalation.provider.streamSimple.bind(escalation.provider),
      thinkingLevel: "high",
    },
    budget: new BudgetLedger(),
  } as never);

  assert.equal(primary.state.callCount, 1);
  assert.equal(escalation.state.callCount, 1);
  assert.equal(result.windows[0]?.translations[0]?.text, "阿尔法。");
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

test("framed text batch parses raw assistant prose without a tool call", async () => {
  const framedNonce = "1".repeat(32);
  const prepared = prepareTranslationRequest({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    responseProtocol: "framed_text",
    framedNonce,
  });
  const frames = prepared.framedProtocol?.frames ?? [];
  assert.equal(frames.length, 2);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([
    frames[0]!.beginLine,
    "阿尔法。",
    frames[0]!.endLine,
    frames[1]!.beginLine,
    "贝塔。",
    frames[1]!.endLine,
  ].join("\n"))]);
  const budget = new BudgetLedger();

  const result = await runTranslationBatch({
    request,
    blocks,
    stableTerms: [],
    snapshot: { id: "snapshot-0", revisions: [] },
    responseProtocol: "framed_text",
    framedNonce,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget,
  });

  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(result.run.toolNames, []);
  assert.equal(result.windows[0]?.translations[0]?.text, "阿尔法。");
  assert.equal(result.windows[1]?.translations[0]?.text, "贝塔。");
  assert.equal(budget.snapshot().translationToolCalls, 1);
});

test("Japanese mixed kanji-kana residue triggers one targeted repair", async () => {
  const sourceBlocks = [block("block-0", 0, "背後から拝み討ちを放った。")];
  const sourceRequest = singleWindowRequest(sourceBlocks);
  const framedNonce = "2".repeat(32);
  const prepared = prepareTranslationRequest({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-ja", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("ja"),
    responseProtocol: "framed_text",
    framedNonce,
  });
  const frame = prepared.framedProtocol?.frames[0];
  assert.ok(frame);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([
      frame.beginLine,
      "他从背后使出一记拜み讨ち。",
      frame.endLine,
    ].join("\n")),
    fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: [{ blockId: "block-0", text: "他从背后使出一记拜式斩击。" }],
      notes: [],
    }), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request: sourceRequest,
    blocks: sourceBlocks,
    stableTerms: [],
    snapshot: { id: "snapshot-ja", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("ja"),
    responseProtocol: "framed_text",
    framedNonce,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(result.windows[0]?.translations[0]?.text, "他从背后使出一记拜式斩击。");
});
