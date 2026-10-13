import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../src/source/source-importer.js";
import { SourceLedger } from "../src/source/source-ledger.js";
import { createScopePlan, certifySourceScope } from "../src/source/source-scope.js";

test("scope requires an explicit disposition for every original section, including epilogues", () => {
  const original = { sourceVersion: "v", rawSha256: "a".repeat(64), sourceText: "Chapter 1\n\nStory.\n\nEpilogue\n\nLater.",
    canonicalSegments: [{ canonicalStart: 0, canonicalEnd: 19, originRef: "chapter.xhtml" },
      { canonicalStart: 19, canonicalEnd: 35, originRef: "epilogue.xhtml" }] };
  // Build exact scalar boundaries independently of heading recognition.
  original.canonicalSegments[0]!.canonicalEnd = original.sourceText.indexOf("Epilogue");
  original.canonicalSegments[1]!.canonicalStart = original.sourceText.indexOf("Epilogue");
  original.canonicalSegments[1]!.canonicalEnd = [...original.sourceText].length;
  const plan = createScopePlan(original);
  assert.equal(plan.parts.length, 2);
  assert.throws(() => certifySourceScope(original, { ...plan, parts: plan.parts.slice(0, 1) }, "Chapter 1\n\nStory."), /unaccounted|coverage/iu);
  assert.throws(() => certifySourceScope(original, { ...plan, parts: [plan.parts[0]!, { ...plan.parts[1]!, disposition: "exclude" }] }, "Chapter 1\n\nStory."), /reason/iu);
  const selected = certifySourceScope(original, { ...plan, parts: [plan.parts[0]!, { ...plan.parts[1]!, disposition: "exclude", reason: "Separate volume" }] }, "Chapter 1\n\nStory.");
  assert.equal(selected.wholeOriginalSelected, false);
  assert.equal(selected.parts[1]!.reason, "Separate volume");
  assert.throws(() => certifySourceScope(original, plan, "Chapter 1\n\nStory."), /selected.*mismatch/iu);
});

test("scope rejects gaps, overlaps, reordered selections and changed original identities", () => {
  const original = { sourceVersion: "v", rawSha256: "a".repeat(64), sourceText: "One.\n\nTwo.", canonicalSegments: [{ canonicalStart: 0, canonicalEnd: 10, originRef: "source.txt" }] };
  const plan = createScopePlan(original);
  assert.throws(() => certifySourceScope(original, { ...plan, originalSourceVersion: "other" }, original.sourceText), /identity/iu);
  assert.throws(() => certifySourceScope(original, { ...plan, parts: [{ ...plan.parts[0]!, start: 1 }] }, original.sourceText), /coverage/iu);
  assert.throws(() => certifySourceScope(original, { ...plan, parts: [plan.parts[0]!, plan.parts[0]!] }, original.sourceText), /coverage/iu);
  assert.throws(() => certifySourceScope(original, plan, "Two.\n\nOne."), /selected.*mismatch/iu);
});

test("scoped imports pin portable original evidence and refuse later plan tampering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-scope-"));
  try {
    const source = join(dir, "full.txt"), subset = join(dir, "subset.txt");
    writeFileSync(source, "One.\n\nTwo."); writeFileSync(subset, "One.");
    const parent = await importSource({ sourcePath: source, projectDirectory: join(dir, "parent"), sourceLanguage: "en" });
    const original = SourceLedger.open(parent.manifestPath), plan = createScopePlan(original);
    plan.parts = [{ ...plan.parts[0]!, end: 6 }, { ...plan.parts[0]!, start: 6, disposition: "exclude", reason: "Next batch" }];
    const child = await importSource({ sourcePath: subset, projectDirectory: join(dir, "child"), sourceLanguage: "en", originalManifestPath: parent.manifestPath, scopePlan: plan });
    const ledger = SourceLedger.open(child.manifestPath);
    assert.equal(ledger.scope?.wholeOriginalSelected, false);
    assert.equal(ledger.scope?.original.sourceVersion, original.sourceVersion);
    rmSync(join(dir, "parent"), { recursive: true });
    assert.equal(SourceLedger.open(child.manifestPath).sourceVersion, ledger.sourceVersion);
    const manifest = JSON.parse(readFileSync(child.manifestPath, "utf8"));
    const path = join(dir, "child", manifest.source_scope.path);
    const evidence = JSON.parse(readFileSync(path, "utf8")); evidence.parts[1].reason = "Changed";
    writeFileSync(path, JSON.stringify(evidence));
    assert.throws(() => SourceLedger.open(child.manifestPath), /scope.*hash/iu);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new imports expose provided-input scope without upgrading legacy identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-scope-legacy-"));
  try {
    const source = join(dir, "source.txt"); writeFileSync(source, "A quiet room.");
    const result = await importSource({ sourcePath: source, projectDirectory: join(dir, "project"), sourceLanguage: "en" });
    const modern = SourceLedger.open(result.manifestPath); assert.equal(modern.scope?.basis, "provided-input");
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")); delete manifest.source_scope;
    writeFileSync(result.manifestPath, JSON.stringify(manifest));
    const legacy = SourceLedger.open(result.manifestPath); assert.equal(legacy.scope, undefined);
    assert.notEqual(legacy.sourceVersion, modern.sourceVersion);
    assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), result.rawSha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
