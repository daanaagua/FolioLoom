import { statSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { doctorBook, type BookDoctorReport } from "../cli.js";
import { SourceLedger } from "../source/source-ledger.js";
import { LosslessBookStore, type StoredTranslationRun } from "../storage/lossless-book-store.js";
import type {
  DesktopDoctorReport,
  DesktopError,
  DesktopProjectRequest,
  DesktopProjectSnapshot,
  DesktopResult,
  DesktopRunSummary,
} from "./contracts.js";
import { DesktopInputError, fail, ok, toDesktopError } from "./desktop-errors.js";
import { desktopProjectTitle } from "./desktop-project-metadata.js";

type Doctor = typeof doctorBook;

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function requireRegularAbsoluteFile(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || !isAbsolute(value)) {
    throw new DesktopInputError("DESKTOP_INPUT_INVALID", `${label} must be an absolute file path`);
  }
  let resolved: string;
  try {
    resolved = realpathSync(value);
  } catch (error) {
    throw new DesktopInputError(
      "DESKTOP_INPUT_INVALID",
      error instanceof Error ? error.message : `${label} cannot be resolved`,
    );
  }
  if (!regularFile(resolved)) {
    throw new DesktopInputError("DESKTOP_INPUT_INVALID", `${label} must identify a regular file`);
  }
  return resolved;
}

function requireManifestPath(path: unknown): string {
  const resolved = requireRegularAbsoluteFile(path, "manifestPath");
  if (basename(resolved) !== "source_manifest.json" || extname(resolved) !== ".json") {
    throw new DesktopInputError(
      "DESKTOP_INPUT_INVALID",
      "manifestPath must identify source_manifest.json",
    );
  }
  return resolved;
}

function requireStorePath(path: unknown): string {
  const resolved = requireRegularAbsoluteFile(path, "storePath");
  if (extname(resolved) !== ".db") {
    throw new DesktopInputError("DESKTOP_INPUT_INVALID", "storePath must identify a .db file");
  }
  return resolved;
}

function requireGlossaryPath(path: unknown): string {
  const resolved = requireRegularAbsoluteFile(path, "glossaryPath");
  if (extname(resolved) !== ".json") {
    throw new DesktopInputError("DESKTOP_INPUT_INVALID", "glossaryPath must identify a .json file");
  }
  return resolved;
}

function requireOptionalRunId(runId: unknown): string | undefined {
  if (runId === undefined) {
    return undefined;
  }
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new DesktopInputError("DESKTOP_INPUT_INVALID", "runId must be a non-empty string");
  }
  return runId;
}

function adjacentGlossaryPath(manifestPath: string): string | undefined {
  const candidate = join(dirname(manifestPath), "glossary.json");
  return regularFile(candidate) ? realpathSync(candidate) : undefined;
}

function pathIsWithinDirectory(path: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return pathFromDirectory.length > 0
    && pathFromDirectory !== ".."
    && !pathFromDirectory.startsWith(`..${sep}`)
    && !isAbsolute(pathFromDirectory);
}

function discoverStorePath(manifestPath: string): string | undefined {
  const directory = dirname(manifestPath);
  const candidates = [
    join(directory, "artifacts", "folioloom", "book.db"),
    join(directory, "book.db"),
  ];
  for (const candidate of candidates) {
    if (regularFile(candidate)) {
      const storePath = requireStorePath(candidate);
      if (!pathIsWithinDirectory(storePath, directory)) {
        throw new DesktopInputError(
          "DESKTOP_INPUT_INVALID",
          "automatically discovered storePath must remain within the project directory",
        );
      }
      return storePath;
    }
  }
  return undefined;
}

function snapshotBase(
  ledger: SourceLedger,
  manifestPath: string,
): Pick<
  DesktopProjectSnapshot,
  | "title"
  | "sourceLanguage"
  | "detectedLanguage"
  | "sourceEncoding"
  | "encodingConfidence"
  | "languageProfileVersion"
  | "sourceChars"
  | "sourceVersion"
