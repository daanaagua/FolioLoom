# FolioLoom Desktop Alpha 实现计划

> **面向 AI 工作代理的工作者：** 必须使用 `executing-plans` 逐任务实现本计划。步骤使用复选框（`- [ ]`）记录进度。

**目标：** 在不改变 FolioLoom V5 翻译协议、SQLite 内容或模型配置的前提下，建立一个可启动的 Electron + React 本地文稿工作台；它能安全读取已经初始化的项目、显示真实状态并运行无模型 `doctor` 检查。

**架构：** React 渲染进程只调用预加载层定义的 `window.folioLoom` API。Electron 主进程保存会话与最近项目路径，通过 `DesktopProjectService` 从 `SourceLedger`、`doctorBook()` 和新加的 `LosslessBookStore.openReadOnly()` 组装可序列化状态。所有原文、SQLite 和模型配置均留在用户指定的位置；Alpha 不创建翻译运行、不写入书库、不读取密钥。

**技术栈：** Node 24 / TypeScript、Electron、electron-vite、React 19、Vitest + Testing Library、Electron Builder；现有 `node:sqlite`、`SourceLedger`、`doctorBook()` 与 V5 测试套件。

---

## 文件结构

```text
translator-v5/
├── electron.vite.config.ts                         # Electron/Vite 三进程入口和输出配置
├── electron-builder.yml                            # Windows x64 portable 构建元数据
├── tsconfig.desktop.json                           # 含 DOM/JSX 的桌面端类型检查配置
├── vitest.desktop.config.ts                         # React/jsdom 测试配置
├── package.json                                    # desktop 开发、构建、测试脚本和依赖
├── package-lock.json                               # npm 锁定依赖树
├── src/
│   ├── storage/lossless-book-store.ts               # 可验证的只读 SQLite 打开入口
│   └── desktop/
│       ├── contracts.ts                             # IPC 与 UI 使用的可序列化 DTO
│       ├── desktop-errors.ts                        # 稳定错误码及未知错误归一化
│       ├── desktop-project-service.ts               # manifest/store/doctor 的只读投影
│       ├── desktop-preferences.ts                   # 最近项目路径的 JSON 存取协议
│       ├── main/
│       │   ├── index.ts                             # BrowserWindow 生命周期与应用会话
│       │   └── ipc.ts                               # 文件选择、项目刷新、run 选择、doctor IPC
│       ├── preload/
│       │   ├── index.ts                             # 最小 contextBridge 暴露
│       │   └── folioloom-api.d.ts                   # 渲染层 Window 类型声明
│       └── renderer/
│           ├── index.html                           # 本地 React 入口
│           ├── src/
│           │   ├── main.tsx                         # React 根挂载
│           │   ├── App.tsx                          # 工作台状态机和页面路由
│           │   ├── App.test.tsx                     # 空态、项目态、doctor 态渲染测试
│           │   ├── types.ts                         # UI 内部状态与导航类型
│           │   ├── components/
│           │   │   ├── Sidebar.tsx                  # 五个工作区入口
│           │   │   ├── ProjectOverview.tsx          # “翻译中”、真实统计和工作流
│           │   │   ├── DoctorPanel.tsx              # doctor 结果与结构化失败提示
│           │   │   └── WorkspacePlaceholder.tsx     # 未接通区域的诚实空态
│           │   └── styles.css                        # 文稿工作台的暗色设计系统
│           └── public/folioloom-mark.svg            # 渲染器使用的矢量标记
├── desktop/resources/app-info.json                  # 未来 portable 资源边界说明
└── test/
    ├── lossless-book-store.test.ts                  # 增补只读打开的回归测试
    ├── desktop-project-service.test.ts              # 真实 V5 fixture 的状态投影测试
    ├── desktop-preferences.test.ts                  # 最近项目路径的持久化测试
    ├── desktop-ipc.test.ts                           # IPC 输入限制与路由契约测试
    └── desktop-build-config.test.ts                  # 构建脚本和 portable 元数据验证
.gitignore                                            # 忽略 Electron 构建产物与本地 release 目录
```

## 任务 1：为状态库建立不写入磁盘的读取入口

**文件：**

- 修改：`translator-v5/src/storage/lossless-book-store.ts:437-466`
- 修改：`translator-v5/test/lossless-book-store.test.ts:1-230`

- [x] **步骤 1：先写只读打开的失败测试**

在 `lossless-book-store.test.ts` 的 schema 测试后加入以下三个测试，并把 `existsSync` 加入现有 `node:fs` import。第一项确保不存在的路径不会被创建；第二项用已初始化数据库验证查询仍可用且 journal mode 未被改写；第三项验证写方法在只读连接上失败。

```ts
test("read-only store refuses a missing path without creating a database", () => {
  const path = fixturePath();
  assert.equal(existsSync(path), false);
  assert.throws(() => LosslessBookStore.openReadOnly(path), /unable to open database file|no such file/i);
  assert.equal(existsSync(path), false);
});

test("read-only store preserves schema and exposes run status", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  writable.close();
  const before = databaseShape(path);

  const readOnly = LosslessBookStore.openReadOnly(path);
  assert.equal(readOnly.listTranslationRuns()[0]?.runId, runId);
  assert.equal(readOnly.statusSummary(runId).totalWindows, 1);
  readOnly.close();

  assert.deepEqual(databaseShape(path), before);
});

test("read-only store rejects mutations", () => {
  const path = fixturePath();
  const writable = new LosslessBookStore(path);
  const runId = initialize(writable);
  writable.close();

  const readOnly = LosslessBookStore.openReadOnly(path);
  assert.throws(() => readOnly.claimWindow(runId, "window-0"), /readonly|read-only/i);
  readOnly.close();
});
```

