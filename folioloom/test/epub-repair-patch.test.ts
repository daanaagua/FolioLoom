import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Repairer } from "../src/agents/repairer.js";
import { ModelProviderError, PiRuntime } from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { evidenceReferences } from "../src/domain/evidence-reference.js";
import { applyEpubRepairValues, applyEpubTextPatch, prepareEpubRepairPlan } from "../src/tools/epub-repair-patch.js";

const source = "⟦E0.0.0⟧The guard ⟦/E0.0.0⟧⟦E0.0.1⟧cannot⟦/E0.0.1⟧⟦E0.0.2⟧ leave.⟦/E0.0.2⟧\n\n⟦E0.1.0⟧The bell rang.⟦/E0.1.0⟧";
const target = "⟦E0.0.0⟧守卫⟦/E0.0.0⟧⟦E0.0.1⟧能⟦/E0.0.1⟧⟦E0.0.2⟧离开。⟦/E0.0.2⟧\n\n⟦E0.1.0⟧钟响了。⟦/E0.1.0⟧";
const blocks = [{ id: "b", sourceText: source, sourceHash: "source-hash", globalIndex: 0,
  legacyId: null, chapterId: null, chapterTitle: null, blockIndex: 0, tokenCount: 20 }];
const candidate = { translations: [{ blockId: "b", text: target }], notes: [], repaired: false };
const failures = [{ code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: "b", message: "Restore negation.", repairable: true,
  evidence: { sourceQuote: "cannot", targetQuote: "能", problem: "Restore negation." } }];

test("EPUB semantic repair accepts only ordered values and preserves every host marker", async () => {
  const faux = fauxProvider();
  let toolNames: string[] = [];
  faux.setResponses([(context) => {
    toolNames = context.tools?.map(t => t.name) ?? [];
    return fauxAssistantMessage('[null,"不能",null]');
  }]);
  const result = await new Repairer(new PiRuntime()).repairBatch({ blocks, failedCandidate: candidate, failures,
    budget: new BudgetLedger(), model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) });
  assert.deepEqual(toolNames, []);
  assert.equal(result.candidate?.translations[0]?.text, target.replace("⟧能⟦", "⟧不能⟦"));
  assert.equal(faux.state.callCount, 1);
});

test("EPUB text patches reject stale, duplicate, injected and out-of-scope edits atomically", () => {
  const plan = prepareEpubRepairPlan(blocks, candidate, failures)!;
  const edit = { blockId: "b", slotId: "E0.0.1", expectedText: "能", text: "不能" };
  const patch = { baseCandidateHash: plan.baseCandidateHash, patches: [edit], notes: [] };
  assert.throws(() => applyEpubTextPatch(plan, candidate, { ...patch, baseCandidateHash: "x" }), /stale/u);
  assert.throws(() => applyEpubTextPatch(plan, { ...candidate, translations: [{ blockId: "b", text: target + "changed" }] }, patch), /stale/u);
  assert.throws(() => applyEpubTextPatch(plan, candidate, { ...patch, patches: [edit, edit] }), /duplicate/u);
  assert.throws(() => applyEpubTextPatch(plan, candidate, { ...patch, patches: [edit, { ...edit, slotId: "E0.1.0", expectedText: "钟响了。" }] }), /unauthorized/u);
  assert.throws(() => applyEpubTextPatch(plan, candidate, { ...patch, patches: [{ ...edit, expectedText: "旧文本" }] }), /expected text/u);
  for (const text of ["⟦E0.0.1⟧不能", "不\n能", "不[[]]能"]) {
    assert.throws(() => applyEpubTextPatch(plan, candidate, { ...patch, patches: [{ ...edit, text }] }), /structural/u);
  }
  assert.equal(candidate.translations[0]!.text, target);
  assert.throws(() => prepareEpubRepairPlan(blocks, candidate, [{ ...failures[0]!, evidence: { ...failures[0]!.evidence, targetQuote: "不存在" } }]), /stale/u);
});

