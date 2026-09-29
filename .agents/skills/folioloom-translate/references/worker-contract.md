# Worker contract

FolioLoom owns source identity, prompts, schemas, token reservations, terminology, validation,
bounded repair, database commits, and exports. The worker receives one model job and returns
one result. It never receives a database path or commits a window. The host agent orchestrates
the CLI; its conversation and subagent tree are not production translation workers.

## Backend boundaries

- Codex CLI uses the dedicated adapter described in [codex-worker.md](codex-worker.md).
- External frameworks use the versioned stdin/stdout protocol described in
  [external-workers.md](external-workers.md). Models are selected through their framework's
  exact IDs. A bridge must actually invoke that framework/model, not call Codex underneath.
- The existing provider-API path remains independent. Its credentials and configuration are
  not automatically reused or changed by worker selection.

Both worker modes run quality mode with concurrency 1. Each job starts in a fresh temporary
directory, with prose on UTF-8 stdin and no shell interpolation. A trusted external bridge has
the account's ordinary OS permissions: the temporary directory is context isolation, not an
OS sandbox. Disable its tools, hooks, plugins, and automatic sharing where supported. Read
the adapter's actual restrictions before dispatch; never describe prompt instructions as a
security boundary. Keep original authentication in the framework's normal installation.

## Identity, usage, and recovery

Keep backend, exact model, source/protocol, style/prompt, glossary, optimization profile, and
scheduler settings unchanged on resume. External runs additionally persist a SHA-256 digest
of the normalized worker profile; command arguments themselves are not persisted as run
metadata. Treat profiles and referenced adapter/config files as immutable for an active run.

Token counters must come from the framework/provider, never the model's generated answer.
Input, cache-read, and cache-write counts are disjoint. Output includes reasoning; reasoning
is a subset reported separately and is not added to the total a second time. Missing or
invalid counters remain zero/incomplete and block strict export. Zero monetary cost fields
mean unpriced by this adapter, not a free model call.

Use the existing bounded protocol/schema recovery for invalid model output. Account/quota
failures stop at the provider boundary; cancellation/deadline preserves durable work.
Inspect status before resuming. Never silently substitute a framework, model, API provider,
or direct conversational translation.

All model calls returning is not completion. Require book audit, strict export, and verified
export with complete coverage, usage, and knowledge convergence. A bounded smoke proves only
that selected path and input, not arbitrary model quality or full-book throughput.
