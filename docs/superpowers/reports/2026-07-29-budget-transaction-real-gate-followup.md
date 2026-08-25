# 2026-07-29 预算事务系统与双语 100k 复验

## 结论

预算事务系统、精确词项投影和结构复杂度上限已经实现，最终代码门禁全部通过。

德语全新 100k 运行满足发布标准；《时间之子》第一部 100k 在新的结构边界下已能
通过此前失败的复杂窗口，但后续 DeepSeek 长连接连续失败，durable ledger 正确
将相关调用标记为 usage incomplete。因此双语 release gate 尚未同时通过，
本轮没有更新版本号、提交 tag、push 或上传 release。

## 实施范围

规格：
`docs/superpowers/specs/2026-07-29-budget-transaction-system.md`

主要实现：

1. 所有模型调用统一执行
   `reserve → dispatch → settle/release`，未知 usage 按
   `max(observed, reserved)` 保守扣账；
2. durable ledger 是实际 token 消耗的唯一事实源，CLI、报告和 export 投影均可
   从 ledger 重建并纠正陈旧数据；
3. `BudgetOracle` 依据真实序列化请求、tool schema、可见输出上限、reasoning
   上限和安全余量预算；
4. mandatory horizon 与 reserve 原子准入；异常退出和 resume 会结算已发车调用，
   仅释放确定未发车的 reservation；
5. strict export 对 usage incomplete、open attempt 和 ledger/projection 不一致
   fail closed；
6. 概念语义归一化与源文逐字出现匹配分离；resume 会按不可变源文重建 occurrence
   投影并淘汰已消失的旧任务；
7. 一个逻辑源块最多包含 32 个语义段落，只能沿不可变段落边界拆分，不降低
   1:1 段落完整性门禁；
8. 源文中原样保留的拉丁学名（例如双名法）不再被误判为未翻译 prose，邻近普通
   英文仍按原规则校验。

## 德语 100k

- 项目：`projects/kafka_verwandlung_100k_budget_tx_20260729`
- run：`4b12f9cc-3ef0-4570-a32f-ea35f00f11c1`
- 模型：`deepseek-v4-flash`
- 调度：`active/balanced`
- 窗口：19 / 19 completed，其中 7 warning
- pending / failed / human-required：0 / 0 / 0
- baseline：1,390,468
- allowed：1,529,514
- actual：609,374
- usage complete：true
- audit：complete、structurally complete、knowledge converged
- strict exportable：true
- strict export：成功，incident 为空

当前 32 段结构上限不会改变该德语样本的 block ID 或窗口计划；其最大逻辑块只有
8 个段落，因此上述全新运行仍是当前代码的有效证据。

## 《时间之子》第一部 100k

样本：

- Unicode scalar：99,862
- 样本 SHA-256：
  `e7911a3b21d28722fce9b7fb2c1dbdd1032f2bcfdd3e1091181fb8ef4e1ad531`
- doctor：22 blocks、19 windows、incident 为空

真实运行先后暴露并推动修复了：

1. context profile 不可行时 planner 错误返回 `NO_LEGAL_PLAN`；
2. `EARTH’S` 的语义词干化错误扩大成普通 `Earth` occurrence，导致 resume
   找不到逐字源项；
3. `Portia labiata`、`Scytodes pallida` 等源文拉丁学名被误判为未翻译 prose；
4. 80 段大块造成 79/80 段输出，说明只限制 token、不限制结构复杂度不够稳健。

加入 32 段硬边界后的最新全新运行：

- 项目：`projects/children_of_time_book1_100k_budget_tx5_20260729`
- run：`6b346935-6a3c-46c5-a2bb-bfe65808324a`
- 已处理：6 / 19（4 completed、2 completed-with-warning）
- 剩余 pending：13
- failed / human-required：0 / 0
- 最后 durable projection：
  - baseline：559,576
  - allowed：615,533
  - conservative actual：525,111
  - usage complete：false

该运行已通过此前失败的复杂窗口和结构恢复路径。随后两条 high-effort
revalidation 长调用以及 lexical anchor 调用收到可重试的 provider
`Connection error`；ledger 中存在 5 条 `usageComplete=false` 的结算事件。
因此该数据库不能作为发布证据，也不能 strict export。

为避免在同一外部故障窗口内继续产生昂贵而不可验证的调用，本轮停止创建新的
英文数据库。待供应商长连接恢复后，必须用全新数据库从 0 重跑英文 100k。

## 最终代码门禁

在最终工作树重新执行：

- `npm test`：881 tests，880 pass，0 fail，1 skip；
- `npm run typecheck`：通过；
- `npm run desktop:test`：Node 110 tests（109 pass、1 skip）；Renderer 66 pass；
- `npm run desktop:typecheck`：通过；
- `npm run desktop:build`：production build 与 preload 验证通过；
- `git diff --check`：通过。

根目录用户未跟踪的 `package-lock.json` 未被修改，SHA-256 仍为：
`08DD6162809680B6A40916C22DC5DB4208F97772B7C6F25CEC242C0BB0140547`。

## Release gate

只有新的英文 100k 运行也同时满足以下条件，才能上传：

1. 19 / 19 完成，0 failed，0 human-required；
2. durable ledger usage complete；
3. actual ≤ allowed；
4. audit complete、structurally complete、knowledge converged；
5. strict exportable 且 strict export 成功；
6. 最终工作树重新通过全部代码门禁。

当前状态：release、tag、push、版本号更新和上传继续冻结。

## 英文 provider failure 根因复核

后续对三个英文数据库的 durable event timeline 做了逐 attempt 复核：

- tx2 在约 14 分钟内连续完成 anchor、主译和 revalidation；随后两条新
  revalidation 在同一秒发车，并在约 5 秒后同时以零 usage 的
  `Connection error` 结束；立即重试及下一次 anchor 同样在约 5 秒失败；
