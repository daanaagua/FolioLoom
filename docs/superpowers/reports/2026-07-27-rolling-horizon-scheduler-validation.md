# 滚动窗口动态调度器验证报告

- 日期：2026-07-27
- 分支：`fix/german-100k-gate`
- 验证范围：任务 1–13 的确定性实现、离线回放、影子一致性、数据库副本准备器、CLI、桌面端、生产构建，以及后续 DeepSeek 德语前 10 万字符真实运行
- 结论：确定性实现与离线质量门通过；后续真实运行的无损审计通过，但 active/balanced token 硬包络失败，因此整体验收不通过

## 验证环境

- 操作系统：Ubuntu Linux，内核 `6.8.0-101-generic`，x86_64，KVM
- CPU：2 个在线 vCPU，AMD EPYC 9754
- 内存：7.4 GiB，交换空间 1.9 GiB
- Node.js：24.18.0
- npm：10.9.7
- SQLite：3.53.1
- 初始离线阶段：未连接模型；离线回放使用固定遥测，短样本使用本地确定性 faux provider
- 后续真实阶段：使用本机 OpenCode 已有 DeepSeek 凭据连接 `deepseek-v4-flash`；凭据未写入报告、数据库或 Git

## Kafka 五任务离线回放

固定回放只包含任务时长、token、风险和资源标识，不包含原文、译文或提示词。`speed` 档位的结果如下：

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 静态串行基线 | 492,000 ms | — |
| 动态计划墙钟 | 213,000 ms | ≤ 246,000 ms |
| 相对基线降幅 | 56.7% | ≥ 50% |
| 已计划任务 | 5 | 5 |
| 资源冲突 | 0 | 0 |
| 静态 baseline token | 227,700 | — |
| 动态计划 token | 227,700 | ≤ 273,240 |
| speed token 比例 | 1.00× | ≤ 1.20× |
| 单次规划墙钟 | 12.823 ms | < 50 ms |
| 规划状态 | `optimal` | 非 `fallback` |

回放测试同时检查每个并发 action 的写资源不相交，并确认五项任务各出现一次。

## 英语、德语、韩语和日语影子一致性

测试使用仓库已有的短小合成语言样本，不下载或保存小说文本。每种语言分别在独立临时数据库中执行 `off` 和 `shadow`：

- 模型可见提示词以 SHA-256 比较，四种语言均逐请求一致；
- 请求覆盖的 window 和 block ID 完全一致；
- 活动译文只比较私有摘要，逐块一致；
- window 状态、警告、错误和整本结果一致；
- 实际 context profile、baseline token 和实际 token 一致；
- `shadow` 只增加规划状态、预测与 decision 数值，不改变派发或提交；
- 四种语言均为 0 fallback、0 incident，测试结束后删除临时数据库。

token 预测误差按 `|预测 token - 实际 token|` 计算并验证为有限非负值。由于 faux provider 不是供应商计费实现，该误差只用于验证 off/shadow 的统计路径，不作为真实模型精度结论。

## 最终调度 metrics

`v5-book-scheduler-metrics-1` 输出包含：

- profile、mode 和 planner status；
- legacy、planned 和 actual 墙钟；
- baseline、allowed、predicted 和 actual token，以及包络是否超限；
- context profile、effort 和协议计数；
- planner deadline、fallback、限流和恢复计数；
- token usage 完整性。

导出只保留固定枚举和聚合数值。测试确认未知 effort 会合并为 `unknown`，不会输出原文、译文、提示词、API Key、模型原始响应或任意 prose-shaped 字段。

## 数据库副本准备器

`scripts/prepare-revalidation-benchmark.ts` 的测试覆盖以下行为：

1. 拒绝相同输入输出路径；
2. 拒绝覆盖已有输出；
3. 使用 `copyFileSync` 创建新数据库；
4. 在副本事务中选择五项已完成精确重译及其当前活动 replacement；
5. 为活动 translation 创建五项新的 pending benchmark task；
6. 只在副本中清空对应 binding usage 并标记为 `stale`；
7. 数量不足时回滚并删除副本；
8. 源数据库准备前后 SHA-256 一致；
9. 检测到源数据库字节变化时以 `BENCHMARK_SOURCE_MUTATED` 失败并删除副本。

临时 SQLite 测试为 4 通过、0 失败。源库保持 0 项 pending，副本恰有 5 项引用活动 translation 的 pending task。没有修改 `book.db` schema。

## 自动质量门

从 `folioloom/` 使用 Node.js 24 执行：

```text
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
git diff --check
```

结果：

- 核心 Node：825 通过、0 失败、1 跳过；
- 核心 TypeScript：0 error；
- desktop Node：109 通过、0 失败；
- renderer：66 通过、0 失败；
- desktop TypeScript：0 error；
- Electron production build：main、preload、renderer 和构建产物校验通过；
- `git diff --check`：通过。

第一次全量运行暴露两项测试环境问题：一个旧测试在 Linux 上使用 Windows 绝对路径样本，另一个构建产物测试在执行 production build 前找不到 preload。前者改为宿主平台绝对临时路径且保留原安全断言；后者由规定的 `desktop:build` 生成产物。随后全量运行通过，未降低任何阈值。

## 后续真实验证

随后从本机 OpenCode 配置读取已有 DeepSeek 凭据，创建独立的德语《变形记》
前 99,953 字符项目，使用 `deepseek-v4-flash`、`active/balanced` 完成真实
翻译。最终达到 19/19 窗口、20/20 逻辑块、`coverageMissing=0`、
`knowledgeConverged=true`、`strictExportable=true` 和 0 incident。

但最后一次续跑的调度指标为实际 359,975 token、允许 261,358 token，超出
98,617（37.7%）。此外，独立严格导出的 metrics 中 `scheduler` 为 `null`，
说明跨命令调度指标尚未持久化。因此，原报告中的“缺少外部验证”限制已经解除，
但真实验证转而确认了一项 active token 硬门实现失败。

完整过程、原文哈希、恢复记录、审计、输出路径、根因和未解决阻塞见：

`docs/superpowers/reports/2026-07-27-kafka-german-100k-live-validation.md`
