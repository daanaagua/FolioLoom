# V5 Agent Kernel 局部翻译试验设计

日期：2026-07-17  
状态：已批准进入最小垂直试验  
目标运行时：TypeScript + `@earendil-works/pi-agent-core`  
试验对象：《新日之书／新日之兀斯》提丰片段，`global_index=219..223`

## 1. 背景

V4 在翻译目标五块前，从全书开头严格串行预映射到目标位置。目标原文只有
33,307 字符，但实际让模型阅读了 1,422,067 字符；主预映射运行进行了 300 次
模型调用，墙钟时间约 3 小时 25 分。已有缓存后，五块正式翻译只需要约 6 分
41 秒。

问题不在单次翻译，而在于 V4 把局部翻译请求退化成了前缀闭包：目标位于第
223 块，就要求模型先顺序理解 0..223 块。既有规格虽然描述了并行 Map、顺序
Reduce，但当前实现仍以 `prior_snapshot` 建立逐块强依赖。

本试验不继续给这条串行链增加例外，而是验证一个新的长期抽象：由确定性内核
维护事实、预算、权限和状态转移；Pi Agent 在有限动作空间内按需发现问题、检索
证据、翻译和修复。

## 2. 设计原则

### 2.1 Pi 是策略层，不是权威层

Pi 可以决定下一步调用哪个合法工具，但不能：

- 直接读取文件系统；
- 直接执行 SQL；
- 直接修改知识库或活动译文；
- 改变预算、位置边界或锁；
- 绕过结构、证据和完整性校验；
- 自由创建递归 Agent；
- 把未来证据注入当前位置可见的叙事事实。

所有持久状态变化都由 Agent Kernel 通过 typed command、前置条件、不变量和
事务执行。

### 2.2 Agent 只接管高适合度工作

本试验让 Pi 执行：

1. 从目标文本发现影响翻译的具体疑问；
2. 选择和改写定向证据查询；
3. 根据证据提交暂定语义判断；
4. 在最小强制上下文基础上按需取用更多信息并翻译；
5. 在确定性校验失败时进行一次有界语义修复。

本试验不让 Pi 执行：

1. TXT/EPUB 解析和章节切分；
2. 本地词汇候选提取和 FTS 建索引；
3. token、时间和调用预算执行；
4. 任务锁、租约、幂等键和缓存提交；
5. 原文结构完整性检查；
6. 数据库版本切换；
7. TXT/EPUB 导出。

### 2.3 冷局部试验必须诚实

试验可以读取：

- `blocks` 中的原文和位置；
- 原文结构数据；
- 人工锁定或已有稳定译名；
- 本地确定性词形索引。

试验故意忽略 V4 已生成的 `narrative_snapshots`、`narrative_memories` 和
`premap_results`，否则无法证明局部模式能够摆脱全书预扫描。

### 2.4 暂定结果允许后续重验

局部模式产生的知识快照和译文标记为 `provisional`。每条判断和译文记录：

- 依赖的 source hash；
- 使用的 evidence ID；
- 可见性通道；
- 覆盖区间；
- 模型、提示词和工具协议版本；
- 未解决问题；
- Agent transcript 和调用成本。

将来完整知识库出现相关新证据时，确定性依赖查询生成重验任务；没有相关依赖
变化的局部译文不重跑。

## 3. 形式模型

Agent Kernel 将运行表示为受约束决策过程：

```text
S     当前不可变源文、知识版本、局部快照、译文版本、预算和队列
A(S)  当前状态允许调用的有限 typed tools
T     由内核实现的确定性、事务性状态转移
O     工具返回的有界观察
π     Pi/LLM 在 A(S) 中选择下一动作的策略
```

Agent 可以提出动作，但只有 Kernel 可以执行 `T(S, a)`。非法参数、超预算动作、
越界证据和无来源事实不会造成状态转移，只产生可审计的拒绝结果。

规划目标采用近似效用：

