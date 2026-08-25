# FolioLoom 桌面端新手入口与模型厂商注册表设计

**日期：** 2026-07-22  
**状态：** 已确认  
**界面方向：** 方案 A（三步准备页）

## 目标

把当前只面向开发者的桌面 Alpha 改造成普通读者能够直接理解的入口。用户选择一本书稿、连接自己已有的模型服务、完成一次真实兼容性检查，然后试译一个短片段。`source_manifest.json`、SQLite、协议类型、接口地址和请求格式仍然存在于内部，但不再成为普通用户必须理解的前置知识。

本设计同时建立可扩展的模型厂商注册表。首批实现 DeepSeek、Kimi、阿里云百炼、火山引擎、OpenAI、硅基流动和一个高级的“自定义 OpenAI-compatible”入口；智谱、MiniMax、OpenRouter、Gemini、Claude、百度千帆、腾讯 TokenHub、Ollama 和 LM Studio 可在不改动界面状态机或翻译核心的前提下逐项加入。

## 用户流程

首页固定为一个三步准备页：

1. **选择书稿**：接受 TXT、Markdown、EPUB 和 DOCX。FolioLoom 在后台建立内部项目；用户不选择 manifest 或数据库。
2. **连接你的模型**：点击厂商按钮，输入 API Key，选择或填写模型名称，并选择该模型原生支持的思考强度。
3. **先试译一小段**：只有书稿准备成功且模型兼容性检查通过后才可用。试译只创建一个短片段任务，不隐式启动全书翻译。

最近一次成功打开的项目在下次启动时自动恢复。已有的开发者项目仍可通过“更多操作 → 导入旧项目”打开，但该入口不出现在首次使用的主路径中。

## 书稿导入

书稿导入在 Electron 主进程内使用 TypeScript 实现，不调用用户机器上的 Python，也不要求额外安装运行时。导入逻辑只承担 V5 正式工作流需要的无损源账本，不生成旧版 Python 项目的 chapters、memory 或 artifacts。

- TXT/Markdown：识别 BOM；无 BOM 时先严格按 UTF-8 解码。解码失败时让用户选择编码，不使用替换字符掩盖错误。
- DOCX：按 `word/document.xml` 中的段落顺序提取正文，段落之间使用两个换行，保留空段落及来源段编号。
- EPUB：读取 container、OPF manifest 和 spine，严格按 spine 顺序提取 XHTML 正文并记录成员路径。
- 导入前后重新计算原始字节 SHA-256；文件在读取中发生变化则失败，不创建半成品项目。
- 内部项目默认保存在系统“文档/FolioLoom/Projects”下，以书名和短源哈希命名。原始字节被复制进项目，绝不改写用户选择的文件。
- 相同原始哈希再次导入时直接恢复已有项目；同名但内容不同的书稿创建独立项目。
- 初次检测源语言后，在书稿卡片显示“检测为英语/日语/法语……”及“修改”入口。无法可靠判断时使用“未确定”，不静默猜测。

主进程最终仍生成现有 `v5-source-ledger-1` manifest 和 canonical source，因此翻译核心、审计和恢复协议不需要了解 GUI 的存在。

## 厂商注册表

界面不为每个厂商编写独立组件，而是读取统一注册表：

```ts
interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  apiFamily: "openai-chat" | "openai-responses" | "anthropic" | "google";
  defaultBaseUrl: string;
  keyPlaceholder: string;
  modelDiscovery: "standard-models" | "provider-specific" | "curated";
  createRuntime(profile: ModelProfile, credential: SecretCredential): ProviderRuntime;
  discoverModels(credential: SecretCredential): Promise<ModelOption[]>;
  probe(profile: ModelProfile, credential: SecretCredential): Promise<CapabilityReport>;
}
```

首批厂商的 Base URL、认证头、API family 和兼容参数全部固定在注册表中。普通厂商卡片不显示这些内容。只有“自定义 OpenAI-compatible”位于高级设置，并要求 Base URL、API Key 和模型名称。

