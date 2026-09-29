import { runSupervisor, supervisorPrompt, supervisorSystemPrompt, validateSupervisorDecision,
  type SupervisorDecision, type SupervisorInput, type SupervisorSource, type SupervisorWindow } from "../agents/supervisor.js";
import { ModelProviderError, type PiAssistantResponseObservation } from "../agents/pi-runtime.js";
import { effectiveSystemPrompt } from "../agents/task-context.js";
import { SUPERVISION_POLICY, supervisionCandidateHash, supervisionHash, type SupervisionRecord } from "../domain/supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import type { AdmissionController } from "./admission-controller.js";
import type { TranslationRuntime } from "./types.js";

export class SupervisionPausedError extends Error {
  readonly code = "SUPERVISION_PAUSED";
  readonly retryable = false;
  constructor(readonly decisionId: string, reason: string) {
    super(`SUPERVISION_PAUSED: ${reason} [${decisionId}]`);
    this.name = "SupervisionPausedError";
  }
}
export class SupervisionExecutionError extends Error {
  readonly code = "SUPERVISION_EXECUTION_FAILED";
  readonly retryable = false;
  constructor(error: unknown) {
    super(`SUPERVISION_EXECUTION_FAILED: ${error instanceof Error ? error.message : "unknown failure"}`, { cause: error });
    this.name = "SupervisionExecutionError";
  }
}
export function isSupervisionBoundaryError(error: unknown): error is SupervisionPausedError | SupervisionExecutionError {
  return error instanceof SupervisionPausedError || error instanceof SupervisionExecutionError;
}
interface SupervisionJournal {
  supervisionRecords(runId: string): SupervisionRecord[];
  appendSupervisionRecord(runId: string, record: SupervisionRecord): void;
}
export interface SupervisionControllerOptions {
  runId: string;
  sourceVersion: string;
  windows: readonly SupervisorWindow[];
  sources: readonly SupervisorSource[];
  runtime: TranslationRuntime;
  admission: AdmissionController;
  store: SupervisionJournal;
  signal?: AbortSignal;
  deadlineMs?: number;
  onResponse?: (requestId: string, observation: PiAssistantResponseObservation) => void | Promise<void>;
}

/** The controller authorizes work; only the host kernel can execute/commit it. */
export class SupervisionController {
  #serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SupervisionControllerOptions) {}

