# 稀疏快照重验实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让概念知识变化只失效实际包含该概念且使用旧快照的译文块，并以《变形记》十万德文字符证明术语收敛、并行安全和严格导出。

**架构：** 在现有追加式知识快照之上增加闭合的词汇概念投影、概念出现索引、译文概念绑定和稀疏重验任务。翻译工具返回正文之外的 `termUsages`；提交门按最新渲染指纹验证，知识变化只查询旧绑定。严格审计要求不存在过时绑定，字符正字规范化继续在每块提交前完成。

**技术栈：** TypeScript 7、Node.js 24、`node:sqlite`、TypeBox 工具 schema、OpenCC、Node test runner、现有 Pi translation harness。

---

## 文件结构

### 新建

- `folioloom/src/storage/book-schema-v4.ts`：schema v4 表、索引、marker 与 fingerprint。
- `folioloom/src/knowledge/lexical-concept.ts`：闭合概念 schema、渲染指纹、候选归一化。
- `folioloom/src/knowledge/concept-occurrence-index.ts`：把概念词形批量映射到原文块和偏移。
- `folioloom/src/knowledge/term-usage.ts`：预期出现、模型使用回执和确定性策略校验。
- `folioloom/src/knowledge/sparse-revalidation.ts`：纯函数影响过滤、任务合并和动作判定。
- `folioloom/test/book-schema-v4.test.ts`
- `folioloom/test/lexical-concept.test.ts`
- `folioloom/test/concept-occurrence-index.test.ts`
- `folioloom/test/term-usage.test.ts`
- `folioloom/test/sparse-revalidation.test.ts`

### 修改

- `folioloom/src/storage/lossless-book-store.ts`：v3→v4 迁移、概念/出现/绑定/任务事务。
- `folioloom/src/domain/types.ts`：扩充 `StableTerm`，增加概念语义和允许实现。
- `folioloom/src/agents/lexical-anchorer.ts`：把语境化职位/技术词生成可见概念，不把普通词升级。
- `folioloom/src/knowledge/stable-terms-from-knowledge.ts`：读取闭合 `lexical_concept`。
- `folioloom/src/agents/translation-request.ts`：准备预期术语出现并扩充工具 schema。
- `folioloom/src/agents/translation-batch.ts`：解析、校验和修复 `termUsages`。
- `folioloom/src/fullbook/book-runner.ts`：波次概念收束、提交门和稀疏重验循环。
- `folioloom/src/style/chinese-script-normalization.ts`：补齐通用简体兼容字规范。
- `folioloom/src/report.ts`：报告结构完成、知识收敛和严格导出条件。
- `folioloom/test/book-runner.test.ts`
- `folioloom/test/translation-request.test.ts`
- `folioloom/test/translation-batch.test.ts`
- `folioloom/test/lossless-audit.test.ts`
- `folioloom/test/chinese-script-normalization.test.ts`

## 任务 1：建立 schema v4 和可回滚迁移

**文件：**
- 创建：`folioloom/src/storage/book-schema-v4.ts`
- 创建：`folioloom/test/book-schema-v4.test.ts`
- 修改：`folioloom/src/storage/lossless-book-store.ts`

- [x] **步骤 1：编写 v3→v4 迁移失败测试**

测试必须建立真实 v3 数据库，写入一条活动译文和知识修订，读写打开后断言：

```ts
assert.equal(database.prepare("PRAGMA user_version").get().user_version, 4);
assert.deepEqual(tableNames(database), [
  ...LOSSLESS_BOOK_SCHEMA_TABLES,
].sort());
assert.equal(activeTranslationText(database), "原有译文");
assert.equal(database.prepare(
  "SELECT COUNT(*) AS count FROM concept_occurrences",
).get().count, 0);
```

同时加入只读不迁移、故障注入完整回滚和第二次打开幂等测试。

- [x] **步骤 2：运行测试确认失败**

运行：

```powershell
npm test -- --test-name-pattern="schema v4"
```

预期：FAIL，缺少 `book-schema-v4.ts` 或 `user_version` 仍为 3。

- [x] **步骤 3：定义 schema v4**

`book-schema-v4.ts` 必须从 v3 追加以下表：

