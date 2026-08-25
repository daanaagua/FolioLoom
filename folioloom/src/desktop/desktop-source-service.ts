import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import {
  importSource,
  SourceImportError,
  type SourceImportResult,
} from "../source/source-importer.js";
import {
  normalizeEncodingLabel,
  type CanonicalEncodingLabel,
  type SourceEncodingDecision,
} from "../source/encoding-policy.js";
import { SourceLedger } from "../source/source-ledger.js";
import {
  createDesktopProjectMetadata,
  desktopProjectMetadataPath,
} from "./desktop-project-metadata.js";

export interface DesktopSourceServiceOptions {
  projectsRoot: string;
  pendingImportTtlMs?: number;
}

export interface DesktopSourceImportRequest {
  sourcePath: string;
  sourceLanguage?: string;
  explicitEncoding?: string;
}

export interface DesktopSourceReadyResult extends SourceImportResult {
  status: "ready";
  projectDirectory: string;
  reused: boolean;
}

export interface DesktopSourceEncodingRequiredResult {
  status: "encoding_required";
  pendingImportId: string;
  fileName: string;
  encodings: readonly CanonicalEncodingLabel[];
}

export type DesktopSourceImportResult =
  | DesktopSourceReadyResult
  | DesktopSourceEncodingRequiredResult;

export interface DesktopConfirmEncodingRequest {
  pendingImportId: string;
  encoding: string;
}

interface PendingImport {
  sourcePath: string;
  sourceLanguage: string;
  rawSha256: string;
  allowedEncodings: ReadonlySet<CanonicalEncodingLabel>;
  expiresAt: number;
}

const DEFAULT_PENDING_IMPORT_TTL_MS = 10 * 60 * 1_000;
const SOURCE_PROBE_PREFIX = ".folioloom-source-probe-";

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function sanitizeTitle(sourcePath: string): string {
  const fileName = basename(sourcePath);
  const title = fileName.slice(0, Math.max(0, fileName.length - extname(fileName).length))
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[ .-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return title.length === 0 ? "Untitled" : title.slice(0, 80);
}

function projectName(sourcePath: string, rawSha256: string): string {
  return `${sanitizeTitle(sourcePath)}-${rawSha256.slice(0, 12)}`;
}

async function regularAbsoluteFile(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim().length === 0 || !isAbsolute(path)) {
    throw new SourceImportError("SOURCE_INPUT_INVALID", "sourcePath must be an absolute file path");
  }
  let resolved: string;
  try {
    resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) {
      throw new SourceImportError("SOURCE_INPUT_INVALID", "sourcePath must identify a regular file");
    }
  } catch (error) {
    if (error instanceof SourceImportError) {
      throw error;
    }
    throw new SourceImportError(
      "SOURCE_INPUT_INVALID",
      error instanceof Error ? error.message : "sourcePath cannot be resolved",
    );
  }
  return resolved;
}

function encodingDecisionIdentity(decision: SourceEncodingDecision): string {
  return JSON.stringify([
    decision.canonicalLabel,
    decision.decisionSource,
    decision.confidence,
    decision.alternatives.map((alternative) => [
      alternative.canonicalLabel,
      alternative.confidence,
      [...alternative.diagnostics],
    ]),
    [...decision.diagnostics],
    decision.policyVersion,
  ]);
}

function hasCompleteEncodingDecision(ledger: SourceLedger): boolean {
  // DOCX/EPUB are decoded from a UTF-8 ZIP container, so they intentionally do
  // not have a byte-decoding decision. Plain-text imports must retain one.
  if (ledger.encoding === "zip-container") {
    return ledger.encodingDecision === undefined;
  }
  return !ledger.sourceEncodingCompatibilityMode && ledger.encodingDecision !== undefined;
}

function matchesFreshImport(existing: SourceLedger, current: SourceLedger): boolean {
  if (existing.sourceLanguageCompatibilityMode || current.sourceLanguageCompatibilityMode) {
    return false;
  }
  if (existing.languageProfile.id !== current.languageProfile.id
    || existing.languageProfile.version !== current.languageProfile.version) {
    return false;
  }
  if (existing.encoding !== current.encoding
    || !hasCompleteEncodingDecision(existing)
    || !hasCompleteEncodingDecision(current)) {
    return false;
  }
  if (existing.encodingDecision !== undefined || current.encodingDecision !== undefined) {
    if (existing.encodingDecision === undefined || current.encodingDecision === undefined
      || encodingDecisionIdentity(existing.encodingDecision) !== encodingDecisionIdentity(current.encodingDecision)) {
      return false;
    }
  }
  return existing.sourceVersion === current.sourceVersion;
}

async function existingProjectForFreshImport(
  projectsRoot: string,
  rawSha256: string,
  current: SourceLedger,
): Promise<DesktopSourceReadyResult | undefined> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(SOURCE_PROBE_PREFIX)) {
      continue;
    }
    const projectDirectory = join(projectsRoot, entry.name);
    const manifestPath = join(projectDirectory, "source_manifest.json");
    try {
      const ledger = SourceLedger.open(manifestPath);
      if (sha256(await readFile(ledger.rawPath)) !== rawSha256) {
        continue;
      }
      if (!matchesFreshImport(ledger, current)) {
        continue;
      }
      return {
        status: "ready",
        projectDirectory,
        manifestPath: ledger.manifestPath,
        rawSha256,
        canonicalChars: ledger.canonicalChars,
        reused: true,
      };
    } catch {
      // A broken or unrelated directory must not prevent importing a new manuscript.
    }
  }
  return undefined;
}

