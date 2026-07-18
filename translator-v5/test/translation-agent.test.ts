import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { PiRuntime } from "../src/agents/pi-runtime.js";
import {
  normalizeCandidateTypography,
  splitIntoChapterIslands,
  trimExactBoundaryOverlaps,
  Translator,
} from "../src/agents/translator.js";
import type { ProvisionalSnapshot } from "../src/domain/provisional-snapshot.js";
import type { V4Block } from "../src/domain/types.js";
import { EvidenceIndex } from "../src/index/evidence-index.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { CandidateCollector } from "../src/tools/candidate-collector.js";
import { TranslationTools } from "../src/tools/translation-tools.js";
import { TranslationValidator } from "../src/validators/translation-validator.js";

function chapterBlock(index: number, text: string): V4Block {
  return {
    id: `v06_ch08_00${index}`,
    legacyId: null,
    chapterId: "v06_ch08",
    chapterTitle: "The Face of the Autarch",
    globalIndex: 220 + index,
    blockIndex: index,
    sourceText: text,
    sourceHash: `hash-${index}`,
    tokenCount: Math.ceil(text.length / 4),
  };
}

function snapshot(): ProvisionalSnapshot {
  return {
    schemaVersion: "v5-provisional-1",
    protocolHash: "protocol",
    modelHash: "model",
    targetScope: {
      blockIds: ["v06_ch08_000", "v06_ch08_001"],
      globalIndexes: [220, 221],
    },
    coverage: { completePrefix: false, indexedGlobalIndexes: [200, 220, 221] },
    questions: [{
      questionId: "q-typhon-piaton",
      kind: "entity_relation",
      prompt: "How are Typhon and Piaton related?",
      subjectIds: ["typhon", "piaton"],
      channel: "translator_global",
      impact: "high",
    }],
    narrativeFacts: [],
    translatorFacts: [{
      questionId: "q-typhon-piaton",
      kind: "entity_relation",
      verdict: "shared body with distinct control",
      confidence: 0.9,
      evidenceIds: ["ev-1"],
      channel: "translator_global",
    }],
    unresolved: [],
    evidence: [{
      evidenceId: "ev-1",
      blockId: "block-200",
      globalIndex: 200,
      paragraphIndex: 0,
      sourceHash: "hash-evidence",
      channel: "translator_global",
    }],
    evidenceIds: ["ev-1"],
    sourceHashes: {},
  };
}

