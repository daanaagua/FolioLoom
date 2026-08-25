# FolioLoom 桌面端日韩长篇翻译与模型探针可靠性设计

**日期：** 2026-07-22

**状态：** 已选定方案，准备实施

**适用范围：** V5 无损翻译核心、Electron 桌面入口、DeepSeek/OpenAI-compatible 能力探针、日语和韩语源文本

## 1. 背景

本轮由两个真实故障触发：

1. 用户使用 `deepseek-v4-flash`、`high` 测试连接时，桌面端报告“流式可用，但结构化工具调用不可用或格式异常”。同一个 API Key 和模型通过正式 Pi runtime 可以完成结构化工具调用。实际原因是能力探针只给 32 个输出 token：模型先输出思考内容，随后以 `finish_reason=length` 截断；探针却把“输出预算耗尽”误分类成“模型不支持工具”。探针与正式 runtime 的请求方言也已经漂移。
2. 一部约 691 万字符的韩语小说在现有流程中运行异常缓慢。当前系统没有 `ko` 画像，韩语退化为 `und`；日语画像也不能识别测试书的结构，连续日语句子常被从句中硬切。分块器统一按四字符一 token 估算，而 DeepSeek V4 Flash 对本地样本的实测密度约为日语 1.30 字符/token、韩语 1.41 字符/token，输入容量被低估约三倍。

本设计不针对某一本小说、某个标题或某个 API 返回打补丁，而是补齐以下架构边界：模型能力探针、源语言画像、编码协商、统一请求预算、显式运行模式和桌面状态机。

## 2. 目标

- 连接测试能正确区分鉴权失败、模型不存在、探针被截断、工具调用不支持、多轮续传不支持与成功。
- 探针和正式 runtime 共享模型方言与思考强度映射，不再各自手写容易漂移的请求规则。
- `ja`、`ko` 成为完整、版本化的源语言画像，覆盖检测、结构、句界、候选实体和源文残留。
- TXT/Markdown 能确定性处理 UTF-8、UTF-16/32、Shift-JIS/Windows-31J、EUC-JP、EUC-KR/CP949；歧义时由用户确认，绝不静默猜错。
- 分块、窗口、物理请求和并发调度共享同一个版本化 token 预算器，预算包含原文、提示、记忆、术语、工具协议和输出预留。
- 普通模式严格采用用户选择的思考强度；另提供用户显式选择的快速模式，并只在高风险或失败片段升级至用户配置的强度。
- 修复当前桌面三步入口的状态错位、异步竞态、无反馈和伪入口，使真实可用范围内的按钮都能完成对应操作。
- 用真实 DeepSeek API 完成日文全样本和约 20 万韩文字符试跑，记录吞吐、重试、覆盖、残留、乱码和基础质量证据。

## 3. 非目标

- 不承诺在本轮实现全书 GUI、术语编辑器、人工审阅工作台或 EPUB 生成器。
- 不自动把用户选择的 `high` 或 `max` 降为低强度。
- 不为日语或韩语引入完整形态学分析器、外部词典服务或云端 tokenizer 依赖。
- 不把真实测试小说正文、API Key 或付费接口响应提交到仓库。
- 不用字符串相似度自动确认两个角色是同一实体。
- 不用“增加超时”和“减小所有块”掩盖请求预算错误。

## 4. 候选方案与决策

### 方案一：局部修补

把探针上限从 32 改大，新增 `ko` 枚举，为日语和韩语分别写固定字符/token 比例，并在 GUI 中补几个状态提示。

优点是改动小；缺点是探针与正式 runtime 仍会继续漂移，提示词开销仍不计入容量，旧编码仍无法可靠恢复，下一种语言或模型还会重复出现同类问题。

### 方案二：版本化画像、统一预算与自适应执行（采用）

建立共享 provider wire policy、版本化 `SourceLanguageProfile`、`SourceEncodingPolicy` 和 `RequestBudgeter`。所有分块与调度基于完整请求预算；快速模式使用有界风险升级和自适应并发；GUI 使用带请求身份的有限状态机。

该方案改动跨模块，但每个边界都有明确职责，可以用合成夹具、假服务器和真实短基准独立验证。它解决的是故障类别，而不是两个样本。

### 方案三：精确 tokenizer 与全代理调度

为每个厂商接入精确 tokenizer，并让常驻 agent 动态决定分块、检索、思考强度与并发。

