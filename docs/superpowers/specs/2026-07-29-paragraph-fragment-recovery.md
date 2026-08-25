# FolioLoom 段落级执行分片与严格恢复规格

日期：2026-07-29
状态：实施中
目标版本：FolioLoom 1.5.x
前置规格：

- `docs/superpowers/specs/2026-07-29-budget-transaction-system.md`
- `docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`

## 1. 决策摘要

FolioLoom 保持 logical window、canonical block、source hash、SQLite translation
记录和 `CommitCoordinator` 顺序不变，但不再要求一个 canonical block 同时充当
generation、validation 和 commit 的最小原子。

对于结构风险高或已经发生 shape collapse 的单个 canonical block，`ExecutionWorker`
在内存中建立确定性的 paragraph fragment plan。每个 fragment 只翻译连续的源段落，
同一 block 内顺序发车；全部 fragment 通过局部校验、精确覆盖组装和原 block 全量校验
后，才产生一个仍以 canonical block ID 标识的候选。fragment 永远不能独立 stage、
promote、写 `translations` 或改变窗口状态。

恢复决策固定为：

```text
provider capability / typed transport protocol failure
  -> strict framed compatibility attempt

content shape collapse or large-unit membership failure
  -> typed paragraph fragments

localized content failure
  -> at most one targeted repair per execution scope,
     at most three scopes in one request

wrong framed marker / ambiguous dispatch / unknown usage
  -> reject or reconcile; never local salvage
```

## 2. 本地根因证据

英文 100K tx8 的阻断窗口
`window-e8ef6957384451593c58` 只有一个 canonical block：

- source chars：5,136；
- source paragraphs：23；
- 初次 typed 输出：23 段压缩为 1 段；
- 同一调用内 targeted repair 仍失败；
- outer isolated typed retry 缺少 submission；
- 随后的 framed fallback 返回错误 marker，严格 parser 正确拒绝；
- 所有已发车调用 usage 完整，0 provider/connection error。

现有恢复只能按 physical request → window → canonical block 拆分。该窗口已经是单
window、单 block，因此 `splitPhysicalRequestAtBoundaries()` 返回空；系统随后把内容
退化误送入 framed 协议分支。根因不是 marker parser 太严格，而是执行原子仍等于
canonical block，且协议完整性与内容完整性没有分轴路由。

## 3. 目标

1. 23→1 等 shape collapse 不再进入 framed fallback；
2. 高风险单 block 可在首次 provider dispatch 前选择 fragment-first；
3. paragraph fragment 只沿现有语义段落边界切分；
4. fragment 使用显式 execution unit 与 paragraph identity，不伪造新的 canonical ID；
5. 同一 block 内顺序执行，已接受左侧只作为不可变 target oracle；
6. assembler 必须验证 plan hash、snapshot、exact paragraph cover、顺序和唯一性；
7. 最终候选必须重新接受 canonical block/window 的完整质量与术语校验；
8. 每个 execution scope 最多一次 targeted repair，每个 request 总计最多三次；
9. shape collapse 不消耗 repair credit；
10. 每次 provider 调用继续 reserve → dispatch → settle，usage 完整性规则不降级；
11. raw provider evidence 在业务分类前形成可审计证据；
12. strict export 继续拒绝 partial、unknown usage、mixed snapshot 和未收敛知识。

## 4. 非目标

- 不从失败 whole-block primary 中抢救部分段落；
- 不做 sentence/subparagraph split；
- 不做递归 fragment split；单段仍超限时进入 `human_required`；
- 不做双侧 seam rewrite；
- 不把每个 fragment 变成独立 logical block、window 或 translation row；
- 不新增 fragment 关系表；
- 不引入 HMAC、完整 event sourcing 或 formal model checking；
- 不把 framed 协议作为内容质量恢复手段；
- 不接受近似 nonce、近似 block ID、未知 paragraph ID 或 frame 外文本。

## 5. 身份与原子性

系统区分五种身份：

1. `logicalWindowId`：持久化调度与 commit 原子；
2. `canonicalBlockId`：持久化 source/translation 原子；
3. `fragmentPlanId`：由 policy version、source hash、snapshot 和段落范围确定性派生；
4. `executionUnitId`：plan 内单个连续段落范围；
5. `attemptId/requestId`：单次 provider 调用与 ledger 原子。

`executionUnitId` 和 paragraph ID 只能存在于本地 call contract、内存候选和 audit
event 中；V1 不把它们交给 provider。它们不得进入 `window_membership`、
`logical_blocks` 或 `translations` 主键。

建议的内存类型：

```ts
interface SourceParagraphSpan {
  readonly paragraphId: string
  readonly ordinal: number
  readonly utf16Start: number
  readonly utf16End: number
  readonly sourceText: string
}

interface ParagraphFragmentUnit {
  readonly executionUnitId: string
  readonly planId: string
  readonly blockId: string
  readonly paragraphStart: number
  readonly paragraphEnd: number
  readonly paragraphs: readonly SourceParagraphSpan[]
  readonly leftSourceContext: readonly SourceParagraphSpan[]
  readonly rightSourceContext: readonly SourceParagraphSpan[]
}

interface ParagraphFragmentPlan {
  readonly schemaVersion: "paragraph-fragment-plan-v1"
  readonly policyVersion: "paragraph-fragment-policy-v1"
  readonly planId: string
  readonly windowId: string
  readonly blockId: string
  readonly sourceHash: string
  readonly snapshotId: string
  readonly paragraphs: readonly SourceParagraphSpan[]
  readonly units: readonly ParagraphFragmentUnit[]
}
```

