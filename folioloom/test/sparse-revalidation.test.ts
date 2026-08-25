import assert from "node:assert/strict";
import test from "node:test";

import {
  conceptFromAnchor,
  reviseConcept,
} from "../src/knowledge/lexical-concept.js";
import {
  evaluateRevalidationBindings,
  evaluateStagedConceptBindings,
  planSparseRevalidation,
  type ActiveTranslationDependency,
} from "../src/knowledge/sparse-revalidation.js";

function oldConcept() {
  return conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "秘书主任",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
  });
}

function currentConcept() {
  return reviseConcept(oldConcept(), {
    canonicalTarget: "主事",
    allowedRealizations: ["主事", "主事先生"],
  });
}

function dependency(
  translationId: number,
  blockId: string,
  revisionId: string,
  renderFingerprint: string,
): ActiveTranslationDependency {
  return {
    translationId,
    blockId,
    snapshotId: "snapshot-old",
    bindings: [{
      conceptId: currentConcept().conceptId,
      appliedRevisionId: revisionId,
      appliedRenderFingerprint: renderFingerprint,
    }],
  };
}

test("sparse revalidation selects only active stale bindings at actual occurrences", () => {
  const previous = oldConcept();
  const current = currentConcept();
  const plan = planSparseRevalidation({
    concepts: [current],
    occurrences: [
      {
        conceptId: current.conceptId,
        blockId: "block-0",
        sourceSpans: [{ start: 0, end: 9, sourceForm: "Prokurist" }],
      },
      {
        conceptId: current.conceptId,
        blockId: "block-2",
        sourceSpans: [{ start: 4, end: 13, sourceForm: "Prokurist" }],
      },
      {
        conceptId: current.conceptId,
        blockId: "block-3",
        sourceSpans: [{ start: 8, end: 17, sourceForm: "Prokurist" }],
      },
    ],
    translations: [
      dependency(10, "block-0", previous.revisionId, previous.renderFingerprint),
      {
        translationId: 11,
        blockId: "block-1",
        snapshotId: "snapshot-old",
        bindings: [],
      },
      dependency(12, "block-2", current.revisionId, current.renderFingerprint),
      dependency(13, "block-3", previous.revisionId, previous.renderFingerprint),
    ],
    toSnapshotId: "snapshot-new",
  });

  assert.deepEqual(
    plan.map((candidate) => candidate.blockId),
    ["block-0", "block-3"],
  );
  assert.ok(plan.every((candidate) =>
    candidate.conceptIds.length === 1
    && candidate.conceptIds[0] === current.conceptId));
  assert.ok(plan.every((candidate) =>
    candidate.fromSnapshotId === "snapshot-old"
    && candidate.toSnapshotId === "snapshot-new"
    && /^[a-f0-9]{64}$/u.test(candidate.changeSetHash)));
});

test("sparse revalidation selects an occurrence hit that has no prior binding", () => {
  const current = currentConcept();
  const plan = planSparseRevalidation({
    concepts: [current],
    occurrences: [{
      conceptId: current.conceptId,
      blockId: "block-0",
      sourceSpans: [{ start: 0, end: 9, sourceForm: "Prokurist" }],
    }],
    translations: [{
      translationId: 10,
      blockId: "block-0",
      snapshotId: "snapshot-before-concept",
      bindings: [],
    }, {
      translationId: 11,
      blockId: "block-1",
      snapshotId: "snapshot-before-concept",
      bindings: [],
    }],
    toSnapshotId: "snapshot-with-concept",
  });

  assert.deepEqual(plan.map((candidate) => ({
    translationId: candidate.translationId,
    blockId: candidate.blockId,
    conceptIds: candidate.conceptIds,
  })), [{
    translationId: 10,
    blockId: "block-0",
    conceptIds: [current.conceptId],
  }]);
});

test("metadata-only concept revisions do not invalidate translations", () => {
  const previous = oldConcept();
  const confidenceOnly = reviseConcept(previous, { confidence: 0.99 });
  const plan = planSparseRevalidation({
    concepts: [confidenceOnly],
    occurrences: [{
      conceptId: confidenceOnly.conceptId,
      blockId: "block-0",
      sourceSpans: [{ start: 0, end: 9, sourceForm: "Prokurist" }],
    }],
    translations: [
      dependency(
        10,
        "block-0",
        previous.revisionId,
        previous.renderFingerprint,
      ),
    ],
    toSnapshotId: "snapshot-new",
  });
  assert.deepEqual(plan, []);
});

test("multiple concept changes merge into one stable task per translation", () => {
  const previousRole = oldConcept();
  const currentRole = currentConcept();
  const previousName = conceptFromAnchor({
    sourceForm: "Gregor",
    target: "格里高尔",
    mode: "stable",
    semanticClass: "proper_name",
    confidence: 0.95,
  });
  const currentName = reviseConcept(previousName, {
    canonicalTarget: "格里戈尔",
  });
  const input = {
    concepts: [currentRole, currentName],
    occurrences: [
      {
        conceptId: currentRole.conceptId,
        blockId: "block-0",
        sourceSpans: [{ start: 0, end: 9, sourceForm: "Prokurist" }],
      },
      {
        conceptId: currentName.conceptId,
        blockId: "block-0",
        sourceSpans: [{ start: 10, end: 16, sourceForm: "Gregor" }],
      },
    ],
    translations: [{
      translationId: 10,
      blockId: "block-0",
      snapshotId: "snapshot-old",
      bindings: [
        {
          conceptId: currentName.conceptId,
          appliedRevisionId: previousName.revisionId,
          appliedRenderFingerprint: previousName.renderFingerprint,
        },
        {
          conceptId: currentRole.conceptId,
          appliedRevisionId: previousRole.revisionId,
          appliedRenderFingerprint: previousRole.renderFingerprint,
        },
      ],
    }],
    toSnapshotId: "snapshot-new",
  } satisfies Parameters<typeof planSparseRevalidation>[0];
  const forward = planSparseRevalidation(input);
  const reversed = planSparseRevalidation({
    ...input,
    concepts: [...input.concepts].reverse(),
    occurrences: [...input.occurrences].reverse(),
  });
  assert.equal(forward.length, 1);
  assert.deepEqual(forward[0]?.conceptIds, [
    currentName.conceptId,
    currentRole.conceptId,
  ].sort());
  assert.equal(forward[0]?.changeSetHash, reversed[0]?.changeSetHash);
});

