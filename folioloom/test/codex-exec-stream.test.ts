import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Context } from "@earendil-works/pi-ai";

import {
  createCodexExecRuntime,
  resolveCodexLaunch,
  restoreToolArguments,
  strictCodexOutputSchema,
  type CodexExecInvocation,
  type CodexExecProcessRunner,
} from "../src/agents/codex-exec-stream.js";
import { PiRuntime } from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { Type, type TypedToolSpec } from "../src/tools/tool-spec.js";

const TOOL_CONTEXT: Context = {
  systemPrompt: "你是文学翻译 worker。",
  messages: [{
    role: "user",
    content: "Translate this source exactly: Die Verwandlung.",
    timestamp: 1,
  }],
  tools: [{
    name: "finalize_translation",
    description: "Submit the translated text.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1 },
        note: { type: "string" },
      },
      required: ["text"],
    },
  }],
};

test("Windows resolves the npm codex.cmd shim to node plus the package entrypoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folioloom-codex-launch-"));
  const shim = join(directory, "codex.cmd");
  const entrypoint = join(
    directory,
    "node_modules", "@openai", "codex", "bin", "codex.js",
  );
  try {
    await mkdir(join(directory, "node_modules", "@openai", "codex", "bin"), {
      recursive: true,
    });
    await writeFile(shim, "@echo off\r\n", "utf8");
    await writeFile(entrypoint, "", "utf8");

    assert.deepEqual(resolveCodexLaunch("codex", {
      platform: "win32",
      pathValue: directory,
      nodeExecutable: "C:\\runtime\\node.exe",
    }), {
      command: "C:\\runtime\\node.exe",
      prefixArgs: [entrypoint],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows prefers the packaged native Codex binary behind an npm shim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folioloom-codex-native-"));
  const shim = join(directory, "codex.cmd");
  const native = join(
    directory,
    "node_modules", "@openai", "codex",
    "node_modules", "@openai", "codex-win32-x64",
    "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
  );
  try {
    await mkdir(join(native, ".."), { recursive: true });
    await writeFile(shim, "@echo off\r\n", "utf8");
    await writeFile(native, "", "utf8");

    assert.deepEqual(resolveCodexLaunch("codex", {
      platform: "win32",
      architecture: "x64",
      pathValue: directory,
      nodeExecutable: "C:\\runtime\\node.exe",
    }), {
      command: native,
      prefixArgs: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict Codex schemas close nested objects and round-trip optional null fields", () => {
  const source = {
    type: "object",
    properties: {
      styleObservation: {
        type: "object",
        properties: {
          modeWeights: {
            type: "object",
            properties: {
              narrative: { type: "number" },
              technical: { type: "number" },
            },
          },
        },
      },
    },
  };
  const strict = strictCodexOutputSchema(source);
  const style = (strict.properties as Record<string, unknown>).styleObservation as {
    anyOf: Array<Record<string, unknown>>;
  };
  const styleObject = style.anyOf[0]!;
  const modeWeights = (styleObject.properties as Record<string, unknown>).modeWeights as {
    anyOf: Array<Record<string, unknown>>;
  };
  const weightsObject = modeWeights.anyOf[0]!;

  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ["styleObservation"]);
  assert.equal(styleObject.additionalProperties, false);
  assert.deepEqual(styleObject.required, ["modeWeights"]);
  assert.equal(weightsObject.additionalProperties, false);
  assert.deepEqual(weightsObject.required, ["narrative", "technical"]);
  assert.deepEqual(restoreToolArguments({
    styleObservation: {
      modeWeights: { narrative: null, technical: 0.4 },
    },
  }, source), {
    styleObservation: {
      modeWeights: { technical: 0.4 },
    },
  });
});

function outputPath(invocation: CodexExecInvocation): string {
  const index = invocation.args.indexOf("--output-last-message");
  assert.notEqual(index, -1);
  const value = invocation.args[index + 1];
  assert.equal(typeof value, "string");
  return value;
}

function schemaPath(invocation: CodexExecInvocation): string {
  const index = invocation.args.indexOf("--output-schema");
  assert.notEqual(index, -1);
  const value = invocation.args[index + 1];
  assert.equal(typeof value, "string");
  return value;
}

function successfulRunner(
  output: unknown,
  captures: CodexExecInvocation[],
  schemas: unknown[] = [],
  usage: Record<string, unknown> | null = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 5,
    output_tokens: 30,
    reasoning_output_tokens: 10,
  },
): CodexExecProcessRunner {
  return async (invocation) => {
    captures.push(invocation);
    schemas.push(JSON.parse(await readFile(schemaPath(invocation), "utf8")));
    await writeFile(outputPath(invocation), JSON.stringify(output), "utf8");
    return {
      exitCode: 0,
      stdout: usage === null
        ? `${JSON.stringify({ type: "turn.completed" })}\n`
        : `${JSON.stringify({ type: "turn.completed", usage })}\n`,
      stderr: "",
    };
  };
}

async function resultFor(
  processRunner: CodexExecProcessRunner,
  context: Context,
  signal?: AbortSignal,
) {
  const runtime = createCodexExecRuntime({
    modelId: "gpt-test",
    processRunner,
  });
  const stream = await runtime.streamFn(runtime.model, context, { signal });
  return stream.result();
}

test("Codex exec sends the job over UTF-8 stdin and restores one typed tool call", async () => {
  const captures: CodexExecInvocation[] = [];
  const schemas: unknown[] = [];
  const message = await resultFor(
    successfulRunner({ text: "《变形记》", note: null }, captures, schemas),
    TOOL_CONTEXT,
  );

  assert.equal(captures.length, 1);
  const invocation = captures[0]!;
  assert.equal(invocation.command, "codex");
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("--ignore-rules"));
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("--skip-git-repo-check"));
  assert.ok(invocation.args.includes("--json"));
  assert.equal(invocation.args.join(" ").includes("Die Verwandlung"), false);
  assert.match(invocation.stdin, /Die Verwandlung/u);
  assert.match(invocation.stdin, /你是文学翻译 worker/u);
  assert.deepEqual(schemas[0], {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", minLength: 1 },
      note: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
    },
    required: ["text", "note"],
  });
  assert.equal(existsSync(invocation.cwd), false);

  assert.equal(message.stopReason, "toolUse");
  assert.equal(message.provider, "codex-cli");
  assert.deepEqual(message.content, [{
    type: "toolCall",
    id: "codex-exec-tool-call-1",
    name: "finalize_translation",
    arguments: { text: "《变形记》" },
  }]);
  assert.deepEqual(message.usage, {
    input: 75,
    output: 30,
    cacheRead: 20,
    cacheWrite: 5,
    reasoning: 10,
    totalTokens: 130,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  });
});