paragraph ID 为 canonical block 内的稳定 ordinal 身份，例如
`block-…:paragraph:0007`。它不是数据库 ID；其有效性由 source hash、plan hash 和
exact-set 校验共同保证。

## 6. Paragraph Planner

### 6.1 段落投影

planner 在原 `LosslessBlock.sourceText` 上识别：

- 空行分隔；
- certified source 中的 `[[]]` scene separator。

每个 span 同时保存原字符串 UTF-16 坐标和 canonical Unicode-scalar 坐标：字符串切片
使用 UTF-16，术语 occurrence ledger、边界保护和审计使用 scalar。发送模型前才调用
既有 source layout projection；空白和 layout token 不单独成为 paragraph。

同一输入、policy version、source hash 和 snapshot 必须产生相同 plan 与 plan hash。

### 6.2 V1 分片策略

- `maxTargetParagraphsPerUnit = 6`；
- `maxSourceTokensPerUnit = 480`，使用 canonical block 已有 token count
  按 source scalar 比例确定性估算；
- 每侧最多 1 个 source context paragraph；
- 同一 unit 只能包含同一 canonical block 的连续段落；
- unit exact cover 整个 block，不允许 gap、overlap、duplicate 或 reorder；
- 单 paragraph 自身超过 provider context/output 安全上限时停止自动恢复；
- paragraph 数超过 12 的单 block 默认 fragment-first；
- 若高风险 block 位于多 block logical window，执行层先按 canonical block 边界生成
  临时 execution fragments：高风险 block 使用 paragraph plan，普通 sibling 保持
  block-level direct 执行；所有结果按原 block 顺序重新合并后再做完整 logical-window
  校验和一次性提交；
- 12 段以内的 block 只有在 shape collapse 或大单元 membership failure 后进入
  fragments。

阈值由代码常量和 policy version 固定，不提供运行时 operator 覆盖。

## 7. Provider 协议

### 7.1 Normal typed 请求

保持现有：

```json
{
  "windowId": "window-…",
  "translations": [
    { "blockId": "block-…", "text": "…" }
  ]
}
```

### 7.2 Fragment typed 请求

fragment prompt 明确区分 target source fragment 与 context-only paragraphs。

结合现有代码后，V1 不把 `executionUnitId` 或 paragraph ID 加进 provider DTO。
fragment 每次只发一个 typed 请求、一个 canonical block，同一 block 严格串行，因此
fragment 归属由本地 call contract 唯一绑定。provider 必须返回一个有序 paragraph
vector；段落边界由 typed array item 表达，不再从一个 JSON string 中的空行反推：

```json
{
  "windowId": "window-…",
  "translations": [
    {
      "blockId": "block-…",
      "paragraphs": [
        { "text": "第一段……" },
        { "text": "第二段……" }
      ]
    }
  ]
}
```

prompt 侧同样把 target source 表达为有序
`paragraphs: [{ordinal, sourceText}]`，而不是先连接成一段字符串；`ordinal` 只描述
本次 unit 内顺序，不是持久化身份，也不由 provider 回传。

应用层校验：

- windowId exact；
- canonical blockId exact；
- target semantic paragraph count 等于本地 unit range；
- 每个 target paragraph 非空且顺序不变；
- 不允许 context-only paragraph 被额外输出。

通过后，本地按 array ordinal 和 unit contract 将 target paragraphs 绑定回内部
paragraph ID，再以 canonical `\n\n` 连接。provider 不抄写 paragraph ID，既避免
身份幻觉，也不再依赖模型正确转义或保留 JSON string 内的空行。
`executionUnitId` 绝不由 provider 输出推导，也不进入 typed schema。

tx13 证明仅把 unit 缩到 480 source tokens 仍不足以解决边界退化：两个不同 unit
分别把 4–6 个源段落合并成 1–2 个 target 段落。根因是旧 DTO 把结构重新压回一个
`text` 字符串；继续减小 token cap 只能降低概率，不能关闭错误类别。有序 paragraph
vector 将结构变成 schema-level data：缺项、增项或空项仍 fail closed，完整 vector
才进入既有质量校验。

已经带 `paragraphPlan` 的 execution unit 不得进入 whole-block framed、block split
或重新运行通用 planner。其 typed submission 若出现 missing submission、paragraph
count mismatch、empty translation、block-set mismatch 或 shape collapse，可以使用
一个固定且有界的 refinement level：

1. 每个 physical request 最多 refinement 一个失败 unit；
2. 失败 unit 按已有 canonical paragraph spans 确定性展开为单段 sub-unit；
3. sub-unit 严格串行，不能再次 refinement；
4. 全部成功后先在内存中聚合回原 executionUnitId，再交给原 plan assembler；
5. 任一 sub-unit 失败，或后续另一个原 unit 失败，保持 fail closed 并交回 outer
   window epoch。

