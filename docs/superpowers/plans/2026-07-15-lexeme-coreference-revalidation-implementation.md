# 词形共指与精确重验实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 parallel_v4 升级到 schema 8，使同一英文词形拥有稳定的全局译名、故事指称通过独立共指阶段收束，并让知识变化只重验真正受影响且已有活动译文的文本块；在模型冲突、协议失败或外部服务失败时仍以可审计警告终态无人值守完成。

**架构：** SQLite 继续是唯一事实源和协调器唯一写入面。`lexemes` 管理词形与默认译法，`concepts` 管理故事指称，`coreference.py` 只在同一 lexeme 内执行确定性或双模型判断；`knowledge_changes`、精确依赖和 `form_occurrences` 计算影响，`revalidation.py` 执行验证、完整块修复、整块重翻和警告兜底；翻译管线以最多三个知识纪元批量应用 staging 建议，不再比较全局知识签名。schema 7 到 8 只能通过预览、确认令牌和备份迁移，普通命令不得静默升级活动数据库。

**技术栈：** Python 3、SQLite、Pydantic v2、`concurrent.futures`、现有 `LLMManager`/`TranslationEngine`、pytest/unittest、zstd 审计归档。

---

## 实施边界

三个设计阶段共享同一数据库迁移和状态机，后两阶段依赖前一阶段产生的 lexeme、occurrence 与 render fingerprint，因此使用一份按阶段设检查点的串行计划，不拆成可独立部署的多个计划。任何真实项目演练只能使用数据库副本；最后一个任务验收前不得修改 `projects/new_sun_omnibus/artifacts/parallel_v4/book.db`。

## 文件职责

### 新建文件

- `src/core/v4/schema_v8.py`：schema 8 建表、旧 schema 探测、迁移预览令牌、备份和原子升级。
- `src/core/v4/coreference.py`：冻结共指案件、确定性规则、双模型投票、缓存和协调器。
- `src/core/v4/revalidation.py`：影响任务规划、双验证、完整块修复、整块重翻和警告兜底。
- `src/core/v4/knowledge_epochs.py`：staging 检查点、知识纪元上限和收敛摘要。
- `tests/test_v4_schema8_migration.py`：全新 schema、schema 7 预览/确认/回滚/幂等迁移。
- `tests/test_lexeme_coreference.py`：词形、类型观察、确定性与双模型共指、redirect 和渲染回归。
- `tests/test_precise_revalidation.py`：变化指纹、任务合并、验证/修复/重翻/警告状态机。
- `tests/test_v4_knowledge_epochs.py`：纪元屏障、无人值守终态、断点恢复和全局签名移除。

### 修改文件

- `src/core/v4/database.py`：schema 入口、lexeme/coreference/revalidation 持久化 API、精确快照和状态摘要。
- `src/core/v4/models.py`：共指、依赖、验证、重验和配置数据契约。
- `src/core/v4/adjudicator.py`：裁决只确认 lexeme 与类型证据，不直接制造 concept。
- `src/core/v4/target_resolver.py`：为 lexeme 解析默认译名，只在有证据时写 concept 覆盖。
- `src/core/v4/matcher.py`：同时匹配 lexeme/concept/rule 并返回精确 span 与渲染指纹。
- `src/core/v4/pipeline.py`：块级差分提交、知识纪元检查点和自动重验调度。
- `src/core/v4/migration.py`：串行项目导入适配 schema 8，并把数据库构造延迟到显式 schema 检查之后。
- `src/core/v4/validation.py`：把 `warning_stale` 写入质量报告，严格模式可拒绝。
- `src/core/v4/exporter.py`：普通自动导出允许警告旧稿，严格导出保持可选。
- `src/core/v4/web_review.py`：显示共指未决和重验警告，但不把人工队列当作运行阻塞条件。
- `src/core/v4/__init__.py`：导出新增服务。
- `main.py`：迁移预览/确认、`coreference-v4`、`revalidate-v4`、prepare 顺序和状态摘要。
- `config/config.example.yaml`：`auto/interactive`、`pause_on_review`、失败策略和纪元上限。
- `tests/test_candidate_adjudicator.py`、`tests/test_scan_adjudication_split.py`：新裁决输出与审计回归。
- `tests/test_working_targets.py`：lexeme/concept 渲染优先级和精确失效回归。
- `tests/test_parallel_v4.py`、`tests/test_parallel_v4_v2.py`：CLI、管线、修复、导出和兼容回归。
- `tests/test_v4_matcher_targets.py`：多层渲染与 span/fingerprint 匹配。
- `tests/test_v4_storage_scale.py`：三百万词本地规模与存储预算。

## 阶段一：词形与共指基础层

### 任务 1：建立 schema 8 升级边界和空库结构

**文件：**
- 新建：`src/core/v4/schema_v8.py`
- 修改：`src/core/v4/database.py`
- 新建：`tests/test_v4_schema8_migration.py`
- 修改：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：编写旧库拒绝静默升级的失败测试**

在 `tests/test_v4_schema8_migration.py` 构造只含 `schema_meta.schema_version=7` 的数据库，验证：

```python
def test_schema7_requires_explicit_preview_and_confirm(tmp_path):
    path = seed_schema7_database(tmp_path)
    with pytest.raises(SchemaUpgradeRequired, match="migrate-v4 --preview"):
        V4Database(tmp_path)
    assert read_schema_version(path) == 7
```

同时增加空目录测试，要求 `V4Database(tmp_path)` 直接创建 schema 8。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_v4_schema8_migration.py -q`

预期：FAIL，`SchemaUpgradeRequired` 和 schema 8 表尚不存在。

- [ ] **步骤 3：实现版本探测和 schema 8 DDL**

在 `schema_v8.py` 提供且只提供以下入口：

```python
SCHEMA_VERSION = 8

