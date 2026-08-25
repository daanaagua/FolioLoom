# Token 账本与调度控制面 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 run 级 token 硬包络与 scheduler metrics 做成可恢复的权威状态，使 active 模式旁路计费完整、续跑不丢账、独立 export 可读 metrics。

**架构：** 纯函数 `TokenLedger` 折叠事件；经 `LosslessBookStore` 事件流持久化并投影为 `SchedulerRunReport`；runner 全路径 `reserve→settle/release`；export 从 store 加载 metrics。P1+ 再拆 Admission/Worker 与 AIMD 传感化。

**技术栈：** TypeScript、Node test runner、tsx、既有 SQLite `events` 表（不改关系 schema）

**规格：** `docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `folioloom/src/fullbook/token-ledger.ts` | 纯事件折叠、硬门、`toSchedulerRunReport` |
| 创建 `folioloom/test/token-ledger.test.ts` | ledger 单元测试 |
| 修改 `folioloom/src/storage/lossless-book-store.ts` | append/load ledger 事件、投影、metrics 加载 |
| 创建 `folioloom/test/token-ledger-store.test.ts` | 持久化与重放集成 |
| 修改 `folioloom/src/report.ts` | export 回退读 store metrics |
| 修改 `folioloom/src/fullbook/book-runner.ts` | 接 ledger：baseline/reserve/settle、resume |
| 修改 `folioloom/src/fullbook/revalidation-executor.ts` | 回溯模型调用并入同一 ledger |
| 修改 `folioloom/src/cli.ts` / desktop export | 确保 export 路径用 store 加载 |
| 修改 `folioloom/test/book-runner.test.ts` 等 | 续跑、旁路计费、拒发、export |
| 修改 `STATE.md` | 阶段状态 |
| 后续 P1：`admission-controller.ts`、`execution-worker.ts`、`telemetry-sink.ts` | 控制面拆分 |
| 后续 P2：`congestion-sensor.ts` 或改造 `adaptive-scheduler.ts` | AIMD 传感化 |

---

### 任务 1：纯 TokenLedger 折叠与硬门

**文件：**
- 创建：`folioloom/src/fullbook/token-ledger.ts`
- 创建：`folioloom/test/token-ledger.test.ts`

- [ ] **步骤 1：编写失败的单元测试**

覆盖：
1. 空 ledger 状态全 0，`tokenUsageComplete=true`
2. `baselineAdded` 累加 baseline 与 allowed（balanced cap 0.10）
3. 同一 taskId 第二次 baseline 被拒绝或 no-op 去重（规格：至多一次；实现选 **确定性 throw**）
4. `reserved` 增加 reserved；`settled` 成功扣 reserved、加 spent
5. 失败有 usage：spent += actual
6. usage 缺失：spent += reserved，`tokenUsageComplete=false`
7. `released`：扣 reserved，不进 spent
8. 非法：未 reserve 就 settle → throw
9. 非法：双重 settle → throw
10. `canReserve(n, floor)`：spent+reserved+n+floor ≤ allowed
11. `toSchedulerRunReport` 字段与 `SchedulerRunReport` 对齐

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
  TokenLedger,
  type TokenLedgerEvent,
} from "../src/fullbook/token-ledger.js";

test("empty ledger starts at zero", () => {
  const ledger = TokenLedger.create({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: 0.1,
  });
  const s = ledger.state();
  assert.equal(s.baselineTokens, 0);
  assert.equal(s.spentTokens, 0);
  assert.equal(s.reservedTokens, 0);
  assert.equal(s.tokenUsageComplete, true);
});

test("baseline and settle feed hard gate", () => {
  const ledger = TokenLedger.create({
    mode: "active",
    profile: "balanced",
    tokenIncreaseCap: 0.1,
  });
  ledger.apply({
    type: "baseline_added",
    taskIds: ["t1"],
    baselineTokens: 1000,
    source: "translate_horizon",
    reason: "test",
  });
  assert.equal(ledger.state().allowedTokens, 1100);
  assert.equal(ledger.canReserve(100, 0), true);
  ledger.apply({
    type: "reserved",
    requestId: "r1",
    purpose: "translate",
    taskIds: ["t1"],
    predictedTokens: 100,
    attempt: 0,
  });
  ledger.apply({
    type: "settled",
    requestId: "r1",
    actualTokens: 120,
    usageComplete: true,
    outcome: "success",
  });
  assert.equal(ledger.state().spentTokens, 120);
  assert.equal(ledger.state().reservedTokens, 0);
  assert.equal(ledger.canReserve(990, 0), false);
});
```

