import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runSupervisor, supervisorPrompt, validateSupervisorDecision, type SupervisorInput } from "../src/agents/supervisor.js";
import { bindTaskContext } from "../src/agents/task-context.js";

function fixture() {
  const faux = fauxProvider();
  const input: SupervisorInput = {
    event: "plan", windows: [{ windowId: "w1", ordinal: 0, blockIds: ["b1"] }, { windowId: "w2", ordinal: 1, blockIds: ["b2"] }],
    sources: [{ blockId: "b1", globalIndex: 0, sourceText: "Rose did not leave. She waited for John." },
      { blockId: "b2", globalIndex: 1, sourceText: "John called Rose his sister." }],
    terms: [], model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
  };
  return { faux, input };
}
const plan = { action: "translate", windowIds: ["w1", "w2"], reviewBlockIds: ["b1"], guidance: [], issues: [], reason: "先译两个窗口，再检查否定含义。" };

test("supervisor can search evidence then authorize a bounded batch using native Pi", async () => {
  const { faux, input } = fixture();
  const seen: string[] = [];
  const raw = input.streamFn;
  input.streamFn = bindTaskContext((m, c, o) => { seen.push(c.systemPrompt ?? ""); return raw(m, c, o); }, "仅作个人阅读的测试材料。");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_source", { query: "sister", limit: 2 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" }),
  ]);
  const result = await runSupervisor(input);
  assert.equal(result.decision.action, "translate");
  assert.deepEqual(result.run.toolNames, ["search_source", "submit_supervisor_decision"]);
  assert.equal(result.run.modelCalls, 2);
  assert.ok(seen.every(s => s.startsWith("仅作个人阅读的测试材料。")));
  assert.equal(faux.state.callCount, 2);
});

test("supervisor cannot skip a window, invent scope, or invent source evidence", () => {
  const { input } = fixture();
  assert.throws(() => validateSupervisorDecision({ ...plan, windowIds: ["w2"] }, input), /prefix/u);
  assert.throws(() => validateSupervisorDecision({ ...plan, windowIds: ["outside"] }, input), /scope|prefix/u);
  assert.throws(() => validateSupervisorDecision({ ...plan, reviewBlockIds: ["other"] }, input), /scope/u);
  assert.throws(() => validateSupervisorDecision({ ...plan, guidance: [{ blockId: "b1", sourceQuote: "invented", instruction: "改译" }] }, input), /source quote/u);
});

test("review decisions must point to supplied source and candidate text", () => {
  const { input } = fixture();
  const review: SupervisorInput = { ...input, event: "review", windows: [input.windows[0]!], candidate: [{ blockId: "b1", text: "罗斯离开了。她等着约翰。" }] };
  const decision = { action: "revise", windowIds: ["w1"], reviewBlockIds: [], guidance: [], reason: "否定意义丢失。", issues: [{ blockId: "b1", sourceQuote: "did not leave", targetQuote: "罗斯离开了", problem: "原文明确否定离开，译文却肯定离开。" }] };
  assert.equal(validateSupervisorDecision(decision, review).action, "revise");
  assert.throws(() => validateSupervisorDecision({ ...decision, issues: [{ ...decision.issues[0], targetQuote: "不存在的译文" }] }, review), /target quote/u);
  assert.throws(() => validateSupervisorDecision({ ...decision, action: "accept" }, review), /accept/u);
  assert.throws(() => validateSupervisorDecision({ ...plan, action: "translate" }, review), /action/u);
});

test("supervisor has a hard turn cap and never grants arbitrary file or shell tools", async () => {
  const { faux, input } = fixture();
  faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage(fauxToolCall("search_source", { query: "Rose", limit: 1 }), { stopReason: "toolUse" })));
  await assert.rejects(() => runSupervisor({ ...input, maxTurns: 2 }), /decision|supervisor/u);
  assert.equal(faux.state.callCount, 2);
});

test("provider failures are propagated rather than repaired as literary issues", async () => {
  const { faux, input } = fixture();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" })]);
  await assert.rejects(() => runSupervisor(input), /provider|Unauthorized/u);
  assert.equal(faux.state.callCount, 1);
});

test("the final supervisor turn exposes only the decision tool without increasing the turn cap", async () => {
  const { faux, input } = fixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_source", { query: "Rose", limit: 1 }), { stopReason: "toolUse" }),
    context => {
      assert.deepEqual(context.tools?.map(tool => tool.name), ["submit_supervisor_decision"]);
      assert.match(context.systemPrompt ?? "", /必须.*submit_supervisor_decision/u);
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" });
    },
  ]);
  const result = await runSupervisor({ ...input, maxTurns: 2 });
  assert.equal(result.run.modelCalls, 2);
  assert.equal(result.decision.action, "translate");
});

