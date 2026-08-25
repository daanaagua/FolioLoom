# Concept Coverage Revalidation and Overhead Telemetry Plan

> 补充《2026-07-26 sparse snapshot revalidation》Task 11。目标是修复“概念在译文生成后才被发现时，旧译文没有 binding，因此不会进入稀疏重验”的覆盖漏洞，并量化修复相对旧流程增加的时间、调用和 token。

## Task 11A：先锁定缺失 binding 的失败行为

**文件**

- 修改：`folioloom/test/sparse-revalidation.test.ts`
- 修改：`folioloom/test/lossless-book-store.test.ts`
- 修改：`folioloom/test/lossless-audit.test.ts`

1. 增加纯规划器测试：文本块命中当前概念 occurrence、但 bindings 为空时，必须产生候选；无 occurrence 的块不得受影响。
2. 增加存储集成测试：旧译文先完成、新概念后出现时，只为命中的 active translation 创建重验任务；重复执行保持幂等。
3. 增加审计测试：存在概念 occurrence、active translation 却没有 binding 时，`knowledgeConverged=false`。
4. 运行定向测试，确认实现前按预期失败。

## Task 11B：实现可恢复的概念覆盖回填

**文件**

- 修改：`folioloom/src/knowledge/sparse-revalidation.ts`
- 修改：`folioloom/src/storage/lossless-book-store.ts`
- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/src/report.ts`

1. 规划器把“命中 occurrence 但没有 binding”视为待验证依赖。
2. 存储层只查询 occurrence 命中的 active translation；为缺失依赖建立可审计的 pending 占位 binding，并创建幂等任务。
3. 增加启动/波次边界回填入口，使升级前已有数据库也能自愈。
4. 审计报告统计缺失覆盖；存在缺口时阻止严格导出。
5. 运行定向测试和 TypeScript 检查。

## Task 11C：增加增量成本监测

**文件**

- 修改：`folioloom/src/fullbook/book-runner.ts`
- 修改：`folioloom/test/book-runner.test.ts`
- 视需要修改：`folioloom/src/cli.ts`

1. 将本地覆盖扫描时间与重验模型时间分开记录。
2. 聚合重验调用的 input/output/cache/reasoning/total token、模型调用数和模型耗时。
3. 在运行结果或持久化报告中输出 `revalidationOverhead`，其数值即相对旧流程新增的直接成本。
4. 用测试锁定零重验与发生重验两条路径，禁止把主翻译调用误计入增量成本。

## Task 11D：重跑《变形记》并给出实测差值

1. 对已有 Kafka 项目执行覆盖回填与重验，不重扫无关文本。
2. 核查开头三处 `Prokurist` 是否收敛到当前策略。
3. 记录新增块数、模型调用数、token 和墙钟时间。
4. 与原始 931,311 ms、59 次模型调用的基线比较；token 基线若旧运行未持久化，只报告新增 token 绝对值，不伪造百分比。
5. 重新审计并抽检译文。

## Task 12：完整验证

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
git diff --check
```

保留根目录既有未跟踪 `package-lock.json`，不提交 API Key、原文、数据库或译文产物。
