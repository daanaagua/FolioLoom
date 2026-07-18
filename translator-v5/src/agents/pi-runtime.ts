import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Model,
  type StopReason,
  type ThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import type { PilotModelConfig } from "../config.js";
import type { AgentPhase } from "../domain/types.js";
import { BudgetLedger, type BudgetCounter } from "../kernel/budget.js";
import { CapabilityRegistry } from "../kernel/capabilities.js";
import { MemoryEventLog } from "../kernel/event-log.js";
import { asKernelTools, type TypedToolSpec } from "../tools/tool-spec.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const SEQUENTIAL_TOOLS = new Set([
  "submit_questions",
  "submit_resolution",
  "finish_research",
  "finalize_translation",
  "finalize_translation_batch",
  "submit_repaired_translation",
  "submit_lexical_anchors",
  "choose_recovery_strategy",
  "submit_recovery_result",
]);

export interface PiSessionSpec {
  systemPrompt: string;
  prompt: string;
  phase: AgentPhase;
  model: Model<Api>;
  tools: readonly TypedToolSpec[];
  budget: BudgetLedger;
  terminateTools?: readonly string[];
  signal?: AbortSignal;
  deadlineMs?: number;
  maxTurns?: number;
  eventLog?: MemoryEventLog;
  thinkingLevel?: ThinkingLevel;
}

export interface PiToolError {
  toolName: string;
  message: string;
}

export class ModelProviderError extends Error {
  override readonly name = "ModelProviderError";
}

export interface PiRunResult {
  modelCalls: number;
  toolNames: string[];
  toolErrors: PiToolError[];
  usage: Usage;
  durationMs: number;
  stopReason: StopReason;
  messages: AgentMessage[];
  deadlineExceeded: boolean;
  turnLimitReached: boolean;
}

function assistant(message: AgentMessage): message is AssistantMessage {
  return "role" in message && message.role === "assistant";
}

function addUsage(total: Usage, value: Usage): void {
  total.input += value.input;
  total.output += value.output;
  total.cacheRead += value.cacheRead;
  total.cacheWrite += value.cacheWrite;
  total.reasoning = (total.reasoning ?? 0) + (value.reasoning ?? 0);
  total.totalTokens += value.totalTokens;
  total.cost.input += value.cost.input;
  total.cost.output += value.cost.output;
  total.cost.cacheRead += value.cost.cacheRead;
  total.cost.cacheWrite += value.cost.cacheWrite;
  total.cost.total += value.cost.total;
}

function turnCounter(phase: AgentPhase): BudgetCounter {
  switch (phase) {
    case "research":
      return "researchTurns";
    case "translation":
      return "translationTurns";
    case "repair":
      return "repairTurns";
    case "recovery":
      return "recoveryTurns";
  }
}

function resultText(result: unknown): string {
  const serialized = JSON.stringify(result);
  return serialized ?? "null";
}

function toAgentTools(specs: readonly TypedToolSpec[]): AgentTool<any>[] {
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: SEQUENTIAL_TOOLS.has(spec.name) ? "sequential" : "parallel",
    execute: async (_toolCallId, parameters, signal) => {
      const effectiveSignal = signal ?? new AbortController().signal;
      const details = await spec.execute(parameters, effectiveSignal);
      return {
        content: [{ type: "text", text: resultText(details) }],
        details,
      };
    },
  }));
}

