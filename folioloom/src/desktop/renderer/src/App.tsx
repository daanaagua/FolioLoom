import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import type {
  DesktopChooseSourceResult,
  DesktopSourceEncoding,
  DesktopSourceEncodingRequired,
  DesktopSourceLanguageChoice,
  DesktopDiscoverModelsRequest,
  DesktopError,
  DesktopExportDestination,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopExportSnapshot,
  DesktopFullBookProgress,
  DesktopFullBookSnapshot,
  DesktopOptimizationProfile,
  DesktopModelOption,
  DesktopOnboardingState,
  DesktopResult,
  DesktopTestModelRequest,
  DesktopTestModelResult,
  DesktopTrialMode,
  DesktopTrialProgress,
  DesktopTrialResult,
} from "../../contracts.js";
import type { FolioLoomDesktopApi } from "../../preload/folioloom-api.js";
import { Onboarding } from "./components/Onboarding.js";
import { ExportWorkspace } from "./components/ExportWorkspace.js";
import { KnowledgeWorkbench } from "./components/KnowledgeWorkbench.js";
import { RunWorkspace } from "./components/RunWorkspace.js";
import { Sidebar } from "./components/Sidebar.js";
import { WindowTitlebar } from "./components/WindowTitlebar.js";
import { WorkspacePlaceholder } from "./components/WorkspacePlaceholder.js";
import type { BusyAction, WorkspaceId } from "./types.js";

interface AppProps {
  api?: FolioLoomDesktopApi;
}

const emptyOnboarding: DesktopOnboardingState = {
  providers: [],
  readiness: { source: false, model: false, trial: false },
};

function unavailableResult<T = never>(): DesktopResult<T> {
  return {
    ok: false,
    error: {
      code: "DESKTOP_UNAVAILABLE",
      message: "此功能暂时不可用。",
      retryable: true,
    },
  };
}

function unavailableApi(): FolioLoomDesktopApi {
  return {
    chooseSource: async () => unavailableResult(),
    confirmSourceEncoding: async () => unavailableResult(),
    getOnboardingState: async () => unavailableResult(),
    discoverModels: async () => unavailableResult(),
    testModel: async () => unavailableResult(),
    forgetCredential: async () => unavailableResult(),
    startTrial: async (_request) => unavailableResult(),
    cancelTrial: async () => unavailableResult(),
    onTrialProgress: () => () => undefined,
    getFullBookState: async () => unavailableResult(),
    startFullBook: async () => unavailableResult(),
    pauseFullBook: async () => unavailableResult(),
    resumeFullBook: async () => unavailableResult(),
    onFullBookProgress: () => () => undefined,
    getExportState: async () => unavailableResult(),
    chooseExportDirectory: async () => unavailableResult(),
    exportBook: async () => unavailableResult(),
    openExportDirectory: async () => unavailableResult(),
    copyDiagnosticSummary: async () => unavailableResult(),
    exportDiagnostics: async () => unavailableResult(),
    listKnowledge: async () => unavailableResult(),
    getKnowledgeDetail: async () => unavailableResult(),
    mutateKnowledge: async () => unavailableResult(),
    promoteKnowledgeToGlobal: async () => unavailableResult(),
    listGlobalKnowledge: async () => unavailableResult(),
    attachGlobalKnowledge: async () => unavailableResult(),
    getKnowledgeDiagnostics: async () => unavailableResult(),
    chooseKnowledgeImport: async () => unavailableResult(),
    inspectKnowledgeImport: async () => unavailableResult(),
    confirmKnowledgeImportEncoding: async () => unavailableResult(),
    listStagedKnowledgeImports: async () => unavailableResult(),
    getStagedKnowledgeImport: async () => unavailableResult(),
    suggestKnowledgeImport: async () => unavailableResult(),
    stageKnowledgeImport: async () => unavailableResult(),
    decideKnowledgeImport: async () => unavailableResult(),
    commitKnowledgeImport: async () => unavailableResult(),
    rollbackKnowledgeImport: async () => unavailableResult(),
    cancelKnowledgeImportOperation: async () => unavailableResult(),
    cancelPendingKnowledgeImport: async () => unavailableResult(),
    discardStagedKnowledgeImport: async () => unavailableResult(),
    chooseProject: async () => unavailableResult(),
    chooseStore: async () => unavailableResult(),
    refreshProject: async () => unavailableResult(),
    selectRun: async () => unavailableResult(),
    runDoctor: async () => unavailableResult(),
  };
}

