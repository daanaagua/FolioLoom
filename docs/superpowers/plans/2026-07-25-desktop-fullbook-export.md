# FolioLoom 桌面端整本翻译与导出实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 V5 已有的整本翻译、持久化恢复和严格文本导出接入 Electron GUI，并补齐经过校验的 EPUB 3 输出。

**架构：** Electron 主进程新增整本运行服务与导出服务，renderer 只通过固定 IPC 合约提交开始、暂停、继续和导出意图。试译与整本翻译共用同一个运行方案生成器；SQLite 是运行状态的唯一事实来源，EPUB 与 TXT 写入临时目录并在严格校验通过后发布。

**技术栈：** TypeScript 7、Node.js、Electron 43、React 19、SQLite、Vitest、Node test runner、EPUB 3 / ZIP Store

---

## 文件结构

### 新建

- `translator-v5/src/desktop/desktop-runtime-plan.ts`：试译与整本翻译共享的 provider-safe 运行方案与稳定指纹。
- `translator-v5/src/desktop/desktop-fullbook-service.ts`：整本任务状态机、后台运行、暂停恢复和 SQLite 状态投影。
- `translator-v5/src/desktop/desktop-export-service.ts`：导出候选、目录令牌、原子发布和结果登记。
- `translator-v5/src/export/stored-zip.ts`：生成无 data descriptor 的确定性 Store ZIP。
- `translator-v5/src/export/epub-writer.ts`：从活动译文生成 EPUB 3。
- `translator-v5/src/desktop/renderer/src/components/RunWorkspace.tsx`：整本运行工作区。
- `translator-v5/src/desktop/renderer/src/components/ExportWorkspace.tsx`：导出工作区。
- `translator-v5/test/desktop-runtime-plan.test.ts`：共享运行方案测试。
- `translator-v5/test/desktop-fullbook-service.test.ts`：整本状态机和恢复测试。
- `translator-v5/test/desktop-export-service.test.ts`：严格、原子、可选择格式的桌面导出测试。
- `translator-v5/test/epub-writer.test.ts`：EPUB ZIP、XML、章节和 CJK 测试。
- `translator-v5/test/desktop-fullbook-export-flow.test.ts`：确定性假模型端到端闭环。
- `translator-v5/src/desktop/renderer/src/components/RunWorkspace.test.tsx`：运行页交互测试。
- `translator-v5/src/desktop/renderer/src/components/ExportWorkspace.test.tsx`：导出页交互测试。

### 修改

- `translator-v5/src/desktop/desktop-trial-service.ts`：改用共享运行方案，保留兼容导出类型。
- `translator-v5/src/desktop/contracts.ts`：新增整本运行与导出 DTO、状态和事件。
- `translator-v5/src/report.ts`：导出有序活动译文投影和可选友好文件名。
- `translator-v5/src/export/export-verifier.ts`：补充 EPUB 结构与正文产物校验。
- `translator-v5/src/desktop/main/ipc.ts`：增加受控运行和导出 IPC、目录选择与输入校验。
- `translator-v5/src/desktop/main/index.ts`：实例化服务、广播进度、退出前安全暂停。
- `translator-v5/src/desktop/preload/folioloom-api.d.ts`：声明新 bridge。
- `translator-v5/src/desktop/preload/index.ts`：映射 IPC 并过滤进度事件。
- `translator-v5/src/desktop/renderer/src/App.tsx`：加载真实运行/导出工作区并刷新状态。
- `translator-v5/src/desktop/renderer/src/types.ts`：扩展 busy action。
- `translator-v5/src/desktop/renderer/src/components/WorkspacePlaceholder.tsx`：只保留尚未实现的审阅占位。
- `translator-v5/src/desktop/renderer/src/styles.css`：运行和导出布局。
- `translator-v5/src/desktop/renderer/src/App.test.tsx`：扩展 API fixture 和路由集成断言。
- `translator-v5/test/desktop-ipc.test.ts`：覆盖新 channel、主进程持有路径和非法转换。
- `translator-v5/test/export-verifier.test.ts`：覆盖完整 EPUB 和正文篡改。
- `translator-v5/test/desktop-build-config.test.ts`：更新桌面能力声明。
- `translator-v5/package.json`、`translator-v5/package-lock.json`：版本更新为 1.2.0。
- `README.md`、`translator-v5/README.md`：删除 GUI 只能试译/不可导出的旧说明。

