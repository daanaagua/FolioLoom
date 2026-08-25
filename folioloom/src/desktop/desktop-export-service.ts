import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import { writeLosslessBookEpub } from "../export/epub-writer.js";
import { verifyExport } from "../export/export-verifier.js";
import {
  auditLosslessBookStore,
  writeLosslessBookArtifacts,
  type LosslessBookArtifactPaths,
} from "../report.js";
import { SourceLedger } from "../source/source-ledger.js";
import {
  LosslessBookStore,
  type StoredTranslationRun,
} from "../storage/lossless-book-store.js";
import type {
  DesktopExportCandidate,
  DesktopExportDestination,
  DesktopExportFormat,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopExportSnapshot,
  DesktopProjectRequest,
} from "./contracts.js";
import { desktopProjectTitle } from "./desktop-project-metadata.js";

const DEFAULT_DESTINATION_TTL_MS = 24 * 60 * 60 * 1_000;
const EXPORT_FORMATS = new Set<DesktopExportFormat>([
  "translation_txt",
  "bilingual_txt",
  "epub",
]);

interface NormalizedExportProject {
  manifestPath: string;
  storePath: string;
  projectDirectory: string;
  sourceVersion: string;
  title: string;
}

interface DestinationRegistration extends DesktopExportDestination {
  expiresAt: number;
}

type ArtifactWriter = typeof writeLosslessBookArtifacts;
type EpubWriter = typeof writeLosslessBookEpub;
type ExportVerifier = typeof verifyExport;
type StoreAuditor = typeof auditLosslessBookStore;

export interface DesktopExportServiceOptions {
  now?: () => number;
  destinationTtlMs?: number;
  createDestinationId?: () => string;
  createExportId?: () => string;
  writeArtifacts?: ArtifactWriter;
  writeEpub?: EpubWriter;
  verify?: ExportVerifier;
  audit?: StoreAuditor;
}

export class DesktopExportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopExportError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTrialRun(run: StoredTranslationRun): boolean {
  const trial = record(record(run.metadata)?.desktopTrial);
  return trial?.schema === "folioloom-desktop-trial-2";
}

function validRunId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 200
    && !/[\u0000-\u001f]/u.test(value);
}

function safeStem(value: string): string {
  const sanitized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[.\s]+$/gu, "")
    .trim()
    .slice(0, 100)
    .replace(/[.\s]+$/gu, "");
  return sanitized.length > 0 ? sanitized : "FolioLoom";
}

function normalizeProject(project: DesktopProjectRequest): NormalizedExportProject {
  if (typeof project?.manifestPath !== "string"
    || !isAbsolute(project.manifestPath)
    || basename(project.manifestPath) !== "source_manifest.json") {
    throw new DesktopExportError(
      "DESKTOP_EXPORT_INPUT_INVALID",
      "导出需要当前项目的 source_manifest.json",
    );
  }
  const manifestPath = resolve(project.manifestPath);
  const ledger = SourceLedger.open(manifestPath);
  let storePath: string;
  if (project.storePath === undefined) {
    storePath = join(dirname(manifestPath), "artifacts", "folioloom", "book.db");
  } else {
    if (!isAbsolute(project.storePath) || extname(project.storePath) !== ".db") {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_INPUT_INVALID",
        "导出状态库必须是绝对 .db 路径",
      );
    }
    storePath = resolve(project.storePath);
  }
  return {
    manifestPath,
    storePath,
    projectDirectory: dirname(manifestPath),
    sourceVersion: ledger.sourceVersion,
    title: desktopProjectTitle(manifestPath, ledger.rawPath),
  };
}

function candidateFor(
  store: LosslessBookStore,
  run: StoredTranslationRun,
  auditStore: StoreAuditor,
): DesktopExportCandidate {
  const summary = store.statusSummary(run.runId);
  const blockers: string[] = [];
  let auditComplete = false;
  try {
    const audit = auditStore(store, run.runId);
    auditComplete = audit.complete;
    if (audit.incidentCodes.length > 0) {
      blockers.push(`完整性校验未通过：${audit.incidentCodes.join("、")}`);
    }
  } catch {
    blockers.push("完整性校验未通过：无法读取这次翻译的审计记录");
  }
  if (summary.humanRequiredWindows > 0) {
    blockers.push(`有 ${summary.humanRequiredWindows} 个文本块需要人工处理`);
  }
  if (summary.failedWindows > 0) {
    blockers.push(`有 ${summary.failedWindows} 个文本块翻译失败`);
  }
  const completedWindows = summary.completedWindows + summary.warningWindows;
  const status: DesktopExportCandidate["status"] = blockers.length > 0
    ? "blocked"
    : auditComplete
      ? "ready"
      : "incomplete";
  if (status === "incomplete") {
    blockers.push(`翻译尚未完成：已完成 ${completedWindows} / ${summary.totalWindows} 个文本块`);
  }
  return {
    runId: run.runId,
    modelId: run.modelId,
    status,
    completedWindows,
    totalWindows: summary.totalWindows,
    blockers,
  };
}

