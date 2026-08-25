import {
  useMemo,
  useState,
  type FormEvent,
  type JSX,
} from "react";

import type { JsonValue, KnowledgeScope } from "../../../../knowledge/knowledge-authority.js";
import type {
  KnowledgeObjectType,
  UpdateKnowledgeCommand,
} from "../../../../knowledge/knowledge-commands.js";
import type { DesktopKnowledgeDetail } from "../../../knowledge-contracts.js";

type EditorFieldKind = "text" | "textarea" | "list" | "select";

interface EditorField {
  readonly key: string;
  readonly label: string;
  readonly kind: EditorFieldKind;
  readonly placeholder?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly required?: boolean;
  readonly maxLength?: number;
}

const EDITABLE_FIELDS: Readonly<Record<KnowledgeObjectType, readonly EditorField[]>> = {
  term: [
    { key: "sourceForm", label: "原文形式", kind: "text" },
    { key: "target", label: "首选译法", kind: "text", required: true },
    { key: "alternatives", label: "备选译法", kind: "list", placeholder: "每行一个译法" },
    {
      key: "policy",
      label: "使用规则",
      kind: "select",
      options: [
        { value: "preferred", label: "优先使用" },
        { value: "contextual", label: "按语境变化" },
        { value: "locked", label: "锁定译法" },
      ],
    },
    { key: "note", label: "译者备注", kind: "textarea" },
  ],
  entity: [
    { key: "canonicalName", label: "规范名称", kind: "text", required: true },
    { key: "targetName", label: "中文名称", kind: "text" },
    { key: "entityType", label: "实体类型", kind: "text" },
    { key: "description", label: "描述", kind: "textarea" },
  ],
  alias: [
    { key: "alias", label: "别名", kind: "text", required: true },
    { key: "entityId", label: "所指实体", kind: "text", required: true },
    { key: "context", label: "适用语境", kind: "textarea" },
  ],
  relation: [
    { key: "fromEntityId", label: "主体", kind: "text", required: true },
    { key: "relationType", label: "关系", kind: "text", required: true },
    { key: "toEntityId", label: "客体", kind: "text", required: true },
    { key: "position", label: "生效位置", kind: "text" },
  ],
  memory: [
    { key: "summary", label: "记忆内容", kind: "textarea", required: true, maxLength: 8_192 },
    { key: "startBlockId", label: "生效起点", kind: "text" },
    { key: "endBlockId", label: "失效点", kind: "text" },
    { key: "entities", label: "关联实体", kind: "list", placeholder: "每行一个实体" },
  ],
  style: [
    { key: "narrativeDistance", label: "叙事距离", kind: "textarea", maxLength: 180 },
    { key: "dialogueRegister", label: "对话语体", kind: "textarea", maxLength: 180 },
    { key: "technicalProse", label: "技术性文字", kind: "textarea", maxLength: 180 },
  ],
};

interface KnowledgeEditorProps {
  detail: DesktopKnowledgeDetail;
  saving: boolean;
  conflict?: string;
  onSave(command: UpdateKnowledgeCommand): Promise<void> | void;
  onReload(): Promise<void> | void;
}

function stringValue(value: JsonValue | undefined, kind: EditorFieldKind): string {
  if (kind === "list") {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .join("\n");
    }
    return typeof value === "string" ? value : "";
  }
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function jsonValue(value: string, kind: EditorFieldKind): JsonValue {
  if (kind === "list") {
    return value
      .split(/\r?\n|,/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return value;
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left ?? "") === JSON.stringify(right);
}

function pointer(field: string): string {
  return `/${field.replace(/~/gu, "~0").replace(/\//gu, "~1")}`;
}

function initialDraft(
  detail: DesktopKnowledgeDetail,
  fields: readonly EditorField[],
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.key, stringValue(detail.fields[field.key], field.kind)]),
  );
}

