import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  collectRepeatedAnchorCandidates,
  collectWindowAnchorCandidates,
  createLexicalPreferredFallbackProtocol,
  LexicalAnchorer,
  parseLexicalPreferredFallbackResponse,
  sourceAuthoredAnchorFallback,
  softenModelAnchorTerm,
} from "../src/agents/lexical-anchorer.js";
import { ModelProviderError, PiRuntime } from "../src/agents/pi-runtime.js";
import type { StableTerm, V4Block } from "../src/domain/types.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";

function block(text: string, index = 1): V4Block {
  return {
    id: `block-${index}`,
    legacyId: null,
    chapterId: "chapter",
    chapterTitle: "Fixture",
    globalIndex: index,
    blockIndex: index,
    sourceText: text,
    sourceHash: "hash",
    tokenCount: 20,
  };
}

const typhonTerm: StableTerm = {
  conceptId: "typhon",
  lexemeId: "typhon-lexeme",
  sourceForm: "Typhon",
  canonicalSource: "Typhon",
  target: "提丰",
  locked: true,
};

test("legacy cached model anchors are downgraded to preferred constraints", () => {
  const softened = softenModelAnchorTerm({
    conceptId: "run-anchor-legacy",
    lexemeId: "run-anchor-lexeme-legacy",
    sourceForm: "제자",
    canonicalSource: "제자",
    target: "弟子",
    locked: true,
  });

  assert.equal(softened.locked, false);
  assert.equal(softened.policy, "preferred");
  assert.equal(typhonTerm.locked, true);
});

test("candidate extraction keeps repeated unknown titles but removes established terms", () => {
  const candidates = collectRepeatedAnchorCandidates([
    block(
      "The Conciliator faced Typhon. Later Typhon was called the enemy of the Conciliator.",
    ),
  ], [typhonTerm]);

  assert.deepEqual(candidates.map((candidate) => candidate.sourceForm), [
    "Conciliator",
  ]);
  assert.equal(candidates[0]?.contexts.length, 2);
});

test("window anchor candidates use whole-book concordance without reconsidering contextual decisions", () => {
  const target = [block("Smoky arrived at Edgewood.", 0)];
  const corpus = [
    ...target,
    block("Later Smoky returned to Edgewood.", 1),
    block("Edgewood remained on no map.", 2),
  ];
  const candidates = collectWindowAnchorCandidates(target, corpus, [], ["Edgewood"]);
  assert.deepEqual(candidates.map((item) => item.sourceForm), ["Smoky"]);
  assert.equal(candidates[0]?.contexts.length, 2);
});

test("window anchor candidates delegate first occurrences to the source language profile", () => {
  const target = [block("Loukianos regarda Lucian.", 0)];
  const candidates = collectWindowAnchorCandidates(
    target,
    target,
    [],
    [],
    getSourceLanguageProfile("fr"),
  );
  assert.deepEqual(candidates.map((item) => item.sourceForm), ["Loukianos", "Lucian"]);
});

test("window anchor candidates use the Korean profile instead of falling back to undetermined text", () => {
  const source = "\ub77c\uc628 \uc7a5\uad70\uc740 \uc131\uc73c\ub85c \ud5a5\ud588\ub2e4. \ub77c\uc628 \uc7a5\uad70\uc740 \uc131\uc8fc\ub97c \ub9cc\ub0ac\ub2e4.";
  const candidates = collectWindowAnchorCandidates(
    [block(source, 0)],
    [block(source, 0)],
    [],
    [],
    getSourceLanguageProfile("ko"),
  );

  assert.ok(candidates.some((candidate) => candidate.sourceForm === "\ub77c\uc628"));
  assert.ok(candidates.length <= 24);
});

test("Korean anchor ranking reserves scarce slots for locally concentrated names", () => {
  const diffuse = [
    "보이지", "정점", "있던", "빨리", "얘기", "제자", "교주님", "하지",
    "그들", "음식", "주십시오", "사부님", "선배님", "지나자", "아니", "보여",
  ];
  const inflected = (form: string) => `${form}는 ${form}가`;
  const targetText = [
    ...diffuse.map(inflected),
    "진양은 진양이 진양을 만났다",
    "옥관패는 옥관패가 옥관패를 들었다",
  ].join(". ");
  const corpus = [
    block(targetText, 0),
    block("진양과 옥관패가 다시 나타났다. 진양은 옥관패를 보았다.", 1),
    ...Array.from({ length: 24 }, (_, index) => block(
      diffuse.map((form) => `${form}는 ${form}가`).join(". "),
      index + 2,
    )),
  ];

  const candidates = collectWindowAnchorCandidates(
    [corpus[0]!],
    corpus,
    [],
    [],
    getSourceLanguageProfile("ko"),
  );

  assert.ok(candidates.some((candidate) => candidate.sourceForm === "진양"));
  assert.ok(candidates.some((candidate) => candidate.sourceForm === "옥관패"));
  assert.ok(candidates.length <= 24);
});

