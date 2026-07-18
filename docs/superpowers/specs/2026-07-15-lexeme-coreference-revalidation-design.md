# 词形共指收束与精确重验设计

日期：2026-07-15
状态：已批准
目标分支：`feature/parallel-v4-v2`

## 1. 背景与问题证据

《新日之书》全量预扫描完成后，数据库中出现 15 组同一标准化英文词形指向两个活动概念的情况。典型例子包括：

- `Briah` 分别被登记为 `concept` 和 `place`；
- `Chatelaine` 分别被登记为 `title` 和 `person`；
- `Malrubius and Triskele` 的 `split` 裁决没有复用已有的 Malrubius 与 Triskele 概念；
- `II The Fleshing` 在正文标题和目录中分别建档；
- `Venant` 在同一段原文中分别被判断为 `place` 和 `person`。

这些碰撞没有立即造成中文译名冲突：相同词形的两个非空译名目前均相同，其余碰撞为一条有译名而另一条为空，或两条都为空。但证据、关系和依赖已经被分散到不同概念；更长小说中继续累积后会产生译名漂移和关系图断裂。

现有实现存在三个直接根因：

1. `_ensure_automatic_concept()` 以 `(normalized_form, entity_kind)` 寻找或创建概念。模型只要对类型判断不同，就会得到不同概念 ID；
2. 裁决阶段同时承担“确认原文词形”和“确定故事中的指称身份”两项职责，`split` 和独立候选簇会分别创建概念；
3. 概念建立后没有全书级共指收束阶段。

现有 `needs_revalidate` 机制也存在两个粒度问题：

1. `_invalidate_working_target_dependents()` 会扫描所有 `ready` 或 `translating` 块，只要原文命中新词形就把块标为 `needs_revalidate`。本次产生的 36 个该状态块全部没有活动 `parallel_v4` 译文或翻译依赖，本质上是未翻译的 `ready` 块；
2. 翻译运行以整份知识快照签名判断陈旧。任意无关概念变化都可能令同一运行已经完成的所有译文进入重验，无法利用现有的块级依赖。

## 2. 目标与非目标

### 2.1 目标

本轮改造必须实现：

1. 把“英文词形及其默认译法”与“故事中的实际指称”分离；
2. 类型分歧不再自动制造不同概念；
3. 对确定性重复自动归并，对可能同名异物进行双模型共指判断；
4. 两个模型冲突或均不确定时，流程仍可无人值守完成；
5. 人工队列成为可选审阅层，不再是自动流程的完成条件；
6. 只有已有活动译文且有效翻译知识发生变化的块才进入重验；
7. 通过定向验证、局部修复和整块重翻的分级机制自动清空重验任务；
8. 知识变更、概念归并、译文失效、修复和兜底均可审计、可恢复、幂等；
9. 删除“每个概念正则扫描全书”的失效路径，使超长篇成本由实际出现次数决定；
10. 保留现有证据、旧译文版本、人工锁定和严格结构校验。

### 2.2 非目标

本轮不要求：

- 把文学歧义、身份谜题或象征解释裁决为唯一真相；
- 为所有单次出现的普通词建立故事实体；
- 仅凭同词形无条件合并同名人物；
- 在数据库中保存完整剧情时间线或人物关系网；
- 对每次知识变化都立即重翻全部命中段落；
- 以静默接受结构错误的方式保证自动完成。

## 3. 方案选择

本设计采用“词形层与实体层分离，配合精确重验”的方案。

仅把现有概念键改成标准化词形虽然改动小，但会错误合并真正的同名人物；完整事件溯源知识图谱虽然表达力更强，但超出当前翻译系统所需范围。词形层能够保证译名稳定，实体层能够保留同名异物与身份不确定性，是自动化、安全性和实现成本之间的合适平衡。

新的主流程为：

```text
本地候选提取
  → 候选裁决：确认词形和是否值得翻译记忆
  → lexeme 写入与类型观察
  → 共指收束：把提及绑定到 concept，或保留为未决 lexeme 提及
  → 工作译名解析
  → 冻结知识纪元并翻译
  → 批量应用新知识
  → 精确影响计算与自动重验
  → 导出正文和质量报告
```

## 4. 词形层、实体层与类型观察

### 4.1 `lexemes`

新增 `lexemes` 表，以 `(language, normalized_form)` 作为活动记录的唯一键：

```text
id
language
normalized_form
canonical_form
default_target
working_target
verified_target
status
locked
created_version
retired_version
created_at
```