test("ordered values retain positions and reject malformed or stale arrays atomically", () => {
  const plan = prepareEpubRepairPlan(blocks, candidate, failures)!;
  const before = structuredClone(candidate);
  const good = applyEpubRepairValues(plan, candidate, [null, "不能", null]);
  assert.equal(good.translations[0]!.text, target.replace("⟧能⟦", "⟧不能⟦"));
  assert.deepEqual(good.notes, []);
  for (const values of [["不能"], [null, "不能", null, null], { values: [null, "不能", null] },
    [null, "不能", 42], [null, "不能", false], [null, "不能", {}], [null, "不能", undefined],
    [null, "不能", "⟦E0.1.0⟧"], [null, "不能", "\n"], [null, null, null], ["守卫", "能", "离开。"]]) {
    assert.throws(() => applyEpubRepairValues(plan, candidate, values));
    assert.deepEqual(candidate, before);
  }
  assert.throws(() => applyEpubRepairValues(plan, { ...candidate, translations: [{ blockId: "b", text: target + "变更" }] },
    [null, "不能", null]), /stale/u);
});

test("rejected terminal arrays preserve provider usage without another model call", async () => {
  for (const text of ['[null,"不能"]', '{"values":[null,"不能",null]}', '```json\n[null,"不能",null]\n```']) {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(text)]);
    let observedTokens = 0;
    await assert.rejects(new Repairer(new PiRuntime()).repairBatch({ blocks, failedCandidate: candidate, failures,
      budget: new BudgetLedger(), model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
      onAssistantResponse: observation => { observedTokens = observation.assistantMessage.usage.totalTokens; } }),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.kind, "protocol");
      assert.ok(observedTokens > 0);
      assert.equal(error.run?.usage.totalTokens, observedTokens);
      assert.equal(error.run?.modelCalls, 1);
      return true;
    });
    assert.equal(faux.state.callCount, 1);
  }
});

test("non-semantic repair retains its existing block tool", async () => {
  const faux = fauxProvider();
  faux.setResponses([(context) => {
    assert.deepEqual(context.tools?.map(t => t.name), ["submit_repaired_translation"]);
    return fauxAssistantMessage(fauxToolCall("submit_repaired_translation", {
      translations: [{ blockId: "b", text: "守卫不能离开。" }], notes: [],
    }), { stopReason: "toolUse" });
  }]);
  const result = await new Repairer(new PiRuntime()).repairBatch({
    blocks: [{ ...blocks[0]!, sourceText: "The guard cannot leave." }],
    failedCandidate: { ...candidate, translations: [{ blockId: "b", text: "守卫能离开。" }] },
    failures: [{ ...failures[0]!, code: "TRANSLATION_VALIDATION" }],
    budget: new BudgetLedger(), model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) });
  assert.equal(result.candidate?.translations[0]?.text, "守卫不能离开。");
});

test("grounded plain-text semantic repair also returns only ordered paragraph values", async () => {
  const faux = fauxProvider();
  faux.setResponses([(context) => {
    assert.deepEqual(context.tools?.map(t => t.name) ?? [], []);
    return fauxAssistantMessage('["守卫不能离开。"]');
  }]);
  const result = await new Repairer(new PiRuntime()).repairBatch({
    blocks: [{ ...blocks[0]!, sourceText: "The guard cannot leave.\n\nThe bell rang." }],
    failedCandidate: { ...candidate, translations: [{ blockId: "b", text: "守卫能离开。\n\n钟响了。" }] },
    failures: [{ ...failures[0]!, evidence: { ...failures[0]!.evidence,
      sourceScopeQuote: "The guard cannot leave.", targetScopeQuote: "守卫能离开。" } }],
    budget: new BudgetLedger(), model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) });
  assert.equal(result.candidate?.translations[0]?.text, "守卫不能离开。\n\n钟响了。");
});

test("multi-slot EPUB patches preserve CRLF, astral characters, plain neighbors and fixed breaks", () => {
  const sourceText = "A neighbor.\r\n\r\n⟦E2.1.0⟧Aster ⟦/E2.1.0⟧⟦E2.1.1⟧did not⟦/E2.1.1⟧⟦E2.1.2⟧⟦/E2.1.2⟧⟦E2.1.3⟧ speak.⟦/E2.1.3⟧\r\n\r\n";
  const text = "邻句😀。\r\n\r\n⟦E2.1.0⟧阿斯特⟦/E2.1.0⟧⟦E2.1.1⟧曾⟦/E2.1.1⟧⟦E2.1.2⟧⟦/E2.1.2⟧⟦E2.1.3⟧说过话。⟦/E2.1.3⟧\r\n\r\n";
  const input = { ...candidate, translations: [{ blockId: "b", text }] };
  const plan = prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }], input, [{ ...failures[0]!,
    evidence: { sourceQuote: "did not speak.", targetQuote: "曾说过话。", problem: "Restore negation." } }])!;
  assert.equal(plan.slots.some(s => s.slotId === "E2.1.2"), false);
  const fixed = applyEpubTextPatch(plan, input, { baseCandidateHash: plan.baseCandidateHash, notes: [], patches: [
    { blockId: "b", slotId: "E2.1.1", expectedText: "曾", text: "没有" },
    { blockId: "b", slotId: "E2.1.3", expectedText: "说过话。", text: "说话。" },
  ] });
  assert.equal(fixed.translations[0]!.text, text.replace("⟧曾⟦", "⟧没有⟦").replace("说过话。", "说话。"));
});

