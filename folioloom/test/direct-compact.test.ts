import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactPrompt, parseCompactTranslation, planDirectFragments, directGenerationUsage, normalizeNamingReferences } from "../src/fullbook/direct-compact.js";
import { versionedName } from "../src/fullbook/direct-name-revisions.js";
import type { DirectRecord } from "../src/fullbook/direct-translation.js";

const name = versionedName({ source: "Heron Isle", target: "赫伦岛", kind: "place", scope: "book", policy: "locked" });
const paragraph = { id: "p0", blockId: "b", source: "Heron Isle lies offshore." };
test("compact context filters references and gives shared names short request-local identifiers", () => {
  const p = JSON.parse(buildCompactPrompt([paragraph], [name], [], {}, [
    { source: "Heron Isle", target: "旧称" }, { source: "Elsewhere", target: "远地" },
    { source: "offshore", target: "近海" },
  ]));
  assert.equal(p.sharedNames[0].nameId, "n0");
  assert.deepEqual(p.referenceNames, [{ source: "offshore", target: "近海" }]);
  assert.ok(!JSON.stringify(p).includes(name.nameId));
});
test("compact receipts derive unique coordinates and require disambiguation for repeated targets", () => {
  const raw = (text: string, use: unknown) => JSON.stringify({ paragraphs: [["p0", text]], names: [], nameUses: [use] });
  const one = parseCompactTranslation(raw("赫伦岛在海上。", ["n0", "p0"]), [paragraph], [name]);
  assert.equal(one.nameUses[0]?.start, 0); assert.equal(one.nameUses[0]?.nameId, name.nameId);
  assert.equal(parseCompactTranslation(raw("赫伦岛旁有赫伦岛。", ["n0", "p0"]), [paragraph], [name]).nameUses.length, 0);
  const two = parseCompactTranslation(raw("赫伦岛旁有赫伦岛。", ["n0", "p0", null, 1]), [paragraph], [name]);
  assert.equal(two.nameUses[0]?.start, 5);
  const wrong = { ...paragraph, source: "No island appears here." };
  assert.equal(parseCompactTranslation(raw("赫伦岛在海上。", ["n0", "p0"]), [wrong], [name]).nameUses.length, 0);
});
test("compact changes retain source evidence and do not infer homonymous referents", () => {
  const other = versionedName({ ...name, nameId: undefined, sense: "village" });
  const raw = JSON.stringify({ paragraphs: [["p0", "赫伦岛在海上。"]], nameUses: [["n0", "p0"]] });
  assert.equal(parseCompactTranslation(raw, [paragraph], [name, other]).nameUses.length, 0);
});
test("output planning handles dense paragraph lists and preserves exact source order", () => {
  const paragraphs = Array.from({ length: 85 }, (_, i) => ({ ...paragraph, id: `p${i}` }));
  const fragments = planDirectFragments(paragraphs, [name], 37200);
  assert.ok(fragments.length >= 4);
  assert.ok(fragments.every(p => p.length <= 24));
  assert.deepEqual(fragments.flat(), paragraphs);
  const long = [{ ...paragraph, source: "Heron Isle ".repeat(500) }, { ...paragraph, id: "p1", source: "Heron Isle ".repeat(500) }];
  assert.equal(planDirectFragments(long, [name], 37200).length, 2);
});
test("successful fragments do not spend failure credits and missing usage is conservatively charged", () => {
  const records: DirectRecord[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `r${i}`;
    records.push({ id, key: id, windowId: "w", at: i, kind: "request", payload: { predictedTokens: 100 } });
    records.push({ id: id + ":response", key: id, windowId: "w", at: i, kind: "response", payload: { requestId: id, totalTokens: 20, usageComplete: true } });
    if (i >= 4) records.push({ id: id + ":accepted", key: id, windowId: "w", at: i, kind: "fragment_result", payload: { requestId: id, accepted: true } });
  }
  assert.deepEqual(directGenerationUsage(records, "w"), { requests: 8, successes: 4, failures: 4, chargedTokens: 160 });
  records.push({ id: "lost", key: "lost", windowId: "w", at: 9, kind: "request", payload: { predictedTokens: 100 } });
  assert.equal(directGenerationUsage(records, "w").chargedTokens, 260);
  records.push({ id: "lost:response", key: "lost", windowId: "w", at: 9, kind: "response", payload: { requestId: "lost", totalTokens: 2, usageComplete: false } });
  assert.equal(directGenerationUsage(records, "w").chargedTokens, 260);
});
test("reference imports exclude foreign evidence and reject invalid scope combinations", () => {
  assert.deepEqual(normalizeNamingReferences([{ ...name, evidence: { paragraphId: "foreign", quote: "Heron Isle" } }]),
    [{ source: name.source, target: name.target, kind: "place", scope: "book", policy: "locked" }]);
  assert.throws(() => normalizeNamingReferences([{ source: "lens", target: "镜片", kind: "term", scope: "book" }]), /reference/u);
});
