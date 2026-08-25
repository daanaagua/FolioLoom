# FolioLoom 滚动调度器云端接续说明

## 接续目标

继续执行：

- `docs/superpowers/specs/2026-07-27-rolling-horizon-dp-scheduler-design.md`
- `docs/superpowers/plans/2026-07-27-rolling-horizon-dp-scheduler.md`

当前分支：`fix/german-100k-gate`

## 已完成

任务 1–4 已按 TDD 完成：

- `b05ca5f feat: define optimization policies`
- `4e402e1 feat: persist scheduler telemetry`
- `3212d43 feat: learn runtime costs online`
- `6338556 feat: classify translation risk locally`

计划根据现有代码接口补充了任务 5–8 的严格合同：

- `e332e99 docs: tighten scheduler implementation contracts`

本阶段最近验证：

- `npm test`：751 pass、0 fail、1 skip
- `npm run typecheck`：0 error
- `npm run desktop:test`：Node 106 pass、0 fail、1 skip；Renderer 66 pass
- `git diff --check`：pass

## 下一步

1. 对任务 1–4 做一次轻量综合检查点审查；只有带最小复现的
   Critical/Important 才阻塞。
2. 实现任务 5–8。任务 5–6 与任务 7–8 文件互不重叠，可以在确认基础合同后
   并行；各自必须先写失败测试。
3. 在一个自然检查点综合审查任务 5–8。
4. 由同一持续实现上下文顺序执行任务 9–11，因为它们共享
   `book-runner.ts`。
5. 完成任务 12–13、全量验证和仅操作数据库副本的真实性能复测。

## 关键工程约束

- 新规划模块必须保持纯数值决策；任务 9 前不得改变真实翻译执行路径。
- 不修改 `book.db` schema；runtime telemetry 使用独立数据库。
- 不降低完整性、术语、跨块、知识覆盖或修复校验。
- planner 不得改变 logical window 边界或 `CommitCoordinator` 的提交顺序。
- selected knowledge revision 不存在、不适用或超预算时必须确定性失败，不能
  静默省略。
- coverage 只能来自明确结构字段，不得从任意自然语言事实中用关键词猜测。
- token 包络是硬门；economy/balanced/speed 分别允许基线增加
  5%/10%/20%。
- benchmark 准备器只能操作数据库副本，并验证源数据库 SHA-256 不变。
- 不触碰仓库根目录可能存在的用户未跟踪 `package-lock.json`。

## 执行方式

使用轻量子代理流程：

- 只在确有并行收益或高风险隔离价值时分派；
- 每 3–5 个关联任务做一次综合审查；
- 不为每个任务重复派规格审查和质量审查；
- 完成前运行计划中列出的核心、桌面、类型检查、构建和真实副本验证。