test("Korean title adjacency keeps an uninflected repeated personal name eligible", () => {
  const source = "\uc6a9\ucc9c\uc775 \ub2f9\uc8fc\uac00 \uc654\ub2e4. \uc6a9\ucc9c\uc775 \ub2f9\uc8fc\ub294 \ub2e4\uc2dc \ub9d0\ud588\ub2e4.";
  const candidates = collectWindowAnchorCandidates(
    [block(source, 0)],
    [block(source, 0)],
    [],
    [],
    getSourceLanguageProfile("ko"),
  );
  const candidate = candidates.find((item) => item.sourceForm === "\uc6a9\ucc9c\uc775");
  assert.equal(candidate?.likelyProperName, true, JSON.stringify(candidates));
});

test("Korean source-authored Hanja glosses survive candidate ranking and bind the canonical target", async () => {
  const source = [
    "\uc625\uad00\ud328(\u7389\u51a0\u8987) \uc678\ucd1d\uad00\uc774 \ub3c4\ucc29\ud588\ub2e4.",
    "\uc124\uc57d\ubcbd(\u859b\u82e5\u78a7)\uc774 \uc625\uad00\ud328\ub97c \ub9cc\ub0ac\ub2e4.",
    "\ud601\ubb34\uc0c1(\u8d6b\u6b66\u76f8)\uc774 \uc625\uad00\ud328\uc5d0\uac8c \ub2f5\ud588\ub2e4.",
    "\uc6a9\ucc9c\uc775(\u9f8d\u5929\u7ffc)\uc774 \uc124\uc57d\ubcbd\uacfc \ud601\ubb34\uc0c1\uc744 \ubd88\ub800\ub2e4.",
    "\uc6a9\ucc9c\uc775\uc774 \ub2e4\uc2dc \uc625\uad00\ud328\ub97c \ubd88\ub800\ub2e4.",
  ].join(" ");
  const candidates = collectWindowAnchorCandidates(
    [block(source, 0)],
    [block(source, 0)],
    [],
    [],
    getSourceLanguageProfile("ko"),
  );
  const sourceForms = candidates.map((candidate) => candidate.sourceForm);
  for (const expected of ["\uc625\uad00\ud328", "\uc124\uc57d\ubcbd", "\ud601\ubb34\uc0c1", "\uc6a9\ucc9c\uc775"]) {
    assert.ok(sourceForms.includes(expected), JSON.stringify(sourceForms));
  }
  const candidate = candidates.find((item) => item.sourceForm === "\uc625\uad00\ud328");
  assert.equal(candidate?.sourceAuthoredTarget, "\u7389\u51a0\u8987");
  assert.equal(candidate?.likelyProperName, true);

  const fallback = sourceAuthoredAnchorFallback(candidate === undefined ? [] : [candidate]);
  assert.equal(fallback.terms[0]?.target, "\u7389\u51a0\u9738");
  assert.equal(fallback.terms[0]?.locked, false);
  assert.equal(fallback.terms[0]?.policy, "preferred");

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc625\uad00\ud328",
      target: "\u7389\u51a0\u724c",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.8,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: candidate === undefined ? [] : [candidate],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.target, "\u7389\u51a0\u9738");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("a high-confidence source-authored common noun remains a preference", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc0ac\ub78c",
      target: "\uc778\uac04",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.99,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "\uc0ac\ub78c",
      sourceAuthoredTarget: "\u4eba",
      contexts: ["\uc0ac\ub78c(\u4eba)\uc740 \uc0ac\ub78c(\u4eba)\uc744 \ub3c4\uc654\ub2e4."],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.target, "\u4eba");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("a stable ordinary-word decision cannot replace an explicit source-authored target", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc124\uc57d\ubcbd",
      target: "\u859b\u82e5\u58c1",
      mode: "stable",
      semanticClass: "ordinary_word",
      confidence: 0.99,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "\uc124\uc57d\ubcbd",
      sourceAuthoredTarget: "\u859b\u82e5\u78a7",
      contexts: ["\uc124\uc57d\ubcbd(\u859b\u82e5\u78a7)\uc774 \ub3c4\ucc29\ud588\ub2e4."],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.target, "\u859b\u82e5\u78a7");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("a repeated common word cannot be hard-locked by model confidence alone", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc0ac\ub78c",
      target: "\uc778\uac04",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.99,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "\uc0ac\ub78c",
      contexts: ["\uc0ac\ub78c\uc740 \uc0ac\ub78c\uc744 \ub3c4\uc654\ub2e4."],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.target, "\uc778\uac04");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("a contextual model decision cannot discard an explicit source-authored target", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc124\uc57d\ubcbd",
      target: "",
      mode: "contextual",
      semanticClass: "ordinary_word",
      confidence: 0.9,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "\uc124\uc57d\ubcbd",
      sourceAuthoredTarget: "\u859b\u82e5\u78a7",
      contexts: ["\uc124\uc57d\ubcbd(\u859b\u82e5\u78a7)\uc774 \ub3c4\ucc29\ud588\ub2e4."],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.target, "\u859b\u82e5\u78a7");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("a provisional alias claim cannot override an explicit source-authored target", async () => {
  const context = "\uc625\uad00\ud328(\u7389\u51a0\u8987)\ub294 Crown\uc774\ub77c\uace0 \ubd88\ub838\ub2e4.";
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc625\uad00\ud328",
      target: "\u7389\u51a0\u724c",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 1,
    }, {
      sourceForm: "Crown",
      target: "\u7389\u51a0\u724c",
      mode: "contextual",
      semanticClass: "ordinary_word",
      confidence: 1,
    }],
    entityLinks: [{
      sourceForms: ["\uc625\uad00\ud328", "Crown"],
      proposedTarget: "\u7389\u51a0\u724c",
      evidenceKind: "explicit_naming",
      evidenceQuote: context,
      confidence: 0.99,
    }],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "\uc625\uad00\ud328",
      sourceAuthoredTarget: "\u7389\u51a0\u8987",
      likelyProperName: true,
      contexts: [context],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    }, {
      sourceForm: "Crown",
      contexts: [context],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.entityLinks[0]?.status, "provisional");
  assert.deepEqual(outcome.terms.map((term) => term.target), ["\u7389\u51a0\u9738"]);
  assert.ok(outcome.terms.every((term) => term.locked === false));
});