## 任务 1：抽取共享模型运行方案

**文件：**
- 创建：`translator-v5/src/desktop/desktop-runtime-plan.ts`
- 创建：`translator-v5/test/desktop-runtime-plan.test.ts`
- 修改：`translator-v5/src/desktop/desktop-trial-service.ts`
- 测试：`translator-v5/test/desktop-trial-service.test.ts`

- [x] **步骤 1：编写失败测试，锁定质量/快速模式和稳定指纹**

测试必须构造一个支持 `off/high/max` 的假运行时，并断言：

```ts
const quality = buildDesktopRuntimePlan("quality", runtime);
assert.equal(quality.runtimeSet.primary.effort, "high");
assert.equal(quality.runtimeSet.escalation.effort, "high");

const fast = buildDesktopRuntimePlan("fast", runtime);
assert.equal(fast.runtimeSet.primary.effort, "off");
assert.equal(fast.runtimeSet.escalation.effort, "high");
assert.equal(
  serializeDesktopRuntimeFingerprint(fast.fingerprint),
  serializeDesktopRuntimeFingerprint(buildDesktopRuntimePlan("fast", runtime).fingerprint),
);
```

同时断言模型对象与 profile model id 不一致、非法 effort 集合和错误的派生 runtime 均抛出 `DESKTOP_RUNTIME_MISMATCH`。

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/desktop-runtime-plan.test.ts
```

预期：FAIL，模块 `desktop-runtime-plan.js` 尚不存在。

- [x] **步骤 3：实现共享类型和纯函数**

核心公开形状固定为：

```ts
export interface DesktopTranslationRuntime {
  profile: ModelProfile;
  model: Model<any>;
  streamFn: StreamFn;
  supportedEfforts: readonly ProviderEffort[];
  createWithProfile(profile: ModelProfile): DesktopTranslationRuntime;
}

export interface DesktopRuntimeResolver {
  resolve(): Promise<DesktopTranslationRuntime | undefined>;
}

export interface DesktopRuntimeFingerprint {
  schema: "folioloom-desktop-runtime-1";
  mode: DesktopTrialMode;
  primary: NormalizedDesktopModelProfile;
  escalation: NormalizedDesktopModelProfile;
}

export interface DesktopRuntimePlan {
  runtimeSet: TranslationRuntimeSet;
  fingerprint: DesktopRuntimeFingerprint;
}

export function buildDesktopRuntimePlan(
  mode: DesktopTrialMode,
  qualityRuntime: DesktopTranslationRuntime,
): DesktopRuntimePlan;

export function serializeDesktopRuntimeFingerprint(
  value: DesktopRuntimeFingerprint,
): string;
```

迁移 `desktop-trial-service.ts` 中的 profile 校验、effort 降档、派生 runtime 和指纹逻辑；原文件用类型别名继续导出 `DesktopTrialRuntime`，避免 main 和既有测试回归。

- [x] **步骤 4：运行共享方案和试译回归**

运行：

```powershell
node --test --import tsx test/desktop-runtime-plan.test.ts test/desktop-trial-service.test.ts
```

预期：全部 PASS。

- [x] **步骤 5：提交**

```powershell
git add translator-v5/src/desktop/desktop-runtime-plan.ts translator-v5/src/desktop/desktop-trial-service.ts translator-v5/test/desktop-runtime-plan.test.ts translator-v5/test/desktop-trial-service.test.ts
git commit -m "refactor(desktop): share translation runtime planning"
```

## 任务 2：实现整本运行状态机

**文件：**
- 创建：`translator-v5/src/desktop/desktop-fullbook-service.ts`
- 创建：`translator-v5/test/desktop-fullbook-service.test.ts`
- 修改：`translator-v5/src/desktop/contracts.ts`

- [x] **步骤 1：先定义 renderer DTO 并编写失败测试**

新增合同：

```ts
export type DesktopFullBookPhase =
  | "idle" | "preparing" | "running" | "pausing"
  | "paused" | "completed" | "needs_attention" | "failed";

