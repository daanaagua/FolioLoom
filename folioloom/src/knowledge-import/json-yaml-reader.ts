import {
  isAlias,
  isMap,
  isSeq,
  isScalar,
  parseDocument,
  type Node as YamlNode,
  type Pair,
} from "yaml";

import {
  enforceImportFileSize,
  inspectJsonShape,
  KnowledgeImportInputError,
} from "./input-policy.js";
import {
  identifyOfficialTemplate,
  type OfficialTemplate,
} from "./official-template.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface StructuredRecordPath {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly shape: "records" | "key_value";
}

export interface StructuredRecord {
  readonly ordinal: number;
  readonly location: string;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export interface StructuredInspection {
  readonly recordPaths: readonly StructuredRecordPath[];
  readonly officialTemplate?: OfficialTemplate;
}

interface RecordPathState {
  readonly path: StructuredRecordPath;
  readonly value: JsonValue;
}

const inspectionState = new WeakMap<StructuredInspection, ReadonlyMap<string, RecordPathState>>();
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_SCALAR_TAGS = new Set([
  undefined,
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:str",
]);

function fail(code: string, message: string, location: string): never {
  throw new KnowledgeImportInputError(code, message, location);
}

function validateKey(key: string, path: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    fail("FORBIDDEN_KEY", `key ${key} is forbidden`, path);
  }
}

function sanitizeJavaScriptValue(
  value: unknown,
  path: string,
  active = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_JSON_VALUE", "number must be finite", path);
    return value;
  }
  if (typeof value !== "object") {
    fail("NON_JSON_VALUE", `unsupported ${typeof value} value`, path);
  }
  if (active.has(value)) fail("NON_JSON_VALUE", "cyclic value is not valid JSON", path);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => sanitizeJavaScriptValue(item, `${path}[${index}]`, active));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("NON_JSON_VALUE", "only plain objects are accepted", path);
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(value)) {
      validateKey(key, `${path}.${key}`);
      output[key] = sanitizeJavaScriptValue(child, `${path}.${key}`, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function scalarToJson(node: YamlNode, path: string): JsonPrimitive {
  if (!isScalar(node)) fail("NON_JSON_VALUE", "expected a scalar", path);
  if (!ALLOWED_SCALAR_TAGS.has(node.tag)) {
    fail("YAML_TAG_FORBIDDEN", `tag ${node.tag ?? "(implicit)"} is not accepted`, path);
  }
  const value: unknown = node.value;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail("NON_JSON_VALUE", "YAML scalar is not a JSON primitive", path);
}

function pairKey(pair: Pair, path: string): string {
  if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
    fail("YAML_NON_STRING_KEY", "mapping keys must be strings", path);
  }
  const key = pair.key.value;
  validateKey(key, `${path}.${key}`);
  return key;
}

function validateYamlNode(
  node: YamlNode | null,
  path = "$",
  active = new Set<object>(),
): void {
  if (node === null || isAlias(node)) return;
  if (isScalar(node)) {
    scalarToJson(node, path);
    return;
  }
  if (active.has(node)) fail("YAML_ALIAS_LIMIT", "cyclic YAML nodes are not accepted", path);
  active.add(node);
  try {
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        validateYamlNode(item as YamlNode | null, `${path}[${index}]`, active);
      });
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pairKey(pair, path);
        validateYamlNode(pair.value as YamlNode | null, `${path}.${key}`, active);
      }
      return;
    }
    fail("NON_JSON_VALUE", "unsupported YAML node", path);
  } finally {
    active.delete(node);
  }
}