class SchemaUpgradeRequired(RuntimeError): ...

def inspect_schema(path: Path) -> int | None: ...
def create_schema8(connection: sqlite3.Connection) -> None: ...
def assert_schema8_or_empty(path: Path) -> None: ...
```

DDL 一次建立批准设计中的 `lexemes`、`concept_lexemes`、`concept_type_observations`、`coreference_decisions`、`concept_redirects`、`form_occurrences`、`knowledge_changes`、`revalidation_tasks`，并重建 `source_forms`、`mentions`、`rendering_rules`、`candidate_resolutions`、`translation_versions`、`dependencies` 所需字段与约束。加入：

```sql
CREATE UNIQUE INDEX uq_active_lexeme
ON lexemes(language, normalized_form) WHERE retired_version IS NULL;

CREATE UNIQUE INDEX uq_active_concept_lexeme_role
ON concept_lexemes(concept_id, lexeme_id, role)
WHERE retired_version IS NULL;

CHECK ((lexeme_id IS NULL) != (concept_id IS NULL))
```

`revalidation_tasks.status` 和 `translation_versions.validation_status` 用 CHECK 限定为设计批准的枚举值。

- [ ] **步骤 4：让数据库只自动创建空库，不自动升级旧库**

`V4Database.__init__()` 在创建目录后先调用 `assert_schema8_or_empty()`；空库走 `create_schema8()`，schema 7 抛出 `SchemaUpgradeRequired`，schema 8 正常连接。删除 `database.py` 中 `SCHEMA_VERSION = 7` 的本地常量，统一从 `schema_v8.py` 导入。

- [ ] **步骤 5：验证结构、约束和存储预算**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_v4_schema8_migration.py tests/test_v4_storage_scale.py -q
.\.venv\Scripts\python.exe -m compileall -q src main.py
```

预期：PASS；空库 `schema_version=8`、`PRAGMA integrity_check='ok'`、`foreign_key_check` 为 0，非法双空/双非空 rendering rule 被 CHECK 拒绝。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/schema_v8.py src/core/v4/database.py tests/test_v4_schema8_migration.py tests/test_v4_storage_scale.py
git commit -m "feat: establish explicit schema 8 boundary"
```

### 任务 2：实现 lexeme、表面词形、类型观察和 occurrence 持久化

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/models.py`
- 新建：`tests/test_lexeme_coreference.py`

- [ ] **步骤 1：编写稳定 lexeme 和精确偏移失败测试**

测试覆盖大小写复用、类型变化不分裂、重复写入幂等以及坏偏移整批回滚：

```python
first = database.ensure_lexeme("Briah", language="en")
second = database.ensure_lexeme("BRIAH", language="en")
assert first == second
database.record_type_observation(first, "place", confidence=.8)
database.record_type_observation(first, "concept", confidence=.7)
assert scalar(database, "SELECT COUNT(*) FROM lexemes") == 1
```

另用 `source_text[start:end] != source_form` 验证 `record_form_occurrences()` 抛错且不留下部分行。

- [ ] **步骤 2：运行单测并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -q`

预期：FAIL，数据库尚无 lexeme API。

- [ ] **步骤 3：增加不可变数据契约**

在 `models.py` 增加 `LexemeRef`、`TypeObservation` 和 `FormOccurrence` dataclass；offset 使用半开区间 `[start_offset, end_offset)`，`language` 当前固定传 `en`，标准化仍调用 `normalize_english_form()`。

- [ ] **步骤 4：实现单写者 API**

在 `V4Database` 增加：

```python
def ensure_lexeme(self, source_form: str, *, language: str = "en",
                  connection: sqlite3.Connection | None = None) -> str: ...
def record_type_observation(self, lexeme_id: str, kind: str, *,
                            confidence: float, source: str,
                            mention_id: int | None = None,
                            concept_id: str | None = None,
                            adjudication_id: str | None = None,
                            connection: sqlite3.Connection | None = None) -> int: ...
def record_form_occurrences(self, rows: Sequence[FormOccurrence], *,
                            connection: sqlite3.Connection | None = None) -> int: ...
```

lexeme ID 严格为 `stable_id("lexeme", f"{language}:{normalized_form}")`；`source_forms` 以 `lexeme_id + normalized_form + form` 幂等；occurrence 写入前从 `blocks` 读取源文并验证 hash、offset 和切片。

- [ ] **步骤 5：验证同词形和偏移不变量**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py tests/test_v4_matcher_targets.py -q`

预期：PASS；同一活动源版本中相同 span 不会产生第二条 occurrence。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py src/core/v4/models.py tests/test_lexeme_coreference.py
git commit -m "feat: persist stable lexemes and exact occurrences"
```

### 任务 3：把候选裁决改为 lexeme/type evidence 提交

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/adjudicator.py`
- 修改：`tests/test_candidate_adjudicator.py`
- 修改：`tests/test_scan_adjudication_split.py`
- 修改：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：把旧“类型不同建两个 concept”测试改成失败回归**

将 `test_promotion_keeps_entity_kinds_distinct...` 改为：两个相同 normalized form、不同 `entity_kind` 的 promote 结果必须共享一个 lexeme，生成两条类型观察，`candidate_resolutions.concept_id IS NULL`，裁决阶段概念数不增加。保留“人工锁定不被覆盖”的独立断言。

- [ ] **步骤 2：运行裁决测试并确认旧行为失败**

运行：

`.\.venv\Scripts\python.exe -m pytest tests/test_v4_storage_scale.py::test_type_disagreement_records_observations_without_creating_concepts tests/test_scan_adjudication_split.py -q`

预期：FAIL，现有 `_ensure_automatic_concept()` 仍按类型创建概念。

- [ ] **步骤 3：移除裁决阶段的概念分配**

