import type { StableTerm } from "../domain/types.js";
import type { ParagraphFragmentExecutionScope } from "../fullbook/paragraph-fragment.js";
import type { PhysicalRequestPlan } from "../fullbook/types.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import {
  conceptsFromStableTerms,
  expectedTermOccurrences,
  type ExpectedTermOccurrence,
  type TermUsageSubmission,
} from "../knowledge/term-usage.js";
import {
  projectKnowledgeForTranslation,
  retainApplicableTranslationKnowledgeRevisionIds,
  type TranslationKnowledgeCurrentBlockPosition,
} from "../knowledge/translation-knowledge-projection.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  DEFAULT_TARGET_LANGUAGE,
  SIMPLIFIED_CHINESE_SCRIPT_REQUIREMENT,
  targetLanguageLabel,
} from "../language/target.js";
import type { LosslessBlock } from "../source/types.js";
import { sourceTextForTranslation } from "../source/layout-separators.js";
import type {
  EffectiveStyleProjection,
  StyleObservationSubmission,
} from "../style/types.js";
import { semanticCharacterLength } from "../text/semantic-text.js";
import {
  TRANSLATION_MEMORY_KINDS,
  type TranslationMemoryCandidate,
} from "../tools/candidate-collector.js";
import {
  assertNotAborted,
  Type,
  type TypedToolSpec,
} from "../tools/tool-spec.js";
import {
  createFramedTranslationProtocol,
  framedTranslationInstructions,
  type FramedTranslationProtocol,
} from "./framed-translation-protocol.js";
import { PARAGRAPH_INTEGRITY_INSTRUCTIONS } from "./paragraph-integrity.js";

export interface FinalizeTranslationBatchArgs {
  windows: Array<{
    windowId: string;
    translations: Array<{ blockId: string; text: string }>;
    termUsages?: TermUsageSubmission[];
    notes: string[];
    memoryCandidates?: TranslationMemoryCandidate[];
    styleObservation?: StyleObservationSubmission;
  }>;
}

type FinalizeTranslationWindow = FinalizeTranslationBatchArgs["windows"][number];

interface FinalizeTranslationWireTranslation {
  blockId?: string;
  text?: string;
  paragraphs?: Array<{ text: string }>;
}

interface FinalizeTranslationBatchWireArgs {
  windows: Array<Omit<FinalizeTranslationWindow, "notes" | "translations"> & {
    notes?: string[];
    translations: FinalizeTranslationWireTranslation[];
  }>;
  termUsages?: TermUsageSubmission[];
  notes?: string[];
  memoryCandidates?: TranslationMemoryCandidate[];
  styleObservation?: StyleObservationSubmission;
}

interface FinalizeParagraphFragmentWireArgs {
  text: string;
}

const FINALIZER_METADATA_KEYS = [
  "termUsages",
  "notes",
  "memoryCandidates",
  "styleObservation",
] as const;

function canonicalizeFinalizerEnvelope(
  rawArgs: FinalizeTranslationBatchWireArgs,
  paragraphFragment?: ParagraphFragmentExecutionScope,
): FinalizeTranslationBatchArgs {
  const allowedEnvelopeKeys = paragraphFragment === undefined
    ? FINALIZER_METADATA_KEYS
    : (["termUsages"] as const);
  if (paragraphFragment !== undefined) {
    const disallowedFragmentMetadata = [
      "notes",
      "memoryCandidates",
      "styleObservation",
    ] as const;
    for (const key of disallowedFragmentMetadata) {
      if (
        rawArgs[key] !== undefined
        || rawArgs.windows.some((window) => window[key] !== undefined)
      ) {
        throw new Error(
          `paragraph fragment finalization does not accept ${key}`,
        );
      }
    }
  }
  const envelopeKeys = allowedEnvelopeKeys.filter(
    (key) => rawArgs[key] !== undefined,
  );
  if (envelopeKeys.length > 0 && rawArgs.windows.length !== 1) {
    throw new Error(
      "tool-envelope metadata is only unambiguous for exactly one logical window",
    );
  }
  const windows = rawArgs.windows.map((window) => ({ ...window }));
  const soleWindow = windows[0];
  if (envelopeKeys.length > 0 && soleWindow !== undefined) {
    for (const key of envelopeKeys) {
      if (soleWindow[key] !== undefined) {
        throw new Error(
          `ambiguous ${key}: submit it inside the logical window only`,
        );
      }
      soleWindow[key] = structuredClone(rawArgs[key]) as never;
    }
  }
  return {
    windows: windows.map((window) => ({
      ...window,
      translations: paragraphFragment === undefined
        ? window.translations.map((translation) => {
          if (typeof translation.blockId !== "string") {
            throw new Error("whole-block translation requires blockId");
          }
          if (typeof translation.text !== "string") {
            throw new Error("whole-block translation requires text");
          }
          return {
            blockId: translation.blockId,
            text: translation.text,
          };
        })
        : (() => {
          const [anchor, ...unexpectedTranslations] = window.translations;
          if (typeof anchor?.blockId !== "string"
            || !Array.isArray(anchor.paragraphs)
            || anchor.text !== undefined) {
            throw new Error(
              "paragraph fragment translation requires exactly one block with an ordered paragraphs array",
            );
          }
          if (unexpectedTranslations.length > 0) {
            throw new Error(
              "paragraph fragment translation requires exactly one translations item",
            );
          }
          return [{
            blockId: anchor.blockId,
            text: anchor.paragraphs.map((paragraph) => paragraph.text)
              .join("\n\n"),
          }];
        })(),
      notes: window.notes ?? [],
    })),
  };
}

