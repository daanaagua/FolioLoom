# 《变形记》概念覆盖回溯验证报告

日期：2026-07-27  
分支：`fix/german-100k-gate`  
模型：`deepseek-v4-flash`，`quality/high`  
样本：既有《变形记》德文运行数据库

## 修复目标

旧实现只会重验已经存在 `translation_concept_binding` 的译文。如果模型在
翻译早期文本时尚未建立某个概念，后文才确认该概念，那么早期译文没有
binding，也就不会进入稀疏重验。`Prokurist` 的前三次错误译法正是由此
漏过。

本轮改为同时检查：

- 活动概念的准确原文 occurrence；
- occurrence 命中的活动译文；
- 该译文是否存在相应 binding；
- binding 的修订与渲染指纹是否仍然有效。

缺失 binding 会建立一个持久的 stale 占位回执和一项稀疏重验任务。审计
新增 `coverageMissing`；只要仍有 occurrence 命中但缺少 binding，
`knowledgeConverged` 就不能为真。

## 增量监测

`book run` 的结果新增 `revalidationOverhead`：

- `coverageScan`：检查的 occurrence 依赖数、候选译文数、新任务数、
  新 binding 数和本地扫描时间；
- `drain`：领取、noop、修复、重译、警告任务数，以及增量模型调用、
  模型耗时、输入/输出/cache/reasoning/总 token、总墙钟时间；
- `tokenUsageComplete`：供应商用量是否完整可得。失败或被中断的请求
  无法可靠取得 token 时会明确置为 `false`。

这些数字只统计概念回溯层，不与普通翻译窗口混在一起。

## 真实影响范围

数据库中共有 198 条当前 occurrence 依赖。新规则发现：

| 指标 | 数值 |
|---|---:|
| 缺失的“文本块—概念”依赖 | 7 |
| 实际受影响活动译文 | 5 |
| 当时已有活动译文 | 27 |
| 重译比例 | 18.5% |
| 创建的稀疏任务 | 5 |
| 全书无关文本块重译 | 0 |

五块分别位于早期文本。一个文本块可同时承载多个缺失概念，因此 7 条依赖
只生成 5 次块级重译。

幂等复扫 198 条依赖耗时 1.4 ms，新增任务和 binding 均为 0。首次扫描
确实创建了 5 项任务，但其进程日志后来被恢复运行覆盖，因此不把首次扫描
的亚毫秒/毫秒级数值伪装成精确测量。

## 时间与 token 开销

原始翻译运行：

| 指标 | 原始翻译 |
|---|---:|
| 墙钟时间 | 931,311 ms（15 分 31 秒） |
| 模型调用 | 58 |

干净回溯开销由两段组成：

- 第一块：事件时间戳显示约 27 秒，1 次模型调用；
- 其余四块：精确监测为 465,376 ms，10 次调用，207,355 total tokens。

合计估算：

| 指标 | 概念回溯 | 相对原始翻译 |
|---|---:|---:|
| 墙钟时间 | 约 492 秒（8 分 12 秒） | +52.9% |
| 模型调用 | 11 | +19.0% |
| total tokens | 实测下限 207,355；估算约 228,000 | 原始运行未持久化 token，不能给出可信百分比 |

约 228,000 token 是按已测四块的单调用均值补估未记录的一次调用，适合作为
量级判断，不是账单精确值。

测试期间曾错误地中断并重启一个已领取任务，额外浪费约 57 秒；该操作事故
未计入上表的干净架构开销。

这组数据表明：定位足够稀疏，但当前 revalidation drain 仍为串行，
`quality/high` 下墙钟开销明显高于任务占比。后续性能优化应优先考虑受控
并行和按风险选择推理强度，而不是扩大扫描或减少校验。

## 结果核验

重译后审计结果：

| 指标 | 结果 |
|---|---:|
| `coverageMissing` | 0 |
| pending / validating / stale | 0 / 0 / 0 |
| `knowledgeConverged` | `true` |
| 重译任务 | 5 |
| 审计 incident | 0 |
| 活动译文 | 27 |

项目仍有 4 个未译块，均位于此前未完成的 Project Gutenberg 尾部许可区，
所以全书状态仍是 partial；这与概念回溯无关。

导出的当前译文中，旧的“秘书主任”和“代理人”均为 0 次，
“全权代表”为 19 次。更新后的 partial TXT 位于：

`projects/kafka_verwandlung_100k_sparse/artifacts/exports/folioloom_book_translation.partial.txt`

真实运行还暴露出一个状态谱系问题：重译块产生 warning 时，新译文状态会
与原窗口状态不一致，导致审计误判活动译文无效。现在替换事务会把 warning
状态提升到整个窗口及其全部活动译文，保持窗口—译文状态一致；对应回归
测试已经加入。

## 自动验证

- 核心测试：718 项，717 pass、0 fail、1 skip；
- desktop Node 测试：107 项，106 pass、0 fail、1 skip；
- renderer 测试：66/66 pass；
- 核心与桌面 TypeScript 检查通过；
- desktop production build 及 preload 产物验证通过；
- 真实数据库审计：0 incident，知识收敛；
- 更新后的 partial artifacts 已重新导出。