```text
U(action)
  = expected_quality_gain
  + expected_consistency_gain
  - latency_weight * expected_latency
  - token_weight * expected_tokens
  - risk_weight * state_corruption_risk
```

第一版不相信模型自报概率。效用特征来自可观测量：未知专名、证据命中、冲突、
位置距离、结构风险、确定性校验结果和历史盲评数据。硬停止条件优先于效用估计。

## 4. 总体组件

```text
TranslationRequest
  -> Deterministic Scope Resolver
  -> Local Source/Evidence Index
  -> Pi Question Scout
  -> Pi Evidence Resolver <-> bounded typed tools
  -> Kernel-validated Provisional Snapshot
  -> Pi Translation Agent <-> bounded read-only tools
  -> Deterministic Validators
  -> optional Pi Repair Agent
  -> Transactional Provisional Commit
  -> TXT + audit report
```

### 4.1 Agent Kernel

职责：

- 建立运行、作用域、预算和 abort signal；
- 计算当前允许的工具；
- 校验工具参数和调用上限；
- 执行只读查询；
- 验证 evidence ID、位置与 source hash；
- 缓存相同查询和模型请求；
- 保存 event log；
- 执行确定性校验和最终提交。

Kernel 不判断文学含义，也不生成中文。

### 4.2 Pi Runtime Adapter

只使用 `pi-agent-core`，不加载 coding-agent 默认的 bash、read、edit、grep 等
工具。每个作用域创建短生命周期、内存会话：

- Question Scout：每个目标 island 一次；
- Evidence Resolver：拆成有局部轮次上限的检索阶段与独占提交预算的证据终结阶段；
- Lexical Anchorer：并行翻译前一次，只处理跨 island 重复且尚无稳定译名的形式；
- Translation Agent：每个 island 一次；
- Repair Agent：仅确定性校验失败时运行；全局最多三次最小补丁，不无限循环。

持久记忆属于 SQLite/event log，不属于 Pi 对话历史。

### 4.3 Deterministic Evidence Index

导入后对全书建立廉价索引，不调用模型：

- 章节、段落、块和字符位置；
- casefold 后的词形；
- 已知 lexeme/concept 别名；
- SQLite FTS；
- 某主体的首次、最近和全部出现位置；
- 共现窗口；
- source hash。

完整本地建索引不等于全书语义扫描，允许在 preview 模式使用。

## 5. 可见性通道

证据查询必须声明通道：

### 5.1 `narrative_before_target`

只允许目标位置之前的证据。可用于：

- 叙述者当前知道什么；
- 当前指代；
- 已揭示的人物关系；
- 应当保留还是消除含混。

### 5.2 `translator_global`

允许搜索全书，但只能生成：

- 规范专名和固定术语；
- 两个词形是否同一实体；
- 性别、物种、固定称号等译者层信息；
- 不改变当前叙述认知的渲染规则。

该通道的结果不能写入叙述者当前状态，也不能让译文提前明说尚未揭晓的身份。

## 6. Typed Tools

第一版只开放下列工具。所有返回结果有字符上限、稳定排序和 evidence ID。

### 6.1 研究工具

```text
inspect_target(block_ids)
lookup_subjects(surface_forms, target_index)
lookup_terms(subject_ids, target_index)
search_mentions(subject_ids, channel, direction, limit)
search_cooccurrence(subject_ids, cue_terms, channel, window, limit)
get_evidence_context(evidence_ids, before_paragraphs, after_paragraphs)
submit_resolution(question_id, verdict, confidence, evidence_ids, unresolved)
finish_research(unresolved_question_ids)
```

### 6.2 翻译工具

```text
get_required_context(block_ids)
lookup_term_usage(subject_ids)
inspect_local_continuity(block_id, neighbor_count)
retrieve_resolved_evidence(question_ids)
inspect_style_state(scene_type)
finalize_translation(block_translations, used_resolution_ids, unresolved_ids)
submit_lexical_anchors(repeated_forms, target_modes, confidence)
```