test("repeated focus is bounded by its grounded context instead of guessing a global occurrence", () => {
  const sourceText = "⟦E0.0.0⟧A bell rang.⟦/E0.0.0⟧\n\nLark waited.\n\nLark answered.\n\nA lark flew away.";
  const text = "⟦E0.0.0⟧钟响了。⟦/E0.0.0⟧\n\n云雀等着。\n\n云雀回答了。\n\n一只云雀飞走了。";
  const current = { ...candidate, translations: [{ blockId: "b", text }] };
  const scoped = [{ ...failures[0]!, evidence: { sourceQuote: "Lark", targetQuote: "云雀", problem: "Use the character's name.",
    sourceScopeQuote: "Lark waited.\n\nLark answered.", targetScopeQuote: "云雀等着。\n\n云雀回答了。" } }];
  const plan = prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }], current, scoped)!;
  assert.deepEqual(plan.slots.map(s => s.slotId), ["P1", "P2"]);
  const fixed = applyEpubRepairValues(plan, current, ["拉克等着。", "拉克回答了。"]);
  assert.equal(fixed.translations[0]!.text, text.replace("云雀等着。", "拉克等着。").replace("云雀回答了。", "拉克回答了。"));
  for (const targetScopeQuote of ["不存在", "钟响了。", "云雀"]) {
    assert.throws(() => prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }], current,
      [{ ...scoped[0]!, evidence: { ...scoped[0]!.evidence, targetScopeQuote } }]));
  }
  assert.throws(() => prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }], current,
    [{ ...scoped[0]!, evidence: { sourceQuote: "Lark", targetQuote: "云雀", problem: "Use the character's name." } }]), /ambiguous/u);
});

test("host evidence identity locates one repeated paragraph without a global text search", () => {
  const sourceText = "The first guard could not leave.\n\nThe second guard could not leave.";
  const repeated = "守卫能离开，随后站到门口。他望着街上，等待下一班巡逻队归来。".repeat(6);
  const text = `${repeated}\n\n${repeated}`;
  const current = { ...candidate, translations: [{ blockId: "b", text }] };
  const sourceRef = evidenceReferences("source", "b", sourceText)[0]!;
  const refs = evidenceReferences("target", "b", text);
  const targetRef = refs.find(r => r.start > Array.from(repeated).length && r.text.includes("守卫能离开"))!;
  assert.ok(targetRef);
  const issues = [{ ...failures[0]!, evidence: { sourceQuote: sourceRef.text, targetQuote: targetRef.text,
    sourceRef: sourceRef.id, targetRef: targetRef.id, problem: "Restore the second guard's negation." } }];
  const plan = prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }], current, issues)!;
  assert.deepEqual(plan.paragraphs.filter(p => p.editable).map(p => p.ordinal), [1]);
  assert.throws(() => prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }],
    { ...current, translations: [{ blockId: "b", text: text + "变更" }] }, issues), /stale/u);
});

test("a missing translation fragment is localized by its host source reference", () => {
  const first = "A patient observer waited at the gate and watched the empty road for the returning guards. ".repeat(3);
  const second = "The second guard could not leave because he had promised to wait beside the old gate until sunset. ".repeat(3);
  const sourceText = `${first}\n\n${second}`;
  const current = { ...candidate, translations: [{ blockId: "b", text: "观察者在门口等待。\n\n第二名守卫在门口。" }] };
  const ref = evidenceReferences("source", "b", sourceText).find(r => r.start > first.length + 2)!;
  assert.ok(ref);
  const plan = prepareEpubRepairPlan([{ ...blocks[0]!, sourceText }], current, [{ ...failures[0]!, evidence: {
    sourceRef: ref.id, targetRef: "", sourceQuote: ref.text, targetQuote: "", problem: "Restore the omitted reason." } }])!;
  assert.deepEqual(plan.slots.map(s => s.slotId), ["P1"]);
});
