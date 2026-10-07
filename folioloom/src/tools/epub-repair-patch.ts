import type { V4Block } from "../domain/types.js";
import { priorQualityIssues } from "../domain/quality-closure.js";
import { supervisionCandidateHash } from "../domain/supervision.js";
import { allEvidenceReferences } from "../domain/evidence-reference.js";
import { epubStructuralTranslationError, resolveEpubVisibleQuote, stripEpubStructuralMarkers } from "../source/epub-structure.js";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";
import type { TranslationCandidate } from "./candidate-collector.js";
import type { ValidationFailure } from "./repair-tools.js";

export const EPUB_TEXT_PATCH_PROTOCOL = "epub-text-patch-1";
/** A valid, candidate-bound no-change proposal is unresolved semantic evidence, not a repaired candidate. */
export class EpubRepairNoChangeError extends Error {
  constructor(readonly candidateHash: string) {
    super("EPUB repair proposed no text change");
    this.name = "EpubRepairNoChangeError";
  }
}
interface TextSlot {
  readonly blockId: string;
  readonly slotId: string;
  readonly sourceText: string;
  readonly expectedText: string;
  readonly start: number;
  readonly end: number;
}
export interface EpubRepairPlan {
  readonly protocol: typeof EPUB_TEXT_PATCH_PROTOCOL;
  readonly baseCandidateHash: string;
  readonly blocks: readonly V4Block[];
  readonly slots: readonly TextSlot[];
  readonly paragraphs: readonly { blockId: string; ordinal: number; editable: boolean; source: string; target: string }[];
}
export interface EpubTextPatch {
  readonly baseCandidateHash: string;
  readonly patches: readonly { blockId: string; slotId: string; expectedText: string; text: string }[];
  readonly notes: readonly string[];
}

