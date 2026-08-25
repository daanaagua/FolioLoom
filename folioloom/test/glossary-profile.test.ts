import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadGlossary,
  relevantGlossaryTerms,
} from "../src/glossary/glossary-profile.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import type { LosslessBlock } from "../src/source/types.js";

function block(globalIndex: number, sourceText: string): LosslessBlock {
  return {
    id: `block-${globalIndex}`,
    sourceVersion: "source-v1",
    canonicalStart: globalIndex * 100,
    canonicalEnd: globalIndex * 100 + sourceText.length,
    sourceText,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    globalIndex,
    tokenCount: 4,
    structureId: null,
    structureTitle: null,
  };
}

function writeGlossary(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-glossary-"));
  const path = join(directory, "glossary.json");
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

const profile = getSourceLanguageProfile("en");

test("loads simple and structured glossary entries with aliases and local evidence", () => {
  const glossary = loadGlossary({
    glossaryPath: writeGlossary({
      "Typhon": "提丰",
      "Piaton": "皮亚顿",
    }),
    blocks: [
      block(0, "Typhon's second head watched Piaton."),
      block(1, "Piaton moved without speaking."),
    ],
    profile,
  });

  assert.equal(glossary.report.schema, "folioloom-glossary-report-1");
  assert.equal(glossary.report.totalTerms, 2);
  assert.equal(glossary.report.totalForms, 2);
  assert.equal(glossary.report.matchedTerms, 2);
  assert.equal(glossary.report.terms.find((term) => term.source === "Typhon")?.occurrenceCount, 1);
  assert.deepEqual(
    glossary.report.terms.find((term) => term.source === "Piaton")?.globalIndexes,
    [0, 1],
  );
  assert.equal(glossary.stableTerms.find((term) => term.sourceForm === "Typhon")?.policy, "preferred");

  const rich = loadGlossary({
    glossaryPath: writeGlossary({
      schema: "folioloom-glossary-1",
      terms: [{
        source: "Archon",
        target: "执政官",
        kind: "title",
        policy: "contextual",
        forms: ["the Archon"],
        note: "直接呼告时可按中文句法处理。",
      }],
    }),
    blocks: [block(0, "The Archon spoke. Archon, I beg you.")],
    profile,
  });

  assert.equal(rich.stableTerms.length, 2);
  assert.deepEqual(
    rich.stableTerms.map((term) => term.sourceForm),
    ["Archon", "the Archon"],
  );
  assert.ok(rich.stableTerms.every((term) => term.policy === "contextual"));
  assert.ok(rich.stableTerms.every((term) => term.note?.includes("直接呼告")));
});

test("matches profile token sequences, not arbitrary substrings", () => {
  const glossary = loadGlossary({
    glossaryPath: writeGlossary({
      schema: "folioloom-glossary-1",
      terms: [
        { source: "art", target: "艺术", policy: "preferred" },
        { source: "New Sun", target: "新日", policy: "locked" },
      ],
    }),
    blocks: [
      block(0, "The party began beneath a New Sun."),
      block(1, "Art outlasts wars."),
    ],
    profile,
  });

  assert.equal(glossary.report.terms.find((term) => term.source === "art")?.occurrenceCount, 1);
  assert.deepEqual(
    glossary.report.terms.find((term) => term.source === "New Sun")?.globalIndexes,
    [0],
  );
  assert.deepEqual(
    relevantGlossaryTerms(glossary, [0]).map((term) => term.sourceForm),
    ["New Sun"],
  );
  assert.deepEqual(
    relevantGlossaryTerms(glossary, [1]).map((term) => term.sourceForm),
    ["art"],
  );
});

test("hashes semantic glossary content deterministically and rejects ambiguous input", () => {
  const common = {
    blocks: [block(0, "Severian met Typhon.")],
    profile,
  };
  const first = loadGlossary({
    ...common,
    glossaryPath: writeGlossary({
      schema: "folioloom-glossary-1",
      terms: [
        { source: "Typhon", target: "提丰", forms: ["Typhon's"], policy: "locked" },
        { source: "Severian", target: "塞万里安", policy: "preferred" },
      ],
    }),
  });
  const second = loadGlossary({
    ...common,
    glossaryPath: writeGlossary({
      terms: [
        { policy: "preferred", target: "塞万里安", source: "Severian" },
        { forms: ["Typhon's"], target: "提丰", policy: "locked", source: "Typhon" },
      ],
      schema: "folioloom-glossary-1",
    }),
  });

  assert.equal(first.hash, second.hash);
  assert.throws(() => loadGlossary({
    ...common,
    glossaryPath: writeGlossary({
      schema: "folioloom-glossary-1",
      terms: [
        { source: "Typhon", target: "提丰" },
        { source: "typhon", target: "泰丰" },
      ],
    }),
  }), /duplicate normalized glossary form/i);
  assert.throws(() => loadGlossary({
    ...common,
    existingStableTerms: [{
      conceptId: "legacy-typhon",
      lexemeId: "legacy-typhon-form",
      sourceForm: "Typhon",
      canonicalSource: "Typhon",
      target: "泰丰",
      locked: true,
    }],
    glossaryPath: writeGlossary({ Typhon: "提丰" }),
  }), /glossary conflicts with existing stable term/i);
  assert.throws(() => loadGlossary({
    ...common,
    existingStableTerms: [{
      conceptId: "legacy-typhon-conflict",
      lexemeId: "legacy-typhon-conflict-form",
      sourceForm: "Typhon",
      canonicalSource: "Typhon",
      target: "泰丰",
      locked: true,
    }, {
      conceptId: "legacy-typhon-match",
      lexemeId: "legacy-typhon-match-form",
      sourceForm: "Typhon",
      canonicalSource: "Typhon",
      target: "提丰",
      locked: true,
    }],
    glossaryPath: writeGlossary({ Typhon: "提丰" }),
  }), /glossary conflicts with existing stable term/i);
});
