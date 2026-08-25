# FolioLoom Token 账本与调度控制面设计

日期：2026-07-28  
状态：已确认设计  
目标版本：FolioLoom 1.5.x  
适用范围：普通长篇翻译、知识回溯、锚定、修复、协议降级、上下文拆分、导出与续跑  
前置设计：`docs/superpowers/specs/2026-07-27-rolling-horizon-dp-scheduler-design.md`

## 1. 背景

滚动动态规划调度器的规划核心与离线回放已完成，德语《变形记》前约 10 万字符真实验证表明：

- 无损覆盖、知识收敛、严格导出可以通过；
- active/balanced 的 token 硬包络失败（实际约 359,975，允许约 261,358）；
- 独立 `book export` 的 metrics 中 `scheduler` 为 `null`；
- 根因不是某种语言或某本书的特判缺失，而是 **run 级 token 与调度指标没有进入与提交顺序同级的权威、可恢复状态**。

当前缺陷是结构性的：

1. `baseline` / `actual` / 调度计数只活在单次 `runBook()` 进程内存中，续跑从 0 重算；
2. 硬门主要卡在“能否首次派发”，repair、协议降级、上下文拆分、锚定、回溯等旁路可以在发车后继续消耗 token；
3. 导出路径是 store-only，不持有本次进程的 `result.scheduler`；
4. Rolling DP 与 AdaptiveScheduler 双控制面并存，token 存在多套“货币”。

本设计补齐 **成本与调度的权威状态机**，并给出中长期控制面收敛路径。它是长期架构修复，不是德语链路补丁；公开德语样本只作为验收探针。

## 2. 目标

1. 将 token 硬包络做成权威、可恢复、可审计的 run 级状态；
2. 独立 CLI `book export` 与桌面导出能读出完整 scheduler metrics；
3. 主翻译、repair、协议降级、上下文拆分、lexical anchor、revalidation 共用同一包络账本；
4. 凡供应商真实消耗的 token 一律计入 spent，失败不扩大 baseline；
5. 中期收敛双调度器：active 模式由 DP/Admission 主导派发，AIMD 降为拥塞传感；
6. 不放宽质量门，不改变逻辑窗口边界，不改变 `CommitCoordinator` 提交顺序。

## 3. 非目标

- 不更换翻译模型，不修改知识结论语义；
- 不取消顺序提交、无损原文、知识收敛或严格导出门；
- 不在 GUI 暴露动态规划权重、滚动范围或内部公式；
- 不一次性求解整本书的全局最优并行计划；
- 不把文学润色或出版级文笔纳入调度验收；
- 不把价格金额当作硬门（硬门是归一化 token 量）；
- 不在本蓝图内重写 Python import 栈（仅冻结边界，迁移可另立项目）；
- 不新增 `book.db` 关系表；采用事件 + 投影。

## 4. 总体架构

```text
逻辑窗口 / 锚定 / 回溯 / 校验任务
              │
              ▼
       TaskGraphBuilder
              │
              ▼
    RollingHorizonPlanner          CongestionSensor (原 AIMD 传感化)
     纯数值决策，无 DB 写                    │
              │                              │
              ▼                              ▼
       AdmissionController ◄── TokenLedger(book.db 事件)
         预留 / 拒发 / 并发上限
              │
              ▼
       ExecutionWorker
     模型调用、协议、repair、拆分
              │
       settle / release
              ▼
       CommitCoordinator ──► 译文与知识提交（既有路径）
              │
              ▼
    SchedulerProjection ──► export / status / desktop
```

### 4.1 权威边界

| 组件 | 决定什么 | 持久化 |
|------|----------|--------|
| Planner | 合法变体与下一批动作 | 无写 |
| AdmissionController | 能否发车（包络、依赖、互斥、并发） | 经 Ledger 写 reserve |
| TokenLedger | baseline / spent / reserved / allowed | `book.db` 事件 |
| SchedulerProjection | run 级 metrics 快照 | 由事件折叠；可缓存事件 |
| CommitCoordinator | 窗口顺序提交 | 既有路径 |
| CongestionSensor | 拥塞档位与建议并发 | 可保留 snapshot；不改派发集合 |

### 4.2 阶段划分

