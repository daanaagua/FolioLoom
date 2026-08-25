import { createHash } from "node:crypto";

import { getSourceLanguageProfile } from "../language/profiles.js";
import type { BoundaryCandidate, SourceLanguageProfile } from "../language/types.js";
import {
  WeightedTokenEstimator,
  type TokenEstimationCursor,
  type TokenEstimator,
} from "./token-estimator.js";
import {
  embeddedSceneSeparatorSpans,
  normalizeSourceSceneSeparators,
  sourceTextForTranslation,
} from "./layout-separators.js";
import { hasSemanticText } from "../text/semantic-text.js";
import type {
  LosslessBlock,
  SourceInput,
  StructureAnnotation,
  UnicodeScalarMap,
} from "./types.js";
import { coordinatesFor, sourceTextFor } from "./types.js";

export interface BlockBuilderOptions {
  maxSourceTokens?: number;
  sourceVersion?: string;
  languageProfile?: SourceLanguageProfile;
  tokenEstimator?: TokenEstimator;
}

interface CandidateCut extends BoundaryCandidate {}

interface ScalarLayoutSpan {
  start: number;
  end: number;
}

interface SemanticScalarIndex {
  readonly prefixCounts: Uint32Array;
  readonly nextSemanticEnds: Int32Array;
}

