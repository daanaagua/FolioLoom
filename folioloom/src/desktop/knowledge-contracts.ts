import type {
  JsonValue,
  KnowledgeEvidence,
  KnowledgeOrigin,
  KnowledgeScope,
} from "../knowledge/knowledge-authority.js";
import type {
  KnowledgeCatalogExpectation,
  KnowledgeObjectType,
  RollbackKnowledgeCommand,
  UpdateKnowledgeCommand,
} from "../knowledge/knowledge-commands.js";
import type {
  KnowledgeListItem,
} from "../knowledge/knowledge-query.js";
import type { KnowledgeStatus } from "../knowledge/knowledge-store.js";
import type {
  ImportSelection,
  PendingKnowledgeImport,
} from "../knowledge-import/types.js";

export type {
  CancelImportOperationRequest,
  CommitImportRequest,
  CommittedImportReport,
  ConfirmImportEncodingRequest,
  DiscardStagedImportRequest,
  ImportFieldMapping,
  ImportConflictDecision,
  ImportDecisionRequest,
  ImportInspection,
  ImportInspectionResult,
  ImportPreviewRow,
  ImportSelection,
  InspectImportRequest,
  MappingSuggestion,
  PendingKnowledgeImport,
  RollbackImportRequest,
  RolledBackImportReport,
  StageImportRequest,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "../knowledge-import/types.js";
export { MAX_STAGED_IMPORT_PAGE_SIZE } from "../knowledge-import/types.js";

export interface DesktopSuggestKnowledgeImportRequest {
  readonly pendingImportId: PendingKnowledgeImport["pendingImportId"];
  readonly selection: ImportSelection;
}

export interface DesktopKnowledgeListRequest {
  readonly search?: string;
  readonly objectTypes?: readonly KnowledgeObjectType[];
  readonly statuses?: readonly KnowledgeStatus[];
  readonly origins?: readonly KnowledgeOrigin[];
  readonly scopes?: readonly KnowledgeScope[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DesktopKnowledgeMutationRequest {
  readonly requestId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
  readonly command: UpdateKnowledgeCommand | RollbackKnowledgeCommand;
}

export interface DesktopPromoteKnowledgeRequest {
  readonly requestId: string;
  readonly objectId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface DesktopGlobalKnowledgeListRequest {
  readonly search?: string;
  readonly objectTypes?: readonly ("term" | "style")[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface DesktopGlobalKnowledgePage {
  readonly items: readonly {
    readonly recordId: string;
    readonly revision: number;
    readonly objectType: "term" | "style";
    readonly normalizedSubject: string;
    readonly displayValue: string;
  }[];
  readonly nextCursor?: string;
}

export interface DesktopAttachGlobalKnowledgeRequest {
  readonly requestId: string;
  readonly recordId: string;
  readonly revision: number;
  readonly expectedGeneration: number;
  readonly expectedSnapshotId: string;
}

export interface DesktopKnowledgePage {
  readonly generation: number;
  readonly snapshotId: string;
  readonly items: readonly KnowledgeListItem[];
  readonly nextCursor?: string;
}

export interface DesktopKnowledgeEvidence {
  readonly kind: KnowledgeEvidence["kind"];
  readonly globalIndex?: number;
  readonly canonicalStart?: number;
  readonly canonicalEnd?: number;
  readonly sourceText?: string;
}

export interface DesktopKnowledgeDetail {
  readonly item: KnowledgeListItem;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly evidence: readonly DesktopKnowledgeEvidence[];
  readonly history: readonly {
    readonly revision: number;
    readonly revisionId: string;
    readonly origin: KnowledgeOrigin;
    readonly scope: KnowledgeScope;
    readonly createdAt: string;
  }[];
  readonly impacts: readonly {
    readonly blockId: string;
    readonly globalIndex: number;
    readonly status: "pending" | "acknowledged" | "retranslated";
  }[];
  readonly relations: readonly {
    readonly subjectId: string;
    readonly predicate: string;
    readonly objectId: string;
  }[];
}

export interface DesktopKnowledgeMutationResult {
  readonly generation: number;
  readonly snapshotId: string;
  readonly detail: DesktopKnowledgeDetail;
}

export interface DesktopKnowledgeDiagnostics {
  readonly schemaVersion: number;
  readonly knowledgeGeneration: number;
  readonly countsByType: Readonly<Record<string, number>>;
  readonly countsByStatus: Readonly<Record<string, number>>;
  readonly pendingImpacts: number;
  readonly latestMigration: string;
  readonly advanced?: {
    readonly tables: readonly {
      readonly name: string;
      readonly rowCount: number;
    }[];
    readonly recentEvents: readonly {
      readonly kind: string;
      readonly createdAt: string;
    }[];
    readonly integrityCheck: "ok";
  };
}

export type DesktopKnowledgeScopeRevision = KnowledgeCatalogExpectation;
