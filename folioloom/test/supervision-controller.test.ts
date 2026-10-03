import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SupervisionController } from "../src/fullbook/supervision-controller.js";
import { AdmissionController } from "../src/fullbook/admission-controller.js";
import { TokenLedger } from "../src/fullbook/token-ledger.js";
import { type SupervisionRecord, summarizeSupervision } from "../src/domain/supervision.js";
import { evidenceReferences } from "../src/domain/evidence-reference.js";

function fixture(options: { sourceText?: string; contextWindow?: number } = {}) {
  const faux = fauxProvider();
  const records: SupervisionRecord[] = [];
  const ledger = TokenLedger.create({ mode: "off", profile: "balanced", tokenIncreaseCap: 0.1, enforceDispatchLifecycle: true });
  const controller = new SupervisionController({
    runId: "run", sourceVersion: "source", windows: [{ windowId: "w1", ordinal: 0, blockIds: ["b1"] }, { windowId: "w2", ordinal: 1, blockIds: ["b2"] }],
    sources: [{ blockId: "b1", globalIndex: 0, sourceText: options.sourceText ?? "He did not leave." }, { blockId: "b2", globalIndex: 1, sourceText: options.sourceText ?? "He waited." }],
    runtime: { model: { ...faux.getModel(), ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}) }, streamFn: faux.provider.streamSimple.bind(faux.provider) },
    admission: new AdmissionController({ ledger, mode: "off", persist: event => ledger.apply(event) }),
    store: { supervisionRecords: () => structuredClone(records), appendSupervisionRecord: (_run, r) => { records.push(structuredClone(r)); } },
  });
  return { faux, records, ledger, controller };
}
const plan = { action: "translate", windowIds: ["w1", "w2"], reviewBlockIds: ["b1"], guidance: [], issues: [], reason: "审校否定。" };

test("batch approvals survive a new controller and do not generate another model call", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" })]);
  assert.equal((await f.controller.planFor("w1", []))?.action, "translate");
  assert.equal((await f.controller.planFor("w2", []))?.action, "translate");
  assert.equal(f.faux.state.callCount, 1);
  assert.ok(f.ledger.reconcile().consistent);
  assert.ok(f.ledger.state().spentTokens > 0);
  assert.equal(f.records.filter(r => r.state === "completed").length, 1);
});

test("grounded review issues request repair; only accepted exact candidate satisfies the audit", async () => {
  const f = fixture();
  const answer = (value: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" });
  f.faux.setResponses([
    answer(plan), answer({ ...plan, action: "revise", windowIds: ["w1"], reviewBlockIds: [], reason: "否定丢失。", issues: [{ blockId: "b1", sourceRef: evidenceReferences("source", "b1", "He did not leave.")[0]!.id, targetRef: evidenceReferences("target", "b1", "他离开了。")[0]!.id, problem: "必须保留否定。" }] }),
    answer({ ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [], reason: "修复正确。" }),
  ]);
  await f.controller.planFor("w1", []);
  const bad = [{ blockId: "b1", text: "他离开了。" }];
  assert.equal((await f.controller.review("w1", bad, []))[0]?.code, "SUPERVISOR_SEMANTIC_REVIEW");
  const good = [{ blockId: "b1", text: "他并没有离开。" }];
  assert.deepEqual(await f.controller.review("w1", good, []), []);
  assert.deepEqual(await f.controller.review("w1", good, []), []);
  const windows = [{ windowId: "w1", blockIds: ["b1"], status: "completed" }];
  assert.deepEqual(summarizeSupervision("bounded", f.records, windows, good).pendingReviewWindowIds, []);
  assert.deepEqual(summarizeSupervision("bounded", f.records, windows, bad).pendingReviewWindowIds, ["w1"]);
  assert.equal(f.faux.state.callCount, 3);
});

test("a paused checkpoint cannot charge another call on an ordinary resume", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { ...plan, action: "pause", reviewBlockIds: [], reason: "约束冲突。" }), { stopReason: "toolUse" })]);
  await assert.rejects(() => f.controller.planFor("w1", []), /SUPERVISION_PAUSED/u);
  await assert.rejects(() => f.controller.planFor("w1", []), /SUPERVISION_PAUSED/u);
  assert.equal(f.faux.state.callCount, 1);
});

