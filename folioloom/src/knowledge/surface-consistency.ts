import { supervisionHash } from "../domain/supervision.js";
import { evidenceReferences } from "../domain/evidence-reference.js";
import type { AnchorCandidate, LexicalAnchor } from "../agents/lexical-anchorer.js";
import type { SourceLanguageProfile } from "../language/types.js";
import type { StableTerm } from "../domain/types.js";
import type { KnowledgeCandidate } from "./knowledge-store.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";

type Source = { blockId: string; sourceText: string };
type Translation = { blockId: string; text: string };
type Term = Pick<StableTerm, "sourceForm" | "target"> & Partial<StableTerm>;
export interface SurfaceMention {
  occurrenceId: string; sourceForm: string; blockId: string; paragraphIndex: number; sourceStart: number; sourceQuote: string;
  preferredTarget?: string;
}
export interface SurfaceUsageSubmission { occurrenceId: string; targetSurface: string }
export interface SurfaceUsage extends SurfaceMention { targetSurface: string; targetQuote: string }
const paragraphs = (text: string): string[] => text.split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u);

/** Bounded host identities; preferences are rendering conventions, never entity facts. */
export function surfaceMentions(sources: readonly Source[], anchors: readonly LexicalAnchor[], previous: readonly SurfaceObservation[], profile: SourceLanguageProfile): SurfaceMention[] {
  const forms = [...new Set([...anchors.filter(a => nameLike({ semanticClass: a.proposedSemanticClass ?? a.semanticClass ?? "unclassified" })).map(a => a.sourceForm),
    ...previous.filter(p => nameLike(p) && hasSemanticSurfaceEvidence(p) && !surfaceObservationNoiseReason(p)).map(p => p.sourceForm)])]
    .filter(form => sources.some(s => mention(s.sourceText, form, profile) >= 0)).slice(0, 16);
  const result: SurfaceMention[] = [];
  for (const source of sources) {
    let offset = 0;
    for (const [paragraphIndex, paragraph] of paragraphs(source.sourceText).entries()) {
      const start = source.sourceText.indexOf(paragraph, offset);
      for (const sourceForm of forms) {
        if (mention(paragraph, sourceForm, profile) < 0) continue;
        const masked = paragraph.replace(/⟦\/?E\d+\.\d+\.\d+⟧/gu, marker => " ".repeat(marker.length));
        for (let at = masked.indexOf(sourceForm); at >= 0; at = masked.indexOf(sourceForm, at + sourceForm.length)) {
          if (/[\p{L}\p{N}]/u.test(masked[at - 1] ?? "") || /[\p{L}\p{N}]/u.test(masked[at + sourceForm.length] ?? "")) continue;
          const sourceStart = start + at;
          const preferredTarget = previous.find(p => p.sourceForm === sourceForm && p.observedTarget)?.observedTarget ?? undefined;
          result.push({ occurrenceId: `surface-${supervisionHash([source.blockId, sourceForm, sourceStart])}`, sourceForm,
            blockId: source.blockId, paragraphIndex, sourceStart, sourceQuote: excerpt(paragraph, sourceForm, at), ...(preferredTarget ? { preferredTarget } : {}) });
          if (result.length >= 64) return result;
        }
      }
      offset = start + paragraph.length;
    }
  }
  return result;
}

/** Bad discovery metadata is discarded, never used to justify a name or rewrite. */
export function groundSurfaceUsages(mentions: readonly SurfaceMention[], submissions: readonly SurfaceUsageSubmission[], translations: readonly Translation[]): SurfaceUsage[] {
  const result: SurfaceUsage[] = [];
  for (const receipt of submissions) {
    const mention = mentions.find(m => m.occurrenceId === receipt.occurrenceId);
    if (!mention || submissions.filter(s => s.occurrenceId === receipt.occurrenceId).length !== 1 || typeof receipt.targetSurface !== "string" || !receipt.targetSurface.trim()) continue;
    const target = translations.find(t => t.blockId === mention.blockId)?.text;
    const paragraph = target === undefined ? undefined : paragraphs(target)[mention.paragraphIndex];
    if (!paragraph?.includes(receipt.targetSurface)) continue;
    result.push({ ...mention, targetSurface: receipt.targetSurface, targetQuote: excerpt(paragraph, receipt.targetSurface) });
  }
  return result;
}
export interface SurfaceObservation {
  schema: "surface-observation-1";
  sourceForm: string;
  blockId: string;
  windowId: string;
  sourceQuote: string;
  targetQuote: string;
  proposedTarget: string;
  observedTarget: string | null;
  semanticClass: string;
  confidence: number;
  evidenceHash: string;
  candidateHash: string;
  policy: "provisional-no-lock";
  occurrenceId?: string;
  paragraphIndex?: number;
}
export interface SurfaceConsistencyEvidence {
  sourceForm: string;
  blockId: string;
  sourceQuote: string;
  currentTargetQuote: string;
  previous: readonly { blockId: string; sourceQuote: string; targetQuote: string; target: string | null }[];
}

