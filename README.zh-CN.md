# FolioLoom

[English](README.md) | **简体中文**

> A continuity-aware translation engine for long-form fiction.

FolioLoom 是一个面向长篇小说的开源 AI 翻译引擎。它把原文完整性、叙事记忆、实体别名、术语连续性、局部风格和失败恢复作为同一条可审计流水线处理，目标是让复杂小说在分块、并行和长时间运行后仍保持可追溯的一致性。

当前版本为 **FolioLoom v1.7.2**。正式内核位于 [`folioloom/`](folioloom/)，以 TypeScript 编写；仓库根目录的 Python 代码主要承担 TXT、Markdown、DOCX、EPUB 输入适配，并保留 V1–V4 的研究历史。

v1.7.2 增加实时模型扫描与明确的备用列表提示，新 DeepSeek 配置默认使用 `deepseek-flash`，精简模型侧术语数据并合并等价推理策略。已有模型选择、任务身份和严格审计规则保持不变。详情见[补丁说明](docs/releases/v1.7.2.md)。

## V1.7.2 能做什么

- 为原始文本建立带哈希和位置映射的无损账本；
- 按逻辑窗口串行或有限并行翻译，并在中断后恢复；
- 按证据记录实体别名、候选关系和再验证状态；
- 在每个并行波次冻结术语锚点，减少兄弟窗口的译名漂移；
- 组合书级风格约束、人物声音、语体权重和衰减的局部状态；
- 对漏译、异常残留和结构错误执行确定性校验与一次局部修复；
- 从 SQLite 状态库导出中文 TXT、双语 TXT、EPUB 和审计报告；
- 对新导入的 EPUB 以原书为导出模板，保留脚注、返回链接、跨章节链接、外部 URL、OPF/spine/nav、样式及其他资源；结构槽或内部链接异常时拒绝发布损坏文件；
- 通过 Electron 桌面端完成书稿导入、模型连接、试译、整本运行、暂停恢复、导出、术语与叙事记忆维护；
- 导入 JSON、YAML、CSV 或 XLSX 术语数据，并在写入前处理字段映射和冲突；
- 在整本翻译运行中审查和提交术语修改；在途请求继续使用旧快照，修改只在下一持久波次边界应用一次；
- 按不可变原文块区间为同一实体或术语指定不同中文称呼，并以固定优先级解析、显式拒绝同级重叠冲突；
- 预览并执行可审计的批量修词：回执唯一时生成本地新译文版本，存在歧义时复用稀疏模型重验证，作业可以续跑、回滚，并纳入严格导出门禁；
- 针对英语、德语、法语、西班牙语、俄语、日语和韩语提供语言画像，并支持常见 Unicode、Windows-1252 及日韩传统编码；
- 一键导出不含密钥、书稿、译文和完整私人路径的诊断 JSON，便于定位导入、连接、试译、校验或提交阶段的失败；
- 在桌面端列出需要处理的文本块、失败类别、公开错误码和下一步；可恢复项只允许一次经过影子审计与原子晋升的安全重试；
- 填入凭据后自动扫描服务端模型列表，支持手动刷新并明确标注备用列表。DeepSeek 新配置默认使用 `deepseek-flash`，已有兼容模型 ID 保持不变。
- 可选使用隔离的 `codex exec` worker，复用用户现有的 Codex CLI 登录，不需要另配模型 API Key 或服务商配置；
- 通过仓库内的 [`$folioloom-translate`](.agents/skills/folioloom-translate/SKILL.md) skill 完成书稿导入、有界试译、原运行续跑、审计和严格导出；
- 在相邻逻辑窗口之间安全摊薄 Codex 文件调用开销，同时保留逐窗口校验与提交；高段落块先整块尝试、失败后再进入有界碎片恢复，并将重段落 DOCX 导入改为线性处理。

## V4 Flash 100K 实测

