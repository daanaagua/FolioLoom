import {
  type DesktopCapabilityReport,
  type DesktopProviderRegistry,
  type DesktopRegisteredProvider,
} from "../desktop-model-service.js";
import type { DesktopModelPreference } from "../desktop-preferences.js";
import { probeProviderCapabilities } from "../../providers/capability-probe.js";
import { ProviderRegistry, providerRegistry } from "../../providers/registry.js";
import type { ModelProfile, ProviderId } from "../../providers/types.js";

const RETRYABLE_PROBE_CODES = new Set([
  "RATE_LIMITED",
  "PROVIDER_BUSY",
  "REQUEST_TIMEOUT",
  "PROVIDER_UNREACHABLE",
]);

function providerId(value: string): ProviderId {
  return value as ProviderId;
}

function resolvedProfile(
  registry: ProviderRegistry,
  profile: ModelProfile,
): ModelProfile {
  const definition = registry.get(profile.providerId);
  if (profile.customBaseUrl !== undefined && !definition.allowCustomBaseUrl) {
    throw new TypeError("customBaseUrl is only supported by the custom OpenAI-compatible provider");
  }
  return registry.resolve(profile).profile;
}

function discoveryProfile(
  registry: ProviderRegistry,
  request: Pick<DesktopModelPreference, "providerId" | "customBaseUrl">,
): ModelProfile {
  const id = providerId(request.providerId);
  const definition = registry.get(id);
  return resolvedProfile(registry, {
    providerId: id,
    // Model discovery has no selected model yet; the registry only requires a
    // non-empty id to resolve the provider's trusted base URL and policy.
    modelId: definition.fallbackModels[0] ?? "folioloom-manual-model",
    ...(request.customBaseUrl === undefined ? {} : { customBaseUrl: request.customBaseUrl }),
  });
}

function registeredProvider(definition: ReturnType<ProviderRegistry["get"]>): DesktopRegisteredProvider {
  return {
    id: definition.id,
    displayName: definition.displayName,
    keyPlaceholder: definition.keyPlaceholder,
    efforts: definition.capabilities.efforts,
    fallbackModelIds: definition.fallbackModels,
    allowManualModel: definition.allowManualModel,
    allowCustomBaseUrl: definition.allowCustomBaseUrl,
  };
}

function retryableReport(code: string | undefined, status: DesktopCapabilityReport["status"]): boolean {
  return status === "failed" && code !== undefined && RETRYABLE_PROBE_CODES.has(code);
}

/**
 * Adapts the provider registry to the desktop model service without leaking
 * trusted preset URLs, StreamFn instances, or credentials to renderer DTOs.
 */
export function createDesktopProviderRegistryAdapter(
  registry: ProviderRegistry = providerRegistry,
): DesktopProviderRegistry {
  return {
    listProviders() {
      return registry.list().map(registeredProvider);
    },
    async discoverModels(request, credential) {
      const profile = discoveryProfile(registry, request);
      const models = await registry.discoverModels({ profile, credential });
      return models.map((model) => ({ id: model.id, displayName: model.id }));
    },
    async probe(profile, credential) {
      const resolved = resolvedProfile(registry, {
        providerId: providerId(profile.providerId),
        modelId: profile.modelId,
        ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }),
        ...(profile.customBaseUrl === undefined ? {} : { customBaseUrl: profile.customBaseUrl }),
      });
      const report = await probeProviderCapabilities({ profile: resolved, credential, registry });
      return {
        status: report.status,
        ...(report.code === undefined ? {} : { code: report.code }),
        message: report.message,
        retryable: retryableReport(report.code, report.status),
      };
    },
  };
}
