export type AgentPhase = "research" | "translation" | "repair" | "recovery" | "supervision";

export type VisibilityChannel =
  | "narrative_before_target"
  | "translator_global";

export type RunStatus =
  | "created"
  | "indexed"
  | "researched"
  | "translating"
  | "validating"
  | "completed"
  | "completed_with_warnings"
  | "human_required"
  | "failed";

export interface V4Block {
  id: string;
  legacyId: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
  globalIndex: number;
  blockIndex: number;
  sourceText: string;
  sourceHash: string;
  tokenCount: number;
}

export type StableTermPolicy = "locked" | "preferred" | "contextual";

export type TermApplicability =
  | { readonly kind: "whole_book" }
  | {
    readonly kind: "block_range";
    readonly sourceVersion: string;
    readonly startBlockId: string;
    readonly endBlockId: string;
    readonly startGlobalIndex: number;
    readonly endGlobalIndex: number;
  };

export interface StableTerm {
  conceptId: string;
  lexemeId: string;
  sourceForm: string;
  canonicalSource: string;
  target: string;
  locked: boolean;
  policy?: StableTermPolicy;
  semanticClass?: "proper_name" | "unique_title" | "technical_term" | "role";
  allowedTargets?: readonly string[];
  revisionId?: string;
  renderFingerprint?: string;
  note?: string;
  origin?: "legacy" | "knowledge" | "glossary";
  ruleId?: string;
  baseConceptId?: string;
  entityId?: string;
  applicability?: TermApplicability;
  authorityRank?: number;
  priority?: number;
  applicableBlockIds?: readonly string[];
  /** Source-grounded semantic preference, not a global replacement instruction. */
  preference?: {
    senseId: string;
    meaning: string;
    usageScope: string;
    evidenceQuotes: readonly string[];
    /** @deprecated Historical records only; never used for admission or ranking. */
    confidence?: number;
  };
}

export interface EvidenceHit {
  evidenceId: string;
  blockId: string;
  globalIndex: number;
  paragraphIndex: number;
  quote: string;
  /** When clipped for a model, bounds are relative to the visible paragraph quote. */
  excerpt?: import("../text/bounded-excerpt.js").ExcerptRange;
  sourceHash: string;
  channel: VisibilityChannel;
}
