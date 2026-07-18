# 候选裁决保守并行加速实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在不改变 12 簇批次内容和双重裁决语义的前提下，让候选裁决以 2→4 路自适应并发运行，并用《新日之书》新增 16 个精确文本块验证速度和知识库完整性。

**架构：** 模型线程只生成不可变的批次结果和内存审计记录；主协调线程按稳定批次顺序，在单个 SQLite 事务中写入审计、裁决、概念和租约状态。每个并发批次使用独立模型客户端；协调器根据 429 或临时网络错误降低下一波并发，在稳定波次逐步恢复。

**技术栈：** Python 3.14、`concurrent.futures.ThreadPoolExecutor`、SQLite、Pydantic 2、DeepSeek OpenAI 兼容接口、pytest。

---

## 文件结构

- 修改 `src/core/v4/adjudicator.py`：增加批次 outcome、内存审计、模型客户端工厂、并发波协调、自适应并发和运行指标。
- 修改 `src/core/v4/database.py`：让审计记录与对应裁决在同一个受管事务中原子提交。
- 修改 `main.py`：为 `adjudicate-v4` 与 `prepare-v4` 增加并发参数，并为每个并发任务创建独立 `LLMManager`。
- 修改 `tests/test_candidate_adjudicator.py`：覆盖内存审计缓冲和原有直接调用兼容性。
- 修改 `tests/test_scan_adjudication_split.py`：覆盖真实并发、稳定提交顺序、单写入、限流降速、协议失败隔离和 `max_clusters` 边界。
- 修改 `tests/test_parallel_v4.py`：覆盖 CLI 参数校验与透传。
- 运行产物 `projects/new_sun_omnibus/artifacts/parallel_v4/book.db`：保留全局 0–7 块，追加全局 8–23 块小样；该产物不提交到 Git。

### 任务 1：把模型调用改为可缓冲的纯批次结果

**文件：**
- 修改：`src/core/v4/adjudicator.py`
- 修改：`tests/test_candidate_adjudicator.py`

- [ ] **步骤 1：编写失败的内存审计测试**

```python
def test_batch_outcome_buffers_audits_without_worker_database_writes():
    source = "Alpha waited."
    item = cluster("cluster-a", [candidate("candidate-a", source, 0, 5)])
    database = ExplodingDatabase()
    worker = V4Adjudicator(FakeLLM([response()]), max_attempts=1)

    outcome = worker._adjudicate_batch_outcome(
        3, (item,), {"block-1": source}, knowledge_version=7
    )

    assert outcome.batch_index == 3
    assert outcome.results[0].verdict == "promote"
    assert len(outcome.audit_attempts) == 1
    assert outcome.audit_attempts[0].accepted is True
    assert database.calls == 0
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py::test_batch_outcome_buffers_audits_without_worker_database_writes -q`

预期：FAIL，`_adjudicate_batch_outcome` 尚不存在。

- [ ] **步骤 3：增加批次与审计数据契约**

在 `adjudicator.py` 增加：

```python
@dataclass(frozen=True)
class AdjudicationAuditAttempt:
    messages: tuple[Mapping[str, str], ...]
    raw_response: str
    parsed: Optional[Mapping[str, Any]]
    accepted: bool
    attempt: int
    elapsed_ms: int
    error: Optional[str]
    error_kind: Optional[str]
    model: str
    knowledge_version: int


@dataclass(frozen=True)
class AdjudicationBatchOutcome:
    batch_index: int
    results: tuple[AdjudicationResult, ...]
    audit_attempts: tuple[AdjudicationAuditAttempt, ...]
    model_calls: int
    model_elapsed_ms_sum: int
    error_kinds: tuple[str, ...]
```

把 `_call_round()` 改为返回“解析结果 + 本轮审计尝试”，不直接访问数据库。`_adjudicate_batch_outcome()` 负责执行现有第一轮、风险分流和第二轮，并汇总全部审计。协议校验、重试次数、短别名和 `AdjudicationResult` 内容保持原样。

