# 叙事记忆融合与动态并行翻译设计

日期：2026-07-16
状态：已实现并通过回归
目标分支：`feature/narrative-memory-v5`
数据库目标版本：schema 9

## 1. 背景

现有 `parallel_v4` 已经具备一套可靠的词汇知识与翻译基础设施：

- 本地确定性候选扫描，不消耗模型调用；
- 候选裁决、词形与概念分离、共指收束、工作译名解析；
- 冻结知识快照、按岛并行翻译、按全局顺序提交；
- 两层翻译、语义映射、完整性校验、旧译文基线对照；
- 词形、概念、渲染规则和声明的精确依赖；
- 最多三个知识纪元、局部修补、整块重译和无人值守兜底；
- TXT、EPUB、质量报告和模型审计。

它仍缺少跨岛、跨章节的持久叙事状态。当前 `local_summary` 在每个 island 开头清空；`SemanticMapper` 只查看当前块和一次性上下文，输出不可复用的文本提示；`claims` 主要承载人工声明，无法自动表示人物状态、时间位置、叙述视角和仍未解决的问题；并行度只按失败情况调整，没有利用叙事复杂度。

这些缺口会造成四类翻译风险：

1. 同一事件跨块描述时，后块只看到很短的前尾，可能误解省略主语、感知层和虚拟呈现层；
2. 人物称谓、关系和语气随剧情变化时，词库可以保持译名一致，却无法提供当前位置可知的关系状态；
3. 并行岛之间各自生成摘要，后续块无法获得统一、可审计、按位置开放的故事记忆；
4. 平静说明段和高歧义转场段采用相同 island 大小与并发度，速度和可靠性无法同时最优。

本设计把现有独立语义映射调用升级为“语义与叙事融合预映射”，用同一次模型调用同时产生当前块的语义关系、叙事记忆候选和话语状态变化。系统不再增加一次独立的章节摘要扫描，而是在翻译前约一章的位置流式构建有限叙事记忆，再按当前位置检索并注入翻译。

## 2. 目标与非目标

### 2.1 目标

本版本必须实现：

1. 保留原书结构和排版语义，包括标题、段落、斜体、小型大写、诗歌、信件、嵌套引号和脚注；
2. 保持本地词汇候选扫描零模型调用；
3. 不增加独立的“章节记忆扫描”模型轮次；
4. 将现有 `SemanticMapper` 升级为严格 JSON 协议的融合预映射器；
5. 建立可追溯、可并存、按位置开放的叙事记忆；
6. 区分明确事实、观察、假说、问题、矛盾、人物状态、关系状态、时间锚点、地点状态和叙述者状态；
7. 保留原作的多义、误认、矛盾和叙述陷阱，不把模型解释提升为唯一真相；
8. 为每个翻译块生成有界的叙事快照和话语状态；
9. 以词形匹配、人物参与、场景、关系、近期变化和未决指代共同检索记忆；
10. 根据叙事波动动态调整并发数和 island 大小；
11. 翻译结果记录准确的词汇、记忆、声明、样式和话语依赖；
12. 记忆或知识变化只失效真正受影响的译文；
13. 自动模式在模型冲突、局部协议失败或修复失败时仍能有限收敛并完成全书；
14. 交互模式可以在检查点暂停，但人工裁决不是自动模式的完成条件；
15. 所有模型输入、输出、缓存键、知识版本、记忆版本和依赖均可审计、可复现；
16. 对 200–300 万字小说保持流式、有界和近似线性增长，不能构造全书一次性上下文。

### 2.2 非目标

本版本不要求：

- 生成一份声称绝对正确的全书剧情大纲；
- 裁决作品中故意保留的身份谜题、时间悖论或象征意义；
- 把所有普通名词和动作登记为永久记忆；
- 用记忆系统替代词形、概念、渲染规则和人工声明；
- 把模型内部分析或中文译文当作原文事实证据；
- 因为出现多个合理解释而暂停自动翻译；
- 对每一项低置信度记忆变化重翻历史译文；
- 将整本小说或整章原文一次性发送给模型。

## 3. 总体流程

完整工作流如下：

```text
导入与结构保真
  → 本地词汇候选扫描
  → 候选簇裁决
  → 词形/概念共指收束
  → 全局工作译名解析
  → 启动融合预映射窗口
      → 当前块原文
      → 当前位置可见的前文记忆快照
      → 前一话语状态
      → 当前 provisional 词形/概念 ID
      → 一次模型返回：
          semantic_relations
          memory_candidates
          discourse_delta
      → 各部分独立校验
      → 按 global_index 串行合并
      → 生成新记忆版本与位置快照
  → 计算叙事波动并规划动态翻译波次
  → 冻结知识版本、记忆版本、话语状态和样式状态
  → 并行两层翻译
  → 完整性校验与一次润色重试
  → 按 global_index 串行提交译文和补充候选
  → 更新知识/记忆纪元
  → 精确失效、局部修补或整块重译
  → 有限收敛
  → 导出 TXT / EPUB / 质量报告 / 审计报告
```

