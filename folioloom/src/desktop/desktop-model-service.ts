import type { ProviderEffort, ProviderId } from "../providers/types.js";
import { isCurrentDeepSeekModelId } from "../providers/presets.js";
import {
  DesktopCredentialStore,
  type DesktopCredentialReadResult,
  type DesktopCredentialStoreSnapshot,
} from "./desktop-credential-store.js";
import {
  DesktopPreferences,
  type DesktopModelPreference,
  type DesktopProbePreference,
  type DesktopProbeStatus,
} from "./desktop-preferences.js";

export interface DesktopRegisteredProvider {
  id: ProviderId;
  displayName: string;
  keyPlaceholder?: string;
  efforts?: readonly ProviderEffort[];
  fallbackModelIds?: readonly string[];
  allowManualModel?: boolean;
  allowCustomBaseUrl?: boolean;
}

export interface DesktopProviderSummary extends DesktopRegisteredProvider {
  keyPlaceholder: string;
  efforts: readonly ProviderEffort[];
  fallbackModelIds: readonly string[];
  allowManualModel: boolean;
  allowCustomBaseUrl: boolean;
  credentialStatus: DesktopCredentialReadResult["status"];
  credentialPersistence?: "encrypted" | "session";
}

export interface DesktopModelOption {
  id: string;
  displayName: string;
}

export interface DesktopRegistryModelOption {
  id: string;
  displayName?: string;
}

export interface DesktopCapabilityReport {
  status: DesktopProbeStatus;
  code?: string;
  message: string;
  retryable: boolean;
}

/**
 * A small adapter boundary: the service never reaches into a raw provider
 * runtime or exposes its credential. The IPC/main composition layer supplies
 * this registry after it has chosen the trusted provider implementation.
 */
export interface DesktopProviderRegistry {
  listProviders(): readonly DesktopRegisteredProvider[];
  discoverModels(
    request: Pick<DesktopModelPreference, "providerId" | "customBaseUrl">,
    credential: string,
  ): Promise<readonly DesktopRegistryModelOption[]>;
  probe(profile: DesktopModelPreference, credential: string): Promise<DesktopCapabilityReport>;
}

export interface DesktopDiscoverModelsRequest {
  providerId: ProviderId;
  customBaseUrl?: string;
  apiKey?: string;
}

export interface DesktopTestModelRequest extends DesktopModelPreference {
  apiKey?: string;
}

export interface DesktopProbeSummary extends DesktopProbePreference {
  checkedAt: string;
  providerId: ProviderId;
  modelId: string;
}

export interface DesktopModelTestResult {
  report: DesktopProbeSummary;
  snapshot: DesktopModelServiceSnapshot;
}

export interface DesktopModelServiceSnapshot {
  providers: readonly DesktopProviderSummary[];
  activeModelProfile?: DesktopModelPreference;
  latestProbe?: DesktopProbePreference;
  credentialStore: DesktopCredentialStoreSnapshot;
}

export interface DesktopModelServiceOptions {
  providers: DesktopProviderRegistry;
  preferences: DesktopPreferences;
  credentials: DesktopCredentialStore;
  now?: () => string;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return normalized;
}

function profileFrom(request: DesktopTestModelRequest): DesktopModelPreference {
  const providerId = requiredText(request.providerId, "providerId") as ProviderId;
  const modelId = requiredText(request.modelId, "modelId");
  const reasoningEffort = request.reasoningEffort === undefined
    ? undefined
    : requiredText(request.reasoningEffort, "reasoningEffort") as ProviderEffort;
  const customBaseUrl = request.customBaseUrl === undefined
    ? undefined
    : requiredText(request.customBaseUrl, "customBaseUrl");
  return {
    providerId,
    modelId,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(customBaseUrl === undefined ? {} : { customBaseUrl }),
  };
}

