import assert from "node:assert/strict";
import test from "node:test";
import { parseRevisionTranslation, planNameRevisionWave, versionedName } from "../src/fullbook/direct-name-revisions.js";
import type { DirectName, DirectParagraph } from "../src/fullbook/direct-translation.js";

const base = versionedName({ source: "Heron Isle", target: "赫伦岛", kind: "place", scope: "book", policy: "locked",
  evidence: { paragraphId: "seed", quote: "Heron Isle" } });
const source = (id: string): DirectParagraph => ({ id, blockId: id, source: "Heron Isle is named for the herons nesting there." });
function draft(windowId: string, target: string, change = false, revision = 1) {
  const p = source(windowId);
  return { windowId, source: [p], result: parseRevisionTranslation(JSON.stringify({ paragraphs: [[p.id, target + "在海中。"]], names: [],
    nameUses: [{ nameId: base.nameId, paragraphId: p.id, quote: "Heron Isle", target, occurrence: 0 }],
    nameChanges: change ? [{ nameId: base.nameId, expectedRevision: revision, target, reason: "The source explains the bird-derived name.",
      evidence: { paragraphId: p.id, quote: p.source } }] : [] }), [p], [base]) };
}

test("a wave applies one attested revision to parallel and earlier anchored text without model review", () => {
  const plan = planNameRevisionWave([base], [draft("a", "鹭岛", true), draft("b", "赫伦岛")], [draft("past", "赫伦岛")]);
  assert.equal(plan.names[0]!.target, "鹭岛");
  assert.equal(plan.names[0]!.revision, 2);
  assert.equal(plan.decisions[0]!.status, "accepted");
  assert.deepEqual(plan.windows.map(w => w.result.paragraphs[0]![1]), ["鹭岛在海中。", "鹭岛在海中。"]);
  assert.equal(plan.history[0]!.result.paragraphs[0]![1], "鹭岛在海中。");
  assert.equal(plan.patches.length, 2);
});

test("conflicting proposals never choose the last finishing writer", () => {
  const a = draft("a", "鹭岛", true), b = draft("b", "苍鹭岛", true);
  for (const drafts of [[a, b], [b, a]]) {
    const plan = planNameRevisionWave([base], drafts, []);
    assert.equal(plan.names[0]!.target, "赫伦岛");
    assert.ok(plan.decisions.every(d => d.status === "pending" && d.reason === "conflicting_proposals"));
    assert.ok(plan.windows.every(w => w.result.paragraphs[0]![1] === "赫伦岛在海中。"));
  }
});

test("stale and user-owned entries cannot be overwritten", () => {
  const stale = planNameRevisionWave([{ ...base, revision: 2 }], [draft("a", "鹭岛", true)], []);
  assert.equal(stale.decisions[0]!.reason, "stale_revision");
  const user = planNameRevisionWave([{ ...base, authority: "user" }], [draft("a", "鹭岛", true)], []);
  assert.equal(user.decisions[0]!.reason, "user_locked");
  assert.equal(user.names[0]!.target, "赫伦岛");
});

test("missing or forged location receipts remain pending instead of broad string replacement", () => {
  const past = draft("past", "赫伦岛"); past.result.nameUses = [];
  const plan = planNameRevisionWave([base], [draft("a", "鹭岛", true)], [past]);
  assert.equal(plan.history[0]!.result.paragraphs[0]![1], "赫伦岛在海中。");
  assert.ok(plan.pending.some(p => p.reason === "missing_receipt" && p.paragraphId === "past"));
  const p = source("x");
  const parsed = parseRevisionTranslation(JSON.stringify({ paragraphs: [["x", "赫伦岛和赫伦岛。"]], names: [],
    nameUses: [{ nameId: base.nameId, paragraphId: "x", quote: "Invented", target: "赫伦岛", occurrence: 0 }] }), [p], [base]);
  assert.equal(parsed.nameUses.length, 0);
  assert.ok(parsed.namingIssues.length > 0);
});

test("local receipts do not rewrite unrelated same-spelled text or EPUB markers", () => {
  const p = source("b");
  const peer = { windowId: "b", source: [p], result: parseRevisionTranslation(JSON.stringify({
    paragraphs: [["b", "赫伦岛在海中；赫伦岛是另一个作品标题。"]], names: [],
    nameUses: [{ nameId: base.nameId, paragraphId: "b", quote: "Heron Isle", target: "赫伦岛", occurrence: 0 }] }), [p], [base]) };
  const plan = planNameRevisionWave([base], [draft("a", "鹭岛", true), peer], []);
  assert.equal(plan.windows[1]!.result.paragraphs[0]![1], "鹭岛在海中；赫伦岛是另一个作品标题。");
});

