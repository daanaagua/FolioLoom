# 自适应扫描、调度与知识纪元收敛实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用版本化 L2 逻辑回归和风险覆盖优化替换固定词汇筛选、叙事波动权重、`35 / 65` 调度档位和最多三次知识纪元。

**架构：** `linear_risk.py` 提供统一稀疏特征和逻辑回归；`candidate_policy.py` 在扫描预算内最大化预计避免损失；`scheduler_policy.py` 枚举安全调度动作并选择风险预算内的最低成本动作；`epoch_policy.py` 用残余变化质量和下一纪元 VOI 停止。所有模型都可退回版本化冷启动先验。

**技术栈：** Python 3.14 标准库、SQLite、pytest、现有 scanner、narrative scheduler、knowledge epoch coordinator 和质量报告。

---

## 文件结构

### 创建

- `src/core/v4/linear_risk.py`：稀疏特征向量、L2 逻辑回归、标准化和版本序列化。
- `src/core/v4/candidate_policy.py`：候选风险、传播规模和扫描预算覆盖选择。
- `src/core/v4/scheduler_policy.py`：调度动作枚举、跨岛风险和墙钟成本选择。
- `src/core/v4/epoch_policy.py`：残余变化质量、下一纪元 VOI 和绝对上限。
- `tests/test_linear_risk.py`：拟合、确定性、冷启动和坏模型回退。
- `tests/test_candidate_policy.py`：风险覆盖、预算和候选上限。
- `tests/test_scheduler_policy.py`：安全边界、成本、限流降级和稳定计划。
- `tests/test_epoch_policy.py`：收敛、正边际收益和绝对上限。

### 修改

- `src/core/v4/calibration.py`：复用公共 `L2LogisticModel`，不维护第二套梯度实现。
- `src/core/v4/lexical_index.py`：只生成特征和有限候选，不按硬编码分数最终筛选。
- `src/core/v4/scanner.py`：调用候选风险和覆盖选择。
- `src/core/v4/narrative_scheduler.py`：保留结构边界，改为调度策略适配器。
- `src/core/v4/knowledge_epochs.py`：用 epoch policy 代替固定最多三轮。
- `src/core/v4/pipeline.py`：训练数据记录、三态模式、运行成本和恢复。
- `src/core/v4/risk_store.py`：保存候选/调度模型、动作成本和 epoch decision。
- `src/core/v4/database.py`：状态和报告查询。
- `src/core/v4/exporter.py`：输出候选、调度、纪元和校准指标。
- `main.py`：新增策略状态、模型重建和 rollout 参数。
- `tests/test_candidate_lattice.py`、`tests/test_narrative_pipeline.py`、
  `tests/test_v4_knowledge_epochs.py`、`tests/test_v4_storage_scale.py`：
  覆盖集成、恢复和规模。

## 任务 1：实现统一 L2 逻辑风险模型

**文件：**
- 创建：`src/core/v4/linear_risk.py`
- 创建：`tests/test_linear_risk.py`
- 修改：`src/core/v4/calibration.py`

- [ ] **步骤 1：编写拟合确定性和冷启动失败测试**

```python
def test_l2_logistic_fit_is_deterministic_for_sparse_features():
    samples = (
        ({"bias": 1.0, "uncertainty": 0.1}, 0),
        ({"bias": 1.0, "uncertainty": 0.9}, 1),
        ({"bias": 1.0, "uncertainty": 0.8}, 1),
    )
    first = L2LogisticModel.fit(samples, l2=0.2, iterations=400)
    second = L2LogisticModel.fit(tuple(reversed(samples)), l2=0.2, iterations=400)
    assert first.to_mapping() == second.to_mapping()


def test_invalid_saved_model_uses_conservative_prior():
    model = load_or_default(
        {"weights": {"x": float("nan")}},
        default_probability=0.25,
    )
    assert model.predict({"x": 1.0}) == pytest.approx(0.25)
    assert model.degraded is True
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_linear_risk.py -q
```

预期：FAIL，公共逻辑模型不存在。

