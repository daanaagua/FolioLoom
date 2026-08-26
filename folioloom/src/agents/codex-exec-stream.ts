import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const DEFAULT_CONTEXT_WINDOW = 256_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const TEMP_PREFIX = "folioloom-codex-";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export interface CodexExecInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly signal?: AbortSignal;
}

export interface CodexExecProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: string;
}

export type CodexExecProcessRunner = (
  invocation: CodexExecInvocation,
) => Promise<CodexExecProcessResult>;

export interface CodexExecRuntimeOptions {
  readonly modelId: string;
  readonly executable?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly tempRoot?: string;
  readonly processRunner?: CodexExecProcessRunner;
}

export interface CodexLaunchResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly pathValue?: string;
  readonly nodeExecutable?: string;
}

export interface CodexLaunch {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty`);
  }
  return value.trim();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (item !== null && typeof item === "object"
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string") {
      return [(item as { text: string }).text];
    }
    return [];
  }).join("\n");
}

function serializedMessages(context: Context): unknown[] {
  return context.messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", text: textFromContent(message.content) };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool_result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        text: textFromContent(message.content),
      };
    }
    const content: unknown[] = [];
    for (const item of message.content) {
      if (item.type === "text") {
        content.push({ type: "text", text: item.text });
      } else if (item.type === "toolCall") {
        content.push({
          type: "tool_call",
          id: item.id,
          name: item.name,
          arguments: item.arguments,
        });
      }
      // Prior hidden reasoning is neither needed for correction nor copied
      // into a fresh isolated worker job.
    }
    return { role: "assistant", content };
  });
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function schemaRecord(value: unknown, label: string): Record<string, unknown> {
  const candidate = record(value);
  if (candidate === undefined) {
    throw new Error(`CODEX_EXEC_INVALID_SCHEMA: ${label} must be a JSON object`);
  }
  return candidate;
}

function schemaAllowsNull(schema: Record<string, unknown>): boolean {
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)
      && alternatives.some((item) => {
        const candidate = record(item);
        return candidate !== undefined && schemaAllowsNull(candidate);
      })) {
      return true;
    }
  }
  return false;
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return schemaAllowsNull(schema)
    ? schema
    : { anyOf: [schema, { type: "null" }] };
}

/**
 * Codex structured output requires every object to be closed and every
 * property to be required. Represent function-tool optional fields as
 * nullable only on the transport wire; the inverse projection removes those
 * nulls before Pi validates and executes the original tool schema.
 */
export function strictCodexOutputSchema(
  rawSchema: unknown,
): Record<string, unknown> {
  const source = schemaRecord(rawSchema, "tool schema");
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema" || key === "$id"
      || key === "properties" || key === "required"
      || key === "additionalProperties" || key === "items"
      || key === "$defs" || key === "definitions"
      || key === "anyOf" || key === "oneOf" || key === "allOf") {
      continue;
    }
    result[key] = structuredClone(value);
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const alternatives = source[keyword];
    if (alternatives !== undefined) {
      if (!Array.isArray(alternatives)) {
        throw new Error(`CODEX_EXEC_INVALID_SCHEMA: ${keyword} must be an array`);
      }
      result[keyword] = alternatives.map((item) => strictCodexOutputSchema(item));
    }
  }
  if (source.items !== undefined) {
    if (Array.isArray(source.items)) {
      result.items = source.items.map((item) => strictCodexOutputSchema(item));
    } else {
      result.items = strictCodexOutputSchema(source.items);
    }
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    if (source[keyword] !== undefined) {
      const definitions = schemaRecord(source[keyword], keyword);
      result[keyword] = Object.fromEntries(Object.entries(definitions).map(
        ([name, schema]) => [name, strictCodexOutputSchema(schema)],
      ));
    }
  }

  const rawProperties = source.properties;
  if (rawProperties !== undefined || source.type === "object") {
    const properties = rawProperties === undefined
      ? {}
      : schemaRecord(rawProperties, "schema properties");
    if (source.additionalProperties !== undefined
      && source.additionalProperties !== false) {
      throw new Error(
        "CODEX_EXEC_UNSUPPORTED_SCHEMA: open-ended object properties are not supported",
      );
    }
    const originallyRequired = new Set(
      Array.isArray(source.required)
        ? source.required.filter((item): item is string => typeof item === "string")
        : [],
    );
    const strictProperties = Object.fromEntries(Object.entries(properties).map(
      ([name, schema]) => {
        const strict = strictCodexOutputSchema(schema);
        return [name, originallyRequired.has(name) ? strict : nullableSchema(strict)];
      },
    ));
    result.properties = strictProperties;
    result.required = Object.keys(strictProperties);
    result.additionalProperties = false;
  }
  return result;
}

function schemaMatchesValue(schema: Record<string, unknown>, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("null") && value === null) return true;
  if (types.includes("array") && Array.isArray(value)) return true;
  if (types.includes("object") && record(value) !== undefined) return true;
  if (types.includes("string") && typeof value === "string") return true;
  if (types.includes("number") && typeof value === "number") return true;
  if (types.includes("integer") && Number.isInteger(value)) return true;
  if (types.includes("boolean") && typeof value === "boolean") return true;
  return schema.type === undefined && schema.properties !== undefined
    && record(value) !== undefined;
}

function branchForValue(
  schema: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)) {
      for (const alternative of alternatives) {
        const candidate = record(alternative);
        if (candidate !== undefined && schemaMatchesValue(candidate, value)) {
          return candidate;
        }
      }
    }
  }
  return schema;
}

export function restoreToolArguments(
  value: unknown,
  rawSchema: unknown,
): unknown {
  const source = branchForValue(schemaRecord(rawSchema, "tool schema"), value);
  if (Array.isArray(value)) {
    const itemSchema = Array.isArray(source.items)
      ? undefined
      : source.items;
    return itemSchema === undefined
      ? value.map((item) => structuredClone(item))
      : value.map((item) => restoreToolArguments(item, itemSchema));
  }
  const object = record(value);
  const properties = record(source.properties);
  if (object === undefined || properties === undefined) {
    return structuredClone(value);
  }
  const required = new Set(
    Array.isArray(source.required)
      ? source.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const restored: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(object)) {
    const childSchema = properties[name];
    if (child === null && childSchema !== undefined && !required.has(name)) {
      continue;
    }
    restored[name] = childSchema === undefined
      ? structuredClone(child)
      : restoreToolArguments(child, childSchema);
  }
  return restored;
}

function textOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"],
  };
}

function workerPrompt(context: Context, tool: Tool | undefined): string {
  const outputInstruction = tool === undefined
    ? "Return one JSON object with exactly one string field named text. Put the complete requested answer in text."
    : [
      `Return only the JSON arguments for the sole available tool ${JSON.stringify(tool.name)}.`,
      "The final response is validated against that tool's JSON Schema and will be executed by FolioLoom.",
      "Do not wrap the JSON in Markdown and do not add an explanation.",
    ].join(" ");
  const job = {
    systemPrompt: context.systemPrompt ?? "",
    messages: serializedMessages(context),
    ...(tool === undefined ? {} : {
      tool: {
        name: tool.name,
        description: tool.description,
      },
    }),
  };
  return [
    "You are an isolated FolioLoom model-execution worker.",
    "Follow the supplied system prompt and transcript as the complete task context.",
    "Do not inspect the filesystem, modify files, or seek unrelated context.",
    outputInstruction,
    "FOLIOLOOM_JOB_JSON",
    JSON.stringify(job),
  ].join("\n\n");
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codexUsage(stdout: string): Usage {
  let latest: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const event = record(JSON.parse(line));
      if (event?.type === "turn.completed") {
        latest = record(event.usage);
      }
    } catch {
      // Non-JSON diagnostic lines are ignored. The final response file remains
      // the authoritative output channel.
    }
  }
  if (latest === undefined) return structuredClone(ZERO_USAGE);

  const inputTotal = finiteToken(latest.input_tokens ?? latest.inputTokens);
  const cached = finiteToken(
    latest.cached_input_tokens ?? latest.cachedInputTokens,
  ) ?? 0;
  const cacheWrite = finiteToken(
    latest.cache_write_input_tokens ?? latest.cacheWriteInputTokens,
  ) ?? 0;
  const output = finiteToken(latest.output_tokens ?? latest.outputTokens);
  const details = record(latest.output_tokens_details ?? latest.outputTokensDetails);
  const reasoning = finiteToken(
    latest.reasoning_output_tokens
      ?? latest.reasoningOutputTokens
      ?? details?.reasoning_tokens
      ?? details?.reasoningTokens,
  ) ?? 0;
  if (inputTotal === undefined || output === undefined
    || cached + cacheWrite > inputTotal) {
    return structuredClone(ZERO_USAGE);
  }
  return {
    input: inputTotal - cached - cacheWrite,
    output,
    cacheRead: cached,
    cacheWrite,
    reasoning,
    totalTokens: inputTotal + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function clippedDiagnostic(value: string): string {
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`;
}

