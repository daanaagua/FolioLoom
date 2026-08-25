import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  DesktopExportError,
  DesktopExportService,
} from "../src/desktop/desktop-export-service.js";
import type {
  DesktopExportFormat,
  DesktopProjectRequest,
} from "../src/desktop/contracts.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { auditLosslessBookStore } from "../src/report.js";
import { scalarLength } from "../src/source/types.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

interface Fixture {
  directory: string;
  projectDirectory: string;
  manifestPath: string;
  storePath: string;
  project: DesktopProjectRequest;
  context: BookContext;
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-desktop-export-"));
  const projectDirectory = join(directory, "project");
  const sourceDirectory = join(projectDirectory, "source");
  const rawPath = join(sourceDirectory, "Friendly Novel.txt");
  const canonicalPath = join(sourceDirectory, "source.txt");
  const manifestPath = join(projectDirectory, "source_manifest.json");
  const storePath = join(projectDirectory, "artifacts", "folioloom", "book.db");
  mkdirSync(sourceDirectory, { recursive: true });
  const source = `${"A".repeat(3_500)}\n\n${"B".repeat(3_500)}`;
  const raw = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, raw);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "source/Friendly Novel.txt",
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
      origin_ref: "source/Friendly Novel.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  const context = BookContext.openLossless({ manifestPath });
  mkdirSync(dirname(storePath), { recursive: true });
  const store = new LosslessBookStore(storePath);
  store.registerSource(context.certifiedSource!);
  store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
    annotations: context.annotations,
    blocks: context.losslessBlocks,
  });
  store.close();
  return {
    directory,
    projectDirectory,
    manifestPath,
    storePath,
    project: { manifestPath, storePath },
    context,
  };
}

function addRun(
  item: Fixture,
  runId: string,
  options: {
    metadata?: unknown;
    completedWindows?: number;
    humanRequired?: boolean;
  } = {},
): void {
  const store = new LosslessBookStore(item.storePath);
  try {
    const snapshot = createKnowledgeSnapshot(runId, []);
    store.createTranslationRun({
      runId,
      sourceVersion: item.context.sourceLedger.sourceVersion,
      protocolVersion: "v5-book-3",
      modelId: `model-${runId}`,
      initialSnapshotId: snapshot.id,
      initialSnapshot: snapshot,
      metadata: options.metadata ?? {},
    });
    const windows = planBookWindows(item.context.losslessBlocks, {
      protocolVersion: "v5-book-3",
      maxBlocks: 1,
    });
    store.initializeWindowPlan(runId, windows);
    for (const window of windows.slice(0, options.completedWindows ?? 0)) {
      store.bindWindowsToSnapshot(runId, [window.windowId], snapshot.id);
      store.claimWindow(runId, window.windowId);
      store.stageWindow({
        runId,
        windowId: window.windowId,
        snapshotId: snapshot.id,
        status: "completed",
        translations: window.blockIds.map((blockId) => {
          const block = item.context.losslessBlocks.find((candidate) => candidate.id === blockId)!;
          return {
            blockId,
            sourceHash: block.sourceHash,
            text: `中文译文 ${block.globalIndex + 1}`,
          };
        }),
        knowledgeCandidates: [],
        styleTail: "",
        budget: {},
        warnings: [],
      });
      store.promoteStagedWindow(runId, window.windowId);
    }
    if (options.humanRequired) {
      const window = windows[options.completedWindows ?? 0];
      assert.ok(window);
      store.claimWindow(runId, window.windowId);
      store.failWindow(runId, window.windowId, {
        error: "fixture needs attention",
        retry: false,
        budget: {},
        warnings: ["fixture needs attention"],
      });
    }
  } finally {
    store.close();
  }
}

function cleanup(item: Fixture): void {
  item.context.close();
  rmSync(item.directory, { recursive: true, force: true });
}

function idSequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

