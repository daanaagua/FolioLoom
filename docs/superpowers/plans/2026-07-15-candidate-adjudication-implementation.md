# 候选跨度裁决与工作译名实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 v4.2 的逐块候选分类升级为本地跨度网格、跨块聚类、受约束的双重裁决和翻译前工作译名冻结，并在受控清理旧试验数据后用 DeepSeek Flash 重跑《新日之书》前八块。

**架构：** 本地索引阶段只生成带精确偏移的候选出现和重叠跨度；模型阶段按最多 12 个候选簇的小批次返回本地短别名，结构校验后才允许形成工作概念。正式翻译只读取冻结的 `verified_target || working_target`，长书匹配使用按知识版本缓存的 Aho–Corasick 自动机，完整成功审计写入可寻址 zstd 归档。

**技术栈：** Python 3.14、Pydantic 2、SQLite、`concurrent.futures`、DeepSeek OpenAI 兼容接口、`zstandard`、pytest。

---

## 文件结构

- 创建 `src/core/v4/candidate_clusters.py`：聚合重叠候选，选择代表性语境并生成本地短别名。
- 创建 `src/core/v4/adjudicator.py`：执行第一/第二轮裁决、响应校验和风险分流。
- 创建 `src/core/v4/target_resolver.py`：生成并冻结 `working_target` 与条件译法。
- 创建 `src/core/v4/matcher.py`：实现 Aho–Corasick 词形匹配器。
- 创建 `src/core/v4/audit_archive.py`：写入可寻址 `jsonl.zst` 审计帧并执行容量检查。
- 修改 `src/core/v4/lexical_index.py`：保留重叠跨度和常见词作为专名中心的完整短语。
- 修改 `src/core/v4/models.py`：增加裁决、工作译名和索引结果的数据契约。
- 修改 `src/core/v4/scanner.py`：扫描改为本地索引，模型只在裁决阶段使用。
- 修改 `src/core/v4/database.py`：迁移 schema 7，持久化裁决、工作译名、重置和归档元数据。
- 修改 `src/core/v4/context.py`、`src/core/v4/pipeline.py`、`src/core/translator.py`：注入冻结译名、使用线性匹配并过滤空目标术语。
- 修改 `main.py`：增加裁决、译名解析、统一准备和安全重置命令。
- 修改 `requirements.txt`：增加 `zstandard>=0.23.0`。
- 创建 `tests/test_candidate_lattice.py`、`tests/test_candidate_adjudicator.py`、`tests/test_working_targets.py`、`tests/test_v4_storage_scale.py`。

### 任务 1：生成完整而可逆的候选跨度网格

**文件：**
- 修改：`src/core/v4/lexical_index.py`
- 创建：`tests/test_candidate_lattice.py`

- [ ] **步骤 1：编写失败的跨度回归测试**

```python
from src.core.v4.lexical_index import LexicalCandidateExtractor
from src.core.v4.models import V4Block


def make_block(text: str) -> V4Block:
    return V4Block(
        id="block_test", source_edition_id=1, chapter_id="ch01",
        chapter_index=1, block_index=0, global_index=0,
        block_type="prose", source_text=text, source_hash="hash",
        token_count=32, status="pending", legacy_id="v01_ch01_000",
    )


def test_lattice_retains_atomic_compound_and_common_head_spans():
    block = make_block("Drotte and Roche waited beside the Corpse Door.")
    items = LexicalCandidateExtractor([block], max_candidates=80).extract(block)
    texts = {item.original_text for item in items}
    assert {"Drotte", "Roche", "Drotte and Roche"} <= texts
    assert {"Corpse", "Corpse Door"} <= texts
    assert len({(item.start_offset, item.end_offset) for item in items}) == len(items)
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_lattice.py -q`

预期：FAIL，集合缺少 `Corpse Door`。

- [ ] **步骤 3：编写最少实现**

为 `LexicalCandidate` 增加 `risk_flags: tuple[str, ...] = ()`。将 `extract()` 的去重键改为 `(paragraph_id, start_offset, end_offset, lexical_key)`；后续大写 token 即使位于 `COMMON_WORDS` 也能进入完整短语。并列整体标记 `coordination`，相互包含的跨度标记 `span_competition`。

```python
span_key = (
    candidate.paragraph_id,
    candidate.start_offset,
    candidate.end_offset,
    lexical_key(candidate.original_text),
)
by_span[span_key] = candidate
```

- [ ] **步骤 4：运行测试验证通过**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_lattice.py tests/test_parallel_v4.py -q`

预期：PASS，原文偏移测试仍为零错误。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/v4/lexical_index.py tests/test_candidate_lattice.py tests/test_parallel_v4.py
git commit -m "feat: build overlapping lexical span lattice"
```