export interface DesktopFullBookRunSnapshot {
  runId: string;
  sourceVersion: string;
  modelId: string;
  mode: DesktopTrialMode;
  phase: DesktopFullBookPhase;
  progress: DesktopRunSummary["progress"] & {
    runningWindows: number;
    stagedWindows: number;
  };
  canPause: boolean;
  canResume: boolean;
  canExport: boolean;
  error?: DesktopError;
}

export interface DesktopFullBookSnapshot {
  activeRunId?: string;
  runs: readonly DesktopFullBookRunSnapshot[];
}

export interface DesktopStartFullBookRequest {
  mode: DesktopTrialMode;
}

export interface DesktopResumeFullBookRequest {
  runId: string;
}

export const DESKTOP_FULLBOOK_PROGRESS_CHANNEL =
  "folioloom:fullbook-progress" as const;

export interface DesktopFullBookProgress {
  runId: string;
  phase: DesktopFullBookPhase;
  progress: DesktopFullBookRunSnapshot["progress"];
}
```

失败测试覆盖：

1. `start()` 返回准备/运行快照而不等待整本完成；
2. 元数据带 `desktopFullBook.schema`、mode 和 runtime fingerprint；
3. 试译 run 不被当成正式 run；
4. 同时启动第二个任务被拒绝；
5. `pause()` 触发 signal，等待 runner settle 后进入 `paused`；
6. `resume()` 使用原 run id、protocol、model id 和完全相同的 metadata；
7. 当前运行指纹变化时返回 `DESKTOP_FULLBOOK_RUNTIME_MISMATCH`；
8. 重启后的未完成正式 run 投影为 `paused`；
9. human-required 投影为 `needs_attention`；
10. completed/warning 完整任务投影为 `completed` 且 `canExport=true`。

- [x] **步骤 2：运行测试确认失败**

```powershell
node --test --import tsx test/desktop-fullbook-service.test.ts
```

预期：FAIL，服务与合同尚不存在。

- [x] **步骤 3：实现后台运行和持久化投影**

服务公开 API：

```ts
export interface DesktopFullBookServiceOptions {
  runtime: DesktopRuntimeResolver;
  runBook?: (options: LosslessBookRunOptions) => Promise<LosslessBookRunResult>;
  createRunId?: () => string;
  onProgress?: (progress: DesktopFullBookProgress) => void;
  pollIntervalMs?: number;
}

export class DesktopFullBookService {
  snapshot(project: DesktopProjectRequest): DesktopFullBookSnapshot;
  start(
    project: DesktopProjectRequest,
    request: DesktopStartFullBookRequest,
  ): Promise<DesktopFullBookSnapshot>;
  pause(): Promise<DesktopFullBookSnapshot>;
  resume(
    project: DesktopProjectRequest,
    request: DesktopResumeFullBookRequest,
  ): Promise<DesktopFullBookSnapshot>;
  hasActiveTask(): boolean;
  settleForShutdown(): Promise<void>;
}
```

实现必须遵守：

- store 默认为 `<manifest-dir>/artifacts/folioloom/book.db`，显式 `project.storePath` 优先；
- 新建 run 元数据使用 `folioloom-desktop-fullbook-1`；
- 启动前读取 SourceLedger，运行时解析后再次核对 sourceVersion；
- runner promise 留在主进程后台，错误转换为持久化可解释快照；
- 进度轮询只读打开 SQLite，事件观察器抛错不得影响任务；
- 暂停原因使用专用 `DesktopFullBookError("DESKTOP_FULLBOOK_PAUSED", ...)`；
- 无活动任务时 `pause()` 幂等返回快照；
- 恢复前读取已存 run 元数据并比较序列化指纹；
- 只允许恢复带有效 desktopFullBook 元数据的正式 run。

- [x] **步骤 4：运行服务测试**

```powershell
node --test --import tsx test/desktop-fullbook-service.test.ts test/desktop-runtime-plan.test.ts test/book-runner.test.ts
```

预期：全部 PASS。

- [x] **步骤 5：提交**

```powershell
git add translator-v5/src/desktop/contracts.ts translator-v5/src/desktop/desktop-fullbook-service.ts translator-v5/test/desktop-fullbook-service.test.ts
git commit -m "feat(desktop): add durable full-book runner"
```

## 任务 3：生成并严格验证 EPUB

**文件：**
- 创建：`translator-v5/src/export/stored-zip.ts`
- 创建：`translator-v5/src/export/epub-writer.ts`
- 创建：`translator-v5/test/epub-writer.test.ts`
- 修改：`translator-v5/src/report.ts`
- 修改：`translator-v5/src/export/export-verifier.ts`
- 修改：`translator-v5/test/export-verifier.test.ts`

- [x] **步骤 1：编写 EPUB 失败测试**

测试用包含 `& < > " '`, 中文、日文和韩文的译文夹具，断言：