function requireFormats(value: unknown): DesktopExportFormat[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DesktopExportError(
      "DESKTOP_EXPORT_INPUT_INVALID",
      "请至少选择一种导出格式",
    );
  }
  const formats: DesktopExportFormat[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !EXPORT_FORMATS.has(item as DesktopExportFormat)) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_INPUT_INVALID",
        "导出格式无效",
      );
    }
    if (seen.has(item)) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_INPUT_INVALID",
        "导出格式不能重复",
      );
    }
    seen.add(item);
    formats.push(item as DesktopExportFormat);
  }
  return formats;
}

function nextAvailableDirectory(parent: string, stem: string): string {
  const base = join(parent, `${stem}-译文`);
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new DesktopExportError(
    "DESKTOP_EXPORT_DESTINATION_BUSY",
    "目标目录中已有过多同名导出",
  );
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = record(error)?.code;
    if (code !== "ENOENT") throw error;
  }
}

export class DesktopExportService {
  readonly #now: () => number;
  readonly #destinationTtlMs: number;
  readonly #createDestinationId: () => string;
  readonly #createExportId: () => string;
  readonly #writeArtifacts: ArtifactWriter;
  readonly #writeEpub: EpubWriter;
  readonly #verify: ExportVerifier;
  readonly #audit: StoreAuditor;
  readonly #destinations = new Map<string, DestinationRegistration>();
  readonly #destinationByPath = new Map<string, string>();
  readonly #completed = new Map<string, string>();

  constructor(options: DesktopExportServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#destinationTtlMs = options.destinationTtlMs ?? DEFAULT_DESTINATION_TTL_MS;
    this.#createDestinationId = options.createDestinationId ?? randomUUID;
    this.#createExportId = options.createExportId ?? randomUUID;
    this.#writeArtifacts = options.writeArtifacts ?? writeLosslessBookArtifacts;
    this.#writeEpub = options.writeEpub ?? writeLosslessBookEpub;
    this.#verify = options.verify ?? verifyExport;
    this.#audit = options.audit ?? auditLosslessBookStore;
    if (!Number.isSafeInteger(this.#destinationTtlMs) || this.#destinationTtlMs <= 0) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_INPUT_INVALID",
        "destinationTtlMs 必须是正安全整数",
      );
    }
  }