refinement 不调用 planner、不改变 planId、canonical block/window identity 或 commit
边界，也不允许使用不带 paragraph scope 的 `selectedBuildInput(request)`；因此既关闭
tx15 暴露的“长 fragment plan 中不同 unit 随机失败、整窗重跑放大失败概率”，又不会
重现 execution-unit exact-cover 漂移。

### 7.3 单窗口 envelope 归一化

OpenAI-compatible provider 偶尔会生成语义完整、ID 正确的 tool call，却把属于
`windows[0]` 的 `notes`、`termUsages`、`memoryCandidates` 或
`styleObservation` 提升到 tool-call 顶层。tx12 的阻断 unit 连续两次都属于这个
形状：翻译本身已经提交，但本地 schema 在 handler 前拒绝参数，最终只暴露为
`missing window submission`。这不是内容质量失败，也不应消耗 repair credit、重跑
整窗或切换 framed。

协议适配层允许一个严格、确定性的归一化：

1. tool call 必须恰好包含一个 logical window；
2. 顶层字段只允许上述四个已知 window metadata 字段；
3. 同一字段不得同时出现在顶层和 window 内；
4. 归一化只把字段下移到唯一的 `windows[0]`，不修改任何 ID、译文或 receipt；
5. 缺省 `notes` 归一化为空数组；
6. 多窗口归属不明、字段冲突或未知字段继续 hard fail，并获得现有的一次 typed
   corrective turn。

上述 envelope metadata 兼容同样适用于 fragment 请求，因为它只移动四个已知字段，
不改变任何数组基数或 identity。fragment 不再接受 paragraph sibling spill。tx22 的
原始 provider evidence 表明，
宽松的 `translations` union 与多层可变数组会把“可恢复兼容”反向暴露成模型可选择的
合法 wire shape：模型在 reasoning 中完成全部六段译文，却连续两轮把 tool arguments
压缩成一个 anchor、空 paragraph、额外 `{text}` translation 和额外 `{text}` window，
最终得到 `missing window submission`。这是 provider-visible schema 的状态空间过宽，
而非内容能力或服务波动。

fragment 的 provider-visible typed schema 必须直接编码已 admission 的执行图：

1. `windows` 的 `minItems=maxItems=1`；
2. 唯一 `windowId` 使用该 execution unit 的 literal ID；
3. `translations` 的 `minItems=maxItems=1`；
4. 唯一 `blockId` 使用 canonical block 的 literal ID；
5. 不使用 translation union，不暴露 `{text}` sibling 分支；
6. `paragraphs` 的 `minItems=maxItems=executionUnit.paragraphs.length`；
7. 每个 `paragraphs[].text` 的 wire schema 使用 admission source 与语言 profile
   推导的保守 `minLength`；多段 unit 取其中最短合法下界，单段 refinement 使用该段
   自身下界。空字符串和明显不可能通过确定性长度校验的截断都在 handler 之前获得
   同一会话的一次 typed corrective turn；
8. 标准输出把 metadata 放在唯一 window 内；若 provider 只把四个已知 metadata
   字段提升到 tool envelope，则沿用 7.3 的唯一归属归一化。
9. 当 recovery 已收敛到单一 source paragraph 时，切换到
   `finalize_paragraph_fragment` 平坦叶子 contract：
   `windowId`、`blockId`、`paragraphId` 均为 literal，`text` 使用该段自身的长度下界，
   metadata 与它们同层；叶子不再重复暴露 `windows → translations → paragraphs`
   三层数组。

因此结构错误会先由 harness 的 schema validator 拒绝，并获得现有的一次 typed
corrective turn；执行 handler 只接收单一 canonical array shape，再执行确定性的
metadata 下移，不做自由文本解析、ID 猜测、空内容补全或 sibling salvage。通过
schema 后仍必须执行 exact identity、段落、术语与质量校验。

tx23 的真实 evidence 验证了这两个约束必须正交：固定 cardinality 让六段错误输出在
corrective turn 中明确获知“唯一 window、唯一 translation、恰好六段”；但单段
refinement 的第一次输出已经具有正确 cardinality，只把 `termUsages`、`notes`、
`memoryCandidates` 和 `styleObservation` 提升到 envelope。若 fragment schema 连这
个无歧义形状也拒绝，会把本可直接接受的单段恢复变成第二次随机生成，并放大为
`missing window submission`。因此 exact arrays 与 sole-window metadata normalization
必须同时存在，不能用其中一个替代另一个。

tx25 的真实 evidence 又验证了 wire schema 不能只固定容器形状。一个单段 refinement
返回了 cardinality、windowId、blockId 全部正确但 `text=""` 的 tool call；旧 schema
把空字符串当作合法参数，handler 随后才以 `empty translation` 拒绝。因为该 sub-unit
已经是恢复图的叶子，原本可由同一 typed 会话纠正的形状错误被放大成整窗
`human_required`。将非空约束前移到 provider-visible schema 后，空字符串与数组漂移
一样消耗 corrective turn，而不消耗新的 refinement、repair credit 或 window retry。

