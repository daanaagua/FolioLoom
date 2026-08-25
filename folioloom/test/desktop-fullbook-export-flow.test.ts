import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

import { DesktopExportService } from "../src/desktop/desktop-export-service.js";
import { DesktopFullBookService } from "../src/desktop/desktop-fullbook-service.js";
import type {
  DesktopFullBookPhase,
  DesktopFullBookProgress,
} from "../src/desktop/contracts.js";
import type {
  DesktopRuntimeResolver,
  DesktopTranslationRuntime,
} from "../src/desktop/desktop-runtime-plan.js";
import {
  DesktopSourceService,
  type DesktopSourceReadyResult,
} from "../src/desktop/desktop-source-service.js";
import { readStoredZipEntries } from "../src/export/stored-zip.js";
import { verifyExport } from "../src/export/export-verifier.js";
import { losslessBookArtifactPaths } from "../src/report.js";
import type { ModelProfile } from "../src/providers/types.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function userText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message && message.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
}

function deterministicResponse(context: Context) {
  const prompt = userText(context);
  if (prompt.includes("Submit zero to four additional questions")) {
    return fauxAssistantMessage(
      fauxToolCall("submit_questions", { questions: [] }),
      { stopReason: "toolUse" },
    );
  }
  if (prompt.includes("SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE")) {
    const match =
      /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u
        .exec(prompt);
    assert.ok(match?.[1]);
    const candidates = JSON.parse(match[1]) as Array<{ sourceForm: string }>;
    return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
      anchors: candidates.map((candidate, index) => ({
        sourceForm: candidate.sourceForm,
        target: `术语${index + 1}`,
        mode: "stable",
        semanticClass: "technical_term",
        confidence: 0.95,
      })),
      entityLinks: [],
    }), { stopReason: "toolUse" });
  }

  const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  const windows = JSON.parse(match[1]) as Array<{
    windowId: string;
    blocks: Array<{ blockId: string; sourceText: string }>;
  }>;
  const translations = windows.map((window) => ({
    windowId: window.windowId,
    translations: window.blocks.map((block) => {
      const prefix = [...block.blockId.slice(-8)].map((digit) => ({
        "0": "零", "1": "一", "2": "二", "3": "三",
        "4": "四", "5": "五", "6": "六", "7": "七",
        "8": "八", "9": "九", a: "甲", b: "乙", c: "丙",
        d: "丁", e: "戊", f: "己",
      })[digit] ?? "庚").join("");
      const vocabulary =
        "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜";
      return {
        blockId: block.blockId,
        text: block.sourceText
        .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
        .filter((paragraph) => paragraph.trim().length > 0)
        .map((paragraph, index) =>
          `${index === 0 ? `${prefix}中文译文` : "续"}${
            [...paragraph].map((character, position) =>
              vocabulary[
                (character.codePointAt(0)! + position + Number.parseInt(
                  block.blockId.slice(-6),
                  16,
                )) % vocabulary.length
              ]).join("")
          }。`)
        .join("\n\n"),
      };
    }),
    notes: [],
  }));
  if (prompt.includes("EXACT FRAME PAIRS")) {
    const promptLines = prompt.split(/\r?\n/gu)
      .map((line) => line.replace(/^\d+\.\s+/u, "").trimStart());
    return fauxAssistantMessage(translations.flatMap((window) =>
      window.translations.flatMap((translation) => {
        const begin = promptLines.find((line) =>
          line.startsWith("@@FOLIOLOOM:")
          && line.endsWith(`:BEGIN:${translation.blockId}@@`));
        const end = promptLines.find((line) =>
          line.startsWith("@@FOLIOLOOM:")
          && line.endsWith(`:END:${translation.blockId}@@`));
        assert.ok(begin && end);
        return [begin, translation.text, end];
      })).join("\n"));
  }
  return fauxAssistantMessage(
    fauxToolCall("finalize_translation_batch", { windows: translations }),
    { stopReason: "toolUse" },
  );
}

function runtimeResolver(
  streamFn: StreamFn,
  model: Model<any>,
): DesktopRuntimeResolver {
  const create = (profile: ModelProfile): DesktopTranslationRuntime => ({
    profile,
    model,
    streamFn,
    supportedEfforts: ["off", "high"],
    createWithProfile: create,
  });
  return {
    async resolve() {
      return create({
        providerId: "openai-compatible",
        modelId: model.id,
        reasoningEffort: "high",
      });
    },
  };
}

function phaseWaiter(): {
  onProgress(progress: DesktopFullBookProgress): void;
  waitFor(phase: DesktopFullBookPhase): Promise<DesktopFullBookProgress>;
} {
  const seen = new Map<DesktopFullBookPhase, DesktopFullBookProgress>();
  const waiting = new Map<
    DesktopFullBookPhase,
    (progress: DesktopFullBookProgress) => void
  >();
  return {
    onProgress(progress) {
      seen.set(progress.phase, progress);
      waiting.get(progress.phase)?.(progress);
      waiting.delete(progress.phase);
    },
    waitFor(phase) {
      const current = seen.get(phase);
      if (current !== undefined) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiting.delete(phase);
          reject(new Error(`timed out waiting for full-book phase ${phase}`));
        }, 20_000);
        waiting.set(phase, (progress) => {
          clearTimeout(timeout);
          resolve(progress);
        });
      });
    },
  };
}

