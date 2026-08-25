import { createHash } from "node:crypto";

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { StableTerm, V4Block } from "../domain/types.js";
import {
  entityLinkAsTerms,
  evaluateEntityLink,
  type EntityLink,
  type EntityLinkEvidenceKind,
} from "../domain/entity-links.js";
import type { BudgetLedger } from "../kernel/budget.js";
import {
  conceptFromAnchor,
  type LexicalSemanticClass,
} from "../knowledge/lexical-concept.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { sourceTextForTranslation } from "../source/layout-separators.js";
import { simplifyChineseTranslation } from "../style/chinese-script-normalization.js";
import { assertNotAborted, Type, type TypedToolSpec } from "../tools/tool-spec.js";
import {
  ModelProviderError,
  PiRuntime,
  type PiAssistantResponseObservation,
  type PiRunResult,
} from "./pi-runtime.js";

export interface AnchorCandidate {
  sourceForm: string;
  sourceAuthoredTarget?: string;
  likelyProperName?: boolean;
  contexts: string[];
  corpusFrequency?: number;
  currentWaveOccurrences?: number;
  documentFrequency?: number;
  morphologyDiversity?: number;
}

export type LexicalAnchorSemanticClass =
  | "proper_name"
  | "unique_title"
  | "technical_term"
  | "role"
  | "form_of_address"
  | "ordinary_word"
  | "unclassified";

export interface LexicalAnchor {
  sourceForm: string;
  target: string;
  mode: "stable" | "contextual";
  semanticClass?: LexicalAnchorSemanticClass;
  lockEligible?: boolean;
  confidence: number;
}

export interface LexicalAnchorInput {
  candidates: readonly AnchorCandidate[];
  stableTerms: readonly StableTerm[];
  model: Model<any>;
  streamFn: StreamFn;
  budget: BudgetLedger;
  sourceLanguageProfile?: SourceLanguageProfile;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  deadlineMs?: number;
  onAssistantResponse?: (
    observation: PiAssistantResponseObservation,
  ) => void | Promise<void>;
}

export interface LexicalAnchorOutcome {
  anchors: LexicalAnchor[];
  entityLinks: EntityLink[];
  terms: StableTerm[];
  run: PiRunResult;
}

export interface LexicalPreferredFallbackProtocol {
  nonce: string;
  beginLine: string;
  endLine: string;
}

export type LexicalAnchorResponseProtocol = "typed_tool" | "framed_text";

export interface PreparedLexicalAnchorRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly serializedToolSchemas: string;
  readonly toolSchemaPayload: readonly Record<string, unknown>[];
  readonly fallbackProtocol?: LexicalPreferredFallbackProtocol;
}

type LexicalPreferredFallbackResult = Pick<
  LexicalAnchorOutcome,
  "anchors" | "entityLinks" | "terms"
>;

const PREFERRED_FALLBACK_CLASSES = new Set<LexicalAnchorSemanticClass>([
  "proper_name",
  "unique_title",
  "technical_term",
  "role",
]);

const CONCEPT_ELIGIBLE_CLASSES = new Set<LexicalAnchorSemanticClass>([
  "proper_name",
  "unique_title",
  "technical_term",
  "role",
]);

function hasIndependentConceptEvidence(
  anchor: LexicalAnchor,
  candidate: AnchorCandidate | undefined,
): boolean {
  if (candidate?.sourceAuthoredTarget !== undefined) return true;
  if (anchor.confidence < 0.9 || candidate === undefined) return false;
  const semanticClass = anchor.semanticClass ?? "unclassified";
  if (semanticClass === "proper_name" || semanticClass === "unique_title") {
    return candidate.likelyProperName === true;
  }
  if (semanticClass === "technical_term" || semanticClass === "role") {
    return (candidate.corpusFrequency ?? 0) >= 3
      && (candidate.currentWaveOccurrences ?? 0) >= 2
      && (candidate.documentFrequency ?? 0) >= 1;
  }
  return false;
}

