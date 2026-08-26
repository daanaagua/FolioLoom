# Portable setup

Read this reference only when installing the skill on another machine, relocating the
FolioLoom checkout, or resolving an environment-doctor failure.

## Keep the two directories separate

The skill contains instructions, validation scripts, and references only. A user-scoped
installation may point at a separate FolioLoom checkout. Source books, `projects/`, `book.db`,
exports, prompts, logs, credentials, and Codex session data must never be copied into the
skill directory.

Copy the complete `folioloom-translate` directory to one of Codex's skill locations, normally
the user-scoped location:

```text
$HOME/.agents/skills/folioloom-translate
```

A repository-scoped installation may instead live at
`<repository>/.agents/skills/folioloom-translate`. Keep `SKILL.md`, `scripts/`, `references/`,
and `agents/` together. Do not rewrite the scripts with the destination account name or home
path.

## Prepare the runtime

1. Check out a FolioLoom version that includes the Codex worker, or use the repository that
   contains this skill.
2. Install Node 22.5 or newer, npm, Git, and Codex CLI.
3. In `<folio-root>/folioloom`, run `npm ci` so installation follows `package-lock.json`.
4. Run `codex login` interactively on that machine. Never transfer tokens or login-state
   directories as part of the skill.
5. Point the skill at the checkout with `FOLIOLOOM_HOME`. Use an absolute path.

For the current PowerShell session:

```powershell
$env:FOLIOLOOM_HOME = "<absolute-checkout-path>"
```

To persist it for the current Windows user, then restart Codex:

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
node <skill-root>/scripts/folioloom_env.mjs doctor
```

The command succeeds only when every required check reports `ok: true`. A dirty Git checkout
is reported as a warning because local work must be preserved, not discarded.

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
