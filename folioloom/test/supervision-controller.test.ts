import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SupervisionController } from "../src/fullbook/supervision-controller.js";
import { AdmissionController } from "../src/fullbook/admission-controller.js";
import { TokenLedger } from "../src/fullbook/token-ledger.js";
import { type SupervisionRecord, summarizeSupervision, supervisorIssueFailures } from "../src/domain/supervision.js";
import { evidenceReferences, paragraphEvidenceReferences } from "../src/domain/evidence-reference.js";
import { AutomaticRecovery, type RecoveryRecord } from "../src/fullbook/automatic-recovery.js";
import { prepareEpubRepairPlan } from "../src/tools/epub-repair-patch.js";

function fixture(options: { sourceText?: string; contextWindow?: number; maxConcurrency?: number; valueWire?: boolean; windowCount?: number;
  getTargetContext?: () => readonly { blockId: string; text: string }[] } = {}) {
  const faux = fauxProvider();
  const records: SupervisionRecord[] = [];
  const recoveries: RecoveryRecord[] = [];
  const ledger = TokenLedger.create({ mode: "off", profile: "balanced", tokenIncreaseCap: 0.1, enforceDispatchLifecycle: true });
  const controller = new SupervisionController({
    maxConcurrency: options.maxConcurrency,
    getTargetContext: options.getTargetContext,
    runId: "run", sourceVersion: "source", windows: Array.from({ length: options.windowCount ?? 2 }, (_, i) => ({ windowId: `w${i + 1}`, ordinal: i, blockIds: [`b${i + 1}`] })),
    sources: Array.from({ length: options.windowCount ?? 2 }, (_, i) => ({ blockId: `b${i + 1}`, globalIndex: i, sourceText: options.sourceText ?? (i === 0 ? "He did not leave." : "He waited.") })),
    runtime: { model: { ...faux.getModel(), ...(options.valueWire ? { provider: "folioloom-deepseek" } : {}), ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}) }, streamFn: faux.provider.streamSimple.bind(faux.provider) },
    admission: new AdmissionController({ ledger, mode: "off", persist: event => ledger.apply(event) }),
    recovery: new AutomaticRecovery({ runId: "run", store: { recoveryRecords: () => recoveries,
      appendRecoveryRecord: (_run, record) => { recoveries.push(record); } }, sleep: async () => {} }),
    store: { supervisionRecords: () => structuredClone(records), appendSupervisionRecord: (_run, r) => { records.push(structuredClone(r)); } },
  });
  return { faux, records, recoveries, ledger, controller };
}
const plan = { action: "translate", windowIds: ["w1", "w2"], reviewBlockIds: ["b1"], guidance: [], issues: [], reason: "审校否定。" };

test("distinct guidance on one current passage retains each readonly supporting reference", async () => {
  const f = fixture();
  const sourceRef = paragraphEvidenceReferences("source", "b1", "He did not leave.")[0]!.id;
  const referenceSourceRef = paragraphEvidenceReferences("source", "b2", "He waited.")[0]!.id;
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { ...plan, windowIds: ["w1"], guidance: [
    { blockId: "b1", sourceRef, referenceSourceRef, instruction: "Keep the same referent as the comparison." },
    { blockId: "b1", sourceRef, instruction: "Preserve the negation independently of the referent." },
  ] }), { stopReason: "toolUse" })]);
  const decision = await f.controller.planFor("w1", []);
  assert.equal(decision.guidance.length, 2);
  assert.deepEqual(f.controller.guidanceFor(["w1"]), decision.guidance);
  assert.deepEqual(f.controller.guidanceFor(["w2"]), [], "a reference cannot become another window's instruction");
  const cached = await f.controller.planFor("w1", []);
  assert.deepEqual(cached.guidance, decision.guidance);
  assert.equal(f.faux.state.callCount, 1);
});

