import type { StableTerm } from "../domain/types.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { canonicalJson } from "./knowledge-store.js";
import {
  createTermRenderingRule,
  compileTermRenderingRules,
  type TermRenderingRule,
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
  const rules = new Map<string, TermRenderingRule>();
  const signatures = new Map<string, string>();
  const formsByRule = new Map<string, Set<string>>();
  const termsByForm = new Map<string, Map<string, number[]>>();
  const normalize = (value: string): string => profile.normalizeSourceForm(value);
  terms.forEach((term, index) => {
    const id = ruleId(term);
    const rule = createTermRenderingRule({
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
    // A rule may have several lexemes. Only its spelling varies; conflicting
    // metadata under one durable rule ID must still fail closed.
    const signature = canonicalJson({
      ...rule,
      sourceForms: [],
      bindingConceptId: term.conceptId,
      revisionId: term.revisionId ?? null,
      renderFingerprint: term.renderFingerprint ?? null,
    });
    if (signatures.has(id) && signatures.get(id) !== signature) {
      throw new Error(`TERM_RULE_ID_CONFLICT: ${id}`);
    }
    signatures.set(id, signature);
    rules.set(id, rule);
    const forms = formsByRule.get(id) ?? new Set<string>();
    forms.add(term.sourceForm);
    formsByRule.set(id, forms);
    const form = normalize(term.sourceForm);
    const byRule = termsByForm.get(form) ?? new Map<string, number[]>();
    const indices = byRule.get(id) ?? [];
    indices.push(index);
    byRule.set(id, indices);
    termsByForm.set(form, byRule);
  });
  const resolver = compileTermRenderingRules([...rules].map(([id, rule]) => ({
    ...rule, sourceForms: [...formsByRule.get(id)!],
  })), normalize);
  const normalizedForms = [...termsByForm.keys()].sort();
  const blockIdsByTerm = new Map<number, Set<string>>();
  const firstBlockOrder = new Map<number, number>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    for (const form of normalizedForms) {
      const winner = resolver.resolve(form, block);
      if (winner === undefined) continue;
      for (const termIndex of termsByForm.get(form)!.get(winner.ruleId)!) {
        const ids = blockIdsByTerm.get(termIndex) ?? new Set<string>();
        ids.add(block.blockId);
        blockIdsByTerm.set(termIndex, ids);
        if (!firstBlockOrder.has(termIndex)) firstBlockOrder.set(termIndex, index);
      }
    }
  }
  return [...blockIdsByTerm.entries()]
    .sort(([left], [right]) =>
      (firstBlockOrder.get(left) ?? 0) - (firstBlockOrder.get(right) ?? 0)
      || terms[left]!.sourceForm.localeCompare(terms[right]!.sourceForm, profile.locale)
      || ruleId(terms[left]!).localeCompare(ruleId(terms[right]!), "und"))
    .map(([index, blockIds]) => {
      const term = terms[index]!;
      const applicableBlockIds = [...blockIds];
      const isPartiallyShadowed = applicableBlockIds.length < blocks.length;
      return term.applicability === undefined && !isPartiallyShadowed
        ? { ...term }
        : {
            ...term,
            applicableBlockIds: Object.freeze(applicableBlockIds),
          };
    });
}