export interface TranslationBatchSnapshot {
  readonly id: string;
  readonly revisions: readonly unknown[];
}

/**
 * The complete translator-visible input.  Runtime-only handles such as the
 * model, stream, and mutable budget deliberately do not belong here: this
 * object is what must be measured before a request can be admitted.
 */
export interface TranslationRequestInput {
  request: PhysicalRequestPlan;
  blocks: readonly LosslessBlock[];
  stableTerms: readonly StableTerm[];
  snapshot: TranslationBatchSnapshot;
  selectedKnowledgeRevisionIds?: readonly string[];
  contextProfileName?: "lean" | "balanced" | "rich";
  styleState?: Readonly<Record<string, string>>;
  previousActiveTail?: string;
  sourceLanguageProfile?: SourceLanguageProfile;
  entityLinkWarnings?: readonly string[];
  effectiveStyleByWindow?: Readonly<Record<string, EffectiveStyleProjection>>;
  responseProtocol?: TranslationResponseProtocol;
  /** Stable only for this admitted framed attempt; new attempts use new entropy. */
  framedNonce?: string;
  paragraphFragment?: ParagraphFragmentExecutionScope;
}

export type TranslationResponseProtocol = "typed_tool" | "framed_text";

export type TranslationRequestSectionKind =
  | "request"
  | "memory"
  | "source"
  | "terms"
  | "style"
  | "protocol";

export interface TranslationRequestSection {
  readonly kind: TranslationRequestSectionKind;
  /** Exact prompt text, including section labels, sent to the model. */
  readonly text: string;
  /** Structured projection behind text when a token estimator supports JSON. */
  readonly jsonPayload?: unknown;
}

