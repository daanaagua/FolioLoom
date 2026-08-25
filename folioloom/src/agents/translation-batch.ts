import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { V4Block } from "../domain/types.js";
import type { BudgetLedger } from "../kernel/budget.js";
import {
  completeTermUsagesFromTarget,
  inferTermUsages,
  validateTermUsages,
  type ExpectedTermOccurrence,
  type TermUsageSubmission,
} from "../knowledge/term-usage.js";
import type { LosslessBlock } from "../source/types.js";
import { normalizeTranslatedSceneSeparators } from "../source/layout-separators.js";
import { hasSemanticText } from "../text/semantic-text.js";
import {
  normalizeChineseQuoteTexts,
  normalizeChineseQuoteTextsAgainstSource,
} from "../style/chinese-quote-normalization.js";
import { simplifyChineseTranslation } from "../style/chinese-script-normalization.js";
import type { StyleObservationSubmission } from "../style/types.js";
import {
  sanitizeTranslationMemoryCandidates,
  type TranslationCandidate,
  type TranslationMemoryCandidate,
} from "../tools/candidate-collector.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import {
  PiRuntime,
  type PiAssistantResponseObservation,
  type PiRunResult,
} from "./pi-runtime.js";
import { Repairer } from "./repairer.js";
import {
  expectedTermOccurrencesForTranslationInput,
  prepareTranslationRequest,
  type FinalizeTranslationBatchArgs,
  type TranslationBatchSnapshot,
  type TranslationRequestInput,
} from "./translation-request.js";
import { TranslationValidator } from "../validators/translation-validator.js";
import { parseFramedTranslationResponse } from "./framed-translation-protocol.js";

export { translationBatchSystemPrompt } from "./translation-request.js";
export type {
  FinalizeTranslationBatchArgs,
  TranslationBatchSnapshot,
} from "./translation-request.js";

export interface TranslationBatchInput extends TranslationRequestInput {
  model: Model<any>;
  streamFn: StreamFn;
  thinkingLevel?: ThinkingLevel;
  repairRuntime?: {
    model: Model<any>;
    streamFn: StreamFn;
    thinkingLevel?: ThinkingLevel;
  };
  budget: BudgetLedger;
  signal?: AbortSignal;
  deadlineMs?: number;
  additionalValidationFailures?: (
    window: TranslationBatchWindowResult,
  ) => readonly ValidationFailure[];
  /** A window recovery epoch owns one shared credit; false forbids a model repair. */
  repairEnabled?: boolean;
  onProviderResponse?: (
    evidence: TranslationProviderResponseEvidence,
  ) => void | Promise<void>;
}

export interface TranslationProviderResponseEvidence
  extends PiAssistantResponseObservation {
  readonly requestId: string;
  readonly snapshotId: string;
  readonly responseProtocol: "typed_tool" | "framed_text";
  readonly executionUnitId?: string;
}

export interface TranslationBatchWindowResult {
  windowId: string;
  ordinal: number;
  status: "completed" | "completed_with_warnings" | "failed";
  translations: Array<{ blockId: string; text: string }>;
  paragraphs?: Array<{ paragraphId: string; text: string }>;
  termUsages: TermUsageSubmission[];
  notes: string[];
  memoryCandidates: TranslationMemoryCandidate[];
  styleObservation?: StyleObservationSubmission;
  error?: string;
}

