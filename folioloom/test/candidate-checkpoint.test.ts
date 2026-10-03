import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { TranslationRequestInput } from "../src/agents/translation-request.js";
import type { TranslationBatchWindowResult } from "../src/agents/translation-batch.js";
import { CandidateCheckpointService, type CandidateCheckpointRecord } from "../src/fullbook/candidate-checkpoint.js";

function fixture() {
  const sourceText = "The traveler waited. The door stayed closed.";
  const input: TranslationRequestInput = {
    request: { requestId: "request", sourceTokens: 12, windows: [{ windowId: "w", ordinal: 0, chapterId: "chapter", chapterTitle: null,
      blockIds: ["b"], globalIndexes: [0], sourceTokens: 12, sourceChars: sourceText.length, oversized: false }] },
    blocks: [{ id: "b", sourceVersion: "source", canonicalStart: 0, canonicalEnd: sourceText.length,
      sourceText, sourceHash: createHash("sha256").update(sourceText).digest("hex"), globalIndex: 0, tokenCount: 12, structureId: null, structureTitle: null }],
    stableTerms: [], snapshot: { id: "snapshot", revisions: [] },
  };
  const candidate: TranslationBatchWindowResult = { windowId: "w", ordinal: 0, status: "completed",
    translations: [{ blockId: "b", text: "旅人等在原地。门始终紧闭着。" }], termUsages: [], memoryCandidates: [], notes: [] };
  const records: CandidateCheckpointRecord[] = [];
  const store = {
    candidateCheckpointRecords: (_run: string, window: string) => structuredClone(records.filter(r => r.windowId === window)),
    appendCandidateCheckpoint: (_run: string, record: CandidateCheckpointRecord) => {
      if (!records.some(r => r.id === record.id)) records.push(structuredClone(record));
    },
  };
  const service = () => new CandidateCheckpointService({ runId: "run", sourceVersion: "source", modelId: "model", store });
  return { input, candidate, records, service };
}

test("candidate checkpoints survive reconstruction but invalidate on semantic dependencies", () => {
  const f = fixture();
  f.service().save(f.input, f.candidate);
  f.service().save(f.input, f.candidate);
  assert.equal(f.records.length, 1);
  assert.deepEqual(f.service().load(f.input, "w"), f.candidate);
  for (const changed of [
    { ...f.input, snapshot: { id: "next-snapshot", revisions: [{ kind: "memory", fact: "the traveler is the keeper" }] } },
    { ...f.input, styleState: { tone: "formal" } },
    { ...f.input, stableTerms: [{ conceptId: "traveler", lexemeId: "traveler", sourceForm: "traveler", canonicalSource: "traveler", target: "行者", locked: true }] },
  ]) assert.equal(f.service().load(changed, "w"), undefined);
  assert.deepEqual(f.service().load({ ...f.input, request: { ...f.input.request, requestId: "repacked-request" } }, "w"), f.candidate);
});

test("snapshot lineage alone does not invalidate an identical knowledge projection", () => {
  const f = fixture();
  f.service().save(f.input, f.candidate);
  assert.deepEqual(f.service().load({ ...f.input, snapshot: { id: "next-lineage-node", revisions: [] } }, "w"), f.candidate);
});

test("candidate repair credit survives restart and an unchanged repair makes no progress", () => {
  const f = fixture();
  f.service().save(f.input, f.candidate);
  f.service().claimRepair(f.input, [f.candidate]);
  assert.throws(() => f.service().claimRepair(f.input, [f.candidate]), /credit exhausted/u);
  assert.throws(() => f.service().save(f.input, f.candidate, "repaired"), /no text progress/u);
  assert.deepEqual(f.service().load(f.input, "w"), f.candidate);
});

test("invalid or tampered checkpoint content is never reusable", () => {
  const f = fixture();
  assert.throws(() => f.service().save(f.input, { ...f.candidate, translations: [{ blockId: "other", text: "越界。" }] }), /scope/u);
  f.service().save(f.input, f.candidate);
  f.records[0]!.candidate.translations[0]!.text = "被修改。";
  assert.throws(() => f.service().load(f.input, "w"), /invalid candidate checkpoint/u);
});

test("a boundary-rejected candidate is discarded rather than replayed forever", () => {
  const f = fixture();
  f.service().save(f.input, f.candidate);
  f.service().discardWindow("w");
  assert.equal(f.service().load(f.input, "w"), undefined);
  const replacement = { ...f.candidate, translations: [{ blockId: "b", text: "旅人在那里等待，门一直没有打开。" }] };
  f.service().save(f.input, replacement);
  assert.deepEqual(f.service().load(f.input, "w"), replacement);
});
