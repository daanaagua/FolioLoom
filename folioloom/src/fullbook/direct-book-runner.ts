import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PiRuntime, ModelProviderError, piRunUsageComplete, type PiRunResult } from "../agents/pi-runtime.js";
import { bindTaskContext, taskContextMetadata } from "../agents/task-context.js";
import { BudgetLedger } from "../kernel/budget.js";
import { RunLease } from "../kernel/run-lease.js";
import { createKnowledgeSnapshot } from "../knowledge/snapshot.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { SourceLedger } from "../source/source-ledger.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import type { LosslessBookRunOptions, LosslessBookRunResult } from "./book-runner.js";
import { BookContext } from "./book-context.js";
import { planBookWindows } from "./window-planner.js";
import type { TranslationRuntime } from "./types.js";
import { AdmissionController } from "./admission-controller.js";
import type { LedgerEvent } from "./token-ledger.js";
import { emptyRevalidationDrainReport } from "./revalidation-executor.js";
import { DirectNameWave } from "./direct-name-wave.js";
import { preflightProviderStream } from "../providers/preflight.js";
import { directAttemptLimit } from "./direct-recovery.js";
import { DIRECT_TRANSLATION_VERSION, DIRECT_SYSTEM_PROMPT, DirectOutputError, buildDirectPrompt, directHash,
  DIRECT_MEMORY_VERSION, DIRECT_MEMORY_SYSTEM_PROMPT, DirectNamingConflict, assertDirectNamesCompatible, relevantDirectNames,
  DIRECT_TYPED_VERSION, DIRECT_TYPED_SYSTEM_PROMPT, directNameKey, equivalentDirectRendering,
  directParagraphs, directNameCandidates, parseDirectResponse,
  type DirectName, type DirectParagraph, type DirectRecord, type DirectTranslation } from "./direct-translation.js";

