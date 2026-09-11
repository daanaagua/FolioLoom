import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  expectedTermOccurrencesForTranslationInput,
  prepareTranslationRequest,
  type TranslationRequestInput,
} from "../src/agents/translation-request.js";
import { conceptFromAnchor } from "../src/knowledge/lexical-concept.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import { RequestBudgeter } from "../src/fullbook/request-budgeter.js";
import type { StableTerm } from "../src/domain/types.js";
import type { ExpectedTermOccurrence } from "../src/knowledge/term-usage.js";

function fixture(): TranslationRequestInput {
  const sourceText = "Mara waited. Mara had not promised to leave.";
  const concept = conceptFromAnchor({ sourceForm: "Mara", target: "玛拉", mode: "stable",
    semanticClass: "proper_name", confidence: 0.99 });
  return {
    request: { requestId: "request", sourceTokens: 20, windows: [{
      windowId: "window", ordinal: 0, chapterId: "chapter", chapterTitle: null,
      blockIds: ["block"], globalIndexes: [0], sourceTokens: 20,
      sourceChars: sourceText.length, oversized: false,
    }] },
    blocks: [{ id: "block", sourceVersion: "source", canonicalStart: 0,
      canonicalEnd: sourceText.length, sourceText,
      sourceHash: createHash("sha256").update(sourceText).digest("hex"),
      globalIndex: 0, tokenCount: 20, structureId: null, structureTitle: null }],
    stableTerms: [{ conceptId: concept.conceptId, lexemeId: "mara-form", sourceForm: "Mara",
      canonicalSource: "Mara", target: concept.canonicalTarget, locked: true,
      semanticClass: concept.semanticClass, policy: concept.policy,
      allowedTargets: concept.allowedRealizations, revisionId: concept.revisionId,
      renderFingerprint: concept.renderFingerprint, note: "Preserve the restrained register.",
      ruleId: "mara-rule", baseConceptId: "mara", entityId: "entity-mara",
      origin: "knowledge", authorityRank: 60, priority: 2,
      applicableBlockIds: ["block"], applicability: {kind: "block_range", sourceVersion: "source",
        startBlockId: "block", endBlockId: "block", startGlobalIndex: 0, endGlobalIndex: 0} }],
    snapshot: { id: "snapshot", revisions: [] },
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  };
}

function withoutAudit<T extends { revisionId?: string; renderFingerprint?: string }>(value: T) {
  const { revisionId: _revisionId, renderFingerprint: _renderFingerprint, ...rest } = value;
  return rest;
}

for (const responseProtocol of ["typed_tool", "framed_text"] as const) {
  test(`${responseProtocol} omits only local revision hashes while retaining full validation records`, () => {
    const input = { ...fixture(), responseProtocol };
    const before = JSON.stringify(input);
    const full = expectedTermOccurrencesForTranslationInput(input);
    assert.equal(full.length, 2);
    const prepared = prepareTranslationRequest(input);
    const section = prepared.sections.find((item) => item.kind === "terms")!;
    const payload = section.jsonPayload as {stableTerms: StableTerm[]; expectedTermOccurrences: ExpectedTermOccurrence[]};
    assert.deepEqual(payload.stableTerms, input.stableTerms.map(withoutAudit));
    assert.deepEqual(payload.expectedTermOccurrences, full.map(withoutAudit));
    assert.deepEqual(prepared.expectedTermOccurrences, full);
    assert.ok(prepared.expectedTermOccurrences.every((item) => item.renderFingerprint.length === 64));
    assert.ok(!section.text.includes(input.stableTerms[0]!.revisionId!));
    assert.ok(!section.text.includes(input.stableTerms[0]!.renderFingerprint!));
    assert.equal(JSON.stringify(input), before);
  });
}

test("budget assessment uses compact wire terms rather than the full audit records", () => {
  const input = fixture();
  const seenJson: unknown[] = [];
  const budgeter = new RequestBudgeter({
    estimateText: (text) => ({tokens: text.length, uncertaintyTokens: 0}),
    estimateJson: (value) => { seenJson.push(value); return {tokens: JSON.stringify(value).length, uncertaintyTokens: 0}; },
  }, {contextWindowTokens: 100_000, outputTokens: 100, reasoningReserveTokens: 0, safetyMarginTokens: 0});
  const assessment = budgeter.assess(input);
  assert.equal(assessment.fits, true);
  const terms = seenJson.find((value) => typeof value === "object" && value !== null && "stableTerms" in value);
  assert.ok(terms);
  assert.ok(!JSON.stringify(terms).includes(input.stableTerms[0]!.revisionId!));
});

test("terminology-rich wire shrinks without pruning any term or rendering field", (t) => {
  const input = fixture();
  const terms: StableTerm[] = [...input.stableTerms];
  for (let index = 0; index < 199; index++) {
    const sourceForm = `SyntheticName${index}`;
    const concept = conceptFromAnchor({sourceForm, target: `译名${index}`, mode: "stable",
      semanticClass: "proper_name", confidence: 0.99});
    terms.push({conceptId: concept.conceptId, lexemeId: `${concept.conceptId}-form`,
      sourceForm, canonicalSource: sourceForm, target: concept.canonicalTarget,
      locked: false, policy: concept.policy, semanticClass: concept.semanticClass,
      allowedTargets: concept.allowedRealizations, revisionId: concept.revisionId,
      renderFingerprint: concept.renderFingerprint});
  }
  input.stableTerms = terms;
  const prepared = prepareTranslationRequest(input);
  const section = prepared.sections.find((item) => item.kind === "terms")!;
  const legacyText = ["STABLE TERMS", JSON.stringify(terms), "UNRESOLVED ENTITY LINKS",
    "[]", "TERM OCCURRENCES", JSON.stringify(prepared.expectedTermOccurrences)].join("\n\n");
  const oldBytes = Buffer.byteLength(legacyText, "utf8");
  const newBytes = Buffer.byteLength(section.text, "utf8");
  const legacyPrompt = prepared.sections.map((item) => item.kind === "terms" ? legacyText : item.text).join("\n\n");
  assert.ok(newBytes < oldBytes * 0.8);
  const payload = section.jsonPayload as {stableTerms: StableTerm[]};
  assert.deepEqual(payload.stableTerms, terms.map(withoutAudit));
  assert.equal(payload.stableTerms.length, 200);
  t.diagnostic(JSON.stringify({terms: 200, oldTermsBytes: oldBytes, compactTermsBytes: newBytes,
    reductionPercent: Math.round((1 - newBytes / oldBytes) * 1000) / 10,
    oldPromptBytes: Buffer.byteLength(legacyPrompt, "utf8"),
    compactPromptBytes: Buffer.byteLength(prepared.prompt, "utf8")}));
});

test("terms without revision metadata retain their exact model-visible fields", () => {
  const input = fixture();
  input.stableTerms = input.stableTerms.map(withoutAudit);
  const prepared = prepareTranslationRequest(input);
  const payload = prepared.sections.find((item) => item.kind === "terms")!.jsonPayload as {stableTerms: StableTerm[]};
  assert.deepEqual(payload.stableTerms, input.stableTerms);
});
