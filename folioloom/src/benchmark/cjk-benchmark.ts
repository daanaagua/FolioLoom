import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getSourceLanguageProfile } from "../language/profiles.js";
import { WEIGHTED_TOKEN_ESTIMATOR_VERSION } from "../source/token-estimator.js";

export const BENCHMARK_PILOT_TARGET_SCALARS = 20_000;
export const BENCHMARK_KOREAN_FULL_TARGET_SCALARS = 200_000;
export const BENCHMARK_SELECTION_OVERSHOOT_SCALARS = 5_000;

export type BenchmarkLanguage = "ja" | "ko";
export type BenchmarkPhase = "pilot" | "formal";
export type BenchmarkSelection = "whole_source" | "prefix";
export type BenchmarkSelectionBoundary = "whole_source" | "paragraph" | "sentence" | "cap";

export interface BenchmarkSampleOptions {
  language: BenchmarkLanguage;
  wholeSource?: boolean;
  maxOvershootScalars?: number;
}

/**
 * The only type in this module that contains source prose. It is intentionally
 * not serializable by any report-producing function below.
 */
export interface BenchmarkSample {
  language: BenchmarkLanguage;
  text: string;
  sourceSha256: string;
  sampleSha256: string;
  sourceScalarCount: number;
  scalarCount: number;
  canonicalStart: number;
  canonicalEnd: number;
  selection: BenchmarkSelection;
  selectionBoundary: BenchmarkSelectionBoundary;
}

export interface RedactedBenchmarkSample {
  language: BenchmarkLanguage;
  sourceSha256: string;
  sampleSha256: string;
  sourceScalarCount: number;
  scalarCount: number;
  canonicalStart: number;
  canonicalEnd: number;
  selection: BenchmarkSelection;
  selectionBoundary: BenchmarkSelectionBoundary;
}

export interface BenchmarkMetrics {
  model?: unknown;
  effort?: unknown;
  usage?: unknown;
  requests?: unknown;
  retries?: unknown;
  errors?: unknown;
  throughput?: unknown;
  coverage?: unknown;
  audit?: unknown;
  [key: string]: unknown;
}

export interface RedactedBenchmarkMetrics {
  model?: string;
  effort?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  requests?: number;
  retries?: number;
  errors?: Record<string, number>;
  throughput?: Record<string, number>;
  coverage?: Record<string, number>;
  audit?: Record<string, number>;
}

export interface BenchmarkReport extends RedactedBenchmarkSample {
  schemaVersion: "folioloom-cjk-benchmark-1";
  profile: {
    id: BenchmarkLanguage;
    version: string;
  };
  estimatorVersion: string;
  nodeVersion: string;
  metrics: RedactedBenchmarkMetrics;
}

export interface BenchmarkEnvironment {
  japaneseSourcePath: string;
  koreanSourcePath: string;
  configPath: string;
  authPath: string;
  outputDirectory: string;
}

export interface OfflineBenchmarkPlanInput {
  japaneseSource: string;
  koreanSource: string;
  configSha256: string;
  authConfigured: boolean;
}

export interface OfflineBenchmarkRun {
  phase: BenchmarkPhase;
  language: BenchmarkLanguage;
  sample: RedactedBenchmarkSample;
  profile: {
    id: BenchmarkLanguage;
    version: string;
  };
  estimatorVersion: string;
  plannedVariants: readonly {
    translationMode: "quality" | "fast";
    reasoningEffort: "high" | "off";
  }[];
}

export interface OfflineBenchmarkPlan {
  schemaVersion: "folioloom-cjk-benchmark-1";
  execution: "offline_plan";
  configSha256: string;
  authConfigured: boolean;
  nodeVersion: string;
  runs: readonly OfflineBenchmarkRun[];
}

/**
 * An adapter receives source only in memory. It must return aggregate metrics,
 * never a provider response; the harness redacts even those metrics again.
 */
export interface BenchmarkExecutionRequest {
  runId: string;
  phase: BenchmarkPhase;
  language: BenchmarkLanguage;
  translationMode: "quality" | "fast";
  reasoningEffort: "high" | "off";
  sample: BenchmarkSample;
  profile: {
    id: BenchmarkLanguage;
    version: string;
  };
  estimatorVersion: string;
}