tx28 进一步证明 `minLength=1` 仍不足以代表已知的 validator contract。ordinal 3 的
长对话段在两次独立 outer attempt 中都被压成一句“塞林继续轻快地说下去：”；随后
targeted repair 仍提交同一句，最终以 `paragraph_length_incompatible`（比例 0.020）
进入 `human_required`。provider usage 完整且同一波其他窗口已经 staged，因此不是
服务波动。wire schema 现在复用 source-language profile 的长度比例 band，为 fragment
计算保守长度下界；这不是放宽质量规则，而是把可静态证明必然失败的参数提前到 typed
corrective turn。完整语义长度、可读字符、目标脚本等检查仍由最终 validator 负责。

tx29 验证了仅收紧嵌套 schema 仍不能作为最终叶子协议。长度下界修复使 tx28 的
ordinal 3 在首次 attempt 通过，critical ordinal 10/11 也通过，且 tx27 的
`NO_LEGAL_PLAN` 点成功发车；但 ordinal 16 的两个 outer attempt 都出现相同的
nested-array collapse。进入单段 refinement 后，模型虽能把容器纠正为单 window、
单 translation、单 paragraph，却会原样重交过短文本并在第二次 schema error 后停止，
最终仍为 `missing window submission`。该 run 的 provider usage 完整，actual
2,860,969 ≤ allowed 10,563,666，不是服务波动。单段 leaf 因此使用独立平坦 tool；
这是执行图收敛后的协议降维，不是自由文本 fallback，也不放宽 identity、长度、术语或
最终 commit gate。

### 7.4 Framed

framed 只允许：

- provider/model 明确不支持 structured/tool；
- 已发车 typed channel 出现 provider 分类为 `protocol` 的 transport/capability 错误。

以下错误禁止进入 framed：

- paragraph count/length；
- abnormal shortening；
- untranslated prose；
- typed exact membership failure；
- shape collapse；
- seam 或术语失败。

每个 framed attempt 使用 128-bit CSPRNG nonce。V1 不认证模型，nonce 只防 source
literal collision 与 cross-attempt confusion。parser 继续 exact match；wrong nonce、
重复 marker、frame 外文本全部拒绝。

当前系统不重放可能已发车的 in-flight provider attempt：崩溃后旧 attempt 保守结算并
结束，新 attempt 使用新 nonce。因此 V1 只需保证同一个 admitted input 在 preflight
与真实 dispatch 中复用同一 nonce；不需要为不存在的 in-flight replay 增加新表。

## 8. 术语、记忆和上下文

term occurrence 必须先按完整 canonical block 计算，再按 paragraph span 过滤，因此：

- occurrence ID、blockId 和 sourceStart/sourceEnd 仍是 canonical 坐标；
- fragment 不重新从局部字符串生成不同 occurrence ID；
- assembler 合并 receipts 后按完整 block expected set 再验证。

occurrence 的 lexical boundary 必须按每一个候选匹配位置局部判定。实现先在原始 source
上生成带 UTF-16 坐标的 word span，再把归一化 scalar match 映射回原始坐标；只有匹配
恰好覆盖一个 word span，或满足本地 identifier/CJK 边界规则时才接受。不得因为同一
block 的其他位置出现过某个独立 token，就把该 token 在 `claim`、`appraised`、`waits`
或 `brain` 等单词内部的子串也登记为 occurrence。

typed provider 可以提交 occurrence receipt，但 receipt 不是事实来源。kernel 保留并严格
校验所有已提交 receipt；对于模型遗漏的 receipt，只有在相应 canonical allowed
realization 已确定性出现在该 block 的 target text 中时，kernel 才补全 harness-owned
receipt。未知、重复、伪造坐标、不允许 surface 或 target 中不存在的已提交 receipt
均不得被补全逻辑覆盖。这样模型无须重复抄写内核已经掌握的 occurrence 身份，同时
术语目标确实缺失时仍进入一次局部 repair。

receipt capture 与 sparse-revalidation surface compatibility 是两个不同判定：

- `locked` policy 是硬契约，receipt surface 必须通过既有严格 allowed-surface 判定；
- `preferred` / `contextual` 是软建议，provider 可以回报确实出现在 target 中的、有界
  实际 realization；kernel 只接受不超过 12 个 Unicode scalar、无空白且仅包含安全
  字母、标记、数字、连接符、间隔点、撇号或连字符的 surface；
- 软策略 receipt 可以省略：若 canonical allowed realization 已出现在 target，kernel
  可以确定性补全；否则保持未绑定，不得因为 `Earth’s` 被自然译成“地球”而强制修复为
  “地球的”。只有 `locked` occurrence 缺失 receipt 才是完整性失败；
- 无论 policy 如何，实际 surface 必须在对应 block 的 target text 中确定性存在；
- sparse revalidation 继续使用独立、严格的 compatibility 判定，不因 receipt capture
  的软策略而放宽。

软策略允许省略 receipt，不等于允许省略知识覆盖关系。revalidation replacement 在
完整 block 上重新计算 exact source occurrences 后，必须为每个确实出现的当前 concept
在新 active translation 上物化一条 binding：

- 有合法 receipt 时，binding 保存已经校验并排序的 receipts；
- `preferred` / `contextual` 合法省略 receipt 时，binding 保存空 receipt 数组，但仍以
  当前 revision/render fingerprint 标记为 `clean`；
