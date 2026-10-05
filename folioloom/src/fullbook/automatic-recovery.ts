import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ModelProviderError, piRunUsageComplete } from "../agents/pi-runtime.js";
import { supervisionHash } from "../domain/supervision.js";

export type RecoveryAction = "provider_retry" | "supervisor_retry" | "reject_checkpoint" | "export_retry";
export interface RecoveryRecord {
  readonly id: string;
  readonly scope: string;
  readonly action: RecoveryAction;
  readonly fingerprint: string;
  readonly state: "claimed" | "blocked";
  readonly at: number;
  readonly reason?: "repeated_fault" | "scope_limit" | "run_limit" | "elapsed_limit" | "deadline";
}
export interface RecoveryJournal {
  recoveryRecords(runId: string): RecoveryRecord[];
  appendRecoveryRecord(runId: string, record: RecoveryRecord): void;
}
export class RecoveryPausedError extends Error {
  readonly retryable = false;
  readonly code = "AUTOMATIC_RECOVERY_PAUSED";
  constructor(readonly scope: string, reason: string) {
    super(`AUTOMATIC_RECOVERY_PAUSED: ${scope}: ${reason}`);
    this.name = "RecoveryPausedError";
  }
}
export function validateRecoveryRecord(record: RecoveryRecord): void {
  if (!record.id || !record.scope || record.scope.length > 4096 || !/^[a-f0-9]{64}$/u.test(record.fingerprint)
    || !["provider_retry", "supervisor_retry", "reject_checkpoint", "export_retry"].includes(record.action)
    || !["claimed", "blocked"].includes(record.state) || !Number.isSafeInteger(record.at) || record.at < 0
    || (record.state === "blocked" && !["repeated_fault", "scope_limit", "run_limit", "elapsed_limit", "deadline"].includes(record.reason ?? ""))) {
    throw new Error("invalid automatic recovery record");
  }
}

/** Only authorizes recovery. Provider calls still require the existing token admission. */
export class AutomaticRecovery {
  constructor(private readonly options: { runId: string; store: RecoveryJournal; now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }) {}

  #records(): RecoveryRecord[] {
    const records = this.options.store.recoveryRecords(this.options.runId);
    records.forEach(validateRecoveryRecord);
    return records;
  }

  assertAvailable(scope: string, initialAttempt = false): void {
    const records = this.#records();
    const blocked = records.findLast(r => r.scope === scope && r.state === "blocked");
    if (blocked) throw new RecoveryPausedError(scope, blocked.reason!);
    if (initialAttempt) {
      const scoped = records.filter(r => r.scope === scope && r.state === "claimed");
      const exhausted = scoped.length >= 4 || scoped.some(r => scoped.filter(other =>
        other.action === r.action && other.fingerprint === r.fingerprint).length >= 2);
      if (exhausted) throw new RecoveryPausedError(scope, "durable recovery credit exhausted");
      if (scoped.length && (this.options.now ?? Date.now)() - scoped[0]!.at >= 15 * 60_000)
        throw new RecoveryPausedError(scope, "elapsed_limit");
    }
  }

  async claim(input: { scope: string; action: RecoveryAction; fingerprint: string; signal?: AbortSignal; deadlineAtMs?: number }): Promise<boolean> {
    input.signal?.throwIfAborted();
    const records = this.#records();
    if (records.some(r => r.scope === input.scope && r.state === "blocked")) return false;
    const claims = records.filter(r => r.state === "claimed");
    const scoped = claims.filter(r => r.scope === input.scope);
    const at = (this.options.now ?? Date.now)();
    const fingerprint = supervisionHash(input.fingerprint);
    const waitMs = input.action === "reject_checkpoint" ? 0 : Math.min(4000, 250 * 2 ** scoped.length);
    const reason: RecoveryRecord["reason"] = scoped.length >= 4 ? "scope_limit"
      : claims.length >= 128 ? "run_limit"
      : scoped.filter(r => r.action === input.action && r.fingerprint === fingerprint).length >= 2 ? "repeated_fault"
      : scoped.length > 0 && at - scoped[0]!.at >= 15 * 60_000 ? "elapsed_limit"
      : input.deadlineAtMs !== undefined && at + waitMs >= input.deadlineAtMs ? "deadline" : undefined;
    // Persist before yielding, so cancellation, a crash, or a new controller cannot renew credit.
    this.options.store.appendRecoveryRecord(this.options.runId, { id: randomUUID(), scope: input.scope,
      action: input.action, fingerprint, state: reason ? "blocked" : "claimed", at, ...(reason ? { reason } : {}) });
    if (reason) return false;
    if (waitMs) await (this.options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(waitMs, input.signal);
    input.signal?.throwIfAborted();
    return true;
  }

  async providerRetry(scope: string, error: unknown, options: { signal?: AbortSignal; deadlineAtMs?: number; supervisor?: boolean } = {}): Promise<boolean> {
    if (!(error instanceof ModelProviderError) || !error.run || !piRunUsageComplete(error.run)) return false;
    const allowed = ["throttled", "timeout", "busy"].includes(error.kind)
      || (options.supervisor && error.kind === "protocol");
    if (!allowed) return false;
    return this.claim({ scope, action: options.supervisor ? "supervisor_retry" : "provider_retry",
      fingerprint: error.kind, signal: options.signal, deadlineAtMs: options.deadlineAtMs });
  }

  async exportStep<T>(scope: string, operation: () => T | Promise<T>): Promise<T> {
    this.assertAvailable(scope, true);
    for (;;) {
      try { return await operation(); }
      catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (!code || !["EBUSY", "EAGAIN", "EMFILE", "ENFILE", "ETIMEDOUT"].includes(code)
          || !await this.claim({ scope, action: "export_retry", fingerprint: code })) throw error;
      }
    }
  }
}
