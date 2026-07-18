# V5 无损工程加固设计

日期：2026-07-18

## 1. 背景与决策

`Little, Big` 冷启动验证了 V5 的全书运行、断点续跑、按需证据和导出能力，同时暴露了若干工程风险：重复章节 ID 曾覆盖跨卷内容；章节极短时模型调用成本失衡；按需证据只能处理模型主动发现的问题；模型升级后需要防止不同运行版本混入同一导出。

本设计只解决工程正确性，不根据 `deepseek-v4-flash` 的语义能力增加永久的习语检测、回译或双模型审校。未来 DeepSeek 模型的翻译质量由模型、翻译提示和用户抽检评价；Harness 必须保证无论使用哪个模型，都不会静默丢失、重复、乱序、错投影或串用数据。

正常翻译路径不增加模型调用。Recovery Pi 只在罕见且存在多个安全恢复选项的工程故障中调用，额外模型成本应远低于总调用量的 10%。

## 2. 目标与非目标

### 目标

- 从原始文件到 TXT/EPUB 建立可审计的数据血缘。
- 使章节识别错误最多影响结构标注，不能影响内容完整性。
- 用数据库约束和运行时不变量阻止错误状态进入活动译文。
- 把逻辑分块、翻译上下文和物理 API 请求解耦。
- 保证中断、并行、模型升级和源文件变化下的版本一致性。
- 提供确定性优先、Pi 受限参与、可回滚的恢复机制。
- 通过属性测试和故障注入覆盖尚未见过的输入形态与失败时点。

### 非目标

- 不自动判断译文文学质量。
- 不为某个具体习语、专名或小说格式写翻译层特例。
- 不自动修正 OCR、拼写或作者有意使用的异常形式。
- 不给 Pi 任意 Shell、SQL 或文件写入能力。
- 不允许审计失败后生成伪装成完整版本的导出物。

## 3. 总体架构

数据流分为七个可独立验证的阶段：

```text
raw source
  → canonical source + position map
  → source spans + structure annotations
  → logical blocks
  → logical windows / physical requests
  → translations + knowledge snapshots
  → strict TXT/EPUB export
```

所有派生实体都引用上游实体的 ID、范围、哈希和版本。原始文件是唯一内容真相；章节树、blocks、windows、译文和导出文件均可从其血缘向上追溯。

另设一个只读 Auditor，从原始文件和 SQLite 重新计算覆盖、顺序和哈希，不复用主流程的通过/失败判断函数，以降低共同缺陷风险。

## 4. 无损源文本账本

### 4.1 两种源表示

- `raw source`：不可变原始字节、文件大小、SHA-256 和检测到的编码。
- `canonical source`：供解析和模型读取的 Unicode 文本，统一换行和允许的规范化形式。

系统保存 raw byte、decoded scalar 和 canonical character 之间的位置映射。BOM、CRLF 转换和格式控制字符即使不投影给模型，也必须登记为已解释区间，不能静默消失。

编码由 BOM、显式配置和确定性检测顺序选择。多个候选无法可靠区分时停止等待人工指定；不得用替换字符继续构造“完整”账本。

### 4.2 区间与结构标注

解析器只产生附着于原文区间的标注，例如 `volume_heading`、`chapter_heading`、`prose`、`epigraph`。结构标注不是内容容器，不拥有正文，也不参与内容唯一性。

卷、章和标题 ID 由 source version 与标注起始位置构成，标题文字只是属性。重复的 `Chapter I`、缺失标题或错误标题不会覆盖其他内容。

不进入翻译的版权信息、目录或站点尾注必须具有显式 `excluded` 记录、确定性策略代码、原文范围和哈希。Recovery Pi 无权把未覆盖区间改成 `excluded`。

### 4.3 内容身份与覆盖不变量

block 身份由 source version、无重叠原文范围和内容哈希产生，不依赖章节名称。每个 canonical 可翻译字符必须恰好属于一个 block；区间不能有空洞或重叠。

源文件变化时创建新 source version。旧版本保持只读；相同内容只能通过显式 remap 复用，remap 必须核对内容哈希、出现位置和邻接上下文，禁止仅凭相同短文本静默复用。

## 5. 强制不变量与阶段契约

### 导入契约

- 所有 raw byte 均映射到 canonical 字符或带理由的非语义区间。
- canonical 可翻译范围覆盖率恰好 100%，重叠率为 0。
- 原文件、encoding、canonical text 和位置映射哈希一致。

