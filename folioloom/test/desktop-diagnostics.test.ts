import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  DesktopDiagnosticLogger,
  assertDiagnosticReportSafe,
  formatDesktopDiagnosticSummary,
  writeDesktopDiagnosticReport,
  type DesktopDiagnosticContext,
} from "../src/desktop/desktop-diagnostics.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const path = join(
    tmpdir(),
    `folioloom-${label}-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  mkdirSync(path, { recursive: true });
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  // Test-owned temporary directories are intentionally left for the operating
  // system temp cleaner. Removing an open Windows JSONL file can make the
  // test nondeterministic on antivirus-heavy machines.
  temporaryDirectories.length = 0;
});

function context(): DesktopDiagnosticContext {
  return {
    model: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "high",
      probeStatus: "ready",
    },
    source: {
      format: "txt",
      language: "de",
      encoding: "utf-8",
      characterCount: 141_034,
      hashPrefix: "0123456789ab",
    },
    runSummary: {
      runId: "run-safe",
      phase: "failed",
      totalWindows: 3,
      completedWindows: 1,
      failedWindows: 1,
      warningWindows: 0,
      humanRequiredWindows: 0,
    },
  };
}

test("diagnostic report redacts secrets, private paths and nested error causes", () => {
  const root = temporaryDirectory("diagnostics-redaction");
  const userData = join(root, "user-data");
  const project = join(root, "projects", "private-book");
  const appRoot = join(root, "app");
  const tempRoot = join(root, "temp");
  const logger = new DesktopDiagnosticLogger({
    directory: join(userData, "diagnostics"),
    appVersion: "1.5.0",
    pathAliases: { userData, app: appRoot, temp: tempRoot },
    environment: {
      platform: "win32",
      release: "fixture",
      arch: "x64",
      electronVersion: "43.2.0",
      nodeVersion: "24.10.1",
      chromeVersion: "fixture",
    },
    now: () => "2026-07-26T12:00:00.000Z",
  });
  const cause = new Error(
    `Authorization: Bearer sk-secret-cause at ${join(project, "source.txt")}`,
  );
  const error = new Error(
    `request failed?api_key=query-secret at ${join(userData, "desktop-credentials.json")}`,
    { cause },
  );
  Object.assign(error, { code: "PROVIDER_REQUEST_REJECTED" });

  logger.recordFailure({
    event: "trial.failed",
    operationId: "op-1",
    channel: "folioloom:start-trial",
    phase: "translating",
    error,
    projectDirectory: project,
  });
  const report = logger.buildReport(context());
  const serialized = JSON.stringify(report);

  assert.doesNotMatch(serialized, /sk-secret-cause|query-secret|private-book|D:\\\\llm/u);
  assert.match(serialized, /<project>|<userData>/u);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0]?.error?.causes.length, 2);
  assert.equal(report.operation?.phase, "translating");
  assert.equal(report.operation?.errorCode, "PROVIDER_REQUEST_REJECTED");
});

test("diagnostic logger rotates bounded JSONL files and caps individual events", () => {
  const directory = temporaryDirectory("diagnostics-rotation");
  const logger = new DesktopDiagnosticLogger({
    directory,
    appVersion: "1.5.0",
    maximumFileBytes: 600,
    maximumFiles: 4,
    maximumEventBytes: 320,
    now: () => "2026-07-26T12:00:00.000Z",
  });

  for (let index = 0; index < 60; index += 1) {
    logger.record({
      event: "probe.step",
      operationId: `operation-${index}`,
      outcome: "completed",
      metadata: { note: "x".repeat(1_000), index },
    });
  }

  const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  assert.ok(files.length > 1);
  assert.ok(files.length <= 4);
  for (const file of files) {
    for (const line of readFileSync(join(directory, file), "utf8").trim().split("\n")) {
      if (line.length === 0) continue;
      assert.ok(Buffer.byteLength(line, "utf8") <= 320);
      assert.doesNotThrow(() => JSON.parse(line));
    }
  }
});

test("diagnostic logger failures never alter application control flow", () => {
  const root = temporaryDirectory("diagnostics-best-effort");
  const notDirectory = join(root, "occupied");
  writeFileSync(notDirectory, "file", "utf8");
  const logger = new DesktopDiagnosticLogger({
    directory: notDirectory,
    appVersion: "1.5.0",
  });

  assert.doesNotThrow(() => logger.record({
    event: "trial.started",
    operationId: "op-best-effort",
    outcome: "started",
  }));
});

test("final sensitive scanner refuses unsafe objects before a report is written", () => {
  const directory = temporaryDirectory("diagnostics-final-scan");
  const destination = join(directory, "FolioLoom-diagnostics.json");
  const unsafe = {
    manifest: {
      schema: "folioloom-diagnostics-1",
      generatedAt: "2026-07-26T12:00:00.000Z",
      appVersion: "1.5.0",
    },
    environment: { platform: "win32", release: "fixture", arch: "x64" },
    events: [],
    privacy: { excluded: [] },
    apiKey: "sk-should-never-be-exported",
  };

  assert.throws(
    () => assertDiagnosticReportSafe(unsafe),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "DIAGNOSTIC_PRIVACY_CHECK_FAILED"
    ),
  );
  assert.throws(
    () => writeDesktopDiagnosticReport(destination, unsafe),
    /DIAGNOSTIC_PRIVACY_CHECK_FAILED/u,
  );
  assert.equal(existsSync(destination), false);
});

test("exported diagnostics are valid UTF-8 JSON and contain no manuscript payload fields", () => {
  const directory = temporaryDirectory("diagnostics-export");
  const logger = new DesktopDiagnosticLogger({
    directory: join(directory, "events"),
    appVersion: "1.5.0",
    now: () => "2026-07-26T12:00:00.000Z",
  });
  logger.record({
    event: "source.import.completed",
    operationId: "op-export",
    outcome: "completed",
    metadata: { format: "txt", language: "de", characterCount: 100 },
  });
  const destination = join(directory, "FolioLoom-diagnostics-20260726-120000.json");

  writeDesktopDiagnosticReport(destination, logger.buildReport(context()));
  const parsed = JSON.parse(readFileSync(destination, "utf8")) as Record<string, unknown>;

  assert.equal((parsed.manifest as { schema: string }).schema, "folioloom-diagnostics-1");
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /"(?:sourceText|translationText|prompt|rawResponse)"\s*:/u,
  );
});

test("diagnostic summary stays short, useful, and privacy-safe", () => {
  const root = temporaryDirectory("diagnostic-summary");
  const logger = new DesktopDiagnosticLogger({
    directory: root,
    appVersion: "1.5.0",
    now: () => "2026-07-26T08:00:00.000Z",
  });
  logger.record({
    event: "desktop.ipc",
    operationId: "op-summary",
    channel: "folioloom:start-trial",
    phase: "translating",
    outcome: "failed",
    errorCode: "MODEL_TIMEOUT",
  });
  const summary = formatDesktopDiagnosticSummary(logger.buildReport(context()));
  assert.match(summary, /deepseek-v4-flash/u);
  assert.match(summary, /MODEL_TIMEOUT/u);
  assert.match(summary, /translating/u);
  assert.doesNotMatch(summary, /source paragraph|translation paragraph|api[-_]?key/iu);
  assert.ok(summary.length < 1_000);
});
