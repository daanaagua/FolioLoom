# 效用记忆检索、完整性与重验动作实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用预算约束效用选择替换固定记忆分数，用语义单元覆盖替换长度硬阈值，并用预期损失和顺序检验选择重验、修补、复核或整块重译。

**架构：** `utility_selection.py` 提供可复用的确定性懒惰贪心选择；`completeness.py` 在既有 `semantic_alignment` 之上构造结构覆盖和长度异常特征；`revalidation_policy.py` 把变更证据映射为动作后验。现有记忆和重验逻辑先在 `observe` 模式运行对照，外部硬预算溢出保持明确人工终态。

**技术栈：** Python 3.14、SQLite、pytest、现有叙事记忆、重验 runner 和两层翻译器。

---

## 文件结构

### 创建

- `src/core/v4/utility_selection.py`：带硬性项、token 预算、冗余和稳定平局的懒惰贪心。
- `src/core/v4/completeness.py`：有限对齐单元、覆盖报告和经验长度异常模型。
- `src/core/v4/revalidation_policy.py`：动作后验、预期损失、顺序验证和终止原因。
- `tests/test_utility_selection.py`：预算、冗余、硬性项和稳定顺序。
- `tests/test_semantic_completeness.py`：否定、数量、比较、受保护 span 和长度先验。
- `tests/test_revalidation_policy.py`：noop、patch、review、retranslate 和风险兜底。

### 修改

- `src/core/v4/narrative_models.py`：记忆候选增加效用特征和选择审计字段。
- `src/core/v4/narrative_memory.py`：替换 `100 / 80 / 70 / 50` 固定评分。
- `src/core/v4/context.py`：消费选择结果并保持必要上下文完整。
- `src/core/v4/revalidation.py`：删除 `impact_level` 直接控制动作和固定验证器数量。
- `src/core/v4/validation.py`：接入语义覆盖与长度异常。
- `src/core/v4/repairer.py`：局部修补后重新运行完整性和风险验证。
- `src/core/v4/database.py`：保存新重验 posterior、成本和选中动作。
- `src/core/v4/pipeline.py`：接入三态 memory/revalidation 模式和无人值守终态。
- `src/core/v4/exporter.py`：输出记忆效用、语义覆盖和重验政策指标。
- `tests/test_narrative_memory.py`、`tests/test_narrative_revalidation.py`、
  `tests/test_precise_revalidation.py`、`tests/test_parallel_v4_v2.py`：覆盖集成行为。

## 任务 1：实现通用预算效用选择器

**文件：**
- 创建：`src/core/v4/utility_selection.py`
- 创建：`tests/test_utility_selection.py`

- [ ] **步骤 1：编写效用、冗余和稳定平局失败测试**

```python
def test_lazy_greedy_prefers_complementary_items_inside_budget():
    selector = UtilitySelector(max_cost=10)
    result = selector.select(
        (
            item("a", utility=8.0, cost=5, topics=("x",)),
            item("b", utility=7.5, cost=5, topics=("x",)),
            item("c", utility=6.0, cost=5, topics=("y",)),
        )
    )
    assert result.selected_ids == ("a", "c")


def test_tie_break_is_reveal_desc_then_id_asc():
    result = UtilitySelector(max_cost=5).select(
        (
            item("b", utility=4.0, cost=5, reveal_index=7),
            item("a", utility=4.0, cost=5, reveal_index=7),
        )
    )
    assert result.selected_ids == ("a",)
```

- [ ] **步骤 2：编写硬性项超预算失败测试**

```python
def test_required_items_over_budget_return_manual_terminal():
    result = UtilitySelector(max_cost=5).select(
        (
            item("locked", utility=100.0, cost=6, required=True),
        )
    )
    assert result.status == "manual_required_context_overflow"
    assert result.selected_ids == ()
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_utility_selection.py -q
```

预期：FAIL，选择器不存在。

- [ ] **步骤 4：实现确定性懒惰贪心**