再补 usage 缺失、release、非法序列、taskId 去重测试。

- [ ] **步骤 2：运行测试确认失败**

```bash
cd folioloom && node --test --import tsx test/token-ledger.test.ts
```

预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 `token-ledger.ts`**

关键 API（实现时保持此命名）：

```typescript
export type LedgerPurpose =
  | "translate" | "repair" | "protocol_switch"
  | "context_split" | "anchor" | "revalidate";

export type LedgerEvent =
  | {
      type: "baseline_added";
      taskIds: readonly string[];
      baselineTokens: number;
      source: "translate_horizon" | "revalidate" | "anchor" | "recovery_floor";
      reason: string;
    }
  | {
      type: "reserved";
      requestId: string;
      purpose: LedgerPurpose;
      taskIds: readonly string[];
      predictedTokens: number;
      attempt: number;
    }
  | {
      type: "settled";
      requestId: string;
      actualTokens: number;
      usageComplete: boolean;
      outcome: "success" | "protocol" | "failed" | "cancelled";
    }
  | {
      type: "released";
      requestId: string;
      reason: "not_launched" | "superseded" | "run_cancelled";
    }
  | {
      type: "metrics_patch";
      // 调度计数补丁：decisions/fallbacks/.../planningStatus/predicted*
      patch: Partial<SchedulerCounters>;
    };

export class TokenLedger {
  static create(init: {
    mode: SchedulerMode;
    profile: OptimizationProfile;
    tokenIncreaseCap: number;
  }): TokenLedger;

  static fromEvents(
    init: { mode: SchedulerMode; profile: OptimizationProfile; tokenIncreaseCap: number },
    events: readonly LedgerEvent[],
  ): TokenLedger;

  apply(event: LedgerEvent): void;
  state(): Readonly<LedgerState>;
  canReserve(newReserveTokens: number, conservativeHorizonFloor: number): boolean;
  toSchedulerRunReport(): SchedulerRunReport;
}
```

规则严格按规格 §5.3–5.6。`metrics_patch` 用于把 decisions 等非 token 计数并入同一可持久化流（可映射为 projection 字段；若不想进 ledger 事件，也可只写 projection——**本计划选择：token 四类事件进 ledger；调度计数通过 `scheduler_run_projection` 全量快照持久化，ledger 重放只保证 token 字段，完整 report = token state + 最新 projection 计数合并**）。

更简实现约定（锁定）：

- ledger 事件仅四种 token 事件 + 可选 `counters_patched`
- `counters_patched` payload 为增量或快照均可，P0 用**快照替换**计数区，避免增量丢失

- [ ] **步骤 4：运行测试确认通过**

```bash
cd folioloom && node --test --import tsx test/token-ledger.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add folioloom/src/fullbook/token-ledger.ts folioloom/test/token-ledger.test.ts
git commit -m "$(cat <<'EOF'
feat: add pure token ledger folding and hard gate

EOF
)"
```

---

### 任务 2：Store 事件持久化、重放与 metrics 加载

**文件：**
- 修改：`folioloom/src/storage/lossless-book-store.ts`
- 创建：`folioloom/test/token-ledger-store.test.ts`
- 可能导出类型到 store 公共方法旁

- [ ] **步骤 1：编写失败的 store 测试**

使用既有测试创建临时 book.db 的模式（参考 `book-runner.test.ts` / `lossless` 相关 setup）：

1. `appendTokenLedgerEvent` + `loadTokenLedger` 重放一致  
2. `saveSchedulerRunProjection` + `loadSchedulerMetrics` 返回完整 `SchedulerRunReport`  
3. 无投影时从 ledger 重放得到至少 token 字段正确的 report（计数可为 0）  
4. 无任何事件时 `loadSchedulerMetrics` 返回 `undefined`

