# V5 无损工程加固实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用可证明无损的源文本账本、版本化运行状态、独立审计和受限恢复机制，消除 V5 中静默漏文、覆盖、乱序、竞态、串版本和错误恢复风险。

**架构：** Python 项目入口只负责保存原始载荷并产出规范源文件清单；TypeScript V5 从规范源建立位置型 blocks、窗口计划和独立 Auditor。翻译运行使用 schema v2、不可变知识快照、顺序晋升和同 run 严格导出；确定性恢复优先，只有策略不唯一时才允许 Recovery Pi 通过类型化工具尝试一次。

**技术栈：** Python 3.14、pytest、Node.js 24、TypeScript 7、`node:sqlite`、Node test runner、Pi Agent Kernel、SQLite WAL。

---

## 文件结构与职责

### Python 外围

- 创建 `src/core/source_ledger.py`：保存原文件、生成 canonical source、记录提取与规范化清单。
- 修改 `src/core/project_manager.py`：项目初始化先建立 source ledger，再运行兼容预处理。
- 修改 `src/core/preprocessor.py`：暴露带格式与编码信息的 `SourceDocument`，不再由调用方猜测来源。
- 修改 `src/core/v5_exporter.py`：读取 schema v2 的指定 translation run，并生成可核验 EPUB lineage。
- 创建 `tests/test_source_ledger.py`：原始字节、canonical hash、编码和重建测试。
- 修改 `tests/test_v5_exporter.py`：同 run、缺块、source version 和 lineage 测试。

### TypeScript 源账本与规划

- 创建 `translator-v5/src/source/types.ts`：source version、区间、结构标注、lossless block 和审计类型。
- 创建 `translator-v5/src/source/source-ledger.ts`：加载并验证 Python 清单和 canonical source。
- 创建 `translator-v5/src/source/block-builder.ts`：按连续位置生成无重叠 blocks 和平铺保底计划。
- 创建 `translator-v5/src/source/structure-annotator.ts`：只产生位置型语义边界，不拥有正文。
- 创建 `translator-v5/src/source/auditor.ts`：独立重算覆盖、顺序与哈希。
- 创建 `translator-v5/test/source-ledger.test.ts`：清单、覆盖和篡改测试。
- 创建 `translator-v5/test/block-builder.property.test.ts`：重复标题、无章节、混合换行和长段落属性测试。
- 修改 `translator-v5/src/fullbook/window-planner.ts`：代价型 logical window 规划。
- 创建 `translator-v5/src/fullbook/request-batcher.ts`：把极短 logical windows 打包为 physical request。
- 修改 `translator-v5/test/window-planner.test.ts`：边界代价和微批测试。

### TypeScript 状态、运行与恢复

- 创建 `translator-v5/src/storage/book-schema-v2.ts`：集中维护 schema v2 DDL。
- 创建 `translator-v5/src/storage/lossless-book-store.ts`：source/run/window/translation/recovery 的事务 API。
- 创建 `translator-v5/test/lossless-book-store.test.ts`：约束、回滚、版本隔离和顺序晋升测试。
- 创建 `translator-v5/src/knowledge/knowledge-store.ts`：追加式知识生命周期与活动视图。
- 创建 `translator-v5/src/knowledge/snapshot.ts`：不可变知识快照和投影哈希。
- 创建 `translator-v5/test/knowledge-snapshot.test.ts`：并行快照、冲突降级和可见性测试。
- 创建 `translator-v5/src/fullbook/commit-coordinator.ts`：并行暂存、按 ordinal 顺序晋升。
- 创建 `translator-v5/src/agents/translation-batch.ts`：单次模型会话翻译多个微型 logical windows。
- 修改 `translator-v5/src/fullbook/book-context.ts`：正式全书模式从 source ledger 取 blocks，V4 只提供可选旧词汇。
- 修改 `translator-v5/src/fullbook/book-runner.ts`：doctor 强制关卡、schema v2、微批、快照和顺序提交。
- 修改 `translator-v5/test/book-runner.test.ts`：无损运行、逆序完成和微批隔离。
- 创建 `translator-v5/src/recovery/types.ts`：事故、策略、尝试和状态类型。
- 创建 `translator-v5/src/recovery/registry.ts`：错误码到允许策略的唯一声明式注册表。
- 创建 `translator-v5/src/recovery/recovery-engine.ts`：确定性恢复、影子版本、审计和晋升。
- 创建 `translator-v5/src/agents/recovery-agent.ts`：最多一轮的受限 Recovery Pi。
- 创建 `translator-v5/src/tools/recovery-tools.ts`：只读检查与枚举恢复工具。
- 创建 `translator-v5/test/recovery-engine.test.ts`：自动降级、Pi 边界、失败回滚测试。

### CLI、导出与端到端验证

- 修改 `translator-v5/src/cli.ts`：增加 `doctor`、`audit`、`recover`、`verify-export` 和 source manifest 参数。
- 修改 `translator-v5/src/report.ts`：partial 标识、run metadata 和 lineage sidecar。
- 创建 `translator-v5/src/export/export-verifier.ts`：TXT/EPUB lineage 与数据库反查。
- 创建 `translator-v5/src/migration/v1-importer.ts`：把旧 V5 译文按唯一 source span 显式导入独立 migration run。
- 修改 `translator-v5/test/cli.test.ts`：新命令解析与必要参数。
- 创建 `translator-v5/test/export-verifier.test.ts`：混合 run、缺块和篡改导出测试。
- 创建 `translator-v5/test/v1-importer.test.ts`：唯一匹配晋升、重复文本隔离和旧版本 provenance 测试。
- 创建 `translator-v5/test/fault-injection.test.ts`：事务阶段故障、重启和一致终态。

