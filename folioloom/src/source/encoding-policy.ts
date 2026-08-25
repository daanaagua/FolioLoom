import { TextDecoder } from "node:util";

export const SOURCE_ENCODING_POLICY_VERSION = "source-encoding-policy-2";

export type CanonicalEncodingLabel =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "utf-32le"
  | "utf-32be"
  | "shift_jis"
  | "euc-jp"
  | "euc-kr"
  | "windows-949"
  | "windows-1252";

export type EncodingDecisionSource = "bom" | "strict_utf8" | "heuristic" | "user";

export interface EncodingAlternative {
  canonicalLabel: CanonicalEncodingLabel;
  confidence: number;
  diagnostics: readonly string[];
}

export interface SourceEncodingDecision {
  canonicalLabel: CanonicalEncodingLabel;
  decisionSource: EncodingDecisionSource;
  confidence: number;
  alternatives: readonly EncodingAlternative[];
  diagnostics: readonly string[];
  policyVersion: string;
}

export interface DecodedSourceBytes {
  text: string;
  bomLength: number;
  bomPolicy?: string;
  decision: SourceEncodingDecision;
}

export type EncodingPolicyErrorCode =
  | "SOURCE_ENCODING_AMBIGUOUS"
  | "SOURCE_ENCODING_UNSUPPORTED";

export class EncodingPolicyError extends Error {
  readonly name = "EncodingPolicyError";

  constructor(
    readonly code: EncodingPolicyErrorCode,
    message: string,
    readonly alternatives: readonly EncodingAlternative[] = [],
  ) {
    super(`${code}: ${message}`);
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      alternatives: this.alternatives,
    };
  }
}

interface BomDecision {
  label: CanonicalEncodingLabel;
  length: number;
  policy: string;
}

interface ScriptCounts {
  scalars: number;
  letters: number;
  han: number;
  kana: number;
  halfwidthKana: number;
  hangul: number;
  latin: number;
  cyrillic: number;
  controls: number;
  replacements: number;
  nul: number;
  privateUse: number;
}

const LEGACY_CANDIDATES: readonly CanonicalEncodingLabel[] = [
  "shift_jis",
  "euc-jp",
  "euc-kr",
  "windows-949",
  "windows-1252",
];

const AUTO_ACCEPT_CONFIDENCE = 0.85;
const AUTO_ACCEPT_MARGIN = 0.15;

function roundConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

export function normalizeEncodingLabel(value: string): CanonicalEncodingLabel {
  const normalized = value.trim().toLocaleLowerCase("en")
    .replaceAll("_", "-")
    .replaceAll(" ", "");
  switch (normalized) {
    case "utf8":
    case "utf-8":
      return "utf-8";
    case "utf16le":
    case "utf-16le":
      return "utf-16le";
    case "utf16be":
    case "utf-16be":
      return "utf-16be";
    case "utf32le":
    case "utf-32le":
      return "utf-32le";
    case "utf32be":
    case "utf-32be":
      return "utf-32be";
    case "shift-jis":
    case "shiftjis":
    case "sjis":
    case "windows-31j":
    case "windows31j":
    case "cp932":
      return "shift_jis";
    case "euc-jp":
    case "eucjp":
      return "euc-jp";
    case "euc-kr":
    case "euckr":
    case "ks-c-5601":
    case "ksc5601":
      return "euc-kr";
    case "cp949":
    case "windows-949":
    case "windows949":
    case "uhc":
      return "windows-949";
    case "cp1252":
    case "windows-1252":
    case "windows1252":
    case "latin1":
      return "windows-1252";
    default:
      throw new EncodingPolicyError(
        "SOURCE_ENCODING_UNSUPPORTED",
        `unsupported explicit encoding label: ${value}`,
      );
  }
}