function lexicalAnchorParameters() {
  return Type.Object({
    anchors: Type.Array(Type.Object({
      sourceForm: Type.String(),
      target: Type.String(),
      mode: Type.Union([Type.Literal("stable"), Type.Literal("contextual")]),
      semanticClass: Type.Union([
        Type.Literal("proper_name"),
        Type.Literal("unique_title"),
        Type.Literal("technical_term"),
        Type.Literal("role"),
        Type.Literal("form_of_address"),
        Type.Literal("ordinary_word"),
        Type.Literal("unclassified"),
      ]),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
    }), { maxItems: 24 }),
    entityLinks: Type.Optional(Type.Array(Type.Object({
      sourceForms: Type.Array(Type.String(), { minItems: 2, maxItems: 4 }),
      proposedTarget: Type.String(),
      evidenceKind: Type.Union([
        Type.Literal("explicit_naming"),
        Type.Literal("apposition"),
        Type.Literal("contextual_compatibility"),
        Type.Literal("distributional_compatibility"),
      ]),
      evidenceQuote: Type.String(),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
    }, { additionalProperties: false }), { maxItems: 6 })),
  });
}

function serializableLexicalAnchorToolSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    name: "submit_lexical_anchors",
    label: "Submit lexical anchors",
    description:
      "Classify every supplied source-language form and bind only context-invariant forms to one Chinese target.",
    phase: "translation",
    parameters: lexicalAnchorParameters(),
  })) as Record<string, unknown>;
}

export function prepareLexicalAnchorRequest(
  input: Pick<
    LexicalAnchorInput,
    "candidates" | "stableTerms" | "sourceLanguageProfile"
  >,
  responseProtocol: LexicalAnchorResponseProtocol,
): PreparedLexicalAnchorRequest {
  const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
  if (responseProtocol === "framed_text") {
    const protocol = createLexicalPreferredFallbackProtocol(
      input.candidates,
      profile,
    );
    return {
      systemPrompt: [
        "You recover a small set of safe run-local lexical preferences when structured tool calls are unavailable.",
        `The source language is ${profile.displayName} (${profile.id}).`,
        "Return only proper names, unique titles, and invariant technical terms that can safely keep one concise Simplified-Chinese rendering across the supplied contexts.",
        "Omit ordinary words, forms of address, relationship labels, ambiguous forms, and anything below 0.8 confidence. Omission means undecided and is safer than guessing.",
        "Every proper-name or unique-title target must be a usable Chinese rendering containing Chinese characters. When no Hanja/Chinese spelling is printed, choose one conservative Chinese transliteration; never copy Hangul, hiragana, or katakana into target.",
        "For sourceAuthoredTarget, copy that printed Hanja/Chinese target exactly; the harness will normalize its Chinese script.",
        "Do not infer aliases or entity identity in this compatibility path. Every returned binding is only a preferred rendering, never a hard constraint.",
        "Inside the exact response frame, emit one JSON array and nothing else. Each item must contain exactly sourceForm, target, semanticClass, and confidence.",
        "semanticClass must be proper_name, unique_title, technical_term, or role. Use role for a profession, office, or institutional function whose Chinese wording may vary by sentence. confidence must be from 0.8 through 1.",
      ].join("\n"),
      prompt: [
        "CANDIDATES AND COMPACT CONCORDANCE",
        JSON.stringify(input.candidates),
        "ESTABLISHED TERMS (do not duplicate or contradict)",
        input.stableTerms.map((term) =>
          `${term.sourceForm} => ${term.target}`).join("\n") || "(none)",
        "EXACT RESPONSE FRAME",
        protocol.beginLine,
        "[{\"sourceForm\":\"...\",\"target\":\"...\",\"semanticClass\":\"proper_name\",\"confidence\":0.9}]",
        protocol.endLine,
      ].join("\n\n"),
      serializedToolSchemas: "[]",
      toolSchemaPayload: [],
      fallbackProtocol: protocol,
    };
  }
  const toolSchemaPayload = [serializableLexicalAnchorToolSchema()];
  return {
    systemPrompt: [
      "You establish run-local lexical anchors before parallel literary translation.",
      `The source language is ${profile.displayName} (${profile.id}).`,
      "Mark proper names, unique titles, and invariant technical terms as stable and choose one concise Chinese target. Classify professions, offices, and institutional functions as role; give their concise default Chinese rendering and normally mark them contextual.",
      "For every anchor, classify semanticClass. Use proper_name only for a concrete named entity; common nouns, pronouns, verbs, and forms of address must use their corresponding non-name class.",
      "A sourceAuthoredTarget is an explicit Hanja/Chinese gloss printed immediately after that source form. For a stable proper name, unique title, or technical term, use that target exactly; the harness treats this source-authored evidence as authoritative.",
      "Every single-pass lexical classification remains a preference; only independently confirmed entity links or user-supplied glossary policy may become exact constraints.",
      "Write every Chinese target in Simplified Chinese (zh-Hans); the harness will normalize model-created targets before persistence.",
      "Mark ordinary words and forms of address as contextual. A role may also be contextual while remaining translator-visible semantic knowledge.",
      "Do not force surface consistency where Chinese grammar or relationship context requires variation.",
      "When compact evidence explicitly links two supplied forms to one entity, submit an entityLinks item and quote the exact supplied context. Leave uncertain relationships unconfirmed.",
      "Quote the smallest source span containing every linked form and any overt naming cue. Links from this single pass remain provisional until independent evidence accumulates; never treat one model judgment as an exact constraint.",
      "For entityLinks, proposedTarget must be the concise canonical Chinese name alone. Do not include aliases, titles, parenthetical explanations, or relation glosses; surrounding descriptors remain contextual translation. The harness will conservatively project only the leading canonical name if you append an explanation.",
      "Call submit_lexical_anchors exactly once and classify every supplied form.",
    ].join("\n"),
    prompt: [
      "SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE",
      JSON.stringify(input.candidates),
      "ESTABLISHED TERMS",
      input.stableTerms.map((term) =>
        `${term.sourceForm} => ${term.target}`).join("\n") || "(none)",
    ].join("\n\n"),
    serializedToolSchemas: canonicalJson(toolSchemaPayload),
    toolSchemaPayload,
  };
}

