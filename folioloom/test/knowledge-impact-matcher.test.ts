import assert from "node:assert/strict";
import test from "node:test";

import {
  matchKnowledgeImpacts,
} from "../src/knowledge/knowledge-impact-matcher.js";
import { getSourceLanguageProfile } from "../src/language/profiles.js";
import type { SourceLanguageProfile } from "../src/language/types.js";

test("batch impact matching scans and segments every translated block only once", () => {
  const base = getSourceLanguageProfile("en");
  let normalizedBlocks = 0;
  let segmentedBlocks = 0;
  const blockTexts = new Set(
    Array.from({ length: 25 }, (_, index) =>
      `This translated block mentions Term${index * 4}.`),
  );
  const profile: SourceLanguageProfile = {
    ...base,
    normalizeSourceLiteral(text) {
      if (blockTexts.has(text)) normalizedBlocks += 1;
      return base.normalizeSourceLiteral(text);
    },
    segment(text) {
      if (blockTexts.has(text)) segmentedBlocks += 1;
      return base.segment(text);
    },
  };
  const revisions = Array.from({ length: 100 }, (_, index) => ({
    revisionId: `revision-${index}`,
    forms: [`Term${index}`],
  }));
  const blocks = [...blockTexts].map((sourceText, index) => ({
    sourceVersion: "source",
    blockId: `block-${index}`,
    sourceText,
  }));

  const matches = matchKnowledgeImpacts(revisions, blocks, profile);

  assert.equal(normalizedBlocks, blocks.length);
  assert.equal(segmentedBlocks, blocks.length);
  assert.equal(matches.length, blocks.length);
  assert.deepEqual(matches[0], {
    revisionId: "revision-0",
    sourceVersion: "source",
    blockId: "block-0",
  });
  assert.deepEqual(matches.at(-1), {
    revisionId: "revision-96",
    sourceVersion: "source",
    blockId: "block-24",
  });
});

test("batch impact matching preserves word boundaries while matching CJK forms", () => {
  const english = matchKnowledgeImpacts(
    [{ revisionId: "arch", forms: ["arch"] }],
    [{
      sourceVersion: "source",
      blockId: "english",
      sourceText: "The archon crossed an arch.",
    }],
    getSourceLanguageProfile("en"),
  );
  assert.deepEqual(english, [{
    revisionId: "arch",
    sourceVersion: "source",
    blockId: "english",
  }]);

  const korean = matchKnowledgeImpacts(
    [{ revisionId: "mukhyang", forms: ["묵향"] }],
    [{
      sourceVersion: "source",
      blockId: "korean",
      sourceText: "그는 묵향이라는 이름으로 불렸다.",
    }],
    getSourceLanguageProfile("ko"),
  );
  assert.deepEqual(korean, [{
    revisionId: "mukhyang",
    sourceVersion: "source",
    blockId: "korean",
  }]);
});

test("batch impact matching rejects short forms embedded inside longer words", () => {
  const matches = matchKnowledgeImpacts(
    [{ revisionId: "ai", forms: ["AI"] }],
    [{
      sourceVersion: "source",
      blockId: "embedded-only",
      sourceText: "The claim was appraised while she waits beside the main airlock.",
    }, {
      sourceVersion: "source",
      blockId: "standalone",
      sourceText: "The shipboard AI answered.",
    }],
    getSourceLanguageProfile("en"),
  );

  assert.deepEqual(matches, [{
    revisionId: "ai",
    sourceVersion: "source",
    blockId: "standalone",
  }]);
});

test("knowledge impacts preserve declared possessive source-form boundaries", () => {
  const matches = matchKnowledgeImpacts([{
    revisionId: "revision-earth-possessive",
    forms: ["EARTH’S"],
  }], [{
    sourceVersion: "source",
    blockId: "block-base",
    sourceText: "Earth is distant.",
  }, {
    sourceVersion: "source",
    blockId: "block-possessive",
    sourceText: "Earth's orbit is changing.",
  }], getSourceLanguageProfile("en"));

  assert.deepEqual(matches, [{
    revisionId: "revision-earth-possessive",
    sourceVersion: "source",
    blockId: "block-possessive",
  }]);
});