融合预映射窗口默认保持在翻译游标前方一个章节；如果章节异常长，则按块数和字符预算限制预取，不要求整章完成后才开始翻译。预映射和翻译可以形成流水线，但同一块必须先有有效或明确降级的预映射结果，才可进入翻译。

## 4. 源文结构保真

### 4.1 结构记录

现有 `blocks.source_text` 继续作为原文事实来源。导入阶段额外保存结构元数据，不把排版标记直接混入自然语言词汇扫描：

```text
source_structure:
  block_id
  structure_json
  structure_hash
  extractor_version
  created_at
```

`structure_json` 只描述可验证结构：

- 块类型与标题层级；
- 段落边界；
- 行分隔；
- 斜体、小型大写、粗体等 span；
- 引号层级；
- 脚注锚点和脚注正文关联；
- 诗歌、信件、目录和题词等特殊区段。

TXT 无法提供的样式信息保持为空，不由模型猜测。EPUB/DOCX 导入可以提供的样式必须通过源文件偏移或节点路径定位。翻译模型看到的是原文和紧凑结构提示；导出时依据结构元数据恢复排版。

### 4.2 完整性

结构完整性校验与文字完整性校验分开：

- 文字完整性检测漏段、重复段、异常缩短、专名和数字丢失；
- 结构完整性检测段落数、脚注锚点、诗行、标题和受保护 span。

润色稿任一校验失败时允许一次带具体错误的润色重试；仍失败则使用完整的初译稿，并记录警告。不得因为润色失败覆盖一个更完整的初译稿。

## 5. 融合预映射器

### 5.1 替换关系

现有 `SemanticMapper` 的模型调用被升级为 `NarrativePremapper`。旧类名可以保留兼容适配器，但生产流水线只调用新的结构化接口。它不是全文总结器，也不直接翻译。

每个请求只包含：

- 当前块英文原文；
- 当前块结构摘要；
- 上一位置的有界叙事快照；
- 上一位置的话语状态；
- 当前块命中的 provisional lexeme/concept 短 ID；
- 当前场景最近的少量英文证据；
- 协议版本和输出上限。

不得传入后文记忆、后文身份结论、整本书摘要或中文译文作为事实证据。

### 5.2 响应协议

严格 JSON 顶层结构为：

```json
{
  "semantic_relations": [],
  "memory_candidates": [],
  "discourse_delta": {}
}
```

三个部分独立校验。某一部分失败不使其他已通过部分失效。顶层 JSON 无法解析时按固定次数重试；重试耗尽后写入降级结果：

- `semantic_relations=[]`
- `memory_candidates=[]`
- `discourse_delta` 延续上一状态并标记 `premap_uncertain`

翻译仍可继续，但该块叙事波动至少按“中”处理，并在质量报告中显示。

### 5.3 `semantic_relations`

保留现有关系类型：

- `referential_link`
- `same_event_different_rendering`
- `viewpoint_or_layer_shift`
- `ellipsis_or_implicit_subject`
- `causal_or_contrast_link`
- `deliberate_ambiguity`

每项必须包含：

```text
relation_type
inference_strength: explicit | strongly_implied | ambiguous
source_spans
related_memory_ids
translation_constraint
```

`source_spans` 必须逐字来自当前块英文原文；`related_memory_ids` 只能引用请求中可见的记忆短 ID；`translation_constraint` 只能说明译文应保留什么关系和显隐强度，不能直接给出整句中文译法。

### 5.4 `memory_candidates`

允许的记忆类型为：

- `explicit_fact`
- `observation`
- `hypothesis`
- `open_question`
- `contradiction`
- `character_state`
- `relationship_state`
- `timeline_anchor`
- `location_state`
- `narrator_state`

每项必须包含：

```text
candidate_id
memory_type
statement
truth_status
visibility
confidence
subjects
related_memory_ids
evidence_spans
state_operation
high_impact
```

约束如下：

- `truth_status` 为 `asserted | observed | inferred | disputed | unknown`；
- `visibility` 为 `reader_visible | system_private | render_only`；
- `confidence` 为 0 到 1；
- `subjects` 只引用请求中出现的短 ID，或受控的匿名角色/地点锚点；
- `evidence_spans` 至少一项，且必须逐字来自当前英文原文；
- `state_operation` 为 `append | supersede | relate | close_question`；
- `high_impact` 只用于身份、时间、地点、视角、叙述层或翻译方式会发生实质变化的项目。

模型不得直接修改或删除已有记忆。`supersede` 和 `close_question` 只是候选关系，提交器验证后通过新记录表示状态变化。

### 5.5 `discourse_delta`

话语状态只描述翻译当前局部所需的可恢复信息：

