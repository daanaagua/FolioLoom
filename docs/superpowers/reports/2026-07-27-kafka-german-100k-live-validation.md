# 《变形记》德语前 10 万字符真实翻译验证报告

- 日期：2026-07-27
- 分支：`fix/german-100k-gate`
- 模型：`deepseek-v4-flash`
- 调度模式：`active`
- 优化档位：`balanced`
- 运行 ID：`2227b003-b87a-4797-98be-f2da0e2fba93`
- 结论：无损覆盖、知识收敛和严格导出通过；token 硬包络失败，不能判定动态调度器整体验收通过

## 1. 样本与隔离范围

原文取自 Project Gutenberg 的德语版卡夫卡《变形记》：

```text
https://www.gutenberg.org/ebooks/22367
```

仅提取小说正文，不包含 Gutenberg 页眉、页脚和许可文本。样本在最后一个完整
句子边界截断，项目清单记录 99,953 个 Unicode scalar（正文截取过程得到
99,952 个非尾随换行 scalar，清单另计结尾换行）。原文 SHA-256 为：

```text
b3a7febe6ac0a3c99b557e437ccdc9e1025effdcdf0cf18789f6daae87e41199
```

验证使用独立项目和独立数据库：

```text
projects/kafka_verwandlung_100k_live/
```

没有修改其他项目的 `book.db`。运行前后 `source.txt` 与
`source/original.txt` 的 SHA-256 均与清单一致。

## 2. 凭据与运行环境

- 从本机 OpenCode 的 DeepSeek 配置读取已有凭据；
- 只生成了一个权限为 `0600` 的临时运行时认证文件；
- 验证结束后已删除该临时认证文件及其空目录；
- 报告、命令输出、数据库和 Git 变更均不包含 API Key；
- `/v1/models` 探测返回 HTTP 200，并确认
  `deepseek-v4-flash`、`deepseek-v4-pro` 可用；
- 所有 FolioLoom 命令使用 Node.js 24.18.0；
- 运行时成本统计写入独立的
  `projects/kafka_verwandlung_100k_live/artifacts/folioloom/runtime-profiles.db`。

## 3. 预检结果

初始化后得到：

- 17 个物理章节；
- 20 个逻辑块；
- 19 个翻译窗口；
- 原文覆盖 99,953/99,953；
- 0 个完整性 incident。

`book doctor` 另报告 11 个超长行和 4 个空格分隔连字符。超长行主要来自本次
纯文本段落重排；这些项目没有形成无损覆盖 incident，也没有在运行中改写原文。

## 4. 真实运行过程

### 4.1 单窗口探针

先用并发 1 运行一个窗口，确认真实模型、协议、usage 和数据库提交路径：

| 指标 | 数值 |
| --- | ---: |
| 命令墙钟 | 98,662.63 ms |
| 模型实际墙钟 | 80,006.81 ms |
| 完成窗口 | 1/19 |
| 静态基线 token | 15,877 |
| 允许 token | 17,464 |
| 实际 token | 16,506 |
| 规划状态 | `optimal` |
| fallback | 0 |

探针处于包络内。

### 4.2 并发续跑与恢复

第一次并发 4 续跑约 5 分钟后，供应商流以 `terminated` 结束。原实现把这一
消息归类为不可重试的 `unknown`，导致整次命令终止。修复后，同一窗口的第二次
尝试成功，证明该故障可以按瞬态网络/上游繁忙错误恢复。

另一个窗口连续两次缺少合法 framed submission，按既有质量门进入
`human_required`，没有被错误接受。随后只使用已注册的确定性恢复命令：

1. `RUNNING_AFTER_CRASH`：把 2 个中断的 staged/running 窗口恢复到可重跑状态；
2. `EXPORT_INCOMPLETE`：把 9 个缺失或需人工处理的窗口恢复为 pending；
3. 使用同一运行 ID、并发 4、最大尝试次数 4 继续执行。

最终 19/19 个窗口完成，20/20 个逻辑块均有活动译文。

## 5. 最终质量与导出审计

严格审计结果：

| 指标 | 结果 |
| --- | ---: |
| `complete` | `true` |
| `structurallyComplete` | `true` |
| `knowledgeConverged` | `true` |
| `strictExportable` | `true` |
| `coverageMissing` | 0 |
| 待处理/处理中/陈旧回溯 | 0/0/0 |
| 精确重译回溯 | 3 |
| incident | 0 |
| 完成窗口 | 19/19 |
| warning 窗口 | 5 |
| `human_required` | 0 |
| failed | 0 |
| 模型调用 | 43 |

5 个 warning 窗口主要保存模型给出的翻译说明，例如保持卡夫卡式叙述距离、
长句节奏和人物称谓一致性；它们不是缺块、原文改写或校验绕过。人工抽查开篇
显示译文整体连贯、信息完整，但仍存在偏直译或不够自然的表达，例如个别职务和
机构称谓。当前审计证明结构、来源、术语绑定和知识收敛，不等同于出版级文学
润色结论。

严格导出文件：

