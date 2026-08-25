# 稀疏快照重验验证报告

日期：2026-07-26  
分支：`fix/german-100k-gate`  
验证前实现提交：`e1b4d79`  
运行环境：Windows、Node.js 24.14.1、npm 11.11.0

## 验证范围

本轮验证覆盖：

- schema v3 → v4 事务迁移与只读兼容；
- 闭合词汇概念、原文 occurrence 索引和译文 binding 回执；
- 快照变化后的稀疏影响定位；
- `noop`、定向修复、整块重译和失败保留旧版本；
- 通用中文异体字规范与锁定术语保护；
- 结构完整性、知识收敛和严格导出门；
- 三百万字符规模样本；
- 核心、桌面端类型检查、测试和 production build。

验证不包含模型联网调用，不读取或输出 API Key，也不复制任何受版权
保护的小说正文。

## 全套命令与结果

执行：

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
git diff --check
```

结果：

- 核心测试：713 项，712 pass、0 fail、1 skip；
- desktop Node 测试：107 项，106 pass、0 fail、1 skip；
- renderer 测试：66/66 pass；
- 核心与桌面 TypeScript 检查均通过；
- Electron main、preload、renderer production build 通过；
- `git diff --check` 通过；
- 两个 skip 均对应当前 Windows 环境不提供测试所需文件符号链接，不是
  功能失败。

## 三百万字符规模样本

固定样本包含：

| 指标 | 数值 |
|---|---:|
| 原文字符 | 3,000,000 |
| 文本块 | 600 |
| 词汇概念 | 1,000 |
| occurrence 行 | 610 |
| 同一概念连续修订 | 10 次 |
| 十次修订后的 occurrence 行 | 610 |
| 无关概念变化产生的任务 | 0 |
| 实际影响十块时产生的任务 | 10 |

首轮 1,000 个概念建立自动机后，每个文本块只归一化一次、分词一次。
同一概念后续修订只重新扫描其 source forms；旧 occurrence 行被同键替换，
不会形成 `revision × block` 乘积。

独立运行规模用例耗时 3,443 ms；全套测试并发环境中该用例耗时
6,605 ms。测试进程观测到的最大堆增量为 57,645,472 bytes，低于
512 MiB 防退化上限。该数字是本机观测值，不是跨机器性能承诺。

使用正式 schema v4 的 SQLite 页分配做无模型存储测量：

| 阶段 | 已分配字节 |
|---|---:|
| 1,000 个概念与首轮 610 个 occurrence | 856,064 |
| 同一概念再修订十次 | 860,160 |
| 增量 | 4,096 |

十次修订后保留 1,010 条概念历史，但 occurrence 仍为 610 行。数据库增长
来自概念历史的一页分配，不来自重复复制全书影响关系。

## 收敛与失败语义

- 仅置信度等元数据改变且渲染指纹不变时，活动 binding 直接推进到新
  revision，零模型调用、零重验任务。
- 渲染指纹变化时，只查询命中该概念且仍绑定旧指纹的活动译文。
- 旧表面形式仍合法时记录 `resolved_noop`，不调用模型。
- 单一表面冲突进入一个文本块的定向修复；指称、策略或 source forms
  实质改变时进入整块重译。
- 新译文通过校验后才在一个事务内切换 active version；旧版本和旧
  binding 历史保留。
- provider、预算或校验失败达到上限时，旧译文继续 active，binding
  标为 `warning_stale`，其他任务继续。
- 审计分别报告 `structurallyComplete`、`knowledgeConverged` 和
  `strictExportable`。任何 pending、validating、stale 或
  warning-stale 状态都会阻止严格导出；显式允许的非严格导出会使用
  partial 文件名并在审计 JSON 中保留原因。

## 已知非目标

- 本轮不会用字符替换猜测修复“欠债”一类语义或搭配错误；这仍由模型
  翻译质量、抽检和未来通用语义覆盖层处理。
- 通用异体字表只收录跨作品可证明的正字映射；专书术语继续进入概念库，
  不写入全局替换表。
- 模型服务的实际吞吐、供应商限流和语言质量不由本地规模测试证明，将在
  后续《变形记》十万字符真实运行中单独记录。