自定义地址必须是 HTTPS；只对 `localhost`、`127.0.0.1` 和 `[::1]` 允许 HTTP。地址不得包含用户名、密码、查询参数或 fragment。预置厂商地址不可由渲染进程覆盖。

### 首批厂商

| 厂商 | 用户入口 | 模型发现 | API 适配 |
|---|---|---|---|
| DeepSeek | 直接显示 | `/models` + 内置回退 | OpenAI Chat + DeepSeek thinking |
| Kimi | 直接显示 | `/models` + 内置回退 | OpenAI Chat + Kimi 多轮约束 |
| 阿里云百炼 | 直接显示 | 内置回退 + 手填 | OpenAI Chat + Qwen thinking |
| 火山引擎 | 直接显示 | 内置回退 + 手填模型/接入点 ID | OpenAI Chat + 模型级兼容配置 |
| OpenAI | 直接显示 | `/models` + 内置回退 | Responses API |
| 硅基流动 | 直接显示 | `/models` + 手填 | OpenAI Chat；能力按具体模型判断 |
| 自定义兼容接口 | 更多服务 | `/models` 尝试 + 手填 | 保守的 OpenAI Chat 默认值 |

后续厂商只新增 `ProviderDefinition`、模型能力元数据和契约测试。侧栏、三步页和 IPC 不增加新的厂商分支。

## 模型与思考强度

模型名称优先从厂商接口动态获取。获取失败时显示版本化的内置推荐列表，并始终允许用户填写厂商控制台给出的模型 ID。内置列表只是回退，不作为“当前可用模型”的事实来源。

思考强度保留接口原名，例如 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不显示“深入”“最大”等翻译值，也不把所有厂商强行压成一套统一等级。

注册表为每个模型声明：

- 是否支持关闭思考；
- 可接受的原始 effort 值；
- pi-ai 内部 ThinkingLevel 与原始值的双向映射；
- reasoning/thinking 内容在多轮工具调用中是否必须原样回传；
- 最大上下文、最大输出和工具调用能力。

例如原始 `max` 在 pi-ai 内部可由 `xhigh` 路径承载，再由模型映射回请求中的 `max`，避免当前非法值回退为 `high` 的隐性降级。模型不提供可调思考强度时，界面隐藏该字段并显示“由模型固定”，而不是发送猜测参数。

## 兼容性检查

“测试连接”不是单纯调用 `/models` 或要求模型回答 `OK`，而是一组有上限的真实探针：

1. 鉴权和普通流式输出；
2. 要求模型调用一个无副作用的最小工具；
3. 返回工具结果后完成第二轮回答；
4. 检查流式工具参数能否被重组；
5. 检查 reasoning/thinking 内容能否按厂商要求续传；
6. 检查用户选择的原始思考强度是否被接口接受。

探针使用极短提示词、低输出上限和 30 秒超时。结果分为：

- `ready`：可用于 FolioLoom 完整工作流；
- `limited`：普通文本可用，但工具调用或多轮连续性不合格；
- `failed`：鉴权、模型、网络或参数失败。

只有 `ready` 可以启动试译。`limited` 不会被包装成“连接成功”。报告在普通视图中给出可执行的中文原因；原始响应码和 provider error 放在折叠的“技术详情”中。

## API Key 与本机安全

渲染进程只通过固定 IPC 发送一次密钥，不能访问文件系统、环境变量、Node API 或任意 IPC channel。网络请求、模型列表和兼容性检查全部在主进程执行。

- Windows 使用 Electron `safeStorage.encryptString()` 加密后，将 base64 密文保存在 `app.getPath("userData")`。
- 非秘密配置只保存 provider ID、model ID、reasoning effort 和最近一次检查摘要。
- 渲染进程只收到 `credentialConfigured: true/false`，永不收到已保存密钥或密文。
- 日志、错误对象、测试快照和导出报告统一经过密钥脱敏。
- `safeStorage` 不可用时不以明文回退；密钥仅保留在本次进程内，并明确提示“关闭应用后需要重新输入”。
- 用户可以点击“忘记密钥”，主进程删除密文并清空内存副本。