删除 `_active_concept_for_form()` 和 `_ensure_automatic_concept()` 在 `commit_adjudications()` 中的调用。每个被选中的候选在同一事务内执行：ensure lexeme、写 source form、写 mention/occurrence、写类型观察、把 `candidate_resolutions.lexeme_id` 设为该 lexeme，保持 `concept_id=NULL`。

`split` 对每个 selected candidate 独立执行上述流程；上下文成员仍不得变成 resolution。

- [ ] **步骤 4：保持重跑、租约和审计原子性**

更新 `_active_adjudication_matches()`，比较 `lexeme_id`、decision、evidence 和 payload，而不是要求 concept ID。完全相同 payload 不创建新知识版本；中途 SQL 失败时审计归档、lexeme、mention、resolution 和 type observation 全部回滚。

- [ ] **步骤 5：运行裁决全回归**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py tests/test_scan_adjudication_split.py tests/test_v4_storage_scale.py -q
```

预期：PASS；`Drotte and Roche` 不被创建为一个人物概念，`Corpse` 不吞并 `Corpse Door`，`Night` 证据不足时仍可 defer。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py src/core/v4/adjudicator.py tests/test_candidate_adjudicator.py tests/test_scan_adjudication_split.py tests/test_v4_storage_scale.py
git commit -m "refactor: separate candidate adjudication from identity"
```

### 任务 4：定义冻结共指案件和双模型协议

**文件：**
- 新建：`src/core/v4/coreference.py`
- 修改：`src/core/v4/models.py`
- 修改：`tests/test_lexeme_coreference.py`

- [ ] **步骤 1：编写严格协议失败测试**

在模型层定义：

```python
class CoreferenceVote(StrictModel):
    case_id: str = Field(pattern=r"^R\d{3}$")
    relation: Literal["same", "different", "uncertain", "non_entity"]
    mention_ids: list[str] = Field(min_length=1, max_length=8)
    confidence: float = Field(ge=0, le=1)
    rationale: str = Field(max_length=300)
```

测试拒绝未知 case、遗漏 mention、额外字段和输入外 mention ID；两个客户端必须收到字节等价的冻结 payload。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -k "protocol or frozen" -q`

预期：FAIL，共指契约与协调器尚不存在。

- [ ] **步骤 3：实现有界案件生成**

`CoreferenceCoordinator.freeze_cases()` 只查询同一 lexeme 下需要判断的 mention/concept anchor；每组最多选择最早、最近、类型冲突和共现差异最大的共 8 条语境。短 ID 只存在请求中；payload 保存稳定 mention ID、evidence ID、source hash 和当前知识版本。

- [ ] **步骤 4：实现 payload hash 缓存键**

左右 anchor 稳定排序；`mention_set_id = stable_id("mention-set", ":".join(sorted(mention_ids)))`；缓存键包含 payload、两个模型名、协议版本，不包含运行 ID 或时间。模型审计继续通过现有 `record_audit_call()` 写压缩归档。

- [ ] **步骤 5：验证协议测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -k "protocol or frozen or bounded" -q`

预期：PASS；高频 lexeme 的模型请求也不超过 8 个 mention 语境。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/coreference.py src/core/v4/models.py tests/test_lexeme_coreference.py
git commit -m "feat: define frozen coreference cases"
```

### 任务 5：实现确定性共指与概念锚点

**文件：**
- 修改：`src/core/v4/coreference.py`
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_lexeme_coreference.py`

- [ ] **步骤 1：编写六类确定性规则测试**

分别测试：相同 span、相同证据 hash 重跑、唯一人工锁定 concept、标题指纹、相同锚点/重复子集、已有 redirect。另加反例：仅同名但不同人物锚点的两个 John 不得自动 same。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -k deterministic -q`

预期：FAIL，mention 尚未绑定稳定 concept。

- [ ] **步骤 3：实现锚点和概念创建 API**

在 `V4Database` 增加：

```python
def ensure_concept_for_anchor(self, lexeme_id: str, anchor_mention_id: int,
                              *, kind: str = "concept",
                              connection: sqlite3.Connection | None = None) -> str: ...
def bind_mentions(self, concept_id: str, mention_ids: Sequence[int], *,
                  connection: sqlite3.Connection | None = None) -> int: ...
```

ID 固定为 `stable_id("concept", f"{lexeme_id}:{anchor_mention_id}")`；`anchor_mention_id` 一旦写入不得更新；创建同时写活动 `concept_lexemes(role='primary')`。

- [ ] **步骤 4：实现按优先级短路的确定性判断**

`_deterministic_relation(case)` 返回 `same/different/non_entity/None` 和命中规则名。只对同一 lexeme 案件运行；不同人物 anchor 时返回 `None` 而不是 `same`。确定性结论写 `coreference_decisions(decision_source='deterministic')` 和无模型审计事件。

- [ ] **步骤 5：验证幂等和人工锁**

同一案件重跑不增加 decision、concept 或 mention 绑定；人工 locked different 的案件不会被确定性 same 覆盖。

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -k deterministic -q`

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/coreference.py src/core/v4/database.py tests/test_lexeme_coreference.py
git commit -m "feat: resolve deterministic coreference anchors"
```

### 任务 6：实现双模型共指、冲突兜底和非阻塞终态

**文件：**
- 修改：`src/core/v4/coreference.py`
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_lexeme_coreference.py`

- [ ] **步骤 1：编写四种投票矩阵和协议失败测试**

