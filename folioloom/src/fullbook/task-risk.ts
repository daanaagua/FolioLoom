export type RiskDimension =
  | "entity_identity"
  | "pronoun_resolution"
  | "part_whole"
  | "control"
  | "causality"
  | "timeline"
  | "viewpoint"
  | "character_knowledge";

export type TaskRelationKind =
  | "identity"
  | "part_of"
  | "control"
  | "causality"
  | "timeline"
  | "viewpoint"
  | "character_knowledge";

export interface TaskRiskFeatures {
  readonly sourceTokens: number;
  readonly entityMentions: number;
  readonly pronounMentions: number;
  readonly relationKinds: readonly TaskRelationKind[];
  readonly remoteEvidenceDistance: number;
  readonly lockedTermOccurrences: number;
  readonly needsRevalidate: boolean;
  readonly priorRepairs: number;
  readonly sourceAnomalies: number;
}

export interface TaskRiskAssessment {
  readonly schemaVersion: "folioloom-task-risk-1";
  readonly score: number;
  readonly requiredCoverage: readonly RiskDimension[];
  readonly minimumContextProfile: "lean" | "balanced" | "rich";
  readonly minimumEffort: "low" | "medium" | "high";
  readonly requiredValidators: readonly (
    | "structure"
    | "terminology"
    | "cross_block"
    | "knowledge_coverage"
  )[];
}

const RELATION_KINDS: readonly TaskRelationKind[] = [
  "identity",
  "part_of",
  "control",
  "causality",
  "timeline",
  "viewpoint",
  "character_knowledge",
];

const CRITICAL_RELATIONS: ReadonlySet<TaskRelationKind> = new Set([
  "control",
  "causality",
  "timeline",
  "character_knowledge",
]);

const COVERAGE_ORDER: readonly RiskDimension[] = [
  "entity_identity",
  "pronoun_resolution",
  "part_whole",
  "control",
  "causality",
  "timeline",
  "viewpoint",
  "character_knowledge",
];