- `locked` receipt 缺失会在 submission validation 阶段失败，不能进入空 binding 路径；
- 不得为 source 中没有 exact occurrence 的 concept 伪造覆盖。

replacement 的 promotion、task resolution 和上述 binding 写入必须位于同一事务。这样
“可选 receipt”只影响 surface 证据，不会让已完成 revalidation 在 strict audit 中重新
变成 `coverageMissing`。

同一 block 内顺序执行：

- 左侧已接受 fragment 不可改写；
-其末尾进入下一 fragment 的 capped `previousActiveTail`；
- seam failure 只允许修复当前右侧 fragment；
- 一次 repair 后仍失败则 `human_required`。

memory candidates 按现有 sanitizer 去重；style observation 采用最后一个非空
fragment observation。最终仍以 whole-block validation 为准。

### 8.1 知识投影与执行变换

context planner 可以先在完整 canonical block 上选择知识 revision，但 paragraph
fragment 是一次会缩小真实 wire source 的执行变换。变换后必须以
`windowsForPrompt()` 产生的准确 source texts、corpus block positions 和 current
window positions 重新计算适用集合，并把原选择单调收窄到该集合：

```text
fragment selected revisions
  = planner selected revisions ∩ exact-wire applicable revisions
```

该步骤只能删除 revision，不能引入 planner 未选择的 revision；不存在的 revision ID
继续 hard fail，不能借“收窄”隐藏陈旧或损坏的调度决策。position-scoped narrative
memory 仍按 canonical block/window 位置判断，source-matched knowledge 则必须在该
fragment 的 target source 中实际匹配。preflight、token estimation 和真实 provider
prompt 必须复用同一 wire projection helper，禁止各自推导 source 范围。

这一约束关闭了 tx10 首次 resume 暴露的漂移：完整 14 段 block 中出现 `Brin`，
rich context 因而选择其 `lexical_concept`；前三个 fragment 中不含 `Brin` 的 unit
仍携带该选择，严格 prompt projection 正确报
`selected knowledge revision is not applicable`。修复后只有实际包含 `Brin` 的
fragment 保留该 revision。

### 8.2 Planner 与 wire projector 的共享容量

context profile planner 不得只按估算 token 选择 revision，再把条目数硬约束推迟到
prompt projector。每个知识 bundle 必须声明其 `entryCost`；当前一个 bundle 对应一个
revision，因此 cost 固定为 1。planner 的所有状态（包括 mandatory closure、dependency
closure、lean/balanced/rich 三档及独立 bundle 快速路径）都必须同时满足：

```text
selected token cost <= profile token budget
selected entry cost <= DEFAULT_TRANSLATION_KNOWLEDGE_MAX_ENTRIES
```

条目上限只从 knowledge projector 导出的同一常量读取，不允许 scheduler 复制一个
数字。wire projector 仍保留 entry/serialized-byte 的独立 hard check，作为不可信调用方
和未来变更的最后防线；它不应再成为正常 scheduler 选择首次发现容量冲突的位置。
如果 mandatory closure 自身超过上限，对应 profile 为不可行，不得选出超限 profile
后在 request build 阶段崩溃。

该约束关闭了 tx22 在 7/19 durable boundary 后的内部失败：lexical anchor 更新使下一
wave 出现超过 24 个适用候选，rich profile 只受 token 预算约束而选出全部候选，
`projectKnowledgeForTranslation()` 随后以
`selected knowledge revisions exceed entry budget` 拒绝。修复后 planner 在 dispatch
前即生成至多 24 个 revision 的合法 profile；已有 7 个提交窗口和完整 provider usage
可以按同一 run 安全 resume。

## 9. Repair credit

新增 window/recovery epoch 内存 credit：

```text
maxTargetedRepairsPerExecutionScope = 1
maxTargetedRepairsPerRequest = 3
maxParagraphRefinementsPerParagraphPlan = 1
```

shape collapse、assembly、transport idempotent replay 不消耗 targeted repair。
localized validation 或 seam repair 第一次实际发起模型 repair 时，只消耗当前
execution scope 的 credit；同一 scope 后续必须以 `repairEnabled=false` 执行。
其他独立 paragraph unit/refinement sub-unit 仍可使用自己的 credit，直到 request 的
三次硬上限。scope key 由 admitted request identity 或
`planId + executionUnitId` 派生，不能由模型输出决定。

paragraph refinement 是独立的结构恢复额度，不消耗 targeted repair；每个 canonical
block 的 paragraph plan 最多使用一次。一个 multi-block logical window 可包含多个互相
独立的 plan，因此合法执行图为“每 plan 最多一次”而不是整个 logical window 只允许
一次；这避免第一个 block 的 shape collapse 吞掉后续高风险 sibling 的唯一恢复机会。
refinement sub-unit 自身不携带下一层 refinement plan，但作为独立的、精确 source
scope 可使用一次 semantic repair；所有 sub-unit 仍共享 request 的三次总上限。

`runTranslationBatch()` 在识别明确 shape collapse 时不得先发 targeted repair；直接把
失败交回 worker 的 fragment route。这样结构恢复不提前消耗 semantic repair。

