import type { RiskDimension } from "./task-risk.js";

export type ContextProfileName = "lean" | "balanced" | "rich";

export interface ContextEvidenceBundle {
  readonly bundleId: string;
  readonly kind:
    | "term"
    | "entity"
    | "relation"
    | "memory"
    | "style"
    | "recovery";
  readonly tokenCost: number;
  /**
   * Number of bounded wire entries consumed by this atomic bundle.  Context
   * users without an entry-shaped wire format may omit it (the default is 1).
   */
  readonly entryCost?: number;
  readonly utility: number;
  readonly coverage: readonly RiskDimension[];
  readonly requires: readonly string[];
  readonly redundancyGroup?: string;
  readonly mandatory: boolean;
  readonly payload: unknown;
}

export interface ContextPlanningInput {
  readonly bundles: readonly ContextEvidenceBundle[];
  readonly requiredCoverage: readonly RiskDimension[];
  readonly budgets: Readonly<Record<ContextProfileName, number>>;
  /** Hard entry cap shared with the downstream wire projector. */
  readonly maxEntries?: number;
}

export interface ContextProfile {
  readonly name: ContextProfileName;
  readonly bundleIds: readonly string[];
  readonly tokenCost: number;
  readonly entryCost: number;
  readonly utility: number;
  readonly coveredRisks: readonly RiskDimension[];
}

export interface ContextProfiles {
  readonly lean: ContextProfile | undefined;
  readonly balanced: ContextProfile | undefined;
  readonly rich: ContextProfile | undefined;
}

interface NormalizedBundle {
  readonly index: number;
  readonly value: ContextEvidenceBundle;
  readonly effectiveUtility: number;
  readonly entryCost: number;
  readonly coverageMask: number;
  readonly requirementMask: bigint;
  readonly bit: bigint;
}

interface ContextSelection {
  readonly bundleIndexes: readonly number[];
  readonly previous: ContextSelection | undefined;
}

interface ContextState {
  readonly tokenCost: number;
  readonly tokenBucket: number;
  readonly entryCost: number;
  readonly coverageMask: number;
  readonly selectedMask: bigint;
  readonly selection?: ContextSelection;
  readonly utility: number;
}

