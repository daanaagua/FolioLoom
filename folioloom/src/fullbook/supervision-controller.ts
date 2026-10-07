import { SUPERVISOR_PROTOCOL, SUPERVISOR_EVIDENCE_PROJECTION, MAX_SUPERVISOR_WINDOWS, validateSupervisorInput, supervisorModelFor, supervisorOutputTokenLimit, runSupervisor, supervisorPrompt, supervisorSystemPrompt, supervisorWireProtocol, usesSupervisorValues, validateSupervisorDecision,
  type SupervisorDecision, type SupervisorInput, type SupervisorSource, type SupervisorWindow } from "../agents/supervisor.js";
import { ModelProviderError, piRunUsageComplete, type PiAssistantResponseObservation } from "../agents/pi-runtime.js";
import { effectiveSystemPrompt } from "../agents/task-context.js";
import { MAX_LIFETIME_REVIEWS_PER_WINDOW, SUPERVISION_POLICY, supervisionCandidateHash, supervisionHash, supervisorIssueFailures, type SupervisionRecord } from "../domain/supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import type { AdmissionController } from "./admission-controller.js";
import type { TranslationRuntime } from "./types.js";
import type { AutomaticRecovery } from "./automatic-recovery.js";
import { ScopedOperationQueue } from "./scoped-operation-queue.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { priorQualityIssues, type QualityClosure } from "../domain/quality-closure.js";
import type { SurfaceConsistencyEvidence } from "../knowledge/surface-consistency.js";
import { reviewFocus } from "./review-focus.js";
import { searchSupervisorTargets } from "../agents/supervisor-target-context.js";

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