test("changing terminology invalidates a cached plan and replaces old guidance", async () => {
  const f = fixture();
  const first = { ...plan, guidance: [{ blockId: "b1", sourceRef: evidenceReferences("source", "b1", "He did not leave.")[0]!.id, instruction: "称为旅人。" }] };
  const next = { ...plan, guidance: [] };
  f.faux.setResponses([first, next].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "旅人" }]);
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "守门人", locked: true }]);
  assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual(f.controller.guidanceFor(["w1"]), []);
});

test("retrying supervision cannot expand its own baseline envelope", async () => {
  const f = fixture();
  f.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" }),
  ]);
  await assert.rejects(() => f.controller.planFor("w1", []), /Unauthorized/u);
  const baseline = f.ledger.state().baselineTokens;
  await f.controller.planFor("w1", []);
  assert.equal(f.ledger.state().baselineTokens, baseline, "a retry spends the original envelope instead of creating new baseline work");
});

test("an accepted candidate cannot reuse review approval after terminology changes", async () => {
  const f = fixture();
  const answer = (value: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" });
  f.faux.setResponses([answer(plan), answer({ ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] }), answer(plan)]);
  const good = [{ blockId: "b1", text: "他没有离开。" }];
  const before = [{ sourceForm: "He", target: "他" }];
  await f.controller.planFor("w1", before);
  await f.controller.review("w1", good, before);
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "旅人" }]);
  assert.deepEqual(summarizeSupervision("bounded", f.records, [{ windowId: "w1", blockIds: ["b1"], status: "completed" }], good).pendingReviewWindowIds, ["w1"]);
});

test("a narrower new plan cannot inherit old guidance through its sibling window", async () => {
  const f = fixture();
  const first = { ...plan, guidance: [{ blockId: "b1", sourceRef: evidenceReferences("source", "b1", "He did not leave.")[0]!.id, instruction: "称为旅人。" }] };
  const next = { ...plan, windowIds: ["w1"], guidance: [] };
  f.faux.setResponses([first, next].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "旅人" }]);
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "守门人" }]);
  assert.deepEqual(f.controller.guidanceFor(["w1", "w2"]), []);
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "旅人" }]);
  assert.equal(f.controller.guidanceFor(["w1"])[0]?.instruction, "称为旅人。");
  assert.equal(f.faux.state.callCount, 2, "reactivating an identical plan does not call the provider");
});

test("planning shrinks an oversized batch before dispatch instead of stopping a legal window", async () => {
  const f = fixture({ sourceText: "the traveler waited beside the door. ".repeat(140), contextWindow: 50_000 });
  f.faux.setResponses([context => {
    const user = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const data = JSON.parse(prompt);
    assert.equal(data.windows.length, 1);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { ...plan, windowIds: ["w1"] }), { stopReason: "toolUse" });
  }]);
  assert.deepEqual((await f.controller.planFor("w1", [])).windowIds, ["w1"]);
  assert.equal(f.faux.state.callCount, 1);
});

test("revalidation refreshes only the affected window's terminology dependency", async () => {
  const f = fixture();
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses([plan, accept, accept].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  const before = [{ sourceForm: "He", target: "他" }];
  const after = [{ sourceForm: "He", target: "旅人" }];
  await f.controller.planFor("w1", before);
  await f.controller.review("w1", [{ blockId: "b1", text: "他没有离开。" }], before);
  const candidate = [{ blockId: "b1", text: "旅人没有离开。" }];
  await f.controller.review("w1", candidate, after);
  assert.deepEqual(summarizeSupervision("bounded", f.records, [{ windowId: "w1", blockIds: ["b1"], status: "completed" }], candidate).pendingReviewWindowIds, []);
  const refreshed = f.records.findLast(r => r.event === "plan" && r.state === "completed")!;
  assert.deepEqual(refreshed.windowIds, ["w1"]);
  assert.equal(refreshed.modelCalls, 0);
  assert.equal(f.faux.state.callCount, 3);
});
