import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { XMLParser } from "fast-xml-parser";

import {
  writeLosslessBookEpub,
} from "../src/export/epub-writer.js";
import { writeTranslatedEpubTemplate } from "../src/export/epub-template-writer.js";
import { verifyExport } from "../src/export/export-verifier.js";
import {
  readStoredZipEntries,
  writeStoredZip,
} from "../src/export/stored-zip.js";
import { BookContext } from "../src/fullbook/book-context.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import {
  losslessBookLineage,
  losslessBookTranslations,
  writeLosslessBookArtifacts,
} from "../src/report.js";
import { importSource } from "../src/source/source-importer.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

function sourceManifest(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-epub-writer-"));
  const payload = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(payload).digest("hex");
  writeFileSync(join(directory, "original.txt"), payload);
  writeFileSync(join(directory, "source.txt"), payload);
  const manifest = join(directory, "source_manifest.json");
  writeFileSync(manifest, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: payload.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    canonical_path: "source.txt",
    canonical_chars: [...source].length,
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: [...source].length,
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: 0,
      raw_end: payload.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  return manifest;
}

function fixture(options: { chapters: boolean }): {
  directory: string;
  store: LosslessBookStore;
  runId: string;
  epubPath: string;
  expectedTranslations: string[];
} {
  const source = [
    "A".repeat(3_500),
    "B".repeat(3_500),
    "C".repeat(3_500),
    "D".repeat(3_500),
  ].join("\n\n");
  const manifest = sourceManifest(source);
  const directory = dirname(manifest);
  const context = BookContext.openLossless({ manifestPath: manifest });
  const store = new LosslessBookStore(join(directory, "book.db"));
  const runId = options.chapters ? "run-chapters" : "run-fallback";
  store.registerSource(context.certifiedSource!);
  store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
    annotations: context.annotations,
    blocks: context.losslessBlocks,
  });
  const snapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({
    runId,
    sourceVersion: context.sourceLedger.sourceVersion,
    protocolVersion: "v5-book-3",
    modelId: "epub-test-model",
    initialSnapshotId: snapshot.id,
    initialSnapshot: snapshot,
    metadata: { fixture: "epub-writer" },
  });
  const baseWindows = planBookWindows(context.losslessBlocks, {
    protocolVersion: "v5-book-3",
    maxBlocks: 1,
  });
  const windows = options.chapters
    ? baseWindows.map((window, index) => ({
      ...window,
      chapterId: `chapter-${Math.floor(index / 2) + 1}`,
      chapterTitle: `Source chapter ${Math.floor(index / 2) + 1}`,
    }))
    : baseWindows;
  store.initializeWindowPlan(runId, windows);
  const expectedTranslations: string[] = [];
  for (const [index, window] of windows.entries()) {
    store.bindWindowsToSnapshot(runId, [window.windowId], snapshot.id);
    store.claimWindow(runId, window.windowId);
    const text = [
      `第 ${index + 1} 段 & <保留> “引号”`,
      `日本語 ${index + 1}\n한국어 ${index + 1}`,
    ].join("\n\n");
    expectedTranslations.push(text);
    store.stageWindow({
      runId,
      windowId: window.windowId,
      snapshotId: snapshot.id,
      status: "completed",
      translations: window.blockIds.map((blockId) => {
        const block = context.losslessBlocks.find((item) => item.id === blockId)!;
        return { blockId, sourceHash: block.sourceHash, text };
      }),
      knowledgeCandidates: [],
      styleTail: "",
      budget: {},
      warnings: [],
    });
    store.promoteStagedWindow(runId, window.windowId);
  }
  context.close();
  return {
    directory,
    store,
    runId,
    epubPath: join(directory, `${runId}.epub`),
    expectedTranslations,
  };
}

