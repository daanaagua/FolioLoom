import { createHash } from "node:crypto";

import {
  canonicalClone,
  canonicalJson,
  deepFreeze,
  type KnowledgeRevision,
} from "./knowledge-store.js";

export interface KnowledgeSnapshot {
  readonly schemaVersion: "v5-knowledge-snapshot-1";
  readonly runId: string;
  readonly parentSnapshotId: string | null;
  readonly id: string;
  readonly contentHash: string;
  readonly revisions: readonly KnowledgeRevision[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

export function createKnowledgeSnapshot(
  runId: string,
  revisions: readonly KnowledgeRevision[],
  parentSnapshotId: string | null = null,
): KnowledgeSnapshot {
  requireIdentifier(runId, "runId");
  if (parentSnapshotId !== null) {
    requireIdentifier(parentSnapshotId, "parentSnapshotId");
  }
  const sorted = revisions
    .map((revision) => canonicalClone(revision))
    .sort((left, right) =>
      compareText(left.normalizedSubject, right.normalizedSubject)
      || compareText(left.kind, right.kind)
      || compareText(left.revisionId, right.revisionId));
  const content = {
    schemaVersion: "v5-knowledge-snapshot-1" as const,
    runId,
    parentSnapshotId,
    revisions: sorted,
  };
  const contentHash = createHash("sha256")
    .update(canonicalJson(content))
    .digest("hex");
  return deepFreeze({
    ...content,
    id: contentHash,
    contentHash,
  });
}
