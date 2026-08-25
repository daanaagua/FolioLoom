import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDeepSeekModel,
  createDeepSeekStreamFn,
  PiRuntime,
} from "./agents/pi-runtime.js";
import { RecoveryAgent } from "./agents/recovery-agent.js";
import {
  loadOpenCodeApiKey,
  loadPilotConfig,
  withReasoningEffort,
  type PilotModelConfig,
} from "./config.js";
import {
  LOSSLESS_BOOK_PROTOCOL_VERSION,
  preflightBook,
  runBook,
  type LosslessBookRunOptions,
  type LosslessBookRunResult,
} from "./fullbook/book-runner.js";
import { BookContext } from "./fullbook/book-context.js";
import type {
  TranslationRunMode,
  TranslationRuntimeSet,
} from "./fullbook/types.js";
import {
  optimizationPolicy,
  profileFromLegacyRunMode,
  validateRuntimeVariants,
  type OptimizationProfile,
  type SchedulerMode,
} from "./fullbook/optimization-policy.js";
import {
  loadGlossary,
  type GlossaryImportReport,
  type LoadedGlossary,
} from "./glossary/glossary-profile.js";
import { planBookWindows, type WindowPlanOptions } from "./fullbook/window-planner.js";
import { preflightPilot, runPilot } from "./pilot-runner.js";
import { BudgetLedger } from "./kernel/budget.js";
import { providerRegistry, toInternalThinking } from "./providers/registry.js";
import type { ProviderEffort } from "./providers/types.js";
import { projectRecoveryRule, isIncidentCode } from "./recovery/registry.js";
import {
  createStoreRecoveryIncident,
  loadAttemptedRecoveryStrategies,
  RecoveryEngine,
  StoreRecoveryKernel,
} from "./recovery/recovery-engine.js";
import type { IncidentCode } from "./recovery/types.js";
import {
  auditLosslessBookStore,
  type BookArtifactPaths,
  losslessBookArtifactPaths,
  writeLosslessBookArtifacts,
} from "./report.js";
import { verifyExport } from "./export/export-verifier.js";
import { importLegacyV1 } from "./migration/v1-importer.js";
import { auditSourceCoverage } from "./source/auditor.js";
import {
  analyzeSourceAnomalies,
  type SourceAnomalyReport,
} from "./source/anomaly-report.js";
import { buildLosslessBlocks } from "./source/block-builder.js";
import { SourceIntegrityError, SourceLedger } from "./source/source-ledger.js";
import { annotateStructure } from "./source/structure-annotator.js";
import { LosslessBookStore } from "./storage/lossless-book-store.js";
import { RuntimeProfileStore } from "./storage/runtime-profile-store.js";
import {
  loadStyleProfile,
  type LoadedStyleProfile,
} from "./style/style-profile.js";

export type CliCommand =
  | "preview"
  | "book-preflight"
  | "book-doctor"
  | "book-audit"
  | "book-recover"
  | "book-verify-export"
  | "book-migrate-v1"
  | "book-run"
  | "book-status"
  | "book-export";

export interface CliOptions {
  command: CliCommand;
  db?: string;
  manifest?: string;
  legacyV4Db?: string;
  legacyStore?: string;
  runId?: string;
  incidentCode?: IncidentCode;
  config?: string;
  output?: string;
  epub?: string;
  store?: string;
  globalIndexes?: number[];
  preflightOnly?: boolean;
  allowIncomplete?: boolean;
  openCodeAuth?: string;
  maxWindows?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  maxBlocks?: number;
  maxSourceTokens?: number;
  hardDeadlineMs?: number;
  styleProfile?: string;
  prompt?: string;
  glossary?: string;
  runMode?: TranslationRunMode;
  optimizationProfile?: OptimizationProfile;
  schedulerMode?: SchedulerMode;
  runtimeProfileStore?: string;
  maxInFlightTokens?: number;
}

export interface BookDoctorReport {
  schema: "v5-book-doctor-1";
  sourceVersion: string;
  sourceChars: number;
  coveredChars: number;
  annotationCount: number;
  blockCount: number;
  windowCount: number;
  incidentCodes: string[];
  sourceAnomalies: SourceAnomalyReport;
  modelCallsAllowed: false;
  glossary?: GlossaryImportReport;
}

type RuntimeAwareBookRunOptions = LosslessBookRunOptions & {
  runtimeSet: TranslationRuntimeSet;
};

export interface CliRuntimeDependencies {
  createModel: typeof createDeepSeekModel;
  createStreamFn: typeof createDeepSeekStreamFn;
  createRuntimeProfileStore?: (path: string) => RuntimeProfileStore;
  runBook?: (options: RuntimeAwareBookRunOptions) => Promise<LosslessBookRunResult>;
}

