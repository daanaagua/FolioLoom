# FolioLoom 桌面端日韩吞吐与模型探针实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 DeepSeek V4 Flash 能力探针和桌面状态机，补齐可追溯的日韩语言/编码/预算支持，并以显式快速模式和自适应调度完成真实基准。

**架构：** provider 探针通过共享 wire policy 构造请求；源文本经版本化编码策略和语言画像进入统一 token/request budget；全书 runner 使用双运行时和有界 AIMD 调度。Electron 只暴露固定 IPC 和类型化状态，不复制核心规则。

**技术栈：** TypeScript 7、Node test runner、React 19、Vitest/Testing Library、Electron 43、pi-agent-core/pi-ai、SQLite、Electron safeStorage。

**规格：** `docs/superpowers/specs/2026-07-22-desktop-cjk-throughput-and-provider-probe-design.md`

---

## 文件结构

### 新建文件

- `translator-v5/src/providers/wire-policy.ts`：从注册表模型元数据生成探针和正式 runtime 共用的 wire policy。
- `translator-v5/src/source/encoding-policy.ts`：严格解码、旧编码候选评分和可追溯编码决定。
- `translator-v5/src/source/token-estimator.ts`：Unicode 权重估算和有界 usage 校准。
- `translator-v5/src/agents/translation-request.ts`：唯一的翻译提示/工具载荷构造入口，为预算和实际请求提供同一序列化结果。
- `translator-v5/src/fullbook/request-budgeter.ts`：完整请求容量核算、裁剪建议和拆包判定。
- `translator-v5/src/fullbook/adaptive-scheduler.ts`：请求数与在途 token 双限制、AIMD 升降载和持久化快照。
- `translator-v5/src/desktop/renderer/src/components/EncodingChooser.tsx`：只呈现主进程允许的编码候选。
- `translator-v5/src/benchmark/cjk-benchmark.ts`：本地真实语料抽样、试跑和去正文指标报告。
- `translator-v5/test/provider-wire-policy.test.ts`：provider wire 契约。
- `translator-v5/test/token-estimator.test.ts`：日韩/拉丁估算和校准。
- `translator-v5/test/request-budgeter.test.ts`：完整载荷预算与拆包。
- `translator-v5/test/adaptive-scheduler.test.ts`：升载、降载、恢复和 token 上限。
- `translator-v5/test/cjk-benchmark.test.ts`：抽样边界、哈希和不泄漏正文的离线测试。

### 修改文件

- `translator-v5/src/providers/{types,presets,registry,runtime,capability-probe}.ts`
- `translator-v5/src/language/{types,profiles}.ts`
- `translator-v5/src/source/{language-detector,structure-annotator,block-builder,source-importer,source-ledger,types}.ts`
- `translator-v5/src/fullbook/{types,book-context,window-planner,request-batcher,book-runner}.ts`
- `translator-v5/src/agents/{pi-runtime,translation-batch,repairer}.ts`
- `translator-v5/src/{config,cli}.ts`
- `translator-v5/src/desktop/{contracts,desktop-errors,desktop-model-service,desktop-source-service,desktop-trial-service}.ts`
- `translator-v5/src/desktop/main/{ipc,provider-model-adapter}.ts`
- `translator-v5/src/desktop/preload/{index,folioloom-api.d.ts}.ts`
- `translator-v5/src/desktop/renderer/src/{App,App.test,types}.tsx`
- `translator-v5/src/desktop/renderer/src/components/{Onboarding,ProviderSetup,Sidebar}.tsx`
- `translator-v5/src/desktop/renderer/src/styles.css`
- 对应 `translator-v5/test/*.test.ts` 与 `translator-v5/README.md`。

---

### 任务 1：统一 provider wire policy 并修复探针假阴性

**文件：**
- 创建：`translator-v5/src/providers/wire-policy.ts`
- 创建：`translator-v5/test/provider-wire-policy.test.ts`
- 修改：`translator-v5/src/providers/types.ts`
- 修改：`translator-v5/src/providers/presets.ts`
- 修改：`translator-v5/src/providers/runtime.ts`
- 修改：`translator-v5/src/providers/capability-probe.ts`
- 修改：`translator-v5/test/provider-capability-probe.test.ts`
- 修改：`translator-v5/test/provider-registry.test.ts`

- [ ] **步骤 1：编写探针截断、off 续传和 wire 契约失败测试**

在 fake provider 中加入 `truncated-once` 与 `always-truncated`，SSE 必须真实发送 `finish_reason: "length"`：

```ts
test("a length-truncated tool call is retried once instead of reported unsupported", async (t) => {
  const provider = await startFakeProvider({ mode: "truncated-once" });
  t.after(() => provider.close());
  const report = await probe("deepseek", provider, "high");
  assert.equal(report.status, "ready");
  assert.equal(provider.requests.length, 3); // first truncated + first retry + round trip
  assert.equal(provider.requests[0]?.body.max_completion_tokens, 512);
  assert.equal(provider.requests[1]?.body.max_completion_tokens, 2048);
});

test("two length terminations return PROBE_OUTPUT_TRUNCATED", async (t) => {
  const provider = await startFakeProvider({ mode: "always-truncated" });
  t.after(() => provider.close());
  const report = await probe("deepseek", provider, "high");
  assert.equal(report.status, "failed");
  assert.equal(report.code, "PROBE_OUTPUT_TRUNCATED");
});

test("DeepSeek off skips reasoning continuity and remains ready", async (t) => {
  const provider = await startFakeProvider({ omitReasoning: true });
  t.after(() => provider.close());
  const report = await probe("deepseek", provider, "off");
  assert.equal(report.status, "ready");
  assert.equal(report.checks.find((item) => item.id === "reasoning_continuity")?.status, "skipped");
});
```

