# 校准风险、信息价值与共指裁决实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把模型自报置信度、固定复审条件和简单多数票替换为版本化校准后验、风险上界、信息价值和确定性的带约束共指聚类。

**架构：** `calibration.py` 提供无第三方数值依赖的分层 beta-binomial、L2 beta calibration 和 Bradley–Terry；`risk_policy.py` 统一动作选择和 VOI；`coreference_graph.py` 把结构规则、模型票和人工锁定转换为边证据。现有裁决器先在 `observe` 模式记录新决策，达到门槛后再切换 `active`。

**技术栈：** Python 3.14 标准库 `math`、SQLite、pytest、现有审计归档和本地盲评页面。

---

## 文件结构

### 创建

- `src/core/v4/calibration.py`：校准器、后验可信上界、序列化和冷启动回退。
- `src/core/v4/risk_policy.py`：严重/中等风险动作选择、VOI 和保守兜底。
- `src/core/v4/coreference_graph.py`：稀疏边、锁定冲突和贪心相关聚类。
- `tests/test_calibration.py`：数值稳定、收缩、拟合失败和版本重放。
- `tests/test_risk_policy.py`：风险预算、成本排序、VOI 和无人值守收敛。
- `tests/test_coreference_graph.py`：must-link、cannot-link、uncertain 和确定性排序。

### 修改

- `src/core/v4/risk_store.py`：保存/读取 observation、calibration、feedback 和 decision。
- `src/core/v4/pipeline.py`：把模型调用和策略模式传给校准层。
- `src/core/v4/adjudicator.py`：删除 `occurrence_count >= 3` 和 `confidence < 0.90` 复审条件。
- `src/core/v4/coreference.py`：把结构规则降级为证据，使用共指图输出。
- `src/core/v4/verifier.py`：由 VOI 决定验证器数量。
- `src/core/v4/target_resolver.py`：使用校准后验比较候选，不用未校准 confidence。
- `src/core/v4/comparison.py`：盲评保存 Bradley–Terry 可用反馈。
- `src/core/v4/database.py`：连接现有盲评、人工队列和风险 store。
- `src/core/v4/web_review.py`：选择按钮立即保存结构化反馈，理由继续为可选字段。
- `main.py`：新增校准状态和重建命令。
- `tests/test_candidate_adjudicator.py`、`tests/test_lexeme_coreference.py`、
  `tests/test_parallel_v4.py`：覆盖新决策路径。

## 任务 1：实现纯 Python 校准器

**文件：**
- 创建：`src/core/v4/calibration.py`
- 创建：`tests/test_calibration.py`

- [ ] **步骤 1：编写 beta-binomial 收缩和上界失败测试**

```python
from src.core.v4.calibration import BetaBinomialPosterior


def test_beta_binomial_cold_start_is_conservative():
    posterior = BetaBinomialPosterior(alpha=1.0, beta=1.0)
    assert posterior.mean == 0.5
    assert risk_upper_from_correctness(posterior, 0.95) > 0.9


def test_book_scope_shrinks_toward_global_posterior():
    global_model = BetaBinomialPosterior(alpha=91.0, beta=11.0)
    book_model = global_model.shrink(successes=1, failures=0, strength=10.0)
    assert 0.8 < book_model.mean < 0.95
```

- [ ] **步骤 2：编写 beta calibration 和 Bradley–Terry 失败测试**

```python
def test_beta_calibration_is_monotonic_and_bounded():
    model = BetaCalibration.fit(
        reported=(0.1, 0.2, 0.8, 0.9),
        labels=(0, 0, 1, 1),
        l2=0.1,
        iterations=400,
    )
    values = [model.predict(value) for value in (0.1, 0.2, 0.8, 0.9)]
    assert values == sorted(values)
    assert all(0.0 < value < 1.0 for value in values)


def test_bradley_terry_prefers_repeated_blind_winner():
    model = BradleyTerry.fit(
        comparisons=(
            ("A", "B", "A"),
            ("A", "B", "A"),
            ("A", "B", "B"),
        ),
        l2=0.1,
        iterations=300,
    )
    assert model.score("A") > model.score("B")
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_calibration.py -q
```

