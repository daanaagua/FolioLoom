import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { toInternalThinking } from "../providers/registry.js";
import type { ProviderEffort } from "../providers/types.js";

const PROVIDER_EFFORTS = [
  "off",
  "on",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ProviderEffort[];

const FAST_EFFORT_PREFERENCE: readonly ProviderEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "on",
  "high",
  "xhigh",
  "max",
];

export function isProviderEffort(value: string): value is ProviderEffort {
  return (PROVIDER_EFFORTS as readonly string[]).includes(value);
}

/** Return the cheapest effort that the selected provider explicitly permits. */
export function lowestLegalFastEffort(
  supportedEfforts: readonly string[],
): ProviderEffort | undefined {
  const supported = new Set(supportedEfforts.filter(isProviderEffort));
  return FAST_EFFORT_PREFERENCE.find((candidate) => supported.has(candidate));
}

/** `off` is a real execution choice, never an omitted default. */
export function explicitThinkingLevel(effort: ProviderEffort | undefined): ThinkingLevel {
  return effort === undefined || effort === "off"
    ? "off"
    : toInternalThinking(effort) ?? "off";
}
