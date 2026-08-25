import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  losslessBookLineage,
  losslessBookTranslations,
  type PilotTranslation,
} from "../report.js";
import type { LosslessBookStore } from "../storage/lossless-book-store.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";
import { writeStoredZip, type StoredZipInput } from "./stored-zip.js";
import { writeTranslatedEpubTemplate } from "./epub-template-writer.js";

export interface LosslessEpubOptions {
  title: string;
  language: "zh-CN";
  fallbackSectionChars?: number;
  sourceManifestPath?: string;
}

interface EpubSection {
  ordinal: number;
  translations: PilotTranslation[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function paragraphMarkup(text: string): string {
  const normalized = stripEpubStructuralMarkers(text)
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (normalized.length === 0) {
    return "";
  }
  return normalized
    .split(/\n{2,}/gu)
    .map((paragraph) => `<p>${escapeXml(paragraph).replaceAll("\n", "<br/>")}</p>`)
    .join("\n");
}

function groupSections(
  translations: readonly PilotTranslation[],
  fallbackSectionChars: number,
): EpubSection[] {
  const hasChapters = translations.some((translation) =>
    translation.chapterId !== null && !translation.chapterId.startsWith("chapter-at-"));
  const sections: EpubSection[] = [];
  if (hasChapters) {
    let previousChapter: string | null | undefined;
    for (const translation of translations) {
      if (sections.length === 0 || translation.chapterId !== previousChapter) {
        sections.push({ ordinal: sections.length + 1, translations: [] });
        previousChapter = translation.chapterId;
      }
      sections.at(-1)!.translations.push(translation);
    }
    return sections;
  }

  for (const translation of translations) {
    const current = sections.at(-1);
    const currentChars = current?.translations.reduce(
      (total, item) => total + [...item.text].length,
      0,
    ) ?? 0;
    if (current === undefined
      || (current.translations.length > 0
        && currentChars + [...translation.text].length > fallbackSectionChars)) {
      sections.push({ ordinal: sections.length + 1, translations: [] });
    }
    sections.at(-1)!.translations.push(translation);
  }
  return sections;
}

function sectionXhtml(section: EpubSection, language: string): string {
  const body = section.translations
    .map((translation) => paragraphMarkup(translation.text))
    .filter((item) => item.length > 0)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head>
  <meta charset="UTF-8"/>
  <title>第 ${section.ordinal} 节</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <section epub:type="chapter" xmlns:epub="http://www.idpf.org/2007/ops">
    <h1>第 ${section.ordinal} 节</h1>
${body}
  </section>
</body>
</html>
`;
}

export async function writeLosslessBookEpub(
  store: LosslessBookStore,
  runId: string,
  outputPath: string,
  options: LosslessEpubOptions,
): Promise<string> {
  const translations = losslessBookTranslations(store, runId);
  if (translations.length === 0) {
    throw new Error("EPUB export requires at least one translated block");
  }
  if (options.sourceManifestPath !== undefined) {
    const manifest = JSON.parse(
      readFileSync(options.sourceManifestPath, "utf8"),
    ) as Record<string, unknown>;
    if (manifest.source_format === ".epub") {
      return writeTranslatedEpubTemplate({
        sourceManifestPath: options.sourceManifestPath,
        translations,
        lineage: losslessBookLineage(store, runId),
        outputPath,
      });
    }
  }
  const sections = groupSections(
    translations,
    Math.max(1, options.fallbackSectionChars ?? 120_000),
  );
  const title = escapeXml(options.title.trim() || basename(outputPath, ".epub"));
  const language = escapeXml(options.language);
  const sectionItems = sections.map((section) => {
    const id = `section-${section.ordinal}`;
    return {
      id,
      href: `${id}.xhtml`,
      label: `第 ${section.ordinal} 节`,
    };
  });
  const manifestItems = sectionItems.map((item) =>
    `    <item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`,
  ).join("\n");
  const spineItems = sectionItems.map((item) =>
    `    <itemref idref="${item.id}"/>`,
  ).join("\n");
  const navItems = sectionItems.map((item) =>
    `      <li><a href="${item.href}">${item.label}</a></li>`,
  ).join("\n");
  const identifier = `urn:folioloom:${escapeXml(runId)}`;

  const entries: StoredZipInput[] = [
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
    },
    {
      name: "META-INF/v5-lineage.json",
      data: `${JSON.stringify(losslessBookLineage(store, runId), null, 2)}\n`,
    },
    {
      name: "EPUB/package.opf",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${identifier}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>${language}</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="styles" href="styles.css" media-type="text/css"/>
${manifestItems}
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>
`,
    },
    {
      name: "EPUB/nav.xhtml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><meta charset="UTF-8"/><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>
`,
    },
    {
      name: "EPUB/styles.css",
      data: `html { writing-mode: horizontal-tb; }
body { font-family: serif; line-height: 1.75; margin: 5%; }
h1 { font-size: 1.4em; margin: 0 0 1.5em; }
p { margin: 0 0 1em; text-indent: 2em; }
`,
    },
    ...sections.map((section) => ({
      name: `EPUB/section-${section.ordinal}.xhtml`,
      data: sectionXhtml(section, options.language),
    })),
  ];
  writeStoredZip(outputPath, entries);
  return outputPath;
}
