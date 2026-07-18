import { createHash } from "node:crypto";
import type { V4Block } from "./domain/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createKnowledgeSnapshot, type KnowledgeSnapshot } from "./knowledge/snapshot.js";
import {
  canonicalJson,
  KnowledgeStore,
  type KnowledgeRevision,
} from "./knowledge/knowledge-store.js";
import { blockId as losslessBlockId } from "./source/block-builder.js";
import { scalarLength } from "./source/types.js";
import type { BookStore } from "./storage/book-store.js";
import type { LosslessBookStore } from "./storage/lossless-book-store.js";

export interface PilotTranslation {
  blockId: string;
  globalIndex: number;
  chapterId: string | null;
  chapterTitle: string | null;
  sourceText: string;
  text: string;
}

export function renderTranslation(translations: readonly PilotTranslation[]): string {
  const lines: string[] = [];
  let chapter: string | null | undefined;
  for (const item of translations) {
    if (item.chapterId !== chapter) {
      chapter = item.chapterId;
      lines.push(
        lines.length === 0 ? "" : "\n",
        `# ${item.chapterTitle ?? item.chapterId ?? "Untitled"}`,
        "",
      );
    }
    lines.push(item.text.trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export function renderBilingual(translations: readonly PilotTranslation[]): string {
  const lines: string[] = [];
  for (const item of translations) {
    lines.push(
      `## ${item.blockId} · global ${item.globalIndex}`,
      "",
      "[SOURCE]",
      item.sourceText.trim(),
      "",
      "[TRANSLATION]",
      item.text.trim(),
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

export function joinTranslations(
  blocks: readonly V4Block[],
  translations: ReadonlyMap<string, string>,
): PilotTranslation[] {
  return blocks
    .filter((block) => translations.has(block.id))
    .map((block) => ({
      blockId: block.id,
      globalIndex: block.globalIndex,
      chapterId: block.chapterId,
      chapterTitle: block.chapterTitle,
      sourceText: block.sourceText,
      text: translations.get(block.id) as string,
    }));
}

export interface BookArtifactPaths {
  translation: string;
  bilingual: string;
  audit: string;
  metrics: string;
}

export interface LosslessBookArtifactPaths extends BookArtifactPaths {
  translationLineage: string;
  bilingualLineage: string;
  auditLineage: string;
  epub?: string;
}

export interface LosslessBookLineageBlock {
  ordinal: number;
  blockId: string;
  sourceHash: string;
  translationRevision: number | null;
}

export interface LosslessBookLineage {
  schema: "v5-book-lineage-1";
  runId: string;
  sourceVersion: string;
  protocolVersion: string;
  modelId: string;
  runMetadata: unknown;
  complete: boolean;
  missingBlockIds: string[];
  blocks: LosslessBookLineageBlock[];
}

export function bookArtifactFileNames(complete: boolean): BookArtifactPaths {
  const qualifier = complete ? "" : ".partial";
  return {
    translation: `v5_book_translation${qualifier}.txt`,
    bilingual: `v5_book_bilingual${qualifier}.txt`,
    audit: `v5_book_audit${qualifier}.json`,
    metrics: `v5_book_metrics${qualifier}.json`,
  };
}

export interface LosslessBookAuditReport {
  schema: "v5-book-store-audit-1";
  runId: string;
  sourceVersion: string;
  protocolVersion: string;
  modelId: string;
  runStatus: string;
  runMetadata: unknown;
  complete: boolean;
  totalBlockCount: number;
  translatedBlockCount: number;
  missingBlockIds: string[];
  missingBlockCount: number;
  incidentCodes: string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function auditLosslessBookStore(
  store: LosslessBookStore,
  runId: string,
): LosslessBookAuditReport {
  const state = store.auditState(runId);
  const incidents: string[] = [];
  const blocks = [...state.blocks].sort((left, right) => (
    left.globalIndex - right.globalIndex || left.blockId.localeCompare(right.blockId)
  ));
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));
  let cursor = 0;
  const canonical = createHash("sha256");
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.sourceVersion !== state.sourceVersion) {
      incidents.push("SOURCE_VERSION_MISMATCH");
    }
    if (block.globalIndex !== index) {
      incidents.push("BLOCK_ORDER_INVALID");
    }
    if (block.canonicalStart > cursor) {
      incidents.push("SOURCE_SPAN_GAP");
    } else if (block.canonicalStart < cursor) {
      incidents.push("SOURCE_SPAN_OVERLAP");
    }
    if (block.canonicalEnd <= block.canonicalStart) {
      incidents.push("SOURCE_SPAN_INVALID");
    }
    if (scalarLength(block.sourceText) !== block.canonicalEnd - block.canonicalStart) {
      incidents.push("SOURCE_TEXT_LENGTH_MISMATCH");
    }
    if (sha256(block.sourceText) !== block.sourceHash) {
      incidents.push("SOURCE_HASH_MISMATCH");
    }
    if (losslessBlockId(
      state.sourceVersion,
      block.canonicalStart,
      block.canonicalEnd,
      block.sourceText,
    ) !== block.blockId) {
      incidents.push("BLOCK_ID_MISMATCH");
    }
    cursor = Math.max(cursor, block.canonicalEnd);
    canonical.update(block.sourceText, "utf8");
  }
  if (cursor < state.canonicalChars) {
    incidents.push("SOURCE_SPAN_GAP");
  }
  if (cursor > state.canonicalChars) {
    incidents.push("SOURCE_SPAN_INVALID");
  }
  if (canonical.digest("hex") !== state.canonicalSha256) {
    incidents.push("CANONICAL_HASH_MISMATCH");
  }

  const windowById = new Map(state.windows.map((window) => [window.windowId, window]));
  const membershipsByWindow = new Map<string, typeof state.memberships>();
  const membershipByBlock = new Map<string, string>();
  for (const membership of state.memberships) {
    if (membership.runId !== state.runId
      || membership.sourceVersion !== state.sourceVersion
      || !windowById.has(membership.windowId)
      || !blockById.has(membership.blockId)) {
      incidents.push("BLOCK_MEMBERSHIP_INVALID");
    }
    if (membershipByBlock.has(membership.blockId)) {
      incidents.push("BLOCK_MEMBERSHIP_INVALID");
    }
    membershipByBlock.set(membership.blockId, membership.windowId);
    const members = membershipsByWindow.get(membership.windowId) ?? [];
    members.push(membership);
    membershipsByWindow.set(membership.windowId, members);
  }
  const sourceOrder: string[] = [];
  const orderedWindows = [...state.windows].sort((left, right) => left.ordinal - right.ordinal);
  for (let ordinal = 0; ordinal < orderedWindows.length; ordinal += 1) {
    const window = orderedWindows[ordinal]!;
    if (window.ordinal !== ordinal) {
      incidents.push("WINDOW_MEMBERSHIP_INVALID");
    }
    const members = [...(membershipsByWindow.get(window.windowId) ?? [])]
      .sort((left, right) => left.position - right.position);
    if (members.some((member, index) => member.position !== index)) {
      incidents.push("BLOCK_MEMBERSHIP_INVALID");
    }
    const memberBlocks = members
      .map((member) => blockById.get(member.blockId))
      .filter((block) => block !== undefined);
    if (memberBlocks.reduce((total, block) => total + block.tokenCount, 0) !== window.sourceTokens
      || memberBlocks.reduce(
        (total, block) => total + block.canonicalEnd - block.canonicalStart,
        0,
      ) !== window.sourceChars) {
      incidents.push("WINDOW_MEMBERSHIP_INVALID");
    }
    sourceOrder.push(...members.map((member) => member.blockId));
  }
  if (sourceOrder.length !== blocks.length
    || sourceOrder.some((blockId, index) => blockId !== blocks[index]?.blockId)) {
    incidents.push("BLOCK_MEMBERSHIP_INVALID");
  }

  const snapshotById = new Map(state.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  try {
    const revisions = state.knowledgeRevisions.map(
      (row) => row.payload as KnowledgeRevision,
    );
    const history = new KnowledgeStore(revisions);
    const projectableStatuses = new Set([
      "provisional",
      "active",
      "needs_revalidate",
      "contextual",
    ]);
    for (const row of state.knowledgeRevisions) {
      const payload = row.payload as KnowledgeRevision;
      const latest = history.latestRevision(row.normalizedSubject, row.kind);
      const expectedActive = latest?.revisionId === row.revisionId
        && projectableStatuses.has(payload.status);
      if (row.runId !== state.runId
        || row.recordId !== sha256(`${row.normalizedSubject}\0${row.kind}`)
        || payload.revisionId !== row.revisionId
        || payload.revision !== row.revision
        || payload.normalizedSubject !== row.normalizedSubject
        || payload.kind !== row.kind
        || payload.status !== row.status
        || row.active !== expectedActive) {
        throw new Error(`knowledge row ${row.revisionId} differs from its canonical payload`);
      }
    }
  } catch {
    incidents.push("KNOWLEDGE_HISTORY_INVALID");
  }
  let projectedKnowledge: KnowledgeStore | undefined;
  const consumedKnowledgeRows = new Set<number>();
  let previousSnapshotId: string | null = null;
  for (let snapshotIndex = 0; snapshotIndex < state.snapshots.length; snapshotIndex += 1) {
    const snapshot = state.snapshots[snapshotIndex]!;
    const payload = snapshot.payload as Partial<KnowledgeSnapshot> | null;
    if (snapshot.contentHash !== snapshot.snapshotId
      || payload === null
      || typeof payload !== "object"
      || payload.runId !== state.runId
      || payload.id !== snapshot.snapshotId
      || payload.contentHash !== snapshot.snapshotId
      || payload.parentSnapshotId !== snapshot.parentSnapshotId
      || !Array.isArray(payload.revisions)) {
      incidents.push("SNAPSHOT_LINEAGE_INVALID");
    } else {
      const rebuilt = createKnowledgeSnapshot(
        state.runId,
        payload.revisions,
        payload.parentSnapshotId,
      );
      if (rebuilt.id !== snapshot.snapshotId) {
        incidents.push("SNAPSHOT_LINEAGE_INVALID");
      }
    }
    try {
      if (payload === null || !Array.isArray(payload.revisions)) {
        throw new Error("snapshot has no typed knowledge projection");
      }
      if (snapshotIndex === 0) {
        if (snapshot.producingWindowId !== null) {
          throw new Error("initial snapshot must not have a producing window");
        }
        projectedKnowledge = new KnowledgeStore(payload.revisions);
      } else {
        if (projectedKnowledge === undefined || snapshot.producingWindowId === null) {
          throw new Error("derived snapshot is missing its knowledge predecessor");
        }
        const appended: KnowledgeRevision[] = [];
        for (let index = 0; index < state.knowledgeRevisions.length; index += 1) {
          const revision = state.knowledgeRevisions[index]!;
          if (revision.producingWindowId === snapshot.producingWindowId) {
            appended.push(revision.payload as KnowledgeRevision);
            consumedKnowledgeRows.add(index);
          }
        }
        projectedKnowledge = new KnowledgeStore([
          ...projectedKnowledge.listRevisions(),
          ...appended,
        ]);
        const expected = createKnowledgeSnapshot(
          state.runId,
          projectedKnowledge.projectableRevisions(),
          snapshot.parentSnapshotId,
        );
        if (canonicalJson(expected) !== canonicalJson(payload)) {
          throw new Error("snapshot projection differs from persisted domain history");
        }
      }
    } catch {
      incidents.push("KNOWLEDGE_HISTORY_INVALID");
    }
    if (snapshot.parentSnapshotId !== previousSnapshotId) {
      incidents.push("SNAPSHOT_LINEAGE_INVALID");
    }
    if (snapshot.producingWindowId !== null
      && !windowById.has(snapshot.producingWindowId)) {
      incidents.push("SNAPSHOT_LINEAGE_INVALID");
    }
    previousSnapshotId = snapshot.snapshotId;
  }
  if (consumedKnowledgeRows.size !== state.knowledgeRevisions.length) {
    incidents.push("KNOWLEDGE_HISTORY_INVALID");
  }
  for (const window of state.windows) {
    if (window.snapshotId !== null && !snapshotById.has(window.snapshotId)) {
      incidents.push("SNAPSHOT_LINEAGE_INVALID");
    }
  }

  const translatedBlockIds = new Set<string>();
  for (const translation of state.translations.filter((item) => item.active)) {
    const block = blockById.get(translation.blockId);
    const window = windowById.get(translation.windowId);
    const valid = translation.runId === state.runId
      && translation.sourceVersion === state.sourceVersion
      && translation.stageState === "promoted"
      && translation.text.trim().length > 0
      && Number.isSafeInteger(translation.version)
      && translation.version > 0
      && (translation.resultStatus === "completed"
        || translation.resultStatus === "completed_with_warnings")
      && window?.status === translation.resultStatus
      && block !== undefined
      && translation.sourceHash === block.sourceHash
      && membershipByBlock.get(translation.blockId) === translation.windowId
      && snapshotById.has(translation.snapshotId);
    if (!valid || translatedBlockIds.has(translation.blockId)) {
      incidents.push("ACTIVE_TRANSLATION_INVALID");
    } else {
      translatedBlockIds.add(translation.blockId);
    }
  }
  const missingBlockIds = blocks
    .filter((block) => !translatedBlockIds.has(block.blockId))
    .map((block) => block.blockId);
  if (state.runStatus === "completed" && missingBlockIds.length > 0) {
    incidents.push("RUN_LINEAGE_INVALID");
  }
  const incidentCodes = [...new Set(incidents)].sort();
  return {
    schema: "v5-book-store-audit-1",
    runId: state.runId,
    sourceVersion: state.sourceVersion,
    protocolVersion: state.protocolVersion,
    modelId: state.modelId,
    runStatus: state.runStatus,
    runMetadata: state.runMetadata,
    complete: missingBlockIds.length === 0 && incidentCodes.length === 0,
    totalBlockCount: blocks.length,
    translatedBlockCount: translatedBlockIds.size,
    missingBlockIds,
    missingBlockCount: missingBlockIds.length,
    incidentCodes,
  };
}

export function losslessBookLineage(
  store: LosslessBookStore,
  runId: string,
): LosslessBookLineage {
  const audit = auditLosslessBookStore(store, runId);
  if (audit.incidentCodes.length > 0) {
    throw new Error(`lossless lineage audit failed: ${audit.incidentCodes.join(",")}`);
  }
  const state = store.auditState(runId);
  const active = new Map(store.activeTranslations(runId).map((item) => [item.blockId, item]));
  return {
    schema: "v5-book-lineage-1",
    runId: audit.runId,
    sourceVersion: audit.sourceVersion,
    protocolVersion: audit.protocolVersion,
    modelId: audit.modelId,
    runMetadata: audit.runMetadata,
    complete: audit.complete,
    missingBlockIds: audit.missingBlockIds,
    blocks: [...state.blocks]
      .sort((left, right) => left.globalIndex - right.globalIndex)
      .map((block) => ({
        ordinal: block.globalIndex,
        blockId: block.blockId,
        sourceHash: block.sourceHash,
        translationRevision: active.get(block.blockId)?.version ?? null,
      })),
  };
}

function lineageFileName(artifactFileName: string): string {
  return `${artifactFileName.replace(/\.(?:txt|json)$/u, "")}.lineage.json`;
}

export function losslessBookArtifactPaths(
  outputDirectory: string,
  complete: boolean,
): LosslessBookArtifactPaths {
  const names = bookArtifactFileNames(complete);
  return {
    translation: join(outputDirectory, names.translation),
    bilingual: join(outputDirectory, names.bilingual),
    audit: join(outputDirectory, names.audit),
    metrics: join(outputDirectory, names.metrics),
    translationLineage: join(outputDirectory, lineageFileName(names.translation)),
    bilingualLineage: join(outputDirectory, lineageFileName(names.bilingual)),
    auditLineage: join(outputDirectory, lineageFileName(names.audit)),
  };
}

export function writeLosslessBookArtifacts(
  store: LosslessBookStore,
  runId: string,
  outputDirectory: string,
  options: { allowIncomplete?: boolean } = {},
): LosslessBookArtifactPaths {
  const audit = auditLosslessBookStore(store, runId);
  if (audit.incidentCodes.length > 0) {
    throw new Error(`lossless export audit failed: ${audit.incidentCodes.join(",")}`);
  }
  if (!options.allowIncomplete && !audit.complete) {
    throw new Error(
      `strict book export requires ${audit.totalBlockCount} translated blocks; found ${audit.translatedBlockCount}`,
    );
  }
  const state = store.auditState(runId);
  const active = new Map(store.activeTranslations(runId).map((item) => [item.blockId, item]));
  const windowById = new Map(state.windows.map((window) => [window.windowId, window]));
  const windowIdByBlock = new Map(
    state.memberships.map((membership) => [membership.blockId, membership.windowId]),
  );
  const translations: PilotTranslation[] = state.blocks
    .filter((block) => active.has(block.blockId))
    .sort((left, right) => left.globalIndex - right.globalIndex)
    .map((block) => {
      const translation = active.get(block.blockId)!;
      const window = windowById.get(windowIdByBlock.get(block.blockId) ?? "");
      return {
        blockId: block.blockId,
        globalIndex: block.globalIndex,
        chapterId: window?.chapterId ?? null,
        chapterTitle: window?.chapterTitle ?? null,
        sourceText: block.sourceText,
        text: translation.text,
      };
    });
  mkdirSync(outputDirectory, { recursive: true });
  const paths = losslessBookArtifactPaths(outputDirectory, audit.complete);
  writeFileSync(paths.translation, renderTranslation(translations), "utf8");
  writeFileSync(paths.bilingual, renderBilingual(translations), "utf8");
  writeFileSync(paths.audit, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  writeFileSync(paths.metrics, `${JSON.stringify({
    schema: "v5-book-metrics-1",
    runId: audit.runId,
    sourceVersion: audit.sourceVersion,
    protocolVersion: audit.protocolVersion,
    modelId: audit.modelId,
    runMetadata: audit.runMetadata,
    complete: audit.complete,
    missingBlockIds: audit.missingBlockIds,
    missingBlockCount: audit.missingBlockCount,
    status: store.statusSummary(runId),
  }, null, 2)}\n`, "utf8");
  const lineageJson = `${JSON.stringify(losslessBookLineage(store, runId), null, 2)}\n`;
  writeFileSync(paths.translationLineage, lineageJson, "utf8");
  writeFileSync(paths.bilingualLineage, lineageJson, "utf8");
  writeFileSync(paths.auditLineage, lineageJson, "utf8");
  return paths;
}

export function writeBookArtifacts(
  store: BookStore,
  outputDirectory: string,
  options: { allowIncomplete?: boolean } = {},
): BookArtifactPaths {
  const status = store.statusSummary();
  if (!options.allowIncomplete && status.translatedBlocks !== status.totalBlocks) {
    throw new Error(
      `strict book export requires ${status.totalBlocks} translated blocks; found ${status.translatedBlocks}`,
    );
  }
  const translations: PilotTranslation[] = store.activeTranslations().map((item) => ({
    blockId: item.blockId,
    globalIndex: item.globalIndex,
    chapterId: item.chapterId,
    chapterTitle: item.chapterTitle,
    sourceText: item.sourceText,
    text: item.text,
  }));
  mkdirSync(outputDirectory, { recursive: true });
  const complete = status.translatedBlocks === status.totalBlocks;
  const names = bookArtifactFileNames(complete);
  const paths = {
    translation: join(outputDirectory, names.translation),
    bilingual: join(outputDirectory, names.bilingual),
    audit: join(outputDirectory, names.audit),
    metrics: join(outputDirectory, names.metrics),
  };
  writeFileSync(paths.translation, renderTranslation(translations), "utf8");
  writeFileSync(paths.bilingual, renderBilingual(translations), "utf8");
  writeFileSync(paths.audit, `${JSON.stringify({
    schemaVersion: "v5-book-audit-1",
    status,
    windows: store.allWindows(),
  }, null, 2)}\n`, "utf8");
  writeFileSync(paths.metrics, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return paths;
}