test("an explicit-naming claim without a source-language naming cue stays provisional", async () => {
  const context = "\uc0ac\ub78c\uc740 \ub0a8\uc790\ub97c \ubcf4\uc558\ub2e4.";
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: ["\uc0ac\ub78c", "\ub0a8\uc790"].map((sourceForm) => ({
      sourceForm,
      target: sourceForm === "\uc0ac\ub78c" ? "\u4eba" : "\u7537\u4eba",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.99,
    })),
    entityLinks: [{
      sourceForms: ["\uc0ac\ub78c", "\ub0a8\uc790"],
      proposedTarget: "\u4eba",
      evidenceKind: "explicit_naming",
      evidenceQuote: context,
      confidence: 0.99,
    }],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: ["\uc0ac\ub78c", "\ub0a8\uc790"].map((sourceForm) => ({
      sourceForm,
      contexts: [context],
      corpusFrequency: 2,
      currentWaveOccurrences: 2,
      documentFrequency: 1,
    })),
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.entityLinks[0]?.status, "provisional");
  assert.ok(outcome.terms.every((term) => term.locked === false));
});

test("an alias quote that omits one linked form stays provisional", async () => {
  const johnContext = "John was called a fool.";
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: ["John", "Peter"].map((sourceForm) => ({
      sourceForm,
      target: sourceForm === "John" ? "\u7ea6\u7ff0" : "\u5f7c\u5f97",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.99,
    })),
    entityLinks: [{
      sourceForms: ["John", "Peter"],
      proposedTarget: "\u7ea6\u7ff0",
      evidenceKind: "explicit_naming",
      evidenceQuote: johnContext,
      confidence: 0.99,
    }],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "John",
      contexts: [johnContext],
      corpusFrequency: 2,
      currentWaveOccurrences: 1,
      documentFrequency: 2,
    }, {
      sourceForm: "Peter",
      contexts: ["Peter arrived later."],
      corpusFrequency: 2,
      currentWaveOccurrences: 1,
      documentFrequency: 2,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  });

  assert.equal(outcome.entityLinks[0]?.status, "provisional");
  assert.ok(outcome.terms.every((term) => term.locked === false));
});