```ts
const result = writeLosslessBookEpub(store, "run-a", epubPath, {
  title: "书名 & <测试>",
  language: "zh-CN",
});
const entries = readStoredZipEntries(epubPath);

assert.equal(entries[0]?.name, "mimetype");
assert.equal(entries[0]?.method, 0);
assert.equal(entries[0]?.data.toString("utf8"), "application/epub+zip");
assert.ok(entries.some((entry) => entry.name === "META-INF/container.xml"));
assert.ok(entries.some((entry) => entry.name === "EPUB/package.opf"));
assert.ok(entries.some((entry) => entry.name === "EPUB/nav.xhtml"));
assert.ok(entries.some((entry) => entry.name === "META-INF/v5-lineage.json"));
```

用 `fast-xml-parser` 解析 container、OPF、nav 和全部正文 XHTML；断言 XML 特殊字符被转义、段落顺序与 `globalIndex` 一致。另一个夹具没有 chapterId，断言按字符上限在块边界稳定分节。

- [x] **步骤 2：运行测试确认失败**

```powershell
node --test --import tsx test/epub-writer.test.ts
```

预期：FAIL，EPUB writer 尚不存在。

- [x] **步骤 3：实现确定性 Store ZIP**

`stored-zip.ts` 提供：

```ts
export interface StoredZipInput {
  name: string;
  data: Buffer | string;
}

export function writeStoredZip(path: string, entries: readonly StoredZipInput[]): void;
export function readStoredZipEntries(path: string): readonly {
  name: string;
  method: number;
  data: Buffer;
}[];
```

实现本地文件头、CRC32、中央目录和 EOCD；禁止 data descriptor，拒绝重复、绝对、反斜杠和 `..` 路径。`mimetype` 由 EPUB writer 固定放在第一项且 Store。

- [x] **步骤 4：抽取有序译文投影并实现 EPUB**

`report.ts` 新增：

```ts
export function losslessBookTranslations(
  store: LosslessBookStore,
  runId: string,
): PilotTranslation[];
```

`epub-writer.ts` 新增：

```ts
export interface LosslessEpubOptions {
  title: string;
  language: "zh-CN";
  fallbackSectionChars?: number;
}

export function writeLosslessBookEpub(
  store: LosslessBookStore,
  runId: string,
  outputPath: string,
  options: LosslessEpubOptions,
): string;
```

连续相同 chapterId 归入同一 section；缺少章节时累计到 120,000 字符并只在块边界切分。正文每个块保留空行分隔；段内换行写成 `<br/>`。导航标题使用“第 N 节”，避免把未翻译 source metadata 泄漏到中文成品。

- [x] **步骤 5：增强导出校验**

`ExportVerificationIncidentCode` 增加：

```ts
| "TRANSLATION_CONTENT_MISMATCH"
| "BILINGUAL_CONTENT_MISMATCH"
| "AUDIT_CONTENT_MISMATCH"
| "EPUB_INVALID"
| "EPUB_MIMETYPE_INVALID"
| "EPUB_PACKAGE_INVALID"
| "EPUB_NAVIGATION_INVALID";
```

`verifyExport()` 从 store 重建预期中文 TXT、双语 TXT 和 audit JSON，比较实际内容；存在 EPUB 时读取全部 ZIP 项，检查首项 mimetype、container rootfile、OPF manifest/spine、nav 目标、XHTML 可解析性和 lineage。

- [x] **步骤 6：运行 EPUB、验证器和 CLI 回归**

```powershell
node --test --import tsx test/epub-writer.test.ts test/export-verifier.test.ts test/cli.test.ts
```

预期：全部 PASS，现有 CLI 不带 EPUB 时行为不变。

- [x] **步骤 7：提交**

