import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { runSupervisor, supervisorPrompt, validateSupervisorDecision, type SupervisorInput } from "../src/agents/supervisor.js";
import { SupervisorValueFrame } from "../src/agents/supervisor-values.js";
import { evidenceReferences } from "../src/domain/evidence-reference.js";
import { ModelProviderError, piRunUsageComplete } from "../src/agents/pi-runtime.js";
import { bindTaskContext } from "../src/agents/task-context.js";

function data(context: Context): any {
  const message = context.messages.findLast(m => m.role === "user")!;
  return JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
}

test("ordered supervisor decisions select host evidence without copying IDs, quotes or field names", async () => {
  const faux = fauxProvider();
  const source = "He’d not leave. He waited beside the gate.";
  const target = "他离开了。他在门边等着。";
  faux.setResponses([context => {
    assert.ok(!context.tools?.some(t => t.name === "submit_supervisor_decision"));
    const prompt = data(context);
    const sourceNumber = prompt.source[0].evidence[0].id;
    const targetNumber = prompt.candidate[0].evidence[0].id;
    assert.ok(Number.isSafeInteger(sourceNumber));
    assert.ok(Number.isSafeInteger(targetNumber));
    return fauxAssistantMessage(JSON.stringify({ values: ["revise", [[sourceNumber, targetNumber, "Restore the negation; he'd not leave."]], [], "Negation was lost."] }));
  }]);
  const input: SupervisorInput = { event: "review", windows: [{ windowId: "w", ordinal: 0, blockIds: ["b"] }],
    sources: [{ blockId: "b", globalIndex: 0, sourceText: source }], candidate: [{ blockId: "b", text: target }], terms: [],
    decisionProtocol: "ordered_values", model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), maxTurns: 1 };
  const result = await runSupervisor(input);
  assert.equal(result.decision.action, "revise");
  assert.deepEqual(result.decision.windowIds, ["w"]);
  assert.equal(result.decision.issues[0]?.sourceQuote, source);
  assert.equal(result.decision.issues[0]?.targetQuote, target);
  assert.equal(result.decision.issues[0]?.blockId, "b");
  assert.equal(result.decision.issues[0]?.sourceFocus, undefined);
  assert.equal(faux.state.callCount, 1);
});

function fixture() {
  const faux = fauxProvider();
  const input: SupervisorInput = { event: "review", decisionProtocol: "ordered_values",
    windows: [{ windowId: "w", ordinal: 0, blockIds: ["a", "b"] }],
    sources: [{ blockId: "a", globalIndex: 0, sourceText: "A guard did not leave." },
      { blockId: "b", globalIndex: 1, sourceText: "A bell rang." }],
    candidate: [{ blockId: "a", text: "守卫离开了。" }, { blockId: "b", text: "钟响了。" }], terms: [],
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), maxTurns: 1 };
  const issued = new Set([...input.sources.flatMap(b => evidenceReferences("source", b.blockId, b.sourceText)),
    ...input.candidate!.flatMap(b => evidenceReferences("target", b.blockId, b.text))].map(r => r.id));
  const frame = new SupervisorValueFrame(input, issued);
  const prompt = JSON.parse(supervisorPrompt(input));
  const a = prompt.source[0].evidence[0].id, b = prompt.source[1].evidence[0].id;
  const ta = prompt.candidate[0].evidence[0].id, tb = prompt.candidate[1].evidence[0].id;
  const decode = (raw: unknown) => validateSupervisorDecision(frame.decode(raw, input), input, issued);
  return { input, faux, issued, frame, prompt, a, b, ta, tb, decode };
}