预期：FAIL，`calibration` 无法导入。

- [ ] **步骤 4：实现 beta-binomial 和可信上界**

使用二分法反演 beta 分布 CDF；不新增 SciPy 依赖。CDF 使用标准库
`math.lgamma` 实现的正则化不完全 beta 连分式：

```python
@dataclass(frozen=True)
class BetaBinomialPosterior:
    alpha: float
    beta: float

    @property
    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    def update(self, successes: int, failures: int) -> "BetaBinomialPosterior":
        return BetaBinomialPosterior(
            self.alpha + successes,
            self.beta + failures,
        )

    def upper(self, confidence: float) -> float:
        return self._quantile(confidence)

    def lower(self, confidence: float) -> float:
        return self._quantile(1.0 - confidence)

    def _quantile(self, quantile: float) -> float:
        low, high = 0.0, 1.0
        for _ in range(80):
            middle = (low + high) / 2.0
            if regularized_beta_cdf(middle, self.alpha, self.beta) < quantile:
                low = middle
            else:
                high = middle
        return high


def risk_upper_from_correctness(
    posterior: BetaBinomialPosterior,
    confidence: float,
) -> float:
    return 1.0 - posterior.lower(confidence)
```

数值函数对 `x=0/1`、参数过小和非有限输入显式校验。
`BetaBinomialPosterior` 表示“判断正确”的概率；生产风险比较必须调用
`risk_upper_from_correctness()`，不得把正确率上界误当成错误风险。

- [ ] **步骤 5：实现 L2 beta calibration**

特征固定为：

```python
def beta_features(probability: float) -> tuple[float, float, float]:
    value = min(max(probability, 1e-6), 1.0 - 1e-6)
    return (math.log(value), -math.log1p(-value), 1.0)
```

用确定性批量梯度下降拟合逻辑回归，固定学习率、迭代数和 L2；训练数据不足、
单一标签或出现非有限参数时抛出 `CalibrationFitError`，调用方回退
beta-binomial。

- [ ] **步骤 6：实现 Bradley–Terry**

为候选 ID 排序后固定第一个候选效用为 0，其他效用用 L2 逻辑似然梯度下降。
未知候选返回 0，不修改已拟合参数。序列化字段：

```python
{
    "method": "bradley_terry_l2_v1",
    "utilities": {"A": 0.72, "B": -0.31},
    "l2": 0.1,
    "iterations": 300,
}
```

- [ ] **步骤 7：运行校准测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_calibration.py -q
```

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```powershell
git add src/core/v4/calibration.py tests/test_calibration.py
git commit -m "feat: add deterministic probability calibration"
```

## 任务 2：保存 observation、反馈和校准版本

**文件：**
- 修改：`src/core/v4/risk_store.py`
- 修改：`src/core/v4/risk_models.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`src/core/v4/comparison.py`
- 修改：`src/core/v4/database.py`
- 创建：`tests/test_risk_feedback.py`

- [ ] **步骤 1：编写审计投影和反馈失败测试**

```python
def test_model_observation_references_archived_audit_without_copying_payload(database):
    audit_id = record_large_archived_audit(database)
    store = RiskStore(database)
    observation_id = store.record_observation(
        observation(audit_call_id=audit_id, calibrated_probability=0.82)
    )
    row = store.load_observation(observation_id)
    assert row.audit_call_id == audit_id
    assert row.payload_hash
    assert "raw_response" not in row.to_mapping()


def test_blind_choice_records_feedback_without_requiring_comment(database):
    database.record_comparison_vote(
        block_id="b1",
        choice="A",
        rationale="",
        reviewer="human",
    )
    feedback = RiskStore(database).feedback_for_subject("block", "b1")
    assert feedback[-1].selected_candidate_id == "A"
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_risk_feedback.py -q
```

预期：FAIL，风险反馈投影不存在。

