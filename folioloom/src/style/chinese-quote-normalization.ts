export interface ChineseQuoteNormalizationState {
  openDoubleQuoteDepth: number;
}

export interface ChineseQuoteTextNormalization {
  text: string;
  state: ChineseQuoteNormalizationState;
}

export interface ChineseQuoteTextsNormalization {
  texts: string[];
  state: ChineseQuoteNormalizationState;
}

const OPENING_DOUBLE_QUOTE_GLYPHS = new Set([
  "“",
  "‛",
  "‟",
  "〝",
  "„",
  "「",
  "『",
]);

const CLOSING_DOUBLE_QUOTE_GLYPHS = new Set([
  "”",
  "〞",
  "」",
  "』",
]);

const OPENING_CONTEXT_GLYPHS = new Set([
  "(", "（", "[", "［", "{", "｛", "〈", "《", "「", "『", "【", "〔",
  ":", "：", ";", "；", ",", "，", "、", "—", "–", "-",
]);

function normalizedState(state: ChineseQuoteNormalizationState | undefined): ChineseQuoteNormalizationState {
  return {
    openDoubleQuoteDepth: Math.max(0, Math.trunc(state?.openDoubleQuoteDepth ?? 0)),
  };
}

function isOpeningAsciiQuote(
  previousSignificant: string | undefined,
  atLineStart: boolean,
  openDoubleQuoteDepth: number,
): boolean {
  if (openDoubleQuoteDepth > 0 && (atLineStart || previousSignificant === undefined)) {
    return false;
  }
  if (atLineStart || previousSignificant === undefined) {
    return true;
  }
  if (openDoubleQuoteDepth > 0) {
    return previousSignificant === ":" || previousSignificant === "：";
  }
  return OPENING_CONTEXT_GLYPHS.has(previousSignificant);
}

/**
 * Rewrites every validator-forbidden double-quote glyph one-for-one into the
 * Chinese curly quotation system. ASCII quotes are resolved with a small
 * state machine rather than a pairing regex, so unmatched closing marks stay
 * closing marks and remain visible to quote_boundary_mismatch validation.
 */
export function normalizeChineseQuoteText(
  text: string,
  initialState?: ChineseQuoteNormalizationState,
): ChineseQuoteTextNormalization {
  let { openDoubleQuoteDepth } = normalizedState(initialState);
  let previousSignificant: string | undefined;
  let atLineStart = true;
  const result: string[] = [];

  for (const glyph of Array.from(text)) {
    let normalizedGlyph = glyph;
    if (glyph === "\"") {
      const opening = isOpeningAsciiQuote(
        previousSignificant,
        atLineStart,
        openDoubleQuoteDepth,
      );
      normalizedGlyph = opening ? "“" : "”";
      openDoubleQuoteDepth += opening ? 1 : openDoubleQuoteDepth > 0 ? -1 : 0;
    } else if (OPENING_DOUBLE_QUOTE_GLYPHS.has(glyph)) {
      normalizedGlyph = "“";
      openDoubleQuoteDepth += 1;
    } else if (CLOSING_DOUBLE_QUOTE_GLYPHS.has(glyph)) {
      normalizedGlyph = "”";
      openDoubleQuoteDepth = Math.max(0, openDoubleQuoteDepth - 1);
    }
    result.push(normalizedGlyph);

    if (glyph === "\r" || glyph === "\n") {
      atLineStart = true;
      continue;
    }
    if (!/\s/u.test(glyph)) {
      atLineStart = false;
      previousSignificant = normalizedGlyph;
    }
  }

  return {
    text: result.join(""),
    state: { openDoubleQuoteDepth },
  };
}

/** Applies quote normalization in order without changing text block boundaries. */
export function normalizeChineseQuoteTexts(
  texts: readonly string[],
  initialState?: ChineseQuoteNormalizationState,
): ChineseQuoteTextsNormalization {
  let state = normalizedState(initialState);
  const normalizedTexts: string[] = [];
  for (const text of texts) {
    const normalized = normalizeChineseQuoteText(text, state);
    normalizedTexts.push(normalized.text);
    state = normalized.state;
  }
  return { texts: normalizedTexts, state };
}

function closingBoundaryExcessInNormalizedTexts(texts: readonly string[]): number {
  let depth = 0;
  let excess = 0;
  for (const text of texts) {
    for (const glyph of Array.from(text)) {
      if (glyph === "“") {
        depth += 1;
      } else if (glyph === "”") {
        if (depth > 0) depth -= 1;
        else excess += 1;
      }
    }
  }
  return excess;
}

/** Counts closing quote boundaries inherited from source text outside this slice. */
export function doubleQuoteClosingBoundaryExcess(texts: readonly string[]): number {
  return closingBoundaryExcessInNormalizedTexts(normalizeChineseQuoteTexts(texts).texts);
}

/** Maps source-authorized inherited closing boundaries to their exact text slice. */
export function doubleQuoteClosingBoundaryExcessByText(
  texts: readonly string[],
): number[] {
  let state = normalizedState(undefined);
  return texts.map((text) => {
    const normalized = normalizeChineseQuoteText(text, state);
    state = normalized.state;
    return closingBoundaryExcessInNormalizedTexts([normalized.text]);
  });
}

/**
 * Normalizes target quote glyphs and removes only unmatched closing marks that
 * have no corresponding boundary in the source slice. Balanced quotes and
 * source-authorized cross-slice closing boundaries are preserved verbatim.
 */
export function normalizeChineseQuoteTextsAgainstSource(
  targetTexts: readonly string[],
  sourceTexts: readonly string[],
): ChineseQuoteTextsNormalization {
  const normalized = normalizeChineseQuoteTexts(targetTexts);
  const allowedClosingsByText = doubleQuoteClosingBoundaryExcessByText(sourceTexts);
  const texts = normalized.texts.map((text, index) => {
    let remainingAllowedClosings = allowedClosingsByText[index] ?? 0;
    let openDoubleQuoteDepth = 0;
    const result: string[] = [];
    for (const glyph of Array.from(text)) {
      if (glyph === "“") {
        openDoubleQuoteDepth += 1;
        result.push(glyph);
        continue;
      }
      if (glyph === "”") {
        if (openDoubleQuoteDepth > 0) {
          openDoubleQuoteDepth -= 1;
          result.push(glyph);
        } else if (remainingAllowedClosings > 0) {
          remainingAllowedClosings -= 1;
          result.push(glyph);
        }
        continue;
      }
      result.push(glyph);
    }
    return result.join("");
  });
  return { texts, state: normalizeChineseQuoteTexts(texts).state };
}
