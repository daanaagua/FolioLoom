import { supervisionHash } from "../domain/supervision.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";

export type PlanningMode = "supervised" | "source";
export const SOURCE_EXECUTION_POLICY = Object.freeze({
  schema: "source-execution-plan-1", maxFrontierWindows: 4, maxFrontierSourceTokens: 12_800,
  semanticReview: "complete-chapter-with-boundary-checks",
  contextSelection: "fixed-baseline", modelPlanning: false,
} as const);
interface SourceWindow {
  readonly windowId: string; readonly ordinal: number; readonly chapterId: string;
  readonly blockIds: readonly string[]; readonly sourceTokens: number;
}
export interface SourceExecutionWindow {
  readonly windowId: string; readonly ordinal: number; readonly sourceHash: string;
  readonly reviewBlockIds: readonly string[]; readonly risks: readonly string[];
}
export interface SourceExecutionPlan {
  readonly id: string; readonly sourceVersion: string; readonly policy: typeof SOURCE_EXECUTION_POLICY;
  readonly windows: readonly SourceExecutionWindow[];
  readonly frontiers: readonly { readonly windowIds: readonly string[]; readonly sourceTokens: number }[];
}

/** Source-only policy. Neither translations, model judgments nor concurrency enter its identity. */
export function planSourceExecution(sourceVersion: string, windows: readonly SourceWindow[],
  blocks: readonly { id: string; sourceText: string }[],
  chapterScopes?: readonly { readonly windowIds: readonly string[] }[]): SourceExecutionPlan {
  const byId = new Map(blocks.map(b => [b.id, b]));
  const ids = new Set<string>();
  const planned = windows.map((w, i): SourceExecutionWindow => {
    if (w.ordinal !== i || ids.has(w.windowId) || !w.blockIds.length
      || !Number.isSafeInteger(w.sourceTokens) || w.sourceTokens < 0) throw new Error("invalid source window order");
    ids.add(w.windowId);
    const sources = w.blockIds.map(id => {
      const block = byId.get(id); if (!block) throw new Error(`missing source block: ${id}`);
      return { blockId: id, sourceText: block.sourceText };
    });
    const text = stripEpubStructuralMarkers(sources.at(-1)!.sourceText).trim();
    const openBoundary = !!text && !/[.!?…。！？।][\s\p{Pe}\p{Pf}"'’”]*$/u.test(text);
    return { windowId: w.windowId, ordinal: w.ordinal, sourceHash: supervisionHash(sources),
      reviewBlockIds: openBoundary ? [...w.blockIds] : [], risks: openBoundary ? ["open-source-boundary"] : [] };
  });
  const frontiers: { windowIds: string[]; sourceTokens: number }[] = [];
  let previousChapter: string | undefined;
  for (const w of windows) {
    // Window planner fallback identifiers are per-block, not real chapter boundaries.
    const membership = chapterScopes?.flatMap((s, i) => s.windowIds.includes(w.windowId) ? [i] : []);
    if (membership && membership.length === 0) throw new Error("source window has no chapter coverage");
    const chapter = membership ? membership.join(":") : /^chapter-at-\d+$/u.test(w.chapterId) ? "document" : w.chapterId;
    let current = frontiers.at(-1);
    if (!current || previousChapter !== chapter || current.windowIds.length >= SOURCE_EXECUTION_POLICY.maxFrontierWindows
      || current.sourceTokens + w.sourceTokens > SOURCE_EXECUTION_POLICY.maxFrontierSourceTokens) {
      current = { windowIds: [], sourceTokens: 0 }; frontiers.push(current);
    }
    current.windowIds.push(w.windowId); current.sourceTokens += w.sourceTokens; previousChapter = chapter;
  }
  const content = { sourceVersion, policy: SOURCE_EXECUTION_POLICY, windows: planned, frontiers };
  return { id: supervisionHash(content), ...content };
}

/** Resume consumes the unchanged suffix of its original frontier, never repartitions from outputs. */
export function sourceFrontier(plan: SourceExecutionPlan, firstWindowId: string): readonly string[] {
  const frontier = plan.frontiers.find(f => f.windowIds.includes(firstWindowId));
  if (!frontier) throw new Error("window outside source plan");
  return frontier.windowIds.slice(frontier.windowIds.indexOf(firstWindowId));
}
