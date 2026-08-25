/**
 * Characters that cannot carry readable prose by themselves. Keep the raw
 * source lossless elsewhere; use this projection only for semantic presence,
 * length, and deterministic alignment checks.
 */
const NONSEMANTIC_CHARACTER = /^[\s\p{Cc}\p{Default_Ignorable_Code_Point}\uFFFD]$/u;
const PRIVATE_USE_CHARACTER = /\p{Private_Use}/u;
const FORMAT_CONTROL_CHARACTER = /\p{Cf}/u;
const LETTER_CHARACTER = /\p{L}/u;
const HAN_CHARACTER = /\p{Script=Han}/u;
const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function isNoncharacter(codePoint: number): boolean {
  return (codePoint >= 0xFDD0 && codePoint <= 0xFDEF)
    || (codePoint & 0xFFFF) === 0xFFFE
    || (codePoint & 0xFFFF) === 0xFFFF;
}

export function hasInvalidUnicodeScalar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const first = text.charCodeAt(index);
    if (first >= 0xD800 && first <= 0xDBFF) {
      const second = text.charCodeAt(index + 1);
      if (!(second >= 0xDC00 && second <= 0xDFFF)) {
        return true;
      }
      const codePoint = text.codePointAt(index) as number;
      if (isNoncharacter(codePoint)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (first >= 0xDC00 && first <= 0xDFFF) {
      return true;
    }
    if (isNoncharacter(first)) {
      return true;
    }
  }
  return PRIVATE_USE_CHARACTER.test(text);
}

/**
 * Reject invisible formatting controls that can reorder, conceal, or smuggle
 * prose in rendered/exported output. ZWNJ and ZWJ are retained because they
 * can be semantically required inside names and emoji sequences; both are
 * already excluded from semantic length accounting.
 */
export function hasProhibitedFormatControl(text: string): boolean {
  for (const character of text) {
    if (FORMAT_CONTROL_CHARACTER.test(character)
      && character !== "\u200C"
      && character !== "\u200D") {
      return true;
    }
  }
  return false;
}

export function compactSemanticText(text: string): string {
  let compact = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (!NONSEMANTIC_CHARACTER.test(character)
      && !isNoncharacter(codePoint)
      && !(codePoint >= 0xD800 && codePoint <= 0xDFFF)
      && !PRIVATE_USE_CHARACTER.test(character)) {
      compact += character;
    }
  }
  return compact;
}

export function hasSemanticText(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (!NONSEMANTIC_CHARACTER.test(character)
      && !isNoncharacter(codePoint)
      && !(codePoint >= 0xD800 && codePoint <= 0xDFFF)
      && !PRIVATE_USE_CHARACTER.test(character)) {
      return true;
    }
  }
  return false;
}

export function semanticCharacterLength(text: string): number {
  return [...graphemeSegmenter.segment(compactSemanticText(text).normalize("NFC"))].length;
}

export function letterGraphemeLength(text: string): number {
  return [...graphemeSegmenter.segment(compactSemanticText(text).normalize("NFC"))]
    .filter((segment) => LETTER_CHARACTER.test(segment.segment))
    .length;
}

export function hanGraphemeLength(text: string): number {
  return [...graphemeSegmenter.segment(compactSemanticText(text).normalize("NFC"))]
    .filter((segment) => HAN_CHARACTER.test(segment.segment))
    .length;
}

export function alignmentFingerprint(text: string): string {
  return compactSemanticText(text)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}
