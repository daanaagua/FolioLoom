# FolioLoom 预算事务系统规格

日期：2026-07-29
状态：实施中
目标版本：FolioLoom 1.5.x
适用范围：长篇翻译中的主译、repair、协议降级、上下文拆分、lexical anchor、
revalidation、续跑、导出与 CLI 状态投影
前置规格：
`docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`

## 1. 决策摘要

FolioLoom 不再把 token 控制视为若干调用点上的预测与累计，而把每一次供应商模型
调用视为一笔可持久化、可重放、可对账的预算事务。

系统必须满足：

> 模型调用只有在预算已经原子预留后才能发车；任何已发车调用最终都必须结算；
> 结算完成后，模型输出才允许推动 fallback、业务解析、提交或导出。

本规格在现有事件存储上演进，不新增 `book.db` 关系表。权威状态仍由事件重放产生，
`scheduler_run_projection` 只是可丢弃缓存。

## 2. 背景与根因

2026-07-29 的双语 100k release gate 暴露了四类表面故障：

1. 英文单窗口 CLI 投影为 31,827 token，而 durable ledger 为 34,614；
2. structured lexical anchor 失败后进入 framed fallback，首个已完成调用的 usage
   没有进入结算，`tokenUsageComplete=false`；
3. high reasoning 的静态预留为 4,096，而真实 reasoning 为 18,958；
4. anchor 静态预测固定为每个候选 120 token，实际调用为 5,736–7,200；
5. 调度器调用 `canLaunch` 时仍把 `conservativeHorizonFloor` 留为 0。

这些故障共享以下结构性根因：

- usage 的捕获晚于协议解析；解析抛错会丢失已经返回的供应商 usage；
- scheduler、CLI 和 ledger 可以各自持有可变累计值；
- 请求预算公式分散在 translation、anchor 和 recovery 路径；
- 包络检查与 reservation 不是同一个原子操作；
- open reservation 没有“未发车”和“可能已经发车”的持久化区别。

因此，单独调大常数或在 finally 中多刷新一次，只能覆盖已经看见的症状。

## 3. 目标

1. 已发车 attempt 必然且只结算一次；
2. 协议失败、工具失败、fallback、超时、取消和进程恢复均不丢 usage；
3. CLI、scheduler、导出和 resume 只读取同一份 ledger 投影；
4. 所有模型路径使用同一个 Budget Oracle；
5. active 模式在发车前原子检查完整 horizon 下界；
6. 任意事件重放得到相同账目；重复操作不产生重复扣账；
7. 账目不完整或对账失败时 fail closed，禁止严格导出和 release；
8. 保持逻辑窗口、质量门、知识语义和 `CommitCoordinator` 顺序不变。

## 4. 非目标

- 不保证供应商服务可用；
- 不解决翻译质量、文件编码或输入内容本身的问题；
- 不通过扩大 token cap 规避预测错误；
- 不改变 economy/balanced/speed 的用户语义；
- 不新增普通用户可配置的调度旋钮；
- 不提交 API Key、prompt、原文、译文或真实运行数据库；
- 不在本次改造中重写 Python 历史导入栈。

## 5. 核心不变量

### I1：先预留，后发车

每个 provider attempt 必须拥有稳定且唯一的 `attemptId`。在调用供应商前，必须先
持久化 reservation。active 模式下，检查与写入 reservation 必须通过同一个
Admission API 完成。

### I2：已发车必结算

每个已发车 attempt 最终恰好产生一个终结事件：

- `settled`：供应商已可能计费；
- `released`：能够证明从未发车。

不能证明未发车时，不允许 release；必须按 reservation 全额保守结算并标记 usage
不完整。

### I3：先记账，后解析

供应商响应中的 usage 必须在业务 JSON、typed tool、framed text、质量校验或 fallback
逻辑之前进入预算事务结果。协议解析失败不能抹掉已经观察到的 usage。

过渡期内，若底层 runtime 仍在一次调用中执行工具协议，它抛出的 typed error 必须
携带完整 `PiRunResult`；事务边界先结算其中的 usage，再决定 fallback。

### I4：单一真相源

```text
spent     = Σ terminal settled charges
reserved  = Σ open reservations
remaining = allowed - spent - reserved
projection.actualTokens = spent
```

任何内存 metrics 都是 ledger 的派生视图，不得独立增加 actual token。

### I5：幂等

同一 `attemptId`：