test("EPUB writer emits a valid ordered EPUB 3 with escaped CJK XHTML and lineage", async () => {
  const item = fixture({ chapters: true });
  try {
    assert.equal(await writeLosslessBookEpub(
      item.store,
      item.runId,
      item.epubPath,
      { title: "书名 & <测试>", language: "zh-CN" },
    ), item.epubPath);

    const entries = readStoredZipEntries(item.epubPath);
    assert.equal(entries[0]?.name, "mimetype");
    assert.equal(entries[0]?.method, 0);
    assert.equal(entries[0]?.data.toString("utf8"), "application/epub+zip");
    for (const required of [
      "META-INF/container.xml",
      "META-INF/v5-lineage.json",
      "EPUB/package.opf",
      "EPUB/nav.xhtml",
      "EPUB/styles.css",
    ]) {
      assert.ok(entries.some((entry) => entry.name === required), required);
    }

    const parser = new XMLParser({ ignoreAttributes: false });
    const xmlEntries = entries.filter((entry) =>
      /\.(?:xml|opf|xhtml)$/u.test(entry.name));
    assert.doesNotThrow(() => {
      for (const entry of xmlEntries) parser.parse(entry.data.toString("utf8"));
    });
    const sections = entries.filter((entry) => /^EPUB\/section-\d+\.xhtml$/u.test(entry.name));
    assert.equal(sections.length, 2);
    const joined = sections.map((entry) => entry.data.toString("utf8")).join("\n");
    assert.match(joined, /&amp;/u);
    assert.match(joined, /&lt;保留&gt;/u);
    assert.match(joined, /日本語/u);
    assert.match(joined, /한국어/u);
    const positions = item.expectedTranslations.map((text) =>
      joined.indexOf(text.split("\n\n")[0]!.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);

    const lineageEntry = entries.find((entry) => entry.name === "META-INF/v5-lineage.json");
    assert.ok(lineageEntry);
    const lineage = JSON.parse(lineageEntry.data.toString("utf8"));
    assert.equal(lineage.schema, "v5-book-lineage-1");
    assert.equal(lineage.runId, item.runId);
    assert.equal(lineage.complete, true);
  } finally {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("EPUB writer falls back to deterministic block-boundary sections", async () => {
  const item = fixture({ chapters: false });
  try {
    await writeLosslessBookEpub(
      item.store,
      item.runId,
      item.epubPath,
      {
        title: "Fallback",
        language: "zh-CN",
        fallbackSectionChars: 30,
      },
    );
    const sections = readStoredZipEntries(item.epubPath)
      .filter((entry) => /^EPUB\/section-\d+\.xhtml$/u.test(entry.name));
    assert.equal(sections.length, item.expectedTranslations.length);
  } finally {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("EPUB template round-trip preserves footnotes, backlinks, cross-chapter links, and resources", async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-epub-roundtrip-"));
  const sourcePath = join(directory, "annotated.epub");
  const projectDirectory = join(directory, "project");
  const outputPath = join(directory, "translated.epub");
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Annotated fixture</dc:title><dc:language>en</dc:language></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="notes/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>One</title></head><body>
<p id="return-1">Read <a epub:type="noteref" href="../notes/notes.xhtml#fn-1">this note</a>.</p>
<p>Continue to <a href="chapter2.xhtml#part-2">the second chapter</a>.</p>
<p>Visit <a href="https://example.com/a?x=1&amp;y=2">the example</a>.</p>
</body></html>`;
  const notes = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Notes</title></head><body>
<aside id="fn-1" epub:type="footnote"><p>Footnote body. <a epub:type="backlink" href="../text/chapter1.xhtml#return-1">Back</a>.</p></aside>
</body></html>`;
  const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1 id="part-2">Second chapter</h1></body></html>`;
  writeStoredZip(sourcePath, [
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: "OEBPS/content.opf", data: packageDocument },
    {
      name: "OEBPS/nav.xhtml",
      data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="text/chapter1.xhtml">One</a></li><li><a href="notes/notes.xhtml">Notes</a></li><li><a href="text/chapter2.xhtml">Two</a></li></ol></nav></body></html>`,
    },
    { name: "OEBPS/style.css", data: "a { color: blue; }\n" },
    { name: "OEBPS/text/chapter1.xhtml", data: chapter1, method: 8 },
    { name: "OEBPS/notes/notes.xhtml", data: notes, method: 8 },
    { name: "OEBPS/text/chapter2.xhtml", data: chapter2 },
  ]);
  let store: LosslessBookStore | undefined;
  let context: BookContext | undefined;
  try {
    const imported = await importSource({
      sourcePath,
      projectDirectory,
      sourceLanguage: "en",
    });
    context = BookContext.openLossless({ manifestPath: imported.manifestPath });
    store = new LosslessBookStore(join(directory, "roundtrip.db"));
    store.registerSource(context.certifiedSource!);
    store.replaceDerivedPlan(context.sourceLedger.sourceVersion, {
      annotations: context.annotations,
      blocks: context.losslessBlocks,
    });
    const runId = "epub-roundtrip";
    const snapshot = createKnowledgeSnapshot(runId, []);
    store.createTranslationRun({
      runId,
      sourceVersion: context.sourceLedger.sourceVersion,
      protocolVersion: "v5-book-3",
      modelId: "deterministic-epub-test",
      initialSnapshotId: snapshot.id,
      initialSnapshot: snapshot,
      metadata: { fixture: "annotated-epub" },
    });
    const windows = planBookWindows(context.losslessBlocks, {
      protocolVersion: "v5-book-3",
      maxBlocks: 1,
    });
    store.initializeWindowPlan(runId, windows);
    const replacements = new Map([
      ["Read ", "阅读 "],
      ["this note", "这条注释"],
      ["Continue to ", "继续前往 "],
      ["the second chapter", "第二章"],
      ["Visit ", "访问 "],
      ["the example", "示例网站"],
      ["Footnote body. ", "脚注正文。"],
      ["Back", "返回"],
      ["Second chapter", "第二章"],
    ]);
    for (const window of windows) {
      store.bindWindowsToSnapshot(runId, [window.windowId], snapshot.id);
      store.claimWindow(runId, window.windowId);
      store.stageWindow({
        runId,
        windowId: window.windowId,
        snapshotId: snapshot.id,
        status: "completed",
        translations: window.blockIds.map((blockId) => {
          const block = context!.losslessBlocks.find((item) => item.id === blockId)!;
          let text = block.sourceText;
          for (const [source, target] of replacements) text = text.replaceAll(source, target);
          return { blockId, sourceHash: block.sourceHash, text };
        }),
        knowledgeCandidates: [],
        styleTail: "",
        budget: {},
        warnings: [],
      });
      store.promoteStagedWindow(runId, window.windowId);
    }
    await writeLosslessBookEpub(store, runId, outputPath, {
      title: "注释测试",
      language: "zh-CN",
      sourceManifestPath: imported.manifestPath,
    });
    const artifacts = writeLosslessBookArtifacts(
      store,
      runId,
      join(directory, "artifacts"),
    );
    assert.equal(
      verifyExport({ ...artifacts, epub: outputPath }, store, runId).ok,
      true,
    );
    const entries = new Map(readStoredZipEntries(outputPath).map((entry) => [
      entry.name,
      entry.data.toString("utf8"),
    ]));
    const translatedChapter = entries.get("OEBPS/text/chapter1.xhtml") ?? "";
    const translatedNotes = entries.get("OEBPS/notes/notes.xhtml") ?? "";
    assert.match(translatedChapter, /id="return-1"/u);
    assert.match(translatedChapter, /epub:type="noteref" href="\.\.\/notes\/notes\.xhtml#fn-1">这条注释<\/a>/u);
    assert.match(translatedChapter, /href="chapter2\.xhtml#part-2">第二章<\/a>/u);
    assert.match(translatedChapter, /href="https:\/\/example\.com\/a\?x=1&amp;y=2">示例网站<\/a>/u);
    assert.match(translatedNotes, /id="fn-1" epub:type="footnote"/u);
    assert.match(translatedNotes, /epub:type="backlink" href="\.\.\/text\/chapter1\.xhtml#return-1">返回<\/a>/u);
    assert.equal(entries.get("OEBPS/content.opf"), packageDocument);
    assert.equal(entries.get("OEBPS/style.css"), "a { color: blue; }\n");

    const brokenOutput = join(directory, "broken-slot.epub");
    const brokenTranslations = losslessBookTranslations(store, runId).map(
      (translation, index) => ({
        ...translation,
        text: index === 0
          ? translation.text.replace(/⟦E\d+\.\d+\.\d+⟧/u, "")
          : translation.text,
      }),
    );
    await assert.rejects(
      writeTranslatedEpubTemplate({
        sourceManifestPath: imported.manifestPath,
        translations: brokenTranslations,
        lineage: losslessBookLineage(store, runId),
        outputPath: brokenOutput,
      }),
      /EPUB_STRUCTURAL_SLOT_MISMATCH/u,
    );
    assert.equal(existsSync(brokenOutput), false);
    const smokeDirectory = process.env.FOLIOLOOM_EPUB_SMOKE_DIR;
    if (smokeDirectory !== undefined && smokeDirectory.length > 0) {
      mkdirSync(smokeDirectory, { recursive: true });
      copyFileSync(sourcePath, join(smokeDirectory, "annotated-source.epub"));
      copyFileSync(outputPath, join(smokeDirectory, "annotated-translated.epub"));
      writeFileSync(join(smokeDirectory, "verification.json"), `${JSON.stringify({
        schema: "folioloom-epub-smoke-1",
        version: "1.5.2",
        verified: true,
        cases: [
          "noteref",
          "footnote",
          "backlink",
          "cross-chapter-fragment",
          "external-url",
          "opf-spine-nav-resource-preservation",
          "broken-slot-no-publish",
        ],
      }, null, 2)}\n`, "utf8");
    }
  } finally {
    store?.close();
    context?.close();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(existsSync(outputPath), false);
});

test("stored ZIP writer rejects duplicate and traversal entry names", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-stored-zip-"));
  try {
    assert.throws(
      () => writeStoredZip(join(directory, "duplicate.zip"), [
        { name: "same.txt", data: "a" },
        { name: "same.txt", data: "b" },
      ]),
      /duplicate ZIP entry/u,
    );
    for (const name of ["../escape.txt", "/absolute.txt", "folder\\file.txt"]) {
      assert.throws(
        () => writeStoredZip(join(directory, "invalid.zip"), [{ name, data: "x" }]),
        /invalid ZIP entry/u,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