function mention(text: string, form: string, profile: SourceLanguageProfile): number {
  // Keep offsets in the original string while excluding host-owned markup.
  text = text.replace(/⟦\/?E\d+\.\d+\.\d+⟧/gu, marker => " ".repeat(marker.length));
  // Case is significant for inferred Latin names: a copper pot is not Copper.
  const index = text.indexOf(form);
  if (index < 0) return -1;
  const wanted = profile.normalizeAnchorSourceForm(form);
  return profile.segment(text).some(t => t.isWordLike && profile.normalizeAnchorSourceForm(t.value) === wanted) ? index : -1;
}
function excerpt(text: string, form: string, at = text.indexOf(form)): string {
  const index = Math.max(0, at);
  return text.slice(Math.max(0, index - 80), index + form.length + 160);
}
function nameLike(value: { semanticClass: string }): boolean {
  return ["proper_name", "unique_title", "form_of_address", "unclassified"].includes(value.semanticClass);
}

export function hasSemanticSurfaceEvidence(value: unknown): boolean {
  const p = value as Partial<SurfaceObservation> | undefined;
  return typeof p?.sourceForm === "string" && p.sourceForm.length > 0 && typeof p.sourceQuote === "string"
    && stripEpubStructuralMarkers(p.sourceQuote).includes(p.sourceForm);
}

export function surfaceObservationNoiseReason(value: unknown): "protocol_only" | "untyped_function_word" | undefined {
  const p = value as Partial<SurfaceObservation> | undefined;
  if (p?.schema !== "surface-observation-1") return undefined;
  if (!hasSemanticSurfaceEvidence(p)) return "protocol_only";
  if (p.semanticClass === "unclassified" && p.observedTarget === null && p.proposedTarget === ""
    && /^(?:I['’](?:ll|m|d|ve)|Thus|Therefore|However)$/u.test(p.sourceForm!)
    && !/\b(?:called|named|nicknamed|name)\b/iu.test(p.sourceQuote!)) return "untyped_function_word";
  return undefined;
}

export function readSurfaceObservations(revisions: readonly unknown[], active?: readonly Translation[]): SurfaceObservation[] {
  const observations = revisions.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as { kind?: string; status?: string; payload?: SurfaceObservation };
    const p = r.payload;
    return r.kind === "lexical_surface_observation" && r.status !== "rejected" && r.status !== "superseded"
      && p?.schema === "surface-observation-1" && typeof p.sourceForm === "string" && typeof p.blockId === "string"
      && typeof p.sourceQuote === "string" && typeof p.targetQuote === "string"
      && hasSemanticSurfaceEvidence(p) && !surfaceObservationNoiseReason(p)
      && (p.observedTarget === null || typeof p.observedTarget === "string") ? [p] : [];
  });
  if (!active) return observations;
  const targets = new Map(active.map(t => [t.blockId, t.text]));
  return observations.flatMap(p => {
    const target = targets.get(p.blockId);
    if (target === undefined) return [];
    const candidateHash = supervisionHash(target);
    if (candidateHash === p.candidateHash) return [p];
    if (p.occurrenceId) {
      const paragraph = paragraphs(target)[p.paragraphIndex ?? -1];
      const grounded = !!p.observedTarget && !!p.targetQuote && paragraph?.includes(p.targetQuote);
      return [{ ...p, candidateHash, observedTarget: grounded ? p.observedTarget : null, targetQuote: grounded ? p.targetQuote : "" }];
    }
    const observedTarget = [p.observedTarget, p.proposedTarget].find(t => t && target.includes(t)) ?? null;
    return [{ ...p, candidateHash, observedTarget, targetQuote: observedTarget ? excerpt(target, observedTarget) : "" }];
  });
}

export function validateSurfaceObservation(value: unknown, windowId: string, sources: readonly Source[], translations: readonly Translation[]): void {
  const p = value as SurfaceObservation | undefined;
  const source = sources.find(s => s.blockId === p?.blockId)?.sourceText;
  const target = translations.find(t => t.blockId === p?.blockId)?.text;
  if (!p || p.schema !== "surface-observation-1" || p.policy !== "provisional-no-lock" || p.windowId !== windowId
    || typeof p.sourceForm !== "string" || !p.sourceForm || !source?.includes(p.sourceForm)
    || typeof p.sourceQuote !== "string" || !p.sourceQuote || !source.includes(p.sourceQuote) || !hasSemanticSurfaceEvidence(p)
    || typeof p.proposedTarget !== "string" || typeof p.targetQuote !== "string" || typeof p.semanticClass !== "string"
    || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1
    || target === undefined || supervisionHash(target) !== p.candidateHash || supervisionHash(p.sourceQuote) !== p.evidenceHash
    || (p.observedTarget === null ? p.targetQuote !== "" : typeof p.observedTarget !== "string" || !p.observedTarget
      || !target.includes(p.observedTarget) || !p.targetQuote.includes(p.observedTarget) || !target.includes(p.targetQuote)))
    throw new Error("invalid grounded surface observation");
}

