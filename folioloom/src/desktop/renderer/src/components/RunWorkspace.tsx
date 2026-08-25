import { useMemo, useState, type JSX } from "react";

import type {
  DesktopError,
  DesktopFullBookRunSnapshot,
  DesktopFullBookSnapshot,
  DesktopOptimizationProfile,
} from "../../../contracts.js";
import { TechnicalDetails, redactTechnicalDetails } from "./TechnicalDetails.js";

interface RunWorkspaceProps {
  title: string;
  modelReady: boolean;
  snapshot: DesktopFullBookSnapshot;
  busy: boolean;
  error?: DesktopError;
  onStart(profile: DesktopOptimizationProfile): void;
  onPause(): void;
  onResume(runId: string): void;
  onExportDiagnostics(): void;
}

const phaseCopy: Readonly<Record<DesktopFullBookRunSnapshot["phase"], string>> = {
  idle: "尚未开始",
  preparing: "正在准备翻译",
  running: "翻译中",
  pausing: "正在完成当前文本块后暂停",
  paused: "已暂停，进度已保存",
  completed: "整本翻译已完成",
  needs_attention: "有内容需要处理",
  failed: "运行中断，进度已保存",
};

const phaseBadge: Readonly<Record<DesktopFullBookRunSnapshot["phase"], string>> = {
  idle: "未开始",
  preparing: "准备中",
  running: "运行中",
  pausing: "暂停中",
  paused: "已暂停",
  completed: "已完成",
  needs_attention: "需要处理",
  failed: "已中断",
};

const profileCopy: Readonly<Record<DesktopOptimizationProfile, {
  label: string;
  detail: string;
}>> = {
  economy: {
    label: "经济",
    detail: "优先控制 token 与调用成本",
  },
  balanced: {
    label: "均衡",
    detail: "兼顾速度、成本与恢复余量",
  },
  speed: {
    label: "极速",
    detail: "在质量门内优先缩短完成时间",
  },
};

function estimatedTime(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "计算中";
  if (milliseconds < 60_000) {
    return `${Math.max(0, Math.ceil(milliseconds / 1_000))} 秒`;
  }
  return `${Math.ceil(milliseconds / 60_000)} 分钟`;
}

function tokenRange(
  range: NonNullable<DesktopFullBookRunSnapshot["scheduler"]>["predictedTokenRange"],
): string {
  if (range === undefined) return "计算中";
  return `${range.lower.toLocaleString("zh-CN")}–${range.upper.toLocaleString("zh-CN")}`;
}

