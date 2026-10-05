import type { SupervisorInput, SupervisorSource } from "../agents/supervisor.js";
import { evidenceReferences } from "../domain/evidence-reference.js";
import type { SurfaceConsistencyEvidence } from "../knowledge/surface-consistency.js";
import { canonicalJson } from "../knowledge/knowledge-store.js";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";

export interface ReviewFocus { policy: "paragraph-delta-1"; sourceIds: string[]; targetIds: string[] }
type Candidate = readonly { blockId: string; text: string }[];
function paragraphs(text: string) {
  return semanticParagraphSpans(text).map(p => ({ text: p.sourceText, start: p.scalarStart, end: p.scalarEnd }));
}
/** Only a durable earlier review permits a delta; structural uncertainty falls back to full review. */
export function reviewFocus(sources: readonly SupervisorSource[], candidate: Candidate, previous: Candidate,
  terms: SupervisorInput["terms"], previousTerms: SupervisorInput["terms"], evidence: readonly SurfaceConsistencyEvidence[],
  priorIssues: readonly { blockId: string; sourceQuote: string }[] = []): ReviewFocus | undefined {
  const changedForms = [...terms, ...previousTerms].filter(t =>
    !terms.some(n => canonicalJson(n) === canonicalJson(t)) || !previousTerms.some(n => canonicalJson(n) === canonicalJson(t))).map(t => t.sourceForm);
  const focus: ReviewFocus = { policy: "paragraph-delta-1", sourceIds: [], targetIds: [] };
  for (const block of candidate) {
    const source = sources.find(s => s.blockId === block.blockId);
    const old = previous.find(p => p.blockId === block.blockId);
    if (!source || !old) return undefined;
    const sourceParagraphs = paragraphs(source.sourceText), targetParagraphs = paragraphs(block.text), oldParagraphs = paragraphs(old.text);
    if (sourceParagraphs.length !== targetParagraphs.length || oldParagraphs.length !== targetParagraphs.length) return undefined;
    const selected = new Set<number>();
    const openRanges = priorIssues.filter(issue => issue.blockId === block.blockId).flatMap(issue => {
      const at = source.sourceText.indexOf(issue.sourceQuote);
      return at < 0 || !issue.sourceQuote ? [] : [{ start: Array.from(source.sourceText.slice(0, at)).length,
        end: Array.from(source.sourceText.slice(0, at + issue.sourceQuote.length)).length }];
    });
    if (priorIssues.some(issue => issue.blockId === block.blockId) && !openRanges.length) return undefined;
    for (let i = 0; i < sourceParagraphs.length; i++) {
      if (targetParagraphs[i]!.text !== oldParagraphs[i]!.text || changedForms.some(f => sourceParagraphs[i]!.text.includes(f))
        || evidence.some(e => e.blockId === block.blockId && sourceParagraphs[i]!.text.includes(e.sourceForm))
        || openRanges.some(r => r.end > sourceParagraphs[i]!.start && r.start < sourceParagraphs[i]!.end)) {
        for (const n of [i - 1, i, i + 1]) if (n >= 0 && n < sourceParagraphs.length) selected.add(n);
      }
    }
    const selectIds = (side: "source" | "target", text: string, spans: ReturnType<typeof paragraphs>) => evidenceReferences(side, block.blockId, text)
      .filter(r => [...selected].some(i => r.end > spans[i]!.start && r.start < spans[i]!.end)).map(r => r.id);
    focus.sourceIds.push(...selectIds("source", source.sourceText, sourceParagraphs));
    focus.targetIds.push(...selectIds("target", block.text, targetParagraphs));
  }
  return focus.sourceIds.length && focus.targetIds.length ? focus : undefined;
}
