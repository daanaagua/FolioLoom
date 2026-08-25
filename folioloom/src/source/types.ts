import type { SourceLanguageProfile } from "../language/types.js";

export type StructureKind =
  | "volume_heading"
  | "chapter_heading"
  | "prose"
  | "epigraph";

export interface StructureAnnotation {
  id: string;
  kind: StructureKind;
  start: number;
  end: number;
  title: string;
  boundaryWeight: number;
}

export interface LosslessBlock {
  id: string;
  sourceVersion: string;
  canonicalStart: number;
  canonicalEnd: number;
  sourceText: string;
  sourceHash: string;
  globalIndex: number;
  tokenCount: number;
  /** Present for newly built plans; absent records use the explicit legacy protocol. */
  estimatorVersion?: string;
  structureId: string | null;
  structureTitle: string | null;
}

export interface CanonicalSegment {
  canonicalStart: number;
  canonicalEnd: number;
  originKind: string;
  originRef: string;
  transformation: string;
  rawStart?: number;
  rawEnd?: number;
}

export interface ExcludedRawRange {
  rawStart: number;
  rawEnd: number;
  policy: string;
}

export type AuditIncidentCode =
  | "SOURCE_SPAN_GAP"
  | "SOURCE_SPAN_OVERLAP"
  | "SOURCE_SPAN_INVALID"
  | "SOURCE_HASH_MISMATCH"
  | "SOURCE_TEXT_MISMATCH"
  | "SOURCE_VERSION_MISMATCH"
  | "BLOCK_ORDER_INVALID"
  | "BLOCK_ID_MISMATCH";

export interface AuditIncident {
  code: AuditIncidentCode;
  start: number;
  end: number;
  blockId?: string;
  detail?: string;
}

export interface AuditReport {
  ok: boolean;
  sourceChars: number;
  coveredChars: number;
  incidents: AuditIncident[];
}

/** A one-time map between Unicode scalar indexes and JavaScript UTF-16 offsets. */
export class UnicodeScalarMap {
  readonly text: string;
  readonly offsets: readonly number[];

  constructor(text: string) {
    this.text = text;
    const offsets = [0];
    let utf16Offset = 0;
    for (const scalar of text) {
      utf16Offset += scalar.length;
      offsets.push(utf16Offset);
    }
    this.offsets = offsets;
  }

  get length(): number {
    return this.offsets.length - 1;
  }

  toUtf16Offset(scalarIndex: number): number {
    if (!Number.isSafeInteger(scalarIndex)
      || scalarIndex < 0
      || scalarIndex > this.length) {
      throw new RangeError(`Unicode scalar index out of bounds: ${scalarIndex}`);
    }
    return this.offsets[scalarIndex] as number;
  }

  toScalarIndex(utf16Offset: number): number {
    if (!Number.isSafeInteger(utf16Offset)
      || utf16Offset < 0
      || utf16Offset > this.text.length) {
      throw new RangeError(`UTF-16 offset out of bounds: ${utf16Offset}`);
    }
    let low = 0;
    let high = this.offsets.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.offsets[middle] as number;
      if (candidate === utf16Offset) {
        return middle;
      }
      if (candidate < utf16Offset) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    throw new RangeError(`UTF-16 offset splits a Unicode scalar: ${utf16Offset}`);
  }

  slice(start: number, end: number): string {
    if (end < start) {
      throw new RangeError(`Unicode scalar range is reversed: [${start}, ${end})`);
    }
    return this.text.slice(this.toUtf16Offset(start), this.toUtf16Offset(end));
  }
}

export interface ScalarSource {
  readonly sourceText: string;
  readonly coordinates: UnicodeScalarMap;
  readonly sourceVersion?: string;
  readonly sourceLanguage?: string;
  readonly languageProfile?: SourceLanguageProfile;
}

export type SourceInput = string | ScalarSource;

export function coordinatesFor(input: SourceInput): UnicodeScalarMap {
  return typeof input === "string" ? new UnicodeScalarMap(input) : input.coordinates;
}

export function sourceTextFor(input: SourceInput): string {
  return typeof input === "string" ? input : input.sourceText;
}

export function scalarLength(text: string): number {
  return new UnicodeScalarMap(text).length;
}

export function scalarSlice(text: string, start: number, end: number): string {
  return new UnicodeScalarMap(text).slice(start, end);
}
