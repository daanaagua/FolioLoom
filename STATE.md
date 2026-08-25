# FolioLoom 调度控制面当前状态

- 日期：2026-07-29
- 承接分支：`fix/execution-worker-local-20260729`
- 回并目标：`fix/german-100k-gate`
- 规格：`docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`
- 计划：`docs/superpowers/plans/2026-07-28-token-ledger-and-scheduler-control-plane.md`
- 真实验收报告：`docs/superpowers/reports/2026-07-28-kafka-german-100k-token-ledger-live-validation.md`
- 状态：**ExecutionWorker 抽取完成；2026-07-29 新一轮双语 100k release gate
  未通过，release 冻结。**

## 已完成

### P0 Token 账本

1. 纯函数 `TokenLedger`：baseline/reserve/settle/release、硬门、重放；
2. `book.db` 事件持久化与 `scheduler_run_projection`；
3. 独立 export 从 store 读取 scheduler metrics；
4. `book-runner` 续跑恢复包络；主译 admit→settle；
5. revalidation drain 并入同一 run ledger；
6. protocol/context 二次调用发车前包络预检（临时 reserve，usage 归 parent settle）；
7. lexical anchor 独立 baseline/reserve/settle。

### P4 真实验收（2026-07-28）

- 项目：`projects/kafka_verwandlung_100k_gate2/`（全新库）
- run：`836e57f2-db0b-487c-ab09-b6b443e0bfb3`
- 模型：`deepseek-v4-flash`，`active/balanced`
- 19/19 窗口完成；严格导出通过；`scheduler ≠ null`
- token：baseline 575,480 / allowed 633,028 / actual **422,510**（未超限）

## P1/P2/P3 完成

- `admission-controller.ts`：唯一发车/结算入口
- `congestion-sensor.ts`：AIMD 拥塞传感
- `telemetry-sink.ts`：成本模型与 profile 观察
- `execution-worker.ts`：请求预算、fragment admission、模型调用、protocol/context recovery 与 usage 归集
- active 模式 `tokenGate: "external"`：并发仍由 AIMD，token 硬门只信 ledger
- `docs/ARCHITECTURE.md`：冻结 TypeScript 生产内核与 Python 导入/历史边界
- lexical anchor：成功调用使用供应商真实 usage 结算；缺失 usage 时继续保守标记不完整，不伪造 usage

## 不变量

- 逻辑窗口不可变；`CommitCoordinator` 顺序不变；不加 book.db 关系表；质量门未降。

## 2026-07-29 ExecutionWorker 验证

- `npm test`：855 tests，854 pass，0 fail，1 skip；
- `npm run typecheck`：0 error；
- `npm run desktop:test`：Node 108 pass / 1 skip；Renderer 66 pass；
- `npm run desktop:typecheck`：0 error；
- `npm run desktop:build`：production build 与 preload 验证通过；
- `git diff --check`：通过；
- 德语 100k 沿用已隔离且通过的 P4 真跑结果，未覆盖唯一真跑数据库。

## 2026-07-29 双语 100k Release Gate

报告：
`docs/superpowers/reports/2026-07-29-german-and-children-of-time-100k-release-gate.md`

- 德语全新 run：8 completed、1 warning、10 pending；actual 243,029 >
  allowed 230,184；strict exportable=false；
- 《时间之子》全新 run：单窗口 probe 后 actual 已超 allowed，停止剩余 18
  个窗口以避免继续产生无效费用；
- release、tag、push、版本号更新均未执行。

### 本轮代码修复

1. `NO_LEGAL_PLAN` 返回稳定调度错误；仅在数值确实超限时返回 token envelope
   错误，不再误报并发容量；
2. resume baseline 按 stable logical window ID 去重，physical request 重组不再
   扩大 allowed；
3. quality retry 不重复失败的 framed 协议；
4. active settle 后真实 usage 超包络时不再返回表面成功；
5. 桌面 active pause 改为等待当前 provider wave 到达 durable boundary 后协作
   暂停，避免中断调用产生未知 usage 并令同一 run 无法 resume；
6. 应用退出使用有界 grace；超时 abort，再经有界等待继续退出，provider 卡住
   不会无限阻塞 Electron shutdown。

最终代码门禁：