```text
viewpoint_holder
narrator_layer
active_speakers
addressed_parties
scene_location
scene_time
presentation_layer
unresolved_references
style_signals
state_confidence
```

其中：

- `presentation_layer` 可表示现实、回忆、梦境、转述、拟景、虚拟呈现或未知层；
- `unresolved_references` 保存仍未确定的代词、省略主语或无名说话者，不强制裁决；
- `style_signals` 只保存人称、语域、礼貌等级、书信/诗歌/口语等有限标签，不保存自由生成的长篇风格评论；
- 任一 ID 必须来自输入短 ID；
- 状态字段设为空表示未知，不表示否定；
- 没有可靠变化时沿用前一状态。

## 6. 叙事记忆模型

### 6.1 版本与追加式记录

新增独立的 `memory_versions`，不把每个记忆变化都强行提升为词汇 `knowledge_version`：

```text
id
parent_id
reason
source_global_index
created_at
```

词汇知识和叙事记忆分别版本化，翻译冻结时同时记录两者。一次波次提交可以同时创建新知识版本和新记忆版本，也可以只创建其中一个。

`narrative_memories` 保存追加式事实：

```text
id
memory_type
statement
truth_status
visibility
confidence
reveal_global_index
source_block_id
source_hash
status
high_impact
semantic_fingerprint
created_memory_version
retired_memory_version nullable
created_at
```

`status` 为 `provisional | verified | disputed | superseded | rejected`。旧记录不原地改写陈述；状态变化创建新版本并保留前态。

### 6.2 证据、主体与关系

新增：

```text
narrative_memory_evidence:
  memory_id
  block_id
  start_offset
  end_offset
  quote
  source_hash

narrative_memory_subjects:
  memory_id
  subject_type: lexeme | concept | anonymous_actor | location | thread
  subject_id
  role

narrative_memory_links:
  from_memory_id
  to_memory_id
  relation: supports | contradicts | supersedes | answers | elaborates
  confidence
  created_memory_version
```

证据必须能在对应块的当前 `source_hash` 中按偏移复核。源文重新导入导致哈希变化时，相关预映射缓存和记忆证据必须失效，不能静默沿用。

### 6.3 可见性与硬约束

三类可见性含义固定：

- `reader_visible`：当前位置的读者已可从原文获得，可注入翻译上下文；
- `system_private`：系统用于保留不确定关联或后续核验，不得直接提示翻译模型；
- `render_only`：只用于保持已经明确的称谓、语气、呈现层或指代，不可扩写进正文。

只有以下记录可以成为硬翻译约束：

1. `explicit_fact` 且状态为 `verified`；
2. 经过确定性校验的 `render_only` 项；
3. 人工锁定的翻译声明；
4. 已核验的词形、概念和渲染规则。

`observation`、`hypothesis`、`open_question`、`contradiction` 和未核验状态只能作为保守提示。提示必须带显隐强度，禁止模型把它们改写成明说。

### 6.4 多重解释与矛盾

同一主体可以同时拥有互相冲突的记忆。系统不得以“置信度最高”覆盖其他解释，而应：

- 保存各自证据；
- 建立 `contradicts` 链接；
- 向翻译模型展示“原文在当前位置存在冲突/未决”；
- 保持中性措辞和原文显隐程度；
- 在后文出现明确证据时以新记录 `supersedes` 或 `answers` 旧记录；
- 不重写读者在旧位置当时能够知道的快照。

## 7. 位置快照与检索

### 7.1 快照

新增 `narrative_snapshots`：

```text
id
block_id
global_index
knowledge_version
memory_version
previous_snapshot_id nullable
discourse_state_json
visible_memory_ids_json
snapshot_hash
created_at
```

快照由提交器按 `global_index` 串行生成。一个块只能看到：

- `reveal_global_index <= block.global_index`；
- 非 `system_private`；
- 未被当前版本拒绝；
- 满足范围和主体相关性的记忆。

快照保存的是有界 ID 集和状态，不复制大量正文。完整记忆内容按 ID 查询。

### 7.2 检索信号

每块候选记忆由以下信号联合召回：

1. 当前原文命中的 lexeme/concept；
2. 当前 `active_speakers`、`viewpoint_holder` 和被称呼对象；
3. 当前章节、场景地点、时间锚点和呈现层；
4. 命中主体的一跳关系；
5. 最近发生的人物、关系、地点或叙述者状态变化；
6. `unresolved_references` 对应的候选主体；
7. 尚未关闭的 `open_question`；
8. 已揭示的高影响事实；
9. 当前 `semantic_relations` 引用的记忆。

不能只依赖字符串关键词。名称未再次出现但代词或对话参与者延续时，话语状态必须能召回相关记忆。

### 7.3 排序与预算

叙事上下文默认控制在 2,000–6,000 个中文字符，具体上限受总上下文预算约束。排序分由确定性特征计算：

