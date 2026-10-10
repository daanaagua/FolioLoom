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
import { auditLosslessBookExport, writeLosslessBookArtifacts } from "../src/report.js";
import { verifyExport } from "../src/export/export-verifier.js";
import { writeLosslessBookEpub } from "../src/export/epub-writer.js";
import { RuntimeProfileStore } from "../src/storage/runtime-profile-store.js";
import { runtimeObservationProfileKey } from "../src/fullbook/runtime-telemetry.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { canonicalJson } from "../src/knowledge/knowledge-store.js";
import { supervisionHash } from "../src/domain/supervision.js";
import { RunLease } from "../src/kernel/run-lease.js";
import { QualityQueue } from "../src/fullbook/delivery-policy.js";

function userText(context: Context): string {
  const msg = context.messages.findLast(m => m.role === "user");
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

for (const finalRepairSucceeds of [true, false]) {
 for (const switchFromStrict of [false, true]) {
  test(`standard delivery final review is durable and bounded (repair succeeds: ${finalRepairSucceeds}; switch: ${switchFromStrict})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "folioloom-standard-"));
    const source = join(root, "source.txt");
    writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.", "utf8");
    const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
    const faux = fauxProvider();
    const good = "那位安静的旅人没有离开屋子。他守在门边，一直等到外面的雨停了下来。";
    const bad = "那位安静的旅人已经离开了屋子。他守在门边，一直等到外面的雨停了下来。";
    let repairCalls = 0;
    let translationCalls = 0;
    let reworkGood = false;
    const reply = (context: Context) => {
      const prompt = userText(context);
      const answer = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
      if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
        const data = JSON.parse(prompt);
        const revise = data.event === "review" && data.candidate.some((t: any) => t.evidence.some((r: any) => r.text.includes("已经离开")));
        return answer("submit_supervisor_decision", { action: data.event === "plan" ? "translate" : revise ? "revise" : "accept",
          windowIds: data.windows.map((w: any) => w.windowId), reviewBlockIds: data.event === "plan" ? data.windows.flatMap((w: any) => w.blockIds) : [],
          ...(data.priorIssues ? { dispositions: data.priorIssues.map((p: any) => ({ issueId: p.issueId, status: revise ? "unresolved" : "fixed",
            sourceRef: data.source[0].evidence[0].id, targetRef: data.candidate[0].evidence[0].id, note: revise ? "否定仍丢失" : "已恢复否定" })) } : {}),
          guidance: [], reason: "核对否定含义。", issues: revise ? [{ blockId: data.candidate[0].blockId,
            sourceRef: data.source[0].evidence[0].id, targetRef: data.candidate[0].evidence[0].id, problem: "译文反转了原文的否定。" }] : [] });
      }
      if (context.tools?.some(t => t.name === "submit_repaired_translation")) {
        repairCalls++;
        const candidate = JSON.parse(/FAILED CANDIDATE\n\n([^\n]+)/u.exec(prompt)![1]!);
        return answer("submit_repaired_translation", { translations: candidate.map((t: any) => ({ blockId: t.blockId,
          text: reworkGood || finalRepairSucceeds && repairCalls > (switchFromStrict ? 2 : 1) ? good : bad })), notes: [] });
      }
      translationCalls++;
      const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
      return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
        translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: bad })), notes: [] })) });
    };
    faux.setResponses(Array.from({ length: 15 }, () => reply));
    const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "standard", protocolVersion: "test" },
      model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), supervisorMode: "bounded" as const,
      maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000 };
    if (switchFromStrict) {
      await assert.rejects(() => runBook({ ...options, deliveryMode: "strict" }), /CANDIDATE_RECOVERY_PAUSED/u);
      await assert.rejects(() => runBook(options), /SUPERVISION_PAUSED/u);
    }
    assert.equal((await runBook({ ...options, ...(switchFromStrict ? { deliveryMode: "standard" as const } : {}) })).outcome, "completed_with_warnings");
    const store = new LosslessBookStore(options.storePath);
    try {
      assert.equal(store.deliveryMode("standard"), "standard");
      const records = store.qualityRecords("standard");
      assert.equal(records.at(-1)?.state, finalRepairSucceeds ? "resolved" : "unresolved");
      if (finalRepairSucceeds) {
        assert.equal(records.at(-1)?.closure?.policy, "issue-closure-2");
        assert.equal(records.at(-1)?.closure?.dispositions[0]?.status, "fixed");
        assert.ok(records.at(-1)?.closure?.dispositions.every(d => d.note.length <= 160));
      }
      assert.equal(records.filter(r => r.state === "reviewing").length, 1);
      assert.equal(store.activeTranslations("standard")[0]?.text, finalRepairSucceeds ? good : bad);
      assert.equal(store.styleObservations("standard").length, 0);
      assert.equal(auditLosslessBookExport(store, "standard").audit.strictExportable, finalRepairSucceeds);
      assert.equal(auditLosslessBookExport(store, "standard").audit.deliveryReady, true);
      const artifacts = writeLosslessBookArtifacts(store, "standard", join(root, "exports"));
      artifacts.epub = await writeLosslessBookEpub(store, "standard", join(root, "exports", "book.epub"), { title: "Test", language: "zh-CN" });
      assert.equal(verifyExport(artifacts, store, "standard").ok, true);
      assert.ok(artifacts.qualityReport);
      writeFileSync(artifacts.qualityReport, "{}", "utf8");
      assert.ok(verifyExport(artifacts, store, "standard").incidentCodes.includes("QUALITY_REPORT_MISMATCH"));
      if (!finalRepairSucceeds) assert.throws(() => writeLosslessBookArtifacts(store, "standard", join(root, "strict"), { deliveryMode: "strict" }), /strict book export/u);
    } finally { store.close(); }
    assert.equal(translationCalls, 1);
    assert.equal(repairCalls, switchFromStrict ? 3 : 2);
    const calls = faux.state.callCount;
    assert.equal((await runBook(options)).outcome, "completed_with_warnings");
    assert.equal(faux.state.callCount, calls);
    if (!finalRepairSucceeds && !switchFromStrict) {
      const control = new LosslessBookStore(options.storePath);
      const failed = new QualityQueue("standard", control).items()[0]!;
      const request = { itemId: failed.itemId, requestId: "protocol-rework-1", expectedRecordId: failed.id,
        expectedCandidateHash: failed.candidateHash, reason: "Repair transport changed; retry the retained candidate." };
      const recordsBefore = control.qualityRecords("standard");
      const ledgerBefore = control.loadTokenLedgerEvents("standard");
      const lease = RunLease.acquire(`${options.storePath}.run.lock`, "lossless:standard");
      assert.throws(() => control.requestQualityRework("standard", request), /active run lease/u);
      lease.release();
      assert.throws(() => control.requestQualityRework("standard", { ...request, expectedCandidateHash: "f".repeat(64) }), /stale/u);
      control.requestQualityRework("standard", request);
      control.requestQualityRework("standard", request);
      assert.deepEqual(control.qualityRecords("standard").slice(0, recordsBefore.length), recordsBefore);
      assert.equal(control.qualityRecords("standard").length, recordsBefore.length + 1);
      assert.deepEqual(control.loadTokenLedgerEvents("standard"), ledgerBefore);
      control.close();
      reworkGood = true;
      await runBook(options);
      const verified = LosslessBookStore.openReadOnly(options.storePath);
      try {
        assert.equal(new QualityQueue("standard", verified).items()[0]?.state, "resolved");
        assert.equal(verified.activeTranslations("standard")[0]?.text, good);
        assert.equal(auditLosslessBookExport(verified, "standard").audit.strictExportable, true);
        assert.equal(translationCalls, 1);
        assert.ok(verified.supervisionRecords("standard").filter(r => r.state === "started" && r.event === "review").length < 12);
      } finally { verified.close(); }
      const afterRework = faux.state.callCount;
      await runBook(options);
      assert.equal(faux.state.callCount, afterRework);
    }
  });
 }
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

for (const scenario of ["repair", "novel-review", "review-auth", "legacy-checkpoint", "repaired-review-auth", "no-progress", "post-repair-revise", "pause"] as const) {
  test(`supervised native integration: ${scenario} preserves scope and exact accounting`, async () => {
    const root = mkdtempSync(join(tmpdir(), "folioloom-supervision-recovery-"));
    const source = join(root, "source.txt");
    writeFileSync(source, "the quiet traveler did not leave the house. he waited by the door until the rain stopped.", "utf8");
    const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
    const faux = fauxProvider();
    const profiles = scenario === "review-auth" ? new RuntimeProfileStore(join(root, "profiles.db")) : undefined;
    const profileKey = runtimeObservationProfileKey({ modelId: faux.getModel().id, languageProfileId: getSourceLanguageProfile("en").id });
    const prefix = "仅供个人阅读的合成测试。";
    const good = "那位安静的旅人没有离开屋子。他守在门边，一直等到外面的雨停了下来。";
    const bad = "那位安静的旅人已经离开了屋子。他守在门边，一直等到外面的雨停了下来。";
    let released = false;
    let authRecovered = false;
    let translationCalls = 0;
    let repairCalls = 0;
    let repairReleased = false;
    const reviewAuth = scenario === "review-auth" || scenario === "legacy-checkpoint";
    const reply = (context: Context) => {
      assert.ok(context.systemPrompt?.startsWith(prefix));
      const prompt = userText(context);
      const answer = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
      if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
        const data = JSON.parse(prompt);
        if (!authRecovered && data.event === "review" && (reviewAuth || (scenario === "repaired-review-auth" && repairCalls > 0))) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" });
        const needsRepair = data.event === "review" && (scenario === "post-repair-revise" || (scenario === "novel-review" && repairCalls < 2) || data.candidate.some((t: any) => t.evidence.some((r: any) => r.text.includes("已经离开"))));
        return answer("submit_supervisor_decision", {
          action: scenario === "pause" && !released ? "pause" : data.event === "plan" ? "translate" : needsRepair ? "revise" : "accept",
          windowIds: data.windows.map((w: any) => w.windowId),
          reviewBlockIds: data.event === "plan" && !(scenario === "pause" && !released) ? data.windows.flatMap((w: any) => w.blockIds) : [],
          guidance: [], reason: "核对否定含义。",
          issues: needsRepair ? [{ blockId: data.candidate[0].blockId, sourceRef: data.source[0].evidence[0].id, targetRef: data.candidate[0].evidence[0].id, problem: scenario === "novel-review" && repairCalls === 1 ? "人物称呼有一处不一致。" : "译文反转了原文的否定。" }] : [],
        });
      }
      if (context.tools?.some(t => t.name === "submit_repaired_translation")) {
        repairCalls += 1;
        const candidate = JSON.parse(/FAILED CANDIDATE\n\n([^\n]+)/u.exec(prompt)![1]!);
        return answer("submit_repaired_translation", { translations: candidate.map((t: any) => ({ blockId: t.blockId, text: scenario === "no-progress" && !repairReleased ? bad : scenario === "novel-review" && repairCalls === 1 ? "那位旅人没有离开屋子。他静静站在门边，等候雨停下来。" : good })), notes: [] });
      }
      const windows = JSON.parse(/WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt)![1]!);
      translationCalls += 1;
      return answer("finalize_translation_batch", { windows: windows.map((w: any) => ({ windowId: w.windowId,
        translations: w.blocks.map((b: any) => ({ blockId: b.blockId, text: ["repair", "novel-review", "repaired-review-auth", "no-progress", "post-repair-revise"].includes(scenario) ? bad : good })), notes: [] })) });
    };
    faux.setResponses(Array.from({ length: 12 }, () => reply));
    const options = { manifestPath: imported.manifestPath, storePath: join(root, "book.db"), runMeta: { runId: "supervised", protocolVersion: "test" },
      model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider), taskContext: prefix, supervisorMode: "bounded" as const, deliveryMode: "strict" as const,
      maxConcurrency: 1, maxAttempts: 1, hardDeadlineMs: 10000, runtimeProfileStore: profiles };
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
    } else if (reviewAuth || scenario === "repaired-review-auth") {
      await assert.rejects(() => runBook(options), /SUPERVISION_EXECUTION_FAILED.*Unauthorized/u);
      assert.equal(faux.state.callCount, reviewAuth ? 3 : 5);
      const interrupted = new LosslessBookStore(options.storePath);
      try {
        assert.equal(interrupted.statusSummary("supervised").humanRequiredWindows, 0);
        assert.equal(interrupted.activeTranslations("supervised").length, 0);
        assert.equal(auditLosslessBookExport(interrupted, "supervised").audit.strictExportable, false);
        if (scenario === "legacy-checkpoint") {
          const windowId = interrupted.allWindows("supervised")[0]!.windowId;
          const { id: _id, ...prior } = interrupted.candidateCheckpointRecords("supervised", windowId).at(-1)!;
          const candidate = { ...prior.candidate, translations: prior.candidate.translations.map(t => ({ ...t,
            text: "the quiet traveler did not leave the house. he waited by the door until the rain stopped." })) };
          const payload = { ...prior, candidate, candidateHash: supervisionHash(canonicalJson(candidate)) };
          interrupted.appendCandidateCheckpoint("supervised", { ...payload, id: supervisionHash(canonicalJson(payload)) });
        }
      } finally { interrupted.close(); }
      authRecovered = true;
      const profileSamples = profiles?.observationsForProfile(profileKey).length;
      assert.equal((await runBook(options)).outcome, "completed");
      assert.equal(translationCalls, 1, "resume must review the durable candidate without retranslating it");
      assert.equal(faux.state.callCount, reviewAuth ? 4 : 6);
      assert.equal(repairCalls, reviewAuth ? 0 : 1);
      if (profiles) assert.equal(profiles.observationsForProfile(profileKey).length, profileSamples, "checkpoint-only resume must not train provider latency from a local cache hit");
    } else if (scenario === "no-progress" || scenario === "post-repair-revise") {
      await assert.rejects(() => runBook(options), /CANDIDATE_RECOVERY_PAUSED/u);
      const calls = faux.state.callCount;
      await assert.rejects(() => runBook(options), /CANDIDATE_RECOVERY_PAUSED|SUPERVISION_PAUSED/u);
      assert.equal(faux.state.callCount, calls, "resume cannot replenish spent repair credit");
      assert.equal(translationCalls, 1);
      assert.equal(repairCalls, 1);
      if (scenario === "no-progress") {
        const pausedStore = new LosslessBookStore(options.storePath);
        try {
          const pause = pausedStore.supervisionRecords("supervised").findLast(r => r.state === "paused");
          assert.ok(pause, "candidate recovery must expose an operator-releasable checkpoint");
          pausedStore.releaseSupervisionPause("supervised", pause.id, "The repair constraint has been corrected.");
        } finally { pausedStore.close(); }
        repairReleased = true;
        assert.equal((await runBook(options)).outcome, "completed");
        assert.equal(translationCalls, 1, "explicit release retains the existing candidate");
        assert.equal(repairCalls, 2);
      }
    } else {
      assert.equal((await runBook(options)).outcome, "completed");
      assert.equal(faux.state.callCount, scenario === "novel-review" ? 7 : 5);
      if (scenario === "novel-review") assert.equal(repairCalls, 2);
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
      if (scenario === "legacy-checkpoint") assert.equal(store.recoveryRecords("supervised").filter(r => r.action === "reject_checkpoint").length, 1);
      if (scenario === "post-repair-revise") {
        assert.equal(store.activeTranslations("supervised").length, 0);
        assert.equal(auditLosslessBookExport(store, "supervised").audit.strictExportable, false);
      } else {
        assert.equal(store.activeTranslations("supervised")[0]?.text, good);
        assert.equal(auditLosslessBookExport(store, "supervised").audit.strictExportable, true);
      }
    } finally { raw.close(); store.close(); profiles?.close(); }
  });
}
