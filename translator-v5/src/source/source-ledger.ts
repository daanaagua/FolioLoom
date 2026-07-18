import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import {
  getSourceLanguageProfile,
  supportedSourceLanguageIds,
} from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import type {
  CanonicalSegment,
  ExcludedRawRange,
  ScalarSource,
} from "./types.js";
import { UnicodeScalarMap } from "./types.js";

const SCHEMA_VERSION = "v5-source-ledger-1";
const COORDINATE_UNIT = "unicode_scalar";

export const ALLOWED_EXCLUDED_RAW_POLICIES: ReadonlySet<string> = new Set([
  "UTF8_BOM",
  "UTF16_LE_BOM",
  "UTF16_BE_BOM",
  "UTF32_LE_BOM",
  "UTF32_BE_BOM",
  "EPUB_NON_SPINE_DATA",
  "DOCX_NON_DOCUMENT_DATA",
]);

export type SourceIntegrityCode =
  | "MANIFEST_INVALID"
  | "MANIFEST_SCHEMA_UNSUPPORTED"
  | "COORDINATE_UNIT_UNSUPPORTED"
  | "MANIFEST_PATH_INVALID"
  | "RAW_SIZE_MISMATCH"
  | "RAW_HASH_MISMATCH"
  | "CANONICAL_HASH_MISMATCH"
  | "CANONICAL_UTF8_INVALID"
  | "CANONICAL_CHAR_COUNT_MISMATCH"
  | "CANONICAL_SEGMENTS_INVALID"
  | "EXCLUDED_POLICY_UNKNOWN"
  | "EXCLUDED_RANGE_INVALID";

export class SourceIntegrityError extends Error {
  readonly code: SourceIntegrityCode;

  constructor(code: SourceIntegrityCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SourceIntegrityError";
    this.code = code;
  }
}

function sha256(payload: string | Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceIntegrityError("MANIFEST_INVALID", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  manifest: Record<string, unknown>,
  name: string,
): string {
  const value = manifest[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new SourceIntegrityError("MANIFEST_INVALID", `${name} must be a non-empty string`);
  }
  return value;
}

function integerField(
  input: Record<string, unknown>,
  name: string,
): number {
  const value = input[name];
  if (!Number.isSafeInteger(value)) {
    throw new SourceIntegrityError("MANIFEST_INVALID", `${name} must be a safe integer`);
  }
  return value as number;
}

function manifestMemberPath(
  manifestDirectory: string,
  member: string,
): string {
  const target = resolve(manifestDirectory, member);
  const child = relative(manifestDirectory, target);
  if (child === ""
    || child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)) {
    throw new SourceIntegrityError(
      "MANIFEST_PATH_INVALID",
      `manifest member escapes its directory: ${member}`,
    );
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch (error) {
    throw new SourceIntegrityError(
      "MANIFEST_PATH_INVALID",
      error instanceof Error ? error.message : `manifest member cannot be resolved: ${member}`,
    );
  }
  const realChild = relative(manifestDirectory, realTarget);
  if (realChild === ""
    || realChild === ".."
    || realChild.startsWith(`..${sep}`)
    || isAbsolute(realChild)) {
    throw new SourceIntegrityError(
      "MANIFEST_PATH_INVALID",
      `manifest member escapes its directory through a link: ${member}`,
    );
  }
  return realTarget;
}

function sourceVersionFor(
  manifest: Record<string, unknown>,
  canonicalSegments: readonly CanonicalSegment[],
  excludedRawRanges: readonly ExcludedRawRange[],
  languageProfile?: SourceLanguageProfile,
): string {
  const identity = [
    ["schema_version", stringField(manifest, "schema_version")],
    ["raw_sha256", stringField(manifest, "raw_sha256")],
    ["canonical_sha256", stringField(manifest, "canonical_sha256")],
    ["source_format", stringField(manifest, "source_format")],
    ["encoding", stringField(manifest, "encoding")],
    ["extractor", stringField(manifest, "extractor")],
    ["canonical_segments", canonicalSegments.map((segment) => [
      ["canonical_start", segment.canonicalStart],
      ["canonical_end", segment.canonicalEnd],
      ["origin_kind", segment.originKind],
      ["origin_ref", segment.originRef],
      ["transformation", segment.transformation],
      ["raw_start", segment.rawStart ?? null],
      ["raw_end", segment.rawEnd ?? null],
    ])],
    ["excluded_raw_ranges", excludedRawRanges.map((range) => [
      ["raw_start", range.rawStart],
      ["raw_end", range.rawEnd],
      ["policy", range.policy],
    ])],
  ];
  if (languageProfile !== undefined) {
    identity.push(
      ["source_language", languageProfile.id],
      ["source_language_profile_version", languageProfile.version],
    );
  }
  return sha256(JSON.stringify(identity));
}

function languageForManifest(manifest: Record<string, unknown>): {
  profile: SourceLanguageProfile;
  compatibilityMode: boolean;
} {
  const value = manifest.sourceLanguage;
  if (value === undefined) {
    return {
      profile: getSourceLanguageProfile("en"),
      compatibilityMode: true,
    };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SourceIntegrityError(
      "MANIFEST_INVALID",
      "sourceLanguage must be a supported non-empty language id",
    );
  }
  const normalized = value.trim().toLocaleLowerCase().split("-", 1)[0] as string;
  if (!supportedSourceLanguageIds().includes(normalized)) {
    throw new SourceIntegrityError(
      "MANIFEST_INVALID",
      `unsupported sourceLanguage: ${value}`,
    );
  }
  return {
    profile: getSourceLanguageProfile(normalized),
    compatibilityMode: false,
  };
}

function validateSegments(
  input: unknown,
  canonicalChars: number,
  rawSize: number,
): CanonicalSegment[] {
  if (!Array.isArray(input)) {
    throw new SourceIntegrityError(
      "CANONICAL_SEGMENTS_INVALID",
      "canonical_segments must be an array",
    );
  }
  const segments: CanonicalSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < input.length; index += 1) {
    let item: Record<string, unknown>;
    try {
      item = record(input[index], `canonical_segments[${index}]`);
    } catch (error) {
      throw new SourceIntegrityError(
        "CANONICAL_SEGMENTS_INVALID",
        error instanceof Error ? error.message : `invalid segment ${index}`,
      );
    }
    const start = item.canonical_start;
    const end = item.canonical_end;
    if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start !== cursor
      || (end as number) < (start as number)
      || (end as number) > canonicalChars) {
      throw new SourceIntegrityError(
        "CANONICAL_SEGMENTS_INVALID",
        `segment ${index} does not continue scalar range at ${cursor}`,
      );
    }
    const originKind = item.origin_kind;
    const originRef = item.origin_ref;
    const transformation = item.transformation;
    if (typeof originKind !== "string" || originKind.length === 0
      || typeof originRef !== "string" || originRef.length === 0
      || typeof transformation !== "string" || transformation.length === 0) {
      throw new SourceIntegrityError(
        "CANONICAL_SEGMENTS_INVALID",
        `segment ${index} has invalid provenance`,
      );
    }
    const rawStart = item.raw_start;
    const rawEnd = item.raw_end;
    if ((rawStart !== undefined || rawEnd !== undefined)
      && (!Number.isSafeInteger(rawStart)
        || !Number.isSafeInteger(rawEnd)
        || (rawStart as number) < 0
        || (rawEnd as number) < (rawStart as number)
        || (rawEnd as number) > rawSize)) {
      throw new SourceIntegrityError(
        "CANONICAL_SEGMENTS_INVALID",
        `segment ${index} has invalid raw range`,
      );
    }
    segments.push({
      canonicalStart: start as number,
      canonicalEnd: end as number,
      originKind,
      originRef,
      transformation,
      ...(rawStart === undefined ? {} : { rawStart: rawStart as number }),
      ...(rawEnd === undefined ? {} : { rawEnd: rawEnd as number }),
    });
    cursor = end as number;
  }
  if (cursor !== canonicalChars) {
    throw new SourceIntegrityError(
      "CANONICAL_SEGMENTS_INVALID",
      `segments stop at ${cursor}, expected ${canonicalChars}`,
    );
  }
  return segments;
}

