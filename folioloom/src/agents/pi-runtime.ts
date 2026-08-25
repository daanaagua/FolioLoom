import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  isContextOverflow,
  type Model,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";

import type { PilotModelConfig } from "../config.js";
import type { AgentPhase } from "../domain/types.js";
import { BudgetLedger, type BudgetCounter } from "../kernel/budget.js";
import { CapabilityRegistry } from "../kernel/capabilities.js";
import { MemoryEventLog } from "../kernel/event-log.js";
import { createProviderRuntime } from "../providers/runtime.js";
import type { ModelProfile, ProviderEffort } from "../providers/types.js";
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
  onAssistantResponse?: (
    observation: PiAssistantResponseObservation,
  ) => void | Promise<void>;
}

export interface PiAssistantResponseObservation {
  readonly phase: AgentPhase;
  readonly modelCallOrdinal: number;
  readonly requestHash: string;
  readonly assistantMessage: AssistantMessage;
}

export interface PiToolError {
  toolName: string;
  message: string;
}

export type ModelProviderErrorKind =
  | "auth"
  | "quota"
  | "throttled"
  | "timeout"
  | "busy"
  | "context"
  | "protocol"
  | "unknown";

export class ModelProviderError extends Error {
  override readonly name = "ModelProviderError";

  public constructor(
    message: string,
    public readonly kind: ModelProviderErrorKind = classifyProviderErrorMessage(message),
    public readonly retryable: boolean = retryableProviderErrorKind(kind),
    public run?: PiRunResult,
  ) {
    super(message);
  }

  get code(): `PROVIDER_${Uppercase<ModelProviderErrorKind>}` {
    return `PROVIDER_${this.kind.toUpperCase() as Uppercase<ModelProviderErrorKind>}`;
  }

  /**
   * Preserve provider usage even when a higher protocol layer rejects the
   * response after the model call has completed.
   */
  withRun(run: PiRunResult): this {
    this.run ??= run;
    return this;
  }
}

function retryableProviderErrorKind(kind: ModelProviderErrorKind): boolean {
  return kind === "throttled" || kind === "timeout" || kind === "busy";
}

export function classifyProviderErrorMessage(message: string): ModelProviderErrorKind {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  if (/(?:insufficient[_ -]?quota|quota exceeded|billing|out of budget|usage limit|credit balance)/u
    .test(normalized)) {
    return "quota";
  }
  if (/(?:\b40[13]\b|unauthori[sz]ed|forbidden|authentication failed|invalid[^\n]{0,32}(?:api[ _-]?key|credential)|no api[ _-]?key|permission denied)/u
    .test(normalized)) {
    return "auth";
  }
  if (/(?:\b429\b|rate[ _-]?limit|too many requests|throttl|resourceexhausted)/u
    .test(normalized)) {
    return "throttled";
  }
  if (/(?:timed? out|timeout|deadline exceeded|etimedout)/u.test(normalized)) {
    return "timeout";
  }
  if (/(?:malformed|invalid|unterminated)[^\n]{0,48}(?:tool[ _-]?call|json|schema|stream)|(?:tool[ _-]?call)[^\n]{0,32}(?:malformed|invalid)|protocol error/u
    .test(normalized)) {
    return "protocol";
  }
  if (normalized.trim() === "terminated"
    || /(?:\b5(?:00|02|03|04|24)\b|overload|service unavailable|server error|internal error|network error|connection (?:error|refused|lost)|fetch failed|socket hang up|upstream connect)/u
    .test(normalized)) {
    return "busy";
  }
  return "unknown";
}

function classifyProviderAssistantError(message: AssistantMessage): ModelProviderErrorKind {
  if (isContextOverflow(message)) {
    return "context";
  }
  return classifyProviderErrorMessage(message.errorMessage ?? "unknown provider failure");
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
    let turnStarts = 0;
    let deadlineExceeded = false;
    let turnLimitReached = false;
    const assistantResponses: Array<{
      readonly modelCallOrdinal: number;
      readonly message: AssistantMessage;
    }> = [];
    const requestHash = createHash("sha256")
      .update(spec.phase, "utf8")
      .update("\0")
      .update(spec.model.provider, "utf8")
      .update("\0")
      .update(spec.model.id, "utf8")
      .update("\0")
      .update(spec.systemPrompt, "utf8")
      .update("\0")
      .update(spec.prompt, "utf8")
      .digest("hex");

    const boundedStreamFn: StreamFn = (model, context, options) => {
      if (!turnLimitReached) {
        return streamFn(model, context, options);
      }
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: structuredClone(ZERO_USAGE),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: spec.systemPrompt,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel ?? "high",
        tools: toAgentTools(spec.tools),
        messages: [],
      },
      streamFn: boundedStreamFn,
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
          turnStarts += 1;
          if (spec.maxTurns !== undefined && turnStarts > spec.maxTurns) {
            turnLimitReached = true;
            break;
          }
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
            assistantResponses.push({
              // Agent event delivery can start the next turn before publishing
              // the preceding turn_end.  The response list itself is ordered,
              // so derive evidence ordinals from accepted responses instead of
              // sampling the mutable turn_start counter.
              modelCallOrdinal: assistantResponses.length + 1,
              message: event.message,
            });
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
    const result: PiRunResult = {
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
    if (spec.onAssistantResponse !== undefined) {
      try {
        for (const response of assistantResponses) {
          await spec.onAssistantResponse({
            phase: spec.phase,
            modelCallOrdinal: response.modelCallOrdinal,
            requestHash,
            assistantMessage: response.message,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ModelProviderError(
          `provider evidence persistence failed: ${message}`,
          "unknown",
          false,
        ).withRun(result);
      }
    }
    if (lastAssistant?.stopReason === "error") {
      const providerMessage = lastAssistant.errorMessage ?? "unknown provider failure";
      throw new ModelProviderError(
        `model provider error: ${providerMessage}`,
        classifyProviderAssistantError(lastAssistant),
      ).withRun(result);
    }
    return result;
  }
}

function deepSeekProfile(config: PilotModelConfig): ModelProfile {
  return {
    providerId: "deepseek",
    modelId: config.model,
    reasoningEffort: config.reasoningEffort as ProviderEffort,
  };
}

function deepSeekRuntime(config: PilotModelConfig) {
  return createProviderRuntime(
    deepSeekProfile(config),
    config.apiKeyForRuntime(),
    {
      trustedBaseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    },
  );
}

export function createDeepSeekModel(
  config: PilotModelConfig,
): Model<"openai-completions"> {
  const runtime = deepSeekRuntime(config);
  if (runtime.model.api !== "openai-completions") {
    throw new TypeError("DeepSeek must use the OpenAI chat-completions runtime");
  }
  return runtime.model as Model<"openai-completions">;
}

export function createDeepSeekStreamFn(config: PilotModelConfig): StreamFn {
  return deepSeekRuntime(config).streamFn;
}
