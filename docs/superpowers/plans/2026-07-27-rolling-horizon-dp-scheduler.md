# FolioLoom 滚动动态规划调度器实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不放宽完整性、知识收敛和质量门的前提下，为普通翻译与知识回溯加入双层动态规划、在线成本校准和受控并发，使《变形记》五块回溯墙钟时间至少降低 50%。

**架构：** 内层 `ContextProfilePlanner` 在提示词预算内选择结构化知识；外层 `RollingHorizonPlanner` 在 12–16 个任务的滚动范围内选择上下文档案、推理强度、协议、校验和并发。规划器没有数据库写权限，现有 store、CommitCoordinator、校验与恢复机制继续负责所有持久化和提交。

**技术栈：** TypeScript、Node.js 24、`node:sqlite`、Node test runner、Vitest、React、Electron、现有 Pi runtime 与 DeepSeek/provider adapters。

---

## 实施边界与文件结构

### 新建文件

- `folioloom/src/fullbook/optimization-policy.ts`：用户优化档位、token 包络与 runtime 候选规则。
- `folioloom/src/fullbook/runtime-telemetry.ts`：供应商 usage 归一化和数值观察记录。
- `folioloom/src/storage/runtime-profile-store.ts`：跨项目数值遥测、模型快照和调度决策的独立 SQLite。
- `folioloom/src/fullbook/runtime-cost-model.ts`：时间、token 和失败率在线估计。
- `folioloom/src/fullbook/task-risk.ts`：确定性风险特征与质量硬门。
- `folioloom/src/fullbook/context-profile-planner.ts`：上下文 evidence bundle 的多约束背包动态规划。
- `folioloom/src/fullbook/task-graph.ts`：翻译、锚定、回溯与校验任务的 DAG。
- `folioloom/src/fullbook/rolling-horizon-planner.ts`：有界 Pareto frontier 的外层动态规划。
- `folioloom/src/fullbook/dynamic-scheduler.ts`：shadow/active/off 调度适配器与旧调度回退。
- `folioloom/src/fullbook/revalidation-executor.ts`：支持资源冲突约束的回溯并发执行器。
- `folioloom/src/desktop/runtime-profile-path.ts`：可独立测试的桌面 profile store 路径函数。
- `folioloom/test/optimization-policy.test.ts`
- `folioloom/test/runtime-telemetry.test.ts`
- `folioloom/test/runtime-profile-store.test.ts`
- `folioloom/test/runtime-cost-model.test.ts`
- `folioloom/test/task-risk.test.ts`
- `folioloom/test/context-profile-planner.test.ts`
- `folioloom/test/task-graph.test.ts`
- `folioloom/test/rolling-horizon-planner.test.ts`
- `folioloom/test/dynamic-scheduler.test.ts`
- `folioloom/test/revalidation-executor.test.ts`
- `folioloom/test/desktop-runtime-profile-path.test.ts`
- `folioloom/test/fixtures/scheduler/kafka-revalidation.json`：仅含数字遥测，不含小说正文。
- `folioloom/scripts/prepare-revalidation-benchmark.ts`：只在复制的本地数据库中重建五项 benchmark 任务。
- `folioloom/test/prepare-revalidation-benchmark.test.ts`

### 修改文件

- `folioloom/src/fullbook/types.ts`：runtime variants 和优化档位类型。
- `folioloom/src/knowledge/translation-knowledge-projection.ts`：公开候选 evidence，并接受已选 revision ID。
- `folioloom/src/agents/translation-request.ts`：接收上下文档案并保持稳定前缀。
- `folioloom/src/fullbook/book-runner.ts`：注入新规划器、遥测和执行适配器。
- `folioloom/src/cli.ts`：新增优化档位、调度模式和 runtime profile store 参数。
- `folioloom/src/report.ts`：导出调度预测、实际开销和偏差。
- `folioloom/src/desktop/contracts.ts`：桌面优化模式与进度指标。
- `folioloom/src/desktop/desktop-runtime-plan.ts`：生成同模型合法 runtime variants。
- `folioloom/src/desktop/desktop-fullbook-service.ts`：向 runner 注入档位和 profile store。
- `folioloom/src/desktop/main/index.ts`：创建 `runtime-profiles.db`。
- `folioloom/src/desktop/main/ipc.ts`
- `folioloom/src/desktop/preload/index.ts`
- `folioloom/src/desktop/preload/folioloom-api.d.ts`
- `folioloom/src/desktop/renderer/src/components/RunWorkspace.tsx`
- `folioloom/src/desktop/renderer/src/components/RunWorkspace.test.tsx`
- `folioloom/src/desktop/renderer/src/styles.css`
- `folioloom/test/book-runner.test.ts`
- `folioloom/test/cli.test.ts`
- `folioloom/test/desktop-fullbook-service.test.ts`
- `folioloom/test/desktop-ipc.test.ts`
- `folioloom/test/desktop-runtime-plan.test.ts`
- `folioloom/README.md`

不修改 `book.db` schema。跨项目统计进入独立的 `runtime-profiles.db`，避免再次迁移每本既有小说数据库。

---

### 任务 1：优化档位与 runtime 候选合同

**文件：**
- 创建：`folioloom/src/fullbook/optimization-policy.ts`
- 修改：`folioloom/src/fullbook/types.ts`
- 测试：`folioloom/test/optimization-policy.test.ts`
- 测试：`folioloom/test/desktop-runtime-plan.test.ts`

- [ ] **步骤 1：编写档位、旧模式映射和 runtime 同模型约束测试**

```ts
test("optimization profiles expose fixed token envelopes", () => {
  assert.equal(optimizationPolicy("economy").tokenIncreaseCap, 0.05);
  assert.equal(optimizationPolicy("balanced").tokenIncreaseCap, 0.10);
  assert.equal(optimizationPolicy("speed").tokenIncreaseCap, 0.20);
});

test("legacy run modes map without changing resumed run metadata", () => {
  assert.equal(profileFromLegacyRunMode("quality"), "balanced");
  assert.equal(profileFromLegacyRunMode("fast"), "speed");
});

test("runtime variants must retain one provider model identity", () => {
  assert.throws(
    () => validateRuntimeVariants([
      runtime("model-a", "low"),
      runtime("model-b", "high"),
    ]),
    /same model identity/u,
  );
});
```

- [ ] **步骤 2：运行测试并确认新模块不存在**

运行：

```powershell
npm test -- --test-name-pattern="optimization profiles|legacy run modes|runtime variants"
```

预期：FAIL，提示无法导入 `optimization-policy.js`。

- [ ] **步骤 3：定义稳定的优化合同**

在 `optimization-policy.ts` 实现：

```ts
export type OptimizationProfile = "economy" | "balanced" | "speed";
export type SchedulerMode = "off" | "shadow" | "active";

export interface OptimizationPolicy {
  readonly profile: OptimizationProfile;
  readonly tokenIncreaseCap: number;
  readonly objectiveWeights: {
    readonly time: number;
    readonly tokens: number;
    readonly rework: number;
  };
  readonly horizon: number;
  readonly maxParetoLabels: number;
  readonly maxBatchCandidates: number;
  readonly planningDeadlineMs: number;
}

const POLICIES: Record<OptimizationProfile, OptimizationPolicy> = {
  economy: {
    profile: "economy",
    tokenIncreaseCap: 0.05,
    objectiveWeights: { time: 1, tokens: 1.5, rework: 1 },
    horizon: 12,
    maxParetoLabels: 8,
    maxBatchCandidates: 16,
    planningDeadlineMs: 50,
  },
  balanced: {
    profile: "balanced",
    tokenIncreaseCap: 0.10,
    objectiveWeights: { time: 1, tokens: 0.75, rework: 1 },
    horizon: 12,
    maxParetoLabels: 8,
    maxBatchCandidates: 24,
    planningDeadlineMs: 50,
  },
  speed: {
    profile: "speed",
    tokenIncreaseCap: 0.20,
    objectiveWeights: { time: 1, tokens: 0.25, rework: 1 },
    horizon: 16,
    maxParetoLabels: 8,
    maxBatchCandidates: 24,
    planningDeadlineMs: 250,
  },
};

export function optimizationPolicy(
  profile: OptimizationProfile,
): OptimizationPolicy {
  return structuredClone(POLICIES[profile]);
}

export function profileFromLegacyRunMode(
  mode: "quality" | "fast",
): OptimizationProfile {
  return mode === "quality" ? "balanced" : "speed";
}
```

