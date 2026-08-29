# FolioLoom 运行中术语控制与审计式修词设计

**日期：** 2026-08-29

**状态：** 已实现并完成离线验收

**目标版本：** v1.7.0
**适用范围：** V5 lossless runner、Electron 桌面端、CLI、私有 Codex skill

## 1. 背景

v1.6.0 已经具备版本化知识、人工修订和回滚、影响块定位、术语使用回执、
稀疏重验、新译文版本以及严格导出门禁，但用户操作仍存在三处断点：

1. 桌面端可以在整书翻译期间打开“术语与记忆”，但知识命令在任一窗口为
   `running` 或 `staged` 时直接返回 `KNOWLEDGE_EDIT_BUSY`；
2. `--glossary` 的语义哈希属于 run identity，续跑时不能修改，且静态
   glossary 的优先级目前高于书内人工知识；
3. term/entity/alias 没有位置适用域，影响列表也没有形成
   “预览—执行—重验—回滚—重新导出”的用户级作业。

本设计不增加第二套翻译器。它把人工术语控制接到已有的知识快照、术语回执、
稀疏重验和译文版本链上，并让桌面端与 skill 共享同一应用服务。

## 2. 目标

- 用户可在翻译运行期间读取、审查和提交术语修改；修改在安全 wave 边界原子生效。
- 静态 glossary 保持不可变种子身份；人工覆盖作为更高优先级的版本化知识保存。
- 同一实体或术语可以在不同章节/文本区间采用不同中文称呼。
- 修改前可以预览精确影响范围、冲突、预计本地修复数和模型重译数。
- 一次修词形成可恢复、可回滚、可审计的作业，不直接破坏当前译文。
- 桌面端、CLI 和 Codex skill 使用相同的类型化命令、计划哈希和状态机。
- 严格导出必须等待所有适用的知识变更与修词任务收敛。

## 3. 非目标

- 不允许任意 SQL、直接编辑 `book.db` 或对整本中文执行无来源约束的字符串替换。
- 不在 v1.7.0 实现多人协作、云端同步或权限系统。
- 不在 v1.7.0 完成完整双语逐段编辑器；审阅队列和逐段改译留给 v1.8.0。
- 不在一个已经发出的模型请求中途替换知识快照。
- 不允许自然语言“前期/后期”直接成为持久范围；界面必须解析为稳定原文块边界。

## 4. 核心概念

### 4.1 不可变种子与人工覆盖

`--glossary` 继续参与 run identity，只负责证明创建/恢复运行时使用的是同一份种子。
编辑种子条目时，系统创建书籍作用域的人工规则，不改写源文件或历史 metadata。

同一原文形式的确定性优先级为：

1. 当前块适用的人工范围规则；
2. 人工全书规则；
3. 当前项目人工规则；
4. 用户明确附加的全局规则；
5. glossary 种子；
6. legacy 锚点；
7. 模型知识。

同一优先级、同一适用范围出现不同目标译法时必须产生冲突，不能以后写覆盖前写。

### 4.2 实体身份与表面称呼分离

实体保留稳定 `entityId`。中文表面称呼由 `TermRenderingRule` 决定：

```text
ruleId
conceptId
entityId?
sourceForms[]
target
allowedTargets[]
policy: locked | preferred | contextual
selector
priority
authority
revisionId
renderFingerprint
```

`selector` 只允许两种规范形式：

```text
whole_book
block_range(sourceVersion, startBlockId, endBlockId,
            startGlobalIndex, endGlobalIndex)
```

块区间两端均包含。保存时必须验证 block ID 属于同一 source version、顺序合法，
并把 global index 作为可快速查询但不可独立信任的冗余值。源版本改变时规则必须
重新定位或显式失效。

### 4.3 有效规则解析

对每个原文块和规范源形式，解析器只返回一个有效规则。排序键固定为：

```text
authority rank DESC,
range specificity DESC,
explicit priority DESC,
ruleId ASC
```

前三项完全相同但目标译法不同即为 `TERM_RULE_CONFLICT`。解析结果转换为现有
`StableTerm` 和 lexical concept 投影，因此提示构建、term usage 回执、校验和
稀疏重验继续复用。

