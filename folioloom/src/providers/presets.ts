import type { ProviderDefinition } from "./types.js";

const COMMON_LIMITS = {
  contextWindow: 128_000,
  maxTokens: 37_200,
} as const;

export const DEEPSEEK_MODEL_IDS = Object.freeze([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const);

// Keep the existing export and request IDs for integrations and durable runs.
export const DEEPSEEK_V4_MODEL_IDS = DEEPSEEK_MODEL_IDS;

export function isWellFormedModelId(modelId: string): boolean {
  return modelId.length > 0 && modelId.length <= 256 && modelId === modelId.trim()
    && !/[\u0000-\u001f\u007f]/u.test(modelId);
}

export function isCurrentDeepSeekModelId(modelId: string): boolean {
  // Discovery is authoritative for new names. Keep only explicitly retired
  // aliases blocked; unknown names still need the normal capability probe.
  return isWellFormedModelId(modelId)
    && modelId !== "deepseek-chat" && modelId !== "deepseek-reasoner";
}

export const PROVIDER_PRESETS: readonly ProviderDefinition[] = Object.freeze([
  {
    id: "deepseek",
    displayName: "DeepSeek",
    apiFamily: "openai-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    keyPlaceholder: "DeepSeek API Key",
    modelDiscovery: "standard-models",
    fallbackModels: DEEPSEEK_MODEL_IDS,
    allowManualModel: false,
    allowCustomBaseUrl: false,
    capabilities: {
      ...COMMON_LIMITS,
      // Keep ordinary generation conservative. Review output stays well below
      // the documented 384K maximum within the provider's 1M context window.
      reviewLimits: { contextWindow: 1_000_000, maxTokens: 65_536 },
      reasoning: true,
      efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsTools: true,
      outputTokenField: "max_tokens",
    },
  },
  {
    id: "kimi-cn",
    displayName: "Kimi",
    apiFamily: "openai-chat",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    keyPlaceholder: "Kimi API Key",
    modelDiscovery: "standard-models",
    fallbackModels: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    capabilities: {
      ...COMMON_LIMITS,
      reasoning: true,
      efforts: ["off", "low", "medium", "high"],
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      supportsTools: true,
      outputTokenField: "max_tokens",
    },
  },
  {
    id: "bailian",
    displayName: "阿里云百炼",
    apiFamily: "openai-chat",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyPlaceholder: "阿里云百炼 API Key",
    modelDiscovery: "curated",
    fallbackModels: ["qwen-plus", "qwen-max", "qwen3-235b-a22b"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    capabilities: {
      ...COMMON_LIMITS,
      reasoning: true,
      efforts: ["off", "on"],
      thinkingFormat: "qwen",
      requiresReasoningContentOnAssistantMessages: true,
      supportsTools: true,
      outputTokenField: "max_completion_tokens",
    },
  },
  {
    id: "volcengine",
    displayName: "火山方舟",
    apiFamily: "openai-chat",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyPlaceholder: "火山方舟 API Key",
    modelDiscovery: "curated",
    fallbackModels: ["doubao-seed-1-6-250615", "doubao-1-5-pro-32k-250115"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    capabilities: {
      ...COMMON_LIMITS,
      reasoning: true,
      efforts: ["off", "low", "medium", "high"],
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: false,
      supportsTools: true,
      outputTokenField: "max_completion_tokens",
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    apiFamily: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "OpenAI API Key",
    modelDiscovery: "standard-models",
    fallbackModels: ["gpt-5-mini", "gpt-5"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    capabilities: {
      ...COMMON_LIMITS,
      reasoning: true,
      efforts: ["minimal", "low", "medium", "high"],
      requiresReasoningContentOnAssistantMessages: true,
      supportsTools: true,
      outputTokenField: "max_output_tokens",
    },
  },
  {
    id: "siliconflow",
    displayName: "硅基流动",
    apiFamily: "openai-chat",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    keyPlaceholder: "硅基流动 API Key",
    modelDiscovery: "provider-specific",
    fallbackModels: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-32B"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    capabilities: {
      ...COMMON_LIMITS,
      reasoning: false,
      efforts: [],
      requiresReasoningContentOnAssistantMessages: false,
      supportsTools: true,
      outputTokenField: "max_completion_tokens",
    },
  },
  {
    id: "openai-compatible",
    displayName: "自定义 OpenAI-compatible",
    apiFamily: "openai-chat",
    defaultBaseUrl: "",
    keyPlaceholder: "兼容接口 API Key",
    modelDiscovery: "provider-specific",
    fallbackModels: [],
    allowManualModel: true,
    allowCustomBaseUrl: true,
    capabilities: {
      ...COMMON_LIMITS,
      reasoning: false,
      efforts: [],
      requiresReasoningContentOnAssistantMessages: false,
      supportsTools: true,
      outputTokenField: "max_completion_tokens",
    },
  },
]);
