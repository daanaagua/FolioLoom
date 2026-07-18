import { readFileSync } from "node:fs";

import { parse } from "yaml";

export interface PilotModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly reasoningEffort: string;
  apiKeyForRuntime(): string;
  toJSON(): Record<string, unknown>;
}

interface RawProviderConfig {
  api_key?: unknown;
  base_url?: unknown;
  timeout?: unknown;
  models?: Record<string, unknown>;
  request_options?: Record<string, { reasoning_effort?: unknown }>;
}

interface RawConfig {
  llm?: {
    active_provider?: unknown;
    providers?: Record<string, RawProviderConfig>;
  };
}

interface OpenCodeAuthEntry {
  type?: unknown;
  key?: unknown;
}

interface LoadPilotConfigOptions {
  apiKeyOverride?: string;
}

class LoadedPilotModelConfig implements PilotModelConfig {
  public constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly baseUrl: string,
    public readonly timeoutMs: number,
    public readonly reasoningEffort: string,
    private readonly apiKey: string,
  ) {}

  public apiKeyForRuntime(): string {
    return this.apiKey;
  }

  public toJSON(): Record<string, unknown> {
    return {
      provider: this.provider,
      model: this.model,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      reasoningEffort: this.reasoningEffort,
      apiKeyConfigured: this.apiKey.length > 0,
    };
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function loadPilotConfig(
  configPath: string,
  role: string,
  options: LoadPilotConfigOptions = {},
): PilotModelConfig {
  const raw = parse(readFileSync(configPath, "utf8")) as RawConfig;
  const provider = requireText(raw.llm?.active_provider, "llm.active_provider");
  const providerConfig = raw.llm?.providers?.[provider];
  if (providerConfig === undefined) {
    throw new Error(`missing llm.providers.${provider}`);
  }

  const timeoutSeconds = Number(providerConfig.timeout ?? 1800);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`llm.providers.${provider}.timeout must be positive`);
  }

  return new LoadedPilotModelConfig(
    provider,
    requireText(providerConfig.models?.[role], `model role ${role}`),
    requireText(providerConfig.base_url, `llm.providers.${provider}.base_url`),
    timeoutSeconds * 1000,
    requireText(
      providerConfig.request_options?.[role]?.reasoning_effort ?? "high",
      `request_options.${role}.reasoning_effort`,
    ),
    options.apiKeyOverride === undefined
      ? requireText(providerConfig.api_key, `llm.providers.${provider}.api_key`)
      : requireText(options.apiKeyOverride, "apiKeyOverride"),
  );
}

export function loadOpenCodeApiKey(
  authPath: string,
  provider: string,
): string {
  const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<
    string,
    OpenCodeAuthEntry | undefined
  >;
  const entry = raw[provider];
  if (entry === undefined || (entry.type !== "api" && entry.type !== "api_key")) {
    throw new Error(`OpenCode auth has no API credential for provider: ${provider}`);
  }
  return requireText(entry.key, `OpenCode auth credential for ${provider}`);
}