### 任务 2：将候选出现聚成稳定裁决簇

**文件：**
- 创建：`src/core/v4/candidate_clusters.py`
- 修改：`src/core/v4/models.py`
- 修改：`tests/test_candidate_lattice.py`

- [ ] **步骤 1：编写失败的聚类与批次上限测试**

```python
from src.core.v4.candidate_clusters import CandidateClusterBuilder


def test_cluster_builder_groups_overlaps_and_caps_model_aliases():
    candidates = extract("Drotte and Roche waited beside the Corpse Door.")
    clusters = CandidateClusterBuilder(max_contexts=3, max_alternatives=4).build(candidates)
    group = next(item for item in clusters if "Drotte and Roche" in item.texts)
    assert {"Drotte", "Roche", "Drotte and Roche"} <= set(group.texts)
    batches = CandidateClusterBuilder.batch(clusters * 13, max_clusters=12)
    assert all(len(batch.clusters) <= 12 for batch in batches)
    assert all(len(alias) <= 4 for batch in batches for alias in batch.alias_map)
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_lattice.py::test_cluster_builder_groups_overlaps_and_caps_model_aliases -q`

预期：ERROR，无法导入 `candidate_clusters`。

- [ ] **步骤 3：实现稳定聚类**

```python
@dataclass(frozen=True)
class CandidateCluster:
    id: str
    alternatives: tuple[LexicalCandidate, ...]
    contexts: tuple[str, ...]
    risk_flags: tuple[str, ...]
    affected_blocks: int

    @property
    def texts(self) -> tuple[str, ...]:
        return tuple(item.original_text for item in self.alternatives)
```

同一段落内以重叠字符区间做 union-find，再以规范化跨度签名合并跨块出现；上下文按首次、最高频、风险差异选取三条。每次调用只生成 `K01A…K12D`，数据库稳定 ID 不发送给模型。

- [ ] **步骤 4：运行测试验证通过**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_lattice.py -q`

预期：PASS，单批不超过 12 簇、48 个跨度别名、每簇 3 个上下文。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/v4/candidate_clusters.py src/core/v4/models.py tests/test_candidate_lattice.py
git commit -m "feat: cluster overlapping candidate spans"
```

### 任务 3：实现严格、可重排的双重裁决器

**文件：**
- 创建：`src/core/v4/adjudicator.py`
- 修改：`src/core/v4/models.py`
- 创建：`tests/test_candidate_adjudicator.py`

- [ ] **步骤 1：编写协议和冲突失败测试**

```python
def test_unknown_alias_never_promotes_cluster():
    llm = FakeLLM(['{"decisions":[{"cluster_id":"K01","verdict":"promote","selected_ids":["K99A"],"entity_kind":"person","confidence":1.0}]}'])
    result = make_adjudicator(llm, max_attempts=1).adjudicate([drotte_cluster()])
    assert result[0].verdict == "defer"
    assert result[0].reason == "model_protocol_failure"


def test_disagreeing_independent_passes_defer():
    result = adjudicate_twice(
        first=decision("K01", "promote", ["K01C"], "person"),
        second=decision("K01", "split", ["K01A", "K01B"], "person"),
    )
    assert result.verdict == "defer"
    assert result.reason == "independent_verdict_conflict"
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py -q`

预期：FAIL，裁决模块和数据契约不存在。

- [ ] **步骤 3：增加严格响应契约**

```python
class AdjudicationDecision(StrictModel):
    cluster_id: str = Field(pattern=r"^K(?:0[1-9]|1[0-2])$")
    verdict: str = Field(pattern=r"^(promote|reject|split|supersede|defer)$")
    selected_ids: List[str] = Field(default_factory=list, max_length=4)
    entity_kind: str = Field(pattern=r"^(person|place|organization|group|item|concept|unit|title|event|species|technology|work|artwork|personification|unknown_named_entity)$")
    confidence: float = Field(ge=0.0, le=1.0)


class AdjudicationResponse(StrictModel):
    decisions: List[AdjudicationDecision] = Field(max_length=12)
```

- [ ] **步骤 4：实现本地别名校验和独立第二轮**

`V4Adjudicator` 对 `coordination`、`span_competition`、`affected_blocks >= 3`、`confidence < 0.90`、`split`、`supersede` 执行第二轮。第二轮逆序 alternatives、重新编号，且不显示第一轮结论。未知 ID、跨簇 ID、重叠 split 和不包含原跨度的 supersede 全部失败；两次重试仍失败则整簇 `defer/model_protocol_failure`。

