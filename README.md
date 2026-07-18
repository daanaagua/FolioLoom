# DeepNovel-Translator

面向长篇、高难度小说的两层AI翻译工具。当前版本支持TXT、Markdown、DOCX和EPUB，默认使用 `deepseek-v4-flash`。

## 当前流程

1. 第一层对照原文生成忠实初译，同时输出必要的难点说明、术语建议、实体关系和更新后的全书滚动摘要。
2. 第二层重新对照原文、初译、术语与上下文，修正误译和中文表达，只输出最终译文。
3. 每块完成后立即保存；再次运行会跳过已经完成的块。

每次翻译只有两次模型调用。逻辑分析和滚动摘要包含在第一层中，不另行增加第三次摘要请求。

## 安装

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

复制并修改配置：

```powershell
Copy-Item config\config.example.yaml config\config.yaml
```

本机配置使用 `opencode://deepseek` 时，程序会在运行时读取 `~/.config/opencode/opencode.json` 中DeepSeek Provider的 `apiKey`，不会把密钥复制进项目或日志。其他机器应使用 `${DEEPSEEK_API_KEY}` 环境变量。

## 使用

初始化EPUB：

```powershell
.\.venv\Scripts\python.exe main.py init incandescence "D:\path\Incandescence.epub"
```

先试译一个块：

```powershell
.\.venv\Scripts\python.exe main.py translate incandescence --chapters v01_ch01 --max-chunks 1 --glossary-mode manual --quiet
```

继续翻译时直接重复命令；已经完成的块会自动跳过。去掉 `--max-chunks` 即处理所选章节的全部剩余块，去掉 `--chapters` 即处理全书。

全书完成后导出TXT和EPUB：

```powershell
.\.venv\Scripts\python.exe main.py export incandescence
```

默认会拦截不完整项目；只有显式添加 `--allow-incomplete` 才会生成试读版。

## parallel_v4 影子流程

第一版并行架构不会修改原有章节JSON、串行译文或串行导出。它把扫描证据、知识版本、并行译文和审计记录写入独立的 `artifacts/parallel_v4/book.db`。

```powershell
.\.venv\Scripts\python.exe main.py migrate-v4 incandescence
.\.venv\Scripts\python.exe main.py scan-v4 incandescence
.\.venv\Scripts\python.exe main.py reconcile-v4 incandescence
.\.venv\Scripts\python.exe main.py translate-v4 incandescence --decision-mode unattended
.\.venv\Scripts\python.exe main.py compare-v4 incandescence --max-blocks 10
.\.venv\Scripts\python.exe main.py validate-v4 incandescence
.\.venv\Scripts\python.exe main.py export-v4 incandescence
```

`--decision-mode interactive` 会在一个批次产生新的知识建议后暂停，并把建议写入人工队列；`unattended` 会继续处理全书。上下文超过硬预算时，两种模式都会把该块标记为 `incomplete_requires_human`，不会压缩规则或伪装完成。

```powershell
.\.venv\Scripts\python.exe main.py review-v4 incandescence
.\.venv\Scripts\python.exe main.py review-v4 incandescence --accept 12
.\.venv\Scripts\python.exe main.py review-v4 incandescence --reject 13
.\.venv\Scripts\python.exe main.py review-v4 incandescence --retry 14
```

人工接受的术语会锁定为书内规则；受影响译文先标记为 `needs_revalidate`，再次运行 `translate-v4` 后才会生成新版本。模型不能覆盖人工锁定项。

严格导出会拒绝未完成块和任何警告。人工确认警告可接受后，使用 `export-v4 --allow-warnings`。输出位于 `exports/parallel_v4/`，包含TXT、EPUB和质量报告。

### 第二版能力

第二版可以把逐段对应的旧DOCX译文作为只读基线。导入默认要求英文源文与DOCX的非空段落数完全一致；基线只用于人工对照，不会进入模型提示词：

```powershell
.\.venv\Scripts\python.exe main.py import-baseline-v4 new_sun_omnibus "D:\path\legacy_translation.docx" --name legacy_docx
.\.venv\Scripts\python.exe main.py compare-v4 new_sun_omnibus --baseline legacy_docx
```

高影响术语或翻译约束需要两个互相独立的核验调用都支持，才能自动标记为已验证：

```powershell
.\.venv\Scripts\python.exe main.py verify-v4 new_sun_omnibus
```

人工校验界面位于翻译数据库之后、最终导出之前，也可以在交互模式暂停后立即打开。服务只监听本机回环地址，写操作使用每次启动生成的随机令牌：

```powershell
.\.venv\Scripts\python.exe main.py serve-v4 new_sun_omnibus
```

确定性校验发现单块问题后，可以把问题交给局部修复器。修复成功会新增译文版本并保留旧版本；修复失败不会覆盖当前译文：

```powershell
.\.venv\Scripts\python.exe main.py validate-v4 new_sun_omnibus
.\.venv\Scripts\python.exe main.py repair-v4 new_sun_omnibus
.\.venv\Scripts\python.exe main.py repair-v4 new_sun_omnibus --block v01_ch01_000 --issue "修复漏译"
```

注释独立于正文，默认不导出。只有明确使用 `--include-annotations` 时，已批准注释才会进入TXT和EPUB：

```powershell
.\.venv\Scripts\python.exe main.py annotate-v4 new_sun_omnibus --add "此处重复了前文意象。" --block v01_ch01_000 --paragraph 0
.\.venv\Scripts\python.exe main.py export-v4 new_sun_omnibus --include-annotations
```

完整的第二版约束与实施范围见 `docs/PARALLEL_V4_V2_SPEC.md`。

## 项目数据

每本书位于 `projects/<book_id>/`：

- `source.txt`：从源文件抽取、清洗后的原文。
- `artifacts/chapters/*.json`：分块原文、初译、定稿、难点说明及每块记忆快照。
- `artifacts/long_term_memory.json`：当前全书摘要和最近两个块的衔接文本。
- `glossary/auto_generated.json`：模型提出的术语。
- `entities/`：实体档案及关系。

`manual` 模式下新术语标记为待审核，但会作为低权重一致性建议提供给后文；`auto` 模式则直接把新术语作为硬约束。

## 当前默认参数

- 分块上限：约1100个英文词量级。
- 物理重叠：0句；衔接由记忆上下文完成。
- 全书滚动摘要：最多1200个汉字。
- 最近上下文：2个块，每块最多600个原文字符和1000个译文字符。
- 第一层温度：0.1；第二层温度：0.2。
- 第一层输出上限：6144；第二层输出上限：37200，以容纳高强度思考和完整润色稿。
- 两层模型：`deepseek-v4-flash`，Thinking开启，`reasoning_effort=high`。

