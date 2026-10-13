import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripEpubStructuralMarkers } from "./epub-structure.js";
import { UnicodeScalarMap } from "./types.js";

export interface ScopeSection { canonicalStart: number; canonicalEnd: number; originRef: string }
export class SourceScopeError extends Error {
  readonly code = "SOURCE_SCOPE_INVALID";
  readonly retryable = false;
  constructor(message: string) { super(message.startsWith("SOURCE_SCOPE_INVALID:") ? message : `SOURCE_SCOPE_INVALID: ${message}`); this.name = "SourceScopeError"; }
}
export interface ScopeOriginal {
  sourceVersion: string;
  sourceText: string;
  canonicalSegments: readonly ScopeSection[];
  rawSha256?: string;
  rawPath?: string;
}
export interface ScopePart {
  sectionIndex: number;
  start: number;
  end: number;
  disposition: "translate" | "exclude" | "regenerate";
  reason?: string;
}
export interface SourceScopePlan {
  schema: "folioloom-source-scope-plan-1";
  originalSourceVersion: string;
  parts: ScopePart[];
}
export interface SourceScopeCertificate {
  schema: "folioloom-source-scope-1";
  basis: "provided-input" | "original-reference";
  original: {
    sourceVersion: string;
    rawSha256: string;
    canonicalSha256: string;
    canonicalChars: number;
    sections: ScopeSection[];
  };
  parts: Array<ScopePart & { sourceHash: string }>;
  planHash: string;
  selectedTextHash: string;
  selectedCanonicalSha256: string;
  wholeOriginalSelected: boolean;
}
export interface SourceScopeEvidence extends SourceScopeCertificate { originManifest?: string }
export const sourceScopeHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** EPUB slot identifiers and inter-paragraph separators are not source prose. */
export function scopeVisibleText(text: string): string {
  return stripEpubStructuralMarkers(text).replace(/\r\n?/gu, "\n").split(/\n[\t ]*\n+/u)
    .map(paragraph => paragraph.trim()).filter(Boolean).join("\n\n");
}

export function createScopePlan(original: Pick<ScopeOriginal, "sourceVersion" | "canonicalSegments">): SourceScopePlan {
  return { schema: "folioloom-source-scope-plan-1", originalSourceVersion: original.sourceVersion,
    parts: original.canonicalSegments.map((section, sectionIndex) => ({ sectionIndex,
      start: section.canonicalStart, end: section.canonicalEnd, disposition: "translate" })) };
}

function checkedParts(plan: SourceScopePlan, original: SourceScopeCertificate["original"]): ScopePart[] {
  if (!plan || plan.schema !== "folioloom-source-scope-plan-1" || plan.originalSourceVersion !== original.sourceVersion)
    throw new SourceScopeError("SOURCE_SCOPE_INVALID: original identity mismatch");
  if (!Array.isArray(plan.parts) || plan.parts.length > 100_000) throw new SourceScopeError("SOURCE_SCOPE_INVALID: parts must be a bounded array");
  const result: ScopePart[] = [];
  let position = 0, sectionCursor = 0;
  for (const [sectionIndex, section] of original.sections.entries()) {
    if (!section || !Number.isSafeInteger(section.canonicalStart) || !Number.isSafeInteger(section.canonicalEnd)
      || section.canonicalStart !== sectionCursor || section.canonicalEnd < sectionCursor
      || section.canonicalEnd > original.canonicalChars || typeof section.originRef !== "string" || !section.originRef)
      throw new SourceScopeError("SOURCE_SCOPE_INVALID: original section coverage mismatch");
    let cursor = section.canonicalStart, count = 0;
    while (position < plan.parts.length && plan.parts[position]?.sectionIndex === sectionIndex) {
      const part = plan.parts[position++]!;
      if (!Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || part.start !== cursor
        || part.end < part.start || part.end > section.canonicalEnd
        || (part.end === part.start && (section.canonicalEnd !== section.canonicalStart || count !== 0))
        || !["translate", "exclude", "regenerate"].includes(part.disposition))
        throw new SourceScopeError("SOURCE_SCOPE_INVALID: part coverage gap, overlap or invalid disposition");
      if (part.disposition !== "translate" && (typeof part.reason !== "string" || !part.reason.trim() || part.reason.length > 1200))
        throw new SourceScopeError("SOURCE_SCOPE_INVALID: exclusion or regeneration requires a reason");
      if (part.reason !== undefined && (typeof part.reason !== "string" || part.reason.length > 1200))
        throw new SourceScopeError("SOURCE_SCOPE_INVALID: invalid reason");
      result.push({ sectionIndex, start: part.start, end: part.end, disposition: part.disposition,
        ...(part.reason === undefined ? {} : { reason: part.reason }) });
      cursor = part.end; count++;
    }
    if (count === 0 || cursor !== section.canonicalEnd) throw new SourceScopeError("SOURCE_SCOPE_INVALID: unaccounted original section coverage");
    sectionCursor = section.canonicalEnd;
  }
  if (position !== plan.parts.length || sectionCursor !== original.canonicalChars)
    throw new SourceScopeError("SOURCE_SCOPE_INVALID: original coverage mismatch or reordered parts");
  return result;
}