test("translation agent receives minimal context and may retrieve evidence", async () => {
  const blocks = [
    chapterBlock(0, "Typhon raised his head and looked at Severian."),
    chapterBlock(1, "Piaton's voice came from the same body."),
  ];
  const island = splitIntoChapterIslands(blocks)[0];
  assert.ok(island);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("retrieve_resolved_evidence", {
        questionIds: ["q-typhon-piaton"],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("finalize_translation", {
        translations: [
          { blockId: "v06_ch08_000", text: "提丰抬起头，望向塞万里安。" },
          { blockId: "v06_ch08_001", text: "皮亚顿的声音从同一具身体里传来。" },
        ],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  const outcome = await new Translator(new PiRuntime()).translateIsland({
    island,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    collector: new CandidateCollector(),
    stableTerms: [],
    snapshot: snapshot(),
    styleState: { register: "literary", dialogueQuotes: "curly" },
    previousActiveTail: "",
  });

  assert.deepEqual(outcome.usedResolutionIds, ["q-typhon-piaton"]);
  assert.equal(outcome.initialPrompt.includes("all narrative memories"), false);
  assert.equal(outcome.validation.valid, true);
  assert.equal(outcome.humanRequired, false);
});

test("on-demand evidence lookup is literal-form bounded and position safe", async () => {
  const target = chapterBlock(0, "Rakesh changed her version of the scape.");
  const future = chapterBlock(1, "The scape was a shared virtual sensory scene.");
  const evidenceIndex = EvidenceIndex.fromBlocks([target, future]);
  try {
    const createTools = () => new TranslationTools({
      budget: new BudgetLedger(),
      targetBlocks: [target],
      collector: new CandidateCollector(),
      stableTerms: [],
      resolvedEvidence: [],
      styleState: { register: "literary" },
      evidenceIndex,
    });
    const global = await createTools().requestTranslationEvidence({
      question: "What concrete interface does scape denote here?",
      sourceForms: ["scape"],
      channel: "translator_global",
    });
    assert.ok(global.evidence.some((hit) => hit.globalIndex === future.globalIndex));

    const narrative = await createTools().requestTranslationEvidence({
      question: "What can the narrator know at this point?",
      sourceForms: ["scape"],
      channel: "narrative_before_target",
    });
    assert.ok(narrative.evidence.every((hit) => hit.globalIndex <= target.globalIndex));

    await assert.rejects(
      createTools().requestTranslationEvidence({
        question: "Look up an unrelated person.",
        sourceForms: ["Typhon"],
        channel: "translator_global",
      }),
      /not present in the target island/i,
    );
  } finally {
    evidenceIndex.close();
  }
});

test("translator may request targeted evidence and continue in the same session", async () => {
  const target = chapterBlock(0, "Rakesh changed her version of the scape.");
  const future = chapterBlock(1, "The scape was a shared virtual sensory scene.");
  const island = splitIntoChapterIslands([target])[0];
  assert.ok(island);
  const evidenceIndex = EvidenceIndex.fromBlocks([target, future]);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_translation_evidence", {
        question: "What concrete interface does scape denote here?",
        sourceForms: ["scape"],
        channel: "translator_global",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("finalize_translation", {
        translations: [{ blockId: target.id, text: "拉凯什改变了她那一版拟景。" }],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  try {
    const outcome = await new Translator(new PiRuntime()).translateIsland({
      island,
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      budget: new BudgetLedger(),
      collector: new CandidateCollector(),
      stableTerms: [],
      snapshot: { ...snapshot(), questions: [], translatorFacts: [], evidence: [] },
      styleState: { register: "literary" },
      previousActiveTail: "",
      evidenceIndex,
    });

    assert.deepEqual(outcome.run.toolNames, [
      "request_translation_evidence",
      "finalize_translation",
    ]);
    assert.equal(outcome.validation.valid, true);
  } finally {
    evidenceIndex.close();
  }
});

test("final submission can attach bounded source-grounded narrative memory", async () => {
  const target = chapterBlock(0, "Rakesh changed her version of the scape.");
  const evidenceIndex = EvidenceIndex.fromBlocks([target]);
  try {
    const tools = new TranslationTools({
      budget: new BudgetLedger(),
      targetBlocks: [target],
      collector: new CandidateCollector(),
      stableTerms: [{
        conceptId: "person-rakesh",
        lexemeId: "lex-rakesh",
        sourceForm: "Rakesh",
        canonicalSource: "Rakesh",
        target: "拉凯什",
        locked: true,
      }],
      resolvedEvidence: [],
      styleState: { register: "literary" },
      evidenceIndex,
    });

    await tools.finalizeTranslation({
      translations: [{ blockId: target.id, text: "拉凯什改变了她那一版拟景。" }],
      notes: [],
      memoryCandidates: [{
        kind: "local_continuity",
        subjectForms: ["Rakesh"],
        fact: "Rakesh can alter her own version of the scape.",
        confidence: 0.95,
      }],
    });

    const memories = tools.durableMemories();
    assert.equal(memories.length, 1);
    assert.deepEqual(memories[0]?.subjectIds, ["person-rakesh"]);
    assert.equal(memories[0]?.visibleFromGlobalIndex, target.globalIndex + 1);
    assert.equal(memories[0]?.evidenceIds.length, 1);
  } finally {
    evidenceIndex.close();
  }
});

test("low-confidence research claims are withheld from translation", async () => {
  const block = chapterBlock(0, "Typhon raised his head.");
  const island = splitIntoChapterIslands([block])[0];
  assert.ok(island);
  const lowConfidence = snapshot();
  lowConfidence.translatorFacts[0]!.confidence = 0.8;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("retrieve_resolved_evidence", {
        questionIds: ["q-typhon-piaton"],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("finalize_translation", {
        translations: [{ blockId: block.id, text: "提丰抬起了头。" }],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  const outcome = await new Translator(new PiRuntime()).translateIsland({
    island,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    collector: new CandidateCollector(),
    stableTerms: [],
    snapshot: lowConfidence,
    styleState: { register: "literary" },
    previousActiveTail: "",
  });

  assert.deepEqual(outcome.usedResolutionIds, []);
  assert.equal(outcome.initialPrompt.includes("shared body with distinct control"), false);
});

test("deterministic validator rejects missing blocks and leaked system JSON", () => {
  const blocks = [
    chapterBlock(0, "Typhon raised his head and looked at Severian."),
    chapterBlock(1, "Piaton's voice came from the same body."),
  ];
  const result = new TranslationValidator().validate(blocks, {
    translations: [{
      blockId: "v06_ch08_000",
      text: '{"systemPrompt":"leaked"}',
    }],
    notes: [],
    repaired: false,
  });

  assert.equal(result.valid, false);
  assert.ok(result.failures.some((failure) => failure.code === "block_set_mismatch"));
  assert.ok(result.failures.some((failure) => failure.code === "system_json_leak"));
});

test("exact paragraph overlap is removed before adjacent blocks are translated", () => {
  const first = chapterBlock(0, "First paragraph.\n\nShared boundary paragraph.");
  const second = chapterBlock(1, "Shared boundary paragraph.\n\nNext paragraph.");
  const trimmed = trimExactBoundaryOverlaps([first, second]);
  assert.equal(trimmed[0]?.sourceText, first.sourceText);
  assert.equal(trimmed[1]?.sourceText, "Next paragraph.");
});

test("typography is normalized and untranslated prose words are rejected", () => {
  const block = chapterBlock(0, "The sailors looked up.");
  const normalized = normalizeCandidateTypography({
    translations: [{ blockId: block.id, text: "「sailors 抬头望去。」" }],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" });
  assert.equal(normalized.translations[0]?.text, "“sailors 抬头望去。”");
  const validation = new TranslationValidator().validate([block], normalized);
  assert.ok(validation.failures.some((failure) =>
    failure.code === "untranslated_latin"),
  );
});

test("validator preserves exact isolated source identifiers without allowing copied prose", () => {
  const block = chapterBlock(0, "eGod\n\nThe sailors looked up.");
  const preserved = new TranslationValidator().validate([block], {
    translations: [{ blockId: block.id, text: "eGod\n\n水手们抬头望去。" }],
    notes: [],
    repaired: false,
  });
  assert.ok(!preserved.failures.some((failure) =>
    failure.code === "untranslated_latin"));

  const copied = new TranslationValidator().validate([block], {
    translations: [{ blockId: block.id, text: "eGod\n\nsailors 抬头望去。" }],
    notes: [],
    repaired: false,
  });
  assert.ok(copied.failures.some((failure) =>
    failure.code === "untranslated_latin" && failure.message.includes("sailors")));
});

test("deterministic validator delegates French residue to its language profile", () => {
  const block = chapterBlock(0, "Il répondit puis partit.");
  const validation = new TranslationValidator().validate([block], {
    translations: [{ blockId: block.id, text: "他回答 bonjour puis 离开。" }],
    notes: [],
    repaired: false,
  }, { sourceLanguageProfile: getSourceLanguageProfile("fr") });
  assert.ok(validation.failures.some((failure) =>
    failure.code === "untranslated_latin"
    && failure.message.includes("bonjour")));
});

test("quote normalization and validation reject invented closing boundaries", () => {
  const block = chapterBlock(0, "“What of Nessus?” he asked.");
  const normalized = normalizeCandidateTypography({
    translations: [{
      blockId: block.id,
      text: "\u201B它可以是你的衣袍。”\n\n\"你好，\"我说。\n\n“尼苏斯呢？”我冷得发抖。”",
    }],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" });

  assert.equal(normalized.translations[0]?.text.startsWith("“"), true);
  assert.equal(normalized.translations[0]?.text.includes("“你好，”我说。"), true);
  assert.equal(normalized.translations[0]?.text.includes('"'), false);
  const validation = new TranslationValidator().validate([block], normalized);
  assert.ok(validation.failures.some((failure) =>
    failure.code === "quote_boundary_mismatch"),
  );
});

test("run-local stable anchors are deterministic validation constraints", () => {
  const block = chapterBlock(0, "Typhon opposed the Conciliator.");
  const validation = new TranslationValidator().validate([block], {
    translations: [{ blockId: block.id, text: "提丰曾是调解人的敌人。" }],
    notes: [],
    repaired: false,
  }, {
    requiredTerms: [{ sourceForm: "Conciliator", target: "和解者" }],
  });

  assert.ok(validation.failures.some((failure) =>
    failure.code === "stable_term_mismatch"),
  );
});

test("one repair pass can replace an invalid island candidate", async () => {
  const blocks = [
    chapterBlock(0, "Typhon raised his head and looked at Severian."),
    chapterBlock(1, "Piaton's voice came from the same body."),
  ];
  const island = splitIntoChapterIslands(blocks)[0];
  assert.ok(island);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("finalize_translation", {
        translations: [
          { blockId: "v06_ch08_000", text: "提丰抬起头。" },
        ],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("submit_repaired_translation", {
        translations: [
          { blockId: "v06_ch08_000", text: "提丰抬起头，望向塞万里安。" },
          { blockId: "v06_ch08_001", text: "皮亚顿的声音从同一具身体里传来。" },
        ],
        notes: ["补回遗漏文本块"],
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  const outcome = await new Translator(new PiRuntime()).translateIsland({
    island,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    collector: new CandidateCollector(),
    stableTerms: [],
    snapshot: snapshot(),
    styleState: { register: "literary" },
    previousActiveTail: "",
  });

  assert.equal(outcome.repaired, true);
  assert.equal(outcome.validation.valid, true);
  assert.equal(outcome.humanRequired, false);
  assert.equal(outcome.candidate?.translations.length, 2);
});

test("a partial repair patch preserves unaffected island blocks", async () => {
  const blocks = [
    chapterBlock(0, "Typhon raised his monstrous head."),
    chapterBlock(1, "Piaton's voice came from the same body."),
  ];
  const island = splitIntoChapterIslands(blocks)[0];
  assert.ok(island);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("finalize_translation", {
        translations: [
          { blockId: "v06_ch08_000", text: "提丰抬起他那颗 monstrous 的头。" },
          { blockId: "v06_ch08_001", text: "皮亚顿的声音从同一具身体里传来。" },
        ],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("submit_repaired_translation", {
        translations: [
          { blockId: "v06_ch08_000", text: "提丰抬起他那颗狰狞的头。" },
        ],
        notes: ["仅修复含未译英文的文本块"],
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  const outcome = await new Translator(new PiRuntime()).translateIsland({
    island,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    collector: new CandidateCollector(),
    stableTerms: [],
    snapshot: snapshot(),
    styleState: { register: "literary" },
    previousActiveTail: "",
  });

  assert.equal(outcome.validation.valid, true);
  assert.equal(outcome.humanRequired, false);
  assert.deepEqual(outcome.candidate?.translations, [
    { blockId: "v06_ch08_000", text: "提丰抬起他那颗狰狞的头。" },
    { blockId: "v06_ch08_001", text: "皮亚顿的声音从同一具身体里传来。" },
  ]);
});

test("repair retries when a first patch introduces another deterministic failure", async () => {
  const block = chapterBlock(0, "Typhon's voice became faint.");
  const island = splitIntoChapterIslands([block])[0];
  assert.ok(island);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("finalize_translation", {
        translations: [{ blockId: block.id, text: "提丰的声音变得 faint。" }],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("submit_repaired_translation", {
        translations: [{ blockId: block.id, text: "提丰的声音依然 faint。" }],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("submit_repaired_translation", {
        translations: [{ blockId: block.id, text: "提丰的声音渐渐微弱。" }],
        notes: [],
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  const outcome = await new Translator(new PiRuntime()).translateIsland({
    island,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    collector: new CandidateCollector(),
    stableTerms: [],
    snapshot: snapshot(),
    styleState: { register: "literary" },
    previousActiveTail: "",
  });

  assert.equal(outcome.validation.valid, true);
  assert.equal(outcome.repairRuns.length, 2);
  assert.equal(outcome.candidate?.translations[0]?.text, "提丰的声音渐渐微弱。");
});