| 阶段 | 交付 | 合并门槛 |
|------|------|----------|
| **P0** | Ledger 事件与投影；resume 恢复；export/desktop 读 metrics；全路径计费与发前预留；active 硬拒发 | 单测 + 集成；现有全量测试绿 |
| **P1** | 抽出 Admission / Worker / Telemetry；统一 estimate→reserve→settle；AIMD in-flight 改读 ledger | runner 职责变薄；测试绿 |
| **P2** | active：DP 主导派发；AIMD→拥塞传感 | active 不再双脑抢 permit |
| **P3** | Python/TS 边界文档化与接口冻结 | 无新的 Python 调度逻辑 |
| **P4** | 全新隔离库真实样本验收 | balanced 不超包络；质量零回归 |

P0 代码可在真跑前合并；**将 active 作为默认推荐模式对外承诺前，必须通过 P4**。

## 5. TokenLedger 事件模型

### 5.1 存储形态

沿用 `LosslessBookStore` 既有 `#appendEvent(runId, kind, payload)`，不新增关系表。

| kind | 含义 |
|------|------|
| `token_ledger_baseline_added` | 静态基线增量 |
| `token_ledger_reserved` | 某 request 发车前预留 |
| `token_ledger_settled` | 某 request 结束后按真实 usage 结算 |
| `token_ledger_released` | 预留作废（未发车取消等） |
| `scheduler_run_projection` | 折叠后的 run 级 metrics 缓存快照 |

**真相** = 按序重放全部 ledger 事件。  
`scheduler_run_projection` 是可丢弃缓存；缺失时必须能从 ledger 重建。

### 5.2 事件 payload

所有 payload 只含数值、短码与稳定 ID，**禁止** API Key、完整提示词、原文、译文。

```text
BaselineAdded:
  eventId, runId, ts
  source: "translate_horizon" | "revalidate" | "anchor" | "recovery_floor"
  taskIds: string[]
  baselineTokens: number
  reason: string

Reserved:
  eventId, runId, ts
  requestId: string
  purpose: "translate" | "repair" | "protocol_switch" | "context_split"
           | "anchor" | "revalidate"
  taskIds: string[]
  predictedTokens: number
  attempt: number

Settled:
  eventId, runId, ts
  requestId: string
  actualTokens: number
  usageComplete: boolean
  outcome: "success" | "protocol" | "failed" | "cancelled"

Released:
  eventId, runId, ts
  requestId: string
  reason: "not_launched" | "superseded" | "run_cancelled"
```

### 5.3 去重与序列不变量

1. 同一 `taskId` 对 baseline：每个逻辑任务至多纳入一次；retry 不扩大 baseline。
2. 同一 `requestId`：`Reserved` 至多一次；终结为恰好一次 `Settled` 或 `Released`。
3. 未 reserve 就 settle、双重 settle、对已终结 request 再 reserve，均属完整性事故，必须确定性失败，不得静默忽略。

### 5.4 折叠状态

```text
LedgerState {
  baselineTokens: number
  allowedTokens: number
  spentTokens: number
  reservedTokens: number
  tokenUsageComplete: boolean
  openReservations: Map<requestId, Reserved>
  baselinedTaskIds: Set<string>
  decisions: number
  fallbacks: number
  recoveries: number
  plannerDeadlines: number
  throttles: number
  planningStatus: "optimal" | "bounded" | "fallback"
  // 以及与 v5-book-scheduler-metrics-1 互转所需的其余计数与预测字段
}
```

`allowedTokens = floor(baselineTokens * (1 + tokenIncreaseCap) + eps)`  
其中 economy/balanced/speed 的 cap 分别为 5% / 10% / 20%，与既有优化策略一致。

### 5.5 硬门

发车前必须满足：

```text
spentTokens + reservedTokens + newReserveTokens + conservativeHorizonFloor
  ≤ allowedTokens
```

- `conservativeHorizonFloor`：对已承诺但尚未完成的强制剩余工作的保守下界。P0 使用“已认领且未完成窗口的 lean/静态预测 token 之和”，**禁止恒为 0**。
- `tokenUsageComplete=false` 时：只允许不增加超限风险的更保守动作或拒发，不得用乐观预测填补包络。
- 硬拒发仅在 `schedulerMode=active` 生效。
- **记账在 off / shadow / active 全部启用。**

### 5.6 计费规则