test("Codex exec restores a schema-bounded text response when no tool is exposed", async () => {
  const captures: CodexExecInvocation[] = [];
  const schemas: unknown[] = [];
  const message = await resultFor(
    successfulRunner({ text: "首选译名" }, captures, schemas),
    {
      systemPrompt: "Return one preferred Chinese term.",
      messages: [{ role: "user", content: "Gregor", timestamp: 1 }],
      tools: [],
    },
  );

  assert.deepEqual(schemas[0], {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"],
  });
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "首选译名" }]);
});

test("PiRuntime executes a typed Codex worker result through the existing capability gate", async () => {
  const captures: CodexExecInvocation[] = [];
  const created = createCodexExecRuntime({
    modelId: "gpt-test",
    processRunner: successfulRunner({ text: "格里高尔醒了。" }, captures),
  });
  let submitted = "";
  const tools: TypedToolSpec[] = [{
    name: "finalize_translation",
    label: "Finalize translation",
    description: "Submit one translated paragraph.",
    phase: "translation",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    execute: async (rawArgs) => {
      submitted = (rawArgs as { text: string }).text;
      return { accepted: true };
    },
  }];

  const result = await new PiRuntime().run({
    systemPrompt: "Translate literary German into Chinese.",
    prompt: "Als Gregor Samsa eines Morgens erwachte.",
    phase: "translation",
    model: created.model,
    tools,
    budget: new BudgetLedger(),
    terminateTools: ["finalize_translation"],
    maxTurns: 1,
  }, created.streamFn);

  assert.equal(submitted, "格里高尔醒了。");
  assert.deepEqual(result.toolNames, ["finalize_translation"]);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.usage.totalTokens, 130);
});

test("Codex exec fails closed before dispatch when multiple tools are exposed", async () => {
  let calls = 0;
  const message = await resultFor(async () => {
    calls += 1;
    throw new Error("must not dispatch");
  }, {
    ...TOOL_CONTEXT,
    tools: [
      TOOL_CONTEXT.tools![0]!,
      { ...TOOL_CONTEXT.tools![0]!, name: "other_tool" },
    ],
  });

  assert.equal(calls, 0);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /CODEX_EXEC_UNSUPPORTED_TOOL_SET/u);
});

test("Codex exec reports nonzero exits and invalid output as provider errors", async () => {
  const failed = await resultFor(async () => ({
    exitCode: 7,
    stdout: "",
    stderr: "account quota exhausted",
  }), TOOL_CONTEXT);
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage ?? "", /quota exhausted/u);

  const structuredFailure = await resultFor(async () => ({
    exitCode: 1,
    stdout: [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "PRIVATE SOURCE MUST NOT LEAK" },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "Invalid response_format schema" },
      }),
    ].join("\n"),
    stderr: "",
  }), TOOL_CONTEXT);
  assert.match(structuredFailure.errorMessage ?? "", /Invalid response_format schema/u);
  assert.doesNotMatch(structuredFailure.errorMessage ?? "", /PRIVATE SOURCE/u);

  const invalid = await resultFor(async (invocation) => {
    await writeFile(outputPath(invocation), "not json", "utf8");
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      })}\n`,
      stderr: "",
    };
  }, TOOL_CONTEXT);
  assert.equal(invalid.stopReason, "error");
  assert.match(invalid.errorMessage ?? "", /CODEX_EXEC_INVALID_OUTPUT/u);
});

test("Codex exec preserves successful output with zero usage when CLI omits usage", async () => {
  const captures: CodexExecInvocation[] = [];
  const message = await resultFor(
    successfulRunner({ text: "译文" }, captures, [], null),
    TOOL_CONTEXT,
  );
  assert.equal(message.stopReason, "toolUse");
  assert.equal(message.usage.totalTokens, 0);
});

test("Codex exec propagates cancellation and cleans only its isolated temp directory", async () => {
  const controller = new AbortController();
  let cwd = "";
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const pending = resultFor((invocation) => new Promise((resolve) => {
    cwd = invocation.cwd;
    signalStarted();
    invocation.signal?.addEventListener("abort", () => resolve({
      exitCode: null,
      stdout: "",
      stderr: "terminated",
    }), { once: true });
  }), TOOL_CONTEXT, controller.signal);
  await started;
  controller.abort();
  const message = await pending;

  assert.equal(message.stopReason, "aborted");
  assert.equal(existsSync(cwd), false);
});
