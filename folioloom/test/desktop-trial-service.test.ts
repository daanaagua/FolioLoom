import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import {
  DesktopTrialError,
  DesktopTrialService,
  type DesktopTrialRuntime,
  type DesktopTrialRuntimeResolver,
  type DesktopTrialServiceOptions,
} from "../src/desktop/desktop-trial-service.js";
import { runBook, type LosslessBookRunOptions } from "../src/fullbook/book-runner.js";
import type { ModelProfile, ProviderEffort } from "../src/providers/types.js";
import { scalarLength } from "../src/source/types.js";

function fixture(source = "The bell rings above the empty court."): {
  directory: string;
  projectDirectory: string;
  manifestPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-trial-"));
  const projectDirectory = join(directory, "project");
  const sourceDirectory = join(projectDirectory, "source");
  const rawPath = join(sourceDirectory, "original.txt");
  const canonicalPath = join(sourceDirectory, "source.txt");
  const manifestPath = join(projectDirectory, "source_manifest.json");
  mkdirSync(sourceDirectory, { recursive: true });
  const raw = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, raw);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "source/original.txt",
    raw_size: raw.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    canonical_path: "source/source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: scalarLength(source),
      origin_kind: "decoded_bytes",
      origin_ref: "source/original.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  return { directory, projectDirectory, manifestPath };
}

function userText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message?.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function completedTrialResponse(context: Context) {
  const prompt = userText(context);
  const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  const windows = JSON.parse(match[1]) as Array<{
    windowId: string;
    blocks: Array<{ blockId: string }>;
  }>;
  const submission = {
    windows: windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blocks.map((block) => ({
        blockId: block.blockId,
        text: "钟声在空荡的庭院上空回响，迟迟不散。",
      })),
      notes: [],
    })),
  };
  if (prompt.includes("EXACT FRAME PAIRS")) {
    const promptLines = prompt.split(/\r?\n/gu).map((line) =>
      line.replace(/^\d+\.\s+/u, "").trimStart());
    const responseLines = submission.windows.flatMap((window) =>
      window.translations.flatMap((translation) => {
        const begin = promptLines.find((line) => line.startsWith("@@FOLIOLOOM:")
          && line.endsWith(`:BEGIN:${translation.blockId}@@`));
        const end = promptLines.find((line) => line.startsWith("@@FOLIOLOOM:")
          && line.endsWith(`:END:${translation.blockId}@@`));
        assert.ok(begin && end);
        return [begin, translation.text, end];
      }));
    return fauxAssistantMessage(responseLines.join("\n"));
  }
  return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", submission), {
    stopReason: "toolUse",
  });
}

function runtimeFor(
  faux: ReturnType<typeof fauxProvider>,
  profile: ModelProfile = {
    providerId: "deepseek",
    modelId: faux.getModel().id,
    reasoningEffort: "high",
  },
  supportedEfforts: readonly ProviderEffort[] = ["off", "high"],
): DesktopTrialRuntimeResolver {
  const createRuntime = (candidate: ModelProfile): DesktopTrialRuntime => ({
    profile: candidate,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    supportedEfforts,
    createWithProfile: createRuntime,
  });
  return {
    async resolve() {
      return createRuntime(profile);
    },
  };
}

