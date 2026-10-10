import { hasSemanticText } from "./semantic-text.js";

/** Semantic paragraph coordinates in the unchanged original string. */
export function semanticParagraphSpans(text: string) {
  const result: Array<{ ordinal: number; scalarStart: number; scalarEnd: number;
    utf16Start: number; utf16End: number; sourceText: string }> = [];
  let start = 0;
  const append = (end: number) => {
    const raw = text.slice(start, end);
    if (!hasSemanticText(raw)) return;
    const utf16Start = start + (raw.match(/^\s*/u)?.[0].length ?? 0);
    const utf16End = Math.max(utf16Start, end - (raw.match(/\s*$/u)?.[0].length ?? 0));
    const sourceText = text.slice(utf16Start, utf16End);
    if (!hasSemanticText(sourceText)) return;
    result.push({ ordinal: result.length, scalarStart: Array.from(text.slice(0, utf16Start)).length,
      scalarEnd: Array.from(text.slice(0, utf16End)).length, utf16Start, utf16End, sourceText });
  };
  for (const match of text.matchAll(/(?:\r?\n)[\t ]*(?:\r?\n)+|\[\[\]\]/gu)) {
    append(match.index);
    start = match.index + match[0].length;
  }
  append(text.length);
  return result;
}