test("lexical anchoring rejects a plain-text completion that never submits decisions", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("I will not call the required tool.")]);
  await assert.rejects(
    new LexicalAnchorer(new PiRuntime()).run({
      candidates: [{
        sourceForm: "Smoky",
        contexts: ["Smoky arrived."],
        corpusFrequency: 2,
        currentWaveOccurrences: 1,
      }],
      stableTerms: [],
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
      budget: new BudgetLedger(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.kind, "protocol");
      assert.ok(error.run !== undefined);
      assert.ok(error.run.usage.totalTokens > 0);
      return true;
    },
  );
});

test("framed lexical fallback recovers safe preferred names without tool calls", () => {
  const candidates = [{
    sourceForm: "용천익",
    likelyProperName: true,
    contexts: ["용천익 당주가 묵향을 만났다."],
    corpusFrequency: 4,
    currentWaveOccurrences: 2,
    documentFrequency: 2,
  }, {
    sourceForm: "묵향",
    likelyProperName: true,
    contexts: ["용천익 당주가 묵향을 만났다."],
    corpusFrequency: 9,
    currentWaveOccurrences: 3,
    documentFrequency: 4,
  }];
  const profile = getSourceLanguageProfile("ko");
  const protocol = createLexicalPreferredFallbackProtocol(candidates, profile);
  const parsed = parseLexicalPreferredFallbackResponse([
    protocol.beginLine,
    JSON.stringify([{
      sourceForm: "용천익",
      target: "龙天翼",
      semanticClass: "proper_name",
      confidence: 0.94,
    }, {
      sourceForm: "묵향",
      target: "墨香",
      semanticClass: "proper_name",
      confidence: 0.98,
    }]),
    protocol.endLine,
  ].join("\n"), protocol, candidates, profile);

  assert.deepEqual(parsed.terms.map((term) => [
    term.sourceForm,
    term.target,
    term.policy,
    term.locked,
  ]), [
    ["용천익", "龙天翼", "preferred", false],
    ["묵향", "墨香", "preferred", false],
  ]);
  assert.deepEqual(parsed.entityLinks, []);
});

test("framed lexical fallback preserves source-authored Hanja and rejects injected forms", () => {
  const candidates = [{
    sourceForm: "옥관패",
    sourceAuthoredTarget: "玉冠覇",
    likelyProperName: true,
    contexts: ["옥관패(玉冠覇)가 왔다."],
    corpusFrequency: 2,
    currentWaveOccurrences: 2,
    documentFrequency: 1,
  }];
  const profile = getSourceLanguageProfile("ko");
  const protocol = createLexicalPreferredFallbackProtocol(candidates, profile);
  const response = (body: unknown) => [
    protocol.beginLine,
    JSON.stringify(body),
    protocol.endLine,
  ].join("\n");
  const parsed = parseLexicalPreferredFallbackResponse(response([{
    sourceForm: "옥관패",
    target: "玉冠牌",
    semanticClass: "proper_name",
    confidence: 0.99,
  }]), protocol, candidates, profile);
  assert.equal(parsed.terms[0]?.target, "玉冠霸");
  assert.equal(parsed.terms[0]?.locked, false);

  assert.throws(
    () => parseLexicalPreferredFallbackResponse(response([{
      sourceForm: "공격자",
      target: "攻击者",
      semanticClass: "proper_name",
      confidence: 0.99,
    }]), protocol, candidates, profile),
    (error: unknown) => error instanceof ModelProviderError && error.kind === "protocol",
  );
});

test("framed lexical fallback leaves omitted uncertain candidates undecided", () => {
  const candidates = [{
    sourceForm: "그분",
    contexts: ["그분이 왔다."],
    corpusFrequency: 3,
    currentWaveOccurrences: 1,
    documentFrequency: 3,
  }];
  const profile = getSourceLanguageProfile("ko");
  const protocol = createLexicalPreferredFallbackProtocol(candidates, profile);
  const parsed = parseLexicalPreferredFallbackResponse([
    protocol.beginLine,
    "[]",
    protocol.endLine,
  ].join("\n"), protocol, candidates, profile);

  assert.deepEqual(parsed.anchors, []);
  assert.deepEqual(parsed.terms, []);
});

