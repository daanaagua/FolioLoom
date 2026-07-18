import { createHash } from "node:crypto";

import type { V4Block } from "../domain/types.js";
import type { LosslessBlock } from "../source/types.js";
import type {
  AdaptiveConcurrencyOptions,
  BookWindowPlan,
  WindowExecutionSummary,
} from "./types.js";

export interface WindowPlanOptions {
  targetSourceTokens?: number;
  maxSourceTokens?: number;
  maxBlocks?: number;
  protocolVersion?: string;
}

const DEFAULT_TARGET_SOURCE_TOKENS = 1_600;
const DEFAULT_MAX_SOURCE_TOKENS = 2_600;
const DEFAULT_MAX_BLOCKS = 3;
const DEFAULT_PROTOCOL_VERSION = "v5-book-3";
const STRUCTURE_CROSSING_PENALTY = 4;
const TINY_WINDOW_RATIO = 0.4;
const TINY_WINDOW_PENALTY = 2;
const COST_EPSILON = 1e-12;

type WindowSourceBlock = V4Block | LosslessBlock;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function stableWindowId(
  blocks: readonly WindowSourceBlock[],
  protocolVersion: string,
): string {
  const hash = createHash("sha256");
  hash.update(protocolVersion);
  for (const block of blocks) {
    hash.update("\0");
    hash.update(block.id);
    hash.update("\0");
    hash.update(block.sourceHash);
  }
  return `window-${hash.digest("hex").slice(0, 20)}`;
}

function isLosslessBlock(block: WindowSourceBlock): block is LosslessBlock {
  return "canonicalStart" in block;
}

function structureIdFor(block: WindowSourceBlock): string | null {
  return isLosslessBlock(block) ? block.structureId : block.chapterId;
}

function structureTitleFor(block: WindowSourceBlock): string | null {
  return isLosslessBlock(block) ? block.structureTitle : block.chapterTitle;
}

function sourceCharsFor(block: WindowSourceBlock): number {
  return isLosslessBlock(block)
    ? block.canonicalEnd - block.canonicalStart
    : block.sourceText.length;
}

function structureCrossings(
  blocks: readonly WindowSourceBlock[],
  start: number,
  end: number,
): number {
  let crossings = 0;
  let previous = structureIdFor(blocks[start] as WindowSourceBlock);
  for (let index = start + 1; index < end; index += 1) {
    const current = structureIdFor(blocks[index] as WindowSourceBlock);
    if (current !== previous && (current !== null || previous !== null)) {
      crossings += 1;
    }
    previous = current;
  }
  return crossings;
}

function logicalWindowCost(
  blocks: readonly WindowSourceBlock[],
  start: number,
  end: number,
  sourceTokens: number,
  targetSourceTokens: number,
): number {
  const ratio = sourceTokens / targetSourceTokens;
  const lengthDeviation = (ratio - 1) ** 2;
  const tinyPenalty = ratio < TINY_WINDOW_RATIO
    ? (TINY_WINDOW_RATIO - ratio) ** 2 * TINY_WINDOW_PENALTY
    : 0;
  return lengthDeviation
    + tinyPenalty
    + structureCrossings(blocks, start, end) * STRUCTURE_CROSSING_PENALTY;
}

interface WindowDecision {
  cost: number;
  windows: number;
  next: number;
}

function chooseWindowCuts(
  blocks: readonly WindowSourceBlock[],
  targetSourceTokens: number,
  maxSourceTokens: number,
  maxBlocks: number,
): number[] {
  const decisions: Array<WindowDecision | undefined> = new Array(blocks.length + 1);
  decisions[blocks.length] = { cost: 0, windows: 0, next: blocks.length };
  for (let start = blocks.length - 1; start >= 0; start -= 1) {
    let sourceTokens = 0;
    let best: WindowDecision | undefined;
    const last = Math.min(blocks.length, start + maxBlocks);
    for (let end = start + 1; end <= last; end += 1) {
      sourceTokens += (blocks[end - 1] as WindowSourceBlock).tokenCount;
      if (sourceTokens > maxSourceTokens && end > start + 1) {
        break;
      }
      const remainder = decisions[end] as WindowDecision;
      const candidate: WindowDecision = {
        cost: logicalWindowCost(
          blocks,
          start,
          end,
          sourceTokens,
          targetSourceTokens,
        ) + remainder.cost,
        windows: remainder.windows + 1,
        next: end,
      };
      const costDelta = candidate.cost - (best?.cost ?? Number.POSITIVE_INFINITY);
      if (best === undefined
        || costDelta < -COST_EPSILON
        || (Math.abs(costDelta) <= COST_EPSILON
          && (candidate.windows < best.windows
            || (candidate.windows === best.windows && candidate.next > best.next)))) {
        best = candidate;
      }
      if (sourceTokens > maxSourceTokens) {
        break;
      }
    }
    decisions[start] = best as WindowDecision;
  }
  const cuts = [0];
  while ((cuts.at(-1) as number) < blocks.length) {
    cuts.push((decisions[cuts.at(-1) as number] as WindowDecision).next);
  }
  return cuts;
}