```text
projects/kafka_verwandlung_100k_live/artifacts/exports/folioloom_book_translation.txt
projects/kafka_verwandlung_100k_live/artifacts/exports/folioloom_book_bilingual.txt
projects/kafka_verwandlung_100k_live/artifacts/exports/folioloom_book_audit.json
projects/kafka_verwandlung_100k_live/artifacts/exports/folioloom_book_metrics.json
```

其中纯译文为 80,657 bytes，双语文件为 183,999 bytes。

## 6. Token 包络失败

最后一次续跑返回的调度指标为：

| 指标 | 数值 |
| --- | ---: |
| 静态基线 token | 237,599 |
| balanced 允许 token | 261,358 |
| 预测 token | 166,477 |
| 实际 token | 359,975 |
| 超出允许值 | 98,617 |
| 相对允许值超出比例 | 37.7% |
| planning status | `fallback` |
| decision / fallback / recovery | 4 / 2 / 3 |

因此，最后一次续跑的实际 token 是静态基线的约 151.5%，明显超过 balanced
档位规定的 110% 硬上限。不能用供应商波动、重试或完成质量来豁免该失败。

运行时统计库共记录 27 个真实请求观察：

| 状态 | 数量 | 累计模型时间 | 累计 token |
| --- | ---: | ---: | ---: |
| success | 20 | 1,261,230.219 ms | 425,486 |
| protocol | 3 | 186,059.295 ms | 109,045 |
| failed | 4 | 154,022.600 ms | 48,147 |
| 合计 | 27 | 1,601,312.114 ms | 582,678 |

582,678 包含多次命令、失败请求和恢复请求，不能与最后一次命令的 237,599
基线直接相除。它揭示了另一个问题：当前调度累计值只存在于单次
`runBook()` 调用中，续跑时会重新从 0 计算，无法给出跨命令的统一硬包络。

## 7. 根因与本次修复

### 7.1 `terminated` 被错误判为不可重试

根因：`classifyProviderErrorMessage()` 没有识别 Node/Undici 流终止消息
`terminated`。

修复：

- 将 `terminated` 归类为可重试的 `busy`；
- 新增精确回归测试；
- 真实续跑中原失败窗口在第二次尝试成功。

### 7.2 `fallback` 绕过 token 硬门

根因：滚动规划器在没有合法方案时正确返回空的
`firstDispatch` 和 `planningStatus="fallback"`，但
`DynamicScheduler` 随后仍把全部 legacy task 交给旧调度路径，绕过了规划器
已经执行的 token 硬门。

修复：

- active 模式遇到 `NO_LEGAL_PLAN` 时不再派发 legacy task；
- planner 本身异常时，active legacy fallback 也必须受剩余 token 包络约束；
- token 受限 fallback 只允许保留 legacy 前缀，不得跳过较早任务后派发较晚任务；
- shadow 模式仍保持原 legacy 派发行为，不改变影子一致性；
- 新增无合法方案、planner 异常、legacy 顺序和 shadow 隔离回归测试。

这项修复阻止后续任务继续主动突破包络，但不能把本次已经发生的 359,975
实际 token 改写为通过。

## 8. 尚未解决的验收阻塞

以下问题必须解决并重新进行真实运行，才能声称 active 模式满足 token 硬包络：

1. 将累计 baseline、allowed、actual、usage 完整性和调度计数持久化到运行，
   续跑必须从持久值恢复；
2. 独立执行 `book export` 时必须读取持久化调度指标；本次严格导出的 metrics
   中 `scheduler` 仍为 `null`；
3. 将协议降级、repair、上下文拆分和并发在途请求的保守 token 预留纳入同一
   硬门，避免单个已发请求或同批并发请求在完成后造成不可阻止的超限；
4. 使用全新隔离数据库重新运行真实样本，不复用本次已经超限的累计结果。

## 9. 修复后的回归验证

所有命令均使用 Node.js 24.18.0：

| 验证项 | 结果 |
| --- | --- |
| 相关调度、runner、provider 与桌面 E2E 测试 | 94 通过，0 失败 |
| 全量 Node 测试 | 830 通过，0 失败，1 跳过 |
| renderer 测试 | 66 通过，0 失败 |
| 核心 TypeScript | 0 error |
| desktop TypeScript | 0 error |
| Electron production build | main、preload、renderer 和产物校验通过 |
| `git diff --check` | 通过 |

桌面全流程测试原先使用 `speed` 档，并隐式依赖无合法方案时的 legacy
绕过。修复硬门后，该测试改用本来就符合其“导入、暂停、恢复、严格导出”
目的的 `balanced` 档；speed 的包络、规划和运行行为继续由专门的调度及
runner 测试覆盖。

## 10. 最终判定

- 原文隔离与哈希不变：通过；
- 99,953/99,953 无损覆盖：通过；
- 19/19 窗口与 20/20 逻辑块完成：通过；
- 知识收敛、严格导出和 0 incident：通过；
- 瞬态 `terminated` 恢复：修复后通过；
- active/balanced token 硬包络：失败；
- 跨续跑调度 metrics 持久化：失败；
- 本次 10 万字符真实验证整体验收：不通过。