> {
  return {
    title: desktopProjectTitle(manifestPath, ledger.rawPath),
    sourceLanguage: ledger.sourceLanguage,
    detectedLanguage: sourceLanguageLabel(ledger.sourceLanguage, ledger.languageProfile.displayName),
    sourceEncoding: ledger.encoding,
    encodingConfidence: ledger.encodingDecision?.confidence ?? 1,
    languageProfileVersion: ledger.languageProfile.version,
    sourceChars: ledger.canonicalChars,
    sourceVersion: ledger.sourceVersion,
  };
}

function sourceLanguageLabel(language: string, fallback: string): string {
  const labels: Readonly<Record<string, string>> = {
    en: "英语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    ru: "俄语",
    ja: "日语",
    ko: "韩语",
    und: "待确认",
  };
  return labels[language] ?? fallback;
}

function runSummary(store: LosslessBookStore, run: StoredTranslationRun): DesktopRunSummary {
  const summary = store.statusSummary(run.runId);
  return {
    runId: run.runId,
    sourceVersion: run.sourceVersion,
    modelId: run.modelId,
    status: run.status,
    progress: {
      totalWindows: summary.totalWindows,
      pendingWindows: summary.pendingWindows,
      completedWindows: summary.completedWindows,
      warningWindows: summary.warningWindows,
      humanRequiredWindows: summary.humanRequiredWindows,
      failedWindows: summary.failedWindows,
    },
  };
}

function sourceVersionMismatchError(sourceVersion: string): DesktopError {
  return {
    code: "SOURCE_VERSION_MISMATCH",
    message: `no translation run matches source version ${sourceVersion}`,
    retryable: false,
  };
}

function safeKnowledgeTargetError(error: DesktopError): DesktopError {
  const messages: Readonly<Record<string, string>> = {
    DESKTOP_INPUT_INVALID: "The current project configuration is invalid",
    KNOWLEDGE_RUN_NOT_FOUND: "The current project has no translation run for this source",
    KNOWLEDGE_RUN_SELECTION_REQUIRED:
      "Select one translation run before opening the knowledge workbench",
    KNOWLEDGE_STORE_INVALID:
      "The current translation state database is not valid for this source",
    KNOWLEDGE_STORE_NOT_FOUND:
      "The current project has no translation state database",
    SOURCE_VERSION_MISMATCH:
      "The translation state database belongs to a different source version",
  };
  return {
    code: error.code,
    message: messages[error.code] ?? "The knowledge workbench could not open this project",
    retryable: error.retryable,
    ...(error.nextAction === undefined ? {} : { nextAction: error.nextAction }),
  };
}

function projectDoctorReport(
  report: BookDoctorReport,
  glossaryPath: string | undefined,
): DesktopDoctorReport {
  return {
    sourceVersion: report.sourceVersion,
    sourceChars: report.sourceChars,
    coveredChars: report.coveredChars,
    annotationCount: report.annotationCount,
    blockCount: report.blockCount,
    windowCount: report.windowCount,
    incidentCodes: [...report.incidentCodes],
    anomalyCount: report.sourceAnomalies.findings.reduce(
      (total, finding) => total + finding.count,
      0,
    ),
    ...(report.glossary === undefined || glossaryPath === undefined ? {} : {
      glossary: {
        path: glossaryPath,
        totalTerms: report.glossary.totalTerms,
        matchedTerms: report.glossary.matchedTerms,
        unmatchedTerms: report.glossary.unmatchedTerms,
        unmatchedForms: report.glossary.terms.flatMap((term) => term.unmatchedForms),
      },
    }),
  };
}

export class DesktopProjectService {
  readonly #doctor: Doctor;

  constructor(dependencies: { doctor?: Doctor } = {}) {
    this.#doctor = dependencies.doctor ?? doctorBook;
  }

