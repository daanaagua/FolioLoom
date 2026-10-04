import type { StableTerm } from "../domain/types.js";

/** A wire-only projection: validators and the persisted terminology keep the full set. */
export function projectTranslationTerms(
  terms: readonly StableTerm[],
  input: { blockIds: ReadonlySet<string>; context: string; occurrenceConceptIds: ReadonlySet<string> },
): StableTerm[] {
  const candidates = terms.filter(term => !term.applicableBlockIds
    || term.applicableBlockIds.some(id => input.blockIds.has(id)));
  const text = input.context.normalize("NFKC").toLocaleLowerCase();
  const groups = (term: StableTerm): string[] => [
    `concept:${term.conceptId}`,
    ...(term.baseConceptId ? [`concept:${term.baseConceptId}`] : []),
    ...(term.entityId ? [`entity:${term.entityId}`] : []),
  ];
  const retained = new Set(candidates.filter(term => {
    // Legacy records lack the occurrence/alias metadata needed to prove irrelevance.
    const typed = term.semanticClass && term.revisionId && term.policy && term.allowedTargets?.length
      && /^[a-f0-9]{64}$/u.test(term.renderFingerprint ?? "");
    return !typed || term.locked || term.policy === "locked" || input.occurrenceConceptIds.has(term.conceptId)
      || [term.sourceForm, term.canonicalSource, term.target, ...(term.allowedTargets ?? [])]
        .some(surface => surface.length > 0 && text.includes(surface.normalize("NFKC").toLocaleLowerCase()));
  }));
  const retainedGroups = new Set([...retained].flatMap(groups));
  let changed = true;
  while (changed) {
    changed = false;
    for (const term of candidates) {
      if (!retained.has(term) && groups(term).some(group => retainedGroups.has(group))) {
        retained.add(term);
        groups(term).forEach(group => retainedGroups.add(group));
        changed = true;
      }
    }
  }
  return candidates.filter(term => retained.has(term));
}
