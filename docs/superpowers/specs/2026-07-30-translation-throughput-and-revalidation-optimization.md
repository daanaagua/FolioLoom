# FolioLoom 翻译吞吐与知识重验证优化规格

日期：2026-07-30
状态：已实施并通过双语 100K 验收
适用版本：v1.5.1
生产内核：`folioloom/` TypeScript

## 1. 目标

在不放宽丢失防护、身份、账本、提交和严格导出规则的前提下，优先消除英文
短段落书稿中已经观测到的重复 provider 工作：

1. 降低 paragraph fragment / refinement 调用数量；
2. 降低每个 fragment 重复生成的 schema、metadata 和 reasoning；
3. 避免单次、低置信度词汇发现反复使已提交译文失效；
4. 将一轮翻译中连续产生的知识变更合并到最终知识水位后再重验证；
5. 让局部坏段只重做其所在的最小失败子树；
6. 在请求形状稳定后，再利用既有动态调度器做受限并发。

允许对低风险片段少量降低发现型元数据、上下文丰富度或 reasoning effort；
不得以降低源文覆盖、译文完整性或严格导出条件换速度。

## 2. 实测基线与根因

### 2.1 英文 100K

`Children of Time` 前 99,862 字符：

- 48 分 56 秒；
- 453 个手工段落，平均 218 字符，144 段短于 80 字符；
- 166 次主调用、28 次重验证调用；
- 160 次 paragraph unit / refinement 调用；
- 仅 2 次外层重试、9 次 repair；
- 重验证约 15 分 42 秒，占总时长约 32%。

84 段的目录/前置信息窗口产生 32 次调用；其他 20–31 段窗口通常产生
9–13 次预先规划的 fragment 调用。这些不是网络重试。

### 2.2 德文 100K

`Die Verwandlung` 前 99,953 字符：

- 14 分 45 秒；
- 90 个手工段落，平均 1,109 字符；
- 31 次主调用、10 次重验证调用；
- 仅 4 次 paragraph unit 调用；
- 0 次外层重试。

### 2.3 根因结论

英文/德文：

- 段落数比约 5.03；
- 主调用数比约 5.35；
- 总调用数比约 4.73；
- 总时长比约 3.32。

因此主要根因是固定 `6 paragraphs / 480 source tokens` 分片、fragment
重复携带完整 metadata schema，以及每个 wave 前立即排空重验证；普通重试和书稿
文学复杂度不是主要解释。

## 3. 不可变约束

以下约束继续 fail closed：

1. source version、block、window、manual paragraph 身份不可变；
2. 每个源段恰好对应一个有语义的目标段，顺序相同；
3. transport group、恢复子段和 sentence leaf 均不得成为持久化身份；
4. fragment 只可在完整 exact cover、整块校验通过后组装；
5. `ExecutionWorker` 不写数据库、不提交窗口；
6. 所有 provider 调用继续 reserve → dispatch → settle；
7. 已发车且 usage 未知时按保守上界结算；
8. `CommitCoordinator` 只按 ordinal 推进；
9. revalidation replacement 继续检查 source/snapshot/current concept，
   并原子替换；
10. strict export 继续要求结构完整、usage complete、knowledge converged、
    coverage 完整且无 stale/warning-stale；
11. 不新增 `book.db` 关系表；不提交书稿、译文、数据库、prompt 或凭据。

## 4. 总体设计

优化只替换策略，不改变身份、账本、校验、提交和导出权威：

```text
immutable paragraphs
        │
        ▼
adaptive contiguous transport groups
        │
        ├─ success ───────────────┐
        └─ local structural fail  │
                 ▼               │
          token-balanced bisection
                 ▼               │
             scalar leaf         │
                                 ▼
                     exact-cover assembly
                                 ▼
                    unchanged validation
                                 ▼
                   staged ordinal commit
                                 ▼
            frozen-wave knowledge reconcile
                                 ▼
              one final revalidation drain
```

## 5. P0：度量与策略版本

### 5.1 必须记录

在既有 runtime observation 与 ledger 之上可推导或记录：

