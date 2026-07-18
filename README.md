# FolioLoom

> A continuity-aware translation engine for long-form fiction.

FolioLoom 是一个面向长篇小说的开源 AI 翻译引擎。它把原文完整性、叙事记忆、实体别名、术语连续性、局部风格和失败恢复作为同一条可审计流水线处理，目标是让复杂小说在分块、并行和长时间运行后仍保持可追溯的一致性。

当前版本为 **FolioLoom v1.0.0**。正式内核位于 [`translator-v5/`](translator-v5/)，以 TypeScript 编写；仓库根目录的 Python 代码主要承担 TXT、Markdown、DOCX、EPUB 输入适配，并保留 V1–V4 的研究历史。

## V1.0 能做什么

- 为原始文本建立带哈希和位置映射的无损账本；
- 按逻辑窗口串行或有限并行翻译，并在中断后恢复；
- 按证据记录实体别名、候选关系和再验证状态；
- 在每个并行波次冻结术语锚点，减少兄弟窗口的译名漂移；
- 组合书级风格约束、人物声音、语体权重和衰减的局部状态；
- 对漏译、异常残留和结构错误执行确定性校验与一次局部修复；
- 从 SQLite 状态库导出中文 TXT、双语 TXT 和审计报告。

## 当前限制

- 当前主要通过命令行使用，没有统一的 V1.0 GUI；
- V4 的本地裁决页和旧 Streamlit 页面仍保留，但不是 V1.0 主入口；
- 已完成离线回归和真实模型的一窗口、三窗口门禁，尚未发布最新版架构的全书质量基准；
- 配置和错误信息仍偏向开发者，尚无桌面安装包；
- 示例配置以 DeepSeek 为主，其他服务需要兼容相同的聊天接口和配置语义。

## 安装

要求：Windows、Python 3.11+、Node.js 24+。

```powershell
git clone https://github.com/daanaagua/FolioLoom.git
Set-Location FolioLoom

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

Set-Location translator-v5
npm.cmd ci
Set-Location ..
```

复制示例配置。V1.0 可以把真实 API Key 写入不会被 Git 跟踪的 `config/config.yaml`，也可以在运行命令中使用 `--opencode-auth` 从本机 OpenCode 的认证文件读取：

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

Set-Location translator-v5

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

## V1.0 命令

所有命令在 `translator-v5/` 中执行。

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

这些入口继续可用，但 FolioLoom V1.0 的正式翻译内核是 `translator-v5`。

## License

[MIT](LICENSE)
