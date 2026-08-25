import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

interface LeaseRecord {
  readonly runKey: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
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
  ) {}

  public static acquire(lockPath: string, runKey: string): RunLease {
    const token = randomUUID();
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ActiveRunError(lockPath);
      }
      throw error;
    }

    const record: LeaseRecord = {
      runKey,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    try {
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
    } finally {
      closeSync(descriptor);
    }
    return new RunLease(lockPath, token);
  }

  public release(): void {
    if (this.released) return;
    const current = JSON.parse(readFileSync(this.lockPath, "utf8")) as LeaseRecord;
    if (current.token !== this.token) {
      throw new Error(`run lease ownership mismatch: ${this.lockPath}`);
    }
    unlinkSync(this.lockPath);
    this.released = true;
  }
}