- [ ] **步骤 2：运行确认失败**

```bash
cd folioloom && node --test --import tsx test/token-ledger-store.test.ts
```

- [ ] **步骤 3：实现 store API**

```typescript
// LosslessBookStore 新增：
appendTokenLedgerEvent(runId: string, event: LedgerEvent & { ts?: string }): void
loadTokenLedgerEvents(runId: string): LedgerEvent[]
loadTokenLedger(runId: string, init: TokenLedgerInit): TokenLedger
saveSchedulerRunProjection(runId: string, report: SchedulerRunReport): void
loadSchedulerMetrics(runId: string): SchedulerRunReport | undefined
```

事件 kind 映射：

| LedgerEvent.type | events.kind |
|------------------|-------------|
| baseline_added | `token_ledger_baseline_added` |
| reserved | `token_ledger_reserved` |
| settled | `token_ledger_settled` |
| released | `token_ledger_released` |
| counters_patched | `token_ledger_counters_patched` |
| （投影） | `scheduler_run_projection` |

查询：`WHERE run_id=? AND kind IN (...) ORDER BY sequence ASC`

`#appendEvent` 已是 private，新方法在 `#transaction` 内调用它。

- [ ] **步骤 4：测试通过**

- [ ] **步骤 5：Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: persist token ledger events and scheduler projection

EOF
)"
```

---

### 任务 3：export 从 store 读取 scheduler metrics

**文件：**
- 修改：`folioloom/src/report.ts`
- 修改：`folioloom/test/export-verifier.test.ts` 或新增断言
- 检查：`folioloom/src/cli.ts` `book export`
- 检查：`folioloom/src/desktop/desktop-export-service.ts`

- [ ] **步骤 1：写失败测试**

构造带 projection 的 store，调用 `writeLosslessBookArtifacts(store, runId, outDir)` **不传** `scheduler`，读 metrics JSON，断言 `scheduler !== null` 且 `tokenEnvelope.actualTokens` 正确。

- [ ] **步骤 2：改 `writeLosslessBookArtifacts`**

```typescript
const schedulerReport = options.scheduler
  ?? store.loadSchedulerMetrics(runId);
// ...
scheduler: schedulerMetricsProjection(schedulerReport),
```

- [ ] **步骤 3：测试通过并 commit**

```bash
git commit -m "$(cat <<'EOF'
feat: load scheduler metrics from store during export

EOF
)"
```

---

### 任务 4：book-runner 接入 ledger（baseline / 主翻译 settle / resume）

**文件：**
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/test/book-runner.test.ts`（或新建 `token-ledger-runner.test.ts`）

- [ ] **步骤 1：写失败集成测试**

1. 一次 run 后关闭 store，再次 `runBook` resume：第二次开始时 metrics/ledger 的 spent 与 baseline 非 0（若第一段已有完成窗口）  
2. 内存 `result.scheduler.actualTokens` 与 `store.loadSchedulerMetrics` 一致  

可用现有 mock provider 路径，不必真模型。

- [ ] **步骤 2：最小接入**

在 `runLosslessBook` 内：

```typescript
const ledger = store.loadTokenLedger(runId, {
  mode: schedulerMode,
  profile: optimizationProfile,
  tokenIncreaseCap: optimizationPolicy(profile).tokenIncreaseCap,
}) // 无事件时 create 空账本
// 用 ledger.state() 初始化 cumulativeBaseline / actualTokens 等
```

当 `retryRound === 0` 增加 baseline 时：

```typescript
ledger.apply({ type: "baseline_added", taskIds, baselineTokens, source: "translate_horizon", reason: "wave_admit" });
store.appendTokenLedgerEvent(runId, event);
```

每个物理翻译请求发车前：

```typescript
if (mode === "active" && !ledger.canReserve(predicted, floor)) {
  throw new BookTokenEnvelopeExceededError(...);
}
ledger.apply(reserved); store.append...
// 调用后
ledger.apply(settled); store.append...
store.saveSchedulerRunProjection(runId, ledger.toSchedulerRunReport());
```