function codexFailureDiagnostic(result: CodexExecProcessResult): string {
  if (result.spawnError !== undefined && result.spawnError.trim().length > 0) {
    return clippedDiagnostic(result.spawnError);
  }
  if (result.stderr.trim().length > 0) {
    return clippedDiagnostic(result.stderr);
  }
  const diagnostics: string[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const event = record(JSON.parse(line));
      if (event?.type !== "error" && event?.type !== "turn.failed") continue;
      const error = record(event.error);
      const message = event.message ?? error?.message;
      if (typeof message === "string" && message.trim().length > 0) {
        diagnostics.push(message);
      }
    } catch {
      // Raw stdout can contain model text, so never surface unstructured lines.
    }
  }
  return clippedDiagnostic(diagnostics.at(-1) ?? "");
}

function baseMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: structuredClone(ZERO_USAGE),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function errorMessage(
  model: Model<any>,
  message: string,
  aborted: boolean,
): AssistantMessage {
  return {
    ...baseMessage(model),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
  };
}

async function defaultProcessRunner(
  invocation: CodexExecInvocation,
): Promise<CodexExecProcessResult> {
  if (signalAborted(invocation.signal)) {
    return { exitCode: null, stdout: "", stderr: "terminated" };
  }
  let launch: CodexLaunch;
  try {
    launch = resolveCodexLaunch(invocation.command);
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawnError: string | undefined;
    const child = spawn(launch.command, [...launch.prefixArgs, ...invocation.args], {
      cwd: invocation.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      invocation.signal?.removeEventListener("abort", abort);
      resolveResult({
        exitCode,
        stdout,
        stderr,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };
    const abort = (): void => {
      child.kill();
    };
    invocation.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // A process that exits before consuming stdin is reported through its
      // exit code/stderr instead of turning EPIPE into a second failure.
    });
    child.stdin.end(invocation.stdin, "utf8");
  });
}

