# 风险受限的翻译推断与流程优化设计

日期：2026-07-16
状态：待用户审查
目标分支：`feature/narrative-memory-v5`
现有数据库版本：schema 9
目标数据库版本：schema 10

## 1. 背景

现有 `parallel_v4` 已具备词汇候选扫描、候选裁决、词形与概念分离、
工作译名、叙事预映射、位置开放记忆、动态并行、两层翻译、重验和局部修复。
这些模块解决了长篇小说翻译中的大量状态管理问题，但部分重要决策仍由固定类别、
固定阈值和固定加权公式驱动。

典型例子包括：

- 词汇扫描使用词长、频率、大小写比例和固定停用词表筛选候选；
- 候选在出现于至少三个文本块或模型置信度低于 `0.90` 时触发独立复审；
- `role`、`vocative`、标题目录等类别拥有专门分支；
- 叙事记忆检索使用 `100 / 80 / 70 / 50` 等固定分值；
- 叙事波动使用手工权重，并以 `35 / 65` 划分并发档位；
- 记忆与知识变化被映射为离散的 `impact_level 0..3`；
- 三级影响直接整块重译，二级影响固定使用两个验证器；
- 完整性检查使用 `0.15 / 0.75` 长度比例和段落数相等；
- 知识纪元默认最多运行三轮。

这些规则可以作为冷启动启发式，却不应成为长期生产逻辑。以 `torturer` 为例，
把单词特判提升为 `role` 类别仍然没有解决根本问题：系统仍在依据人工定义的类别
决定处理流程，而不是依据当前证据、错误风险、预期损失和计算成本做统一决策。

本设计把模型视为有噪声的证据源，把翻译及流程控制改写为两个相互连接的问题：

1. 在有限候选空间内求解语义、指称、叙事和中文实现的全局协调结果；
2. 在严重错误风险受控的前提下，选择成本最低的扫描、验证、翻译、修复和重译动作。

## 2. 目标与非目标

### 2.1 目标

本版本必须：

1. 删除由 `role`、`vocative`、`title` 等类别直接控制翻译流程的生产分支；
2. 保留这些类别作为可审计特征，但类别本身不能自动决定译名或触发额外模型调用；
3. 为高风险原文片段建立语义解释候选格和中文实现候选格；
4. 用统一因子图表达词汇一致性、对照差异、共指、谓词论元、话语关系、
   叙事可见性和文体连续性；
5. 把模型输出、旧译、局部语法信号和人工反馈统一表示为带来源的概率证据；
6. 对模型置信度进行按模型、按任务和按版本校准，不直接采用模型自报置信度；
7. 在硬约束下最小化预期翻译损失和计算成本；
8. 把词汇候选筛选、独立复审、上下文检索、动态并发、重验动作和知识收敛
   逐步迁移到同一决策框架；
9. 保持无人值守模式可以有限收敛并完成全书；
10. 保持人工锁定、原文证据、位置开放和未来信息隔离等现有安全不变量；
11. 对 200–300 万字小说维持流式、有限、可恢复和近似线性增长；
12. 所有评分、候选、证据、后验、动作和校准版本均可审计和复现。

### 2.2 非目标

本版本不追求：

- 用一个公式计算出文学翻译的唯一真值；
- 训练新的通用语言模型；
- 一次性把全书构造成可驻留内存的完整因子图；
- 消除所有枚举和数据模式；
- 取消工程预算、超时、文件大小或协议字段上限；
- 自动裁决原作故意保留的多义性、叙述陷阱或象征意义；
- 用数学评分覆盖人工锁定或明确的源文件结构；
- 在缺少足够证据时伪造高置信度结论。

## 3. 总目标：风险受限优化

对任一流程决策，动作集合记为：

```text
skip
scan
second_review
translate_once
generate_candidates
verify
local_repair
full_retranslate
strong_model_review
human_optional
```

给定当前证据 \(E\)、候选动作 \(a\)、错误损失 \(L\) 和计算成本 \(C\)，基本决策为：

\[
a^* =
\arg\min_a
\left[
\mathbb{E}(L \mid E,a) + \lambda C(a)
\right]
\]

正式生产目标采用风险约束形式：

\[
\min_a C(a)
\]

满足：

\[
P(\text{严重错误}\mid E,a) \le \varepsilon_{\text{high}}
\]

