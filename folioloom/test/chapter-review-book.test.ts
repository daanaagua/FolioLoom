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

function userText(context: Context): string {
  const m = context.messages.findLast(m => m.role === "user");
  return !m ? "" : typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

for (const valueWire of [false, true]) {
for (const pauseStage of ["none", "before_chapter", "after_chapter"] as const) {
test(`chapter review finds unflagged errors with durable coverage and local repair (${pauseStage}, values=${valueWire})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-chapter-review-"));
  const source = join(root, "source.txt");
  writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const good = "那位安静的旅人没有离开屋子。他守在门边，一直等到外面的雨停了下来。";
  const bad = "那位安静的旅人已经离开了屋子。他守在门边，一直等到外面的雨停了下来。";
  let chapterCalls = 0;
  let finalCalls = 0;
  let translations = 0;
  let pauseEnabled = pauseStage !== "none";
  const response = (context: Context) => {
    const prompt = userText(context);
    const answer = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_supervisor_decision" || t.name === "submit_supervisor_values")) {
      const data = JSON.parse(prompt);
      if (data.priorIssues) {
        finalCalls++;
        assert.ok(data.priorIssues.every((issue: any) => issue.repairIntent), "closure retains the chapter's source-grounded repair direction");
        assert.doesNotMatch(data.targetContext?.instruction ?? "", /先调用search_target/u);
      }
      if (data.chapterReview) { chapterCalls++; assert.match(data.chapterReview.instruction, /疑似错字|疑似拼写/u); }
      const revise = data.event === "review" && data.candidate.some((t: any) => t.evidence.some((r: any) => r.text.includes("已经离开")));
      if (valueWire) return answer("submit_supervisor_values", { values: data.event === "plan"
        ? [data.windows.length, [], [], "Translate."]
        : [revise ? "revise" : "accept", revise ? [[data.source[0].evidence[0].id, data.candidate[0].evidence[0].id, "Restore source negation."]] : [],
          (data.priorIssues ?? []).map(() => [revise ? "unresolved" : "fixed", data.source[0].evidence[0].id,
            data.candidate[0].evidence[0].id, revise ? "Negation remains wrong." : "Negation restored."]), "Checked."] });
      return answer("submit_supervisor_decision", {
        action: data.event === "plan" ? "translate" : revise ? "revise" : "accept",
        windowIds: data.windows.map((w: any) => w.windowId), reviewBlockIds: [], guidance: [], reason: "核对原文的否定。",
        issues: revise ? [{ blockId: data.candidate[0].blockId, sourceRef: data.source[0].evidence[0].id,
          targetRef: data.candidate[0].evidence[0].id, problem: "译文反转了原文的否定。" }] : [],
        ...(data.priorIssues ? { dispositions: data.priorIssues.map((p: any) => ({ issueId: p.issueId,
          status: revise ? "unresolved" : "fixed", sourceRef: data.source[0].evidence[0].id,
          targetRef: data.candidate[0].evidence[0].id, note: revise ? "否定仍丢失" : "已恢复否定" })) } : {}),
      });
    }
    if (prompt.includes("ORDERED TEXT SLOTS")) {
      const slots: [number, string, string][] = JSON.parse(/ORDERED TEXT SLOTS[^\n]*\n\n([^\n]+)/u.exec(prompt)![1]!);
      return fauxAssistantMessage(JSON.stringify(slots.map(([, , target]) => target.includes("已经离开了")
        ? target.replace("已经离开了", "没有离开") : null)));
    }
    if (context.tools?.some(t => t.name === "submit_repaired_translation")) {
      const candidate = JSON.parse(/FAILED CANDIDATE\n\n([^\n]+)/u.exec(prompt)![1]!);
      return answer("submit_repaired_translation", { translations: candidate.map((t: any) => ({ blockId: t.blockId, text: good })), notes: [] });
    }
    translations++;
    const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
    return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
      translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: bad })), notes: [] })) });
  };
  faux.setResponses(Array.from({ length: 15 }, () => response));
  const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "chapter-review", protocolVersion: "test" }, model: { ...faux.getModel(), ...(valueWire ? { provider: "folioloom-deepseek" } : {}) },
    streamFn: faux.provider.streamSimple.bind(faux.provider), supervisorMode: "bounded" as const,
    chapterReviewMode: "bounded" as const, deliveryMode: "standard" as const,
    shouldPause: () => pauseEnabled && (pauseStage === "before_chapter" ? translations > 0 : chapterCalls > 0),
    maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
  await runBook(options);
  if (pauseEnabled) {
    const partial = LosslessBookStore.openReadOnly(options.storePath);
    try {
      const audit = auditLosslessBookExport(partial, "chapter-review").audit;
      assert.equal(audit.strictExportable, false);
      assert.ok(audit.incidentCodes.includes(pauseStage === "before_chapter" ? "CHAPTER_REVIEW_PENDING" : "QUALITY_REVIEW_PENDING"));
      assert.equal(partial.chapterReviewCheckpoints("chapter-review").length, pauseStage === "before_chapter" ? 0 : 1);
    } finally { partial.close(); }
    pauseEnabled = false;
    await runBook(options);
  }
  assert.equal(chapterCalls, 1, "risk selection cannot stand in for chapter-wide coverage");
  assert.equal(finalCalls, 1, "an unchanged chapter finding goes directly to repair, followed by one closure review");
  const store = LosslessBookStore.openReadOnly(options.storePath);
  try {
    assert.equal(store.activeTranslations("chapter-review")[0]!.text, good);
    assert.equal(auditLosslessBookExport(store, "chapter-review").audit.strictExportable, true);
  } finally { store.close(); }
  const calls = faux.state.callCount;
  await runBook(options);
  assert.equal(faux.state.callCount, calls);
  assert.equal(translations, 1);
  await assert.rejects(() => runBook({ ...options, chapterReviewMode: "off" }), /chapter review policy mismatch/u);
});
}
}
