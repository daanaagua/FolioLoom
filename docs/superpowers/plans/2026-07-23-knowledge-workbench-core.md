# FolioLoom 知识工作台核心实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 在现有 V5 无损书库中加入可追溯的人工知识修订、分页查询、证据/版本/影响查看、全局术语提升，并在 Electron 中交付可用的“术语与记忆”工作台。

**架构：** 保留 `KnowledgeRevision` 与知识快照作为翻译核心的唯一有效知识链，在 schema v3 中允许无窗口来源的人工/导入修订，并增加代数、影响和导入 staging 表。渲染进程只通过严格 IPC 调用 `DesktopKnowledgeService`；所有写入在主进程中经过 `KnowledgeCommandService`、乐观锁和单事务提交，翻译运行继续读取知识快照而不引入第二套真相。

**技术栈：** TypeScript 7、Node `node:sqlite`、Electron 43、React 19、Vitest/Testing Library、Node test runner

**前置设计：** `docs/superpowers/specs/2026-07-23-knowledge-workbench-and-import-design.md`

**命令目录：** 所有 `npm`/`npx` 命令在 `translator-v5` 目录运行；所有 `git add`/`git commit` 命令在仓库 worktree 根目录运行。

---

## 文件结构

### 新建

- `translator-v5/src/storage/book-schema-v3.ts`：schema v3、v2→v3 原子迁移和严格形状校验常量。
- `translator-v5/src/knowledge/knowledge-authority.ts`：来源、作用域、字段所有权、字段级合并和兼容解析。
- `translator-v5/src/knowledge/knowledge-commands.ts`：知识命令、乐观锁、批量提交和撤销领域接口。
- `translator-v5/src/knowledge/knowledge-source-forms.ts`：从知识 payload 中保守提取明确原文形式。
- `translator-v5/src/knowledge/knowledge-query.ts`：语义对象适配、稳定排序、游标分页、详情、证据和影响投影。
- `translator-v5/src/knowledge/persisted-style.ts`：从已激活知识修订中提取结构化风格覆盖。
- `translator-v5/src/knowledge/global-knowledge-store.ts`：用户级通用术语 SQLite 修订库。
- `translator-v5/src/desktop/knowledge-contracts.ts`：渲染进程可见的严格知识 API 类型。
- `translator-v5/src/desktop/desktop-knowledge-service.ts`：项目目标解析、查询、写入、撤销和全局提升编排。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx`：工作台状态机和主要布局。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeTable.tsx`：筛选、分页和行选择。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeDetailDrawer.tsx`：详情、证据、历史和影响抽屉。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeEditor.tsx`：按对象类型编辑并提交字段补丁。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeDiagnostics.tsx`：受限只读诊断信息。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeRelationGraph.tsx`：当前对象一到两层的有界关系辅助图。
- `translator-v5/src/desktop/renderer/src/components/GlobalKnowledgePicker.tsx`：选择并快照通用术语/风格到当前项目。
- `translator-v5/test/book-schema-v3.test.ts`：新建、迁移、只读兼容和故障回滚。
- `translator-v5/test/knowledge-authority.test.ts`：字段级所有权和模型候选合并。
- `translator-v5/test/knowledge-commands.test.ts`：事务、快照、代数、乐观锁和撤销。
- `translator-v5/test/knowledge-query.test.ts`：分页、筛选、详情、证据和影响。
- `translator-v5/test/global-knowledge-store.test.ts`：通用术语提升、版本和限制。
- `translator-v5/test/desktop-knowledge-service.test.ts`：服务层不信任路径、持久化和错误映射。
- `translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.test.tsx`：桌面工作台交互。

### 修改

- `translator-v5/src/storage/book-schema-v2.ts`：仅保留 v2 常量，供兼容验证与迁移输入使用。
- `translator-v5/src/storage/lossless-book-store.ts`：打开/迁移 schema、知识命令事务、分页读取、影响和审计。
- `translator-v5/src/knowledge/knowledge-store.ts`：修订中携带可选 authority，候选协调尊重字段所有权。
- `translator-v5/src/knowledge/translation-knowledge-projection.ts`：复用统一源形式提取并按有效作用域投影。
- `translator-v5/src/fullbook/book-runner.ts`：从快照提取人工术语和持久化风格。
- `translator-v5/src/desktop/contracts.ts`：项目快照加入知识工作台可用状态。
- `translator-v5/src/desktop/desktop-project-service.ts`：提供只在主进程使用的已验证知识目标。
- `translator-v5/src/desktop/main/ipc.ts`：注册严格知识 IPC。
- `translator-v5/src/desktop/main/index.ts`：构造知识服务和用户级通用术语库。
- `translator-v5/src/desktop/preload/index.ts`：暴露有限知识 API。
- `translator-v5/src/desktop/preload/folioloom-api.d.ts`：声明知识 API。
- `translator-v5/src/desktop/renderer/src/App.tsx`：渲染真实知识工作区。
- `translator-v5/src/desktop/renderer/src/App.test.tsx`：更新侧栏可用性和路由测试。
- `translator-v5/src/desktop/renderer/src/components/Sidebar.tsx`：仅在有效项目/运行下启用“术语与记忆”。
- `translator-v5/src/desktop/renderer/src/types.ts`：增加知识操作 busy 状态。
- `translator-v5/src/desktop/renderer/src/styles.css`：表格、抽屉、表单和响应式样式。
- `translator-v5/test/lossless-book-store.test.ts`：schema 版本期望和知识事务回归。
- `translator-v5/test/desktop-ipc.test.ts`：知识通道、载荷校验和不可信调用。
- `translator-v5/test/desktop-main-security.test.ts`：确认渲染进程无法传数据库路径或 SQL。

## 任务 1：建立 schema v3 与无损迁移

**文件：**

- 创建：`translator-v5/src/storage/book-schema-v3.ts`
- 修改：`translator-v5/src/storage/book-schema-v2.ts`
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 测试：`translator-v5/test/book-schema-v3.test.ts`
- 测试：`translator-v5/test/lossless-book-store.test.ts`

- [x] **步骤 1：编写新建与迁移失败测试**

在 `book-schema-v3.test.ts` 建立真实临时数据库，覆盖新建、v2 迁移和中途故障回滚：

```ts
test("opens a v2 store as v3 without changing knowledge identities", () => {
  const path = fixturePath();
  createV2Fixture(path);
  const before = readKnowledgeRows(path);

  const store = new LosslessBookStore(path);
  store.close();

  assert.equal(userVersion(path), 3);
  assert.deepEqual(readKnowledgeRows(path), before);
  assert.deepEqual(requiredTables(path), [
    "book_knowledge_revisions",
    "book_knowledge_state",
    "knowledge_block_impacts",
    "knowledge_import_batches",
    "knowledge_import_rows",
    "knowledge_state",
    "project_knowledge_revisions",
    "project_knowledge_state",
  ]);
});

test("rolls back the complete v2 to v3 migration after a fault", () => {
  const path = fixturePath();
  createV2Fixture(path);
  assert.throws(
    () => new LosslessBookStore(path, {
      checkpoint(name) {
        if (name === "schema_v3_before_commit") throw new Error("injected");
      },
    }),
    /injected/u,
  );
  assert.equal(userVersion(path), 2);
  assert.equal(tableExists(path, "knowledge_state"), false);
});
```

同时把 `lossless-book-store.test.ts` 中“schema v2”新建期望改为 schema v3，但保留“未知/部分数据库不得擅自改动”和只读快照行为。

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx --test-name-pattern="schema v3|v2 store as v3|schema v2" test/book-schema-v3.test.ts test/lossless-book-store.test.ts
```

预期：FAIL，提示 `book-schema-v3.ts` 不存在或 `user_version` 仍为 2。

- [x] **步骤 3：定义 schema v3**

在 `book-schema-v3.ts` 复用 v2 建表串并追加以下严格表：

```ts
export const LOSSLESS_BOOK_SCHEMA_VERSION = 3;
export const LOSSLESS_BOOK_SCHEMA_MARKER =
  "folioloom-lossless-book-store-v3-user-knowledge";