function ready(
  result: Awaited<ReturnType<DesktopSourceService["importSource"]>>,
): DesktopSourceReadyResult {
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("source import is not ready");
  return result;
}

async function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test("desktop imports, pauses, resumes, strictly exports, and verifies a Unicode book", {
  timeout: 30_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-e2e-"));
  const sourcePath = join(directory, "Unicode Story.txt");
  const source = [
    "CHAPTER ONE",
    ...Array.from({ length: 4 }, (_, index) =>
      `The archive keeps every sentence in order ${index}. `.repeat(20)),
    "The labels remain exact: 中文段落，日本語の記録，한국어 기록.",
    "CHAPTER TWO",
    ...Array.from({ length: 4 }, (_, index) =>
      `The second archive preserves each later consequence ${index}. `.repeat(20)),
    "CHAPTER THREE",
    ...Array.from({ length: 4 }, (_, index) =>
      `The final archive keeps one more durable section ${index}. `.repeat(20)),
  ].join("\n\n");
  writeFileSync(sourcePath, source, "utf8");

  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let enterFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
  let firstRequest = true;
  const faux = fauxProvider();
  const response = async (context: Context) => {
    if (firstRequest) {
      firstRequest = false;
      enterFirst();
      await firstRelease;
    }
    return deterministicResponse(context);
  };
  faux.setResponses(Array.from({ length: 100 }, () => response));
  const model = faux.getModel();
  const streamFn = faux.provider.streamSimple.bind(faux.provider);
  const runtime = runtimeResolver(streamFn, model);

  try {
    const imported = ready(await new DesktopSourceService({
      projectsRoot: join(directory, "projects"),
    }).importSource({ sourcePath, sourceLanguage: "en" }));
    const project = { manifestPath: imported.manifestPath };

    const firstPhases = phaseWaiter();
    const firstService = new DesktopFullBookService({
      runtime,
      createRunId: () => "desktop-e2e-run",
      onProgress: firstPhases.onProgress,
      pollIntervalMs: 10,
    });
    const running = firstPhases.waitFor("running");
    const started = await firstService.start(project, {
      optimizationProfile: "balanced",
    });
    await running;
    await withDeadline(
      firstEntered,
      `provider was not entered: ${JSON.stringify(firstService.snapshot(project))}`,
    );
    const pausing = firstService.pause();
    releaseFirst();
    const paused = await pausing;
    assert.equal(paused.activeRunId, undefined);
    assert.equal(
      paused.runs.find((run) => run.runId === started.activeRunId)?.phase,
      "paused",
    );

    const restartedPhases = phaseWaiter();
    const restarted = new DesktopFullBookService({
      runtime,
      onProgress: restartedPhases.onProgress,
      pollIntervalMs: 10,
    });
    const completed = restartedPhases.waitFor("completed");
    await restarted.resume(project, { runId: started.activeRunId! });
    let completedProgress: DesktopFullBookProgress;
    try {
      completedProgress = await completed;
    } catch (error) {
      const diagnosticStorePath = join(
        imported.projectDirectory,
        "artifacts",
        "folioloom",
        "book.db",
      );
      const diagnosticStore = LosslessBookStore.openReadOnly(diagnosticStorePath);
      const windows = diagnosticStore.allWindows(started.activeRunId!);
      diagnosticStore.close();
      throw new Error(
        `completion failed: ${JSON.stringify({
          snapshot: restarted.snapshot(project),
          modelCalls: faux.state.callCount,
          pendingResponses: faux.getPendingResponseCount(),
          windows: windows.map((window) => ({
            status: window.status,
            lastError: window.lastError,
            warnings: window.warnings,
          })),
        })}`,
        { cause: error },
      );
    }
    assert.equal(
      completedProgress.progress.completedWindows,
      completedProgress.progress.totalWindows,
    );

    const exporter = new DesktopExportService({
      createDestinationId: () => "desktop-e2e-destination",
      createExportId: () => "desktop-e2e-export",
    });
    const destination = exporter.registerDestination(join(directory, "exports"));
    const result = await exporter.export(project, {
      runId: started.activeRunId!,
      destinationId: destination.destinationId,
      formats: ["translation_txt", "bilingual_txt", "epub"],
    });
    assert.deepEqual(
      new Set(result.files.map((file) => file.format)),
      new Set(["translation_txt", "bilingual_txt", "epub", "audit", "metrics"]),
    );

    const paths = {
      ...losslessBookArtifactPaths(result.directory, true, "Unicode Story"),
      epub: join(result.directory, "Unicode Story.epub"),
    };
    const storePath = join(
      imported.projectDirectory,
      "artifacts",
      "folioloom",
      "book.db",
    );
    const store = LosslessBookStore.openReadOnly(storePath);
    try {
      assert.equal(verifyExport(paths, store, started.activeRunId!).ok, true);
    } finally {
      store.close();
    }

    const translation = readFileSync(paths.translation, "utf8");
    const bilingual = readFileSync(paths.bilingual, "utf8");
    assert.match(translation, /中文译文/u);
    assert.match(bilingual, /中文段落/u);
    assert.match(bilingual, /日本語の記録/u);
    assert.match(bilingual, /한국어 기록/u);
    const epubText = readStoredZipEntries(paths.epub)
      .map((entry) => entry.data.toString("utf8"))
      .join("\n");
    assert.match(epubText, /中文译文/u);
    assert.equal(basename(result.directory), "Unicode Story-译文");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
