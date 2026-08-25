import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceImportFileSize,
  inspectImportPath,
  inspectJsonShape,
  MAX_IMPORT_BYTES,
  validateCellScalarCount,
  validateColumnCount,
  validateRowCount,
  validateXlsxArchive,
  validateXlsxEntry,
} from "../src/knowledge-import/input-policy.js";

function deepObject(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

test("accepts only the four knowledge import formats", () => {
  assert.equal(inspectImportPath("terms.json").format, "json");
  assert.equal(inspectImportPath("terms.yaml").format, "yaml");
  assert.equal(inspectImportPath("terms.yml").format, "yaml");
  assert.equal(inspectImportPath("terms.csv").format, "csv");
  assert.equal(inspectImportPath("terms.xlsx").format, "xlsx");
  assert.equal(inspectImportPath("TERMS.JSON").format, "json");
  assert.throws(() => inspectImportPath("terms.xlsm"), /KNOWLEDGE_IMPORT_FORMAT_UNSUPPORTED/u);
  assert.throws(() => inspectImportPath("terms.xlsx.exe"), /KNOWLEDGE_IMPORT_FORMAT_UNSUPPORTED/u);
});

test("rejects oversized, deeply nested and over-wide inputs before staging", () => {
  assert.throws(() => enforceImportFileSize(MAX_IMPORT_BYTES + 1), /KNOWLEDGE_IMPORT_TOO_LARGE/u);
  assert.throws(() => enforceImportFileSize(-1), /KNOWLEDGE_IMPORT_SIZE_INVALID/u);
  assert.throws(() => inspectJsonShape(deepObject(65)), /KNOWLEDGE_IMPORT_NESTING_LIMIT/u);
  assert.throws(() => validateRowCount(100_001), /KNOWLEDGE_IMPORT_ROW_LIMIT/u);
  assert.throws(() => validateColumnCount(257), /KNOWLEDGE_IMPORT_COLUMN_LIMIT/u);
  assert.throws(() => validateCellScalarCount("x".repeat(8_193)), /KNOWLEDGE_IMPORT_CELL_LIMIT/u);
  assert.throws(() => validateXlsxArchive({
    entries: 10_001,
    uncompressedBytes: 1,
  }), /XLSX_ENTRY_LIMIT/u);
  assert.throws(
    () => validateXlsxArchive({ entries: 1, uncompressedBytes: 256 * 1024 * 1024 + 1 }),
    /XLSX_EXPANSION_LIMIT/u,
  );
  assert.throws(
    () => validateXlsxEntry({ compressedBytes: 1, uncompressedBytes: 101 }),
    /XLSX_ENTRY_RATIO_LIMIT/u,
  );
});

test("accepts values exactly at every input boundary", () => {
  assert.doesNotThrow(() => enforceImportFileSize(MAX_IMPORT_BYTES));
  assert.doesNotThrow(() => inspectJsonShape(deepObject(64)));
  assert.doesNotThrow(() => validateRowCount(100_000));
  assert.doesNotThrow(() => validateColumnCount(256));
  assert.doesNotThrow(() => validateCellScalarCount("x".repeat(8_192)));
  assert.doesNotThrow(() => validateXlsxArchive({
    entries: 10_000,
    uncompressedBytes: 256 * 1024 * 1024,
  }));
  assert.doesNotThrow(() => validateXlsxEntry({
    compressedBytes: 1,
    uncompressedBytes: 100,
  }));
});
