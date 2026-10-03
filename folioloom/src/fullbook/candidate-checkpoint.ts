import type { TranslationBatchWindowResult } from "../agents/translation-batch.js";
import type { TranslationRequestInput } from "../agents/translation-request.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { supervisionHash, supervisionCandidateHash } from "../domain/supervision.js";

export const CANDIDATE_CHECKPOINT_PROTOCOL = "folioloom-candidate-checkpoint-1";
export interface CandidateCheckpointRecord {
  readonly id: string;
  readonly key: string;
  readonly protocol: typeof CANDIDATE_CHECKPOINT_PROTOCOL;
  readonly phase: "candidate" | "repair_started" | "discarded";
  readonly windowId: string;
  readonly sourceVersion: string;
  readonly snapshotId: string;
  readonly repairGeneration: string;
  readonly candidateHash: string;
  readonly candidate: TranslationBatchWindowResult;
}
export interface CandidateCheckpointJournal {
  candidateRecoveryGeneration?(runId: string, windowId: string): string;
  candidateCheckpointRecords(runId: string, windowId: string): CandidateCheckpointRecord[];
  appendCandidateCheckpoint(runId: string, record: CandidateCheckpointRecord): void;
}
export class CandidateRecoveryPausedError extends Error {
  readonly code = "CANDIDATE_RECOVERY_PAUSED";
  readonly retryable = false;
  constructor(readonly windowId: string, reason: string) {
    super(`CANDIDATE_RECOVERY_PAUSED: ${windowId}: ${reason}; saved candidate retained`);
    this.name = "CandidateRecoveryPausedError";
  }
}

function digest(value: unknown): string { return supervisionHash(canonicalJson(value)); }
function recordId(record: Omit<CandidateCheckpointRecord, "id">): string { return digest(record); }

export function validateCandidateCheckpoint(record: CandidateCheckpointRecord): void {
  const { id, ...payload } = record;
  const candidate = record.candidate;
  if (record.protocol !== CANDIDATE_CHECKPOINT_PROTOCOL || !["candidate", "repair_started", "discarded"].includes(record.phase)
    || !/^[a-f0-9]{64}$/u.test(record.key) || record.id !== recordId(payload)
    || typeof record.snapshotId !== "string" || !record.snapshotId || typeof record.repairGeneration !== "string"
    || record.candidateHash !== digest(candidate) || candidate.windowId !== record.windowId
    || !["completed", "completed_with_warnings"].includes(candidate.status)
    || !candidate.translations?.length
    || candidate.translations.some(t => typeof t.blockId !== "string" || typeof t.text !== "string" || !t.text.trim())
    || new Set(candidate.translations.map(t => t.blockId)).size !== candidate.translations.length
    || !Array.isArray(candidate.termUsages) || !Array.isArray(candidate.notes) || !Array.isArray(candidate.memoryCandidates)) {
    throw new Error(`invalid candidate checkpoint: ${record.windowId}`);
  }
}

/** Durable candidates are not active translations and confer no export approval. */
export class CandidateCheckpointService {
  constructor(private readonly options: {
    runId: string; sourceVersion: string; modelId: string; store: CandidateCheckpointJournal; purpose?: string;
  }) {}

