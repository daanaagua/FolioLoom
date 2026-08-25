# 多行标题中文词序修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不放宽正文逐段完整性校验的前提下，让多行标题能够按自然中文词序在原有段落槽位内重新分配译文。

**架构：** 新建一个只负责段落槽位完整性提示的共享常量，正式批量翻译、兼容 island 翻译和定向修复共同引用它。验证器保持不变，因为它已经允许 `时间 / 之子` 且会继续拒绝合并为单段的 `时间之子`。

**技术栈：** TypeScript 7、Node.js test runner、tsx、FolioLoom 的 PiRuntime 与 TranslationValidator。

---

## 文件结构

- 创建：`folioloom/src/agents/paragraph-integrity.ts`
  - 保存三个翻译入口共享的段落槽位与多行标题规则。
- 修改：`folioloom/src/agents/translation-request.ts`
  - 正式整书批量翻译使用共享规则。
- 修改：`folioloom/src/agents/translator.ts`
  - 兼容 island 翻译使用共享规则。
- 修改：`folioloom/src/agents/repairer.ts`
  - 定向修复使用共享规则。
- 修改：`folioloom/test/translation-request.test.ts`
  - 检查正式翻译系统提示包含受限标题组例外。
- 修改：`folioloom/test/translation-agent.test.ts`
  - 检查兼容翻译运行时实际收到该规则，并记录验证器对多行标题的边界行为。
- 修改：`folioloom/test/translation-batch.test.ts`
  - 检查定向修复运行时实际收到该规则。

### 任务 1：用失败测试锁定三个提示入口

**文件：**
- 修改：`folioloom/test/translation-request.test.ts:77-103`
- 修改：`folioloom/test/translation-agent.test.ts:82-126`
- 修改：`folioloom/test/translation-batch.test.ts:734-781`

- [x] **步骤 1：为正式批量翻译提示增加失败断言**

在 `one request builder serializes all translator-visible projections and one tool schema` 中增加：

```ts
assert.match(
  prepared.systemPrompt,
  /adjacent short display-only lines clearly form one title or heading/u,
);
assert.match(
  prepared.systemPrompt,
  /redistribute wording only within those same target paragraph slots/u,
);
assert.match(
  prepared.systemPrompt,
  /never apply this exception to ordinary prose/u,
);
```

- [x] **步骤 2：为兼容 Translator 的实际系统提示增加失败断言**

把该测试的首个 faux 响应改为响应工厂，以记录 `context.systemPrompt`：

```ts
const translationSystemPrompts: string[] = [];
faux.setResponses([
  (context) => {
    translationSystemPrompts.push(context.systemPrompt ?? "");
    return fauxAssistantMessage(
      fauxToolCall("retrieve_resolved_evidence", {
        questionIds: ["q-typhon-piaton"],
      }),
      { stopReason: "toolUse" },
    );
  },
  fauxAssistantMessage(
    fauxToolCall("finalize_translation", {
      translations: [
        { blockId: "v06_ch08_000", text: "提丰抬起头，望向塞万里安。" },
        { blockId: "v06_ch08_001", text: "皮亚顿的声音从同一具身体里传来。" },
      ],
      notes: [],
    }),
    { stopReason: "toolUse" },
  ),
]);
```

在现有结果断言后增加：

```ts
assert.match(
  translationSystemPrompts[0] ?? "",
  /adjacent short display-only lines clearly form one title or heading/u,
);
```

- [x] **步骤 3：为 Repairer 的实际系统提示增加失败断言**

在 `batch validation repairs only the invalid block once and preserves its valid sibling` 中增加数组，并在修复响应工厂中记录系统提示：

```ts
const repairSystemPrompts: string[] = [];
```

```ts
(context) => {
  repairSystemPrompts.push(context.systemPrompt ?? "");
  repairPrompts.push(promptText(context));
  return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
    translations: [{ blockId: "block-0", text: "阿尔法。" }],
    notes: [],
  }), { stopReason: "toolUse" });
},
```

在现有结果断言后增加：

```ts
assert.match(
  repairSystemPrompts[0] ?? "",
  /adjacent short display-only lines clearly form one title or heading/u,
);
```

- [x] **步骤 4：运行三个目标测试并确认正确失败**

在 `folioloom/` 目录运行：

```powershell
node --test --import tsx `
  test/translation-request.test.ts `
  test/translation-agent.test.ts `
  test/translation-batch.test.ts
