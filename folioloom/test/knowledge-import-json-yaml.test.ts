import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectJson,
  inspectJsonText,
  inspectYamlText,
  readStructuredRecords,
} from "../src/knowledge-import/json-yaml-reader.js";
import { identifyOfficialTemplate } from "../src/knowledge-import/official-template.js";

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "knowledge-import",
);

function rootArray(): readonly Record<string, unknown>[] {
  return [
    { source: "Archon", target: "执政官" },
    { source: "Lictor", target: "扈从" },
  ];
}

function aliasBomb(): string {
  return [
    "base: &base [Archon, Lictor]",
    "a: &a [*base, *base, *base, *base, *base]",
    "b: &b [*a, *a, *a, *a, *a]",
    "records: [*b, *b, *b, *b, *b]",
  ].join("\n");
}

test("discovers root arrays, nested arrays and key-value glossaries", async () => {
  assert.deepEqual(
    (await inspectJson(rootArray())).recordPaths.map((item) => item.path),
    ["$"],
  );
  assert.equal(
    (await inspectJson({ data: { terms: rootArray() } })).recordPaths[0]?.path,
    "$.data.terms",
  );
  assert.equal(
    (await inspectJson({ Archon: "执政官" })).recordPaths[0]?.shape,
    "key_value",
  );
});

test("uses opaque path ids to read the selected records", async () => {
  const inspection = await inspectJson({ data: { terms: rootArray() } });
  const selected = inspection.recordPaths[0];
  assert.ok(selected);
  assert.match(selected.id, /^record-path:\d+$/u);
  assert.deepEqual(
    (await readStructuredRecords(inspection, selected.id)).map((record) => record.values.source),
    ["Archon", "Lictor"],
  );
  await assert.rejects(
    () => readStructuredRecords(inspection, "$.data.terms"),
    /KNOWLEDGE_IMPORT_RECORD_PATH_UNKNOWN/u,
  );
});

test("rejects prototype keys, duplicate keys and YAML alias expansion", async () => {
  await assert.rejects(
    () => inspectJsonText('{"__proto__":{"polluted":true}}'),
    /FORBIDDEN_KEY/u,
  );
  await assert.rejects(
    () => inspectJsonText('{"records":[],"records":[]}'),
    /DUPLICATE_KEY/u,
  );
  await assert.rejects(() => inspectYamlText(aliasBomb()), /YAML_ALIAS_LIMIT/u);
});

test("allows YAML aliases that remain within the expansion limit", async () => {
  const inspection = await inspectYamlText([
    "term: &term",
    "  source: Archon",
    "  target: 执政官",
    "records:",
    "  - *term",
  ].join("\n"));
  const records = inspection.recordPaths.find((item) => item.path === "$.records");
  assert.ok(records);
  assert.equal(
    (await readStructuredRecords(inspection, records.id))[0]?.values.source,
    "Archon",
  );
});

test("requires the dedicated library flow for a template declaring global scope", async () => {
  await assert.rejects(
    () => inspectJson({
      schema: "folioloom-knowledge-import-1",
      objectType: "term",
      scope: "global",
      records: rootArray(),
    }),
    /GLOBAL_IMPORT_REQUIRES_LIBRARY_CONFIRMATION/u,
  );
});

test("recognizes only the exact official template version and root keys", async () => {
  const json = await readFile(join(fixtureDirectory, "terms.json"), "utf8");
  const yaml = await readFile(join(fixtureDirectory, "terms.yaml"), "utf8");
  const jsonInspection = await inspectJsonText(json);
  const yamlInspection = await inspectYamlText(yaml);

  assert.deepEqual(jsonInspection.officialTemplate, {
    schema: "folioloom-knowledge-import-1",
    objectType: "term",
    scope: "book",
    recordPathId: "record-path:1",
    fields: {
      source: "source",
      target: "target",
      policy: "policy",
      forms: "forms",
      note: "note",
      locked: "locked",
    },
  });
  assert.deepEqual(yamlInspection.officialTemplate, jsonInspection.officialTemplate);
  assert.equal(identifyOfficialTemplate({
    schema: "folioloom-knowledge-import-2",
    objectType: "term",
    scope: "book",
    records: [],
  }), undefined);
  assert.throws(
    () => identifyOfficialTemplate({
      schema: "folioloom-knowledge-import-1",
      objectType: "term",
      scope: "book",
      records: [],
      surprise: true,
    }),
    /OFFICIAL_TEMPLATE_ROOT_KEY_UNKNOWN/u,
  );
});