## 5. 运行中修改状态机

新增持久化 `knowledge_change_queue`。提交命令时：

- 当前没有 `running/staged` 窗口：立即按现有事务提交；
- 当前存在在途窗口：校验并持久化为 `queued`，立即把 request ID 返回用户；
- 同一对象已有未应用命令：后续命令返回显式队列冲突，用户可取消旧命令后重提。

状态为：

```text
queued -> applying -> applied
                  \-> rejected
queued -> cancelled
```

runner 在每个 wave 边界、领取下一窗口之前调用 `applyQueuedKnowledgeChanges()`。
每个请求保持幂等；进程崩溃后 `applying` 恢复为可重放状态。一个失败请求不能阻塞
其他无关请求。应用结果记录新 generation、snapshot ID 和拒绝原因。

在途翻译继续绑定旧 snapshot；提交门和稀疏重验负责判断其结果能否直接采用，
不得取消一个已经返回合法结果的请求来伪造“即时生效”。

## 6. 审计式修词作业

### 6.1 计划

`planTermRetrofit` 输入：

- run ID；
- 一个已激活或待激活的规则 revision；
- 作用范围；
- 预期 knowledge generation/snapshot ID。

计划只从不可变原文、活动译文和术语回执计算，输出：

- 命中的原文块；
- 当前译文版本和旧规则绑定；
- `noop`、`local_repair`、`model_retranslate` 或 `human_required` 分类；
- 预计模型调用块数；
- 冲突和导出阻塞项；
- canonical plan hash。

计划过期时不得执行。

### 6.2 安全局部修复

只有同时满足以下条件才允许本地替换：

- 原文出现由 term usage 回执唯一标识；
- 旧 `targetSurface` 在对应译文块中只有一个规范匹配；
- 只改变目标表面形式，实体身份、source forms、策略、适用范围和 discourse role 不变；
- 新旧表面均不是空串，且不会改变段落数量或结构槽位；
- 替换后通过完整的术语与结构验证。

其他情况全部进入现有模型重译路径。局部修复和模型重译都新增 translation version，
旧版本保持 inactive，不执行原地 UPDATE。

### 6.3 状态与回滚

作业状态为：

```text
planned -> running -> completed
                  \-> needs_attention
                  \-> failed
planned -> cancelled
completed/needs_attention -> rolled_back
```

实现阶段收紧了取消语义：尚未执行的 `planned` 作业可以直接取消；作业一旦进入
`running`，可能已经生成局部译文版本或把模型重验证任务交给执行器，此时不伪造
取消。系统让它从持久 item 继续收敛，随后由用户回滚。这样可避免一个已在执行的
模型任务晚到后覆盖“已取消”状态。

每个 item 单独持久化并可从块边界恢复。回滚创建新的规则修订，并重新激活作业前
的译文版本；回滚本身写入事件，不删除历史。

`knowledge_block_impacts.status` 必须随 item 进入 `acknowledged` 或
`retranslated`，不能永久停留在仅展示用途的 `pending`。

## 7. 数据库与迁移

schema v5 新增：

- `knowledge_change_queue`：持久化安全边界命令；
- `term_retrofit_jobs`：计划、状态、规则 revision、generation、plan hash；
- `term_retrofit_items`：块级分类、旧/新 translation ID、状态和结果；
- lexical concept applicability/authority 投影字段，或等价的规范 JSON 字段。

迁移要求：

- v2/v3/v4 均可在读写打开时迁移到 v5；
- 只读打开旧 schema 不执行迁移；
- 任一故障注入点失败后 user_version、marker、fingerprint 和表集合保持旧版本完整；
- 旧 term 没有 selector 时解释为 `whole_book`；
- 旧 run、旧 glossary hash 和旧译文 ID 不改变。

## 8. 应用服务与接口

新增 `TerminologyControlService`，它只接收 store/run 身份和类型化 DTO。Electron IPC
和 CLI 都是适配器，不各自实现规则解析或 SQL。

CLI 至少提供：

```text
book knowledge list
book knowledge term-upsert
book knowledge queue-status
book knowledge queue-cancel
book retrofit plan
book retrofit apply
book retrofit status
book retrofit rollback
```