export function certifySourceScope(original: ScopeOriginal, plan: SourceScopePlan, selectedText: string,
  basis: SourceScopeCertificate["basis"] = "original-reference"): SourceScopeCertificate {
  if (!["provided-input", "original-reference"].includes(basis)) throw new SourceScopeError("invalid coverage basis");
  const coordinates = new UnicodeScalarMap(original.sourceText);
  const identity: SourceScopeCertificate["original"] = {
    sourceVersion: original.sourceVersion,
    rawSha256: original.rawSha256 ?? sourceScopeHash(readFileSync(original.rawPath!)),
    canonicalSha256: sourceScopeHash(original.sourceText), canonicalChars: coordinates.length,
    sections: original.canonicalSegments.map(s => ({ canonicalStart: s.canonicalStart, canonicalEnd: s.canonicalEnd, originRef: s.originRef })),
  };
  const normalized = checkedParts(plan, identity);
  const boundaries = new Set(identity.sections.flatMap(s => [s.canonicalStart, s.canonicalEnd]));
  for (const match of original.sourceText.matchAll(/\n[\t ]*\n+/gu)) {
    boundaries.add(coordinates.toScalarIndex(match.index)); boundaries.add(coordinates.toScalarIndex(match.index + match[0].length));
  }
  const parts = normalized.map(part => {
    if (!boundaries.has(part.start) || !boundaries.has(part.end)) throw new SourceScopeError("SOURCE_SCOPE_INVALID: split must use a paragraph or section boundary");
    return { ...part, sourceHash: sourceScopeHash(coordinates.slice(part.start, part.end)) };
  });
  const selected = parts.filter(p => p.disposition === "translate")
    .map(p => scopeVisibleText(coordinates.slice(p.start, p.end))).filter(Boolean).join("\n\n");
  if (selected !== scopeVisibleText(selectedText)) throw new SourceScopeError("SOURCE_SCOPE_INVALID: selected source text mismatch");
  const result: SourceScopeCertificate = { schema: "folioloom-source-scope-1", basis, original: identity, parts,
    planHash: sourceScopeHash(JSON.stringify({ schema: plan.schema, originalSourceVersion: plan.originalSourceVersion, parts: normalized })),
    selectedTextHash: sourceScopeHash(selected), selectedCanonicalSha256: sourceScopeHash(selectedText),
    wholeOriginalSelected: parts.every(p => p.disposition === "translate") };
  if (basis === "provided-input" && !result.wholeOriginalSelected) throw new SourceScopeError("SOURCE_SCOPE_INVALID: provided input cannot hide excluded ranges");
  validateSourceScope(result, sourceScopeHash(selectedText), selectedText);
  return result;
}

/** Validate the immutable certificate when reading a database without the source files. */
export function validateSourceScope(scope: SourceScopeCertificate, canonicalSha256: string, sourceText?: string): void {
  if (!scope || scope.schema !== "folioloom-source-scope-1" || !["provided-input", "original-reference"].includes(scope.basis)
    || !scope.original || !Number.isSafeInteger(scope.original.canonicalChars) || scope.original.canonicalChars < 0
    || !Array.isArray(scope.original.sections) || typeof scope.original.sourceVersion !== "string" || !scope.original.sourceVersion
    || scope.selectedCanonicalSha256 !== canonicalSha256)
    throw new SourceScopeError("SOURCE_SCOPE_INVALID: certificate identity mismatch");
  const parts = checkedParts({ schema: "folioloom-source-scope-plan-1", originalSourceVersion: scope.original.sourceVersion, parts: scope.parts }, scope.original);
  const digest = sourceScopeHash(JSON.stringify({ schema: "folioloom-source-scope-plan-1", originalSourceVersion: scope.original.sourceVersion, parts }));
  if (digest !== scope.planHash || scope.wholeOriginalSelected !== parts.every(p => p.disposition === "translate")
    || (scope.basis === "provided-input" && !scope.wholeOriginalSelected)
    || [scope.original.rawSha256, scope.original.canonicalSha256, scope.selectedTextHash, ...scope.parts.map(p => p.sourceHash)].some(h => typeof h !== "string" || !/^[a-f0-9]{64}$/u.test(h))
    || (sourceText !== undefined && sourceScopeHash(scopeVisibleText(sourceText)) !== scope.selectedTextHash))
    throw new SourceScopeError("SOURCE_SCOPE_INVALID: certificate coverage or content mismatch");
}