精度上限最高，但会增加依赖、调用次数和不可重复决策；对一个可移植桌面工具而言过重，也不利于在无网络或未知兼容接口下运行。本轮不采用。

## 5. 总体结构

```text
原始字节
  │
  ├─ SourceEncodingPolicy ──> 编码决定 + 可信度 + 备选项
  │
  └─ 严格解码后的 canonical UTF-8 文本
          │
          ├─ SourceLanguageDetector
          └─ SourceLanguageProfile(ja/ko/...)
                  ├─ 结构与句界候选
                  ├─ 实体/术语候选
                  ├─ 源文残留规则
                  └─ 字符脚本统计
                          │
                          v
                Versioned TokenEstimator
                          │
                lossless blocks/windows
                          │
                          v
                 RequestBudgeter
       原文 + 固定提示 + 术语 + 记忆 + 风格 + 工具 + 输出预留
                          │
                          v
              Adaptive Translation Scheduler
        quality: 用户 effort 原样使用
        fast: 低成本首译 -> 风险/失败时升级至用户 effort
                          │
                          v
             校验、局部修复、原子提交、审计
```

桌面端只调用上述稳定接口，不复制语言、编码、provider 或调度规则。

## 6. 模型能力探针

### 6.1 共享请求方言

从 provider/model 注册表导出一个只读 `ProviderWirePolicy`：

```ts
interface ProviderWirePolicy {
  apiFamily: "openai-chat" | "openai-responses";
  outputTokenField: "max_tokens" | "max_completion_tokens";
  serializeThinking(effort: ReasoningEffort): Record<string, unknown>;
  serializeAssistantContinuation(turn: ProbeAssistantTurn): Record<string, unknown>;
  requiresReasoningReplay(effort: ReasoningEffort): boolean;
}
```

能力探针、模型发现后的测试请求和正式 Pi runtime 的本地适配层都从同一模型元数据构建该 policy。不能再在探针里独立猜测 token 字段、thinking 开关或第二轮 assistant 消息。

### 6.2 有界探针预算

- 非思考请求初始输出预算 128 tokens。
- 开启思考的请求初始输出预算 512 tokens。
- 若流正常结束于 `finish_reason=length`，将结果分类为 `probe_truncated`，只允许一次有界重试，预算上限 2048 tokens，并受总超时控制。
- 第二次仍被截断时返回“探针输出被截断”，不得转换成 `TOOL_CALL_UNSUPPORTED`。
- JSON 参数仍执行严格解析；不能为了通过测试而接受不完整 JSON。

每轮收集器必须保存终止原因、是否看到工具名、工具参数累计长度和 reasoning 是否存在，但对 UI 和日志输出去敏摘要。

### 6.3 思考续传

- `off` 表示用户明确关闭思考。此时没有 `reasoning_content` 是正常状态，连续性检查记为 `skipped`。
- 只有 policy 表明当前 effort 需要 reasoning replay 时，探针才要求首轮包含 reasoning，并在第二轮原样续传。
- UI 将“请求被接受”与“服务商确实按该强度推理”区分开；后者无法从普通 API 响应严格证明时不作虚假承诺。

### 6.4 DeepSeek 当前模型

内置回退列表使用当前 `deepseek-v4-flash` 与 `deepseek-v4-pro`，动态 `/models` 仍优先。旧模型 ID 只为已有配置保留兼容加载，不再作为新用户默认项。

## 7. 日语与韩语源语言画像

### 7.1 画像接口扩展

`SourceLanguageProfile` 增加以下职责：

```ts
interface SourceLanguageProfile {
  id: SourceLanguageId;
  version: string;
  scripts: readonly SourceScript[];
  detectStructureHeading(line: string): StructureHeading | null;
  collectBoundaryCandidates(text: string): BoundaryCandidate[];
  segment(text: string): SourceToken[];
  collectAnchorCandidates(input: CandidateCollectionInput): AnchorCandidate[];
  detectSourceResidue(translation: string): ResidueFinding[];
  collectScriptStats(text: string): ScriptStats;
}
```

通用分块器只选择画像给出的带权边界；不得再假定句末标点后一定有空格。

### 7.2 日语