| 情况 | baseline | spent |
|------|----------|-------|
| 任务首次纳入 horizon | +静态预测 | — |
| retry / repair / 协议切换 / 拆分 | 不增加 | reserve 后按 settle |
| 成功且 usage 完整 | — | +actual |
| 协议失败 / 供应商失败且 usage 完整 | — | +actual |
| 结束但 usage 缺失 | — | +该 request 的 reserved 全额，并标 `usageComplete=false` |
| 取消且从未发车 | — | `Released`，不进 spent |

凡 provider 返回的真实 usage，不论成败，一律进入 spent。不得以“失败了所以不算”或“质量已通过”豁免硬门。

### 5.7 Resume 对账

`runBook` 启动时：

1. 从 store 加载并重放 ledger（或读投影后再校验）；
2. 用折叠态初始化进程内 baseline / spent / reserved / 计数；
3. 对崩溃遗留的 open reservation 做 reconcile：
   - 若 runtime 观察能证明已产生 usage → 补 `Settled`；
   - 否则 `Released(reason=superseded)` 不可用于“可能已计费”的模糊情况；
   - 无法证明未计费时：按 reserved 全额 `Settled` 并 `usageComplete=false`（保守）。

### 5.8 投影与导出

- 每次 baseline / reserve / settle / release 后更新内存状态；
- 每波次至少写一次 `scheduler_run_projection`，run 正常或异常结束时必须再写一次；
- `store.loadSchedulerMetrics(runId)`：优先最新投影，否则重放 ledger；
- `writeLosslessBookArtifacts`：使用 `options.scheduler ?? store.loadSchedulerMetrics(runId)`；
- 若该 run 曾产生 ledger 事件而仍无法得到 metrics：审计标记 `schedulerMetricsMissing`，不得伪装成“无调度信息的成功默契”。

## 6. 执行接入

### 6.1 统一发车 API

所有模型调用必须：

```text
admission.tryAdmit(requestSpec) -> AdmitOk | AdmitReject
execution.execute(admitted) -> outcome + usage
ledger.settle(...) 或 ledger.release(...)
```

### 6.2 P0 必须接入的路径

1. 主翻译 physical request  
2. 批内 repair  
3. 协议降级的后续请求  
4. 上下文拆分后的每个 fragment  
5. lexical anchor 的模型调用  
6. revalidation 中除纯 noop 外的全部模型调用  

### 6.3 模式语义

| 模式 | 记账 | 硬拒发 | 派发来源 |
|------|------|--------|----------|
| off | 是 | 否 | 既有路径；P2 前可保留 AIMD permit |
| shadow | 是 | 否 | 执行 legacy；规划仅对比 |
| active | 是 | 是 | Planner + Admission；禁止无包络 legacy 放行 |

active 在 `NO_LEGAL_PLAN` 或包络耗尽时：停止新派发，等待在途 settle，写投影，返回稳定错误（如 `BookTokenEnvelopeExceededError`）。已提交窗口不回滚。

### 6.4 与提交的正交性

- Worker 不直接 promote；仍由 `CommitCoordinator` 顺序提交；
- 译文提交成功不豁免 token 超限；
- token 拒发不修改已提交知识或译文。

## 7. P1 模块边界

| 模块 | 建议位置 | 职责 |
|------|----------|------|
| `token-ledger.ts` | `folioloom/src/fullbook/` | 纯折叠与硬门判断 |
| ledger store 适配 | `storage` 或 `fullbook` | 事件读写、重放、投影 |
| `admission-controller.ts` | `fullbook/` | reserve / 拒发 / 并发上限 |
| `execution-worker.ts` | `fullbook/` | 单请求执行与内部 recovery 边 |
| `telemetry-sink.ts` | `fullbook/` | 成本模型观察与决策日志 |
| `book-runner.ts` | `fullbook/` | 波次编排与 commit 粘合 |

### 7.1 统一 token 货币

```text
estimate → reserve(ceil(estimate)) → settle(actual)
```

- P0：预测值直接作为 reserve；usage 缺失时按 reserve 全额 settle。  
- P1：CostModel 提供唯一 `predictedTokens`（建议 P90）；Admission 与 AIMD in-flight 都只读 ledger 的 open reserved 合计，删除第二套 reserved 累加器。

## 8. P2 双调度器收敛

```text
active:
  Planner 产出 DispatchSet
  Admission 检查 envelope + 资源互斥 + 并发上限
  并发上限 = min(userMaxConcurrency, sensor.recommendedConcurrency)
  CongestionSensor（原 AIMD）只更新拥塞档位，不再 tryAcquire 跳过任务

shadow:
  规划对比 + legacy 执行 + 全量记账；默认不硬拒发

off:
  无 DP 派发；可保留旧 permit 行为；全量记账
```

