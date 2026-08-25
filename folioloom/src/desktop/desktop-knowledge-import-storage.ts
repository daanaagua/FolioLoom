import type {
  KnowledgeImportStorageAdapter,
  StageBatchInput,
} from "../knowledge-import/knowledge-import-service.js";
import { LosslessKnowledgeImportStorageAdapter } from "../knowledge-import/lossless-knowledge-import-storage.js";
import type {
  CommitImportRequest,
  CommittedImportReport,
  DiscardStagedImportRequest,
  ImportDecisionRequest,
  RollbackImportRequest,
  RolledBackImportReport,
  StagedImportPageRequest,
  StagedImportReport,
  StagedImportSummary,
} from "../knowledge-import/types.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import type { DesktopProjectRequest } from "./contracts.js";
import { DesktopInputError } from "./desktop-errors.js";
import { DesktopProjectService } from "./desktop-project-service.js";

type AdapterOperation<T> = (
  adapter: LosslessKnowledgeImportStorageAdapter,
) => Promise<T>;

/**
 * Resolves the active project for every operation. The renderer never supplies
 * a database path or run id, and switching manuscripts cannot leave a stale
 * store handle attached to the import service.
 */
export class DesktopKnowledgeImportStorage
implements KnowledgeImportStorageAdapter {
  constructor(
    private readonly projects: DesktopProjectService,
    private readonly getCurrentRequest: () => DesktopProjectRequest | undefined,
  ) {}

  stageBatch(input: StageBatchInput): Promise<StagedImportReport> {
    return this.#withAdapter((adapter) => adapter.stageBatch(input));
  }

  listStaged(): Promise<readonly StagedImportSummary[]> {
    return this.#withAdapter((adapter) => adapter.listStaged());
  }

  getStaged(input: StagedImportPageRequest): Promise<StagedImportReport> {
    return this.#withAdapter((adapter) => adapter.getStaged(input));
  }

  setDecisions(input: ImportDecisionRequest): Promise<StagedImportReport> {
    return this.#withAdapter((adapter) => adapter.setDecisions(input));
  }

  discardStaged(input: DiscardStagedImportRequest): Promise<void> {
    return this.#withAdapter((adapter) => adapter.discardStaged(input));
  }

  commitBatch(
    input: CommitImportRequest & { readonly signal: AbortSignal },
  ): Promise<CommittedImportReport> {
    return this.#withAdapter((adapter) => adapter.commitBatch(input));
  }

  rollbackBatch(
    input: RollbackImportRequest & { readonly signal: AbortSignal },
  ): Promise<RolledBackImportReport> {
    return this.#withAdapter((adapter) => adapter.rollbackBatch(input));
  }

  async #withAdapter<T>(operation: AdapterOperation<T>): Promise<T> {
    const request = this.getCurrentRequest();
    if (request === undefined) {
      throw new DesktopInputError(
        "DESKTOP_PROJECT_NOT_SELECTED",
        "Open a project before importing knowledge",
      );
    }
    const resolved = this.projects.resolveKnowledgeTarget(request);
    if (!resolved.ok) {
      throw new DesktopInputError(
        resolved.error.code,
        resolved.error.message,
      );
    }
    const store = new LosslessBookStore(resolved.value.storePath);
    try {
      store.syncScopedKnowledge(resolved.value.runId);
      return await operation(
        new LosslessKnowledgeImportStorageAdapter(
          store,
          resolved.value.runId,
        ),
      );
    } finally {
      store.close();
    }
  }
}