- [x] **步骤 2：运行新测试，确认 API 尚不存在**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="read-only store"
```

预期：FAIL，报错包含 `LosslessBookStore.openReadOnly is not a function`。

- [x] **步骤 3：将构造逻辑拆为读写和只读两种明确模式**

保留公共构造器的默认读写行为，新增第三个内部模式参数与静态工厂。读写模式才允许 `mkdirSync`、空数据库 schema 初始化以及 `PRAGMA journal_mode=WAL`；只读模式直接以 `DatabaseSync(absolute, { readOnly: true })` 打开现有文件，验证现有 schema，但不写 WAL PRAGMA。两种模式均设置连接级 `foreign_keys=ON`；如果 SQLite 拒绝该 PRAGMA，关闭连接并重新抛出错误。

```ts
type LosslessStoreOpenMode = "read-write" | "read-only";

export class LosslessBookStore {
  readonly #database: DatabaseSync;
  readonly #faultInjector: FaultInjector | undefined;

  constructor(
    path: string,
    faultInjector?: FaultInjector,
    mode: LosslessStoreOpenMode = "read-write",
  ) {
    const absolute = resolve(requireNonempty(path, "database path"));
    this.#faultInjector = faultInjector;
    if (mode === "read-write") mkdirSync(dirname(absolute), { recursive: true });
    this.#database = new DatabaseSync(
      absolute,
      mode === "read-only" ? { readOnly: true } : undefined,
    );
    try {
      this.#database.exec("PRAGMA foreign_keys=ON");
      const userVersion = one<{ user_version: number }>(
        this.#database.prepare("PRAGMA user_version"),
      )?.user_version ?? 0;
      const tables = all<{ name: string }>(this.#database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)).map((row) => row.name);
      if (tables.length === 0 && userVersion === 0) {
        if (mode === "read-only") throw new Error("lossless book store does not exist");
        this.#initializeSchema();
      } else {
        this.#verifyExistingSchema(userVersion, tables);
      }
      if (mode === "read-write") this.#database.exec("PRAGMA journal_mode=WAL");
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  static openReadOnly(path: string): LosslessBookStore {
    return new LosslessBookStore(path, undefined, "read-only");
  }
}
```

该模式参数只由 `openReadOnly()` 传入；现有 `new LosslessBookStore(path, faultInjector)` 调用维持编译兼容。所有 GUI 代码只能调用静态工厂，不可传入第三参数。

- [x] **步骤 4：运行定向测试与原有 schema 测试**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="schema v2|read-only store"
npm.cmd run typecheck
```

预期：所有命名测试 PASS，原有 `schema v2 enables foreign keys and WAL` 仍看到 `journalMode: "wal"`。

- [x] **步骤 5：提交只读存储改动**

```powershell
git add translator-v5/src/storage/lossless-book-store.ts translator-v5/test/lossless-book-store.test.ts
git commit -m "feat: add read-only lossless store access"
```

## 任务 2：建立可测试的桌面项目投影与最近项目存储

**文件：**

- 创建：`translator-v5/src/desktop/contracts.ts`
- 创建：`translator-v5/src/desktop/desktop-errors.ts`
- 创建：`translator-v5/src/desktop/desktop-project-service.ts`
- 创建：`translator-v5/src/desktop/desktop-preferences.ts`
- 创建：`translator-v5/test/desktop-project-service.test.ts`
- 创建：`translator-v5/test/desktop-preferences.test.ts`

- [x] **步骤 1：先定义共享数据契约与失败测试**

`contracts.ts` 定义纯 JSON 类型，禁止将 `DatabaseSync`、`SourceLedger`、Error 对象或函数穿越 IPC。固定状态字面量如下：

```ts
export type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopError };

export interface DesktopError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DesktopRunSummary {
  runId: string;
  sourceVersion: string;
  modelId: string;
  status: string;
  progress: {
    totalWindows: number;
    pendingWindows: number;
    completedWindows: number;
    warningWindows: number;
    humanRequiredWindows: number;
    failedWindows: number;
  };
}

export interface DesktopProjectSnapshot {
  manifestPath: string;
  title: string;
  sourceLanguage: string;
  sourceChars: number;
  sourceVersion: string;
  glossaryPath?: string;
  store: {
    state: "not_found" | "ready" | "invalid";
    path?: string;
    error?: DesktopError;
  };
  runs: DesktopRunSummary[];
  selectedRunId?: string;
  runSelection: "none" | "selected" | "required";
}

export interface DesktopDoctorReport {
  sourceVersion: string;
  sourceChars: number;
  coveredChars: number;
  annotationCount: number;
  blockCount: number;
  windowCount: number;
  incidentCodes: string[];
  anomalyCount: number;
  glossary?: {
    path: string;
    totalTerms: number;
    matchedTerms: number;
    unmatchedTerms: number;
    unmatchedForms: string[];
  };
}
```

在 `desktop-project-service.test.ts` 创建真实临时 manifest、canonical source 和 V5 store fixture，并先写以下行为：

```ts
test("snapshot opens a manifest without a store", () => {
  const service = new DesktopProjectService();
  const result = service.snapshot({ manifestPath: fixture.manifestPath });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.store.state, "not_found");
    assert.equal(result.value.runSelection, "none");
    assert.equal(result.value.sourceLanguage, "en");
  }
});

test("snapshot uses the sole matching run and reports true counters", () => {
  const result = new DesktopProjectService().snapshot({
    manifestPath: fixture.manifestPath,
    storePath: fixture.storePath,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.selectedRunId, "run-desktop");
    assert.deepEqual(result.value.runs[0]?.progress, {
      totalWindows: 2, pendingWindows: 1, completedWindows: 1,
      warningWindows: 0, humanRequiredWindows: 0, failedWindows: 0,
    });
  }
});

test("snapshot requires an explicit selection for multiple matching runs", () => {
  const result = new DesktopProjectService().snapshot({
    manifestPath: fixture.manifestPath,
    storePath: fixture.storePath,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.runSelection, "required");
});

test("doctor calls no provider and preserves the glossary report", () => {
  let doctorCalls = 0;
  const service = new DesktopProjectService({
    doctor: (manifestPath, options, glossaryPath) => {
      doctorCalls += 1;
      return doctorBook(manifestPath, options, glossaryPath);
    },
  });
  const result = service.doctor({ manifestPath: fixture.manifestPath, glossaryPath: fixture.glossaryPath });
  assert.equal(result.ok, true);
  assert.equal(doctorCalls, 1);
  if (result.ok) assert.equal(result.value.coveredChars, result.value.sourceChars);
});
```

在 `desktop-preferences.test.ts` 写入临时 JSON 文件，验证保存与读取只保留绝对 `manifestPath`、可选 `storePath` 和可选 `runId`，损坏 JSON 返回 `undefined` 而不抛出。

- [x] **步骤 2：运行新增 Node 测试，确认模块不存在**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="snapshot opens|snapshot uses|snapshot requires|doctor calls|recent project"
```

预期：FAIL，模块 `../src/desktop/desktop-project-service.js` 与 `../src/desktop/desktop-preferences.js` 尚不存在。

- [x] **步骤 3：实现输入验证、投影与单文件偏好存储**

`desktop-errors.ts` 提供 `DesktopInputError`，并将 `SourceIntegrityError` 的 `code`、普通 Error 的 `message` 变成 `{ code, message, retryable: false }`。服务入口只接受绝对、存在的 `source_manifest.json` 和现有普通 `.db` 文件；`realpathSync` 后验证 basename/extension，拒绝目录、非 JSON manifest 与非 `.db` store。项目标题固定从 `basename(ledger.rawPath, extname(ledger.rawPath))` 推导，不猜测或改写作品名。

```ts
export interface DesktopProjectRequest {
  manifestPath: string;
  storePath?: string;
  runId?: string;
  glossaryPath?: string;
}

type Doctor = typeof doctorBook;

export class DesktopProjectService {
  readonly #doctor: Doctor;

  constructor(dependencies: { doctor?: Doctor } = {}) {
    this.#doctor = dependencies.doctor ?? doctorBook;
  }

  snapshot(request: DesktopProjectRequest): DesktopResult<DesktopProjectSnapshot> {
    try {
      const manifestPath = requireManifestPath(request.manifestPath);
      const ledger = SourceLedger.open(manifestPath);
      const candidateStorePath = request.storePath ?? discoverStorePath(manifestPath);
      const storePath = candidateStorePath === undefined ? undefined : requireStorePath(candidateStorePath);
      const discoveredGlossary = request.glossaryPath ?? adjacentGlossaryPath(manifestPath);
      if (storePath === undefined) return ok(noStoreSnapshot(ledger, discoveredGlossary));

      const store = LosslessBookStore.openReadOnly(storePath);
      try {
        const allRuns = store.listTranslationRuns();
        const runs = allRuns.filter((run) => run.sourceVersion === ledger.sourceVersion);
        return ok(snapshotFromLedgerAndRuns(ledger, storePath, allRuns, runs, request.runId, discoveredGlossary, store));
      } finally {
        store.close();
      }
    } catch (error) {
      return fail(toDesktopError(error));
    }
  }

  doctor(request: Pick<DesktopProjectRequest, "manifestPath" | "glossaryPath">): DesktopResult<DesktopDoctorReport> {
    try {
      const manifestPath = requireManifestPath(request.manifestPath);
      const glossaryPath = request.glossaryPath ?? adjacentGlossaryPath(manifestPath);
      const report = this.#doctor(manifestPath, {}, glossaryPath);
      return ok(projectDoctorReport(report, glossaryPath));
    } catch (error) {
      return fail(toDesktopError(error));
    }
  }
}
```

`projectDoctorReport()` 将 `report.sourceAnomalies.findings` 的 `count` 求和为 `anomalyCount`，并把 glossary 映射成 `totalTerms`、`matchedTerms`、`unmatchedTerms` 与 `terms.flatMap((term) => term.unmatchedForms)`；不要杜撰“导入数量”字段。`adjacentGlossaryPath()` 只在 `dirname(manifestPath)/glossary.json` 是普通文件时返回路径。`discoverStorePath()` 只检查两个固定位置：`dirname(manifestPath)/artifacts/folioloom/book.db`，然后是 `dirname(manifestPath)/book.db`；两者均不存在时不猜测其它数据库。多个与 source version 匹配的 run 令 `runSelection` 为 `required`，除非请求中的 `runId` 存在且匹配；store 没有任何 run 时返回 `store.state: "ready"` 与 `runSelection: "none"`；store 有 run 但没有 source version 匹配 run 时返回 `store.state: "invalid"` 和稳定错误 `SOURCE_VERSION_MISMATCH`。

`DesktopPreferences` 使用 `{ schema: "folioloom-desktop-preferences-1", recent?: DesktopProjectRequest }`。保存时先创建 Electron userData 下的父目录，再写入同目录临时文件并 `renameSync`；读取使用 `readFileSync`，遇到 JSON 解析错误、未知 schema 或缺失 manifest 字段时返回 `undefined`。

- [x] **步骤 4：运行服务、偏好和全量 V5 测试**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="snapshot opens|snapshot uses|snapshot requires|doctor calls|recent project|read-only store"
npm.cmd test
npm.cmd run typecheck
```

预期：全部 PASS；`doctorBook()` 的报告仍有 `modelCallsAllowed: false`，测试不创建 provider。

- [x] **步骤 5：提交桌面领域层**

```powershell
git add translator-v5/src/desktop translator-v5/test/desktop-project-service.test.ts translator-v5/test/desktop-preferences.test.ts
git commit -m "feat: add read-only desktop project service"
```

## 审查后回归修正：只读快照与自动发现路径

- [x] **步骤 1：复现并选择安全的 SQLite 读取机制**

在 Node 24 中，`DatabaseSync(path, { readOnly: true })` 仍会在 WAL 数据库旁创建 `-wal` 与 `-shm`。SQLite URI 的 `immutable=1` 虽可避免这些副作用，但不会读取尚在 WAL 中的新状态，因此不作为项目状态读取机制。

- [x] **步骤 2：把 `openReadOnly()` 改为外部稳定快照**

只读入口在系统临时目录复制 `.db` 与可选 `-wal`，不复制 `-shm`；复制前后比较 source `.db` 与 `-wal` 的 `size` 和 `mtime`，变化时清理快照并有限重试。仍不稳定时抛出带 `LOSSLESS_READ_SNAPSHOT_UNSTABLE` code 的结构化错误。SQLite 只会在临时副本旁重建自己的 sidecar，`close()` 后删除整个临时目录。

- [x] **步骤 3：收紧自动发现的规范路径**

自动发现先在 `realpath` 后重复 `requireStorePath()` 校验，再拒绝任何落到 manifest 项目目录之外的 reparse point；显式选择的已有 `.db` 路径保留原行为。

- [x] **步骤 4：回归验证与提交审查修复**

运行只读 WAL、最新 WAL 状态、Windows junction、显式外部数据库的定向测试，再运行全量 V5 测试和类型检查；作为独立 `fix` 提交。

## 任务 3：接入 Electron 主进程、最小预加载 API 与受限 IPC

**文件：**

- 修改：`translator-v5/package.json`
- 修改：`translator-v5/package-lock.json`
- 创建：`translator-v5/electron.vite.config.ts`
- 创建：`translator-v5/tsconfig.desktop.json`
- 创建：`translator-v5/vitest.desktop.config.ts`
- 创建：`translator-v5/src/desktop/main/index.ts`
- 创建：`translator-v5/src/desktop/main/ipc.ts`
- 创建：`translator-v5/src/desktop/main/runtime.ts`
- 创建：`translator-v5/src/desktop/preload/index.ts`
- 创建：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 创建：`translator-v5/src/desktop/renderer/index.html`（仅安全窗口入口；任务 4 扩展内容）
- 创建：`translator-v5/test/desktop-ipc.test.ts`
- 创建：`translator-v5/test/desktop-main-security.test.ts`
- 创建：`translator-v5/test/desktop-toolchain.test.ts`
- 创建：`translator-v5/test/verify-desktop-build.test.ts`

- [x] **步骤 1：安装桌面运行时与测试基础设施**

在 `translator-v5` 内安装 Electron、React、Vite 和测试工具；这一步不安装 Builder，也不生成桌面产物：

```powershell
Set-Location translator-v5
npm.cmd install --save-dev electron@43.2.0 electron-vite@5.0.0 vite@7.3.6 @vitejs/plugin-react@5.2.0 vitest@4.1.10 jsdom@29.1.1 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 @types/react@19.2.17 @types/react-dom@19.2.3
npm.cmd install react@19.2.8 react-dom@19.2.8
```

兼容性修正：`electron-vite@5.0.0` 的 peer dependency 只接受 Vite 5–7，而 `@vitejs/plugin-react@6.0.4` 只接受 Vite 8。因此锁定可共同满足 peer 的 `vite@7.3.6` 与 `@vitejs/plugin-react@5.2.0`，不用 `--legacy-peer-deps` 绕过解析。

向 `package.json` 添加：

```json
{
  "scripts": {
    "desktop:dev": "electron-vite dev",
    "desktop:build": "electron-vite build && node --test --import tsx test/verify-desktop-build.test.ts",
    "desktop:typecheck": "tsc --noEmit -p tsconfig.desktop.json",
    "desktop:test": "node --test --import tsx test/desktop-*.test.ts && vitest run --config vitest.desktop.config.ts --passWithNoTests"
  }
}
```

创建 `tsconfig.desktop.json`，它扩展 `tsconfig.json` 并覆盖 `compilerOptions` 为 `{"noEmit": true, "jsx": "react-jsx", "lib": ["ES2024", "DOM", "DOM.Iterable"], "types": ["node", "electron", "vitest/globals"]}`，`include` 为 `src/desktop/**/*.ts`、`src/desktop/**/*.tsx` 和 `test/desktop-*.test.ts`。创建 `vitest.desktop.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/desktop/**/*.test.ts", "src/desktop/**/*.test.tsx"],
  },
});
```

- [x] **步骤 2：写独立于 Electron 运行时的 IPC 工厂测试**

把实际 Electron `ipcMain.handle()` 注册包在可注入的 `registerDesktopIpc(deps)` 中。测试用假对话框、假会话和 `Map<string, Handler>` 代替 Electron，对输入表面做如下断言：

```ts
test("IPC only registers the desktop allowlist", () => {
  const handlers = registerFixtureHandlers();
  assert.deepEqual([...handlers.keys()].sort(), [
    "folioloom:choose-project",
    "folioloom:choose-store",
    "folioloom:doctor",
    "folioloom:refresh-project",
    "folioloom:select-run",
  ]);
});

test("select-run accepts only a run id from the active snapshot", async () => {
  const handlers = registerFixtureHandlers({ activeRunIds: ["run-a"] });
  const result = await handlers.get("folioloom:select-run")!({}, "run-a");
  assert.equal(result.ok, true);
  const rejected = await handlers.get("folioloom:select-run")!({}, "..\\outside");
  assert.equal(rejected.ok, false);
});

test("choose-store rejects a directory and a non-db selection", async () => {
  const directoryResult = await registerFixtureHandlers({ pickedStore: fixture.directory })
    .get("folioloom:choose-store")!({});
  assert.equal(directoryResult.ok, false);
  const textResult = await registerFixtureHandlers({ pickedStore: fixture.textPath })
    .get("folioloom:choose-store")!({});
  assert.equal(textResult.ok, false);
});
```

- [x] **步骤 3：运行 IPC 测试，确认入口不存在**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="IPC only registers|select-run accepts|choose-store rejects"
```

预期：FAIL，无法解析 `../src/desktop/main/ipc.js`。

- [x] **步骤 4：实现主进程会话与严格 API**

`electron.vite.config.ts` 明确给出三个入口，避免 electron-vite 从传统 `src/main`、`src/preload` 路径猜测文件：

```ts
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(root, "src/desktop/main/index.ts") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(root, "src/desktop/preload/index.ts") } },
  },
  renderer: {
    root: resolve(root, "src/desktop/renderer"),
    plugins: [react()],
    build: { rollupOptions: { input: resolve(root, "src/desktop/renderer/index.html") } },
  },
});
```

`main/index.ts` 先以 `dirname(fileURLToPath(import.meta.url))` 计算当前编译目录，再以如下配置创建唯一窗口，不启用 renderer Node 能力，不允许远程模块，也不加载任意外部 URL：

```ts
const window = new BrowserWindow({
  width: 1440,
  height: 920,
  minWidth: 1100,
  minHeight: 720,
  backgroundColor: "#101318",
  title: "FolioLoom",
  webPreferences: {
    preload: preloadEntryPath(currentDirectory),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
```

`preloadEntryPath()` 固定指向 electron-vite 实际产出的 `../preload/index.mjs`，并由构建后断言验证文件存在。仅当 `app.isPackaged === false` 且 `ELECTRON_RENDERER_URL` 是无凭据的 loopback `http://localhost`、`127.0.0.1` 或 `[::1]` URL 时才加载开发 renderer；所有其他情况（包括打包环境中的任意环境变量）只加载本地 `../renderer/index.html`。每个窗口在 `will-navigate` 时阻止导航、拒绝全部 `window.open`，并将自身 `webContents.id` 与目标 renderer URL 登记为可信 IPC 来源。应用的当前 `DesktopProjectRequest` 放在主进程闭包中；`DesktopPreferences` 的位置为 `join(app.getPath("userData"), "desktop-preferences.json")`。启动时若最近 manifest 已不存在，清除偏好并显示空项目，而不是向 renderer 发出路径错误。

`ipc.ts` 的对话框过滤器必须是：

```ts
const manifestFilter = [{ name: "FolioLoom 项目", extensions: ["json"] }];
const storeFilter = [{ name: "FolioLoom 状态库", extensions: ["db"] }];
```

选中 manifest 后主进程再以 `basename(path) === "source_manifest.json"` 验证；不能通过改名的任意 JSON。选择 store 后执行 `requireStorePath()`。只允许五个固定 channel：

```ts
export interface FolioLoomDesktopApi {
  chooseProject(): Promise<DesktopResult<DesktopProjectSnapshot>>;
  chooseStore(): Promise<DesktopResult<DesktopProjectSnapshot>>;
  refreshProject(): Promise<DesktopResult<DesktopProjectSnapshot>>;
  selectRun(runId: string): Promise<DesktopResult<DesktopProjectSnapshot>>;
  runDoctor(): Promise<DesktopResult<DesktopDoctorReport>>;
}
```

`registerDesktopIpc()` 的每个固定 handler 先检查调用 event：sender 必须是已登记窗口、`senderFrame.parent === null`（主 frame）且 URL 与该窗口的目标 renderer 一致；否则在触及项目服务或对话框前返回 `DESKTOP_UNTRUSTED_IPC`。预加载层逐个包装 `ipcRenderer.invoke()`，不导出 `ipcRenderer`、`fs`、`process`、`require` 或泛用 `invoke(channel, payload)`。`folioloom-api.d.ts` 将该接口附到 `Window`：

```ts
declare global {
  interface Window {
    folioLoom: FolioLoomDesktopApi;
  }
}
export {};
```

- [x] **步骤 5：运行 IPC 与领域层测试**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="IPC only registers|select-run accepts|choose-store rejects|snapshot opens|read-only store"
npm.cmd run desktop:test
npm.cmd run typecheck
npm.cmd run desktop:typecheck
npm.cmd run desktop:build
```

预期：PASS；`desktop:test` 先运行 `test/desktop-*.test.ts`，再运行可为空的 renderer Vitest 套件；测试中不存在可调用的任意 channel，也没有 renderer 端文件系统入口；`desktop:build` 实际生成 `out/preload/index.mjs` 与 `out/renderer/index.html`。

- [x] **步骤 6：提交 Electron 安全边界与基础工具链**

```powershell
git add translator-v5/package.json translator-v5/package-lock.json translator-v5/electron.vite.config.ts translator-v5/tsconfig.desktop.json translator-v5/vitest.desktop.config.ts translator-v5/src/desktop/main translator-v5/src/desktop/preload translator-v5/src/desktop/renderer/index.html translator-v5/test/desktop-ipc.test.ts translator-v5/test/desktop-main-security.test.ts translator-v5/test/desktop-toolchain.test.ts translator-v5/test/verify-desktop-build.test.ts
git commit -m "feat: add secure desktop IPC boundary"
```

### 审查修复（2026-07-22）

- [x] 复现并锁定 electron-vite 产出 `.mjs` preload、无 renderer test suite 退出 1，以及缺少显式 renderer HTML input 的构建失败。
- [x] 以纯函数和注入式 IPC 测试覆盖 preload 路径、打包环境远程 URL、远程导航、`window.open`、外部 IPC event 与构建产物。
- [x] 提交审查修复。

## 任务 4：实现“翻译中”文稿工作台与可验证的渲染状态

**文件：**

- 修改：`translator-v5/src/desktop/renderer/index.html`
- 创建：`translator-v5/src/desktop/renderer/src/main.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/types.ts`
- 创建：`translator-v5/src/desktop/renderer/src/App.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/Sidebar.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/ProjectOverview.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/DoctorPanel.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/WorkspacePlaceholder.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/styles.css`
- 创建：`translator-v5/src/desktop/renderer/public/folioloom-mark.svg`
- 创建：`translator-v5/vitest.desktop.config.ts`

- [x] **步骤 1：写渲染层行为测试**

在 `App.test.tsx` 用 `vi.stubGlobal("window", ...)` 或 `Object.defineProperty(window, "folioLoom", ...)` 注入固定 API。验证空态、真实项目态和 doctor 失败态：

```tsx
test("empty workbench asks the user to open an initialized project", () => {
  render(<App api={emptyApi} />);
  expect(screen.getByRole("button", { name: "打开项目" })).toBeTruthy();
  expect(screen.getByText("尚未打开项目")).toBeTruthy();
});

test("project overview renders 翻译中 and real counters without a fake percentage", async () => {
  render(<App api={projectApi} />);
  await userEvent.click(screen.getByRole("button", { name: "打开项目" }));
  expect(await screen.findByRole("heading", { name: "翻译中" })).toBeTruthy();
  expect(screen.getByText("已完成 1 / 4 窗口")).toBeTruthy();
  expect(screen.queryByText(/%/)).toBeNull();
});

test("doctor failure keeps a structured next step visible", async () => {
  render(<App api={doctorFailureApi} />);
  await userEvent.click(screen.getByRole("button", { name: "运行检查" }));
  expect(await screen.findByText("CANONICAL_HASH_MISMATCH")).toBeTruthy();
  expect(screen.getByText("请恢复与 manifest 匹配的 canonical 原文后重试")).toBeTruthy();
});

test("inactive workspace says it is unavailable instead of exposing a fake action", async () => {
  render(<App api={projectApi} />);
  await userEvent.click(screen.getByRole("button", { name: "审阅队列" }));
  expect(await screen.findByText("将在运行控制阶段接入")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "开始审阅" })).toBeNull();
});
```

- [x] **步骤 2：运行渲染测试，确认应用入口不存在**

运行：

```powershell
Set-Location translator-v5
npx.cmd vitest run --config vitest.desktop.config.ts
```

预期：FAIL，`src/desktop/renderer/src/App.tsx` 尚不存在。

- [x] **步骤 3：实现面向阅读的工作台，而不是产品幻灯片**

`App.tsx` 维护以下内部状态：`activeWorkspace`、`snapshot`、`doctorResult`、`busyAction`。它在初始化时调用 `api.refreshProject()`；空项目时只显示打开入口，成功时默认选中“项目概览”。渲染器中不保存访问路径到 localStorage，不读取 API Key，不访问 Node API。

`Sidebar.tsx` 固定显示五个按钮：`项目概览`、`翻译运行`、`术语与记忆`、`审阅队列`、`导出`。按钮使用 `aria-current="page"` 标识当前页。`ProjectOverview.tsx` 只根据 `DesktopProjectSnapshot` 的 `runSelection` 和 `runs` 显示状态：

```tsx
<h1>翻译中</h1>
<p className="book-title">{snapshot.title}</p>
<dl className="metadata">
  <div><dt>源语言</dt><dd>{snapshot.sourceLanguage}</dd></div>
  <div><dt>原文长度</dt><dd>{formatNumber(snapshot.sourceChars)} 字</dd></div>
  <div><dt>状态库</dt><dd>{storeLabel(snapshot.store)}</dd></div>
</dl>
```

选择 `runSelection === "required"` 时显示每个 run 的按钮，调用 `api.selectRun(runId)`；单一 run 显示真实窗口统计，格式固定为 `已完成 {completedWindows} / {totalWindows} 窗口`、`待处理 {pendingWindows}`、`需人工查看 {humanRequiredWindows}`。没有状态库时显示“尚未开始翻译”，而不显示百分比。

`DoctorPanel.tsx` 的成功态显示 `coveredChars / sourceChars`、结构块数、逻辑窗口数、异常代码、术语表路径和导入统计；失败态显示稳定 error code，并按已知 code 映射给出准确下一步。`CANONICAL_HASH_MISMATCH`、`RAW_HASH_MISMATCH`、`MANIFEST_INVALID` 分别映射为恢复对应原文、检查原始文件、检查 manifest JSON；其它错误显示原始信息和“重新选择项目”。

`styles.css` 采用本地变量，不从网络加载字体：

```css
:root {
  color-scheme: dark;
  --canvas: #101318;
  --panel: #171c23;
  --panel-raised: #1d2430;
  --ink: #edf2f7;
  --muted: #9ca9ba;
  --teal: #68d2bf;
  --violet: #a99bff;
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
}

.workbench { min-height: 100vh; display: grid; grid-template-columns: 276px minmax(0, 1fr); }
.book-title, h1 { font-family: Georgia, "Noto Serif SC", serif; }
.status-card { border: 1px solid color-mix(in srgb, var(--teal), transparent 68%); border-radius: 18px; }
```

界面不出现已删除的引语、“织进中文”或任何伪造的完成比例。未接通页面统一使用 `WorkspacePlaceholder`，只显示工作区用途、已有只读数据和不可用说明。

- [x] **步骤 4：运行 renderer 测试、桌面类型检查与核心测试**

运行：

```powershell
Set-Location translator-v5
npm.cmd run desktop:test
npm.cmd run desktop:typecheck
npm.cmd test
```

预期：PASS；渲染测试断言“翻译中”存在，`%` 不存在，且所有现有 V5 Node 测试通过。

- [x] **步骤 5：提交渲染工作台**

```powershell
git add translator-v5/src/desktop/renderer translator-v5/vitest.desktop.config.ts
git commit -m "feat: add folioloom desktop workbench"
```

## 任务 5：锁定开发构建、便携元数据和人工烟雾验证

**文件：**

- 修改：`translator-v5/package.json`
- 修改：`translator-v5/package-lock.json`
- 创建：`translator-v5/electron-builder.yml`
- 创建：`translator-v5/desktop/resources/app-info.json`
- 创建：`translator-v5/test/desktop-build-config.test.ts`
- 修改：`.gitignore`
- 创建：`translator-v5/README.md`
- 修改：`README.md:55-115`

- [x] **步骤 1：先写构建配置的文件级验证测试**

在 `translator-v5/test/desktop-build-config.test.ts` 读取 package JSON、Builder YAML 和 resource JSON，不启动 Electron。断言脚本、构建目标和资源边界完整：

```ts
test("desktop package scripts and portable metadata stay explicit", () => {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["desktop:dev"], "electron-vite dev");
  assert.equal(pkg.scripts["desktop:build"], "electron-vite build && node --test --import tsx test/verify-desktop-build.test.ts");
  assert.equal(pkg.scripts["desktop:test"], "node --test --import tsx test/desktop-*.test.ts && vitest run --config vitest.desktop.config.ts --passWithNoTests");
  assert.equal(pkg.scripts["desktop:dist"], "npm run desktop:build && electron-builder --win portable --x64");
  const builder = readFileSync(builderPath, "utf8");
  assert.match(builder, /target:\s*portable/);
  assert.match(builder, /arch:\s*x64/);
  const resource = JSON.parse(readFileSync(resourcePath, "utf8"));
  assert.equal(resource.apiKeyPolicy, "never-packaged");
  assert.equal(resource.projectDataPolicy, "user-selected");
});
```

- [x] **步骤 2：运行构建配置测试，确认尚未配置桌面脚本**

运行：

```powershell
Set-Location translator-v5
npm.cmd test -- --test-name-pattern="desktop package scripts"
```

预期：FAIL，`desktop:dist` 未定义且 Builder 配置文件不存在。

- [x] **步骤 3：添加 Builder 依赖、portable 命令与元数据**

以 `npm.cmd install --save-dev` 安装 Builder，并让 npm 更新 `package-lock.json`：

```powershell
npm.cmd install --save-dev electron-builder@26.15.3
```

然后在 `package.json` 的已有桌面脚本旁添加：

```json
{
  "scripts": {
    "desktop:dist": "npm run desktop:build && electron-builder --win portable --x64"
  }
}
```

`electron-builder.yml` 使用此固定内容：

```yaml
appId: io.folioloom.desktop
productName: FolioLoom
directories:
  output: release
