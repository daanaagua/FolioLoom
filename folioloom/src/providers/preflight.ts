import type { StreamFn } from "@earendil-works/pi-agent-core";
import { providerFetch, ProviderNetworkError, providerNetworkError } from "./network.js";

export interface ProviderConnectionReport {
  readonly httpStatus: number;
  readonly catalog: "available" | "unsupported";
}
type Preflight = (signal?: AbortSignal, fresh?: boolean) => Promise<ProviderConnectionReport>;
const checks = new WeakMap<StreamFn, Preflight>();

/** Only registered native runtimes use this hook; external workers keep their own preflight contract. */
export function registerProviderPreflight(streamFn: StreamFn, check: Preflight): void { checks.set(streamFn, check); }
export function inheritProviderPreflight(from: StreamFn, to: StreamFn): StreamFn {
  const check = checks.get(from);
  if (check) checks.set(to, check);
  return to;
}
export async function preflightProviderStream(streamFn: StreamFn, signal?: AbortSignal, fresh = false): Promise<void> {
  signal?.throwIfAborted();
  await checks.get(streamFn)?.(signal, fresh);
}

export function createProviderPreflight(baseUrl: string, credential: string, timeoutMs = 15_000): Preflight {
  const pending = new Map<AbortSignal | undefined, Promise<ProviderConnectionReport>>();
  let successful: ProviderConnectionReport | undefined;
  const execute = async (signal?: AbortSignal): Promise<ProviderConnectionReport> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 15_000));
    try {
      const response = await providerFetch(`${baseUrl.replace(/\/$/u, "")}/models`, {
        method: "GET", headers: { Authorization: `Bearer ${credential}` }, redirect: "error",
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      await response.body?.cancel();
      if (response.ok || response.status === 404 || response.status === 405) {
        return { httpStatus: response.status, catalog: response.ok ? "available" : "unsupported" };
      }
      const code = response.status === 401 || response.status === 403 ? "AUTH_INVALID"
        : response.status === 402 ? "QUOTA_EXHAUSTED" : response.status === 429 ? "RATE_LIMITED"
        : response.status >= 500 ? "PROVIDER_BUSY" : "PROVIDER_PREFLIGHT_FAILED";
      throw new ProviderNetworkError(code, `Read-only model endpoint preflight returned HTTP ${response.status}; no generation request was sent.`);
    } catch (error) {
      signal?.throwIfAborted();
      const networkFailure = providerNetworkError(error);
      if (networkFailure) throw networkFailure;
      if (controller.signal.aborted) throw new ProviderNetworkError("REQUEST_TIMEOUT", "Read-only provider preflight timed out; no generation request was sent.");
      throw new ProviderNetworkError("PROVIDER_UNREACHABLE", "Read-only provider preflight could not establish a connection; no generation request was sent.");
    } finally { clearTimeout(timer); }
  };
  return async (signal, fresh = false) => {
    signal?.throwIfAborted();
    if (fresh) successful = undefined;
    if (successful) return successful;
    let request = pending.get(signal);
    if (!request) {
      request = execute(signal).then(report => { successful = report; return report; }).finally(() => { pending.delete(signal); });
      pending.set(signal, request);
    }
    const report = await request;
    signal?.throwIfAborted();
    return report;
  };
}
