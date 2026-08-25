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
import { normalizeTranslatedSceneSeparators } from "../src/source/layout-separators.js";
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
  const translationSystemPrompts: string[] = [];
  faux.setResponses([
    (context) => {
      translationSystemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage(
        fauxToolCall("retrieve_resolved_evidence", {
          questionIds: ["q-typhon-piaton"],
        }),
        { stopReason: "toolUse" },
      );
    },
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
  assert.match(
    translationSystemPrompts[0] ?? "",
    /adjacent short display-only lines clearly form one title or heading/u,
  );
});

test("translator validates every locked glossary or legacy term", async () => {
  const target = chapterBlock(0, "The Archon entered the chamber.");
  const island = splitIntoChapterIslands([target])[0];
  assert.ok(island);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("finalize_translation", {
    translations: [{ blockId: target.id, text: "那位统治者走进了房间。" }],
    notes: [],
  }), { stopReason: "toolUse" })]);

  const outcome = await new Translator(new PiRuntime()).translateIsland({
    island,
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger({ repairTurns: 0 }),
    collector: new CandidateCollector(),
    stableTerms: [{
      conceptId: "glossary-archon",
      lexemeId: "glossary-archon-lexeme",
      sourceForm: "Archon",
      canonicalSource: "Archon",
      target: "执政官",
      locked: true,
      policy: "locked",
      origin: "glossary",
    }],
    snapshot: { ...snapshot(), questions: [], translatorFacts: [], evidence: [] },
    styleState: { register: "literary" },
    previousActiveTail: "",
  });

  assert.equal(outcome.validation.valid, false);
  assert.ok(outcome.validation.failures.some((failure) =>
    failure.code === "stable_term_mismatch"));
  assert.equal(outcome.humanRequired, true);
});

test("on-demand evidence lookup is literal-form bounded and position safe", async () => {
  const target = chapterBlock(0, "Rakesh changed her version of the scape.");
  const future = chapterBlock(1, "The scape was a shared[[]]virtual sensory scene.");
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
    assert.ok(global.evidence.every((hit) => !hit.quote.includes("[[]]")));
    assert.ok(global.evidence.some((hit) => hit.quote.includes("shared\n\nvirtual")));

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
  const block = chapterBlock(0, "The sailors looked up.[[]]Next scene.");
  const normalized = normalizeCandidateTypography({
    translations: [{ blockId: block.id, text: "「sailors 抬头望去。」[[]]下一场。" }],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" }, [], new Map([
    [block.id, block.sourceText],
  ]));
  assert.equal(normalized.translations[0]?.text, "“sailors 抬头望去。”[[]]下一场。");
  const validation = new TranslationValidator().validate([block], normalized);
  assert.ok(validation.failures.some((failure) =>
    failure.code === "untranslated_latin"),
  );
  assert.ok(validation.failures.some((failure) =>
    failure.code === "source_layout_token_leak"),
  );
});

