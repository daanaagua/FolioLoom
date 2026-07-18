# 叙事记忆融合与动态并行翻译实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有 `parallel_v4` 上实现 schema 9、融合预映射、位置开放叙事记忆、动态并行调度和记忆级精确重验。

**架构：** 保留本地词汇扫描、冻结知识纪元和两层翻译；把 `SemanticMapper` 升级为严格结构化的 `NarrativePremapper`，并以追加式记忆、串行快照和有界检索为翻译提供跨章节状态。所有 worker 继续只产生内存结果，由协调器按 `global_index` 原子提交知识版本、记忆版本、译文和精确依赖。

**技术栈：** Python 3.11、SQLite、dataclasses、Pydantic、pytest、现有 `parallel_v4` CLI/HTTP 本地评审界面、TXT/EPUB 导出器。

---

## 文件结构

### 新建文件

- `src/core/v4/schema_v9.py`：schema 9 创建、检查、预览和 schema 8→9 原子迁移。
- `src/core/v4/narrative_models.py`：预映射、记忆、快照、话语状态和动态计划的不可变类型。
- `src/core/v4/narrative_protocol.py`：融合预映射 JSON 协议、证据校验和分区降级。
- `src/core/v4/narrative_memory.py`：记忆版本、追加式合并、快照构建、检索和缓存存储。
- `src/core/v4/narrative_scheduler.py`：叙事波动评分、island 边界和动态并发规划。
- `tests/test_v4_schema9_migration.py`：schema 9 创建、迁移、回滚和兼容测试。
- `tests/test_narrative_protocol.py`：融合预映射协议和证据约束测试。
- `tests/test_narrative_memory.py`：记忆合并、可见性、快照、检索和缓存测试。
- `tests/test_narrative_pipeline.py`：前瞻流水线、动态调度、上下文和失败降级集成测试。
- `tests/test_narrative_revalidation.py`：记忆依赖、精确失效、修补和重译测试。

### 修改文件

- `src/core/v4/database.py`：切换 schema 入口，扩展译文提交、状态查询和记忆依赖。
- `src/core/v4/models.py`：扩展 `ContextPacket`、`TranslationOutcome` 和依赖快照。
- `src/core/v4/semantic_mapper.py`：保留兼容适配器并委托给新预映射协议。
- `src/core/v4/context.py`：注入叙事快照、话语状态、样式状态和准确依赖。
- `src/core/v4/pipeline.py`：前瞻预映射、动态 wave/island、双版本冻结和串行提交。
- `src/core/v4/knowledge_epochs.py`：同时协调知识提案与补充记忆提案。
- `src/core/translator.py`：解析补充记忆和样式变化，限制润色修改权限。
- `src/core/schemas.py`：扩展 `TextChunk` 的结构化结果字段。
- `src/core/v4/revalidation.py`：识别记忆、快照、话语和样式依赖。
- `src/core/v4/validation.py`：增加结构保真和语义义务校验入口。
- `src/core/v4/exporter.py`：导出质量报告中的记忆/预映射/动态调度信息。
- `src/core/v4/web_review.py`：显示叙事记忆、证据、话语状态和波动原因。
- `src/core/v4/migration.py`：使用 schema 9 确认流程。
- `src/core/v4/__init__.py`：导出新增公共类型。
- `main.py`：新增预映射、记忆查看、快照重建命令和翻译配置。
- `config/prompts.yaml`：补充结构化记忆和样式输出协议。

## 任务 1：建立 schema 9 和显式迁移

**文件：**
- 创建：`src/core/v4/schema_v9.py`
- 创建：`tests/test_v4_schema9_migration.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/migration.py`

- [x] **步骤 1：编写空库 schema 9 失败测试**

```python
def test_empty_database_initializes_schema9(tmp_path):
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
    assert version == "9"
    assert {
        "memory_versions",
        "narrative_memories",
        "narrative_memory_evidence",
        "narrative_memory_subjects",
        "narrative_memory_links",
        "narrative_snapshots",
        "premap_results",
        "source_structure",
        "style_snapshots",
    } <= tables
```

- [x] **步骤 2：运行测试确认 schema 仍为 8**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_v4_schema9_migration.py::test_empty_database_initializes_schema9 -q
```

预期：FAIL，schema version 为 `8` 或缺少新表。

- [x] **步骤 3：实现 schema 9 创建脚本**

`schema_v9.py` 定义：

```python
SCHEMA_VERSION = 9

def create_schema9(connection: sqlite3.Connection) -> None:
    create_schema8(connection)
    connection.executescript(SCHEMA9_SQL)
    connection.execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '9')"
    )
```

`SCHEMA9_SQL` 使用规格中九张新表，并为 `translation_versions` 目标结构增加：

```text
memory_version
snapshot_id
context_hash
style_snapshot_id
discourse_state_hash
```

JSON 字段默认使用 `{}` 或 `[]`，外键指向 `blocks`、`knowledge_versions`、`memory_versions` 和相关记忆表。

- [x] **步骤 4：编写 schema 8→9 迁移和回滚测试**

测试必须断言：

```python
preview = preview_schema9(path)
assert preview["from_version"] == 8
assert preview["to_version"] == 9
assert preview["confirmation_token"]

with pytest.raises(SchemaMigrationError):
    migrate_schema9(path, "wrong-token")

result = migrate_schema9(path, preview["confirmation_token"])
assert result["schema_version"] == 9
```

另一个测试在重建 `translation_versions` 中途注入异常，断言 schema 仍为 8、活动译文和依赖行数不变。

- [x] **步骤 5：实现非破坏性迁移**

迁移流程：

```python
def migrate_schema9(path: str | Path, confirm_token: str) -> dict[str, Any]:
    preview = preview_schema9(path)
    if confirm_token != preview["confirmation_token"]:
        raise SchemaMigrationError("schema 9 confirmation token mismatch")
    with sqlite3.connect(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _rebuild_translation_versions_with_memory_columns(connection)
        connection.executescript(SCHEMA9_SQL)
        _assert_schema9_invariants(connection)
        connection.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '9')"
        )
        connection.commit()
    return inspect_schema9(path)
