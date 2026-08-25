# FolioLoom 诊断导出、DeepSeek V4 与拉丁语种支持实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 发布 FolioLoom 1.4.0：提供严格隐私模式的可导出诊断包，限制 DeepSeek 为 V4 Flash/Pro，并让德语、法语和西班牙语在结构识别、语言检测和术语候选链路中得到可验证支持。

**架构：** Electron 主进程新增有界 JSONL 诊断记录器和单文件安全报告生成器，IPC 只记录通道、阶段、结果与脱敏错误，不记录请求载荷。DeepSeek 模型约束集中在 provider registry，桌面偏好和 CLI 共用同一验证边界；拉丁语种改动集中在语言画像、结构注释器与知识投影层，普通词分类只作为负缓存而不进入翻译提示词。

**技术栈：** TypeScript、Electron、React、node:test、Vitest、SQLite、electron-builder

---

## 文件结构

- 创建 `src/desktop/desktop-diagnostics.ts`：诊断事件类型、双重脱敏、JSONL 轮转、错误链序列化、诊断报告构建和最终安全扫描。
- 修改 `src/desktop/contracts.ts`：增加诊断导出 DTO、原文语言覆盖请求和桌面 API 契约。
- 修改 `src/desktop/main/ipc.ts`：在可信 IPC 边界统一记录操作；注册复制摘要与导出诊断通道；支持保存对话框和语言覆盖。
- 修改 `src/desktop/main/index.ts`：创建诊断记录器，接入进程异常、试译/整本进度、剪贴板和保存对话框。
- 修改 `src/desktop/preload/index.ts`、`src/desktop/preload/folioloom-api.d.ts`：只暴露无原始日志目录的窄诊断 API。
- 修改 `src/desktop/renderer/src/App.tsx`、`components/Onboarding.tsx`、`components/Sidebar.tsx`、`styles.css`：增加全局诊断入口、错误面板按钮、反馈和原文语言覆盖选择。
- 修改 `src/providers/presets.ts`、`src/providers/registry.ts`：集中定义 DeepSeek V4 模型白名单和 `DEEPSEEK_MODEL_RETIRED` 错误。
- 修改 `src/desktop/desktop-model-service.ts`：废弃旧 DeepSeek 偏好并清除旧 probe。
- 修改 `src/language/profiles.ts`、`src/source/language-detector.ts`、`src/source/structure-annotator.ts`：增强德法西语言检测和有布局证据的章节标题识别。
- 修改 `src/knowledge/knowledge-store.ts`、`src/knowledge/translation-knowledge-projection.ts`、`src/fullbook/book-runner.ts`：把普通词裁决持久化为 `contextual` 负缓存，并禁止进入翻译上下文。
- 修改 `package.json`、`package-lock.json`、`desktop/resources/app-info.json`、`README.md`：统一 1.4.0 版本和使用说明。
- 创建/修改测试：`test/desktop-diagnostics.test.ts`、`test/desktop-ipc.test.ts`、`test/desktop-model-service.test.ts`、`test/desktop-preferences.test.ts`、`test/provider-registry.test.ts`、`test/language-profile.test.ts`、`test/source-importer.test.ts`、`test/book-runner.test.ts`、`test/translation-request.test.ts`、`src/desktop/renderer/src/App.test.tsx`。

### 任务 1：安全诊断核心

**文件：**
- 创建：`src/desktop/desktop-diagnostics.ts`
- 创建：`test/desktop-diagnostics.test.ts`
- 修改：`src/desktop/desktop-errors.ts`

- [x] **步骤 1：编写诊断脱敏、轮转、错误链和最终拒绝测试**

