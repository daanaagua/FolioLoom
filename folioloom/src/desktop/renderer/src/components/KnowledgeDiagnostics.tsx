import { useEffect, useState, type JSX } from "react";

import type {
  DesktopError,
  DesktopResult,
} from "../../../contracts.js";
import type { DesktopKnowledgeDiagnostics } from "../../../knowledge-contracts.js";

interface KnowledgeDiagnosticsProps {
  load(): Promise<DesktopResult<DesktopKnowledgeDiagnostics>>;
  onClose(): void;
}
type DiagnosticState =
  | { status: "loading" }
  | { status: "ready"; value: DesktopKnowledgeDiagnostics; advanced: boolean }
  | { status: "failed"; error: DesktopError };

export function KnowledgeDiagnostics({
  load,
  onClose,
}: KnowledgeDiagnosticsProps): JSX.Element {
  const [state, setState] = useState<DiagnosticState>({ status: "loading" });

  async function refresh(showAdvanced: boolean): Promise<void> {
    setState({ status: "loading" });
    const result = await load();
    setState(result.ok
      ? { status: "ready", value: result.value, advanced: showAdvanced }
      : { status: "failed", error: result.error });
  }

  useEffect(() => {
    void refresh(false);
  }, []);

  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section className="knowledge-modal diagnostics-modal" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <header className="knowledge-modal-header">
          <div>
            <p className="eyebrow">LOCAL / READ ONLY</p>
            <h2 id="diagnostics-title">只读诊断</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭诊断" onClick={onClose}>×</button>
        </header>

        {state.status === "loading" ? <p className="knowledge-loading">正在读取诊断摘要…</p> : null}
        {state.status === "failed" ? (
          <div className="knowledge-inline-error" role="alert">
            <p>{state.error.message}</p>
            <button className="quiet-button" type="button" onClick={() => { void refresh(false); }}>重试</button>
          </div>
        ) : null}
        {state.status === "ready" ? (
          <>
            <div className="diagnostic-metrics">
              <article><span>数据库结构</span><strong>Schema v{state.value.schemaVersion}</strong></article>
              <article><span>知识代数</span><strong>{state.value.knowledgeGeneration}</strong></article>
              <article><span>待处理影响</span><strong>{state.value.pendingImpacts}</strong></article>
              <article><span>最近迁移</span><strong>{state.value.latestMigration}</strong></article>
            </div>
            <div className="diagnostic-breakdown">
              <section>
                <h3>按类型</h3>
                <dl>
                  {Object.entries(state.value.countsByType).map(([kind, count]) => (
                    <div key={kind}><dt>{kind}</dt><dd>{count}</dd></div>
                  ))}
                </dl>
              </section>
              <section>
                <h3>按状态</h3>
                <dl>
                  {Object.entries(state.value.countsByStatus).map(([status, count]) => (
                    <div key={status}><dt>{status}</dt><dd>{count}</dd></div>
                  ))}
                </dl>
              </section>
            </div>
            {!state.advanced ? (
              <button
                className="quiet-button"
                type="button"
                onClick={() => { void refresh(true); }}
              >
                高级只读诊断
              </button>
            ) : null}
            {state.advanced ? (
              state.value.advanced === undefined ? (
                <p className="knowledge-form-note">高级诊断暂不可用，未开放任何写入入口。</p>
              ) : (
                <div className="advanced-diagnostics">
                  <p className="integrity-ok">完整性：{state.value.advanced.integrityCheck}</p>
                  <div className="diagnostic-breakdown">
                    <section>
                      <h3>允许查看的表</h3>
                      <dl>
                        {state.value.advanced.tables.map((table) => (
                          <div key={table.name}><dt>{table.name}</dt><dd>{table.rowCount}</dd></div>
                        ))}
                      </dl>
                    </section>
                    <section>
                      <h3>最近事件</h3>
                      <ul>
                        {state.value.advanced.recentEvents.map((event, index) => (
                          <li key={`${event.kind}:${event.createdAt}:${index}`}>
                            <span>{event.kind}</span><time>{event.createdAt}</time>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                </div>
              )
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
