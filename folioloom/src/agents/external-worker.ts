import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { serializedMessages } from "./codex-exec-stream.js";

export interface WorkerProfile {
  schema: "folioloom-worker-profile-v1";
  id: string;
  modelId: string;
  command: string;
  args: string[];
  contextWindow: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${name} must be a nonempty string`);
  return value.trim();
}

export function parseWorkerProfile(value: unknown): WorkerProfile {
  const p = object(value);
  if (p?.schema !== "folioloom-worker-profile-v1") throw new Error("unsupported worker profile schema");
  const command = string(p.command, "command");
  if (/\.(cmd|bat|ps1)$/iu.test(command)) throw new Error("worker command must be a native executable, not a shell shim; use node plus the package entrypoint");
  const id = string(p.id, "id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id)) throw new Error("invalid worker profile id");
  const contextWindow = positive(p.contextWindow, "contextWindow");
  const maxOutputTokens = positive(p.maxOutputTokens, "maxOutputTokens");
  if (maxOutputTokens >= contextWindow) throw new Error("maxOutputTokens must be smaller than contextWindow");
  const args = p.args ?? [];
  if (!Array.isArray(args) || args.some(a => typeof a !== "string" || a.includes("\0"))) throw new Error("args must be a string array");
  return {schema: p.schema, id, modelId: string(p.modelId, "modelId"), command, args: [...args], contextWindow, maxOutputTokens, timeoutMs: positive(p.timeoutMs ?? 600_000, "timeoutMs")};
}

export function loadWorkerProfile(path: string): WorkerProfile {
  const profile = parseWorkerProfile(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")));
  if (/[\\/]/u.test(profile.command)) profile.command = resolve(dirname(path), profile.command);
  return profile;
}

export function workerRunMetadata(metadata: unknown, profile: WorkerProfile, resuming: boolean): Record<string, unknown> {
  const existing = object(metadata) ?? {};
  // Persist only the digest, never command arguments which may contain credentials.
  const identity = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  if (resuming && (existing.executionBackend !== "external-worker" || existing.workerIdentity !== identity)) {
    throw new Error("external worker identity changed; use the original profile/model or start a new run");
  }
  return {...existing, executionBackend: "external-worker", workerProfile: profile.id, workerIdentity: identity};
}

const zeroUsage = (): Usage => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}});

export function externalUsage(value: unknown): Usage {
  const u = object(value);
  const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
  if (!u || fields.some(k => typeof u[k] !== "number" || !Number.isSafeInteger(u[k]) || (u[k] as number) < 0)) return zeroUsage();
  const totalTokens = (u.input as number) + (u.output as number) + (u.cacheRead as number) + (u.cacheWrite as number);
  if (!Number.isSafeInteger(totalTokens) || (u.reasoning as number) > (u.output as number)) return zeroUsage();
  return {...zeroUsage(), input: u.input as number, output: u.output as number, cacheRead: u.cacheRead as number, cacheWrite: u.cacheWrite as number, reasoning: u.reasoning as number, totalTokens};
}

// The bridge is trusted operator code, not a sandbox. Only this job's process tree
// is killed; source text travels through stdin and is never interpreted by a shell.
async function invoke(profile: WorkerProfile, cwd: string, stdin: string, signal?: AbortSignal): Promise<string> {
  if (Buffer.byteLength(stdin) > 8_000_000) throw new Error("request exceeds transport limit");
  if (signal?.aborted) throw new Error("terminated");
  return new Promise((accept, reject) => {
    const child = spawn(profile.command, profile.args, {cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]});
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let done = false;
    const kill = (reason: string) => {
      if (failure || done) return;
      failure = new Error(reason);
      if (child.pid !== undefined) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
          killer.on("error", () => child.kill());
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
    };
    const abort = () => kill("terminated");
    const timer = setTimeout(() => kill("worker timeout"), profile.timeoutMs);
    const finish = (code: number | null) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`worker exited unsuccessfully (${String(code)}); inspect the framework's authentication/quota outside the book job`));
      else accept(Buffer.concat(chunks).toString("utf8"));
    };
    child.stdout.on("data", (chunk: Buffer) => {bytes += chunk.length; if (bytes > 8_000_000) kill("response exceeds transport limit"); else chunks.push(chunk);});
    child.stderr.on("data", (chunk: Buffer) => {bytes += chunk.length; if (bytes > 8_000_000) kill("diagnostics exceed transport limit");});
    child.once("error", () => {failure = new Error("worker executable could not be started"); finish(null);});
    child.once("close", finish);
    child.stdin.on("error", () => {});
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) abort();
    child.stdin.end(stdin, "utf8");
  });
}

