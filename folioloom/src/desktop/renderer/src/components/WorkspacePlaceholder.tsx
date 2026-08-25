import type { JSX } from "react";

import type { DesktopProjectSnapshot } from "../../../contracts.js";
import { WORKSPACES, type WorkspaceId } from "../types.js";

interface WorkspacePlaceholderProps {
  workspace: Extract<WorkspaceId, "review">;
  snapshot: DesktopProjectSnapshot | undefined;
  onChooseProject(): void;
}

const workspaceCopy: Record<Extract<WorkspaceId, "review">, string> = {
  review: "这里将收纳需要人工确认的译文、名称和其他疑问。",
};

export function WorkspacePlaceholder({ workspace, snapshot, onChooseProject }: WorkspacePlaceholderProps): JSX.Element {
  const label = WORKSPACES.find((candidate) => candidate.id === workspace)?.label ?? "工作区";
  return (
    <main className="onboarding-scroll">
      <div className="content-column placeholder-page">
        <p className="eyebrow">{label}</p>
        <h1>{label}</h1>
        <p className="placeholder-lead">
          {snapshot === undefined ? "请先在项目概览中选择一本书稿。" : workspaceCopy[workspace]}
        </p>
        {snapshot === undefined ? (
          <button className="primary-button" type="button" onClick={onChooseProject}>选择书稿</button>
        ) : (
          <section className="placeholder-boundary">
            <p className="eyebrow">当前书稿</p>
            <h2>{snapshot.title}</h2>
            <p>这一工作区将在后续版本接入；当前可在项目概览完成模型连接和片段试译。</p>
          </section>
        )}
      </div>
    </main>
  );
}
