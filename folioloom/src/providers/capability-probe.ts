import { ProviderRegistry, providerRegistry } from "./registry.js";
import { providerWirePolicy, type ProviderWirePolicy } from "./wire-policy.js";
import type {
  CapabilityCheck,
  CapabilityCheckId,
  CapabilityReport,
  FetchLike,
  ModelProfile,
  ProviderProbeErrorCode,
  ResolvedProviderProfile,
  SecretCredential,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PROBE_RETRY_MAX_OUTPUT_TOKENS = 2_048;
const CHECK_IDS: readonly CapabilityCheckId[] = [
  "stream",
  "tool_call",
  "tool_round_trip",
  "reasoning_continuity",
  "effort",
];
const PROBE_TOKEN = "FOLIOLOOM_PROBE";
const READY_TOKEN = "FOLIOLOOM_READY";
const PROBE_TOOL_NAME = "return_probe_token";

export interface ProviderCapabilityProbeRequest {
  profile: ModelProfile;
  credential: SecretCredential;
  registry?: ProviderRegistry;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamResult {
  text: string;
  reasoning: string;
  responseId?: string;
  finishReason?: string;
  toolCalls: readonly ToolCall[];
}

class ProbeFailure extends Error {
  constructor(
    readonly code: ProviderProbeErrorCode,
    message: string,
    readonly technicalDetails?: string,
  ) {
    super(message);
    this.name = "ProbeFailure";
  }
}

function check(id: CapabilityCheckId, status: CapabilityCheck["status"], message: string): CapabilityCheck {
  return { id, status, message };
}

function initialChecks(): Map<CapabilityCheckId, CapabilityCheck> {
  return new Map(CHECK_IDS.map((id) => [id, check(id, "skipped", "not reached")]));
}

function orderedChecks(checks: ReadonlyMap<CapabilityCheckId, CapabilityCheck>): readonly CapabilityCheck[] {
  return CHECK_IDS.map((id) => checks.get(id) ?? check(id, "skipped", "not reached"));
}

function baseUrl(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function endpoint(resolved: ResolvedProviderProfile): string {
  const suffix = resolved.definition.apiFamily === "openai-responses" ? "/responses" : "/chat/completions";
  return `${baseUrl(resolved.baseUrl)}${suffix}`;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(value: string, credential: SecretCredential): string {
  let safe = value;
  if (credential.length > 0) {
    safe = safe.replace(new RegExp(escapedRegExp(credential), "g"), "[REDACTED]");
  }
  return safe
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|rk|pk|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function timeoutMs(value: number | undefined): number {
  const effective = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(effective) || effective <= 0 || effective > DEFAULT_TIMEOUT_MS) {
    throw new TypeError(`capability probe timeout must be a positive number no greater than ${DEFAULT_TIMEOUT_MS}`);
  }
  return effective;
}

function remainingTimeoutMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ProbeFailure("REQUEST_TIMEOUT", "The provider did not respond before the probe timeout.");
  }
  return remaining;
}

function providerFailure(status: number, raw: string, credential: SecretCredential): ProbeFailure {
  const details = redact(`HTTP ${status}: ${raw.slice(0, 1_000)}`, credential);
  if (status === 401 || status === 403) {
    return new ProbeFailure("AUTH_INVALID", "The provider rejected this API credential.", details);
  }
  if (status === 404) {
    return new ProbeFailure("MODEL_NOT_FOUND", "The provider could not find the selected model or endpoint.", details);
  }
  if (status === 429 && /(quota|credit|balance|insufficient)/i.test(raw)) {
    return new ProbeFailure("QUOTA_EXHAUSTED", "The provider reports that this account has no available quota.", details);
  }
  if (status === 429) {
    return new ProbeFailure("RATE_LIMITED", "The provider is rate limiting this request.", details);
  }
  if (status === 503 || status === 502 || status === 504) {
    return new ProbeFailure("PROVIDER_BUSY", "The provider is temporarily unavailable.", details);
  }
  return new ProbeFailure("PROVIDER_REQUEST_REJECTED", "The provider rejected the compatibility probe.", details);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolCallAt(calls: Map<number, ToolCall>, index: number): ToolCall {
  const current = calls.get(index);
  if (current !== undefined) {
    return current;
  }
  const created: ToolCall = { id: "", name: "", arguments: "" };
  calls.set(index, created);
  return created;
}

function consumeChatEvent(value: unknown, result: {
  text: string;
  reasoning: string;
  calls: Map<number, ToolCall>;
  finishReason?: string;
}): void {
  const event = asRecord(value);
  const firstChoice = event !== undefined && Array.isArray(event.choices) ? asRecord(event.choices[0]) : undefined;
  result.finishReason = asString(firstChoice?.finish_reason) ?? result.finishReason;
  const delta = firstChoice === undefined ? undefined : asRecord(firstChoice.delta);
  if (delta === undefined) {
    return;
  }
  result.text += asString(delta.content) ?? "";
  result.reasoning += asString(delta.reasoning_content) ?? asString(delta.reasoning) ?? "";
  if (!Array.isArray(delta.tool_calls)) {
    return;
  }
  for (const rawCall of delta.tool_calls) {
    const call = asRecord(rawCall);
    if (call === undefined) {
      continue;
    }
    const index = typeof call.index === "number" && Number.isInteger(call.index) ? call.index : 0;
    const target = toolCallAt(result.calls, index);
    target.id ||= asString(call.id) ?? "";
    const fn = asRecord(call.function);
    if (fn !== undefined) {
      target.name ||= asString(fn.name) ?? "";
      target.arguments += asString(fn.arguments) ?? "";
    }
  }
}

function consumeResponsesEvent(value: unknown, result: {
  text: string;
  reasoning: string;
  calls: Map<string, ToolCall>;
  finishReason?: string;
}): void {
  const event = asRecord(value);
  if (event === undefined) {
    return;
  }
  const type = asString(event.type);
  if (type === "response.output_text.delta") {
    result.text += asString(event.delta) ?? "";
    return;
  }
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    result.reasoning += asString(event.delta) ?? "";
    return;
  }
  if (type === "response.output_item.added") {
    const item = asRecord(event.item);
    if (item?.type !== "function_call") {
      return;
    }
    const itemId = asString(item.id) ?? asString(item.call_id);
    if (itemId === undefined) {
      return;
    }
    result.calls.set(itemId, {
      id: asString(item.call_id) ?? itemId,
      name: asString(item.name) ?? "",
      arguments: "",
    });
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const itemId = asString(event.item_id) ?? asString(event.call_id);
    if (itemId === undefined) {
      return;
    }
    const target = result.calls.get(itemId) ?? { id: itemId, name: "", arguments: "" };
    target.arguments += asString(event.delta) ?? "";
    result.calls.set(itemId, target);
    return;
  }
  if (type === "response.completed") {
    const response = asRecord(event.response);
    if (response?.status === "incomplete" && asRecord(response.incomplete_details)?.reason === "max_output_tokens") {
      result.finishReason = "length";
    }
  }
}

async function streamSse(
  response: Response,
  consume: (value: unknown) => void,
  credential: SecretCredential,
): Promise<void> {
  if (response.body === null) {
    throw new ProbeFailure("PROVIDER_PROTOCOL_INVALID", "The provider returned no streaming response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;
  const consumeFrame = (frame: string): void => {
    const payload = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (payload.length === 0 || payload === "[DONE]") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ProbeFailure(
        "PROVIDER_PROTOCOL_INVALID",
        "The provider sent malformed JSON in its streaming response.",
        redact(payload.slice(0, 500), credential),
      );
    }
    eventCount += 1;
    consume(parsed);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator: RegExpMatchArray | null;
      while ((separator = buffer.match(/\r?\n\r?\n/)) !== null && separator.index !== undefined) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        consumeFrame(frame);
      }
      if (done) {
        break;
      }
    }
    if (buffer.trim().length > 0) {
      consumeFrame(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (eventCount === 0) {
    throw new ProbeFailure("PROVIDER_PROTOCOL_INVALID", "The provider sent no structured streaming events.");
  }
}

async function postStream(
  url: string,
  body: Record<string, unknown>,
  credential: SecretCredential,
  fetcher: FetchLike,
  timeout: number,
  consume: (value: unknown) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProbeFailure("REQUEST_TIMEOUT", "The provider did not respond before the probe timeout.");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ProbeFailure("PROVIDER_UNREACHABLE", "FolioLoom could not reach the provider.", redact(message, credential));
    }
    if (!response.ok) {
      throw providerFailure(response.status, await response.text(), credential);
    }
    await streamSse(response, consume, credential);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ProbeFailure)) {
      throw new ProbeFailure("REQUEST_TIMEOUT", "The provider did not respond before the probe timeout.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function firstChatRequest(
  resolved: ResolvedProviderProfile,
  policy: ProviderWirePolicy,
  outputTokens: number,
): Record<string, unknown> {
  const effort = resolved.profile.reasoningEffort;
  const body: Record<string, unknown> = {
    model: resolved.profile.modelId,
    stream: true,
    messages: [{ role: "user", content: `Call ${PROBE_TOOL_NAME} with token ${PROBE_TOKEN}.` }],
    tools: [{
      type: "function",
      function: {
        name: PROBE_TOOL_NAME,
        description: "Returns the supplied probe token.",
        parameters: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
          additionalProperties: false,
        },
      },
    }],
  };
  body[policy.outputTokenField] = outputTokens;
  Object.assign(body, policy.serializeThinking(effort));
  return body;
}

function secondChatRequest(
  resolved: ResolvedProviderProfile,
  policy: ProviderWirePolicy,
  first: StreamResult,
  toolCall: ToolCall,
  outputTokens: number,
): Record<string, unknown> {
  const firstRequest = firstChatRequest(resolved, policy, outputTokens);
  const messages = firstRequest.messages as Array<Record<string, unknown>>;
  messages.push(policy.serializeAssistantContinuation({
    text: first.text,
    reasoning: first.reasoning,
    toolCall,
  }, resolved.profile.reasoningEffort));
  messages.push({ role: "tool", tool_call_id: toolCall.id, content: PROBE_TOKEN });
  messages.push({ role: "user", content: `Reply only ${READY_TOKEN}.` });
  return firstRequest;
}

function firstResponsesRequest(
  resolved: ResolvedProviderProfile,
  policy: ProviderWirePolicy,
  outputTokens: number,
): Record<string, unknown> {
  const effort = resolved.profile.reasoningEffort;
  const body: Record<string, unknown> = {
    model: resolved.profile.modelId,
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: `Call ${PROBE_TOOL_NAME} with token ${PROBE_TOKEN}.` }] }],
    tools: [{
      type: "function",
      name: PROBE_TOOL_NAME,
      description: "Returns the supplied probe token.",
      parameters: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
      strict: true,
    }],
  };
  body[policy.outputTokenField] = outputTokens;
  Object.assign(body, policy.serializeThinking(effort));
  return body;
}

