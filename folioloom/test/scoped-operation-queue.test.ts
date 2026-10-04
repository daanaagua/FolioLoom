import assert from "node:assert/strict";
import test from "node:test";
import { ScopedOperationQueue } from "../src/fullbook/scoped-operation-queue.js";

test("independent scopes overlap, conflicting scopes stay ordered and capacity is bounded", async () => {
  const queue = new ScopedOperationQueue(2);
  const releaseA = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  const events: string[] = [];
  const a = queue.run(["a"], async () => { events.push("a1"); await releaseA.promise; events.push("a1-end"); });
  const again = queue.run(["a"], async () => { events.push("a2"); });
  const b = queue.run(["b"], async () => { events.push("b"); await releaseB.promise; });
  const c = queue.run(["c"], async () => { events.push("c"); });
  await Promise.resolve();
  assert.deepEqual(events, ["a1", "b"]);
  releaseB.resolve(); await b;
  await c;
  assert.deepEqual(events, ["a1", "b", "c"]);
  releaseA.resolve(); await Promise.all([a, again]);
  assert.deepEqual(events.slice(-2), ["a1-end", "a2"]);
});

test("queued multi-window operations cannot be overtaken on a shared scope and failures release locks", async () => {
  const queue = new ScopedOperationQueue(3);
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const a = queue.run(["a"], () => release.promise);
  const ab = queue.run(["a", "b"], async () => { events.push("ab"); throw new Error("failure"); });
  const failure = assert.rejects(ab, /failure/);
  const b = queue.run(["b"], async () => { events.push("b"); });
  await Promise.resolve(); assert.deepEqual(events, []);
  release.resolve(); await Promise.all([a, failure, b]);
  assert.deepEqual(events, ["ab", "b"]);
});