所有命令默认输出 UTF-8 JSON；路径和自由文本必须通过参数值传入，不能拼接 SQL。

桌面端在“术语与记忆”中增加：

- 全书/章节或块区间选择；
- 保存结果的 `applied/queued/rejected` 状态；
- 影响预览和预计修复分类；
- 启动修词、查看进度、取消未执行计划和回滚已执行作业。

skill 通过 CLI 操作，不直接读写 SQLite。长任务期间由持久化状态而非对话上下文保存
控制信息；用户插入修改后，可在下一安全边界继续同一 run。

## 9. 严格审计与导出

严格 audit/export 新增阻塞条件：

- 存在 `queued/applying` 知识命令；
- 存在未完成或需要人工处理的 retrofit item；
- 当前活动译文仍绑定非有效规则 revision；
- 存在未解决的同优先级范围冲突；
- impact 仍为 pending 且对应规则会改变活动译文。

部分导出可以显示这些状态，但最终交付不得使用 `--allow-incomplete` 绕过。

## 10. 失败、并发与隐私

- 所有写操作使用 request ID 幂等和 generation/revision 乐观锁。
- SQLite busy、进程中断和网络失败只在安全边界重试，不扩大替换范围。
- 计划和事件不得保存整本原文副本；item 只保存 block ID、哈希、短诊断和版本 ID。
- 不把用户词汇表、译文或项目路径发送给与当前翻译不同的服务。
- UI/CLI 错误必须包含当前状态、是否已写入和可执行的下一步。

## 11. 验收标准

### 11.1 范围规则

- 同一 source form 在块 0—9 使用译名 A，块 10—19 使用译名 B，其他块使用默认规则；
- 端点、相邻范围和 source version 校验正确；
- 同级重叠冲突被拒绝，较高人工覆盖稳定胜出；
- 同形但属于其他 concept 的译文不被目标中文字符串误伤。

### 11.2 运行中修改

- 在窗口运行期间提交不会返回 busy，而是 durable `queued`；
- 当前窗口保持旧 snapshot，下一 wave 使用新 snapshot；
- 崩溃重启后命令只应用一次；
- 同对象并发编辑得到确定冲突，不发生最后写入者覆盖。

### 11.3 修词

- dry-run 数量和实际 item 完全一致；
- 唯一安全表面替换生成新译文版本；歧义位置进入模型重译或人工处理；
- 中断后从未完成 item 继续；
- 回滚恢复旧规则与可交付译文，但保留完整历史；
- 作业完成后 audit、strict export、verify-export 全部通过。

### 11.4 控制面

- 桌面端和 CLI 对同一请求产生相同 plan hash；
- skill 可以列出、提交、等待、执行和回滚，不手改数据库；
- 旧 v1.6 项目迁移后仍能 resume 和 export。

## 12. 实施顺序

1. 纯范围规则类型、验证和解析器；
2. schema v5 与故障安全迁移；
3. glossary/knowledge/lexical concept 的统一有效规则投影；
4. 持久化知识变更队列和 runner wave 边界；
5. retrofit plan、item 状态机、本地修复与现有重译执行器接合；
6. audit/export 阻塞；
7. 共享应用服务、CLI、桌面端和 skill；
8. 完整测试、文档和真实小型项目验收。

## 13. 实现验收记录

- 核心 Node/TypeScript 测试：989 项，988 通过，1 项因当前 Windows 环境不支持
  文件符号链接而跳过，0 失败；
- 桌面主进程测试：114 项，113 通过，同一符号链接能力项跳过；
- 桌面 React 测试：67/67 通过；
- 核心与桌面 TypeScript 类型检查通过；Electron Vite 生产构建及 preload 校验通过；
- schema v2/v3/v4 到 v5 的迁移和故障注入测试通过；
- 真实 SQLite 小项目覆盖了运行中持久排队、计划/取消、回执驱动的新译文版本、
  模型重验证委派、回滚、审计和严格导出门禁；
- 仓库级与用户全局私有 `folioloom-translate` skill 均通过结构校验。
