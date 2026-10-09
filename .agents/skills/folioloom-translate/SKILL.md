---
name: folioloom-translate
description: Translate or resume authorized long-form TXT, Markdown, DOCX, or EPUB projects with FolioLoom, inspect progress, audit, and strictly export the result. Runs from any agent host using embedded Pi/provider API by default, or an explicitly selected external framework. Not for casual sentence translation or desktop GUI control.
---

# FolioLoom Translate

Use the current agent conversation as the control plane, not as the book's translation
context. FolioLoom owns source import, window planning, terminology, recovery, storage, and
export. Each model turn runs through the selected backend. The host reading this skill and
the framework performing translation are independent.

A host needs permission to read local files, run Node commands, and observe long-running
processes. No Codex-specific tool or subagent API is required. Hosts that do not discover
skills automatically can read this file and its linked references directly.

## Resolve the checkout and backend

Derive `<skill-root>` from this loaded file. Resolve FolioLoom without embedding a machine,
account, or installation path:

```text
node <skill-root>/scripts/folioloom_env.mjs doctor [--root <checkout>] --backend core
```

Use returned `root` as `<folio-root>` and `cliDir` as `<folio-cli>`. Root precedence is
explicit `--root`, `FOLIOLOOM_HOME`, then validated ancestors. A configured invalid root
fails closed. Read its `AGENTS.md` when present and concise `STATE.md`; preserve unrelated
Git changes. Read [portable-setup.md](references/portable-setup.md) for installation or moves.

Select the backend/model the user requested or the existing run records. Never infer that
the current agent's model is available to a separate CLI. For a new run without a selection,
inspect available configured frameworks/models; use a clearly established preference or ask
if the choice materially changes cost, privacy, or capability. Do not install, authenticate,
switch providers, or change account configuration silently. For ordinary new translation
jobs with an established provider configuration, prefer embedded Pi and the provider API.
An external-framework compatibility test is not a choice of backend for another book.

Read [worker-contract.md](references/worker-contract.md) before a model call or resume:

- Codex CLI: `--worker codex --codex-model <id>`. Run the environment doctor with
  `--backend codex`; read [codex-worker.md](references/codex-worker.md).
- Other frameworks: `--worker external --worker-profile <profile.json>`. Read
  [external-workers.md](references/external-workers.md). Built-in bridge recipes cover
  OpenCode and Claude Code; any other CLI/SDK can implement the same JSON protocol.
  The model ID is opaque, not a FolioLoom whitelist. Run the environment doctor with
  `--backend external --worker-profile <profile.json>`.
- Native Pi/provider API: keep the established `--config <config>` path and model.
  Do not combine provider options with a worker. A configured OpenCode CLI is different
  from the provider-API option `--opencode-auth`, which reads credentials and does not
  launch OpenCode. Embedded Pi does not require a standalone Pi CLI.

Stop on failed required preflight checks. Core/status/audit/export commands do not require
Codex login. External authentication/model access is checked by the bounded smoke call,
not by assuming that finding an executable proves it works.