export interface TranslationRequestHooks {
  onFinalize?: (
    args: FinalizeTranslationBatchArgs,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface PreparedTranslationRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly sections: readonly TranslationRequestSection[];
  readonly tools: readonly TypedToolSpec<any>[];
  /** Canonical wire-schema projection; executable handlers are never serialized. */
  readonly serializedToolSchemas: string;
  readonly expectedTermOccurrences: readonly ExpectedTermOccurrence[];
  readonly framedProtocol?: FramedTranslationProtocol;
}

function requireFinalizer(hooks: TranslationRequestHooks): (
  args: FinalizeTranslationBatchArgs,
  signal: AbortSignal,
) => Promise<unknown> {
  if (hooks.onFinalize === undefined) {
    return async () => {
      throw new Error("prepared translation request has no finalizer handler");
    };
  }
  return hooks.onFinalize;
}

function finalizerTool(
  hooks: TranslationRequestHooks,
  paragraphFragment?: ParagraphFragmentExecutionScope,
  expectedWindowId?: string,
  sourceLanguageProfile: SourceLanguageProfile = getSourceLanguageProfile("en"),
): TypedToolSpec<any> {
  const onFinalize = requireFinalizer(hooks);
  if (paragraphFragment !== undefined && expectedWindowId === undefined) {
    throw new Error("paragraph fragment finalizer requires one expected windowId");
  }
  const paragraphCount = paragraphFragment?.paragraphs.length ?? 1;
  const fragmentParagraphMinimumLengths = paragraphFragment?.paragraphs.map(
    (paragraph) => {
      const sourceLength = semanticCharacterLength(
        sourceTextForTranslation(paragraph.sourceText),
      );
      const ratioBand = [...(
        sourceLanguageProfile.translationLengthRatioBands ?? []
      )]
        .filter((band) => sourceLength >= band.minSourceCharacters)
        .sort((left, right) =>
          right.minSourceCharacters - left.minSourceCharacters)[0];
      return Math.max(
        1,
        Math.ceil(sourceLength * (ratioBand?.min ?? 0)),
      );
    },
  ) ?? [];
  const fragmentParagraphMinimumLength =
    fragmentParagraphMinimumLengths.length === 0
      ? 1
      : Math.min(...fragmentParagraphMinimumLengths);
  const canonicalFragmentTranslationSchema = Type.Object({
    blockId: paragraphFragment === undefined
      ? Type.String()
      : Type.Literal(paragraphFragment.blockId),
    paragraphs: Type.Array(Type.Object({
      text: Type.String({
        minLength: fragmentParagraphMinimumLength,
      }),
    }, { additionalProperties: false }), {
      minItems: paragraphCount,
      maxItems: paragraphCount,
    }),
  }, { additionalProperties: false });
  const translationSchema = paragraphFragment === undefined
    ? Type.Object({
      blockId: Type.String(),
      text: Type.String(),
    }, { additionalProperties: false })
    : canonicalFragmentTranslationSchema;
  const termUsagesSchema = Type.Array(Type.Object({
    occurrenceId: Type.String(),
    blockId: Type.String(),
    conceptId: Type.String(),
    sourceForm: Type.String(),
    sourceStart: Type.Integer({ minimum: 0 }),
    sourceEnd: Type.Integer({ minimum: 1 }),
    discourseRole: Type.Union([
      Type.Literal("narrative"),
      Type.Literal("vocative"),
      Type.Literal("title"),
      Type.Literal("other"),
    ]),
    targetSurface: Type.String(),
  }, { additionalProperties: false }), { maxItems: 512 });
  const notesSchema = Type.Array(Type.String());
  const memoryCandidatesSchema = Type.Array(Type.Object({
    kind: Type.Union(
      TRANSLATION_MEMORY_KINDS.map((kind) => Type.Literal(kind)),
    ),
    subjectForms: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
    fact: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }, { additionalProperties: false }), { maxItems: 4 });
  const styleObservationSchema = Type.Object({
    voiceId: Type.Optional(Type.String()),
    activeRegister: Type.Optional(Type.String()),
    rhythm: Type.Optional(Type.String()),
    addressChoices: Type.Optional(Type.Array(Type.Object({
      subject: Type.String(),
      target: Type.String(),
    }, { additionalProperties: false }), { maxItems: 6 })),
    lexicalChoices: Type.Optional(Type.Array(Type.Object({
      source: Type.String(),
      target: Type.String(),
    }, { additionalProperties: false }), { maxItems: 6 })),
    continuityNotes: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
    modeWeights: Type.Optional(Type.Object({
      narrative: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      dialogue: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      action: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      description: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      technical: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      documentary: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      lyrical: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      interior: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false });
  if (paragraphFragment !== undefined && paragraphCount === 1) {
    return {
      name: "finalize_paragraph_fragment",
      label: "Finalize paragraph fragment",
      description:
        "Submit only the complete target text for this invocation-owned source paragraph.",
      phase: "translation",
      parameters: Type.Object({
        text: Type.String({
          minLength: fragmentParagraphMinimumLength,
        }),
      }, { additionalProperties: false }),
      execute: async (
        rawArgs: FinalizeParagraphFragmentWireArgs,
        signal,
      ) => {
        assertNotAborted(signal);
        return onFinalize({
          windows: [{
            windowId: expectedWindowId!,
            translations: [{
              blockId: paragraphFragment.blockId,
              text: rawArgs.text,
            }],
            notes: [],
          }],
        }, signal);
      },
    };
  }
  const wholeWindowProperties = {
    windowId: paragraphFragment === undefined
      ? Type.String()
      : Type.Literal(expectedWindowId!),
    translations: Type.Array(
      translationSchema,
      paragraphFragment === undefined
        ? {}
        : {
          minItems: 1,
          maxItems: 1,
        },
    ),
    termUsages: Type.Optional(termUsagesSchema),
    notes: Type.Optional(notesSchema),
    memoryCandidates: Type.Optional(memoryCandidatesSchema),
    styleObservation: Type.Optional(styleObservationSchema),
  };
  const fragmentWindowProperties = {
    windowId: Type.Literal(expectedWindowId!),
    translations: Type.Array(translationSchema, {
      minItems: 1,
      maxItems: 1,
    }),
    termUsages: Type.Optional(termUsagesSchema),
  };
  return {
    name: "finalize_translation_batch",
    label: "Finalize translation batch",
    description: paragraphFragment === undefined
      ? "Submit one complete response grouped by immutable logical window identity."
      : "Submit one ordered target paragraphs item for every source paragraph in the fragment.",
    phase: "translation",
    parameters: paragraphFragment === undefined
      ? Type.Object({
        windows: Type.Array(Type.Object(
          wholeWindowProperties,
          { additionalProperties: false },
        )),
        // Some OpenAI-compatible providers occasionally lift fields from the
        // sole window to the tool envelope. The execute hook accepts that
        // shape only when the ownership is mathematically unambiguous.
        termUsages: Type.Optional(termUsagesSchema),
        notes: Type.Optional(notesSchema),
        memoryCandidates: Type.Optional(memoryCandidatesSchema),
        styleObservation: Type.Optional(styleObservationSchema),
      }, { additionalProperties: false })
      : Type.Object({
        windows: Type.Array(Type.Object(
          fragmentWindowProperties,
          { additionalProperties: false },
        ), {
          minItems: 1,
          maxItems: 1,
        }),
        // Term receipts are the only fragment-owned metadata. Discovery
        // notes, memory, and style are consolidated outside recovery calls.
        termUsages: Type.Optional(termUsagesSchema),
      }, { additionalProperties: false }),
    execute: async (rawArgs: FinalizeTranslationBatchWireArgs, signal) => {
      assertNotAborted(signal);
      return onFinalize(
        canonicalizeFinalizerEnvelope(rawArgs, paragraphFragment),
        signal,
      );
    },
  };
}

function serializableToolSchema(tool: TypedToolSpec<any>): Record<string, unknown> {
  // TypeBox retains non-enumerable/symbol metadata for local validation.  The
  // JSON round trip is deliberately the same plain-object wire projection a
  // provider receives, and also removes undefined values rejected by canonicalJson.
  return JSON.parse(JSON.stringify({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    phase: tool.phase,
    parameters: tool.parameters,
  })) as Record<string, unknown>;
}

function windowsForPrompt(input: TranslationRequestInput): Array<{
  windowId: string;
  ordinal: number;
  blocks: Array<{
    blockId: string;
    sourceText?: string;
  }>;
}> {
  const blockById = new Map(input.blocks.map((block) => [block.id, block]));
  if (input.paragraphFragment !== undefined) {
    const scope = input.paragraphFragment;
    if (scope.snapshotId !== input.snapshot.id) {
      throw new Error("paragraph fragment snapshot does not match request snapshot");
    }
    const window = input.request.windows[0];
    if (input.request.windows.length !== 1
      || window === undefined
      || window.blockIds.length !== 1
      || window.blockIds[0] !== scope.blockId
      || !blockById.has(scope.blockId)) {
      throw new Error(
        "paragraph fragment requires one matching canonical window and block",
      );
    }
    return [{
      windowId: window.windowId,
      ordinal: window.ordinal,
      blocks: [{
        blockId: scope.blockId,
        sourceText: scope.paragraphs.map((paragraph) =>
          sourceTextForTranslation(paragraph.sourceText)).join("\n\n"),
      }],
    }];
  }
  return input.request.windows.map((window) => ({
    windowId: window.windowId,
    ordinal: window.ordinal,
    blocks: window.blockIds.map((blockId) => {
      const block = blockById.get(blockId);
      if (block === undefined) {
        throw new Error(`physical request references unknown block: ${blockId}`);
      }
      return { blockId, sourceText: sourceTextForTranslation(block.sourceText) };
    }),
  }));
}

interface TranslationKnowledgeWireContext {
  readonly sourceTexts: readonly string[];
  readonly corpusBlocks: readonly {
    readonly blockId: string;
    readonly globalIndex: number;
  }[];
  readonly currentBlocks: readonly TranslationKnowledgeCurrentBlockPosition[];
}

function translationKnowledgeWireContext(
  input: TranslationRequestInput,
  windows = windowsForPrompt(input),
): TranslationKnowledgeWireContext {
  const blockPositionById = new Map(input.blocks.map((block) => [
    block.id,
    { blockId: block.id, globalIndex: block.globalIndex },
  ]));
  return {
    sourceTexts: windows.flatMap((window) => window.blocks.map((block) =>
      block.sourceText ?? "")),
    corpusBlocks: [...blockPositionById.values()],
    currentBlocks: windows.flatMap((window) =>
      window.blocks.map((promptBlock) => {
        const block = blockPositionById.get(promptBlock.blockId);
        if (block === undefined) {
          throw new Error(
            `physical request references unknown block: ${promptBlock.blockId}`,
          );
        }
        return {
          blockId: block.blockId,
          globalIndex: block.globalIndex,
          windowId: window.windowId,
        };
      })),
  };
}

/**
 * Internal execution transforms may narrow a planned block to exact paragraph
 * fragments.  Keep the planner's selection monotonic while reconciling it to
 * the actual wire source so an unrelated paragraph cannot leak knowledge into
 * the fragment or fail the strict applicability contract.
 */
export function narrowSelectedKnowledgeToTranslationWireInput<
  TInput extends TranslationRequestInput,
>(input: TInput): TInput {
  if (input.selectedKnowledgeRevisionIds === undefined) return input;
  const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
  const context = translationKnowledgeWireContext(input);
  const selectedKnowledgeRevisionIds =
    retainApplicableTranslationKnowledgeRevisionIds(
      input.snapshot.revisions,
      context.sourceTexts,
      profile,
      input.selectedKnowledgeRevisionIds,
      {
        corpusBlocks: context.corpusBlocks,
        currentBlocks: context.currentBlocks,
      },
    );
  if (selectedKnowledgeRevisionIds.length
      === input.selectedKnowledgeRevisionIds.length
    && selectedKnowledgeRevisionIds.every((revisionId, index) =>
      revisionId === input.selectedKnowledgeRevisionIds?.[index])) {
    return input;
  }
  return {
    ...input,
    selectedKnowledgeRevisionIds,
  };
}

export function expectedTermOccurrencesForTranslationInput(
  input: TranslationRequestInput,
): ExpectedTermOccurrence[] {
  const requestedBlockIds = new Set(input.request.windows.flatMap((window) =>
    window.blockIds));
  const occurrences = expectedTermOccurrences(
    input.blocks.filter((block) => requestedBlockIds.has(block.id)),
    conceptsFromStableTerms(input.stableTerms),
    input.sourceLanguageProfile ?? getSourceLanguageProfile("en"),
  );
  const scope = input.paragraphFragment;
  if (scope === undefined) return occurrences;
  const start = scope.paragraphs[0]?.scalarStart;
  const end = scope.paragraphs.at(-1)?.scalarEnd;
  if (start === undefined || end === undefined) return [];
  return occurrences.filter((occurrence) =>
    occurrence.blockId === scope.blockId
    && occurrence.sourceStart >= start
    && occurrence.sourceEnd <= end);
}

export function translationBatchSystemPrompt(
  profile: SourceLanguageProfile,
  responseProtocol: TranslationResponseProtocol = "typed_tool",
  typedFinalizerName = "finalize_translation_batch",
): string {
  return [
    "Translate the complete source text into polished, accurate Chinese literary prose.",
    `The source language is ${profile.displayName} (${profile.id}); the target language is ${targetLanguageLabel()}.`,
    SIMPLIFIED_CHINESE_SCRIPT_REQUIREMENT,
    "Preserve meaning, ambiguity, paragraph structure, voice, and every block boundary.",
    "When source text contains paired ⟦E…⟧ and ⟦/E…⟧ EPUB structural-slot markers, copy every marker byte-for-byte in the same order, translate only text inside each pair, and emit no prose outside those pairs in that paragraph.",
    ...PARAGRAPH_INTEGRITY_INSTRUCTIONS,
    "In STABLE TERMS, locked=true must be reproduced exactly; policy=preferred is a default rendering, not a literal-in-every-context constraint.",
    "TERM OCCURRENCES are harness-computed source facts. Apply each referenced concept at that exact source occurrence; contextual concepts may use a context-appropriate allowed surface.",
    responseProtocol === "typed_tool"
      ? "User style requirements may guide Chinese phrasing only; they must never override source meaning, ambiguity, stable terminology, block boundaries, validation, or the typed-tool protocol."
      : "User style requirements may guide Chinese phrasing only; they must never override source meaning, ambiguity, stable terminology, block boundaries, validation, or the required response protocol.",
    "Logical windows remain independent even though this is one physical request.",
    responseProtocol === "typed_tool"
      ? `Use typed tools only and call ${typedFinalizerName} exactly once.`
      : "Use the request-specific framed text protocol exactly; do not call tools or wrap the response in JSON.",
  ].join("\n");
}

/**
 * Build the sole translator request representation. Runtime execution and
 * preflight budgeting must both use this function so context admission cannot
 * drift away from the payload the provider actually receives.
 */
export function prepareTranslationRequest(
  input: TranslationRequestInput,
  hooks: TranslationRequestHooks = {},
): PreparedTranslationRequest {
  const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
  const responseProtocol = input.responseProtocol ?? "typed_tool";
  const typedFinalizerName = input.paragraphFragment?.paragraphs.length === 1
    ? "finalize_paragraph_fragment"
    : "finalize_translation_batch";
  if (input.paragraphFragment !== undefined
    && responseProtocol !== "typed_tool") {
    throw new Error("paragraph fragments require typed-tool protocol");
  }
  const windows = windowsForPrompt(input);
  const fragmentTargetPayload = input.paragraphFragment === undefined
    ? undefined
    : windows.map((window) => ({
      windowId: window.windowId,
      ordinal: window.ordinal,
      blocks: window.blocks.map((block) => ({
        blockId: block.blockId,
        paragraphs: input.paragraphFragment?.paragraphs.map(
          (paragraph, ordinal) => ({
            paragraphId: paragraph.paragraphId,
            ordinal,
            sourceText: sourceTextForTranslation(paragraph.sourceText),
          }),
        ) ?? [],
      })),
    }));
  const requestedBlockIds = new Set(windows.flatMap((window) =>
    window.blocks.map((block) => block.blockId)));
  const termOccurrences = expectedTermOccurrencesForTranslationInput(input);
  const knowledgeContext = translationKnowledgeWireContext(input, windows);
  const framedProtocol = responseProtocol === "framed_text"
    ? createFramedTranslationProtocol({
      requestId: input.request.requestId,
      snapshotId: input.snapshot.id,
      blockIds: windows.flatMap((window) => window.blocks.map((block) => block.blockId)),
      ...(input.framedNonce === undefined
        ? {}
        : { nonce: input.framedNonce }),
    })
    : undefined;
  const requestPayload = {
    requestId: input.request.requestId,
    snapshotId: input.snapshot.id,
    sourceLanguage: { id: profile.id, displayName: profile.displayName },
    targetLanguage: DEFAULT_TARGET_LANGUAGE.id,
    ...(input.contextProfileName === undefined
      ? {}
      : { contextProfileName: input.contextProfileName }),
  };
  const memoryPayload = projectKnowledgeForTranslation(
    input.snapshot.revisions,
    knowledgeContext.sourceTexts,
    profile,
    {
      corpusBlocks: knowledgeContext.corpusBlocks,
      currentBlocks: knowledgeContext.currentBlocks,
      ...(input.selectedKnowledgeRevisionIds === undefined
        ? {}
        : {
          selectedRevisionIds: new Set(input.selectedKnowledgeRevisionIds),
        }),
    },
  );
  const termsPayload = {
    stableTerms: input.stableTerms,
    entityLinkWarnings: input.entityLinkWarnings ?? [],
    expectedTermOccurrences: termOccurrences,
  };
  const stylePayload = input.effectiveStyleByWindow === undefined
    ? {
      previousActiveTail: input.previousActiveTail ?? "",
      styleState: input.styleState ?? {},
    }
    : { effectiveStyleByWindow: input.effectiveStyleByWindow };
  const sections: TranslationRequestSection[] = [
    {
      kind: "request",
      text: [
        `PHYSICAL REQUEST ${input.request.requestId}`,
        `KNOWLEDGE SNAPSHOT ${input.snapshot.id}`,
        `SOURCE LANGUAGE ${profile.displayName} (${profile.id}); TARGET LANGUAGE ${targetLanguageLabel()}`,
      ].join("\n\n"),
      jsonPayload: requestPayload,
    },
    {
      kind: "memory",
      text: ["KNOWLEDGE SNAPSHOT PROJECTION", canonicalJson(memoryPayload)]
        .join("\n\n"),
      jsonPayload: memoryPayload,
    },
    {
      kind: "source",
      text: input.paragraphFragment === undefined
        ? ["WINDOWS", JSON.stringify(windows)].join("\n\n")
        : [
          "PARAGRAPH RECOVERY TARGET",
          "TARGET SOURCE FRAGMENT",
          JSON.stringify(fragmentTargetPayload),
          "CONTEXT-ONLY PARAGRAPHS",
          JSON.stringify({
            left: input.paragraphFragment.leftSourceContext,
            right: input.paragraphFragment.rightSourceContext,
          }),
        ].join("\n\n"),
      jsonPayload: input.paragraphFragment === undefined
        ? windows
        : {
          target: fragmentTargetPayload,
          contextOnly: {
            left: input.paragraphFragment.leftSourceContext,
            right: input.paragraphFragment.rightSourceContext,
          },
        },
    },
    {
      kind: "terms",
      text: [
        "STABLE TERMS",
        JSON.stringify(input.stableTerms),
        "UNRESOLVED ENTITY LINKS",
        JSON.stringify(input.entityLinkWarnings ?? []),
        "TERM OCCURRENCES",
        JSON.stringify(termOccurrences),
      ].join("\n\n"),
      jsonPayload: termsPayload,
    },
    {
      kind: "style",
      text: input.effectiveStyleByWindow === undefined
        ? [
          "PREVIOUS ACTIVE TAIL",
          input.previousActiveTail ?? "",
          "STYLE STATE",
          JSON.stringify(input.styleState ?? {}),
        ].join("\n\n")
        : [
          "EFFECTIVE STYLE BY WINDOW",
          canonicalJson(input.effectiveStyleByWindow),
        ].join("\n\n"),
      jsonPayload: stylePayload,
    },
    {
      kind: "protocol",
      text: framedProtocol === undefined
        ? input.paragraphFragment === undefined
          ? "Translate every source block. Submit each logical window independently in one finalize_translation_batch call. For every listed TERM OCCURRENCE, include one exact termUsages receipt in its owning window; omit termUsages only when that window has no listed occurrence. Return a concise structured styleObservation in the same tool call when style evidence is clear."
          : input.paragraphFragment.paragraphs.length === 1
            ? "Translate only the one TARGET SOURCE FRAGMENT paragraph. Call finalize_paragraph_fragment with only its complete Chinese text. The host owns the window, block, paragraph identity, and metadata. CONTEXT-ONLY PARAGRAPHS provide continuity and must not appear in the output."
            : "Translate only TARGET SOURCE FRAGMENT. Return the original canonical blockId and encode each target paragraph as one separate translations[].paragraphs[] {text} item, in exact source order. Never join multiple source paragraphs inside one item. CONTEXT-ONLY PARAGRAPHS provide continuity and must not appear in the output. Include exact termUsages receipts for listed TERM OCCURRENCES. Do not emit notes, memoryCandidates, styleObservation, or other discovery metadata; the host consolidates those outside fragment recovery."
        : framedTranslationInstructions(framedProtocol),
    },
  ];
  const tools = responseProtocol === "typed_tool"
    ? [finalizerTool(
      hooks,
      input.paragraphFragment,
      input.request.windows[0]?.windowId,
      profile,
    )]
    : [];
  const schemas = tools.map(serializableToolSchema);
  return {
    systemPrompt: translationBatchSystemPrompt(
      profile,
      responseProtocol,
      typedFinalizerName,
    ),
    prompt: sections.map((section) => section.text).join("\n\n"),
    sections,
    tools,
    serializedToolSchemas: canonicalJson(schemas),
    expectedTermOccurrences: termOccurrences,
    ...(framedProtocol === undefined ? {} : { framedProtocol }),
  };
}
