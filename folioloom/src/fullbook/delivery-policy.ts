import { canonicalJson } from "../knowledge/knowledge-store.js";
import { supervisionHash } from "../domain/supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import { assertQualityClosure, priorQualityIssues, type QualityClosure } from "../domain/quality-closure.js";

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
}
export interface QualityJournal {
  qualityRecords(runId: string): QualityRecord[];
  appendQualityRecord(runId: string, record: QualityRecord): void;
}
const hash = (value: unknown): string => supervisionHash(canonicalJson(value));
export function validateQualityRecord(record: QualityRecord): void {
  const { id, ...payload } = record;
  if (record.protocol !== "folioloom-quality-queue-1" || id !== hash(payload)
    || !/^[a-f0-9]{64}$/u.test(record.itemId) || !/^[a-f0-9]{64}$/u.test(record.candidateHash)
    || typeof record.windowId !== "string" || !record.windowId
    || !["pending", "reviewing", "resolved", "unresolved", "blocked"].includes(record.state)
    || !Array.isArray(record.issues)
    || (record.state === "resolved" ? record.issues.length !== 0 : !onlySemanticIssues(record.issues))) {
    throw new Error("invalid quality record");
  }
}

/** An append-only queue. Restart never replenishes a final-review attempt. */
export class QualityQueue {
  constructor(private readonly runId: string, private readonly store: QualityJournal) {}

  items(): QualityRecord[] {
    const latest = new Map<string, QualityRecord>();
    for (const record of this.store.qualityRecords(this.runId)) {
      validateQualityRecord(record);
      const previous = latest.get(record.itemId);
      if ((!previous && record.state !== "pending")
        || (previous && (previous.windowId !== record.windowId
          || !(previous.state === "pending" && record.state === "reviewing"
            || previous.state === "reviewing" && ["resolved", "unresolved", "blocked"].includes(record.state))))) {
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

  claimFinal(itemId: string): QualityRecord {
    const item = this.#item(itemId);
    if (item.state !== "pending") throw new Error("quality final-review credit already consumed");
    return this.#append({ ...item, state: "reviewing" });
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