```python
@dataclass(frozen=True)
class UtilityItem:
    id: str
    utility: float
    cost: int
    reveal_index: int
    required: bool = False
    topics: tuple[str, ...] = ()


@dataclass(frozen=True)
class UtilitySelectionResult:
    selected_ids: tuple[str, ...]
    total_cost: int
    total_utility: float
    status: str = "completed"


def marginal_utility(
    item: UtilityItem,
    selected: Sequence[UtilityItem],
    redundancy_weight: float,
) -> float:
    overlap = sum(
        len(set(item.topics) & set(other.topics))
        for other in selected
    )
    return item.utility - redundancy_weight * overlap
```

算法：

1. 按 `(reveal_index DESC, id ASC)` 加入 required；
2. required 总成本超预算立即返回人工终态；
3. 对剩余项维护 `marginal_utility / cost` 最大堆；
4. 弹出时重新计算真实边际效用，过期项重新入堆；
5. 边际效用不为正或剩余项均放不下时停止；
6. 输出按实际选择顺序和稳定 ID 保存。

- [ ] **步骤 5：运行选择器测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_utility_selection.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/utility_selection.py `
  tests/test_utility_selection.py
git commit -m "feat: select context by marginal utility"
```

## 任务 2：把叙事记忆检索改为预算效用

**文件：**
- 修改：`src/core/v4/narrative_models.py`
- 修改：`src/core/v4/narrative_memory.py`
- 修改：`src/core/v4/context.py`
- 修改：`tests/test_narrative_memory.py`

- [ ] **步骤 1：编写固定分值消失和 observe 等价失败测试**

```python
def test_memory_retrieval_source_has_no_fixed_weight_formula():
    source = inspect.getsource(NarrativeMemoryStore.retrieve_for_block)
    assert "100 * int(direct)" not in source
    assert "80 * int(participant)" not in source
    assert "70 * int(semantic_reference)" not in source
    assert "50 * int(distance <= 3)" not in source


def test_observe_memory_mode_keeps_legacy_context_and_records_new_selection(store):
    retrieval = store.retrieve_for_block(
        block,
        snapshot,
        matched_subject_ids=("Q1",),
        max_chars=600,
        mode=PolicyMode.OBSERVE,
    )
    assert retrieval.rendered == retrieval.legacy_rendered
    assert retrieval.utility_selected_ids
    assert retrieval.selection_decision_id
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_narrative_memory.py -q
```

预期：FAIL，仍使用固定分数且返回类型没有效用字段。

- [ ] **步骤 3：构造记忆效用特征**

每条记忆转换为：

```python
@dataclass(frozen=True)
class MemoryUtilityFeatures:
    relevance_probability: float
    expected_error_reduction: float
    redundancy_topics: tuple[str, ...]
    spoiler_risk: float
    rendered_token_cost: int


MemoryUtilityFeatures(
    relevance_probability=calibrated_relevance,
    expected_error_reduction=expected_error_reduction,
    redundancy_topics=tuple(subject_and_relation_ids),
    spoiler_risk=spoiler_probability,
    rendered_token_cost=token_count(rendered_memory),
)
```

首版效用固定为可审计公式：

```python
utility = (
    relevance_probability
    * expected_error_reduction
    * (1.0 - spoiler_risk)
)
```

旧分数只作为 `bootstrap_legacy_score` 特征进入冷启动相关性估计，不直接排序。

- [ ] **步骤 4：定义硬性记忆**

required 只包括：

```python
required = (
    human_locked
    or explicit_semantic_relation_reference
    or (
        status == "verified"
        and directly_matched
        and visibility in {"reader_visible", "render_only"}
    )
)
```

required 超预算返回 `manual_required_context_overflow`，不截断、不压缩和不继续翻译。

- [ ] **步骤 5：接入三态和审计**

- `legacy`：旧选择控制。
- `observe`：旧选择控制，新选择和效用写 `decision_events`。
- `active`：新选择控制，旧 ID 只写对照。

`NarrativeRetrieval` 增加：

```python
selection_decision_id: str = ""
utility_selected_ids: tuple[str, ...] = ()
selection_status: str = "completed"
```