`schedulerMetrics` 对象改为以 ledger 为源，或每次从 ledger 同步。

- [ ] **步骤 3：测试通过并 commit**

```bash
git commit -m "$(cat <<'EOF'
feat: restore and record token ledger in book runner

EOF
)"
```

---

### 任务 5：旁路路径 reserve/settle（repair / protocol / split / anchor）

**文件：**
- 修改：`folioloom/src/fullbook/book-runner.ts`（翻译批内 recovery）
- 测试：扩展 runner 测试，强制触发 protocol 失败后降级或 repair mock

- [ ] **步骤 1：写失败测试**

模拟：主请求失败（protocol）+ 第二次 framed 成功 → ledger 中 **两次** settle，spent 为两次 usage 之和；baseline 只加一次。

- [ ] **步骤 2：在所有二次模型调用点包 admit**

purpose 分别：`repair` | `protocol_switch` | `context_split` | `anchor`

active 下二次调用前同样 `canReserve`。

- [ ] **步骤 3：通过并 commit**

```bash
git commit -m "$(cat <<'EOF'
feat: charge repair protocol split and anchor through token ledger

EOF
)"
```

---

### 任务 6：revalidation 并入同一 run ledger

**文件：**
- 修改：`folioloom/src/fullbook/revalidation-executor.ts`
- 修改：`folioloom/src/fullbook/book-runner.ts` 传入 ledger/store 回调
- 测试：revalidation 相关测试或新建

- [ ] **步骤 1：失败测试** — 回溯一次模型调用后 run ledger spent 增加  
- [ ] **步骤 2：executor 接受 `ledgerPort: { reserve, settle, release, canReserve }`**，禁止 `actualRunTokens: 0` 的孤立包络作为全书真相  
- [ ] **步骤 3：通过并 commit**

```bash
git commit -m "$(cat <<'EOF'
feat: fold revalidation model spend into run token ledger

EOF
)"
```

---

### 任务 7：active 硬拒发与 projection 刷盘、STATE 更新

**文件：**
- `book-runner.ts`、`dynamic-scheduler.ts`（确认无 legacy 绕过）
- `STATE.md`
- 全量测试

- [ ] **步骤 1：测试** — 人为极小 allowed（或高 spent）时 active 抛 `BookTokenEnvelopeExceededError`，且无新窗口 promote  
- [ ] **步骤 2：run 结束（含异常路径 finally）必 `saveSchedulerRunProjection`**  
- [ ] **步骤 3：`cd folioloom && npm test && npm run typecheck`**  
- [ ] **步骤 4：更新 STATE.md 勾选 P0 项，注明 P1–P4 未做**  
- [ ] **步骤 5：Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: enforce active envelope from durable ledger and update state

EOF
)"
```

---

### 任务 8（P1 大纲，P0 完成后另开执行）

- 抽出 `admission-controller.ts`、`execution-worker.ts`、`telemetry-sink.ts`
- AIMD in-flight 改读 ledger.reserved
- 不改变外部行为

### 任务 9（P2 大纲）

- `CongestionSensor` 包装 AdaptiveScheduler
- active 派发不再 `tryAcquire` 跳过任务
- 并发上限 = min(userMax, sensor.recommended)

### 任务 10（P4 大纲）

- 全新库德语 100k `active/balanced` 真跑
- 写 `docs/superpowers/reports/2026-07-28-...-live-validation.md`
- A5/A6 判定

---

## 自检

| 规格章节 | 任务 |
|----------|------|
| §5 Ledger 事件与硬门 | 任务 1–2 |
| §5.8 投影与导出 | 任务 2–3 |
| §5.7 Resume | 任务 4 |
| §6.2 六类路径 | 任务 4–6 |
| §6.3 active 硬拒发 | 任务 7 |
| §7 P1 | 任务 8 |
| §8 P2 | 任务 9 |
| §11.4/§12 P4 | 任务 10 |

无 TODO/TBD 占位。类型名以 `token-ledger.ts` 导出为准。
