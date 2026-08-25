import { Buffer } from "node:buffer";

import {
  canonicalJson,
  type KnowledgeStatus,
} from "./knowledge-store.js";
import { sourceFormsFromRevision } from "./knowledge-source-forms.js";
import type { ContextEvidenceBundle } from "../fullbook/context-profile-planner.js";
import type { RiskDimension } from "../fullbook/task-risk.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { WeightedTokenEstimator } from "../source/token-estimator.js";

/**
 * Translator prompts must not grow with the durable book snapshot.  These
 * limits apply only to the wire projection; the persistent snapshot remains
 * complete and keeps its original identity.
 */
export const DEFAULT_TRANSLATION_KNOWLEDGE_MAX_ENTRIES = 24;
export const DEFAULT_TRANSLATION_KNOWLEDGE_MAX_BYTES = 24_000;
export const DEFAULT_TRANSLATION_KNOWLEDGE_GLOBAL_FALLBACK_ENTRIES = 2;

const TRANSLATOR_VISIBLE_STATUSES = new Set<KnowledgeStatus>([
  "provisional",
  "active",
  "needs_revalidate",
  "contextual",
]);

const GLOBAL_FALLBACK_KINDS = new Set([
  "lexical_anchor",
  "term_sense",
]);

export interface TranslationKnowledgeBlockPosition {
  readonly blockId: string;
  readonly globalIndex: number;
}

export interface TranslationKnowledgeCurrentBlockPosition
  extends TranslationKnowledgeBlockPosition {
  readonly windowId: string;
}

export interface TranslationKnowledgeProjectionOptions {
  /** Maximum number of individual knowledge revisions exposed to one request. */
  readonly maxEntries?: number;
  /** Maximum UTF-8 bytes of the canonical wire payload, metadata included. */
  readonly maxSerializedBytes?: number;
  /** Reserved deterministic fallbacks for global terminology/revalidation facts. */
  readonly maxGlobalFallbackEntries?: number;
  /** Complete immutable block order used to resolve positioned narrative memory. */
  readonly corpusBlocks?: readonly TranslationKnowledgeBlockPosition[];
  /** Blocks actually contained in this physical translation request. */
  readonly currentBlocks?: readonly TranslationKnowledgeCurrentBlockPosition[];
  /** Exact request-local revision selection produced by the context planner. */
  readonly selectedRevisionIds?: ReadonlySet<string>;
}

export interface TranslationKnowledgeCandidate {
  readonly bundleId: string;
  readonly revisionIds: readonly string[];
  readonly kind: ContextEvidenceBundle["kind"];
  readonly evidenceDistance?: number;
  readonly tokenCost: number;
  readonly entryCost: number;
  readonly utility: number;
  readonly coverage: readonly RiskDimension[];
  readonly requires: readonly string[];
  readonly redundancyGroup?: string;
  readonly mandatory: boolean;
  readonly payload: unknown;
}

export interface TranslationKnowledgeProjectionMetadata {
  readonly total: number;
  readonly projected: number;
  readonly omitted: number;
  readonly maxEntries: number;
  readonly maxSerializedBytes: number;
  readonly serializedBytes: number;
}

export interface ProjectedKnowledgeRevision {
  readonly revisionId: string;
  readonly revision: number;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly status: Extract<KnowledgeStatus,
    "provisional" | "active" | "needs_revalidate" | "contextual">;
  readonly scope: "source_matched" | "position_matched" | "global_fallback";
  /** Present for positioned memory so packed logical windows stay independent. */
  readonly appliesToWindowIds?: readonly string[];
  readonly payload: unknown;
  readonly alternatives: readonly unknown[];
}

/**
 * This is the only knowledge structure serialized into a translator prompt.
 * It contains no pointer to the full snapshot or omitted revision contents.
 */
export interface TranslationKnowledgeProjection {
  readonly schemaVersion: "v5-translation-knowledge-projection-1";
  readonly metadata: TranslationKnowledgeProjectionMetadata;
  readonly revisions: readonly ProjectedKnowledgeRevision[];
}