`provider-wire-policy.test.ts` 断言 DeepSeek 的 output token 字段、thinking 开关、原始 effort 和 assistant reasoning replay 与 runtime adapter 使用同一 policy。

- [ ] **步骤 2：运行定向测试并确认因 32-token 固定值、缺少终止原因和 off 误判而失败**

运行：

```powershell
node --test --import tsx test/provider-wire-policy.test.ts test/provider-capability-probe.test.ts test/provider-registry.test.ts test/provider-runtime.test.ts
```

预期：至少 `truncated-once`、`always-truncated`、`off` 和 V4 fallback 断言失败；失败不是测试语法或 fake server 错误。

- [ ] **步骤 3：实现共享 policy、终止原因和一次有界重试**

`wire-policy.ts` 提供稳定接口：

```ts
export interface ProviderWirePolicy {
  apiFamily: ProviderApiFamily;
  outputTokenField: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
  initialProbeTokens(effort: ProviderEffort | undefined): number;
  serializeThinking(effort: ProviderEffort | undefined): Record<string, unknown>;
  requiresReasoningReplay(effort: ProviderEffort | undefined): boolean;
}

export function providerWirePolicy(resolved: ResolvedProviderProfile): ProviderWirePolicy;
```

`StreamResult` 新增 `finishReason?: string`；chat 读取 `choices[0].finish_reason`，Responses 读取 completed/incomplete 状态。第一轮仅在 `length` 时以 2048 tokens 重试一次，总 deadline 不重置。两次截断抛出 `ProbeFailure("PROBE_OUTPUT_TRUNCATED", ...)`。`off` 将 reasoning continuity 记为 skipped。严格 JSON 校验保持不变。

`runtime.ts` 从同一 policy 读取 thinking format、reasoning replay 和 thinking map。`presets.ts` 把 DeepSeek fallback 更新为：

```ts
fallbackModels: ["deepseek-v4-flash", "deepseek-v4-pro"]
```

- [ ] **步骤 4：运行 provider 全套并验证绿灯**

运行：

```powershell
node --test --import tsx test/provider-wire-policy.test.ts test/provider-capability-probe.test.ts test/provider-registry.test.ts test/provider-runtime.test.ts test/desktop-provider-adapter.test.ts
```

预期：全部 PASS；fake request 中不再出现 32-token 探针；credential 不出现在失败快照。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/providers translator-v5/test/provider-*.test.ts translator-v5/test/desktop-provider-adapter.test.ts
git commit -m "fix: make provider capability probes truncation-aware"
```

---

### 任务 2：修复桌面模型表单状态、异步竞态和伪导航

**文件：**
- 修改：`translator-v5/src/desktop/desktop-model-service.ts`
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/renderer/src/App.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/ProviderSetup.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/Sidebar.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`
- 修改：`translator-v5/test/desktop-model-service.test.ts`
- 修改：`translator-v5/test/desktop-ipc.test.ts`

- [ ] **步骤 1：为保存模型同步、竞态和反馈写失败测试**

```tsx
it("opens the provider form on the saved active model", async () => {
  render(<App api={desktopApi({ activeModel: kimiReadyModel })} />);
  expect(await screen.findByRole("button", { name: "Kimi" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByDisplayValue(kimiReadyModel.modelId)).toBeVisible();
});

it("prevents provider changes while model discovery is pending", async () => {
  const deepSeek = deferred<DesktopResult<DesktopModelOption[]>>();
  const api = desktopApi({ discoverModels: () => deepSeek.promise });
  render(<App api={api} />);
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  expect(screen.getByRole("button", { name: "Kimi" })).toBeDisabled();
  deepSeek.resolve(ok([{ id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" }]));
  expect(await screen.findByText("DeepSeek V4 Flash")).toBeVisible();
});
```

另测：busy 时 provider 按钮不可切换；失败/limited 后 API Key 仍在 password 输入框；ready 后输入框清空；忘记密钥清空绿色提示和试译可用状态；占位工作区没有可点击按钮。

- [ ] **步骤 2：运行桌面定向测试并确认失败**

运行：

```powershell
npm run desktop:test
```

预期：新增表单同步、异步竞态、忘记反馈和伪导航测试失败；既有导入和试译测试保持通过。

- [ ] **步骤 3：实现 provider snapshot + nonce 状态机**

`ProviderSetup` 用活动模型确定初值，并为每个异步动作绑定快照：

```ts
const requestNonce = useRef(0);
const beginRequest = () => ({ nonce: ++requestNonce.current, providerId });
const isCurrent = (request: RequestIdentity) =>
  request.nonce === requestNonce.current && request.providerId === providerId;
```

切换 provider 时递增 nonce；busy 时 provider 按钮 `disabled`。响应只有 `isCurrent` 才可写入 state。`onboarding.activeModel` 改变时同步 provider/model/effort，但不得覆盖用户正在编辑且未提交的同一表单。`forgetCredential()` 同时删除与该 provider 相关的 latest probe；失败/limited 不保存 credential，但 renderer 当前输入不被重建清空。