tx26 暴露了全 window 单 credit 的结构性缺陷：第一个 paragraph unit 的合法局部修复
用掉全局 credit 后，后续独立 unit 在 `Doctor Avrana Kern` 处提交了截断译文和
target 不存在的 receipts，系统只能报
`validation failed without targeted repair`。这不是同一失败的循环重试，而是不同
source scope 的独立内容失败。按 scope 隔离并设置 request 级三次硬上限，可以恢复这类
组合故障，同时仍保持有限状态空间。

## 10. Assembly 与最终校验

assembler 是纯函数，输入为 frozen plan 与已接受 fragment candidates。它必须检查：

1. planId、windowId、blockId、sourceHash、snapshotId 相同；
2. execution unit exact set；
3. paragraph ID exact cover；
4. 每段只出现一次；
5. canonical paragraph 顺序不变；
6. 所有 target paragraph 非空；
7. term receipts 无未知、重复或缺失；
8. 不包含 failed/partial candidate。

assembler 只产生一个 canonical candidate：

```ts
{
  blockId: canonicalBlockId,
  text: targetParagraphs.join("\n\n")
}
```

随后必须以完整 canonical block 重新运行：

- block set；
- paragraph count/length；
- untranslated prose；
- terminology/receipts；
- cross-block overlap；
- committed-neighbor boundary；
- snapshot/knowledge consistency。

只有最终校验通过的完整 logical window 才能交给现有 staging/commit。

## 11. 预算

保留两种指标：

```text
onePassWorkFloor
legalPolicyBaseline
hardCap = floor(legalPolicyBaseline * 1.10)
```

baseline 只能由版本化 recovery policy 计算，不接受 operator 直接输入。
paragraph plan 的 baseline 额外包含“候选原 unit 中最昂贵的一次完整单段 refinement
序列”；每个独立 plan 取最大一个，再对同一 logical window 的 plan 求和。主 translate
transaction 仍只 reserve direct plan，实际 refinement 通过独立 secondary transaction
reserve，避免同一 recovery reserve 被重复占用。

targeted repair baseline 取 direct units 与已 admission refinement sub-units 中
`totalReserved` 最大的三个 scope 之和。它只进入 run-level legal policy baseline，
不能作为 scheduler 的瞬时 `inFlightTokens`：三个 repair scope 顺序执行，把累计恢复图
当作并发 token 占用会让合法任务错误地产生 `NO_LEGAL_PLAN`。主 translate transaction
按 direct plan reserve，并在 settlement 中记录该 transaction 内实际发生的 repairs；
run-level hard cap 仍由包含 repair 图的 baseline 约束。

ExecutionWorker 内部的防循环 `BudgetLedger` 限额必须从已经 admission 的执行图派生，
不能继续使用与图无关的固定默认值。合法上界为所有 direct fragment 的 typed/framed
turn 与 tool-call 上界之和，再加每个 plan 最昂贵失败 fragment 的完整单段 refinement
子图；
`modelCalls`、`translationToolCalls` 和 `repairTurns` 还包含最多三次、每 scope
最多一次的 targeted repair。内部限额只防止实现越过已
批准图，不得反过来拒绝 admission 已批准的合法恢复路径。

V1 policy 的互斥分支：

```text
direct primary
  + max(
      bounded scoped repairs,
      complete paragraph fragment plan + bounded scoped repairs,
      one framed capability fallback
    )
```

高风险 block 使用：

```text
complete paragraph fragment plan
  + up to three scoped localized repairs
```

同一路径上的调用求和，互斥分支取 max。target oracle 使用固定 token 上限，运行时超过
上限必须截断 context，不能扩大 reserve。

ledger 的 secondary transaction 以整个 fragment plan 为原子；其中每个真实 provider
call 的 usage 逐次捕获并汇总。对于顺序 fragment plan：

- policy baseline 在首次 dispatch 前包含整个 plan 的 reserve；
-整个 plan 只 reserve/dispatch/settle 一次；
-失败后未发车 fragments 不产生 usage；
-继续条件为 `settledActual + openReservations + Need(nextState) <= hardCap`；
-unknown usage 立即阻断后续 fragment；
-settlement 包含成功 fragment、失败 fragment 和最多三次 scoped repair 的全部
  actual usage。

## 12. Raw provider evidence

每次 provider 调用在 protocol/content 分类前记录：

- attempt/request/provider response ID（若有）；
- model、finish/stop reason；
-完整 usage；
- request hash、response hash；
-assistant raw message/tool arguments；
-协议版本、executionUnitId、snapshotId；
-evidence sidecar locator。

不重复保存 system/user prompt、Authorization、cookie、API key 或 source body。
assistant raw response 允许包含译文，因为它正是判定 model collapse、tool truncation 或
adapter loss 的必要证据。

实现复用现有 `events` 和 token ledger：

- metadata/ref 写 append-only event；
-raw assistant evidence 写 `book.db` 同级 `evidence/<run-id>/<hash>.json.gz`；
-先临时文件、fsync/close、atomic rename，再写 SQLite event；
-同 project/run 内按 response hash 去重；
-项目删除时 evidence 随项目目录删除。

`modelCallOrdinal` 以有序收集到的 assistant response 序列为唯一事实来源，即记录第
N 个 response 时写 N；不得读取可能已经被下一次 `turn_start` 改写的可变启动计数器。
事件乱序到达时仍必须得到严格递增的 `1, 2, ...`，不得出现重复 ordinal 或 `0`。