interface ParsedRevision {
  readonly revisionId: string;
  readonly revision: number;
  readonly normalizedSubject: string;
  readonly kind: string;
  readonly status: Extract<KnowledgeStatus,
    "provisional" | "active" | "needs_revalidate" | "contextual">;
  readonly payload: unknown;
  readonly alternatives: readonly unknown[];
}

interface Candidate {
  readonly revision: ParsedRevision;
  readonly scope: ProjectedKnowledgeRevision["scope"];
  readonly appliesToWindowIds?: readonly string[];
  readonly evidenceDistance?: number;
}

interface CandidateGroups {
  readonly total: number;
  readonly validRevisionIds: ReadonlySet<string>;
  readonly matchingNeedsRevalidate: readonly Candidate[];
  readonly matchingOther: readonly Candidate[];
  readonly globalFallbacks: readonly Candidate[];
}

interface ResolvedOptions {
  readonly maxEntries: number;
  readonly maxSerializedBytes: number;
  readonly maxGlobalFallbackEntries: number;
}

interface PositionContext {
  readonly corpusIndexById: ReadonlyMap<string, number>;
  readonly currentIndexesByWindow: ReadonlyMap<string, ReadonlySet<number>>;
}

interface PositionedMemoryMatch {
  readonly positioned: boolean;
  readonly windowIds: readonly string[];
  readonly distance?: number;
}

const KNOWLEDGE_TOKEN_ESTIMATOR = new WeightedTokenEstimator();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function resolvedOptions(
  options: TranslationKnowledgeProjectionOptions,
): ResolvedOptions {
  const maxEntries = nonNegativeSafeInteger(
    options.maxEntries ?? DEFAULT_TRANSLATION_KNOWLEDGE_MAX_ENTRIES,
    "maxEntries",
  );
  const maxSerializedBytes = nonNegativeSafeInteger(
    options.maxSerializedBytes ?? DEFAULT_TRANSLATION_KNOWLEDGE_MAX_BYTES,
    "maxSerializedBytes",
  );
  const maxGlobalFallbackEntries = nonNegativeSafeInteger(
    options.maxGlobalFallbackEntries
      ?? DEFAULT_TRANSLATION_KNOWLEDGE_GLOBAL_FALLBACK_ENTRIES,
    "maxGlobalFallbackEntries",
  );
  return {
    maxEntries,
    maxSerializedBytes,
    maxGlobalFallbackEntries: Math.min(maxEntries, maxGlobalFallbackEntries),
  };
}

function blockPosition(
  value: TranslationKnowledgeBlockPosition,
  label: string,
): TranslationKnowledgeBlockPosition {
  if (value === null
    || typeof value !== "object"
    || typeof value.blockId !== "string"
    || value.blockId.trim().length === 0
    || !Number.isSafeInteger(value.globalIndex)
    || value.globalIndex < 0) {
    throw new TypeError(`${label} must contain a nonempty blockId and nonnegative globalIndex`);
  }
  return {
    blockId: value.blockId,
    globalIndex: value.globalIndex,
  };
}

