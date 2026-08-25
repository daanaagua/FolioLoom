export type BusyAction =
  | "choose-source"
  | "confirm-encoding"
  | "discover-models"
  | "test-model"
  | "forget-credential"
  | "start-trial"
  | "cancel-trial"
  | "load-fullbook"
  | "start-fullbook"
  | "pause-fullbook"
  | "resume-fullbook"
  | "load-export"
  | "choose-export-directory"
  | "export-book"
  | "open-export-directory"
  | "copy-diagnostics"
  | "export-diagnostics"
  | "choose-project"
  | "choose-store"
  | "refresh"
  | "select-run"
  | "doctor"
  | undefined;

export const WORKSPACES = [
  { id: "overview", label: "项目概览", detail: "原文与状态" },
  { id: "runs", label: "翻译运行", detail: "运行记录" },
  { id: "memory", label: "术语与记忆", detail: "知识脉络" },
  { id: "review", label: "审阅队列", detail: "待确认内容" },
  { id: "export", label: "导出", detail: "交付文件" },
] as const;

export type WorkspaceId = (typeof WORKSPACES)[number]["id"];