`Sidebar` 只让“准备/试译”可点击；其余项渲染 `aria-disabled="true"` 和“后续版本”，不改变 `activeSection`。

- [ ] **步骤 4：运行桌面 Node、Renderer 和类型检查**

```powershell
npm run desktop:typecheck
npm run desktop:test
```

预期：0 failures；React 控制台无 act、key 或受控输入警告。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/desktop translator-v5/test/desktop-*.test.ts
git commit -m "fix: isolate desktop provider form state"
```

---

### 任务 3：建立完整的日语和韩语画像

**文件：**
- 修改：`translator-v5/src/language/types.ts`
- 修改：`translator-v5/src/language/profiles.ts`
- 修改：`translator-v5/src/source/language-detector.ts`
- 修改：`translator-v5/src/source/structure-annotator.ts`
- 修改：`translator-v5/test/language-profile.test.ts`
- 修改：`translator-v5/test/source-ledger.test.ts`
- 修改：`translator-v5/test/translation-batch.test.ts`

- [ ] **步骤 1：编写韩语检测、日韩结构、候选和残留失败测试**

```ts
test("detects Korean independently of und", () => {
  const detected = detectLanguage("그는 문을 열었다. 바람이 방 안으로 들어왔다.".repeat(8));
  assert.equal(detected?.id, "ko");
  assert.ok((detected?.confidence ?? 0) >= 0.8);
});

test("Japanese and Korean profiles expose structure and candidates", () => {
  const ja = getSourceLanguageProfile("ja");
  const ko = getSourceLanguageProfile("ko");
  assert.equal(ja.detectStructureHeading("甲源一刀流の巻")?.kind, "volume_heading");
  assert.equal(ja.detectStructureHeading("第十二章")?.kind, "chapter_heading");
  assert.equal(ko.detectStructureHeading("제12장")?.kind, "chapter_heading");
  assert.equal(ko.detectStructureHeading("■ 검은 숲 □")?.kind, "chapter_heading");
  assert.ok(ja.collectAnchorCandidates(cjkCandidateFixture("ja")).length > 0);
  assert.ok(ko.collectAnchorCandidates(cjkCandidateFixture("ko")).length > 0);
});

test("Hangul and Kana prose residue are reported without treating Han alone as Japanese", () => {
  assert.ok(getSourceLanguageProfile("ko").detectSourceResidue("译文仍有한국어句子").length > 0);
  assert.ok(getSourceLanguageProfile("ja").detectSourceResidue("译文仍有カタカナ").length > 0);
  assert.deepEqual(getSourceLanguageProfile("ja").detectSourceResidue("纯中文汉字"), []);
});
```

另测纯汉字短文本返回未确定或低置信；`ko-KR` 归一到 `ko`；`SourceLedger` 能 reopen 韩文 manifest。

- [ ] **步骤 2：运行测试并确认当前 ko 缺失、CJK 候选为零**

```powershell
node --test --import tsx test/language-profile.test.ts test/source-ledger.test.ts test/translation-batch.test.ts
```

预期：`ko` 注册、Hangul 检测、结构、候选和残留断言失败。

- [ ] **步骤 3：实现版本化日韩画像与通用 CJK 候选评分**

在 `language/types.ts` 中加入：

```ts
export type SourceScript = "latin" | "cyrillic" | "kana" | "hangul" | "han" | "unknown";
export interface BoundaryCandidate { scalarOffset: number; weight: number; kind: "paragraph" | "sentence" | "heading"; }
export interface ScriptStats { scalars: number; latin: number; han: number; kana: number; hangul: number; other: number; }
```

`SourceLanguageProfile` 增加 `scripts`、`collectBoundaryCandidates`、`collectScriptStats`。`ko` 使用 locale `ko`、Hangul residue 和韩文章节规则；`ja` 扩展章节规则和无空格句界。CJK 候选通过 `Intl.Segmenter`、重复度、位置分散、称谓/命名线索和停用词惩罚评分，最多 24 个。画像版本升级，旧语言画像身份自然失效。

- [ ] **步骤 4：运行画像、账本、锚定与翻译校验测试**

```powershell
node --test --import tsx test/language-profile.test.ts test/source-ledger.test.ts test/lexical-anchor.test.ts test/translation-batch.test.ts test/source-anomaly.test.ts
```

预期：全部 PASS；日/韩候选非空且不超过 24；中文目标中的纯汉字不被日语残留误报。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/language translator-v5/src/source/language-detector.ts translator-v5/src/source/structure-annotator.ts translator-v5/test/language-profile.test.ts translator-v5/test/source-ledger.test.ts translator-v5/test/lexical-anchor.test.ts translator-v5/test/translation-batch.test.ts
git commit -m "feat: add complete Japanese and Korean profiles"
```

---

### 任务 4：实现严格、可追溯的日韩编码策略

**文件：**
- 创建：`translator-v5/src/source/encoding-policy.ts`
- 修改：`translator-v5/src/source/source-importer.ts`
- 修改：`translator-v5/src/source/source-ledger.ts`
- 修改：`translator-v5/src/source/types.ts`
- 修改：`translator-v5/test/source-importer.test.ts`
- 修改：`translator-v5/test/source-ledger.test.ts`