```sql
CREATE TABLE lexical_concepts(
  run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  revision_id TEXT NOT NULL,
  normalized_subject TEXT NOT NULL,
  source_forms_json TEXT NOT NULL CHECK(json_valid(source_forms_json)),
  semantic_class TEXT NOT NULL,
  canonical_target TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('locked','preferred','contextual')),
  allowed_realizations_json TEXT NOT NULL CHECK(json_valid(allowed_realizations_json)),
  visibility TEXT NOT NULL CHECK(visibility IN ('translator_global','narrative_before_target')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  render_fingerprint TEXT NOT NULL CHECK(length(render_fingerprint)=64),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(run_id, concept_id, revision),
  UNIQUE(run_id, revision_id)
) STRICT;

CREATE TABLE concept_occurrences(
  run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  block_id TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK(occurrence_count >= 1),
  source_spans_json TEXT NOT NULL CHECK(json_valid(source_spans_json)),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(run_id, concept_id, block_id),
  FOREIGN KEY(source_version, block_id)
    REFERENCES logical_blocks(source_version, block_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE translation_concept_bindings(
  translation_id INTEGER NOT NULL REFERENCES translations(translation_id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  applied_revision_id TEXT NOT NULL,
  applied_render_fingerprint TEXT NOT NULL CHECK(length(applied_render_fingerprint)=64),
  term_usages_json TEXT NOT NULL CHECK(json_valid(term_usages_json)),
  validation_status TEXT NOT NULL
    CHECK(validation_status IN ('clean','pending','validating','stale','warning_stale')),
  validated_revision_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(translation_id, concept_id)
) STRICT;

CREATE TABLE knowledge_revalidation_tasks(
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES translation_runs(run_id) ON DELETE CASCADE,
  translation_id INTEGER NOT NULL REFERENCES translations(translation_id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  change_set_hash TEXT NOT NULL CHECK(length(change_set_hash)=64),
  from_snapshot_id TEXT NOT NULL,
  to_snapshot_id TEXT NOT NULL,
  concept_ids_json TEXT NOT NULL CHECK(json_valid(concept_ids_json)),
  status TEXT NOT NULL
    CHECK(status IN ('pending','validating','resolved_noop','resolved_repair',
                     'resolved_retranslate','completed_with_warning')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  result_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(result_json)),
  replacement_translation_id INTEGER REFERENCES translations(translation_id),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  resolved_at TEXT,
  UNIQUE(translation_id, change_set_hash)
) STRICT;
```

添加 active concept、occurrence 查询、binding 状态和任务状态索引。

- [x] **步骤 4：实现迁移**

在 `LosslessBookStore` 打开逻辑中：

```ts
if (userVersion === LOSSLESS_BOOK_SCHEMA_V3_VERSION) {
  if (readOnly) {
    this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_V3_VERSION;
  } else {
    this.#migrateV3ToV4();
    this.#schemaVersion = LOSSLESS_BOOK_SCHEMA_VERSION;
  }
}
```

迁移在 `BEGIN IMMEDIATE` 内核验 v3 marker/fingerprint、执行 extension、
写 v4 marker/fingerprint 和 `PRAGMA user_version=4`。任何 checkpoint
异常必须回滚。

- [x] **步骤 5：运行测试验证通过**

```powershell
npm test -- --test-name-pattern="schema v4"
npm run typecheck
```

预期：v4 测试全部 PASS，类型检查 exit 0。

- [ ] **步骤 6：Commit**

```powershell
git add folioloom/src/storage/book-schema-v4.ts folioloom/src/storage/lossless-book-store.ts folioloom/test/book-schema-v4.test.ts
git commit -m "feat: add sparse revalidation schema"
```

## 任务 2：建立闭合词汇概念

**文件：**
- 创建：`folioloom/src/knowledge/lexical-concept.ts`
- 创建：`folioloom/test/lexical-concept.test.ts`
- 修改：`folioloom/src/domain/types.ts`

- [x] **步骤 1：编写概念归一化失败测试**

覆盖：

```ts
const concept = conceptFromAnchor({
  sourceForm: "Prokurist",
  target: "主事",
  mode: "contextual",
  semanticClass: "role",
  confidence: 0.95,
});
assert.equal(concept.policy, "contextual");
assert.deepEqual(concept.allowedRealizations, ["主事"]);
assert.equal(concept.renderFingerprint.length, 64);
assert.equal(
  reviseConcept(concept, { confidence: 0.99 }).renderFingerprint,
  concept.renderFingerprint,
);
assert.notEqual(
  reviseConcept(concept, { canonicalTarget: "协理" }).renderFingerprint,
  concept.renderFingerprint,
);
```