### 分块契约

- 每个可翻译 source span 恰好属于一个 block。
- block 顺序严格按原文范围递增。
- 重建相同 source version 和协议时，block 计划确定性一致。

### 分窗契约

- 每个 block 恰好属于一个 logical window。
- logical window 不重复、不跳号，且引用的 block source hash 匹配。
- 上下文超限通过重新分窗解决，禁止 API 层静默截断原文。

### 提交契约

- 译文只能引用当前 translation run 中声明的 block ID。
- 每个已完成 block 恰有一个活动译文版本。
- 窗口译文、词汇、记忆、尾部状态和窗口状态在一个事务中提交。
- 并行窗口只能写入暂存候选，活动状态按原文顺序晋升。

### 导出契约

- 严格导出要求所有可翻译 blocks 已完成。
- 所有译文属于同一 source version、translation run、prompt protocol 和兼容的 knowledge lineage。
- source hash 或范围不符时拒绝导出。
- 允许缺块的预览导出必须在文件元数据和文件名中明确标识 `partial`。

## 6. 分块与执行单位

系统区分三层单位：

1. `source span / block`：永久、无损的数据单位。
2. `logical window`：可重新规划的翻译上下文单位。
3. `physical request`：一次 API 调用，可承载一个普通窗口或多个极短窗口。

logical window 使用段落边界候选和代价函数规划：

```text
cost = length_deviation
     + structural_boundary_penalty
     + paragraph_split_penalty
     + tiny_window_penalty
```

卷界与明确章节界具有高惩罚，但只是语义边界，不是内容存储边界。结构标注不可靠时，系统仍可按连续段落和 token 数产生完整窗口。

物理微批请求可以包含多个极短 logical windows，但返回值必须按 window ID 分组。每个窗口独立校验和提交；单个窗口失败不能污染同一请求中的其他合法结果。

## 7. 并发、知识快照与运行版本

每一并行波只读取同一个不可变 `knowledge_snapshot_id`。并行结果先暂存，再按原文顺序提交。两个窗口对同一术语或事实产生冲突时禁止最后写入者覆盖：冲突记录保留，活动项降为 `needs_revalidate` 或 `contextual`，下一快照不投影未解决冲突。

译文记录至少携带：

- `source_version`
- `block_plan_version`
- `window_plan_version`
- `prompt_protocol_version`
- `model_provider`
- `model_id`
- `knowledge_snapshot_id`
- `translation_run_id`

更换 DeepSeek 模型时创建新的 translation run。原文账本和符合兼容政策的证据知识可以复用，译文不能无提示混合。严格导出只能选择一个完整 run。

上下文组装使用确定性 token 预算：目标原文不可裁剪；稳定术语、位置可见记忆、局部尾部和文风状态分别有上限并记录哈希。目标原文超限时重新分窗，外部提供方错误不得伪装成人工翻译问题。

## 8. 知识记录生命周期

术语和叙事事实使用统一状态机：

```text
candidate → provisional → active
                     ↘ needs_revalidate / contextual
                     ↘ superseded
```

每项保存原文形式、标准化形式、译名或事实、原文位置、evidence IDs、模型与协议来源、首次出现、最后验证位置、状态和变更原因。

活动知识是从追加式历史记录计算出的视图。候选晋升后不再参与普通候选查询，但历史不物理删除；冲突、模型升级或 source remap 时可以重算活动视图。知识内容仍由模型决定，Kernel 只保证来源、状态转移、可见位置和快照一致。

## 9. 失败、恢复与 Recovery Pi

### 9.1 失败分类

结构识别失败但无损覆盖仍成立时自动降级，不阻塞翻译。覆盖、编码、哈希、数据库或版本一致性无法证明时进入 `preflight_blocked`，禁止模型调用和严格导出。

事故报告必须包含稳定错误码、阶段、精确范围、违反的不变量、有限原文片段、已尝试策略和建议动作，不能只返回自由文本异常。

### 9.2 确定性恢复优先

错误只有一个安全处理时 Kernel 直接执行，例如：

- 章节解析失败 → 位置驱动的平铺标注；
- 超大窗口 → 在段落或句子边界重新规划；
- 中断残留 `running` → 恢复为 `pending`；
- source hash 改变 → 隔离旧 run；
- 导出缺块 → 恢复对应 pending 窗口。