覆盖：same+same 合并、different+different 分离、non_entity+non_entity 不建 concept、冲突/任一 uncertain 写 uncertain；一侧或两侧协议连续失败两次时写 `uncertain` 和 `model_protocol_failure`，运行结果不得含 blocking human item。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -k dual_model -q`

预期：FAIL，协调器没有模型路径。

- [ ] **步骤 3：实现独立客户端和有限重试**

构造器使用 `llm_factory_a`、`llm_factory_b`，每个案件两个客户端读取同一 frozen payload；每侧最多 `max_attempts` 次。严禁把第一侧结论写进第二侧 prompt。

- [ ] **步骤 4：实现合并矩阵和默认译名兜底**

冲突/不确定时保留 lexeme-only mention，或保留已经由不同 anchor 建立的 concept 并写活动 uncertain decision；共同中文默认译名从 lexeme 读取。多个旧译名的固定选择顺序为 locked、verified、已有一致值、受影响块多数票、Unicode 字典序，选择理由进入 `votes_json`。

- [ ] **步骤 5：验证审计、缓存和无人值守完成**

相同 payload 重跑复用 decision，不再调用 fake LLM；`run()` 摘要精确返回 deterministic merges、model merges、different、uncertain、protocol failures 和 fallbacks。

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -q`

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/coreference.py src/core/v4/database.py tests/test_lexeme_coreference.py
git commit -m "feat: resolve coreference with dual model fallback"
```

### 任务 7：实现概念 redirect 和原子归并

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/coreference.py`
- 修改：`tests/test_lexeme_coreference.py`
- 修改：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：编写完整归并与冲突规则测试**

为左右 concept 分别种入 mentions、resolutions、type observations、concept_lexemes、dependencies 和 rendering rules。断言完全相同规则去重，冲突规则进入未决候选而非覆盖，旧 ID 经 redirect 找到 canonical，旧审计仍可读。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py -k redirect -q`

预期：FAIL，当前 `merge_concept_forms()` 不满足 schema 8 归并契约。

- [ ] **步骤 3：实现 canonical 排序和 redirect 解析**

canonical 排序键依次使用 locked、verified、非空有效译名、依赖+mention 数、created_at、ID。增加：

```python
def resolve_concept_id(self, concept_id: str, *, connection=None) -> str: ...
def merge_concepts(self, concept_ids: Sequence[str], *, reason: str,
                   decision_id: str, connection=None) -> dict[str, Any]: ...
```

redirect 解析检测环并限制深度；归并时把所有旧依赖转到 canonical 后去重。

- [ ] **步骤 4：实现规则冲突的显式保留**

完全同一 condition/target/priority 的规则只保留一条活动规则；相同 condition 不同 target 时，两条规则均退休并写入 `human_queue(kind='render_rule_conflict', severity='warning')` 或专用未决 payload，且不阻塞自动流程。

- [ ] **步骤 5：验证事务回滚和存储预算**

在转移 dependencies 后注入异常，断言 redirect、retirement、全部关联和 audit frame 都回滚。

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_lexeme_coreference.py tests/test_v4_storage_scale.py -q`

预期：PASS，foreign key check 为 0。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py src/core/v4/coreference.py tests/test_lexeme_coreference.py tests/test_v4_storage_scale.py
git commit -m "feat: merge concepts through auditable redirects"
```

### 任务 8：实现 lexeme/concept 双层译名与匹配快照

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/matcher.py`
- 修改：`src/core/v4/target_resolver.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`tests/test_working_targets.py`
- 修改：`tests/test_v4_matcher_targets.py`

- [ ] **步骤 1：编写六层渲染优先级失败测试**

同一 lexeme `archon` 设置工作译名“执政官”，在 vocative mention 上设置 occurrence 规则“阁下”，再为可靠 concept 设置覆盖；断言优先级严格为 occurrence/speaker/thread、verified concept、verified lexeme、working concept、working lexeme、普通模型处理。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_working_targets.py tests/test_v4_matcher_targets.py -q`

预期：FAIL，现有 snapshot 只读取 concept/source_forms。

- [ ] **步骤 3：重写 render snapshot 而非全局 concept snapshot**

`V4Database.render_snapshot()` 返回 lexeme、关联 concept、有效 target、规则和 redirect 后 ID；`FrozenConceptIndex` 改名为向后兼容别名，实际编译 `FrozenRenderIndex`。每条匹配返回：

```python
MatchedRendering(
    lexeme_id=...,
    concept_id=...,
    matched_form=...,
    start_offset=...,
    end_offset=...,
    rendered_target=...,
    applied_rule_ids=(...),
    dependency_fingerprint=...,
)
```

- [ ] **步骤 4：把工作译名解析主体改为 lexeme**

`working_target_candidates()` 和 `TargetResolver` 默认批量处理 lexeme；仅当可靠 different/义项证据存在时生成 concept override 决策。兼容旧测试中 concept ID 的调用入口，但新写入落到对应 primary lexeme，除非 payload 显式 `subject_type='concept'`。

- [ ] **步骤 5：验证 Severian 全局译名和 archon 语境变化**

测试同一 lexeme 后续所有块默认获得一个“塞万里安”，称呼语境仍可渲染“阁下”；共指 uncertain 不导致译名空缺。

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_working_targets.py tests/test_v4_matcher_targets.py tests/test_parallel_v4.py -q`

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py src/core/v4/matcher.py src/core/v4/target_resolver.py src/core/v4/pipeline.py tests/test_working_targets.py tests/test_v4_matcher_targets.py tests/test_parallel_v4.py
git commit -m "feat: render lexeme and concept knowledge by precedence"
```

## 阶段二：精确重验层

### 任务 9：记录有效知识变化和精确翻译依赖

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/models.py`
- 修改：`src/core/v4/pipeline.py`
- 新建：`tests/test_precise_revalidation.py`
- 修改：`tests/test_working_targets.py`

- [ ] **步骤 1：编写 render fingerprint 与依赖失败测试**

测试类型、描述、证据数量变化生成 impact 0 且不创建任务；默认译名变化生成 impact 1；条件规则/merge/split 生成 impact 2；人工锁和高影响 constraint 生成 impact 3。重复同值写入不得产生知识版本或 change。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py -k fingerprint -q`