\[
P(\text{中等错误}\mid E,a) \le \varepsilon_{\text{medium}}
\]

其中风险上限由项目配置给出，但必须有系统级保守默认值。风险上限是质量政策，
不是针对具体词汇、体裁或小说的规则。

schema 10 的默认质量政策为：

```text
epsilon_high = 0.02
epsilon_medium = 0.10
confidence_level = 0.95
```

这些值是显式的产品质量政策，不由小说内容或词类推导。项目可以收紧但不能在
无人确认时放宽。风险模型必须使用置信水平为 `confidence_level` 的风险上界与
阈值比较，而不是使用点估计。

决策采用词典序，而不是把所有目标压成一个不可解释的总分：

1. 排除违反硬约束的动作；
2. 排除严重错误风险上界超过 `epsilon_high` 的动作；
3. 排除中等错误风险上界超过 `epsilon_medium` 的动作；
4. 在可行动作中选择预计计算成本最低者；
5. 成本相同时依次选择严重风险更低、中等风险更低、文体损失更低者。

只有当不存在满足风险约束的动作时，才使用预期损失和成本共同选择保守兜底，
并写入 `risk_budget_unmet`。自动模式仍然结束，人工队列只是可选出口。

严重错误至少包括：

- 主体、客体、否定、数量、比较对象或事件关系丢失；
- 两个已知不同概念在中文中坍缩且影响理解；
- 未来信息泄露；
- 人物身份、叙述层或时序被无证据改写；
- 受保护结构或原文段落缺失；
- 人工锁定被覆盖。

中等错误至少包括：

- 语域、称呼关系、群体/制度关系或比喻层级丢失；
- 稳定译名发生无证据漂移；
- 句间指代虽然可猜测但被明显削弱；
- 中文实现生硬到改变读者对关系的理解。

## 4. 硬约束与软约束

### 4.1 必须继续确定性执行的硬约束

以下内容不参与概率裁决：

- 原文、段落、格式 span、偏移和哈希必须可复核；
- 证据必须逐字来自授权位置的原文；
- 不得向当前位置注入后文信息；
- 人工锁定不得被模型覆盖；
- 数据库记录保持追加式和版本化；
- 同一运行只能提交冻结知识和记忆版本下生成的结果；
- JSON 协议、数据库外键、唯一性、字段长度和文件大小上限；
- API 超时、绝对重试上限和并发上限；
- 上下文或存储超过硬预算时必须进入明确终态；
- 标题、脚注、诗行等源文件明确标注的受保护结构必须保留；
- 导出不得悄悄跳过缺失文本块；
- 人工模式和自动模式共享相同的数据完整性约束。

### 4.2 可由风险模型控制的软约束

以下内容进入评分与决策：

- 是否把某个词或短语提升为全书知识；
- 是否需要第二个独立模型；
- 同一概念在当前出现位置采用何种中文实现；
- 哪些前文记忆值得进入有限上下文；
- 当前波次使用多少并发和多大 island；
- 知识变化需要不处理、局部修复还是整块重译；
- 是否继续下一次模型重试；
- 知识纪元是否已经收敛；
- 是否把某项不确定结果交给强模型或可选人工队列。

## 5. 统一表示

### 5.1 原文出现位置

所有需要协调的对象都以 occurrence 为中心：

```text
occurrence_id
block_id
start_offset
end_offset
source_form
lexeme_id nullable
concept_id nullable
source_hash
```

每个 occurrence 拥有通用、稀疏的语境特征，不因词类不同而改变模式：

```text
syntactic_relation
semantic_role
discourse_function
referentiality
grammatical_number
definiteness
polarity
modality
speaker_id
addressee_ids
social_relation
register
literal_or_figurative
presentation_layer
candidate_interpretations
```

字段可以为空。空表示未知，不表示否定。

`role`、`person`、`title` 等旧类别作为 `semantic_features` 中的观察值保存，
不再控制代码分支。

### 5.2 语义候选格

对高风险 occurrence，系统保存有限个解释候选：

```text
interpretation_id
occurrence_id
predicate
arguments_json
features_json
prior_probability
posterior_probability
evidence_ids
status
```

原文故意保留歧义时允许多个解释同时存活。翻译候选必须保留其公共约束，
不得为了降低优化难度强制选择唯一解释。

### 5.3 中文实现候选格

中文实现不再等同于一个固定术语字符串：