- [ ] **步骤 1：为旧编码、歧义和 manifest 决策写失败测试**

使用小型硬编码 byte fixtures，不加入外部 iconv 依赖：

```ts
const ENCODED_FIXTURES = [
  { label: "shift_jis", bytes: Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), text: "日本語" },
  { label: "euc-jp", bytes: Buffer.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec]), text: "日本語" },
  { label: "euc-kr", bytes: Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]), text: "한국어" },
] as const;
```

逐项导入并断言 canonical 文本、encoding decision、raw SHA-256 和 0 U+FFFD。通过注入同分候选测试 `SOURCE_ENCODING_AMBIGUOUS`，断言 error 只包含允许编码，不包含源正文或任意路径。

- [ ] **步骤 2：运行导入/账本测试并确认旧编码被拒绝**

```powershell
node --test --import tsx test/source-importer.test.ts test/source-ledger.test.ts
```

预期：Shift-JIS、EUC-JP、EUC-KR/Windows-949 和 decision manifest 测试失败；既有 BOM/EPUB/DOCX 测试仍通过。

- [ ] **步骤 3：实现 `SourceEncodingPolicy` 并接入 importer/ledger**

```ts
export interface SourceEncodingDecision {
  canonicalLabel: string;
  decisionSource: "bom" | "strict_utf8" | "heuristic" | "user";
  confidence: number;
  alternatives: readonly EncodingAlternative[];
  diagnostics: readonly string[];
  policyVersion: string;
}

export function decodeSourceBytes(
  payload: Buffer,
  options?: { explicitEncoding?: string; languageHint?: string },
): DecodedSource;
```

顺序固定为 BOM、严格 UTF-8、有限候选。所有 `TextDecoder` 使用 `fatal:true`；`cp949` 归一为 `windows-949`。自动接受需要高置信且领先；否则抛出带安全 `alternatives` 的 `SourceImportError`。manifest 写 `encodingDecision`，ledger 对旧 manifest 生成兼容只读决定。source version 纳入 policy/profile 版本但不纳入机器路径。

- [ ] **步骤 4：运行导入、账本、覆盖和异常测试**

```powershell
node --test --import tsx test/source-importer.test.ts test/source-ledger.test.ts test/lossless-audit.test.ts test/source-anomaly.test.ts
```

预期：全部 PASS；原始 bytes 和 canonical 坐标覆盖不变。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/source translator-v5/test/source-importer.test.ts translator-v5/test/source-ledger.test.ts translator-v5/test/lossless-audit.test.ts
git commit -m "feat: add traceable East Asian encoding policy"
```

---

### 任务 5：把编码歧义安全接入桌面导入流程

**文件：**
- 创建：`translator-v5/src/desktop/renderer/src/components/EncodingChooser.tsx`
- 修改：`translator-v5/src/desktop/contracts.ts`
- 修改：`translator-v5/src/desktop/desktop-source-service.ts`
- 修改：`translator-v5/src/desktop/desktop-errors.ts`
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 修改：`translator-v5/src/desktop/renderer/src/types.ts`
- 修改：`translator-v5/src/desktop/renderer/src/components/Onboarding.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/test/desktop-source-service.test.ts`
- 修改：`translator-v5/test/desktop-ipc.test.ts`
- 修改：`translator-v5/test/desktop-main-security.test.ts`

- [ ] **步骤 1：编写 pending import、单次令牌和 renderer 安全失败测试**

```ts
test("ambiguous source import exposes only an opaque pending id and allowed encodings", async () => {
  const result = await service.beginImport({ sourcePath });
  assert.equal(result.status, "encoding_required");
  if (result.status !== "encoding_required") return;
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(sourcePath)));
  assert.deepEqual(result.encodings.sort(), ["euc-kr", "windows-949"].sort());
});

test("pending import ids are single-use and cannot select an arbitrary decoder", async () => {
  const pending = await ambiguousImport(service, sourcePath);
  await service.confirmEncoding({ pendingImportId: pending.id, encoding: pending.encodings[0]! });
  await assert.rejects(service.confirmEncoding({ pendingImportId: pending.id, encoding: pending.encodings[0]! }), /expired|used/i);
  await assert.rejects(service.confirmEncoding({ pendingImportId: "forged", encoding: "utf-7" }), /invalid/i);
});
```

UI 测试断言编码选择出现、取消不替换当前项目、确认后显示文件名/语言/编码；preload 没有 path-taking API。

- [ ] **步骤 2：运行桌面 source/IPC/security/UI 测试并确认失败**

```powershell
node --test --import tsx test/desktop-source-service.test.ts test/desktop-ipc.test.ts test/desktop-main-security.test.ts
npm run desktop:test
```

- [ ] **步骤 3：实现主进程 pending import 与固定 IPC**

`DesktopSourceService` 增加：

```ts
type DesktopSourceImportOutcome =
  | { status: "imported"; project: DesktopSourceImportResult }
  | { status: "encoding_required"; pendingImportId: string; fileName: string; encodings: readonly string[] };

