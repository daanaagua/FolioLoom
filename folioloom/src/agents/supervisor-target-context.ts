import { createHash } from "node:crypto";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";
import type { SupervisorInput } from "./supervisor.js";
import { boundedTextExcerpt, type ExcerptRange } from "../text/bounded-excerpt.js";

/** Comparison text is read-only; it never expands the candidate's repair scope. */
export function searchSupervisorTargets(input: Pick<SupervisorInput, "sources" | "targetContext">, query: string, limit: number) {
  const needle = query.toLocaleLowerCase();
  const sources = new Map(input.sources.map(b => [b.blockId, b]));
  const excerpt = (text: string) => {
    const visible = stripEpubStructuralMarkers(text);
    const index = visible.toLocaleLowerCase().indexOf(needle);
    return boundedTextExcerpt(visible, 900, Array.from(visible.slice(0, Math.max(0, index))).length);
  };
  const hits: Array<{ blockId: string; globalIndex: number; translationHash: string;
    alignment: string; sourceExcerpt: string; targetExcerpt: string; sourceRange: ExcerptRange; targetRange: ExcerptRange }> = [];
  for (const target of input.targetContext ?? []) {
    if (hits.length >= limit) break;
    const source = sources.get(target.blockId)!;
    const sourceParagraphs = semanticParagraphSpans(source.sourceText);
    const targetParagraphs = semanticParagraphSpans(target.text);
    const matching = (rows: typeof sourceParagraphs) => rows.findIndex(p =>
      stripEpubStructuralMarkers(p.sourceText).toLocaleLowerCase().includes(needle));
    const sourceIndex = matching(sourceParagraphs), targetIndex = matching(targetParagraphs);
    if (sourceIndex < 0 && targetIndex < 0) continue;
    const aligned = sourceParagraphs.length === targetParagraphs.length;
    const index = sourceIndex >= 0 ? sourceIndex : targetIndex;
    const sourcePreview = excerpt(sourceParagraphs[aligned ? index : Math.max(0, sourceIndex)]?.sourceText ?? source.sourceText);
    const targetPreview = excerpt(targetParagraphs[aligned ? index : Math.max(0, targetIndex)]?.sourceText ?? target.text);
    hits.push({ blockId: target.blockId, globalIndex: source.globalIndex,
      translationHash: createHash("sha256").update(target.text).digest("hex"),
      alignment: aligned ? "paragraph" : "block_only",
      sourceExcerpt: sourcePreview.text, targetExcerpt: targetPreview.text,
      sourceRange: sourcePreview.range, targetRange: targetPreview.range });
  }
  return { readOnly: true, hits };
}

export function validateSupervisorTargetContext(input: SupervisorInput): void {
  if (input.targetContext === undefined) return;
  const allowed = new Set(input.sources.map(b => b.blockId));
  const ids = input.targetContext.map(b => b.blockId);
  if (input.event !== "review" || new Set(ids).size !== ids.length
    || input.targetContext.some(b => !allowed.has(b.blockId) || typeof b.text !== "string"))
    throw new Error("supervisor target context outside source scope or duplicate block");
}
