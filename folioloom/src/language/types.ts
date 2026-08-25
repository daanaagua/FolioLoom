import type { StructureKind } from "../source/types.js";

export type SourceScript = "latin" | "cyrillic" | "kana" | "hangul" | "han" | "unknown";

export interface BoundaryCandidate {
  scalarOffset: number;
  weight: number;
  kind: "paragraph" | "sentence" | "heading" | "layout";
}

export interface TranslationLengthRatioBand {
  min: number;
  max: number;
  minSourceCharacters: number;
}

export interface ScriptStats {
  scalars: number;
  latin: number;
  han: number;
  kana: number;
  hangul: number;
  other: number;
}

export interface StructureHeading {
  kind: Extract<StructureKind, "volume_heading" | "chapter_heading">;
  title: string;
  boundaryWeight: number;
}

export interface SourceToken {
  value: string;
  normalized: string;
  start: number;
  end: number;
  isWordLike: boolean;
}

export interface AnchorCandidateInput {
  targetTexts: readonly string[];
  corpusTexts: readonly string[];
  establishedSourceForms?: readonly string[];
  limit?: number;
}

export interface ProfileAnchorCandidate {
  sourceForm: string;
  normalizedSource: string;
  sourceAuthoredTarget?: string;
  likelyProperName?: boolean;
  contexts: string[];
  corpusFrequency: number;
  currentWaveOccurrences: number;
  documentFrequency: number;
  morphologyDiversity: number;
  score: number;
}

export interface ResidueDetectionOptions {
  preservedSourceForms?: readonly string[];
}

export interface ResidueFinding {
  code: "source_prose_residue";
  form: string;
  start: number;
  end: number;
  script: "latin" | "cyrillic" | "kana" | "hangul" | "unknown";
}

export interface SourceLanguageProfile {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly locale: string;
  readonly scripts: readonly SourceScript[];
  readonly translationLengthRatioBands?: readonly TranslationLengthRatioBand[];
  detectStructureHeading(line: string): StructureHeading | null;
  collectBoundaryCandidates(text: string): BoundaryCandidate[];
  collectScriptStats(text: string): ScriptStats;
  segment(text: string): SourceToken[];
  /**
   * Canonicalize spelling-only differences for exact source-span matching.
   * Unlike normalizeSourceForm, this must not remove morphology.
   */
  normalizeSourceLiteral(text: string): string;
  normalizeSourceForm(text: string): string;
  normalizeAnchorSourceForm(text: string): string;
  hasExplicitEntityNamingCue(text: string): boolean;
  collectAnchorCandidates(input: AnchorCandidateInput): ProfileAnchorCandidate[];
  detectSourceResidue(
    translation: string,
    options?: ResidueDetectionOptions,
  ): ResidueFinding[];
}
