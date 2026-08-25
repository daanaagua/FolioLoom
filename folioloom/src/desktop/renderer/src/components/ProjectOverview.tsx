import type { JSX } from "react";

import type { DesktopDoctorReport, DesktopProjectSnapshot, DesktopResult } from "../../../contracts.js";
import type { BusyAction } from "../types.js";

interface ProjectOverviewProps {
  snapshot: DesktopProjectSnapshot | undefined;
  doctorResult: DesktopResult<DesktopDoctorReport> | undefined;
  busyAction: BusyAction;
  operationError: { code: string; message: string } | undefined;
  onChooseProject(): void;
  onChooseStore(): void;
  onRefresh(): void;
  onSelectRun(runId: string): void;
  onRunDoctor(): void;
}

/**
 * Kept as a narrow compatibility surface while the main app is onboarding
 * first.  It deliberately uses reader-facing terms if a later route renders
 * it again.
 */
export function ProjectOverview({ snapshot, busyAction, onChooseProject }: ProjectOverviewProps): JSX.Element {
  return (
    <main className="onboarding-scroll">
      <div className="onboarding-column">
        <p className="eyebrow">书稿</p>
        <h1>{snapshot?.title ?? "选择一本书开始"}</h1>
        <p className="section-copy">从准备页选择书稿、连接模型，再开始试译。</p>
        <button className="primary-button" type="button" onClick={onChooseProject} disabled={busyAction !== undefined}>
          选择书稿
        </button>
      </div>
    </main>
  );
}