test("value frames reject malformed shapes, forged handles, cross-side and cross-block evidence", () => {
  const f = fixture();
  const valid = ["revise", [[f.a, f.ta, "Restore negation."]], [], "One issue."];
  assert.equal(f.decode(valid).issues.length, 1);
  for (const raw of [{ values: valid }, valid.slice(0, 3), [...valid, "extra"],
    ["revise", [{ source: f.a, target: f.ta, problem: "wrong shape" }], [], "bad"],
    ["revise", [[f.a, f.ta, "problem", "sourceFocus2"]], [], "bad"],
    ["revise", [[0, f.ta, "problem"]], [], "bad"], ["revise", [[9999, f.ta, "problem"]], [], "bad"],
    ["revise", [[String(f.a), f.ta, "problem"]], [], "bad"], ["revise", [[1.5, f.ta, "problem"]], [], "bad"],
    ["revise", [[f.ta, f.a, "problem"]], [], "bad"], ["revise", [[f.a, f.tb, "problem"]], [], "bad"],
    ["accept", [[f.a, f.ta, "problem"]], [], "contradiction"], ["revise", [], [], "no evidence"],
    ["accept", [], ["extra disposition"], "bad"], ["accept", [], [], "x".repeat(1201)]]) {
    assert.throws(() => f.decode(raw));
  }
  assert.equal(f.decode(["revise", [[f.a, null, "A fragment is missing."]], [], "Omission."]).issues[0]?.targetQuote, "");
});

test("a frame cannot be reused after its candidate, source, terms or scope change", () => {
  const f = fixture(), value = ["accept", [], [], "Checked."];
  for (const changed of [
    { ...f.input, candidate: [{ blockId: "a", text: "不同的译文。" }] },
    { ...f.input, sources: [{ ...f.input.sources[0]!, sourceText: "A different source." }] },
    { ...f.input, terms: [{ sourceForm: "guard", target: "卫兵", locked: true }] },
    { ...f.input, windows: [{ windowId: "other", ordinal: 0, blockIds: ["a"] }] },
  ]) assert.throws(() => f.frame.decode(value, changed), /stale/u);
});

test("unexposed and out-of-window evidence cannot authorize a decision", () => {
  const f = fixture();
  const hidden = evidenceReferences("source", "b", f.input.sources[1]!.sourceText)[0]!;
  f.issued.delete(hidden.id);
  assert.throws(() => f.frame.present({ id: hidden.id, text: hidden.text }), /unissued/u);
  assert.throws(() => f.decode(["revise", [[f.b, f.tb, "wrong"]], [], "wrong"]), /unissued/u);
  const input = { ...f.input, windows: [{ windowId: "w", ordinal: 0, blockIds: ["a"] }] };
  f.issued.add(hidden.id);
  const frame = new SupervisorValueFrame(input, f.issued);
  const target = evidenceReferences("target", "b", input.candidate![1]!.text)[0]!;
  const sourceNumber = frame.present({ id: hidden.id, text: hidden.text }).id;
  const targetNumber = frame.present({ id: target.id, text: target.text }).id;
  assert.throws(() => validateSupervisorDecision(frame.decode(["revise", [[sourceNumber, targetNumber, "outside"]], [], "outside"], input), input, f.issued), /scope/u);
});

test("plan tuples expand only a contiguous host prefix and its block selections", async () => {
  const f = fixture();
  f.input.event = "plan";
  f.input.windows = [{ windowId: "w1", ordinal: 0, blockIds: ["a"] }, { windowId: "w2", ordinal: 1, blockIds: ["b"] }];
  f.faux.setResponses([context => {
    const prompt = data(context);
    return fauxAssistantMessage(JSON.stringify({ values: [1, [prompt.windows[0].blockIds[0]], [[prompt.source[0].evidence[0].id, "Preserve negation."]], "First window."] }));
  }]);
  const result = await runSupervisor(f.input);
  assert.deepEqual(result.decision.windowIds, ["w1"]);
  assert.deepEqual(result.decision.reviewBlockIds, ["a"]);
  assert.equal(result.decision.guidance[0]?.sourceQuote, f.input.sources[0]!.sourceText);
  const frame = new SupervisorValueFrame(f.input, f.issued);
  for (const value of [[3, [], [], "bad"], [1.5, [], [], "bad"], [1, [2], [], "outside prefix"], [1, [1, 1], [], "duplicate"]]) {
    assert.throws(() => validateSupervisorDecision(frame.decode(value, f.input), f.input, f.issued));
  }
  assert.equal(validateSupervisorDecision(frame.decode([0, [], [], "Insufficient evidence."], f.input), f.input, f.issued).action, "pause");
});

