import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { probeProviderCapabilities } from "../src/providers/capability-probe.js";
import { PROVIDER_PRESETS } from "../src/providers/presets.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ModelProfile, ProviderId } from "../src/providers/types.js";

type FakeMode =
  | "ready"
  | "plain-text"
  | "reject-continuity"
  | "invalid-json"
  | "timeout"
  | "truncated-once"
  | "truncated-always"
  | "second-truncated-once"
  | "second-truncated-always"
  | "off-omits-reasoning";

interface FakeProviderOptions {
  mode?: FakeMode;
  status?: number;
  errorMessage?: string;
}

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

interface FakeProvider {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sse(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function chatToolEvents(includeReasoning = true): readonly unknown[] {
  return [
    {
      choices: [{
        delta: {
          ...(includeReasoning ? { reasoning_content: "preserve this reasoning across the second turn" } : {}),
          tool_calls: [{
            index: 0,
            id: "call-probe",
            type: "function",
            function: { name: "return_probe_token", arguments: '{"token":"FOLIO' },
          }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: 'LOOM_PROBE"}' },
          }],
        },
      }],
    },
  ];
}

function truncatedChatToolEvents(): readonly unknown[] {
  return [{
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-probe",
          type: "function",
          function: { name: "return_probe_token", arguments: '{"token":"FOLIO' },
        }],
      },
      finish_reason: "length",
    }],
  }];
}

function truncatedChatReadyEvents(): readonly unknown[] {
  return [{
    choices: [{
      delta: { content: "FOLIOLOOM_REA" },
      finish_reason: "length",
    }],
  }];
}

function responsesToolEvents(): readonly unknown[] {
  return [
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "item-probe", call_id: "call-probe", name: "return_probe_token" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item-probe",
      delta: '{"token":"FOLIO',
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item-probe",
      delta: 'LOOM_PROBE"}',
    },
    { type: "response.completed", response: { id: "response-probe" } },
  ];
}

function isSecondChatTurn(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) && body.messages.some((message) =>
    typeof message === "object" && message !== null && (message as { role?: unknown }).role === "tool",
  );
}

function isSecondResponsesTurn(body: Record<string, unknown>): boolean {
  return Array.isArray(body.input) && body.input.some((item) =>
    typeof item === "object" && item !== null && (item as { type?: unknown }).type === "function_call_output",
  );
}

async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const requests: CapturedRequest[] = [];
  let firstTurnCount = 0;
  let secondTurnCount = 0;
  const server: Server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    const path = request.url ?? "/";
    requests.push({ path, body });

    if (options.status !== undefined) {
      response.writeHead(options.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: options.errorMessage ?? `fixture status ${options.status}` } }));
      return;
    }
    if (options.mode === "timeout") {
      const timer = setTimeout(() => response.end("too late"), 1_000);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    if (options.mode === "invalid-json") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: {this is not JSON}\n\ndata: [DONE]\n\n");
      return;
    }

    const responses = path.endsWith("/responses");
    const secondTurn = responses ? isSecondResponsesTurn(body) : isSecondChatTurn(body);
    if (options.mode === "reject-continuity" && secondTurn) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "reasoning content rejected by fixture" } }));
      return;
    }
    if (secondTurn) {
      if (options.mode === "second-truncated-always"
        || (options.mode === "second-truncated-once" && secondTurnCount++ === 0)) {
        sse(response, responses
          ? [{ type: "response.output_text.delta", delta: "FOLIOLOOM_REA" }, {
            type: "response.completed",
            response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
          }]
          : truncatedChatReadyEvents());
        return;
      }
      sse(response, responses
        ? [{ type: "response.output_text.delta", delta: "FOLIOLOOM_READY" }, { type: "response.completed" }]
        : [{ choices: [{ delta: { content: "FOLIOLOOM_READY" } }] }]);
      return;
    }
    if (options.mode === "truncated-always" || (options.mode === "truncated-once" && firstTurnCount++ === 0)) {
      sse(response, responses ? responsesToolEvents() : truncatedChatToolEvents());
      return;
    }
    if (options.mode === "plain-text") {
      sse(response, responses
        ? [{ type: "response.output_text.delta", delta: "plain text only" }, { type: "response.completed" }]
        : [{ choices: [{ delta: { content: "plain text only" } }] }]);
      return;
    }
    sse(response, responses ? responsesToolEvents() : chatToolEvents(options.mode !== "off-omits-reasoning"));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

