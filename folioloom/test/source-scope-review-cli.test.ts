import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { main, parseArgs, cliErrorPayload } from "../src/cli.js";
import { importSource } from "../src/source/source-importer.js";
import { SourceLedger } from "../src/source/source-ledger.js";
import { createScopePlan, SourceScopeError } from "../src/source/source-scope.js";
import { writeStoredZip } from "../src/export/stored-zip.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport } from "../src/report.js";
import { readOmissionReviewStatus } from "../src/fullbook/omission-review-runner.js";

function epub(path: string, includeEpilogue: boolean) {
  const names = includeEpilogue ? ["chapter", "epilogue"] : ["chapter"];
  writeStoredZip(path, [{ name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>' },
    { name: "content.opf", data: `<package><manifest>${names.map(n => `<item id="${n}" href="${n}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${names.map(n => `<itemref idref="${n}"/>`).join("")}</spine></package>` },
    ...names.map(n => ({ name: `${n}.xhtml`, data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${n === "chapter" ? "Chapter 1" : "Epilogue"}</p><p>${n === "chapter" ? "She nodded. The door was open." : "No one was left behind."}</p></body></html>` }))]);
}
function payload(context: Context): any { const m = context.messages.findLast(m => m.role === "user")!; return JSON.parse(typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("")); }
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("formal import prevents chapter-only omission unless the original scope explicitly accounts for the epilogue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-scope-cli-"));
  try {
    epub(join(dir, "full.epub"), true); epub(join(dir, "part.epub"), false);
    const original = await importSource({ sourcePath: join(dir, "full.epub"), projectDirectory: join(dir, "original"), sourceLanguage: "en" });
    const ledger = SourceLedger.open(original.manifestPath), plan = createScopePlan(ledger);
    assert.equal(plan.parts.length, 2); assert.equal(ledger.canonicalSegments[1]?.originRef, "epilogue.xhtml");
    await assert.rejects(importSource({ sourcePath: join(dir, "part.epub"), projectDirectory: join(dir, "bad"), sourceLanguage: "en", originalManifestPath: original.manifestPath,
      scopePlan: { ...plan, parts: plan.parts.slice(0, 1) } }), /unaccounted/iu);
    const scoped = await importSource({ sourcePath: join(dir, "part.epub"), projectDirectory: join(dir, "selected"), sourceLanguage: "en", originalManifestPath: original.manifestPath,
      scopePlan: { ...plan, parts: [plan.parts[0]!, { ...plan.parts[1]!, disposition: "exclude", reason: "Separate final section" }] } });
    const fake = fauxProvider(); fake.setResponses([(context: Context) => fauxAssistantMessage(JSON.stringify({ paragraphs: payload(context).paragraphs.map(([id]: [string]) => [id, "译文段落。"]), names: [], nameUses: [] }))]);
    const storePath = join(dir, "book.db");
    await runBook({ workflow: "direct", manifestPath: scoped.manifestPath, storePath, runMeta: { runId: "scope", protocolVersion: "test" }, model: fake.getModel(), streamFn: fake.provider.streamSimple.bind(fake.provider), maxConcurrency: 1 });
    const store = LosslessBookStore.openReadOnly(storePath);
    try { const audit = auditLosslessBookExport(store, "scope").audit;
      assert.equal(audit.strictExportable, true); assert.equal(audit.sourceScope?.wholeOriginalSelected, false);
      assert.equal(audit.sourceScope?.parts[1]?.reason, "Separate final section");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("public CLI scans, reviews and resumes with a read-only book store and grounded paraphrase results", async t => {
  const dir = mkdtempSync(join(tmpdir(), "folio-review-cli-")); const log = t.mock.method(console, "log", () => {});
  try {
    epub(join(dir, "full.epub"), true);
    const project = await importSource({ sourcePath: join(dir, "full.epub"), projectDirectory: join(dir, "project"), sourceLanguage: "en" });
    const fake = fauxProvider(); fake.setResponses([(context: Context) => fauxAssistantMessage(JSON.stringify({ paragraphs: payload(context).paragraphs.map(([id, source]: [string, string]) => [id,
      source.startsWith("She nodded") ? "门开着。" : source.startsWith("No one") ? "所有人都跟上了。" : "标题。"]), names: [], nameUses: [] }))]);
    const storePath = join(dir, "book.db");
    await runBook({ workflow: "direct", manifestPath: project.manifestPath, storePath, runMeta: { runId: "review", protocolVersion: "test" }, model: fake.getModel(), streamFn: fake.provider.streamSimple.bind(fake.provider), maxConcurrency: 1 });
    const before = hash(storePath), planPath = join(dir, "plan.json"), output = join(dir, "review");
    await main(["book", "review", "scan", "--store", storePath, "--run", "review", "--output", planPath, "--max-candidates", "4", "--samples", "3"], {
      createModel: () => { throw new Error("scan constructed a model"); }, createStreamFn: () => { throw new Error("scan constructed a provider"); },
    });
    const plan = JSON.parse(readFileSync(planPath, "utf8")); assert.equal(plan.candidates.length, 4);
    const reviewer = fauxProvider(); reviewer.setResponses(Array.from({ length: 4 }, () => (context: Context) => {
      const p = payload(context); return fauxAssistantMessage(JSON.stringify({ verdict: p.source.startsWith("She nodded") ? "possible_omission" : "adequate",
        sourceQuote: p.source, targetQuote: p.target, note: p.source.startsWith("She nodded") ? "The nodding action is missing." : "Meaning is retained." }));
    }));
    const config = join(dir, "model.yaml"); writeFileSync(config, "llm:\n  active_provider: deepseek\n  providers:\n    deepseek:\n      api_key: fixture\n      base_url: https://example.invalid\n      models:\n        draft: deepseek-flash\n      request_options:\n        draft:\n          reasoning_effort: high\n");
    const args = ["book", "review", "run", "--store", storePath, "--run", "review", "--input", planPath, "--output", output,
      "--config", config, "--max-calls", "4", "--max-tokens", "50000", "--max-output-tokens", "1024"];
    const factories = { createModel: () => ({ ...reviewer.getModel(), api: "openai-completions" as const }), createStreamFn: () => reviewer.provider.streamSimple.bind(reviewer.provider) };
    await main(args, factories); const status = readOmissionReviewStatus(output);
    assert.equal(status.stoppedReason, "complete"); assert.equal(status.calls, 4);
    assert.equal(status.findings.filter(f => f.result.verdict === "possible_omission").length, 1);
    assert.equal(status.findings.filter(f => f.result.verdict === "adequate").length, 3);
    await main(args, factories); assert.equal(reviewer.state.callCount, 4); assert.equal(hash(storePath), before);
  } finally { log.mock.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("scope and review command parsing exposes explicit boundaries", () => {
  assert.equal(parseArgs(["book", "scope", "--manifest", "source_manifest.json"]).command, "book-scope");
  assert.throws(() => parseArgs(["book", "import", "--source", "subset.epub", "--project", "p", "--source-language", "en", "--original-manifest", "full.json"]), /together/iu);
  assert.throws(() => parseArgs(["book", "review", "run", "--store", "b.db", "--run", "r", "--input", "plan.json", "--output", "review", "--config", "config.yaml"]), /explicit/iu);
  assert.equal(cliErrorPayload(new SourceScopeError("unaccounted section")).code, "SOURCE_SCOPE_INVALID");
});