test("export snapshot excludes trials and explains incomplete, human, and audit blockers", () => {
  const item = fixture();
  try {
    const total = item.context.losslessBlocks.length;
    addRun(item, "trial", {
      metadata: { desktopTrial: { schema: "folioloom-desktop-trial-2" } },
      completedWindows: total,
    });
    addRun(item, "cli-ready", { completedWindows: total });
    addRun(item, "desktop-ready", {
      metadata: {
        desktopFullBook: {
          schema: "folioloom-desktop-fullbook-1",
          mode: "quality",
          runtimeFingerprint: "fingerprint",
          styleProfileHash: "style",
        },
      },
      completedWindows: total,
    });
    addRun(item, "incomplete", { completedWindows: 1 });
    addRun(item, "human", { completedWindows: 1, humanRequired: true });
    addRun(item, "audit-bad", { completedWindows: total });

    const service = new DesktopExportService({
      createDestinationId: idSequence("destination"),
      audit: (store, runId) => {
        const audit = auditLosslessBookStore(store, runId);
        return runId === "audit-bad"
          ? { ...audit, complete: false, incidentCodes: ["FIXTURE_AUDIT_INCIDENT"] }
          : audit;
      },
    });
    const snapshot = service.snapshot(item.project);
    assert.deepEqual(
      snapshot.candidates.map((candidate) => candidate.runId).sort(),
      ["audit-bad", "cli-ready", "desktop-ready", "human", "incomplete"],
    );
    assert.equal(
      snapshot.candidates.find((candidate) => candidate.runId === "cli-ready")?.status,
      "ready",
    );
    assert.equal(
      snapshot.candidates.find((candidate) => candidate.runId === "desktop-ready")?.status,
      "ready",
    );
    assert.equal(
      snapshot.candidates.find((candidate) => candidate.runId === "incomplete")?.status,
      "incomplete",
    );
    assert.match(
      snapshot.candidates.find((candidate) => candidate.runId === "incomplete")
        ?.blockers.join("") ?? "",
      /翻译尚未完成/u,
    );
    assert.match(
      snapshot.candidates.find((candidate) => candidate.runId === "human")
        ?.blockers.join("") ?? "",
      /需要人工处理/u,
    );
    assert.match(
      snapshot.candidates.find((candidate) => candidate.runId === "audit-bad")
        ?.blockers.join("") ?? "",
      /完整性校验未通过/u,
    );
    assert.equal(snapshot.defaultDestination?.displayPath, join(item.projectDirectory, "exports"));
    assert.match(snapshot.defaultDestination?.destinationId ?? "", /^destination-/u);
  } finally {
    cleanup(item);
  }
});

test("destination tokens expire and malformed export requests are rejected", async () => {
  const item = fixture();
  let now = 1_000;
  try {
    addRun(item, "ready", { completedWindows: item.context.losslessBlocks.length });
    const service = new DesktopExportService({
      now: () => now,
      destinationTtlMs: 100,
      createDestinationId: idSequence("secret"),
    });
    const destination = service.registerDestination(join(item.directory, "chosen"));
    assert.doesNotMatch(destination.destinationId, /chosen/u);

    for (const request of [
      { runId: "", destinationId: destination.destinationId, formats: ["translation_txt"] },
      { runId: "ready", destinationId: destination.destinationId, formats: [] },
      {
        runId: "ready",
        destinationId: destination.destinationId,
        formats: ["translation_txt", "translation_txt"],
      },
      { runId: "ready", destinationId: "unknown", formats: ["translation_txt"] },
    ]) {
      await assert.rejects(
        service.export(item.project, request as {
          runId: string;
          destinationId: string;
          formats: DesktopExportFormat[];
        }),
        (error: unknown) => error instanceof DesktopExportError,
      );
    }

    now += 101;
    await assert.rejects(
      service.export(item.project, {
        runId: "ready",
        destinationId: destination.destinationId,
        formats: ["translation_txt"],
      }),
      (error: unknown) =>
        error instanceof DesktopExportError
        && error.code === "DESKTOP_EXPORT_DESTINATION_EXPIRED",
    );
  } finally {
    cleanup(item);
  }
});

