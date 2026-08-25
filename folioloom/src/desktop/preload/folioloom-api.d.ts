import type {
  DesktopChooseSourceResult,
  DesktopChooseSourceRequest,
  DesktopConfirmSourceEncodingRequest,
  DesktopDiscoverModelsRequest,
  DesktopDoctorReport,
  DesktopDiagnosticExportResult,
  DesktopExportDestination,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopExportSnapshot,
  DesktopFullBookProgress,
  DesktopFullBookSnapshot,
  DesktopResumeFullBookRequest,
  DesktopStartFullBookRequest,
  DesktopAttachGlobalKnowledgeRequest,
  DesktopGlobalKnowledgeListRequest,
  DesktopGlobalKnowledgePage,
  DesktopKnowledgeDetail,
  DesktopKnowledgeDiagnostics,
  DesktopKnowledgeListRequest,
  DesktopKnowledgeMutationRequest,
  DesktopKnowledgeMutationResult,
  DesktopKnowledgePage,
  DesktopPromoteKnowledgeRequest,
  DesktopSuggestKnowledgeImportRequest,
  DesktopModelOption,
  DesktopOnboardingState,
  DesktopProjectSnapshot,
  DesktopResult,
  DesktopStartTrialRequest,
  DesktopTestModelRequest,
  DesktopTestModelResult,
  DesktopTrialProgress,
  DesktopTrialResult,
  CancelImportOperationRequest,
  CommitImportRequest,
  CommittedImportReport,
  ConfirmImportEncodingRequest,
  DiscardStagedImportRequest,
  ImportDecisionRequest,
  ImportInspectionResult,
  InspectImportRequest,
  MappingSuggestion,
  PendingKnowledgeImport,
  RollbackImportRequest,
  RolledBackImportReport,
  StageImportRequest,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "../contracts.js";

export interface FolioLoomDesktopApi {
  chooseSource(request?: DesktopChooseSourceRequest): Promise<DesktopResult<DesktopChooseSourceResult>>;
  confirmSourceEncoding(
    request: DesktopConfirmSourceEncodingRequest,
  ): Promise<DesktopResult<DesktopChooseSourceResult>>;
  getOnboardingState(): Promise<DesktopResult<DesktopOnboardingState>>;
  discoverModels(request: DesktopDiscoverModelsRequest): Promise<DesktopResult<readonly DesktopModelOption[]>>;
  testModel(request: DesktopTestModelRequest): Promise<DesktopResult<DesktopTestModelResult>>;
  forgetCredential(providerId: string): Promise<DesktopResult<DesktopOnboardingState>>;
  startTrial(request: DesktopStartTrialRequest): Promise<DesktopResult<DesktopTrialResult>>;
  cancelTrial(): Promise<DesktopResult<void>>;
  onTrialProgress(listener: (progress: DesktopTrialProgress) => void): () => void;
  getFullBookState(): Promise<DesktopResult<DesktopFullBookSnapshot>>;
  startFullBook(
    request: DesktopStartFullBookRequest,
  ): Promise<DesktopResult<DesktopFullBookSnapshot>>;
  pauseFullBook(): Promise<DesktopResult<DesktopFullBookSnapshot>>;
  resumeFullBook(
    request: DesktopResumeFullBookRequest,
  ): Promise<DesktopResult<DesktopFullBookSnapshot>>;
  onFullBookProgress(listener: (value: DesktopFullBookProgress) => void): () => void;
  getExportState(): Promise<DesktopResult<DesktopExportSnapshot>>;
  chooseExportDirectory(): Promise<DesktopResult<DesktopExportDestination>>;
  exportBook(request: DesktopExportRequest): Promise<DesktopResult<DesktopExportResult>>;
  openExportDirectory(exportId: string): Promise<DesktopResult<void>>;
  copyDiagnosticSummary(): Promise<DesktopResult<void>>;
  exportDiagnostics(): Promise<DesktopResult<DesktopDiagnosticExportResult>>;
  listKnowledge(request: DesktopKnowledgeListRequest): Promise<DesktopResult<DesktopKnowledgePage>>;
  getKnowledgeDetail(objectId: string): Promise<DesktopResult<DesktopKnowledgeDetail>>;
  mutateKnowledge(request: DesktopKnowledgeMutationRequest): Promise<DesktopResult<DesktopKnowledgeMutationResult>>;
  promoteKnowledgeToGlobal(request: DesktopPromoteKnowledgeRequest): Promise<DesktopResult<DesktopKnowledgeMutationResult>>;
  listGlobalKnowledge(request: DesktopGlobalKnowledgeListRequest): Promise<DesktopResult<DesktopGlobalKnowledgePage>>;
  attachGlobalKnowledge(request: DesktopAttachGlobalKnowledgeRequest): Promise<DesktopResult<DesktopKnowledgeMutationResult>>;
  getKnowledgeDiagnostics(): Promise<DesktopResult<DesktopKnowledgeDiagnostics>>;
  chooseKnowledgeImport(): Promise<DesktopResult<PendingKnowledgeImport>>;
  inspectKnowledgeImport(request: InspectImportRequest): Promise<DesktopResult<ImportInspectionResult>>;
  confirmKnowledgeImportEncoding(request: ConfirmImportEncodingRequest): Promise<DesktopResult<ImportInspectionResult>>;
  listStagedKnowledgeImports(): Promise<DesktopResult<readonly StagedImportSummary[]>>;
  getStagedKnowledgeImport(request: StagedImportPageRequest): Promise<DesktopResult<StagedImportReport>>;
  suggestKnowledgeImport(request: DesktopSuggestKnowledgeImportRequest): Promise<DesktopResult<MappingSuggestion>>;
  stageKnowledgeImport(request: StageImportRequest): Promise<DesktopResult<StagedImportReport>>;
  decideKnowledgeImport(request: ImportDecisionRequest): Promise<DesktopResult<StagedImportReport>>;
  commitKnowledgeImport(request: CommitImportRequest): Promise<DesktopResult<CommittedImportReport>>;
  rollbackKnowledgeImport(request: RollbackImportRequest): Promise<DesktopResult<RolledBackImportReport>>;
  cancelKnowledgeImportOperation(request: CancelImportOperationRequest): Promise<DesktopResult<void>>;
  cancelPendingKnowledgeImport(pendingImportId: string): Promise<DesktopResult<void>>;
  discardStagedKnowledgeImport(request: DiscardStagedImportRequest): Promise<DesktopResult<void>>;
  chooseProject(): Promise<DesktopResult<DesktopProjectSnapshot>>;
  chooseStore(): Promise<DesktopResult<DesktopProjectSnapshot>>;
  refreshProject(): Promise<DesktopResult<DesktopProjectSnapshot>>;
  selectRun(runId: string): Promise<DesktopResult<DesktopProjectSnapshot>>;
  runDoctor(): Promise<DesktopResult<DesktopDoctorReport>>;
}

declare global {
  interface Window {
    folioLoom: FolioLoomDesktopApi;
  }
}

export {};
