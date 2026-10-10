import type { AnchorCandidateInput, ProfileAnchorCandidate } from "./types.js";
import { boundedTextExcerpt } from "../text/bounded-excerpt.js";

// These are discovery hints, not a dictionary, semantic classification, or spelling correction.
const ORDINARY_HEADS = new Set(("other first second great good same own old little new last only next small right left "
  + "the and but for not out off can did get got let say said says see saw yet too how why nor yes now "
  + "this that these those there here what when where which who whose whom their your they them ours yours hers "
  + "have has had been being was were shall will would could should must might does doing done only even also then "
  + "because until while although though unless however therefore again always never still just both either neither each "
  + "hand hands head eyes face hair mind name voice body life time father mother child children boy boys girl girls "
  + "person persons people man men woman women traveler traveller student teacher soldier stranger friend friends way thing things heart door room house street place year years day days week words word "
  + "back front side part end rest more most few much many such whole every all one two three four five six seven eight nine ten").split(" "));
const WORD = /\b[a-z][a-z-]{2,31}(?:['’]s)?\b/gu;
const HEAD_CUE = /\b(the|a|an|our|your|their|his|her|its|this|that|these|those|all|some|many|several|few|fewer|more|most|both|any|no|we|us|you|they|them)[ \t]+(?:(?:old|new|small|large|long|short|heavy|light|wooden|metal|broken|little|[a-z]+(?:-[a-z]+){1,2})[ \t]+){0,2}$/iu;
const GROUP_PRONOUNS = new Set(["we", "us", "you", "they", "them"]);
const QUANTIFIER_CUES = new Set(["all", "some", "many", "several", "few", "fewer", "more", "most", "both", "any", "no"]);
const NEGATIVE_AUXILIARY = /^(?:isn|aren|wasn|weren|hasn|haven|hadn|doesn|don|didn|can|couldn|wouldn|shouldn|won|mustn|needn)['’]t$/u;
const AFTER_HEAD = new Set(("and or of on in at to for from with without by as than which that where when before after "
  + "around is are was were be been being has have had do does did can could may might must shall should will would "
  + "stood stands remained remains seemed seems opened closed needed needs held holds contained contains").split(" "));

function words(text: string) {
  return [...text.matchAll(WORD)].filter(m => !/[\p{L}\p{N}]/u.test(text[m.index - 1] ?? ""))
    .map(m => {
      const possessive = /['’]s$/u.test(m[0]);
      const form = m[0].replace(/['’]s$/u, "");
      const next = /^[ \t]+([A-Za-z][A-Za-z-]*(?:['’][A-Za-z]+)?)/u.exec(text.slice(m.index + m[0].length))?.[1]?.toLowerCase();
      // A determiner followed by another bare content word is often an adjective or compound modifier.
      // Leave such cases to semantic review instead of treating the first word as a noun automatically.
      const head = possessive || next === undefined || AFTER_HEAD.has(next) || NEGATIVE_AUXILIARY.test(next) || /(?:ed|ing)$/u.test(next);
      let cue = head ? HEAD_CUE.exec(text.slice(Math.max(0, m.index - 80), m.index))?.[1]?.toLowerCase() : undefined;
      // In "we guilders" the plural names the group; "we pass/work" are predicates.
      if (cue && GROUP_PRONOUNS.has(cue) && (!form.endsWith("s") || /(?:ss|us|is)$/u.test(form))) cue = undefined;
      return { form, at: m.index, cue, possessive, group: cue !== undefined && GROUP_PRONOUNS.has(cue) };
    });
}

function regularPlural(form: string): string {
  if (/[^aeiou]y$/u.test(form)) return `${form.slice(0, -1)}ies`;
  return `${form}${/(?:s|x|z|ch|sh)$/u.test(form) ? "es" : "s"}`;
}

/** Possible regular pairs only; every form must separately occur in the source. */
function possibleInflections(form: string): string[] {
  const roots = [form.slice(0, -1), form.slice(0, -2), `${form.slice(0, -3)}y`];
  return [...new Set([regularPlural(form), ...roots.filter(root => root.length >= 3 && regularPlural(root) === form)])];
}

const ordinary = (form: string): boolean => ORDINARY_HEADS.has(form)
  || possibleInflections(form).some(related => ORDINARY_HEADS.has(related));

/** Reserve a small candidate channel for repeated lowercase noun heads; the model still classifies meaning. */
export function collectEnglishContextualTermCandidates(input: AnchorCandidateInput): ProfileAnchorCandidate[] {
  const established = new Set((input.establishedSourceForms ?? []).map(s => s.toLowerCase().replace(/['’]s$/u, "")));
  const current = new Map<string, { count: number; heads: number }>();
  for (const text of input.targetTexts) for (const word of words(text)) {
    if (!ordinary(word.form) && !established.has(word.form)) {
      const record = current.get(word.form) ?? { count: 0, heads: 0 };
      record.count++;
      if (word.cue || word.possessive) record.heads++;
      current.set(word.form, record);
    }
  }
  const relevantForms = new Set([...current.keys()].flatMap(form => [form, ...possibleInflections(form)]));
  const corpus = new Map<string, { count: number; heads: number; strongHeads: number; groups: number; possessives: number; cues: Set<string>; documents: Set<number>; contexts: string[] }>();
  for (const [index, text] of input.corpusTexts.entries()) for (const word of words(text)) {
    if (!relevantForms.has(word.form) || ordinary(word.form)) continue;
    const record = corpus.get(word.form) ?? { count: 0, heads: 0, strongHeads: 0, groups: 0, possessives: 0, cues: new Set(), documents: new Set(), contexts: [] };
    record.count++;
    record.documents.add(index);
    if (word.cue || word.possessive) {
      record.heads++;
      if (word.possessive || word.cue && !QUANTIFIER_CUES.has(word.cue)) record.strongHeads++;
      if (word.group) record.groups++;
      if (word.cue) record.cues.add(word.cue);
      if (word.possessive || word.cue && ["our", "your", "their"].includes(word.cue)) record.possessives++;
      if (record.contexts.length < 3) {
        const context = boundedTextExcerpt(text, 360, Array.from(text.slice(0, word.at)).length).text;
        if (!record.contexts.includes(context)) record.contexts.push(context);
      }
    }
    corpus.set(word.form, record);
  }
  const ranked = [...current.entries()].flatMap(([sourceForm, local]) => {
    const value = corpus.get(sourceForm);
    if (!value?.contexts.length) return [];
    const related = possibleInflections(sourceForm).flatMap(form => {
      const evidence = corpus.get(form);
      return evidence?.contexts.length ? [{ form, evidence }] : [];
    });
    const family = [value, ...related.map(r => r.evidence)];
    const count = family.reduce((total, item) => total + item.count, 0);
    const heads = family.reduce((total, item) => total + item.heads, 0);
    // Quantifiers alone (for example repeated "all details") are weak lexical evidence.
    if (count < 3 || heads < 2 || !family.some(item => item.strongHeads > 0)) return [];
    if (!local.heads) return [];
    const currentWaveOccurrences = local.count;
    return [{ sourceForm, normalizedSource: sourceForm, contexts: value.contexts,
      corpusFrequency: value.count, currentWaveOccurrences, documentFrequency: value.documents.size, morphologyDiversity: family.length,
      ...(related.length ? { relatedSourceForms: related.map(({ form, evidence }) => ({
        sourceForm: form, corpusFrequency: evidence.count, contexts: evidence.contexts,
      })) } : {}),
      score: Math.min(local.heads, 4) * 16 + Math.min(currentWaveOccurrences, 4) * 8 + Math.min(value.cues.size, 4) * 6
        + Math.min(value.possessives, 4) * 4 + Math.log1p(Math.min(value.count, 16)) * 4
        + Math.min(related.length, 2) * 12 + Math.min(family.reduce((total, item) => total + item.groups, 0), 2) * 24 }];
  }).sort((a, b) => b.score - a.score || a.sourceForm.localeCompare(b.sourceForm));
  // One existing slot protects an attested low-frequency inflection from frequent heads.
  // Its exact spelling and semantic decision remain independent of the supporting form.
  const groupEvidence = (candidate: ProfileAnchorCandidate) => (corpus.get(candidate.sourceForm)?.groups ?? 0)
    + (candidate.relatedSourceForms ?? []).reduce((total, form) => total + (corpus.get(form.sourceForm)?.groups ?? 0), 0);
  const inflected = ranked.filter(candidate => candidate.relatedSourceForms?.length
    && (candidate.corpusFrequency < 3 || candidate.relatedSourceForms.some(form => form.corpusFrequency < 3)))
    .sort((a, b) => groupEvidence(b) - groupEvidence(a) || a.corpusFrequency - b.corpusFrequency
      || b.score - a.score || a.sourceForm.localeCompare(b.sourceForm))[0];
  return (inflected ? [inflected, ...ranked.filter(candidate => candidate !== inflected)] : ranked)
    .slice(0, Math.min(input.limit ?? 4, 4));
}

export function isEnglishPronounContraction(form: string): boolean {
  return /^(?:I|you|we|they|he|she|it|that|there|what)['’](?:m|re|ve|ll|d|s)$/iu.test(form);
}