  snapshot(request: DesktopProjectRequest): DesktopResult<DesktopProjectSnapshot> {
    try {
      const manifestPath = requireManifestPath(request.manifestPath);
      const ledger = SourceLedger.open(manifestPath);
      if (request.glossaryPath !== undefined) {
        requireGlossaryPath(request.glossaryPath);
      }
      const requestedRunId = requireOptionalRunId(request.runId);
      const candidateStorePath = request.storePath === undefined
        ? discoverStorePath(manifestPath)
        : requireStorePath(request.storePath);
      const base = snapshotBase(ledger, manifestPath);
      if (candidateStorePath === undefined) {
        return ok({
          ...base,
          store: { state: "not_found" },
          runs: [],
          runSelection: "none",
        });
      }

      const store = LosslessBookStore.openReadOnly(candidateStorePath);
      try {
        const allRuns = store.listTranslationRuns();
        const matchingRuns = allRuns.filter((run) => run.sourceVersion === ledger.sourceVersion);
        if (allRuns.length > 0 && matchingRuns.length === 0) {
          return ok({
            ...base,
            store: {
              state: "invalid",
              error: sourceVersionMismatchError(ledger.sourceVersion),
            },
            runs: [],
            runSelection: "none",
          });
        }
        const runs = matchingRuns.map((run) => runSummary(store, run));
        if (runs.length === 0) {
          return ok({
            ...base,
            store: { state: "ready" },
            runs,
            runSelection: "none",
          });
        }
        if (runs.length === 1) {
          return ok({
            ...base,
            store: { state: "ready" },
            runs,
            selectedRunId: runs[0]!.runId,
            runSelection: "selected",
          });
        }
        const selected = requestedRunId === undefined
          ? undefined
          : runs.find((run) => run.runId === requestedRunId);
        return ok({
          ...base,
          store: { state: "ready" },
          runs,
          ...(selected === undefined ? {} : { selectedRunId: selected.runId }),
          runSelection: selected === undefined ? "required" : "selected",
        });
      } finally {
        store.close();
      }
    } catch (error) {
      return fail(toDesktopError(error));
    }
  }

  resolveKnowledgeTarget(request: DesktopProjectRequest): DesktopResult<{
    storePath: string;
    runId: string;
    sourceVersion: string;
    sourceLanguage: string;
  }> {
    try {
      const manifestPath = requireManifestPath(request.manifestPath);
      const storePath = request.storePath === undefined
        ? discoverStorePath(manifestPath)
        : requireStorePath(request.storePath);
      if (storePath === undefined) {
        throw new DesktopInputError(
          "KNOWLEDGE_STORE_NOT_FOUND",
          "The current project has no translation state database",
        );
      }
      const snapshot = this.snapshot({
        ...request,
        manifestPath,
        storePath,
      });
      if (!snapshot.ok) {
        return fail(safeKnowledgeTargetError(snapshot.error));
      }
      if (snapshot.value.store.state === "invalid") {
        return fail(safeKnowledgeTargetError(snapshot.value.store.error ?? {
          code: "KNOWLEDGE_STORE_INVALID",
          message: "The current translation state database is not valid for this source",
          retryable: false,
        }));
      }
      if (snapshot.value.runSelection === "required") {
        throw new DesktopInputError(
          "KNOWLEDGE_RUN_SELECTION_REQUIRED",
          "Select one translation run before opening the knowledge workbench",
        );
      }
      if (snapshot.value.runSelection !== "selected"
        || snapshot.value.selectedRunId === undefined) {
        throw new DesktopInputError(
          "KNOWLEDGE_RUN_NOT_FOUND",
          "The current project has no translation run for this source",
        );
      }
      return ok({
        storePath,
        runId: snapshot.value.selectedRunId,
        sourceVersion: snapshot.value.sourceVersion,
        sourceLanguage: snapshot.value.sourceLanguage,
      });
    } catch (error) {
      return fail(safeKnowledgeTargetError(toDesktopError(error)));
    }
  }

  doctor(
    request: Pick<DesktopProjectRequest, "manifestPath" | "glossaryPath">,
  ): DesktopResult<DesktopDoctorReport> {
    try {
      const manifestPath = requireManifestPath(request.manifestPath);
      const glossaryPath = request.glossaryPath === undefined
        ? adjacentGlossaryPath(manifestPath)
        : requireGlossaryPath(request.glossaryPath);
      const report = this.#doctor(manifestPath, {}, glossaryPath);
      return ok(projectDoctorReport(report, glossaryPath));
    } catch (error) {
      return fail(toDesktopError(error));
    }
  }
}