export interface BenchmarkExecutionAdapter {
  execute(request: BenchmarkExecutionRequest): Promise<BenchmarkMetrics> | BenchmarkMetrics;
}

export interface ExecutedBenchmarkRecord {
  runId: string;
  phase: BenchmarkPhase;
  language: BenchmarkLanguage;
  translationMode: "quality" | "fast";
  reasoningEffort: "high" | "off";
  report: BenchmarkReport;
}

export interface CjkBenchmarkExecutionOptions {
  /** Defaults to true: no adapter is called until the caller explicitly opts in. */
  dryRun?: boolean;
}

export interface CjkBenchmarkExecutionResult {
  execution: "dry_run" | "executed";
  plan: OfflineBenchmarkPlan;
  plannedRequestCount: number;
  reports: readonly ExecutedBenchmarkRecord[];
}

interface PlannedRunState {
  readonly run: OfflineBenchmarkRun;
  readonly sample: BenchmarkSample;
}

interface OfflineBenchmarkPlanState {
  readonly plan: OfflineBenchmarkPlan;
  readonly runStates: readonly PlannedRunState[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function countUnicodeScalars(text: string): number {
  let count = 0;
  for (const _scalar of text) {
    count += 1;
  }
  return count;
}

function utf16OffsetAtScalar(text: string, scalarOffset: number): number {
  if (!Number.isSafeInteger(scalarOffset) || scalarOffset < 0) {
    throw new RangeError("scalarOffset must be a non-negative safe integer");
  }
  if (scalarOffset === 0) {
    return 0;
  }
  let scalarCount = 0;
  let utf16Offset = 0;
  for (const scalar of text) {
    scalarCount += 1;
    utf16Offset += scalar.length;
    if (scalarCount === scalarOffset) {
      return utf16Offset;
    }
  }
  if (scalarCount === scalarOffset) {
    return utf16Offset;
  }
  throw new RangeError(`scalarOffset is outside source: ${scalarOffset}`);
}

function scalarOffsetAtUtf16(text: string, utf16Offset: number): number {
  let scalarCount = 0;
  let currentUtf16Offset = 0;
  for (const scalar of text) {
    if (currentUtf16Offset === utf16Offset) {
      return scalarCount;
    }
    currentUtf16Offset += scalar.length;
    scalarCount += 1;
    if (currentUtf16Offset === utf16Offset) {
      return scalarCount;
    }
    if (currentUtf16Offset > utf16Offset) {
      throw new RangeError(`UTF-16 offset splits a Unicode scalar: ${utf16Offset}`);
    }
  }
  if (currentUtf16Offset === utf16Offset) {
    return scalarCount;
  }
  throw new RangeError(`UTF-16 offset is outside source: ${utf16Offset}`);
}

function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function paragraphEndsUtf16(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(/(?:\r\n|\r|\n)[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)+/gu)) {
    if (match.index !== undefined) {
      ends.push(match.index + match[0].length);
    }
  }
  return ends;
}

function sentenceEndsUtf16(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(/[.!?。！？](?:["'”’」』）】〕])*/gu)) {
    if (match.index !== undefined) {
      ends.push(match.index + match[0].length);
    }
  }
  return ends;
}

function chooseBoundary(
  prefix: string,
  targetUtf16: number,
): { utf16Offset: number; boundary: Exclude<BenchmarkSelectionBoundary, "whole_source" | "cap"> } | undefined {
  const paragraphs = paragraphEndsUtf16(prefix);
  const sentences = sentenceEndsUtf16(prefix);
  const paragraphAfterTarget = paragraphs.find((offset) => offset >= targetUtf16);
  if (paragraphAfterTarget !== undefined) {
    return { utf16Offset: paragraphAfterTarget, boundary: "paragraph" };
  }
  const sentenceAfterTarget = sentences.find((offset) => offset >= targetUtf16);
  if (sentenceAfterTarget !== undefined) {
    return { utf16Offset: sentenceAfterTarget, boundary: "sentence" };
  }
  const paragraph = paragraphs.at(-1);
  const sentence = sentences.at(-1);
  if (paragraph === undefined && sentence === undefined) {
    return undefined;
  }
  if (paragraph === undefined) {
    return { utf16Offset: sentence as number, boundary: "sentence" };
  }
  if (sentence === undefined || paragraph >= sentence) {
    return { utf16Offset: paragraph, boundary: "paragraph" };
  }
  return { utf16Offset: sentence, boundary: "sentence" };
}

function reportSample(sample: BenchmarkSample): RedactedBenchmarkSample {
  return {
    language: sample.language,
    sourceSha256: sample.sourceSha256,
    sampleSha256: sample.sampleSha256,
    sourceScalarCount: sample.sourceScalarCount,
    scalarCount: sample.scalarCount,
    canonicalStart: sample.canonicalStart,
    canonicalEnd: sample.canonicalEnd,
    selection: sample.selection,
    selectionBoundary: sample.selectionBoundary,
  };
}

function redactedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const model = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)
    && !model.startsWith("/")
    && !/^[A-Za-z]:[\\/]/u.test(model)
    && !/^sk-[A-Za-z0-9_-]{8,}$/iu.test(model)
    && !/^AIza[A-Za-z0-9_-]{16,}$/u.test(model)
    && !/^AKIA[A-Z0-9]{16}$/u.test(model)
    && !/(?:api|key|token|secret)/iu.test(model)
    ? model
    : undefined;
}

function safeEffort(value: unknown): string | undefined {
  return value === "off" || value === "low" || value === "medium" || value === "high"
    || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : undefined;
}

const THROUGHPUT_METRICS = new Set([
  "sourceScalarsPerSecond",
  "translatedScalarsPerSecond",
  "tokensPerSecond",
  "elapsedSeconds",
  "requestsPerMinute",
]);
const COVERAGE_METRICS = new Set([
  "sourceScalars",
  "coveredScalars",
  "translatedScalars",
  "untranslatedScalars",
  "coverageRatio",
]);
const AUDIT_METRICS = new Set([
  "checkedBlocks",
  "failedBlocks",
  "incidents",
  "protocolViolations",
]);

function redactedNumberRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string> | "error_codes",
): Record<string, number> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const allowed = allowedKeys === "error_codes"
      ? /^[A-Z][A-Z0-9_]{0,63}$/u.test(key)
      : allowedKeys.has(key);
    if (allowed) {
      const numberValue = redactedNumber(rawValue);
      if (numberValue !== undefined) {
        record[key] = numberValue;
      }
    }
  }
  return Object.keys(record).length === 0 ? undefined : record;
}

