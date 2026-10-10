import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createContextProfilePlanner } from "../fullbook/context-profile-cache.js";
import { planContextProfiles } from "../fullbook/context-profile-planner.js";
import { variedContextPlanningInput, VARIED_CONTEXT_PROFILES } from "./context-planning-fixture.js";

let solverCalls = 0;
const plan = createContextProfilePlanner({ solve: (input) => {
  solverCalls += 1;
  return planContextProfiles(input);
} });
const timesMs: number[] = [];
for (let iteration = 0; iteration < 4; iteration += 1) {
  const input = variedContextPlanningInput();
  const start = performance.now();
  const profiles = plan(input);
  timesMs.push(performance.now() - start);
  assert.deepEqual(profiles, VARIED_CONTEXT_PROFILES);
}
assert.equal(solverCalls, 1);
console.log(JSON.stringify({ fixture: "synthetic-137-varied-costs", solverCalls,
  coldMs: timesMs[0], repeatMs: timesMs.slice(1), exactReferenceMatch: true }, null, 2));