function assertOwnedTempDirectory(path: string, root: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (dirname(resolvedPath) !== resolvedRoot
    || !basename(resolvedPath).startsWith(TEMP_PREFIX)) {
    throw new Error("refusing to clean an unowned Codex worker directory");
  }
}

function npmCodexEntrypoint(shimPath: string): string {
  return join(
    dirname(shimPath),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
}

function windowsLaunchForPath(
  executablePath: string,
  nodeExecutable: string,
  architecture: NodeJS.Architecture,
): CodexLaunch {
  const extension = extname(executablePath).toLocaleLowerCase("en-US");
  if (extension === ".exe" || extension === ".com") {
    return { command: executablePath, prefixArgs: [] };
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return { command: nodeExecutable, prefixArgs: [executablePath] };
  }
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    const packageRoot = join(
      dirname(executablePath),
      "node_modules",
      "@openai",
      "codex",
    );
    const target = architecture === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
    const platformPackage = architecture === "arm64"
      ? "codex-win32-arm64"
      : "codex-win32-x64";
    const nativeCandidates = [
      join(
        packageRoot,
        "node_modules", "@openai", platformPackage,
        "vendor", target, "bin", "codex.exe",
      ),
      join(packageRoot, "vendor", target, "bin", "codex.exe"),
    ];
    const native = nativeCandidates.find((candidate) => existsSync(candidate));
    if (native !== undefined) {
      return { command: native, prefixArgs: [] };
    }
    const entrypoint = npmCodexEntrypoint(executablePath);
    if (existsSync(entrypoint)) {
      return { command: nodeExecutable, prefixArgs: [entrypoint] };
    }
    throw new Error(
      `CODEX_EXEC_UNSAFE_SHIM: cannot resolve package entrypoint for ${executablePath}`,
    );
  }
  throw new Error(
    `CODEX_EXEC_UNSUPPORTED_EXECUTABLE: Windows requires codex.exe or a recognized npm Codex shim: ${executablePath}`,
  );
}

