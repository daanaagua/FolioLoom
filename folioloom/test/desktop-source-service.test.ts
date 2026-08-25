import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  DesktopSourceService,
  type DesktopSourceImportResult,
  type DesktopSourceReadyResult,
} from "../src/desktop/desktop-source-service.js";
import { SourceLedger } from "../src/source/source-ledger.js";

function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "folioloom-desktop-source-service-"));
}

function ready(result: DesktopSourceImportResult): DesktopSourceReadyResult {
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("expected a ready source import");
  }
  return result;
}

test("desktop source service creates a reader-named project and never rewrites the selected manuscript", async () => {
  const directory = fixtureDirectory();
  const sourcePath = join(directory, "My: Novel?.txt");
  const projectsRoot = join(directory, "Projects");
  const source = Buffer.from(
    "The book is in the house, and the garden is on the hill. We return to the house with a book and a map.",
    "utf8",
  );
  writeFileSync(sourcePath, source);
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const imported = ready(await service.importSource({ sourcePath, sourceLanguage: "auto" }));
    const ledger = SourceLedger.open(imported.manifestPath);

    assert.equal(imported.reused, false);
    assert.equal(ledger.sourceText, source.toString("utf8"));
    assert.equal(ledger.sourceLanguage, "en");
    assert.equal(existsSync(join(imported.projectDirectory, "source", "original.txt")), true);
    assert.equal(readFileEquals(sourcePath, source), true);
    assert.match(basename(imported.projectDirectory), /^My-Novel-[a-f0-9]{12}$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop source service restores a project when the raw source hash was imported before", async () => {
  const directory = fixtureDirectory();
  const projectsRoot = join(directory, "Projects");
  const firstPath = join(directory, "First Title.txt");
  const renamedPath = join(directory, "Renamed Title.txt");
  writeFileSync(firstPath, "Identical source bytes.", "utf8");
  writeFileSync(renamedPath, "Identical source bytes.", "utf8");
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const first = ready(await service.importSource({ sourcePath: firstPath, sourceLanguage: "en" }));
    const second = ready(await service.importSource({ sourcePath: renamedPath, sourceLanguage: "en" }));

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.projectDirectory, first.projectDirectory);
    assert.equal(second.manifestPath, first.manifestPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop source service does not reuse an undetermined Korean project for a fresh auto import", async () => {
  const directory = fixtureDirectory();
  const projectsRoot = join(directory, "Projects");
  const firstPath = join(directory, "legacy-und.txt");
  const renamedPath = join(directory, "detected-korean.txt");
  const source = "한국어 문장이 충분히 길어서 언어 감지기가 한국어로 판별할 수 있어야 한다. ".repeat(3);
  writeFileSync(firstPath, source, "utf8");
  writeFileSync(renamedPath, source, "utf8");
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const legacy = ready(await service.importSource({ sourcePath: firstPath, sourceLanguage: "und" }));
    const detected = ready(await service.importSource({ sourcePath: renamedPath, sourceLanguage: "auto" }));

    assert.equal(SourceLedger.open(legacy.manifestPath).sourceLanguage, "und");
    assert.equal(detected.reused, false);
    assert.notEqual(detected.projectDirectory, legacy.projectDirectory);
    assert.equal(SourceLedger.open(detected.manifestPath).sourceLanguage, "ko");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop source service does not reuse a legacy plain-text manifest without an encoding decision", async () => {
  const directory = fixtureDirectory();
  const projectsRoot = join(directory, "Projects");
  const firstPath = join(directory, "legacy-encoding.txt");
  const renamedPath = join(directory, "fresh-encoding.txt");
  const source = "The book is in the house, and the garden is on the hill. We return to the house with a book and a map.";
  writeFileSync(firstPath, source, "utf8");
  writeFileSync(renamedPath, source, "utf8");
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const legacy = ready(await service.importSource({ sourcePath: firstPath, sourceLanguage: "auto" }));
    const manifest = JSON.parse(readFileSync(legacy.manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.encodingDecision;
    writeFileSync(legacy.manifestPath, JSON.stringify(manifest), "utf8");

    assert.equal(SourceLedger.open(legacy.manifestPath).sourceEncodingCompatibilityMode, true);
    const refreshed = ready(await service.importSource({ sourcePath: renamedPath, sourceLanguage: "auto" }));

    assert.equal(refreshed.reused, false);
    assert.notEqual(refreshed.projectDirectory, legacy.projectDirectory);
    assert.equal(SourceLedger.open(refreshed.manifestPath).sourceEncodingCompatibilityMode, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop source service re-evaluates automatic encoding before reusing a manually decoded project", async () => {
  const directory = fixtureDirectory();
  const projectsRoot = join(directory, "Projects");
  const firstPath = join(directory, "manual-legacy.txt");
  const renamedPath = join(directory, "automatic-legacy.txt");
  const source = Buffer.concat(Array.from({ length: 3 }, () =>
    Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee])));
  writeFileSync(firstPath, source);
  writeFileSync(renamedPath, source);
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const manual = ready(await service.importSource({
      sourcePath: firstPath,
      sourceLanguage: "auto",
      explicitEncoding: "euc-kr",
    }));

    const pending = await service.importSource({ sourcePath: renamedPath, sourceLanguage: "auto" });
    assert.equal(pending.status, "encoding_required");
    if (pending.status !== "encoding_required") return;
    assert.doesNotMatch(JSON.stringify(pending), /[A-Z]:\\/u);

    const confirmed = await service.confirmEncoding({
      pendingImportId: pending.pendingImportId,
      encoding: "euc-kr",
    });
    assert.equal(confirmed.reused, true);
    assert.equal(confirmed.projectDirectory, manual.projectDirectory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop source service keeps same-title manuscripts with different bytes as independent projects", async () => {
  const directory = fixtureDirectory();
  const projectsRoot = join(directory, "Projects");
  const firstDirectory = join(directory, "one");
  const secondDirectory = join(directory, "two");
  const firstPath = join(firstDirectory, "Same Title.txt");
  const secondPath = join(secondDirectory, "Same Title.txt");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  writeFileSync(firstPath, "First manuscript.", "utf8");
  writeFileSync(secondPath, "Second manuscript.", "utf8");
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const first = ready(await service.importSource({ sourcePath: firstPath, sourceLanguage: "en" }));
    const second = ready(await service.importSource({ sourcePath: secondPath, sourceLanguage: "en" }));

    assert.equal(first.reused, false);
    assert.equal(second.reused, false);
    assert.notEqual(first.projectDirectory, second.projectDirectory);
    assert.match(basename(first.projectDirectory), /^Same-Title-[a-f0-9]{12}$/u);
    assert.match(basename(second.projectDirectory), /^Same-Title-[a-f0-9]{12}$/u);
    assert.equal(dirname(first.manifestPath), first.projectDirectory);
    assert.equal(dirname(second.manifestPath), second.projectDirectory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous source import exposes only an opaque pending id and allowed encodings", async () => {
  const directory = fixtureDirectory();
  const projectsRoot = join(directory, "Projects");
  const sourcePath = join(directory, "ambiguous-korean.txt");
  const source = Buffer.concat(Array.from({ length: 3 }, () =>
    Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee])));
  writeFileSync(sourcePath, source);
  try {
    const service = new DesktopSourceService({ projectsRoot });
    const pending = await service.importSource({ sourcePath, sourceLanguage: "ko" });
    assert.equal(pending.status, "encoding_required");
    if (pending.status !== "encoding_required") return;
    assert.match(pending.pendingImportId, /^[a-f0-9-]{16,}$/u);
    assert.equal(pending.fileName, "ambiguous-korean.txt");
    assert.deepEqual([...pending.encodings].sort(), ["euc-kr", "windows-949"].sort());
    assert.doesNotMatch(JSON.stringify(pending), /[A-Z]:\\|SOURCE_ENCODING|韓国語|한국어/u);

    const imported = await service.confirmEncoding({
      pendingImportId: pending.pendingImportId,
      encoding: "euc-kr",
    });
    assert.equal(imported.status, "ready");
    if (imported.status !== "ready") return;
    assert.equal(SourceLedger.open(imported.manifestPath).sourceText, "한국어".repeat(3));
    await assert.rejects(
      service.confirmEncoding({ pendingImportId: pending.pendingImportId, encoding: "euc-kr" }),
      /expired|used|invalid/iu,
    );
    await assert.rejects(
      service.confirmEncoding({ pendingImportId: "forged", encoding: "utf-7" }),
      /expired|used|invalid/iu,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readFileEquals(path: string, expected: Buffer): boolean {
  return readFileSync(path).equals(expected);
}