function parseStructuredText(text: string, schema: "json" | "core"): JsonValue {
  enforceImportFileSize(Buffer.byteLength(text, "utf8"));
  const parseOptions = {
    schema,
    maxAliasCount: schema === "json" ? 0 : 20,
    prettyErrors: false,
    uniqueKeys: true,
  } as NonNullable<Parameters<typeof parseDocument>[1]> & { readonly maxAliasCount: number };
  const document = parseDocument(text, parseOptions);
  const error = document.errors[0];
  if (error !== undefined) {
    const code = error.code === "DUPLICATE_KEY"
      ? "DUPLICATE_KEY"
      : schema === "json" ? "KNOWLEDGE_IMPORT_JSON_INVALID" : "KNOWLEDGE_IMPORT_YAML_INVALID";
    fail(code, error.message, `line ${error.linePos?.[0]?.line ?? 1}`);
  }
  let expanded: unknown;
  try {
    // This pass enforces YAML's alias accounting before our AST conversion.
    expanded = document.toJS({ maxAliasCount: schema === "json" ? 0 : 20 });
  } catch (error_) {
    const message = error_ instanceof Error ? error_.message : String(error_);
    if (/alias|resource exhaustion/iu.test(message)) {
      fail("YAML_ALIAS_LIMIT", message, "$");
    }
    fail("KNOWLEDGE_IMPORT_YAML_INVALID", message, "$");
  }
  validateYamlNode(document.contents as YamlNode | null);
  return sanitizeJavaScriptValue(expanded, "$");
}

function isRecordArray(value: JsonValue): value is Array<{ readonly [key: string]: JsonValue }> {
  return Array.isArray(value)
    && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

function isKeyValueGlossary(value: JsonValue): value is { readonly [key: string]: JsonPrimitive } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, item]) =>
    item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function discoverRecordPaths(value: JsonValue): RecordPathState[] {
  const discovered: Array<{ path: string; shape: "records" | "key_value"; value: JsonValue }> = [];
  const visit = (child: JsonValue, path: string): void => {
    if (isRecordArray(child)) {
      discovered.push({ path, shape: "records", value: child });
      return;
    }
    if (isKeyValueGlossary(child)) {
      discovered.push({ path, shape: "key_value", value: child });
      return;
    }
    if (Array.isArray(child)) {
      child.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (child !== null && typeof child === "object") {
      for (const [key, item] of Object.entries(child)) visit(item, `${path}.${key}`);
    }
  };
  visit(value, "$");
  return discovered.map((item, index) => ({
    path: Object.freeze({
      id: `record-path:${index + 1}`,
      label: item.path,
      path: item.path,
      shape: item.shape,
    }),
    value: item.value,
  }));
}

async function inspectSanitized(value: JsonValue): Promise<StructuredInspection> {
  inspectJsonShape(value);
  const paths = discoverRecordPaths(value);
  const templateRecords = paths.find((item) => item.path.path === "$.records");
  const officialTemplate = identifyOfficialTemplate(value, templateRecords?.path.id);
  const inspection: StructuredInspection = Object.freeze({
    recordPaths: Object.freeze(paths.map((item) => item.path)),
    ...(officialTemplate === undefined ? {} : { officialTemplate }),
  });
  inspectionState.set(inspection, new Map(paths.map((item) => [item.path.id, item])));
  return inspection;
}

export async function inspectJson(value: unknown): Promise<StructuredInspection> {
  return inspectSanitized(sanitizeJavaScriptValue(value, "$"));
}

export async function inspectJsonText(text: string): Promise<StructuredInspection> {
  return inspectSanitized(parseStructuredText(text, "json"));
}

export async function inspectYamlText(text: string): Promise<StructuredInspection> {
  return inspectSanitized(parseStructuredText(text, "core"));
}

export async function readStructuredRecords(
  inspection: StructuredInspection,
  recordPathId: string,
): Promise<readonly StructuredRecord[]> {
  const state = inspectionState.get(inspection)?.get(recordPathId);
  if (state === undefined) {
    fail(
      "KNOWLEDGE_IMPORT_RECORD_PATH_UNKNOWN",
      "record path id was not produced by this inspection",
      recordPathId,
    );
  }
  if (state.path.shape === "key_value") {
    return Object.freeze(Object.entries(state.value as Record<string, JsonPrimitive>)
      .map(([source, target], index) => Object.freeze({
        ordinal: index + 1,
        location: `${state.path.path}.${source}`,
        values: Object.freeze({ source, target }),
      })));
  }
  return Object.freeze((state.value as Array<Record<string, JsonValue>>)
    .map((values, index) => Object.freeze({
      ordinal: index + 1,
      location: `${state.path.path}[${index}]`,
      values: Object.freeze({ ...values }),
    })));
}