function positionContext(
  options: TranslationKnowledgeProjectionOptions,
): PositionContext | undefined {
  if (options.corpusBlocks === undefined && options.currentBlocks === undefined) {
    return undefined;
  }
  if (!Array.isArray(options.corpusBlocks) || !Array.isArray(options.currentBlocks)) {
    throw new TypeError("corpusBlocks and currentBlocks must be provided together");
  }
  const corpusIndexById = new Map<string, number>();
  const corpusIdByIndex = new Map<number, string>();
  for (const [index, raw] of options.corpusBlocks.entries()) {
    const item = blockPosition(raw, `corpusBlocks[${index}]`);
    const priorIndex = corpusIndexById.get(item.blockId);
    if (priorIndex !== undefined && priorIndex !== item.globalIndex) {
      throw new TypeError(`corpusBlocks contains conflicting blockId ${item.blockId}`);
    }
    const priorId = corpusIdByIndex.get(item.globalIndex);
    if (priorId !== undefined && priorId !== item.blockId) {
      throw new TypeError(`corpusBlocks contains duplicate globalIndex ${item.globalIndex}`);
    }
    corpusIndexById.set(item.blockId, item.globalIndex);
    corpusIdByIndex.set(item.globalIndex, item.blockId);
  }
  const currentIndexesByWindow = new Map<string, Set<number>>();
  const currentWindowByBlockId = new Map<string, string>();
  for (const [index, raw] of options.currentBlocks.entries()) {
    const item = blockPosition(raw, `currentBlocks[${index}]`);
    if (typeof raw.windowId !== "string" || raw.windowId.trim().length === 0) {
      throw new TypeError(`currentBlocks[${index}].windowId must be nonempty`);
    }
    if (corpusIndexById.get(item.blockId) !== item.globalIndex) {
      throw new TypeError(`currentBlocks[${index}] is not present in corpusBlocks`);
    }
    const priorWindow = currentWindowByBlockId.get(item.blockId);
    if (priorWindow !== undefined && priorWindow !== raw.windowId) {
      throw new TypeError(`current block ${item.blockId} belongs to multiple windows`);
    }
    currentWindowByBlockId.set(item.blockId, raw.windowId);
    const windowIndexes = currentIndexesByWindow.get(raw.windowId) ?? new Set<number>();
    windowIndexes.add(item.globalIndex);
    currentIndexesByWindow.set(raw.windowId, windowIndexes);
  }
  return { corpusIndexById, currentIndexesByWindow };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asVisibleStatus(value: unknown): ParsedRevision["status"] | undefined {
  return typeof value === "string" && TRANSLATOR_VISIBLE_STATUSES.has(value as KnowledgeStatus)
    ? value as ParsedRevision["status"]
    : undefined;
}

function parseRevision(value: unknown): ParsedRevision | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const revisionId = nonemptyString(raw.revisionId);
  const normalizedSubject = nonemptyString(raw.normalizedSubject);
  const kind = nonemptyString(raw.kind);
  const status = asVisibleStatus(raw.status);
  if (revisionId === undefined
    || normalizedSubject === undefined
    || kind === undefined
    || status === undefined
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 1
    || !Array.isArray(raw.alternatives)
    || !("payload" in raw)) {
    return undefined;
  }
  return {
    revisionId,
    revision: raw.revision as number,
    normalizedSubject,
    kind,
    status,
    payload: raw.payload,
    alternatives: raw.alternatives,
  };
}

function formsForRevision(revision: ParsedRevision): string[] {
  const forms = new Set(sourceFormsFromRevision(revision));
  // Ordinary durable memory candidates normalize their first subject form into
  // normalizedSubject.  Entity-link keys use an internal prefix, so payload
  // forms above remain the matching route for those records.
  if (!revision.normalizedSubject.startsWith("entity-alias:")) {
    forms.add(revision.normalizedSubject);
  }
  return [...forms].sort(compareText);
}

function identifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function containsWordOrPhrase(
  source: string,
  form: string,
  profile: SourceLanguageProfile,
): boolean {
  let start = source.indexOf(form);
  while (start >= 0) {
    const before = source.at(start - 1);
    const after = source.at(start + form.length);
    const cjk = profile.scripts.some((script) =>
      script === "kana" || script === "hangul" || script === "han");
    if (cjk || (!identifierCharacter(before) && !identifierCharacter(after))) {
      return true;
    }
    start = source.indexOf(form, start + form.length);
  }
  return false;
}

function sourceMatchesRevision(
  revision: ParsedRevision,
  sourceText: string,
  sourceTokens: ReadonlySet<string>,
  profile: SourceLanguageProfile,
): boolean {
  for (const rawForm of formsForRevision(revision)) {
    const form = profile.normalizeSourceForm(rawForm);
    // One-scalar labels create high false-positive rates (notably Latin "I");
    // they remain available through stable terminology when explicitly locked.
    if (form.length < 2) continue;
    if (sourceTokens.has(form) || containsWordOrPhrase(sourceText, form, profile)) {
      return true;
    }
  }
  return false;
}

