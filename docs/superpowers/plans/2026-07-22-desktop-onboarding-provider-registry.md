# FolioLoom 桌面端新手入口与厂商注册表实现计划

> **面向 AI 代理的工作者：** 使用 `executing-plans` 在当前 `feat/folioloom-desktop` worktree 内逐任务执行。仅在存在明确并行收益或高风险隔离价值时使用子代理。使用复选框记录进度。

**目标：** 把只读桌面 Alpha 攦造成普通用户可直接选择书稿、配置模型、完成真实兼容性检查并试译一个片段的本地应用，同时建立可扩展且不泄露 API Key 的厂商注册表。

**架构：** TypeScript 主进程负责无损书稿导入、厂商协议适配、模型能力探针、加密密钥和试译任务；沙箱化 React 渲染进程只通过固定 IPC 使用序列化 DTO。现有 V5 source ledger、`runBook()`、SQLite 审计和 CLI 保持兼容，GUI 不复制翻译协议。

**技术栈：** TypeScript 7、Node 24、Electron 43、React 19、pi-ai、node:sqlite、yauzl、fast-xml-parser、Vitest、Node test runner。

**设计依据：** `docs/superpowers/specs/2026-07-22-desktop-onboarding-and-provider-registry.md`

---

## 文件结构

### 新增

- `translator-v5/src/source/source-importer.ts`：TXT/MD/DOCX/EPUB 到 `v5-source-ledger-1` 的原生 TypeScript 导入。
- `translator-v5/src/source/language-detector.ts`：保守的源语言检测及置信度。
- `translator-v5/src/desktop/desktop-source-service.ts`：项目目录命名、去重和导入事务。
- `translator-v5/src/providers/types.ts`：厂商、模型 profile、effort 和探针报告的领域类型。
- `translator-v5/src/providers/presets.ts`：首批厂商不可变预设。
- `translator-v5/src/providers/registry.ts`：注册表、模型发现和自定义 URL 验证。
- `translator-v5/src/providers/runtime.ts`：从 profile 构造 pi-ai Model 与 StreamFn。
- `translator-v5/src/providers/capability-probe.ts`：真实流式、多轮工具调用和 effort 探针。
- `translator-v5/src/desktop/desktop-credential-store.ts`：Electron safeStorage 加密和会话回退。
- `translator-v5/src/desktop/desktop-model-service.ts`：模型列表、探针、保存和忘记密钥。
- `translator-v5/src/desktop/desktop-trial-service.ts`：单片段 V5 试译任务及结果投影。
- `translator-v5/src/desktop/renderer/src/components/Onboarding.tsx`：三步准备页。
- `translator-v5/src/desktop/renderer/src/components/ProviderSetup.tsx`：厂商、模型、API Key 和 effort 表单。
- `translator-v5/src/desktop/renderer/src/components/TechnicalDetails.tsx`：默认折叠的脱敏技术详情。
- 对应的 `translator-v5/test/*.test.ts` 与 renderer 测试。

### 修改

- `translator-v5/src/agents/pi-runtime.ts`：保留 DeepSeek CLI 包装器，内部委托通用 runtime。
- `translator-v5/src/desktop/contracts.ts`：新增书稿、模型、探针、试译 DTO。
- `translator-v5/src/desktop/desktop-errors.ts`：普通用户消息、下一步和脱敏详情。
- `translator-v5/src/desktop/desktop-preferences.ts`：升级非秘密偏好 schema。
- `translator-v5/src/desktop/main/ipc.ts`、`index.ts`：固定 IPC、依赖注入和 safeStorage。
- `translator-v5/src/desktop/preload/*`：暴露窄化 API 与单一进度订阅。
- `translator-v5/src/desktop/renderer/src/App.tsx`、现有组件与样式：三步状态机和普通用户文案。
- `translator-v5/package.json`、`package-lock.json`：显式 ZIP/XML 依赖。
- `README.md`、`translator-v5/README.md`：桌面使用方法和安全说明。

---

### 任务 1：建立原生无损书稿导入

**文件：**

