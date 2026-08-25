# FolioLoom 稀疏快照重验设计

日期：2026-07-26  
目标：修复知识只向后生效、早期译文不会随最终概念知识收敛的问题  
首个真实回归样本：卡夫卡《变形记》德文版中的 `Prokurist`

## 1. 背景与根因

FolioLoom 当前具备无损原文账本、追加式知识快照、按波次并行翻译、
结构完整性校验和 `knowledge_block_impacts` 影响记录。真实翻译
《变形记》时，工程链路完整通过，但 `Prokurist` 在开头三处被译为
“秘书主任”，后续四十余处被译为“主事”。

这不是单次提示词偶然失效，而是现有状态模型存在四个缺口：

1. 词法锚点只有 `stable/contextual` 二分。`contextual` 决定被用作
   “以后不再扫描此词”的负缓存，却不作为翻译可见的概念知识。
2. 模型可以提交 `lexical_anchor`、`lexical_choice`、
   `translation_choice` 等任意 `kind`。相同原词在不同 `kind` 下不会
   发生冲突收束，也不一定能转换成正式术语。
3. 译文记录了生成时的 `snapshot_id`，但新知识生效后，没有根据
   快照代际使受影响旧译文失效。
4. 当前 `complete` 审计证明原文覆盖、块/段落和账本谱系完整，不证明
   译文已经符合最终知识。

本设计把译文与概念知识建立稀疏、可版本化的依赖关系。知识变化时，
系统只检查实际包含该概念、且由旧知识快照产生的文本块。

## 2. 设计原则

1. **概念稳定与表面措辞分离**  
   同一职位、人物或专名拥有稳定概念身份；中文表面形式可以受
   叙述、呼告、头衔等语境影响。
2. **只处理真实依赖**  
   不按“知识数 × 全书块数”遍历，不无条件重读或重译全书。
3. **快照而非位置决定新旧**  
   并行窗口的位置可能靠后，但仍使用旧快照；是否需要重验以
   `snapshot_id` 和渲染指纹为准。
4. **先本地判断，后模型修复**  
   旧译法仍被新策略允许时只更新验证记录；只有不符合时才调用模型。
5. **旧译文不可静默覆盖**  
   修复和重译必须生成新译文版本，旧版本保留完整谱系。
6. **终局审计只证明收敛**  
   终审不承担第一次发现问题；严格导出要求不存在过时依赖。

## 3. 三层术语模型

### 3.1 概念层 `LexicalConcept`

模型产生的翻译敏感词必须先归一化为闭合 schema，不能再把任意
`kind` 直接当成可执行术语。

```text
concept_id
normalized_subject
source_forms[]
semantic_class
canonical_target
policy: locked | preferred | contextual
allowed_realizations[]
confidence
visibility
render_fingerprint
revision_id
```

`semantic_class` 至少区分：

- `proper_name`
- `unique_title`
- `technical_term`
- `role`
- `form_of_address`
- `ordinary_word`

只有前四类默认进入概念系统。普通词继续使用负缓存，不建立全书依赖。
`form_of_address` 只有与一个已知概念绑定时才进入表面表达规则。

`render_fingerprint` 只包含会影响译文的字段。证据数量、说明文字或
置信度轻微变化而允许译法不变时，指纹保持不变，不触发重验。

### 3.2 表达策略层 `RealizationPolicy`

概念允许一个中性工作译名和有限的语境实现：

```text
default_target
allowed_targets[]
rules[
  discourse_role: narrative | vocative | title | other
  target
]
```

例如：

```json
{
  "concept": "company-proxy-officer",
  "sourceForms": ["Prokurist", "Prokuristen"],
  "defaultTarget": "主事",
  "policy": "contextual",
  "allowedTargets": ["主事", "主事先生"],
  "rules": [
    {"discourseRole": "vocative", "target": "主事先生"}
  ]
}
```