test("lexical fallback accepts one strict bare JSON array but no prose wrapper", () => {
  const candidates = [{
    sourceForm: "용천익",
    likelyProperName: true,
    contexts: ["용천익 당주가 왔다."],
    corpusFrequency: 3,
    currentWaveOccurrences: 2,
    documentFrequency: 2,
  }];
  const profile = getSourceLanguageProfile("ko");
  const protocol = createLexicalPreferredFallbackProtocol(candidates, profile);
  const bare = JSON.stringify([{
    sourceForm: "용천익",
    target: "龙天翼",
    semanticClass: "proper_name",
    confidence: 0.9,
  }]);
  const parsed = parseLexicalPreferredFallbackResponse(
    bare,
    protocol,
    candidates,
    profile,
  );
  assert.equal(parsed.terms[0]?.target, "龙天翼");
  assert.throws(
    () => parseLexicalPreferredFallbackResponse(
      `Here is the result:\n${bare}`,
      protocol,
      candidates,
      profile,
    ),
    (error: unknown) => error instanceof ModelProviderError && error.kind === "protocol",
  );
});

test("lexical fallback omits copied Korean or Japanese script targets", () => {
  for (const fixture of [{ language: "ko", sourceForm: "용천익" }, {
    language: "ja",
    sourceForm: "セヴェリアン",
  }] as const) {
    const candidates = [{
      sourceForm: fixture.sourceForm,
      likelyProperName: true,
      contexts: [`${fixture.sourceForm} arrived.`],
      corpusFrequency: 3,
      currentWaveOccurrences: 2,
      documentFrequency: 2,
    }];
    const profile = getSourceLanguageProfile(fixture.language);
    const protocol = createLexicalPreferredFallbackProtocol(candidates, profile);
    const parsed = parseLexicalPreferredFallbackResponse(JSON.stringify([{
      sourceForm: fixture.sourceForm,
      target: fixture.sourceForm,
      semanticClass: "proper_name",
      confidence: 0.9,
    }]), protocol, candidates, profile);
    assert.deepEqual(parsed.terms, []);
  }
});

test("title-adjacent repeated forms remain preferred even at high model confidence", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "\uc6a9\ucc9c\uc775",
      target: "\u9f99\u5929\u7ffc",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.99,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);
  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "\uc6a9\ucc9c\uc775",
      likelyProperName: true,
      contexts: ["\uc6a9\ucc9c\uc775 \ub2f9\uc8fc\uac00 \uc654\ub2e4."],
      corpusFrequency: 6,
      currentWaveOccurrences: 3,
      documentFrequency: 3,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.target, "\u9f99\u5929\u7ffc");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("single-pass lexical anchor decisions remain preferred rather than hard-locked", async () => {
  const candidates = collectRepeatedAnchorCandidates([
    block("The Conciliator spoke. Typhon opposed the Conciliator."),
  ], [typhonTerm]);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("submit_lexical_anchors", {
        anchors: [{
          sourceForm: "Conciliator",
          target: "調和者",
          mode: "stable",
          semanticClass: "unique_title",
          confidence: 0.95,
        }],
      }),
      { stopReason: "toolUse" },
    ),
  ]);

  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates,
    stableTerms: [typhonTerm],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(outcome.anchors.length, 1);
  assert.equal(outcome.terms[0]?.sourceForm, "Conciliator");
  assert.equal(outcome.terms[0]?.target, "调和者");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("an uncorroborated capitalized common word stays a soft preference", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "Ocean",
      target: "海洋",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.99,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);

  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "Ocean",
      contexts: [
        "They crossed the Ocean in silence.",
        "The western edge of the Ocean was dark.",
      ],
      corpusFrequency: 9,
      currentWaveOccurrences: 3,
      documentFrequency: 3,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  });

  assert.equal(outcome.anchors[0]?.semanticClass, "unclassified");
  assert.equal(outcome.terms.length, 1);
  assert.match(outcome.terms[0]?.conceptId ?? "", /^run-anchor-/u);
  assert.equal(outcome.terms[0]?.policy, "preferred");
  assert.equal(outcome.terms[0]?.locked, false);
});

test("contextual role anchor remains translator-visible without forcing one surface form", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "Prokurist",
      target: "主事",
      mode: "contextual",
      semanticClass: "role",
      confidence: 0.95,
    }, {
      sourceForm: "Fenster",
      target: "窗户",
      mode: "contextual",
      semanticClass: "ordinary_word",
      confidence: 0.99,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);

  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates: [{
      sourceForm: "Prokurist",
      contexts: ["Der Prokurist sprach mit Gregor."],
      corpusFrequency: 4,
      currentWaveOccurrences: 2,
      documentFrequency: 2,
    }, {
      sourceForm: "Fenster",
      contexts: ["Gregor sah zum Fenster."],
      corpusFrequency: 4,
      currentWaveOccurrences: 2,
      documentFrequency: 2,
    }],
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("de"),
  });

  assert.deepEqual(outcome.terms.map((term) => ({
    sourceForm: term.sourceForm,
    target: term.target,
    policy: term.policy,
    semanticClass: term.semanticClass,
    allowedTargets: term.allowedTargets,
    hasFingerprint: term.renderFingerprint?.length === 64,
  })), [{
    sourceForm: "Prokurist",
    target: "主事",
    policy: "contextual",
    semanticClass: "role",
    allowedTargets: ["主事"],
    hasFingerprint: true,
  }]);
});