`lexeme` 表示“原文中的这一词形家族及其默认中文表达”，不承诺它只对应一个故事实体。默认工作译名和词形级语境规则归属于 lexeme。两个名叫 John 的人物可以共享 lexeme `john → 约翰`，而保持为两个不同 concept。

活动 lexeme 使用稳定 ID：

```text
stable_id("lexeme", language + ":" + normalized_form)
```

同词形重跑、大小写变化、目录与正文重复不得创建第二个活动 lexeme。

### 4.2 `concepts`、`concept_lexemes` 与提及绑定

概念表示故事中的一个实际指称或一个已确认的术语义项。`concepts` 增加可空的 `primary_lexeme_id` 和不可变的 `anchor_mention_id`。现有 `kind` 保留为当前首选类型，供兼容查询使用，但不再参与概念身份生成。

新概念 ID 使用 lexeme ID 与最早的不可变锚点提及 ID 生成。后续增加提及不会改变概念 ID；概念归并通过 redirect 完成，不重写历史 ID：

```text
stable_id("concept", lexeme_id + ":" + anchor_mention_id)
```

新增多对多关联表 `concept_lexemes`：

```text
concept_id
lexeme_id
role: primary | alias | title | uncertain
confidence
status
evidence_id nullable
created_version
retired_version nullable
created_at
primary key (concept_id, lexeme_id, role, created_version)
```

这样同一人物未来可以拥有本名、头衔和别名等多个 lexeme，而同一个 lexeme 也可以对应两个真正同名的 concept。`primary_lexeme_id` 只是快速读取路径，真实关联以 `concept_lexemes` 为准。

表上增加活动记录部分唯一索引 `(concept_id, lexeme_id, role) WHERE retired_version IS NULL`，防止知识版本更新产生重复活动关联。

`mentions` 增加非空 `lexeme_id`，`concept_id` 继续可空；`candidate_resolutions` 增加 `lexeme_id`，其 `concept_id` 只有在共指收束后才填写。现有 `source_forms` 从 concept 所有权迁移到 lexeme 所有权，保存大小写、所有格等原文表面变体；跨标准化词形的别名关系通过 `concept_lexemes` 表达。

概念 ID 只在共指收束阶段创建；候选裁决本身不再因为一次 `promote` 或 `split` 立即创建概念。未完成共指判断的提及只有 `lexeme_id` 而没有 `concept_id`，仍可获得全局工作译名并进入翻译。

同一个 lexeme 下允许存在多个 concept，但必须满足至少一项：

- 有活动 `different` 共指裁决；
- 有人工锁定的不同身份；
- 尚处于显式 `uncertain_coreference` 状态，并且提及没有被错误绑定到多个 concept。

### 4.3 `concept_type_observations`

新增类型观察表：

```text
id
concept_id nullable
lexeme_id
mention_id nullable
evidence_id nullable
kind
confidence
source
adjudication_id nullable
created_version
retired_version nullable
created_at
```

`place`、`concept`、`title`、`person` 等判断作为证据观察保存。类型分歧可以并存，不得单独触发新概念创建。例如 Briah 可以同时具有 `place` 和 `concept` 两条观察，而只保留一个指称。

### 4.4 词形级与概念级译法

渲染优先级固定为：

1. 人工锁定的 occurrence/speaker/thread 规则；
2. 已核验的 concept 义项覆盖；
3. 已核验的 lexeme 规则；
4. concept 工作覆盖；
5. lexeme 工作译名和规则；
6. 无规则时由翻译模型按普通语境处理。

`rendering_rules` 通过重建表支持两个可空外键 `lexeme_id` 与 `concept_id`，并以 `CHECK ((lexeme_id IS NULL) != (concept_id IS NULL))` 保证每条规则恰好属于一种主体。这样继续保留 SQLite 外键约束，不使用无法校验的通用字符串主体。concept 覆盖只在已有可靠的不同义项证据时建立；共指未决时默认使用 lexeme 译名，保证无人值守翻译仍保持一致。

## 5. 共指收束

### 5.1 确定性收束

下列情况在协调器事务内直接复用或归并，不调用模型：

1. 同一活动源版本中，块 ID、原文起止偏移和标准化词形完全相同；
2. 断点恢复或重跑产生相同候选/证据哈希；
3. `split` 选中的词形已存在唯一的人工锁定或已核验 concept；
4. 目录与正文具有完全相同的标准化标题指纹，且双方均为标题/作品观察；
5. 一条记录的全部提及与另一条记录具有相同锚点，或只是另一条提及集合的重复子集，双方差异仅为低证据类型观察；
6. 已存在 `concept_redirect` 指向活动 concept。

