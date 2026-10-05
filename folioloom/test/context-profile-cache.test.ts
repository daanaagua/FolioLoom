import assert from "node:assert/strict";
import test from "node:test";

import { createContextProfilePlanner } from "../src/fullbook/context-profile-cache.js";
import {
  planContextProfiles,
  type ContextPlanningInput,
} from "../src/fullbook/context-profile-planner.js";

function input(): ContextPlanningInput {
  return {
    bundles: [
      { bundleId: "a", kind: "entity", tokenCost: 10, entryCost: 1,
        byteCost: 20, utility: 4, coverage: ["control"], requires: [],
        mandatory: false, payload: { text: "evidence" } },
      { bundleId: "b", kind: "relation", tokenCost: 20, entryCost: 1,
        byteCost: 40, utility: 5, coverage: ["timeline"], requires: ["a"],
        mandatory: false, payload: null },
    ],
    requiredCoverage: ["control"],
    budgets: { lean: 10, balanced: 20, rich: 30 },
    maxEntries: 2,
    maxBytes: 60,
  };
}

function instrument(maxCachedInputs = 128) {
  let calls = 0;
  const plan = createContextProfilePlanner({
    maxCachedInputs,
    solve: (value) => { calls += 1; return planContextProfiles(value); },
  });
  return { plan, calls: () => calls };
}

test("equivalent admission inputs solve once without caching evidence payloads", () => {
  const cache = instrument();
  const expected = planContextProfiles(input());
  assert.deepEqual(cache.plan(input()), expected);
  const changedPayload = input();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const bundles = changedPayload.bundles.map((bundle) => ({
    ...bundle, payload: circular,
  }));
  assert.deepEqual(cache.plan({ ...changedPayload, bundles }), expected);
  assert.equal(cache.calls(), 1);
});

test("every planning decision field invalidates reuse", () => {
  const changes: readonly Partial<ContextPlanningInput>[] = [
    { requiredCoverage: ["timeline"] },
    { budgets: { lean: 11, balanced: 20, rich: 30 } },
    { budgets: { lean: 10, balanced: 21, rich: 30 } },
    { budgets: { lean: 10, balanced: 20, rich: 31 } },
    { maxEntries: 1 }, { maxBytes: 40 },
    ...[
      { bundleId: "c", requires: [] }, { kind: "memory" as const },
      { tokenCost: 21 }, { entryCost: 2 }, { byteCost: 41 },
      { utility: 6 }, { coverage: ["control" as const] },
      { requires: [] }, { redundancyGroup: "shared" }, { mandatory: true },
    ].map((change) => ({ bundles: [input().bundles[0]!, {
      ...input().bundles[1]!, ...change,
    }] })),
  ];
  for (const change of changes) {
    const cache = instrument();
    cache.plan(input());
    const changed = { ...input(), ...change };
    assert.deepEqual(cache.plan(changed), planContextProfiles(changed));
    assert.equal(cache.calls(), 2, JSON.stringify(change));
  }
});

test("callers cannot mutate cached profile arrays or objects", () => {
  const cache = instrument();
  const first = cache.plan(input());
  (first.rich!.bundleIds as string[]).push("unissued");
  (first.rich!.coveredRisks as string[]).length = 0;
  Object.assign(first.lean!, { tokenCost: 999 });
  assert.deepEqual(cache.plan(input()), planContextProfiles(input()));
  assert.equal(cache.calls(), 1);
});

test("bounded request-local cache evicts least recently used inputs", () => {
  const cache = instrument(2);
  const a = input();
  const b = { ...a, maxBytes: 50 };
  const c = { ...a, maxBytes: 40 };
  cache.plan(a); cache.plan(b); cache.plan(a); cache.plan(c); cache.plan(a);
  assert.equal(cache.calls(), 3);
  cache.plan(b);
  assert.equal(cache.calls(), 4);
  const separate = instrument();
  separate.plan(a);
  assert.equal(separate.calls(), 1);
});

test("invalid and omitted values cannot alias a previously valid cache key", () => {
  const cache = instrument();
  cache.plan({ ...input(), maxBytes: undefined });
  for (const maxBytes of [null, NaN, Infinity, -1]) {
    assert.throws(() => cache.plan({ ...input(), maxBytes } as ContextPlanningInput));
  }
  cache.plan(input());
  const invalid = { ...input(), bundles: input().bundles.map((bundle) => ({
    ...bundle, mandatory: null,
  })) } as unknown as ContextPlanningInput;
  assert.throws(() => cache.plan(invalid));
  assert.throws(() => cache.plan(invalid));
  assert.equal(cache.calls(), 8);
  assert.throws(() => instrument(0));
});
