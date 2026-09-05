import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";

interface LeaseRecord {
  readonly runKey: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly hostname?: string;
}

function confirmedDeadOwner(lockPath: string, runKey: string): boolean {
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as LeaseRecord;
    if (record.runKey !== runKey || typeof record.token !== "string"
      || !record.token || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
      || (record.hostname !== undefined && record.hostname !== hostname())) return false;
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (error) {
      // Permission errors and PID reuse are not evidence of a dead owner.
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

export class ActiveRunError extends Error {
  public constructor(public readonly lockPath: string) {
    super(`active run lease exists: ${lockPath}`);
    this.name = "ActiveRunError";
  }
}

export class RunLease {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly token: string,
    private readonly guard: DatabaseSync,
  ) {}

  public static acquire(lockPath: string, runKey: string): RunLease {
    const token = randomUUID();
    // SQLite's OS lock serializes reclaimers and is released even on hard exit.
    // Keep the sidecar: deleting it could split ownership across file inodes.
    const guard = new DatabaseSync(`${lockPath}.lease.db`);
    try {
      guard.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch (error) {
      guard.close();
      if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) {
        throw new ActiveRunError(lockPath);
      }
      throw error;
    }
    let created = false;
    try {
      let descriptor: number;
      try {
        descriptor = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!confirmedDeadOwner(lockPath, runKey)) throw new ActiveRunError(lockPath);
        unlinkSync(lockPath);
        try {
          descriptor = openSync(lockPath, "wx");
        } catch (retryError) {
          // Older versions do not take the SQLite guard but still use wx.
          if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ActiveRunError(lockPath);
          }
          throw retryError;
        }
      }
      created = true;
      const record: LeaseRecord = {
        runKey, token, pid: process.pid, createdAt: new Date().toISOString(),
        hostname: hostname(),
      };
      try {
        writeFileSync(descriptor, JSON.stringify(record), "utf8");
      } finally {
        closeSync(descriptor);
      }
      return new RunLease(lockPath, token, guard);
    } catch (error) {
      try {
        if (created) unlinkSync(lockPath);
      } finally {
        guard.close();
      }
      throw error;
    }
  }

  public release(): void {
    if (this.released) return;
    try {
      const current = JSON.parse(readFileSync(this.lockPath, "utf8")) as LeaseRecord;
      if (current.token !== this.token) {
        throw new Error(`run lease ownership mismatch: ${this.lockPath}`);
      }
      unlinkSync(this.lockPath);
    } finally {
      this.released = true;
      this.guard.close();
    }
  }
}
