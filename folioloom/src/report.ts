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
import { stripEpubStructuralMarkers } from "./source/epub-structure.js";
import type { BookStore } from "./storage/book-store.js";
import type { LosslessBookStore } from "./storage/lossless-book-store.js";
import type { SchedulerRunReport } from "./fullbook/dynamic-scheduler.js";
import { optimizationPolicy } from "./fullbook/optimization-policy.js";

export interface PilotTranslation {
  blockId: string;
  globalIndex: number;
  chapterId: string | null;
  chapterTitle: string | null;
  sourceText: string;
  text: string;
  canonicalStart?: number;
  canonicalEnd?: number;
}

export interface RenderTranslationOptions {
  /** Lossless source headings are themselves translated blocks; repeating source metadata leaks residue. */
  includeChapterMetadata?: boolean;
}

export function renderTranslation(
  translations: readonly PilotTranslation[],
  options: RenderTranslationOptions = {},
): string {
  const lines: string[] = [];
  let chapter: string | null | undefined;
  for (const item of translations) {
    if (options.includeChapterMetadata !== false && item.chapterId !== chapter) {
      chapter = item.chapterId;
      lines.push(
        lines.length === 0 ? "" : "\n",
        `# ${item.chapterTitle ?? item.chapterId ?? "Untitled"}`,
        "",
      );
    }
    lines.push(stripEpubStructuralMarkers(item.text).trim(), "");
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
      stripEpubStructuralMarkers(item.sourceText).trim(),
      "",
      "[TRANSLATION]",
      stripEpubStructuralMarkers(item.text).trim(),
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
    translation: `folioloom_book_translation${qualifier}.txt`,
    bilingual: `folioloom_book_bilingual${qualifier}.txt`,
    audit: `folioloom_book_audit${qualifier}.json`,
    metrics: `folioloom_book_metrics${qualifier}.json`,
  };
}

function safeArtifactFileStem(value: string): string {
  const sanitized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[.\s]+$/gu, "")
    .trim()
    .slice(0, 100)
    .replace(/[.\s]+$/gu, "");
  return sanitized.length > 0 ? sanitized : "FolioLoom";
}