beginImport(request: DesktopSourceImportRequest): Promise<DesktopSourceImportOutcome>;
confirmEncoding(request: { pendingImportId: string; encoding: string }): Promise<DesktopSourceImportResult>;
```

pending map 只在 main process 保存 real path、初始 hash、允许编码和过期时间；确认时重新校验 hash，成功/失败后销毁。IPC 新增固定 `folioloom:confirm-source-encoding`，payload 只接受 exact keys。`EncodingChooser` 只渲染返回枚举。

项目复用必须同时匹配 raw hash、语言画像和编码策略兼容性；旧 `und` 韩文项目不得覆盖新 `ko` 项目。

- [ ] **步骤 4：运行桌面全套与 production build**

```powershell
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
```

预期：0 failures；构建验证不包含真实源路径、fixture secret 或 pending token。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/desktop translator-v5/test/desktop-*.test.ts
git commit -m "feat: add safe desktop encoding negotiation"
```

---

### 任务 6：以完整请求预算替换四字符估算

**文件：**
- 创建：`translator-v5/src/source/token-estimator.ts`
- 创建：`translator-v5/src/agents/translation-request.ts`
- 创建：`translator-v5/src/fullbook/request-budgeter.ts`
- 创建：`translator-v5/test/token-estimator.test.ts`
- 创建：`translator-v5/test/request-budgeter.test.ts`
- 修改：`translator-v5/src/source/block-builder.ts`
- 修改：`translator-v5/src/source/types.ts`
- 修改：`translator-v5/src/fullbook/book-context.ts`
- 修改：`translator-v5/src/fullbook/types.ts`
- 修改：`translator-v5/src/fullbook/window-planner.ts`
- 修改：`translator-v5/src/fullbook/request-batcher.ts`
- 修改：`translator-v5/src/agents/translation-batch.ts`
- 修改：`translator-v5/test/block-builder.property.test.ts`
- 修改：`translator-v5/test/window-planner.test.ts`
- 修改：`translator-v5/test/translation-batch.test.ts`

- [ ] **步骤 1：写 CJK 密度、日语句界和完整载荷超限失败测试**

```ts
test("CJK is conservatively denser than Latin", () => {
  const estimator = new WeightedTokenEstimator();
  assert.ok(estimator.estimateText("彼は学校へ行く。".repeat(100), ja).tokens > 500);
  assert.ok(estimator.estimateText("그는 학교에 간다.".repeat(100), ko).tokens > 500);
  assert.ok(estimator.estimateText("He goes to school. ".repeat(100), en).tokens < 700);
});

test("Japanese blocks prefer a full stop without following whitespace", () => {
  const blocks = buildLosslessBlocks("彼は学校へ行く。彼は帰る。", [], {
    maxSourceTokens: 8,
    sourceVersion: "ja-v1",
    languageProfile: ja,
    tokenEstimator: new WeightedTokenEstimator(),
  });
  assert.equal(blocks[0]?.sourceText, "彼は学校へ行く。");
});

test("large memory and tool schemas split before transport", () => {
  const plans = budgetTranslationRequests(fixtureWithLargeProjection(), modelLimits);
  assert.ok(plans.length > 1);
  assert.ok(plans.every((plan) => plan.budget.totalReserved <= modelLimits.contextWindow));
});
```

属性测试继续断言所有块严格重构原文。

- [ ] **步骤 2：运行测试并确认固定 `/4` 与 source-only batcher 失败**

```powershell
node --test --import tsx test/token-estimator.test.ts test/request-budgeter.test.ts test/block-builder.property.test.ts test/window-planner.test.ts test/translation-batch.test.ts
```

- [ ] **步骤 3：实现估算器、唯一载荷构造和三层容量门**

`WeightedTokenEstimator` 按规格权重统计 Unicode scalar，并返回 `tokens`、`uncertainty`、`estimatorVersion`。`observeUsage` 对模型+画像维护截断在安全区间内的指数平滑倍率。

`translation-request.ts` 唯一构造：

```ts
export interface PreparedTranslationRequest {
  systemPrompt: string;
  prompt: string;
  tools: readonly TypedToolSpec[];
  serializedToolSchemas: string;
}

export function prepareTranslationRequest(input: TranslationBatchInput): PreparedTranslationRequest;
```

`runTranslationBatch` 和 `RequestBudgeter` 均调用它，不能各自拼 prompt。预算结果包含固定提示、原文、术语、记忆、风格、工具、输出、reasoning reserve 和安全余量。`packPhysicalRequests` 接收对实际投影估算后的 `totalReserved`；超限先拆 request，再拆窗口/块。block ID 或 derived plan protocol 纳入 estimator version，旧计划不复用。

- [ ] **步骤 4：运行所有 source、window、batch 与恢复测试**

```powershell
node --test --import tsx test/token-estimator.test.ts test/request-budgeter.test.ts test/block-builder.property.test.ts test/book-context.test.ts test/window-planner.test.ts test/translation-batch.test.ts test/book-runner.test.ts test/fault-injection.test.ts
```