function validateExcludedRanges(
  input: unknown,
  rawSize: number,
): ExcludedRawRange[] {
  if (!Array.isArray(input)) {
    throw new SourceIntegrityError(
      "EXCLUDED_RANGE_INVALID",
      "excluded_raw_ranges must be an array",
    );
  }
  const ranges: ExcludedRawRange[] = [];
  let previousEnd = 0;
  for (let index = 0; index < input.length; index += 1) {
    const item = record(input[index], `excluded_raw_ranges[${index}]`);
    const policy = item.policy;
    if (typeof policy !== "string"
      || !ALLOWED_EXCLUDED_RAW_POLICIES.has(policy)) {
      throw new SourceIntegrityError(
        "EXCLUDED_POLICY_UNKNOWN",
        `unknown policy at excluded_raw_ranges[${index}]: ${String(policy)}`,
      );
    }
    const start = item.raw_start;
    const end = item.raw_end;
    if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || (start as number) < previousEnd
      || (end as number) <= (start as number)
      || (end as number) > rawSize) {
      throw new SourceIntegrityError(
        "EXCLUDED_RANGE_INVALID",
        `invalid excluded raw range at index ${index}`,
      );
    }
    ranges.push({
      rawStart: start as number,
      rawEnd: end as number,
      policy,
    });
    previousEnd = end as number;
  }
  return ranges;
}

export class SourceLedger implements ScalarSource {
  readonly manifestPath: string;
  readonly rawPath: string;
  readonly canonicalPath: string;
  readonly sourceText: string;
  readonly sourceVersion: string;
  readonly sourceLanguage: string;
  readonly sourceLanguageCompatibilityMode: boolean;
  readonly languageProfile: SourceLanguageProfile;
  readonly canonicalChars: number;
  readonly canonicalSegments: readonly CanonicalSegment[];
  readonly excludedRawRanges: readonly ExcludedRawRange[];
  readonly coordinates: UnicodeScalarMap;