```text
score =
  100 * direct_subject_match
  + 80 * discourse_participant_match
  + 70 * semantic_relation_reference
  + 60 * unresolved_reference_match
  + 50 * recent_state_change
  + 40 * same_scene
  + 30 * open_question
  + 25 * high_impact_revealed
  + 20 * one_hop_relation
  + confidence_weight
  - distance_penalty
```

同分时按 `reveal_global_index` 降序、`memory_id` 升序，确保可复现。硬约束、当前话语参与者和未决指代优先保留；低分观察和旧场景信息可被裁剪。预算超限时只裁剪可选项，必需上下文仍超预算则返回人工处理，不在模型内部偷偷省略。

## 8. 预映射缓存与流水线

### 8.1 缓存键

每块预映射结果使用下列材料生成缓存键：

```text
protocol_version
source_hash
structure_hash
prompt_hash
model_id
model_parameters_hash
prior_snapshot_hash
provisional_subject_hash
```

缓存表 `premap_results` 保存：

```text
id
block_id
cache_key
status
semantic_json
memory_candidates_json
discourse_delta_json
validation_json
model_id
prompt_hash
prior_snapshot_hash
request_hash
response_hash
audit_call_id
created_at
```

相同键重复运行必须复用结果，不产生第二次模型调用。上一快照变化会自然产生新键；源文、提示词或模型变化也不会误用旧缓存。

### 8.2 前瞻窗口

默认前瞻目标为一个章节，同时受以下上限限制：

- 最大预映射块数；
- 最大未提交候选数；
- 最大缓存字节；
- 最大模型并发；
- 翻译游标与预映射游标的最大距离。

预映射模型调用可以并行准备同一冻结前态下的独立块候选，但记忆合并和最终快照必须串行。为避免同章后块缺少本章前态，生产默认以小批次推进：

1. 冻结当前快照；
2. 并行映射一个有限 batch；
3. 按 `global_index` 依次合并；
4. 为后续 batch 生成新快照；
5. 直到达到前瞻目标。

预映射吞吐和翻译吞吐由同一调度器协调。预映射不足时翻译等待最小必要块，不等待整章。

## 9. 动态并行调度

### 9.1 叙事波动

每个块产生确定性的 `narrative_volatility` 分数，取值 0–100。信号包括：

- 新主体或新 lexeme 数量；
- 视角、叙述层、呈现层、时间或地点切换；
- 未解决代词、省略主语和说话者数量；
- 新矛盾、未决问题和高影响记忆；
- 当前块命中的 provisional/uncertain 共指；
- 近期知识或记忆失效任务数量；
- 预映射协议降级；
- 对话参与者快速变化；
- 结构复杂度，如嵌套引语、脚注、诗歌或信件。

默认分档：

- 高波动 `>= 65`：`workers=1`，`island_size=1–2`；
- 中波动 `35–64`：`workers=2`，`island_size=2–3`；
- 低波动 `< 35`：`workers=4` 起，可增长到配置上限，`island_size=3–5`。

### 9.2 边界

island 不得跨越：

- 章节边界；
- 明确场景切换；
- 视角或叙述层切换；
- 高影响记忆揭示边界；
- 未完成的结构化区段边界；
- 知识或记忆纪元冻结边界。

调度器可以因速率限制、失败或人工模式降低并发，但不能超过配置上限。恢复时逐步增加，避免振荡。叙事波动只影响计划，不修改内容判断。

## 10. 翻译上下文

每个翻译块先构建带优先级和依赖 ID 的结构化上下文，再分别投影为初译和润色
提示。不得再把数据库查询结果拼成一份无优先级的长字符串同时发送给两个模型。

共同的结构化材料按固定顺序构建：

```text
1. 当前英文原文
2. 源文结构与受保护格式
3. 命中的 lexeme / concept / rendering rules
4. 已核验且当前位置可见的 claims
5. 当前块的 semantic_relations
6. 位置开放的 narrative memory
7. 当前 discourse state
8. 命中概念的前文英文证据
9. 上一块英文尾部与中文尾部
10. 当前最小 style state
11. 可选双语风格锚点
12. 可选旧译文基线
```

上下文构建必须返回准确依赖 ID、各部分字符数、估算 token 数、是否进入初译/
润色投影以及被裁剪原因。任何必需部分不能因总预算被静默截断。旧译文基线和
双语锚点永远只是措辞参考，英文原文是唯一事实依据。

### 10.1 两层投影

初译投影包含：完整原文、结构保护、命中术语、硬语义义务、直接相关叙事记忆、
局部衔接和一行最小风格状态。初译不接收中文风格例文，避免模仿压过原文。

润色投影包含：完整原文、完整初稿、结构保护、精简后的硬语义/术语/叙事事实、
必要局部衔接和一行最小风格状态。只有检索效用为正且预算充足时，才额外加入一
个短双语风格锚点或旧译文基线；二者不能因为“已存在”而默认发送。

### 10.2 默认 token 预算