```text
realization_id
occurrence_id
interpretation_id
target_text
target_span_hint nullable
generator
generation_model
feature_vector_json
evidence_ids
local_score
posterior_probability
status
```

候选可以来自：

- 工作译名；
- 当前翻译模型；
- 润色模型；
- 旧译对齐；
- 已通过的本书历史实现；
- 强模型局部复核；
- 人工锁定。

旧译和历史实现只提供先验或候选，不具备自动优先权。

### 5.4 因子与约束

因子类型采用开放谓词加版本化参数，不使用词类专属代码：

```text
semantic_fidelity
predicate_argument_preservation
coreference_consistency
lexical_identity
contrast_separation
discourse_relation
register_compatibility
narrative_visibility
information_release
structural_preservation
style_continuity
target_fluency
```

一个因子可以连接 occurrence、interpretation、realization、memory、concept
和 translation candidate。因子参数必须记录来源和版本。

## 6. 内容层：有限因子图推断

对一个文本块及其必要前文证据构造局部图：

\[
(\hat{Y},\hat{Z}) =
\arg\min_{Y,Z}
\left[
\sum_i \phi_i(y_i,z_i)
+ \sum_{(i,j)\in E}\psi_{ij}(y_i,y_j,z_i,z_j)
+ \sum_g \Omega_g(Y,Z)
\right]
\]

其中：

- \(\phi_i\) 是单点因子，包括语义匹配、中文自然度和证据可靠性；
- \(\psi_{ij}\) 是成对因子，包括同概念一致性、对照词区分、共指和关系连续性；
- \(\Omega_g\) 是高阶因子，包括段落结构、叙事可见性、信息释放和文体状态。

自然语言空间无限，生产实现只在有限候选格上求近似解：

1. 普通低风险句只生成一个候选；
2. 高风险 occurrence 或句子生成有限个候选；
3. 对候选做源端和目标端结构抽取；
4. 计算因子残差；
5. schema 10 使用风险驱动的坐标下降，通过局部重生成降低残差；
6. 达到风险约束后停止；
7. 若边际收益不足，保留最优候选并记录不确定性。

第一版不实现通用 ILP 或束搜索求解器。离散的术语与共指选择使用下文规定的
有限图优化，自由文本只通过候选生成和局部比较参与。

### 6.1 schema 10 首版求解器

首版固定采用风险驱动的坐标下降，不在实现阶段重新选择求解算法：

1. 以现有两层翻译结果作为初始候选；
2. 抽取源端和目标端有限结构，计算每个 occurrence 和句子的因子残差；
3. 选择严重风险上界最高的尚未冻结局部区域；
4. 对该区域请求一个新的局部实现候选；
5. 仅当新候选降低词典序风险向量，或在风险相同时降低成本/文体损失时接受；
6. 更新相邻因子，不重算无关文本块；
7. 满足风险预算或下一次局部生成的 VOI 不大于零时停止；
8. 达到项目配置的绝对局部生成上限后按保守兜底结束。

每次只新增一个候选，使停止依据来自边际收益，而不是固定生成 `N` 个候选。
绝对生成上限属于资源安全边界。

## 7. 模型是证据源，不是最终裁判

每次模型判断保存为 observation：

```text
observation_id
purpose
subject_type
subject_id
model_id
model_version
prompt_version
reported_confidence
calibrated_probability
payload_hash
evidence_hash
created_at
```

系统不得把 `reported_confidence=0.95` 直接当作 95% 正确率。

### 7.1 校准

按以下维度维护校准器：

```text
model_id
purpose
protocol_version
language_pair
calibration_scope: global | book
```

冷启动时使用保守全局先验。积累数据后：

- 二分类正确率使用按 `model_id × purpose × protocol_version` 分组的
  分层 beta-binomial 后验；
- 模型自报的连续置信度使用带 L2 正则的 beta calibration；
- A/B 盲评使用 Bradley–Terry 模型估计潜在质量；
- 多模型一致性使用各模型经过校准的似然，而不是简单多数票；
- 书内数据不足时使用全局和书内的分层贝叶斯收缩；
- 风险上界使用 95% 后验可信上界；无有效样本时使用保守先验上界；
- 校准器更新必须版本化，旧决策仍可复现。

若 beta calibration 拟合失败或样本退化为单一标签，直接回退到分层
beta-binomial 后验，不切换到未在本规格中定义的其他校准算法。