export function resolveCodexLaunch(
  executable: string,
  options: CodexLaunchResolutionOptions = {},
): CodexLaunch {
  const command = nonempty(executable, "Codex executable");
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, prefixArgs: [] };
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const architecture = options.architecture ?? process.arch;
  const hasDirectory = isAbsolute(command) || /[\\/]/u.test(command);
  if (hasDirectory) {
    const path = resolve(command);
    if (!existsSync(path)) {
      throw new Error(`CODEX_EXEC_NOT_FOUND: executable does not exist: ${path}`);
    }
    return windowsLaunchForPath(path, nodeExecutable, architecture);
  }

  const pathValue = options.pathValue ?? process.env.PATH ?? process.env.Path ?? "";
  const requestedExtension = extname(command);
  const names = requestedExtension.length > 0
    ? [command]
    : [`${command}.exe`, `${command}.com`, `${command}.cmd`, `${command}.bat`, `${command}.ps1`, command];
  for (const rawDirectory of pathValue.split(delimiter)) {
    const pathDirectory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (pathDirectory.length === 0) continue;
    for (const name of names) {
      const candidate = resolve(pathDirectory, name);
      if (existsSync(candidate)) {
        return windowsLaunchForPath(candidate, nodeExecutable, architecture);
      }
    }
  }
  throw new Error(`CODEX_EXEC_NOT_FOUND: executable is not on PATH: ${command}`);
}