function detectBom(raw: Buffer): BomDecision | undefined {
  const bytes = raw.subarray(0, 4);
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
    return { label: "utf-32be", length: 4, policy: "UTF32_BE_BOM" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return { label: "utf-32le", length: 4, policy: "UTF32_LE_BOM" };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { label: "utf-8", length: 3, policy: "UTF8_BOM" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { label: "utf-16be", length: 2, policy: "UTF16_BE_BOM" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { label: "utf-16le", length: 2, policy: "UTF16_LE_BOM" };
  }
  return undefined;
}

function decodeUtf32(payload: Buffer, littleEndian: boolean): string {
  if (payload.length % 4 !== 0) {
    throw new TypeError("UTF-32 payload is not divisible into scalar words");
  }
  const output: string[] = [];
  for (let offset = 0; offset < payload.length; offset += 4) {
    const scalar = littleEndian
      ? payload.readUInt32LE(offset)
      : payload.readUInt32BE(offset);
    if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      throw new TypeError("UTF-32 payload contains an invalid Unicode scalar");
    }
    output.push(String.fromCodePoint(scalar));
  }
  return output.join("");
}

function strictDecode(payload: Buffer, label: CanonicalEncodingLabel): string {
  if (label === "utf-32le") {
    return decodeUtf32(payload, true);
  }
  if (label === "utf-32be") {
    return decodeUtf32(payload, false);
  }
  return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(payload);
}

function scriptCounts(text: string): ScriptCounts {
  const counts: ScriptCounts = {
    scalars: 0,
    letters: 0,
    han: 0,
    kana: 0,
    halfwidthKana: 0,
    hangul: 0,
    latin: 0,
    cyrillic: 0,
    controls: 0,
    replacements: 0,
    nul: 0,
    privateUse: 0,
  };
  for (const scalar of text) {
    counts.scalars += 1;
    if (/\p{L}/u.test(scalar)) counts.letters += 1;
    if (/\p{Script=Han}/u.test(scalar)) counts.han += 1;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(scalar)) counts.kana += 1;
    if (/[\uFF66-\uFF9D]/u.test(scalar)) counts.halfwidthKana += 1;
    if (/\p{Script=Hangul}/u.test(scalar)) counts.hangul += 1;
    if (/\p{Script=Latin}/u.test(scalar)) counts.latin += 1;
    if (/\p{Script=Cyrillic}/u.test(scalar)) counts.cyrillic += 1;
    if (scalar === "\uFFFD") counts.replacements += 1;
    if (scalar === "\u0000") counts.nul += 1;
    if (/\p{Private_Use}/u.test(scalar)) counts.privateUse += 1;
    const point = scalar.codePointAt(0) as number;
    if ((point < 0x20 && scalar !== "\t" && scalar !== "\n" && scalar !== "\r")
      || (point >= 0x7f && point <= 0x9f)) {
      counts.controls += 1;
    }
  }
  return counts;
}

function decodedTextIsSafe(counts: ScriptCounts): boolean {
  return counts.replacements === 0 && counts.nul === 0 && counts.controls === 0;
}

function decodedTextIsSafeForAutomaticSelection(counts: ScriptCounts): boolean {
  return decodedTextIsSafe(counts) && counts.privateUse === 0;
}

function detectBomlessUtf16(raw: Buffer): {
  label: "utf-16le" | "utf-16be";
  text: string;
  confidence: number;
  diagnostics: readonly string[];
} | undefined {
  if (raw.length < 8 || raw.length % 2 !== 0) {
    return undefined;
  }
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index] === 0) evenNuls += 1;
    if (raw[index + 1] === 0) oddNuls += 1;
  }
  const laneSize = raw.length / 2;
  const dominantNuls = Math.max(evenNuls, oddNuls);
  const minorNuls = Math.min(evenNuls, oddNuls);
  const minimumEvidence = Math.max(2, Math.ceil(laneSize * 0.02));
  if (dominantNuls < minimumEvidence || dominantNuls < Math.max(2, minorNuls * 4)) {
    return undefined;
  }
  const label = oddNuls > evenNuls ? "utf-16le" : "utf-16be";
  try {
    const text = strictDecode(raw, label);
    const counts = scriptCounts(text);
    if (!decodedTextIsSafeForAutomaticSelection(counts)) {
      return undefined;
    }
    const laneRatio = dominantNuls / laneSize;
    return {
      label,
      text,
      confidence: roundConfidence(0.9 + Math.min(0.09, laneRatio * 0.09)),
      diagnostics: Object.freeze([
        "BOM-less UTF-16 byte-lane pattern detected",
        `even_nuls=${evenNuls}`,
        `odd_nuls=${oddNuls}`,
      ]),
    };
  } catch {
    return undefined;
  }
}