拥塞传感接口：

```text
CongestionSensor.snapshot(): {
  tier: string,
  recommendedConcurrency: number,
  inFlightTokenHint?: number
}
```

## 9. P3 双栈边界

- 生产内核唯一权威：`folioloom/` TypeScript；
- 仓库根目录 Python：输入适配与 V1–V4 研究历史；
- 禁止再向 Python 增加新的调度/包络/提交逻辑；
- import 迁 TS 另立项目，不阻塞 P0–P2。

## 10. 功能开关

| 开关 | 默认 | 说明 |
|------|------|------|
| 记账（token ledger） | 开 | 不可对用户关闭；关闭将失去审计 |
| 硬拒发 | 仅 active | 内部可临时关闭以便紧急回滚执行，但记账仍开 |
| `schedulerMode` | 既有 | off / shadow / active |
| `optimizationProfile` | 既有 | economy / balanced / speed |

不新增普通用户 GUI 旋钮。CLI 调试输出（如打印 ledger）可在 P1 追加，非 P0 必做。

## 11. 测试

### 11.1 单元

- 非法事件序列失败；
- baseline 去重与 retry 不扩 baseline；
- success / protocol / failed / usage 缺失计费；
- 硬门边界：恰等于 allowed 可通过，差 1 拒绝；
- 重放结果与投影一致。

### 11.2 集成

- 两段 `runBook` resume 后 spent/baseline 一致；
- repair / protocol_switch / context_split 产生独立 requestId 且计入 spent；
- active 余量不足拒发且无 legacy 绕过；
- 不传 `options.scheduler` 的 export 仍得到非 null metrics（在有 ledger 时）；
- revalidate 模型调用并入同一 run ledger。

### 11.3 回归

- 现有 core / desktop / typecheck / build 全绿；
- off 不启用硬拒发，但可导出记账后的 metrics；
- shadow 规划对比不被 ledger 破坏。

### 11.4 真实样本（P4）

- 全新隔离数据库；
- 德语《变形记》前约 100k 字符，`active/balanced`；
- 多语言短样不回归；
- 不复用已超限 run。

## 12. 验收标准

| ID | 标准 |
|----|------|
| A1 | 任意 resume 后 baseline/spent/reserved 与事件重放一致 |
| A2 | 独立 export 在存在 ledger 时 `scheduler ≠ null` |
| A3 | active 下 translate/repair/split/protocol/anchor/revalidate 均先 reserve 再调用 |
| A4 | active 包络耗尽：零新派发，稳定错误码，已提交窗口不回滚 |
| A5 | balanced 真跑：`actual ≤ floor(baseline * 1.10)` |
| A6 | 无损覆盖、知识收敛、strictExportable 零回归 |
| A7 | P2 后 active 中 AIMD 不单独 skip 任务 |
| A8 | Planner 除经 ledger/store API 外无 DB 写 |

## 13. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 成本模型系统性低估导致频繁拒发 | 硬门保留；校准 CostModel；usage 缺失走保守 settle |
| 事件量增大 | payload 仅数值；投影缓存；按 run 查询 |
| runner 接入遗漏旁路 | P0 清单 + 测试强制覆盖六类路径 |
| 与“不改 schema”旧约束冲突 | 明确改为事件 kind 扩展，不加表 |
| 真跑费用 | P0 以自动化测试合并；P4 再付费验收 |

## 14. 上线顺序

1. 实现纯 `TokenLedger` 折叠与硬门 + 单测；  
2. store 事件读写、重放、投影、loadSchedulerMetrics；  
3. runner/revalidation/anchor/repair/split 接入 reserve/settle；  
4. export/desktop 读投影；  
5. resume 对账；  
6. P1 拆模块与统一货币；  
7. P2 传感化 AIMD；  
8. P4 全新库真跑与报告；  
9. 更新 `STATE.md` 与用户可见文档中关于调度验收状态的表述。

## 15. 文档产出

- 本规格：`docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`
- 实现计划：`docs/superpowers/plans/2026-07-28-token-ledger-and-scheduler-control-plane.md`
- 真实验收报告：P4 后写入 `docs/superpowers/reports/`
- 滚动更新 `STATE.md` 未完成项与阶段状态
