# 2026-07-29 德语与《时间之子》100k Release Gate

## 结论

**Release gate 未通过；不得上传、打 tag 或发布 release。**

本轮使用全新项目和独立数据库复跑，没有覆盖 2026-07-28 的历史验收库。
德语样本在正确的 token 硬门处停止；英文样本的单窗口探针已经超出硬包络，
因此没有继续消耗完整 100k 的模型调用。

## 样本指纹

### 德语

- 来源：Project Gutenberg《Die Verwandlung》
  - <https://gutenberg.org/ebooks/22367>
- 取样：正文起点开始的前 99,952 个 Unicode scalar，末尾补一个换行
- Unicode scalar：99,953
- UTF-8 bytes：101,997
- SHA-256：
  `b3a7febe6ac0a3c99b557e437ccdc9e1025effdcdf0cf18789f6daae87e41199`

### 英文

- 来源：用户提供的《Children of Time》Book 1 TXT
- 完整源文件 SHA-256：
  `68c112d3470be160095116be4e1737a4638439eb7495df6bf2c29e421bfd76ce`
- 取样：100k 边界前最后一个完整句子
- Unicode scalar：99,862
- UTF-8 bytes：101,453
- 样本 SHA-256：
  `e7911a3b21d28722fce9b7fb2c1dbdd1032f2bcfdd3e1091181fb8ef4e1ad531`

样本、译文、运行数据库和模型日志均保留在被忽略的本地 `projects/` 目录，
不进入 Git。

## Doctor

### 德语

- 覆盖：99,953 / 99,953 scalar
- 窗口：19
- incident：0
- warning：11 条超长行、4 条 spaced hyphenation

### 英文

- 覆盖：99,862 / 99,862 scalar
- 窗口：19
- incident：0
- warning：1 条重复 frontmatter

## 真跑结果

运行模型均为 `deepseek-v4-flash`，调度模式为 `active/balanced`。

### 德语

最终候选运行：

- run：`d0def66f-24e5-498a-9779-589a1868025b`
- probe：1 / 19 完成
  - baseline：17,797
  - allowed：19,576
  - actual：18,819
  - usage complete：true
- resume：累计 9 / 19 已处理，8 completed、1 warning、10 pending
  - baseline：209,259
  - allowed：230,184
  - actual：243,029
  - usage complete：true
- audit：
  - structurally complete：false
  - strict exportable：false
  - missing blocks：10

停止原因是稳定的 `TOKEN_ENVELOPE_EXHAUSTED`，没有把 token gate 错报成
`maxInFlightTokens`。

ledger 显示 lexical anchor 的静态 baseline 每次为 1,920，而三次已完成调用的
真实消耗分别为 5,736、6,258、7,200。第四次 anchor 仅写入 baseline，随后在
reserve 前被硬门拒绝。anchor 静态预测偏低是后续必须处理的发布阻断项。

### 《时间之子》

- run：`afc81800-07d8-46c2-95b3-da490dcc687a`
- 只执行单窗口 probe：1 / 19 completed、18 pending
- CLI 投影：
  - baseline：17,491
  - allowed：19,240
  - actual：31,827
  - usage complete：false
- durable ledger 最终 spent：34,614
- strict export：未执行

该窗口的翻译静态预测为 14,771，真实翻译消耗为 29,907，其中 reasoning
tokens 为 18,958。冷启动的 high-effort reasoning reserve 明显偏低。单窗口
已经证明硬包络失败，因此停止完整 100k，避免继续产生无效费用。

CLI 投影的 31,827 与 durable ledger 的 34,614 不一致，也必须在下一轮验证中
查清投影刷新时序。

## 本轮已修复

1. planner 返回 `NO_LEGAL_PLAN` 时，返回稳定调度错误；仅在数值确实超限时
   返回 token envelope 错误，不再误报
   `maxInFlightTokens cannot admit smallest request reservation`；
2. resume 不再把已纳入 horizon 的 logical window 重复加入 baseline；
3. quality outer retry 回到 typed-tool，不重复使用已经失败的 framed 协议；
4. active 模式 settle 后若真实 spend 已超 allowed，不能再返回表面成功；
5. baseline 去重键改为稳定 logical window ID；physical request 重组不会扩大
   token envelope；
6. 桌面 active pause 改为在当前 provider wave 正常结算和提交后，于下一个
   durable wave boundary 协作暂停；不再中断调用并把未知 usage 永久计入
   spend；
7. 应用退出与交互 pause 分流：退出先给 cooperative pause 有界 grace，超时
   abort，再经过有界等待后允许 Electron 继续退出，provider 卡住不会无限阻塞。

上述改动均有回归测试；独立代码审查未发现新增 Critical 或 Important。

## 最终代码门禁

在报告对应的最终工作树上重新执行：

- `npm test`：861 tests，860 pass，0 fail，1 skip；
- `npm run typecheck`：通过；
- `npm run desktop:test`：Node 109 pass、1 skip；Renderer 66 pass；
- `npm run desktop:typecheck`：通过；
- `npm run desktop:build`：production build 与 preload 验证通过；
- `git diff --check`：通过。

代码门禁通过不改变真跑结论：两个 100k release gate 仍未通过。

## 剩余发布阻断项

1. 修正 high/max effort 的 reasoning 静态 reserve，使其覆盖真实 provider usage，
   且不靠抬高 baseline 掩盖 retry 成本；
2. 为 lexical anchor 建立基于真实输入、输出和 reasoning 的静态预算；
3. 修复 CLI scheduler projection 与 durable ledger 最终 spent 不一致；
4. 按冻结规格接入非零 `conservativeHorizonFloor`，不得继续使用默认 0；
5. 在最终代码上用两个全新项目重跑：
   - 德语 100k：19 / 19、strict export、usage complete、actual ≤ allowed；
   - 《时间之子》100k：19 / 19、strict export、usage complete、actual ≤ allowed；
6. 再执行全部 Node、Renderer、typecheck 和 production build gate。

只有以上全部通过，才能进入版本号更新、tag、push 和 release 上传。
