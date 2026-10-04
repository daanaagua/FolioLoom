# Bounded native Pi supervision

FolioLoom embeds `pi-agent-core`. Native runs use the configured provider API directly;
they do not launch a coding-agent CLI. The supervisor and translation workers use the
same explicitly configured model. External workers remain an opt-in compatibility path.

## Responsibilities

The supervisor can search the registered source, read bounded Unicode-scalar ranges,
approve a contiguous batch, identify source-grounded translation guidance, and choose
which blocks need semantic review. Reviews can accept a candidate, request a minimal
repair with host-issued source/target reference IDs, or pause a checkpoint. The host
resolves IDs to exact text and validates block, version and visibility before a decision
can take effect. Historical quote-based decisions remain strictly validated on read.

The kernel owns window boundaries, scheduling, account/model configuration, budgets,
validation, database writes, ordered promotion and export. Source text and tool results
are data, not instructions. No filesystem, shell, SQL or arbitrary delegation tools are
exposed to the supervisor.

Approvals cover up to four logical windows; the host reduces the batch before dispatch
when its context estimate exceeds model capacity. A decision has at most four model turns and
eight tool calls; model completions are capped at 8192 tokens or the model's smaller cap.
Each checkpoint has two attempts per explicit release generation, and each window has
at most three review attempts. Ordinary resume cannot bypass a paused checkpoint.
An explicit release is an operator action, not automatic model recovery.
Repeated identical tool errors stop after two occurrences. A retry spends the original
checkpoint baseline instead of adding a new baseline allowance.

The supervisor reads current source and relevant terminology at event boundaries;
its durable state is an append-only journal, not an indefinitely growing conversation.
Plans are invalidated when their terminology dependency changes. Guidance is selected
from the latest plan for each window, not accumulated from superseded plans. Scoped
terminology rules, allowed realizations and revision metadata remain part of the shared
term projection. An affected committed window receives a host-recorded mandatory review
when typed terminology changes require revalidation; neighboring plans are not replaced.
Accepted reviews are tied to the exact candidate text and terminology dependency. Requested reviews that are
missing or stale block strict export. Structural validation remains mandatory even
when the supervisor accepts a candidate.

Whole-window candidates are checkpointed before semantic review and after repair. They
remain separate from active translations and cannot satisfy strict export on their own.
Resume can reuse a checkpoint only when its source, model, knowledge projection, terms,
style and guidance dependencies match. Snapshot ancestry alone does not invalidate an
unchanged knowledge projection. A source or meaningful context change can require a new
candidate. Cross-request validation rejection explicitly discards a reusable candidate.

Semantic repair credit is durable across restarts. In strict mode, an unchanged repair or an exhausted
credit pauses the supervised checkpoint, preserving the candidate. The existing explicit
release command permits another bounded repair after its cause has been addressed; it
does not automatically retranslate the window or waive review.

## CLI

Run from the `folioloom` directory:

```text
npm run folioloom -- book run --manifest projects/example/source_manifest.json --store projects/example/book.db --config config/model.json --supervisor bounded --task-context-file projects/example/purpose.txt --max-windows 2 --max-concurrency 1 --output projects/example/exports
```

New native CLI runs default to `bounded`. Use `--supervisor off` when intentionally
selecting the deterministic stage-only workflow. Existing runs preserve their recorded
mode; enabling supervision on an old run requires a new run. Do not combine `bounded`
with `--worker codex` or `--worker external`.

New runs use `--delivery-mode standard` by default: complete text and a quality report.
Grounded semantic findings that remain after bounded repair enter a durable queue while
translation continues. The book-end pass rechecks them with current terminology; remaining
findings accompany delivery. Choose `--delivery-mode strict` to require all reviews to pass.
Existing runs retain their recorded delivery policy; an explicit mode change is recorded.
Both modes require complete coverage, valid provenance, converged knowledge and real usage.

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

The new-run screen offers **交付模式**, **Pi 主 agent 监督** and **任务背景前缀**. The selected mode and
private prefix are saved with that run and restored on resume. Older runs keep the
stage-only policy. Changing a model, task context or supervisor policy cannot silently
alter an existing run's identity.

## Scoped reuse and bounded overlap

Plan caches include the terminology visible to their source windows, and batch plans
persist a dependency fingerprint for each window. Changes outside that projection do
not request another decision; changed local constraints invalidate the affected scope.
Candidate identity and all review-coverage checks still apply. Legacy cache identities
are conservatively refreshed on first use without releasing explicit pauses.

Independent windows may be reviewed concurrently, up to three operations and never
above the run's configured concurrency. An overlapping plan or another review of the
same window waits in scope order. Concurrent duplicate requests reuse the first valid
receipt instead of spending another review credit. The default reasoning level and
the chosen review policy are not reduced by these optimizations.

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

See [Reliability contracts and gates](reliability.md) for offline failure injection,
large synthetic runs, and real-provider acceptance criteria.