```

重建译文表时复制所有旧列，新增列使用空值或当前初始 `memory_version`。依赖表不删除，外键检查在提交前执行。

- [x] **步骤 6：切换数据库和迁移器入口**

`database.py` 从 `schema_v9` 导入：

```python
from .schema_v9 import (
    SCHEMA_VERSION,
    SchemaUpgradeRequired,
    assert_schema9_or_empty,
)
```

`migration.py` 对 schema 8 要求显式 `migrate-v4 --preview/--confirm`，对 schema 9 正常打开。

- [x] **步骤 7：运行迁移测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_v4_schema9_migration.py tests/test_v4_schema8_migration.py -q
```

预期：全部 PASS。

- [x] **步骤 8：Commit**

```powershell
git add src/core/v4/schema_v9.py src/core/v4/database.py src/core/v4/migration.py tests/test_v4_schema9_migration.py
git commit -m "feat: add schema 9 narrative storage migration"
```

## 任务 2：定义叙事类型和有界校验

**文件：**
- 创建：`src/core/v4/narrative_models.py`
- 修改：`src/core/v4/models.py`
- 创建：`tests/test_narrative_protocol.py`

- [x] **步骤 1：编写类型与边界失败测试**

```python
def test_memory_candidate_rejects_unknown_type():
    with pytest.raises(ValueError, match="memory_type"):
        NarrativeMemoryCandidate(
            candidate_id="M1",
            memory_type="plot_answer",
            statement="x",
            truth_status="asserted",
            visibility="reader_visible",
            confidence=0.9,
            evidence_spans=("x",),
        )

def test_context_packet_records_dual_versions():
    packet = ContextPacket(
        block_id="b1",
        knowledge_version=4,
        memory_version=7,
        snapshot_id="snapshot-7",
        rendered="context",
        required_chars=7,
    )
    assert packet.memory_version == 7
```

- [x] **步骤 2：运行测试确认类型不存在**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_protocol.py -q
```

预期：FAIL，无法导入新增类型或 `ContextPacket` 不接受字段。

- [x] **步骤 3：实现不可变类型**

`narrative_models.py` 定义：

```python
@dataclass(frozen=True)
class DiscourseState:
    viewpoint_holder: str = ""
    narrator_layer: str = ""
    active_speakers: tuple[str, ...] = ()
    addressed_parties: tuple[str, ...] = ()
    scene_location: str = ""
    scene_time: str = ""
    presentation_layer: str = ""
    unresolved_references: tuple[str, ...] = ()
    style_signals: tuple[str, ...] = ()
    state_confidence: float = 0.0

@dataclass(frozen=True)
class NarrativeMemoryCandidate:
    candidate_id: str
    memory_type: str
    statement: str
    truth_status: str
    visibility: str
    confidence: float
    evidence_spans: tuple[str, ...]
    subjects: tuple[tuple[str, str, str], ...] = ()
    related_memory_ids: tuple[str, ...] = ()
    state_operation: str = "append"
    high_impact: bool = False

@dataclass(frozen=True)
class NarrativePremapResult:
    semantic_relations: tuple[SemanticRelation, ...]
    memory_candidates: tuple[NarrativeMemoryCandidate, ...]
    discourse_delta: DiscourseDelta
    validation_warnings: tuple[str, ...] = ()
    degraded: bool = False
```

构造时校验枚举、长度、置信度、最大条数和字符串字节数。

- [x] **步骤 4：扩展翻译模型**

`models.py` 增加：

```python
@dataclass(frozen=True)
class NarrativeDependencySnapshot:
    memory_id: str
    semantic_fingerprint: str

@dataclass
class ContextPacket:
    block_id: str
    knowledge_version: int
    rendered: str
    required_chars: int
    memory_version: int = 1
    snapshot_id: str = ""
    matched_lexeme_ids: List[str] = field(default_factory=list)
    matched_concept_ids: List[str] = field(default_factory=list)
    matched_rule_ids: List[str] = field(default_factory=list)
    matched_claim_ids: List[str] = field(default_factory=list)
    matched_memory_ids: List[str] = field(default_factory=list)
    style_snapshot_id: str = ""
    discourse_state_hash: str = ""
    context_hash: str = ""
```

`TranslationOutcome` 增加 `memory_version`、`snapshot_id`、`narrative_dependencies`、`supplemental_memory_candidates`、`style_delta` 和上下文哈希字段。

- [x] **步骤 5：运行类型测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_protocol.py tests/test_parallel_v4.py -q
```

预期：全部 PASS。

- [x] **步骤 6：Commit**

```powershell
git add src/core/v4/narrative_models.py src/core/v4/models.py tests/test_narrative_protocol.py
git commit -m "feat: define bounded narrative data models"
```

## 任务 3：实现融合预映射协议和分区降级

**文件：**
- 创建：`src/core/v4/narrative_protocol.py`
- 修改：`src/core/v4/semantic_mapper.py`
- 修改：`src/core/v4/__init__.py`
- 修改：`tests/test_narrative_protocol.py`

- [x] **步骤 1：编写协议 grounding 测试**