- [ ] **步骤 4：保留 `adjudicate()` 的直接调用兼容性**

`adjudicate()` 继续返回 `tuple[AdjudicationResult, ...]`。若调用者提供 `run_id` 和 `database`，则在当前调用线程按顺序写入 outcome 的审计记录，维持既有测试行为；`run()` 的并发路径不使用这一即时写入入口。

- [ ] **步骤 5：运行测试验证通过**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_candidate_adjudicator.py -q`

预期：PASS，包括原有“失败尝试与成功尝试各有一条审计、审计不泄露稳定 ID”的测试。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/adjudicator.py tests/test_candidate_adjudicator.py
git commit -m "refactor: buffer adjudication batch outcomes"
```

### 任务 2：原子提交批次审计与裁决

**文件：**
- 修改：`src/core/v4/database.py`
- 修改：`tests/test_scan_adjudication_split.py`

- [ ] **步骤 1：编写失败的原子提交测试**

```python
def test_commit_adjudications_persists_audits_in_same_transaction(database):
    seed_one_leased_cluster(database, run_id="adjudicate-run")
    audit = audit_attempt(accepted=True, knowledge_version=0)

    with pytest.raises(RuntimeError, match="forced adjudication failure"):
        database.commit_adjudications(
            "adjudicate-run",
            [promote_result()],
            audit_attempts=[audit],
            require_lease=True,
            _test_fail_after_audits=True,
        )

    assert scalar(database, "SELECT COUNT(*) FROM audit_calls") == 0
    assert scalar(database, "SELECT COUNT(*) FROM candidate_adjudications") == 0
```

实际测试使用 mock/patch 在 `record_audit_call(..., connection=connection)` 之后抛出异常，不给生产接口增加 `_test_fail_after_audits` 参数。

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_scan_adjudication_split.py::test_commit_adjudications_persists_audits_in_same_transaction -q`

预期：FAIL，`commit_adjudications()` 不接受 `audit_attempts`。

- [ ] **步骤 3：扩展数据库提交接口**

将签名扩展为：

```python
def commit_adjudications(
    self,
    run_id: str,
    results: Sequence[Any],
    *,
    audit_attempts: Sequence[Any] = (),
    require_lease: bool = False,
    finalize_run_status: Optional[str] = None,
) -> Dict[str, Any]:
```

在现有 `with self.transaction() as connection:` 内，先按传入顺序调用 `record_audit_call(..., connection=connection)`，再执行租约校验与现有裁决写入。审计字段从 dataclass 属性读取，`request` 仍包含 `audit_mode`；事务回滚时 zstd 审计帧和 SQL locator 一同回滚。

- [ ] **步骤 4：验证成功、失败审计与租约回滚**

增加测试确认：成功批次有可读取的归档定位器；协议失败审计保留内联错误；租约校验失败时两者均不写入。

- [ ] **步骤 5：运行数据库回归测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_scan_adjudication_split.py tests/test_v4_storage_scale.py -q`

