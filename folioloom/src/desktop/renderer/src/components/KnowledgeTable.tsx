import {
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import type { DesktopKnowledgePage } from "../../../knowledge-contracts.js";

type KnowledgeItem = DesktopKnowledgePage["items"][number];

interface KnowledgeTableProps {
  items: readonly KnowledgeItem[];
  nextCursor?: string;
  selectedId?: string;
  loadingMore: boolean;
  onSelect(id: string): void;
  onLoadMore(): void;
  rowHeight?: number;
  overscan?: number;
}
const TYPE_LABELS: Readonly<Record<KnowledgeItem["objectType"], string>> = {
  term: "术语",
  entity: "实体",
  alias: "别名",
  relation: "关系",
  memory: "记忆",
  style: "风格",
};

const SCOPE_LABELS: Readonly<Record<KnowledgeItem["scope"], string>> = {
  book: "本书",
  project: "项目",
  global: "通用副本",
};

const STATUS_LABELS: Readonly<Record<KnowledgeItem["status"], string>> = {
  candidate: "候选",
  provisional: "暂定",
  active: "已启用",
  needs_revalidate: "待复核",
  contextual: "按语境",
  superseded: "已替代",
};

function selectWithKeyboard(
  event: KeyboardEvent<HTMLTableRowElement>,
  id: string,
  onSelect: (id: string) => void,
): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect(id);
  }
}

export function KnowledgeTable({
  items,
  nextCursor,
  selectedId,
  loadingMore,
  onSelect,
  onLoadMore,
  rowHeight = 44,
  overscan = 8,
}: KnowledgeTableProps): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const useWindowing = items.length > 80;
  const windowRange = useMemo(() => {
    if (!useWindowing) return { start: 0, end: items.length };
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const count = Math.ceil(viewportHeight / rowHeight) + (overscan * 2);
    return { start: first, end: Math.min(items.length, first + count) };
  }, [items.length, overscan, rowHeight, scrollTop, useWindowing, viewportHeight]);
  const visibleItems = items.slice(windowRange.start, windowRange.end);
  const beforeHeight = windowRange.start * rowHeight;
  const afterHeight = (items.length - windowRange.end) * rowHeight;

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight || 520);
  }

  return (
    <section className="knowledge-table-panel" aria-label="知识列表">
      <div className="knowledge-table-scroll" onScroll={handleScroll}>
        <table className="knowledge-table" aria-label="知识条目">
          <thead>
            <tr>
              <th scope="col">原文形式</th>
              <th scope="col">类型</th>
              <th scope="col">作用域</th>
              <th scope="col">状态</th>
              <th scope="col">来源</th>
              <th scope="col">修订</th>
            </tr>
          </thead>
          <tbody>
            {beforeHeight > 0 ? (
              <tr className="knowledge-spacer" aria-hidden="true">
                <td colSpan={6} style={{ height: beforeHeight }} />
              </tr>
            ) : null}
            {visibleItems.map((item) => (
              <tr
                key={item.id}
                className={item.id === selectedId ? "is-selected" : ""}
                aria-label={`${item.displayName} ${item.normalizedSubject} ${TYPE_LABELS[item.objectType]}`}
                aria-selected={item.id === selectedId}
                tabIndex={0}
                onClick={() => onSelect(item.id)}
                onKeyDown={(event) => selectWithKeyboard(event, item.id, onSelect)}
                style={{ height: rowHeight }}
              >
                <td>
                  <span className="knowledge-primary">{item.displayName}</span>
                  {item.normalizedSubject !== item.displayName ? (
                    <span className="knowledge-secondary">{item.normalizedSubject}</span>
                  ) : null}
                </td>
                <td><span className="knowledge-type">{TYPE_LABELS[item.objectType]}</span></td>
                <td>{SCOPE_LABELS[item.scope]}</td>
                <td><span className={`knowledge-status is-${item.status}`}>{STATUS_LABELS[item.status]}</span></td>
                <td>{item.origin}</td>
                <td className="knowledge-revision">r{item.revision}</td>
              </tr>
            ))}
            {afterHeight > 0 ? (
              <tr className="knowledge-spacer" aria-hidden="true">
                <td colSpan={6} style={{ height: afterHeight }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <footer className="knowledge-table-footer">
        <span>已显示 {items.length} 条</span>
        {nextCursor !== undefined ? (
          <button
            className="quiet-button"
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "正在载入…" : "加载更多"}
          </button>
        ) : (
          <span>已到末尾</span>
        )}
      </footer>
    </section>
  );
}