```python
def test_premapper_keeps_valid_sections_when_one_section_is_invalid():
    response = {
        "semantic_relations": [{
            "relation_type": "referential_link",
            "inference_strength": "explicit",
            "source_spans": ["The woman", "she"],
            "related_memory_ids": [],
            "translation_constraint": "保留二者同指。"
        }],
        "memory_candidates": [{
            "candidate_id": "M1",
            "memory_type": "explicit_fact",
            "statement": "A woman entered.",
            "truth_status": "asserted",
            "visibility": "reader_visible",
            "confidence": 0.9,
            "subjects": [],
            "related_memory_ids": [],
            "evidence_spans": ["not in source"],
            "state_operation": "append",
            "high_impact": False
        }],
        "discourse_delta": {"active_speakers": []}
    }
    result = validate_premap_payload(response, "The woman entered; she sat.")
    assert len(result.semantic_relations) == 1
    assert result.memory_candidates == ()
    assert "memory_candidates" in result.validation_warnings[0]
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_protocol.py::test_premapper_keeps_valid_sections_when_one_section_is_invalid -q
```

预期：FAIL，协议函数不存在。

- [x] **步骤 3：实现规范化与独立校验**

`narrative_protocol.py` 提供：

```python
def validate_premap_payload(
    payload: Any,
    source_text: str,
    allowed_subject_ids: Collection[str] = (),
    allowed_memory_ids: Collection[str] = (),
) -> NarrativePremapResult:
    relations, relation_warnings = _validate_relations(...)
    candidates, memory_warnings = _validate_memory_candidates(...)
    delta, discourse_warnings = _validate_discourse_delta(...)
    return NarrativePremapResult(
        semantic_relations=tuple(relations),
        memory_candidates=tuple(candidates),
        discourse_delta=delta,
        validation_warnings=tuple(
            relation_warnings + memory_warnings + discourse_warnings
        ),
        degraded=bool(relation_warnings or memory_warnings or discourse_warnings),
    )
```

所有证据 span 使用空白折叠后在当前英文原文中逐字查找；短 ID 只能来自请求白名单。

- [x] **步骤 4：实现 `NarrativePremapper`**

```python
class NarrativePremapper:
    def map(
        self,
        *,
        block: V4Block,
        structure: Mapping[str, Any],
        prior_snapshot: Mapping[str, Any],
        discourse_state: DiscourseState,
        provisional_subjects: Sequence[Mapping[str, Any]],
    ) -> NarrativePremapResult:
        raw = self.llm.chat(
            messages=self._messages(...),
            purpose="narrative_premap",
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            json_mode=True,
            stream=False,
        )
        return validate_premap_payload(...)
```

顶层 JSON 失败有限重试；耗尽后返回 `degraded=True` 的空候选结果，并延续上一话语状态。

- [x] **步骤 5：保留旧接口适配器**

`SemanticMapper.map(source_text, prior_context)` 委托预映射器的关系校验和渲染，使现有调用和测试继续工作：

```python
result = self._premapper.map_legacy(source_text, prior_context)
self.last_succeeded = not result.degraded
return render_semantic_relations(result.semantic_relations)
```

实施说明：生产流水线直接使用 `NarrativePremapper`；旧 `SemanticMapper`
作为独立兼容路径保留，避免在同一块上重复调用模型。它继续通过原有协议和
回归测试，不再强制委托完整记忆预映射。

- [x] **步骤 6：运行协议与旧语义映射测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_protocol.py tests/test_parallel_v4.py -q
```

预期：全部 PASS。

- [x] **步骤 7：Commit**

```powershell
git add src/core/v4/narrative_protocol.py src/core/v4/semantic_mapper.py src/core/v4/__init__.py tests/test_narrative_protocol.py
git commit -m "feat: add fused narrative premap protocol"
```

## 任务 4：实现叙事记忆存储、缓存和追加式合并

**文件：**
- 创建：`src/core/v4/narrative_memory.py`
- 修改：`src/core/v4/database.py`
- 创建：`tests/test_narrative_memory.py`

- [x] **步骤 1：编写缓存幂等测试**

```python
def test_premap_cache_key_is_stable_and_reused(database, block):
    store = NarrativeMemoryStore(database)
    key = store.premap_cache_key(
        block=block,
        structure_hash="s",
        prompt_hash="p",
        model_id="deepseek-v4-flash",
        parameters_hash="x",
        prior_snapshot_hash="before",
        provisional_subject_hash="subjects",
    )
    store.save_premap_result(key=key, block=block, result=sample_result())
    assert store.load_premap_result(key) == store.load_premap_result(key)
    assert database.table_count("premap_results") == 1
```

- [x] **步骤 2：编写重复、替代和矛盾测试**

```python
def test_memory_merge_is_append_only_and_preserves_contradiction(database, block):
    store = NarrativeMemoryStore(database)
    first = store.merge_candidates(block, [fact("The gate is locked.")])
    duplicate = store.merge_candidates(block, [fact("The gate is locked.")])
    opposite = store.merge_candidates(
        block, [fact("The gate is open.", operation="append")]
    )
    assert duplicate.memory_ids == first.memory_ids
    assert store.link_relations(first.memory_ids[0]) == ["contradicts"]
    assert opposite.memory_version > first.memory_version
```

- [x] **步骤 3：运行测试确认存储层不存在**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_memory.py -q
```

预期：FAIL，无法导入 `NarrativeMemoryStore`。

- [x] **步骤 4：实现缓存和版本 API**

`NarrativeMemoryStore` 使用 `V4Database.transaction()`：

```python
def current_memory_version(self) -> int: ...
def create_memory_version(
    self, reason: str, source_global_index: int, connection
) -> int: ...
def premap_cache_key(...) -> str: ...
def load_premap_result(self, cache_key: str) -> NarrativePremapResult | None: ...
def save_premap_result(...) -> str: ...
```

缓存唯一键为规格中的七项哈希材料，响应各分区和校验警告分别存储。

- [x] **步骤 5：实现追加式合并**

