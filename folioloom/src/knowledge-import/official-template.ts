import ExcelJS from "exceljs";

import { KnowledgeImportInputError } from "./input-policy.js";

export const OFFICIAL_KNOWLEDGE_IMPORT_SCHEMA = "folioloom-knowledge-import-1";

const OFFICIAL_ROOT_KEYS = new Set(["schema", "objectType", "scope", "records"]);
const OFFICIAL_TERM_FIELDS = Object.freeze({
  source: "source",
  target: "target",
  policy: "policy",
  forms: "forms",
  note: "note",
  locked: "locked",
});

export interface OfficialTemplate {
  readonly schema: typeof OFFICIAL_KNOWLEDGE_IMPORT_SCHEMA;
  readonly objectType: string;
  readonly scope: "book" | "project";
  readonly recordPathId: string;
  readonly fields: Readonly<Record<string, string>>;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function identifyOfficialTemplate(
  value: unknown,
  recordPathId = "record-path:1",
): OfficialTemplate | undefined {
  if (!isObject(value) || value.schema !== OFFICIAL_KNOWLEDGE_IMPORT_SCHEMA) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!OFFICIAL_ROOT_KEYS.has(key)) {
      throw new KnowledgeImportInputError(
        "OFFICIAL_TEMPLATE_ROOT_KEY_UNKNOWN",
        `unknown official template root key ${key}`,
        `$.${key}`,
      );
    }
  }
  if (typeof value.objectType !== "string" || value.objectType.length === 0) {
    throw new KnowledgeImportInputError(
      "OFFICIAL_TEMPLATE_INVALID",
      "objectType must be a non-empty string",
      "$.objectType",
    );
  }
  if (!Array.isArray(value.records)) {
    throw new KnowledgeImportInputError(
      "OFFICIAL_TEMPLATE_INVALID",
      "records must be an array",
      "$.records",
    );
  }
  if (value.scope === "global") {
    throw new KnowledgeImportInputError(
      "GLOBAL_IMPORT_REQUIRES_LIBRARY_CONFIRMATION",
      "global templates must use the dedicated library promotion flow",
      "$.scope",
    );
  }
  if (value.scope !== "book" && value.scope !== "project") {
    throw new KnowledgeImportInputError(
      "OFFICIAL_TEMPLATE_SCOPE_INVALID",
      "scope must be book or project",
      "$.scope",
    );
  }
  return Object.freeze({
    schema: OFFICIAL_KNOWLEDGE_IMPORT_SCHEMA,
    objectType: value.objectType,
    scope: value.scope,
    recordPathId,
    fields: OFFICIAL_TERM_FIELDS,
  });
}

export async function writeOfficialXlsxTemplate(outputPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Terms");
  worksheet.addRow(["source", "target", "policy", "forms", "note", "locked"]);
  worksheet.addRow(["Archon", "执政官", "preferred", "archon", "职位称呼", false]);
  await workbook.xlsx.writeFile(outputPath);
}
