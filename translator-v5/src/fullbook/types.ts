export type BookWindowStatus =
  | "pending"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "human_required"
  | "failed";

export interface BookWindowPlan {
  windowId: string;
  ordinal: number;
  chapterId: string;
  chapterTitle: string | null;
  blockIds: string[];
  globalIndexes: number[];
  sourceTokens: number;
  sourceChars: number;
  oversized: boolean;
}

export type RequestBatchWindow = BookWindowPlan & {
  readonly status?: BookWindowStatus;
};

export interface RequestBatchOptions {
  tinyWindowTokens: number;
  maxRequestTokens: number;
  maxWindowsPerRequest: number;
}

export interface PhysicalRequestPlan {
  requestId: string;
  windows: RequestBatchWindow[];
  sourceTokens: number;
}

export interface WindowExecutionSummary {
  status: Extract<
    BookWindowStatus,
    "completed" | "completed_with_warnings" | "human_required" | "failed"
  >;
  modelCalls: number;
  modelCallLimit: number;
  repaired: boolean;
  deadlineExceeded: boolean;
}

export interface AdaptiveConcurrencyOptions {
  warmupWindows: number;
  maxConcurrency: number;
  budgetRiskRatio?: number;
}

export interface NarrativeMemoryRecord {
  questionId: string;
  kind: string;
  subjectIds: string[];
  verdict: string;
  confidence: number;
  channel: "narrative_before_target" | "translator_global";
  visibleFromGlobalIndex: number;
  evidenceIds: string[];
}
