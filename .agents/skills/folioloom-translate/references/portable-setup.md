# Portable setup

Read this reference only when installing the skill on another machine, relocating the
FolioLoom checkout, or resolving an environment-doctor failure.

## Keep the two directories separate

The skill contains instructions, validation scripts, and references only. A user-scoped
installation may point at a separate FolioLoom checkout. Source books, `projects/`, `book.db`,
exports, prompts, logs, credentials, and framework session data must never be copied into the
skill directory.

Copy the complete `folioloom-translate` directory to the selected host's documented skill
location. For hosts using the shared agent-skills layout, a user-scoped location is:

```text
$HOME/.agents/skills/folioloom-translate
```

A repository-scoped installation may instead live at
`<repository>/.agents/skills/folioloom-translate`. Keep `SKILL.md`, `scripts/`, `references/`,
and `agents/` together. `agents/openai.yaml` is optional OpenAI UI metadata; other hosts can
ignore it. Hosts without skill discovery can load `SKILL.md` directly. Do not rewrite the
scripts with the destination account name or home path.

## Prepare the runtime

1. Use a FolioLoom checkout supporting the selected backend. External workers require
   `book run --worker external --worker-profile`; older Codex-only checkouts cannot run them.
2. Install Node 22.5 or newer, npm, Git, and the selected framework (Codex is optional).
3. In `<folio-root>/folioloom`, run `npm ci` so installation follows `package-lock.json`.
4. Authenticate/configure the selected framework interactively if necessary. For Codex this
   is `codex login`; other frameworks use their own setup. Never transfer tokens or login
   directories as part of the skill. No separate API key is needed by FolioLoom when the
   chosen CLI already provides authorized model access.
5. Point the skill at the checkout with `FOLIOLOOM_HOME`. Use an absolute path.

For the current PowerShell session:

```powershell
$env:FOLIOLOOM_HOME = "<absolute-checkout-path>"
```

To persist it for the current Windows user, then restart the host:

```powershell
[Environment]::SetEnvironmentVariable("FOLIOLOOM_HOME", "<absolute-checkout-path>", "User")
```

For a POSIX shell session on macOS or Linux:

```sh
export FOLIOLOOM_HOME="<absolute-checkout-path>"
```

Persist the POSIX assignment using the user's normal shell-profile or environment manager.
Do not edit a profile without the user's authorization.

## Verify the move

Run this with the actual installed skill path:

```text
node <skill-root>/scripts/folioloom_env.mjs doctor --backend core
```

The command succeeds only when every required check reports `ok: true`. A dirty Git checkout
is reported as a warning because local work must be preserved, not discarded.
For translation, add the selected backend check: `--backend codex`, or
`--backend external --worker-profile <profile.json>`. Regenerate local external profiles on
the destination machine; see [external-workers.md](external-workers.md). Backend/model
authentication is never inferred merely from the core doctor passing.

To print only the validated checkout path, use:

```text
node <skill-root>/scripts/folioloom_env.mjs resolve
```

On Windows, existing callers may use
`<skill-root>/scripts/resolve_folioloom.ps1`; it delegates to the same Node implementation.

## Move an existing translation project

Project data is not part of skill migration. If the user also authorizes moving an existing
run, copy its `projects/<project-id>` directory separately with a lossless file-transfer tool.
Before resuming, compare the source manifest and database file sizes/hashes, run FolioLoom's
`book doctor` and `book status`, and preserve the existing run identity. Never merge two
project directories or hand-edit `book.db`.