function lexicalProtocolError(message: string): ModelProviderError {
  return new ModelProviderError(
    `lexical preferred fallback protocol error: ${message}`,
    "protocol",
    true,
  );
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

export function createLexicalPreferredFallbackProtocol(
  candidates: readonly AnchorCandidate[],
  profile: SourceLanguageProfile,
): LexicalPreferredFallbackProtocol {
  const hash = createHash("sha256");
  hash.update("lexical-preferred-v1");
  hash.update("\0");
  hash.update(profile.id);
  hash.update("\0");
  hash.update(JSON.stringify(candidates));
  const nonce = hash.digest("hex").slice(0, 24);
  return {
    nonce,
    beginLine: `@@FOLIOLOOM:LEXICAL-PREFERRED:${nonce}:BEGIN@@`,
    endLine: `@@FOLIOLOOM:LEXICAL-PREFERRED:${nonce}:END@@`,
  };
}

function framedPayload(
  response: string,
  protocol: LexicalPreferredFallbackProtocol,
): string {
  const normalizedResponse = response.replace(/\r\n?/gu, "\n");
  const lines = normalizedResponse.split("\n");
  const begins = lines.flatMap((line, index) =>
    line === protocol.beginLine ? [index] : []);
  const ends = lines.flatMap((line, index) =>
    line === protocol.endLine ? [index] : []);
  if (begins.length === 0 && ends.length === 0) {
    const bare = normalizedResponse.trim();
    if (bare.startsWith("[") && bare.endsWith("]")) {
      return bare;
    }
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0]! >= ends[0]!) {
    throw lexicalProtocolError("expected exactly one ordered BEGIN/END frame");
  }
  if (lines.slice(0, begins[0]).some((line) => line.trim().length > 0)
    || lines.slice(ends[0]! + 1).some((line) => line.trim().length > 0)) {
    throw lexicalProtocolError("text appeared outside the response frame");
  }
  const payload = lines.slice(begins[0]! + 1, ends[0]).join("\n").trim();
  if (payload.length === 0) {
    throw lexicalProtocolError("response frame was empty");
  }
  return payload;
}