```ts
test("diagnostic report excludes credentials, manuscript text, translations and private paths", () => {
  const logger = new DesktopDiagnosticLogger({
    directory,
    appVersion: "1.4.0",
    pathAliases: { userData, app: appRoot, temp: tempRoot },
  });
  logger.failure({
    event: "trial.failed",
    operationId: "op-1",
    channel: "folioloom:start-trial",
    phase: "translating",
    error: new Error(`Bearer sk-private ${projectRoot}\\source.txt`),
    projectDirectory: projectRoot,
  });
  const report = logger.buildReport(fixtureContext());
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /sk-private|source paragraph|translated paragraph|C:\\Users/u);
  assert.match(serialized, /<project>/);
});

test("diagnostic logger rotates at the configured byte limit and retains at most four files", () => {
  const logger = new DesktopDiagnosticLogger({
    directory,
    appVersion: "1.4.0",
    maximumFileBytes: 512,
    maximumFiles: 4,
  });
  for (let index = 0; index < 40; index += 1) {
    logger.event({ event: "probe.step", operationId: `op-${index}`, outcome: "completed" });
  }
  assert.ok(readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length <= 4);
});

test("final sensitive scanner refuses an unsafe report before writing", () => {
  assert.throws(
    () => writeDesktopDiagnosticReport(path, unsafeReportWithApiKey()),
    /DIAGNOSTIC_PRIVACY_CHECK_FAILED/u,
  );
  assert.equal(existsSync(path), false);
});
```

- [x] **步骤 2：运行测试并确认因模块不存在而失败**

运行：`node --test --import tsx test/desktop-diagnostics.test.ts`

预期：FAIL，报告无法解析 `src/desktop/desktop-diagnostics.ts`。

- [x] **步骤 3：实现最小诊断记录器和报告生成器**

```ts
export class DesktopDiagnosticLogger {
  event(input: DesktopDiagnosticEventInput): void {
    try {
      this.#append(boundedEvent(sanitizeEvent(input, this.#aliases)));
    } catch {
      // 诊断永远不能改变翻译控制流。
    }
  }

  failure(input: DesktopDiagnosticFailureInput): void {
    this.event({
      ...input,
      severity: "error",
      outcome: "failed",
      error: serializeDiagnosticError(input.error, input.phase, this.#aliases),
    });
  }

  buildReport(context: DesktopDiagnosticContext): DesktopDiagnosticReport {
    return sanitizeAndValidateReport({
      manifest: { schema: "folioloom-diagnostics-1", generatedAt: this.#now(), appVersion: this.#appVersion },
      environment: this.#environment,
      model: context.model,
      source: context.source,
      operation: latestFailedOperation(this.#readEvents()),
      runSummary: context.runSummary,
      events: this.#readEvents(),
      privacy: {
        excluded: ["api_keys", "authorization", "source_text", "translation_text", "prompts", "raw_responses", "private_paths"],
      },
    });
  }
}
```

实现固定默认边界：2 MiB/文件、4 文件、16 KiB/事件、5 层 cause；最终写入采用同目录临时文件加原子重命名，安全扫描失败时不留下目标文件。

- [x] **步骤 4：运行诊断与错误映射测试**

运行：`node --test --import tsx test/desktop-diagnostics.test.ts test/desktop-errors.test.ts`

预期：PASS，且没有包含模拟密钥或私人路径的失败输出。

- [x] **步骤 5：提交诊断核心**

```bash
git add src/desktop/desktop-diagnostics.ts src/desktop/desktop-errors.ts test/desktop-diagnostics.test.ts
git commit -m "feat: add private desktop diagnostics core"
```

### 任务 2：IPC、主进程与 GUI 诊断入口

**文件：**
- 修改：`src/desktop/contracts.ts`
- 修改：`src/desktop/main/ipc.ts`
- 修改：`src/desktop/main/index.ts`
- 修改：`src/desktop/preload/index.ts`
- 修改：`src/desktop/preload/folioloom-api.d.ts`
- 修改：`src/desktop/renderer/src/App.tsx`
- 修改：`src/desktop/renderer/src/components/Onboarding.tsx`
- 修改：`src/desktop/renderer/src/components/Sidebar.tsx`
- 修改：`src/desktop/renderer/src/styles.css`
- 修改：`test/desktop-ipc.test.ts`
- 修改：`test/desktop-main-security.test.ts`
- 修改：`src/desktop/renderer/src/App.test.tsx`

