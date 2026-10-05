import assert from "node:assert/strict";
import test from "node:test";
import { pruneIndependentFrontier } from "../src/fullbook/context-frontier.js";

interface State {
  tokenCost: number;
  entryCost: number;
  byteCost: number;
  utility: number;
  id: number;
}
const tie = (a: State, b: State) => a.id - b.id;
function reference(candidates: readonly State[]): State[] {
  const dominates = (a: State, b: State) =>
    a.tokenCost <= b.tokenCost && a.entryCost <= b.entryCost
    && a.byteCost <= b.byteCost && a.utility >= b.utility
    && (a.tokenCost < b.tokenCost || a.entryCost < b.entryCost
      || a.byteCost < b.byteCost || a.utility > b.utility || tie(a, b) <= 0);
  let frontier: State[] = [];
  for (const candidate of candidates) {
    if (frontier.some((state) => dominates(state, candidate))) continue;
    frontier = frontier.filter((state) => !dominates(candidate, state));
    frontier.push(candidate);
  }
  return frontier;
}

test("indexed dominance preserves all resource tradeoffs and exact ties", () => {
  const candidates = [
    { tokenCost: 0, entryCost: 0, byteCost: 0, utility: -3, id: 0 },
    { tokenCost: 1, entryCost: 1, byteCost: 10, utility: 3, id: 7 },
    { tokenCost: 1, entryCost: 1, byteCost: 10, utility: 3, id: 2 },
    { tokenCost: 2, entryCost: 1, byteCost: 9, utility: 3, id: 3 },
    { tokenCost: 1, entryCost: 2, byteCost: 10, utility: 4, id: 4 },
    { tokenCost: 2, entryCost: 2, byteCost: 10, utility: 3, id: 5 },
    { tokenCost: 0, entryCost: 3, byteCost: 0, utility: 1, id: 6 },
  ];
  assert.deepEqual(pruneIndependentFrontier(candidates, tie), reference(candidates));
  assert.deepEqual(pruneIndependentFrontier([], tie), []);
});

test("indexed dominance equals pairwise pruning for seeded varied frontiers", () => {
  let seed = 527;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let sample = 0; sample < 250; sample += 1) {
    const candidates = Array.from({ length: 1 + random(350) }, (_, id) => ({
      tokenCost: random(32), entryCost: random(25), byteCost: random(250),
      utility: random(15) - 7, id,
    })).sort(() => random(3) - 1);
    assert.deepEqual(pruneIndependentFrontier(candidates, tie), reference(candidates));
  }
});

test("dominated resource ties do not materialize expensive selection identities", () => {
  const best = { tokenCost: 0, entryCost: 0, byteCost: 0, utility: 10, id: 0 };
  const candidates = [best, ...Array.from({ length: 200 }, (_, id) => ({
    tokenCost: 1, entryCost: 1, byteCost: 1, utility: 5, id: id + 1,
  }))];
  let comparisons = 0;
  assert.deepEqual(pruneIndependentFrontier(candidates, (a, b) => {
    comparisons += 1;
    return tie(a, b);
  }), [best]);
  assert.equal(comparisons, 0);
});