- 最多 reserve 一次；
- 最多 dispatch 一次；
- 最多终结一次；
- 终结后不能再次使用。

重复传入完全相同的持久化事件可以由存储层按事件 ID 去重；语义冲突必须确定性失败。

### I6：未知 usage 保守扣账

若调用可能已经发车但无法获得完整 usage：

```text
chargedTokens = max(observedTotalTokens, reservedTokens)
tokenUsageComplete = false
```

若 usage 完整：

```text
chargedTokens = observedTotalTokens
```

失败、协议错误和取消不构成免计费理由。

### I7：原子 horizon 准入

active 模式发车前必须满足：

```text
spent
+ open reservations
+ new attempt reservation
+ mandatory pending horizon floor
<= allowed
```

`mandatory pending horizon floor` 是所有已认领、未完成且未被 open reservation 覆盖的
强制任务最低合法预算之和，并包含尚未执行的必要 anchor/revalidation/finalize 成本。
该值必须在 reserve 时提交，不能只在更早的 `canLaunch` 查询中使用。

### I8：结束时强制对账

run 正常返回、异常退出及 resume 前都必须重放或折叠 ledger 并检查：

- 无无法解释的 open attempt；
- projection 与 ledger 相等；
- 所有 dispatched attempt 已终结；
- 计数和 token 值均为非负安全整数。

任一检查失败时写稳定 incident，禁止严格导出。

### I9：源出现必须按字面投影

源词的“语义身份归一化”和“字面出现匹配”是两个不同操作。前者可以把英文所有格
归并到词元，后者只能处理 NFKC、大小写和等价撇号，不能删除形态。term usage、
concept occurrence 与 knowledge impact 必须共享同一套字面匹配语义。

resume 前从不可变源文和当前 active concepts 重建 occurrence projection。旧版本留下的
伪出现、孤儿 binding 与依赖伪出现的 pending/validating revalidation task 必须在任何
provider 调用前原子退役。

### I10：模型可见结构复杂度有硬上限

token 合法不等于结构可可靠生成。一个逻辑 source block 最多包含 32 个语义段落；
超过时只允许在既有段落边界切块，原文坐标、重建顺序与 logical window 提交顺序不变。
这样段落遗漏仍由质量硬门拒绝，但恢复可以隔离到更小的 immutable block，不需要放宽
一一对应要求。

### I11：usage 不完整立即形成运行边界

同一 run 一旦出现已发车且 `usageComplete=false` 的 provider attempt，该 run 已经不可能
满足 strict export。主译、revalidation 和 lexical anchor 不得在该错误之后自动发起
新的 provider attempt，也不得把 transport/provider failure 转写成翻译质量 warning。

当前已经发车的并发 sibling 可以等待结算；尚未发车的工作必须保留为 pending。被
provider failure 中断的 revalidation task 必须恢复为 pending，且该 transport failure
不消耗语义质量重试次数。下次显式 resume 使用新的 ledger attempt ID。

### I12：重校验质量失败必须进入修复闭环

revalidation 产生的新译文必须在同一个已记账请求内同时接受块内校验、术语 receipt
校验和已提交相邻块校验。相邻块重复等可修复失败必须连同稳定 failure code 进入
targeted repair，不能等请求成功返回后才在外层转写为无反馈的盲重试。

相邻已提交块只作为不可变校验上下文，repair 只能改写当前 revalidation block。修复后
必须重新执行全部校验；runner 在持久化前还要保留一次相邻块终态校验，以阻断修复期间
并发提交造成的竞态。重复尝试耗尽后仍须保留 `warning_stale` 并禁止严格导出，不能为
通过 release gate 而放宽知识收敛要求。

## 6. Attempt 状态机

```text
planned（非持久化）
  │
  ▼
reserved ───────► released（仅可证明未发车）
  │
  ▼
dispatched
  │
  ├─────────────► settled(success)
  ├─────────────► settled(protocol)
  ├─────────────► settled(failed)
  └─────────────► settled(cancelled)
```

`response_received`、`accounted` 和 `parsed` 是执行器内部顺序，不需要单独成为存储事件；
其中 accounted 必须早于 parsed/fallback。

### 6.1 稳定标识

```text
operationId = 逻辑业务操作，例如 translate:window-12
attemptId   = operationId + 协议/fragment/retry/ordinal 的稳定派生
```

fallback、repair、context fragment 和 provider retry 都是新的 attempt，不复用父 attempt
的 reservation。

