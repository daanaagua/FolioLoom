import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, supervisorPrompt, validateSupervisorDecision, type SupervisorInput } from "../src/agents/supervisor.js";
import { supervisorQueryResults } from "./helpers/supervisor-context.js";

function prompt(context: Context) {
  const user = context.messages.find(m => m.role === "user")!;
  return JSON.parse(typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
function hit(context: Context) {
  return supervisorQueryResults(context)[0]!.result.hits[0];
}
function fixture(protocol: SupervisorInput["decisionProtocol"] = "ordered_values_tool") {
  const faux = fauxProvider();
  const input: SupervisorInput = { event: "plan", decisionProtocol: protocol,
    windows: [{ windowId: "w5", ordinal: 4, blockIds: ["b5"] }, { windowId: "w6", ordinal: 5, blockIds: ["b6"] }],
    sources: ["A lyceum is a school.", "The river was quiet.", "A bell rang.", "They used cards as currency.",
      "She entered the lyceum.", "He paid three cards."].map((sourceText, i) => ({ blockId: `b${i + 1}`, globalIndex: i, sourceText })),
    terms: [], model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), maxTurns: 2 };
  return { faux, input };
}

test("the DeepSeek wire advertises only the explicit three-field guidance contract", async () => {
  const f = fixture();
  f.input.model = { ...f.input.model, provider: "folioloom-deepseek" };
  f.faux.setResponses([context => {
    const schema: any = context.tools!.find(t => t.name === "submit_supervisor_values")!.parameters;
    const row = schema.properties.values.prefixItems[2].items;
    assert.equal(row.prefixItems.length, 3);
    assert.equal(row.maxItems, 3);
    assert.equal(row.anyOf, undefined, "legacy input compatibility must not encourage ambiguous new output");
    const p = prompt(context);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [1, [], [[p.source[0].evidence[0].id, null, "Keep the school sense."]], "Translate." ] }), { stopReason: "toolUse" });
  }]);
  assert.equal((await runSupervisor(f.input)).decision.guidance[0]!.blockId, "b5");
});

for (const protocol of ["ordered_values_tool", "ordered_values", "native_tool"] as const) {
test(`queried earlier evidence supports guidance on an explicitly selected current passage (${protocol})`, async () => {
  const f = fixture(protocol);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_source", { query: "lyceum", limit: 1 }), { stopReason: "toolUse" }),
    context => {
      const p = prompt(context), earlier = hit(context);
      assert.equal(earlier.referenceOnly, true);
      assert.equal(earlier.inCurrentBatch, false);
      assert.match(p.guidanceScope.instruction, /参考|reference/u);
      const currentRef = p.source[0].evidence[0].id, referenceRef = earlier.evidence[0].id;
      const value = { values: [2, p.windows.flatMap((w: any) => w.blockIds), [[currentRef, referenceRef, "Use 学馆 here for the same school sense."]], "Translate both current windows."] };
      return protocol === "ordered_values" ? fauxAssistantMessage(JSON.stringify(value)) : protocol === "ordered_values_tool"
        ? fauxAssistantMessage(fauxToolCall("submit_supervisor_values", value), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { action: "translate", windowIds: ["w5", "w6"], reviewBlockIds: ["b5"], issues: [],
          guidance: [{ blockId: "b5", sourceRef: currentRef, referenceSourceRef: referenceRef, instruction: "Use 学馆 here for the same school sense." }], reason: "Translate." }), { stopReason: "toolUse" });
    },
  ]);
  const result = await runSupervisor(f.input);
  const guidance = result.decision.guidance[0]!;
  assert.equal(guidance.blockId, "b5");
  assert.equal(guidance.sourceQuote, "She entered the lyceum.");
  assert.deepEqual((guidance as any).referenceEvidence, { blockId: "b1", sourceRef: (guidance as any).referenceEvidence.sourceRef,
    sourceQuote: "A lyceum is a school.", readOnly: true });
  assert.deepEqual(validateSupervisorDecision(result.decision, f.input), result.decision, "persisted evidence survives strict canonical validation");
  for (const patch of [{ blockId: "b6" }, { sourceQuote: "Invented earlier facts." }, { readOnly: false }, { sourceRef: "unissued" }]) {
    assert.throws(() => validateSupervisorDecision({ ...result.decision, guidance: [{ ...guidance,
      referenceEvidence: { ...(guidance as any).referenceEvidence, ...patch } }] }, f.input), /reference evidence/u);
  }
  assert.equal(result.run.modelCalls, 2); assert.deepEqual(result.run.toolErrors, []);
});
}

test("outside read_source evidence is marked reference-only and cannot be promoted by a query", async () => {
  const f = fixture();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_source", { blockId: 1, start: 0, count: 100 }), { stopReason: "toolUse" }),
    context => {
      const evidence = supervisorQueryResults(context)[0]!.result;
      assert.equal(evidence.referenceOnly, true);
      assert.equal(evidence.inCurrentBatch, false);
      const p = prompt(context);
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [1, [],
        [[p.source[0].evidence[0].id, evidence.evidence[0].id, "Use the same school sense here."]], "Translate." ] }), { stopReason: "toolUse" });
    },
  ]);
  const result = await runSupervisor(f.input);
  assert.equal(result.decision.guidance[0]!.blockId, "b5");
  assert.equal((result.decision.guidance[0] as any).referenceEvidence.blockId, "b1");
});

for (const variant of ["legacy_outside", "outside_target", "unapproved_prefix", "invented_reference"] as const) {
test(`reference separation never expands scope or repairs an ambiguous instruction (${variant})`, async () => {
  const f = fixture();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_source", { query: "lyceum", limit: 1 }), { stopReason: "toolUse" }),
    context => {
      const p = prompt(context), earlier = hit(context).evidence[0].id;
      const row = variant === "legacy_outside" ? [earlier, "Wrong target."]
        : [variant === "outside_target" ? earlier : p.source[variant === "unapproved_prefix" ? 1 : 0].evidence[0].id,
          variant === "invented_reference" ? 99999 : earlier, "Do not infer another location."];
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [variant === "unapproved_prefix" ? 1 : 2, [], [row], "Bounded plan."] }), { stopReason: "toolUse" });
    },
  ]);
  await assert.rejects(() => runSupervisor(f.input), (e: any) => e.kind === "protocol" && e.run?.modelCalls === 2);
  assert.equal(f.faux.state.callCount, 2);
});
}

test("new guidance can omit comparison evidence without changing its current position", async () => {
  const f = fixture();
  f.faux.setResponses([context => {
    const p = prompt(context);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [1, [], [[p.source[0].evidence[0].id, null, "Keep the stated school sense."]], "Translate one window."] }), { stopReason: "toolUse" });
  }]);
  const result = await runSupervisor(f.input);
  assert.equal(result.decision.guidance[0]?.blockId, "b5");
  assert.equal((result.decision.guidance[0] as any).referenceEvidence, undefined);
});