`contextual` 不再表示“不要把知识交给翻译器”，而表示“概念必须一致，
表面形式可以在允许集合内随语境变化”。

### 3.3 出现层 `TermUsage`

翻译模型在返回每个块译文时，同时返回有界的结构化使用记录：

```text
block_id
concept_id
source_form
source_start
source_end
discourse_role
target_surface
```

正文不插入标记。验证器本地检查：

- 原文偏移确实对应 `source_form`；
- `target_surface` 确实出现在该块译文对应段落；
- 表面译法符合当前概念策略；
- 当前块内的同一出现不被重复或遗漏申报。

## 4. 稀疏出现索引

新增按概念而非按修订重复保存的出现索引：

```text
concept_occurrences(
  run_id,
  concept_id,
  source_version,
  block_id,
  occurrence_count,
  source_spans_json,
  PRIMARY KEY(run_id, concept_id, block_id)
)
```

现有 `matchKnowledgeImpacts()` 的 Aho–Corasick 多模式匹配器继续复用。
一批新概念或新别名只对活动源版本做一次批量扫描，复杂度为：

```text
O(原文长度 + 实际命中数量)
```

同一概念后续修订只复用已有 occurrence，不重新复制全部影响边。
新增 source form 时只为新增 forms 做一次批量回填。

## 5. 译文依赖

新增：

```text
translation_concept_bindings(
  translation_id,
  concept_id,
  applied_revision_id,
  applied_render_fingerprint,
  term_usages_json,
  validation_status,
  validated_revision_id,
  updated_at,
  PRIMARY KEY(translation_id, concept_id)
)
```

`validation_status`：

- `clean`
- `pending`
- `validating`
- `stale`
- `warning_stale`

每个活动译文仍保留原有 `snapshot_id`。绑定表只记录当前块实际命中的
概念，不复制完整知识快照。

## 6. 知识变化与候选定位

新概念修订生效时：

1. 比较新旧 `render_fingerprint`；
2. 指纹相同则不创建重验；
3. 从 `concept_occurrences` 取出包含该概念的块；
4. 只保留活动译文使用旧 revision/fingerprint 的块；
5. 为同一活动译文合并多项变化，只创建一个重验任务。

候选集合为：

```text
occurrences(concept)
∩ active_translations
∩ bindings.applied_render_fingerprint != current_render_fingerprint
```

它不是“前半本”集合。后文位置的并行窗口若使用旧快照，也会命中；
位置更早但已经按新策略验证过的块不会重复命中。

## 7. 并行提交门

每个翻译波使用一个冻结知识快照。波内建议在波结束时按概念合并，
每个概念最多产生一个新活动修订。

窗口提交分两种情况：

1. **提交时知识仍与输入快照一致**  
   正常验证、提升译文并记录 bindings。
2. **提交时相关概念已发生变化**  
   在提升为活动译文前运行本地策略检查：
   - 仍符合新策略：直接以最新 revision 写 bindings；
   - 不符合：该候选不提升，窗口用最新快照进入一次定向修复或重译。

已经在更早 ordinal 提升的活动译文由稀疏重验队列处理。这样既不会
因为无关知识变化使整波失效，也不会让晚完成的旧快照结果静默通过。

## 8. 重验状态机

### 8.1 确定性检查

首先根据 `TermUsage` 和新策略判断：

- `resolved_noop`：原译仍被允许，只更新 binding；
- `repair_required`：概念一致，但表面译法不允许；
- `retranslate_required`：概念、指称或语境角色发生实质变化；
- `uncertain`：本地信息不足。

### 8.2 模型动作

- `repair_required`：只发送受影响块、精确 source span、原译和新策略；
  模型返回完整块译文和新的 `TermUsage`。
- `retranslate_required/uncertain`：使用正常翻译协议和最新知识整块重译。
- 修复后重新运行段落、完整性、正字、术语使用和跨块重复校验。

