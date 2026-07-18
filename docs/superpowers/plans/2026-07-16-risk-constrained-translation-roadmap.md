# 风险受限翻译优化实施路线图

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按可回退的四个阶段，把 schema 9 的固定类别、固定阈值和固定加权流程迁移为 schema 10 的风险受限翻译推断系统。

**架构：** 四份子计划共享同一组不可变风险类型、追加式数据库和 `legacy / observe / active` 三态策略。每一阶段先在 `observe` 模式计算并记录新决策，再用固定回归门槛切换为 `active`；任何阶段都能单独退回 `legacy`，不回滚数据库或丢失既有译文。

**技术栈：** Python 3.14、Pydantic 2、SQLite、pytest、现有 OpenAI 兼容模型客户端、TXT/EPUB 导出链路。

---

## 当前基线

- 分支：`feature/narrative-memory-v5`
- 已提交规格：`a43fbce`
- schema 9 叙事记忆实现已完成并通过既有全量回归。
- 语境化术语档案仍是工作区未提交改动；定向测试命令：

```powershell
& 'D:\llm\小说翻译\.venv\Scripts\python.exe' -m pytest `
  tests/test_candidate_adjudicator.py `
  tests/test_working_targets.py `
  tests/test_v4_matcher_targets.py `
  tests/test_term_validator.py -q
```

当前实测：`110 passed`。第一份子计划先把这批改动验证并独立提交，避免 schema 10
提交混入未冻结的 schema 9 工作。

## 子计划与执行顺序

1. [schema 10 与局部因子推断基础](2026-07-16-schema10-factor-foundation.md)
   - 固化当前 schema 9 基线；
   - 建立 schema 10、风险类型、追加式存储和局部有限因子图；
   - 以统一关系残差替换 `role / vocative` 生产特判；
   - 新路径先以 `observe` 模式接入翻译。
2. [校准风险、信息价值与共指裁决](2026-07-16-calibrated-risk-decisions.md)
   - 实现 beta-binomial、beta calibration 和 Bradley–Terry；
   - 把模型响应保存为可校准 observation；
   - 用风险上界和 VOI 控制二次验证；
   - 用带约束贪心相关聚类统一共指。
3. [效用记忆检索、完整性与重验动作](2026-07-16-utility-memory-revalidation.md)
   - 用懒惰贪心效用选择替换固定记忆分数；
   - 用语义单元覆盖替换长度/段落硬判定；
   - 用预期损失和顺序检验选择 noop、patch、review、retranslate；
   - 验证无人值守有限收敛。
4. [自适应扫描、调度与知识纪元收敛](2026-07-16-adaptive-scheduling-convergence.md)
   - 用 L2 逻辑回归估计候选和跨岛风险；
   - 用风险覆盖选择扫描候选；
   - 用风险约束调度替换 `35 / 65` 档位；
   - 用边际收益停止知识纪元；
   - 完成 200–300 万字规模测试和真实作品试跑。

四份子计划必须按顺序执行。后续计划可以依赖前一计划公开的类型和表，但不得
直接读取前一计划的私有实现细节。

## 跨计划公共契约

### 三态策略

所有可替换的策略使用相同三态：

```python
from enum import Enum


class PolicyMode(str, Enum):
    LEGACY = "legacy"
    OBSERVE = "observe"
    ACTIVE = "active"
```

- `legacy`：只运行现有策略。
- `observe`：现有策略控制结果；新策略计算并写入 `decision_events`，不得改变译文。
- `active`：新策略控制结果；现有策略只记录对照值，不再拥有最终决定权。

### 默认质量政策

```python
@dataclass(frozen=True)
class QualityPolicy:
    epsilon_high: float = 0.02
    epsilon_medium: float = 0.10
    confidence_level: float = 0.95
```

项目可以收紧默认值，但 CLI 和配置加载器不得在无人确认时放宽。

### 风险决策顺序

所有动作选择都必须遵循：

1. 排除硬约束失败动作；
2. 排除严重风险上界超过 `epsilon_high` 的动作；
3. 排除中等风险上界超过 `epsilon_medium` 的动作；
4. 在可行动作中选预计成本最低者；
5. 成本相同依次比较严重风险、中等风险、文体损失和稳定动作名；
6. 无可行动作时选择最低预期损失兜底并记录 `risk_budget_unmet`。

### 审计和版本

- 原始模型请求/响应继续由 `audit_calls` 和压缩审计归档保存。
- schema 10 的轻量结构表只保存归一化特征、概率、哈希和外键。
- 所有学习参数、策略、提示词和特征模式必须有版本号。
- 旧决策必须通过其 `policy_version` 和 `calibration_version` 重放。
- 新表保持追加式；修正通过 `retired_version` 或新版本行表达。

### 回退边界

- 回退只切换 `PolicyMode`，不删除 schema 10 数据。
- 活动译文和人工锁定始终保留。
- 任何迁移失败必须保持原 schema、原活动译文和依赖行数不变。
- 任一阶段出现模型不可用、协议失败或候选格为空时必须在绝对调用上限内结束。

## 每阶段共同验收

- [ ] 新功能先有失败测试，并记录预期失败原因。
- [ ] `observe` 模式与 `legacy` 的最终译文逐字相同。
- [ ] `decision_events` 能解释新旧策略的差异。
- [ ] `active` 模式通过该阶段定向测试和全部既有回归。
- [ ] `legacy` 回退不需要数据库降级。
- [ ] `git diff --check` 无输出。
- [ ] `python -m compileall src main.py` 成功。
- [ ] 每个任务独立 commit；不得把用户既有无关改动纳入提交。

## 最终完成定义

只有四份子计划全部完成并满足以下条件，才能把规格状态改为“已实现”：

- 生产代码中不再由 `role`、`vocative`、具体敬称列表或标题类别直接决定译名；
- 模型自报置信度不经校准不能参与自动决策；
- 固定 `100 / 80 / 70 / 50` 记忆分、`35 / 65` 调度档位、
  `0.15 / 0.75` 完整性阈值和最多三纪元只保留为版本化冷启动先验；
- 严重错误漏检率不高于 schema 9 基线；
- 同成本盲评胜率提高，或同盲评胜率下模型成本下降；
- 无校准数据、模型冲突和局部协议失败时，全书仍能无人值守完成；
- 200–300 万字合成长篇的活动 SQLite 与原文长度保持近似线性增长；
- 《新日之书》和 `Incandescence` 定向案例不依赖作品字符串硬编码。