test("strict export publishes selected friendly artifacts atomically and never overwrites", async () => {
  const item = fixture();
  try {
    addRun(item, "ready", { completedWindows: item.context.losslessBlocks.length });
    const service = new DesktopExportService({
      createDestinationId: idSequence("destination"),
      createExportId: idSequence("export"),
    });
    const destination = service.registerDestination(join(item.directory, "chosen"));
    const first = await service.export(item.project, {
      runId: "ready",
      destinationId: destination.destinationId,
      formats: ["translation_txt", "bilingual_txt", "epub"],
    });
    assert.equal(service.completedDirectory(first.exportId), first.directory);
    assert.equal(dirname(first.directory), destination.displayPath);
    assert.ok(first.files.some((file) =>
      file.format === "translation_txt" && file.fileName === "Friendly Novel-中文.txt"));
    assert.ok(first.files.some((file) =>
      file.format === "bilingual_txt" && file.fileName === "Friendly Novel-双语.txt"));
    assert.ok(first.files.some((file) =>
      file.format === "epub" && file.fileName === "Friendly Novel.epub"));
    for (const file of first.files) {
      assert.equal(existsSync(join(first.directory, file.fileName)), true, file.fileName);
    }
    assert.equal(readdirSync(destination.displayPath).some((name) => name.includes(".tmp-")), false);

    const second = await service.export(item.project, {
      runId: "ready",
      destinationId: destination.destinationId,
      formats: ["translation_txt"],
    });
    assert.notEqual(second.directory, first.directory);
    const secondNames = readdirSync(second.directory);
    assert.ok(secondNames.includes("Friendly Novel-中文.txt"));
    assert.ok(secondNames.includes("Friendly Novel-审计.json"));
    assert.ok(secondNames.includes("Friendly Novel-指标.json"));
    assert.equal(secondNames.includes("Friendly Novel-双语.txt"), false);
    assert.equal(secondNames.includes("Friendly Novel.epub"), false);
    assert.equal(secondNames.some((name) => name.includes("双语.lineage")), false);
    assert.equal(existsSync(first.directory), true);
  } finally {
    cleanup(item);
  }
});

test("writer and verifier failures clean temporary state without publishing a final directory", async () => {
  const item = fixture();
  try {
    addRun(item, "ready", { completedWindows: item.context.losslessBlocks.length });
    const destinationPath = join(item.directory, "chosen");
    let observedTemporary = "";
    const writerFailure = new DesktopExportService({
      createDestinationId: idSequence("destination"),
      createExportId: idSequence("export"),
      writeArtifacts: (_store, _runId, outputDirectory) => {
        observedTemporary = outputDirectory;
        throw new Error("writer failed");
      },
    });
    const writerDestination = writerFailure.registerDestination(destinationPath);
    await assert.rejects(writerFailure.export(item.project, {
      runId: "ready",
      destinationId: writerDestination.destinationId,
      formats: ["translation_txt"],
    }));
    assert.equal(dirname(observedTemporary), destinationPath);
    assert.equal(existsSync(observedTemporary), false);
    assert.deepEqual(existsSync(destinationPath) ? readdirSync(destinationPath) : [], []);

    const verifierFailure = new DesktopExportService({
      createDestinationId: idSequence("destination"),
      createExportId: idSequence("export"),
      verify: () => ({
        schema: "v5-export-verification-1",
        runId: "ready",
        ok: false,
        incidentCodes: ["TRANSLATION_CONTENT_MISMATCH"],
      }),
    });
    const verifierDestination = verifierFailure.registerDestination(destinationPath);
    await assert.rejects(
      verifierFailure.export(item.project, {
        runId: "ready",
        destinationId: verifierDestination.destinationId,
        formats: ["translation_txt"],
      }),
      (error: unknown) =>
        error instanceof DesktopExportError
        && error.code === "DESKTOP_EXPORT_VERIFICATION_FAILED",
    );
    assert.deepEqual(existsSync(destinationPath) ? readdirSync(destinationPath) : [], []);
  } finally {
    cleanup(item);
  }
});