预期：PASS，`PRAGMA integrity_check` 为 `ok`，外键违规为 0。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/database.py tests/test_scan_adjudication_split.py
git commit -m "feat: atomically persist adjudication audits"
```

### 任务 3：实现稳定批次的并发波协调器

**文件：**
- 修改：`src/core/v4/adjudicator.py`
- 修改：`tests/test_scan_adjudication_split.py`

- [ ] **步骤 1：编写真并发和稳定顺序失败测试**

```python
def test_run_executes_four_batches_concurrently_and_commits_in_order(database):
    seed_pending_clusters(database, count=48)
    tracker = ConcurrentLLMTracker(expected=4, delays={0: 0.20, 1: 0.15, 2: 0.10, 3: 0.01})
    adjudicator = V4Adjudicator(
        tracker.first_client(), database=database, llm_factory=tracker.new_client
    )

    result = adjudicator.run(initial_workers=4, max_workers=4)

    assert tracker.peak == 4
    assert result["peak_workers"] == 4
    assert persisted_cluster_order(database, result["run_id"]) == sorted_cluster_ids(database)
    assert set(database_write_thread_ids(database)) == {threading.get_ident()}
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_scan_adjudication_split.py::test_run_executes_four_batches_concurrently_and_commits_in_order -q`

预期：FAIL，构造器不接受 `llm_factory`，`run()` 不接受 worker 参数。

- [ ] **步骤 3：增加模型客户端工厂**

`V4Adjudicator.__init__()` 增加可选 `llm_factory: Optional[Callable[[], Any]]`。`run()` 每提交一个批次任务就调用一次工厂，并创建只共享只读配置的工作裁决器：

```python
def _new_worker(self) -> "V4Adjudicator":
    llm = self.llm_factory() if self.llm_factory else self.llm
    return V4Adjudicator(
        llm,
        max_attempts=self.max_attempts,
        max_tokens=self.max_tokens,
        audit_mode=self.audit_mode,
    )
```

当 `max_workers > 1` 且没有提供 `llm_factory` 时，明确抛出 `ValueError`，防止误共享可变模型客户端；`max_workers=1` 保持向后兼容。

- [ ] **步骤 4：实现并发波**

`run(initial_workers=2, max_workers=4, max_clusters=None)` 每波领取 `min(remaining, workers * 12)` 簇，保持数据库返回顺序切片。通过 `ThreadPoolExecutor(max_workers=workers)` 执行每个批次的 `_adjudicate_batch_outcome()`；等待整波完成后按 `batch_index` 排序，逐批调用带 `audit_attempts` 的 `commit_adjudications()`。

最后一批提交时才传入 `finalize_run_status`。只有成功提交的结果计入 `adjudicated/failed/deferred/concepts`。`remaining` 在成功领取后扣除，确保不会超过 `max_clusters`。

- [ ] **步骤 5：增加异常隔离测试**

覆盖一个 worker 抛未知异常时：同波已经产生合法 outcome 的批次按稳定顺序提交，运行标为 `failed`，异常批次不生成伪裁决；重新运行可领取其恢复后的候选。

- [ ] **步骤 6：运行并发回归测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_scan_adjudication_split.py -q`

预期：PASS，4 路并发成立，单次模型请求仍不超过 12 簇，第二轮不跨批。

- [ ] **步骤 7：Commit**

```powershell
git add src/core/v4/adjudicator.py tests/test_scan_adjudication_split.py
git commit -m "feat: adjudicate stable batches concurrently"
```

### 任务 4：增加自适应降速和运行指标

**文件：**
- 修改：`src/core/v4/adjudicator.py`
- 修改：`tests/test_scan_adjudication_split.py`

- [ ] **步骤 1：编写 429、超时和恢复失败测试**

```python
def test_worker_count_halves_after_rate_limit_and_recovers(database):
    seed_pending_clusters(database, count=132)
    factory = ScriptedFactory(first_wave_error=RateLimitError("429"))

    result = V4Adjudicator(
        factory(), database=database, llm_factory=factory
    ).run(initial_workers=4, max_workers=4)

    assert result["worker_history"][:3] == [4, 2, 3]
    assert result["rate_limit_events"] == 1
    assert result["worker_reductions"] == 1
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_scan_adjudication_split.py::test_worker_count_halves_after_rate_limit_and_recovers -q`

预期：FAIL，运行摘要无自适应字段。

- [ ] **步骤 3：实现错误分类**

只根据异常类名、HTTP 状态码和错误文本进行通用分类，不包含小说词汇特例：

```python
def _external_error_kind(exc: Exception) -> Optional[str]:
    status = getattr(exc, "status_code", None)
    text = f"{type(exc).__name__}: {exc}".lower()
    if status == 429 or "rate limit" in text or "too many requests" in text:
        return "rate_limit"
    if isinstance(exc, TimeoutError) or "timeout" in text or "timed out" in text:
        return "timeout"
    if "connection" in text or "temporarily unavailable" in text:
        return "transient_network"
    return None
```

