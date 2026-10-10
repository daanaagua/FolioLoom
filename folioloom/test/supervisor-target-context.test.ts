import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, type SupervisorInput } from "../src/agents/supervisor.js";
import { SupervisorValueFrame } from "../src/agents/supervisor-values.js";
import { evidenceReferences } from "../src/domain/evidence-reference.js";
import { searchSupervisorTargets } from "../src/agents/supervisor-target-context.js";
import { supervisorQueryResults } from "./helpers/supervisor-context.js";

function prompt(c: Context): any {
  const m = c.messages.find(m => m.role === "user")!;
  return JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
function fixture() {
  const faux = fauxProvider();
  const input: SupervisorInput = { event: "review", decisionProtocol: "ordered_values_tool", maxTurns: 2,
    windows: [{ windowId: "w2", ordinal: 1, blockIds: ["b2"] }],
    sources: [{ blockId: "b1", globalIndex: 0, sourceText: "They reached the Lantern." },
      { blockId: "b2", globalIndex: 1, sourceText: "The Lantern was quiet." }],
    candidate: [{ blockId: "b2", text: "灯城很安静。" }],
    targetContext: [{ blockId: "b1", text: "他们抵达了灯城。" }],
    terms: [], model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) };
  return { faux, input };
}

test("final review queries bounded committed translations by source form then submits within its original turn cap", async () => {
  const { faux, input } = fixture();
  faux.setResponses([c => {
    assert.ok(c.tools?.some(t => t.name === "search_target"));
    assert.ok(prompt(c).targetContext.available);
    return fauxAssistantMessage(fauxToolCall("search_target", { query: "Lantern", limit: 4 }), { stopReason: "toolUse" });
  }, c => {
    assert.deepEqual(c.tools?.map(t => t.name), ["submit_supervisor_values"]);
    const text = JSON.stringify(supervisorQueryResults(c).at(-1)!.result);
    assert.match(text, /他们抵达了灯城/u);
    assert.match(text, /readOnly/u);
    assert.doesNotMatch(text, /"id":/u, "context excerpts do not mint editable candidate references");
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["accept", [], [], "Rendering is consistent."] }), { stopReason: "toolUse" });
  }]);
  const result = await runSupervisor(input);
  assert.equal(result.decision.action, "accept");
  assert.equal(result.run.modelCalls, 2);
  assert.equal(result.run.toolErrors.length, 0);
});

test("translation context outside the supplied source project fails before a model call", async () => {
  const { faux, input } = fixture();
  await assert.rejects(() => runSupervisor({ ...input, targetContext: [{ blockId: "unrelated", text: "private" }] }), /target context.*scope/u);
  assert.equal(faux.state.callCount, 0);
});

test("ordered decision frames are invalidated by changed comparison translations", () => {
  const { input } = fixture();
  const issued = new Set([...input.sources.flatMap(b => evidenceReferences("source", b.blockId, b.sourceText)),
    ...input.candidate!.flatMap(b => evidenceReferences("target", b.blockId, b.text))].map(r => r.id));
  const frame = new SupervisorValueFrame(input, issued);
  assert.throws(() => frame.decode(["accept", [], [], "Checked."], { ...input,
    targetContext: [{ blockId: "b1", text: "他们抵达了灯塔。" }] }), /stale/u);
});

test("protocol failures retain a bounded actionable diagnostic and actual usage", async () => {
  const { faux, input } = fixture();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "length" })]);
  await assert.rejects(() => runSupervisor({ ...input, maxTurns: 1 }), (error: any) => {
    assert.match(error.message, /stopReason=length/u);
    assert.ok(error.message.length <= 400);
    assert.equal(error.run.modelCalls, 1);
    return true;
  });
});

test("target lookup bounds Unicode excerpts and does not pretend mismatched paragraphs align", () => {
  const { input } = fixture();
  const source = "🙂".repeat(200) + " Lantern " + "x".repeat(3000);
  const scoped = { ...input, sources: [{ blockId: "b1", globalIndex: 0, sourceText: source }],
    targetContext: [{ blockId: "b1", text: "🙂".repeat(200) + "灯城" + "字".repeat(3000) }] };
  for (const query of ["Lantern", "灯城"]) {
    const result = searchSupervisorTargets(scoped, query, 1);
    assert.equal(result.hits.length, 1);
    assert.ok(Array.from(result.hits[0]!.sourceExcerpt).length <= 900);
    assert.ok(Array.from(result.hits[0]!.targetExcerpt).length <= 900);
    assert.ok(result.hits[0]!.sourceExcerpt.isWellFormed());
    assert.ok(result.hits[0]!.targetExcerpt.isWellFormed());
    assert.match(result.hits[0]!.translationHash, /^[a-f0-9]{64}$/u);
    assert.equal(result.hits[0]!.sourceRange.truncatedEnd, true);
    assert.equal(result.hits[0]!.targetRange.truncatedEnd, true);
  }
  const unaligned = searchSupervisorTargets({ ...scoped, targetContext: [{ blockId: "b1", text: "前段。\n\n灯城。" }] }, "灯城", 1);
  assert.equal(unaligned.hits[0]!.alignment, "block_only");
  assert.equal(searchSupervisorTargets(scoped, "missing", 4).hits.length, 0);
});

test("short comparison paragraphs remain whole even when a match is near their end", () => {
  const { input } = fixture();
  const text = "前文".repeat(180) + "灯城。";
  const result = searchSupervisorTargets({ ...input, targetContext: [{blockId:'b1',text}] }, '灯城', 1);
  assert.equal(result.hits[0]!.targetExcerpt, text);
});

test("comparison translations do not authorize corrections outside the candidate window", async () => {
  const { faux, input } = fixture();
  const outside = evidenceReferences("source", "b1", input.sources[0]!.sourceText)[0]!;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
    action: "revise", windowIds: ["w2"], reviewBlockIds: [], guidance: [], reason: "Out of scope.",
    issues: [{ blockId: "b1", sourceRef: outside.id, targetRef: "", problem: "Change a different window." }],
  }), { stopReason: "toolUse" })]);
  await assert.rejects(() => runSupervisor({ ...input, decisionProtocol: "native_tool", maxTurns: 1 }), /outside scope/u);
});