export const LOSSLESS_BOOK_SCHEMA_V3_EXTENSION = `
  CREATE TABLE knowledge_state(
    run_id TEXT PRIMARY KEY REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    applied_book_generation INTEGER NOT NULL DEFAULT 0
      CHECK(applied_book_generation >= 0),
    applied_project_generation INTEGER NOT NULL DEFAULT 0
      CHECK(applied_project_generation >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE book_knowledge_state(
    source_version TEXT PRIMARY KEY
      REFERENCES source_versions(source_version) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE book_knowledge_revisions(
    source_version TEXT NOT NULL
      REFERENCES source_versions(source_version) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    revision_id TEXT NOT NULL UNIQUE,
    object_type TEXT NOT NULL
      CHECK(object_type IN ('term', 'entity', 'alias', 'relation', 'memory', 'style')),
    normalized_subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    origin TEXT NOT NULL CHECK(origin IN ('manual', 'import', 'rollback')),
    scope TEXT NOT NULL CHECK(scope IN ('book', 'global')),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(source_version, record_id, revision)
  ) STRICT;

  CREATE TABLE project_knowledge_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE project_knowledge_revisions(
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    revision_id TEXT NOT NULL UNIQUE,
    object_type TEXT NOT NULL
      CHECK(object_type IN ('term', 'entity', 'alias', 'relation', 'memory', 'style')),
    normalized_subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    origin TEXT NOT NULL CHECK(origin IN ('manual', 'import', 'rollback')),
    scope TEXT NOT NULL CHECK(scope = 'project'),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(record_id, revision)
  ) STRICT;

  CREATE TABLE knowledge_block_impacts(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    block_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'acknowledged', 'retranslated')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, revision_id, block_id),
    FOREIGN KEY(source_version, block_id)
      REFERENCES logical_blocks(source_version, block_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE knowledge_import_batches(
    run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_format TEXT NOT NULL,
    mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
    mapping_hash TEXT NOT NULL CHECK(length(mapping_hash) = 64),
    status TEXT NOT NULL
      CHECK(status IN ('staged', 'committed', 'rolled_back', 'discarded', 'failed')),
    report_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(run_id, batch_id),
    UNIQUE(run_id, source_hash, mapping_hash)
  ) STRICT;

  CREATE TABLE knowledge_import_rows(
    run_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK(row_ordinal >= 0),
    state TEXT NOT NULL
      CHECK(state IN ('ready', 'merge', 'conflict', 'invalid', 'skipped', 'committed')),
    normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
    diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json)),
    decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
    PRIMARY KEY(run_id, batch_id, row_ordinal),
    FOREIGN KEY(run_id, batch_id)
      REFERENCES knowledge_import_batches(run_id, batch_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX idx_v5_knowledge_records_list
    ON knowledge_records(run_id, active, normalized_subject, kind, record_id);
  CREATE INDEX idx_v5_book_knowledge_active
    ON book_knowledge_revisions(
      source_version, active, object_type, normalized_subject, kind, record_id
    );
  CREATE INDEX idx_v5_project_knowledge_active
    ON project_knowledge_revisions(
      active, object_type, normalized_subject, kind, record_id
    );
  CREATE INDEX idx_v5_knowledge_impacts_status
    ON knowledge_block_impacts(run_id, status, created_at, block_id);
  CREATE INDEX idx_v5_import_batches_status
    ON knowledge_import_batches(run_id, status, created_at, batch_id);
  CREATE INDEX idx_v5_import_rows_state
    ON knowledge_import_rows(run_id, batch_id, state, row_ordinal);
`;
```

`document_json` 保存完整的 `CatalogKnowledgeDocument`（对象类型、payload、alternatives、status、authority、evidence），而不是只保存译名字段；列中的 `object_type`、`normalized_subject`、`kind`、`origin`、`scope` 必须在写入和读取时与文档逐项互证。`book_knowledge_revisions` 只承载当前 source version 的 `book` 修订和已经快照到本书的 `global` 修订；真正跨 source version 的 `project` 修订只写 `project_knowledge_revisions`。

v3 的 `knowledge_records` 定义将 `producing_window_id` 改为可空，并增加：

```sql
origin TEXT NOT NULL DEFAULT 'model'
  CHECK(origin IN ('model', 'manual', 'import', 'rollback')),
scope TEXT NOT NULL DEFAULT 'book'
  CHECK(scope IN ('book', 'project', 'global')),
owned_fields_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(owned_fields_json)),
evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
import_batch_id TEXT
```

- [x] **步骤 4：实现严格迁移与兼容打开**

在 `LosslessBookStore` 构造阶段：

```ts
if (userVersion === 2 && mode === "read-write") {
  this.#migrateV2ToV3(tables);
} else if (userVersion === 2 && mode === "read-only") {
  this.#verifyV2Schema(tables);
} else {
  this.#verifyV3Schema(userVersion, tables);
}
```

`#migrateV2ToV3` 必须在一个 `BEGIN IMMEDIATE` 中重建 `knowledge_records`，把旧行复制为 `origin='model'`、`scope='book'`、空 owned fields/evidence，然后创建扩展表、为每个 source 插入 generation 0 的 `book_knowledge_state`、插入 singleton=1/generation=0 的 `project_knowledge_state`、为每个运行插入 generation 0 且两个 applied generation 均为 0 的 `knowledge_state`、更新 marker/fingerprint/user_version，最后调用：

```ts
this.#faultInjector?.checkpoint("schema_v3_before_commit");
```

只读 v2 兼容只允许旧读取方法；调用 v3 知识写入或分页方法时返回明确的 `schema v3 write upgrade required`。

同时修改 `createTranslationRun`，在创建运行和初始 snapshot 的同一事务中插入 `knowledge_state(run_id, generation=0, applied_book_generation=currentBookGeneration, applied_project_generation=currentProjectGeneration)`；重复创建运行时校验该行存在且两个 applied generation 均合法。任务 3 将补上实际 book/project seed 内容。

- [x] **步骤 5：运行迁移与完整存储测试**

运行：

```powershell
node --test --import tsx test/book-schema-v3.test.ts test/lossless-book-store.test.ts
```

预期：PASS；故障注入后的数据库仍为完整 v2，正常迁移后知识 revision ID 和快照 ID 不变。

- [x] **步骤 6：Commit**

```powershell
git add translator-v5/src/storage/book-schema-v2.ts translator-v5/src/storage/book-schema-v3.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test/book-schema-v3.test.ts translator-v5/test/lossless-book-store.test.ts
git commit -m "feat: add user knowledge schema v3"
```

## 任务 2：给知识修订加入字段级权威

**文件：**

- 创建：`translator-v5/src/knowledge/knowledge-authority.ts`
- 修改：`translator-v5/src/knowledge/knowledge-store.ts`
- 测试：`translator-v5/test/knowledge-authority.test.ts`
- 测试：`translator-v5/test/knowledge-snapshot.test.ts`

- [x] **步骤 1：编写兼容与字段合并失败测试**

```ts
test("keeps legacy revision hashes when authority is absent", () => {
  const legacy = new KnowledgeStore();
  const revision = legacy.appendRevision({
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "执政官" },
    status: "active",
  });
  const expected = createHash("sha256").update(canonicalJson({
    revision: 1,
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "执政官" },
    alternatives: [{ target: "执政官" }],
    status: "active",
    candidateIds: [],
    sourceWindowIds: [],
  })).digest("hex");
  assert.equal(revision.revisionId, expected);
  assert.equal(revision.authority, undefined);
});

test("a manual owned target survives later model candidates", () => {
  const store = new KnowledgeStore();
  store.appendRevision({
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "阁下", note: "direct address" },
    status: "active",
    authority: {
      origin: "manual",
      scope: "book",
      ownedFields: ["/target"],
    },
  });
  const [next] = store.reconcileCandidates([{
    recordId: "candidate-1",
    normalizedSubject: "archon",
    kind: "term_sense",
    payload: { target: "执政官", note: "title" },
  }], "window-2");

  assert.equal((next?.payload as { target: string }).target, "阁下");
  assert.equal((next?.payload as { note: string }).note, "title");
  assert.equal(next?.status, "active");
});

test("resolves authority by scope and origin and exposes same-rank conflicts", () => {
  assert.equal(compareAuthority(
    authority("manual", "book"),
    authority("manual", "global"),
  ), 1);
  assert.equal(compareAuthority(
    authority("manual", "book"),
    authority("import", "book"),
  ), 1);
  assert.throws(
    () => chooseEffectiveField([
      field("manual", "book", "执政官"),
      field("manual", "book", "阁下"),
    ]),
    /KNOWLEDGE_AUTHORITY_CONFLICT/u,
  );
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-authority.test.ts test/knowledge-snapshot.test.ts
```

预期：FAIL，`KnowledgeRevision` 尚无 `authority`，候选会把人工值变为冲突。

- [x] **步骤 3：实现 authority 类型和 JSON Pointer 合并**