正常解析再次失败时可启用无结构保底解析器，只按连续原文范围、空行和 token 数建立 blocks。保底解析器仍必须通过同一覆盖审计。

### 9.3 受限 Recovery Pi

存在多个安全策略且确定性规则不能唯一选择时，Recovery Pi 最多尝试一轮。Pi 只看到结构化事故、有限局部证据、已尝试策略和允许动作；只能调用类型化恢复工具。

Pi 不得修改 raw source、执行任意 SQL/Shell、改变哈希、增加 excluded 范围、绕过审计、编造译文或提升预算。恢复策略来自代码层声明式注册表；提示词、工具 schema、参数限制、最大尝试次数和复验要求均从同一注册表生成。

Pi 选择的策略由 Kernel 在影子版本或事务中执行。Auditor 通过后原子晋升；失败则丢弃影子版本，进入确定性保底路径或人工处理，不允许 Pi 循环试错。

恢复状态机为：

```text
preflight_blocked
→ recovery_planning
→ recovery_trial
→ auditing
→ resumed | quarantined
```

每次尝试记录恢复前后哈希、策略、参数、执行结果和审计结果。

## 10. 存储与审计

V5 工作库新增或版本化以下概念：

- `source_versions`
- `source_ranges`
- `structure_annotations`
- `logical_blocks`
- `window_plans` 与 `window_membership`
- `translation_runs`
- `translations`
- `knowledge_records` 与 `knowledge_snapshots`
- `recovery_runs`
- `events`

数据库启用外键、唯一性和显式状态转移检查。事件历史追加写入，不保存 API key 或隐藏推理。SQLite 事务损坏时只能从已验证源账本、事件记录和哈希匹配的已提交译文重建；禁止原地猜测修补。

## 11. CLI 与运维行为

- `book doctor`：模型调用前验证源账本、覆盖、计划和版本。
- `book audit`：任意时刻由独立 Auditor 重新计算不变量。
- `book recover`：执行确定性恢复，必要时调用一次受限 Recovery Pi。
- `book verify-export`：核对 TXT/EPUB 中每个译文单元对应的 block、source hash 和 run。

`book run` 默认先执行 doctor；强制跳过 doctor 的开关不进入正式 CLI。无人值守模式可以自动恢复安全故障，但不能绕过编码不确定、无法恢复的源损坏或持续性存储错误。

## 12. 测试策略

### 属性测试

随机生成具有重复章节名、无章节、数千极短章节、单个超长段落、混合换行、BOM、Unicode 控制字符、目录与正文同名、空标题和重复段落的书籍。所有样本必须满足覆盖 100%、重叠 0、每 block 恰属一窗、重建确定性和严格导出版本一致。

### 故障注入

在导入、计划、模型调用、暂存、事务提交和导出各时点强制终止；模拟 API 超时、无效凭据、畸形工具结果、数据库锁、磁盘写入失败、原文件运行中变化、未知 block ID、缺块、重复块和并行知识冲突。

任意时点恢复后的最终活动状态必须与无中断运行一致，或明确进入 `quarantined`；不得出现静默部分成功。

### 独立审计测试

测试需要直接篡改派生数据库，证明主库即使内部看似自洽，Auditor 仍能从原文件发现缺口、重叠、乱序、哈希和运行版本混杂。Auditor 不得调用主流程的覆盖验证函数。

## 13. 迁移与实施边界

V5 新 schema 使用新的 schema/protocol version。现有 V4/V5 数据不原地升级：必须从原始小说文件建立 source ledger，再把旧稳定词汇和译文作为带 provenance 的迁移候选导入。没有原始文件时不能签发“无损认证”。

迁移后的译文只有在 source text、hash 和显式 span remap 全部匹配时才能进入新 run；否则保留为参考候选。`Little, Big` 的四个测试 blocks 可以用于迁移验证，但不要求保留为正式全书 run。

## 14. 验收标准

- 正常路径不新增语义审校模型调用。
- doctor/audit 对整本书为线性本地操作，目标额外墙钟开销低于 5%。
- 章节解析器完全失效时仍能生成覆盖 100% 的保底 block 计划。
- 所有属性测试和故障注入测试满足不变量。
- Recovery Pi 无任意写权限，失败尝试可完全回滚。
- 并发运行不会发生知识最后写入者覆盖。
- 模型、提示协议或源版本不同的译文不能混入严格导出。
- TXT/EPUB 可由 `verify-export` 反查完整血缘。

