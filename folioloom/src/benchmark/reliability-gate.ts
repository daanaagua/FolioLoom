import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../source/source-importer.js";
import { runBook } from "../fullbook/book-runner.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import { auditLosslessBookExport, writeLosslessBookArtifacts } from "../report.js";
import { verifyExport } from "../export/export-verifier.js";

export interface ReliabilityGateOptions {
  words?: number;
  faultEvery?: number;
  mode?: "quality" | "fast";
  onProgress?: (message: string) => void;
}

function userText(context: Context): string {
  const message = context.messages.findLast(m => m.role === "user");
  assert.ok(message);
  return typeof message.content === "string" ? message.content
    : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

/** Synthetic contract fixture; the generated CJK text is NOT a literary translation. */
function syntheticSource(words: number): string {
  const vocabulary = "a traveler waited near the narrow door while quiet rain fell over an old stone road and a small garden".split(" ");
  const paragraphs: string[] = [];
  let remaining = words;
  while (remaining > 0) {
    const size = Math.min(180, remaining);
    const row = Array.from({ length: size }, (_, i) => i === 0 ? "section" : i === 1 ? String(paragraphs.length + 1) : vocabulary[(i + paragraphs.length) % vocabulary.length]!);
    paragraphs.push(`${row.join(" ")}.`);
    remaining -= size;
  }
  return paragraphs.join("\n\n");
}

function syntheticTarget(blockId: string, sourceText: string): string {
  let seed = Number.parseInt(blockId.slice(-7), 16) || 17;
  return sourceText.split(/\n\s*\n/u).map(paragraph => Array.from(paragraph).map(character => {
    seed = (Math.imul(seed, 1664525) + 1013904223 + character.codePointAt(0)!) >>> 0;
    return String.fromCodePoint(0x4e00 + seed % 1800);
  }).join("") + "。").join("\n\n");
}

export async function runReliabilityGate(options: ReliabilityGateOptions = {}) {
  const words = options.words ?? 10_000;
  const faultEvery = options.faultEvery ?? 3;
  const mode = options.mode ?? "quality";
  if (!Number.isSafeInteger(words) || words < 100 || words > 1_000_000) throw new Error("words must be an integer in 100..1000000");
  if (!Number.isSafeInteger(faultEvery) || faultEvery < 1) throw new Error("faultEvery must be a positive integer");
  const directory = mkdtempSync(join(tmpdir(), "folioloom-reliability-"));
  const sourcePath = join(directory, "synthetic.txt");
  writeFileSync(sourcePath, syntheticSource(words), "utf8");
  const project = await importSource({ sourcePath, projectDirectory: join(directory, "project"), sourceLanguage: "en" });
  const faux = fauxProvider();
  const translated = new Map<string, number>();
  const injected = new Set<string>();
  let reviews = 0;
  const reply = (context: Context) => {
    const prompt = userText(context);
    const answer = (tool: string, args: unknown) => fauxAssistantMessage(fauxToolCall(tool, args as Record<string, unknown>), { stopReason: "toolUse" });
    if (context.tools?.some(t => t.name === "submit_supervisor_decision")) {
      const data = JSON.parse(prompt) as { event: "plan" | "review"; windows: Array<{ windowId: string; ordinal: number; blockIds: string[] }> };
      const window = data.windows[0]!;
      if (data.event === "review") {
        if (window.ordinal % faultEvery === 0 && !injected.has(window.windowId)) {
          injected.add(window.windowId);
          return fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized (synthetic fault)" });
        }
        reviews += 1;
        if (reviews % 10 === 0) options.onProgress?.(`accepted reviews: ${reviews}; injected faults: ${injected.size}`);
      }
      return answer("submit_supervisor_decision", { action: data.event === "plan" ? "translate" : "accept",
        windowIds: data.windows.map(w => w.windowId), reviewBlockIds: data.event === "plan" ? data.windows.flatMap(w => w.blockIds) : [],
        guidance: [], issues: [], reason: "Synthetic infrastructure contract check." });
    }
    if (context.tools?.some(t => t.name === "submit_lexical_anchors")) {
      const candidates = JSON.parse(/SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u.exec(prompt)![1]!) as Array<{ sourceForm: string }>;
      return answer("submit_lexical_anchors", { anchors: candidates.map(c => ({ sourceForm: c.sourceForm, target: "", mode: "contextual", semanticClass: "role", confidence: 0.5 })), entityLinks: [] });
    }
    const match = /WINDOWS\n\n([^\n]+)\n\nSTABLE TERMS/u.exec(prompt);
    assert.ok(match, `unexpected synthetic request: ${prompt.slice(0, 100)}`);
    const windows = JSON.parse(match[1]!) as Array<{ windowId: string; blocks: Array<{ blockId: string; sourceText: string }> }>;
    const result = windows.map(w => ({ windowId: w.windowId, translations: w.blocks.map(b => {
      translated.set(b.blockId, (translated.get(b.blockId) ?? 0) + 1);
      return { blockId: b.blockId, text: syntheticTarget(b.blockId, b.sourceText) };
    }), notes: [] }));
    if (prompt.includes("EXACT FRAME PAIRS")) {
      const lines = prompt.split(/\r?\n/u).map(line => line.replace(/^\d+\.\s+/u, "").trimStart());
      return fauxAssistantMessage(result.flatMap(w => w.translations.flatMap(t => {
        const begin = lines.find(line => line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:BEGIN:${t.blockId}@@`));
        const end = lines.find(line => line.startsWith("@@FOLIOLOOM:") && line.endsWith(`:END:${t.blockId}@@`));
        assert.ok(begin && end);
        return [begin, t.text, end];
      })).join("\n"));
    }
    return answer("finalize_translation_batch", { windows: result });
  };
  faux.setResponses(Array.from({ length: Math.ceil(words / 100) * 12 }, () => reply));
  const runtime = { model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider) };
  const storePath = join(directory, "book.db");
  const runId = "synthetic-reliability";
  const runOptions = { manifestPath: project.manifestPath, storePath, runMeta: { runId, protocolVersion: "reliability-gate-1" }, ...runtime,
    runtimeSet: { mode, primary: runtime, escalation: runtime }, supervisorMode: "bounded" as const, schedulerMode: "active" as const,
    maxConcurrency: 1, maxWindowsPerRequest: 1, maxAttempts: 1, hardDeadlineMs: 30_000 };
  let resumes = 0;
  const started = performance.now();
  while (true) {
    try {
      const result = await runBook(runOptions);
      assert.equal(result.outcome, "completed");
      break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("synthetic fault") || injected.size <= resumes) throw error;
      resumes += 1;
      assert.ok(resumes <= Math.ceil(words / 100), "bounded fault recovery");
    }
  }
  const callsBeforeResume = faux.state.callCount;
  assert.equal((await runBook(runOptions)).outcome, "completed");
  assert.equal(faux.state.callCount, callsBeforeResume, "completed resume must not call a model");
  const store = new LosslessBookStore(storePath);
  const raw = new DatabaseSync(storePath, { readOnly: true });
  try {
    let dependencyRegeneratedBlocks = 0;
    for (const window of store.allWindows(runId)) {
      const keys = new Set(store.candidateCheckpointRecords(runId, window.windowId).filter(r => r.phase === "candidate").map(r => r.key));
      for (const blockId of window.blockIds) {
        const count = translated.get(blockId) ?? 0;
        assert.ok(count > 0 && count <= keys.size, "unchanged candidate dependencies must not trigger duplicate translation");
        dependencyRegeneratedBlocks += Math.max(0, count - 1);
      }
    }
    const audit = auditLosslessBookExport(store, runId);
    assert.equal(audit.audit.strictExportable, true);
    const settlements = store.loadTokenLedgerEvents(runId).filter(e => e.type === "settled");
    assert.ok(settlements.every(e => e.usageComplete));
    const records = raw.prepare("SELECT payload_json FROM events WHERE run_id=? AND kind='provider_response_evidence'").all(runId) as Array<{ payload_json: string }>;
    const reported = records.reduce((n, row) => n + JSON.parse(row.payload_json).usage.totalTokens, 0);
    assert.equal(settlements.reduce((n, e) => n + e.actualTokens, 0), reported);
    const artifacts = writeLosslessBookArtifacts(store, runId, join(directory, "exports"));
    assert.equal(verifyExport(artifacts, store, runId).ok, true);
    const report = { schema: "folioloom-reliability-gate-1", synthetic: true, semanticQualityMeasured: false,
      words, mode, windows: store.allWindows(runId).length, translatedBlocks: translated.size, injectedFaults: injected.size, resumes,
      modelCalls: faux.state.callCount, reportedTokens: reported, duplicateTranslations: 0, dependencyRegeneratedBlocks,
      strictExportable: true, exportVerified: true, durationMs: Math.round(performance.now() - started), directory };
    writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally { raw.close(); store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
  const mode = value("--mode", "quality");
  if (mode !== "quality" && mode !== "fast") throw new Error("mode must be quality or fast");
  const report = await runReliabilityGate({ words: Number(value("--words", "10000")), faultEvery: Number(value("--fault-every", "3")), mode,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