- 创建：`translator-v5/src/source/language-detector.ts`
- 创建：`translator-v5/src/source/source-importer.ts`
- 创建：`translator-v5/src/desktop/desktop-source-service.ts`
- 创建：`translator-v5/test/source-importer.test.ts`
- 创建：`translator-v5/test/desktop-source-service.test.ts`
- 修改：`translator-v5/package.json`
- 修改：`translator-v5/package-lock.json`

- [x] **步骤 1：安装显式依赖**

运行：

```powershell
Set-Location translator-v5
npm.cmd install yauzl@3 fast-xml-parser@5
npm.cmd install --save-dev @types/yauzl@2
```

预期：`package.json` 只新增上述运行时与类型依赖，lockfile 正常更新。

- [x] **步骤 2：先写 TXT/Markdown、编码和账本覆盖失败测试**

测试必须断言：UTF-8、五种 BOM、CRLF 规范化、无 BOM 非 UTF-8 返回 `ENCODING_AMBIGUOUS`；`canonical_segments` 以 Unicode scalar 坐标连续覆盖全文；读取中源文件变化不留下项目目录。

核心测试形态：

```ts
test("imports UTF-8 text into a certified scalar source ledger", async () => {
  const result = await importSource({ sourcePath, projectDirectory, sourceLanguage: "en" });
  const ledger = SourceLedger.open(result.manifestPath);
  assert.equal(ledger.sourceText, "Alpha\nBeta");
  assert.deepEqual(ledger.canonicalSegments.map((segment) => [
    segment.canonicalStart,
    segment.canonicalEnd,
  ]), [[0, 10]]);
});
```

- [x] **步骤 3：运行测试并确认导入 API 尚不存在**

运行：

```powershell
npm.cmd test -- --test-name-pattern="imports UTF-8|encoding ambiguous|source changes during import"
```

预期：FAIL，缺少 `source-importer.ts` 或导出函数。

- [x] **步骤 4：实现纯文本导入、语言检测和原子目录发布**

公开边界固定为：

```ts
export interface SourceImportRequest {
  sourcePath: string;
  projectDirectory: string;
  sourceLanguage: string;
  explicitEncoding?: string;
}

export interface SourceImportResult {
  manifestPath: string;
  rawSha256: string;
  canonicalChars: number;
  detectedLanguage?: { id: string; confidence: number };
}

export async function importSource(request: SourceImportRequest): Promise<SourceImportResult>;
```

写入 `source/original.<ext>`、`source.txt` 和 `source_manifest.json` 时先使用同父目录临时目录；全部写入并经 `SourceLedger.open()` 自验后再 rename 发布。失败时删除临时目录，不覆盖已有项目。

- [x] **步骤 5：先写 DOCX/EPUB 顺序、空段落与 ZIP 限制测试**

用测试内生成的小型 ZIP fixture 覆盖：DOCX 文档段落顺序及空段落；EPUB container → OPF → spine 顺序；路径穿越、单项超过 64 MiB、总展开大小超过 512 MiB、缺失 container/OPF/document.xml 均返回稳定错误。

- [x] **步骤 6：实现 lazy ZIP 与 XML 提取**

使用 `yauzl.open(..., { lazyEntries: true })` 先检查 central directory 元数据，只读取需要的成员。XML 使用 `fast-xml-parser`，关闭实体展开，拒绝 `..`、绝对路径和反斜线路径逃逸。DOCX 与 EPUB 分别生成 `docx_paragraph` 和 `epub_spine_member` provenance。

- [x] **步骤 7：实现项目去重与用户目录服务**

`DesktopSourceService` 构造函数注入 `projectsRoot`。它以 `sanitizeTitle(basename)` 与源 SHA 前 12 位生成目录；已存在目录先用 `SourceLedger.open()` 校验 raw hash，相同则复用，不同则创建带 hash 的新目录。

- [x] **步骤 8：运行导入测试、类型检查和现有 ledger 回归**

```powershell
npm.cmd test -- --test-name-pattern="source importer|desktop source service|source ledger"
npm.cmd run typecheck
```

预期：PASS。

- [x] **步骤 9：提交**

```powershell
git add translator-v5/package.json translator-v5/package-lock.json translator-v5/src/source translator-v5/src/desktop/desktop-source-service.ts translator-v5/test/source-importer.test.ts translator-v5/test/desktop-source-service.test.ts
git commit -m "feat: import manuscript files in desktop"
```

