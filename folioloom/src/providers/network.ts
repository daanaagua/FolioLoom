import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { ProviderProbeErrorCode } from "./types.js";

const TLS_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_REVOKED", "CERT_UNTRUSTED", "INVALID_CA",
]);

export class ProviderNetworkError extends Error {
  readonly retryable = false;
  constructor(readonly code: ProviderProbeErrorCode,
    message: string, readonly transportCode?: string) {
    super(`${code}: ${message}`);
    this.name = "ProviderNetworkError";
  }
}

/** Keep allowlisted transport codes, never raw request objects, credentials or certificate contents. */
export function providerNetworkError(error: unknown): ProviderNetworkError | undefined {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  for (let checked = 0; pending.length && checked < 24; checked++) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    if (value instanceof ProviderNetworkError) return value;
    seen.add(value);
    const item = value as { code?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
    const code = typeof item.code === "string" && TLS_CODES.has(item.code) ? item.code
      : typeof item.message === "string" ? [...TLS_CODES].find(c => item.message!.toString().includes(c)) : undefined;
    if (code) return new ProviderNetworkError("PROVIDER_TLS",
      `TLS certificate validation failed (${code}); verify the configured network route and trusted certificate authority.`, code);
    pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
  return undefined;
}

let initialized = false;
let installedFetch: typeof fetch | undefined;
const scopes = new AsyncLocalStorage<{ failure?: ProviderNetworkError }>();

/** One process-local snapshot: never mutate the environment or switch active requests to a different route. */
export function ensureProviderNetwork(): void {
  if (!initialized) {
    const value = (key: string) => process.env[key.toLowerCase()] || process.env[key] || "";
    const environment: Record<string, string> = {};
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY"] as const) {
      const raw = (value(key) || value("ALL_PROXY")).trim();
      if (!raw) continue;
      let proxy: URL;
      try { proxy = new URL(raw.includes("://") ? raw : `http://${raw}`); }
      catch { throw new ProviderNetworkError("PROVIDER_PROXY_CONFIGURATION", "The configured proxy URL is invalid."); }
      if (!["http:", "https:"].includes(proxy.protocol) || proxy.search || proxy.hash
        || (proxy.pathname && proxy.pathname !== "/")) {
        throw new ProviderNetworkError("PROVIDER_PROXY_CONFIGURATION", "Use an HTTP or HTTPS proxy URL without a query or path.");
      }
      environment[key] = proxy.toString().replace(/\/$/u, "");
    }
    if (Object.keys(environment).length) {
      environment.NO_PROXY = [value("NO_PROXY"), "localhost", "127.0.0.1", "::1", "[::1]"].filter(Boolean).join(",");
      const configure = (http as typeof http & { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }).setGlobalProxyFromEnv;
      if (!configure) {
        throw new ProviderNetworkError("PROVIDER_PROXY_CONFIGURATION",
          "Environment proxy support requires Node.js 24.14 or newer in this process.");
      }
      configure(environment);
    }
    initialized = true;
  }
  if (globalThis.fetch !== installedFetch) {
    const underlyingFetch = globalThis.fetch;
    installedFetch = async (input, init) => {
      try { return await underlyingFetch(input, init); }
      catch (error) {
        const scope = scopes.getStore();
        const failure = scope && providerNetworkError(error);
        if (scope && failure) { scope.failure = failure; throw failure; }
        throw error;
      }
    };
    globalThis.fetch = installedFetch;
  }
}

export function withProviderNetwork<T>(scope: { failure?: ProviderNetworkError }, work: () => T): T {
  ensureProviderNetwork();
  return scopes.run(scope, work);
}

export const providerFetch: typeof fetch = (input, init) => withProviderNetwork({}, () => fetch(input, init));
