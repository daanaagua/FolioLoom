import type { JSX } from "react";

import { WORKSPACES, type WorkspaceId } from "../types.js";

interface SidebarProps {
  activeWorkspace: WorkspaceId;
  hasProject: boolean;
  knowledgeAvailable: boolean;
  diagnosticBusy: boolean;
  diagnosticFeedback?: string;
  onSelectWorkspace(workspace: WorkspaceId): void;
  onExportDiagnostics(): void;
}

export function Sidebar({
  activeWorkspace,
  hasProject,
  knowledgeAvailable,
  diagnosticBusy,
  diagnosticFeedback,
  onSelectWorkspace,
  onExportDiagnostics,
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <img className="brand-mark" src="./folioloom-mark.svg" alt="" />
        <div>
          <p className="brand-name">FolioLoom</p>
          <p className="brand-subtitle">本地文稿工作台</p>
        </div>
      </div>

      <nav className="workspace-nav" aria-label="工作区">
        <p className="nav-label">工作区</p>
        {WORKSPACES.map((workspace, index) => {
          const selected = workspace.id === activeWorkspace;
          const available = workspace.id === "overview"
            || (workspace.id === "memory" && knowledgeAvailable)
            || (workspace.id !== "memory" && hasProject);
          return (
            <button
              className={`nav-item${selected ? " is-active" : ""}`}
              type="button"
              key={workspace.id}
              aria-label={workspace.label}
              aria-current={selected ? "page" : undefined}
              disabled={!available}
              onClick={() => {
                if (available) onSelectWorkspace(workspace.id);
              }}
            >
              <span className="nav-index" aria-hidden="true">0{index + 1}</span>
              <span>
                <span className="nav-name">{workspace.label}</span>
                <span className="nav-detail">{workspace.detail}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footnote">
        <div className="sidebar-project-state">
          <span className={`connection-dot${hasProject ? " is-ready" : ""}`} aria-hidden="true" />
          <span>{hasProject ? "书稿已打开" : "等待书稿"}</span>
        </div>
        <button
          className="sidebar-diagnostic-button"
          type="button"
          disabled={diagnosticBusy}
          onClick={onExportDiagnostics}
        >
          {diagnosticBusy ? "正在导出…" : "导出诊断"}
        </button>
        {diagnosticFeedback === undefined ? null : (
          <p className="sidebar-diagnostic-feedback" role="status">{diagnosticFeedback}</p>
        )}
      </div>
    </aside>
  );
}
