import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CommitCoordinator,
  type CommitPromotion,
} from "../src/fullbook/commit-coordinator.js";
import {
  canonicalJson,
  KnowledgeStore,
  transitionAllowed,
  type KnowledgeCandidate,
  type KnowledgeRevision,
} from "../src/knowledge/knowledge-store.js";
import {
  createKnowledgeSnapshot,
} from "../src/knowledge/snapshot.js";

function candidate(
  recordId: string,
  normalizedSubject: string,
  payload: unknown,
  kind = "term",
): KnowledgeCandidate {
  return { recordId, normalizedSubject, kind, payload };
}

function bindPair(coordinator: CommitCoordinator): string {
  const snapshot = coordinator.snapshotForNextWave();
  coordinator.bindWindow({ ordinal: 0, windowId: "window-0", snapshot });
  coordinator.bindWindow({ ordinal: 1, windowId: "window-1", snapshot });
  return snapshot.id;
}

function stage(
  coordinator: CommitCoordinator,
  ordinal: number,
  snapshotId: string,
  candidates: readonly KnowledgeCandidate[],
): void {
  coordinator.stage({
    runId: coordinator.runId,
    windowId: `window-${ordinal}`,
    ordinal,
    snapshotId,
    candidates,
  });
}

function rehashRevision(
  revision: KnowledgeRevision,
  changes: Partial<Omit<KnowledgeRevision, "revisionId">>,
): KnowledgeRevision {
  const { revisionId: _oldId, ...oldContent } = revision;
  const content = { ...oldContent, ...changes };
  return {
    revisionId: createHash("sha256").update(canonicalJson(content)).digest("hex"),
    ...content,
  };
}

test("parallel windows share one immutable snapshot and promote in ordinal order", () => {
  const coordinator = new CommitCoordinator("run-reverse");
  const snapshotId = bindPair(coordinator);

  stage(coordinator, 1, snapshotId, [candidate("c1", "term", "乙")]);
  assert.deepEqual(coordinator.promoteReady(), []);

  stage(coordinator, 0, snapshotId, [candidate("c0", "term", "甲")]);
  assert.deepEqual(coordinator.promoteReady(), ["window-0", "window-1"]);
  assert.equal(
    coordinator.activeKnowledge("term", "term")?.status,
    "needs_revalidate",
  );

  const next = coordinator.snapshotForNextWave();
  assert.notEqual(next.id, snapshotId);
  assert.equal(coordinator.snapshot(snapshotId)?.revisions.length, 0);
});

test("stage completion order cannot change revisions or the resulting snapshot", () => {
  function completed(order: readonly number[]) {
    const coordinator = new CommitCoordinator("run-order");
    const snapshotId = bindPair(coordinator);
    const values = [
      candidate("candidate-a", "Name", { target: "甲", note: "a" }),
      candidate("candidate-b", "Name", { note: "b", target: "乙" }),
    ];
    for (const ordinal of order) {
      stage(coordinator, ordinal, snapshotId, [values[ordinal]]);
      coordinator.promoteReady();
    }
    return {
      revisions: coordinator.knowledge.listRevisions(),
      snapshot: coordinator.snapshotForNextWave(),
    };
  }

  assert.deepEqual(completed([0, 1]), completed([1, 0]));
});

test("same-value candidates merge while conflicting values need revalidation", () => {
  const same = new CommitCoordinator("run-same");
  const sameSnapshot = bindPair(same);
  stage(same, 0, sameSnapshot, [
    candidate("same-b", "Name", { spelling: "阿尔法", notes: { b: 2, a: 1 } }),
  ]);
  stage(same, 1, sameSnapshot, [
    candidate("same-a", "Name", { notes: { a: 1, b: 2 }, spelling: "阿尔法" }),
  ]);
  assert.deepEqual(same.promoteReady(), ["window-0", "window-1"]);
  const merged = same.activeKnowledge("Name", "term");
  assert.equal(merged?.status, "active");
  assert.deepEqual(merged?.candidateIds, ["same-a", "same-b"]);
  assert.equal(merged?.alternatives.length, 1);

  const conflict = new CommitCoordinator("run-conflict");
  const conflictSnapshot = bindPair(conflict);
  stage(conflict, 0, conflictSnapshot, [candidate("left", "Name", "甲")]);
  stage(conflict, 1, conflictSnapshot, [candidate("right", "Name", "乙")]);
  conflict.promoteReady();
  const active = conflict.activeKnowledge("Name", "term");
  assert.equal(active?.status, "needs_revalidate");
  assert.deepEqual(active?.alternatives, ["乙", "甲"]);
  assert.deepEqual(conflict.knowledge.listRevisions().map((item) => item.revision), [1, 2]);
});

