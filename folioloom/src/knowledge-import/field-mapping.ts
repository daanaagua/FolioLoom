import { createHash } from "node:crypto";

import { canonicalJson } from "../knowledge/knowledge-store.js";
import type { KnowledgeObjectType } from "../knowledge/knowledge-commands.js";
import type { ImportColumn } from "./csv-reader.js";
import { OFFICIAL_KNOWLEDGE_IMPORT_SCHEMA } from "./official-template.js";
import type {
  ImportFieldMapping,
  ImportRecordSource,
  ImportSelection,
  KnowledgeImportFormat,
  KnowledgeImportScope,
  MappingSuggestion,
} from "./types.js";

type ImportColumnInput = string | ImportColumn;

interface FieldDefinition {
  readonly aliases: readonly string[];
  readonly weakAliases?: readonly string[];
  readonly shape?: "boolean" | "list" | "number" | "text";
}

const FIELD_DEFINITIONS: Readonly<Record<
  KnowledgeObjectType,
  Readonly<Record<string, FieldDefinition>>
>> = {
  term: {
    source: {
      aliases: ["source", "source form", "original", "term", "原文", "原词", "词条", "原語", "原語表記", "원문", "원어"],
      shape: "text",
    },
    target: {
      aliases: ["target", "translation", "translated term", "译文", "译名", "翻译", "訳語", "翻訳", "번역", "번역어"],
      shape: "text",
    },
    sourceForms: {
      aliases: ["source forms", "forms", "variants", "原文变体", "变体", "表記揺れ", "이형", "변형"],
      shape: "list",
    },
    alternatives: {
      aliases: ["alternatives", "alternate translations", "备选译名", "其他译名", "別訳", "대체 번역"],
      shape: "list",
    },
    policy: {
      aliases: ["policy", "translation policy", "策略", "翻译策略", "方針", "번역 정책"],
      shape: "text",
    },
    note: {
      aliases: ["note", "notes", "备注", "備考", "메모", "비고"],
      weakAliases: ["description", "说明", "描述", "解説", "설명"],
      shape: "text",
    },
    locked: {
      aliases: ["locked", "lock", "锁定", "固定", "ロック", "잠금"],
      shape: "boolean",
    },
    contexts: {
      aliases: ["contexts", "context", "语境", "上下文", "文脈", "문맥"],
      shape: "list",
    },
    register: {
      aliases: ["register", "语域", "文体层级", "語域", "격식"],
      shape: "text",
    },
  },
  entity: {
    canonicalName: {
      aliases: ["canonical name", "name", "entity", "人物", "名称", "规范名", "正式名称", "正規名", "이름", "정식명"],
      shape: "text",
    },
    targetName: {
      aliases: ["target name", "translated name", "译名", "中文名", "訳名", "번역명"],
      shape: "text",
    },
    entityType: {
      aliases: ["entity type", "type", "类别", "类型", "種別", "유형"],
      shape: "text",
    },
    description: {
      aliases: ["description", "简介", "描述", "说明", "解説", "설명"],
      shape: "text",
    },
    aliases: {
      aliases: ["aliases", "alias", "别名", "别称", "別名", "별명"],
      shape: "list",
    },
    gender: {
      aliases: ["gender", "性别", "性別", "성별"],
      shape: "text",
    },
    pronouns: {
      aliases: ["pronouns", "代词", "代名詞", "대명사"],
      shape: "list",
    },
    note: {
      aliases: ["note", "notes", "备注", "備考", "메모", "비고"],
      shape: "text",
    },
  },
  alias: {
    alias: {
      aliases: ["alias", "别名", "别称", "別名", "별명"],
      shape: "text",
    },
    entityId: {
      aliases: ["entity id", "entity", "canonical entity", "实体", "本体", "对象", "対象", "개체"],
      shape: "text",
    },
    context: {
      aliases: ["context", "语境", "上下文", "文脈", "문맥"],
      shape: "text",
    },
    note: {
      aliases: ["note", "notes", "备注", "備考", "메모", "비고"],
      shape: "text",
    },
  },
  relation: {
    fromEntityId: {
      aliases: ["from entity", "from", "source entity", "主体", "起点", "始点", "주체"],
      shape: "text",
    },
    relationType: {
      aliases: ["relation type", "relation", "关系", "关系类型", "関係", "관계"],
      shape: "text",
    },
    toEntityId: {
      aliases: ["to entity", "to", "target entity", "客体", "终点", "終点", "대상"],
      shape: "text",
    },
    position: {
      aliases: ["position", "order", "位置", "顺序", "位置番号", "순서"],
      shape: "number",
    },
    note: {
      aliases: ["note", "notes", "备注", "備考", "메모", "비고"],
      shape: "text",
    },
  },
  memory: {
    summary: {
      aliases: ["summary", "memory", "event", "摘要", "记忆", "事件", "要約", "出来事", "요약", "사건"],
      shape: "text",
    },
    startBlockId: {
      aliases: ["start block", "start", "起始块", "开始位置", "開始位置", "시작 위치"],
      shape: "text",
    },
    endBlockId: {
      aliases: ["end block", "end", "结束块", "结束位置", "終了位置", "종료 위치"],
      shape: "text",
    },
    entities: {
      aliases: ["entities", "characters", "人物", "相关实体", "登場人物", "등장인물"],
      shape: "list",
    },
    timeline: {
      aliases: ["timeline", "time", "时间线", "时间", "時系列", "타임라인"],
      shape: "list",
    },
    note: {
      aliases: ["note", "notes", "备注", "備考", "메모", "비고"],
      shape: "text",
    },
  },
  style: {
    register: { aliases: ["register", "语域", "語域", "격식"], shape: "text" },
    sentencePolicy: { aliases: ["sentence policy", "句式", "文の方針", "문장 방침"], shape: "text" },
    explicitation: { aliases: ["explicitation", "显化", "明示化", "명시화"], shape: "text" },
    imagery: { aliases: ["imagery", "意象", "イメージ", "이미지"], shape: "text" },
    dialogue: { aliases: ["dialogue", "对话", "台詞", "대화"], shape: "text" },
    technicalProse: { aliases: ["technical prose", "技术文体", "技術文体", "기술 문체"], shape: "text" },
    typography: { aliases: ["typography", "排版", "組版", "조판"], shape: "text" },
    narratorVoice: { aliases: ["narrator voice", "叙述声音", "語り口", "서술 어조"], shape: "text" },
    additionalInstruction: { aliases: ["additional instruction", "附加指令", "追加指示", "추가 지침"], shape: "text" },
    narrativeDistance: { aliases: ["narrative distance", "叙事距离", "物語距離", "서술 거리"], shape: "text" },
    dialogueRegister: { aliases: ["dialogue register", "对话语域", "台詞語域", "대화 격식"], shape: "text" },
  },
};

