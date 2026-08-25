import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  narrowSelectedKnowledgeToTranslationWireInput,
  prepareTranslationRequest,
} from "../src/agents/translation-request.js";
import {
  paragraphFragmentExecutionScope,
  planParagraphFragments,
} from "../src/fullbook/paragraph-fragment.js";
import { admitTranslationRequests } from "../src/fullbook/execution-worker.js";
import type { PhysicalRequestPlan } from "../src/fullbook/types.js";
import {
  collectTranslationKnowledgeCandidates,
  projectKnowledgeForTranslation,
} from "../src/knowledge/translation-knowledge-projection.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { WeightedTokenEstimator } from "../src/source/token-estimator.js";
import type { LosslessBlock } from "../src/source/types.js";

function revision(
  revisionId: string,
  normalizedSubject: string,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  status: "active" | "needs_revalidate" | "contextual" = "active",
) {
  return {
    revisionId,
    revision: 1,
    normalizedSubject,
    kind,
    payload,
    alternatives: [payload],
    status,
    candidateIds: [`candidate-${revisionId}`],
    sourceWindowIds: ["window-prior"],
  };
}

function block(
  id: string,
  globalIndex: number,
  sourceText: string,
): LosslessBlock {
  return {
    id,
    sourceVersion: "source-v1",
    canonicalStart: globalIndex * 100,
    canonicalEnd: globalIndex * 100 + sourceText.length,
    sourceText,
    sourceHash: createHash("sha256").update(sourceText).digest("hex"),
    globalIndex,
    tokenCount: 20,
    structureId: null,
    structureTitle: null,
  };
}

function requestFor(sourceBlock: LosslessBlock): PhysicalRequestPlan {
  return {
    requestId: "request-context-profile",
    sourceTokens: sourceBlock.tokenCount,
    windows: [{
      windowId: "window-context-profile",
      ordinal: 0,
      chapterId: "chapter-context-profile",
      chapterTitle: null,
      blockIds: [sourceBlock.id],
      globalIndexes: [sourceBlock.globalIndex],
      sourceTokens: sourceBlock.tokenCount,
      sourceChars: sourceBlock.sourceText.length,
      oversized: false,
    }],
  };
}

test("knowledge candidates expose atomic structured relation bundles", () => {
  const profile = getSourceLanguageProfile("en");
  const payload = {
    fromEntityId: "entity-bird",
    relationType: "control",
    toEntityId: "entity-eyes",
    subjectForms: ["Bird"],
    note: "No source passage is copied into the scheduler bundle.",
  };
  const relation = revision(
    "revision-control",
    "bird-control",
    "entity_relation",
    payload,
  );

  const candidates = collectTranslationKnowledgeCandidates(
    [relation],
    ["Bird watched the room."],
    profile,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, "relation");
  assert.deepEqual(candidates[0]?.revisionIds, ["revision-control"]);
  assert.deepEqual(candidates[0]?.coverage, [
    "entity_identity",
    "control",
  ]);
  assert.equal(
    (candidates[0]?.payload as { payload?: unknown }).payload,
    payload,
  );
  assert.equal(
    candidates[0]?.tokenCost,
    new WeightedTokenEstimator().estimateJson!(
      candidates[0]?.payload,
      profile,
    ).tokens,
  );
});

test("candidate coverage never guesses risk from arbitrary fact prose", () => {
  const candidates = collectTranslationKnowledgeCandidates(
    [revision(
      "revision-unstructured",
      "bird",
      "entity_relation",
      {
        subjectForms: ["Bird"],
        fact: "control timeline causality viewpoint",
      },
    )],
    ["Bird moved."],
    getSourceLanguageProfile("en"),
  );

  assert.deepEqual(candidates[0]?.coverage, []);
});

test("position-scoped candidate utility decays with explicit block distance", () => {
  const candidates = collectTranslationKnowledgeCandidates(
    [
      revision("revision-near", "near-memory", "narrative_memory", {
        startBlockId: "block-current",
        endBlockId: "block-end",
        confidence: 0.8,
      }),
      revision("revision-far", "far-memory", "narrative_memory", {
        startBlockId: "block-start",
        endBlockId: "block-end",
        confidence: 0.8,
      }),
    ],
    ["Synthetic current text."],
    getSourceLanguageProfile("en"),
    {
      corpusBlocks: [
        { blockId: "block-start", globalIndex: 0 },
        { blockId: "block-current", globalIndex: 10 },
        { blockId: "block-end", globalIndex: 20 },
      ],
      currentBlocks: [{
        blockId: "block-current",
        globalIndex: 10,
        windowId: "window-current",
      }],
    },
  );
  const utilityById = new Map(candidates.map((candidate) => [
    candidate.revisionIds[0],
    candidate.utility,
  ]));

  assert.ok(
    utilityById.get("revision-near")! > utilityById.get("revision-far")!,
  );
});