function redactMetrics(metrics: BenchmarkMetrics): RedactedBenchmarkMetrics {
  const usageInput = metrics.usage;
  const usage = usageInput !== null && typeof usageInput === "object" && !Array.isArray(usageInput)
    ? {
      inputTokens: redactedNumber((usageInput as Record<string, unknown>).inputTokens),
      outputTokens: redactedNumber((usageInput as Record<string, unknown>).outputTokens),
    }
    : undefined;
  const sanitizedUsage = usage === undefined
    ? undefined
    : Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
  const result: RedactedBenchmarkMetrics = {
    model: safeModelId(metrics.model),
    effort: safeEffort(metrics.effort),
    usage: sanitizedUsage,
    requests: redactedNumber(metrics.requests),
    retries: redactedNumber(metrics.retries),
    errors: redactedNumberRecord(metrics.errors, "error_codes"),
    throughput: redactedNumberRecord(metrics.throughput, THROUGHPUT_METRICS),
    coverage: redactedNumberRecord(metrics.coverage, COVERAGE_METRICS),
    audit: redactedNumberRecord(metrics.audit, AUDIT_METRICS),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

/**
 * Choose a UTF-8 BOM-normalized prefix on a paragraph or sentence boundary.
 * The return value carries prose solely for an in-memory future runner; all
 * persistent data must be derived through benchmarkReport or the offline plan.
 */
export function selectBenchmarkSample(
  source: string,
  targetScalars: number,
  options: BenchmarkSampleOptions,
): BenchmarkSample {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string");
  }
  requirePositiveSafeInteger(targetScalars, "targetScalars");
  const maxOvershootScalars = options.maxOvershootScalars
    ?? BENCHMARK_SELECTION_OVERSHOOT_SCALARS;
  if (!Number.isSafeInteger(maxOvershootScalars) || maxOvershootScalars < 0) {
    throw new TypeError("maxOvershootScalars must be a non-negative safe integer");
  }

  const canonicalSource = stripUtf8Bom(source);
  const sourceScalarCount = countUnicodeScalars(canonicalSource);
  const sourceSha256 = sha256(canonicalSource);
  const useWholeSource = options.wholeSource === true || sourceScalarCount <= targetScalars;
  if (useWholeSource) {
    return {
      language: options.language,
      text: canonicalSource,
      sourceSha256,
      sampleSha256: sourceSha256,
      sourceScalarCount,
      scalarCount: sourceScalarCount,
      canonicalStart: 0,
      canonicalEnd: sourceScalarCount,
      selection: "whole_source",
      selectionBoundary: "whole_source",
    };
  }

  const upperBoundScalars = Math.min(
    sourceScalarCount,
    targetScalars + maxOvershootScalars,
  );
  const upperBoundUtf16 = utf16OffsetAtScalar(canonicalSource, upperBoundScalars);
  const targetUtf16 = utf16OffsetAtScalar(canonicalSource, targetScalars);
  const prefix = canonicalSource.slice(0, upperBoundUtf16);
  const boundary = chooseBoundary(prefix, targetUtf16);
  const selectedUtf16End = boundary?.utf16Offset ?? utf16OffsetAtScalar(canonicalSource, targetScalars);
  const selectedScalarCount = scalarOffsetAtUtf16(canonicalSource, selectedUtf16End);
  const text = canonicalSource.slice(0, selectedUtf16End);
  return {
    language: options.language,
    text,
    sourceSha256,
    sampleSha256: sha256(text),
    sourceScalarCount,
    scalarCount: selectedScalarCount,
    canonicalStart: 0,
    canonicalEnd: selectedScalarCount,
    selection: "prefix",
    selectionBoundary: boundary?.boundary ?? "cap",
  };
}

/** Construct a report whose shape has no field capable of carrying source prose or credentials. */
export function benchmarkReport(
  sample: BenchmarkSample,
  metrics: BenchmarkMetrics = {},
): BenchmarkReport {
  const profile = getSourceLanguageProfile(sample.language);
  return {
    schemaVersion: "folioloom-cjk-benchmark-1",
    ...reportSample(sample),
    profile: { id: sample.language, version: profile.version },
    estimatorVersion: WEIGHTED_TOKEN_ESTIMATOR_VERSION,
    nodeVersion: process.version,
    metrics: redactMetrics(metrics),
  };
}

function requiredEnvironmentValue(
  environment: Record<string, string | undefined>,
  primaryName: string,
  legacyName?: string,
): string | undefined {
  const primary = environment[primaryName]?.trim();
  const legacy = legacyName === undefined ? undefined : environment[legacyName]?.trim();
  return primary || legacy || undefined;
}

/**
 * Read only location metadata. The returned values never enter a benchmark
 * report, and legacy FOLIOLOOM_* names remain accepted for shell compatibility.
 */
export function readBenchmarkEnvironment(
  environment: Record<string, string | undefined> = process.env,
): BenchmarkEnvironment {
  const values = {
    japaneseSourcePath: requiredEnvironmentValue(environment, "FOLIOLOOM_JA_SOURCE"),
    koreanSourcePath: requiredEnvironmentValue(environment, "FOLIOLOOM_KO_SOURCE"),
    configPath: requiredEnvironmentValue(environment, "BENCH_CONFIG", "FOLIOLOOM_BENCH_CONFIG"),
    authPath: requiredEnvironmentValue(environment, "OPENCODE_AUTH", "FOLIOLOOM_OPENCODE_AUTH"),
    outputDirectory: requiredEnvironmentValue(environment, "BENCH_OUTPUT", "FOLIOLOOM_BENCH_OUTPUT"),
  };
  const labels: Record<keyof typeof values, string> = {
    japaneseSourcePath: "FOLIOLOOM_JA_SOURCE",
    koreanSourcePath: "FOLIOLOOM_KO_SOURCE",
    configPath: "BENCH_CONFIG",
    authPath: "OPENCODE_AUTH",
    outputDirectory: "BENCH_OUTPUT",
  };
  const missing = (Object.keys(values) as (keyof typeof values)[])
    .filter((key) => values[key] === undefined)
    .map((key) => labels[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required benchmark environment variables: ${missing.join(", ")}`);
  }
  return values as BenchmarkEnvironment;
}

function requireReadableFile(path: string, environmentVariable: string): void {
  if (!existsSync(path)) {
    throw new Error(`Benchmark input is not readable: ${environmentVariable}`);
  }
}

function validateSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("configSha256 must be a lowercase SHA-256 digest");
  }
  return value;
}

function runFor(
  phase: BenchmarkPhase,
  language: BenchmarkLanguage,
  source: string,
): PlannedRunState {
  const profile = getSourceLanguageProfile(language);
  const sample = selectBenchmarkSample(
    source,
    phase === "pilot" ? BENCHMARK_PILOT_TARGET_SCALARS : BENCHMARK_KOREAN_FULL_TARGET_SCALARS,
    {
      language,
      wholeSource: phase === "formal" && language === "ja",
    },
  );
  return {
    sample,
    run: {
      phase,
      language,
      sample: reportSample(sample),
      profile: { id: language, version: profile.version },
      estimatorVersion: WEIGHTED_TOKEN_ESTIMATOR_VERSION,
      plannedVariants: phase === "pilot"
        ? [
          { translationMode: "quality", reasoningEffort: "high" },
          { translationMode: "fast", reasoningEffort: "off" },
        ]
        : [{ translationMode: "fast", reasoningEffort: "off" }],
    },
  };
}

function createOfflineBenchmarkPlanState(input: OfflineBenchmarkPlanInput): OfflineBenchmarkPlanState {
  const runStates = [
    runFor("pilot", "ja", input.japaneseSource),
    runFor("pilot", "ko", input.koreanSource),
    runFor("formal", "ja", input.japaneseSource),
    runFor("formal", "ko", input.koreanSource),
  ];
  return {
    plan: {
      schemaVersion: "folioloom-cjk-benchmark-1",
      execution: "offline_plan",
      configSha256: validateSha256(input.configSha256),
      authConfigured: input.authConfigured === true,
      nodeVersion: process.version,
      runs: runStates.map((state) => state.run),
    },
    runStates,
  };
}

/**
 * Produce an execution-free manifest. It deliberately has no provider request
 * code, no raw source fields, no source paths, and no auth contents.
 */
export function createOfflineBenchmarkPlan(input: OfflineBenchmarkPlanInput): OfflineBenchmarkPlan {
  return createOfflineBenchmarkPlanState(input).plan;
}

function executionRequests(state: OfflineBenchmarkPlanState): BenchmarkExecutionRequest[] {
  return state.runStates.flatMap(({ run, sample }) => run.plannedVariants.map((variant) => ({
    runId: `${run.phase}-${run.language}-${variant.translationMode}`,
    phase: run.phase,
    language: run.language,
    translationMode: variant.translationMode,
    reasoningEffort: variant.reasoningEffort,
    sample,
    profile: run.profile,
    estimatorVersion: run.estimatorVersion,
  })));
}

/**
 * Runs are deliberately serialized and remain dry until explicitly requested.
 * This function owns report redaction, while the injected adapter owns the
 * provider-specific work and may be wired to the formal runner in a later step.
 */
export async function executeCjkBenchmark(
  input: OfflineBenchmarkPlanInput,
  adapter?: BenchmarkExecutionAdapter,
  options: CjkBenchmarkExecutionOptions = {},
): Promise<CjkBenchmarkExecutionResult> {
  const state = createOfflineBenchmarkPlanState(input);
  const requests = executionRequests(state);
  if (options.dryRun !== false) {
    return {
      execution: "dry_run",
      plan: state.plan,
      plannedRequestCount: requests.length,
      reports: [],
    };
  }
  if (adapter === undefined) {
    throw new Error("Benchmark execution requires an explicit execution adapter");
  }

  const reports: ExecutedBenchmarkRecord[] = [];
  for (const request of requests) {
    const metrics = await adapter.execute(request);
    reports.push({
      runId: request.runId,
      phase: request.phase,
      language: request.language,
      translationMode: request.translationMode,
      reasoningEffort: request.reasoningEffort,
      report: benchmarkReport(request.sample, metrics),
    });
  }
  return {
    execution: "executed",
    plan: state.plan,
    plannedRequestCount: requests.length,
    reports,
  };
}

function benchmarkInputFromEnvironment(environment: BenchmarkEnvironment): OfflineBenchmarkPlanInput {
  requireReadableFile(environment.japaneseSourcePath, "FOLIOLOOM_JA_SOURCE");
  requireReadableFile(environment.koreanSourcePath, "FOLIOLOOM_KO_SOURCE");
  requireReadableFile(environment.configPath, "BENCH_CONFIG");
  requireReadableFile(environment.authPath, "OPENCODE_AUTH");
  return {
    japaneseSource: readFileSync(environment.japaneseSourcePath, "utf8"),
    koreanSource: readFileSync(environment.koreanSourcePath, "utf8"),
    configSha256: sha256(readFileSync(environment.configPath, "utf8")),
    authConfigured: true,
  };
}

function writePrivateSafeArtifact(
  outputDirectory: string,
  fileName: string,
  artifact: OfflineBenchmarkPlan | CjkBenchmarkExecutionResult,
): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, fileName), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function writeOfflineBenchmarkPlan(
  environment: BenchmarkEnvironment,
): { reportFileName: string; plan: OfflineBenchmarkPlan } {
  const plan = createOfflineBenchmarkPlan(benchmarkInputFromEnvironment(environment));
  const reportFileName = "cjk-benchmark-offline-plan.json";
  writePrivateSafeArtifact(environment.outputDirectory, reportFileName, plan);
  return { reportFileName, plan };
}

function benchmarkExecutorModulePath(environment: Record<string, string | undefined>): string | undefined {
  return environment.BENCH_EXECUTOR_MODULE?.trim()
    || environment.FOLIOLOOM_BENCH_EXECUTOR_MODULE?.trim()
    || undefined;
}

async function loadBenchmarkExecutionAdapter(modulePath: string): Promise<BenchmarkExecutionAdapter> {
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const loaded = await import(moduleUrl) as Record<string, unknown>;
  const candidate = loaded.executeCjkBenchmarkRequest ?? loaded.default;
  if (typeof candidate !== "function") {
    throw new Error("Benchmark executor module must export executeCjkBenchmarkRequest");
  }
  return {
    execute: async (request: BenchmarkExecutionRequest): Promise<BenchmarkMetrics> => {
      const result = await candidate(request);
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Benchmark executor must return aggregate metrics object");
      }
      return result as BenchmarkMetrics;
    },
  };
}

function benchmarkCliMode(args: readonly string[]): "dry_run" | "execute" | "help" {
  if (args.length === 0) {
    return "dry_run";
  }
  if (args.length === 1 && args[0] === "--execute") {
    return "execute";
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  throw new Error("Usage: npm run benchmark:cjk [--execute]");
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const mode = benchmarkCliMode(args);
  if (mode === "help") {
    process.stdout.write("Usage: npm run benchmark:cjk [--execute]\n");
    process.stdout.write("Default mode writes a private-safe offline plan. --execute requires BENCH_EXECUTOR_MODULE.\n");
    return;
  }
  const modulePath = mode === "execute" ? benchmarkExecutorModulePath(process.env) : undefined;
  if (mode === "execute" && modulePath === undefined) {
    throw new Error("--execute requires BENCH_EXECUTOR_MODULE; no provider call was made");
  }
  const environment = readBenchmarkEnvironment();
  if (mode === "dry_run") {
    const { reportFileName } = writeOfflineBenchmarkPlan(environment);
    process.stdout.write(`Wrote private-safe offline benchmark plan: ${basename(reportFileName)}\n`);
    return;
  }
  const result = await executeCjkBenchmark(
    benchmarkInputFromEnvironment(environment),
    await loadBenchmarkExecutionAdapter(modulePath as string),
    { dryRun: false },
  );
  const reportFileName = "cjk-benchmark-executed-report.json";
  writePrivateSafeArtifact(environment.outputDirectory, reportFileName, result);
  process.stdout.write(`Wrote private-safe executed benchmark report: ${basename(reportFileName)}\n`);
}

const executedAsScript = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (executedAsScript) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown benchmark setup error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