test("evidence tools leave one of the existing eight tool credits for a final decision", async () => {
  const { faux, input } = fixture();
  faux.setResponses([
    fauxAssistantMessage(Array.from({ length: 7 }, (_, index) => ({
      ...fauxToolCall("search_source", { query: "Rose", limit: 1 }), id: `search-${index}`,
    })), { stopReason: "toolUse" }),
    context => {
      assert.deepEqual(context.tools?.map(tool => tool.name), ["submit_supervisor_decision"]);
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" });
    },
  ]);
  const result = await runSupervisor(input);
  assert.equal(result.run.modelCalls, 2);
  assert.equal(result.run.toolNames.length, 8);
  assert.equal(result.decision.action, "translate");
});

test("review advertises empty plan-only fields in its native tool schema and prompt", async () => {
  const { faux, input } = fixture();
  let schema: any;
  let system = "";
  faux.setResponses([(context) => {
    schema = context.tools?.find(tool => tool.name === "submit_supervisor_decision")?.parameters;
    system = context.systemPrompt ?? "";
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
      action: "accept", windowIds: ["w1"], reviewBlockIds: [], guidance: [], issues: [], reason: "语义一致。",
    }), { stopReason: "toolUse" });
  }]);
  const review: SupervisorInput = { ...input, event: "review", windows: [input.windows[0]!], candidate: [{ blockId: "b1", text: "罗斯没有离开。她等着约翰。" }] };
  assert.equal((await runSupervisor(review)).decision.action, "accept");
  assert.equal(schema.properties.reviewBlockIds.maxItems, 0);
  assert.equal(schema.properties.guidance.maxItems, 0);
  assert.match(system, /reviewBlockIds.*guidance.*\[\]/u);
});

test("an extra evidence call cannot consume the reserved decision credit", async () => {
  const { faux, input } = fixture();
  faux.setResponses([fauxAssistantMessage(
    Array.from({ length: 8 }, (_, index) => ({
      ...fauxToolCall("search_source", { query: "Rose", limit: 1 }), id: `search-${index}`,
    })),
  { stopReason: "toolUse" }), fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" })]);
  const result = await runSupervisor(input);
  assert.equal(result.decision.action, "translate");
  assert.equal(result.run.toolErrors.length, 1);
  assert.match(result.run.toolErrors[0]!.message, /final tool credit/u);
  assert.equal(result.run.modelCalls, 2);
});

test("legacy quote diagnostics identify the faulty issue without weakening exact evidence", () => {
  const { input } = fixture();
  const review: SupervisorInput = { ...input, event: "review", windows: [input.windows[0]!], candidate: [{ blockId: "b1", text: "罗斯离开了。她等着约翰。" }] };
  const issue = { blockId: "b1", sourceQuote: "Rose", targetQuote: "罗斯", problem: "核对人物。" };
  assert.throws(() => validateSupervisorDecision({
    action: "revise", windowIds: ["w1"], reviewBlockIds: [], guidance: [], reason: "核对原意。",
    issues: [issue, { ...issue, sourceQuote: "John", targetQuote: "约翰" }, { ...issue, sourceQuote: "rose did not leave" }],
  }, review), /issues\[2\]\.sourceQuote.*b1.*source quote/u);
});

test("host-issued source and target references replace model-transcribed quotes", () => {
  const { input } = fixture();
  const review: SupervisorInput = { ...input, event: "review", windows: [input.windows[0]!], candidate: [{ blockId: "b1", text: "罗斯离开了。她等着约翰。" }] };
  const prompt = JSON.parse(supervisorPrompt(review));
  const source = prompt.source[0].evidence?.[0];
  const target = prompt.candidate[0].evidence?.[0];
  assert.ok(source?.id, "source spans must have host-issued IDs");
  assert.ok(target?.id, "candidate spans must have host-issued IDs");
  const raw = { action: "revise", windowIds: ["w1"], reviewBlockIds: [], guidance: [], reason: "否定丢失。",
    issues: [{ blockId: "b1", sourceRef: source.id, targetRef: target.id, problem: "恢复否定。" }] };
  const checked = validateSupervisorDecision(raw, review);
  assert.equal(checked.issues[0]?.sourceQuote, source.text);
  assert.equal(checked.issues[0]?.targetQuote, target.text);
  assert.throws(() => validateSupervisorDecision(raw, { ...review, candidate: [{ blockId: "b1", text: "罗斯没有离开。" }] }), /issues\[0\]\.targetRef/u);
});

test("repeated identical reference errors stop without spending all review turns", async () => {
  const { faux, input } = fixture();
  const invalid = { ...plan, guidance: [{ blockId: "b1", sourceRef: "invented", instruction: "核对人物。" }] };
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", invalid), { stopReason: "toolUse" })));
  await assert.rejects(() => runSupervisor(input), /supervisor/u);
  assert.equal(faux.state.callCount, 2);
});