并断言 `ordinary_word` 不能升级为概念，任意 `kind` 不能绕过 schema。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="lexical concept"
```

预期：FAIL，模块不存在。

- [x] **步骤 3：实现概念类型和指纹**

导出：

```ts
export type LexicalSemanticClass =
  | "proper_name" | "unique_title" | "technical_term" | "role";

export interface LexicalConcept {
  conceptId: string;
  revisionId: string;
  normalizedSubject: string;
  sourceForms: readonly string[];
  semanticClass: LexicalSemanticClass;
  canonicalTarget: string;
  policy: StableTermPolicy;
  allowedRealizations: readonly string[];
  confidence: number;
  visibility: VisibilityChannel;
  renderFingerprint: string;
}
```

`renderFingerprint` 只哈希 source forms、semantic class、canonical target、
policy、allowed realizations 和 visibility。

- [x] **步骤 4：扩充 StableTerm**

在 `domain/types.ts` 增加：

```ts
semanticClass?: "proper_name" | "unique_title" | "technical_term" | "role";
allowedTargets?: readonly string[];
revisionId?: string;
renderFingerprint?: string;
```

现有调用者保持兼容。

- [x] **步骤 5：运行测试验证通过并提交**

```powershell
npm test -- --test-name-pattern="lexical concept"
npm run typecheck
git add folioloom/src/domain/types.ts folioloom/src/knowledge/lexical-concept.ts folioloom/test/lexical-concept.test.ts
git commit -m "feat: model contextual lexical concepts"
```

## 任务 3：让语境化职位成为翻译可见知识

**文件：**
- 修改：`folioloom/src/agents/lexical-anchorer.ts`
- 修改：`folioloom/src/knowledge/stable-terms-from-knowledge.ts`
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 测试：`folioloom/test/lexical-anchor.test.ts`
- 测试：`folioloom/test/knowledge-import-runtime.test.ts`
- 测试：`folioloom/test/book-runner.test.ts`

- [x] **步骤 1：编写 `Prokurist` 回归失败测试**

模型把 `Prokurist` 返回为：

```ts
{
  sourceForm: "Prokurist",
  target: "主事",
  mode: "contextual",
  semanticClass: "role",
  confidence: 0.95,
}
```

断言 outcome 含一个 `policy="contextual"` 的 term；`Fenster` 作为
`ordinary_word/contextual` 仍然只形成负缓存，不进入 terms。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="contextual role anchor"
```

预期：FAIL，当前 `anchorTerms` 只接受 `mode === "stable"`。

- [x] **步骤 3：扩充锚点 schema 和映射**

给 `semanticClass` 增加 `role`。`anchorTerms` 接受：

```ts
const conceptEligible = new Set([
  "proper_name", "unique_title", "technical_term", "role",
]);
const anchorTerms = anchors
  .filter((anchor) =>
    conceptEligible.has(anchor.semanticClass)
    && anchor.target.trim().length > 0
    && anchor.confidence >= 0.8)
  .map(anchorAsTerm);
```

`anchorAsTerm()` 保留 contextual policy，不能再统一软化成 preferred。

- [x] **步骤 4：持久化闭合概念**

`waveKnowledgeCandidates()` 对 eligible anchor 写
`kind="lexical_concept"` 的闭合 payload。普通词仍写
`lexical_anchor_decision`。`stableTermsFromKnowledge()` 读取
`lexical_concept`，同时保留旧 `lexical_anchor` 兼容。

- [x] **步骤 5：验证并提交**

```powershell
npm test -- --test-name-pattern="contextual role anchor|stable terms from knowledge|completed waves remember"
npm run typecheck
git add folioloom/src/agents/lexical-anchorer.ts folioloom/src/knowledge/stable-terms-from-knowledge.ts folioloom/src/fullbook/book-runner.ts folioloom/test/lexical-anchor.test.ts folioloom/test/knowledge-import-runtime.test.ts folioloom/test/book-runner.test.ts
git commit -m "feat: project contextual role concepts"
```

## 任务 4：增加结构化 TermUsage 和提交前校验

