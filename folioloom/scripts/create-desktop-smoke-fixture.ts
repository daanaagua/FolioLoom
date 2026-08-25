import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BookContext } from "../src/fullbook/book-context.js";
import { createKnowledgeSnapshot } from "../src/knowledge/snapshot.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";

const sourceText = "Chapter I\n\nThe Archon greeted Piaton.\n";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const root = await mkdtemp(join(tmpdir(), "folioloom-desktop-smoke-"));
const projectDirectory = join(root, "project");
const userDataDirectory = join(root, "user-data");
const rawPath = join(projectDirectory, "original.txt");
const canonicalPath = join(projectDirectory, "source.txt");
const manifestPath = join(projectDirectory, "source_manifest.json");
const storePath = join(projectDirectory, "book.db");
mkdirSync(projectDirectory, { recursive: true });
mkdirSync(userDataDirectory, { recursive: true });

const source = Buffer.from(sourceText, "utf8");
writeFileSync(rawPath, source);
writeFileSync(canonicalPath, source);
writeFileSync(manifestPath, JSON.stringify({
  schema_version: "v5-source-ledger-1",
  coordinate_unit: "unicode_scalar",
  raw_path: "original.txt",
  raw_size: source.length,
  raw_sha256: sha256(source),
  source_format: ".txt",
  encoding: "utf-8",
  extractor: "plain-text-v1",
  sourceLanguage: "en",
  canonical_path: "source.txt",
  canonical_chars: [...sourceText].length,
  canonical_sha256: sha256(source),
  canonical_segments: [{
    canonical_start: 0,
    canonical_end: [...sourceText].length,
    origin_kind: "decoded_bytes",
    origin_ref: "original.txt",
    transformation: "decode+newline-normalize",
    raw_start: 0,
    raw_end: source.length,
  }],
  excluded_raw_ranges: [],
}), "utf8");

const context = BookContext.openLossless({ manifestPath });
const certifiedSource = context.certifiedSource!;
const blocks = context.losslessBlocks;
const annotations = context.annotations;
context.close();

const runId = "desktop-smoke-run";
const store = new LosslessBookStore(storePath);
store.registerSource(certifiedSource);
store.replaceDerivedPlan(certifiedSource.sourceVersion, { blocks, annotations });
const snapshot = createKnowledgeSnapshot(runId, []);
store.createTranslationRun({
  runId,
  sourceVersion: certifiedSource.sourceVersion,
  protocolVersion: "desktop-smoke",
  modelId: "fixture-model",
  initialSnapshotId: snapshot.id,
  initialSnapshot: snapshot,
});
const state = store.knowledgeState(runId);
store.commitKnowledgeCommands({
  requestId: randomUUID(),
  runId,
  expectedGeneration: state.generation,
  expectedSnapshotId: state.snapshotId,
  commands: [{
    type: "upsert",
    objectType: "term",
    normalizedSubject: "archon",
    kind: "lexical_anchor",
    expectedRevision: null,
    expectedScopeRevision: null,
    fieldPatch: {
      sourceForm: "Archon",
      canonicalSource: "archon",
      target: "执政官",
      locked: true,
      policy: "locked",
      note: "GUI smoke fixture",
    },
    ownedFields: ["/target", "/locked", "/policy", "/note"],
    scope: "book",
    evidence: [],
    origin: "manual",
  }],
});
store.close();

writeFileSync(join(userDataDirectory, "desktop-preferences.json"), JSON.stringify({
  schema: "folioloom-desktop-preferences-2",
  recent: {
    manifestPath,
    storePath,
    runId,
  },
}), "utf8");

process.stdout.write(`${JSON.stringify({
  root,
  projectDirectory,
  userDataDirectory,
  manifestPath,
  storePath,
  runId,
}, null, 2)}\n`);
