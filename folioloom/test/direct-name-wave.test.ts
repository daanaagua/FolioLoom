import assert from "node:assert/strict";
import test from "node:test";
import { DirectNameWave } from "../src/fullbook/direct-name-wave.js";
import { directHash, type DirectRecord } from "../src/fullbook/direct-translation.js";

test("a durable naming wave waits for its members, then chooses source order, not completion order", async () => {
  const records: DirectRecord[] = [];
  const waveRecord: DirectRecord = { id: "wave", kind: "name_wave", key: directHash("wave"), windowId: "a", at: 1, payload: { windowIds: ["a", "b"], names: [] } };
  const append = (r: DirectRecord) => { records.push(r); };
  const wave = new DirectNameWave(waveRecord, records, append);
  let released = false;
  const b = wave.collect("b", [{ source: "Mira", target: "蜜拉" }]).then(n => { released = true; return n; });
  await Promise.resolve(); assert.equal(released, false);
  const a = await wave.collect("a", [{ source: "Mira", target: "米拉" }]);
  assert.deepEqual(a, [{ source: "Mira", target: "米拉" }]); assert.deepEqual(await b, a);
  const resumed = new DirectNameWave(waveRecord, records, append);
  assert.deepEqual(await resumed.collect("b", [{ source: "Mira", target: "另一译名" }]), a);
  assert.equal(records.filter(r => r.kind === "name_plan").length, 1);
});

test("a failed wave releases waiting peers without publishing a partial decision", async () => {
  const records: DirectRecord[] = [];
  const wave = new DirectNameWave({ id: "wave", kind: "name_wave", key: directHash("wave"), windowId: "a", at: 1, payload: { windowIds: ["a", "b"], names: [] } }, records, r => records.push(r));
  const waiting = wave.collect("b", []);
  wave.fail(new Error("peer failed"));
  await assert.rejects(waiting, /peer failed/u);
  await assert.rejects(wave.collect("a", []), /peer failed/u);
  assert.equal(records.filter(r => r.kind === "name_plan").length, 0);
});
