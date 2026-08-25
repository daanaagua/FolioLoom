import { stat } from "node:fs/promises";
import { posix } from "node:path";

import ExcelJS, { type Cell, type Row } from "exceljs";
import * as yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";

import {
  enforceImportFileSize,
  IMPORT_SAMPLE_ROWS,
  KnowledgeImportInputError,
  validateCellScalarCount,
  validateColumnCount,
  validateRowCount,
  validateXlsxArchive,
  validateXlsxEntry,
} from "./input-policy.js";
import {
  normalizeHeaders,
  type ImportColumn,
  type TabularRecord,
} from "./csv-reader.js";
import type { ImportDiagnostic } from "./types.js";

interface StreamingWorksheet {
  readonly id: number;
  readonly name: string;
  readonly state?: string;
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<Row>;
}

export interface XlsxSheetInspection {
  readonly id: string;
  readonly name: string;
  readonly visibility: string;
  readonly suggestedHeaderRows: readonly number[];
  readonly columns: readonly ImportColumn[];
}

export interface XlsxInspection {
  readonly sheets: readonly XlsxSheetInspection[];
  readonly sample: readonly (TabularRecord & { readonly sheetId: string })[];
  readonly diagnostics: readonly ImportDiagnostic[];
}

interface WorkbookSheetMetadata {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly rId: string;
}

interface XlsxArchiveInspection {
  readonly sheets: readonly WorkbookSheetMetadata[];
  readonly sharedStrings?: readonly unknown[];
}

function importError(code: string, message: string, location: string): never {
  throw new KnowledgeImportInputError(code, message, location);
}

function safeArchivePath(value: string): string {
  if (value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value)
    || value.split("/").some((part) => part === "..")) {
    importError("XLSX_ENTRY_PATH_INVALID", "archive entry has an unsafe path", value);
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) {
    importError("XLSX_ENTRY_PATH_INVALID", "archive entry escapes the archive root", value);
  }
  return normalized;
}

function archiveFailure(error: unknown): KnowledgeImportInputError {
  if (error instanceof KnowledgeImportInputError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid (?:relative )?path|invalid file ?name/iu.test(message)) {
    return new KnowledgeImportInputError("XLSX_ENTRY_PATH_INVALID", message, "xlsx archive");
  }
  return new KnowledgeImportInputError("XLSX_ARCHIVE_INVALID", message, "xlsx archive");
}

function readEntryText(zip: ZipFile, entry: Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(archiveFailure(error));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize) {
          stream.destroy(archiveFailure(new Error("entry exceeds its declared size")));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (streamError) => reject(archiveFailure(streamError)));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function decodeXmlText(value: string): string {
  return decodeXmlAttribute(value)
    .replace(/&#(\d+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([\dA-Fa-f]+);/gu, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)));
}

function parseSharedStrings(text: string): readonly unknown[] {
  return Object.freeze([...text.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)].map((match) => {
    const body = match[1] ?? "";
    const value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)]
      .map((textMatch) => decodeXmlText(textMatch[1] ?? ""))
      .join("");
    return /<r\b/iu.test(body)
      ? Object.freeze({ richText: Object.freeze([{ text: value }]) })
      : value;
  }));
}

function parseWorkbookSheets(text: string): readonly WorkbookSheetMetadata[] {
  const sheets: WorkbookSheetMetadata[] = [];
  for (const match of text.matchAll(/<sheet\b([^>]*)\/?>/giu)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? "").matchAll(
      /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu,
    )) {
      attributes.set(attribute[1] ?? "", decodeXmlAttribute(attribute[2] ?? attribute[3] ?? ""));
    }
    const name = attributes.get("name");
    const id = Number(attributes.get("sheetId"));
    const rId = attributes.get("r:id");
    if (name !== undefined && Number.isSafeInteger(id) && id > 0 && rId !== undefined) {
      sheets.push(Object.freeze({
        id,
        name,
        state: attributes.get("state") ?? "visible",
        rId,
      }));
    }
  }
  return Object.freeze(sheets);
}

