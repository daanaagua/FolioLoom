# FolioLoom 本地目录规范化执行计划

## 目标

- 将当前产品目录统一为 `D:\llm\小说翻译\folioloom`。
- 当前产品、命令帮助和活动代码不再以 `V5` / `translator-v5` 命名。
- 保留内部数据协议的兼容标识，并为旧命令与旧产物路径提供只读兼容。
- 封装包仅保留在 `folioloom\release`。
- 保存尚未合并的唯一改动后，清除旧工作树、旧克隆和散落的旧视频资产。
- 最终确保主工作树可构建、测试通过、分支与工作树状态可追溯。

## Task 1：规范化产品目录与活动命名

- `git mv translator-v5 folioloom`。
- 更新 CI、README、脚本、测试与文档中的活动路径。
- 将 `v5_exporter.py` / `V5BookExporter` 改为 FolioLoom 主命名，保留兼容别名。
- 默认产物路径改为 `artifacts/folioloom` 与 `exports/folioloom`，兼容读取旧路径。
- 删除不再使用的调试脚本。

## Task 2：验证与封装

- 运行 Node 全量测试、桌面测试、类型检查与构建。
- 运行相关 Python 测试。
- 生成 Windows portable 目录与 ZIP，确认版本、文件结构和可执行文件。

## Task 3：集成并清理

- 提交规范化分支并合并到 `main`。
- 将脏视频工作树保存到 Git stash；保留未合并分支。
- 移除所有旧工作树，删除已合并的旧分支和可由远端恢复的旧克隆。
- 将散落视频资产压缩归档到 `D:\llm\小说翻译\local-archive` 后删除原副本。
- 保留 `D:\Documents\FolioLoom` 与 AppData 中的用户项目、偏好和加密凭据。

## Task 4：最终核验

- 扫描本机相关目录，确认源码和封装包没有散落副本。
- 检查 `git status`、`git worktree list`、分支可达性与 release 文件。
- 输出最终规范路径、保留的兼容内容和清理结果。
