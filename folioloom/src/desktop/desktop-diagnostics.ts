import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";

import { redactSecrets } from "./secret-redaction.js";

const DIAGNOSTIC_SCHEMA = "folioloom-diagnostics-1";
const EVENT_SCHEMA = "folioloom-diagnostic-event-1";
const DEFAULT_MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_FILES = 4;
const DEFAULT_MAXIMUM_EVENT_BYTES = 16 * 1024;
const DEFAULT_MAXIMUM_EXPORTED_EVENTS = 1_000;
const MAXIMUM_ERROR_CAUSES = 5;
const MAXIMUM_MESSAGE_SCALARS = 2_000;
const MAXIMUM_STACK_SCALARS = 6_000;
const MAXIMUM_METADATA_DEPTH = 4;
const MAXIMUM_METADATA_ENTRIES = 64;

export type DesktopDiagnosticSeverity = "info" | "warning" | "error";
export type DesktopDiagnosticOutcome =
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

export interface DesktopDiagnosticEnvironment {
  platform: string;
  release: string;
  arch: string;
  electronVersion?: string;
  nodeVersion?: string;
  chromeVersion?: string;
}

export interface DesktopDiagnosticPathAliases {
  userData?: string;
  project?: string;
  temp?: string;
  app?: string;
}

export interface DesktopDiagnosticErrorCause {
  name: string;
  message: string;
  code?: string;
  phase?: string;
  stack?: string;
}

export interface DesktopDiagnosticError {
  causes: readonly DesktopDiagnosticErrorCause[];
}

export interface DesktopDiagnosticEvent {
  schemaVersion: typeof EVENT_SCHEMA;
  timestamp: string;
  severity: DesktopDiagnosticSeverity;
  event: string;
  operationId: string;
  channel?: string;
  phase?: string;
  durationMs?: number;
  outcome?: DesktopDiagnosticOutcome;
  errorCode?: string;
  metadata?: Readonly<Record<string, unknown>>;
  error?: DesktopDiagnosticError;
}

export interface DesktopDiagnosticEventInput {
  event: string;
  operationId: string;
  severity?: DesktopDiagnosticSeverity;
  channel?: string;
  phase?: string;
  durationMs?: number;
  outcome?: DesktopDiagnosticOutcome;
  errorCode?: string;
  metadata?: Readonly<Record<string, unknown>>;
  projectDirectory?: string;
}

export interface DesktopDiagnosticFailureInput
  extends Omit<DesktopDiagnosticEventInput, "severity" | "outcome" | "errorCode"> {
  error: unknown;
}

export interface DesktopDiagnosticModelContext {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  probeStatus?: string;
  probeCode?: string;
}

export interface DesktopDiagnosticSourceContext {
  format: string;
  language: string;
  encoding: string;
  characterCount: number;
  hashPrefix: string;
}

export interface DesktopDiagnosticRunSummary {
  runId?: string;
  phase?: string;
  totalWindows: number;
  completedWindows: number;
  warningWindows: number;
  humanRequiredWindows: number;
  failedWindows: number;
}

export interface DesktopDiagnosticContext {
  model?: DesktopDiagnosticModelContext;
  source?: DesktopDiagnosticSourceContext;
  runSummary?: DesktopDiagnosticRunSummary;
}

export interface DesktopDiagnosticOperation {
  event: string;
  operationId: string;
  channel?: string;
  phase?: string;
  errorCode?: string;
  timestamp: string;
}

export interface DesktopDiagnosticReport {
  manifest: {
    schema: typeof DIAGNOSTIC_SCHEMA;
    generatedAt: string;
    appVersion: string;
  };
  environment: DesktopDiagnosticEnvironment;
  model?: DesktopDiagnosticModelContext;
  source?: DesktopDiagnosticSourceContext;
  operation?: DesktopDiagnosticOperation;
  runSummary?: DesktopDiagnosticRunSummary;
  events: readonly DesktopDiagnosticEvent[];
  privacy: {
    excluded: readonly string[];
  };
}

export interface DesktopDiagnosticLoggerOptions {
  directory: string;
  appVersion: string;
  environment?: DesktopDiagnosticEnvironment;
  pathAliases?: DesktopDiagnosticPathAliases;
  maximumFileBytes?: number;
  maximumFiles?: number;
  maximumEventBytes?: number;
  maximumExportedEvents?: number;
  now?: () => string;
}

export class DesktopDiagnosticPrivacyError extends Error {
  readonly code = "DIAGNOSTIC_PRIVACY_CHECK_FAILED" as const;