function friendlyBookArtifactFileNames(
  complete: boolean,
  fileStem: string,
): BookArtifactPaths {
  const stem = safeArtifactFileStem(fileStem);
  const qualifier = complete ? "" : "-未完成";
  return {
    translation: `${stem}-中文${qualifier}.txt`,
    bilingual: `${stem}-双语${qualifier}.txt`,
    audit: `${stem}-审计${qualifier}.json`,
    metrics: `${stem}-指标${qualifier}.json`,
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
  structurallyComplete: boolean;
  knowledgeConverged: boolean;
  strictExportable: boolean;
  revalidation: {
    pending: number;
    validating: number;
    stale: number;
    warningStale: number;
    coverageMissing: number;
    resolvedNoop: number;
    repaired: number;
    retranslated: number;
  };
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
  const appendSnapshotKnowledge = (
    payloadRevisions: readonly KnowledgeRevision[],
    producingWindowId: string | null,
  ): KnowledgeStore => {
    const previous = projectedKnowledge ?? new KnowledgeStore();
    const selected: Array<{
      readonly index: number;
      readonly revision: KnowledgeRevision;
    }> = [];
    if (producingWindowId !== null) {
      for (let index = 0; index < state.knowledgeRevisions.length; index += 1) {
        const row = state.knowledgeRevisions[index]!;
        if (!consumedKnowledgeRows.has(index)
          && row.producingWindowId === producingWindowId) {
          selected.push({
            index,
            revision: row.payload as KnowledgeRevision,
          });
        }
      }
    } else {
      for (const targetRevision of payloadRevisions) {
        const previousRevision = previous.latestRevision(
          targetRevision.normalizedSubject,
          targetRevision.kind,
        )?.revision ?? 0;
        if (targetRevision.revision <= previousRevision) {
          continue;
        }
        for (let index = 0; index < state.knowledgeRevisions.length; index += 1) {
          const row = state.knowledgeRevisions[index]!;
          if (!consumedKnowledgeRows.has(index)
            && row.producingWindowId === null
            && row.normalizedSubject === targetRevision.normalizedSubject
            && row.kind === targetRevision.kind
            && row.revision > previousRevision
            && row.revision <= targetRevision.revision) {
            selected.push({
              index,
              revision: row.payload as KnowledgeRevision,
            });
          }
        }
      }
    }
    const next = new KnowledgeStore([
      ...previous.listRevisions(),
      ...selected.map((item) => item.revision),
    ]);
    const expected = createKnowledgeSnapshot(
      state.runId,
      next.projectableRevisions(),
      previousSnapshotId,
    );
    const actual = createKnowledgeSnapshot(
      state.runId,
      payloadRevisions,
      previousSnapshotId,
    );
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new Error("snapshot projection differs from persisted domain history");
    }
    for (const item of selected) {
      consumedKnowledgeRows.add(item.index);
    }
    return next;
  };
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
        projectedKnowledge = appendSnapshotKnowledge(
          payload.revisions,
          snapshot.producingWindowId,
        );
      } else {
        if (projectedKnowledge === undefined) {
          throw new Error("derived snapshot is missing its knowledge predecessor");
        }
        projectedKnowledge = appendSnapshotKnowledge(
          payload.revisions,
          snapshot.producingWindowId,
        );
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
  const structurallyComplete = missingBlockIds.length === 0
    && incidents.length === 0;
  const revalidation = {
    pending: state.revalidationTasks.filter((task) =>
      task.status === "pending").length,
    validating: state.revalidationTasks.filter((task) =>
      task.status === "validating").length,
    stale: state.conceptBindings.filter((binding) =>
      binding.validationStatus === "pending"
      || binding.validationStatus === "validating"
      || binding.validationStatus === "stale").length,
    warningStale: state.conceptBindings.filter((binding) =>
      binding.validationStatus === "warning_stale").length,
    coverageMissing: state.missingConceptBindings.length,
    resolvedNoop: state.revalidationTasks.filter((task) =>
      task.status === "resolved_noop").length,
    repaired: state.revalidationTasks.filter((task) =>
      task.status === "resolved_repair").length,
    retranslated: state.revalidationTasks.filter((task) =>
      task.status === "resolved_retranslate").length,
  };
  const knowledgeConverged = revalidation.pending === 0
    && revalidation.validating === 0
    && revalidation.stale === 0
    && revalidation.warningStale === 0
    && revalidation.coverageMissing === 0
    && state.revalidationTasks.every((task) =>
      task.status !== "completed_with_warning");
  if (!knowledgeConverged) {
    incidents.push("STALE_KNOWLEDGE_BINDING");
  }
  const incidentCodes = [...new Set(incidents)].sort();
  const strictExportable = structurallyComplete && knowledgeConverged;
  return {
    schema: "v5-book-store-audit-1",
    runId: state.runId,
    sourceVersion: state.sourceVersion,
    protocolVersion: state.protocolVersion,
    modelId: state.modelId,
    runStatus: state.runStatus,
    runMetadata: state.runMetadata,
    complete: strictExportable,
    structurallyComplete,
    knowledgeConverged,
    strictExportable,
    revalidation,
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
  const integrityIncidents = audit.incidentCodes.filter((code) =>
    code !== "STALE_KNOWLEDGE_BINDING");
  if (integrityIncidents.length > 0) {
    throw new Error(`lossless lineage audit failed: ${integrityIncidents.join(",")}`);
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
  fileStem?: string,
): LosslessBookArtifactPaths {
  const names = fileStem === undefined
    ? bookArtifactFileNames(complete)
    : friendlyBookArtifactFileNames(complete, fileStem);
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

export function losslessBookTranslations(
  store: LosslessBookStore,
  runId: string,
): PilotTranslation[] {
  const state = store.auditState(runId);
  const active = new Map(store.activeTranslations(runId).map((item) => [item.blockId, item]));
  const windowById = new Map(state.windows.map((window) => [window.windowId, window]));
  const windowIdByBlock = new Map(
    state.memberships.map((membership) => [membership.blockId, membership.windowId]),
  );
  return state.blocks
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
        canonicalStart: block.canonicalStart,
        canonicalEnd: block.canonicalEnd,
      };
    });
}

export interface WriteLosslessBookArtifactsOptions {
  allowIncomplete?: boolean;
  fileStem?: string;
  scheduler?: SchedulerRunReport;
}

export interface SchedulerMetricsReport {
  readonly schema: "v5-book-scheduler-metrics-1";
  readonly mode: SchedulerRunReport["mode"];
  readonly profile: SchedulerRunReport["profile"];
  readonly plannerStatus: SchedulerRunReport["planningStatus"];
  readonly wallTime: {
    readonly legacyEstimateMs: number;
    readonly plannedEstimateMs: number;
    readonly actualMs: number;
  };
  readonly tokenEnvelope: {
    readonly baselineTokens: number;
    readonly allowedTokens: number;
    readonly predictedTokens: number;
    readonly actualTokens: number;
    readonly exceeded: boolean;
  };
  readonly selections: {
    readonly contextProfiles: Readonly<Record<string, number>>;
    readonly efforts: Readonly<Record<string, number>>;
    readonly protocols: Readonly<Record<string, number>>;
  };
  readonly events: {
    readonly plannerDeadlines: number;
    readonly fallbacks: number;
    readonly throttles: number;
    readonly recoveries: number;
  };
  readonly decisions: number;
  readonly tokenUsageComplete: boolean;
}

