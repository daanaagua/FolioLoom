# schema 10 与局部因子推断基础实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立 schema 10、统一 occurrence/interpretation/realization 表示和可审计局部因子图，并用通用关系残差替代职业、呼语和具体敬称的生产特判。

**架构：** 新增小型专责模块 `risk_models.py`、`risk_store.py`、`factor_graph.py`、`semantic_alignment.py` 和 `realization_optimizer.py`，避免继续扩大 `database.py`。schema 10 通过显式预览/确认从 schema 9 原子迁移；新推断先以 `observe` 模式记录结果，再通过回归门槛切换为 `active`。

**技术栈：** Python 3.14、dataclasses、Pydantic 2、SQLite、pytest、现有两层翻译器。

---

## 文件结构

### 创建

- `src/core/v4/schema_v10.py`：schema 10 创建、检查、预览、确认和 schema 9→10 原子迁移。
- `src/core/v4/risk_models.py`：不可变策略模式、质量政策、occurrence、候选、因子和风险类型。
- `src/core/v4/risk_store.py`：schema 10 轻量结构的追加式持久化和读取。
- `src/core/v4/factor_graph.py`：有限候选格、硬约束过滤、风险向量比较和局部残差计算。
- `src/core/v4/semantic_alignment.py`：源端/目标端有限语义单元及覆盖报告。
- `src/core/v4/realization_optimizer.py`：风险驱动坐标下降和局部候选生成接口。
- `tests/test_v4_schema10_migration.py`：创建、迁移、回滚和旧数据保留。
- `tests/test_risk_store.py`：追加式写入、重放和版本隔离。
- `tests/test_factor_graph.py`：硬约束、词典序风险和局部更新。
- `tests/test_semantic_alignment.py`：谓词论元、呼语、群体关系和受保护结构。
- `tests/test_realization_optimizer.py`：坐标下降、VOI 停止和保守兜底。

### 修改

- `src/core/v4/database.py`：切换 schema 入口，向专责 store 提供事务和只读连接。
- `src/core/v4/migration.py`：识别并确认 schema 9→10。
- `src/core/v4/models.py`：让翻译结果携带 occurrence 特征和局部优化审计 ID。
- `src/core/v4/pipeline.py`：构造三态模式并在翻译提交前运行局部优化。
- `src/core/v4/target_resolver.py`：删除 `role` 专用复核和固定呼语补全。
- `src/core/v4/term_validator.py`：改为生成通用因子证据，不决定职业译名。
- `src/core/v4/context.py`：渲染 occurrence 关系约束，不插入逐词标记。
- `src/core/translator.py`：接受结构化关系约束和局部候选请求。
- `src/core/v4/__init__.py`：导出 schema 10 公共类型。
- `main.py`：迁移命令显示 schema 10 预览与确认结果。
- `tests/test_candidate_adjudicator.py`、`tests/test_working_targets.py`、
  `tests/test_term_validator.py`、`tests/test_parallel_v4.py`：移除类别控制断言并增加通用关系回归。

## 任务 0：冻结当前 schema 9 语境化术语基线

**文件：**
- 修改：当前工作区中 `docs/superpowers/plans/2026-07-16-contextual-term-profiles.md`
- 修改：当前工作区中 `docs/superpowers/specs/2026-07-16-contextual-term-profiles-design.md`
- 修改：当前工作区已有语境化术语实现和测试文件

- [ ] **步骤 1：确认只存在已知语境化术语改动**

运行：

```powershell
git status --short
git diff --stat
```

预期：除 schema 10 计划文档外，代码改动只属于语境化术语档案、目标解析、
匹配器、翻译注入和对应测试；若出现其他用户改动，不纳入本任务 commit。

- [ ] **步骤 2：重新运行语境化术语定向测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_candidate_adjudicator.py `
  tests/test_working_targets.py `
  tests/test_v4_matcher_targets.py `
  tests/test_term_validator.py -q
```

预期：`110 passed` 或更多，零失败。

- [ ] **步骤 3：运行现有全量回归**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests --ignore=tests/test_foila_logic.py -q
```

预期：零失败；记录精确通过数作为 schema 10 基线。

- [ ] **步骤 4：独立提交 schema 9 基线**

```powershell
git add `
  docs/superpowers/plans/2026-07-16-contextual-term-profiles.md `
  docs/superpowers/specs/2026-07-16-contextual-term-profiles-design.md `
  src/core/schemas.py src/core/translator.py `
  src/core/v4/adjudicator.py src/core/v4/context.py `
  src/core/v4/database.py src/core/v4/matcher.py src/core/v4/models.py `
  src/core/v4/pipeline.py src/core/v4/schema_v9.py `
  src/core/v4/target_resolver.py src/core/v4/term_validator.py `
  tests/test_candidate_adjudicator.py tests/test_lexeme_coreference.py `
  tests/test_parallel_v4.py tests/test_v4_matcher_targets.py `
  tests/test_working_targets.py tests/test_term_validator.py