```python
def merge_candidates(
    self,
    block: V4Block,
    candidates: Sequence[NarrativeMemoryCandidate],
    *,
    source: str = "premap",
    connection: sqlite3.Connection | None = None,
) -> MemoryMergeResult:
    valid = self._ground_and_bound(block, candidates)
    if not valid:
        return MemoryMergeResult(self.current_memory_version(), (), ())
    version = self.create_memory_version(
        f"{source} memory for {block.id}", block.global_index, connection
    )
    for candidate in valid:
        memory_id = stable_memory_id(candidate, block)
        self._insert_or_reuse_memory(...)
        self._insert_evidence(...)
        self._insert_subjects(...)
        self._insert_links_without_overwrite(...)
    return MemoryMergeResult(version, tuple(ids), tuple(change_ids))
```

明确重复复用 ID；状态变化和矛盾只追加关系，不修改旧陈述。

- [x] **步骤 6：运行存储测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_memory.py -q
```

预期：全部 PASS。

- [x] **步骤 7：Commit**

```powershell
git add src/core/v4/narrative_memory.py src/core/v4/database.py tests/test_narrative_memory.py
git commit -m "feat: persist append-only narrative memory"
```

## 任务 5：实现位置快照、话语状态和有界检索

**文件：**
- 修改：`src/core/v4/narrative_memory.py`
- 修改：`tests/test_narrative_memory.py`

- [x] **步骤 1：编写防后文泄露测试**

```python
def test_snapshot_excludes_future_reveal(database, blocks):
    store = NarrativeMemoryStore(database)
    past = store.insert_memory(reveal_global_index=1, visibility="reader_visible")
    future = store.insert_memory(reveal_global_index=9, visibility="reader_visible")
    snapshot = store.build_snapshot(blocks[4])
    assert past.id in snapshot.visible_memory_ids
    assert future.id not in snapshot.visible_memory_ids
```

- [x] **步骤 2：编写非关键词召回测试**

```python
def test_retrieval_uses_active_speaker_without_name_in_source(database, block):
    store = NarrativeMemoryStore(database)
    memory = store.insert_character_state(subject_id="concept_tecla")
    snapshot = store.build_snapshot(
        block,
        discourse_state=DiscourseState(active_speakers=("concept_tecla",)),
    )
    selected = store.retrieve_for_block(
        block,
        snapshot,
        matched_subject_ids=(),
        max_chars=4000,
    )
    assert memory.id in {item.id for item in selected.memories}
```

- [x] **步骤 3：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_memory.py -q
```

预期：FAIL，快照或检索方法不存在。

- [x] **步骤 4：实现话语状态合并和快照**

```python
def apply_discourse_delta(
    prior: DiscourseState, delta: DiscourseDelta
) -> DiscourseState:
    return DiscourseState(
        viewpoint_holder=delta.viewpoint_holder.or_else(prior.viewpoint_holder),
        active_speakers=delta.active_speakers.or_else(prior.active_speakers),
        ...
    )

def build_snapshot(
    self,
    block: V4Block,
    *,
    knowledge_version: int,
    memory_version: int,
    discourse_state: DiscourseState,
) -> NarrativeSnapshot:
    visible_ids = self._visible_memory_ids(block.global_index, ...)
    digest = snapshot_hash(...)
    return self._insert_or_reuse_snapshot(...)
```

快照只保存有界 ID、状态 JSON 和哈希。

- [x] **步骤 5：实现多信号检索和字符预算**

```python
def retrieve_for_block(..., max_chars: int) -> NarrativeRetrieval:
    candidates = self._candidate_rows_for_subjects_scene_and_questions(...)
    ranked = sorted(candidates, key=self._ranking_key)
    required, optional = partition_required(ranked)
    if rendered_size(required) > max_chars:
        raise NarrativeContextOverflow(...)
    selected = required + fit_optional(optional, max_chars - rendered_size(required))
    return NarrativeRetrieval(memories=tuple(selected), ...)
```

评分严格使用规格中的确定性特征和稳定同分规则。

- [x] **步骤 6：运行快照和检索测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_memory.py -q
```

预期：全部 PASS。

- [x] **步骤 7：Commit**

```powershell
git add src/core/v4/narrative_memory.py tests/test_narrative_memory.py
git commit -m "feat: add position-gated narrative snapshots"
```

## 任务 6：扩展翻译上下文和模型输出

**文件：**
- 修改：`src/core/v4/context.py`
- 修改：`src/core/schemas.py`
- 修改：`src/core/translator.py`
- 修改：`config/prompts.yaml`
- 创建：`tests/test_narrative_pipeline.py`

- [x] **步骤 1：编写上下文顺序和依赖测试**

```python
def test_context_includes_memory_and_discourse_after_semantic_constraints(...):
    packet = builder.build(
        block,
        narrative_snapshot=snapshot,
        narrative_retrieval=retrieval,
        semantic_relations=relations,
    )
    assert packet.rendered.index("<semantic_relations>") < packet.rendered.index(
        "<narrative_memory>"
    )
    assert packet.rendered.index("<narrative_memory>") < packet.rendered.index(
        "<discourse_state>"
    )
    assert packet.matched_memory_ids == ["memory-1"]
    assert packet.context_hash
```

- [x] **步骤 2：编写补充记忆只接受英文证据测试**

```python
def test_translation_supplemental_memory_requires_english_evidence():
    parsed = engine._parse_xml_response(
        "<response><translation>译文</translation>"
        "<supplemental_memory><memory evidence='中文措辞'>猜测</memory>"
        "</supplemental_memory></response>"
    )
    assert parsed["supplemental_memory_candidates"] == []
```

- [x] **步骤 3：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_pipeline.py -q
```

预期：FAIL，新上下文参数或输出字段不存在。

- [x] **步骤 4：扩展 `ContextBuilder`**

增加参数：

```python
narrative_snapshot: NarrativeSnapshot | None = None
narrative_retrieval: NarrativeRetrieval | None = None
semantic_relations: Sequence[SemanticRelation] = ()
style_snapshot: Mapping[str, Any] | None = None
```

按规格顺序渲染标签，返回准确 memory/rule/lexeme 依赖和 `context_hash`。必需叙事上下文超预算抛出 `NarrativeContextOverflow`。