- execution unit 的 paragraph count；
- source tokens、预测 output tokens、schema tokens；
- model/provider、语言、内容类别、protocol、effort；
- first-pass accepted / structural failure / semantic failure；
- recovery 深度和 recovery token；
- accepted source tokens / wall-clock second；
- wave 起止 snapshot 和最终 revalidation drain。

不得把书稿或 prompt 写入新增度量。

### 5.2 策略版本

新增 paragraph policy version。旧策略保留为可选择的测试/回滚实现：

- `legacy-v1`：固定 6/480、失败后全 scalar；
- `adaptive-v2`：本规格的 workload packing、tail rebalance、bisection。

## 6. P1：知识晋升门槛与最终水位重验证

### 6.1 低证据模型发现

单次模型分类不得直接把普通大写词提升为可触发全书重验证的 lexical concept。

模型发现只有满足下列任一条件才可成为 lexical concept：

1. 用户 glossary/import 明确声明；
2. 原文带有直接中文/汉字释义；
3. `proper_name` / `unique_title` 同时具有显式命名线索和高置信度；
4. `technical_term` / `role` 具有重复、跨位置证据和高置信度；
5. 已存在独立证据，当前结果是重复确认。

未达到门槛但可用的译法可保存为 soft lexical preference，不生成
`lexical_concept`，不得创建 sparse revalidation task。

### 6.2 wave 冻结

一个 provider wave 中所有任务继续使用 wave 开始时的不可变 snapshot。wave 内模型
发现仅在边界统一 reconcile。

### 6.3 重验证合并

主翻译尚有 pending/running/staged window 时，不执行模型重验证。知识任务继续
持久化为 pending。

只有满足以下条件才 drain：

- 本 run 所有翻译 window 已进入 committed terminal 状态；或
- 用户显式请求 strict export / final validation barrier。

最终 drain 使用最新 snapshot。若多个旧 task 指向同一已被替换的 translation，
后续 task 通过现有 active-translation gate 自动收敛为 noop，不再次调用模型。

暂停、provider failure、`maxWindows` 部分运行均不提前 drain；恢复后继续累积，最终
统一处理。任务和 binding 在此期间保持 stale，strict export 仍被阻止。

### 6.4 P1 验收

- Ocean/Western 形状的普通大写词不产生 lexical concept；
- 明确的人名、称号、术语仍可晋升；
- 多 wave 连续知识变更期间模型重验证调用数为 0；
- 最终 barrier 能排空任务并使 knowledge converged；
- 同一旧 translation 在一个最终水位最多被模型替换一次；
- 英文同类运行的重验证调用目标：28 → ≤20；
- 不允许 coverage、stale 或 strict-export 回归。

回滚：恢复旧 promotion policy，并在每个 wave 前 drain；已有事件和证据不删除。

## 7. P2：最小 fragment contract

### 7.1 全块协议

正常 whole block/window 继续允许完整字段：

- translations；
- term usages；
- notes；
- memory candidates；
- style observation。

### 7.2 多段 fragment 协议

paragraph fragment 只返回：

- invocation-owned window/block 下的 ordered paragraph texts；
- 本 fragment 中 harness 已列出的 exact term usage receipts。

不得返回：

-自由 notes；
- memory candidates；
- style observation；
- 新概念定义。

host 已持有 window/block/paragraph identity；最终 scalar leaf 继续只返回
`{text}`。

### 7.3 metadata 补偿

- lexical discovery 由 wave lexical anchor 阶段负责；
- style observation 由已存在的本地 `createStyleObservation` 从整块 source/target
  推导，模型 submission 仅是可选增强；
- narrative memory 只从成功的 whole block/window 输出接收；
- fragment 恢复路径不新增独立 metadata consolidation 调用，避免为了少量发现信息
  重新增加固定调用。

若后续抽样证明 memory recall 显著下降，再增加“仅异常标志触发一次 window
consolidator”，不得默认全量调用。

### 7.4 TOC/title

目录、标题、短结构行使用相同 minimal fragment contract；不得携带 prose memory
或 voice discovery schema。

### 7.5 P2 验收

