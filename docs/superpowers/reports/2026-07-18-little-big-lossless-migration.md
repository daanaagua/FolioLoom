# V5 无损工程验收与《Little, Big》迁移报告

日期：2026-07-18  
分支：`feat/v5-lossless-engineering`

## 结论

建议进入合并评估。全书 source ledger、逻辑分块、窗口规划、schema v2、审计、旧译文候选迁移、partial 导出和反向 lineage 核验均未发现静默丢失或跨 run 混入。`doctor`、`audit`、迁移和导出核验均为确定性本地流程，额外模型调用数为 0。

## 《Little, Big》无损覆盖

| 项目 | 结果 |
| --- | ---: |
| 原始文件字节数 | 1,267,013 |
| canonical Unicode scalar 数 | 1,233,190 |
| raw SHA-256 | `e97042bf71289cc21dfab3b83aec2b3bd6c5bf5c24ea4d5deb0acf44c0ad6dc8` |
| canonical SHA-256 | `e97042bf71289cc21dfab3b83aec2b3bd6c5bf5c24ea4d5deb0acf44c0ad6dc8` |
| source version | `e821cab386200f1cfad7a4abd67e7acbd2823de5b13d8b8c1b21764204a41205` |
| 结构注解 | 32 |
| 逻辑 blocks | 230 |
| 翻译 windows | 210 |
| 覆盖字符 | 1,233,190 / 1,233,190（100%） |
| gap / overlap incidents | 0 / 0 |
| 重复标题 | 5 个标题值、26 次出现（`I`×6、`II`×6、`III`×6、`IV`×6、`V`×2） |
| 初始化用时 | 1,292 ms |
| doctor 用时 | 725 ms |
| doctor `maxRSS` | 145,680 KiB（约 142.3 MiB） |
| doctor 模型调用 | 0（`modelCallsAllowed: false`） |

`doctor` 返回空 incident 列表。重复卷章标题没有参与 block 身份，因此没有造成 ID 合并或覆盖缺口。

## v1 旧译文迁移

旧库为 schema v1、协议 `v5-book-3`、模型 `deepseek-v4-flash`，共有 231 个旧 blocks 和 4 条活动译文。迁移生成独立 run：

`migration-v1-78fb27a0-65ea-46f2-9196-d3c4ddb915a4`

结果：

| 项目 | 结果 |
| --- | ---: |
| 唯一精确匹配并晋升 | 0 |
| 写入 `migration_candidates` | 4 |
| 新 run 活动译文 | 0 |
| 新 run 总 blocks / 缺失 blocks | 230 / 230 |
| audit integrity incidents | 0 |
| partial lineage blocks | 230，revision 全为 `null` |
| `verify-export` | `ok: true`，incidentCodes 为空 |
| 迁移、audit、export、verify 模型调用 | 0 |

这 4 条旧译文的分块边界均与新 lossless blocks 不完全一致，`possibleBlockIds` 因而为空。系统没有按相似文本、邻接位置或旧 global index 猜测晋升，而是全部保留为带 provenance 的候选。该结果正是“不确定则不静默污染活动译文”的预期行为。

## 故障注入矩阵

| 检查点 | 注入时状态 | 重开后的可见状态 | 恢复结果 |
| --- | --- | --- | --- |
| `before_translation_insert` | stage 事务内、写译文前抛错 | 无 staged / active 译文 | rollback 后重新 claim，结果与无故障运行一致 |
| `before_commit` | 事务完成逻辑后、SQLite commit 前抛错 | 无半提交行 | rollback 后重新运行，结果与无故障运行一致 |
| `after_stage` | stage 已原子提交、调用方尚未进入 promote | 仅完整 staged rows，active 为 0 | `recoverInterruptedWindows` 清理后重跑，结果一致 |
| `before_promote` | stage 已完整提交、promote 事务开始前抛错 | 仅完整 staged rows，active 为 0 | 恢复后重跑，结果一致 |

四个检查点都验证了：重开 SQLite 后不存在“部分 active”译文；恢复后的 active projection、audit 和状态汇总与无故障运行完全相同。

额外工程故障验证：

- canonical source 在第一波模型响应期间被修改后，第二波模型调用前以 `SOURCE_VERSION_CHANGED` 阻塞；模型调用计数停在 1。
- 未知 block ID 和同一 block 的重复提交在 stage 前被拒绝，数据库中不产生译文行。
- SQLite `BUSY/locked` 被归一为 `BookStorageIncidentError`，`code=STORAGE_LOCKED` 且 `retryable=true`；CLI JSON 保留这两个字段，不创建人工翻译任务，`humanRequiredWindows=0`。

## 属性验收形态

原有 240 个固定种子随机书样本继续验证 Unicode-scalar block 唯一性和逐字重构。本轮另加 8 个确定性整链样本：

1. 无章节正文；
2. 重复卷名与章名；
3. 1,000 个短章；
4. 100,000 字符单段；
5. UTF-8 BOM、Unicode 控制字符、emoji 和 CJK 混合；
6. 同名目录项与正文标题；
7. 空标题形态；
8. 重复段落。

每个新增样本都完成 `source ledger → structure annotation → lossless blocks → windows → schema v2 → audit`，重构原文完全一致、audit incident 为空、模型调用为 0。合计 248 个书级样本，另有 emoji scalar range 和结构标题重命名两个聚焦属性用例。

## 完整回归

| 套件 | 结果 |
| --- | --- |
| Python（排除历史外部密钥测试 `test_foila_logic.py`） | 682 passed，8 subtests passed，64.03 s（最终验收） |
| TypeScript | 170 / 170 passed |
| TypeScript typecheck | passed |
| `git diff --check` | passed |

历史 `tests/test_foila_logic.py` 依赖外部 `ARK_API_KEY`，按批准计划明确排除；本轮改动没有扩大该例外。