- [x] **步骤 1：编写 IPC 不记录 payload、复制摘要、取消导出和成功导出测试**

```ts
test("trusted IPC records channel outcome without recording request payload", async () => {
  const fixture = ipcFixture();
  registerDesktopIpc(fixture.dependencies);
  await handler(fixture, "folioloom:test-model")(
    trustedEvent,
    { providerId: "deepseek", modelId: "deepseek-v4-flash", apiKey: "sk-never-log" },
  );
  assert.equal(fixture.diagnostics.events[0]?.channel, "folioloom:test-model");
  assert.doesNotMatch(JSON.stringify(fixture.diagnostics.events), /sk-never-log/u);
});

test("diagnostic export cancellation is not reported as an error", async () => {
  fixture.dialog.saveResult = { canceled: true, filePath: undefined };
  const result = await handler(fixture, "folioloom:export-diagnostics")(trustedEvent);
  assert.deepEqual(result, { ok: false, error: expectSelectionCancelled() });
  assert.equal(fixture.diagnostics.exportCalls, 0);
});
```

在 renderer 测试中断言：左侧始终存在“导出诊断”；发生试译错误时存在“复制诊断摘要”和“导出诊断包”；成功后显示文件名而不接收内部日志目录。

- [x] **步骤 2：运行定向测试确认新通道和按钮尚不存在**

运行：

```bash
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts
npx vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/App.test.tsx
```

预期：FAIL，缺少诊断通道、API 方法和 GUI 按钮。

- [x] **步骤 3：实现 IPC 与主进程组合**

新增通道：

```ts
"folioloom:copy-diagnostic-summary",
"folioloom:export-diagnostics",
```

`handleTrusted` 为每次调用生成 `operationId`，记录 `started/completed/failed`、通道和耗时；不得序列化 `args`。把 `resultFrom` 的错误捕获移动到该统一边界，使原始异常在转换成 `DesktopError` 前进入脱敏记录器。主进程注入 `dialog.showSaveDialog`、`clipboard.writeText`、应用版本和当前安全状态摘要，并捕获 `uncaughtExceptionMonitor` 与 `unhandledRejection`。

- [x] **步骤 4：实现 preload 和 GUI**

```ts
export interface FolioLoomDesktopApi {
  copyDiagnosticSummary(): Promise<DesktopResult<void>>;
  exportDiagnostics(): Promise<DesktopResult<DesktopDiagnosticExportResult>>;
}
```

Sidebar 底部增加常驻按钮；Onboarding 错误区复用相同回调。诊断反馈用 `role="status"`，取消保存不显示红色失败；renderer 不读取日志路径或日志原文。

- [x] **步骤 5：运行 IPC、renderer、安全和构建边界测试**

运行：

```bash
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts test/desktop-build-config.test.ts
npx vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/App.test.tsx
npm run desktop:typecheck
```

预期：PASS。

- [x] **步骤 6：提交桌面诊断集成**

```bash
git add src/desktop test/desktop-ipc.test.ts test/desktop-main-security.test.ts
git commit -m "feat: expose private diagnostic export in desktop app"
```

### 任务 3：DeepSeek V4-only 与旧配置失效

**文件：**
- 修改：`src/providers/presets.ts`
- 修改：`src/providers/registry.ts`
- 修改：`src/desktop/desktop-model-service.ts`
- 修改：`src/desktop/desktop-errors.ts`
- 修改：`src/desktop/renderer/src/components/ProviderSetup.tsx`
- 修改：`test/provider-registry.test.ts`
- 修改：`test/desktop-model-service.test.ts`
- 修改：`test/desktop-provider-adapter.test.ts`
- 修改：`src/desktop/renderer/src/App.test.tsx`
- 修改：`test/fixtures/config.yaml`

- [x] **步骤 1：编写白名单、旧配置失效和 CLI 共同拒绝测试**

