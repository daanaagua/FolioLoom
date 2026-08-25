# FolioLoom

`folioloom/` 是 FolioLoom 的 TypeScript 翻译内核，也是本地 Electron 工作台的运行目录。它保留完整命令行工作流，并提供书稿导入、模型连接检查、单片段试译、整本运行与严格导出入口。

## 安装

要求：Node.js 24+ 与 Windows。

```powershell
Set-Location folioloom
npm.cmd install
```

完整的原文导入、模型配置和 `book` 命令说明见仓库根目录的 [README](../README.md)。

## 本地桌面工作台

桌面端已经随 FolioLoom v1.5.3 提供 Windows x64 便携包。普通用户不需要理解内部清单或数据库，按以下步骤操作即可：

1. 选择 TXT、EPUB、DOCX 或 Markdown 书稿；
2. 选择 DeepSeek、Kimi、阿里云百炼、火山方舟、OpenAI、硅基流动或自定义兼容服务，填写 API Key、模型与 provider 原始 effort 值；DeepSeek 只提供当前的 `deepseek-v4-flash` 和 `deepseek-v4-pro`；
3. 完成真实兼容性检查后，试译一个短片段；
4. 在“翻译运行”中开始整本翻译，需要时安全暂停，并可在应用重启后继续；
5. 完整性审计通过后，从“导出”选择中文 TXT、双语 TXT、EPUB 或全部格式。

```powershell
Set-Location folioloom
npm.cmd install
npm.cmd run desktop:dev
```

