import { SUPERVISOR_PROTOCOL, runSupervisor, supervisorPrompt, supervisorSystemPrompt, validateSupervisorDecision,
  type SupervisorDecision, type SupervisorInput, type SupervisorSource, type SupervisorWindow } from "../agents/supervisor.js";
import { ModelProviderError, type PiAssistantResponseObservation } from "../agents/pi-runtime.js";
import { effectiveSystemPrompt } from "../agents/task-context.js";
import { SUPERVISION_POLICY, supervisionCandidateHash, supervisionHash, type SupervisionRecord } from "../domain/supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import type { AdmissionController } from "./admission-controller.js";
import type { TranslationRuntime } from "./types.js";
import type { AutomaticRecovery } from "./automatic-recovery.js";
import { ScopedOperationQueue } from "./scoped-operation-queue.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { priorQualityIssues, needsDispositionVerification, type QualityClosure } from "../domain/quality-closure.js";
import type { SurfaceConsistencyEvidence } from "../knowledge/surface-consistency.js";
import { reviewFocus } from "./review-focus.js";

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
  recovery?: AutomaticRecovery;
  maxConcurrency?: number;
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
  readonly #operations: ScopedOperationQueue;
  constructor(private readonly options: SupervisionControllerOptions) {
    this.#operations = new ScopedOperationQueue(options.maxConcurrency ?? 1);
  }

  #records(): SupervisionRecord[] { return this.options.store.supervisionRecords(this.options.runId); }
  #dependencyHash(terms: SupervisorInput["terms"], windows: readonly SupervisorWindow[]): string {
    return supervisionHash({ schema: "scoped-supervision-dependencies-1", protocol: SUPERVISOR_PROTOCOL,
      sourceVersion: this.options.sourceVersion, windows: windows.map(w => ({ windowId: w.windowId, blockIds: w.blockIds })),
      terms: this.#projectTerms(terms, windows) });
  }
  #requestBounds(input: SupervisorInput): { inputUpper: number; outputUpper: number } {
    const chars = supervisorPrompt(input).length + effectiveSystemPrompt(input.streamFn, supervisorSystemPrompt()).length;
    return { inputUpper: chars * 2 + 20_000, outputUpper: Math.min(8192, input.model.maxTokens) };
  }
  #append(record: SupervisionRecord): void { this.options.store.appendSupervisionRecord(this.options.runId, record); }
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
  #projectTerms(terms: SupervisorInput["terms"], windows: readonly SupervisorWindow[]): SupervisorInput["terms"] {
    const ids = new Set(windows.flatMap(w => w.blockIds));
    const source = this.options.sources.filter(b => ids.has(b.blockId)).map(b => b.sourceText).join("\n").toLocaleLowerCase();
    return terms.filter(t => source.includes(t.sourceForm.toLocaleLowerCase())
      && (!t.applicableBlockIds || t.applicableBlockIds.some(id => ids.has(id))))
      .map(t => ({ ...t, locked: t.locked === true }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  #input(event: "plan" | "review", windows: readonly SupervisorWindow[], terms: SupervisorInput["terms"]): SupervisorInput {
    const runtime = this.options.runtime;
    const projectedTerms = this.#projectTerms(terms, windows);
    return { event, windows, sources: this.options.sources, terms: projectedTerms, model: runtime.model, streamFn: runtime.streamFn,
      maxTurns: 2, thinkingLevel: runtime.thinkingLevel,
      signal: this.options.signal, deadlineMs: this.options.deadlineMs };
  }

  planFor(windowId: string, terms: SupervisorInput["terms"], conflicts: readonly string[] = []): Promise<SupervisorDecision> {
    const index = this.options.windows.findIndex(w => w.windowId === windowId);
    if (index < 0) return Promise.reject(new Error("supervisor window outside plan"));
    const plannedScope = this.options.windows.slice(index, index + SUPERVISION_POLICY.batchWindows);
    return this.#operations.run(plannedScope.map(w => w.windowId), async () => {
      this.options.signal?.throwIfAborted();
      this.#checkPaused(windowId);
      const conflictHash = supervisionHash(conflicts);
      const cached = this.#records().findLast(r => r.event === "plan" && r.state === "completed"
        && r.decision?.action === "translate" && r.decision.windowIds.includes(windowId));
      if (cached?.decision && cached.conflictHash === conflictHash) {
        const scope = this.options.windows.filter(w => cached.windowIds.includes(w.windowId));
        if (cached.dependencyHash === this.#dependencyHash(terms, scope))
          return validateSupervisorDecision(cached.decision, this.#input("plan", scope, terms));
      }
      let windows = this.options.windows.slice(index, index + SUPERVISION_POLICY.batchWindows);
      let input = { ...this.#input("plan", windows, terms), conflicts };
      while (windows.length > 1) {
        const bounds = this.#requestBounds(input);
        if (bounds.inputUpper + bounds.outputUpper <= input.model.contextWindow) break;
        windows = windows.slice(0, -1);
        input = { ...this.#input("plan", windows, terms), conflicts };
      }
      return this.#decide(input, conflictHash, this.#dependencyHash(terms, windows));
    });
  }

  guidanceFor(windowIds: readonly string[], terms?: SupervisorInput["terms"]): SupervisorDecision["guidance"] {
    const selected = new Set(windowIds);
    const records = this.#records();
    const entries = this.options.windows.filter(w => selected.has(w.windowId)).flatMap(window => {
      const plan = records.findLast(r => r.event === "plan" && r.state === "completed" && r.decision?.action === "translate" && r.decision.windowIds.includes(window.windowId));
      if (terms !== undefined && (plan?.windowDependencyHashes?.[window.windowId] ?? plan?.dependencyHash) !== this.#dependencyHash(terms, [window])) return [];
      return plan?.decision?.guidance.filter(g => window.blockIds.includes(g.blockId)) ?? [];
    });
    return [...new Map(entries.map(g => [`${g.blockId}\0${g.sourceQuote}`, g])).values()];
  }

  pauseCandidate(windowId: string, reason: string): void {
    const records = this.#records();
    const released = new Set(records.filter(r => r.state === "released").map(r => r.key));
    if (records.some(r => r.state === "paused" && r.windowIds.includes(windowId) && !released.has(r.id))) return;
    const generation = records.filter(r => r.state === "released" && r.windowIds.includes(windowId)).length;
    const inputHash = supervisionHash({ sourceVersion: this.options.sourceVersion, windowId, reason });
    const id = `candidate-recovery:${windowId}:generation-${generation}:${inputHash}`;
    this.#append({ id, key: id, event: "review", state: "paused", windowIds: [windowId], inputHash,
      reason: reason.slice(0, 1200), modelCalls: 0, totalTokens: 0, usageComplete: true });
  }

  review(windowId: string, candidate: readonly { blockId: string; text: string }[], terms: SupervisorInput["terms"], surfaceEvidence: readonly SurfaceConsistencyEvidence[] = []): Promise<readonly ValidationFailure[]> {
    return this.#operations.run([windowId], async () => {
      this.options.signal?.throwIfAborted();
      this.#checkPaused(windowId);
      const window = this.options.windows.find(w => w.windowId === windowId);
      if (!window) throw new Error("review window outside supervisor plan");
      let latestPlan = this.#records().findLast(r => r.event === "plan" && r.state === "completed"
        && r.decision?.action === "translate" && r.decision.windowIds.includes(windowId));
      if (candidate.length !== window.blockIds.length || window.blockIds.some(id => !candidate.some(t => t.blockId === id))) {
        throw new Error("supervisor review requires the complete logical window");
      }
      const dependencyHash = this.#dependencyHash(terms, [window]);
      if (latestPlan && (latestPlan.windowDependencyHashes?.[windowId] ?? latestPlan.dependencyHash) !== dependencyHash) {
        // A typed knowledge change can revalidate an already committed window.
        // Require a fresh review of that window, without reauthorizing siblings
        // or carrying guidance authored against an obsolete terminology view.
        const inputHash = supervisionHash({ origin: "host_revalidation", priorPlan: latestPlan.id, dependencyHash, windowId });
        latestPlan = { id: `revalidation-plan:${inputHash}`, key: `revalidation-plan:${windowId}`, event: "plan", state: "completed",
          windowIds: [windowId], inputHash, dependencyHash, origin: "host_revalidation",
          modelCalls: 0, totalTokens: 0, usageComplete: true,
          decision: { action: "translate", windowIds: [windowId], reviewBlockIds: window.blockIds, guidance: [], issues: [],
            reason: "Terminology dependencies changed; review the complete affected candidate." } };
        this.#append(latestPlan);
      }
      const requested = latestPlan?.decision?.reviewBlockIds.some(id => window.blockIds.includes(id));
      if (!requested && !surfaceEvidence.length) return [];
      const base = { ...this.#input("review", [window], terms), candidate, ...(surfaceEvidence.length ? { surfaceEvidence } : {}) };
      const cached = this.#records().findLast(r => r.event === "review" && r.state === "completed" && !r.qualityItemId
        && r.windowIds.includes(windowId) && r.candidateHash === supervisionCandidateHash(candidate) && r.dependencyHash === dependencyHash
        && r.surfaceEvidenceHash === supervisionHash(surfaceEvidence));
      const prior = this.#records().findLast(r => r.event === "review" && r.state === "completed" && !r.qualityItemId
        && r.windowIds.includes(windowId) && r.reviewedCandidate);
      const focus = prior?.reviewedCandidate ? reviewFocus(this.options.sources, candidate, prior.reviewedCandidate, base.terms, prior.reviewedTerms ?? [], surfaceEvidence,
        prior.decision?.issues.map(i => ({ blockId: i.blockId, sourceQuote: i.sourceFocus ?? i.sourceQuote }))) : undefined;
      const input = { ...base, ...(focus ? { reviewFocus: focus } : {}) };
      const decision = cached?.decision ? validateSupervisorDecision(cached.decision, base) : await this.#decide(input, undefined, dependencyHash);
      return decision.issues.map(issue => ({
        issueKey: supervisionHash([issue.blockId, issue.sourceQuote.normalize("NFKC").trim(), issue.problem.normalize("NFKC").trim()]),
        code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: issue.blockId, repairable: true,
        evidence: { sourceQuote: issue.sourceFocus ?? issue.sourceQuote, targetQuote: issue.targetFocus ?? issue.targetQuote, problem: issue.problem },
        message: `原文 ${JSON.stringify(issue.sourceQuote)}；当前译文 ${JSON.stringify(issue.targetQuote)}；问题：${issue.problem}。只修正该实质问题，不改无关内容。`,
      }));
    });
  }

  reviewFinal(qualityItemId: string, windowId: string, candidate: readonly { blockId: string; text: string }[], terms: SupervisorInput["terms"], priorIssues: readonly ValidationFailure[] = []): Promise<readonly ValidationFailure[]> {
    return this.#operations.run([windowId], async () => {
      this.options.signal?.throwIfAborted();
      const window = this.options.windows.find(w => w.windowId === windowId);
      if (!/^[a-f0-9]{64}$/u.test(qualityItemId) || !window || candidate.length !== window.blockIds.length
        || window.blockIds.some(id => !candidate.some(t => t.blockId === id))) throw new Error("invalid final quality review scope");
      const dependencyHash = this.#dependencyHash(terms, [window]);
      const plan = this.#records().findLast(r => r.event === "plan" && r.state === "completed" && r.decision?.action === "translate" && r.windowIds.includes(windowId));
      if ((plan?.windowDependencyHashes?.[windowId] ?? plan?.dependencyHash) !== dependencyHash) {
        const inputHash = supervisionHash({ origin: "host_revalidation", qualityItemId, dependencyHash, windowId });
        this.#append({ id: `quality-plan:${inputHash}`, key: `quality-plan:${windowId}`, event: "plan", state: "completed",
          windowIds: [windowId], inputHash, dependencyHash, origin: "host_revalidation", qualityItemId,
          modelCalls: 0, totalTokens: 0, usageComplete: true,
          decision: { action: "translate", windowIds: [windowId], reviewBlockIds: window.blockIds, guidance: [], issues: [],
            reason: "Final quality review uses the current terminology projection." } });
      }
      const input: SupervisorInput = { ...this.#input("review", [window], terms), candidate,
        ...(priorIssues.length ? { priorIssues: priorQualityIssues(priorIssues), qualityReviewStage: "disposition" } : {}) };
      const decision = await this.#decide(input, undefined, dependencyHash, qualityItemId);
      let verificationIssues: SupervisorDecision["issues"] = [];
      if (decision.dispositions?.some(needsDispositionVerification) && this.canReview(windowId, qualityItemId)) {
        // An independent bounded pass sees the original question, not the proposed verdict.
        verificationIssues = (await this.#decide({ ...input, qualityReviewStage: "verification" }, undefined, dependencyHash, qualityItemId)).issues;
      }
      const closure = this.finalClosure(qualityItemId, candidate);
      const open = priorQualityIssues(priorIssues).flatMap((issue, index) =>
        closure?.dispositions.find(d => d.issueId === issue.issueId)?.status !== "unresolved" && closure ? [] : [priorIssues[index]!]);
      return [...open, ...[...decision.issues, ...verificationIssues].map(issue => ({
        issueKey: supervisionHash([issue.blockId, issue.sourceQuote.normalize("NFKC").trim(), issue.problem.normalize("NFKC").trim()]),
        code: "SUPERVISOR_SEMANTIC_REVIEW", blockId: issue.blockId, repairable: true,
        evidence: { sourceQuote: issue.sourceFocus ?? issue.sourceQuote, targetQuote: issue.targetFocus ?? issue.targetQuote, problem: issue.problem },
        message: `原文 ${JSON.stringify(issue.sourceQuote)}；当前译文 ${JSON.stringify(issue.targetQuote)}；问题：${issue.problem}。只修正该实质问题，不改无关内容。`,
      }))];
    });
  }

  finalClosure(qualityItemId: string, candidate: readonly { blockId: string; text: string }[]): QualityClosure | undefined {
    const candidateHash = supervisionCandidateHash(candidate);
    const records = this.#records().filter(r => r.qualityItemId === qualityItemId && r.candidateHash === candidateHash && r.state === "completed");
    const main = records.findLast(r => r.qualityReviewStage === "disposition");
    if (!main?.decision?.dispositions) return undefined;
    const verification = records.findLast(r => r.qualityReviewStage === "verification");
    const dispositions = main.decision.dispositions.map(d => {
      if (!needsDispositionVerification(d)) return d;
      const confirmed = verification?.decision?.dispositions?.find(v => v.issueId === d.issueId);
      return confirmed?.status === d.status && !verification?.decision?.issues.length ? d : { ...d, status: "unresolved" as const, note: "改判未获得独立核验支持。" };
    });
    return { policy: "issue-closure-1", candidateHash, decisionId: main.id, dispositions,
      ...(verification ? { verificationDecisionId: verification.id } : {}) };
  }

  canReview(windowId: string, qualityItemId?: string, terms?: SupervisorInput["terms"]): boolean {
    const window = this.options.windows.find(w => w.windowId === windowId);
    const dependencyHash = terms && window ? this.#dependencyHash(terms, [window])
      : this.#records().findLast(r => r.event === "plan" && r.state === "completed" && r.windowIds.includes(windowId))?.windowDependencyHashes?.[windowId]
        ?? this.#records().findLast(r => r.event === "plan" && r.state === "completed" && r.windowIds.includes(windowId))?.dependencyHash;
    const all = this.#records().filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(windowId));
    const epoch = (qualityItemId ? all : this.#afterRelease(windowId)).filter(r => r.qualityItemId === qualityItemId
      && r.event === "review" && r.state === "started" && r.windowIds.includes(windowId)
      && (qualityItemId !== undefined || r.dependencyHash === dependencyHash));
    return all.length < 12 && epoch.length < SUPERVISION_POLICY.maxReviewsPerWindow;
  }

  async #decide(input: SupervisorInput, conflictHash?: string, dependencyHash?: string, qualityItemId?: string): Promise<SupervisorDecision> {
    const inputHash = supervisionHash({ protocol: SUPERVISOR_PROTOCOL, ...(qualityItemId ? { qualityItemId } : {}), dependencyHash, sourceVersion: this.options.sourceVersion, event: input.event, windows: input.windows,
      terms: input.terms, candidate: input.candidate, conflicts: input.conflicts,
      ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}),
      ...(input.surfaceEvidence?.length ? { surfaceEvidence: input.surfaceEvidence } : {}),
      ...(input.priorIssues?.length ? { priorIssues: input.priorIssues, qualityReviewStage: input.qualityReviewStage } : {}) });
    const key = `${input.event}:${input.windows[0]!.windowId}:${inputHash}`;
    const cached = this.#records().find(r => r.state === "completed" && r.inputHash === inputHash && r.decision);
    if (cached?.decision) {
      const decision = validateSupervisorDecision(cached.decision, input);
      if (input.event === "plan") this.#append({ ...cached,
        id: `activation:${supervisionHash([cached.id, this.#records().at(-1)?.id])}`,
        modelCalls: 0, totalTokens: 0, usageComplete: true });
      return decision;
    }
    const recoveryScope = `supervision:${input.event}:${input.windows[0]!.windowId}`;
    this.options.recovery?.assertAvailable(recoveryScope);
    const history = (qualityItemId ? this.#records() : this.#afterRelease(input.windows[0]!.windowId)).filter(r => r.qualityItemId === qualityItemId);
    const attempts = history.filter(r => r.key === key && r.state === "started").length;
    const reviews = history.filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(input.windows[0]!.windowId)
      && (qualityItemId !== undefined || r.dependencyHash === dependencyHash)).length;
    const lifetimeReviews = this.#records().filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(input.windows[0]!.windowId)).length;
    const generation = this.#records().filter(r => r.state === "released" && r.windowIds.includes(input.windows[0]!.windowId)).length;
    const attemptId = `${key}:generation-${generation}:attempt-${attempts}`;
    const recordBase = { key, event: input.event, windowIds: input.windows.map(w => w.windowId), inputHash, dependencyHash,
      windowDependencyHashes: Object.fromEntries(input.windows.map(window => [window.windowId, this.#dependencyHash(input.terms, [window])])),
      ...(qualityItemId ? { qualityItemId } : {}),
      ...(input.qualityReviewStage ? { qualityReviewStage: input.qualityReviewStage } : {}),
      ...(input.candidate ? { candidateHash: supervisionCandidateHash(input.candidate) } : {}),
      ...(input.event === "review" ? { ...(JSON.stringify([input.candidate, input.terms]).length <= 32_000
        ? { reviewedCandidate: input.candidate, reviewedTerms: input.terms } : {}),
        surfaceEvidenceHash: supervisionHash(input.surfaceEvidence ?? []), ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}) } : {}),
      ...(conflictHash ? { conflictHash } : {}) };
    if (attempts >= SUPERVISION_POLICY.maxAttemptsPerCheckpoint
      || (input.event === "review" && (reviews >= SUPERVISION_POLICY.maxReviewsPerWindow || lifetimeReviews >= 12))) {
      const id = `${attemptId}:limit`;
      this.#append({ ...recordBase, id, state: "paused", reason: "bounded supervisor checkpoint budget exhausted", modelCalls: 0, totalTokens: 0, usageComplete: true });
      throw new SupervisionPausedError(id, "bounded supervisor checkpoint budget exhausted");
    }
    // Bounds include tool schemas and all permitted evidence returned in the session.
    const { inputUpper, outputUpper } = this.#requestBounds(input);
    if (inputUpper + outputUpper > input.model.contextWindow) throw new Error("supervisor context capacity exceeded before dispatch");
    const predictedTokens = (inputUpper + outputUpper) * (input.maxTurns ?? SUPERVISION_POLICY.maxTurns);
    const baselineId = `supervision:${input.event}:${input.windows[0]!.windowId}:generation-${generation}${qualityItemId ? `:quality-${qualityItemId}` : input.event === "review" ? `:dependency-${dependencyHash}` : ""}`;
    if (!this.options.admission.ledger.state().baselinedTaskIds.has(baselineId)) {
      this.options.admission.addBaseline({ taskIds: [baselineId],
        baselineTokens: predictedTokens * (input.event === "review" ? SUPERVISION_POLICY.maxReviewsPerWindow : SUPERVISION_POLICY.maxAttemptsPerCheckpoint),
        source: "supervision", reason: input.event });
    }
    const transaction = this.options.admission.begin({ requestId: attemptId, purpose: "supervision", taskIds: [baselineId], predictedTokens,
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
      if (!settled && error instanceof ModelProviderError
        && this.options.admission.ledger.state().tokenUsageComplete
        && attempts + 1 < SUPERVISION_POLICY.maxAttemptsPerCheckpoint
        && (input.event !== "review" || (reviews + 1 < SUPERVISION_POLICY.maxReviewsPerWindow && lifetimeReviews + 1 < 12))
        && (this.options.recovery
          ? await this.options.recovery.providerRetry(recoveryScope, error, { supervisor: true, signal: this.options.signal })
          : error.kind === "protocol" && error.run && error.run.usage.totalTokens > 0)) {
        return this.#decide(input, conflictHash, dependencyHash, qualityItemId);
      }
      throw isSupervisionBoundaryError(error) ? error : new SupervisionExecutionError(error);
    }
  }
}