---

### 任务 2：建立可扩展厂商注册表与通用 runtime

**文件：**

- 创建：`translator-v5/src/providers/types.ts`
- 创建：`translator-v5/src/providers/presets.ts`
- 创建：`translator-v5/src/providers/registry.ts`
- 创建：`translator-v5/src/providers/runtime.ts`
- 创建：`translator-v5/test/provider-registry.test.ts`
- 创建：`translator-v5/test/provider-runtime.test.ts`
- 修改：`translator-v5/src/agents/pi-runtime.ts`

- [x] **步骤 1：先写注册表、URL 和 effort 映射失败测试**

断言首批 provider ID 精确为 `deepseek`、`kimi-cn`、`bailian`、`volcengine`、`openai`、`siliconflow`、`openai-compatible`；预置 Base URL 不接受 UI 覆盖；自定义接口只接受 HTTPS 或 loopback HTTP；`max` 经内部 `xhigh` 后仍发送为 `max`。

```ts
assert.deepEqual(registry.list().map((item) => item.id), [
  "deepseek", "kimi-cn", "bailian", "volcengine",
  "openai", "siliconflow", "openai-compatible",
]);
assert.equal(toInternalThinking("max"), "xhigh");
assert.equal(toProviderEffort("xhigh", profile), "max");
```

- [x] **步骤 2：运行定向测试确认失败**

```powershell
npm.cmd test -- --test-name-pattern="provider registry|custom provider URL|raw max effort"
```

预期：FAIL，providers 模块不存在。

- [x] **步骤 3：定义稳定领域类型**

```ts
export type ProviderId =
  | "deepseek" | "kimi-cn" | "bailian" | "volcengine"
  | "openai" | "siliconflow" | "openai-compatible";

export interface ModelProfile {
  providerId: ProviderId;
  modelId: string;
  reasoningEffort?: string;
  customBaseUrl?: string;
}

export interface ProviderRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
}
```

`ModelProfile` 不含 API Key；effort 为接口原始值，不使用翻译枚举。

- [x] **步骤 4：实现预设、模型发现与保守回退**

标准 `/models` 响应只接收 `{ data: [{ id: string }] }`；去重、排序并限制为 500 项。网络失败返回内置推荐列表加 `source: "fallback"`，不把回退描述为在线结果。百炼、火山和自定义接口始终允许手填模型 ID。

- [x] **步骤 5：实现 runtime 并保留 CLI 兼容包装器**

`createProviderRuntime(profile, credential)` 根据 api family 选择 pi-ai 的 OpenAI Chat 或 Responses 实现，并填入模型级 compat。`createDeepSeekModel()` 与 `createDeepSeekStreamFn()` 继续导出，但只把现有 `PilotModelConfig` 转成 `ModelProfile` 后委托新 runtime，保证 CLI 测试不变。

- [x] **步骤 6：运行 provider、pi-runtime 和 config 回归**

```powershell
npm.cmd test -- --test-name-pattern="provider registry|provider runtime|PiRuntime|config"
npm.cmd run typecheck
```

预期：PASS，并确认 `reasoningEffort: "max"` 不再静默变成 `high`。

- [x] **步骤 7：提交**

```powershell
git add translator-v5/src/providers translator-v5/src/agents/pi-runtime.ts translator-v5/test/provider-registry.test.ts translator-v5/test/provider-runtime.test.ts
git commit -m "feat: add extensible model provider registry"
```

---

### 任务 3：实现真实兼容性探针

**文件：**

- 创建：`translator-v5/src/providers/capability-probe.ts`
- 创建：`translator-v5/test/provider-capability-probe.test.ts`
- 修改：`translator-v5/src/providers/types.ts`

- [x] **步骤 1：写本地假服务的失败测试**

测试服务器分别模拟：完整流式工具调用、只返回文本、碎片化 tool arguments、第二轮拒绝 reasoning 内容、401、404 model、429、503、超时和非法 JSON。自动测试不得请求真实厂商。

```ts
const report = await probeProvider({ profile, credential: "test-key", fetch: localFetch });
assert.equal(report.status, "ready");
assert.deepEqual(report.checks.map((check) => check.id), [
  "stream", "tool_call", "tool_round_trip", "reasoning_continuity", "effort",
]);
```