在 `knowledge-authority.ts` 定义：

```ts
export type KnowledgeOrigin = "model" | "manual" | "import" | "rollback";
export type KnowledgeScope = "book" | "project" | "global";
export type JsonValue =
  | null | boolean | number | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface KnowledgeAuthority {
  readonly origin: KnowledgeOrigin;
  readonly scope: KnowledgeScope;
  readonly ownedFields: readonly string[];
  readonly provenance?: {
    readonly catalog: "book" | "project";
    readonly catalogRevisionId: string;
    readonly globalRevisionId?: string;
  };
}

export interface KnowledgeEvidence {
  readonly kind: "source_block" | "source_window" | "user_note";
  readonly blockId?: string;
  readonly sourceWindowId?: string;
  readonly canonicalStart?: number;
  readonly canonicalEnd?: number;
  readonly quote?: string;
}

export function mergeCandidateWithAuthority(
  current: unknown,
  candidate: unknown,
  authority: KnowledgeAuthority | undefined,
): unknown;

export function compareAuthority(
  left: KnowledgeAuthority,
  right: KnowledgeAuthority,
): -1 | 0 | 1;
```

`ownedFields` 仅接受 RFC 6901 的根字段路径（如 `/target`、`/note`），拒绝空路径、数组索引、`__proto__`、`prototype` 和 `constructor`。合并以候选为基础，仅把人工拥有字段从 current 复制回来；两侧均须为纯 JSON。

`compareAuthority` 固定按 `book > project > global`，同作用域按 `manual/rollback > import > model`。同级不同值必须返回显式冲突，不能用 revision 时间或数组顺序决胜。

- [x] **步骤 4：扩展修订但保持旧哈希兼容**

给 `KnowledgeRevision` 和 `AppendKnowledgeRevision` 只增加可选 authority：

```ts
readonly authority?: KnowledgeAuthority;
```

`normalizeRevisionContent` 只有在输入确实含有 authority 时才写入 canonical content，旧修订不得被补默认值。证据保存在 `knowledge_records.evidence_json`，不进入反复复制的 snapshot payload。`reconcileCandidates` 使用 `mergeCandidateWithAuthority` 后再去重 alternatives；若所有差异均落在被保护字段上，保持 `active`，否则才进入 `needs_revalidate`。

- [x] **步骤 5：验证旧快照和新权威修订**

运行：

```powershell
node --test --import tsx test/knowledge-authority.test.ts test/knowledge-snapshot.test.ts
```

预期：PASS；旧 fixture 哈希不变，新 revision/snapshot 对相同输入保持确定性。

- [x] **步骤 6：Commit**

```powershell
git add translator-v5/src/knowledge/knowledge-authority.ts translator-v5/src/knowledge/knowledge-store.ts translator-v5/test/knowledge-authority.test.ts translator-v5/test/knowledge-snapshot.test.ts
git commit -m "feat: preserve user-owned knowledge fields"
```

## 任务 3：实现原子知识命令、代数和撤销

**文件：**

- 创建：`translator-v5/src/knowledge/knowledge-commands.ts`
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 测试：`translator-v5/test/knowledge-commands.test.ts`
- 测试：`translator-v5/test/fault-injection.test.ts`

- [x] **步骤 1：编写保存、竞争和故障失败测试**

```ts
test("commits one user revision, snapshot, generation and event atomically", () => {
  const { store, runId } = initializedStore();
  const before = store.knowledgeState(runId);
  const result = store.commitKnowledgeCommands({
    runId,
    expectedGeneration: before.generation,
    expectedSnapshotId: before.snapshotId,
    commands: [termCommand("archon", "阁下")],
  });
  assert.equal(result.generation, before.generation + 1);
  assert.equal(store.latestKnowledgeSnapshot(runId).id, result.snapshotId);
  assert.equal(store.knowledgeRevisions(runId).at(-1)?.authority?.origin, "manual");
});

test("rejects a stale editor without overwriting the newer revision", () => {
  const { store, runId } = initializedStore();
  const stale = store.knowledgeState(runId);
  store.commitKnowledgeCommands(commandAt(stale, "执政官"));
  assert.throws(
    () => store.commitKnowledgeCommands(commandAt(stale, "阁下")),
    /KNOWLEDGE_GENERATION_CONFLICT/u,
  );
});

test("rolls back revision, snapshot, generation and event together", () => {
  const { store, runId } = initializedStore("knowledge_command_before_commit");
  const before = store.auditState(runId);
  assert.throws(() => store.commitKnowledgeCommands(validCommand(store, runId)), /injected/u);
  assert.deepEqual(store.auditState(runId), before);
});

test("rejects edits while a window is running or staged", () => {
  const { store, runId } = initializedStore();
  store.claimWindow(runId, "window-0");
  assert.throws(
    () => store.commitKnowledgeCommands(validCommand(store, runId)),
    /KNOWLEDGE_EDIT_BUSY/u,
  );
});

test("seeds a later run from the current book-scoped knowledge", () => {
  const { store, runId, sourceVersion } = initializedStore();
  store.commitKnowledgeCommands(validCommand(store, runId));
  const nextRunId = createSecondRun(store, sourceVersion);
  assert.equal(
    (store.latestKnowledgeSnapshot(nextRunId).revisions[0]?.payload as { target: string }).target,
    "阁下",
  );
});

test("seeds a different source version only from project-scoped knowledge", () => {
  const { store, runId } = initializedStore();
  store.commitKnowledgeCommands(projectCommand(store, runId, "Archon", "执政官"));
  store.commitKnowledgeCommands(bookCommand(store, runId, "Piaton", "皮亚顿"));
  const nextRunId = createRunForNewSourceVersion(store);
  const subjects = store.latestKnowledgeSnapshot(nextRunId).revisions
    .map((item) => item.normalizedSubject);
  assert.deepEqual(subjects, ["archon"]);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-commands.test.ts test/fault-injection.test.ts
```

预期：FAIL，存储层尚无 `knowledgeState` 和 `commitKnowledgeCommands`。

- [x] **步骤 3：定义命令和结果**

在 `knowledge-commands.ts` 定义无路径、无 SQL 的领域命令：

```ts
export type KnowledgeObjectType =
  | "term" | "entity" | "alias" | "relation" | "memory" | "style";

export interface CatalogKnowledgeDocument {
  readonly objectType: KnowledgeObjectType;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly alternatives: readonly JsonValue[];
  readonly status: KnowledgeStatus;
  readonly authority: KnowledgeAuthority;
  readonly evidence: readonly KnowledgeEvidence[];
}

export interface KnowledgeCatalogExpectation {
  readonly scope: KnowledgeScope;
  readonly revision: number;
}

export interface UpdateKnowledgeCommand {
  readonly type: "upsert";
  readonly objectType: KnowledgeObjectType;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly expectedRevision: number | null;
  readonly expectedScopeRevision: KnowledgeCatalogExpectation | null;
  readonly fieldPatch: Readonly<Record<string, JsonValue>>;
  readonly ownedFields: readonly string[];
  readonly scope: KnowledgeScope;
  readonly evidence: readonly KnowledgeEvidence[];
  readonly origin: "manual" | "import";
  readonly importBatchId?: string;
}

export interface RollbackKnowledgeCommand {
  readonly type: "rollback";
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly expectedRevision: number;
  readonly expectedScopeRevision: KnowledgeCatalogExpectation;
  readonly targetRevision: number;
}
```

同时定义 `validateKnowledgeCommand`，为六种对象给出允许字段、必填字段和长度上限。未知字段必须报错，不能静默丢弃。`expectedScopeRevision.scope` 表示编辑前条目所在作用域；因此改变 `book/project` 作用域时仍能对旧 catalog 做乐观锁。`global` 条目不能在普通命令中就地改写：界面必须让用户选择“复制为本书覆盖”或进入任务 6 的全局库流程。

- [x] **步骤 4：实现单事务命令提交**

`LosslessBookStore.commitKnowledgeCommands` 在一个现有 `#transaction` 中：

1. 验证运行、当前 generation、latest snapshot 和每条命令的 expected scope revision；
2. 确认没有 `running` 或 `staged` 窗口，否则返回可重试的 `KNOWLEDGE_EDIT_BUSY`；
3. 加载 `KnowledgeStore`；
4. 按命令顺序验证 run revision，合并字段，追加 revision；
5. `book` 写 `book_knowledge_revisions` 并增加 book generation，`project` 写 `project_knowledge_revisions` 并增加 project generation；改变作用域时在同一事务中给旧 catalog 追加 inactive/superseded 修订，再向新 catalog 追加 active 修订；
6. 将旧 active run 行置 0，插入带 authority/evidence 元数据的新行，并校验列元数据与 revision authority 一致；
7. 创建以旧 snapshot 为 parent 的新 snapshot；
8. 将 run generation 增加 1，并把本事务实际改动的 applied book/project generation 更新为新值；
9. 写 `knowledge_user_commit` 事件；
10. 在 `knowledge_command_before_commit` 故障点后提交。

