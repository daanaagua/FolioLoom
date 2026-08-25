import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { runTranslationBatch } from "../src/agents/translation-batch.js";
import {
  expectedTermOccurrencesForTranslationInput,
  prepareTranslationRequest,
} from "../src/agents/translation-request.js";
import {
  planParagraphFragments,
} from "../src/fullbook/paragraph-fragment.js";
import type { PhysicalRequestPlan } from "../src/fullbook/types.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import type { LosslessBlock } from "../src/source/types.js";

const sourceText = [
  "The first complete source paragraph has enough ordinary prose for validation.",
  "The second complete source paragraph continues the scene without ambiguity.",
  "The third complete source paragraph closes this deterministic fixture.",
].join("\n\n");

const sourceBlock: LosslessBlock = {
  id: "block-0123456789abcdefabcd",
  sourceVersion: "source-v1",
  canonicalStart: 0,
  canonicalEnd: sourceText.length,
  sourceText,
  sourceHash: createHash("sha256").update(sourceText).digest("hex"),
  globalIndex: 0,
  tokenCount: 60,
  estimatorVersion: "test",
  structureId: "chapter-1",
  structureTitle: null,
};

const request: PhysicalRequestPlan = {
  requestId: "request-fragment-protocol",
  sourceTokens: sourceBlock.tokenCount,
  windows: [{
    windowId: "window-fragment-protocol",
    ordinal: 0,
    chapterId: "chapter-1",
    chapterTitle: null,
    blockIds: [sourceBlock.id],
    globalIndexes: [sourceBlock.globalIndex],
    sourceTokens: sourceBlock.tokenCount,
    sourceChars: sourceBlock.sourceText.length,
    oversized: false,
  }],
};

const plan = planParagraphFragments({
  windowId: request.windows[0]?.windowId ?? "",
  block: sourceBlock,
  snapshotId: "snapshot-1",
  maxTargetParagraphs: 2,
});
const unit = plan.units.at(-1)!;
const executionScope = {
  planId: plan.planId,
  executionUnitId: unit.executionUnitId,
  blockId: plan.blockId,
  sourceHash: plan.sourceHash,
  snapshotId: plan.snapshotId,
  paragraphs: unit.paragraphs,
  leftSourceContext: unit.leftSourceContext,
  rightSourceContext: unit.rightSourceContext,
};

