import { useState, type JSX } from "react";

import type {
  UpdateKnowledgeCommand,
} from "../../../../knowledge/knowledge-commands.js";
import type { DesktopKnowledgeDetail } from "../../../knowledge-contracts.js";
import { KnowledgeEditor } from "./KnowledgeEditor.js";
import { KnowledgeRelationGraph } from "./KnowledgeRelationGraph.js";

interface KnowledgeDetailDrawerProps {
  detail: DesktopKnowledgeDetail;
  saving: boolean;
  conflict?: string;
  feedback?: string;
  editorEpoch: number;
  onClose(): void;
  onSave(command: UpdateKnowledgeCommand): Promise<void> | void;
  onReload(): Promise<void> | void;
  onRollback(revision: number): Promise<void> | void;
  onPromote(): Promise<void> | void;
  onSelectRelated(id: string): Promise<void> | void;
}

const ORIGIN_LABELS = {
  model: "模型扫描",
  manual: "人工编辑",
  import: "文件导入",
  rollback: "版本恢复",
} as const;

function displayJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join("、");
  return JSON.stringify(value, null, 2);
}

export function KnowledgeDetailDrawer({
  detail,
  saving,
  conflict,
  feedback,
  editorEpoch,
  onClose,
  onSave,
  onReload,
  onRollback,
  onPromote,
  onSelectRelated,
}: KnowledgeDetailDrawerProps): JSX.Element {
  const [relationsExpanded, setRelationsExpanded] = useState(false);
  const promotable = detail.item.objectType === "term" || detail.item.objectType === "style";

  return (
    <aside className="knowledge-drawer" aria-label={`${detail.item.displayName} 详情`}>
      <header className="knowledge-drawer-header">
        <div>
          <p className="eyebrow">{detail.item.objectType.toUpperCase()} / r{detail.item.revision}</p>
          <h2>{detail.item.displayName}</h2>
          <p>{detail.item.normalizedSubject}</p>
        </div>
        <button className="icon-button" type="button" aria-label="关闭详情" onClick={onClose}>×</button>
      </header>

      <div className="knowledge-drawer-scroll">
        {feedback !== undefined ? <p className="knowledge-feedback" role="status">{feedback}</p> : null}

        <section className="knowledge-detail-section">
          <p className="drawer-section-kicker">当前字段</p>
          <dl className="knowledge-field-list">
            {Object.entries(detail.fields).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{displayJson(value)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <KnowledgeEditor
          key={`${detail.item.id}:${detail.item.revision}:${editorEpoch}`}
          detail={detail}
          saving={saving}
          conflict={conflict}
          onSave={onSave}
          onReload={onReload}
        />

        {promotable ? (
          <section className="knowledge-detail-section promote-section">
            <p className="drawer-section-kicker">跨书复用</p>
            <h3>{detail.item.objectType === "term" ? "保存为通用术语" : "保存为通用风格"}</h3>
            <p>只复制当前术语或风格字段；本书中的证据、人物关系和文本位置不会进入通用库。</p>
            <button className="quiet-button" type="button" disabled={saving} onClick={() => { void onPromote(); }}>
              {detail.item.objectType === "term" ? "保存为通用术语" : "保存为通用风格"}
            </button>
          </section>
        ) : null}

        <section className="knowledge-detail-section">
          <p className="drawer-section-kicker">原文证据</p>
          <h3>为何这样判断</h3>
          {detail.evidence.length === 0 ? <p className="knowledge-empty-copy">没有可显示的原文证据。</p> : (
            <ol className="evidence-list">
              {detail.evidence.map((evidence, index) => (
                <li key={`${evidence.kind}:${evidence.globalIndex ?? index}:${index}`}>
                  <span>{evidence.kind}{evidence.globalIndex === undefined ? "" : ` · #${evidence.globalIndex}`}</span>
                  {evidence.sourceText !== undefined ? <blockquote>{evidence.sourceText}</blockquote> : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="knowledge-detail-section">
          <p className="drawer-section-kicker">局部关系</p>
          <h3>相邻对象</h3>
          <KnowledgeRelationGraph
            rootId={detail.item.id}
            relations={detail.relations}
            expanded={relationsExpanded}
            onExpandedChange={setRelationsExpanded}
            onSelect={(id) => { void onSelectRelated(id); }}
          />
        </section>

        <section className="knowledge-detail-section">
          <p className="drawer-section-kicker">版本历史</p>
          <h3>可追溯修订</h3>
          <ol className="revision-timeline">
            {detail.history.map((revision) => (
              <li key={revision.revisionId}>
                <div>
                  <strong>版本 {revision.revision}</strong>
                  <span>{ORIGIN_LABELS[revision.origin]} · {revision.scope}</span>
                  <time>{revision.createdAt}</time>
                </div>
                {revision.revision !== detail.item.revision ? (
                  <button
                    className="text-button"
                    type="button"
                    aria-label={`恢复版本 ${revision.revision}`}
                    disabled={saving}
                    title="恢复会创建一条新的修订，不会删除历史"
                    onClick={() => { void onRollback(revision.revision); }}
                  >
                    恢复此版本
                  </button>
                ) : <span className="current-revision">当前</span>}
              </li>
            ))}
          </ol>
        </section>

        <section className="knowledge-detail-section">
          <p className="drawer-section-kicker">翻译影响</p>
          <h3>可能受影响的文本块</h3>
          {detail.impacts.length === 0 ? <p className="knowledge-empty-copy">没有已记录的受影响文本块。</p> : (
            <ul className="impact-list">
              {detail.impacts.map((impact) => (
                <li key={`${impact.blockId}:${impact.globalIndex}`}>
                  <span>{impact.blockId}</span>
                  <span>#{impact.globalIndex}</span>
                  <span className={`knowledge-status is-${impact.status}`}>{impact.status}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="knowledge-form-note">这里仅作提示；已有译文不会被静默改写。</p>
        </section>
      </div>
    </aside>
  );
}
