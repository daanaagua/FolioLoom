import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RunLease } from "../kernel/run-lease.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import { directHash, DEFAULT_DIRECT_ATTEMPT_LIMIT, MAX_DIRECT_ATTEMPT_LIMIT, MAX_DIRECT_TOKEN_BUDGET_EXTENSION, type DirectRecord } from "./direct-translation.js";
import { directGenerationUsage } from "./direct-compact.js";

/** A saved transport grant keeps its original base policy when no override is supplied. */
export function directBaseAttemptLimit(records: readonly DirectRecord[], requested?: number): number {
  const grantedBase = (records.findLast(r => r.kind === "transport_release")?.payload.request as DirectTransportRelease | undefined)?.baseAttemptLimit;
  const savedFailureLimit = records.find(r => r.kind === "generation_budget")?.payload.failureLimit;
  const limit = requested ?? grantedBase ?? (savedFailureLimit === undefined ? DEFAULT_DIRECT_ATTEMPT_LIMIT : Number(savedFailureLimit));
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("maxAttempts must be a positive safe integer");
  if (limit > MAX_DIRECT_ATTEMPT_LIMIT) throw new Error(`direct maxAttempts cannot exceed ${MAX_DIRECT_ATTEMPT_LIMIT}`);
  return limit;
}

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
    || !Number.isSafeInteger(r.baseAttemptLimit) || r.baseAttemptLimit < 1 || r.baseAttemptLimit > MAX_DIRECT_ATTEMPT_LIMIT
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
  if (workflow?.name !== "direct" || !["direct-translation-1", "direct-translation-2", "direct-translation-3", "direct-translation-4", "direct-translation-5"].includes(workflow.version))
    throw new Error("direct recovery requires a supported existing direct run");
  return workflow.identityHash;
}

function transportOnly(records: readonly DirectRecord[], requests: readonly DirectRecord[]): boolean {
  return requests.length > 0 && requests.every(request => records.some(response => response.kind === "response"
    && response.windowId === request.windowId && response.key === request.key && response.payload.requestId === request.id
    && response.payload.stopReason === "error"));
}

export interface DirectTokenBudgetExtension {
  requestId: string;
  windowId: string;
  expectedLastRequestId: string;
  expectedIdentityHash: string;
  expectedTokenLimit: number;
  additionalTokens: number;
  reason: string;
}

function validateBudgetExtension(value: unknown): DirectTokenBudgetExtension {
  const r = value as DirectTokenBudgetExtension;
  if (!r || typeof r !== "object" || Array.isArray(r)
    || ![r.requestId, r.windowId, r.expectedLastRequestId, r.reason].every(s => typeof s === "string" && s.trim() && s.length <= 500)
    || typeof r.expectedIdentityHash !== "string" || !/^[a-f0-9]{64}$/u.test(r.expectedIdentityHash)
    || !Number.isSafeInteger(r.expectedTokenLimit) || r.expectedTokenLimit < 1
    || !Number.isSafeInteger(r.additionalTokens) || r.additionalTokens < 1 || r.additionalTokens > MAX_DIRECT_TOKEN_BUDGET_EXTENSION
    || !Number.isSafeInteger(r.expectedTokenLimit + r.additionalTokens))
    throw new Error("invalid direct token budget extension request");
  return { requestId: r.requestId, windowId: r.windowId, expectedLastRequestId: r.expectedLastRequestId,
    expectedIdentityHash: r.expectedIdentityHash, expectedTokenLimit: r.expectedTokenLimit,
    additionalTokens: r.additionalTokens, reason: r.reason };
}

/** Reconstruct the ceiling from immutable base and explicit, ordered grants. */
export function directTokenBudget(records: readonly DirectRecord[], windowId: string, identityHash: string) {
  const base = records.find(r => r.kind === "generation_budget" && r.windowId === windowId);
  if (!base) return undefined;
  if (base.key !== identityHash) throw new Error("direct token budget identity mismatch");
  const baseTokenLimit = Number(base.payload.tokenLimit);
  let tokenLimit = baseTokenLimit, extensions = 0, lastRequestId: string | undefined;
  for (const record of records) {
    if (record.windowId !== windowId) continue;
    if (record.kind === "request") lastRequestId = record.id;
    if (record.kind !== "token_budget_extension") continue;
    const request = validateBudgetExtension(record.payload.request);
    if (request.expectedIdentityHash !== identityHash || request.windowId !== windowId)
      throw new Error("direct token budget extension identity mismatch");
    if (request.expectedTokenLimit !== tokenLimit || request.expectedLastRequestId !== lastRequestId
      || record.payload.tokenLimit !== tokenLimit + request.additionalTokens)
      throw new Error("stale direct token budget extension chain");
    tokenLimit += request.additionalTokens;
    extensions++;
  }
  return { baseTokenLimit, additionalTokens: tokenLimit - baseTokenLimit, tokenLimit, extensions,
    maxCalls: Number(base.payload.maxCalls) };
}

