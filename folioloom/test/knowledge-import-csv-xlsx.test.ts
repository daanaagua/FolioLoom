import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";

import {
  inspectCsv,
  normalizeHeaders,
  streamCsvRecords,
} from "../src/knowledge-import/csv-reader.js";
import { writeOfficialXlsxTemplate } from "../src/knowledge-import/official-template.js";
import {
  inspectXlsx,
  preflightXlsxArchive,
  readXlsxRecords,
  streamXlsxRecords,
} from "../src/knowledge-import/xlsx-reader.js";

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "knowledge-import",
);

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "folioloom-import-"));
  return join(directory, name);
}

async function formulaWorkbook(): Promise<string> {
  const path = await temporaryPath("formula.xlsx");
  const workbook = new ExcelJS.Workbook();
  const terms = workbook.addWorksheet("Terms");
  terms.addRow(["source", "target", "policy"]);
  terms.addRow(["Archon", { formula: "1+1", result: 2 }, "preferred"]);
  const people = workbook.addWorksheet("People");
  people.addRow(["name", "role"]);
  people.addRow(["Severian", "narrator"]);
  await workbook.xlsx.writeFile(path);
  return path;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeZip(
  name: string,
  entries: readonly { readonly path: string; readonly body: Buffer; readonly deflate?: boolean }[],
): Promise<string> {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const nameBytes = Buffer.from(item.path, "utf8");
    const compressed = item.deflate ? deflateRawSync(item.body) : item.body;
    const method = item.deflate ? 8 : 0;
    const checksum = crc32(item.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(item.body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(item.body.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  const path = await temporaryPath(name);
  await writeFile(path, Buffer.concat([...chunks, ...central, end]));
  return path;
}

test("streams UTF-8 BOM CSV and preserves source row numbers", async () => {
  const inspection = await inspectCsv(join(fixtureDirectory, "terms.csv"));
  assert.equal(inspection.status, "ready");
  if (inspection.status !== "ready") return;
  assert.deepEqual(inspection.columns, ["source", "target", "policy"]);
  assert.equal(inspection.sample[0]?.location, "row 2");

  const stream = streamCsvRecords(join(fixtureDirectory, "terms.csv"), { headerRow: 1 });
  assert.equal(typeof stream[Symbol.asyncIterator], "function");
  const rows = [];
  for await (const row of stream) rows.push(row);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.values["column:1"], "扈从");
});

test("counts CSV data records without charging the selected header row", async () => {
  const acceptedPath = await temporaryPath("one-hundred-thousand.csv");
  await writeFile(
    acceptedPath,
    [
      "source,target",
      ...Array.from({ length: 100_000 }, (_item, index) => `term-${index},译名-${index}`),
      "",
    ].join("\n"),
    "utf8",
  );
  let accepted = 0;
  for await (const _record of streamCsvRecords(acceptedPath, { headerRow: 1 })) {
    accepted += 1;
  }
  assert.equal(accepted, 100_000);

  const rejectedPath = await temporaryPath("one-hundred-thousand-and-one.csv");
  await writeFile(
    rejectedPath,
    [
      "source,target",
      ...Array.from({ length: 100_001 }, (_item, index) => `term-${index},译名-${index}`),
      "",
    ].join("\n"),
    "utf8",
  );
  await assert.rejects(
    async () => {
      for await (const _record of streamCsvRecords(rejectedPath, { headerRow: 1 })) {
        // Consume the stream so the boundary is exercised.
      }
    },
    /KNOWLEDGE_IMPORT_ROW_LIMIT/u,
  );
});

test("requires explicit confirmation for non-UTF-8 CSV", async () => {
  const path = await temporaryPath("shift-jis.csv");
  await writeFile(path, Buffer.concat([
    Buffer.from("source,target\nArchon,", "ascii"),
    Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]),
    Buffer.from("\n", "ascii"),
  ]));
  const undecided = await inspectCsv(path);
  assert.equal(undecided.status, "encoding_required");
  if (undecided.status !== "encoding_required") return;
  assert.ok(undecided.encodings.includes("shift_jis"));

  const confirmed = await inspectCsv(path, { encoding: "shift_jis" });
  assert.equal(confirmed.status, "ready");
  if (confirmed.status !== "ready") return;
  assert.equal(confirmed.sample[0]?.values["column:1"], "テスト");
});

test("normalizes duplicate and empty headers without losing stable column indexes", () => {
  assert.deepEqual(normalizeHeaders([" source ", "ｓｏｕｒｃｅ", "", 42]), [
    { id: "column:0", sourceIndex: 0, raw: "source", label: "source", mappable: true },
    { id: "column:1", sourceIndex: 1, raw: "source", label: "source [2]", mappable: true },
    { id: "column:2", sourceIndex: 2, raw: "", label: "未命名列 3", mappable: false },
    { id: "column:3", sourceIndex: 3, raw: "", label: "未命名列 4", mappable: false },
  ]);
});

test("lists XLSX sheets and never evaluates formulas", async () => {
  const workbook = await formulaWorkbook();
  const inspection = await inspectXlsx(workbook);
  assert.deepEqual(inspection.sheets.map((sheet) => sheet.name), ["Terms", "People"]);
  assert.ok(inspection.diagnostics.some((item) =>
    item.code === "KNOWLEDGE_IMPORT_FORMULA_FORBIDDEN" && /Terms!B2/u.test(item.location)));
  await assert.rejects(
    () => readXlsxRecords(workbook, {
      sheetId: inspection.sheets[0]!.id,
      headerRow: 1,
    }),
    /KNOWLEDGE_IMPORT_FORMULA_FORBIDDEN.*Terms!B2/u,
  );
});

test("rejects zip bombs, macros, external relationships and traversal before ExcelJS", async () => {
  const bomb = await writeZip("bomb.xlsx", [{
    path: "xl/worksheets/sheet1.xml",
    body: Buffer.alloc(64 * 1024, 0),
    deflate: true,
  }]);
  const macro = await writeZip("macro.xlsx", [{
    path: "xl/vbaProject.bin",
    body: Buffer.from("macro"),
  }]);
  const external = await writeZip("external.xlsx", [{
    path: "xl/_rels/workbook.xml.rels",
    body: Buffer.from('<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>'),
  }]);
  const traversal = await writeZip("traversal.xlsx", [{
    path: "../escape.xml",
    body: Buffer.from("escape"),
  }]);

  await assert.rejects(() => preflightXlsxArchive(bomb), /XLSX_ENTRY_RATIO_LIMIT/u);
  await assert.rejects(() => preflightXlsxArchive(macro), /XLSX_MACRO_FORBIDDEN/u);
  await assert.rejects(() => preflightXlsxArchive(external), /XLSX_EXTERNAL_LINK_FORBIDDEN/u);
  await assert.rejects(() => preflightXlsxArchive(traversal), /XLSX_ENTRY_PATH_INVALID/u);
});

test("writes an official XLSX template that the streaming reader can read back", async () => {
  const path = await temporaryPath("official.xlsx");
  await writeOfficialXlsxTemplate(path);
  const bytes = await readFile(path);
  assert.ok(bytes.length > 0);
  const inspection = await inspectXlsx(path);
  assert.equal(inspection.sheets[0]?.name, "Terms");
  const iterator = streamXlsxRecords(path, {
    sheetId: inspection.sheets[0]!.id,
    headerRow: 1,
  });
  assert.equal(typeof iterator[Symbol.asyncIterator], "function");
  const rows = [];
  for await (const row of iterator) rows.push(row);
  assert.deepEqual(rows[0]?.values, {
    "column:0": "Archon",
    "column:1": "执政官",
    "column:2": "preferred",
    "column:3": "archon",
    "column:4": "职位称呼",
    "column:5": false,
  });
});