- `npm test`：861 tests，860 pass，0 fail，1 skip；
- `npm run typecheck`：通过；
- `npm run desktop:test`：Node 109 pass / 1 skip；Renderer 66 pass；
- `npm run desktop:typecheck`：通过；
- `npm run desktop:build`：通过；
- `git diff --check`：通过；
- 独立审查无新增 Critical / Important。

### 剩余阻断项

- high/max effort reasoning reserve 低估；
- lexical anchor 静态预算低估；
- CLI projection 与 durable ledger 最终 spent 存在差异；
- `conservativeHorizonFloor` 仍需按冻结规格接入非零静态下界；
- 修复后必须以全新数据库重新跑通德语和英文两个 100k，再执行全量门禁，才可
  更新 release。

## 2026-07-29 预算事务系统实施进度

新规格：
`docs/superpowers/specs/2026-07-29-budget-transaction-system.md`

已完成：

1. provider/protocol error 携带已完成 `PiRunResult`，usage 在 fallback 前捕获；
2. ledger 增加 `dispatched`、terminal attempt ID、防重复终结和重放兼容；
3. 未知 usage 按 `max(observed, reserved)` 保守扣账；
4. resume/异常退出区分未发车 release 与已发车 conservative settle；
5. Admission reserve 原子接收 mandatory horizon floor；
6. 主译 recovery、lexical anchor、revalidation 均改为 reserve→dispatch→settle；
7. `BudgetOracle` 统一测量实际 prompt、JSON payload、tool schema、可见输出、
   reasoning 和安全余量；
8. high effort 冷启动 reasoning 上界覆盖已观测 18,958 token；
9. lexical anchor 删除 `candidateCount × 120`，改用完整序列化 payload；
10. scheduler/CLI/export 从 durable ledger 重建 actual；stale projection 可纠正；
11. 正常结束强制 ledger reconciliation；strict export 在 usage 不完整、open
    attempt 或 projection mismatch 时 fail closed；
12. fallback 的初始 mandatory baseline 包含合法 escalation 上界，但 retry 不得
    扩大累计包络。

本轮代码门禁：

- `npm test`：875 tests，874 pass，0 fail，1 skip；
- `npm run typecheck`：通过；
- `npm run desktop:test`：Node 109 pass / 1 skip；Renderer 66 pass；
- `npm run desktop:typecheck`：通过；
- `npm run desktop:build`：通过；
- `git diff --check`：通过；
- 用户未跟踪的根目录 `package-lock.json` 保持原 SHA-256：
  `08DD6162809680B6A40916C22DC5DB4208F97772B7C6F25CEC242C0BB0140547`。

当前 release 状态：

- 代码门禁已通过；
- 尚未执行修复后的两个全新 100k 真实门禁；
- release、tag、push、版本号更新继续冻结；
- 只有德语与《时间之子》均达到 19/19、usage complete、actual ≤ allowed、
  strict exportable，才允许上传和更新 release。

云端清理：

- `codex-sg` 上 `folioloom-dp` tmux 槽位已关闭；
- `/home/ubuntu/projects/folioloom-dp-20260727` 已永久删除；
- 其他 tmux 槽位未改动。

## 2026-07-29 预算事务系统真实门禁复验

报告：
`docs/superpowers/reports/2026-07-29-budget-transaction-real-gate-followup.md`

新增完成项：

1. planner 在 context profile 不可行时使用合法的风险门控基线，不再误报
   `NO_LEGAL_PLAN`；
2. 概念语义归一化与源文逐字 occurrence 匹配分离；resume 会从不可变源文重建
   occurrence，并淘汰已经失效的旧 revalidation task；
3. 源文原样存在的拉丁双名法不再被误判为未翻译 prose；
4. 每个逻辑源块最多 32 个语义段落，只沿不可变段落边界拆分，保持 1:1 段落
   完整性和 source/window 顺序。

德语全新门禁通过：

- 项目：`projects/kafka_verwandlung_100k_budget_tx_20260729`
- run：`4b12f9cc-3ef0-4570-a32f-ea35f00f11c1`
- 19 / 19；7 warning；0 pending / failed / human-required；
- baseline 1,390,468 / allowed 1,529,514 / actual 609,374；
- usage complete；strict exportable；strict export 成功且 incident 为空。

《时间之子》最新全新运行：

