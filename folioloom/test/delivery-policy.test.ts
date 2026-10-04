import assert from "node:assert/strict";
import test from "node:test";
import { QualityQueue, resolveDeliveryMode, type QualityRecord } from "../src/fullbook/delivery-policy.js";

function fixture() {
  const records: QualityRecord[] = [];
  const journal = {
    qualityRecords: () => structuredClone(records),
    appendQualityRecord: (_run: string, record: QualityRecord) => {
      if (!records.some(r => r.id === record.id)) records.push(structuredClone(record));
    },
  };
  const queue = () => new QualityQueue("run", journal);
  const input = { windowId: "w", candidateHash: "a".repeat(64), issues: [
    { code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: "b", issueKey: "issue", message: "Negation remains ambiguous.", repairable: true },
  ] };
  return { records, queue, input };
}

test("new runs default to standard; legacy runs keep strict unless explicitly changed", () => {
  assert.equal(resolveDeliveryMode(undefined, undefined, false), "standard");
  assert.equal(resolveDeliveryMode(undefined, undefined, true), "strict");
  assert.equal(resolveDeliveryMode(undefined, "standard", true), "standard");
  assert.equal(resolveDeliveryMode("standard", undefined, true), "standard");
  assert.equal(resolveDeliveryMode("strict", "standard", true), "strict");
});

test("quality queue preserves evidence and consumes final review credit before dispatch", () => {
  const f = fixture();
  const item = f.queue().defer(f.input);
  assert.deepEqual(item.issues, f.input.issues);
  assert.equal(f.queue().items()[0]?.state, "pending");
  assert.equal(f.queue().defer(f.input).id, item.id);
  assert.equal(f.queue().defer({ ...f.input, candidateHash: "c".repeat(64) }).itemId, item.itemId);
  assert.equal(f.records.length, 1);
  assert.equal(f.queue().claimFinal(item.itemId).state, "reviewing");
  assert.throws(() => f.queue().claimFinal(item.itemId), /already consumed/u);
  f.queue().finish(item.itemId, "unresolved", f.input.candidateHash, f.input.issues);
  assert.equal(f.queue().items()[0]?.state, "unresolved");
  assert.throws(() => f.queue().claimFinal(item.itemId), /already consumed/u);
});

test("queue cannot waive hard validation or replace evidence after finalization", () => {
  const f = fixture();
  assert.throws(() => f.queue().defer({ ...f.input, issues: [
    { code: "missing_block", message: "Missing source coverage", repairable: true },
  ] }), /semantic/u);
  const item = f.queue().defer(f.input);
  assert.throws(() => f.queue().finish(item.itemId, "resolved", f.input.candidateHash, []), /not reviewing/u);
  f.queue().claimFinal(item.itemId);
  assert.throws(() => f.queue().finish(item.itemId, "resolved", "b".repeat(64), []), /closure/u);
  f.queue().finish(item.itemId, "unresolved", "b".repeat(64), f.input.issues);
  assert.equal(f.queue().items()[0]?.state, "unresolved");
  assert.throws(() => f.queue().finish(item.itemId, "unresolved", f.input.candidateHash, f.input.issues), /not reviewing/u);
});

test("interrupted final pass remains spent and tampered evidence fails closed", () => {
  const f = fixture();
  const item = f.queue().defer(f.input);
  f.queue().claimFinal(item.itemId);
  f.queue().recoverInterrupted();
  assert.equal(f.queue().items()[0]?.state, "blocked");
  assert.throws(() => f.queue().claimFinal(item.itemId), /already consumed/u);
  (f.records[0]!.issues[0] as { message: string }).message = "tampered";
  assert.throws(() => f.queue().items(), /invalid quality record/u);
});