function redactSecret(message: string, credential: string): string {
  let redacted = message;
  if (credential.length > 0) {
    redacted = redacted.split(credential).join("[已隐藏]");
  }
  return redacted
    .replace(/(authorization|api[ _-]?key|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/([?&](?:api[ _-]?key|key|token)=)[^&\s]+/gi, "$1[已隐藏]");
}

function probeSummary(
  report: DesktopCapabilityReport,
  credential: string,
  checkedAt: string,
  profile: DesktopModelPreference,
): DesktopProbeSummary {
  return {
    status: report.status,
    providerId: profile.providerId,
    modelId: profile.modelId,
    ...(report.code === undefined ? {} : { code: report.code }),
    message: redactSecret(report.message, credential),
    retryable: report.retryable,
    checkedAt,
  };
}

function failedProbeSummary(checkedAt: string, profile: DesktopModelPreference): DesktopProbeSummary {
  return {
    status: "failed",
    providerId: profile.providerId,
    modelId: profile.modelId,
    code: "PROBE_FAILED",
    message: "模型连通性测试失败，请检查设置后重试。",
    retryable: true,
    checkedAt,
  };
}

/**
 * Coordinates model discovery, a one-off capability test, and secret-safe
 * persistence. All public return values are deliberately JSON-safe DTOs.
 */
export class DesktopModelService {
  readonly #providers: DesktopProviderRegistry;
  readonly #preferences: DesktopPreferences;
  readonly #credentials: DesktopCredentialStore;
  readonly #now: () => string;

  constructor(options: DesktopModelServiceOptions) {
    this.#providers = options.providers;
    this.#preferences = options.preferences;
    this.#credentials = options.credentials;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  listProviders(): readonly DesktopProviderSummary[] {
    return this.#providers.listProviders().map((provider) => {
      const credential = this.#credentials.read(provider.id);
      return {
        id: provider.id,
        displayName: provider.displayName,
        keyPlaceholder: provider.keyPlaceholder?.trim() || "API Key",
        efforts: Object.freeze([...(provider.efforts ?? [])]),
        fallbackModelIds: Object.freeze([...(provider.fallbackModelIds ?? [])]),
        allowManualModel: provider.allowManualModel ?? false,
        allowCustomBaseUrl: provider.allowCustomBaseUrl ?? false,
        credentialStatus: credential.status,
        ...(credential.status === "available" || credential.status === "needs_reentry"
          ? { credentialPersistence: credential.persistence }
          : {}),
      };
    });
  }

  async discoverModels(request: DesktopDiscoverModelsRequest): Promise<readonly DesktopModelOption[]> {
    const providerId = requiredText(request.providerId, "providerId") as ProviderId;
    const provider = this.#registeredProvider(providerId);
    const customBaseUrl = request.customBaseUrl === undefined
      ? undefined
      : requiredText(request.customBaseUrl, "customBaseUrl");
    this.#assertCustomBaseUrlAllowed(provider, customBaseUrl);
    const credential = this.#credentialFor(providerId, request.apiKey);
    try {
      const models = await this.#providers.discoverModels({
        providerId,
        ...(customBaseUrl === undefined ? {} : { customBaseUrl }),
      }, credential);
      return models
        .filter((model) => typeof model.id === "string" && model.id.trim().length > 0)
        .map((model) => {
          const id = model.id.trim();
          return {
            id,
            displayName: typeof model.displayName === "string" && model.displayName.trim().length > 0
              ? model.displayName.trim()
              : id,
          };
        });
    } catch {
      throw new Error("无法获取可用模型，请检查设置后重试。");
    }
  }

  async testAndSave(request: DesktopTestModelRequest): Promise<DesktopModelTestResult> {
    const profile = profileFrom(request);
    const provider = this.#registeredProvider(profile.providerId);
    this.#assertCustomBaseUrlAllowed(provider, profile.customBaseUrl);
    const credential = this.#credentialFor(profile.providerId, request.apiKey);
    const checkedAt = this.#now();
    let report: DesktopProbeSummary;
    try {
      report = probeSummary(await this.#providers.probe(profile, credential), credential, checkedAt, profile);
    } catch {
      report = failedProbeSummary(checkedAt, profile);
    }

    const state = this.#preferences.loadState();
    if (report.status === "ready") {
      this.#credentials.save(profile.providerId, credential);
      this.#preferences.saveState({
        ...state,
        activeModelProfile: profile,
        latestProbe: report,
      });
    } else {
      this.#preferences.saveState({ ...state, latestProbe: report });
    }
    return { report, snapshot: this.snapshot() };
  }

  forgetCredential(providerIdInput: ProviderId): void {
    const providerId = requiredText(providerIdInput, "providerId") as ProviderId;
    this.#registeredProvider(providerId);
    this.#credentials.forget(providerId);
    const state = this.#preferences.loadState();
    this.#preferences.saveState({
      ...state,
      ...(state.activeModelProfile?.providerId === providerId ? { activeModelProfile: undefined } : {}),
    });
  }

  snapshot(): DesktopModelServiceSnapshot {
    let state = this.#preferences.loadState();
    const retiredActive = state.activeModelProfile?.providerId === "deepseek"
      && !isCurrentDeepSeekModelId(state.activeModelProfile.modelId);
    const retiredProbe = state.latestProbe?.providerId === "deepseek"
      && typeof state.latestProbe.modelId === "string"
      && !isCurrentDeepSeekModelId(state.latestProbe.modelId);
    if (retiredActive || retiredProbe) {
      state = {
        ...state,
        ...(retiredActive ? { activeModelProfile: undefined } : {}),
        ...((retiredActive || retiredProbe) ? { latestProbe: undefined } : {}),
      };
      this.#preferences.saveState(state);
    }
    return {
      providers: this.listProviders(),
      ...(state.activeModelProfile === undefined ? {} : { activeModelProfile: state.activeModelProfile }),
      ...(state.latestProbe === undefined ? {} : { latestProbe: state.latestProbe }),
      credentialStore: this.#credentials.snapshot(),
    };
  }

  #credentialFor(providerId: ProviderId, suppliedApiKey: string | undefined): string {
    if (suppliedApiKey !== undefined) {
      return requiredText(suppliedApiKey, "API Key");
    }
    const stored = this.#credentials.read(providerId);
    if (stored.status === "available") {
      return stored.credential;
    }
    if (stored.status === "needs_reentry") {
      throw new TypeError("保存的 API Key 无法读取，请重新输入。");
    }
    throw new TypeError("请先输入 API Key。");
  }

  #registeredProvider(providerId: ProviderId): DesktopRegisteredProvider {
    const provider = this.#providers.listProviders().find((candidate) => candidate.id === providerId);
    if (provider === undefined) {
      throw new TypeError("不支持的模型服务商。");
    }
    return provider;
  }

  #assertCustomBaseUrlAllowed(
    provider: DesktopRegisteredProvider,
    customBaseUrl: string | undefined,
  ): void {
    if (customBaseUrl !== undefined && provider.allowCustomBaseUrl !== true) {
      throw new TypeError("此服务商不支持自定义接口地址。");
    }
  }
}