test("prepared requests serialize only selected revision ids after the stable prefix", () => {
  const sourceBlock = block(
    "block-context-profile",
    0,
    "Alice met Bob in the hall.",
  );
  const revisions = [
    revision("revision-a", "alice", "entity_identity", {
      subjectForms: ["Alice"],
      canonicalName: "Alice",
    }),
    revision("revision-b", "bob", "entity_identity", {
      subjectForms: ["Bob"],
      canonicalName: "Bob",
    }),
  ];
  const base = {
    request: requestFor(sourceBlock),
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: { id: "snapshot-context-profile", revisions },
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  };
  const unselected = prepareTranslationRequest(base);
  const selected = prepareTranslationRequest({
    ...base,
    selectedKnowledgeRevisionIds: ["revision-a"],
    contextProfileName: "lean",
  });
  const memory = selected.sections.find((section) => section.kind === "memory")
    ?.jsonPayload as { revisions: readonly { revisionId: string }[] };
  const request = selected.sections[0]?.jsonPayload as {
    contextProfileName?: string;
  };

  assert.deepEqual(
    memory.revisions.map((item) => item.revisionId),
    ["revision-a"],
  );
  assert.equal(request.contextProfileName, "lean");
  assert.equal(selected.systemPrompt, unselected.systemPrompt);
  assert.equal(selected.serializedToolSchemas, unselected.serializedToolSchemas);
  assert.equal(selected.sections[0]?.kind, "request");
  assert.equal(selected.sections[1]?.kind, "memory");
});

test("selected revisions fail when missing, inapplicable, or over entry budget", () => {
  const profile = getSourceLanguageProfile("en");
  const revisions = [
    revision("revision-alice", "alice", "entity_identity", {
      subjectForms: ["Alice"],
    }),
    revision("revision-bob", "bob", "entity_identity", {
      subjectForms: ["Bob"],
    }),
  ];

  assert.throws(
    () => projectKnowledgeForTranslation(
      revisions,
      ["Alice waited."],
      profile,
      { selectedRevisionIds: new Set(["revision-missing"]) },
    ),
    /selected knowledge revision does not exist/u,
  );
  assert.throws(
    () => projectKnowledgeForTranslation(
      revisions,
      ["Alice waited."],
      profile,
      { selectedRevisionIds: new Set(["revision-bob"]) },
    ),
    /selected knowledge revision is not applicable/u,
  );
  assert.throws(
    () => projectKnowledgeForTranslation(
      revisions,
      ["Alice met Bob."],
      profile,
      {
        selectedRevisionIds: new Set(["revision-alice", "revision-bob"]),
        maxEntries: 1,
      },
    ),
    /selected knowledge revisions exceed entry budget/u,
  );
});

test("paragraph execution narrows planned knowledge to the exact wire fragment", () => {
  const sourceBlock = block(
    "block-fragment-knowledge",
    0,
    [
      ...Array.from(
        { length: 12 },
        (_, index) => `Ordinary source paragraph ${index + 1}.`,
      ),
      "Brin appears only in the final source paragraph.",
    ].join("\n\n"),
  );
  const plan = planParagraphFragments({
    windowId: "window-context-profile",
    block: sourceBlock,
    snapshotId: "snapshot-context-profile",
  });
  const brin = revision("revision-brin", "brin", "lexical_concept", {
    sourceForms: ["Brin"],
    canonicalTarget: "布林",
  });
  const base = {
    request: requestFor(sourceBlock),
    blocks: [sourceBlock],
    stableTerms: [],
    snapshot: {
      id: "snapshot-context-profile",
      revisions: [brin],
    },
    sourceLanguageProfile: getSourceLanguageProfile("en"),
    selectedKnowledgeRevisionIds: ["revision-brin"],
    contextProfileName: "rich" as const,
    responseProtocol: "typed_tool" as const,
  };
  const first = {
    ...base,
    paragraphFragment: paragraphFragmentExecutionScope(
      plan,
      plan.units[0]!,
    ),
  };
  assert.throws(
    () => prepareTranslationRequest(first),
    /selected knowledge revision is not applicable/u,
  );
  const narrowedFirst =
    narrowSelectedKnowledgeToTranslationWireInput(first);
  assert.deepEqual(narrowedFirst.selectedKnowledgeRevisionIds, []);
  assert.deepEqual(
    (prepareTranslationRequest(narrowedFirst).sections
      .find((section) => section.kind === "memory")
      ?.jsonPayload as { revisions: readonly unknown[] }).revisions,
    [],
  );

  const final = narrowSelectedKnowledgeToTranslationWireInput({
    ...base,
    paragraphFragment: paragraphFragmentExecutionScope(
      plan,
      plan.units.at(-1)!,
    ),
  });
  assert.deepEqual(final.selectedKnowledgeRevisionIds, ["revision-brin"]);
  const memory = prepareTranslationRequest(final).sections
    .find((section) => section.kind === "memory")
    ?.jsonPayload as { revisions: readonly { revisionId: string }[] };
  assert.deepEqual(
    memory.revisions.map((item) => item.revisionId),
    ["revision-brin"],
  );

  const admitted = admitTranslationRequests(
    [base.request],
    {
      model: {
        id: "fragment-knowledge-test",
        contextWindow: 128_000,
        maxTokens: 16_000,
      },
      streamFn: (() => {
        throw new Error("admission must not call the provider");
      }) as never,
      effort: "high",
      thinkingLevel: "high",
    } as never,
    new WeightedTokenEstimator(),
    new Map([[sourceBlock.id, sourceBlock]]),
    () => base,
  )[0];
  assert.ok(admitted);
  assert.deepEqual(
    admitted.fragments.map((fragment) =>
      fragment.input.selectedKnowledgeRevisionIds),
    [[], ["revision-brin"]],
  );
});
