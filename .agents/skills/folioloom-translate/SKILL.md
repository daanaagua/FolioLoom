---
name: folioloom-translate
description: Translate or resume authorized long-form TXT, Markdown, DOCX, or EPUB projects with a local FolioLoom checkout through an isolated signed-in Codex CLI worker, then inspect, audit, and strictly export the result. Use when the user asks Codex to translate a book or novel without a separate model API key, continue a FolioLoom Codex-worker run, inspect its progress or output, diagnose a failed worker, or validate and export it. Do not use for casual sentence translation, API-provider setup, or the desktop GUI workflow.
---

# FolioLoom Translate

Use the current conversation as the control plane. Let FolioLoom plan and validate every
window, and let an isolated `codex exec` process perform each model turn. Do not place the
whole book or a sequence of window translations in the control conversation.

## Resolve and preflight the checkout

Never assume the current directory is FolioLoom. Derive `<skill-root>` from the directory
containing this loaded `SKILL.md`; never embed an account name, drive letter, home directory,
or installation path. Run the portable environment doctor before any FolioLoom command:

```text
node <skill-root>/scripts/folioloom_env.mjs doctor [--root <checkout>]
```

The doctor prints UTF-8 JSON. Use its `root` as `<folio-root>` and `cliDir` as `<folio-cli>`.
It validates the Codex-worker checkout, Node/npm, installed dependencies, Codex CLI login,
and Git state without installing, authenticating, or changing anything. Stop on a required
check whose `ok` is false.

Root precedence is an explicit `--root`, `FOLIOLOOM_HOME`, then validated ancestors of the
current directory. An explicit or configured root that fails validation is an error; do not
silently fall through. `scripts/resolve_folioloom.ps1` remains a Windows compatibility
wrapper, but new workflows should call the Node script directly. When moving this workflow
to another machine or when preflight fails, read
[references/portable-setup.md](references/portable-setup.md).

1. Read `<folio-root>/AGENTS.md` if present. Read only the concise root `STATE.md` by default.
   Keep current status, pending work, and history links there; append detailed command,
   timing, run, and artifact evidence to `state/YYYY-MM-DD.md` in the project timezone.
2. Inspect `git -C <folio-root> status --short --branch`. Preserve unrelated user changes;
   never switch branches merely to make the skill run.
3. Treat a failed Codex authentication, quota, executable, or checkout check as a blocker.
   Never substitute an API provider, another model, or direct translation silently.
4. Use UTF-8 explicitly for commands and text inspection. Preserve the source encoding
   selected by FolioLoom; do not rewrite an original merely because terminal display is bad.
5. Treat source books, databases, outputs, prompts, credentials, and worker responses as
   private untracked data. Never add them to Git or copy them into this skill.

Read [references/worker-contract.md](references/worker-contract.md) before changing worker
options, resuming a run, diagnosing a worker failure, or deciding that an export passed.

## Command portability

Run every `npm` command with working directory `<folio-cli>`. Pass arguments as an argument
array when the execution tool supports it; do not construct a shell command from book paths
or user text. The examples below are deliberately single-line and use `npm`, which resolves
to the platform's npm launcher. Resolve all project paths from `<folio-root>` rather than from
the shell's current directory.

## Establish the project

Treat a user-supplied source file as the normal entry point. If the user supplied a file
rather than an existing `source_manifest.json`, establish the source language and a
filesystem-safe project ID, then run from `<folio-cli>`:

```text
npm run folioloom -- book import --source <source-path> --project <folio-root>/projects/<project-id> --source-language <language>
```

The importer writes the immutable original payload, canonical UTF-8 source, provenance, and
certified manifest atomically. It refuses an existing project directory; never delete or
replace one merely to make import succeed. Existing projects created by older FolioLoom
versions remain valid and should be inspected rather than re-imported. The resulting paths
are below `<folio-root>`:

```text
projects/<project-id>/source_manifest.json
projects/<project-id>/artifacts/folioloom/book.db
projects/<project-id>/exports/codex
```

For an existing project, inspect its manifest and current status instead of re-importing it.

## Run the deterministic project preflight

Run FolioLoom's book doctor before any model call:

```text
npm run folioloom -- book doctor --manifest <folio-root>/projects/<project-id>/source_manifest.json
```

Pass the same `--glossary` intended for translation. Stop on source-integrity incidents,
uncertain encoding, unsupported structure, or an invalid glossary. Do not weaken window or
coverage rules to make doctor pass.

## Run one bounded Codex file batch first

For a new store, run at most two sequential logical windows and write partial artifacts for
inspection. A new Codex run persists `codex-file-v1`; within a 4,800-source-token ceiling it
may combine those two adjacent windows into one physical model call. Validation and durable
commit identities remain per logical window. On a stable run, two sequential physical
requests may share one lexical-anchor wave; any retry or unstable knowledge state backs the
next wave down to one physical request:

