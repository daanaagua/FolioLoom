import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import { runBook } from "../src/fullbook/book-runner.js";
import { planBookWindows } from "../src/fullbook/window-planner.js";
import { buildLosslessBlocks } from "../src/source/block-builder.js";
import { SourceLedger } from "../src/source/source-ledger.js";
import { annotateStructure } from "../src/source/structure-annotator.js";
import { BookStore } from "../src/storage/book-store.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { scalarLength } from "../src/source/types.js";

function losslessFixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "v5-lossless-runner-"));
  const rawPath = join(directory, "original.txt");
  const canonicalPath = join(directory, "source.txt");
  const manifestPath = join(directory, "source_manifest.json");
  const raw = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  writeFileSync(rawPath, raw);
  writeFileSync(canonicalPath, raw);
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: "v5-source-ledger-1",
    coordinate_unit: "unicode_scalar",
    raw_path: "original.txt",
    raw_size: raw.length,
    raw_sha256: hash,
    source_format: ".txt",
    encoding: "utf-8",
    extractor: "plain-text-v1",
    sourceLanguage: "en",
    canonical_path: "source.txt",
    canonical_chars: scalarLength(source),
    canonical_sha256: hash,
    canonical_segments: [{
      canonical_start: 0,
      canonical_end: scalarLength(source),
      origin_kind: "decoded_bytes",
      origin_ref: "original.txt",
      raw_start: 0,
      raw_end: raw.length,
      transformation: "decode+newline-normalize",
    }],
    excluded_raw_ranges: [],
  }), "utf8");
  const ledger = SourceLedger.open(manifestPath);
  const blocks = buildLosslessBlocks(
    ledger,
    annotateStructure(ledger, ledger.sourceVersion),
    { sourceVersion: ledger.sourceVersion },
  );
  const windows = planBookWindows(blocks, {
    maxBlocks: 1,
    maxSourceTokens: 100,
    protocolVersion: "lossless-v5-1",
  });
  const faux = fauxProvider();
  return {
    canonicalPath,
    faux,
    submission: {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blockIds.map((blockId) => ({
          blockId,
          text: "这是完整的中文译文。",
        })),
        notes: [],
      })),
    },
    options: {
      manifestPath,
      storePath: join(directory, "book-v2.db"),
      runMeta: { runId: "run-lossless", protocolVersion: "lossless-v5-1" },
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
      tinyWindowTokens: 32,
      maxRequestTokens: 100,
      maxWindowsPerRequest: 4,
      maxConcurrency: 2,
      hardDeadlineMs: 30_000,
    },
  };
}

