# FolioLoom 多格式知识导入向导实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 在知识工作台核心完成后，交付 JSON、YAML、CSV、XLSX 的安全导入、字段映射、预览校验、冲突处理、幂等提交和整批撤销。

**架构：** 主进程把外部文件解析成有界的中间表，确定性映射器只给建议，用户确认后的 `KnowledgeImportService` 才把规范记录写入 schema v3 staging。提交阶段复用 `commitKnowledgeCommands`，在同一项目事务内创建知识修订、快照、generation、导入报告和行状态；渲染进程只持有 opaque batch ID，不接触路径、文件内容或数据库。

**技术栈：** TypeScript 7、Node streams、`yaml` 2.9.0、`csv-parse` 7.0.1、`exceljs` 4.4.0、Electron 43、React 19、Vitest/Testing Library、Node test runner

**前置计划：** `docs/superpowers/plans/2026-07-23-knowledge-workbench-core.md`

**前置设计：** `docs/superpowers/specs/2026-07-23-knowledge-workbench-and-import-design.md`

**命令目录：** 所有 `npm`/`npx` 命令在 `translator-v5` 目录运行；所有 `git add`/`git commit` 命令在仓库 worktree 根目录运行。

---

## 文件结构

### 新建

- `translator-v5/src/knowledge-import/types.ts`：文件描述、记录样例、映射、诊断、冲突和报告类型。
- `translator-v5/src/knowledge-import/input-policy.ts`：扩展名、大小、编码、深度、行数、单元格和公式安全边界。
- `translator-v5/src/knowledge-import/json-yaml-reader.ts`：有界 JSON/YAML 结构发现和记录路径读取。
- `translator-v5/src/knowledge-import/csv-reader.ts`：流式 CSV 预览与记录读取。
- `translator-v5/src/knowledge-import/xlsx-reader.ts`：工作表/标题行发现和只读单元格提取。
- `translator-v5/src/knowledge-import/mapping-suggester.ts`：字段名、类型、唯一性和样例驱动的确定性映射建议。
- `translator-v5/src/knowledge-import/official-template.ts`：FolioLoom 模板识别、版本和直接映射。
- `translator-v5/src/knowledge-import/record-normalizer.ts`：映射外部行到六类严格知识命令。
- `translator-v5/src/knowledge-import/conflict-classifier.ts`：新增、安全合并、冲突和无效分类。
- `translator-v5/src/knowledge-import/knowledge-import-service.ts`：inspect、stage、decide、commit、rollback 编排。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeImportWizard.tsx`：四步导入向导。
- `translator-v5/src/desktop/renderer/src/components/ImportMappingStep.tsx`：记录路径、工作表、标题行和字段映射。
- `translator-v5/src/desktop/renderer/src/components/ImportConflictStep.tsx`：预览、错误和冲突决策。
- `translator-v5/config/knowledge-import-template.json`：JSON 官方模板。
- `translator-v5/config/knowledge-import-template.yaml`：YAML 官方模板。
- `translator-v5/config/knowledge-import-template.csv`：CSV 官方模板。
- `translator-v5/config/knowledge-import-template.xlsx`：由受测生成器产出的 XLSX 官方模板。
- `translator-v5/test/knowledge-import-input-policy.test.ts`
- `translator-v5/test/knowledge-import-json-yaml.test.ts`
- `translator-v5/test/knowledge-import-csv-xlsx.test.ts`
- `translator-v5/test/knowledge-import-mapping.test.ts`
- `translator-v5/test/knowledge-import-conflicts.test.ts`
- `translator-v5/test/knowledge-import-service.test.ts`
- `translator-v5/src/desktop/renderer/src/components/KnowledgeImportWizard.test.tsx`
- `translator-v5/test/fixtures/knowledge-import/terms.json`
- `translator-v5/test/fixtures/knowledge-import/terms.yaml`
- `translator-v5/test/fixtures/knowledge-import/terms.csv`

### 修改

- `translator-v5/package.json`：加入固定版本 `csv-parse` 和 `exceljs`。
- `translator-v5/package-lock.json`：锁定依赖。
- `translator-v5/src/storage/lossless-book-store.ts`：staging、决策、原子提交、批次撤销和幂等读取。
- `translator-v5/src/knowledge/knowledge-commands.ts`：接受导入来源、批次 ID 和整批 rollback。
- `translator-v5/src/desktop/knowledge-contracts.ts`：导入 inspect/stage/decision/commit/rollback 合约。
- `translator-v5/src/desktop/desktop-knowledge-service.ts`：持有短时 pending 文件并调用导入服务。
- `translator-v5/src/desktop/main/ipc.ts`：文件选择与导入通道。
- `translator-v5/src/desktop/preload/index.ts`：有限导入 API。
- `translator-v5/src/desktop/preload/folioloom-api.d.ts`：导入 API 类型。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx`：打开向导并在提交后刷新代数。
- `translator-v5/src/desktop/renderer/src/styles.css`：映射表、预览、冲突和步骤条。
- `translator-v5/test/desktop-ipc.test.ts`：导入通道和载荷边界。
- `translator-v5/test/desktop-main-security.test.ts`：路径、公式、宏和 SQL 隔离。
- `translator-v5/README.md`：导入方法、模板和冲突说明。

## 任务 1：安装解析依赖并建立输入安全策略

**文件：**

- 修改：`translator-v5/package.json`
- 修改：`translator-v5/package-lock.json`
- 创建：`translator-v5/src/knowledge-import/types.ts`
- 创建：`translator-v5/src/knowledge-import/input-policy.ts`
- 测试：`translator-v5/test/knowledge-import-input-policy.test.ts`

- [x] **步骤 1：编写扩展名、大小和结构边界失败测试**

```ts
test("accepts only the four knowledge import formats", () => {
  assert.equal(inspectImportPath("terms.json").format, "json");
  assert.equal(inspectImportPath("terms.yaml").format, "yaml");
  assert.equal(inspectImportPath("terms.csv").format, "csv");
  assert.equal(inspectImportPath("terms.xlsx").format, "xlsx");
  assert.throws(() => inspectImportPath("terms.xlsm"), /KNOWLEDGE_IMPORT_FORMAT_UNSUPPORTED/u);
});

test("rejects oversized, deeply nested and over-wide inputs before staging", () => {
  assert.throws(() => enforceImportFileSize(MAX_IMPORT_BYTES + 1), /KNOWLEDGE_IMPORT_TOO_LARGE/u);
  assert.throws(() => inspectJsonShape(deepObject(65)), /KNOWLEDGE_IMPORT_NESTING_LIMIT/u);
  assert.throws(() => validateColumnCount(257), /KNOWLEDGE_IMPORT_COLUMN_LIMIT/u);
  assert.throws(() => validateXlsxArchive({ entries: 10_001, uncompressedBytes: 1 }), /XLSX_ENTRY_LIMIT/u);
  assert.throws(
    () => validateXlsxArchive({ entries: 1, uncompressedBytes: 256 * 1024 * 1024 + 1 }),
    /XLSX_EXPANSION_LIMIT/u,
  );
  assert.throws(
    () => validateXlsxEntry({ compressedBytes: 1, uncompressedBytes: 101 }),
    /XLSX_ENTRY_RATIO_LIMIT/u,
  );
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-import-input-policy.test.ts
```