git diff --cached --check
git commit -m "feat: add contextual term profiles"
```

预期：schema 10 计划文档不在该 commit 中。

## 任务 1：建立 schema 10 和显式迁移

**文件：**
- 创建：`src/core/v4/schema_v10.py`
- 创建：`tests/test_v4_schema10_migration.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/migration.py`
- 修改：`src/core/v4/__init__.py`
- 修改：`main.py`

- [ ] **步骤 1：编写空库和 schema 9 升级失败测试**

在 `tests/test_v4_schema10_migration.py` 写入：

```python
import sqlite3

import pytest

from src.core.v4.database import V4Database
from src.core.v4.schema_v10 import (
    migrate_schema10,
    preview_schema10,
)


EXPECTED = {
    "occurrence_features",
    "semantic_interpretations",
    "realization_candidates",
    "factor_constraints",
    "calibration_models",
    "decision_events",
    "evaluation_feedback",
    "model_observations",
}


def test_empty_database_initializes_schema10(tmp_path):
    database = V4Database(tmp_path)
    database.initialize()
    with database.connect() as connection:
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert version == "10"
    assert EXPECTED <= tables


def test_schema9_requires_explicit_schema10_confirmation(schema9_project):
    preview = preview_schema10(schema9_project)
    assert preview["from_version"] == 9
    assert preview["to_version"] == 10
    with pytest.raises(ValueError, match="confirmation token"):
        migrate_schema10(schema9_project, "wrong-token")
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_v4_schema10_migration.py -q
```

预期：FAIL，`schema_v10` 无法导入。

- [ ] **步骤 3：实现 schema 10 表和索引**

`schema_v10.py` 定义 `SCHEMA_VERSION = 10`，调用 `create_schema9()` 后执行以下
表结构。`model_observations` 是规格第 7 节 observation 的轻量正规化投影；
原始请求/响应仍只保存在 `audit_calls` 和压缩归档。

```sql
CREATE TABLE occurrence_features (
    occurrence_id INTEGER NOT NULL REFERENCES mentions(id),
    feature_version TEXT NOT NULL,
    features_json TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(occurrence_id, feature_version)
);
CREATE TABLE semantic_interpretations (
    id TEXT PRIMARY KEY,
    occurrence_id INTEGER NOT NULL REFERENCES mentions(id),
    predicate TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    features_json TEXT NOT NULL,
    prior_probability REAL NOT NULL CHECK(prior_probability BETWEEN 0 AND 1),
    posterior_probability REAL NOT NULL CHECK(posterior_probability BETWEEN 0 AND 1),
    status TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    model_id TEXT,
    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
    retired_version INTEGER REFERENCES knowledge_versions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_semantic_interpretations_active
    ON semantic_interpretations(occurrence_id, retired_version, status);
CREATE TABLE realization_candidates (
    id TEXT PRIMARY KEY,
    occurrence_id INTEGER NOT NULL REFERENCES mentions(id),
    interpretation_id TEXT REFERENCES semantic_interpretations(id),
    target_text TEXT NOT NULL,
    generator TEXT NOT NULL,
    model_id TEXT,
    feature_vector_json TEXT NOT NULL,
    local_score REAL NOT NULL,
    posterior_probability REAL NOT NULL CHECK(posterior_probability BETWEEN 0 AND 1),
    status TEXT NOT NULL,
    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
    retired_version INTEGER REFERENCES knowledge_versions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_realization_candidates_active
    ON realization_candidates(occurrence_id, retired_version, status);
CREATE TABLE factor_constraints (
    id TEXT PRIMARY KEY,
    factor_type TEXT NOT NULL,
    subject_ids_json TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    hard_constraint INTEGER NOT NULL CHECK(hard_constraint IN (0, 1)),
    weight REAL NOT NULL,
    calibration_version TEXT,
    evidence_ids_json TEXT NOT NULL,
    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
    retired_version INTEGER REFERENCES knowledge_versions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_factor_constraints_active
    ON factor_constraints(factor_type, retired_version, created_version);
CREATE TABLE calibration_models (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    language_pair TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'book')),
    book_id TEXT,
    method TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_calibration_lookup
    ON calibration_models(
        model_id, purpose, protocol_version, language_pair, scope, book_id, created_at
    );
CREATE TABLE model_observations (
    id TEXT PRIMARY KEY,
    audit_call_id INTEGER NOT NULL REFERENCES audit_calls(id),
    purpose TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    reported_confidence REAL CHECK(reported_confidence BETWEEN 0 AND 1),
    calibrated_probability REAL CHECK(calibrated_probability BETWEEN 0 AND 1),
    payload_hash TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    calibration_version TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_model_observations_subject
    ON model_observations(subject_type, subject_id, purpose, created_at);
CREATE TABLE decision_events (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(id),
    stage TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    posterior_json TEXT NOT NULL,
    expected_loss_json TEXT NOT NULL,
    cost_json TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    selected_action TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    calibration_version TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_decision_events_subject
    ON decision_events(stage, subject_type, subject_id, created_at);
CREATE TABLE evaluation_feedback (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    block_id TEXT REFERENCES blocks(id),
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    feedback_type TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL,
    selected_candidate_id TEXT,
    label_json TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_evaluation_feedback_subject
    ON evaluation_feedback(book_id, subject_type, subject_id, feedback_type, created_at);
```

- [ ] **步骤 4：实现预览、确认和回滚保护**

沿用 schema 9 的序列化快照和 HMAC 确认模式：

```python
def migrate_schema10(path: str | Path, confirm_token: str) -> dict[str, Any]:
    preview = preview_schema10(path)
    if not hmac.compare_digest(confirm_token, preview["confirmation_token"]):
        raise SchemaMigrationError("schema 10 confirmation token mismatch")
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        _install_schema10_extensions(connection)
        _assert_schema10_features(connection)
        connection.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '10')"
        )
        connection.commit()
    return {"status": "migrated", "schema_version": 10}
```

测试在 `_assert_schema10_features` 前注入异常，断言 schema 版本、活动译文、
人工锁定和 schema 9 记忆行数均不变。

- [ ] **步骤 5：切换入口并运行迁移测试**

`database.py` 改为从 `schema_v10` 导入 `SCHEMA_VERSION` 和
`assert_schema10_or_empty`；`migration.py` 和 `main.py` 把 schema 9 识别为
唯一可迁移来源。

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_v4_schema10_migration.py `
  tests/test_v4_schema9_migration.py `
  tests/test_v4_schema8_migration.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/schema_v10.py src/core/v4/database.py `
  src/core/v4/migration.py src/core/v4/__init__.py main.py `
  tests/test_v4_schema10_migration.py
git commit -m "feat: add schema 10 risk storage migration"
```

## 任务 2：定义公共风险类型和三态模式

**文件：**
- 创建：`src/core/v4/risk_models.py`
- 创建：`tests/test_factor_graph.py`
- 修改：`src/core/v4/models.py`
- 修改：`src/core/v4/pipeline.py`

- [ ] **步骤 1：编写质量政策和模式失败测试**

```python
import pytest

from src.core.v4.risk_models import OptimizationModes, PolicyMode, QualityPolicy


def test_quality_policy_rejects_relaxed_or_inverted_limits():
    with pytest.raises(ValueError):
        QualityPolicy(epsilon_high=0.11, epsilon_medium=0.10)
    with pytest.raises(ValueError):
        QualityPolicy(confidence_level=0.49)


def test_optimization_modes_default_to_non_mutating_rollout():
    modes = OptimizationModes()
    assert modes.inference is PolicyMode.OBSERVE
    assert modes.adjudication is PolicyMode.LEGACY
    assert modes.memory is PolicyMode.LEGACY
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_factor_graph.py -q
```

预期：FAIL，`risk_models` 无法导入。

- [ ] **步骤 3：实现不可变公共类型**

`risk_models.py` 至少定义：

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


class PolicyMode(str, Enum):
    LEGACY = "legacy"
    OBSERVE = "observe"
    ACTIVE = "active"


@dataclass(frozen=True)
class OptimizationModes:
    inference: PolicyMode = PolicyMode.OBSERVE
    adjudication: PolicyMode = PolicyMode.LEGACY
    memory: PolicyMode = PolicyMode.LEGACY
    revalidation: PolicyMode = PolicyMode.LEGACY
    scheduling: PolicyMode = PolicyMode.LEGACY
    candidate_scan: PolicyMode = PolicyMode.LEGACY
    epoch: PolicyMode = PolicyMode.LEGACY


@dataclass(frozen=True)
class QualityPolicy:
    epsilon_high: float = 0.02
    epsilon_medium: float = 0.10
    confidence_level: float = 0.95

    def __post_init__(self) -> None:
        if not 0.0 < self.epsilon_high <= self.epsilon_medium < 1.0:
            raise ValueError("risk limits must be ordered inside (0, 1)")
        if not 0.5 <= self.confidence_level < 1.0:
            raise ValueError("confidence_level must be in [0.5, 1)")


@dataclass(frozen=True)
class RiskVector:
    hard_failures: tuple[str, ...] = ()
    high_upper: float = 1.0
    medium_upper: float = 1.0
    compute_cost: float = 0.0
    style_loss: float = 0.0

    def ordering_key(self) -> tuple[object, ...]:
        return (
            bool(self.hard_failures),
            self.high_upper,
            self.medium_upper,
            self.compute_cost,
            self.style_loss,
        )


@dataclass(frozen=True)
class OccurrenceFeatureVector:
    occurrence_id: int
    block_id: str
    start_offset: int
    end_offset: int
    source_form: str
    feature_version: str
    features: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SemanticInterpretation:
    id: str
    occurrence_id: int
    predicate: str
    arguments: Mapping[str, str]
    features: Mapping[str, Any]
    prior_probability: float
    posterior_probability: float
    status: str
    evidence_ids: tuple[str, ...]
    model_id: str | None
    created_version: int
    retired_version: int | None = None


@dataclass(frozen=True)
class RealizationCandidate:
    id: str
    occurrence_id: int
    interpretation_id: str | None
    target_text: str
    generator: str
    model_id: str | None
    feature_vector: Mapping[str, float]
    local_score: float
    posterior_probability: float
    status: str
    created_version: int
    retired_version: int | None = None


@dataclass(frozen=True)
class FactorConstraint:
    id: str
    factor_type: str
    subject_ids: tuple[str, ...]
    parameters: Mapping[str, Any]
    hard_constraint: bool
    weight: float
    calibration_version: str | None
    evidence_ids: tuple[str, ...]
    created_version: int
    retired_version: int | None = None


@dataclass(frozen=True)
class DecisionCandidate:
    action: str
    candidate_id: str
    risk: RiskVector
    cost: float
    style_loss: float
    expected_high_loss: float
    expected_medium_loss: float
    payload: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DecisionResult:
    selected_action: str
    selected_candidate_id: str
    risk: RiskVector
    warning: str = ""
    feasible: bool = True

    @property
    def risk_budget_unmet(self) -> bool:
        return self.warning == "risk_budget_unmet"

    @classmethod
    def from_candidate(
        cls,
        candidate: DecisionCandidate,
        warning: str = "",
    ) -> "DecisionResult":
        return cls(
            selected_action=candidate.action,
            selected_candidate_id=candidate.candidate_id,
            risk=candidate.risk,
            warning=warning,
            feasible=not warning,
        )


@dataclass(frozen=True)
class InferenceBundle:
    occurrence: OccurrenceFeatureVector
    interpretations: tuple[SemanticInterpretation, ...]
    realizations: tuple[RealizationCandidate, ...]
    factors: tuple[FactorConstraint, ...]
    decision: DecisionResult
```

- [ ] **步骤 4：把模式加入流水线配置**

`V4PipelineConfig` 增加：

```python
quality_policy: QualityPolicy = field(default_factory=QualityPolicy)
optimization_modes: OptimizationModes = field(default_factory=OptimizationModes)
max_local_generations: int = 4
```

`__post_init__` 要求 `max_local_generations >= 1`。模式对象写入 run 的
`config_json`，确保恢复时使用相同策略。

- [ ] **步骤 5：运行类型和既有配置测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_factor_graph.py tests/test_config_loader.py tests/test_parallel_v4.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/risk_models.py src/core/v4/models.py `
  src/core/v4/pipeline.py tests/test_factor_graph.py
git commit -m "feat: define risk policy contracts"
```

## 任务 3：实现追加式风险存储

**文件：**
- 创建：`src/core/v4/risk_store.py`
- 创建：`tests/test_risk_store.py`
- 修改：`src/core/v4/database.py`

- [ ] **步骤 1：编写原子写入和重放失败测试**

```python
def test_risk_store_writes_occurrence_candidates_and_decision_atomically(database):
    store = RiskStore(database)
    with database.transaction() as connection:
        store.save_occurrence_features(feature, connection=connection)
        store.save_interpretations((interpretation,), connection=connection)
        store.save_realizations((realization,), connection=connection)
        event_id = store.record_decision(decision, connection=connection)
    replay = store.load_decision(event_id)
    assert replay.selected_action == "accept"
    assert replay.policy_version == "risk-policy-v1"


def test_risk_store_rolls_back_entire_bundle_on_invalid_factor(database):
    store = RiskStore(database)
    with pytest.raises(ValueError, match="subject_ids"):
        store.commit_inference_bundle(bundle_with_empty_subjects)
    assert store.count_rows("semantic_interpretations") == 0
    assert store.count_rows("realization_candidates") == 0
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_risk_store.py -q
```

预期：FAIL，`RiskStore` 无法导入。

- [ ] **步骤 3：实现稳定 ID 和规范 JSON**

```python
def canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def risk_id(prefix: str, value: object) -> str:
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"{prefix}_{digest[:24]}"
```

`RiskStore` 接受 `V4Database`，所有写方法支持调用者传入活动事务。重复保存完全
相同 payload 必须幂等；内容不同但 ID 相同必须抛错，不能覆盖。

- [ ] **步骤 4：实现 bundle 提交和重放**

```python
def commit_inference_bundle(
    self,
    bundle: InferenceBundle,
    *,
    connection: sqlite3.Connection | None = None,
) -> str:
    if connection is None:
        with self.database.transaction() as owned:
            return self.commit_inference_bundle(bundle, connection=owned)
    self.save_occurrence_features(bundle.occurrence, connection=connection)
    self.save_interpretations(bundle.interpretations, connection=connection)
    self.save_realizations(bundle.realizations, connection=connection)
    self.save_factors(bundle.factors, connection=connection)
    return self.record_decision(bundle.decision, connection=connection)
```

`load_decision()` 必须从 JSON 字段恢复不可变 `DecisionResult`，并验证策略和校准
版本存在。

- [ ] **步骤 5：运行存储和预算测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_risk_store.py tests/test_v4_storage_scale.py -q
```

预期：全部 PASS；活动 SQLite 预算检查继续生效。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/risk_store.py src/core/v4/database.py `
  tests/test_risk_store.py
git commit -m "feat: persist risk inference bundles"
```

## 任务 4：实现有限因子图和词典序决策

**文件：**
- 创建：`src/core/v4/factor_graph.py`
- 修改：`tests/test_factor_graph.py`

- [ ] **步骤 1：编写硬约束和风险预算失败测试**

```python
def test_hard_failure_eliminates_fluent_candidate():
    graph = FactorGraph(
        candidates=(
            candidate("smooth", "流畅译文"),
            candidate("faithful", "保留否定的译文"),
        ),
        evaluations={
            "smooth": RiskVector(
                hard_failures=("negation_missing",),
                high_upper=0.01,
                medium_upper=0.01,
            ),
            "faithful": RiskVector(
                high_upper=0.015,
                medium_upper=0.08,
                compute_cost=2.0,
            ),
        },
    )
    assert graph.select(QualityPolicy()).selected_candidate_id == "faithful"


def test_no_feasible_candidate_returns_lowest_expected_loss_with_warning():
    result = graph_with_only_over_budget_candidates().select(QualityPolicy())
    assert result.risk_budget_unmet is True
    assert result.selected_action == "conservative_fallback"
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_factor_graph.py -q
```

预期：FAIL，`FactorGraph` 无法导入。

- [ ] **步骤 3：实现统一因子和风险比较**

```python
@dataclass(frozen=True)
class FactorEvaluation:
    factor_id: str
    factor_type: str
    subject_ids: tuple[str, ...]
    residual: float
    hard_failure: str = ""
    evidence_ids: tuple[str, ...] = ()


def is_feasible(vector: RiskVector, policy: QualityPolicy) -> bool:
    return (
        not vector.hard_failures
        and vector.high_upper <= policy.epsilon_high
        and vector.medium_upper <= policy.epsilon_medium
    )
```

`FactorGraph.select()` 先过滤硬失败，再按质量政策过滤风险，最后用
`(compute_cost, high_upper, medium_upper, style_loss, candidate_id)` 稳定排序。
无可行候选时使用预期严重损失、中等损失、成本和 ID 排序，设置
`risk_budget_unmet=True`。

因子注册表固定覆盖规格中的全部类型：

```python
SUPPORTED_FACTOR_TYPES = frozenset(
    {
        "semantic_fidelity",
        "predicate_argument_preservation",
        "coreference_consistency",
        "lexical_identity",
        "contrast_separation",
        "discourse_relation",
        "register_compatibility",
        "narrative_visibility",
        "information_release",
        "structural_preservation",
        "style_continuity",
        "target_fluency",
    }
)
```

未知因子类型拒绝持久化；已知类型通过统一 `FactorEvaluator` 接口计算，不在
`FactorGraph` 中按词类或具体词汇增加分支。

- [ ] **步骤 4：实现邻域残差更新**

```python
def replace_candidate(
    self,
    subject_id: str,
    candidate: RealizationCandidate,
) -> "FactorGraph":
    affected = self.adjacency.get(subject_id, frozenset())
    evaluations = dict(self.factor_evaluations)
    for factor_id in sorted(affected):
        evaluations[factor_id] = self.evaluator.evaluate(
            self.factors[factor_id],
            {**self.assignments, subject_id: candidate},
        )
    return replace(
        self,
        assignments={**self.assignments, subject_id: candidate},
        factor_evaluations=evaluations,
    )
```

测试记录 evaluator 调用次数，断言替换一个 occurrence 不重算无关块。

同一类还实现以下稳定方法，供坐标下降直接调用：

```python
def highest_risk_region(self) -> str:
    return min(
        self.region_risks,
        key=lambda region_id: (
            -self.region_risks[region_id].high_upper,
            -self.region_risks[region_id].medium_upper,
            region_id,
        ),
    )


def risk_key(self) -> tuple[object, ...]:
    selected = self.select(self.quality_policy)
    return (
        not selected.feasible,
        selected.risk.high_upper,
        selected.risk.medium_upper,
        selected.risk.compute_cost,
        selected.risk.style_loss,
        selected.selected_candidate_id,
    )
```

`FactorGraph` 构造时保存 `quality_policy` 和按句/occurrence 聚合的
`region_risks`；空 region 集合返回当前候选，不调用局部生成。

- [ ] **步骤 5：运行因子图测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_factor_graph.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/factor_graph.py tests/test_factor_graph.py
git commit -m "feat: add finite risk factor graph"
```

## 任务 5：实现通用语义单元和关系残差

**文件：**
- 创建：`src/core/v4/semantic_alignment.py`
- 创建：`tests/test_semantic_alignment.py`
- 修改：`src/core/v4/term_validator.py`

- [ ] **步骤 1：编写职业群体、呼语和否定失败测试**

```python
def test_collective_environment_is_not_satisfied_by_bare_individual_noun():
    source = SourceSemantics.from_mapping(
        {
            "units": [
                {
                    "id": "u1",
                    "kind": "predicate",
                    "predicate": "rear",
                    "arguments": {
                        "experiencer": "Severian",
                        "environment": "collective(torturer)",
                    },
                    "hard": False,
                }
            ]
        }
    )
    target = TargetSemantics.from_mapping(
        {
            "units": [
                {
                    "id": "t1",
                    "kind": "predicate",
                    "predicate": "rear",
                    "arguments": {
                        "experiencer": "Severian",
                        "environment": "individual(torturer)",
                    },
                    "hard": False,
                }
            ]
        }
    )
    report = align(source, target)
    assert "collective_relation_missing" in report.residual_codes


def test_address_relation_does_not_require_fixed_honorific():
    source = semantics_for_address(label="torturer")
    report = align(source, target_semantics_for_address(label="torturer"))
    assert "address_relation_missing" not in report.residual_codes


def test_negation_is_a_hard_unit():
    report = align(
        semantics_with_negation("not"),
        target_semantics_without_negation(),
    )
    assert report.hard_failures == ("negation_missing",)
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_semantic_alignment.py -q
```

预期：FAIL，语义单元类型不存在。

- [ ] **步骤 3：实现有限语义表示**

```python
@dataclass(frozen=True)
class SemanticUnit:
    id: str
    kind: str
    predicate: str = ""
    arguments: Mapping[str, str] = field(default_factory=dict)
    value: str = ""
    hard: bool = False
    weight: float = 1.0


@dataclass(frozen=True)
class AlignmentReport:
    preserved_ids: tuple[str, ...]
    missing_ids: tuple[str, ...]
    residual_codes: tuple[str, ...]
    hard_failures: tuple[str, ...]
    coverage: float


@dataclass(frozen=True)
class SourceSemantics:
    units: tuple[SemanticUnit, ...]

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "SourceSemantics":
        return cls(
            units=tuple(SemanticUnit(**item) for item in value.get("units", ()))
        )


@dataclass(frozen=True)
class TargetSemantics:
    units: tuple[SemanticUnit, ...]

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "TargetSemantics":
        return cls(
            units=tuple(SemanticUnit(**item) for item in value.get("units", ()))
        )
```

源端结构来自当前预映射/翻译模型的严格 JSON 和确定性 protected span；
目标端结构由同一协议的目标分析器返回，单元测试直接提供结构化 mapping，
不在本地凭中文字符串猜语义。词典、职业和敬称只作为 unit 特征，
不能映射成直接分支。

- [ ] **步骤 4：把术语核验改成因子证据**

`TermConsistencyValidator.validate()` 保留兼容返回值，但内部调用
`build_term_factors()`：

```python
def build_term_factors(
    *,
    source_units: Sequence[SemanticUnit],
    target_units: Sequence[SemanticUnit],
    matches: Sequence[Mapping[str, Any]],
) -> tuple[FactorEvaluation, ...]:
    report = align(
        SourceSemantics(tuple(source_units)),
        TargetSemantics(tuple(target_units)),
    )
    return tuple(
        FactorEvaluation(
            factor_id=f"alignment:{code}",
            factor_type="predicate_argument_preservation",
            subject_ids=tuple(str(item["occurrence_id"]) for item in matches),
            residual=1.0,
            hard_failure=code if code in report.hard_failures else "",
        )
        for code in report.residual_codes
    )
```

删除针对 `role`、`vocative`、具体敬称后缀和具体英文词的生产判断。

- [ ] **步骤 5：运行语义和旧术语测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_semantic_alignment.py tests/test_term_validator.py `
  tests/test_v4_matcher_targets.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/semantic_alignment.py src/core/v4/term_validator.py `
  tests/test_semantic_alignment.py tests/test_term_validator.py
git commit -m "feat: validate translations with semantic relations"
```

## 任务 6：实现风险驱动坐标下降

**文件：**
- 创建：`src/core/v4/realization_optimizer.py`
- 创建：`tests/test_realization_optimizer.py`

- [ ] **步骤 1：编写局部生成和停止条件失败测试**

```python
def test_optimizer_regenerates_only_highest_risk_region():
    generator = FakeGenerator(
        {
            "sentence-2": [
                candidate("c2b", "我在拷问官行会中长大。"),
            ]
        }
    )
    result = RealizationOptimizer(
        generator=generator,
        evaluator=fake_evaluator,
        max_local_generations=4,
    ).optimize(problem_with_one_collective_residual())
    assert generator.requested_regions == ["sentence-2"]
    assert result.translation == "我在拷问官行会中长大。"


def test_optimizer_stops_when_next_generation_has_nonpositive_voi():
    result = optimizer_with_negative_voi().optimize(high_risk_problem())
    assert result.stop_reason == "nonpositive_voi"
    assert result.generation_count == 0
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_realization_optimizer.py -q
```

预期：FAIL，优化器不存在。

- [ ] **步骤 3：实现候选生成接口和坐标下降**

```python
@dataclass(frozen=True)
class OptimizationProblem:
    problem_id: str
    initial: RealizationCandidate
    interpretations: tuple[SemanticInterpretation, ...]
    factors: tuple[FactorConstraint, ...]
    quality_policy: QualityPolicy


@dataclass(frozen=True)
class OptimizationResult:
    translation: str
    selected_candidate_id: str
    decision_id: str
    generation_count: int
    stop_reason: str
    warnings: tuple[str, ...] = ()


class CandidateGenerator(Protocol):
    def generate(
        self,
        problem: OptimizationProblem,
        region_id: str,
        current_text: str,
    ) -> RealizationCandidate:
        raise NotImplementedError


def optimize(self, problem: OptimizationProblem) -> OptimizationResult:
    current = problem.initial
    graph = self.evaluator.build_graph(problem, current)
    generations = 0
    while generations < self.max_local_generations:
        selected = graph.select(problem.quality_policy)
        if selected.feasible:
            return self._result(current, graph, generations, "risk_budget_met")
        region = graph.highest_risk_region()
        if self.voi.estimate(problem, graph, region) <= 0.0:
            return self._result(current, graph, generations, "nonpositive_voi")
        proposal = self.generator.generate(problem, region, current.target_text)
        proposed_graph = graph.replace_candidate(region, proposal)
        if proposed_graph.risk_key() < graph.risk_key():
            current = proposal
            graph = proposed_graph
        generations += 1
    return self._result(current, graph, generations, "generation_limit")
```

每轮只请求一个新候选；相同风险向量按候选 ID 稳定决胜。

- [ ] **步骤 4：实现协议失败和空候选兜底**

候选生成抛出协议异常时不重置已接受候选。达到绝对调用上限后返回当前最低
预期损失候选，并写：

```python
warnings = ("candidate_lattice_empty",) if not candidates else ("risk_budget_unmet",)
```

- [ ] **步骤 5：运行优化器测试**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_realization_optimizer.py tests/test_factor_graph.py -q
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/realization_optimizer.py `
  tests/test_realization_optimizer.py
git commit -m "feat: optimize local realizations by residual risk"
```

## 任务 7：接入翻译并删除类别生产特判

**文件：**
- 修改：`src/core/v4/target_resolver.py`
- 修改：`src/core/v4/context.py`
- 修改：`src/core/translator.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`src/core/v4/models.py`
- 修改：`tests/test_working_targets.py`
- 修改：`tests/test_parallel_v4.py`
- 修改：`tests/test_realization_optimizer.py`

- [ ] **步骤 1：编写无类别分支和 observe 不改译文测试**

```python
def test_observe_mode_records_optimizer_without_changing_legacy_translation(pipeline):
    result = pipeline.run_one(
        source="I was reared among the torturers.",
        legacy_translation="我在拷问官中长大。",
        inference_mode=PolicyMode.OBSERVE,
    )
    assert result.final_translation == "我在拷问官中长大。"
    assert result.optimization_decision_id
    assert result.optimization_selected_text == "我在拷问官行会中长大。"


def test_target_resolver_has_no_role_or_vocative_decision_branch():
    source = inspect.getsource(TargetResolver)
    assert "_review_role_decisions" not in source
    assert "_augment_role_vocatives" not in source
    assert "discourse_function == \"vocative\"" not in source
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_working_targets.py tests/test_parallel_v4.py `
  tests/test_realization_optimizer.py -q
```

预期：FAIL，现有角色专用方法仍存在，流水线未记录优化决策。

- [ ] **步骤 3：删除角色专用目标复核**

从 `target_resolver.py` 删除 `_augment_role_vocatives()`、
`_review_role_decisions()`、角色专用提示和按 `entity_kind == "role"` 调用。
保留一个对全部候选一致的目标响应协议，并只生成通用特征：

```python
def _target_review_features(
    decision: WorkingTargetDecision,
    evidence: Mapping[str, Any],
) -> dict[str, float]:
    return {
        "semantic_core_missing": float(not decision.semantic_core.strip()),
        "contrast_count": float(evidence.get("contrast_count", 0)),
        "context_diversity": float(evidence.get("context_diversity", 0.0)),
        "target_disagreement": float(evidence.get("target_disagreement", 0.0)),
    }
```

该函数不返回是否复审；是否调用第二模型留给下一子计划的 VOI 策略。当前阶段
`observe` 模式只记录特征，不额外调用模型。

- [ ] **步骤 4：把 occurrence 约束加入翻译上下文**

`ContextBuilder.build()` 增加：

```python
occurrence_constraints: Sequence[Mapping[str, Any]] = ()
```

只渲染每句聚合后的关系：

```text
<semantic_obligations>
- S2: preserve rear(experiencer=Severian, environment=collective(torturer))
- S4: preserve address(speaker=X, addressee=Y, label=torturer)
</semantic_obligations>
```

不得在正文每个专名后插入短编号或内联标签。

- [ ] **步骤 5：接入三态局部优化**

在两层翻译完成、提交译文之前：

```python
optimization = self.realization_optimizer.optimize(problem)
if modes.inference is PolicyMode.ACTIVE:
    final_translation = optimization.translation
elif modes.inference is PolicyMode.OBSERVE:
    final_translation = legacy_final_translation
else:
    optimization = None
```

`TranslationOutcome` 增加 `optimization_decision_id` 和
`optimization_selected_text`；数据库提交只在 active 模式把选中候选作为正文。

- [ ] **步骤 6：运行定向与全量回归**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_working_targets.py tests/test_term_validator.py `
  tests/test_semantic_alignment.py tests/test_realization_optimizer.py `
  tests/test_parallel_v4.py tests/test_narrative_pipeline.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests --ignore=tests/test_foila_logic.py -q
```

预期：全部 PASS；observe 模式活动译文与 schema 9 基线逐字相同。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/target_resolver.py src/core/v4/context.py `
  src/core/translator.py src/core/v4/pipeline.py src/core/v4/models.py `
  tests/test_working_targets.py tests/test_parallel_v4.py `
  tests/test_realization_optimizer.py
git commit -m "feat: integrate generic realization inference"
```

## 任务 8：阶段 A 验收和 active 切换

**文件：**
- 修改：`tests/test_semantic_alignment.py`
- 修改：`tests/test_realization_optimizer.py`
- 修改：`tests/test_v4_storage_scale.py`
- 修改：`docs/superpowers/plans/2026-07-16-schema10-factor-foundation.md`

- [ ] **步骤 1：增加真实案例回归**

测试夹具至少覆盖：

```python
CASES = (
    ("I am a torturer.", "我是个拷问官。"),
    ("reared among the torturers", "在拷问官行会中长大"),
    ("Torturer, I ask you", "拷问官，我请求你"),
    ("no carnifex, executioner, or headsman", "并非行刑官、刽子手或斩首者"),
)
```

断言通用关系残差能区分自称、群体、呼语和对照词；测试代码不得根据
`torturer` 字符串选择处理路径。

- [ ] **步骤 2：增加 schema 10 存储规模测试**

生成 100,000 个 occurrence feature、每个 occurrence 最多两个 interpretation、
两个 realization 和四个 factor。断言：

```python
assert active_database_bytes <= source_bytes * configured_ratio
assert query_plan_uses_index("idx_semantic_interpretations_active")
assert query_plan_uses_index("idx_realization_candidates_active")
```

大段模型响应只进入压缩审计归档。

- [ ] **步骤 3：运行阶段 A 完整验证**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_v4_schema10_migration.py tests/test_risk_store.py `
  tests/test_factor_graph.py tests/test_semantic_alignment.py `
  tests/test_realization_optimizer.py tests/test_v4_storage_scale.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests --ignore=tests/test_foila_logic.py -q

& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m compileall src main.py
git diff --check
```

预期：测试零失败，compileall 成功，`git diff --check` 无输出。

- [ ] **步骤 4：切换阶段 A 默认模式**

只有在 observe 结果满足以下条件时，把 `OptimizationModes.inference` 默认值从
`OBSERVE` 改为 `ACTIVE`：

```text
硬约束漏检数 = 0
活动译文缺块数 = 0
未来信息泄露数 = 0
定向案例通用处理率 = 100%
全量测试失败数 = 0
```

未满足时保持 `OBSERVE`，记录差异，不以调高风险阈值通过验收。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/v4/risk_models.py tests/test_semantic_alignment.py `
  tests/test_realization_optimizer.py tests/test_v4_storage_scale.py `
  docs/superpowers/plans/2026-07-16-schema10-factor-foundation.md
git commit -m "test: verify schema 10 inference foundation"
```