test("dispositions retain the exact host issue order, grounding and changed-text requirement", () => {
  const f = fixture();
  f.input.priorIssues = f.input.sources.map((s, i) => ({ issueId: `issue-${i}`, blockId: s.blockId,
    sourceQuote: s.sourceText, targetQuote: f.input.candidate![i]!.text, problem: "Check wording." }));
  f.input.priorCandidate = f.input.candidate;
  const frame = new SupervisorValueFrame(f.input, f.issued);
  const valid = [["variant", f.a, f.ta, "Contextual rendering."], ["dismissed", f.b, f.tb, "Meaning preserved."]];
  const decode = (rows: unknown) => validateSupervisorDecision(frame.decode(["accept", [], rows, "Checked independently."], f.input), f.input, f.issued);
  assert.deepEqual(decode(valid).dispositions?.map(d => d.issueId), ["issue-0", "issue-1"]);
  assert.deepEqual(JSON.parse(supervisorPrompt(f.input)).priorIssues.map((p: any) => p.issueId), [1, 2]);
  for (const rows of [valid.slice(0, 1), [...valid, valid[0]], [valid[1], valid[0]],
    [["fixed", f.a, f.ta, "No actual edit."], valid[1]], [["variant", null, f.ta, "Ungrounded."], valid[1]]]) assert.throws(() => decode(rows));
});

test("queried evidence receives append-only short handles and final turn retains no query tools", async () => {
  const f = fixture();
  f.input.sources = [{ blockId: "a", globalIndex: 0, sourceText: "An ordinary sentence ends here. ".repeat(240) + "The secret phrase restores the missing reason." }];
  f.input.windows = [{ windowId: "w", ordinal: 0, blockIds: ["a"] }];
  f.input.candidate = [{ blockId: "a", text: "这里遗漏了原因。" }];
  f.input.maxTurns = 2;
  let targetNumber = 0, maxInitialNumber = 0;
  f.faux.setResponses([context => {
    const prompt = data(context);
    targetNumber = prompt.candidate[0].evidence[0].id;
    maxInitialNumber = Math.max(targetNumber, ...prompt.source[0].evidence.map((r: any) => r.id));
    return fauxAssistantMessage(fauxToolCall("search_source", { query: "secret phrase", limit: 1 }), { stopReason: "toolUse" });
  }, context => {
    assert.deepEqual(context.tools ?? [], []);
    const result = context.messages.findLast(m => m.role === "toolResult")!;
    const content = JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join(""));
    const ref = content.hits[0].evidence.find((r: any) => r.text.includes("secret phrase"));
    assert.ok(ref.id > maxInitialNumber);
    assert.equal(content.hits[0].blockId, 1);
    assert.equal(data(context).candidate[0].evidence[0].id, targetNumber);
    return fauxAssistantMessage(JSON.stringify({ values: ["revise", [[ref.id, targetNumber, "Restore the omitted reason."]], [], "Evidence found."] }));
  }]);
  const result = await runSupervisor(f.input);
  assert.match(result.decision.issues[0]!.sourceQuote, /secret phrase/u);
  assert.equal(result.run.modelCalls, 2);
  assert.deepEqual(result.run.toolNames, ["search_source"]);
});

test("read_source resolves short block numbers through the same host table", async () => {
  const f = fixture(); f.input.maxTurns = 2;
  f.faux.setResponses([context => fauxAssistantMessage(fauxToolCall("read_source", {
    blockId: data(context).source[0].blockId, start: 0, count: 40 }), { stopReason: "toolUse" }),
  context => {
    const result = context.messages.findLast(m => m.role === "toolResult")!;
    const body = JSON.parse(result.content.filter(c => c.type === "text").map(c => c.text).join(""));
    assert.equal(body.blockId, 1);
    assert.equal(body.evidence[0].id, data(context).source[0].evidence[0].id);
    return fauxAssistantMessage('{"values":["accept",[],[],"Checked."]}');
  }]);
  assert.equal((await runSupervisor(f.input)).decision.action, "accept");
});

test("invalid value responses keep real usage and never silently fall back to the old object protocol", async () => {
  for (const response of ['{"action":"accept","issues":[],"reason":"old shape"}', '["accept",[],[]]', '```json\n["accept",[],[],"ok"]\n```']) {
    const f = fixture(); let observedTokens = 0;
    f.input.onAssistantResponse = observation => { observedTokens += observation.assistantMessage.usage.totalTokens; };
    f.faux.setResponses([fauxAssistantMessage(response)]);
    await assert.rejects(() => runSupervisor(f.input), (error: unknown) => {
      assert.ok(error instanceof ModelProviderError && error.run);
      assert.equal(error.kind, "protocol");
      assert.ok(piRunUsageComplete(error.run));
      assert.equal(error.run.usage.totalTokens, observedTokens);
      assert.equal(error.run.modelCalls, 1);
      return true;
    });
  }
});

