import { createHash } from "node:crypto";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { StableTerm, V4Block } from "../domain/types.js";
import {
  entityLinkAsTerms,
  evaluateEntityLink,
  type EntityLink,
  type EntityLinkEvidenceKind,
} from "../domain/entity-links.js";
import type { BudgetLedger } from "../kernel/budget.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { assertNotAborted, Type, type TypedToolSpec } from "../tools/tool-spec.js";
import { PiRuntime, type PiRunResult } from "./pi-runtime.js";

export interface AnchorCandidate {
  sourceForm: string;
  contexts: string[];
}

export interface LexicalAnchor {
  sourceForm: string;
  target: string;
  mode: "stable" | "contextual";
  confidence: number;
}

interface LexicalAnchorInput {
  candidates: readonly AnchorCandidate[];
  stableTerms: readonly StableTerm[];
  model: Model<any>;
  streamFn: StreamFn;
  budget: BudgetLedger;
  sourceLanguageProfile?: SourceLanguageProfile;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface LexicalAnchorOutcome {
  anchors: LexicalAnchor[];
  entityLinks: EntityLink[];
  terms: StableTerm[];
  run: PiRunResult;
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
  return (value.trim().split(
    /(?:（|\(|\[|【|,|，|;|；|\s+(?:又称|亦称|即|alias)\s+)/iu,
    1,
  )[0] ?? "").trim();
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
    targetTexts: blocks.map((block) => block.sourceText),
    corpusTexts: blocks.map((block) => block.sourceText),
    establishedSourceForms: establishedForms(stableTerms),
    limit: 24,
  }).filter((candidate) => candidate.corpusFrequency >= 2)
    .slice(0, 12)
    .map((candidate) => ({
      sourceForm: candidate.sourceForm,
      contexts: candidate.contexts,
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
    targetTexts: targetBlocks.map((block) => block.sourceText),
    corpusTexts: corpusBlocks.map((block) => block.sourceText),
    establishedSourceForms: [
      ...establishedForms(stableTerms),
      ...decidedSourceForms,
    ],
    limit: 12,
  }).map((candidate) => ({
    sourceForm: candidate.sourceForm,
    contexts: candidate.contexts,
  }));
}

export class LexicalAnchorer {
  constructor(private readonly runtime: PiRuntime) {}

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
    const tool: TypedToolSpec = {
      name: "submit_lexical_anchors",
      label: "Submit lexical anchors",
      description: "Classify every supplied source-language form and bind only context-invariant forms to one Chinese target.",
      phase: "translation",
      parameters: Type.Object({
        anchors: Type.Array(Type.Object({
          sourceForm: Type.String(),
          target: Type.String(),
          mode: Type.Union([Type.Literal("stable"), Type.Literal("contextual")]),
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
      }),
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
          const proposedTarget = canonicalEntityTarget(link.proposedTarget);
          if (proposedTarget.length === 0
            || Array.from(proposedTarget).length > 32
            || /[()（）\[\]【】,，;；]/u.test(proposedTarget)) {
            throw new Error(
              `entity link ${index} proposedTarget must be one concise canonical Chinese name without aliases, titles, parentheses, or explanations`,
            );
          }
          const normalizedForms = [...new Set(link.sourceForms.map((form) =>
            profile.normalizeSourceForm(form)))];
          if (normalizedForms.length < 2
            || normalizedForms.some((form) => !allowed.has(form))) {
            throw new Error(`entity link ${index} references unknown or duplicate forms`);
          }
          const contexts = normalizedForms.flatMap((form) =>
            candidateByForm.get(form)?.contexts ?? []);
          const quote = link.evidenceQuote.replace(/\s+/gu, " ").trim();
          if (quote.length === 0
            || !contexts.some((context) =>
              context.replace(/\s+/gu, " ").includes(quote))) {
            throw new Error(`entity link ${index} evidence quote is outside supplied contexts`);
          }
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
              kind: link.evidenceKind,
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
        anchors = args.anchors.map((anchor) => ({ ...anchor }));
        return {
          accepted: true,
          anchors: anchors.length,
          entityLinks: entityLinks.length,
        };
      },
    };
    const run = await this.runtime.run({
      systemPrompt: [
        "You establish run-local lexical anchors before parallel literary translation.",
        `The source language is ${profile.displayName} (${profile.id}).`,
        "Mark proper names, unique titles, and invariant technical terms as stable and choose one concise Chinese target.",
        "Mark ordinary words, forms whose Chinese rendering changes by discourse role, and forms of address as contextual.",
        "Do not force surface consistency where Chinese grammar or relationship context requires variation.",
        "When compact evidence explicitly links two supplied forms to one entity, submit an entityLinks item and quote the exact supplied context. Leave uncertain relationships unconfirmed.",
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
      phase: "translation",
      model: input.model,
      tools: [tool],
      budget: input.budget,
      terminateTools: ["submit_lexical_anchors"],
      maxTurns: 2,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
    }, input.streamFn);
    const confirmedForms = new Set(entityLinks
      .filter((link) => link.status === "confirmed")
      .flatMap((link) => link.normalizedForms));
    return {
      anchors: anchors.map((anchor) => ({ ...anchor })),
      entityLinks: entityLinks.map((link) => structuredClone(link)),
      terms: [
        ...anchors
        .filter((anchor) =>
          anchor.mode === "stable"
          && anchor.confidence >= 0.85
          && anchor.target.trim().length > 0
          && !confirmedForms.has(profile.normalizeSourceForm(anchor.sourceForm)))
        .map(anchorAsTerm),
        ...entityLinks.flatMap(entityLinkAsTerms),
      ],
      run,
    };
  }
}

export function anchorAsTerm(anchor: LexicalAnchor): StableTerm {
  const id = createHash("sha256")
    .update(`${anchor.sourceForm}\0${anchor.target}`)
    .digest("hex")
    .slice(0, 16);
  return {
    conceptId: `run-anchor-${id}`,
    lexemeId: `run-anchor-lexeme-${id}`,
    sourceForm: anchor.sourceForm,
    canonicalSource: anchor.sourceForm,
    target: anchor.target,
    locked: true,
  };
}
