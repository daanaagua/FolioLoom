import type { AnchorCandidateInput, ProfileAnchorCandidate } from "./types.js";
import { boundedTextExcerpt } from "../text/bounded-excerpt.js";

// These are discovery hints, not a dictionary, semantic classification, or spelling correction.
const ORDINARY_HEADS = new Set(("other first second great good same own old little new last only next small right left "
  + "this that these those there here what when where which who whose whom their your they them ours yours hers "
  + "have has had been being was were shall will would could should must might does doing done only even also then "
  + "because until while although though unless however therefore again always never still just both either neither each "
  + "hand hands head eyes face hair mind name voice body life time father mother child children boy boys girl girls "
  + "person persons people man men woman women traveler traveller student teacher soldier stranger friend friends way thing things heart door room house street place year years day days week words word "
  + "back front side part end rest more most few much many such whole every all one two three four five six seven eight nine ten").split(" "));
const WORD = /\b[a-z][a-z-]{3,31}(?:['’]s)?\b/gu;
const HEAD_CUE = /\b(the|a|an|our|your|their|his|her|its|this|that|these|those)[ \t]+(?:(?:old|new|small|large|long|short|heavy|light|wooden|metal|broken|little)[ \t]+){0,2}$/iu;
const AFTER_HEAD = new Set(("and or of on in at to for from with without by as than which that where when before after "
  + "is are was were be been being has have had can could may might must shall should will would "
  + "stood stands remained remains seemed seems opened closed needed needs held holds contained contains").split(" "));

function words(text: string) {
  return [...text.matchAll(WORD)].filter(m => !/[\p{L}\p{N}]/u.test(text[m.index - 1] ?? ""))
    .map(m => {
      const possessive = /['’]s$/u.test(m[0]);
      const next = /^[ \t]+([A-Za-z][A-Za-z-]*)/u.exec(text.slice(m.index + m[0].length))?.[1]?.toLowerCase();
      // A determiner followed by another bare content word is often an adjective or compound modifier.
      // Leave such cases to semantic review instead of treating the first word as a noun automatically.
      const head = possessive || next === undefined || AFTER_HEAD.has(next) || /(?:ed|ing)$/u.test(next);
      return { form: m[0].replace(/['’]s$/u, ""), at: m.index,
        cue: head ? HEAD_CUE.exec(text.slice(Math.max(0, m.index - 24), m.index))?.[1]?.toLowerCase() : undefined, possessive };
    });
}

/** Reserve a small candidate channel for repeated lowercase noun heads; the model still classifies meaning. */
export function collectEnglishContextualTermCandidates(input: AnchorCandidateInput): ProfileAnchorCandidate[] {
  const established = new Set((input.establishedSourceForms ?? []).map(s => s.toLowerCase().replace(/['’]s$/u, "")));
  const current = new Map<string, { count: number; heads: number }>();
  for (const text of input.targetTexts) for (const word of words(text)) {
    if (!ORDINARY_HEADS.has(word.form) && !ORDINARY_HEADS.has(word.form.replace(/s$/u, "")) && !established.has(word.form)) {
      const record = current.get(word.form) ?? { count: 0, heads: 0 };
      record.count++;
      if (word.cue || word.possessive) record.heads++;
      current.set(word.form, record);
    }
  }
  const corpus = new Map<string, { count: number; heads: number; possessives: number; cues: Set<string>; documents: Set<number>; contexts: string[] }>();
  for (const [index, text] of input.corpusTexts.entries()) for (const word of words(text)) {
    if (!current.has(word.form)) continue;
    const record = corpus.get(word.form) ?? { count: 0, heads: 0, possessives: 0, cues: new Set(), documents: new Set(), contexts: [] };
    record.count++;
    record.documents.add(index);
    if (word.cue || word.possessive) {
      record.heads++;
      if (word.cue) record.cues.add(word.cue);
      if (word.possessive || word.cue && ["our", "your", "their"].includes(word.cue)) record.possessives++;
      if (record.contexts.length < 3) {
        const context = boundedTextExcerpt(text, 360, Array.from(text.slice(0, word.at)).length).text;
        if (!record.contexts.includes(context)) record.contexts.push(context);
      }
    }
    corpus.set(word.form, record);
  }
  return [...corpus.entries()].flatMap(([sourceForm, value]) => {
    if (value.count < 3 || value.heads < 2 || !value.contexts.length) return [];
    const local = current.get(sourceForm)!;
    if (!local.heads) return [];
    const currentWaveOccurrences = local.count;
    return [{ sourceForm, normalizedSource: sourceForm, contexts: value.contexts,
      corpusFrequency: value.count, currentWaveOccurrences, documentFrequency: value.documents.size, morphologyDiversity: 1,
      score: Math.min(local.heads, 4) * 16 + Math.min(currentWaveOccurrences, 4) * 8 + Math.min(value.cues.size, 4) * 6
        + Math.min(value.possessives, 4) * 4 + Math.log1p(Math.min(value.count, 16)) * 4 }];
  }).sort((a, b) => b.score - a.score || a.sourceForm.localeCompare(b.sourceForm)).slice(0, Math.min(input.limit ?? 4, 4));
}

export function isEnglishPronounContraction(form: string): boolean {
  return /^(?:I|you|we|they|he|she|it|that|there|what)['’](?:m|re|ve|ll|d|s)$/iu.test(form);
}
