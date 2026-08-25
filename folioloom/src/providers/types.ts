import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export type ProviderId =
  | "deepseek"
  | "kimi-cn"
  | "bailian"
  | "volcengine"
  | "openai"
  | "siliconflow"
  | "openai-compatible";

export type ProviderApiFamily = "openai-chat" | "openai-responses";

export type ProviderOutputTokenField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";

export type ProviderThinkingFormat = "openai" | "deepseek" | "qwen";

export type ProviderEffort = "off" | "on" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type InternalThinkingLevel = ThinkingLevel;

export type ModelDiscoveryMode = "standard-models" | "provider-specific" | "curated";

export type ModelOptionSource = "live" | "fallback";

export interface ModelOption {
  id: string;
  source: ModelOptionSource;
}

export interface ProviderCapabilities {
  reasoning: boolean;
  efforts: readonly ProviderEffort[];
  thinkingFormat?: ProviderThinkingFormat;
  requiresReasoningContentOnAssistantMessages: boolean;
  supportsTools: boolean;
  contextWindow: number;
  maxTokens: number;
  outputTokenField: ProviderOutputTokenField;
}

export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  apiFamily: ProviderApiFamily;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  modelDiscovery: ModelDiscoveryMode;
  fallbackModels: readonly string[];
  allowManualModel: boolean;
  allowCustomBaseUrl: boolean;
  capabilities: ProviderCapabilities;
}

export interface ModelProfile {
  providerId: ProviderId;
  modelId: string;
  reasoningEffort?: ProviderEffort;
  customBaseUrl?: string;
}

export type SecretCredential = string;

export interface ResolvedProviderProfile {
  profile: ModelProfile;
  definition: ProviderDefinition;
  baseUrl: string;
}

export interface ProviderRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
}

export type ProbeStatus = "ready" | "limited" | "failed";

export type CapabilityCheckId =
  | "stream"
  | "tool_call"
  | "tool_round_trip"
  | "reasoning_continuity"
  | "effort";

export type CapabilityCheckStatus = "passed" | "failed" | "skipped";

export type ProviderProbeErrorCode =
  | "AUTH_INVALID"
  | "MODEL_NOT_FOUND"
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "PROVIDER_BUSY"
  | "TOOL_CALL_UNSUPPORTED"
  | "REASONING_CONTINUITY_UNSUPPORTED"
  | "PROBE_OUTPUT_TRUNCATED"
  | "REQUEST_TIMEOUT"
  | "PROVIDER_PROTOCOL_INVALID"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_REQUEST_REJECTED";

export interface CapabilityCheck {
  id: CapabilityCheckId;
  status: CapabilityCheckStatus;
  message: string;
}

export interface CapabilityReport {
  status: ProbeStatus;
  checks: readonly CapabilityCheck[];
  code?: ProviderProbeErrorCode;
  message: string;
  technicalDetails?: string;
}

export type FetchLike = typeof globalThis.fetch;
