import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  planContextProfiles,
  type ContextEvidenceBundle,
  type ContextPlanningInput,
} from "../src/fullbook/context-profile-planner.js";
import type { RiskDimension } from "../src/fullbook/task-risk.js";

function bundle(
  bundleId: string,
  tokenCost: number,
  utility: number,
  coverage: readonly RiskDimension[] = [],
  requires: readonly string[] = [],
  overrides: Partial<ContextEvidenceBundle> = {},
): ContextEvidenceBundle {
  return {
    bundleId,
    kind: "entity",
    tokenCost,
    utility,
    coverage,
    requires,
    mandatory: false,
    payload: { revisionIds: [bundleId] },
    ...overrides,
  };
}

function planningInput(
  bundles: readonly ContextEvidenceBundle[],
  overrides: Partial<ContextPlanningInput> = {},
): ContextPlanningInput {
  return {
    bundles,
    requiredCoverage: [],
    budgets: { lean: 220, balanced: 320, rich: 500 },
    ...overrides,
  };
}

test("context planning covers every required risk within the exact budget", () => {
  const profiles = planContextProfiles(planningInput([
    bundle("identity", 100, 8, ["entity_identity"]),
    bundle("control-relation", 120, 10, ["control"], ["identity"], {
      kind: "relation",
    }),
    bundle("duplicate-control", 180, 7, ["control"]),
  ], {
    requiredCoverage: ["entity_identity", "control"],
  }));

  assert.deepEqual(profiles.lean?.bundleIds, [
    "control-relation",
    "identity",
  ]);
  assert.equal(profiles.lean?.tokenCost, 220);
  assert.deepEqual(profiles.lean?.coveredRisks, [
    "entity_identity",
    "control",
  ]);
});

test("selecting an atomic relation closes all of its evidence dependencies", () => {
  const profile = planContextProfiles(planningInput([
    bundle("bird", 40, 2, ["entity_identity"]),
    bundle("glass-eyes", 40, 2),
    bundle("bird-has-glass-eyes", 80, 10, ["part_whole"], [
      "bird",
      "glass-eyes",
    ], {
      kind: "relation",
    }),
    bundle("glass-eyes-without-owner", 70, 9),
  ], {
    requiredCoverage: ["part_whole"],
    budgets: { lean: 160, balanced: 160, rich: 160 },
  })).balanced;

  assert.deepEqual(profile?.bundleIds, [
    "bird",
    "bird-has-glass-eyes",
    "glass-eyes",
  ]);
  assert.equal(
    profile?.bundleIds.includes("glass-eyes-without-owner"),
    false,
  );
});

test("mandatory evidence and its dependencies enter every feasible profile", () => {
  const profiles = planContextProfiles(planningInput([
    bundle("protocol-anchor", 60, 1),
    bundle("locked-term", 80, 1, [], ["protocol-anchor"], {
      kind: "term",
      mandatory: true,
    }),
    bundle("optional-style", 200, 20, [], [], { kind: "style" }),
  ], {
    budgets: { lean: 140, balanced: 200, rich: 400 },
  }));

  assert.deepEqual(profiles.lean?.bundleIds, [
    "locked-term",
    "protocol-anchor",
  ]);
  assert.deepEqual(profiles.balanced?.bundleIds, [
    "locked-term",
    "protocol-anchor",
  ]);
  assert.deepEqual(profiles.rich?.bundleIds, [
    "locked-term",
    "optional-style",
    "protocol-anchor",
  ]);
});