  #generation(windowId: string): string {
    return this.options.store.candidateRecoveryGeneration?.(this.options.runId, windowId) ?? "initial";
  }

  key(input: TranslationRequestInput, windowId: string): string {
    const window = input.request.windows.find(w => w.windowId === windowId);
    if (!window) throw new Error(`candidate window outside request: ${windowId}`);
    const ids = new Set(window.blockIds);
    return digest({ protocol: CANDIDATE_CHECKPOINT_PROTOCOL, sourceVersion: this.options.sourceVersion,
      purpose: this.options.purpose ?? "translate",
      modelId: this.options.modelId, windowId, blockIds: window.blockIds,
      sources: input.blocks.filter(b => ids.has(b.id)).map(b => ({ id: b.id, hash: b.sourceHash })),
      // Snapshot IDs include ancestry even when no knowledge changes. Bind the
      // actual projection, retaining the original snapshot separately as provenance.
      knowledge: input.snapshot.revisions,
      selectedKnowledgeRevisionIds: input.snapshot.revisions.length === 0 ? [] : input.selectedKnowledgeRevisionIds ?? null,
      stableTerms: input.stableTerms.filter(t => !t.applicableBlockIds || t.applicableBlockIds.some(id => ids.has(id))),
      styleState: input.styleState ?? null, effectiveStyle: input.effectiveStyleByWindow?.[windowId] ?? null,
      sourceLanguage: input.sourceLanguageProfile?.id ?? null, previousActiveTail: input.previousActiveTail ?? "",
      guidance: input.supervisorGuidance?.filter(g => ids.has(g.blockId)) ?? [], strictIdentifiers: input.strictIdentifiers ?? false,
    });
  }

  #records(input: TranslationRequestInput, windowId: string): CandidateCheckpointRecord[] {
    const key = this.key(input, windowId);
    return this.options.store.candidateCheckpointRecords(this.options.runId, windowId).filter(r => {
      validateCandidateCheckpoint(r);
      return r.key === key && r.sourceVersion === this.options.sourceVersion;
    });
  }

  load(input: TranslationRequestInput, windowId: string): TranslationBatchWindowResult | undefined {
    const record = this.#records(input, windowId).findLast(r => r.phase !== "repair_started");
    if (!record || record.phase === "discarded") return undefined;
    const ids = input.request.windows.find(w => w.windowId === windowId)!.blockIds;
    if (record.candidate.translations.length !== ids.length || ids.some(id => !record.candidate.translations.some(t => t.blockId === id))) {
      throw new Error(`candidate checkpoint scope mismatch: ${windowId}`);
    }
    return structuredClone(record.candidate);
  }

  save(input: TranslationRequestInput, candidate: TranslationBatchWindowResult, phase: "generated" | "repaired" = "generated"): void {
    if (candidate.status === "failed") return;
    const window = input.request.windows.find(w => w.windowId === candidate.windowId);
    if (!window || candidate.ordinal !== window.ordinal || candidate.translations.length !== window.blockIds.length
      || window.blockIds.some(id => !candidate.translations.some(t => t.blockId === id))) throw new Error("candidate checkpoint scope mismatch");
    const prior = this.load(input, candidate.windowId);
    const unchanged = prior && supervisionCandidateHash(prior.translations) === supervisionCandidateHash(candidate.translations);
    this.#append(input, candidate, "candidate");
    if (phase === "repaired" && unchanged) throw new CandidateRecoveryPausedError(candidate.windowId, "repair made no text progress");
  }

  claimRepair(input: TranslationRequestInput, candidates: readonly TranslationBatchWindowResult[]): void {
    for (const candidate of candidates) {
      if (this.#records(input, candidate.windowId).some(r => r.phase === "repair_started" && r.repairGeneration === this.#generation(candidate.windowId))) {
        throw new CandidateRecoveryPausedError(candidate.windowId, "durable semantic repair credit exhausted");
      }
    }
    // All candidates have been checked before any credit is consumed. A crash
    // during this loop can only conservatively spend credit, never renew it.
    for (const candidate of candidates) this.#append(input, candidate, "repair_started");
  }

  discardWindow(windowId: string): void {
    const records = this.options.store.candidateCheckpointRecords(this.options.runId, windowId);
    const latest = new Map(records.filter(r => r.phase !== "repair_started").map(r => [r.key, r]));
    for (const record of latest.values()) {
      validateCandidateCheckpoint(record);
      if (record.phase === "discarded") continue;
      const { id: _id, ...payload } = { ...record, phase: "discarded" as const };
      this.options.store.appendCandidateCheckpoint(this.options.runId, { id: recordId(payload), ...payload });
    }
  }

  #append(input: TranslationRequestInput, window: TranslationBatchWindowResult, phase: CandidateCheckpointRecord["phase"]): void {
    const candidate = JSON.parse(JSON.stringify(window)) as TranslationBatchWindowResult;
    const payload: Omit<CandidateCheckpointRecord, "id"> = { protocol: CANDIDATE_CHECKPOINT_PROTOCOL, phase, windowId: candidate.windowId,
      key: this.key(input, candidate.windowId), sourceVersion: this.options.sourceVersion, snapshotId: input.snapshot.id,
      repairGeneration: this.#generation(candidate.windowId),
      candidateHash: digest(candidate), candidate };
    const record = { id: recordId(payload), ...payload };
    validateCandidateCheckpoint(record);
    this.options.store.appendCandidateCheckpoint(this.options.runId, record);
  }
}