const DEFAULT_MAX_SOURCE_TOKENS = 1_500;
const MAX_PARAGRAPHS_PER_BLOCK = 32;
const DEFAULT_TOKEN_ESTIMATOR = new WeightedTokenEstimator();
const GENERIC_ESTIMATOR_PROBE_SCALARS = 256;
const GENERIC_ESTIMATOR_MIN_HORIZON_SCALARS = 1_024;
const GENERIC_ESTIMATOR_MAX_HORIZON_SCALARS = 65_536;
const GENERIC_ESTIMATOR_HORIZON_PER_TOKEN = 16;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function blockId(
  sourceVersion: string,
  start: number,
  end: number,
  text: string,
): string {
  return `block-${createHash("sha256")
    .update(`${sourceVersion}\0${start}\0${end}\0${sha256(text)}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function profileFor(
  source: SourceInput,
  options: BlockBuilderOptions,
): SourceLanguageProfile {
  return options.languageProfile
    ?? (typeof source === "string" ? undefined : source.languageProfile)
    ?? getSourceLanguageProfile(
      typeof source === "string" ? undefined : source.sourceLanguage,
    );
}

function estimatorVersion(estimator: TokenEstimator): string {
  if (typeof estimator.version !== "string" || estimator.version.trim().length === 0) {
    throw new TypeError("tokenEstimator.version must be nonempty");
  }
  return estimator.version;
}

function estimateTokens(
  estimator: TokenEstimator,
  text: string,
  profile: SourceLanguageProfile,
  structuredFields: number,
): number {
  const estimate = estimator.estimateText(text, profile, { structuredFields });
  if (!Number.isSafeInteger(estimate.tokens) || estimate.tokens < 0) {
    throw new TypeError("tokenEstimator must return a non-negative safe integer token count");
  }
  if (estimate.estimatorVersion !== estimatorVersion(estimator)) {
    throw new Error("tokenEstimator returned an estimate for a different estimator version");
  }
  return estimate.tokens;
}

function estimatorCursorFor(
  estimator: TokenEstimator,
  text: string,
  profile: SourceLanguageProfile,
): TokenEstimationCursor | undefined {
  const cursor = estimator.createCursor?.(text, profile);
  if (cursor === undefined) {
    return undefined;
  }
  if (cursor === null || typeof cursor !== "object"
    || typeof cursor.maximumEndWithinBudget !== "function"
    || cursor.estimatorVersion !== estimatorVersion(estimator)) {
    throw new TypeError("tokenEstimator.createCursor returned an incompatible cursor");
  }
  return cursor;
}

function addCandidate(
  candidates: Map<number, CandidateCut>,
  candidate: BoundaryCandidate,
  sourceLength: number,
): void {
  if (!Number.isSafeInteger(candidate.scalarOffset)
    || candidate.scalarOffset <= 0
    || candidate.scalarOffset > sourceLength
    || !Number.isFinite(candidate.weight)
    || candidate.weight < 0) {
    return;
  }
  const previous = candidates.get(candidate.scalarOffset);
  if (previous === undefined
    || candidate.weight > previous.weight
    || (candidate.weight === previous.weight && candidate.kind < previous.kind)) {
    candidates.set(candidate.scalarOffset, candidate);
  }
}

function candidateCuts(
  source: SourceInput,
  annotations: readonly StructureAnnotation[],
  profile: SourceLanguageProfile,
): CandidateCut[] {
  const text = sourceTextFor(source);
  const coordinates = coordinatesFor(source);
  const strongestByOffset = new Map<number, CandidateCut>();
  addCandidate(strongestByOffset, {
    scalarOffset: coordinates.length,
    weight: 0,
    kind: "sentence",
  }, coordinates.length);
  for (const span of embeddedSceneSeparatorSpans(text)) {
    addCandidate(strongestByOffset, {
      scalarOffset: coordinates.toScalarIndex(span.utf16End),
      weight: 120,
      kind: "layout",
    }, coordinates.length);
  }
  for (const candidate of profile.collectBoundaryCandidates(text)) {
    addCandidate(strongestByOffset, candidate, coordinates.length);
  }
  for (const annotation of annotations) {
    if (!Number.isSafeInteger(annotation.start)
      || !Number.isSafeInteger(annotation.end)
      || annotation.start < 0
      || annotation.end < annotation.start
      || annotation.end > coordinates.length) {
      throw new RangeError(`structure annotation is outside canonical source: ${annotation.id}`);
    }
    const weight = Math.max(annotation.boundaryWeight, 0);
    addCandidate(strongestByOffset, {
      scalarOffset: annotation.start,
      weight,
      kind: "heading",
    }, coordinates.length);
    addCandidate(strongestByOffset, {
      scalarOffset: annotation.end,
      weight,
      kind: "heading",
    }, coordinates.length);
  }
  return [...strongestByOffset.values()].sort((left, right) => (
    left.scalarOffset - right.scalarOffset
    || right.weight - left.weight
    || left.kind.localeCompare(right.kind)
  ));
}

function scalarLayoutSpans(
  text: string,
  coordinates: UnicodeScalarMap,
): ScalarLayoutSpan[] {
  return embeddedSceneSeparatorSpans(text).map((span) => ({
    start: coordinates.toScalarIndex(span.utf16Start),
    end: coordinates.toScalarIndex(span.utf16End),
  }));
}

function scalarEpubSlotSpans(
  text: string,
  coordinates: UnicodeScalarMap,
): ScalarLayoutSpan[] {
  const spans: ScalarLayoutSpan[] = [];
  const opening = /⟦(E\d+\.\d+\.\d+)⟧/gu;
  for (const match of text.matchAll(opening)) {
    const startUtf16 = match.index;
    const closeMarker = `⟦/${match[1] ?? ""}⟧`;
    const closeUtf16 = text.indexOf(closeMarker, startUtf16 + match[0].length);
    if (closeUtf16 < 0) continue;
    spans.push({
      start: coordinates.toScalarIndex(startUtf16),
      end: coordinates.toScalarIndex(closeUtf16 + closeMarker.length),
    });
  }
  return spans;
}

function protectLayoutCut(
  end: number,
  spans: readonly ScalarLayoutSpan[],
  semanticIndex: SemanticScalarIndex,
  sourceLength: number,
): number {
  let low = 0;
  let high = spans.length - 1;
  let crossing: ScalarLayoutSpan | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle] as ScalarLayoutSpan;
    if (end < span.start) {
      high = middle - 1;
    } else if (end >= span.end) {
      low = middle + 1;
    } else {
      crossing = span;
      break;
    }
  }
  if (crossing === undefined) {
    return end;
  }
  if (end === crossing.start
    && semanticRangeHasContent(semanticIndex, crossing.end, sourceLength)) {
    return end;
  }
  return crossing.end;
}