---

### 任务 1：保存原始载荷并生成规范源清单

**文件：**
- 创建：`src/core/source_ledger.py`
- 修改：`src/core/preprocessor.py:56-130`
- 修改：`src/core/project_manager.py:17-24,66-148`
- 创建：`tests/test_source_ledger.py`

- [x] **步骤 1：编写原始字节和 canonical 清单的失败测试**

```python
def test_project_preserves_raw_source_and_writes_verified_manifest(tmp_path):
    original = tmp_path / "novel.txt"
    original.write_bytes(b"\xef\xbb\xbfBook One\r\n\r\nChapter I\r\nText.\r\n")
    project = ProjectManager(str(tmp_path / "projects")).create_project(
        "novel", str(original), overlap_sentences=0
    )
    manifest = json.loads(project.source_manifest_file.read_text(encoding="utf-8"))
    assert project.raw_source_file.read_bytes() == original.read_bytes()
    assert manifest["schema_version"] == "v5-source-ledger-1"
    assert manifest["raw_sha256"] == hashlib.sha256(original.read_bytes()).hexdigest()
    assert manifest["canonical_sha256"] == hashlib.sha256(
        project.source_file.read_bytes()
    ).hexdigest()
    assert manifest["canonical_chars"] == len(project.source_file.read_text(encoding="utf-8"))
    assert manifest["canonical_segments"] == [{
        "canonical_start": 0,
        "canonical_end": manifest["canonical_chars"],
        "origin_kind": "decoded_bytes",
        "origin_ref": "source/original.txt",
        "raw_start": 3,
        "raw_end": len(original.read_bytes()),
        "transformation": "decode+newline-normalize",
    }]
    assert manifest["excluded_raw_ranges"] == [{
        "raw_start": 0, "raw_end": 3, "policy": "UTF8_BOM"
    }]
```

- [x] **步骤 2：运行定向测试确认因 source ledger API 不存在而失败**

运行：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest -q tests/test_source_ledger.py
```

预期：FAIL，`Project` 没有 `raw_source_file` 或 `source_manifest_file`。

- [x] **步骤 3：实现格式感知的 `SourceDocument` 和清单写入器**

在 `preprocessor.py` 定义并让 `load_document()` 返回：

```python
@dataclass(frozen=True)
class SourceDocument:
    text: str
    source_format: str
    encoding: str
    extractor: str
    canonical_segments: tuple[dict, ...]
    excluded_raw_ranges: tuple[dict, ...]

def load_document(self, file_path: str) -> SourceDocument:
    path = Path(file_path)
    if path.suffix.lower() in {".txt", ".md"}:
        text, encoding = self._load_plain_text_with_encoding(path)
        return SourceDocument(
            text, path.suffix.lower(), encoding, "plain-text-v1",
            canonical_segments=(plain_text_segment(path, text, encoding),),
            excluded_raw_ranges=tuple(detected_bom_ranges(path)),
        )
    if path.suffix.lower() == ".epub":
        document = EpubReader.read(path)
        return SourceDocument(
            self._clean_text(EpubReader.to_chapter_marked_text(document)),
            ".epub", "container", "epub-spine-v1",
            canonical_segments=tuple(epub_spine_segments(document)),
            excluded_raw_ranges=(container_metadata_range(path, "EPUB_NON_SPINE_DATA"),),
        )
    if path.suffix.lower() == ".docx":
        text, segments = self._load_docx_with_segments(path)
        return SourceDocument(
            text, ".docx", "container", "docx-paragraph-v1",
            canonical_segments=tuple(segments),
            excluded_raw_ranges=(container_metadata_range(path, "DOCX_NON_DOCUMENT_DATA"),),
        )
    raise ValueError(f"不支持的文件格式: {path.suffix.lower()}")