异常尝试仍进入现有重试；最终 outcome 汇总实际出现的 `error_kind`。协议解析错误的 `error_kind` 为 `None`。

- [ ] **步骤 4：实现下一波并发调整与指标**

一波含 `rate_limit` 时并发减半；含 `timeout/transient_network` 时减一；整波无外部错误时加一，始终限制在 `[1, max_workers]`。运行摘要增加设计规格中的并发、波次、调用、错误和耗时字段；额外保留 `worker_history` 方便测试和现场诊断。

- [ ] **步骤 5：运行自适应与边界测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_scan_adjudication_split.py -q`

预期：PASS；`max_clusters=0` 不调用模型，非 12 倍数不多领取，成功批次不因同波限流而重复。

- [ ] **步骤 6：Commit**

```powershell
git add src/core/v4/adjudicator.py tests/test_scan_adjudication_split.py
git commit -m "feat: adapt adjudication concurrency to service pressure"
```

### 任务 5：接入 CLI 并验证串行兼容

**文件：**
- 修改：`main.py`
- 修改：`tests/test_parallel_v4.py`

- [ ] **步骤 1：编写 CLI 参数失败测试**

```python
def test_adjudicate_and_prepare_forward_worker_limits(self):
    exit_code, output = self.invoke(
        "adjudicate-v4", "book", "--initial-workers", "3", "--max-workers", "4"
    )
    self.assertEqual(exit_code, 0)
    self.assertEqual(self.adjudicator_run_kwargs["initial_workers"], 3)
    self.assertEqual(self.adjudicator_run_kwargs["max_workers"], 4)


