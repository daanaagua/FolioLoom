import assert from "node:assert/strict";
import test from "node:test";

import {
  composeEffectiveStyle,
  createBookStyleConstitution,
  extractDiscourseModeWeights,
} from "../src/style/effective-style.js";
import { createStyleObservation } from "../src/style/style-observation.js";
import { projectEffectiveStyle } from "../src/style/style-projection.js";
import type { VoiceProfile } from "../src/style/types.js";

test("default book typography explicitly selects simplified Chinese", () => {
  assert.match(createBookStyleConstitution().typography, /简体中文/u);
});

test("structured style keeps the book constitution immutable while local evidence decays", () => {
  const constitution = createBookStyleConstitution({
    register: "典雅、克制，不使用网络流行语",
    sentencePolicy: "保留长句的逻辑层次，必要时自然拆分",
    explicitation: "不替原文消除有意歧义",
    imagery: "保留意象之间的陌生联系",
    dialogue: "对白自然，但不把人物说话改成现代段子",
    technicalProse: "科学说明优先准确和清楚",
    typography: "使用规范中文引号与标点",
  });
  const original = structuredClone(constitution);
  const voices: VoiceProfile[] = [{
    voiceId: "narrator",
    scope: "main_narrator",
    instruction: "冷静的第一人称回顾口吻",
    confidence: 1,
  }];
  const observations = [createStyleObservation({
    windowId: "w1",
    ordinal: 1,
    sourceText: "He said, “Wait.”",
    translations: ["他说：“等等。”"],
    submission: {
      voiceId: "narrator",
      activeRegister: "冷静克制",
      rhythm: "短句后接停顿",
      addressChoices: [{ subject: "Archon", target: "阁下" }],
      lexicalChoices: [{ source: "scape", target: "拟景" }],
      continuityNotes: ["叙述者仍在隐瞒恐惧"],
    },
  }), createStyleObservation({
    windowId: "old",
    ordinal: 0,
    sourceText: "Old text.",
    translations: ["一段过远的旧译文。"],
    submission: { activeRegister: "已经过期" },
  })];

  const effective = composeEffectiveStyle({
    constitution,
    voices,
    observations,
    currentOrdinal: 3,
    sourceText: "“Archon,” she said. The value was x = 3.14.",
    defaultVoiceId: "narrator",
    localTtl: 3,
  });

  assert.deepEqual(constitution, original);
  assert.equal(effective.voice.voiceId, "narrator");
  assert.ok(effective.modeWeights.dialogue > 0);
  assert.ok(effective.modeWeights.technical > 0);
  assert.ok(effective.local.addressChoices.some((choice) => choice.target === "阁下"));
  assert.ok(!effective.local.registers.some((item) => item.value === "已经过期"));
});

test("source features produce mixed normalized discourse weights instead of one rigid label", () => {
  const weights = extractDiscourseModeWeights(
    "“Observe,” she said. The measured ratio was x = 3.14 (n = 8).",
  );

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(weights.dialogue > 0.1);
  assert.ok(weights.technical > 0.1);
  assert.ok(weights.narrative > 0);
});

test("effective style projection is bounded and selects only compatible accepted examples", () => {
  const constitution = createBookStyleConstitution({ register: "文学、准确、隽永" });
  const observations = [
    createStyleObservation({
      windowId: "dialogue",
      ordinal: 4,
      sourceText: "“Come here,” he said.",
      translations: ["“到这里来，”他说。"],
      submission: { voiceId: "narrator" },
    }),
    createStyleObservation({
      windowId: "technical",
      ordinal: 5,
      sourceText: "The orbit has eccentricity 0.2.",
      translations: ["该轨道的偏心率为零点二。"],
      submission: { voiceId: "document" },
    }),
    createStyleObservation({
      windowId: "rejected",
      ordinal: 6,
      sourceText: "“Bad.”",
      translations: ["这段不应出现。"],
      accepted: false,
      submission: { voiceId: "narrator" },
    }),
  ];
  const effective = composeEffectiveStyle({
    constitution,
    voices: [{
      voiceId: "narrator",
      scope: "main_narrator",
      instruction: "克制叙述",
      confidence: 1,
    }],
    observations,
    currentOrdinal: 7,
    sourceText: "“Will you come?” she asked.",
    defaultVoiceId: "narrator",
  });
  const projection = projectEffectiveStyle(effective, { maxChars: 900 });

  assert.ok(projection.text.length <= 900);
  assert.ok(projection.examples.length <= 2);
  assert.ok(projection.examples.some((example) => example.includes("到这里来")));
  assert.ok(!projection.examples.some((example) => example.includes("偏心率")));
  assert.ok(!projection.text.includes("这段不应出现"));
  assert.ok(projection.modeRules.length <= 2);
});

test("effective style projects a user additional instruction without replacing the constitution", () => {
  const constitution = createBookStyleConstitution({
    register: "准确、克制",
    additionalInstruction: "对白避免网络流行语",
  });
  const projection = projectEffectiveStyle(composeEffectiveStyle({
    constitution,
    voices: [{
      voiceId: "narrator",
      scope: "main_narrator",
      instruction: "保持叙述距离",
      confidence: 1,
    }],
    observations: [],
    currentOrdinal: 0,
    sourceText: "A short source paragraph.",
    defaultVoiceId: "narrator",
  }));

  assert.match(projection.text, /用户附加文风要求：对白避免网络流行语/u);
  assert.match(projection.text, /基调：准确、克制/u);
});
