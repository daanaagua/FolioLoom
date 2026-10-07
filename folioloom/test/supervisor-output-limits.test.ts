import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createProviderRuntime } from "../src/providers/runtime.js";
import { supervisorModelFor, supervisorOutputTokenLimit } from "../src/agents/supervisor.js";
import { SupervisionController } from "../src/fullbook/supervision-controller.js";
import { AdmissionController } from "../src/fullbook/admission-controller.js";
import { TokenLedger, type LedgerEvent } from "../src/fullbook/token-ledger.js";
import type { SupervisionRecord } from "../src/domain/supervision.js";

test("DeepSeek review has a 64K envelope while translation and planning retain their defaults", async () => {
  const runtime = createProviderRuntime({ providerId: "deepseek", modelId: "deepseek-flash", reasoningEffort: "high" }, "fixture-secret");
  assert.equal(runtime.model.maxTokens, 37_200);
  assert.equal(runtime.model.contextWindow, 128_000);
  const review = { model: runtime.model, event: "review" as const };
  const selected = supervisorModelFor(review);
  assert.equal(selected.maxTokens, 65_536);
  assert.equal(selected.contextWindow, 1_000_000);
  assert.equal(supervisorOutputTokenLimit(review), 65_536);
  assert.equal(supervisorOutputTokenLimit({ ...review, event: "plan" }), 32_768);
  assert.equal(supervisorModelFor({ ...review, event: "plan" }), runtime.model);
  for (const reviewPhase of [false, true]) {
    let wire: any;
    const stream = await runtime.streamFn(reviewPhase ? selected : runtime.model,
      { messages: [{ role: "user", content: "A synthetic wire fixture.", timestamp: 0 }] }, {
        ...(reviewPhase ? { maxTokens: supervisorOutputTokenLimit(review) } : {}),
        onPayload(payload) { wire = payload; throw new Error("stop before network"); },
      });
    await stream.result();
    assert.equal(wire.max_tokens, reviewPhase ? 65_536 : 37_200);
    assert.equal(wire.reasoning_effort, "high");
  }
  const small = { ...runtime.model, reviewLimits: undefined, maxTokens: 16_000 };
  assert.equal(supervisorOutputTokenLimit({ event: "review", model: small }), 16_000);
});

test("review admission reserves the same larger output envelope that reaches the wire", async () => {
  const faux = fauxProvider(), records: SupervisionRecord[] = [], events: LedgerEvent[] = [];
  const native = createProviderRuntime({ providerId: "deepseek", modelId: "deepseek-flash", reasoningEffort: "high" }, "fixture-secret");
  const ledger = TokenLedger.create({ mode: "off", profile: "balanced", tokenIncreaseCap: 0.1, enforceDispatchLifecycle: true });
  faux.setResponses([context => {
    const m = context.messages.find(m => m.role === "user")!;
    const p = JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: ["accept", [], [], "Checked."] }), { stopReason: "toolUse" });
  }]);
  let wireLimit = 0;
  const controller = new SupervisionController({ runId: "run", sourceVersion: "source",
    windows: [{ windowId: "w", ordinal: 0, blockIds: ["b"] }], sources: [{ blockId: "b", globalIndex: 0, sourceText: "The guard waited." }],
    runtime: { model: native.model, thinkingLevel: "high", streamFn: (model, context, options) => {
      wireLimit = options!.maxTokens!;
      assert.equal(model.maxTokens, 65_536);
      return faux.provider.streamSimple(model, context, options);
    } },
    admission: new AdmissionController({ ledger, mode: "off", persist: event => { events.push(event); ledger.apply(event); } }),
    store: { supervisionRecords: () => structuredClone(records), appendSupervisionRecord: (_run, record) => records.push(record) },
  });
  await controller.reviewFinal("a".repeat(64), "w", [{ blockId: "b", text: "守卫等着。" }], []);
  assert.equal(wireLimit, 65_536);
  const reservation = events.find(e => e.type === "reserved")!;
  assert.equal(reservation.type, "reserved");
  assert.ok(reservation.predictedTokens >= 2 * (20_000 + wireLimit));
  assert.ok(ledger.reconcile().consistent);
  assert.equal(records.filter(r => r.state === "started").length, 1);
});
