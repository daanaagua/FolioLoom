import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  createDeepSeekModel,
  ModelProviderError,
  PiRuntime,
} from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { Type, type TypedToolSpec } from "../src/tools/tool-spec.js";

function streamFrom(faux: ReturnType<typeof fauxProvider>) {
  return faux.provider.streamSimple.bind(faux.provider);
}

test("Pi executes an allowlisted tool and stops on terminating submit", async () => {
  const faux = fauxProvider();
  const executed: string[] = [];
  const evidenceOrdinals: number[] = [];
  const tools: TypedToolSpec[] = [
    {
      name: "search_mentions",
      label: "Search mentions",
      description: "Fixture search.",
      phase: "research",
      parameters: Type.Object({ subjectIds: Type.Array(Type.String()) }),
      execute: async () => {
        executed.push("search_mentions");
        return { hits: [] };
      },
    },
    {
      name: "finish_research",
      label: "Finish research",
      description: "Fixture termination.",
      phase: "research",
      parameters: Type.Object({ unresolvedQuestionIds: Type.Array(Type.String()) }),
      execute: async () => {
        executed.push("finish_research");
        return { finished: true };
      },
    },
  ];
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("search_mentions", { subjectIds: ["typhon"] }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("finish_research", { unresolvedQuestionIds: [] }),
      { stopReason: "toolUse" },
    ),
  ]);
  const runtime = new PiRuntime();
  const result = await runtime.run({
      systemPrompt: "Use the tools.",
      prompt: "Research Typhon.",
      phase: "research",
      model: faux.getModel(),
      tools,
      budget: new BudgetLedger(),
      terminateTools: ["finish_research"],
      onAssistantResponse: (observation) => {
        evidenceOrdinals.push(observation.modelCallOrdinal);
      },
  }, streamFrom(faux));

  assert.deepEqual(executed, ["search_mentions", "finish_research"]);
  assert.deepEqual(result.toolNames, ["search_mentions", "finish_research"]);
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(evidenceOrdinals, [1, 2]);
  assert.equal(result.stopReason, "toolUse");
  assert.ok(result.usage.totalTokens > 0);
});

test("Pi gracefully stops a nonterminal session at its local turn cap", async () => {
  const faux = fauxProvider();
  const tools: TypedToolSpec[] = [{
    name: "search_mentions",
    label: "Search mentions",
    description: "Fixture search.",
    phase: "research",
    parameters: Type.Object({ subjectIds: Type.Array(Type.String()) }),
    execute: async () => ({ hits: [] }),
  }];
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("search_mentions", { subjectIds: ["typhon"] }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("This second model turn must never start."),
  ]);

  const result = await new PiRuntime().run({
    systemPrompt: "Search once.",
    prompt: "Research Typhon.",
    phase: "research",
    model: faux.getModel(),
    tools,
    budget: new BudgetLedger(),
    maxTurns: 1,
  }, streamFrom(faux));

  assert.equal(result.modelCalls, 1);
  assert.equal(result.turnLimitReached, true);
  assert.equal(faux.state.callCount, 1);
});

test("Pi never executes a tool outside its capability registry", async () => {
  const faux = fauxProvider();
  let executed = 0;
  const tools: TypedToolSpec[] = [{
    name: "finish_research",
    label: "Finish research",
    description: "Only legal fixture capability.",
    phase: "research",
    parameters: Type.Object({ unresolvedQuestionIds: Type.Array(Type.String()) }),
    execute: async () => {
      executed += 1;
      return { finished: true };
    },
  }];
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("shell", { command: "whoami" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Stopped after the rejected tool."),
  ]);
  const result = await new PiRuntime().run({
      systemPrompt: "Never use arbitrary tools.",
      prompt: "Try the fixture.",
      phase: "research",
      model: faux.getModel(),
      tools,
      budget: new BudgetLedger(),
      terminateTools: ["finish_research"],
  }, streamFrom(faux));

  assert.equal(executed, 0);
  assert.ok(result.toolErrors.some((item) => item.toolName === "shell"));
});

test("Pi refuses a pre-aborted session before a model call", async () => {
  const faux = fauxProvider();
  const controller = new AbortController();
  controller.abort(new Error("fixture abort"));
  await assert.rejects(
    new PiRuntime().run({
        systemPrompt: "Stop.",
        prompt: "Do not run.",
        phase: "research",
        model: faux.getModel(),
        tools: [],
        budget: new BudgetLedger(),
        signal: controller.signal,
    }, streamFrom(faux)),
    /fixture abort|aborted/i,
  );
  assert.equal(faux.state.callCount, 0);
});

