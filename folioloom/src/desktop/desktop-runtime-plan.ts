import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { TranslationRuntime, TranslationRuntimeSet } from "../fullbook/types.js";
import { validateRuntimeVariants } from "../fullbook/optimization-policy.js";
import type { ModelProfile, ProviderEffort } from "../providers/types.js";
import type { DesktopTrialMode } from "./contracts.js";
import {
  explicitThinkingLevel,
  isProviderEffort,
  lowestLegalFastEffort,
} from "./trial-runtime-policy.js";

export class DesktopRuntimePlanError extends Error {
  readonly code = "DESKTOP_RUNTIME_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "DesktopRuntimePlanError";
  }
}

export interface DesktopTranslationRuntime {
  profile: ModelProfile;
  model: Model<any>;
  streamFn: StreamFn;
  supportedEfforts: readonly ProviderEffort[];
  createWithProfile(profile: ModelProfile): DesktopTranslationRuntime;
}

export interface DesktopRuntimeResolver {
  resolve(): Promise<DesktopTranslationRuntime | undefined>;
}

export interface NormalizedDesktopModelProfile {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  customBaseUrl?: string;
}

export interface DesktopRuntimeFingerprint {
  schema: "folioloom-desktop-runtime-1";
  mode: DesktopTrialMode;
  primary: NormalizedDesktopModelProfile;
  escalation: NormalizedDesktopModelProfile;
}

export interface DesktopRuntimePlan {
  runtimeSet: TranslationRuntimeSet;
  fingerprint: DesktopRuntimeFingerprint;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DesktopRuntimePlanError(`${label} must be non-empty`);
  }
  return value.trim();
}

function normalizedModelProfile(
  raw: ModelProfile,
  label = "active",
): NormalizedDesktopModelProfile {
  return {
    providerId: nonempty(raw?.providerId, `${label} provider id`),
    modelId: nonempty(raw?.modelId, `${label} model id`),
    ...(raw?.reasoningEffort === undefined ? {} : {
      reasoningEffort: nonempty(raw.reasoningEffort, `${label} reasoning effort`),
    }),
    ...(raw?.customBaseUrl === undefined ? {} : {
      customBaseUrl: nonempty(raw.customBaseUrl, `${label} custom base URL`),
    }),
  };
}

function normalizedProfile(
  runtime: DesktopTranslationRuntime,
): NormalizedDesktopModelProfile {
  const profile = normalizedModelProfile(runtime.profile);
  if (runtime.model === undefined || runtime.model.id !== profile.modelId) {
    throw new DesktopRuntimePlanError(
      "active model profile does not match the resolved translation runtime",
    );
  }
  if (typeof runtime.streamFn !== "function") {
    throw new DesktopRuntimePlanError(
      "active translation runtime has no stream function",
    );
  }
  return profile;
}

function profileWithEffort(
  profile: ModelProfile,
  effort: ProviderEffort | undefined,
): ModelProfile {
  return {
    providerId: profile.providerId,
    modelId: profile.modelId,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(profile.customBaseUrl === undefined ? {} : {
      customBaseUrl: profile.customBaseUrl,
    }),
  };
}

function sameProfile(
  left: NormalizedDesktopModelProfile,
  right: NormalizedDesktopModelProfile,
): boolean {
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.reasoningEffort === right.reasoningEffort
    && left.customBaseUrl === right.customBaseUrl;
}

function translationRuntime(
  runtime: DesktopTranslationRuntime,
): TranslationRuntime {
  return {
    model: runtime.model,
    streamFn: runtime.streamFn,
    ...(runtime.profile.reasoningEffort === undefined ? {} : {
      effort: runtime.profile.reasoningEffort,
    }),
    thinkingLevel: explicitThinkingLevel(runtime.profile.reasoningEffort),
  };
}

function requireSupportedEfforts(
  runtime: DesktopTranslationRuntime,
): readonly ProviderEffort[] {
  if (!Array.isArray(runtime.supportedEfforts)
    || runtime.supportedEfforts.some((effort) => !isProviderEffort(effort))) {
    throw new DesktopRuntimePlanError(
      "active translation runtime has invalid provider effort capabilities",
    );
  }
  return runtime.supportedEfforts;
}

function derivedRuntime(
  qualityRuntime: DesktopTranslationRuntime,
  profile: ModelProfile,
): DesktopTranslationRuntime {
  if (typeof qualityRuntime.createWithProfile !== "function") {
    throw new DesktopRuntimePlanError(
      "active translation runtime cannot derive a provider-safe effort projection",
    );
  }
  const derived = qualityRuntime.createWithProfile(profile);
  const expected = normalizedModelProfile(profile, "derived");
  const actual = normalizedProfile(derived);
  if (!sameProfile(actual, expected)) {
    throw new DesktopRuntimePlanError(
      "derived translation runtime does not match the requested provider profile",
    );
  }
  return derived;
}

export function buildDesktopRuntimePlan(
  mode: DesktopTrialMode,
  qualityRuntime: DesktopTranslationRuntime,
): DesktopRuntimePlan {
  if (mode !== "quality" && mode !== "fast") {
    throw new DesktopRuntimePlanError("desktop runtime mode must be quality or fast");
  }
  const qualityProfile = normalizedProfile(qualityRuntime);
  const quality = translationRuntime(qualityRuntime);
  const supportedEfforts = requireSupportedEfforts(qualityRuntime);
  const candidateEfforts = new Set<ProviderEffort | undefined>([
    ...supportedEfforts,
    qualityRuntime.profile.reasoningEffort,
  ]);
  const variants = validateRuntimeVariants([...candidateEfforts].map((effort) => {
    if (effort === qualityRuntime.profile.reasoningEffort) {
      return quality;
    }
    return translationRuntime(derivedRuntime(
      qualityRuntime,
      profileWithEffort(qualityRuntime.profile, effort),
    ));
  }));
  if (mode === "quality") {
    return {
      runtimeSet: {
        mode,
        primary: quality,
        escalation: quality,
        variants,
      },
      fingerprint: {
        schema: "folioloom-desktop-runtime-1",
        mode,
        primary: qualityProfile,
        escalation: qualityProfile,
      },
    };
  }

  const primaryEffort = lowestLegalFastEffort(supportedEfforts);
  const primaryProfile = profileWithEffort(qualityRuntime.profile, primaryEffort);
  const primaryRuntime = primaryEffort === qualityRuntime.profile.reasoningEffort
    ? qualityRuntime
    : derivedRuntime(qualityRuntime, primaryProfile);
  const primary = translationRuntime(primaryRuntime);
  return {
    runtimeSet: {
      mode,
      primary,
      escalation: quality,
      variants,
    },
    fingerprint: {
      schema: "folioloom-desktop-runtime-1",
      mode,
      primary: normalizedProfile(primaryRuntime),
      escalation: qualityProfile,
    },
  };
}

export function serializeDesktopRuntimeFingerprint(
  value: DesktopRuntimeFingerprint,
): string {
  return JSON.stringify(value);
}
