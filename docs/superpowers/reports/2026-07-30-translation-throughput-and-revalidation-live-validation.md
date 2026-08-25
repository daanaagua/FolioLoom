# 2026-07-30 翻译吞吐与知识重验证优化验收

## 结论

本轮优化通过自动化门禁及全新英文、德文 100K 真实运行验收。两次有效性能样本均满足：

- 19/19 windows 完成；
- 0 human-required、0 failed、0 missing block；
- usage complete；
- actual tokens 未超过 allowed tokens；
- knowledge converged；
- coverageMissing=0、pending=0、stale=0；
- strict exportable；
- 独立 `book audit` 复算无 incident。

因此 `2026-07-30-translation-throughput-and-revalidation-optimization.md` 中 P1–P4 可以判定实施成功。

## 实施内容

### P1：知识晋升防抖与最终水位重验证

- 低证据的大写普通词只保留为 soft preference，不再直接成为会触发全书重验证的 lexical concept。
- 主翻译过程中不再按 wave 排空模型重验证；所有窗口提交后，在最终知识水位统一 drain。
- 暂停或 provider failure 不提前 drain；恢复后继续累计。
- 最终 drain 使用 active lexical concept 校验旧任务，避免把仍有效但未出现在最新增量 revision payload 中的概念误判为失效。

### P2：最小 fragment contract

- 多段 fragment wire 只保留有序段落文本及 exact term-usage receipts。
- fragment schema 移除 notes、memoryCandidates 和 styleObservation。
- 单段 leaf 继续只返回 `{text}`。
- whole-window 协议继续保留完整元数据能力。

### P3：自适应连续分组

- paragraph policy 升级为 `paragraph-fragment-policy-v2`。
- 默认硬上限由 6/480 调整为 10/720，冷启动目标为 8 paragraphs / 640 source tokens。
- 使用确定性动态规划寻找最少调用、尾组更平衡的 exact partition。
- 23 个短段落由 `[6,6,6,5]` 改为 `[8,8,7]`。
- protected source range、段落身份、顺序和 exact cover 约束保持不变。

### P4：局部递归二分

- 结构失败不再直接把整个 group 展开成所有 scalar leaves。
- 按源文本权重寻找平衡切点，只递归执行失败节点；已经成功的 sibling 不重做。
- 完整合法二分树在发车前计入 anti-loop 与 token baseline 上界。
- provider timeout/connection failure 仍形成安全 run boundary，不触发内容二分。

## 自动化门禁

| 门禁 | 结果 |
|---|---:|
| Core Node | 931 passed，1 Windows symlink skipped，0 failed |
| Desktop Node | 109 passed，1 Windows symlink skipped，0 failed |
| Desktop Renderer | 66 passed，0 failed |
| Core TypeScript | passed |
| Desktop TypeScript | passed |
| Electron production build + preload verification | passed |
| `git diff --check` | passed |

关键专项回归还覆盖：

- soft lexical preference 不触发 concept/revalidation；
- wave 内先继续普通翻译，最终 barrier 才 drain；
- fragment wire 不再暴露 discovery metadata；
- `[8,8,7]` 自适应 exact cover；
- 失败子树递归二分且成功 sibling 只执行一次；
- 递归恢复树预算完整覆盖；
- 长段落 revalidation 复用相同恢复拓扑。

## 真实 100K 结果

有效样本均使用：

- `deepseek-v4-flash`
- `active/balanced`
- `max-concurrency=3`
- 全新项目与全新 SQLite 数据库

| 指标 | 英文旧基线 tx32 | 英文新样本 tx35 | 变化 | 德文旧基线 tx34 | 德文新样本 tx37 | 变化 |
|---|---:|---:|---:|---:|---:|---:|
| 总墙钟 | 48:56 | 18:56 | -61.3% | 14:45 | 10:55 | -26.0% |
| 主路径模型调用 | 166 | 122 | -26.5% | 31 | 28 | -9.7% |
| 重验证模型调用 | 28 | 0 | -100% | 10 | 8 | -20.0% |
| 总模型调用 | 194 | 122 | -37.1% | 41 | 36 | -12.2% |
| actual tokens | 2,761,484 | 1,018,172 | -63.1% | 510,147 | 410,836 | -19.5% |
| warning windows | 17 | 0 | -17 | 2 | 1 | -1 |
| strict exportable | yes | yes | 无回退 | yes | yes | 无回退 |

英文新样本：

- 项目：`projects/children_of_time_book1_100k_optimized_tx35_20260730`
- run：`f654304a-b118-4749-8096-a2a0e5683ad1`
- 22/22 blocks，453/453 manual paragraphs；
- revalidation drain：0 calls；
- 输出无 replacement character、协议 marker 或段落缺失。

德文新样本：

- 项目：`projects/kafka_verwandlung_100k_optimized_retry_tx37_20260730`
- run：`ae256bae-abac-4883-bd60-43420657b8d7`
- 20/20 blocks，90/90 manual paragraphs；
- final drain：4 retranslated tasks / 8 calls；
- 唯一 warning 为“三个源段落对应三个目标段落”的信息性说明，未触发 incident。

英文 recoveries 从 8 增至 12，但总调用、token、墙钟和 warning 均显著下降，且没有 strict-export 或质量门槛回退。它反映更大的冷启动 group 在少数节点进入局部二分，局部恢复收益仍显著为正。

## 故障样本

`projects/kafka_verwandlung_100k_optimized_tx36_20260730` 不计入性能验收：

1. 首进程收到 provider `Request timed out`，以 retryable run boundary 安全退出；
2. 同库恢复成功回收 staged 状态；
3. 随后一个窗口连续产生不合规 framed 输出，按三次上限进入 human-required；
4. 同配置、全新数据库 tx37 从零运行未复现并严格导出。

该样本说明 provider 波动没有污染已提交数据，fail-closed 与恢复边界按设计工作。它不属于本轮分组或知识架构的可复现失败，也不计入性能数字。

## 产物

英文：

- `projects/children_of_time_book1_100k_optimized_tx35_20260730/exports/folioloom_book_translation.txt`
- `projects/children_of_time_book1_100k_optimized_tx35_20260730/exports/folioloom_book_bilingual.txt`
- `projects/children_of_time_book1_100k_optimized_tx35_20260730/exports/folioloom_book_audit.json`
- `projects/children_of_time_book1_100k_optimized_tx35_20260730/exports/folioloom_book_metrics.json`

德文：

- `projects/kafka_verwandlung_100k_optimized_retry_tx37_20260730/exports/folioloom_book_translation.txt`
- `projects/kafka_verwandlung_100k_optimized_retry_tx37_20260730/exports/folioloom_book_bilingual.txt`
- `projects/kafka_verwandlung_100k_optimized_retry_tx37_20260730/exports/folioloom_book_audit.json`
- `projects/kafka_verwandlung_100k_optimized_retry_tx37_20260730/exports/folioloom_book_metrics.json`

真实书稿、译文、SQLite、provider 输出和凭据均保持在 `projects/`，不得提交。

## 回滚

按最小影响面回滚：

1. concept 误抑制：恢复旧 promotion policy 与逐 wave drain；
2. fragment schema 兼容问题：恢复完整 fragment metadata schema，identity 与 validation 不变；
3. 自适应分组回归：把 policy 切回 legacy 6/480；
4. 二分恢复回归：恢复 paragraph-vector → all-scalar fallback；
5. 不删除既有 ledger、candidate、knowledge 或 revalidation 证据。
