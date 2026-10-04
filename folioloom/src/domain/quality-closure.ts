import { supervisionHash } from "./supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";

export interface PriorQualityIssue {
  issueId: string;
  blockId: string;
  sourceQuote: string;
  targetQuote: string;
  problem: string;
}
export interface QualityDisposition {
  issueId: string;
  status: "fixed" | "dismissed" | "variant" | "unresolved";
  sourceRef: string;
  targetRef: string;
  sourceQuote: string;
  targetQuote: string;
  note: string;
}
export interface QualityClosure {
  policy: "issue-closure-1";
  candidateHash: string;
  dispositions: readonly QualityDisposition[];
  decisionId: string;
  verificationDecisionId?: string;
}

/** Legacy quotations are parsed, never inferred; ungrounded entries stay open. */
export function priorQualityIssues(issues: readonly ValidationFailure[]): PriorQualityIssue[] {
  return issues.map((issue, index) => {
    const legacy = /^原文 ("(?:[^"\\]|\\.)*")；当前译文 ("(?:[^"\\]|\\.)*")；问题：([\s\S]*?)。只修正/u.exec(issue.message);
    const evidence = issue.evidence ?? (legacy ? {
      sourceQuote: JSON.parse(legacy[1]!) as string, targetQuote: JSON.parse(legacy[2]!) as string, problem: legacy[3]!,
    } : { sourceQuote: "", targetQuote: "", problem: issue.message });
    return { issueId: issue.issueKey ?? supervisionHash([issue.blockId, issue.message, index]),
      blockId: issue.blockId ?? "", ...evidence };
  });
}

export function needsDispositionVerification(disposition: QualityDisposition): boolean {
  return disposition.status === "dismissed" || disposition.status === "variant";
}

export function assertQualityClosure(prior: readonly PriorQualityIssue[], closure: QualityClosure, candidateHash: string): void {
  if (closure.policy !== "issue-closure-1" || closure.candidateHash !== candidateHash || !closure.decisionId
    || closure.dispositions.length !== prior.length || new Set(closure.dispositions.map(d => d.issueId)).size !== prior.length)
    throw new Error("invalid quality closure coverage or candidate");
  for (const issue of prior) {
    const d = closure.dispositions.find(d => d.issueId === issue.issueId);
    if (!d || !["fixed", "dismissed", "variant", "unresolved"].includes(d.status)
      || !d.note?.trim() || d.note.length > 160) throw new Error("invalid quality closure disposition");
    if (d.status !== "unresolved" && (!issue.sourceQuote || !d.sourceQuote || !d.targetQuote || !d.sourceRef || !d.targetRef))
      throw new Error("quality closure requires grounded evidence");
    if (needsDispositionVerification(d) && !closure.verificationDecisionId) throw new Error("quality reversal requires verification");
  }
}