function signedPercent(value: number | undefined): string {
  if (value === undefined) return "计算中";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function schedulerStatus(run: DesktopFullBookRunSnapshot): string {
  switch (run.scheduler?.adjustment) {
    case "throttled":
      return "正在因限流调整并发";
    case "recovering":
      return "正在根据失败恢复结果调整计划";
    case "steady":
      return "当前计划运行稳定";
    case "planning":
    default:
      return run.phase === "completed" ? "计划执行完成" : "正在生成调度估算";
  }
}

function currentRun(snapshot: DesktopFullBookSnapshot): DesktopFullBookRunSnapshot | undefined {
  return snapshot.runs.find((run) => run.runId === snapshot.activeRunId)
    ?? snapshot.runs.at(-1);
}

export function RunWorkspace({
  title,
  modelReady,
  snapshot,
  busy,
  error,
  onStart,
  onPause,
  onResume,
  onExportDiagnostics,
}: RunWorkspaceProps): JSX.Element {
  const [selectedProfile, setSelectedProfile] =
    useState<DesktopOptimizationProfile>("balanced");
  const run = useMemo(() => currentRun(snapshot), [snapshot]);
  const completed = run === undefined
    ? 0
    : run.progress.completedWindows + run.progress.warningWindows;
  const total = run?.progress.totalWindows ?? 0;
  const progressMaximum = Math.max(total, 1);

  return (
    <main className="onboarding-scroll">
      <div className="content-column workspace-page">
        <header className="workspace-heading">
          <p className="eyebrow">FolioLoom / Full book</p>
          <h1>翻译运行</h1>
          <p>{title}</p>
        </header>

        {run === undefined ? (
          <section className="workspace-card run-start-card">
            <div>
              <p className="eyebrow">运行方式</p>
              <h2>开始整本翻译</h2>
              <p className="workspace-copy">
                系统会保存每个文本块的结果，关闭程序前暂停即可在下次继续。
              </p>
            </div>
            <div
              className="profile-choice"
              role="group"
              aria-label="优化档案"
            >
              {(["economy", "balanced", "speed"] as const).map((profile) => (
                <button
                  key={profile}
                  type="button"
                  aria-label={profileCopy[profile].label}
                  aria-pressed={selectedProfile === profile}
                  disabled={busy}
                  onClick={() => setSelectedProfile(profile)}
                >
                  <strong>{profileCopy[profile].label}</strong>
                  <small>{profileCopy[profile].detail}</small>
                </button>
              ))}
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!modelReady || busy}
              onClick={() => onStart(selectedProfile)}
            >
              {busy ? "正在启动" : "开始整本翻译"}
            </button>
            {!modelReady ? <p className="workspace-hint">请先在项目概览完成模型连接测试。</p> : null}
          </section>
        ) : (
          <section className="workspace-card run-progress-card">
            <header className="run-progress-header">
              <div>
                <p className="eyebrow">当前状态</p>
                <h2>{phaseCopy[run.phase]}</h2>
              </div>
              <span className={`run-state is-${run.phase}`}>{phaseBadge[run.phase]}</span>
            </header>

            <div className="progress-copy">
              <strong>{completed} / {total} 个文本块</strong>
              <span>{total === 0 ? "等待生成分块计划" : `${Math.round((completed / total) * 100)}%`}</span>
            </div>
            <progress
              aria-label="整本翻译进度"
              aria-valuenow={completed}
              aria-valuemin={0}
              aria-valuemax={total}
              value={completed}
              max={progressMaximum}
            />

            <div className="run-metrics">
              <article><span>等待</span><strong>{run.progress.pendingWindows}</strong></article>
              <article><span>进行中</span><strong>{run.progress.runningWindows}</strong></article>
              <article><span>警告</span><strong>{run.progress.warningWindows}</strong></article>
              <article><span>需要处理</span><strong>{run.progress.humanRequiredWindows}</strong></article>
            </div>

            <div className="scheduler-metrics">
              <article>
                <span>预计剩余时间</span>
                <strong>{estimatedTime(run.scheduler?.estimatedRemainingMs)}</strong>
              </article>
              <article>
                <span>预计 token 区间</span>
                <strong>{tokenRange(run.scheduler?.predictedTokenRange)}</strong>
              </article>
              <article>
                <span>实际与预计偏差</span>
                <strong>
                  耗时 {signedPercent(run.scheduler?.wallTimeDeviationPercent)}
                  {" · "}
                  Token {signedPercent(run.scheduler?.tokenDeviationPercent)}
                </strong>
              </article>
            </div>
            <p className="scheduler-status">{schedulerStatus(run)}</p>

            {run.phase === "needs_attention" ? (
              <div className="workspace-notice is-warning">
                {run.progress.humanRequiredWindows > 0
                  ? <p>{run.progress.humanRequiredWindows} 个文本块需要人工处理。</p>
                  : null}
                {run.progress.failedWindows > 0
                  ? <p>{run.progress.failedWindows} 个文本块运行失败。</p>
                  : null}
              </div>
            ) : null}

            {run.attention === undefined ? null : (
              <section className="attention-center" aria-labelledby="attention-center-title">
                <header>
                  <div>
                    <p className="eyebrow">安全恢复</p>
                    <h3 id="attention-center-title">需要处理的文本块</h3>
                  </div>
                  <span>{run.attention.totalItems} 项</span>
                </header>
                <p className="attention-intro">
                  已完成进度仍保存在本地。这里不显示正文片段、译文、私人路径或模型原始响应。
                </p>
                {run.attention.truncated ? (
                  <p className="attention-intro">当前只显示前 100 项；诊断文件包含完整聚合计数。</p>
                ) : null}
                <div className="attention-list">
                  {run.attention.items.map((item) => (
                    <article key={item.windowId}>
                      <div className="attention-item-heading">
                        <div>
                          <strong>{item.location}</strong>
                          <small>{item.sourceChars.toLocaleString("zh-CN")} 字符 · 已尝试 {item.attemptCount} 次</small>
                        </div>
                        <code>{item.code}</code>
                      </div>
                      <h4>{item.title}</h4>
                      <p>{item.explanation}</p>
                      <p className="attention-next-action">下一步：{item.nextAction}</p>
                    </article>
                  ))}
                </div>
                {run.progress.failedWindows > 0 ? (
                  <p className="attention-blocker">
                    存在运行失败的文本块，自动重试不可用；请先导出诊断文件。
                  </p>
                ) : run.attention.retryAttempted ? (
                  <p className="attention-blocker">
                    本次受审计的自动重试已经使用；再次失败需要诊断具体原因。
                  </p>
                ) : null}
                <div className="attention-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={onExportDiagnostics}
                  >
                    导出诊断文件
                  </button>
                </div>
              </section>
            )}

            <div className="workspace-actions">
              {run.canPause ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy}
                  onClick={onPause}
                >
                  暂停
                </button>
              ) : null}
              {run.canResume ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy || !modelReady}
                  onClick={() => onResume(run.runId)}
                >
                  {busy
                    ? run.phase === "needs_attention" ? "正在安全恢复" : "正在继续"
                    : run.phase === "needs_attention"
                      ? `安全重试 ${run.attention?.totalItems ?? 0} 个文本块`
                      : "继续翻译"}
                </button>
              ) : null}
            </div>
          </section>
        )}

        {error === undefined ? null : (
          <section className="operation-error" role="status">
            <p>{redactTechnicalDetails(error.message)}</p>
            {error.nextAction === undefined
              ? null
              : <p>{redactTechnicalDetails(error.nextAction)}</p>}
            <TechnicalDetails details={error.technicalDetails} />
          </section>
        )}
      </div>
    </main>
  );
}