实现入口保持单事务、无嵌套事务：

```ts
commitKnowledgeCommands(input: CommitKnowledgeCommandsRequest): KnowledgeCommitResult {
  requireNonempty(input.requestId, "requestId");
  if (input.commands.length === 0) throw new TypeError("commands must not be empty");
  return this.#transaction(() => {
    const replay = this.#knowledgeCommandReplay(input);
    if (replay) return replay;
    const context = this.#prepareKnowledgeCommandContext(input);
    const result = this.#applyKnowledgeCommandsInOpenTransaction(context, input.commands);
    this.#checkpoint("knowledge_command_before_commit");
    return result;
  });
}
```

撤销不是删除旧行，而是以 `origin="rollback"` 创建一条恢复目标内容的新 revision。

`createTranslationRun` 从当前 source version 的 active `book_knowledge_revisions` 与 active `project_knowledge_revisions` 合并生成 run 内 revision 1 seed 和初始 snapshot，并把两个当前 catalog generation 记入 `knowledge_state`。catalog revision ID 只放入 authority provenance，不直接冒充 run revision ID。这样同一本书的新 run 继承书籍与项目知识，换 source version 的 run 只继承 project 知识。

现有 `promoteStagedWindow` 在确实追加模型 knowledge revisions 时也把 run generation 增加 1；只有翻译文本变化而知识不变时 generation 保持不变。这样工作台能发现后台扫描产生的新知识。

- [x] **步骤 5：增加空批次与幂等约束**

空 commands 必须报 `commands must not be empty`。同一 `requestId` 的成功命令重试应返回原结果：把 requestId 和结果记录在事件中，并在事务开始时查询；同一 requestId 携带不同 canonical payload 时返回 `KNOWLEDGE_REQUEST_REUSE_CONFLICT`。

事件 payload 固定保存请求哈希与结果：

```ts
interface KnowledgeCommandEventPayload {
  readonly requestId: string;
  readonly requestHash: string;
  readonly result: KnowledgeCommitResult;
}

function requireMatchingReplay(
  stored: KnowledgeCommandEventPayload,
  requestHash: string,
): KnowledgeCommitResult {
  if (stored.requestHash !== requestHash) {
    throw new Error("KNOWLEDGE_REQUEST_REUSE_CONFLICT");
  }
  return stored.result;
}
```

- [x] **步骤 6：运行命令和全套故障测试**

运行：

```powershell
node --test --import tsx test/knowledge-commands.test.ts test/fault-injection.test.ts test/lossless-book-store.test.ts
```

预期：PASS，无故障点留下半条 revision 或孤立 snapshot。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge/knowledge-commands.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test/knowledge-commands.test.ts translator-v5/test/fault-injection.test.ts
git commit -m "feat: add atomic knowledge commands"
```

## 任务 4：实现分页查询、证据、历史和影响

**文件：**

- 创建：`translator-v5/src/knowledge/knowledge-source-forms.ts`
- 创建：`translator-v5/src/knowledge/knowledge-query.ts`
- 修改：`translator-v5/src/storage/lossless-book-store.ts`
- 修改：`translator-v5/src/knowledge/translation-knowledge-projection.ts`
- 测试：`translator-v5/test/knowledge-query.test.ts`

- [x] **步骤 1：编写分页稳定性和影响失败测试**

```ts
test("uses an opaque stable cursor without duplicates after equal labels", () => {
  const fixture = queryFixture(["Archon", "archon", "Piaton"]);
  const first = fixture.query({ limit: 2, filters: {} });
  const second = fixture.query({ limit: 2, cursor: first.nextCursor, filters: {} });
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 3);
});

