import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import {
  losslessBookLineage,
  type LosslessBookArtifactPaths,
  type LosslessBookLineage,
} from "../report.js";
import type { LosslessBookStore } from "../storage/lossless-book-store.js";

export type ExportVerificationIncidentCode =
  | "LINEAGE_MISSING"
  | "LINEAGE_INVALID"
  | "LINEAGE_MISMATCH"
  | "RUN_MISMATCH"
  | "EPUB_LINEAGE_MISSING"
  | "EPUB_LINEAGE_MISMATCH";

export interface ExportVerificationResult {
  schema: "v5-export-verification-1";
  runId: string;
  ok: boolean;
  incidentCodes: ExportVerificationIncidentCode[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseLineage(path: string): LosslessBookLineage {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LosslessBookLineage>;
  if (parsed.schema !== "v5-book-lineage-1"
    || typeof parsed.runId !== "string"
    || !Array.isArray(parsed.blocks)
    || !Array.isArray(parsed.missingBlockIds)) {
    throw new Error(`invalid lineage sidecar ${path}`);
  }
  return parsed as LosslessBookLineage;
}

function zipEntry(path: string, entryName: string): Buffer | undefined {
  const zip = readFileSync(path);
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0) {
      throw new Error("ZIP data descriptors are not supported for lineage verification");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    if (name === entryName) {
      if (method === 0) {
        return compressed;
      }
      if (method === 8) {
        return inflateRawSync(compressed);
      }
      throw new Error(`unsupported ZIP compression method ${method}`);
    }
    offset = dataStart + compressedSize;
  }
  return undefined;
}

export function verifyExport(
  paths: LosslessBookArtifactPaths,
  store: LosslessBookStore,
  runId: string,
): ExportVerificationResult {
  const incidents = new Set<ExportVerificationIncidentCode>();
  const expected = losslessBookLineage(store, runId);
  const expectedJson = canonical(expected);
  for (const path of [
    paths.translationLineage,
    paths.bilingualLineage,
    paths.auditLineage,
  ]) {
    try {
      const lineage = parseLineage(path);
      if (lineage.runId !== runId) {
        incidents.add("RUN_MISMATCH");
      }
      if (canonical(lineage) !== expectedJson) {
        incidents.add("LINEAGE_MISMATCH");
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        incidents.add("LINEAGE_INVALID");
      } else if (error instanceof Error && /ENOENT/u.test(error.message)) {
        incidents.add("LINEAGE_MISSING");
      } else {
        incidents.add("LINEAGE_INVALID");
      }
    }
  }
  if (paths.epub !== undefined) {
    try {
      const payload = zipEntry(paths.epub, "META-INF/v5-lineage.json");
      if (payload === undefined) {
        incidents.add("EPUB_LINEAGE_MISSING");
      } else {
        const lineage = JSON.parse(payload.toString("utf8")) as unknown;
        if (canonical(lineage) !== expectedJson) {
          incidents.add("EPUB_LINEAGE_MISMATCH");
        }
      }
    } catch {
      incidents.add("EPUB_LINEAGE_MISMATCH");
    }
  }
  const incidentCodes = [...incidents].sort();
  return {
    schema: "v5-export-verification-1",
    runId,
    ok: incidentCodes.length === 0,
    incidentCodes,
  };
}
