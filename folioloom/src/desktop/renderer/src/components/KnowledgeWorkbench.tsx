import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import type { DesktopError } from "../../../contracts.js";
import type {
  CommittedImportReport,
  RolledBackImportReport,
} from "../../../contracts.js";
import type {
  DesktopKnowledgeDetail,
  DesktopKnowledgeMutationResult,
  DesktopKnowledgePage,
} from "../../../knowledge-contracts.js";
import type { UpdateKnowledgeCommand } from "../../../../knowledge/knowledge-commands.js";
import type { FolioLoomDesktopApi } from "../../../preload/folioloom-api.js";
import { GlobalKnowledgePicker } from "./GlobalKnowledgePicker.js";
import { KnowledgeDetailDrawer } from "./KnowledgeDetailDrawer.js";
import { KnowledgeDiagnostics } from "./KnowledgeDiagnostics.js";
import { KnowledgeImportWizard } from "./KnowledgeImportWizard.js";
import { KnowledgeTable } from "./KnowledgeTable.js";

interface KnowledgeWorkbenchProps {
  api: FolioLoomDesktopApi;
  onImportKnowledge?: () => void;
  importSlot?: ReactNode;
}

type KnowledgeViewState =
  | { status: "loading" }
  | { status: "ready"; page: DesktopKnowledgePage }
  | { status: "failed"; error: DesktopError };

type KnowledgeDetailState =
  | { status: "closed" }
  | { status: "loading"; id: string }
  | { status: "ready"; detail: DesktopKnowledgeDetail }
  | { status: "failed"; id: string; error: DesktopError };

interface Filters {
  readonly search: string;
  readonly objectType: string;
  readonly status: string;
  readonly scope: string;
  readonly origin: string;
}

const EMPTY_FILTERS: Filters = {
  search: "",
  objectType: "",
  status: "",
  scope: "",
  origin: "",
};

function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function rendererError(error: unknown): DesktopError {
  return {
    code: "DESKTOP_RENDERER_ERROR",
    message: "操作没有完成，请重试。",
    retryable: true,
    ...(error instanceof Error && error.message.length > 0
      ? { technicalDetails: error.message }
      : {}),
  };
}

function conflictError(error: DesktopError): boolean {
  return error.code.includes("CONFLICT");
}

