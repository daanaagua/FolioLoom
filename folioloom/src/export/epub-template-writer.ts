import { randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";

import { XMLParser } from "fast-xml-parser";

import type {
  LosslessBookLineage,
  PilotTranslation,
} from "../report.js";
import {
  analyzeEpubXhtml,
  rewriteEpubXhtml,
  stripEpubStructuralMarkers,
  type EpubXhtmlAnalysis,
} from "../source/epub-structure.js";
import { SourceLedger } from "../source/source-ledger.js";
import { writeStoredZip, type StoredZipInput } from "./stored-zip.js";
import { readZipArchive } from "./zip-archive.js";

type XmlObject = Record<string, unknown>;

const XML = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});

function object(value: unknown, context: string): XmlObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`EPUB_TEMPLATE_INVALID: ${context} must be an XML object`);
  }
  return value as XmlObject;
}

function arrayOf<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value] as readonly T[];
}

function attribute(value: unknown, name: string): string | undefined {
  const found = object(value, name)[`@_${name}`];
  return typeof found === "string" ? found : undefined;
}

function decodeUtf8(payload: Buffer, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new Error(
      `EPUB_TEMPLATE_INVALID: ${context} is not UTF-8: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function archiveReference(parent: string, reference: string): string {
  const withoutFragment = reference.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    throw new Error(`EPUB_TEMPLATE_INVALID: malformed archive reference ${reference}`);
  }
  if (decoded.length === 0
    || decoded.startsWith("/")
    || decoded.includes("\\")) {
    throw new Error(`EPUB_TEMPLATE_INVALID: unsafe archive reference ${reference}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(parent), decoded));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`EPUB_TEMPLATE_INVALID: escaping archive reference ${reference}`);
  }
  return resolved;
}

function packagePath(containerText: string): string {
  const parsed = object(XML.parse(containerText), "container document");
  const container = object(parsed.container, "container");
  const rootfiles = object(container.rootfiles, "rootfiles");
  const rootfile = arrayOf(rootfiles.rootfile)[0];
  const path = rootfile === undefined ? undefined : attribute(rootfile, "full-path");
  if (path === undefined) {
    throw new Error("EPUB_TEMPLATE_INVALID: container has no rootfile");
  }
  return path;
}

function spinePaths(opfText: string, opfPath: string): string[] {
  const parsed = object(XML.parse(opfText), "package document");
  const packageNode = object(parsed.package, "package");
  const manifest = object(packageNode.manifest, "manifest");
  const spine = object(packageNode.spine, "spine");
  const byId = new Map<string, {
    path: string;
    mediaType: string;
    properties: string;
  }>();
  const manifestOrder: Array<{
    path: string;
    mediaType: string;
    properties: string;
  }> = [];
  for (const item of arrayOf(manifest.item)) {
    const id = attribute(item, "id");
    const href = attribute(item, "href");
    const mediaType = attribute(item, "media-type");
    if (id === undefined || href === undefined || mediaType === undefined || byId.has(id)) {
      throw new Error("EPUB_TEMPLATE_INVALID: malformed or duplicate manifest item");
    }
    const member = {
      path: archiveReference(opfPath, href),
      mediaType,
      properties: attribute(item, "properties") ?? "",
    };
    byId.set(id, member);
    manifestOrder.push(member);
  }
  const paths: string[] = [];
  for (const itemref of arrayOf(spine.itemref)) {
    const idref = attribute(itemref, "idref");
    const item = idref === undefined ? undefined : byId.get(idref);
    if (item === undefined || item.mediaType !== "application/xhtml+xml") {
      throw new Error(`EPUB_TEMPLATE_INVALID: invalid spine reference ${String(idref)}`);
    }
    paths.push(item.path);
  }
  if (paths.length === 0) {
    throw new Error("EPUB_TEMPLATE_INVALID: package spine is empty");
  }
  const spineSet = new Set(paths);
  return [
    ...paths,
    ...manifestOrder
      .filter((item) =>
        item.mediaType === "application/xhtml+xml"
        && !item.properties.split(/\s+/u).includes("nav")
        && !spineSet.has(item.path))
      .map((item) => item.path),
  ];
}

function paragraphUnits(text: string): string[] {
  return text
    .trim()
    .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
    .filter((paragraph) => stripEpubStructuralMarkers(paragraph).trim().length > 0);
}