function hasTranslatableSourceContent(text: string): boolean {
  return hasSemanticText(normalizeSourceSceneSeparators(text));
}

function buildSemanticScalarIndex(
  text: string,
  layoutSpans: readonly ScalarLayoutSpan[],
): SemanticScalarIndex {
  const scalars = [...text];
  const prefixCounts = new Uint32Array(scalars.length + 1);
  const semantic = new Uint8Array(scalars.length);
  let layoutIndex = 0;
  for (let index = 0; index < scalars.length; index += 1) {
    while ((layoutSpans[layoutIndex]?.end ?? Number.POSITIVE_INFINITY) <= index) {
      layoutIndex += 1;
    }
    const layout = layoutSpans[layoutIndex];
    const insideLayout = layout !== undefined && index >= layout.start && index < layout.end;
    semantic[index] = !insideLayout && hasSemanticText(scalars[index] as string) ? 1 : 0;
    prefixCounts[index + 1] = (prefixCounts[index] as number) + semantic[index];
  }
  const nextSemanticEnds = new Int32Array(scalars.length + 1);
  nextSemanticEnds.fill(-1);
  let nextEnd = -1;
  for (let index = scalars.length - 1; index >= 0; index -= 1) {
    if (semantic[index] === 1) {
      nextEnd = index + 1;
    }
    nextSemanticEnds[index] = nextEnd;
  }
  return { prefixCounts, nextSemanticEnds };
}

function semanticRangeHasContent(
  index: SemanticScalarIndex,
  start: number,
  end: number,
): boolean {
  return (index.prefixCounts[end] as number) > (index.prefixCounts[start] as number);
}

