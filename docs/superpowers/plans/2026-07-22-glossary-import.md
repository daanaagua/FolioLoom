# 外部术语表导入实现计划

> **面向 AI 代理的工作者：** 必须使用 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框语法跟踪进度。

**目标：** 让 FolioLoom 的 `book doctor` 与 `book run` 接受可复现的 JSON 术语表，在本地确定性地定位术语，并仅向当前翻译请求注入相关的导入条目。

**架构：** `glossary-profile` 独立完成解析、语义哈希、别形展开和基于 `SourceLanguageProfile` 的定位。Book runner 将快照作为最高优先级稳定术语并入现有术语流，CLI 将摘要哈希写入既有 run metadata，从而复用恢复一致性保护。

**技术栈：** TypeScript、Node test runner、现有无损源账本、`SourceLanguageProfile`、SQLite run metadata。

---

### 任务 1：实现 JSON 术语表加载与确定性定位

**文件：**
- 创建：`translator-v5/src/glossary/glossary-profile.ts`
- 创建：`translator-v5/test/glossary-profile.test.ts`
- 修改：`translator-v5/src/domain/types.ts`

- [x] **步骤 1：编写失败的术语表加载测试**

```ts
test("loads simple and structured glossary entries with aliases", () => {
  const glossary = loadGlossary({
    glossaryPath: fixturePath("glossary.json"),
    blocks: blocks("Typhon's body moved.", "The archon spoke."),
    profile: getSourceLanguageProfile("en"),
  });
  assert.equal(glossary.report.totalTerms, 2);
  assert.equal(glossary.stableTerms.filter((term) => term.canonicalSource === "Typhon").length, 2);
  assert.equal(glossary.report.terms[0]?.occurrenceCount, 1);
});

test("uses profile tokens instead of substring matching", () => {
  const glossary = loadGlossary({
    glossaryPath: fixturePath("art.json"),
    blocks: blocks("The party began."),
    profile: getSourceLanguageProfile("en"),
  });
  assert.equal(glossary.report.terms[0]?.occurrenceCount, 0);
});
```

- [x] **步骤 2：运行定向测试并确认红灯**

运行：`node --test --import tsx test/glossary-profile.test.ts`

预期：失败，原因是 `glossary-profile.ts` 尚不存在。

- [x] **步骤 3：实现最小加载器与扩展术语类型**

```ts
export type StableTermPolicy = "locked" | "preferred" | "contextual";

export interface StableTerm {
  // existing fields
  policy?: StableTermPolicy;
  note?: string;
  origin?: "legacy" | "knowledge" | "glossary";
}

export function loadGlossary(input: LoadGlossaryInput): LoadedGlossary {
  const parsed = parseAndValidateGlossary(input.glossaryPath);
  const stableTerms = expandGlossaryTerms(parsed);
  const occurrences = locateTerms(stableTerms, input.blocks, input.profile);
  return { stableTerms, occurrences, hash: semanticHash(parsed), report: buildReport(...) };
}
```

解析器只接受最简映射或 `folioloom-glossary-1` 结构，严格检查字段和容量上限；`locateTerms()` 使用 profile 词元序列，而不是 `includes()`。

- [x] **步骤 4：运行定向测试并确认绿灯**

运行：`node --test --import tsx test/glossary-profile.test.ts`

预期：所有术语表加载、规范化、哈希、限制和冲突测试通过。

- [x] **步骤 5：提交独立变更**

```bash
git add translator-v5/src/domain/types.ts translator-v5/src/glossary/glossary-profile.ts translator-v5/test/glossary-profile.test.ts
git commit -m "feat: load deterministic glossary snapshots"
```

### 任务 2：将术语快照接入无损 book runner

**文件：**
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/test/book-runner.test.ts`
- 修改：`translator-v5/test/translation-batch.test.ts`

- [ ] **步骤 1：编写失败的窗口注入与硬锁测试**

```ts
test("book runner sends only glossary terms relevant to each request", async () => {
  const observed = await runFixtureBook({
    glossary: glossaryWith("Typhon", "Severian"),
    source: ["Typhon speaks.", "Unrelated prose."],
  });
  assert.match(observed.firstPrompt, /Typhon/);
  assert.doesNotMatch(observed.firstPrompt, /Severian/);
});