def test_worker_bounds_reject_inverted_range(self):
    exit_code, output = self.invoke(
        "adjudicate-v4", "book", "--initial-workers", "4", "--max-workers", "2"
    )
    self.assertEqual(exit_code, 1)
    self.assertIn("initial_workers", output)
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py -q`

预期：FAIL，裁决命令尚无 worker 参数。

- [ ] **步骤 3：接入独立客户端工厂和参数**

`_run_adjudicate_v4()` 使用：

```python
llm_config = config["llm"]
adjudicator = V4Adjudicator(
    LLMManager(llm_config),
    llm_factory=lambda: LLMManager(llm_config),
    database=database,
    max_attempts=args.max_attempts,
    audit_mode=_preparation_audit_mode(args, config),
)
return adjudicator.run(
    max_clusters=getattr(args, "max_clusters", None),
    initial_workers=args.initial_workers,
    max_workers=args.max_workers,
)
```

为 `adjudicate-v4` 和 `prepare-v4` 都增加 `_positive_int` 类型的 `--initial-workers`（默认 2）与 `--max-workers`（默认 4）。在开始迁移或模型调用前校验起始值不大于上限，错误以现有 JSON stage error 输出。

- [ ] **步骤 4：运行 CLI 与串行等价测试**

运行：`.\.venv\Scripts\python.exe -m pytest tests/test_parallel_v4.py tests/test_candidate_adjudicator.py tests/test_scan_adjudication_split.py -q`

预期：PASS；显式 `--initial-workers 1 --max-workers 1` 的结果与原串行固定响应基线一致。

- [ ] **步骤 5：Commit**

```powershell
git add main.py tests/test_parallel_v4.py
git commit -m "feat: configure parallel candidate adjudication"
```

### 任务 6：完整验证并运行《新日之书》16 块小样

**文件：**
- 只读/运行产物：`projects/new_sun_omnibus/artifacts/parallel_v4/book.db`
- 创建运行备份：`projects/new_sun_omnibus/artifacts/parallel_v4/book.before-parallel-adjudication-pilot.db`

- [ ] **步骤 1：运行全部自动化验证**

```powershell
.\.venv\Scripts\python.exe -m pytest tests --ignore=tests/test_foila_logic.py -q
.\.venv\Scripts\python.exe -m compileall -q src main.py
git diff --check
```

预期：204 个以上测试全部通过，既有子测试全部通过；编译和 diff 检查无输出。`tests/test_foila_logic.py` 在收集阶段强制要求与本项目无关的 `ARK_API_KEY`，明确排除且单独报告；根目录的 `test_thinking_stream.py` 也不混入本次结论。

- [ ] **步骤 2：核对并备份活动数据库**

解析项目迁移结果列出的 510 个文本块，打印全局 8–23 块的 `global_index`、`id`、`legacy_id`、章节和块类型。确认绝对路径位于 `D:\llm\小说翻译\projects\new_sun_omnibus\artifacts\parallel_v4\` 后，用 `Copy-Item -LiteralPath` 创建上述备份；不得删除现有备份。

- [ ] **步骤 3：仅扫描全局 8–23 块**

根据步骤 2 得到的 16 个稳定块 ID，逐个传入。以下命令直接从活动数据库按全局序号读取它们并构造 CLI 参数：

```powershell
$databasePath = 'projects\new_sun_omnibus\artifacts\parallel_v4\book.db'
$blockIds = .\.venv\Scripts\python.exe -c "import sqlite3; c=sqlite3.connect(r'$databasePath'); print(chr(10).join(r[0] for r in c.execute('SELECT id FROM blocks WHERE global_index BETWEEN 8 AND 23 ORDER BY global_index')))"
$blockArgs = @()
foreach ($blockId in $blockIds) { $blockArgs += @('--block', $blockId) }
& .\.venv\Scripts\python.exe main.py scan-v4 new_sun_omnibus --initial-workers 2 --max-workers 4 --max-attempts 2 --audit-mode full @blockArgs
```

预期 `$blockIds.Count -eq 16`、`indexed=16`，且结果返回的 `block_ids` 与请求集合完全一致。

- [ ] **步骤 4：并行裁决新增 pending 簇**

```powershell
.\.venv\Scripts\python.exe main.py adjudicate-v4 new_sun_omnibus --initial-workers 2 --max-workers 4 --max-attempts 2 --audit-mode full
```

记录 JSON 摘要和墙钟时间。预期实际 `peak_workers >= 2`；无持续限流时 `model_elapsed_ms_sum / elapsed_ms >= 2.5`。

- [ ] **步骤 5：生成工作译名并执行 SQL/审计检查**

```powershell
.\.venv\Scripts\python.exe main.py resolve-targets-v4 new_sun_omnibus --max-attempts 2 --audit-mode full
```

随后检查：`PRAGMA integrity_check='ok'`、`PRAGMA foreign_key_check` 为 0 行、候选原文偏移不匹配为 0、所有审计 locator 可读取且 SHA-256 正确、必需工作译名覆盖率为 100%。不开始 `translate-v4`。

- [ ] **步骤 6：复核真实语义回归并估算全书耗时**

报告 0–23 块累计候选、簇、五类 verdict、概念、工作译名和 defer 原因；确认：

```text
Drotte and Roche 不成为单一人物概念
Corpse 不替代完整 Corpse Door
Night 在证据不足时不强制登记为 work
Severian 仍只有一个有效工作译名“塞万里安”
```

使用小样 `elapsed_ms`、`model_elapsed_ms_sum`、pending 总簇数和全书 3,770 簇估算完整预处理时间，并区分无持续限流与观察到限流两种情形。

- [ ] **步骤 7：最终验证与 Commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests --ignore=tests/test_foila_logic.py -q
.\.venv\Scripts\python.exe -m compileall -q src main.py
git diff --check
git status --short
git log -8 --oneline
```

预期：测试全绿，运行产物被 Git 忽略，工作树干净。若实施过程中测试提交已经覆盖全部源代码，本步骤不创建空提交。
