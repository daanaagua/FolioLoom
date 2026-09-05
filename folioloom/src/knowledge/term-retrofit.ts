import { createHash } from "node:crypto";

import type { SourceLanguageProfile } from "../language/types.js";
import type { TermUsageSubmission } from "./term-usage.js";
import { canonicalJson } from "./knowledge-store.js";
import { matchKnowledgeImpacts } from "./knowledge-impact-matcher.js";
import {
  ruleAppliesToBlock,
  type TermRenderingRule,
} from "./term-rendering-rule.js";

export type TermRetrofitClassification =
  | "noop"
  | "local_repair"
  | "model_retranslate"
  | "human_required";

export interface TermRetrofitSourceBlock {
  readonly blockId: string;
  readonly sourceVersion: string;
  readonly globalIndex: number;
  readonly sourceText: string;
  readonly translationId: number;
  readonly translationText: string;
  readonly termUsages: readonly TermUsageSubmission[];
}

export interface TermRetrofitPlanItem {
  readonly ordinal: number;
  readonly blockId: string;
  readonly sourceVersion: string;
  readonly globalIndex: number;
  readonly translationId: number;
  readonly classification: TermRetrofitClassification;
  readonly receiptConceptId?: string;
  readonly replacementText?: string;
  readonly reason: string;
}

export interface TermRetrofitPlan {
  readonly schema: "folioloom-term-retrofit-plan-1";
  readonly runId: string;
  readonly ruleRevisionId: string;
  readonly baseGeneration: number;
  readonly baseSnapshotId: string;
  readonly planHash: string;
  readonly items: readonly TermRetrofitPlanItem[];
  readonly summary: {
    readonly total: number;
    readonly noop: number;
    readonly localRepair: number;
    readonly modelRetranslate: number;
    readonly humanRequired: number;
  };
}

export interface PlanTermRetrofitInput {
  readonly runId: string;
  readonly ruleRevisionId: string;
  readonly baseGeneration: number;
  readonly baseSnapshotId: string;
  readonly rule: TermRenderingRule;
  readonly blocks: readonly TermRetrofitSourceBlock[];
  readonly profile: SourceLanguageProfile;
}

function normalized(value: string, profile: SourceLanguageProfile): string {
  return profile.normalizeSourceForm(value);
}

interface TargetSpan { start: number; end: number }

function spans(text: string, surface: string): TargetSpan[] {
  const result: TargetSpan[] = [];
  if (surface.length === 0) return result;
  // Advance by one, not surface.length: self-overlapping matches are ambiguous.
  for (let start = text.indexOf(surface); start !== -1;
    start = text.indexOf(surface, start + 1)) {
    result.push({ start, end: start + surface.length });
  }
  return result;
}