test("knowledge transitions are explicit and revisions are append-only per active key", () => {
  assert.equal(transitionAllowed("candidate", "provisional"), true);
  assert.equal(transitionAllowed("provisional", "active"), true);
  assert.equal(transitionAllowed("active", "needs_revalidate"), true);
  assert.equal(transitionAllowed("superseded", "active"), false);

  const store = new KnowledgeStore();
  const first = store.appendRevision({
    normalizedSubject: "same",
    kind: "term",
    payload: "甲",
    status: "candidate",
    candidateIds: ["c0"],
    sourceWindowIds: ["window-0"],
  });
  const second = store.appendRevision({
    normalizedSubject: "same",
    kind: "term",
    payload: "甲",
    status: "provisional",
    candidateIds: ["c0"],
    sourceWindowIds: ["window-0"],
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(first.status, "candidate");
  assert.equal(store.activeKnowledge("same", "term")?.revisionId, second.revisionId);
  assert.throws(() => store.appendRevision({
    normalizedSubject: "same",
    kind: "term",
    payload: "甲",
    status: "candidate",
    candidateIds: ["c0"],
    sourceWindowIds: ["window-0"],
  }), /transition/i);
});

test("snapshots are deeply immutable and hash canonical content", () => {
  const storeA = new KnowledgeStore();
  storeA.reconcileCandidates([
    candidate("b", "Zulu", { target: "乙", metadata: { z: 2, a: 1 } }),
    candidate("a", "Alpha", { metadata: { a: 1, z: 2 }, target: "甲" }),
  ], "window-0");
  const storeB = new KnowledgeStore();
  storeB.reconcileCandidates([
    candidate("a", "Alpha", { target: "甲", metadata: { z: 2, a: 1 } }),
    candidate("b", "Zulu", { metadata: { a: 1, z: 2 }, target: "乙" }),
  ], "window-0");

  const left = createKnowledgeSnapshot("run-hash", storeA.listRevisions());
  const right = createKnowledgeSnapshot("run-hash", [...storeB.listRevisions()].reverse());
  assert.equal(left.id, left.contentHash);
  assert.equal(left.id, right.id);
  assert.deepEqual(left, right);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.revisions), true);
  assert.equal(Object.isFrozen(left.revisions[0]?.payload), true);
  assert.throws(() => {
    (left.revisions[0]?.payload as { target: string }).target = "mutated";
  }, TypeError);
});

test("authority-bearing revisions and snapshots are deterministic", () => {
  function completed(ownedFields: readonly string[]) {
    const store = new KnowledgeStore();
    store.appendRevision({
      normalizedSubject: "archon",
      kind: "term_sense",
      payload: { target: "阁下", note: "manual" },
      status: "active",
      authority: {
        origin: "manual",
        scope: "book",
        ownedFields,
      },
    });
    store.reconcileCandidates([candidate(
      "candidate-1",
      "archon",
      { note: "model", target: "执政官" },
      "term_sense",
    )], "window-1");
    return {
      revisions: store.listRevisions(),
      snapshot: createKnowledgeSnapshot("run-authority", store.projectableRevisions()),
    };
  }

  const left = completed(["/target", "/note", "/target"]);
  const right = completed(["/note", "/target"]);
  assert.deepEqual(left, right);
  assert.equal(left.revisions[1]?.status, "active");
  assert.deepEqual(left.revisions[1]?.payload, {
    note: "manual",
    target: "阁下",
  });
  assert.deepEqual(
    new KnowledgeStore(left.revisions).listRevisions(),
    left.revisions,
  );
});