function positionedMemoryMatch(
  revision: ParsedRevision,
  positions: PositionContext | undefined,
): PositionedMemoryMatch {
  if (revision.kind !== "narrative_memory") {
    return { positioned: false, windowIds: [] };
  }
  const payload = record(revision.payload);
  if (payload === undefined) return { positioned: false, windowIds: [] };
  const hasStart = Object.hasOwn(payload, "startBlockId");
  const hasEnd = Object.hasOwn(payload, "endBlockId");
  if (!hasStart && !hasEnd) return { positioned: false, windowIds: [] };
  if (!hasStart || !hasEnd || positions === undefined) {
    return { positioned: true, windowIds: [] };
  }
  const startId = nonemptyString(payload.startBlockId);
  const endId = nonemptyString(payload.endBlockId);
  if (startId === undefined || endId === undefined) {
    return { positioned: true, windowIds: [] };
  }
  const start = positions.corpusIndexById.get(startId);
  const end = positions.corpusIndexById.get(endId);
  if (start === undefined || end === undefined || start > end) {
    return { positioned: true, windowIds: [] };
  }
  const windowIds: string[] = [];
  let distance = Number.POSITIVE_INFINITY;
  for (const [windowId, indexes] of positions.currentIndexesByWindow) {
    let applies = false;
    for (const current of indexes) {
      if (current >= start && current <= end) {
        applies = true;
        distance = Math.min(distance, current - start);
      }
    }
    if (applies) windowIds.push(windowId);
  }
  return {
    positioned: true,
    windowIds,
    ...(Number.isFinite(distance) ? { distance } : {}),
  };
}

function isGlobalFallback(revision: ParsedRevision): boolean {
  return revision.status === "needs_revalidate" || GLOBAL_FALLBACK_KINDS.has(revision.kind);
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return compareText(left.revision.normalizedSubject, right.revision.normalizedSubject)
    || compareText(left.revision.kind, right.revision.kind)
    || left.revision.revision - right.revision.revision
    || compareText(left.revision.revisionId, right.revision.revisionId);
}

function projectedRevision(candidate: Candidate): ProjectedKnowledgeRevision {
  return {
    revisionId: candidate.revision.revisionId,
    revision: candidate.revision.revision,
    normalizedSubject: candidate.revision.normalizedSubject,
    kind: candidate.revision.kind,
    status: candidate.revision.status,
    scope: candidate.scope,
    ...(candidate.appliesToWindowIds === undefined
      ? {}
      : { appliesToWindowIds: candidate.appliesToWindowIds }),
    payload: candidate.revision.payload,
    alternatives: candidate.revision.alternatives,
  };
}

function projectionWithStableByteCount(
  total: number,
  revisions: readonly ProjectedKnowledgeRevision[],
  options: ResolvedOptions,
): TranslationKnowledgeProjection {
  let serializedBytes = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const projection: TranslationKnowledgeProjection = {
      schemaVersion: "v5-translation-knowledge-projection-1",
      metadata: {
        total,
        projected: revisions.length,
        omitted: total - revisions.length,
        maxEntries: options.maxEntries,
        maxSerializedBytes: options.maxSerializedBytes,
        serializedBytes,
      },
      revisions,
    };
    const measured = Buffer.byteLength(canonicalJson(projection), "utf8");
    if (measured === serializedBytes) return projection;
    serializedBytes = measured;
  }
  throw new Error("knowledge projection byte count did not converge");
}

function appendIfWithinBounds(
  total: number,
  selected: ProjectedKnowledgeRevision[],
  candidate: Candidate,
  options: ResolvedOptions,
): boolean {
  if (selected.length >= options.maxEntries) return false;
  const next = [...selected, projectedRevision(candidate)];
  let projection: TranslationKnowledgeProjection;
  try {
    projection = projectionWithStableByteCount(total, next, options);
  } catch {
    // A malformed legacy record is safer omitted than copied wholesale to a
    // prompt; durable snapshots are never mutated by this decision.
    return false;
  }
  if (projection.metadata.serializedBytes > options.maxSerializedBytes) return false;
  selected.push(projectedRevision(candidate));
  return true;
}

