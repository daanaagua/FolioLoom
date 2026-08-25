import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ProviderEffort, ProviderId } from "../providers/types.js";
import type { DesktopProjectRequest, DesktopRecentProject } from "./contracts.js";

const PREFERENCES_SCHEMA = "folioloom-desktop-preferences-2";
const LEGACY_PREFERENCES_SCHEMA = "folioloom-desktop-preferences-1";

export interface DesktopModelPreference {
  providerId: ProviderId;
  modelId: string;
  reasoningEffort?: ProviderEffort;
  customBaseUrl?: string;
}

export type DesktopProbeStatus = "ready" | "limited" | "failed";

export interface DesktopProbePreference {
  status: DesktopProbeStatus;
  providerId?: ProviderId;
  modelId?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  checkedAt?: string;
}

export interface DesktopPreferencesState {
  recent?: DesktopRecentProject;
  activeModelProfile?: DesktopModelPreference;
  latestProbe?: DesktopProbePreference;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && isAbsolute(value)
    ? value
    : undefined;
}

function runId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recentProject(value: unknown): DesktopRecentProject | undefined {
  const candidate = record(value);
  if (candidate === undefined) {
    return undefined;
  }
  const manifestPath = absolutePath(candidate.manifestPath);
  if (manifestPath === undefined) {
    return undefined;
  }
  const storePath = candidate.storePath === undefined
    ? undefined
    : absolutePath(candidate.storePath);
  if (candidate.storePath !== undefined && storePath === undefined) {
    return undefined;
  }
  const selectedRunId = candidate.runId === undefined ? undefined : runId(candidate.runId);
  if (candidate.runId !== undefined && selectedRunId === undefined) {
    return undefined;
  }
  return {
    manifestPath,
    ...(storePath === undefined ? {} : { storePath }),
    ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
  };
}

function storedRecentProject(request: DesktopProjectRequest): DesktopRecentProject {
  const recent = recentProject({
    manifestPath: request.manifestPath,
    ...(request.storePath === undefined ? {} : { storePath: request.storePath }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
  });
  if (recent === undefined) {
    throw new TypeError("recent project requires an absolute manifestPath and valid optional fields");
  }
  return recent;
}

function modelPreference(value: unknown): DesktopModelPreference | undefined {
  const candidate = record(value);
  const providerId = text(candidate?.providerId);
  const modelId = text(candidate?.modelId);
  if (providerId === undefined || modelId === undefined) {
    return undefined;
  }
  const reasoningEffort = candidate?.reasoningEffort === undefined
    ? undefined
    : text(candidate.reasoningEffort);
  if (candidate?.reasoningEffort !== undefined && reasoningEffort === undefined) {
    return undefined;
  }
  const customBaseUrl = candidate?.customBaseUrl === undefined
    ? undefined
    : text(candidate.customBaseUrl);
  if (candidate?.customBaseUrl !== undefined && customBaseUrl === undefined) {
    return undefined;
  }
  return {
    providerId: providerId as ProviderId,
    modelId,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as ProviderEffort }),
    ...(customBaseUrl === undefined ? {} : { customBaseUrl }),
  };
}

function probePreference(value: unknown): DesktopProbePreference | undefined {
  const candidate = record(value);
  if (candidate === undefined) {
    return undefined;
  }
  const status = candidate?.status;
  if (status !== "ready" && status !== "limited" && status !== "failed") {
    return undefined;
  }
  const code = candidate.code === undefined ? undefined : text(candidate.code);
  const message = candidate.message === undefined ? undefined : text(candidate.message);
  const checkedAt = candidate.checkedAt === undefined ? undefined : text(candidate.checkedAt);
  const providerId = candidate.providerId === undefined ? undefined : text(candidate.providerId);
  const modelId = candidate.modelId === undefined ? undefined : text(candidate.modelId);
  if (
    (candidate.code !== undefined && code === undefined)
    || (candidate.message !== undefined && message === undefined)
    || (candidate.checkedAt !== undefined && checkedAt === undefined)
    || (candidate.providerId !== undefined && providerId === undefined)
    || (candidate.modelId !== undefined && modelId === undefined)
    || (candidate.retryable !== undefined && typeof candidate.retryable !== "boolean")
  ) {
    return undefined;
  }
  return {
    status,
    ...(providerId === undefined ? {} : { providerId: providerId as ProviderId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
    ...(checkedAt === undefined ? {} : { checkedAt }),
  };
}

function preferencesState(value: unknown): DesktopPreferencesState | undefined {
  const payload = record(value);
  if (payload === undefined) {
    return undefined;
  }
  if (payload.schema === LEGACY_PREFERENCES_SCHEMA) {
    const recent = payload.recent === undefined ? undefined : recentProject(payload.recent);
    return recent === undefined ? {} : { recent };
  }
  if (payload.schema !== PREFERENCES_SCHEMA) {
    return undefined;
  }
  const recent = payload.recent === undefined ? undefined : recentProject(payload.recent);
  const activeModelProfile = payload.activeModelProfile === undefined
    ? undefined
    : modelPreference(payload.activeModelProfile);
  const latestProbe = payload.latestProbe === undefined ? undefined : probePreference(payload.latestProbe);
  return {
    ...(recent === undefined ? {} : { recent }),
    ...(activeModelProfile === undefined ? {} : { activeModelProfile }),
    ...(latestProbe === undefined ? {} : { latestProbe }),
  };
}

export class DesktopPreferences {
  readonly #path: string;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  load(): DesktopRecentProject | undefined {
    try {
      return this.loadState().recent;
    } catch {
      return undefined;
    }
  }

  loadState(): DesktopPreferencesState {
    try {
      return preferencesState(JSON.parse(readFileSync(this.#path, "utf8")) as unknown) ?? {};
    } catch {
      return {};
    }
  }

  save(request: DesktopProjectRequest): void {
    const recent = storedRecentProject(request);
    this.saveState({ ...this.loadState(), recent });
  }

  saveState(state: DesktopPreferencesState): void {
    const normalized: DesktopPreferencesState = {
      ...(state.recent === undefined ? {} : { recent: storedRecentProject(state.recent) }),
      ...(state.activeModelProfile === undefined ? {} : { activeModelProfile: modelPreference(state.activeModelProfile) }),
      ...(state.latestProbe === undefined ? {} : { latestProbe: probePreference(state.latestProbe) }),
    };
    const parent = dirname(this.#path);
    mkdirSync(parent, { recursive: true });
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify({
        schema: PREFERENCES_SCHEMA,
        ...normalized,
      }), "utf8");
      renameSync(temporaryPath, this.#path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
