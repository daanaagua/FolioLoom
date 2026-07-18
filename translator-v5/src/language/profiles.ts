import type {
  AnchorCandidateInput,
  ProfileAnchorCandidate,
  ResidueDetectionOptions,
  ResidueFinding,
  SourceLanguageProfile,
  SourceToken,
  StructureHeading,
} from "./types.js";

const PROFILE_VERSION = "source-language-profile-1";
const DEFAULT_CANDIDATE_LIMIT = 24;

interface ProfileDefinition {
  id: string;
  displayName: string;
  locale: string;
  volumePatterns: readonly RegExp[];
  chapterPatterns: readonly RegExp[];
  stopWords: readonly string[];
  script: "latin" | "cyrillic" | "kana" | "unknown";
  leadingContractions?: readonly string[];
  aliasCuePatterns?: readonly RegExp[];
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
      /\b(?:also known as|known as|called|alias|a\.?k\.?a\.?)\b/iu,
    ],
  },
  {
    id: "fr",
    displayName: "French",
    locale: "fr",
    volumePatterns: [/^LIVRE(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
    chapterPatterns: [
      /^CHAPITRE(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu,
      /^[IVXLCDM]+$/u,
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
    chapterPatterns: [/^KAPITEL(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
    stopWords: ["aber", "das", "der", "die", "ein", "eine", "er", "es", "im", "in", "mit", "sie", "und", "von", "zu"],
    script: "latin",
    aliasCuePatterns: [/\b(?:auch bekannt als|bekannt als|genannt)\b/iu],
  },
  {
    id: "es",
    displayName: "Spanish",
    locale: "es",
    volumePatterns: [/^LIBRO(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
    chapterPatterns: [/^CAP[IÍ]TULO(?:\s+(?:\d+|[IVXLCDM]+|[\p{L}-]+))?$/iu],
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
    volumePatterns: [/^第[^\r\n]{1,20}巻$/u],
    chapterPatterns: [/^第[^\r\n]{1,20}章$/u],
    stopWords: [],
    script: "kana",
    aliasCuePatterns: [/(?:別名|として知ら)/u],
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

function normalizeForm(value: string, definition: ProfileDefinition): string {
  let normalized = normalizeApostrophes(value.normalize("NFKC"))
    .trim()
    .toLocaleLowerCase(definition.locale);
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
  return false;
}

function collectCandidates(
  input: AnchorCandidateInput,
  definition: ProfileDefinition,
): ProfileAnchorCandidate[] {
  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("candidate limit must be a non-negative safe integer");
  }
  const established = new Set((input.establishedSourceForms ?? [])
    .map((form) => normalizeForm(form, definition)));
  const current = new Map<string, { sourceForm: string; count: number }>();
  for (const text of input.targetTexts) {
    for (const token of segmentText(text, definition)) {
      if (!isCandidateToken(token, definition) || established.has(token.normalized)) {
        continue;
      }
      const record = current.get(token.normalized) ?? {
        sourceForm: token.value.replace(/[’']s$/u, ""),
        count: 0,
      };
      record.count += 1;
      current.set(token.normalized, record);
    }
  }

  const corpus = new Map<string, {
    count: number;
    candidateCaseCount: number;
    contexts: Set<string>;
  }>();
  for (const text of input.corpusTexts) {
    for (const token of segmentText(text, definition)) {
      if (!current.has(token.normalized)) {
        continue;
      }
      const record = corpus.get(token.normalized) ?? {
        count: 0,
        candidateCaseCount: 0,
        contexts: new Set<string>(),
      };
      record.count += 1;
      if (isCandidateToken(token, definition)) {
        record.candidateCaseCount += 1;
      }
      if (record.contexts.size < 3) {
        const context = compactContext(text, token.start);
        if (context.length > 0) {
          record.contexts.add(context);
        }
      }
      corpus.set(token.normalized, record);
    }
  }

  return [...current.entries()].flatMap(([normalizedSource, wave]) => {
    const evidence = corpus.get(normalizedSource) ?? {
      count: wave.count,
      candidateCaseCount: wave.count,
      contexts: new Set<string>(),
    };
    const contexts = [...evidence.contexts];
    const hasAliasCue = contexts.some((context) =>
      definition.aliasCuePatterns?.some((pattern) => pattern.test(context)) ?? false);
    const caseConsistency = evidence.count === 0
      ? 1
      : evidence.candidateCaseCount / evidence.count;
    const caseAmbiguous = evidence.candidateCaseCount < evidence.count
      && caseConsistency <= 0.5;
    if (caseAmbiguous && !hasAliasCue) {
      return [];
    }
    const score = 20
      + Math.log1p(evidence.count) * 8
      + Math.min(wave.count, 4) * 3
      + caseConsistency * 30
      - (1 - caseConsistency) * 35
      + (hasAliasCue ? 80 : 0);
    return [{
      sourceForm: wave.sourceForm,
      normalizedSource,
      contexts,
      corpusFrequency: evidence.count,
      currentWaveOccurrences: wave.count,
      score,
    }];
  }).sort((left, right) => right.score - left.score
    || left.sourceForm.localeCompare(right.sourceForm))
    .slice(0, limit);
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
    : /[\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu;
  return [...text.matchAll(pattern)].flatMap((match): ResidueFinding[] => {
    const form = match[0];
    if (preserved.has(normalizeForm(form, definition))) {
      return [];
    }
    return [{
      code: "source_prose_residue",
      form,
      start: match.index,
      end: match.index + form.length,
      script: definition.script === "cyrillic" ? "cyrillic" : "kana",
    }];
  });
}

function buildProfile(definition: ProfileDefinition): SourceLanguageProfile {
  const profile: SourceLanguageProfile = {
    id: definition.id,
    version: PROFILE_VERSION,
    displayName: definition.displayName,
    locale: definition.locale,
    detectStructureHeading(line: string): StructureHeading | null {
      const title = line.trim();
      if (definition.volumePatterns.some((pattern) => pattern.test(title))) {
        return { kind: "volume_heading", title, boundaryWeight: 100 };
      }
      if (definition.chapterPatterns.some((pattern) => pattern.test(title))) {
        return { kind: "chapter_heading", title, boundaryWeight: 80 };
      }
      return null;
    },
    segment(text: string): SourceToken[] {
      return segmentText(text, definition);
    },
    normalizeSourceForm(text: string): string {
      return normalizeForm(text, definition);
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
      if (definition.script === "cyrillic" || definition.script === "kana") {
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