export class PiRuntime {
  async run(spec: PiSessionSpec, streamFn: StreamFn): Promise<PiRunResult> {
    spec.signal?.throwIfAborted();
    if (spec.deadlineMs !== undefined && (
      !Number.isFinite(spec.deadlineMs) || spec.deadlineMs <= 0
    )) {
      throw new TypeError("deadlineMs must be positive");
    }
    if (spec.maxTurns !== undefined && (
      !Number.isInteger(spec.maxTurns) || spec.maxTurns <= 0
    )) {
      throw new TypeError("maxTurns must be a positive integer");
    }

    const registry = new CapabilityRegistry(asKernelTools(spec.tools));
    const specsByName = new Map(spec.tools.map((tool) => [tool.name, tool]));
    const terminateTools = new Set(spec.terminateTools ?? [
      "finish_research",
      "finalize_translation",
      "submit_repaired_translation",
    ]);
    const eventLog = spec.eventLog ?? new MemoryEventLog();
    const startedAt = performance.now();
    const usage = structuredClone(ZERO_USAGE);
    const toolNames: string[] = [];
    const toolErrors: PiToolError[] = [];
    let modelCalls = 0;
    let deadlineExceeded = false;
    let turnLimitReached = false;

    const agent = new Agent({
      initialState: {
        systemPrompt: spec.systemPrompt,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel ?? "high",
        tools: toAgentTools(spec.tools),
        messages: [],
      },
      streamFn,
      toolExecution: "parallel",
      beforeToolCall: async ({ toolCall }) => {
        try {
          registry.get(toolCall.name);
          const tool = specsByName.get(toolCall.name);
          if (tool === undefined || tool.phase !== spec.phase) {
            return {
              block: true,
              reason: `capability unavailable in ${spec.phase}: ${toolCall.name}`,
            };
          }
          return undefined;
        } catch {
          return {
            block: true,
            reason: `capability not allowed: ${toolCall.name}`,
          };
        }
      },
      afterToolCall: async ({ toolCall, isError }) => {
        eventLog.append("tool", { name: toolCall.name, isError });
        if (terminateTools.has(toolCall.name) && !isError) {
          return { terminate: true };
        }
        if (spec.maxTurns !== undefined && modelCalls >= spec.maxTurns) {
          turnLimitReached = true;
          return { terminate: true };
        }
        return undefined;
      },
    });

    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          spec.budget.consumeMany({
            modelCalls: 1,
            [turnCounter(spec.phase)]: 1,
          });
          modelCalls += 1;
          eventLog.append("model", { phase: spec.phase, modelCalls });
          break;
        case "turn_end":
          if (assistant(event.message)) {
            addUsage(usage, event.message.usage);
          }
          break;
        case "tool_execution_start":
          toolNames.push(event.toolName);
          break;
        case "tool_execution_end":
          if (event.isError) {
            const content = event.result?.content;
            const message = Array.isArray(content)
              ? content
                .filter((item): item is { type: "text"; text: string } =>
                  item?.type === "text" && typeof item.text === "string")
                .map((item) => item.text)
                .join("\n")
              : "tool execution failed";
            toolErrors.push({ toolName: event.toolName, message });
          }
          break;
        case "agent_start":
          eventLog.append("started", { phase: spec.phase });
          break;
        case "agent_end":
          eventLog.append("finished", { phase: spec.phase });
          break;
      }
    });

    const abortFromParent = (): void => agent.abort();
    spec.signal?.addEventListener("abort", abortFromParent, { once: true });
    const deadline = spec.deadlineMs === undefined
      ? undefined
      : setTimeout(() => {
        deadlineExceeded = true;
        agent.abort();
      }, spec.deadlineMs);

    try {
      await agent.prompt(spec.prompt);
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      spec.signal?.removeEventListener("abort", abortFromParent);
      unsubscribe();
    }

    const messages = [...agent.state.messages];
    const lastAssistant = messages.findLast(assistant);
    if (lastAssistant?.stopReason === "error") {
      throw new ModelProviderError(
        `model provider error: ${lastAssistant.errorMessage ?? "unknown provider failure"}`,
      );
    }
    return {
      modelCalls,
      toolNames,
      toolErrors,
      usage,
      durationMs: performance.now() - startedAt,
      stopReason: deadlineExceeded
        ? "aborted"
        : (lastAssistant?.stopReason ?? "stop"),
      messages,
      deadlineExceeded,
      turnLimitReached,
    };
  }
}

function thinkingLevel(value: string): ThinkingLevel {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return "high";
}

export function createDeepSeekModel(
  config: PilotModelConfig,
): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    provider: "translator-v5-deepseek",
    api: "openai-completions",
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 37_200,
    thinkingLevelMap: {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: thinkingLevel(config.reasoningEffort),
      xhigh: "xhigh",
    },
    compat: {
      thinkingFormat: "deepseek",
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
      supportsStrictMode: true,
    },
  };
}

export function createDeepSeekStreamFn(config: PilotModelConfig): StreamFn {
  const api = openAICompletionsApi();
  return (model, context, options) => api.streamSimple(model, context, {
    ...options,
    apiKey: config.apiKeyForRuntime(),
    timeoutMs: config.timeoutMs,
    maxTokens: Math.min(model.maxTokens, 37_200),
    reasoning: thinkingLevel(config.reasoningEffort),
  });
}