function candidateGroups(
  revisions: readonly unknown[],
  sourceTexts: readonly string[],
  profile: SourceLanguageProfile,
  options: TranslationKnowledgeProjectionOptions,
): CandidateGroups {
  if (!Array.isArray(revisions)) {
    throw new TypeError("revisions must be an array");
  }
  if (!Array.isArray(sourceTexts)
    || sourceTexts.some((text) => typeof text !== "string")) {
    throw new TypeError("sourceTexts must be an array of strings");
  }
  const positions = positionContext(options);
  const normalizedSource = profile.normalizeSourceForm(sourceTexts.join("\n"));
  const sourceTokens = new Set(profile.segment(sourceTexts.join("\n"))
    .filter((token) => token.isWordLike)
    .map((token) => token.normalized));
  const matchingNeedsRevalidate: Candidate[] = [];
  const matchingOther: Candidate[] = [];
  const globalFallbacks: Candidate[] = [];
  const validRevisionIds = new Set<string>();

  for (const raw of revisions) {
    const revision = parseRevision(raw);
    if (revision === undefined) continue;
    validRevisionIds.add(revision.revisionId);
    if (revision.kind === "lexical_anchor_decision") continue;
    const positionMatch = positionedMemoryMatch(revision, positions);
    const matched = positionMatch.positioned
      ? positionMatch.windowIds.length > 0
      : sourceMatchesRevision(revision, normalizedSource, sourceTokens, profile);
    if (matched) {
      const candidate: Candidate = {
        revision,
        scope: positionMatch.positioned ? "position_matched" : "source_matched",
        ...(positionMatch.positioned
          ? {
            appliesToWindowIds: positionMatch.windowIds,
            ...(positionMatch.distance === undefined
              ? {}
              : { evidenceDistance: positionMatch.distance }),
          }
          : { evidenceDistance: 0 }),
      };
      if (revision.status === "needs_revalidate") {
        matchingNeedsRevalidate.push(candidate);
      } else {
        matchingOther.push(candidate);
      }
      continue;
    }
    if (positionMatch.positioned) continue;
    if (revision.status !== "contextual" && isGlobalFallback(revision)) {
      globalFallbacks.push({ revision, scope: "global_fallback" });
    }
  }

  matchingNeedsRevalidate.sort(compareCandidate);
  matchingOther.sort(compareCandidate);
  globalFallbacks.sort(compareCandidate);
  return {
    total: revisions.length,
    validRevisionIds,
    matchingNeedsRevalidate,
    matchingOther,
    globalFallbacks,
  };
}

function eligibleCandidates(
  groups: CandidateGroups,
  options: ResolvedOptions,
): readonly Candidate[] {
  return [
    ...groups.matchingNeedsRevalidate,
    ...groups.matchingOther,
    ...groups.globalFallbacks.slice(0, options.maxGlobalFallbackEntries),
  ];
}

function contextBundleKind(
  knowledgeKind: string,
): ContextEvidenceBundle["kind"] {
  if (knowledgeKind === "lexical_anchor" || knowledgeKind === "term_sense") {
    return "term";
  }
  if (knowledgeKind === "entity_relation") {
    return "relation";
  }
  if (knowledgeKind === "entity_identity"
    || knowledgeKind === "entity_alias_link"
    || knowledgeKind === "coreference") {
    return "entity";
  }
  if (knowledgeKind === "style_directive") {
    return "style";
  }
  return "memory";
}

const COVERAGE_ORDER = [
  "entity_identity",
  "pronoun_resolution",
  "part_whole",
  "control",
  "causality",
  "timeline",
  "viewpoint",
  "character_knowledge",
] as const satisfies readonly RiskDimension[];

function explicitCoverage(candidate: Candidate): readonly RiskDimension[] {
  const coverage = new Set<RiskDimension>();
  const payload = record(candidate.revision.payload);
  if (candidate.revision.kind === "entity_identity") {
    coverage.add("entity_identity");
  }
  if (candidate.revision.kind === "coreference") {
    coverage.add("pronoun_resolution");
  }
  if (candidate.revision.kind === "entity_relation"
    && payload !== undefined
    && nonemptyString(payload.fromEntityId) !== undefined
    && nonemptyString(payload.toEntityId) !== undefined) {
    const relationType = nonemptyString(payload.relationType);
    if (relationType === "identity") {
      coverage.add("entity_identity");
    } else if (relationType === "part_of") {
      coverage.add("entity_identity");
      coverage.add("part_whole");
    } else if (relationType === "control") {
      coverage.add("entity_identity");
      coverage.add("control");
    } else if (relationType === "causality"
      || relationType === "timeline"
      || relationType === "viewpoint"
      || relationType === "character_knowledge") {
      coverage.add(relationType);
    }
  }
  if (payload !== undefined) {
    if (Object.hasOwn(payload, "timeline") && payload.timeline !== undefined) {
      coverage.add("timeline");
    }
    if (Object.hasOwn(payload, "viewpoint") && payload.viewpoint !== undefined) {
      coverage.add("viewpoint");
    }
    if (Object.hasOwn(payload, "characterKnowledge")
      && payload.characterKnowledge !== undefined) {
      coverage.add("character_knowledge");
    }
    if (Object.hasOwn(payload, "causality") && payload.causality !== undefined) {
      coverage.add("causality");
    }
  }
  return COVERAGE_ORDER.filter((dimension) => coverage.has(dimension));
}