无需新增关系表。

## 13. Resume、并发与 fencing

- fragment plan 与 snapshot 绑定；
- worker 只接受当前 window epoch 和当前 lease 的结果；
-late/stale response 可以 settle 和审计，但不能加入 candidate；
-同一 block 内至多一个 fragment attempt 在飞；
-不同 windows 可继续由现有 scheduler 并行；
-resume 若发现 dispatched 未终结 attempt，沿既有 conservative settle/fail-closed
  规则处理，不从 partial fragment 推断成功；
-V1 不持久化可续跑 fragment frontier；崩溃后该 logical window 以新 epoch 重新执行
  完整 plan，已提交的其他 windows 不变。

## 14. 实施顺序

### Change Set 1：Attempt identity、evidence 与 ledger spine

- framed nonce 由 admitted input 生成并复用；
- `PiRuntime` 完成一次 provider response 后、业务解析前触发 evidence callback；
- store 写 gzip sidecar 和 metadata event；
-测试 provider success、protocol reject、provider error、duplicate response hash。

### Change Set 2：Protocol Adapter v2

- normal typed 与 fragment typed 复用既有 exact schema；fragment 的段落身份由单次
  调用的本地 contract 唯一绑定；
- framed nonce 128-bit random；
-删除 near-match/错误 ID 自动纠正进入 strict path 的可能性；
-错误 nonce、unknown paragraph、context-only output 均为 hard failure。

### Change Set 3：纯 Paragraph Planner/Assembler

-无 provider 调用；
-deterministic plan、gap/overlap、mixed snapshot、out-of-order、exact-cover 性质测试；
-不触及 DB/commit schema。

### Change Set 4：Policy baseline 与 admission

-计算 direct 与 fragment-first policy；
-target tail 固定上限；
-boundary、差一 token、actual 超 reserve、unknown usage 测试。

### Change Set 5：ExecutionWorker FSM

-高风险 fragment-first；
-shape collapse → fragments；
-provider protocol → framed；
-每 execution scope 一次、每 request 最多三次 repair credit；
-同 block 顺序、跨 window 并行；
-最终 canonical validation。

### Change Set 6：Commit/release gate 与 fault harness

-fragment/partial 不能触达 commit；
-crash、late response、stale epoch、duplicate attempt、mixed snapshot；
-tx7/tx8 fixtures；
-strict release gate 报告。

## 15. 验收标准

代码级：

- wrong nonce accepted = 0；
- unknown/duplicate paragraph accepted = 0；
- partial logical commit = 0；
- duplicate logical commit = 0；
- mixed-snapshot assembly = 0；
- unknown usage at release = 0；
- budget cap violation = 0；
- shape collapse routed to framed = 0；
- fragment 段落边界从 typed paragraph vector 读取，不从译文空行猜测；
- fragment failure 最多进入一次有预算的单段 refinement，且聚合回原 unit identity；
- 多 block logical window 中的高风险 block 可独立分片，普通 sibling 不丢失、不重复，
  最终仍只产生一个 logical-window commit；
- 单窗口 metadata envelope 可确定归一化，多窗口或冲突归属被拒绝；
- occurrence lexical boundary 逐匹配位置判定，block-global token membership 不参与；
- preferred/contextual receipt 可记录安全的实际译法，但 locked surface 仍严格；
- internal BudgetLedger 能覆盖 admission 已批准的 direct + one-refinement 图；
- provider evidence ordinal 从 response 序列派生且严格从 1 递增；
- revalidation replacement 对 exact source occurrence 保持一条 active binding，
  即使 contextual/preferred receipt 合法省略；
- 完成 revalidation 后 `coverageMissing` = 0；
-新 run 中 `warning_stale` = 0。

英文 100K 前：

1. planner/assembler property tests、protocol tests、ledger conservation、
   crash/replay、commit exactly-once、tx7/tx8 fixture 全通过；
2. corpus dry-run 为每个 window 固定 policy hash、baseline 和 direct/fragment-first
   决策；
3. 覆盖最长、段落最多、术语密集和 tx8 类 block 的 5%–10% canary；
4. canary 必须 100% usage complete、0 partial/duplicate commit、0 stale、
   0 internal invariant、0 budget overrun；
5. canary 中任何 `human_required` 必须先分类并关闭原因，不能直接扩大到 100K。

只有英文全新数据库达到 19/19、knowledge converged、actual ≤ allowed、
usage complete、strict exportable，并重新通过全部代码门禁后，才允许更新版本、
tag、上传和 release。

## 16. 2026-07-30 implementation amendments

These amendments supersede any earlier leaf-schema or coverage wording that
conflicts with them.

### 16.1 Invocation-owned scalar leaf

Once recovery reaches one source paragraph, the provider-visible
`finalize_paragraph_fragment` schema contains exactly one field:

```json
{ "text": "complete target paragraph" }
```

`windowId`, `blockId`, `paragraphId`, snapshot identity, and execution lineage
belong to the immutable host invocation. They are not emitted by the model and
cannot participate in routing. The host lowers the scalar text into the common
batch candidate shape. The leaf emits no notes, term receipts, memory
candidates, or style observation; deterministic receipt completion and the
whole-block validator remain authoritative. This reduces the terminal recovery
state space without weakening semantic validation.