预期：FAIL，模块不存在。

- [x] **步骤 3：安装固定依赖**

运行：

```powershell
npm install csv-parse@7.0.1 exceljs@4.4.0
```

确认 `package.json` 的 dependencies 精确记录两个版本，`npm audit --omit=dev` 不得出现 high/critical；若出现则停止实施并记录依赖风险，不使用 `--force` 绕过。

- [x] **步骤 4：定义有界输入策略**

`input-policy.ts` 固定：

```ts
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_COLUMNS = 256;
export const MAX_IMPORT_CELL_SCALARS = 8_192;
export const MAX_IMPORT_NESTING = 64;
export const IMPORT_SAMPLE_ROWS = 50;
export const MAX_XLSX_ENTRIES = 10_000;
export const MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_XLSX_ENTRY_RATIO = 100;
```

只接受 `.json`、`.yaml`、`.yml`、`.csv`、`.xlsx`。路径必须来自 Electron 文件选择器产生的 pending import，不允许 renderer 传入。所有错误使用稳定码并带行/列/路径定位。

- [x] **步骤 5：定义跨解析器类型**

在 `types.ts` 定义：

```ts
import type {
  JsonValue,
  KnowledgeScope,
} from "../knowledge/knowledge-authority.js";
import type { KnowledgeObjectType } from "../knowledge/knowledge-commands.js";

export type KnowledgeImportFormat = "json" | "yaml" | "csv" | "xlsx";
export type ImportOperationId = string;
export type KnowledgeImportScope = Extract<KnowledgeScope, "book" | "project">;
export type ImportTextEncoding =
  | "utf-8" | "utf-16le" | "utf-16be"
  | "shift_jis" | "euc-jp" | "euc-kr" | "windows-949";

export interface PendingKnowledgeImport {
  readonly pendingImportId: string;
  readonly fileName: string;
  readonly format: KnowledgeImportFormat;
}

export interface InspectImportRequest {
  readonly pendingImportId: string;
  readonly operationId: ImportOperationId;
}

export interface ConfirmImportEncodingRequest extends InspectImportRequest {
  readonly encoding: ImportTextEncoding;
}

export interface ImportRecordPath {
  readonly id: string;
  readonly label: string;
  readonly shape: "records" | "key_value";
}

export interface ImportSheet {
  readonly id: string;
  readonly name: string;
  readonly suggestedHeaderRows: readonly number[];
}

export interface ImportRecordSource {
  readonly ordinal: number;
  readonly location: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export interface ImportInspection {
  readonly pendingImportId: string;
  readonly fileName: string;
  readonly format: KnowledgeImportFormat;
  readonly recordPaths: readonly ImportRecordPath[];
  readonly sheets: readonly ImportSheet[];
  readonly sample: readonly ImportRecordSource[];
}

export type ImportInspectionResult =
  | { readonly status: "ready"; readonly inspection: ImportInspection }
  | {
      readonly status: "encoding_required";
      readonly pendingImportId: string;
      readonly fileName: string;
      readonly encodings: readonly ImportTextEncoding[];
      readonly previews: readonly {
        readonly encoding: ImportTextEncoding;
        readonly text: string;
      }[];
    };

export interface ImportSelection {
  readonly recordPathId?: string;
  readonly sheetId?: string;
  readonly headerRow?: number;
  readonly encoding?: ImportTextEncoding;
  readonly objectType: KnowledgeObjectType;
  readonly scope: KnowledgeImportScope;
}

export interface ImportFieldMapping {
  readonly targetField: string;
  readonly sourceColumn: string;
  readonly confidence: "high" | "medium" | "low";
  readonly confirmed: boolean;
  readonly separator?: string;
  readonly nullMeansDelete?: boolean;
}

export interface MappingSuggestion {
  readonly selection: ImportSelection;
  readonly fields: Readonly<Record<string, ImportFieldMapping | undefined>>;
  readonly reasons: Readonly<Record<string, readonly string[]>>;
  readonly mappingHash: string;
}

export interface ImportDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly location: string;
  readonly field?: string;
}

export interface StageImportRequest {
  readonly pendingImportId: string;
  readonly operationId: ImportOperationId;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly selection: ImportSelection;
  readonly fields: Readonly<Record<string, ImportFieldMapping | undefined>>;
}

export interface ImportCountSummary {
  readonly ready: number;
  readonly merge: number;
  readonly conflict: number;
  readonly invalid: number;
  readonly skipped: number;
}

export type ImportConflictDecision =
  | { readonly action: "keep_existing" }
  | { readonly action: "use_imported" }
  | { readonly action: "merge_as_alias" }
  | { readonly action: "create_separate"; readonly normalizedSubject: string }
  | { readonly action: "skip" };

export interface ImportPreviewRow {
  readonly ordinal: number;
  readonly location: string;
  readonly state: "ready" | "merge" | "conflict" | "invalid" | "skipped";
  readonly displayFields: Readonly<Record<string, JsonValue>>;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly allowedDecisions: readonly ImportConflictDecision["action"][];
}

export interface StagedImportReport {
  readonly batchId: string;
  readonly counts: ImportCountSummary;
  readonly unresolved: number;
  readonly rows: readonly ImportPreviewRow[];
  readonly nextCursor?: string;
}

export interface StagedImportSummary {
  readonly batchId: string;
  readonly sourceName: string;
  readonly sourceFormat: KnowledgeImportFormat;
  readonly counts: ImportCountSummary;
  readonly unresolved: number;
  readonly createdAt: string;
}

export interface CommittedImportReport {
  readonly batchId: string;
  readonly added: number;
  readonly updated: number;
  readonly merged: number;
  readonly skipped: number;
  readonly invalid: number;
  readonly committed: number;
  readonly generation: number;
  readonly snapshotId: string;
}

export interface RolledBackImportReport {
  readonly batchId: string;
  readonly rolledBack: number;
  readonly generation: number;
  readonly snapshotId: string;
}

export interface ImportDecisionRequest {
  readonly batchId: string;
  readonly decisions: readonly {
    readonly rowOrdinal: number;
    readonly decision: ImportConflictDecision;
  }[];
}

export interface StagedImportPageRequest {
  readonly batchId: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CommitImportRequest {
  readonly batchId: string;
  readonly operationId: ImportOperationId;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface RollbackImportRequest {
  readonly batchId: string;
  readonly operationId: ImportOperationId;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface DiscardStagedImportRequest {
  readonly batchId: string;
}

export interface CancelImportOperationRequest {
  readonly operationId: ImportOperationId;
}
```

