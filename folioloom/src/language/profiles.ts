import type {
  AnchorCandidateInput,
  BoundaryCandidate,
  ProfileAnchorCandidate,
  ResidueDetectionOptions,
  ResidueFinding,
  ScriptStats,
  SourceLanguageProfile,
  SourceScript,
  SourceToken,
  StructureHeading,
} from "./types.js";

const PROFILE_VERSION = "source-language-profile-5";
const DEFAULT_CANDIDATE_LIMIT = 24;
const DEFAULT_TRANSLATION_LENGTH_RATIO_BANDS = Object.freeze([
  Object.freeze({ minSourceCharacters: 1, min: 0.08, max: 10 }),
  Object.freeze({ minSourceCharacters: 24, min: 0.08, max: 5 }),
  Object.freeze({ minSourceCharacters: 80, min: 0.08, max: 3 }),
  Object.freeze({ minSourceCharacters: 400, min: 0.18, max: 1.5 }),
]);

interface ProfileDefinition {
  id: string;
  displayName: string;
  locale: string;
  volumePatterns: readonly RegExp[];
  chapterPatterns: readonly RegExp[];
  stopWords: readonly string[];
  script: SourceScript;
  leadingContractions?: readonly string[];
  aliasCuePatterns?: readonly RegExp[];
  namingCuePatterns?: readonly RegExp[];
  translationLengthRatioBands?: readonly {
    min: number;
    max: number;
    minSourceCharacters: number;
  }[];
}