```powershell
git add translator-v5/src/export/stored-zip.ts translator-v5/src/export/epub-writer.ts translator-v5/src/report.ts translator-v5/src/export/export-verifier.ts translator-v5/test/epub-writer.test.ts translator-v5/test/export-verifier.test.ts
git commit -m "feat(export): add verified EPUB output"
```

## 任务 4：实现桌面导出服务

**文件：**
- 创建：`translator-v5/src/desktop/desktop-export-service.ts`
- 创建：`translator-v5/test/desktop-export-service.test.ts`
- 修改：`translator-v5/src/desktop/contracts.ts`
- 修改：`translator-v5/src/report.ts`

- [x] **步骤 1：定义导出合同并编写失败测试**

新增：

```ts
export type DesktopExportFormat =
  | "translation_txt" | "bilingual_txt" | "epub";

export interface DesktopExportCandidate {
  runId: string;
  modelId: string;
  status: "ready" | "incomplete" | "blocked";
  completedWindows: number;
  totalWindows: number;
  blockers: readonly string[];
}

export interface DesktopExportDestination {
  destinationId: string;
  displayPath: string;
}

export interface DesktopExportSnapshot {
  candidates: readonly DesktopExportCandidate[];
  defaultDestination?: DesktopExportDestination;
}

export interface DesktopExportRequest {
  runId: string;
  destinationId: string;
  formats: readonly DesktopExportFormat[];
}

export interface DesktopExportResult {
  exportId: string;
  runId: string;
  directory: string;
  files: readonly {
    format: DesktopExportFormat | "audit" | "metrics";
    fileName: string;
  }[];
}
```

测试覆盖：

- 试译 run 不进入候选；
- 完整 CLI run 和 desktop fullbook run 可导出；
- 未完成、human-required 和 audit incident 生成中文阻断原因；
- destination 使用不可猜测令牌，未知/过期令牌被拒绝；
- 空 formats、重复 formats 和非法 run id 被拒绝；
- 写入发生在同父目录临时目录；
- writer 或 verifier 失败时清理临时目录且最终目录不存在；
- 成功后原子重命名，返回用户选择的三种文件；
- 未选择格式的主文件与对应 lineage 不留在最终目录；
- 同名目录使用稳定后缀而不覆盖旧成品。

- [x] **步骤 2：运行测试确认失败**

```powershell
node --test --import tsx test/desktop-export-service.test.ts
```

预期：FAIL，服务尚不存在。

- [x] **步骤 3：支持 GUI 友好文件名但保持 CLI 默认**

扩展 `writeLosslessBookArtifacts()`：

```ts
export interface WriteLosslessBookArtifactsOptions {
  allowIncomplete?: boolean;
  fileStem?: string;
}
```

`fileStem` 未提供时继续生成 `v5_book_translation.txt` 等旧名称；提供时生成 `<安全书名>-中文.txt`、`<安全书名>-双语.txt` 及对应审计、指标和 lineage。

- [x] **步骤 4：实现受控目录和原子导出**

服务 API：

```ts
export class DesktopExportService {
  snapshot(project: DesktopProjectRequest): DesktopExportSnapshot;
  registerDestination(path: string): DesktopExportDestination;
  export(
    project: DesktopProjectRequest,
    request: DesktopExportRequest,
  ): Promise<DesktopExportResult>;
  completedDirectory(exportId: string): string | undefined;
}
```

实现严格审计、友好文件名、EPUB、`verifyExport()`、选择格式后的清理和原子 rename。默认 destination 注册项目目录下的 `exports`，renderer 永远不直接提交文件系统路径。

- [x] **步骤 5：运行导出服务与报告回归**

```powershell
node --test --import tsx test/desktop-export-service.test.ts test/export-verifier.test.ts test/lossless-audit.test.ts
```

预期：全部 PASS。

- [x] **步骤 6：提交**

```powershell
git add translator-v5/src/desktop/contracts.ts translator-v5/src/desktop/desktop-export-service.ts translator-v5/src/report.ts translator-v5/test/desktop-export-service.test.ts
git commit -m "feat(desktop): add strict export service"
```

## 任务 5：接入 Electron IPC、preload 和生命周期