### 7.2 可用反馈

反馈来源包括：

- 人工 A/B 选择；
- 人工接受或拒绝知识条目；
- 后续强模型复核；
- 局部修复是否通过确定性校验；
- 翻译重跑后问题是否消失；
- 合成扰动测试的已知标签；
- 不同模型的独立判断。

自由文本评论可以保留，但不是训练和校准的必需条件。

## 8. 词汇候选发现的数学化

现有词长、频率、大小写和停用词规则保留为特征生成器，不再直接决定候选资格。

对片段 \(s_i\) 定义：

\[
R_i =
H(T_i \mid X,K)
\cdot I_i
\cdot F_i
\]

其中：

- \(H(T_i \mid X,K)\) 是目标实现的条件熵；
- \(I_i\) 是译错后的预计影响；
- \(F_i\) 是全书复现或传播规模。

实际实现使用校准风险模型近似 \(R_i\)。输入特征可以包括：

- 词形和短语长度；
- 大小写分布；
- 书内频率和上下文多样性；
- 不同上下文中的候选译名分歧；
- 是否参与指称、对照、单位、制度或叙事关系；
- 是否在旧译或多个模型中出现稳定实现；
- 若忽略该片段，后续漂移会影响多少文本块。

schema 10 首版的候选风险估计器固定使用带 L2 正则的逻辑回归。
现有词长、频率、大小写、停用词和结构风险以特征形式进入；其旧分值只用于
初始化系数，不再直接决定候选资格。模型和特征模式均版本化。

选择候选的目标不是固定取前 80 个，而是在扫描预算下最大化预期风险覆盖：

\[
\max_{S}
\sum_{i\in S} \mathbb{E}[\text{avoided loss}_i]
\quad
\text{s.t. }
\sum_{i\in S} C_i \le B_{\text{scan}}
\]

绝对每块候选上限仍作为工程安全边界存在。

## 9. 裁决与独立复审的数学化

独立第二轮不再由“出现三块”“置信度低于 0.90”或“属于人名”等条件触发。

对是否增加一次验证，计算信息价值：

\[
\operatorname{VOI}(q) =
\mathbb{E}[L \mid E]
-
\mathbb{E}[L \mid E,q]
-
C(q)
\]

只有 \(\operatorname{VOI}(q)>0\) 且风险尚未满足上限时才调用第二模型。

两个模型冲突时不自动 `defer` 或整块重译。系统根据校准可靠性更新后验；
若后验仍不足，选择预期损失最低的后续动作。无人值守模式可以选择保守候选并记录风险，
人工队列仍然只是可选项。

## 10. 共指的数学化

标题目录、人物姓名和同形词不再拥有独立合并算法。所有 occurrence 对统一计算：

\[
P(c_i=c_j \mid E_{ij})
\]

证据包括：

- 字面形式和词形关系；
- 源位置、段落类型和结构；
- 共同概念锚点；
- 参与事件、说话者和关系；
- 时间、地点和叙事层；
- 目录与正文等结构对应；
- 人工锁定；
- 模型判断和校准可靠性。

schema 10 固定采用确定性的带约束贪心相关聚类：

- 人工声明不同为不可合并边；
- 人工锁定同一为必须合并边；
- 其余边使用后验代价；
- 保留 `uncertain` 边，不强迫全图闭包；
- 只构造同词形或高相似候选的稀疏图，避免平方增长。

具体过程如下：

1. 将候选边的后验概率转换为截断后的对数优势
   \(w_{ij}=\operatorname{clip}(\log\frac{p_{ij}}{1-p_{ij}},-w_{\max},w_{\max})\)；
2. 先合并全部必须合并边的连通分量；若它与不可合并边冲突，返回
   `lock_conflict`，不猜测人工意图；
3. 按边权从高到低处理剩余正边，相同权重按 occurrence ID 排序；
4. 对两个候选分量计算跨分量边权之和 \(\Delta\)，仅在
   \(\Delta>0\) 且不存在不可合并边时合并；
5. 重复第 3、4 步直至一轮没有合并；
6. 未进入同一分量且其 `confidence_level` 后验可信区间包含 `0.5` 的边继续
   保留为 `uncertain`，供后续证据更新，不把“不确定”伪装成“不同”。

标题目录规则可以继续产生高质量证据，但不能直接返回最终结论。

## 11. 语境化中文实现