function mergeItems(
  current: DesktopKnowledgePage["items"],
  incoming: DesktopKnowledgePage["items"],
): DesktopKnowledgePage["items"] {
  const seen = new Set(current.map((item) => item.id));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

function updatePageWithMutation(
  current: DesktopKnowledgePage,
  mutation: DesktopKnowledgeMutationResult,
): DesktopKnowledgePage {
  const index = current.items.findIndex((item) => item.id === mutation.detail.item.id);
  const items = index < 0
    ? [mutation.detail.item, ...current.items]
    : current.items.map((item) =>
      item.id === mutation.detail.item.id ? mutation.detail.item : item);
  return {
    ...current,
    generation: mutation.generation,
    snapshotId: mutation.snapshotId,
    items,
  };
}

export function KnowledgeWorkbench({
  api,
  onImportKnowledge,
  importSlot,
}: KnowledgeWorkbenchProps): JSX.Element {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [view, setView] = useState<KnowledgeViewState>({ status: "loading" });
  const [detailState, setDetailState] = useState<KnowledgeDetailState>({ status: "closed" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [operationError, setOperationError] = useState<DesktopError>();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showGlobalPicker, setShowGlobalPicker] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const listNonce = useRef(0);
  const detailNonce = useRef(0);

  async function loadFirstPage(background = false): Promise<void> {
    const nonce = ++listNonce.current;
    setLoadingMore(false);
    if (!background) setView({ status: "loading" });
    setOperationError(undefined);
    try {
      const result = await api.listKnowledge({
        ...(filters.search.trim().length === 0 ? {} : { search: filters.search }),
        ...(filters.objectType === "" ? {} : {
          objectTypes: [filters.objectType as "term" | "entity" | "alias" | "relation" | "memory" | "style"],
        }),
        ...(filters.status === "" ? {} : {
          statuses: [filters.status as "candidate" | "provisional" | "active" | "needs_revalidate" | "contextual" | "superseded"],
        }),
        ...(filters.scope === "" ? {} : {
          scopes: [filters.scope as "book" | "project" | "global"],
        }),
        ...(filters.origin === "" ? {} : {
          origins: [filters.origin as "model" | "manual" | "import" | "rollback"],
        }),
        limit: 50,
      });
      if (nonce !== listNonce.current) return;
      if (!result.ok) {
        if (background) setOperationError(result.error);
        else setView({ status: "failed", error: result.error });
        return;
      }
      setView({ status: "ready", page: result.value });
    } catch (error) {
      if (nonce === listNonce.current) {
        if (background) setOperationError(rendererError(error));
        else setView({ status: "failed", error: rendererError(error) });
      }
    }
  }

  useEffect(() => {
    void loadFirstPage();
  }, [
    api,
    filters.search,
    filters.objectType,
    filters.status,
    filters.scope,
    filters.origin,
  ]);

  async function loadMore(): Promise<void> {
    if (view.status !== "ready"
      || view.page.nextCursor === undefined
      || loadingMore) return;
    const nonce = ++listNonce.current;
    const cursor = view.page.nextCursor;
    setLoadingMore(true);
    try {
      const result = await api.listKnowledge({
        ...(filters.search.trim().length === 0 ? {} : { search: filters.search }),
        ...(filters.objectType === "" ? {} : {
          objectTypes: [filters.objectType as "term" | "entity" | "alias" | "relation" | "memory" | "style"],
        }),
        ...(filters.status === "" ? {} : {
          statuses: [filters.status as "candidate" | "provisional" | "active" | "needs_revalidate" | "contextual" | "superseded"],
        }),
        ...(filters.scope === "" ? {} : {
          scopes: [filters.scope as "book" | "project" | "global"],
        }),
        ...(filters.origin === "" ? {} : {
          origins: [filters.origin as "model" | "manual" | "import" | "rollback"],
        }),
        cursor,
        limit: 50,
      });
      if (nonce !== listNonce.current) return;
      if (!result.ok) {
        setOperationError(result.error);
        return;
      }
      setView((current) => {
        if (current.status !== "ready") return current;
        return {
          status: "ready",
          page: {
            generation: result.value.generation,
            snapshotId: result.value.snapshotId,
            items: mergeItems(current.page.items, result.value.items),
            ...(result.value.nextCursor === undefined
              ? {}
              : { nextCursor: result.value.nextCursor }),
          },
        };
      });
    } catch (error) {
      if (nonce === listNonce.current) setOperationError(rendererError(error));
    } finally {
      if (nonce === listNonce.current) setLoadingMore(false);
    }
  }

  async function openDetail(id: string, resetDraft = true): Promise<void> {
    const nonce = ++detailNonce.current;
    setDetailState({ status: "loading", id });
    setOperationError(undefined);
    if (resetDraft) {
      setConflict(undefined);
      setFeedback(undefined);
    }
    try {
      const result = await api.getKnowledgeDetail(id);
      if (nonce !== detailNonce.current) return;
      if (!result.ok) {
        setDetailState({ status: "failed", id, error: result.error });
        return;
      }
      setDetailState({ status: "ready", detail: result.value });
      if (resetDraft) setEditorEpoch((current) => current + 1);
    } catch (error) {
      if (nonce === detailNonce.current) {
        setDetailState({ status: "failed", id, error: rendererError(error) });
      }
    }
  }

  function applyMutation(result: DesktopKnowledgeMutationResult, message: string): void {
    setView((current) => current.status === "ready"
      ? { status: "ready", page: updatePageWithMutation(current.page, result) }
      : current);
    setDetailState({ status: "ready", detail: result.detail });
    setConflict(undefined);
    setOperationError(undefined);
    setFeedback(message);
    setEditorEpoch((current) => current + 1);
  }

  async function save(command: UpdateKnowledgeCommand): Promise<void> {
    if (view.status !== "ready") return;
    setSaving(true);
    setConflict(undefined);
    setFeedback(undefined);
    try {
      const result = await api.mutateKnowledge({
        requestId: requestId(),
        expectedGeneration: view.page.generation,
        expectedSnapshotId: view.page.snapshotId,
        command,
      });
      if (!result.ok) {
        if (conflictError(result.error)) setConflict(result.error.code);
        else setOperationError(result.error);
        return;
      }
      applyMutation(result.value, "修改已保存");
    } catch (error) {
      setOperationError(rendererError(error));
    } finally {
      setSaving(false);
    }
  }

  async function rollback(targetRevision: number): Promise<void> {
    if (view.status !== "ready" || detailState.status !== "ready") return;
    const item = detailState.detail.item;
    if (item.scopeRevision === null) {
      setOperationError({
        code: "KNOWLEDGE_ROLLBACK_UNAVAILABLE",
        message: "这条旧版知识缺少可验证的作用域修订，暂时不能恢复。",
        retryable: false,
      });
      return;
    }
    setSaving(true);
    setFeedback(undefined);
    try {
      const result = await api.mutateKnowledge({
        requestId: requestId(),
        expectedGeneration: view.page.generation,
        expectedSnapshotId: view.page.snapshotId,
        command: {
          type: "rollback",
          normalizedSubject: item.normalizedSubject,
          kind: item.kind,
          expectedRevision: item.revision,
          expectedScopeRevision: item.scopeRevision,
          targetRevision,
        },
      });
      if (!result.ok) {
        if (conflictError(result.error)) setConflict(result.error.code);
        else setOperationError(result.error);
        return;
      }
      applyMutation(result.value, "已创建新的恢复修订");
    } catch (error) {
      setOperationError(rendererError(error));
    } finally {
      setSaving(false);
    }
  }

  async function promote(): Promise<void> {
    if (view.status !== "ready" || detailState.status !== "ready") return;
    setSaving(true);
    try {
      const result = await api.promoteKnowledgeToGlobal({
        requestId: requestId(),
        objectId: detailState.detail.item.id,
        expectedGeneration: view.page.generation,
        expectedSnapshotId: view.page.snapshotId,
      });
      if (!result.ok) {
        setOperationError(result.error);
        return;
      }
      applyMutation(result.value, "已保存到通用知识库");
    } catch (error) {
      setOperationError(rendererError(error));
    } finally {
      setSaving(false);
    }
  }

  async function attachGlobal(recordId: string, revision: number): Promise<void> {
    if (view.status !== "ready") return;
    setSaving(true);
    try {
      const result = await api.attachGlobalKnowledge({
        requestId: requestId(),
        recordId,
        revision,
        expectedGeneration: view.page.generation,
        expectedSnapshotId: view.page.snapshotId,
      });
      if (!result.ok) {
        setOperationError(result.error);
        return;
      }
      applyMutation(result.value, "已将所选通用版本添加到当前书");
      setShowGlobalPicker(false);
    } catch (error) {
      setOperationError(rendererError(error));
    } finally {
      setSaving(false);
    }
  }

  const selectedId = detailState.status === "closed" ? undefined : detailState.status === "ready"
    ? detailState.detail.item.id
    : detailState.id;

  async function refreshAfterImport(
    report: CommittedImportReport | RolledBackImportReport,
  ): Promise<void> {
    await loadFirstPage(true);
    if (selectedId !== undefined) {
      await openDetail(selectedId, false);
    }
    setFeedback("rolledBack" in report ? "已撤销本次导入" : "知识已导入");
  }

  return (
    <main className="knowledge-workbench">
      <header className="knowledge-workbench-header">
        <div>
          <p className="eyebrow">BOOK KNOWLEDGE</p>
          <h1>术语与记忆</h1>
          <p className="knowledge-workbench-lead">查阅这本书已经确认的译名、人物身份、关系、叙事记忆与文风约束。</p>
        </div>
        <div className="knowledge-header-actions">
          <button className="quiet-button" type="button" onClick={() => setShowDiagnostics(true)}>
            只读诊断
          </button>
          <button className="quiet-button" type="button" onClick={() => setShowGlobalPicker(true)}>
            添加通用术语
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              if (onImportKnowledge !== undefined) onImportKnowledge();
              else setShowImportWizard(true);
            }}
          >
            导入知识
          </button>
        </div>
      </header>

      <section className="knowledge-filter-bar" aria-label="筛选知识">
        <label className="knowledge-search">
          <span className="visually-hidden">搜索知识</span>
          <input
            type="search"
            aria-label="搜索知识"
            placeholder="搜索原文、译名或类别"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
          />
        </label>
        <label>
          <span>类型</span>
          <select
            aria-label="类型筛选"
            value={filters.objectType}
            onChange={(event) => setFilters((current) => ({ ...current, objectType: event.target.value }))}
          >
            <option value="">全部</option>
            <option value="term">术语</option>
            <option value="entity">实体</option>
            <option value="alias">别名</option>
            <option value="relation">关系</option>
            <option value="memory">记忆</option>
            <option value="style">风格</option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select
            aria-label="状态筛选"
            value={filters.status}
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <option value="">全部</option>
            <option value="active">已启用</option>
            <option value="needs_revalidate">待复核</option>
            <option value="contextual">按语境</option>
            <option value="provisional">暂定</option>
            <option value="candidate">候选</option>
            <option value="superseded">已替代</option>
          </select>
        </label>
        <label>
          <span>范围</span>
          <select
            aria-label="作用域筛选"
            value={filters.scope}
            onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}
          >
            <option value="">全部</option>
            <option value="book">本书</option>
            <option value="project">项目</option>
            <option value="global">通用副本</option>
          </select>
        </label>
        <label>
          <span>来源</span>
          <select
            aria-label="来源筛选"
            value={filters.origin}
            onChange={(event) => setFilters((current) => ({ ...current, origin: event.target.value }))}
          >
            <option value="">全部</option>
            <option value="manual">人工</option>
            <option value="import">导入</option>
            <option value="model">模型</option>
            <option value="rollback">恢复</option>
          </select>
        </label>
        {filters !== EMPTY_FILTERS && Object.values(filters).some((value) => value !== "") ? (
          <button className="text-button" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
            清除筛选
          </button>
        ) : null}
      </section>

      {operationError !== undefined ? (
        <div className="knowledge-inline-error" role="alert">
          <p>{operationError.message}</p>
          <button className="icon-button" type="button" aria-label="关闭错误" onClick={() => setOperationError(undefined)}>×</button>
        </div>
      ) : null}
      {feedback !== undefined && detailState.status !== "ready" ? (
        <div className="knowledge-inline-feedback" role="status">
          <p>{feedback}</p>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭提示"
            onClick={() => setFeedback(undefined)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="knowledge-workspace-body">
        {view.status === "loading" ? (
          <div className="knowledge-loading-state">
            <span className="knowledge-pulse" aria-hidden="true" />
            <p>正在整理这本书的知识脉络…</p>
          </div>
        ) : null}
        {view.status === "failed" ? (
          <div className="knowledge-empty-state" role="alert">
            <p className="eyebrow">LOAD FAILED</p>
            <h2>知识列表没有载入</h2>
            <p>{view.error.message}</p>
            <button className="quiet-button" type="button" onClick={() => { void loadFirstPage(); }}>重新载入</button>
          </div>
        ) : null}
        {view.status === "ready" && view.page.items.length === 0 ? (
          <div className="knowledge-empty-state">
            <p className="eyebrow">NO MATCH</p>
            <h2>没有符合条件的知识</h2>
            <p>换一个关键词或清除筛选；后续扫描与人工导入也会继续补充这里。</p>
          </div>
        ) : null}
        {view.status === "ready" && view.page.items.length > 0 ? (
          <KnowledgeTable
            items={view.page.items}
            nextCursor={view.page.nextCursor}
            selectedId={selectedId}
            loadingMore={loadingMore}
            onSelect={(id) => { void openDetail(id); }}
            onLoadMore={() => { void loadMore(); }}
          />
        ) : null}

        {detailState.status === "loading" ? (
          <aside className="knowledge-drawer is-loading" aria-label="正在载入详情">
            <p className="knowledge-loading">正在读取证据与历史…</p>
          </aside>
        ) : null}
        {detailState.status === "failed" ? (
          <aside className="knowledge-drawer is-failed" aria-label="详情载入失败">
            <button className="icon-button" type="button" aria-label="关闭详情" onClick={() => setDetailState({ status: "closed" })}>×</button>
            <p>{detailState.error.message}</p>
            <button className="quiet-button" type="button" onClick={() => { void openDetail(detailState.id); }}>重试</button>
          </aside>
        ) : null}
        {detailState.status === "ready" ? (
          <KnowledgeDetailDrawer
            detail={detailState.detail}
            saving={saving}
            conflict={conflict}
            feedback={feedback}
            editorEpoch={editorEpoch}
            onClose={() => {
              detailNonce.current += 1;
              setDetailState({ status: "closed" });
              setConflict(undefined);
              setFeedback(undefined);
            }}
            onSave={save}
            onReload={() => openDetail(detailState.detail.item.id)}
            onRollback={rollback}
            onPromote={promote}
            onSelectRelated={(id) => openDetail(id)}
          />
        ) : null}
      </div>

      {showDiagnostics ? (
        <KnowledgeDiagnostics
          load={() => api.getKnowledgeDiagnostics()}
          onClose={() => setShowDiagnostics(false)}
        />
      ) : null}
      {showGlobalPicker && view.status === "ready" ? (
        <GlobalKnowledgePicker
          load={(request) => api.listGlobalKnowledge(request)}
          attaching={saving}
          onAttach={attachGlobal}
          onClose={() => setShowGlobalPicker(false)}
        />
      ) : null}
      {showImportWizard && view.status === "ready" ? (
        <KnowledgeImportWizard
          api={api}
          generation={view.page.generation}
          snapshotId={view.page.snapshotId}
          onClose={() => setShowImportWizard(false)}
          onCommitted={(report) => { void refreshAfterImport(report); }}
        />
      ) : null}
      {importSlot}
    </main>
  );
}