const METRIC_EFFORTS = new Set([
  "off",
  "on",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function sortedPositiveCounts(
  counts: Readonly<Record<string, number>>,
  allowedKeys?: ReadonlySet<string>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of Object.keys(counts).sort((left, right) =>
    left.localeCompare(right, "en"))) {
    const count = counts[key] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`scheduler metric count must be non-negative: ${key}`);
    }
    if (count === 0) continue;
    const safeKey = allowedKeys === undefined || allowedKeys.has(key)
      ? key
      : "unknown";
    result[safeKey] = (result[safeKey] ?? 0) + count;
  }
  return result;
}

export function schedulerMetrics(
  scheduler: SchedulerRunReport,
): SchedulerMetricsReport {
  const contextProfiles = { lean: 0, balanced: 0, rich: 0 };
  for (const profile of Object.values(scheduler.contextProfiles)) {
    contextProfiles[profile] += 1;
  }
  const selectedContextProfiles = sortedPositiveCounts(contextProfiles);
  const efforts = sortedPositiveCounts(
    scheduler.effortCounts,
    METRIC_EFFORTS,
  );
  const protocols = sortedPositiveCounts(
    scheduler.protocolCounts,
    new Set(["typed_tool", "framed_text", "local"]),
  );
  return {
    schema: "v5-book-scheduler-metrics-1",
    mode: scheduler.mode,
    profile: scheduler.profile,
    plannerStatus: scheduler.planningStatus,
    wallTime: {
      legacyEstimateMs: scheduler.baselineWallTimeMs,
      plannedEstimateMs: scheduler.predictedWallTimeMs,
      actualMs: scheduler.actualWallTimeMs,
    },
    tokenEnvelope: {
      baselineTokens: scheduler.baselineTokens,
      allowedTokens: scheduler.allowedTokens,
      predictedTokens: scheduler.predictedTokens,
      actualTokens: scheduler.actualTokens,
      exceeded: Math.max(
        scheduler.predictedTokens,
        scheduler.actualTokens,
      ) > scheduler.allowedTokens,
    },
    selections: {
      contextProfiles: selectedContextProfiles,
      efforts,
      protocols,
    },
    events: {
      plannerDeadlines: scheduler.plannerDeadlines,
      fallbacks: scheduler.fallbacks,
      throttles: scheduler.throttles,
      recoveries: scheduler.recoveries,
    },
    decisions: scheduler.decisions,
    tokenUsageComplete: scheduler.tokenUsageComplete,
  };
}

function schedulerMetricsProjection(
  scheduler: SchedulerRunReport | undefined,
): SchedulerMetricsReport | null {
  if (scheduler === undefined) return null;
  return schedulerMetrics(scheduler);
}

const TOKEN_LEDGER_EXPORT_INCIDENTS = new Set([
  "TOKEN_LEDGER_PROJECTION_MISSING",
  "TOKEN_LEDGER_PROJECTION_MISMATCH",
  "TOKEN_LEDGER_OPEN_ATTEMPT",
  "TOKEN_USAGE_INCOMPLETE",
]);

function sameLedgerProjection(
  left: SchedulerRunReport,
  right: SchedulerRunReport,
): boolean {
  return left.baselineTokens === right.baselineTokens
    && left.allowedTokens === right.allowedTokens
    && left.actualTokens === right.actualTokens
    && left.tokenUsageComplete === right.tokenUsageComplete;
}