以每块最多约 1,100 个英文 token 为基准：

- 初译输入典型为 2,300–4,500 token，软上限 6,000 token；
- 润色输入典型为 3,000–5,100 token，软上限 8,000 token；
- 初译输出通常为译文 1,000–1,800 token，加 100–300 token 稀疏增量；
- 润色输出通常只含 1,000–1,800 token 的最终译文；
- 配置的 6,144/37,200 输出上限只是防截断安全线，不是预期消耗；
- 若模型没有精确 tokenizer，使用保守估算并预留至少 20% 波动空间；
- 现有 `max_context_chars` 保留为绝对安全护栏，不再承担主要分配职责。

裁剪不是固定字符截断，而是按边际效用选择。绝不删除完整原文、受保护结构、
人工锁定项、必须落实的术语和硬语义义务。通常先在旧译文基线、风格锚点中删除
边际效用较低者，再删除重复叙事信息、过旧的前尾和非必要风格特征。仅必需材料
就超过硬预算时，按既定规则返回人工处理，不让模型自行省略。

### 10.3 最小风格状态与双语锚点

数据库可以保存完整风格状态、候选锚点的来源位置、质量后验、适用场景、生成
谱系和校准版本；模型只看到紧凑投影：

- 初译始终至多看到 20–60 token 的一行风格状态；
- 润色默认也只看到该状态；
- 双语锚点默认关闭，启用时为 120–300 token，只能来自当前位置之前、已通过
  完整性校验且非回退稿的译文；
- 锚点必须与当前叙述层、语域、文本类型和句法特征高度相关，并避免连续使用同一
  锚点造成自我强化；
- 锚点只约束叙事距离、语域、节奏、句法密度和对话习惯，不提供事实、术语或语义
  结论，也不得覆盖当前英文原文的风格变化；
- 当前原文已经足以确定表达时，不发送锚点。

`ContextPacket` 扩展为：

```text
knowledge_version
memory_version
snapshot_id
rendered
required_chars
matched_lexeme_ids
matched_concept_ids
matched_rule_ids
matched_claim_ids
matched_memory_ids
style_snapshot_id
discourse_state_hash
section_token_estimates
draft_projection
polish_projection
dropped_optional_sections
style_projection
style_anchor_id nullable
```

## 11. 翻译与润色协议

### 11.1 初译

初译模型输出：

- `analysis`
- `semantic_obligations`
- `translation`
- `new_terms`
- `relations`

并新增结构化：

- `supplemental_memory_candidates`
- `style_delta`

兼容解析器可以继续接受旧响应中的 `memory_summary`，但生产提示不再要求初译模型
重复生成全书滚动摘要。跨块状态来自融合预映射；初译只报告预映射遗漏的稀疏补充
记忆候选和风格增量。补充记忆候选必须引用当前英文原文证据，默认置信度低于预
映射候选；如果只是中文措辞推断而无法在英文原文定位，则拒绝入库。

### 11.2 润色

润色模型接收英文原文、初译、语义义务、结构约束、有界叙事上下文、最小风格
状态，以及按效用可选的短双语风格锚点或旧译文。它只能返回最终译文和质量警告，
不能修改词库、记忆、关系或话语状态。

润色输出依次通过：

1. 结构校验；
2. 段落与内容完整性；
3. 数字、专名和受保护项检查；
4. 中文标点规范化；
5. 语义义务覆盖检查。

失败时允许一次针对具体问题的润色重试；再次失败则回退至初译，并把失败原因写入质量报告。

## 12. 提交、知识纪元与记忆纪元

### 12.1 Worker 隔离

所有 worker 只产生内存结果和审计调用，不直接写 SQLite。一个波次结束后，协调器：

1. 按 `global_index` 排序结果；
2. 校验每个 outcome 使用的知识版本、记忆版本和快照；
3. 写入译文版本和依赖；
4. 合并术语、关系和补充记忆候选；
5. 创建必要的新知识版本和记忆版本；
6. 生成后续位置快照；
7. 计算精确失效；
8. 决定下一波次的并发和 island。

任一事务失败不得留下半个记忆版本或半个活动译文。

### 12.2 记忆合并

预映射候选和翻译补充候选使用稳定指纹：

```text
memory_type
normalized_statement
sorted_subjects
source_block_id
sorted_evidence_offsets
visibility
```

相同指纹重跑为幂等。合并规则：

- 明确重复：复用已有记忆并增加证据；
- 同主体的新状态：追加新记录并建立 `supersedes`，不覆盖旧记录；
- 相反陈述：双方保留并建立 `contradicts`；
- 假说变事实：创建新的明确事实并建立 `supports`/`supersedes`；
- 无可靠英文证据：拒绝；
- 模型只给出解释、原文刻意模糊：保存为 `hypothesis` 或 `open_question`，不能升级为硬约束。

### 12.3 有限收敛