test("snapshots project only the latest translator-visible revision per active key", () => {
  const store = new KnowledgeStore();
  store.appendRevision({
    normalizedSubject: "alpha", kind: "term", payload: "候选",
    status: "candidate", candidateIds: ["alpha-c"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "alpha", kind: "term", payload: "暂定",
    status: "provisional", candidateIds: ["alpha-p"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "beta", kind: "term", payload: "甲",
    status: "active", candidateIds: ["beta-a"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "delta", kind: "term", payload: { alternatives: ["丙", "丁"] },
    alternatives: ["丁", "丙"], status: "needs_revalidate",
    candidateIds: ["delta-a", "delta-b"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "gamma", kind: "fact", payload: "仅此语境",
    status: "contextual", candidateIds: ["gamma"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "hidden", kind: "term", payload: "未晋升",
    status: "candidate", candidateIds: ["hidden"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "retired", kind: "term", payload: "旧值",
    status: "active", candidateIds: ["retired"], sourceWindowIds: ["seed"],
  });
  store.appendRevision({
    normalizedSubject: "retired", kind: "term", payload: "旧值",
    status: "superseded", candidateIds: ["retired"], sourceWindowIds: ["seed"],
  });

  assert.equal(store.listRevisions().length, 8);
  assert.deepEqual(store.projectableRevisions().map((item) => [
    item.normalizedSubject,
    item.status,
  ]), [
    ["alpha", "provisional"],
    ["beta", "active"],
    ["delta", "needs_revalidate"],
    ["gamma", "contextual"],
  ]);

  const coordinator = new CommitCoordinator("run-projected", store);
  const initial = coordinator.snapshotForNextWave();
  assert.deepEqual(
    initial.revisions.map((item) => item.revisionId),
    store.projectableRevisions().map((item) => item.revisionId),
  );
  coordinator.bindWindow({ ordinal: 0, windowId: "window-0", snapshot: initial });
  stage(coordinator, 0, initial.id, [candidate("beta-conflict", "beta", "乙")]);
  assert.deepEqual(coordinator.promoteReady(), ["window-0"]);
  const next = coordinator.snapshotForNextWave();
  assert.equal(next.revisions.length, 4);
  assert.deepEqual(next.revisions.filter((item) => item.normalizedSubject === "beta")
    .map((item) => item.status), ["needs_revalidate"]);
  assert.equal(next.revisions.some((item) =>
    item.status === "candidate" || item.status === "superseded"), false);
  assert.equal(coordinator.knowledge.listRevisions().length, 9);
});

test("hydration validates and canonicalizes the complete append-only chain", () => {
  const seed = new KnowledgeStore();
  seed.appendRevision({
    normalizedSubject: "name", kind: "term", payload: { target: "甲" },
    status: "candidate", candidateIds: ["c0"], sourceWindowIds: ["w0"],
  });
  seed.appendRevision({
    normalizedSubject: "name", kind: "term", payload: { target: "甲" },
    status: "provisional", candidateIds: ["c0"], sourceWindowIds: ["w0"],
  });
  seed.appendRevision({
    normalizedSubject: "name", kind: "term", payload: { target: "甲" },
    status: "active", candidateIds: ["c1", "c0"], sourceWindowIds: ["w1", "w0"],
  });
  const legal = seed.listRevisions();
  const hydrated = new KnowledgeStore([...legal].reverse());
  assert.deepEqual(hydrated.listRevisions(), legal);
  assert.equal(Object.isFrozen(hydrated.listRevisions()[0]), true);
  assert.deepEqual(hydrated.fork().listRevisions(), legal);
  const multiKey = new KnowledgeStore();
  multiKey.appendRevision({
    normalizedSubject: "zeta", kind: "term", payload: "末", status: "active",
  });
  multiKey.appendRevision({
    normalizedSubject: "alpha", kind: "term", payload: "首", status: "active",
  });
  assert.deepEqual(multiKey.fork().listRevisions(), multiKey.listRevisions());

  const first = legal[0] as KnowledgeRevision;
  const second = legal[1] as KnowledgeRevision;
  const revision99 = rehashRevision(second, { revision: 99 });
  assert.throws(() => new KnowledgeStore([first, revision99]), /continuous|revision/i);
  assert.throws(() => new KnowledgeStore([
    first,
    { ...second, revisionId: "0".repeat(64) },
  ]), /revision.*id|hash/i);
  const illegalTransition = rehashRevision(second, { status: "candidate" });
  assert.throws(() => new KnowledgeStore([first, illegalTransition]), /transition/i);
  assert.throws(() => new KnowledgeStore([first, first]), /duplicate|revision/i);
  const gap = rehashRevision(second, { revision: 3 });
  assert.throws(() => new KnowledgeStore([first, gap]), /continuous|revision/i);
});

test("hydration rejects malformed runtime revision fields", () => {
  const seed = new KnowledgeStore();
  const valid = seed.appendRevision({
    normalizedSubject: "name", kind: "term", payload: "甲", status: "active",
    candidateIds: ["c0"], sourceWindowIds: ["w0"],
  });
  const malformed: unknown[] = [
    { ...valid, status: "invented" },
    { ...valid, normalizedSubject: 7 },
    { ...valid, kind: [] },
    { ...valid, candidateIds: "c0" },
    { ...valid, candidateIds: [7] },
    { ...valid, sourceWindowIds: [null] },
    { ...valid, alternatives: "甲" },
    { ...valid, alternatives: [] },
    { ...valid, payload: undefined },
  ];
  for (const revision of malformed) {
    assert.throws(
      () => new KnowledgeStore([revision as KnowledgeRevision]),
      Error,
    );
  }
});

test("coordinator rejects cross-run and unknown snapshots plus duplicate stages", () => {
  const first = new CommitCoordinator("run-a");
  const second = new CommitCoordinator("run-b");
  const foreign = second.snapshotForNextWave();
  assert.throws(() => first.bindWindow({
    ordinal: 0,
    windowId: "window-0",
    snapshot: foreign,
  }), /another run/i);

  const local = first.snapshotForNextWave();
  first.bindWindow({ ordinal: 0, windowId: "window-0", snapshot: local });
  assert.throws(() => first.stage({
    runId: "run-a",
    windowId: "window-0",
    ordinal: 0,
    snapshotId: "unknown-snapshot",
    candidates: [],
  }), /unknown snapshot/i);
  assert.throws(() => first.stage({
    runId: "run-b",
    windowId: "window-0",
    ordinal: 0,
    snapshotId: local.id,
    candidates: [],
  }), /run mismatch/i);

  stage(first, 0, local.id, []);
  assert.throws(() => stage(first, 0, local.id, []), /already staged/i);
});

test("a promotion failure cannot skip the failing ordinal", () => {
  const attempts: number[] = [];
  let failOnce = true;
  const coordinator = new CommitCoordinator("run-failure", undefined, {
    commitPromotion(promotion: CommitPromotion) {
      attempts.push(promotion.ordinal);
      if (promotion.ordinal === 0 && failOnce) {
        failOnce = false;
        throw new Error("injected promotion failure");
      }
    },
  });
  const snapshotId = bindPair(coordinator);
  stage(coordinator, 1, snapshotId, [candidate("later", "Later", "乙")]);
  stage(coordinator, 0, snapshotId, [candidate("first", "First", "甲")]);

  assert.throws(() => coordinator.promoteReady(), /injected promotion failure/);
  assert.deepEqual(attempts, [0]);
  assert.equal(coordinator.activeKnowledge("Later", "term"), undefined);
  assert.deepEqual(coordinator.promoteReady(), ["window-0", "window-1"]);
  assert.deepEqual(attempts, [0, 0, 1]);
});

test("a submission-gate retry releases the bound ordinal for a fresh snapshot", () => {
  const runId = "run-gate-retry";
  const initial = createKnowledgeSnapshot(runId, []);
  let retry = true;
  const coordinator = new CommitCoordinator(
    runId,
    new KnowledgeStore(),
    {
      commitPromotion: () => {
        if (retry) return "retry_latest_snapshot";
        return "promoted";
      },
    },
    initial,
  );
  coordinator.bindWindow({
    ordinal: 0,
    windowId: "window-0",
    snapshot: initial,
  });
  coordinator.stage({
    runId,
    ordinal: 0,
    windowId: "window-0",
    snapshotId: initial.id,
    candidates: [],
  });

  assert.deepEqual(coordinator.promoteReady(), []);
  assert.deepEqual(coordinator.takeRetryWindowIds(), ["window-0"]);
  assert.deepEqual(coordinator.takeRetryWindowIds(), []);

  retry = false;
  coordinator.stage({
    runId,
    ordinal: 0,
    windowId: "window-0",
    snapshotId: coordinator.snapshotForNextWave().id,
    candidates: [],
  });
  assert.deepEqual(coordinator.promoteReady(), ["window-0"]);
});

test("windows must be bound with continuous ordinals and matching identities", () => {
  const coordinator = new CommitCoordinator("run-continuous");
  const snapshot = coordinator.snapshotForNextWave();
  assert.throws(() => coordinator.bindWindow({
    ordinal: 1,
    windowId: "window-1",
    snapshot,
  }), /continuous ordinal/i);
  coordinator.bindWindow({ ordinal: 0, windowId: "window-0", snapshot });
  assert.throws(() => coordinator.stage({
    runId: "run-continuous",
    windowId: "window-0",
    ordinal: 1,
    snapshotId: snapshot.id,
    candidates: [],
  }), /ordinal/i);
});

test("coordinator resumes from the exact persisted immutable snapshot", () => {
  const knowledge = new KnowledgeStore();
  knowledge.reconcileCandidates([candidate("seed", "Name", "甲")], "window-seed");
  const persisted = createKnowledgeSnapshot(
    "run-resume",
    knowledge.projectableRevisions(),
    "snapshot-before-resume",
  );
  const coordinator = new CommitCoordinator(
    "run-resume",
    new KnowledgeStore(persisted.revisions),
    undefined,
    persisted,
  );
  assert.equal(coordinator.snapshotForNextWave().id, persisted.id);
  coordinator.bindWindow({ ordinal: 0, windowId: "window-next", snapshot: persisted });
});