interface MappingColumn {
  readonly id: string;
  readonly label: string;
  readonly mappable: boolean;
}

export interface SuggestMappingInput {
  readonly objectType: KnowledgeObjectType;
  readonly scope?: KnowledgeImportScope;
  readonly columns: readonly ImportColumnInput[];
  readonly sample?: readonly ImportRecordSource[];
  readonly format?: KnowledgeImportFormat;
  readonly selection?: Omit<ImportSelection, "objectType" | "scope">;
  readonly templateVersion?: string;
}

export interface MappingIdentityOptions {
  readonly templateVersion?: string;
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function compactHeader(value: string): string {
  return normalizeHeader(value).replace(/[\s_.:/\\()[\]{}-]+/gu, "");
}

function columnsOf(input: readonly ImportColumnInput[]): readonly MappingColumn[] {
  return input.map((column) => typeof column === "string"
    ? Object.freeze({
        id: column,
        label: column,
        mappable: column.trim().length > 0,
      })
    : Object.freeze({
        id: column.id,
        label: column.raw,
        mappable: column.mappable,
      }));
}

function sampleValues(
  samples: readonly ImportRecordSource[] | undefined,
  columnId: string,
): readonly unknown[] {
  if (samples === undefined) return [];
  return samples
    .map((sample) => sample.values[columnId])
    .filter((value) => value !== null && value !== undefined && value !== "");
}

function compatibleShape(shape: FieldDefinition["shape"], values: readonly unknown[]): number {
  if (values.length === 0 || shape === undefined) return 0;
  const matching = values.filter((value) => {
    if (shape === "list") return Array.isArray(value);
    if (shape === "boolean") {
      return typeof value === "boolean"
        || (typeof value === "string" && /^(?:true|false|yes|no|0|1|是|否)$/iu.test(value.trim()));
    }
    if (shape === "number") {
      return typeof value === "number"
        || (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value)));
    }
    return typeof value === "string";
  }).length;
  return matching / values.length >= 0.8 ? 2 : 0;
}

interface Candidate {
  readonly column: MappingColumn;
  readonly score: number;
  readonly reasons: readonly string[];
}