- 项目：`projects/children_of_time_book1_100k_budget_tx5_20260729`
- run：`6b346935-6a3c-46c5-a2bb-bfe65808324a`
- 32 段硬边界后的复杂窗口已通过；当前 6 / 19（4 completed、2 warning）；
- 后续 DeepSeek 长连接连续返回 `Connection error`；
- ledger 出现 5 条 `usageComplete=false`，该运行不能作为 release 证据；
- 为避免继续产生不可验证费用，供应商恢复前不再新建英文真跑数据库。

最终代码门禁：

- `npm test`：881 tests，880 pass，0 fail，1 skip；
- `npm run typecheck`：通过；
- `npm run desktop:test`：Node 110 tests（109 pass / 1 skip）；Renderer 66 pass；
- `npm run desktop:typecheck`：通过；
- `npm run desktop:build`：通过；
- 用户未跟踪的根目录 `package-lock.json` SHA-256 保持
  `08DD6162809680B6A40916C22DC5DB4208F97772B7C6F25CEC242C0BB0140547`。

当前 release 状态：

- 德语门禁通过，英文门禁因外部 provider usage incomplete 未通过；
- release、tag、push、版本号更新和上传继续冻结；
- 待 provider 恢复后以全新数据库从 0 重跑英文 100k，达到 19 / 19、
  usage complete、actual ≤ allowed、strict exportable，再复跑全部代码门禁。

## 2026-07-29 英文 Connection error 根因复核与检修

根因判断：

- 三个英文数据库均表现为同一进程先连续成功，随后不同任务类型的新请求同步在
  约 5 秒内以零 usage 的 `Connection error` 失败；
- 当前同机 `/models` 8 / 8 成功；同 SDK 流式探针累计 31 / 31 成功，其中
  24 次复核按 4 并发执行；
- DeepSeek 官方并发上限远高于本次 4 并发，超限应为 HTTP 429；
- 直接触发点最可能是 DeepSeek 边缘服务或到其边缘节点的短时传输路径，不是英文
  block、固定请求格式或本地 socket pool 的确定性故障；无法仅凭现有证据断言为
  DeepSeek 全局事故。

架构放大器已修复：

1. provider failure 立即形成 run boundary；主译不再同轮自动重发；
2. revalidation provider failure 原子恢复 pending，且不消耗质量 attempt；
3. provider failure 不再转写成翻译 warning，也不会继续发 lexical anchor；
4. CLI provider error 使用 `PROVIDER_BUSY` 等稳定分类。

故障注入与最终门禁：

- provider failure 只发车一次，未发车 sibling 保持 pending；
- revalidation 保持 pending / attempts 回退 / 0 warning；
- 相关回归：150 / 150；
- `npm test`：884 tests，883 pass，0 fail，1 skip；
- `npm run typecheck`、`npm run desktop:typecheck`、`npm run desktop:test`、
  `npm run desktop:build`：全部通过。

release 状态不变：旧英文数据库已有 incomplete usage，不能补救为发布证据；必须用
全新数据库重新跑通英文 100k 后才能上传。

## 2026-07-29 英文 100k tx7 / tx8 复验

- tx7：`projects/children_of_time_book1_100k_budget_tx7_20260729`，
  run `860eef4f-fb95-4697-a432-8257ca3c6412`；19 / 19、usage complete、
  actual 1,083,059 ≤ allowed 1,703,513，但一项 revalidation 留下
  `warning_stale`，strict exportable=false。
- 已把 committed-boundary 质量失败纳入 revalidation 的定向 repair loop，并在
  repair 后复检；相关回归 168 / 168、TypeScript、diff check 通过。
- tx8：`projects/children_of_time_book1_100k_budget_tx8_20260729`，
  run `471ad015-130b-4b69-8fa1-2fdff50c69a8`；约 30 分 37 秒后
  `human_required`。
- tx8 最终为 10 completed（6 warning）、1 human-required、1 staged、
  7 pending；audit 12 / 22 blocks、strict exportable=false。
- tx8 durable baseline 1,040,879 / allowed 1,144,966 / actual 725,915；
  所有 settled attempt usage complete，0 provider / connection error。
- tx8 的 8 项 revalidation 全部 retranslate 收敛、另 1 项 noop，
  0 stale / warning-stale，真实验证了 committed-boundary 修复。
- 阻断窗口 ordinal 10：首次输出将 23 段压成 1 段；定向修复失败后，
  isolated typed retry 缺少 submission，framed fallback 又返回错误 marker。
  这是模型退化输出与一次性 framed fallback 恢复缺口，不是 DeepSeek 服务波动。