- [x] **步骤 5：扩展初译解析**

`TextChunk` 增加：

```python
supplemental_memory_candidates: list[dict[str, Any]]
style_delta: dict[str, Any]
```

XML/JSON 解析器只保留能在 `source_text` grounding 的英文 evidence。`prompts.yaml` 明确：

- 补充记忆置信度低于预映射；
- 只引用当前英文原文；
- 润色不能返回知识或记忆变化；
- `memory_summary` 仅用于审计。

- [x] **步骤 6：运行上下文和翻译器测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_pipeline.py tests/test_pipeline_v3.py tests/test_parallel_v4.py -q
```

预期：全部 PASS。

- [x] **步骤 7：Commit**

```powershell
git add src/core/v4/context.py src/core/schemas.py src/core/translator.py config/prompts.yaml tests/test_narrative_pipeline.py
git commit -m "feat: inject narrative context into translation"
```

## 任务 7：实现动态调度和前瞻预映射流水线

**文件：**
- 创建：`src/core/v4/narrative_scheduler.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`src/core/v4/knowledge_epochs.py`
- 修改：`tests/test_narrative_pipeline.py`

- [x] **步骤 1：编写波动分档和边界测试**

```python
def test_high_volatility_forces_single_worker_and_small_island():
    plan = NarrativeScheduler().plan(
        [signals(viewpoint_shift=True, unresolved_references=4)]
    )
    assert plan[0].workers == 1
    assert 1 <= plan[0].island_size <= 2

def test_island_never_crosses_reveal_boundary():
    islands = scheduler.make_islands(blocks, boundary_indexes={2})
    assert all(not ({1, 2} <= {b.global_index for b in i.blocks}) for i in islands)
```

- [x] **步骤 2：编写前瞻缓存流水线测试**

```python
def test_translation_premaps_ahead_and_reuses_cache(fake_llm, pipeline):
    result = pipeline.run(max_blocks=6)
    assert result["premap_cursor"] >= result["translation_cursor"]
    first_calls = fake_llm.count("narrative_premap")
    pipeline.run(max_blocks=6, force=True)
    assert fake_llm.count("narrative_premap") == first_calls
```

- [x] **步骤 3：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_pipeline.py -q
```

预期：FAIL，动态计划和预映射游标不存在。

- [x] **步骤 4：实现波动评分**

`NarrativeScheduler.score()` 按规格信号产生 0–100 分和原因列表；`plan()` 返回：

```python
@dataclass(frozen=True)
class DynamicWavePlan:
    start_global_index: int
    end_global_index: int
    volatility: int
    reasons: tuple[str, ...]
    workers: int
    island_size: int
```

同样输入产生完全相同计划。

- [x] **步骤 5：实现前瞻协调器**

`pipeline.py` 增加：

```python
def _ensure_premapped_through(self, target_global_index: int) -> PremapWindow:
    while self._premap_cursor <= target_global_index:
        batch = self._next_premap_batch()
        raw_results = self._map_batch_against_frozen_snapshot(batch)
        for block, result in sorted(raw_results, key=lambda x: x[0].global_index):
            self.narrative_store.commit_premap(block, result)
        self._advance_premap_cursor(batch)
    return self.narrative_store.window(...)
```

正常翻译前确保目标块已有快照；缓存命中不调用模型。映射失败写降级结果并继续。

- [x] **步骤 6：把动态计划接入 wave**

替换固定 `islands = _make_islands(..., island_size)` 和单一 `workers`：

```python
while cursor < len(candidates):
    self._ensure_premapped_through(self._ahead_target(cursor))
    wave_plan = scheduler.plan_next(candidates[cursor:], ...)
    islands = scheduler.materialize_wave(candidates, cursor, wave_plan)
    outcomes = self._run_wave(islands, wave_plan.workers, frozen_state)
    self._commit_wave_in_global_order(outcomes)
```

速率限制和失败只能降低动态计划的并发上限；成功后逐步恢复。

- [x] **步骤 7：扩展知识纪元提交补充记忆**

`KnowledgeEpochCoordinator` 的 staged entry 加入：

```python
"supplemental_memory_candidates": [
    candidate_to_json(value)
    for value in outcome.supplemental_memory_candidates
]
```

在 checkpoint 中按块顺序调用 `NarrativeMemoryStore.merge_candidates()`，并记录 `memory_version`、deferred memory 数量和记忆变化 ID。

- [x] **步骤 8：运行流水线测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_pipeline.py tests/test_v4_knowledge_epochs.py tests/test_parallel_v4.py -q
```

预期：全部 PASS。

- [x] **步骤 9：Commit**

```powershell
git add src/core/v4/narrative_scheduler.py src/core/v4/pipeline.py src/core/v4/knowledge_epochs.py tests/test_narrative_pipeline.py
git commit -m "feat: add narrative-aware dynamic translation waves"
```

## 任务 8：提交双版本译文和精确记忆依赖

**文件：**
- 修改：`src/core/v4/database.py`
- 创建：`tests/test_narrative_revalidation.py`
- 修改：`tests/test_precise_revalidation.py`

- [x] **步骤 1：编写译文依赖提交测试**

```python
def test_translation_commit_records_memory_snapshot_and_discourse_dependencies(...):
    database.commit_translation_batch("run", [outcome])
    with database.connect() as connection:
        translation = connection.execute(
            "SELECT memory_version, snapshot_id, context_hash, discourse_state_hash "
            "FROM translation_versions WHERE active=1"
        ).fetchone()
        dependencies = {
            (row["dependency_type"], row["dependency_id"])
            for row in connection.execute("SELECT * FROM dependencies")
        }
    assert tuple(translation) == (7, "snap-7", "context-hash", "discourse-hash")
    assert ("narrative_memory", "memory-1") in dependencies
    assert ("narrative_snapshot", "snap-7") in dependencies
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_revalidation.py -q
```