function secondResponsesRequest(
  resolved: ResolvedProviderProfile,
  policy: ProviderWirePolicy,
  first: StreamResult,
  toolCall: ToolCall,
  outputTokens: number,
): Record<string, unknown> {
  return {
    ...firstResponsesRequest(resolved, policy, outputTokens),
    ...(first.responseId === undefined ? {} : { previous_response_id: first.responseId }),
    instructions: `Reply only ${READY_TOKEN}.`,
    input: [{ type: "function_call_output", call_id: toolCall.id, output: PROBE_TOKEN }],
  };
}

function validatedToolCall(calls: readonly ToolCall[]): ToolCall | undefined {
  const call = calls.find((candidate) => candidate.name === PROBE_TOOL_NAME && candidate.id.length > 0);
  if (call === undefined) {
    return undefined;
  }
  try {
    const parameters = JSON.parse(call.arguments) as { token?: unknown };
    return parameters.token === PROBE_TOKEN ? call : undefined;
  } catch {
    return undefined;
  }
}

function failedReport(
  checks: Map<CapabilityCheckId, CapabilityCheck>,
  failure: ProbeFailure,
): CapabilityReport {
  if (checks.get("stream")?.status !== "passed") {
    checks.set("stream", check("stream", "failed", failure.message));
  }
  return {
    status: "failed",
    checks: orderedChecks(checks),
    code: failure.code,
    message: failure.message,
    ...(failure.technicalDetails === undefined ? {} : { technicalDetails: failure.technicalDetails }),
  };
}