  constructor(message: string) {
    super(`DIAGNOSTIC_PRIVACY_CHECK_FAILED: ${message}`);
    this.name = "DesktopDiagnosticPrivacyError";
  }
}

interface ResolvedPathAlias {
  path: string;
  marker: string;
}

const FORBIDDEN_FIELD = /^(?:api[-_]?key|authorization|cookie|password|secret|token|source[-_]?text|translation[-_]?text|prompt|raw[-_]?response|request[-_]?payload|knowledge[-_]?content)$/iu;
const WINDOWS_PRIVATE_PATH = /\b[A-Za-z]:\\[^\r\n"'<>|)]+/giu;
const POSIX_PRIVATE_PATH = /\/(?:Users|home)\/[^\s"'<>]+/gu;
const URL_WITH_PRIVATE_COMPONENTS = /https?:\/\/[^\s"'<>]+[/?#][^\s"'<>]*/giu;

function scalarSlice(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function finiteDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Number(value.toFixed(2));
}

function safeIdentifier(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > maximum) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return normalized;
}

function normalizedAliases(
  aliases: DesktopDiagnosticPathAliases,
): readonly ResolvedPathAlias[] {
  const pairs: Array<[keyof DesktopDiagnosticPathAliases, string]> = [
    ["project", "<project>"],
    ["userData", "<userData>"],
    ["temp", "<temp>"],
    ["app", "<app>"],
  ];
  return pairs.flatMap(([key, marker]): ResolvedPathAlias[] => {
    const value = aliases[key];
    if (typeof value !== "string" || value.trim().length === 0) return [];
    return [{ path: resolve(value), marker }];
  }).sort((left, right) => right.path.length - left.path.length);
}

function replaceInsensitive(value: string, needle: string, replacement: string): string {
  if (needle.length === 0) return value;
  let result = value;
  let searchFrom = 0;
  while (searchFrom < result.length) {
    const index = result.toLocaleLowerCase("en")
      .indexOf(needle.toLocaleLowerCase("en"), searchFrom);
    if (index < 0) break;
    result = `${result.slice(0, index)}${replacement}${result.slice(index + needle.length)}`;
    searchFrom = index + replacement.length;
  }
  return result;
}

function redactDiagnosticString(
  value: string,
  aliases: readonly ResolvedPathAlias[],
): string {
  let redacted = redactSecrets(value, "[REDACTED]");
  for (const alias of aliases) {
    redacted = replaceInsensitive(redacted, alias.path, alias.marker);
  }
  return redacted
    .replace(URL_WITH_PRIVATE_COMPONENTS, "<url>")
    .replace(WINDOWS_PRIVATE_PATH, "<privatePath>")
    .replace(POSIX_PRIVATE_PATH, "<privatePath>");
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Z][A-Z0-9_]{1,100}$/u.test(normalized) ? normalized : undefined;
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorCause(
  value: unknown,
  phase: string | undefined,
  aliases: readonly ResolvedPathAlias[],
): DesktopDiagnosticErrorCause {
  const record = errorRecord(value);
  const error = value instanceof Error ? value : undefined;
  const name = error?.name
    ?? (typeof record?.name === "string" ? record.name : typeof value);
  const rawMessage = error?.message
    ?? (typeof record?.message === "string" ? record.message : String(value));
  const code = safeErrorCode(record?.code)
    ?? rawMessage.match(/^[A-Z][A-Z0-9_]{1,100}/u)?.[0];
  const stack = typeof error?.stack === "string"
    ? scalarSlice(redactDiagnosticString(error.stack, aliases), MAXIMUM_STACK_SCALARS)
    : undefined;
  return {
    name: scalarSlice(redactDiagnosticString(name, aliases), 160),
    message: scalarSlice(
      redactDiagnosticString(rawMessage, aliases),
      MAXIMUM_MESSAGE_SCALARS,
    ),
    ...(code === undefined ? {} : { code }),
    ...(phase === undefined ? {} : { phase }),
    ...(stack === undefined || stack.length === 0 ? {} : { stack }),
  };
}

export function serializeDiagnosticError(
  value: unknown,
  phase: string | undefined,
  aliases: DesktopDiagnosticPathAliases = {},
): DesktopDiagnosticError {
  const resolvedAliases = normalizedAliases(aliases);
  const causes: DesktopDiagnosticErrorCause[] = [];
  const seen = new Set<object>();
  let current: unknown = value;
  for (let depth = 0; depth < MAXIMUM_ERROR_CAUSES; depth += 1) {
    if (current !== null && typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    causes.push(errorCause(current, phase, resolvedAliases));
    const record = errorRecord(current);
    if (record === undefined || !Object.hasOwn(record, "cause")) break;
    current = record.cause;
  }
  return { causes };
}

function sanitizeMetadataValue(
  value: unknown,
  aliases: readonly ResolvedPathAlias[],
  depth: number,
): unknown {
  if (depth > MAXIMUM_METADATA_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return scalarSlice(redactDiagnosticString(value, aliases), 1_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAXIMUM_METADATA_ENTRIES)
      .map((item) => sanitizeMetadataValue(item, aliases, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAXIMUM_METADATA_ENTRIES)) {
      if (FORBIDDEN_FIELD.test(key)) continue;
      result[key] = sanitizeMetadataValue(item, aliases, depth + 1);
    }
    return result;
  }
  return String(value);
}

function sanitizeMetadata(
  value: Readonly<Record<string, unknown>> | undefined,
  aliases: readonly ResolvedPathAlias[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const sanitized = sanitizeMetadataValue(value, aliases, 0);
  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return undefined;
  }
  return sanitized as Readonly<Record<string, unknown>>;
}

function eventErrorCode(error: DesktopDiagnosticError): string | undefined {
  return error.causes.find((cause) => cause.code !== undefined)?.code;
}

function eventAliases(
  base: DesktopDiagnosticPathAliases,
  projectDirectory: string | undefined,
): DesktopDiagnosticPathAliases {
  return {
    ...base,
    ...(projectDirectory === undefined ? {} : { project: projectDirectory }),
  };
}

function createEvent(
  input: DesktopDiagnosticEventInput,
  timestamp: string,
  baseAliases: DesktopDiagnosticPathAliases,
  error?: DesktopDiagnosticError,
): DesktopDiagnosticEvent {
  const aliases = normalizedAliases(eventAliases(baseAliases, input.projectDirectory));
  const metadata = sanitizeMetadata(input.metadata, aliases);
  const phase = input.phase === undefined
    ? undefined
    : scalarSlice(redactDiagnosticString(input.phase, aliases), 120);
  const errorCode = input.errorCode ?? (error === undefined ? undefined : eventErrorCode(error));
  return {
    schemaVersion: EVENT_SCHEMA,
    timestamp,
    severity: input.severity ?? (error === undefined ? "info" : "error"),
    event: safeIdentifier(input.event, "event"),
    operationId: safeIdentifier(input.operationId, "operationId"),
    ...(input.channel === undefined
      ? {}
      : { channel: safeIdentifier(input.channel, "channel") }),
    ...(phase === undefined ? {} : { phase }),
    ...(finiteDuration(input.durationMs) === undefined
      ? {}
      : { durationMs: finiteDuration(input.durationMs) as number }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata }),
    ...(error === undefined ? {} : { error }),
  };
}

function boundedEvent(
  event: DesktopDiagnosticEvent,
  maximumBytes: number,
): DesktopDiagnosticEvent {
  if (Buffer.byteLength(JSON.stringify(event), "utf8") <= maximumBytes) return event;
  const compact: DesktopDiagnosticEvent = {
    schemaVersion: EVENT_SCHEMA,
    timestamp: event.timestamp,
    severity: event.severity,
    event: scalarSlice(event.event, 80),
    operationId: scalarSlice(event.operationId, 80),
    ...(event.channel === undefined ? {} : { channel: scalarSlice(event.channel, 80) }),
    ...(event.phase === undefined ? {} : { phase: scalarSlice(event.phase, 80) }),
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    metadata: { truncated: true },
  };
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= maximumBytes) return compact;
  return {
    schemaVersion: EVENT_SCHEMA,
    timestamp: scalarSlice(event.timestamp, 40),
    severity: event.severity,
    event: "diagnostic.event.truncated",
    operationId: scalarSlice(event.operationId, 32),
    metadata: { truncated: true },
  };
}

function positiveInteger(value: number, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

function defaultEnvironment(): DesktopDiagnosticEnvironment {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    ...(process.versions.electron === undefined
      ? {}
      : { electronVersion: process.versions.electron }),
    nodeVersion: process.versions.node,
    ...(process.versions.chrome === undefined
      ? {}
      : { chromeVersion: process.versions.chrome }),
  };
}

function parseEvents(path: string): DesktopDiagnosticEvent[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split(/\r?\n/gu).flatMap((line) => {
      if (line.trim().length === 0) return [];
      try {
        const parsed = JSON.parse(line) as DesktopDiagnosticEvent;
        return parsed.schemaVersion === EVENT_SCHEMA ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function latestFailedOperation(
  events: readonly DesktopDiagnosticEvent[],
): DesktopDiagnosticOperation | undefined {
  const event = [...events].findLast((candidate) =>
    candidate.outcome === "failed" || candidate.severity === "error");
  if (event === undefined) return undefined;
  return {
    event: event.event,
    operationId: event.operationId,
    ...(event.channel === undefined ? {} : { channel: event.channel }),
    ...(event.phase === undefined ? {} : { phase: event.phase }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    timestamp: event.timestamp,
  };
}

function containsSensitiveString(value: string): boolean {
  const normalizedMarkers = value.replace(
    /\[(?:REDACTED|redacted|已隐藏)\]/gu,
    "MASKED",
  );
  if (redactSecrets(normalizedMarkers, "MASKED") !== normalizedMarkers) return true;
  const containsWindowsPath = WINDOWS_PRIVATE_PATH.test(value);
  WINDOWS_PRIVATE_PATH.lastIndex = 0;
  const containsPosixPath = POSIX_PRIVATE_PATH.test(value);
  POSIX_PRIVATE_PATH.lastIndex = 0;
  if (containsWindowsPath || containsPosixPath) return true;
  URL_WITH_PRIVATE_COMPONENTS.lastIndex = 0;
  const containsPrivateUrl = URL_WITH_PRIVATE_COMPONENTS.test(value);
  URL_WITH_PRIVATE_COMPONENTS.lastIndex = 0;
  return containsPrivateUrl;
}

function scanSafe(value: unknown, path: string, ancestors: Set<object>): void {
  if (typeof value === "string") {
    if (containsSensitiveString(value)) {
      throw new DesktopDiagnosticPrivacyError(`sensitive string at ${path}`);
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value !== "object") {
    throw new DesktopDiagnosticPrivacyError(`unsupported value at ${path}`);
  }
  if (ancestors.has(value)) {
    throw new DesktopDiagnosticPrivacyError(`circular value at ${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => scanSafe(item, `${path}[${index}]`, ancestors));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD.test(key)) {
        throw new DesktopDiagnosticPrivacyError(`forbidden field ${key} at ${path}`);
      }
      scanSafe(item, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertDiagnosticReportSafe(value: unknown): void {
  scanSafe(value, "$", new Set<object>());
}

export function writeDesktopDiagnosticReport(
  destination: string,
  report: unknown,
): void {
  assertDiagnosticReportSafe(report);
  const path = resolve(destination);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const reparsed = JSON.parse(readFileSync(temporary, "utf8")) as unknown;
    assertDiagnosticReportSafe(reparsed);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function formatDesktopDiagnosticSummary(
  report: DesktopDiagnosticReport,
): string {
  assertDiagnosticReportSafe(report);
  const operation = report.operation;
  return [
    `FolioLoom ${report.manifest.appVersion}`,
    `生成时间：${report.manifest.generatedAt}`,
    `系统：${report.environment.platform} ${report.environment.release} ${report.environment.arch}`,
    report.model === undefined
      ? "模型：未配置"
      : `模型：${report.model.providerId} / ${report.model.modelId}${report.model.reasoningEffort === undefined ? "" : ` / ${report.model.reasoningEffort}`}`,
    report.source === undefined
      ? "书稿：未打开"
      : `书稿：${report.source.format} / ${report.source.language} / ${report.source.encoding} / ${report.source.characterCount} 字符 / ${report.source.hashPrefix}`,
    operation === undefined
      ? "最近失败：无"
      : `最近失败：${operation.errorCode ?? "UNKNOWN"} / ${operation.phase ?? operation.event} / ${operation.timestamp}`,
  ].join("\n");
}

export class DesktopDiagnosticLogger {
  readonly #directory: string;
  readonly #appVersion: string;
  readonly #environment: DesktopDiagnosticEnvironment;
  readonly #pathAliases: DesktopDiagnosticPathAliases;
  readonly #maximumFileBytes: number;
  readonly #maximumFiles: number;
  readonly #maximumEventBytes: number;
  readonly #maximumExportedEvents: number;
  readonly #now: () => string;

  constructor(options: DesktopDiagnosticLoggerOptions) {
    this.#directory = resolve(options.directory);
    this.#appVersion = safeIdentifier(options.appVersion, "appVersion", 100);
    this.#environment = options.environment ?? defaultEnvironment();
    this.#pathAliases = { ...(options.pathAliases ?? {}) };
    this.#maximumFileBytes = positiveInteger(
      options.maximumFileBytes ?? DEFAULT_MAXIMUM_FILE_BYTES,
      "maximumFileBytes",
      256,
    );
    this.#maximumFiles = positiveInteger(
      options.maximumFiles ?? DEFAULT_MAXIMUM_FILES,
      "maximumFiles",
    );
    this.#maximumEventBytes = positiveInteger(
      options.maximumEventBytes ?? DEFAULT_MAXIMUM_EVENT_BYTES,
      "maximumEventBytes",
      256,
    );
    if (this.#maximumEventBytes + 1 > this.#maximumFileBytes) {
      throw new TypeError("maximumEventBytes must fit inside maximumFileBytes");
    }
    this.#maximumExportedEvents = positiveInteger(
      options.maximumExportedEvents ?? DEFAULT_MAXIMUM_EXPORTED_EVENTS,
      "maximumExportedEvents",
    );
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  record(input: DesktopDiagnosticEventInput): void {
    try {
      const event = boundedEvent(
        createEvent(input, this.#now(), this.#pathAliases),
        this.#maximumEventBytes,
      );
      this.#append(event);
    } catch {
      // Diagnostics are best-effort observability and never application state.
    }
  }

  recordFailure(input: DesktopDiagnosticFailureInput): void {
    try {
      const aliases = eventAliases(this.#pathAliases, input.projectDirectory);
      const error = serializeDiagnosticError(input.error, input.phase, aliases);
      const event = boundedEvent(
        createEvent({
          ...input,
          severity: "error",
          outcome: "failed",
          errorCode: eventErrorCode(error),
        }, this.#now(), this.#pathAliases, error),
        this.#maximumEventBytes,
      );
      this.#append(event);
    } catch {
      // A broken disk or unexpected error shape cannot break a translation.
    }
  }

  buildReport(context: DesktopDiagnosticContext = {}): DesktopDiagnosticReport {
    const events = this.#readEvents().slice(-this.#maximumExportedEvents);
    const report: DesktopDiagnosticReport = {
      manifest: {
        schema: DIAGNOSTIC_SCHEMA,
        generatedAt: this.#now(),
        appVersion: this.#appVersion,
      },
      environment: {
        platform: this.#environment.platform,
        release: this.#environment.release,
        arch: this.#environment.arch,
        ...(this.#environment.electronVersion === undefined
          ? {}
          : { electronVersion: this.#environment.electronVersion }),
        ...(this.#environment.nodeVersion === undefined
          ? {}
          : { nodeVersion: this.#environment.nodeVersion }),
        ...(this.#environment.chromeVersion === undefined
          ? {}
          : { chromeVersion: this.#environment.chromeVersion }),
      },
      ...(context.model === undefined ? {} : { model: { ...context.model } }),
      ...(context.source === undefined ? {} : { source: { ...context.source } }),
      ...(latestFailedOperation(events) === undefined
        ? {}
        : { operation: latestFailedOperation(events) as DesktopDiagnosticOperation }),
      ...(context.runSummary === undefined
        ? {}
        : { runSummary: { ...context.runSummary } }),
      events,
      privacy: {
        excluded: [
          "api_keys",
          "authorization_headers",
          "cookies",
          "source_text",
          "translation_text",
          "model_prompts",
          "raw_model_responses",
          "knowledge_content",
          "private_paths",
          "sqlite_database",
        ],
      },
    };
    assertDiagnosticReportSafe(report);
    return report;
  }

  #eventPath(index: number): string {
    return resolve(this.#directory, `events.${index}.jsonl`);
  }

  #append(event: DesktopDiagnosticEvent): void {
    mkdirSync(this.#directory, { recursive: true });
    const line = JSON.stringify(event);
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    const current = this.#eventPath(0);
    if (existsSync(current) && statSync(current).size + bytes > this.#maximumFileBytes) {
      this.#rotate();
    }
    appendFileSync(current, `${line}\n`, "utf8");
  }

  #rotate(): void {
    for (let index = this.#maximumFiles - 1; index >= 1; index -= 1) {
      const destination = this.#eventPath(index);
      const source = this.#eventPath(index - 1);
      rmSync(destination, { force: true });
      if (existsSync(source)) renameSync(source, destination);
    }
  }

  #readEvents(): DesktopDiagnosticEvent[] {
    const events: DesktopDiagnosticEvent[] = [];
    for (let index = this.#maximumFiles - 1; index >= 0; index -= 1) {
      events.push(...parseEvents(this.#eventPath(index)));
    }
    return events.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
      || left.operationId.localeCompare(right.operationId)
      || left.event.localeCompare(right.event));
  }
}