export function planBookWindows(
  sourceBlocks: readonly WindowSourceBlock[],
  options: WindowPlanOptions = {},
): BookWindowPlan[] {
  const maxSourceTokens = positiveInteger(
    options.maxSourceTokens ?? DEFAULT_MAX_SOURCE_TOKENS,
    "maxSourceTokens",
  );
  const targetSourceTokens = positiveInteger(
    options.targetSourceTokens
      ?? Math.min(DEFAULT_TARGET_SOURCE_TOKENS, maxSourceTokens),
    "targetSourceTokens",
  );
  if (targetSourceTokens > maxSourceTokens) {
    throw new TypeError("targetSourceTokens must not exceed maxSourceTokens");
  }
  const maxBlocks = positiveInteger(options.maxBlocks ?? DEFAULT_MAX_BLOCKS, "maxBlocks");
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  if (protocolVersion.trim().length === 0) {
    throw new TypeError("protocolVersion must not be empty");
  }
  const blocks = [...sourceBlocks].sort((left, right) =>
    left.globalIndex - right.globalIndex
    || left.id.localeCompare(right.id));
  const seen = new Set<number>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as WindowSourceBlock;
    if (seen.has(block.globalIndex)) {
      throw new Error(`duplicate global index: ${block.globalIndex}`);
    }
    seen.add(block.globalIndex);
    if (index > 0
      && block.globalIndex !== (blocks[index - 1] as WindowSourceBlock).globalIndex + 1) {
      throw new Error("book blocks must use continuous global indexes");
    }
  }

  if (blocks.length === 0) {
    return [];
  }
  const cuts = chooseWindowCuts(
    blocks,
    targetSourceTokens,
    maxSourceTokens,
    maxBlocks,
  );
  const grouped = cuts.slice(0, -1).map((start, index) =>
    blocks.slice(start, cuts[index + 1] as number));

  return grouped.map((windowBlocks, ordinal) => {
    const first = windowBlocks[0] as WindowSourceBlock;
    const sourceTokens = windowBlocks.reduce(
      (total, block) => total + block.tokenCount,
      0,
    );
    return {
      windowId: stableWindowId(windowBlocks, protocolVersion),
      ordinal,
      chapterId: structureIdFor(first) ?? `chapter-at-${first.globalIndex}`,
      chapterTitle: structureTitleFor(first),
      blockIds: windowBlocks.map((block) => block.id),
      globalIndexes: windowBlocks.map((block) => block.globalIndex),
      sourceTokens,
      sourceChars: windowBlocks.reduce(
        (total, block) => total + sourceCharsFor(block),
        0,
      ),
      oversized: windowBlocks.length === 1 && sourceTokens > maxSourceTokens,
    };
  });
}

export function nextConcurrency(
  history: readonly WindowExecutionSummary[],
  options: AdaptiveConcurrencyOptions,
): number {
  const warmupWindows = Math.max(0, Math.trunc(options.warmupWindows));
  const maxConcurrency = positiveInteger(options.maxConcurrency, "maxConcurrency");
  const riskRatio = options.budgetRiskRatio ?? 0.8;
  if (!Number.isFinite(riskRatio) || riskRatio <= 0 || riskRatio > 1) {
    throw new TypeError("budgetRiskRatio must be in (0, 1]");
  }
  if (history.length < warmupWindows) {
    return 1;
  }
  const latest = history.at(-1);
  if (latest === undefined) {
    return 1;
  }
  const budgetRatio = latest.modelCallLimit === 0
    ? 1
    : latest.modelCalls / latest.modelCallLimit;
  if (latest.status !== "completed"
    || latest.repaired
    || latest.deadlineExceeded
    || budgetRatio > riskRatio) {
    return 1;
  }
  return maxConcurrency;
}
