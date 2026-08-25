import {
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";

import type {
  CommittedImportReport,
  DesktopError,
  DesktopResult,
  ImportConflictDecision,
  ImportFieldMapping,
  ImportInspection,
  ImportInspectionResult,
  ImportSelection,
  MappingSuggestion,
  PendingKnowledgeImport,
  RolledBackImportReport,
  StagedImportReport,
  StagedImportSummary,
} from "../../../contracts.js";
import { MAX_STAGED_IMPORT_PAGE_SIZE } from "../../../contracts.js";
import type { FolioLoomDesktopApi } from "../../../preload/folioloom-api.js";
import { ImportConflictStep } from "./ImportConflictStep.js";
import { ImportMappingStep } from "./ImportMappingStep.js";

interface KnowledgeImportWizardProps {
  api: FolioLoomDesktopApi;
  generation: number;
  snapshotId: string;
  onClose(): void;
  onCommitted(report: CommittedImportReport | RolledBackImportReport): void;
}

type WizardView =
  | { kind: "loading" }
  | { kind: "choose" }
  | { kind: "resume"; batches: readonly StagedImportSummary[] }
  | { kind: "inspecting"; pending: PendingKnowledgeImport; operationId: string }
  | {
      kind: "encoding";
      pending: PendingKnowledgeImport;
      result: Extract<ImportInspectionResult, { status: "encoding_required" }>;
    }
  | {
      kind: "mapping";
      pending: PendingKnowledgeImport;
      inspection: ImportInspection;
      suggestion: MappingSuggestion;
      busy: boolean;
    }
  | { kind: "review"; report: StagedImportReport; busy: boolean }
  | { kind: "done"; report: CommittedImportReport; rolledBack?: RolledBackImportReport };

function errorText(error: DesktopError): string {
  return error.nextAction === undefined
    ? error.message
    : `${error.message} ${error.nextAction}`;
}

function rendererError(): DesktopError {
  return {
    code: "DESKTOP_RENDERER_ERROR",
    message: "与桌面服务通信失败，请重试。",
    retryable: true,
  };
}

async function desktopCall<T>(
  operation: () => Promise<DesktopResult<T>>,
): Promise<DesktopResult<T>> {
  try {
    return await operation();
  } catch {
    return { ok: false, error: rendererError() };
  }
}

function freshOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function initialSelection(inspection: ImportInspection): ImportSelection {
  const recordPathId = inspection.recordPaths[0]?.id;
  const sheet = inspection.sheets[0];
  return {
    ...(recordPathId === undefined ? {} : { recordPathId }),
    ...(sheet === undefined ? {} : {
      sheetId: sheet.id,
      headerRow: sheet.suggestedHeaderRows[0] ?? 1,
    }),
    objectType: "term",
    scope: "book",
  };
}

function allMappingsConfirmed(suggestion: MappingSuggestion): boolean {
  const mapped = Object.values(suggestion.fields).filter(
    (field): field is ImportFieldMapping => field !== undefined,
  );
  return mapped.length > 0
    && mapped.every((field) =>
      field.confidence === "high" && field.confirmed);
}

function mergeStagedReports(
  current: StagedImportReport,
  incoming: StagedImportReport,
): StagedImportReport {
  if (current.batchId !== incoming.batchId) {
    return incoming;
  }
  const rows = new Map(current.rows.map((row) => [row.ordinal, row]));
  for (const row of incoming.rows) rows.set(row.ordinal, row);
  return {
    ...incoming,
    rows: [...rows.values()].sort((left, right) => left.ordinal - right.ordinal),
  };
}

export function KnowledgeImportWizard({
  api,
  generation,
  snapshotId,
  onClose,
  onCommitted,
}: KnowledgeImportWizardProps): JSX.Element {
  const [view, setView] = useState<WizardView>({ kind: "loading" });
  const [error, setError] = useState<DesktopError>();
  const [undoArmed, setUndoArmed] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const requestNonce = useRef(0);
  const activeOperation = useRef<{
    operationId: string;
    pending?: PendingKnowledgeImport;
  } | undefined>(undefined);
  const alive = useRef(true);
  const dialogRef = useRef<HTMLElement>(null);
  const latestView = useRef<WizardView>(view);
  const closeRef = useRef<() => Promise<void>>(async () => undefined);
  const closing = useRef(false);
  latestView.current = view;

  useEffect(() => {
    alive.current = true;
    const nonce = ++requestNonce.current;
    void desktopCall(() => api.listStagedKnowledgeImports()).then((result) => {
      if (!alive.current || nonce !== requestNonce.current) return;
      if (!result.ok) {
        setError(result.error);
        setView({ kind: "choose" });
        return;
      }
      setView(result.value.length === 0
        ? { kind: "choose" }
        : { kind: "resume", batches: result.value });
    });
    return () => {
      alive.current = false;
      requestNonce.current += 1;
    };
  }, [api]);

  async function cancelActive(
    returnToChooser: boolean,
  ): Promise<string | undefined> {
    requestNonce.current += 1;
    const active = activeOperation.current;
    activeOperation.current = undefined;
    let cancellationError: DesktopError | undefined;
    if (active !== undefined) {
      const operationResult = await desktopCall(() =>
        api.cancelKnowledgeImportOperation({
        operationId: active.operationId,
        }));
      if (!operationResult.ok) cancellationError = operationResult.error;
      if (active.pending !== undefined) {
        const pendingResult = await desktopCall(() =>
          api.cancelPendingKnowledgeImport(
            active.pending!.pendingImportId,
          ));
        if (!pendingResult.ok) cancellationError ??= pendingResult.error;
      }
    }
    if (returnToChooser && alive.current) {
      setError(cancellationError);
      setActionBusy(false);
      setView({ kind: "choose" });
    }
    return active?.pending?.pendingImportId;
  }

  async function close(): Promise<void> {
    if (closing.current) return;
    closing.current = true;
    const current = latestView.current;
    const cancelledPendingId = await cancelActive(false);
    if (
      (current.kind === "inspecting"
        || current.kind === "encoding"
        || current.kind === "mapping")
      && current.pending.pendingImportId !== cancelledPendingId
    ) {
      await desktopCall(() =>
        api.cancelPendingKnowledgeImport(current.pending.pendingImportId));
    }
    onClose();
  }
  closeRef.current = close;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const focusTimer = window.setTimeout(() => {
      const first = dialog.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), "
          + "textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      (first ?? dialog).focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), "
          + "textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || dialog.contains(document.activeElement)) return;
    const focusTimer = window.setTimeout(() => {
      if (dialog.contains(document.activeElement)) return;
      const first = dialog.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), "
          + "textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      (first ?? dialog).focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [view.kind]);

  async function stage(
    pending: PendingKnowledgeImport,
    selection: ImportSelection,
    fields: Readonly<Record<string, ImportFieldMapping | undefined>>,
  ): Promise<void> {
    const nonce = ++requestNonce.current;
    const operationId = freshOperationId();
    activeOperation.current = { operationId, pending };
    setView((current) => current.kind === "mapping"
      ? { ...current, busy: true }
      : current);
    const result = await desktopCall(() => api.stageKnowledgeImport({
      pendingImportId: pending.pendingImportId,
      operationId,
      expectedGeneration: generation,
      expectedSnapshotId: snapshotId,
      selection,
      fields,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    activeOperation.current = undefined;
    if (!result.ok) {
      setError(result.error);
      setView((current) => current.kind === "mapping"
        ? { ...current, busy: false }
        : { kind: "choose" });
      return;
    }
    const cleanup = await desktopCall(() =>
      api.cancelPendingKnowledgeImport(pending.pendingImportId));
    setError(undefined);
    setView({ kind: "review", report: result.value, busy: false });
    if (!cleanup.ok) setError(cleanup.error);
  }

  async function loadMapping(
    pending: PendingKnowledgeImport,
    inspection: ImportInspection,
    selection: ImportSelection,
  ): Promise<void> {
    const nonce = ++requestNonce.current;
    const result = await desktopCall(() => api.suggestKnowledgeImport({
      pendingImportId: pending.pendingImportId,
      selection,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    if (!result.ok) {
      setError(result.error);
      await desktopCall(() =>
        api.cancelPendingKnowledgeImport(pending.pendingImportId));
      setView({ kind: "choose" });
      return;
    }
    if (allMappingsConfirmed(result.value)) {
      await stage(
        pending,
        result.value.selection,
        result.value.fields,
      );
      return;
    }
    setError(undefined);
    setView({
      kind: "mapping",
      pending,
      inspection,
      suggestion: result.value,
      busy: false,
    });
  }

  async function acceptInspection(
    pending: PendingKnowledgeImport,
    result: ImportInspectionResult,
  ): Promise<void> {
    if (result.status === "encoding_required") {
      setView({ kind: "encoding", pending, result });
      return;
    }
    await loadMapping(
      pending,
      result.inspection,
      initialSelection(result.inspection),
    );
  }

  async function inspect(pending: PendingKnowledgeImport): Promise<void> {
    const nonce = ++requestNonce.current;
    const operationId = freshOperationId();
    activeOperation.current = { operationId, pending };
    setView({ kind: "inspecting", pending, operationId });
    const result = await desktopCall(() => api.inspectKnowledgeImport({
      pendingImportId: pending.pendingImportId,
      operationId,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    activeOperation.current = undefined;
    if (!result.ok) {
      setError(result.error);
      await desktopCall(() =>
        api.cancelPendingKnowledgeImport(pending.pendingImportId));
      setView({ kind: "choose" });
      return;
    }
    setError(undefined);
    await acceptInspection(pending, result.value);
  }

  async function choose(): Promise<void> {
    if (actionBusy) return;
    setActionBusy(true);
    setError(undefined);
    const result = await desktopCall(() => api.chooseKnowledgeImport());
    if (!alive.current) return;
    setActionBusy(false);
    if (!result.ok) {
      if (result.error.code !== "DESKTOP_SELECTION_CANCELLED") {
        setError(result.error);
      }
      return;
    }
    await inspect(result.value);
  }

  async function confirmEncoding(
    encoding: Extract<
      ImportInspectionResult,
      { status: "encoding_required" }
    >["encodings"][number],
  ): Promise<void> {
    if (view.kind !== "encoding") return;
    const pending = view.pending;
    const nonce = ++requestNonce.current;
    const operationId = freshOperationId();
    activeOperation.current = { operationId, pending };
    setActionBusy(true);
    const result = await desktopCall(() =>
      api.confirmKnowledgeImportEncoding({
      pendingImportId: pending.pendingImportId,
      operationId,
      encoding,
      }));
    if (!alive.current || nonce !== requestNonce.current) return;
    activeOperation.current = undefined;
    setActionBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    await acceptInspection(pending, result.value);
  }

  async function resume(batch: StagedImportSummary): Promise<void> {
    if (actionBusy) return;
    const nonce = ++requestNonce.current;
    setActionBusy(true);
    const result = await desktopCall(() => api.getStagedKnowledgeImport({
      batchId: batch.batchId,
      limit: MAX_STAGED_IMPORT_PAGE_SIZE,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    setActionBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    setView({ kind: "review", report: result.value, busy: false });
  }

  async function discard(batch: StagedImportSummary): Promise<void> {
    if (actionBusy) return;
    const nonce = ++requestNonce.current;
    setActionBusy(true);
    const result = await desktopCall(() => api.discardStagedKnowledgeImport({
      batchId: batch.batchId,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    setActionBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    setView({ kind: "choose" });
  }

  async function decide(
    rowOrdinal: number,
    decision: ImportConflictDecision,
  ): Promise<void> {
    if (view.kind !== "review" || view.busy) return;
    const report = view.report;
    const nonce = ++requestNonce.current;
    setView({ ...view, busy: true });
    const result = await desktopCall(() => api.decideKnowledgeImport({
      batchId: report.batchId,
      decisions: [{ rowOrdinal, decision }],
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    if (!result.ok) {
      setError(result.error);
      setView({ kind: "review", report, busy: false });
      return;
    }
    setError(undefined);
    setView({ kind: "review", report: result.value, busy: false });
  }

  async function loadMore(): Promise<void> {
    if (view.kind !== "review"
      || view.busy
      || view.report.nextCursor === undefined) return;
    const report = view.report;
    const nonce = ++requestNonce.current;
    setView({ ...view, busy: true });
    const result = await desktopCall(() => api.getStagedKnowledgeImport({
      batchId: report.batchId,
      cursor: report.nextCursor,
      limit: MAX_STAGED_IMPORT_PAGE_SIZE,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    if (!result.ok) {
      setError(result.error);
      setView({ kind: "review", report, busy: false });
      return;
    }
    setError(undefined);
    setView({
      kind: "review",
      report: mergeStagedReports(report, result.value),
      busy: false,
    });
  }

  async function commit(): Promise<void> {
    if (view.kind !== "review" || view.busy) return;
    const report = view.report;
    const operationId = freshOperationId();
    const nonce = ++requestNonce.current;
    activeOperation.current = { operationId };
    setView({ ...view, busy: true });
    const result = await desktopCall(() => api.commitKnowledgeImport({
      batchId: report.batchId,
      operationId,
      expectedGeneration: generation,
      expectedSnapshotId: snapshotId,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    activeOperation.current = undefined;
    if (!result.ok) {
      setError(result.error);
      setView({ kind: "review", report, busy: false });
      return;
    }
    setError(undefined);
    setView({ kind: "done", report: result.value });
    onCommitted(result.value);
  }

  async function rollback(): Promise<void> {
    if (view.kind !== "done" || view.rolledBack !== undefined || actionBusy) return;
    if (!undoArmed) {
      setUndoArmed(true);
      return;
    }
    const operationId = freshOperationId();
    const nonce = ++requestNonce.current;
    activeOperation.current = { operationId };
    setActionBusy(true);
    const result = await desktopCall(() => api.rollbackKnowledgeImport({
      batchId: view.report.batchId,
      operationId,
      expectedGeneration: view.report.generation,
      expectedSnapshotId: view.report.snapshotId,
    }));
    if (!alive.current || nonce !== requestNonce.current) return;
    activeOperation.current = undefined;
    setActionBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setUndoArmed(false);
    setError(undefined);
    setView({ ...view, rolledBack: result.value });
    onCommitted(result.value);
  }

  return (
    <div className="knowledge-import-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="knowledge-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-import-title"
        tabIndex={-1}
      >
        <header className="knowledge-import-titlebar">
          <div>
            <p className="drawer-section-kicker">本地知识导入</p>
            <h1 id="knowledge-import-title">导入已有术语与知识</h1>
          </div>
          <button
            className="drawer-close"
            type="button"
            aria-label="关闭导入"
            onClick={() => { void close(); }}
          >
            ×
          </button>
        </header>

        {error !== undefined ? (
          <div className="knowledge-import-error" role="alert">
            <strong>操作没有完成</strong>
            <p>{errorText(error)}</p>
            <span>错误编号：{error.code}</span>
          </div>
        ) : null}

        <div className="knowledge-import-body">
          {view.kind === "loading" ? <p>正在检查未完成的导入…</p> : null}

          {view.kind === "choose" ? (
            <section className="import-step import-choose-step">
              <header className="import-step-heading">
                <p className="drawer-section-kicker">第 1 步</p>
                <h2>选择知识文件</h2>
                <p>支持 JSON、YAML、CSV 和 XLSX。文件只在本机解析。</p>
              </header>
              <button
                className="primary-button"
                type="button"
                disabled={actionBusy}
                onClick={() => { void choose(); }}
              >
                {actionBusy ? "正在打开…" : "选择文件"}
              </button>
            </section>
          ) : null}

          {view.kind === "resume" ? (
            <section className="import-step import-resume-step">
              <header className="import-step-heading">
                <p className="drawer-section-kicker">恢复导入</p>
                <h2>发现一项尚未提交的导入</h2>
                <p>暂存内容仍在本机数据库中。可以继续处理，也可以安全丢弃。</p>
              </header>
              {view.batches.map((batch) => (
                <article className="import-resume-card" key={batch.batchId}>
                  <div>
                    <strong>{batch.sourceName}</strong>
                    <span>{batch.sourceFormat.toUpperCase()} · {batch.createdAt}</span>
                  </div>
                  <div>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={actionBusy}
                      onClick={() => { void resume(batch); }}
                    >
                      继续处理
                    </button>
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={actionBusy}
                      onClick={() => { void discard(batch); }}
                    >
                      丢弃暂存
                    </button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {view.kind === "inspecting" ? (
            <section className="import-step import-progress-step">
              <div className="import-progress-orbit" aria-hidden="true" />
              <h2>正在检查 {view.pending.fileName}</h2>
              <p>识别结构、编码与样例，不会把文件发送给模型。</p>
              <button
                className="quiet-button"
                type="button"
                onClick={() => { void cancelActive(true); }}
              >
                取消检查
              </button>
            </section>
          ) : null}

          {view.kind === "encoding" ? (
            <section className="import-step import-encoding-step">
              <header className="import-step-heading">
                <p className="drawer-section-kicker">文字编码</p>
                <h2>请选择正确的 CSV 编码</h2>
                <p>系统不会用替换字符强行解码。请对照短预览后确认。</p>
              </header>
              <div className="import-encoding-grid">
                {view.result.encodings.map((encoding) => (
                  <button
                    className="import-encoding-choice"
                    type="button"
                    key={encoding}
                    disabled={actionBusy}
                    onClick={() => { void confirmEncoding(encoding); }}
                  >
                    <strong>{encoding}</strong>
                    <span>{view.result.previews.find(
                      (preview) => preview.encoding === encoding,
                    )?.text ?? "无预览"}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {view.kind === "mapping" ? (
            <ImportMappingStep
              inspection={view.inspection}
              suggestion={view.suggestion}
              busy={view.busy}
              onSelectionChange={(selection) => {
                setView({ ...view, busy: true });
                void loadMapping(view.pending, view.inspection, selection);
              }}
              onConfirm={(selection, fields) => {
                void stage(view.pending, selection, fields);
              }}
            />
          ) : null}

          {view.kind === "review" ? (
            <ImportConflictStep
              report={view.report}
              busy={view.busy}
              onDecide={(rowOrdinal, decision) => {
                void decide(rowOrdinal, decision);
              }}
              onCommit={() => { void commit(); }}
              onLoadMore={() => { void loadMore(); }}
            />
          ) : null}

          {view.kind === "done" ? (
            <section className="import-step import-done-step">
              <span className="import-done-mark" aria-hidden="true">✓</span>
              <p className="drawer-section-kicker">第 4 步</p>
              <h2>{view.rolledBack === undefined ? "导入完成" : "已撤销本次导入"}</h2>
              {view.rolledBack === undefined ? (
                <>
                  <p>
                    新增 {view.report.added} 条，更新 {view.report.updated} 条，
                    合并 {view.report.merged} 条，跳过 {view.report.skipped} 条。
                  </p>
                  <button
                    className={undoArmed ? "danger-button" : "quiet-button"}
                    type="button"
                    disabled={actionBusy}
                    onClick={() => { void rollback(); }}
                  >
                    {actionBusy
                      ? "正在撤销…"
                      : undoArmed
                        ? "确认撤销并创建新版本"
                        : "撤销本次导入"}
                  </button>
                </>
              ) : (
                <p>已追加 {view.rolledBack.rolledBack} 条恢复修订，审计历史仍然保留。</p>
              )}
              <button
                className="primary-button"
                type="button"
                onClick={onClose}
              >
                返回知识工作台
              </button>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