function scoreColumn(
  column: MappingColumn,
  definition: FieldDefinition,
  samples: readonly ImportRecordSource[] | undefined,
): Candidate {
  const header = normalizeHeader(column.label);
  const compact = compactHeader(column.label);
  const strongExact = definition.aliases.some((alias) => normalizeHeader(alias) === header);
  const weakExact = definition.weakAliases?.some((alias) => normalizeHeader(alias) === header) ?? false;
  const normalizedMatch = !strongExact && !weakExact
    && [...definition.aliases, ...(definition.weakAliases ?? [])]
      .some((alias) => compactHeader(alias) === compact);
  const values = sampleValues(samples, column.id);
  const reasons: string[] = [];
  let score = 0;
  if (strongExact) {
    score += 6;
    reasons.push("exact alias match");
  } else if (weakExact) {
    score += 4;
    reasons.push("ambiguous alias match");
  } else if (normalizedMatch) {
    score += 4;
    reasons.push("normalized alias match");
  }
  const shapeScore = compatibleShape(definition.shape, values);
  if (shapeScore > 0) {
    score += shapeScore;
    reasons.push("sample values have a compatible type");
  }
  if (values.length > 0) {
    const emptyRate = 1 - values.length / (samples?.length ?? values.length);
    if (emptyRate >= 0.5) {
      score -= 2;
      reasons.push("many sample values are empty");
    }
  }
  return { column, score, reasons };
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return right.score - left.score
    || (left.column.id < right.column.id ? -1 : left.column.id > right.column.id ? 1 : 0);
}

function cleanSelection(selection: ImportSelection): Record<string, unknown> {
  const result: Record<string, unknown> = {
    objectType: selection.objectType,
    scope: selection.scope,
  };
  for (const key of ["recordPathId", "sheetId", "headerRow", "encoding"] as const) {
    const value = selection[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function cleanField(field: ImportFieldMapping): Record<string, unknown> {
  const result: Record<string, unknown> = {
    targetField: field.targetField,
    sourceColumn: field.sourceColumn,
    confidence: field.confidence,
    confirmed: field.confirmed,
  };
  if (field.separator !== undefined) result.separator = field.separator;
  if (field.nullMeansDelete !== undefined) result.nullMeansDelete = field.nullMeansDelete;
  return result;
}

export function mappingIdentity(
  format: KnowledgeImportFormat,
  selection: ImportSelection,
  fields: Readonly<Record<string, ImportFieldMapping | undefined>>,
  options: MappingIdentityOptions = {},
): string {
  const normalizedFields: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort(
    (left, right) => left < right ? -1 : left > right ? 1 : 0,
  )) {
    const field = fields[key];
    if (field !== undefined) normalizedFields[key] = cleanField(field);
  }
  return createHash("sha256").update(canonicalJson({
    format,
    selection: cleanSelection(selection),
    fields: normalizedFields,
    templateVersion: options.templateVersion ?? OFFICIAL_KNOWLEDGE_IMPORT_SCHEMA,
  })).digest("hex");
}

export function suggestMapping(input: SuggestMappingInput): MappingSuggestion {
  const selection: ImportSelection = {
    ...input.selection,
    objectType: input.objectType,
    scope: input.scope ?? "book",
  };
  const columns = columnsOf(input.columns).filter((column) => column.mappable);
  const fields: Record<string, ImportFieldMapping | undefined> = {};
  const reasons: Record<string, readonly string[]> = {};
  for (const [targetField, definition] of Object.entries(
    FIELD_DEFINITIONS[input.objectType],
  )) {
    const candidates = columns
      .map((column) => scoreColumn(column, definition, input.sample))
      .filter((candidate) => candidate.score > 0)
      .sort(compareCandidate);
    const best = candidates[0];
    if (best === undefined || best.score < 4) continue;
    const runnerUp = candidates[1];
    const lead = best.score - (runnerUp?.score ?? 0);
    const uniqueLeader = runnerUp === undefined || lead >= 2;
    const confidence = best.score >= 6 && uniqueLeader ? "high" : "medium";
    const fieldReasons = [...best.reasons];
    if (!uniqueLeader) {
      fieldReasons.push("ambiguous collision with another source column");
    } else {
      fieldReasons.push(`unique leading candidate with score ${best.score}`);
    }
    fields[targetField] = Object.freeze({
      targetField,
      sourceColumn: best.column.id,
      confidence,
      confirmed: confidence === "high",
    });
    reasons[targetField] = Object.freeze(fieldReasons);
  }
  return Object.freeze({
    selection: Object.freeze(selection),
    fields: Object.freeze(fields),
    reasons: Object.freeze(reasons),
    mappingHash: mappingIdentity(
      input.format ?? "json",
      selection,
      fields,
      { templateVersion: input.templateVersion },
    ),
  });
}

export function knowledgeImportFields(
  objectType: KnowledgeObjectType,
): readonly string[] {
  return Object.freeze(Object.keys(FIELD_DEFINITIONS[objectType]));
}
