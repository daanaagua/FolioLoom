import { toInternalThinking } from "./registry.js";
import type {
  ProviderEffort,
  ProviderOutputTokenField,
  ResolvedProviderProfile,
} from "./types.js";

const NON_THINKING_PROBE_TOKENS = 128;
const THINKING_PROBE_TOKENS = 512;

export interface ProviderWireToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderWireAssistantTurn {
  text: string;
  reasoning: string;
  toolCall: ProviderWireToolCall;
}

export interface ProviderWirePolicy {
  apiFamily: ResolvedProviderProfile["definition"]["apiFamily"];
  outputTokenField: ProviderOutputTokenField;
  thinkingFormat: ResolvedProviderProfile["definition"]["capabilities"]["thinkingFormat"];
  supportsReasoningEffort: boolean;
  requiresReasoningContentOnAssistantMessages: boolean;
  thinkingLevelMap: Record<string, string | null> | undefined;
  initialProbeTokens(effort: ProviderEffort | undefined): number;
  serializeThinking(effort: ProviderEffort | undefined): Record<string, unknown>;
  requiresReasoningReplay(effort: ProviderEffort | undefined): boolean;
  serializeAssistantContinuation(
    turn: ProviderWireAssistantTurn,
    effort: ProviderEffort | undefined,
  ): Record<string, unknown>;
}

function thinkingEnabled(resolved: ResolvedProviderProfile, effort: ProviderEffort | undefined): boolean {
  return resolved.definition.capabilities.reasoning && effort !== undefined && effort !== "off";
}

function thinkingLevelMap(resolved: ResolvedProviderProfile): Record<string, string | null> | undefined {
  const effort = resolved.profile.reasoningEffort;
  if (resolved.definition.capabilities.thinkingFormat === "qwen" || effort === undefined) {
    return undefined;
  }
  const internal = toInternalThinking(effort);
  return internal === undefined ? undefined : { [internal]: effort };
}

export function providerWirePolicy(resolved: ResolvedProviderProfile): ProviderWirePolicy {
  const capabilities = resolved.definition.capabilities;
  const isChat = resolved.definition.apiFamily === "openai-chat";
  const supportsReasoningEffort = capabilities.reasoning && capabilities.thinkingFormat !== "qwen";
  const serializeThinking = (effort: ProviderEffort | undefined): Record<string, unknown> => {
    const enabled = thinkingEnabled(resolved, effort);
    if (!isChat) {
      return enabled && effort !== undefined ? { reasoning: { effort } } : {};
    }
    if (capabilities.thinkingFormat === "deepseek") {
      return {
        thinking: { type: enabled ? "enabled" : "disabled" },
        ...(enabled && supportsReasoningEffort && effort !== undefined ? { reasoning_effort: effort } : {}),
      };
    }
    if (capabilities.thinkingFormat === "qwen") {
      return { enable_thinking: enabled };
    }
    return enabled && supportsReasoningEffort && effort !== undefined ? { reasoning_effort: effort } : {};
  };
  const requiresReasoningReplay = (effort: ProviderEffort | undefined): boolean => (
    isChat
    && capabilities.requiresReasoningContentOnAssistantMessages
    && thinkingEnabled(resolved, effort)
  );

  return {
    apiFamily: resolved.definition.apiFamily,
    outputTokenField: capabilities.outputTokenField,
    thinkingFormat: capabilities.thinkingFormat,
    supportsReasoningEffort,
    requiresReasoningContentOnAssistantMessages: capabilities.requiresReasoningContentOnAssistantMessages,
    thinkingLevelMap: thinkingLevelMap(resolved),
    initialProbeTokens: (effort) => thinkingEnabled(resolved, effort)
      ? THINKING_PROBE_TOKENS
      : NON_THINKING_PROBE_TOKENS,
    serializeThinking,
    requiresReasoningReplay,
    serializeAssistantContinuation: (turn, effort) => ({
      role: "assistant",
      content: turn.text || null,
      tool_calls: [{
        id: turn.toolCall.id,
        type: "function",
        function: { name: turn.toolCall.name, arguments: turn.toolCall.arguments },
      }],
      ...(requiresReasoningReplay(effort) && turn.reasoning.length > 0
        ? { reasoning_content: turn.reasoning }
        : {}),
    }),
  };
}