FolioLoom v1.5.1 使用当前 `deepseek-v4-flash` 模型、Active/Balanced 调度和 3 路并发，在全新项目数据库上的前 100K 字符实测如下；v1.5.2 增加 EPUB 结构保真，v1.5.3 增加桌面端处理与恢复工作流，v1.6.0 新增独立的 Codex worker 路径，v1.7.0 新增运行中术语控制与审计式修词，不改变这些历史实测数据：

- 德语《变形记》：**10 分 55 秒**；
- 英语《时间之子》第一部：**18 分 56 秒**。

两次运行均完成严格导出与审计，且没有 human-required 或 failed 窗口。实际耗时仍会受模型服务负载、网络状况、段落结构和知识重验证次数影响；上述数字是本次发布验收样本，不是固定速度承诺。详细口径与结果见[双语 100K 验收报告](docs/superpowers/reports/2026-07-30-translation-throughput-and-revalidation-live-validation.md)。

## 当前限制

- 当前发布 Windows x64 单文件便携版和目录便携 ZIP，尚未提供代码签名；
- V4 的本地裁决页和旧 Streamlit 页面仍保留，但不是当前版本主入口；
- 已完成离线回归和真实模型的一窗口、三窗口门禁，尚未发布最新版架构的全书质量基准；
- 桌面端已接通书稿导入、模型兼容性检查、单片段试译、整本开始、暂停、恢复、运行中术语审查、审计式批量修词、需要处理中心和严格导出；逐段人工改译与一般批量审阅仍是后续工作；
- 桌面端内置 DeepSeek、Kimi、阿里云百炼、火山方舟、OpenAI、硅基流动及自定义 OpenAI-compatible 接口入口；刷新列表不会自动更换已选模型，各模型仍须通过真实兼容性检查。已停用的 DeepSeek 路由（`deepseek-chat`、`deepseek-reasoner`）会被明确拒绝。
- Codex worker 当前只提供命令行/skill 工作流，需要本机安装并登录 Codex CLI，并有意限制为 `--max-concurrency 1`；它尚未接入桌面端。
- EPUB 原模板保真只适用于由 v1.5.2 重新导入的项目；旧项目不会用模糊对齐猜测链接位置，需重新导入原 EPUB 后再翻译。

## 安装

要求：Windows、Python 3.11+、Node.js 24+。

```powershell
git clone https://github.com/daanaagua/FolioLoom.git
Set-Location FolioLoom

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

Set-Location folioloom
npm.cmd ci
Set-Location ..
```

使用服务商 API 时，先复制示例配置。可以把真实 API Key 写入不会被 Git 跟踪的 `config/config.yaml`，也可以在运行命令中使用 `--opencode-auth` 从本机 OpenCode 的认证文件读取；Codex worker 不使用这两个选项。

```powershell
Copy-Item config\config.example.yaml config\config.yaml
# 编辑 config\config.yaml，将 api_key 占位值替换为本机密钥；
# 或在 book run 后附加：
# --opencode-auth "$HOME\.local\share\opencode\auth.json"
```

真实密钥、小说原文、项目数据库和模型输出都不应提交到 Git。

## 快速开始

以下示例先建立 `my_book` 项目，再只翻译一个窗口进行检查。

```powershell
# 在仓库根目录执行；支持 .txt/.md/.docx/.epub
.\.venv\Scripts\python.exe main.py init my_book "D:\books\my_book.epub" `
  --source-language en

Set-Location folioloom

# 只读检查原文覆盖、分块和异常，不调用模型
npm.cmd run folioloom -- book doctor `
  --manifest ..\projects\my_book\source_manifest.json

# 翻译一个逻辑窗口
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --max-windows 1 `
  --max-concurrency 1

# 查看状态；若状态库中只有一个运行，可以省略 --run
npm.cmd run folioloom -- book status `
  --store ..\projects\my_book\artifacts\folioloom\book.db
```

确认试译后，重复 `book run` 并移除 `--max-windows 1` 即可继续。运行器会跳过已经提交的窗口。

## 运行中术语控制与审计式修词

