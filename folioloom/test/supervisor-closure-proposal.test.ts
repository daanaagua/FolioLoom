import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, supervisorPrompt, supervisorSystemPrompt, validateSupervisorDecision, type SupervisorInput } from "../src/agents/supervisor.js";

function prompt(context: Context): any {
  const message = context.messages.find(m => m.role === "user")!;
  return JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
function fixture() {
  const faux = fauxProvider();
  const original = "The guard did not leave the tower.";
  const target = "守卫离开了塔楼。";
  const input: SupervisorInput = { event: "review", decisionProtocol: "ordered_values_tool",
    windows: [{ windowId: "w", ordinal: 0, blockIds: ["b"] }], sources: [{ blockId: "b", globalIndex: 0, sourceText: original }],
    candidate: [{ blockId: "b", text: target }], priorCandidate: [{ blockId: "b", text: target }],
    priorIssues: [{ issueId: "negation", blockId: "b", sourceQuote: original, targetQuote: target, problem: "Restore the missing negation." }],
    qualityReviewStage: "disposition", terms: [], model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), maxTurns: 1 };
  return { faux, input, target };
}

test("closure prompts expose current-candidate fix eligibility and do not present requested edits as completed", () => {
  const f = fixture();
  for (const decisionProtocol of ["ordered_values_tool", "ordered_values", "native_tool", "json_terminal"] as const) {
    const input = { ...f.input, decisionProtocol };
    const data = JSON.parse(supervisorPrompt(input));
    assert.equal(data.priorIssues[0].changeEvidence, false);
    assert.deepEqual(data.priorIssues[0].allowedStatuses, ["dismissed", "variant", "unresolved"]);
    assert.match(supervisorSystemPrompt(input) + data.closureInstruction, /尚未执行|尚未应用/u);
    assert.match(supervisorSystemPrompt(input) + data.closureInstruction, /多种译法.*不能|不能.*多种译法/u);
  }
  f.input.candidate = [{ blockId: "b", text: "守卫没有离开塔楼。" }];
  const data = JSON.parse(supervisorPrompt(f.input));
  assert.equal(data.priorIssues[0].changeEvidence, true);
  assert.ok(data.priorIssues[0].allowedStatuses.includes("fixed"));
});

for (const protocol of ["ordered_values_tool", "ordered_values", "native_tool", "json_terminal"] as const) {
  test(`${protocol}: a grounded revise proposal retains an unproven fixed claim as unresolved without another call`, async () => {
    const f = fixture(); f.input.decisionProtocol = protocol;
    let observedTokens = 0;
    f.input.onAssistantResponse = o => { observedTokens += o.assistantMessage.usage.totalTokens; };
    f.faux.setResponses([context => {
      const p = prompt(context), s = p.source[0].evidence[0].id, t = p.candidate[0].evidence[0].id;
      const values = ["revise", [[s, t, "Restore the missing negation."]], [["fixed", s, t, "Negation has been restored."]], "Correction requested."];
      const raw = { action: "revise", windowIds: ["w"], reviewBlockIds: [], guidance: [],
        issues: [{ blockId: "b", sourceRef: s, targetRef: t, problem: "Restore the missing negation." }],
        dispositions: [{ issueId: "negation", status: "fixed", sourceRef: s, targetRef: t, note: "Negation has been restored." }], reason: "Correction requested." };
      if (protocol === "native_tool" || protocol === "json_terminal") assert.throws(() => validateSupervisorDecision(raw, f.input), /unchanged/u);
      return protocol === "ordered_values_tool" ? fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values }), { stopReason: "toolUse" })
        : protocol === "native_tool" ? fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", raw), { stopReason: "toolUse" })
        : fauxAssistantMessage(JSON.stringify(protocol === "ordered_values" ? { values } : raw));
    }]);
    const result = await runSupervisor(f.input);
    assert.equal(result.decision.action, "revise");
    assert.equal(result.decision.issues.length, 1);
    assert.equal(result.decision.dispositions?.[0]?.status, "unresolved");
    assert.match(result.decision.dispositions![0]!.note, /尚未应用|尚未执行/u);
    assert.equal(f.input.candidate![0]!.text, f.target);
    assert.equal(result.run.modelCalls, 1);
    assert.equal(result.run.usage.totalTokens, observedTokens);
  });
}