预期：FAIL，尚无 knowledge change API。

- [ ] **步骤 3：实现规范化渲染指纹**

增加 `render_fingerprint(subject_type, subject_id, state)`，只序列化进入 prompt/匹配的 target、condition、priority、lock、effective subject link；description、kind observation 和 evidence count 不进入。所有 target/规则/merge/lock 提交在同一事务写 `knowledge_changes`。

- [ ] **步骤 4：提交完整 dependency 记录**

`TranslationOutcome` 增加 `matched_renderings`；`commit_translation_batch()` 为实际匹配写 lexeme、concept、rule、claim 依赖及 `dependency_fingerprint/matched_form/occurrence_count/rendered_target/applied_rule_ids_json/source_spans_json`。span JSON 只保存 offset 数字；写入前验证 block source hash。

- [ ] **步骤 5：验证现有翻译提交回归**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py tests/test_working_targets.py tests/test_parallel_v4.py -q
```

预期：PASS；一个块多次出现同 lexeme 时是一条 dependency、正确 occurrence_count 和有界 spans。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py src/core/v4/models.py src/core/v4/pipeline.py tests/test_precise_revalidation.py tests/test_working_targets.py
git commit -m "feat: persist render changes and exact dependencies"
```

### 任务 10：用 occurrence 和反向依赖创建、合并重验任务

**文件：**
- 新建：`src/core/v4/revalidation.py`
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_precise_revalidation.py`
- 修改：`tests/test_working_targets.py`

- [ ] **步骤 1：编写硬条件和当前 36 块问题的失败测试**

创建 ready 未翻译块、completed 无活动译文块、serial_v3 译文块和 completed 活动 parallel_v4 译文块。同一 target change 只能为最后一种创建任务；前三种任务数为 0，block status 不改成 `needs_revalidate`。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py -k task_planning -q`

预期：FAIL，现有 `_invalidate_working_target_dependents()` 会误标 ready 块。

- [ ] **步骤 3：删除全书逐概念正则失效路径**

移除 `_invalidate_working_target_dependents()` 中的 Python `re` 全书扫描及所有写 `blocks.status='needs_revalidate'` 的调用。新增 `RevalidationPlanner.plan(change_ids)`，只使用：

```sql
dependencies -> active completed parallel_v4 translation
form_occurrences -> block -> active completed parallel_v4 translation
```

并在新旧 effective render fingerprint 相同或 impact 0 时跳过。

- [ ] **步骤 4：实现任务幂等和同译文合并**

`change_set_hash` 由排序后的 change ID 与最终 `to_knowledge_version` 生成。执行前如果同 translation 已有 pending task，则合并 change IDs、取最大 impact、提升目标版本并保持一个 pending 行；重复规划不改变 attempts。

- [ ] **步骤 5：验证 derived status**

`status_summary()` 从 pending/validating task 派生 `needs_revalidate` 数，不再依赖 `blocks.status`。`V4BlockStatus.NEEDS_REVALIDATE` 仅保留读取旧库迁移兼容，不再进入新管线候选状态。

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py tests/test_working_targets.py -q`

预期：PASS；未翻译 ready 块始终为 ready。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/revalidation.py src/core/v4/database.py tests/test_precise_revalidation.py tests/test_working_targets.py
git commit -m "feat: plan precise revalidation tasks"
```

### 任务 11：实现定向验证、双模型升级和完整块修复

**文件：**
- 修改：`src/core/v4/models.py`
- 修改：`src/core/v4/revalidation.py`
- 修改：`src/core/v4/repairer.py`
- 修改：`tests/test_precise_revalidation.py`
- 修改：`tests/test_parallel_v4_v2.py`

- [ ] **步骤 1：编写验证矩阵失败测试**

定义严格输出 `no_effect/patch_required/retranslate/uncertain`。测试 impact 1 单次定向验证；impact 2 双独立验证；两个 no_effect 关闭任务；两个 patch 调一次 repair；冲突、uncertain、协议失败全部升级 full retranslate。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py -k validation_matrix -q`

预期：FAIL，revalidation runner 尚不存在。

- [ ] **步骤 3：实现最小而完整的验证 prompt**

请求只包含 block 原文、活动译文、旧/新规则、精确 span、rendered target 和 change reason；两个 impact 2 客户端不共享结论。协议错误最多重试配置次数，之后返回升级动作而非人工阻塞。

- [ ] **步骤 4：让 patch 只接受完整块**

`V4Repairer` 增加 `repair_full_block(...) -> TranslationOutcome`，模型必须返回与块段落结构一致的完整译文；禁止 `str.replace()`。新版本通过现有 `_translation_shape_problems()`、段落数和术语命中校验后才把旧版本设为 inactive。

- [ ] **步骤 5：实现重验提交状态机**

数据库提供 claim/commit/fail API，以 compare-and-set 从 pending 到 validating；结果只允许 `resolved_noop/resolved_patch/resolved_retranslate/completed_with_warning`。中断时 validating 租约超时可回到 pending，已完成任务重跑不得再次调用模型。

- [ ] **步骤 6：运行修复和断点回归**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py tests/test_parallel_v4_v2.py -q
```

预期：PASS；patch 产生完整新 translation version，旧版本保留历史且只在成功后失活。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/models.py src/core/v4/revalidation.py src/core/v4/repairer.py tests/test_precise_revalidation.py tests/test_parallel_v4_v2.py
git commit -m "feat: validate and repair stale translations"
```

### 任务 12：实现整块重翻和外部失败警告兜底

**文件：**
- 修改：`src/core/v4/revalidation.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`tests/test_precise_revalidation.py`

