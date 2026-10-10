import { createHash } from "node:crypto";
import type { StableTerm } from "../domain/types.js";
import { canonicalJson } from "./knowledge-store.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const compact = (value: string, limit: number): string => value.trim().slice(0, limit).trim();

/** Keep weak specialized senses separate from independently corroborated concepts. */
export function createLexicalPreference(input: {
  sourceForm: string; target: string; meaning?: string; usageScope?: string;
  allowedTargets?: readonly string[]; contexts: readonly string[]; confidence?: number;
  mode: "stable" | "contextual";
}): StableTerm {
  const sourceForm = compact(input.sourceForm, 128);
  const target = compact(input.target, 64);
  const meaning = compact(input.meaning ?? "specialized sense in the cited source contexts", 240);
  const usageScope = compact(input.usageScope ?? "same sense as the cited source contexts only", 240);
  const evidenceQuotes = [...new Set(input.contexts.map(q => compact(q, 320)).filter(Boolean))].slice(0, 3);
  const senseId = hash({ source: sourceForm.normalize("NFKC").toLowerCase(), meaning, usageScope }).slice(0, 24);
  const allowedTargets = [...new Set([target, ...(input.allowedTargets ?? []).map(t => compact(t, 64)).filter(Boolean)])].slice(0, 5);
  const preference = { senseId, meaning, usageScope, evidenceQuotes };
  const policy = input.mode === "contextual" ? "contextual" as const : "preferred" as const;
  const renderFingerprint = hash({ sourceForm, target, allowedTargets, policy, meaning, usageScope });
  return {
    conceptId: `lexical-preference-${senseId}`, lexemeId: `lexical-preference-${senseId}-lexeme`,
    sourceForm, canonicalSource: sourceForm, target, locked: false, policy, semanticClass: "technical_term",
    allowedTargets, preference, renderFingerprint, revisionId: `preference-${hash({ renderFingerprint, preference }).slice(0, 24)}`,
    authorityRank: 5,
    note: `Soft preference. Meaning: ${meaning}. Applies to: ${usageScope}. Keep the established name for this sense; a different sense may use different wording. Sentence rhythm, imagery and voice remain free.`,
  };
}

export function readLexicalPreference(value: unknown): StableTerm | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const term = value as Partial<StableTerm>;
  const pref = term.preference;
  if (typeof term.sourceForm !== "string" || !term.sourceForm.trim()
    || typeof term.target !== "string" || !term.target.trim()
    || !pref || typeof pref.meaning !== "string" || !pref.meaning.trim()
    || typeof pref.usageScope !== "string" || !pref.usageScope.trim()
    || !Array.isArray(pref.evidenceQuotes) || !pref.evidenceQuotes.length
    || !pref.evidenceQuotes.every(q => typeof q === "string" && q.trim())
    || (term.allowedTargets !== undefined && (!Array.isArray(term.allowedTargets) || !term.allowedTargets.every(t => typeof t === "string")))) return undefined;
  const restored = createLexicalPreference({ sourceForm: term.sourceForm, target: term.target,
    meaning: pref.meaning, usageScope: pref.usageScope, contexts: pref.evidenceQuotes,
    allowedTargets: term.allowedTargets, mode: term.policy === "contextual" ? "contextual" : "stable" });
  // Preserve authentic historical revision IDs without reintroducing the obsolete score.
  if (typeof pref.confidence === "number" && Number.isFinite(pref.confidence)) {
    const legacyId = `preference-${hash({ renderFingerprint: restored.renderFingerprint,
      preference: { ...restored.preference, confidence: pref.confidence } }).slice(0, 24)}`;
    if (term.revisionId === legacyId && term.renderFingerprint === restored.renderFingerprint) {
      return { ...restored, revisionId: legacyId };
    }
  }
  return restored;
}

/** Distinct senses stay separate in SQLite; one contextual wire entry avoids rule conflicts. */
export function combineLexicalPreferences(terms: readonly StableTerm[]): StableTerm[] {
  const groups = new Map<string, StableTerm[]>();
  for (const term of terms) {
    const key = term.sourceForm.normalize("NFKC").toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), term]);
  }
  return [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => a.conceptId.localeCompare(b.conceptId));
    const first = sorted[0]!;
    if (sorted.length === 1) return first;
    const id = `lexical-preference-senses-${hash(sorted.map(t => t.conceptId)).slice(0, 24)}`;
    return { ...first, conceptId: id, lexemeId: `${id}-lexeme`, policy: "contextual",
      revisionId: `preference-${hash(sorted.map(t => t.revisionId)).slice(0, 24)}`,
      renderFingerprint: hash(sorted.map(t => t.renderFingerprint)),
      allowedTargets: [...new Set(sorted.flatMap(t => t.allowedTargets ?? [t.target]))],
      note: `Distinct senses; choose by source meaning, not a global replacement. ${sorted.map(t => `${t.target}: ${t.note}`).join(" | ")}`,
    };
  });
}