`ImportInspection` 不含绝对路径和完整文件内容。

- [x] **步骤 6：运行策略测试和类型检查**

运行：

```powershell
node --test --import tsx test/knowledge-import-input-policy.test.ts
npm run typecheck
```

预期：PASS。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/package.json translator-v5/package-lock.json translator-v5/src/knowledge-import/types.ts translator-v5/src/knowledge-import/input-policy.ts translator-v5/test/knowledge-import-input-policy.test.ts
git commit -m "feat: define safe knowledge import inputs"
```

## 任务 2：实现 JSON/YAML 结构发现和官方模板

**文件：**

- 创建：`translator-v5/src/knowledge-import/json-yaml-reader.ts`
- 创建：`translator-v5/src/knowledge-import/official-template.ts`
- 创建：`translator-v5/config/knowledge-import-template.json`
- 创建：`translator-v5/config/knowledge-import-template.yaml`
- 测试：`translator-v5/test/knowledge-import-json-yaml.test.ts`
- 测试：`translator-v5/test/fixtures/knowledge-import/terms.json`
- 测试：`translator-v5/test/fixtures/knowledge-import/terms.yaml`

- [x] **步骤 1：编写四种结构和危险键失败测试**

```ts
test("discovers root arrays, nested arrays and key-value glossaries", async () => {
  assert.deepEqual((await inspectJson(rootArray())).recordPaths.map((item) => item.path), ["$"]);
  assert.deepEqual((await inspectJson({ data: { terms: rootArray() } })).recordPaths[0]?.path, "$.data.terms");
  assert.equal((await inspectJson({ Archon: "执政官" })).recordPaths[0]?.shape, "key_value");
});

test("rejects prototype keys and YAML aliases that exceed expansion limits", async () => {
  await assert.rejects(() => inspectJsonText('{"__proto__":{"polluted":true}}'), /FORBIDDEN_KEY/u);
  await assert.rejects(() => inspectYamlText(aliasBomb()), /YAML_ALIAS_LIMIT/u);
});