- release、tag、push、版本号更新和上传继续冻结。

## 2026-07-30 paragraph fragment exact-wire 复验

- `tx22` 在 10 / 19 后于 ordinal 10 进入 `human_required`；provider 原始 evidence
  显示模型 reasoning 已完成六段译文，但宽松 union schema 把 tool arguments 压成
  多 window / 多 translation / 空 paragraph 的错误嵌套，不是服务波动。
- fragment typed schema 已改为 admission-derived exact wire contract：唯一 literal
  window、唯一 literal block、唯一 translation、固定 paragraph cardinality；不再暴露
  sibling `{text}` union。相关 malformed-call 回归先失败、修复后通过。
- `tx23` 从全新数据库运行；此前阻断的 ordinal 10 已一次通过，但 ordinal 11 的六段
  unit 两次触发确定性的 nested-array collapse，随后单段 refinement 首次返回正确数组
  却把四个已知 metadata 提升到唯一 window 的 envelope。过严的 fragment schema
  拒绝了这一本可无损归一化的形状，第二次随机生成失败后形成
  `missing window submission`。
- exact arrays 与 sole-window metadata normalization 现已正交：数组与 ID 继续固定；
  仅允许 `termUsages`、`notes`、`memoryCandidates`、`styleObservation` 四个已知字段
  从 envelope 确定性下移。新增回归验证该形状单次接受。
- 全新英文 `tx24`：
  `projects/children_of_time_book1_100k_fragment_metadata_tx24_20260730`，
  run `4aec5d16-1e10-4d68-974b-acbffb14c6cc`；19 / 19，ordinal 10 与 11
  均通过，durable scheduler usage complete，actual 3,055,644 ≤
  allowed 8,943,499。
- tx24 strict audit 仍因一个 `coverageMissing` 失败。根因为 revalidation
  replacement 允许 contextual receipt 省略后，只按实际 receipts 重写 binding，
  让新 active translation 丢失对应 concept coverage；这不是 provider 故障。
- 已增加持久化回归：只为 exact source occurrence 写当前 revision 的空 receipt
  `clean` binding；locked omission 仍由 submission gate 拒绝。回归在修复前失败，
  修复后通过。
- 全新英文 `tx25`：
  `projects/children_of_time_book1_100k_binding_tx25_20260730`，
  run `bfe025a5-3c19-4967-b552-27577344eb4c`；运行至 ordinal 7 后
  `human_required`，durable usage complete，0 provider/connection error。
- tx25 raw evidence 显示一个单段 refinement 返回 exact window/block/cardinality，
  但唯一 `paragraphs[].text` 为空字符串。旧 provider-visible schema 未声明
  `minLength`，因此没有触发同会话 corrective turn，而是在叶子 handler 中失败。
- fragment exact schema 已增加 `paragraphs[].text minLength=1`；新增行为回归在修复前
  只调用一次并失败，修复后第二次 corrective call 成功。
- 全新英文 `tx26`：
  `projects/children_of_time_book1_100k_nonempty_tx26_20260730`；ordinal 0
  第二次执行中，一个早期 unit 已消耗全 request 唯一 targeted repair，后续独立
  unit 在 `Doctor Avrana Kern` 处截断并提交 target 不存在的 receipts，最终
  `human_required`；durable usage complete，0 provider/connection error。
- targeted repair credit 已从全 request 单布尔值改为每 execution scope 最多一次、
  每 request 最多三次；预算上限和 legal baseline 同步包含最大的三个 repair
  scopes。双独立 unit 回归在修复前第二项无 repair 并失败，修复后两项各修一次且
  完整提交。
- 全新英文 `tx27`：
  `projects/children_of_time_book1_100k_scoped_repair_tx27_20260730`；
  ordinal 0–14 均完成、critical ordinal 10/11 均通过，但发车 ordinal 15–17
  时 planner 报 `NO_LEGAL_PLAN`。当时 actual 2,091,437、allowed 10,461,856，
  并非 run-level token 不足。
- 根因为 scoped repair 的累计 policy reserve 被错误加入 scheduler
  `inFlightTokens`；三个顺序 repair scopes 被当成并发占用，使所有 variant 超过
  瞬时上限。repair 图现只进入 run-level legal baseline，执行 variant 仍按 direct
  graph 做瞬时 admission；active scheduler 双 repair 集成回归通过。