确定性规则不得仅凭同词形合并两个已经有不同人物锚点的概念。

### 5.2 双模型共指判断

只有以下碰撞组调用共指模型：

- 同一 lexeme 下存在两个或更多 provisional concept；
- 同词形提及出现互不兼容的类型观察；
- 候选需要绑定到已有 concept，但确定性规则无法证明同一性；
- 目录/正文、头衔/人物、天体/地点等边界情况无法由规则完成。

每个请求最多包含该 lexeme 下的有限提及集合，使用短 ID；语境选择为：最早出现、最近出现、类型分歧语境、共现实体差异最大的语境。模型只能返回：

```text
same
different
uncertain
non_entity
```

并必须引用提供的提及短 ID。两个独立客户端读取相同的冻结证据快照，不共享第一轮结论。

### 5.3 双模型合并规则

- 两者均为 `same`：自动合并；
- 两者均为 `different`：保留不同 concept；
- 两者均为 `non_entity`：不创建 concept，保留 lexeme 或语境规则；
- 任一为 `uncertain`，或两者结论冲突：记录 `uncertain_coreference`，不强制合并，也不阻塞翻译；
- 模型协议失败：有限重试后按 `uncertain_coreference/model_protocol_failure` 处理；
- 人工锁定关系不得被模型覆盖。

未决组的共同词形仍使用 lexeme 工作译名。若存在多个候选译名，优先级为：人工锁定、双重核验、旧有一致译名、受影响块多数票、稳定词典排序。最终选择及不确定性必须写入审计；不得因无法选择而暂停自动流程。

### 5.4 `coreference_decisions`

共指结论持久化为：

```text
id
lexeme_id
left_anchor_type: concept | mention_set
left_anchor_id
right_anchor_type: concept | mention_set
right_anchor_id
relation: same | different | uncertain | non_entity
decision_source: deterministic | dual_model | human
confidence
locked
votes_json
evidence_ids_json
anchor_members_json
payload_hash
created_version
retired_version nullable
created_at
```

`mention_set` 是同一候选簇或相同不可变锚点形成的有界提及集合，其 ID 由排序后的不可变 mention ID 生成；`anchor_members_json` 保存这些 ID，不复制原文。左右锚点按稳定排序保存，使相同案件拥有唯一 payload hash。提交前必须校验所有 concept 和 mention ID 仍然存在且属于该 lexeme。人工决定写为 `locked=1`；自动重跑只能复用，不能覆盖。

### 5.5 归并事务

新增 `concept_redirects`：

```text
retired_concept_id primary key
canonical_concept_id
reason
knowledge_version
created_at
```

归并时的 canonical concept 选择顺序为：人工锁定、已核验、具有有效译名、依赖和提及数更多、创建时间更早、ID 字典序。一个事务内完成：

1. 转移 source forms、mentions、candidate resolutions、类型观察和关系；
2. 把旧依赖重定向到 canonical concept；
3. 处理渲染规则：完全一致的规则去重，冲突规则降为未决候选，不静默覆盖；
4. 写入 redirect；
5. 退休旧 concept，但不删除证据和历史译文；
6. 写入知识变化事件；
7. 只有有效渲染结果变化时才产生重验任务。

concept ID 变化但有效译名、规则和命中语义均相同，不得使译文失效。

## 6. 原文词形位置索引

新增 `form_occurrences`：

```text
lexeme_id
block_id
start_offset
end_offset
source_form
source_hash
created_at
primary key (lexeme_id, block_id, start_offset, end_offset)
```

本地扫描和候选裁决负责写入准确原文偏移。新别名或新 lexeme 生效时，只查询对应 occurrence，不再为每个概念正则扫描所有文本块。

若新的 lexeme 或别名在初始扫描时尚不存在，检查点协调器把本批新增词形编译成一次多模式匹配器，对活动源版本执行单次批量回填；禁止为每个新词形分别遍历全书。回填完成后同样写入并校验 occurrence，再进行影响计算。

位置索引写入前必须验证：

```text
source_text[start_offset:end_offset] == source_form
```

源版本变化时旧 occurrence 随源版本失活，不跨版本复用偏移。

## 7. 知识变化与精确依赖

### 7.1 `knowledge_changes`

