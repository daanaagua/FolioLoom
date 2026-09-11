import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { loadOpenCodeApiKey, loadPilotConfig } from "../src/config.js";
import { createProviderRuntime } from "../src/providers/runtime.js";
import type { ProviderEffort } from "../src/providers/types.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { auditLosslessBookStore, writeLosslessBookArtifacts } from "../src/report.js";
import { verifyExport } from "../src/export/export-verifier.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

// Explicit opt-in only. Each invocation creates a fresh synthetic project.
const [configPath, destination, authPath, callLimitArgument] = process.argv.slice(2);
const callLimit = Number(callLimitArgument ?? "4");
if (!Number.isSafeInteger(callLimit) || callLimit < 1 || callLimit > 4) {
  throw new Error("short benchmark call limit must be between 1 and 4");
}
if (!configPath || !destination) {
  throw new Error("Usage: node --import tsx scripts/benchmark-pi-short.ts <config.yaml> <new-output-directory> [opencode-auth.json] [call-limit:1..4]");
}
const config = loadPilotConfig(resolve(configPath), "draft", authPath === undefined ? {} : {
  apiKeyOverride: loadOpenCodeApiKey(resolve(authPath), "deepseek"),
});
const modelId = config.model === "deepseek-v4-flash" ? "deepseek-flash" : config.model;
if (/^(?:opencode|env):/iu.test(config.apiKeyForRuntime())) {
  throw new Error("The config contains a credential reference; supply the authentication file");
}
if (config.provider !== "deepseek" || new URL(config.baseUrl).hostname !== "api.deepseek.com") {
  throw new Error("This bounded fixture requires the official DeepSeek endpoint");
}
const root = resolve(destination);
mkdirSync(dirname(root), { recursive: true });
mkdirSync(root); // Never overwrite or resume an earlier measurement.
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/pi-short-novel.txt");
const source = readFileSync(fixture, "utf8").replace(/\r\n/g, "\n");
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sourceBytes = Buffer.from(source, "utf8");
const manifestPath = join(root, "source_manifest.json");
const storePath = join(root, "book.db");
writeFileSync(join(root, "source.txt"), sourceBytes);
writeFileSync(manifestPath, JSON.stringify({
  schema_version: "v5-source-ledger-1", coordinate_unit: "unicode_scalar",
  raw_path: "source.txt", raw_size: sourceBytes.length, raw_sha256: hash(sourceBytes),
  source_format: ".txt", encoding: "utf-8", extractor: "plain-text-v1", sourceLanguage: "en",
  canonical_path: "source.txt", canonical_chars: [...source].length,
  canonical_sha256: hash(sourceBytes),
  canonical_segments: [{ canonical_start: 0, canonical_end: [...source].length,
    origin_kind: "decoded_bytes", origin_ref: "source.txt", raw_start: 0,
    raw_end: sourceBytes.length, transformation: "decode+newline-normalize" }],
  excluded_raw_ranges: [],
}), "utf8");
const runtime = createProviderRuntime({
  providerId: "deepseek", modelId,
  reasoningEffort: config.reasoningEffort as ProviderEffort,
}, config.apiKeyForRuntime(), { trustedBaseUrl: config.baseUrl, timeoutMs: 60_000 });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("short benchmark deadline exceeded")), 175_000);
let modelCalls = 0;
const observations: Array<Record<string, unknown>> = [];
const streamFn: StreamFn = (model, context, options) => {
  controller.signal.throwIfAborted();
  if (modelCalls >= callLimit) throw new Error("short benchmark model-call budget exhausted");
  const ordinal = ++modelCalls;
  const started = performance.now();
  const observation: Record<string, unknown> = {
    ordinal, tools: context.tools?.map((tool) => tool.name) ?? [],
    contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
  };
  observations.push(observation);
  const output = createAssistantMessageEventStream();
  const signal = options?.signal === undefined ? controller.signal
    : AbortSignal.any([controller.signal, options.signal]);
  console.log(JSON.stringify({event: "model_start", ordinal, tools: observation.tools}));
  void (async () => {
    let terminal = false;
    try {
      const input = await runtime.streamFn(model, context, {
        ...options, signal, maxTokens: Math.min(options?.maxTokens ?? 8192, 8192),
      });
      for await (const event of input) {
        if ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
          && event.delta.length > 0 && observation.firstTokenMs === undefined) {
          observation.firstTokenMs = performance.now() - started;
        }
        if (event.type === "done" || event.type === "error") {
          terminal = true;
          const message = event.type === "done" ? event.message : event.error;
          observation.durationMs = performance.now() - started;
          observation.usage = message.usage;
          observation.stopReason = message.stopReason;
          console.log(JSON.stringify({event: "model_end", ordinal, durationMs: observation.durationMs,
            stopReason: message.stopReason, tokens: message.usage.totalTokens}));
        }
        output.push(event);
      }
      if (!terminal) throw new Error("provider stream ended without a terminal event");
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: "error",
        errorMessage: String(error).replaceAll(config.apiKeyForRuntime(), "[REDACTED]"),
        usage: {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      };
      observation.durationMs = performance.now() - started;
      observation.stopReason = "error";
      output.push({type:"error",reason:"error",error:message});
    } finally { output.end(); }
  })();
  return output;
};
const started = performance.now();
const runId = "pi-short-literary";
const summary: Record<string, unknown> = {
  model: modelId, effort: config.reasoningEffort, sourceSha256: hash(sourceBytes),
  sourceWords: source.trim().split(/\s+/u).length, sourceChars: [...source].length,
  requestBuilderSha256: hash(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/agents/translation-request.ts"))),
};
try {
  const result = await runBook({
    manifestPath, storePath, runMeta: {runId,protocolVersion:"lossless-v5-1",modelId},
    model: runtime.model, streamFn, maxConcurrency: 1, maxAttempts: 1,
    schedulerMode: "active", optimizationProfile: "balanced",
    hardDeadlineMs: 150_000, signal: controller.signal,
  });
  summary.outcome = result.outcome;
  summary.status = result.status;
  const store = new LosslessBookStore(storePath);
  try {
    const audit = auditLosslessBookStore(store, runId);
    summary.audit = audit;
    if (!audit.strictExportable) throw new Error("short benchmark strict audit failed");
    const paths = writeLosslessBookArtifacts(store, runId, join(root, "export"));
    const verification = verifyExport(paths, store, runId);
    summary.exportVerification = verification;
    if (!verification.ok) throw new Error("short benchmark export verification failed");
  } finally { store.close(); }
} catch (error) {
  summary.error = String(error).replaceAll(config.apiKeyForRuntime(), "[REDACTED]");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  summary.wallTimeMs = performance.now() - started;
  summary.modelCalls = modelCalls;
  summary.observations = observations;
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summary));
}
