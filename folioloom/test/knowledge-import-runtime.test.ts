import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  prepareTranslationRequest,
} from "../src/agents/translation-request.js";
import {
  stableTermsFromKnowledge,
} from "../src/knowledge/stable-terms-from-knowledge.js";
import { conceptFromAnchor } from "../src/knowledge/lexical-concept.js";
import {
  persistedStyleFromKnowledge,
} from "../src/knowledge/persisted-style.js";
import {
  normalizeImportRecord,
  type NormalizedImportRecord,
} from "../src/knowledge-import/record-normalizer.js";
import {
  inspectJson,
  readStructuredRecords,
} from "../src/knowledge-import/json-yaml-reader.js";
import { suggestMapping } from "../src/knowledge-import/field-mapping.js";
import type {
  ImportFieldMapping,
  ImportRecordSource,
} from "../src/knowledge-import/types.js";
import type {
  KnowledgeObjectType,
} from "../src/knowledge/knowledge-commands.js";
import type {
  KnowledgeRevision,
} from "../src/knowledge/knowledge-store.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import type { LosslessBlock } from "../src/source/types.js";

function mapping(targetField: string, sourceColumn = targetField): ImportFieldMapping {
  return {
    targetField,
    sourceColumn,
    confidence: "high",
    confirmed: true,
  };
}

function imported(
  objectType: KnowledgeObjectType,
  values: ImportRecordSource["values"],
  fields: Readonly<Record<string, ImportFieldMapping>>,
  ordinal: number,
): NormalizedImportRecord {
  return normalizeImportRecord({
    record: {
      ordinal,
      location: `row ${ordinal + 1}`,
      values,
    },
    selection: {
      objectType,
      scope: "book",
      recordPathId: "record-path:1",
    },
    fields,
    importBatchId: "batch-runtime",
  });
}

function revision(
  normalized: NormalizedImportRecord,
): KnowledgeRevision {
  const payload = normalized.command.fieldPatch;
  return {
    revisionId: `revision-${normalized.ordinal}`,
    revision: 1,
    normalizedSubject: normalized.command.normalizedSubject,
    kind: normalized.command.kind,
    payload,
    alternatives: [payload],
    status: "active",
    candidateIds: [],
    sourceWindowIds: [],
    authority: {
      origin: "import",
      scope: "book",
      ownedFields: normalized.command.ownedFields,
    },
  };
}

function block(id: string, globalIndex: number, sourceText: string): LosslessBlock {
  return {
    id,
    sourceVersion: "source-v1",
    canonicalStart: globalIndex * 100,
    canonicalEnd: globalIndex * 100 + sourceText.length,
    sourceText,
    sourceHash: createHash("sha256").update(sourceText).digest("hex"),
    globalIndex,
    tokenCount: 20,
    structureId: null,
    structureTitle: null,
  };
}

test("official term, style, and positioned memory imports all reach the translation request", async () => {
  const officialInspection = await inspectJson({
    schema: "folioloom-knowledge-import-1",
    objectType: "term",
    scope: "book",
    records: [{ source: "Archon", target: "执政官", policy: "preferred" }],
  });
  const officialPath = officialInspection.officialTemplate?.recordPathId;
  assert.ok(officialPath);
  const officialRecords = await readStructuredRecords(officialInspection, officialPath);
  const officialMapping = suggestMapping({
    objectType: "term",
    scope: "book",
    columns: Object.keys(officialRecords[0]!.values),
    sample: officialRecords,
    format: "json",
    selection: { recordPathId: officialPath },
    templateVersion: officialInspection.officialTemplate?.schema,
  });
  const term = normalizeImportRecord({
    record: officialRecords[0]!,
    selection: officialMapping.selection,
    fields: officialMapping.fields,
    importBatchId: "batch-runtime",
  });
  const style = imported("style", {
    register: "克制、庄重而清晰",
    narrativeDistance: "保持疏离的回忆距离",
    dialogueRegister: "正式场合克制，私下自然",
  }, {
    register: mapping("register"),
    narrativeDistance: mapping("narrativeDistance"),
    dialogueRegister: mapping("dialogueRegister"),
  }, 2);
  const memory = imported("memory", {
    summary: "皮亚顿仍控制着这具身体的心跳。",
    startBlockId: "block-1",
    endBlockId: "block-2",
  }, {
    summary: mapping("summary"),
    startBlockId: mapping("startBlockId"),
    endBlockId: mapping("endBlockId"),
  }, 3);
  const revisions = [term, style, memory].map(revision);
  const blocks = [
    block("block-0", 0, "A silent antechamber."),
    block("block-1", 1, "The Archon entered."),
    block("block-2", 2, "The audience ended."),
  ];
  const prepared = prepareTranslationRequest({
    request: {
      requestId: "request-import-runtime",
      sourceTokens: 20,
      windows: [{
        windowId: "window-import-runtime",
        ordinal: 1,
        chapterId: "chapter-0",
        chapterTitle: null,
        blockIds: ["block-1"],
        globalIndexes: [1],
        sourceTokens: 20,
        sourceChars: blocks[1]!.sourceText.length,
        oversized: false,
      }],
    },
    blocks,
    stableTerms: stableTermsFromKnowledge(revisions),
    snapshot: { id: "snapshot-import-runtime", revisions },
    styleState: persistedStyleFromKnowledge(revisions),
    sourceLanguageProfile: getSourceLanguageProfile("en"),
  });

  const terms = prepared.sections.find((section) => section.kind === "terms")
    ?.jsonPayload as { stableTerms: readonly { sourceForm: string; target: string; locked: boolean; policy?: string }[] };
  assert.deepEqual(terms.stableTerms.map((item) => ({
    sourceForm: item.sourceForm,
    target: item.target,
    locked: item.locked,
    policy: item.policy,
  })), [{
    sourceForm: "Archon",
    target: "执政官",
    locked: false,
    policy: "preferred",
  }]);
  assert.match(prepared.prompt, /克制、庄重而清晰/u);
  assert.match(prepared.prompt, /保持疏离的回忆距离/u);
  assert.match(prepared.prompt, /正式场合克制[,，]私下自然/u);
  assert.match(prepared.prompt, /皮亚顿仍控制着这具身体的心跳/u);
});

test("stable terms from knowledge project a closed contextual lexical concept", () => {
  const concept = conceptFromAnchor({
    sourceForm: "Prokurist",
    target: "主事",
    mode: "contextual",
    semanticClass: "role",
    confidence: 0.95,
    allowedRealizations: ["主事", "公司代表"],
  });
  const terms = stableTermsFromKnowledge([{
    revisionId: concept.revisionId,
    revision: 1,
    normalizedSubject: concept.normalizedSubject,
    kind: "lexical_concept",
    payload: concept,
    alternatives: [concept],
    status: "active",
    candidateIds: [],
    sourceWindowIds: [],
  } satisfies KnowledgeRevision]);

  assert.deepEqual(terms.map((term) => ({
    sourceForm: term.sourceForm,
    canonicalSource: term.canonicalSource,
    target: term.target,
    policy: term.policy,
    semanticClass: term.semanticClass,
    allowedTargets: term.allowedTargets,
    revisionId: term.revisionId,
    renderFingerprint: term.renderFingerprint,
  })), [{
    sourceForm: "Prokurist",
    canonicalSource: "prokurist",
    target: "主事",
    policy: "contextual",
    semanticClass: "role",
    allowedTargets: ["主事", "公司代表"],
    revisionId: concept.revisionId,
    renderFingerprint: concept.renderFingerprint,
  }]);
});