For a demonstrated hybrid TLS handshake incompatibility on the configured route,
native requests can explicitly use `FOLIOLOOM_TLS_COMPATIBILITY=classical` (or the
runtime's `tlsCompatibility` option). This opts out of hybrid key exchange for
provider requests while retaining certificate checks and TLS 1.3 negotiation.
Do not enable it for ordinary failures, bypass TLS validation or change proxy
routes silently. Native direct preflight must succeed before reserving attempts.

## Native workflow and task context

In v1.11 and later, new native CLI runs default to direct translation. Use
`--workflow direct`: new direct-translation-3 runs return typed names with source
paragraph evidence alongside translation. Stable entities become book-scoped
constraints; distinctive terms remain sense-bearing contextual preferences.
Ordinary or uncertain entries are excluded. SQLite-backed fixed waves collect
drafts and resolve declared conflicts in source order against one frozen plan,
within the original translation allowance. Do not add separate planning, lexical
research, semantic review or closure calls. Existing protocol-1/2 runs retain their
original prompts and behavior; never upgrade a stored run by editing its database.

The optional `--workflow supervised --supervisor bounded` path retains model
planning, source queries and semantic review. Use it when explicitly selected or
recorded by an existing run. External CLI workers retain their original adapters.
FolioLoom owns source identity, structural validation, accounting and commits.

When the user supplies a purpose/background prefix, save that exact authorized text in a
private UTF-8 file and pass `--task-context-file <file>`. It reaches translation, repair,
research and supervision system prompts and is included in run identity. Do not place
private context in the skill, tracked examples, or a style-only setting. Keep the file
unchanged and pass it on resume; never invent rights or ownership claims.

For supervised runs, read `book supervisor status --store <store> --run <id>` for durable decisions.
`book supervisor release --store <store> --run <id> --request <pause-id> --reason <reason>`
only releases a paused checkpoint after its cause is addressed and retry is authorized.
It does not call a model, change backend, or waive validation.

If the selected checkout lacks these flags, use a known compatible checkout with an
explicit `--root`, or report the version boundary. Do not substitute an external CLI.

## Establish and check the project

Run all `npm` commands in `<folio-cli>`, with UTF-8 and argument arrays where supported.
Resolve paths from the returned checkout; never build shell code from source prose.
Books, databases, prompts, credentials, profiles, responses, and exports stay untracked
and outside the skill. Keep the source encoding chosen by FolioLoom.

For a source file rather than an existing manifest, establish source language and a safe
project ID, then import:

```text
npm run folioloom -- book import --source <source-path> --project <folio-root>/projects/<project-id> --source-language <language>
```

The importer owns extraction, immutable originals, provenance, and the certified manifest.
It refuses existing directories; inspect existing projects rather than overwrite/re-import.
Use `projects/<project-id>/source_manifest.json`, a dedicated `book.db`, and an export
directory for that project. Never copy credentials into it.

Before any model call:

```text
npm run folioloom -- book doctor --manifest <manifest> [--glossary <glossary>]
```

Stop on source-integrity incidents, uncertain encoding, unsupported structure, or an invalid
glossary. Do not relax coverage/window rules to make doctor pass.

## Bounded smoke, continuation, and resume

Start a new store with at most two logical windows, sequentially. Native Pi:

```text
npm run folioloom -- book run --manifest <manifest> --store <store> --config <config> --workflow direct --task-context-file <private-context> --max-windows 2 --max-concurrency 1 --output <exports>
```

Omit the task-context flag when no prefix is supplied. For an explicitly selected external worker:

```text
npm run folioloom -- book run --manifest <manifest> --store <store> --worker external --worker-profile <profile.json> --max-windows 2 --max-concurrency 1 --output <exports>
```

For Codex, replace the external flags with `--worker codex --codex-model <id>`. Add approved
style, prompt, glossary, window, and scheduler options now; they become resume identity.
Workers use quality mode and concurrency 1. Codex-only batching is not enabled for external
workers.

After the smoke, run `book status --store <store>` and capture the exact run ID. Inspect
a representative translated excerpt locally, window state, model/backend, usage completeness,
warnings, and any failed/human-required window. Show the user the output location, without
pasting extensive copyrighted text. A structurally invalid smoke is a stop/diagnostic gate.

When the full run is already authorized, continue immediately after this gate. Repeat the
same arguments with `--run <run-id>`, removing `--max-windows 2`. Always pass the exact run
ID after the first call, even if the smoke completed the whole small source.

Preserve backend, worker profile, model, source, style/prompt, glossary, run mode, optimization
profile, scheduler, workflow, supervisor policy and task-context identity. Changing these requires a new run/store; do not hand-edit
the database. On cancellation or connection loss, let the process terminate, inspect status,
and resume from its durable boundary.

Use the host's process handle/wait facility for a foreground run and give concise progress
updates. Do not invent a detached daemon or automatic monitoring schedule.

## Terminology and completion

For term edits, source-range names, queued edits, retrofits, or rollback, read
[terminology-control.md](references/terminology-control.md). Use the typed control plane,
not direct SQLite writes. A queued change is durable but only becomes effective at the next
safe wave boundary. Dry-run a retrofit and report its action counts before applying it.
Direct protocol 3 retains explicit glossary precedence, durable wave membership,
frozen naming plans and bounded recovery. Comparing outer title/quotation marks
and source-attested possessives never rewrites prose. On resume, a window limit
must cover the saved wave's unfinished members; lower concurrency is allowed.
Protocol-2 recovery may reuse compatible responses from older naming contexts
for the same exact input without new calls or renewed allowance. This is not
general semantic memory or retrospective correction of existing text.
Those revalidation operations belong to the supervised workflow. Do not introduce
independent review calls merely to eliminate optional naming-table differences.

Once no pending/running/staged/human-required/failed windows remain:

```text
npm run folioloom -- book audit --store <store> --run <run-id>
npm run folioloom -- book export --store <store> --run <run-id> --output <exports>
npm run folioloom -- book verify-export --store <store> --run <run-id> --output <exports>
```

Final export must not use `--allow-incomplete`. Include the reported EPUB in verification
when applicable. Success requires complete blocks/windows, reconciled real usage, converged
knowledge and concept coverage, no outstanding knowledge commands/retrofits or integrity
incidents, strict export true, and verify-export `ok: true`.

Authentication/quota/network failures are backend boundaries, not translation warnings.
Use FolioLoom's bounded protocol/recovery paths for invalid JSON or schema rejection; do not
add an independent model retry loop. Missing usage blocks strict export; never estimate it.
Do not silently translate a book in the control conversation as a fallback.

For an exhausted direct window after a corrected connection failure, inspect
`book direct-recovery status --store <store> --run <id>`. With explicit recovery
authorization, use `book direct-recovery release --store <store> --run <id> --input
<release.json>`. The JSON carries requestId, windowId, expectedLastRequestId,
expectedIdentityHash, baseAttemptLimit, additionalAttempts and reason. Preserve
the original base limit; the release permits 1–4 extra attempts for a purely
transport-failed window, capped at eight lifetime attempts. It does not call a
model, refresh on ordinary restart, renew token envelopes, approve semantic
failures or reconcile unknown usage. Reuse saved peer responses and committed text;
do not create a replacement run merely to evade exhausted generation credits.

Update concise `STATE.md` with current result and remaining work. Record important run,
model/backend, timing, usage, recovery, audit, and artifact evidence in `state/YYYY-MM-DD.md`
in the project timezone. A short smoke is not a full-book quality or 100K throughput claim.