`finalize_translation` 只是提交候选。Kernel 仍会运行结构和完整性校验。

### 6.3 修复工具

```text
inspect_validation_failures(translation_candidate_id)
retrieve_failure_evidence(failure_ids)
submit_repaired_translation(block_translations, addressed_failure_ids)
```

修复按 block ID 合并最小补丁；若补丁引入新的确定性失败，可在全局三轮硬预算内继续。
三轮后仍失败则返回人工处理，不无限循环。

## 7. 问题到检索的桥接

Question Scout 不返回自由文本任务，而返回 `EvidenceQuestion`：

```text
id
type
subject_ids
surface_forms
relation_families
translation_impact
visibility_channel
target_global_index
suggested_query_operations
stop_condition
```

Kernel 拒绝模型凭空发明的 subject ID。合法 subject 必须来自：

- 当前目标原文中的已定位 span；
- 已知 lexeme/concept；
- 某次工具返回的候选 ID。

Evidence Resolver 可以迭代改写查询，但不能提交没有 evidence ID 的肯定事实。
如果没有足够证据，合法结果是 `unresolved`。

## 8. 翻译 Agent 输入

Translation Agent 初始只接收强制最小包：

1. 当前 island 完整英文原文；
2. 原文结构和段落边界；
3. 已锁定或高置信必须译名；
4. 当前叙述位置和可见性边界；
5. 上一块英文尾部和活动中文尾部；
6. 已验证的高影响局部判断；
7. 调用工具和结束条件。

可选世界知识、长程证据、风格锚点和远距离译文不预先塞入。Agent 认为必要时
通过 typed tools 请求，Kernel 按预算返回。

即使 Agent 不主动查询，Kernel 也会根据未解析专名、指代冲突、称谓风险和结构
风险强制打开最小问题集，避免完全依赖模型的自知之明。

## 9. 预算与停止

提丰试验实现后的硬上限：

- Question Scout：最多 3 个纠错 turn，且只开放 `submit_questions`；
- Evidence Search：最多 2 个 turn、6 次检索工具；
- Evidence Finalizer：最多 2 个 turn，独占 `finish_research`；
- 研究工具：全局最多 10 次调用；
- 单次工具最多 8 个证据；
- 研究证据正文累计最多 12,000 字符；
- Lexical Anchorer：最多 2 个 turn；
- 翻译与锚点：全局最多 10 个 turn、18 次工具调用；
- Repair Agent：每次最多 1 个 turn，全局最多 3 个 turn；
- 整个试验模型调用硬上限：20；
- 整个试验墙钟软目标：15 分钟，硬上限：30 分钟。

达到预算后自动降级：保留未决问题、生成 provisional 译文、输出警告。不得扩大
为 0..223 前缀扫描。

## 10. 并发与幂等

- 同一项目、作用域、协议版本和模型组成稳定 run key；
- 相同 run key 同时只能有一个 lease owner；
- 查询结果按 normalized query hash 缓存；
- 模型结果按 prompt/tool schema/model/source hash 缓存；
- 父 run 取消时向所有 Pi session 传播 abort signal；
- Agent 工具读取可并行，但最终候选按 `global_index` 稳定排序；
- 最终提交由单写者事务执行。

## 11. 试验范围

### 11.1 包含

- 独立 `translator-v5` TypeScript 原型；
- 读取现有 V4 SQLite 的源文和稳定术语；
- 在内存或独立 pilot DB 中保存 V5 event log；
- Pi Question Scout；
- Pi Evidence Resolver；
- Pi Translation Agent；
- 一次可选 Repair Agent；
- 提丰五块 TXT 译文；
- 运行审计 JSON；
- 与 V4 冷/热运行指标比较。

### 11.2 不包含

- 全书 Book Director；
- 全量概念重建；
- 全书翻译；
- EPUB 导出；
- Web 人工界面；
- Python V4 数据迁移；
- 删除或替换现有 Python 实现；
- 通用 bash/file Agent；
- 多模型投票。

## 12. 目录建议

