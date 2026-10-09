import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ensureProviderNetwork, providerNetworkError, withProviderNetwork, providerTlsCompatibility, type ProviderNetworkError, type ProviderTlsCompatibility } from "./network.js";
import { createProviderPreflight, registerProviderPreflight } from "./preflight.js";

import { providerRegistry, toInternalThinking } from "./registry.js";
import { providerWirePolicy, type ProviderWirePolicy } from "./wire-policy.js";
import type {
  ModelProfile,
  ProviderModel,
  ProviderRuntime,
  ResolvedProviderProfile,
  SecretCredential,
} from "./types.js";

export interface ProviderRuntimeOptions {
  trustedBaseUrl?: string;
  timeoutMs?: number;
  tlsCompatibility?: ProviderTlsCompatibility;
}

function requireCredential(value: SecretCredential): SecretCredential {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("provider credential must be a non-empty string");
  }
  return value;
}

function chatCompat(resolved: ResolvedProviderProfile, policy: ProviderWirePolicy): OpenAICompletionsCompat {
  return {
    thinkingFormat: policy.thinkingFormat,
    supportsReasoningEffort: policy.supportsReasoningEffort,
    requiresReasoningContentOnAssistantMessages: policy.requiresReasoningReplay(resolved.profile.reasoningEffort),
    maxTokensField: policy.outputTokenField === "max_tokens" ? "max_tokens" : "max_completion_tokens",
    supportsStrictMode: true,
    ...(resolved.definition.id === "kimi-cn" ? { deferredToolsMode: "kimi" as const } : {}),
  };
}

function createModel(resolved: ResolvedProviderProfile, baseUrl: string): ProviderModel {
  const capabilities = resolved.definition.capabilities;
  const policy = providerWirePolicy(resolved);
  const common = {
    id: resolved.profile.modelId,
    name: resolved.profile.modelId,
    provider: `folioloom-${resolved.definition.id}`,
    baseUrl,
    reasoning: capabilities.reasoning,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
    ...(capabilities.reviewLimits ? { reviewLimits: { ...capabilities.reviewLimits } } : {}),
    thinkingLevelMap: policy.thinkingLevelMap,
  };
  if (resolved.definition.apiFamily === "openai-responses") {
    const model: Model<"openai-responses"> = {
      ...common,
      api: "openai-responses",
      compat: {
        supportsDeveloperRole: true,
      } satisfies OpenAIResponsesCompat,
    };
    return model;
  }
  const model: Model<"openai-completions"> = {
    ...common,
    api: "openai-completions",
    compat: chatCompat(resolved, policy),
  };
  return model;
}

export function createProviderRuntime(
  profile: ModelProfile,
  credential: SecretCredential,
  options: ProviderRuntimeOptions = {},
): ProviderRuntime {
  const resolved = providerRegistry.resolve(profile);
  const apiKey = requireCredential(credential);
  const tlsCompatibility = providerTlsCompatibility(options.tlsCompatibility);
  const baseUrl = options.trustedBaseUrl === undefined
    ? resolved.baseUrl
    : options.trustedBaseUrl.trim().replace(/\/$/, "");
  if (baseUrl.length === 0) {
    throw new TypeError("trusted provider base URL must be a non-empty string");
  }
  const model = createModel(resolved, baseUrl);
  const internalThinking = profile.reasoningEffort === undefined
    ? undefined
    : toInternalThinking(profile.reasoningEffort);
  const api = resolved.definition.apiFamily === "openai-responses"
    ? openAIResponsesApi()
    : openAICompletionsApi();
  const streamFn: StreamFn = (streamModel, context, streamOptions) => {
    ensureProviderNetwork();
    const output = createAssistantMessageEventStream();
    const scope: { failure?: ProviderNetworkError; tlsCompatibility: ProviderTlsCompatibility } = { tlsCompatibility };
    void withProviderNetwork(scope, async () => {
      let partial: AssistantMessage | undefined;
      try {
        const events = api.streamSimple(streamModel, context, {
          ...streamOptions, apiKey, maxRetries: 0,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(internalThinking === undefined ? {} : { reasoning: internalThinking }),
        });
        for await (const event of events) {
          if ("partial" in event) partial = event.partial;
          if (event.type === "error" && scope.failure) {
            output.push({ ...event, error: { ...event.error, errorMessage: scope.failure.message } });
          } else output.push(event);
        }
      } catch (error) {
        const failure = scope.failure ?? providerNetworkError(error);
        output.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: streamModel.api, provider: streamModel.provider, model: streamModel.id,
          timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          ...partial, stopReason: "error", errorMessage: failure?.message ?? "Provider stream could not be completed.",
        } });
      } finally { output.end(); }
    });
    return output;
  };
  const preflight = createProviderPreflight(baseUrl, apiKey, options.timeoutMs, tlsCompatibility);
  registerProviderPreflight(streamFn, preflight);
  return { model, streamFn, preflight };
}
