import { canonicalJson } from "../knowledge/knowledge-store.js";
import { supervisionHash } from "../domain/supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import { assertQualityClosure, priorQualityIssues, type QualityClosure } from "../domain/quality-closure.js";
import { EPUB_TEXT_PATCH_PROTOCOL } from "../tools/epub-repair-patch.js";

export const MAX_QUALITY_REWORKS = 2;
export interface QualityReworkRequest {
  readonly itemId: string;
  readonly requestId: string;
  readonly expectedRecordId: string;
  readonly expectedCandidateHash: string;
  readonly reason: string;
}

export type DeliveryMode = "standard" | "strict";
export function resolveDeliveryMode(requested: DeliveryMode | undefined, stored: DeliveryMode | undefined, existing: boolean): DeliveryMode {
  return requested ?? stored ?? (existing ? "strict" : "standard");
}

export function onlySemanticIssues(issues: readonly ValidationFailure[]): boolean {
  return issues.length > 0 && issues.every(issue => issue.code === "SUPERVISOR_SEMANTIC_REVIEW"
    && typeof issue.blockId === "string" && issue.blockId.length > 0
    && typeof issue.message === "string" && issue.message.trim().length > 0);
}

export interface QualityRecord {
  readonly protocol: "folioloom-quality-queue-1";
  readonly id: string;
  readonly itemId: string;
  readonly windowId: string;
  readonly candidateHash: string;
  readonly state: "pending" | "reviewing" | "resolved" | "unresolved" | "blocked";
  readonly issues: readonly ValidationFailure[];
  readonly reason?: string;
  readonly closureRequired?: boolean;
  readonly closure?: QualityClosure;
  readonly rework?: { readonly requestId: string; readonly previousRecordId: string;
    readonly protocol: typeof EPUB_TEXT_PATCH_PROTOCOL; readonly reason: string };
}
export interface QualityJournal {
  qualityRecords(runId: string): QualityRecord[];
  appendQualityRecord(runId: string, record: QualityRecord): void;
}
const hash = (value: unknown): string => supervisionHash(canonicalJson(value));
export function qualityReviewId(item: QualityRecord): string {
  return item.rework ? hash([item.itemId, item.rework.requestId, item.rework.protocol]) : item.itemId;
}
export function validateQualityRecord(record: QualityRecord): void {
  const { id, ...payload } = record;
  if (record.protocol !== "folioloom-quality-queue-1" || id !== hash(payload)
    || !/^[a-f0-9]{64}$/u.test(record.itemId) || !/^[a-f0-9]{64}$/u.test(record.candidateHash)
    || typeof record.windowId !== "string" || !record.windowId
    || !["pending", "reviewing", "resolved", "unresolved", "blocked"].includes(record.state)
    || !Array.isArray(record.issues)
    || (record.state === "resolved" ? record.issues.length !== 0 : !onlySemanticIssues(record.issues))
    || (record.rework !== undefined && (record.rework.protocol !== EPUB_TEXT_PATCH_PROTOCOL
      || !/^[a-f0-9]{64}$/u.test(record.rework.previousRecordId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.rework.requestId)
      || typeof record.rework.reason !== "string" || !record.rework.reason.trim() || record.rework.reason.length > 1200))) {
    throw new Error("invalid quality record");
  }
}

/** An append-only queue. Restart never replenishes a final-review attempt. */
export class QualityQueue {
  constructor(private readonly runId: string, private readonly store: QualityJournal) {}

  items(): QualityRecord[] {
    const latest = new Map<string, QualityRecord>();
    const reworks = new Map<string, number>();
    const requests = new Set<string>();
    for (const record of this.store.qualityRecords(this.runId)) {
      validateQualityRecord(record);
      const previous = latest.get(record.itemId);
      const reopening = previous && record.state === "pending" && record.rework
        && ["unresolved", "blocked"].includes(previous.state)
        && record.rework.previousRecordId === previous.id;
      if (reopening) {
        const count = (reworks.get(record.itemId) ?? 0) + 1;
        if (count > MAX_QUALITY_REWORKS || requests.has(record.rework!.requestId)
          || record.candidateHash !== previous.candidateHash || canonicalJson(record.issues) !== canonicalJson(previous.issues)
          || record.closure !== undefined || record.closureRequired !== true) throw new Error("invalid quality rework history");
        reworks.set(record.itemId, count); requests.add(record.rework!.requestId);
      }
      if ((!previous && (record.state !== "pending" || record.rework !== undefined))
        || (previous && (previous.windowId !== record.windowId
          || (!reopening && (canonicalJson(previous.rework ?? null) !== canonicalJson(record.rework ?? null)
            || !(previous.state === "pending" && record.state === "pending" && previous.candidateHash === record.candidateHash
                && previous.issues.every(issue => record.issues.some(i => canonicalJson(i) === canonicalJson(issue)))
              || previous.state === "pending" && record.state === "reviewing"
              || previous.state === "reviewing" && ["resolved", "unresolved", "blocked"].includes(record.state))))))) {
        throw new Error("invalid quality record transition");
      }
      latest.set(record.itemId, record);
      if (previous?.closureRequired && record.state === "resolved") {
        if (!record.closure) throw new Error("quality closure missing");
        assertQualityClosure(priorQualityIssues(previous.issues), record.closure, record.candidateHash);
        if (record.closure.dispositions.some(d => d.status === "unresolved")) throw new Error("unresolved quality closure");
      }
    }
    return structuredClone([...latest.values()]);
  }