export interface CliErrorPayload {
  schema: "v5-book-cli-error-1";
  code: string;
  message: string;
  retryable?: boolean;
}

class CliCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CliCommandError";
    this.code = code;
  }
}

export function cliErrorPayload(error: unknown): CliErrorPayload {
  const structured = error !== null && typeof error === "object"
    ? error as { code?: unknown; retryable?: unknown }
    : {};
  const code = typeof structured.code === "string" && structured.code.trim().length > 0
    ? structured.code
    : error instanceof SourceIntegrityError || error instanceof CliCommandError
      ? error.code
      : "CLI_ERROR";
  return {
    schema: "v5-book-cli-error-1",
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof structured.retryable === "boolean"
      ? { retryable: structured.retryable }
      : {}),
  };
}

export function doctorBook(
  manifestPath: string,
  windowOptions: WindowPlanOptions = {},
  glossaryPath?: string,
): BookDoctorReport {
  const ledger = SourceLedger.open(manifestPath);
  const annotations = annotateStructure(ledger, ledger.sourceVersion, ledger.languageProfile);
  const blocks = buildLosslessBlocks(ledger, annotations, {
    sourceVersion: ledger.sourceVersion,
  });
  const audit = auditSourceCoverage(ledger, blocks, {
    sourceVersion: ledger.sourceVersion,
  });
  const windows = planBookWindows(blocks, windowOptions);
  return {
    schema: "v5-book-doctor-1",
    sourceVersion: ledger.sourceVersion,
    sourceChars: audit.sourceChars,
    coveredChars: audit.coveredChars,
    annotationCount: annotations.length,
    blockCount: blocks.length,
    windowCount: windows.length,
    incidentCodes: [...new Set(audit.incidents.map((incident) => incident.code))].sort(),
    sourceAnomalies: analyzeSourceAnomalies(ledger.sourceText),
    modelCallsAllowed: false,
    ...(glossaryPath === undefined ? {} : {
      glossary: loadGlossary({
        glossaryPath,
        blocks,
        profile: ledger.languageProfile,
      }).report,
    }),
  };
}

function loadGlossaryForManifest(options: {
  manifestPath: string;
  legacyV4DbPath?: string;
  glossaryPath: string;
}): LoadedGlossary {
  const context = BookContext.openLossless({
    manifestPath: options.manifestPath,
    ...(options.legacyV4DbPath === undefined
      ? {}
      : { legacyV4DbPath: options.legacyV4DbPath }),
  });
  try {
    return loadGlossary({
      glossaryPath: options.glossaryPath,
      blocks: context.losslessBlocks,
      profile: context.languageProfile,
      existingStableTerms: context.stableTerms,
    });
  } finally {
    context.close();
  }
}

export function resolveRunSelection(
  store: LosslessBookStore,
  explicitRunId: string | undefined,
  mode: "run" | "read",
): string | undefined {
  const runs = store.listTranslationRuns();
  if (explicitRunId !== undefined) {
    if (!runs.some((run) => run.runId === explicitRunId)) {
      throw new Error(`unknown translation run ${explicitRunId}`);
    }
    return explicitRunId;
  }
  if (mode === "run") {
    const unfinished = runs.filter((run) => run.status === "created" || run.status === "running");
    if (unfinished.length === 0) {
      return undefined;
    }
    if (unfinished.length === 1) {
      return unfinished[0]!.runId;
    }
    throw new Error("multiple unfinished runs require explicit --run");
  }
  if (runs.length !== 1) {
    throw new Error(
      `status/export requires --run when the store contains ${runs.length} candidate runs`,
    );
  }
  return runs[0]!.runId;
}

function parseIndexes(value: string): number[] {
  const result: number[] = [];
  for (const part of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    if (match === null) {
      throw new Error(`invalid --global-index value: ${value}`);
    }
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (end < start || end - start > 10_000) {
      throw new Error(`invalid --global-index range: ${part}`);
    }
    for (let index = start; index <= end; index += 1) {
      result.push(index);
    }
  }
  return [...new Set(result)].sort((left, right) => left - right);
}

function positiveFlag(
  values: ReadonlyMap<string, string>,
  name: string,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function runModeFlag(
  values: ReadonlyMap<string, string>,
  name: string,
): TranslationRunMode {
  const raw = values.get(name);
  if (raw === undefined) {
    return "quality";
  }
  if (raw !== "quality" && raw !== "fast") {
    throw new Error(`${name} must be quality or fast`);
  }
  return raw;
}

function optimizationProfileFlag(
  values: ReadonlyMap<string, string>,
  name: string,
): OptimizationProfile | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  if (raw !== "economy" && raw !== "balanced" && raw !== "speed") {
    throw new Error(`${name} must be economy, balanced, or speed`);
  }
  return raw;
}

