# 可配置翻译文风与受限 CLI Prompt 设计

## 目标

让 FolioLoom V1 用户能够在不改动 TypeScript 源码的前提下，为一次翻译运行选择可复现的书级中文文风；同时提供一次性的 `--prompt` 文风补充入口。两者都不能覆盖原文、术语、结构化提交和完整性校验协议。

## 非目标

- 不提供任意系统提示词替换。
- 不改变术语表、知识库、实体消歧或模型配置接口。
- 不为旧 Python/V1--V4 流程增加新功能。
- 不修改已开始运行的 run 的文风。

## 用户接口

`book run` 新增两个可选参数：

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --style-profile ..\projects\my_book\style.yaml `
  --prompt "对白自然，避免过度古雅化"
```

`--style-profile` 的 YAML 结构固定为：

```yaml
style:
  register: "准确、克制，有文学感，但不古雅化"
  sentencePolicy: "保留原句关系；中文过长时自然拆句"
  explicitation: "不解释歧义，不替作者补因果"
  imagery: "保留陌生意象和比喻，不替换成中文俗语"
  dialogue: "对白自然，避免网络流行语"
  technicalProse: "术语、数字、单位优先准确清楚"
  typography: "使用规范中文标点和弯引号"
  narratorVoice: "保持主叙述者既定视角、距离和信息显隐"
  additionalInstruction: "专名以术语表为准。"
```

字段可以省略；省略时沿用 V1 内置默认值。配置根仅允许 `style`，`style` 内仅允许上述八个字段，所有值必须是非空字符串。

## 优先级与安全边界

文风输入按下列顺序合并：

1. V1 内置默认文风；
2. `style.yaml` 中存在的字段；
3. `--prompt`，仅追加到 `additionalInstruction` 末尾。

`--prompt` 不会写回 YAML，也不会替换其中任一结构化字段。它的唯一作用是给本次运行增加一条低优先级文风要求。

系统提示词继续拥有更高优先级，明确要求：用户文风要求只可改变中文行文选择，绝不可改变原文含义、歧义显隐、术语锁定、块边界、工具调用和校验协议。

每个普通文风字段最多 180 个 Unicode 标量；`additionalInstruction` 与 `--prompt` 分别最多 600 个 Unicode 标量。CLI prompt 与配置中的附加指令合并后仍最多 600 个 Unicode 标量，避免文风控制挤占翻译上下文。空白文本、未知字段、错误 YAML 和超限输入均在模型调用前报错。

## 可复现性

运行开始前，加载器将合并后的样式状态规范化为稳定 JSON，并计算 SHA-256 哈希。该哈希和“是否使用 profile / CLI prompt”的来源标记写入 `runMeta.metadata`；不写入完整的自由文本。

同一 `runId` 恢复时，`LosslessBookStore.createTranslationRun` 会比较 metadata。若用户修改样式文件、修改 `--prompt` 或省略之前使用的任一输入，哈希不同，恢复将被拒绝，避免一本书前后两种文风。

未提供任一新参数时，运行 metadata 的兼容行为保持现状，默认文风也不变。

## 内部结构

新增 `src/style/style-profile.ts`：

- 读取并解析 YAML；
- 验证允许字段、类型、长度和空白；
- 合并样式文件和 CLI prompt；
- 返回 `StyleState`、稳定 hash 与来源标记。

`StyleState` 继续作为运行时传递对象。书级 `BookStyleConstitution` 新增 `additionalInstruction`，`losslessStyleConstitution()` 将其投影进去；`projectEffectiveStyle()` 将它作为明确标记的“用户附加文风要求”送入模型。

`cli.ts` 解析新参数、调用 profile 加载器、把样式状态传入 `runBook()`，并把 style 元数据并入 run metadata。`book run` 以外的命令不读取样式文件，也不受影响。

## 测试与文档

测试覆盖：

- YAML 读取、字段合并、稳定 hash、未知字段和长度错误；
- `book run` 对两个新参数的解析；
- 样式状态进入书级投影，附加要求被清晰地投给翻译模型；
- 不同的 profile / prompt 导致恢复元数据不匹配；
- 没有 profile 和 prompt 的既有命令保持可用。

README 增加最小示例和限制说明；提供 `config/style.example.yaml` 作为可复制模板。
