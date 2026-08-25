import { useEffect, useRef, useState, type JSX } from "react";

import type {
  DesktopError,
  DesktopResult,
} from "../../../contracts.js";
import type {
  DesktopGlobalKnowledgeListRequest,
  DesktopGlobalKnowledgePage,
} from "../../../knowledge-contracts.js";

interface GlobalKnowledgePickerProps {
  load(request: DesktopGlobalKnowledgeListRequest): Promise<DesktopResult<DesktopGlobalKnowledgePage>>;
  attaching: boolean;
  onAttach(recordId: string, revision: number): Promise<void> | void;
  onClose(): void;
}
type PickerState =
  | { status: "loading"; items: DesktopGlobalKnowledgePage["items"] }
  | {
    status: "ready";
    items: DesktopGlobalKnowledgePage["items"];
    nextCursor?: string;
  }
  | { status: "failed"; items: DesktopGlobalKnowledgePage["items"]; error: DesktopError };

export function GlobalKnowledgePicker({
  load,
  attaching,
  onAttach,
  onClose,
}: GlobalKnowledgePickerProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<PickerState>({ status: "loading", items: [] });
  const [selected, setSelected] = useState<{ recordId: string; revision: number }>();
  const nonce = useRef(0);

  async function loadPage(cursor?: string): Promise<void> {
    const requestNonce = ++nonce.current;
    setState((current) => ({
      status: "loading",
      items: cursor === undefined ? [] : current.items,
    }));
    const result = await load({
      search,
      objectTypes: ["term", "style"],
      limit: 50,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (requestNonce !== nonce.current) return;
    if (!result.ok) {
      setState((current) => ({ status: "failed", items: current.items, error: result.error }));
      return;
    }
    setState((current) => ({
      status: "ready",
      items: cursor === undefined
        ? result.value.items
        : [...current.items, ...result.value.items],
      ...(result.value.nextCursor === undefined
        ? {}
        : { nextCursor: result.value.nextCursor }),
    }));
  }

  useEffect(() => {
    void loadPage();
  }, [search]);

  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section className="knowledge-modal global-picker" role="dialog" aria-modal="true" aria-labelledby="global-picker-title">
        <header className="knowledge-modal-header">
          <div>
            <p className="eyebrow">GLOBAL LIBRARY</p>
            <h2 id="global-picker-title">添加通用术语与风格</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭通用知识" onClick={onClose}>×</button>
        </header>
        <p className="knowledge-modal-copy">
          当前书将保存所选版本的副本；通用库未来发生变化时，本书不会自动漂移。
        </p>
        <label className="knowledge-search compact">
          <span className="visually-hidden">搜索通用知识</span>
          <input
            type="search"
            aria-label="搜索通用知识"
            placeholder="按原文或译名搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="global-picker-list">
          {state.items.map((item) => {
            const checked = selected?.recordId === item.recordId
              && selected.revision === item.revision;
            return (
              <label className={`global-picker-item${checked ? " is-selected" : ""}`} key={`${item.recordId}:${item.revision}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  aria-label={`${item.displayValue} revision ${item.revision}`}
                  onChange={() => setSelected(checked
                    ? undefined
                    : { recordId: item.recordId, revision: item.revision })}
                />
                <span>
                  <strong>{item.displayValue}</strong>
                  <small>{item.objectType === "term" ? "术语" : "风格"} · revision {item.revision}</small>
                </span>
              </label>
            );
          })}
          {state.status === "loading" ? <p className="knowledge-loading">正在读取通用库…</p> : null}
          {state.status === "ready" && state.items.length === 0 ? (
            <p className="knowledge-empty-copy">没有匹配的通用术语或风格。</p>
          ) : null}
          {state.status === "failed" ? (
            <p className="knowledge-inline-error" role="alert">{state.error.message}</p>
          ) : null}
        </div>
        <footer className="knowledge-modal-actions">
          {state.status === "ready" && state.nextCursor !== undefined ? (
            <button className="text-button" type="button" onClick={() => { void loadPage(state.nextCursor); }}>
              加载更多通用知识
            </button>
          ) : <span />}
          <button
            className="primary-button"
            type="button"
            disabled={selected === undefined || attaching}
            onClick={() => {
              if (selected !== undefined) void onAttach(selected.recordId, selected.revision);
            }}
          >
            {attaching ? "正在添加…" : "添加到当前书"}
          </button>
        </footer>
      </section>
    </div>
  );
}
