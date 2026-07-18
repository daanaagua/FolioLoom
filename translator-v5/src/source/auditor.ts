import { createHash } from "node:crypto";

import type {
  AuditIncident,
  AuditReport,
  LosslessBlock,
  SourceInput,
} from "./types.js";
import { coordinatesFor, sourceTextFor } from "./types.js";

export interface AuditOptions {
  sourceVersion?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function expectedBlockId(block: LosslessBlock, actualText: string): string {
  const sourceHash = sha256(actualText);
  return `block-${createHash("sha256")
    .update(
      `${block.sourceVersion}\0${block.canonicalStart}\0${block.canonicalEnd}\0${sourceHash}`,
    )
    .digest("hex")
    .slice(0, 20)}`;
}

function validRange(block: LosslessBlock, sourceChars: number): boolean {
  return Number.isSafeInteger(block.canonicalStart)
    && Number.isSafeInteger(block.canonicalEnd)
    && block.canonicalStart >= 0
    && block.canonicalEnd > block.canonicalStart
    && block.canonicalEnd <= sourceChars;
}

export function auditSourceCoverage(
  source: SourceInput,
  input: readonly LosslessBlock[],
  options: AuditOptions = {},
): AuditReport {
  const text = sourceTextFor(source);
  const coordinates = coordinatesFor(source);
  if (coordinates.text !== text) {
    throw new Error("source coordinate map does not belong to source text");
  }
  const sourceChars = coordinates.length;
  const sourceVersion = options.sourceVersion
    ?? (typeof source === "string" ? undefined : source.sourceVersion)
    ?? sha256(text);
  const blocks = [...input].sort((left, right) => (
    left.canonicalStart - right.canonicalStart
    || left.canonicalEnd - right.canonicalEnd
    || left.id.localeCompare(right.id)
  ));
  const coverageIncidents: AuditIncident[] = [];
  const contentIncidents: AuditIncident[] = [];
  let cursor = 0;
  let coveredChars = 0;

  for (const block of blocks) {
    if (!validRange(block, sourceChars)) {
      coverageIncidents.push({
        code: "SOURCE_SPAN_INVALID",
        start: block.canonicalStart,
        end: block.canonicalEnd,
        blockId: block.id,
      });
      continue;
    }
    if (block.canonicalStart > cursor) {
      coverageIncidents.push({
        code: "SOURCE_SPAN_GAP",
        start: cursor,
        end: block.canonicalStart,
      });
    }
    if (block.canonicalStart < cursor) {
      coverageIncidents.push({
        code: "SOURCE_SPAN_OVERLAP",
        start: block.canonicalStart,
        end: Math.min(cursor, block.canonicalEnd),
        blockId: block.id,
      });
    }
    if (block.canonicalEnd > cursor) {
      coveredChars += block.canonicalEnd - Math.max(cursor, block.canonicalStart);
      cursor = block.canonicalEnd;
    }
  }
  if (cursor < sourceChars) {
    coverageIncidents.push({
      code: "SOURCE_SPAN_GAP",
      start: cursor,
      end: sourceChars,
    });
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as LosslessBlock;
    if (block.sourceVersion !== sourceVersion) {
      contentIncidents.push({
        code: "SOURCE_VERSION_MISMATCH",
        start: block.canonicalStart,
        end: block.canonicalEnd,
        blockId: block.id,
      });
    }
    if (block.globalIndex !== index) {
      contentIncidents.push({
        code: "BLOCK_ORDER_INVALID",
        start: block.canonicalStart,
        end: block.canonicalEnd,
        blockId: block.id,
        detail: `expected globalIndex ${index}, got ${block.globalIndex}`,
      });
    }
    if (!validRange(block, sourceChars)) {
      continue;
    }
    const actualText = coordinates.slice(block.canonicalStart, block.canonicalEnd);
    if (actualText !== block.sourceText) {
      contentIncidents.push({
        code: "SOURCE_TEXT_MISMATCH",
        start: block.canonicalStart,
        end: block.canonicalEnd,
        blockId: block.id,
      });
    }
    if (sha256(actualText) !== block.sourceHash) {
      contentIncidents.push({
        code: "SOURCE_HASH_MISMATCH",
        start: block.canonicalStart,
        end: block.canonicalEnd,
        blockId: block.id,
      });
    }
    if (expectedBlockId(block, actualText) !== block.id) {
      contentIncidents.push({
        code: "BLOCK_ID_MISMATCH",
        start: block.canonicalStart,
        end: block.canonicalEnd,
        blockId: block.id,
      });
    }
  }

  const incidents = [...coverageIncidents, ...contentIncidents];
  return {
    ok: incidents.length === 0,
    sourceChars,
    coveredChars,
    incidents,
  };
}