不需要开发环境的用户可以从
[GitHub Releases](https://github.com/daanaagua/novel-translate/releases/latest)
下载 `FolioLoom-portable-win-x64.zip`，完整解压后运行根目录的 `FolioLoom.exe`。

连接检查会验证真实流式响应、工具调用和多轮连续性；只有 `ready` 状态可以开始试译或整本翻译。`limited` 和 `failed` 会显示可执行原因，不会被包装成成功。试译只运行一个串行窗口，不会暗中启动全书翻译。

### 当前边界与密钥策略

- API Key 只进入 Electron 主进程；不会返回渲染器、写入偏好、项目、测试快照或安装包。
- Windows `safeStorage` 可用时仅保存加密密文；不可用时使用明确的会话模式，关闭应用即失效。
- 预设厂商地址由程序固定，普通界面不要求填写协议或 Base URL；只有自定义兼容入口允许填写经过校验的 HTTPS 地址或本机 loopback HTTP 地址。
- 书稿导入复制原始字节并建立可校验项目，绝不覆盖用户选择的原文件。
- 英语、德语、法语、西班牙语、俄语、日语和韩语可在导入时自动检测或手工指定；西欧 TXT 支持 UTF-8、UTF-16 和 Windows-1252。
- 试译写入项目内 `artifacts/folioloom/book.db`，支持读取上次已提交结果；取消或退出不会中断已经进入的原子提交。
- 整本运行同一时间只允许一个活动任务；暂停会停在持久边界，重启后根据 SQLite 中的原运行元数据继续，不会悄悄更换模型或 effort。
- 导出只开放完整且审计通过的运行；中文 TXT、双语 TXT 和 EPUB 会先写入临时目录并严格校验，通过后再原子发布到用户选择的目录。
- “术语与记忆”已经支持分页浏览、筛选、详情、证据、关系、历史、影响诊断、人工修改、恢复旧版本、全局术语附加与多格式导入。
- 左侧“导出诊断”及错误面板中的诊断按钮会生成严格隐私模式 JSON；其中不含 API Key、原文、译文、提示词、模型原始响应或完整私人路径，可直接用于反馈试译失败。
- “需要处理”会列出文本块位置、失败类别、公开错误码和建议动作；安全重试只对 `human_required` 开放一次，并复用既有影子恢复、完整审计和原子晋升协议。
- 逐段人工改译与批量审阅尚未接入桌面入口，继续作为后续功能；命令行工作流保持兼容。
- `desktop:dist` 会同时生成 Windows x64 单文件便携版
  `release/FolioLoom-portable-win-x64.exe` 和目录便携版
  `release/FolioLoom-portable-win-x64.zip`。普通用户建议下载 ZIP，完整解压后直接双击根目录的
  `FolioLoom.exe`；旁边的 DLL、`resources` 和 `locales` 都是运行所需内容，不能只把 EXE
  单独移动出去。

## 动态调度档位

整本运行可以在不改变逻辑窗口、提交顺序、质量校验或数据库结构的前提下，动态选择同一模型的上下文档案、合法 effort、响应协议和并发批次。三个档位使用同一套质量硬门：

- `economy`（经济）：优先控制 token，计划 token 上限为静态基线的 105%；
- `balanced`（均衡）：同时权衡时间、token 和返工风险，上限为静态基线的 110%；
- `speed`（极速）：优先缩短墙钟时间，上限为静态基线的 120%。

桌面端在“翻译运行”中提供“经济”“均衡”“极速”三个按钮。开始后界面显示预计剩余时间、预计 token 区间、实际与预计偏差，以及因限流而调整并发或进入恢复的状态。旧的进行中运行仍按其持久化策略恢复，不会在升级后自动切换为动态调度。

命令行可以明确选择档位和调度模式：

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --optimization-profile balanced `
  --scheduler-mode active `
  --runtime-profile-store "$HOME\.folioloom\runtime-profiles.db"
```

`--scheduler-mode` 支持：

- `active`：执行滚动计划选出的合法方案；
- `shadow`：计算并记录计划，但仍按旧派发顺序和旧 runtime 执行，用于上线前对比；
- `off`：关闭滚动规划，完整回退到旧派发路径。

旧参数继续兼容：`--run-mode quality` 映射到 `balanced`，`--run-mode fast` 映射到 `speed`；若同时给出互相冲突的旧模式和新档位，命令会直接拒绝。CLI 未指定 profile store 时使用用户目录下的 `.folioloom/runtime-profiles.db`；桌面端使用 Electron `userData` 下独立的 `runtime-profiles.db`。该库只保存模型、语言、任务 ID 和聚合数值观察，不保存 API Key、原文、译文、提示词或模型原始响应。

调度性能数据只代表对应硬件、模型、供应商状态和样本下的实测结果，不是跨模型或跨供应商的速度承诺。遇到供应商限流、usage 不完整或成本模型冷启动时，运行器会保守估算、降低并发或回退，不会跳过完整性与知识收敛门。

## 术语与记忆工作台

打开一本已经完成试译或建立翻译运行的书，在左侧进入“术语与记忆”。工作台读取的是当前项目实际使用的知识版本，不是另一份只供界面展示的词表。

- 顶部可以按名称、译名、对象类型、状态、来源和作用域筛选；大库使用游标分页，不会一次把全部记录送进渲染器。
- 选择一条记录后可以查看当前内容、来源证据、版本历史、对象关系和受影响的已译文本块。
- 人工编辑只提交勾选的字段，并要求当前 revision 与作用域 revision 未被其他操作修改；冲突时会要求刷新，不会静默覆盖。
- “恢复此版本”会追加一条新的 rollback revision，历史记录不会被删除。
- `book` 作用域只影响当前书，`project` 作用域可供同一项目后续运行复用；通用 term/style 需要从工作台显式提升或附加，其他项目不会随全局库更新而静默漂移。

## 导入已有术语与知识

### 使用 FolioLoom 官方模板

仓库内的 [knowledge-import-template.json](config/knowledge-import-template.json) 是可直接复制填写的官方 JSON 模板。保留根节点的 `schema`、`scope` 和 `records`，在 `records` 中填写知识项后，从“术语与记忆”右上角选择“导入知识”。

官方模板会自动识别字段，但仍会先展示只读映射摘要和导入预览；确认前不会写入正式知识库。当前支持 JSON、YAML、CSV 和 XLSX，单个文件上限为 64 MiB、100,000 条数据记录和 256 列。

### 映射任意 JSON、YAML、CSV 或 XLSX

普通文件不必改造成官方模板。向导会让用户选择 JSON/YAML 记录数组、XLSX 工作表或 CSV 标题行，并把源列映射到 FolioLoom 字段。高置信映射可以直接确认；中低置信字段必须由用户选择后才能生成预览。

导入时可选择：

- `term`：原词、中文译法、词性、语域、来源形式等；
- `entity`：人物或地点的规范名称、别名与说明；
- `alias`、`relation`、`memory`、`style`：别名关系、实体关系、叙事记忆或文体指令；
- `book` 或 `project` 作用域。默认使用当前书，不会自动写入全局库。

CSV 若存在编码歧义，会先显示候选编码和短预览；只有明确确认后才继续。文件路径始终保留在 Electron 主进程，渲染器只收到临时 ID 和安全摘要。

### 处理冲突与无效行

导入内容先进入磁盘暂存区。系统按“同一对象、同一 kind、同一作用域”比较现有版本，并把记录分为新增、安全合并、冲突和无效。冲突允许的操作会按对象类型收窄：

- 保留现有值；
- 采用导入值；
- 合并为别名；
- 另建对象并填写新的规范名称；
- 跳过该行。

仍有未解决冲突或未明确跳过的无效行时，“确认导入”不可用。关闭应用不会丢失已暂存决策；下次打开向导可继续处理，也可以显式丢弃后重新导入同一文件。

### 提交、撤销和重新扫描

确认导入会在一个数据库事务中追加知识 revision、目录 revision、快照和 generation；任何一项失败都会整体回滚。重复提交同一 batch 不会重复写入。导入完成页可以撤销整批，撤销同样通过追加版本完成，不删除审计历史。

导入术语本身不要求重新扫描全文，下一轮翻译会读取新的当前快照。只有希望为新术语补全全书位置证据、关系或叙事记忆时，才需要另行运行离线证据索引。

### 安全边界与不支持的格式

- 不接受 renderer 传入的任意路径、SQL、表名或解析器参数，也不提供直接编辑 SQLite 的入口。
- 不支持旧版 `.xls`、带宏的 `.xlsm`、公式执行、外部工作簿链接、外部 XML 实体或 YAML 任意对象标签。
- XLSX 公式只作为不可信输入拒绝处理；ZIP 路径穿越、压缩炸弹、损坏归档、过深 JSON/YAML、重复键和超限单元格都有固定错误。
- 导入完成后仍以 append-only revision 链和当前知识快照作为唯一事实来源；原始 JSON、YAML、CSV 或 XLSX 不是运行时数据库。

## 开发验证

```powershell
npm.cmd run desktop:test
npm.cmd run desktop:typecheck
npm.cmd run typecheck
npm.cmd run desktop:build
npm.cmd test
```

`desktop:build` 只构建本地 Electron 资源，并断言主进程实际使用的 preload 与 renderer 入口存在。它不会调用模型或创建翻译输出。

## 私有日/韩基准

`benchmark:cjk` 默认只生成离线计划，不会调用模型。它读取 `FOLIOLOOM_JA_SOURCE`、`FOLIOLOOM_KO_SOURCE`、`BENCH_CONFIG`、`OPENCODE_AUTH` 与 `BENCH_OUTPUT`（旧的 `FOLIOLOOM_BENCH_*` 名称仍可用），并只把哈希、Unicode scalar 范围、语言画像和计划写入输出目录。

```powershell
npm.cmd run benchmark:cjk
```

计划固定为：日、韩各一个 20k scalar 的 `quality/high` 与 `fast/off` 对照；门槛通过后的正式吞吐验证为全量日文和约 200k scalar 韩文，均使用 `fast/off`。报告不会保存原文、源路径、API Key 或模型原始响应。

实际执行必须显式传入受控 adapter，因而不会由默认脚本暗中产生付费请求。维护者可设置 `BENCH_EXECUTOR_MODULE`（或 `FOLIOLOOM_BENCH_EXECUTOR_MODULE`）并明确运行：

```powershell
npm.cmd run benchmark:cjk -- --execute
```

该模块需要导出 `executeCjkBenchmarkRequest(request)`；它只应返回聚合指标，例如模型、effort、usage、请求数、重试数和错误分类。基准 harness 会再次过滤这些字段，拒绝把正文或原始响应写入报告。