test("accepting unchanged text as fixed still fails; forged evidence cannot enter proposal recovery", async () => {
  for (const kind of ["accept", "forged", "unrelated"] as const) {
    const f = fixture();
    if (kind === "unrelated") f.input.sources = [{ blockId: "b", globalIndex: 0, sourceText: f.input.sources[0]!.sourceText + "\n\nThe bell rang." }];
    f.faux.setResponses([context => {
      const p = prompt(context), s = p.source[0].evidence[0].id, t = p.candidate[0].evidence[0].id;
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [kind === "accept" ? "accept" : "revise",
        kind === "accept" ? [] : [[kind === "forged" ? 9999 : p.source[0].evidence.at(-1).id, t, "Different proposed correction."]],
        [["fixed", s, t, "Claimed fix."]], "Checked."] }), { stopReason: "toolUse" });
    }]);
    await assert.rejects(() => runSupervisor(f.input));
    assert.equal(f.faux.state.callCount, 1);
  }
});

test("an actual repaired candidate can still be grounded as fixed", async () => {
  const f = fixture(); f.input.candidate = [{ blockId: "b", text: "守卫没有离开塔楼。" }];
  f.faux.setResponses([context => {
    const p = prompt(context);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["accept", [],
      [["fixed", p.source[0].evidence[0].id, p.candidate[0].evidence[0].id, "Negation is present in the repaired candidate."]], "Verified."] }), { stopReason: "toolUse" });
  }]);
  assert.equal((await runSupervisor(f.input)).decision.dispositions?.[0]?.status, "fixed");
});

test("proposal recovery cannot hide invalid grounding in another submitted fixed row", async () => {
  const f = fixture(); f.input.decisionProtocol = "native_tool";
  f.input.priorIssues = [...f.input.priorIssues!, { ...f.input.priorIssues![0]!, issueId: "second" }];
  f.faux.setResponses([context => {
    const p = prompt(context), s = p.source[0].evidence[0].id, t = p.candidate[0].evidence[0].id;
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
      action: "revise", windowIds: ["w"], reviewBlockIds: [], guidance: [],
      issues: [{ blockId: "b", sourceRef: s, targetRef: t, problem: "Restore negation." }],
      dispositions: [{ issueId: "negation", status: "fixed", sourceRef: s, targetRef: t, note: "Not yet changed." },
        { issueId: "second", status: "fixed", sourceRef: "", targetRef: "", note: "Missing required grounding." }], reason: "Proposed fixes.",
    }), { stopReason: "toolUse" });
  }]);
  await assert.rejects(() => runSupervisor(f.input));
});

for (const grounded of [false, true]) {
test(`existing unresolved findings can request repair without duplicate new issues only when grounded (${grounded})`, async () => {
  const f = fixture();
  f.faux.setResponses([context => {
    const p = prompt(context);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["revise", [],
      [["unresolved", grounded ? p.source[0].evidence[0].id : null, grounded ? p.candidate[0].evidence[0].id : null, "The original negation error remains in this candidate."]],
      "Repair the existing finding."] }), { stopReason: "toolUse" });
  }]);
  if (grounded) {
    const result = await runSupervisor(f.input);
    assert.equal(result.decision.action, "revise");
    assert.deepEqual(result.decision.issues, []);
    assert.equal(result.decision.dispositions?.[0]?.status, "unresolved");
    assert.equal(result.run.modelCalls, 1);
  } else await assert.rejects(() => runSupervisor(f.input), /grounded issues/u);
});
}