function candidateUtility(candidate: Candidate): number {
  const scopeUtility = candidate.scope === "position_matched"
    ? 12
    : candidate.scope === "source_matched" ? 10 : 2;
  const statusUtility = candidate.revision.status === "needs_revalidate"
    ? 4
    : candidate.revision.status === "active" ? 3 : 1;
  const payload = record(candidate.revision.payload);
  const confidence = payload !== undefined
    && typeof payload.confidence === "number"
    && Number.isFinite(payload.confidence)
    ? Math.min(1, Math.max(0, payload.confidence))
    : 0;
  const distanceUtility = candidate.evidenceDistance === undefined
    ? 0
    : 2 * Math.exp(-candidate.evidenceDistance / 12);
  return Math.round(
    (scopeUtility + statusUtility + confidence * 2 + distanceUtility)
      * 1_000_000,
  ) / 1_000_000;
}

function translationKnowledgeCandidate(
  candidate: Candidate,
  profile: SourceLanguageProfile,
): TranslationKnowledgeCandidate {
  const payload = projectedRevision(candidate);
  return {
    bundleId: `knowledge:${candidate.revision.revisionId}`,
    revisionIds: [candidate.revision.revisionId],
    kind: contextBundleKind(candidate.revision.kind),
    ...(candidate.evidenceDistance === undefined
      ? {}
      : { evidenceDistance: candidate.evidenceDistance }),
    tokenCost: KNOWLEDGE_TOKEN_ESTIMATOR.estimateJson(
      payload,
      profile,
    ).tokens,
    entryCost: 1,
    utility: candidateUtility(candidate),
    coverage: explicitCoverage(candidate),
    requires: [],
    redundancyGroup: [
      candidate.revision.kind,
      candidate.revision.normalizedSubject,
    ].join(":"),
    mandatory: candidate.revision.status === "needs_revalidate",
    payload,
  };
}

function selectedRevisionIdSet(
  selected: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (selected === undefined) {
    return undefined;
  }
  if (selected === null
    || typeof selected !== "object"
    || typeof selected[Symbol.iterator] !== "function") {
    throw new TypeError("selectedRevisionIds must be a set of revision ids");
  }
  const result = new Set<string>();
  for (const revisionId of selected) {
    const normalized = nonemptyString(revisionId);
    if (normalized === undefined) {
      throw new TypeError("selected knowledge revision id must be nonempty");
    }
    result.add(normalized);
  }
  return result;
}

export function collectTranslationKnowledgeCandidates(
  revisions: readonly unknown[],
  sourceTexts: readonly string[],
  profile: SourceLanguageProfile,
  options: TranslationKnowledgeProjectionOptions = {},
): readonly TranslationKnowledgeCandidate[] {
  const resolved = resolvedOptions(options);
  return eligibleCandidates(
    candidateGroups(revisions, sourceTexts, profile, options),
    resolved,
  ).map((candidate) => translationKnowledgeCandidate(candidate, profile));
}

/**
 * Narrow a planner-owned selection after an internal execution transform has
 * reduced the exact source sent to the provider.  This never adds knowledge:
 * it only removes revisions that are no longer applicable to the wire input.
 * Missing revision ids remain a hard error so the operation cannot conceal a
 * stale or corrupt planner decision.
 */
