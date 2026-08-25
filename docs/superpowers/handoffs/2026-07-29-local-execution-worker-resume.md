# FolioLoom 本地接续：ExecutionWorker 抽取

## 新对话入口

工作目录：

```text
D:\llm\小说翻译
```

本地承接分支：

```text
fix/execution-worker-local-20260729
```

开始工作前完整阅读：

1. `STATE.md`
2. `docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`
3. `docs/superpowers/plans/2026-07-28-token-ledger-and-scheduler-control-plane.md`
4. 本文件

## 云端接回状态

- `fix/german-100k-gate` 已同步到 `d99db16`，本地、GitHub 和云端一致。
- 云端已验证提交均已推送到 `origin/fix/german-100k-gate`。
- 云端未完成的 ExecutionWorker 半成品单独备份为：
  - 分支：`origin/cloud/folioloom-execution-worker-wip-20260729`
  - WIP 提交：`576ce62`
- `codex-sg` 的 `folioloom-dp` tmux 会话已经停止，避免继续写入。

本文件提交后，本地会以 `git cherry-pick --no-commit 576ce62` 恢复半成品，
因此新对话看到的工作树应包含：

- 修改：`folioloom/src/fullbook/book-runner.ts`
- 新建：`folioloom/src/fullbook/execution-worker.ts`
- 新建：`docs/ARCHITECTURE.md`
- 用户原有未跟踪文件：仓库根目录 `package-lock.json`（不得触碰或提交）

## 已完成且通过验证

### 原滚动调度计划

原计划任务 5–13 已完成并推送。验证记录：

- `docs/superpowers/reports/2026-07-27-rolling-horizon-scheduler-validation.md`
- `docs/superpowers/reports/2026-07-27-kafka-german-100k-live-validation.md`

### Token ledger 与控制面

已完成：

- durable `TokenLedger`
- `book.db` ledger 事件与 scheduler projection
- resume、主译、revalidation、protocol/context recovery、anchor 的包络接入
- `AdmissionController`
- `CongestionSensor`
- `TelemetrySink`
- active 模式由 ledger 单独执行 token 硬门

德语前 10 万字符真实验证：

- 项目：`projects/kafka_verwandlung_100k_gate2/`
- run：`836e57f2-db0b-487c-ab09-b6b443e0bfb3`
- 模型：`deepseek-v4-flash`
- 模式：`active/balanced`
- 19/19 窗口完成，严格导出通过
- baseline：575,480
- allowed：633,028
- actual：422,510

报告：

`docs/superpowers/reports/2026-07-28-kafka-german-100k-token-ledger-live-validation.md`

`d99db16` 在干净状态下重新验证：

- admission/congestion/telemetry/adaptive/book-runner：75 pass、0 fail
- 核心 TypeScript：0 error

此前云端全量记录：

- Node：830 pass、0 fail、1 skip
- Renderer：66 pass
- Desktop production build：通过

## 当前半成品的明确失败状态

`576ce62` 只是安全备份，不能直接合并。应用后执行：

```powershell
cd D:\llm\小说翻译\folioloom
npm run typecheck
```

当前预计产生 41 个 TypeScript 错误，主要为：

1. `book-runner.ts` 已导入 `execution-worker.ts`，但旧的同名函数和接口尚未
   完整删除，形成重复声明。
2. 若干常量、类型和预算辅助函数已从 runner 删除，但调用点尚未全部迁入
   worker。
3. `PlannedTranslationExecution.admitted` 暂缺顶层 `assessment`。
4. 执行循环、protocol fallback、context split、usage 归集仍有一部分留在
   runner，抽取边界尚未闭合。
5. `docs/ARCHITECTURE.md` 已起草，但尚未经过验证和提交。

不要用恢复旧文件的方式消除错误；目标是完成抽取，同时保持外部行为不变。

## 推荐续做顺序

### 1. 固定行为测试

先复用或补充 characterization tests，覆盖：

- context overflow 无损分块
- protocol → framed fallback
- recovery usage 归集
- active token reserve/settle
- cancellation
- 乱序完成、按 ordinal 提交

每次迁移一个函数族后运行对应测试。

### 2. 完成 ExecutionWorker

逐组迁移，不做一次性大删改：

1. 请求预算与 fragment admission
2. 单 fragment 模型调用
3. protocol/context recovery
4. usage、状态和 recovery telemetry
5. 完整 physical request 合并

`ExecutionWorker` 只负责模型调用和恢复边；不得：

- 绕过 `AdmissionController`
- 写数据库
- 改逻辑窗口
- 改 `CommitCoordinator` 顺序
- 改知识结论或质量门

### 3. 清理 runner

runner 保留：

- wave/task/variant 构造
- planner 与并发编排
- ledger/admission 生命周期
- CommitCoordinator 与持久化

删除已经由 worker 权威实现的重复声明和死代码。

### 4. 完成 P3 与剩余项

- 审核并提交 `docs/ARCHITECTURE.md`
- Python 仅保留导入适配与旧版兼容，不新增生产调度逻辑
- 检查 anchor 路径真实供应商 usage；若仍缺失，修复
  `tokenUsageComplete`，但不得伪造 usage

### 5. 完成验证

```powershell
cd D:\llm\小说翻译\folioloom
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
git diff --check
```

必要时复跑德语 10 万字符，但必须使用新项目或数据库副本，不得覆盖唯一真跑
数据库。完成后把干净实现提交到本地承接分支，再合并回
`fix/german-100k-gate`。

## 不变量

- `book.db` 不新增关系 schema。
- logical window 和源文边界不可变。
- `CommitCoordinator` 继续按 ordinal 提交。
- token 包络、质量校验和知识收敛门不得降低。
- API Key、书稿、译文、运行数据库和模型 prompt 不得提交。
