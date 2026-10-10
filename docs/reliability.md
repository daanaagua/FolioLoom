# Reliability contracts and gates

FolioLoom treats model output as a candidate, not a database instruction. Source identity,
execution state, terminology authority, budget and export approval belong to the host.

## Evidence and protocol

`domain/evidence-reference.ts` issues immutable source and target span references. IDs bind
the side, block, complete text version and Unicode-scalar range. Repeated passages have
distinct ranges. Lookup does not case-fold, guess a name, or fuzzy-match an unissued ID.

Native supervision advertises reference IDs instead of quoted-text fields. The host
expands the selected references into canonical quotations for validation and repair.
Legacy decisions still use exact quote validation. Invalid references identify the array
entry, field and block. Repeated identical tool failures are bounded by the common Pi
runtime, independently of literary repair credit.

A protocol response without a valid supervisor receipt receives one automatic retry
inside the existing checkpoint and review ceilings. Every failed response is settled
before retry; authentication errors and unknown usage do not enter this path. Repairs
are not dispatched when no review credit remains for the resulting candidate.

Reference fragments are compact and bounded; a long sequence of short sentences must not
create an unbounded amount of metadata. Source lookup returns references with the same
identity scheme. A reference returned for background context cannot authorize a change
outside the selected window.

## Candidate lifecycle

The lossless execution worker uses these boundaries:

1. Generate and assemble a complete logical candidate.
2. Persist a content-hashed candidate checkpoint, separate from active translation rows.
3. Apply deterministic validation and any requested semantic review.
4. Persist repair credit before dispatch; save repaired text only after deterministic checks, before its next review.
5. Stage and promote only a validated result through the existing ordered transaction.

Candidate records are append-only events and do not require rewriting source or active
translation tables. Reusing a candidate never means reusing provider charges: earlier
requests retain their own settlements; a resume with no new provider operation has known
zero incremental translation usage.

The cache key binds source hashes, model identity, knowledge projection, selected
knowledge, terminology, effective style and guidance. The snapshot ID is retained for
provenance. A lineage-only snapshot change with identical knowledge is not a semantic
change. Changes to actual terminology, knowledge or style invalidate reuse. Repacked
transport requests do not invalidate unchanged logical candidates.

A corrupted checkpoint fails validation. Cross-request overlap failures discard the
rejected candidate before retry. In strict mode, a semantic repair that makes no progress or exhausts
its durable credit produces a releasable supervision pause. Ordinary resume cannot
replenish that credit. Explicit release preserves the candidate and creates a new bounded
repair generation for the affected window.

Native semantic recovery permits at most two repairs within a generation and keeps the
existing three-review ceiling. A second repair requires changed candidate text and only
new grounded issue fingerprints; repeated diagnostics or non-semantic failures do not
qualify. Fingerprints bind the source evidence and problem description, excluding the
mutable target quotation. The initial request reserves the complete repair envelope.
Credits and issue fingerprints survive restart; historical credits without fingerprints
remain conservative. Ordinary structural repair remains single-pass.

Provider failures and missing usage are not literary issues. An interrupted dispatch
whose usage was not observed remains incomplete in the ledger and blocks strict export.
Candidate recovery never fabricates an invoice or converts unknown usage to zero.

## Delivery policy

New runs default to `standard`: complete translated text plus a mandatory quality report.
`strict` requires all requested semantic reviews to pass. Older runs without a recorded
delivery policy retain strict behavior. `--delivery-mode standard|strict` on `book run`
records an explicit policy transition without changing source, model or task-context identity.
Switching a semantic candidate pause to standard retains the candidate and revalidates it;
explicit model pauses and infrastructure failures are not waived.

Standard mode defers only grounded semantic findings on a complete candidate that passes
deterministic validation. If a semantic patch violates a hard check, it is rejected; the
previous reviewed candidate can be retained only after all deterministic checks pass again,
with its original semantic findings attached. Protocol or provider failures do not take
this path. It suppresses new memory, terminology candidates and style
observations from that window. Findings are stored atomically with staging, then receive
one persisted final-review pass after all source windows are committed. This pass has
the same bounded review/repair limits and uses current terminology. Repaired text replaces
active translations transactionally, preserving prior versions and validated term receipts.
Restart never renews final-review credit. An interrupted final pass blocks delivery.

`deliveryReady` and `strictExportable` are separate audit fields. Unresolved semantic
findings can permit standard delivery, but cannot set `strictExportable` to true. Missing
blocks, invalid provenance, unresolved knowledge control operations, stale bindings,
provider failures and unknown usage remain blocking conditions. Standard exports include
readable `.quality.txt` and machine-readable `.quality.json` sidecars; EPUB embeds the JSON
report. Verification checks these reports and their lineage hash against the database.
`--allow-incomplete` remains a separate partial-preview option, not standard delivery.

## Terminology and review dependency