- [ ] **步骤 3：实现 observation 投影**

在 `AuditedLLM.chat()` 完成 `record_audit_call()` 后，仅当调用提供
`observation_subject` 时写入：

```python
@dataclass(frozen=True)
class ModelObservation:
    audit_call_id: int
    purpose: str
    subject_type: str
    subject_id: str
    model_id: str
    model_version: str
    prompt_version: str
    reported_confidence: float | None
    calibrated_probability: float | None
    payload_hash: str
    evidence_hash: str
    calibration_version: str | None

    def to_mapping(self) -> dict[str, object]:
        return asdict(self)


ModelObservation(
    audit_call_id=audit_id,
    purpose=purpose,
    subject_type=subject_type,
    subject_id=subject_id,
    model_id=model_id,
    model_version=model_version,
    prompt_version=prompt_version,
    reported_confidence=reported_confidence,
    calibrated_probability=calibrated_probability,
    payload_hash=payload_hash,
    evidence_hash=evidence_hash,
    calibration_version=calibration_version,
)
```

普通翻译文本生成不强制伪造一个二分类 confidence；只有明确判断任务写该字段。

- [ ] **步骤 4：把盲评和人工选择映射为 feedback**

`record_comparison_vote()` 在同一事务写 `evaluation_feedback`：

```python
feedback_type = "pairwise_preference"
candidate_ids = ("A", "B")
selected_candidate_id = choice if choice in {"A", "B"} else None
label = {"choice": choice, "rationale": rationale}
```

“两者相当”和“都不合格”保留为不同 label，不伪造成 A/B 胜负。自由理由允许为空。

- [ ] **步骤 5：实现校准模型保存和最新有效版本读取**

`RiskStore.save_calibration()` 验证 `sample_count`、方法名和有限参数；
`load_calibration()` 按 scope 优先：

```text
book exact -> global exact -> conservative default
```

旧决策引用的 calibration ID 必须仍可读取。

- [ ] **步骤 6：运行反馈和数据库测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_risk_feedback.py tests/test_parallel_v4.py `
  tests/test_v4_storage_scale.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/risk_store.py src/core/v4/pipeline.py `
  src/core/v4/risk_models.py src/core/v4/comparison.py src/core/v4/database.py `
  tests/test_risk_feedback.py
git commit -m "feat: record calibration feedback and observations"
```

## 任务 3：实现风险政策和信息价值

**文件：**
- 创建：`src/core/v4/risk_policy.py`
- 创建：`tests/test_risk_policy.py`

- [ ] **步骤 1：编写词典序选择和 VOI 失败测试**

```python
def test_policy_chooses_cheapest_action_inside_risk_budget():
    result = RiskPolicy(QualityPolicy()).select(
        (
            action("single", high=0.01, medium=0.08, cost=1.0),
            action("double", high=0.005, medium=0.04, cost=3.0),
        )
    )
    assert result.selected_action == "single"


def test_information_value_accounts_for_expected_posterior_and_cost():
    value = information_value(
        current_expected_loss=4.0,
        posterior_losses=(1.0, 5.0),
        posterior_probabilities=(0.7, 0.3),
        query_cost=0.5,
    )
    assert value == pytest.approx(1.3)
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_risk_policy.py -q
```

预期：FAIL，风险政策不存在。

- [ ] **步骤 3：实现统一动作选择**

```python
def select(self, actions: Sequence[DecisionCandidate]) -> DecisionResult:
    ordered = tuple(sorted(actions, key=lambda item: item.action))
    hard_safe = tuple(item for item in ordered if not item.risk.hard_failures)
    feasible = tuple(
        item
        for item in hard_safe
        if item.risk.high_upper <= self.quality.epsilon_high
        and item.risk.medium_upper <= self.quality.epsilon_medium
    )
    if feasible:
        selected = min(
            feasible,
            key=lambda item: (
                item.cost,
                item.risk.high_upper,
                item.risk.medium_upper,
                item.style_loss,
                item.action,
            ),
        )
        return DecisionResult.from_candidate(selected)
    selected = min(
        hard_safe or ordered,
        key=lambda item: (
            item.expected_high_loss,
            item.expected_medium_loss,
            item.cost,
            item.action,
        ),
    )
    return DecisionResult.from_candidate(
        selected,
        warning="risk_budget_unmet",
    )
```