test("typography normalization simplifies prose without rewriting locked targets", () => {
  const normalized = normalizeCandidateTypography({
    translations: [{ blockId: "block-0", text: "龍與黑殺隊完成了訓練。" }],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" }, ["龍"]);

  assert.equal(normalized.translations[0]?.text, "龍与黑杀队完成了训练。");
});

test("target normalization never guesses that bracket content is a scene marker", () => {
  const source = "前场[[]]后场";
  for (const marker of ["[[]]", "[ [] ]", "［［］］"]) {
    assert.equal(
      normalizeTranslatedSceneSeparators(`甲${marker}乙`, source),
      `甲${marker}乙`,
    );
  }
  assert.equal(
    normalizeTranslatedSceneSeparators("数组 [] 为空", "The array is empty."),
    "数组 [] 为空",
  );
  assert.equal(
    normalizeTranslatedSceneSeparators("数组 [] 为空", source),
    "数组 [] 为空",
  );
  assert.equal(
    normalizeTranslatedSceneSeparators(
      "数组 [] 为空；真正的场景边界在这里[[]]下一场",
      "场一[[]]场二",
    ),
    "数组 [] 为空；真正的场景边界在这里[[]]下一场",
  );
  assert.equal(
    normalizeTranslatedSceneSeparators("甲[\n[]\n]乙", source),
    "甲[\n[]\n]乙",
  );
});

test("source layout checks do not reinterpret unrelated target brackets", () => {
  const source = chapterBlock(0, "x");
  const validation = new TranslationValidator().validate([source], {
    translations: [{ blockId: source.id, text: "[[]]" }],
    notes: [],
    repaired: false,
  });

  assert.ok(!validation.failures.some((failure) =>
    failure.code === "source_layout_token_leak"));
  assert.ok(!validation.failures.some((failure) =>
    failure.code === "paragraph_count_incompatible"));
});

test("source layout tokens cannot migrate into a neighboring translated block", () => {
  const first = chapterBlock(0, "Ordinary prose without a layout token.");
  const second = chapterBlock(1, "Scene one.[[]]Scene two.");
  const validation = new TranslationValidator().validate([first, second], {
    translations: [
      { blockId: first.id, text: "第一段译文意外带出了[[]]提取记号。" },
      { blockId: second.id, text: "第二段译文保留为普通段落边界。" },
    ],
    notes: [],
    repaired: false,
  });

  assert.ok(validation.failures.some((failure) =>
    failure.code === "source_layout_token_leak" && failure.blockId === first.id));
});

test("EPUB structural slots must survive translation exactly and in order", () => {
  const source = chapterBlock(
    0,
    "⟦E0.0.0⟧Read ⟦/E0.0.0⟧⟦E0.0.1⟧this note⟦/E0.0.1⟧⟦E0.0.2⟧.⟦/E0.0.2⟧",
  );
  const missing = new TranslationValidator().validate([source], {
    translations: [{
      blockId: source.id,
      text: "⟦E0.0.0⟧阅读 ⟦/E0.0.0⟧这条注释⟦/E0.0.1⟧⟦E0.0.2⟧。⟦/E0.0.2⟧",
    }],
    notes: [],
    repaired: false,
  });
  assert.ok(missing.failures.some((failure) =>
    failure.code === "epub_structural_slot_mismatch"));

  const valid = new TranslationValidator().validate([source], {
    translations: [{
      blockId: source.id,
      text: "⟦E0.0.0⟧阅读 ⟦/E0.0.0⟧⟦E0.0.1⟧这条注释⟦/E0.0.1⟧⟦E0.0.2⟧。⟦/E0.0.2⟧",
    }],
    notes: [],
    repaired: false,
  });
  assert.ok(!valid.failures.some((failure) =>
    failure.code === "epub_structural_slot_mismatch"));
});

test("short formulas and symbolic identifiers may remain unchanged", () => {
  const source = chapterBlock(0, "F=ma");
  const validation = new TranslationValidator().validate([source], {
    translations: [{ blockId: source.id, text: "F=ma" }],
    notes: [],
    repaired: false,
  });

  assert.ok(!validation.failures.some((failure) =>
    failure.code === "target_script_mismatch"));
});

test("source layout tokens do not inflate semantic completeness length", () => {
  const source = chapterBlock(0, `${"[[]]".repeat(100)}y`);
  const validation = new TranslationValidator().validate([source], {
    translations: [{ blockId: source.id, text: "乙" }],
    notes: [],
    repaired: false,
  });

  assert.ok(!validation.failures.some((failure) =>
    failure.code === "abnormal_block_shortening"));
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

test("validator preserves a source-authored scientific binomial without allowing nearby prose", () => {
  const block = chapterBlock(
    0,
    "Science has named her Portia labiata, a species of jumping spider.",
  );
  const preserved = new TranslationValidator().validate([block], {
    translations: [{
      blockId: block.id,
      text: "科学界将她命名为 Portia labiata，一种跳蛛。",
    }],
    notes: [],
    repaired: false,
  });
  assert.ok(!preserved.failures.some((failure) =>
    failure.code === "untranslated_latin"));

  const copied = new TranslationValidator().validate([block], {
    translations: [{
      blockId: block.id,
      text: "Science has 将她命名为 Portia labiata，一种跳蛛。",
    }],
    notes: [],
    repaired: false,
  });
  assert.ok(copied.failures.some((failure) =>
    failure.code === "untranslated_latin"
    && failure.message.includes("Science")));
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
      text: "\u201B它可以是你的衣袍。”\n\n\"你好，\"我说。\n\n“尼苏斯呢？”我冷得发抖。”\n\n尾声。\"",
    }],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" });

  assert.equal(normalized.translations[0]?.text.startsWith("“"), true);
  assert.equal(normalized.translations[0]?.text.includes("“你好，”我说。"), true);
  assert.equal(normalized.translations[0]?.text.endsWith("尾声。”"), true);
  assert.equal(normalized.translations[0]?.text.includes('"'), false);
  assert.equal(/["‛‟〝〞„]/u.test(normalized.translations[0]?.text ?? ""), false);
  const validation = new TranslationValidator().validate([block], normalized);
  assert.ok(validation.failures.some((failure) =>
    failure.code === "quote_boundary_mismatch"),
  );
});

test("quote normalization removes only closing boundaries unsupported by source", () => {
  const source = chapterBlock(0, "No quoted boundary appears here.");
  const normalized = normalizeCandidateTypography({
    translations: [{ blockId: source.id, text: "正文没有引语。”" }],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" }, [], new Map([
    [source.id, source.sourceText],
  ]));

  assert.equal(normalized.translations[0]?.text, "正文没有引语。");
  const validation = new TranslationValidator().validate([source], normalized);
  assert.ok(!validation.failures.some((failure) =>
    failure.code === "quote_boundary_mismatch"));
});

test("validator recognizes a closing ASCII quote inherited from prior source context", () => {
  const source = chapterBlock(0, "A quoted sentence continues here.\"");
  const validation = new TranslationValidator().validate([source], {
    translations: [{ blockId: source.id, text: "一句引语在这里结束。”" }],
    notes: [],
    repaired: false,
  });

  assert.ok(!validation.failures.some((failure) =>
    failure.code === "quote_boundary_mismatch"));
});

test("source quote state preserves an ASCII closing quote at the next block boundary", () => {
  const first = chapterBlock(0, "He began, \"");
  const second = chapterBlock(1, "\" and then left the room.");
  const normalized = normalizeCandidateTypography({
    translations: [
      { blockId: first.id, text: "他开口说道：“" },
      { blockId: second.id, text: "”随后离开了房间。" },
    ],
    notes: [],
    repaired: false,
  }, { dialogueQuotes: "Chinese curly double quotes" }, [], new Map([
    [first.id, first.sourceText],
    [second.id, second.sourceText],
  ]));

  assert.equal(normalized.translations[1]?.text.startsWith("”"), true);
  const validation = new TranslationValidator().validate([first, second], normalized);
  assert.ok(!validation.failures.some((failure) =>
    failure.code === "quote_boundary_mismatch"), JSON.stringify(validation.failures));
});

test("quote boundary allowance cannot migrate into a neighboring block", () => {
  const first = chapterBlock(0, "Plain narration ends here.");
  const second = chapterBlock(1, "A prior quotation ends here.\"");
  const validation = new TranslationValidator().validate([first, second], {
    translations: [
      { blockId: first.id, text: "普通叙述在这里结束。”" },
      { blockId: second.id, text: "先前的引语在这里结束。" },
    ],
    notes: [],
    repaired: false,
  });

  assert.ok(validation.failures.some((failure) =>
    failure.code === "quote_boundary_mismatch" && failure.blockId === first.id));
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

test("CJK literary blocks reject implausible per-block shortening and expansion", () => {
  const korean = getSourceLanguageProfile("ko");
  const source = "가나다라마바사".repeat(100);
  const shortBlock = chapterBlock(0, source);
  const expandedBlock = chapterBlock(1, source);
  const validation = new TranslationValidator().validate(
    [shortBlock, expandedBlock],
    {
      translations: [
        { blockId: shortBlock.id, text: "短".repeat(350) },
        { blockId: expandedBlock.id, text: "长".repeat(900) },
      ],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: korean },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "abnormal_block_shortening" && failure.blockId === shortBlock.id));
  assert.ok(validation.failures.some((failure) =>
    failure.code === "abnormal_block_expansion" && failure.blockId === expandedBlock.id));
});

test("paragraph boundaries remain one-to-one across a translated block", () => {
  const source = chapterBlock(0, Array.from(
    { length: 13 },
    (_, index) => `한국어 원문 단락 ${index}에는 충분한 서술이 이어집니다.`.repeat(4),
  ).join("\n\n"));
  const validation = new TranslationValidator().validate(
    [source],
    {
      translations: [{
        blockId: source.id,
        text: Array.from(
          { length: 21 },
          (_, index) => `中文译文第${index}段保留了看似合理的篇幅。`.repeat(3),
        ).join("\n\n"),
      }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("ko") },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "paragraph_count_incompatible" && failure.blockId === source.id));
});

test("multiline display titles may redistribute wording without losing paragraph slots", () => {
  const source = chapterBlock(0, "CHILDREN\n\nOF TIME");
  const validator = new TranslationValidator();
  const redistributed = validator.validate(
    [source],
    {
      translations: [{ blockId: source.id, text: "时间\n\n之子" }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("en") },
  );
  const merged = validator.validate(
    [source],
    {
      translations: [{ blockId: source.id, text: "时间之子" }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("en") },
  );

  assert.equal(redistributed.valid, true);
  assert.ok(merged.failures.some((failure) =>
    failure.code === "paragraph_count_incompatible"));
});

test("paragraph-level length checks catch a shifted passage hidden by a healthy block total", () => {
  const source = chapterBlock(0, `${"한국어첫문단".repeat(100)}\n\n${"한국어둘째문단".repeat(100)}`);
  const validation = new TranslationValidator().validate(
    [source],
    {
      translations: [{
        blockId: source.id,
        text: `${"短".repeat(100)}\n\n${"第二段被错误塞入过多未来内容".repeat(90)}`,
      }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("ko") },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "paragraph_length_incompatible" && failure.blockId === source.id));
});

test("adjacent paraphrased paragraph runs are treated as ungrounded cross-block overlap", () => {
  const first = chapterBlock(0, [
    "가나다라마바사아자차카타파하".repeat(5),
    "고노도로모보소오조초코토포호".repeat(5),
    "구누두루무부수우주추쿠투푸후".repeat(5),
    "기니디리미비시이지치키티피히".repeat(5),
  ].join("\n\n"));
  const second = chapterBlock(1, [
    "깨내때래매배쌔애째채캐태패해".repeat(5),
    "꼬또뽀쏘쪼초쿄툐표효".repeat(6),
    "워눠둬뤄뭐붜숴줘춰쿼퉈풔훠".repeat(5),
    "계녜뎨례몌볘셰예졔쳬켸톄폐혜".repeat(5),
  ].join("\n\n"));
  const firstTarget = [
    "此外还有一件事情需要禀告大人，我修炼童子功，从来不接近女色，也不需要安排侍女服侍。",
    "既然大人已经作出决定，我便暂时住进东边的客房，等候下一步命令，不会擅自离开。",
    "侍从听完这番吩咐，立刻躬身答应下来，并命人收拾房间准备清水和简单饭菜。",
    "他向堂中众人逐一告辞，随后沿着长廊离去，脚步声很快消失在夜色深处。",
  ].join("\n\n");
  const secondTarget = [
    "此外还有一件事需禀告大人，在下修炼童子功，从不接近女色，也无需安排侍女服侍。",
    "既然大人已有决定，我便暂住东边客房，等候下一步命令，绝不会擅自离开。",
    "侍从听完这番吩咐后立刻躬身领命，又命人收拾房间，准备清水和简单饭菜。",
    "他向堂中众人逐一告辞，随后沿着长廊走远，脚步声渐渐消失在深沉夜色中。",
  ].join("\n\n");
  const validation = new TranslationValidator().validateCrossBlockAlignment(
    [first, second],
    {
      translations: [
        { blockId: first.id, text: firstTarget },
        { blockId: second.id, text: secondTarget },
      ],
      notes: [],
      repaired: false,
    },
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((failure) =>
    failure.code === "cross_block_translation_overlap"));
});

test("default language profiles reject one-block omissions hidden by a healthy sibling", () => {
  const first = chapterBlock(0, "a".repeat(399));
  const second = chapterBlock(1, "b".repeat(500));
  const validation = new TranslationValidator().validate(
    [first, second],
    {
      translations: [
        { blockId: first.id, text: "短" },
        { blockId: second.id, text: "丙".repeat(350) },
      ],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("en") },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "abnormal_block_shortening" && failure.blockId === first.id));
});

test("CJK short-scene bands reject a token translation below the long-block threshold", () => {
  const source = "가".repeat(399);
  const item = chapterBlock(0, source);
  const validation = new TranslationValidator().validate(
    [item],
    {
      translations: [{ blockId: item.id, text: `短${"\u200B".repeat(350)}\uFFFD` }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("ko") },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "abnormal_block_shortening" && failure.blockId === item.id));
  assert.ok(validation.failures.some((failure) =>
    failure.code === "invalid_unicode_output" && failure.blockId === item.id));
});

test("CJK micro blocks and invisible padding cannot bypass completeness checks", () => {
  const korean = getSourceLanguageProfile("ko");
  const micro = chapterBlock(0, "가".repeat(23));
  const padded = chapterBlock(1, "나".repeat(399));
  const validation = new TranslationValidator().validate(
    [micro, padded],
    {
      translations: [
        { blockId: micro.id, text: "短" },
        { blockId: padded.id, text: `短${"\u0000".repeat(350)}` },
      ],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: korean },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "abnormal_block_shortening" && failure.blockId === micro.id));
  assert.ok(validation.failures.some((failure) =>
    failure.code === "abnormal_block_shortening" && failure.blockId === padded.id));
  assert.ok(validation.failures.some((failure) =>
    failure.code === "invalid_unicode_output" && failure.blockId === padded.id));
});

test("grapheme and invalid-scalar padding cannot forge CJK translation length", () => {
  const korean = getSourceLanguageProfile("ko");
  const paddings = [
    "\u0301".repeat(350),
    "\u20DD".repeat(350),
    "\uFFFF".repeat(350),
    "\uFDD0".repeat(350),
    "\uD800".repeat(350),
  ];
  for (const [index, padding] of paddings.entries()) {
    const item = chapterBlock(index, "가".repeat(399));
    const validation = new TranslationValidator().validate(
      [item],
      {
        translations: [{ blockId: item.id, text: `短${padding}` }],
        notes: [],
        repaired: false,
      },
      { sourceLanguageProfile: korean },
    );
    assert.ok(validation.failures.some((failure) =>
      failure.code === "abnormal_block_shortening" && failure.blockId === item.id));
    if (index >= 2) {
      assert.ok(validation.failures.some((failure) =>
        failure.code === "invalid_unicode_output" && failure.blockId === item.id));
    }
  }
});

test("bidirectional and invisible format controls are rejected from translated prose", () => {
  const prohibited = [
    "\u00AD", "\u061C", "\u180E", "\u200B", "\u200E", "\u200F",
    "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
    "\u2060", "\u2066", "\u2067", "\u2068", "\u2069", "\uFEFF",
  ];
  for (const [index, control] of prohibited.entries()) {
    const item = chapterBlock(index, "한국어 문장이 충분히 길게 이어집니다.".repeat(8));
    const validation = new TranslationValidator().validate(
      [item],
      {
        translations: [{ blockId: item.id, text: `这是一段完整的中文译文${control}并且长度足够。`.repeat(8) }],
        notes: [],
        repaired: false,
      },
      { sourceLanguageProfile: getSourceLanguageProfile("ko") },
    );
    assert.ok(validation.failures.some((failure) =>
      failure.code === "invalid_unicode_output" && failure.blockId === item.id),
    `expected U+${control.codePointAt(0)?.toString(16).toUpperCase()} to be rejected`);
  }
});

test("punctuation, digits, and emoji cannot impersonate translated prose", () => {
  const korean = getSourceLanguageProfile("ko");
  for (const [index, noise] of [".", "。", "1", "🙂"].entries()) {
    const item = chapterBlock(index, "가".repeat(23));
    const validation = new TranslationValidator().validate(
      [item],
      {
        translations: [{ blockId: item.id, text: noise.repeat(23) }],
        notes: [],
        repaired: false,
      },
      { sourceLanguageProfile: korean },
    );
    assert.ok(validation.failures.some((failure) =>
      failure.code === "insufficient_lexical_content" && failure.blockId === item.id));
  }
});

test("source-script prose cannot pass as a Chinese translation", () => {
  for (const profileId of ["ja", "ko"] as const) {
    const item = chapterBlock(0, profileId === "ja" ? "あ".repeat(23) : "가".repeat(23));
    const validation = new TranslationValidator().validate(
      [item],
      {
        translations: [{ blockId: item.id, text: "A".repeat(23) }],
        notes: [],
        repaired: false,
      },
      { sourceLanguageProfile: getSourceLanguageProfile(profileId) },
    );
    assert.ok(validation.failures.some((failure) =>
      failure.code === "target_script_mismatch" && failure.blockId === item.id));
  }
});

test("a small Chinese prefix cannot disguise a mostly non-Chinese target", () => {
  const item = chapterBlock(0, "가".repeat(399));
  const validation = new TranslationValidator().validate(
    [item],
    {
      translations: [{ blockId: item.id, text: `${"甲".repeat(35)}${"α".repeat(315)}` }],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: getSourceLanguageProfile("ko") },
  );
  assert.ok(validation.failures.some((failure) =>
    failure.code === "target_script_mismatch" && failure.blockId === item.id));
});

test("zero-width padding cannot hide a copied cross-block paragraph", () => {
  const first = chapterBlock(0, "甲源".repeat(100));
  const second = chapterBlock(1, "乙源".repeat(100));
  const repeated = "重复内容".repeat(15);
  const validation = new TranslationValidator().validateCrossBlockAlignment(
    [first, second],
    {
      translations: [
        { blockId: first.id, text: repeated },
        { blockId: second.id, text: `${repeated.slice(0, 30)}\u200B${repeated.slice(30)}` },
      ],
      notes: [],
      repaired: false,
    },
  );

  assert.equal(validation.valid, false);
});

test("validator rejects long target paragraphs copied across distinct source blocks", () => {
  const korean = getSourceLanguageProfile("ko");
  const first = chapterBlock(0, "가나다라마바사".repeat(100));
  const second = chapterBlock(1, "아자차카타파하".repeat(100));
  const duplicated = "这是一段被错误复制到相邻文本块的完整中文内容".repeat(5);
  const validation = new TranslationValidator().validate(
    [first, second],
    {
      translations: [
        { blockId: first.id, text: `${"甲".repeat(400)}\n\n${duplicated}` },
        { blockId: second.id, text: `${"乙".repeat(400)}\n\n${duplicated}` },
      ],
      notes: [],
      repaired: false,
    },
    { sourceLanguageProfile: korean },
  );

  assert.ok(validation.failures.some((failure) =>
    failure.code === "cross_block_translation_overlap" && failure.blockId === first.id));
  assert.ok(validation.failures.some((failure) =>
    failure.code === "cross_block_translation_overlap" && failure.blockId === second.id));
});

test("one legitimate repeated source paragraph cannot exempt an extra target duplicate", () => {
  const repeatedSource = "가나다라마바사아자차카타파하".repeat(6);
  const first = chapterBlock(0, `${repeatedSource}\n\n${"첫째본문".repeat(100)}`);
  const second = chapterBlock(1, `${repeatedSource}\n\n${"둘째본문".repeat(100)}`);
  const legitimateTarget = "这是原文中本就重复出现的长段内容".repeat(6);
  const leakedTarget = "这是模型额外串入两个文本块的错误长段内容".repeat(6);
  const validation = new TranslationValidator().validateCrossBlockAlignment(
    [first, second],
    {
      translations: [
        { blockId: first.id, text: `${legitimateTarget}\n\n${leakedTarget}\n\n${"甲".repeat(300)}` },
        { blockId: second.id, text: `${legitimateTarget}\n\n${leakedTarget}\n\n${"乙".repeat(300)}` },
      ],
      notes: [],
      repaired: false,
    },
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((failure) => failure.blockId === first.id));
  assert.ok(validation.failures.some((failure) => failure.blockId === second.id));
});

test("a source scene marker exposes a legitimate repeated paragraph to alignment", () => {
  const sharedSource = "共同源段".repeat(30);
  const first = chapterBlock(0, `${"第一场景".repeat(30)}[[]]${sharedSource}`);
  const second = chapterBlock(1, `${"第二场景".repeat(30)}[[]]${sharedSource}`);
  const sharedTarget = "共同译文".repeat(30);
  const validation = new TranslationValidator().validateCrossBlockAlignment(
    [first, second],
    {
      translations: [
        { blockId: first.id, text: `${"甲".repeat(100)}\n\n${sharedTarget}` },
        { blockId: second.id, text: `${"乙".repeat(100)}\n\n${sharedTarget}` },
      ],
      notes: [],
      repaired: false,
    },
  );

  assert.equal(validation.valid, true);
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