function maximumEndWithBoundedFallback(
  coordinates: UnicodeScalarMap,
  cursor: number,
  maxSourceTokens: number,
  profile: SourceLanguageProfile,
  estimator: TokenEstimator,
  structuredFields: number,
): number {
  const remaining = coordinates.length - cursor;
  const horizon = Math.min(
    remaining,
    Math.max(
      GENERIC_ESTIMATOR_MIN_HORIZON_SCALARS,
      Math.min(
        GENERIC_ESTIMATOR_MAX_HORIZON_SCALARS,
        maxSourceTokens * GENERIC_ESTIMATOR_HORIZON_PER_TOKEN,
      ),
    ),
  );
  const probeWidth = Math.min(horizon, GENERIC_ESTIMATOR_PROBE_SCALARS);
  const probeEnd = cursor + probeWidth;
  const probeTokens = estimateTokens(
    estimator,
    coordinates.slice(cursor, probeEnd),
    profile,
    structuredFields,
  );
  let high = probeEnd;
  if (probeTokens <= maxSourceTokens) {
    const inferredWidth = probeTokens === 0
      ? horizon
      : Math.ceil(maxSourceTokens / probeTokens * probeWidth * 1.15);
    high = cursor + Math.min(
      horizon,
      Math.max(probeWidth, inferredWidth),
    );
    const highTokens = estimateTokens(
      estimator,
      coordinates.slice(cursor, high),
      profile,
      structuredFields,
    );
    if (highTokens <= maxSourceTokens) {
      return high;
    }
  }
  let low = cursor + 1;
  let best = cursor;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const tokens = estimateTokens(
      estimator,
      coordinates.slice(cursor, middle),
      profile,
      structuredFields,
    );
    if (tokens <= maxSourceTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best === cursor ? Math.min(cursor + 1, coordinates.length) : best;
}

function maximumEndWithinBudget(
  coordinates: UnicodeScalarMap,
  cursor: number,
  maxSourceTokens: number,
  profile: SourceLanguageProfile,
  estimator: TokenEstimator,
  estimatorCursor: TokenEstimationCursor | undefined,
  structuredFields: number,
): number {
  if (estimatorCursor === undefined) {
    return maximumEndWithBoundedFallback(
      coordinates,
      cursor,
      maxSourceTokens,
      profile,
      estimator,
      structuredFields,
    );
  }
  const end = estimatorCursor.maximumEndWithinBudget(
    cursor,
    maxSourceTokens,
    { structuredFields },
  );
  if (!Number.isSafeInteger(end) || end <= cursor || end > coordinates.length) {
    throw new RangeError("tokenEstimator cursor returned a source range outside canonical text");
  }
  return end;
}

function preferredCandidateEnd(
  cuts: readonly CandidateCut[],
  startIndex: number,
  cursor: number,
  maximumEnd: number,
): number | undefined {
  let selected: CandidateCut | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  const width = Math.max(1, maximumEnd - cursor);
  for (let index = startIndex; index < cuts.length; index += 1) {
    const candidate = cuts[index] as CandidateCut;
    if (candidate.scalarOffset > maximumEnd) {
      break;
    }
    // Fill most of the window, but let a strong paragraph/heading win nearby.
    const progress = (candidate.scalarOffset - cursor) / width;
    const score = progress + Math.min(0.15, candidate.weight / 100 * 0.15);
    if (score > bestScore
      || (score === bestScore && (selected === undefined
        || candidate.scalarOffset > selected.scalarOffset))) {
      selected = candidate;
      bestScore = score;
    }
  }
  return selected?.scalarOffset;
}

export function buildLosslessBlocks(
  source: SourceInput,
  annotations: readonly StructureAnnotation[],
  options: BlockBuilderOptions = {},
): LosslessBlock[] {
  const text = sourceTextFor(source);
  const coordinates = coordinatesFor(source);
  if (coordinates.text !== text) {
    throw new Error("source coordinate map does not belong to source text");
  }
  if (coordinates.length === 0) {
    return [];
  }
  if (!hasTranslatableSourceContent(text)) {
    throw new RangeError("source contains no translatable content");
  }
  const maxSourceTokens = positiveInteger(
    options.maxSourceTokens ?? DEFAULT_MAX_SOURCE_TOKENS,
    "maxSourceTokens",
  );
  const sourceVersion = options.sourceVersion
    ?? (typeof source === "string" ? undefined : source.sourceVersion)
    ?? sha256(text);
  if (sourceVersion.trim().length === 0) {
    throw new TypeError("sourceVersion must not be empty");
  }
  const profile = profileFor(source, options);
  const estimator = options.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR;
  const estimatorVersionValue = estimatorVersion(estimator);
  const estimationCursor = estimatorCursorFor(estimator, text, profile);
  const cuts = candidateCuts(source, annotations, profile);
  const softCuts = cuts.filter((candidate) => candidate.kind !== "layout");
  const layoutSpans = scalarLayoutSpans(text, coordinates);
  const epubSlotSpans = scalarEpubSlotSpans(text, coordinates);
  const semanticIndex = buildSemanticScalarIndex(text, layoutSpans);
  const layoutEnds = [...new Set(
    cuts.filter((candidate) => candidate.kind === "layout")
      .map((candidate) => candidate.scalarOffset),
  )].filter((end) => end > 0);
  const paragraphEnds = [...new Set(
    cuts.filter((candidate) => candidate.kind === "paragraph")
      .map((candidate) => candidate.scalarOffset),
  )].filter((end) => end > 0);
  const sortedAnnotations = [...annotations].sort((left, right) => (
    left.start - right.start || left.end - right.end || left.id.localeCompare(right.id)
  ));
  const structureStarts = [...new Set(
    sortedAnnotations.map((annotation) => annotation.start),
  )].filter((start) => start > 0);
  // Reserve one field whenever the source has structural metadata so final block
  // counts cannot exceed a prompt budget merely because a heading is attached.
  const budgetStructuredFields = sortedAnnotations.length === 0 ? 0 : 1;
  const blocks: LosslessBlock[] = [];
  let cursor = 0;
  let structureIndex = 0;
  let layoutIndex = 0;
  let paragraphIndex = 0;
  let candidateIndex = 0;
  let annotationIndex = 0;
  let activeStructure: StructureAnnotation | undefined;
  while (cursor < coordinates.length) {
    const maximumEnd = maximumEndWithinBudget(
      coordinates,
      cursor,
      maxSourceTokens,
      profile,
      estimator,
      estimationCursor,
      budgetStructuredFields,
    );
    while ((softCuts[candidateIndex]?.scalarOffset ?? Number.POSITIVE_INFINITY) <= cursor) {
      candidateIndex += 1;
    }
    while ((structureStarts[structureIndex] ?? Number.POSITIVE_INFINITY) <= cursor) {
      structureIndex += 1;
    }
    while ((layoutEnds[layoutIndex] ?? Number.POSITIVE_INFINITY) <= cursor
      || (layoutEnds[layoutIndex] !== undefined
        && !semanticRangeHasContent(
          semanticIndex,
          cursor,
          layoutEnds[layoutIndex] as number,
        ))) {
      layoutIndex += 1;
    }
    while ((paragraphEnds[paragraphIndex] ?? Number.POSITIVE_INFINITY) <= cursor) {
      paragraphIndex += 1;
    }
    const nextStructureStart = structureStarts[structureIndex];
    const nextLayoutEnd = layoutEnds[layoutIndex];
    const paragraphCapEnd = paragraphEnds[
      paragraphIndex + MAX_PARAGRAPHS_PER_BLOCK - 1
    ];
    const nextHardBoundary = [
      nextStructureStart,
      nextLayoutEnd,
      paragraphCapEnd,
    ]
      .filter((value): value is number => value !== undefined && value <= maximumEnd)
      .sort((left, right) => left - right)[0];
    let end = nextHardBoundary
      ?? preferredCandidateEnd(softCuts, candidateIndex, cursor, maximumEnd)
      ?? maximumEnd;
    end = protectLayoutCut(end, layoutSpans, semanticIndex, coordinates.length);
    end = protectLayoutCut(end, epubSlotSpans, semanticIndex, coordinates.length);
    if (!semanticRangeHasContent(semanticIndex, cursor, end)) {
      const nextSemanticEnd = semanticIndex.nextSemanticEnds[end] as number;
      if (nextSemanticEnd < 0) {
        throw new RangeError("source contains a trailing nonsemantic fragment without a prose block");
      }
      end = protectLayoutCut(
        nextSemanticEnd,
        layoutSpans,
        semanticIndex,
        coordinates.length,
      );
      end = protectLayoutCut(
        end,
        epubSlotSpans,
        semanticIndex,
        coordinates.length,
      );
    }
    if (end < coordinates.length
      && !semanticRangeHasContent(semanticIndex, end, coordinates.length)) {
      end = coordinates.length;
    }
    const blockText = coordinates.slice(cursor, end);
    const sourceHash = sha256(blockText);
    while ((sortedAnnotations[annotationIndex]?.start ?? Number.POSITIVE_INFINITY) < end) {
      activeStructure = sortedAnnotations[annotationIndex] as StructureAnnotation;
      annotationIndex += 1;
    }
    const structure = activeStructure;
    blocks.push({
      id: blockId(sourceVersion, cursor, end, blockText),
      sourceVersion,
      canonicalStart: cursor,
      canonicalEnd: end,
      sourceText: blockText,
      sourceHash,
      globalIndex: blocks.length,
      tokenCount: estimateTokens(
        estimator,
        sourceTextForTranslation(blockText),
        profile,
        structure === undefined ? 0 : 1,
      ),
      estimatorVersion: estimatorVersionValue,
      structureId: structure?.id ?? null,
      structureTitle: structure?.title ?? null,
    });
    cursor = end;
  }
  return blocks;
}