在 `types.ts` 为 `TranslationRuntimeSet` 增加可选
`variants?: readonly TranslationRuntime[]`，保留 `primary` 和
`escalation` 以兼容旧运行。

- [ ] **步骤 4：实现候选去重和同模型验证**

实现 `validateRuntimeVariants()`：按 `model.id + effort + thinkingLevel`
去重；拒绝不同 `model.id`；拒绝空数组；返回稳定排序后的只读数组。测试
DeepSeek 支持的 `low/medium/high` 顺序和旧双 runtime 的兼容结果。

- [ ] **步骤 5：运行目标测试与类型检查**

运行：

```powershell
npm test -- --test-name-pattern="optimization profiles|legacy run modes|runtime variants"
npm run typecheck
```

预期：目标测试 PASS，TypeScript 0 error。

- [ ] **步骤 6：提交**

```powershell
git add folioloom/src/fullbook/optimization-policy.ts folioloom/src/fullbook/types.ts folioloom/test/optimization-policy.test.ts folioloom/test/desktop-runtime-plan.test.ts
git commit -m "feat: define optimization policies"
```

---

### 任务 2：归一化数值遥测与跨项目存储

**文件：**
- 创建：`folioloom/src/fullbook/runtime-telemetry.ts`
- 创建：`folioloom/src/storage/runtime-profile-store.ts`
- 测试：`folioloom/test/runtime-telemetry.test.ts`
- 测试：`folioloom/test/runtime-profile-store.test.ts`

- [ ] **步骤 1：编写 usage 去重、完整性和隐私测试**

```ts
test("normalized usage never double counts reasoning tokens", () => {
  const usage = normalizeRuntimeUsage({
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: 30,
    totalTokens: 170,
  });
  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 30,
    totalTokens: 170,
    complete: true,
  });
});

test("runtime profile store persists numeric telemetry without source or secrets", () => {
  const path = fixturePath();
  const store = new RuntimeProfileStore(path);
  store.appendObservation(observation({ requestId: "request-1" }));
  store.close();
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from("api-secret", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from("Gregor Samsa", "utf8")), false);
});
```

- [ ] **步骤 2：运行目标测试并确认失败**

```powershell
npm test -- --test-name-pattern="normalized usage|runtime profile store"
```

预期：FAIL，缺少两个新模块。

- [ ] **步骤 3：实现不可重复计数的遥测合同**

在 `runtime-telemetry.ts` 定义：

```ts
export interface NormalizedRuntimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly complete: boolean;
}

export interface RuntimeObservation {
  readonly observationId: string;
  readonly requestId: string;
  readonly modelId: string;
  readonly languageProfileId: string;
  readonly taskType: "translate" | "lexical_anchor" | "revalidate" | "validate";
  readonly protocol: "typed_tool" | "framed_text" | "local";
  readonly effort: string;
  readonly inputEstimate: number;
  readonly outputEstimate: number;
  readonly sourceTokens: number;
  readonly contextProfile: "lean" | "balanced" | "rich";
  readonly concurrency: number;
  readonly cacheHitRatio: number;
  readonly riskScore: number;
  readonly durationMs: number;
  readonly usage: NormalizedRuntimeUsage;
  readonly status: "success" | "throttled" | "timeout" | "context" | "protocol" | "failed";
  readonly observedAt: string;
}
```

`normalizeRuntimeUsage()` 以供应商 `totalTokens` 为权威总量；reasoning
作为诊断分量，不在 `totalTokens` 之外再次相加。负数、NaN 和不安全整数
必须抛错。

- [ ] **步骤 4：实现独立 SQLite schema**

`RuntimeProfileStore` 创建 schema version 1：

```sql
CREATE TABLE runtime_observations(
  observation_id TEXT PRIMARY KEY,
  profile_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
  duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE runtime_model_snapshots(
  profile_key TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE scheduler_decisions(
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  profile TEXT NOT NULL,
  predicted_json TEXT NOT NULL CHECK(json_valid(predicted_json)),
  selected_json TEXT NOT NULL CHECK(json_valid(selected_json)),
  created_at TEXT NOT NULL
) STRICT;
```

所有写入使用 prepared statement 和事务。公开方法仅接受结构化数值合同：
`appendObservation`、`observationsForProfile`、`saveModelSnapshot`、
`modelSnapshot`、`appendDecision`。

- [ ] **步骤 5：补充 WAL、并发打开、损坏快照和幂等测试**

测试两个 store 实例顺序写入、重复 observation ID 不重复、损坏 JSON
返回确定性错误、`PRAGMA journal_mode=wal`。

- [ ] **步骤 6：运行测试**

```powershell
npm test -- --test-name-pattern="runtime usage|runtime profile"
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 7：提交**

```powershell
git add folioloom/src/fullbook/runtime-telemetry.ts folioloom/src/storage/runtime-profile-store.ts folioloom/test/runtime-telemetry.test.ts folioloom/test/runtime-profile-store.test.ts
git commit -m "feat: persist scheduler telemetry"
```

---

### 任务 3：在线时间、token 与失败率模型

**文件：**
- 创建：`folioloom/src/fullbook/runtime-cost-model.ts`
- 测试：`folioloom/test/runtime-cost-model.test.ts`
- 修改：`folioloom/src/storage/runtime-profile-store.ts`

- [ ] **步骤 1：编写保守先验、学习、衰减和序列化测试**

```ts
test("cold predictions use conservative p90 priors", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  const prediction = model.predict(features());
  assert.ok(prediction.p90DurationMs >= prediction.p50DurationMs);
  assert.ok(prediction.totalTokens > 0);
  assert.ok(prediction.failureProbability > 0);
});

test("recent slow observations raise p90 more than expired observations", () => {
  const model = OnlineRuntimeCostModel.coldStart("deepseek-v4-flash:de");
  for (let index = 0; index < 20; index += 1) {
    model.observe(successObservation(1_000, `2026-07-01T00:00:${String(index).padStart(2, "0")}Z`));
  }
  const before = model.predict(features()).p90DurationMs;
  model.observe(successObservation(4_000, "2026-07-27T00:00:00Z"));
  assert.ok(model.predict(features()).p90DurationMs > before);
});

