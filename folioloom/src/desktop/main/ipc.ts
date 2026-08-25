import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

import type {
  DesktopChooseSourceResult,
  DesktopChooseSourceRequest,
  DesktopConfirmSourceEncodingRequest,
  DesktopDoctorReport,
  DesktopDiagnosticExportResult,
  DesktopExportDestination,
  DesktopExportFormat,
  DesktopExportRequest,
  DesktopExportResult,
  DesktopExportSnapshot,
  DesktopFullBookSnapshot,
  DesktopResumeFullBookRequest,
  DesktopStartFullBookRequest,
  DesktopAttachGlobalKnowledgeRequest,
  DesktopGlobalKnowledgeListRequest,
  DesktopGlobalKnowledgePage,
  DesktopKnowledgeDetail,
  DesktopKnowledgeDiagnostics,
  DesktopKnowledgeListRequest,
  DesktopKnowledgeMutationRequest,
  DesktopKnowledgeMutationResult,
  DesktopKnowledgePage,
  DesktopPromoteKnowledgeRequest,
  DesktopSuggestKnowledgeImportRequest,
  PendingKnowledgeImport,
  InspectImportRequest,
  ConfirmImportEncodingRequest,
  ImportInspectionResult,
  ImportSelection,
  MappingSuggestion,
  StageImportRequest,
  StagedImportReport,
  StagedImportSummary,
  StagedImportPageRequest,
  ImportDecisionRequest,
  CommitImportRequest,
  CommittedImportReport,
  RollbackImportRequest,
  RolledBackImportReport,
  CancelImportOperationRequest,
  DiscardStagedImportRequest,
  DesktopModelOption,
  DesktopModelProbe,
  DesktopModelSummary,
  DesktopOnboardingProvider,
  DesktopOnboardingState,
  DesktopProjectRequest,
  DesktopProjectSnapshot,
  DesktopResult,
  DesktopStartTrialRequest,
  DesktopTestModelResult,
  DesktopTrialMode,
  DesktopTrialResult,
} from "../contracts.js";
import type {
  DesktopDiscoverModelsRequest as ServiceDiscoverModelsRequest,
  DesktopTestModelRequest as ServiceTestModelRequest,
} from "../desktop-model-service.js";
import type {
  DesktopConfirmEncodingRequest,
  DesktopSourceEncodingRequiredResult,
  DesktopSourceImportRequest,
  DesktopSourceReadyResult,
} from "../desktop-source-service.js";
import type { ProviderEffort, ProviderId } from "../../providers/types.js";
import {
  validateKnowledgeCommand,
  type KnowledgeObjectType,
} from "../../knowledge/knowledge-commands.js";
import { knowledgeImportFields } from "../../knowledge-import/field-mapping.js";
import { MAX_STAGED_IMPORT_PAGE_SIZE } from "../../knowledge-import/types.js";
import { DesktopInputError, fail, ok, toDesktopError } from "../desktop-errors.js";
import type {
  DesktopDiagnosticEventInput,
  DesktopDiagnosticFailureInput,
} from "../desktop-diagnostics.js";

export const DESKTOP_IPC_CHANNELS = [
  "folioloom:choose-source",
  "folioloom:confirm-source-encoding",
  "folioloom:onboarding-state",
  "folioloom:discover-models",
  "folioloom:test-model",
  "folioloom:forget-credential",
  "folioloom:start-trial",
  "folioloom:cancel-trial",
  "folioloom:fullbook-state",
  "folioloom:start-fullbook",
  "folioloom:pause-fullbook",
  "folioloom:resume-fullbook",
  "folioloom:export-state",
  "folioloom:choose-export-directory",
  "folioloom:export-book",
  "folioloom:open-export-directory",
  "folioloom:copy-diagnostic-summary",
  "folioloom:export-diagnostics",
  "folioloom:knowledge-list",
  "folioloom:knowledge-detail",
  "folioloom:knowledge-mutate",
  "folioloom:knowledge-promote-global",
  "folioloom:knowledge-global-list",
  "folioloom:knowledge-global-attach",
  "folioloom:knowledge-diagnostics",
  "folioloom:knowledge-import-choose",
  "folioloom:knowledge-import-inspect",
  "folioloom:knowledge-import-confirm-encoding",
  "folioloom:knowledge-import-list-staged",
  "folioloom:knowledge-import-get-staged",
  "folioloom:knowledge-import-suggest",
  "folioloom:knowledge-import-stage",
  "folioloom:knowledge-import-decide",
  "folioloom:knowledge-import-commit",
  "folioloom:knowledge-import-rollback",
  "folioloom:knowledge-import-cancel-operation",
  "folioloom:knowledge-import-cancel-pending",
  "folioloom:knowledge-import-discard-staged",
  // Legacy project controls remain for existing developer workspaces.
  "folioloom:choose-project",
  "folioloom:choose-store",
  "folioloom:refresh-project",
  "folioloom:select-run",
  "folioloom:doctor",
] as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[number];
export type DesktopIpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

export interface DesktopIpcMain {
  handle(channel: DesktopIpcChannel, handler: DesktopIpcHandler): void;
}

export interface DesktopOpenDialogOptions {
  properties: Array<"openFile" | "openDirectory" | "createDirectory">;
  filters: Array<{ name: string; extensions: string[] }>;
}