export class DirectRecoveryPausedError extends Error {
  readonly code = "DIRECT_RECOVERY_PAUSED";
  readonly retryable = false;
  constructor(scope: string) { super(`DIRECT_RECOVERY_PAUSED: attempt limit reached for ${scope}; completed work is retained`); }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/** One generation session per source window; no model planning, research or semantic review. */
export async function runDirectBook(options: LosslessBookRunOptions): Promise<LosslessBookRunResult> {
  const startedAt = performance.now();
  const runtime: TranslationRuntime = options.runtimeSet?.primary ?? { model: options.model, streamFn: options.streamFn, thinkingLevel: "high" };
  if (runtime.executionPolicy || runtime.model.provider.startsWith("external-")) throw new Error("direct workflow requires the native provider API");
  if (options.supervisorMode === "bounded" || options.chapterReviewMode === "bounded" || options.planningMode === "source")
    throw new Error("direct workflow cannot enable model supervision or chapter review");
  const maxConcurrency = positive(options.maxConcurrency ?? 2, "maxConcurrency");
  const maxAttempts = positive(options.maxAttempts ?? 4, "maxAttempts");
  if (maxAttempts > 8) throw new Error("direct maxAttempts cannot exceed 8");
  const limit = options.maxWindows ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("maxWindows must be a nonnegative safe integer");
  const runId = options.runMeta.runId;
  if (!runId?.trim()) throw new Error("runMeta.runId is required");
  await preflightProviderStream(runtime.streamFn, options.signal, true);
  const context = BookContext.openLossless({ manifestPath: options.manifestPath, legacyV4DbPath: options.legacyV4DbPath });
  mkdirSync(dirname(resolve(options.storePath)), { recursive: true });
  let lease: ReturnType<typeof RunLease.acquire> | undefined;
  let store: LosslessBookStore | undefined;
  try {
    lease = RunLease.acquire(`${resolve(options.storePath)}.run.lock`, `lossless:${runId}`);
    store = new LosslessBookStore(options.storePath);
    const db = store;
    const existing = db.listTranslationRuns().find(r => r.runId === runId);
    const recordedVersion = (existing?.metadata as any)?.workflow?.version;
    const typed = !existing || recordedVersion === DIRECT_TYPED_VERSION;
    const learning = typed || recordedVersion === DIRECT_MEMORY_VERSION;
    if (existing && ![DIRECT_TRANSLATION_VERSION, DIRECT_MEMORY_VERSION, DIRECT_TYPED_VERSION].includes(recordedVersion))
      throw new Error("unsupported direct workflow version");
    const version = typed ? DIRECT_TYPED_VERSION : learning ? DIRECT_MEMORY_VERSION : DIRECT_TRANSLATION_VERSION;
    const systemPrompt = typed ? DIRECT_TYPED_SYSTEM_PROMPT : learning ? DIRECT_MEMORY_SYSTEM_PROMPT : DIRECT_SYSTEM_PROMPT;
    const blocks = context.losslessBlocks;
    const maxSourceTokens = options.windowOptions?.maxSourceTokens ?? 4_800;
    const windows = planBookWindows(blocks, { ...options.windowOptions,
      targetSourceTokens: options.windowOptions?.targetSourceTokens ?? Math.min(3_600, maxSourceTokens),
      maxSourceTokens, maxBlocks: options.windowOptions?.maxBlocks ?? 6, protocolVersion: options.runMeta.protocolVersion });
    const candidates = directNameCandidates(blocks, context.languageProfile);
    const userNames: DirectName[] = [...context.stableTerms, ...(options.glossary?.stableTerms ?? [])]
      .map(t => ({ source: t.sourceForm, target: t.target, ...(t.applicableBlockIds ? { applicableBlockIds: t.applicableBlockIds } : {}) }));
    const modelId = options.runMeta.modelId ?? runtime.model.id;
    if (modelId !== runtime.model.id) throw new Error("direct run model mismatch");
    if (options.glossary?.sourceVersion && options.glossary.sourceVersion !== context.sourceLedger.sourceVersion)
      throw new Error("glossary source version mismatch");
    const identity = { version, promptHash: directHash(systemPrompt), source: context.sourceLedger.sourceVersion,
      plan: windows, candidates, names: userNames, style: options.styleState ?? null,
      model: { id: modelId, provider: runtime.model.provider, api: runtime.model.api, baseUrl: runtime.model.baseUrl,
        contextWindow: runtime.model.contextWindow, maxTokens: runtime.model.maxTokens,
        effort: runtime.effort ?? null, thinkingLevel: runtime.thinkingLevel ?? "high" },
      taskContext: options.taskContext === undefined ? null : taskContextMetadata(options.taskContext) };
    const identityHash = directHash(identity);
    if (existing && (existing.metadata as any)?.workflow?.name !== "direct") throw new Error("translation workflow mismatch; existing run uses supervised workflow");
    if (existing && (existing.metadata as any)?.workflow?.identityHash !== identityHash)
      throw new Error("direct workflow identity mismatch; resume requires original source, model, context, style, names and plan");
    const metadata = existing?.metadata ?? { ...(options.runMeta.metadata as object ?? {}),
      workflow: { name: "direct", version, identityHash },
      sourceLanguageProfile: { id: context.languageProfile.id, version: context.languageProfile.version,
        compatibilityMode: context.sourceLedger.sourceLanguageCompatibilityMode },
      ...(options.taskContext === undefined ? {} : { taskContext: taskContextMetadata(options.taskContext) }),
      translationRuntime: { mode: options.runtimeSet?.mode ?? "quality", primary: identity.model, escalation: identity.model } };
    db.registerSource(context.certifiedSource!);
    db.replaceDerivedPlan(context.sourceLedger.sourceVersion, { blocks, annotations: context.annotations });
    const initial = createKnowledgeSnapshot(runId, []);
    db.createTranslationRun({ runId, sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: options.runMeta.protocolVersion, modelId, metadata, initialSnapshotId: initial.id, initialSnapshot: initial });
    db.initializeWindowPlan(runId, windows);
    db.recoverInterruptedWindows(runId);
    db.setDeliveryMode(runId, options.deliveryMode ?? db.deliveryMode(runId) ?? "strict");
    const snapshot = db.latestKnowledgeSnapshot(runId);
    const records = db.directRecords(runId);
    const append = (record: DirectRecord) => { db.appendDirectRecord(runId, record); records.push(record); };
    const ledger = db.loadTokenLedger(runId, { mode: options.schedulerMode ?? "off", profile: options.optimizationProfile ?? "balanced",
      tokenIncreaseCap: 0.1, enforceDispatchLifecycle: true });
    const persist = (event: LedgerEvent) => { db.appendTokenLedgerEvent(runId, event); ledger.apply(event); };
    const admission = new AdmissionController({ ledger, mode: options.schedulerMode ?? "off", persist });
    const responseFor = (requestId: string) => records.find(r => r.kind === "response" && r.payload.requestId === requestId);
    const reconcile = () => {
      for (const reservation of ledger.state().openReservations.values()) {
        const receipt = responseFor(reservation.requestId);
        persist(ledger.state().dispatchedRequestIds.has(reservation.requestId)
          ? { type: "settled", requestId: reservation.requestId, actualTokens: Number(receipt?.payload.totalTokens ?? 0),
              usageComplete: receipt?.payload.usageComplete === true, outcome: "cancelled" }
          : { type: "released", requestId: reservation.requestId, reason: "not_launched" });
      }
    };
    reconcile();
    const stream = bindTaskContext(runtime.streamFn, options.taskContext);
    const allParagraphs = directParagraphs(blocks);
    const byBlock = new Map(blocks.map(b => [b.id, b]));
    let names = [...userNames];
    const currentNames = (paragraphs: readonly DirectParagraph[], catalog: readonly DirectName[] = db.directNames(runId)): DirectName[] => {
      const explicit = relevantDirectNames(userNames, paragraphs);
      return [...explicit, ...relevantDirectNames(catalog, paragraphs).filter(n => !explicit.some(e => e.source === n.source))];
    };
    const firstCheckpoint = records.find(r => r.kind === "checkpoint" && r.windowId === windows[0]?.windowId);
    if (!userNames.length && firstCheckpoint) names = (firstCheckpoint.payload.names as DirectName[]) ?? [];
    let completedThisInvocation = 0;
    let stop: unknown;
    let seedFinished = userNames.length > 0 || !!firstCheckpoint;
    const waves: LosslessBookRunResult["waves"] = [];
    const capacity = positive(options.maxInFlightTokens ?? Math.min(256_000, runtime.model.contextWindow * maxConcurrency), "maxInFlightTokens");
    let inFlightTokens = 0;
    let inFlightRequests = 0;
    const capacityWaiters = new Set<() => void>();
    const acquireCapacity = async (tokens: number) => {
      if (tokens > capacity) throw new Error("DIRECT_INPUT_CAPACITY: in-flight token limit cannot admit this request");
      while (inFlightTokens + tokens > capacity || inFlightRequests >= maxConcurrency) {
        options.signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const finish = () => { capacityWaiters.delete(finish); options.signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => { capacityWaiters.delete(finish); reject(options.signal?.reason ?? new Error("aborted")); };
          capacityWaiters.add(finish); options.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      options.signal?.throwIfAborted();
      if (stop) throw stop;
      inFlightTokens += tokens;
      inFlightRequests++;
      return () => { inFlightTokens -= tokens; inFlightRequests--; for (const wake of [...capacityWaiters]) wake(); };
    };

    const execute = async (windowId: string, paragraphs: DirectParagraph[], seed: boolean, depth = 0, sharedNames = names, repair = false): Promise<DirectTranslation> => {
      options.signal?.throwIfAborted();
      const first = allParagraphs.findIndex(p => p.id === paragraphs[0]?.id);
      const last = allParagraphs.findIndex(p => p.id === paragraphs.at(-1)?.id);
      const neighbors = [allParagraphs[first - 1]?.source.slice(-600), allParagraphs[last + 1]?.source.slice(0, 600)].filter((s): s is string => !!s);
      const prompt = buildDirectPrompt({ paragraphs, candidates, names: sharedNames, neighbors, seed, style: options.styleState, typed });
      const key = directHash(typed ? [identityHash, windowId, paragraphs.map(p => p.id), sharedNames, seed, repair] : [identityHash, windowId, paragraphs.map(p => p.id), sharedNames, seed]);
      const parse = (text: string) => {
        const result = parseDirectResponse(text, paragraphs, seed ? candidates : [], typed ? "typed" : learning);
        if (learning && (!typed || repair)) assertDirectNamesCompatible(result.names, sharedNames);
        return result;
      };
      // Every completed response can be replayed after a crash, even before window promotion.
      // Version two can acquire more names while an earlier window is paused. Its
      // immutable run/source identity still permits replay of the same exact input,
      // but every candidate must satisfy both saved and current naming constraints.
      const legacyReplay = learning && !typed;
      const paragraphIds = canonicalJson(paragraphs.map(p => p.id));
      const eligibleRequests = new Set(legacyReplay ? records.filter(r => r.kind === "request" && r.windowId === windowId
        && r.payload.seed === seed && canonicalJson(r.payload.paragraphIds) === paragraphIds).map(r => r.id) : []);
      const responses = records.filter(r => r.kind === "response" && (r.key === key
        || (legacyReplay && r.windowId === windowId && eligibleRequests.has(String(r.payload.requestId)))));
      for (const response of responses) {
        if (response.payload.stopReason !== "stop") continue;
        try {
          const result = parse(String(response.payload.text));
          if (legacyReplay) assertDirectNamesCompatible(result.names, currentNames(paragraphs));
          if (response.key !== key) {
            const id = `replay:${directHash([key, response.id])}`;
            if (!records.some(r => r.id === id)) append({ id, kind: "replay", windowId, key, at: Date.now(),
              payload: { requestId: response.payload.requestId, responseId: response.id, originalKey: response.key } });
          }
          return result;
        }
        catch (error) { if (!(error instanceof DirectOutputError) && !(error instanceof DirectNamingConflict)) throw error; }
      }
      if (records.some(r => r.kind === "split" && r.key === key)) return split();
      const predictedTokens = Math.ceil((prompt.length + systemPrompt.length) * 1.5) + runtime.model.maxTokens;
      if (predictedTokens > runtime.model.contextWindow) {
        if (paragraphs.length > 1 && depth < 12) return split();
        throw new Error("DIRECT_INPUT_CAPACITY: source paragraph exceeds model capacity");
      }
      const baselineKey = `direct-window:${windowId}`;
      admission.addBaseline({ taskIds: [baselineKey], baselineTokens: predictedTokens * maxAttempts, source: "translate_horizon", reason: "direct bounded generation" });
      let attempt = records.filter(r => r.kind === "request" && r.key === key).length;
      const attemptLimit = directAttemptLimit(records, windowId, maxAttempts, identityHash);
      while (ledger.state().terminalRequestIds.has(`direct:${key}:${attempt}`)) attempt++;
      if (attempt >= attemptLimit || records.filter(r => r.kind === "request" && r.windowId === windowId).length >= attemptLimit)
        throw new DirectRecoveryPausedError(windowId);
      for (; attempt < attemptLimit; attempt++) {
        options.signal?.throwIfAborted();
        if (records.filter(r => r.kind === "request" && r.windowId === windowId).length >= attemptLimit) throw new DirectRecoveryPausedError(windowId);
        const waiting = records.findLast(r => r.kind === "retry" && r.key === key);
        const waitMs = Math.max(0, Number(waiting?.payload.nextAttemptAt ?? 0) - Date.now());
        if (waitMs) await delay(waitMs, undefined, { signal: options.signal });
        options.signal?.throwIfAborted();
        const requestId = `direct:${key}:${attempt}`;
        const releaseCapacity = await acquireCapacity(predictedTokens);
        let result: PiRunResult | undefined;
        let failure: unknown;
        try {
          const transaction = admission.begin({ requestId, taskIds: [baselineKey], purpose: "translate", predictedTokens, attempt, conservativeHorizonFloor: 0 });
          append({ id: requestId, kind: "request", windowId, key, at: Date.now(), payload: { paragraphIds: paragraphs.map(p => p.id), seed } });
          transaction.markDispatched();
          try {
            result = await new PiRuntime().run({ systemPrompt, prompt, phase: "translation", model: runtime.model,
              tools: [], budget: new BudgetLedger({ modelCalls: 1, translationTurns: 1 }), maxTurns: 1,
              thinkingLevel: runtime.thinkingLevel ?? "high", deadlineMs: options.hardDeadlineMs ?? 240_000, signal: options.signal,
              onAssistantResponse: observation => {
                db.appendProviderResponseEvidence({ runId, requestId, snapshotId: snapshot.id, phase: "translation",
                  responseProtocol: "framed_text", modelCallOrdinal: observation.modelCallOrdinal,
                  requestHash: observation.requestHash, assistantMessage: observation.assistantMessage });
                const message = observation.assistantMessage;
                const partial: PiRunResult = { modelCalls: 1, toolNames: [], toolErrors: [], usage: message.usage, durationMs: 0,
                  stopReason: message.stopReason, messages: [message], providerResponses: [message], deadlineExceeded: false, turnLimitReached: false };
                append({ id: `${requestId}:response`, kind: "response", windowId, key, at: Date.now(), payload: { requestId,
                  text: message.content.filter(c => c.type === "text").map(c => c.text).join(""), stopReason: message.stopReason,
                  totalTokens: message.usage.totalTokens, usageComplete: piRunUsageComplete(partial) } });
              } }, stream);
          } catch (error) { failure = error; result = error instanceof ModelProviderError ? error.run : undefined; }
          transaction.settle({ actualTokens: result?.usage.totalTokens ?? 0, usageComplete: !!result && piRunUsageComplete(result),
            outcome: failure ? "failed" : result?.deadlineExceeded ? "cancelled" : "success" });
        } finally { releaseCapacity(); }
        options.signal?.throwIfAborted();
        if (!failure) {
          if (result?.deadlineExceeded) failure = new ModelProviderError("direct request timeout", "timeout", true, result);
          else if (result?.stopReason !== "stop") failure = new DirectOutputError(`incomplete generation: ${result?.stopReason}`);
          else {
            try { return parse(String(responseFor(requestId)?.payload.text ?? "")); }
            catch (error) { failure = error; }
          }
        }
        if (failure instanceof DirectOutputError && paragraphs.length > 1 && depth < 12) return split();
        const transient = failure instanceof ModelProviderError && failure.retryable && ["busy", "timeout", "throttled"].includes(failure.kind);
        if (!transient && !(failure instanceof DirectOutputError) && !(failure instanceof DirectNamingConflict)) throw failure;
        if (attempt + 1 >= attemptLimit || records.filter(r => r.kind === "retry").length >= 128) throw new DirectRecoveryPausedError(windowId);
        const wait = failure instanceof DirectOutputError || failure instanceof DirectNamingConflict ? 0 : Math.min(30_000, 2_000 * 4 ** attempt);
        append({ id: randomUUID(), kind: "retry", windowId, key, at: Date.now(),
          payload: { nextAttemptAt: Date.now() + wait, category: transient ? (failure as ModelProviderError).kind : failure instanceof DirectNamingConflict ? "naming" : "structure" } });
      }
      throw new DirectRecoveryPausedError(windowId);

      async function split(): Promise<DirectTranslation> {
        if (!records.some(r => r.kind === "split" && r.key === key)) append({
          id: `split:${key}`, kind: "split", windowId, key, at: Date.now(), payload: { paragraphIds: paragraphs.map(p => p.id) },
        });
        const cut = Math.ceil(paragraphs.length / 2);
        const left = await execute(windowId, paragraphs.slice(0, cut), seed, depth + 1, sharedNames, repair);
        const inherited = learning ? [...sharedNames, ...left.names.filter(n => !sharedNames.some(s => directNameKey(s) === directNameKey(n)))] : seed ? left.names : sharedNames;
        const right = await execute(windowId, paragraphs.slice(cut), false, depth + 1, inherited, repair);
        const joined = [...left.paragraphs, ...right.paragraphs];
        const merged = parseDirectResponse(JSON.stringify({ paragraphs: joined }), paragraphs, []);
        return { ...merged, names: learning ? [...left.names, ...right.names.filter(n => !left.names.some(s => directNameKey(s) === directNameKey(n)))] : left.names };
      }
    };

    const promoteReady = () => {
      if (SourceLedger.open(options.manifestPath).sourceVersion !== context.sourceLedger.sourceVersion) throw new Error("SOURCE_VERSION_CHANGED");
      for (const window of db.allWindows(runId)) {
        if (["completed", "completed_with_warnings"].includes(window.status)) continue;
        if (window.status !== "staged") break;
        if (db.promoteStagedWindow(runId, window.windowId) !== "promoted") {
          // Empty semantic memory has no mutable dependency to replan.
          const current = db.allWindows(runId).find(w => w.windowId === window.windowId)!;
          if (!["completed", "completed_with_warnings"].includes(current.status)) throw new Error("direct promotion dependency changed");
        }
      }
    };
    const translateWindow = async (window: typeof windows[number], seed: boolean, wave?: DirectNameWave) => {
      const paragraphs = directParagraphs(window.blockIds.map(id => byBlock.get(id)!));
      db.bindWindowsToSnapshot(runId, [window.windowId], snapshot.id);
      db.claimWindow(runId, window.windowId);
      let result: DirectTranslation;
      let sharedNames = names;
      let repair = false;
      let wavePlan: DirectName[] | undefined;
      if (learning) {
        const prior = records.findLast(r => r.kind === "name_context" && r.windowId === window.windowId);
        sharedNames = prior ? prior.payload.names as DirectName[] : currentNames(paragraphs, wave?.baseNames);
        repair = typed && prior?.payload.repair === true;
        if (!prior) saveContext(sharedNames);
      }
      for (;;) {
        const checkpointKey = directHash(learning ? [identityHash, window.windowId, "checkpoint", sharedNames] : [identityHash, window.windowId, "checkpoint"]);
        const saved = records.find(r => r.kind === "checkpoint" && r.key === checkpointKey);
        if (saved) {
          result = parseDirectResponse(JSON.stringify({ paragraphs: saved.payload.paragraphs }), paragraphs, []);
          result.names = saved.payload.names as DirectName[];
        } else {
          result = await execute(window.windowId, paragraphs, seed, 0, sharedNames, repair);
        }
        if (learning) {
          if (wave && !wavePlan) wavePlan = await wave.collect(window.windowId, result.names);
          const latest = currentNames(paragraphs, wavePlan);
          try { assertDirectNamesCompatible(result.names, latest); }
          catch (error) {
            if (!(error instanceof DirectNamingConflict)) throw error;
            append({ id: randomUUID(), kind: "name_conflict", windowId: window.windowId, key: checkpointKey, at: Date.now(),
              payload: { source: error.source, expected: error.expected, proposed: error.proposed, conflicts: error.conflicts } });
            if ((!typed || repair) && canonicalJson(sharedNames) === canonicalJson(latest)) throw error;
            repair = true;
            sharedNames = latest; saveContext(sharedNames);
            continue;
          }
        }
        if (!saved) append({ id: `checkpoint:${checkpointKey}`, kind: "checkpoint", windowId: window.windowId, key: checkpointKey,
          at: Date.now(), payload: { paragraphs: result.paragraphs, names: result.names } });
        if (learning && !records.some(r => r.id === `names:${checkpointKey}`)) {
          const established = new Set(db.directNames(runId).map(directNameKey));
          const learned = result.names.filter(n => !userNames.some(u => u.source === n.source) && !established.has(directNameKey(n))
            && (!wavePlan || wavePlan.some(p => directNameKey(p) === directNameKey(n) && equivalentDirectRendering(n.source, p.target, n.target))));
          append({ id: `names:${checkpointKey}`, kind: "names", windowId: window.windowId, key: checkpointKey, at: Date.now(), payload: { names: learned } });
        }
        break;
      }
      if (seed) { names = result.names; seedFinished = true; }
      db.stageWindow({ runId, windowId: window.windowId, snapshotId: snapshot.id, status: "completed",
        translations: result.translations.map(t => ({ ...t, sourceHash: byBlock.get(t.blockId)!.sourceHash })),
        knowledgeCandidates: [], styleTail: "", warnings: [],
        budget: { modelCalls: records.filter(r => r.kind === "request" && r.windowId === window.windowId).length },
        conceptBindings: { usages: [], concepts: [] } });
      completedThisInvocation++;
      promoteReady();
      function saveContext(contextNames: DirectName[]) {
        const key = directHash(typed ? [identityHash, window.windowId, "name_context", contextNames, repair] : [identityHash, window.windowId, "name_context", contextNames]);
        if (!records.some(r => r.id === `name_context:${key}`)) append({ id: `name_context:${key}`, kind: "name_context",
          windowId: window.windowId, key, at: Date.now(), payload: { names: contextNames, ...(typed ? { repair } : {}) } });
      }
    };
    try {
      const pending = db.pendingWindows(runId).slice(0, limit);
      const runWave = async (members: typeof windows, seed = false, saved?: DirectRecord) => {
        const key = saved?.key ?? directHash([identityHash, "name_wave", members.map(w => w.windowId)]);
        const record: DirectRecord = saved ?? { id: `name_wave:${key}`, kind: "name_wave", windowId: members[0]!.windowId,
          key, at: Date.now(), payload: { windowIds: members.map(w => w.windowId), names: db.directNames(runId) } };
        if (!saved) append(record);
        const wave = new DirectNameWave(record, records, append);
        waves.push({ wave: waves.length, concurrency: maxConcurrency, windowIds: members.map(w => w.windowId) });
        await Promise.all(members.map(async w => {
          try { await translateWindow(w, seed, wave); }
          catch (error) { stop ??= error; wave.fail(error); }
        }));
        if (stop) throw stop;
      };
      if (pending.length && !seedFinished && !options.shouldPause?.()) {
        const first = pending.shift()!;
        if (typed) await runWave([first], true, records.find(r => r.kind === "name_wave" && (r.payload.windowIds as string[]).includes(first.windowId)));
        else await translateWindow(first, true);
      }
      if (typed) {
        while (pending.length && !options.shouldPause?.() && !options.signal?.aborted) {
          const saved = records.find(r => r.kind === "name_wave" && (r.payload.windowIds as string[]).includes(pending[0]!.windowId));
          const needed = saved ? db.pendingWindows(runId).filter(w => (saved.payload.windowIds as string[]).includes(w.windowId)) : [];
          if (needed.some(w => !pending.some(p => p.windowId === w.windowId))) throw new Error("DIRECT_WAVE_LIMIT: maxWindows must include the remaining saved naming wave");
          const members = saved ? needed : pending.slice(0, maxConcurrency);
          await runWave(members, false, saved);
          pending.splice(0, members.length);
        }
      } else {
      let next = 0;
      if (pending.length) waves.push({ wave: 0, concurrency: maxConcurrency, windowIds: pending.map(w => w.windowId) });
      const worker = async () => {
        while (!stop && !options.shouldPause?.() && !options.signal?.aborted && next < pending.length) {
          const window = pending[next++]!;
          try { await translateWindow(window, false); }
          catch (error) { stop ??= error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(maxConcurrency, pending.length) }, worker));
      }
      options.signal?.throwIfAborted();
      if (stop) throw stop;
      const status = db.statusSummary(runId);
      return { outcome: status.completedWindows === status.totalWindows ? "completed" : "partial", runId,
        processedWindows: completedThisInvocation, waves, status, windows: db.allWindows(runId), wallTimeMs: performance.now() - startedAt,
        revalidationOverhead: { coverageScan: { occurrenceDependencies: 0, candidateTranslations: 0, tasksCreated: 0, bindingsCreated: 0, wallTimeMs: 0 },
          drain: emptyRevalidationDrainReport() }, scheduler: ledger.toSchedulerRunReport(), leaseReleased: true, artifacts: null };
    } finally {
      reconcile();
      db.recoverInterruptedWindows(runId);
      db.saveSchedulerRunProjection(runId, ledger.toSchedulerRunReport());
    }
  } finally { store?.close(); lease?.release(); context.close(); }
}
