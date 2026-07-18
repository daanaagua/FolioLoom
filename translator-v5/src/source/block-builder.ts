import { createHash } from "node:crypto";

import type {
  LosslessBlock,
  SourceInput,
  StructureAnnotation,
} from "./types.js";
import { coordinatesFor, sourceTextFor } from "./types.js";

export interface BlockBuilderOptions {
  maxSourceTokens?: number;
  sourceVersion?: string;
}

const DEFAULT_MAX_SOURCE_TOKENS = 1_500;
const APPROXIMATE_SCALARS_PER_TOKEN = 4;

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

function estimateTokens(scalarCount: number): number {
  return Math.max(1, Math.ceil(scalarCount / APPROXIMATE_SCALARS_PER_TOKEN));
}

function candidateCuts(
  source: SourceInput,
  annotations: readonly StructureAnnotation[],
): number[] {
  const text = sourceTextFor(source);
  const coordinates = coordinatesFor(source);
  const cuts = new Set<number>([coordinates.length]);
  for (const pattern of [
    /(?:\r\n|\r|\n)[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)+/gu,
    /[.!?。！？](?:["'”’）】])?(?=\s|$)/gu,
  ]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) {
        cuts.add(coordinates.toScalarIndex(match.index + match[0].length));
      }
    }
  }
  for (const annotation of annotations) {
    if (!Number.isSafeInteger(annotation.start)
      || !Number.isSafeInteger(annotation.end)
      || annotation.start < 0
      || annotation.end < annotation.start
      || annotation.end > coordinates.length) {
      throw new RangeError(`structure annotation is outside canonical source: ${annotation.id}`);
    }
    cuts.add(annotation.start);
    cuts.add(annotation.end);
  }
  return [...cuts].sort((left, right) => left - right);
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
  const cuts = candidateCuts(source, annotations);
  const sortedAnnotations = [...annotations].sort((left, right) => (
    left.start - right.start || left.end - right.end || left.id.localeCompare(right.id)
  ));
  const structureStarts = [...new Set(
    sortedAnnotations.map((annotation) => annotation.start),
  )].filter((start) => start > 0);
  const hardWidth = maxSourceTokens * APPROXIMATE_SCALARS_PER_TOKEN;
  const blocks: LosslessBlock[] = [];
  let cursor = 0;
  let structureIndex = 0;
  while (cursor < coordinates.length) {
    const hardEnd = Math.min(coordinates.length, cursor + hardWidth);
    let end = cursor;
    while ((structureStarts[structureIndex] ?? Number.POSITIVE_INFINITY) <= cursor) {
      structureIndex += 1;
    }
    const nextStructureStart = structureStarts[structureIndex];
    if (nextStructureStart !== undefined && nextStructureStart <= hardEnd) {
      end = nextStructureStart;
    } else {
      for (const candidate of cuts) {
        if (candidate > hardEnd) {
          break;
        }
        if (candidate > cursor) {
          end = candidate;
        }
      }
    }
    if (end === cursor) {
      end = hardEnd;
    }
    const blockText = coordinates.slice(cursor, end);
    const sourceHash = sha256(blockText);
    const structure = sortedAnnotations
      .filter((annotation) => annotation.start < end)
      .at(-1);
    blocks.push({
      id: blockId(sourceVersion, cursor, end, blockText),
      sourceVersion,
      canonicalStart: cursor,
      canonicalEnd: end,
      sourceText: blockText,
      sourceHash,
      globalIndex: blocks.length,
      tokenCount: estimateTokens(end - cursor),
      structureId: structure?.id ?? null,
      structureTitle: structure?.title ?? null,
    });
    cursor = end;
  }
  return blocks;
}
