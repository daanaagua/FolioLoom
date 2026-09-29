import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport } from "../src/report.js";

function userText(context: Context): string {
  const msg = context.messages.findLast(m => m.role === "user");
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

test("native supervised book run persists approvals/reviews, propagates task context, and resumes without calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-supervised-"));
  const source = join(root, "original.txt");
  writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.", "utf8");
  const project = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const prefix = "以下测试原文用于个人阅读，请忠实翻译。";
  const observed: string[] = [];
  const reply = (context: Context) => {
    observed.push(context.systemPrompt ?? "");
    const prompt = userText(context);
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const data = JSON.parse(prompt);
      return fauxAssistantMessage(fauxToolCall("submit_supervisor_decision", {
        action: data.event === "plan" ? "translate" : "accept", windowIds: data.windows.map((w: any) => w.windowId),
        reviewBlockIds: data.event === "plan" ? data.windows.flatMap((w: any) => w.blockIds) : [],
        guidance: [], issues: [], reason: "按原意推进并检查否定。",
      }), { stopReason: "toolUse" });
    }
    const match = /WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt);
    assert.ok(match, `unexpected request: ${prompt.slice(0, 80)}`);
    const windows = JSON.parse(match[1]!);
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((w: any) => ({ windowId: w.windowId, translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: "那位安静的旅人没有离开屋子。他守在门边，等到雨终于停了下来。" })), notes: [] })),
    }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 8 }, () => reply));
  const options = { manifestPath: project.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "native-supervised", protocolVersion: "test" },
    model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), supervisorMode: "bounded" as const, taskContext: prefix,
    maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
  const result = await runBook(options);
  assert.equal(result.outcome, "completed");
  assert.ok(observed.length >= 3);
  assert.ok(observed.every(p => p.startsWith(prefix)));
  const calls = faux.state.callCount;
  const store = new LosslessBookStore(options.storePath);
  try {
    assert.ok(store.supervisionRecords(options.runMeta.runId).some(r => r.decision?.action === "translate"));
    assert.ok(store.supervisionRecords(options.runMeta.runId).some(r => r.decision?.action === "accept"));
    const audit = auditLosslessBookExport(store, options.runMeta.runId);
    assert.equal(audit.audit.strictExportable, true);
    assert.equal(audit.scheduler?.tokenUsageComplete, true);
  } finally { store.close(); }
  assert.equal((await runBook(options)).outcome, "completed");
  assert.equal(faux.state.callCount, calls);
  await assert.rejects(() => runBook({ ...options, taskContext: "改变后的任务背景" }), /task context/u);
  await assert.rejects(() => runBook({ ...options, supervisorMode: "off" }), /supervision/u);
  assert.equal(faux.state.callCount, calls);
});

for (const scenario of ["repair", "review-auth", "pause"] as const) {
  test(`supervised native integration: ${scenario} preserves scope and exact accounting`, async () => {
    const root = mkdtempSync(join(tmpdir(), "folioloom-supervision-recovery-"));
    const source = join(root, "source.txt");
    writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.", "utf8");
    const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
    const faux = fauxProvider();
    const prefix = "仅供个人阅读的合成测试。";
    const good = "那位安静的旅人没有离开屋子。他守在门边，一直等到外面的雨停了下来。";
    const bad = "那位安静的旅人已经离开了屋子。他守在门边，一直等到外面的雨停了下来。";
    let released = false;
    const reply = (context: Context) => {
      assert.ok(context.systemPrompt?.startsWith(prefix));
      const prompt = userText(context);
      const answer = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
      if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
        const data = JSON.parse(prompt);
        if (scenario === "review-auth" && data.event === "review") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" });
        const needsRepair = data.event === "review" && data.candidate.some((t: any) => t.text.includes("已经离开"));
        return answer("submit_supervisor_decision", {
          action: scenario === "pause" && !released ? "pause" : data.event === "plan" ? "translate" : needsRepair ? "revise" : "accept",
          windowIds: data.windows.map((w: any) => w.windowId),
          reviewBlockIds: data.event === "plan" && !(scenario === "pause" && !released) ? data.windows.flatMap((w: any) => w.blockIds) : [],
          guidance: [], reason: "核对否定含义。",
          issues: needsRepair ? [{ blockId: data.candidate[0].blockId, sourceQuote: "did not leave the house", targetQuote: "已经离开了屋子", problem: "译文反转了原文的否定。" }] : [],
        });
      }
      if (context.tools?.some(t => t.name === "submit_repaired_translation")) {
        const candidate = JSON.parse(/FAILED CANDIDATE\n\n([^\n]+)/u.exec(prompt)![1]!);
        return answer("submit_repaired_translation", { translations: candidate.map((t: any) => ({ blockId: t.blockId, text: good })), notes: [] });
      }
      const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
      return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
        translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: scenario === "repair" ? bad : good })), notes: [] })) });
    };
    faux.setResponses(Array.from({ length: 12 }, () => reply));
    const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "supervised", protocolVersion: "test" },
      model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), taskContext: prefix, supervisorMode: "bounded" as const,
      maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
    if (scenario === "pause") {
      await assert.rejects(() => runBook(options), /SUPERVISION_PAUSED/u);
      await assert.rejects(() => runBook(options), /SUPERVISION_PAUSED/u);
      assert.equal(faux.state.callCount, 1);
      const store = new LosslessBookStore(options.storePath);
      try {
        const paused = store.supervisionRecords("supervised").find(r => r.state === "paused")!;
        assert.equal(auditLosslessBookExport(store, "supervised").audit.strictExportable, false);
        store.releaseSupervisionPause("supervised", paused.id, "已解决测试约束。");
      } finally { store.close(); }
      released = true;
      assert.equal((await runBook(options)).outcome, "completed");
      assert.equal(faux.state.callCount, 4);
    } else if (scenario === "review-auth") {
      await assert.rejects(() => runBook(options), /SUPERVISION_EXECUTION_FAILED.*Unauthorized/u);
      assert.equal(faux.state.callCount, 3);
    } else {
      assert.equal((await runBook(options)).outcome, "completed");
      assert.equal(faux.state.callCount, 5);
    }
    const store = new LosslessBookStore(options.storePath);
    const raw = new DatabaseSync(options.storePath, { readOnly: true });
    try {
      const ledger = store.loadTokenLedgerEvents("supervised").filter(e => e.type === "settled");
      const evidence = raw.prepare("SELECT payload_json FROM events WHERE run_id=? AND kind='provider_response_evidence'").all("supervised") as Array<{ payload_json: string }>;
      const actual = evidence.reduce((n, row) => n + JSON.parse(row.payload_json).usage.totalTokens, 0);
      assert.ok(actual > 0);
      assert.ok(ledger.every(e => e.usageComplete));
      assert.equal(ledger.reduce((n, e) => n + e.actualTokens, 0), actual, "each real response is charged exactly once");
      if (scenario !== "review-auth") {
        assert.equal(store.activeTranslations("supervised")[0]?.text, good);
        assert.equal(auditLosslessBookExport(store, "supervised").audit.strictExportable, true);
      } else {
        assert.equal(store.statusSummary("supervised").humanRequiredWindows, 0);
        assert.equal(store.activeTranslations("supervised").length, 0);
      }
    } finally { raw.close(); store.close(); }
  });
}
