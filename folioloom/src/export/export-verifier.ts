import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { XMLParser, XMLValidator } from "fast-xml-parser";

import { readStoredZipEntries, type StoredZipEntry } from "./stored-zip.js";
import {
  auditLosslessBookExport,
  losslessBookLineage,
  losslessBookTranslations,
  renderBilingual,
  renderTranslation,
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
  | "EPUB_LINEAGE_MISMATCH"
  | "TRANSLATION_CONTENT_MISMATCH"
  | "BILINGUAL_CONTENT_MISMATCH"
  | "AUDIT_CONTENT_MISMATCH"
  | "EPUB_INVALID"
  | "EPUB_MIMETYPE_INVALID"
  | "EPUB_PACKAGE_INVALID"
  | "EPUB_NAVIGATION_INVALID"
  | "EPUB_LINK_INVALID";

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

function readMatches(path: string, expected: string): boolean {
  try {
    return readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

function validXml(text: string): boolean {
  return XMLValidator.validate(text) === true;
}

function arrayOf<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value] as readonly T[];
}

type XmlObject = Record<string, unknown>;

function xmlObject(value: unknown): XmlObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as XmlObject
    : undefined;
}

function attribute(value: unknown, name: string): string | undefined {
  const item = xmlObject(value)?.[`@_${name}`];
  return typeof item === "string" ? item : undefined;
}

function safeEntryPath(basePath: string, reference: string): string | undefined {
  if (reference.length === 0
    || reference.startsWith("/")
    || reference.includes("\\")) {
    return undefined;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(basePath), reference));
  return resolved.startsWith("../") || resolved === ".." ? undefined : resolved;
}

function resolvedEpubHref(
  basePath: string,
  href: string,
): { readonly path: string; readonly fragment?: string } | "external" | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href) || href.startsWith("//")) {
    return "external";
  }
  const hashAt = href.indexOf("#");
  const rawPath = (hashAt < 0 ? href : href.slice(0, hashAt)).split("?", 1)[0] ?? "";
  let reference: string;
  let fragment: string | undefined;
  try {
    reference = decodeURIComponent(rawPath);
    if (hashAt >= 0) fragment = decodeURIComponent(href.slice(hashAt + 1));
  } catch {
    return undefined;
  }
  const path = reference.length === 0 ? basePath : safeEntryPath(basePath, reference);
  if (path === undefined) return undefined;
  return {
    path,
    ...(fragment === undefined || fragment.length === 0 ? {} : { fragment }),
  };
}

function collectElements(value: unknown, tag: string, target: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) collectElements(item, tag, target);
    return target;
  }
  const object = xmlObject(value);
  if (object === undefined) return target;
  for (const [key, item] of Object.entries(object)) {
    if (key === tag) {
      target.push(...arrayOf(item));
    }
    collectElements(item, tag, target);
  }
  return target;
}

const epubXmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});

