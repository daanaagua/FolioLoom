import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { TextDecoder } from "node:util";

import { parse } from "csv-parse";

import {
  enforceImportFileSize,
  IMPORT_SAMPLE_ROWS,
  KnowledgeImportInputError,
  MAX_IMPORT_CELL_SCALARS,
  MAX_IMPORT_COLUMNS,
  validateCellScalarCount,
  validateColumnCount,
  validateRowCount,
} from "./input-policy.js";
import type { ImportTextEncoding } from "./types.js";

const LEGACY_ENCODINGS: readonly Exclude<ImportTextEncoding, "utf-8">[] = Object.freeze([
  "utf-16le",
  "utf-16be",
  "shift_jis",
  "euc-jp",
  "euc-kr",
  "windows-949",
]);
const PREVIEW_BYTES = 16 * 1024;

export interface ImportColumn {
  readonly id: string;
  readonly sourceIndex: number;
  readonly raw: string;
  readonly label: string;
  readonly mappable: boolean;
}

export interface TabularRecord {
  readonly ordinal: number;
  readonly location: string;
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ReadyCsvInspection {
  readonly status: "ready";
  readonly columns: readonly string[];
  readonly columnDetails: readonly ImportColumn[];
  readonly suggestedHeaderRows: readonly number[];
  readonly sample: readonly TabularRecord[];
  readonly encoding: ImportTextEncoding;
}

export interface CsvEncodingRequired {
  readonly status: "encoding_required";
  readonly fileName: string;
  readonly encodings: readonly Exclude<ImportTextEncoding, "utf-8">[];
  readonly previews: readonly {
    readonly encoding: Exclude<ImportTextEncoding, "utf-8">;
    readonly text: string;
  }[];
}

export type CsvInspection = ReadyCsvInspection | CsvEncodingRequired;

interface ParsedCsvRow {
  readonly rowNumber: number;
  readonly values: readonly string[];
}

class CsvDecodingError extends Error {
  readonly code = "KNOWLEDGE_IMPORT_ENCODING_INVALID";

  constructor(encoding: ImportTextEncoding, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`KNOWLEDGE_IMPORT_ENCODING_INVALID at ${encoding}: ${detail}`);
  }
}

class StrictTextDecoderTransform extends Transform {
  readonly #decoder: TextDecoder;
  readonly #encoding: ImportTextEncoding;