- 检测：假名占比、日文标点和汉字/假名共现；纯汉字短文本保持低置信，避免误判中文。
- 结构候选：`第…章/話/節/巻/部`、以 `…の巻` 结束的短独立行、独立的日文数字标题；候选需要长度、周围空行和重复模式共同评分，不能只凭一次正则就确认为章节。
- 边界：段落、标题、`。！？`、闭合引号后的标点均可在无空格情况下成为句界；括号或引号未闭合时降低权重。
- 分词：使用 `Intl.Segmenter("ja", {granularity:"word"})`；不可用时退化为 Unicode 脚本游程和短 n-gram。
- 残留：平假名、片假名和日语专用标点是强信号；汉字不能单独判定，因为目标中文共享汉字。

### 7.3 韩语

- 新增 `ko`、`hangul` 脚本及 Hangul 检测分支。
- 结构候选：标准 `제…장/화/권/부`、短独立标题和成对框线标题；同样通过布局和重复模式评分，避免把正文里的序数短语当章节。
- 边界：段落、标题、`.?!`、韩文引号闭合位置和对话换行。
- 分词：使用 `Intl.Segmenter("ko", {granularity:"word"})`，退化策略同日语。
- 残留：连续 Hangul 是强源文残留信号；已批准的人名原写、引用、代码和产品名通过允许列表豁免。

### 7.4 通用 CJK 候选系统

日语和韩语不能依赖拉丁文字的大写规则。候选由以下确定性特征评分：

```text
score = log1p(corpusFrequency)
      + positionalSpread
      + localRepetition
      + titleOrDialogueCue
      + parentheticalAliasCue
      + honorificOrNamingCue
      - stopwordPenalty
      - punctuationAndNumberNoise
```

画像只提出最多 24 个源形式和紧凑上下文，不决定中文译名，也不确认同一实体。最终锚定仍由现有有界模型结合可见证据完成。测试使用合成姓名、称谓、地名和普通高频词，证明普通虚词不会淹没候选池。

## 8. 编码策略与跨电脑稳定性

### 8.1 决策顺序

`SourceEncodingPolicy` 对 TXT/Markdown 使用固定顺序：

1. BOM 明确的 UTF-8/16/32；
2. 无 BOM 的严格 UTF-8；
3. 有限旧编码候选：Windows-31J/Shift-JIS、EUC-JP、EUC-KR/Windows-949；
4. 只有一个高置信且明显领先的候选时自动接受；
5. 其余情况返回 `encoding_required`，由用户确认。

CP949 作为用户可见别名映射到运行时 canonical label `windows-949`。所有解码都使用显式 `TextDecoder` label 和 `fatal:true`，不依赖 Windows 系统区域设置。

### 8.2 候选评分

评分只用于排序候选，不用于掩盖歧义：

- 目标脚本占比和合法字符比例加分；
- 替换字符、NUL、C0/C1 控制字符、孤立组合符和异常标点游程重罚；
- 日文候选要求假名/汉字的合理共现，韩文候选要求 Hangul 音节占比；
- 多个候选得分接近或样本过短时必须人工确认。

### 8.3 可追溯记录

源清单记录：

```ts
interface SourceEncodingDecision {
  canonicalLabel: string;
  decisionSource: "bom" | "strict_utf8" | "heuristic" | "user";
  confidence: number;
  alternatives: readonly EncodingAlternative[];
  diagnostics: readonly string[];
  policyVersion: string;
}
```

原始字节哈希保持不变，canonical 文本统一为 UTF-8。画像版本、编码策略版本和用户语言覆写进入派生计划身份。旧 `und` 韩文项目不得仅凭相同原始哈希被静默恢复；若已有翻译数据则创建兼容隔离的新派生项目，避免污染旧记录。

### 8.4 GUI 歧义回退

主进程保存一个短时、单次使用的 pending import，并只向渲染进程返回 opaque ID、文件名和允许的编码枚举。渲染进程不能提交任意文件路径或任意 decoder 名称。用户选择后，主进程对原始字节重新严格解码并完成导入。

## 9. 统一 token 与请求预算

### 9.1 版本化估算器

用 `TokenEstimator` 替代固定 `scalar / 4`：

```ts
interface TokenEstimator {
  id: string;
  version: string;
  estimateText(text: string, profile: SourceLanguageProfile): TokenEstimate;
  observeUsage(sample: UsageObservation): void;
}
```

有可用的本地精确 tokenizer 时可以接入；默认估算器按 Unicode 类别线性计权，初始保守权重为：

