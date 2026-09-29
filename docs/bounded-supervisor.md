# Bounded native Pi supervision

FolioLoom embeds `pi-agent-core`. Native runs use the configured provider API directly;
they do not launch a coding-agent CLI. The supervisor and translation workers use the
same explicitly configured model. External workers remain an opt-in compatibility path.

## Responsibilities

The supervisor can search the registered source, read bounded Unicode-scalar ranges,
approve a contiguous batch, identify source-grounded translation guidance, and choose
which blocks need semantic review. Reviews can accept a candidate, request a minimal
repair with exact source/target quotations, or pause a checkpoint. Candidate quotations
and block identities are validated by the host before a decision can take effect.

The kernel owns window boundaries, scheduling, account/model configuration, budgets,
validation, database writes, ordered promotion and export. Source text and tool results
are data, not instructions. No filesystem, shell, SQL or arbitrary delegation tools are
exposed to the supervisor.

Approvals cover up to four logical windows. A decision has at most four model turns and
eight tool calls; model completions are capped at 8192 tokens or the model's smaller cap.
Each checkpoint has two attempts per explicit release generation, and each window has
at most three review attempts. Ordinary resume cannot bypass a paused checkpoint.
An explicit release is an operator action, not automatic model recovery.

The supervisor reads current source and relevant terminology at event boundaries;
its durable state is an append-only journal, not an indefinitely growing conversation.
Accepted reviews are tied to the exact candidate text. Requested reviews that are
missing or stale block strict export. Structural validation remains mandatory even
when the supervisor accepts a candidate.

## CLI

Run from the `folioloom` directory:

```text
npm run folioloom -- book run --manifest projects/example/source_manifest.json --store projects/example/book.db --config config/model.json --supervisor bounded --task-context-file projects/example/purpose.txt --max-windows 2 --max-concurrency 1 --output projects/example/exports
```

New native CLI runs default to `bounded`. Use `--supervisor off` when intentionally
selecting the deterministic stage-only workflow. Existing runs preserve their recorded
mode; enabling supervision on an old run requires a new run. Do not combine `bounded`
with `--worker codex` or `--worker external`.

`--task-context-file` is optional. It contains caller-supplied purpose/background in
UTF-8, up to 16000 characters. The context precedes the existing system instructions
for translation, research, repair, recovery and supervision. It is distinct from
`--prompt`, which expresses literary style preferences. Keep private statements and
credentials out of tracked files. The context digest is part of resume identity;
resuming requires the original file contents.

After checking the initial windows, resume with the same options and explicit `--run`
ID, removing `--max-windows 2` to continue. Supervision decisions and calls are visible in:

```text
npm run folioloom -- book supervisor status --store projects/example/book.db --run RUN_ID
```

After resolving the cause of an explicit supervisor pause:

```text
npm run folioloom -- book supervisor release --store projects/example/book.db --run RUN_ID --request PAUSE_RECORD_ID --reason "Resolved the conflicting constraint"
```

Release requires an idle run. It records an operator explanation but neither starts a
model request nor relaxes any validation. A subsequent normal run command resumes work.

## Desktop

The new-run screen offers **Pi 主 agent 监督** and **任务背景前缀**. The selected mode and
private prefix are saved with that run and restored on resume. Older runs keep the
stage-only policy. Changing a model, task context or supervisor policy cannot silently
alter an existing run's identity.

## Protocol and accounting

Supervised typed translation requests constrain window, block and occurrence identities
to supplied values. Term receipts ask the model only for a known occurrence, its target
surface and discourse role; the kernel supplies source coordinates and concept identity.
An empty occurrence set cannot accept invented receipts.

Supervisor calls have their own persisted reservations, response evidence and actual
usage settlements. They are not counted a second time inside translation/repair calls.
Protocol-rejected repair responses retain reported usage. Authentication and other
infrastructure failures stop the workflow rather than becoming literary repair tasks.
Unknown usage remains unknown and blocks strict export; it is never reported as zero.

Semantic review is a model judgment, not a guarantee of literary quality. Compare it
against the stage-only workflow on the same source/model with blind reading, coverage,
consistency, completion rate, latency and total reported usage.
