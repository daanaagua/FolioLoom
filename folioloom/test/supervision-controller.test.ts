import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SupervisionController } from "../src/fullbook/supervision-controller.js";
import { AdmissionController } from "../src/fullbook/admission-controller.js";
import { TokenLedger } from "../src/fullbook/token-ledger.js";
import { type SupervisionRecord, summarizeSupervision } from "../src/domain/supervision.js";

function fixture() {
  const faux = fauxProvider();
  const records: SupervisionRecord[] = [];
  const ledger = TokenLedger.create({ mode: "off", profile: "balanced", tokenIncreaseCap: 0.1, enforceDispatchLifecycle: true });
  const controller = new SupervisionController({
    runId: "run", sourceVersion: "source", windows: [{ windowId: "w1", ordinal: 0, blockIds: ["b1"] }, { windowId: "w2", ordinal: 1, blockIds: ["b2"] }],
    sources: [{ blockId: "b1", globalIndex: 0, sourceText: "He did not leave." }, { blockId: "b2", globalIndex: 1, sourceText: "He waited." }],
    runtime: { model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) },
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
    answer(plan), answer({ ...plan, action: "revise", windowIds: ["w1"], reviewBlockIds: [], reason: "否定丢失。", issues: [{ blockId: "b1", sourceQuote: "did not leave", targetQuote: "他离开了", problem: "必须保留否定。" }] }),
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