```

预期：测试断言失败，实际系统提示中不存在 `adjacent short display-only lines clearly form one title or heading`；不得是 TypeScript 编译错误或测试夹具错误。

### 任务 2：实现共享的段落槽位与标题组规则

**文件：**
- 创建：`folioloom/src/agents/paragraph-integrity.ts`
- 修改：`folioloom/src/agents/translation-request.ts:198-211`
- 修改：`folioloom/src/agents/translator.ts:239-250`
- 修改：`folioloom/src/agents/repairer.ts:76-84`

- [x] **步骤 1：创建共享提示规则**

创建 `folioloom/src/agents/paragraph-integrity.ts`：

```ts
export const PARAGRAPH_INTEGRITY_INSTRUCTIONS = Object.freeze([
  "Keep the number and order of paragraph slots unchanged: return exactly one non-empty target paragraph for each source paragraph.",
  "For ordinary prose, never move, duplicate, merge, or split content across paragraphs or blocks.",
  "Exception: when adjacent short display-only lines clearly form one title or heading, translate the whole group as one semantic unit and redistribute wording only within those same target paragraph slots to produce natural Chinese word order.",
  "Never move content across that display-line group or a block boundary, and never apply this exception to ordinary prose.",
] as const);
```

- [x] **步骤 2：正式批量翻译使用共享规则**

在 `translation-request.ts` 中导入：

```ts
import { PARAGRAPH_INTEGRITY_INSTRUCTIONS } from "./paragraph-integrity.js";
```

将原有两条逐段规则替换为：

```ts
...PARAGRAPH_INTEGRITY_INSTRUCTIONS,
```

保留其前面的 `Preserve meaning, ambiguity, paragraph structure, voice, and every block boundary.`。

- [x] **步骤 3：兼容 Translator 使用共享规则**

在 `translator.ts` 中导入：

```ts
import { PARAGRAPH_INTEGRITY_INSTRUCTIONS } from "./paragraph-integrity.js";
```

将原有两条逐段规则替换为：

```ts
...PARAGRAPH_INTEGRITY_INSTRUCTIONS,
```

- [x] **步骤 4：Repairer 使用共享规则**

在 `repairer.ts` 中导入：

```ts
import { PARAGRAPH_INTEGRITY_INSTRUCTIONS } from "./paragraph-integrity.js";
```

将原有两条逐段规则替换为：

```ts
...PARAGRAPH_INTEGRITY_INSTRUCTIONS,
```

保留 `Preserve all unaffected meaning and paragraph structure.` 和最小补丁要求。

- [x] **步骤 5：运行目标测试确认转绿**

运行：

```powershell
node --test --import tsx `
  test/translation-request.test.ts `
  test/translation-agent.test.ts `
  test/translation-batch.test.ts
```

预期：全部通过，0 failed。

### 任务 3：记录验证器的标题边界并提交修复

**文件：**
- 修改：`folioloom/test/translation-agent.test.ts:632-657`

- [x] **步骤 1：增加多行标题验证器回归测试**

在现有逐段边界测试附近增加：

```ts
test("multiline display titles may redistribute wording without losing paragraph slots", () => {
  const source = chapterBlock(0, "CHILDREN\n\nOF TIME");
  const validator = new TranslationValidator();
  const redistributed = validator.validate(
    [source],
    {
      translations: [{ blockId: source.id, text: "时间\n\n之子" }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("en") },
  );
  const merged = validator.validate(
    [source],
    {
      translations: [{ blockId: source.id, text: "时间之子" }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("en") },
  );

  assert.equal(redistributed.valid, true);
  assert.ok(merged.failures.some((failure) =>
    failure.code === "paragraph_count_incompatible"));
});
```

- [x] **步骤 2：运行翻译相关测试**

运行：

```powershell
node --test --import tsx `
  test/translation-request.test.ts `
  test/translation-agent.test.ts `
  test/translation-batch.test.ts
```

预期：全部通过，0 failed。

- [x] **步骤 3：检查补丁并提交**

运行：

```powershell
git diff --check
git diff -- folioloom/src/agents folioloom/test
```

确认仅包含共享提示规则、三个接入点和对应测试，然后提交：

```powershell
git add -- `
  folioloom/src/agents/paragraph-integrity.ts `
  folioloom/src/agents/translation-request.ts `
  folioloom/src/agents/translator.ts `
  folioloom/src/agents/repairer.ts `
  folioloom/test/translation-request.test.ts `
  folioloom/test/translation-agent.test.ts `
  folioloom/test/translation-batch.test.ts
git commit -m "fix: preserve Chinese order in multiline headings"
```

### 任务 4：完整验证与真实模型门禁

**文件：**
- 不修改受版本控制文件。
- 生成被 `.gitignore` 排除的试译状态库和导出文件：
  - `projects/children_of_time/artifacts/folioloom/heading-fix.db`
  - `projects/children_of_time/exports/heading-fix/`

- [x] **步骤 1：运行完整单元测试**

在 `folioloom/` 目录运行：

```powershell
npm.cmd test
```

预期：0 failed。

- [x] **步骤 2：运行类型检查**

运行：

```powershell
npm.cmd run typecheck
npm.cmd run desktop:typecheck
```

预期：两个命令退出码均为 0。

- [x] **步骤 3：用新状态库执行首窗口真实试译**

运行：

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\children_of_time\source_manifest.json `
  --store ..\projects\children_of_time\artifacts\folioloom\heading-fix.db `
  --config ..\config\config.yaml `
  --opencode-auth C:\Users\admin\.local\share\opencode\auth.json `
  --max-windows 1 `
  --max-concurrency 1 `
  --output ..\projects\children_of_time\exports\heading-fix
```

预期：处理首个窗口，译文数据库没有失败窗口，并生成 partial TXT。

- [x] **步骤 4：核对真实标题输出**

运行：

```powershell
Get-Content -LiteralPath `
  '..\projects\children_of_time\exports\heading-fix\folioloom_book_translation.partial.txt' `
  -Encoding UTF8 |
  Select-Object -First 12
```

预期：标题按自然中文顺序出现，例如 `时间 / 之子` 或其他保持两个段落槽位的等价自然译法；不得再次出现 `子 / 时间之`。

- [x] **步骤 5：运行最终工作树核对**

运行：

```powershell
git status --short
git log -2 --oneline
```

预期：没有未提交的受版本控制变更；最新实现提交为 `fix: preserve Chinese order in multiline headings`。