- Han、Kana、Hangul：0.85 token/scalar；
- 拉丁字母和数字：0.30 token/scalar；
- 空白与常见标点：0.20 token/scalar；
- 其他脚本：0.55 token/scalar；
- 每段和每个结构化字段追加固定边界开销。

这些值不是声称复刻某个 tokenizer，而是让请求安全地不被低估。实际 provider usage 按“模型 + 源画像 + 估算器版本”形成有界校准倍率；倍率只能在安全区间内平滑更新，不能由单个异常响应把全书计划拉偏。

### 9.2 完整请求预算

`RequestBudgeter` 统一核算：

```text
inputBudget = systemPrompt
            + sourceText
            + termProjection
            + narrativeMemory
            + styleProjection
            + toolSchemas
            + protocolEnvelope

totalReserved = inputBudget + expectedOutput + reasoningReserve + safetyMargin
```

分块器负责源文可切割大小，窗口规划器负责逻辑上下文，物理 batcher 在实际投影生成后做最后容量门。任何一层都使用同一估算器和模型限制。

超限处理顺序：

1. 裁剪低相关记忆和低分未锁定术语；
2. 拆分物理请求，但保持逻辑窗口和风格前态；
3. 在画像允许的最佳边界重新细分源块；
4. 仍无法安全执行时返回类型化人工处理，不改变翻译语义。

新估算器版本进入 block/window plan identity，旧的四字符估算计划不会被错误复用。

## 10. 显式运行模式与自适应调度

### 10.1 两种模式

- `quality`：每个模型调用严格使用用户选择的 effort，包括 `high` 和 `max`。
- `fast`：用户明确选择后，普通首译使用该模型支持的最低成本强度（优先 `off`，否则最低合法 effort）；下列情况只对失败片段重试一次，并升级到用户选定 effort：
  - 工具协议或完整性校验失败；
  - 高置信术语、实体或残留校验失败；
  - 请求返回模型自报不确定或风险分超过阈值；
  - provider 可恢复错误后的重新切块请求。

界面在开始前显示当前模式、首译强度和升级强度。选择 `high` 本身不等于允许系统降级；只有用户另选 `fast` 才启用分层策略。

### 10.2 并发控制

调度器同时限制“请求数”和“在途估算 token”：

- 从 2 路开始；
- 连续成功且延迟、错误率和在途 token 均有余量时，每个稳定波次增加 1，直到 provider/user 上限；
- 429、超时或可恢复 5xx 触发乘法降载；
- 上下文超限不视为 provider 拥塞，而是回到 `RequestBudgeter` 拆分；
- 成功、降载和恢复状态持久化，恢复运行不会立即重复冲击服务商。

默认上限应保守，并可由 GUI 高级设置调整。调度算法不得根据语种硬编码并发数。

## 11. 桌面 GUI 状态机修复

### 11.1 模型表单

- 打开页面时，表单从已保存的 `activeModel` 初始化，而不是无条件显示注册表第一个 provider。
- `/models` 和“测试连接”都携带 `providerId + requestNonce`；响应只在二者仍匹配当前表单时生效。
- 请求进行中禁止切换 provider，或显式取消旧请求；不能让旧 DeepSeek 结果覆盖新的 Kimi 表单。
- 失败或 `limited` 后，API Key 只保留在当前 password 输入框，便于用户修正模型后重试；不写日志、不返回 renderer、不持久化。
- `ready` 后密钥由主进程安全保存并清空输入；“忘记密钥”同时清理保存状态、当前反馈和可启动状态。
- 所有路径必须给出成功、受限或失败提示；不能通过重新渲染把状态静默清空。

### 11.2 入口真实性

当前只实现“书稿—模型—短试译”的页面。尚未接通的“翻译运行、术语与记忆、审阅队列、导出”不显示为可点击工作区；可以标注“后续版本”，但不能伪装成已可用功能。

### 11.3 书稿卡片

导入后显示：文件名、检测语言、编码和置信度。语言或编码不确定时展示明确选择控件；正常 UTF-8 高置信导入不增加额外步骤。

## 12. 错误模型与恢复

新增或明确以下稳定错误码：

- `PROBE_OUTPUT_TRUNCATED`
- `TOOL_CALL_UNSUPPORTED`
- `REASONING_CONTINUITY_UNSUPPORTED`
- `SOURCE_ENCODING_AMBIGUOUS`
- `SOURCE_ENCODING_UNSUPPORTED`
- `SOURCE_LANGUAGE_UNCERTAIN`
- `REQUEST_BUDGET_EXCEEDED`
- `PROVIDER_THROTTLED`
- `PROVIDER_TIMEOUT`