function isReasoningFailure(failure: ProbeFailure): boolean {
  return failure.code === "PROVIDER_REQUEST_REJECTED" && /reasoning|thinking/i.test(failure.technicalDetails ?? failure.message);
}

function isOutputTruncated(result: Pick<StreamResult, "finishReason">): boolean {
  return result.finishReason === "length";
}

async function withTruncationRetry<T extends Pick<StreamResult, "finishReason">>(
  initialOutputTokens: number,
  attempt: (outputTokens: number) => Promise<T>,
): Promise<T> {
  const first = await attempt(initialOutputTokens);
  if (!isOutputTruncated(first)) {
    return first;
  }
  const retry = await attempt(PROBE_RETRY_MAX_OUTPUT_TOKENS);
  if (isOutputTruncated(retry)) {
    throw new ProbeFailure(
      "PROBE_OUTPUT_TRUNCATED",
      "The provider repeatedly ended the compatibility probe because the output limit was reached.",
    );
  }
  return retry;
}

export async function probeProviderCapabilities(request: ProviderCapabilityProbeRequest): Promise<CapabilityReport> {
  const registry = request.registry ?? providerRegistry;
  const resolved = registry.resolve(request.profile);
  const policy = providerWirePolicy(resolved);
  const checks = initialChecks();
  const fetcher = request.fetch ?? globalThis.fetch;
  const timeout = timeoutMs(request.timeoutMs);
  const deadline = Date.now() + timeout;
  const isResponses = policy.apiFamily === "openai-responses";
  const effort = resolved.profile.reasoningEffort;
  const initialOutputTokens = policy.initialProbeTokens(effort);
  const firstAttempt = async (outputTokens: number): Promise<StreamResult> => {
    if (isResponses) {
      const collector = {
        text: "",
        reasoning: "",
        calls: new Map<string, ToolCall>(),
        finishReason: undefined as string | undefined,
      };
      const result: StreamResult = { text: "", reasoning: "", toolCalls: [] };
      await postStream(
        endpoint(resolved),
        firstResponsesRequest(resolved, policy, outputTokens),
        request.credential,
        fetcher,
        remainingTimeoutMs(deadline),
        (event) => {
          consumeResponsesEvent(event, collector);
          const payload = asRecord(event);
          if (payload?.type === "response.completed") {
            result.responseId = asString(asRecord(payload.response)?.id);
          }
        },
      );
      return {
        text: collector.text,
        reasoning: collector.reasoning,
        responseId: result.responseId,
        finishReason: collector.finishReason,
        toolCalls: [...collector.calls.values()],
      };
    }
    const collector = {
      text: "",
      reasoning: "",
      calls: new Map<number, ToolCall>(),
      finishReason: undefined as string | undefined,
    };
    await postStream(
      endpoint(resolved),
      firstChatRequest(resolved, policy, outputTokens),
      request.credential,
      fetcher,
      remainingTimeoutMs(deadline),
      (event) => consumeChatEvent(event, collector),
    );
    return {
      text: collector.text,
      reasoning: collector.reasoning,
      finishReason: collector.finishReason,
      toolCalls: [...collector.calls.values()],
    };
  };
  let first: StreamResult;
  try {
    first = await withTruncationRetry(initialOutputTokens, firstAttempt);
  } catch (error) {
    return failedReport(checks, error instanceof ProbeFailure
      ? error
      : new ProbeFailure("PROVIDER_PROTOCOL_INVALID", "The provider probe failed unexpectedly."));
  }

  checks.set("stream", check("stream", "passed", "Received a structured streaming response."));
  checks.set("effort", effort === undefined || effort === "off"
    ? check("effort", "skipped", "No reasoning effort was requested.")
    : check("effort", "passed", `Accepted the requested ${effort} reasoning effort.`));

  const toolCall = validatedToolCall(first.toolCalls);
  if (toolCall === undefined) {
    checks.set("tool_call", check("tool_call", "failed", "The provider did not return the requested structured tool call."));
    return {
      status: "limited",
      checks: orderedChecks(checks),
      code: "TOOL_CALL_UNSUPPORTED",
      message: "Streaming works, but structured tool calls are unavailable or malformed.",
    };
  }
  checks.set("tool_call", check("tool_call", "passed", "Received and reconstructed a fragmented tool call."));

  const secondAttempt = async (outputTokens: number): Promise<StreamResult> => {
    if (isResponses) {
      const collector = {
        text: "",
        reasoning: "",
        calls: new Map<string, ToolCall>(),
        finishReason: undefined as string | undefined,
      };
      await postStream(
        endpoint(resolved),
        secondResponsesRequest(resolved, policy, first, toolCall, outputTokens),
        request.credential,
        fetcher,
        remainingTimeoutMs(deadline),
        (event) => consumeResponsesEvent(event, collector),
      );
      return {
        text: collector.text,
        reasoning: collector.reasoning,
        finishReason: collector.finishReason,
        toolCalls: [...collector.calls.values()],
      };
    }
    const collector = {
      text: "",
      reasoning: "",
      calls: new Map<number, ToolCall>(),
      finishReason: undefined as string | undefined,
    };
    await postStream(
      endpoint(resolved),
      secondChatRequest(resolved, policy, first, toolCall, outputTokens),
      request.credential,
      fetcher,
      remainingTimeoutMs(deadline),
      (event) => consumeChatEvent(event, collector),
    );
    return {
      text: collector.text,
      reasoning: collector.reasoning,
      finishReason: collector.finishReason,
      toolCalls: [...collector.calls.values()],
    };
  };
  let second: StreamResult;
  try {
    second = await withTruncationRetry(initialOutputTokens, secondAttempt);
  } catch (error) {
    const failure = error instanceof ProbeFailure
      ? error
      : new ProbeFailure("PROVIDER_PROTOCOL_INVALID", "The second tool-call turn failed unexpectedly.");
    checks.set("tool_round_trip", check("tool_round_trip", "failed", failure.message));
    if (policy.requiresReasoningReplay(effort) && isReasoningFailure(failure)) {
      checks.set("reasoning_continuity", check("reasoning_continuity", "failed", "The provider rejected preserved reasoning on the second turn."));
      return {
        status: "limited",
        checks: orderedChecks(checks),
        code: "REASONING_CONTINUITY_UNSUPPORTED",
        message: "Tool calls work, but the provider rejected reasoning continuity on the second turn.",
        ...(failure.technicalDetails === undefined ? {} : { technicalDetails: failure.technicalDetails }),
      };
    }
    return failedReport(checks, failure);
  }

  if (!second.text.includes(READY_TOKEN)) {
    checks.set("tool_round_trip", check("tool_round_trip", "failed", "The provider did not complete the second tool-call turn."));
    return {
      status: "limited",
      checks: orderedChecks(checks),
      code: "TOOL_CALL_UNSUPPORTED",
      message: "The provider produced a tool call but did not complete the tool round trip.",
    };
  }
  checks.set("tool_round_trip", check("tool_round_trip", "passed", "Completed a second turn after the tool result."));
  if (policy.requiresReasoningReplay(effort) && first.reasoning.length === 0) {
    checks.set("reasoning_continuity", check("reasoning_continuity", "failed", "The provider omitted reasoning needed for a compatible second turn."));
    return {
      status: "limited",
      checks: orderedChecks(checks),
      code: "REASONING_CONTINUITY_UNSUPPORTED",
      message: "Tool calls work, but the provider did not preserve reasoning for the second turn.",
    };
  }
  checks.set("reasoning_continuity", policy.requiresReasoningReplay(effort)
    ? check("reasoning_continuity", "passed", "Preserved reasoning context through the second turn.")
    : check("reasoning_continuity", "skipped", "This provider does not require serialized reasoning continuity."));
  return {
    status: "ready",
    checks: orderedChecks(checks),
    message: "The provider completed the compatibility probe.",
  };
}

/** Backwards-compatible concise name used by desktop model services. */
export const probeProvider = probeProviderCapabilities;
