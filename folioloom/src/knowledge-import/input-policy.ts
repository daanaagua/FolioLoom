import { extname } from "node:path";

import type { KnowledgeImportFormat } from "./types.js";

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_COLUMNS = 256;
export const MAX_IMPORT_CELL_SCALARS = 8_192;
export const MAX_IMPORT_NESTING = 64;
export const IMPORT_SAMPLE_ROWS = 50;
export const MAX_XLSX_ENTRIES = 10_000;
export const MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_XLSX_ENTRY_RATIO = 100;

export class KnowledgeImportInputError extends Error {
  readonly name = "KnowledgeImportInputError";

  constructor(
    readonly code: string,
    message: string,
    readonly location = "$",
  ) {
    super(`${code} at ${location}: ${message}`);
  }
}

const IMPORT_FORMATS: Readonly<Record<string, KnowledgeImportFormat | undefined>> =
  Object.freeze({
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".csv": "csv",
    ".xlsx": "xlsx",
  });

export function inspectImportPath(fileName: string): {
  readonly fileName: string;
  readonly format: KnowledgeImportFormat;
} {
  const extension = extname(fileName).toLocaleLowerCase("en");
  const format = IMPORT_FORMATS[extension];
  if (format === undefined) {
    throw new KnowledgeImportInputError(
      "KNOWLEDGE_IMPORT_FORMAT_UNSUPPORTED",
      "expected .json, .yaml, .yml, .csv, or .xlsx",
      fileName,
    );
  }
  return Object.freeze({ fileName, format });
}

function requireNonNegativeInteger(value: number, code: string, location: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KnowledgeImportInputError(code, "value must be a non-negative safe integer", location);
  }
}

export function enforceImportFileSize(bytes: number, location = "$"): void {
  requireNonNegativeInteger(bytes, "KNOWLEDGE_IMPORT_SIZE_INVALID", location);
  if (bytes > MAX_IMPORT_BYTES) {
    throw new KnowledgeImportInputError(
      "KNOWLEDGE_IMPORT_TOO_LARGE",
      `file size ${bytes} exceeds ${MAX_IMPORT_BYTES} bytes`,
      location,
    );
  }
}

export function validateRowCount(rows: number, location = "$"): void {
  requireNonNegativeInteger(rows, "KNOWLEDGE_IMPORT_ROW_COUNT_INVALID", location);
  if (rows > MAX_IMPORT_ROWS) {
    throw new KnowledgeImportInputError(
      "KNOWLEDGE_IMPORT_ROW_LIMIT",
      `row count ${rows} exceeds ${MAX_IMPORT_ROWS}`,
      location,
    );
  }
}

export function validateColumnCount(columns: number, location = "$"): void {
  requireNonNegativeInteger(columns, "KNOWLEDGE_IMPORT_COLUMN_COUNT_INVALID", location);
  if (columns > MAX_IMPORT_COLUMNS) {
    throw new KnowledgeImportInputError(
      "KNOWLEDGE_IMPORT_COLUMN_LIMIT",
      `column count ${columns} exceeds ${MAX_IMPORT_COLUMNS}`,
      location,
    );
  }
}

export function validateCellScalarCount(value: string, location = "$"): void {
  let scalars = 0;
  for (const _scalar of value) {
    scalars += 1;
    if (scalars > MAX_IMPORT_CELL_SCALARS) {
      throw new KnowledgeImportInputError(
        "KNOWLEDGE_IMPORT_CELL_LIMIT",
        `cell contains more than ${MAX_IMPORT_CELL_SCALARS} Unicode scalars`,
        location,
      );
    }
  }
}

export function inspectJsonShape(value: unknown): void {
  const active = new Set<object>();
  const stack: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly path: string;
    readonly leaving?: boolean;
  }> = [{ value, depth: 0, path: "$" }];

  while (stack.length > 0) {
    const item = stack.pop() as typeof stack[number];
    if (item.leaving) {
      active.delete(item.value as object);
      continue;
    }
    if (typeof item.value === "string") {
      validateCellScalarCount(item.value, item.path);
      continue;
    }
    if (item.value === null || typeof item.value !== "object") continue;

    const nextDepth = item.depth + 1;
    if (nextDepth > MAX_IMPORT_NESTING) {
      throw new KnowledgeImportInputError(
        "KNOWLEDGE_IMPORT_NESTING_LIMIT",
        `nesting exceeds ${MAX_IMPORT_NESTING}`,
        item.path,
      );
    }
    if (active.has(item.value)) {
      throw new KnowledgeImportInputError(
        "KNOWLEDGE_IMPORT_CYCLIC_VALUE",
        "cyclic input is not valid JSON",
        item.path,
      );
    }
    active.add(item.value);
    stack.push({ ...item, leaving: true });

    if (Array.isArray(item.value)) {
      validateRowCount(item.value.length, item.path);
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: item.value[index],
          depth: nextDepth,
          path: `${item.path}[${index}]`,
        });
      }
      continue;
    }

    const entries = Object.entries(item.value);
    validateColumnCount(entries.length, item.path);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index] as [string, unknown];
      validateCellScalarCount(key, item.path);
      stack.push({
        value: child,
        depth: nextDepth,
        path: `${item.path}.${key}`,
      });
    }
  }
}

export function validateXlsxArchive(summary: {
  readonly entries: number;
  readonly uncompressedBytes: number;
}): void {
  requireNonNegativeInteger(summary.entries, "XLSX_ENTRY_COUNT_INVALID", "xlsx archive");
  requireNonNegativeInteger(
    summary.uncompressedBytes,
    "XLSX_EXPANSION_SIZE_INVALID",
    "xlsx archive",
  );
  if (summary.entries > MAX_XLSX_ENTRIES) {
    throw new KnowledgeImportInputError(
      "XLSX_ENTRY_LIMIT",
      `archive contains ${summary.entries} entries; limit is ${MAX_XLSX_ENTRIES}`,
      "xlsx archive",
    );
  }
  if (summary.uncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
    throw new KnowledgeImportInputError(
      "XLSX_EXPANSION_LIMIT",
      `archive expands to ${summary.uncompressedBytes} bytes; limit is ${MAX_XLSX_UNCOMPRESSED_BYTES}`,
      "xlsx archive",
    );
  }
}

export function validateXlsxEntry(entry: {
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly path?: string;
}): void {
  const location = entry.path ?? "xlsx entry";
  requireNonNegativeInteger(entry.compressedBytes, "XLSX_ENTRY_SIZE_INVALID", location);
  requireNonNegativeInteger(entry.uncompressedBytes, "XLSX_ENTRY_SIZE_INVALID", location);
  const ratio = entry.compressedBytes === 0
    ? entry.uncompressedBytes === 0 ? 0 : Number.POSITIVE_INFINITY
    : entry.uncompressedBytes / entry.compressedBytes;
  if (ratio > MAX_XLSX_ENTRY_RATIO) {
    throw new KnowledgeImportInputError(
      "XLSX_ENTRY_RATIO_LIMIT",
      `entry expansion ratio ${ratio} exceeds ${MAX_XLSX_ENTRY_RATIO}`,
      location,
    );
  }
}
