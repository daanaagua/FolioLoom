import type { InternalThinkingLevel, ModelProfile, ProviderEffort } from "./types.js";

/** Pure mappings shared with the renderer; this module must not import network or Node APIs. */
export function toInternalThinking(effort: ProviderEffort): InternalThinkingLevel | undefined {
  switch (effort) {
    case "off": return undefined;
    case "on": return "high";
    case "max": return "xhigh";
    case "minimal": case "low": case "medium": case "high": case "xhigh": return effort;
  }
}

export function toProviderEffort(internal: InternalThinkingLevel, profile: Pick<ModelProfile, "reasoningEffort">): ProviderEffort | undefined {
  const raw = profile.reasoningEffort;
  return raw === undefined || raw === "off" || toInternalThinking(raw) !== internal ? undefined : raw;
}