const VALIDATOR_ORDER = [
  "structure",
  "terminology",
  "cross_block",
  "knowledge_coverage",
] as const;

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function relationKinds(
  values: readonly TaskRelationKind[],
): ReadonlySet<TaskRelationKind> {
  if (!Array.isArray(values)) {
    throw new TypeError("relation kinds must be an array");
  }
  const result = new Set<TaskRelationKind>();
  for (const value of values) {
    if (!RELATION_KINDS.includes(value)) {
      throw new TypeError(`unknown relation kind: ${String(value)}`);
    }
    result.add(value);
  }
  return result;
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function normalizedCount(value: number, ceiling: number): number {
  return Math.min(1, value / ceiling);
}

function coverageFor(
  features: TaskRiskFeatures,
  relations: ReadonlySet<TaskRelationKind>,
): readonly RiskDimension[] {
  const coverage = new Set<RiskDimension>();
  if (features.entityMentions >= 2
    || relations.has("identity")
    || relations.has("part_of")
    || relations.has("control")) {
    coverage.add("entity_identity");
  }
  if (features.pronounMentions >= 4) {
    coverage.add("pronoun_resolution");
  }
  if (relations.has("part_of")) {
    coverage.add("part_whole");
  }
  for (const relation of relations) {
    if (relation !== "identity" && relation !== "part_of") {
      coverage.add(relation);
    }
  }
  return COVERAGE_ORDER.filter((dimension) => coverage.has(dimension));
}

function riskScore(
  features: TaskRiskFeatures,
  relations: ReadonlySet<TaskRelationKind>,
): number {
  const criticalRelationCount = [...relations]
    .filter((relation) => CRITICAL_RELATIONS.has(relation))
    .length;
  let score = (
    0.12 * normalizedCount(features.sourceTokens, 4_000)
    + 0.08 * normalizedCount(features.entityMentions, 8)
    + 0.08 * normalizedCount(features.pronounMentions, 8)
    + 0.22 * normalizedCount(relations.size, 4)
    + 0.14 * normalizedCount(features.remoteEvidenceDistance, 30)
    + 0.06 * normalizedCount(features.lockedTermOccurrences, 8)
    + (features.needsRevalidate ? 0.12 : 0)
    + 0.08 * normalizedCount(features.priorRepairs, 3)
    + 0.10 * normalizedCount(features.sourceAnomalies, 3)
  );
  if (criticalRelationCount > 0) {
    score = Math.max(score, 0.65);
  }
  if (features.needsRevalidate) {
    score = Math.max(score, 0.70);
  }
  if (features.sourceAnomalies > 0) {
    score = Math.max(score, 0.75);
  }
  return clampScore(score);
}

export function assessTaskRisk(
  rawFeatures: TaskRiskFeatures,
): TaskRiskAssessment {
  const features: TaskRiskFeatures = {
    sourceTokens: count(rawFeatures.sourceTokens, "source tokens"),
    entityMentions: count(rawFeatures.entityMentions, "entity mentions"),
    pronounMentions: count(rawFeatures.pronounMentions, "pronoun mentions"),
    relationKinds: rawFeatures.relationKinds,
    remoteEvidenceDistance: count(
      rawFeatures.remoteEvidenceDistance,
      "remote evidence distance",
    ),
    lockedTermOccurrences: count(
      rawFeatures.lockedTermOccurrences,
      "locked term occurrences",
    ),
    needsRevalidate: rawFeatures.needsRevalidate,
    priorRepairs: count(rawFeatures.priorRepairs, "prior repairs"),
    sourceAnomalies: count(rawFeatures.sourceAnomalies, "source anomalies"),
  };
  if (typeof features.needsRevalidate !== "boolean") {
    throw new TypeError("needs revalidate must be boolean");
  }
  const relations = relationKinds(features.relationKinds);
  const requiredCoverage = coverageFor(features, relations);
  const hasCriticalRelation = [...relations]
    .some((relation) => CRITICAL_RELATIONS.has(relation));
  const requiresRich = hasCriticalRelation
    || features.needsRevalidate
    || features.sourceAnomalies > 0
    || features.remoteEvidenceDistance >= 24;
  const requiresBalanced = requiredCoverage.length > 0
    || features.remoteEvidenceDistance > 0
    || features.lockedTermOccurrences >= 4
    || features.sourceTokens >= 2_000
    || features.priorRepairs > 0;
  const requiresHighEffort = hasCriticalRelation
    || features.needsRevalidate
    || features.sourceAnomalies > 0
    || features.priorRepairs >= 2;
  const requiresMediumEffort = requiredCoverage.length > 0
    || features.remoteEvidenceDistance > 0
    || features.lockedTermOccurrences >= 4
    || features.sourceTokens >= 2_000
    || features.priorRepairs > 0;

  const validatorSet = new Set<TaskRiskAssessment["requiredValidators"][number]>([
    "structure",
  ]);
  if (features.lockedTermOccurrences > 0) {
    validatorSet.add("terminology");
  }
  if (hasCriticalRelation
    || features.needsRevalidate
    || features.remoteEvidenceDistance > 0
    || features.priorRepairs > 0) {
    validatorSet.add("cross_block");
  }
  if (requiredCoverage.length > 0 || features.needsRevalidate) {
    validatorSet.add("knowledge_coverage");
  }

  return {
    schemaVersion: "folioloom-task-risk-1",
    score: riskScore(features, relations),
    requiredCoverage,
    minimumContextProfile: requiresRich
      ? "rich"
      : requiresBalanced ? "balanced" : "lean",
    minimumEffort: requiresHighEffort
      ? "high"
      : requiresMediumEffort ? "medium" : "low",
    requiredValidators: VALIDATOR_ORDER.filter(
      (validator) => validatorSet.has(validator),
    ),
  };
}