预期：全部 PASS；高密度 CJK fixture 无 oversized request；覆盖审计仍为 100%。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/source translator-v5/src/agents/translation-request.ts translator-v5/src/agents/translation-batch.ts translator-v5/src/fullbook translator-v5/test/token-estimator.test.ts translator-v5/test/request-budgeter.test.ts translator-v5/test/block-builder.property.test.ts translator-v5/test/book-context.test.ts translator-v5/test/window-planner.test.ts translator-v5/test/translation-batch.test.ts translator-v5/test/book-runner.test.ts translator-v5/test/fault-injection.test.ts
git commit -m "feat: budget complete translation requests"
```

---

### 任务 7：实现显式快速模式、升级运行时和自适应并发

**文件：**
- 创建：`translator-v5/src/fullbook/adaptive-scheduler.ts`
- 创建：`translator-v5/test/adaptive-scheduler.test.ts`
- 修改：`translator-v5/src/fullbook/types.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/src/agents/translation-batch.ts`
- 修改：`translator-v5/src/agents/repairer.ts`
- 修改：`translator-v5/src/agents/pi-runtime.ts`
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 修改：`translator-v5/src/config.ts`
- 修改：`translator-v5/src/cli.ts`
- 修改：`translator-v5/test/book-runner.test.ts`
- 修改：`translator-v5/test/cli.test.ts`
- 修改：`translator-v5/test/fault-injection.test.ts`

- [ ] **步骤 1：写 quality/fast effort、AIMD 与恢复失败测试**

```ts
test("quality mode never changes the selected high effort", async () => {
  const calls = await runEffortFixture({ mode: "quality", selectedEffort: "high" });
  assert.deepEqual(new Set(calls.map((call) => call.effort)), new Set(["high"]));
});

test("fast mode uses off first and high only for the invalid window retry", async () => {
  const calls = await runEffortFixture({ mode: "fast", selectedEffort: "high", failWindow: 1 });
  assert.equal(calls.filter((call) => call.effort === "off").length, 2);
  assert.deepEqual(calls.filter((call) => call.effort === "high").map((call) => call.windowId), ["window-1"]);
});

test("scheduler grows additively and halves on retryable congestion", () => {
  const scheduler = new AdaptiveScheduler({ initialConcurrency: 2, maxConcurrency: 6, maxInFlightTokens: 20_000 });
  scheduler.observe({ status: "success", durationMs: 100, estimatedTokens: 2_000 });
  assert.equal(scheduler.snapshot().concurrency, 3);
  scheduler.observe({ status: "throttled", durationMs: 100, estimatedTokens: 2_000 });
  assert.equal(scheduler.snapshot().concurrency, 1);
});
```

另测：context-limit 走拆包而非降载；auth/quota 立即中止；scheduler snapshot 恢复后保持降载；快速模式未显式选择时不能启用。

- [ ] **步骤 2：运行 runner/CLI/scheduler 测试并确认失败**

```powershell
node --test --import tsx test/adaptive-scheduler.test.ts test/book-runner.test.ts test/cli.test.ts test/fault-injection.test.ts
```

- [ ] **步骤 3：实现双 runtime、类型化 provider 错误和有界调度**

```ts
export type TranslationRunMode = "quality" | "fast";

export interface TranslationRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
  effort?: ProviderEffort;
}

export interface TranslationRuntimeSet {
  mode: TranslationRunMode;
  primary: TranslationRuntime;
  escalation: TranslationRuntime;
}
```

`quality` 的 primary/escalation 相同。`fast` 的 primary 使用 provider 支持的最低成本 effort，escalation 使用用户配置 effort。`runTranslationBatch` 的 repair runtime 单独传入；工具/完整性/术语/残留失败只局部使用 escalation。

`ModelProviderError` 增加 `kind: auth|quota|throttled|timeout|busy|context|protocol|unknown` 和 `retryable`。runner 对 throttled/timeout/busy 观察并降载后有界重试，对 context 回预算器拆分，对 auth/quota 立即返回外部失败且不建人工语义任务。

CLI 增加 `--run-mode quality|fast` 和 `--max-in-flight-tokens`；`withReasoningEffort(config, effort)` 创建第二 runtime，API Key 不复制到日志。run metadata 保存 mode、primary/escalation effort 和 scheduler snapshot。

- [ ] **步骤 4：运行 runner、恢复、存储与 CLI 测试**

```powershell
node --test --import tsx test/adaptive-scheduler.test.ts test/book-runner.test.ts test/fault-injection.test.ts test/lossless-book-store.test.ts test/recovery-engine.test.ts test/cli.test.ts test/config.test.ts
```

预期：全部 PASS；并发完成顺序仍不改变逻辑提交顺序。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/fullbook translator-v5/src/agents translator-v5/src/storage/lossless-book-store.ts translator-v5/src/config.ts translator-v5/src/cli.ts translator-v5/test/adaptive-scheduler.test.ts translator-v5/test/book-runner.test.ts translator-v5/test/fault-injection.test.ts translator-v5/test/lossless-book-store.test.ts translator-v5/test/recovery-engine.test.ts translator-v5/test/cli.test.ts translator-v5/test/config.test.ts
git commit -m "feat: add explicit fast translation scheduling"
```

---

### 任务 8：把运行模式和日韩诊断接入桌面试译

**文件：**
- 修改：`translator-v5/src/desktop/contracts.ts`
- 修改：`translator-v5/src/desktop/desktop-project-service.ts`
- 修改：`translator-v5/src/desktop/desktop-trial-service.ts`
- 修改：`translator-v5/src/desktop/main/provider-model-adapter.ts`
- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 修改：`translator-v5/src/desktop/renderer/src/components/Onboarding.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/test/desktop-trial-service.test.ts`
- 修改：`translator-v5/test/desktop-project-service.test.ts`
- 修改：`translator-v5/test/desktop-ipc.test.ts`

- [ ] **步骤 1：编写试译模式和项目诊断失败测试**

