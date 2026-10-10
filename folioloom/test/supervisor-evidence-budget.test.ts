import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, type SupervisorInput } from "../src/agents/supervisor.js";
import { evidenceReferences, paragraphEvidenceReferences } from "../src/domain/evidence-reference.js";
import { ModelProviderError } from "../src/agents/pi-runtime.js";
import { supervisorQueryResults } from "./helpers/supervisor-context.js";

function body(message: Context["messages"][number]): any {
  return JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
function fixture() {
  const faux = fauxProvider();
  const sources = Array.from({ length: 5 }, (_, i) => ({ blockId: `b${i}`, globalIndex: i,
    sourceText: `Needle ${i} ${"🌙 quiet words ".repeat(800)}` }));
  const input: SupervisorInput = { event: "review", windows: [{ windowId: "w", ordinal: 0, blockIds: ["b0"] }], sources,
    candidate: [{ blockId: "b0", text: "守卫在塔楼旁等候。" }], terms: [], decisionProtocol: "ordered_values_tool",
    model: { ...faux.getModel(), provider: "folioloom-deepseek", contextWindow: 1_000_000 },
    streamFn: faux.provider.streamSimple.bind(faux.provider), thinkingLevel: "high", maxTurns: 2 };
  return { faux, input };
}
function resultTextSize(result: any): number {
  return (result.evidence ?? []).reduce((n: number, e: any) => n + Array.from(e.text).length, 0)
    + (result.hits ?? []).reduce((n: number, h: any) => n + (h.evidence ?? []).reduce((m: number, e: any) => m + Array.from(e.text).length, 0)
      + Array.from((h.sourceExcerpt ?? "") + (h.targetExcerpt ?? "")).length, 0);
}
function pause(context: Context) {
  const p = body(context.messages.find(m => m.role === "user")!);
  assert.equal(p.event, "review");
  return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["pause", [], [], "Preserve uncertainty within the evidence budget."] }), { stopReason: "toolUse" });
}

test("batched search exhaustion returns bounded evidence and still permits the original final turn", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(Array.from({ length: 6 }, () => fauxToolCall("search_source", { query: "Needle", limit: 4 })), { stopReason: "toolUse" }), context => {
    const results = supervisorQueryResults(context);
    assert.equal(results.length, 6);
    assert.ok(results.every(r => !r.isError), "ordinary exhaustion is not a tool failure");
    const parsed = results.map(r => r.result);
    const total = parsed.reduce((n, r) => n + resultTextSize(r), 0);
    assert.ok(total <= 12_000);
    assert.ok(parsed.some(r => r.truncated && r.evidenceBudget.queryState === "closed"));
    assert.equal(parsed.at(-1).evidenceBudget.remainingChars, 12_000 - total);
    assert.deepEqual(context.tools?.map(t => t.name), ["submit_supervisor_values"]);
    assert.match(context.systemPrompt!, /剩余证据字符额度/u);
    for (const r of parsed) for (const hit of r.hits ?? []) {
      const original = f.input.sources[Number(hit.blockId) - 1]!.sourceText;
      for (const e of hit.evidence) {
        assert.ok(original.includes(e.text), "evidence is kept whole, not rewritten");
        assert.ok(!/[\uD800-\uDBFF]$/u.test(e.text), "Unicode scalars remain intact");
      }
    }
    return pause(context);
  }]);
  const result = await runSupervisor(f.input);
  assert.equal(result.decision.action, "pause");
  assert.equal(result.run.modelCalls, 2);
  assert.deepEqual(result.run.toolErrors, []);
});

test("source reads and committed-target pairs share the same remaining evidence allowance", async () => {
  const f = fixture();
  f.input.targetContext = f.input.sources.slice(1).map(b => ({ blockId: b.blockId, text: "Needle 中文🌙".repeat(800) }));
  f.faux.setResponses([context => {
    const p = body(context.messages.find(m => m.role === "user")!);
    return fauxAssistantMessage([
      fauxToolCall("read_source", { blockId: p.source[0].blockId, start: 0, count: 4000 }),
      fauxToolCall("read_source", { blockId: p.source[0].blockId, start: 4000, count: 4000 }),
      fauxToolCall("search_target", { query: "Needle", limit: 4 }),
      fauxToolCall("search_source", { query: "Needle", limit: 4 }),
    ], { stopReason: "toolUse" });
  }, context => {
    const results = supervisorQueryResults(context);
    assert.ok(results.every(r => !r.isError));
    const parsed = results.map(r => r.result);
    assert.ok(parsed.reduce((n, r) => n + resultTextSize(r), 0) <= 12_000);
    assert.ok(parsed[2].truncated);
    assert.equal(parsed[2].readOnly, true);
    assert.ok(parsed[2].hits.every((h: any) => h.sourceExcerpt && h.targetExcerpt && h.translationHash));
    assert.deepEqual(parsed[3].hits, []);
    assert.equal(parsed[3].evidenceBudget.queryState, "closed");
    assert.match(parsed[3].instruction, /提交|决定/u);
    return pause(context);
  }]);
  assert.equal((await runSupervisor(f.input)).run.modelCalls, 2);
});

test("real no-match results remain distinguishable from budget-closed empty results", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("search_source", { query: "absent-phrase", limit: 1 }), { stopReason: "toolUse" }), context => {
    const r = supervisorQueryResults(context)[0]!.result;
    assert.deepEqual(r.hits, []);
    assert.equal(r.truncated, false);
    assert.equal(r.evidenceBudget.remainingChars, 12_000);
    assert.equal(r.evidenceBudget.queryState, "open");
    return pause(context);
  }]);
  assert.equal((await runSupervisor(f.input)).decision.action, "pause");
});

test("references omitted by the remaining budget cannot be used as issued repair evidence", async () => {
  const f = fixture(); f.input.decisionProtocol = "native_tool";
  f.input.sources = [{ blockId: "b0", globalIndex: 0, sourceText: "🌙 quiet words ".repeat(1400) }];
  const omitted = evidenceReferences("source", "b0", f.input.sources[0]!.sourceText).filter(r => r.end > 8000 && r.start < 12000).at(-1)!;
  const target = paragraphEvidenceReferences("target", "b0", f.input.candidate![0]!.text)[0]!;
  f.faux.setResponses([fauxAssistantMessage([0, 4000, 8000].map(start => fauxToolCall("read_source", { blockId: "b0", start, count: 4000 })), { stopReason: "toolUse" }), context => {
    const results = supervisorQueryResults(context).map(r => r.result);
    assert.ok(results.at(-1).truncated);
    assert.ok(results.every(r => !r.evidence.some((e: any) => e.id === omitted.id)));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
      action: "revise", windowIds: ["w"], reviewBlockIds: [], guidance: [],
      issues: [{ blockId: "b0", sourceRef: omitted.id, targetRef: target.id, problem: "An unissued reference cannot authorize repair." }], reason: "Invalid evidence.",
    }), { stopReason: "toolUse" });
  }]);
  await assert.rejects(() => runSupervisor(f.input), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError && error.run);
    assert.match(error.message, /unissued/u);
    assert.equal(error.run.modelCalls, 2);
    assert.ok(!error.run.toolErrors.some(e => e.message.includes("budget exceeded")));
    return true;
  });
});