- [ ] **步骤 1：编写旧译文保持活动的失败测试**

脚本化 fake LLM 依次模拟结构失败、超时、429、上下文上限和预算错误。每种在重试耗尽后都应：旧译文 active=1、新的不完整版本不存在、`validation_status='warning_stale'`、task=`completed_with_warning`、运行继续处理下一 task。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py -k warning_fallback -q`

预期：FAIL，当前失败路径可能直接修改 block/translation status。

- [ ] **步骤 3：复用正常两层翻译器完成整块重翻**

`RevalidationRunner` 通过管线提供的 `translate_block_factory` 使用当前稳定知识版本；仅在完整性校验通过的事务中切换 active version，并把 task 记为 `resolved_retranslate`。

- [ ] **步骤 4：实现固定无人值守失败策略**

错误归类为 protocol/structure/external/budget/context；前两类和可重试 external 按有限次数重试。耗尽后调用 `complete_with_warning()`，附上错误种类、attempts、最后 audit locator 和 stale change set。可选 warning 人工项 severity 只能为 warning，不得 blocking。

- [ ] **步骤 5：验证运行级摘要**

`run()` 只有任务仍为 pending/validating 才视为未完成；全部 resolved 或 completed_with_warning 时返回 `completed` 或 `completed_with_warnings`，并继续到队列尾。

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_precise_revalidation.py -q`

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/revalidation.py src/core/v4/database.py src/core/v4/pipeline.py tests/test_precise_revalidation.py
git commit -m "feat: finish revalidation with warning fallbacks"
```

## 阶段三：调度、迁移和产品入口

### 任务 13：用知识纪元替换全局签名失效

**文件：**
- 新建：`src/core/v4/knowledge_epochs.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`src/core/v4/database.py`
- 新建：`tests/test_v4_knowledge_epochs.py`
- 修改：`tests/test_working_targets.py`

- [ ] **步骤 1：把全局签名测试改成块级差分失败测试**

新增两块 A/B，仅 A 依赖 lexeme X。A 翻译期间修改无关 lexeme Y，A/B 均应正常提交且无 task；修改 X 时只为 A 创建 task，B 不受影响。删除“中途任何 target change 停止全 run”的旧预期。

- [ ] **步骤 2：运行测试并确认旧行为失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_v4_knowledge_epochs.py tests/test_working_targets.py -k "midrun or epoch" -q`

预期：FAIL，现有管线比较 `target_snapshot_signature` 并中断。

- [ ] **步骤 3：实现 staging 和检查点应用**

`KnowledgeEpochCoordinator` 提供：

```python
def freeze(self) -> KnowledgeEpoch: ...
def stage(self, run_id: str, outcomes: Sequence[TranslationOutcome]) -> int: ...
def checkpoint(self, run_id: str) -> EpochCheckpointResult: ...
```

每个工作波读取一个 frozen epoch；proposal 先 staging，卷边界或配置块数到达时批量 adjudicate/coreference/resolve/apply，然后由 planner 一次生成 tasks。重验产生的 proposal 只进入下一 epoch。

- [ ] **步骤 4：实现三纪元收敛上限**

`max_knowledge_epochs` 默认 3；达到上限后非锁定 proposal 保持 staging，写 quality report 计数，不再改变当前 run 的活动知识。重跑根据 run/epoch/payload hash 复用 checkpoint，不重复模型调用。

- [ ] **步骤 5：更新配置兼容性**

`V4PipelineConfig` 使用：

```python
decision_mode: Literal["auto", "interactive"] = "auto"
pause_on_review: bool = False
unattended_failure_policy: Literal["finish_with_warnings"] = "finish_with_warnings"
max_knowledge_epochs: int = 3
```

读取旧配置值 `unattended` 时规范化为 `auto`，但新 CLI/help/config 不再输出 `unattended`。只有 `interactive + pause_on_review=true` 才在检查点暂停；模型冲突不改变该开关。

- [ ] **步骤 6：删除全局失效写路径并验证**

`finish_translation_run_atomically()` 不再因全局 signature 变化批量失效本 run；保留快照结构合法性检查。删除 `invalidate_translation_run()` 的生产调用，改由 planner 定位块。

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_v4_knowledge_epochs.py tests/test_working_targets.py tests/test_parallel_v4.py -q
```

预期：PASS；达到纪元上限必然稳定结束。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/knowledge_epochs.py src/core/v4/pipeline.py src/core/v4/database.py tests/test_v4_knowledge_epochs.py tests/test_working_targets.py tests/test_parallel_v4.py
git commit -m "feat: coordinate bounded knowledge epochs"
```

### 任务 14：实现 schema 7 数据迁移预览、备份和原子升级

**文件：**
- 修改：`src/core/v4/schema_v8.py`
- 修改：`src/core/v4/migration.py`
- 修改：`tests/test_v4_schema8_migration.py`
- 修改：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：构造含碰撞和误标状态的 schema 7 fixture**

fixture 至少包含：Briah 两类型 concept、Malrubius/Triskele split、相同标题、两个旧译名冲突、活动/历史译文依赖、36 个无活动 V4 译文的 `needs_revalidate` 块、一个真实陈旧活动译文、人工 locked concept/rule/audit locator。

- [ ] **步骤 2：编写 preview 不写盘和 confirm token 测试**

`preview_schema8(path)` 必须返回 source path/hash、backup path、表行数、lexeme 冲突、target conflict、36 个状态修复数、真实 stale task 数和稳定 confirm token。preview 后数据库字节 hash 不变；错误/过期 token 不写盘。

- [ ] **步骤 3：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_v4_schema8_migration.py -q`

预期：FAIL，schema 8 migrator 尚无数据升级实现。

- [ ] **步骤 4：实现备份和单事务表重建**