## 普通用户文案

内部数据结构保持原名，用户可见界面改用以下词汇：

| 内部概念 | 普通界面 |
|---|---|
| manifest / canonical source | 书稿 / 项目资料 |
| SQLite store | 翻译记录 |
| run | 翻译任务 |
| window / block | 片段 |
| doctor | 检查 |
| source version mismatch | 书稿内容已发生变化 |

`ProjectOverview`、`DoctorPanel`、`WorkspacePlaceholder`、侧栏、空状态和错误提示都必须扫描。默认可见区域不得出现 `V5`、`source_manifest.json`、`book.db`、`canonical`、`SQLite`、`状态库` 或“协议”等要求用户理解的工程术语。稳定错误码可以保留在默认折叠的技术详情中，方便远程排障。

## 运行与状态边界

试译在 Electron 主进程中创建受控后台任务，复用现有 V5 runner、预算、恢复和审计逻辑；渲染进程只收到序列化进度事件。关闭窗口时，主进程先请求安全中断并等待当前原子提交结束，不把窗口关闭等同于强杀数据库写入。

本阶段只接通一个短片段试译及其成功/失败结果。全书开始、暂停、恢复、批量审阅、术语编辑和导出仍属于后续工作区，不在三步入口中伪造按钮或状态。

## 错误处理

主进程错误统一转换为：

```ts
interface DesktopPublicError {
  code: string;
  message: string;
  nextAction?: string;
  retryable: boolean;
  technicalDetails?: string;
}
```

普通界面只显示 `message` 和 `nextAction`。密钥错误、模型不存在、账户额度不足、限流、服务拥塞、工具调用不支持、网络超时和书稿编码不明确必须分别识别，不使用统一的“连接失败”。未知错误仍保留稳定 code 及已脱敏的技术详情。

## 验证策略

- 单元测试：厂商注册表、effort 映射、模型列表解析、URL 限制、密钥脱敏、源文件解码和来源段覆盖。
- 契约测试：使用本地假服务器覆盖 OpenAI Chat、Responses、DeepSeek reasoning、Qwen thinking、流式工具参数和错误响应；自动测试不调用真实付费 API。
- IPC 测试：渲染层没有任意网络/文件/密钥读取入口，预置 Base URL 不可覆盖。
- UI 测试：三步状态机、厂商切换、原始 effort 标签、连接失败、密钥会话模式和试译解锁。
- 导入回归：TXT/Markdown BOM 与编码、DOCX 空段落、EPUB spine 顺序、源文件中途变化、相同哈希恢复。
- 构建验证：production Electron build 和 Windows x64 unpacked smoke test；密钥文件不进入安装包或仓库。

## 本阶段不做

- 不在首批同时实现所有“更多服务”厂商；注册表先证明新增厂商无需改核心。
- 不为任意自定义协议提供可编程模板；自定义入口只支持保守的 OpenAI-compatible Chat API。
- 不把不支持工具调用的模型降级成另一套隐藏工作流。
- 不把完整全书控制、术语编辑器或导出界面塞进首次使用页。
- 不自动上传书稿、密钥或翻译记录到 FolioLoom 自有服务器。

## 官方接口依据

- [DeepSeek API 文档](https://api-docs.deepseek.com/)
- [Kimi API 文档](https://platform.kimi.com/docs/api/overview)
- [阿里云百炼 OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [硅基流动快速开始](https://docs.siliconflow.com/en/userguide/quickstart)
- [硅基流动 Function Calling](https://docs.siliconflow.com/en/userguide/guides/function-calling)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [智谱 OpenAI 兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
- [MiniMax OpenAI 兼容接口](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [OpenRouter Tool Calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [百度千帆文本生成](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
- [腾讯混元 OpenAI 兼容接口](https://cloud.tencent.com/document/product/1729/111007)
- [Gemini OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)
- [Claude OpenAI SDK 兼容接口](https://docs.anthropic.com/en/api/openai-sdk)
- [LM Studio Tool Use](https://lmstudio.ai/docs/developer/openai-compat/tools)
- [Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)
