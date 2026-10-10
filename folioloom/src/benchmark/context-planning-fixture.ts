import type { ContextPlanningInput, ContextProfiles } from "../fullbook/context-profile-planner.js";

/** Synthetic heterogeneous costs, without book text or persisted knowledge. */
export function variedContextPlanningInput(): ContextPlanningInput {
  return {
    bundles: Array.from({ length: 137 }, (_, index) => ({
      bundleId: `b-${String(index).padStart(3, "0")}`,
      kind: "entity",
      tokenCost: 150 + (index * 47) % 1100,
      byteCost: 500 + (index * 179) % 2900,
      entryCost: 1,
      utility: 1 + (index * 17) % 31,
      coverage: index % 7 === 0 ? ["control"] : index % 11 === 0 ? ["timeline"] : [],
      requires: [],
      mandatory: index === 0,
      payload: null,
    })),
    requiredCoverage: ["control"],
    budgets: { lean: 2500, balanced: 5000, rich: 83744 },
    maxEntries: 24,
    maxBytes: 23807,
  };
}

/** Exact selections from the pairwise-dominance solver, including tie breaks. */
export const VARIED_CONTEXT_PROFILES: ContextProfiles = {
  lean: {
    name: "lean",
    bundleIds: ["b-000", "b-001", "b-025", "b-027", "b-047", "b-049", "b-051",
      "b-071", "b-094", "b-118", "b-120"],
    tokenCost: 2491, entryCost: 11, byteCost: 17737, utility: 249,
    coveredRisks: ["control"],
  },
  balanced: {
    name: "balanced",
    bundleIds: ["b-000", "b-001", "b-003", "b-005", "b-007", "b-025", "b-027",
      "b-047", "b-049", "b-050", "b-051", "b-071", "b-098", "b-100", "b-118",
      "b-120", "b-122"],
    tokenCost: 4968, entryCost: 17, byteCost: 23526, utility: 397,
    coveredRisks: ["control"],
  },
  rich: {
    name: "rich",
    bundleIds: ["b-000", "b-001", "b-003", "b-005", "b-018", "b-020", "b-034",
      "b-036", "b-038", "b-040", "b-049", "b-051", "b-065", "b-067", "b-069",
      "b-071", "b-082", "b-098", "b-100", "b-102", "b-114", "b-116", "b-131",
      "b-133"],
    tokenCost: 16421, entryCost: 24, byteCost: 23797, utility: 592,
    coveredRisks: ["control"],
  },
};