**文件：**
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/main/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/test/desktop-ipc.test.ts`
- 修改：`translator-v5/test/desktop-main-security.test.ts`

- [x] **步骤 1：先扩展 IPC 失败测试**

新增固定 channel：

```ts
"folioloom:fullbook-state"
"folioloom:start-fullbook"
"folioloom:pause-fullbook"
"folioloom:resume-fullbook"
"folioloom:export-state"
"folioloom:choose-export-directory"
"folioloom:export-book"
"folioloom:open-export-directory"
```

测试断言：

- renderer 的 start payload 只能含 `mode`；
- resume 只能含已存在 run id；
- export formats 是去重后的允许枚举；
- manifest/store path 永远来自 `getCurrentRequest()`；
- 活动整本任务存在时 choose-source 返回 `DESKTOP_FULLBOOK_ACTIVE`；
- open-directory 只接受成功 exportId；
- 非可信事件、额外字段和多余参数均失败；
- 目录选择器使用 `openDirectory/createDirectory`，取消不清空旧 destination。

- [x] **步骤 2：运行 IPC 测试确认失败**

```powershell
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts
```

预期：FAIL，新 channel 未注册。

- [x] **步骤 3：实现 IPC 和 preload bridge**

preload API 固定新增：

```ts
getFullBookState(): Promise<DesktopResult<DesktopFullBookSnapshot>>;
startFullBook(request: DesktopStartFullBookRequest): Promise<DesktopResult<DesktopFullBookSnapshot>>;
pauseFullBook(): Promise<DesktopResult<DesktopFullBookSnapshot>>;
resumeFullBook(request: DesktopResumeFullBookRequest): Promise<DesktopResult<DesktopFullBookSnapshot>>;
onFullBookProgress(listener: (value: DesktopFullBookProgress) => void): () => void;
getExportState(): Promise<DesktopResult<DesktopExportSnapshot>>;
chooseExportDirectory(): Promise<DesktopResult<DesktopExportDestination>>;
exportBook(request: DesktopExportRequest): Promise<DesktopResult<DesktopExportResult>>;
openExportDirectory(exportId: string): Promise<DesktopResult<void>>;
```

进度事件验证必须检查精确字段、phase 枚举和非负整数，不转发未知对象。

- [x] **步骤 4：实例化服务并统一 runtime resolver**

`main/index.ts` 建立一个共享 `DesktopRuntimeResolver`，同时传给 trial 和 fullbook；广播 `DESKTOP_FULLBOOK_PROGRESS_CHANNEL`。`before-quit` 同时等待 trial cancel 和 fullbook `settleForShutdown()`。注入 Electron `shell.openPath`，非空错误字符串转换为失败结果。

- [x] **步骤 5：运行 IPC、preload、主进程和 typecheck**

```powershell
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts test/desktop-provider-adapter.test.ts
npm run desktop:typecheck
```

预期：全部 PASS。

- [x] **步骤 6：提交**

```powershell
git add translator-v5/src/desktop/main/ipc.ts translator-v5/src/desktop/main/index.ts translator-v5/src/desktop/preload/folioloom-api.d.ts translator-v5/src/desktop/preload/index.ts translator-v5/test/desktop-ipc.test.ts translator-v5/test/desktop-main-security.test.ts
git commit -m "feat(desktop): wire full-book and export IPC"
```

## 任务 6：实现翻译运行与导出工作区

**文件：**
- 创建：`translator-v5/src/desktop/renderer/src/components/RunWorkspace.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/RunWorkspace.test.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/ExportWorkspace.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/ExportWorkspace.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/types.ts`
- 修改：`translator-v5/src/desktop/renderer/src/components/WorkspacePlaceholder.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`

- [x] **步骤 1：编写运行页失败测试**

覆盖：

```ts
expect(screen.getByRole("heading", { name: "翻译运行" })).toBeTruthy();
expect(screen.getByText("32 / 100 个文本块")).toBeTruthy();
expect(screen.getByRole("progress").getAttribute("aria-valuenow")).toBe("32");
```

并验证：

- 默认质量模式，可切换快速模式；
- idle 只显示“开始整本翻译”；
- running 只允许“暂停”；
- pausing 文案为“正在完成当前文本块后暂停”；
- paused 允许继续；
- needs_attention 显示具体窗口数；
- 进度事件到达后刷新而不重建任务；
- 网络错误保留进度和重试入口；
- 内部 run id、SQLite 路径和协议名默认不可见。

- [x] **步骤 2：编写导出页失败测试**

覆盖：

- 列出完整 run 和完成度；
- 阻断 run 显示“仍有 N 个文本块未完成”；
- 默认勾选中文 TXT、双语 TXT、EPUB；
- 取消全部格式时按钮禁用；
- 选择目录后保留显示路径；
- 导出中按钮锁定；
- 成功后列出文件名和“打开文件夹”；
- 选择器取消不清空当前目录；
- 失败时显示下一步和折叠技术详情。

- [x] **步骤 3：运行 renderer 测试确认失败**

```powershell
npx vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/components/RunWorkspace.test.tsx src/desktop/renderer/src/components/ExportWorkspace.test.tsx
```

预期：FAIL，组件尚不存在。

- [x] **步骤 4：实现两个工作区**

`RunWorkspace` 只通过回调接收动作：

```ts
interface RunWorkspaceProps {
  title: string;
  modelReady: boolean;
  snapshot: DesktopFullBookSnapshot;
  busy: boolean;
  onStart(mode: DesktopTrialMode): void;
  onPause(): void;
  onResume(runId: string): void;
}
```

`ExportWorkspace` 只使用 DTO 和回调：

```ts
interface ExportWorkspaceProps {
  title: string;
  snapshot: DesktopExportSnapshot;
  destination?: DesktopExportDestination;
  result?: DesktopExportResult;
  busy: boolean;
  onChooseDirectory(): void;
  onExport(request: DesktopExportRequest): void;
  onOpenDirectory(exportId: string): void;
}
```

使用现有色彩、间距、按钮和卡片语汇；进度条有文本替代，窄窗口不产生横向滚动条。

- [x] **步骤 5：接入 App 和事件刷新**

`App` 在进入 runs/export 时读取快照；订阅 fullbook progress 后更新运行快照并刷新 onboarding/export 候选。更换书稿后清空旧 run/export UI。`WorkspacePlaceholder` 只处理 review；memory 继续使用 KnowledgeWorkbench。

- [x] **步骤 6：运行 renderer 回归**

```powershell
npx vitest run --config vitest.desktop.config.ts
```

预期：全部 PASS。

- [x] **步骤 7：提交**

```powershell
git add translator-v5/src/desktop/renderer/src/App.tsx translator-v5/src/desktop/renderer/src/App.test.tsx translator-v5/src/desktop/renderer/src/types.ts translator-v5/src/desktop/renderer/src/styles.css translator-v5/src/desktop/renderer/src/components/RunWorkspace.tsx translator-v5/src/desktop/renderer/src/components/RunWorkspace.test.tsx translator-v5/src/desktop/renderer/src/components/ExportWorkspace.tsx translator-v5/src/desktop/renderer/src/components/ExportWorkspace.test.tsx translator-v5/src/desktop/renderer/src/components/WorkspacePlaceholder.tsx
git commit -m "feat(desktop): add full-book and export workspaces"
```

## 任务 7：端到端闭环、版本和文档

**文件：**
- 创建：`translator-v5/test/desktop-fullbook-export-flow.test.ts`
- 修改：`translator-v5/test/desktop-build-config.test.ts`
- 修改：`translator-v5/package.json`
- 修改：`translator-v5/package-lock.json`
- 修改：`README.md`
- 修改：`translator-v5/README.md`

- [x] **步骤 1：编写端到端失败测试**

测试使用临时 TXT 和确定性 fake stream，执行：

```ts
function phaseWaiter(): {
  onProgress(progress: DesktopFullBookProgress): void;
  waitFor(phase: DesktopFullBookPhase): Promise<DesktopFullBookProgress>;
} {
  const waiting = new Map<
    DesktopFullBookPhase,
    (progress: DesktopFullBookProgress) => void
  >();
  return {
    onProgress(progress) {
      waiting.get(progress.phase)?.(progress);
      waiting.delete(progress.phase);
    },
    waitFor(phase) {
      return new Promise((resolve) => waiting.set(phase, resolve));
    },
  };
}

