interface FrontierState {
  readonly tokenCost: number;
  readonly entryCost: number;
  readonly byteCost: number;
  readonly utility: number;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Exact dominance among equal-coverage states; utilities must be finite. */
export function pruneIndependentFrontier<T extends FrontierState>(
  candidates: readonly T[],
  compareTies: (left: T, right: T) => number,
): T[] {
  if (candidates.length < 2) return [...candidates];
  // Earlier points have no greater token cost. Ordering the other costs and
  // utility makes every possible dominator precede its dominated point, even
  // for exact resource ties. The index answers entry <= x, bytes <= y, max utility.
  const ordered = candidates.map((state, index) => ({ state, index }));
  ordered.sort((a, b) => a.state.tokenCost - b.state.tokenCost
    || a.state.entryCost - b.state.entryCost
    || a.state.byteCost - b.state.byteCost
    || b.state.utility - a.state.utility);
  const entries = [...new Set(candidates.map((state) => state.entryCost))]
    .sort((a, b) => a - b);
  // Offline coordinate compression keeps the 2-D Fenwick tree at O(n log n)
  // space instead of allocating a dense entries-by-bytes grid.
  const byteCoordinates = Array.from({ length: entries.length + 1 }, () => [] as number[]);
  for (const state of candidates) {
    for (let x = upperBound(entries, state.entryCost); x <= entries.length; x += x & -x) {
      byteCoordinates[x]!.push(state.byteCost);
    }
  }
  const trees = byteCoordinates.map((values, index) => {
    const unique = [...new Set(values)].sort((a, b) => a - b);
    byteCoordinates[index] = unique;
    return new Float64Array(unique.length + 1).fill(-Infinity);
  });
  const retained = new Uint8Array(candidates.length);
  for (let position = 0; position < ordered.length;) {
    let chosen = ordered[position]!;
    const { state } = chosen;
    let end = position + 1;
    while (end < ordered.length) {
      const next = ordered[end]!.state;
      if (next.tokenCost !== state.tokenCost || next.entryCost !== state.entryCost
        || next.byteCost !== state.byteCost || next.utility !== state.utility) break;
      end += 1;
    }
    const entryIndex = upperBound(entries, state.entryCost);
    let best = -Infinity;
    for (let x = entryIndex; x > 0; x -= x & -x) {
      const tree = trees[x]!;
      for (let y = upperBound(byteCoordinates[x]!, state.byteCost); y > 0; y -= y & -y) {
        best = Math.max(best, tree[y]!);
      }
    }
    if (best >= state.utility) {
      position = end;
      continue;
    }
    // Resolve expensive identity ties only for a surviving resource tuple.
    for (let tie = position + 1; tie < end; tie += 1) {
      if (compareTies(ordered[tie]!.state, chosen.state) < 0) chosen = ordered[tie]!;
    }
    retained[chosen.index] = 1;
    position = end;
    for (let x = entryIndex; x <= entries.length; x += x & -x) {
      const tree = trees[x]!;
      for (let y = upperBound(byteCoordinates[x]!, state.byteCost); y < tree.length; y += y & -y) {
        tree[y] = Math.max(tree[y]!, state.utility);
      }
    }
  }
  // Preserve iteration order (and therefore subsequent floating-point addition
  // and stable tie behavior) from the original incremental frontier.
  return candidates.filter((_state, index) => retained[index] === 1);
}
