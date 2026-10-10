import type { StableTerm } from "../domain/types.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { paragraphEvidenceReferences } from "../domain/evidence-reference.js";
import { conceptsFromStableTerms, expectedTermOccurrences } from "./term-usage.js";
import { resolveStableTermsForBlocks } from "./stable-term-resolver.js";

export interface LexicalPreferenceCheck {
  occurrenceId: string; sourceForm: string; preferredTarget: string; blockId: string;
  paragraphIndex: number; sourceStart: number; sourceEnd: number;
  sourceQuote: string; targetQuote: string;
  status: "preferred_surface_present" | "variant_or_missing" | "untranslated" | "unaligned";
}

export function auditLexicalPreferences(input: {
  sources: readonly { blockId: string; sourceText: string; globalIndex: number; sourceVersion: string }[];
  translations: readonly { blockId: string; text: string }[];
  terms: readonly StableTerm[]; profile: SourceLanguageProfile;
}): LexicalPreferenceCheck[] {
  if (!input.terms.some(term => term.preference)) return [];
  const terms = resolveStableTermsForBlocks(input.terms, input.sources, input.profile).filter(term => term.preference);
  const translations = new Map(input.translations.map(t => [t.blockId, t.text]));
  const byBlock = new Map(input.sources.map(source => {
    const target = translations.get(source.blockId);
    return [source.blockId, { source: paragraphEvidenceReferences("source", source.blockId, source.sourceText),
      target: target === undefined ? undefined : paragraphEvidenceReferences("target", source.blockId, target) }];
  }));
  const occurrences = expectedTermOccurrences(input.sources.map(s => ({ id: s.blockId, sourceText: s.sourceText })),
    conceptsFromStableTerms(terms), input.profile);
  return occurrences.map(occurrence => {
    const block = byBlock.get(occurrence.blockId)!;
    const paragraphIndex = block.source.findIndex(p => p.start <= occurrence.sourceStart && p.end >= occurrence.sourceEnd);
    const aligned = paragraphIndex >= 0 && block.target?.length === block.source.length;
    const targetQuote = aligned ? block.target![paragraphIndex]!.text : "";
    return { occurrenceId: occurrence.occurrenceId, sourceForm: occurrence.sourceForm,
      preferredTarget: occurrence.canonicalTarget, blockId: occurrence.blockId, paragraphIndex,
      sourceStart: occurrence.sourceStart, sourceEnd: occurrence.sourceEnd,
      sourceQuote: block.source[paragraphIndex]?.text ?? "", targetQuote,
      status: block.target === undefined ? "untranslated" : !aligned ? "unaligned"
        : occurrence.allowedRealizations.some(target => targetQuote.includes(target)) ? "preferred_surface_present" : "variant_or_missing" };
  });
}