export function parseLexicalPreferredFallbackResponse(
  response: string,
  protocol: LexicalPreferredFallbackProtocol,
  candidates: readonly AnchorCandidate[],
  profile: SourceLanguageProfile,
): LexicalPreferredFallbackResult {
  let raw: unknown;
  try {
    raw = JSON.parse(framedPayload(response, protocol));
  } catch (error) {
    if (error instanceof ModelProviderError) {
      throw error;
    }
    throw lexicalProtocolError(error instanceof Error ? error.message : "invalid JSON");
  }
  if (!Array.isArray(raw) || raw.length > candidates.length) {
    throw lexicalProtocolError("payload must be an array no larger than the candidate set");
  }
  const candidateByForm = new Map(candidates.map((candidate) => [
    profile.normalizeSourceForm(candidate.sourceForm),
    candidate,
  ]));
  const submitted = new Map<string, {
    target: string;
    semanticClass: LexicalAnchorSemanticClass;
    confidence: number;
  }>();
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw lexicalProtocolError(`item ${index} must be an object`);
    }
    const value = item as Record<string, unknown>;
    const sourceForm = value.sourceForm;
    const target = value.target;
    const semanticClass = value.semanticClass;
    const confidence = value.confidence;
    if (typeof sourceForm !== "string") {
      throw lexicalProtocolError(`item ${index} has no sourceForm`);
    }
    const normalizedSource = profile.normalizeSourceForm(sourceForm);
    if (!candidateByForm.has(normalizedSource) || submitted.has(normalizedSource)) {
      throw lexicalProtocolError(`item ${index} references an unknown or duplicate form`);
    }
    if (typeof target !== "string"
      || target.trim().length === 0
      || Array.from(target.trim()).length > 32
      || /[\r\n\u0000-\u001f]/u.test(target)
      || target.includes("@@FOLIOLOOM:")) {
      throw lexicalProtocolError(`item ${index} has an invalid preferred target`);
    }
    if (typeof semanticClass !== "string"
      || !PREFERRED_FALLBACK_CLASSES.has(semanticClass as LexicalAnchorSemanticClass)) {
      throw lexicalProtocolError(`item ${index} is not an invariant lexical class`);
    }
    if (typeof confidence !== "number"
      || !Number.isFinite(confidence)
      || confidence < 0.8
      || confidence > 1) {
      throw lexicalProtocolError(`item ${index} has invalid confidence`);
    }
    const normalizedTarget = simplifyChineseTranslation(target.trim());
    const copiedSourceScript = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u
      .test(normalizedTarget);
    const entityClass = semanticClass === "proper_name" || semanticClass === "unique_title";
    if (copiedSourceScript || (entityClass && !/\p{Script=Han}/u.test(normalizedTarget))) {
      continue;
    }
    submitted.set(normalizedSource, {
      target: normalizedTarget,
      semanticClass: semanticClass as LexicalAnchorSemanticClass,
      confidence,
    });
  }

  const anchors = candidates.flatMap((candidate): LexicalAnchor[] => {
    const normalizedSource = profile.normalizeSourceForm(candidate.sourceForm);
    const decision = submitted.get(normalizedSource);
    if (decision === undefined && candidate.sourceAuthoredTarget === undefined) {
      return [];
    }
    return [{
      sourceForm: candidate.sourceForm,
      target: simplifyChineseTranslation(
        candidate.sourceAuthoredTarget ?? decision?.target ?? "",
      ),
      mode: decision?.semanticClass === "role" ? "contextual" : "stable",
      semanticClass: decision?.semanticClass ?? "unclassified",
      lockEligible: false,
      confidence: candidate.sourceAuthoredTarget === undefined
        ? decision!.confidence
        : Math.max(0.9, decision?.confidence ?? 0),
    }];
  });
  return {
    anchors,
    entityLinks: [],
    terms: anchors.map(anchorAsTerm),
  };
}

interface EntityLinkSubmission {
  sourceForms: string[];
  proposedTarget: string;
  evidenceKind: Extract<EntityLinkEvidenceKind,
    | "explicit_naming"
    | "apposition"
    | "contextual_compatibility"
    | "distributional_compatibility">;
  evidenceQuote: string;
  confidence: number;
}