test("Pi surfaces provider errors instead of misclassifying them as human review", async () => {
  const faux = fauxProvider();
  const evidence: Array<{
    phase: string;
    modelCallOrdinal: number;
    requestHash: string;
    stopReason: string;
  }> = [];
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "401: authentication failed for fixture credential",
    }),
  ]);

  await assert.rejects(
    new PiRuntime().run({
      systemPrompt: "Use the tools.",
      prompt: "Translate the fixture.",
      phase: "translation",
      model: faux.getModel(),
      tools: [],
      budget: new BudgetLedger(),
      onAssistantResponse: (observation) => {
        evidence.push({
          phase: observation.phase,
          modelCallOrdinal: observation.modelCallOrdinal,
          requestHash: observation.requestHash,
          stopReason: observation.assistantMessage.stopReason,
        });
      },
    }, streamFrom(faux)),
    /authentication failed/i,
  );
  assert.deepEqual(evidence, [{
    phase: "translation",
    modelCallOrdinal: 1,
    requestHash: evidence[0]?.requestHash ?? "",
    stopReason: "error",
  }]);
  assert.match(evidence[0]?.requestHash ?? "", /^[0-9a-f]{64}$/u);
});

test("Pi classifies provider failures for bounded runtime recovery", async () => {
  const cases = [
    { message: "401: invalid api key", kind: "auth", retryable: false },
    { message: "insufficient_quota: billing limit reached", kind: "quota", retryable: false },
    { message: "429: rate limit exceeded", kind: "throttled", retryable: true },
    { message: "request timed out while reading the stream", kind: "timeout", retryable: true },
    { message: "503: service unavailable", kind: "busy", retryable: true },
    { message: "terminated", kind: "busy", retryable: true },
    { message: "unterminated JSON payload", kind: "protocol", retryable: false },
    { message: "input exceeds the context window", kind: "context", retryable: false },
    { message: "malformed tool-call stream", kind: "protocol", retryable: false },
    { message: "fixture mystery failure", kind: "unknown", retryable: false },
  ] as const;

  for (const fixture of cases) {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: fixture.message,
    })]);
    try {
      await new PiRuntime().run({
        systemPrompt: "Use the tools.",
        prompt: "Translate the fixture.",
        phase: "translation",
        model: faux.getModel(),
        tools: [],
        budget: new BudgetLedger(),
      }, streamFrom(faux));
      assert.fail(`expected ${fixture.kind} provider failure`);
    } catch (error) {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.kind, fixture.kind);
      assert.equal(error.retryable, fixture.retryable);
      assert.ok(error.run !== undefined);
      assert.equal(error.run.stopReason, "error");
      assert.ok(error.run.usage.totalTokens > 0);
    }
  }
});

test("Pi preserves an explicit off or high thinking level at the stream boundary", async () => {
  for (const thinkingLevel of ["off", "high"] as const) {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("fixture response")]);
    let observedReasoning: unknown = "not-called";
    const stream = (model: Parameters<typeof faux.provider.streamSimple>[0],
      context: Parameters<typeof faux.provider.streamSimple>[1],
      options: Parameters<typeof faux.provider.streamSimple>[2]) => {
      observedReasoning = options?.reasoning;
      return faux.provider.streamSimple(model, context, options);
    };
    await new PiRuntime().run({
      systemPrompt: "Return the fixture.",
      prompt: "Run once.",
      phase: "translation",
      model: faux.getModel(),
      tools: [],
      budget: new BudgetLedger(),
      thinkingLevel,
    }, stream);
    assert.equal(observedReasoning, thinkingLevel === "off" ? undefined : "high");
  }
});

test("DeepSeek model metadata carries compatibility controls but no API key", () => {
  const secret = "fixture-secret-must-not-serialize";
  const model = createDeepSeekModel({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://example.invalid/v1",
    timeoutMs: 30_000,
    reasoningEffort: "high",
    apiKeyForRuntime: () => secret,
    toJSON: () => ({}),
  });

  assert.equal(model.maxTokens, 37_200);
  assert.equal(model.compat?.thinkingFormat, "deepseek");
  assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(JSON.stringify(model).includes(secret), false);
});