**文件：**
- 创建：`folioloom/src/knowledge/term-usage.ts`
- 创建：`folioloom/test/term-usage.test.ts`
- 修改：`folioloom/src/agents/translation-request.ts`
- 修改：`folioloom/src/agents/translation-batch.ts`
- 修改：`folioloom/test/translation-request.test.ts`
- 修改：`folioloom/test/translation-batch.test.ts`

- [x] **步骤 1：编写回执校验失败测试**

```ts
const expected = expectedTermOccurrences(blocks, [prokuristConcept], profile);
assert.equal(expected.length, 3);

assert.deepEqual(validateTermUsages(expected, [{
  occurrenceId: expected[0]!.occurrenceId,
  blockId: expected[0]!.blockId,
  conceptId: prokuristConcept.conceptId,
  sourceForm: "Prokurist",
  sourceStart: expected[0]!.sourceStart,
  sourceEnd: expected[0]!.sourceEnd,
  discourseRole: "narrative",
  targetSurface: "秘书主任",
}], targetByBlock), [{
  code: "TERM_USAGE_TARGET_NOT_ALLOWED",
  occurrenceId: expected[0]!.occurrenceId,
}]);
```

同时测试合法的“主事”“主事先生”、伪造偏移、译文中不存在的
`targetSurface`、遗漏 occurrence 和重复回执。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="term usage"
```

预期：FAIL，模块不存在。

- [x] **步骤 3：实现预期 occurrence 与校验器**

模型回执结构：

```ts
export interface TermUsageSubmission {
  occurrenceId: string;
  blockId: string;
  conceptId: string;
  sourceForm: string;
  sourceStart: number;
  sourceEnd: number;
  discourseRole: "narrative" | "vocative" | "title" | "other";
  targetSurface: string;
}
```

occurrence ID 由 block ID、concept ID、start/end 哈希生成。所有偏移、
source form 和目标表面形式由 harness 复核。

- [x] **步骤 4：扩充翻译工具 schema**

每个 window 增加：

```ts
termUsages: Type.Optional(Type.Array(Type.Object({
  occurrenceId: Type.String(),
  blockId: Type.String(),
  conceptId: Type.String(),
  sourceForm: Type.String(),
  sourceStart: Type.Integer({ minimum: 0 }),
  sourceEnd: Type.Integer({ minimum: 1 }),
  discourseRole: Type.Union([
    Type.Literal("narrative"),
    Type.Literal("vocative"),
    Type.Literal("title"),
    Type.Literal("other"),
  ]),
  targetSurface: Type.String(),
}, { additionalProperties: false }))),
```

请求的 terms section 同时投影 occurrence IDs。没有命中概念的窗口允许
省略 `termUsages`；命中时遗漏必须触发一次既有 targeted repair。

- [x] **步骤 5：把回执纳入 batch 验证和修复**

`TranslationBatchWindowResult` 保存 `termUsages`。第一次修复只发送失败
block、预期 occurrence 和错误代码；修复后重新验证完整块。

- [x] **步骤 6：验证并提交**

```powershell
npm test -- --test-name-pattern="term usage|translation request|batch"
npm run typecheck
git add folioloom/src/knowledge/term-usage.ts folioloom/src/agents/translation-request.ts folioloom/src/agents/translation-batch.ts folioloom/test/term-usage.test.ts folioloom/test/translation-request.test.ts folioloom/test/translation-batch.test.ts
git commit -m "feat: validate contextual term usages"
```

## 任务 5：持久化概念、出现索引和译文绑定

**文件：**
- 创建：`folioloom/src/knowledge/concept-occurrence-index.ts`
- 创建：`folioloom/test/concept-occurrence-index.test.ts`
- 修改：`folioloom/src/storage/lossless-book-store.ts`
- 修改：`folioloom/test/lossless-book-store.test.ts`

- [x] **步骤 1：编写一次扫描与幂等测试**

使用 100 个概念、25 个块，包装语言 profile 计数，断言所有概念批量
建立 occurrence 时每个块只归一化和分词一次。重复写入同一概念修订后：

```ts
assert.equal(store.conceptOccurrences(runId, conceptId).length, originalCount);
assert.equal(store.activeLexicalConcept(runId, conceptId)?.revision, 2);
```

并验证一个 translation version 的 term usages 原子写入 bindings。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="concept occurrence|translation concept binding"
```

- [x] **步骤 3：实现批量 occurrence 构建**