- [ ] **步骤 5：运行测试验证通过**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py -q`

预期：PASS，所有非法关系均无法进入 promote。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/adjudicator.py src/core/v4/models.py tests/test_candidate_adjudicator.py
git commit -m "feat: adjudicate candidate clusters conservatively"
```

### 任务 4：迁移 SQLite 并事务化保存、提升和重置

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_candidate_adjudicator.py`
- 创建：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：编写 schema、提升和重置失败测试**

```python
def test_schema_7_keeps_occurrence_after_promotion(database):
    database.persist_candidate_clusters("run_index", [cluster_fixture()])
    database.commit_adjudications("run_judge", [promote_fixture()])
    assert scalar(database, "SELECT COUNT(*) FROM lexical_candidates WHERE id='cand_a'") == 1
    assert scalar(database, "SELECT resolution_status FROM lexical_candidates WHERE id='cand_a'") == "promoted"


def test_reset_preserves_sources_baseline_and_human_locks(database):
    preview = database.preview_scan_reset()
    result = database.reset_scan_derivatives(expected_token=preview["token"])
    assert result["lexical_candidates_deleted"] == preview["lexical_candidates"]
    assert database.source_block_count() > 0
    assert database.locked_concept_count() == 1
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py tests/test_v4_storage_scale.py -q`

预期：FAIL，schema 6 缺少新表、列和方法。

- [ ] **步骤 3：实现 schema 7**

新增 `candidate_clusters`、`candidate_cluster_members`、`candidate_adjudications`、`candidate_resolutions`；为 `lexical_candidates` 增加 `risk_flags_json`、`resolution_status`；为 `concepts` 增加 `working_target`、`verified_target`。旧人工锁定 `default_target` 同步到两个新列。对 block、cluster、resolution、concept 建索引。

- [ ] **步骤 4：实现原子提交和预览 token 重置**

`commit_adjudications()` 在同一事务写裁决、resolution、证据和概念。`preview_scan_reset()` 返回各表计数和这些计数的 SHA-256 token；`reset_scan_derivatives(expected_token)` 在事务内重新计算，token 不同即回滚。只清除扫描派生数据和未锁定概念，保留 source、baseline、人工锁定条目。

- [ ] **步骤 5：运行数据库测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py tests/test_v4_storage_scale.py tests/test_parallel_v4.py -q`

预期：PASS，`integrity_check=ok` 且无外键错误。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py tests/test_candidate_adjudicator.py tests/test_v4_storage_scale.py tests/test_parallel_v4.py
git commit -m "feat: persist candidate adjudication decisions"
```

### 任务 5：拆分本地索引、模型裁决和概念提升阶段

**文件：**
- 修改：`src/core/v4/scanner.py`
- 修改：`src/core/v4/adjudicator.py`
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_parallel_v4.py`

- [ ] **步骤 1：编写扫描不调用模型的失败测试**

```python
def test_index_stage_is_local_and_does_not_create_concepts(database, blocks):
    llm = ExplodingLLM()
    result = V4Scanner(database, llm, max_attempts=1).scan_project(max_blocks=2)
    assert result["indexed"] == 2
    assert llm.calls == 0
    assert scalar(database, "SELECT COUNT(*) FROM lexical_candidates") > 0
    assert scalar(database, "SELECT COUNT(*) FROM concepts") == 0
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py -q`

预期：FAIL，当前扫描器仍调用模型。

- [ ] **步骤 3：重构扫描器**

`scan_project()` 只构建候选和簇并写 SQLite，prose 块置为 `scanned`，前置材料置为 `ready`。旧 `CandidateScanResponse` 只保留历史解析兼容。`V4Adjudicator.run()` 读取 pending clusters；只有通过裁决的 candidate resolutions 才允许 `reconcile_exact_forms()` 创建 concepts。

- [ ] **步骤 4：运行扫描、裁决和回归测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py tests/test_candidate_lattice.py tests/test_candidate_adjudicator.py -q`

预期：PASS，模型调用只出现在 adjudicate run。

- [ ] **步骤 5：Commit**

```powershell
git add src/core/v4/scanner.py src/core/v4/adjudicator.py src/core/v4/database.py tests/test_parallel_v4.py
git commit -m "refactor: separate candidate indexing from adjudication"
```

### 任务 6：生成工作译名并修复翻译注入

**文件：**
- 创建：`src/core/v4/target_resolver.py`
- 修改：`src/core/v4/models.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/context.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`src/core/translator.py`
- 创建：`tests/test_working_targets.py`

- [ ] **步骤 1：编写工作译名和空目标失败测试**

