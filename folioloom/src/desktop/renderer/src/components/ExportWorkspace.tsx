import { useEffect, useMemo, useState, type JSX } from "react";

import type {
  DesktopError,
  DesktopExportCandidate,
  DesktopExportDestination,
  DesktopExportFormat,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopExportSnapshot,
} from "../../../contracts.js";
import { TechnicalDetails, redactTechnicalDetails } from "./TechnicalDetails.js";

interface ExportWorkspaceProps {
  title: string;
  snapshot: DesktopExportSnapshot;
  destination?: DesktopExportDestination;
  result?: DesktopExportResult;
  busy: boolean;
  error?: DesktopError;
  onChooseDirectory(): void;
  onExport(request: DesktopExportRequest): void;
  onOpenDirectory(exportId: string): void;
}

const formatOptions: readonly {
  format: DesktopExportFormat;
  label: string;
  detail: string;
}[] = [
  { format: "translation_txt", label: "中文 TXT", detail: "适合搜索、摘录和纯文本阅读" },
  { format: "bilingual_txt", label: "双语 TXT", detail: "按文本块保留原文与译文对照" },
  { format: "epub", label: "EPUB", detail: "适合手机、平板和电子书阅读器" },
];

function defaultCandidate(snapshot: DesktopExportSnapshot): DesktopExportCandidate | undefined {
  return snapshot.candidates.find((candidate) => candidate.status === "ready")
    ?? snapshot.candidates[0];
}

export function ExportWorkspace({
  title,
  snapshot,
  destination,
  result,
  busy,
  error,
  onChooseDirectory,
  onExport,
  onOpenDirectory,
}: ExportWorkspaceProps): JSX.Element {
  const initialCandidate = defaultCandidate(snapshot);
  const [runId, setRunId] = useState(initialCandidate?.runId ?? "");
  const [formats, setFormats] = useState<DesktopExportFormat[]>([
    "translation_txt",
    "bilingual_txt",
    "epub",
  ]);

  useEffect(() => {
    if (!snapshot.candidates.some((candidate) => candidate.runId === runId)) {
      setRunId(defaultCandidate(snapshot)?.runId ?? "");
    }
  }, [runId, snapshot]);

  const candidate = useMemo(
    () => snapshot.candidates.find((item) => item.runId === runId),
    [runId, snapshot.candidates],
  );
  const activeDestination = destination ?? snapshot.defaultDestination;
  const incomplete = candidate === undefined
    ? 0
    : Math.max(0, candidate.totalWindows - candidate.completedWindows);
  const canExport = candidate?.status === "ready"
    && activeDestination !== undefined
    && formats.length > 0
    && !busy;

  function toggleFormat(format: DesktopExportFormat): void {
    setFormats((current) => {
      const selected = new Set(current);
      if (selected.has(format)) selected.delete(format);
      else selected.add(format);
      return formatOptions
        .map((option) => option.format)
        .filter((item) => selected.has(item));
    });
  }

  return (
    <main className="onboarding-scroll">
      <div className="content-column workspace-page">
        <header className="workspace-heading">
          <p className="eyebrow">FolioLoom / Delivery</p>
          <h1>导出</h1>
          <p>{title}</p>
        </header>

        <section className="workspace-card export-card">
          <div className="export-control">
            <label htmlFor="export-run">选择翻译记录</label>
            <select
              id="export-run"
              value={runId}
              disabled={busy || snapshot.candidates.length === 0}
              onChange={(event) => setRunId(event.currentTarget.value)}
            >
              {snapshot.candidates.length === 0
                ? <option value="">还没有可导出的整本翻译</option>
                : snapshot.candidates.map((item, index) => (
                  <option key={item.runId} value={item.runId}>
                    {item.modelId} · 第 {index + 1} 次 · {item.completedWindows}/{item.totalWindows}
                  </option>
                ))}
            </select>
          </div>

          {candidate === undefined ? (
            <p className="workspace-copy">整本翻译完成后，文件会在这里准备好。</p>
          ) : (
            <div className="export-candidate-summary">
              <div>
                <strong>{candidate.completedWindows} / {candidate.totalWindows} 个文本块</strong>
                <span>{candidate.status === "ready" ? "已通过导出前检查" : "尚未通过导出检查"}</span>
              </div>
              <span className={`run-state is-${candidate.status}`}>
                {candidate.status === "ready" ? "可以导出" : candidate.status === "blocked" ? "需要处理" : "尚未完成"}
              </span>
            </div>
          )}

          {candidate !== undefined && candidate.status !== "ready" ? (
            <div className="workspace-notice is-warning">
              {candidate.status === "incomplete"
                ? <p>仍有 {incomplete} 个文本块未完成</p>
                : candidate.blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}
            </div>
          ) : null}

          <fieldset className="format-choice" disabled={busy}>
            <legend>文件格式</legend>
            {formatOptions.map((option) => (
              <label key={option.format}>
                <input
                  type="checkbox"
                  aria-label={option.label}
                  checked={formats.includes(option.format)}
                  onChange={() => toggleFormat(option.format)}
                />
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              </label>
            ))}
          </fieldset>

          <div className="destination-row">
            <div>
              <span>保存到</span>
              <strong>{activeDestination?.displayPath ?? "尚未选择文件夹"}</strong>
            </div>
            <button
              className="quiet-button"
              type="button"
              disabled={busy}
              onClick={onChooseDirectory}
            >
              选择文件夹
            </button>
          </div>

          <button
            className="primary-button"
            type="button"
            disabled={!canExport}
            onClick={() => {
              if (candidate === undefined || activeDestination === undefined) return;
              onExport({
                runId: candidate.runId,
                destinationId: activeDestination.destinationId,
                formats,
              });
            }}
          >
            {busy ? "正在导出" : "导出文件"}
          </button>
        </section>

        {result === undefined ? null : (
          <section className="workspace-card export-result" aria-live="polite">
            <div>
              <p className="eyebrow">导出完成</p>
              <h2>文件已经准备好</h2>
            </div>
            <ul>
              {result.files.map((file) => <li key={`${file.format}:${file.fileName}`}>{file.fileName}</li>)}
            </ul>
            <button
              className="quiet-button"
              type="button"
              onClick={() => onOpenDirectory(result.exportId)}
            >
              打开文件夹
            </button>
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