test("one source-supported proper-name classification remains a preference", async () => {
  const source = "진양은 성으로 향했다. 진양이 성주를 만났다. 진양을 모두가 기다렸다.";
  const candidates = collectWindowAnchorCandidates(
    [block(source, 0)],
    [block(source, 0), block("훗날 진양은 다시 돌아왔다.", 1)],
    [],
    [],
    getSourceLanguageProfile("ko"),
  ).filter((candidate) => candidate.sourceForm === "진양");
  assert.equal(candidates.length, 1);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: [{
      sourceForm: "진양",
      target: "陈阳",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.98,
    }],
    entityLinks: [],
  }), { stopReason: "toolUse" })]);

  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates,
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
    sourceLanguageProfile: getSourceLanguageProfile("ko"),
  });

  assert.equal(outcome.terms[0]?.sourceForm, "진양");
  assert.equal(outcome.terms[0]?.locked, false);
  assert.equal(outcome.terms[0]?.policy, "preferred");
});

test("Pi lexical anchor evidence records a provisional entity link", async () => {
  const candidates = collectWindowAnchorCandidates(
    [block("Loukianos, whom they called Lucian the Scoffer, laughed.")],
    [block("Loukianos, whom they called Lucian the Scoffer, laughed.")],
    [],
  );
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_lexical_anchors", {
    anchors: candidates.map((candidate) => ({
      sourceForm: candidate.sourceForm,
      target: "卢奇安",
      mode: "stable",
      semanticClass: "proper_name",
      confidence: 0.95,
    })),
    entityLinks: [{
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget: "盧奇安",
      evidenceKind: "explicit_naming",
      evidenceQuote: "Loukianos, whom they called Lucian the Scoffer, laughed.",
      confidence: 0.95,
    }],
  }), { stopReason: "toolUse" })]);

  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates,
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(outcome.entityLinks[0]?.status, "provisional");
  assert.equal(outcome.entityLinks[0]?.preferredTarget, null);
  assert.ok(outcome.terms
    .filter((term) => ["Loukianos", "Lucian"].includes(term.sourceForm))
    .every((term) => term.locked === false && term.target === "卢奇安"));
});

test("entity alias proposals remain provisional even with an explanatory target", async () => {
  const source = "Loukianos, who was also known as Lucian the Scoffer, wrote.";
  const candidates = collectWindowAnchorCandidates([block(source)], [block(source)], []);
  const submission = (proposedTarget: string) => ({
    anchors: candidates.map((candidate) => ({
      sourceForm: candidate.sourceForm,
      target: candidate.sourceForm === "Scoffer" ? "嘲弄者" : "卢奇安",
      mode: "stable" as const,
      semanticClass: candidate.sourceForm === "Scoffer" ? "unique_title" : "proper_name",
      confidence: 0.95,
    })),
    entityLinks: [{
      sourceForms: ["Loukianos", "Lucian"],
      proposedTarget,
      evidenceKind: "explicit_naming" as const,
      evidenceQuote: source,
      confidence: 0.95,
    }],
  });
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(
      "submit_lexical_anchors",
      submission("卢奇安（嘲弄者卢奇安）"),
    ), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall(
      "submit_lexical_anchors",
      submission("卢奇安"),
    ), { stopReason: "toolUse" }),
  ]);

  const outcome = await new LexicalAnchorer(new PiRuntime()).run({
    candidates,
    stableTerms: [],
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider),
    budget: new BudgetLedger(),
  });

  assert.equal(faux.state.callCount, 1);
  assert.equal(outcome.entityLinks[0]?.status, "provisional");
  assert.equal(outcome.entityLinks[0]?.preferredTarget, null);
  assert.ok(outcome.terms
    .filter((term) => ["Loukianos", "Lucian"].includes(term.sourceForm))
    .every((term) => term.target === "卢奇安" && term.locked === false));
});
