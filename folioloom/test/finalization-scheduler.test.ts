import assert from "node:assert/strict";
import test from "node:test";
import { runFinalizationTasks, finalQualityScopes } from "../src/fullbook/finalization-scheduler.js";

test("invalid finalization scopes reject before any sibling starts", async () => {
  let started = false;
  await assert.rejects(() => runFinalizationTasks([{ scopes: ["valid"], run: async () => { started = true; } },
    { scopes: [], run: async () => {} }], 2), /scope/u);
  assert.equal(started, false);
});

test("finalization overlaps independent tasks, retains dependency order and drains before failure", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const events: string[] = [];
  let finished = false;
  const run = runFinalizationTasks([
    { scopes: ["a"], run: async () => { events.push("a"); await started.promise; throw new Error("provider failed"); } },
    { scopes: ["b"], run: async () => { events.push("b"); started.resolve(); await release.promise; events.push("b-end"); } },
    { scopes: ["a"], run: async () => { events.push("must-not-start"); } },
  ], 2);
  const failed = assert.rejects(run, /provider failed/).then(() => { finished = true; });
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, "the store cannot close while a sibling is still writing receipts");
  release.resolve(); await failed;
  assert.deepEqual(events, ["a", "b", "b-end"]);
});

test("repair locks include every potential source-bound comparison block", () => {
  const blocks = [{ blockId: "a", sourceText: "The lyceum stood." }, { blockId: "b", sourceText: "The lyceum closed." },
    { blockId: "c", sourceText: "The bell rang." }];
  const scopes = finalQualityScopes(["a"], [{ evidence: { sourceQuote: "The lyceum stood.", problem: "Use 学馆 for lyceum." } }], blocks);
  assert.deepEqual(scopes, ["block:a", "block:b"]);
  assert.deepEqual(finalQualityScopes(["c"], [{ evidence: { sourceQuote: "The bell rang.", problem: "Restore negation." } }], blocks), ["block:c"]);
  assert.deepEqual(finalQualityScopes(["a"], [{ message: '原文 "The lyceum stood."；当前译文 "学校矗立着。"；问题：Use 学馆 for lyceum.。只修正该实质问题。' }], blocks), ["block:a", "block:b"]);
});

test("a comparison reader cannot overlap a writer of its evidence", async () => {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const run = runFinalizationTasks([
    { scopes: ["block:a", "block:b"], run: async () => { events.push("read"); await gate.promise; events.push("read-end"); } },
    { scopes: ["block:b"], run: async () => { events.push("write"); } },
    { scopes: ["block:c"], run: async () => { events.push("independent"); gate.resolve(); } },
  ], 2);
  await run;
  assert.deepEqual(events, ["read", "independent", "read-end", "write"]);
});