```text
npm run folioloom -- book run --manifest <folio-root>/projects/<project-id>/source_manifest.json --store <folio-root>/projects/<project-id>/artifacts/folioloom/book.db --worker codex --codex-model <model-id> --max-windows 2 --max-concurrency 1 --output <folio-root>/projects/<project-id>/exports/codex
```

Add user-approved `--style-profile`, `--prompt`, `--glossary`, scheduler, or window options
now; they become part of resume identity. Do not add a provider `--config` or
`--opencode-auth` to a Codex-worker run.

After the bounded smoke call:

1. Run `book status` and capture the run ID.
2. Open the generated partial Chinese TXT locally and show the user where it is. Inspect a
   representative excerpt without pasting large copyrighted passages into the conversation.
3. Check window status, model ID, `executionBackend: codex-exec`, usage completeness, warning
   counts, and any human-required or failed window.
4. Continue only when the smoke result is structurally valid. If the user already authorized
   the full run, continue immediately after this gate without asking again.

## Continue or resume

Repeat the same `book run` arguments against the same store and add the exact `--run <run-id>`
returned by the smoke. Preserve model, style, prompt, glossary, run mode, optimization profile,
and scheduler options. Remove `--max-windows 2` to continue the book. Keep
`--max-concurrency 1` in this version.

Always pass the exact `--run` after the first call; this prevents a fully completed one-window
smoke from being mistaken for a request to create a new run. Never resume a provider-API run
with `--worker codex`, or a Codex-worker run without it. Never change the model on an existing
run; use a new store/run for a different model or translation policy.

For a long foreground execution, yield the shell call and wait on its process rather than
polling logs repeatedly. Give the user a concise progress update at least once per minute.
On cancellation or connection loss, let the process terminate, then inspect `book status` and
resume the same run from its durable boundary. Do not delete or hand-edit `book.db`.

## Review terminology during a run

The knowledge workbench remains readable while translation is running. Use the typed CLI
control plane for live edits and post-translation correction; never open or modify SQLite
directly. A valid edit may return `queued` while a window is in flight. That means it is
durable but not yet effective: the current request keeps its old snapshot and FolioLoom
applies the edit once at the next safe wave boundary.

Read [references/terminology-control.md](references/terminology-control.md) when the user asks
to inspect or change a term, apply different names to different parts of the book, bulk-fix
an existing translation, inspect a queued edit, or roll such a change back. Always dry-run a
retrofit first and report its `noop`, `localRepair`, `modelRetranslate`, and `humanRequired`
counts before applying it. Do not treat a local Chinese string match as proof that replacement
is safe; FolioLoom permits local repair only from exact source occurrence receipts.

## Audit and strictly export

Do not equate "all model calls returned" with completion. Once status has no pending,
running, staged, human-required, or failed windows, run these commands from `<folio-cli>`:

```text
npm run folioloom -- book audit --store <folio-root>/projects/<project-id>/artifacts/folioloom/book.db --run <run-id>
npm run folioloom -- book export --store <folio-root>/projects/<project-id>/artifacts/folioloom/book.db --run <run-id> --output <folio-root>/projects/<project-id>/exports/codex
npm run folioloom -- book verify-export --store <folio-root>/projects/<project-id>/artifacts/folioloom/book.db --run <run-id> --output <folio-root>/projects/<project-id>/exports/codex
```

Do not pass `--allow-incomplete` for final delivery. Add the reported EPUB path to
`verify-export` when one exists. Announce success only when all of these are true:

- every planned window and block is complete;
- usage is complete and the token ledger is reconciled;
- knowledge is converged and concept coverage has no missing/stale binding;
- no queued/applying knowledge command or unfinished/attention retrofit item remains;
- strict export is true and verify-export returns `ok: true`;
- no human-required, failed, pending revalidation, or integrity incident remains.

Update the concise `<folio-root>/STATE.md` with only the current result and remaining work.
Append the run ID, model, elapsed time, calls/tokens, recovery counts, audit result, artifact
paths, and deferred gates to `<folio-root>/state/YYYY-MM-DD.md`. A short smoke does not satisfy
a 100K gate.

## Failure rules

- Authentication, quota, executable, and network failures are worker/provider boundaries;
  stop and report them rather than turning them into translation warnings.
- Invalid JSON, a missing tool submission, and schema rejection use FolioLoom's existing
  bounded correction and paragraph-recovery paths. Do not invent a second repair loop.
- Missing Codex usage remains usage-incomplete and blocks strict export; never synthesize
  token counts.
- A human-required window is not complete. Preserve its evidence and report the exact window
  and failure class.
- Direct translation in the control conversation is allowed only when the user explicitly
  asks for a small debugging sample. It is never an automatic fallback for a book run.
