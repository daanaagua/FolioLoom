import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";

test("native CLI accepts an explicit supervisor and private task context file", () => {
  const args = parseArgs(["book", "run", "--manifest", "source.json", "--store", "book.db", "--config", "model.json", "--supervisor", "bounded", "--task-context-file", "purpose.txt"]);
  assert.equal(args.supervisorMode, "bounded");
  assert.ok(args.taskContextFile?.endsWith("purpose.txt"));
  assert.equal(args.worker, undefined);
});
test("external workers cannot silently host the bounded native supervisor", () => {
  assert.throws(() => parseArgs(["book", "run", "--manifest", "source.json", "--store", "book.db", "--worker", "external", "--worker-profile", "worker.json", "--supervisor", "bounded"]), /native|supervisor/u);
});
test("supervisor status and explicit pause release have bounded typed CLI commands", () => {
  assert.equal(parseArgs(["book", "supervisor", "status", "--store", "book.db", "--run", "r"]).command, "book-supervisor-status");
  const result = parseArgs(["book", "supervisor", "release", "--store", "book.db", "--run", "r", "--request", "decision-1", "--reason", "Resolved the source ambiguity."]);
  assert.equal(result.command, "book-supervisor-release");
  assert.equal(result.requestId, "decision-1");
});
