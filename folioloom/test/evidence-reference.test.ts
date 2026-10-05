import assert from "node:assert/strict";
import test from "node:test";
import { evidenceReferences, resolveEvidenceReference } from "../src/domain/evidence-reference.js";
import { resolveEpubVisibleQuote } from "../src/source/epub-structure.js";

test("visible focus projection ignores only host EPUB markers and rejects ambiguity", () => {
  const text = "🦉 ⟦E1.2.0⟧Do ⟦/E1.2.0⟧⟦E1.2.1⟧not leave.⟦/E1.2.1⟧";
  const raw = resolveEpubVisibleQuote(text, "Do not leave.");
  assert.equal(raw, "Do ⟦/E1.2.0⟧⟦E1.2.1⟧not leave.");
  assert.ok(text.includes(raw!));
  for (const focus of ["Do leave.", "do not leave.", "Do not leave!", "Do  not leave.", "E1.2.0Do"])
    assert.equal(resolveEpubVisibleQuote(text, focus), undefined);
  assert.equal(resolveEpubVisibleQuote(text + text, "Do not leave."), undefined);
  assert.equal(resolveEpubVisibleQuote("Do <b>not</b> leave.", "Do not leave."), undefined);
  assert.equal(resolveEpubVisibleQuote("Do ⟦UNKNOWN⟧not leave.", "Do not leave."), undefined);
  assert.equal(resolveEpubVisibleQuote(text, "🦉 Do"), "🦉 ⟦E1.2.0⟧Do");
  assert.equal(resolveEpubVisibleQuote("", ""), "");
});

test("evidence references preserve scalar coordinates across Unicode and repeated text", () => {
  for (const text of ["Rose rose. rose Rose.", "🦉 e\u0301 é ‘quoted’ 中文。\r\n".repeat(140), "x".repeat(2401), "\n".repeat(700) + "ending"]) {
    const refs = evidenceReferences("source", "block", text);
    assert.equal(new Set(refs.map(r => r.id)).size, refs.length);
    assert.ok(refs.length <= Math.ceil(Array.from(text).length / 120));
    for (const ref of refs) {
      assert.equal(Array.from(text).slice(ref.start, ref.end).join(""), ref.text);
      assert.ok(ref.end - ref.start <= 480);
      assert.equal(resolveEvidenceReference(refs, ref.id, "source", "block", "issues[2].sourceRef").text, ref.text);
      assert.throws(() => resolveEvidenceReference(refs, ref.id, "source", "other", "issues[2].sourceRef"), /issues\[2\]\.sourceRef/u);
      assert.throws(() => resolveEvidenceReference(refs, ref.id, "target", "block", "targetRef"), /target reference/u);
    }
    assert.equal(refs.map(r => r.text).join("").replace(/\s/gu, ""), text.replace(/\s/gu, ""));
  }
});

test("reference identity binds the complete version and cannot be guessed into visibility", () => {
  const original = evidenceReferences("source", "b", "The door stayed shut.");
  const edited = evidenceReferences("source", "b", "the door stayed shut.");
  assert.notEqual(original[0]!.id, edited[0]!.id);
  assert.throws(() => resolveEvidenceReference(edited, original[0]!.id, "source", "b", "sourceRef"), /stale/u);
  assert.throws(() => resolveEvidenceReference(original, original[0]!.id, "source", "b", "sourceRef", new Set()), /unissued/u);
});