- [ ] **步骤 4：实现 VOI 和绝对调用上限**

```python
def should_query(
    *,
    voi: float,
    current_high_upper: float,
    quality: QualityPolicy,
    calls_used: int,
    call_limit: int,
) -> bool:
    return (
        voi > 0.0
        and current_high_upper > quality.epsilon_high
        and calls_used < call_limit
    )
```

调用上限只负责有限终止，不把负 VOI 变为正。

- [ ] **步骤 5：运行政策测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_risk_policy.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/risk_policy.py tests/test_risk_policy.py
git commit -m "feat: select model actions by calibrated risk"
```

## 任务 4：把候选裁决改为 VOI 复审

**文件：**
- 修改：`src/core/v4/adjudicator.py`
- 修改：`tests/test_candidate_adjudicator.py`
- 修改：`src/core/v4/pipeline.py`

- [ ] **步骤 1：编写固定阈值消失和 observe 对照测试**

```python
def test_second_round_depends_on_voi_not_count_or_reported_confidence():
    adjudicator = adjudicator_with_calibrated_policy(
        first_round=decision(confidence=0.99),
        calibrated_high_upper=0.20,
        voi=0.4,
    )
    result = adjudicator.adjudicate(cluster_with_occurrence_count(1))
    assert result.rounds == 2


def test_negative_voi_skips_second_round_even_for_many_occurrences():
    adjudicator = adjudicator_with_calibrated_policy(
        first_round=decision(confidence=0.20),
        calibrated_high_upper=0.03,
        voi=-0.1,
    )
    result = adjudicator.adjudicate(cluster_with_occurrence_count(12))
    assert result.rounds == 1
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_candidate_adjudicator.py -q
```

预期：FAIL，旧 `_needs_independent_round` 仍按数量和 confidence 决定。

- [ ] **步骤 3：替换复审入口**

删除固定条件，新增：

```python
def _should_request_independent_round(
    self,
    first_round: _RoundOutcome,
    cluster: CandidateCluster,
) -> bool:
    estimate = self.risk_estimator.adjudication_risk(first_round, cluster)
    voi = self.voi_estimator.second_adjudication_round(
        estimate=estimate,
        model_cost=self.second_round_cost,
    )
    return should_query(
        voi=voi,
        current_high_upper=estimate.high_upper,
        quality=self.quality_policy,
        calls_used=1,
        call_limit=self.max_rounds,
    )
```

模型 `confidence` 只作为校准器输入特征。

- [ ] **步骤 4：接入三态模式和 decision event**

- `legacy` 使用旧结果，但旧 `_needs_independent_round` 逻辑移入测试夹具中的
  `LegacyAdjudicationPolicy`，不留散落 if。
- `observe` 同时计算新旧动作，旧动作控制，保存差异。
- `active` 使用新动作；冲突且无满足预算动作时选择保守兜底并完成，不自动阻塞。

- [ ] **步骤 5：运行裁决测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_candidate_adjudicator.py tests/test_scan_adjudication_split.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/adjudicator.py src/core/v4/pipeline.py `
  tests/test_candidate_adjudicator.py
git commit -m "feat: adjudicate candidates by information value"
```

## 任务 5：实现带约束贪心共指聚类

**文件：**
- 创建：`src/core/v4/coreference_graph.py`
- 创建：`tests/test_coreference_graph.py`
- 修改：`src/core/v4/coreference.py`
- 修改：`tests/test_lexeme_coreference.py`

- [ ] **步骤 1：编写聚类、锁冲突和 uncertain 失败测试**

```python
def test_greedy_cluster_uses_sum_of_cross_component_log_odds():
    graph = CoreferenceGraph(
        nodes=("m1", "m2", "m3"),
        edges=(
            edge("m1", "m2", probability=0.90),
            edge("m2", "m3", probability=0.80),
            edge("m1", "m3", probability=0.40),
        ),
    )
    result = graph.cluster(confidence_level=0.95)
    assert result.clusters == (("m1", "m2", "m3"),)