  defer(input: { windowId: string; candidateHash: string; issues: readonly ValidationFailure[] }): QualityRecord {
    if (!onlySemanticIssues(input.issues)) throw new Error("quality deferral requires grounded semantic issues only");
    const itemId = hash({ runId: this.runId, windowId: input.windowId });
    const existing = this.items().find(item => item.itemId === itemId);
    if (existing) return existing;
    return this.#append({ ...input, itemId, state: "pending", closureRequired: true });
  }

  /** Chapter findings extend unclaimed evidence; they cannot reopen a spent final-review credit. */
  mergePending(input: { windowId: string; candidateHash: string; issues: readonly ValidationFailure[] }): QualityRecord {
    if (!onlySemanticIssues(input.issues)) throw new Error("quality merge requires grounded semantic issues only");
    const existing = this.items().find(item => item.windowId === input.windowId);
    if (!existing) return this.defer(input);
    const added = input.issues.filter(i => !existing.issues.some(prior => (prior.issueKey ?? prior.message) === (i.issueKey ?? i.message)));
    if (!added.length) return existing;
    if (existing.state !== "pending" || existing.candidateHash !== input.candidateHash) throw new Error("quality merge requires an unclaimed matching candidate");
    return this.#append({ ...existing, issues: [...existing.issues, ...added] });
  }

  claimFinal(itemId: string): QualityRecord {
    const item = this.#item(itemId);
    if (item.state !== "pending") throw new Error("quality final-review credit already consumed");
    return this.#append({ ...item, state: "reviewing" });
  }

  requestRework(input: QualityReworkRequest): QualityRecord {
    if (!input || Object.keys(input).sort().join(",") !== "expectedCandidateHash,expectedRecordId,itemId,reason,requestId"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.requestId)
      || !/^[a-f0-9]{64}$/u.test(input.expectedCandidateHash) || !/^[a-f0-9]{64}$/u.test(input.expectedRecordId)
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1200) throw new Error("invalid quality rework request");
    this.items();
    const records = this.store.qualityRecords(this.runId);
    const existing = records.find(r => r.state === "pending" && r.rework?.requestId === input.requestId);
    if (existing) {
      if (existing.itemId !== input.itemId || existing.candidateHash !== input.expectedCandidateHash
        || existing.rework!.previousRecordId !== input.expectedRecordId || existing.rework!.reason !== input.reason)
        throw new Error("quality rework request id conflict");
      return existing;
    }
    const item = this.#item(input.itemId);
    if (item.id !== input.expectedRecordId || item.candidateHash !== input.expectedCandidateHash) throw new Error("stale quality rework request");
    if (!["unresolved", "blocked"].includes(item.state)) throw new Error("quality rework requires a terminal unresolved item");
    if (records.filter(r => r.itemId === item.itemId && r.state === "pending" && r.rework).length >= MAX_QUALITY_REWORKS)
      throw new Error("quality rework limit exhausted");
    return this.#append({ itemId: item.itemId, windowId: item.windowId, candidateHash: item.candidateHash,
      state: "pending", issues: item.issues, closureRequired: true,
      rework: { requestId: input.requestId, previousRecordId: item.id, protocol: EPUB_TEXT_PATCH_PROTOCOL, reason: input.reason } });
  }

  finish(itemId: string, state: "resolved" | "unresolved" | "blocked", candidateHash: string, issues: readonly ValidationFailure[], reason?: string, closure?: QualityClosure): QualityRecord {
    const item = this.#item(itemId);
    if (item.state !== "reviewing") throw new Error("quality item is not reviewing");
    if (state === "resolved") {
      if (!closure) throw new Error("quality closure missing");
      assertQualityClosure(priorQualityIssues(item.issues), closure, candidateHash);
      if (closure.dispositions.some(d => d.status === "unresolved")) throw new Error("unresolved quality closure");
    }
    return this.#append({ ...item, state, candidateHash, issues, ...(reason ? { reason } : {}), ...(closure ? { closure } : {}) });
  }

  recoverInterrupted(): void {
    for (const item of this.items().filter(item => item.state === "reviewing")) {
      this.finish(item.itemId, "blocked", item.candidateHash, item.issues, "Final review interrupted; bounded attempt retained.");
    }
  }

  #item(id: string): QualityRecord {
    const item = this.items().find(item => item.itemId === id);
    if (!item) throw new Error("unknown quality item");
    return item;
  }

  #append(input: Omit<QualityRecord, "id" | "protocol">): QualityRecord {
    const { id: _id, protocol: _protocol, ...clean } = input as QualityRecord;
    const payload = JSON.parse(JSON.stringify({ ...clean, protocol: "folioloom-quality-queue-1" })) as Omit<QualityRecord, "id">;
    const record = { ...payload, id: hash(payload) };
    validateQualityRecord(record);
    this.store.appendQualityRecord(this.runId, record);
    return record;
  }
}
