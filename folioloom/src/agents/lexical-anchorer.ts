import { createHash } from "node:crypto";

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { StableTerm, V4Block } from "../domain/types.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";
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
import { createLexicalPreference } from "../knowledge/lexical-preference.js";
import { collectEnglishContextualTermCandidates, isEnglishPronounContraction } from "../language/contextual-term-candidates.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { ProfileAnchorCandidate, SourceLanguageProfile } from "../language/types.js";
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
  discoveryKind?: "recurrent_noun";
  sourceAuthoredTarget?: string;
  likelyProperName?: boolean;
  contexts: string[];
  corpusFrequency?: number;
  currentWaveOccurrences?: number;
  documentFrequency?: number;
  morphologyDiversity?: number;
  relatedSourceForms?: ProfileAnchorCandidate["relatedSourceForms"];
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
  /** Host discovery evidence, independent of the model's lexical classification. */
  discoveryKind?: "recurrent_noun";
  meaning?: string;
  usageScope?: string;
  allowedTargets?: string[];
  /** Context quotes are attached by the host, never accepted from model output. */
  sourceContexts?: string[];
  /** Preserve the model's weak classification without making it an eligible concept. */
  proposedSemanticClass?: LexicalAnchorSemanticClass;
  sourceForm: string;
  target: string;
  mode: "stable" | "contextual";
  semanticClass?: LexicalAnchorSemanticClass;
  lockEligible?: boolean;
  /** @deprecated Historical input only; ignored by decisions and projections. */
  confidence?: number;
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
  if (candidate === undefined) return false;
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