def test_conflicting_human_locks_return_terminal_conflict():
    result = graph_with_conflicting_must_and_cannot_link().cluster(0.95)
    assert result.status == "lock_conflict"


def test_interval_crossing_half_remains_uncertain():
    result = graph_with_interval(0.42, 0.61).cluster(0.95)
    assert result.uncertain_edges == (("m1", "m2"),)
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_coreference_graph.py -q
```

预期：FAIL，共指图不存在。

- [ ] **步骤 3：实现稳定贪心相关聚类**

```python
@dataclass(frozen=True)
class CoreferenceEdge:
    left: str
    right: str
    probability: float
    interval_low: float
    interval_high: float
    must_link: bool = False
    cannot_link: bool = False
    evidence_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CoreferenceClusterResult:
    clusters: tuple[tuple[str, ...], ...]
    uncertain_edges: tuple[tuple[str, str], ...]
    status: str = "completed"


def log_odds(probability: float, maximum: float = 12.0) -> float:
    value = min(max(probability, 1e-6), 1.0 - 1e-6)
    return max(-maximum, min(maximum, math.log(value / (1.0 - value))))


def merge_delta(
    left: frozenset[str],
    right: frozenset[str],
    weights: Mapping[tuple[str, str], float],
) -> float:
    return sum(
        weights.get(tuple(sorted((a, b))), 0.0)
        for a in left
        for b in right
    )
```

流程固定：

1. 合并 must-link 连通分量；
2. must-link 分量内出现 cannot-link 返回 `lock_conflict`；
3. 按正边权降序、节点 ID 升序遍历；
4. `merge_delta > 0` 且无 cannot-link 才合并；
5. 重复到无合并；
6. 95% 可信区间含 0.5 的未合并边记 `uncertain`。

- [ ] **步骤 4：把现有规则变为边证据**

`coreference.py` 中：

- 人工 same/different 继续生成 must/cannot-link；
- 同 span、同 evidence hash、标题目录对应、同 anchor、类型和叙事位置生成
  `CoreferenceEvidence`；
- 自动规则不得直接调用 `bind_mentions()` 或 `merge_concepts()`；
- 双模型票按各自校准似然更新边后验，不用多数票矩阵。

最终只有聚类结果驱动绑定和概念 redirect。

- [ ] **步骤 5：运行共指定向测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_coreference_graph.py tests/test_lexeme_coreference.py `
  tests/test_precise_revalidation.py -q
```

预期：全部 PASS；标题目录规则仍能贡献强证据，但不独立返回最终 same。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/coreference_graph.py src/core/v4/coreference.py `
  tests/test_coreference_graph.py tests/test_lexeme_coreference.py
git commit -m "feat: cluster coreferences from calibrated evidence"
```

## 任务 6：统一验证器、目标解析和人工反馈

**文件：**
- 修改：`src/core/v4/verifier.py`
- 修改：`src/core/v4/target_resolver.py`
- 修改：`src/core/v4/web_review.py`
- 修改：`main.py`
- 修改：`tests/test_parallel_v4.py`
- 修改：`tests/test_working_targets.py`

- [ ] **步骤 1：编写顺序验证和未校准置信度失败测试**

```python
def test_verifier_stops_after_first_vote_when_risk_budget_is_met():
    verifier = verifier_with_posteriors((0.005, 0.004))
    result = verifier.run_one(task())
    assert result.votes_used == 1


