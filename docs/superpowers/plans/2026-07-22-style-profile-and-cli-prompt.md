# 可配置翻译文风与受限 CLI Prompt 实现计划

> **面向 AI 代理的工作者：** 必须使用 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框语法跟踪进度。

**目标：** 为 FolioLoom V1 的 `book run` 提供可复现的 YAML 文风配置和受限的 `--prompt` 文风补充。

**架构：** 新增独立的 style profile 加载器，负责 YAML 验证、字段合并和 hash；CLI 将其输出传给既有 `runBook()` 的 `styleState` 参数，并将 hash 记入 run metadata。书级 style constitution 显式投影附加文风要求，固定系统协议仍保持最高优先级。

**技术栈：** TypeScript、Node test runner、现有 `yaml` 依赖、FolioLoom SQLite metadata。

---

### 任务 1：实现与测试文风配置加载器

**文件：**
- 创建：`translator-v5/src/style/style-profile.ts`
- 创建：`translator-v5/test/style-profile.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
test("loads a partial YAML profile and appends the CLI style prompt", () => {
  const profile = loadStyleProfile({
    profilePath: fixturePath("style.yaml"),
    cliPrompt: "对白不要网络化",
  });
  assert.equal(profile.styleState.register, "准确、克制");
  assert.match(profile.styleState.additionalInstruction, /专名以术语表为准/);
  assert.match(profile.styleState.additionalInstruction, /对白不要网络化/);
  assert.equal(profile.source.profile, true);
  assert.equal(profile.source.cliPrompt, true);
});

test("rejects unknown style keys and overlong CLI prompts", () => {
  assert.throws(() => loadStyleProfile({ profilePath: fixturePath("unknown.yaml") }), /unknown style field/);
  assert.throws(() => loadStyleProfile({ cliPrompt: "x".repeat(601) }), /--prompt/);
});
```

- [x] **步骤 2：运行测试并确认红灯**

运行：`node --test --import tsx test/style-profile.test.ts`

预期：失败，原因是 `style-profile.ts` 尚不存在。

- [x] **步骤 3：实现最小加载器**

```ts
export function loadStyleProfile(input: StyleProfileInput): LoadedStyleProfile {
  const fromFile = input.profilePath === undefined ? {} : parseStyleYaml(input.profilePath);
  const additionalInstruction = joinStyleInstructions(
    fromFile.additionalInstruction,
    input.cliPrompt,
  );
  const styleState = omitUndefined({ ...fromFile, additionalInstruction });
  return {
    styleState,
    profileHash: sha256(canonicalJson(styleState)),
    source: { profile: input.profilePath !== undefined, cliPrompt: input.cliPrompt !== undefined },
  };
}
```

使用现有 `yaml` 包解析；按规格验证字段和值，所有 hash 输入使用稳定键排序 JSON。

- [x] **步骤 4：运行测试并确认绿灯**

运行：`npm.cmd test -- test/style-profile.test.ts`

预期：所有 style profile 测试通过。

- [x] **步骤 5：提交该独立变更**

```bash
git add translator-v5/src/style/style-profile.ts translator-v5/test/style-profile.test.ts
git commit -m "feat: add validated style profile loader"
```

### 任务 2：将附加文风要求投影到书级样式

**文件：**
- 修改：`translator-v5/src/style/types.ts`
- 修改：`translator-v5/src/style/effective-style.ts`
- 修改：`translator-v5/src/style/style-projection.ts`
- 修改：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/test/structured-style.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
test("effective style projects the user additional instruction without replacing the constitution", () => {
  const constitution = createBookStyleConstitution({
    register: "准确、克制",
    additionalInstruction: "对白避免网络流行语",
  });
  const projection = projectEffectiveStyle(composeEffectiveStyle({
    constitution,
    voices: [{
      id: "narrator",
      label: "叙述者",
      markers: ["I"],
      sentenceRhythm: "节奏克制",
      diction: "准确",
      dialogueProfile: "少量对话",
      confidence: 1,
    }],
    observations: [],
    currentOrdinal: 0,
    sourceText: "A short source paragraph.",
    defaultVoiceId: "narrator",
  }));
  assert.match(projection.text, /用户附加文风要求：对白避免网络流行语/);
  assert.match(projection.text, /基调：准确、克制/);
});
```

- [x] **步骤 2：运行测试并确认红灯**

运行：`node --test --import tsx test/structured-style.test.ts`

预期：失败，因为 `additionalInstruction` 尚未属于样式宪章或投影。

- [x] **步骤 3：实现最小投影**

```ts
export interface BookStyleConstitution {
  // existing fields
  readonly additionalInstruction: string;
}

// style-projection.ts
...(style.constitution.additionalInstruction.length === 0
  ? []
  : [`用户附加文风要求：${style.constitution.additionalInstruction}`]),