确认绝对路径位于项目 `artifacts/parallel_v4` 后，使用 SQLite backup API 创建带 UTC 时间和源 hash 的 `.db` 副本。升级事务依次：创建新表、建立 lexeme、迁移 source forms/mentions/resolutions、迁移 target、写 type observations、创建 anchored concepts/associations、跑确定性 coreference、写 redirects、迁移 rules/dependencies、回填 occurrences、修复旧 block status、为真实 stale 活动译文建 task、更新 schema_meta。

任一步异常回滚原库；备份保留供诊断。

- [ ] **步骤 5：实现旧 target 冲突的固定兜底**

同 lexeme 多个旧译名按 locked、verified、一致值、活动依赖多数票、Unicode 字典序选 lexeme target；其余值写迁移冲突审计和 warning 人工项，不阻塞迁移。locked concept override 保留在 concept 层。

- [ ] **步骤 6：让串行导入原生写 schema 8**

`V4Migrator` 不在 `__init__()` 直接构造可能拒绝的数据库；先完成显式 schema 检查/升级，再延迟创建 `V4Database`。旧 glossary 词条导入 lexeme 和工作译名；只有人工锁或明确义项时创建 concept override。

- [ ] **步骤 7：验证幂等、回滚和 36 块修复**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_v4_schema8_migration.py tests/test_v4_storage_scale.py tests/test_parallel_v4.py -q
```

预期：PASS；36 块全部 ready、未生成 task；真实 stale 译文生成一个 task；第二次 confirm 只报告 already_schema8；锁和 audit 可读。

- [ ] **步骤 8：Commit**

```powershell
git add src/core/v4/schema_v8.py src/core/v4/migration.py tests/test_v4_schema8_migration.py tests/test_v4_storage_scale.py tests/test_parallel_v4.py
git commit -m "feat: migrate schema 7 data safely to schema 8"
```

### 任务 15：接入 CLI、prepare 顺序、状态、UI 和导出报告

**文件：**
- 修改：`main.py`
- 修改：`src/core/v4/__init__.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/validation.py`
- 修改：`src/core/v4/exporter.py`
- 修改：`src/core/v4/web_review.py`
- 修改：`config/config.example.yaml`
- 修改：`tests/test_parallel_v4.py`
- 修改：`tests/test_parallel_v4_v2.py`

- [ ] **步骤 1：编写 CLI 和产品输出失败测试**

测试：`migrate-v4 BOOK --preview`、`--confirm TOKEN`；`coreference-v4` 和 `revalidate-v4` 参数转发；prepare 顺序严格为 scan→adjudicate→coreference→resolve；status 显示 lexeme/concept/coreference/revalidation/epoch/warning；人工 warning 数不导致命令非零退出。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py tests/test_parallel_v4_v2.py -k "cli or export or status" -q`

预期：FAIL，新命令与字段尚未接入。

- [ ] **步骤 3：增加命令和参数**

增加：

```text
migrate-v4 BOOK_ID --preview
migrate-v4 BOOK_ID --confirm TOKEN
coreference-v4 BOOK_ID --max-cases N --max-attempts N
revalidate-v4 BOOK_ID --max-tasks N --max-attempts N
```

`translate-v4` 接收 `--decision-mode auto|interactive`、`--pause-on-review`、`--max-knowledge-epochs`；正常退出码只由真正未完成/失败决定，`completed_with_warnings` 返回 0。

- [ ] **步骤 4：增强状态和本地审阅页**

`status-v4` 返回设计规定的计数；UI 把 uncertain coreference、render conflict 和 warning stale 分区显示。接受/拒绝人工建议是覆盖动作，不是 pending 自动任务；页面不得把 warning queue 标成“流程未完成”。

- [ ] **步骤 5：实现警告导出策略**

`export_rows()` 返回 validation status 和 task 摘要；`V4Validator` 为 warning_stale 添加 warning issue。默认自动导出允许活动旧译文并生成 `quality_report.md`；显式 `--strict-validation` 拒绝 warning_stale。保留现有 `--allow-warnings` 作为其他结构警告的兼容开关。

- [ ] **步骤 6：更新示例配置和公共导出**

`config.example.yaml` 写入：

```yaml
parallel_v4:
  decision_mode: auto
  pause_on_review: false
  unattended_failure_policy: finish_with_warnings
  max_knowledge_epochs: 3
```

在 `__init__.py` 导出 coordinator/runner/migrator；不导出内部 SQL helper。

- [ ] **步骤 7：运行 CLI/UI/导出回归**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py tests/test_parallel_v4_v2.py tests/test_precise_revalidation.py tests/test_v4_knowledge_epochs.py -q
```

预期：PASS；不启动真实浏览器，不调用真实模型。

- [ ] **步骤 8：Commit**

```powershell
git add main.py src/core/v4/__init__.py src/core/v4/database.py src/core/v4/validation.py src/core/v4/exporter.py src/core/v4/web_review.py config/config.example.yaml tests/test_parallel_v4.py tests/test_parallel_v4_v2.py
git commit -m "feat: expose schema 8 unattended workflow"
```

### 任务 16：实现批量多模式 occurrence 回填和三百万词规模约束

**文件：**
- 修改：`src/core/v4/matcher.py`
- 修改：`src/core/v4/knowledge_epochs.py`
- 修改：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：编写禁止 concept×block 扫描的失败测试**

生成至少 3,000,000 个英文词的合成 source、10,000 个 blocks、2,000 个 lexeme，其中只有 5,000 个实际 occurrences。对 100 个新增词形回填时 monkeypatch block 读取计数，要求活动源只遍历一次，不得调用 100 次正则全书扫描。

- [ ] **步骤 2：运行规模测试并确认失败或超出计数**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_v4_storage_scale.py -k three_million -q`

