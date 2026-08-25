export type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopError };

export interface DesktopError {
  code: string;
  message: string;
  nextAction?: string;
  retryable: boolean;
  technicalDetails?: string;
}

export interface DesktopRunSummary {
  runId: string;
  sourceVersion: string;
  modelId: string;
  status: string;
  progress: {
    totalWindows: number;
    pendingWindows: number;
    completedWindows: number;
    warningWindows: number;
    humanRequiredWindows: number;
    failedWindows: number;
  };
}

export interface DesktopProjectSnapshot {
  title: string;
  sourceLanguage: string;
  /** Chinese reader-facing label for the detected source language. */
  detectedLanguage: string;
  /** Canonical source encoding, e.g. `utf-8`. */
  sourceEncoding: string;
  /** Detector confidence in the canonical encoding, from 0 to 1. */
  encodingConfidence: number;
  languageProfileVersion: string;
  sourceChars: number;
  sourceVersion: string;
  store: {
    state: "not_found" | "ready" | "invalid";
    error?: DesktopError;
  };
  runs: DesktopRunSummary[];
  selectedRunId?: string;
  runSelection: "none" | "selected" | "required";
}

export type DesktopSourceEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "utf-32le"
  | "utf-32be"
  | "shift_jis"
  | "euc-jp"
  | "euc-kr"
  | "windows-949"
  | "windows-1252";

export interface DesktopSourceEncodingRequired {
  status: "encoding_required";
  pendingImportId: string;
  fileName: string;
  encodings: readonly DesktopSourceEncoding[];
}

export type DesktopSourceLanguageChoice =
  | "auto"
  | "en"
  | "de"
  | "fr"
  | "es"
  | "ru"
  | "ja"
  | "ko";

export interface DesktopChooseSourceRequest {
  sourceLanguage?: DesktopSourceLanguageChoice;
}

export type DesktopChooseSourceResult =
  | { status: "ready"; project: DesktopProjectSnapshot }
  | DesktopSourceEncodingRequired;

export interface DesktopConfirmSourceEncodingRequest {
  pendingImportId: string;
  encoding: DesktopSourceEncoding;
}

export interface DesktopDoctorReport {
  sourceVersion: string;
  sourceChars: number;
  coveredChars: number;
  annotationCount: number;
  blockCount: number;
  windowCount: number;
  incidentCodes: string[];
  anomalyCount: number;
  glossary?: {
    path: string;
    totalTerms: number;
    matchedTerms: number;
    unmatchedTerms: number;
    unmatchedForms: string[];
  };
}

export interface DesktopProjectRequest {
  manifestPath: string;
  storePath?: string;
  runId?: string;
  glossaryPath?: string;
}

export interface DesktopRecentProject {
  manifestPath: string;
  storePath?: string;
  runId?: string;
}

/**
 * Renderer-facing provider data. It intentionally does not include a preset
 * base URL, a runtime instance, or any form of credential.
 */
export interface DesktopOnboardingProvider {
  id: string;
  displayName: string;
  keyPlaceholder: string;
  efforts: readonly string[];
  fallbackModelIds: readonly string[];
  allowManualModel: boolean;
  allowCustomBaseUrl: boolean;
  credentialStatus: "available" | "missing" | "needs_reentry";
  credentialPersistence?: "encrypted" | "session";
}

export interface DesktopModelOption {
  id: string;
  displayName: string;
}

export interface DesktopModelProbe {
  status: "ready" | "limited" | "failed";
  providerId?: string;
  modelId?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  checkedAt?: string;
}

export interface DesktopModelSummary {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  customBaseUrl?: string;
  capability: DesktopModelProbe["status"] | "unverified";
}

export interface DesktopOnboardingState {
  project?: DesktopProjectSnapshot;
  providers: readonly DesktopOnboardingProvider[];
  activeModel?: DesktopModelSummary;
  latestProbe?: DesktopModelProbe;
  readiness: {
    source: boolean;
    model: boolean;
    trial: boolean;
  };
}

/** A one-shot credential may enter only through a request, never a response. */
export interface DesktopDiscoverModelsRequest {
  providerId: string;
  apiKey?: string;
  customBaseUrl?: string;
}

export interface DesktopTestModelRequest {
  providerId: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: string;
  customBaseUrl?: string;
}

export interface DesktopTestModelResult {
  report: DesktopModelProbe;
  onboarding: DesktopOnboardingState;
}

export type DesktopTrialMode = "quality" | "fast";

export type DesktopOptimizationProfile =
  | "economy"
  | "balanced"
  | "speed";

/** Renderer-controlled choice; project identity remains in the main process. */
export interface DesktopStartTrialRequest {
  mode: DesktopTrialMode;
}

export type DesktopTrialStage =
  | "preparing"
  | "translating"
  | "checking"
  | "completed"
  | "failed";

export const DESKTOP_TRIAL_PROGRESS_CHANNEL = "folioloom:trial-progress" as const;