async function scanXlsxArchive(path: string): Promise<XlsxArchiveInspection> {
  const details = await stat(path);
  if (!details.isFile()) {
    importError("KNOWLEDGE_IMPORT_NOT_FILE", "input must be a regular file", path);
  }
  enforceImportFileSize(details.size, path);

  return new Promise<XlsxArchiveInspection>((resolve, reject) => {
    yauzl.open(path, {
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: false,
      validateEntrySizes: false,
    }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        reject(archiveFailure(openError));
        return;
      }
      let entries = 0;
      let uncompressedBytes = 0;
      let settled = false;
      const names = new Set<string>();
      let workbookXml: string | undefined;
      let sharedStringsXml: string | undefined;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch {
          // The central directory reader may already be closed.
        }
        reject(archiveFailure(error));
      };
      zip.on("error", fail);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const memberPath = safeArchivePath(entry.fileName);
          const lowerPath = memberPath.toLocaleLowerCase("en");
          if (names.has(lowerPath)) {
            importError("XLSX_ENTRY_DUPLICATE", "archive has a duplicate entry", memberPath);
          }
          names.add(lowerPath);
          if (entry.isEncrypted()) {
            importError("XLSX_ENCRYPTION_FORBIDDEN", "encrypted workbooks are not accepted", memberPath);
          }
          entries += 1;
          uncompressedBytes += entry.uncompressedSize;
          validateXlsxEntry({
            compressedBytes: entry.compressedSize,
            uncompressedBytes: entry.uncompressedSize,
            path: memberPath,
          });
          validateXlsxArchive({ entries, uncompressedBytes });

          if (lowerPath === "xl/vbaproject.bin" || lowerPath.endsWith("/vbaproject.bin")) {
            importError("XLSX_MACRO_FORBIDDEN", "macro projects are not accepted", memberPath);
          }
          if (lowerPath.startsWith("xl/externallinks/")) {
            importError("XLSX_EXTERNAL_LINK_FORBIDDEN", "external links are not accepted", memberPath);
          }
          if (lowerPath.startsWith("xl/embeddings/")) {
            importError("XLSX_EMBEDDING_FORBIDDEN", "embedded objects are not accepted", memberPath);
          }
          if (lowerPath.endsWith(".rels")) {
            const relationships = await readEntryText(zip, entry);
            if (/TargetMode\s*=\s*["']External["']/iu.test(relationships)) {
              importError(
                "XLSX_EXTERNAL_LINK_FORBIDDEN",
                "external relationship targets are not accepted",
                memberPath,
              );
            }
          }
          if (lowerPath === "[content_types].xml") {
            const contentTypes = await readEntryText(zip, entry);
            if (/macroEnabled|vbaProject/iu.test(contentTypes)) {
              importError("XLSX_MACRO_FORBIDDEN", "macro content types are not accepted", memberPath);
            }
          }
          if (lowerPath === "xl/workbook.xml") {
            workbookXml = await readEntryText(zip, entry);
          }
          if (lowerPath === "xl/sharedstrings.xml") {
            sharedStringsXml = await readEntryText(zip, entry);
          }
        })().then(() => zip.readEntry(), fail);
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Object.freeze({
          sheets: workbookXml === undefined ? Object.freeze([]) : parseWorkbookSheets(workbookXml),
          ...(sharedStringsXml === undefined
            ? {}
            : { sharedStrings: parseSharedStrings(sharedStringsXml) }),
        }));
      });
      zip.readEntry();
    });
  });
}

export async function preflightXlsxArchive(path: string): Promise<void> {
  await scanXlsxArchive(path);
}

function worksheetIdentity(
  worksheet: ExcelJS.stream.xlsx.WorksheetReader,
  index: number,
): StreamingWorksheet {
  const value = worksheet as unknown as StreamingWorksheet;
  return {
    id: value.id ?? index,
    name: value.name ?? `Sheet${index}`,
    state: value.state,
    [Symbol.asyncIterator]: value[Symbol.asyncIterator].bind(value),
  };
}

function cellDiagnostic(code: string, message: string, location: string): ImportDiagnostic {
  return Object.freeze({ code, message, location });
}