export function createExternalWorkerRuntime(profile: WorkerProfile): {model: Model<"openai-completions">; streamFn: StreamFn} {
  const model: Model<"openai-completions"> = {id: profile.modelId, name: `${profile.id} ${profile.modelId}`, api: "openai-completions", provider: `external-${profile.id}`, baseUrl: "local://external-worker", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: profile.contextWindow, maxTokens: profile.maxOutputTokens};
  const streamFn: StreamFn = (activeModel, context, options) => {
    const stream = createAssistantMessageEventStream();
    const base: AssistantMessage = {role: "assistant", content: [], api: activeModel.api, provider: activeModel.provider, model: activeModel.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now()};
    stream.push({type: "start", partial: base});
    void (async () => {
      let directory: string | undefined;
      let message = base;
      try {
        if (options?.signal?.aborted) throw new Error("terminated");
        if ((context.tools?.length ?? 0) > 1) throw new Error("worker accepts at most one tool");
        const tool = context.tools?.[0];
        const requestId = randomUUID();
        const request = {schema: "folioloom-worker-v1", requestId, modelId: profile.modelId,
          maxOutputTokens: profile.maxOutputTokens, systemPrompt: context.systemPrompt ?? "", messages: serializedMessages(context),
          outputSchema: tool?.parameters ?? {type: "object", properties: {text: {type: "string"}}, required: ["text"], additionalProperties: false},
          ...(tool ? {tool: {name: tool.name, description: tool.description}} : {})};
        directory = await mkdtemp(join(tmpdir(), "folioloom-worker-"));
        const raw = await invoke(profile, directory, JSON.stringify(request), options?.signal);
        let result: Record<string, unknown> | undefined;
        try { result = object(JSON.parse(raw)); } catch { throw new Error("invalid JSON worker envelope"); }
        if (result?.schema !== request.schema || result.requestId !== requestId || result.modelId !== profile.modelId) throw new Error("worker response identity mismatch");
        base.usage = externalUsage(result.usage);
        if (result.error !== undefined) {
          const code = object(result.error)?.code;
          const reasons: Record<string, string> = {auth: "authentication failed: unauthorized", quota: "insufficient quota", network: "network error: connection failed", output: "invalid JSON output", execution: "framework execution failed"};
          throw new Error(reasons[String(code)] ?? "framework execution failed");
        }
        const output = object(result.output);
        if (!output || (!tool && typeof output.text !== "string")) throw new Error("invalid JSON worker output");
        message = {...base, usage: externalUsage(result.usage), stopReason: tool ? "toolUse" : "stop",
          content: tool ? [{type: "toolCall", id: "external-worker-tool-1", name: tool.name, arguments: output}] : [{type: "text", text: output.text as string}]};
      } catch (error) {
        message = {...base, stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: `EXTERNAL_WORKER_FAILED: ${error instanceof Error ? error.message : "worker failure"}`};
      } finally {
        if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith("folioloom-worker-")) {
          await rm(directory, {recursive: true, force: true}).catch(() => {});
        }
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({type: "error", reason: message.stopReason, error: message});
      else stream.push({type: "done", reason: message.stopReason, message});
      stream.end(message);
    })();
    return stream;
  };
  return {model, streamFn};
}