function localRegistry(providerId: ProviderId, baseUrl: string): ProviderRegistry {
  return new ProviderRegistry(PROVIDER_PRESETS.map((definition) => definition.id === providerId
    ? { ...definition, defaultBaseUrl: baseUrl }
    : definition));
}

async function probe(
  providerId: ProviderId,
  provider: FakeProvider,
  reasoningEffort: ModelProfile["reasoningEffort"] = "max",
  timeoutMs?: number,
) {
  return probeProviderCapabilities({
    registry: localRegistry(providerId, provider.baseUrl),
    profile: {
      providerId,
      modelId: providerId === "deepseek" ? "deepseek-v4-flash" : "fixture-model",
      reasoningEffort,
    },
    credential: "probe-fixture-secret",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

test("capability probe verifies a local chat provider stream, fragmented tool call, second turn, continuity, and max effort", async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "ready");
  assert.deepEqual(report.checks.map((check) => check.id), [
    "stream",
    "tool_call",
    "tool_round_trip",
    "reasoning_continuity",
    "effort",
  ]);
  assert.equal(report.checks.every((check) => check.status === "passed"), true);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0]?.body.reasoning_effort, "max");
  assert.equal(provider.requests[0]?.body.max_completion_tokens, 512);
  assert.equal(provider.requests[1]?.body.messages instanceof Array, true);
  const messages = provider.requests[1]?.body.messages as Array<Record<string, unknown>>;
  const assistant = messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.reasoning_content, "preserve this reasoning across the second turn");
  assert.equal(messages.some((message) => message.content === "Reply only FOLIOLOOM_READY."), true);
});

test("a length-truncated tool call is retried once instead of reported unsupported", async (t) => {
  const provider = await startFakeProvider({ mode: "truncated-once" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "ready");
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.requests[0]?.body.max_completion_tokens, 512);
  assert.equal(provider.requests[1]?.body.max_completion_tokens, 2048);
});