function candidateConfidence(
  counts: ScriptCounts,
  languageHint: string | undefined,
): { confidence: number; diagnostics: string[] } {
  const primary = languageHint?.trim().toLocaleLowerCase().split("-", 1)[0];
  const denominator = Math.max(1, counts.letters);
  const controlPenalty = Math.min(0.8, counts.controls / Math.max(1, counts.scalars) * 8);
  const invalidPenalty = counts.replacements > 0 || counts.nul > 0 || counts.privateUse > 0 ? 1 : 0;
  let scriptRatio: number;
  let incompatibleRatio: number;
  if (primary === "ja") {
    scriptRatio = (counts.kana + counts.han * 0.45) / denominator;
    incompatibleRatio = (counts.hangul + counts.cyrillic) / denominator;
  } else if (primary === "ko") {
    scriptRatio = (counts.hangul + counts.han * 0.35) / denominator;
    incompatibleRatio = (counts.kana + counts.cyrillic) / denominator;
  } else if (primary === "de" || primary === "fr" || primary === "es" || primary === "en") {
    scriptRatio = counts.latin / denominator;
    incompatibleRatio = (counts.kana + counts.han + counts.hangul + counts.cyrillic) / denominator;
  } else {
    const dominant = Math.max(counts.kana + counts.han * 0.45, counts.hangul + counts.han * 0.35);
    scriptRatio = dominant / denominator;
    incompatibleRatio = 0;
  }
  const missingPrimaryPenalty = primary === "ko" && counts.hangul === 0
    ? 0.45
    : primary === "ja" && counts.kana === 0
      ? 0.25
      : 0;
  const evidence = Math.min(0.18, Math.log1p(counts.letters) / 24);
  const confidence = roundConfidence(
    0.42 + scriptRatio * 0.5 + evidence
      - incompatibleRatio * 0.65
      - missingPrimaryPenalty
      - controlPenalty
      - invalidPenalty,
  );
  return {
    confidence,
    diagnostics: [
      `letters=${counts.letters}`,
      `han=${counts.han}`,
      `kana=${counts.kana}`,
      `halfwidth_kana=${counts.halfwidthKana}`,
      `hangul=${counts.hangul}`,
      `controls=${counts.controls}`,
      `private_use=${counts.privateUse}`,
    ],
  };
}

interface DecodedCandidate {
  label: CanonicalEncodingLabel;
  text: string;
  alternative: EncodingAlternative;
  automatic: boolean;
}

function bomlessUtf16ConfirmationCandidates(
  raw: Buffer,
  languageHint: string | undefined,
): DecodedCandidate[] {
  if (raw.length < 32 || raw.length % 2 !== 0) return [];
  return (["utf-16le", "utf-16be"] as const).flatMap((label): DecodedCandidate[] => {
    try {
      const text = strictDecode(raw, label);
      const counts = scriptCounts(text);
      if (!decodedTextIsSafeForAutomaticSelection(counts) || counts.letters < 8) return [];
      const scored = candidateConfidence(counts, languageHint);
      if (scored.confidence < 0.7) return [];
      const diagnostics = Object.freeze([
        ...scored.diagnostics,
        "BOM-less UTF-16 content candidate requires user confirmation",
      ]);
      return [{
        label,
        text,
        automatic: false,
        alternative: Object.freeze({
          canonicalLabel: label,
          confidence: scored.confidence,
          diagnostics,
        }),
      }];
    } catch {
      return [];
    }
  });
}

function decision(
  label: CanonicalEncodingLabel,
  source: EncodingDecisionSource,
  confidence: number,
  alternatives: readonly EncodingAlternative[],
  diagnostics: readonly string[],
): SourceEncodingDecision {
  return Object.freeze({
    canonicalLabel: label,
    decisionSource: source,
    confidence: roundConfidence(confidence),
    alternatives: Object.freeze([...alternatives]),
    diagnostics: Object.freeze([...diagnostics]),
    policyVersion: SOURCE_ENCODING_POLICY_VERSION,
  });
}

function explicitDecode(raw: Buffer, label: CanonicalEncodingLabel): DecodedSourceBytes {
  try {
    const text = strictDecode(raw, label);
    const counts = scriptCounts(text);
    if (!decodedTextIsSafe(counts)) {
      throw new TypeError("decoded text contains replacement, NUL, or prohibited control characters");
    }
    return {
      text,
      bomLength: 0,
      decision: decision(label, "user", 1, [], ["explicit encoding selected by user"]),
    };
  } catch (error) {
    throw new EncodingPolicyError(
      "SOURCE_ENCODING_UNSUPPORTED",
      error instanceof Error ? `cannot strictly decode ${label}: ${error.message}` : `cannot strictly decode ${label}`,
    );
  }
}