test("bookkeeping-only term revisions cannot invalidate semantic plans or reviews", async () => {
  const f = fixture();
  f.faux.setResponses([plan, { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] }]
    .map(decision => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", decision), { stopReason: "toolUse" })));
  const before = [{ sourceForm: "He", target: "他", conceptId: "local-concept", lexemeId: "local-lexeme", revisionId: "rev-1", origin: "knowledge" as const }];
  const after = [{ ...before[0]!, revisionId: "rev-2", renderFingerprint: "stored-fingerprint", origin: "knowledge" as const }];
  const candidate = [{ blockId: "b1", text: "他没有离开。" }];
  await f.controller.planFor("w1", before);
  await f.controller.review("w1", candidate, before);
  await f.controller.planFor("w1", after);
  await f.controller.review("w1", candidate, after);
  assert.equal(f.faux.state.callCount, 2);
});

test("final repair reviews retain changed paragraphs, neighbors and all open issues", async () => {
  const sourceText = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}. The traveler waited.`).join("\n\n");
  const f = fixture({ sourceText });
  const text = Array.from({ length: 10 }, (_, i) => `第${i}段，旅人等候。`).join("\n\n");
  let calls = 0;
  const reply = (context: import("@earendil-works/pi-ai").Context) => {
    const user = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join(""));
    calls++;
    assert.equal(!!p.reviewFocus, calls === 2);
    if (calls === 2) assert.equal(p.candidate[0].evidence.length, 3);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] }), { stopReason: "toolUse" });
  };
  f.faux.setResponses([reply, reply]);
  await f.controller.reviewFinal("d".repeat(64), "w1", [{ blockId: "b1", text }], []);
  await f.controller.reviewFinal("d".repeat(64), "w1", [{ blockId: "b1", text: text.replace("第4段", "第四段") }], []);
  assert.equal(f.faux.state.callCount, 2);
});

for (const changed of ["none", "candidate", "terms", "comparison", "unread_context", "issues"] as const) {
test(`chapter repair authorization requires unchanged dependencies (${changed})`, async () => {
  const targets = [{ blockId: "b1", text: "他离开了。" }, { blockId: "b2", text: "他等着。" }];
  const f = fixture({ getTargetContext: () => targets });
  const terms = [{ sourceForm: "He", target: "他" }];
  f.faux.setResponses([...(changed === "comparison" ? [fauxAssistantMessage(fauxToolCall("search_target", { query: "waited", limit: 4 }), { stopReason: "toolUse" })] : []),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
    ...plan, action: "revise", windowIds: ["w1"], reviewBlockIds: [], issues: [{ blockId: "b1",
      sourceRef: paragraphEvidenceReferences("source", "b1", "He did not leave.")[0]!.id,
      targetRef: paragraphEvidenceReferences("target", "b1", targets[0]!.text)[0]!.id, problem: "Restore negation." }],
  }), { stopReason: "toolUse" }), context => {
    const user = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join(""));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { ...plan, action: "revise", windowIds: ["w1"], reviewBlockIds: [],
      dispositions: p.priorIssues.map((i: any) => ({ issueId: i.issueId, status: "unresolved", sourceRef: p.source[0].evidence[0].id,
        targetRef: p.candidate[0].evidence[0].id, note: "Restore negation." })) }), { stopReason: "toolUse" });
  }]);
  await f.controller.reviewChapter("e".repeat(64), "Chapter", ["w1"], terms);
  const chapterCalls = f.faux.state.callCount;
  const issues = supervisorIssueFailures(f.records.findLast(r => r.state === "completed")!.decision!.issues);
  if (changed === "candidate") targets[0]!.text = "旅人离开了。";
  if (changed === "terms") terms[0]!.target = "旅人";
  if (changed === "comparison" || changed === "unread_context") targets[1]!.text = "旅人等候。";
  if (changed === "issues") issues[0]!.evidence!.problem = "A different issue.";
  const failures = await f.controller.reviewFinal("f".repeat(64), "w1", targets.slice(0, 1), terms, issues, targets.slice(0, 1));
  assert.equal(failures.length, 1);
  assert.equal(f.faux.state.callCount, chapterCalls + (changed === "none" || changed === "unread_context" ? 0 : 1));
  if (changed === "none") {
    assert.equal(f.controller.finalClosure("f".repeat(64), targets.slice(0, 1)), undefined, "repair authorization is not closure");
    await f.controller.reviewFinal("f".repeat(64), "w1", targets.slice(0, 1), terms, issues, targets.slice(0, 1));
    assert.equal(f.faux.state.callCount, 2, "a no-change repair still requires a real closure judgment");
  }
});
}

test("chapter review splits nine small windows into four-window scopes even with ample context", async () => {
  const targets = Array.from({ length: 9 }, (_, i) => ({ blockId: `b${i + 1}`, text: "他等着。" }));
  const f = fixture({ windowCount: 9, contextWindow: 1_000_000, getTargetContext: () => targets });
  const batches: string[][] = [];
  f.faux.setResponses(Array.from({ length: 3 }, () => context => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
    const ids = p.windows.map((w: any) => w.windowId);
    batches.push(ids); assert.ok(ids.length <= 4);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { action: "accept", windowIds: ids,
      reviewBlockIds: [], guidance: [], issues: [], reason: "Checked complete scope." }), { stopReason: "toolUse" });
  }));
  let remaining = targets.map((_, i) => `w${i + 1}`);
  while (remaining.length) {
    const result = await f.controller.reviewChapter("c".repeat(64), "Long chapter", remaining, []);
    remaining = remaining.filter(id => !result.windowIds.includes(id));
  }
  assert.deepEqual(batches.map(b => b.length), [4, 4, 1]);
  assert.equal(f.ledger.state().tokenUsageComplete, true);
  assert.ok(f.ledger.reconcile().consistent);
});

test("supervisor local target-context rejection occurs before usage dispatch or reservation", async () => {
  const f = fixture({ getTargetContext: () => [{ blockId: "b1", text: "他等着。" }, { blockId: "outside", text: "无关。" }] });
  await assert.rejects(() => f.controller.reviewChapter("a".repeat(64), "Chapter", ["w1"], []), /target context outside/u);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.ledger.state().spentTokens, 0);
  assert.equal(f.ledger.state().tokenUsageComplete, true);
  assert.equal(f.records.length, 0);
  assert.ok(f.ledger.reconcile().consistent);
});

test("chapter lexical hints stay read-only, scope-filtered and part of the decision cache identity", async () => {
  const f = fixture({ getTargetContext: () => [{ blockId: "b1", text: "木柱。" }, { blockId: "b2", text: "木棒。" }] });
  const hint = { sourceForm: "tallyrod", proposedTarget: "木柱", classification: "ordinary_word", readOnly: true as const,
    occurrences: [{ blockId: "b1", paragraphIndex: 0, sourceStart: 0 }], examples: [{ blockId: "b1", paragraphIndex: 0, sourceExcerpt: "He waited.", targetExcerpt: "木柱。" }] };
  const response = (context: import("@earendil-works/pi-ai").Context) => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
    assert.equal(p.lexicalReviewHints.length, 1);
    assert.equal(p.lexicalReviewHints[0].sourceForm, "tallyrod");
    assert.equal(p.lexicalReviewHints[0].readOnly, true);
    assert.doesNotMatch(JSON.stringify(p.lexicalReviewHints) + p.lexicalReviewInstruction, /confidence|置信度/u);
    assert.deepEqual(p.stableTerms, []);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { action: "accept", windowIds: ["w1"], reviewBlockIds: [],
      guidance: [], issues: [], reason: "Read-only evidence checked." }), { stopReason: "toolUse" });
  };
  f.faux.setResponses([response, response]);
  const outside = { ...hint, sourceForm: "outside", occurrences: [{ blockId: "b2", paragraphIndex: 0, sourceStart: 0 }] };
  await f.controller.reviewChapter("b".repeat(64), "Chapter", ["w1"], [], [hint, outside]);
  await f.controller.reviewChapter("b".repeat(64), "Chapter", ["w1"], [], [{ ...hint, proposedTarget: "筹杆" }, outside]);
  assert.equal(f.faux.state.callCount, 2);
});

test("complete current responses retain bounded protocol recovery despite unknown historical usage", async () => {
  const f = fixture();
  f.ledger.apply({ type: "reserved", requestId: "old", purpose: "supervision", taskIds: [], predictedTokens: 100, attempt: 0 });
  f.ledger.apply({ type: "dispatched", requestId: "old" });
  f.ledger.apply({ type: "settled", requestId: "old", actualTokens: 0, usageComplete: false, outcome: "failed" });
  f.faux.setResponses([fauxAssistantMessage("Missing the decision tool."),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" })]);
  assert.equal((await f.controller.planFor("w1", [])).action, "translate");
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.ledger.state().tokenUsageComplete, false, "old unknown usage is not waived");
  assert.equal(f.records.filter(r => r.state === "failed").length, 1);
});

test("repair execution receives the current grounded direction without rewriting the original finding", async () => {
  const f = fixture({ sourceText: "A night chough landed." });
  const candidate = [{ blockId: "b1", text: "一只夜山鸦落了下来。" }];
  const prior = [{ issueKey: "bird", code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: "b1", repairable: true,
    message: "Original rendering concern.", evidence: { sourceQuote: "A night chough landed.", targetQuote: candidate[0]!.text,
      problem: "Historical proposal: change 夜鸦 to 夜山鸦." } }];
  const frozen = structuredClone(prior);
  const note = "Use 夜鸦 for this particular bird to preserve the established local convention.";
  f.faux.setResponses([context => {
    const m = context.messages.find(m => m.role === "user")!;
    const p = JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { action: "revise", windowIds: ["w1"],
      reviewBlockIds: [], guidance: [], issues: [], dispositions: [{ issueId: "bird", status: "unresolved",
        sourceRef: p.source[0].evidence[0].id, targetRef: p.candidate[0].evidence[0].id, note }], reason: "Use current grounded direction." }), { stopReason: "toolUse" });
  }]);
  const failures = await f.controller.reviewFinal("d".repeat(64), "w1", candidate, [], prior, candidate);
  assert.equal(failures[0]!.evidence?.repairInstruction, note);
  assert.deepEqual(prior, frozen);
});

for (const grounded of [false, true]) {
test(`final rework refreshes stale repair evidence only from current grounded review (grounded=${grounded})`, async () => {
  const source = "The old tower remained closed.\n\nThe bell rang.";
  const old = "旧塔楼开着。\n\n钟响了。", current = "旧灯塔开着。\n\n钟响了。";
  const f = fixture({ sourceText: source });
  const s = paragraphEvidenceReferences("source", "b1", source)[0]!, stale = paragraphEvidenceReferences("target", "b1", old)[0]!;
  const fresh = paragraphEvidenceReferences("target", "b1", current)[0]!;
  const prior = [{ issueKey: "closed-tower", code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: "b1", repairable: true,
    message: "The tower must remain closed.", evidence: { sourceRef: s.id, sourceQuote: s.text, sourceScopeQuote: s.text,
      targetRef: stale.id, targetQuote: stale.text, targetScopeQuote: stale.text, problem: "The tower must remain closed." } }];
  const saved = structuredClone(prior);
  f.faux.setResponses([context => {
    const m = context.messages.find(m => m.role === "user")!;
    const p = JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { action: grounded ? "revise" : "accept", windowIds: ["w1"],
      reviewBlockIds: [], guidance: [], issues: grounded ? [{ blockId: "b1", sourceRef: p.source[0].evidence[0].id,
        targetRef: p.candidate[0].evidence[0].id, problem: "Preserve the closed tower in this current paragraph." }] : [],
      dispositions: [{ issueId: "closed-tower", status: "unresolved", sourceRef: grounded ? p.source[0].evidence[0].id : "",
        targetRef: grounded ? p.candidate[0].evidence[0].id : "", note: "The original finding is not resolved." }], reason: "Checked current evidence." }), { stopReason: "toolUse" });
  }]);
  const candidate = [{ blockId: "b1", text: current }];
  const failures = await f.controller.reviewFinal("e".repeat(64), "w1", candidate, [], prior, candidate);
  assert.deepEqual(prior, saved, "historical issues are immutable");
  assert.equal(failures[0]!.issueKey, "closed-tower");
  assert.equal(f.controller.finalClosure("e".repeat(64), candidate)?.dispositions[0]?.status, "unresolved");
  const blocks = [{ id: "b1", sourceText: source, sourceHash: "source", globalIndex: 0, legacyId: null,
    chapterId: null, chapterTitle: null, blockIndex: 0, tokenCount: 20 }];
  const translated = { translations: candidate, notes: [], repaired: false };
  if (grounded) {
    assert.equal(failures[0]!.evidence?.targetRef, fresh.id);
    assert.equal(failures[0]!.evidence?.targetScopeQuote, fresh.text);
    const patch = prepareEpubRepairPlan(blocks, translated, failures)!;
    assert.deepEqual(patch.paragraphs.filter(p => p.editable).map(p => p.ordinal), [0]);
  } else {
    assert.equal(failures[0]!.evidence?.targetRef, stale.id);
    assert.throws(() => prepareEpubRepairPlan(blocks, translated, failures), /stale/u);
  }
});
}

test("chapter review checks every sibling's lifetime limit before dispatch", async () => {
  const f = fixture({ getTargetContext: () => [{ blockId: "b1", text: "他没有离开。" }, { blockId: "b2", text: "他等着。" }] });
  for (let i = 0; i < 12; i++) f.records.push({ id: `spent-${i}`, key: `spent-${i}`, event: "review", state: "started",
    inputHash: "a".repeat(64), windowIds: ["w2"] });
  await assert.rejects(() => f.controller.reviewChapter("b".repeat(64), "Chapter 1", ["w1", "w2"], []), /budget exhausted/u);
  assert.equal(f.faux.state.callCount, 0);
});

test("an oversized chapter is split at whole-window boundaries within the original context capacity", async () => {
  const f = fixture({ sourceText: "a quiet passage. ".repeat(1000), contextWindow: 100_000,
    getTargetContext: () => [{ blockId: "b1", text: "一段安静的文字。".repeat(900) }, { blockId: "b2", text: "一段安静的文字。".repeat(900) }] });
  f.faux.setResponses([(context) => {
    const m = context.messages.findLast(m => m.role === "user")!;
    const data = JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
    assert.deepEqual(data.windows.map((w: any) => w.windowId), ["w1"]);
    assert.equal(data.candidate.length, 1);
    assert.ok(data.chapterReview);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
      action: "accept", windowIds: ["w1"], reviewBlockIds: [], guidance: [], issues: [], reason: "Checked." }), { stopReason: "toolUse" });
  }]);
  const result = await f.controller.reviewChapter("c".repeat(64), "Chapter 1", ["w1", "w2"], []);
  assert.deepEqual(result.windowIds, ["w1"]);
  assert.equal(f.faux.state.callCount, 1);
});

test("legacy review projection receipts cannot bypass a fresh complete-paragraph review", async () => {
  const f = fixture();
  const accepted = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses([plan, accepted, accepted].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), {stopReason:"toolUse"})));
  await f.controller.planFor("w1", []);
  const candidate = [{blockId:"b1",text:"他没有离开。"}];
  await f.controller.review("w1", candidate, []);
  for (const r of f.records) delete (r as any).evidenceProjectionVersion;
  await f.controller.review("w1", candidate, []);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal(f.records.filter(r=>r.event==='review'&&r.state==='started').length, 2);
});

test("final review binds committed comparison versions without changing ordinary plan identity", async () => {
  let context = [{ blockId: "b2", text: "他等着。" }];
  const f = fixture({ getTargetContext: () => context });
  const accept = { action: "accept", windowIds: ["w1"], reviewBlockIds: [], guidance: [], issues: [], reason: "Checked." };
  const response = (c: import("@earendil-works/pi-ai").Context) => {
    assert.ok(c.tools?.some(t => t.name === "search_target"));
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", accept), { stopReason: "toolUse" });
  };
  f.faux.setResponses([response, response]);
  const candidate = [{ blockId: "b1", text: "他没有离开。" }];
  await f.controller.reviewFinal("a".repeat(64), "w1", candidate, []);
  await f.controller.reviewFinal("a".repeat(64), "w1", candidate, []);
  assert.equal(f.faux.state.callCount, 1);
  context = [{ blockId: "b2", text: "他等待着。" }];
  await f.controller.reviewFinal("a".repeat(64), "w1", candidate, []);
  assert.equal(f.faux.state.callCount, 2, "changed comparison text cannot reuse a stale final verdict");
  assert.equal(new Set(f.records.filter(r => r.state === "started").map(r => r.inputHash)).size, 2);
  assert.ok(f.ledger.reconcile().consistent);
});

test("explicit supervision release scopes automatic recovery to the same durable generation", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" })]);
  await f.controller.planFor("w1", []);
  f.recoveries.push({ id: "old-block", scope: "supervision:review:w1", action: "supervisor_retry",
    fingerprint: "a".repeat(64), state: "blocked", at: Date.now(), reason: "repeated_fault" });
  const candidate = [{ blockId: "b1", text: "他没有离开。" }];
  await assert.rejects(() => f.controller.review("w1", candidate, []), /AUTOMATIC_RECOVERY_PAUSED/u);
  assert.equal(f.faux.state.callCount, 1);
  f.controller.pauseCandidate("w1", "Addressed transport failure.");
  const pause = f.records.findLast(r => r.state === "paused")!;
  f.records.push({ ...pause, id: `release:${pause.id}`, key: pause.id, state: "released" });
  f.faux.setResponses([fauxAssistantMessage("invalid terminal"), fauxAssistantMessage(fauxToolCall("submit_supervisor_decision",
    { action: "accept", windowIds: ["w1"], reviewBlockIds: [], guidance: [], issues: [], reason: "Checked source." }), { stopReason: "toolUse" })]);
  assert.deepEqual(await f.controller.review("w1", candidate, []), []);
  assert.equal(f.recoveries[0]!.id, "old-block");
  assert.ok(f.recoveries.some(r => r.state === "claimed" && r.scope === "supervision:review:w1:generation-1"));
  assert.equal(f.records.filter(r => r.event === "review" && r.state === "started").length, 2);
});

test("value-wire retry receives bounded diagnostic feedback without renewing its checkpoint or baseline", async () => {
  const f = fixture({ valueWire: true });
  f.faux.setResponses([fauxAssistantMessage('{"values":[2,[],[]]}'), fauxAssistantMessage("Still no native receipt."), context => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const prompt = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
    assert.match(prompt.protocolFeedback, /valid bounded decision/u);
    assert.ok(prompt.protocolFeedback.length <= 400);
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_values", { values: [2, [], [], "Checked both windows."] }), { stopReason: "toolUse" });
  }]);
  assert.equal((await f.controller.planFor("w1", [])).action, "translate");
  const attempts = f.records.filter(r => r.state === "started");
  assert.equal(attempts.length, 2);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal(new Set(attempts.map(r => r.inputHash)).size, 1);
  assert.equal(f.ledger.state().baselinedTaskIds.size, 1);
  assert.ok(f.records.filter(r => r.state === "completed" || r.state === "failed").every(r => r.wireProtocol === "folioloom-supervisor-values-tool-1"));
  assert.ok(f.ledger.reconcile().consistent);
  assert.equal(f.ledger.state().spentTokens, f.records.reduce((n, r) => n + (r.totalTokens ?? 0), 0));
});

test("native channel correction shares the original checkpoint, token baseline and attempt limit", async () => {
  const f = fixture({ valueWire: true });
  f.faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("No native receipt.")));
  await assert.rejects(() => f.controller.planFor("w1", []), /valid bounded decision/u);
  assert.equal(f.faux.state.callCount, 4);
  assert.equal(f.records.filter(r => r.state === "started").length, 2);
  assert.equal(f.ledger.state().baselinedTaskIds.size, 1);
  assert.ok(f.ledger.reconcile().consistent);
  assert.equal(f.ledger.state().spentTokens, f.records.reduce((n, r) => n + (r.totalTokens ?? 0), 0));
  await assert.rejects(() => f.controller.planFor("w1", []));
  assert.equal(f.faux.state.callCount, 4);
});

test("mixed metered and unmetered supervisor responses block retry and retain incomplete ledger", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("search_source", { query: "He", limit: 1 }), { stopReason: "toolUse" }),
    () => { throw new Error("503 service unavailable"); }]);
  await assert.rejects(() => f.controller.planFor("w1", []));
  assert.equal(f.faux.state.callCount, 2);
  assert.ok(f.ledger.state().spentTokens > 0);
  assert.equal(f.ledger.state().tokenUsageComplete, false);
  assert.equal(f.records.find(r => r.state === "failed")?.usageComplete, false);
});

for (const disposition of ["dismissed", "variant", "unresolved"] as const) {
  test(`grounded quality disposition closes without a mandatory second vote: ${disposition}`, async () => {
    const f = fixture();
    const candidate = [{ blockId: "b1", text: "他没有离开。" }];
    const prior = [{ issueKey: "old-negation", code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: "b1", repairable: true,
      message: "核对否定。", evidence: { sourceQuote: "He did not leave.", targetQuote: "他没有离开。", problem: "核对否定。" } }];
    const reply = (context: import("@earendil-works/pi-ai").Context) => {
      const message = context.messages.findLast(m => m.role === "user")!;
      const data = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      assert.equal(data.priorIssues.length, 1);
      assert.equal(data.qualityReviewStage, "disposition");
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { action: "accept", windowIds: ["w1"],
        reviewBlockIds: [], guidance: [], issues: [], reason: "核对原文否定。", dispositions: [{ issueId: "old-negation",
          status: disposition,
          sourceRef: data.source[0].evidence[0].id, targetRef: data.candidate[0].evidence[0].id, note: "现译文保留否定。" }] }), { stopReason: "toolUse" });
    };
    f.faux.setResponses([reply, reply]);
    const qualityId = "a".repeat(64);
    assert.equal((await f.controller.reviewFinal(qualityId, "w1", candidate, [], prior)).length, disposition === "unresolved" ? 1 : 0);
    assert.equal(f.faux.state.callCount, 1);
    const closure = f.controller.finalClosure(qualityId, candidate)!;
    assert.equal(closure.dispositions[0]?.status, disposition);
    assert.equal(closure.policy, "issue-closure-2");
    assert.equal(closure.verificationDecisionId, undefined);
    await f.controller.reviewFinal(qualityId, "w1", candidate, [], prior);
    assert.equal(f.faux.state.callCount, 1, "cached disposition must not replenish or spend another call");
    assert.ok(f.ledger.reconcile().consistent);
  });
}

test("a separate repair does not reopen an accepted contextual rendering or exhaust closure credit", async () => {
  const f = fixture({ sourceText: "He used the short name.\n\nThe soldiers waited." });
  const before = [{ blockId: "b1", text: "他用了简称。\n\n骑兵等着。" }];
  const after = [{ blockId: "b1", text: "他用了简称。\n\n士兵等着。" }];
  const prior = [{ issueKey: "short-name", code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: "b1", repairable: true,
    message: "Check the short name.", evidence: { sourceQuote: "He used the short name.", targetQuote: "他用了简称。", problem: "Check the short name." } }];
  const reply = (context: import("@earendil-works/pi-ai").Context) => {
    const m = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(""));
    assert.equal(p.qualityReviewStage, "disposition");
    const wrong = p.candidate[0].evidence[1].text.includes("骑兵");
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
      action: wrong ? "revise" : "accept", windowIds: ["w1"], reviewBlockIds: [], guidance: [], reason: "Check only material meaning.",
      issues: wrong ? [{ blockId: "b1", sourceRef: p.source[0].evidence[1].id, targetRef: p.candidate[0].evidence[1].id, problem: "Use soldiers." }] : [],
      dispositions: [{ issueId: "short-name", status: wrong ? "variant" : "dismissed", sourceRef: p.source[0].evidence[0].id,
        targetRef: p.candidate[0].evidence[0].id, note: "The short name is appropriate here." }],
    }), { stopReason: "toolUse" });
  };
  f.faux.setResponses([reply, reply]);
  const id = "d".repeat(64);
  const issues = await f.controller.reviewFinal(id, "w1", before, [], prior, before);
  assert.equal(issues.length, 1);
  assert.notEqual(issues[0]!.issueKey, "short-name");
  assert.ok(f.controller.canReview("w1", id));
  assert.deepEqual(await f.controller.reviewFinal(id, "w1", after, [], prior, before), []);
  assert.equal(f.controller.finalClosure(id, after)?.dispositions[0]?.status, "dismissed");
  assert.equal(f.faux.state.callCount, 2);
  assert.ok(f.controller.canReview("w1", id));
});

test("independent reviews overlap while duplicate review shares the completed receipt", { timeout: 3000 }, async () => {
  const f = fixture({ maxConcurrency: 2 });
  const release = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  let active = 0, peak = 0;
  const review = async (context: import("@earendil-works/pi-ai").Context) => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const content = typeof message.content === "string" ? message.content
      : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const data = JSON.parse(content);
    active++; peak = Math.max(peak, active);
    if (active === 2) bothStarted.resolve();
    await release.promise;
    active--;
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
      ...plan, action: "accept", windowIds: data.windows.map((w: { windowId: string }) => w.windowId), reviewBlockIds: [],
    }), { stopReason: "toolUse" });
  };
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", { ...plan, reviewBlockIds: ["b1", "b2"] }), { stopReason: "toolUse" }), review, review]);
  await f.controller.planFor("w1", []);
  const first = f.controller.review("w1", [{ blockId: "b1", text: "他没有离开。" }], []);
  const duplicate = f.controller.review("w1", [{ blockId: "b1", text: "他没有离开。" }], []);
  const second = f.controller.review("w2", [{ blockId: "b2", text: "他等着。" }], []);
  await bothStarted.promise;
  assert.equal(f.faux.state.callCount, 3);
  release.resolve();
  await Promise.all([first, duplicate, second]);
  assert.equal(peak, 2);
  assert.equal(f.faux.state.callCount, 3);
  assert.ok(f.ledger.reconcile().consistent);
  assert.equal(f.ledger.state().spentTokens, f.records.reduce((n, r) => n + (r.totalTokens ?? 0), 0));
});

test("unrelated terminology cannot invalidate a cached plan or accepted review", async () => {
  const f = fixture();
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses([plan, accept].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  const terms = [{ sourceForm: "He", target: "他" }];
  await f.controller.planFor("w1", terms);
  const candidate = [{ blockId: "b1", text: "他并没有离开。" }];
  await f.controller.review("w1", candidate, terms);
  const changed = [...terms, { sourceForm: "Distant City", target: "远城", locked: true }];
  assert.equal((await f.controller.planFor("w2", changed)).action, "translate");
  assert.deepEqual(await f.controller.review("w1", candidate, changed), []);
  assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual(summarizeSupervision("bounded", f.records, [{ windowId: "w1", blockIds: ["b1"], status: "completed" }], candidate).pendingReviewWindowIds, []);
});

test("a sibling's terminology change invalidates its plan without invalidating an unchanged window's review", async () => {
  const f = fixture();
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses([plan, accept, { ...plan, windowIds: ["w2"], reviewBlockIds: ["b2"] }].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  await f.controller.planFor("w1", []);
  const candidate = [{ blockId: "b1", text: "他并没有离开。" }];
  await f.controller.review("w1", candidate, []);
  const terms = [{ sourceForm: "waited", target: "等待", applicableBlockIds: ["b2"] }];
  await f.controller.planFor("w2", terms);
  assert.deepEqual(await f.controller.review("w1", candidate, terms), []);
  assert.equal(f.faux.state.callCount, 3);
  assert.deepEqual(summarizeSupervision("bounded", f.records, [{ windowId: "w1", blockIds: ["b1"], status: "completed" }], candidate).pendingReviewWindowIds, []);
});

test("supervisor retries a transient provider response within the original attempt and token envelope", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" })]);
  assert.equal((await f.controller.planFor("w1", [])).action, "translate");
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.recoveries.filter(r => r.action === "supervisor_retry").length, 1);
  assert.equal(f.ledger.state().spentTokens, f.records.reduce((n, r) => n + (r.totalTokens ?? 0), 0));
  assert.ok(f.ledger.reconcile().consistent);
});

test("missing supervisor receipt receives one automatic protocol retry with exact accounting", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage("I checked the passage."),
    fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" })]);
  assert.equal((await f.controller.planFor("w1", [])).action, "translate");
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.records.filter(record => record.state === "failed").length, 1);
  assert.equal(f.ledger.state().spentTokens, f.records.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0));
  assert.ok(f.ledger.reconcile().consistent);
});

test("repeated missing supervisor receipts exhaust the existing checkpoint budget", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage("No receipt."), fauxAssistantMessage("Still no receipt.")]);
  await assert.rejects(() => f.controller.planFor("w1", []), /SUPERVISION_EXECUTION_FAILED/u);
  assert.equal(f.faux.state.callCount, 2);
  await assert.rejects(() => f.controller.planFor("w1", []), /SUPERVISION_PAUSED/u);
  assert.equal(f.faux.state.callCount, 2);
});

test("final review refreshes changed terminology without inheriting stale approval", async () => {
  const f = fixture();
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses([plan, accept].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  await f.controller.planFor("w1", [{ sourceForm: "He", target: "他" }]);
  const candidate = [{ blockId: "b1", text: "旅人没有离开。" }];
  await f.controller.reviewFinal("a".repeat(64), "w1", candidate, [{ sourceForm: "He", target: "旅人" }]);
  assert.deepEqual(summarizeSupervision("bounded", f.records, [{ windowId: "w1", blockIds: ["b1"], status: "completed" }], candidate).pendingReviewWindowIds, []);
});

test("releasing an ordinary pause cannot replenish a final-review epoch", async () => {
  const f = fixture();
  const itemId = "b".repeat(64);
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", accept), { stopReason: "toolUse" })));
  for (const text of ["他没有离开。", "他一直没有离开。", "他并没有离开。"]) await f.controller.reviewFinal(itemId, "w1", [{ blockId: "b1", text }], []);
  assert.equal(f.controller.canReview("w1", itemId), false);
  f.records.push({ id: "release", key: "unrelated-pause", event: "review", state: "released", windowIds: ["w1"], inputHash: "a".repeat(64) });
  assert.equal(f.controller.canReview("w1", itemId), false);
  await assert.rejects(() => f.controller.reviewFinal(itemId, "w1", [{ blockId: "b1", text: "旅人没有离开。" }], []), /SUPERVISION_PAUSED/u);
  assert.equal(f.faux.state.callCount, 3);
});

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
  const failures = await f.controller.review("w1", bad, []);
  assert.equal(failures[0]?.code, "SUPERVISOR_SEMANTIC_REVIEW");
  assert.equal(failures[0]?.evidence?.sourceScopeQuote, "He did not leave.");
  assert.equal(failures[0]?.evidence?.targetScopeQuote, "他离开了。");
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

test("a repaired candidate uses durable paragraph deltas and identical deltas do not spend another call", async () => {
  const sourceText = Array.from({ length: 8 }, (_, i) => `Paragraph ${i}. ${"The traveler waited. ".repeat(16)}`).join("\n\n");
  const f = fixture({ sourceText });
  const text = Array.from({ length: 8 }, (_, i) => `第${i}段。${"旅人等着。".repeat(45)}`).join("\n\n");
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  let fullBytes = 0;
  const reply = (delta: boolean) => (context: import("@earendil-works/pi-ai").Context) => {
    const user = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const data = JSON.parse(prompt);
    assert.equal(!!data.reviewFocus, delta);
    if (!delta) fullBytes = prompt.length;
    else assert.ok(prompt.length < fullBytes, "delta payload must actually be smaller");
    return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", accept), { stopReason: "toolUse" });
  };
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", plan), { stopReason: "toolUse" }), reply(false), reply(true)]);
  await f.controller.planFor("w1", []);
  await f.controller.review("w1", [{ blockId: "b1", text }], []);
  const repaired = [{ blockId: "b1", text: text.replace("第4段", "第四段") }];
  await f.controller.review("w1", repaired, []);
  await f.controller.review("w1", repaired, []);
  assert.equal(f.faux.state.callCount, 3);
});

test("dependency epochs reserve repair review without resetting the lifetime ceiling", async () => {
  const f = fixture();
  const accept = { ...plan, action: "accept", windowIds: ["w1"], reviewBlockIds: [] };
  f.faux.setResponses([plan, ...Array.from({ length: 12 }, () => accept)].map(value => fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", value), { stopReason: "toolUse" })));
  await f.controller.planFor("w1", []);
  for (let epoch = 0; epoch < 4; epoch++) {
    const terms = [{ sourceForm: "He", target: `人物${epoch}` }];
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(f.controller.canReview("w1", undefined, terms), true);
      await f.controller.review("w1", [{ blockId: "b1", text: `人物${epoch}没有离开${attempt}。` }], terms);
    }
    assert.equal(f.controller.canReview("w1", undefined, terms), false);
  }
  assert.equal(f.controller.canReview("w1", undefined, [{ sourceForm: "He", target: "新人物" }]), false);
  assert.equal(f.faux.state.callCount, 13);
  assert.ok(f.ledger.reconcile().consistent);
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