async function unusedProjectDirectory(projectsRoot: string, baseName: string): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(projectsRoot, suffix === 0 ? baseName : `${baseName}-${suffix + 1}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

export class DesktopSourceService {
  readonly #projectsRoot: string;
  readonly #pendingImportTtlMs: number;
  readonly #pendingImports = new Map<string, PendingImport>();

  constructor(options: DesktopSourceServiceOptions) {
    if (!isAbsolute(options.projectsRoot)) {
      throw new SourceImportError("SOURCE_INPUT_INVALID", "projectsRoot must be an absolute directory path");
    }
    this.#projectsRoot = resolve(options.projectsRoot);
    this.#pendingImportTtlMs = options.pendingImportTtlMs ?? DEFAULT_PENDING_IMPORT_TTL_MS;
    if (!Number.isSafeInteger(this.#pendingImportTtlMs) || this.#pendingImportTtlMs <= 0) {
      throw new SourceImportError("SOURCE_INPUT_INVALID", "pendingImportTtlMs must be a positive safe integer");
    }
  }

  async importSource(request: DesktopSourceImportRequest): Promise<DesktopSourceImportResult> {
    const sourcePath = await regularAbsoluteFile(request.sourcePath);
    const initialRawSha256 = sha256(await readFile(sourcePath));
    try {
      return await this.#importReady({ ...request, sourcePath }, initialRawSha256);
    } catch (error) {
      if (!(error instanceof SourceImportError) || error.code !== "SOURCE_ENCODING_AMBIGUOUS") {
        throw error;
      }
      const encodings = [...new Set(error.alternatives.map((item) => item.canonicalLabel))];
      if (encodings.length === 0) {
        throw error;
      }
      this.#removeExpiredPendingImports();
      const pendingImportId = randomUUID();
      this.#pendingImports.set(pendingImportId, {
        sourcePath,
        sourceLanguage: request.sourceLanguage ?? "auto",
        rawSha256: initialRawSha256,
        allowedEncodings: new Set(encodings),
        expiresAt: Date.now() + this.#pendingImportTtlMs,
      });
      return {
        status: "encoding_required",
        pendingImportId,
        fileName: basename(sourcePath),
        encodings,
      };
    }
  }

  async confirmEncoding(request: DesktopConfirmEncodingRequest): Promise<DesktopSourceReadyResult> {
    this.#removeExpiredPendingImports();
    const pending = this.#pendingImports.get(request.pendingImportId);
    this.#pendingImports.delete(request.pendingImportId);
    if (pending === undefined) {
      throw new SourceImportError(
        "SOURCE_INPUT_INVALID",
        "pending import id is invalid, expired, or already used",
      );
    }
    let encoding: CanonicalEncodingLabel;
    try {
      encoding = normalizeEncodingLabel(request.encoding);
    } catch {
      throw new SourceImportError("SOURCE_INPUT_INVALID", "selected encoding is invalid");
    }
    if (!pending.allowedEncodings.has(encoding)) {
      throw new SourceImportError("SOURCE_INPUT_INVALID", "selected encoding is invalid");
    }
    const sourcePath = await regularAbsoluteFile(pending.sourcePath);
    if (sha256(await readFile(sourcePath)) !== pending.rawSha256) {
      throw new SourceImportError(
        "SOURCE_CHANGED_DURING_IMPORT",
        "source bytes changed before encoding confirmation",
      );
    }
    return this.#importReady({
      sourcePath,
      sourceLanguage: pending.sourceLanguage,
      explicitEncoding: encoding,
    }, pending.rawSha256);
  }

  async #importReady(
    request: DesktopSourceImportRequest,
    initialRawSha256: string,
  ): Promise<DesktopSourceReadyResult> {
    const sourcePath = request.sourcePath;
    await mkdir(this.#projectsRoot, { recursive: true });
    const explicitEncoding = request.explicitEncoding === undefined
      ? undefined
      : normalizeEncodingLabel(request.explicitEncoding);
    const probeDirectory = join(this.#projectsRoot, `${SOURCE_PROBE_PREFIX}${randomUUID()}`);
    try {
      // Re-import into a private staging directory before considering a raw-hash
      // match. A hash alone cannot prove that old detection policy, language
      // profile, and user/automatic encoding decisions still describe these bytes.
      const imported = await importSource({
        sourcePath,
        projectDirectory: probeDirectory,
        sourceLanguage: request.sourceLanguage ?? "auto",
        ...(explicitEncoding === undefined ? {} : { explicitEncoding }),
      });
      if (imported.rawSha256 !== initialRawSha256) {
        throw new SourceImportError("SOURCE_CHANGED_DURING_IMPORT", "source bytes changed before project import completed");
      }
      const current = SourceLedger.open(imported.manifestPath);
      const existing = await existingProjectForFreshImport(
        this.#projectsRoot,
        initialRawSha256,
        current,
      );
      if (existing !== undefined) {
        await rm(probeDirectory, { recursive: true, force: true });
        return existing;
      }
      const projectDirectory = await unusedProjectDirectory(
        this.#projectsRoot,
        projectName(sourcePath, initialRawSha256),
      );
      await writeFile(
        desktopProjectMetadataPath(probeDirectory),
        `${JSON.stringify(createDesktopProjectMetadata(sourcePath), null, 2)}\n`,
        "utf8",
      );
      await rename(probeDirectory, projectDirectory);
      return {
        status: "ready",
        ...imported,
        manifestPath: join(projectDirectory, "source_manifest.json"),
        projectDirectory,
        reused: false,
      };
    } catch (error) {
      await rm(probeDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #removeExpiredPendingImports(): void {
    const now = Date.now();
    for (const [id, pending] of this.#pendingImports) {
      if (pending.expiresAt <= now) {
        this.#pendingImports.delete(id);
      }
    }
  }
}