test("the submission gate upgrades allowed surfaces and rejects obsolete ones", () => {
  const previous = oldConcept();
  const current = currentConcept();
  const binding = (targetSurface: string) => ({
    conceptId: current.conceptId,
    appliedRevisionId: previous.revisionId,
    appliedRenderFingerprint: previous.renderFingerprint,
    termUsages: [{
      occurrenceId: "occurrence-0",
      blockId: "block-0",
      conceptId: current.conceptId,
      sourceForm: "Prokurist",
      sourceStart: 0,
      sourceEnd: 9,
      discourseRole: "narrative" as const,
      targetSurface,
    }],
  });

  const compatible = evaluateStagedConceptBindings({
    concepts: [current],
    bindings: [binding("主事先生")],
  });
  assert.equal(compatible.status, "compatible");
  assert.deepEqual(compatible.updates, [{
    conceptId: current.conceptId,
    revisionId: current.revisionId,
    renderFingerprint: current.renderFingerprint,
  }]);

  const obsolete = evaluateStagedConceptBindings({
    concepts: [current],
    bindings: [binding("秘书主任")],
  });
  assert.equal(obsolete.status, "retry_latest_snapshot");
  assert.deepEqual(obsolete.incompatibleConceptIds, [current.conceptId]);
});

test("revalidation action distinguishes noop, one-surface repair, and substantive retranslation", () => {
  const previous = oldConcept();
  const current = currentConcept();
  const usage = (targetSurface: string) => ({
    occurrenceId: "occurrence-0",
    blockId: "block-0",
    conceptId: current.conceptId,
    sourceForm: "Prokurist",
    sourceStart: 0,
    sourceEnd: 9,
    discourseRole: "narrative" as const,
    targetSurface,
  });
  const state = (
    currentConceptRevision: ReturnType<typeof currentConcept>,
    targetSurface: string,
  ) => [{
    conceptId: current.conceptId,
    appliedConcept: previous,
    currentConcept: currentConceptRevision,
    termUsages: [usage(targetSurface)],
  }];

  assert.deepEqual(
    evaluateRevalidationBindings(state(current, "主事先生")),
    { action: "noop", conceptIds: [current.conceptId] },
  );
  assert.deepEqual(
    evaluateRevalidationBindings(state(current, "秘书主任")),
    { action: "repair", conceptIds: [current.conceptId] },
  );

  const policyChange = reviseConcept(previous, {
    canonicalTarget: "主事",
    allowedRealizations: ["主事"],
    policy: "locked",
  });
  assert.deepEqual(
    evaluateRevalidationBindings(state(policyChange, "秘书主任")),
    { action: "retranslate", conceptIds: [current.conceptId] },
  );
});

test("large sparse planning ignores unrelated changes and selects ten affected blocks", () => {
  const previous = conceptFromAnchor({
    sourceForm: "ScaleTerm0999",
    target: "旧译名",
    mode: "stable",
    semanticClass: "technical_term",
    confidence: 0.95,
  });
  const current = reviseConcept(previous, {
    canonicalTarget: "新译名",
  });
  const unrelated = reviseConcept(conceptFromAnchor({
    sourceForm: "AbsentScaleTerm",
    target: "无关旧译",
    mode: "stable",
    semanticClass: "technical_term",
    confidence: 0.95,
  }), {
    canonicalTarget: "无关新译",
  });
  const occurrences = Array.from({ length: 10 }, (_, index) => ({
    conceptId: current.conceptId,
    blockId: `scale-block-${index.toString().padStart(3, "0")}`,
    sourceSpans: [{
      start: 14,
      end: 27,
      sourceForm: "ScaleTerm0999",
    }],
  }));
  const translations: ActiveTranslationDependency[] = Array.from(
    { length: 600 },
    (_, index) => ({
      translationId: index + 1,
      blockId: `scale-block-${index.toString().padStart(3, "0")}`,
      snapshotId: "snapshot-old",
      bindings: index < 10
        ? [{
            conceptId: current.conceptId,
            appliedRevisionId: previous.revisionId,
            appliedRenderFingerprint: previous.renderFingerprint,
          }]
        : [],
    }),
  );

  const unrelatedTasks = planSparseRevalidation({
    concepts: [unrelated],
    occurrences,
    translations,
    toSnapshotId: "snapshot-new",
  });
  const affectedTasks = planSparseRevalidation({
    concepts: [current],
    occurrences,
    translations,
    toSnapshotId: "snapshot-new",
  });

  assert.equal(unrelatedTasks.length, 0);
  assert.equal(affectedTasks.length, 10);
  assert.deepEqual(
    affectedTasks.map((task) => task.blockId),
    Array.from(
      { length: 10 },
      (_, index) => `scale-block-${index.toString().padStart(3, "0")}`,
    ),
  );
});