- [ ] **步骤 6：运行记忆与上下文测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_narrative_memory.py tests/test_narrative_pipeline.py `
  tests/test_utility_selection.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/narrative_models.py src/core/v4/narrative_memory.py `
  src/core/v4/context.py tests/test_narrative_memory.py
git commit -m "feat: retrieve narrative memory by expected utility"
```

## 任务 3：实现语义完整性和经验长度异常

**文件：**
- 创建：`src/core/v4/completeness.py`
- 创建：`tests/test_semantic_completeness.py`
- 修改：`src/core/v4/validation.py`
- 修改：`src/core/translator.py`

- [ ] **步骤 1：编写结构覆盖失败测试**

```python
def test_coverage_catches_missing_quantity_despite_similar_length():
    report = CompletenessValidator().validate(
        source_units=(
            unit("q1", "quantity", value="three", hard=True),
            unit("p1", "predicate", value="arrive"),
        ),
        target_units=(unit("p1", "predicate", value="arrive"),),
        source_text="Three riders arrived.",
        target_text="骑手们抵达了。",
    )
    assert "quantity_missing" in report.hard_failures


def test_length_outlier_is_only_a_feature_when_semantics_are_complete():
    report = validator_with_book_distribution().validate(
        source_units=complete_source_units(),
        target_units=complete_target_units(),
        source_text=long_source(),
        target_text=short_but_complete_target(),
    )
    assert report.hard_failures == ()
    assert "length_outlier" in report.warnings
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_semantic_completeness.py -q
```

预期：FAIL，完整性验证器不存在。

- [ ] **步骤 3：实现覆盖报告**

```python
@dataclass(frozen=True)
class CompletenessReport:
    coverage: float
    preserved_ids: tuple[str, ...]
    missing_ids: tuple[str, ...]
    hard_failures: tuple[str, ...]
    warnings: tuple[str, ...]
    length_percentile: float | None


def weighted_coverage(
    source_units: Sequence[SemanticUnit],
    preserved_ids: Collection[str],
) -> float:
    total = sum(unit.weight for unit in source_units)
    kept = sum(unit.weight for unit in source_units if unit.id in preserved_ids)
    return 1.0 if total == 0 else kept / total
```

受保护 span、否定、数量、比较和人工锁定缺失进入 `hard_failures`；自由句法和
文体只进入 warning/soft risk。

- [ ] **步骤 4：实现经验长度分布**

按 `(language_pair, block_type, model_id, stage)` 保存有界直方图，不保存全部样本：

```python
@dataclass(frozen=True)
class LengthHistogram:
    lower: float
    upper: float
    bins: tuple[int, ...]
    sample_count: int
```

当目标分位数的 `confidence_level` 置信区间宽度仍大于项目配置的
`max_length_quantile_uncertainty` 时，使用 schema 9 的 `0.15 / 0.75` 作为
`bootstrap_feature`；它只产生异常特征，不单独拒绝译文。是否退回先验由统计
不确定性决定，不由固定样本数决定。

- [ ] **步骤 5：接入翻译形状校验**

`TranslationEngine._translation_shape_problems()` 调用新验证器。旧段落数和长度
检查保留为廉价特征生成，不直接返回最终 failure。模型协议缺少目标语义结构时：

1. protected span/段落硬检查照常执行；
2. 语义覆盖标记 `coverage_degraded`；
3. 风险政策选择强模型复核或保守结果；
4. 达到调用上限后有限结束。

- [ ] **步骤 6：运行完整性测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_semantic_completeness.py tests/test_pipeline_v3.py `
  tests/test_parallel_v4.py tests/test_narrative_pipeline.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/completeness.py src/core/v4/validation.py `
  src/core/translator.py tests/test_semantic_completeness.py
git commit -m "feat: validate translation semantic coverage"
```

## 任务 4：实现预期损失重验政策

**文件：**
- 创建：`src/core/v4/revalidation_policy.py`
- 创建：`tests/test_revalidation_policy.py`
- 修改：`src/core/v4/revalidation.py`

- [ ] **步骤 1：编写动作选择失败测试**

