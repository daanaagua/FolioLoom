export const PARAGRAPH_INTEGRITY_INSTRUCTIONS = Object.freeze([
  "Return exactly one target paragraph for each source paragraph, in the same order; keep every target paragraph non-empty.",
  "Never move, duplicate, merge, or split content across paragraphs or blocks in ordinary prose.",
  "For paired ⟦E…⟧ and ⟦/E…⟧ EPUB structural-slot markers, preserve every marker exactly and in order; translate only inside each pair and leave no prose outside the pairs in that paragraph.",
  "Exception: when adjacent short display-only lines clearly form one title or heading, translate the whole group as one semantic unit and redistribute wording only within those same target paragraph slots to produce natural Chinese word order.",
  "Never move content across that display-line group or a block boundary, and never apply this exception to ordinary prose.",
] as const);