  constructor(encoding: ImportTextEncoding) {
    super({ decodeStrings: true });
    this.#encoding = encoding;
    this.#decoder = new TextDecoder(encoding, { fatal: true });
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.push(this.#decoder.decode(chunk, { stream: true }));
      callback();
    } catch (error) {
      callback(new CsvDecodingError(this.#encoding, error));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.push(this.#decoder.decode());
      callback();
    } catch (error) {
      callback(new CsvDecodingError(this.#encoding, error));
    }
  }
}

function importError(code: string, message: string, location: string): never {
  throw new KnowledgeImportInputError(code, message, location);
}

function normalizeCell(value: string, location: string): string {
  const normalized = value.normalize("NFKC").trim();
  validateCellScalarCount(normalized, location);
  return normalized;
}

export function normalizeHeaders(values: readonly unknown[]): readonly ImportColumn[] {
  const seen = new Map<string, number>();
  return Object.freeze(values.map((value, index) => {
    const raw = typeof value === "string" ? value.normalize("NFKC").trim() : "";
    validateCellScalarCount(raw, `header column ${index + 1}`);
    const occurrence = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, occurrence);
    return Object.freeze({
      id: `column:${index}`,
      sourceIndex: index,
      raw,
      label: raw.length === 0
        ? `未命名列 ${index + 1}`
        : occurrence === 1 ? raw : `${raw} [${occurrence}]`,
      mappable: raw.length > 0,
    });
  }));
}

async function assertFileSize(path: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile()) {
    importError("KNOWLEDGE_IMPORT_NOT_FILE", "input must be a regular file", path);
  }
  enforceImportFileSize(details.size, path);
}

async function* parseCsvRows(
  path: string,
  encoding: ImportTextEncoding,
  headerRow: number,
): AsyncGenerator<ParsedCsvRow> {
  await assertFileSize(path);
  const input = createReadStream(path);
  const decoder = new StrictTextDecoderTransform(encoding);
  const parser = parse({
    bom: true,
    columns: false,
    info: true,
    relax_column_count: false,
    skip_empty_lines: true,
    max_record_size: MAX_IMPORT_CELL_SCALARS * MAX_IMPORT_COLUMNS,
  });
  input.on("error", (error) => parser.destroy(error));
  decoder.on("error", (error) => parser.destroy(error));
  input.pipe(decoder).pipe(parser);
  let records = 0;
  try {
    for await (const item of parser as AsyncIterable<{
      readonly record: unknown[];
      readonly info: { readonly lines: number };
    }>) {
      records += 1;
      // MAX_IMPORT_ROWS limits importable records. The selected header and
      // any explicitly skipped preamble rows are structural input.
      validateRowCount(Math.max(0, records - headerRow), path);
      validateColumnCount(item.record.length, `row ${item.info.lines}`);
      yield {
        rowNumber: item.info.lines,
        values: item.record.map((value, index) =>
          normalizeCell(String(value), `row ${item.info.lines}, column ${index + 1}`)),
      };
    }
  } catch (error) {
    input.destroy();
    decoder.destroy();
    if (error instanceof KnowledgeImportInputError || error instanceof CsvDecodingError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    importError("KNOWLEDGE_IMPORT_CSV_INVALID", message, path);
  }
}

function requireHeaderRow(headerRow: number): void {
  if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > 20) {
    importError(
      "KNOWLEDGE_IMPORT_HEADER_ROW_INVALID",
      "header row must be within the first 20 non-empty rows",
      `row ${headerRow}`,
    );
  }
}

export async function* streamCsvRecords(
  path: string,
  options: {
    readonly headerRow?: number;
    readonly encoding?: ImportTextEncoding;
  } = {},
): AsyncGenerator<TabularRecord> {
  const headerRow = options.headerRow ?? 1;
  requireHeaderRow(headerRow);
  const encoding = options.encoding ?? "utf-8";
  let ordinal = 0;
  let parsedRow = 0;
  let columns: readonly ImportColumn[] | undefined;
  for await (const row of parseCsvRows(path, encoding, headerRow)) {
    parsedRow += 1;
    if (parsedRow < headerRow) continue;
    if (parsedRow === headerRow) {
      columns = normalizeHeaders(row.values);
      continue;
    }
    if (columns === undefined) continue;
    if (row.values.length !== columns.length) {
      importError(
        "KNOWLEDGE_IMPORT_COLUMN_COUNT_MISMATCH",
        `expected ${columns.length} cells but found ${row.values.length}`,
        `row ${row.rowNumber}`,
      );
    }
    ordinal += 1;
    validateRowCount(ordinal, path);
    const values: Record<string, string> = {};
    for (const column of columns) {
      values[column.id] = row.values[column.sourceIndex] ?? "";
    }
    yield Object.freeze({
      ordinal,
      location: `row ${row.rowNumber}`,
      values: Object.freeze(values),
    });
  }
  if (columns === undefined) {
    importError(
      "KNOWLEDGE_IMPORT_HEADER_ROW_MISSING",
      "selected header row does not exist",
      `row ${headerRow}`,
    );
  }
}

async function encodingPreviews(path: string): Promise<CsvEncodingRequired> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    const previews = LEGACY_ENCODINGS.flatMap((encoding) => {
      try {
        const decoder = new TextDecoder(encoding, { fatal: true });
        const text = decoder.decode(sample, { stream: bytesRead === PREVIEW_BYTES })
          .slice(0, 1_000);
        return [{ encoding, text }] as const;
      } catch {
        return [];
      }
    });
    return Object.freeze({
      status: "encoding_required",
      fileName: basename(path),
      encodings: Object.freeze(previews.map((item) => item.encoding)),
      previews: Object.freeze(previews),
    });
  } finally {
    await handle.close();
  }
}

export async function inspectCsv(
  path: string,
  options: {
    readonly headerRow?: number;
    readonly encoding?: ImportTextEncoding;
  } = {},
): Promise<CsvInspection> {
  const headerRow = options.headerRow ?? 1;
  requireHeaderRow(headerRow);
  const encoding = options.encoding ?? "utf-8";
  const firstRows: ParsedCsvRow[] = [];
  let parsedRow = 0;
  try {
    for await (const row of parseCsvRows(path, encoding, headerRow)) {
      parsedRow += 1;
      if (parsedRow <= 20) firstRows.push(row);
    }
  } catch (error) {
    const code = error !== null && typeof error === "object"
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (options.encoding === undefined
      && (error instanceof CsvDecodingError || code === "KNOWLEDGE_IMPORT_ENCODING_INVALID")) {
      return encodingPreviews(path);
    }
    throw error;
  }
  const header = firstRows[headerRow - 1];
  if (header === undefined) {
    importError(
      "KNOWLEDGE_IMPORT_HEADER_ROW_MISSING",
      "selected header row does not exist",
      `row ${headerRow}`,
    );
  }
  const columnDetails = normalizeHeaders(header.values);
  const sample: TabularRecord[] = [];
  let ordinal = 0;
  for await (const record of streamCsvRecords(path, { headerRow, encoding })) {
    ordinal += 1;
    if (sample.length < IMPORT_SAMPLE_ROWS) sample.push(record);
  }
  return Object.freeze({
    status: "ready",
    columns: Object.freeze(columnDetails.map((column) => column.raw)),
    columnDetails,
    suggestedHeaderRows: Object.freeze(firstRows.map((_row, index) => index + 1)),
    sample: Object.freeze(sample),
    encoding,
  });
}
