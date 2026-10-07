import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, supervisorPrompt, type SupervisorInput } from "../src/agents/supervisor.js";

function fixture() {
  const faux = fauxProvider();
  const input: SupervisorInput = { event: "review", reviewMode: "occurrence_cards", windows: [{ windowId: "w", ordinal: 0, blockIds: ["b"] }],
    sources: [{ blockId: "b", globalIndex: 0, sourceText: "He watched the whorl.\n\nShe remembered the whorl." },
      { blockId: "other", globalIndex: 1, sourceText: "The whorl was quiet." }],
    candidate: [{ blockId: "b", text: "他望着涡旋。\n\n她记得那个涡。" }],
    priorCandidate: [{ blockId: "b", text: "他望着涡。\n\n她记得那个涡。" }],
    priorIssues: [{ issueId: "whorl-first", blockId: "b", sourceQuote: "He watched the whorl.", targetQuote: "他望着涡。", problem: "whorl must use the established rendering 涡旋 in this occurrence." }],
    targetContext: [{ blockId: "other", text: "涡旋静谧无声。" }], terms: [],
    model: { ...faux.getModel(), provider: "folioloom-deepseek" }, streamFn: faux.provider.streamSimple.bind(faux.provider), maxTurns: 2 };
  return { input, faux };
}
function prompt(context: Context) {
  const m = context.messages.find(m => m.role === "user")!;
  return JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
}

test("review cards distinguish historical allegations, the current occurrence, and preloaded comparison evidence", () => {
  const f = fixture(), p = JSON.parse(supervisorPrompt(f.input));
  const card = p.priorIssues[0];
  assert.equal(card.before, "他望着涡。");
  assert.equal(card.current.text, "他望着涡旋。");
  assert.equal(card.source.text, "He watched the whorl.");
  assert.equal(card.changeEvidence, true);
  assert.ok(card.allowedStatuses.includes("fixed"));
  assert.equal(card.historicalProblem, f.input.priorIssues![0]!.problem);
  assert.equal(card.problem, undefined, "a historical allegation is not presented as a current fact");
  assert.ok(p.comparisonEvidence.hits.some((h: any) => h.targetExcerpt.includes("涡旋")));
  assert.ok(p.comparisonEvidence.characters <= 12000);
});

test("two-value closure rows are host-bound while another occurrence is a separate finding", async () => {
  const f = fixture();
  f.faux.setResponses([context => {
    const p = prompt(context);
    assert.deepEqual(context.tools?.map(t => t.name), ["submit_supervisor_values"]);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["revise",
      [[p.source[0].evidence[1].id, p.candidate[0].evidence[1].id, "The second whorl occurrence still uses 涡."]],
      [["fixed", "The original occurrence now uses 涡旋."]], "Keep the first fix and repair the second occurrence."] }), { stopReason: "toolUse" });
  }]);
  const result = await runSupervisor(f.input);
  assert.equal(result.run.modelCalls, 1);
  assert.equal(result.decision.dispositions![0]!.sourceQuote, "He watched the whorl.");
  assert.equal(result.decision.dispositions![0]!.targetQuote, "他望着涡旋。");
  assert.equal(result.decision.issues[0]!.sourceQuote, "She remembered the whorl.");
});

test("a single flattened closure row is losslessly framed without another provider turn", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_values", {
    values: ["accept", [], ["fixed", "The original occurrence now uses 涡旋."], "Checked."],
  }), { stopReason: "toolUse" })]);
  const result = await runSupervisor(f.input);
  assert.equal(result.run.modelCalls, 1);
  assert.deepEqual(result.run.toolErrors, []);
  assert.equal(result.decision.dispositions?.[0]?.issueId, "whorl-first");
  assert.equal(result.decision.dispositions?.[0]?.status, "fixed");
});

test("singleton framing cannot collapse two issues or manufacture fixed evidence", async () => {
  for (const twoIssues of [false, true]) {
    const f = fixture();
    if (twoIssues) f.input.priorIssues = [...f.input.priorIssues!, { ...f.input.priorIssues![0]!, issueId: "second" }];
    else f.input.candidate = f.input.priorCandidate;
    f.input.maxTurns = 1;
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_values", {
      values: ["accept", [], ["fixed", "Claimed fix."], "Checked."],
    }), { stopReason: "toolUse" })]);
    await assert.rejects(() => runSupervisor(f.input), /valid bounded decision/u);
    assert.equal(f.faux.state.callCount, 1);
  }
});

test("an ambiguous historical quote cannot authorize an inferred location or automatic closure", async () => {
  const f = fixture();
  f.input.sources = [{ blockId: "b", globalIndex: 0, sourceText: "He watched the whorl.\n\nHe watched the whorl." }];
  f.input.targetContext = [];
  const p = JSON.parse(supervisorPrompt(f.input));
  assert.equal(p.priorIssues[0].current, null);
  assert.deepEqual(p.priorIssues[0].allowedStatuses, ["unresolved"]);
  f.input.maxTurns = 1;
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["accept", [], [["fixed", "Guess the occurrence."]], "Guess."] }), { stopReason: "toolUse" })]);
  await assert.rejects(() => runSupervisor(f.input), /ground|evidence|disposition/u);
});