test("hard entry budgets constrain every profile and mandatory closure", () => {
  const optional = Array.from(
    { length: 30 },
    (_item, index) => bundle(
      `optional-${String(index).padStart(2, "0")}`,
      1,
      index + 1,
    ),
  );
  const profiles = planContextProfiles(planningInput(optional, {
    budgets: { lean: 100, balanced: 100, rich: 100 },
    maxEntries: 24,
  }));

  assert.equal(profiles.lean?.entryCost, 24);
  assert.equal(profiles.balanced?.entryCost, 24);
  assert.equal(profiles.rich?.entryCost, 24);
  assert.deepEqual(
    profiles.rich?.bundleIds,
    optional.slice(-24).map((item) => item.bundleId),
  );

  const mandatory = optional.map((item) => ({
    ...item,
    mandatory: true,
  }));
  const infeasible = planContextProfiles(planningInput(mandatory, {
    budgets: { lean: 100, balanced: 100, rich: 100 },
    maxEntries: 24,
  }));
  assert.equal(infeasible.lean, undefined);
  assert.equal(infeasible.balanced, undefined);
  assert.equal(infeasible.rich, undefined);
});

test("a profile is absent when mandatory evidence exceeds its budget", () => {
  const profiles = planContextProfiles(planningInput([
    bundle("mandatory-memory", 240, 5, [], [], {
      kind: "memory",
      mandatory: true,
    }),
  ]));

  assert.equal(profiles.lean, undefined);
  assert.equal(profiles.balanced?.tokenCost, 240);
});

test("feasible profile names remain distinct when their selections match", () => {
  const profiles = planContextProfiles(planningInput([
    bundle("only-evidence", 80, 5, ["viewpoint"]),
  ], {
    requiredCoverage: ["viewpoint"],
  }));

  assert.equal(profiles.lean?.name, "lean");
  assert.equal(profiles.balanced?.name, "balanced");
  assert.equal(profiles.rich?.name, "rich");
  assert.deepEqual(profiles.lean?.bundleIds, profiles.rich?.bundleIds);
});

test("redundancy decay preserves budget for stronger independent evidence", () => {
  const profile = planContextProfiles(planningInput([
    bundle("control-a", 100, 10, ["control"], [], {
      redundancyGroup: "control",
    }),
    bundle("control-b", 100, 9, ["control"], [], {
      redundancyGroup: "control",
    }),
    bundle("timeline", 100, 5, ["timeline"]),
  ], {
    requiredCoverage: ["control", "timeline"],
    budgets: { lean: 200, balanced: 200, rich: 200 },
  })).lean;

  assert.deepEqual(profile?.bundleIds, ["control-a", "timeline"]);
});

test("bundle validation rejects duplicate, missing, self, and cyclic dependencies", () => {
  assert.throws(
    () => planContextProfiles(planningInput([
      bundle("duplicate", 10, 1),
      bundle("duplicate", 20, 2),
    ])),
    /duplicate bundle id/u,
  );
  assert.throws(
    () => planContextProfiles(planningInput([
      bundle("missing", 10, 1, [], ["absent"]),
    ])),
    /unknown dependency/u,
  );
  assert.throws(
    () => planContextProfiles(planningInput([
      bundle("self", 10, 1, [], ["self"]),
    ])),
    /self dependency/u,
  );
  assert.throws(
    () => planContextProfiles(planningInput([
      bundle("left", 10, 1, [], ["right"]),
      bundle("right", 10, 1, [], ["left"]),
    ])),
    /dependency cycle/u,
  );
});

test("context planning is deterministic across input order", () => {
  const bundles = [
    bundle("a", 100, 5),
    bundle("b", 100, 5),
    bundle("c", 100, 5),
  ];

  assert.deepEqual(
    planContextProfiles(planningInput(bundles)),
    planContextProfiles(planningInput([...bundles].reverse())),
  );
});

test("five hundred bundles plan below fifty milliseconds after warmup", () => {
  const input = planningInput(Array.from({ length: 500 }, (_item, index) =>
    bundle(`bundle-${String(index).padStart(3, "0")}`, 48, index + 1)), {
    budgets: { lean: 8_000, balanced: 16_000, rich: 24_000 },
  });
  planContextProfiles(input);

  const started = performance.now();
  const profiles = planContextProfiles(input);
  const elapsedMs = performance.now() - started;

  assert.ok(profiles.rich);
  assert.ok(elapsedMs < 50, `context planning took ${elapsedMs.toFixed(2)} ms`);
});