function verifyEpub(
  path: string,
  expectedLineageJson: string,
  incidents: Set<ExportVerificationIncidentCode>,
): void {
  let entries: readonly StoredZipEntry[];
  try {
    entries = readStoredZipEntries(path);
  } catch {
    incidents.add("EPUB_INVALID");
    return;
  }
  if (entries.length === 0) {
    incidents.add("EPUB_INVALID");
    return;
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)
      || entry.name.length === 0
      || entry.name.startsWith("/")
      || entry.name.includes("\\")
      || entry.name.split("/").some((part) => part === "." || part === "..")) {
      incidents.add("EPUB_INVALID");
    }
    names.add(entry.name);
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const mimetype = entries[0];
  if (mimetype?.name !== "mimetype"
    || mimetype.method !== 0
    || mimetype.data.toString("utf8") !== "application/epub+zip") {
    incidents.add("EPUB_MIMETYPE_INVALID");
  }

  const lineagePayload = byName.get("META-INF/v5-lineage.json")?.data;
  if (lineagePayload === undefined) {
    incidents.add("EPUB_LINEAGE_MISSING");
  } else {
    try {
      if (canonical(JSON.parse(lineagePayload.toString("utf8"))) !== expectedLineageJson) {
        incidents.add("EPUB_LINEAGE_MISMATCH");
      }
    } catch {
      incidents.add("EPUB_LINEAGE_MISMATCH");
    }
  }

  let packagePath: string | undefined;
  const containerText = byName.get("META-INF/container.xml")?.data.toString("utf8");
  if (containerText === undefined || !validXml(containerText)) {
    incidents.add("EPUB_PACKAGE_INVALID");
  } else {
    try {
      const container = epubXmlParser.parse(containerText) as unknown;
      const rootfiles = collectElements(container, "rootfile");
      const rootPaths = rootfiles
        .map((rootfile) => attribute(rootfile, "full-path"))
        .filter((item): item is string => item !== undefined);
      const rootPath = rootPaths.length === 1
        ? safeEntryPath("package.opf", rootPaths[0] ?? "")
        : undefined;
      if (rootPath === undefined || !byName.has(rootPath)) {
        incidents.add("EPUB_PACKAGE_INVALID");
      } else {
        packagePath = rootPath;
      }
    } catch {
      incidents.add("EPUB_PACKAGE_INVALID");
    }
  }
  if (packagePath === undefined) return;

  const packageText = byName.get(packagePath)?.data.toString("utf8");
  if (packageText === undefined || !validXml(packageText)) {
    incidents.add("EPUB_PACKAGE_INVALID");
    return;
  }
  let manifestById = new Map<string, { path: string; mediaType: string; properties: string }>();
  let spinePaths: string[] = [];
  let xhtmlPaths: string[] = [];
  let navPath: string | undefined;
  try {
    const packageDocument = epubXmlParser.parse(packageText) as unknown;
    const packageNode = xmlObject(xmlObject(packageDocument)?.package);
    const manifestNode = xmlObject(packageNode?.manifest);
    const spineNode = xmlObject(packageNode?.spine);
    const manifestItems = arrayOf(manifestNode?.item);
    for (const item of manifestItems) {
      const id = attribute(item, "id");
      const href = attribute(item, "href");
      const mediaType = attribute(item, "media-type");
      const properties = attribute(item, "properties") ?? "";
      const resolved = href === undefined ? undefined : safeEntryPath(packagePath, href);
      if (id === undefined || mediaType === undefined || resolved === undefined
        || manifestById.has(id) || !byName.has(resolved)) {
        incidents.add("EPUB_PACKAGE_INVALID");
        continue;
      }
      manifestById.set(id, { path: resolved, mediaType, properties });
      if (mediaType === "application/xhtml+xml") {
        xhtmlPaths.push(resolved);
      }
      if (properties.split(/\s+/u).includes("nav")) {
        if (navPath !== undefined || mediaType !== "application/xhtml+xml") {
          incidents.add("EPUB_PACKAGE_INVALID");
        }
        navPath = resolved;
      }
    }
    const itemrefs = arrayOf(spineNode?.itemref);
    for (const itemref of itemrefs) {
      const idref = attribute(itemref, "idref");
      const manifestItem = idref === undefined ? undefined : manifestById.get(idref);
      if (manifestItem === undefined
        || manifestItem.mediaType !== "application/xhtml+xml"
        || manifestItem.properties.split(/\s+/u).includes("nav")) {
        incidents.add("EPUB_PACKAGE_INVALID");
      } else {
        spinePaths.push(manifestItem.path);
      }
    }
    if (manifestById.size === 0 || spinePaths.length === 0 || navPath === undefined) {
      incidents.add("EPUB_PACKAGE_INVALID");
    }
  } catch {
    incidents.add("EPUB_PACKAGE_INVALID");
    return;
  }

  for (const xhtmlPath of spinePaths) {
    const text = byName.get(xhtmlPath)?.data.toString("utf8");
    if (text === undefined || !validXml(text)) {
      incidents.add("EPUB_INVALID");
    } else {
      try {
        epubXmlParser.parse(text);
      } catch {
        incidents.add("EPUB_INVALID");
      }
    }
  }

  const idsByPath = new Map<string, Set<string>>();
  const links: Array<{ readonly basePath: string; readonly href: string }> = [];
  const collectGraph = (value: unknown, basePath: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectGraph(item, basePath);
      return;
    }
    const node = xmlObject(value);
    if (node === undefined) return;
    const id = attribute(node, "id");
    if (id !== undefined) {
      const ids = idsByPath.get(basePath) ?? new Set<string>();
      if (ids.has(id)) {
        incidents.add("EPUB_LINK_INVALID");
      }
      ids.add(id);
      idsByPath.set(basePath, ids);
    }
    const href = attribute(node, "href");
    if (href !== undefined) links.push({ basePath, href });
    for (const [key, item] of Object.entries(node)) {
      if (!key.startsWith("@_")) collectGraph(item, basePath);
    }
  };
  for (const xhtmlPath of xhtmlPaths) {
    const payload = byName.get(xhtmlPath)?.data.toString("utf8");
    if (payload === undefined || !validXml(payload)) {
      incidents.add("EPUB_INVALID");
      continue;
    }
    try {
      collectGraph(epubXmlParser.parse(payload), xhtmlPath);
    } catch {
      incidents.add("EPUB_INVALID");
    }
  }
  for (const link of links) {
    const resolved = resolvedEpubHref(link.basePath, link.href);
    if (resolved === "external") continue;
    if (resolved === undefined || !byName.has(resolved.path)) {
      incidents.add("EPUB_LINK_INVALID");
      continue;
    }
    if (resolved.fragment !== undefined
      && !idsByPath.get(resolved.path)?.has(resolved.fragment)) {
      incidents.add("EPUB_LINK_INVALID");
    }
  }

  const navText = navPath === undefined
    ? undefined
    : byName.get(navPath)?.data.toString("utf8");
  if (navPath === undefined || navText === undefined || !validXml(navText)) {
    incidents.add("EPUB_NAVIGATION_INVALID");
    return;
  }
  try {
    const navDocument = epubXmlParser.parse(navText) as unknown;
    const hrefs = collectElements(navDocument, "a")
      .map((anchor) => attribute(anchor, "href"))
      .filter((item): item is string => item !== undefined);
    const targets = new Set(
      hrefs
        .map((href) => safeEntryPath(navPath, href.split("#", 1)[0] ?? ""))
        .filter((item): item is string => item !== undefined && byName.has(item)),
    );
    if (hrefs.length === 0 || spinePaths.some((spinePath) => !targets.has(spinePath))) {
      incidents.add("EPUB_NAVIGATION_INVALID");
    }
  } catch {
    incidents.add("EPUB_NAVIGATION_INVALID");
  }
}