  snapshot(projectRequest: DesktopProjectRequest): DesktopExportSnapshot {
    const project = normalizeProject(projectRequest);
    const defaultDestination = this.#registerStableDestination(
      join(project.projectDirectory, "exports"),
    );
    if (!existsSync(project.storePath)) {
      return { candidates: [], defaultDestination };
    }
    const store = LosslessBookStore.openReadOnly(project.storePath);
    try {
      const candidates = store.listTranslationRuns()
        .filter((run) => run.sourceVersion === project.sourceVersion && !isTrialRun(run))
        .map((run) => candidateFor(store, run, this.#audit));
      return { candidates, defaultDestination };
    } finally {
      store.close();
    }
  }

  registerDestination(path: string): DesktopExportDestination {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_DESTINATION_INVALID",
        "导出目录必须是绝对路径",
      );
    }
    const resolved = resolve(path);
    if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_DESTINATION_INVALID",
        "导出位置不是文件夹",
      );
    }
    return this.#registerStableDestination(resolved);
  }

  async export(
    projectRequest: DesktopProjectRequest,
    request: DesktopExportRequest,
  ): Promise<DesktopExportResult> {
    if (!validRunId(request?.runId)
      || typeof request?.destinationId !== "string"
      || request.destinationId.length === 0) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_INPUT_INVALID",
        "请选择一项可导出的整本翻译",
      );
    }
    const formats = requireFormats(request.formats);
    const destination = this.#destination(request.destinationId);
    const project = normalizeProject(projectRequest);
    if (!existsSync(project.storePath)) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_RUN_NOT_FOUND",
        "没有找到这次翻译的状态库",
      );
    }
    const store = LosslessBookStore.openReadOnly(project.storePath);
    let temporaryDirectory = "";
    try {
      const run = store.listTranslationRuns().find((candidate) =>
        candidate.runId === request.runId
        && candidate.sourceVersion === project.sourceVersion
        && !isTrialRun(candidate));
      if (run === undefined) {
        throw new DesktopExportError(
          "DESKTOP_EXPORT_RUN_NOT_FOUND",
          "没有找到这次可导出的整本翻译",
        );
      }
      const candidate = candidateFor(store, run, this.#audit);
      if (candidate.status !== "ready") {
        throw new DesktopExportError(
          "DESKTOP_EXPORT_NOT_READY",
          candidate.blockers.join("；"),
        );
      }

      mkdirSync(destination.displayPath, { recursive: true });
      const stem = safeStem(project.title);
      const finalDirectory = nextAvailableDirectory(destination.displayPath, stem);
      const exportId = this.#createExportId();
      if (!/^[A-Za-z0-9_-]{1,200}$/u.test(exportId)) {
        throw new DesktopExportError(
          "DESKTOP_EXPORT_INPUT_INVALID",
          "生成的导出标识无效",
        );
      }
      temporaryDirectory = join(
        destination.displayPath,
        `.${basename(finalDirectory)}.tmp-${exportId}`,
      );
      if (existsSync(temporaryDirectory)) {
        throw new DesktopExportError(
          "DESKTOP_EXPORT_DESTINATION_BUSY",
          "导出临时目录已存在",
        );
      }
      mkdirSync(temporaryDirectory, { recursive: false });
      const paths = this.#writeArtifacts(store, run.runId, temporaryDirectory, {
        fileStem: stem,
      });
      const epubPath = join(temporaryDirectory, `${stem}.epub`);
      await this.#writeEpub(store, run.runId, epubPath, {
        title: project.title,
        language: "zh-CN",
        sourceManifestPath: project.manifestPath,
      });
      const allPaths: LosslessBookArtifactPaths = { ...paths, epub: epubPath };
      const verification = this.#verify(allPaths, store, run.runId);
      if (!verification.ok) {
        throw new DesktopExportError(
          "DESKTOP_EXPORT_VERIFICATION_FAILED",
          `导出校验未通过：${verification.incidentCodes.join("、")}`,
        );
      }
      this.#removeUnselected(allPaths, new Set(formats));
      renameSync(temporaryDirectory, finalDirectory);
      temporaryDirectory = "";
      this.#completed.set(exportId, finalDirectory);
      return {
        exportId,
        runId: run.runId,
        directory: finalDirectory,
        files: [
          ...(formats.includes("translation_txt")
            ? [{ format: "translation_txt" as const, fileName: basename(paths.translation) }]
            : []),
          ...(formats.includes("bilingual_txt")
            ? [{ format: "bilingual_txt" as const, fileName: basename(paths.bilingual) }]
            : []),
          ...(formats.includes("epub")
            ? [{ format: "epub" as const, fileName: basename(epubPath) }]
            : []),
          { format: "audit", fileName: basename(paths.audit) },
          { format: "metrics", fileName: basename(paths.metrics) },
        ],
      };
    } catch (error) {
      if (error instanceof DesktopExportError) throw error;
      throw new DesktopExportError(
        "DESKTOP_EXPORT_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      store.close();
      if (temporaryDirectory.length > 0) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  completedDirectory(exportId: string): string | undefined {
    return this.#completed.get(exportId);
  }

  #registerStableDestination(path: string): DesktopExportDestination {
    const existingId = this.#destinationByPath.get(path);
    const existing = existingId === undefined ? undefined : this.#destinations.get(existingId);
    if (existing !== undefined && existing.expiresAt > this.#now()) {
      return {
        destinationId: existing.destinationId,
        displayPath: existing.displayPath,
      };
    }
    if (existingId !== undefined) {
      this.#destinations.delete(existingId);
    }
    const destinationId = this.#createDestinationId();
    if (typeof destinationId !== "string"
      || destinationId.length < 1
      || destinationId.length > 200
      || /[\u0000-\u001f]/u.test(destinationId)) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_INPUT_INVALID",
        "生成的目录授权标识无效",
      );
    }
    const registration: DestinationRegistration = {
      destinationId,
      displayPath: path,
      expiresAt: this.#now() + this.#destinationTtlMs,
    };
    this.#destinations.set(destinationId, registration);
    this.#destinationByPath.set(path, destinationId);
    return { destinationId, displayPath: path };
  }

  #destination(destinationId: string): DestinationRegistration {
    const destination = this.#destinations.get(destinationId);
    if (destination === undefined) {
      throw new DesktopExportError(
        "DESKTOP_EXPORT_DESTINATION_INVALID",
        "导出位置授权无效，请重新选择文件夹",
      );
    }
    if (destination.expiresAt <= this.#now()) {
      this.#destinations.delete(destinationId);
      this.#destinationByPath.delete(destination.displayPath);
      throw new DesktopExportError(
        "DESKTOP_EXPORT_DESTINATION_EXPIRED",
        "导出位置授权已过期，请重新选择文件夹",
      );
    }
    return destination;
  }

  #removeUnselected(
    paths: LosslessBookArtifactPaths,
    formats: ReadonlySet<DesktopExportFormat>,
  ): void {
    if (!formats.has("translation_txt")) {
      removeIfPresent(paths.translation);
      removeIfPresent(paths.translationLineage);
    }
    if (!formats.has("bilingual_txt")) {
      removeIfPresent(paths.bilingual);
      removeIfPresent(paths.bilingualLineage);
    }
    if (!formats.has("epub") && paths.epub !== undefined) {
      removeIfPresent(paths.epub);
    }
  }
}