- [ ] **步骤 3：实现稳定稀疏特征**

```python
@dataclass(frozen=True)
class SparseVector:
    values: Mapping[str, float]

    def normalized(self) -> tuple[tuple[str, float], ...]:
        result = []
        for key, value in sorted(self.values.items()):
            number = float(value)
            if not math.isfinite(number):
                raise ValueError(f"non-finite feature: {key}")
            if number != 0.0:
                result.append((str(key), number))
        return tuple(result)
```

特征 schema 由 `feature_version` 锁定；未知特征忽略，缺失特征视为 0。

- [ ] **步骤 4：实现 L2 逻辑回归**

训练前按规范键排序样本，使用固定学习率衰减：

```python
for step in range(iterations):
    gradient = {name: l2 * weight for name, weight in weights.items()}
    for vector, label in ordered_samples:
        error = sigmoid(dot(weights, vector)) - label
        for name, value in vector.normalized():
            gradient[name] = gradient.get(name, 0.0) + error * value
    rate = learning_rate / math.sqrt(step + 1.0)
    scale = 1.0 / len(ordered_samples)
    for name in sorted(gradient):
        weights[name] = weights.get(name, 0.0) - rate * gradient[name] * scale
```

序列化保存 weights、l2、iterations、feature_version、sample_count 和训练指标。

- [ ] **步骤 5：让 beta calibration 复用公共模型**

`BetaCalibration.fit()` 只负责把 reported confidence 转成
`log(p), -log(1-p), bias` 特征，再调用 `L2LogisticModel.fit()`。
删除重复梯度实现，保持旧序列化兼容读取。

- [ ] **步骤 6：运行风险和校准测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_linear_risk.py tests/test_calibration.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/linear_risk.py src/core/v4/calibration.py `
  tests/test_linear_risk.py
git commit -m "feat: add reusable linear risk model"
```

## 任务 2：实现候选风险覆盖扫描

**文件：**
- 创建：`src/core/v4/candidate_policy.py`
- 创建：`tests/test_candidate_policy.py`
- 修改：`src/core/v4/lexical_index.py`
- 修改：`src/core/v4/scanner.py`
- 修改：`tests/test_candidate_lattice.py`

- [ ] **步骤 1：编写硬编码资格消失和预算选择失败测试**

```python
def test_candidate_extractor_emits_features_without_final_term_decision():
    candidates = LexicalCandidateExtractor(max_candidates=12).extract(block())
    assert candidates
    assert all(candidate.feature_vector for candidate in candidates)
    assert all(candidate.selection_status == "unscored" for candidate in candidates)


def test_scan_budget_maximizes_expected_avoided_loss():
    selected = CandidatePolicy(scan_budget=6).select(
        (
            candidate("a", risk=0.8, impact=4.0, spread=3, cost=6),
            candidate("b", risk=0.7, impact=3.0, spread=3, cost=3),
            candidate("c", risk=0.6, impact=3.0, spread=2, cost=3),
        )
    )
    assert selected.ids == ("b", "c")
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_candidate_policy.py tests/test_candidate_lattice.py -q
```

预期：FAIL，候选仍由固定规则截断或 policy 不存在。

- [ ] **步骤 3：把旧规则改为特征**

`LexicalCandidate` 增加：

```python
feature_vector: dict[str, float]
selection_status: str = "unscored"
```

特征包括：

```text
length_chars
token_count
capitalization_ratio
book_frequency
context_diversity
translation_disagreement
relation_participation
baseline_stability
estimated_affected_blocks
legacy_stopword_signal
legacy_structure_risk
```

停用词、大小写和长度不再直接返回 reject；只有空 span、非法偏移、非文本和每块
绝对候选上限继续是确定性边界。

- [ ] **步骤 4：实现候选风险和覆盖选择**

```python
@dataclass(frozen=True)
class CandidateRisk:
    id: str
    risk_probability: float
    impact: float
    propagation: float
    cost: int


def avoided_loss(candidate: CandidateRisk) -> float:
    return (
        candidate.risk_probability
        * candidate.impact
        * candidate.propagation
    )
```