桌面端“术语与记忆”可以在整本翻译运行时保存术语。在途窗口尚未结束时，修改会先持久排队，并在下一波次边界生效。译名规则可以覆盖全书，也可以覆盖包含两端的不可变原文块区间；端点过期或同级规则重叠时会明确拒绝，不会猜测。

保存规则后，在“术语控制”中预览精确影响。执行锁定计划时，回执唯一的安全替换会产生新译文版本；存在歧义的块进入既有稀疏模型重验证。未执行的计划可以取消，完成或需要处理的作业可以回滚。排队中的修改、尚未处理的活动术语影响和未收敛的修词 item 都会阻断严格导出。

CLI 和私有 Codex skill 使用同一个控制面：

```powershell
npm.cmd run folioloom -- book knowledge queue-status --store <book.db> --run <run-id>
npm.cmd run folioloom -- book retrofit plan --store <book.db> --run <run-id> `
  --revision <rule-revision-id> --request <unique-request-id>
npm.cmd run folioloom -- book retrofit apply --store <book.db> --run <run-id> `
  --job <job-id> --plan-hash <plan-hash>
npm.cmd run folioloom -- book retrofit status --store <book.db> --run <run-id>
npm.cmd run folioloom -- book retrofit rollback --store <book.db> --run <run-id> `
  --job <job-id>
```

类型化 term-upsert JSON 和完整安全流程见 [terminology-control 参考](.agents/skills/folioloom-translate/references/terminology-control.md)。CLI 与 skill 都不会直接改写 SQLite。

## 使用已登录的 Codex CLI 翻译

FolioLoom v1.7.1 可以把隔离的 `codex exec` 子进程用作模型传输层。它复用本机 Codex 的交互式登录，因此不需要单独的模型 API Key。原文身份、有界请求、校验、恢复、SQLite 提交、审计与导出仍由 FolioLoom 负责；每个子进程只看到当前模型任务，且不能写入项目。

安装 Codex CLI 并执行 `codex login` 后，从仓库根目录启动 Codex。Codex 会从 `.agents/skills/folioloom-translate` 发现仓库级 skill；直接传入待翻译文件，不要把整本书粘贴进对话：

```text
使用 $folioloom-translate，把 D:\books\my_book.epub 从英语翻译为简体中文，模型使用 MODEL_ID。
```

skill 会先执行只读环境检查，导入获准处理的原文，完成确定性预检，最多试译两个逻辑窗口供检查，然后沿同一个持久运行继续，最后完成审计与严格导出。若要在仓库外使用，可把完整的 `.agents/skills/folioloom-translate` 目录复制到用户级 `.agents/skills`；不要同时复制书稿、`projects/`、数据库、导出文件或 Codex 登录状态。

完成原生 `book import` 和 `book doctor` 后，对应的首次命令行调用是：

```powershell
Set-Location folioloom
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --worker codex `
  --codex-model "MODEL_ID" `
  --max-windows 2 `
  --max-concurrency 1 `
  --output ..\projects\my_book\exports\codex