const phases = phaseWaiter();
const fullBook = new DesktopFullBookService({
  ...dependencies,
  onProgress: phases.onProgress,
});
const imported = await sourceService.importSource({ sourcePath });
const running = phases.waitFor("running");
const started = await fullBook.start(
  { manifestPath: imported.manifestPath },
  { mode: "fast" },
);
await running;
await fullBook.pause();
const paused = fullBook.snapshot({ manifestPath: imported.manifestPath });
assert.ok(paused.runs.some((run) => run.phase === "paused"));

const restartedPhases = phaseWaiter();
const restarted = new DesktopFullBookService({
  ...dependencies,
  onProgress: restartedPhases.onProgress,
});
const completed = restartedPhases.waitFor("completed");
await restarted.resume(
  { manifestPath: imported.manifestPath },
  { runId: started.activeRunId! },
);
await completed;

const destination = exporter.registerDestination(outputRoot);
const result = await exporter.export(
  { manifestPath: imported.manifestPath },
  {
    runId: started.activeRunId!,
    destinationId: destination.destinationId,
    formats: ["translation_txt", "bilingual_txt", "epub"],
  },
);
assert.deepEqual(
  new Set(result.files.map((file) => file.format)),
  new Set(["translation_txt", "bilingual_txt", "epub", "audit", "metrics"]),
);
```

最后重新打开 store 并对发布目录运行 `verifyExport()`；断言中文、日文、韩文 Unicode 均未乱码。

- [x] **步骤 2：运行端到端测试确认行为**

```powershell
node --test --import tsx test/desktop-fullbook-export-flow.test.ts
```

预期：PASS；如果测试揭示状态竞争，只修服务契约，不在测试中增加固定 sleep。

- [x] **步骤 3：更新版本和说明**

把 `package.json`、package-lock 根包版本改为 `1.2.0`。README 明确：

- GUI 已支持整本开始、暂停、重启后继续；
- GUI 已支持中文 TXT、双语 TXT、EPUB 和自动校验；
- 审阅队列仍是后续工作；
- 命令行继续可用且行为兼容。

`desktop-build-config.test.ts` 的能力声明改为：

```ts
translationWritePolicy: "single-window-trial-and-durable-fullbook",
exportPolicy: "strict-txt-bilingual-epub",
```

- [x] **步骤 4：运行文档与构建配置回归**

```powershell
node --test --import tsx test/desktop-build-config.test.ts test/verify-desktop-build.test.ts
npm run desktop:typecheck
```

预期：全部 PASS。

- [x] **步骤 5：提交**

```powershell
git add translator-v5/test/desktop-fullbook-export-flow.test.ts translator-v5/test/desktop-build-config.test.ts translator-v5/package.json translator-v5/package-lock.json README.md translator-v5/README.md
git commit -m "docs: prepare FolioLoom 1.2.0 desktop workflow"
```

## 任务 8：全量验证和 Windows 便携目录

**文件：**
- 仅修复验证发现的直接回归，不扩大功能范围。

- [x] **步骤 1：运行所有内核测试**

```powershell
npm test
```

预期：全部 PASS，无跳过新增测试。

- [x] **步骤 2：运行类型与桌面测试**

```powershell
npm run typecheck
npm run desktop:typecheck
npm run desktop:test
```

预期：全部 PASS。

- [x] **步骤 3：构建 production 桌面代码**

```powershell
npm run desktop:build
```

预期：main、preload、renderer 构建成功，构建验证 PASS。

- [x] **步骤 4：生成 win-unpacked 与文件夹便携包**

```powershell
npm run desktop:dist:folder
```

预期：

- `translator-v5/release/win-unpacked/FolioLoom.exe` 存在；
- `translator-v5/release/FolioLoom-portable-win-x64.zip` 存在；
- ZIP 解压后保留 exe 与资源目录，而不是单文件安装器。

- [x] **步骤 5：执行本地 GUI 烟雾测试**

从 `win-unpacked` 启动，使用小型测试书稿和假/测试模型入口确认：

1. 翻译运行页可打开；
2. 进度刷新；
3. 暂停与继续按钮切换；
4. 导出页可选择目录；
5. 导出后 TXT 和 EPUB 存在；
6. 页面无水平滚动条、空白占位和失效按钮。

- [x] **步骤 6：检查工作树与最终提交**

```powershell
git diff --check
git status --short
git log --oneline --decorate -10
```

预期：只剩有意变更；若验证修复尚未提交：

```powershell
git add translator-v5
git commit -m "fix(desktop): close full-book export regressions"
```