function browserApi(): FolioLoomDesktopApi {
  if (typeof window === "undefined" || window.folioLoom === undefined) return unavailableApi();
  return window.folioLoom;
}

function errorFromUnknown(error: unknown): DesktopError {
  return {
    code: "DESKTOP_RENDERER_ERROR",
    message: "操作未完成，请重试。",
    retryable: true,
    ...(error instanceof Error && error.message !== "" ? { technicalDetails: error.message } : {}),
  };
}

function mergeFullBookProgress(
  snapshot: DesktopFullBookSnapshot,
  event: DesktopFullBookProgress,
): DesktopFullBookSnapshot {
  if (!snapshot.runs.some((run) => run.runId === event.runId)) return snapshot;
  return {
    ...snapshot,
    ...(event.phase === "preparing" || event.phase === "running" || event.phase === "pausing"
      ? { activeRunId: event.runId }
      : { activeRunId: undefined }),
    runs: snapshot.runs.map((run) => run.runId !== event.runId ? run : {
      ...run,
      phase: event.phase,
      progress: event.progress,
      canPause: event.phase === "preparing" || event.phase === "running",
      canResume: event.phase === "paused" || event.phase === "failed",
      canExport: event.phase === "completed",
    }),
  };
}

export function App({ api }: AppProps): JSX.Element {
  const fallbackApi = useMemo(browserApi, []);
  const desktopApi = api ?? fallbackApi;
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("overview");
  const [onboarding, setOnboarding] = useState<DesktopOnboardingState>(emptyOnboarding);
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [operationError, setOperationError] = useState<DesktopError>();
  const [trialProgress, setTrialProgress] = useState<DesktopTrialProgress>();
  const [trialResult, setTrialResult] = useState<DesktopTrialResult>();
  const [fullBookSnapshot, setFullBookSnapshot] = useState<DesktopFullBookSnapshot>({ runs: [] });
  const [fullBookError, setFullBookError] = useState<DesktopError>();
  const [exportSnapshot, setExportSnapshot] = useState<DesktopExportSnapshot>({ candidates: [] });
  const [exportDestination, setExportDestination] = useState<DesktopExportDestination>();
  const [exportResult, setExportResult] = useState<DesktopExportResult>();
  const [exportError, setExportError] = useState<DesktopError>();
  const [pendingEncoding, setPendingEncoding] = useState<DesktopSourceEncodingRequired>();
  const [diagnosticFeedback, setDiagnosticFeedback] = useState<string>();
  const onboardingGeneration = useRef(0);
  const projectGeneration = useRef(0);

  function beginOnboardingRefresh(): number {
    onboardingGeneration.current += 1;
    return onboardingGeneration.current;
  }

  function isCurrentOnboardingRefresh(generation: number): boolean {
    return generation === onboardingGeneration.current;
  }

  function acceptOnboarding(result: DesktopResult<DesktopOnboardingState>): boolean {
    if (!result.ok) {
      setOperationError(result.error);
      return false;
    }
    setOnboarding(result.value);
    setOperationError(undefined);
    return true;
  }

  async function refreshFullBookState(showBusy = false): Promise<void> {
    if (onboarding.project === undefined) return;
    const generation = projectGeneration.current;
    if (showBusy) setBusyAction("load-fullbook");
    try {
      const result = await desktopApi.getFullBookState();
      if (generation !== projectGeneration.current) return;
      if (!result.ok) {
        setFullBookError(result.error);
        return;
      }
      setFullBookSnapshot(result.value);
      setFullBookError(undefined);
    } catch (error) {
      if (generation === projectGeneration.current) {
        setFullBookError(errorFromUnknown(error));
      }
    } finally {
      if (showBusy && generation === projectGeneration.current) {
        setBusyAction(undefined);
      }
    }
  }

  async function refreshExportState(showBusy = false): Promise<void> {
    if (onboarding.project === undefined) return;
    const generation = projectGeneration.current;
    if (showBusy) setBusyAction("load-export");
    try {
      const result = await desktopApi.getExportState();
      if (generation !== projectGeneration.current) return;
      if (!result.ok) {
        setExportError(result.error);
        return;
      }
      setExportSnapshot(result.value);
      setExportDestination((current) => current ?? result.value.defaultDestination);
      setExportError(undefined);
    } catch (error) {
      if (generation === projectGeneration.current) {
        setExportError(errorFromUnknown(error));
      }
    } finally {
      if (showBusy && generation === projectGeneration.current) {
        setBusyAction(undefined);
      }
    }
  }

  async function refreshProjectAfterRunChange(): Promise<void> {
    const generation = projectGeneration.current;
    try {
      const [onboardingResult, exportState] = await Promise.all([
        desktopApi.getOnboardingState(),
        desktopApi.getExportState(),
      ]);
      if (generation !== projectGeneration.current) return;
      if (onboardingResult.ok) setOnboarding(onboardingResult.value);
      if (exportState.ok) {
        setExportSnapshot(exportState.value);
        setExportDestination((current) => current ?? exportState.value.defaultDestination);
      }
    } catch {
      // The durable run snapshot remains visible; the next workspace refresh
      // can retry these presentation-only projections.
    }
  }

  useEffect(() => {
    let disposed = false;
    const generation = beginOnboardingRefresh();
    void desktopApi.getOnboardingState()
      .then((result) => {
        if (!disposed && isCurrentOnboardingRefresh(generation)) acceptOnboarding(result);
      })
      .catch((error: unknown) => {
        if (!disposed && isCurrentOnboardingRefresh(generation)) {
          setOperationError(errorFromUnknown(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [desktopApi]);

  useEffect(() => desktopApi.onTrialProgress((progress) => {
    setTrialProgress(progress);
  }), [desktopApi]);

  useEffect(() => desktopApi.onFullBookProgress((progress) => {
    setFullBookSnapshot((current) => mergeFullBookProgress(current, progress));
    void refreshFullBookState(false);
    if (["paused", "completed", "needs_attention", "failed"].includes(progress.phase)) {
      void refreshProjectAfterRunChange();
    }
  }), [desktopApi, onboarding.project?.sourceVersion]);

  const knowledgeAvailable = onboarding.project?.store.state === "ready"
    && onboarding.project.selectedRunId !== undefined;

  useEffect(() => {
    if (activeWorkspace === "memory" && !knowledgeAvailable) {
      setActiveWorkspace("overview");
    }
  }, [activeWorkspace, knowledgeAvailable]);

  useEffect(() => {
    if (onboarding.project === undefined) return;
    if (activeWorkspace === "runs") {
      void refreshFullBookState(true);
    } else if (activeWorkspace === "export") {
      void refreshExportState(true);
    }
  }, [activeWorkspace, desktopApi, onboarding.project?.sourceVersion]);

  async function acceptSourceChoice(
    choice: DesktopChooseSourceResult,
  ): Promise<void> {
    if (choice.status === "encoding_required") {
      setPendingEncoding(choice);
      setOperationError(undefined);
      return;
    }
    setPendingEncoding(undefined);
    // A source identity change invalidates every projected trial artifact even
    // when refreshing the richer onboarding snapshot subsequently fails.
    projectGeneration.current += 1;
    setTrialProgress(undefined);
    setTrialResult(undefined);
    setFullBookSnapshot({ runs: [] });
    setFullBookError(undefined);
    setExportSnapshot({ candidates: [] });
    setExportDestination(undefined);
    setExportResult(undefined);
    setExportError(undefined);
    const generation = beginOnboardingRefresh();
    const stateResult = await desktopApi.getOnboardingState();
    if (!isCurrentOnboardingRefresh(generation)) return;
    if (!stateResult.ok) {
      setOnboarding((current) => ({
        ...current,
        project: choice.project,
        readiness: { ...current.readiness, source: true, trial: false },
      }));
      setOperationError(stateResult.error);
      return;
    }
    acceptOnboarding(stateResult);
  }

  async function chooseSource(
    sourceLanguage: DesktopSourceLanguageChoice = "auto",
  ): Promise<void> {
    setActiveWorkspace("overview");
    setPendingEncoding(undefined);
    setBusyAction("choose-source");
    try {
      const sourceResult = await desktopApi.chooseSource({ sourceLanguage });
      if (!sourceResult.ok) {
        if (sourceResult.error.code === "DESKTOP_SELECTION_CANCELLED") {
          setOperationError(undefined);
          return;
        }
        setOperationError(sourceResult.error);
        return;
      }

      await acceptSourceChoice(sourceResult.value);
    } catch (error) {
      setOperationError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function confirmSourceEncoding(encoding: DesktopSourceEncoding): Promise<void> {
    if (pendingEncoding === undefined) return;
    setBusyAction("confirm-encoding");
    setOperationError(undefined);
    try {
      const result = await desktopApi.confirmSourceEncoding({
        pendingImportId: pendingEncoding.pendingImportId,
        encoding,
      });
      if (!result.ok) {
        setPendingEncoding(undefined);
        setOperationError(result.error);
        return;
      }
      await acceptSourceChoice(result.value);
    } catch (error) {
      setPendingEncoding(undefined);
      setOperationError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function discoverModels(request: DesktopDiscoverModelsRequest): Promise<DesktopResult<readonly DesktopModelOption[]>> {
    setBusyAction("discover-models");
    try {
      const result = await desktopApi.discoverModels(request);
      if (!result.ok) setOperationError(result.error);
      else setOperationError(undefined);
      return result;
    } catch (error) {
      const rendererError = errorFromUnknown(error);
      setOperationError(rendererError);
      return { ok: false, error: rendererError };
    } finally {
      setBusyAction(undefined);
    }
  }

  async function testModel(request: DesktopTestModelRequest): Promise<DesktopResult<DesktopTestModelResult>> {
    setBusyAction("test-model");
    try {
      const result = await desktopApi.testModel(request);
      if (!result.ok) {
        setOperationError(undefined);
        return result;
      }
      beginOnboardingRefresh();
      setOnboarding(result.value.onboarding);
      setOperationError(undefined);
      return result;
    } catch (error) {
      const rendererError = errorFromUnknown(error);
      setOperationError(undefined);
      return { ok: false, error: rendererError };
    } finally {
      setBusyAction(undefined);
    }
  }

  async function forgetCredential(providerId: string): Promise<DesktopResult<DesktopOnboardingState>> {
    setBusyAction("forget-credential");
    try {
      const result = await desktopApi.forgetCredential(providerId);
      if (!result.ok) {
        setOperationError(result.error);
        return result;
      }
      beginOnboardingRefresh();
      setOnboarding(result.value);
      setOperationError(undefined);
      return result;
    } catch (error) {
      const rendererError = errorFromUnknown(error);
      setOperationError(rendererError);
      return { ok: false, error: rendererError };
    } finally {
      setBusyAction(undefined);
    }
  }

  async function startTrial(mode: DesktopTrialMode): Promise<void> {
    setBusyAction("start-trial");
    setTrialResult(undefined);
    setOperationError(undefined);
    try {
      const result = await desktopApi.startTrial({ mode });
      if (!result.ok) {
        if (result.error.code === "DESKTOP_TRIAL_CANCELLED") {
          setTrialProgress(undefined);
        } else {
          setOperationError(result.error);
        }
        return;
      }
      setTrialResult(result.value);
      setTrialProgress({ stage: "completed" });
    } catch (error) {
      setOperationError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function cancelTrial(): Promise<void> {
    setBusyAction("cancel-trial");
    try {
      const result = await desktopApi.cancelTrial();
      if (!result.ok) setOperationError(result.error);
      else setTrialProgress(undefined);
    } catch (error) {
      setOperationError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function startFullBook(
    optimizationProfile: DesktopOptimizationProfile,
  ): Promise<void> {
    setBusyAction("start-fullbook");
    setFullBookError(undefined);
    try {
      const result = await desktopApi.startFullBook({ optimizationProfile });
      if (!result.ok) {
        setFullBookError(result.error);
        return;
      }
      setFullBookSnapshot(result.value);
    } catch (error) {
      setFullBookError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function pauseFullBook(): Promise<void> {
    setBusyAction("pause-fullbook");
    setFullBookError(undefined);
    try {
      const result = await desktopApi.pauseFullBook();
      if (!result.ok) {
        setFullBookError(result.error);
        return;
      }
      setFullBookSnapshot(result.value);
    } catch (error) {
      setFullBookError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function resumeFullBook(runId: string): Promise<void> {
    setBusyAction("resume-fullbook");
    setFullBookError(undefined);
    try {
      const result = await desktopApi.resumeFullBook({ runId });
      if (!result.ok) {
        setFullBookError(result.error);
        return;
      }
      setFullBookSnapshot(result.value);
    } catch (error) {
      setFullBookError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function chooseExportDirectory(): Promise<void> {
    setBusyAction("choose-export-directory");
    try {
      const result = await desktopApi.chooseExportDirectory();
      if (!result.ok) {
        if (result.error.code !== "DESKTOP_SELECTION_CANCELLED") {
          setExportError(result.error);
        }
        return;
      }
      setExportDestination(result.value);
      setExportError(undefined);
    } catch (error) {
      setExportError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function exportBook(request: DesktopExportRequest): Promise<void> {
    setBusyAction("export-book");
    setExportError(undefined);
    setExportResult(undefined);
    try {
      const result = await desktopApi.exportBook(request);
      if (!result.ok) {
        setExportError(result.error);
        return;
      }
      setExportResult(result.value);
      await refreshExportState(false);
    } catch (error) {
      setExportError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function openExportDirectory(exportId: string): Promise<void> {
    setBusyAction("open-export-directory");
    try {
      const result = await desktopApi.openExportDirectory(exportId);
      if (!result.ok) setExportError(result.error);
      else setExportError(undefined);
    } catch (error) {
      setExportError(errorFromUnknown(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function copyDiagnosticSummary(): Promise<void> {
    setBusyAction("copy-diagnostics");
    try {
      const result = await desktopApi.copyDiagnosticSummary();
      setDiagnosticFeedback(result.ok
        ? "诊断摘要已复制"
        : `复制失败：${result.error.message}`);
    } catch (error) {
      setDiagnosticFeedback(`复制失败：${errorFromUnknown(error).message}`);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function exportDiagnostics(): Promise<void> {
    setBusyAction("export-diagnostics");
    try {
      const result = await desktopApi.exportDiagnostics();
      if (!result.ok) {
        if (result.error.code !== "DESKTOP_SELECTION_CANCELLED") {
          setDiagnosticFeedback(`导出失败：${result.error.message}`);
        }
        return;
      }
      setDiagnosticFeedback(`诊断包已导出：${result.value.displayPath}`);
    } catch (error) {
      setDiagnosticFeedback(`导出失败：${errorFromUnknown(error).message}`);
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <div className="workbench-shell">
      <WindowTitlebar />
      <Sidebar
        activeWorkspace={activeWorkspace}
        hasProject={onboarding.project !== undefined}
        knowledgeAvailable={knowledgeAvailable}
        diagnosticBusy={busyAction === "export-diagnostics"}
        diagnosticFeedback={diagnosticFeedback}
        onSelectWorkspace={setActiveWorkspace}
        onExportDiagnostics={() => { void exportDiagnostics(); }}
      />
      <div className="workbench-main">
        {activeWorkspace === "overview" ? (
          <Onboarding
            onboarding={onboarding}
            busyAction={busyAction}
            operationError={operationError}
            trialProgress={trialProgress}
            trialResult={trialResult}
            pendingEncoding={pendingEncoding}
            onChooseSource={chooseSource}
            onConfirmSourceEncoding={confirmSourceEncoding}
            onDiscoverModels={discoverModels}
            onTestModel={testModel}
            onForgetCredential={forgetCredential}
            onStartTrial={startTrial}
            onCancelTrial={cancelTrial}
            onCopyDiagnosticSummary={() => { void copyDiagnosticSummary(); }}
            onExportDiagnostics={() => { void exportDiagnostics(); }}
          />
        ) : activeWorkspace === "runs" && onboarding.project !== undefined ? (
          <RunWorkspace
            title={onboarding.project.title}
            modelReady={onboarding.activeModel?.capability === "ready"}
            snapshot={fullBookSnapshot}
            busy={busyAction === "load-fullbook"
              || busyAction === "start-fullbook"
              || busyAction === "pause-fullbook"
              || busyAction === "resume-fullbook"
              || busyAction === "export-diagnostics"}
            error={fullBookError}
            onStart={(profile) => { void startFullBook(profile); }}
            onPause={() => { void pauseFullBook(); }}
            onResume={(runId) => { void resumeFullBook(runId); }}
            onExportDiagnostics={() => { void exportDiagnostics(); }}
          />
        ) : activeWorkspace === "memory" && knowledgeAvailable ? (
          <KnowledgeWorkbench
            key={`${onboarding.project?.sourceVersion ?? "none"}:${onboarding.project?.selectedRunId ?? "none"}`}
            api={desktopApi}
          />
        ) : activeWorkspace === "export" && onboarding.project !== undefined ? (
          <ExportWorkspace
            title={onboarding.project.title}
            snapshot={exportSnapshot}
            destination={exportDestination}
            result={exportResult}
            busy={busyAction === "load-export"
              || busyAction === "choose-export-directory"
              || busyAction === "export-book"
              || busyAction === "open-export-directory"}
            error={exportError}
            onChooseDirectory={() => { void chooseExportDirectory(); }}
            onExport={(request) => { void exportBook(request); }}
            onOpenDirectory={(exportId) => { void openExportDirectory(exportId); }}
          />
        ) : (
          <WorkspacePlaceholder
            workspace="review"
            snapshot={onboarding.project}
            onChooseProject={() => { void chooseSource("auto"); }}
          />
        )}
      </div>
    </div>
  );
}