```python
def test_local_unique_render_change_prefers_patch():
    decision = RevalidationPolicy(QualityPolicy()).select(
        RevalidationEstimate(
            no_effect=0.05,
            local_error=0.90,
            block_error=0.05,
            loss_if_ignored=8.0,
            patch_cost=1.0,
            retranslate_cost=6.0,
            review_cost=2.0,
            patch_hard_failures=(),
        )
    )
    assert decision.action == "patch"


def test_viewpoint_boundary_change_forbids_patch():
    decision = RevalidationPolicy(QualityPolicy()).select(
        estimate_with_hard_retranslation_reason("viewpoint_boundary_changed")
    )
    assert decision.action == "retranslate"
```

- [ ] **步骤 2：编写 impact level 不控制动作失败测试**

```python
def test_same_impact_level_can_choose_different_actions():
    first = policy.select(estimate_for_noop(impact_level=2))
    second = policy.select(estimate_for_retranslate(impact_level=2))
    assert first.action == "noop"
    assert second.action == "retranslate"
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_revalidation_policy.py -q
```

预期：FAIL，重验政策不存在。

- [ ] **步骤 4：实现动作损失**

先定义输入和输出：

```python
@dataclass(frozen=True)
class RevalidationEstimate:
    no_effect: float
    local_error: float
    block_error: float
    loss_if_ignored: float
    patch_cost: float
    retranslate_cost: float
    review_cost: float
    patch_failure_probability: float
    retranslation_failure_probability: float
    patch_hard_failures: tuple[str, ...] = ()
    noop_hard_failures: tuple[str, ...] = ()
    impact_level: int = 0


@dataclass(frozen=True)
class RevalidationDecision:
    action: str
    risk: RiskVector
    expected_loss: float
    warning: str = ""
```

然后生成统一候选：

```python
def candidates(self, estimate: RevalidationEstimate) -> tuple[DecisionCandidate, ...]:
    return (
        candidate_for_noop(estimate),
        candidate_for_patch(estimate),
        candidate_for_review(estimate),
        candidate_for_retranslate(estimate),
    )
```

预期损失：

```python
noop_loss = (
    estimate.local_error * estimate.loss_if_ignored
    + estimate.block_error * estimate.loss_if_ignored * 2.0
)
patch_loss = estimate.patch_failure_probability * estimate.loss_if_ignored
retranslate_loss = estimate.retranslation_failure_probability * estimate.loss_if_ignored
```

人工锁定变化、未来可见性边界变化、protected span 缺失和源结构不完整为硬约束，
直接禁止 noop/patch，但仍通过同一候选过滤接口。

- [ ] **步骤 5：替换 `impact_level` 分支**

`classify_memory_change()` 和 `impact_level` 继续用于 UI 和冷启动特征；
删除 `_factories_for_impact()` 以及 `impact == 3` 直接重译、`impact == 2`
固定两个验证器的控制分支。

planner 保存：

```text
posterior_json
expected_loss_json
cost_json
constraints_json
selected_action
policy_version
calibration_version
```

- [ ] **步骤 6：运行重验政策和既有精确重验测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_revalidation_policy.py tests/test_precise_revalidation.py `
  tests/test_narrative_revalidation.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/revalidation_policy.py src/core/v4/revalidation.py `
  tests/test_revalidation_policy.py
git commit -m "feat: choose revalidation actions by expected loss"
```

## 任务 5：实现顺序重验、修补复核和无人值守终态

**文件：**
- 修改：`src/core/v4/revalidation.py`
- 修改：`src/core/v4/repairer.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`tests/test_narrative_revalidation.py`
- 修改：`tests/test_parallel_v4_v2.py`

- [ ] **步骤 1：编写一个验证器即停止和冲突有限结束测试**

```python
def test_revalidation_stops_after_one_validator_when_budget_is_met(runner):
    result = runner.run_one(task_with_first_posterior(high_upper=0.01))
    assert result.validator_calls == 1


def test_conflicting_validators_finish_without_required_human_input(runner):
    result = runner.run_one(task_with_conflicting_votes())
    assert result.status in {"completed", "completed_with_warning"}
    assert result.selected_action in {"review", "retranslate", "noop"}
    assert result.warning == "risk_budget_unmet"
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_narrative_revalidation.py tests/test_parallel_v4_v2.py -q
```