function canonicalEntityTarget(value: string): string {
  return simplifyChineseTranslation((value.trim().split(
    /(?:（|\(|\[|【|,|，|;|；|\s+(?:又称|亦称|即|alias)\s+)/iu,
    1,
  )[0] ?? "").trim());
}

function establishedForms(stableTerms: readonly StableTerm[]): string[] {
  return stableTerms.flatMap((term) => [term.sourceForm, term.canonicalSource]);
}

export function collectRepeatedAnchorCandidates(
  blocks: readonly V4Block[],
  stableTerms: readonly StableTerm[],
  profile: SourceLanguageProfile = getSourceLanguageProfile("en"),
): AnchorCandidate[] {
  return profile.collectAnchorCandidates({
    targetTexts: blocks.map((block) => sourceTextForTranslation(block.sourceText)),
    corpusTexts: blocks.map((block) => sourceTextForTranslation(block.sourceText)),
    establishedSourceForms: establishedForms(stableTerms),
    limit: 24,
  }).filter((candidate) => candidate.corpusFrequency >= 2)
    .slice(0, 12)
    .map((candidate) => ({
      sourceForm: candidate.sourceForm,
      ...(candidate.sourceAuthoredTarget === undefined
        ? {}
        : { sourceAuthoredTarget: candidate.sourceAuthoredTarget }),
      ...(candidate.likelyProperName === true ? { likelyProperName: true } : {}),
      contexts: candidate.contexts,
      corpusFrequency: candidate.corpusFrequency,
      currentWaveOccurrences: candidate.currentWaveOccurrences,
      documentFrequency: candidate.documentFrequency,
      morphologyDiversity: candidate.morphologyDiversity,
    }));
}

/**
 * Finds forms in the current window and builds compact translator-global
 * concordance from the complete source using the selected language profile.
 */
export function collectWindowAnchorCandidates(
  targetBlocks: readonly V4Block[],
  corpusBlocks: readonly V4Block[],
  stableTerms: readonly StableTerm[],
  decidedSourceForms: readonly string[] = [],
  profile: SourceLanguageProfile = getSourceLanguageProfile("en"),
): AnchorCandidate[] {
  return profile.collectAnchorCandidates({
    targetTexts: targetBlocks.map((block) => sourceTextForTranslation(block.sourceText)),
    corpusTexts: corpusBlocks.map((block) => sourceTextForTranslation(block.sourceText)),
    establishedSourceForms: [
      ...establishedForms(stableTerms),
      ...decidedSourceForms,
    ],
    limit: 16,
  }).map((candidate) => ({
    sourceForm: candidate.sourceForm,
    ...(candidate.sourceAuthoredTarget === undefined
      ? {}
      : { sourceAuthoredTarget: candidate.sourceAuthoredTarget }),
    ...(candidate.likelyProperName === true ? { likelyProperName: true } : {}),
    contexts: candidate.contexts,
    corpusFrequency: candidate.corpusFrequency,
    currentWaveOccurrences: candidate.currentWaveOccurrences,
    documentFrequency: candidate.documentFrequency,
    morphologyDiversity: candidate.morphologyDiversity,
  }));
}

export class LexicalAnchorer {
  constructor(private readonly runtime: PiRuntime) {}

  async runPreferredTextFallback(input: LexicalAnchorInput): Promise<LexicalAnchorOutcome> {
    const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
    const prepared = prepareLexicalAnchorRequest(input, "framed_text");
    const protocol = prepared.fallbackProtocol;
    if (protocol === undefined) {
      throw new Error("framed lexical request is missing its protocol");
    }
    const run = await this.runtime.run({
      systemPrompt: prepared.systemPrompt,
      prompt: prepared.prompt,
      phase: "translation",
      model: input.model,
      tools: [],
      budget: input.budget,
      terminateTools: [],
      maxTurns: 1,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
      thinkingLevel: input.thinkingLevel,
      onAssistantResponse: input.onAssistantResponse,
    }, input.streamFn);
    try {
      return {
        ...parseLexicalPreferredFallbackResponse(
          lastAssistantText(run),
          protocol,
          input.candidates,
          profile,
        ),
        run,
      };
    } catch (error) {
      if (error instanceof ModelProviderError) {
        throw error.withRun(run);
      }
      throw error;
    }
  }

  async run(input: LexicalAnchorInput): Promise<LexicalAnchorOutcome> {
    const profile = input.sourceLanguageProfile ?? getSourceLanguageProfile("en");
    const allowed = new Map(input.candidates.map((candidate) => [
      profile.normalizeSourceForm(candidate.sourceForm),
      candidate.sourceForm,
    ]));
    const candidateByForm = new Map(input.candidates.map((candidate) => [
      profile.normalizeSourceForm(candidate.sourceForm),
      candidate,
    ]));
    let anchors: LexicalAnchor[] = [];
    let entityLinks: EntityLink[] = [];
    const uncorroboratedConceptForms = new Set<string>();
    let submitted = false;
    const tool: TypedToolSpec = {
      name: "submit_lexical_anchors",
      label: "Submit lexical anchors",
      description: "Classify every supplied source-language form and bind only context-invariant forms to one Chinese target.",
      phase: "translation",
      parameters: lexicalAnchorParameters(),
      execute: async (rawArgs, signal) => {
        assertNotAborted(signal);
        const args = rawArgs as {
          anchors: LexicalAnchor[];
          entityLinks?: EntityLinkSubmission[];
        };
        if (!Array.isArray(args.anchors) || args.anchors.length !== allowed.size) {
          throw new Error(`expected exactly ${allowed.size} lexical anchor decisions`);
        }
        const seen = new Set<string>();
        for (const anchor of args.anchors) {
          const key = profile.normalizeSourceForm(anchor.sourceForm);
          if (!allowed.has(key) || seen.has(key)) {
            throw new Error(`unknown or duplicate anchor form: ${anchor.sourceForm}`);
          }
          if (anchor.mode === "stable" && anchor.target.trim().length === 0) {
            throw new Error(`stable anchor requires a Chinese target: ${anchor.sourceForm}`);
          }
          if (!Number.isFinite(anchor.confidence)
            || anchor.confidence < 0 || anchor.confidence > 1) {
            throw new Error(`invalid anchor confidence: ${anchor.sourceForm}`);
          }
          seen.add(key);
        }
        entityLinks = (args.entityLinks ?? []).map((link, index) => {
          const normalizedForms = [...new Set(link.sourceForms.map((form) =>
            profile.normalizeSourceForm(form)))];
          if (normalizedForms.length < 2
            || normalizedForms.some((form) => !allowed.has(form))) {
            throw new Error(`entity link ${index} references unknown or duplicate forms`);
          }
          const sourceAuthoredTargets = [...new Set(normalizedForms.flatMap((form) => {
            const target = candidateByForm.get(form)?.sourceAuthoredTarget;
            return target === undefined ? [] : [simplifyChineseTranslation(target)];
          }))];
          if (sourceAuthoredTargets.length > 1) {
            throw new Error(`entity link ${index} conflicts with source-authored targets`);
          }
          const proposedTarget = sourceAuthoredTargets[0]
            ?? canonicalEntityTarget(link.proposedTarget);
          if (proposedTarget.length === 0
            || Array.from(proposedTarget).length > 32
            || /[()（）\[\]【】,，;；]/u.test(proposedTarget)) {
            throw new Error(
              `entity link ${index} proposedTarget must be one concise canonical Chinese name without aliases, titles, parentheses, or explanations`,
            );
          }
          const contexts = normalizedForms.flatMap((form) =>
            candidateByForm.get(form)?.contexts ?? []);
          const quote = link.evidenceQuote.replace(/\s+/gu, " ").trim();
          if (quote.length === 0
            || !contexts.some((context) =>
              context.replace(/\s+/gu, " ").includes(quote))) {
            throw new Error(`entity link ${index} evidence quote is outside supplied contexts`);
          }
          const hasEntityLikeAnchor = normalizedForms.some((form) => {
            const decision = args.anchors.find((anchor) =>
              profile.normalizeSourceForm(anchor.sourceForm) === form);
            return decision?.mode === "stable"
              && (decision.semanticClass === "proper_name"
                || decision.semanticClass === "unique_title")
              && decision.confidence >= 0.95;
          });
          const normalizedQuote = profile.normalizeSourceForm(quote);
          const quoteCoversAllForms = normalizedForms.every((form) =>
            normalizedQuote.includes(form));
          const hasCorroboratingCue = hasEntityLikeAnchor
            && quoteCoversAllForms
            && profile.hasExplicitEntityNamingCue(quote);
          const evidenceKind = hasCorroboratingCue
            ? "contextual_compatibility"
            : "distributional_compatibility";
          const evidenceBase = createHash("sha256")
            .update(`${normalizedForms.sort().join("\0")}\0${quote}`)
            .digest("hex")
            .slice(0, 20);
          return evaluateEntityLink({
            sourceForms: link.sourceForms,
            proposedTarget,
            profile,
            evidence: [{
              evidenceId: `anchor-evidence-${evidenceBase}`,
              kind: evidenceKind,
              weight: link.confidence,
              sourceForms: link.sourceForms,
            }, {
              evidenceId: `anchor-model-${evidenceBase}`,
              kind: "model_verdict",
              weight: link.confidence,
              sourceForms: link.sourceForms,
            }],
          });
        });
        input.budget.consume("translationToolCalls", 1);
        submitted = true;
        anchors = args.anchors.map((anchor) => {
          const normalizedSource = profile.normalizeSourceForm(anchor.sourceForm);
          const candidate = candidateByForm.get(normalizedSource);
          let semanticClass = anchor.semanticClass ?? "unclassified";
          if (CONCEPT_ELIGIBLE_CLASSES.has(semanticClass)
            && !hasIndependentConceptEvidence(anchor, candidate)) {
            semanticClass = "unclassified";
            if (anchor.confidence >= 0.9) {
              uncorroboratedConceptForms.add(normalizedSource);
            }
          }
          const sourceAuthoredTarget = candidate?.sourceAuthoredTarget;
          const sourceAuthoredBinding = anchor.mode === "stable"
            && anchor.confidence >= 0.75
            && sourceAuthoredTarget !== undefined;
          return {
            ...anchor,
            semanticClass,
            lockEligible: false,
            target: simplifyChineseTranslation(
              sourceAuthoredBinding ? sourceAuthoredTarget : anchor.target.trim(),
            ),
          };
        });
        return {
          accepted: true,
          anchors: anchors.length,
          entityLinks: entityLinks.length,
        };
      },
    };
    const prepared = prepareLexicalAnchorRequest(input, "typed_tool");
    const run = await this.runtime.run({
      systemPrompt: prepared.systemPrompt,
      prompt: prepared.prompt,
      phase: "translation",
      model: input.model,
      tools: [tool],
      budget: input.budget,
      terminateTools: ["submit_lexical_anchors"],
      maxTurns: 2,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
      thinkingLevel: input.thinkingLevel,
      onAssistantResponse: input.onAssistantResponse,
    }, input.streamFn);
    if (!submitted) {
      throw new ModelProviderError(
        "lexical anchor protocol error: submit_lexical_anchors was not called",
        "protocol",
        true,
      ).withRun(run);
    }
    const confirmedForms = new Set(entityLinks
      .filter((link) => link.status === "confirmed")
      .flatMap((link) => link.normalizedForms));
    const anchorTerms = anchors
      .filter((anchor) =>
        CONCEPT_ELIGIBLE_CLASSES.has(anchor.semanticClass ?? "unclassified")
        && (anchor.lockEligible === true || anchor.confidence >= 0.8)
        && anchor.target.trim().length > 0
        && !confirmedForms.has(profile.normalizeSourceForm(anchor.sourceForm)))
      .map(anchorAsTerm);
    const softAnchorTerms = anchors
      .filter((anchor) =>
        uncorroboratedConceptForms.has(
          profile.normalizeSourceForm(anchor.sourceForm),
        )
        && anchor.target.trim().length > 0
        && !confirmedForms.has(profile.normalizeSourceForm(anchor.sourceForm)))
      .map(anchorAsTerm);
    const projectedForms = new Set([
      ...confirmedForms,
      ...anchorTerms.map((term) => profile.normalizeSourceForm(term.sourceForm)),
      ...softAnchorTerms.map((term) =>
        profile.normalizeSourceForm(term.sourceForm)),
    ]);
    const sourceAuthoredPreferences = input.candidates.flatMap((candidate): StableTerm[] => {
      const normalized = profile.normalizeSourceForm(candidate.sourceForm);
      if (candidate.sourceAuthoredTarget === undefined || projectedForms.has(normalized)) {
        return [];
      }
      projectedForms.add(normalized);
      return [anchorAsTerm({
        sourceForm: candidate.sourceForm,
        target: simplifyChineseTranslation(candidate.sourceAuthoredTarget),
        mode: "stable",
        semanticClass: "unclassified",
        lockEligible: false,
        confidence: 0.9,
      })];
    });
    return {
      anchors: anchors.map((anchor) => ({ ...anchor })),
      entityLinks: entityLinks.map((link) => structuredClone(link)),
      terms: [
        ...anchorTerms,
        ...softAnchorTerms,
        ...sourceAuthoredPreferences,
        ...entityLinks.flatMap(entityLinkAsTerms),
      ],
      run,
    };
  }
}

export function sourceAuthoredAnchorFallback(
  candidates: readonly AnchorCandidate[],
): Pick<LexicalAnchorOutcome, "anchors" | "entityLinks" | "terms"> {
  const anchors = candidates.flatMap((candidate): LexicalAnchor[] => {
    if (candidate.sourceAuthoredTarget === undefined) {
      return [];
    }
    return [{
      sourceForm: candidate.sourceForm,
      target: simplifyChineseTranslation(candidate.sourceAuthoredTarget),
      mode: "stable",
      semanticClass: "unclassified",
      lockEligible: false,
      confidence: 0.9,
    }];
  });
  return {
    anchors,
    entityLinks: [],
    terms: anchors.map(anchorAsTerm),
  };
}

export function anchorAsTerm(anchor: LexicalAnchor): StableTerm {
  if (CONCEPT_ELIGIBLE_CLASSES.has(anchor.semanticClass ?? "unclassified")) {
    const concept = conceptFromAnchor({
      sourceForm: anchor.sourceForm,
      target: anchor.target,
      mode: anchor.mode,
      semanticClass: anchor.semanticClass as LexicalSemanticClass,
      confidence: anchor.confidence,
    });
    return {
      conceptId: concept.conceptId,
      lexemeId: `${concept.conceptId}-lexeme`,
      sourceForm: concept.sourceForms[0]!,
      canonicalSource: concept.normalizedSubject,
      target: concept.canonicalTarget,
      locked: concept.policy === "locked",
      policy: concept.policy,
      semanticClass: concept.semanticClass,
      allowedTargets: concept.allowedRealizations,
      revisionId: concept.revisionId,
      renderFingerprint: concept.renderFingerprint,
      note: concept.policy === "contextual"
        ? "semantic role with context-sensitive Chinese surface realization"
        : "single-pass model anchor; prefer this rendering but allow context-sensitive Chinese wording",
    };
  }
  const id = createHash("sha256")
    .update(`${anchor.sourceForm}\0${anchor.target}`)
    .digest("hex")
    .slice(0, 16);
  const locked = anchor.lockEligible === true;
  return softenModelAnchorTerm({
    conceptId: `run-anchor-${id}`,
    lexemeId: `run-anchor-lexeme-${id}`,
    sourceForm: anchor.sourceForm,
    canonicalSource: anchor.sourceForm,
    target: anchor.target,
    locked,
    policy: locked ? "locked" : "preferred",
    note: locked
      ? "source-grounded evidence and a high-confidence stable semantic classification"
      : "single-pass model anchor; prefer this rendering but allow context-sensitive Chinese wording",
  });
}

/** A single model classification is evidence for preference, never a hard invariant. */
export function softenModelAnchorTerm(term: StableTerm): StableTerm {
  if (!term.conceptId.startsWith("run-anchor-") || (term.locked && term.policy === "locked")) {
    return { ...term };
  }
  return {
    ...term,
    locked: false,
    policy: "preferred",
    note: "single-pass model anchor; prefer this rendering but allow context-sensitive Chinese wording",
  };
}