/** Repetition is memory, not another anchor call. New explicit naming evidence can reopen a decision. */
export function reconsiderSurfaceCandidates(candidates: readonly AnchorCandidate[], previous: readonly SurfaceObservation[], sources: readonly Source[], profile: SourceLanguageProfile): AnchorCandidate[] {
  const semanticQuote = (q: string) => stripEpubStructuralMarkers(q).replace(/\[\[\]\]/gu, "").replace(/\s+/gu, " ").trim();
  return candidates.flatMap(candidate => {
    const history = previous.filter(p => profile.normalizeSourceForm(p.sourceForm) === profile.normalizeSourceForm(candidate.sourceForm));
    const local = sources.filter(s => mention(s.sourceText, candidate.sourceForm, profile) >= 0)
      .map(s => excerpt(s.sourceText, candidate.sourceForm, mention(s.sourceText, candidate.sourceForm, profile)));
    if (!local.length) return [];
    const freshCue = local.find(q => (profile.hasExplicitEntityNamingCue(q)
      || (profile.id === "en" && /\b(?:called\s+(?:her|him|them)|(?:real\s+)?name\s+(?:was|is)|nicknamed)\b/iu.test(q)))
      && !history.some(p => p.evidenceHash === supervisionHash(q)));
    if (history.length && !freshCue && !candidate.sourceAuthoredTarget && (history.some(p => p.observedTarget !== null)
      || local.every(q => history.some(p => semanticQuote(p.sourceQuote) === semanticQuote(q))))) return [];
    return [{ ...candidate, contexts: [...new Set([...(freshCue ? [freshCue] : local.slice(0, 1)), ...candidate.contexts])].slice(0, 3) }];
  });
}

/** Host-grounded observations are persisted atomically with their translated window. */
export function surfaceObservations(input: {
  windowId: string; sources: readonly Source[]; translations: readonly Translation[];
  candidates: readonly AnchorCandidate[]; anchors: readonly LexicalAnchor[];
  previous: readonly SurfaceObservation[]; profile: SourceLanguageProfile;
  usages?: readonly SurfaceUsage[];
}): KnowledgeCandidate[] {
  const forms = new Set([...input.candidates.filter(c => c.likelyProperName).map(c => c.sourceForm),
    ...input.anchors.map(a => a.sourceForm), ...input.previous.filter(nameLike).map(p => p.sourceForm)]);
  const result: KnowledgeCandidate[] = [];
  for (const sourceForm of forms) {
    const anchor = input.anchors.find(a => a.sourceForm === sourceForm);
    const previous = input.previous.filter(p => p.sourceForm === sourceForm);
    const semanticClass = anchor?.proposedSemanticClass ?? anchor?.semanticClass ?? previous.at(-1)?.semanticClass ?? "unclassified";
    if (!nameLike({ semanticClass })) continue;
    const proposedTarget = anchor?.target ?? previous.at(-1)?.proposedTarget ?? "";
    for (const source of input.sources.filter(s => mention(s.sourceText, sourceForm, input.profile) >= 0)) {
      const translation = input.translations.find(t => t.blockId === source.blockId);
      if (!translation) continue;
      const mentions = surfaceMentions([source], input.anchors, input.previous, input.profile);
      const receipts = groundSurfaceUsages(mentions, input.usages ?? [], [translation]);
      const localReceipts = receipts.filter(r => r.sourceForm === sourceForm);
      const localMentions = mentions.filter(m => m.sourceForm === sourceForm);
      if (localMentions.length && (localReceipts.length || input.usages !== undefined)) {
        for (const mention of localMentions) {
          const receipt = localReceipts.find(r => r.occurrenceId === mention.occurrenceId);
          const payload: SurfaceObservation = { schema: "surface-observation-1", sourceForm, blockId: source.blockId, windowId: input.windowId,
            sourceQuote: mention.sourceQuote, targetQuote: receipt?.targetQuote ?? "", proposedTarget, observedTarget: receipt?.targetSurface ?? null,
            semanticClass, confidence: anchor?.confidence ?? previous.at(-1)?.confidence ?? 0, evidenceHash: supervisionHash(mention.sourceQuote),
            candidateHash: supervisionHash(translation.text), policy: "provisional-no-lock", occurrenceId: mention.occurrenceId, paragraphIndex: mention.paragraphIndex };
          result.push({ recordId: `surface-${supervisionHash([mention.occurrenceId, payload.candidateHash])}`,
            normalizedSubject: `${input.profile.normalizeSourceForm(sourceForm)}:${mention.occurrenceId}`, kind: "lexical_surface_observation", payload });
        }
        continue;
      }
      const knownTargets = [...new Set([proposedTarget, ...previous.flatMap(p => p.observedTarget ? [p.observedTarget] : [])])].filter(Boolean);
      const observedTarget = knownTargets.find(t => translation.text.includes(t)) ?? null;
      const sourceQuote = excerpt(source.sourceText, sourceForm, mention(source.sourceText, sourceForm, input.profile));
      const payload: SurfaceObservation = { schema: "surface-observation-1", sourceForm, blockId: source.blockId, windowId: input.windowId,
        sourceQuote, targetQuote: observedTarget ? excerpt(translation.text, observedTarget) : "", proposedTarget, observedTarget,
        semanticClass, confidence: anchor?.confidence ?? previous.at(-1)?.confidence ?? 0,
        evidenceHash: supervisionHash(sourceQuote), candidateHash: supervisionHash(translation.text), policy: "provisional-no-lock" };
      const id = supervisionHash([sourceForm, source.blockId, payload.candidateHash]);
      result.push({ recordId: `surface-${id}`, normalizedSubject: `${input.profile.normalizeSourceForm(sourceForm)}:${source.blockId}`,
        kind: "lexical_surface_observation", payload });
    }
  }
  return result;
}