`role` 复核、固定 `vocative` 前缀列表和“大人/阁下/先生/女士”后缀匹配
从生产决策中移除。它们可以作为测试数据和冷启动特征。

例如：

```text
reared among the torturers
```

源端结构应近似表示为：

```text
rear(
  experiencer=Severian,
  environment=collective(torturer)
)
```

候选“我在拷问官中长大”在目标端缺失明确的群体或制度承载关系，
因此产生 `predicate_argument_preservation` 残差；候选
“我在拷问官行会中长大”或其他自然改写能够降低残差。

同理：

```text
Torturer, I ask you...
```

关键约束是目标译句保留 `address(speaker, addressee, label)` 关系，
而不是必须包含某个固定敬称后缀。

## 12. 记忆检索的数学化

固定的 `100 / 80 / 70 / 50` 记忆分值替换为预算约束下的选择问题。

对记忆 \(m_i\) 定义：

```text
relevance_probability
expected_error_reduction
redundancy
spoiler_risk
rendered_token_cost
```

检索目标为：

\[
\max_{S}
\left[
\sum_{i\in S} U(m_i)
-
\sum_{i,j\in S} \rho(m_i,m_j)
\right]
\]

满足：

\[
\sum_{i\in S} \text{tokens}(m_i) \le B_{\text{context}}
\]

其中 \(U\) 是预计减少的翻译损失，\(\rho\) 是冗余惩罚。

首版使用确定性的懒惰贪心近似：

1. 先加入全部硬性需要记忆；
2. 对剩余记忆计算单位 token 的边际效用；
3. 每次加入边际效用最高且不超过预算的一项；
4. 更新与已选记忆的冗余惩罚；
5. 无正边际效用或无剩余预算时停止；
6. 分值相同按 `reveal_global_index DESC, memory_id ASC` 打破平局。

硬性需要的 verified 约束、人工锁定和明确的 render-only 关系先占用预算；
如果硬性内容本身超出预算，继续返回人工处理终态，不压缩或伪装完成。

## 13. 动态调度的数学化

现有叙事波动分数和 `35 / 65` 档位改为风险受限的调度策略。

调度动作包括：

```text
workers
island_size
premap_ahead
candidate_count
validator_count
model_tier
```

优化目标：

\[
\min \mathbb{E}[\text{wall time} + \lambda_{\text{token}}\text{tokens}]
\]

满足：

\[
P(\text{跨岛状态错误}) \le \varepsilon_{\text{island}}
\]

schema 10 首版固定使用带 L2 正则的逻辑回归预测每个候选调度动作的
跨岛错误概率，并使用最近运行的实际墙钟时间估计成本。树模型和
contextual bandit 只作为未来实验方向，不属于首版实施范围。

调度器必须保留以下确定性边界：

- 章节和显式叙事边界可以强制切岛；
- 最大并发不能超过配置；
- 外部限流和网络错误立即降低并发；
- 同一知识纪元内仍按 `global_index` 提交。

## 14. 重验与修复的数学化

`impact_level 0..3` 保留为兼容展示字段，但不再直接决定动作。

对每个过期译文估计：

```text
P(no_effect)
P(local_error)
P(global_block_error)
loss_if_ignored
cost_patch
cost_retranslate
cost_strong_review
```

动作选择：

\[
a^* =
\arg\min_{a\in
\{\text{noop, patch, retranslate, review}\}}
\mathbb{E}[L(a)\mid E] + \lambda C(a)
\]

只有人工锁定变化、未来可见性边界改变或结构不完整等硬情况可以直接强制重译。

两个验证器不再固定用于二级影响。验证器数量由顺序检验决定：

1. 第一个验证器更新后验；
2. 若风险已经低于阈值则停止；
3. 若第二次判断的预期信息价值高于成本则继续；
4. 达到绝对调用上限后按最低预期损失动作收敛。

## 15. 完整性校验的数学化

段落数和长度比例仍作为廉价异常特征，但不再单独代表完整性。

源端和目标端建立有限对齐单元：

```text
paragraph
sentence
protected_span
named_or_numeric_anchor
predicate
argument
negation
quantity
comparison
coreference_link
```

计算：

\[
\text{coverage} =
\frac{\sum_k w_k \cdot \mathbf{1}[\text{unit}_k\text{ preserved}]}
{\sum_k w_k}
\]