The existing terminology control service and knowledge snapshots are authoritative.
Supervision receives the same scoped terms, allowed target forms and revision metadata;
its free-text advice is not a second terminology database. Locked terms retain their
existing authority. Ambiguous aliases and suspected source errors are not automatically
merged by the evidence protocol.

Targeted repair receives the same scoped established terms, locked forms and allowed
realizations as translation. Soft terms remain contextual. Review inspects the complete
window for supported meaning and terminology issues rather than deliberately deferring
known findings to later passes.

Only the latest applicable plan contributes guidance for a window. A narrower plan
cannot inherit obsolete instructions through a neighboring window's older batch plan.
Reviews bind both candidate content and terminology dependencies. Typed knowledge
revalidation refreshes the affected window's review requirement without reauthorizing
unrelated windows or copying old guidance.

## Automated gates

Run from `folioloom`:

```text
npm run test:reliability
npm run benchmark:reliability -- --words 10000 --fault-every 3
npm run benchmark:reliability -- --words 100000 --fault-every 7
npm run benchmark:reliability -- --words 100000 --fault-every 7 --mode fast
```

The benchmark uses a local deterministic fake provider; it does not read account
credentials or call an external model. Generated CJK output is a transport fixture, not
a literary translation. Temporary source, database, exports and a JSON report are retained
in the reported directory for inspection.

Gates cover:

- Unicode coordinates, repeated passages, stale references and out-of-scope references;
- exact identification of an invalid item among several valid review observations;
- current versus superseded terminology plans and review approvals;
- review interruption before and after repair, followed by process-level reconstruction;
- preserved repair limits and explicit release without unnecessary regeneration;
- typed and framed translation routes through native supervision;
- accounting equality between all response evidence and ledger settlements;
- strict export, artifact verification, and completed resume with no provider calls.

`duplicateTranslations` counts generation repeated without a new dependency key and must
be zero. `dependencyRegeneratedBlocks` separately reports regenerated blocks after actual
context changes, such as newly committed style examples. These are not silently counted
as checkpoint hits. Both metrics matter when comparing speed or cost.

Run latency-sensitive planner tests without a simultaneous stress benchmark. Run the
normal core, desktop and build suites as well; the focused gate is not their replacement.

## Automatic operational recovery

The native book runner, bounded supervisor, CLI export and desktop export share an
append-only `automatic_recovery` journal. `book status` includes its records. Recovery
is deterministic and does not invoke another model to choose an action.

- Translation retries throttling, timeout and busy responses only when each response
  has known usage. It retries the failed fragment on the same runtime, preserving
  successful siblings, and admits/settles the additional call through the original
  token ledger. The existing protocol-switch and context-split paths retain their
  own narrower topology limits; recovery does not replenish those limits.
- Supervisor transient/protocol retries also retain the original checkpoint and
  review-attempt ceilings. A completed candidate is reused without retranslating it.
- On resume, well-formed legacy candidates that fail current hard validation are
  quarantined in the checkpoint journal. A still-valid earlier candidate is reused;
  otherwise the missing window is generated normally. Hash corruption and source
  identity mismatches remain hard errors. Rejection never renews semantic repair
  credit or releases a supervision pause.
- Export retries only transient I/O codes (`EBUSY`, `EAGAIN`, `EMFILE`, `ENFILE`,
  `ETIMEDOUT`) at the failing stage. A successful text stage is not repeated when
  EPUB writing fails. Verification failures, permission errors and disk exhaustion
  are not retried. Desktop publication remains staged, verified and non-overwriting;
  no export path can dispatch translation calls.

Claims are persisted before backoff. The additional recovery ceiling is two claims
per identical action/fault, four per stable operation scope, 128 per run and fifteen
minutes from the first claim in a scope. Backoff starts at 250 ms and is capped at
four seconds; checkpoint quarantine needs no delay. Reconstruction does not reset
credits, and a blocked scope cannot dispatch another initial attempt on resume.
These are extra ceilings, not a new token allowance. Original token, model-turn and
supervision limits may stop recovery earlier. Authentication, account quota, unknown
usage, explicit cancellation, source-integrity errors and unknown code failures are
never downgraded to literary warnings or treated as successful output. Existing
explicit pauses remain explicit; automatic recovery does not hotpatch code or edit
source/translation rows to bypass a gate.

## Real-provider acceptance

For a configured provider, begin with a bounded one- or two-window smoke in a separate
store. Exercise an evidence-bound revision as well as a complete translation. Inspect
the actual text, tool errors, incremental calls, usage completeness and strict export.
Do not increase retries to conceal a repeated protocol error.

Progressively expand to a complete chapter, 10,000 words and 100,000 words using varied
prose, dialogue, names, Unicode and source anomalies. Record completion rate, calls and
tokens per accepted source word, review overhead, duplicate generation and restart
behavior. Synthetic scale tests establish execution contracts; real-provider trials and
reading-based evaluation establish model compatibility and translation quality.