const PROFILE_NAMES = ["lean", "balanced", "rich"] as const;
const TOKEN_BUCKET_SIZE = 32;
const RISK_DIMENSIONS = [
  "entity_identity",
  "pronoun_resolution",
  "part_whole",
  "control",
  "causality",
  "timeline",
  "viewpoint",
  "character_knowledge",
] as const satisfies readonly RiskDimension[];
const BUNDLE_KINDS = new Set<ContextEvidenceBundle["kind"]>([
  "term",
  "entity",
  "relation",
  "memory",
  "style",
  "recovery",
]);

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string"
    || value.trim().length === 0
    || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty printable string`);
  }
  return value;
}

function tokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveEntryCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function utility(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function riskBit(value: RiskDimension, label: string): number {
  const index = RISK_DIMENSIONS.indexOf(value);
  if (index < 0) {
    throw new TypeError(`${label} contains an unknown risk dimension`);
  }
  return 1 << index;
}

function coverageMask(
  values: readonly RiskDimension[],
  label: string,
): number {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }
  let result = 0;
  for (const value of values) {
    result |= riskBit(value, label);
  }
  return result;
}

function stableTopologicalOrder(
  byId: ReadonlyMap<string, ContextEvidenceBundle>,
): readonly ContextEvidenceBundle[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const bundle of byId.values()) {
    indegree.set(bundle.bundleId, bundle.requires.length);
    for (const requirementId of bundle.requires) {
      const targets = dependents.get(requirementId) ?? [];
      targets.push(bundle.bundleId);
      dependents.set(requirementId, targets);
    }
  }
  for (const targets of dependents.values()) {
    targets.sort(compareText);
  }

  const ready = [...byId.keys()]
    .filter((bundleId) => indegree.get(bundleId) === 0)
    .sort(compareText);
  const ordered: ContextEvidenceBundle[] = [];
  while (ready.length > 0) {
    const bundleId = ready.shift()!;
    ordered.push(byId.get(bundleId)!);
    for (const dependentId of dependents.get(bundleId) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
        ready.sort(compareText);
      }
    }
  }

  if (ordered.length !== byId.size) {
    const cyclicIds = [...byId.keys()]
      .filter((bundleId) => (indegree.get(bundleId) ?? 0) > 0)
      .sort(compareText);
    throw new TypeError(
      `context evidence dependency cycle: ${cyclicIds.join(",")}`,
    );
  }
  return ordered;
}

function normalizedBundles(
  input: ContextPlanningInput,
): {
  readonly bundles: readonly ContextEvidenceBundle[];
  readonly byId: ReadonlyMap<string, ContextEvidenceBundle>;
} {
  if (!Array.isArray(input.bundles)) {
    throw new TypeError("context evidence bundles must be an array");
  }
  const byId = new Map<string, ContextEvidenceBundle>();
  for (const rawBundle of [...input.bundles].sort((left, right) =>
    compareText(left.bundleId, right.bundleId))) {
    const bundleId = nonempty(rawBundle.bundleId, "bundle id");
    if (byId.has(bundleId)) {
      throw new TypeError(`duplicate bundle id: ${bundleId}`);
    }
    if (!BUNDLE_KINDS.has(rawBundle.kind)) {
      throw new TypeError(`unknown context evidence kind: ${String(rawBundle.kind)}`);
    }
    tokenCount(rawBundle.tokenCost, `${bundleId} token cost`);
    if (rawBundle.entryCost !== undefined) {
      positiveEntryCount(rawBundle.entryCost, `${bundleId} entry cost`);
    }
    utility(rawBundle.utility, `${bundleId} utility`);
    coverageMask(rawBundle.coverage, `${bundleId} coverage`);
    if (!Array.isArray(rawBundle.requires)) {
      throw new TypeError(`${bundleId} dependencies must be an array`);
    }
    const requires = [...new Set<string>(
      (rawBundle.requires as readonly string[]).map((requirementId) =>
        nonempty(requirementId, `${bundleId} dependency`)),
    )].sort(compareText);
    if (requires.includes(bundleId)) {
      throw new TypeError(`self dependency for context evidence: ${bundleId}`);
    }
    if (typeof rawBundle.mandatory !== "boolean") {
      throw new TypeError(`${bundleId} mandatory flag must be boolean`);
    }
    if (rawBundle.redundancyGroup !== undefined) {
      nonempty(rawBundle.redundancyGroup, `${bundleId} redundancy group`);
    }
    byId.set(bundleId, { ...rawBundle, bundleId, requires });
  }

  for (const bundle of byId.values()) {
    for (const requirementId of bundle.requires) {
      if (!byId.has(requirementId)) {
        throw new TypeError(
          `unknown dependency ${requirementId} required by ${bundle.bundleId}`,
        );
      }
    }
  }
  return {
    bundles: stableTopologicalOrder(byId),
    byId,
  };
}

function mandatoryClosure(
  bundles: readonly ContextEvidenceBundle[],
  byId: ReadonlyMap<string, ContextEvidenceBundle>,
): ReadonlySet<string> {
  const result = new Set(
    bundles.filter((bundle) => bundle.mandatory).map((bundle) => bundle.bundleId),
  );
  const pending = [...result];
  while (pending.length > 0) {
    const bundle = byId.get(pending.pop()!)!;
    for (const requirementId of bundle.requires) {
      if (!result.has(requirementId)) {
        result.add(requirementId);
        pending.push(requirementId);
      }
    }
  }
  return result;
}

function effectiveUtilities(
  bundles: readonly ContextEvidenceBundle[],
): ReadonlyMap<string, number> {
  const result = new Map(
    bundles.map((bundle) => [bundle.bundleId, bundle.utility]),
  );
  const groups = new Map<string, ContextEvidenceBundle[]>();
  for (const bundle of bundles) {
    if (bundle.redundancyGroup === undefined) {
      continue;
    }
    const group = groups.get(bundle.redundancyGroup) ?? [];
    group.push(bundle);
    groups.set(bundle.redundancyGroup, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) =>
      right.utility - left.utility
      || left.tokenCost - right.tokenCost
      || compareText(left.bundleId, right.bundleId));
    group.forEach((bundle, index) => {
      const multiplier = index === 0 ? 1 : index === 1 ? 0.35 : 0.15;
      result.set(bundle.bundleId, bundle.utility * multiplier);
    });
  }
  return result;
}

function selectedBundleIds(
  state: ContextState,
  bundles: readonly NormalizedBundle[],
): readonly string[] {
  if (state.selection !== undefined) {
    const result: string[] = [];
    let selection: ContextSelection | undefined = state.selection;
    while (selection !== undefined) {
      for (const bundleIndex of selection.bundleIndexes) {
        result.push(bundles[bundleIndex]!.value.bundleId);
      }
      selection = selection.previous;
    }
    return result.sort(compareText);
  }
  return bundles
    .filter((bundle) => (state.selectedMask & bundle.bit) !== 0n)
    .map((bundle) => bundle.value.bundleId)
    .sort(compareText);
}

function compareIdSequences(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = compareText(left[index]!, right[index]!);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function stateDominates(
  left: ContextState,
  right: ContextState,
  bundles: readonly NormalizedBundle[],
): boolean {
  if (left.tokenCost > right.tokenCost
    || left.entryCost > right.entryCost
    || left.utility < right.utility) {
    return false;
  }
  if (left.tokenCost < right.tokenCost
    || left.entryCost < right.entryCost
    || left.utility > right.utility) {
    return true;
  }
  return compareIdSequences(
    selectedBundleIds(left, bundles),
    selectedBundleIds(right, bundles),
  ) <= 0;
}

function pruneStates(
  candidates: readonly ContextState[],
  futureRequirementMask: bigint,
  bundles: readonly NormalizedBundle[],
): ContextState[] {
  const numericGroups = futureRequirementMask === 0n
    ? new Map<number, ContextState[]>()
    : undefined;
  const dependencyGroups = numericGroups === undefined
    ? new Map<string, ContextState[]>()
    : undefined;
  for (const candidate of candidates) {
    const numericKey = candidate.coverageMask * 1_000_000
      + candidate.tokenBucket;
    const dependencyKey = numericGroups === undefined
      ? `${numericKey}:${(
        candidate.selectedMask & futureRequirementMask
      ).toString(36)}`
      : undefined;
    const frontier = numericGroups?.get(numericKey)
      ?? dependencyGroups?.get(dependencyKey!)
      ?? [];
    if (frontier.some((state) => stateDominates(state, candidate, bundles))) {
      continue;
    }
    const next = frontier
      .filter((state) => !stateDominates(candidate, state, bundles));
    next.push(candidate);
    if (numericGroups !== undefined) {
      numericGroups.set(numericKey, next);
    } else {
      dependencyGroups!.set(dependencyKey!, next);
    }
  }
  const result: ContextState[] = [];
  for (const frontier of (numericGroups ?? dependencyGroups!).values()) {
    result.push(...frontier);
  }
  return result;
}

function finalStateOrder(
  left: ContextState,
  right: ContextState,
  bundles: readonly NormalizedBundle[],
): number {
  return right.utility - left.utility
    || left.tokenCost - right.tokenCost
    || compareIdSequences(
      selectedBundleIds(left, bundles),
      selectedBundleIds(right, bundles),
  );
}

function insertIndependentState(
  groups: Map<number, ContextState[]>,
  key: number,
  candidate: ContextState,
  bundles: readonly NormalizedBundle[],
): void {
  const frontier = groups.get(key) ?? [];
  if (frontier.some((state) => stateDominates(state, candidate, bundles))) {
    return;
  }
  const next = frontier
    .filter((state) => !stateDominates(candidate, state, bundles));
  next.push(candidate);
  groups.set(key, next);
}

function planIndependentStates(
  bundles: readonly NormalizedBundle[],
  mandatoryIds: ReadonlySet<string>,
  maximumBudget: number,
  maximumEntries: number,
): ContextState[] {
  const mandatoryBundles = bundles
    .filter((bundle) => mandatoryIds.has(bundle.value.bundleId));
  const mandatoryCost = mandatoryBundles.reduce(
    (total, bundle) => total + bundle.value.tokenCost,
    0,
  );
  const mandatoryEntryCost = mandatoryBundles.reduce(
    (total, bundle) => total + bundle.entryCost,
    0,
  );
  if (mandatoryCost > maximumBudget
    || mandatoryEntryCost > maximumEntries) {
    return [];
  }
  const mandatoryState: ContextState = {
    tokenCost: mandatoryCost,
    tokenBucket: Math.floor(mandatoryCost / TOKEN_BUCKET_SIZE),
    entryCost: mandatoryEntryCost,
    coverageMask: mandatoryBundles.reduce(
      (mask, bundle) => mask | bundle.coverageMask,
      0,
    ),
    selectedMask: 0n,
    selection: mandatoryBundles.length === 0
      ? undefined
      : {
        bundleIndexes: mandatoryBundles.map((bundle) => bundle.index),
        previous: undefined,
      },
    utility: mandatoryBundles.reduce(
      (total, bundle) => total + bundle.effectiveUtility,
      0,
    ),
  };
  const bucketsPerCoverage = Math.floor(
    maximumBudget / TOKEN_BUCKET_SIZE,
  ) + 1;
  const initialKey = mandatoryState.coverageMask * bucketsPerCoverage
    + mandatoryState.tokenBucket;
  let groups = new Map<number, ContextState[]>([[
    initialKey,
    [mandatoryState],
  ]]);
  const bundleGroups = new Map<string, NormalizedBundle[]>();
  for (const bundle of bundles) {
    if (mandatoryIds.has(bundle.value.bundleId)) {
      continue;
    }
    const key = [
      bundle.value.tokenCost,
      bundle.entryCost,
      bundle.coverageMask,
    ].join(":");
    const group = bundleGroups.get(key) ?? [];
    group.push(bundle);
    bundleGroups.set(key, group);
  }
  const orderedGroups = [...bundleGroups.values()].sort((left, right) =>
    left[0]!.value.tokenCost - right[0]!.value.tokenCost
    || left[0]!.coverageMask - right[0]!.coverageMask
    || compareText(left[0]!.value.bundleId, right[0]!.value.bundleId));
  for (const group of orderedGroups) {
    group.sort((left, right) =>
      right.effectiveUtility - left.effectiveUtility
      || compareText(left.value.bundleId, right.value.bundleId));
    const unitCost = group[0]!.value.tokenCost;
    const unitEntryCost = group[0]!.entryCost;
    const maximumCount = Math.min(
      group.length,
      Math.floor((maximumEntries - mandatoryEntryCost) / unitEntryCost),
      ...(unitCost === 0
        ? []
        : [Math.floor((maximumBudget - mandatoryCost) / unitCost)]),
    );
    const choices: {
      readonly count: number;
      readonly cost: number;
      readonly entryCost: number;
      readonly utility: number;
      readonly bundleIndexes: readonly number[];
    }[] = [{
      count: 0,
      cost: 0,
      entryCost: 0,
      utility: 0,
      bundleIndexes: [],
    }];
    let prefixUtility = 0;
    const prefixIndexes: number[] = [];
    for (let count = 1; count <= maximumCount; count += 1) {
      const bundle = group[count - 1]!;
      prefixUtility += bundle.effectiveUtility;
      prefixIndexes.push(bundle.index);
      choices.push({
        count,
        cost: unitCost * count,
        entryCost: unitEntryCost * count,
        utility: prefixUtility,
        bundleIndexes: [...prefixIndexes],
      });
    }

    const next = new Map<number, ContextState[]>();
    for (const frontier of groups.values()) {
      for (const state of frontier) {
        for (const choice of choices) {
          const nextCost = state.tokenCost + choice.cost;
          const nextEntryCost = state.entryCost + choice.entryCost;
          if (nextCost > maximumBudget
            || nextEntryCost > maximumEntries) {
            break;
          }
          const candidate: ContextState = {
            tokenCost: nextCost,
            tokenBucket: Math.floor(nextCost / TOKEN_BUCKET_SIZE),
            entryCost: nextEntryCost,
            coverageMask: choice.count === 0
              ? state.coverageMask
              : state.coverageMask | group[0]!.coverageMask,
            selectedMask: 0n,
            selection: choice.count === 0
              ? state.selection
              : {
                bundleIndexes: choice.bundleIndexes,
                previous: state.selection,
              },
            utility: state.utility + choice.utility,
          };
          const key = candidate.coverageMask * bucketsPerCoverage
            + candidate.tokenBucket;
          insertIndependentState(next, key, candidate, bundles);
        }
      }
    }
    groups = next;
    if (groups.size === 0) {
      break;
    }
  }
  const result: ContextState[] = [];
  for (const frontier of groups.values()) {
    result.push(...frontier);
  }
  return result;
}

function profileFromState(
  name: ContextProfileName,
  state: ContextState,
  bundles: readonly NormalizedBundle[],
): ContextProfile {
  return {
    name,
    bundleIds: selectedBundleIds(state, bundles),
    tokenCost: state.tokenCost,
    entryCost: state.entryCost,
    utility: state.utility,
    coveredRisks: RISK_DIMENSIONS.filter((_risk, index) =>
      (state.coverageMask & (1 << index)) !== 0),
  };
}

export function planContextProfiles(
  input: ContextPlanningInput,
): ContextProfiles {
  const budgets = Object.fromEntries(PROFILE_NAMES.map((name) => [
    name,
    tokenCount(input.budgets[name], `${name} context budget`),
  ])) as Record<ContextProfileName, number>;
  const requiredMask = coverageMask(
    input.requiredCoverage,
    "required context coverage",
  );
  const maximumEntries = input.maxEntries === undefined
    ? Number.MAX_SAFE_INTEGER
    : tokenCount(input.maxEntries, "maximum context entries");
  const { bundles: orderedBundles, byId } = normalizedBundles(input);
  const mandatoryIds = mandatoryClosure(orderedBundles, byId);
  const utilities = effectiveUtilities(orderedBundles);
  const bitById = new Map<string, bigint>();
  orderedBundles.forEach((bundle, index) => {
    bitById.set(bundle.bundleId, 1n << BigInt(index));
  });
  const bundles: NormalizedBundle[] = orderedBundles.map((bundle, index) => ({
    index,
    value: bundle,
    effectiveUtility: utilities.get(bundle.bundleId)!,
    entryCost: bundle.entryCost ?? 1,
    coverageMask: coverageMask(bundle.coverage, `${bundle.bundleId} coverage`),
    requirementMask: bundle.requires.reduce(
      (mask, requirementId) => mask | bitById.get(requirementId)!,
      0n,
    ),
    bit: bitById.get(bundle.bundleId)!,
  }));
  const futureRequirementMasks = new Array<bigint>(bundles.length + 1).fill(0n);
  for (let index = bundles.length - 1; index >= 0; index -= 1) {
    futureRequirementMasks[index] = (
      futureRequirementMasks[index + 1]!
      | bundles[index]!.requirementMask
    );
  }

  const maximumBudget = Math.max(...Object.values(budgets));
  let states: ContextState[];
  if (bundles.every((bundle) => bundle.requirementMask === 0n)) {
    states = planIndependentStates(
      bundles,
      mandatoryIds,
      maximumBudget,
      maximumEntries,
    );
  } else {
    states = [{
      tokenCost: 0,
      tokenBucket: 0,
      entryCost: 0,
      coverageMask: 0,
      selectedMask: 0n,
      utility: 0,
    }];
    for (let index = 0; index < bundles.length; index += 1) {
      const bundle = bundles[index]!;
      const candidates: ContextState[] = mandatoryIds.has(bundle.value.bundleId)
        ? []
        : [...states];
      for (const state of states) {
        if ((state.selectedMask & bundle.requirementMask)
          !== bundle.requirementMask) {
          continue;
        }
        const nextCost = state.tokenCost + bundle.value.tokenCost;
        const nextEntryCost = state.entryCost + bundle.entryCost;
        if (nextCost > maximumBudget
          || nextEntryCost > maximumEntries) {
          continue;
        }
        candidates.push({
          tokenCost: nextCost,
          tokenBucket: Math.floor(nextCost / TOKEN_BUCKET_SIZE),
          entryCost: nextEntryCost,
          coverageMask: state.coverageMask | bundle.coverageMask,
          selectedMask: state.selectedMask | bundle.bit,
          utility: state.utility + bundle.effectiveUtility,
        });
      }
      states = pruneStates(
        candidates,
        futureRequirementMasks[index + 1]!,
        bundles,
      );
      if (states.length === 0) {
        break;
      }
    }
  }

  const result = {} as Record<ContextProfileName, ContextProfile | undefined>;
  for (const name of PROFILE_NAMES) {
    const feasible = states.filter((state) =>
      state.tokenCost <= budgets[name]
      && state.entryCost <= maximumEntries
      && (state.coverageMask & requiredMask) === requiredMask);
    feasible.sort((left, right) => finalStateOrder(left, right, bundles));
    result[name] = feasible[0] === undefined
      ? undefined
      : profileFromState(name, feasible[0], bundles);
  }
  return result;
}