/** Grounded sub-block repairs use inline slots or whole plain-text paragraphs. */
export function prepareEpubRepairPlan(
  blocks: readonly V4Block[], candidate: TranslationCandidate, failures: readonly ValidationFailure[],
): EpubRepairPlan | undefined {
  if (!failures.length || failures.some(f => f.code !== "SUPERVISOR_SEMANTIC_REVIEW")) return undefined;
  // Keep the existing block protocol when there is no smaller structural unit.
  if (!blocks.some(b => /⟦E\d+\.\d+\.\d+⟧/u.test(b.sourceText)
    || semanticParagraphSpans(b.sourceText).length > 1)) return undefined;
  const targetById = new Map(candidate.translations.map(t => [t.blockId, t.text]));
  if (targetById.size !== candidate.translations.length || targetById.size !== blocks.length) throw new Error("EPUB patch candidate scope mismatch");
  const slots: TextSlot[] = [];
  const paragraphs: EpubRepairPlan["paragraphs"][number][] = [];
  const issues = priorQualityIssues(failures);
  if (issues.some(i => !blocks.some(b => b.id === i.blockId))) throw new Error("EPUB patch issue outside block scope");
  for (const block of blocks) {
    const target = targetById.get(block.id);
    if (target === undefined) throw new Error("EPUB patch candidate is missing a block");
    const error = epubStructuralTranslationError(block.sourceText, target);
    if (error) throw new Error(`EPUB patch requires valid structural slots: ${error}`);
    const sources = semanticParagraphSpans(block.sourceText), targets = semanticParagraphSpans(target);
    if (sources.length !== targets.length) throw new Error("EPUB patch paragraph alignment mismatch");
    const owned = new Set<number>();
    for (const issue of issues.filter(i => i.blockId === block.id)) {
      const sourceRef = issue.sourceRef ? allEvidenceReferences("source", block.id, block.sourceText).find(r => r.id === issue.sourceRef) : undefined;
      const targetRef = issue.targetRef ? allEvidenceReferences("target", block.id, target).find(r => r.id === issue.targetRef) : undefined;
      if (issue.sourceRef && !sourceRef || issue.targetRef && !targetRef) throw new Error("EPUB patch issue reference is stale");
      if (sourceRef && issue.sourceScopeQuote !== undefined && issue.sourceScopeQuote !== sourceRef.text
        || targetRef && issue.targetScopeQuote !== undefined && issue.targetScopeQuote !== targetRef.text)
        throw new Error("EPUB patch issue scope does not match its reference");
      const scope = targetRef?.text ?? (issue.targetScopeQuote === undefined ? target : resolveEpubVisibleQuote(target, issue.targetScopeQuote));
      const sourceScope = sourceRef?.text ?? (issue.sourceScopeQuote === undefined ? block.sourceText : resolveEpubVisibleQuote(block.sourceText, issue.sourceScopeQuote));
      if (!issue.targetQuote && sourceRef && !issue.targetRef) {
        if (!issue.sourceQuote || !resolveEpubVisibleQuote(sourceRef.text, issue.sourceQuote)) throw new Error("EPUB patch omission evidence is stale");
        const start = Array.from(block.sourceText).slice(0, sourceRef.start).join("").length;
        const end = Array.from(block.sourceText).slice(0, sourceRef.end).join("").length;
        for (const p of sources) if (p.utf16Start < end && p.utf16End > start) owned.add(p.ordinal);
        continue;
      }
      if (!scope || !sourceScope) throw new Error("EPUB patch issue scope is stale or missing");
      const scopeStart = targetRef ? Array.from(target).slice(0, targetRef.start).join("").length : target.indexOf(scope);
      if (!targetRef && issue.targetScopeQuote !== undefined && target.indexOf(scope, scopeStart + 1) >= 0)
        throw new Error("EPUB patch issue scope is ambiguous");
      const quote = issue.targetQuote && resolveEpubVisibleQuote(scope, issue.targetQuote);
      const sourceQuote = issue.sourceQuote && resolveEpubVisibleQuote(sourceScope, issue.sourceQuote);
      if (!quote || !sourceQuote) throw new Error("EPUB patch issue evidence is stale or missing");
      const first = scope.indexOf(quote);
      if (!targetRef && issue.targetScopeQuote === undefined && scope.indexOf(quote, first + 1) >= 0)
        throw new Error("EPUB patch issue evidence is ambiguous");
      for (let offset = first; offset >= 0; offset = scope.indexOf(quote, offset + 1)) {
        const start = scopeStart + offset;
        for (const p of targets) if (p.utf16Start < start + quote.length && p.utf16End > start) owned.add(p.ordinal);
      }
    }
    for (const p of targets) {
      if (!owned.has(p.ordinal) && !owned.has(p.ordinal - 1) && !owned.has(p.ordinal + 1)) continue;
      const source = sources[p.ordinal]!;
      paragraphs.push({ blockId: block.id, ordinal: p.ordinal, editable: owned.has(p.ordinal),
        source: stripEpubStructuralMarkers(source.sourceText), target: stripEpubStructuralMarkers(p.sourceText) });
      if (!owned.has(p.ordinal)) continue;
      const sourceSlots = new Map([...source.sourceText.matchAll(/⟦(E\d+\.\d+\.\d+)⟧([\s\S]*?)⟦\/\1⟧/gu)]
        .map(m => [m[1]!, m[2]!]));
      if (!sourceSlots.size) {
        slots.push({ blockId: block.id, slotId: `P${p.ordinal}`, sourceText: source.sourceText,
          expectedText: p.sourceText, start: p.utf16Start, end: p.utf16End });
        continue;
      }
      for (const match of p.sourceText.matchAll(/⟦(E\d+\.\d+\.\d+)⟧([\s\S]*?)⟦\/\1⟧/gu)) {
        const slotId = match[1]!, sourceText = sourceSlots.get(slotId);
        if (sourceText === undefined) throw new Error("EPUB patch slot not found in source");
        // Empty/whitespace-only source slots include fixed <br/> nodes; never edit them.
        if (!sourceText.trim()) continue;
        const start = p.utf16Start + match.index + `⟦${slotId}⟧`.length;
        slots.push({ blockId: block.id, slotId, sourceText, expectedText: match[2]!, start, end: start + match[2]!.length });
      }
    }
  }
  if (!slots.length || new Set(slots.map(s => `${s.blockId}:${s.slotId}`)).size !== slots.length) throw new Error("EPUB patch has no unique editable slots");
  return { protocol: EPUB_TEXT_PATCH_PROTOCOL, baseCandidateHash: supervisionCandidateHash(candidate.translations),
    blocks: structuredClone(blocks), slots, paragraphs };
}

