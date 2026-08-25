import type {
  JsonValue,
  KnowledgeScope,
} from "../knowledge/knowledge-authority.js";
import type { KnowledgeObjectType } from "../knowledge/knowledge-commands.js";

export type KnowledgeImportFormat = "json" | "yaml" | "csv" | "xlsx";
export type ImportOperationId = string;
export type KnowledgeImportScope = Extract<KnowledgeScope, "book" | "project">;
export const MAX_STAGED_IMPORT_PAGE_SIZE = 100;
export type ImportTextEncoding =
  | "utf-8" | "utf-16le" | "utf-16be"
  | "shift_jis" | "euc-jp" | "euc-kr" | "windows-949";

export interface PendingKnowledgeImport {
  readonly pendingImportId: string;
  readonly fileName: string;
  readonly format: KnowledgeImportFormat;
}

export interface InspectImportRequest {
  readonly pendingImportId: string;
  readonly operationId: ImportOperationId;
}

export interface ConfirmImportEncodingRequest extends InspectImportRequest {
  readonly encoding: ImportTextEncoding;
}

export interface ImportRecordPath {
  readonly id: string;
  readonly label: string;
  readonly shape: "records" | "key_value";
}

export interface ImportSheet {
  readonly id: string;
  readonly name: string;
  readonly suggestedHeaderRows: readonly number[];
}

export interface ImportRecordSource {
  readonly ordinal: number;
  readonly location: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export interface ImportInspection {
  readonly pendingImportId: string;
  readonly fileName: string;
  readonly format: KnowledgeImportFormat;
  readonly recordPaths: readonly ImportRecordPath[];
  readonly sheets: readonly ImportSheet[];
  readonly sample: readonly ImportRecordSource[];
}

export type ImportInspectionResult =
  | { readonly status: "ready"; readonly inspection: ImportInspection }
  | {
      readonly status: "encoding_required";
      readonly pendingImportId: string;
      readonly fileName: string;
      readonly encodings: readonly ImportTextEncoding[];
      readonly previews: readonly {
        readonly encoding: ImportTextEncoding;
        readonly text: string;
      }[];
    };

export interface ImportSelection {
  readonly recordPathId?: string;
  readonly sheetId?: string;
  readonly headerRow?: number;
  readonly encoding?: ImportTextEncoding;
  readonly objectType: KnowledgeObjectType;
  readonly scope: KnowledgeImportScope;
}

export interface ImportFieldMapping {
  readonly targetField: string;
  readonly sourceColumn: string;
  readonly confidence: "high" | "medium" | "low";
  readonly confirmed: boolean;
  readonly separator?: string;
  readonly nullMeansDelete?: boolean;
}

export interface MappingSuggestion {
  readonly selection: ImportSelection;
  readonly fields: Readonly<Record<string, ImportFieldMapping | undefined>>;
  readonly reasons: Readonly<Record<string, readonly string[]>>;
  readonly mappingHash: string;
}

export interface ImportDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly location: string;
  readonly field?: string;
}

export interface StageImportRequest {
  readonly pendingImportId: string;
  readonly operationId: ImportOperationId;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly selection: ImportSelection;
  readonly fields: Readonly<Record<string, ImportFieldMapping | undefined>>;
}

export interface ImportCountSummary {
  readonly ready: number;
  readonly merge: number;
  readonly conflict: number;
  readonly invalid: number;
  readonly skipped: number;
}

export type ImportConflictDecision =
  | { readonly action: "keep_existing" }
  | { readonly action: "use_imported" }
  | { readonly action: "merge_as_alias" }
  | { readonly action: "create_separate"; readonly normalizedSubject: string }
  | { readonly action: "skip" };

export interface ImportPreviewRow {
  readonly ordinal: number;
  readonly location: string;
  readonly state: "ready" | "merge" | "conflict" | "invalid" | "skipped";
  readonly displayFields: Readonly<Record<string, JsonValue>>;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly allowedDecisions: readonly ImportConflictDecision["action"][];
}

export interface StagedImportReport {
  readonly batchId: string;
  readonly counts: ImportCountSummary;
  readonly unresolved: number;
  readonly rows: readonly ImportPreviewRow[];
  readonly nextCursor?: string;
}

export interface StagedImportSummary {
  readonly batchId: string;
  readonly sourceName: string;
  readonly sourceFormat: KnowledgeImportFormat;
  readonly counts: ImportCountSummary;
  readonly unresolved: number;
  readonly createdAt: string;
}

export interface CommittedImportReport {
  readonly batchId: string;
  readonly added: number;
  readonly updated: number;
  readonly merged: number;
  readonly skipped: number;
  readonly invalid: number;
  readonly committed: number;
  readonly generation: number;
  readonly snapshotId: string;
}

export interface RolledBackImportReport {
  readonly batchId: string;
  readonly rolledBack: number;
  readonly generation: number;
  readonly snapshotId: string;
}

export interface ImportDecisionRequest {
  readonly batchId: string;
  readonly decisions: readonly {
    readonly rowOrdinal: number;
    readonly decision: ImportConflictDecision;
  }[];
}

export interface StagedImportPageRequest {
  readonly batchId: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CommitImportRequest {
  readonly batchId: string;
  readonly operationId: ImportOperationId;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface RollbackImportRequest {
  readonly batchId: string;
  readonly operationId: ImportOperationId;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface DiscardStagedImportRequest {
  readonly batchId: string;
}

export interface CancelImportOperationRequest {
  readonly operationId: ImportOperationId;
}
