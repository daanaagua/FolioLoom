export interface LexicalReviewHint {
  readonly sourceForm: string;
  readonly proposedTarget: string;
  readonly classification: string;
  readonly readOnly: true;
  readonly occurrences: readonly { blockId: string; paragraphIndex: number; sourceStart: number }[];
  readonly examples: readonly { blockId: string; paragraphIndex: number; sourceExcerpt: string; targetExcerpt: string }[];
}
export function lexicalReviewHints(input: {
  revisions: readonly unknown[];
  sources: readonly { blockId: string; sourceText: string }[];
  translations: readonly { blockId: string; text: string }[];
  scopeBlockIds: readonly string[];
}): LexicalReviewHint[] {
  const scope = new Set(input.scopeBlockIds), targets = new Map(input.translations.map(t => [t.blockId, t.text]));
  const result: LexicalReviewHint[] = [];
  const mixedSurfaces = new Set<string>();
  const seen = new Set<string>();
  for (const raw of input.revisions) {
    const r = raw as { kind?: string; status?: string; payload?: Record<string, unknown> } | null;
    const p = r?.payload;
    if (r?.kind !== "lexical_anchor_decision" || !["active", "contextual"].includes(r.status ?? "")
      || !p || p.semanticClass !== "ordinary_word"
      || typeof p.sourceForm !== "string" || !p.sourceForm.trim() || p.sourceForm.length > 128
      || typeof p.target !== "string" || !p.target.trim() || seen.has(p.sourceForm)) continue;
    seen.add(p.sourceForm);
    const sourceForm = p.sourceForm, proposedTarget = p.target;
    const escaped = sourceForm.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expression = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
    const occurrences: LexicalReviewHint["occurrences"][number][] = [];
    const examples: LexicalReviewHint["examples"][number][] = [];
    let referencePresent = false, referenceAbsent = false;
    for (const source of input.sources) {
      const target = targets.get(source.blockId);
      if (target === undefined) continue;
      const sourceParagraphs = semanticParagraphSpans(source.sourceText), targetParagraphs = semanticParagraphSpans(target);
      if (sourceParagraphs.length !== targetParagraphs.length) continue;
      for (const [paragraphIndex, paragraph] of sourceParagraphs.entries()) {
        const text = stripEpubStructuralMarkers(paragraph.sourceText);
        const matches = [...text.matchAll(expression)];
        if (!matches.length) continue;
        occurrences.push(...matches.map(m => ({ blockId: source.blockId, paragraphIndex, sourceStart: m.index })));
        const translated = stripEpubStructuralMarkers(targetParagraphs[paragraphIndex]!.sourceText);
        if (translated.includes(proposedTarget)) referencePresent = true;
        else referenceAbsent = true;
        examples.push({ blockId: source.blockId, paragraphIndex,
          sourceExcerpt: boundedTextExcerpt(text, 480, Array.from(text.slice(0, matches[0]!.index)).length).text,
          targetExcerpt: boundedTextExcerpt(translated, 480, Array.from(translated.slice(0, Math.max(0, translated.indexOf(proposedTarget)))).length).text });
      }
    }
    if (occurrences.length < 3 || !occurrences.some(o => scope.has(o.blockId))) continue;
    // Literal presence is a review clue, not a semantic verdict or a score.
    if (referencePresent && referenceAbsent) mixedSurfaces.add(sourceForm);
    const local = examples.filter(e => scope.has(e.blockId)), other = examples.filter(e => !scope.has(e.blockId));
    const selected = [local[0], local.at(-1), other[0], other.at(-1)].filter((e): e is typeof examples[number] => !!e);
    result.push({ sourceForm, proposedTarget, classification: "ordinary_word", readOnly: true,
      occurrences, examples: [...new Map(selected.map(e => [`${e.blockId}:${e.paragraphIndex}`, e])).values()] });
  }
  return result.sort((a, b) => Number(mixedSurfaces.has(b.sourceForm)) - Number(mixedSurfaces.has(a.sourceForm))
    || b.occurrences.filter(o => scope.has(o.blockId)).length - a.occurrences.filter(o => scope.has(o.blockId)).length
    || a.sourceForm.localeCompare(b.sourceForm)).slice(0, 6);
}
import { semanticParagraphSpans } from "../text/paragraph-spans.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";
import { boundedTextExcerpt } from "../text/bounded-excerpt.js";
