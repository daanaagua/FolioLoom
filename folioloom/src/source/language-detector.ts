export interface DetectedLanguage {
  id: string;
  confidence: number;
}

const MAX_SAMPLE_CHARS = 48_000;

const LATIN_STOP_WORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["en", ["the", "and", "of", "to", "in", "is", "that", "for", "with", "on", "as", "was", "were", "from", "had", "his"]],
  ["fr", ["le", "la", "les", "de", "des", "du", "et", "en", "un", "une", "que", "pour", "dans", "sur", "avec", "mais", "avait", "était", "son", "ses"]],
  ["de", ["der", "die", "das", "und", "den", "dem", "des", "von", "zu", "mit", "ist", "war", "ein", "eine", "einer", "nicht", "sich", "auf", "als", "sein"]],
  ["es", ["el", "la", "los", "las", "de", "del", "y", "en", "que", "por", "para", "una", "un", "con", "pero", "había", "estaba", "se", "su"]],
]);

const LATIN_SIGNATURES: ReadonlyMap<string, RegExp> = new Map([
  ["de", /\b(?:aber|auch|einem|einen|einer|eines|nicht|sich|seine|seinen|wurde|über)\b|[äöüß]/giu],
  ["fr", /\b(?:ainsi|avait|avec|comme|dans|était|lorsque|mais|sans|sous)\b|[àâçéèêëîïôùûüÿœ]/giu],
  ["es", /\b(?:aunque|como|cuando|desde|estaba|había|pero|porque|sobre|tras)\b|[¿¡áéíóúñ]/giu],
  ["en", /\b(?:although|because|could|should|through|when|which|would)\b/giu],
]);

function stratifiedSample(source: string): string {
  if (source.length <= MAX_SAMPLE_CHARS) return source;
  const window = Math.floor(MAX_SAMPLE_CHARS / 3);
  const middle = Math.max(0, Math.floor((source.length - window) / 2));
  return [
    source.slice(0, window),
    source.slice(middle, middle + window),
    source.slice(-window),
  ].join("\n");
}

function confidence(hits: number, totalLetters: number): number {
  return Math.min(0.98, Number((0.55 + Math.min(0.3, hits / 20) + Math.min(0.13, totalLetters / 2_000)).toFixed(2)));
}

function countMatches(input: string, expression: RegExp): number {
  return [...input.matchAll(expression)].length;
}

function detectScriptLanguage(sample: string): DetectedLanguage | undefined {
  const letters = countMatches(sample, /\p{L}/gu);
  if (letters < 12) {
    return undefined;
  }
  const hangul = countMatches(sample, /\p{Script=Hangul}/gu);
  if (hangul >= 8 && hangul / letters >= 0.2) {
    return { id: "ko", confidence: confidence(hangul, letters) };
  }
  const kana = countMatches(sample, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  if (kana >= 8 && kana / letters >= 0.2) {
    return { id: "ja", confidence: confidence(kana, letters) };
  }
  const cyrillic = countMatches(sample, /\p{Script=Cyrillic}/gu);
  if (cyrillic >= 8 && cyrillic / letters >= 0.45) {
    return { id: "ru", confidence: confidence(cyrillic, letters) };
  }
  return undefined;
}

function detectLatinLanguage(sample: string): DetectedLanguage | undefined {
  const words = sample.toLocaleLowerCase("en").match(/\p{L}+/gu) ?? [];
  if (words.length < 8) {
    return undefined;
  }
  const wordSet = new Set(words);
  const scores = [...LATIN_STOP_WORDS.entries()].map(([id, stopWords]) => ({
    id,
    score: words.reduce((total, word) => total + (stopWords.includes(word) ? 1 : 0), 0)
      + countMatches(sample, LATIN_SIGNATURES.get(id) as RegExp) * 2,
    distinct: stopWords.reduce((total, word) => total + (wordSet.has(word) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score || right.distinct - left.distinct);
  const best = scores[0];
  const second = scores[1];
  if (best === undefined
    || best.score < 3
    || best.distinct < 2
    || (second !== undefined && best.score - second.score < 2)) {
    return undefined;
  }
  return {
    id: best.id,
    confidence: confidence(best.score, words.length),
  };
}

/**
 * A deliberately conservative, offline hint for onboarding. Callers should show
 * an undetermined state when this returns undefined rather than inventing a language.
 */
export function detectLanguage(source: string): DetectedLanguage | undefined {
  const sample = stratifiedSample(source);
  if (sample.trim().length === 0) {
    return undefined;
  }
  return detectScriptLanguage(sample) ?? detectLatinLanguage(sample);
}