test("fragment typed prompt distinguishes target paragraphs from context-only source", () => {
  const prepared = prepareTranslationRequest({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
  });

  assert.doesNotMatch(prepared.prompt, new RegExp(unit.executionUnitId, "u"));
  assert.match(prepared.prompt, /TARGET SOURCE FRAGMENT/u);
  assert.match(prepared.prompt, /CONTEXT-ONLY PARAGRAPHS/u);
  assert.match(
    prepared.prompt,
    /"paragraphs":\[\{"paragraphId":"[^"]+","ordinal":0,"sourceText":/u,
  );
  assert.doesNotMatch(prepared.serializedToolSchemas, /executionUnitId/u);
  assert.doesNotMatch(prepared.serializedToolSchemas, /paragraphId/u);
  assert.match(prepared.serializedToolSchemas, /"paragraphs"/u);
  assert.match(prepared.serializedToolSchemas, /"termUsages"/u);
  assert.doesNotMatch(prepared.serializedToolSchemas, /"notes"/u);
  assert.doesNotMatch(prepared.serializedToolSchemas, /"memoryCandidates"/u);
  assert.doesNotMatch(prepared.serializedToolSchemas, /"styleObservation"/u);

  const [toolSchema] = JSON.parse(prepared.serializedToolSchemas) as Array<{
    parameters: {
      properties: {
        windows: {
          minItems?: number;
          maxItems?: number;
          items: {
            properties: {
              windowId: { const?: string };
              translations: {
                minItems?: number;
                maxItems?: number;
                items: {
                  anyOf?: unknown[];
                  properties: {
                    blockId: { const?: string };
                    paragraphs: {
                      minItems?: number;
                      maxItems?: number;
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  }>;
  const windowsSchema = toolSchema!.parameters.properties.windows;
  const windowSchema = windowsSchema.items;
  const translationsSchema = windowSchema.properties.translations;
  const translationSchema = translationsSchema.items;
  const paragraphsSchema = translationSchema.properties.paragraphs;

  assert.equal(windowsSchema.minItems, 1);
  assert.equal(windowsSchema.maxItems, 1);
  assert.equal(windowSchema.properties.windowId.const, request.windows[0]!.windowId);
  assert.equal(translationsSchema.minItems, 1);
  assert.equal(translationsSchema.maxItems, 1);
  assert.equal("anyOf" in translationSchema, false);
  assert.equal(translationSchema.properties.blockId.const, sourceBlock.id);
  assert.equal(paragraphsSchema.minItems, unit.paragraphs.length);
  assert.equal(paragraphsSchema.maxItems, unit.paragraphs.length);
});

test("single-paragraph refinement uses a text-only invocation-owned leaf tool", async () => {
  const singlePlan = planParagraphFragments({
    windowId: request.windows[0]?.windowId ?? "",
    block: sourceBlock,
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 1,
  });
  const singleUnit = singlePlan.units[0]!;
  const singleScope = {
    planId: singlePlan.planId,
    executionUnitId: singleUnit.executionUnitId,
    blockId: singlePlan.blockId,
    sourceHash: singlePlan.sourceHash,
    snapshotId: singlePlan.snapshotId,
    paragraphs: singleUnit.paragraphs,
    leftSourceContext: singleUnit.leftSourceContext,
    rightSourceContext: singleUnit.rightSourceContext,
  };
  const prepared = prepareTranslationRequest({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: singleScope,
  });
  assert.deepEqual(
    prepared.tools.map((tool) => tool.name),
    ["finalize_paragraph_fragment"],
  );
  const [serializedTool] = JSON.parse(
    prepared.serializedToolSchemas,
  ) as Array<{
    parameters: {
      properties: Record<string, { minLength?: number }>;
    };
  }>;
  assert.deepEqual(
    Object.keys(serializedTool?.parameters.properties ?? {}),
    ["text"],
  );
  assert.ok(
    (serializedTool?.parameters.properties.text?.minLength ?? 0) > 0,
  );
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_paragraph_fragment",
    {
      text: "第一段完整译文保留了源文中的全部普通信息，可用于确定性的质量验证。",
    },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: singleScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(result.run.toolNames, ["finalize_paragraph_fragment"]);
  assert.equal(
    result.windows[0]?.status,
    "completed",
    result.windows[0]?.error,
  );
});

test("fragment term receipts use canonical scalar coordinates after astral text", () => {
  const emojiSource = [
    "😀 The opening paragraph precedes the protected term.",
    "Mechanism appears in the second paragraph.",
  ].join("\n\n");
  const emojiBlock: LosslessBlock = {
    ...sourceBlock,
    sourceText: emojiSource,
    canonicalEnd: Array.from(emojiSource).length,
    sourceHash: createHash("sha256").update(emojiSource).digest("hex"),
  };
  const emojiRequest: PhysicalRequestPlan = {
    ...request,
    windows: [{
      ...request.windows[0]!,
      sourceChars: Array.from(emojiSource).length,
    }],
  };
  const emojiPlan = planParagraphFragments({
    windowId: emojiRequest.windows[0]!.windowId,
    block: emojiBlock,
    snapshotId: "snapshot-1",
    maxTargetParagraphs: 1,
  });
  const secondUnit = emojiPlan.units[1]!;
  const occurrences = expectedTermOccurrencesForTranslationInput({
    request: emojiRequest,
    blocks: [emojiBlock],
    stableTerms: [{
      conceptId: "concept-mechanism",
      lexemeId: "lexeme-mechanism",
      sourceForm: "Mechanism",
      canonicalSource: "Mechanism",
      target: "机械",
      locked: true,
      policy: "locked",
      semanticClass: "technical_term",
      allowedTargets: ["机械"],
      revisionId: "revision-mechanism",
      renderFingerprint: "b".repeat(64),
    }],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: {
      planId: emojiPlan.planId,
      executionUnitId: secondUnit.executionUnitId,
      blockId: emojiPlan.blockId,
      sourceHash: emojiPlan.sourceHash,
      snapshotId: emojiPlan.snapshotId,
      paragraphs: secondUnit.paragraphs,
      leftSourceContext: secondUnit.leftSourceContext,
      rightSourceContext: secondUnit.rightSourceContext,
    },
  });

  assert.equal(occurrences.length, 1);
  assert.equal(
    occurrences[0]?.sourceStart,
    Array.from(emojiSource.slice(0, emojiSource.indexOf("Mechanism"))).length,
  );
});

test("fragment typed submission requires exact paragraph identity and joins locally", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    {
      windows: [{
        windowId: request.windows[0]?.windowId,
        translations: [{
          blockId: sourceBlock.id,
          paragraphs: [
            { text: "第一段完整译文保留了源文的全部信息。" },
            { text: "第二段完整译文继续场景并保持清晰连贯。" },
          ],
        }],
      }],
    },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(
    result.windows[0]?.status,
    "completed",
    result.windows[0]?.error,
  );
  assert.equal(
    result.windows[0]?.translations[0]?.text,
    "第一段完整译文保留了源文的全部信息。\n\n第二段完整译文继续场景并保持清晰连贯。",
  );
  assert.deepEqual(
    result.windows[0]?.paragraphs?.map((paragraph) => paragraph.paragraphId),
    unit.paragraphs.map((paragraph) => paragraph.paragraphId),
  );
});

test("fragment rejects discovery metadata and accepts a minimal correction", async () => {
  const faux = fauxProvider();
  const fragmentSubmission = {
    windows: [{
        windowId: request.windows[0]?.windowId,
        translations: [{
          blockId: sourceBlock.id,
          paragraphs: [
            {
              text:
                "第一段完整译文保留了源文中的全部普通信息，可用于确定性的质量验证。",
            },
            {
              text:
                "第二段完整译文继续呈现场景中的全部细节，并且保持清晰连贯而没有歧义。",
            },
          ],
        }],
      }],
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      {
        ...fragmentSubmission,
        notes: ["disallowed fragment discovery metadata"],
      },
    ), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      fragmentSubmission,
    ), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(
    result.windows[0]?.status,
    "completed",
    result.windows[0]?.error,
  );
  assert.deepEqual(result.windows[0]?.notes, []);
});

test("fragment exact schema rejects sibling spill and accepts one correction", async () => {
  const faux = fauxProvider();
  const setFragmentResponses = faux.setResponses;
  faux.setResponses = (responses) => {
    const malformedArgs =
      (responses[0] as any).content[0].arguments as {
        windows: Array<{
          windowId: string;
          translations: Array<{
            blockId?: string;
            paragraphs?: Array<{ text: string }>;
            text?: string;
          }>;
        }>;
      };
    const malformedWindow = malformedArgs.windows[0]!;
    const [anchor, spilled] = malformedWindow.translations;
    setFragmentResponses([
      ...responses,
      fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
        windows: [{
          windowId: malformedWindow.windowId,
          translations: [{
            blockId: anchor!.blockId,
            paragraphs: [
              ...anchor!.paragraphs!,
              { text: spilled!.text! },
            ],
          }],
        }],
      }), { stopReason: "toolUse" }),
    ]);
  };
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    {
      windows: [{
        windowId: request.windows[0]?.windowId,
        translations: [{
          blockId: sourceBlock.id,
          paragraphs: [{
            text: "第一段完整译文保留了源文的全部信息。",
          }],
        }, {
          text: "第二段完整译文继续场景并保持清晰连贯。",
        }],
      }],
    },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.windows[0]?.status, "completed");
  assert.equal(
    result.windows[0]?.translations[0]?.text,
    "第一段完整译文保留了源文的全部信息。\n\n第二段完整译文继续场景并保持清晰连贯。",
  );
});

test("fragment exact schema rejects an empty paragraph and accepts one correction", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      {
        windows: [{
          windowId: request.windows[0]?.windowId,
          translations: [{
            blockId: sourceBlock.id,
            paragraphs: [
              { text: "第一段完整译文保留了源文的全部信息。" },
              { text: "" },
            ],
          }],
        }],
      },
    ), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      {
        windows: [{
          windowId: request.windows[0]?.windowId,
          translations: [{
            blockId: sourceBlock.id,
            paragraphs: [
              { text: "第一段完整译文保留了源文的全部信息。" },
              { text: "第二段补正译文继续场景并保持清晰连贯。" },
            ],
          }],
        }],
      },
    ), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(
    result.windows[0]?.status,
    "completed",
    result.windows[0]?.error,
  );
  assert.equal(
    result.windows[0]?.translations[0]?.text,
    "第一段完整译文保留了源文的全部信息。\n\n第二段补正译文继续场景并保持清晰连贯。",
  );
});

test("fragment exact schema rejects a validator-incompatible truncation and accepts one correction", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      {
        windows: [{
          windowId: request.windows[0]?.windowId,
          translations: [{
            blockId: sourceBlock.id,
            paragraphs: [
              { text: "第一段完整译文保留了源文的全部信息。" },
              { text: "短" },
            ],
          }],
        }],
      },
    ), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall(
      "finalize_translation_batch",
      {
        windows: [{
          windowId: request.windows[0]?.windowId,
          translations: [{
            blockId: sourceBlock.id,
            paragraphs: [
              { text: "第一段完整译文保留了源文的全部信息。" },
              { text: "第二段补正译文继续场景并保持清晰连贯。" },
            ],
          }],
        }],
      },
    ), { stopReason: "toolUse" }),
  ]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(
    result.windows[0]?.status,
    "completed",
    result.windows[0]?.error,
  );
  assert.equal(
    result.windows[0]?.translations[0]?.text,
    "第一段完整译文保留了源文的全部信息。\n\n第二段补正译文继续场景并保持清晰连贯。",
  );
});

test("fragment typed submission rejects paragraph-count drift without repair", async () => {
  const faux = fauxProvider();
  const setCountDriftResponses = faux.setResponses;
  faux.setResponses = (responses) =>
    setCountDriftResponses([...responses, ...responses]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    {
      windows: [{
        windowId: request.windows[0]?.windowId,
        translations: [{
          blockId: sourceBlock.id,
          paragraphs: [{ text: "只有一段，缺少第二段。" }],
        }],
      }],
    },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    paragraphFragment: executionScope,
    repairEnabled: false,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 2);
  assert.equal(result.windows[0]?.status, "failed");
  assert.match(result.windows[0]?.error ?? "", /missing window submission/u);
});

test("whole-block shape collapse returns to the worker without consuming repair credit", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    {
      windows: [{
        windowId: request.windows[0]?.windowId,
        translations: [{
          blockId: sourceBlock.id,
          text: "过短。",
        }],
        notes: [],
      }],
    },
  ), { stopReason: "toolUse" })]);

  const result = await runTranslationBatch({
    request,
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-1", revisions: [] },
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.repairRuns.length, 0);
  assert.equal(result.windows[0]?.status, "failed");
  assert.match(result.windows[0]?.error ?? "", /shape collapse/u);
});