function overlaps(left: TargetSpan, right: TargetSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function classify(
  block: TermRetrofitSourceBlock,
  rule: TermRenderingRule,
  profile: SourceLanguageProfile,
): Omit<TermRetrofitPlanItem, "ordinal"> {
  const forms = new Set(rule.sourceForms.map((form) => normalized(form, profile)));
  const usages = block.termUsages.filter((usage) =>
    usage.blockId === block.blockId
    && forms.has(normalized(usage.sourceForm, profile)));
  if (usages.length === 0) {
    return {
      blockId: block.blockId,
      sourceVersion: block.sourceVersion,
      globalIndex: block.globalIndex,
      translationId: block.translationId,
      classification: "model_retranslate",
      reason: "missing_term_usage_receipt",
    };
  }
  const receiptConceptIds = [...new Set(usages.map((usage) => usage.conceptId))];
  if (receiptConceptIds.length !== 1) {
    return {
      blockId: block.blockId,
      sourceVersion: block.sourceVersion,
      globalIndex: block.globalIndex,
      translationId: block.translationId,
      classification: "model_retranslate",
      reason: "source_form_has_multiple_concept_receipts",
    };
  }
  const receiptConceptId = receiptConceptIds[0]!;
  if (usages.every((usage) =>
    rule.allowedTargets.includes(usage.targetSurface)
    && block.translationText.includes(usage.targetSurface))) {
    return {
      blockId: block.blockId,
      sourceVersion: block.sourceVersion,
      globalIndex: block.globalIndex,
      translationId: block.translationId,
      classification: "noop",
      receiptConceptId,
      reason: "all_recorded_surfaces_already_allowed",
    };
  }
  const disallowed = usages.filter((usage) =>
    !rule.allowedTargets.includes(usage.targetSurface));
  const counts = new Map<string, number>();
  for (const usage of disallowed) {
    counts.set(usage.targetSurface, (counts.get(usage.targetSurface) ?? 0) + 1);
  }
  const matches = [...counts].map(([surface, count]) => ({
    surface, count, spans: spans(block.translationText, surface),
  }));
  const patches = matches.flatMap((match) => match.spans)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const protectedSurfaces = new Set([
    ...rule.allowedTargets,
    ...block.termUsages.filter((usage) => !disallowed.includes(usage))
      .map((usage) => usage.targetSurface),
  ]);
  const protectedSpans = [...protectedSurfaces]
    .flatMap((surface) => spans(block.translationText, surface));
  const exact = rule.policy === "locked"
    && matches.length > 0
    && matches.every((match) => match.surface.length > 0 && match.spans.length === match.count)
    && patches.every((patch, index) =>
      (index === 0 || !overlaps(patches[index - 1]!, patch))
      && !protectedSpans.some((protectedSpan) => overlaps(patch, protectedSpan)));
  if (!exact) {
    return {
      blockId: block.blockId,
      sourceVersion: block.sourceVersion,
      globalIndex: block.globalIndex,
      translationId: block.translationId,
      classification: "model_retranslate",
      reason: "target_surface_is_ambiguous_or_contextual",
    };
  }
  // All offsets belong to the original text. Inserted text is never scanned.
  const parts: string[] = [];
  let cursor = 0;
  for (const patch of patches) {
    parts.push(block.translationText.slice(cursor, patch.start), rule.target);
    cursor = patch.end;
  }
  parts.push(block.translationText.slice(cursor));
  const replacementText = parts.join("");
  if (replacementText.split(/\r?\n/u).length
    !== block.translationText.split(/\r?\n/u).length) {
    return {
      blockId: block.blockId,
      sourceVersion: block.sourceVersion,
      globalIndex: block.globalIndex,
      translationId: block.translationId,
      classification: "model_retranslate",
      reason: "local_repair_changes_paragraph_shape",
    };
  }
  return {
    blockId: block.blockId,
    sourceVersion: block.sourceVersion,
    globalIndex: block.globalIndex,
    translationId: block.translationId,
    classification: "local_repair",
    receiptConceptId,
    replacementText,
    reason: "receipt_backed_unique_surface",
  };
}

export function planTermRetrofit(input: PlanTermRetrofitInput): TermRetrofitPlan {
  if (!Number.isSafeInteger(input.baseGeneration) || input.baseGeneration < 0) {
    throw new TypeError("baseGeneration must be a non-negative safe integer");
  }
  const inRange = input.blocks.filter((block) =>
    ruleAppliesToBlock(input.rule, {
      sourceVersion: block.sourceVersion,
      blockId: block.blockId,
      globalIndex: block.globalIndex,
    }));
  const matched = new Set(matchKnowledgeImpacts(
    [{ revisionId: input.ruleRevisionId, forms: input.rule.sourceForms }],
    inRange.map((block) => ({
      sourceVersion: block.sourceVersion,
      blockId: block.blockId,
      sourceText: block.sourceText,
    })),
    input.profile,
  ).map((item) => item.blockId));
  const items = inRange
    .filter((block) => matched.has(block.blockId))
    .sort((left, right) =>
      left.globalIndex - right.globalIndex
      || left.blockId.localeCompare(right.blockId, "und"))
    .map((block, ordinal): TermRetrofitPlanItem => ({
      ordinal,
      ...classify(block, input.rule, input.profile),
    }));
  const summary = {
    total: items.length,
    noop: items.filter((item) => item.classification === "noop").length,
    localRepair: items.filter((item) => item.classification === "local_repair").length,
    modelRetranslate:
      items.filter((item) => item.classification === "model_retranslate").length,
    humanRequired:
      items.filter((item) => item.classification === "human_required").length,
  };
  const identity = {
    schema: "folioloom-term-retrofit-plan-1",
    runId: input.runId,
    ruleRevisionId: input.ruleRevisionId,
    baseGeneration: input.baseGeneration,
    baseSnapshotId: input.baseSnapshotId,
    rule: input.rule,
    items: items.map((item) => ({
      ordinal: item.ordinal,
      blockId: item.blockId,
      sourceVersion: item.sourceVersion,
      globalIndex: item.globalIndex,
      translationId: item.translationId,
      classification: item.classification,
      receiptConceptId: item.receiptConceptId ?? null,
      reason: item.reason,
      replacementHash: item.replacementText === undefined
        ? null
        : sha256(item.replacementText),
    })),
    summary,
  } as const;
  return Object.freeze({
    ...identity,
    planHash: sha256(canonicalJson(identity)),
    items: Object.freeze(items),
    summary: Object.freeze(summary),
  });
}
