import type { CommitKnowledgeCommandsRequest } from "./knowledge-commands.js";
import type {
  ApplyQueuedKnowledgeChangesReport,
  KnowledgeChangeQueueRecord,
  KnowledgeSubmissionResult,
  LosslessBookStore,
  PlanStoredTermRetrofitInput,
  StoredTermRetrofitJob,
  StoredTermRetrofitPlan,
} from "../storage/lossless-book-store.js";

/**
 * One typed control plane shared by CLI, desktop, and the private Codex skill.
 * Adapters never reach into SQLite or duplicate queue/retrofit state rules.
 */
export class TerminologyControlService {
  constructor(
    private readonly store: LosslessBookStore,
    private readonly runId: string,
  ) {}

  submit(
    request: Omit<CommitKnowledgeCommandsRequest, "runId">,
  ): KnowledgeSubmissionResult {
    return this.store.submitKnowledgeCommands({
      ...request,
      runId: this.runId,
    });
  }

  queue(): readonly KnowledgeChangeQueueRecord[] {
    return this.store.queuedKnowledgeChanges(this.runId);
  }

  applyQueue(): ApplyQueuedKnowledgeChangesReport {
    return this.store.applyQueuedKnowledgeChanges(this.runId);
  }

  cancelQueued(requestId: string): boolean {
    return this.store.cancelQueuedKnowledgeChange(this.runId, requestId);
  }

  planRetrofit(
    request: Omit<PlanStoredTermRetrofitInput, "runId">,
  ): StoredTermRetrofitPlan {
    return this.store.planTermRetrofitJob({
      ...request,
      runId: this.runId,
    });
  }

  applyRetrofit(jobId: string, planHash: string): StoredTermRetrofitJob {
    return this.store.applyTermRetrofitJob(this.runId, jobId, planHash);
  }

  retrofit(jobId: string): StoredTermRetrofitJob {
    return this.store.termRetrofitJob(this.runId, jobId);
  }

  retrofits(): readonly StoredTermRetrofitJob[] {
    return this.store.termRetrofitJobs(this.runId);
  }

  cancelRetrofit(jobId: string): StoredTermRetrofitJob {
    return this.store.cancelTermRetrofitJob(this.runId, jobId);
  }

  rollbackRetrofit(jobId: string): StoredTermRetrofitJob {
    return this.store.rollbackTermRetrofitJob(this.runId, jobId);
  }
}