function extractCell(
  cell: Cell,
  location: string,
  diagnostics?: ImportDiagnostic[],
): string | number | boolean | null {
  const reject = (code: string, message: string): null => {
    if (diagnostics === undefined) importError(code, message, location);
    diagnostics.push(cellDiagnostic(code, message, location));
    return null;
  };
  if (cell.hyperlink !== undefined && cell.hyperlink.length > 0) {
    return reject("KNOWLEDGE_IMPORT_HYPERLINK_FORBIDDEN", "hyperlink cells are not accepted");
  }
  const value: unknown = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = value.normalize("NFKC").trim();
    validateCellScalarCount(normalized, location);
    return normalized;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return reject("KNOWLEDGE_IMPORT_CELL_TYPE_FORBIDDEN", "number must be finite");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") {
    return reject("KNOWLEDGE_IMPORT_CELL_TYPE_FORBIDDEN", "unsupported cell value");
  }
  const structured = value as Readonly<Record<string, unknown>>;
  if ("formula" in structured || "sharedFormula" in structured) {
    return reject("KNOWLEDGE_IMPORT_FORMULA_FORBIDDEN", "formula cells are not accepted");
  }
  if ("richText" in structured) {
    return reject("KNOWLEDGE_IMPORT_RICH_TEXT_FORBIDDEN", "rich text cells are not accepted");
  }
  if ("hyperlink" in structured) {
    return reject("KNOWLEDGE_IMPORT_HYPERLINK_FORBIDDEN", "hyperlink cells are not accepted");
  }
  if ("error" in structured) {
    return reject("KNOWLEDGE_IMPORT_CELL_ERROR_FORBIDDEN", "spreadsheet error cells are not accepted");
  }
  return reject("KNOWLEDGE_IMPORT_CELL_TYPE_FORBIDDEN", "only primitive cell values are accepted");
}

function rowWidth(row: Row): number {
  return Math.max(0, (row.values as unknown[]).length - 1);
}

function extractRow(
  row: Row,
  sheetName: string,
  width: number,
  diagnostics?: ImportDiagnostic[],
): readonly (string | number | boolean | null)[] {
  validateColumnCount(width, `${sheetName}!${row.number}`);
  const values: Array<string | number | boolean | null> = [];
  for (let index = 1; index <= width; index += 1) {
    const cell = row.getCell(index);
    values.push(extractCell(cell, `${sheetName}!${cell.address}`, diagnostics));
  }
  return values;
}

function workbookReader(
  path: string,
  archive: XlsxArchiveInspection,
): ExcelJS.stream.xlsx.WorkbookReader {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "cache",
    styles: "cache",
    entries: "ignore",
  });
  // ExcelJS 4.4 can encounter worksheet entries before xl/workbook.xml. Seed the
  // bounded sheet metadata found during ZIP preflight so that early streaming
  // worksheet events retain their real names and visibility.
  (reader as unknown as {
    model: { readonly sheets: readonly WorkbookSheetMetadata[] };
  }).model = { sheets: archive.sheets };
  if (archive.sharedStrings !== undefined) {
    (reader as unknown as { sharedStrings: readonly unknown[] }).sharedStrings =
      archive.sharedStrings;
  }
  return reader;
}

export async function inspectXlsx(path: string): Promise<XlsxInspection> {
  const archive = await scanXlsxArchive(path);
  const sheets: XlsxSheetInspection[] = [];
  const sample: Array<TabularRecord & { readonly sheetId: string }> = [];
  const diagnostics: ImportDiagnostic[] = [];
  let sheetIndex = 0;
  for await (const rawWorksheet of workbookReader(path, archive)) {
    sheetIndex += 1;
    const worksheet = worksheetIdentity(rawWorksheet, sheetIndex);
    const sheetId = `sheet:${sheetIndex}`;
    const suggestedHeaderRows: number[] = [];
    let columns: readonly ImportColumn[] = Object.freeze([]);
    let rows = 0;
    let sampleRows = 0;
    for await (const row of worksheet) {
      rows += 1;
      validateRowCount(rows, worksheet.name);
      const width = rowWidth(row);
      validateColumnCount(width, `${worksheet.name}!${row.number}`);
      if (row.number <= 20 && width > 0) suggestedHeaderRows.push(row.number);
      if (row.number === 1) {
        columns = normalizeHeaders(extractRow(row, worksheet.name, width, diagnostics));
        continue;
      }
      if (sampleRows >= IMPORT_SAMPLE_ROWS || columns.length === 0) continue;
      const values = extractRow(row, worksheet.name, columns.length, diagnostics);
      const mapped: Record<string, string | number | boolean | null> = {};
      for (const column of columns) mapped[column.id] = values[column.sourceIndex] ?? null;
      sampleRows += 1;
      sample.push(Object.freeze({
        sheetId,
        ordinal: sampleRows,
        location: `${worksheet.name}!${row.number}`,
        values: Object.freeze(mapped),
      }));
    }
    sheets.push(Object.freeze({
      id: sheetId,
      name: worksheet.name,
      visibility: worksheet.state ?? "visible",
      suggestedHeaderRows: Object.freeze(suggestedHeaderRows),
      columns,
    }));
  }
  return Object.freeze({
    sheets: Object.freeze(sheets),
    sample: Object.freeze(sample),
    diagnostics: Object.freeze(diagnostics),
  });
}