```

续跑时必须使用返回的 `--run` ID，并保持模型、文风、术语表和策略选项不变；检查部分导出后再移除 `--max-windows 2`。最终交付仍须依次通过 `book audit`、严格 `book export` 和 `book verify-export`。

## 本地桌面工作台（开发预览）

桌面工作台允许普通用户选择书稿、连接模型、先试译一小段，再开始整本翻译和导出。它可以直接导入 TXT、EPUB、DOCX 或 Markdown；内部项目文件和数据库无需手动选择。

```powershell
Set-Location folioloom
npm.cmd install
npm.cmd run desktop:dev
```

打开后按界面完成以下步骤：

1. 选择一本有权处理的书稿；
2. 选择模型服务，输入自己的 API Key、模型与原始 effort 值；
3. 测试连接，通过后运行一次单片段试译；
4. 在“翻译运行”中选择质量或快速模式，开始整本翻译；运行可安全暂停，并可在重启应用后继续；
5. 翻译完整且审计通过后，在“导出”中选择中文 TXT、双语 TXT、EPUB 或三者全部。

API Key 不会进入项目、日志、界面返回值或安装包。Windows 系统加密可用时，密钥以 Electron `safeStorage` 密文保存；不可用时只保留到当前应用会话结束。试译固定为一个串行窗口；整本运行把进度和译文提交到该书稿自己的 SQLite 状态库，不改写原始文件。暂停或关闭应用会先取消当前模型请求并等待持久状态落稳；恢复时沿用原运行的模型策略。导出只接受已完整翻译且严格校验通过的运行，并为 TXT 与 EPUB 保留可追溯谱系。

遇到试译失败时，可以从错误面板或左侧常驻入口导出诊断 JSON。严格隐私模式只保留版本、运行阶段、状态、计数、错误码和已经脱敏的错误链，不保存 API Key、Authorization、原文、译文、提示词、模型原始响应或完整私人路径。

`npm.cmd run desktop:dist` 可在本机生成 Windows x64 portable 构建；普通用户也可以从 [GitHub Releases](https://github.com/daanaagua/FolioLoom/releases/latest) 下载目录便携 ZIP。桌面端的开发与安全边界见 [`folioloom/README.md`](folioloom/README.md)。

## 调整翻译文风

FolioLoom 的文风配置只影响中文措辞、句法节奏和排版偏好；它不能改写原意、消除歧义、替换术语、改变分块边界或绕过校验协议。这样可以在维持全书一致性的同时，让译文更接近你的阅读偏好。

### 可复用的 YAML 文风档

从示例复制一份配置，只填写需要改动的字段即可：

```powershell
Copy-Item ..\config\style.example.yaml ..\config\style.yaml
# 编辑 ..\config\style.yaml

npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --style-profile ..\config\style.yaml
```

文风档使用 `style:` 下的可选字段：`register`、`sentencePolicy`、`explicitation`、`imagery`、`dialogue`、`technicalProse`、`typography`、`narratorVoice` 和 `additionalInstruction`。完整模板见 [`config/style.example.yaml`](config/style.example.yaml)。常规字段上限为 180 个 Unicode 字符，`additionalInstruction` 上限为 600 个。

### 一次性的 `--prompt`

如果只想为本次运行补一条最终文风要求，可以附加 `--prompt`。它只会追加到运行时的 `additionalInstruction`，不会改写你的 YAML 文件，也不会替换系统提示词：

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --prompt "这一版对白更克制，避免现代网络口吻"
```

`--style-profile` 和 `--prompt` 可以同时使用；两者的附加要求会按“YAML 在前、`--prompt` 在后”合并，合计最多 600 个 Unicode 字符。

每次运行都会把**生效后的**文风配置哈希写入 SQLite metadata。恢复已有运行时，必须继续传入能产生相同生效配置的 `--style-profile` 和/或 `--prompt`；配置发生变化时，FolioLoom 会拒绝恢复，防止一本书的后半段悄悄换一种文风。若需要尝试新文风，请使用新的状态库（`--store`）开启新运行。

## 导入术语表

术语表是给已经明确的译名、别名和称谓规则准备的“用户种子”，不是另一份需要模型全文阅读的提示词。FolioLoom 会在本地按源语言词元规则定位这些形式；这一步不调用模型，也不消耗 API token。翻译时，只有当前请求原文中实际出现的导入术语会进入模型上下文，既有叙事记忆和模型已确认的锚点仍按原有方式维持全局连续性。

最简单的 JSON 可以直接写成“原文形式 → 默认译法”：

```json
{
  "Severian": "塞万里安",
  "Typhon": "提丰"
}
```

需要处理别形或中文语境差异时，使用结构化格式；可复制 [`config/glossary.example.json`](config/glossary.example.json)：

```json
{
  "schema": "folioloom-glossary-1",
  "terms": [
    {
      "source": "Severian",
      "target": "塞万里安",
      "policy": "locked",
      "forms": ["Severian's"]
    },
    {
      "source": "Archon",
      "target": "执政官",
      "policy": "contextual",
      "note": "作为官职时译为“执政官”；直接呼告时可按中文语境译为“阁下”。"
    }
  ]
}
```