预期：FAIL，译文表或提交快照缺少新字段。

- [x] **步骤 3：扩展不可变提交快照**

`database.py` 的 `_TranslationCommitSnapshot` 和 `_snapshot_translation_outcome()` 必须复制并校验：

```text
memory_version
snapshot_id
context_hash
style_snapshot_id
discourse_state_hash
narrative_dependencies
```

worker 提供的任一记忆依赖必须在冻结快照中可见且指纹匹配，否则整个 batch 回滚。

- [x] **步骤 4：扩展译文写入和依赖行**

所有创建译文版本的路径，包括正常提交、重译、局部修补和旧译文导入，均写入新列。正常提交增加：

```python
for snapshot in outcome.narrative_dependencies:
    insert_dependency(
        translation_id,
        "narrative_memory",
        snapshot.memory_id,
        outcome.knowledge_version,
        snapshot.semantic_fingerprint,
    )
```

快照、话语和样式使用各自哈希作为 dependency fingerprint。

- [x] **步骤 5：运行提交和旧精确依赖测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_revalidation.py tests/test_precise_revalidation.py -q
```

预期：全部 PASS。

- [x] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py tests/test_narrative_revalidation.py tests/test_precise_revalidation.py
git commit -m "feat: persist narrative translation dependencies"
```

## 任务 9：实现记忆级精确重验和安全兜底

**文件：**
- 修改：`src/core/v4/revalidation.py`
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_narrative_revalidation.py`

- [x] **步骤 1：编写影响级别测试**

```python
@pytest.mark.parametrize(
    ("change_kind", "impact"),
    [
        ("memory_evidence", 0),
        ("render_only_address", 1),
        ("relationship_state", 2),
        ("viewpoint_shift", 3),
        ("timeline_anchor", 3),
    ],
)
def test_memory_change_impact(change_kind, impact):
    assert classify_memory_change(change_kind, high_impact=False) == impact
```

- [x] **步骤 2：编写无关块不重验和失败保旧稿测试**

```python
def test_memory_change_only_plans_actual_dependents(database):
    change_id = add_memory_change(database, memory_id="M1")
    result = RevalidationPlanner(database).plan([change_id])
    assert result["planned_block_ids"] == ["dependent-block"]

def test_failed_memory_retranslation_keeps_old_active_translation(database):
    run_failed_retranslation(database)
    active = database.active_translations("parallel_v4")
    assert active["block-1"]["final_translation"] == "old valid translation"
```

- [x] **步骤 3：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_revalidation.py -q
```

预期：FAIL，planner 不识别记忆变化。

- [x] **步骤 4：扩展重验规划**

增加记忆变化查询，按 dependency type、fingerprint、位置可见性和版本生成 change set。动作规则：

```python
if impact == 0:
    action = "validate_noop"
elif impact == 1 and exact_unique_render_change:
    action = "safe_patch"
else:
    action = "retranslate"
```

身份、时间、地点、视角、叙述层和高影响揭示边界禁止局部字符串替换。

实现收紧：叙事记忆变化会推进 `memory_version` 并要求生成新的叙事快照；现有局部替换路径无法安全生成该快照。因此 schema 9 的记忆域任务统一使用整块重译，`safe_patch` 仅保留给不改变叙事快照的知识域变更。

- [x] **步骤 5：实现失败兜底和有限状态**

重译失败写 `completed_with_warning`，保留旧活动版本；成功替代必须再次验证冻结知识/记忆版本。重复 change set 复用已有任务，不生成循环。

- [x] **步骤 6：运行记忆和既有重验测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_revalidation.py tests/test_precise_revalidation.py tests/test_parallel_v4_v2.py -q
```

预期：全部 PASS。

- [x] **步骤 7：Commit**

```powershell
git add src/core/v4/revalidation.py src/core/v4/database.py tests/test_narrative_revalidation.py
git commit -m "feat: precisely revalidate narrative memory changes"
```

## 任务 10：接入 CLI、状态、评审界面和导出

**文件：**
- 修改：`main.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/web_review.py`
- 修改：`src/core/v4/exporter.py`
- 修改：`tests/test_narrative_pipeline.py`
- 修改：`tests/test_parallel_v4.py`

- [x] **步骤 1：编写 CLI 构造测试**

```python
def test_premap_and_memory_commands_construct_services(cli):
    code, output = cli.invoke("premap-v4", "book", "--max-blocks", "3")
    assert code == 0
    assert json.loads(output)["premapped"] == 3

    code, output = cli.invoke(
        "inspect-memory-v4", "book", "--block", "v01_ch01_000"
    )
    assert code == 0
    assert "memories" in json.loads(output)
```

- [x] **步骤 2：编写状态和导出报告测试**

```python
def test_status_and_export_include_narrative_metrics(database, exporter):
    status = database.status_summary()
    assert {
        "premap_cursor",
        "translation_cursor",
        "memory_version",
        "premap_cache_hit_rate",
        "degraded_premap_blocks",
    } <= status.keys()
    report = exporter.build_quality_report()
    assert "narrative_memory" in report
    assert "dynamic_scheduling" in report
```

- [x] **步骤 3：运行测试确认失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_pipeline.py tests/test_parallel_v4.py -q
```

预期：FAIL，命令和状态字段不存在。

- [x] **步骤 4：新增命令**

`main.py` 新增：

```text
premap-v4 <book_id> [--max-blocks N] [--block ID]
inspect-memory-v4 <book_id> [--block ID] [--subject ID] [--type TYPE]
rebuild-snapshots-v4 <book_id> [--from-index N]
```

`translate-v4` 增加预映射、记忆上下文、动态调度和最大记忆纪元参数；默认启用新路径。

- [x] **步骤 5：扩展状态和本地界面**

`status_summary()` 返回预映射/翻译游标、记忆版本、缓存命中、波动分布、降级块和 deferred memory proposals。