function requireXlsxSelection(selection: { readonly sheetId: string; readonly headerRow: number }): void {
  if (!/^sheet:[1-9]\d*$/u.test(selection.sheetId)) {
    importError("KNOWLEDGE_IMPORT_SHEET_UNKNOWN", "sheet id is invalid", selection.sheetId);
  }
  if (!Number.isSafeInteger(selection.headerRow)
    || selection.headerRow < 1
    || selection.headerRow > 20) {
    importError(
      "KNOWLEDGE_IMPORT_HEADER_ROW_INVALID",
      "header row must be within the first 20 rows",
      `${selection.sheetId}!${selection.headerRow}`,
    );
  }
}

export async function* streamXlsxRecords(
  path: string,
  selection: { readonly sheetId: string; readonly headerRow: number },
): AsyncGenerator<TabularRecord> {
  requireXlsxSelection(selection);
  const archive = await scanXlsxArchive(path);
  const selectedIndex = Number(selection.sheetId.slice("sheet:".length));
  let sheetIndex = 0;
  let selectedFound = false;
  let headerFound = false;
  for await (const rawWorksheet of workbookReader(path, archive)) {
    sheetIndex += 1;
    const worksheet = worksheetIdentity(rawWorksheet, sheetIndex);
    if (sheetIndex !== selectedIndex) {
      for await (const _row of worksheet) {
        // Drain unselected sheet streams without retaining their rows.
      }
      continue;
    }
    selectedFound = true;
    let columns: readonly ImportColumn[] | undefined;
    let ordinal = 0;
    for await (const row of worksheet) {
      if (row.number < selection.headerRow) continue;
      if (row.number === selection.headerRow) {
        const width = rowWidth(row);
        columns = normalizeHeaders(extractRow(row, worksheet.name, width));
        headerFound = true;
        continue;
      }
      if (columns === undefined) continue;
      const width = rowWidth(row);
      if (width > columns.length) {
        importError(
          "KNOWLEDGE_IMPORT_COLUMN_COUNT_MISMATCH",
          `expected at most ${columns.length} cells but found ${width}`,
          `${worksheet.name}!${row.number}`,
        );
      }
      const rowValues = extractRow(row, worksheet.name, columns.length);
      const values: Record<string, string | number | boolean | null> = {};
      for (const column of columns) values[column.id] = rowValues[column.sourceIndex] ?? null;
      ordinal += 1;
      validateRowCount(ordinal, worksheet.name);
      yield Object.freeze({
        ordinal,
        location: `${worksheet.name}!${row.number}`,
        values: Object.freeze(values),
      });
    }
  }
  if (!selectedFound) {
    importError("KNOWLEDGE_IMPORT_SHEET_UNKNOWN", "sheet id was not produced by inspection", selection.sheetId);
  }
  if (!headerFound) {
    importError(
      "KNOWLEDGE_IMPORT_HEADER_ROW_MISSING",
      "selected header row does not exist",
      `${selection.sheetId}!${selection.headerRow}`,
    );
  }
}

export async function readXlsxRecords(
  path: string,
  selection: { readonly sheetId: string; readonly headerRow: number },
): Promise<readonly TabularRecord[]> {
  const records: TabularRecord[] = [];
  for await (const record of streamXlsxRecords(path, selection)) records.push(record);
  return Object.freeze(records);
}
