import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, type SupervisorInput } from "../src/agents/supervisor.js";
import { bindTaskContext } from "../src/agents/task-context.js";
import { ModelProviderError, piRunUsageComplete } from "../src/agents/pi-runtime.js";

function data(message: Context["messages"][number]): any {
  return JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
function fixture(protocol: SupervisorInput["decisionProtocol"] = "ordered_values_tool") {
  const faux = fauxProvider();
  const input: SupervisorInput = { event: "plan", decisionProtocol: protocol, maxTurns: 2,
    sources: [{ blockId: "prior", globalIndex: 0, sourceText: "The lyceum was a school. 🌙" },
      { blockId: "current", globalIndex: 1, sourceText: "She entered the lyceum." }],
    windows: [{ windowId: "w", ordinal: 1, blockIds: ["current"] }], terms: [],
    model: faux.getModel(), streamFn: bindTaskContext(faux.provider.streamSimple.bind(faux.provider), "Synthetic authorized context."), thinkingLevel: "high" };
  return { faux, input };
}

for (const protocol of ["ordered_values_tool", "native_tool", "ordered_values", "json_terminal"] as const) {
test(`final decisions use a readonly evidence handoff instead of a query conversation (${protocol})`, async () => {
  const f = fixture(protocol);
  let firstInput: any;
  f.faux.setResponses([context => {
    firstInput = data(context.messages[0]!);
    return fauxAssistantMessage(fauxToolCall("search_source", { query: "lyceum", limit: 1 }), { stopReason: "toolUse" });
  }, context => {
    assert.ok(context.systemPrompt?.startsWith("Synthetic authorized context."));
    assert.ok(context.messages.every(m => m.role === "user"), "query-stage assistant/tool messages must not remain callable history");
    const p = data(context.messages[0]!), handoff = data(context.messages.at(-1)!);
    assert.equal(handoff.protocol, "supervisor-decision-handoff-1");
    assert.equal(handoff.queriesClosed, true);
    assert.equal(handoff.queries.length, 1);
    assert.deepEqual(handoff.queries[0].request, { query: "lyceum", limit: 1 });
    assert.equal(handoff.queries[0].isError, false);
    const earlier = handoff.queries[0].result.hits[0];
    assert.equal(earlier.evidence[0].text, f.input.sources[0]!.sourceText);
    assert.equal(earlier.referenceOnly, true);
    assert.deepEqual(p.source, firstInput.source, "current source and issued handles are unchanged");
    assert.match(p.instruction, /最终|提交/u);
    const values = { values: [1, [], [[p.source[0].evidence[0].id, earlier.evidence[0].id, "Keep the school sense."]], "Translate this passage."] };
    const native = { action: "translate", windowIds: ["w"], reviewBlockIds: [], issues: [],
      guidance: [{ blockId: "current", sourceRef: p.source[0].evidence[0].id, referenceSourceRef: earlier.evidence[0].id, instruction: "Keep the school sense." }], reason: "Translate this passage." };
    return protocol === "ordered_values" || protocol === "json_terminal"
      ? fauxAssistantMessage(JSON.stringify(protocol === "ordered_values" ? values : native))
      : fauxAssistantMessage(fauxToolCall(protocol === "ordered_values_tool" ? "submit_supervisor_values" : "submit_supervisor_decision",
        protocol === "ordered_values_tool" ? values : native), { stopReason: "toolUse" });
  }]);
  const result = await runSupervisor(f.input);
  assert.equal(result.run.modelCalls, 2);
  assert.equal(result.decision.guidance[0]!.blockId, "current");
  assert.equal(result.decision.guidance[0]!.referenceEvidence!.blockId, "prior");
  assert.ok(result.run.messages.some(m => m.role === "toolResult"), "durable audit history must retain original tool receipts");
  assert.ok(result.run.messages.some(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.name === "search_source")));
  assert.deepEqual(data(result.run.messages[0] as Context["messages"][number]), firstInput, "the persisted task is not rewritten by its wire projection");
  assert.deepEqual(result.run.toolErrors, []);
  assert.ok(piRunUsageComplete(result.run));
});
}

test("a failed query becomes explicit error evidence without relaxing its argument limits", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read_source", { blockId: 1, start: 0, count: 4200 }), { stopReason: "toolUse" }), context => {
    assert.ok(context.messages.every(m => m.role === "user"));
    const h = data(context.messages.at(-1)!);
    assert.equal(h.queries[0].isError, true);
    assert.match(h.queries[0].result, /4000/u);
    assert.deepEqual(context.tools?.map(t => t.name), ["submit_supervisor_values"]);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [0, [], [], "Evidence unavailable; preserve uncertainty."] }), { stopReason: "toolUse" });
  }]);
  const result = await runSupervisor(f.input);
  assert.equal(result.decision.action, "pause");
  assert.equal(result.run.toolErrors.length, 1);
  assert.equal(result.run.modelCalls, 2);
});

for (const query of [
  { name: "read_source", arguments: { blockId: 1, start: 0, count: 4000 }, error: /queries are closed/u },
  { name: "read_source", arguments: { blockId: 1, start: 0, count: 4200 }, error: /4000/u },
  { name: "search_source", arguments: { query: "lyceum", limit: 5 }, error: /must be <= 4/u },
]) {
test(`a forbidden final query remains bounded: ${query.name} ${JSON.stringify(query.arguments)}`, async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("search_source", { query: "lyceum", limit: 1 }), { stopReason: "toolUse" }), context => {
    assert.equal(data(context.messages.at(-1)!).protocol, "supervisor-decision-handoff-1");
    return fauxAssistantMessage(fauxToolCall(query.name, query.arguments), { stopReason: "toolUse" });
  }, fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [1, [], [], "Must not be reached."] }), { stopReason: "toolUse" })]);
  await assert.rejects(() => runSupervisor(f.input), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError && error.run);
    assert.equal(error.run.modelCalls, 2);
    assert.match(error.message, query.error);
    assert.ok(piRunUsageComplete(error.run));
    return true;
  });
  assert.equal(f.faux.state.callCount, 2);
});
}