首版选择使用确定性单位成本贪心并做一次单候选改进：

1. 按 `avoided_loss / cost DESC, avoided_loss DESC, id ASC` 加入可放下候选；
2. 比较贪心集合和预算内单个最高 avoided loss 候选；
3. 取总 avoided loss 更高者；
4. 绝对每块候选上限在特征生成后、模型调用前执行。

该近似算法、版本和误差界进入 decision event。`risk_probability` 使用候选模型
经过 beta calibration 后的错误概率；自动筛选比较其 `confidence_level` 风险
上界，不使用逻辑回归点估计或模型自报值。

- [ ] **步骤 5：接入三态 scanner**

- `legacy`：旧选中集合控制。
- `observe`：旧集合控制，新集合保存。
- `active`：新集合控制；旧分值只作特征。

候选风险模型使用 `L2LogisticModel`；无标签时读取版本化保守先验，再由校准层
给出可用于风险约束的上界。

- [ ] **步骤 6：运行候选测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_candidate_policy.py tests/test_candidate_lattice.py `
  tests/test_scan_adjudication_split.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/candidate_policy.py src/core/v4/lexical_index.py `
  src/core/v4/scanner.py tests/test_candidate_policy.py `
  tests/test_candidate_lattice.py
git commit -m "feat: scan lexical candidates by risk coverage"
```

## 任务 3：实现风险受限动态调度

**文件：**
- 创建：`src/core/v4/scheduler_policy.py`
- 创建：`tests/test_scheduler_policy.py`
- 修改：`src/core/v4/narrative_scheduler.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`tests/test_narrative_pipeline.py`

- [ ] **步骤 1：编写固定档位消失和安全边界失败测试**

```python
def test_scheduler_source_has_no_35_65_decision_thresholds():
    source = inspect.getsource(NarrativeScheduler.plan)
    assert "volatility >= self.high_threshold" not in source
    assert "volatility >= self.medium_threshold" not in source


def test_scheduler_rejects_fast_action_above_island_risk_budget():
    policy = SchedulerPolicy(epsilon_island=0.03)
    result = policy.select(
        actions=(
            action(workers=8, island_size=8, risk_upper=0.20, wall_ms=100),
            action(workers=2, island_size=2, risk_upper=0.02, wall_ms=300),
        )
    )
    assert result.workers == 2
    assert result.island_size == 2
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_scheduler_policy.py tests/test_narrative_pipeline.py -q
```

预期：FAIL，调度器仍按固定波动阈值。

- [ ] **步骤 3：定义有限动作集合**

只枚举配置允许的笛卡尔积：

```python
@dataclass(frozen=True)
class SchedulerBounds:
    max_workers: int
    island_sizes: tuple[int, ...]
    premap_ahead_values: tuple[int, ...]
    candidate_counts: tuple[int, ...]
    validator_counts: tuple[int, ...]
    model_tiers: tuple[str, ...]


@dataclass(frozen=True)
class SchedulerAction:
    workers: int
    island_size: int
    premap_ahead: int
    candidate_count: int
    validator_count: int
    model_tier: str
    risk_upper: float = 1.0
    expected_wall_ms: float = 0.0
    expected_tokens: float = 0.0

    def stable_key(self) -> tuple[object, ...]:
        return (
            self.workers,
            self.island_size,
            self.premap_ahead,
            self.candidate_count,
            self.validator_count,
            self.model_tier,
        )


def enumerate_actions(config: SchedulerBounds) -> tuple[SchedulerAction, ...]:
    return tuple(
        SchedulerAction(
            workers=workers,
            island_size=island,
            premap_ahead=ahead,
            candidate_count=candidates,
            validator_count=validators,
            model_tier=tier,
        )
        for workers in range(1, config.max_workers + 1)
        for island in config.island_sizes
        for ahead in config.premap_ahead_values
        for candidates in config.candidate_counts
        for validators in config.validator_counts
        for tier in config.model_tiers
    )