- [x] **步骤 2：运行定向测试确认失败**

```powershell
npm.cmd test -- --test-name-pattern="capability probe"
```

预期：FAIL，probe API 不存在。

- [x] **步骤 3：实现 30 秒、低输出上限的探针状态机**

探针使用无副作用工具：

```ts
const tool = {
  name: "return_probe_token",
  description: "Return the supplied probe token",
  parameters: {
    type: "object",
    properties: { token: { type: "string" } },
    required: ["token"],
    additionalProperties: false,
  },
};
```

第一轮强制调用工具，主进程回传固定 token，第二轮要求只输出 `FOLIOLOOM_READY`。任何一步不能结构化完成均为 `limited`，鉴权/网络/参数错误为 `failed`。

- [x] **步骤 4：建立脱敏错误分类**

将常见响应映射为 `AUTH_INVALID`、`MODEL_NOT_FOUND`、`QUOTA_EXHAUSTED`、`RATE_LIMITED`、`PROVIDER_BUSY`、`TOOL_CALL_UNSUPPORTED`、`REASONING_CONTINUITY_UNSUPPORTED`、`REQUEST_TIMEOUT`。技术详情移除 Authorization、API Key、URL query 和响应中的疑似密钥串。

- [x] **步骤 5：运行探针和 provider 全套测试**

```powershell
npm.cmd test -- --test-name-pattern="capability probe|provider runtime|provider registry"
npm.cmd run typecheck
```

预期：PASS。

- [x] **步骤 6：提交**

```powershell
git add translator-v5/src/providers translator-v5/test/provider-capability-probe.test.ts
git commit -m "feat: verify provider tool compatibility"
```

---

### 任务 4：加密保存密钥与非秘密模型偏好

**文件：**

- 创建：`translator-v5/src/desktop/desktop-credential-store.ts`
- 创建：`translator-v5/src/desktop/desktop-model-service.ts`
- 创建：`translator-v5/test/desktop-credential-store.test.ts`
- 创建：`translator-v5/test/desktop-model-service.test.ts`
- 修改：`translator-v5/src/desktop/desktop-preferences.ts`
- 修改：`translator-v5/test/desktop-preferences.test.ts`

- [x] **步骤 1：写 safeStorage、会话回退和不泄密测试**

测试注入假 `safeStorage`，验证落盘只有 base64 密文；`isEncryptionAvailable() === false` 时不创建 credential 文件；读取设置、错误序列化、`JSON.stringify(service.snapshot())` 均不包含明文 key。

```ts
interface DesktopSecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
```

- [x] **步骤 2：运行定向测试确认失败**

```powershell
npm.cmd test -- --test-name-pattern="credential store|model service|desktop preferences v2"
```

预期：FAIL。

- [x] **步骤 3：实现原子密文存储与会话模式**

credential 文件 schema 固定为 `folioloom-desktop-credentials-1`，按 provider ID 保存密文。文件写入沿用临时文件 + rename；解密失败时返回“需要重新输入”，不删除其他厂商密钥。`forget(providerId)` 同时清理磁盘与内存。

- [x] **步骤 4：升级非秘密偏好 schema**

`DesktopPreferences` 升级到 schema 2，保存：`recent`、`activeModelProfile`、最近一次脱敏 probe 摘要。读取 schema 1 时迁移 recent project，绝不尝试迁移密钥。

- [x] **步骤 5：实现 DesktopModelService**

该服务组合 registry、credential store 和 probe，公开 `listProviders()`、`discoverModels(request)`、`testAndSave(request)`、`forgetCredential(providerId)` 和 `snapshot()`。只有 probe 为 `ready` 才保存 active profile；API Key 参数在调用结束后的任何 DTO 中均不存在。

- [x] **步骤 6：运行桌面设置测试与类型检查**

```powershell
npm.cmd test -- --test-name-pattern="credential store|model service|desktop preferences"
npm.cmd run desktop:typecheck
npm.cmd run typecheck
```

预期：PASS。

- [x] **步骤 7：提交**

