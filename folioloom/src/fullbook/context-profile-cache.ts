import { serialize } from "node:v8";

import {
  planContextProfiles,
  type ContextPlanningInput,
  type ContextProfiles,
} from "./context-profile-planner.js";

/** Reuse exact decisions within one admission pass, never evidence payloads. */
export function createContextProfilePlanner(options: {
  readonly maxCachedInputs?: number;
  readonly solve?: typeof planContextProfiles;
} = {}): typeof planContextProfiles {
  const capacity = options.maxCachedInputs ?? 128;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("context planning cache capacity must be positive");
  }
  const solve = options.solve ?? planContextProfiles;
  const cache = new Map<string, ContextProfiles>();
  const maximumKeyBytes = 16 * 1024 * 1024;
  let keyBytes = 0;
  return (input: ContextPlanningInput): ContextProfiles => {
    // V8 serialization preserves undefined, null and non-finite numbers as
    // distinct values, so invalid input cannot bypass the solver's validation.
    // Keep every decision field here; payload is deliberately not inspected.
    const key = serialize([
      input.bundles.map((bundle) => [
        bundle.bundleId, bundle.kind, bundle.tokenCost, bundle.entryCost,
        bundle.byteCost, bundle.utility, bundle.coverage, bundle.requires,
        bundle.redundancyGroup, bundle.mandatory,
      ]),
      input.requiredCoverage,
      input.budgets.lean, input.budgets.balanced, input.budgets.rich,
      input.maxEntries, input.maxBytes,
    ]).toString("base64");
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return structuredClone(cached);
    }
    const profiles = solve(input);
    // Base64 keys are ASCII; account conservatively for UTF-16 string storage.
    const bytes = key.length * 2;
    if (bytes <= maximumKeyBytes) {
      while (cache.size >= capacity || keyBytes + bytes > maximumKeyBytes) {
        const oldestKey = cache.keys().next().value!;
        cache.delete(oldestKey);
        keyBytes -= oldestKey.length * 2;
      }
      cache.set(key, structuredClone(profiles));
      keyBytes += bytes;
    }
    return profiles;
  };
}