复用现有 Aho–Corasick 思路，但输出精确 source spans：

```ts
export interface ConceptOccurrence {
  conceptId: string;
  blockId: string;
  sourceSpans: readonly { start: number; end: number; sourceForm: string }[];
}
```

一个 batch 中每个 block 只扫描一次。

- [x] **步骤 4：增加 store 事务 API**

实现：

```ts
upsertLexicalConcepts(runId, concepts): readonly ConceptChange[];
replaceConceptOccurrences(runId, conceptId, occurrences): void;
stageWindowConceptBindings(runId, windowId, usages, concepts): void;
activeTranslationBindings(runId, blockId): readonly TranslationConceptBinding[];
```

概念、译文、binding 和窗口状态必须在现有 stage/promote 事务边界内保持
原子性。binding 只能指向同一 translation 的 staged/promoted 版本。

- [x] **步骤 5：验证故障回滚并提交**

```powershell
npm test -- --test-name-pattern="concept occurrence|translation concept binding|rolls back"
npm run typecheck
git add folioloom/src/knowledge/concept-occurrence-index.ts folioloom/src/storage/lossless-book-store.ts folioloom/test/concept-occurrence-index.test.ts folioloom/test/lossless-book-store.test.ts
git commit -m "feat: persist sparse concept dependencies"
```

## 任务 6：实现稀疏重验规划和并行提交门

**文件：**
- 创建：`folioloom/src/knowledge/sparse-revalidation.ts`
- 创建：`folioloom/test/sparse-revalidation.test.ts`
- 修改：`folioloom/src/storage/lossless-book-store.ts`
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/test/book-runner.test.ts`

- [x] **步骤 1：编写 `Prokurist` 稀疏影响失败测试**

夹具建立：

- block 0：三次 `Prokurist`，旧 binding 为“秘书主任”；
- block 1：无该词；
- block 2：一次 `Prokurist`，新 binding 为“主事”；
- block 3：位置靠后但与 block 0 同时启动，使用旧快照。

新概念 revision 的 allowed target 为“主事/主事先生”。断言：

```ts
assert.deepEqual(plan.map((item) => item.blockId), ["block-0", "block-3"]);
assert.equal(plan.some((item) => item.blockId === "block-1"), false);
assert.equal(plan.some((item) => item.blockId === "block-2"), false);
```

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="sparse revalidation"
```

- [x] **步骤 3：实现纯规划函数**

```ts
export function planSparseRevalidation(input: {
  concepts: readonly LexicalConcept[];
  occurrences: readonly ConceptOccurrence[];
  translations: readonly ActiveTranslationDependency[];
}): readonly RevalidationCandidate[];
```

只在 render fingerprint 变化且 translation binding 旧于当前 revision 时
产生候选。对同一 translation 合并 concept IDs 并生成稳定
`changeSetHash`。

- [x] **步骤 4：实现提交门**

在窗口 promotion 前比较 staged binding 与最新 concept：

- 新策略仍允许全部 usages：以最新 revision 写 clean binding；
- 不允许：丢弃 staged 候选版本，保留旧 active，窗口回到 pending，
  绑定最新 snapshot 后重试；
- 无关概念变化：正常 promotion。

不能因为全局 snapshot ID 不同而直接拒绝整个窗口。

- [x] **步骤 5：实现已完成块任务创建**

概念 promotion 后调用 store 规划 API，只查询 `concept_occurrences` 命中
块和旧 binding。`UNIQUE(translation_id, change_set_hash)` 保证恢复幂等。

- [x] **步骤 6：验证并提交**

```powershell
npm test -- --test-name-pattern="sparse revalidation|reverse physical completion|knowledge"
npm run typecheck
git add folioloom/src/knowledge/sparse-revalidation.ts folioloom/src/storage/lossless-book-store.ts folioloom/src/fullbook/book-runner.ts folioloom/test/sparse-revalidation.test.ts folioloom/test/book-runner.test.ts
git commit -m "feat: invalidate only stale concept bindings"
```

## 任务 7：执行重验并生成新译文版本