沿用最多三个知识纪元，并增加最多三个记忆纪元。一次检查点可同时推进两者。达到上限后：

- 已冻结译文继续完成；
- 新发现以 deferred proposal 保存；
- 相关译文标记可用但带警告；
- 不再开启新的自动纪元；
- 导出质量报告列出延后项；
- 不进入无限重验循环。

## 13. 精确依赖与重验

### 13.1 依赖

沿用 `dependencies` 通用表，增加受控依赖类型：

- `lexeme`
- `concept`
- `rendering_rule`
- `claim`
- `narrative_memory`
- `narrative_snapshot`
- `discourse_state`
- `style_snapshot`

其中：

- `narrative_memory` 记录实际注入提示的记忆及语义指纹；
- `narrative_snapshot` 记录快照 ID 和快照哈希；
- `discourse_state` 记录影响人称、称谓、指代或呈现层的状态哈希；
- `style_snapshot` 记录当前风格状态。

`translation_versions` 增加 `memory_version`、`snapshot_id`、`context_hash`、`style_snapshot_id` 和 `discourse_state_hash`。

### 13.2 失效级别

记忆变化映射为：

- 0：元数据、额外证据或不可见私有项，无需重验；
- 1：低影响称谓或稳定词形变化，可尝试安全局部修补；
- 2：关系、场景、话语参与者或呈现层变化，需要定向模型校验；
- 3：身份、时间、视角、叙述层、高影响揭示边界变化，需要整块重译。

只有满足以下条件的译文进入任务：

1. 活动译文确实依赖变化的 memory/claim/lexeme/concept/rule/state；
2. 变化版本晚于该译文冻结版本；
3. 新旧语义指纹不同；
4. 变化在该块位置可见；
5. 任务 change-set 尚未处理。

### 13.3 修复

动作优先级：

1. `resolved_noop`：变化与当前译文无关；
2. `resolved_patch`：仅在精确、唯一、可验证的译名替换时使用；
3. `resolved_retranslate`：语义、身份、时间、视角或话语状态变化；
4. `completed_with_warning`：重译或修复失败，保留旧活动译文。

修复失败不能停用旧译文。替代译文只有在完整性校验通过且冻结版本仍有效时才能原子切换为活动版本。

## 14. schema 9

### 14.1 新表

schema 9 新增：

- `source_structure`
- `memory_versions`
- `narrative_memories`
- `narrative_memory_evidence`
- `narrative_memory_subjects`
- `narrative_memory_links`
- `narrative_snapshots`
- `premap_results`
- `style_snapshots`

所有 JSON 字段写入前执行深度、节点数、字符串长度和 UTF-8 字节上限校验。所有可反向查询的主体、块、版本和状态建立索引；大型英文原文不在多张表重复保存。

### 14.2 现有表扩展

`translation_versions` 新增：

```text
memory_version INTEGER
snapshot_id TEXT
context_hash TEXT NOT NULL DEFAULT ''
style_snapshot_id TEXT
discourse_state_hash TEXT NOT NULL DEFAULT ''
```

`audit_calls` 继续保存模型、请求和响应，并确保可关联 `premap_results`。`dependencies` 不重建，只扩展允许的类型语义。`claims` 保持人工声明用途，不与自动叙事记忆混表。

### 14.3 迁移

迁移只允许 schema 8 → schema 9，并沿用显式预览和确认令牌：

```text
python main.py migrate-v4 <book_id> --preview
python main.py migrate-v4 <book_id> --confirm <token>
```

预览必须报告：

- 当前 schema；
- 目标 schema；
- 新表和新列；
- 预计新增索引；
- 当前活动译文数；
- 是否存在未完成任务；
- 数据库文件哈希；
- 迁移后预计磁盘增长；
- 确认令牌。

迁移事务完成后执行外键检查、表结构检查、活动译文唯一性检查和已知行数对账。失败时回滚。旧 `memory_summary` 保留为历史审计文本，不自动提升为正式叙事记忆，避免把旧模型幻觉写入新知识库。

## 15. 配置与命令

### 15.1 默认行为

`translate-v4` 默认启用融合预映射和动态调度。为了兼容旧项目，schema 8 数据库会先要求迁移，不能静默以半兼容模式运行。

新增配置项：

```text
enable_narrative_premap
premap_ahead_chapters
premap_batch_blocks
premap_initial_workers
premap_max_workers
premap_max_attempts
premap_max_tokens
max_narrative_context_chars
max_memory_candidates_per_block
max_visible_memories_per_block
dynamic_scheduling
high_volatility_threshold
medium_volatility_threshold
max_memory_epochs
automatic_degraded_completion
```

默认值必须在 `V4PipelineConfig` 中集中定义和校验，CLI 只覆盖用户显式传入的值。

### 15.2 命令

新增只读或可恢复命令：

```text
premap-v4 <book_id>
inspect-memory-v4 <book_id>
rebuild-snapshots-v4 <book_id>
```

