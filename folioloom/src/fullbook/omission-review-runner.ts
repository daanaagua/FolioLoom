import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { RunLease } from "../kernel/run-lease.js";
import { preflightProviderStream } from "../providers/preflight.js";
import { LosslessBookStore } from "../storage/lossless-book-store.js";
import { auditLosslessBookExport, losslessBookTranslations } from "../report.js";
import { buildOmissionReviewPlan, omissionHash, OMISSION_REVIEW_PROMPT, parseOmissionReview, validateOmissionReviewPlan,
  type OmissionCandidate, type OmissionReviewInput, type OmissionReviewPlan, type OmissionReviewVerdict } from "./omission-review.js";

export interface OmissionReviewLimits { maxCalls: number; maxTokens: number; maxOutputTokens: number }
export function loadOmissionReviewInput(storePath: string, runId: string): OmissionReviewInput {
  const store = LosslessBookStore.openReadOnly(storePath);
  try {
    const audit = auditLosslessBookExport(store, runId).audit;
    if (!audit.structurallyComplete) throw new Error("omission review requires complete, structurally valid translated text");
    const state = store.auditState(runId);
    return { runId, sourceVersion: state.sourceVersion, sourceLanguage: state.sourceLanguage ?? "en", translations: losslessBookTranslations(store, runId) };
  } finally { store.close(); }
}
type Outcome = "reviewed" | "provider_error" | "invalid_response" | "usage_incomplete" | "interrupted" | "source_changed";
type Event = { type: "start"; identity: unknown } | { type: "dispatch"; candidateId: string; reservedTokens: number }
  | { type: "settled"; candidateId: string; outcome: Outcome; knownTokens: number; usageComplete: boolean;
    response?: Pick<AssistantMessage, "content" | "usage" | "stopReason">; verdict?: OmissionReviewVerdict };
interface Record { sequence: number; previousHash: string; hash: string; event: Event }
export interface OmissionReviewStatus {
  schema: "folioloom-omission-review-status-1";
  planHash: string;
  calls: number;
  knownTokens: number;
  chargedTokens: number;
  unknownUsage: number;
  pending: number;
  stoppedReason: string;
  findings: Array<{ candidateId: string; selection: "risk" | "sample"; result: OmissionReviewVerdict }>;
  coverage: { totalParagraphs: number; plannedCandidates: number; reviewedParagraphs: number; sampledParagraphs: number; riskJudgedAdequate: number };
  assurance: "sampled-comparison-not-full-semantic-proof";
}

function checkLimits(limits: OmissionReviewLimits): void {
  if (!limits || [limits.maxCalls, limits.maxTokens, limits.maxOutputTokens].some(n => !Number.isSafeInteger(n) || n < 1)
    || limits.maxCalls > 1000) throw new Error("invalid explicit review budgets");
}