```ts
test("DeepSeek exposes only V4 Flash and Pro as curated models", () => {
  const definition = providerRegistry.get("deepseek");
  assert.equal(definition.modelDiscovery, "curated");
  assert.deepEqual(definition.fallbackModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(definition.allowManualModel, false);
});

test("DeepSeek retired model ids fail with a stable public code", () => {
  assert.throws(
    () => providerRegistry.resolve({ providerId: "deepseek", modelId: "deepseek-chat" }),
    (error: unknown) => diagnosticCode(error) === "DEEPSEEK_MODEL_RETIRED",
  );
});

test("desktop snapshot invalidates a persisted retired DeepSeek profile and probe", () => {
  preferences.saveState({ activeModelProfile: legacyProfile, latestProbe: legacyProbe });
  const snapshot = service.snapshot();
  assert.equal(snapshot.activeModelProfile, undefined);
  assert.equal(snapshot.latestProbe, undefined);
});
```

- [x] **步骤 2：运行测试确认旧模型仍可解析**

运行：`node --test --import tsx test/provider-registry.test.ts test/desktop-model-service.test.ts test/desktop-provider-adapter.test.ts`

预期：FAIL，DeepSeek 仍是动态发现且 registry 接受旧模型。

- [x] **步骤 3：实现集中模型策略**

```ts
export const DEEPSEEK_V4_MODEL_IDS = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const);

export class ProviderModelConfigurationError extends Error {
  constructor(readonly code: "DEEPSEEK_MODEL_RETIRED", message: string) {
    super(`${code}: ${message}`);
  }
}
```

在 `ProviderRegistry.resolve()` 中验证 DeepSeek 白名单；preset 使用 curated 且禁止手工模型。`DesktopModelService.snapshot()` 在发现旧持久化配置时原子清除 active profile/latest probe，不删除密钥。`toDesktopError()` 增加中文指引。

- [x] **步骤 4：验证 desktop、CLI 和 GUI**

运行：

```bash
node --test --import tsx test/provider-registry.test.ts test/desktop-model-service.test.ts test/desktop-provider-adapter.test.ts test/config.test.ts
npx vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/App.test.tsx
```

预期：PASS；renderer 的 DeepSeek 下拉框只出现两个 V4 ID，且没有手工模型输入框。

- [x] **步骤 5：提交模型策略**

```bash
git add src/providers src/desktop test src/desktop/renderer/src/components/ProviderSetup.tsx
git commit -m "fix: require current DeepSeek V4 model ids"
```

### 任务 4：德法西检测、语言覆盖与章节结构

**文件：**
- 修改：`src/source/language-detector.ts`
- 修改：`src/language/profiles.ts`
- 修改：`src/source/structure-annotator.ts`
- 修改：`src/desktop/contracts.ts`
- 修改：`src/desktop/main/ipc.ts`
- 修改：`src/desktop/preload/index.ts`
- 修改：`src/desktop/preload/folioloom-api.d.ts`
- 修改：`src/desktop/renderer/src/App.tsx`
- 修改：`src/desktop/renderer/src/components/Onboarding.tsx`
- 修改：`test/language-profile.test.ts`
- 修改：`test/source-importer.test.ts`
- 修改：`test/desktop-ipc.test.ts`
- 修改：`src/desktop/renderer/src/App.test.tsx`

- [x] **步骤 1：编写检测、混合前言、低置信和章节布局测试**

```ts
test("detects German, French and Spanish fiction after a short English front matter", () => {
  assert.equal(detectLanguage(`${englishCopyright}\n${germanNovel}`)?.id, "de");
  assert.equal(detectLanguage(`${englishCopyright}\n${frenchNovel}`)?.id, "fr");
  assert.equal(detectLanguage(`${englishCopyright}\n${spanishNovel}`)?.id, "es");
});

test("standalone Roman chapter headings require blank-line layout evidence", () => {
  const text = "Vorbemerkung.\n\nI.\n\nAls Gregor Samsa ...\nEr sprach von I. im Satz.";
  const annotations = annotateStructure(source(text), hash, getSourceLanguageProfile("de"));
  assert.deepEqual(annotations.map((item) => item.title), ["I."]);
});
```