function exactKeys(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== names.length || names.some(k => !Object.hasOwn(value, k))) throw new Error("invalid EPUB patch fields");
}

/** Wire positions are issued once; identity and optimistic concurrency stay host-owned. */
export function applyEpubRepairValues(plan: EpubRepairPlan, current: TranslationCandidate, values: unknown): TranslationCandidate {
  if (!Array.isArray(values) || values.length !== plan.slots.length)
    throw new Error("EPUB repair values must match the exact issued slot count");
  const patches: EpubTextPatch["patches"][number][] = [];
  for (let index = 0; index < plan.slots.length; index++) {
    const value: unknown = values[index];
    if (value === null) continue;
    if (typeof value !== "string") throw new Error("EPUB repair values must be strings or null");
    const slot = plan.slots[index]!;
    patches.push({ blockId: slot.blockId, slotId: slot.slotId, expectedText: slot.expectedText, text: value });
  }
  return applyEpubTextPatch(plan, current, { baseCandidateHash: plan.baseCandidateHash, patches, notes: [] });
}

/** Validate the complete patch first, then apply text-only replacements atomically. */
export function applyEpubTextPatch(plan: EpubRepairPlan, current: TranslationCandidate, patch: EpubTextPatch): TranslationCandidate {
  exactKeys(patch, ["baseCandidateHash", "patches", "notes"]);
  if (patch.baseCandidateHash !== plan.baseCandidateHash || supervisionCandidateHash(current.translations) !== plan.baseCandidateHash)
    throw new Error("stale EPUB patch candidate");
  if (!Array.isArray(patch.patches) || patch.patches.length > plan.slots.length
    || !Array.isArray(patch.notes) || patch.notes.some(n => typeof n !== "string")) throw new Error("invalid EPUB patch payload");
  const seen = new Set<string>();
  const edits: { slot: TextSlot; text: string }[] = [];
  for (const edit of patch.patches) {
    exactKeys(edit, ["blockId", "slotId", "expectedText", "text"]);
    const key = `${edit.blockId}:${edit.slotId}`;
    const slot = plan.slots.find(s => s.blockId === edit.blockId && s.slotId === edit.slotId);
    if (!slot || seen.has(key)) throw new Error("duplicate or unauthorized EPUB patch slot");
    seen.add(key);
    if (edit.expectedText !== slot.expectedText || typeof edit.text !== "string") throw new Error("EPUB patch expected text mismatch");
    if (/[⟦⟧\r\n]/u.test(edit.text) || edit.text.includes("[[]]")) throw new Error("EPUB patch cannot contain structural markers or separators");
    if (edit.text !== edit.expectedText) edits.push({ slot, text: edit.text });
  }
  if (!edits.length) throw new EpubRepairNoChangeError(plan.baseCandidateHash);
  const translations = current.translations.map(t => {
    let text = t.text;
    for (const { slot, text: replacement } of edits.filter(e => e.slot.blockId === t.blockId).sort((a, b) => b.slot.start - a.slot.start))
      text = text.slice(0, slot.start) + replacement + text.slice(slot.end);
    const source = plan.blocks.find(b => b.id === t.blockId)!;
    if (epubStructuralTranslationError(source.sourceText, text)) throw new Error("EPUB patch changed structural alignment");
    return { blockId: t.blockId, text };
  });
  return { translations, notes: [...patch.notes], repaired: true };
}