受保护结构、否定、数量和人工锁定拥有硬权重或硬约束。自由句法和文体采用软损失。

长度异常使用书内和模型内经验分布进行检测，而不是固定 `0.15 / 0.75`：

\[
P(r_{\text{length}}\mid
\text{language pair, block type, model, stage})
\]

在校准数据不足时继续使用现有比例作为保守先验，但记录为
`bootstrap_feature`，不得把它伪装成已学习结论。

## 16. 知识纪元与停止条件

固定最多三轮替换为收敛判据加绝对上限。

定义第 \(t\) 轮的残余变化质量：

\[
\Delta_t =
\sum_{c\in C_t}
P(c\text{ materially changes translation})
\cdot \operatorname{impact}(c)
\]

继续下一纪元的条件：

\[
\mathbb{E}[\text{avoided loss from next epoch}]
>
C(\text{next epoch})
\]

并且尚未达到绝对纪元上限。绝对上限仍是防失控的工程配置。

如果变化质量未收敛但达到上限，自动模式保留当前最佳结果，创建可审计警告，
不得无限循环，也不得要求人工才能结束。

## 17. schema 10 数据模型

schema 10 新增以下表；不删除 schema 9 的词汇、记忆和审计表。

### 17.1 `occurrence_features`

```text
occurrence_id
feature_version
features_json
evidence_hash
created_at
PRIMARY KEY(occurrence_id, feature_version)
```

### 17.2 `semantic_interpretations`

```text
id
occurrence_id
predicate
arguments_json
features_json
prior_probability
posterior_probability
status
evidence_ids_json
model_id nullable
created_version
retired_version nullable
created_at
```

### 17.3 `realization_candidates`

```text
id
occurrence_id
interpretation_id nullable
target_text
generator
model_id nullable
feature_vector_json
local_score
posterior_probability
status
created_version
retired_version nullable
created_at
```

### 17.4 `factor_constraints`

```text
id
factor_type
subject_ids_json
parameters_json
hard_constraint
weight
calibration_version nullable
evidence_ids_json
created_version
retired_version nullable
created_at
```

### 17.5 `calibration_models`

```text
id
model_id
purpose
protocol_version
language_pair
scope
book_id nullable
method
parameters_json
sample_count
metrics_json
created_at
```

### 17.6 `decision_events`

```text
id
run_id
stage
subject_type
subject_id
actions_json
posterior_json
expected_loss_json
cost_json
constraints_json
selected_action
policy_version
calibration_version nullable
created_at
```

### 17.7 `evaluation_feedback`

```text
id
book_id
block_id nullable
subject_type
subject_id
feedback_type
candidate_ids_json
selected_candidate_id nullable
label_json
source
created_at
```

大段自由文本和完整模型响应继续进入压缩审计归档，不复制进活动 SQLite。

## 18. 冷启动与渐进学习

系统不能要求先积累大量人工数据才能运行。

冷启动顺序：

1. 把现有启发式转换为带版本号的先验特征；
2. 使用模型自洽性、跨模型分歧、旧译和确定性检查构造弱监督；
3. 使用合成扰动测试校准严重错误检测；
4. 使用已有盲评结果校准 A/B 偏好；
5. 运行中逐步形成全局模型和书内模型；
6. 数据不足时向保守全局先验收缩。

任何学习参数都必须可以恢复为保守默认值。模型漂移或校准失效时，
系统可以退回启发式先验，但所有退化必须进入质量报告。

## 19. 迁移顺序

### 阶段 A：统一出现位置与中文实现

- 引入 occurrence feature、interpretation 和 realization candidate；
- 把现有 `role/vocative` 特判降级为先验特征；
- 增加源端/目标端关系对齐和局部候选重生成；
- 保留当前词库和术语校验作为兼容因子；
- 用《新日之书》的职业、直接称呼、群体、制度和比喻语境回归。

### 阶段 B：风险模型与校准

- 建立 observation、calibration 和 feedback；
- 接入现有人工 A/B 选择；
- 校准 Flash、Pro 和各验证用途；
- 把独立复审改为 VOI 决策；
- 保留绝对调用上限。

### 阶段 C：检索与重验优化

- 把记忆检索改为预算约束选择；
- 把 impact level 降级为展示和先验特征；
- 用预期损失选择 noop、patch、retranslate 和 review；
- 验证无人值守模式可以在冲突时有限收敛。