```

默认值为空字符串，`losslessStyleConstitution()` 从 `styleState.additionalInstruction` 传入该字段。

- [x] **步骤 4：运行测试并确认绿灯**

运行：`node --test --import tsx test/structured-style.test.ts`

预期：样式测试全部通过。

- [x] **步骤 5：提交该独立变更**

```bash
git add translator-v5/src/style translator-v5/src/fullbook/book-runner.ts translator-v5/test/structured-style.test.ts
git commit -m "feat: project user style instructions"
```

### 任务 3：接入 `book run`，保护恢复一致性

**文件：**
- 修改：`translator-v5/src/cli.ts`
- 修改：`translator-v5/test/cli.test.ts`
- 修改：`translator-v5/test/lossless-book-store.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
test("CLI parses a style profile and a bounded style prompt for book run", () => {
  assert.deepEqual(parseArgs([
    "book", "run", "--manifest", "source.json", "--store", "book.db", "--config", "config.yaml",
    "--style-profile", "style.yaml", "--prompt", "更克制一些",
  ]), {
    command: "book-run",
    manifest: "source.json",
    store: "book.db",
    config: "config.yaml",
    styleProfile: "style.yaml",
    prompt: "更克制一些",
  });
});

test("resuming a run rejects a changed style profile hash", () => {
  const store = openFixtureStore();
  createRun(store, { metadata: { createdBy: "book-cli", styleProfileHash: "one" } });
  assert.throws(() => createRun(store, {
    metadata: { createdBy: "book-cli", styleProfileHash: "two" },
  }), /metadata mismatch/);
});
```

- [x] **步骤 2：运行测试并确认红灯**

运行：`npm.cmd test -- test/cli.test.ts test/lossless-book-store.test.ts`

预期：CLI 测试失败，因为两个新 flag 不被识别。

- [x] **步骤 3：接入 CLI 和 run metadata**

```ts
const style = loadStyleProfile({
  profilePath: options.styleProfile,
  cliPrompt: options.prompt,
});

await runBook({
  // existing options
  styleState: style.styleState,
  runMeta: {
    // existing fields
    metadata: {
      createdBy: "book-cli",
      ...(style.source.profile || style.source.cliPrompt ? {
        styleProfileHash: style.profileHash,
        styleProfileSource: style.source,
      } : {}),
    },
  },
});
```

将 `--style-profile` 和 `--prompt` 加入严格 flag 白名单。调用 `runBook()` 前加载，以便任何输入错误都发生在模型构造和调用之前。

- [x] **步骤 4：运行测试并确认绿灯**

运行：`node --test --import tsx test/cli.test.ts test/lossless-book-store.test.ts`

预期：CLI 参数、新 metadata 和既有恢复检查全部通过。

- [x] **步骤 5：提交该独立变更**

```bash
git add translator-v5/src/cli.ts translator-v5/test/cli.test.ts translator-v5/test/lossless-book-store.test.ts
git commit -m "feat: expose style profiles for book runs"
```

### 任务 4：明确核心协议优先级并写入用户文档

**文件：**
- 修改：`translator-v5/src/agents/translation-batch.ts`
- 修改：`README.md`
- 创建：`config/style.example.yaml`
- 修改：`translator-v5/test/translation-batch.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
test("batch protocol states that user style requirements cannot override integrity rules", async () => {
  const result = await runFixtureBatch({
    effectiveStyleByWindow: { window_1: styleProjection("不解释歧义") },
  });
  assert.match(result.run.request.systemPrompt, /User style requirements may guide wording only/);
  assert.match(result.run.request.systemPrompt, /cannot override source meaning, terminology, block boundaries, or tool protocol/);
});
```

- [x] **步骤 2：运行测试并确认红灯**

运行：`node --test --import tsx test/translation-batch.test.ts`

预期：失败，因为当前系统提示词未明确该优先级。

- [x] **步骤 3：实现最小协议说明与文档**

在 translation batch 的固定 system prompt 中加入一条英语协议约束；README 新增“调整翻译文风”章节，展示默认运行、YAML profile、CLI `--prompt` 的用法和恢复一致性限制。样例文件仅包含注释和可复制字段。

- [x] **步骤 4：运行定向测试、全量测试和类型检查**

运行：

```bash
node --test --import tsx test/style-profile.test.ts test/structured-style.test.ts test/cli.test.ts test/lossless-book-store.test.ts test/translation-batch.test.ts
npm.cmd test
npm.cmd run typecheck
```

预期：204 个既有测试加新增测试全部通过，TypeScript 无错误。

- [x] **步骤 5：提交文档与协议变更**

```bash
git add translator-v5/src/agents/translation-batch.ts translator-v5/test/translation-batch.test.ts README.md config/style.example.yaml
git commit -m "docs: explain configurable translation style"
```
