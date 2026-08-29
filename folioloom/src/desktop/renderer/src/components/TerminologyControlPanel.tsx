import { useEffect, useState, type JSX } from "react";

import type {
  DesktopError,
  DesktopTerminologyControlState,
  DesktopTermRetrofitPlan,
} from "../../../contracts.js";
import type { DesktopKnowledgeDetail } from "../../../knowledge-contracts.js";
import type { FolioLoomDesktopApi } from "../../../preload/folioloom-api.js";

interface TerminologyControlPanelProps {
  readonly api: FolioLoomDesktopApi;
  readonly generation: number;
  readonly snapshotId: string;
  readonly selected?: DesktopKnowledgeDetail;
  readonly onClose: () => void;
}

function freshRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `retrofit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function TerminologyControlPanel({
  api,
  generation,
  snapshotId,
  selected,
  onClose,
}: TerminologyControlPanelProps): JSX.Element {
  const [state, setState] = useState<DesktopTerminologyControlState>();
  const [plan, setPlan] = useState<DesktopTermRetrofitPlan>();
  const [error, setError] = useState<DesktopError>();
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const result = await api.getTerminologyControlState();
    if (result.ok) {
      setState(result.value);
      setError(undefined);
    } else {
      setError(result.error);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const activeRevisionId = selected?.history.at(-1)?.revisionId;
  const canPlan = selected?.item.objectType === "term"
    && selected.item.kind.startsWith("term_rendering_rule:")
    && activeRevisionId !== undefined;

  async function preview(): Promise<void> {
    if (activeRevisionId === undefined) return;
    setBusy(true);
    try {
      const result = await api.planTermRetrofit({
        requestId: freshRequestId(),
        ruleRevisionId: activeRevisionId,
        expectedGeneration: generation,
        expectedSnapshotId: snapshotId,
      });
      if (result.ok) {
        setPlan(result.value);
        setError(undefined);
        await refresh();
      } else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (plan === undefined) return;
    setBusy(true);
    try {
      const result = await api.applyTermRetrofit({
        jobId: plan.jobId,
        planHash: plan.planHash,
      });
      if (result.ok) {
        setPlan(undefined);
        setError(undefined);
        await refresh();
      } else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  async function cancelQueued(requestId: string): Promise<void> {
    const result = await api.cancelQueuedTerminologyChange(requestId);
    if (result.ok) {
      setState(result.value);
      setError(undefined);
    } else setError(result.error);
  }

  async function cancelRetrofit(jobId: string): Promise<void> {
    const result = await api.cancelTermRetrofit(jobId);
    if (result.ok) {
      setPlan((current) => current?.jobId === jobId ? undefined : current);
      setError(undefined);
      await refresh();
    } else setError(result.error);
  }

  async function rollbackRetrofit(jobId: string): Promise<void> {
    const result = await api.rollbackTermRetrofit(jobId);
    if (result.ok) {
      setError(undefined);
      await refresh();
    } else setError(result.error);
  }

  return (
    <aside className="knowledge-diagnostics-panel terminology-control-panel" aria-label="术语修词控制">
      <div className="knowledge-editor-heading">
        <div>
          <p className="drawer-section-kicker">TERMINOLOGY CONTROL</p>
          <h2>运行中术语与修词</h2>
        </div>
        <button className="icon-button" type="button" aria-label="关闭术语控制" onClick={onClose}>×</button>
      </div>

      {error !== undefined ? <p className="knowledge-validation-message" role="alert">{error.message}</p> : null}

      <section>
        <h3>安全边界队列</h3>
        {state === undefined ? <p>正在读取…</p> : state.queuedChanges.length === 0 ? (
          <p>没有等待生效的修改。</p>
        ) : state.queuedChanges.map((item) => (
          <div className="knowledge-conflict" key={item.requestId}>
            <strong>{item.status === "applying" ? "正在应用" : "等待下一批次边界"}</strong>
            <p>{item.objectKeys.join("、")}</p>
            {item.status === "queued" ? (
              <button
                className="text-button"
                type="button"
                onClick={() => { void cancelQueued(item.requestId); }}
              >取消</button>
            ) : null}
          </div>
        ))}
      </section>

      <section>
        <h3>影响预览</h3>
        {canPlan ? (
          <button className="quiet-button" type="button" disabled={busy} onClick={() => { void preview(); }}>
            预览当前范围规则的修词影响
          </button>
        ) : <p>选择一条“范围译名规则”后可以生成修词计划。</p>}
        {plan !== undefined ? (
          <div className="knowledge-conflict">
            <strong>计划已锁定</strong>
            <p>
              无需修改 {plan.summary.noop}；本地安全修复 {plan.summary.localRepair}；
              模型重译 {plan.summary.modelRetranslate}；人工处理 {plan.summary.humanRequired}。
            </p>
            <button className="primary-button" type="button" disabled={busy} onClick={() => { void apply(); }}>
              执行此计划
            </button>
          </div>
        ) : null}
      </section>

      <section>
        <h3>修词作业</h3>
        {state?.retrofitJobs.length === 0 ? <p>还没有修词作业。</p> : state?.retrofitJobs.map((job) => (
          <div className="knowledge-conflict" key={job.jobId}>
            <strong>{job.status}</strong>
            <p>
              共 {job.summary.total} 块；本地 {job.summary.localRepair}；
              模型 {job.summary.modelRetranslate}；人工 {job.summary.humanRequired}。
            </p>
            {job.status === "planned" ? (
              <button
                className="text-button"
                type="button"
                onClick={() => { void cancelRetrofit(job.jobId); }}
              >取消计划</button>
            ) : null}
            {job.status === "completed" || job.status === "needs_attention" ? (
              <button
                className="text-button"
                type="button"
                onClick={() => { void rollbackRetrofit(job.jobId); }}
              >回滚作业</button>
            ) : null}
          </div>
        ))}
      </section>
    </aside>
  );
}