export function decodeSourceBytes(
  raw: Buffer,
  options: { explicitEncoding?: string; languageHint?: string } = {},
): DecodedSourceBytes {
  const bom = detectBom(raw);
  if (bom !== undefined) {
    try {
      const text = strictDecode(raw.subarray(bom.length), bom.label);
      if (!decodedTextIsSafe(scriptCounts(text))) {
        throw new TypeError("decoded text contains replacement, NUL, or prohibited control characters");
      }
      return {
        text,
        bomLength: bom.length,
        bomPolicy: bom.policy,
        decision: decision(bom.label, "bom", 1, [], [`detected ${bom.policy}`]),
      };
    } catch (error) {
      throw new EncodingPolicyError(
        "SOURCE_ENCODING_UNSUPPORTED",
        error instanceof Error ? `cannot decode ${bom.policy}: ${error.message}` : `cannot decode ${bom.policy}`,
      );
    }
  }

  if (options.explicitEncoding !== undefined) {
    return explicitDecode(raw, normalizeEncodingLabel(options.explicitEncoding));
  }

  const bomlessUtf16 = detectBomlessUtf16(raw);
  if (bomlessUtf16 !== undefined) {
    const alternative: EncodingAlternative = Object.freeze({
      canonicalLabel: bomlessUtf16.label,
      confidence: bomlessUtf16.confidence,
      diagnostics: bomlessUtf16.diagnostics,
    });
    return {
      text: bomlessUtf16.text,
      bomLength: 0,
      decision: decision(
        bomlessUtf16.label,
        "heuristic",
        bomlessUtf16.confidence,
        [alternative],
        bomlessUtf16.diagnostics,
      ),
    };
  }

  try {
    const text = strictDecode(raw, "utf-8");
    if (!decodedTextIsSafe(scriptCounts(text))) {
      throw new EncodingPolicyError(
        "SOURCE_ENCODING_UNSUPPORTED",
        "strict UTF-8 text contains NUL or prohibited control characters",
      );
    }
    return {
      text,
      bomLength: 0,
      decision: decision("utf-8", "strict_utf8", 1, [], ["strict UTF-8 decoding succeeded"]),
    };
  } catch (error) {
    if (error instanceof EncodingPolicyError) {
      throw error;
    }
    // Only legacy encodings are considered after strict UTF-8 fails.
  }

  const legacyDecoded = LEGACY_CANDIDATES.flatMap((label): DecodedCandidate[] => {
    try {
      const text = strictDecode(raw, label);
      const counts = scriptCounts(text);
      if (!decodedTextIsSafe(counts)) {
        return [];
      }
      const scored = candidateConfidence(counts, options.languageHint);
      return [{
        label,
        text,
        automatic: decodedTextIsSafeForAutomaticSelection(counts)
          && counts.letters >= 8
          && !(counts.kana > 0
            && counts.halfwidthKana / counts.kana >= 0.8
            && counts.han === 0),
        alternative: Object.freeze({
          canonicalLabel: label,
          confidence: scored.confidence,
          diagnostics: Object.freeze(scored.diagnostics),
        }),
      }];
    } catch {
      return [];
    }
  });
  const decoded = [
    ...legacyDecoded,
    ...bomlessUtf16ConfirmationCandidates(raw, options.languageHint),
  ].sort((left, right) => right.alternative.confidence - left.alternative.confidence
    || left.label.localeCompare(right.label));

  if (decoded.length === 0) {
    throw new EncodingPolicyError(
      "SOURCE_ENCODING_UNSUPPORTED",
      "source bytes are neither strict UTF-8 nor a supported East Asian legacy encoding",
    );
  }
  const plausible = decoded.filter((item) => item.alternative.confidence >= 0.45);
  const alternatives = (plausible.length > 0 ? plausible : decoded)
    .map((item) => item.alternative);
  const best = decoded[0] as typeof decoded[number];
  const second = decoded[1];
  const margin = best.alternative.confidence - (second?.alternative.confidence ?? 0);
  if (best.alternative.confidence >= AUTO_ACCEPT_CONFIDENCE
    && best.automatic
    && (second === undefined || margin >= AUTO_ACCEPT_MARGIN)) {
    return {
      text: best.text,
      bomLength: 0,
      decision: decision(
        best.label,
        "heuristic",
        best.alternative.confidence,
        alternatives,
        best.alternative.diagnostics,
      ),
    };
  }
  throw new EncodingPolicyError(
    "SOURCE_ENCODING_AMBIGUOUS",
    "multiple source encodings remain plausible; user confirmation is required",
    alternatives,
  );
}