const DEFINITIONS: readonly ProfileDefinition[] = [
  {
    id: "en",
    displayName: "English",
    locale: "en",
    volumePatterns: [/^BOOK(?:\s+(?:\d+|[IVXLCDM]+|[A-Z]+))?$/iu],
    chapterPatterns: [
      /^CHAPTER(?:\s+(?:\d+|[IVXLCDM]+|[A-Z]+))?$/iu,
      /^[IVXLCDM]+$/u,
    ],
    stopWords: [
      "a", "after", "all", "an", "and", "another", "any", "as", "at",
      "before", "book", "but", "by", "chapter", "for", "from", "he", "her",
      "his", "i", "in", "is", "it", "its", "my", "of", "on", "or", "our",
      "she", "that", "the", "their", "they", "this", "to", "we", "with",
      "you", "your",
    ],
    script: "latin",
    aliasCuePatterns: [
      /\b(?:also known as|known as|alias|a\.?k\.?a\.?|(?:was|is|were|are|be|been|being)\s+called|whom\s+(?:they\s+)?called)\b/iu,
    ],
  },
  {
    id: "fr",
    displayName: "French",
    locale: "fr",
    volumePatterns: [/^LIVRE(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
    chapterPatterns: [
      /^CHAPITRE(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu,
      /^(?:PREMIER|PREMIÈRE|DEUXIÈME|TROISIÈME|QUATRIÈME|CINQUIÈME)\s+CHAPITRE$/iu,
      /^[IVXLCDM]+\.?$/iu,
    ],
    stopWords: [
      "au", "aux", "avec", "ce", "ces", "chapitre", "dans", "de", "des",
      "du", "elle", "en", "et", "il", "la", "le", "les", "livre", "mais",
      "ou", "par", "pour", "que", "qui", "sur", "un", "une",
    ],
    script: "latin",
    leadingContractions: ["c", "d", "j", "l", "m", "n", "qu", "s", "t"],
    aliasCuePatterns: [
      /\b(?:aussi connu(?:e)? sous le nom de|connu(?:e)? comme|appel[ée]|surnomm[ée])\b/iu,
    ],
  },
  {
    id: "de",
    displayName: "German",
    locale: "de",
    volumePatterns: [/^(?:BUCH|BAND)(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
    chapterPatterns: [
      /^KAPITEL(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu,
      /^(?:\d+|[IVXLCDM]+)\.\s*KAPITEL$/iu,
      /^(?:ERSTES|ZWEITES|DRITTES|VIERTES|FÜNFTES|SECHSTES|SIEBTES|ACHTES|NEUNTES|ZEHNTES)\s+KAPITEL$/iu,
      /^[IVXLCDM]+\.?$/iu,
    ],
    stopWords: ["aber", "das", "der", "die", "ein", "eine", "er", "es", "im", "in", "mit", "sie", "und", "von", "zu"],
    script: "latin",
    aliasCuePatterns: [/\b(?:auch bekannt als|bekannt als|genannt)\b/iu],
  },
  {
    id: "es",
    displayName: "Spanish",
    locale: "es",
    volumePatterns: [/^LIBRO(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
    chapterPatterns: [
      /^CAP[IÍ]TULO(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu,
      /^(?:PRIMER|PRIMERO|SEGUNDO|TERCER|TERCERO|CUARTO|QUINTO)\s+CAP[IÍ]TULO$/iu,
      /^[IVXLCDM]+\.?$/iu,
    ],
    stopWords: ["a", "con", "de", "del", "el", "ella", "en", "la", "las", "los", "pero", "por", "que", "se", "un", "una", "y"],
    script: "latin",
    aliasCuePatterns: [
      /\b(?:tambi[ée]n conocid[oa] como|conocid[oa] como|llamad[oa])\b/iu,
    ],
  },
  {
    id: "ru",
    displayName: "Russian",
    locale: "ru",
    volumePatterns: [/^(?:КНИГА|ТОМ)(?:\s+[\p{L}\p{N}-]+)?$/iu],
    chapterPatterns: [/^ГЛАВА(?:\s+[\p{L}\p{N}-]+)?$/iu],
    stopWords: ["а", "в", "и", "из", "к", "на", "но", "он", "она", "с", "что"],
    script: "cyrillic",
    aliasCuePatterns: [/(?:также известн|известн.+ как|по прозвищу)/iu],
  },
  {
    id: "ja",
    displayName: "Japanese",
    locale: "ja",
    volumePatterns: [
      /^\u7b2c[^\r\n]{1,20}\u5dfb$/u,
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{N}\u30fc]{2,24}\u306e\u5dfb$/u,
    ],
    chapterPatterns: [
      /^\u7b2c[^\r\n]{1,20}\u7ae0$/u,
      /^\u7b2c[^\r\n]{1,20}\u8a71$/u,
      /^(?:[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u3007\u96f6]+|\d{1,4})$/u,
      /^(?:\u5e8f\u7ae0|\u7d42\u7ae0|\u30d7\u30ed\u30ed\u30fc\u30b0|\u30a8\u30d4\u30ed\u30fc\u30b0)$/u,
    ],
    stopWords: [
      "\u3053\u308c", "\u305d\u308c", "\u3042\u308c", "\u3053\u3068", "\u3082\u306e", "\u305f\u3081", "\u3055\u3089\u306b",
      "\u3059\u308b", "\u3057\u305f", "\u3057\u3066", "\u3042\u308b", "\u3042\u3063\u305f", "\u3067\u3059", "\u307e\u3059",
    ],
    script: "kana",
    translationLengthRatioBands: [
      { minSourceCharacters: 1, min: 0.08, max: 6 },
      { minSourceCharacters: 24, min: 0.08, max: 3 },
      { minSourceCharacters: 80, min: 0.25, max: 2 },
      { minSourceCharacters: 400, min: 0.6, max: 1.25 },
    ],
    aliasCuePatterns: [/(?:\u5225\u540d|\u3068\u3057\u3066\u77e5\u3089)/u],
    namingCuePatterns: [/(?:\u6c0f|\u69d8|\u6bbf|\u3055\u3093)\b/u],
  },
  {
    id: "ko",
    displayName: "Korean",
    locale: "ko",
    volumePatterns: [
      /^\uc81c\s*(?:\d+|[\p{Script=Hangul}\p{Script=Han}\p{N}]+)\s*\uad8c$/u,
      /^(?:\uc81c\s*)?\d+\s*\ubd80$/u,
    ],
    chapterPatterns: [
      /^(?:\uc81c\s*)?(?:\d+|[\p{Script=Hangul}\p{Script=Han}\p{N}]+)\s*(?:\uc7a5|\ud654|\ud68c)$/u,
      /^(?:\uc11c\uc7a5|\uc885\uc7a5|\ud504\ub864\ub85c\uadf8|\uc5d0\ud544\ub85c\uadf8)$/u,
      /^(?:\[|\u3010)\s*[\p{L}\p{N}\s-]{1,32}\s*(?:\]|\u3011)$/u,
      /^[\u25a0\u25c6\u25cf\u25b6\u25c7]\s*[\p{L}\p{N}\s:：\u00b7'\u2019"\u201c\u201d!?！？,，\u2014\u2013-]{1,48}\s*[\u25a1\u25a0\u25c6\u25cf\u25c0\u25c7]$/u,
    ],
    stopWords: [
      "\uadf8\ub7ec\ub098", "\uadf8\ub9ac\uace0", "\uadf8\ub7f0", "\uc774\ub7f0", "\uac83\uc740", "\uac83\uc774", "\uc5c6\uc5c8\ub2e4",
      "\uc788\uc5c8\ub2e4", "\ud588\ub2e4", "\ub418\uc5c8\ub2e4", "\ud558\uc5c8\ub2e4", "\ud558\ub294", "\uc774\ub2e4",
      "이것", "그것", "저것", "이유", "벌써", "결국", "예전", "일종", "정식", "의견",
    ],
    script: "hangul",
    translationLengthRatioBands: [
      { minSourceCharacters: 1, min: 0.08, max: 6 },
      { minSourceCharacters: 24, min: 0.08, max: 3 },
      { minSourceCharacters: 80, min: 0.25, max: 2 },
      { minSourceCharacters: 400, min: 0.6, max: 1.25 },
    ],
    aliasCuePatterns: [/(?:\ubcc4\uba85|(?:\ub77c\uace0|\uc73c\ub85c|\ub85c)\s*\ubd88(?:\ub9ac|\ub838)|\ub77c\uace0\s*\ud55c\ub2e4)/u],
    namingCuePatterns: [/(?:\uc528|\ub2d8|\uc7a5\uad70|\ub300\uac10)/u],
  },
  {
    id: "und",
    displayName: "Undetermined",
    locale: "und",
    volumePatterns: [],
    chapterPatterns: [],
    stopWords: [],
    script: "unknown",
    aliasCuePatterns: [/\b(?:alias|a\.?k\.?a\.?)\b/iu],
  },
];

function normalizeApostrophes(value: string): string {
  return value.replace(/[’‘`]/gu, "'");
}

function normalizeLiteral(value: string, definition: ProfileDefinition): string {
  return normalizeApostrophes(value.normalize("NFKC"))
    .toLocaleLowerCase(definition.locale);
}

function normalizeForm(value: string, definition: ProfileDefinition): string {
  let normalized = normalizeLiteral(value, definition).trim();
  if (definition.id === "en") {
    normalized = normalized.replace(/'s$/u, "");
  }
  if (definition.leadingContractions !== undefined) {
    const contraction = new RegExp(
      `^(?:${definition.leadingContractions.join("|")})['’]`,
      "iu",
    );
    normalized = normalized.replace(contraction, "");
  }
  return normalized;
}

function segmentText(text: string, definition: ProfileDefinition): SourceToken[] {
  const segmenter = new Intl.Segmenter(definition.locale, { granularity: "word" });
  return [...segmenter.segment(text)].map((part) => ({
    value: part.segment,
    normalized: normalizeForm(part.segment, definition),
    start: part.index,
    end: part.index + part.segment.length,
    isWordLike: part.isWordLike ?? false,
  }));
}

function scriptsFor(definition: ProfileDefinition): readonly SourceScript[] {
  switch (definition.script) {
    case "kana":
      return ["han", "kana"];
    case "hangul":
      return ["han", "hangul"];
    case "latin":
      return ["latin"];
    case "cyrillic":
      return ["cyrillic"];
    case "han":
      return ["han"];
    default:
      return ["unknown"];
  }
}

function scriptStats(text: string): ScriptStats {
  const stats: ScriptStats = {
    scalars: 0,
    latin: 0,
    han: 0,
    kana: 0,
    hangul: 0,
    other: 0,
  };
  for (const scalar of text) {
    stats.scalars += 1;
    if (/\p{Script=Latin}/u.test(scalar)) {
      stats.latin += 1;
    } else if (/\p{Script=Han}/u.test(scalar)) {
      stats.han += 1;
    } else if (/[\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/u.test(scalar)) {
      stats.kana += 1;
    } else if (/\p{Script=Hangul}/u.test(scalar)) {
      stats.hangul += 1;
    } else {
      stats.other += 1;
    }
  }
  return stats;
}

function structureHeading(
  line: string,
  definition: ProfileDefinition,
): StructureHeading | null {
  const title = line.trim();
  if (definition.volumePatterns.some((pattern) => pattern.test(title))) {
    return { kind: "volume_heading", title, boundaryWeight: 100 };
  }
  if (definition.chapterPatterns.some((pattern) => pattern.test(title))) {
    return { kind: "chapter_heading", title, boundaryWeight: 80 };
  }
  return null;
}

const CLOSING_PUNCTUATION = new Set([
  "\"", "'", "\u201d", "\u2019", "\u300d", "\u300f", "\uff09", "\u3011", "\u3015",
]);

interface Utf16BoundaryCandidate {
  utf16Offset: number;
  weight: number;
  kind: BoundaryCandidate["kind"];
}

function appendUtf16BoundariesAsScalars(
  scalars: readonly string[],
  boundaries: readonly Utf16BoundaryCandidate[],
  candidates: BoundaryCandidate[],
): void {
  const ordered = [...boundaries].sort((left, right) => (
    left.utf16Offset - right.utf16Offset
    || right.weight - left.weight
    || left.kind.localeCompare(right.kind)
  ));
  let boundaryIndex = 0;
  let utf16Offset = 0;
  while ((ordered[boundaryIndex]?.utf16Offset ?? Number.POSITIVE_INFINITY) <= 0) {
    const boundary = ordered[boundaryIndex] as Utf16BoundaryCandidate;
    candidates.push({
      scalarOffset: 0,
      weight: boundary.weight,
      kind: boundary.kind,
    });
    boundaryIndex += 1;
  }
  for (let scalarIndex = 0; scalarIndex < scalars.length; scalarIndex += 1) {
    const scalar = scalars[scalarIndex] as string;
    const nextUtf16Offset = utf16Offset + scalar.length;
    while ((ordered[boundaryIndex]?.utf16Offset ?? Number.POSITIVE_INFINITY)
      <= nextUtf16Offset) {
      const boundary = ordered[boundaryIndex] as Utf16BoundaryCandidate;
      candidates.push({
        scalarOffset: boundary.utf16Offset <= utf16Offset
          ? scalarIndex
          : scalarIndex + 1,
        weight: boundary.weight,
        kind: boundary.kind,
      });
      boundaryIndex += 1;
    }
    utf16Offset = nextUtf16Offset;
  }
}

function cjkBoundaryCandidates(
  text: string,
  definition: ProfileDefinition,
): BoundaryCandidate[] {
  const candidates: BoundaryCandidate[] = [];
  const utf16Boundaries: Utf16BoundaryCandidate[] = [];
  for (const match of text.matchAll(/(?:\r\n|\r|\n)[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)+/gu)) {
    if (match.index !== undefined) {
      utf16Boundaries.push({
        utf16Offset: match.index + match[0].length,
        weight: 70,
        kind: "paragraph",
      });
    }
  }

  const scalars = [...text];
  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index] as string;
    const cjkTerminal = scalar === "\u3002" || scalar === "\uff01" || scalar === "\uff1f";
    if (!cjkTerminal && scalar !== "." && scalar !== "!" && scalar !== "?") {
      continue;
    }
    let end = index + 1;
    while (end < scalars.length && CLOSING_PUNCTUATION.has(scalars[end] as string)) {
      end += 1;
    }
    const next = scalars[end];
    if (!cjkTerminal && next !== undefined && !/\s/u.test(next)) {
      continue;
    }
    candidates.push({ scalarOffset: end, weight: 50, kind: "sentence" });
    index = end - 1;
  }

  for (const match of text.matchAll(/^.*$/gmu)) {
    if (match.index === undefined || match[0].length === 0) {
      continue;
    }
    const heading = structureHeading(match[0], definition);
    if (heading !== null) {
      utf16Boundaries.push({
        utf16Offset: match.index,
        weight: heading.boundaryWeight,
        kind: "heading",
      });
    }
  }
  appendUtf16BoundariesAsScalars(scalars, utf16Boundaries, candidates);

  const strongestByOffset = new Map<number, BoundaryCandidate>();
  for (const candidate of candidates) {
    const previous = strongestByOffset.get(candidate.scalarOffset);
    if (previous === undefined || candidate.weight > previous.weight) {
      strongestByOffset.set(candidate.scalarOffset, candidate);
    }
  }
  return [...strongestByOffset.values()].sort((left, right) => (
    left.scalarOffset - right.scalarOffset
    || right.weight - left.weight
    || left.kind.localeCompare(right.kind)
  ));
}

function compactContext(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const left = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("?"),
    before.lastIndexOf("!"),
    before.lastIndexOf("。"),
    before.lastIndexOf("？"),
    before.lastIndexOf("！"),
    before.lastIndexOf("\n"),
  );
  const after = text.slice(offset);
  const candidates = [".", "?", "!", "。", "？", "！", "\n"]
    .map((mark) => after.indexOf(mark))
    .filter((index) => index >= 0);
  const right = candidates.length === 0
    ? text.length
    : offset + Math.min(...candidates) + 1;
  return text.slice(left + 1, right).replace(/\s+/gu, " ").trim().slice(0, 360);
}

function cjkCandidateToken(token: SourceToken, definition: ProfileDefinition): boolean {
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]+$/u.test(token.value)) {
    return false;
  }
  if (definition.script === "kana") {
    return /[\p{Script=Han}\p{Script=Katakana}]/u.test(token.value);
  }
  return /\p{Script=Hangul}/u.test(token.value);
}

function directHanGloss(text: string, token: SourceToken): string | undefined {
  const match = /^\s*[（(]\s*([\p{Script=Han}〇々〆]{1,24})\s*[）)]/u.exec(
    text.slice(token.end, token.end + 40),
  );
  return match?.[1]?.normalize("NFKC");
}

function hasLocalNamingCue(
  text: string,
  token: SourceToken,
  definition: ProfileDefinition,
  sourceForm: string,
): boolean {
  const before = text.slice(Math.max(0, token.start - 16), token.start);
  const after = text.slice(token.end, token.end + 16);
  if (definition.id === "ko") {
    const syllables = hangulSyllableCount(sourceForm);
    const genericTitleOrRole = /^(?:문파|문주|장로|당주|총관|호법|교주|위사|수하|수하들)$/u
      .test(sourceForm);
    const nonNominalEnding = /(?:자|아|어|들|지)$/u.test(sourceForm);
    if (syllables < 2 || syllables > 4 || genericTitleOrRole || nonNominalEnding) {
      return false;
    }
    const afterGloss = after.replace(/^\s*[（(]\s*[\p{Script=Han}〇々〆]{1,24}\s*[）)]\s*/u, "");
    const title = "(?:씨|님|(?:장군|대감|[좌우외내부대소]{0,2}(?:장로|당주|문주|총관|호법|교주)|공자|소저|부인|대협|선생)(?:님)?)";
    const boundary = `(?=$|[\\s,，.。!?！？…"“”'’()（）]|은|는|이|가|을|를|도|만|께|의|와|과|로|에|에게|으로)`;
    return new RegExp(`^\\s*${title}${boundary}`, "u").test(afterGloss)
      || new RegExp(`${title}\\s*$`, "u").test(before);
  }
  if (definition.id === "ja") {
    return /^\s*(?:氏|様|殿|さん|君|ちゃん|先生|将軍|長老)/u.test(after);
  }
  return false;
}

function isCandidateToken(token: SourceToken, definition: ProfileDefinition): boolean {
  if (!token.isWordLike || token.normalized.length < 2) {
    return false;
  }
  if (definition.stopWords.includes(token.normalized)) {
    return false;
  }
  if (definition.script === "latin") {
    return /^\p{Lu}[\p{L}\p{M}\p{N}'’.-]{1,}$/u.test(token.value);
  }
  if (definition.script === "cyrillic") {
    return /^\p{Lu}[\p{Script=Cyrillic}\p{M}-]{1,}$/u.test(token.value);
  }
  if (definition.script === "kana" || definition.script === "hangul") {
    return cjkCandidateToken(token, definition);
  }
  return false;
}

interface CandidateTokenForm {
  sourceForm: string;
  normalizedSource: string;
  morphologyMarker: string;
}

const KOREAN_CASE_MARKERS = [
  "으로부터", "에게서", "한테서", "이라는", "이라고", "에서", "에게", "한테",
  "으로", "까지", "부터", "처럼", "보다", "이나", "라며", "라고",
  "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "로", "도", "만", "든",
] as const;

function hangulSyllableCount(value: string): number {
  return [...value].filter((scalar) => /\p{Script=Hangul}/u.test(scalar)).length;
}

/**
 * Intl.Segmenter deliberately returns Korean eojeol rather than morphemes.
 * Normalize productive case/topic markers so repeated names and terms share
 * one statistical key. A one-syllable remainder is rejected: at that point a
 * particle and a verbal/adnominal ending cannot be distinguished safely.
 */
function koreanCandidateForm(value: string): Omit<CandidateTokenForm, "normalizedSource"> | null {
  if (/다$/u.test(value) || /^(?:되어|돼|하여|해|있어|없어)$/u.test(value)) {
    return null;
  }
  for (const marker of KOREAN_CASE_MARKERS) {
    if (!value.endsWith(marker)) {
      continue;
    }
    const base = value.slice(0, -marker.length);
    if (hangulSyllableCount(base) < 2) {
      return null;
    }
    return { sourceForm: base, morphologyMarker: marker };
  }
  return { sourceForm: value, morphologyMarker: "" };
}

function candidateTokenForm(
  token: SourceToken,
  definition: ProfileDefinition,
): CandidateTokenForm | null {
  if (!isCandidateToken(token, definition)) {
    return null;
  }
  const transformed = definition.id === "ko"
    ? koreanCandidateForm(token.value)
    : { sourceForm: token.value.replace(/[’']s$/u, ""), morphologyMarker: "" };
  if (transformed === null) {
    return null;
  }
  const normalizedSource = normalizeForm(transformed.sourceForm, definition);
  if (normalizedSource.length < 2 || definition.stopWords.includes(normalizedSource)) {
    return null;
  }
  return { ...transformed, normalizedSource };
}

function collectCandidates(
  input: AnchorCandidateInput,
  definition: ProfileDefinition,
): ProfileAnchorCandidate[] {
  const requestedLimit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
    throw new TypeError("candidate limit must be a non-negative safe integer");
  }
  const limit = Math.min(requestedLimit, DEFAULT_CANDIDATE_LIMIT);
  const established = new Set((input.establishedSourceForms ?? []).map((form) => {
    const token: SourceToken = {
      value: form,
      normalized: normalizeForm(form, definition),
      start: 0,
      end: form.length,
      isWordLike: true,
    };
    return candidateTokenForm(token, definition)?.normalizedSource ?? token.normalized;
  }));
  const current = new Map<string, {
    sourceForm: string;
    count: number;
    morphologyMarkers: Set<string>;
  }>();
  for (const text of input.targetTexts) {
    for (const token of segmentText(text, definition)) {
      const candidate = candidateTokenForm(token, definition);
      if (candidate === null || established.has(candidate.normalizedSource)) {
        continue;
      }
      const record = current.get(candidate.normalizedSource) ?? {
        sourceForm: candidate.sourceForm,
        count: 0,
        morphologyMarkers: new Set<string>(),
      };
      record.count += 1;
      record.morphologyMarkers.add(candidate.morphologyMarker);
      current.set(candidate.normalizedSource, record);
    }
  }

  const corpus = new Map<string, {
    count: number;
    candidateCaseCount: number;
    contexts: Set<string>;
    documentIndexes: Set<number>;
    morphologyMarkers: Set<string>;
    directTermCueCount: number;
    directTargets: Map<string, number>;
    namingCueCount: number;
  }>();
  for (const [documentIndex, text] of input.corpusTexts.entries()) {
    for (const token of segmentText(text, definition)) {
      const candidate = candidateTokenForm(token, definition);
      const normalizedSource = candidate?.normalizedSource
        ?? (definition.id === "ko" ? "" : token.normalized);
      if (!current.has(normalizedSource)) {
        continue;
      }
      const record = corpus.get(normalizedSource) ?? {
        count: 0,
        candidateCaseCount: 0,
        contexts: new Set<string>(),
        documentIndexes: new Set<number>(),
        morphologyMarkers: new Set<string>(),
        directTermCueCount: 0,
        directTargets: new Map<string, number>(),
        namingCueCount: 0,
      };
      record.count += 1;
      record.documentIndexes.add(documentIndex);
      if (candidate !== null) {
        record.candidateCaseCount += 1;
        record.morphologyMarkers.add(candidate.morphologyMarker);
      }
      const sourceAuthoredTarget = directHanGloss(text, token);
      if (sourceAuthoredTarget !== undefined) {
        record.directTermCueCount += 1;
        record.directTargets.set(
          sourceAuthoredTarget,
          (record.directTargets.get(sourceAuthoredTarget) ?? 0) + 1,
        );
      }
      if (candidate !== null && hasLocalNamingCue(text, token, definition, candidate.sourceForm)) {
        record.namingCueCount += 1;
      }
      if (record.contexts.size < 3) {
        const context = compactContext(text, token.start);
        if (context.length > 0) {
          record.contexts.add(context);
        }
      }
      corpus.set(normalizedSource, record);
    }
  }

  const ranked = [...current.entries()].flatMap(([normalizedSource, wave]) => {
    const evidence = corpus.get(normalizedSource) ?? {
      count: wave.count,
      candidateCaseCount: wave.count,
      contexts: new Set<string>(),
      documentIndexes: new Set<number>(),
      morphologyMarkers: wave.morphologyMarkers,
      directTermCueCount: 0,
      directTargets: new Map<string, number>(),
      namingCueCount: 0,
    };
    const contexts = [...evidence.contexts];
    const hasAliasCue = contexts.some((context) =>
      definition.aliasCuePatterns?.some((pattern) => pattern.test(context)) ?? false);
    const hasNamingCue = evidence.namingCueCount > 0 || (definition.id !== "ko"
      && contexts.some((context) =>
        definition.namingCuePatterns?.some((pattern) => pattern.test(context)) ?? false));
    const caseConsistency = evidence.count === 0
      ? 1
      : evidence.candidateCaseCount / evidence.count;
    const caseAmbiguous = evidence.candidateCaseCount < evidence.count
      && caseConsistency <= 0.5;
    if (caseAmbiguous && !hasAliasCue && !hasNamingCue) {
      return [];
    }
    const isCjk = definition.script === "kana" || definition.script === "hangul";
    const hasDirectTermCue = evidence.directTermCueCount > 0;
    const sourceAuthoredTargets = [...evidence.directTargets.keys()];
    const sourceAuthoredTarget = sourceAuthoredTargets.length === 1
      ? sourceAuthoredTargets[0]
      : undefined;
    if (isCjk && evidence.count < 2 && wave.count < 2
      && !hasAliasCue && !hasNamingCue && !hasDirectTermCue) {
      return [];
    }
    if (definition.id === "ko") {
      if (evidence.count < 2 && wave.count < 2 && !hasNamingCue && !hasDirectTermCue) {
        return [];
      }
      if (evidence.morphologyMarkers.size === 1
        && !hasNamingCue
        && !hasDirectTermCue) {
        return [];
      }
    }
    const documentFrequency = evidence.documentIndexes.size;
    const morphologyDiversity = evidence.morphologyMarkers.size;
    const positionalSpread = Math.min(documentFrequency, 3) * 5
      + Math.min(contexts.length, 3) * 3;
    const inverseDocumentFrequency = Math.log(
      (Math.max(1, input.corpusTexts.length) + 1) / (documentFrequency + 1),
    );
    const localConcentration = evidence.count === 0
      ? 1
      : Math.min(1, wave.count / evidence.count);
    const score = isCjk
      ? 20
        + Math.log1p(wave.count) * 14
        + Math.max(0, inverseDocumentFrequency) * 18
        + localConcentration * 40
        + caseConsistency * 30
        - (1 - caseConsistency) * 35
        + (hasAliasCue ? 80 : 0)
        + (hasNamingCue ? 120 : 0)
        + (sourceAuthoredTarget === undefined ? 0 : 120)
      : 20
        + Math.log1p(evidence.count) * 8
        + Math.min(wave.count, 4) * 3
        + positionalSpread
        + caseConsistency * 30
        - (1 - caseConsistency) * 35
        + (hasAliasCue ? 80 : 0)
        + (hasNamingCue ? 20 : 0);
    return [{
      sourceForm: wave.sourceForm,
      normalizedSource,
      ...(sourceAuthoredTarget === undefined ? {} : { sourceAuthoredTarget }),
      ...(hasNamingCue ? { likelyProperName: true } : {}),
      contexts,
      corpusFrequency: evidence.count,
      currentWaveOccurrences: wave.count,
      documentFrequency,
      morphologyDiversity,
      score,
    }];
  }).sort((left, right) => right.score - left.score
    || left.sourceForm.localeCompare(right.sourceForm));
  if ((definition.script !== "kana" && definition.script !== "hangul") || limit < 3) {
    return ranked.slice(0, limit);
  }
  // Explicit source glosses and inferred names compete for different scarce
  // resources. Reserving one third of the slots for non-glossed forms prevents
  // a terminology-dense scene from crowding out recurrent character names.
  const inferredQuota = Math.min(8, Math.max(1, Math.ceil(limit / 3)));
  const explicitQuota = limit - inferredQuota;
  const explicit = ranked.filter((candidate) => candidate.sourceAuthoredTarget !== undefined);
  const inferred = ranked.filter((candidate) => candidate.sourceAuthoredTarget === undefined);
  const selected = [
    ...explicit.slice(0, explicitQuota),
    ...inferred.slice(0, inferredQuota),
  ];
  if (selected.length < limit) {
    const selectedKeys = new Set(selected.map((candidate) => candidate.normalizedSource));
    selected.push(...ranked.filter((candidate) => !selectedKeys.has(candidate.normalizedSource))
      .slice(0, limit - selected.length));
  }
  return selected.sort((left, right) => right.score - left.score
    || left.sourceForm.localeCompare(right.sourceForm));
}

function overlapsUrl(text: string, start: number, end: number): boolean {
  for (const match of text.matchAll(/https?:\/\/\S+|\b\S+\.\p{L}{2,}(?:\/\S*)?/giu)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (start < matchEnd && end > matchStart) {
      return true;
    }
  }
  return false;
}

function latinResidue(
  text: string,
  definition: ProfileDefinition,
  options: ResidueDetectionOptions,
): ResidueFinding[] {
  const preserved = new Set((options.preservedSourceForms ?? [])
    .flatMap((form) => segmentText(form, definition))
    .filter((token) => token.isWordLike)
    .map((token) => token.normalized));
  return segmentText(text, definition).flatMap((token): ResidueFinding[] => {
    if (!token.isWordLike
      || !/^\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]+$/u.test(token.value)
      || token.normalized.length < 2
      || preserved.has(token.normalized)
      || /^[\p{Lu}\d]{2,6}$/u.test(token.value)
      || /\d/u.test(token.value)
      || overlapsUrl(text, token.start, token.end)) {
      return [];
    }
    const neighborhood = text.slice(Math.max(0, token.start - 3), token.end + 3);
    if (/[=+*/^]\s*\p{L}|\p{L}\s*[=+*/^]/u.test(neighborhood)) {
      return [];
    }
    return [{
      code: "source_prose_residue",
      form: token.value,
      start: token.start,
      end: token.end,
      script: "latin",
    }];
  });
}

function scriptedResidue(
  text: string,
  definition: ProfileDefinition,
  options: ResidueDetectionOptions,
): ResidueFinding[] {
  const preserved = new Set((options.preservedSourceForms ?? [])
    .map((form) => normalizeForm(form, definition)));
  const pattern = definition.script === "cyrillic"
    ? /[\p{Script=Cyrillic}\p{M}]{2,}/gu
    : definition.script === "hangul"
      ? /[\p{Script=Hangul}]{2,}/gu
      : /[\p{Script=Hiragana}\p{Script=Katakana}\u30fc]{2,}/gu;
  const matches = [...text.matchAll(pattern)];
  if (definition.script === "kana") {
    matches.push(...text.matchAll(
      /[\p{Script=Hiragana}\p{Script=Katakana}\u30fc][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]{0,8}[\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/gu,
    ));
  }
  const seen = new Set<string>();
  return matches.sort((left, right) => left.index - right.index
    || left[0].length - right[0].length).flatMap((match): ResidueFinding[] => {
    const form = match[0];
    const normalized = normalizeForm(form, definition);
    const key = `${match.index}:${match.index + form.length}`;
    if (seen.has(key)
      || preserved.has(normalized)
      || [...preserved].some((preservedForm) => preservedForm.includes(normalized))) {
      return [];
    }
    seen.add(key);
    return [{
      code: "source_prose_residue",
      form,
      start: match.index,
      end: match.index + form.length,
      script: definition.script === "cyrillic"
        ? "cyrillic"
        : definition.script === "hangul"
          ? "hangul"
          : "kana",
    }];
  });
}

function buildProfile(definition: ProfileDefinition): SourceLanguageProfile {
  const profile: SourceLanguageProfile = {
    id: definition.id,
    version: PROFILE_VERSION,
    displayName: definition.displayName,
    locale: definition.locale,
    scripts: scriptsFor(definition),
    translationLengthRatioBands: definition.translationLengthRatioBands === undefined
      ? DEFAULT_TRANSLATION_LENGTH_RATIO_BANDS
      : Object.freeze(
        definition.translationLengthRatioBands.map((band) => Object.freeze({ ...band })),
      ),
    detectStructureHeading(line: string): StructureHeading | null {
      return structureHeading(line, definition);
    },
    collectBoundaryCandidates(text: string): BoundaryCandidate[] {
      return cjkBoundaryCandidates(text, definition);
    },
    collectScriptStats(text: string): ScriptStats {
      return scriptStats(text);
    },
    segment(text: string): SourceToken[] {
      return segmentText(text, definition);
    },
    normalizeSourceLiteral(text: string): string {
      return normalizeLiteral(text, definition);
    },
    normalizeSourceForm(text: string): string {
      return normalizeForm(text, definition);
    },
    normalizeAnchorSourceForm(text: string): string {
      const token: SourceToken = {
        value: text,
        normalized: normalizeForm(text, definition),
        start: 0,
        end: text.length,
        isWordLike: true,
      };
      return candidateTokenForm(token, definition)?.normalizedSource ?? token.normalized;
    },
    hasExplicitEntityNamingCue(text: string): boolean {
      return definition.aliasCuePatterns?.some((pattern) => pattern.test(text)) ?? false;
    },
    collectAnchorCandidates(input: AnchorCandidateInput): ProfileAnchorCandidate[] {
      return collectCandidates(input, definition);
    },
    detectSourceResidue(
      translation: string,
      options: ResidueDetectionOptions = {},
    ): ResidueFinding[] {
      if (definition.script === "latin") {
        return latinResidue(translation, definition, options);
      }
      if (definition.script === "cyrillic"
        || definition.script === "kana"
        || definition.script === "hangul") {
        return scriptedResidue(translation, definition, options);
      }
      return [];
    },
  };
  return Object.freeze(profile);
}

const PROFILES = new Map(DEFINITIONS.map((definition) => [
  definition.id,
  buildProfile(definition),
]));

export function supportedSourceLanguageIds(): string[] {
  return [...PROFILES.keys()].sort();
}

export function getSourceLanguageProfile(language: string | undefined): SourceLanguageProfile {
  const primary = language?.trim().toLocaleLowerCase().split("-", 1)[0] ?? "und";
  return PROFILES.get(primary) ?? PROFILES.get("und") as SourceLanguageProfile;
}