test("returns exact evidence and flags only translated matching blocks", () => {
  const fixture = translatedFixture();
  const saved = fixture.saveTerm("Piaton", "皮亚顿");
  const detail = fixture.detail(saved.objectId);
  assert.match(detail.evidence[0]?.sourceText ?? "", /Piaton/u);
  assert.deepEqual(detail.impacts.map((item) => item.globalIndex), [4, 9]);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/knowledge-query.test.ts
```

预期：FAIL，查询适配器和影响表写入尚不存在。

- [x] **步骤 3：抽取统一源形式**

把 `translation-knowledge-projection.ts` 中私有的源形式提取逻辑迁到职责单一的 `knowledge-source-forms.ts`：

```ts
export function sourceFormsFromRevision(revision: KnowledgeRevision): readonly string[];
```

只读取明确表示原文形式的字段（`sourceForm`、`sourceForms`、`canonicalSource`、`subjectForms`、`normalizedForms`），不得搜索事实散文。

- [x] **步骤 4：实现语义对象和游标**

定义：

```ts
export interface KnowledgeListQuery {
  readonly search?: string;
  readonly objectTypes?: readonly KnowledgeObjectType[];
  readonly statuses?: readonly KnowledgeStatus[];
  readonly origins?: readonly KnowledgeOrigin[];
  readonly scopes?: readonly KnowledgeScope[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface KnowledgeListItem {
  readonly id: string;
  readonly normalizedSubject: string;
  readonly displayName: string;
  readonly objectType: KnowledgeObjectType;
  readonly kind: string;
  readonly revision: number;
  readonly scopeRevision: KnowledgeCatalogExpectation | null;
  readonly status: KnowledgeStatus;
  readonly origin: KnowledgeOrigin;
  readonly scope: KnowledgeScope;
}
```

排序键固定为 `normalized_subject, kind, record_id`；游标是带 schema 字段的 base64url canonical JSON，非法、过期或不匹配筛选哈希的游标报 `KNOWLEDGE_CURSOR_INVALID`。

- [x] **步骤 5：在命令事务内写影响**

每条新 revision 取明确源形式，使用当前语言画像归一化后与 `logical_blocks.source_text` 做保守匹配；只对已有 active translation 的块写 `knowledge_block_impacts`。没有明确源形式的关系/记忆不制造全书影响。

```ts
function impactForms(revision: KnowledgeRevision): readonly string[] {
  return sourceFormsFromRevision(revision)
    .map((form) => normalizeForSourceLanguage(form))
    .filter((form) => form.length >= 2);
}

for (const block of store.activeTranslatedBlocks(runId)) {
  if (impactForms(revision).some((form) => block.normalizedSource.includes(form))) {
    store.insertKnowledgeImpactInOpenTransaction({
      runId,
      revisionId: revision.revisionId,
      sourceVersion: block.sourceVersion,
      blockId: block.blockId,
      reason: "explicit_source_form_match",
    });
  }
}
```

详情查询按需返回：

- 当前有效字段；
- revision history；
- candidate/source-window evidence；
- 原文块位置与短摘录；
- pending/acknowledged/retranslated impacts。

- [x] **步骤 6：运行查询和投影回归**

运行：

```powershell
node --test --import tsx test/knowledge-query.test.ts test/translation-request.test.ts test/memory-projection.test.ts
```

预期：PASS；分页结果稳定，投影字节预算不变，全文事实不会被误当成匹配关键词。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge/knowledge-source-forms.ts translator-v5/src/knowledge/knowledge-query.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/src/knowledge/translation-knowledge-projection.ts translator-v5/test/knowledge-query.test.ts
git commit -m "feat: query knowledge with evidence and impacts"
```

## 任务 5：让人工知识真实参与后续翻译

**文件：**

- 创建：`translator-v5/src/knowledge/persisted-style.ts`
- 修改：`translator-v5/src/knowledge/knowledge-store.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/src/agents/translation-request.ts`
- 测试：`translator-v5/test/book-runner.test.ts`
- 测试：`translator-v5/test/translation-request.test.ts`
- 测试：`translator-v5/test/structured-style.test.ts`

- [x] **步骤 1：编写术语、记忆和风格生效失败测试**

```ts
test("uses a manually locked term in the next pending window", async () => {
  const fixture = resumableBookFixture();
  fixture.commitTerm({
    sourceForm: "Archon",
    target: "阁下",
    policy: "locked",
  });
  await fixture.resumeOneWindow();
  assert.deepEqual(fixture.lastRequest().stableTerms.map((term) => term.target), ["阁下"]);
});

test("projects a manual narrative memory only when its source form is present", () => {
  const memory = manualMemoryRevision("Piaton", "皮亚顿控制这具身体的心跳");
  assert.equal(project([memory], ["Piaton moved his lips."]).revisions.length, 1);
  assert.equal(project([memory], ["The mountain was empty."]).revisions.length, 0);
});

test("merges a persisted style field without replacing the fixed protocol", () => {
  assert.deepEqual(persistedStyleFromKnowledge([styleRevision({
    technicalProse: "优先清楚说明概念关系",
  })]), { technicalProse: "优先清楚说明概念关系" });
});

test("syncs a book edit made through another run before resuming", async () => {
  const fixture = twoRunBookFixture();
  fixture.editThroughRun("run-a", {
    sourceForm: "Archon",
    target: "阁下",
    policy: "locked",
  });
  await fixture.resumeOneWindow("run-b");
  assert.equal(fixture.lastRequest("run-b").stableTerms[0]?.target, "阁下");
  assert.equal(fixture.runState("run-b").appliedBookGeneration, 1);
});

test("syncs project knowledge into a stale run from another source version", async () => {
  const fixture = twoSourceVersionFixture();
  fixture.editProjectKnowledge("run-a", {
    sourceForm: "Archon",
    target: "执政官",
    policy: "preferred",
  });
  await fixture.resumeOneWindow("run-b");
  assert.equal(fixture.lastRequest("run-b").stableTerms[0]?.target, "执政官");
  assert.equal(fixture.runState("run-b").appliedProjectGeneration, 1);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/book-runner.test.ts test/translation-request.test.ts test/structured-style.test.ts
```

预期：FAIL，人工 `term_sense` 和 `style_directive` 尚未进入 runner。

- [x] **步骤 3：统一人工术语表示**

人工术语保存为 `kind="lexical_anchor"`，payload 完整满足 `StableTerm`：

```ts
{
  conceptId: `user-${recordId}`,
  lexemeId: `user-${revisionId}`,
  sourceForm,
  canonicalSource,
  target,
  locked: policy === "locked",
  policy,
  note,
  origin: "knowledge"
}
```

修改 `termsFromKnowledge`：人工 authority 的 locked/preferred 值不经过 `softenModelAnchorTerm`，只有模型来源仍按现有降权逻辑处理。

- [x] **步骤 4：持久化风格只覆盖允许字段**

`persisted-style.ts` 只读取 active `kind="style_directive"`，允许字段与 `style-profile.ts` 的九个字段一致。按 `book > project > global`、`manual > import > model` 合并；同级冲突抛出 `PERSISTED_STYLE_CONFLICT`，不凭写入时间猜测。

在 `book-runner.ts` 每个波次构造：

```ts
const persistedStyle = persistedStyleFromKnowledge(snapshot.revisions);
const requestStyle = mergeStyleState(options.styleState, persistedStyle);
```

固定翻译协议不在可覆盖字段中。

在恢复/启动运行并进入第一波前调用 `store.syncScopedKnowledge(runId)`。该方法仅在没有 running/staged 窗口的安全边界执行；它分别比较当前 source version 的 book generation 和 singleton project generation 与 run 中的两个 applied generation，把较新的 active catalog 文档按任务 2 的权威规则合并并重基为该 run 的下一 revision。一次同步无论涉及一个还是两个 catalog，都只创建一个新 snapshot、只增加一次 run generation，并原子更新两个 applied generation；二者均相等时严格 no-op，不能每波制造重复 revision。

- [x] **步骤 5：验证模型候选不会覆盖人工值**

增加恢复运行测试：人工 revision 后出现冲突模型候选，完成窗口后最新 payload 的 owned target 仍为人工值；候选原始行仍在 `knowledge_candidates` 可审计。

```ts
test("keeps owned fields after a conflicting model candidate is promoted", async () => {
  const fixture = translatedRunWithManualTerm("Archon", "阁下");
  await fixture.promoteCandidate("Archon", { target: "执政官" });
  const latest = fixture.latestRevision("Archon", "lexical_anchor");
  assert.equal((latest.payload as { target: string }).target, "阁下");
  assert.equal(fixture.candidateHistory("Archon").at(-1)?.payload.target, "执政官");
});
```

- [x] **步骤 6：运行翻译核心回归**

运行：

```powershell
node --test --import tsx test/book-runner.test.ts test/translation-request.test.ts test/structured-style.test.ts test/knowledge-authority.test.ts
```

预期：PASS；人工术语进入 stable terms，叙事记忆按位置开放，风格不改变工具协议。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/knowledge/persisted-style.ts translator-v5/src/knowledge/knowledge-store.ts translator-v5/src/fullbook/book-runner.ts translator-v5/src/agents/translation-request.ts translator-v5/test/book-runner.test.ts translator-v5/test/translation-request.test.ts translator-v5/test/structured-style.test.ts
git commit -m "feat: apply edited knowledge during translation"
```

## 任务 6：实现用户级通用术语库

**文件：**

- 创建：`translator-v5/src/knowledge/global-knowledge-store.ts`
- 修改：`translator-v5/src/knowledge/knowledge-commands.ts`
- 测试：`translator-v5/test/global-knowledge-store.test.ts`

- [x] **步骤 1：编写提升、重启和类型限制失败测试**

```ts
test("promotes a book term and reopens the same global revision", () => {
  const path = fixturePath("global-knowledge.db");
  const first = new GlobalKnowledgeStore(path);
  const promoted = first.promote(termRevision(), { expectedRevision: null });
  first.close();

  const reopened = new GlobalKnowledgeStore(path);
  assert.deepEqual(reopened.get(promoted.recordId), promoted);
  reopened.close();
});

test("rejects narrative memory promotion to the global library", () => {
  const store = new GlobalKnowledgeStore(fixturePath("global-knowledge.db"));
  assert.throws(() => store.promote(memoryRevision(), { expectedRevision: null }), /GLOBAL_SCOPE_FORBIDDEN/u);
});

test("lists reusable terms and attaches an immutable snapshot to another project", () => {
  const library = globalFixtureWith(termRevision());
  const target = emptyProjectFixture();
  const [entry] = library.list({ search: "Archon", limit: 20 });
  const attached = target.attachGlobal(entry!.recordId, entry!.revision);
  library.promote(updatedTermRevision(), { expectedRevision: entry!.revision });
  assert.equal(target.detail(attached.objectId).fields.target, "执政官");
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/global-knowledge-store.test.ts
```

预期：FAIL，`GlobalKnowledgeStore` 不存在。

- [x] **步骤 3：实现独立 SQLite 修订库**

全局库路径由主进程固定为 `app.getPath("userData")/global-knowledge.db`，schema 只含：

```sql
CREATE TABLE global_knowledge_revisions(
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  revision_id TEXT NOT NULL UNIQUE,
  object_type TEXT NOT NULL CHECK(object_type IN ('term', 'style')),
  normalized_subject TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(record_id, revision)
) STRICT;

CREATE TABLE global_knowledge_events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('promoted', 'attached', 'unattached')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(record_id, revision)
    REFERENCES global_knowledge_revisions(record_id, revision) ON DELETE RESTRICT
) STRICT;
```

只允许 `term` 和 `style`。提升时复制经过验证的语义文档，不保存项目路径、原文证据或运行 ID。

- [x] **步骤 4：把全局条目快照回当前项目**

当用户选择“保存为通用术语”时：

1. 在全局库写修订；
2. 在当前 source version 的 `book_knowledge_revisions` 以 `scope="global"` 创建引用快照 revision，并通过正常命令事务投影到当前 run；
3. 当前项目保存全局 revision ID 和完整 payload，保证离线可复现；
4. 两个数据库不能形成跨库事务，因此先写全局，再写项目；项目写失败时写一条全局 `unattached` 审计状态，下一次操作可重试，不删除全局成功数据。

全局库提供分页 `list` 和按 revision 读取。另一个项目选择条目后，把指定 revision 的完整文档以 `origin="import"`、`scope="global"` 快照进该书的 book catalog 与当前知识链；全局库后续更新不会静默改变已附加项目，界面可显式选择升级。

```ts
function attachGlobalRevision(
  project: LosslessBookStore,
  runId: string,
  global: GlobalKnowledgeRevision,
  expected: KnowledgeState,
): KnowledgeCommitResult {
  return project.commitKnowledgeCommands({
    requestId: `attach-global:${global.revisionId}`,
    runId,
    expectedGeneration: expected.generation,
    expectedSnapshotId: expected.snapshotId,
    commands: [commandFromGlobalSnapshot(global)],
  });
}
```

- [x] **步骤 5：运行全局库测试**

运行：

```powershell
node --test --import tsx test/global-knowledge-store.test.ts test/knowledge-commands.test.ts
```

预期：PASS；重启后仍可读取，剧情记忆/人物关系无法提升。

- [x] **步骤 6：Commit**

```powershell
git add translator-v5/src/knowledge/global-knowledge-store.ts translator-v5/src/knowledge/knowledge-commands.ts translator-v5/test/global-knowledge-store.test.ts
git commit -m "feat: add reusable global terminology"
```

## 任务 7：建立桌面知识服务与严格 IPC 合约

**文件：**

- 创建：`translator-v5/src/desktop/knowledge-contracts.ts`
- 创建：`translator-v5/src/desktop/desktop-knowledge-service.ts`
- 修改：`translator-v5/src/desktop/contracts.ts`
- 修改：`translator-v5/src/desktop/desktop-project-service.ts`
- 测试：`translator-v5/test/desktop-knowledge-service.test.ts`

- [x] **步骤 1：编写路径隔离与持久化失败测试**

```ts
test("resolves the store and run only from the current trusted project", () => {
  const service = fixtureService();
  const page = service.list({ limit: 50, filters: {} });
  assert.equal(page.ok, true);
  assert.equal(JSON.stringify(page).includes("book.db"), false);
});

test("persists an edit and returns the newer generation after restart", () => {
  const fixture = fixtureService();
  const page = unwrap(fixture.service.list({ limit: 20, filters: {} }));
  unwrap(fixture.service.mutate(termMutation(page.generation)));

  const reopened = fixture.reopen();
  const next = unwrap(reopened.list({ limit: 20, filters: {} }));
  assert.equal(next.generation, page.generation + 1);
  assert.equal(next.items[0]?.displayValue, "阁下");
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/desktop-knowledge-service.test.ts
```

预期：FAIL，服务和合约不存在。

- [x] **步骤 3：定义 renderer-safe 合约**

`knowledge-contracts.ts` 定义：

```ts
export interface DesktopKnowledgeListRequest {
  readonly search?: string;
  readonly objectTypes?: readonly KnowledgeObjectType[];
  readonly statuses?: readonly KnowledgeStatus[];
  readonly origins?: readonly KnowledgeOrigin[];
  readonly scopes?: readonly KnowledgeScope[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DesktopKnowledgeMutationRequest {
  readonly requestId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly command: UpdateKnowledgeCommand | RollbackKnowledgeCommand;
}

export interface DesktopPromoteKnowledgeRequest {
  readonly requestId: string;
  readonly objectId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface DesktopGlobalKnowledgeListRequest {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface DesktopGlobalKnowledgePage {
  readonly items: readonly {
    readonly recordId: string;
    readonly revision: number;
    readonly objectType: "term" | "style";
    readonly normalizedSubject: string;
    readonly displayValue: string;
  }[];
  readonly nextCursor?: string;
}

export interface DesktopAttachGlobalKnowledgeRequest {
  readonly requestId: string;
  readonly recordId: string;
  readonly revision: number;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface DesktopKnowledgePage {
  readonly generation: number;
  readonly snapshotId: string;
  readonly items: readonly KnowledgeListItem[];
  readonly nextCursor?: string;
}

export interface DesktopKnowledgeEvidence {
  readonly kind: KnowledgeEvidence["kind"];
  readonly globalIndex?: number;
  readonly canonicalStart?: number;
  readonly canonicalEnd?: number;
  readonly sourceText?: string;
}

export interface DesktopKnowledgeDetail {
  readonly item: KnowledgeListItem;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly evidence: readonly DesktopKnowledgeEvidence[];
  readonly history: readonly {
    readonly revision: number;
    readonly revisionId: string;
    readonly origin: KnowledgeOrigin;
    readonly scope: KnowledgeScope;
    readonly createdAt: string;
  }[];
  readonly impacts: readonly {
    readonly blockId: string;
    readonly globalIndex: number;
    readonly status: "pending" | "acknowledged" | "retranslated";
  }[];
  readonly relations: readonly {
    readonly subjectId: string;
    readonly predicate: string;
    readonly objectId: string;
  }[];
}

export interface DesktopKnowledgeMutationResult {
  readonly generation: number;
  readonly snapshotId: string;
  readonly detail: DesktopKnowledgeDetail;
}

export interface DesktopKnowledgeDiagnostics {
  readonly schemaVersion: number;
  readonly knowledgeGeneration: number;
  readonly countsByType: Readonly<Record<string, number>>;
  readonly countsByStatus: Readonly<Record<string, number>>;
  readonly pendingImpacts: number;
  readonly latestMigration: string;
  readonly advanced?: {
    readonly tables: readonly {
      readonly name: string;
      readonly rowCount: number;
    }[];
    readonly recentEvents: readonly {
      readonly kind: string;
      readonly createdAt: string;
    }[];
    readonly integrityCheck: "ok";
  };
}
```

响应只含 opaque object ID、短证据、页游标和语义字段；不得包含 `storePath`、`manifestPath`、SQL、API Key 或任意文件句柄。

- [x] **步骤 4：让项目服务解析可信目标**

在 `DesktopProjectService` 增加只供主进程调用的方法：

```ts
resolveKnowledgeTarget(request: DesktopProjectRequest): DesktopResult<{
  storePath: string;
  runId: string;
  sourceVersion: string;
  sourceLanguage: string;
}>;
```

它复用现有 manifest/store/run 校验；无状态库、无匹配运行或多运行未选择时返回稳定错误码，不接受渲染进程路径。

- [x] **步骤 5：实现 DesktopKnowledgeService**

每次操作：

1. 从闭包读取 current request；
2. 通过 `resolveKnowledgeTarget` 得到可信路径；
3. 首次进入工作台时用 read-write store 完成受测的 v2→v3 升级并立即关闭；
4. 查询时重新打开 read-only snapshot，写入时打开 read-write store；
5. 调用 query/command；
6. `finally` 关闭；
7. 通过 `toDesktopError` 返回普通错误。

列表/详情使用只读快照，写入使用 read-write store。全局提升由注入的 `GlobalKnowledgeStore` 完成。

```ts
export class DesktopKnowledgeService {
  constructor(
    private readonly projects: DesktopProjectService,
    private readonly globals: GlobalKnowledgeStore,
    private readonly getCurrentRequest: () => DesktopProjectRequest | undefined,
  ) {}

  list(request: DesktopKnowledgeListRequest): DesktopResult<DesktopKnowledgePage> {
    return this.#withCurrentStore("read-only", (store, target) =>
      ok(queryKnowledgePage(store, target.runId, request)));
  }

  save(request: DesktopKnowledgeMutationRequest): DesktopResult<DesktopKnowledgeMutationResult> {
    return this.#withCurrentStore("read-write", (store, target) =>
      ok(store.commitKnowledgeCommands(toCommitRequest(target.runId, request))));
  }
}
```

`#withCurrentStore` 只调用注入的 `getCurrentRequest()`，再把结果交给 `resolveKnowledgeTarget`；renderer 的知识 IPC 请求中没有 manifest/store 路径字段。

- [x] **步骤 6：运行服务与安全测试**

运行：

```powershell
node --test --import tsx test/desktop-knowledge-service.test.ts test/desktop-project-service.test.ts
```

预期：PASS；响应 JSON 中无本地绝对路径。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/desktop/knowledge-contracts.ts translator-v5/src/desktop/desktop-knowledge-service.ts translator-v5/src/desktop/contracts.ts translator-v5/src/desktop/desktop-project-service.ts translator-v5/test/desktop-knowledge-service.test.ts
git commit -m "feat: add trusted desktop knowledge service"
```

## 任务 8：接通 IPC、preload 与主进程

**文件：**

- 修改：`translator-v5/src/desktop/main/ipc.ts`
- 修改：`translator-v5/src/desktop/main/index.ts`
- 修改：`translator-v5/src/desktop/preload/index.ts`
- 修改：`translator-v5/src/desktop/preload/folioloom-api.d.ts`
- 测试：`translator-v5/test/desktop-ipc.test.ts`
- 测试：`translator-v5/test/desktop-main-security.test.ts`

- [x] **步骤 1：编写通道和恶意载荷失败测试**

```ts
test("rejects knowledge mutation payloads containing a path or SQL", async () => {
  const fixture = ipcFixture();
  for (const extra of [
    { storePath: "C:\\other\\book.db" },
    { sql: "UPDATE knowledge_records SET active=0" },
  ]) {
    const result = await fixture.invoke("folioloom:knowledge-mutate", {
      ...validMutation(),
      ...extra,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "DESKTOP_INPUT_INVALID");
  }
});

test("does not expose generic invoke or raw database methods in preload", () => {
  assert.equal("invoke" in exposedApi(), false);
  assert.equal("querySql" in exposedApi(), false);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts
```

预期：FAIL，知识通道和 preload 方法尚未注册。

- [x] **步骤 3：增加有限通道**

只加入：

```ts
"folioloom:knowledge-list"
"folioloom:knowledge-detail"
"folioloom:knowledge-mutate"
"folioloom:knowledge-promote-global"
"folioloom:knowledge-global-list"
"folioloom:knowledge-global-attach"
"folioloom:knowledge-diagnostics"
```

所有 payload 使用 `exactRecord`、枚举白名单、长度/limit 上限和 UUID requestId 校验。详情只接收 opaque `objectId`；诊断不接收 SQL。

- [x] **步骤 4：暴露窄 preload API**

```ts
listKnowledge(request): Promise<DesktopResult<DesktopKnowledgePage>>;
getKnowledgeDetail(objectId): Promise<DesktopResult<DesktopKnowledgeDetail>>;
mutateKnowledge(request): Promise<DesktopResult<DesktopKnowledgeMutationResult>>;
promoteKnowledgeToGlobal(request): Promise<DesktopResult<DesktopKnowledgeMutationResult>>;
listGlobalKnowledge(request): Promise<DesktopResult<DesktopGlobalKnowledgePage>>;
attachGlobalKnowledge(request): Promise<DesktopResult<DesktopKnowledgeMutationResult>>;
getKnowledgeDiagnostics(): Promise<DesktopResult<DesktopKnowledgeDiagnostics>>;
```

主进程在 `app.whenReady` 后构造全局库和 `DesktopKnowledgeService`，退出时关闭全局库。

- [x] **步骤 5：运行 IPC、preload 和构建测试**

运行：

```powershell
node --test --import tsx test/desktop-ipc.test.ts test/desktop-main-security.test.ts test/desktop-build-config.test.ts
npm run desktop:typecheck
```

预期：PASS；TypeScript 不允许 renderer 构造数据库路径参数。

- [x] **步骤 6：Commit**

```powershell
git add translator-v5/src/desktop/main/ipc.ts translator-v5/src/desktop/main/index.ts translator-v5/src/desktop/preload/index.ts translator-v5/src/desktop/preload/folioloom-api.d.ts translator-v5/test/desktop-ipc.test.ts translator-v5/test/desktop-main-security.test.ts
git commit -m "feat: expose safe knowledge IPC"
```

## 任务 9：交付可浏览的知识工作台

**文件：**

- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeTable.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeDetailDrawer.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/App.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/Sidebar.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/types.ts`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`
- 测试：`translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.test.tsx`

- [x] **步骤 1：编写侧栏、分页和详情失败测试**

```tsx
it("opens the real knowledge workspace only for a ready selected run", async () => {
  const user = userEvent.setup();
  render(<App api={knowledgeReadyApi()} />);
  const memory = await screen.findByRole("button", { name: "术语与记忆" });
  expect((memory as HTMLButtonElement).disabled).toBe(false);
  await user.click(memory);
  expect(await screen.findByRole("heading", { name: "术语与记忆" })).toBeTruthy();
});

it("loads the next page without replacing the selected detail", async () => {
  const user = userEvent.setup();
  render(<KnowledgeWorkbench api={pagedApi()} />);
  await user.click(await screen.findByRole("row", { name: /Piaton 皮亚顿/u }));
  await user.click(screen.getByRole("button", { name: "加载更多" }));
  expect(screen.getByRole("heading", { name: "皮亚顿" })).toBeTruthy();
});
```

- [x] **步骤 2：运行组件测试确认失败**

运行：

```powershell
npx vitest run --config vitest.desktop.config.ts KnowledgeWorkbench
```

预期：FAIL，组件不存在，侧栏仍禁用。

- [x] **步骤 3：实现工作台状态机**

`KnowledgeWorkbench` 维护：

```ts
type KnowledgeViewState =
  | { status: "loading" }
  | { status: "ready"; page: DesktopKnowledgePage; selectedId?: string }
  | { status: "empty"; generation: number; snapshotId: string }
  | { status: "failed"; error: DesktopError };
```

搜索和筛选变化时丢弃旧 cursor；请求带本地 nonce，迟到响应不能覆盖新筛选。列表保留当前已选 ID，详情独立加载并可关闭。

- [x] **步骤 4：实现表格与详情抽屉**

表格列为原文形式、当前译法/名称、类型、作用域、状态、来源、修订。长表格使用固定 44 px 行高、滚动容器、前后各 8 行 overscan 和游标“加载更多”；`KnowledgeTable` 只渲染可见窗口，不引入第三方虚拟列表。

详情抽屉分区：

- 当前字段；
- 原文证据；
- 相关别名/关系；
- 版本历史；
- 受影响文本块。

证据与历史由详情请求按需加载，关闭抽屉后清理。

```tsx
return (
  <section className="knowledge-workbench">
    <KnowledgeFilters value={filters} onChange={replaceFilters} />
    <KnowledgeTable
      items={state.page.items}
      nextCursor={state.page.nextCursor}
      selectedId={state.selectedId}
      onSelect={openDetail}
      onLoadMore={loadMore}
      rowHeight={44}
      overscan={8}
    />
    {detail ? <KnowledgeDetailDrawer detail={detail} onClose={closeDetail} /> : null}
  </section>
);
```

- [x] **步骤 5：启用侧栏并保持无项目边界**

`Sidebar` 的 available 条件：

```ts
const available = workspace.id === "overview"
  || (workspace.id === "memory" && knowledgeAvailable);
```

`knowledgeAvailable` 仅在 store ready 且 `selectedRunId` 存在时为 true。更换书稿后若失去知识目标，App 自动回到 overview 并清空工作台状态。

- [x] **步骤 6：运行组件与布局测试**

运行：

```powershell
npm run desktop:test
```

预期：PASS；无项目时入口禁用，有项目时可浏览，筛选迟到响应不会覆盖当前状态。

- [x] **步骤 7：Commit**

```powershell
git add translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeTable.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeDetailDrawer.tsx translator-v5/src/desktop/renderer/src/App.tsx translator-v5/src/desktop/renderer/src/App.test.tsx translator-v5/src/desktop/renderer/src/components/Sidebar.tsx translator-v5/src/desktop/renderer/src/types.ts translator-v5/src/desktop/renderer/src/styles.css translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.test.tsx
git commit -m "feat: add desktop knowledge workbench"
```

## 任务 10：加入编辑、撤销、全局提升与只读诊断

**文件：**

- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeEditor.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeDiagnostics.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/KnowledgeRelationGraph.tsx`
- 创建：`translator-v5/src/desktop/renderer/src/components/GlobalKnowledgePicker.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/KnowledgeDetailDrawer.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.test.tsx`
- 修改：`translator-v5/src/desktop/renderer/src/styles.css`
- 修改：`translator-v5/README.md`

- [x] **步骤 1：编写编辑、冲突和撤销失败测试**

```tsx
it("saves a term, refreshes generation and keeps the drawer open", async () => {
  const user = userEvent.setup();
  const api = editableApi();
  render(<KnowledgeWorkbench api={api} />);
  await user.click(await screen.findByRole("row", { name: /Archon/u }));
  await user.clear(screen.getByLabelText("首选译法"));
  await user.type(screen.getByLabelText("首选译法"), "阁下");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  expect(await screen.findByText("修改已保存")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Archon" })).toBeTruthy();
});

it("shows a generation conflict without discarding the draft", async () => {
  const user = userEvent.setup();
  render(<KnowledgeWorkbench api={conflictingApi()} />);
  await openAndEdit(user, "Archon", "阁下");
  expect(await screen.findByText("这条知识已在其他位置更新")).toBeTruthy();
  expect((screen.getByLabelText("首选译法") as HTMLInputElement).value).toBe("阁下");
});

it("attaches an explicitly selected global revision to this book", async () => {
  const user = userEvent.setup();
  const api = globalLibraryApi();
  render(<KnowledgeWorkbench api={api} />);
  await user.click(await screen.findByRole("button", { name: "添加通用术语" }));
  await user.click(await screen.findByRole("checkbox", { name: /Archon.*revision 3/u }));
  await user.click(screen.getByRole("button", { name: "添加到当前书" }));
  expect(api.attachGlobalKnowledge).toHaveBeenCalledWith(expect.objectContaining({
    recordId: "global-archon",
    revision: 3,
  }));
});
```

- [x] **步骤 2：运行组件测试确认失败**

运行：

```powershell
npx vitest run --config vitest.desktop.config.ts KnowledgeWorkbench
```

预期：FAIL，编辑器和诊断组件不存在。

- [x] **步骤 3：实现六类语义表单**

`KnowledgeEditor` 按 objectType 显示白名单字段。保存请求只发送发生变化的字段及对应 ownedFields；原文证据只可选择已有证据或填写位置明确的新证据，不能把整段自由文本当作 SQL/路径。

保存中锁定当前表单；成功后用返回的 generation/snapshot/detail 原子替换；失败保留草稿。generation conflict 提供“重新载入”和“复制草稿”两个动作，不自动覆盖。

```ts
const EDITABLE_FIELDS: Readonly<Record<KnowledgeObjectType, readonly string[]>> = {
  term: ["sourceForm", "target", "alternatives", "policy", "note", "scope"],
  entity: ["canonicalName", "targetName", "entityType", "description", "scope"],
  alias: ["alias", "entityId", "context", "scope"],
  relation: ["fromEntityId", "relationType", "toEntityId", "position", "scope"],
  memory: ["summary", "startBlockId", "endBlockId", "entities", "scope"],
  style: ["narrativeDistance", "dialogueRegister", "technicalProse", "scope"],
};

const fieldPatch = diffEditableFields(initial, draft, EDITABLE_FIELDS[detail.objectType]);
const ownedFields = Object.keys(fieldPatch).map((field) => `/${escapeJsonPointer(field)}`);
```

- [x] **步骤 4：实现撤销和全局提升**

历史行“恢复此版本”发 rollback command，并清楚提示它会创建新修订。只有 term/style 显示“保存为通用术语/风格”；提升前列出不随之复制的书内证据。

影响列表只读展示当前状态；状态由后续审阅/重译流程更新，本轮既不伪造“已知悉”操作，也不自动触发重译。

`GlobalKnowledgePicker` 分页列出通用 term/style，用户勾选具体 revision 后调用 attach；附加前显示“当前项目将保存这一版本的副本，未来不会自动漂移”。同一全局 revision 重复附加保持幂等。

```ts
async function restoreRevision(targetRevision: number): Promise<void> {
  await api.rollbackKnowledge({
    objectId: detail.id,
    expectedGeneration: page.generation,
    expectedSnapshotId: page.snapshotId,
    expectedRevision: detail.revision,
    expectedScopeRevision: detail.scopeRevision,
    targetRevision,
  });
}

async function attachGlobal(recordId: string, revision: number): Promise<void> {
  await api.attachGlobalKnowledge({
    recordId,
    revision,
    expectedGeneration: page.generation,
    expectedSnapshotId: page.snapshotId,
  });
}
```

- [x] **步骤 5：实现固定只读诊断**

诊断组件只显示服务返回的：

```ts
{
  schemaVersion,
  knowledgeGeneration,
  countsByType,
  countsByStatus,
  pendingImpacts,
  latestMigration,
  advanced?: {
    tables: [{ name, rowCount }],
    recentEvents: [{ kind, createdAt }],
    integrityCheck: "ok",
  },
}
```

默认只显示顶层摘要；用户打开“高级只读诊断”后，服务才返回 schema v3 固定 allowlist 表的名称/行数、最近 20 条事件的 kind/时间和 `PRAGMA integrity_check` 结果。界面没有 SQL 输入框，也没有任意表名、PRAGMA 或查询参数。

- [x] **步骤 6：实现有界局部关系图**

`KnowledgeRelationGraph` 只接收详情响应中的邻接点，不自行查询数据库。默认展示当前对象和一层关系，用户展开后最多两层、最多 40 个节点；超过上限显示“还有更多关系，请用表格筛选查看”。节点点击只切换当前详情，关系创建和修改仍使用结构化表单。

```tsx
const MAX_RELATION_DEPTH = 2;
const MAX_RELATION_NODES = 40;
const visible = boundedBreadthFirst(detail.relationNeighborhood, {
  rootId: detail.id,
  depth: expanded ? MAX_RELATION_DEPTH : 1,
  limit: MAX_RELATION_NODES,
});
return <RelationCanvas nodes={visible.nodes} edges={visible.edges} onNodeClick={onSelect} />;
```

- [x] **步骤 7：运行桌面全套和构建**

运行：

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
```

预期：全部 PASS，Electron 构建产物通过 preload/renderer 安全检查。

- [x] **步骤 8：更新用户文档**

在 `translator-v5/README.md` 增加：

- 如何进入“术语与记忆”；
- 修改默认只影响当前书；
- 如何提升为通用术语；
- 修改何时影响后续翻译；
- 已译块只会被标记，不会自动改写；
- 高级诊断只读。

使用以下小节标题，避免把 SQLite 或内部协议当成用户入口：

```markdown
## 术语与记忆工作台
### 查看和修改当前书知识
### 在项目中复用知识
### 保存和附加通用术语
### 修改后的翻译影响
### 只读诊断
```

- [x] **步骤 9：Commit**

```powershell
git add translator-v5/src/desktop/renderer/src/components/KnowledgeEditor.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeDiagnostics.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeRelationGraph.tsx translator-v5/src/desktop/renderer/src/components/GlobalKnowledgePicker.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeDetailDrawer.tsx translator-v5/src/desktop/renderer/src/components/KnowledgeWorkbench.test.tsx translator-v5/src/desktop/renderer/src/styles.css translator-v5/README.md
git commit -m "feat: edit and audit desktop knowledge"
```

## 任务 11：核心阶段验收

**文件：**

- 创建：`docs/superpowers/reports/2026-07-23-knowledge-workbench-validation.md`

- [x] **步骤 1：运行确定性持久化验收**

建立一个临时项目并执行：

1. 打开已有 run；
2. 把 `Archon` 的 book-scope 译法改为“阁下”；
3. 关闭应用并重开；
4. 确认修改、历史和 generation 不变；
5. 恢复旧版本；
6. 确认产生新 revision 而不是删除历史。

记录 revision ID、snapshot ID 和 generation，不记录书稿正文或本机绝对路径。

运行：

```powershell
node --test --import tsx --test-name-pattern="reopens user knowledge|rollback appends|seeds a later run|different source version" test/knowledge-commands.test.ts test/desktop-knowledge-service.test.ts
```

预期：PASS，进程重开后 book/project catalog、当前快照和历史一致。

- [x] **步骤 2：运行翻译投影验收**

用只含两个小块的合成书：

- 一个块包含 `Archon`；
- 一个块不包含该词；
- 保存 locked 人工术语；
- 恢复运行一波。

断言仅匹配块收到该术语，模型候选不能覆盖人工 target，未匹配块不承担额外 prompt。

运行：

```powershell
node --test --import tsx --test-name-pattern="manual term|conflicting model candidate|syncs book|syncs project" test/book-runner.test.ts test/translation-request.test.ts test/knowledge-authority.test.ts
```

预期：PASS，两个合成块的请求投影与断言一致。

- [x] **步骤 3：运行安全与性能验收**

运行：

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
```

再用 50,000 条合成知识记录测量：

- 首屏 50 条查询低于 250 ms；
- 后续游标页低于 250 ms；
- 详情读取低于 250 ms；
- renderer 响应中不出现数据库路径。

若机器不满足时间阈值，测试报告必须记录实际时间并停止合并，不能放宽断言掩盖索引问题。

- [x] **步骤 4：写验证报告**

创建 `docs/superpowers/reports/2026-07-23-knowledge-workbench-validation.md`，列出命令、通过数量、迁移 fixture、性能数字、已知非 P0/P1 限制。不得使用“应该可用”替代实测结果。

报告结构固定为：

```markdown
# 知识工作台验证报告
## 构建与测试命令
## schema v2→v3 迁移与故障回滚
## book/project/global 持久化
## 翻译投影与已译块影响
## IPC 与桌面安全边界
## 50,000 条记录性能
## 非 P0/P1 限制
```

- [x] **步骤 5：Commit**

```powershell
git add docs/superpowers/reports/2026-07-23-knowledge-workbench-validation.md
git commit -m "docs: validate knowledge workbench core"
```