失败不得修改活动译文。自动模式达到重试上限后保留旧版本，
标记 `warning_stale` 并继续其他任务；严格导出拒绝该状态。

## 9. 正字检查边界

本次同时把通用简体正字检查前移到每个块的提交门，以避免
“晄动、谨愼、硏究”等已知类别继续进入活动译文：

1. Unicode NFC/NFKC 安全规范化；
2. OpenCC 日文兼容字与繁体到简体转换；
3. 版本化的通用简体异体字映射；
4. 规范化后重新运行锁定术语保护和段落校验。

该层只处理跨作品通用的字符规范，不硬编码《变形记》词句。
“父亲缺经理的债”一类语义/搭配错误不由字符替换猜测修复；它仍由
翻译质量抽检和后续语义覆盖层处理。本轮验收会把它列为人工质量样本，
但不以硬编码 `缺 → 欠` 通过。

## 10. SQLite 与兼容

Lossless Book Store 从 schema v3 升级到 schema v4，新增：

- `lexical_concepts`
- `concept_occurrences`
- `translation_concept_bindings`
- `knowledge_revalidation_tasks`

现有 `knowledge_block_impacts` 保留为迁移兼容和工作台展示来源，
新运行不再为同一概念的每个 revision 复制全部 impact 行。

v3 → v4 迁移必须：

1. 在单一事务内创建新表和索引；
2. 不修改认证原文、窗口规划、已有译文或知识历史；
3. 对旧译文采用 `legacy_unassessed` 惰性状态，不在打开数据库时重扫全书；
4. 首次继续翻译、严格导出或显式重验时按需建立 occurrence/binding；
5. 故障时完整回滚；
6. 只读打开 v3 时不得迁移。

## 11. 性能与存储约束

1. 出现索引规模随唯一 `concept-block` 命中增长，不随
   `revision × block` 增长。
2. 同一波对新增 forms 只扫描源块一次。
3. 相同活动译文的多个知识变化合并成一个任务。
4. 模型调用数只随真正不合规的块数增长。
5. 三百万字符合成样本必须证明：
   - 本地影响定位近似线性；
   - 单纯元数据修订产生零重验；
   - 重复修订不会线性复制 occurrence 行；
   - 内存峰值和 SQLite 增长保持有界。

## 12. 《变形记》10 万字符验收

使用与首轮相同的德文原文、`deepseek-v4-flash`、`high`、
`quality`、四路并发重新建立新项目，不复用旧译文或旧活动知识。

必须验证：

1. 至少翻译 100,000 个德文正文字符；
2. 原文覆盖、块集合和段落对应完整；
3. `Gregor/Grete/Samsa` 无名字漂移；
4. `Prokurist/Prokuristen` 归入一个概念；
5. 所有命中块都有有效 binding；
6. 不再出现“开头秘书主任、后文主事”这种无策略支持的漂移；
7. 如果知识在翻译中变化，只重验旧快照且实际命中的块；
8. 没有 `pending/stale/warning_stale` 时严格导出；
9. 不出现“晄、愼、硏”等非预期目标正字；
10. 报告翻译墙钟、模型调用、重验候选、noop、修复和重译数量。

人工抽查至少覆盖：

- 第一段变形描写；
- 公司来人及 `Prokurist` 首次出现；
- 父亲债务段；
- 一个长对话段；
- 一个跨块边界段。

本轮不把“父亲缺经理的债”等单句错误写成专书规则。若新译仍产生
类似语义错误，必须作为下一层通用语义校验的真实失败样本报告。

## 13. 完成定义

运行的工程完成与语言收敛分开报告：

- `structurally_complete`：无损账本、块和段落完整；
- `knowledge_converged`：所有活动 binding 符合最终渲染指纹；
- `strict_exportable`：结构完整、知识收敛且没有阻断质量事件。

只有三者全部成立时，GUI 和 CLI 才能显示“已完成并可严格导出”。
终局审计只重新计算这些不变量，不进行第一次全书编辑。
