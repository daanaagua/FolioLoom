export interface ExcerptRange {
  readonly coordinateUnit: "unicode_scalar";
  readonly start: number;
  readonly end: number;
  readonly totalCharacters: number;
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
}

/** Bounded preview coordinates refer to the supplied visible text, not an enclosing file. */
export function boundedTextExcerpt(text: string, maxCharacters: number, focusStart = 0): { text: string; range: ExcerptRange } {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0
    || !Number.isSafeInteger(focusStart) || focusStart < 0) throw new TypeError("invalid excerpt bounds");
  const scalars = Array.from(text);
  const start = scalars.length <= maxCharacters ? 0
    : Math.max(0, Math.min(focusStart - Math.min(120, Math.floor(maxCharacters / 2)), scalars.length - maxCharacters));
  const end = Math.min(scalars.length, start + maxCharacters);
  return { text: scalars.slice(start, end).join(""), range: { coordinateUnit: "unicode_scalar", start, end,
    totalCharacters: scalars.length, truncatedStart: start > 0, truncatedEnd: end < scalars.length } };
}
