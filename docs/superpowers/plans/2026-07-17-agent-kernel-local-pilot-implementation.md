# V5 Agent Kernel 局部翻译试验实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `executing-plans` 在当前专用
> worktree 中逐任务执行本计划。步骤使用复选框跟踪。不要自动启用子代理；本试验
> 由当前会话内联执行，以保持 Pi 协议、真实模型试跑和诊断上下文连续。

**目标：** 建立一个 TypeScript + Pi Agent Kernel 垂直原型，在不读取 V4 叙事
快照、不执行全书模型预扫描的条件下，翻译提丰片段 `global_index=219..223`，并
输出可读 TXT 与完整审计报告。

**架构：** TypeScript Kernel 掌握作用域、预算、可见性、证据验证、锁和提交；
Pi 只通过 allowlist typed tools 执行问题发现、证据检索、翻译和一次语义修复。
V4 SQLite 只读适配器提供原文和稳定术语；全书检索索引由本地 SQLite FTS5 构建，
不调用模型。所有 Pi 会话短生命周期，最终状态写入独立 pilot store。

**技术栈：** Node.js 24、TypeScript、Node `node:sqlite`、Node test runner、
`@earendil-works/pi-agent-core@0.80.10`、`@earendil-works/pi-ai@0.80.10`、
TypeBox、YAML、DeepSeek OpenAI-compatible endpoint。

---

## 文件边界

### 项目与配置

- 创建 `translator-v5/package.json`：锁定运行和测试依赖，定义 test/typecheck/pilot。
- 创建 `translator-v5/tsconfig.json`：NodeNext、strict、noEmit。
- 修改 `.gitignore`：忽略 `translator-v5/node_modules`、构建物和本地 pilot artifact。
- 创建 `translator-v5/src/config.ts`：只读取显式 `--config` 路径，返回脱敏模型配置。

### 领域与确定性内核

- 创建 `translator-v5/src/domain/types.ts`：块、术语、问题、证据、判断、快照和译文。
- 创建 `translator-v5/src/kernel/budget.ts`：硬预算账本与拒绝原因。
- 创建 `translator-v5/src/kernel/capabilities.ts`：typed tool allowlist 和前置校验。
- 创建 `translator-v5/src/kernel/event-log.ts`：结构化事件及耗时/usage 统计。
- 创建 `translator-v5/src/kernel/run-lease.ts`：基于 exclusive lock 的单 run 租约。

### 只读数据与本地检索

- 创建 `translator-v5/src/storage/v4-read-adapter.ts`：只查询 `blocks` 和稳定术语表。
- 创建 `translator-v5/src/index/evidence-index.ts`：段落拆分、FTS5、本地查询和 evidence ID。
- 创建 `translator-v5/src/index/query-compiler.ts`：受限 QuerySpec 到检索操作。

### Pi 与 Agent

- 创建 `translator-v5/src/agents/pi-runtime.ts`：Pi Agent、DeepSeek streamFn 和 faux 注入点。
- 创建 `translator-v5/src/agents/question-scout.ts`：目标疑问发现。
- 创建 `translator-v5/src/agents/evidence-resolver.ts`：有界检索循环与判断提交。
- 创建 `translator-v5/src/agents/translator.ts`：按章节 island 翻译和按需查证。
- 创建 `translator-v5/src/agents/repairer.ts`：只处理明确校验失败的一轮修复。

### Tools、校验、运行与报告

- 创建 `translator-v5/src/tools/research-tools.ts`：问题提交、mentions/cooccurrence/context。
- 创建 `translator-v5/src/tools/translation-tools.ts`：术语、连续性、证据、最终候选。
- 创建 `translator-v5/src/tools/repair-tools.ts`：失败读取和修复候选。
- 创建 `translator-v5/src/validators/translation-validator.ts`：块覆盖、段落和空译检查。
- 创建 `translator-v5/src/pilot-runner.ts`：端到端状态机。
- 创建 `translator-v5/src/cli.ts`：`preview` CLI。
- 创建 `translator-v5/src/report.ts`：TXT、bilingual TXT、audit JSON 和 metrics JSON。

### 测试

- 创建 `translator-v5/test/kernel.test.ts`：预算、不变量、锁和事件。
- 创建 `translator-v5/test/evidence-index.test.ts`：FTS、位置边界、稳定 evidence ID。
- 创建 `translator-v5/test/pi-runtime.test.ts`：Pi faux provider 的真实工具循环。
- 创建 `translator-v5/test/research-agent.test.ts`：问题发现、检索改写和 unresolved。
- 创建 `translator-v5/test/translation-agent.test.ts`：按需工具与候选提交。
- 创建 `translator-v5/test/pilot-runner.test.ts`：冷局部端到端，证明不触碰 narrative 表。