```text
translator-v5/
  package.json
  tsconfig.json
  src/
    domain/
      state.ts
      evidence.ts
      translation.ts
    kernel/
      budget.ts
      capabilities.ts
      event-log.ts
      executor.ts
    storage/
      v4-read-adapter.ts
      pilot-store.ts
    index/
      evidence-index.ts
      query-compiler.ts
    agents/
      pi-runtime.ts
      question-scout.ts
      evidence-resolver.ts
      translator.ts
      repairer.ts
    tools/
      research-tools.ts
      translation-tools.ts
      repair-tools.ts
    validators/
      structure.ts
      evidence.ts
      completeness.ts
    cli.ts
  test/
```

## 13. 验收标准

### 13.1 架构正确性

- Pi 只看到显式注册的 typed tools；
- 没有 bash、任意文件和任意 SQL；
- 非法 subject/evidence ID 被 Kernel 拒绝；
- `narrative_before_target` 不返回目标之后的证据；
- `translator_global` 结果不能进入 narrative state；
- 超预算调用被拒绝并触发可审计降级；
- 相同 run key 不产生并发重复模型调用；
- Pi 无法直接提交活动译文。

### 13.2 局部性

- 不调用 V4 narrative premap；
- 不逐块让模型读取 0..218；
- 模型读取的非目标证据总量不超过 12,000 字符；
- 总模型调用不超过 20；
- 目标五块可以在没有 V4 叙事快照的条件下完成。

### 13.3 质量与完整性

- 五块原文全部有对应译文；
- 段落结构和非空内容通过确定性校验；
- `Typhon`、`Piaton`、`Severian`、`Claw` 等命中项有一致依赖记录；
- 译文中的高影响判断可以追溯到 evidence ID 或明确标记 unresolved；
- 生成可供用户直接阅读的 TXT；
- 生成包含问题、工具调用、证据、预算、耗时和降级信息的审计报告。

### 13.4 性能

- 墙钟时间硬上限 30 分钟；
- 目标 15 分钟以内；
- 不允许以读取 0..223 的模型前缀扫描换取质量；
- 报告分别列出研究、翻译、修复的模型调用和时间。

## 14. 对照实验

V4 已知指标：

```text
cold prefix premap: 224 blocks / 1,422,067 chars / ~3h25m
warm target translation: 5 blocks / 33,307 chars / ~6m41s
```

V5 报告必须列出：

```text
target source chars
off-target evidence chars
agent turns
tool calls
model calls by role
input/output tokens if provider reports
wall time by role
cache hits
unresolved questions
validation failures
repair count
final output path
```

速度通过不代表质量通过。输出交给用户阅读，并在后续使用现有盲评系统与 V4 译文
进行 A/B；本试验先验证架构能否在严格局部预算下得到可读且有证据依赖的译文。

## 15. 失败策略

- Pi runtime 不支持当前模型工具调用：使用同一 typed action schema 的 JSON action
  loop 适配器完成试验，并在报告中标明，不伪装为原生 tool call；
- 单个研究问题失败：标记 unresolved，继续翻译；
- 单个翻译 island 失败：按失败项提交最小 block 补丁；
- 确定性校验失败：在全局三次修复预算内迭代，仍失败则返回人工处理；
- 预算耗尽：停止增加知识，输出 provisional 结果和完整警告；
- 进程终止：lease 到期后可恢复，不能产生第二个并发 run；
- 任何持久化不变量失败：事务回滚，不覆盖 V4 数据。

## 16. 后续决策门

只有当提丰试验同时满足局部性、权限、完整性和性能要求，才讨论：

1. Book Director；
2. 全书并行 Agent islands；
3. 全量术语/共指 Agent；
4. TypeScript V5 对 Python V4 的正式替代；
5. EPUB 和人工审阅界面。

如果 Pi 仅增加调用而没有改善按需取证和译文质量，则保留 Agent Kernel 接口，
替换策略运行时，而不是推翻确定性内核和 typed tools。
