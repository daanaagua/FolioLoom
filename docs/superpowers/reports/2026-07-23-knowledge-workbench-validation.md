# 知识工作台验证报告

日期：2026-07-23
分支：`feat/folioloom-desktop`
运行环境：Windows 10、Node.js 24.14.1、Electron 43.2.0

## 构建与测试命令

执行：

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
npm run desktop:dist
git diff --check
```

本轮记录：

- 核心：615 pass、0 fail、1 skip；跳过项是当前 Windows 环境无法创建测试文件符号链接。
- desktop Node：73 pass、0 fail、1 个同类 symlink skip。
- renderer：53/53 pass。
- 核心与桌面 TypeScript 检查通过。
- production renderer/main/preload build 通过。
- Windows x64 portable 打包通过，产物为 `translator-v5/release/FolioLoom-portable-win-x64.exe`。

## schema v2→v3 迁移与故障回滚

- 新库直接创建 schema v3。
- v2 以一个 `BEGIN IMMEDIATE` 迁移到 v3；迁移前后既有 knowledge revision 和 snapshot identity 不变。
- `schema_v3_before_commit` 故障注入会回滚表、marker、fingerprint 和 `user_version`。
- v2 只读打开不触发迁移；v3 写 API 在旧 schema 上给出明确拒绝。
- 新增 `(run_id, record_id) WHERE active=1` 唯一部分索引，既锁定每个知识对象只有一条 active revision，也避免批量提交逐条扫描全部 active 记录。
- Windows 上只读 SQLite 快照关闭后可能短暂保留 WAL/SHM 句柄；清理现有有界重试，耗尽后的 `EBUSY`、`ENOTEMPTY`、`EPERM` 不再掩盖成功的项目读取。快速重复打开回归通过。

## book/project/global 持久化

定向命令：

```powershell
node --test --import tsx --test-name-pattern="reopens user knowledge|rollback appends|seeds a later run|different source version" test/knowledge-commands.test.ts test/desktop-knowledge-service.test.ts
```

结果：3 个匹配测试文件/用例通过。另在真实 Electron 中完成：

- book-scope term 从“执政官”改为“阁下”；
- 关闭应用并重开后仍为 revision 2 与“阁下”；
- 恢复 revision 1 后追加 revision 3，目标值回到“执政官”；
- 导入、导入撤销继续追加 revision 4/5，未删除历史。

project catalog 会为同一项目后续 run seed；不同 source version 只继承 project，不泄漏 book。global term/style 通过显式 promotion/attach 保存不可变 revision 副本，后续全局更新不会静默漂移当前书。

## 翻译投影与已译块影响

命令：

```powershell
node --test --import tsx --test-name-pattern="manual term|conflicting model candidate|syncs book|syncs project" test/book-runner.test.ts test/translation-request.test.ts test/knowledge-authority.test.ts
```

结果：3/3 匹配测试文件通过。

- 人工 locked 字段不能被模型候选覆盖。
- 恢复运行前同步较新的 book/project generation。
- 翻译请求只投影与当前片段匹配的有界知识；不匹配块不承担额外 prompt。
- 知识修改只记录“可能受影响”的已译块，不静默重写既有译文。
- style 继续使用结构化持久字段，不把整份工作台历史发给模型。

## IPC 与桌面安全边界

- 主进程从当前可信项目解析 manifest、store 和 run；renderer 不能提交路径。
- preload 只暴露具名、固定形状的方法，没有 generic invoke、文件读取器、数据库句柄或 credential reader。
- list/detail/import 均有枚举、长度、UUID、游标和分页上限校验。
- 外部导航与 `window.open` 被拒绝；production 不接受任意 dev renderer URL。
- API Key 始终留在主进程，本次工作台验收没有读取或发送任何用户密钥。

真实 GUI 验收覆盖：

- 1442×922 与 1102×722；
- 集成暗色标题栏、项目概览与知识工作台；
- 列表、筛选、详情、编辑、历史恢复；
- 导入冲突、提交、撤销、重启恢复、丢弃后重试；
- modal 视图切换后的焦点回收；
- 页面级 `scrollWidth === clientWidth` 且 `scrollHeight === clientHeight`；
- portable 冷启动后直接恢复当前项目。

全部测试 Electron 窗口已关闭，用户已有 Chrome 未被操作。

## 50,000 条记录性能

命令：

```powershell
$env:FOLIOLOOM_PERF_RECORDS='50000'
npx tsx scripts/validate-knowledge-workbench-performance.ts
```

本机结果：

| 指标 | 结果 |
|---|---:|
| staging | 2,735 ms |
| 单事务 commit | 173,928 ms |
| 首屏 50 条 | 4.32 ms |
| 后续游标页 50 条 | 3.20 ms |
| 精确详情 | 1.17 ms |
| payload 模糊搜索 | 887.38 ms |
| 诊断汇总 | 612.65 ms |
| SQLite 大小 | 255,950,848 bytes |

计划规定的首屏、后续页与详情三项均低于 250 ms。搜索与诊断不在阻断门槛内，但保留实测数字，不用放宽断言掩盖性能。

## 非 P0/P1 限制

- 大批量 commit 仍比 staging 慢，50,000 条约 2 分 54 秒；这是当前主要 P2 性能空间。
- 50,000 条 payload 任意字段模糊搜索接近 0.9 秒；若未来知识库普遍达到十万级，可增加独立 FTS 索引。
- `翻译运行`、`审阅队列` 与 `导出` 完整 GUI 仍属于后续里程碑；当前 CLI 功能未被移除。
- portable 仍使用 Electron 默认图标，package metadata 还没有 author；不影响运行正确性。