### 6.2 事件

沿用并扩展现有事件：

```text
token_ledger_baseline_added
token_ledger_reserved
token_ledger_dispatched
token_ledger_settled
token_ledger_released
token_ledger_counters_patched
scheduler_run_projection
```

payload 只包含 ID、枚举和数值，不包含 prompt 或文本内容。

## 7. 组件边界

### 7.1 TokenLedger

职责：

- 纯事件折叠；
- 校验状态迁移；
- 计算 spent/reserved/allowed；
- 提供 reconciliation 结果；
- 生成 `SchedulerRunReport`。

它不调用模型、不做预测、不写数据库。

### 7.2 AdmissionController

权威 API：

```ts
reserve({
  attemptId,
  operationId,
  purpose,
  taskIds,
  predictedTokens,
  attempt,
  conservativeHorizonFloor,
}): Reservation

markDispatched(attemptId): void
settle({...}): void
releaseUnlaunched(attemptId): void
```

`canLaunch` 只用于 UI 或 planner 提示，不能作为安全边界；真正安全边界是 `reserve`。

### 7.3 BudgetTransactionExecutor

为所有 provider 调用提供统一模板：

```ts
const reservation = admission.reserve(spec);
try {
  admission.markDispatched(spec.attemptId);
  const provider = await invoke();
  admission.settle(usageFrom(provider));
  return parse(provider);
} catch (error) {
  const run = providerRunFromError(error);
  admission.settle(run === undefined
    ? unknownUsageSettlement(reservation)
    : observedUsageSettlement(run));
  throw error;
}
```

若结算本身发现硬包络超限，必须保留原始业务错误作为 `cause`，但以稳定的
`TOKEN_ENVELOPE_EXHAUSTED` 阻断后续发车。

### 7.4 Budget Oracle

translation、anchor、repair、protocol fallback 和 revalidation 必须共享同一评估器。

输入：

- 实际序列化后的 system prompt、messages、工具 schema 和 JSON payload；
- provider/model/context capacity/max completion；
- source language、task type、protocol、reasoning effort；
- 历史 profile（若有）。

输出：

```text
inputEstimate
inputUncertainty
visibleOutputUpperBound
reasoningUpperBound
protocolFallbackReserve
safetyMargin
totalReservation
confidence
breakdown
```

要求：

1. completion 的 visible output 与 reasoning 总和不能超过模型 max completion；
2. 冷启动使用 effort 相对于 max completion 的保守比例；
3. 有足够完整样本后使用分组高分位数，但不能跌破冷启动安全下限；
4. 供应商 output 已包含 reasoning 时，不得在实际 usage 中重复相加；
5. 不允许 anchor 使用 `candidateCount × 常数` 作为最终 reservation；
6. 未识别的新模型或 effort 必须走保守路径。

## 8. Resume 与崩溃恢复

启动时重放事件：

- `reserved` 且未 `dispatched`：可安全 release；
- `dispatched` 且未终结：若没有可验证 usage，按 reservation 全额 settle，
  `usageComplete=false`；
- 已终结：保持原结果；
- projection 与重放不一致：以重放为准并写新 projection，同时产生审计 incident。

旧版本没有 `dispatched` 事件的 reservation 按兼容策略处理：

- 同一历史序列中已 settled/released：正常重放；
- 遗留 open reservation：按旧行为仅在能够证明进程停在发车前时 release，否则保守
  settle。完成迁移后不得再写入无 dispatched 的新 attempt。

## 9. Horizon floor

对当前调度快照构造集合：

```text
claimed mandatory tasks
- completed/staged tasks
- tasks covered by open reservations
- candidate task being reserved
```

对剩余任务调用 Budget Oracle 的最低合法静态变体，并求和。计算必须使用稳定 logical
task ID 去重，physical request 的拆分或合并不能重复扩大 baseline/floor。

当 floor 本身已大于 remaining 时，active 模式在下一次 provider 调用前返回
`TOKEN_ENVELOPE_EXHAUSTED`；已提交结果不回滚。

## 10. 投影与导出

- 每个 ledger 事件后内存 report 从 ledger hydrate；
- 每个 wave 边界及 run 的 finally 保存一次 projection；
- CLI 在 runner 返回后重新从 store 读取最终 projection，不传入可能过期的内存副本；
- export 在存在 ledger 时必须从 store 对账；
- `tokenUsageComplete=false`、open reservation、projection mismatch 任一成立时，
  `strictExportable=false`。