function translatedStructuralBlocks(
  analyses: readonly EpubXhtmlAnalysis[],
  translations: readonly PilotTranslation[],
): string[][] {
  const sourceBlocks = analyses.flatMap((analysis) =>
    analysis.blocks.map((block) => block.sourceText));
  const units = [...translations]
    .sort((left, right) => left.globalIndex - right.globalIndex)
    .flatMap((translation) => {
      const sources = paragraphUnits(translation.sourceText);
      const targets = paragraphUnits(translation.text);
      if (sources.length !== targets.length) {
        throw new Error(
          `EPUB_STRUCTURAL_SLOT_MISMATCH: block ${translation.blockId} has source paragraphs=${sources.length}, target paragraphs=${targets.length}`,
        );
      }
      return sources.map((source, index) => ({
        source,
        target: targets[index] ?? "",
        blockId: translation.blockId,
      }));
    });
  const targetBlocks: string[] = [];
  let unitIndex = 0;
  for (const [blockIndex, sourceBlock] of sourceBlocks.entries()) {
    let consumedSource = "";
    let translated = "";
    while (consumedSource.length < sourceBlock.length) {
      const unit = units[unitIndex];
      if (unit === undefined) {
        throw new Error(
          `EPUB_STRUCTURAL_SOURCE_MISMATCH: no translation unit for XHTML block ${blockIndex}`,
        );
      }
      const candidate = consumedSource + unit.source;
      if (!sourceBlock.startsWith(candidate)) {
        throw new Error(
          `EPUB_STRUCTURAL_SOURCE_MISMATCH: translation block ${unit.blockId} does not align with XHTML block ${blockIndex}`,
        );
      }
      consumedSource = candidate;
      translated += unit.target;
      unitIndex += 1;
    }
    if (consumedSource !== sourceBlock) {
      throw new Error(
        `EPUB_STRUCTURAL_SOURCE_MISMATCH: XHTML block ${blockIndex} is only partially covered`,
      );
    }
    targetBlocks.push(translated);
  }
  if (unitIndex !== units.length) {
    throw new Error("EPUB_STRUCTURAL_SOURCE_MISMATCH: translation has trailing unmatched units");
  }
  const grouped: string[][] = [];
  let cursor = 0;
  for (const analysis of analyses) {
    grouped.push(targetBlocks.slice(cursor, cursor + analysis.blocks.length));
    cursor += analysis.blocks.length;
  }
  return grouped;
}

function markupSignature(xml: string): string {
  return xml.replace(/>[^<]*/gu, ">");
}

function manifestExtractor(manifestPath: string): string | undefined {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  return typeof parsed.extractor === "string" ? parsed.extractor : undefined;
}

function temporaryOutputPath(outputPath: string): string {
  return join(dirname(outputPath), `.${basename(outputPath)}.tmp-${randomUUID()}`);
}

export async function writeTranslatedEpubTemplate(options: {
  readonly sourceManifestPath: string;
  readonly translations: readonly PilotTranslation[];
  readonly lineage: LosslessBookLineage;
  readonly outputPath: string;
}): Promise<string> {
  const ledger = SourceLedger.open(options.sourceManifestPath);
  if (extname(ledger.rawPath).toLocaleLowerCase("en") !== ".epub"
    || manifestExtractor(options.sourceManifestPath) !== "epub-spine-v2") {
    throw new Error("EPUB_TEMPLATE_UNAVAILABLE: project was not imported with epub-spine-v2");
  }
  const entries = await readZipArchive(readFileSync(ledger.rawPath));
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  const mimetype = byName.get("mimetype");
  if (mimetype?.toString("utf8") !== "application/epub+zip") {
    throw new Error("EPUB_TEMPLATE_INVALID: mimetype is missing or invalid");
  }
  const container = byName.get("META-INF/container.xml");
  if (container === undefined) {
    throw new Error("EPUB_TEMPLATE_INVALID: META-INF/container.xml is missing");
  }
  const opfPath = packagePath(decodeUtf8(container, "META-INF/container.xml"));
  const opf = byName.get(opfPath);
  if (opf === undefined) {
    throw new Error(`EPUB_TEMPLATE_INVALID: package is missing: ${opfPath}`);
  }
  const paths = spinePaths(decodeUtf8(opf, opfPath), opfPath);
  const analyses = paths.map((path, ordinal) => {
    const payload = byName.get(path);
    if (payload === undefined) {
      throw new Error(`EPUB_TEMPLATE_INVALID: spine document is missing: ${path}`);
    }
    return analyzeEpubXhtml(decodeUtf8(payload, path), ordinal);
  });
  const canonical = analyses.map((analysis) => analysis.canonicalText).join("\n\n");
  if (canonical !== ledger.sourceText) {
    throw new Error("EPUB_STRUCTURAL_SOURCE_MISMATCH: template extraction differs from source ledger");
  }
  const targets = translatedStructuralBlocks(analyses, [...options.translations]);
  const replacements = new Map<string, Buffer>();
  for (const [index, path] of paths.entries()) {
    const source = decodeUtf8(byName.get(path)!, path);
    const rewritten = rewriteEpubXhtml(source, analyses[index]!, targets[index] ?? []);
    if (markupSignature(rewritten) !== markupSignature(source)) {
      throw new Error(`EPUB_STRUCTURE_MISMATCH: non-text XHTML markup changed in ${path}`);
    }
    replacements.set(path, Buffer.from(rewritten, "utf8"));
  }
  const lineageName = "META-INF/v5-lineage.json";
  replacements.set(lineageName, Buffer.from(`${JSON.stringify(options.lineage, null, 2)}\n`, "utf8"));
  const outputEntries: StoredZipInput[] = [
    { name: "mimetype", data: mimetype },
    ...entries
      .filter((entry) => entry.name !== "mimetype" && entry.name !== lineageName)
      .map((entry) => ({
        name: entry.name,
        data: replacements.get(entry.name) ?? entry.data,
      })),
    { name: lineageName, data: replacements.get(lineageName)! },
  ];
  const temporaryPath = temporaryOutputPath(options.outputPath);
  try {
    writeStoredZip(temporaryPath, outputEntries);
    renameSync(temporaryPath, options.outputPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A failure before writing the temporary file leaves nothing to clean.
    }
    throw error;
  }
  return options.outputPath;
}