function schedulerModeFlag(
  values: ReadonlyMap<string, string>,
  name: string,
): SchedulerMode {
  const raw = values.get(name);
  if (raw === undefined) return "off";
  if (raw !== "off" && raw !== "shadow" && raw !== "active") {
    throw new Error(`${name} must be off, shadow, or active`);
  }
  return raw;
}

function runModeForProfile(profile: OptimizationProfile): TranslationRunMode {
  return profile === "speed" ? "fast" : "quality";
}

function parseFlags(
  argv: readonly string[],
  context: string,
  valueNames: readonly string[],
  booleanNames: readonly string[] = [],
): {
  values: Map<string, string>;
  booleans: Set<string>;
} {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const allowedValues = new Set(valueNames);
  const allowedBooleans = new Set(booleanNames);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    if (!allowedValues.has(argument) && !allowedBooleans.has(argument)) {
      throw new Error(`unknown flag for ${context}: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new Error(`duplicate flag: ${argument}`);
    }
    seen.add(argument);
    if (allowedBooleans.has(argument)) {
      booleans.add(argument);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return { values, booleans };
}

function identifierValue(
  values: ReadonlyMap<string, string>,
  name: string,
  required = false,
): string | undefined {
  const value = values.get(name);
  if (value === undefined) {
    if (required) {
      throw new Error(`missing ${name}`);
    }
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(`${name} must be nonempty`);
  }
  return value;
}

function incidentCodeValue(
  values: ReadonlyMap<string, string>,
  name: string,
): IncidentCode {
  const value = identifierValue(values, name, true) as string;
  if (!isIncidentCode(value)) {
    throw new Error(`unknown recovery incident code: ${value}`);
  }
  return value;
}

function pathValue(
  values: ReadonlyMap<string, string>,
  name: string,
  required = true,
): string | undefined {
  const value = values.get(name);
  if (value === undefined) {
    if (required) {
      throw new Error(`missing ${name}`);
    }
    return undefined;
  }
  return resolve(value);
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>) };
  }
  return metadata === undefined ? {} : { userMetadata: metadata };
}

function hasStyleProfileMetadata(metadata: unknown): boolean {
  return metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && typeof (metadata as Record<string, unknown>).styleProfileHash === "string";
}

function glossaryHashFromMetadata(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>).glossaryHash;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function runMetadataForStyle(
  style: LoadedStyleProfile,
  previousMetadata: unknown | undefined,
): unknown {
  if (previousMetadata === undefined) {
    return {
      createdBy: "book-cli",
      ...(style.profileHash === undefined ? {} : {
        styleProfileHash: style.profileHash,
        styleProfileSource: style.source,
      }),
    };
  }
  if (style.profileHash === undefined) {
    if (hasStyleProfileMetadata(previousMetadata)) {
      throw new Error(
        "resuming a style-configured run requires the same --style-profile and/or --prompt",
      );
    }
    return previousMetadata;
  }
  return {
    ...metadataRecord(previousMetadata),
    styleProfileHash: style.profileHash,
    styleProfileSource: style.source,
  };
}

function glossarySummary(glossary: LoadedGlossary): Record<string, unknown> {
  return {
    schema: glossary.report.schema,
    termCount: glossary.report.totalTerms,
    formCount: glossary.report.totalForms,
    matchedTerms: glossary.report.matchedTerms,
    unmatchedTerms: glossary.report.unmatchedTerms,
    sourceLanguage: glossary.report.sourceLanguage,
  };
}

function runMetadataForGlossary(
  glossary: LoadedGlossary | undefined,
  previousMetadata: unknown | undefined,
): unknown {
  const previousHash = glossaryHashFromMetadata(previousMetadata);
  if (previousMetadata === undefined) {
    return {
      createdBy: "book-cli",
      ...(glossary === undefined ? {} : {
        glossaryHash: glossary.hash,
        glossarySummary: glossarySummary(glossary),
      }),
    };
  }
  if (glossary === undefined) {
    if (previousHash !== undefined) {
      throw new Error("resuming a glossary-configured run requires the same --glossary");
    }
    return previousMetadata;
  }
  if (previousHash === undefined) {
    throw new Error("resuming a run without a glossary cannot add --glossary");
  }
  if (previousHash !== glossary.hash) {
    throw new Error("resuming a glossary-configured run requires the same glossary content");
  }
  return {
    ...metadataRecord(previousMetadata),
    glossaryHash: glossary.hash,
    glossarySummary: glossarySummary(glossary),
  };
}

function runMetadataForScheduler(
  metadata: unknown,
  profile: OptimizationProfile,
  schedulerMode: SchedulerMode,
  resuming: boolean,
): unknown {
  const existing = metadataRecord(metadata);
  const storedProfile = existing.optimizationProfile;
  const storedMode = existing.schedulerMode;
  if (resuming && storedProfile === undefined && storedMode === undefined) {
    if (schedulerMode !== "off") {
      throw new Error(
        "legacy translation runs can only resume with scheduler mode off",
      );
    }
    return metadata;
  }
  if (storedProfile !== undefined && storedProfile !== profile) {
    throw new Error(
      `translation run optimization profile is ${String(storedProfile)}, not ${profile}`,
    );
  }
  if (storedMode !== undefined && storedMode !== schedulerMode) {
    throw new Error(
      `translation run scheduler mode is ${String(storedMode)}, not ${schedulerMode}`,
    );
  }
  return {
    ...existing,
    optimizationProfile: profile,
    schedulerMode,
  };
}

export function parseArgs(argv: readonly string[]): CliOptions {
  if (argv[0] === "preview") {
    const { values, booleans } = parseFlags(
      argv.slice(1),
      "preview",
      ["--db", "--config", "--output", "--global-index", "--opencode-auth"],
      ["--preflight-only"],
    );
    return {
      command: "preview",
      db: pathValue(values, "--db"),
      config: pathValue(values, "--config"),
      output: pathValue(values, "--output"),
      globalIndexes: parseIndexes(values.get("--global-index") ?? ""),
      preflightOnly: booleans.has("--preflight-only"),
      ...(pathValue(values, "--opencode-auth", false) === undefined
        ? {}
        : { openCodeAuth: pathValue(values, "--opencode-auth", false) }),
    };
  }
  if (argv[0] !== "book" || argv[1] === undefined) {
    throw new Error(
      "usage: pilot preview ... | pilot book preflight|doctor|audit|recover|verify-export|migrate-v1|run|status|export ...",
    );
  }
  const action = argv[1];
  if (action === "preflight") {
    const { values } = parseFlags(
      argv.slice(2),
      "book preflight",
      ["--db", "--max-blocks", "--max-source-tokens"],
    );
    return {
      command: "book-preflight",
      db: pathValue(values, "--db"),
      maxBlocks: positiveFlag(values, "--max-blocks"),
      maxSourceTokens: positiveFlag(values, "--max-source-tokens"),
    };
  }
  if (action === "doctor") {
    const { values } = parseFlags(
      argv.slice(2),
      "book doctor",
      ["--manifest", "--max-blocks", "--max-source-tokens", "--glossary"],
    );
    const maxBlocks = positiveFlag(values, "--max-blocks");
    const maxSourceTokens = positiveFlag(values, "--max-source-tokens");
    return {
      command: "book-doctor",
      manifest: pathValue(values, "--manifest"),
      ...(maxBlocks === undefined ? {} : { maxBlocks }),
      ...(maxSourceTokens === undefined ? {} : { maxSourceTokens }),
      ...(pathValue(values, "--glossary", false) === undefined
        ? {}
        : { glossary: pathValue(values, "--glossary", false) }),
    };
  }
  if (action === "audit") {
    const { values } = parseFlags(
      argv.slice(2),
      "book audit",
      ["--store", "--run"],
    );
    return {
      command: "book-audit",
      store: pathValue(values, "--store"),
      runId: identifierValue(values, "--run", true),
    };
  }
  if (action === "recover") {
    const { values } = parseFlags(
      argv.slice(2),
      "book recover",
      [
        "--store", "--run", "--incident", "--manifest", "--config",
        "--opencode-auth", "--hard-deadline-ms",
      ],
    );
    const config = pathValue(values, "--config", false);
    const openCodeAuth = pathValue(values, "--opencode-auth", false);
    const hardDeadlineMs = positiveFlag(values, "--hard-deadline-ms");
    const incidentCode = incidentCodeValue(values, "--incident");
    const manifest = pathValue(values, "--manifest", false);
    const planStrategies = new Set([
      "flat_partition_rebuild",
      "rebuild_affected_span",
      "rebuild_window_membership",
      "replan_affected_windows",
      "split_window_boundaries",
    ]);
    const recoveryRule = projectRecoveryRule(incidentCode);
    if ((recoveryRule.deterministic !== null
      && planStrategies.has(recoveryRule.deterministic))
      || recoveryRule.allowed.some((strategy) => planStrategies.has(strategy))) {
      if (manifest === undefined) {
        throw new Error(`--manifest is required for ${incidentCode} recovery`);
      }
    }
    if (openCodeAuth !== undefined && config === undefined) {
      throw new Error("--opencode-auth requires --config for book recover");
    }
    return {
      command: "book-recover",
      store: pathValue(values, "--store"),
      runId: identifierValue(values, "--run", true),
      incidentCode,
      ...(manifest === undefined ? {} : { manifest }),
      ...(config === undefined ? {} : { config }),
      ...(openCodeAuth === undefined ? {} : { openCodeAuth }),
      ...(hardDeadlineMs === undefined ? {} : { hardDeadlineMs }),
    };
  }
  if (action === "verify-export") {
    const { values } = parseFlags(
      argv.slice(2),
      "book verify-export",
      ["--store", "--run", "--output", "--epub"],
    );
    const epub = pathValue(values, "--epub", false);
    return {
      command: "book-verify-export",
      store: pathValue(values, "--store"),
      runId: identifierValue(values, "--run", true),
      output: pathValue(values, "--output"),
      ...(epub === undefined ? {} : { epub }),
    };
  }
  if (action === "migrate-v1") {
    const { values } = parseFlags(
      argv.slice(2),
      "book migrate-v1",
      ["--legacy-store", "--manifest", "--store"],
    );
    return {
      command: "book-migrate-v1",
      legacyStore: pathValue(values, "--legacy-store"),
      manifest: pathValue(values, "--manifest"),
      store: pathValue(values, "--store"),
    };
  }
  if (action === "run") {
    const { values } = parseFlags(
      argv.slice(2),
      "book run",
      [
        "--manifest", "--v4-db", "--store", "--config", "--output",
        "--opencode-auth", "--run", "--max-windows", "--max-concurrency",
        "--max-attempts", "--max-blocks", "--max-source-tokens",
        "--hard-deadline-ms", "--style-profile", "--prompt",
        "--glossary", "--run-mode", "--max-in-flight-tokens",
        "--optimization-profile", "--scheduler-mode",
        "--runtime-profile-store",
      ],
    );
    const explicitProfile = optimizationProfileFlag(
      values,
      "--optimization-profile",
    );
    const explicitRunMode = values.has("--run-mode");
    const runMode = explicitRunMode
      ? runModeFlag(values, "--run-mode")
      : explicitProfile === undefined
        ? "quality"
        : runModeForProfile(explicitProfile);
    const legacyProfile = profileFromLegacyRunMode(runMode);
    if (explicitRunMode
      && explicitProfile !== undefined
      && runModeForProfile(explicitProfile) !== runMode) {
      throw new Error(
        `optimization profile ${explicitProfile} conflicts with run mode ${runMode}`,
      );
    }
    return {
      command: "book-run",
      manifest: pathValue(values, "--manifest"),
      legacyV4Db: pathValue(values, "--v4-db", false),
      store: pathValue(values, "--store"),
      config: pathValue(values, "--config"),
      output: pathValue(values, "--output", false),
      openCodeAuth: pathValue(values, "--opencode-auth", false),
      runId: identifierValue(values, "--run"),
      maxWindows: positiveFlag(values, "--max-windows"),
      maxConcurrency: positiveFlag(values, "--max-concurrency"),
      runMode,
      optimizationProfile: explicitProfile ?? legacyProfile,
      schedulerMode: schedulerModeFlag(values, "--scheduler-mode"),
      runtimeProfileStore: pathValue(
        values,
        "--runtime-profile-store",
        false,
      ),
      maxInFlightTokens: positiveFlag(values, "--max-in-flight-tokens"),
      maxAttempts: positiveFlag(values, "--max-attempts"),
      hardDeadlineMs: positiveFlag(values, "--hard-deadline-ms"),
      maxBlocks: positiveFlag(values, "--max-blocks"),
      maxSourceTokens: positiveFlag(values, "--max-source-tokens"),
      styleProfile: pathValue(values, "--style-profile", false),
      prompt: identifierValue(values, "--prompt"),
      glossary: pathValue(values, "--glossary", false),
    };
  }
  if (action === "status") {
    const { values } = parseFlags(
      argv.slice(2),
      "book status",
      ["--store", "--run"],
    );
    return {
      command: "book-status",
      store: pathValue(values, "--store"),
      runId: identifierValue(values, "--run"),
    };
  }
  if (action === "export") {
    const { values, booleans } = parseFlags(
      argv.slice(2),
      "book export",
      ["--store", "--output", "--run"],
      ["--allow-incomplete"],
    );
    return {
      command: "book-export",
      store: pathValue(values, "--store"),
      output: pathValue(values, "--output"),
      runId: identifierValue(values, "--run"),
      allowIncomplete: booleans.has("--allow-incomplete"),
    };
  }
  throw new Error(`unknown book action: ${action}`);
}

function requireOption(options: CliOptions, name: keyof CliOptions): string {
  const value = options[name];
  if (typeof value !== "string") {
    throw new Error(`missing ${String(name)}`);
  }
  return value;
}

function loadRuntimeConfig(options: CliOptions) {
  const baseConfig = loadPilotConfig(requireOption(options, "config"), "draft");
  return options.openCodeAuth === undefined
    ? baseConfig
    : loadPilotConfig(requireOption(options, "config"), "draft", {
      apiKeyOverride: loadOpenCodeApiKey(options.openCodeAuth, baseConfig.provider),
    });
}

/**
 * Project one credential-bearing config into the immutable runtime choices for
 * a translation run.  Only model/stream closures enter this object; it is not
 * serialized or persisted by the CLI.
 */
export function buildTranslationRuntimeSet(
  config: PilotModelConfig,
  mode: TranslationRunMode,
  factories: Pick<CliRuntimeDependencies, "createModel" | "createStreamFn">,
): TranslationRuntimeSet {
  const makeRuntime = (candidate: PilotModelConfig) => ({
    // `withReasoningEffort` is the validation boundary for both source and
    // derived configs, so this narrow cast cannot introduce an unchecked wire value.
    effort: candidate.reasoningEffort as ProviderEffort,
    model: factories.createModel(candidate),
    streamFn: factories.createStreamFn(candidate),
    thinkingLevel: candidate.reasoningEffort === "off"
      ? "off" as const
      : toInternalThinking(candidate.reasoningEffort as ProviderEffort),
  });
  const qualityConfig = withReasoningEffort(config, config.reasoningEffort);
  const supportedEfforts =
    providerRegistry.get("deepseek").capabilities.efforts;
  if (!supportedEfforts.includes(
    qualityConfig.reasoningEffort as ProviderEffort,
  )) {
    throw new TypeError(
      `deepseek does not support reasoning effort: ${qualityConfig.reasoningEffort}`,
    );
  }
  const variantsByEffort = new Map(
    supportedEfforts.map((effort) => [
      effort,
      makeRuntime(withReasoningEffort(qualityConfig, effort)),
    ]),
  );
  const primaryEffort = mode === "fast"
    ? "off"
    : qualityConfig.reasoningEffort as ProviderEffort;
  const primary = variantsByEffort.get(primaryEffort);
  const escalation = variantsByEffort.get(
    qualityConfig.reasoningEffort as ProviderEffort,
  );
  if (primary === undefined || escalation === undefined) {
    throw new TypeError("translation runtime variants are incomplete");
  }
  return {
    mode,
    primary,
    escalation,
    variants: validateRuntimeVariants([...variantsByEffort.values()]),
  };
}

export async function main(
  argv = process.argv.slice(2),
  dependencyOverrides: Partial<CliRuntimeDependencies> = {},
): Promise<void> {
  const options = parseArgs(argv);
  if (options.command === "book-preflight") {
    console.log(JSON.stringify(preflightBook(requireOption(options, "db"), {
      maxBlocks: options.maxBlocks,
      maxSourceTokens: options.maxSourceTokens,
    }), null, 2));
    return;
  }
  if (options.command === "book-doctor") {
    console.log(JSON.stringify(doctorBook(requireOption(options, "manifest"), {
      maxBlocks: options.maxBlocks,
      maxSourceTokens: options.maxSourceTokens,
    }, options.glossary), null, 2));
    return;
  }
  if (options.command === "book-audit") {
    const store = new LosslessBookStore(requireOption(options, "store"));
    try {
      const report = auditLosslessBookStore(
        store,
        requireOption(options, "runId"),
      );
      console.log(JSON.stringify(report, null, 2));
      if (report.incidentCodes.length > 0) {
        throw new CliCommandError(
          "BOOK_AUDIT_FAILED",
          `integrity incidents: ${report.incidentCodes.join(",")}`,
        );
      }
    } finally {
      store.close();
    }
    return;
  }
  if (options.command === "book-migrate-v1") {
    console.log(JSON.stringify(importLegacyV1({
      legacyStorePath: requireOption(options, "legacyStore"),
      manifestPath: requireOption(options, "manifest"),
      storePath: requireOption(options, "store"),
    }), null, 2));
    return;
  }
  if (options.command === "book-verify-export") {
    const store = new LosslessBookStore(requireOption(options, "store"));
    try {
      const runId = requireOption(options, "runId");
      const audit = auditLosslessBookStore(store, runId);
      const paths = losslessBookArtifactPaths(
        requireOption(options, "output"),
        audit.complete,
      );
      const result = verifyExport(
        options.epub === undefined ? paths : { ...paths, epub: options.epub },
        store,
        runId,
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        throw new CliCommandError(
          "BOOK_EXPORT_VERIFICATION_FAILED",
          `export incidents: ${result.incidentCodes.join(",")}`,
        );
      }
    } finally {
      store.close();
    }
    return;
  }
  if (options.command === "book-recover") {
    const storePath = requireOption(options, "store");
    const runId = requireOption(options, "runId");
    const incidentCode = options.incidentCode;
    if (incidentCode === undefined) {
      throw new Error("missing incidentCode");
    }
    const store = new LosslessBookStore(storePath);
    let recoveryContext: BookContext | undefined;
    try {
      const incident = createStoreRecoveryIncident(
        store,
        runId,
        incidentCode,
        loadAttemptedRecoveryStrategies(storePath, runId, incidentCode),
      );
      const rule = projectRecoveryRule(incidentCode, incident.attemptedStrategies);
      if (options.manifest !== undefined) {
        recoveryContext = BookContext.openLossless({ manifestPath: options.manifest });
      }
      let planner: RecoveryAgent | undefined;
      if (rule.deterministic === null
        && rule.allowed.length > 0
        && rule.maxAttempts === 1
        && options.config !== undefined) {
        const recoveryRuntime: CliRuntimeDependencies = {
          createModel: dependencyOverrides.createModel ?? createDeepSeekModel,
          createStreamFn: dependencyOverrides.createStreamFn ?? createDeepSeekStreamFn,
        };
        const config = loadRuntimeConfig(options);
        planner = new RecoveryAgent(new PiRuntime(), {
          model: recoveryRuntime.createModel(config),
          streamFn: recoveryRuntime.createStreamFn(config),
          budget: new BudgetLedger({
            modelCalls: 1,
            recoveryTurns: 1,
            recoveryToolCalls: 5,
          }),
          deadlineMs: options.hardDeadlineMs,
        });
      }
      const result = await new RecoveryEngine({
        kernel: new StoreRecoveryKernel(store, storePath, recoveryContext === undefined
          ? undefined
          : {
              sourceText: recoveryContext.sourceLedger.sourceText,
              certifiedSource: recoveryContext.certifiedSource!,
              annotations: recoveryContext.annotations,
              rawHashVerified: true,
            }),
        ...(planner === undefined ? {} : { planner }),
      }).recover(incident);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      recoveryContext?.close();
      store.close();
    }
    return;
  }
  if (options.command === "book-status") {
    const store = new LosslessBookStore(requireOption(options, "store"));
    try {
      const runId = resolveRunSelection(store, options.runId, "read") as string;
      const state = store.auditState(runId);
      console.log(JSON.stringify({
        schema: "v5-book-status-1",
        runId,
        sourceVersion: state.sourceVersion,
        protocolVersion: state.protocolVersion,
        modelId: state.modelId,
        runMetadata: state.runMetadata,
        status: store.statusSummary(runId),
        windows: store.allWindows(runId),
      }, null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (options.command === "book-export") {
    const store = new LosslessBookStore(requireOption(options, "store"));
    try {
      const runId = resolveRunSelection(store, options.runId, "read") as string;
      console.log(JSON.stringify(writeLosslessBookArtifacts(
        store,
        runId,
        requireOption(options, "output"),
        { allowIncomplete: options.allowIncomplete },
      ), null, 2));
    } finally {
      store.close();
    }
    return;
  }

  const runtime: CliRuntimeDependencies = {
    createModel: dependencyOverrides.createModel ?? createDeepSeekModel,
    createStreamFn: dependencyOverrides.createStreamFn ?? createDeepSeekStreamFn,
  };
  if (options.command === "book-run") {
    const selectionStore = new LosslessBookStore(requireOption(options, "store"));
    let selectedRunId: string | undefined;
    let selectedRun: ReturnType<LosslessBookStore["listTranslationRuns"]>[number] | undefined;
    try {
      selectedRunId = resolveRunSelection(selectionStore, options.runId, "run");
      selectedRun = selectionStore.listTranslationRuns()
        .find((run) => run.runId === selectedRunId);
    } finally {
      selectionStore.close();
    }
    const style = loadStyleProfile({
      ...(options.styleProfile === undefined ? {} : { profilePath: options.styleProfile }),
      ...(options.prompt === undefined ? {} : { cliPrompt: options.prompt }),
    });
    const glossary = options.glossary === undefined
      ? undefined
      : loadGlossaryForManifest({
        manifestPath: requireOption(options, "manifest"),
        ...(options.legacyV4Db === undefined
          ? {}
          : { legacyV4DbPath: options.legacyV4Db }),
        glossaryPath: options.glossary,
      });
    const baseRunMetadata = runMetadataForStyle(
      style,
      runMetadataForGlossary(glossary, selectedRun?.metadata),
    );
    const optimizationProfile = options.optimizationProfile
      ?? profileFromLegacyRunMode(options.runMode ?? "quality");
    const schedulerMode = options.schedulerMode ?? "off";
    const runMetadata = runMetadataForScheduler(
      baseRunMetadata,
      optimizationProfile,
      schedulerMode,
      selectedRun !== undefined,
    );
    const config = loadRuntimeConfig(options);
    const runtimeSet = buildTranslationRuntimeSet(
      config,
      options.runMode ?? "quality",
      runtime,
    );
    const bookRunner = dependencyOverrides.runBook
      ?? ((runOptions: RuntimeAwareBookRunOptions) => runBook(runOptions));
    const runId = selectedRunId ?? randomUUID();
    const profileStorePath = options.runtimeProfileStore
      ?? join(homedir(), ".folioloom", "runtime-profiles.db");
    mkdirSync(dirname(profileStorePath), { recursive: true });
    const runtimeProfileStore =
      dependencyOverrides.createRuntimeProfileStore?.(profileStorePath)
      ?? new RuntimeProfileStore(profileStorePath);
    let result: LosslessBookRunResult;
    try {
      result = await bookRunner({
        manifestPath: requireOption(options, "manifest"),
        ...(options.legacyV4Db === undefined ? {} : { legacyV4DbPath: options.legacyV4Db }),
        storePath: requireOption(options, "store"),
        runMeta: selectedRun === undefined
          ? {
              runId,
              protocolVersion: LOSSLESS_BOOK_PROTOCOL_VERSION,
              modelId: config.model,
              metadata: runMetadata,
            }
          : {
              runId,
              protocolVersion: selectedRun.protocolVersion,
              modelId: selectedRun.modelId,
              metadata: runMetadata,
            },
        model: runtimeSet.primary.model,
        streamFn: runtimeSet.primary.streamFn,
        runtimeSet,
        optimizationProfile,
        schedulerMode,
        runtimeProfileStore,
        styleState: style.styleState,
        ...(glossary === undefined ? {} : { glossary }),
        windowOptions: {
          maxBlocks: options.maxBlocks,
          maxSourceTokens: options.maxSourceTokens,
        },
        maxWindows: options.maxWindows,
        maxConcurrency: options.maxConcurrency,
        maxInFlightTokens: options.maxInFlightTokens,
        maxAttempts: options.maxAttempts,
        hardDeadlineMs: options.hardDeadlineMs,
      });
    } finally {
      runtimeProfileStore.close();
    }
    if (result.scheduler !== undefined) {
      const schedulerStore = new LosslessBookStore(
        requireOption(options, "store"),
      );
      try {
        const durableScheduler = schedulerStore.loadSchedulerMetrics(runId, {
          mode: schedulerMode,
          profile: optimizationProfile,
          tokenIncreaseCap:
            optimizationPolicy(optimizationProfile).tokenIncreaseCap,
          enforceDispatchLifecycle: true,
        });
        if (durableScheduler !== undefined) {
          result = {
            ...result,
            scheduler: durableScheduler,
          };
        }
      } finally {
        schedulerStore.close();
      }
    }
    let artifacts: BookArtifactPaths | null = result.artifacts;
    if (options.output !== undefined) {
      const store = new LosslessBookStore(requireOption(options, "store"));
      try {
        artifacts = writeLosslessBookArtifacts(store, runId, options.output, {
          allowIncomplete: true,
          scheduler: result.scheduler,
        });
      } finally {
        store.close();
      }
    }
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
    return;
  }

  const config = loadRuntimeConfig(options);
  const model = runtime.createModel(config);
  const streamFn = runtime.createStreamFn(config);
  const db = requireOption(options, "db");
  const indexes = options.globalIndexes ?? [];
  const preflight = preflightPilot(db, indexes);
  console.log(JSON.stringify({
    mode: "cold-preview",
    ...preflight,
    model: config.toJSON(),
  }, null, 2));
  if (options.preflightOnly) {
    return;
  }
  const result = await runPilot({
    dbPath: db,
    outputDir: requireOption(options, "output"),
    globalIndexes: indexes,
    model,
    streamFn,
  });
  console.log(JSON.stringify({
    status: result.status,
    translations: result.translations.length,
    metrics: result.metrics,
    artifacts: result.artifacts,
  }, null, 2));
}

const entry = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify(cliErrorPayload(error)));
    process.exitCode = 1;
  });
}