**文件：**
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/src/storage/lossless-book-store.ts`
- 修改：`folioloom/test/book-runner.test.ts`

- [x] **步骤 1：编写 noop、修复、重译和失败保留测试**

四个用例：

1. 旧表面形式仍在 allowed targets：零模型调用，任务 `resolved_noop`；
2. 唯一表面冲突：一次定向修复，translation version 从 1 变 2；
3. 指称或 policy 实质变化：整块重译；
4. provider/预算失败：旧 version 仍 active，binding 为
   `warning_stale`，其他窗口继续。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="revalidation noop|revalidation repair|warning stale"
```

- [x] **步骤 3：实现任务循环**

每个波次结束后、选择下一波之前：

```ts
while (true) {
  const task = store.claimNextRevalidationTask(runId);
  if (task === undefined) break;
  const local = evaluateCurrentTermUsages(task);
  if (local.status === "clean") {
    store.resolveRevalidationNoop(task, latestBindings);
    continue;
  }
  await repairOrRetranslateOneWindow(task, latestSnapshot);
}
```

同一任务最多使用现有 `maxAttempts`。重验产生的知识候选只进入下一波，
不能在当前任务排空时递归触发无限循环。

- [x] **步骤 4：实现版本切换事务**

新译文完整通过后：

- 插入 version+1 staged translation；
- 写新 bindings；
- 原 active version 设为 0；
- 新 version 提升为 active；
- 任务写 replacement ID 和终态；
- 旧译文、旧 binding 和事件历史保留。

- [x] **步骤 5：验证并提交**

```powershell
npm test -- --test-name-pattern="revalidation"
npm run typecheck
git add folioloom/src/fullbook/book-runner.ts folioloom/src/storage/lossless-book-store.ts folioloom/test/book-runner.test.ts
git commit -m "feat: converge stale translations incrementally"
```

## 任务 8：前移通用简体正字规范

**文件：**
- 修改：`folioloom/src/style/chinese-script-normalization.ts`
- 修改：`folioloom/test/chinese-script-normalization.test.ts`

- [x] **步骤 1：编写通用正字失败测试**

```ts
assert.equal(
  simplifyChineseTranslation("谨愼地硏究，双腿轻轻晄动"),
  "谨慎地研究，双腿轻轻晃动",
);
```

测试 glossary 锁定目标仍逐字节保留，不能被兼容转换改写。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="Chinese script|orthography"
```

- [x] **步骤 3：扩充版本化通用映射**

在 `compatibilityToChinese` 增加跨作品通用兼容/异体映射：

```ts
["愼", "慎"],
["硏", "研"],
["晄", "晃"],
```

保持顺序：日文兼容 → 通用异体 → 繁体到简体；受保护术语继续绕过转换。

- [x] **步骤 4：验证并提交**

```powershell
npm test -- --test-name-pattern="Chinese script|orthography"
npm run typecheck
git add folioloom/src/style/chinese-script-normalization.ts folioloom/test/chinese-script-normalization.test.ts
git commit -m "fix: normalize generic Chinese variant glyphs"
```

## 任务 9：严格审计必须证明知识收敛

**文件：**
- 修改：`folioloom/src/report.ts`
- 修改：`folioloom/test/lossless-audit.test.ts`
- 修改：`folioloom/test/cli.test.ts`

- [x] **步骤 1：编写审计失败测试**

活动译文完整但存在 pending/stale binding 时：

```ts
const report = auditLosslessBookStore(store, runId);
assert.equal(report.structurallyComplete, true);
assert.equal(report.knowledgeConverged, false);
assert.equal(report.strictExportable, false);
assert.ok(report.incidentCodes.includes("STALE_KNOWLEDGE_BINDING"));
```

`warning_stale` 同样阻止严格导出；普通 partial 导出必须清楚标注。

- [x] **步骤 2：运行测试确认失败**

```powershell
npm test -- --test-name-pattern="knowledge converged|strict export"
```

- [x] **步骤 3：扩充报告**

报告增加：

```ts
structurallyComplete: boolean;
knowledgeConverged: boolean;
strictExportable: boolean;
revalidation: {
  pending: number;
  validating: number;
  stale: number;
  warningStale: number;
  resolvedNoop: number;
  repaired: number;
  retranslated: number;
};
```

保留现有 `complete` 兼容字段，但其值只等于 `strictExportable`；新增字段
使结构状态可单独解释。

- [x] **步骤 4：验证并提交**

```powershell
npm test -- --test-name-pattern="knowledge converged|strict export|book audit"
npm run typecheck
git add folioloom/src/report.ts folioloom/test/lossless-audit.test.ts folioloom/test/cli.test.ts
git commit -m "feat: require knowledge convergence for strict export"
```

## 任务 10：规模回归和全套验证

**文件：**
- 修改：`folioloom/test/concept-occurrence-index.test.ts`
- 修改：`folioloom/test/sparse-revalidation.test.ts`
- 修改：`docs/superpowers/reports/2026-07-26-sparse-revalidation-validation.md`

- [x] **步骤 1：增加三百万字符合成测试**

构造三百万字符、六百块、一千概念的固定种子样本。记录：

- 每块归一化/分词次数；
- occurrence 行数；
- 相同概念重复修订十次后的行数；
- 无关知识变化产生的任务数；
- 影响十个块的知识变化产生的候选数。

断言：

```ts
assert.equal(normalizedBlocks, 600);
assert.equal(segmentedBlocks, 600);
assert.equal(rowsAfterTenRevisions, rowsAfterFirstRevision);
assert.equal(unrelatedTasks, 0);
assert.equal(affectedTasks, 10);
```

- [x] **步骤 2：运行核心和桌面全套验证**

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
git diff --check
```