UI 显式显示“精细试译/快速试译”；默认精细。IPC 只接受 `mode: "quality" | "fast"`，拒绝任意字符串。项目卡片显示 `检测为日语/韩语`、canonical encoding 和置信度，但不显示 manifest/SQLite 等内部术语。

```ts
test("desktop trial passes an explicit run mode and never infers fast from high", async () => {
  await trial.start({ manifestPath, mode: "quality" });
  assert.equal(runBookCalls[0]?.runtimeSet.mode, "quality");
  assert.equal(runBookCalls[0]?.runtimeSet.primary.effort, "high");
});
```

- [ ] **步骤 2：运行 desktop trial/IPC/UI 测试并确认失败**

```powershell
node --test --import tsx test/desktop-trial-service.test.ts test/desktop-project-service.test.ts test/desktop-ipc.test.ts
npm run desktop:test
```

- [ ] **步骤 3：实现 mode DTO、双 runtime composition 和用户文案**

`DesktopTrialService` 从已保存 profile 创建 runtime set；quality 保持选定 effort，fast 创建 off/最低合法 primary。项目 snapshot 增加只读 `sourceEncoding`、`encodingConfidence`、`languageProfileVersion`。Renderer 只发送 mode，不发送 model、path 或 credential。

- [ ] **步骤 4：运行桌面全套、类型检查和 build**

```powershell
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
```

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/desktop translator-v5/test/desktop-*.test.ts
git commit -m "feat: expose explicit desktop translation modes"
```

---

### 任务 9：建立不泄漏正文的日韩真实基准工具

**文件：**
- 创建：`translator-v5/src/benchmark/cjk-benchmark.ts`
- 创建：`translator-v5/test/cjk-benchmark.test.ts`
- 修改：`translator-v5/package.json`
- 修改：`translator-v5/.gitignore` 或仓库根 `.gitignore`
- 修改：`translator-v5/README.md`

- [ ] **步骤 1：编写段落抽样、哈希和报告去正文失败测试**

```ts
test("benchmark selects complete paragraphs and reports hashes without prose", () => {
  const sample = selectBenchmarkSample(fixtureText, 200_000);
  assert.equal(sample.text.length <= 205_000, true);
  assert.equal(sample.text.endsWith("\n") || /[.!?。！？]$/u.test(sample.text), true);
  const report = benchmarkReport(sample, fixtureMetrics);
  assert.equal("text" in report, false);
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(report), /fixture secret sentence/u);
});
```

另测 UTF-8 BOM、Unicode scalar 计数、韩文 200k 上限、日文全样本模式和缺失环境变量的明确错误。

- [ ] **步骤 2：运行基准单测并确认入口缺失**

```powershell
node --test --import tsx test/cjk-benchmark.test.ts
```

- [ ] **步骤 3：实现本地挂载、pilot/正式试跑和去敏报告**

脚本读取：

```text
FOLIOLOOM_JA_SOURCE
FOLIOLOOM_KO_SOURCE
FOLIOLOOM_BENCH_CONFIG
FOLIOLOOM_OPENCODE_AUTH
FOLIOLOOM_BENCH_OUTPUT
```

先导入并运行 doctor，再执行每种语言 20k quality/high 与 fast 对照；门槛通过后运行完整日文样本和约 200k 韩文。报告只保存哈希、scalar 范围、画像/估算器版本、模型、mode、effort、usage、请求/重试、错误分类、吞吐、覆盖和校验统计。质量抽样正文仅存本机 ignore 目录。

`package.json` 增加：

```json
"benchmark:cjk": "tsx src/benchmark/cjk-benchmark.ts"
```

- [ ] **步骤 4：运行离线基准单测和 CLI help/parse 测试**

```powershell
node --test --import tsx test/cjk-benchmark.test.ts test/cli.test.ts
```

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/benchmark translator-v5/test/cjk-benchmark.test.ts translator-v5/package.json translator-v5/package-lock.json translator-v5/README.md .gitignore
git commit -m "test: add private CJK translation benchmark"
```

---

### 任务 10：以分帧正文协议消除快速模式的大型 JSON 瓶颈