## 11. 实施分片

### P0：usage 与真相源

- `ModelProviderError` 携带已完成 `PiRunResult`；
- protocol/fallback 路径先捕获 usage；
- runner 返回、CLI 和异常 finally 都从 ledger hydrate；
- 增加最终 reconciliation。

### P1：attempt 状态

- 新增 dispatched 事件与终结 ID 集合；
- Admission 的 reserve 接收 horizon floor；
- resume 区分未发车和已发车 reservation；
- 所有 provider 路径迁入 attempt API。

### P2：统一 Budget Oracle

- RequestBudgeter 改为 Oracle adapter；
- lexical anchor 使用真实 payload 与 tool schema；
- reasoning reserve 使用模型 completion 容量和 effort 的保守边界；
- profile 学习只在完整 usage 上更新。

### P3：原子 horizon

- planner 输出 mandatory pending floor；
- reserve 原子检查并写入；
- 删除生产路径中的默认 0。

### P4：故障注入与真实门禁

- 在每个 attempt 状态边界模拟失败和恢复；
- 全量测试、typecheck、desktop test/build；
- 全新德语与《时间之子》100k release gate。

## 12. 测试矩阵

### 12.1 单元与性质

- reserve→dispatch→settle；
- reserve→release；
- dispatch 后禁止 release；
- settle/release 后禁止复用 attemptId；
- double settle、unknown settle、duplicate dispatch 确定性失败；
- 事件重放结果相同；
- `spent + reserved + new + floor` 的等号边界通过、差 1 拒绝；
- projection actual 始终等于 ledger spent。

### 12.2 协议与 usage

- typed tool 未调用但响应带 usage；
- framed JSON 解析失败但响应带 usage；
- provider error 带部分或完整 usage；
- structured→framed fallback 的两次调用分别计费；
- usage 真正缺失时按 reservation 扣账并标 incomplete。
- 故障注入 retryable provider error 后不允许同一 run 继续主译、revalidation 或
  lexical anchor；revalidation 保持 pending，且不生成 warning。
- revalidation 候选与已提交相邻块发生重复时，同一请求内触发一次 targeted repair；
  repair 只包含当前 block，并在返回后重新通过块内、术语和相邻块校验。

### 12.3 恢复与并发

- 在 reserve、dispatch、响应、settle、parse 后分别模拟崩溃；
- 重复事件和重复 resume；
- 两个 worker 同时争用最后余额；
- shutdown、abort 与 settle 交错；
- context/protocol split 多层递归有界。
- resume 重建字面 occurrence projection 并退役旧伪任务；
- 英文所有格 source form 不得反向匹配不带所有格的基本词；
- 80 段 frontmatter 在完整重建前提下切成每块不超过 32 段。

### 12.4 预算

- 16 个 anchor 候选的完整 prompt/schema 被测量；
- high effort 冷启动覆盖 18,958 reasoning 样本；
- completion reserve 不超过模型 max completion；
- 新模型、未知 effort 使用保守默认值；
- 低样本 profile 不得把 reservation 学习到安全下限以下。

## 13. 验收标准

| ID | 标准 |
|----|------|
| B1 | 任意已发车 attempt 恰好结算一次 |
| B2 | structured→framed fallback 在 usage 完整时保持 `tokenUsageComplete=true` |
| B3 | CLI、runner report、store projection、ledger replay 的 actual 完全相等 |
| B4 | 生产 active reserve 不再使用隐式 horizon floor 0 |
| B5 | anchor reservation 来自完整序列化 payload，不使用候选数常数 |
| B6 | high 冷启动 reasoning reservation 不低于已验证的 18,958 样本 |
| B7 | 崩溃恢复不释放可能已经计费的 attempt |
| B8 | 两个全新 100k 均 19/19、usage complete、actual ≤ allowed、strict export |
| B9 | Node、Renderer、typecheck、desktop production build 和 diff-check 全部通过 |

只有 B1–B9 全部满足，才允许更新版本号、tag、push 和 release。

## 14. 回滚与兼容

- 事件扩展不改变 SQLite schema；旧 ledger 可继续重放；
- 新 reader 接受旧事件，新 writer 只写新 attempt 生命周期；
- 若 P1–P3 出现回归，可以关闭 active 硬拒发，但不得关闭记账、对账或 strict export
  阻断；
- 不允许回滚到“未知 usage 直接 release”或“CLI 信任内存累计”的行为。