- release 继续冻结；以全新数据库重跑英文与德语，两者都达到 usage complete、
  actual ≤ allowed、knowledge converged、`coverageMissing=0`、strict exportable，
  且最终全量代码门禁通过后才上传。

## 2026-07-30 paragraph fragment in-flight 修复复验

- scoped repair reserve 仅属于 run-level legal baseline，不再累计进入 scheduler
  `inFlightTokens`；direct execution variant 只描述本次真实发车图，避免把顺序 repair
  scope 错当成并发占用并产生伪 `NO_LEGAL_PLAN`。
- retry 回归已改为验证固定 `maxAttempts`：一次 primary 加七次 escalation 后进入
  `human_required`，translate horizon baseline 只登记一次，retry 不扩张累计 envelope。
- 定向回归与 TypeScript typecheck 已通过。
- 英文全新复验已从零启动：
  `projects/children_of_time_book1_100k_inflight_tx28_20260730`。通过后再串行启动德语
  全新 100K；两者和全量代码门禁均通过前，release 仍冻结。

## 2026-07-30 英文 100k tx28 与长度 contract 修复

- tx28 run `c2ca7a19-de7c-4766-b9d3-ea482dc61c20` 在 ordinal 3 第二次 attempt 后
  `human_required`；durable usage complete，actual 842,012 ≤ allowed 3,550,098，
  同一波另两窗已 staged，没有 provider/connection error。
- 原始 evidence 显示长对话单段在两次独立 outer attempt 中都被压成一句
  “塞林继续轻快地说下去：”，targeted repair 仍原样提交；最终长度比例 0.020，
  确认为 typed wire contract 只要求 `minLength=1` 所放大的确定性内容截断。
- fragment schema 现在按 source-language profile 的长度比例 band 和真实 source
  paragraph 推导保守 `minLength`；多段 unit 取最短下界，失败后单段 refinement 使用
  精确段落下界。明显不可能通过 validator 的截断会先获得同会话 typed corrective
  turn，完整语义与脚本质量仍由最终 validator 把关。
- 新回归在修复前只调用一次并失败，修复后两次调用完成；empty、sibling spill 回归与
  TypeScript typecheck 同时通过。需再次使用全新数据库重跑英文，release 仍冻结。

## 2026-07-30 英文 100k tx29 与平坦 leaf protocol

- tx29 run `973e2af6-83f0-4c97-ab5a-9c37660b4fa3` 验证长度 contract 有效：
  tx28 的 ordinal 3 首次通过，critical ordinal 10/11 通过，ordinal 15–17 也成功发车，
  不再出现 tx27 的伪 `NO_LEGAL_PLAN`。
- run 在 ordinal 16 第二次 attempt 后以 `missing window submission` 进入
  `human_required`；16 completed、1 staged，durable usage complete，actual
  2,860,969 ≤ allowed 10,563,666，无 provider/connection error。
- raw evidence 显示 multi-paragraph unit 仍可能连续两轮发生 nested-array collapse；
  单段 refinement 随后能纠正容器，却会原样重交过短文本并在第二个 schema error 后
  stop。说明叶子仍复用三层 batch array 是不必要的失败放大器。
- 单段 refinement 现改用独立平坦 `finalize_paragraph_fragment`：
  literal `windowId` / `blockId` / `paragraphId`、该段动态 `text.minLength`，metadata
  同层；没有 nested window/translation/paragraph array。handler 再确定性降低为统一
  batch candidate，完整 validator 与 commit gate 不变。
- 新 leaf 回归在实现前因 unknown tool 失败，实现后单次完成；paragraph protocol、
  refinement、scoped repair 和 no-framed 相关回归均通过。需再建全新英文数据库复验。

## 2026-07-30 英文 100k tx30、Pro 复核与 coverage contract

- tx30 run `5d2e4c6f-cf50-402f-864f-f129870ba845` 从全新数据库完成 19/19；
  ordinal 16 的首轮结构失败在第二次 outer attempt 中由单段 leaf 成功恢复，最终
  0 `human_required`、0 failed、usage complete，actual 2,539,835 ≤ allowed
  11,297,293。
- 首次结束时结构已完整，但 strict audit 报告唯一
  `coverageMissing=1`：`EARTH’S` 是 contextual concept，译文自然写成“地球昔日
  主人们”，因此合法省略 receipt；持久化层只给有 receipt 的 concept 建 binding，
  审计层却要求 exact occurrence 都有 binding，两个契约不一致。
