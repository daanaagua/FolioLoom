import {
  useEffect,
  useMemo,
  useState,
  type JSX,
} from "react";

import type {
  ImportFieldMapping,
  ImportInspection,
  ImportSelection,
  MappingSuggestion,
} from "../../../contracts.js";

const FIELD_LABELS: Readonly<Record<string, string>> = {
  sourceForm: "原文形式",
  canonicalSource: "规范原文",
  target: "首选译法",
  alternatives: "备选译法",
  policy: "使用规则",
  locked: "锁定",
  note: "备注",
  canonicalName: "规范名称",
  targetName: "中文名称",
  entityType: "实体类型",
  description: "描述",
  alias: "别名",
  entityId: "所指实体",
  context: "适用语境",
  fromEntityId: "主体",
  relationType: "关系",
  toEntityId: "客体",
  position: "生效位置",
  summary: "记忆内容",
  startBlockId: "生效起点",
  endBlockId: "失效点",
  entities: "关联实体",
  narrativeDistance: "叙事距离",
  dialogueRegister: "对话语体",
  technicalProse: "技术性文字",
  formality: "正式程度",
  rhythm: "节奏",
  imagery: "意象",
  terminology: "术语风格",
  sentenceTexture: "句式质地",
  additionalInstruction: "补充要求",
};

const OBJECT_TYPE_LABELS: Readonly<Record<ImportSelection["objectType"], string>> = {
  term: "术语",
  entity: "实体",
  alias: "别名",
  relation: "关系",
  memory: "叙事记忆",
  style: "风格",
};

interface ImportMappingStepProps {
  inspection: ImportInspection;
  suggestion: MappingSuggestion;
  busy: boolean;
  onSelectionChange(selection: ImportSelection): void;
  onConfirm(
    selection: ImportSelection,
    fields: Readonly<Record<string, ImportFieldMapping | undefined>>,
  ): void;
}

function mappedEntries(
  fields: MappingSuggestion["fields"],
): Array<[string, ImportFieldMapping]> {
  return Object.entries(fields).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, value] as [string, ImportFieldMapping]]);
}

export function ImportMappingStep({
  inspection,
  suggestion,
  busy,
  onSelectionChange,
  onConfirm,
}: ImportMappingStepProps): JSX.Element {
  const [fields, setFields] = useState(suggestion.fields);
  useEffect(() => setFields(suggestion.fields), [suggestion]);
  const entries = useMemo(() => mappedEntries(fields), [fields]);
  const columns = useMemo(() => {
    const names = new Set<string>();
    for (const row of inspection.sample.slice(0, 50)) {
      for (const key of Object.keys(row.values)) names.add(key);
    }
    return [...names];
  }, [inspection.sample]);
  const canContinue = entries.length > 0
    && entries.every(([, field]) => field.confirmed)
    && !busy;

  function updateField(
    targetField: string,
    patch: Partial<ImportFieldMapping>,
  ): void {
    setFields((current) => {
      const field = current[targetField];
      if (field === undefined) return current;
      return {
        ...current,
        [targetField]: { ...field, ...patch },
      };
    });
  }

  function updateSelection(
    patch: Partial<ImportSelection>,
  ): void {
    onSelectionChange({ ...suggestion.selection, ...patch });
  }

  return (
    <section className="import-step import-mapping-step">
      <header className="import-step-heading">
        <p className="drawer-section-kicker">第 2 步</p>
        <h2>核对字段映射</h2>
        <p>系统只读取你选中的列。中等置信度的判断需要你亲自确认。</p>
      </header>

      <div className="import-selection-grid">
        <label className="knowledge-field">
          <span>对象类型</span>
          <select
            aria-label="对象类型"
            value={suggestion.selection.objectType}
            disabled={busy}
            onChange={(event) => updateSelection({
              objectType: event.target.value as ImportSelection["objectType"],
            })}
          >
            {Object.entries(OBJECT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="knowledge-field">
          <span>保存范围</span>
          <select
            aria-label="保存范围"
            value={suggestion.selection.scope}
            disabled={busy}
            onChange={(event) => updateSelection({
              scope: event.target.value as ImportSelection["scope"],
            })}
          >
            <option value="book">当前书籍</option>
            <option value="project">当前项目</option>
          </select>
        </label>
        {inspection.recordPaths.length > 0 ? (
          <label className="knowledge-field">
            <span>记录位置</span>
            <select
              aria-label="记录位置"
              value={suggestion.selection.recordPathId}
              disabled={busy}
              onChange={(event) => updateSelection({
                recordPathId: event.target.value,
              })}
            >
              {inspection.recordPaths.map((path) => (
                <option key={path.id} value={path.id}>{path.label}</option>
              ))}
            </select>
          </label>
        ) : null}
        {inspection.sheets.length > 0 ? (
          <label className="knowledge-field">
            <span>工作表</span>
            <select
              aria-label="工作表"
              value={suggestion.selection.sheetId}
              disabled={busy}
              onChange={(event) => updateSelection({
                sheetId: event.target.value,
              })}
            >
              {inspection.sheets.map((sheet) => (
                <option key={sheet.id} value={sheet.id}>{sheet.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="import-mapping-list">
        {entries.map(([key, field]) => {
          const label = FIELD_LABELS[key] ?? key;
          return (
            <article className={`import-mapping-row is-${field.confidence}`} key={key}>
              <div>
                <strong>{label}</strong>
                <span>{field.confidence} confidence</span>
              </div>
              <label className="knowledge-field">
                <span className="sr-only">{label}的来源列</span>
                <select
                  aria-label={`${label}的来源列`}
                  value={field.sourceColumn}
                  disabled={busy}
                  onChange={(event) => updateField(key, {
                    sourceColumn: event.target.value,
                    confirmed: false,
                  })}
                >
                  {columns.map((column) => (
                    <option key={column} value={column}>{column}</option>
                  ))}
                </select>
              </label>
              <label className="import-confirm-mapping">
                <input
                  type="checkbox"
                  checked={field.confirmed}
                  disabled={busy}
                  onChange={(event) => updateField(key, {
                    confirmed: event.target.checked,
                  })}
                />
                {field.confirmed
                  ? "已确认"
                  : `请确认“${label}”的来源列`}
              </label>
              <p>{suggestion.reasons[key]?.join("；")}</p>
            </article>
          );
        })}
      </div>

      <details className="import-sample-preview">
        <summary>查看样例（最多 50 行）</summary>
        <div className="import-sample-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">位置</th>
                {columns.map((column) => <th scope="col" key={column}>{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {inspection.sample.slice(0, 50).map((row) => (
                <tr key={`${row.location}:${row.ordinal}`}>
                  <td>{row.location}</td>
                  {columns.map((column) => (
                    <td key={column}>{String(row.values[column] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <footer className="import-step-actions">
        <button
          className="primary-button"
          type="button"
          disabled={!canContinue}
          onClick={() => onConfirm(suggestion.selection, fields)}
        >
          {busy ? "正在生成预览…" : "生成预览"}
        </button>
      </footer>
    </section>
  );
}
