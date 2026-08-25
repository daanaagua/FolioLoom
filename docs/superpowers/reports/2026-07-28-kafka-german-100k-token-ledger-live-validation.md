# 《变形记》德语前 10 万字符 Token 账本验收报告

- 日期：2026-07-28
- 分支：`fix/german-100k-gate`
- 规格：`docs/superpowers/specs/2026-07-28-token-ledger-and-scheduler-control-plane-design.md`
- 模型：`deepseek-v4-flash`
- 调度模式：`active`
- 优化档位：`balanced`
- 运行 ID：`836e57f2-db0b-487c-ab09-b6b443e0bfb3`
- 项目：`projects/kafka_verwandlung_100k_gate2/`（全新隔离库，不复用 07-27 超限 run）
- 结论：**通过**。无损覆盖、知识收敛、严格导出与 token 硬包络均满足；独立 export 可读 scheduler metrics。

## 1. 样本与隔离

- 原文：与 2026-07-27 报告相同的 Project Gutenberg 德语《Die Verwandlung》正文截取
- Unicode scalar：99,953
- SHA-256：`b3a7febe6ac0a3c99b557e437ccdc9e1025effdcdf0cf18789f6daae87e41199`
- 新项目路径：`projects/kafka_verwandlung_100k_gate2/`
- 未修改 `kafka_verwandlung_100k_live` 或其他项目的 `book.db`
- 凭据：从本机 OpenCode DeepSeek 配置生成临时 `0600` 认证文件；验证结束后删除

## 2. 预检与探针

`book doctor`：覆盖完整；11 个超长行与 4 个空格连字符告警（与既有报告一致），无完整性 incident。

单窗口探针（`max-windows 1`，并发 1）：

| 指标 | 数值 |
| --- | ---: |
| 墙钟 | ~79 s |
| baselineTokens | 17,797 |
| allowedTokens | 19,576 |
| actualTokens | 15,942 |
| planningStatus | optimal |
| 包络 | 通过 |

## 3. 全书续跑

同一 run ID 续跑，`max-concurrency 4`，`active/balanced`。

| 指标 | 数值 |
| --- | ---: |
| 完成窗口 | 19/19 |
| warning 窗口 | 3 |
| human_required | 0 |
| failed | 0 |
| 模型调用（status） | 26 |
| 精确重译回溯 | 3 |
| 全书墙钟（续跑段） | ~618 s |
| planningStatus | optimal |
| decisions | 10 |
| fallbacks | 0 |
| baselineTokens | 575,480 |
| allowedTokens | 633,028 |
| predictedTokens | 398,743 |
| actualTokens | 422,510 |
| actual ≤ allowed | **是**（约 66.7% of allowed） |
| exceeded | **false** |
| tokenUsageComplete | false（锚定路径无供应商 usage 分量，按保守 settle） |

相对 2026-07-27 失败基线（actual 359,975 / allowed 261,358，超 37.7%）：本次在全新账本路径下 **未超限**。

## 4. 质量与导出

严格审计与独立 `book export`（不传 `options.scheduler`）：

| 指标 | 结果 |
| --- | --- |
| complete | true |
| structurallyComplete | true |
| knowledgeConverged | true |
| strictExportable | true |
| coverageMissing | 0 |
| incident | 无 |
| export `scheduler` | **非 null** |
| tokenEnvelope.exceeded | false |

导出产物：

```text
projects/kafka_verwandlung_100k_gate2/artifacts/exports/folioloom_book_translation.txt
projects/kafka_verwandlung_100k_gate2/artifacts/exports/folioloom_book_bilingual.txt
projects/kafka_verwandlung_100k_gate2/artifacts/exports/folioloom_book_audit.json
projects/kafka_verwandlung_100k_gate2/artifacts/exports/folioloom_book_metrics.json
```

## 5. 与规格验收项对照

| ID | 标准 | 结果 |
|----|------|------|
| A2 | 独立 export `scheduler ≠ null` | 通过 |
| A4 | 包络耗尽语义 | 本次未触发；硬门代码路径已有回归 |
| A5 | balanced：`actual ≤ floor(baseline*1.10)` | 通过（422,510 ≤ 633,028） |
| A6 | 无损 / 收敛 / strictExportable | 通过 |

## 6. 残余说明

1. `tokenUsageComplete=false`：lexical anchor 暂无完整供应商 usage 回写，按预测保守 settle；不豁免包络比较。
2. P1/P2（runner 拆分、AIMD 传感化）未在本验收范围。
3. 文学润色质量不在本验收范围；结构与成本硬门通过不等于出版级译文。

## 7. 判定

**2026-07-28 德语 100k active/balanced 真实验收：通过。**