- 新失败回归稳定复现后，staging commit gate 现在对 exact occurrences 统一建覆盖
  binding：合法软策略省略 receipt 时写 clean empty-receipt binding，locked receipt
  缺失仍 fail closed。定向 store 回归 44/44、typecheck 通过。
- 用同一 run 的启动 coverage scan 生成并完成 1 个 revalidation task 后，strict
  artifacts 已生成：structurally complete、knowledge converged、strict exportable，
  missing/pending/validating/stale/warningStale/coverageMissing 全为 0。
- 网页端 Pro 的独立复核赞同单调下降的恢复拓扑，建议最终 scalar leaf 只暴露
  `{text}`，身份全部由调用域持有，metadata 不进入终端协议；该建议已实现并通过
  paragraph protocol 10/10、translation request/batch 43/43 与 typecheck。
- 因 tx30 启动时 leaf 仍含 literal IDs 与可选 metadata，下一步必须用最终代码再次
  从全新数据库跑英文 100K，然后才跑全新德语 100K；release 继续冻结。

## 2026-07-30 tx31 网络中断与 secondary ledger 恢复修复

- 最终 text-only leaf 的英文全新 tx31：
  `projects/children_of_time_book1_100k_text_leaf_tx31_20260730`，
  run `8a3ba2a1-4d0b-4c65-a953-dae67f42c7d2`。
- 网络中断终止 provider 后，durable DB 保留 2 staged / 17 pending；使用同一 run
  恢复时，外层 translate attempt 正确获得新 ID，但 paragraph-fragment 子尝试复用
  `request-...:paragraph_fragment:retry-0:0`，被 token ledger 拒绝并使 ordinal 0
  在第二次窗口 attempt 错误进入 `human_required`。
- 根因是 secondary provider identity 由进程内 `retryRound + ordinal` 生成；两者在
  重启后归零，而外层 translate、anchor、revalidation 已使用 run-owned durable
  allocator。
- 新回归先稳定复现相同窗口 replay 的 terminal-ID 碰撞；修复后 execution worker
  的 repair / protocol-switch / context-split / paragraph-fragment 全部通过同一
  durable allocator 分配 attempt ID，重复 stem 自动追加 `recovery-N`。
- 回归从红转绿；book-runner、token-ledger、admission、paragraph fragment 相关
  126 / 126 通过，TypeScript typecheck 通过。tx31 仅保留为故障证据，不作为
  release gate；下一步从全新 DB 启动英文 tx32。

## 2026-07-30 英文 100K 最终门禁 tx32

- 全新项目：
  `projects/children_of_time_book1_100k_resume_safe_tx32_20260730`，
  run `247bef9c-afb7-48e0-8c43-e4dbe5859a49`。
- 最终代码从零完成 19 / 19 windows、22 / 22 blocks；0 pending / running /
  staged / human-required / failed。ordinal 3 的有界第二次 attempt 成功，
  critical ordinal 10/11 通过，ordinal 15–17 成功发车且 ordinal 16 首次通过。
- strict audit：complete、structurally complete、knowledge converged、
  strict exportable 全为 true；pending / validating / stale / warning-stale /
  coverageMissing 全为 0。
- scheduler ledger：usage complete，actual 2,761,484 ≤ allowed 11,086,044，
  planner optimal，0 fallback / deadline，8 次受预算约束的 recovery。
- 根目录用户 `package-lock.json` SHA256 仍为
  `08DD6162809680B6A40916C22DC5DB4208F97772B7C6F25CEC242C0BB0140547`。
- 英文最终门禁通过；下一步使用最终代码和全新 DB 运行德语 100K tx33。

## 2026-07-30 德语 tx33 与 revalidation 共享恢复链路

- 全新德语项目
  `projects/kafka_verwandlung_100k_resume_safe_tx33_20260730`，run
  `983934a9-3d1b-4f33-b00a-1a3495029899`，结构上完成 19/19 windows、
  20/20 blocks，0 human-required/failed；durable usage complete，actual
  539,457 <= allowed 2,357,544，planner optimal。
- strict gate 未通过：`knowledgeConverged=false`、
  `strictExportable=false`，唯一 revalidation task 在两次 attempt 后成为
  `completed_with_warning / REVALIDATION_OUTPUT_INVALID`。release 继续冻结。