function readRecords(directory: string): Record[] {
  const path = join(directory, "journal.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("review journal has an incomplete durable record");
  const records: Record[] = [];
  for (const line of raw.trimEnd().split("\n")) {
    const row = JSON.parse(line) as Record, { hash, ...payload } = row;
    if (row.sequence !== records.length || row.previousHash !== (records.at(-1)?.hash ?? "") || hash !== omissionHash(payload))
      throw new Error("review journal hash chain mismatch");
    records.push(row);
  }
  if (records[0]?.event.type !== "start") throw new Error("review journal identity missing");
  return records;
}

function append(directory: string, records: Record[], event: Event): void {
  const payload = { sequence: records.length, previousHash: records.at(-1)?.hash ?? "", event };
  const record = { ...payload, hash: omissionHash(payload) };
  appendFileSync(join(directory, "journal.jsonl"), JSON.stringify(record) + "\n", { encoding: "utf8", flush: true });
  records.push(record);
}

function projection(plan: OmissionReviewPlan, records: Record[]): OmissionReviewStatus {
  const dispatched = new Map<string, number>(), settled = new Set<string>();
  let knownTokens = 0, chargedTokens = 0, unknownUsage = 0, stoppedReason = "pending";
  const findings: OmissionReviewStatus["findings"] = [];
  for (const [index, row] of records.entries()) {
    const event = row.event;
    if (index === 0 && event.type === "start") continue;
    if (event.type === "dispatch") {
      if (dispatched.has(event.candidateId) || !plan.candidates.some(c => c.id === event.candidateId)
        || !Number.isSafeInteger(event.reservedTokens) || event.reservedTokens < 1) throw new Error("invalid review dispatch history");
      dispatched.set(event.candidateId, event.reservedTokens); chargedTokens += event.reservedTokens;
    } else if (event.type === "settled") {
      const reservation = dispatched.get(event.candidateId);
      if (reservation === undefined || settled.has(event.candidateId) || !Number.isSafeInteger(event.knownTokens) || event.knownTokens < 0
        || typeof event.usageComplete !== "boolean") throw new Error("invalid review settlement history");
      settled.add(event.candidateId); knownTokens += event.knownTokens;
      if (event.usageComplete) chargedTokens += event.knownTokens - reservation;
      else { chargedTokens += Math.max(0, event.knownTokens - reservation); unknownUsage++; }
      if (event.outcome !== "reviewed") stoppedReason = event.outcome;
      else {
        const candidate = plan.candidates.find(c => c.id === event.candidateId)!;
        if (!event.usageComplete || !event.verdict) throw new Error("reviewed result lacks complete evidence");
        findings.push({ candidateId: candidate.id, selection: candidate.selection, result: parseOmissionReview(JSON.stringify(event.verdict), candidate) });
      }
    } else throw new Error("invalid review journal transition");
  }
  if (dispatched.size !== settled.size) { unknownUsage += dispatched.size - settled.size; stoppedReason = "interrupted"; }
  const pending = plan.candidates.length - dispatched.size;
  if (stoppedReason === "pending" && pending === 0) stoppedReason = "complete";
  return { schema: "folioloom-omission-review-status-1", planHash: plan.planHash, calls: dispatched.size, knownTokens, chargedTokens,
    unknownUsage, pending, stoppedReason, findings,
    coverage: { totalParagraphs: plan.scan.paragraphs, plannedCandidates: plan.candidates.length, reviewedParagraphs: findings.length,
      sampledParagraphs: findings.filter(f => f.selection === "sample").length,
      riskJudgedAdequate: findings.filter(f => f.selection === "risk" && f.result.verdict === "adequate").length },
    assurance: "sampled-comparison-not-full-semantic-proof" };
}

export function readOmissionReviewStatus(directory: string): OmissionReviewStatus {
  const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8")) as OmissionReviewPlan;
  validateOmissionReviewPlan(plan);
  const records = readRecords(directory), status = projection(plan, records);
  const first = records[0]?.event;
  if (first?.type !== "start" || (first.identity as { planHash?: string }).planHash !== plan.planHash) throw new Error("review plan/journal identity mismatch");
  const limits = (first.identity as { limits: OmissionReviewLimits }).limits; checkLimits(limits);
  if (status.stoppedReason === "pending") {
    const sent = new Set(records.flatMap(r => r.event.type === "dispatch" ? [r.event.candidateId] : []));
    const next = plan.candidates.find(candidate => !sent.has(candidate.id));
    if (next) {
      const reservation = reviewReservation(next, limits).tokens;
      const contextWindow = (first.identity as { model: { contextWindow: number } }).model.contextWindow;
      if (next.source.length + next.target.length > 24000 || reservation > contextWindow) status.stoppedReason = "candidate_too_large";
      else if (status.calls >= limits.maxCalls || status.chargedTokens + reservation > limits.maxTokens) status.stoppedReason = "budget_exhausted";
    }
  }
  if (status.chargedTokens > limits.maxTokens) status.stoppedReason = "budget_overrun";
  return status;
}

function reviewReservation(candidate: OmissionCandidate, limits: OmissionReviewLimits): { prompt: string; tokens: number } {
  const prompt = JSON.stringify({ source: candidate.source, target: candidate.target, context: candidate.context, uncertainSignals: candidate.reasons });
  return { prompt, tokens: Buffer.byteLength(OMISSION_REVIEW_PROMPT + prompt, "utf8") + 4096 + limits.maxOutputTokens };
}

function messageUsage(message: AssistantMessage): { knownTokens: number; complete: boolean } {
  const u = message.usage;
  const complete = !!u && [u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)
    && u.totalTokens > 0 && u.totalTokens === u.input + u.output + u.cacheRead + u.cacheWrite
    && (u.reasoning === undefined || (Number.isSafeInteger(u.reasoning) && u.reasoning >= 0 && u.reasoning <= u.output));
  return { knownTokens: Number.isSafeInteger(u?.totalTokens) && u.totalTokens > 0 ? u.totalTokens : 0, complete };
}

export async function runOmissionReview(options: {
  plan: OmissionReviewPlan;
  currentInput: () => OmissionReviewInput | Promise<OmissionReviewInput>;
  outputDirectory: string;
  limits: OmissionReviewLimits;
  model: Model<Api>;
  streamFn: StreamFn;
  thinkingLevel?: ThinkingLevel;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<OmissionReviewStatus> {
  const { plan, limits, model, outputDirectory: directory } = options;
  validateOmissionReviewPlan(plan); checkLimits(limits);
  if (limits.maxOutputTokens > model.maxTokens) throw new Error("review output budget exceeds model capacity");
  const deadlineMs = options.deadlineMs ?? 120000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 600000) throw new Error("invalid review deadline");
  if (plan.scan.structuralIssues.length) throw new Error("review requires structurally aligned source and translation paragraphs");
  const assertCurrent = async () => {
    if (buildOmissionReviewPlan(await options.currentInput(), plan.options).planHash !== plan.planHash) throw new Error("stale review plan: source or translation changed");
  };
  await assertCurrent();
  const identity = { schema: "folioloom-omission-review-journal-1", planHash: plan.planHash,
    promptHash: omissionHash(OMISSION_REVIEW_PROMPT), limits, model: { id: model.id, provider: model.provider, api: model.api,
      endpointHash: omissionHash(model.baseUrl), contextWindow: model.contextWindow, thinkingLevel: options.thinkingLevel ?? null }, deadlineMs };
  if (existsSync(directory) && !existsSync(join(directory, "plan.json")) && readdirSync(directory)
    .some(name => ![".review.lock", ".review.lock.lease.db", ".review.lock.lease.db-journal"].includes(name)))
    throw new Error("review output must be a new or existing review directory");
  mkdirSync(directory, { recursive: true });
  const lease = RunLease.acquire(join(directory, ".review.lock"), `omission-review:${plan.planHash}`);
  try {
    const planPath = join(directory, "plan.json");
    if (existsSync(planPath)) {
      if (omissionHash(JSON.parse(readFileSync(planPath, "utf8"))) !== omissionHash(plan)) throw new Error("review plan identity mismatch");
    } else writeFileSync(planPath, JSON.stringify(plan, null, 2), { encoding: "utf8", flag: "wx", flush: true });
    const records = readRecords(directory);
    if (!records.length) append(directory, records, { type: "start", identity });
    else if (records[0]!.event.type !== "start" || omissionHash(records[0]!.event.identity) !== omissionHash(identity))
      throw new Error("review identity or budget changed; saved limits cannot be replenished");
    const settles = new Set(records.flatMap(r => r.event.type === "settled" ? [r.event.candidateId] : []));
    for (const row of [...records]) if (row.event.type === "dispatch" && !settles.has(row.event.candidateId))
      append(directory, records, { type: "settled", candidateId: row.event.candidateId, outcome: "interrupted", knownTokens: 0, usageComplete: false });
    let status = projection(plan, records), ready = false;
    if (status.chargedTokens > limits.maxTokens) status.stoppedReason = "budget_overrun";
    for (const candidate of plan.candidates) {
      if (!["pending", "complete"].includes(status.stoppedReason)) break;
      if (records.some(r => r.event.type === "dispatch" && r.event.candidateId === candidate.id)) continue;
      await assertCurrent(); options.signal?.throwIfAborted();
      const { prompt, tokens: reservation } = reviewReservation(candidate, limits);
      if (candidate.source.length + candidate.target.length > 24000 || reservation > model.contextWindow) { status.stoppedReason = "candidate_too_large"; break; }
      if (status.calls >= limits.maxCalls || status.chargedTokens + reservation > limits.maxTokens) { status.stoppedReason = "budget_exhausted"; break; }
      if (!ready) { await preflightProviderStream(options.streamFn, options.signal, true); ready = true; }
      append(directory, records, { type: "dispatch", candidateId: candidate.id, reservedTokens: reservation });
      let message: AssistantMessage | undefined;
      let settlement: Extract<Event, { type: "settled" }>;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), deadlineMs);
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      let abortHandler: (() => void) | undefined;
      try {
        const pending = Promise.resolve(options.streamFn(model, { systemPrompt: OMISSION_REVIEW_PROMPT,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: limits.maxOutputTokens,
          maxRetries: 0, reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel, signal })).then(events => events.result());
        const abort = new Promise<never>((_, reject) => {
          abortHandler = () => reject(new Error("review interrupted")); signal.addEventListener("abort", abortHandler, { once: true });
          if (signal.aborted) abortHandler();
        });
        message = await Promise.race([pending, abort]);
        const usage = messageUsage(message);
        let outcome: Outcome = usage.complete ? (message.stopReason === "stop" && message.usage.output <= limits.maxOutputTokens ? "reviewed" : "invalid_response") : "usage_incomplete";
        let verdict: OmissionReviewVerdict | undefined;
        if (outcome === "reviewed") {
          try { await assertCurrent(); } catch { outcome = "source_changed"; }
          if (outcome === "reviewed") try { verdict = parseOmissionReview(message.content.filter(c => c.type === "text").map(c => c.text).join(""), candidate); }
          catch { outcome = "invalid_response"; }
        }
        settlement = { type: "settled", candidateId: candidate.id, outcome,
          knownTokens: usage.knownTokens, usageComplete: usage.complete,
          response: { content: message.content, usage: message.usage, stopReason: message.stopReason }, ...(verdict ? { verdict } : {}) };
      } catch {
        settlement = { type: "settled", candidateId: candidate.id, outcome: "provider_error", knownTokens: 0, usageComplete: false };
      } finally { clearTimeout(timer); if (abortHandler) signal.removeEventListener("abort", abortHandler); }
      append(directory, records, settlement);
      status = projection(plan, records);
      if (status.chargedTokens > limits.maxTokens) { status.stoppedReason = "budget_overrun"; break; }
    }
    writeFileSync(join(directory, "report.json"), JSON.stringify(status, null, 2), "utf8");
    return status;
  } finally { lease.release(); }
}
