import { createHash } from "node:crypto";
import { semanticParagraphSpans } from "../text/paragraph-spans.js";

export type EvidenceSide = "source" | "target";
export interface EvidenceReference {
  readonly id: string;
  readonly side: EvidenceSide;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A field-level protocol failure, not a semantic translation failure. */
export class EvidenceReferenceError extends Error {
  readonly code = "EVIDENCE_REFERENCE_INVALID";
  readonly retryable = true;
  constructor(readonly field: string, readonly blockId: string, reason: string) {
    super(`${field} [blockId=${blockId}]: ${reason}. Select an issued reference for this block; do not rewrite unrelated entries.`);
    this.name = "EvidenceReferenceError";
  }
}

/**
 * Stable, content-bound references. Coordinates are Unicode scalars; a target
 * edit invalidates every reference into that candidate block. No fuzzy match.
 */
export function evidenceReferences(side: EvidenceSide, blockId: string, text: string): EvidenceReference[] {
  const hash = createHash("sha256").update(JSON.stringify([side, blockId, text])).digest("hex");
  const scalars = Array.from(text);
  const references: EvidenceReference[] = [];
  let start = 0;
  while (start < scalars.length) {
    let end = Math.min(start + 480, scalars.length);
    // Prefer readable sentence/paragraph boundaries without dropping whitespace.
    for (let index = start; index < end; index += 1) {
      if (index - start >= 120 && /[.!?。！？\n]/u.test(scalars[index]!)
        && (index + 1 === scalars.length || /\s|[”’"']/u.test(scalars[index + 1]!) || /[。！？]/u.test(scalars[index]!))) {
        end = index + 1;
        break;
      }
    }
    const quote = scalars.slice(start, end).join("");
    if (quote.trim()) references.push({ id: `${side[0]}:${hash}:${start}:${end}`, side, blockId, start, end, text: quote });
    start = end;
  }
  return references;
}

/** Model-facing review evidence never crosses or truncates a semantic paragraph. */
export function paragraphEvidenceReferences(side: EvidenceSide, blockId: string, text: string): EvidenceReference[] {
  const hash = createHash("sha256").update(JSON.stringify([side, blockId, text])).digest("hex");
  return semanticParagraphSpans(text).map(p => ({ id: `${side[0]}:${hash}:${p.scalarStart}:${p.scalarEnd}`,
    side, blockId, start: p.scalarStart, end: p.scalarEnd, text: p.sourceText }));
}

/** Existing journals keep their original ranges; new paragraphs add compatible ranges. */
export function allEvidenceReferences(side: EvidenceSide, blockId: string, text: string): EvidenceReference[] {
  return [...new Map([...evidenceReferences(side, blockId, text), ...paragraphEvidenceReferences(side, blockId, text)]
    .map(r => [r.id, r])).values()];
}

export function resolveEvidenceReference(
  references: readonly EvidenceReference[], id: unknown, side: EvidenceSide, blockId: string, field: string,
  issuedIds?: ReadonlySet<string>,
): EvidenceReference {
  const ref = typeof id === "string" ? references.find(r => r.id === id && r.side === side && r.blockId === blockId) : undefined;
  if (!ref || (issuedIds !== undefined && !issuedIds.has(ref.id))) {
    throw new EvidenceReferenceError(field, blockId, `unknown, stale, unissued or out-of-scope ${side} reference`);
  }
  return ref;
}