export interface DesktopDialog {
  showOpenDialog(options: DesktopOpenDialogOptions): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  showSaveDialog(options: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
}

export interface DesktopIpcDiagnostics {
  record(input: DesktopDiagnosticEventInput): void;
  recordFailure(input: DesktopDiagnosticFailureInput): void;
  copySummary(): void;
  exportReport(path: string): void;
}

export interface DesktopIpcProjectService {
  snapshot(request: DesktopProjectRequest): DesktopResult<DesktopProjectSnapshot>;
  doctor(
    request: Pick<DesktopProjectRequest, "manifestPath" | "glossaryPath">,
  ): DesktopResult<DesktopDoctorReport>;
}

export interface DesktopIpcSourceService {
  importSource(
    request: Pick<DesktopSourceImportRequest, "sourcePath" | "sourceLanguage" | "explicitEncoding">,
  ): Promise<DesktopSourceEncodingRequiredResult | Pick<DesktopSourceReadyResult, "status" | "manifestPath">>;
  confirmEncoding(
    request: DesktopConfirmEncodingRequest,
  ): Promise<Pick<DesktopSourceReadyResult, "status" | "manifestPath">>;
}

export interface DesktopIpcModelSnapshot {
  providers: readonly DesktopOnboardingProvider[];
  activeModelProfile?: {
    providerId: string;
    modelId: string;
    reasoningEffort?: string;
    customBaseUrl?: string;
  };
  latestProbe?: DesktopModelProbe;
}

export interface DesktopIpcModelTestResult {
  report: DesktopModelProbe;
  snapshot: DesktopIpcModelSnapshot;
}

export interface DesktopIpcModelService {
  snapshot(): DesktopIpcModelSnapshot;
  discoverModels(request: ServiceDiscoverModelsRequest): Promise<readonly { id: string; displayName: string }[]>;
  testAndSave(request: ServiceTestModelRequest): Promise<DesktopIpcModelTestResult>;
  forgetCredential(providerId: ProviderId): void;
}

export interface DesktopIpcTrialService {
  start(request: { manifestPath: string; mode: DesktopTrialMode }): Promise<DesktopTrialResult>;
  cancel(): Promise<void>;
}

export interface DesktopIpcFullBookService {
  snapshot(project: DesktopProjectRequest): DesktopFullBookSnapshot;
  start(
    project: DesktopProjectRequest,
    request: DesktopStartFullBookRequest,
  ): Promise<DesktopFullBookSnapshot>;
  pause(): Promise<DesktopFullBookSnapshot>;
  resume(
    project: DesktopProjectRequest,
    request: DesktopResumeFullBookRequest,
  ): Promise<DesktopFullBookSnapshot>;
  hasActiveTask(): boolean;
}

export interface DesktopIpcExportService {
  snapshot(project: DesktopProjectRequest): DesktopExportSnapshot;
  registerDestination(path: string): DesktopExportDestination;
  export(
    project: DesktopProjectRequest,
    request: DesktopExportRequest,
  ): Promise<DesktopExportResult>;
  completedDirectory(exportId: string): string | undefined;
}

export interface DesktopIpcKnowledgeService {
  list(request: DesktopKnowledgeListRequest): DesktopResult<DesktopKnowledgePage>;
  detail(objectId: string): DesktopResult<DesktopKnowledgeDetail>;
  mutate(request: DesktopKnowledgeMutationRequest): DesktopResult<DesktopKnowledgeMutationResult>;
  promoteGlobal(request: DesktopPromoteKnowledgeRequest): DesktopResult<DesktopKnowledgeMutationResult>;
  listGlobal(request: DesktopGlobalKnowledgeListRequest): DesktopResult<DesktopGlobalKnowledgePage>;
  attachGlobal(request: DesktopAttachGlobalKnowledgeRequest): DesktopResult<DesktopKnowledgeMutationResult>;
  diagnostics(): DesktopResult<DesktopKnowledgeDiagnostics>;
}

export interface DesktopIpcKnowledgeImportService {
  registerPending(path: string): PendingKnowledgeImport;
  inspect(request: InspectImportRequest): Promise<ImportInspectionResult>;
  confirmEncoding(request: ConfirmImportEncodingRequest): Promise<ImportInspectionResult>;
  suggestMapping(
    pendingImportId: string,
    selection: ImportSelection,
  ): Promise<MappingSuggestion>;
  stage(request: StageImportRequest): Promise<StagedImportReport>;
  listStaged(): Promise<readonly StagedImportSummary[]>;
  getStaged(request: StagedImportPageRequest): Promise<StagedImportReport>;
  setDecisions(request: ImportDecisionRequest): Promise<StagedImportReport>;
  discardStaged(request: DiscardStagedImportRequest): Promise<void>;
  commit(request: CommitImportRequest): Promise<CommittedImportReport>;
  rollback(request: RollbackImportRequest): Promise<RolledBackImportReport>;
  cancelOperation(request: CancelImportOperationRequest): void;
  cancelPendingImport(pendingImportId: string): void;
}

export interface DesktopIpcDependencies {
  ipcMain: DesktopIpcMain;
  dialog: DesktopDialog;
  projectService: DesktopIpcProjectService;
  sourceService: DesktopIpcSourceService;
  modelService: DesktopIpcModelService;
  trialService: DesktopIpcTrialService;
  fullBookService: DesktopIpcFullBookService;
  exportService: DesktopIpcExportService;
  knowledgeService: DesktopIpcKnowledgeService;
  knowledgeImportService: DesktopIpcKnowledgeImportService;
  diagnostics: DesktopIpcDiagnostics;
  isTrustedEvent(event: unknown): boolean;
  getCurrentRequest(): DesktopProjectRequest | undefined;
  setCurrentRequest(request: DesktopProjectRequest): void;
  openDirectory(path: string): Promise<string>;
}

const manuscriptFilter = [{ name: "书稿", extensions: ["txt", "md", "markdown", "epub", "docx"] }];
const manifestFilter = [{ name: "FolioLoom 项目", extensions: ["json"] }];
const storeFilter = [{ name: "FolioLoom 状态库", extensions: ["db"] }];
const knowledgeImportFilter = [{
  name: "FolioLoom 知识文件",
  extensions: ["json", "yaml", "yml", "csv", "xlsx"],
}];
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SOURCE_ENCODINGS = new Set([
  "utf-8", "utf-16le", "utf-16be", "utf-32le", "utf-32be",
  "shift_jis", "euc-jp", "euc-kr", "windows-949",
  "windows-1252",
]);
const KNOWLEDGE_OBJECT_TYPES = new Set<KnowledgeObjectType>([
  "term", "entity", "alias", "relation", "memory", "style",
]);
const KNOWLEDGE_STATUSES = new Set([
  "candidate", "provisional", "active", "needs_revalidate",
  "contextual", "superseded",
]);
const KNOWLEDGE_ORIGINS = new Set(["model", "manual", "import", "rollback"]);
const KNOWLEDGE_SCOPES = new Set(["book", "project", "global"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_ID = /^[0-9a-f]{64}$/u;
const GLOBAL_RECORD_ID = /^gk_[0-9a-f]{64}$/u;
const IMPORT_SCOPES = new Set(["book", "project"] as const);
const IMPORT_ENCODINGS = new Set([
  "utf-8", "utf-16le", "utf-16be",
  "shift_jis", "euc-jp", "euc-kr", "windows-949",
  "windows-1252",
] as const);
const MAPPING_CONFIDENCE = new Set(["high", "medium", "low"] as const);
const IMPORT_DECISIONS = new Set([
  "keep_existing", "use_imported", "merge_as_alias",
  "create_separate", "skip",
] as const);
const EXPORT_FORMATS = new Set<DesktopExportFormat>([
  "translation_txt",
  "bilingual_txt",
  "epub",
]);
const SOURCE_LANGUAGE_CHOICES: ReadonlySet<string> = new Set([
  "auto", "en", "de", "fr", "es", "ru", "ja", "ko",
] as const);
function failure<T = never>(code: string, message: string): DesktopResult<T> {
  return fail({ code, message, retryable: false });
}

function noOpenProject(): DesktopResult<DesktopProjectSnapshot> {
  return failure("DESKTOP_NO_PROJECT", "open an initialized project first");
}

function canceledSelection(): DesktopResult<never> {
  return failure("DESKTOP_SELECTION_CANCELLED", "no file was selected");
}

function invalidSelection(message: string): DesktopResult<never> {
  return failure("DESKTOP_INPUT_INVALID", message);
}

function untrustedEvent(): DesktopResult<never> {
  return failure("DESKTOP_UNTRUSTED_IPC", "IPC caller is not the trusted FolioLoom renderer");
}

async function resultFrom<T>(
  operation: () => DesktopResult<T> | Promise<DesktopResult<T>>,
): Promise<DesktopResult<T>> {
  return await operation();
}

async function chooseSingleFile(
  dialog: DesktopDialog,
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<string | undefined> {
  const selection = await dialog.showOpenDialog({ properties: ["openFile"], filters });
  return selection.canceled || selection.filePaths.length !== 1
    ? undefined
    : selection.filePaths[0];
}

async function chooseDirectory(
  dialog: DesktopDialog,
): Promise<string | undefined> {
  const selection = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    filters: [],
  });
  return selection.canceled || selection.filePaths.length !== 1
    ? undefined
    : selection.filePaths[0];
}

function isManuscriptPath(path: string): boolean {
  return manuscriptFilter[0].extensions.includes(extname(path).toLocaleLowerCase("en").slice(1));
}

function inputError(message: string): never {
  throw new DesktopInputError("DESKTOP_INPUT_INVALID", message);
}

function oneArgument(args: readonly unknown[], label: string): unknown {
  if (args.length !== 1) {
    return inputError(`${label} requires exactly one payload`);
  }
  return args[0];
}

function noArguments(args: readonly unknown[], label: string): void {
  if (args.length !== 0) {
    inputError(`${label} does not accept a payload`);
  }
}

function chooseSourceRequest(args: readonly unknown[]): DesktopChooseSourceRequest {
  if (args.length === 0) return {};
  const input = exactRecord(
    oneArgument(args, "choose-source"),
    "choose-source",
    ["sourceLanguage"],
  );
  if (
    input.sourceLanguage !== undefined
    && (typeof input.sourceLanguage !== "string"
      || !SOURCE_LANGUAGE_CHOICES.has(input.sourceLanguage))
  ) {
    inputError("choose-source sourceLanguage is not supported");
  }
  return input.sourceLanguage === undefined
    ? {}
    : { sourceLanguage: input.sourceLanguage as DesktopChooseSourceRequest["sourceLanguage"] };
}

function exactRecord(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return inputError(`${label} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    return inputError(`${label} contains an unsupported field`);
  }
  return record;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return inputError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredText(value, label);
}

function boundedText(
  value: unknown,
  label: string,
  maximumScalars: number,
): string {
  const text = requiredText(value, label);
  if ([...text].length > maximumScalars) {
    return inputError(`${label} is too long`);
  }
  return text;
}

function optionalBoundedText(
  value: unknown,
  label: string,
  maximumScalars: number,
): string | undefined {
  return value === undefined
    ? undefined
    : boundedText(value, label, maximumScalars);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return inputError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result < 1) return inputError(`${label} must be positive`);
  return result;
}

function pageLimit(value: unknown): number {
  const limit = positiveInteger(value, "limit");
  if (limit > MAX_STAGED_IMPORT_PAGE_SIZE) {
    return inputError(
      `limit must not exceed ${MAX_STAGED_IMPORT_PAGE_SIZE}`,
    );
  }
  return limit;
}

function enumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: ReadonlySet<T>,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > allowed.size) {
    return inputError(`${label} must be a bounded array`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !allowed.has(item as T)) {
      return inputError(`${label} contains an unsupported value`);
    }
    return item as T;
  });
  if (new Set(result).size !== result.length) {
    return inputError(`${label} contains a duplicate value`);
  }
  return result;
}

function requestId(value: unknown): string {
  const id = requiredText(value, "requestId");
  if (!UUID.test(id)) return inputError("requestId must be a UUID");
  return id;
}

function snapshotId(value: unknown): string {
  const id = requiredText(value, "expectedSnapshotId");
  if (!HASH_ID.test(id)) {
    return inputError("expectedSnapshotId must identify a knowledge snapshot");
  }
  return id;
}

function knowledgeObjectId(value: unknown): string {
  const id = requiredText(value, "objectId");
  if (!HASH_ID.test(id)) return inputError("objectId is invalid");
  return id;
}

function knowledgeListRequest(value: unknown): DesktopKnowledgeListRequest {
  const input = exactRecord(value, "knowledge-list payload", [
    "search", "objectTypes", "statuses", "origins", "scopes", "cursor", "limit",
  ]);
  const search = optionalBoundedText(input.search, "search", 512);
  const cursor = optionalBoundedText(input.cursor, "cursor", 4096);
  const objectTypes = enumArray(
    input.objectTypes,
    "objectTypes",
    KNOWLEDGE_OBJECT_TYPES,
  );
  const statuses = enumArray(input.statuses, "statuses", KNOWLEDGE_STATUSES);
  const origins = enumArray(input.origins, "origins", KNOWLEDGE_ORIGINS);
  const scopes = enumArray(input.scopes, "scopes", KNOWLEDGE_SCOPES);
  return {
    ...(search === undefined ? {} : { search }),
    ...(objectTypes === undefined ? {} : { objectTypes }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(origins === undefined ? {} : { origins }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: pageLimit(input.limit),
  } as DesktopKnowledgeListRequest;
}

function knowledgeMutationRequest(
  value: unknown,
): DesktopKnowledgeMutationRequest {
  const input = exactRecord(value, "knowledge-mutate payload", [
    "requestId", "expectedGeneration", "expectedSnapshotId", "command",
  ]);
  return {
    requestId: requestId(input.requestId),
    expectedGeneration: nonnegativeInteger(
      input.expectedGeneration,
      "expectedGeneration",
    ),
    expectedSnapshotId: snapshotId(input.expectedSnapshotId),
    command: validateKnowledgeCommand(input.command),
  };
}

function promoteKnowledgeRequest(
  value: unknown,
): DesktopPromoteKnowledgeRequest {
  const input = exactRecord(value, "knowledge-promote-global payload", [
    "requestId", "objectId", "expectedGeneration", "expectedSnapshotId",
  ]);
  return {
    requestId: requestId(input.requestId),
    objectId: knowledgeObjectId(input.objectId),
    expectedGeneration: nonnegativeInteger(
      input.expectedGeneration,
      "expectedGeneration",
    ),
    expectedSnapshotId: snapshotId(input.expectedSnapshotId),
  };
}

function globalKnowledgeListRequest(
  value: unknown,
): DesktopGlobalKnowledgeListRequest {
  const input = exactRecord(value, "knowledge-global-list payload", [
    "search", "objectTypes", "cursor", "limit",
  ]);
  const search = optionalBoundedText(input.search, "search", 512);
  const cursor = optionalBoundedText(input.cursor, "cursor", 4096);
  const objectTypes = enumArray(
    input.objectTypes,
    "objectTypes",
    new Set(["term", "style"] as const),
  );
  return {
    ...(search === undefined ? {} : { search }),
    ...(objectTypes === undefined ? {} : { objectTypes }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: pageLimit(input.limit),
  };
}

function attachGlobalKnowledgeRequest(
  value: unknown,
): DesktopAttachGlobalKnowledgeRequest {
  const input = exactRecord(value, "knowledge-global-attach payload", [
    "requestId", "recordId", "revision",
    "expectedGeneration", "expectedSnapshotId",
  ]);
  const recordId = requiredText(input.recordId, "recordId");
  if (!GLOBAL_RECORD_ID.test(recordId)) {
    return inputError("recordId is invalid");
  }
  return {
    requestId: requestId(input.requestId),
    recordId,
    revision: positiveInteger(input.revision, "revision"),
    expectedGeneration: nonnegativeInteger(
      input.expectedGeneration,
      "expectedGeneration",
    ),
    expectedSnapshotId: snapshotId(input.expectedSnapshotId),
  };
}

function uuidValue(value: unknown, label: string): string {
  const id = requiredText(value, label);
  if (!UUID.test(id)) return inputError(`${label} must be a UUID`);
  return id;
}

function pendingImportId(value: unknown): string {
  return uuidValue(value, "pendingImportId");
}

function batchId(value: unknown): string {
  return uuidValue(value, "batchId");
}

function operationId(value: unknown): string {
  return uuidValue(value, "operationId");
}

function importEncoding(
  value: unknown,
): ConfirmImportEncodingRequest["encoding"] {
  const encoding = requiredText(value, "encoding");
  if (!IMPORT_ENCODINGS.has(
    encoding as ConfirmImportEncodingRequest["encoding"],
  )) {
    return inputError("encoding is unsupported");
  }
  return encoding as ConfirmImportEncodingRequest["encoding"];
}

function importSelection(value: unknown): ImportSelection {
  const input = exactRecord(value, "selection", [
    "recordPathId", "sheetId", "headerRow", "encoding",
    "objectType", "scope",
  ]);
  const objectType = requiredText(input.objectType, "selection.objectType");
  if (!KNOWLEDGE_OBJECT_TYPES.has(objectType as KnowledgeObjectType)) {
    return inputError("selection.objectType is unsupported");
  }
  const scope = requiredText(input.scope, "selection.scope");
  if (!IMPORT_SCOPES.has(scope as ImportSelection["scope"])) {
    return inputError("selection.scope is unsupported");
  }
  const recordPathId = optionalBoundedText(
    input.recordPathId,
    "selection.recordPathId",
    512,
  );
  const sheetId = optionalBoundedText(
    input.sheetId,
    "selection.sheetId",
    512,
  );
  const headerRow = input.headerRow === undefined
    ? undefined
    : positiveInteger(input.headerRow, "selection.headerRow");
  if (headerRow !== undefined && headerRow > 1_000) {
    return inputError("selection.headerRow must not exceed 1000");
  }
  const encoding = input.encoding === undefined
    ? undefined
    : importEncoding(input.encoding);
  return {
    ...(recordPathId === undefined ? {} : { recordPathId }),
    ...(sheetId === undefined ? {} : { sheetId }),
    ...(headerRow === undefined ? {} : { headerRow }),
    ...(encoding === undefined ? {} : { encoding }),
    objectType: objectType as KnowledgeObjectType,
    scope: scope as ImportSelection["scope"],
  };
}

function importFields(
  value: unknown,
  objectType: KnowledgeObjectType,
): StageImportRequest["fields"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return inputError("fields must be a JSON object");
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const allowedFields = new Set(knowledgeImportFields(objectType));
  if (keys.length > allowedFields.size) {
    return inputError("fields contains too many mappings");
  }
  const result: Record<
    string,
    NonNullable<StageImportRequest["fields"][string]> | undefined
  > = Object.create(null) as Record<
    string,
    NonNullable<StageImportRequest["fields"][string]> | undefined
  >;
  for (const key of keys) {
    if (!allowedFields.has(key)) {
      return inputError(`fields contains unsupported target field ${key}`);
    }
    const raw = fields[key];
    if (raw === undefined) {
      result[key] = undefined;
      continue;
    }
    const mapping = exactRecord(raw, `fields.${key}`, [
      "targetField", "sourceColumn", "confidence", "confirmed",
      "separator", "nullMeansDelete",
    ]);
    const targetField = requiredText(
      mapping.targetField,
      `fields.${key}.targetField`,
    );
    if (targetField !== key || !allowedFields.has(targetField)) {
      return inputError(`fields.${key}.targetField must equal ${key}`);
    }
    const sourceColumn = boundedText(
      mapping.sourceColumn,
      `fields.${key}.sourceColumn`,
      512,
    );
    const confidence = requiredText(
      mapping.confidence,
      `fields.${key}.confidence`,
    );
    if (!MAPPING_CONFIDENCE.has(
      confidence as NonNullable<
        StageImportRequest["fields"][string]
      >["confidence"],
    )) {
      return inputError(`fields.${key}.confidence is unsupported`);
    }
    if (typeof mapping.confirmed !== "boolean") {
      return inputError(`fields.${key}.confirmed must be boolean`);
    }
    const separator = optionalBoundedText(
      mapping.separator,
      `fields.${key}.separator`,
      32,
    );
    if (
      mapping.nullMeansDelete !== undefined
      && typeof mapping.nullMeansDelete !== "boolean"
    ) {
      return inputError(`fields.${key}.nullMeansDelete must be boolean`);
    }
    result[key] = {
      targetField,
      sourceColumn,
      confidence: confidence as NonNullable<
        StageImportRequest["fields"][string]
      >["confidence"],
      confirmed: mapping.confirmed,
      ...(separator === undefined ? {} : { separator }),
      ...(mapping.nullMeansDelete === undefined
        ? {}
        : { nullMeansDelete: mapping.nullMeansDelete }),
    };
  }
  return result;
}

function inspectImportRequest(value: unknown): InspectImportRequest {
  const input = exactRecord(value, "knowledge-import-inspect payload", [
    "pendingImportId", "operationId",
  ]);
  return {
    pendingImportId: pendingImportId(input.pendingImportId),
    operationId: operationId(input.operationId),
  };
}

function confirmImportEncodingRequest(
  value: unknown,
): ConfirmImportEncodingRequest {
  const input = exactRecord(
    value,
    "knowledge-import-confirm-encoding payload",
    ["pendingImportId", "operationId", "encoding"],
  );
  return {
    pendingImportId: pendingImportId(input.pendingImportId),
    operationId: operationId(input.operationId),
    encoding: importEncoding(input.encoding),
  };
}

function suggestKnowledgeImportRequest(
  value: unknown,
): DesktopSuggestKnowledgeImportRequest {
  const input = exactRecord(value, "knowledge-import-suggest payload", [
    "pendingImportId", "selection",
  ]);
  return {
    pendingImportId: pendingImportId(input.pendingImportId),
    selection: importSelection(input.selection),
  };
}

function stageImportRequest(value: unknown): StageImportRequest {
  const input = exactRecord(value, "knowledge-import-stage payload", [
    "pendingImportId", "operationId", "expectedGeneration",
    "expectedSnapshotId", "selection", "fields",
  ]);
  const selection = importSelection(input.selection);
  return {
    pendingImportId: pendingImportId(input.pendingImportId),
    operationId: operationId(input.operationId),
    expectedGeneration: nonnegativeInteger(
      input.expectedGeneration,
      "expectedGeneration",
    ),
    expectedSnapshotId: snapshotId(input.expectedSnapshotId),
    selection,
    fields: importFields(input.fields, selection.objectType),
  };
}

function stagedImportPageRequest(value: unknown): StagedImportPageRequest {
  const input = exactRecord(value, "knowledge-import-get-staged payload", [
    "batchId", "cursor", "limit",
  ]);
  const cursor = optionalBoundedText(input.cursor, "cursor", 4096);
  return {
    batchId: batchId(input.batchId),
    ...(cursor === undefined ? {} : { cursor }),
    limit: pageLimit(input.limit),
  };
}

function importDecisionRequest(value: unknown): ImportDecisionRequest {
  const input = exactRecord(value, "knowledge-import-decide payload", [
    "batchId", "decisions",
  ]);
  if (!Array.isArray(input.decisions) || input.decisions.length > 1_000) {
    return inputError("decisions must be an array with at most 1000 items");
  }
  const seen = new Set<number>();
  const decisions = input.decisions.map((raw, index) => {
    const item = exactRecord(raw, `decisions[${index}]`, [
      "rowOrdinal", "decision",
    ]);
    const rowOrdinal = positiveInteger(
      item.rowOrdinal,
      `decisions[${index}].rowOrdinal`,
    );
    if (seen.has(rowOrdinal)) {
      return inputError("decisions contains a duplicate rowOrdinal");
    }
    seen.add(rowOrdinal);
    const decision = exactRecord(
      item.decision,
      `decisions[${index}].decision`,
      ["action", "normalizedSubject"],
    );
    const action = requiredText(
      decision.action,
      `decisions[${index}].decision.action`,
    );
    if (!IMPORT_DECISIONS.has(
      action as ImportDecisionRequest["decisions"][number]["decision"]["action"],
    )) {
      return inputError(`decisions[${index}].decision.action is unsupported`);
    }
    if (action === "create_separate") {
      return {
        rowOrdinal,
        decision: {
          action,
          normalizedSubject: boundedText(
            decision.normalizedSubject,
            `decisions[${index}].decision.normalizedSubject`,
            512,
          ),
        },
      } as const;
    }
    if (decision.normalizedSubject !== undefined) {
      return inputError(
        `decisions[${index}].decision.normalizedSubject is not allowed`,
      );
    }
    return {
      rowOrdinal,
      decision: { action },
    } as ImportDecisionRequest["decisions"][number];
  });
  return {
    batchId: batchId(input.batchId),
    decisions,
  };
}

function importOperationRequest<T extends CommitImportRequest | RollbackImportRequest>(
  value: unknown,
  label: string,
): T {
  const input = exactRecord(value, `${label} payload`, [
    "batchId", "operationId", "expectedGeneration", "expectedSnapshotId",
  ]);
  return {
    batchId: batchId(input.batchId),
    operationId: operationId(input.operationId),
    expectedGeneration: nonnegativeInteger(
      input.expectedGeneration,
      "expectedGeneration",
    ),
    expectedSnapshotId: snapshotId(input.expectedSnapshotId),
  } as T;
}

function cancelImportOperationRequest(
  value: unknown,
): CancelImportOperationRequest {
  const input = exactRecord(
    value,
    "knowledge-import-cancel-operation payload",
    ["operationId"],
  );
  return { operationId: operationId(input.operationId) };
}

function discardStagedImportRequest(
  value: unknown,
): DiscardStagedImportRequest {
  const input = exactRecord(
    value,
    "knowledge-import-discard-staged payload",
    ["batchId"],
  );
  return { batchId: batchId(input.batchId) };
}

function requiredProviderId(value: unknown): ProviderId {
  const providerId = requiredText(value, "providerId");
  if (!PROVIDER_ID.test(providerId)) {
    return inputError("providerId contains unsupported characters");
  }
  return providerId as ProviderId;
}

function discoverModelsRequest(value: unknown): ServiceDiscoverModelsRequest {
  const record = exactRecord(value, "discover-models payload", ["providerId", "apiKey", "customBaseUrl"]);
  const providerId = requiredProviderId(record.providerId);
  const apiKey = optionalText(record.apiKey, "apiKey");
  const customBaseUrl = optionalText(record.customBaseUrl, "customBaseUrl");
  return {
    providerId,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(customBaseUrl === undefined ? {} : { customBaseUrl }),
  };
}

function testModelRequest(value: unknown): ServiceTestModelRequest {
  const record = exactRecord(value, "test-model payload", [
    "providerId",
    "apiKey",
    "modelId",
    "reasoningEffort",
    "customBaseUrl",
  ]);
  const providerId = requiredProviderId(record.providerId);
  const apiKey = optionalText(record.apiKey, "apiKey");
  const modelId = requiredText(record.modelId, "modelId");
  const reasoningEffort = optionalText(record.reasoningEffort, "reasoningEffort");
  const customBaseUrl = optionalText(record.customBaseUrl, "customBaseUrl");
  return {
    providerId,
    modelId,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as ProviderEffort }),
    ...(customBaseUrl === undefined ? {} : { customBaseUrl }),
  };
}

function confirmSourceEncodingRequest(value: unknown): DesktopConfirmSourceEncodingRequest {
  const input = exactRecord(
    value,
    "confirm-source-encoding payload",
    ["pendingImportId", "encoding"],
  );
  const pendingImportId = requiredText(input.pendingImportId, "pendingImportId");
  const encoding = requiredText(input.encoding, "encoding");
  if (!SOURCE_ENCODINGS.has(encoding)) {
    return inputError("encoding is unsupported");
  }
  return {
    pendingImportId,
    encoding: encoding as DesktopConfirmSourceEncodingRequest["encoding"],
  };
}

function startTrialRequest(value: unknown): DesktopStartTrialRequest {
  const input = exactRecord(value, "start-trial payload", ["mode"]);
  const mode = requiredText(input.mode, "mode");
  if (mode !== "quality" && mode !== "fast") {
    return inputError("mode must be quality or fast");
  }
  return { mode };
}

function startFullBookRequest(value: unknown): DesktopStartFullBookRequest {
  const input = exactRecord(
    value,
    "start-fullbook payload",
    ["optimizationProfile"],
  );
  const optimizationProfile = requiredText(
    input.optimizationProfile,
    "optimizationProfile",
  );
  if (optimizationProfile !== "economy"
    && optimizationProfile !== "balanced"
    && optimizationProfile !== "speed") {
    return inputError(
      "optimizationProfile must be economy, balanced, or speed",
    );
  }
  return { optimizationProfile };
}

function resumeFullBookRequest(value: unknown): DesktopResumeFullBookRequest {
  const input = exactRecord(value, "resume-fullbook payload", ["runId"]);
  return { runId: boundedText(input.runId, "runId", 200) };
}

function exportBookRequest(value: unknown): DesktopExportRequest {
  const input = exactRecord(
    value,
    "export-book payload",
    ["runId", "destinationId", "formats"],
  );
  const formats = enumArray(input.formats, "formats", EXPORT_FORMATS);
  if (formats === undefined || formats.length === 0) {
    return inputError("formats must contain at least one export format");
  }
  return {
    runId: boundedText(input.runId, "runId", 200),
    destinationId: boundedText(input.destinationId, "destinationId", 200),
    formats,
  };
}

function publicProviders(snapshot: DesktopIpcModelSnapshot): readonly DesktopOnboardingProvider[] {
  return snapshot.providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    keyPlaceholder: provider.keyPlaceholder,
    efforts: [...provider.efforts],
    fallbackModelIds: [...provider.fallbackModelIds],
    allowManualModel: provider.allowManualModel,
    allowCustomBaseUrl: provider.allowCustomBaseUrl,
    credentialStatus: provider.credentialStatus,
    ...(provider.credentialPersistence === undefined
      ? {}
      : { credentialPersistence: provider.credentialPersistence }),
  }));
}

function publicProbe(probe: DesktopIpcModelSnapshot["latestProbe"]): DesktopModelProbe | undefined {
  if (probe === undefined) {
    return undefined;
  }
  return {
    status: probe.status,
    ...(probe.providerId === undefined ? {} : { providerId: probe.providerId }),
    ...(probe.modelId === undefined ? {} : { modelId: probe.modelId }),
    ...(probe.code === undefined ? {} : { code: probe.code }),
    ...(probe.message === undefined ? {} : { message: probe.message }),
    ...(probe.retryable === undefined ? {} : { retryable: probe.retryable }),
    ...(probe.checkedAt === undefined ? {} : { checkedAt: probe.checkedAt }),
  };
}

function onboardingState(
  modelSnapshot: DesktopIpcModelSnapshot,
  project: DesktopProjectSnapshot | undefined,
): DesktopOnboardingState {
  const providers = publicProviders(modelSnapshot);
  const latestProbe = publicProbe(modelSnapshot.latestProbe);
  const profile = modelSnapshot.activeModelProfile;
  const provider = profile === undefined
    ? undefined
    : providers.find((candidate) => candidate.id === profile.providerId);
  // `latestProbe` describes the most recent attempted model, which can differ
  // from the separately persisted ready profile. Credential availability is
  // the durable fact that the saved profile remains runnable.
  const capability: DesktopModelSummary["capability"] = profile !== undefined
    && provider?.credentialStatus === "available"
    ? "ready"
    : "unverified";
  const activeModel = profile === undefined
    ? undefined
    : {
      providerId: profile.providerId,
      modelId: profile.modelId,
      ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }),
      // Only the explicitly configured custom endpoint can return to the renderer.
      ...(provider?.allowCustomBaseUrl === true && profile.customBaseUrl !== undefined
        ? { customBaseUrl: profile.customBaseUrl }
        : {}),
      capability,
    };
  const model = activeModel?.capability === "ready";
  return {
    ...(project === undefined ? {} : { project }),
    providers,
    ...(activeModel === undefined ? {} : { activeModel }),
    ...(latestProbe === undefined ? {} : { latestProbe }),
    readiness: {
      source: project !== undefined,
      model,
      trial: project !== undefined && model,
    },
  };
}

export function registerDesktopIpc(dependencies: DesktopIpcDependencies): void {
  let activeSnapshot: DesktopProjectSnapshot | undefined;
  let activeExportDestination: DesktopExportDestination | undefined;

  const record = (input: DesktopDiagnosticEventInput): void => {
    try {
      dependencies.diagnostics.record(input);
    } catch {
      // Observability must never change an application operation.
    }
  };

  const recordFailure = (input: DesktopDiagnosticFailureInput): void => {
    try {
      dependencies.diagnostics.recordFailure(input);
    } catch {
      // Observability must never change an application operation.
    }
  };

  const handleTrusted = (channel: DesktopIpcChannel, handler: DesktopIpcHandler): void => {
    dependencies.ipcMain.handle(channel, async (event, ...args) => {
      const operationId = randomUUID();
      const startedAt = performance.now();
      record({
        event: "desktop.ipc",
        operationId,
        channel,
        outcome: "started",
      });
      try {
        if (!dependencies.isTrustedEvent(event)) {
          const result = untrustedEvent();
          record({
            event: "desktop.ipc",
            operationId,
            channel,
            durationMs: performance.now() - startedAt,
            outcome: "failed",
            severity: "warning",
            errorCode: "DESKTOP_UNTRUSTED_IPC",
          });
          return result;
        }
      } catch {
        const result = untrustedEvent();
        record({
          event: "desktop.ipc",
          operationId,
          channel,
          durationMs: performance.now() - startedAt,
          outcome: "failed",
          severity: "warning",
          errorCode: "DESKTOP_UNTRUSTED_IPC",
        });
        return result;
      }
      try {
        const result = await handler(event, ...args);
        if (
          result !== null
          && typeof result === "object"
          && !Array.isArray(result)
          && Object.hasOwn(result, "ok")
          && (result as { ok?: unknown }).ok === false
        ) {
          const code = (result as { ok: false; error: { code: string } }).error.code;
          const cancelled = code === "DESKTOP_SELECTION_CANCELLED"
            || code === "DESKTOP_TRIAL_CANCELLED";
          record({
            event: "desktop.ipc",
            operationId,
            channel,
            durationMs: performance.now() - startedAt,
            outcome: cancelled ? "cancelled" : "failed",
            severity: cancelled ? "info" : "warning",
            errorCode: code,
          });
        } else {
          record({
            event: "desktop.ipc",
            operationId,
            channel,
            durationMs: performance.now() - startedAt,
            outcome: "completed",
          });
        }
        return result;
      } catch (error) {
        recordFailure({
          event: "desktop.ipc",
          operationId,
          channel,
          durationMs: performance.now() - startedAt,
          error,
        });
        return fail(toDesktopError(error));
      }
    });
  };

  const snapshot = (request: DesktopProjectRequest): DesktopResult<DesktopProjectSnapshot> => {
    const result = dependencies.projectService.snapshot(request);
    if (result.ok) {
      activeSnapshot = result.value;
    }
    return result;
  };

  const activateImportedSource = (
    imported: Pick<DesktopSourceReadyResult, "manifestPath">,
  ): DesktopResult<DesktopChooseSourceResult> => {
    const request: DesktopProjectRequest = { manifestPath: imported.manifestPath };
    const result = snapshot(request);
    if (!result.ok) {
      return fail(result.error);
    }
    dependencies.setCurrentRequest(request);
    activeExportDestination = undefined;
    return ok({ status: "ready", project: result.value });
  };

  const currentProject = (): DesktopResult<DesktopProjectSnapshot | undefined> => {
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return ok(undefined);
    }
    const result = snapshot(current);
    return result.ok ? ok(result.value) : fail(result.error);
  };

  const currentOnboarding = (): DesktopResult<DesktopOnboardingState> => {
    const project = currentProject();
    if (!project.ok) {
      return fail(project.error);
    }
    return ok(onboardingState(dependencies.modelService.snapshot(), project.value));
  };

  handleTrusted("folioloom:copy-diagnostic-summary", async (_event, ...args) => resultFrom(() => {
    noArguments(args, "copy-diagnostic-summary");
    dependencies.diagnostics.copySummary();
    return ok(undefined);
  }));

  handleTrusted("folioloom:export-diagnostics", async (_event, ...args) => resultFrom(async () => {
    noArguments(args, "export-diagnostics");
    const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    const selection = await dependencies.dialog.showSaveDialog({
      title: "导出 FolioLoom 诊断包",
      defaultPath: `FolioLoom-diagnostics-${stamp}.json`,
      filters: [{ name: "JSON 诊断包", extensions: ["json"] }],
    });
    if (selection.canceled || selection.filePath === undefined) {
      return canceledSelection();
    }
    dependencies.diagnostics.exportReport(selection.filePath);
    return ok({
      fileName: basename(selection.filePath),
      displayPath: selection.filePath,
    } satisfies DesktopDiagnosticExportResult);
  }));

  handleTrusted("folioloom:choose-source", async (_event, ...args) => resultFrom(async () => {
    const request = chooseSourceRequest(args);
    if (dependencies.fullBookService.hasActiveTask()) {
      return failure(
        "DESKTOP_FULLBOOK_ACTIVE",
        "请先暂停当前整本翻译，再更换书稿",
      );
    }
    const sourcePath = await chooseSingleFile(dependencies.dialog, manuscriptFilter);
    if (sourcePath === undefined) {
      return canceledSelection();
    }
    if (!isManuscriptPath(sourcePath)) {
      return invalidSelection("sourcePath must use a supported manuscript extension");
    }
    const imported = await dependencies.sourceService.importSource({
      sourcePath,
      ...(request.sourceLanguage === undefined || request.sourceLanguage === "auto"
        ? {}
        : { sourceLanguage: request.sourceLanguage }),
    });
    if (imported.status === "encoding_required") {
      return ok({
        status: imported.status,
        pendingImportId: imported.pendingImportId,
        fileName: imported.fileName,
        encodings: [...imported.encodings],
      });
    }
    return activateImportedSource(imported);
  }));

  handleTrusted("folioloom:confirm-source-encoding", async (_event, ...args) => resultFrom(async () => {
    const request = confirmSourceEncodingRequest(oneArgument(args, "confirm-source-encoding"));
    const imported = await dependencies.sourceService.confirmEncoding(request);
    return activateImportedSource(imported);
  }));

  handleTrusted("folioloom:onboarding-state", async (_event, ...args) => resultFrom(() => {
    noArguments(args, "onboarding-state");
    return currentOnboarding();
  }));

  handleTrusted("folioloom:discover-models", async (_event, ...args) => resultFrom(async () => {
    const request = discoverModelsRequest(oneArgument(args, "discover-models"));
    const models = await dependencies.modelService.discoverModels(request);
    const value: readonly DesktopModelOption[] = models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
    }));
    return ok(value);
  }));

  handleTrusted("folioloom:test-model", async (_event, ...args) => resultFrom(async () => {
    const request = testModelRequest(oneArgument(args, "test-model"));
    const tested = await dependencies.modelService.testAndSave(request);
    const project = currentProject();
    if (!project.ok) {
      return fail(project.error);
    }
    const report = publicProbe(tested.report);
    if (report === undefined) {
      return failure("DESKTOP_MODEL_TEST_INVALID", "model test returned no report");
    }
    const value: DesktopTestModelResult = {
      report,
      onboarding: onboardingState(tested.snapshot, project.value),
    };
    return ok(value);
  }));

  handleTrusted("folioloom:forget-credential", async (_event, ...args) => resultFrom(() => {
    const providerId = requiredProviderId(oneArgument(args, "forget-credential"));
    dependencies.modelService.forgetCredential(providerId);
    return currentOnboarding();
  }));

  handleTrusted("folioloom:start-trial", async (_event, ...args) => resultFrom(async () => {
    const request = startTrialRequest(oneArgument(args, "start-trial"));
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "choose a manuscript before starting a trial");
    }
    return ok(await dependencies.trialService.start({
      manifestPath: current.manifestPath,
      mode: request.mode,
    }));
  }));

  handleTrusted("folioloom:cancel-trial", async (_event, ...args) => resultFrom(async () => {
    noArguments(args, "cancel-trial");
    await dependencies.trialService.cancel();
    return ok(undefined);
  }));

  handleTrusted("folioloom:fullbook-state", async (_event, ...args) => resultFrom(() => {
    noArguments(args, "fullbook-state");
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "choose a manuscript before viewing full-book progress");
    }
    return ok(dependencies.fullBookService.snapshot(current));
  }));

  handleTrusted("folioloom:start-fullbook", async (_event, ...args) => resultFrom(async () => {
    const request = startFullBookRequest(oneArgument(args, "start-fullbook"));
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "choose a manuscript before starting a full-book translation");
    }
    return ok(await dependencies.fullBookService.start(current, request));
  }));

  handleTrusted("folioloom:pause-fullbook", async (_event, ...args) => resultFrom(async () => {
    noArguments(args, "pause-fullbook");
    return ok(await dependencies.fullBookService.pause());
  }));

  handleTrusted("folioloom:resume-fullbook", async (_event, ...args) => resultFrom(async () => {
    const request = resumeFullBookRequest(oneArgument(args, "resume-fullbook"));
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "choose a manuscript before resuming a full-book translation");
    }
    const snapshot = dependencies.fullBookService.snapshot(current);
    if (!snapshot.runs.some((run) => run.runId === request.runId)) {
      return failure("DESKTOP_FULLBOOK_RUN_NOT_FOUND", "the selected full-book run does not exist");
    }
    return ok(await dependencies.fullBookService.resume(current, request));
  }));

  handleTrusted("folioloom:export-state", async (_event, ...args) => resultFrom(() => {
    noArguments(args, "export-state");
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "choose a manuscript before exporting");
    }
    const value = dependencies.exportService.snapshot(current);
    activeExportDestination ??= value.defaultDestination;
    return ok({
      ...value,
      ...(activeExportDestination === undefined
        ? {}
        : { defaultDestination: activeExportDestination }),
    });
  }));

  handleTrusted(
    "folioloom:choose-export-directory",
    async (_event, ...args) => resultFrom(async () => {
      noArguments(args, "choose-export-directory");
      if (dependencies.getCurrentRequest() === undefined) {
        return failure("DESKTOP_NO_PROJECT", "choose a manuscript before selecting an export folder");
      }
      const path = await chooseDirectory(dependencies.dialog);
      if (path === undefined) {
        return activeExportDestination === undefined
          ? canceledSelection()
          : ok(activeExportDestination);
      }
      activeExportDestination = dependencies.exportService.registerDestination(path);
      return ok(activeExportDestination);
    }),
  );

  handleTrusted("folioloom:export-book", async (_event, ...args) => resultFrom(async () => {
    const request = exportBookRequest(oneArgument(args, "export-book"));
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "choose a manuscript before exporting");
    }
    return ok(await dependencies.exportService.export(current, request));
  }));

  handleTrusted(
    "folioloom:open-export-directory",
    async (_event, ...args) => resultFrom(async () => {
      const exportId = boundedText(
        oneArgument(args, "open-export-directory"),
        "exportId",
        200,
      );
      const path = dependencies.exportService.completedDirectory(exportId);
      if (path === undefined) {
        return failure(
          "DESKTOP_EXPORT_NOT_FOUND",
          "只能打开本次程序运行中已经成功完成的导出",
        );
      }
      const error = await dependencies.openDirectory(path);
      return error.length === 0
        ? ok(undefined)
        : failure("DESKTOP_EXPORT_OPEN_FAILED", error);
    }),
  );

  handleTrusted("folioloom:knowledge-list", async (_event, ...args) => resultFrom(() =>
    dependencies.knowledgeService.list(
      knowledgeListRequest(oneArgument(args, "knowledge-list")),
    )));

  handleTrusted("folioloom:knowledge-detail", async (_event, ...args) => resultFrom(() =>
    dependencies.knowledgeService.detail(
      knowledgeObjectId(oneArgument(args, "knowledge-detail")),
    )));

  handleTrusted("folioloom:knowledge-mutate", async (_event, ...args) => resultFrom(() =>
    dependencies.knowledgeService.mutate(
      knowledgeMutationRequest(oneArgument(args, "knowledge-mutate")),
    )));

  handleTrusted("folioloom:knowledge-promote-global", async (_event, ...args) => resultFrom(() =>
    dependencies.knowledgeService.promoteGlobal(
      promoteKnowledgeRequest(
        oneArgument(args, "knowledge-promote-global"),
      ),
    )));

  handleTrusted("folioloom:knowledge-global-list", async (_event, ...args) => resultFrom(() =>
    dependencies.knowledgeService.listGlobal(
      globalKnowledgeListRequest(
        oneArgument(args, "knowledge-global-list"),
      ),
    )));

  handleTrusted("folioloom:knowledge-global-attach", async (_event, ...args) => resultFrom(() =>
    dependencies.knowledgeService.attachGlobal(
      attachGlobalKnowledgeRequest(
        oneArgument(args, "knowledge-global-attach"),
      ),
    )));

  handleTrusted("folioloom:knowledge-diagnostics", async (_event, ...args) => resultFrom(() => {
    noArguments(args, "knowledge-diagnostics");
    return dependencies.knowledgeService.diagnostics();
  }));

  handleTrusted("folioloom:knowledge-import-choose", async (_event, ...args) =>
    resultFrom(async () => {
      noArguments(args, "knowledge-import-choose");
      const path = await chooseSingleFile(
        dependencies.dialog,
        knowledgeImportFilter,
      );
      if (path === undefined) return canceledSelection();
      const extension = extname(path).toLocaleLowerCase("en").slice(1);
      if (!knowledgeImportFilter[0].extensions.includes(extension)) {
        return invalidSelection(
          "knowledge import must use JSON, YAML, CSV, or XLSX",
        );
      }
      return ok(dependencies.knowledgeImportService.registerPending(path));
    }));

  handleTrusted("folioloom:knowledge-import-inspect", async (_event, ...args) =>
    resultFrom(async () => ok(
      await dependencies.knowledgeImportService.inspect(
        inspectImportRequest(
          oneArgument(args, "knowledge-import-inspect"),
        ),
      ),
    )));

  handleTrusted(
    "folioloom:knowledge-import-confirm-encoding",
    async (_event, ...args) => resultFrom(async () => ok(
      await dependencies.knowledgeImportService.confirmEncoding(
        confirmImportEncodingRequest(
          oneArgument(args, "knowledge-import-confirm-encoding"),
        ),
      ),
    )),
  );

  handleTrusted(
    "folioloom:knowledge-import-list-staged",
    async (_event, ...args) => resultFrom(async () => {
      noArguments(args, "knowledge-import-list-staged");
      return ok(await dependencies.knowledgeImportService.listStaged());
    }),
  );

  handleTrusted(
    "folioloom:knowledge-import-get-staged",
    async (_event, ...args) => resultFrom(async () => ok(
      await dependencies.knowledgeImportService.getStaged(
        stagedImportPageRequest(
          oneArgument(args, "knowledge-import-get-staged"),
        ),
      ),
    )),
  );

  handleTrusted("folioloom:knowledge-import-suggest", async (_event, ...args) =>
    resultFrom(async () => {
      const request = suggestKnowledgeImportRequest(
        oneArgument(args, "knowledge-import-suggest"),
      );
      return ok(await dependencies.knowledgeImportService.suggestMapping(
        request.pendingImportId,
        request.selection,
      ));
    }));

  handleTrusted("folioloom:knowledge-import-stage", async (_event, ...args) =>
    resultFrom(async () => ok(
      await dependencies.knowledgeImportService.stage(
        stageImportRequest(
          oneArgument(args, "knowledge-import-stage"),
        ),
      ),
    )));

  handleTrusted("folioloom:knowledge-import-decide", async (_event, ...args) =>
    resultFrom(async () => ok(
      await dependencies.knowledgeImportService.setDecisions(
        importDecisionRequest(
          oneArgument(args, "knowledge-import-decide"),
        ),
      ),
    )));

  handleTrusted("folioloom:knowledge-import-commit", async (_event, ...args) =>
    resultFrom(async () => ok(
      await dependencies.knowledgeImportService.commit(
        importOperationRequest<CommitImportRequest>(
          oneArgument(args, "knowledge-import-commit"),
          "knowledge-import-commit",
        ),
      ),
    )));

  handleTrusted(
    "folioloom:knowledge-import-rollback",
    async (_event, ...args) => resultFrom(async () => ok(
      await dependencies.knowledgeImportService.rollback(
        importOperationRequest<RollbackImportRequest>(
          oneArgument(args, "knowledge-import-rollback"),
          "knowledge-import-rollback",
        ),
      ),
    )),
  );

  handleTrusted(
    "folioloom:knowledge-import-cancel-operation",
    async (_event, ...args) => resultFrom(() => {
      dependencies.knowledgeImportService.cancelOperation(
        cancelImportOperationRequest(
          oneArgument(args, "knowledge-import-cancel-operation"),
        ),
      );
      return ok(undefined);
    }),
  );

  handleTrusted(
    "folioloom:knowledge-import-cancel-pending",
    async (_event, ...args) => resultFrom(() => {
      dependencies.knowledgeImportService.cancelPendingImport(
        pendingImportId(
          oneArgument(args, "knowledge-import-cancel-pending"),
        ),
      );
      return ok(undefined);
    }),
  );

  handleTrusted(
    "folioloom:knowledge-import-discard-staged",
    async (_event, ...args) => resultFrom(async () => {
      await dependencies.knowledgeImportService.discardStaged(
        discardStagedImportRequest(
          oneArgument(args, "knowledge-import-discard-staged"),
        ),
      );
      return ok(undefined);
    }),
  );

  handleTrusted("folioloom:choose-project", async () => resultFrom(async () => {
    const manifestPath = await chooseSingleFile(dependencies.dialog, manifestFilter);
    if (manifestPath === undefined) {
      return canceledSelection();
    }
    if (basename(manifestPath) !== "source_manifest.json") {
      return invalidSelection("manifestPath must identify source_manifest.json");
    }
    const request: DesktopProjectRequest = { manifestPath };
    const result = snapshot(request);
    if (result.ok) {
      dependencies.setCurrentRequest(request);
    }
    return result;
  }));

  handleTrusted("folioloom:choose-store", async () => resultFrom(async () => {
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return noOpenProject();
    }
    const storePath = await chooseSingleFile(dependencies.dialog, storeFilter);
    if (storePath === undefined) {
      return canceledSelection();
    }
    const request: DesktopProjectRequest = { ...current, storePath, runId: undefined };
    const result = snapshot(request);
    if (result.ok) {
      dependencies.setCurrentRequest(request);
    }
    return result;
  }));

  handleTrusted("folioloom:refresh-project", async () => resultFrom(() => {
    const current = dependencies.getCurrentRequest();
    return current === undefined ? noOpenProject() : snapshot(current);
  }));

  handleTrusted("folioloom:select-run", async (_event, runId) => resultFrom(() => {
    const current = dependencies.getCurrentRequest();
    if (current === undefined || activeSnapshot === undefined) {
      return noOpenProject();
    }
    if (typeof runId !== "string" || !activeSnapshot.runs.some((run) => run.runId === runId)) {
      return invalidSelection("runId must identify a run in the active project snapshot");
    }
    const request: DesktopProjectRequest = { ...current, runId };
    const result = snapshot(request);
    if (result.ok) {
      dependencies.setCurrentRequest(request);
    }
    return result;
  }));

  handleTrusted("folioloom:doctor", async () => resultFrom(() => {
    const current = dependencies.getCurrentRequest();
    if (current === undefined) {
      return failure("DESKTOP_NO_PROJECT", "open an initialized project first");
    }
    return dependencies.projectService.doctor({
      manifestPath: current.manifestPath,
      ...(current.glossaryPath === undefined ? {} : { glossaryPath: current.glossaryPath }),
    });
  }));
}