- fragment wire schema 不出现 notes/memory/style；
- exact term receipts 仍受全量 deterministic gate；
- scalar leaf 仍只有 text；
- 84 段 TOC 目标 ≤18 次调用；
- output + reasoning tokens / accepted source token 明显下降；
- first-pass schema validity 不低于基线。

回滚：选择旧完整 typed fragment protocol version。

## 8. P3：自适应连续分组

### 8.1 输入与硬约束

分组仅在同一个 immutable block 内进行，必须连续，不跨 block、window 或受保护的
source occurrence。每段恰好属于一个 unit。

硬约束：

- provider context/output capacity；
- `hardMaxParagraphs`；
- `hardMaxPredictedSourceTokens`；
- `hardMaxPredictedOutputTokens`；
- protected source range；
- 单个超限段必须独立。

### 8.2 预测量

每个候选 group 计算：

- `S(g)`：source tokens；
- `I(g)`：context + source + schema input；
- `O(g)`：按语言长度 band 预测的 target output；
- `R(g)`：effort/profile 的 reasoning reserve；
- `p_schema(g)`：按 paragraph count、输出占用率、内容类别估计的结构失败率；
- `C_recovery(g)`：失败后 token-balanced bisection 的期望成本；
- `P_accept(g)`：在现有 repair/recovery 上限内通过的概率。

目标是在完整覆盖下最小化：

```text
ExpectedCost(g)
  = fixedCallCost
  + alpha * I(g)
  + beta  * O(g)
  + gamma * R(g)
  + p_schema(g) * C_recovery(g)
  + literaryRiskPenalty(g)
  + tinyTailPenalty(g)
```

整本 source token 数固定，因此最小化总期望成本等价于最大化
`accepted source tokens / expected second`。

候选 endpoint 数小于 32，使用确定性动态规划求最小成本 exact partition。相同成本
优先更少调用，再优先更平衡的尾组。

### 8.3 冷启动参数

在真实样本足够前：

- legacy soft target：6 paragraphs / 480 source tokens；
- adaptive 普通短段可增长到 10 paragraphs；
- 低风险、低预测输出占用时才允许超过 6；
- dialogue/verse、嵌套引号、mixed script、异常 markup、历史失败组收缩；
- 一个极小尾组应与前组重平衡。

按 model + language + content class 分桶；低样本或低置信度回退 legacy。

### 8.4 在线更新

只使用 durable runtime observations 更新，不在单次失败后永久改变全局策略：

- 连续 clean group：additive increase；
- truncation / identity / schema failure：immediate halve；
- 429、5xx、timeout、auth、quota：不得缩小 group；
- 新参数先 shadow 评分，达到最小样本后才生效；
- 参数必须有上下界，可切回 legacy。

### 8.5 P3 验收

- exact cover、identity、order、protected range property tests 全通过；
- 23 段短文本不得固定产生 `[6,6,6,5]`；
- 不产生 1 段 tiny tail（除非该段本身违反合并硬约束）；
- 英文 paragraph/refinement 调用目标：160 → ≤110；
- accepted source tokens/s 提高 ≥25%；
- first-pass acceptance 相对基线下降不超过 1 个百分点；
- repairs/retranslations 不显著上升。

回滚：`legacy-v1` partitioner；candidate/ledger/commit 数据无需迁移。

## 9. P4：分类恢复与递归二分

### 9.1 分类

| 失败类别 | 动作 |
|---|---|
| timeout / connection / transient 5xx | 原组有界退避；形成 run boundary；不二分 |
| 429 / overload | 降并发；不二分 |
| auth / quota / DB / abort | 立即停止；不二分 |
| output truncation / missing suffix | 二分，可保留身份明确的完整 sibling |
| ID/schema mismatch | 一次同组 corrective turn 后二分 |
| content refusal | 二分隔离，最终 scalar |
| semantic validator failure | 只把失败段路由到强路径；不因语义失败盲目二分 |
| 同签名跨组重复失败 | circuit break，禁用对应 protocol/profile |

### 9.2 二分树