  #records(): SupervisionRecord[] { return this.options.store.supervisionRecords(this.options.runId); }
  #append(record: SupervisionRecord): void { this.options.store.appendSupervisionRecord(this.options.runId, record); }
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(operation);
    this.#serial = next.catch(() => undefined);
    return next;
  }
  #checkPaused(windowId: string): void {
    const records = this.#records();
    const released = new Set(records.filter(r => r.state === "released").map(r => r.key));
    const paused = records.find(r => r.state === "paused" && r.windowIds.includes(windowId) && !released.has(r.id));
    if (paused) throw new SupervisionPausedError(paused.id, paused.reason ?? paused.decision?.reason ?? "checkpoint requires attention");
  }
  #afterRelease(windowId: string): SupervisionRecord[] {
    const records = this.#records();
    const index = records.findLastIndex(r => r.state === "released" && r.windowIds.includes(windowId));
    return records.slice(index + 1);
  }
  #input(event: "plan" | "review", windows: readonly SupervisorWindow[], terms: SupervisorInput["terms"]): SupervisorInput {
    const runtime = this.options.runtime;
    const ids = new Set(windows.flatMap(w => w.blockIds));
    const source = this.options.sources.filter(b => ids.has(b.blockId)).map(b => b.sourceText).join("\n").toLocaleLowerCase();
    const projectedTerms = terms.filter(t => source.includes(t.sourceForm.toLocaleLowerCase()))
      .map(t => ({ sourceForm: t.sourceForm, target: t.target, locked: t.locked === true }));
    return { event, windows, sources: this.options.sources, terms: projectedTerms, model: runtime.model, streamFn: runtime.streamFn,
      maxTurns: SUPERVISION_POLICY.maxTurns, thinkingLevel: runtime.thinkingLevel,
      signal: this.options.signal, deadlineMs: this.options.deadlineMs };
  }

  planFor(windowId: string, terms: SupervisorInput["terms"], conflicts: readonly string[] = []): Promise<SupervisorDecision> {
    return this.#exclusive(async () => {
      this.options.signal?.throwIfAborted();
      this.#checkPaused(windowId);
      const conflictHash = supervisionHash(conflicts);
      const cached = this.#records().findLast(r => r.event === "plan" && r.state === "completed"
        && r.conflictHash === conflictHash && r.decision?.action === "translate" && r.decision.windowIds.includes(windowId));
      if (cached?.decision) {
        const scope = this.options.windows.filter(w => cached.windowIds.includes(w.windowId));
        return validateSupervisorDecision(cached.decision, this.#input("plan", scope, terms));
      }
      const index = this.options.windows.findIndex(w => w.windowId === windowId);
      if (index < 0) throw new Error("supervisor window outside plan");
      const windows = this.options.windows.slice(index, index + SUPERVISION_POLICY.batchWindows);
      return this.#decide({ ...this.#input("plan", windows, terms), conflicts }, conflictHash);
    });
  }

  guidanceFor(windowIds: readonly string[]): SupervisorDecision["guidance"] {
    const selected = new Set(windowIds);
    const blocks = new Set(this.options.windows.filter(w => selected.has(w.windowId)).flatMap(w => w.blockIds));
    const entries = this.#records().filter(r => r.event === "plan" && r.state === "completed" && r.decision?.action === "translate")
      .flatMap(r => r.decision!.guidance).filter(g => blocks.has(g.blockId));
    return [...new Map(entries.map(g => [`${g.blockId}\0${g.sourceQuote}`, g])).values()];
  }

  review(windowId: string, candidate: readonly { blockId: string; text: string }[], terms: SupervisorInput["terms"]): Promise<readonly ValidationFailure[]> {
    return this.#exclusive(async () => {
      this.options.signal?.throwIfAborted();
      this.#checkPaused(windowId);
      const window = this.options.windows.find(w => w.windowId === windowId);
      if (!window) throw new Error("review window outside supervisor plan");
      const requested = this.#records().some(r => r.event === "plan" && r.state === "completed"
        && r.decision?.action === "translate" && r.decision.reviewBlockIds.some(id => window.blockIds.includes(id)));
      if (!requested) return [];
      if (candidate.length !== window.blockIds.length || window.blockIds.some(id => !candidate.some(t => t.blockId === id))) {
        throw new Error("supervisor review requires the complete logical window");
      }
      const input = { ...this.#input("review", [window], terms), candidate };
      const decision = await this.#decide(input);
      return decision.issues.map(issue => ({
        code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: issue.blockId, repairable: true,
        message: `原文 ${JSON.stringify(issue.sourceQuote)}；当前译文 ${JSON.stringify(issue.targetQuote)}；问题：${issue.problem}。只修正该实质问题，不改无关内容。`,
      }));
    });
  }

  async #decide(input: SupervisorInput, conflictHash?: string): Promise<SupervisorDecision> {
    const inputHash = supervisionHash({ sourceVersion: this.options.sourceVersion, event: input.event, windows: input.windows,
      terms: input.terms, candidate: input.candidate, conflicts: input.conflicts });
    const key = `${input.event}:${input.windows[0]!.windowId}:${inputHash}`;
    const cached = this.#records().find(r => r.state === "completed" && r.inputHash === inputHash && r.decision);
    if (cached?.decision) return validateSupervisorDecision(cached.decision, input);
    const history = this.#afterRelease(input.windows[0]!.windowId);
    const attempts = history.filter(r => r.key === key && r.state === "started").length;
    const reviews = history.filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(input.windows[0]!.windowId)).length;
    const generation = this.#records().filter(r => r.state === "released").length;
    const attemptId = `${key}:generation-${generation}:attempt-${attempts}`;
    const recordBase = { key, event: input.event, windowIds: input.windows.map(w => w.windowId), inputHash,
      ...(input.candidate ? { candidateHash: supervisionCandidateHash(input.candidate) } : {}),
      ...(conflictHash ? { conflictHash } : {}) };
    if (attempts >= SUPERVISION_POLICY.maxAttemptsPerCheckpoint
      || (input.event === "review" && reviews >= SUPERVISION_POLICY.maxReviewsPerWindow)) {
      const id = `${attemptId}:limit`;
      this.#append({ ...recordBase, id, state: "paused", reason: "bounded supervisor checkpoint budget exhausted", modelCalls: 0, totalTokens: 0, usageComplete: true });
      throw new SupervisionPausedError(id, "bounded supervisor checkpoint budget exhausted");
    }
    const chars = supervisorPrompt(input).length + effectiveSystemPrompt(input.streamFn, supervisorSystemPrompt()).length;
    // Bounds include tool schemas and all permitted evidence returned in the session.
    const inputUpper = chars * 2 + 20_000;
    const outputUpper = Math.min(8192, input.model.maxTokens);
    if (inputUpper + outputUpper > input.model.contextWindow) throw new Error("supervisor context capacity exceeded before dispatch");
    const predictedTokens = (inputUpper + outputUpper) * SUPERVISION_POLICY.maxTurns;
    this.options.admission.addBaseline({ taskIds: [attemptId], baselineTokens: predictedTokens, source: "supervision", reason: input.event });
    const transaction = this.options.admission.begin({ requestId: attemptId, purpose: "supervision", taskIds: [attemptId], predictedTokens,
      attempt: attempts, conservativeHorizonFloor: 0 });
    this.#append({ ...recordBase, id: `${attemptId}:started`, state: "started" });
    transaction.markDispatched();
    let settled = false;
    try {
      const result = await runSupervisor({ ...input, onAssistantResponse: this.options.onResponse === undefined ? undefined
        : observation => this.options.onResponse!(attemptId, observation) });
      const usageComplete = result.run.modelCalls === 0 || result.run.usage.totalTokens > 0;
      transaction.settle({ actualTokens: result.run.usage.totalTokens, usageComplete, outcome: "success" });
      settled = true;
      const id = `${attemptId}:result`;
      this.#append({ ...recordBase, id, state: result.decision.action === "pause" ? "paused" : "completed", decision: result.decision,
        reason: result.decision.reason, modelCalls: result.run.modelCalls, totalTokens: result.run.usage.totalTokens, usageComplete });
      if (result.decision.action === "pause") throw new SupervisionPausedError(id, result.decision.reason);
      return result.decision;
    } catch (error) {
      if (!settled) {
        const run = error instanceof ModelProviderError ? error.run : undefined;
        const usageComplete = run !== undefined && (run.modelCalls === 0 || run.usage.totalTokens > 0);
        transaction.settle({ actualTokens: run?.usage.totalTokens ?? 0, usageComplete, outcome: "failed" });
        this.#append({ ...recordBase, id: `${attemptId}:failed`, state: "failed", modelCalls: run?.modelCalls ?? 0,
          totalTokens: run?.usage.totalTokens ?? 0, usageComplete, reason: error instanceof Error ? error.message : "supervisor execution failed" });
      }
      throw isSupervisionBoundaryError(error) ? error : new SupervisionExecutionError(error);
    }
  }
}
