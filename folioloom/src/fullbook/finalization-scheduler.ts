import { ScopedOperationQueue } from "./scoped-operation-queue.js";
import { reviewComparisonQueries } from "../agents/supervisor-review-cards.js";
import { priorQualityIssues } from "../domain/quality-closure.js";

/** Stop queued work on failure, but settle every in-flight receipt before unwinding. */
export async function runFinalizationTasks(tasks: readonly { scopes: readonly string[]; run: () => Promise<void> }[], concurrency: number): Promise<void> {
  const queue = new ScopedOperationQueue(concurrency);
  if (tasks.some(task => !task.scopes.length || task.scopes.some(scope => !scope))) throw new Error("finalization scope is empty");
  let failed = false;
  let failure: unknown;
  await Promise.all(tasks.map(task => queue.run(task.scopes, async () => {
    if (failed) return;
    try { await task.run(); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
  })));
  if (failed) throw failure;
}

/** Lock writers and the source-bound comparison set, including currently empty hits. */
export function finalQualityScopes(blockIds: readonly string[], issues: readonly { message?: string; evidence?: { problem: string; sourceQuote: string } }[],
  sources: readonly { blockId: string; sourceText: string }[], targets: readonly { blockId: string; text: string }[] = []): string[] {
  const queries = reviewComparisonQueries(priorQualityIssues(issues.map(i => ({ code: "SUPERVISOR_SEMANTIC_REVIEW", repairable: true,
    message: i.message ?? "", ...(i.evidence ? { evidence: { targetQuote: "", ...i.evidence } } : {}) }))))
    .map(q => q.toLocaleLowerCase());
  return [...new Set([...blockIds, ...sources.filter(s => queries.some(q => s.sourceText.toLocaleLowerCase().includes(q))).map(s => s.blockId),
    ...targets.filter(t => queries.some(q => t.text.toLocaleLowerCase().includes(q))).map(t => t.blockId)])].map(id => `block:${id}`);
}