export interface TranslationBatchResult {
  requestId: string;
  snapshotId: string;
  windows: TranslationBatchWindowResult[];
  responseErrors: string[];
  run: PiRunResult;
  repairRuns: PiRunResult[];
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function copyMemories(
  values: readonly TranslationMemoryCandidate[] | undefined,
): TranslationMemoryCandidate[] {
  return sanitizeTranslationMemoryCandidates(values).candidates;
}

function copyTermUsages(
  values: readonly TermUsageSubmission[] | undefined,
): TermUsageSubmission[] {
  return (values ?? []).map((usage) => ({ ...usage }));
}

function validateSubmission(
  input: TranslationBatchInput,
  submission: FinalizeTranslationBatchArgs | undefined,
): Pick<TranslationBatchResult, "windows" | "responseErrors"> {
  const expected = new Map(input.request.windows.map((window) => [window.windowId, window]));
  const blockById = new Map(input.blocks.map((block) => [block.id, block]));
  const entries = submission?.windows ?? [];
  const byWindow = new Map<string, FinalizeTranslationBatchArgs["windows"]>();
  const responseErrors: string[] = [];
  for (const entry of entries) {
    if (!expected.has(entry.windowId)) {
      responseErrors.push(`unknown windowId: ${entry.windowId}`);
      continue;
    }
    const grouped = byWindow.get(entry.windowId) ?? [];
    grouped.push(entry);
    byWindow.set(entry.windowId, grouped);
  }

  const windows = input.request.windows.map((window): TranslationBatchWindowResult => {
    const submitted = byWindow.get(window.windowId) ?? [];
    const failed = (error: string): TranslationBatchWindowResult => ({
      windowId: window.windowId,
      ordinal: window.ordinal,
      status: "failed",
      translations: [],
      termUsages: [],
      notes: [],
      memoryCandidates: [],
      error,
    });
    if (submitted.length === 0) {
      return failed(`missing window submission: ${window.windowId}`);
    }
    if (submitted.length > 1) {
      return failed(`duplicate windowId: ${window.windowId}`);
    }
    const candidate = submitted[0] as FinalizeTranslationBatchArgs["windows"][number];
    const paragraphScope = input.paragraphFragment;
    const expectedIds = new Set(window.blockIds);
    const seen = new Set<string>();
    const translations: Array<{ blockId: string; text: string }> = [];
    let paragraphTranslations:
      Array<{ paragraphId: string; text: string }> | undefined;
    for (const translation of candidate.translations) {
      const blockId = translation.blockId;
      if (!expectedIds.has(blockId) || !blockById.has(blockId)) {
        return failed(`unknown blockId for ${window.windowId}: ${translation.blockId}`);
      }
      if (seen.has(blockId)) {
        return failed(`duplicate blockId for ${window.windowId}: ${translation.blockId}`);
      }
      seen.add(blockId);
      if (!hasSemanticText(translation.text)) {
        return failed(`empty translation for block ${blockId}`);
      }
      if (paragraphScope !== undefined) {
        const targetParagraphs = translation.text
          .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
          .filter(hasSemanticText);
        if (targetParagraphs.length !== paragraphScope.paragraphs.length) {
          return failed(
            `paragraph count mismatch for ${paragraphScope.executionUnitId}: `
            + `expected ${paragraphScope.paragraphs.length}, `
            + `received ${targetParagraphs.length}`,
          );
        }
        paragraphTranslations = targetParagraphs.map((text, index) => ({
          paragraphId:
            (paragraphScope.paragraphs[index] as { paragraphId: string })
              .paragraphId,
          text,
        }));
      }
      translations.push({ blockId, text: translation.text });
    }
    const missing = window.blockIds.filter((blockId) => !seen.has(blockId));
    if (missing.length > 0 || candidate.translations.length !== window.blockIds.length) {
      return failed(`block set mismatch for ${window.windowId}: missing ${missing.join(", ")}`);
    }
    const memories = sanitizeTranslationMemoryCandidates(
      candidate.memoryCandidates as readonly unknown[] | undefined,
    );
    const notes = [...candidate.notes, ...memories.warnings];
    return {
      windowId: window.windowId,
      ordinal: window.ordinal,
      status: notes.length > 0 ? "completed_with_warnings" : "completed",
      translations,
      termUsages: copyTermUsages(candidate.termUsages),
      notes,
      memoryCandidates: memories.candidates,
      ...(paragraphTranslations === undefined
        ? {}
        : { paragraphs: paragraphTranslations }),
      ...(candidate.styleObservation === undefined
        ? {}
        : { styleObservation: structuredClone(candidate.styleObservation) }),
    };
  });
  const normalized = normalizeWindowTypography(
    windows,
    input.stableTerms.filter((term) => term.locked).map((term) => term.target),
    new Map(input.blocks.map((block) => [block.id, block.sourceText])),
  );
  const expectedOccurrences = termOccurrencesForInput(input);
  return {
    windows: normalized.map((window) => ({
      ...window,
      termUsages: completeTermUsagesFromTarget(
        expectedOccurrences.filter((occurrence) =>
          window.translations.some((translation) =>
            translation.blockId === occurrence.blockId)),
        window.termUsages,
        new Map(window.translations.map((translation) => [
          translation.blockId,
          translation.text,
        ])),
      ),
    })),
    responseErrors,
  };
}

function losslessAsV4(block: LosslessBlock): V4Block {
  return {
    id: block.id,
    legacyId: null,
    chapterId: block.structureId,
    chapterTitle: block.structureTitle,
    globalIndex: block.globalIndex,
    blockIndex: block.globalIndex,
    sourceText: block.sourceText,
    sourceHash: block.sourceHash,
    tokenCount: block.tokenCount,
  };
}

function candidateFor(window: TranslationBatchWindowResult): TranslationCandidate {
  return {
    translations: window.translations.map((item) => ({ ...item })),
    notes: [...window.notes],
    memoryCandidates: copyMemories(window.memoryCandidates),
    repaired: false,
  };
}

function termOccurrencesForInput(
  input: TranslationBatchInput,
): ExpectedTermOccurrence[] {
  return expectedTermOccurrencesForTranslationInput(input);
}

function validationSourceBlocks(
  input: TranslationBatchInput,
): LosslessBlock[] {
  const scope = input.paragraphFragment;
  if (scope === undefined) return [...input.blocks];
  return input.blocks.map((block) => block.id !== scope.blockId
    ? block
    : {
      ...block,
      sourceText: scope.paragraphs.map((paragraph) =>
        paragraph.sourceText).join("\n\n"),
      canonicalStart: scope.paragraphs[0]?.utf16Start
        ?? block.canonicalStart,
      canonicalEnd: scope.paragraphs.at(-1)?.utf16End
        ?? block.canonicalEnd,
    });
}

function termFailuresForWindow(
  window: TranslationBatchWindowResult,
  expected: readonly ExpectedTermOccurrence[],
): ValidationFailure[] {
  const expectedForWindow = expected.filter((occurrence) =>
    window.translations.some((translation) =>
      translation.blockId === occurrence.blockId));
  const targetByBlock = new Map(window.translations.map((translation) => [
    translation.blockId,
    translation.text,
  ]));
  const expectedById = new Map(expectedForWindow.map((occurrence) => [
    occurrence.occurrenceId,
    occurrence,
  ]));
  const submittedById = new Map(window.termUsages.map((usage) => [
    usage.occurrenceId,
    usage,
  ]));
  return validateTermUsages(
    expectedForWindow,
    window.termUsages,
    targetByBlock,
  ).map((failure) => {
    const occurrence = expectedById.get(failure.occurrenceId);
    const submitted = submittedById.get(failure.occurrenceId);
    return {
      code: failure.code,
      blockId: occurrence?.blockId ?? submitted?.blockId,
      message: [
        failure.code,
        `occurrence=${failure.occurrenceId}`,
        occurrence === undefined
          ? "the submitted occurrence is not in the harness projection"
          : `expected=${JSON.stringify(occurrence)}`,
      ].join("; "),
      repairable: true,
    };
  });
}

function normalizeWindowTypography(
  windows: readonly TranslationBatchWindowResult[],
  preservedTargetForms: readonly string[],
  sourceTextByBlockId: ReadonlyMap<string, string>,
): TranslationBatchWindowResult[] {
  return windows.map((window) => {
    const targetTexts = window.translations.map((translation) =>
      normalizeTranslatedSceneSeparators(
        translation.text,
        sourceTextByBlockId.get(translation.blockId),
      ));
    const sourceTexts = window.translations.map((translation) =>
      sourceTextByBlockId.get(translation.blockId));
    const normalizedTexts = targetTexts.map((targetText, index) => {
      const sourceText = sourceTexts[index];
      return sourceText === undefined
        ? normalizeChineseQuoteTexts([targetText]).texts[0] ?? targetText
        : normalizeChineseQuoteTextsAgainstSource([targetText], [sourceText]).texts[0]
          ?? targetText;
    });
    return {
      ...window,
      translations: window.translations.map((translation, index) => ({
        ...translation,
        text: simplifyChineseTranslation(
          normalizedTexts[index] ?? translation.text,
          preservedTargetForms,
        ),
      })),
      ...(window.paragraphs === undefined
        ? {}
        : {
          paragraphs: (() => {
            const normalized = simplifyChineseTranslation(
              normalizedTexts[0] ?? window.translations[0]?.text ?? "",
              preservedTargetForms,
            ).split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u);
            return normalized.length === window.paragraphs.length
              ? window.paragraphs.map((paragraph, index) => ({
                paragraphId: paragraph.paragraphId,
                text: normalized[index] ?? paragraph.text,
              }))
              : window.paragraphs;
          })(),
        }),
      termUsages: window.termUsages.map((usage) => ({
        ...usage,
        targetSurface: simplifyChineseTranslation(
          usage.targetSurface,
          preservedTargetForms,
        ),
      })),
    };
  });
}