test("requires the dedicated library flow for a template declaring global scope", async () => {
  await assert.rejects(
    () => inspectJson(globalTermTemplate()),
    /GLOBAL_IMPORT_REQUIRES_LIBRARY_CONFIRMATION/u,
  );
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-import-json-yaml.test.ts
```

预期：FAIL，读取器不存在。

- [x] **步骤 3：实现有界解析和记录路径**

JSON 和 YAML 都先校验文件大小。JSON 使用 YAML 库的严格 JSON schema 解析，以保留重复键错误；YAML 使用 core schema：

```ts
parseDocument(jsonText, {
  schema: "json",
  maxAliasCount: 0,
  prettyErrors: false,
  uniqueKeys: true,
});

parseDocument(text, {
  schema: "core",
  maxAliasCount: 20,
  prettyErrors: false,
  uniqueKeys: true,
});
```

将文档转成纯 JSON 时再次拒绝 `__proto__`、`prototype`、`constructor`、非字符串键、日期/二进制/自定义 tag。

记录路径仅由读取器生成 opaque ID；renderer 选择 ID，不传自写 JSONPath。

- [x] **步骤 4：建立官方模板版本**

模板根结构固定：

```json
{
  "schema": "folioloom-knowledge-import-1",
  "objectType": "term",
  "scope": "book",
  "records": [
    {
      "source": "Archon",
      "target": "执政官",
      "policy": "preferred",
      "forms": ["archon"],
      "note": "职位称呼"
    }
  ]
}
```

YAML 使用同一字段。`official-template.ts` 只接受精确 schema 和已知 root keys，成功时返回直接映射；未知版本不猜测。导入向导的目标作用域只允许 `book/project`；文件声明 `global` 时返回 `GLOBAL_IMPORT_REQUIRES_LIBRARY_CONFIRMATION`，提示先导入当前书或项目，再通过核心计划任务 6 的全局库流程显式提升 term/style，避免普通导入绕过跨库审计。

- [x] **步骤 5：运行 JSON/YAML 与旧 glossary 回归**

运行：

```powershell
node --test --import tsx test/knowledge-import-json-yaml.test.ts test/glossary-profile.test.ts
```

预期：PASS；旧 glossary 解析行为不变。

- [x] **步骤 6：Commit**

```powershell
git add translator-v5/src/knowledge-import/json-yaml-reader.ts translator-v5/src/knowledge-import/official-template.ts translator-v5/config/knowledge-import-template.json translator-v5/config/knowledge-import-template.yaml translator-v5/test/knowledge-import-json-yaml.test.ts translator-v5/test/fixtures/knowledge-import/terms.json translator-v5/test/fixtures/knowledge-import/terms.yaml
git commit -m "feat: inspect JSON and YAML knowledge files"
```

## 任务 3：实现 CSV/XLSX 安全读取

**文件：**

- 创建：`translator-v5/src/knowledge-import/csv-reader.ts`
- 创建：`translator-v5/src/knowledge-import/xlsx-reader.ts`
- 修改：`translator-v5/src/knowledge-import/official-template.ts`
- 创建：`translator-v5/config/knowledge-import-template.csv`
- 创建：`translator-v5/config/knowledge-import-template.xlsx`
- 创建：`translator-v5/test/knowledge-import-csv-xlsx.test.ts`
- 创建：`translator-v5/test/fixtures/knowledge-import/terms.csv`

- [x] **步骤 1：编写编码、标题行、多工作表和公式失败测试**

```ts
test("streams UTF-8 BOM CSV and preserves source row numbers", async () => {
  const inspection = await inspectCsv(fixture("terms.csv"));
  assert.deepEqual(inspection.columns, ["source", "target", "policy"]);
  assert.equal(inspection.sample[0]?.location, "row 2");
});

test("lists XLSX sheets and never evaluates formulas", async () => {
  const workbook = await formulaWorkbook();
  const inspection = await inspectXlsx(workbook);
  assert.deepEqual(inspection.sheets.map((sheet) => sheet.name), ["Terms", "People"]);
  await assert.rejects(
    () => readXlsxRecords(workbook, { sheetId: inspection.sheets[0]!.id, headerRow: 1 }),
    /KNOWLEDGE_IMPORT_FORMULA_FORBIDDEN/u,
  );
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-import-csv-xlsx.test.ts
```

预期：FAIL，CSV/XLSX 读取器不存在。

- [x] **步骤 3：实现 CSV 流式读取**

使用 `createReadStream` 和 `csv-parse`：

```ts
parse({
  bom: true,
  columns: false,
  relax_column_count: false,
  skip_empty_lines: true,
  max_record_size: MAX_IMPORT_CELL_SCALARS * MAX_IMPORT_COLUMNS,
});
```

编码只自动接受严格 UTF-8/UTF-8 BOM。非 UTF-8 返回 `status="encoding_required"` 和限定候选 `utf-16le/utf-16be/shift_jis/euc-jp/euc-kr/windows-949`，经用户确认后用 `new TextDecoder(encoding, { fatal: true })` 从原始字节重新严格解码；不用系统区域设置静默猜测，也不以替换字符吞掉乱码。标题行默认第一行，用户可在前 20 行中选择。

- [x] **步骤 4：实现 XLSX 只读提取**

读取前先用现有 `yauzl` 检查 ZIP entries，累计 entry 数、声明的 uncompressed bytes 和每个 entry 的压缩比，按任务 1 的三个上限拒绝 ZIP bomb；同时拒绝 `xl/vbaProject.bin`、`xl/externalLinks/`、`xl/embeddings/`、任何 `.rels` 外部 Target 和任何路径穿越 entry。随后使用 `ExcelJS.stream.xlsx.WorkbookReader`：inspect 首次流式遍历时只为每个工作表保留前 20 个候选标题行和最多 50 条样例；stage 重新打开文件，只流式规范化用户选中的工作表，不把整本 workbook 留在内存。读取内容仅包括：

- 工作表名称和可见性；
- 用户选择的标题行；
- primitive string/number/boolean/null 单元格。

遇到 formula、rich text、hyperlink、error、shared formula 或外部链接时，该单元格产生定位明确的 invalid diagnostic；不执行宏，不接受 `.xlsm`。

在 `official-template.ts` 实现：

```ts
export async function writeOfficialXlsxTemplate(outputPath: string): Promise<void>;
```

用该受测函数创建 `config/knowledge-import-template.xlsx`，内容与 JSON/YAML/CSV 官方模板相同；测试重新读取生成文件并断言字段和值。

- [x] **步骤 5：统一表格列名**

空标题生成不可映射诊断；重复标题显示为 `name [2]` 的 UI 标签，但内部使用稳定 column index，不改写原值。单元格字符串执行 NFKC 和首尾空白清理，正文内部空白不折叠。

```ts
export function normalizeHeaders(values: readonly unknown[]): readonly ImportColumn[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const raw = typeof value === "string" ? value.normalize("NFKC").trim() : "";
    const occurrence = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, occurrence);
    return {
      id: `column:${index}`,
      sourceIndex: index,
      raw,
      label: raw.length === 0 ? `未命名列 ${index + 1}` : occurrence === 1 ? raw : `${raw} [${occurrence}]`,
      mappable: raw.length > 0,
    };
  });
}
```

- [x] **步骤 6：运行解析和依赖安全测试**

运行：

```powershell
node --test --import tsx test/knowledge-import-csv-xlsx.test.ts test/knowledge-import-input-policy.test.ts
npm audit --omit=dev
```

预期：测试 PASS，audit 无 high/critical。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge-import/csv-reader.ts translator-v5/src/knowledge-import/xlsx-reader.ts translator-v5/src/knowledge-import/official-template.ts translator-v5/config/knowledge-import-template.csv translator-v5/config/knowledge-import-template.xlsx translator-v5/test/knowledge-import-csv-xlsx.test.ts translator-v5/test/fixtures/knowledge-import/terms.csv
git commit -m "feat: read CSV and XLSX knowledge files"
```

## 任务 4：实现确定性字段映射和记录规范化

**文件：**

- 创建：`translator-v5/src/knowledge-import/mapping-suggester.ts`
- 创建：`translator-v5/src/knowledge-import/record-normalizer.ts`
- 测试：`translator-v5/test/knowledge-import-mapping.test.ts`

- [x] **步骤 1：编写高、中、低置信与多语言表头失败测试**

```ts
test("suggests source and target without auto-accepting an ambiguous note column", () => {
  const result = suggestMapping({
    objectType: "term",
    columns: sampleColumns(["原文", "译名", "说明"]),
  });
  assert.deepEqual(result.fields.source, {
    targetField: "source",
    sourceColumn: "原文",
    confidence: "high",
    confirmed: true,
  });
  assert.deepEqual(result.fields.target, {
    targetField: "target",
    sourceColumn: "译名",
    confidence: "high",
    confirmed: true,
  });
  assert.equal(result.fields.note?.confidence, "medium");
});

test("leaves low-confidence fields unmapped", () => {
  const result = suggestMapping({
    objectType: "entity",
    columns: sampleColumns(["A", "B", "C"]),
  });
  assert.equal(result.fields.canonicalName, undefined);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-import-mapping.test.ts
```

预期：FAIL，映射器和规范器不存在。

- [x] **步骤 3：实现可解释映射评分**

每个目标字段计算：

```text
score =
  exactAlias * 6
  + normalizedAlias * 4
  + compatibleType * 2
  + uniquenessFit
  + sampleShapeFit
  - emptyRatePenalty
  - collisionPenalty
```

字段别名表覆盖英文和常见中文（如 source/原文/原词、target/译文/译名、alias/别名、note/备注），但不含小说专有名词。高置信须有唯一领先候选且超过固定阈值；中置信只提示；低置信不映射。返回 `reasons` 供 UI 显示。

- [x] **步骤 4：规范化为知识命令**

`normalizeImportRecord` 接收用户确认映射，输出：

```ts
export interface NormalizedImportRecord {
  readonly ordinal: number;
  readonly location: string;
  readonly command: UpdateKnowledgeCommand;
  readonly canonicalHash: string;
  readonly diagnostics: readonly ImportDiagnostic[];
}
```

六种 objectType 分别调用 `validateKnowledgeCommand`。数组字段支持真实数组或用户明确指定的分隔符；默认不凭逗号拆人名/备注。空字符串不等于删除，只有显式 `nullMeansDelete` 映射选项才能形成 tombstone。

- [x] **步骤 5：加入映射身份**

映射 canonical JSON 包含格式、记录路径/工作表/标题行、objectType、scope、字段映射和分隔规则，计算 `mappingHash`。它与文件 hash 一起构成幂等批次身份。

```ts
export function mappingIdentity(
  format: KnowledgeImportFormat,
  selection: ImportSelection,
  fields: Readonly<Record<string, ImportFieldMapping | undefined>>,
): string {
  return createHash("sha256").update(canonicalJson({
    format,
    selection,
    fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
  })).digest("hex");
}
```

- [x] **步骤 6：运行映射和命令校验测试**

运行：

```powershell
node --test --import tsx test/knowledge-import-mapping.test.ts test/knowledge-commands.test.ts
```

预期：PASS；低置信字段不会自动进入命令。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge-import/mapping-suggester.ts translator-v5/src/knowledge-import/record-normalizer.ts translator-v5/test/knowledge-import-mapping.test.ts
git commit -m "feat: map external fields to knowledge objects"
```

## 任务 5：实现冲突分类、staging 与 dry-run

**文件：**

- 创建：`translator-v5/src/knowledge-import/conflict-classifier.ts`
- 创建：`translator-v5/src/knowledge-import/knowledge-import-service.ts`
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 测试：`translator-v5/test/knowledge-import-conflicts.test.ts`
- 测试：`translator-v5/test/knowledge-import-service.test.ts`

- [x] **步骤 1：编写五种分类和无部分 staging 失败测试**

```ts
test("classifies add, safe merge, conflict and invalid deterministically", () => {
  assert.equal(classify(emptyStore(), term("Archon", "执政官")).state, "ready");
  assert.equal(classify(storeWith(term("Archon", "执政官")), term("archon", "执政官")).state, "merge");
  assert.equal(classify(storeWith(term("Archon", "执政官")), term("Archon", "阁下")).state, "conflict");
  assert.equal(classify(emptyStore(), invalidRelation()).state, "invalid");
});

test("rolls back the entire staging batch after one database fault", async () => {
  const fixture = importFixture({ failAt: "knowledge_import_stage_before_commit" });
  await assert.rejects(() => fixture.stage(validMapping()), /injected/u);
  assert.equal(fixture.batchCount(), 0);
  assert.equal(fixture.rowCount(), 0);
});

test("discards only staged rows without changing knowledge generation", async () => {
  const fixture = importFixture();
  const staged = await fixture.stage(validMapping());
  const before = fixture.generation();
  await fixture.discardStaged({ batchId: staged.batchId });
  assert.equal(fixture.batch(staged.batchId).status, "discarded");
  assert.equal(fixture.stagedRowCount(staged.batchId), 0);
  assert.equal(fixture.generation(), before);
});

test("cancels a long stage at a checkpoint without leaving partial rows", async () => {
  const fixture = importFixture({ pauseEveryRows: 256 });
  const operationId = randomUUID();
  const staging = fixture.stage({ ...validMapping(), operationId });
  await fixture.waitForCheckpoint(operationId);
  fixture.cancelOperation({ operationId });
  await assert.rejects(() => staging, /KNOWLEDGE_IMPORT_CANCELLED/u);
  assert.equal(fixture.batchCount(), 0);
  assert.equal(fixture.rowCount(), 0);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-import-conflicts.test.ts test/knowledge-import-service.test.ts
```

预期：FAIL，分类器和服务不存在。

- [x] **步骤 3：实现确定性冲突分类**

分类规则：

- `ready`：规范 subject/kind 不存在；
- `merge`：目标值相同，只增加别名、证据或非互斥字段；
- `conflict`：同一优先级的 owned 字段出现不同值，或实体身份无法确定；
- `invalid`：模式错误、悬空关系端点、缺少记忆生效位置等；
- `skipped`：用户明确跳过。

字符串相似度只能给“可能同一对象”的提示，不能自动 merge 实体。

```ts
export function classifyImport(
  existing: KnowledgeListItem | undefined,
  incoming: NormalizedImportRecord,
): ImportClassification {
  if (incoming.diagnostics.length > 0) return invalid(incoming.diagnostics);
  if (!existing) return ready();
  if (hasSameOwnedValues(existing, incoming.command)) return merge();
  return conflict({
    code: "KNOWLEDGE_IMPORT_OWNED_FIELD_CONFLICT",
    allowedDecisions: decisionsFor(incoming.command.objectType),
  });
}
```

- [x] **步骤 4：实现 inspect 与 stage 生命周期**

`KnowledgeImportService`：

```ts
inspect(input: InspectImportRequest): Promise<ImportInspectionResult>;
confirmEncoding(input: ConfirmImportEncodingRequest): Promise<ImportInspectionResult>;
suggestMapping(pendingImportId: string, selection: ImportSelection): Promise<MappingSuggestion>;
listStaged(): Promise<readonly StagedImportSummary[]>;
getStaged(batchId: string, cursor?: string, limit?: number): Promise<StagedImportReport>;
stage(input: StageImportRequest): Promise<StagedImportReport>;
setDecisions(input: ImportDecisionRequest): Promise<StagedImportReport>;
discardStaged(input: DiscardStagedImportRequest): Promise<void>;
commit(input: CommitImportRequest): Promise<CommittedImportReport>;
rollback(input: RollbackImportRequest): Promise<RolledBackImportReport>;
cancelOperation(input: CancelImportOperationRequest): void;
```

pendingImportId 只在主进程内映射绝对路径，15 分钟过期，最多 4 个；新进程启动后旧 ID 全部失效。

`operationId` 由 renderer 为每次 inspect/stage/commit/rollback 生成 UUID；主进程严格校验 UUID、拒绝仍 active 的重复 ID，并在 active operation map 中绑定对应的 `AbortController`。解析循环每 256 行、规范化循环每 256 行检查 signal；提交/撤销在打开事务前以及每条命令之间检查，取消异常必须让当前事务完整回滚。操作已经结束时取消为幂等 no-op，不把成功批次改成失败。

stage 对完整文件解析、规范化和分类，在一个数据库事务中写 batch/rows。完整外部值只留在项目数据库 staging，不返回 renderer；UI 每页最多接收 100 条选定字段、短样例和诊断，并通过 opaque cursor 加载后续页。

`source_name` 只保存文件 basename；绝对路径只存在于短时 pending map，既不写项目数据库，也不进入报告或日志。

`discardStaged` 只接受状态仍为 staged 的 batch：在一个事务中把 batch 标为 `discarded`，将聚合计数写入 report 后删除对应 staging rows。它不改变知识 generation/snapshot；committed/rolled_back batch 不能走此入口。

- [x] **步骤 5：实现决策约束**

使用 `types.ts` 中已经定义的冲突决策枚举：

```ts
type ImportConflictDecision =
  | { action: "keep_existing" }
  | { action: "use_imported" }
  | { action: "merge_as_alias" }
  | { action: "create_separate"; normalizedSubject: string }
  | { action: "skip" };
```

`merge_as_alias` 只对 term/entity/alias 且通过引用校验时开放；`create_separate` 必须给出新的规范 subject。批量应用要求 conflict signature 完全相同。

- [x] **步骤 6：运行 staging 和分类测试**

运行：

```powershell
node --test --import tsx test/knowledge-import-conflicts.test.ts test/knowledge-import-service.test.ts test/fault-injection.test.ts
```

预期：PASS；错误定位到输入行，故障不留下 batch/row。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge-import/conflict-classifier.ts translator-v5/src/knowledge-import/knowledge-import-service.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test/knowledge-import-conflicts.test.ts translator-v5/test/knowledge-import-service.test.ts
git commit -m "feat: stage and classify knowledge imports"
```

## 任务 6：实现幂等原子提交和整批撤销

**文件：**

- 修改：`translator-v5/src/knowledge-import/knowledge-import-service.ts`
- 修改：`translator-v5/src/knowledge/knowledge-commands.ts`
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 测试：`translator-v5/test/knowledge-import-service.test.ts`
- 测试：`translator-v5/test/fault-injection.test.ts`

- [x] **步骤 1：编写 unresolved、重复提交、故障和撤销失败测试**

```ts
test("refuses commit while any conflict has no explicit decision", async () => {
  const batch = await fixture.stage(conflictingFile());
  await assert.rejects(() => fixture.commit(batch.batchId), /IMPORT_CONFLICTS_UNRESOLVED/u);
  assert.equal(fixture.generation(), 0);
});

test("retries the same committed batch idempotently", async () => {
  const batch = await fixture.stage(validFile());
  const first = await fixture.commit(batch.batchId);
  const second = await fixture.commit(batch.batchId);
  assert.deepEqual(second, first);
  assert.equal(fixture.revisionCount(), first.committed);
});

test("rolls back every import revision by appending rollback revisions", async () => {
  const batch = await fixture.stage(validFile());
  await fixture.commit(batch.batchId);
  const before = fixture.historyCount();
  await fixture.rollback(batch.batchId);
  assert.ok(fixture.historyCount() > before);
  assert.equal(fixture.activeImportedCount(batch.batchId), 0);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-import-service.test.ts test/fault-injection.test.ts
```

预期：FAIL，commit/rollback 尚未完整实现。

- [x] **步骤 3：原子提交整个批次**

在一个 `BEGIN IMMEDIATE` 中：

1. 验证 batch 为 staged；
2. 验证 expected generation/snapshot；
3. 确认没有 unresolved/invalid 行（invalid 必须显式 skip）；
4. 将决策转换为 `origin="import"`、带 batchId 的 commands；
5. 调用与人工编辑相同的内部事务函数，不嵌套事务；
6. 只创建一个新 knowledge snapshot 和一个 generation；
7. 更新所有提交行与 batch report；
8. 写 `knowledge_import_committed` event；
9. 故障点 `knowledge_import_before_commit`；
10. COMMIT。

报告固定包含：

```ts
{
  added,
  updated,
  merged,
  skipped,
  invalid,
  committed,
  generation,
  snapshotId,
}
```

- [x] **步骤 4：保证幂等**

`run_id + source_hash + mapping_hash` 唯一，`mapping_json` 保存生成该哈希的 canonical 内容供审计。重复 inspect/stage 返回现有 batch 摘要；重复 commit 返回已保存 report。相同 batchId 但 payload identity 不一致报 `KNOWLEDGE_IMPORT_IDENTITY_CONFLICT`。

```ts
const existing = store.findImportBatch(runId, sourceHash, canonicalMappingJson);
if (existing?.status === "committed") {
  return parseCommittedReport(existing.reportJson);
}
if (existing && existing.mappingHash !== mappingHash) {
  throw new Error("KNOWLEDGE_IMPORT_IDENTITY_CONFLICT");
}
```

- [x] **步骤 5：实现整批撤销**

撤销加载该 batch 创建的每个 active revision，找到其前一有效 revision；对有前身者追加 rollback revision，对纯新增者追加 `superseded` revision。整批只创建一个 snapshot/generation/event。已经 rollback 的 batch 重试返回原报告。

```ts
const commands = importedRevisions.map((revision): RollbackKnowledgeCommand =>
  revision.previous
    ? rollbackToPrevious(revision)
    : supersedeImportedAddition(revision));
return store.commitImportRollbackInOpenTransaction({
  batchId,
  requestId: `rollback-import:${batchId}`,
  expectedGeneration,
  expectedSnapshotId,
  commands,
});
```

- [x] **步骤 6：运行提交、撤销和存储审计**

运行：

```powershell
node --test --import tsx test/knowledge-import-service.test.ts test/knowledge-commands.test.ts test/fault-injection.test.ts test/lossless-audit.test.ts
```

预期：PASS；任何故障都不出现部分导入，重复操作不增加 revision。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge-import/knowledge-import-service.ts translator-v5/src/knowledge/knowledge-commands.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test/knowledge-import-service.test.ts translator-v5/test/fault-injection.test.ts
git commit -m "feat: commit and roll back knowledge imports"
```

## 任务 7：接通桌面导入 IPC 与 preload

**文件：**

- 修改：`translator-v5/src/desktop/knowledge-contracts.ts`
- 修改：`translator-v5/src/desktop/desktop-knowledge-service.ts`
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 修改：`translator-v5/test/desktop-ipc.test.ts`
- 修改：`translator-v5/test/desktop-main-security.test.ts`

- [x] **步骤 1：编写文件选择、opaque ID 和恶意路径失败测试**

```ts
test("returns an opaque pending file before inspection", async () => {
  const result = await fixture.invoke("folioloom:knowledge-import-choose");
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected pending import");
  assert.equal(result.value.fileName, "terms.xlsx");
  assert.match(result.value.pendingImportId, /^[0-9a-f-]{36}$/u);
  assert.equal(JSON.stringify(result.value).includes(fixture.absolutePath), false);
});

test("rejects a renderer supplied path and unknown mapping fields", async () => {
  const result = await fixture.invoke("folioloom:knowledge-import-stage", {
    pendingImportId: fixture.pendingId,
    path: "C:\\secrets\\terms.xlsx",
    mapping: { source: "A", sql: "DELETE FROM events" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DESKTOP_INPUT_INVALID");
});
```

- [x] **步骤 2：运行 IPC 测试确认失败**

运行：

```powershell
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts
```

预期：FAIL，导入通道不存在。

- [x] **步骤 3：注册有限导入通道**

加入：

```ts
"folioloom:knowledge-import-choose"
"folioloom:knowledge-import-inspect"
"folioloom:knowledge-import-confirm-encoding"
"folioloom:knowledge-import-list-staged"
"folioloom:knowledge-import-get-staged"
"folioloom:knowledge-import-suggest"
"folioloom:knowledge-import-stage"
"folioloom:knowledge-import-decide"
"folioloom:knowledge-import-commit"
"folioloom:knowledge-import-rollback"
"folioloom:knowledge-import-cancel-operation"
"folioloom:knowledge-import-cancel-pending"
"folioloom:knowledge-import-discard-staged"
```

文件选择过滤器只含 json/yaml/yml/csv/xlsx，选择通道只登记路径并返回 `PendingKnowledgeImport`。inspect/编码确认只接受 pendingImportId、operationId 和 `ImportTextEncoding` 枚举；所有后续调用只接受 pendingImportId 或 batchId、operationId、枚举 selection 和严格映射对象。

- [x] **步骤 4：扩展 preload**

```ts
chooseKnowledgeImport(): Promise<DesktopResult<PendingKnowledgeImport>>;
inspectKnowledgeImport(request: InspectImportRequest): Promise<DesktopResult<ImportInspectionResult>>;
confirmKnowledgeImportEncoding(request: ConfirmImportEncodingRequest): Promise<DesktopResult<ImportInspectionResult>>;
listStagedKnowledgeImports(): Promise<DesktopResult<readonly StagedImportSummary[]>>;
getStagedKnowledgeImport(request: StagedImportPageRequest): Promise<DesktopResult<StagedImportReport>>;
suggestKnowledgeImport(request): Promise<DesktopResult<MappingSuggestion>>;
stageKnowledgeImport(request): Promise<DesktopResult<StagedImportReport>>;
decideKnowledgeImport(request): Promise<DesktopResult<StagedImportReport>>;
commitKnowledgeImport(request): Promise<DesktopResult<CommittedImportReport>>;
rollbackKnowledgeImport(request): Promise<DesktopResult<RolledBackImportReport>>;
cancelKnowledgeImportOperation(request: CancelImportOperationRequest): Promise<DesktopResult<void>>;
cancelPendingKnowledgeImport(pendingImportId: string): Promise<DesktopResult<void>>;
discardStagedKnowledgeImport(request: DiscardStagedImportRequest): Promise<DesktopResult<void>>;
```

不暴露 `readFile`、`openPath`、generic invoke 或 parser。

- [x] **步骤 5：运行 IPC、安全和桌面类型检查**

运行：

```powershell
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts
npm run desktop:typecheck
```

预期：PASS。

- [x] **步骤 6：Commit**

```powershell
git add translator-v5/src/desktop/knowledge-contracts.ts translator-v5/src/desktop/desktop-knowledge-service.ts translator-v5/src/desktop/main/ipc.ts translator-v5/src/desktop/preload/index.ts translator-v5/src/desktop/preload/folioloom-api.d.ts translator-v5/test/desktop-ipc.test.ts translator-v5/test/desktop-main-security.test.ts
git commit -m "feat: expose safe knowledge import IPC"
```

## 任务 8：交付四步导入向导

**文件：**

- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeImportWizard.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/ImportMappingStep.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/ImportConflictStep.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeImportWizard.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`

- [x] **步骤 1：编写官方模板、映射、冲突和刷新失败测试**

```tsx
it("skips manual mapping for an official template but still shows preview", async () => {
  const user = userEvent.setup();
  render(<KnowledgeImportWizard api={officialTemplateApi()} onClose={vi.fn()} onCommitted={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "选择文件" }));
  expect(await screen.findByRole("heading", { name: "检查与解决冲突" })).toBeTruthy();
  expect(screen.getByText("将新增 12 条")).toBeTruthy();
});

it("requires confirmation for medium-confidence mappings", async () => {
  const user = userEvent.setup();
  render(<KnowledgeImportWizard api={ambiguousApi()} onClose={vi.fn()} onCommitted={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "选择文件" }));
  expect(await screen.findByText("请确认“备注”的来源列")).toBeTruthy();
  expect((screen.getByRole("button", { name: "生成预览" }) as HTMLButtonElement).disabled).toBe(true);
});

it("commits once and refreshes the workbench generation", async () => {
  const onCommitted = vi.fn();
  const user = userEvent.setup();
  render(<KnowledgeImportWizard api={readyBatchApi()} onClose={vi.fn()} onCommitted={onCommitted} />);
  await completeWizard(user);
  await user.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(expect.objectContaining({
    generation: 8,
  })));
});

it("offers to resume a staged batch after the application restarts", async () => {
  render(<KnowledgeImportWizard api={restartedStagedApi()} onClose={vi.fn()} onCommitted={vi.fn()} />);
  expect(await screen.findByText("发现一项尚未提交的导入")).toBeTruthy();
  expect(screen.getByRole("button", { name: "继续处理" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "丢弃暂存" })).toBeTruthy();
});

it("cancels an active inspection and keeps the wizard usable", async () => {
  const api = cancellableInspectionApi();
  const user = userEvent.setup();
  render(<KnowledgeImportWizard api={api} onClose={vi.fn()} onCommitted={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "选择文件" }));
  await user.click(await screen.findByRole("button", { name: "取消检查" }));
  expect(api.cancelKnowledgeImportOperation).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "选择文件" })).toBeTruthy();
});
```

- [x] **步骤 2：运行组件测试确认失败**

运行：

```powershell
npx vitest run --config vitest.desktop.config.ts KnowledgeImportWizard
```

预期：FAIL，向导组件不存在。

- [x] **步骤 3：实现四步状态机**

```ts
type ImportWizardState =
  | { step: "choose"; busy: false }
  | {
      step: "choose";
      busy: true;
      pending: PendingKnowledgeImport;
      operationId: ImportOperationId;
    }
  | {
      step: "encoding";
      pending: Extract<ImportInspectionResult, { status: "encoding_required" }>;
    }
  | { step: "map"; inspection: ImportInspection; draft: MappingSuggestion }
  | { step: "review"; report: StagedImportReport }
  | { step: "done"; report: CommittedImportReport }
  | { step: "failed"; previous: "choose" | "map" | "review"; error: DesktopError };
```

关闭向导时：

- active operation 先调 `cancelKnowledgeImportOperation`，完成取消后再调 `cancelPendingKnowledgeImport`；
- 没有 active operation 的 pending file 直接调 `cancelPendingKnowledgeImport`；
- staged batch 保留并提示“下次可继续”或显式丢弃；
- committed batch 不调用 cancel。

迟到的 suggest/stage 响应用 request nonce 丢弃。

选择文件后立即生成 operationId 并调用 `inspectKnowledgeImport`；busy 状态显示“取消检查”。当 CSV 返回 `encoding_required` 时，向导先展示候选编码和短预览；确认后使用新的 operationId 调主进程重新严格解码，成功才进入 map。编码失败保留选择界面和错误，不清空 pending file。stage/commit/rollback 各自使用新的 operationId，进度区在操作结束前始终提供取消按钮。

- [x] **步骤 4：实现映射界面**

显示：

- 记录路径或工作表；
- 标题行选择；
- 对象类型和默认作用域；
- 每个 FolioLoom 字段对应的源列；
- high/medium/low 置信和简短原因；
- 50 行以内样例预览。

官方模板仍展示只读映射摘要，不直接跳过用户检查。

```tsx
return (
  <ImportMappingStep
    inspection={state.inspection}
    selection={selection}
    suggestion={suggestion}
    sampleLimit={50}
    onSelectionChange={setSelection}
    onFieldChange={setFieldMapping}
    onConfirm={() => stageImport(selection, confirmedFields)}
  />
);
```

- [x] **步骤 5：实现冲突和错误界面**

按新增、安全合并、冲突、无效分组。每条冲突提供允许的决策；批量操作显示影响条数。存在 unresolved 或未 skip 的 invalid 时禁用提交。

提交成功页显示新增/更新/合并/跳过数量和“撤销本次导入”按钮。撤销需要二次确认并显示它会生成新版本。

```tsx
const canCommit = report.unresolved === 0 && report.counts.invalid === 0;
return (
  <ImportConflictStep
    report={report}
    canCommit={canCommit}
    onDecide={setDecision}
    onApplySignature={applyDecisionToSignature}
    onCommit={commitBatch}
  />
);
```

- [x] **步骤 6：接入知识工作台刷新**

`KnowledgeWorkbench` 在 import commit/rollback 后：

1. 清空旧 cursor 页面；
2. 使用返回 generation 重载第一页；
3. 若当前详情对象仍存在则重载详情，否则关闭；
4. 显示一次性成功状态，不把报告塞入全局 App error。

打开导入向导时先调用 `listStagedKnowledgeImports`。存在 staged batch 时先显示恢复页；“继续处理”读取该 batch 的分页预览，“丢弃暂存”调用 `discardStagedKnowledgeImport` 后才进入文件选择。不得因为 renderer 重载自动删除 staging，也不得把尚未提交的 batch 误走知识 rollback。

```ts
async function refreshAfterImport(result: CommittedImportReport | RolledBackImportReport) {
  setCursor(undefined);
  const page = await api.listKnowledge({ ...filters, cursor: undefined, limit: 50 });
  setPage(requireOk(page, result.generation));
  if (selectedId) await reloadOrCloseDetail(selectedId);
  setNotice(resultHasRollback(result) ? "已撤销本次导入" : "知识已导入");
}
```

- [x] **步骤 7：运行组件、桌面和构建测试**

运行：

```powershell
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
```

预期：PASS；键盘可以完成选择、映射、决策和提交，焦点不会落到遮罩后方。

- [x] **步骤 8：Commit**

```powershell
git add translator-v5/src/desktop/renderer/src/components/KnowledgeImportWizard.tsx translator-v5/src/desktop/renderer/src/components/ImportMappingStep.tsx translator-v5/src/desktop/renderer/src/components/ImportConflictStep.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeImportWizard.test.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx translator-v5/src/desktop/renderer/src/styles.css
git commit -m "feat: add knowledge import wizard"
```

## 任务 9：模板、文档与端到端验收

**文件：**

- 修改：`translator-v5/README.md`
- 创建：`docs/superpowers/reports/2026-07-23-knowledge-import-validation.md`

- [x] **步骤 1：验证四种格式产生相同语义结果**

用同一组 20 条术语分别生成 JSON、YAML、CSV、XLSX，完成导入后比较：

- normalized subject；
- active payload；
- authority origin/scope/ownedFields；
- revision 数；
- snapshot content；
- generation。

除 source file hash、batch ID 和行位置外，语义对象必须一致。

运行：

```powershell
node --test --import tsx --test-name-pattern="four formats produce identical knowledge" test/knowledge-import-service.test.ts
```

预期：PASS，四个数据库的规范化语义摘要相同。

- [x] **步骤 2：验证冲突与重启恢复**

执行：

1. stage 一个含 3 个冲突的 XLSX；
2. 解决 2 个，关闭应用；
3. 重开后从 batch 恢复；
4. 解决最后 1 个并提交；
5. 重复提交；
6. 撤销；
7. 重复撤销。

断言提交和撤销分别只增加一次 generation，重复调用返回原报告。

运行：

```powershell
node --test --import tsx --test-name-pattern="restart|idempotently|rolls back every import" test/knowledge-import-service.test.ts
```

预期：PASS，重开 fixture 可继续同一 batch，重试不增加 revision。

- [x] **步骤 3：验证恶意和损坏输入**

测试：

- YAML alias bomb；
- 65 层 JSON；
- 100,001 行 CSV；
- 257 列 CSV；
- 损坏 XLSX zip；
- XLSX zip bomb、路径穿越 entry 和外部 relationship；
- formula/shared formula/external link；
- `.xlsm`；
- 重复 JSON key/YAML key；
- `__proto__` 键；
- 非 UTF-8 且未确认编码的 CSV。

每种输入应有稳定错误码、无数据库部分写入、无 renderer 崩溃。

运行：

```powershell
node --test --import tsx test/knowledge-import-input-policy.test.ts test/knowledge-import-json-yaml.test.ts test/knowledge-import-csv-xlsx.test.ts test/desktop-main-security.test.ts
```

预期：PASS，每个恶意 fixture 命中指定错误码且 batch/row 计数保持 0。

- [x] **步骤 4：运行完整验证**

运行：

```powershell
npm audit --omit=dev
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
```

预期：全部 PASS，audit 无 high/critical。

- [x] **步骤 5：更新 README**

写明：

- 官方模板下载位置；
- 任意字段映射流程；
- 作用域默认是当前书；
- 冲突的五种处理方式；
- 导入可直接选择 book/project；通用 term/style 在导入后从工作台显式提升；
- 导入与撤销都生成版本；
- 不支持宏、公式执行、任意 SQL；
- 何时需要重新扫描：导入术语本身不要求重新扫描，只有希望为新术语补全全书位置证据时才运行离线证据索引。

README 使用以下结构：

```markdown
## 导入已有术语与知识
### 使用 FolioLoom 官方模板
### 映射任意 JSON、YAML、CSV 或 XLSX
### 处理冲突与无效行
### 提交、撤销和重新扫描
### 安全边界与不支持的格式
```

- [x] **步骤 6：记录验证报告**

`docs/superpowers/reports/2026-07-23-knowledge-import-validation.md` 记录：

- 依赖版本和 audit 结果；
- 四格式等价测试；
- 100,000 行 CSV staging 时间与峰值内存；
- XLSX 工作表/公式安全结果；
- 重启、幂等、回滚和故障注入结果；
- 尚未实现但不影响正确性的低优先级限制。

报告结构固定为：

```markdown
# 知识导入验证报告
## 依赖与审计
## 四格式语义等价
## 冲突、重启、幂等与撤销
## 恶意输入与 XLSX 安全
## 100,000 行 CSV 性能
## 非 P0/P1 限制
```

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/README.md docs/superpowers/reports/2026-07-23-knowledge-import-validation.md
git commit -m "docs: validate knowledge import workflow"
```
