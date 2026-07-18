export type AgentPhase = "research" | "translation" | "repair" | "recovery";

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

export interface StableTerm {
  conceptId: string;
  lexemeId: string;
  sourceForm: string;
  canonicalSource: string;
  target: string;
  locked: boolean;
}

export interface EvidenceHit {
  evidenceId: string;
  blockId: string;
  globalIndex: number;
  paragraphIndex: number;
  quote: string;
  sourceHash: string;
  channel: VisibilityChannel;
}
