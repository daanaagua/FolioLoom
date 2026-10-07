import type { SupervisorInput } from "./supervisor.js";
import { paragraphEvidenceReferences } from "../domain/evidence-reference.js";
import { hasChangedIssueEvidence } from "../domain/quality-closure.js";
import { searchSupervisorTargets } from "./supervisor-target-context.js";

export const REVIEW_CARDS_PROTOCOL = "occurrence-cards-1";
export function usesReviewCards(input: Pick<SupervisorInput, "event" | "reviewMode" | "priorIssues">): boolean {
  return input.event === "review" && input.reviewMode === "occurrence_cards" && !!input.priorIssues?.length;
}

/** Source identity selects the occurrence; the model never moves an old finding. */
export function supervisorReviewCards(input: SupervisorInput) {
  return (input.priorIssues ?? []).map(issue => {
    const sourceText = input.sources.find(s => s.blockId === issue.blockId)?.sourceText ?? "";
    const targetText = input.candidate?.find(t => t.blockId === issue.blockId)?.text ?? "";
    const sources = paragraphEvidenceReferences("source", issue.blockId, sourceText);
    const targets = paragraphEvidenceReferences("target", issue.blockId, targetText);
    const matches = sources.filter(s => issue.sourceQuote && (s.text.includes(issue.sourceQuote) || issue.sourceQuote.includes(s.text)));
    const exact = matches.find(s => s.id === issue.sourceRef);
    const source = exact ?? (matches.length === 1 ? matches[0] : undefined);
    const index = source ? sources.findIndex(s => s.id === source.id) : -1;
    const current = source && sources.length === targets.length ? targets[index] : undefined;
    const changeEvidence = !!current && hasChangedIssueEvidence(issue.targetQuote, targetText,
      input.priorCandidate?.find(t => t.blockId === issue.blockId)?.text);
    return { issueId: issue.issueId, blockId: issue.blockId,
      historicalProblem: issue.problem, before: issue.targetQuote,
      source: source ? { id: source.id, text: source.text } : null,
      current: current ? { id: current.id, text: current.text } : null,
      changeEvidence,
      allowedStatuses: current ? [...(changeEvidence ? ["fixed"] : []), "dismissed", "variant", "unresolved"] : ["unresolved"],
      ...(input.repairIntents?.find(i => i.issueId === issue.issueId) ? {
        repairIntent: input.repairIntents.find(i => i.issueId === issue.issueId)!.instruction,
      } : {}),
    };
  });
}

/** Cheap lexical lookup is comparison evidence, never an inferred hard glossary. */
export function supervisorReviewComparisons(input: SupervisorInput) {
  const candidates = reviewComparisonQueries(input.priorIssues ?? []);
  const queries = candidates.slice(0, 6);
  const seen = new Set<string>();
  const hits: (ReturnType<typeof searchSupervisorTargets>["hits"][number] & { query: string })[] = [];
  let characters = 0, truncated = candidates.length > queries.length;
  for (const query of queries) {
    for (const hit of searchSupervisorTargets(input, query, 4).hits) {
      const key = `${hit.blockId}:${hit.translationHash}:${hit.sourceRange.start}:${hit.targetRange.start}`;
      if (seen.has(key)) continue;
      const size = Array.from(hit.sourceExcerpt + hit.targetExcerpt).length;
      if (characters + size > 12000) { truncated = true; continue; }
      hits.push({ ...hit, query }); seen.add(key); characters += size;
    }
  }
  return { readOnly: true, characters, truncated, hits,
    instruction: "这是少量真实译法对照，不是全书多数票，也不是必须照抄的词表。以同一词义、说话人和作用范围比较；合理变体不要求统一。没有对照命中不代表没有其他译法。" };
}

/** Shared by prefetch and finalization locks; source matching is immutable. */
export function reviewComparisonQueries(issues: readonly { problem: string; sourceQuote: string }[]): string[] {
  return [...new Set(issues.flatMap(p =>
    (p.problem.match(/[\p{Script=Latin}][\p{Script=Latin}'’-]{2,}/gu) ?? [])
      .filter(word => p.sourceQuote.toLocaleLowerCase().includes(word.toLocaleLowerCase()))))]
    .filter(word => !/^(?:the|and|for|with|this|that|from|into|was|were|are|not|has|have|had|his|her|she|they|their|you|your|its|one|same|all|only|still)$/iu.test(word));
}