每个可能影响翻译的知识提交写入：

```text
id
knowledge_version
subject_type
subject_id
change_kind
old_fingerprint
new_fingerprint
impact_level
payload_json
created_at
```

指纹只包含会进入翻译提示或渲染匹配的有效状态。描述、类型观察、证据数量等元数据变化不进入渲染指纹，因此属于影响等级 0。

### 7.2 翻译依赖细化

现有 `dependencies` 保留反向索引，并增加：

```text
dependency_fingerprint
matched_form
occurrence_count
rendered_target
applied_rule_ids_json
source_spans_json
```

每个译文版本记录它实际命中的 lexeme、concept、rule 和 claim，以及当时有效渲染指纹。JSON 字段只保存当前块内的有限偏移，不保存重复原文。

新 lexeme 或新别名在旧译文中没有依赖时，通过 `form_occurrences` 查找包含该词形的已翻译块，补充进入影响计算。

## 8. 重验状态模型

### 8.1 状态分离

`needs_revalidate` 不再作为 `blocks.status` 的持久状态。块状态继续表示正常翻译生命周期：`pending/scanned/ready/translating/completed/completed_with_warnings/...`。

活动 `translation_versions` 增加：

```text
validation_status: clean | pending | validating | warning_stale
validated_knowledge_version
validation_fingerprint
```

外部 `status-v4` 仍可显示 `needs_revalidate`，但该数字由活动重验任务推导，避免未翻译块进入该状态。

### 8.2 `revalidation_tasks`

新增：

```text
id
translation_id
block_id
from_knowledge_version
to_knowledge_version
change_set_hash
impact_level
status
action
attempts
result_json
replacement_translation_id nullable
error nullable
created_at
resolved_at nullable
```

`status` 为：

```text
pending
validating
resolved_noop
resolved_patch
resolved_retranslate
completed_with_warning
```

`UNIQUE(translation_id, change_set_hash)` 保证断点恢复和重复知识提交不会创建重复任务。同一活动译文的多个待处理变化在执行前合并为一个任务，并把目标知识版本提升到当前稳定版本。

### 8.3 创建任务的硬条件

只有同时满足以下条件才创建任务：

1. 存在活动 `parallel_v4` 译文；
2. 译文状态为 `completed` 或 `completed_with_warnings`；
3. 实际依赖指纹变化，或新的词形 occurrence 命中该块；
4. 新旧有效渲染状态不同。

未翻译的 `ready` 块、没有活动译文的块、只发生元数据变化的概念，任务数必须为 0。

## 9. 影响等级与自动重验

知识变化分级固定为：

| 等级 | 变化 | 自动动作 |
|---|---|---|
| 0 | 类型、描述、证据或同义元数据变化，渲染指纹不变 | 直接记录 `resolved_noop` 或不创建任务 |
| 1 | 默认工作译名变化，且没有条件规则或身份变化 | 定向验证；必要时局部修复 |
| 2 | 条件规则、概念归并/拆分、称呼功能或义项覆盖变化 | 双模型检查；决定无影响、局部修复或整块重翻 |
| 3 | 人工锁定、高影响约束、揭示边界变化，或低级处理无法达成一致 | 整块重翻 |

定向验证模型收到：当前块原文、活动译文、旧有效规则、新有效规则、精确命中位置和变化原因。它只能返回：

```text
no_effect
patch_required
retranslate
uncertain
```

等级 2 使用两个独立验证调用：

- 两者均为 `no_effect`：关闭任务，不生成新译文版本；
- 两者均认为可以局部修复：调用一次修复器，生成完整的新块译文并运行确定性完整性校验；
- 任一要求重翻、两者冲突、任一不确定：自动升级为整块重翻；
- 模型协议失败或重试耗尽：自动升级为整块重翻，不进入阻塞人工队列。

局部修复不得直接在旧中文字符串上进行无语境替换。修复器必须返回完整块译文，旧版本保留，结构校验通过后才切换活动版本。

## 10. 整块重翻与无人值守兜底

整块重翻使用当前稳定知识版本和正常两层翻译器，产生新的 `translation_versions` 记录。原活动版本在新版本通过完整性校验前保持活动。

自动模式的终止路径固定为：

1. 定向验证冲突或失败，升级整块重翻；
2. 整块重翻结构失败，按现有限次重试；
3. 重试耗尽、模型服务不可用、上下文或外部预算硬限制触发时，不接受不完整新译文；
4. 保留旧译文为活动版本，设为 `validation_status=warning_stale`；
5. 重验任务标记 `completed_with_warning`，写入质量报告和可选人工队列；
6. 调度器继续处理后续任务并正常结束，运行结果为 `completed_with_warnings`。