`premap-v4` 用于单独试跑或提前填充缓存；正常 `translate-v4` 会自动确保前瞻窗口，不要求用户手动执行。

`inspect-memory-v4` 支持按块、人物、类型、可见性、状态和 reveal index 查看证据。

`rebuild-snapshots-v4` 只从已验证的追加式记忆重建快照，不调用模型，不修改原始记忆。

现有 `status-v4` 增加：

- 预映射游标；
- 翻译游标；
- 当前记忆版本；
- 缓存命中率；
- 高/中/低波动块数；
- 降级预映射块数；
- 记忆相关重验任务；
- deferred memory proposals。

## 16. 人工界面

本地评审页面增加折叠区：

- 当前位置叙事记忆；
- 记忆原文证据；
- 相互支持/矛盾/替代关系；
- 当前话语状态；
- 叙事波动分数与原因；
- 预映射协议降级警告。

人工可以：

- 核验、拒绝或编辑一条 provisional 记忆；
- 锁定 render-only 称谓或话语规则；
- 把错误的事实降级为假说；
- 将两条记忆标记为矛盾或同义；
- 重建后续快照并触发精确重验。

“编辑后接受”创建新版本，不原地覆盖旧证据。自动模式忽略未处理人工队列继续运行；交互模式可在配置的检查点暂停。

## 17. 审计与复现

每个模型调用必须记录：

- 实际模型 ID；
- purpose；
- protocol version；
- prompt hash；
- source hash；
- structure hash；
- knowledge version；
- memory version；
- prior snapshot hash；
- context hash；
-模型参数；
- request hash；
- raw response hash；
- 解析和各部分校验结果；
- 是否被接受；
- 缓存命中与原缓存 ID。

审计模式继续支持 `full | response | minimal`。即使在 minimal 模式，也必须保留复现与依赖所需的哈希、模型 ID、版本和校验状态。

## 18. 失败与降级

无人值守原则为“有限重试、保留有效旧结果、以警告完成”：

- 预映射协议失败：空关系、空候选、延续话语状态并标记不确定；
- 单条记忆证据失败：丢弃该条，不丢弃同响应其他有效条目；
- 记忆合并冲突：并存为 disputed/contradiction；
- 上下文必需项超预算：返回人工处理，不改变内部逻辑；
- 润色不完整：一次重试后回退初译；
- 波次提交失败：整个事务回滚；
- 修复失败：保留旧活动译文；
- 超过知识或记忆纪元：延后提案并带警告完成；
- 模型速率限制：降低并发并指数退避，但不无限等待；
- 源文哈希变化：失效对应缓存、证据和快照，要求重新预映射受影响范围。

自动模式不能因为两个模型或两种解释冲突而永久暂停。只有数据库损坏、必需上下文超过明确预算、源文结构无法恢复或外部模型持续不可用等外部/结构性问题才进入人工处理。

## 19. 性能与存储

### 19.1 模型调用

相对于现有启用 `SemanticMapper` 的流程，本设计不增加每块的基础模型调用次数，而是扩大并结构化该次调用的职责。缓存和前瞻流水线降低重复调用：

- 本地词汇扫描仍为零调用；
- 预映射通常每块一次；
- 初译每块一次；
- 润色每块一次，失败时最多一次重试；
- 重验只针对有精确依赖的块。

模型调用输入保持有界，不随全书长度线性增长到单次上下文中。

### 19.2 SQLite

记忆表增长与“被保留的叙事状态和证据数”相关，而不是原文字符的笛卡尔积。采用以下限制：

- 每块最大记忆候选数；
- 每条证据最大引用长度；
- 每块最大可见记忆数；
- 快照只保存 ID 与哈希；
- 原文只在 `blocks` 保存一份；
- 审计大响应继续使用现有归档策略；
- 对旧 provisional、重复候选和缓存提供安全压缩/清理命令；
- 任何清理不删除活动译文依赖的记忆、证据或审计定位信息。

目标是即使处理 200–300 万字小说，数据库仍保持在普通桌面 SQLite 可控范围内，不因短 ID、索引或快照造成平方级增长。

## 20. 测试

### 20.1 单元测试

必须覆盖：

- 三部分响应独立校验；
- 原文证据 span grounding；
- 位置可见性和防后文泄露；
- 多重解释并存；
- 记忆追加、替代、矛盾和问题关闭；
- 预映射缓存键和失效；
- 快照确定性重建；
- 关键词缺失但话语参与者命中的检索；
- 上下文排序和预算裁剪；
- 高/中/低叙事波动分档；
- 动态 island 不跨边界；
- 记忆依赖写入；
- 记忆变化的精确重验级别；
- 润色失败回退初译；
- 知识与记忆纪元有限收敛；
- 自动模式的冲突兜底；
- schema 8 → 9 迁移、回滚和幂等；
- 结构保真与 TXT/EPUB 导出。

