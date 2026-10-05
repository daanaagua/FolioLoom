import { supervisionHash } from "./supervision.js";
import type { ValidationFailure } from "../tools/repair-tools.js";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";

/** A bounded exact edit alignment; insertions at a quote edge can restore negation. */
function editedAtQuote(before: string, after: string, offset: number, start: number, end: number): boolean {
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const a = before.slice(prefix, before.length - suffix), b = after.slice(prefix, after.length - suffix);
  const base = offset + prefix;
  if (!a.length) return b.length > 0 && base >= start && base <= end;
  if (!b.length) return base < end && base + a.length > start;
  // Oversized ambiguous differences remain unproven, rather than guessing locality.
  if ((a.length + 1) * (b.length + 1) > 1_000_000) return false;
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1
      : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    if (j < b.length && (i === a.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!)) {
      if (base + i >= start && base + i <= end) return true;
      j++;
    } else {
      if (base + i < end && base + i + 1 > start) return true;
      i++;
    }
  }
  return false;
}

/** Text-change evidence only: a grounded semantic review must still approve the repair. */
export function hasChangedIssueEvidence(quote: string, after: string, before?: string): boolean {
  if (!quote) return false;
  if (!after.includes(quote)) return true;
  if (before === undefined || before === after) return false;
  const start = before.indexOf(quote);
  if (start < 0 || before.indexOf(quote, start + 1) >= 0) return false;
  const original = semanticParagraphSpans(before), updated = semanticParagraphSpans(after);
  if (original.length !== updated.length) return false;
  return original.some((p, index) => p.utf16Start <= start + quote.length && p.utf16End >= start
    && editedAtQuote(p.sourceText, updated[index]!.sourceText, p.utf16Start, start, start + quote.length));
}

export interface PriorQualityIssue {
  issueId: string;
  blockId: string;
  sourceQuote: string;
  targetQuote: string;
  problem: string;
  sourceRef?: string;
  targetRef?: string;
  sourceScopeQuote?: string;
  targetScopeQuote?: string;
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