- 按预测 target tokens 找平衡切点，不按 paragraph count 平分；
- 子组保留原组左右 source context，但只提交自身 paragraph IDs；
- 成功 sibling 不重做；
- 失败子组递归下降；
- leaf 为现有 text-only scalar；
- 最大深度和 retry-token budget 均受 admission baseline 约束；
- 最坏合法恢复树在发车前计入 run-level baseline，但只把当前节点放入瞬时
  in-flight。

单个超长 manual paragraph 的 sentence split 不进入 v1 默认路径。只有真实样本证明
单段超过 output capacity 时才启用；临时 sentence ordinal 不持久化，最后仍组装成
一个 paragraph。

### 9.3 P4 验收

- 单一坏段只重做二分路径，成功 sibling 不重复调用；
- systemic/provider failure 不产生 child；
- 所有节点 attempt ID 跨进程唯一；
- 最坏恢复树被 baseline 覆盖；
- 无重叠 candidate 可重复提交；
- 回归保持最多三个 scoped repairs。

回滚：使用旧 paragraph-vector → all-scalar fallback。

## 10. P5：既有优化的收口

以下能力已经存在，不另建第二套系统：

1. 风险/effort routing：继续由 RollingHorizonPlanner 和 runtime variants 负责；
2. context reduction：继续使用 lean/balanced/rich profile 和
   `narrowSelectedKnowledgeToTranslationWireInput`；
3. selective validation：identity、coverage、term、empty、truncation、residue、
   boundary 永远全量；只有模型 repair 是失败触发；
4. bounded concurrency：继续使用 dynamic scheduler、weighted token admission、
   AIMD 和 ordinal-frontier 语义；
5. deterministic repair：只允许不改变译文的、无歧义的 envelope normalization。

在 P1–P4 稳定前不得提高默认并发。并发只减少 wall time，不减少 token 或费用。

## 11. P6：缓存与进一步降级

### 11.1 精确缓存

冷启动新书收益为零，因此不阻塞本轮发布。后续 exact cache key 至少包含：

- source bytes/hash 与 paragraph identity；
- target language；
- model、effort、protocol、contract version；
- relevant knowledge subset hash；
- style/context selector hash；
- validator/normalizer version。

上下文不一致的命中只能成为 candidate，不能自动 commit。命中仍运行全部硬校验并
保留 provenance。v1 不做 fuzzy TM。

### 11.2 小质量降级

只有在 P1–P4 通过后才允许：

- 低风险组降低 reasoning effort；
- 省略无关 neighboring tail；
- 只抽检昂贵语义 review。

不得同时启用模型降级、上下文缩短、扩大分组和减少 QA；每次实验只改变一个变量。

## 12. 分阶段验证

每个阶段执行：

```powershell
npm test -- --test-name-pattern <focused>
npm run typecheck
```

阶段合并前执行：

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
git diff --check
```

真实门禁必须使用全新项目/数据库，不覆盖 tx32、tx34 或唯一证据库：

1. 英文 `Children of Time` 前 100K；
2. 德文 `Die Verwandlung` 前 100K；
3. active/balanced、`deepseek-v4-flash`；
4. 记录总时长、调用类别、tokens、repair/retry/revalidation；
5. 两者均须 19/19、usage complete、actual ≤ allowed、
   knowledge converged、coverageMissing=0、strict exportable；
6. 与 tx32/tx34 比较速度和结构/知识质量指标。

若供应商发生 connection/provider failure，该数据库只作为故障证据，不计性能验收；
恢复后用全新数据库从零复跑。

## 13. 成功定义

只有同时满足以下条件，才可宣布“改进成功”：

1. P1–P4 的行为与回归测试全部通过；
2. 全量核心、桌面、typecheck、build、diff gate 全通过；
3. 全新英文与德文 100K 均严格导出；
4. 英文主路径调用和重验证调用达到门槛，或提供证据证明同等 wall-clock/token
   收益且无质量回归；
5. 德文不发生显著性能回退；
6. 所有不变量零违反；
7. release note、性能报告和可回滚策略均已记录。

在上述条件完成前，不更新 release、不上传候选，也不声称已经成功。
