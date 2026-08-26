#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REQUIRED_FILES = [
  "main.py",
  join("folioloom", "package.json"),
  join("folioloom", "src", "cli.ts"),
  join("folioloom", "src", "agents", "codex-exec-stream.ts"),
];

const CODEX_FLAGS = ['"--worker"', '"--codex-model"'];

function expandHome(candidate) {
  const value = String(candidate ?? "").trim();
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function validateFolioLoomRoot(candidate) {
  const expanded = expandHome(candidate);
  if (!expanded) return { ok: false, reason: "path is empty" };

  const absolute = resolve(expanded);
  try {
    if (!statSync(absolute).isDirectory()) {
      return { ok: false, reason: "path is not a directory" };
    }
  } catch {
    return { ok: false, reason: "directory does not exist" };
  }

  const root = realpathSync(absolute);
  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(join(root, relativePath))) {
      return { ok: false, reason: `required file is missing: ${relativePath}` };
    }
  }

  const cliSourcePath = join(root, "folioloom", "src", "cli.ts");
  const cliSource = readFileSync(cliSourcePath, "utf8");
  for (const flag of CODEX_FLAGS) {
    if (!cliSource.includes(flag)) {
      return { ok: false, reason: `Codex worker flag is missing: ${flag}` };
    }
  }

  return { ok: true, root, cliDir: join(root, "folioloom") };
}

function requireValidRoot(label, candidate) {
  const result = validateFolioLoomRoot(candidate);
  if (!result.ok) {
    throw new Error(`${label} is not a valid Codex-worker FolioLoom checkout (${result.reason}): ${candidate}`);
  }
  return result;
}

export function resolveFolioLoomRoot({
  explicitRoot,
  envRoot = process.env.FOLIOLOOM_HOME,
  cwd = process.cwd(),
} = {}) {
  if (explicitRoot !== undefined) {
    return { ...requireValidRoot("--root", explicitRoot), source: "explicit" };
  }

  if (String(envRoot ?? "").trim()) {
    return { ...requireValidRoot("FOLIOLOOM_HOME", envRoot), source: "environment" };
  }

  let cursor = resolve(cwd);
  while (true) {
    const candidate = validateFolioLoomRoot(cursor);
    if (candidate.ok) return { ...candidate, source: "ancestor" };
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  throw new Error("FolioLoom checkout was not found. Set FOLIOLOOM_HOME or pass --root.");
}

function compactOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
}

function runTool(tool, args, cwd) {
  const options = {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  };
  const result = process.platform === "win32"
    ? spawnSync(`${tool} ${args.join(" ")}`, { ...options, shell: true })
    : spawnSync(tool, args, options);
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    detail: result.error?.message ?? (compactOutput(result) || `exit ${result.status}`),
  };
}

function runGit(root) {
  const result = spawnSync("git", ["-C", root, "status", "--short", "--branch"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    detail: result.error?.message ?? (compactOutput(result) || `exit ${result.status}`),
  };
}

function parseNodeVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return { major, minor, patch };
}

function nodeSupportsSqlite(version) {
  const { major, minor } = parseNodeVersion(version);
  return major > 22 || (major === 22 && minor >= 5);
}

function inspectPackage(cliDir) {
  try {
    const packageJson = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
    return Boolean(packageJson.scripts?.folioloom);
  } catch {
    return false;
  }
}

export function doctorFolioLoom(options = {}) {
  const resolvedRoot = resolveFolioLoomRoot(options);
  const checks = [];
  const warnings = [];
  const addCheck = (name, ok, detail, required = true) => {
    checks.push({ name, ok, required, detail });
  };

  addCheck("checkout", true, `${resolvedRoot.root} (${resolvedRoot.source})`);
  addCheck(
    "node-sqlite-runtime",
    nodeSupportsSqlite(process.versions.node),
    `Node ${process.versions.node}; FolioLoom requires Node 22.5 or newer`,
  );
  const hasPackageScript = inspectPackage(resolvedRoot.cliDir);
  addCheck(
    "package-script",
    hasPackageScript,
    hasPackageScript ? "scripts.folioloom is present" : "package.json must define scripts.folioloom",
  );
  const hasPackageLock = existsSync(join(resolvedRoot.cliDir, "package-lock.json"));
  addCheck(
    "package-lock",
    hasPackageLock,
    hasPackageLock ? "package-lock.json is present" : "package-lock.json is required for deterministic npm ci",
  );
  const hasDependencies = existsSync(join(resolvedRoot.cliDir, "node_modules", "tsx", "package.json"));
  addCheck(
    "dependencies",
    hasDependencies,
    hasDependencies ? "folioloom/node_modules is installed" : "folioloom/node_modules is missing or incomplete; run npm ci in cliDir",
  );

  const npm = runTool("npm", ["--version"], resolvedRoot.cliDir);
  addCheck("npm", npm.ok, npm.detail);

  const codexVersion = runTool("codex", ["--version"], resolvedRoot.cliDir);
  addCheck("codex-cli", codexVersion.ok, codexVersion.detail);

  const codexLogin = runTool("codex", ["login", "status"], resolvedRoot.cliDir);
  addCheck("codex-login", codexLogin.ok, codexLogin.detail);

  const gitStatus = runGit(resolvedRoot.root);
  if (!gitStatus.ok) {
    warnings.push(`Git state could not be inspected: ${gitStatus.detail}`);
  } else if (gitStatus.detail.split(" | ").some((line) => !line.startsWith("## "))) {
    warnings.push("The FolioLoom checkout has local changes; preserve them and do not switch branches implicitly.");
  }

  return {
    schemaVersion: 1,
    ok: checks.every((check) => !check.required || check.ok),
    platform: { os: process.platform, arch: process.arch },
    resolutionSource: resolvedRoot.source,
    root: resolvedRoot.root,
    cliDir: resolvedRoot.cliDir,
    commands: { node: process.execPath, npm: "npm", codex: "codex" },
    checks,
    warnings,
  };
}

function parseArgs(argv) {
  const parsed = { command: "doctor", explicitRoot: undefined, json: false, help: false };
  let index = 0;
  if (argv[index] === "resolve" || argv[index] === "doctor") {
    parsed.command = argv[index];
    index += 1;
  }
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "--root") {
      if (index + 1 >= argv.length) throw new Error("--root requires a path");
      parsed.explicitRoot = argv[index + 1];
      index += 2;
    } else if (argument === "--json") {
      parsed.json = true;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  node folioloom_env.mjs doctor [--root <checkout>] [--json]",
    "  node folioloom_env.mjs resolve [--root <checkout>] [--json]",
    "",
    "Resolution order: --root, FOLIOLOOM_HOME, current-directory ancestors.",
    "",
  ].join("\n"));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      printHelp();
      return;
    }

    const options = { explicitRoot: parsed.explicitRoot };
    if (parsed.command === "resolve") {
      const result = resolveFolioLoomRoot(options);
      if (parsed.json) printJson(result);
      else process.stdout.write(`${result.root}\n`);
      return;
    }

    const report = doctorFolioLoom(options);
    printJson(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed?.command === "doctor" || parsed?.json) {
      printJson({ schemaVersion: 1, ok: false, error: message });
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) main();