预期：FAIL，尚无批量回填器。

- [ ] **步骤 3：实现单次多模式匹配**

在 matcher 中增加 `MultiFormMatcher.compile(forms)` 和 `finditer(text)`；优先复用项目现有词法索引/Trie，保持单词边界、大小写和 curly punctuation 规则。checkpoint 把本批所有新增 form 一次编译、一次遍历活动源，并按批提交 occurrences。

- [ ] **步骤 4：验证复杂度和偏移**

测试断言：block 读取次数等于活动 block 数；写入行数等于实际 occurrence；所有 source slice 精确；第二次相同回填写入 0 行；SQLite 大小仍通过 `StorageBudget`。

- [ ] **步骤 5：运行规模与词法回归**

运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_v4_storage_scale.py tests/test_v4_matcher_targets.py tests/test_candidate_lattice.py -q
```

预期：PASS；报告本地算法耗时，但不把真实模型耗时混入复杂度结论。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/matcher.py src/core/v4/knowledge_epochs.py tests/test_v4_storage_scale.py
git commit -m "perf: backfill form occurrences in one pass"
```

### 任务 17：全回归、备份库迁移预演和《新日之书》验收

**文件：**
- 只读活动库：`projects/new_sun_omnibus/artifacts/parallel_v4/book.db`
- 创建演练目录：`projects/new_sun_omnibus/artifacts/parallel_v4-schema8-pilot/`
- 不提交运行产物。

- [ ] **步骤 1：运行全部离线自动化验证**

```powershell
.\.venv\Scripts\python.exe -m pytest tests --ignore=tests/test_foila_logic.py -q
.\.venv\Scripts\python.exe -m compileall -q src main.py
git diff --check
```

预期：全部 PASS；`tests/test_foila_logic.py` 仍因外部 `ARK_API_KEY` 单独排除并书面报告，不把根目录临时模型脚本计入本轮结论。

- [ ] **步骤 2：核对活动数据库并创建演练副本**

先解析活动库与目标目录绝对路径，确认源为：

`D:\llm\小说翻译\projects\new_sun_omnibus\artifacts\parallel_v4\book.db`

目标必须位于：

`D:\llm\小说翻译\projects\new_sun_omnibus\artifacts\parallel_v4-schema8-pilot\`

使用 SQLite backup API 或 `Copy-Item -LiteralPath` 复制数据库及所需只读审计归档；禁止移动、删除或覆盖活动库。

- [ ] **步骤 3：对演练副本执行 preview 并核对摘要**

用临时项目根指向 pilot，执行迁移 preview。保存：15 组碰撞、target conflicts、误标 needs_revalidate、真实 stale translation、预计 lexeme/concept/redirect/task 数和 confirm token。确认 preview 前后 pilot DB hash 相同。

- [ ] **步骤 4：确认迁移并执行 SQL 完整性检查**

只对 pilot 使用 confirm token。验证：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT normalized_form, COUNT(*) FROM lexemes
 WHERE retired_version IS NULL GROUP BY normalized_form HAVING COUNT(*) > 1;
SELECT COUNT(*) FROM blocks WHERE status='needs_revalidate';
```

预期：integrity 为 ok，外键 0 行，活动 lexeme 重复 0，旧误标 block 为 0；只有活动 V4 译文可关联 pending task。

- [ ] **步骤 5：在 pilot 上执行自动共指与重验**

先用 fake/offline 缓存验证命令路径，再在用户批准的模型配置下执行：

```powershell
.\.venv\Scripts\python.exe main.py coreference-v4 new_sun_omnibus_schema8_pilot
.\.venv\Scripts\python.exe main.py revalidate-v4 new_sun_omnibus_schema8_pilot
.\.venv\Scripts\python.exe main.py status-v4 new_sun_omnibus_schema8_pilot
```

模型或预算不可用时必须得到 completed_with_warnings，而不是遗留 validating/pending 任务。

- [ ] **步骤 6：核对真实语义回归**

报告并人工抽查：Briah、Chatelaine、Malrubius、Triskele、II The Fleshing、Venant、Drotte、Roche、Corpse、Corpse Door、Night、Severian。必须满足：同一 lexeme 默认译名唯一；不同身份可保留多个 concept；15 组碰撞均有 same/different/uncertain/non_entity 关系或已 redirect；Severian 默认工作译名唯一；未决共指不阻塞翻译。

- [ ] **步骤 7：验证导出质量报告和断点重跑**

在 pilot 导出 TXT/EPUB/quality report；如有 warning_stale，正文使用旧活动译文且报告列出 block/change/reason。再次运行 coreference/revalidate，断言不增加模型调用、任务、redirect 或 translation version。

- [ ] **步骤 8：最终工作树和提交审计**

```powershell
git status --short
git log -20 --oneline
git diff --check
```

运行产物必须被 Git 忽略。若任务 1—16 已分别提交，本步骤不创建空提交；最终报告每个阶段测试证据、pilot 迁移摘要、模型调用数、警告终态和活动库未改动的 hash 证据。

## 计划完成自检

- [ ] 设计目标 1—10 均有对应实现任务和失败测试。
- [ ] 同词形全局译名、同名异物、类型分歧和文学不确定性分别由 lexeme、concept、type observation、uncertain decision 表达。
- [ ] 所有重验创建路径都要求活动、已完成的 parallel_v4 译文。
- [ ] 任何 patch 都生成完整块；任何失败都不覆盖旧活动译文。
- [ ] 自动模式在模型冲突、协议失败、外部服务失败和纪元上限下都有有限终态。
- [ ] 没有生产路径执行“变化概念数 × 全书块数”的正则扫描。
- [ ] schema 7 不能在普通命令中静默升级，真实演练只使用副本。
- [ ] 文档中不存在未落实的占位标记或未定义方法。