test("snapshot round trip is deterministic", () => {
  const restored = OnlineRuntimeCostModel.fromSnapshot(model.snapshot());
  assert.deepEqual(restored.predict(features()), model.predict(features()));
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="cold predictions|recent slow|snapshot round trip"
```

预期：FAIL，缺少 `runtime-cost-model.js`。

- [ ] **步骤 3：实现固定维度特征向量**

定义：

```ts
export interface RuntimeFeatures {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly sourceTokens: number;
  readonly effortRank: number;
  readonly cacheHitRatio: number;
  readonly concurrency: number;
  readonly batchWindows: number;
  readonly riskScore: number;
  readonly protocolRank: number;
}

export interface RuntimePrediction {
  readonly p50DurationMs: number;
  readonly p90DurationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly failureProbability: number;
  readonly confidence: number;
}
```

特征向量固定为 `[1, log1p(input), log1p(output), log1p(source),
effortRank, cacheHitRatio, concurrency, batchWindows, riskScore,
protocolRank]`，任何调用都不得动态增加维度。

- [ ] **步骤 4：实现递归最小二乘**

实现遗忘因子 `0.97` 的 RLS：

```ts
const px = multiplyMatrixVector(covariance, x);
const gainDenominator = forgettingFactor + dot(x, px);
const gain = px.map((value) => value / gainDenominator);
const residual = Math.log1p(observation.durationMs) - dot(weights, x);
weights = weights.map((value, index) => value + gain[index]! * residual);
covariance = updateCovariance(covariance, gain, x, forgettingFactor);
```

残差使用 Huber 截断；P90 由指数衰减绝对残差估算。失败、限流、上下文和
协议错误分别更新，不把 provider timeout 当成正常耗时样本。

- [ ] **步骤 5：实现带收缩的在线失败模型**

使用固定特征向量、L2 收缩和有界学习率更新逻辑概率。样本少于 20 时，
最终概率为先验与在线预测的加权平均；输出始终裁剪到 `[0.001, 0.95]`。

- [ ] **步骤 6：连接 profile store 快照**

增加：

```ts
export function loadRuntimeCostModel(
  store: RuntimeProfileStore,
  profileKey: string,
): OnlineRuntimeCostModel;

export function persistRuntimeCostModel(
  store: RuntimeProfileStore,
  model: OnlineRuntimeCostModel,
): void;
```

损坏快照必须返回冷启动模型和 `snapshotStatus: "invalid"`；调用方把该状态
写入现有隐私诊断日志，不向 runtime profile store 写入无法解析的副本。

- [ ] **步骤 7：运行测试和类型检查**

```powershell
npm test -- --test-name-pattern="RuntimeCostModel|cold predictions|recent slow|snapshot round trip"
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 8：提交**

```powershell
git add folioloom/src/fullbook/runtime-cost-model.ts folioloom/src/storage/runtime-profile-store.ts folioloom/test/runtime-cost-model.test.ts
git commit -m "feat: learn runtime costs online"
```

---

### 任务 4：确定性任务风险与质量硬门

**文件：**
- 创建：`folioloom/src/fullbook/task-risk.ts`
- 测试：`folioloom/test/task-risk.test.ts`

- [ ] **步骤 1：编写风险维度和最低执行要求测试**

```ts
test("entity control and timeline facts require rich context and high effort", () => {
  const result = assessTaskRisk({
    sourceTokens: 1_200,
    entityMentions: 4,
    pronounMentions: 3,
    relationKinds: ["control", "part_of", "timeline"],
    remoteEvidenceDistance: 30,
    lockedTermOccurrences: 1,
    needsRevalidate: false,
    priorRepairs: 0,
    sourceAnomalies: 0,
  });
  assert.equal(result.minimumContextProfile, "rich");
  assert.equal(result.minimumEffort, "high");
  assert.deepEqual(result.requiredCoverage.sort(), [
    "control",
    "entity_identity",
    "part_whole",
    "timeline",
  ]);
});

test("plain narration remains eligible for lean low execution", () => {
  const result = assessTaskRisk(plainFeatures());
  assert.equal(result.minimumContextProfile, "lean");
  assert.equal(result.minimumEffort, "low");
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="entity control|plain narration"
```

预期：FAIL，缺少 `task-risk.js`。

- [ ] **步骤 3：实现版本化风险合同**

```ts
export type RiskDimension =
  | "entity_identity"
  | "pronoun_resolution"
  | "part_whole"
  | "control"
  | "causality"
  | "timeline"
  | "viewpoint"
  | "character_knowledge";

export interface TaskRiskFeatures {
  readonly sourceTokens: number;
  readonly entityMentions: number;
  readonly pronounMentions: number;
  readonly relationKinds: readonly (
    | "identity"
    | "part_of"
    | "control"
    | "causality"
    | "timeline"
    | "viewpoint"
    | "character_knowledge"
  )[];
  readonly remoteEvidenceDistance: number;
  readonly lockedTermOccurrences: number;
  readonly needsRevalidate: boolean;
  readonly priorRepairs: number;
  readonly sourceAnomalies: number;
}

export interface TaskRiskAssessment {
  readonly schemaVersion: "folioloom-task-risk-1";
  readonly score: number;
  readonly requiredCoverage: readonly RiskDimension[];
  readonly minimumContextProfile: "lean" | "balanced" | "rich";
  readonly minimumEffort: "low" | "medium" | "high";
  readonly requiredValidators: readonly (
    | "structure"
    | "terminology"
    | "cross_block"
    | "knowledge_coverage"
  )[];
}
```

实现固定阈值表。任何一个 `control/causality/timeline/character_knowledge`
命中都不得被平均分稀释；它们独立提升 required coverage 和校验集合。

- [ ] **步骤 4：补充多语言与异常边界测试**

输入只使用已经归一化的计数与关系类型，所以英语、德语、韩语和日语的相同
结构特征必须得到相同硬门。NaN、负数和未知关系类型必须抛出。

- [ ] **步骤 5：运行测试并提交**

```powershell
npm test -- --test-name-pattern="task risk|entity control|plain narration"
npm run typecheck
git add folioloom/src/fullbook/task-risk.ts folioloom/test/task-risk.test.ts
git commit -m "feat: classify translation risk locally"
```

---

### 任务 5：上下文 evidence bundle 与内层动态规划

**文件：**
- 创建：`folioloom/src/fullbook/context-profile-planner.ts`
- 测试：`folioloom/test/context-profile-planner.test.ts`

- [ ] **步骤 1：编写强制覆盖、关系原子性和预算测试**

```ts
test("context planning covers every required risk within budget", () => {
  const profiles = planContextProfiles({
    bundles: [
      bundle("identity", 100, 8, ["entity_identity"]),
      bundle("control-relation", 120, 10, ["control"], ["identity"]),
      bundle("duplicate-control", 180, 7, ["control"]),
    ],
    requiredCoverage: ["entity_identity", "control"],
    budgets: { lean: 220, balanced: 320, rich: 500 },
  });
  assert.deepEqual(profiles.lean?.bundleIds, ["identity", "control-relation"]);
  assert.ok((profiles.lean?.tokenCost ?? Infinity) <= 220);
});

test("an atomic relation bundle is never split into orphan fields", () => {
  const profile = planContextProfiles(relationFixture()).balanced;
  assert.ok(profile?.bundleIds.includes("bird-has-glass-eyes"));
  assert.equal(profile?.bundleIds.includes("glass-eyes-without-owner"), false);
});

test("a profile is absent when mandatory evidence exceeds its budget", () => {
  assert.equal(planContextProfiles(overBudgetFixture()).lean, undefined);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="context planning|atomic relation|mandatory evidence"
```

预期：FAIL，缺少 planner。

- [ ] **步骤 3：定义 bundle 和输出档案**

```ts
export interface ContextEvidenceBundle {
  readonly bundleId: string;
  readonly kind: "term" | "entity" | "relation" | "memory" | "style" | "recovery";
  readonly tokenCost: number;
  readonly utility: number;
  readonly coverage: readonly RiskDimension[];
  readonly requires: readonly string[];
  readonly redundancyGroup?: string;
  readonly mandatory: boolean;
  readonly payload: unknown;
}

export interface ContextPlanningInput {
  readonly bundles: readonly ContextEvidenceBundle[];
  readonly requiredCoverage: readonly RiskDimension[];
  readonly budgets: Readonly<Record<"lean" | "balanced" | "rich", number>>;
}

export interface ContextProfile {
  readonly name: "lean" | "balanced" | "rich";
  readonly bundleIds: readonly string[];
  readonly tokenCost: number;
  readonly utility: number;
  readonly coveredRisks: readonly RiskDimension[];
}
```

- [ ] **步骤 4：实现 token 桶 × 风险 bitmask 动态规划**

按 `bundleId` 排序保证确定性。状态为：

```ts
interface ContextState {
  readonly tokenCost: number;
  readonly tokenBucket: number;
  readonly coverageMask: number;
  readonly selected: readonly string[];
  readonly utility: number;
}
```

先验证重复 ID、未知依赖、自依赖和依赖环，再闭包展开 `requires`。全部
`mandatory=true` 的 bundle 及其依赖必须进入每个可行解。状态保存精确
`tokenCost`，32-token 桶仅用于索引和合并候选，不能把 `100 + 120 = 220`
误判成 256 token。重复组先按基础效用、成本和 ID 稳定排序，再静态赋予
第一项 1、第二项 0.35、第三项及以后 0.15 的衰减，确保 DP 状态仍然闭合。
最终只接受覆盖 required mask 且包含全部 mandatory ID 的状态；同成本同效用
时选择字典序最小的 bundle ID 序列。

- [ ] **步骤 5：实现帕累托档案生成**

分别用三个预算求解。即使两个档案选集相同，也保留三个可行档名，因为
`minimumContextProfile="rich"` 是质量合同；执行变体生成阶段可以按 bundle
ID 复用成本预测，但不能删除档名语义。档案 payload 在最终 prompt 组装时
才读取，规划器只处理 ID、数字和风险 bitmask。

- [ ] **步骤 6：运行测试和性能样本**

```powershell
npm test -- --test-name-pattern="context profile|context planning|atomic relation"
npm run typecheck
```

新增一个 500 bundle、24,000-token 预算样本，要求本机低于 50 ms。

- [ ] **步骤 7：提交**

```powershell
git add folioloom/src/fullbook/context-profile-planner.ts folioloom/test/context-profile-planner.test.ts
git commit -m "feat: optimize translator context profiles"
```

---

### 任务 6：把结构化知识投影接入上下文档案

**文件：**
- 修改：`folioloom/src/knowledge/translation-knowledge-projection.ts`
- 修改：`folioloom/src/agents/translation-request.ts`
- 创建：`folioloom/test/translation-context-profile.test.ts`
- 修改：`folioloom/test/translation-request.test.ts`

- [ ] **步骤 1：编写候选公开、revision 选择和稳定前缀测试**

```ts
test("knowledge candidates expose atomic relation bundles", () => {
  const candidates = collectTranslationKnowledgeCandidates(
    revisions(),
    ["current source"],
    getSourceLanguageProfile("en"),
    {
      corpusBlocks: positions().corpusBlocks,
      currentBlocks: positions().currentBlocks,
    },
  );
  const relation = candidates.find((item) => item.kind === "relation");
  assert.ok(relation);
  assert.ok(relation.coverage.length > 0);
});

test("prepared requests serialize only selected revision ids", () => {
  const prepared = prepareTranslationRequest({
    ...requestInput(),
    selectedKnowledgeRevisionIds: ["revision-a"],
  });
  const memory = prepared.sections.find((section) => section.kind === "memory");
  assert.match(memory?.text ?? "", /revision-a/u);
  assert.doesNotMatch(memory?.text ?? "", /revision-b/u);
});

test("dynamic memory remains after the stable protocol prefix", () => {
  const prepared = prepareTranslationRequest(requestInput());
  assert.ok(prepared.systemPrompt.length > 0);
  assert.equal(prepared.sections[0]?.kind, "request");
  assert.equal(prepared.sections[1]?.kind, "memory");
});
```

- [ ] **步骤 2：运行测试并确认接口不存在**

```powershell
npm test -- --test-name-pattern="knowledge candidates expose|selected revision ids|stable protocol prefix"
```

预期：FAIL。

- [ ] **步骤 3：从现有投影器拆出只读候选阶段**

导出 `collectTranslationKnowledgeCandidates()`。它复用现有 source match、
position match 和 global fallback 规则，返回：

```ts
export interface TranslationKnowledgeCandidate {
  readonly bundleId: string;
  readonly revisionIds: readonly string[];
  readonly kind: ContextEvidenceBundle["kind"];
  readonly tokenCost: number;
  readonly utility: number;
  readonly coverage: readonly RiskDimension[];
  readonly requires: readonly string[];
  readonly redundancyGroup?: string;
  readonly mandatory: boolean;
  readonly payload: unknown;
}
```

不复制原文；payload 只引用原有 revision payload。
`tokenCost` 使用将该候选序列化为动态 memory section 后的确定性 token 估算；
`utility` 由来源强度、位置距离、revision 置信度和重复衰减组成，不调用模型
打分。token 估算复用 `WeightedTokenEstimator.estimateJson()`，不得把
UTF-8 字节数直接冒充 token。相同输入必须产生相同数值。

coverage 只从明确 kind 和结构字段映射；不得通过关键词猜测任意自然语言
`fact`。无法证明 `control/causality/timeline` 的候选保持空 coverage，
从而不能虚假满足质量硬门。

- [ ] **步骤 4：让投影器接受已选 revision**

在 `TranslationKnowledgeProjectionOptions` 增加
`selectedRevisionIds?: ReadonlySet<string>`。若提供，投影器只能序列化该集合，
并按原候选稳定顺序输出。发现所选 revision 不存在、不适用于当前窗口、
超过 entry/byte 上限时抛出确定性错误，不能静默省略。fragment 拆分后必须
针对实际 fragment 重新规划选集，不能原样沿用父请求的 positioned memory。

- [ ] **步骤 5：扩展 TranslationRequestInput**

增加：

```ts
readonly selectedKnowledgeRevisionIds?: readonly string[];
readonly contextProfileName?: "lean" | "balanced" | "rich";
```

`prepareTranslationRequest()` 把 profile 名称放进 request metadata，不改变
系统提示词或工具 schema。使用 `Set` 传给知识投影器。

- [ ] **步骤 6：运行翻译请求、预算和知识投影测试**

```powershell
npm test -- --test-name-pattern="translator wire knowledge|translation request|context profile"
npm run typecheck
```

预期：旧测试与新测试全部 PASS。

- [ ] **步骤 7：提交**

```powershell
git add folioloom/src/knowledge/translation-knowledge-projection.ts folioloom/src/agents/translation-request.ts folioloom/test/translation-context-profile.test.ts folioloom/test/translation-request.test.ts
git commit -m "feat: project selected translation context"
```

---

### 任务 7：统一任务图与完整性约束

**文件：**
- 创建：`folioloom/src/fullbook/task-graph.ts`
- 测试：`folioloom/test/task-graph.test.ts`

- [ ] **步骤 1：编写 DAG、资源冲突和损坏输入测试**

```ts
test("independent revalidation tasks are ready together", () => {
  const graph = buildTaskGraph([
    revalidationTask("a", "window-a", ["concept-a"]),
    revalidationTask("b", "window-b", ["concept-b"]),
  ]);
  assert.deepEqual(graph.readyTaskIds([]), ["a", "b"]);
});

test("same concept writes create an ordering edge", () => {
  const graph = buildTaskGraph([
    revalidationTask("a", "window-a", ["concept-x"]),
    revalidationTask("b", "window-b", ["concept-x"]),
  ]);
  assert.deepEqual(graph.readyTaskIds([]), ["a"]);
});

test("cycles and missing dependencies are integrity incidents", () => {
  assert.throws(() => buildTaskGraph(cyclicTasks()), /TASK_GRAPH_INVALID/u);
  assert.throws(() => buildTaskGraph(missingDependencyTasks()), /TASK_GRAPH_INVALID/u);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="revalidation tasks are ready|same concept writes|TASK_GRAPH_INVALID"
```

预期：FAIL。

- [ ] **步骤 3：定义任务、资源和 DAG 接口**

```ts
export type SchedulerTaskType =
  | "translate"
  | "lexical_anchor"
  | "revalidate"
  | "validate";

export interface SchedulerTask {
  readonly taskId: string;
  readonly type: SchedulerTaskType;
  readonly ordinal: number;
  readonly dependencyIds: readonly string[];
  readonly readResources: readonly string[];
  readonly writeResources: readonly string[];
  readonly sourceTokens: number;
  readonly risk: TaskRiskAssessment;
}

export interface SchedulerTaskGraph {
  readonly tasks: readonly SchedulerTask[];
  readyTaskIds(completedTaskIds: readonly string[]): readonly string[];
  horizon(
    completedTaskIds: readonly string[],
    limit?: number,
  ): readonly SchedulerTask[];
  tasksCompatible(leftTaskId: string, rightTaskId: string): boolean;
}
```

资源键固定使用 `window:<id>`、`concept:<id>`、`snapshot:<id>`。输入先稳定
排序；显式依赖和写资源冲突共同产生边。资源冲突按 `(ordinal, taskId)`
稳定定向；若显式依赖要求相反方向，交给 Kahn 检测为循环事故。首版只校验
task ID、dependency ID、资源键格式和 DAG；没有实体 registry 时不得声称
验证了 window/concept/snapshot 是否真实存在。

- [ ] **步骤 4：实现 Kahn 拓扑验证与滚动 horizon**

`readyTaskIds(completedIds)` 返回所有前置已完成的任务；运行中 task 由调用方
显式排除。`horizon()` 从 ready frontier 出发，按关键路径长度、ordinal 和
task ID 稳定扩展 12–16 项，并包含在局部完成后会解锁的后继任务。检测到环时
抛出带涉及 task ID 的 `TaskGraphIntegrityError`。

- [ ] **步骤 5：实现并发兼容判断**

`graph.tasksCompatible(leftTaskId,rightTaskId)` 使用依赖闭包，在以下任一情况
返回 false：

- 写资源相交；
- 一方写资源与另一方读资源相交；
- 显式存在祖先关系。

只读资源相交允许并发。

- [ ] **步骤 6：运行测试和提交**

```powershell
npm test -- --test-name-pattern="task graph|revalidation tasks are ready|same concept writes"
npm run typecheck
git add folioloom/src/fullbook/task-graph.ts folioloom/test/task-graph.test.ts
git commit -m "feat: model scheduler task dependencies"
```

---

### 任务 8：外层滚动动态规划求解器

**文件：**
- 创建：`folioloom/src/fullbook/rolling-horizon-planner.ts`
- 测试：`folioloom/test/rolling-horizon-planner.test.ts`

- [ ] **步骤 1：编写穷举最优、token 硬门和确定性测试**

```ts
test("subset planner matches brute force for eight tasks", () => {
  const input = plannerFixture(8);
  const expected = bruteForceSchedule(input);
  const actual = planRollingHorizon(input);
  assert.equal(actual.objective, expected.objective);
  assert.deepEqual(actual.firstDispatch, expected.firstDispatch);
});

test("speed mode never exceeds its cumulative token envelope", () => {
  const result = planRollingHorizon(tokenPressureFixture("speed"));
  assert.ok(result.predictedTotalTokens <= result.allowedTotalTokens);
});

test("planner output is deterministic", () => {
  assert.deepEqual(
    planRollingHorizon(plannerFixture(12)),
    planRollingHorizon(plannerFixture(12)),
  );
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="subset planner|cumulative token envelope|planner output is deterministic"
```

预期：FAIL。

- [ ] **步骤 3：定义执行变体与规划输入**

```ts
export interface TaskExecutionVariant {
  readonly variantId: string;
  readonly taskId: string;
  readonly contextProfile: "lean" | "balanced" | "rich";
  readonly effort: string;
  readonly effortRank: number;
  readonly protocol: "typed_tool" | "framed_text" | "local";
  readonly validators: readonly string[];
  readonly predicted: RuntimePrediction;
}

export interface RunningTaskReservation {
  readonly taskId: string;
  readonly variantId: string;
  readonly remainingP90DurationMs: number;
  readonly reservedTokens: number;
}

export interface RollingPlannerInput {
  readonly graph: SchedulerTaskGraph;
  readonly completedTaskIds: readonly string[];
  readonly running: readonly RunningTaskReservation[];
  readonly variants: readonly TaskExecutionVariant[];
  readonly policy: OptimizationPolicy;
  readonly runBaselineTotalTokens: number;
  readonly actualRunTokens: number;
  readonly runningReservedTokens: number;
  readonly horizonBaselineTokens: number;
  readonly maxConcurrency: number;
  readonly maxInFlightTokens: number;
  readonly clock?: () => number;
}
```

- [ ] **步骤 4：实现候选裁剪与批次枚举**

先删除低于 task risk 硬门的候选，再删除时间、token、失败概率均被支配的
variant。批次只从 ready tasks 组合，最大不超过空闲并发槽和 24 个候选；
使用 `graph.tasksCompatible()` 验证资源。effort 硬门使用统一数值
`effortRank`，不得用字符串字典序判断。

批次时间：

```ts
const batchTime = Math.max(
  ...variants.map((variant) => variant.predicted.p90DurationMs),
);
const batchTokens = variants.reduce(
  (total, variant) => total + variant.predicted.totalTokens,
  0,
);
const expectedRework = variants.reduce(
  (total, variant) =>
    total
    + variant.predicted.failureProbability
      * variant.predicted.p90DurationMs,
  0,
);
```

- [ ] **步骤 5：定义归一化 objective**

不同量纲先相对当前 horizon 的静态基线归一化：

```ts
const objective =
  policy.objectiveWeights.time
    * (label.elapsedMs / Math.max(1, baselineWallTimeMs))
  + policy.objectiveWeights.tokens
    * (label.tokens / Math.max(1, allowedTotalTokens))
  + policy.objectiveWeights.rework
    * (label.expectedReworkMs / Math.max(1, baselineWallTimeMs));
```

质量风险不进入该加权和；它已经在 variant 生成阶段作为硬门删除。
`validators` 仅声明该变体包含的校验集合，不能关闭现有结构、术语、跨块或
修复校验；speed 档也不得跳过这些既有质量门。

- [ ] **步骤 6：实现 subset DP 与 epsilon-Pareto frontier**

状态键为 completed bitmask。标签包含 elapsed、tokens、rework 和 actions。
对每次转移：

```ts
const next = {
  completedMask: label.completedMask | batch.taskMask,
  elapsedMs: label.elapsedMs + batch.p90DurationMs,
  tokens: label.tokens + batch.totalTokens,
  expectedReworkMs: label.expectedReworkMs + batch.expectedReworkMs,
  actions: [...label.actions, batch],
};
```

全运行 token 硬门按
`actualRunTokens + runningReservedTokens + label.tokens`
与 `runBaselineTotalTokens × (1 + cap)` 比较；目标函数的 token 归一化使用
局部 `horizonBaselineTokens`。超过累计包络的标签删除；epsilon 为时间 1%、
token 0.5%。每个状态最多保留 8 个标签，排序规则为 objective、tokens、
动作 ID。

- [ ] **步骤 7：纳入已经运行的固定 reservation**

运行中任务先按预计剩余时间排序，占用对应并发槽和 in-flight token。第一批
只能使用剩余槽；后续 DP 把 reservation 完成建模为确定性事件，只有事件发生
后才释放槽位并解锁其后继。任何重规划都不得改变或取消这些 reservation。

- [ ] **步骤 8：实现 deadline 与可行回退**

每 128 次转移检查注入的 `clock()`，生产默认 `performance.now()`，测试使用
确定性递增时钟。达到 deadline 时返回当前最优完整
标签；若没有完整标签，返回当前最优第一批可行动作并标记
`planningStatus="bounded"`。只有完全没有合法动作才返回
`planningStatus="fallback"`。

- [ ] **步骤 9：增加性能测试**

```ts
test("twelve-task planning stays below fifty milliseconds", () => {
  const started = performance.now();
  planRollingHorizon(plannerFixture(12));
  assert.ok(performance.now() - started < 50);
});

test("sixteen-task planning stays below two hundred fifty milliseconds", () => {
  const started = performance.now();
  planRollingHorizon(plannerFixture(16, "speed"));
  assert.ok(performance.now() - started < 250);
});
```

性能测试使用固定 fixture、预热一次后测量，避免把模块加载计入。

- [ ] **步骤 10：运行测试和提交**

```powershell
npm test -- --test-name-pattern="rolling horizon|subset planner|planning stays below"
npm run typecheck
git add folioloom/src/fullbook/rolling-horizon-planner.ts folioloom/test/rolling-horizon-planner.test.ts
git commit -m "feat: plan rolling execution horizons"
```

---

### 任务 9：动态调度适配器与影子模式

**文件：**
- 创建：`folioloom/src/fullbook/dynamic-scheduler.ts`
- 测试：`folioloom/test/dynamic-scheduler.test.ts`
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/src/report.ts`
- 修改：`folioloom/test/book-runner.test.ts`

- [ ] **步骤 1：编写 off、shadow、active 与求解回退测试**

```ts
test("shadow mode records a decision but delegates the legacy dispatch", async () => {
  const result = await scheduler.dispatch(tasks(), { mode: "shadow" });
  assert.deepEqual(result.dispatchedTaskIds, legacyTaskIds());
  assert.ok(result.shadowDecision);
});

test("planner failure falls back without skipping validation", async () => {
  const result = await failingScheduler.dispatch(tasks(), { mode: "active" });
  assert.equal(result.fallbackReason, "PLANNER_FAILED");
  assert.deepEqual(result.dispatchedTaskIds, legacyTaskIds());
  assert.equal(result.validatorsSkipped, 0);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="shadow mode records|planner failure falls back"
```

预期：FAIL。

- [ ] **步骤 3：实现适配器合同**

```ts
export interface DynamicSchedulerOptions {
  readonly mode: SchedulerMode;
  readonly profile: OptimizationProfile;
  readonly planner: typeof planRollingHorizon;
  readonly costModel: OnlineRuntimeCostModel;
  readonly profileStore?: RuntimeProfileStore;
}

export interface SchedulerDispatchReport {
  readonly mode: SchedulerMode;
  readonly planningStatus: "disabled" | "shadow" | "optimal" | "bounded" | "fallback";
  readonly dispatchedTaskIds: readonly string[];
  readonly predictedWallTimeMs: number;
  readonly predictedTokens: number;
  readonly validatorsSkipped: 0;
  readonly contextProfiles: Readonly<Record<"lean" | "balanced" | "rich", number>>;
  readonly shadowDecision?: RollingPlannerResult;
  readonly fallbackReason?: string;
}
```

`off` 不调用 planner；`shadow` 调用并记录但返回 legacy dispatch；`active`
返回 planner 的第一批。所有异常转为结构化 fallback，TaskGraphIntegrityError
除外，它必须向上抛出。

- [ ] **步骤 4：在 runner 只接入 shadow 模式**

给 `LosslessBookRunOptions` 增加：

```ts
optimizationProfile?: OptimizationProfile;
schedulerMode?: SchedulerMode;
runtimeProfileStore?: RuntimeProfileStore;
```

本任务只收集现有请求的特征、生成 shadow decision 和写入数值观察，实际
`runWithAdaptiveScheduler()` 调用保持不变。

- [ ] **步骤 5：扩展 run result 与 report**

增加：

```ts
scheduler: {
  mode: SchedulerMode;
  profile: OptimizationProfile;
  decisions: number;
  fallbacks: number;
  predictedWallTimeMs: number;
  actualWallTimeMs: number;
  predictedTokens: number;
  actualTokens: number;
  tokenUsageComplete: boolean;
}
```

partial export metrics 同步包含该字段；不写 prompt 或正文。

- [ ] **步骤 6：运行 runner、report 和桌面 fixture 测试**

```powershell
npm test -- --test-name-pattern="shadow mode|scheduler report|lossless runner"
npm run typecheck
```

预期：既有执行顺序、输出和调用次数完全不变，新 report 有 shadow 数据。

- [ ] **步骤 7：提交**

```powershell
git add folioloom/src/fullbook/dynamic-scheduler.ts folioloom/src/fullbook/book-runner.ts folioloom/src/report.ts folioloom/test/dynamic-scheduler.test.ts folioloom/test/book-runner.test.ts
git commit -m "feat: observe dynamic schedules in shadow mode"
```

---

### 任务 10：回溯任务受控并行

**文件：**
- 创建：`folioloom/src/fullbook/revalidation-executor.ts`
- 测试：`folioloom/test/revalidation-executor.test.ts`
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/test/book-runner.test.ts`
- 创建：`folioloom/test/fixtures/scheduler/kafka-revalidation.json`

- [ ] **步骤 1：编写独立并发、冲突串行和失败隔离测试**

```ts
test("independent revalidation tasks overlap in active mode", async () => {
  const gate = deferred<void>();
  const started: string[] = [];
  const run = executeRevalidationTasks(fixtureStore(independentTasks()), {
    maxConcurrency: 2,
    translate: async (work) => {
      started.push(work.task.taskId);
      if (started.length === 2) gate.resolve();
      await gate.promise;
      return replacement(work);
    },
  });
  await gate.promise;
  assert.deepEqual(started.sort(), ["task-a", "task-b"]);
  await run;
});

test("same concept revalidation tasks never overlap", async () => {
  const report = await executeRevalidationTasks(
    fixtureStore(conflictingTasks()),
    instrumentedExecutor(),
  );
  assert.equal(report.maximumObservedConcurrency, 1);
});

test("one warning does not roll back an unrelated successful replacement", async () => {
  const report = await executeRevalidationTasks(
    fixtureStore(oneFailureTasks()),
    expectedFailureExecutor(),
  );
  assert.equal(report.retranslated, 1);
  assert.equal(report.warning, 1);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
npm test -- --test-name-pattern="revalidation tasks overlap|never overlap|unrelated successful"
```

预期：FAIL。

- [ ] **步骤 3：把单任务状态机移入 executor**

从 `drainKnowledgeRevalidationTasks()` 提取：

```ts
async function executeOneRevalidationTask(
  task: KnowledgeRevalidationTask,
  options: RevalidationExecutionOptions,
): Promise<RevalidationTaskOutcome>;
```

保留 noop、repair、retranslate、retry 和 warning 的现有事务语义；每次
translate 返回后才调用 `replaceTranslationForRevalidation()`。

- [ ] **步骤 4：使用任务图和滚动 planner 选择第一批**

领取前先读取 pending 任务并构建 task graph。只领取 planner 返回的 task
ID；领取失败表示另一进程已取得任务，删除该 ID 并立即重规划。使用
`Promise.allSettled()` 执行兼容任务，但每个结果独立提交。

- [ ] **步骤 5：限制并发与在途 token**

每个任务开始前取得本地 permit：

```ts
interface RevalidationPermit {
  readonly taskId: string;
  readonly reservedTokens: number;
  release(): void;
}
```

总数不得超过 `maxConcurrency`，reserved token 之和不得超过
`maxInFlightTokens`。限流时只降低该 provider 的后续并发，不取消已经运行
的请求。

- [ ] **步骤 6：写入 Kafka 数字重放 fixture**

fixture 只包含：

```json
{
  "schema": "folioloom-scheduler-replay-1",
  "tasks": [
    {"id":"b0","durationMs":86000,"totalTokens":62100,"risk":0.3},
    {"id":"b1","durationMs":106000,"totalTokens":41400,"risk":0.4},
    {"id":"b2","durationMs":87000,"totalTokens":41400,"risk":0.4},
    {"id":"b3","durationMs":27000,"totalTokens":20700,"risk":0.5},
    {"id":"b5","durationMs":186000,"totalTokens":62100,"risk":0.5}
  ],
  "serialBaselineMs": 492000,
  "maxConcurrency": 4
}
```

测试动态计划预测值低于 `246000` ms，且 token 不超过 speed 20% 包络。

- [ ] **步骤 7：替换 runner 中串行 drain**

`drainKnowledgeRevalidationTasks()` 保留为兼容包装器；新 runner 在
`schedulerMode=active` 时调用 `executeRevalidationTasks()`，off/shadow
仍使用原实现。结果合并到现有 `revalidationOverhead`。

- [ ] **步骤 8：运行回溯、store、审计与重放测试**

```powershell
npm test -- --test-name-pattern="revalidation|Kafka scheduler replay|knowledge convergence"
npm run typecheck
```

预期：任务并发测试 PASS；旧版本切换、warning stale、audit 测试零回归。

- [ ] **步骤 9：提交**

```powershell
git add folioloom/src/fullbook/revalidation-executor.ts folioloom/src/fullbook/book-runner.ts folioloom/test/revalidation-executor.test.ts folioloom/test/book-runner.test.ts folioloom/test/fixtures/scheduler/kafka-revalidation.json
git commit -m "feat: schedule revalidation tasks concurrently"
```

---

### 任务 11：普通翻译动态执行与上下文档案

**文件：**
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/src/fullbook/types.ts`
- 修改：`folioloom/src/agents/translation-request.ts`
- 测试：`folioloom/test/book-runner.test.ts`
- 测试：`folioloom/test/fault-injection.test.ts`

- [ ] **步骤 1：编写上下文档案选择、乱序生成顺序提交和 runtime 升级测试**

```ts
test("low-risk windows use lean context while high-risk windows keep rich evidence", async () => {
  const result = await runBook(dynamicFixture());
  assert.deepEqual(result.scheduler.contextProfiles, {
    "window-0": "lean",
    "window-1": "rich",
  });
});

test("dynamic completion order never changes promotion order", async () => {
  const fixture = outOfOrderDynamicFixture();
  await runBook(fixture.options);
  assert.deepEqual(fixture.promotedOrdinals, [0, 1, 2]);
});

test("failed low effort retries only its task with the legal escalation runtime", async () => {
  const fixture = lowFailureFixture();
  await runBook(fixture.options);
  assert.deepEqual(fixture.efforts, ["low", "high"]);
});
```

- [ ] **步骤 2：运行测试并确认当前 runner 不支持**

```powershell
npm test -- --test-name-pattern="low-risk windows|dynamic completion order|failed low effort"
```

预期：FAIL。

- [ ] **步骤 3：为每个 physical request 建立 task 与 variants**

保持 `planBookWindows()` 的无损窗口不变。对当前 wave 的 physical request：

1. 从投影器取得 evidence candidates；
2. 用 `assessTaskRisk()` 生成硬门；
3. 用 `planContextProfiles()` 生成档案；
4. 对合法 runtime variant 和协议生成 `TaskExecutionVariant`；
5. 用 cost model 预测并交给滚动 planner。

不允许 planner 合并非相邻窗口，也不允许改变 logical window ID。

- [ ] **步骤 4：把 selected revision ID 传入 request**

`buildTranslationInput()` 根据 planner 选择设置：

```ts
{
  selectedKnowledgeRevisionIds: selectedContext.revisionIds,
  contextProfileName: selectedContext.name,
  responseProtocol: selectedVariant.protocol,
}
```

`admitTranslationRequests()` 必须基于最终选择后的完整 request 重新预算；
如果超过 context window，删除该 variant 并重规划，不直接发送。

- [ ] **步骤 5：执行第一批并在每次完成后重规划**

运行任务继续使用现有 `runTranslationBatch()`、BudgetLedger、validator 和
CommitCoordinator。完成一个 request 后：

- 写 observation；
- 更新 cost model；
- 保留其余 running reservation；
- 重算可用槽；
- 调用 planner 选择下一项。

不得增加真实同步批次屏障。

- [ ] **步骤 6：实现 runtime 失败边**

严格使用现有恢复语义：

- protocol → framed text；
- context → 无损边界拆分；
- low/medium 校验失败 → 同模型更高合法 effort；
- quota/auth → 不升级，直接返回现有 provider error；
- 达到 max attempts → 现有 warning/human handling。

每条恢复写入 observation，防止成本模型把失败请求当作成功样本。

- [ ] **步骤 7：生成同任务的静态基线**

新增 `baselineVariantForTask()`：使用 FolioLoom 1.4 相同知识投影、
`runtimeSet.primary`、原 response protocol 和完整既有校验，生成不可执行的
估算 variant。它只用于计算 `baselineWallTimeMs` 与
`cumulativeBaselineTokens`，不能被 planner 选择。

- [ ] **步骤 8：实现累计 token 包络**

每个滚动点计算：

```ts
const allowed = Math.floor(
  cumulativeBaselineTokens * (1 + policy.tokenIncreaseCap),
);
const committedAndReserved = actualTokens + runningReservedTokens;
```

只允许 `committedAndReserved + candidate.predicted.totalTokens <= allowed`。
usage 不完整时使用预测值与供应商已知值中的较大者。

- [ ] **步骤 9：运行 runner、fault injection、budget 和 commit 测试**

```powershell
npm test -- --test-name-pattern="dynamic completion|context profile|fault injection|request admission|CommitCoordinator"
npm run typecheck
```

预期：新增测试 PASS；现有上下文拆分、协议 fallback、顺序提交和预算测试
零回归。

- [ ] **步骤 10：提交**

```powershell
git add folioloom/src/fullbook/book-runner.ts folioloom/src/fullbook/types.ts folioloom/src/agents/translation-request.ts folioloom/test/book-runner.test.ts folioloom/test/fault-injection.test.ts
git commit -m "feat: dynamically schedule book translation"
```

---

### 任务 12：CLI、桌面运行和 GUI 三档入口

**文件：**
- 修改：`folioloom/src/cli.ts`
- 创建：`folioloom/src/desktop/runtime-profile-path.ts`
- 修改：`folioloom/src/desktop/contracts.ts`
- 修改：`folioloom/src/desktop/desktop-runtime-plan.ts`
- 修改：`folioloom/src/desktop/desktop-fullbook-service.ts`
- 修改：`folioloom/src/desktop/main/index.ts`
- 修改：`folioloom/src/desktop/main/ipc.ts`
- 修改：`folioloom/src/desktop/preload/index.ts`
- 修改：`folioloom/src/desktop/preload/folioloom-api.d.ts`
- 修改：`folioloom/src/desktop/renderer/src/components/RunWorkspace.tsx`
- 修改：`folioloom/src/desktop/renderer/src/components/RunWorkspace.test.tsx`
- 修改：`folioloom/src/desktop/renderer/src/styles.css`
- 测试：`folioloom/test/cli.test.ts`
- 测试：`folioloom/test/desktop-fullbook-service.test.ts`
- 测试：`folioloom/test/desktop-ipc.test.ts`
- 测试：`folioloom/test/desktop-runtime-plan.test.ts`
- 测试：`folioloom/test/desktop-runtime-profile-path.test.ts`

- [ ] **步骤 1：编写 CLI 兼容、桌面合同和 profile store 路径测试**

```ts
test("book run accepts optimization profile and scheduler mode", () => {
  const parsed = parseCli([
    "book", "run",
    "--optimization-profile", "balanced",
    "--scheduler-mode", "active",
    "--runtime-profile-store", "profiles.db",
  ]);
  assert.equal(parsed.optimizationProfile, "balanced");
  assert.equal(parsed.schedulerMode, "active");
});

test("legacy quality mode maps to balanced when no profile is supplied", () => {
  assert.equal(parseLegacyRun().optimizationProfile, "balanced");
});

test("desktop creates one runtime profile store under userData", () => {
  assert.equal(
    runtimeProfilePath("C:\\UserData"),
    "C:\\UserData\\runtime-profiles.db",
  );
});
```

- [ ] **步骤 2：运行目标测试并确认失败**

```powershell
npm test -- --test-name-pattern="optimization profile and scheduler|legacy quality mode|runtime profile store under userData"
```

预期：FAIL。

- [ ] **步骤 3：扩展 CLI 参数**

新增：

```text
--optimization-profile economy|balanced|speed
--scheduler-mode off|shadow|active
--runtime-profile-store <absolute-or-resolved-path>
```

若同时给出旧 `--run-mode` 和新 profile，只有映射一致时允许；不一致时返回
`CLI_ERROR`。CLI 未给 profile store 时使用
`join(homedir(), ".folioloom", "runtime-profiles.db")`，创建父目录。

- [ ] **步骤 4：更新桌面合同与 runtime plan**

```ts
export type DesktopOptimizationProfile =
  | "economy"
  | "balanced"
  | "speed";

export interface DesktopStartFullBookRequest {
  optimizationProfile: DesktopOptimizationProfile;
}
```

旧持久化 run 的 `quality/fast` 继续显示；新运行 metadata 同时保存
`optimizationProfile`。`desktop-runtime-plan.ts` 从供应商 efforts 产生同一
model 的合法 variants，并通过 `validateRuntimeVariants()`。

- [ ] **步骤 5：在 main process 创建共享 profile store**

把路径规则放进无 Electron 依赖的纯函数模块：

```ts
export function runtimeProfilePath(userDataPath: string): string {
  return join(userDataPath, "runtime-profiles.db");
}
```

main 进程调用 `runtimeProfilePath(app.getPath("userData"))` 并拥有 store
生命周期；服务只接收实例，不向 renderer 暴露路径或 SQLite 句柄。退出时
关闭 store。纯函数由 `desktop-runtime-profile-path.test.ts` 覆盖 Windows
和 POSIX 路径样本。

- [ ] **步骤 6：更新 GUI**

`RunWorkspace` 增加三个单选按钮：

```tsx
{(["economy", "balanced", "speed"] as const).map((profile) => (
  <button
    key={profile}
    type="button"
    aria-pressed={selectedProfile === profile}
    onClick={() => setSelectedProfile(profile)}
  >
    {profileLabel(profile)}
  </button>
))}
```

显示：

- 预计剩余时间；
- 预计 token 区间；
- 实际与预计偏差；
- “正在因限流调整并发”等短状态。

不显示公式、权重和 horizon。

- [ ] **步骤 7：运行 CLI、IPC、service 与 renderer 测试**

```powershell
npm test -- --test-name-pattern="optimization profile|runtime profile|fullbook"
npm run desktop:test
npm run desktop:typecheck
```

预期：Node 与 renderer 全部 PASS。

- [ ] **步骤 8：提交**

```powershell
git add folioloom/src/cli.ts folioloom/src/desktop/contracts.ts folioloom/src/desktop/runtime-profile-path.ts folioloom/src/desktop/desktop-runtime-plan.ts folioloom/src/desktop/desktop-fullbook-service.ts folioloom/src/desktop/main/index.ts folioloom/src/desktop/main/ipc.ts folioloom/src/desktop/preload/index.ts folioloom/src/desktop/preload/folioloom-api.d.ts folioloom/src/desktop/renderer/src/components/RunWorkspace.tsx folioloom/src/desktop/renderer/src/components/RunWorkspace.test.tsx folioloom/src/desktop/renderer/src/styles.css folioloom/test/cli.test.ts folioloom/test/desktop-fullbook-service.test.ts folioloom/test/desktop-ipc.test.ts folioloom/test/desktop-runtime-plan.test.ts folioloom/test/desktop-runtime-profile-path.test.ts
git commit -m "feat: expose dynamic translation modes"
```

---

### 任务 13：影子对比、真实回放、全量验证与文档

**文件：**
- 修改：`folioloom/src/report.ts`
- 修改：`folioloom/README.md`
- 创建：`docs/superpowers/reports/2026-07-27-rolling-horizon-scheduler-validation.md`
- 创建：`folioloom/scripts/prepare-revalidation-benchmark.ts`
- 测试：`folioloom/test/prepare-revalidation-benchmark.test.ts`
- 测试：`folioloom/test/rolling-horizon-planner.test.ts`
- 测试：`folioloom/test/book-runner.test.ts`
- 测试：`folioloom/test/desktop-fullbook-service.test.ts`

- [ ] **步骤 1：增加固定影子对比报告测试**

```ts
test("scheduler metrics compare legacy, predicted, and actual execution", () => {
  const report = schedulerMetrics(fixtureRun());
  assert.deepEqual(report.wallTime, {
    legacyEstimateMs: 492_000,
    plannedEstimateMs: 240_000,
    actualMs: 238_000,
  });
  assert.equal(report.tokenEnvelope.exceeded, false);
});
```

- [ ] **步骤 2：运行测试并确认缺少最终 metrics**

```powershell
npm test -- --test-name-pattern="scheduler metrics compare"
```

预期：FAIL。

- [ ] **步骤 3：完成 metrics 与诊断输出**

最终 metrics 必须包含：

- profile、mode、planner status；
- legacy/predicted/actual 时间；
- baseline/allowed/predicted/actual token；
- 各上下文档案、effort、协议使用次数；
- planner deadline、fallback、限流与恢复次数；
- token usage 是否完整。

诊断包沿用隐私模式，只输出数值和 task/window ID，不输出 prompt、API Key
或正文。

- [ ] **步骤 4：运行 Kafka 离线回放**

```powershell
npm test -- --test-name-pattern="Kafka scheduler replay"
```

预期：

- predicted wall time ≤ 246,000 ms；
- 5 项任务全部计划；
- 无资源冲突；
- speed token ≤ baseline × 1.20；
- 规划时间 < 50 ms。

- [ ] **步骤 5：运行英语、德语、韩语、日语短样本**

使用仓库已有语言 profile fixtures，不下载新版权文本。每种语言比较 off 与
shadow：

- prompt 覆盖；
- token 预测误差；
- context profile；
- 校验结果。

shadow 阶段实际输出必须逐块一致；只允许 metrics 不同。

- [ ] **步骤 6：运行全套自动验证**

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
git diff --check
```

预期：

- 核心 0 fail；
- desktop Node 0 fail；
- renderer 0 fail；
- 两套 TypeScript 0 error；
- production build PASS；
- diff check 0 error。

- [ ] **步骤 7：实现只操作副本的 benchmark 准备器**

核心合同为：

```ts
export interface PrepareRevalidationBenchmarkOptions {
  readonly sourceStorePath: string;
  readonly outputStorePath: string;
  readonly runId: string;
  readonly taskCount: 5;
}

export interface PreparedRevalidationBenchmark {
  readonly outputStorePath: string;
  readonly sourceSha256Before: string;
  readonly sourceSha256After: string;
  readonly pendingTaskIds: readonly string[];
}
```

脚本参数为 `--source-store`、`--output-store` 和 `--run`。它必须：

1. 拒绝相同输入输出路径；
2. 拒绝已经存在的输出；
3. 用 `copyFileSync` 创建副本；
4. 在副本事务中查找五项 `resolved_retranslate` 任务及其当前 replacement；
5. 为当前活动 translation 创建新的 benchmark task ID 和 change set；
6. 仅在副本中把对应 binding 的 `term_usages_json` 置为 `[]`、
   `validation_status` 置为 `stale`；
7. 确认恰好创建 5 项 pending task，否则回滚并删除不完整副本。

测试使用临时 SQLite fixture，断言原库字节哈希不变、输出库有 5 项 pending、
所有任务引用活动 translation。若准备完成后源库哈希不一致，脚本必须删除
输出副本并以 `BENCHMARK_SOURCE_MUTATED` 失败。

- [ ] **步骤 8：进行真实《变形记》五块回溯复测**

使用既有项目副本，禁止直接覆盖唯一数据库：

1. 调用 benchmark 准备器创建新的 validation 数据库副本；
2. 确认原 `book.db` SHA-256 在准备前后相同；
3. 使用同一 DeepSeek 模型和相同质量门；
4. active/balanced 跑完五块；
5. 审计必须 `coverageMissing=0`、`knowledgeConverged=true`、0 incident；
6. 墙钟时间必须低于 246 秒；
7. token 不超过静态基线 10%；若供应商波动导致失败，保留原始数据并另跑
   离线回放，不修改门槛。

- [ ] **步骤 9：编写验证报告**

报告写入实际日期文件，记录硬件、模型、API 状态、样本、命令、时间、
token、缓存、失败、fallback、质量审计和已知限制。不得复制小说正文。

- [ ] **步骤 10：更新 README**

增加：

- 三种优化档位；
- CLI 参数；
- GUI 使用方法；
- runtime profile store 隐私说明；
- shadow/off 回退方法；
- 性能数字是特定环境实测，不是跨供应商承诺。

- [ ] **步骤 11：提交**

```powershell
git add folioloom/src/report.ts folioloom/README.md folioloom/scripts/prepare-revalidation-benchmark.ts folioloom/test/prepare-revalidation-benchmark.test.ts folioloom/test/rolling-horizon-planner.test.ts folioloom/test/book-runner.test.ts folioloom/test/desktop-fullbook-service.test.ts docs/superpowers/reports/2026-07-27-rolling-horizon-scheduler-validation.md
git commit -m "docs: validate dynamic translation scheduler"
```

---

## 完成门

以下条件全部成立才可宣布功能完成：

1. 13 个任务全部提交，工作树只保留用户原有的无关文件；
2. 新调度器在 `off` 下与旧执行行为一致；
3. shadow 模式不改变译文、调用顺序或数据库状态；
4. active 模式不突破质量门、token 包络和资源依赖；
5. 《变形记》五块回溯低于 246 秒；
6. 核心、桌面、类型检查、production build 和审计全部通过；
7. 真实运行中出现的 provider 波动与不完整 usage 在报告中明确标注；
8. 不把动态调度默认推送给旧的进行中运行。
