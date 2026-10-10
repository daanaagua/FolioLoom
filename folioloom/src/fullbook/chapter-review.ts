import { supervisionHash, type SupervisionRecord } from "../domain/supervision.js";
import type { LosslessBlock } from "../source/types.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";

export type ChapterReviewMode = "off" | "bounded";
export interface ChapterReviewScope { readonly id: string; readonly title: string; readonly windowIds: readonly string[] }
export interface ChapterReviewMetadata { readonly schema: "chapter-review-1"; readonly mode: "bounded"; readonly scopes: readonly ChapterReviewScope[] }
export interface ChapterReviewCheckpoint {
  readonly schema: "chapter-review-checkpoint-1";
  readonly scopeId: string;
  readonly windowIds: readonly string[];
  readonly decisionId: string;
  readonly candidateHash: string;
  readonly qualityItemIds: readonly string[];
}

/** Whole immutable windows retain the complete paragraphs on both sides of an EPUB chapter boundary. */
export function planChapterReviews(blocks: readonly LosslessBlock[], windows: readonly { windowId: string; blockIds: readonly string[] }[],
  profile: SourceLanguageProfile): ChapterReviewScope[] {
  if (!blocks.length || !windows.length) return [];
  const headings = blocks.flatMap(b => semanticParagraphSpans(b.sourceText).flatMap(p => {
    const heading = profile.detectStructureHeading(stripEpubStructuralMarkers(p.sourceText).trim());
    return heading?.kind === "chapter_heading" ? [{ start: b.canonicalStart + p.scalarStart, title: heading.title }] : [];
  }));
  const start = blocks[0]!.canonicalStart;
  const end = blocks.at(-1)!.canonicalEnd;
  if (!headings.length || headings[0]!.start > start) headings.unshift({ start, title: headings.length ? "Opening" : "Document" });
  const byId = new Map(blocks.map(b => [b.id, b]));
  const merged = new Map<string, { start: number; end: number; titles: string[]; windowIds: string[] }>();
  for (const [index, heading] of headings.entries()) {
    const chapterEnd = headings[index + 1]?.start ?? end;
    const windowIds = windows.filter(w => w.blockIds.some(id => {
      const block = byId.get(id);
      if (!block) throw new Error("chapter review window has unknown source block");
      return block.canonicalStart < chapterEnd && block.canonicalEnd > heading.start;
    })).map(w => w.windowId);
    if (!windowIds.length) continue;
    const key = windowIds.join("\0");
    const existing = merged.get(key);
    if (existing) { existing.end = chapterEnd; existing.titles.push(heading.title); }
    else merged.set(key, { start: heading.start, end: chapterEnd, titles: [heading.title], windowIds });
  }
  return [...merged.values()].map(group => ({
    id: supervisionHash(["chapter-review-1", blocks[0]!.sourceVersion, group.start, group.end, group.windowIds]),
    title: group.titles.join(" / ").slice(0, 240), windowIds: group.windowIds,
  }));
}

export function chapterReviewMetadata(scopes: readonly ChapterReviewScope[]): ChapterReviewMetadata {
  return { schema: "chapter-review-1", mode: "bounded", scopes };
}

export function chapterReviewCoverage(metadata: unknown, checkpoints: readonly ChapterReviewCheckpoint[], records: readonly SupervisionRecord[]) {
  const m = metadata as ChapterReviewMetadata | undefined;
  if (m === undefined) return undefined;
  if (m.schema !== "chapter-review-1" || m.mode !== "bounded" || !Array.isArray(m.scopes)
    || m.scopes.some(s => !/^[a-f0-9]{64}$/u.test(s.id) || !s.windowIds.length || new Set(s.windowIds).size !== s.windowIds.length)
    || new Set(m.scopes.map(s => s.id)).size !== m.scopes.length) throw new Error("invalid chapter review metadata");
  for (const c of checkpoints) {
    const scope = m.scopes.find(s => s.id === c.scopeId);
    const record = records.find(r => r.id === c.decisionId);
    if (c.schema !== "chapter-review-checkpoint-1" || !scope || !c.windowIds.length || !record
      || record.state !== "completed" || record.event !== "review" || record.chapterReview?.scopeId !== scope.id
      || record.candidateHash !== c.candidateHash || JSON.stringify(record.windowIds) !== JSON.stringify(c.windowIds)
      || c.windowIds.some(id => !scope.windowIds.includes(id)) || !Array.isArray(c.qualityItemIds)
      || !record.decision || !["accept", "revise"].includes(record.decision.action)
      || record.decision.issues.length > 0 && c.qualityItemIds.length === 0) {
      throw new Error("invalid chapter review checkpoint");
    }
  }
  const pendingScopes = m.scopes.flatMap((scope: ChapterReviewScope) => {
    const checked = new Set(checkpoints.filter(c => c.scopeId === scope.id).flatMap(c => c.windowIds));
    const windowIds = scope.windowIds.filter(id => !checked.has(id));
    return windowIds.length ? [{ ...scope, windowIds }] : [];
  });
  return { scopes: m.scopes.length, completedScopes: m.scopes.length - pendingScopes.length, pendingScopes };
}
