import {
  prepareLexicalAnchorRequest,
  type AnchorCandidate,
  type LexicalAnchorInput,
  type LexicalAnchorResponseProtocol,
} from "../agents/lexical-anchorer.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { WeightedTokenEstimator } from "../source/token-estimator.js";
import {
  BudgetOracle,
  coldStartReasoningUpperBound,
  type BudgetOracleAssessment,
} from "./budget-oracle.js";
import type { TranslationRuntime } from "./types.js";

export type LexicalAnchorBudgetComponentKind =
  | "system"
  | "request"
  | "tool_schemas";

export interface LexicalAnchorBudgetAssessment {
  readonly protocol: LexicalAnchorResponseProtocol;
  readonly assessment: BudgetOracleAssessment<LexicalAnchorBudgetComponentKind>;
  readonly totalReserved: number;
}

function conservativeTarget(candidate: AnchorCandidate): string {
  return candidate.sourceAuthoredTarget ?? "示例中文译名";
}

function visibleOutputFixture(
  input: Pick<LexicalAnchorInput, "candidates">,
  protocol: LexicalAnchorResponseProtocol,
): string {
  if (protocol === "framed_text") {
    return JSON.stringify(input.candidates.map((candidate) => ({
      sourceForm: candidate.sourceForm,
      target: conservativeTarget(candidate),
      semanticClass: candidate.likelyProperName === true
        ? "proper_name"
        : "technical_term",
      confidence: 0.95,
    })));
  }
  return JSON.stringify({
    anchors: input.candidates.map((candidate) => ({
      sourceForm: candidate.sourceForm,
      target: conservativeTarget(candidate),
      mode: candidate.likelyProperName === true ? "stable" : "contextual",
      semanticClass: candidate.likelyProperName === true
        ? "proper_name"
        : "unclassified",
      confidence: 0.95,
    })),
    entityLinks: [],
  });
}

export function assessLexicalAnchorAttempt(
  input: Pick<
    LexicalAnchorInput,
    "candidates" | "stableTerms" | "sourceLanguageProfile"
  >,
  runtime: TranslationRuntime,
  estimator: WeightedTokenEstimator,
  protocol: LexicalAnchorResponseProtocol,
): LexicalAnchorBudgetAssessment {
  const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
  const prepared = prepareLexicalAnchorRequest(input, protocol);
  const outputEstimate = estimator.estimateText(
    visibleOutputFixture(input, protocol),
    profile,
    { modelId: runtime.model.id },
  );
  const reasoningUpperBound = coldStartReasoningUpperBound(
    runtime.model.maxTokens,
    runtime.effort ?? runtime.thinkingLevel,
  );
  const visibleOutputUpperBound = Math.min(
    Math.max(
      256,
      Math.ceil(outputEstimate.tokens)
        + Math.ceil(outputEstimate.uncertainty ?? 0),
    ),
    Math.max(0, runtime.model.maxTokens - reasoningUpperBound),
  );
  const assessment = new BudgetOracle(estimator, {
    modelId: runtime.model.id,
    contextWindowTokens: runtime.model.contextWindow,
    maxCompletionTokens: runtime.model.maxTokens,
    visibleOutputUpperBound,
    reasoningUpperBound,
    safetyMarginTokens: Math.max(
      512,
      Math.ceil(runtime.model.contextWindow * 0.02),
    ),
  }).assess<LexicalAnchorBudgetComponentKind>([
    {
      kind: "system",
      text: prepared.systemPrompt,
    },
    {
      kind: "request",
      text: prepared.prompt,
      jsonPayload: {
        candidates: input.candidates,
        stableTerms: input.stableTerms.map((term) => ({
          sourceForm: term.sourceForm,
          target: term.target,
        })),
      },
    },
    {
      kind: "tool_schemas",
      text: prepared.serializedToolSchemas,
      jsonPayload: prepared.toolSchemaPayload,
    },
  ], profile);
  return {
    protocol,
    assessment,
    totalReserved: assessment.totalReservation,
  };
}