`web_review.py` 增加只读 API：

```text
/api/narrative-memory?block=<id>
/api/narrative-snapshot?block=<id>
/api/narrative-volatility?block=<id>
```

页面显示证据、关系、话语状态和波动原因；现有盲评和人工队列按钮保持不变。

- [x] **步骤 6：扩展导出**

TXT/EPUB 正文不插入系统记忆。质量报告增加：

- 降级预映射块；
- unresolved references；
- disputed memories；
- deferred proposals；
- 动态调度统计；
- 记忆相关重验和警告。

- [x] **步骤 7：运行 CLI、UI 和导出测试**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_narrative_pipeline.py tests/test_parallel_v4.py -q
```

预期：全部 PASS。

- [x] **步骤 8：Commit**

```powershell
git add main.py src/core/v4/database.py src/core/v4/web_review.py src/core/v4/exporter.py tests/test_narrative_pipeline.py tests/test_parallel_v4.py
git commit -m "feat: expose narrative workflow controls and reports"
```

## 任务 11：全量回归、规模验证和《新日之书》试跑

**文件：**
- 修改：`tests/test_v4_storage_scale.py`
- 修改：`tests/test_narrative_pipeline.py`
- 修改：`docs/superpowers/specs/2026-07-16-narrative-memory-dynamic-translation-design.md`

- [x] **步骤 1：增加规模和恢复测试**

规模夹具写入十万块元数据和多批记忆，断言：

```python
assert query_plan_uses_index("narrative_memory_subjects")
assert snapshot_row_count <= block_count
assert premap_result_count <= block_count * protocol_versions
assert recovered_cursor == last_committed_global_index + 1
```

注入波次事务失败，断言活动译文和由该波次产生的记忆版本均停留在上一完整
检查点。预映射快照允许按设计前瞻，但必须保持追加式、可审计并能在恢复后
作为已提交前缀继续使用。

- [x] **步骤 2：运行新功能测试集合**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_v4_schema9_migration.py tests/test_narrative_protocol.py tests/test_narrative_memory.py tests/test_narrative_pipeline.py tests/test_narrative_revalidation.py tests/test_v4_storage_scale.py -q
```

预期：全部 PASS。

- [x] **步骤 3：运行完整回归**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests --ignore=tests/test_foila_logic.py -q
```

最终实际：`621 passed, 8 subtests passed`，全部 PASS。

- [x] **步骤 4：执行静态完整性检查**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m compileall src main.py
git diff --check
```

预期：compileall 成功；`git diff --check` 无输出；新增生产路径均有可执行实现。

- [x] **步骤 5：迁移《新日之书》项目副本并试跑**

先复制现有项目数据库到隔离测试目录，再运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py migrate-v4 <pilot-book-id> --preview
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py migrate-v4 <pilot-book-id> --confirm <preview-token>
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py premap-v4 <pilot-book-id> --max-blocks 12
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py translate-v4 <pilot-book-id> --max-blocks 6
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py status-v4 <pilot-book-id>
```

检查：

- 每条记忆有可定位英文证据；
- 后文 reveal 不进入前文快照；
- 译名仍来自 lexeme/concept 渲染；
- 高波动块降低并发；
- 二次预映射命中缓存；
- 输出中不存在具体小说词汇硬编码。

- [x] **步骤 6：把规格状态改为已实现**

将规格头部更新为：

```text
状态：已实现并通过回归
```

并在验收章节记录实际测试数和试跑命令结果。

- [x] **步骤 7：最终 Commit**

```powershell
git add tests/test_v4_storage_scale.py tests/test_narrative_pipeline.py docs/superpowers/specs/2026-07-16-narrative-memory-dynamic-translation-design.md
git commit -m "test: verify narrative workflow end to end"
```

## 任务 12：实现 token 预算投影和动态风格锚点

**文件：**
- 创建：`src/core/v4/prompt_projection.py`
- 修改：`src/core/v4/models.py`
- 修改：`src/core/v4/context.py`
- 修改：`src/core/v4/narrative_memory.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`src/core/translator.py`
- 修改：`config/prompts.yaml`
- 修改：`config/config.example.yaml`
- 修改：`main.py`
- 创建：`tests/test_prompt_projection.py`
- 修改：`tests/test_narrative_pipeline.py`
- 修改：`tests/test_parallel_v4.py`

- [x] **步骤 1：为预算优先级和确定性裁剪编写失败测试**

测试必须证明：完整原文和硬约束永不被裁剪；相同输入产生相同投影；软预算不足
时按边际效用移除可选项；仅必需材料超过硬预算时抛出可识别的人工处理异常；
结果记录每部分的估算 token、进入的阶段和裁剪原因。

```python
def test_projection_drops_optional_anchor_before_required_semantics():
    policy = PromptBudgetPolicy(draft_soft_tokens=80, reserve_ratio=0.20)
    result = PromptProjector(policy).project(
        stage="draft",
        sections=(
            PromptSection("source", "source", priority=0, required=True),
            PromptSection("semantic", "must keep", priority=0, required=True),
            PromptSection("style_anchor", "example " * 200, priority=4),
        ),
    )
    assert "semantic" in result.included_section_ids
    assert "style_anchor" in result.dropped_section_ids
```

