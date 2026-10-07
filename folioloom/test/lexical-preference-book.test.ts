import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { stableTermsFromKnowledge } from "../src/knowledge/stable-terms-from-knowledge.js";
import { auditLosslessBookExport, qualityReportJson, qualityReportText } from "../src/report.js";

test("source-grounded preferences survive a deferred translation-quality issue without leaking rejected memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-lexical-preference-"));
  const source = join(directory, "source.txt");
  writeFileSync(source, "the lyceum has a classroom. the lyceum is open. the keeper stood outside the lyceum.\n\nhe quietly asked the visitor to wait outside.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(directory, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  let repairs = 0;
  const response = (context: Context) => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const prompt = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const answer = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) return answer("submit_lexical_anchors", {
      anchors: [{ sourceForm: "lyceum", target: "学馆", semanticClass: "technical_term", mode: "stable", confidence: 0.65,
        meaning: "an educational institution", usageScope: "the school building" }] });
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const data = JSON.parse(prompt);
      const plan = data.event === "plan";
      if (plan) assert.ok(data.stableTerms.some((t: any) => t.sourceForm === "lyceum" && t.target === "学馆"),
        "planning must use the same newly anchored terms as translation");
      const sourceRef = data.source?.[0]?.evidence.find((e: any) => e.text.includes("he quietly"));
      const targetRef = data.candidate?.[0]?.evidence.find((e: any) => e.text.includes("轻声"));
      return answer("submit_supervisor_decision", { action: plan ? "translate" : "revise",
        windowIds: data.windows.map((w: any) => w.windowId), reviewBlockIds: plan ? data.windows.flatMap((w: any) => w.blockIds) : [],
        guidance: [], issues: plan ? [] : [{ blockId: data.candidate[0].blockId, sourceRef: sourceRef.id, targetRef: targetRef.id,
          problem: "The male keeper is rendered with a female pronoun." }], reason: "Check the pronoun." });
    }
    if (prompt.includes("ORDERED TEXT SLOTS")) {
      repairs++;
      const slots = JSON.parse(/ORDERED TEXT SLOTS[^\n]*\n\n([^\n]+)/u.exec(prompt)![1]!);
      return fauxAssistantMessage(JSON.stringify(slots.map(() => null)));
    }
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId, notes: [],
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId,
        text: "学馆里有一间教室。学馆开着门，守门人站在学馆外。\n\n她轻声请那位来访者在外面稍等片刻。" })) })) });
  };
  faux.setResponses(Array.from({ length: 10 }, () => response));
  const storePath = join(directory, "book.db");
  await runBook({ manifestPath: imported.manifestPath, storePath, runMeta: { runId: "pref-quality", protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), supervisorMode: "bounded", deliveryMode: "standard",
    shouldPause: () => repairs > 0, maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 });
  const store = LosslessBookStore.openReadOnly(storePath);
  try {
    const terms = stableTermsFromKnowledge(store.latestKnowledgeSnapshot("pref-quality").revisions);
    assert.equal(terms[0]?.preference?.meaning, "an educational institution");
    assert.equal(terms[0]?.locked, false);
    const audit = auditLosslessBookExport(store, "pref-quality").audit;
    assert.equal(audit.quality.pending, 1);
    assert.equal(audit.deliveryReady, true);
    assert.equal(audit.strictExportable, false);
    assert.equal(JSON.parse(qualityReportJson(store, "pref-quality")).lexicalPreferences.length, 3);
    assert.match(qualityReportText(store, "pref-quality"), /专用词全位置核对/u);
  } finally { store.close(); }
});