### 20.2 集成测试

构造至少以下短篇夹具：

1. 同一事件在现实层与虚拟呈现层连续描述；
2. 人物名称不重复出现，仅以代词和对话轮次延续；
3. 同一人物从“女士”自然变化为“亲爱的”；
4. 原文故意保留两个互斥身份解释；
5. 后文揭示不能泄露到前文翻译；
6. 时间、地点和视角在相邻块切换；
7. 预映射失败但全书自动完成；
8. 记忆变化只重验实际依赖块；
9. 失败修复保留旧活动译文；
10. 重跑完全命中缓存且不产生重复记忆。

### 20.3 规模与恢复测试

必须验证：

- 十万级块元数据查询不做全表逐概念正则扫描；
- 快照构建和检索使用索引；
- 中断后从最后已提交快照恢复；
- 波次事务中断不留下部分活动数据；
- 大型审计输出仍遵守现有归档预算；
- 数据库增长近似线性；
- 并发 worker 不直接写数据库。

## 21. 验收标准

本版本完成需满足：

1. 现有测试与新增回归测试全部继续通过；
2. schema 9 新测试全部通过；
3. 《新日之书》试跑中，预映射与翻译形成至少一个章节前瞻流水线；
4. 典型词形、人物状态、地点、时间和呈现层能生成带英文证据的记忆；
5. 前文块无法读取后文 reveal index 的记忆；
6. “拟景/scape”类跨句呈现关系能以语义关系和话语状态进入翻译，而不是硬编码具体词；
7. 译名仍由 lexeme/concept/rendering rules 统一，不由叙事记忆另建竞争译名；
8. 同一块重跑命中预映射缓存，不重复调用模型或写入重复记忆；
9. 高波动段自动降低并发，低波动段能够恢复并行；
10. 记忆变化只创建精确依赖任务；
11. 自动模式在冲突和局部失败下能跑完全程并输出警告；
12. TXT、EPUB、质量报告和审计报告可正常导出；
13. 迁移预览、确认、回滚和数据库完整性检查全部工作；
14. 代码中不存在依赖具体小说词汇的硬编码修复。

### 21.1 实施验收记录

2026-07-16 在隔离项目 `new_sun_v5_pilot_clean` 上完成验收：

- 原项目 schema 7 先经显式预览/确认迁移到 schema 8，再经显式
  预览/确认迁移到 schema 9；原项目数据库未被修改；
- 12 块融合预映射首次运行完成，随后同一范围重跑为
  `premap_cache_hits=12`、`premap_model_calls=0`；
- 预映射生成 37 条叙事记忆、54 条英文证据；SQL 复核
  `INVALID_EVIDENCE=0`、`FUTURE_LEAKS=0`；
- 6 块翻译试跑完成，`completed=6`、失败与人工阻塞均为 0；
  翻译阶段复用 6 个预映射缓存，未重新调用预映射模型；
- 活动译文写入 73 条 lexeme 依赖、40 条 narrative memory 依赖、
  6 条 narrative snapshot 依赖和 6 条 discourse state 依赖；
- 低波动块保持多 worker 计划，高波动块降至单 worker；试跑最终
  高波动 wave 的 `final_workers=1`；
- 译文快照的后文记忆泄露计数为 0；
- 同轮新增词汇知识为 6 个活动译文生成精确 impact-2 重验任务，
  未产生全书无差别重验；
- 更新后的严格协议又对前三块实测，首次 3 次模型调用，重跑
  `premap_cache_hits=3`、`premap_model_calls=0`；
- 翻译波次的译文、style、知识/记忆 checkpoint 和精确重验任务现由
  同一 SQLite 写事务提交；在 memory version 已写入后注入 checkpoint
  异常，活动译文、记忆、style 和块状态全部回滚；
- 新鲜数据库上的非连续 `--block` 选择会自动预映射缺失前缀，不会把
  远处目标块错误地当作无前文的第一块；
- `rg` 检查新增生产路径未发现 Severian、Vodalus、Drotte、
  Roche、Tecla 或 Gene Wolfe 等小说专名硬编码；
- 完整回归结果：`621 passed, 8 subtests passed`。

## 22. 实施边界

实现按以下顺序推进，以避免同时改动过多状态：

1. schema 9 与迁移；
2. 结构元数据和叙事记忆存储；
3. 融合预映射协议、校验和缓存；
4. 串行记忆合并、快照和检索；
5. `ContextPacket` 与翻译协议接入；
6. 动态调度；
7. 精确记忆依赖与重验；
8. CLI、状态、人工界面和导出；
9. 《新日之书》小规模试跑；
10. 全书前瞻流水线与性能验证。

每一阶段必须保留现有可运行基线。不得先删除旧 `SemanticMapper` 路径再补新实现；兼容适配器在新路径通过集成测试后再收束。所有新表、协议和调度决定均使用确定性哈希、有限边界和原子事务。
