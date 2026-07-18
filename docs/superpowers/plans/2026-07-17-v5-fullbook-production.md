# V5 全书生产化接管实现计划

> **面向 AI 代理的工作者：** 使用 `executing-plans` 在当前专用 worktree 内连续实现；只有出现真实并行收益或高风险隔离需求才使用子代理。步骤使用复选框跟踪。

**目标：** 让 V5 以独立事务工作库完成全书窗口调度、持久记忆、断点续跑和 TXT/EPUB 导出，并用 `Little, Big` 做冷启动小规模验收。

**架构：** 把 Pilot 的单次流程抽成共享的书级上下文和窗级运行内核；全书 Runner 用确定性窗口计划和自适应波次调用该内核。V4 SQLite 继续只读，V5 状态写入独立 SQLite，Python 只承担既有导入和 EPUB 外围。

**技术栈：** Node.js 24、TypeScript、`node:sqlite`、Pi Agent Kernel、Python 3、pytest、标准库 EPUB writer。

---

### 任务 1：确定性窗口计划与书级预算统计

**文件：**
- 创建：`translator-v5/src/fullbook/window-planner.ts`
- 创建：`translator-v5/src/fullbook/types.ts`
- 测试：`translator-v5/test/window-planner.test.ts`

- [x] 先写测试：窗口不跨章节、受 token/block 上限约束、ID 对相同输入稳定，过大单块独立成窗。
- [x] 运行 `npm test -- --test-name-pattern="window plan"`，确认因模块不存在而失败。
- [x] 实现 `planBookWindows(blocks, options)` 和纯函数 `nextConcurrency(history, limits)`；默认热身 2、最大并发 2，风险结果降为 1。
- [x] 重跑定向测试与 `npm run typecheck`。
- [x] Commit：`feat: plan bounded full-book windows`。

### 任务 2：事务工作库与恢复

**文件：**
- 创建：`translator-v5/src/storage/book-store.ts`
- 测试：`translator-v5/test/book-store.test.ts`

- [x] 先写测试：初始化计划、原子提交译文/锚点/记忆/尾部、重开后跳过已完成块、`running` 恢复、source fingerprint 不匹配时拒绝。
- [x] 运行定向测试确认失败。
- [x] 建立版本化 `v5_book_schema=1`；实现 `initializePlan`、`claimWindow`、`commitWindow`、`failWindow`、初始化恢复、`statusSummary` 和只读导出查询。
- [x] 使用真实临时 SQLite 验证事务回滚，禁止用纯 mock 代替。
- [x] 重跑定向测试与类型检查。
- [x] Commit：`feat: persist resumable v5 book state`。

### 任务 3：共享上下文、窗级内核与持久记忆投影

**文件：**
- 创建：`translator-v5/src/fullbook/book-context.ts`
- 创建：`translator-v5/src/fullbook/memory-projection.ts`
- 修改：`translator-v5/src/agents/lexical-anchorer.ts`
- 修改：`translator-v5/src/pilot-runner.ts`
- 测试：`translator-v5/test/book-context.test.ts`
- 测试：`translator-v5/test/memory-projection.test.ts`

- [x] 先写测试：一本书只构建一次证据索引；未知形式只从当前窗触发但 concordance 可取全书；已存 contextual 决定不重复；未来 narrative 事实不可见；尾部最多 1,600 字符。
- [x] 运行定向测试确认失败。
- [x] 实现 `BookContext.open/close`，持有只读 adapter、全部 blocks、稳定术语和单一 EvidenceIndex。
- [x] 将词汇锚定移到窗级研究之前；加入全书 concordance 但不向翻译提示暴露非目标全文。
- [x] 把 Pilot 主体抽成 `runTranslationWindow`，允许注入额外术语、已有锚点、投影事实、style state 与 previous tail；`runPilot` 变成兼容包装器。
- [x] 重跑现有 Pilot 回归、定向测试和类型检查。
- [x] Commit：`refactor: share bounded v5 window kernel`。

### 任务 4：全书 Runner、重试与 CLI

**文件：**
- 创建：`translator-v5/src/fullbook/book-runner.ts`
- 修改：`translator-v5/src/cli.ts`
- 修改：`translator-v5/src/report.ts`
- 修改：`translator-v5/package.json`
- 测试：`translator-v5/test/book-runner.test.ts`
- 测试：`translator-v5/test/cli.test.ts`

- [x] 先写 faux 模型端到端测试：串行热身后并发 2、风险降速、每窗独立预算、无提交重试、失败窗不污染活动状态、重启不重复已完成窗、无人值守继续并汇总人工队列。
- [x] 运行定向测试确认失败。
- [x] 实现 `preflightBook`、`runBook`、波次提交和每窗最多两次尝试；事件和 metrics 不保存 key/reasoning。
- [x] 增加 `book preflight|run|status|export` 参数；保留现有 `preview` 兼容入口。
- [x] 生成整书 TXT、双语 TXT、audit 和 metrics；严格模式拒绝缺块。
- [x] 重跑全体 V5 测试与类型检查。
- [x] Commit：`feat: run resumable full-book translation`。

### 任务 5：复用 Python 外围导出 TXT/EPUB

**文件：**
- 创建：`src/core/v5_exporter.py`
- 修改：`main.py`
- 测试：`tests/test_v5_exporter.py`

- [x] 先写测试：从临时 V5 store 和项目章节构造有序译文章节；严格模式拒绝缺块/hash 不符；成功产出带 BOM 的 TXT 和有效 EPUB。
- [x] 运行 `python -m pytest tests/test_v5_exporter.py -q` 确认失败。
- [x] 实现 `V5BookExporter`，只读 V5 store，并复用 `BookExporter` 的 EPUB 生成代码。
- [x] 增加 `python main.py export-v5 BOOK_ID [--allow-incomplete] [--output-dir]`。
- [x] 重跑定向测试和 Python 正式回归。
- [x] Commit：`feat: export v5 translations to txt and epub`。

### 任务 6：Little, Big 冷启动验收

**运行产物（不提交）：**
- `projects/little_big/`
- `projects/little_big/exports/translator_v5/`
- `docs/superpowers/reports/2026-07-17-little-big-v5-cold-start.md`

- [x] 用 `main.py init little_big <source>` 与 `migrate-v4 little_big` 建立新项目；确认没有旧词表和旧译文。
- [x] 运行 `book preflight`，记录章节、blocks、windows、tokens、source fingerprint 和异常字符警告。
- [x] 用 Flash 跑三个窗口；在第二次实测中模拟停止并恢复，核对已完成窗口模型调用没有增加。
- [x] 运行严格校验；生成内部 TXT/EPUB 抽查版。
- [x] 报告速度、调用量、预算峰值、修复/人工队列、锚点和记忆样例，以及是否建议启动全书。
- [x] 运行 `git diff --check`、V5 全测、typecheck 和 Python 正式测试；再决定合并到 main。