/** Safe only at a final review barrier with already committed, validated text. */
export function isDeferrableQualityReviewError(error: unknown): boolean {
  if (error instanceof SupervisionPausedError) return true;
  const cause = error instanceof SupervisionExecutionError ? error.cause : error;
  return cause instanceof ModelProviderError && cause.kind === "protocol" && !!cause.run
    && !cause.run.deadlineExceeded;
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
  /** Read-only committed translation snapshot, acquired only for final quality review. */
  getTargetContext?: () => readonly { blockId: string; text: string }[];
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
    const chars = supervisorPrompt(input).length + effectiveSystemPrompt(input.streamFn, supervisorSystemPrompt(input)).length;
    return { inputUpper: chars * 2 + 20_000, outputUpper: supervisorOutputTokenLimit(input) };
  }
  #append(record: SupervisionRecord): void { this.options.store.appendSupervisionRecord(this.options.runId, record); }
  #chapterComparisonsUnchanged(record: SupervisionRecord, targets: readonly { blockId: string; text: string }[]): boolean {
    if (!record.comparisonQueries || !record.comparisonBlockHashes) return record.reviewContextHash === supervisionCandidateHash(targets);
    const scope = new Set(this.options.windows.filter(w => record.windowIds.includes(w.windowId)).flatMap(w => w.blockIds));
    const input = { sources: this.options.sources, targetContext: targets.filter(t => !scope.has(t.blockId)) };
    return Object.entries(record.comparisonBlockHashes).every(([id, hash]) => {
      const target = targets.find(t => t.blockId === id);
      return target && supervisionCandidateHash([target]) === hash;
    }) && record.comparisonQueries.every(q => supervisionHash(searchSupervisorTargets(input, q.query, q.limit)) === q.resultHash);
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
  #projectTerms(terms: SupervisorInput["terms"], windows: readonly SupervisorWindow[]): SupervisorInput["terms"] {
    const ids = new Set(windows.flatMap(w => w.blockIds));
    const source = this.options.sources.filter(b => ids.has(b.blockId)).map(b => b.sourceText).join("\n").toLocaleLowerCase();
    return terms.filter(t => source.includes(t.sourceForm.toLocaleLowerCase())
      && (!t.applicableBlockIds || t.applicableBlockIds.some(id => ids.has(id))))
      // Revision receipts are provenance, not new translation instructions.
      // All actual rendering, authority, identity, sense and scope fields remain bound.
      .map(({ revisionId: _revisionId, renderFingerprint: _renderFingerprint, ...t }) => ({ ...t, locked: t.locked === true,
        ...(t.applicableBlockIds ? { applicableBlockIds: t.applicableBlockIds.filter(id => ids.has(id)).sort() } : {}) }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  #input(event: "plan" | "review", windows: readonly SupervisorWindow[], terms: SupervisorInput["terms"]): SupervisorInput {
    const runtime = this.options.runtime;
    const projectedTerms = this.#projectTerms(terms, windows);
    return { event, windows, sources: this.options.sources, terms: projectedTerms, model: supervisorModelFor({ event, model: runtime.model }), streamFn: runtime.streamFn,
      maxTurns: 2, thinkingLevel: runtime.thinkingLevel,
      signal: this.options.signal, deadlineMs: this.options.deadlineMs };
  }

  planFor(windowId: string, terms: SupervisorInput["terms"], conflicts: readonly string[] = [], maxWindows: number = SUPERVISION_POLICY.batchWindows): Promise<SupervisorDecision> {
    const index = this.options.windows.findIndex(w => w.windowId === windowId);
    if (index < 0) return Promise.reject(new Error("supervisor window outside plan"));
    if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || maxWindows > SUPERVISION_POLICY.batchWindows)
      return Promise.reject(new Error("invalid supervisor planning frontier"));
    const plannedScope = this.options.windows.slice(index, index + maxWindows);
    return this.#operations.run(plannedScope.map(w => w.windowId), async () => {
      this.options.signal?.throwIfAborted();
      this.#checkPaused(windowId);
      const conflictHash = supervisionHash(conflicts);
      const cached = this.#records().findLast(r => r.event === "plan" && r.state === "completed"
        && r.decision?.action === "translate" && r.decision.windowIds.includes(windowId));
      if (cached?.decision && cached.conflictHash === conflictHash
        && (maxWindows === SUPERVISION_POLICY.batchWindows || cached.windowIds.every(id => plannedScope.some(w => w.windowId === id)))) {
        const scope = this.options.windows.filter(w => cached.windowIds.includes(w.windowId));
        if (cached.dependencyHash === this.#dependencyHash(terms, scope))
          return validateSupervisorDecision(cached.decision, this.#input("plan", scope, terms));
      }
      let windows = plannedScope;
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
    return [...new Map(entries.map(g => [canonicalJson(g), g])).values()];
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
        && r.evidenceProjectionVersion === SUPERVISOR_EVIDENCE_PROJECTION
        && r.windowIds.includes(windowId) && r.candidateHash === supervisionCandidateHash(candidate) && r.dependencyHash === dependencyHash
        && r.surfaceEvidenceHash === supervisionHash(surfaceEvidence));
      const prior = this.#records().findLast(r => r.event === "review" && r.state === "completed" && !r.qualityItemId
        && r.windowIds.includes(windowId) && r.reviewedCandidate);
      const focus = prior?.reviewedCandidate ? reviewFocus(this.options.sources, candidate, prior.reviewedCandidate, base.terms, prior.reviewedTerms ?? [], surfaceEvidence,
        prior.decision?.issues.map(i => ({ blockId: i.blockId, sourceQuote: i.sourceFocus ?? i.sourceQuote, sourceRef: i.sourceRef }))) : undefined;
      const input = { ...base, ...(focus ? { reviewFocus: focus } : {}) };
      const decision = cached?.decision ? validateSupervisorDecision(cached.decision, base) : await this.#decide(input, undefined, dependencyHash);
      return supervisorIssueFailures(decision.issues);
    });
  }

  reviewFinal(qualityItemId: string, windowId: string, candidate: readonly { blockId: string; text: string }[], terms: SupervisorInput["terms"], priorIssues: readonly ValidationFailure[] = [], priorCandidate?: SupervisorInput["priorCandidate"]): Promise<readonly ValidationFailure[]> {
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
      const targetContext = this.options.getTargetContext ? structuredClone(this.options.getTargetContext()) : undefined;
      const priorReview = this.#records().findLast(r => r.event === "review" && r.qualityItemId === qualityItemId && r.state === "completed");
      // A chapter finding already authorizes a repair of the exact same evidence.
      // This is not a closure verdict and cannot accept unchanged text. Legacy
      // receipts without a complete comparison binding take the normal review path.
      if (!priorReview && priorIssues.length && targetContext) {
        const chapter = this.#records().findLast(r => r.event === "review" && r.state === "completed" && r.chapterReview
          && r.evidenceProjectionVersion === SUPERVISOR_EVIDENCE_PROJECTION && r.windowIds.includes(windowId)
          && r.windowDependencyHashes?.[windowId] === dependencyHash && r.decision?.action === "revise"
          && this.#chapterComparisonsUnchanged(r, targetContext)
          && r.candidateHash === supervisionCandidateHash(targetContext.filter(t => this.options.windows
            .filter(w => r.windowIds.includes(w.windowId)).some(w => w.blockIds.includes(t.blockId)))));
        const issues = chapter?.decision?.issues.filter(i => window.blockIds.includes(i.blockId));
        const failures = issues ? supervisorIssueFailures(issues) : [];
        if (chapter && issues && failures.length === priorIssues.length
          && supervisionCandidateHash(candidate) === supervisionCandidateHash(targetContext.filter(t => window.blockIds.includes(t.blockId)))
          && priorIssues.every(issue => failures.some(f => canonicalJson(f) === canonicalJson(issue)))) {
          const inputHash = supervisionHash({ qualityItemId, reusedFrom: chapter.id, candidateHash: supervisionCandidateHash(candidate), dependencyHash });
          this.#append({ id: `chapter-reuse:${inputHash}`, key: `chapter-reuse:${qualityItemId}`, event: "review", state: "completed",
            origin: "host_reuse", reusedFromDecisionId: chapter.id, qualityItemId, windowIds: [windowId], inputHash, dependencyHash,
            evidenceProjectionVersion: SUPERVISOR_EVIDENCE_PROJECTION, candidateHash: supervisionCandidateHash(candidate),
            ...(JSON.stringify([candidate, this.#projectTerms(terms, [window])]).length <= 32_000
              ? { reviewedCandidate: candidate, reviewedTerms: this.#projectTerms(terms, [window]) } : {}),
            modelCalls: 0, totalTokens: 0, usageComplete: true,
            decision: { action: "revise", windowIds: [windowId], reviewBlockIds: [], guidance: [], issues,
              reason: "Reuse the unchanged grounded chapter findings for repair; closure still requires review." } });
          return failures;
        }
      }
      const previous = this.#records().findLast(r => r.qualityItemId === qualityItemId && r.state === "completed" && r.decision?.action === "revise");
      const repairIntents = priorQualityIssues(priorIssues).flatMap(issue => {
        const disposition = previous?.decision?.dispositions?.find(d => d.issueId === issue.issueId && d.status === "unresolved");
        const chapterIssue = previous?.origin === "host_reuse" ? previous.decision?.issues.find(i => i.blockId === issue.blockId
          && i.problem === issue.problem && (i.sourceFocus ?? i.sourceQuote) === issue.sourceQuote) : undefined;
        const instruction = disposition?.note ?? chapterIssue?.problem;
        return instruction ? [{ issueId: issue.issueId, instruction }] : [];
      });
      const base = this.#input("review", [window], terms);
      const focus = priorReview?.candidateHash === supervisionCandidateHash(candidate) && priorReview.dependencyHash === dependencyHash
        ? priorReview.reviewFocus : priorReview?.reviewedCandidate ? reviewFocus(this.options.sources, candidate, priorReview.reviewedCandidate,
        base.terms, priorReview.reviewedTerms ?? [], [], [
          ...priorQualityIssues(priorIssues).map(i => ({ blockId: i.blockId, sourceQuote: i.sourceQuote, sourceRef: i.sourceRef })),
          ...(priorReview.decision?.issues.map(i => ({ blockId: i.blockId, sourceQuote: i.sourceFocus ?? i.sourceQuote, sourceRef: i.sourceRef })) ?? []),
        ]) : undefined;
      const input: SupervisorInput = { ...base, candidate, ...(priorCandidate ? { priorCandidate } : {}),
        ...(focus ? { reviewFocus: focus } : {}),
        ...(targetContext ? { targetContext: targetContext
          .filter(t => !window.blockIds.includes(t.blockId)) } : {}),
        ...(priorIssues.length ? { priorIssues: priorQualityIssues(priorIssues), qualityReviewStage: "disposition",
          reviewMode: "occurrence_cards", repairIntents } : {}) };
      const decision = await this.#decide(input, undefined, dependencyHash, qualityItemId);
      const closure = this.finalClosure(qualityItemId, candidate);
      const open = priorQualityIssues(priorIssues).flatMap((issue, index) => {
        const disposition = closure?.dispositions.find(d => d.issueId === issue.issueId);
        if (closure && disposition?.status !== "unresolved") return [];
        const original = priorIssues[index]!;
        const matchesSource = (quote: string) => !!issue.sourceQuote && !!quote
          && (quote.includes(issue.sourceQuote) || issue.sourceQuote.includes(quote));
        // Original findings remain immutable closure input. Only repair execution
        // uses fresh evidence from this exact candidate's validated review receipt.
        const currentEvidence = disposition?.sourceRef && disposition.targetRef && matchesSource(disposition.sourceQuote)
          ? disposition : decision.issues.find(i => i.blockId === issue.blockId && i.sourceRef && i.targetRef && matchesSource(i.sourceQuote));
        if (!currentEvidence?.targetQuote) return [original];
        const sourceQuote = currentEvidence.sourceQuote.includes(issue.sourceQuote) ? issue.sourceQuote : currentEvidence.sourceQuote;
        const targetQuote = issue.targetQuote && currentEvidence.targetQuote.includes(issue.targetQuote) ? issue.targetQuote : currentEvidence.targetQuote;
        const repairInstruction = "note" in currentEvidence ? currentEvidence.note : currentEvidence.problem;
        return [{ ...original, evidence: { sourceQuote, targetQuote, problem: issue.problem,
          repairInstruction,
          sourceRef: currentEvidence.sourceRef, targetRef: currentEvidence.targetRef,
          sourceScopeQuote: currentEvidence.sourceQuote, targetScopeQuote: currentEvidence.targetQuote },
          message: `原文 ${JSON.stringify(sourceQuote)}；当前译文 ${JSON.stringify(targetQuote)}；问题：${issue.problem}。只修正该实质问题，不改无关内容。` }];
      });
      return [...open, ...supervisorIssueFailures(decision.issues)];
    });
  }

  finalClosure(qualityItemId: string, candidate: readonly { blockId: string; text: string }[]): QualityClosure | undefined {
    const candidateHash = supervisionCandidateHash(candidate);
    const records = this.#records().filter(r => r.qualityItemId === qualityItemId && r.candidateHash === candidateHash && r.state === "completed");
    const main = records.findLast(r => r.qualityReviewStage === "disposition");
    if (!main?.decision?.dispositions) return undefined;
    // Classifications explain a grounded judgment; they are not ballots that a
    // second model must repeat. Concrete new issues remain separate repair work.
    return { policy: "issue-closure-2", candidateHash, decisionId: main.id, dispositions: main.decision.dispositions };
  }

  canReview(windowId: string, qualityItemId?: string, terms?: SupervisorInput["terms"]): boolean {
    const window = this.options.windows.find(w => w.windowId === windowId);
    const dependencyHash = terms && window ? this.#dependencyHash(terms, [window])
      : this.#records().findLast(r => r.event === "plan" && r.state === "completed" && r.windowIds.includes(windowId))?.windowDependencyHashes?.[windowId]
        ?? this.#records().findLast(r => r.event === "plan" && r.state === "completed" && r.windowIds.includes(windowId))?.dependencyHash;
    const all = this.#records().filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(windowId));
    const epoch = (qualityItemId ? all : this.#afterRelease(windowId)).filter(r => !r.chapterReview && r.qualityItemId === qualityItemId
      && r.event === "review" && r.state === "started" && r.windowIds.includes(windowId)
      && (qualityItemId !== undefined || r.dependencyHash === dependencyHash));
    return all.length < MAX_LIFETIME_REVIEWS_PER_WINDOW && epoch.length < SUPERVISION_POLICY.maxReviewsPerWindow;
  }

  reviewChapter(scopeId: string, title: string, windowIds: readonly string[], terms: SupervisorInput["terms"], lexicalReviewHints: SupervisorInput["lexicalReviewHints"] = []): Promise<{ decisionId: string; windowIds: readonly string[] }> {
    return this.#operations.run(windowIds, async () => {
      this.options.signal?.throwIfAborted();
      if (!/^[a-f0-9]{64}$/u.test(scopeId) || !windowIds.length || new Set(windowIds).size !== windowIds.length) throw new Error("invalid chapter review scope");
      let windows = windowIds.map(id => {
        this.#checkPaused(id);
        const window = this.options.windows.find(w => w.windowId === id);
        if (!window) throw new Error("chapter review window outside source");
        return window;
      });
      if (windows.some((w, i) => i > 0 && w.ordinal !== windows[i - 1]!.ordinal + 1)) throw new Error("chapter review requires contiguous windows");
      windows = windows.slice(0, MAX_SUPERVISOR_WINDOWS);
      const targets = this.options.getTargetContext?.() ?? [];
      const makeInput = (): SupervisorInput => {
        const ids = new Set(windows.flatMap(w => w.blockIds));
        const candidate = targets.filter(t => ids.has(t.blockId));
        if (candidate.length !== ids.size) throw new Error("chapter review requires complete committed translations");
        return { ...this.#input("review", windows, terms), candidate, targetContext: targets.filter(t => !ids.has(t.blockId)),
          lexicalReviewHints: lexicalReviewHints.filter(h => h.occurrences.some(o => ids.has(o.blockId))),
          chapterReview: { scopeId, title } };
      };
      let input = makeInput();
      while (windows.length > 1) {
        const bounds = this.#requestBounds(input);
        if (bounds.inputUpper + bounds.outputUpper <= input.model.contextWindow) break;
        windows = windows.slice(0, -1);
        input = makeInput();
      }
      await this.#decide(input, undefined, this.#dependencyHash(terms, windows));
      const record = this.#records().findLast(r => r.state === "completed" && r.chapterReview?.scopeId === scopeId
        && r.candidateHash === supervisionCandidateHash(input.candidate!) && canonicalJson(r.windowIds) === canonicalJson(windows.map(w => w.windowId)));
      if (!record) throw new Error("chapter review has no durable decision");
      return { decisionId: record.id, windowIds: record.windowIds };
    });
  }

  async #decide(input: SupervisorInput, conflictHash?: string, dependencyHash?: string, qualityItemId?: string): Promise<SupervisorDecision> {
    validateSupervisorInput(input);
    const inputHash = supervisionHash({ protocol: SUPERVISOR_PROTOCOL, ...(input.event === "review" ? { evidenceProjectionVersion: SUPERVISOR_EVIDENCE_PROJECTION } : {}), ...(qualityItemId ? { qualityItemId } : {}), dependencyHash, sourceVersion: this.options.sourceVersion, event: input.event, windows: input.windows,
      terms: input.terms, candidate: input.candidate, conflicts: input.conflicts,
      ...(input.chapterReview ? { chapterReview: input.chapterReview } : {}),
      ...(input.lexicalReviewHints?.length ? { lexicalReviewHints: input.lexicalReviewHints } : {}),
      ...(input.targetContext !== undefined ? { targetContextHash: supervisionHash(input.targetContext) } : {}),
      ...(input.priorCandidate ? { priorCandidateHash: supervisionCandidateHash(input.priorCandidate) } : {}),
      ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}),
      ...(input.surfaceEvidence?.length ? { surfaceEvidence: input.surfaceEvidence } : {}),
      ...(input.priorIssues?.length ? { priorIssues: input.priorIssues, qualityReviewStage: input.qualityReviewStage,
        reviewMode: input.reviewMode, repairIntents: input.repairIntents } : {}) });
    const key = `${input.event}:${input.windows[0]!.windowId}:${inputHash}`;
    const cached = this.#records().find(r => r.state === "completed" && r.inputHash === inputHash && r.decision
      && (input.event !== "review" || r.evidenceProjectionVersion === SUPERVISOR_EVIDENCE_PROJECTION));
    if (cached?.decision) {
      const decision = validateSupervisorDecision(cached.decision, input);
      if (input.event === "plan") this.#append({ ...cached,
        id: `activation:${supervisionHash([cached.id, this.#records().at(-1)?.id])}`,
        modelCalls: 0, totalTokens: 0, usageComplete: true });
      return decision;
    }
    const generation = this.#records().filter(r => r.state === "released" && r.windowIds.includes(input.windows[0]!.windowId)).length;
    // An explicit release renews the ordinary checkpoint and its recovery scope
    // together. Historical faults and run/lifetime caps remain durable. Final
    // quality epochs are independent and cannot be renewed by an ordinary release.
    const recoveryScope = `supervision:${input.event}:${input.windows[0]!.windowId}${input.chapterReview ? `:chapter-${input.chapterReview.scopeId}` : ""}${qualityItemId
      ? `:quality-${qualityItemId}` : generation ? `:generation-${generation}` : ""}`;
    this.options.recovery?.assertAvailable(recoveryScope);
    const history = (qualityItemId ? this.#records() : this.#afterRelease(input.windows[0]!.windowId)).filter(r => r.qualityItemId === qualityItemId
      && r.chapterReview?.scopeId === input.chapterReview?.scopeId);
    const attempts = history.filter(r => r.key === key && r.state === "started").length;
    const reviews = Math.max(...input.windows.map(window => history.filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(window.windowId)
      && (qualityItemId !== undefined || r.dependencyHash === dependencyHash)).length));
    const lifetimeReviews = Math.max(...input.windows.map(window => this.#records().filter(r => r.event === "review" && r.state === "started" && r.windowIds.includes(window.windowId)).length));
    const attemptId = `${key}:generation-${generation}:attempt-${attempts}`;
    const recordBase = { key, event: input.event, windowIds: input.windows.map(w => w.windowId), inputHash, dependencyHash,
      wireProtocol: supervisorWireProtocol(input),
      ...(input.event === "review" ? { evidenceProjectionVersion: SUPERVISOR_EVIDENCE_PROJECTION } : {}),
      windowDependencyHashes: Object.fromEntries(input.windows.map(window => [window.windowId, this.#dependencyHash(input.terms, [window])])),
      ...(qualityItemId ? { qualityItemId } : {}),
      ...(input.qualityReviewStage ? { qualityReviewStage: input.qualityReviewStage } : {}),
      ...(input.reviewMode ? { reviewMode: input.reviewMode, repairIntents: input.repairIntents } : {}),
      ...(input.chapterReview ? { chapterReview: input.chapterReview } : {}),
      ...(input.candidate ? { candidateHash: supervisionCandidateHash(input.candidate) } : {}),
      ...(input.chapterReview && input.targetContext ? { reviewContextHash: supervisionCandidateHash([...(input.candidate ?? []), ...input.targetContext]) } : {}),
      ...(input.chapterReview ? { comparisonBlockHashes: Object.fromEntries((input.lexicalReviewHints ?? [])
        .flatMap(h => h.examples).flatMap(example => {
          const target = [...(input.candidate ?? []), ...(input.targetContext ?? [])].find(t => t.blockId === example.blockId);
          return target ? [[target.blockId, supervisionCandidateHash([target])]] : [];
        })) } : {}),
      ...(input.event === "review" ? { ...(JSON.stringify([input.candidate, input.terms]).length <= 32_000
        ? { reviewedCandidate: input.candidate, reviewedTerms: input.terms } : {}),
        surfaceEvidenceHash: supervisionHash(input.surfaceEvidence ?? []), ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}) } : {}),
      ...(conflictHash ? { conflictHash } : {}) };
    if (attempts >= SUPERVISION_POLICY.maxAttemptsPerCheckpoint
      || (input.event === "review" && (reviews >= SUPERVISION_POLICY.maxReviewsPerWindow || lifetimeReviews >= MAX_LIFETIME_REVIEWS_PER_WINDOW))) {
      const id = `${attemptId}:limit`;
      this.#append({ ...recordBase, id, state: "paused", reason: "bounded supervisor checkpoint budget exhausted", modelCalls: 0, totalTokens: 0, usageComplete: true });
      throw new SupervisionPausedError(id, "bounded supervisor checkpoint budget exhausted");
    }
    // Bounds include tool schemas and all permitted evidence returned in the session.
    const { inputUpper, outputUpper } = this.#requestBounds(input);
    if (inputUpper + outputUpper > input.model.contextWindow) throw new Error("supervisor context capacity exceeded before dispatch");
    const predictedTokens = (inputUpper + outputUpper) * (input.maxTurns ?? SUPERVISION_POLICY.maxTurns);
    const baselineId = `supervision:${input.event}:${input.windows[0]!.windowId}:generation-${generation}${input.chapterReview ? `:chapter-${input.chapterReview.scopeId}` : ""}${qualityItemId ? `:quality-${qualityItemId}` : input.event === "review" ? `:dependency-${dependencyHash}` : ""}`;
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
      const usageComplete = piRunUsageComplete(result.run);
      transaction.settle({ actualTokens: result.run.usage.totalTokens, usageComplete, outcome: "success" });
      settled = true;
      const id = `${attemptId}:result`;
      this.#append({ ...recordBase, id, state: result.decision.action === "pause" ? "paused" : "completed", decision: result.decision,
        ...(input.chapterReview ? { comparisonQueries: result.comparisonQueries } : {}),
        reason: result.decision.reason, modelCalls: result.run.modelCalls, totalTokens: result.run.usage.totalTokens, usageComplete });
      if (result.decision.action === "pause") throw new SupervisionPausedError(id, result.decision.reason);
      return result.decision;
    } catch (error) {
      if (!settled) {
        const run = error instanceof ModelProviderError ? error.run : undefined;
        const usageComplete = run !== undefined && piRunUsageComplete(run);
        transaction.settle({ actualTokens: run?.usage.totalTokens ?? 0, usageComplete, outcome: "failed" });
        this.#append({ ...recordBase, id: `${attemptId}:failed`, state: "failed", modelCalls: run?.modelCalls ?? 0,
          totalTokens: run?.usage.totalTokens ?? 0, usageComplete, reason: error instanceof Error ? error.message : "supervisor execution failed" });
      }
      if (!settled && error instanceof ModelProviderError
        && error.run && piRunUsageComplete(error.run)
        && attempts + 1 < SUPERVISION_POLICY.maxAttemptsPerCheckpoint
        && (input.event !== "review" || (reviews + 1 < SUPERVISION_POLICY.maxReviewsPerWindow && lifetimeReviews + 1 < MAX_LIFETIME_REVIEWS_PER_WINDOW))
        && (this.options.recovery
          ? await this.options.recovery.providerRetry(recoveryScope, error, { supervisor: true, signal: this.options.signal })
          : error.kind === "protocol" && error.run && piRunUsageComplete(error.run))) {
        const retryInput = usesSupervisorValues(input) && error.kind === "protocol" ? { ...input,
          protocolFeedback: error.message.split(/\r?\n/u).slice(0, 3).join(" ").slice(0, 400) } : input;
        return this.#decide(retryInput, conflictHash, dependencyHash, qualityItemId);
      }
      throw isSupervisionBoundaryError(error) ? error : new SupervisionExecutionError(error);
    }
  }
}