export function retainApplicableTranslationKnowledgeRevisionIds(
  revisions: readonly unknown[],
  sourceTexts: readonly string[],
  profile: SourceLanguageProfile,
  selectedRevisionIds: readonly string[],
  options: Omit<
    TranslationKnowledgeProjectionOptions,
    "selectedRevisionIds"
  > = {},
): readonly string[] {
  const resolved = resolvedOptions(options);
  const selected = selectedRevisionIdSet(new Set(selectedRevisionIds))
    ?? new Set<string>();
  const groups = candidateGroups(revisions, sourceTexts, profile, options);
  for (const revisionId of selected) {
    if (!groups.validRevisionIds.has(revisionId)) {
      throw new Error(
        `selected knowledge revision does not exist: ${revisionId}`,
      );
    }
  }
  if (selected.size > resolved.maxEntries) {
    throw new RangeError("selected knowledge revisions exceed entry budget");
  }
  const applicableIds = new Set(
    eligibleCandidates(groups, resolved).map((candidate) =>
      candidate.revision.revisionId),
  );
  return [...selected]
    .filter((revisionId) => applicableIds.has(revisionId))
    .sort(compareText);
}

/**
 * Produce a deterministic, request-local view of durable knowledge.  The
 * caller's complete snapshot is neither modified nor serialized wholesale.
 */
export function projectKnowledgeForTranslation(
  revisions: readonly unknown[],
  sourceTexts: readonly string[],
  profile: SourceLanguageProfile,
  options: TranslationKnowledgeProjectionOptions = {},
): TranslationKnowledgeProjection {
  const resolved = resolvedOptions(options);
  const groups = candidateGroups(revisions, sourceTexts, profile, options);
  const total = groups.total;

  const empty = projectionWithStableByteCount(total, [], resolved);
  if (empty.metadata.serializedBytes > resolved.maxSerializedBytes) {
    throw new RangeError("maxSerializedBytes cannot fit knowledge projection metadata");
  }
  const selectedRevisionIds = selectedRevisionIdSet(
    options.selectedRevisionIds,
  );
  if (selectedRevisionIds !== undefined) {
    for (const revisionId of selectedRevisionIds) {
      if (!groups.validRevisionIds.has(revisionId)) {
        throw new Error(
          `selected knowledge revision does not exist: ${revisionId}`,
        );
      }
    }
    if (selectedRevisionIds.size > resolved.maxEntries) {
      throw new RangeError("selected knowledge revisions exceed entry budget");
    }
    const applicable = eligibleCandidates(groups, resolved);
    const applicableIds = new Set(
      applicable.map((candidate) => candidate.revision.revisionId),
    );
    for (const revisionId of selectedRevisionIds) {
      if (!applicableIds.has(revisionId)) {
        throw new Error(
          `selected knowledge revision is not applicable: ${revisionId}`,
        );
      }
    }
    const selected: ProjectedKnowledgeRevision[] = [];
    for (const candidate of applicable) {
      if (!selectedRevisionIds.has(candidate.revision.revisionId)) {
        continue;
      }
      if (!appendIfWithinBounds(total, selected, candidate, resolved)) {
        throw new RangeError(
          "selected knowledge revisions exceed serialized byte budget",
        );
      }
    }
    if (selected.length !== selectedRevisionIds.size) {
      throw new Error("selected knowledge revisions are not uniquely applicable");
    }
    return projectionWithStableByteCount(total, selected, resolved);
  }

  const selected: ProjectedKnowledgeRevision[] = [];
  for (const candidate of groups.matchingNeedsRevalidate) {
    appendIfWithinBounds(total, selected, candidate, resolved);
  }

  // Literal evidence in the current source always outranks a global fallback.
  // Otherwise two unrelated terminology fallbacks could evict an identity or
  // causal fact that the current passage actually names.
  for (const candidate of groups.matchingOther) {
    appendIfWithinBounds(total, selected, candidate, resolved);
  }

  let fallbackCount = 0;
  for (const candidate of groups.globalFallbacks) {
    if (fallbackCount >= resolved.maxGlobalFallbackEntries) break;
    if (appendIfWithinBounds(total, selected, candidate, resolved)) fallbackCount += 1;
  }

  const projection = projectionWithStableByteCount(total, selected, resolved);
  if (projection.metadata.serializedBytes > resolved.maxSerializedBytes) {
    throw new Error("knowledge projection exceeds its canonical byte budget");
  }
  return projection;
}
