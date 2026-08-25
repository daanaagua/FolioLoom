import type {
  DiscourseMode,
  EffectiveStyle,
  EffectiveStyleProjection,
} from "./types.js";

const MODE_RULES: Readonly<Record<DiscourseMode, string>> = {
  narrative: "叙述：维持视角、时态与信息显隐，不替叙述者解释。",
  dialogue: "对白：按人物关系处理称呼与语气，避免机械直译。",
  action: "动作：保持动作链、空间关系与节奏清晰。",
  description: "描写：保留感官次序、意象联系和句子呼吸。",
  technical: "技术说明：概念、数量和因果优先准确，中文表达自然清楚。",
  documentary: "文献体：保留条目、引文、记录或公文的体裁信号。",
  lyrical: "抒情：保留音调、复现意象与含蓄，不滥加华辞。",
  interior: "内心：保留意识转折、犹疑和未说尽之处。",
};

export function projectEffectiveStyle(
  style: EffectiveStyle,
  options: { maxChars?: number } = {},
): EffectiveStyleProjection {
  const maxChars = options.maxChars ?? 1_200;
  if (!Number.isSafeInteger(maxChars) || maxChars < 300) {
    throw new TypeError("style projection maxChars must be a safe integer of at least 300");
  }
  const modeRules = style.topModes.map((mode) => MODE_RULES[mode]);
  const lines = [
    `全书文体宪章 v${style.constitution.version}（不可被局部样例改写）`,
    `基调：${style.constitution.register}`,
    `句法：${style.constitution.sentencePolicy}`,
    `显化：${style.constitution.explicitation}`,
    `意象：${style.constitution.imagery}`,
    `对白：${style.constitution.dialogue}`,
    `技术文：${style.constitution.technicalProse}`,
    `排版：${style.constitution.typography}`,
    ...(style.constitution.additionalInstruction.length === 0
      ? []
      : [`用户附加文风要求：${style.constitution.additionalInstruction}`]),
    `当前声音 ${style.voice.voiceId}：${style.voice.instruction}`,
    ...modeRules,
    ...style.local.registers.map((item) => `近期语域：${item.value}`),
    ...style.local.rhythms.map((item) => `近期节奏：${item.value}`),
    ...style.local.addressChoices.map((item) => `称呼：${item.subject} → ${item.target}`),
    ...style.local.lexicalChoices.map((item) => `措辞：${item.source} → ${item.target}`),
    ...style.local.continuityNotes.map((item) => `连续性：${item.value}`),
    ...style.examples.map((example) => `兼容短例：${example}`),
  ];
  let text = "";
  for (const line of lines) {
    const next = text.length === 0 ? line : `${text}\n${line}`;
    if (next.length > maxChars) {
      break;
    }
    text = next;
  }
  return {
    schemaVersion: "v5-effective-style-1",
    constitutionVersion: style.constitution.version,
    voiceId: style.voice.voiceId,
    modeWeights: structuredClone(style.modeWeights),
    modeRules,
    examples: [...style.examples],
    text,
  };
}