test("referents keep homonymous names separate", () => {
  const village = versionedName({ ...base, nameId: undefined, sense: "village", target: "赫伦村" } as DirectName);
  assert.notEqual(village.nameId, base.nameId);
  const plan = planNameRevisionWave([base, village], [draft("a", "鹭岛", true)], []);
  assert.equal(plan.names.find(n => n.nameId === village.nameId)!.target, "赫伦村");
});

test("the response parser preserves explicitly distinct referents of the same source spelling", () => {
  const p = { id: "p", blockId: "b", source: "Heron is an island. Heron is also a village." };
  const result = parseRevisionTranslation(JSON.stringify({ paragraphs: [["p", "赫伦岛和赫伦村。"]],
    names: [{ id: "new1", source: "Heron", target: "赫伦岛", sense: "island", kind: "place", scope: "book", evidence: { paragraphId: "p", quote: "Heron is an island" } },
      { id: "new2", source: "Heron", target: "赫伦村", sense: "village", kind: "place", scope: "book", evidence: { paragraphId: "p", quote: "Heron is also a village" } }],
    nameUses: [{ nameId: "new1", paragraphId: "p", quote: "Heron is an island", target: "赫伦岛", occurrence: 0 },
      { nameId: "new2", paragraphId: "p", quote: "Heron is also a village", target: "赫伦村", occurrence: 0 }] }), [p], []);
  assert.equal(result.names.length, 2); assert.notEqual(result.names[0]!.nameId, result.names[1]!.nameId);
  assert.equal(result.nameUses.length, 2);
});

test("declaring a new entry cannot bypass a user-owned rendering", () => {
  const user = versionedName({ source: "Heron Isle", target: "苍鹭岛", authority: "user", policy: "locked" });
  const p = source("p");
  const result = parseRevisionTranslation(JSON.stringify({ paragraphs: [["p", "赫伦岛。"]],
    names: [{ id: "new1", source: "Heron Isle", target: "赫伦岛", kind: "place", scope: "book", evidence: { paragraphId: "p", quote: "Heron Isle" } }],
    nameUses: [{ nameId: "new1", paragraphId: "p", quote: "Heron Isle", target: "赫伦岛", occurrence: 0 }] }), [p], [user]);
  assert.equal(result.names.length, 0);
  const plan = planNameRevisionWave([user], [{ windowId: "w", source: [p], result }], []);
  assert.equal(plan.windows[0]!.result.paragraphs[0]![1], "苍鹭岛。");
  assert.ok(plan.pending.some(p => p.reason === "user_locked"));
});

test("a local rename preserves EPUB slot markers", () => {
  const p = { id: "epub", blockId: "epub", source: "⟦E0.0.0⟧Heron Isle⟦/E0.0.0⟧⟦E0.0.1⟧ is named for birds.⟦/E0.0.1⟧" };
  const translated = "⟦E0.0.0⟧赫伦岛⟦/E0.0.0⟧⟦E0.0.1⟧以鸟得名。⟦/E0.0.1⟧";
  const result = parseRevisionTranslation(JSON.stringify({ paragraphs: [[p.id, translated]], names: [], nameUses: [
    { nameId: base.nameId, paragraphId: p.id, quote: "Heron Isle", target: "赫伦岛", occurrence: 0 }] }), [p], [base]);
  const plan = planNameRevisionWave([base], [draft("a", "鹭岛", true), { windowId: "epub", source: [p], result }], []);
  assert.equal(plan.windows[1]!.result.paragraphs[0]![1], translated.replace("赫伦岛", "鹭岛"));
  assert.equal(plan.pending.length, 0);
});

test("title wrappers survive correction and partial-name receipts cannot broaden edits", () => {
  const p = source("b");
  const result = parseRevisionTranslation(JSON.stringify({ paragraphs: [["b", "《赫伦岛》在海中。"]], names: [],
    nameUses: [{ nameId: base.nameId, paragraphId: "b", quote: "Heron Isle", target: "《赫伦岛》", occurrence: 0 }] }), [p], [base]);
  const stable = planNameRevisionWave([base], [{ windowId: "b", source: [p], result }], []);
  assert.equal(stable.windows[0]!.result.paragraphs[0]![1], "《赫伦岛》在海中。");
  const changed = planNameRevisionWave([base], [draft("a", "鹭岛", true), { windowId: "b", source: [p], result }], []);
  assert.equal(changed.windows[1]!.result.paragraphs[0]![1], "《鹭岛》在海中。");
  const bad = parseRevisionTranslation(JSON.stringify({ paragraphs: [["b", "赫伦岛。"]], names: [],
    nameUses: [{ nameId: base.nameId, paragraphId: "b", quote: "Heron Isle", target: "赫", occurrence: 0 }] }), [p], [base]);
  assert.equal(bad.nameUses.length, 0);
});