```python
def test_repeated_name_receives_one_working_target(database):
    seed_promoted_concept(database, "Severian", occurrences=4)
    TargetResolver(database, FakeLLM([target_response("Q01", "塞万里安")])).run()
    concept = database.concept_by_source("Severian")
    assert concept["working_target"] == "塞万里安"
    assert concept["verified_target"] == ""
    assert concept["locked"] == 0


def test_context_never_renders_empty_arrow(database, block):
    rendered = ContextBuilder(database).build(block).rendered
    assert "Severian ->  " not in rendered
    assert "核心译名: 塞万里安" in rendered
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_working_targets.py -q`

预期：FAIL，resolver 和新列尚未接入上下文。

- [ ] **步骤 3：实现工作译名响应和 resolver**

```python
class WorkingTargetDecision(StrictModel):
    concept_id: str = Field(pattern=r"^Q(?:0[1-9]|1\d|2[0-4])$")
    working_target: str = Field(min_length=1, max_length=200)
    rules: List[WorkingTargetRule] = Field(default_factory=list, max_length=6)
    confidence: float = Field(ge=0.0, le=1.0)
```

每批最多 24 个概念，输入代表性英文上下文、扫描描述和最多两个对齐旧译文段落。重复人物、地点、组织、单位及影响三个以上块的概念必须得到非空工作译名，否则返回人工处理。

- [ ] **步骤 4：修改翻译依赖语义**

有效译名为 `verified_target or working_target`。验证译名是硬约束；工作译名是全书一致性约束，可被明确 rendering rule 覆盖。过滤空目标 GlossaryItem。知识版本在翻译 run 开始时冻结；译名变化将当前批次和历史依赖块全部置为 `needs_revalidate`。

- [ ] **步骤 5：运行测试验证通过**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_working_targets.py tests/test_parallel_v4.py tests/test_parallel_v4_v2.py -q`

预期：PASS，不同翻译岛收到同一工作译名。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/target_resolver.py src/core/v4/models.py src/core/v4/database.py src/core/v4/context.py src/core/v4/pipeline.py src/core/translator.py tests/test_working_targets.py tests/test_parallel_v4.py tests/test_parallel_v4_v2.py
git commit -m "feat: freeze provisional working translations"
```

### 任务 7：实现长书线性匹配、审计归档和容量预算

**文件：**
- 创建：`src/core/v4/matcher.py`
- 创建：`src/core/v4/audit_archive.py`
- 修改：`src/core/v4/database.py`
- 修改：`src/core/v4/context.py`
- 修改：`src/core/v4/pipeline.py`
- 修改：`requirements.txt`
- 修改：`tests/test_v4_storage_scale.py`

- [ ] **步骤 1：编写规模和归档失败测试**

```python
def test_matcher_is_built_once_per_knowledge_version(database):
    seed_forms(database, 100_000, include={"Severian": "concept_severian"})
    builder = ContextBuilder(database)
    assert builder.match_concept_ids("Severian spoke.", 7) == {"concept_severian"}
    assert builder.match_concept_ids("Severian waited.", 7) == {"concept_severian"}
    assert builder.matcher_build_count == 1


def test_accepted_audit_round_trips_from_zstd_frame(tmp_path):
    archive = AuditArchive(tmp_path / "audit")
    locator = archive.append("run_1", {"request": {"x": 1}, "response": "ok"})
    assert archive.read(locator) == {"request": {"x": 1}, "response": "ok"}


def test_storage_budget_stops_before_sql_limit():
    budget = StorageBudget(source_bytes=1_000_000)
    with pytest.raises(StorageBudgetExceeded):
        budget.check(budget.active_limit + 1)
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_v4_storage_scale.py -q`

预期：FAIL，matcher、archive 和 budget 尚不存在。

- [ ] **步骤 3：实现 Aho–Corasick 缓存**

`ConceptMatcher` 对 Unicode casefold 后的 source forms 构建 trie 和 failure links，命中后检查英文词边界。`ContextBuilder` 按 `(database.path, knowledge_version)` 缓存 matcher；`V4Database.concepts_by_ids()` 只读取命中概念。

- [ ] **步骤 4：实现独立 zstd 帧和 SQL locator**

在 `requirements.txt` 增加 `zstandard>=0.23.0`。每条审计 JSON 编码为独立 zstd frame 追加到 `audit/<stage>_<run_id>.jsonl.zst`，locator 保存相对路径、帧偏移、压缩长度和 SHA-256。schema 7 为 `audit_calls` 增加相应列；失败与人工调用仍在 SQL 保留全文。

安装命令：`.\.venv\Scripts\python.exe -m pip install "zstandard>=0.23.0"`