  private constructor(options: {
    manifestPath: string;
    rawPath: string;
    canonicalPath: string;
    sourceText: string;
    sourceVersion: string;
    languageProfile: SourceLanguageProfile;
    sourceLanguageCompatibilityMode: boolean;
    canonicalSegments: CanonicalSegment[];
    excludedRawRanges: ExcludedRawRange[];
    coordinates: UnicodeScalarMap;
  }) {
    this.manifestPath = options.manifestPath;
    this.rawPath = options.rawPath;
    this.canonicalPath = options.canonicalPath;
    this.sourceText = options.sourceText;
    this.sourceVersion = options.sourceVersion;
    this.languageProfile = options.languageProfile;
    this.sourceLanguage = options.languageProfile.id;
    this.sourceLanguageCompatibilityMode = options.sourceLanguageCompatibilityMode;
    this.canonicalSegments = options.canonicalSegments;
    this.excludedRawRanges = options.excludedRawRanges;
    this.coordinates = options.coordinates;
    this.canonicalChars = options.coordinates.length;
  }

  static open(manifestPath: string): SourceLedger {
    const resolvedManifestPath = realpathSync(resolve(manifestPath));
    let manifest: Record<string, unknown>;
    try {
      manifest = record(
        JSON.parse(readFileSync(resolvedManifestPath, "utf8")) as unknown,
        "manifest",
      );
    } catch (error) {
      if (error instanceof SourceIntegrityError) {
        throw error;
      }
      throw new SourceIntegrityError(
        "MANIFEST_INVALID",
        error instanceof Error ? error.message : "manifest cannot be parsed",
      );
    }
    if (manifest.schema_version !== SCHEMA_VERSION) {
      throw new SourceIntegrityError(
        "MANIFEST_SCHEMA_UNSUPPORTED",
        `expected ${SCHEMA_VERSION}, got ${String(manifest.schema_version)}`,
      );
    }
    if (manifest.coordinate_unit !== COORDINATE_UNIT) {
      throw new SourceIntegrityError(
        "COORDINATE_UNIT_UNSUPPORTED",
        `expected ${COORDINATE_UNIT}, got ${String(manifest.coordinate_unit)}`,
      );
    }
    const directory = dirname(resolvedManifestPath);
    const rawPath = manifestMemberPath(directory, stringField(manifest, "raw_path"));
    const canonicalPath = manifestMemberPath(
      directory,
      stringField(manifest, "canonical_path"),
    );
    const raw = readFileSync(rawPath);
    const expectedRawSize = integerField(manifest, "raw_size");
    if (raw.length !== expectedRawSize) {
      throw new SourceIntegrityError(
        "RAW_SIZE_MISMATCH",
        `expected ${expectedRawSize} raw bytes, got ${raw.length}`,
      );
    }
    const rawHash = sha256(raw);
    if (rawHash !== stringField(manifest, "raw_sha256")) {
      throw new SourceIntegrityError("RAW_HASH_MISMATCH", "raw SHA-256 does not match");
    }

    const canonical = readFileSync(canonicalPath);
    const canonicalHash = sha256(canonical);
    if (canonicalHash !== stringField(manifest, "canonical_sha256")) {
      throw new SourceIntegrityError(
        "CANONICAL_HASH_MISMATCH",
        "canonical SHA-256 does not match",
      );
    }
    let sourceText: string;
    try {
      sourceText = new TextDecoder("utf-8", { fatal: true }).decode(canonical);
    } catch (error) {
      throw new SourceIntegrityError(
        "CANONICAL_UTF8_INVALID",
        error instanceof Error ? error.message : "canonical source is not UTF-8",
      );
    }
    const coordinates = new UnicodeScalarMap(sourceText);
    const expectedChars = integerField(manifest, "canonical_chars");
    if (coordinates.length !== expectedChars) {
      throw new SourceIntegrityError(
        "CANONICAL_CHAR_COUNT_MISMATCH",
        `expected ${expectedChars} scalars, got ${coordinates.length}`,
      );
    }
    const canonicalSegments = validateSegments(
      manifest.canonical_segments,
      expectedChars,
      raw.length,
    );
    const excludedRawRanges = validateExcludedRanges(
      manifest.excluded_raw_ranges,
      raw.length,
    );
    const language = languageForManifest(manifest);
    const sourceVersion = sourceVersionFor(
      manifest,
      canonicalSegments,
      excludedRawRanges,
      language.compatibilityMode ? undefined : language.profile,
    );

    return new SourceLedger({
      manifestPath: resolvedManifestPath,
      rawPath,
      canonicalPath,
      sourceText,
      sourceVersion,
      languageProfile: language.profile,
      sourceLanguageCompatibilityMode: language.compatibilityMode,
      canonicalSegments,
      excludedRawRanges,
      coordinates,
    });
  }

  slice(start: number, end: number): string {
    return this.coordinates.slice(start, end);
  }
}