```

章节和显式叙事边界在动作物化时强制切岛，不能被模型覆盖。

- [ ] **步骤 4：预测跨岛风险和墙钟成本**

风险特征：

```text
workers
island_size
premap_ahead
candidate_count
validator_count
model_tier
new_subjects
viewpoint_shift
narrator_layer_shift
time_shift
location_shift
unresolved_references
uncertain_coreferences
premap_degraded
recent_rate_limit
recent_protocol_failure
```

风险使用 L2 逻辑回归的 95% 上界；成本使用最近同动作和相邻动作的指数移动平均：

```python
new_cost = alpha * observed_ms + (1.0 - alpha) * prior_cost
```

无历史时使用配置的冷启动成本表。

- [ ] **步骤 5：实现策略选择和限流降级**

```python
safe = [
    action
    for action in actions
    if action.risk_upper <= epsilon_island
    and action.workers <= runtime_worker_cap
]
selected = min(
    safe,
    key=lambda item: (
        item.expected_wall_ms + lambda_token * item.expected_tokens,
        item.risk_upper,
        item.stable_key(),
    ),
)
```

若无 safe 动作，选择最低风险动作并记录 `risk_budget_unmet`。外部限流立即降低
`runtime_worker_cap`；连续成功按现有恢复节奏逐步提高，不绕过风险检查。

- [ ] **步骤 6：接入三态和恢复**

`DynamicWavePlan` 增加：

```python
decision_id: str
risk_upper: float
expected_wall_ms: float
policy_version: str
```

恢复运行读取原 run 的模式和 policy version；同一 knowledge epoch 继续按
`global_index` 提交。

- [ ] **步骤 7：运行调度测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_scheduler_policy.py tests/test_narrative_pipeline.py `
  tests/test_parallel_v4.py tests/test_v4_storage_scale.py -q
```

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```powershell
git add src/core/v4/scheduler_policy.py `
  src/core/v4/narrative_scheduler.py src/core/v4/pipeline.py `
  tests/test_scheduler_policy.py tests/test_narrative_pipeline.py
git commit -m "feat: schedule translation waves by predicted risk"
```

## 任务 4：实现知识纪元边际收益停止

**文件：**
- 创建：`src/core/v4/epoch_policy.py`
- 创建：`tests/test_epoch_policy.py`
- 修改：`src/core/v4/knowledge_epochs.py`
- 修改：`tests/test_v4_knowledge_epochs.py`

- [ ] **步骤 1：编写正收益继续和绝对上限失败测试**

```python
def test_epoch_continues_when_expected_avoided_loss_exceeds_cost():
    decision = EpochPolicy(max_epochs=8).decide(
        epoch=2,
        changes=(
            change(probability=0.8, impact=5.0),
            change(probability=0.4, impact=2.0),
        ),
        next_epoch_cost=2.0,
    )
    assert decision.continue_epoch is True


def test_absolute_limit_finishes_with_warning():
    decision = EpochPolicy(max_epochs=4).decide(
        epoch=4,
        changes=(change(probability=0.9, impact=10.0),),
        next_epoch_cost=1.0,
    )
    assert decision.continue_epoch is False
    assert decision.warning == "epoch_limit_with_residual_risk"
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_epoch_policy.py tests/test_v4_knowledge_epochs.py -q
```

预期：FAIL，epoch policy 不存在或仍使用固定三轮。

- [ ] **步骤 3：实现残余变化质量**

```python
@dataclass(frozen=True)
class EpochChange:
    change_id: int
    material_translation_probability: float
    impact: float


@dataclass(frozen=True)
class EpochDecision:
    continue_epoch: bool
    residual_mass: float
    expected_avoided_loss: float
    warning: str = ""


def residual_change_mass(changes: Sequence[EpochChange]) -> float:
    return sum(
        change.material_translation_probability * change.impact
        for change in changes
    )


def decide(self, epoch, changes, next_epoch_cost):
    mass = residual_change_mass(changes)
    avoided_loss = self.avoided_loss_model.predict(mass, changes)
    if epoch >= self.max_epochs:
        return EpochDecision(False, mass, avoided_loss, "epoch_limit_with_residual_risk")
    if avoided_loss <= next_epoch_cost:
        return EpochDecision(False, mass, avoided_loss, "")
    return EpochDecision(True, mass, avoided_loss, "")
