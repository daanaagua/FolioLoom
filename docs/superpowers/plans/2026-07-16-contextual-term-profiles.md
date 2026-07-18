# 语境化术语档案实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让反复职业/身份普通名词进入术语知识库，并以核心译名、语境变体、对照词和译后核验共同约束正式翻译。

**架构：** 扩充候选裁决类型和提示词；在 schema 9 数据库中以内联扩展表保存术语档案；将档案加入冻结渲染快照和翻译术语说明；在翻译提交前运行本地一致性核验并生成非阻断警告。

**技术栈：** Python 3、Pydantic、SQLite、pytest。

---

## 文件结构

- 修改 `src/core/v4/models.py`：扩充裁决和工作译名响应模型。
- 修改 `src/core/v4/adjudicator.py`：允许反复职业/身份普通名词。
- 修改 `src/core/v4/target_resolver.py`：生成语义边界与对照词。
- 修改 `src/core/v4/database.py`：持久化、冻结并读取术语档案，挑选高信息语境并吸收安全职业复数。
- 修改 `src/core/v4/context.py`：渲染档案约束。
- 修改 `src/core/v4/pipeline.py`：术语说明注入和译后核验接入。
- 创建 `src/core/v4/term_validator.py`：纯本地译后术语检查。
- 修改 `tests/test_candidate_adjudicator.py`：覆盖 role 协议与提示词。
- 修改 `tests/test_working_targets.py`：覆盖档案写入、幂等、快照和提示词。
- 创建 `tests/test_term_validator.py`：覆盖缺失目标与对照冲突。

### 任务 1：候选裁决支持 recurring role

- [x] **步骤 1：编写失败测试**

在 `tests/test_candidate_adjudicator.py` 中断言 `entity_kind="role"` 可以通过严格模型，并断言系统提示词明确普通职业名词在需要全书协调时不得仅因 `common noun` 被拒绝。

- [x] **步骤 2：运行测试验证失败**

运行：

```powershell
pytest tests/test_candidate_adjudicator.py -q
```

预期：`role` 模型校验失败或提示词断言失败。

- [x] **步骤 3：最少实现**

在 `models.py` 的 `AdjudicationDecision.entity_kind` 增加 `role`；更新 `ADJUDICATION_PROTOCOL` 与 `ADJUDICATION_SYSTEM`，区分 translation-sensitive recurring roles 与普通无约束名词。

- [x] **步骤 4：运行测试验证通过**

```powershell
pytest tests/test_candidate_adjudicator.py -q
```

### 任务 2：持久化并注入术语档案

- [x] **步骤 1：编写失败测试**

在 `tests/test_working_targets.py` 中增加：

```python
def test_working_target_profile_is_atomic_idempotent_and_rendered(tmp_path):
    ...
    decision = {
        "subject_type": "lexeme",
        "subject_id": lexeme_id,
        "target": "拷问者",
        "semantic_core": "行会职业身份；不自动等同于处刑者。",
        "contrast_sources": ["executioner", "headsman", "carnifex"],
        "rules": [
            {
                "condition": {"discourse_function": "vocative"},
                "target": "拷问官",
            }
        ],
    }
    ...
```

断言：

- `term_profiles` 存在并保存规范化 JSON；
- 重复提交不产生新知识版本；
- `render_snapshot()` 包含 `term_profile`；
- `ContextBuilder` 和翻译 glossary 说明包含语义边界及对照词。

- [x] **步骤 2：运行测试验证失败**

```powershell
pytest tests/test_working_targets.py -q
```

- [x] **步骤 3：最少实现**

扩充 `WorkingTargetDecision`：

```python
semantic_core: str = Field(min_length=1, max_length=600)
contrast_sources: List[str] = Field(default_factory=list, max_length=12)
```

在数据库初始化脚本中创建：

```sql
CREATE TABLE IF NOT EXISTS term_profiles (
    subject_type TEXT NOT NULL CHECK(subject_type IN ('lexeme','concept')),
    subject_id TEXT NOT NULL,
    semantic_core TEXT NOT NULL DEFAULT '',
    contrast_sources_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'provisional',
    locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
    created_version INTEGER NOT NULL REFERENCES knowledge_versions(id),
    retired_version INTEGER REFERENCES knowledge_versions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY(subject_type, subject_id, created_version)
);
```

`apply_working_target_decisions()` 在同一事务中退休旧档案并写入新档案。状态比较包含档案字段，从而保持幂等并触发正确的知识变更。

`_render_snapshot_from_connection()` 将档案附着到 lexeme/concept；`ContextBuilder` 与 `_glossary_for()` 渲染语义边界和对照词。

- [x] **步骤 4：运行测试验证通过**

```powershell
pytest tests/test_working_targets.py -q
```

### 任务 3：译后术语一致性核验

- [x] **步骤 1：编写失败测试**

创建 `tests/test_term_validator.py`，覆盖：

```python
def test_warns_when_translation_uses_no_allowed_target():
    warnings = TermConsistencyValidator.validate(
        source_text="I am a torturer.",
        final_translation="我是个刽子手。",
        matches=[... rendered_target="拷问者" ...],
        render_index=index_with_vocative_variant,
    )
    assert warnings[0]["kind"] == "term_target_missing"
```

以及两个互为对照的术语被配置为同一中文目标时产生 `term_contrast_target_collision`。

- [x] **步骤 2：运行测试验证失败**

```powershell
pytest tests/test_term_validator.py -q
```

- [x] **步骤 3：最少实现**

创建 `term_validator.py`，只使用冻结快照、命中记录和最终译文做确定性检查。在 `pipeline.py` 中把警告并入 `quality_warnings`；存在术语警告且原状态为 `completed` 时改为 `completed_with_warnings`。

- [x] **步骤 4：运行定向测试**

```powershell
pytest tests/test_term_validator.py tests/test_working_targets.py tests/test_candidate_adjudicator.py -q
```

### 任务 4：回归验证与《新日之书》试跑

- [x] **步骤 1：运行 V4 核心测试**

```powershell
pytest tests/test_candidate_adjudicator.py tests/test_working_targets.py tests/test_v4_matcher_targets.py tests/test_narrative_pipeline.py tests/test_term_validator.py -q
```

- [x] **步骤 2：运行全量测试**

```powershell
$tests = Get-ChildItem tests -Filter 'test_*.py' |
  Where-Object { $_.Name -ne 'test_foila_logic.py' } |
  ForEach-Object { $_.FullName }
python -m pytest @tests -q
```

- [x] **步骤 3：重建独立试验项目**

使用独立项目 `projects/new_sun_term_profile_trial`。扫描前七块，并定向补扫包含
`no carnifex / executioner / headsman` 的后文块；导入旧译 DOCX 作为非权威措辞证据。

- [x] **步骤 4：检查试跑证据**

查询 SQLite 并确认：

- `torturer` 被提升为 `role`，观察到的 `torturers` 安全并入同一 lexeme；
- 档案明确区别 `carnifex / executioner / headsman`；
- 无旧译证据时 Flash 暴露“拷刑者”的中文措辞弱点；
- 导入旧译后目标解析选择“拷问官”；
- 强制重翻自称块得到“我是个拷问官……我是拷问官的学徒”，且无术语警告。