export function auditLosslessBookExport(
  store: LosslessBookStore,
  runId: string,
  schedulerOverride?: SchedulerRunReport,
): {
  readonly audit: LosslessBookAuditReport;
  readonly scheduler: SchedulerRunReport | undefined;
} {
  const baseAudit = auditLosslessBookStore(store, runId);
  const ledgerEvents = store.loadTokenLedgerEvents(runId);
  let storedProjection: SchedulerRunReport | undefined;
  try {
    storedProjection = store.loadSchedulerMetrics(runId);
  } catch (error) {
    if (!(error instanceof TypeError)
      || !/requires TokenLedgerInit/u.test(error.message)) {
      throw error;
    }
  }
  const projection = schedulerOverride ?? storedProjection;
  let scheduler = projection;
  const ledgerIncidents: string[] = [];
  if (ledgerEvents.length > 0) {
    if (projection === undefined) {
      ledgerIncidents.push("TOKEN_LEDGER_PROJECTION_MISSING");
    } else {
      const init = {
        mode: projection.mode,
        profile: projection.profile,
        tokenIncreaseCap:
          optimizationPolicy(projection.profile).tokenIncreaseCap,
        enforceDispatchLifecycle: true,
      };
      const ledger = store.loadTokenLedger(runId, init);
      const durableScheduler = store.loadSchedulerMetrics(runId, init);
      if (durableScheduler === undefined) {
        ledgerIncidents.push("TOKEN_LEDGER_PROJECTION_MISSING");
      } else {
        scheduler = durableScheduler;
        if (!sameLedgerProjection(projection, durableScheduler)
          || (storedProjection !== undefined
            && !sameLedgerProjection(storedProjection, durableScheduler))) {
          ledgerIncidents.push("TOKEN_LEDGER_PROJECTION_MISMATCH");
        }
        if (!durableScheduler.tokenUsageComplete) {
          ledgerIncidents.push("TOKEN_USAGE_INCOMPLETE");
        }
      }
      if (!ledger.reconcile().consistent) {
        ledgerIncidents.push("TOKEN_LEDGER_OPEN_ATTEMPT");
      }
    }
  }
  const incidentCodes = [...new Set([
    ...baseAudit.incidentCodes,
    ...ledgerIncidents,
  ])].sort();
  const strictExportable = baseAudit.strictExportable
    && ledgerIncidents.length === 0;
  return {
    audit: {
      ...baseAudit,
      complete: strictExportable,
      strictExportable,
      incidentCodes,
    },
    scheduler,
  };
}

export function writeLosslessBookArtifacts(
  store: LosslessBookStore,
  runId: string,
  outputDirectory: string,
  options: WriteLosslessBookArtifactsOptions = {},
): LosslessBookArtifactPaths {
  const projection = auditLosslessBookExport(
    store,
    runId,
    options.scheduler,
  );
  const audit = projection.audit;
  const integrityIncidents = audit.incidentCodes.filter((code) =>
    code !== "STALE_KNOWLEDGE_BINDING"
    && !TOKEN_LEDGER_EXPORT_INCIDENTS.has(code));
  if (integrityIncidents.length > 0) {
    throw new Error(`lossless export audit failed: ${integrityIncidents.join(",")}`);
  }
  if (!options.allowIncomplete && !audit.strictExportable) {
    const ledgerIncidents = audit.incidentCodes.filter((code) =>
      TOKEN_LEDGER_EXPORT_INCIDENTS.has(code));
    if (ledgerIncidents.length > 0) {
      throw new Error(
        `strict book export requires reconciled token usage: ${ledgerIncidents.join(",")}`,
      );
    }
    if (!audit.knowledgeConverged) {
      throw new Error(
        "strict book export requires knowledge convergence: STALE_KNOWLEDGE_BINDING",
      );
    }
    throw new Error(
      `strict book export requires ${audit.totalBlockCount} translated blocks; found ${audit.translatedBlockCount}`,
    );
  }
  const translations = losslessBookTranslations(store, runId);
  mkdirSync(outputDirectory, { recursive: true });
  const paths = losslessBookArtifactPaths(outputDirectory, audit.complete, options.fileStem);
  writeFileSync(paths.translation, renderTranslation(translations, {
    includeChapterMetadata: false,
  }), "utf8");
  writeFileSync(paths.bilingual, renderBilingual(translations), "utf8");
  writeFileSync(paths.audit, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  const schedulerReport = projection.scheduler;
  writeFileSync(paths.metrics, `${JSON.stringify({
    schema: "v5-book-metrics-1",
    runId: audit.runId,
    sourceVersion: audit.sourceVersion,
    protocolVersion: audit.protocolVersion,
    modelId: audit.modelId,
    runMetadata: audit.runMetadata,
    complete: audit.complete,
    structurallyComplete: audit.structurallyComplete,
    knowledgeConverged: audit.knowledgeConverged,
    strictExportable: audit.strictExportable,
    revalidation: audit.revalidation,
    missingBlockIds: audit.missingBlockIds,
    missingBlockCount: audit.missingBlockCount,
    status: store.statusSummary(runId),
    scheduler: schedulerMetricsProjection(schedulerReport),
  }, null, 2)}\n`, "utf8");
  const lineageJson = `${JSON.stringify({
    ...losslessBookLineage(store, runId),
    complete: audit.complete,
  }, null, 2)}\n`;
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