```

在 `source_ledger.py` 实现不可变写入：

```python
def create_source_ledger(source: Path, project_dir: Path, document: SourceDocument) -> dict:
    raw = source.read_bytes()
    raw_target = project_dir / "source" / f"original{source.suffix.lower()}"
    raw_target.parent.mkdir(parents=True, exist_ok=True)
    raw_target.write_bytes(raw)
    canonical = document.text.replace("\r\n", "\n").replace("\r", "\n")
    canonical_target = project_dir / "source.txt"
    canonical_target.write_text(canonical, encoding="utf-8", newline="\n")
    manifest = {
        "schema_version": "v5-source-ledger-1",
        "raw_path": str(raw_target.relative_to(project_dir)),
        "raw_size": len(raw),
        "raw_sha256": hashlib.sha256(raw).hexdigest(),
        "source_format": document.source_format,
        "encoding": document.encoding,
        "extractor": document.extractor,
        "canonical_path": "source.txt",
        "canonical_chars": len(canonical),
        "canonical_sha256": hashlib.sha256(canonical_target.read_bytes()).hexdigest(),
        "canonical_segments": list(document.canonical_segments),
        "excluded_raw_ranges": list(document.excluded_raw_ranges),
    }
    (project_dir / "source_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest
```

- [x] **步骤 4：接入 `ProjectManager` 并验证原始文件与 canonical 文件分离**

`Project` 增加 `raw_source_file`（从 manifest 解析）和 `source_manifest_file`；`create_project()` 先调用 `load_document()`，再调用 `create_source_ledger()`，兼容 artifacts 继续读取 `source.txt`。失败时仍删除未完成项目目录。

纯文本 canonicalization 只允许解码、移除已登记 BOM 和换行统一；不再静默 `strip()` 每行或折叠空行。EPUB/DOCX segment 的 `origin_ref` 分别使用 spine member 路径和文档段落序号；容器内不参与正文提取的字节以固定 policy code 登记。canonical segments 自身必须连续覆盖 `[0, canonical_chars)`，excluded policy 只能来自代码枚举，不能接受自由文本。

- [x] **步骤 5：运行测试和 Python 正式回归**

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest -q tests/test_source_ledger.py tests/test_preprocessor_structure.py tests/test_pipeline_v3.py
```

预期：全部 PASS。

- [x] **步骤 6：Commit**

```powershell
git add src/core/source_ledger.py src/core/preprocessor.py src/core/project_manager.py tests/test_source_ledger.py
git commit -m "feat: preserve certified source ledger"
```

### 任务 2：建立位置型 blocks 与独立 Auditor

**文件：**
- 创建：`translator-v5/src/source/types.ts`
- 创建：`translator-v5/src/source/source-ledger.ts`
- 创建：`translator-v5/src/source/block-builder.ts`
- 创建：`translator-v5/src/source/structure-annotator.ts`
- 创建：`translator-v5/src/source/auditor.ts`
- 创建：`translator-v5/test/source-ledger.test.ts`
- 创建：`translator-v5/test/block-builder.property.test.ts`

- [x] **步骤 1：编写覆盖、重复标题和数据库篡改的失败测试**

```ts
test("lossless blocks cover canonical source exactly once despite duplicate chapter names", () => {
  const source = "Book One\n\nChapter I\n\nAlpha.\n\nBook Two\n\nChapter I\n\nBeta.";
  const annotations = annotateStructure(source, "source-v1");
  const blocks = buildLosslessBlocks(source, annotations, { maxSourceTokens: 8 });
  const report = auditSourceCoverage(source, blocks);
  assert.equal(report.ok, true);
  assert.equal(blocks.map((item) => item.sourceText).join(""), source);
  assert.equal(new Set(blocks.map((item) => item.id)).size, blocks.length);
  assert.equal(annotations.filter((item) => item.kind === "chapter_heading").length, 2);
});

test("auditor reports the exact first gap without using chapter ids", () => {
  const source = "Alpha.\n\nBeta.";
  const blocks = buildLosslessBlocks(source, [], { maxSourceTokens: 100 });
  const report = auditSourceCoverage(source, [{ ...blocks[0]!, canonicalEnd: 5 }]);
  assert.equal(report.ok, false);
  assert.equal(report.incidents[0]?.code, "SOURCE_SPAN_GAP");
  assert.equal(report.incidents[0]?.start, 5);
});
```

- [x] **步骤 2：运行测试确认模块不存在**

```powershell
Set-Location translator-v5
node --test --import tsx test/source-ledger.test.ts test/block-builder.property.test.ts
```

预期：FAIL，无法导入 `source/*` 模块。

- [x] **步骤 3：实现 source 类型、清单加载和位置型 ID**

```ts
export interface LosslessBlock {
  id: string;
  sourceVersion: string;
  canonicalStart: number;
  canonicalEnd: number;
  sourceText: string;
  sourceHash: string;
  globalIndex: number;
  tokenCount: number;
  structureId: string | null;
  structureTitle: string | null;
}

export function blockId(sourceVersion: string, start: number, end: number, text: string): string {
  return `block-${createHash("sha256")
    .update(`${sourceVersion}\0${start}\0${end}\0${sha256(text)}`)
    .digest("hex").slice(0, 20)}`;
}
```

`SourceLedger.open(manifestPath)` 必须核对 raw 文件大小/hash、canonical 文件 hash/字符数和 manifest schema；不一致时抛出带稳定错误码的 `SourceIntegrityError`。
它还必须独立检查 `canonical_segments` 连续覆盖 `[0, canonical_chars)`，以及 `excluded_raw_ranges` 的 policy 属于允许枚举。清单中的范围缺口、重叠、越界或未知 policy 在 block builder 运行前直接失败。

- [x] **步骤 4：实现只标注位置的结构解析和平铺保底 block builder**

结构解析器只返回 `{ id, kind, start, end, title, boundaryWeight }`。block builder 以空行和句子末尾作为候选切点，任何切法都使用连续 `[cursor, next)` 区间；最后一个区间必须结束于 `source.length`。章节识别结果只影响 `structureId` 与切点代价。

- [x] **步骤 5：实现不复用 builder 判断函数的 Auditor**

```ts
export function auditSourceCoverage(source: string, input: readonly LosslessBlock[]): AuditReport {
  const blocks = [...input].sort((a, b) => a.canonicalStart - b.canonicalStart);
  const incidents: AuditIncident[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.canonicalStart > cursor) incidents.push(gap(cursor, block.canonicalStart));
    if (block.canonicalStart < cursor) incidents.push(overlap(block.canonicalStart, cursor));
    const actual = source.slice(block.canonicalStart, block.canonicalEnd);
    if (actual !== block.sourceText || sha256(actual) !== block.sourceHash) {
      incidents.push(hashMismatch(block));
    }
    cursor = Math.max(cursor, block.canonicalEnd);
  }
  if (cursor < source.length) incidents.push(gap(cursor, source.length));
  return { ok: incidents.length === 0, coveredChars: cursor, incidents };
}
```

- [x] **步骤 6：增加 200 个固定种子的生成样本**

使用测试内置的 xorshift32 生成重复标题、空标题、混合换行、Unicode、极短章和超长单段；每个样本断言 blocks 拼接精确等于 canonical source、区间连续且 ID 唯一。不要增加外部 property-test 依赖。

- [x] **步骤 7：运行测试、typecheck 并 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx --test-name-pattern="lossless|auditor|property" test/source-ledger.test.ts test/block-builder.property.test.ts
npm run typecheck
git add src/source test/source-ledger.test.ts test/block-builder.property.test.ts
git commit -m "feat: build and audit lossless source blocks"
```

### 任务 3：实现代价型窗口和物理微批计划

**文件：**
- 修改：`translator-v5/src/fullbook/types.ts`
- 修改：`translator-v5/src/fullbook/window-planner.ts`
- 创建：`translator-v5/src/fullbook/request-batcher.ts`
- 修改：`translator-v5/test/window-planner.test.ts`

- [x] **步骤 1：编写语义边界和微批的失败测试**

```ts
test("planner balances text size but strongly prefers chapter boundaries", () => {
  const blocks = fixtureBlocks([700, 700, 700, 700], ["ch1", "ch1", "ch2", "ch2"]);
  const windows = planBookWindows(blocks, { targetSourceTokens: 1_600, maxSourceTokens: 2_600 });
  assert.deepEqual(windows.map((item) => item.blockIds.length), [2, 2]);
});

test("request batcher packs tiny logical windows without merging their identities", () => {
  const requests = packPhysicalRequests(fixtureWindows([1, 12, 2_000]), {
    tinyWindowTokens: 64, maxRequestTokens: 2_600, maxWindowsPerRequest: 6,
  });
  assert.deepEqual(requests.map((item) => item.windows.length), [2, 1]);
  assert.equal(new Set(requests.flatMap((r) => r.windows.map((w) => w.windowId))).size, 3);
});
```

- [x] **步骤 2：运行定向测试确认新参数和 batcher 不存在**

```powershell
Set-Location translator-v5
node --test --import tsx --test-name-pattern="balances|batcher" test/window-planner.test.ts
```

预期：FAIL，缺少 `targetSourceTokens` 或 `packPhysicalRequests`。

- [x] **步骤 3：用动态规划替换贪心切窗**

对每个合法 block 边界计算：长度偏差、跨结构边界惩罚、过短惩罚和超限无穷惩罚；从尾到头保存最低累计代价及下一个切点。窗口 ID 仍由协议、block IDs 和 source hashes 产生。单 block 超限时允许独立窗口并标记 `oversized`。

- [x] **步骤 4：实现纯函数 physical request packer**

```ts
export interface PhysicalRequestPlan {
  requestId: string;
  windows: BookWindowPlan[];
  sourceTokens: number;
}

export function packPhysicalRequests(
  windows: readonly BookWindowPlan[], options: RequestBatchOptions,
): PhysicalRequestPlan[] {
  // 只将连续、pending、低于 tinyWindowTokens 的窗口放入同一 request；
  // 保留原 window 对象，不能重写 block membership。
}
```

- [x] **步骤 5：运行窗口全测、typecheck 并 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx test/window-planner.test.ts
npm run typecheck
git add src/fullbook/types.ts src/fullbook/window-planner.ts src/fullbook/request-batcher.ts test/window-planner.test.ts
git commit -m "feat: plan semantic windows and micro batches"
```

### 任务 4：建立 schema v2 与完整 translation run 隔离

**文件：**
- 创建：`translator-v5/src/storage/book-schema-v2.ts`
- 创建：`translator-v5/src/storage/lossless-book-store.ts`
- 创建：`translator-v5/test/lossless-book-store.test.ts`

- [x] **步骤 1：编写 source/run 约束和回滚失败测试**

```ts
test("store cannot mix translations from two runs", () => {
  const store = fixtureV2Store();
  const runA = store.createTranslationRun(runMeta("model-a"));
  const runB = store.createTranslationRun(runMeta("model-b"));
  store.initializeWindowPlan(runA, fixturePlan());
  assert.throws(() => store.commitWindow({
    runId: runB, windowId: "window-0", snapshotId: "snapshot-a", translations: fixtureTranslations(),
    knowledgeCandidates: [], styleTail: "", budget: {}, warnings: [],
  }), /run.*window/i);
});

test("failed atomic commit leaves no active translation or knowledge row", () => {
  const store = fixtureV2Store();
  assert.throws(() => store.commitWindow(invalidSecondBlockCommit()), /source hash/i);
  assert.equal(store.activeTranslations("run-a").length, 0);
  assert.equal(store.knowledgeHistory("run-a").length, 0);
});
```

- [x] **步骤 2：运行测试确认 v2 store 不存在**

```powershell
Set-Location translator-v5
node --test --import tsx test/lossless-book-store.test.ts
```

预期：FAIL，无法导入 `lossless-book-store`。

- [x] **步骤 3：实现集中 DDL 和显式 run 外键**

DDL 创建 `source_versions`、`source_ranges`、`structure_annotations`、`logical_blocks`、`translation_runs`、`window_plans`、`window_membership`、`translations`、`knowledge_records`、`knowledge_snapshots`、`migration_candidates`、`recovery_runs` 和 `events`。所有 window、translation、snapshot 都携带 `run_id`；活动译文唯一索引为 `(run_id, block_id) WHERE active=1`。

`translations` 的触发器或提交前检查必须验证 translation source hash 等于 `logical_blocks.source_hash`；`window_membership` 对 `(run_id, block_id)` 唯一，阻止一块进入两个窗口。

- [x] **步骤 4：实现小而明确的事务 API**

```ts
export class LosslessBookStore {
  registerSource(input: CertifiedSourceInput): string;
  replaceDerivedPlan(sourceVersion: string, plan: DerivedPlan): void;
  createTranslationRun(meta: TranslationRunMeta): string;
  initializeWindowPlan(runId: string, windows: readonly BookWindowPlan[]): void;
  claimWindow(runId: string, windowId: string): PersistedWindow;
  stageWindow(input: WindowStageInput): void;
  promoteStagedWindow(runId: string, windowId: string): void;
  failWindow(runId: string, windowId: string, failure: WindowFailureInput): void;
  auditRows(runId: string): AuditProjection;
}
```

v1 `BookStore` 保持只读兼容，不执行原地 schema migration。

- [x] **步骤 5：运行 store 测试、现有 store 回归和 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx test/lossless-book-store.test.ts test/book-store.test.ts
npm run typecheck
git add src/storage/book-schema-v2.ts src/storage/lossless-book-store.ts test/lossless-book-store.test.ts
git commit -m "feat: persist isolated v5 translation runs"
```

### 任务 5：实现追加式知识生命周期与顺序晋升

**文件：**
- 创建：`translator-v5/src/knowledge/knowledge-store.ts`
- 创建：`translator-v5/src/knowledge/snapshot.ts`
- 创建：`translator-v5/src/fullbook/commit-coordinator.ts`
- 创建：`translator-v5/test/knowledge-snapshot.test.ts`

- [x] **步骤 1：编写不可变快照和逆序完成测试**

```ts
test("parallel windows share one immutable snapshot and promote in source order", () => {
  const coordinator = fixtureCoordinator(["window-0", "window-1"]);
  const snapshot = coordinator.snapshotForNextWave();
  coordinator.stage("window-1", stagedResult("Term", "乙", snapshot.id));
  assert.deepEqual(coordinator.promoteReady(), []);
  coordinator.stage("window-0", stagedResult("Term", "甲", snapshot.id));
  assert.deepEqual(coordinator.promoteReady(), ["window-0", "window-1"]);
  assert.equal(coordinator.activeKnowledge("Term")?.status, "needs_revalidate");
});
```

- [x] **步骤 2：运行测试确认模块不存在**

```powershell
Set-Location translator-v5
node --test --import tsx test/knowledge-snapshot.test.ts
```

- [x] **步骤 3：实现知识状态机和活动视图**

```ts
export type KnowledgeStatus =
  | "candidate" | "provisional" | "active"
  | "needs_revalidate" | "contextual" | "superseded";

export function transitionAllowed(from: KnowledgeStatus, to: KnowledgeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
```

知识写入只追加新 revision；活动视图选取同一 normalized subject 的最新合法 revision。两个并行候选译名不同则追加冲突 revision，并将活动状态置为 `needs_revalidate`，不使用完成时间或最后写入者决胜。

- [x] **步骤 4：实现快照哈希和 commit coordinator**

快照序列化必须按 normalized subject、kind、revision ID 稳定排序；ID 是序列化内容 SHA-256。Coordinator 只晋升当前最小 pending ordinal，窗口引用的 snapshot ID 不存在或不属于同 run 时拒绝提交。

- [x] **步骤 5：运行测试、typecheck 并 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx test/knowledge-snapshot.test.ts test/memory-projection.test.ts
npm run typecheck
git add src/knowledge src/fullbook/commit-coordinator.ts test/knowledge-snapshot.test.ts
git commit -m "feat: snapshot and sequence book knowledge"
```

### 任务 6：接入微批翻译和无损全书 Runner

**文件：**
- 创建：`translator-v5/src/agents/translation-batch.ts`
- 修改：`translator-v5/src/fullbook/book-context.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/test/book-runner.test.ts`

- [x] **步骤 1：编写一调用多微窗、单窗失败隔离和 doctor 零调用测试**

```ts
test("two tiny logical windows use one physical model session and commit independently", async () => {
  const fixture = losslessRunnerFixture(["EDGEWOOD", "BOOK ONE"]);
  const result = await runBook({ ...fixture.options, tinyWindowTokens: 32, maxWindowsPerRequest: 4 });
  assert.equal(fixture.provider.calls.length, 1);
  assert.equal(result.status.completedWindows, 2);
  assert.deepEqual(result.windows.map((item) => item.windowId), fixture.windowIds);
});

test("failed doctor blocks every model call", async () => {
  const fixture = losslessRunnerFixture(["Alpha."]);
  fixture.corruptCanonicalSource();
  await assert.rejects(runBook(fixture.options), /SOURCE_HASH_MISMATCH/);
  assert.equal(fixture.provider.calls.length, 0);
});
```

- [x] **步骤 2：运行定向测试确认仍使用 V4 source DB**

```powershell
Set-Location translator-v5
node --test --import tsx --test-name-pattern="tiny logical|failed doctor" test/book-runner.test.ts
```

- [x] **步骤 3：实现 batch agent 的单次终止提交**

batch prompt 为每个 island 提供 `windowId`、block IDs 和原文。唯一终止工具为：

```ts
interface FinalizeTranslationBatchArgs {
  windows: Array<{
    windowId: string;
    translations: Array<{ blockId: string; text: string }>;
    notes: string[];
    memoryCandidates?: TranslationMemoryCandidate[];
  }>;
}
```

Kernel 校验 window ID 集合完全一致、每个 block 只出现一次。返回后拆成独立 staged window；一个窗口不完整时只标记该窗口失败，合法窗口仍可顺序晋升。

- [x] **步骤 4：让正式 `BookContext` 从 source manifest 建立 blocks**

`BookContext.openLossless({ manifestPath, legacyV4DbPath? })` 加载 SourceLedger、annotations、lossless blocks 和单一 EvidenceIndex。`legacyV4DbPath` 仅调用 `loadStableTerms()`；不得再调用 V4 `loadBlocks()`。旧 `open(databasePath)` 只保留 preview 兼容。

- [x] **步骤 5：改造 Runner 使用 schema v2、snapshot 和 physical requests**

`runBook()` 参数替换为 `manifestPath`、可选 `legacyV4DbPath` 和 `runMeta`。开头同步运行 Auditor；通过后初始化 source/run/window plan。每波获取一个 snapshot，执行 physical requests，stage 后交给 Coordinator 按 ordinal 晋升。

- [x] **步骤 6：运行 Runner 全测、typecheck 并 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx test/book-runner.test.ts test/book-context.test.ts
npm run typecheck
git add src/agents/translation-batch.ts src/fullbook/book-context.ts src/fullbook/book-runner.ts test/book-runner.test.ts
git commit -m "feat: run lossless batched book translation"
```

### 任务 7：增加 doctor、audit 与版本安全 CLI

**文件：**
- 修改：`translator-v5/src/cli.ts`
- 修改：`translator-v5/test/cli.test.ts`
- 修改：`translator-v5/src/report.ts`

- [x] **步骤 1：编写新命令解析和 partial 命名测试**

```ts
test("CLI parses lossless doctor and audit without model configuration", () => {
  assert.deepEqual(parseArgs(["book", "doctor", "--manifest", "source_manifest.json"]), {
    command: "book-doctor", manifest: resolve("source_manifest.json"),
  });
  assert.deepEqual(parseArgs(["book", "audit", "--store", "book.db", "--run", "run-1"]), {
    command: "book-audit", store: resolve("book.db"), runId: "run-1",
  });
});
```

- [x] **步骤 2：运行 CLI 测试确认命令未知**

```powershell
Set-Location translator-v5
node --test --import tsx test/cli.test.ts
```

- [x] **步骤 3：实现 `doctor` 与 `audit`**

`book doctor --manifest` 只加载源账本、构建 annotations/blocks/windows 并运行独立 Auditor；输出稳定 JSON，包括 source version、覆盖率、incident codes 和是否允许模型调用。`book audit --store --run` 从 store 的审计投影与 canonical source 重算，不加载模型配置。

- [x] **步骤 4：版本化 `run`、`status` 和 partial artifacts**

`book run` 必须接收 `--manifest`，可选 `--v4-db`；第一次运行创建并打印 run ID，恢复时要求 `--run` 或 store 中唯一未完成 run。`status/export` 的 run 省略规则相同。允许不完整时文件名包含 `.partial`，audit JSON 写明缺块数。

- [x] **步骤 5：运行 CLI、report 测试和 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx test/cli.test.ts test/book-runner.test.ts
npm run typecheck
git add src/cli.ts src/report.ts test/cli.test.ts
git commit -m "feat: expose lossless book diagnostics"
```

### 任务 8：实现确定性恢复和受限 Recovery Pi

**文件：**
- 创建：`translator-v5/src/recovery/types.ts`
- 创建：`translator-v5/src/recovery/registry.ts`
- 创建：`translator-v5/src/recovery/recovery-engine.ts`
- 创建：`translator-v5/src/agents/recovery-agent.ts`
- 创建：`translator-v5/src/tools/recovery-tools.ts`
- 创建：`translator-v5/test/recovery-engine.test.ts`
- 修改：`translator-v5/src/cli.ts`

- [x] **步骤 1：编写确定性恢复、Pi 单次限制和越权拒绝测试**

```ts
test("a source span gap uses flat deterministic rebuild before any Pi call", async () => {
  const fixture = recoveryFixture("SOURCE_SPAN_GAP");
  const result = await fixture.engine.recover(fixture.incident);
  assert.equal(result.strategy, "flat_partition_rebuild");
  assert.equal(fixture.model.calls.length, 0);
  assert.equal(result.audit.ok, true);
});

test("Recovery Pi may choose one registered strategy but cannot mutate raw source", async () => {
  const fixture = ambiguousRecoveryFixture();
  const result = await fixture.engine.recover(fixture.incident);
  assert.equal(fixture.model.calls.length, 1);
  assert.equal(result.attempts, 1);
  assert.equal(fixture.tools.names().includes("write_file"), false);
  assert.equal(fixture.rawHashAfter(), fixture.rawHashBefore());
});
```

- [x] **步骤 2：运行测试确认 recovery 模块不存在**

```powershell
Set-Location translator-v5
node --test --import tsx test/recovery-engine.test.ts
```

- [x] **步骤 3：建立单一策略注册表**

```ts
export const RECOVERY_RULES: Readonly<Record<IncidentCode, RecoveryRule>> = {
  SOURCE_SPAN_GAP: {
    deterministic: "flat_partition_rebuild",
    allowed: ["rebuild_affected_span", "flat_partition_rebuild"],
    maxAttempts: 1,
    requiredAudits: ["source_coverage", "block_membership"],
  },
  ENCODING_AMBIGUOUS: {
    deterministic: null, allowed: [], maxAttempts: 0,
    requiredAudits: ["raw_hash"], requiresHuman: true,
  },
  RUNNING_AFTER_CRASH: {
    deterministic: "reset_interrupted_windows",
    allowed: ["reset_interrupted_windows"], maxAttempts: 1,
    requiredAudits: ["run_state"],
  },
};
```

完整 `INCIDENT_CODES` 同时声明 `SOURCE_SPAN_OVERLAP`、`SOURCE_HASH_MISMATCH`、`BLOCK_MEMBERSHIP_INVALID`、`WINDOW_OVERSIZED`、`SOURCE_VERSION_CHANGED`、`RUN_VERSION_MISMATCH`、`STORAGE_LOCKED`、`STORAGE_CORRUPT` 和 `EXPORT_INCOMPLETE`。测试断言 `Object.keys(RECOVERY_RULES).sort()` 与 `INCIDENT_CODES` 完全相等，避免出现没有恢复政策的新错误码。工具 schema 和 agent prompt 都从此注册表投影，不复制策略文字。

- [x] **步骤 4：实现影子计划和确定性恢复**

RecoveryEngine 先查唯一 deterministic 策略，在临时 source/plan version 中执行；Auditor 全过后调用 `promoteRecovery()`，失败则删除影子版本并记录 `quarantined`。原始文件、已完成译文和旧 run 不得原地修改。

- [x] **步骤 5：实现最多一次的 Recovery Pi**

Pi 仅暴露 `inspect_incident`、`inspect_source_span`、`inspect_structure_annotations`、`choose_recovery_strategy` 和 `submit_recovery_result`。`choose` 参数必须是当前 incident 注册表中的枚举值；没有允许策略时不启动模型。一次非终止响应后直接返回 `quarantined`，不循环。

- [x] **步骤 6：接入 `book recover` 并运行测试**

```powershell
Set-Location translator-v5
node --test --import tsx test/recovery-engine.test.ts test/pi-runtime.test.ts test/cli.test.ts
npm run typecheck
```

- [x] **步骤 7：Commit**

```powershell
git add src/recovery src/agents/recovery-agent.ts src/tools/recovery-tools.ts src/cli.ts test/recovery-engine.test.ts
git commit -m "feat: recover lossless runs within typed bounds"
```

### 任务 9：实现同 run 严格导出和反向核验

**文件：**
- 修改：`translator-v5/src/report.ts`
- 创建：`translator-v5/src/export/export-verifier.ts`
- 创建：`translator-v5/src/migration/v1-importer.ts`
- 创建：`translator-v5/test/export-verifier.test.ts`
- 创建：`translator-v5/test/v1-importer.test.ts`
- 修改：`src/core/v5_exporter.py`
- 修改：`tests/test_v5_exporter.py`
- 修改：`main.py`
- 修改：`translator-v5/src/cli.ts`

- [x] **步骤 1：编写混合 run、缺块和 lineage 篡改失败测试**

```ts
test("strict export rejects active rows from a different run", () => {
  const fixture = exportFixture();
  fixture.injectTranslationFrom("run-b", "block-1");
  assert.throws(() => writeBookArtifacts(fixture.store, fixture.output, {
    runId: "run-a", allowIncomplete: false,
  }), /translation run mismatch/i);
});

test("verify-export detects a modified block lineage", () => {
  const fixture = exportedFixture();
  fixture.modifyLineageBlockHash("block-1", "bad-hash");
  assert.equal(verifyExport(fixture.paths, fixture.store, "run-a").ok, false);
});

test("v1 importer activates only a unique exact source match", () => {
  const fixture = legacyImportFixture();
  fixture.addLegacyTranslation("unique source", "唯一译文");
  fixture.addLegacyTranslation("repeated source", "不应静默晋升");
  fixture.addNewBlocks(["unique source", "repeated source", "repeated source"]);
  const result = importLegacyV1(fixture.options);
  assert.equal(result.importedTranslations, 1);
  assert.equal(result.referenceCandidates, 1);
  assert.equal(fixture.store.activeTranslations(result.runId).length, 1);
});
```

- [x] **步骤 2：运行 TS/Python 定向测试确认 schema v2 尚不支持**

```powershell
Set-Location translator-v5
node --test --import tsx test/export-verifier.test.ts
node --test --import tsx test/v1-importer.test.ts
Set-Location ..
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest -q tests/test_v5_exporter.py
```

- [x] **步骤 3：生成稳定 lineage sidecar**

TXT、双语 TXT 和 audit 输出旁生成 `*.lineage.json`，包含 artifact schema、source version、run metadata、按 ordinal 排序的 block ID/source hash/translation revision。partial 文件明确写 `complete: false` 和 missing IDs。EPUB 在 `META-INF/v5-lineage.json` 写入同一投影。

- [x] **步骤 4：改造 Python exporter 只读 schema v2 指定 run**

`V5BookExporter(..., run_id=...)` 查询必须使用 `translations.run_id=? AND active=1`，并验证 translation run 的 source version 与 logical blocks 一致。省略 run ID 时只允许数据库存在一个可导出的 run；否则报错要求显式选择。

- [x] **步骤 5：实现 `verify-export`**

Verifier 核对 artifact lineage 与数据库投影的数量、顺序、source hash、revision、run metadata；EPUB 额外验证 ZIP 中 lineage 成员存在且 JSON 一致。它不比较中英文语义。

- [x] **步骤 6：实现显式 v1 migration run**

`importLegacyV1()` 读取旧 `book_blocks` 与活动 `translations`，对新 blocks 做精确 source hash + source text 匹配。只有唯一匹配才写入新建的 migration run；重复文本或邻接位置无法唯一对齐时写入 `migration_candidates`，不进入活动译文。migration run 保存旧 store fingerprint、旧模型 ID（缺失时为 `legacy-unknown`）和 `v5-book-3` provenance。CLI 增加：

```text
book migrate-v1 --legacy-store OLD.db --manifest source_manifest.json --store NEW.db
```

命令输出新 `runId`、唯一导入数和 reference candidate 数。

- [x] **步骤 7：运行导出/迁移测试、typecheck 并 Commit**

```powershell
Set-Location translator-v5
node --test --import tsx test/export-verifier.test.ts test/v1-importer.test.ts test/cli.test.ts
npm run typecheck
Set-Location ..
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest -q tests/test_v5_exporter.py
git add translator-v5/src/report.ts translator-v5/src/export translator-v5/src/migration translator-v5/src/cli.ts translator-v5/test/export-verifier.test.ts translator-v5/test/v1-importer.test.ts src/core/v5_exporter.py tests/test_v5_exporter.py main.py
git commit -m "feat: verify single-run book exports"
```

### 任务 10：故障注入、全量回归与 `Little, Big` 迁移验收

**文件：**
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/src/cli.ts`
- 创建：`translator-v5/test/fault-injection.test.ts`
- 修改：`translator-v5/test/block-builder.property.test.ts`
- 创建：`docs/superpowers/reports/2026-07-18-little-big-lossless-migration.md`

- [x] **步骤 1：为事务检查点增加可注入测试钩子**

仅在构造 `LosslessBookStore` 时允许传入：

```ts
export interface FaultInjector {
  checkpoint(name: "after_stage" | "before_translation_insert" | "before_promote" | "before_commit"): void;
}
```

生产默认实现为空；测试实现分别在四个位置抛错，重开数据库后核对没有半提交状态。

- [x] **步骤 2：编写中断、源变化、数据库锁和无效模型结果测试**

```ts
for (const checkpoint of CHECKPOINTS) {
  test(`resume after injected ${checkpoint} matches uninterrupted final state`, async () => {
    const interrupted = await runWithInjectedFailure(checkpoint);
    const resumed = await resumeFixture(interrupted);
    const clean = await runCleanFixture();
    assert.deepEqual(resumed.activeProjection, clean.activeProjection);
    assert.equal(resumed.audit.ok, true);
  });
}
```

另写独立用例验证：运行中修改 canonical source 会在下一波前阻塞；未知/重复 block ID 无法 stage；SQLite lock 产生 retryable storage incident，不产生人工翻译任务。

- [x] **步骤 3：把属性样本扩充到全部验收形态**

固定种子覆盖无章节、重复卷章、千个短章、十万字符单段、BOM/Unicode 控制字符、同名目录/正文、空标题和重复段落。每个样本运行 ledger → block → window → schema 初始化 → audit，不调用模型。

- [x] **步骤 4：运行全部 TypeScript 与 Python 正式测试**

```powershell
Set-Location translator-v5
npm test
npm run typecheck
Set-Location ..
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest -q tests --ignore=tests/test_foila_logic.py
git diff --check
```

预期：全部 PASS；`test_foila_logic.py` 仍因历史外部 `ARK_API_KEY` 需求明确排除。

- [x] **步骤 5：重建 `Little, Big` source ledger 并运行 doctor**

使用原文件：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' main.py init little_big_lossless 'D:\llm\qikan4\Little, Big. (John Crowley) (z-library.sk, 1lib.sk, z-lib.sk).txt' --force
Set-Location translator-v5
npm run book -- doctor --manifest '..\projects\little_big_lossless\source_manifest.json'
```

记录 raw/canonical hashes、覆盖率、blocks、windows、重复标题数量、doctor 时间和内存；覆盖必须 100%、重叠必须 0。

- [x] **步骤 6：迁移旧四块作为候选并验证不静默晋升**

```powershell
Set-Location translator-v5
$migration = npm run --silent book -- migrate-v1 `
  --legacy-store 'D:\llm\小说翻译\.worktrees\v5-fullbook-production\projects\little_big\artifacts\translator_v5_final\book.db' `
  --manifest '..\projects\little_big_lossless\source_manifest.json' `
  --store '..\projects\little_big_lossless\artifacts\translator_v5_v2\book.db' | ConvertFrom-Json
npm run --silent book -- audit `
  --store '..\projects\little_big_lossless\artifacts\translator_v5_v2\book.db' `
  --run $migration.runId
```

唯一 source hash + text +位置匹配的旧译文进入 migration run；其余进入 `migration_candidates`。随后对该 run 生成 partial export 并运行 `verify-export`，确认没有其他 Flash run 或歧义候选混入活动译文。

- [x] **步骤 7：撰写验收报告并 Commit**

报告列出故障注入矩阵、属性样本数量、完整回归结果、Little Big 覆盖证明、迁移结果、模型额外调用数（doctor/audit 应为 0）以及是否建议合并。

```powershell
git add translator-v5/src/storage/lossless-book-store.ts translator-v5/src/fullbook/book-runner.ts translator-v5/src/cli.ts translator-v5/test/fault-injection.test.ts translator-v5/test/block-builder.property.test.ts docs/superpowers/reports/2026-07-18-little-big-lossless-migration.md
git commit -m "test: verify lossless recovery under faults"
```

---

## 最终验收命令

```powershell
Set-Location 'D:\llm\小说翻译\.worktrees\v5-lossless-engineering\translator-v5'
npm test
npm run typecheck
Set-Location ..
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest -q tests --ignore=tests/test_foila_logic.py
git diff --check
git status --short
```

只有所有自动测试通过、Little Big doctor 覆盖率为 100%、工作树只含预期报告改动时，才能进入合并评估。
