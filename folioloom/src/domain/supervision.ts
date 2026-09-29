import { createHash } from "node:crypto";
import type { SupervisorDecision } from "../agents/supervisor.js";

export type SupervisionMode = "off" | "bounded";
export const SUPERVISION_POLICY = Object.freeze({
  schema: "folioloom-supervision-1", batchWindows: 4, maxTurns: 4,
  maxAttemptsPerCheckpoint: 2, maxReviewsPerWindow: 3,
});
export interface SupervisionRecord {
  readonly id: string;
  readonly key: string;
  readonly event: "plan" | "review";
  readonly state: "started" | "completed" | "paused" | "failed" | "released";
  readonly windowIds: readonly string[];
  readonly inputHash: string;
  readonly candidateHash?: string;
  readonly conflictHash?: string;
  readonly decision?: SupervisorDecision;
  readonly modelCalls?: number;
  readonly totalTokens?: number;
  readonly usageComplete?: boolean;
  readonly reason?: string;
}
export interface SupervisionSummary {
  readonly mode: SupervisionMode;
  readonly decisions: number;
  readonly reviews: number;
  readonly revisionsRequested: number;
  readonly modelCalls: number;
  readonly knownTokens: number;
  readonly usageComplete: boolean;
  readonly paused: readonly string[];
  readonly pendingReviewWindowIds: readonly string[];
}
export function supervisionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
export function supervisionCandidateHash(translations: readonly { blockId: string; text: string }[]): string {
  return supervisionHash(translations.map(t => ({ blockId: t.blockId, text: t.text }))
    .sort((a, b) => a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
}
export function supervisionMetadata(mode: SupervisionMode): unknown {
  return mode === "off" ? undefined : { ...SUPERVISION_POLICY, mode };
}
export function validateSupervisionIdentity(stored: unknown, mode: SupervisionMode): void {
  if (JSON.stringify(stored) !== JSON.stringify(supervisionMetadata(mode))) {
    throw new Error("supervision policy mismatch; resume requires the original supervisor mode");
  }
}

export function summarizeSupervision(
  mode: SupervisionMode,
  records: readonly SupervisionRecord[],
  windows: readonly { windowId: string; blockIds: readonly string[]; status: string }[],
  active: readonly { blockId: string; text: string }[],
): SupervisionSummary {
  const completed = records.filter(r => r.state === "completed");
  const finished = records.filter(r => ["completed", "paused", "failed"].includes(r.state));
  const released = new Set(records.filter(r => r.state === "released").map(r => r.key));
  const paused = records.filter(r => r.state === "paused" && !released.has(r.id)).map(r => r.id);
  const pendingReviewWindowIds: string[] = [];
  if (mode === "bounded") {
    for (const window of windows.filter(w => w.status === "completed" || w.status === "completed_with_warnings")) {
      const plans = completed.filter(r => r.event === "plan" && r.decision?.action === "translate" && r.decision.windowIds.includes(window.windowId));
      if (!plans.length) { pendingReviewWindowIds.push(window.windowId); continue; }
      const requiresReview = plans.some(r => r.decision!.reviewBlockIds.some(id => window.blockIds.includes(id)));
      if (!requiresReview) continue;
      const candidateHash = supervisionCandidateHash(active.filter(t => window.blockIds.includes(t.blockId)));
      if (!completed.some(r => r.event === "review" && r.windowIds.includes(window.windowId)
        && r.candidateHash === candidateHash && r.decision?.action === "accept")) pendingReviewWindowIds.push(window.windowId);
    }
  }
  return {
    mode, decisions: completed.filter(r => r.event === "plan").length,
    reviews: completed.filter(r => r.event === "review").length,
    revisionsRequested: completed.filter(r => r.decision?.action === "revise").length,
    modelCalls: finished.reduce((n, r) => n + (r.modelCalls ?? 0), 0),
    knownTokens: finished.filter(r => r.usageComplete).reduce((n, r) => n + (r.totalTokens ?? 0), 0),
    usageComplete: finished.every(r => r.usageComplete !== false)
      && records.filter(r => r.state === "started").every(r => finished.some(f =>
        f.id === r.id.replace(/:started$/u, ":result") || f.id === r.id.replace(/:started$/u, ":failed"))),
    paused, pendingReviewWindowIds,
  };
}