---

### 任务 1：建立 TypeScript/Pi 可运行骨架

**文件：**
- 创建：`translator-v5/package.json`
- 创建：`translator-v5/tsconfig.json`
- 修改：`.gitignore`
- 创建：`translator-v5/src/config.ts`
- 测试：`translator-v5/test/config.test.ts`

- [x] **步骤 1：编写失败的配置测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadPilotConfig } from "../src/config.js";

test("loads the selected DeepSeek role without exposing the key in JSON", () => {
  const config = loadPilotConfig(fixturePath("config.yaml"), "draft");
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.reasoningEffort, "high");
  assert.equal(JSON.stringify(config).includes("secret-test-key"), false);
  assert.equal(config.apiKeyForRuntime(), "secret-test-key");
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`cd translator-v5 && npm test -- --test-name-pattern="loads the selected"`  
预期：FAIL，`src/config.ts` 不存在。

- [x] **步骤 3：创建 package/tsconfig 并安装锁定依赖**

`package.json` 必须包含：

```json
{
  "type": "module",
  "scripts": {
    "test": "node --test --import tsx test/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "pilot": "tsx src/cli.ts"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.80.10",
    "@earendil-works/pi-ai": "0.80.10",
    "yaml": "2.9.0"
  },
  "devDependencies": {
    "@types/node": "24.10.1",
    "tsx": "4.23.1",
    "typescript": "7.0.2"
  }
}
```

运行：`npm install --ignore-scripts`。提交 `package-lock.json`。

- [x] **步骤 4：实现脱敏配置加载器**

```ts
export interface PilotModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  reasoningEffort: string;
  apiKeyForRuntime(): string;
  toJSON(): Record<string, unknown>;
}
```

配置只从显式路径读取。`toJSON()` 不得包含 key；event log 禁止接收包含
`apiKeyForRuntime` 返回值的对象。

- [x] **步骤 5：运行测试和类型检查**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 6：Commit**

```bash
git add .gitignore translator-v5
git commit -m "build: scaffold v5 pi pilot"
```

---

### 任务 2：实现预算、能力和租约内核

**文件：**
- 创建：`translator-v5/src/domain/types.ts`
- 创建：`translator-v5/src/kernel/budget.ts`
- 创建：`translator-v5/src/kernel/capabilities.ts`
- 创建：`translator-v5/src/kernel/event-log.ts`
- 创建：`translator-v5/src/kernel/run-lease.ts`
- 测试：`translator-v5/test/kernel.test.ts`

- [x] **步骤 1：编写预算和能力失败测试**

```ts
test("rejects the ninth research tool call without running it", async () => {
  const budget = new BudgetLedger({ researchToolCalls: 8 });
  for (let i = 0; i < 8; i++) budget.consume("researchToolCalls", 1);
  assert.throws(() => budget.consume("researchToolCalls", 1), BudgetExceeded);
});

test("does not register generic filesystem or shell capabilities", () => {
  const names = createCapabilityRegistry(fixtureContext()).names();
  assert.deepEqual(names.includes("bash"), false);
  assert.deepEqual(names.includes("read_file"), false);
  assert.deepEqual(names.includes("execute_sql"), false);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="rejects|does not register"`  
预期：FAIL，Kernel 类型未定义。

- [x] **步骤 3：实现状态和硬预算**

```ts
export type BudgetCounter =
  | "modelCalls"
  | "researchTurns"
  | "researchToolCalls"
  | "evidenceChars"
  | "translationTurns"
  | "translationToolCalls"
  | "repairTurns";

export class BudgetLedger {
  consume(counter: BudgetCounter, amount: number): void;
  remaining(counter: BudgetCounter): number;
  snapshot(): Readonly<Record<BudgetCounter, number>>;
}
```

默认上限来自规格：20 个模型调用、8 个研究工具调用、12,000 个 off-target
证据字符、每个 island 3 个翻译 turn、30 分钟 abort deadline。

- [x] **步骤 4：实现能力注册、事件和租约**

```ts
export interface KernelTool<Args, Result> {
  readonly name: string;
  readonly phase: "research" | "translation" | "repair";
  execute(args: Args, signal: AbortSignal): Promise<Result>;
}
```

`RunLease.acquire(path, runKey)` 使用 exclusive create；重复 run key 立即失败。释放只
删除自己 token 对应的 lock。事件记录 `started/tool/model/validation/degraded/finished`，
每条带 monotonically increasing sequence。

- [x] **步骤 5：补充并发租约和事件排序测试并运行**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 6：Commit**

```bash
git add translator-v5/src/domain translator-v5/src/kernel translator-v5/test/kernel.test.ts
git commit -m "feat: add bounded agent kernel"
```

---

### 任务 3：实现冷局部 V4 只读适配器与证据索引

**文件：**
- 创建：`translator-v5/src/storage/v4-read-adapter.ts`
- 创建：`translator-v5/src/index/evidence-index.ts`
- 创建：`translator-v5/src/index/query-compiler.ts`
- 测试：`translator-v5/test/evidence-index.test.ts`

- [x] **步骤 1：创建最小 SQLite fixture 并编写失败测试**

```ts
test("narrative-before queries never return later evidence", () => {
  const index = buildFixtureIndex([
    paragraph(10, "Typhon spoke."),
    paragraph(30, "Typhon was later explained."),
  ]);
  const hits = index.searchMentions({
    terms: ["Typhon"], channel: "narrative_before_target",
    targetGlobalIndex: 20, limit: 8,
  });
  assert.deepEqual(hits.map((hit) => hit.globalIndex), [10]);
});

test("cold adapter exposes no narrative table methods", () => {
  const adapter = new V4ReadAdapter(fixtureDb);
  assert.equal("loadNarrativeMemories" in adapter, false);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="narrative-before|cold adapter"`  
预期：FAIL。

- [x] **步骤 3：实现 read-only V4 adapter**

仅允许以下查询：

```sql
SELECT id, legacy_id, chapter_id, chapter_title, global_index,
       block_index, source_text, source_hash, token_count
FROM blocks
ORDER BY global_index;
```

稳定术语只读取 `concepts/concept_lexemes/lexemes/source_forms`，选择优先级为
`verified_target > working_target > default_target`；人工锁定项优先。代码中不出现
`narrative_snapshots`、`narrative_memories`、`premap_results` 查询。

- [x] **步骤 4：实现段落 FTS5 索引和稳定 evidence ID**

```ts
export interface EvidenceHit {
  evidenceId: string;
  blockId: string;
  globalIndex: number;
  paragraphIndex: number;
  quote: string;
  sourceHash: string;
  channel: VisibilityChannel;
}
```

ID 为 `sha256(blockId + paragraphIndex + normalizedQuote + sourceHash)` 的稳定前缀。
FTS 仅保存源文段落和位置，不保存模型解释。

- [x] **步骤 5：实现受限查询编译器**

只支持 `mentions/cooccurrence/context/nearest`；拒绝原始 SQL 和任意表名。检索结果
按通道过滤后再按 BM25、位置距离和稳定 tie-break 排序。

- [x] **步骤 6：运行测试和类型检查**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 7：Commit**

```bash
git add translator-v5/src/storage translator-v5/src/index translator-v5/test/evidence-index.test.ts
git commit -m "feat: index bounded source evidence"
```

---

### 任务 4：实现 typed research/translation tools 与不变量

**文件：**
- 创建：`translator-v5/src/tools/research-tools.ts`
- 创建：`translator-v5/src/tools/translation-tools.ts`
- 创建：`translator-v5/src/tools/repair-tools.ts`
- 测试：`translator-v5/test/tools.test.ts`

- [x] **步骤 1：编写非法 ID、未来泄漏和预算失败测试**

```ts
test("submit_resolution rejects evidence outside the query channel", async () => {
  await assert.rejects(
    tools.submitResolution({
      questionId: "q1", verdict: "same entity", confidence: 0.9,
      evidenceIds: [futureEvidence.id], unresolved: "",
    }),
    /evidence visibility violation/,
  );
});

test("invented subject ids are rejected before search", async () => {
  await assert.rejects(
    tools.searchMentions({ subjectIds: ["invented"], channel: "translator_global", limit: 8 }),
    /unknown subject/,
  );
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="visibility violation|invented subject"`  
预期：FAIL。

- [x] **步骤 3：用 TypeBox 定义 allowlist tools**

工具包括：

```text
submit_questions
lookup_subjects
lookup_terms
search_mentions
search_cooccurrence
get_evidence_context
submit_resolution
finish_research
get_required_context
inspect_local_continuity
retrieve_resolved_evidence
inspect_style_state
finalize_translation
inspect_validation_failures
submit_repaired_translation
```

每个 tool execute 先通过 Kernel 校验和 budget consume；所有 evidence 返回值裁剪到
工具与总预算上限。

- [x] **步骤 4：实现写候选而非写活动状态**

`submit_resolution/finalize_translation/submit_repaired_translation` 只写当前 run 的
内存 candidate collector。Kernel 在 Agent 结束后验证并决定是否提交 pilot store。

- [x] **步骤 5：运行测试和类型检查**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 6：Commit**

```bash
git add translator-v5/src/tools translator-v5/test/tools.test.ts
git commit -m "feat: expose bounded translation capabilities"
```

---

### 任务 5：接入真实 Pi Agent loop 和 DeepSeek provider

**文件：**
- 创建：`translator-v5/src/agents/pi-runtime.ts`
- 测试：`translator-v5/test/pi-runtime.test.ts`

- [x] **步骤 1：用 Pi faux provider 编写真实工具循环失败测试**

```ts
test("Pi executes an allowlisted tool and stops on terminating submit", async () => {
  const faux = scriptedPi([
    toolCall("search_mentions", { subjectIds: ["typhon"], channel: "narrative_before_target", limit: 4 }),
    toolCall("finish_research", { unresolvedQuestionIds: [] }),
  ]);
  const result = await runtime.run(sessionSpec, faux.streamFn);
  assert.deepEqual(result.toolNames, ["search_mentions", "finish_research"]);
  assert.equal(result.modelCalls, 2);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="Pi executes"`  
预期：FAIL。

- [x] **步骤 3：实现 Pi runtime**

使用 `Agent` 而非低层 `agentLoop`，以便 `beforeToolCall` 成为执行屏障：

```ts
const agent = new Agent({
  initialState: { systemPrompt, model, thinkingLevel: "high", tools, messages: [] },
  streamFn,
  toolExecution: "parallel",
  beforeToolCall: ({ toolCall, args }) => kernel.preflight(toolCall.name, args),
  afterToolCall: ({ toolCall, result, isError }) => kernel.audit(toolCall, result, isError),
});
```

event subscriber 统计 `turn_start` 为模型调用，记录 usage、工具、耗时和 stop reason。

- [x] **步骤 4：实现 DeepSeek OpenAI-compatible streamFn**

创建 `Model<"openai-completions">`：

```ts
{
  id: config.model,
  provider: "translator-v5-deepseek",
  api: "openai-completions",
  baseUrl: config.baseUrl,
  reasoning: true,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 37200,
  compat: {
    thinkingFormat: "deepseek",
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true
  }
}
```

`streamFn` 通过 `openAICompletionsApi` 或直接 `streamSimple` 注入运行时 key，不把
key 写入 Agent state、event log 或错误正文。

- [x] **步骤 5：测试 abort、非法工具阻止和 usage 统计**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 6：Commit**

```bash
git add translator-v5/src/agents/pi-runtime.ts translator-v5/test/pi-runtime.test.ts
git commit -m "feat: run bounded pi sessions"
```

---

### 任务 6：实现 Question Scout、Evidence Resolver 和暂定快照

**文件：**
- 创建：`translator-v5/src/agents/question-scout.ts`
- 创建：`translator-v5/src/agents/evidence-resolver.ts`
- 创建：`translator-v5/src/domain/provisional-snapshot.ts`
- 测试：`translator-v5/test/research-agent.test.ts`

- [x] **步骤 1：编写 scripted Pi 研究测试**

```ts
test("research agent refines Typhon/Piaton evidence without prefix scanning", async () => {
  const outcome = await runResearchWithScript(typhonFixture, [
    submitQuestions([relationQuestion("Typhon", "Piaton")]),
    searchCooccurrence(["Typhon", "Piaton"], ["body", "head", "voice"]),
    submitResolution("shared body with distinct control", ["ev-1", "ev-2"]),
    finishResearch([]),
  ]);
  assert.equal(outcome.snapshot.coverage.completePrefix, false);
  assert.ok(outcome.snapshot.evidenceIds.length > 0);
  assert.ok(outcome.metrics.offTargetEvidenceChars <= 12_000);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="refines Typhon"`  
预期：FAIL。

- [x] **步骤 3：实现 Question Scout 提示和提交门**

Scout 必须通过 `submit_questions`，问题类型限于：

```text
entity_identity, entity_relation, term_sense, coreference,
narrative_visibility, discourse_role, local_continuity
```

Kernel 自动加入未解析目标专名对应的强制问题；Scout 不能删除强制问题。

- [x] **步骤 4：实现 Evidence Resolver 与停止规则**

Resolver 只看到问题、已知 subject IDs、工具说明和剩余预算。`finish_research` 前
每个高影响问题必须处于 `resolved` 或 `unresolved`。达到三 turn 或预算时由 Kernel
强制结束并填充 unresolved。

- [x] **步骤 5：构建 provisional snapshot**

快照包含问题、判断、证据、通道、目标范围、覆盖范围、未决项、source hashes、
protocol/model hash。`translator_global` 判断进入单独的 translator facts，不进入
narrative-visible facts。

- [x] **步骤 6：运行测试和类型检查**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 7：Commit**

```bash
git add translator-v5/src/agents/question-scout.ts translator-v5/src/agents/evidence-resolver.ts translator-v5/src/domain/provisional-snapshot.ts translator-v5/test/research-agent.test.ts
git commit -m "feat: research local translation evidence"
```

---

### 任务 7：实现按需 Translation Agent、校验和一次修复

**文件：**
- 创建：`translator-v5/src/agents/translator.ts`
- 创建：`translator-v5/src/agents/repairer.ts`
- 创建：`translator-v5/src/validators/translation-validator.ts`
- 测试：`translator-v5/test/translation-agent.test.ts`

- [x] **步骤 1：编写按章节 island 翻译失败测试**

```ts
test("translation agent receives minimal context and may retrieve evidence", async () => {
  const outcome = await runTranslationWithScript(chapterIsland, [
    retrieveResolvedEvidence(["q-typhon-piaton"]),
    finalizeTranslation([
      { blockId: "v06_ch08_000", translation: "提丰抬起头，望向塞万里安。" },
      { blockId: "v06_ch08_001", translation: "皮亚顿的声音从同一具身体里传来。" },
    ]),
  ]);
  assert.deepEqual(outcome.usedResolutionIds, ["q-typhon-piaton"]);
  assert.equal(outcome.initialPrompt.includes("all narrative memories"), false);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="minimal context"`  
预期：FAIL。

- [x] **步骤 3：实现章节 island 与最小强制上下文**

目标五块按章节分为：

```text
v06_ch07: global 219
v06_ch08: global 220..221
v06_ch09: global 222..223
```

每个 island 的初始提示只含完整原文、结构、稳定术语、位置边界、上一活动尾部、
高影响判断和工具说明。三组最多并发 2；同章内不拆分。

- [x] **步骤 4：实现候选提交与确定性校验**

校验：目标 block ID 集合完全相等、无重复、译文非空、段落数量相容、输出总字符
不异常缩短、没有泄漏系统 JSON。失败返回 typed failures，不切换候选状态。

- [x] **步骤 5：实现一次 Repair Agent**

Repair 只接收失败项、原文、失败候选和必要证据；必须通过
`submit_repaired_translation` 返回完整受影响 island。第二次失败直接降级为人工处理。

- [x] **步骤 6：运行测试和类型检查**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 7：Commit**

```bash
git add translator-v5/src/agents/translator.ts translator-v5/src/agents/repairer.ts translator-v5/src/validators translator-v5/test/translation-agent.test.ts
git commit -m "feat: translate with on-demand pi tools"
```

---

### 任务 8：实现端到端 Pilot Runner、CLI、报告和冷局部测试

**文件：**
- 创建：`translator-v5/src/pilot-runner.ts`
- 创建：`translator-v5/src/cli.ts`
- 创建：`translator-v5/src/report.ts`
- 创建：`translator-v5/src/storage/pilot-store.ts`
- 测试：`translator-v5/test/pilot-runner.test.ts`

- [x] **步骤 1：编写端到端 faux 失败测试**

```ts
test("cold preview completes five blocks without narrative reads", async () => {
  const result = await runPilot({
    globalIndexes: [219, 220, 221, 222, 223],
    dataProfile: "cold-preview",
    runtime: scriptedRuntime,
  });
  assert.equal(result.translations.length, 5);
  assert.equal(result.metrics.narrativeTableReads, 0);
  assert.ok(result.metrics.modelCalls <= 20);
  assert.ok(result.metrics.offTargetEvidenceChars <= 12_000);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm test -- --test-name-pattern="cold preview"`  
预期：FAIL。

- [x] **步骤 3：实现单向状态机**

```text
created -> indexed -> researched -> translating -> validating
        -> completed | completed_with_warnings | human_required | failed
```

任何异常都必须完成 lease cleanup 和 event flush。相同 run key 有活动 lease 时禁止
启动第二个模型 run。

- [x] **步骤 4：实现 CLI**

```powershell
npm run pilot -- preview `
  --db "D:\llm\小说翻译\projects\new_sun_omnibus\artifacts\parallel_v4\book.db" `
  --config "D:\llm\小说翻译\config\config.yaml" `
  --global-index 219-223 `
  --output "D:\llm\小说翻译\projects\new_sun_omnibus\exports\v5-agent-pilot"
```

CLI 启动前输出目标块数、目标字符、最大模型调用、最大证据字符和硬 deadline；不得
输出 API key。

- [x] **步骤 5：实现输出**

生成：

```text
Typhon_v5_agent_translation.txt
Typhon_v5_agent_bilingual.txt
Typhon_v5_agent_audit.json
Typhon_v5_agent_metrics.json
```

audit 包含问题、tool calls、evidence IDs、预算变化、校验和降级；不包含 API key、
隐藏 reasoning 内容和完整非目标原文。

- [x] **步骤 6：运行全部 V5 测试和类型检查**

运行：`npm test && npm run typecheck`  
预期：PASS。

- [x] **步骤 7：运行 Python 回归基线**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests -q --ignore=tests/test_foila_logic.py
```

预期：`666 passed, 8 subtests passed`。

- [x] **步骤 8：Commit**

```bash
git add translator-v5
git commit -m "feat: run cold local agent pilot"
```

---

### 任务 9：运行真实 DeepSeek/Pi 提丰试验并形成决策报告

**文件：**
- 创建：`docs/superpowers/reports/2026-07-17-v5-agent-kernel-pilot.md`
- 生成但不提交：`projects/new_sun_omnibus/exports/v5-agent-pilot/*`

- [x] **步骤 1：运行本地配置预检，不调用模型**

运行：

```powershell
npm run pilot -- preview `
  --db "D:\llm\小说翻译\projects\new_sun_omnibus\artifacts\parallel_v4\book.db" `
  --config "D:\llm\小说翻译\config\config.yaml" `
  --global-index 219-223 `
  --output "D:\llm\小说翻译\projects\new_sun_omnibus\exports\v5-agent-pilot" `
  --preflight-only
```

预期：报告 5 blocks、33,307 source chars、0 narrative reads、20 call hard limit，且 key
不出现在 stdout、event log 或序列化配置中。

- [x] **步骤 2：运行真实 Pi/DeepSeek pilot**

使用任务 8 CLI。30 分钟硬 deadline 由 `AbortController` 执行，不用外部 shell timeout
代替；进程结束后确认没有残留 Node 子进程和活动 lease。

- [x] **步骤 3：核验机器指标**

必须确认：

```text
translations = 5
narrative_table_reads = 0
off_target_evidence_chars <= 12000
model_calls <= 20
wall_time <= 1800s
lease_released = true
```

- [x] **步骤 4：人工抽查输出与证据链**

检查 Typhon/Piaton/Severian/Claw、段落完整性、引号和连续性；列出 Agent 主动查询了
什么、没有查询什么、哪些判断 unresolved。质量判断不由自动指标替代。

- [x] **步骤 5：编写决策报告**

报告对比：

```text
V4 cold: ~3h25m / 224 prefix blocks / 300 premap calls
V4 warm: ~6m41s / 5 target blocks
V5 cold local: measured values
```

结论只能是 `promote / iterate / reject` 之一，并给出下一轮最小改动；不得因已投入
TypeScript/Pi 成本而默认 promote。

- [x] **步骤 6：运行最终验证并 Commit**

运行：`npm test && npm run typecheck`，再运行 Python 回归。  
提交：

```bash
git add docs/superpowers/reports/2026-07-17-v5-agent-kernel-pilot.md
git commit -m "docs: evaluate v5 agent kernel pilot"
```

---

## 最终验证清单

- [x] `git diff --check` 无错误。
- [x] `translator-v5` 全部 Node 测试通过。
- [x] TypeScript strict typecheck 通过。
- [x] Python 正式测试集仍为 666 passed、8 subtests passed。
- [x] V5 对 V4 数据库只读。
- [x] V5 没有查询 narrative tables。
- [x] Pi 工具清单不含 bash/read/edit/任意 SQL。
- [x] 运行超时或失败不会留下 lease 或并发子进程。
- [x] API key 不出现在 git diff、日志、audit、stdout。
- [x] 五块译文和双语对照可直接阅读。
- [x] 真实运行指标和 V4 对照已写入报告。