- [x] **步骤 2：运行预算测试并确认因缺少投影器而失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests/test_prompt_projection.py -q
```

预期：FAIL，`PromptBudgetPolicy`、`PromptSection` 或 `PromptProjector` 尚不存在。

- [x] **步骤 3：实现无外部依赖的保守 token 估算和预算投影器**

实现不可变的 `PromptBudgetPolicy`、`PromptSection`、`PromptProjection` 和
`PromptBudgetOverflow`。优先使用调用方提供的精确 token 计数器；缺失时使用版本化
保守估算器，对中文、英文、数字和标记分别计数，并保留 20% 余量。默认值：初译
软预算 6,000、润色软预算 8,000；绝对字符护栏仍由 `max_context_chars` 执行。

可选项以 `(marginal_utility, priority, stable_id)` 确定性排序；不是按字符串尾部截断。
必需项超过硬预算时抛出 `PromptBudgetOverflow`。

- [x] **步骤 4：为最小风格投影和锚点门控编写失败测试**

测试必须覆盖：任意长 `style_delta` 只能投影成受控字段和 20–60 token 的一行提示；
初译永远不接收中文例文；润色只有在位置、质量、文本类型和相似度门槛均满足时才
获得至多一个 120–300 token 双语锚点；锚点不得来自未来、失败/回退译文或自身
派生链；当前原文风格信号充分时锚点为空。

```python
def test_draft_projection_never_contains_bilingual_anchor():
    material = projector.build_style_material(
        stage="draft", style_state=state, anchor_candidates=[candidate]
    )
    assert material.anchor is None
    assert estimate_tokens(material.directive) <= 60
```

- [x] **步骤 5：运行风格测试并确认因缺少门控而失败**

运行步骤 2 的命令；预期新增用例 FAIL，现有实现会直接序列化完整 style state，且
没有位置/质量/谱系门控。

- [x] **步骤 6：实现最小风格状态和动态锚点选择**

`style_delta` 只允许更新受控的叙事距离、语域、措辞密度、句法密度、节奏、对话
习惯和文本类型字段；完整状态保存在 SQLite，提示投影只生成一行非事实性指导。

锚点候选从当前位置之前已通过完整性校验的活动译文及其英文原文构建，保存来源
块、质量、适用特征、父锚点和校准版本。选择器以位置合法性为硬门，按文本类型、
叙述层、语域、句法特征相似度减去重复使用和谱系惩罚；效用不为正则不选择。
模型只收到选中锚点的短双语正文，不收到评分、数据库 ID 或内部元数据。

- [x] **步骤 7：为初译/润色分离投影编写失败的集成测试**

捕获模型请求并断言：初译包含完整原文、硬语义和最小风格状态，但没有
`<style_anchor>`、旧译基线或重复全书摘要要求；润色包含完整原文和初稿，按预算
可带一个锚点；低效用锚点和基线不发送；审计记录估算 token 和裁剪决策。

- [x] **步骤 8：接入两层翻译、配置和审计**

`ContextPacket` 保留旧 `rendered` 兼容字段，同时增加结构化 section 统计、初译投影、
润色基础投影、最小风格提示、可选锚点和裁剪记录。`TranslationEngine` 分别接收两层
上下文，不再将同一 `memory_context` 原样复制给两个阶段。删除生产 prompt 中必须
生成 1,200 字滚动摘要的要求，但兼容解析旧模型输出。

配置增加：

```yaml
parallel_v4:
  draft_input_soft_tokens: 6000
  polish_input_soft_tokens: 8000
  prompt_reserve_ratio: 0.20
  style_directive_max_tokens: 60
  style_anchor_max_tokens: 300
  enable_style_anchors: true
```

模型配置的输出 `max_tokens` 保持安全上限含义。CLI 配置加载必须向
`V4PipelineConfig` 传递上述字段。

- [x] **步骤 9：运行定向测试并修复回归**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_prompt_projection.py `
  tests/test_narrative_pipeline.py `
  tests/test_parallel_v4.py -q
```

预期：全部 PASS；既有不启用锚点的调用保持兼容。

- [x] **步骤 10：运行完整回归和静态检查**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest tests --ignore=tests/test_foila_logic.py -q
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m compileall src main.py
git diff --check
```

实际：最终重跑为 `665 passed, 8 subtests passed`；compileall 成功；`git diff --check`
退出码为 0，仅显示工作树既有的 CRLF 提示。

- [x] **步骤 11：记录三类真实文本的实测预算**

在一个普通叙事块、一个术语密集块和一个包含对话的块上记录初译/润色各部分估算
token、裁剪项和最终请求大小。不得调用付费模型作为单元测试条件。

使用 `projects/new_sun_term_profile_trial` 中已有原文、知识库和活动初稿只读测量；
预算显示的是预留 20% 后的可用量（初译 4,800，润色 6,400）：

| 类型 | 真实块 | 原文 token | 词形命中/引号 | 初译输入 | 润色输入 | 裁剪 |
|---|---|---:|---:|---:|---:|---|
| 普通叙事 | `v01_ch04_001` | 1,051 | 17 / 2 | 3,920 / 4,800 | 5,272 / 6,400 | 无 |
| 术语密集 | `v01_ch02_000` | 959 | 30 / 0 | 4,343 / 4,800 | 5,685 / 6,400 | 无 |
| 对话密集 | `v01_ch07_001` | 1,057 | 23 / 28 | 4,401 / 4,800 | 6,013 / 6,400 | 无 |

三次测量均把实际 system prompt、完整原文、结构化上下文和已有活动初稿计入，
没有调用模型。术语密集和对话密集块接近可用软预算但仍留在绝对字符护栏内。

- [x] **步骤 12：在确认工作树提交边界后提交**

用户已确认先做完整验证，再将当前功能分支中前序 schema 9/10 与本任务的连续改动
作为同一集成边界提交并合并到 `main`。

```powershell
git add docs/superpowers/specs/2026-07-16-narrative-memory-dynamic-translation-design.md `
  docs/superpowers/plans/2026-07-16-narrative-memory-dynamic-translation.md `
  src/core/v4/prompt_projection.py src/core/v4/models.py src/core/v4/context.py `
  src/core/v4/narrative_memory.py src/core/v4/pipeline.py src/core/translator.py `
  config/prompts.yaml config/config.example.yaml main.py `
  tests/test_prompt_projection.py tests/test_narrative_pipeline.py tests/test_parallel_v4.py
git commit -m "feat: budget translation prompts and gate style anchors"
```
