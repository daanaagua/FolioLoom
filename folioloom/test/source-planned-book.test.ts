import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport } from "../src/report.js";
import { semanticParagraphSpans } from "../src/text/paragraph-spans.js";

function prompt(context: Context): string {
  const message = context.messages.findLast(m => m.role === "user")!;
  return typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

test("source frontier fills a freed slot before its slower sibling completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-source-frontier-"));
  const source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 6 }, (_, i) =>
    `section ${i + 1}. ` + "the quiet traveler waited beside the garden gate while the rain fell gently. ".repeat(85)).join("\n\n"), "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider(); let translations = 0, filled = false;
  let release!: () => void;
  const thirdStarted = new Promise<void>(resolve => { release = resolve; });
  const reply = async (context: Context) => {
    const text = prompt(context);
    if (context.tools?.some(t => t.name === "submit_repaired_translation")) throw new Error(`unexpected repair: ${text.slice(0, 1800)}`);
    const answer = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) {
      const forms = JSON.parse(/SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u.exec(text)![1]!);
      return answer("submit_lexical_anchors", { anchors: forms.map((c: any) => ({ sourceForm: c.sourceForm, target: "",
        mode: "contextual", semanticClass: "ordinary_word", confidence: 0.99 })), entityLinks: [] });
    }
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const data = JSON.parse(text); assert.equal(data.event, "review");
      return answer("submit_supervisor_decision", { action: "accept", windowIds: data.windows.map((w: any) => w.windowId),
        reviewBlockIds: [], guidance: [], issues: [], reason: "Checked." });
    }
    const number = ++translations;
    if (number === 3) { filled = true; release(); }
    if (number === 2) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([thirdStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("free slot did not refill")), 3000); })]); }
      finally { clearTimeout(timer); }
    }
    const fragment = /TARGET SOURCE FRAGMENT\n\n(\[[\s\S]*?\])\n\nCONTEXT-ONLY PARAGRAPHS/u.exec(text);
    const windows = JSON.parse(fragment?.[1] ?? /WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(text)![1]!);
    const translated = (sourceText: string) => `第${number}段，` + "那位安静的旅人守在花园门旁，细雨一直轻轻地落下。".repeat(Math.max(1, Math.ceil(sourceText.length / 75)));
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId, ...(fragment
        ? { paragraphs: b.paragraphs.map((p: any) => ({ text: translated(p.sourceText) })) }
        : { text: semanticParagraphSpans(b.sourceText).map(p => translated(p.sourceText)).join("\n\n") }) })), notes: [] })) });
  };
  faux.setResponses(Array.from({ length: 40 }, () => reply));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "fill", protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), planningMode: "source" as const,
    supervisorMode: "bounded" as const, chapterReviewMode: "bounded" as const, schedulerMode: "active" as const,
    windowOptions: { maxBlocks: 1, maxSourceTokens: 2600 }, maxInFlightTokens: 1_000_000,
    maxConcurrency: 2, maxWindows: 4, maxAttempts: 1, hardDeadlineMs: 10000 };
  const result = await runBook(options);
  assert.equal(filled, true); assert.ok(translations >= 4);
  assert.equal(result.status.completedWindows, 4);
  assert.equal(result.waves.length, 1, "four source-planned windows share one continuously filled pool");
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try { assert.equal(auditLosslessBookExport(store, "fill").audit.strictExportable, false, "unfinished chapter coverage must still block strict export"); }
  finally { store.close(); }
});

test("source-planned book resumes its exact plan with no model planning and complete chapter audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-source-plan-"));
  const source = join(root, "source.txt");
  writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider(); let translations = 0, chapters = 0;
  const reply = (context: Context) => {
    const text = prompt(context);
    const answer = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const data = JSON.parse(text);
      assert.equal(data.event, "review", "source plan must never ask the provider to plan");
      assert.ok(data.chapterReview, "ordinary complete source sentences defer to chapter review"); chapters++;
      return answer("submit_supervisor_decision", { action: "accept", windowIds: data.windows.map((w: any) => w.windowId),
        reviewBlockIds: [], guidance: [], issues: [], reason: "Meaning and coverage checked." });
    }
    translations++;
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(text)![1]!);
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: "那位安静的旅人没有离开屋子。他守在门边，一直等到外面的雨停了下来。" })), notes: [] })) });
  };
  faux.setResponses(Array.from({ length: 8 }, () => reply));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "source-plan", protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), planningMode: "source" as const,
    supervisorMode: "bounded" as const, chapterReviewMode: "bounded" as const, schedulerMode: "active" as const,
    maxConcurrency: 2, hardDeadlineMs: 10000 };
  assert.equal((await runBook({ ...options, maxWindows: 0 })).status.completedWindows, 0);
  const initial = LosslessBookStore.openReadOnly(options.storePath);
  const sourcePlan = (initial.listTranslationRuns()[0]!.metadata as any).sourceExecutionPlan;
  initial.close(); assert.equal(faux.state.callCount, 0);
  assert.ok(sourcePlan.id);
  assert.equal((await runBook(options)).outcome, "completed");
  assert.equal(translations, 1); assert.equal(chapters, 1);
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.deepEqual((store.listTranslationRuns()[0]!.metadata as any).sourceExecutionPlan, sourcePlan);
    assert.equal(auditLosslessBookExport(store, "source-plan").audit.strictExportable, true);
    assert.ok(store.supervisionRecords("source-plan").filter(r => r.event === "plan").every(r => r.origin === "host_source_plan" && r.modelCalls === 0));
  } finally { store.close(); }
  const calls = faux.state.callCount;
  await runBook(options); assert.equal(faux.state.callCount, calls);
  await assert.rejects(() => runBook({ ...options, planningMode: "supervised" }), /planning policy mismatch/u);
  await assert.rejects(() => runBook({ ...options, chapterReviewMode: "off" }), /source planning requires/u);
  assert.equal(faux.state.callCount, calls);
});