- [ ] **步骤 5：实现活动数据库预算**

活动上限为 `40 * source_bytes + 64 * 1024**2`。批次提交前检查预计页数；超限抛 `StorageBudgetExceeded` 并回滚，不截断证据。

- [ ] **步骤 6：运行测试验证通过**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_v4_storage_scale.py tests/test_working_targets.py tests/test_parallel_v4.py -q`

预期：PASS，十万词形只构建一次 matcher，归档可按偏移读取，预算失败无半批数据。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/matcher.py src/core/v4/audit_archive.py src/core/v4/database.py src/core/v4/context.py src/core/v4/pipeline.py requirements.txt tests/test_v4_storage_scale.py
git commit -m "feat: bound storage and index active concepts"
```

### 任务 8：增加 CLI、完整验证并运行 Flash 小样

**文件：**
- 修改：`main.py`
- 修改：`tests/test_parallel_v4.py`
- 运行产物：`projects/new_sun_omnibus/artifacts/parallel_v4/book.db`

- [ ] **步骤 1：编写 CLI 解析和重置 token 失败测试**

```python
def test_reset_requires_current_preview_token(cli):
    preview = cli("reset-scan-v4", "book", "--preview")
    assert cli("reset-scan-v4", "book", "--confirm", "wrong").exit_code == 1
    assert cli("reset-scan-v4", "book", "--confirm", preview.json["token"]).exit_code == 0
```

- [ ] **步骤 2：运行测试验证失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py -q`

预期：FAIL，CLI 不认识新命令。

- [ ] **步骤 3：增加命令并验证失败短路**

```text
scan-v4             本地索引
adjudicate-v4       DeepSeek 裁决
resolve-targets-v4  生成 working_target
prepare-v4          依次执行前三步
reset-scan-v4       --preview 或 --confirm TOKEN
```

`prepare-v4` 支持 `--max-blocks`、`--max-clusters`、`--max-attempts`、`--audit-mode`；任一阶段失败时停止。

- [ ] **步骤 4：运行全部自动化验证**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py tests/test_parallel_v4_v2.py tests/test_pipeline_v3.py tests/test_candidate_lattice.py tests/test_candidate_adjudicator.py tests/test_working_targets.py tests/test_v4_storage_scale.py -q
.\.venv\Scripts\python.exe -m compileall -q src
git diff --check
```

预期：全部通过。整仓无参数 pytest 继续排除既有的 `test_thinking_stream.py` 路径假设和要求 `ARK_API_KEY` 的 `test_foila_logic.py`。

- [ ] **步骤 5：预览并确认清理旧扫描派生数据**

```powershell
$preview = .\.venv\Scripts\python.exe main.py reset-scan-v4 new_sun_omnibus --preview | ConvertFrom-Json
.\.venv\Scripts\python.exe main.py reset-scan-v4 new_sun_omnibus --confirm $preview.token
```

预期：源块 510、baseline 和人工锁定数据不变；旧候选、未锁定概念、扫描验证任务和扫描审计归零。

- [ ] **步骤 6：用 DeepSeek Flash 跑相同前八块**

运行：`.\.venv\Scripts\python.exe main.py prepare-v4 new_sun_omnibus --max-blocks 8 --max-attempts 2 --audit-mode full`

预期：两块前置材料本地跳过，六块进入裁决；未知 ID 为 0。

- [ ] **步骤 7：执行 SQL 和真实语义回归审计**

报告 `integrity_check`、外键、偏移、五类 verdict、工作译名覆盖、调用耗时，并确认：

```text
Drotte and Roche 不是单一 person concept
Corpse Door 存在时 Corpse 不成为最终地点 concept
Night 不被无证据强制登记为 work
Severian 在正式翻译前只有一个 working_target
```

文学类型允许 `defer`，结构错误不得进入工作词库。

- [ ] **步骤 8：小样通过后清理旧快照并 Commit**

删除前列出并验证绝对路径只位于 `projects/new_sun_omnibus/artifacts/parallel_v4/`。仅删除 `book.v4.1-*.db` 和 `book.v4.2-*.db`；保留 `book.before-flash-kb-pilot.db` 到用户确认新小样。

```powershell
git add main.py tests/test_parallel_v4.py
git commit -m "feat: orchestrate candidate preparation stages"
.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py tests/test_parallel_v4_v2.py tests/test_pipeline_v3.py tests/test_candidate_lattice.py tests/test_candidate_adjudicator.py tests/test_working_targets.py tests/test_v4_storage_scale.py -q
git status --short
git log -10 --oneline
```

预期：测试全绿；运行产物被忽略；源代码工作树干净。