export function KnowledgeEditor({
  detail,
  saving,
  conflict,
  onSave,
  onReload,
}: KnowledgeEditorProps): JSX.Element {
  const fields = EDITABLE_FIELDS[detail.item.objectType];
  const [draft, setDraft] = useState<Record<string, string>>(
    () => initialDraft(detail, fields),
  );
  const [scope, setScope] = useState<KnowledgeScope>(detail.item.scope);
  const [copyFeedback, setCopyFeedback] = useState<string>();

  const fieldPatch = useMemo(() => {
    const patch: Record<string, JsonValue> = {};
    for (const field of fields) {
      const next = jsonValue(draft[field.key] ?? "", field.kind);
      const current = jsonValue(
        stringValue(detail.fields[field.key], field.kind),
        field.kind,
      );
      if (!jsonEqual(current, next)) patch[field.key] = next;
    }
    return patch;
  }, [detail.fields, draft, fields]);
  const changedFields = Object.keys(fieldPatch);
  const validationMessage = useMemo(() => {
    const missing = fields.find((field) =>
      field.required === true && (draft[field.key] ?? "").trim().length === 0);
    if (missing !== undefined) return `${missing.label}不能为空`;
    if (detail.item.objectType === "memory") {
      const hasStart = (draft.startBlockId ?? "").trim().length > 0;
      const hasEnd = (draft.endBlockId ?? "").trim().length > 0;
      if (hasStart !== hasEnd) return "生效起点和失效点必须同时填写";
    }
    if (detail.item.objectType === "style"
      && fields.every((field) => (draft[field.key] ?? "").trim().length === 0)) {
      return "至少填写一项风格要求";
    }
    const cleared = fields.find((field) =>
      (draft[field.key] ?? "").trim().length === 0
      && stringValue(detail.fields[field.key], field.kind).trim().length > 0);
    if (cleared !== undefined) {
      return `${cleared.label}不能保存为空值`;
    }
    return undefined;
  }, [detail.fields, detail.item.objectType, draft, fields]);
  const dirty = changedFields.length > 0 || scope !== detail.item.scope;
  const canSave = changedFields.length > 0 && validationMessage === undefined && !saving;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    await onSave({
      type: "upsert",
      objectType: detail.item.objectType,
      normalizedSubject: detail.item.normalizedSubject,
      kind: detail.item.kind,
      expectedRevision: detail.item.revision,
      expectedScopeRevision: detail.item.scopeRevision,
      fieldPatch,
      ownedFields: changedFields.map(pointer),
      scope,
      evidence: [],
      origin: "manual",
    });
  }

  async function copyDraft(): Promise<void> {
    const text = JSON.stringify({ scope, ...draft }, null, 2);
    try {
      await navigator.clipboard?.writeText(text);
      setCopyFeedback("草稿已复制");
    } catch {
      setCopyFeedback("无法访问剪贴板，请手动复制字段内容");
    }
  }

  return (
    <form className="knowledge-editor" onSubmit={(event) => { void submit(event); }}>
      <div className="knowledge-editor-heading">
        <div>
          <p className="drawer-section-kicker">语义编辑</p>
          <h3>修改当前知识</h3>
        </div>
        {dirty ? <span className="draft-indicator">有未保存修改</span> : null}
      </div>

      <div className="knowledge-editor-fields">
        {fields.map((field) => (
          <label className="knowledge-field" key={field.key}>
            <span>{field.label}</span>
            {field.kind === "select" ? (
              <select
                aria-label={field.label}
                value={draft[field.key] ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, [field.key]: event.target.value }));
                }}
              >
                {detail.fields[field.key] === undefined ? <option value="">未指定</option> : null}
                {field.options?.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            ) : field.kind === "textarea" || field.kind === "list" ? (
              <textarea
                aria-label={field.label}
                value={draft[field.key] ?? ""}
                placeholder={field.placeholder}
                rows={field.kind === "list" ? 3 : 4}
                maxLength={field.maxLength}
                disabled={saving}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, [field.key]: event.target.value }));
                }}
              />
            ) : (
              <input
                aria-label={field.label}
                value={draft[field.key] ?? ""}
                maxLength={field.maxLength ?? 512}
                disabled={saving}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, [field.key]: event.target.value }));
                }}
              />
            )}
          </label>
        ))}
        <label className="knowledge-field">
          <span>作用域</span>
          <select
            aria-label="作用域"
            value={scope}
            disabled={saving || detail.item.scope === "global"}
            onChange={(event) => setScope(event.target.value as KnowledgeScope)}
          >
            <option value="book">仅当前书</option>
            <option value="project">当前项目</option>
            {detail.item.scope === "global" ? <option value="global">通用副本</option> : null}
          </select>
        </label>
      </div>

      {scope !== detail.item.scope && changedFields.length === 0 ? (
        <p className="knowledge-form-note">作用域会随下一项字段修改一起保存。</p>
      ) : null}
      {validationMessage !== undefined ? (
        <p className="knowledge-validation-message" role="alert">{validationMessage}</p>
      ) : null}

      {conflict !== undefined ? (
        <div className="knowledge-conflict" role="alert">
          <strong>这条知识已在其他位置更新</strong>
          <p>草稿仍保留。重新载入可查看最新版本，或先复制草稿再决定。</p>
          <div>
            <button className="quiet-button" type="button" onClick={() => { void onReload(); }}>
              重新载入
            </button>
            <button className="text-button" type="button" onClick={() => { void copyDraft(); }}>
              复制草稿
            </button>
          </div>
          {copyFeedback !== undefined ? <p>{copyFeedback}</p> : null}
        </div>
      ) : null}

      <div className="knowledge-editor-actions">
        <button className="primary-button" type="submit" disabled={!canSave}>
          {saving ? "正在保存…" : "保存修改"}
        </button>
      </div>
    </form>
  );
}