### 16.2 Coverage binding is independent from an optional receipt

For every exact source occurrence projected into a staged translation,
storage materializes one translation/concept binding:

- a submitted and validated receipt is stored when present;
- a legally omitted `preferred` or `contextual` receipt produces a clean
  binding with an empty receipt array;
- an omitted `locked` receipt fails staged validation;
- concepts without an exact source occurrence receive no binding.

Receipt validation, coverage materialization, staged translations, and staged
knowledge candidates share the same transaction. Therefore strict audit cannot
report `coverageMissing` merely because a soft term used a natural target
variant.

### 16.3 Pro consultation disposition

The reviewed architecture remains monotone: whole request → paragraph vector
→ scalar leaf. The scalar leaf and its identities follow the consultation's
out-of-band ownership recommendation. A shallower one-array multi-paragraph
wire shape remains a future efficiency hardening, not a release correctness
dependency, because ambiguous multi-paragraph structure already fails closed
and deterministically descends to the scalar terminal protocol.

## 17. Durable identity for secondary recovery attempts

Every provider attempt charged to the token ledger, including repair,
protocol-switch, context-split, and paragraph-fragment work launched inside an
execution worker, must receive its identity from the run-owned durable ledger
allocator.

Process-local retry counters and charge ordinals may form an operation stem,
but they are not sufficient attempt identities: both reset after a restart.
The allocator must reject both open and terminal request IDs and append a
monotonic `recovery-N` suffix when the same logical operation is replayed.

This preserves two independent properties:

- the logical recovery topology remains deterministic;
- every physical provider attempt remains unique and auditable across process
  interruption and resume.

Acceptance requires a regression that executes the same paragraph-recovery
operation after its prior ledger attempt is terminal. The replay must complete
without a reservation collision, and the two paragraph-fragment reservations
must have distinct IDs, with the replay carrying a recovery suffix.

## 18. Revalidation uses the shared execution reliability boundary

Knowledge revalidation remains a distinct operation and commit protocol, but it
must not call the provider directly. After it has captured the immutable source
block, source hash, active translation, and target knowledge snapshot, it admits
one single-block translation operation and delegates provider execution to
`ExecutionWorker`.

The shared worker owns:

- whole-block typed execution;
- bounded targeted repair;
- whole-to-paragraph-vector degeneration;
- invocation-owned scalar refinement;
- deterministic paragraph assembly;
- provider evidence and durable secondary-attempt identity.

Revalidation continues to own:

- stale source/snapshot rejection;
- validation against committed neighboring translations;
- the atomic replacement of the prior active translation;
- revalidation task status and convergence.

Committed-boundary validation is attached only to the original whole request
and to the final assembled candidate. It must not run against an intermediate
paragraph fragment, because a partial paragraph result cannot satisfy a
whole-block boundary contract.

The revalidation parent ledger attempt has purpose `revalidate` and accounts
only for provider runs not already charged by a secondary worker transaction.
Paragraph recovery, protocol switching, context splitting, and repair
transactions retain their actual purposes and settle independently. The parent
therefore uses `accountingUsage`, while operation telemetry uses total `usage`;
the two must never be added together as debits.

### 18.1 Complete paragraph-degradation reserve

Admission must expose a finite reserve for the complete legal degradation
graph, including a request that starts as a whole block and later descends:

```text
direct execution
+ paragraph-vector recovery
+ at most one scalar-refinement level per paragraph plan
+ at most three scoped targeted repairs
```

`paragraphRecoveryReserveTokens` covers the paragraph-vector recovery calls and
their legal scalar-refinement level. It is distinct from
`paragraphRefinementReserveTokens`, which covers refinement of an operation
that was paragraph-fragmented at initial admission. Targeted-repair reserve is
computed from both the initially admitted fragments and the pre-assessed
paragraph-recovery candidates.

When primary and escalation runtimes differ, the policy baseline uses the
larger direct, paragraph-recovery, refinement, and repair components. The
instantaneous scheduler variant remains the work being launched now; sequential
fallback reserve must not be misreported as concurrent in-flight usage.

### 18.2 Required regression

A five-paragraph revalidation fixture must reproduce a valid provider session
whose whole-block tool submission collapses to one short translation. Before
the integration it must exhaust two outer revalidation attempts and finish
`completed_with_warning`. With the integration it must:

- reserve a `revalidate` parent attempt;
- descend through a separately charged `paragraph_fragment` attempt;
- use the text-only scalar tool for a one-paragraph terminal unit;
- assemble all five source paragraph identities exactly once;
- pass committed-boundary validation only after assembly;
- atomically resolve the revalidation task without a warning;
- keep the revalidation policy baseline no smaller than the admitted parent and
  paragraph-recovery reservations.

The Pro consultation agreed with this boundary: reuse worker reliability while
keeping replacement semantics and atomic visibility in revalidation. Its
broader per-invocation ledger hierarchy is retained as a future ledger
normalization; the current parent-accounting/secondary-accounting split is safe
because each provider run has exactly one charging owner and is regression
checked against double charging.