因此“自动跑完”表示流程必然收敛到已解决或明确带警告的终态，不表示在外部服务彻底不可用时伪造一份新译文。

人工队列默认不暂停自动运行。仅在显式配置 `pause_on_review=true` 时，交互模式可以在检查点暂停；模型冲突本身不得隐式打开该开关。

## 11. 知识纪元与收敛

翻译使用知识纪元避免长篇中反复失效：

1. 全书扫描、候选裁决、共指收束和工作译名解析完成后冻结 K0；
2. 每个工作波读取同一冻结纪元；
3. 翻译线程提出的新词和关系先写入 staging，不立即改变活动渲染知识；
4. 到卷边界或固定块数检查点时，协调器批量裁决并应用建议，产生 K1；
5. 使用变化事件和反向依赖一次性创建、合并重验任务；
6. 新纪元用于后续块，前面受影响的块进入重验队列；
7. 重验产生的新建议只进入下一纪元，不在当前重验排空过程中递归生效。

默认最多三个自动知识纪元。达到上限后，新的非锁定建议留在 staging 并进入可选审阅报告，不再改变本次运行的活动知识。该上限保证无人值守运行不会因模型不断提出新知识而振荡。

当前“全局知识签名变化则令整个运行失效”的逻辑改为提交时的块级差分：

- 当前块依赖及源词形均未受影响时，译文正常提交；
- 依赖在工作波执行期间变化时，译文提交后只为该块创建重验任务；
- 无关概念变化不得令本运行其他块失效。

## 12. 自动模式、交互模式与导出

配置明确区分：

```text
decision_mode: auto | interactive
pause_on_review: false | true
unattended_failure_policy: finish_with_warnings
max_knowledge_epochs: 3
```

默认值为 `auto/false/finish_with_warnings/3`。人工队列在两种模式中都可查看和覆盖自动决定，但只有显式 `pause_on_review=true` 才能暂停运行。

自动导出允许包含 `warning_stale` 的旧活动译文，但必须：

- 在质量报告中列出块、知识变化、失败原因和旧知识版本；
- 在运行摘要中给出带警告块总数；
- 不把警告版本声称为已通过最新知识校验。

严格模式可以拒绝带警告导出，但不是无人值守默认值。

## 13. 现有数据库迁移

目标 schema 版本为 8，迁移必须先支持预览和备份。

迁移步骤：

1. 按活动 `source_forms.normalized_form` 创建唯一 lexeme，并把 `source_forms` 重建为 lexeme 所有；
2. 汇总现有 working/verified/locked target。目标完全一致时迁移到 lexeme；有冲突时按人工锁定、已核验、受影响块票数和稳定排序自动选择，并把冲突写入审计和可选审阅；
3. 把现有 concept.kind 转成类型观察，为 mentions 和 candidate resolutions 回填 lexeme ID，并建立 concept_lexemes 关联；
4. 对同词形活动概念运行确定性规则和双模型共指收束；
5. 归并时写入 redirect，不删除 evidence、audit、旧 translation version；
6. 迁移 rendering rules、mentions、resolutions 和 dependencies；
7. 为活动源版本建立 form occurrence 索引并校验全部偏移；
8. `blocks.status=needs_revalidate` 且没有活动译文的块恢复为 `ready`；
9. 有活动译文的旧 `needs_revalidate` 状态转换成重验任务；
10. 运行完整性、外键、依赖指纹、规则冲突和可读审计检查后才提交迁移。

迁移中任何结构异常必须整体回滚。模型不确定性只影响共指关系状态，不得令迁移事务处于半完成状态。

## 14. CLI、状态与审计

新增或扩展命令：

```text
coreference-v4 BOOK_ID
revalidate-v4 BOOK_ID
status-v4 BOOK_ID
migrate-v4 --preview
```

`prepare-v4` 顺序更新为：

```text
scan → adjudicate → coreference → resolve targets
```

运行摘要至少返回：

- lexeme 数、活动 concept 数；
- 确定性归并数、模型归并数、明确分离数、未决组数；
- 共指模型调用、冲突、协议失败和自动兜底数；
- 重验任务按影响等级和终态的数量；
- `resolved_noop/patch/retranslate/completed_with_warning` 数；
- 当前知识纪元、达到纪元上限时冻结的建议数；
- 可选人工队列数量，但不得把它计为未完成任务。

