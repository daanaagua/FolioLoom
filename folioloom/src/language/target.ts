export const DEFAULT_TARGET_LANGUAGE = Object.freeze({
  id: "zh-Hans",
  displayName: "Simplified Chinese",
});

export const SIMPLIFIED_CHINESE_SCRIPT_REQUIREMENT =
  "Use simplified Chinese characters consistently in translated prose; preserve a non-simplified form only when an explicit locked target requires it.";

export function targetLanguageLabel(): string {
  return `${DEFAULT_TARGET_LANGUAGE.displayName} (${DEFAULT_TARGET_LANGUAGE.id})`;
}