```

绝对上限默认保留当前配置值但不再固定为三；它只防失控。

- [ ] **步骤 4：接入 coordinator 和幂等恢复**

`KnowledgeEpochCoordinator.checkpoint()` 保存：

```text
residual_change_mass
expected_avoided_loss
next_epoch_cost
continue_epoch
stop_reason
policy_version
```

同一 change set 重跑复用 decision event；到上限时保留当前最佳译文并生成警告，
不留下 pending。

- [ ] **步骤 5：运行纪元测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_epoch_policy.py tests/test_v4_knowledge_epochs.py `
  tests/test_narrative_pipeline.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/epoch_policy.py src/core/v4/knowledge_epochs.py `
  tests/test_epoch_policy.py tests/test_v4_knowledge_epochs.py
git commit -m "feat: stop knowledge epochs by marginal value"
```

## 任务 5：接入策略状态、训练数据和质量报告

**文件：**
- 修改：`src/core/v4/risk_store.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/exporter.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`main.py`
- 修改：`tests/test_parallel_v4.py`

- [ ] **步骤 1：编写状态和模型重建失败测试**

```python
def test_status_exposes_each_policy_mode_and_model_version(database):
    status = database.status_summary()
    assert status["policy_modes"]["candidate_scan"] in {"legacy", "observe", "active"}
    assert status["policy_modes"]["scheduling"] in {"legacy", "observe", "active"}
    assert "candidate_risk_model" in status["model_versions"]
    assert "island_risk_model" in status["model_versions"]


def test_rebuild_policy_model_is_reproducible(cli):
    first = cli.invoke("rebuild-risk-model-v4", "book", "--purpose", "island")
    second = cli.invoke("rebuild-risk-model-v4", "book", "--purpose", "island")
    assert first.json["parameters_hash"] == second.json["parameters_hash"]
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_parallel_v4.py -q
```

预期：FAIL，状态字段和命令不存在。

- [ ] **步骤 3：记录训练标签和成本**

候选标签来自后续人工/强模型接受、译名漂移和合成扰动；调度标签来自：

```text
跨岛依赖被后续重验判错
因上下文缺失导致整块重译
协议失败
未来泄露
成功墙钟时间
token 数
限流/网络错误
```

训练读取冻结时间点之前的数据，禁止使用当前待决动作的未来结果。

- [ ] **步骤 4：新增 CLI**

```text
policy-status-v4 <book_id>
rebuild-risk-model-v4 <book_id> --purpose candidate|island [--scope global|book]
set-policy-mode-v4 <book_id> --policy POLICY --mode legacy|observe|active
```

`set-policy-mode-v4` 从 `observe` 切到 `active` 时运行该政策的验收查询；未达到门槛
拒绝切换。`active` 切回 `legacy` 不删除数据。

- [ ] **步骤 5：扩展质量报告**

报告至少包含：

```text
candidate_risk_coverage
candidate_model_calibration
selected_candidates_per_1000_words
island_risk_upper_distribution
wall_time_by_action
token_cost_by_action
rate_limit_downgrades
epoch_count_distribution
epoch_residual_mass
policy_observe_disagreement
policy_active_fallbacks
```

- [ ] **步骤 6：运行 CLI 和报告测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_parallel_v4.py tests/test_candidate_policy.py `
  tests/test_scheduler_policy.py tests/test_epoch_policy.py -q
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/risk_store.py src/core/v4/database.py `
  src/core/v4/exporter.py src/core/v4/pipeline.py main.py `
  tests/test_parallel_v4.py
