import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { readSurfaceObservations, surfaceMentions } from "../src/knowledge/surface-consistency.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

test("weak recurrent noun decisions and occurrence receipts survive a SQLite close and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-recurrent-memory-")), source = join(directory, "source.txt");
  writeFileSync(source, "the tallyrod fell.\n\nhe held his tallyrod.\n\nhe stood with the tallyrod.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(directory, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const response = (context: Context) => {
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
      anchors: [{ sourceForm: "tallyrod", target: "木柱", semanticClass: "ordinary_word", mode: "contextual", confidence: 0.55 }] }), { stopReason: "toolUse" });
    const message = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
    const mentions = JSON.parse(/SURFACE MENTIONS\n\n([^\n]+)/u.exec(prompt)![1]!);
    assert.equal(mentions.length, 3);
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", { windows: windows.map((w: any) => ({
      windowId: w.windowId, notes: [], translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: "筹杆掉了下来。\n\n他手里拿着筹杆。\n\n他拿着筹杆站在那里。" })),
      surfaceUsages: mentions.map((m: any) => ({ occurrenceId: m.occurrenceId, targetSurface: "筹杆" })) })) }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 5 }, () => response));
  const path = join(directory, "book.db"), runId = "weak-recurrent";
  await runBook({ manifestPath: imported.manifestPath, storePath: path, runMeta: { runId, protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 });
  const store = LosslessBookStore.openReadOnly(path);
  try {
    const revisions = store.latestKnowledgeSnapshot(runId).revisions;
    assert.equal((revisions.find(r => r.kind === "lexical_anchor_decision" && r.normalizedSubject === "tallyrod")?.payload as any).discoveryKind, "recurrent_noun");
    assert.equal(revisions.filter(r => r.kind.startsWith("lexical_preference:")).length, 0);
    const observations = readSurfaceObservations(revisions, store.activeTranslations(runId));
    assert.equal(observations.filter(o => o.sourceForm === "tallyrod" && o.observedTarget === "筹杆").length, 3);
    const restored = surfaceMentions([{ blockId: "next", sourceText: "his tallyrod fell." }], [], observations, getSourceLanguageProfile("en"));
    assert.equal(restored[0]?.preferredTarget, "筹杆");
  } finally { store.close(); }
});