test("two length terminations return PROBE_OUTPUT_TRUNCATED", async (t) => {
  const provider = await startFakeProvider({ mode: "truncated-always" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "failed");
  assert.equal(report.code, "PROBE_OUTPUT_TRUNCATED");
  assert.equal(provider.requests.length, 2);
});

test("a length-truncated second tool turn retries once with the bounded output budget", async (t) => {
  const provider = await startFakeProvider({ mode: "second-truncated-once" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "ready");
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.requests[0]?.body.max_completion_tokens, 512);
  assert.equal(provider.requests[1]?.body.max_completion_tokens, 512);
  assert.equal(provider.requests[2]?.body.max_completion_tokens, 2048);
});

test("two length-truncated second tool turns return PROBE_OUTPUT_TRUNCATED rather than tool-call unsupported", async (t) => {
  const provider = await startFakeProvider({ mode: "second-truncated-always" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "failed");
  assert.equal(report.code, "PROBE_OUTPUT_TRUNCATED");
  assert.equal(provider.requests.length, 3);
});

test("DeepSeek off skips reasoning continuity and remains ready", async (t) => {
  const provider = await startFakeProvider({ mode: "off-omits-reasoning" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider, "off");

  assert.equal(report.status, "ready");
  assert.equal(report.checks.find((check) => check.id === "reasoning_continuity")?.status, "skipped");
  const messages = provider.requests[1]?.body.messages as Array<Record<string, unknown>>;
  const assistant = messages.find((message) => message.role === "assistant");
  assert.equal(Object.hasOwn(assistant ?? {}, "reasoning_content"), false);
});

test("capability probe reports a missing tool call as limited", async (t) => {
  const provider = await startFakeProvider({ mode: "plain-text" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "limited");
  assert.equal(report.code, "TOOL_CALL_UNSUPPORTED");
  assert.equal(report.checks.find((check) => check.id === "tool_call")?.status, "failed");
});

test("capability probe reports rejected reasoning continuity as limited", async (t) => {
  const provider = await startFakeProvider({ mode: "reject-continuity" });
  t.after(() => provider.close());

  const report = await probe("deepseek", provider);

  assert.equal(report.status, "limited");
  assert.equal(report.code, "REASONING_CONTINUITY_UNSUPPORTED");
  assert.equal(report.checks.find((check) => check.id === "reasoning_continuity")?.status, "failed");
});

test("capability probe normalizes provider failures without leaking the credential", async (t) => {
  const cases = [
    { status: 401, message: "invalid key", code: "AUTH_INVALID" },
    { status: 404, message: "model missing", code: "MODEL_NOT_FOUND" },
    { status: 429, message: "quota exhausted", code: "QUOTA_EXHAUSTED" },
    { status: 429, message: "too many requests", code: "RATE_LIMITED" },
    { status: 503, message: "provider busy", code: "PROVIDER_BUSY" },
  ] as const;

  for (const fixture of cases) {
    const provider = await startFakeProvider({
      status: fixture.status,
      errorMessage: `${fixture.message} probe-fixture-secret Bearer bearer-secret https://example.invalid/v1?api_key=query-secret sk-123456789`,
    });
    t.after(() => provider.close());
    const report = await probe("deepseek", provider);
    assert.equal(report.status, "failed");
    assert.equal(report.code, fixture.code);
    assert.equal(report.technicalDetails?.includes("probe-fixture-secret"), false);
    assert.equal(report.technicalDetails?.includes("bearer-secret"), false);
    assert.equal(report.technicalDetails?.includes("query-secret"), false);
    assert.equal(report.technicalDetails?.includes("sk-123456789"), false);
  }
});

test("capability probe reports timeout and malformed stream payloads", async (t) => {
  const timeoutProvider = await startFakeProvider({ mode: "timeout" });
  t.after(() => timeoutProvider.close());
  const timeout = await probe("deepseek", timeoutProvider, "max", 20);
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.code, "REQUEST_TIMEOUT");

  const malformedProvider = await startFakeProvider({ mode: "invalid-json" });
  t.after(() => malformedProvider.close());
  const malformed = await probe("deepseek", malformedProvider);
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.code, "PROVIDER_PROTOCOL_INVALID");
});

test("capability probe uses the local OpenAI Responses shape when that family is selected", async (t) => {
  const provider = await startFakeProvider();
  t.after(() => provider.close());

  const report = await probe("openai", provider, "high");

  assert.equal(report.status, "ready");
  assert.equal(provider.requests[0]?.path.endsWith("/responses"), true);
  assert.equal(provider.requests[0]?.body.max_output_tokens, 512);
  assert.equal(provider.requests[1]?.body.input instanceof Array, true);
  assert.equal(provider.requests[1]?.body.instructions, "Reply only FOLIOLOOM_READY.");
});

test("capability probe sends Bailian's Qwen reasoning control as an on/off toggle", async (t) => {
  const enabledProvider = await startFakeProvider();
  const disabledProvider = await startFakeProvider();
  t.after(() => enabledProvider.close());
  t.after(() => disabledProvider.close());

  const enabled = await probe("bailian", enabledProvider, "on");
  const disabled = await probe("bailian", disabledProvider, "off");

  assert.equal(enabled.status, "ready");
  assert.equal(disabled.status, "ready");
  assert.equal(enabledProvider.requests[0]?.body.enable_thinking, true);
  assert.equal(disabledProvider.requests[0]?.body.enable_thinking, false);
  assert.equal("reasoning_effort" in (enabledProvider.requests[0]?.body ?? {}), false);
  assert.equal("reasoning_effort" in (disabledProvider.requests[0]?.body ?? {}), false);
});
