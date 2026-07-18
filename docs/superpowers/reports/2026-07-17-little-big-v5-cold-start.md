# `Little, Big` V5 冷启动验收报告

日期：2026-07-17

## 结论

V5 全书架构已达到受控长跑条件：确定性分窗、独立 SQLite、按窗原子提交、断点续跑、按需证据检索、词汇锚点、位置受限记忆、TXT/EPUB 导出均通过真实模型试跑与自动测试。此次只运行前三个窗口，不启动全书。

工程可靠性通过，但当前 Flash 模型的文学翻译质量仍需人工抽查。最明确的反例是把习语 `a tall drink of water` 直译成“长长的一杯水”。这不是文本缺失或流程失控，而是模型理解/表达错误；在换用 DeepSeek 正式版或 Pro 前，不建议直接无人值守翻完全书。

## 输入与结构

- 原文件：`D:\llm\qikan4\Little, Big. (John Crowley) (z-library.sk, 1lib.sk, z-lib.sk).txt`
- 文件大小：1,267,013 bytes
- source fingerprint：`5f438209309101a31abf1e25718ffe4960f30c24510824ba5765acb1c324456a`
- 卷/章节记录：33
- 文本块：231
- 翻译窗口：117
- 源字符：1,231,214
- 估算源 token：220,626
- oversized 窗口：0

冷启动发现并修复了一个通用导入缺陷：原预处理器不识别 `Book One` 至 `Book Six`，且各卷重复使用罗马数字章节 ID，导致后卷覆盖前卷。修复后，文本从错误的 6 个章节文件、约 22.2 万字符恢复为 33 个章节、123.1 万字符，并增加重复章节回归测试。

## 架构对比与性能

| 运行方式 | 样本 | 模型调用 | 按需证据 | 耗时/结果 |
|---|---:|---:|---:|---:|
| 旧固定研究 | 73-token 书名页 | 8 | 11,756 字符 | 124 秒 |
| 旧固定研究 | 6,122-token 正文窗 | 多轮 | 大量 | 约 713 秒后终止 |
| V5 按需检索（v5-book-2） | 1,951-token 正文窗 | 4 | 1 次、860 字符 | 93.8 秒 |
| 最终协议（v5-book-3） | 前 3 窗、4 blocks | 11 | 1 次、860 字符 | 193.4 秒总计 |

最终试跑状态：3 completed、114 pending、0 warning、0 human-required、0 failed；所有窗口均一次成功，没有 repair turn。正文窗口预算为 4 次模型调用、4 次翻译工具调用、1 次研究工具调用，证据上限没有被打满。

按正文窗约 90 秒、全书 117 窗粗估，纯串行约 3 小时；热身后并发 2 的实际墙钟时间约 1.5–2.5 小时。考虑模型服务延迟、后文疑难窗口、修复重试，保守预算为 2–3 小时、约 350–470 次模型调用。该估算不是费用承诺。

## 知识状态样例

本次形成 20 个词汇锚点，其中稳定锚点包括：

- `EDGEWOOD` → “埃奇伍德”（0.95）
- `Smoky` → “斯莫基”（0.98）
- `Barnable` → “巴纳布尔”（0.98）
- `Daily` → “戴利”（0.97）
- `Alice` → “爱丽丝”（0.98）
- `Drinkwater` → “德林克沃特”（0.97）
- `Mouse` → “莫斯”（0.97）

`City`、`World`、`Well` 等被保留为 contextual，不会被当作全局硬替换。书名中的 `Little`、`Big` 也没有被固化为空间无关的全局译名。

本轮 narrative memories 为 0。原因是最终模型没有提交满足“置信度至少 0.9、主体在原文出现、证据属于当前窗口”等条件的候选；系统没有为了展示功能而虚构记忆。功能本身由单元测试覆盖，后续出现稳定故事事实时才会写入，并从下一 block 起按位置开放。

## 输出抽查

成功生成：

- `projects/little_big/exports/translator_v5/Little, Big_zh.txt`：UTF-8 BOM，11,224 bytes
- `projects/little_big/exports/translator_v5/Little, Big_zh.epub`：18,499 bytes

目前导出为允许缺块的抽查版，只包含已译的前 4 blocks；严格导出会正确拒绝其余 227 个缺块。

优点：段落完整，专名在同一窗口内一致，未出现系统 JSON 泄漏、引号边界破损、缺段、人工队列或失败窗。断点续跑测试确认已完成窗口不会重复调用模型。

问题：`A Tall Drink of Water` 被译作“长长的一杯水”，且正文复述同一习语时仍作字面处理。这里说明按需检索只能在模型意识到疑点时触发；模型把错误直译当作确定答案时，检索层不会自动救回。后续可通过更强模型、独立低成本习语/异常直译检测器或审校层解决，不应把该短语硬编码进主流程。

## 源文件风险

原 TXT 有若干疑似版本/OCR 异常，例如 `north side or the river`、`hut then`、`rung ftr attention`、`unflcused`。另有 `intr dcrtrs`、`bsns`、`rsdnce` 等形式可能是作品内电话簿缩写，不能一律自动修复。V5 保留原文，不静默改写；正式全书运行前最好换用经过核对的 EPUB 或校订文本。

## 验证结果

- TypeScript：60/60 tests passed
- TypeScript：`tsc --noEmit` passed
- Python：673 tests + 8 subtests passed
- `git diff --check` passed
- 仓库根目录另有历史联网脚本 `tests/test_foila_logic.py`，收集时强制要求 `ARK_API_KEY`；正式离线回归排除此脚本。它不属于本次 V5 改动。

建议：合并 V5 架构到 `main`，保留此次抽查产物；待 DeepSeek 新模型可用后，用相同 3–5 窗做 A/B 质量复测，再决定是否启动 `Little, Big` 全书无人值守翻译。
