import type { StableTerm } from "../domain/types.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  createTermRenderingRule,
  resolveTermRenderingRule,
  type TermRuleBlockPosition,
} from "./term-rendering-rule.js";

function authorityRank(term: StableTerm): number {
  if (term.authorityRank !== undefined) return term.authorityRank;
  if (term.origin === "glossary") return 30;
  if (term.origin === "legacy") return 20;
  return 10;
}

function ruleId(term: StableTerm): string {
  return term.ruleId ?? `${term.conceptId}:${term.lexemeId}`;
}

/**
 * Resolve every source form independently for each immutable source block.
 * Scoped terms carry exact block IDs so a physical request may safely cross a
 * terminology boundary. Whole-book terms remain unscoped, preserving their
 * meaning when a request contains only part of the book.
 */
export function resolveStableTermsForBlocks(
  terms: readonly StableTerm[],
  blocks: readonly TermRuleBlockPosition[],
  profile: SourceLanguageProfile,
): StableTerm[] {
  const termByRuleId = new Map<string, StableTerm>();
  const rules = terms.map((term) => {
    const id = ruleId(term);
    const previous = termByRuleId.get(id);
    if (previous !== undefined && previous !== term) {
      throw new Error(`TERM_RULE_ID_CONFLICT: ${id}`);
    }
    termByRuleId.set(id, term);
    return createTermRenderingRule({
      ruleId: id,
      conceptId: term.baseConceptId ?? term.conceptId,
      ...(term.entityId === undefined ? {} : { entityId: term.entityId }),
      sourceForms: [term.sourceForm],
      target: term.target,
      allowedTargets: term.allowedTargets ?? [term.target],
      policy: term.policy ?? (term.locked ? "locked" : "preferred"),
      selector: term.applicability ?? { kind: "whole_book" },
      priority: term.priority ?? 0,
      authorityRank: authorityRank(term),
    });
  });
  const normalizedForms = [...new Set(terms.map((term) =>
    profile.normalizeSourceForm(term.sourceForm)))].sort();
  const blockIdsByRule = new Map<string, string[]>();
  const firstBlockOrder = new Map<string, number>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    for (const form of normalizedForms) {
      const winner = resolveTermRenderingRule(rules, form, block);
      if (winner === undefined) continue;
      const ids = blockIdsByRule.get(winner.ruleId) ?? [];
      if (!ids.includes(block.blockId)) ids.push(block.blockId);
      blockIdsByRule.set(winner.ruleId, ids);
      if (!firstBlockOrder.has(winner.ruleId)) {
        firstBlockOrder.set(winner.ruleId, index);
      }
    }
  }
  return [...blockIdsByRule.entries()]
    .map(([id, applicableBlockIds]) => {
      const term = termByRuleId.get(id) as StableTerm;
      const isPartiallyShadowed = applicableBlockIds.length < blocks.length;
      return term.applicability === undefined && !isPartiallyShadowed
        ? { ...term }
        : {
            ...term,
            applicableBlockIds: Object.freeze(applicableBlockIds),
          };
    })
    .sort((left, right) =>
      (firstBlockOrder.get(ruleId(left)) ?? 0)
        - (firstBlockOrder.get(ruleId(right)) ?? 0)
      || left.sourceForm.localeCompare(right.sourceForm, profile.locale)
      || ruleId(left).localeCompare(ruleId(right), "und"));
}