```powershell
git add translator-v5/src/desktop/desktop-credential-store.ts translator-v5/src/desktop/desktop-model-service.ts translator-v5/src/desktop/desktop-preferences.ts translator-v5/test/desktop-credential-store.test.ts translator-v5/test/desktop-model-service.test.ts translator-v5/test/desktop-preferences.test.ts
git commit -m "feat: store desktop model credentials securely"
```

---

### 任务 5：扩展固定 IPC 与桌面契约

**文件：**

- 修改：`translator-v5/src/desktop/contracts.ts`
- 修改：`translator-v5/src/desktop/desktop-errors.ts`
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/main/index.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 修改：`translator-v5/test/desktop-ipc.test.ts`
- 修改：`translator-v5/test/desktop-main-security.test.ts`

- [x] **步骤 1：先写 IPC 白名单和输入拒绝测试**

新增固定 channel：`choose-source`、`onboarding-state`、`discover-models`、`test-model`、`forget-credential`。断言没有 `invoke(channel, payload)`、任意 URL fetch、读取 credential 或任意文件路径 API。`choose-source` picker 只接受 TXT/MD/EPUB/DOCX。

- [x] **步骤 2：运行桌面 IPC 测试确认失败**

```powershell
npm.cmd test -- --test-name-pattern="desktop IPC|trusted renderer|model credential"
```

预期：FAIL，channel 与契约尚不存在。

- [x] **步骤 3：扩充纯 JSON DTO**

```ts
export interface DesktopOnboardingState {
  project?: DesktopProjectSnapshot;
  providers: DesktopProviderSummary[];
  activeModel?: DesktopModelSummary;
  readiness: { source: boolean; model: boolean; trial: boolean };
}

export interface DesktopTestModelRequest {
  providerId: string;
  apiKey?: string;
  modelId: string;
  reasoningEffort?: string;
  customBaseUrl?: string;
}
```

任何响应类型不得出现 `apiKey`、encrypted secret、Node Buffer、Error、Model 或 StreamFn。

- [x] **步骤 4：实现依赖注入式 IPC 和 main 装配**

`main/index.ts` 在 `app.whenReady()` 后以 `safeStorage`、`app.getPath("userData")`、`app.getPath("documents")` 创建服务。IPC 继续验证顶层 frame 和精确 renderer URL。取消文件选择返回可忽略的 `DESKTOP_SELECTION_CANCELLED`，不覆盖当前状态。

- [x] **步骤 5：实现 preload 窄接口**

只暴露命名方法；API Key 仅可作为 `testModel()` 请求字段进入主进程，主进程响应不回显。渲染器无 provider URL 表，防止篡改预置地址。

- [x] **步骤 6：运行 IPC、安全、偏好和 build 测试**

```powershell
npm.cmd test -- --test-name-pattern="desktop IPC|desktop window|desktop preferences|credential"
npm.cmd run desktop:typecheck
npm.cmd run desktop:build
```

预期：PASS。

- [x] **步骤 7：提交**

```powershell
git add translator-v5/src/desktop/contracts.ts translator-v5/src/desktop/desktop-errors.ts translator-v5/src/desktop/main translator-v5/src/desktop/preload translator-v5/test/desktop-ipc.test.ts translator-v5/test/desktop-main-security.test.ts
git commit -m "feat: expose secure desktop onboarding IPC"
```

---

### 任务 6：实现方案 A 三步准备页并清理工程术语

**文件：**

- 创建：`translator-v5/src/desktop/renderer/src/components/Onboarding.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/ProviderSetup.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/TechnicalDetails.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/types.ts`
- 修改：`translator-v5/src/desktop/renderer/src/components/ProjectOverview.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/DoctorPanel.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/Sidebar.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/WorkspacePlaceholder.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`

- [x] **步骤 1：先写用户流程与禁用文案测试**

覆盖：空状态显示“开始翻译一本书”和“选择书稿”；厂商按钮包括六个直接入口和“更多服务”；选 DeepSeek 时 effort 显示原始 `high`、`max`；API Key 测试成功后输入框清空；模型未 ready 时试译禁用；默认 DOM 不出现 `V5`、`source_manifest.json`、`book.db`、`canonical`、`SQLite`、`状态库`。

