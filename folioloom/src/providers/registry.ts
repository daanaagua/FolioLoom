import type {
  FetchLike,
  InternalThinkingLevel,
  ModelOption,
  ModelProfile,
  ProviderDefinition,
  ProviderEffort,
  ProviderId,
  ResolvedProviderProfile,
  SecretCredential,
} from "./types.js";
import {
  PROVIDER_PRESETS,
  isCurrentDeepSeekModelId,
  isWellFormedModelId,
} from "./presets.js";

const MAX_DISCOVERED_MODELS = 500;

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return text;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function validateCustomOpenAICompatibleBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(requireText(value, "custom provider base URL"));
  } catch {
    throw new TypeError("custom provider base URL must be an HTTPS URL or loopback HTTP URL");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError("custom provider base URL must not include credentials, query parameters, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new TypeError("custom provider base URL must be an HTTPS URL or loopback HTTP URL");
  }
  return normalizeBaseUrl(url.toString());
}

export function toInternalThinking(effort: ProviderEffort): InternalThinkingLevel | undefined {
  switch (effort) {
    case "off":
      return undefined;
    case "on":
      return "high";
    case "max":
      return "xhigh";
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
  }
}

export function toProviderEffort(
  internal: InternalThinkingLevel,
  profile: Pick<ModelProfile, "reasoningEffort">,
): ProviderEffort | undefined {
  const raw = profile.reasoningEffort;
  return raw === undefined || raw === "off" || toInternalThinking(raw) !== internal
    ? undefined
    : raw;
}

function uniqueSortedModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { data?: unknown }).data)) {
    throw new TypeError("model discovery response must contain a data array");
  }
  const ids = (value as { data: unknown[] }).data
    .map((item) => typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined)
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(isWellFormedModelId);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, MAX_DISCOVERED_MODELS);
}

function modelsEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

export interface DiscoverModelsRequest {
  profile: ModelProfile;
  credential: SecretCredential;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Attempt /models even for providers whose built-in catalogue is curated. */
  forceLive?: boolean;
}

export class ProviderModelConfigurationError extends Error {
  readonly code: "DEEPSEEK_MODEL_RETIRED";

  constructor(
    code: "DEEPSEEK_MODEL_RETIRED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProviderModelConfigurationError";
    this.code = code;
  }
}

export class ProviderRegistry {
  readonly #definitions: readonly ProviderDefinition[];
  readonly #byId: ReadonlyMap<ProviderId, ProviderDefinition>;

  constructor(definitions: readonly ProviderDefinition[] = PROVIDER_PRESETS) {
    const copy = definitions.map((definition) => Object.freeze({
      ...definition,
      fallbackModels: Object.freeze([...definition.fallbackModels]),
      capabilities: Object.freeze({
        ...definition.capabilities,
        efforts: Object.freeze([...definition.capabilities.efforts]),
      }),
    }));
    if (copy.length === 0 || new Set(copy.map((item) => item.id)).size !== copy.length) {
      throw new TypeError("provider definitions must have unique ids");
    }
    this.#definitions = Object.freeze(copy);
    this.#byId = new Map(copy.map((definition) => [definition.id, definition]));
  }

  list(): readonly ProviderDefinition[] {
    return this.#definitions;
  }

  get(providerId: ProviderId): ProviderDefinition {
    const definition = this.#byId.get(providerId);
    if (definition === undefined) {
      throw new TypeError(`unsupported provider: ${providerId}`);
    }
    return definition;
  }

  resolve(profile: ModelProfile): ResolvedProviderProfile {
    const definition = this.get(profile.providerId);
    const modelId = requireText(profile.modelId, "modelId");
    if (!isWellFormedModelId(modelId)) throw new TypeError("modelId is invalid");
    if (definition.id === "deepseek" && !isCurrentDeepSeekModelId(modelId)) {
      throw new ProviderModelConfigurationError(
        "DEEPSEEK_MODEL_RETIRED",
        "DeepSeek 已停用该模型路由，新任务请选择 deepseek-flash；旧任务兼容 deepseek-v4-flash 或 deepseek-v4-pro",
      );
    }
    const reasoningEffort = profile.reasoningEffort;
    if (reasoningEffort !== undefined && !definition.capabilities.efforts.includes(reasoningEffort)) {
      throw new TypeError(`provider ${definition.id} does not support reasoning effort: ${reasoningEffort}`);
    }
    const baseUrl = definition.allowCustomBaseUrl
      ? validateCustomOpenAICompatibleBaseUrl(profile.customBaseUrl ?? "")
      : definition.defaultBaseUrl;
    return {
      definition,
      baseUrl,
      profile: {
        providerId: profile.providerId,
        modelId,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(definition.allowCustomBaseUrl ? { customBaseUrl: baseUrl } : {}),
      },
    };
  }

  async discoverModels(request: DiscoverModelsRequest): Promise<readonly ModelOption[]> {
    request.signal?.throwIfAborted();
    // Discovery must not depend on a previously selected model still existing.
    const definition = this.get(request.profile.providerId);
    const baseUrl = definition.allowCustomBaseUrl
      ? validateCustomOpenAICompatibleBaseUrl(request.profile.customBaseUrl ?? "")
      : definition.defaultBaseUrl;
    const fallback = definition.fallbackModels.map((id) => ({ id, source: "fallback" as const }));
    if (definition.modelDiscovery === "curated" && !request.forceLive) {
      return fallback;
    }
    const timeoutMs = request.timeoutMs ?? 8000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      throw new TypeError("model discovery timeout must be between 0 and 30000 ms");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = request.signal === undefined ? controller.signal
      : AbortSignal.any([request.signal, controller.signal]);
    const fetcher = request.fetch ?? globalThis.fetch;
    try {
      const response = await fetcher(modelsEndpoint(baseUrl), {
        method: "GET",
        headers: { Authorization: `Bearer ${request.credential}` },
        signal,
      });
      if (!response.ok) {
        throw new Error(`model discovery failed with ${response.status}`);
      }
      return uniqueSortedModelIds(await response.json())
        .filter((id) => definition.id !== "deepseek" || isCurrentDeepSeekModelId(id))
        .filter((id) => request.credential.length === 0 || !id.includes(request.credential))
        .map((id) => ({ id, source: "live" as const }));
    } catch {
      request.signal?.throwIfAborted();
      if (fallback.length === 0) throw new Error("MODEL_DISCOVERY_UNAVAILABLE");
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const providerRegistry = new ProviderRegistry();