**文件：**
- 创建：`translator-v5/src/agents/framed-translation-protocol.ts`
- 创建：`translator-v5/test/framed-translation-protocol.test.ts`
- 修改：`translator-v5/src/agents/translation-request.ts`
- 修改：`translator-v5/src/agents/translation-batch.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/test/translation-request.test.ts`
- 修改：`translator-v5/test/translation-batch.test.ts`
- 修改：`translator-v5/test/book-runner.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖请求专属 nonce、含中文引号和换行的原始正文、错误 nonce 不能注入、重复/未知/缺失 block 拒绝、fast 无工具、quality 仍使用工具、归一化与锁定术语不回归。

- [ ] **步骤 2：实现唯一协议构造与严格解析器**

`TranslationRequestInput` 增加默认值为 `typed_tool` 的响应协议。`prepareTranslationRequest` 是提示、工具列表与预算的唯一构造入口；分帧模式返回空工具列表和请求专属标记说明。解析器只把当前请求已知 block 映射回其逻辑 window，随后复用同一个 submission 校验器。

- [ ] **步骤 3：接入快速模式与有限恢复**

runner 只在 `runtimeSet.mode === "fast"` 时选择 `framed_text`。Pi runtime 单轮、无工具执行；结构错误只对失败单窗口按不可变 block 切分，次数和深度有界。质量模式和其他代理工具协议不变。

- [ ] **步骤 4：运行定向回归和真实 20k 韩语 pilot**

预期覆盖率 100%、0 人工任务、0 协议违规；模型调用接近一次锚定加物理请求数，并比深层 JSON 方案明显降低墙钟时间。达不到门槛时不得扩大样本。

- [ ] **步骤 5：提交**

```powershell
git add translator-v5/src/agents translator-v5/src/fullbook/book-runner.ts translator-v5/test docs/superpowers STATE.md
git commit -m "perf: stream fast translations in nonce frames"
```

---

### 任务 11：阶段集成审查、真实 API 验证与发行构建

**文件：**
- 创建：`docs/superpowers/reports/2026-07-22-cjk-desktop-validation.md`
- 修改：`STATE.md`
- 可能修改：综合审查中有可复现 Critical/Important 的相关文件

- [ ] **步骤 1：运行无付费全量门禁**

```powershell
Set-Location translator-v5
npm run typecheck
npm test
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
```

预期：所有命令 exit 0；测试统计和唯一允许的 skip 写入报告；`git diff --check` 无输出。

- [ ] **步骤 2：分派一次综合审查并处理阻塞问题**

向独立审查代理提供规格、计划、base/head、测试输出和已知风险，同时检查：规格覆盖、探针 wire、源账本/编码、token 预算、分帧协议与并发恢复、密钥安全、GUI 状态和测试有效性。只有包含位置、复现和原因的 Critical/Important 阻塞。修复后运行原复现，并让原审查代理仅做一次定向复核。

- [ ] **步骤 3：用真实 DeepSeek V4 Flash/high 复测桌面能力探针**

通过桌面正式 IPC/服务路径测试 `deepseek-v4-flash` + `high`，不得使用诊断 wrapper 改写请求。记录 `ready`、检查项、请求数、终止原因、总耗时和去敏 usage；API Key 不写入任何报告或 shell 输出。

- [ ] **步骤 4：运行真实 20k 对照和指定规模日韩基准**

```powershell
$env:FOLIOLOOM_JA_SOURCE='D:\llm\qikan4\大菩薩峠 01 甲源一刀流の巻 (中里 介山 [中里 介山]) (z-library.sk, 1lib.sk, z-lib.sk).txt'
$env:FOLIOLOOM_KO_SOURCE='D:\llm\qikan4\묵향 1-37권 (전동조) (z-library.sk, 1lib.sk, z-lib.sk).txt'
$env:FOLIOLOOM_BENCH_CONFIG='D:\llm\小说翻译\.worktrees\folioloom-desktop\.local\benchmark\deepseek-v4-flash.yaml'
$env:FOLIOLOOM_OPENCODE_AUTH='C:\Users\admin\.local\share\opencode\auth.json'
$env:FOLIOLOOM_BENCH_OUTPUT='D:\llm\小说翻译\.worktrees\folioloom-desktop\.local\benchmark\output'
npm run benchmark:cjk
```

预期：先完成 20k quality/fast 对照；若无未解决协议/覆盖/容量错误，再完成日文全样本与约 200k 韩文。外部持续限流时保存证据、降载并恢复，不放宽内部质量门。

- [ ] **步骤 5：对日韩译文做独立质量抽检**

从每种语言的开头、中段、结尾各选不泄漏到仓库的短片段，交由至少两个独立审查视角检查忠实、可读、人物/称谓一致、残留、段落/引号和凭空增写。把结论、分歧和匿名 block hash 写入报告，不复制正文。

- [ ] **步骤 6：执行 production Electron 最小端到端 smoke**

在 unpacked 应用中依次验证：启动、选择 UTF-8 日文、选择 UTF-8 BOM 韩文、显示正确语言/编码、模型表单恢复、真实连接测试、quality/fast 短试译、失败提示、忘记密钥、关闭应用。另用合成 Shift-JIS/CP949 fixture 验证编码确认 UI。所有打开的测试窗口和浏览器标签随后关闭。

- [ ] **步骤 7：写验证报告并运行最终门禁**

报告逐项对应规格第 17 节，包含命令、exit code、测试数、构建产物、真实基准指标、审查结论和未承诺功能。然后重新运行：

```powershell
npm run typecheck
npm test
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
git diff --check
git status --short
```

只有新鲜输出全部支持完成定义，才能声明完成。

- [ ] **步骤 8：提交验证报告与最终修复**

```powershell
git add docs/superpowers/reports/2026-07-22-cjk-desktop-validation.md STATE.md translator-v5
git commit -m "test: validate FolioLoom CJK desktop workflow"
```

---

## 计划自检

- 规格目标均有任务映射：探针（任务 1）、GUI 状态（任务 2/5/8）、日韩画像（任务 3）、编码（任务 4/5）、完整预算（任务 6）、快速模式和自适应调度（任务 7）、真实基准（任务 9）、快速正文协议（任务 10）、最终质量与发行验证（任务 11）。
- 没有把全书 GUI、EPUB 生成或外部 tokenizer 扩入本轮。
- 每项生产代码均在对应失败测试之后；真实付费调用只在无付费门禁和综合审查之后。
- 数据格式、IPC、并发、密钥和旧项目兼容均设置阶段检查点。
- 真实小说正文、API Key、源路径和模型原始响应不会进入提交。