- [x] **步骤 2：运行 renderer 测试确认失败**

```powershell
npx.cmd vitest run --config vitest.desktop.config.ts src/desktop/renderer/src/App.test.tsx
```

预期：FAIL，仍显示旧 Alpha 空状态。

- [x] **步骤 3：实现三步状态机**

`App` 状态只保留 DTO、表单草稿和 busy action。流程状态从服务快照派生，不以“用户点击过”作为完成依据：

```ts
const sourceReady = onboarding.project !== undefined;
const modelReady = onboarding.activeModel?.capability === "ready";
const trialEnabled = sourceReady && modelReady && busyAction === undefined;
```

API Key 只存在 `ProviderSetup` 的受控 state；`testModel` promise settled 后立即 `setApiKey("")`。

- [x] **步骤 4：按已确认原型实现视觉层级**

保留现有暗色标题栏和侧栏；内容区使用 1/2/3 三段。思考强度用模型元数据返回的原始字符串；不翻译、不补齐不存在的等级。自定义接口置于“更多服务”，展开后才显示 Base URL。

- [x] **步骤 5：清理所有默认可见工程文案**

统一替换为“书稿、翻译记录、翻译任务、片段、检查”。错误码和内部路径只放进 `<details><summary>技术详情</summary>`；技术详情组件在渲染前再次调用纯函数脱敏。

- [x] **步骤 6：运行 renderer、布局和可访问性回归**

```powershell
npm.cmd run desktop:test
npm.cmd run desktop:typecheck
```

预期：PASS；1440×920、1100×720 下 `.workbench-main` 无页面级纵向滚动条，内容区自身按需滚动；厂商按钮、字段和错误提示均有可访问名称。

- [x] **步骤 7：提交**

```powershell
git add translator-v5/src/desktop/renderer
git commit -m "feat: add reader-friendly desktop onboarding"
```

---

### 任务 7：接通单片段试译

**文件：**

- 创建：`translator-v5/src/desktop/desktop-trial-service.ts`
- 创建：`translator-v5/test/desktop-trial-service.test.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/src/desktop/contracts.ts`
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 修改：`translator-v5/src/desktop/renderer/src/App.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/Onboarding.tsx`
- 修改：相关测试。

- [x] **步骤 1：写试译边界和恢复失败测试**

用 fake StreamFn 验证：只处理一个 window、`maxConcurrency: 1`、同一项目不能并发两个试译、模型未 ready 拒绝、成功返回源文/译文和 run ID、失败仍释放 lease、第二次启动能从 SQLite 读取上次结果。

- [x] **步骤 2：运行定向测试确认失败**

```powershell
npm.cmd test -- --test-name-pattern="desktop trial"
```

预期：FAIL，trial service 不存在。

- [x] **步骤 3：为 lossless runner 添加可选 AbortSignal**

在 `LosslessBookRunOptions` 增加 `signal?: AbortSignal`，每轮选窗前、provider 调用前和提交下一原子窗口前 `throwIfAborted()`；信号向 PiSessionSpec 传递。已进入 commit coordinator 的原子提交不得被中途打断。

- [x] **步骤 4：实现单任务控制器**

`DesktopTrialService.start()` 固定 `maxWindows: 1`、`maxConcurrency: 1`，store 使用项目内 `artifacts/folioloom/book.db`。运行前重新验证 source version 与 active profile；运行后从 `LosslessBookStore.auditState(runId).translations` 投影第一个译文。窗口关闭时 `cancel()` 发 signal，并等待 promise settled 后允许 app quit。

- [x] **步骤 5：增加固定进度事件**

主进程只发送 `preparing`、`translating`、`checking`、`completed`、`failed`；事件不包含 prompt、API Key 或完整 provider 响应。preload 返回 unsubscribe 函数，且只接受来自固定 channel 的 DTO。

- [x] **步骤 6：在 UI 显示试译结果**

三步页第三段在运行时显示阶段文字；成功后并排显示原文与译文，并提供“进入翻译进度”入口。失败显示普通用户原因和折叠技术详情，不自动启动整本翻译。

- [x] **步骤 7：运行 trial、runner、desktop 全套回归**