test("desktop trial processes one window serially and projects the committed source and translation", async () => {
  const project = fixture();
  const faux = fauxProvider();
  faux.setResponses([completedTrialResponse]);
  const seen: LosslessBookRunOptions[] = [];
  const stages: string[] = [];
  try {
    const options: DesktopTrialServiceOptions = {
      runtime: runtimeFor(faux),
      runBook: async (options) => {
        seen.push(options);
        return runBook(options);
      },
      onProgress: (stage: string) => stages.push(stage),
    };
    const service = new DesktopTrialService(options);

    const result = await service.start({ manifestPath: project.manifestPath, mode: "quality" });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.maxWindows, 1);
    assert.equal(seen[0]?.maxConcurrency, 1);
    assert.equal(seen[0]?.storePath, join(project.projectDirectory, "artifacts", "folioloom", "book.db"));
    assert.equal(seen[0]?.runtimeSet?.mode, "quality");
    assert.equal(seen[0]?.runtimeSet?.primary.effort, "high");
    assert.equal(seen[0]?.runtimeSet?.primary.thinkingLevel, "high");
    assert.equal(seen[0]?.runtimeSet?.primary, seen[0]?.runtimeSet?.escalation);
    assert.match(result.runId, /^[0-9a-f-]{36}$/u);
    assert.equal(result.sourceText, "The bell rings above the empty court.");
    assert.equal(result.translationText, "钟声在空荡的庭院上空回响，迟迟不散。");
    assert.deepEqual(stages, ["preparing", "translating", "checking", "completed"]);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop trial rejects an unready model before opening a translation task", async () => {
  const project = fixture();
  try {
    const service = new DesktopTrialService({
      runtime: { async resolve() { return undefined; } },
    });

    await assert.rejects(
      service.start({ manifestPath: project.manifestPath, mode: "quality" }),
      (error: unknown) => error instanceof DesktopTrialError
        && error.code === "DESKTOP_TRIAL_MODEL_NOT_READY",
    );
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop trial allows only one active lease for the same project", async () => {
  const project = fixture();
  const faux = fauxProvider();
  let release!: () => void;
  const paused = new Promise<void>((resolvePaused) => { release = resolvePaused; });
  let entered!: () => void;
  const enteredProvider = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  faux.setResponses([async (context) => {
    entered();
    await paused;
    return completedTrialResponse(context);
  }]);
  try {
    const service = new DesktopTrialService({ runtime: runtimeFor(faux) });
    const first = service.start({ manifestPath: project.manifestPath, mode: "quality" });
    await enteredProvider;

    await assert.rejects(
      service.start({ manifestPath: project.manifestPath, mode: "quality" }),
      (error: unknown) => error instanceof DesktopTrialError
        && error.code === "DESKTOP_TRIAL_ALREADY_RUNNING",
    );
    release();
    await first;
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop trial releases a failed lease and reads the latest committed trial after restart", async () => {
  const project = fixture();
  const failing = fauxProvider();
  failing.setResponses([fauxAssistantMessage([], {
    stopReason: "error",
    errorMessage: "fixture provider unavailable",
  })]);
  try {
    const failedService = new DesktopTrialService({ runtime: runtimeFor(failing) });
    await assert.rejects(failedService.start({ manifestPath: project.manifestPath, mode: "quality" }), /provider unavailable/i);

    const succeeding = fauxProvider();
    succeeding.setResponses([completedTrialResponse]);
    const result = await new DesktopTrialService({ runtime: runtimeFor(succeeding) })
      .start({ manifestPath: project.manifestPath, mode: "quality" });
    assert.equal(succeeding.state.callCount, 1);

    const restartedProvider = fauxProvider();
    const restarted = await new DesktopTrialService({ runtime: runtimeFor(restartedProvider) })
      .start({ manifestPath: project.manifestPath, mode: "quality" });
    assert.equal(restartedProvider.state.callCount, 0);
    assert.equal(restarted.runId, result.runId);
    assert.equal(restarted.translationText, result.translationText);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop trial cancellation signals the active run and waits for it to settle", async () => {
  const project = fixture();
  const faux = fauxProvider();
  try {
    const service = new DesktopTrialService({
      runtime: runtimeFor(faux),
      runBook: async (options) => new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        }, { once: true });
      }),
    });
    const trial = service.start({ manifestPath: project.manifestPath, mode: "quality" });
    const cancelled = service.cancel();

    await cancelled;
    await assert.rejects(
      trial,
      (error: unknown) => error instanceof DesktopTrialError
        && String(error.code) === "DESKTOP_TRIAL_CANCELLED",
    );
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop fast trial chooses the provider's lowest legal effort and retains the tested effort for escalation", async () => {
  const project = fixture();
  const faux = fauxProvider();
  faux.setResponses([completedTrialResponse]);
  const seen: LosslessBookRunOptions[] = [];
  try {
    const service = new DesktopTrialService({
      runtime: runtimeFor(faux, {
        providerId: "deepseek",
        modelId: faux.getModel().id,
        reasoningEffort: "high",
      }, ["off", "high"]),
      runBook: async (options) => {
        seen.push(options);
        return runBook(options);
      },
    });

    await service.start({ manifestPath: project.manifestPath, mode: "fast" });

    const runtimeSet = seen[0]?.runtimeSet;
    assert.equal(runtimeSet?.mode, "fast");
    assert.equal(runtimeSet?.primary.effort, "off");
    assert.equal(runtimeSet?.primary.thinkingLevel, "off");
    assert.equal(runtimeSet?.escalation.effort, "high");
    assert.equal(runtimeSet?.escalation.thinkingLevel, "high");
    assert.notEqual(runtimeSet?.primary, runtimeSet?.escalation);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop fast trial falls back to minimal when off is not legal for the provider", async () => {
  const project = fixture();
  const faux = fauxProvider();
  faux.setResponses([completedTrialResponse]);
  const seen: LosslessBookRunOptions[] = [];
  try {
    const service = new DesktopTrialService({
      runtime: runtimeFor(faux, {
        providerId: "deepseek",
        modelId: faux.getModel().id,
        reasoningEffort: "high",
      }, ["minimal", "high"]),
      runBook: async (options) => {
        seen.push(options);
        return runBook(options);
      },
    });

    await service.start({ manifestPath: project.manifestPath, mode: "fast" });

    assert.equal(seen[0]?.runtimeSet?.primary.effort, "minimal");
    assert.equal(seen[0]?.runtimeSet?.primary.thinkingLevel, "minimal");
    assert.equal(seen[0]?.runtimeSet?.escalation.effort, "high");
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});

test("desktop trial rejects an arbitrary mode before it resolves the model runtime", async () => {
  const project = fixture();
  let resolved = 0;
  try {
    const service = new DesktopTrialService({
      runtime: {
        async resolve() {
          resolved += 1;
          return undefined;
        },
      },
    });

    await assert.rejects(
      service.start({ manifestPath: project.manifestPath, mode: "cheap" as never }),
      (error: unknown) => error instanceof DesktopTrialError
        && error.code === "DESKTOP_TRIAL_INPUT_INVALID",
    );
    assert.equal(resolved, 0);
  } finally {
    rmSync(project.directory, { recursive: true, force: true });
  }
});
