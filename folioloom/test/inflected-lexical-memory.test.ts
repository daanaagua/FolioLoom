import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { collectWindowAnchorCandidates, createLexicalPreferredFallbackProtocol, LexicalAnchorer,
  parseLexicalPreferredFallbackResponse, type AnchorCandidate } from "../src/agents/lexical-anchorer.js";
import { PiRuntime } from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { stableTermsFromKnowledge } from "../src/knowledge/stable-terms-from-knowledge.js";
import type { LexicalPreferenceCheck } from "../src/knowledge/lexical-preference-audit.js";
import { qualityReportJson } from "../src/report.js";

const profile = getSourceLanguageProfile("en");
const paragraphs = [
  "a worn-out drem stood at the gate. more drems waited nearby.",
  "We drems didn't join the gathering.",
  "all drems of this kind remained outside.",
];
const blocks = paragraphs.map((sourceText, i) => ({ id: `b${i}`, legacyId: null, chapterId: "c", chapterTitle: "",
  globalIndex: i, blockIndex: i, sourceText, sourceHash: "source", tokenCount: 25 }));
const decisions = (forms: string[]) => forms.map(sourceForm => ({ sourceForm, target: "泥工族", mode: "stable" as const,
  semanticClass: "technical_term" as const, meaning: "a constructed worker kind", usageScope: "the worker group in the cited scene" }));

for (const transport of ["typed", "framed"] as const) {
  test(`an attested singleton inflection retains sense-scoped soft memory (${transport})`, async () => {
    const candidates = collectWindowAnchorCandidates(blocks.slice(0, 1), blocks, []);
    assert.ok(candidates.some(c => c.sourceForm === "drem"));
    assert.equal(candidates.find(c => c.sourceForm === "drem")!.corpusFrequency, 1);
    const anchors = decisions(candidates.map(c => c.sourceForm));
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", { anchors }), { stopReason: "toolUse" })]);
    const outcome = transport === "typed"
      ? await new LexicalAnchorer(new PiRuntime()).run({ candidates, stableTerms: [], model: faux.getModel(),
        streamFn: faux.provider.streamSimple.bind(faux.provider), budget: new BudgetLedger() })
      : parseLexicalPreferredFallbackResponse(JSON.stringify(anchors), createLexicalPreferredFallbackProtocol(candidates, profile), candidates, profile);
    const term = outcome.terms.find(t => t.sourceForm === "drem");
    assert.ok(term?.preference, "the attested inflection must retain meaning and source-grounded preference metadata");
    assert.equal(term.preference.meaning, "a constructed worker kind");
    assert.equal(term.canonicalSource, "drem");
    assert.equal(term.locked, false);
    assert.equal(term.policy, "preferred");
    assert.ok(term.preference.evidenceQuotes.every(q => /\bdrem\b/u.test(q)), "a sibling quote cannot replace own-form grounding");
    assert.equal(outcome.entityLinks.length, 0);
    if (transport === "typed") assert.equal(outcome.anchors.find(a => a.sourceForm === "drem")?.semanticClass, "unclassified",
      "related forms cannot satisfy the independent exact-form concept threshold");
  });
}

test("a source-absent supporting inflection cannot provide a singleton preference", async () => {
  const candidates: AnchorCandidate[] = [{ sourceForm: "drem", discoveryKind: "recurrent_noun", corpusFrequency: 1,
    currentWaveOccurrences: 1, contexts: ["a drem stood."],
    relatedSourceForms: [{ sourceForm: "drems", corpusFrequency: 2, contexts: ["the workers stood."] }] }];
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", { anchors: decisions(["drem"]) }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({ candidates, stableTerms: [], model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider), budget: new BudgetLedger() });
  assert.ok(outcome.terms.every(t => t.preference === undefined));
  assert.equal(outcome.anchors[0]?.lockEligible, false);
});

test("discovered group-name inflections persist separately in SQLite and survive zero-call resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-inflected-memory-"));
  const source = join(directory, "source.txt");
  writeFileSync(source, paragraphs.join("\n\n"), "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(directory, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  let anchorCalls = 0;
  const response = (context: Context) => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) {
      anchorCalls++;
      return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", { anchors: decisions(["drem", "drems"]) }), { stopReason: "toolUse" });
    }
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
    const mentions = JSON.parse(/SURFACE MENTIONS\n\n([^\n]+)/u.exec(prompt)![1]!);
    assert.equal(mentions.length, 4);
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", { windows: windows.map((w: any) => ({
      windowId: w.windowId, notes: [], translations: w.blocks.map((b: any) => ({ blockId: b.blockId,
        text: "一个破旧的泥工族人站在门口。更多泥工族人在附近等候。\n\n泥工族人没有参加聚会。\n\n这一类泥工族人都留在外面。" })),
      surfaceUsages: mentions.map((m: any) => ({ occurrenceId: m.occurrenceId, targetSurface: "泥工族" })),
    })) }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));
  const storePath = join(directory, "book.db"), runId = "inflected-memory";
  const options = { manifestPath: imported.manifestPath, storePath, runMeta: { runId, protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
  await runBook(options);
  const store = LosslessBookStore.openReadOnly(storePath);
  try {
    const terms = stableTermsFromKnowledge(store.latestKnowledgeSnapshot(runId).revisions);
    for (const form of ["drem", "drems"]) {
      const term = terms.find(t => t.sourceForm === form);
      assert.ok(term?.preference, `${form} has its own durable preferred sense`);
      assert.equal(term.locked, false);
      assert.equal(term.canonicalSource, form);
    }
    assert.equal(new Set(terms.map(t => t.conceptId)).size, 2, "discovery must not merge semantic identities");
    const audit: LexicalPreferenceCheck[] = JSON.parse(qualityReportJson(store, runId)).lexicalPreferences;
    assert.equal(audit.length, 4);
    assert.ok(audit.every(row => row.status === "preferred_surface_present"));
  } finally { store.close(); }
  const calls = faux.state.callCount;
  await runBook(options);
  assert.equal(faux.state.callCount, calls);
  assert.equal(anchorCalls, 1);
});