/** Append an authorized token grant without modifying original budgets or usage. */
export function extendDirectTokenBudget(storePath: string, runId: string, value: unknown): DirectRecord {
  const request = validateBudgetExtension(value);
  if (!existsSync(storePath)) throw new Error("direct budget extension store does not exist");
  const lease = RunLease.acquire(`${resolve(storePath)}.run.lock`, `lossless:${runId}`);
  let store: LosslessBookStore | undefined;
  try {
    store = new LosslessBookStore(storePath);
    const identityHash = identity(store, runId);
    const workflow = (store.listTranslationRuns().find(r => r.runId === runId)?.metadata as any)?.workflow;
    if (workflow.version !== "direct-translation-5") throw new Error("token budget extension requires direct-translation-5");
    if (request.expectedIdentityHash !== identityHash) throw new Error("direct budget extension identity mismatch");
    const records = store.directRecords(runId), id = `token-budget-extension:${request.requestId}`;
    const prior = records.find(r => r.id === id);
    if (prior) {
      if (prior.kind !== "token_budget_extension" || canonicalJson(prior.payload.request) !== canonicalJson(request))
        throw new Error("direct budget extension request identity conflict");
      return prior;
    }
    const window = store.allWindows(runId).find(w => w.windowId === request.windowId);
    if (!window || window.status !== "pending") throw new Error("direct budget extension requires a pending window");
    const budget = directTokenBudget(records, request.windowId, identityHash);
    if (!budget) throw new Error("direct budget extension requires an existing generation budget");
    if (budget.tokenLimit !== request.expectedTokenLimit
      || records.findLast(r => r.kind === "request" && r.windowId === request.windowId)?.id !== request.expectedLastRequestId)
      throw new Error("stale direct budget extension request");
    const record: DirectRecord = { id, kind: "token_budget_extension", windowId: request.windowId,
      key: directHash([identityHash, "token_budget_extension", request]), at: Date.now(),
      payload: { request, tokenLimit: budget.tokenLimit + request.additionalTokens } };
    store.appendDirectRecord(runId, record);
    return record;
  } finally { store?.close(); lease.release(); }
}

export function directRecoveryStatus(store: LosslessBookStore, runId: string, requestedBaseAttemptLimit?: number) {
  const identityHash = identity(store, runId), records = store.directRecords(runId);
  const baseAttemptLimit = directBaseAttemptLimit(records, requestedBaseAttemptLimit);
  const compact = (store.listTranslationRuns().find(r => r.runId === runId)?.metadata as any)?.workflow?.version === "direct-translation-5";
  return { runId, identityHash, baseAttemptLimit, lifetimeAttemptCap: MAX_DIRECT_ATTEMPT_LIMIT,
    unknownUsage: store.loadTokenLedgerEvents(runId).filter(e => e.type === "settled" && !e.usageComplete).length,
    windows: store.allWindows(runId).flatMap(window => {
      const requests = records.filter(r => r.kind === "request" && r.windowId === window.windowId);
      const limit = directAttemptLimit(records, window.windowId, baseAttemptLimit, identityHash);
      const usage = compact ? directGenerationUsage(records, window.windowId) : undefined;
      const budget = compact ? directTokenBudget(records, window.windowId, identityHash) : undefined;
      if (!compact && requests.length < limit && limit === baseAttemptLimit) return [];
      if (compact && !requests.length) return [];
      return [{ windowId: window.windowId, ordinal: window.ordinal, status: window.status, attempts: requests.length,
        attemptLimit: limit, remaining: Math.max(0, limit - (usage?.failures ?? requests.length)), lastRequestId: requests.at(-1)?.id,
        ...(usage ? { accounting: "failure-credits", failureLimit: limit, successfulFragments: usage.successes, failedAttempts: usage.failures,
          chargedTokens: usage.chargedTokens, tokenLimit: budget?.tokenLimit, baseTokenLimit: budget?.baseTokenLimit,
          additionalTokens: budget?.additionalTokens, tokenBudgetExtensions: budget?.extensions, maxCalls: budget?.maxCalls } : {}),
        releaseEligible: window.status === "pending" && requests.length >= limit && requests.length < MAX_DIRECT_ATTEMPT_LIMIT && transportOnly(records, requests) }];
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
    if (attemptCeiling > MAX_DIRECT_ATTEMPT_LIMIT) throw new Error("direct recovery lifetime attempt cap exceeded");
    const record: DirectRecord = { id, kind: "transport_release", windowId: request.windowId,
      key: directHash([identityHash, "transport_release", request]), at: Date.now(),
      payload: { request, attemptFloor: requests.length, attemptCeiling } };
    store.appendDirectRecord(runId, record);
    return record;
  } finally { store?.close(); lease.release(); }
}