git commit -m "feat: expose adaptive policy controls and metrics"
```

## 任务 6：规模测试、真实作品试跑和最终验收

**文件：**
- 修改：`tests/test_v4_storage_scale.py`
- 修改：`tests/test_narrative_pipeline.py`
- 修改：`docs/superpowers/specs/2026-07-16-risk-constrained-translation-optimization-design.md`
- 修改：`docs/superpowers/plans/2026-07-16-adaptive-scheduling-convergence.md`

- [ ] **步骤 1：增加 200–300 万字合成长篇**

构造约 250 万英文词、流式分块、重复和歧义候选、叙事层切换、记忆关系和重验
变化。测试断言：

```python
assert peak_loaded_blocks <= configured_wave_limit + configured_premap_ahead
assert candidate_edges <= occurrences * sparse_edge_ratio
assert active_database_bytes <= source_bytes * configured_storage_ratio
assert unfinished_revalidation_count == 0
assert epoch_count <= absolute_epoch_limit
```

禁止为全书构建 occurrence 完全图。

- [ ] **步骤 2：增加模型失效和恢复测试**

依次注入：

```text
候选风险模型损坏
调度校准缺失
两个验证模型冲突
模型协议返回空候选
网络限流
知识纪元达到绝对上限
```

断言系统使用保守先验、降低并发、记录退化并进入明确终态。

- [ ] **步骤 3：运行完整自动测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_linear_risk.py tests/test_candidate_policy.py `
  tests/test_scheduler_policy.py tests/test_epoch_policy.py `
  tests/test_v4_storage_scale.py tests/test_narrative_pipeline.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests --ignore=tests/test_foila_logic.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m compileall src main.py
git diff --check
```

预期：测试零失败，compileall 成功，diff check 无输出。

- [ ] **步骤 4：在隔离项目运行《新日之书》**

复制项目数据库，不修改正式项目。依次执行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py migrate-v4 `
  new_sun_risk_trial --preview
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py migrate-v4 `
  new_sun_risk_trial --confirm <preview 输出的 confirmation_token>
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py set-policy-mode-v4 `
  new_sun_risk_trial --policy all --mode observe
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py translate-v4 `
  new_sun_risk_trial --max-blocks 24
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py policy-status-v4 `
  new_sun_risk_trial
```

人工查看：

```text
torturer / executioner / headsman / carnifex
自称、群体、制度、呼语和比喻
标题目录与正文
梦境、回忆、转述和不可靠叙述层
```

检查代码和 decision event，确认没有按作品字符串分支。

- [ ] **步骤 5：在隔离项目运行 `Incandescence`**

至少覆盖 `scape`、不同观察者版本、虚拟感知场景和目标中文自然度。检查同一
源词的不同 realization 来自 occurrence 关系和候选风险，而不是固定全局替换。

- [ ] **步骤 6：盲评和成本比较**

使用已有本地 A/B 页面，样本来源、顺序和模型身份保持盲化。至少报告：

```text
schema 9 与 schema 10 A/B 胜率
严重错误漏检率
每千词模型调用数
每千词 token
平均墙钟时间
整块重译率
无人值守完成率
```

切换 active 的最低条件：

```text
严重错误漏检率不高于 schema 9
同成本 A/B 胜率提高，或同胜率成本下降
未来泄露数 = 0
活动译文缺块数 = 0
无人值守无限循环数 = 0
```

- [ ] **步骤 7：切换其余默认策略**

满足门槛后把 `candidate_scan`、`scheduling` 和 `epoch` 改为 `ACTIVE`。
任一单项不达标则该项保持 `OBSERVE`，其他已达标项可以独立 active。

- [ ] **步骤 8：更新规格状态和实测证据**

把规格头部改为：

```text
状态：已实现并通过回归
```

在规格末尾追加实际：

```text
commit 范围
测试通过数
规模样本大小
真实作品试跑块数
盲评样本数和结果
成本变化
仍处于 observe 的策略
```

不得写预计数字。

- [ ] **步骤 9：最终 Commit**

```powershell
git add src/core/v4/risk_models.py tests/test_v4_storage_scale.py `
  tests/test_narrative_pipeline.py `
  docs/superpowers/specs/2026-07-16-risk-constrained-translation-optimization-design.md `
  docs/superpowers/plans/2026-07-16-adaptive-scheduling-convergence.md
git commit -m "test: verify risk-constrained translation end to end"
```