同时覆盖 `KAPITEL 1`、`1. Kapitel`、`Erstes Kapitel`、`CHAPITRE I`、`PREMIER CHAPITRE`、`CAPÍTULO I`、`CAPITULO 1`，以及 UTF-8/UTF-16/Windows-1252 重音字符和弯引号导入。

- [x] **步骤 2：运行测试确认德语 `I.` 和语言覆盖链尚未工作**

运行：`node --test --import tsx test/language-profile.test.ts test/source-importer.test.ts test/desktop-ipc.test.ts`

预期：FAIL，缺少章节模式或 GUI/IPC 语言覆盖请求。

- [x] **步骤 3：实现确定性检测和有布局证据的标题**

增加德法西高辨识度功能词和分段采样，仍保持低证据返回 `undefined`。扩展三个 profile 的标题正则；`structure-annotator.ts` 对单独阿拉伯数字或罗马数字统一要求前后空行，避免正文误判。

- [x] **步骤 4：实现可选原文语言覆盖**

```ts
export interface DesktopChooseSourceRequest {
  sourceLanguage?: "auto" | "en" | "de" | "fr" | "es" | "ru" | "ja" | "ko";
}
```

初始页和更换书稿区域提供默认“自动检测”的选择框。IPC 只接受受支持 ID，并把选择传给 `DesktopSourceService.importSource()`；编码确认沿用 pending import 中已保存的语言值。

- [x] **步骤 5：运行语言、导入、IPC 和 renderer 测试**

运行：

```bash
node --test --import tsx test/language-profile.test.ts test/source-importer.test.ts test/desktop-source-service.test.ts test/desktop-ipc.test.ts
npx vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/App.test.tsx
```

预期：PASS。

- [x] **步骤 6：提交语言和结构支持**

```bash
git add src/language src/source src/desktop test
git commit -m "feat: strengthen German French and Spanish source support"
```

### 任务 5：普通词负缓存与提示词降噪

**文件：**
- 修改：`src/knowledge/knowledge-store.ts`
- 修改：`src/knowledge/translation-knowledge-projection.ts`
- 修改：`src/fullbook/book-runner.ts`
- 修改：`test/book-runner.test.ts`
- 修改：`test/translation-request.test.ts`
- 修改：`test/knowledge-store.test.ts`

- [x] **步骤 1：编写负缓存状态、后续跳过和不投影测试**

```ts
test("ordinary-word lexical decisions become contextual negative cache", () => {
  const revisions = new KnowledgeStore().reconcileCandidates([
    lexicalDecision("Fenster", "ordinary_word", "contextual"),
  ], "window-1");
  assert.equal(revisions[0]?.status, "contextual");
});

test("lexical negative cache suppresses reconsideration without entering translation memory", () => {
  const decided = decidedAnchorFormsFromKnowledge([ordinaryWordRevision("Fenster")]);
  assert.deepEqual(decided, ["Fenster"]);
  const projection = projectKnowledgeForTranslation(
    [ordinaryWordRevision("Fenster")],
    ["Das Fenster war offen."],
    getSourceLanguageProfile("de"),
  );
  assert.equal(projection.revisions.length, 0);
});
```

- [x] **步骤 2：运行测试确认当前裁决状态为 active 且会进入投影**

运行：`node --test --import tsx test/knowledge-store.test.ts test/translation-request.test.ts test/book-runner.test.ts`

预期：FAIL，`lexical_anchor_decision` 仍以 active 状态进入 source-matched projection。

- [x] **步骤 3：实现语义类别驱动的负缓存**

`singletonCandidateStatus()` 对 `lexical_anchor_decision` 的 contextual/普通词裁决返回 `contextual`；`decidedAnchorFormsFromKnowledge()` 同时读取 `active` 和 `contextual`；`projectKnowledgeForTranslation()` 明确跳过 `lexical_anchor_decision`，因为它只服务于本地候选调度，不是翻译事实。proper name、unique title、technical term 和实体关系仍由现有 `lexical_anchor`/`entity_alias_link` 路径投影。