所有模型调用保存请求证据、冻结知识版本、原始响应、结构化结果、耗时、重试和接受状态。确定性归并、redirect、重验无影响判断和警告兜底也必须保存无模型审计事件。

## 15. 性能与存储约束

1. 共指比较只在同一 lexeme 的碰撞组内进行，不允许全概念两两比较；
2. 相同证据快照和模型配置使用 payload hash 缓存，不重复调用；
3. 高频词形只发送最早、最近、类型分歧和离群语境，保持固定上下文预算；
4. 影响查询必须使用 dependencies 和 form_occurrences 索引；
5. 禁止按“变化概念数 × 全书块数”执行正则扫描；
6. 重验任务按 translation ID 和 change-set hash 合并；
7. 审计正文继续写入可寻址压缩归档，不回填活动 SQLite 大字段；
8. 所有新增表计入现有每书动态存储预算。

规模测试必须覆盖至少三百万源词量级的合成项目，证明本地共指候选生成和影响定位随实际 occurrence 数增长，不随 `concept_count × block_count` 增长。真实模型总耗时单独报告，不作为 SQLite 算法复杂度的替代证明。

## 16. 测试与验收

### 16.1 概念与共指

1. 同一块、同一偏移、同一词形不得绑定到两个活动 concept；
2. 类型变化不得单独创建新 concept；
3. `split` 遇到已有 Malrubius/Triskele 时复用已有 lexeme 和可靠 concept；
4. 目录与正文相同标题只建立一个 lexeme，不重复创建标题 concept；
5. 两个同名但有明确不同人物锚点的 John 保持两个 concept；
6. 两个 concept 即使共指未决，也继承同一 lexeme 默认译名；
7. 双模型冲突产生 `uncertain_coreference`，不产生阻塞人工任务；
8. `Goodman` 类普通称呼可以被判为 `non_entity`，而不删除原始证据；
9. 人工锁定的 same/different 关系不能被模型覆盖；
10. 归并后旧 ID 可经 redirect 找到 canonical concept，旧审计仍可读取。

### 16.2 精确重验

1. 没有活动译文的块永远不会产生重验任务；
2. 现有 36 个误标块迁移后均恢复 `ready`；
3. 类型或描述变化、译名未变时影响块为 0；
4. 重复写入相同工作译名时不创建知识版本或重验任务；
5. 默认译名变化只影响具有相应依赖或新 occurrence 命中的已翻译块；
6. 无关概念变化不会使整个翻译运行失效；
7. 双验证模型冲突自动升级整块重翻；
8. 局部修复必须生成完整新块并通过段落、完整性和术语校验；
9. 重翻失败保留旧活动版本并进入 `completed_with_warning`，调度器继续；
10. 多项知识变化对同一译文只产生一个合并任务；
11. 中断后重跑不重复模型调用、任务或译文版本；
12. 达到知识纪元上限后运行稳定结束，未应用建议进入可选报告。

### 16.3 数据与回归

- SQLite `integrity_check=ok`，外键检查为 0；
- 所有 form occurrence 偏移与原文一致；
- 所有接受的模型审计归档可按定位器和校验和读取；
- 旧串行项目、外部 DOCX 基线、盲评、局部修复和导出测试继续通过；
- `Drotte and Roche` 不成为单一人物；
- `Corpse`、`Corpse Door`、`Night` 回归约束继续成立；
- `Severian` 保持唯一默认工作译名；
- 当前 15 组碰撞迁移后不得继续以“无 same/different/uncertain 关系的两个活动 concept”存在；
- 完整测试套件通过，外部密钥测试继续单独运行和报告。

## 17. 实施边界与顺序

实现拆成三个可独立验收的阶段：

1. **词形与共指基础层**：schema 8、lexeme、类型观察、redirect、确定性和双模型共指；
2. **精确重验层**：知识变化、依赖指纹、occurrence 索引、任务状态机和自动升级；
3. **调度与迁移层**：知识纪元、无人值守终态、现有数据库迁移、CLI/UI/导出报告。

每一阶段必须先通过独立单元测试和合成规模测试，再在 `new_sun_omnibus` 的备份数据库上迁移验证。不得直接在唯一活动数据库上试验 schema 迁移。

本设计批准后，下一步只编写实现计划；实现计划批准前不修改生产代码或活动数据库。
