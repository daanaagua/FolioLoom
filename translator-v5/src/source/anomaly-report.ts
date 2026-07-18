import { UnicodeScalarMap } from "./types.js";

export const SOURCE_ANOMALY_CODES = [
  "CONTROL_CHARACTER",
  "EXTREME_LONG_LINE",
  "REPEATED_FRONTMATTER_LINE",
  "REPLACEMENT_CHARACTER",
  "SPACED_HYPHENATION",
] as const;

export type SourceAnomalyCode = typeof SOURCE_ANOMALY_CODES[number];

export interface SourceAnomalySample {
  scalarStart: number;
  scalarEnd: number;
  excerpt: string;
}

export interface SourceAnomalyFinding {
  code: SourceAnomalyCode;
  count: number;
  samples: SourceAnomalySample[];
}

export interface SourceAnomalyReport {
  schema: "v5-source-anomaly-1";
  counts: Record<SourceAnomalyCode, number>;
  findings: SourceAnomalyFinding[];
}

export interface SourceAnomalyOptions {
  maxSamplesPerCode?: number;
  extremeLineScalars?: number;
  frontmatterLines?: number;
}

const DEFAULT_MAX_SAMPLES = 3;
const DEFAULT_EXTREME_LINE_SCALARS = 2_000;
const DEFAULT_FRONTMATTER_LINES = 300;
const MAX_EXCERPT_SCALARS = 180;

function boundedExcerpt(
  scalars: readonly string[],
  start: number,
  end: number,
): string {
  const span = Math.max(1, end - start);
  const context = Math.max(0, Math.floor((MAX_EXCERPT_SCALARS - span) / 2));
  const excerptStart = Math.max(0, start - context);
  const excerptEnd = Math.min(scalars.length, excerptStart + MAX_EXCERPT_SCALARS);
  return scalars.slice(excerptStart, excerptEnd).join("");
}

function frontmatterKey(line: string): string | null {
  const normalized = line.trim().replace(/\s+/gu, " ");
  if (normalized.length < 4 || normalized.length > 120) {
    return null;
  }
  const letters = normalized.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) {
    return null;
  }
  const upperLetters = normalized.match(/\p{Lu}/gu) ?? [];
  const looksLikeHeading = upperLetters.length / letters.length >= 0.8;
  const looksLikePublicationLine = /\b(?:copyright|isbn|publisher|published|edition|author)\b/iu
    .test(normalized);
  return looksLikeHeading || looksLikePublicationLine
    ? normalized.toLocaleLowerCase("und")
    : null;
}

export function analyzeSourceAnomalies(
  sourceText: string,
  options: SourceAnomalyOptions = {},
): SourceAnomalyReport {
  const maxSamples = Math.max(0, Math.floor(
    options.maxSamplesPerCode ?? DEFAULT_MAX_SAMPLES,
  ));
  const extremeLineScalars = Math.max(1, Math.floor(
    options.extremeLineScalars ?? DEFAULT_EXTREME_LINE_SCALARS,
  ));
  const frontmatterLines = Math.max(0, Math.floor(
    options.frontmatterLines ?? DEFAULT_FRONTMATTER_LINES,
  ));
  const scalarMap = new UnicodeScalarMap(sourceText);
  const scalars = Array.from(sourceText);
  const counts: Record<SourceAnomalyCode, number> = {
    CONTROL_CHARACTER: 0,
    EXTREME_LONG_LINE: 0,
    REPEATED_FRONTMATTER_LINE: 0,
    REPLACEMENT_CHARACTER: 0,
    SPACED_HYPHENATION: 0,
  };
  const samples: Record<SourceAnomalyCode, SourceAnomalySample[]> = {
    CONTROL_CHARACTER: [],
    EXTREME_LONG_LINE: [],
    REPEATED_FRONTMATTER_LINE: [],
    REPLACEMENT_CHARACTER: [],
    SPACED_HYPHENATION: [],
  };

  const record = (code: SourceAnomalyCode, start: number, end: number): void => {
    counts[code] += 1;
    if (samples[code].length < maxSamples) {
      samples[code].push({
        scalarStart: start,
        scalarEnd: end,
        excerpt: boundedExcerpt(scalars, start, end),
      });
    }
  };

  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index] as string;
    const codePoint = scalar.codePointAt(0) as number;
    if (scalar === "\uFFFD") {
      record("REPLACEMENT_CHARACTER", index, index + 1);
    }
    if ((codePoint <= 0x1f && scalar !== "\n" && scalar !== "\r" && scalar !== "\t")
      || codePoint === 0x7f) {
      record("CONTROL_CHARACTER", index, index + 1);
    }
  }

  for (const match of sourceText.matchAll(/\p{L}{2,}-[ \t]+\p{L}{2,}/gu)) {
    const utf16Start = match.index;
    const utf16End = utf16Start + match[0].length;
    record(
      "SPACED_HYPHENATION",
      scalarMap.toScalarIndex(utf16Start),
      scalarMap.toScalarIndex(utf16End),
    );
  }

  const lines = sourceText.split(/\n/u);
  const seenFrontmatter = new Map<string, number>();
  let lineScalarStart = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] as string;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineLength = Array.from(line).length;
    if (lineLength > extremeLineScalars) {
      record("EXTREME_LONG_LINE", lineScalarStart, lineScalarStart + lineLength);
    }
    if (lineIndex < frontmatterLines) {
      const key = frontmatterKey(line);
      if (key !== null) {
        if (seenFrontmatter.has(key)) {
          record("REPEATED_FRONTMATTER_LINE", lineScalarStart, lineScalarStart + lineLength);
        } else {
          seenFrontmatter.set(key, lineScalarStart);
        }
      }
    }
    lineScalarStart += Array.from(rawLine).length + (lineIndex < lines.length - 1 ? 1 : 0);
  }

  return {
    schema: "v5-source-anomaly-1",
    counts,
    findings: SOURCE_ANOMALY_CODES
      .filter((code) => counts[code] > 0)
      .map((code) => ({ code, count: counts[code], samples: samples[code] })),
  };
}