### 阶段 D：调度、扫描与收敛

- 学习叙事风险和并发失败概率；
- 把调度权重和阈值降级为冷启动先验；
- 把词汇候选筛选改为风险覆盖优化；
- 把知识纪元改为边际收益停止；
- 在 200–300 万字合成长篇上做规模测试。

每个阶段必须独立可回退，不能要求四个阶段一次性切换。

## 20. 失败处理

### 20.1 概率模型不可用

- 使用最近一个已验证校准版本；
- 若不存在，使用保守冷启动先验；
- 记录 `calibration_degraded`；
- 不阻断全书，但降低自动接受概率并限制高风险并发。

### 20.2 候选格为空

- 回退到当前单候选翻译；
- 运行硬约束和完整性检查；
- 记录 `candidate_lattice_empty`；
- 若风险超限，选择强模型或整块重译，人工仍为可选。

### 20.3 因子冲突

- 人工锁定和源结构硬约束优先；
- 其余因子按校准权重计算；
- 无可行候选时局部重生成；
- 达到调用上限后选择预期损失最低的候选并记录冲突。

### 20.4 数据规模超限

- 因子图只覆盖当前块、必要前文和受影响的稀疏邻域；
- 历史候选按版本和活跃状态归档；
- 活动 SQLite 继续执行现有大小预算；
- 不允许为全书构建完全图。

## 21. 测试策略

### 21.1 确定性单元测试

- 类别值不再触发专门生产分支；
- 同一特征向量在不同词类上走同一推断接口；
- 人工锁定、未来隔离、证据偏移和结构硬约束保持不变；
- 决策事件能够复现选中动作；
- 校准版本变化不会改写旧决策记录；
- 预算超限保持明确终态。

### 21.2 合成扰动测试

自动构造并验证：

- 删除主语、宾语、否定、数量或比较对象；
- 合并两个必须区分的译名；
- 把群体关系改写为个体关系；
- 把呼语改写成普通指称；
- 把现实层改写成梦境层或反向操作；
- 泄露后文身份；
- 删除段落、诗行或脚注锚点；
- 把已锁定译名替换成自由变体。

### 21.3 真实作品测试

至少包括：

- 《新日之书》：`torturer / executioner / headsman / carnifex`，
  自称、群体、制度、呼语和比喻语境；
- `Incandescence`：`scape` 在不同呈现层和观察者版本中的实现；
- 人名与普通词同形；
- 目录标题与正文标题共指；
- 不可靠叙述、梦境、回忆和转述层切换；
- 长距离人物关系和称呼变化。

### 21.4 评价指标

系统级指标：

```text
严重错误召回率
严重错误漏检率
中等错误误报率
人类 A/B 胜率
每千词模型调用数
每千词 token
平均墙钟时间
局部修复成功率
整块重译率
无人值守完成率
校准误差
```

核心验收目标不是某个单一总分，而是：

- 在相同或更低严重错误漏检率下减少模型成本；
- 在相同成本下提高盲评胜率；
- 不因数学化引入未来泄露、不可审计状态或无限循环。

## 22. 验收标准

1. 生产代码中不存在由 `role`、`vocative` 或具体敬称列表直接决定译名的分支；
2. `role`、`title` 等值只作为证据特征或展示标签；
3. “在拷问官中长大”类问题能通过通用关系残差发现，不依赖 `torturer` 字符串；
4. 词汇、共指、叙事和目标实现可以在同一局部因子图中表达；
5. 模型自报置信度经过版本化校准后才能参与自动决策；
6. 是否二次验证由信息价值决定，而非固定类别和阈值；
7. 记忆检索在字符预算下使用预计信息收益和冗余惩罚；
8. 重验动作按预期损失选择，`impact_level` 不再直接控制动作；
9. 调度策略以预测风险和成本为输入，固定波动分数只作冷启动先验；
10. 完整性以结构和语义单元覆盖为主，长度比例只作异常特征；
11. 知识纪元按残余变化和边际收益停止，同时保留绝对安全上限；
12. 无校准数据、模型冲突或局部协议失败时仍可无人值守有限收敛；
13. 所有候选、因子、概率、动作和校准版本均可从审计记录复现；
14. 现有 schema 9 项目可迁移、可回退，旧译文和人工锁定不丢失；
15. 200–300 万字规模测试保持流式和近似线性存储增长。
