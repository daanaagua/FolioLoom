# FolioLoom 架构边界

日期：2026-07-29
适用范围：仓库根目录与 `folioloom/` 生产内核
状态：现行约定（P3 冻结）

## 1. 一句话

**生产翻译内核唯一权威是 `folioloom/`（TypeScript）。**
仓库根目录的 Python 只负责输入适配与 V1–V4 研究历史，不得再扩展调度、包络、提交或知识收敛逻辑。

## 2. 目录职责

| 路径 | 角色 | 可否新增生产逻辑 |
|------|------|------------------|
| `folioloom/src/` | 正式内核：分块、调度、翻译、知识、校验、导出、桌面 | **是** |
| `folioloom/desktop` / Electron | 用户工作台，调用同一内核 | 仅 UI/IPC/凭据壳 |
| `main.py` + `src/`（根） | TXT/MD/DOCX/EPUB 导入适配；V1–V4 研究流水线 | **否**（仅修导入/兼容） |
| `tests/`（根 Python） | 旧 Python 栈测试 | 仅随旧栈维护 |
| `folioloom/test/` | 内核与桌面测试 | **是** |
| `docs/superpowers/` | 规格、计划、验收报告 | 文档 |
| `projects/` | 运行时书稿与 `book.db`（勿提交密钥与私人书稿） | 数据 |

## 3. 运行时数据流

```text
用户书稿
   │
   ▼
Python main.py init  ──►  source_manifest.json + 认证原文副本
   │
   ▼
folioloom book doctor / book run / desktop
   │
   ├─ LosslessBookStore (book.db)     译文、知识、窗口、ledger 事件
   ├─ TokenLedger + AdmissionController   token 硬包络
   ├─ RollingHorizonPlanner               纯数值派发（无 DB 写）
   ├─ CongestionSensor (AIMD)             仅推荐并发
   ├─ ExecutionWorker                     单请求模型调用与恢复边
   ├─ CommitCoordinator                   顺序提交
   └─ export / audit / metrics
```

## 4. 控制面边界（1.5 调度）

| 组件 | 允许 | 禁止 |
|------|------|------|
| Planner | 选变体/批次 | 写 DB、改窗口边界、改知识结论 |
| AdmissionController | reserve/settle/拒发 | 调模型、改译文 |
| CongestionSensor | 推荐并发、观察限流 | 单独决定 token 包络 |
| ExecutionWorker | 模型调用、协议/拆分恢复 | 绕过 admission 发车 |
| CommitCoordinator | 按 ordinal 提交 | 重排逻辑窗口 |
| Python | 产生 manifest/原文 | 调度、包络、并行策略 |

`ExecutionWorker` 不持有 store，也不提交窗口。runner 在发车前完成主请求
reserve，并把 `AdmissionController` 作为恢复路径的临时包络端口传入 worker；
worker 返回结果与 usage 后，runner 才负责 settle、遥测、顺序提交与持久化。

## 5. Python 冻结规则

自本文件生效日起：

1. **禁止**在 `src/core/v4/` 或任何 Python 路径新增：
   - 动态调度 / token 包络 / AIMD
   - 新的提交顺序或知识收敛算法
   - 与 `book.db` 并行的第二套全书状态机
2. **允许**的 Python 改动仅限：
   - 输入格式适配与编码探测
   - `main.py init` 兼容性与错误信息
   - 明确标注为研究/历史的脚本，且不得被 `folioloom` CLI/桌面默认调用
3. 新功能默认落在 `folioloom/src/`，测试落在 `folioloom/test/`。
4. 若未来将 import 迁入 TypeScript，另立项目；迁移完成前 Python init 仍为受支持入口。

## 6. 持久化边界

| 数据 | 位置 |
|------|------|
| 原文账本、译文、知识、窗口状态 | `book.db`（LosslessBookStore） |
| token ledger 事件与 scheduler 投影 | `book.db` events（不加关系表） |
| 成本模型与决策日志 | `runtime-profiles.db`（可跨书） |
| API Key | 仅运行时 / Electron safeStorage；永不入库、不进 metrics |

## 7. 对外入口

| 入口 | 用途 |
|------|------|
| `python main.py init …` | 建项目与 manifest |
| `npm run folioloom -- book …` | doctor / run / status / export |
| `npm run desktop:dev` / 便携包 | 普通用户工作台 |
| 根目录 Streamlit / V4 页面 | **非** v1.4+ 主入口，仅历史 |

## 8. 验收与版本

- 调度与 token 包络验收以 `folioloom` 真跑与 `docs/superpowers/reports/` 为准。
- 变更本边界须更新本文件，并在 PR/提交说明中写明。