/** Discovery support may retain a soft sense; it never increases exact-form concept evidence. */
function hasSpecializedPreferenceEvidence(candidate: AnchorCandidate | undefined): boolean {
  if (!candidate?.contexts.length) return false;
  if ((candidate.corpusFrequency ?? 0) >= 2) return true;
  if (candidate.discoveryKind !== "recurrent_noun" || candidate.corpusFrequency !== 1) return false;
  const grounded = (form: string, contexts: readonly string[]) => {
    const literal = form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, "iu");
    return contexts.some(context => pattern.test(context));
  };
  return grounded(candidate.sourceForm, candidate.contexts)
    && (candidate.relatedSourceForms ?? []).some(related => related.sourceForm !== candidate.sourceForm
      && Number.isSafeInteger(related.corpusFrequency) && related.corpusFrequency >= 2
      && grounded(related.sourceForm, related.contexts));
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
      meaning: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      usageScope: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      allowedTargets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 4 })),
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
        "Omit ordinary words, forms of address, relationship labels, and forms for which the supplied contexts do not establish a lexical sense.",
        "Every proper-name or unique-title target must be a usable Chinese rendering containing Chinese characters. When no Hanja/Chinese spelling is printed, choose one conservative Chinese transliteration; never copy Hangul, hiragana, or katakana into target.",
        "For sourceAuthoredTarget, copy that printed Hanja/Chinese target exactly; the harness will normalize its Chinese script.",
        "Do not infer aliases or entity identity in this compatibility path. Every returned binding is only a preferred rendering, never a hard constraint.",
        "Preserve source spellings; do not correct suspected typos or OCR errors.",
        "relatedSourceForms are attested possible inflections for read-only comparison, not established aliases. Classify only the supplied candidate forms; use a shared preferred rendering only when their contexts support the same sense. Do not merge distinct senses or manufacture a binding for a supporting form.",
        "Inside the exact response frame, emit one JSON array and nothing else. Each item must contain sourceForm, target, semanticClass, and mode (stable or contextual). For technical_term, also give brief meaning and usageScope (each at most 240 characters) and optionally allowedTargets (up to four concise short forms, not rival translations).",
        "semanticClass must be proper_name, unique_title, technical_term, or role. Use role for a profession, office, or institutional function whose Chinese wording may vary by sentence. Preserve contextual modes and genuine sense-specific variants.",
      ].join("\n"),
      prompt: [
        "CANDIDATES AND COMPACT CONCORDANCE",
        JSON.stringify(input.candidates.map(c => ({ ...c, contextScope: "bounded_source_excerpt" }))),
        "ESTABLISHED TERMS (do not duplicate or contradict)",
        input.stableTerms.map((term) =>
          `${term.sourceForm} => ${term.target}`).join("\n") || "(none)",
        "EXACT RESPONSE FRAME",
        protocol.beginLine,
        "[{\"sourceForm\":\"...\",\"target\":\"...\",\"semanticClass\":\"proper_name\",\"mode\":\"stable\"}]",
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
      "For recurrent lowercase places, institutions, practices and devices, establish a concise default only when the supplied contexts support the same meaning. Ordinary nouns and polysemous readings remain contextual; recurrence alone does not make a proper name.",
      "Book-specific building, institutional and ritual nouns can be technical_term even when lowercase. Use contextual mode when a place word also denotes its service or activity; do not force the literal building label into that use.",
      "For technical_term, include a brief meaning and usageScope describing which sense/object the target names; optionally list concise allowedTargets for genuine short forms. Do not list rival translations as interchangeable aliases. These fields share this call and do not authorize global replacement. Establish source-grounded preferences directly, keeping distinct senses and contextual usage explicit.",
      "Preserve source spellings. Do not correct suspected typos or OCR errors, or infer alias links from a presumed spelling mistake.",
      "relatedSourceForms are attested possible inflections for read-only comparison, not established aliases. Classify each supplied exact form; use a shared preferred rendering only when their contexts support the same sense. Different senses stay separate. A supporting form is not an additional candidate or an entity-identity claim.",
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
      JSON.stringify(input.candidates.map(c => ({ ...c, contextScope: "bounded_source_excerpt" }))),
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
    mode: "stable" | "contextual";
    meaning?: string;
    usageScope?: string;
    allowedTargets?: string[];
  }>();
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw lexicalProtocolError(`item ${index} must be an object`);
    }
    const value = item as Record<string, unknown>;
    const sourceForm = value.sourceForm;
    const target = value.target;
    const semanticClass = value.semanticClass;
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
    if (value.mode !== undefined && value.mode !== "stable" && value.mode !== "contextual") {
      throw lexicalProtocolError(`item ${index} has invalid mode`);
    }
    const normalizedTarget = simplifyChineseTranslation(target.trim());
    for (const field of ["meaning", "usageScope"]) {
      if (value[field] !== undefined && (typeof value[field] !== "string"
        || !(value[field] as string).trim() || (value[field] as string).length > 240)) {
        throw lexicalProtocolError(`item ${index} has invalid ${field}`);
      }
    }
    if (value.allowedTargets !== undefined && (!Array.isArray(value.allowedTargets) || value.allowedTargets.length > 4
      || !value.allowedTargets.every(t => typeof t === "string" && t.trim() && t.length <= 64))) {
      throw lexicalProtocolError(`item ${index} has invalid allowedTargets`);
    }
    const copiedSourceScript = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u
      .test(normalizedTarget);
    const entityClass = semanticClass === "proper_name" || semanticClass === "unique_title";
    if (copiedSourceScript || (entityClass && !/\p{Script=Han}/u.test(normalizedTarget))) {
      continue;
    }
    submitted.set(normalizedSource, {
      target: normalizedTarget,
      semanticClass: semanticClass as LexicalAnchorSemanticClass,
      mode: value.mode === "contextual" || (value.mode === undefined && semanticClass === "role") ? "contextual" : "stable",
      ...(value.meaning === undefined ? {} : { meaning: value.meaning as string }),
      ...(value.usageScope === undefined ? {} : { usageScope: value.usageScope as string }),
      ...(value.allowedTargets === undefined ? {} : { allowedTargets: (value.allowedTargets as string[]).map(t => simplifyChineseTranslation(t)) }),
    });
  }

  const anchors = candidates.flatMap((candidate): LexicalAnchor[] => {
    const normalizedSource = profile.normalizeSourceForm(candidate.sourceForm);
    const decision = submitted.get(normalizedSource);
    if (decision === undefined && candidate.sourceAuthoredTarget === undefined) {
      return [];
    }
    return [{
      ...(decision ?? {}),
      sourceForm: candidate.sourceForm,
      sourceContexts: candidate.contexts.slice(0, 3),
      target: simplifyChineseTranslation(
        candidate.sourceAuthoredTarget ?? decision?.target ?? "",
      ),
      mode: decision?.mode ?? "stable",
      semanticClass: decision?.semanticClass ?? "unclassified",
      lockEligible: false,
    }];
  });
  return {
    anchors,
    entityLinks: [],
    terms: anchors.map(anchor => anchor.semanticClass === "technical_term"
      && hasSpecializedPreferenceEvidence(candidateByForm.get(profile.normalizeSourceForm(anchor.sourceForm)))
      && anchor.sourceContexts?.length
      ? createLexicalPreference({ ...anchor, contexts: anchor.sourceContexts }) : anchorAsTerm(anchor)),
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
    targetTexts: blocks.map((block) => stripEpubStructuralMarkers(sourceTextForTranslation(block.sourceText))),
    corpusTexts: blocks.map((block) => stripEpubStructuralMarkers(sourceTextForTranslation(block.sourceText))),
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
  const discoveryInput = {
    targetTexts: targetBlocks.map((block) => stripEpubStructuralMarkers(sourceTextForTranslation(block.sourceText))),
    corpusTexts: corpusBlocks.map((block) => stripEpubStructuralMarkers(sourceTextForTranslation(block.sourceText))),
    establishedSourceForms: [
      ...establishedForms(stableTerms),
      ...decidedSourceForms,
    ],
    limit: 16,
  };
  const contextual = profile.id === "en" ? collectEnglishContextualTermCandidates({ ...discoveryInput, limit: 4 }) : [];
  const named = profile.collectAnchorCandidates(discoveryInput)
    .filter(candidate => profile.id !== "en" || !isEnglishPronounContraction(candidate.sourceForm));
  const namedForms = new Set(named.map(c => c.normalizedSource));
  const additions = contextual.filter(c => !namedForms.has(c.normalizedSource));
  return [...named.slice(0, 16 - additions.length), ...additions].map((candidate) => ({
    sourceForm: candidate.sourceForm,
    ...(additions.includes(candidate) ? { discoveryKind: "recurrent_noun" as const } : {}),
    ...(candidate.sourceAuthoredTarget === undefined
      ? {}
      : { sourceAuthoredTarget: candidate.sourceAuthoredTarget }),
    ...(candidate.likelyProperName === true ? { likelyProperName: true } : {}),
    contexts: candidate.contexts,
    corpusFrequency: candidate.corpusFrequency,
    currentWaveOccurrences: candidate.currentWaveOccurrences,
    documentFrequency: candidate.documentFrequency,
    morphologyDiversity: candidate.morphologyDiversity,
    ...(candidate.relatedSourceForms ? { relatedSourceForms: candidate.relatedSourceForms } : {}),
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
    const specializedPreferenceForms = new Set<string>();
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
                || decision.semanticClass === "unique_title");
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
              // Presence of a host-verified source receipt, not a model self-rating.
              weight: 1,
              sourceForms: link.sourceForms,
            }, {
              evidenceId: `anchor-model-${evidenceBase}`,
              kind: "model_verdict",
              weight: 1,
              sourceForms: link.sourceForms,
            }],
          });
        });
        input.budget.consume("translationToolCalls", 1);
        submitted = true;
        anchors = args.anchors.map((anchor) => {
          const normalizedSource = profile.normalizeSourceForm(anchor.sourceForm);
          const candidate = candidateByForm.get(normalizedSource);
          if (anchor.semanticClass === "technical_term"
            && hasSpecializedPreferenceEvidence(candidate)
            && anchor.target.trim()) specializedPreferenceForms.add(normalizedSource);
          let semanticClass = anchor.semanticClass ?? "unclassified";
          if (CONCEPT_ELIGIBLE_CLASSES.has(semanticClass)
            && !hasIndependentConceptEvidence(anchor, candidate)) {
            semanticClass = "unclassified";
            uncorroboratedConceptForms.add(normalizedSource);
          }
          const sourceAuthoredTarget = candidate?.sourceAuthoredTarget;
          const sourceAuthoredBinding = anchor.mode === "stable"
            && sourceAuthoredTarget !== undefined;
          const { confidence: _legacyScore, discoveryKind: _untrustedKind, ...decision } = anchor;
          return {
            ...decision,
            ...(candidate?.discoveryKind ? { discoveryKind: candidate.discoveryKind } : {}),
            proposedSemanticClass: anchor.semanticClass ?? "unclassified",
            semanticClass,
            lockEligible: false,
            sourceContexts: candidate?.contexts.slice(0, 3),
            ...(anchor.allowedTargets === undefined ? {} : {
              allowedTargets: anchor.allowedTargets.map(target => simplifyChineseTranslation(target)),
            }),
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
        && !specializedPreferenceForms.has(profile.normalizeSourceForm(anchor.sourceForm))
        && anchor.target.trim().length > 0
        && !confirmedForms.has(profile.normalizeSourceForm(anchor.sourceForm)))
      .map(anchorAsTerm);
    const softAnchorTerms = anchors
      .filter((anchor) =>
        (uncorroboratedConceptForms.has(
          profile.normalizeSourceForm(anchor.sourceForm),
        ) || specializedPreferenceForms.has(profile.normalizeSourceForm(anchor.sourceForm)))
        && anchor.target.trim().length > 0
        && !confirmedForms.has(profile.normalizeSourceForm(anchor.sourceForm)))
      .map(anchor => specializedPreferenceForms.has(profile.normalizeSourceForm(anchor.sourceForm))
        ? createLexicalPreference({ ...anchor, contexts: anchor.sourceContexts ?? [] })
        : anchorAsTerm(anchor));
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
      allowedRealizations: anchor.allowedTargets,
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
    policy: locked ? "locked" : anchor.mode === "contextual" ? "contextual" : "preferred",
    ...(anchor.allowedTargets === undefined ? {} : { allowedTargets: anchor.allowedTargets }),
    note: locked
      ? "source-grounded evidence and a stable semantic classification"
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
    policy: term.policy === "contextual" ? "contextual" : "preferred",
    note: "single-pass model anchor; prefer this rendering but allow context-sensitive Chinese wording",
  };
}
