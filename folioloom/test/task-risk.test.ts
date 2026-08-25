import assert from "node:assert/strict";
import test from "node:test";

import {
  assessTaskRisk,
  type TaskRiskFeatures,
} from "../src/fullbook/task-risk.js";

function plainFeatures(
  overrides: Partial<TaskRiskFeatures> = {},
): TaskRiskFeatures {
  return {
    sourceTokens: 650,
    entityMentions: 1,
    pronounMentions: 0,
    relationKinds: [],
    remoteEvidenceDistance: 0,
    lockedTermOccurrences: 0,
    needsRevalidate: false,
    priorRepairs: 0,
    sourceAnomalies: 0,
    ...overrides,
  };
}

test("entity control and timeline facts require rich context and high effort", () => {
  const result = assessTaskRisk({
    sourceTokens: 1_200,
    entityMentions: 4,
    pronounMentions: 3,
    relationKinds: ["control", "part_of", "timeline"],
    remoteEvidenceDistance: 30,
    lockedTermOccurrences: 1,
    needsRevalidate: false,
    priorRepairs: 0,
    sourceAnomalies: 0,
  });
  assert.equal(result.minimumContextProfile, "rich");
  assert.equal(result.minimumEffort, "high");
  assert.deepEqual([...result.requiredCoverage].sort(), [
    "control",
    "entity_identity",
    "part_whole",
    "timeline",
  ]);
  assert.deepEqual(result.requiredValidators, [
    "structure",
    "terminology",
    "cross_block",
    "knowledge_coverage",
  ]);
});

test("plain narration remains eligible for lean low execution", () => {
  const result = assessTaskRisk(plainFeatures());
  assert.equal(result.minimumContextProfile, "lean");
  assert.equal(result.minimumEffort, "low");
  assert.deepEqual(result.requiredCoverage, []);
  assert.deepEqual(result.requiredValidators, ["structure"]);
});

test("critical relation dimensions cannot be averaged below their hard gate", () => {
  for (const relation of [
    "control",
    "causality",
    "timeline",
    "character_knowledge",
  ] as const) {
    const result = assessTaskRisk(plainFeatures({
      sourceTokens: 1,
      relationKinds: [relation],
    }));
    assert.equal(result.minimumContextProfile, "rich");
    assert.equal(result.minimumEffort, "high");
    assert.ok(result.requiredCoverage.includes(relation));
    assert.ok(result.requiredValidators.includes("knowledge_coverage"));
  }
});

test("part-whole, identity, and pronouns produce deterministic coverage gates", () => {
  const result = assessTaskRisk(plainFeatures({
    entityMentions: 3,
    pronounMentions: 4,
    relationKinds: ["part_of", "identity", "part_of"],
  }));

  assert.deepEqual(result.requiredCoverage, [
    "entity_identity",
    "pronoun_resolution",
    "part_whole",
  ]);
  assert.equal(result.minimumContextProfile, "balanced");
  assert.equal(result.minimumEffort, "medium");
});

test("equal normalized features produce the same gate for every source language", () => {
  const normalizedByLanguage = ["en", "de", "ko", "ja"].map(() =>
    assessTaskRisk(plainFeatures({
      relationKinds: ["viewpoint"],
      remoteEvidenceDistance: 4,
    })));

  for (const result of normalizedByLanguage.slice(1)) {
    assert.deepEqual(result, normalizedByLanguage[0]);
  }
});

test("revalidation and source anomalies remain quality hard gates", () => {
  const revalidation = assessTaskRisk(plainFeatures({ needsRevalidate: true }));
  assert.equal(revalidation.minimumContextProfile, "rich");
  assert.equal(revalidation.minimumEffort, "high");
  assert.ok(revalidation.requiredValidators.includes("cross_block"));

  const anomaly = assessTaskRisk(plainFeatures({ sourceAnomalies: 1 }));
  assert.equal(anomaly.minimumContextProfile, "rich");
  assert.equal(anomaly.minimumEffort, "high");
});

test("task risk rejects invalid counts and unknown relation types", () => {
  for (const invalid of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assessTaskRisk(plainFeatures({ sourceTokens: invalid })),
      /source tokens/u,
    );
  }
  assert.throws(
    () => assessTaskRisk({
      ...plainFeatures(),
      relationKinds: ["ownership" as "control"],
    }),
    /unknown relation kind/u,
  );
});