- [x] **步骤 4：运行知识链与全书 runner 定向测试**

运行：`node --test --import tsx test/knowledge-store.test.ts test/translation-request.test.ts test/book-runner.test.ts test/lexical-anchor.test.ts`

预期：PASS，且现有锚点和实体关系测试不回退。

- [x] **步骤 5：提交负缓存**

```bash
git add src/knowledge src/fullbook/book-runner.ts test
git commit -m "perf: keep ordinary lexical decisions out of prompts"
```

### 任务 6：1.4.0 文档、真实门禁、打包与发布

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`desktop/resources/app-info.json`
- 修改：`README.md`
- 修改：`docs/superpowers/specs/2026-07-26-diagnostics-deepseek-v4-latin-language-design.md`
- 修改：`docs/superpowers/plans/2026-07-26-diagnostics-deepseek-v4-latin-language.md`

- [x] **步骤 1：统一版本与文档**

运行：`npm version 1.4.0 --no-git-tag-version`

更新 README：DeepSeek 只列 V4 Flash/Pro；说明诊断包的导出入口和隐私排除项；德语标注真实门禁，法语/西班牙语标注工程回归；不把旧模型名作为正常配置示例。

- [x] **步骤 2：运行全量自动化门禁**

运行：

```bash
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
```

预期：全部 exit 0，node:test 失败数为 0，Vitest 失败数为 0。

- [x] **步骤 3：运行真实德语单窗口门禁**

使用未跟踪的 Project Gutenberg《变形记》样本建立全新项目，运行：

```bash
npm run folioloom -- book run --manifest "<german-project>/source_manifest.json" --store "<german-project>/artifacts/folioloom/book.db" --config "<private-config>" --opencode-auth "<private-auth>" --run-mode quality --max-windows 1 --max-concurrency 1
```

然后运行 doctor、status 和导出审计。验收：

- `sourceLanguage=de`；
- `I.` 产生章节注释；
- 一个 4–6k 字符窗口完整提交；
- 无乱码、无异常德语散文残留、无失败或人工窗口；
- `ordinary_word` 裁决不成为 active 锚点且不进入翻译知识投影；
- 记录耗时、模型调用数、状态和 warning 代码，不提交正文、译文、私有配置或数据库。

- [x] **步骤 4：生成并检查隐私诊断样本**

用模拟 auth、私人路径、原文和译文构造失败事件，导出诊断 JSON；递归扫描不得出现模拟秘密、源/译文或盘符用户路径。对生成 JSON 执行 `JSON.parse()` 并核对 schema、环境、模型、source 摘要、最近失败阶段和事件顺序。

- [x] **步骤 5：生成 Windows 发布产物并做便携目录冒烟**

运行：

```bash
npm run desktop:dist
```

检查 `release/win-unpacked/FolioLoom.exe` 可启动；在打包应用中走通选择书稿、选择 DeepSeek V4、模拟试译失败、复制摘要、导出诊断、正常试译和译文导出。确认 `release/FolioLoom-portable-win-x64.zip` 可解压并运行。

- [x] **步骤 6：完成分支、合并和 GitHub Release**

```bash
git add package.json package-lock.json desktop/resources/app-info.json README.md docs
git commit -m "release: prepare FolioLoom v1.4.0"
git push origin main
git tag -a v1.4.0 -m "FolioLoom v1.4.0"
git push origin v1.4.0
gh release create v1.4.0 release/FolioLoom-portable-win-x64.zip release/*.exe --title "FolioLoom 1.4.0" --notes-file "<release-notes>"
```

最后用 `gh release view v1.4.0 --json url,assets,tagName` 验证普通用户可见的 ZIP 和 EXE 资产，检查主工作区干净，并把规格状态改为“已实现”。