/** Only changed/unknown realizations enter semantic review; no nickname becomes an identity alias. */
export function surfaceConsistencyEvidence(input: {
  sources: readonly Source[]; translations: readonly Translation[]; observations: readonly SurfaceObservation[];
  terms: readonly Term[]; profile: SourceLanguageProfile;
}): SurfaceConsistencyEvidence[] {
  const result: SurfaceConsistencyEvidence[] = [];
  const byForm = new Map<string, SurfaceObservation[]>();
  for (const observation of input.observations.filter(o => nameLike(o) && hasSemanticSurfaceEvidence(o))) {
    const history = byForm.get(observation.sourceForm) ?? [];
    history.push(observation);
    byForm.set(observation.sourceForm, history);
  }
  for (const source of input.sources) {
    const target = input.translations.find(t => t.blockId === source.blockId)?.text;
    if (!target) continue;
    for (const [sourceForm, all] of byForm) {
      if (mention(source.sourceText, sourceForm, input.profile) < 0) continue;
      const local = all.filter(o => o.blockId === source.blockId && o.candidateHash === supervisionHash(target) && o.occurrenceId);
      const localTargets = [...new Set(local.flatMap(o => o.observedTarget ? [o.observedTarget] : []))];
      const unknown = local.some(o => o.observedTarget === null);
      const history = all.filter(o => o.blockId !== source.blockId || localTargets.length > 1 || (unknown && local.length > 1));
      if (!history.length) continue;
      const scoped = input.terms.filter(t => input.profile.normalizeSourceForm(t.sourceForm) === input.profile.normalizeSourceForm(sourceForm)
        && (!t.applicableBlockIds || t.applicableBlockIds.includes(source.blockId)));
      if (!unknown && scoped.some(t => localTargets.length ? localTargets.every(v => [t.target, ...(t.allowedTargets ?? [])].includes(v))
        : [t.target, ...(t.allowedTargets ?? [])].some(v => target.includes(v)))) continue;
      const known = [...new Set(history.flatMap(p => p.observedTarget ? [p.observedTarget] : []))];
      if (!unknown && localTargets.length <= 1 && known.length === 1 && (localTargets.length ? localTargets.every(t => t === known[0]) : target.includes(known[0]!))) continue;
      const distinct = [...new Map(history.map(p => [p.observedTarget ?? "unknown", p])).values()].slice(-2);
      const changed = local.find(p => p.observedTarget && (known.length !== 1 || p.observedTarget !== known[0])) ?? local[0];
      const sourceRef = evidenceReferences("source", source.blockId, source.sourceText).find(r => changed
        ? r.text.includes(changed.sourceQuote) || changed.sourceQuote.includes(r.text) : stripEpubStructuralMarkers(r.text).includes(sourceForm));
      if (!sourceRef) continue;
      result.push({ sourceForm, blockId: source.blockId, sourceQuote: sourceRef.text,
        currentTargetQuote: evidenceReferences("target", source.blockId, target).find(r => changed?.observedTarget ? r.text.includes(changed.observedTarget) : true)?.text ?? "",
        previous: distinct.map(p => ({ blockId: p.blockId, sourceQuote: p.sourceQuote, targetQuote: p.targetQuote, target: p.observedTarget })) });
      if (result.length >= 8) return result;
    }
  }
  return result;
}