def test_target_resolver_ignores_raw_confidence_without_calibration():
    resolver = resolver_with_missing_calibration(raw_confidence=0.99)
    result = resolver.resolve_one(target_case())
    assert result.calibration_degraded is True
    assert result.accepted_automatically is False
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_parallel_v4.py tests/test_working_targets.py -q
```

预期：FAIL，验证器数量固定或目标解析仍直接使用 confidence。

- [ ] **步骤 3：实现顺序验证**

验证循环：

```python
for factory in self.verifier_factories:
    vote = self._vote(task, factory)
    posterior = self.risk_estimator.update(posterior, vote)
    if posterior.high_upper <= self.quality_policy.epsilon_high:
        break
    if self.voi.next_verifier(posterior, factory.cost) <= 0.0:
        break
```

达到调用上限后按 `RiskPolicy` 选择动作，不要求人工才能结束。

- [ ] **步骤 4：统一目标解析后验**

工作译名、旧译、Flash、Pro 和人工锁定都转换为 observation：

```python
posterior = combine_calibrated_likelihoods(
    prior=working_target_prior,
    observations=observations,
)
```

人工锁定仍是硬约束；其他来源不自动优先。缺校准时回退保守全局先验并记录
`calibration_degraded`。

- [ ] **步骤 5：接入本地反馈页面和 CLI**

`web_review.py` 的 A/B、相当、都不合格按钮立即写结构化反馈；理由输入框只更新
同一 feedback 的 `label_json`，揭示来源不得清空已保存选择。

`main.py` 新增：

```text
calibration-status-v4 <book_id>
rebuild-calibration-v4 <book_id> [--purpose PURPOSE] [--scope global|book]
```

重建命令只从结构化标签和已验证弱监督读取，不从自由评论猜标签。

- [ ] **步骤 6：运行定向测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_parallel_v4.py tests/test_working_targets.py `
  tests/test_risk_feedback.py tests/test_calibration.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/verifier.py src/core/v4/target_resolver.py `
  src/core/v4/web_review.py main.py tests/test_parallel_v4.py `
  tests/test_working_targets.py
git commit -m "feat: calibrate verification and target decisions"
```

## 任务 7：阶段 B 验收和 active 切换

**文件：**
- 修改：`tests/test_calibration.py`
- 修改：`tests/test_risk_policy.py`
- 修改：`tests/test_coreference_graph.py`
- 修改：`tests/test_v4_storage_scale.py`
- 修改：`docs/superpowers/plans/2026-07-16-calibrated-risk-decisions.md`

- [ ] **步骤 1：增加合成校准评估**

固定随机种子生成已知真实概率的数据，分别验证：

```text
Brier score
expected calibration error
95% 风险上界覆盖率
单一标签回退
书内小样本收缩
```

验收：

```python
assert calibrated_brier <= raw_brier
assert upper_bound_coverage >= 0.93
assert no_nan_or_infinite_parameters
```

- [ ] **步骤 2：运行 observe 差异报告**

在隔离项目对同一候选和共指案例同时运行 legacy/observe，导出：

```text
旧动作
新动作
风险上界
VOI
实际后续标签
模型调用差
```

不得改变活动词库或译文。

- [ ] **步骤 3：运行完整验证**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_calibration.py tests/test_risk_policy.py `
  tests/test_coreference_graph.py tests/test_candidate_adjudicator.py `
  tests/test_lexeme_coreference.py tests/test_v4_storage_scale.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests --ignore=tests/test_foila_logic.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m compileall src main.py
git diff --check
```

预期：零失败，compileall 成功，diff check 无输出。

- [ ] **步骤 4：切换 adjudication 默认模式**

只有同时满足：

```text
严重错误上界覆盖率 >= 93%
锁定冲突误合并数 = 0
未来信息泄露数 = 0
observe 决策可重放率 = 100%
无人值守未终止任务数 = 0
```

才把 `OptimizationModes.adjudication` 默认值改为 `ACTIVE`。未满足则继续
`OBSERVE`，不删除校准记录。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/v4/risk_models.py tests/test_calibration.py `
  tests/test_risk_policy.py tests/test_coreference_graph.py `
  tests/test_v4_storage_scale.py `
  docs/superpowers/plans/2026-07-16-calibrated-risk-decisions.md
git commit -m "test: verify calibrated risk decisions"
```