export function createCodexExecModel(
  options: Pick<
    CodexExecRuntimeOptions,
    "modelId" | "contextWindow" | "maxOutputTokens"
  >,
): Model<"openai-codex-responses"> {
  const modelId = nonempty(options.modelId, "Codex modelId");
  const contextWindow = positiveInteger(
    options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    "Codex contextWindow",
  );
  const maxTokens = positiveInteger(
    options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    "Codex maxOutputTokens",
  );
  if (maxTokens >= contextWindow) {
    throw new TypeError("Codex maxOutputTokens must be smaller than contextWindow");
  }
  return {
    id: modelId,
    name: `Codex CLI ${modelId}`,
    api: "openai-codex-responses",
    provider: "codex-cli",
    baseUrl: "local://codex-cli",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

export function createCodexExecStreamFn(
  options: CodexExecRuntimeOptions,
): StreamFn {
  const modelId = nonempty(options.modelId, "Codex modelId");
  const executable = nonempty(options.executable ?? "codex", "Codex executable");
  const processRunner = options.processRunner ?? defaultProcessRunner;
  const tempRoot = resolve(options.tempRoot ?? tmpdir());
  const reasoningEffort = options.reasoningEffort ?? "high";

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const partial = baseMessage(model);
    stream.push({ type: "start", partial });

    void (async () => {
      let directory: string | undefined;
      let cleaned = false;
      const cleanup = async (): Promise<void> => {
        if (cleaned || directory === undefined) return;
        cleaned = true;
        try {
          assertOwnedTempDirectory(directory, tempRoot);
          await rm(directory, { recursive: true, force: true });
        } catch {
          // Cleanup failure must not replace the model result. The directory is
          // random, isolated, and contains only this job's schema/output files.
        }
      };
      const complete = async (message: AssistantMessage): Promise<void> => {
        await cleanup();
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({
            type: "error",
            reason: message.stopReason,
            error: message,
          });
        } else {
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end(message);
      };

      try {
        const tools = context.tools ?? [];
        if (tools.length > 1) {
          await complete(errorMessage(
            model,
            "CODEX_EXEC_UNSUPPORTED_TOOL_SET: Codex worker accepts at most one tool",
            false,
          ));
          return;
        }
        if (signalAborted(streamOptions?.signal)) {
          await complete(errorMessage(model, "CODEX_EXEC_ABORTED: terminated", true));
          return;
        }

        await mkdir(tempRoot, { recursive: true });
        directory = await mkdtemp(join(tempRoot, TEMP_PREFIX));
        const schemaFile = join(directory, "output-schema.json");
        const outputFile = join(directory, "last-message.json");
        const tool = tools[0];
        await writeFile(
          schemaFile,
          `${JSON.stringify(
            tool === undefined
              ? textOutputSchema()
              : strictCodexOutputSchema(tool.parameters),
            null,
            2,
          )}\n`,
          "utf8",
        );
        if (signalAborted(streamOptions?.signal)) {
          await complete(errorMessage(model, "CODEX_EXEC_ABORTED: terminated", true));
          return;
        }
        const args = [
          "exec",
          "--model", modelId,
          "--sandbox", "read-only",
          "--cd", directory,
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
          "--output-schema", schemaFile,
          "--output-last-message", outputFile,
          "--json",
          "-",
        ];
        const result = await processRunner({
          command: executable,
          args,
          cwd: directory,
          stdin: workerPrompt(context, tool),
          ...(streamOptions?.signal === undefined
            ? {}
            : { signal: streamOptions.signal }),
        });
        if (signalAborted(streamOptions?.signal)) {
          await complete(errorMessage(model, "CODEX_EXEC_ABORTED: terminated", true));
          return;
        }
        if (result.exitCode !== 0) {
          const diagnostic = codexFailureDiagnostic(result);
          await complete(errorMessage(
            model,
            `CODEX_EXEC_FAILED: exit ${String(result.exitCode)}${diagnostic.length === 0 ? "" : `: ${diagnostic}`}`,
            false,
          ));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(outputFile, "utf8"));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await complete(errorMessage(
            model,
            `CODEX_EXEC_INVALID_OUTPUT: ${clippedDiagnostic(detail)}`,
            false,
          ));
          return;
        }
        const usage = codexUsage(result.stdout);
        const output = record(parsed);
        if (output === undefined) {
          await complete(errorMessage(
            model,
            "CODEX_EXEC_INVALID_OUTPUT: final response must be a JSON object",
            false,
          ));
          return;
        }
        const message: AssistantMessage = tool === undefined
          ? typeof output.text !== "string"
            ? errorMessage(
              model,
              "CODEX_EXEC_INVALID_OUTPUT: text response is missing string field text",
              false,
            )
            : {
              ...baseMessage(model),
              content: [{ type: "text", text: output.text }],
              usage,
              stopReason: "stop",
            }
          : {
            ...baseMessage(model),
            content: [{
              type: "toolCall",
              id: "codex-exec-tool-call-1",
              name: tool.name,
              arguments: restoreToolArguments(
                output,
                tool.parameters,
              ) as Record<string, unknown>,
            }],
            usage,
            stopReason: "toolUse",
          };
        await complete(message);
      } catch (error) {
        const aborted = signalAborted(streamOptions?.signal);
        const detail = error instanceof Error ? error.message : String(error);
        await complete(errorMessage(
          model,
          aborted
            ? "CODEX_EXEC_ABORTED: terminated"
            : `CODEX_EXEC_FAILED: ${clippedDiagnostic(detail)}`,
          aborted,
        ));
      } finally {
        await cleanup();
      }
    })();

    return stream;
  };
}

export function createCodexExecRuntime(
  options: CodexExecRuntimeOptions,
): { model: Model<"openai-codex-responses">; streamFn: StreamFn } {
  return {
    model: createCodexExecModel(options),
    streamFn: createCodexExecStreamFn(options),
  };
}
