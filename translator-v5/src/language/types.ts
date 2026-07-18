import type { StructureKind } from "../source/types.js";

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
  contexts: string[];
  corpusFrequency: number;
  currentWaveOccurrences: number;
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
  script: "latin" | "cyrillic" | "kana" | "unknown";
}

export interface SourceLanguageProfile {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly locale: string;
  detectStructureHeading(line: string): StructureHeading | null;
  segment(text: string): SourceToken[];
  normalizeSourceForm(text: string): string;
  collectAnchorCandidates(input: AnchorCandidateInput): ProfileAnchorCandidate[];
  detectSourceResidue(
    translation: string,
    options?: ResidueDetectionOptions,
  ): ResidueFinding[];
}