- tx4 的一个长流已运行约 3 分钟并产生部分 usage 后连接中断，随后的新请求约
  5 秒即失败；
- tx5 先连续完成约 15 次调用，包括持续 4 分钟的 high-effort revalidation；
  随后所有新 revalidation 和 anchor 都在约 5 秒内以零 usage 失败。

该模式跨任务类型、block、prompt 大小和新进程出现，不符合确定性英文内容错误或
本地连接池耗尽。当前同一机器、同一 API key、同一模型和同一 OpenAI SDK 的复核：

- `/models`：8 / 8 返回 HTTP 200；
- 低成本流式探针：先执行 3 串行 + 4 并发，再执行 6 轮 × 4 并发，共
  31 / 31 成功；
- 24 调用复核的单轮并发为 4，完成时间 1.116–2.778 秒。

DeepSeek 官方文档说明 `deepseek-v4-flash` 的账号并发上限为 2500，超限会返回
HTTP 429；本次最大并发只有 4，持久化错误也没有 HTTP status。因此可以排除
FolioLoom 确定性 socket/并发上限故障，也没有证据支持 API key、余额或固定请求格式
错误。直接触发点最可能位于 DeepSeek 边缘服务、上游传输或本机到其边缘节点的短时
网络路径；现有证据不足以进一步断言是 DeepSeek 全局事故。

官方参考：

- <https://api-docs.deepseek.com/quick_start/rate_limit/>
- <https://api-docs.deepseek.com/quick_start/error_codes/>

### 发现并修复的架构放大器

虽然触发点在外部传输路径，旧架构会放大故障：

1. 主译在 usage 已不完整后仍于同一 run 立即重发；
2. revalidation 把 provider error 消耗为质量 attempt，最终写成 warning；
3. revalidation failure 后 runner 仍继续发 lexical anchor；
4. CLI 只报告 `CLI_ERROR`，没有稳定 provider 分类。

现已改为：

- 任一 provider failure 都立即形成 run boundary；只等待已经发车的并发 sibling
  结算，不再发起同轮 retry、后续 revalidation 或 anchor；
- 受影响的主译窗口保持 pending，允许以后显式 resume；
- 受影响的 revalidation 原子恢复 pending，并回退本次质量 attempt 计数；
- ledger attempt ID 仍保持唯一；未知 usage 继续保守结算；
- CLI 输出稳定的 `PROVIDER_BUSY`、`PROVIDER_TIMEOUT` 等分类。

故障注入验证：

- retryable provider error 只调用一次，不发生同轮重发；
- revalidation 保持 pending、attempts 回到原值、不产生 warning；
- 未发车 sibling 保持 pending；
- 相关回归 150 / 150 通过；
- 最终全量 `npm test`：884 tests，883 pass，0 fail，1 skip；
- TypeScript、桌面 TypeScript、桌面测试和 production build 全部通过。

这些改动消除了外部抖动的架构放大，但不会让已经含有 incomplete usage 的 tx2/tx4/tx5
重新成为 release 证据。英文 100k 仍需在新数据库中从 0 复跑。

## 英文全新数据库 tx7 / tx8 复验

tx7 从零完成了 19 / 19：

- 项目：`projects/children_of_time_book1_100k_budget_tx7_20260729`
- run：`860eef4f-fb95-4697-a432-8257ca3c6412`
- 12 completed、7 completed-with-warning、0 pending / failed / human-required；
- baseline 1,548,649 / allowed 1,703,513 / actual 1,083,059；
- durable ledger usage complete；
- 一项 revalidation 在外层 committed-boundary 校验中两次失败，留下
  `warning_stale`，因此 knowledge 未收敛、strict exportable=false。

这暴露的不是 provider 故障，而是 repair loop 的输入不完整：revalidation 的常规
质量失败会进入定向修复，但与已经提交的相邻块之间的边界失败只在 repair loop
外层出现，重试时模型没有收到可执行的失败反馈。现已把 committed-boundary 失败
映射到唯一可变的当前块，并在首次校验和修复后复检时都注入同一 repair loop；
外层校验仍作为并发提交防火墙保留。相关回归 168 / 168 通过，TypeScript 与
`git diff --check` 通过。

tx8 用全新数据库验证上述修复：

- 项目：`projects/children_of_time_book1_100k_budget_tx8_20260729`
- run：`471ad015-130b-4b69-8fa1-2fdff50c69a8`
- 运行约 30 分 37 秒后以 `outcome=human_required` 收尾；
- 10 completed（其中 6 warning）、1 human-required、1 staged、7 pending；
- 独立 audit 为 12 / 22 blocks、`strictExportable=false`；
- baseline 1,040,879 / allowed 1,144,966 / actual 725,915；
- 所有 durable settled attempt 均 `usageComplete=true`，没有 provider /
  connection error；
- 8 项 revalidation 全部 `resolved_retranslate`，另 1 项 `resolved_noop`，
  0 stale / warning-stale，证明 tx7 的 committed-boundary 修复在真实调用中生效。

阻断窗口为 ordinal 10（`window-e8ef6957384451593c58`）。首次 typed-tool
响应把 23 个源段落压成 1 个目标段落，定向修复仍未通过；隔离后的 high/max
typed-tool retry 没有提交目标窗口，随后 framed-text protocol switch 返回了
不匹配的 FolioLoom marker，严格解析器拒绝该响应并将窗口置为
`human_required`。相关调用都正常结算且 usage 完整，因此本次失败不是 DeepSeek
服务波动，而是模型退化输出叠加“一次性 framed fallback 无自修复”的恢复缺口。

结论：英文 release gate 仍未通过；不得上传、打 tag、更新版本号或 release。