function failureMessage(failures: readonly ValidationFailure[]): string {
  return failures.map((failure) => `${failure.code}: ${failure.message}`).join("; ");
}

function lastAssistantText(run: PiRunResult): string {
  const message = run.messages.findLast((item) =>
    "role" in item && item.role === "assistant");
  if (message === undefined || !("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object"
      && part !== null
      && "type" in part
      && part.type === "text"
      && "text" in part
      && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function framedSubmission(
  input: TranslationBatchInput,
  translations: readonly { blockId: string; text: string }[],
): FinalizeTranslationBatchArgs {
  const byId = new Map(translations.map((translation) => [translation.blockId, translation.text]));
  return {
    windows: input.request.windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blockIds.flatMap((blockId) => {
        const text = byId.get(blockId);
        return text === undefined ? [] : [{ blockId, text }];
      }),
      notes: [],
    })),
  };
}

async function validateAndRepair(
  input: TranslationBatchInput,
  initial: Pick<TranslationBatchResult, "windows" | "responseErrors">,
): Promise<Pick<TranslationBatchResult, "windows" | "responseErrors" | "repairRuns">> {
  const validator = new TranslationValidator();
  const validationBlocks = validationSourceBlocks(input);
  const blockById = new Map(validationBlocks.map((block) => [
    block.id,
    losslessAsV4(block),
  ]));
  const validationPolicy = {
    allowedLatinTokens: input.stableTerms.flatMap((term) => [
      term.sourceForm,
      term.canonicalSource,
    ]),
    requiredTerms: input.stableTerms.filter((term) => term.locked)
      .map((term) => ({ sourceForm: term.sourceForm, target: term.target })),
    sourceLanguageProfile: input.sourceLanguageProfile,
  };
  type InvalidWindow = {
    window: TranslationBatchWindowResult;
    blocks: V4Block[];
    failures: ValidationFailure[];
  };
  const blocksByWindowId = new Map(input.request.windows.map((window) => [
    window.windowId,
    window.blockIds.map((blockId) => blockById.get(blockId))
      .filter((block): block is V4Block => block !== undefined),
  ]));
  const invalidByWindowId = new Map<string, InvalidWindow>();
  const expectedOccurrences = termOccurrencesForInput(input);
  const addFailures = (
    window: TranslationBatchWindowResult,
    failures: readonly ValidationFailure[],
  ): void => {
    if (failures.length === 0) {
      return;
    }
    const previous = invalidByWindowId.get(window.windowId);
    const merged = [...(previous?.failures ?? []), ...failures];
    const unique = [...new Map(merged.map((failure) => [
      `${failure.code}\u0000${failure.blockId ?? ""}\u0000${failure.message}`,
      failure,
    ])).values()];
    invalidByWindowId.set(window.windowId, {
      window,
      blocks: blocksByWindowId.get(window.windowId) ?? [],
      failures: unique,
    });
  };
  for (const window of initial.windows) {
    if (window.status === "failed") {
      continue;
    }
    const blocks = blocksByWindowId.get(window.windowId) ?? [];
    const validation = validator.validate(blocks, candidateFor(window), validationPolicy);
    addFailures(window, [
      ...validation.failures,
      ...termFailuresForWindow(window, expectedOccurrences),
      ...(input.additionalValidationFailures?.(window) ?? []),
    ]);
  }
  const successfulWindows = initial.windows.filter((window) => window.status !== "failed");
  const successfulBlocks = successfulWindows.flatMap((window) =>
    blocksByWindowId.get(window.windowId) ?? []);
  const crossWindowValidation = validator.validateCrossBlockAlignment(
    successfulBlocks,
    {
      translations: successfulWindows.flatMap((window) => window.translations),
      notes: [],
      repaired: false,
    },
  );
  for (const failure of crossWindowValidation.failures) {
    const window = successfulWindows.find((candidate) =>
      candidate.translations.some((translation) => translation.blockId === failure.blockId));
    if (window !== undefined) {
      addFailures(window, [failure]);
    }
  }
  const invalid = [...invalidByWindowId.values()];
  if (invalid.length === 0) {
    return { ...initial, repairRuns: [] };
  }
  const invalidIds = new Set(invalid.map((item) => item.window.windowId));
  const failWithoutRepair = (
    prefix: string,
  ): Pick<
    TranslationBatchResult,
    "windows" | "responseErrors" | "repairRuns"
  > => ({
    responseErrors: initial.responseErrors,
    repairRuns: [],
    windows: initial.windows.map((window) => {
      const item = invalidByWindowId.get(window.windowId);
      return item === undefined
        ? window
        : {
          ...window,
          status: "failed" as const,
          translations: [],
          termUsages: [],
          memoryCandidates: [],
          error: `${prefix}: ${failureMessage(item.failures)}`,
        };
    }),
  });
  const shapeCollapse = invalid.some((item) => {
    const codes = new Set(item.failures.map((failure) => failure.code));
    return codes.has("paragraph_count_incompatible")
      && (
        codes.has("abnormal_block_shortening")
        || codes.has("abnormal_shortening")
        || codes.has("insufficient_lexical_content")
      );
  });
  if (shapeCollapse) {
    return failWithoutRepair("shape collapse");
  }
  if (input.repairEnabled === false) {
    return failWithoutRepair("validation failed without targeted repair");
  }

  const repairBlockIds = new Set<string>();
  for (const item of invalid) {
    for (const failure of item.failures) {
      if (failure.blockId !== undefined) {
        repairBlockIds.add(failure.blockId);
      } else {
        item.blocks.forEach((block) => repairBlockIds.add(block.id));
      }
    }
  }
  const repairBlocks = [...repairBlockIds].map((blockId) => blockById.get(blockId))
    .filter((block): block is V4Block => block !== undefined)
    .sort((left, right) => left.globalIndex - right.globalIndex);
  const failedTranslations = invalid.flatMap((item) => item.window.translations)
    .filter((translation) => repairBlockIds.has(translation.blockId));
  const failures = invalid.flatMap((item) => item.failures);
  let repair: Awaited<ReturnType<Repairer["repairBatch"]>>;
  try {
    const repairRuntime = input.repairRuntime ?? {
      model: input.model,
      streamFn: input.streamFn,
      thinkingLevel: input.thinkingLevel,
    };
    repair = await new Repairer(new PiRuntime()).repairBatch({
      blocks: repairBlocks,
      failedCandidate: {
        translations: failedTranslations,
        notes: [],
        repaired: false,
      },
      failures,
      budget: input.budget,
      model: repairRuntime.model,
      streamFn: repairRuntime.streamFn,
      thinkingLevel: repairRuntime.thinkingLevel,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
      onAssistantResponse: input.onProviderResponse === undefined
        ? undefined
        : (observation) => input.onProviderResponse?.({
          ...observation,
          requestId: input.request.requestId,
          snapshotId: input.snapshot.id,
          responseProtocol: input.responseProtocol ?? "typed_tool",
          ...(input.paragraphFragment === undefined
            ? {}
            : {
              executionUnitId:
                input.paragraphFragment.executionUnitId,
            }),
        }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      responseErrors: initial.responseErrors,
      repairRuns: [],
      windows: initial.windows.map((window) => invalidIds.has(window.windowId)
        ? {
          ...window,
          status: "failed" as const,
          translations: [],
          termUsages: [],
          memoryCandidates: [],
          error: `targeted repair failed: ${message}`,
        }
        : window),
    };
  }
  const patchById = new Map(repair.candidate?.translations.map((item) => [
    item.blockId,
    item,
  ]) ?? []);
  const invalidById = new Map(invalid.map((item) => [item.window.windowId, item]));
  const patchedWindows = initial.windows.map((window): TranslationBatchWindowResult => {
    const item = invalidById.get(window.windowId);
    if (item === undefined) {
      return window;
    }
    const repairedWindow: TranslationBatchWindowResult = {
      ...window,
      translations: window.translations.map((translation) => ({
        ...(patchById.get(translation.blockId) ?? translation),
      })),
    };
    const repairedBlockIds = new Set(repairBlocks.map((block) => block.id));
    repairedWindow.termUsages = [
      ...window.termUsages.filter((usage) => !repairedBlockIds.has(usage.blockId)),
      ...inferTermUsages(
        expectedOccurrences.filter((occurrence) =>
          repairedBlockIds.has(occurrence.blockId)),
        new Map(repairedWindow.translations.map((translation) => [
          translation.blockId,
          translation.text,
        ])),
      ),
    ];
    delete repairedWindow.styleObservation;
    return repairedWindow;
  });
  const windows = normalizeWindowTypography(
    patchedWindows,
    input.stableTerms.filter((term) => term.locked).map((term) => term.target),
    new Map(validationBlocks.map((block) => [block.id, block.sourceText])),
  );
  const validatedWindows = windows.map((window): TranslationBatchWindowResult => {
    const item = invalidById.get(window.windowId);
    if (item === undefined || window.status === "failed") {
      return window;
    }
    const validation = validator.validate(
      item.blocks,
      candidateFor(window),
      validationPolicy,
    );
    const termFailures = termFailuresForWindow(window, expectedOccurrences);
    const additionalFailures =
      input.additionalValidationFailures?.(window) ?? [];
    if (validation.valid
      && termFailures.length === 0
      && additionalFailures.length === 0) {
      return window;
    }
    return {
      ...window,
      status: "failed",
      translations: [],
      termUsages: [],
      memoryCandidates: [],
      error: `validation failed after one targeted repair: ${
        failureMessage([
          ...validation.failures,
          ...termFailures,
          ...additionalFailures,
        ])
      }`,
    };
  });
  const postRepairWindows = validatedWindows.filter((window) => window.status !== "failed");
  const postRepairCrossValidation = validator.validateCrossBlockAlignment(
    postRepairWindows.flatMap((window) => blocksByWindowId.get(window.windowId) ?? []),
    {
      translations: postRepairWindows.flatMap((window) => window.translations),
      notes: [],
      repaired: true,
    },
  );
  const postRepairFailures = new Map<string, ValidationFailure[]>();
  for (const failure of postRepairCrossValidation.failures) {
    const failures = postRepairFailures.get(failure.blockId ?? "") ?? [];
    failures.push(failure);
    postRepairFailures.set(failure.blockId ?? "", failures);
  }
  const finalWindows = validatedWindows.map((window): TranslationBatchWindowResult => {
    const failures = window.translations.flatMap((translation) =>
      postRepairFailures.get(translation.blockId) ?? []);
    if (failures.length === 0 || window.status === "failed") {
      return window;
    }
    return {
      ...window,
      status: "failed",
      translations: [],
      termUsages: [],
      memoryCandidates: [],
      error: `cross-block validation failed after one targeted repair: ${failureMessage(failures)}`,
    };
  });
  return {
    windows: finalWindows,
    responseErrors: initial.responseErrors,
    repairRuns: [repair.run],
  };
}

export async function validateTranslationBatchCandidate(
  input: TranslationBatchInput,
  initial: Pick<TranslationBatchResult, "windows" | "responseErrors">,
): Promise<Pick<
  TranslationBatchResult,
  "windows" | "responseErrors" | "repairRuns"
>> {
  return validateAndRepair(
    { ...input, repairEnabled: false },
    initial,
  );
}

export async function runTranslationBatch(
  input: TranslationBatchInput,
): Promise<TranslationBatchResult> {
  nonempty(input.request.requestId, "requestId");
  nonempty(input.snapshot.id, "snapshotId");
  let submission: FinalizeTranslationBatchArgs | undefined;
  let duplicateTerminalCalls = 0;
  const responseProtocol = input.responseProtocol ?? "typed_tool";
  const prepared = prepareTranslationRequest(input, {
    onFinalize: async (args) => {
      if (submission !== undefined) {
        duplicateTerminalCalls += 1;
        return { accepted: true };
      }
      input.budget.consume("translationToolCalls", 1);
      submission = structuredClone(args);
      return { accepted: true };
    },
  });
  const run = await new PiRuntime().run({
    systemPrompt: prepared.systemPrompt,
    prompt: prepared.prompt,
    phase: "translation",
    model: input.model,
    tools: prepared.tools,
    budget: input.budget,
    terminateTools: responseProtocol === "typed_tool"
      ? prepared.tools.map((tool) => tool.name)
      : [],
    // A malformed typed-tool call gets one corrective turn. More turns have no
    // new evidence and only turn a provider-format error into a long stall.
    maxTurns: responseProtocol === "typed_tool" ? 2 : 1,
    signal: input.signal,
    deadlineMs: input.deadlineMs,
    thinkingLevel: input.thinkingLevel,
    onAssistantResponse: input.onProviderResponse === undefined
      ? undefined
      : (observation) => input.onProviderResponse?.({
        ...observation,
        requestId: input.request.requestId,
        snapshotId: input.snapshot.id,
        responseProtocol,
        ...(input.paragraphFragment === undefined
          ? {}
          : {
            executionUnitId: input.paragraphFragment.executionUnitId,
          }),
      }),
  }, input.streamFn);
  const framedErrors: string[] = [];
  if (responseProtocol === "framed_text") {
    input.budget.consume("translationToolCalls", 1);
    const protocol = prepared.framedProtocol;
    if (protocol === undefined) {
      framedErrors.push("framed response protocol was not prepared");
    } else {
      const parsed = parseFramedTranslationResponse(lastAssistantText(run), protocol);
      framedErrors.push(...parsed.errors);
      if (parsed.errors.length === 0) {
        submission = framedSubmission(input, parsed.translations);
      }
    }
  }
  const validated = validateSubmission(input, submission);
  validated.responseErrors.push(...framedErrors);
  if (duplicateTerminalCalls > 0) {
    validated.responseErrors.push(
      `multiple terminating submissions rejected: ${duplicateTerminalCalls + 1}`,
    );
  }
  const checked = await validateAndRepair(input, validated);
  return {
    requestId: input.request.requestId,
    snapshotId: input.snapshot.id,
    ...checked,
    run,
  };
}
