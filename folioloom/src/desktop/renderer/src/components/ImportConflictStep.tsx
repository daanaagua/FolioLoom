import { useState, type JSX } from "react";

import type {
  ImportConflictDecision,
  ImportPreviewRow,
  StagedImportReport,
} from "../../../contracts.js";

interface ImportConflictStepProps {
  report: StagedImportReport;
  busy: boolean;
  onDecide(rowOrdinal: number, decision: ImportConflictDecision): void;
  onLoadMore(): void;
  onCommit(): void;
}

const STATE_LABELS: Readonly<Record<ImportPreviewRow["state"], string>> = {
  ready: "新增",
  merge: "安全合并",
  conflict: "需要决定",
  invalid: "无法导入",
  skipped: "已跳过",
};

const DECISION_LABELS: Readonly<Record<
  Exclude<ImportConflictDecision["action"], "create_separate">,
  string
>> = {
  keep_existing: "保留现有值",
  use_imported: "采用导入值",
  merge_as_alias: "并为别名",
  skip: "跳过",
};

function displayFields(row: ImportPreviewRow): string {
  return Object.entries(row.displayFields)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value ?? "")}`)
    .join(" · ");
}

export function ImportConflictStep({
  report,
  busy,
  onDecide,
  onLoadMore,
  onCommit,
}: ImportConflictStepProps): JSX.Element {
  const [separateNames, setSeparateNames] = useState<Record<number, string>>({});
  const canCommit = report.unresolved === 0
    && report.counts.invalid === 0
    && !busy;

  return (
    <section className="import-step import-conflict-step">
      <header className="import-step-heading">
        <p className="drawer-section-kicker">第 3 步</p>
        <h2>检查与解决冲突</h2>
        <p>系统尚未写入知识库。确认后，整批内容会在一个事务中提交。</p>
      </header>

      <div className="import-count-grid" aria-label="导入预览统计">
        <article>
          <strong>{report.counts.ready}</strong>
          <span>将新增 {report.counts.ready} 条</span>
        </article>
        <article>
          <strong>{report.counts.merge}</strong>
          <span>可安全合并</span>
        </article>
        <article className={report.counts.conflict > 0 ? "has-warning" : ""}>
          <strong>{report.counts.conflict}</strong>
          <span>需要决定</span>
        </article>
        <article className={report.counts.invalid > 0 ? "has-error" : ""}>
          <strong>{report.counts.invalid}</strong>
          <span>无法导入</span>
        </article>
      </div>

      {report.rows.length > 0 ? (
        <div className="import-preview-list">
          {report.rows.map((row) => (
            <article className={`import-preview-row is-${row.state}`} key={row.ordinal}>
              <header>
                <span className="import-row-state">{STATE_LABELS[row.state]}</span>
                <strong>第 {row.ordinal} 条</strong>
                <span>{row.location}</span>
              </header>
              <p>{displayFields(row)}</p>
              {row.diagnostics.map((diagnostic) => (
                <p className="import-row-diagnostic" key={`${diagnostic.code}:${diagnostic.location}`}>
                  {diagnostic.message}
                </p>
              ))}
              {row.allowedDecisions.length > 0 ? (
                <div className="import-decision-actions">
                  {row.allowedDecisions.flatMap((action) => {
                    if (action === "create_separate") {
                      return [
                        <label className="import-separate-control" key={action}>
                          <span>作为独立对象</span>
                          <input
                            aria-label={`第 ${row.ordinal} 条的独立对象名称`}
                            value={separateNames[row.ordinal] ?? ""}
                            disabled={busy}
                            onChange={(event) => setSeparateNames((current) => ({
                              ...current,
                              [row.ordinal]: event.target.value,
                            }))}
                          />
                          <button
                            className="quiet-button"
                            type="button"
                            disabled={busy || (separateNames[row.ordinal]?.trim().length ?? 0) === 0}
                            onClick={() => onDecide(row.ordinal, {
                              action,
                              normalizedSubject: separateNames[row.ordinal]!.trim(),
                            })}
                          >
                            确认独立保存
                          </button>
                        </label>,
                      ];
                    }
                    return [
                      <button
                        className="quiet-button"
                        type="button"
                        key={action}
                        disabled={busy}
                        onClick={() => onDecide(row.ordinal, { action })}
                      >
                        {DECISION_LABELS[action]}
                      </button>,
                    ];
                  })}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="import-clean-preview">没有需要逐条处理的记录。</p>
      )}

      {report.unresolved > 0 || report.counts.invalid > 0 ? (
        <p className="import-blocking-note" role="status">
          还有 {report.unresolved + report.counts.invalid} 条记录需要处理，暂时不能提交。
        </p>
      ) : null}

      <footer className="import-step-actions">
        {report.nextCursor !== undefined ? (
          <button
            className="quiet-button"
            type="button"
            disabled={busy}
            onClick={onLoadMore}
          >
            {busy ? "正在加载…" : "加载更多记录"}
          </button>
        ) : null}
        <button
          className="primary-button"
          type="button"
          disabled={!canCommit}
          onClick={onCommit}
        >
          {busy ? "正在提交…" : "确认导入"}
        </button>
      </footer>
    </section>
  );
}