function createFixture(path: string, blockCount: number): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY, legacy_id TEXT, chapter_id TEXT, chapter_title TEXT,
      block_index INTEGER, global_index INTEGER, source_text TEXT,
      source_hash TEXT, token_count INTEGER
    );
    CREATE TABLE concepts (
      id TEXT PRIMARY KEY, canonical_source TEXT, default_target TEXT,
      working_target TEXT, verified_target TEXT, status TEXT, locked INTEGER,
      retired_version INTEGER
    );
    CREATE TABLE lexemes (
      id TEXT PRIMARY KEY, canonical_form TEXT, default_target TEXT,
      working_target TEXT, verified_target TEXT, status TEXT, locked INTEGER,
      retired_version INTEGER
    );
    CREATE TABLE concept_lexemes (
      concept_id TEXT, lexeme_id TEXT, status TEXT, retired_version INTEGER
    );
    CREATE TABLE source_forms (lexeme_id TEXT, form TEXT);
  `);
  const insert = database.prepare(`
    INSERT INTO blocks VALUES(?, ?, 'ch1', 'One', ?, ?, ?, ?, 12)
  `);
  for (let index = 0; index < blockCount; index += 1) {
    insert.run(
      `block-${index}`,
      `legacy-${index}`,
      index,
      index,
      `The person moved slowly through room ${index}.`,
      `hash-${index}`,
    );
  }
  database.close();
}

function userText(context: Context): string {
  const message = context.messages.findLast((item) => item.role === "user");
  assert.ok(message && message.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
}

function dynamicResponse(context: Context) {
  const prompt = userText(context);
  if (prompt.includes("Submit zero to four additional questions")) {
    return fauxAssistantMessage(
      fauxToolCall("submit_questions", { questions: [] }),
      { stopReason: "toolUse" },
    );
  }
  const ids = [...prompt.matchAll(/\[(block-\d+)\]/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(ids.length > 0, prompt.slice(0, 300));
  return fauxAssistantMessage(fauxToolCall("finalize_translation", {
    translations: ids.map((blockId) => ({
      blockId,
      text: "这是对应文本块的完整中文译文，保留了原文全部信息。",
    })),
    notes: [],
  }), { stopReason: "toolUse" });
}

function losslessBatchResponse(context: Context) {
  const prompt = userText(context);
  const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  const windows = JSON.parse(match[1]) as Array<{
    windowId: string;
    blocks: Array<{ blockId: string; sourceText: string }>;
  }>;
  const termMatch = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(prompt);
  const terms = JSON.parse(termMatch?.[1] ?? "[]") as Array<{
    sourceForm: string;
    target: string;
  }>;
  return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
    windows: windows.map((window) => ({
      windowId: window.windowId,
      translations: window.blocks.map((block) => ({
        blockId: block.blockId,
        text: `${terms.filter((term) => block.sourceText.toLocaleLowerCase()
          .includes(term.sourceForm.toLocaleLowerCase()))
          .map((term) => term.target).join("、")}${"完整译文".repeat(
            Math.max(1, Math.ceil([...block.sourceText].length / 12)),
          )}。`,
      })),
      notes: [],
    })),
  }), { stopReason: "toolUse" });
}

function lexicalAnchorResponse(
  context: Context,
  entityLink?: {
    sourceForms: string[];
    proposedTarget: string;
    evidenceQuote: string;
  },
) {
  const prompt = userText(context);
  const match = /SOURCE-LANGUAGE FORMS AND COMPACT CONCORDANCE\n\n(\[[\s\S]*?\])\n\nESTABLISHED TERMS/u.exec(prompt);
  assert.ok(match?.[1], prompt.slice(0, 500));
  const candidates = JSON.parse(match[1]) as Array<{ sourceForm: string }>;
  return fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: candidates.map((candidate) => ({
      sourceForm: candidate.sourceForm,
      target: entityLink?.sourceForms.includes(candidate.sourceForm)
        ? entityLink.proposedTarget
        : `译-${candidate.sourceForm}`,
      mode: "stable",
      confidence: 0.95,
    })),
    entityLinks: entityLink === undefined ? [] : [{
      ...entityLink,
      evidenceKind: "explicit_naming",
      confidence: 0.98,
    }],
  }), { stopReason: "toolUse" });
}

test("wave anchor runs once and every physical request receives the same confirmed alias target", async () => {
  const fixture = losslessFixture(
    "Loukianos, whom they called Lucian the Scoffer, laughed.\n\nBOOK ONE",
  );
  const translationPrompts: string[] = [];
  fixture.faux.setResponses([
    (context) => lexicalAnchorResponse(context, {
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget: "卢基阿诺斯",
      evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
    }),
    (context) => {
      translationPrompts.push(userText(context));
      return losslessBatchResponse(context);
    },
    (context) => {
      translationPrompts.push(userText(context));
      return losslessBatchResponse(context);
    },
  ]);

  const result = await runBook({
    ...fixture.options,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
  } as never);

  assert.equal(fixture.faux.state.callCount, 3);
  assert.equal(result.status.modelCalls, 3);
  assert.equal(translationPrompts.length, 2);
  const projectedTerms = translationPrompts.map((prompt) => {
    const match = /STABLE TERMS\n\n(\[[\s\S]*?\])\n\nUNRESOLVED ENTITY LINKS/u.exec(prompt);
    assert.ok(match?.[1]);
    return JSON.parse(match[1]) as Array<{
      sourceForm: string;
      target: string;
      conceptId: string;
    }>;
  });
  assert.deepEqual(projectedTerms[0], projectedTerms[1]);
  const aliases = projectedTerms[0]!.filter((term) =>
    term.sourceForm === "Loukianos" || term.sourceForm === "Lucian");
  assert.equal(aliases.length, 2);
  assert.equal(new Set(aliases.map((term) => term.target)).size, 1);
  assert.equal(new Set(aliases.map((term) => term.conceptId)).size, 1);

  const store = new LosslessBookStore(fixture.options.storePath);
  const revisions = store.knowledgeRevisions("run-lossless");
  store.close();
  assert.equal(revisions.filter((revision) => revision.kind === "entity_alias_link").length, 1);
});

test("failed wave promotes no anchor knowledge and resume reuses its cached anchor decision", async () => {
  const fixture = losslessFixture(
    "Loukianos, whom they called Lucian the Scoffer, laughed.",
  );
  fixture.faux.setResponses([
    (context) => lexicalAnchorResponse(context, {
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget: "卢基阿诺斯",
      evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
    }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "503: fixture provider unavailable",
    }),
  ]);

  await assert.rejects(runBook(fixture.options as never), /provider unavailable/i);
  const failedStore = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(failedStore.knowledgeRevisions("run-lossless"), []);
  failedStore.close();

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([losslessBatchResponse]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);

  assert.equal(resumedProvider.state.callCount, 1);
  assert.equal(resumed.status.completedWindows, 1);
  const recoveredStore = new LosslessBookStore(fixture.options.storePath);
  assert.equal(
    recoveredStore.knowledgeRevisions("run-lossless")
      .filter((revision) => revision.kind === "entity_alias_link").length,
    1,
  );
  recoveredStore.close();
});

test("two tiny logical windows use one physical model session and commit independently", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    fixture.submission,
  ), { stopReason: "toolUse" })]);

  const result = await runBook(fixture.options as never);

  assert.equal(fixture.faux.state.callCount, 1);
  assert.equal(result.status.completedWindows, 2);
  assert.equal(result.status.modelCalls, 1);
  const store = new LosslessBookStore(fixture.options.storePath);
  try {
    assert.deepEqual(store.listTranslationRuns()[0]?.metadata, {
      sourceLanguageProfile: {
        id: "en",
        version: "source-language-profile-1",
        compatibilityMode: false,
      },
      sourceAnomalies: {
        schema: "v5-source-anomaly-1",
        counts: {
          CONTROL_CHARACTER: 0,
          EXTREME_LONG_LINE: 0,
          REPEATED_FRONTMATTER_LINE: 0,
          REPLACEMENT_CHARACTER: 0,
          SPACED_HYPHENATION: 0,
        },
        findings: [],
      },
    });
  } finally {
    store.close();
  }
});

test("failed lossless doctor blocks every model call", async () => {
  const fixture = losslessFixture("Alpha.");
  writeFileSync(fixture.canonicalPath, "Corrupt.", "utf8");

  await assert.rejects(runBook(fixture.options as never), /HASH_MISMATCH/);
  assert.equal(fixture.faux.state.callCount, 0);
});

test("one malformed window in a batch cannot erase its valid earlier sibling", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const malformed = structuredClone(fixture.submission);
  malformed.windows[1]!.translations[0]!.text = "";
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    malformed,
  ), { stopReason: "toolUse" })]);

  const result = await runBook({ ...fixture.options, maxAttempts: 1 } as never);

  assert.equal(fixture.faux.state.callCount, 1);
  assert.equal(result.status.completedWindows, 1);
  assert.equal(result.status.humanRequiredWindows, 1);
  assert.deepEqual(result.windows.map((window) => window.status), [
    "completed",
    "human_required",
  ]);
  const store = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(store.styleObservations("run-lossless").map((item) => item.ordinal), [0]);
  store.close();
});

test("lossless provider errors stay retryable and never become human incidents", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage([], {
    stopReason: "error",
    errorMessage: "503: fixture provider unavailable",
  })]);

  await assert.rejects(runBook(fixture.options as never), /provider unavailable/i);
  const store = new LosslessBookStore(fixture.options.storePath);
  const status = store.statusSummary("run-lossless");
  store.close();
  assert.equal(status.humanRequiredWindows, 0);
  assert.equal(status.pendingWindows, 2);
});

test("lossless runner resumes the same isolated run and promotes the remaining ordinal", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [fixture.submission.windows[0]] },
  ), { stopReason: "toolUse" })]);
  const first = await runBook({ ...fixture.options, maxWindows: 1 } as never);
  assert.equal(first.status.completedWindows, 1);
  assert.equal(first.status.pendingWindows, 1);

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [fixture.submission.windows[1]] },
  ), { stopReason: "toolUse" })]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);
  assert.equal(resumedProvider.state.callCount, 1);
  assert.equal(resumed.processedWindows, 1);
  assert.equal(resumed.status.completedWindows, 2);
  assert.deepEqual(resumed.windows.map((window) => window.status), ["completed", "completed"]);
});

test("lossless resume uses bounded structured style evidence instead of a raw prior tail", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const longTranslation = "克制样例。";
  const firstWindow = structuredClone(fixture.submission.windows[0]!);
  firstWindow.translations[0]!.text = longTranslation;
  (firstWindow as typeof firstWindow & { styleObservation: unknown }).styleObservation = {
    voiceId: "narrator",
    activeRegister: "冷静克制",
    rhythm: "长句舒展，短句收束",
    continuityNotes: ["不要解释叙述者的保留"],
  };
  fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(
    "finalize_translation_batch",
    { windows: [firstWindow] },
  ), { stopReason: "toolUse" })]);
  const first = await runBook({ ...fixture.options, maxWindows: 1 } as never);
  assert.equal(first.status.completedWindows, 1);

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([(context) => {
    const prompt = userText(context);
    assert.match(prompt, /EFFECTIVE STYLE BY WINDOW/);
    assert.match(prompt, /全书文体宪章/);
    assert.match(prompt, /冷静克制/);
    assert.doesNotMatch(prompt, /PREVIOUS ACTIVE TAIL/);
    return losslessBatchResponse(context);
  }]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
  } as never);

  assert.equal(resumed.status.completedWindows, 2);
  const store = new LosslessBookStore(fixture.options.storePath);
  const observations = store.styleObservations("run-lossless");
  store.close();
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map((item) => item.ordinal), [0, 1]);
});

test("lossless runner hydrates full knowledge history when resuming from a revision-two projection", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE\n\nCHAPTER ONE");
  assert.equal(fixture.submission.windows.length, 3);
  const responseWithMemory = (target: string) => (context: Context) => {
    const prompt = userText(context);
    const match = /WINDOWS\n\n(\[[\s\S]*?\])\n\nSTABLE TERMS/u.exec(prompt);
    assert.ok(match?.[1]);
    const windows = JSON.parse(match[1]) as Array<{
      windowId: string;
      blocks: Array<{ blockId: string }>;
    }>;
    return fauxAssistantMessage(fauxToolCall("finalize_translation_batch", {
      windows: windows.map((window) => ({
        windowId: window.windowId,
        translations: window.blocks.map((block) => ({
          blockId: block.blockId,
          text: `译文-${target}`,
        })),
        notes: [],
        memoryCandidates: [{
          kind: "term",
          subjectForms: ["Alpha"],
          fact: target,
          confidence: 0.9,
        }],
      })),
    }), { stopReason: "toolUse" });
  };
  fixture.faux.setResponses([
    responseWithMemory("甲"),
    responseWithMemory("乙"),
  ]);
  const first = await runBook({
    ...fixture.options,
    maxWindows: 2,
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    tinyWindowTokens: 1,
  } as never);
  assert.equal(first.status.completedWindows, 2);
  const afterTwo = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(afterTwo.knowledgeRevisions("run-lossless").map((revision) => revision.revision), [1, 2]);
  assert.equal(afterTwo.latestKnowledgeSnapshot("run-lossless").revisions[0]?.revision, 2);
  afterTwo.close();

  const resumedProvider = fauxProvider();
  resumedProvider.setResponses([(context) => {
    const prompt = userText(context);
    const projectionMatch = /KNOWLEDGE SNAPSHOT REVISIONS\n\n(\[[\s\S]*?\])\n\nWINDOWS/u.exec(prompt);
    assert.ok(projectionMatch?.[1]);
    const projection = JSON.parse(projectionMatch[1]) as Array<{ revision: number; status: string }>;
    assert.deepEqual(projection.map((revision) => [revision.revision, revision.status]), [
      [2, "needs_revalidate"],
    ]);
    return responseWithMemory("乙")(context);
  }]);
  const resumed = await runBook({
    ...fixture.options,
    model: resumedProvider.getModel(),
    streamFn: resumedProvider.provider.streamSimple.bind(resumedProvider.provider),
    maxConcurrency: 1,
    maxWindowsPerRequest: 1,
    tinyWindowTokens: 1,
  } as never);
  assert.equal(resumed.status.completedWindows, 3);
  const recovered = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(
    recovered.knowledgeRevisions("run-lossless").map((revision) => revision.revision),
    [1, 2, 3],
  );
  recovered.close();
});

test("reverse physical completion still promotes lossless windows in ordinal order", async () => {
  const fixture = losslessFixture("EDGEWOOD\n\nBOOK ONE");
  const completionOrder: number[] = [];
  fixture.faux.setResponses([
    async (context) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      completionOrder.push(0);
      return losslessBatchResponse(context);
    },
    async (context) => {
      completionOrder.push(1);
      return losslessBatchResponse(context);
    },
  ]);
  const result = await runBook({
    ...fixture.options,
    tinyWindowTokens: 1,
    maxWindowsPerRequest: 1,
    maxConcurrency: 2,
  } as never);

  assert.deepEqual(completionOrder, [1, 0]);
  assert.equal(result.status.completedWindows, 2);
  const database = new DatabaseSync(fixture.options.storePath);
  const promoted = (database.prepare(`
    SELECT payload_json FROM events WHERE kind='window_promoted' ORDER BY sequence
  `).all() as unknown as Array<{ payload_json: string }>).map((row) =>
    (JSON.parse(row.payload_json) as { windowId: string }).windowId);
  database.close();
  assert.deepEqual(promoted, result.windows.map((window) => window.windowId));
  const styleStore = new LosslessBookStore(fixture.options.storePath);
  assert.deepEqual(styleStore.styleObservations("run-lossless").map((item) => item.ordinal), [0, 1]);
  styleStore.close();
});

test("book runner warms up, runs a parallel wave, and resumes without model calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-runner-"));
  const sourceDb = join(directory, "source.db");
  const storePath = join(directory, "state.db");
  createFixture(sourceDb, 4);
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 4 }, () => dynamicResponse));
  const first = await runBook({
    dbPath: sourceDb,
    storePath,
    outputDir: join(directory, "output"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
    warmupWindows: 2,
    maxConcurrency: 2,
    maxAttempts: 2,
    hardDeadlineMs: 30_000,
  });
  assert.deepEqual(first.waves.map((wave) => wave.concurrency), [1, 1, 2]);
  assert.equal(first.status.completedWindows, 4);
  assert.equal(first.status.modelCalls, 4);

  const noCalls = fauxProvider();
  noCalls.setResponses([]);
  const resumed = await runBook({
    dbPath: sourceDb,
    storePath,
    outputDir: join(directory, "output"),
    model: noCalls.getModel(),
    streamFn: noCalls.provider.streamSimple.bind(noCalls.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
    warmupWindows: 2,
    maxConcurrency: 2,
    maxAttempts: 2,
    hardDeadlineMs: 30_000,
  });
  assert.equal(resumed.processedWindows, 0);
  assert.equal(resumed.status.modelCalls, 4);
});

test("book runner retries a no-submit window with a fresh per-window budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-retry-"));
  const sourceDb = join(directory, "source.db");
  const storePath = join(directory, "state.db");
  createFixture(sourceDb, 1);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("No translation was submitted."),
    dynamicResponse,
  ]);
  const result = await runBook({
    dbPath: sourceDb,
    storePath,
    outputDir: join(directory, "output"),
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
    warmupWindows: 0,
    maxConcurrency: 1,
    maxAttempts: 2,
    hardDeadlineMs: 30_000,
  });
  const store = new BookStore(storePath);
  const window = store.window(store.pendingWindows()[0]?.windowId ?? "")
    ?? result.windows[0];
  assert.equal(result.status.completedWindows, 1);
  assert.equal(window?.attemptCount, 2);
  assert.equal(result.status.modelCalls, 2);
  store.close();
});

test("book runner aborts external provider failures without creating a human task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-book-provider-failure-"));
  const sourceDb = join(directory, "source.db");
  const storePath = join(directory, "state.db");
  createFixture(sourceDb, 1);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "401: authentication failed for fixture credential",
    }),
  ]);

  await assert.rejects(
    runBook({
      dbPath: sourceDb,
      storePath,
      outputDir: join(directory, "output"),
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      windowOptions: { maxBlocks: 1, maxSourceTokens: 100 },
      maxAttempts: 2,
      hardDeadlineMs: 30_000,
    }),
    /authentication failed/i,
  );
  const store = new BookStore(storePath);
  assert.equal(store.statusSummary().humanRequiredWindows, 0);
  assert.equal(store.statusSummary().pendingWindows, 1);
  store.close();
});