- raw evidence 证明 provider 和 reasoning 正常，但五段 Kafka block 的两个
  revalidation tool submission 分别只提交约一段和约 1.5 段，并把
  `termUsages`、`styleObservation`、`modeWeights` 提升到 tool root。
- 根因是普通 window 已经通过 `ExecutionWorker` 获得 whole -> paragraph
  vector -> scalar leaf 的单调恢复，而 `translateRevalidation` 仍直接调用
  `runTranslationBatch`，完全绕过共享恢复链路。
- 新回归先稳定复现两次 outer attempt 后告警；实现后 revalidation 通过
  `admitTranslationRequests` 和 `executePlannedTranslationRequest`，保留
  stale/snapshot、committed-boundary 与 atomic replacement 的独立语义。
  fragment child 不执行 whole-block boundary callback，最终组装候选仍执行。
- parent `revalidate` 只结算 worker 的 `accountingUsage`；paragraph、
  repair、protocol/context secondary transaction 独立结算，避免双重扣账。
- admission 新增 `paragraphRecoveryReserveTokens`，完整覆盖 whole 请求退化到
  paragraph vector、一次 scalar refinement 与最多三个 scoped repairs 的
  合法图；primary/escalation 取保守上界，但 sequential reserve 不进入瞬时
  scheduler in-flight。
- 定向回归已由红转绿；book-runner、revalidation、admission、ledger、
  paragraph protocol、translation request/batch 相关测试 176/176 通过，
  TypeScript typecheck 通过，`git diff --check` 无 whitespace error。
- Pro 复核同意“共享 execution reliability、保留 revalidation commit
  semantics、最终完整组装后再原子替换”的边界；临时咨询标签已关闭并释放 lease。
- 下一步必须用本次最终代码从全新 DB 重跑德语 100K（tx34）。tx34 strict
  exportable、usage complete、actual <= allowed 全部通过且全量桌面/代码门禁
  通过后，才允许更新版本、tag、push、release 和上传。

## 2026-07-30 德语 100K 最终门禁 tx34 与 v1.5.0 候选

- 全新项目 `projects/kafka_verwandlung_100k_shared_worker_tx34_20260730`，
  run `715398db-5cb4-4cab-a576-3fcf91cafaf6`，完成 19/19 windows、
  20/20 blocks；最终 17 completed、2 completed-with-warning，均为普通可接受告警，
  0 pending / running / staged / human-required / failed。
- 5 项 revalidation 全部在首次 attempt 收敛为 `resolved_retranslate`。其中一项真实触发
  whole -> paragraph recovery（parent reserve 38,143、paragraph reserve 124,236、
  legal baseline 322,185）并成功；另一项触发 typed -> framed protocol switch 并成功。
- revalidation drain：claimed 5、retranslated 5、warning 0、model calls 10、
  total tokens 141,879，usage complete。
- strict audit：complete、structurally complete、knowledge converged、
  strict exportable 全为 true；pending / validating / stale / warning-stale /
  coverageMissing 全为 0，incident codes 为空。
- scheduler ledger：active/balanced、planner optimal、usage complete，
  actual 510,147 <= allowed 8,298,912；0 fallback、0 planner deadline、0 throttle。
  strict artifacts 已生成，`book verify-export` 返回 `ok=true`、incident codes 为空。
- 完整代码门禁通过：`npm test` 930 pass / 1 skip / 0 fail；
  TypeScript 与 desktop TypeScript 通过；desktop Node 109 pass / 1 skip，
  renderer 66 pass；desktop build 通过；`git diff --check` 无 whitespace error。
- 版本元数据已统一更新至 v1.5.0，release note 已生成。候选产物：
  `FolioLoom-portable-win-x64.exe`（96,636,652 bytes，
  SHA256 `0608973F6A6AD3687694B03BAF5F7EC72873497525347A16C1BD479B9C4F55AA`）；
  `FolioLoom-portable-win-x64.zip`（166,347,291 bytes，
  SHA256 `DCFA569137642A7C1242283E30138FFBC31F4BE726AB629FE12DF05B21A67025`）。
  folder app FileVersion 1.5.0、ProductVersion 1.5.0.0；候选尚未上传。
- 根目录用户 `package-lock.json` SHA256 仍为
  `08DD6162809680B6A40916C22DC5DB4208F97772B7C6F25CEC242C0BB0140547`，
  不纳入提交。
