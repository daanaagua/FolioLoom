import type { SupervisorInput, SupervisorSource } from "../agents/supervisor.js";
import { allEvidenceReferences, paragraphEvidenceReferences, resolveEvidenceReference } from "../domain/evidence-reference.js";
import type { SurfaceConsistencyEvidence } from "../knowledge/surface-consistency.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";

export interface ReviewFocus { policy: "paragraph-delta-1" | "paragraph-delta-2"; sourceIds: string[]; targetIds: string[] }
type Candidate = readonly { blockId: string; text: string }[];
function paragraphs(text: string) {
  return semanticParagraphSpans(text).map(p => ({ text: p.sourceText, start: p.scalarStart, end: p.scalarEnd }));
}
/** Only a durable earlier review permits a delta; structural uncertainty falls back to full review. */
export function reviewFocus(sources: readonly SupervisorSource[], candidate: Candidate, previous: Candidate,
  terms: SupervisorInput["terms"], previousTerms: SupervisorInput["terms"], evidence: readonly SurfaceConsistencyEvidence[],
  priorIssues: readonly { blockId: string; sourceQuote: string; sourceRef?: string }[] = []): ReviewFocus | undefined {
  const changedForms = [...terms, ...previousTerms].filter(t =>
    !terms.some(n => canonicalJson(n) === canonicalJson(t)) || !previousTerms.some(n => canonicalJson(n) === canonicalJson(t))).map(t => t.sourceForm);
  const focus: ReviewFocus = { policy: "paragraph-delta-2", sourceIds: [], targetIds: [] };
  for (const block of candidate) {
    const source = sources.find(s => s.blockId === block.blockId);
    const old = previous.find(p => p.blockId === block.blockId);
    if (!source || !old) return undefined;
    const sourceParagraphs = paragraphs(source.sourceText), targetParagraphs = paragraphs(block.text), oldParagraphs = paragraphs(old.text);
    if (sourceParagraphs.length !== targetParagraphs.length || oldParagraphs.length !== targetParagraphs.length) return undefined;
    const selected = new Set<number>();
    const openRanges: { start: number; end: number }[] = [];
    for (const issue of priorIssues.filter(issue => issue.blockId === block.blockId)) {
      if (issue.sourceRef) {
        try {
          const ref = resolveEvidenceReference(allEvidenceReferences("source", block.blockId, source.sourceText), issue.sourceRef, "source", block.blockId, "review focus");
          if (!issue.sourceQuote || !ref.text.includes(issue.sourceQuote)) return undefined;
          openRanges.push({ start: ref.start, end: ref.end });
          continue;
        } catch { return undefined; }
      }
      const at = source.sourceText.indexOf(issue.sourceQuote);
      if (at < 0 || !issue.sourceQuote || source.sourceText.indexOf(issue.sourceQuote, at + 1) >= 0) return undefined;
      openRanges.push({ start: Array.from(source.sourceText.slice(0, at)).length,
        end: Array.from(source.sourceText.slice(0, at + issue.sourceQuote.length)).length });
    }
    for (let i = 0; i < sourceParagraphs.length; i++) {
      const sourceLower = sourceParagraphs[i]!.text.toLocaleLowerCase();
      if (targetParagraphs[i]!.text !== oldParagraphs[i]!.text || changedForms.some(f => sourceLower.includes(f.toLocaleLowerCase()))
        || evidence.some(e => e.blockId === block.blockId && sourceLower.includes(e.sourceForm.toLocaleLowerCase()))
        || openRanges.some(r => r.end > sourceParagraphs[i]!.start && r.start < sourceParagraphs[i]!.end)) {
        for (const n of [i - 1, i, i + 1]) if (n >= 0 && n < sourceParagraphs.length) selected.add(n);
      }
    }
    const selectIds = (side: "source" | "target", text: string) => paragraphEvidenceReferences(side, block.blockId, text)
      .filter((_r, i) => selected.has(i)).map(r => r.id);
    focus.sourceIds.push(...selectIds("source", source.sourceText));
    focus.targetIds.push(...selectIds("target", block.text));
  }
  return focus.sourceIds.length && focus.targetIds.length ? focus : undefined;
}