test("locked glossary terms reuse stable term validation", async () => {
  const result = await runFixtureBatch({
    stableTerms: [lockedGlossaryTerm("Typhon", "提丰")],
  });
  assert.ok(result.issues.some((issue) => issue.code === "stable_term_mismatch"));
});
```

- [ ] **步骤 2：运行定向测试并确认红灯**

运行：`node --test --import tsx test/book-runner.test.ts test/translation-batch.test.ts`

预期：失败，原因是 runner 尚未接收或筛选 glossary snapshot。

- [ ] **步骤 3：实现优先级合并和请求级筛选**

```ts
const establishedTerms = uniqueTerms([
  ...context.stableTerms,
  ...options.glossary?.stableTerms ?? [],
  ...termsFromKnowledge(snapshot.revisions),
], context);

await runTranslationBatch({
  // existing input
  stableTerms: termsForWindows(activeTerms, request.windows, context, options.glossary),
});
```

更新 `uniqueTerms()`：`origin: "glossary"` 优先；发生不同 target 的用户术语/旧术语冲突时在请求前抛错。只按请求筛选导入术语，既有知识快照和本波锚点继续遵循原有的全局连续性投影。`translation-batch` 的锁定校验不重写，继续以 `locked: true` 工作，并在 prompt 中保留 `policy` 与 `note`。

- [ ] **步骤 4：运行定向测试并确认绿灯**

运行：`node --test --import tsx test/book-runner.test.ts test/translation-batch.test.ts`

预期：相关术语被注入、无关术语未被注入、锁定术语校验保持有效。

- [ ] **步骤 5：提交独立变更**

```bash
git add translator-v5/src/fullbook/book-runner.ts translator-v5/test/book-runner.test.ts translator-v5/test/translation-batch.test.ts
git commit -m "feat: inject glossary terms by translation window"
```

### 任务 3：接入 CLI、doctor 与恢复元数据

**文件：**
- 修改：`translator-v5/src/cli.ts`
- 修改：`translator-v5/test/cli.test.ts`
- 修改：`translator-v5/test/lossless-book-store.test.ts`

- [ ] **步骤 1：编写失败的 CLI 和恢复测试**

```ts
test("CLI parses glossary for book doctor and book run", () => {
  assert.equal(parseArgs(["book", "doctor", "--manifest", "source.json", "--glossary", "terms.json"]).glossary, resolve("terms.json"));
  assert.equal(parseArgs(["book", "run", "--manifest", "source.json", "--store", "book.db", "--config", "config.yaml", "--glossary", "terms.json"]).glossary, resolve("terms.json"));
});

test("resuming a glossary-configured run requires the same glossary hash", () => {
  assert.throws(() => runWithMetadata({ glossaryHash: "different" }), /metadata mismatch/);
});
```

- [ ] **步骤 2：运行定向测试并确认红灯**

运行：`node --test --import tsx test/cli.test.ts test/lossless-book-store.test.ts`

预期：失败，原因是 `--glossary` 尚未被允许或记录。

- [ ] **步骤 3：在模型构造前加载快照并写入 metadata**

```ts
const glossary = options.glossary === undefined
  ? undefined
  : loadGlossaryForManifest({ manifestPath: options.manifest, legacyV4DbPath: options.legacyV4Db, glossaryPath: options.glossary });
const metadata = runMetadataForGlossary(glossary, runMetadataForStyle(style, previousMetadata));
```

`book doctor` 返回 glossary report；`book run` 将 snapshot 传入 `runBook()`。没有 `--glossary` 却尝试恢复 glossary 配置 run 时，在 provider 创建前失败。

- [ ] **步骤 4：运行定向测试并确认绿灯**

运行：`node --test --import tsx test/cli.test.ts test/lossless-book-store.test.ts`

预期：参数、doctor 报告、恢复一致性以及模型调用前失败路径均通过。

- [ ] **步骤 5：提交独立变更**

```bash
git add translator-v5/src/cli.ts translator-v5/test/cli.test.ts translator-v5/test/lossless-book-store.test.ts
git commit -m "feat: expose glossary import in book commands"
```

### 任务 4：提供样例、用户文档并全量验证

**文件：**
- 创建：`config/glossary.example.json`
- 修改：`README.md`
- 修改：`docs/superpowers/plans/2026-07-22-glossary-import.md`

- [ ] **步骤 1：新增示例与 README 使用场景**

README 说明最简映射、结构化条目、三种策略、`book doctor --glossary`、`book run --glossary`、无模型全文预扫描，以及恢复时语义 hash 必须相同。样例文件同时展示实体、别名和语境化称谓。

- [ ] **步骤 2：运行完整验证**

运行：

```bash
npm.cmd test
npm.cmd run typecheck
```

预期：全量 Node 测试和 TypeScript 类型检查均通过。

- [ ] **步骤 3：检查工作树与提交最终文档**

```bash
git status --short
git add README.md config/glossary.example.json docs/superpowers/plans/2026-07-22-glossary-import.md
git commit -m "docs: explain glossary import"
```
