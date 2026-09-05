import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BudgetExceeded,
  BudgetLedger,
} from "../src/kernel/budget.js";
import {
  CapabilityRegistry,
  type KernelTool,
} from "../src/kernel/capabilities.js";
import { MemoryEventLog } from "../src/kernel/event-log.js";
import { ActiveRunError, RunLease } from "../src/kernel/run-lease.js";

test("rejects the ninth research tool call without running it", () => {
  const budget = new BudgetLedger({ researchToolCalls: 8 });
  for (let index = 0; index < 8; index += 1) {
    budget.consume("researchToolCalls", 1);
  }

  assert.throws(
    () => budget.consume("researchToolCalls", 1),
    BudgetExceeded,
  );
  assert.equal(budget.remaining("researchToolCalls"), 0);
});

test("multi-counter budget reservations fail atomically", () => {
  const budget = new BudgetLedger({ modelCalls: 2, researchTurns: 0 });
  assert.throws(
    () => budget.consumeMany({ modelCalls: 1, researchTurns: 1 }),
    BudgetExceeded,
  );
  assert.equal(budget.remaining("modelCalls"), 2);
  assert.equal(budget.remaining("researchTurns"), 0);
});

test("capability registry rejects generic shell and filesystem tools", () => {
  const forbiddenTool: KernelTool<Record<string, never>, string> = {
    name: "bash",
    phase: "research",
    execute: async () => "should not execute",
  };

  assert.throws(
    () => new CapabilityRegistry([forbiddenTool]),
    /forbidden capability: bash/,
  );
});

test("event log assigns a stable increasing sequence", () => {
  const log = new MemoryEventLog();

  log.append("started", { runKey: "pilot" });
  log.append("tool", { name: "search_mentions" });

  assert.deepEqual(
    log.events().map((event) => [event.sequence, event.type]),
    [[1, "started"], [2, "tool"]],
  );
});

test("run lease blocks a duplicate owner and can be reacquired after release", () => {
  const directory = mkdtempSync(join(tmpdir(), "v5-run-lease-"));
  const lockPath = join(directory, "pilot.lock");
  try {
    const first = RunLease.acquire(lockPath, "same-run");
    assert.throws(
      () => RunLease.acquire(lockPath, "same-run"),
      ActiveRunError,
    );
    first.release();

    const second = RunLease.acquire(lockPath, "same-run");
    second.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a lease whose child owner exited without releasing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-dead-lease-"));
  const lockPath = join(directory, "run.lock");
  try {
    const moduleUrl = new URL("../src/kernel/run-lease.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { RunLease } from ${JSON.stringify(moduleUrl)}; RunLease.acquire(${JSON.stringify(lockPath)}, 'test'); process.exit(0);`],
      { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
    const recovered = RunLease.acquire(lockPath, "test");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    recovered.release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("does not discard a malformed or live-owner legacy lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-unknown-lease-"));
  const lockPath = join(directory, "run.lock");
  try {
    const base = { runKey: "test", token: "legacy", pid: process.pid, createdAt: new Date().toISOString() };
    for (const value of ["{", "null", JSON.stringify(base),
      JSON.stringify({ ...base, hostname: "different-host" }),
      JSON.stringify({ ...base, runKey: "another-run" })]) {
      writeFileSync(lockPath, value, "utf8");
      assert.throws(() => RunLease.acquire(lockPath, "test"), ActiveRunError);
      assert.equal(readFileSync(lockPath, "utf8"), value);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent processes reclaim one dead lease without gaining dual ownership", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-racing-lease-"));
  const lockPath = join(directory, "run.lock");
  const moduleUrl = new URL("../src/kernel/run-lease.ts", import.meta.url).href;
  const importLine = `import { RunLease, ActiveRunError } from ${JSON.stringify(moduleUrl)};`;
  const dead = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `${importLine} RunLease.acquire(${JSON.stringify(lockPath)}, 'test'); process.exit(0);`],
    { encoding: "utf8", windowsHide: true });
  assert.equal(dead.status, 0, dead.stderr);
  const children = Array.from({ length: 3 }, () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      ${importLine}
      let lease;
      process.on('message', message => {
        if (message === 'acquire') {
          try { lease = RunLease.acquire(${JSON.stringify(lockPath)}, 'test'); process.send('won'); }
          catch (error) { if (!(error instanceof ActiveRunError)) throw error; process.send('lost'); }
        } else if (message === 'release') { lease?.release(); process.exit(0); }
      });
      process.send('ready');
    `], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const nextMessage = () => new Promise<unknown>((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
    });
    const ready = nextMessage();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return { child, ready, nextMessage, exited };
  });
  try {
    assert.deepEqual(await Promise.all(children.map((child) => child.ready)), ["ready", "ready", "ready"]);
    const results = children.map(({ child, nextMessage }) => {
      const result = nextMessage();
      child.send("acquire");
      return result;
    });
    assert.deepEqual((await Promise.all(results)).sort(), ["lost", "lost", "won"]);
    for (const { child } of children) child.send("release");
    await Promise.all(children.map((child) => child.exited));
    RunLease.acquire(lockPath, "test").release();
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
});