test("DeepSeek encloses value arrays in one fixed envelope with service JSON mode and original context", async () => {
  const f = fixture();
  f.input.decisionProtocol = "ordered_values";
  f.input.model = { ...f.input.model, provider: "folioloom-deepseek" };
  const original = f.input.streamFn;
  f.input.streamFn = bindTaskContext(async (model, context, options) => {
    assert.ok(context.systemPrompt?.startsWith("A synthetic authorized context."));
    assert.equal(options?.maxTokens, Math.min(32768, model.maxTokens));
    const wire: any = await options?.onPayload?.({ response_format: { type: "json_object" }, retained: true }, model);
    assert.deepEqual(wire.response_format, { type: "json_object" }); assert.equal(wire.retained, true);
    assert.ok(Number.isSafeInteger(data(context).source[0].evidence[0].id));
    return original(model, context, options);
  }, "A synthetic authorized context.");
  f.faux.setResponses([fauxAssistantMessage('{"values":["accept",[],[],"Checked."]}')]);
  assert.equal((await runSupervisor(f.input)).decision.action, "accept");
});

test("DeepSeek defaults to a one-argument native values finalizer without text JSON parsing", async () => {
  const f = fixture(); f.input.decisionProtocol = undefined;
  f.input.model = { ...f.input.model, provider: "folioloom-deepseek" };
  f.faux.setResponses([context => {
    const finalizer = context.tools?.find(t => t.name === "submit_supervisor_values");
    assert.ok(finalizer);
    assert.deepEqual(Object.keys((finalizer.parameters as any).properties), ["values"]);
    assert.ok(!context.tools?.some(t => t.name === "submit_supervisor_decision"));
    const p = data(context);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["revise",
      [[p.source[0].evidence[0].id, p.candidate[0].evidence[0].id, "Restore negation."]], [], "Meaning changed."] }), { stopReason: "toolUse" });
  }]);
  const result = await runSupervisor(f.input);
  assert.equal(result.decision.action, "revise"); assert.equal(result.run.modelCalls, 1);
  assert.deepEqual(result.run.toolNames, ["submit_supervisor_values"]);
  assert.ok(piRunUsageComplete(result.run));
});

test("value envelopes reject duplicate wrappers, extra keys, trailing prose and legacy bare arrays", async () => {
  for (const response of ['["accept",[],[],"Checked."]', '{"values":["accept",[],[],"ok"],"note":"extra"}',
    '{"values":{"values":["accept",[],[],"ok"]}}', '{"values":["accept",[],[],"ok"]}\n说明：已按协议输出。']) {
    const f = fixture(); f.faux.setResponses([fauxAssistantMessage(response)]);
    await assert.rejects(() => runSupervisor(f.input), (error: unknown) => {
      assert.ok(error instanceof ModelProviderError && error.run && piRunUsageComplete(error.run));
      assert.equal(error.run.modelCalls, 1); return true;
    });
  }
});

test("native values retain one bounded query round and reject forged handles or prose decisions", async () => {
  const f = fixture(); f.input.decisionProtocol = "ordered_values_tool"; f.input.maxTurns = 2;
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read_source", { blockId: 1, start: 0, count: 20 }), { stopReason: "toolUse" }), context => {
    assert.deepEqual(context.tools?.map(t => t.name), ["submit_supervisor_values"]);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["accept", [], [], "Checked."] }), { stopReason: "toolUse" });
  }]);
  assert.equal((await runSupervisor(f.input)).decision.action, "accept");
  for (const response of [fauxAssistantMessage('{"values":["accept",[],[],"not a tool"]}'),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["revise", [[9999, 1, "Forged."]], [], "bad"] }), { stopReason: "toolUse" })]) {
    const rejected = fixture(); rejected.input.decisionProtocol = "ordered_values_tool";
    rejected.faux.setResponses([response]);
    await assert.rejects(() => runSupervisor(rejected.input), (error: unknown) => {
      assert.ok(error instanceof ModelProviderError && error.run && piRunUsageComplete(error.run)); return true;
    });
  }
});