预期：FAIL，验证器数量或冲突处理仍由 impact 固定。

- [ ] **步骤 3：实现顺序检验**

每次验证后：

```python
posterior = estimator.update(posterior, vote)
decision = policy.select(estimator.to_revalidation_estimate(posterior, task))
if decision.risk.high_upper <= quality.epsilon_high:
    break
if voi.next_verifier(posterior, next_cost) <= 0.0:
    break
if calls_used >= absolute_validator_limit:
    break
```

最终动作始终写入 decision event。

- [ ] **步骤 4：修补后重新验证完整性**

`repairer.py` 的局部 patch 成功条件：

```python
report = completeness.validate(
    source_units=task.source_units,
    target_units=analyze_target(patched_text),
    source_text=task.source_text,
    target_text=patched_text,
)
if report.hard_failures:
    raise RepairValidationError(",".join(report.hard_failures))
```

失败后由 policy 重新比较 review/retranslate，不直接无限重试 patch。

- [ ] **步骤 5：定义所有终态**

```text
completed
completed_with_warning
manual_required_context_overflow
failed_external_budget
failed_invalid_source
```

模型冲突、协议失败和校准退化不能留下 `pending`。外部 token/上下文硬预算超限按
用户要求返回人工处理终态，不改变内部候选和知识状态。

- [ ] **步骤 6：运行重验集成测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_revalidation_policy.py tests/test_narrative_revalidation.py `
  tests/test_precise_revalidation.py tests/test_parallel_v4_v2.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/revalidation.py src/core/v4/repairer.py `
  src/core/v4/database.py src/core/v4/pipeline.py `
  tests/test_narrative_revalidation.py tests/test_parallel_v4_v2.py
git commit -m "feat: converge revalidation without fixed verifier counts"
```

## 任务 6：阶段 C 验收和 active 切换

**文件：**
- 修改：`src/core/v4/exporter.py`
- 修改：`tests/test_v4_storage_scale.py`
- 修改：`tests/test_semantic_completeness.py`
- 修改：`docs/superpowers/plans/2026-07-16-utility-memory-revalidation.md`

- [ ] **步骤 1：增加合成语义扰动集**

自动生成：

```text
删除主语
删除宾语
删除否定
删除数量
删除比较对象
把群体关系变为个体关系
把呼语变为普通指称
把现实层变为梦境层
删除段落或脚注锚点
覆盖人工锁定译名
```

每个样本保存已知严重性标签，计算严重错误召回、漏检和中等错误误报。

- [ ] **步骤 2：增加效用检索和重验报告**

质量报告输出：

```text
memory_required_count
memory_selected_count
memory_redundancy_avoided
manual_context_overflow_count
semantic_coverage_mean
hard_completeness_failure_count
revalidation_action_counts
validator_calls_per_task
risk_budget_unmet_count
unattended_completion_rate
```

- [ ] **步骤 3：运行完整验证**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_utility_selection.py tests/test_narrative_memory.py `
  tests/test_semantic_completeness.py tests/test_revalidation_policy.py `
  tests/test_narrative_revalidation.py tests/test_v4_storage_scale.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests --ignore=tests/test_foila_logic.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m compileall src main.py
git diff --check
```

预期：零失败，compileall 成功，diff check 无输出。

- [ ] **步骤 4：切换 memory/revalidation 默认模式**

只有满足：

```text
严重错误漏检率 <= schema 9 基线
protected span 漏检数 = 0
未来信息泄露数 = 0
无人值守完成率 = 100%（外部硬预算人工终态计为明确完成）
重验无限循环数 = 0
活动译文缺块数 = 0
```

才把 `OptimizationModes.memory` 和 `OptimizationModes.revalidation` 改为
`ACTIVE`。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/v4/risk_models.py src/core/v4/exporter.py `
  tests/test_v4_storage_scale.py tests/test_semantic_completeness.py `
  docs/superpowers/plans/2026-07-16-utility-memory-revalidation.md
git commit -m "test: verify utility memory and revalidation policies"
```