```powershell
npm.cmd test -- --test-name-pattern="desktop trial|lossless book|abort"
npm.cmd run desktop:test
npm.cmd run typecheck
npm.cmd run desktop:typecheck
```

预期：PASS。

- [x] **步骤 8：提交**

```powershell
git add translator-v5/src/desktop translator-v5/src/fullbook/book-runner.ts translator-v5/test/desktop-trial-service.test.ts translator-v5/test/book-runner.test.ts
git commit -m "feat: run one-window desktop trials"
```

---

### 任务 8：文档、构建和人工验收

**文件：**

- 修改：`README.md`
- 修改：`translator-v5/README.md`
- 修改：`translator-v5/desktop/resources/app-info.json`
- 修改：`translator-v5/test/desktop-build-config.test.ts`
- 修改：`docs/superpowers/plans/2026-07-22-desktop-onboarding-provider-registry.md`（勾选完成状态）

- [x] **步骤 1：更新桌面边界与用户说明**

文档只让普通用户执行：启动应用 → 选择书稿 → 选择厂商 → 填入 API Key/模型/effort → 测试连接 → 试译。说明密钥用系统加密保存，`safeStorage` 不可用时为会话模式。开发者章节另行解释内部项目和 CLI，不混进用户步骤。

- [x] **步骤 2：更新资源策略和构建测试**

`app-info.json` 将 `translationWritePolicy` 从 Alpha 禁用状态改为 `single-window-trial`，保留 `apiKeyPolicy: "never-packaged"`。构建测试断言 `yauzl`、XML parser 和 provider runtime 被打入产物，而测试 fixture、密钥文件和本机项目不进入包。

- [x] **步骤 3：运行完整自动验证**

```powershell
Set-Location translator-v5
npm.cmd test
npm.cmd run typecheck
npm.cmd run desktop:test
npm.cmd run desktop:typecheck
npm.cmd run desktop:build
npx.cmd electron-builder --win --x64 --dir
```

预期：全部 PASS，`release/win-unpacked/FolioLoom.exe` 存在。

- [x] **步骤 4：执行本地 smoke test**

使用不含私人密钥的本地假 provider：

1. 启动 production Electron。
2. 导入 TXT、EPUB、DOCX 各一个小 fixture。
3. 确认重选同一文件恢复原项目。
4. 切换六个预置厂商，确认普通入口不显示 Base URL。
5. 用自定义 loopback provider 完成模型发现、工具兼容性检查和单片段试译。
6. 关闭并重启应用，确认项目和非秘密模型配置恢复；测试密钥按 safeStorage 策略恢复。
7. 退出所有 FolioLoom 进程和本地假服务。

- [x] **步骤 5：检查仓库与密钥污染**

```powershell
git status --short
git grep -n -I -E "sk-[A-Za-z0-9_-]{12,}|Authorization: Bearer [A-Za-z0-9_-]{8,}" -- . ":(exclude)translator-v5/test/**"
```

预期：无真实密钥；只有本计划产生的预期修改。

- [x] **步骤 6：提交文档与验收元数据**

```powershell
git add README.md translator-v5/README.md translator-v5/desktop/resources/app-info.json translator-v5/test/desktop-build-config.test.ts docs/superpowers/plans/2026-07-22-desktop-onboarding-provider-registry.md
git commit -m "docs: describe desktop onboarding workflow"
```

---

## 计划自检

- **规格覆盖：** 任务 1 覆盖原始书稿入口；任务 2–3 覆盖厂商注册表、原始 effort 和真实工具兼容性；任务 4–5 覆盖密钥与 IPC；任务 6 覆盖方案 A 和文案；任务 7 覆盖单片段试译；任务 8 覆盖 portable 构建与安全验收。
- **架构边界：** provider、source、desktop service、IPC 和 renderer 分离；CLI 通过兼容包装器继续使用同一 runtime。
- **无假能力：** 不支持工具调用的模型得到 `limited`，不能开始试译；尚未接通的全书功能不显示可点击按钮。
- **隐私：** API Key 不进入 DTO、偏好、日志、测试快照、仓库或安装包；自定义 URL 受协议与 loopback 限制。
- **恢复：** 源导入原子发布，SQLite 原子窗口提交保持现有协议，试译中断可从真实状态恢复。