预期：全部 exit 0；Windows 不支持符号链接的既有单项允许显式 skip。

- [x] **步骤 3：编写验证报告并提交**

报告记录测试总数、规模样本耗时/内存、数据库增长、已知非目标和提交
哈希，不复制任何密钥或受版权保护正文。

```powershell
git add folioloom/test/concept-occurrence-index.test.ts folioloom/test/sparse-revalidation.test.ts docs/superpowers/reports/2026-07-26-sparse-revalidation-validation.md
git commit -m "test: validate sparse revalidation at scale"
```

## 任务 11：重译《变形记》十万字符

**文件：**
- 新建运行目录：`projects/kafka_verwandlung_100k_sparse/`
- 新建报告：`docs/superpowers/reports/2026-07-26-kafka-100k-sparse-revalidation.md`

- [ ] **步骤 1：从原始德文重新建项目**

使用：

```text
downloads/kafka-die-verwandlung-gutenberg.txt
```

新建项目和 SQLite，不复制旧活动译文、知识快照或导出文件。源语言固定
为 `de`。

- [ ] **步骤 2：运行 doctor**

确认：

- 原始字节和 canonical hash 可验证；
- 德语画像生效；
- 原文覆盖无缺口/重叠；
- 不存在 replacement character 或编码乱码。

- [ ] **步骤 3：运行至少十万正文字符**

配置：

```text
model=deepseek-v4-flash
mode=quality
reasoning=high
maxConcurrency=4
```

运行达到不少于 100,000 个德文正文字符；外部额度或服务中断直接报告，
不修改内部逻辑。

- [ ] **步骤 4：运行严格审计并导出**

必须得到：

```text
structurallyComplete=true
knowledgeConverged=true
strictExportable=true
pending/stale/warningStale=0
```

导出中文和双语 TXT。

- [ ] **步骤 5：运行自动和人工抽检**

自动统计：

- `Prokurist/Prokuristen` source occurrences；
- concept 数、允许实现和各目标出现次数；
- Gregor/Grete/Samsa 变体；
- “晄、愼、硏”；
- 重验候选/noop/修复/重译数；
- 100k 墙钟和模型调用。

人工对照规格中的五段。不能只凭审计布尔值宣布语言质量通过。

- [ ] **步骤 6：写报告并提交**

报告给出：

- 工程结果；
- 译文优点；
- 所有发现的实际错误；
- 是否建议联系外部德语用户；
- 可点击的本地译文和双语文件路径。

```powershell
git add docs/superpowers/reports/2026-07-26-kafka-100k-sparse-revalidation.md
git commit -m "test: report German 100k sparse revalidation"
```

## 任务 12：完成分支

- [ ] **步骤 1：重新运行最终验证**

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
git status --short --branch
```

- [ ] **步骤 2：审查提交范围**

确认未提交：

- API Key、OpenCode auth、诊断日志；
- 下载原文、项目 SQLite 和译文导出；
- 根目录既有未跟踪 `package-lock.json`；
- 与本功能无关的用户文件。

- [ ] **步骤 3：按 finishing-a-development-branch 流程交付**

报告分支、提交、测试、真实 100k 结果和仍存风险；在用户明确要求前
不推送、不合并、不发布 release。
