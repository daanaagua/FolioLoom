import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
