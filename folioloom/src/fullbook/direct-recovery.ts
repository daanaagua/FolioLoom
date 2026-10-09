import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RunLease } from "../kernel/run-lease.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import { directHash, type DirectRecord } from "./direct-translation.js";

export interface DirectTransportRelease {
  requestId: string;
  windowId: string;
  expectedLastRequestId: string;
  expectedIdentityHash: string;
  baseAttemptLimit: number;
  additionalAttempts: number;
  reason: string;
}

function validateRequest(value: unknown): DirectTransportRelease {
  const r = value as DirectTransportRelease;
  if (!r || typeof r !== "object" || Array.isArray(r)
    || ![r.requestId, r.windowId, r.expectedLastRequestId, r.reason].every(s => typeof s === "string" && s.trim() && s.length <= 500)
    || typeof r.expectedIdentityHash !== "string" || !/^[a-f0-9]{64}$/u.test(r.expectedIdentityHash)
    || !Number.isSafeInteger(r.baseAttemptLimit) || r.baseAttemptLimit < 1 || r.baseAttemptLimit > 8
    || !Number.isSafeInteger(r.additionalAttempts) || r.additionalAttempts < 1 || r.additionalAttempts > 4)
    throw new Error("invalid direct transport release request");
  return { requestId: r.requestId, windowId: r.windowId, expectedLastRequestId: r.expectedLastRequestId,
    expectedIdentityHash: r.expectedIdentityHash, baseAttemptLimit: r.baseAttemptLimit,
    additionalAttempts: r.additionalAttempts, reason: r.reason };
}

export function directAttemptLimit(records: readonly DirectRecord[], windowId: string, baseLimit: number, identityHash: string): number {
  const grants = records.filter(r => r.kind === "transport_release" && r.windowId === windowId);
  if (grants.some(r => {
    const request = r.payload.request as DirectTransportRelease;
    return request.baseAttemptLimit !== baseLimit || request.expectedIdentityHash !== identityHash;
  })) throw new Error("direct transport release identity or attempt policy mismatch");
  return Number(grants.at(-1)?.payload.attemptCeiling ?? baseLimit);
}

function identity(store: LosslessBookStore, runId: string): string {
  const run = store.listTranslationRuns().find(r => r.runId === runId);
  const workflow = (run?.metadata as any)?.workflow;
  if (workflow?.name !== "direct" || !["direct-translation-1", "direct-translation-2", "direct-translation-3"].includes(workflow.version))
    throw new Error("direct recovery requires a supported existing direct run");
  return workflow.identityHash;
}

function transportOnly(records: readonly DirectRecord[], requests: readonly DirectRecord[]): boolean {
  return requests.length > 0 && requests.every(request => records.some(response => response.kind === "response"
    && response.windowId === request.windowId && response.key === request.key && response.payload.requestId === request.id
    && response.payload.stopReason === "error"));
}

export function directRecoveryStatus(store: LosslessBookStore, runId: string, baseAttemptLimit = 4) {
  if (!Number.isSafeInteger(baseAttemptLimit) || baseAttemptLimit < 1 || baseAttemptLimit > 8) throw new Error("invalid attempt limit");
  const identityHash = identity(store, runId), records = store.directRecords(runId);
  return { runId, identityHash, baseAttemptLimit, lifetimeAttemptCap: 8,
    unknownUsage: store.loadTokenLedgerEvents(runId).filter(e => e.type === "settled" && !e.usageComplete).length,
    windows: store.allWindows(runId).flatMap(window => {
      const requests = records.filter(r => r.kind === "request" && r.windowId === window.windowId);
      const limit = directAttemptLimit(records, window.windowId, baseAttemptLimit, identityHash);
      if (requests.length < limit && limit === baseAttemptLimit) return [];
      return [{ windowId: window.windowId, ordinal: window.ordinal, status: window.status, attempts: requests.length,
        attemptLimit: limit, remaining: Math.max(0, limit - requests.length), lastRequestId: requests.at(-1)?.id,
        releaseEligible: window.status === "pending" && requests.length >= limit && requests.length < 8 && transportOnly(records, requests) }];
    }) };
}

/** Explicit bounded release only; never clears attempts, usage, translations or token envelopes. */
export function releaseDirectTransportRecovery(storePath: string, runId: string, value: unknown): DirectRecord {
  const request = validateRequest(value);
  if (!existsSync(storePath)) throw new Error("direct recovery store does not exist");
  const lease = RunLease.acquire(`${resolve(storePath)}.run.lock`, `lossless:${runId}`);
  let store: LosslessBookStore | undefined;
  try {
    store = new LosslessBookStore(storePath);
    const identityHash = identity(store, runId);
    if (request.expectedIdentityHash !== identityHash) throw new Error("direct recovery identity mismatch");
    const records = store.directRecords(runId), id = `transport-release:${request.requestId}`;
    const prior = records.find(r => r.id === id);
    if (prior) {
      if (prior.kind !== "transport_release" || canonicalJson(prior.payload.request) !== canonicalJson(request))
        throw new Error("direct recovery request identity conflict");
      return prior;
    }
    const window = store.allWindows(runId).find(w => w.windowId === request.windowId);
    if (!window || window.status !== "pending") throw new Error("direct recovery requires a pending window");
    const requests = records.filter(r => r.kind === "request" && r.windowId === request.windowId);
    if (requests.at(-1)?.id !== request.expectedLastRequestId) throw new Error("stale direct recovery request");
    const limit = directAttemptLimit(records, request.windowId, request.baseAttemptLimit, identityHash);
    if (requests.length < limit) throw new Error("direct recovery allowance is not exhausted");
    if (!transportOnly(records, requests)) throw new Error("direct recovery only releases failed transport attempts, not semantic or structural output");
    const attemptCeiling = requests.length + request.additionalAttempts;
    if (attemptCeiling > 8) throw new Error("direct recovery lifetime attempt cap exceeded");
    const record: DirectRecord = { id, kind: "transport_release", windowId: request.windowId,
      key: directHash([identityHash, "transport_release", request]), at: Date.now(),
      payload: { request, attemptFloor: requests.length, attemptCeiling } };
    store.appendDirectRecord(runId, record);
    return record;
  } finally { store?.close(); lease.release(); }
}
