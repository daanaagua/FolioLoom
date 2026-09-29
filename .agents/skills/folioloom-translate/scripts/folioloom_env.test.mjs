import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

import { doctorFolioLoom, resolveFolioLoomRoot, validateFolioLoomRoot } from "./folioloom_env.mjs";

function createFixture(t, label) {
  const root = mkdtempSync(join(tmpdir(), `folioloom-skill-${label}-`));
  const safePrefix = `${resolve(tmpdir())}${sep}`.toLowerCase();
  t.after(() => {
    if (!`${resolve(root)}${sep}`.toLowerCase().startsWith(safePrefix)) {
      throw new Error(`Refusing to remove non-temporary test directory: ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  });

  const files = new Map([
    ["main.py", "# fixture\n"],
    [join("folioloom", "package.json"), '{"scripts":{"folioloom":"tsx src/cli.ts"}}\n'],
    [join("folioloom", "src", "cli.ts"), 'const flags = ["--worker", "--codex-model"];\n'],
    [join("folioloom", "src", "agents", "codex-exec-stream.ts"), "export {};\n"],
  ]);
  for (const [relativePath, contents] of files) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents, "utf8");
  }
  return root;
}

test("validates a checkout whose path contains spaces and non-ASCII text", (t) => {
  const parent = createFixture(t, "unicode");
  const unicodeRoot = join(parent, "小说 workspace");
  mkdirSync(unicodeRoot);
  for (const relativePath of [
    "main.py",
    join("folioloom", "package.json"),
    join("folioloom", "src", "cli.ts"),
    join("folioloom", "src", "agents", "codex-exec-stream.ts"),
  ]) {
    const source = join(parent, relativePath);
    const target = join(unicodeRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source, "utf8"), "utf8");
  }
  assert.equal(validateFolioLoomRoot(unicodeRoot).ok, true);
});

test("explicit root takes precedence over environment and ancestors", (t) => {
  const explicitRoot = createFixture(t, "explicit");
  const envRoot = createFixture(t, "environment");
  const result = resolveFolioLoomRoot({ explicitRoot, envRoot, cwd: envRoot });
  assert.equal(result.root, realpathSync(explicitRoot));
  assert.equal(result.source, "explicit");
});

test("configured roots fail closed instead of falling through", (t) => {
  const ancestorRoot = createFixture(t, "ancestor");
  assert.throws(
    () => resolveFolioLoomRoot({ envRoot: join(ancestorRoot, "missing"), cwd: ancestorRoot }),
    /FOLIOLOOM_HOME is not a valid/u,
  );
});

test("discovers a checkout from a current-directory ancestor", (t) => {
  const root = createFixture(t, "ancestor-scan");
  const nested = join(root, "projects", "book", "exports");
  mkdirSync(nested, { recursive: true });
  const result = resolveFolioLoomRoot({ envRoot: "", cwd: nested });
  assert.equal(result.root, realpathSync(root));
  assert.equal(result.source, "ancestor");
});

test("core doctor does not require a Codex executable or login", (t) => {
  const root = createFixture(t, "neutral-doctor");
  const calls = [];
  doctorFolioLoom({explicitRoot: root, toolRunner: (tool, args) => {calls.push([tool, args]); return {ok:true,detail:'fixture'};}});
  assert.ok(calls.some(([tool])=>tool === 'npm'));
  assert.ok(calls.every(([tool])=>tool !== 'codex'));
  calls.length = 0;
  doctorFolioLoom({explicitRoot: root, backend: 'codex', toolRunner: (tool,args) => {calls.push([tool,args]);return {ok:true,detail:'fixture'};}});
  assert.ok(calls.some(([tool,args])=>tool === 'codex' && args[0] === 'login'));
});