Pi agent 可按类型化规则先自行执行一次安全恢复：探针扩大预算、翻译请求拆包、provider 降载或高风险片段升级 effort。每种恢复都有次数上限和审计记录；无法恢复时返回人工处理，不无限循环，也不把外部故障写进术语或叙事记忆。

## 13. 测试策略

### 13.1 能力探针

- 假 SSE 在工具参数中途以 `finish_reason=length` 结束：首次得到截断分类，第二次扩大预算后可通过。
- 两次均截断：返回 `PROBE_OUTPUT_TRUNCATED`，不返回工具不支持。
- DeepSeek `off` 无 reasoning：结果 `ready`，连续性为 `skipped`。
- DeepSeek `high`：分片工具调用、reasoning replay 和第二轮均通过。
- policy 契约测试证明探针和正式 runtime 使用相同 token 字段、thinking 映射和续传规则。

### 13.2 日韩画像与编码

- 自然韩文检测为 `ko`，日文检测为 `ja`；短纯汉字文本不被冒进判断。
- `제1장`、`第十二章`、`…の巻` 和测试书布局能形成结构候选；正文中的相似短语不会被当成标题。
- 连续日语句子在 `。` 后切分，不从句中硬切；韩语对话和段落边界同样可用。
- 日/韩合成文本产生非空且有界的实体候选，虚词不占满候选池。
- Hangul/Kana 残留被发现，合法允许项不误报。
- UTF-8/16/32、Shift-JIS、EUC-JP、EUC-KR 和 Windows-949 合成 fixture 严格往返；歧义字节必须进入确认流程。
- 导入后原始 SHA-256 不变，canonical scalar 坐标可往返，且不存在 U+FFFD、NUL 或异常控制字符。

### 13.3 预算与调度

- CJK 高密度文本不再按四字符/token 规划。
- 加入大型记忆、术语和工具 schema 后，物理请求在发送前拆分。
- usage 反馈只能平滑校准倍率，异常样本不能破坏后续计划。
- 模拟 429/超时会降载，稳定成功会有界升载；恢复后沿用已持久化状态。
- `quality/high` 的所有请求保持 high；`fast` 只有明确风险片段升级 high。

### 13.4 GUI 和安全

- 保存的 Kimi/DeepSeek 配置与当前表单一致。
- provider 切换竞态不会污染新表单。
- 连接成功、受限、失败和忘记密钥均有稳定反馈。
- renderer 无法读取保存密钥、任意本地路径或任意编码 decoder。
- 不可用工作区不能被当作正常功能进入。
- Electron production build 和 Windows unpacked 启动通过最小自动化 smoke test。

## 14. 真实试跑与验收

真实语料仅从本机挂载，仓库只保留哈希、范围和指标：

- 日语：完整运行本地《大菩萨峠》样本，当前约 74,703 Unicode 字符；
- 韩语：从本地《墨香》按完整段落选取约 200,000 Unicode 字符，不运行全书；
- 每份记录原文件 SHA-256、选择范围、画像版本、估算器版本、模型 ID、effort、模式、请求数、重试数、provider usage、墙钟时间和输出哈希。

验收必须同时满足：

1. 导入与导出中 U+FFFD、NUL 和非预期控制字符为 0，原始字节哈希可追溯。
2. 源文覆盖 100%，无重复块、遗漏块、错序块或静默失败。
3. 没有 context-limit 请求；429、超时等可恢复错误按策略降载或重试，并保留审计。
4. 实际输入 usage 的 p95 不超过发送前估算的安全预算；估算不得再出现约三倍低估。
5. 在 provider 未持续限流的同环境基准中，`fast` 对同一 20k 字符样本的有效吞吐至少达到 `quality/high` 的 1.5 倍；韩文 200k 快速模式有效吞吐目标不低于 300k 源字符/小时。若外部服务持续限流，报告 provider 时间与本地处理时间，不能把外部等待归罪于内部流程。
6. 确定性质量门全部通过：工具协议、段落/引号完整、源文残留、锁定术语、系统提示泄漏和异常长度比。
7. 从两种语言各抽取开头、中段、结尾片段，由至少两个独立审查视角检查忠实度、中文可读性、人物/称谓一致性和无凭空增写；存在分歧时保留样本和理由，不以单一模型分数掩盖问题。
8. 桌面端从选择书稿、设置模型、测试连接到短试译完整走通；所有可见按钮均有真实行为或明确不可用状态。