files:
  - out/**/*
  - package.json
extraResources:
  - from: desktop/resources
    to: folioloom
win:
  target:
    - target: portable
      arch:
        - x64
artifactName: FolioLoom-portable-win-x64.${ext}
```

`desktop/resources/app-info.json` 使用下列实际应用边界：

```json
{
  "schema": "folioloom-desktop-resource-1",
  "apiKeyPolicy": "never-packaged",
  "projectDataPolicy": "user-selected",
  "translationWritePolicy": "disabled-in-alpha"
}
```

根 README 的桌面段落写清一条启动命令：

```powershell
Set-Location translator-v5
npm.cmd install
npm.cmd run desktop:dev
```

文档同时写明开发 Alpha 只读取既有 V5 `source_manifest.json` 与可选 `book.db`，不打包 API Key、不创建译文、不执行 `desktop:dist`。

在根 `.gitignore` 的 V5 TypeScript 段落加入两个精确规则，防止本机构建输出进入提交：

```gitignore
translator-v5/out/
translator-v5/release/
```

- [x] **步骤 4：运行自动验证**

运行：

```powershell
Set-Location translator-v5
npm.cmd run desktop:test
npm.cmd run desktop:typecheck
npm.cmd test
npm.cmd run typecheck
npm.cmd run desktop:build
```

预期：五个命令均 PASS，`out/main/index.js`、`out/preload/index.mjs` 和 `out/renderer/index.html` 存在。

### 人工烟雾检查（与工作台集成收尾）

- [ ] 使用已完成的桌面工作台选择真实 `source_manifest.json` 与可选 `book.db`，完成下列交互验收后退出应用，不保留开发服务器或额外浏览器窗口。

随后运行：

```powershell
npm.cmd run desktop:dev
```

人工验收：选择真实 `source_manifest.json` 后能看到原文长度和源语言；选择真实 V5 `book.db` 后能看到 run 状态；点击“运行检查”只出现 coverage/结构/术语报告；切换四个未接通工作区不会暴露写入按钮；关闭应用后再次启动会恢复最近项目或明确回到空态。完成检查后退出 Electron，不保留开发服务器或额外浏览器窗口。

- [x] **步骤 5：提交构建配置、文档与验证完成状态**

```powershell
git add .gitignore translator-v5/package.json translator-v5/package-lock.json translator-v5/tsconfig.desktop.json translator-v5/electron-builder.yml translator-v5/desktop/resources/app-info.json translator-v5/test/desktop-build-config.test.ts translator-v5/README.md README.md
git commit -m "build: configure folioloom desktop alpha"
git status --short
```

预期：工作树除本任务明确生成的验证产物外没有未提交代码；`release/` 与 `out/` 保持被 `.gitignore` 忽略。

### 最终审查修复（2026-07-22）

- [x] 以失败测试锁定 `package.json` 缺少 Electron 主入口的问题，并声明 `"main": "out/main/index.js"`。
- [x] 使用 `electron-builder --win --x64 --dir` 验证未压缩应用可构建，再启动 `FolioLoom.exe` 确认窗口标题为“FolioLoom · 翻译中”；未生成 portable EXE/ZIP 发布物。

## 任务 6：将 Windows 系统控制按钮融入暗色工作台

**文件：**

- 修改：`translator-v5/src/desktop/main/runtime.ts`
- 修改：`translator-v5/src/desktop/main/index.ts`
- 修改：`translator-v5/test/desktop-main-security.test.ts`
- 创建：`translator-v5/src/desktop/renderer/src/components/WindowTitlebar.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`

- [x] **步骤 1：先写窗口外观与渲染标题栏的失败测试**

在 `desktop-main-security.test.ts` 断言纯函数 `desktopWindowChrome()` 返回 `applicationMenu: null`、`titleBarStyle: "hidden"`、42px 暗色 `titleBarOverlay` 与 `autoHideMenuBar: true`。在 `App.test.tsx` 断言页面存在“FolioLoom · 翻译中”的 `banner`，且不出现 `File / Edit / View / Window`。

- [x] **步骤 2：运行定向测试并确认因 API 与标题栏缺失而失败**

运行：

```powershell
Set-Location translator-v5
node --test --import tsx test/desktop-main-security.test.ts
npx.cmd vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/App.test.tsx
```

- [x] **步骤 3：实现 Electron 原生 overlay 与 42px 拖拽栏**

`desktopWindowChrome()` 返回唯一窗口外观契约；`index.ts` 将其 `applicationMenu` 交给 `Menu.setApplicationMenu()`，并把 `windowOptions` 展开到 `BrowserWindow`。不使用 `frame: false`，不新增窗口控制 IPC。渲染层新增无交互的 `WindowTitlebar`，工作台改为标题栏/侧栏/主内容三个 grid area；标题栏使用 `-webkit-app-region: drag`，右侧为系统按钮保留空间。

- [x] **步骤 4：验证定向测试、完整桌面测试、类型检查与 production build**

```powershell
npm.cmd run desktop:test
npm.cmd run desktop:typecheck
npm.cmd test
npm.cmd run typecheck
npm.cmd run desktop:build
```

- [x] **步骤 5：启动本地窗口，确认暗色标题栏、系统按钮和菜单移除后提交**

启动 production build，确认窗口仍能拖动、最小化、最大化和关闭，且不显示白色标题栏或默认应用菜单；退出全部 FolioLoom 进程后提交。

## 计划自检

- **规格覆盖：** 任务 1 实现真实只读 SQLite；任务 2 读取 manifest、真实 run 与无模型 doctor；任务 3 限制 Electron 安全边界和文件选择；任务 4 实现“翻译中”的文稿工作台、真实数据及诚实空态；任务 5 配置 Windows x64 portable 元数据、开发命令、自动验证和人工验收；任务 6 使用原生 overlay 融合窗口控制并移除默认菜单。
- **非目标保护：** 所有任务都不引入模型 provider、API Key 读取、翻译运行、SQLite 写操作、知识库编辑、Python 导入侧车、自动更新或发布二进制。
- **类型一致性：** 渲染器唯一依赖 `FolioLoomDesktopApi` 和 `DesktopResult<T>`；IPC、项目服务和测试使用同一份 `DesktopProjectSnapshot`、`DesktopDoctorReport`、`DesktopProjectRequest` 声明；`LosslessBookStore.openReadOnly()` 是唯一桌面状态库入口。
- **占位符检查：** 本计划的文件、函数、状态字面量、测试命令、Builder 配置、文案和提交信息均已明确，不依赖未命名的实现步骤。