三种 `policy` 的区别：

- `locked`：在命中该原文形式的块中，校验器要求使用指定译法；适合已经确定的专名。
- `preferred`：默认策略，作为首选译法提供给模型，但不把所有语境冻结为一个字面形式。
- `contextual`：提供译名与说明，不启用字面硬锁；适合官职、敬语和中文必须随句法变化的称谓。

先运行无模型的检查，查看每个词命中了哪些 `globalIndex`，以及有哪些形式在原文中尚未命中：

```powershell
npm.cmd run folioloom -- book doctor `
  --manifest ..\projects\my_book\source_manifest.json `
  --glossary ..\config\glossary.json
```

确认报告后，把同一份表传给正式运行：

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --glossary ..\config\glossary.json
```

术语表会被规范化后计算语义哈希并写入 run metadata。恢复同一 run 时必须继续提供语义相同的 `--glossary`；只调整 JSON 空白、对象键顺序、术语数组顺序或文件路径不影响恢复，修改原文形式、译法、策略、别形或注释则会被拒绝。若要换一份术语表，请使用新的 `--store` 开始新 run。

## V1.0 命令

所有命令在 `folioloom/` 中执行。

```powershell
# 使用旧 V4 SQLite 数据估算窗口；只读且不调用模型
npm.cmd run folioloom -- book preflight --db ..\projects\my_book\artifacts\parallel_v4\book.db

# 对认证原文执行独立检查
npm.cmd run folioloom -- book doctor --manifest ..\projects\my_book\source_manifest.json

# 运行或继续翻译
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml

# 状态和恢复
npm.cmd run folioloom -- book status --store ..\projects\my_book\artifacts\folioloom\book.db
npm.cmd run folioloom -- book recover `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --run RUN_ID `
  --incident INCIDENT_CODE

# 独立审计与导出
npm.cmd run folioloom -- book audit `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --run RUN_ID
npm.cmd run folioloom -- book export `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --run RUN_ID `
  --output ..\projects\my_book\exports\folioloom
```

`recover` 的附加参数取决于事件类型。结构或源文本事件可能还需要 `--manifest`；需要模型参与的受限修复需要 `--config`。系统不会通过压缩原文、丢弃规则或伪造完成状态来绕过预算错误。

## 设计重点

FolioLoom 的核心不是把尽可能多的背景材料塞进模型，而是只按当前位置投影必要知识：

1. 原文账本和窗口规划器决定不可丢失的文本边界；
2. 有界 Agent 只登记翻译所需疑问，并通过受限工具检索证据；
3. 已确认实体、术语和叙事记忆按位置开放；
4. 同一并行波次共享不可变锚点和前态；
5. 每个窗口单独校验、提交或隔离，失败不会污染相邻译文；
6. 独立 Auditor 从认证原文和 SQLite 重新计算覆盖与顺序。

详细设计和实施记录位于 [`docs/superpowers/`](docs/superpowers/)。

## 数据、密钥与版权

- API Key 只应存在于环境变量、本机配置或未跟踪的 `config/config.yaml`；
- `projects/`、数据库、日志、导出文件和下载的小说由 `.gitignore` 排除；
- 源文件异常只会报告，不会静默改写认证原文；
- 请只翻译自己拥有或获准处理的文本，并自行承担译文发布所需的版权责任。

## Legacy V1–V4

仓库根目录的 `main.py` 仍保留旧串行流程和 parallel_v4 工具，用于创建输入项目、导入旧译文、人工盲评及历史数据迁移。常用入口包括：

```powershell
.\.venv\Scripts\python.exe main.py serve-v4 my_book
.\.venv\Scripts\python.exe main.py review-v4 my_book
.\.venv\Scripts\python.exe main.py export-v4 my_book
```

这些入口继续可用，但 FolioLoom V1.0 的正式翻译内核是 `folioloom`。

## License

[MIT](LICENSE)
