import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DESKTOP_TRIAL_PROGRESS_CHANNEL,
  DESKTOP_FULLBOOK_PROGRESS_CHANNEL,
  type DesktopTrialProgress,
  type DesktopTrialStage,
} from "../contracts.js";
import type { FolioLoomDesktopApi } from "./folioloom-api.js";
import { parseDesktopFullBookProgress } from "./progress-validation.js";

const TRIAL_STAGES = new Set<DesktopTrialStage>([
  "preparing",
  "translating",
  "checking",
  "completed",
  "failed",
]);

function trialProgress(value: unknown): DesktopTrialProgress | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.stage !== "string") return undefined;
  return TRIAL_STAGES.has(record.stage as DesktopTrialStage)
    ? { stage: record.stage as DesktopTrialStage }
    : undefined;
}

const desktopApi: FolioLoomDesktopApi = {
  chooseSource: (request) => request === undefined
    ? ipcRenderer.invoke("folioloom:choose-source")
    : ipcRenderer.invoke("folioloom:choose-source", request),
  confirmSourceEncoding: (request) => ipcRenderer.invoke("folioloom:confirm-source-encoding", request),
  getOnboardingState: () => ipcRenderer.invoke("folioloom:onboarding-state"),
  discoverModels: (request) => ipcRenderer.invoke("folioloom:discover-models", request),
  testModel: (request) => ipcRenderer.invoke("folioloom:test-model", request),
  forgetCredential: (providerId) => ipcRenderer.invoke("folioloom:forget-credential", providerId),
  startTrial: (request) => ipcRenderer.invoke("folioloom:start-trial", request),
  cancelTrial: () => ipcRenderer.invoke("folioloom:cancel-trial"),
  onTrialProgress: (listener) => {
    const forward = (_event: IpcRendererEvent, value: unknown): void => {
      const progress = trialProgress(value);
      if (progress !== undefined) listener(progress);
    };
    ipcRenderer.on(DESKTOP_TRIAL_PROGRESS_CHANNEL, forward);
    return () => ipcRenderer.removeListener(DESKTOP_TRIAL_PROGRESS_CHANNEL, forward);
  },
  getFullBookState: () => ipcRenderer.invoke("folioloom:fullbook-state"),
  startFullBook: (request) => ipcRenderer.invoke("folioloom:start-fullbook", request),
  pauseFullBook: () => ipcRenderer.invoke("folioloom:pause-fullbook"),
  resumeFullBook: (request) => ipcRenderer.invoke("folioloom:resume-fullbook", request),
  onFullBookProgress: (listener) => {
    const forward = (_event: IpcRendererEvent, value: unknown): void => {
      const progress = parseDesktopFullBookProgress(value);
      if (progress !== undefined) listener(progress);
    };
    ipcRenderer.on(DESKTOP_FULLBOOK_PROGRESS_CHANNEL, forward);
    return () => ipcRenderer.removeListener(DESKTOP_FULLBOOK_PROGRESS_CHANNEL, forward);
  },
  getExportState: () => ipcRenderer.invoke("folioloom:export-state"),
  chooseExportDirectory: () => ipcRenderer.invoke("folioloom:choose-export-directory"),
  exportBook: (request) => ipcRenderer.invoke("folioloom:export-book", request),
  openExportDirectory: (exportId) =>
    ipcRenderer.invoke("folioloom:open-export-directory", exportId),
  copyDiagnosticSummary: () =>
    ipcRenderer.invoke("folioloom:copy-diagnostic-summary"),
  exportDiagnostics: () =>
    ipcRenderer.invoke("folioloom:export-diagnostics"),
  listKnowledge: (request) => ipcRenderer.invoke("folioloom:knowledge-list", request),
  getKnowledgeDetail: (objectId) => ipcRenderer.invoke("folioloom:knowledge-detail", objectId),
  mutateKnowledge: (request) => ipcRenderer.invoke("folioloom:knowledge-mutate", request),
  promoteKnowledgeToGlobal: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-promote-global", request),
  listGlobalKnowledge: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-global-list", request),
  attachGlobalKnowledge: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-global-attach", request),
  getKnowledgeDiagnostics: () =>
    ipcRenderer.invoke("folioloom:knowledge-diagnostics"),
  chooseKnowledgeImport: () =>
    ipcRenderer.invoke("folioloom:knowledge-import-choose"),
  inspectKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-inspect", request),
  confirmKnowledgeImportEncoding: (request) =>
    ipcRenderer.invoke(
      "folioloom:knowledge-import-confirm-encoding",
      request,
    ),
  listStagedKnowledgeImports: () =>
    ipcRenderer.invoke("folioloom:knowledge-import-list-staged"),
  getStagedKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-get-staged", request),
  suggestKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-suggest", request),
  stageKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-stage", request),
  decideKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-decide", request),
  commitKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-commit", request),
  rollbackKnowledgeImport: (request) =>
    ipcRenderer.invoke("folioloom:knowledge-import-rollback", request),
  cancelKnowledgeImportOperation: (request) =>
    ipcRenderer.invoke(
      "folioloom:knowledge-import-cancel-operation",
      request,
    ),
  cancelPendingKnowledgeImport: (pendingImportId) =>
    ipcRenderer.invoke(
      "folioloom:knowledge-import-cancel-pending",
      pendingImportId,
    ),
  discardStagedKnowledgeImport: (request) =>
    ipcRenderer.invoke(
      "folioloom:knowledge-import-discard-staged",
      request,
    ),
  chooseProject: () => ipcRenderer.invoke("folioloom:choose-project"),
  chooseStore: () => ipcRenderer.invoke("folioloom:choose-store"),
  refreshProject: () => ipcRenderer.invoke("folioloom:refresh-project"),
  selectRun: (runId) => ipcRenderer.invoke("folioloom:select-run", runId),
  runDoctor: () => ipcRenderer.invoke("folioloom:doctor"),
};

contextBridge.exposeInMainWorld("folioLoom", desktopApi);