export function verifyExport(
  paths: LosslessBookArtifactPaths,
  store: LosslessBookStore,
  runId: string,
): ExportVerificationResult {
  const incidents = new Set<ExportVerificationIncidentCode>();
  const exportAudit = auditLosslessBookExport(store, runId);
  const expected = {
    ...losslessBookLineage(store, runId),
    complete: exportAudit.audit.complete,
  };
  const expectedJson = canonical(expected);
  const translations = losslessBookTranslations(store, runId);
  if (!readMatches(paths.translation, renderTranslation(translations, {
    includeChapterMetadata: false,
  }))) {
    incidents.add("TRANSLATION_CONTENT_MISMATCH");
  }
  if (!readMatches(paths.bilingual, renderBilingual(translations))) {
    incidents.add("BILINGUAL_CONTENT_MISMATCH");
  }
  try {
    const actualAudit = JSON.parse(readFileSync(paths.audit, "utf8")) as unknown;
    if (canonical(actualAudit) !== canonical(exportAudit.audit)) {
      incidents.add("AUDIT_CONTENT_MISMATCH");
    }
  } catch {
    incidents.add("AUDIT_CONTENT_MISMATCH");
  }
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
    verifyEpub(paths.epub, expectedJson, incidents);
  }
  const incidentCodes = [...incidents].sort();
  return {
    schema: "v5-export-verification-1",
    runId,
    ok: incidentCodes.length === 0,
    incidentCodes,
  };
}