## 15. 兼容与迁移

- 旧 manifest 缺少画像或编码策略版本时保持只读可打开，并由 doctor 提示派生计划需重建。
- 已有英语、法语等项目不重写原始源账本；只有依赖旧 token 估算的 block/window 计划失效重建。
- 同一原始哈希若检测出的语言从 `und` 升级为 `ko`，不能复用旧画像派生物。
- 旧 DeepSeek 模型 ID 保持可加载，但 GUI 新建配置使用当前 V4 模型。
- 数据库 schema 若无需新增列，则优先把版本化元数据写入现有审计载荷；若必须迁移，需另设事务和回滚测试检查点。

## 16. 风险与控制

- **旧编码误判：** 只有高置信且领先时自动接受，否则用户确认；原始字节始终保存。
- **CJK 候选噪声：** 有界数量、停用词惩罚和上下文证据；画像不直接锁定译名。
- **预算过于保守降低速度：** 用真实 usage 平滑校准，不以牺牲容量安全换取单次大请求。
- **快速模式质量下降：** 明确 opt-in；确定性门控和高风险升级；失败只局部重试。
- **并发触发限流：** token 与请求双重限流、AIMD 降载、状态持久化。
- **GUI 密钥泄漏：** renderer 不取回密钥，失败时只保留当前输入内存，日志全链路脱敏。
- **真实基准成本和波动：** 先做 20k pilot，再做指定规模；记录 usage 和 provider 等待，不提交正文或密钥。

## 17. 完成定义

本轮只有在下列证据同时存在时完成：

- DeepSeek V4 Flash/high 的真实连接测试为 `ready`，且回归测试证明截断不会再被误报为工具不支持。
- 日语和韩语均有完整画像、严格编码策略、正确句界和非空有界候选。
- 完整请求预算和自适应调度已替换固定四字符估算与固定两路假设。
- GUI 当前承诺的全流程在 production Electron 中走通，状态不丢失、按钮不失效、错误有反馈。
- 日文全样本与约 20 万韩文字符真实试跑满足第 14 节指标，并保存不含正文和秘密的基准报告。
- 核心、桌面、渲染、构建、恢复和安全测试全部通过；独立综合审查没有未解决的 Critical/Important。

## 18. 真实试跑补充：快速模式正文传输协议

首轮韩语真实试跑证明，主要瓶颈已经不是韩语分块或并发，而是把数千字译文作为深层 JSON 工具参数返回。长正文中的引号、换行和反斜杠都必须再次转义；模型只要漏掉一个字符，整批工具调用就会失效。结构切分重试能够保住覆盖率，却会放大调用数和墙钟时间，因此只能作为兜底。

采用双协议设计：

- `quality` 继续使用 `finalize_translation_batch`，保留结构化风格观察与叙事记忆候选。
- `fast` 使用请求专属 nonce 的纯文本分帧协议。每个不可变 block 的译文被一对独占行包围；正文保持原始中文文本，不进入 JSON 字符串，也不要求工具调用。
- nonce 由协议版本、request ID 和 snapshot ID 确定性哈希生成；解析器只接受当前请求的完整标记行、已知 block ID 和唯一一次起止配对。错误 nonce、未知块、重复块、嵌套标记、缺失结尾或标记外非空正文均按结构错误拒绝。
- 分帧结果仍进入现有 block/window 集合校验、繁简与引号归一化、确定性完整性校验、定向修复和原子提交。协议变化不能绕过任何质量门。
- 快速模式不要求模型在大正文响应中同时生成风格与记忆 JSON。风格观察先由现有确定性逻辑从源文和译文派生；叙事记忆仍由质量模式完整采集，快速模式的低频独立提取留作后续优化，不阻塞本轮吞吐验收。
- 分帧解析失败时，只对失败的单窗口按不可变 block 边界做有限切分，并升级到用户选择的运行时；禁止无限续轮或重新翻译已通过的兄弟窗口。

新增验收证据：快速模式请求不得暴露翻译工具 schema；同一预算下应显著减少模型调用；20k 韩语样本必须 100% 覆盖、无人工任务、无协议违规，并达到第 14 节吞吐目标后才能扩大到正式样本。