export interface DesktopTrialProgress {
  stage: DesktopTrialStage;
}

export interface DesktopTrialResult {
  runId: string;
  sourceText: string;
  translationText: string;
}

export type DesktopFullBookPhase =
  | "idle"
  | "preparing"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "needs_attention"
  | "failed";

export type DesktopFullBookWindowProgress = DesktopRunSummary["progress"] & {
  runningWindows: number;
  stagedWindows: number;
};

export type DesktopAttentionCategory =
  | "provider"
  | "protocol"
  | "validation"
  | "budget"
  | "source"
  | "storage"
  | "unknown";

export interface DesktopAttentionItem {
  windowId: string;
  ordinal: number;
  location: string;
  sourceChars: number;
  attemptCount: number;
  status: "human_required" | "failed";
  category: DesktopAttentionCategory;
  code: string;
  title: string;
  explanation: string;
  nextAction: string;
  retryable: boolean;
}

export interface DesktopAttentionSummary {
  items: readonly DesktopAttentionItem[];
  totalItems: number;
  truncated: boolean;
  retryAvailable: boolean;
  retryAttempted: boolean;
}

export interface DesktopFullBookRunSnapshot {
  runId: string;
  sourceVersion: string;
  modelId: string;
  mode: DesktopTrialMode;
  optimizationProfile: DesktopOptimizationProfile;
  phase: DesktopFullBookPhase;
  progress: DesktopFullBookWindowProgress;
  scheduler?: {
    estimatedRemainingMs?: number;
    predictedTokenRange?: {
      lower: number;
      upper: number;
    };
    wallTimeDeviationPercent?: number;
    tokenDeviationPercent?: number;
    adjustment: "planning" | "steady" | "throttled" | "recovering";
  };
  canPause: boolean;
  canResume: boolean;
  canExport: boolean;
  attention?: DesktopAttentionSummary;
  error?: DesktopError;
}

export interface DesktopFullBookSnapshot {
  activeRunId?: string;
  runs: readonly DesktopFullBookRunSnapshot[];
}

export interface DesktopStartFullBookRequest {
  optimizationProfile: DesktopOptimizationProfile;
}

export interface DesktopResumeFullBookRequest {
  runId: string;
}

export const DESKTOP_FULLBOOK_PROGRESS_CHANNEL =
  "folioloom:fullbook-progress" as const;

export interface DesktopFullBookProgress {
  runId: string;
  phase: DesktopFullBookPhase;
  progress: DesktopFullBookWindowProgress;
}

export type DesktopExportFormat =
  | "translation_txt"
  | "bilingual_txt"
  | "epub";

export interface DesktopExportCandidate {
  runId: string;
  modelId: string;
  status: "ready" | "incomplete" | "blocked";
  completedWindows: number;
  totalWindows: number;
  blockers: readonly string[];
}

export interface DesktopExportDestination {
  destinationId: string;
  displayPath: string;
}

export interface DesktopExportSnapshot {
  candidates: readonly DesktopExportCandidate[];
  defaultDestination?: DesktopExportDestination;
}

export interface DesktopExportRequest {
  runId: string;
  destinationId: string;
  formats: readonly DesktopExportFormat[];
}

export interface DesktopExportResult {
  exportId: string;
  runId: string;
  directory: string;
  files: readonly {
    format: DesktopExportFormat | "audit" | "metrics";
    fileName: string;
  }[];
}

export interface DesktopDiagnosticExportResult {
  fileName: string;
  /** The destination explicitly chosen by the user, never the internal log directory. */
  displayPath: string;
}

export type {
  DesktopAttachGlobalKnowledgeRequest,
  DesktopGlobalKnowledgeListRequest,
  DesktopGlobalKnowledgePage,
  DesktopKnowledgeDetail,
  DesktopKnowledgeDiagnostics,
  DesktopKnowledgeEvidence,
  DesktopKnowledgeListRequest,
  DesktopKnowledgeMutationRequest,
  DesktopKnowledgeMutationResult,
  DesktopKnowledgePage,
  DesktopKnowledgeScopeRevision,
  DesktopPromoteKnowledgeRequest,
  DesktopSuggestKnowledgeImportRequest,
} from "./knowledge-contracts.js";
export type {
  CancelImportOperationRequest,
  CommitImportRequest,
  CommittedImportReport,
  ConfirmImportEncodingRequest,
  DiscardStagedImportRequest,
  ImportFieldMapping,
  ImportConflictDecision,
  ImportDecisionRequest,
  ImportInspection,
  ImportInspectionResult,
  ImportPreviewRow,
  ImportSelection,
  InspectImportRequest,
  MappingSuggestion,
  PendingKnowledgeImport,
  RollbackImportRequest,
  RolledBackImportReport,
  StageImportRequest,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "./knowledge-contracts.js";
export { MAX_STAGED_IMPORT_PAGE_SIZE } from "./knowledge-contracts.js";
