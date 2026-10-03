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

Reference fragments are compact and bounded; a long sequence of short sentences must not
create an unbounded amount of metadata. Source lookup returns references with the same
identity scheme. A reference returned for background context cannot authorize a change
outside the selected window.

## Candidate lifecycle

The lossless execution worker uses these boundaries:

1. Generate and assemble a complete logical candidate.
2. Persist a content-hashed candidate checkpoint, separate from active translation rows.
3. Apply deterministic validation and any requested semantic review.
4. Persist repair credit before dispatch; save repaired text before its next review.
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
rejected candidate before retry. A semantic repair that makes no progress or exhausts
its durable credit produces a releasable supervision pause. Ordinary resume cannot
replenish that credit. Explicit release preserves the candidate and creates a new bounded
repair generation for the affected window.

Provider failures and missing usage are not literary issues. An interrupted dispatch
whose usage was not observed remains incomplete in the ledger and blocks strict export.
Candidate recovery never fabricates an invoice or converts unknown usage to zero.

## Terminology and review dependency

The existing terminology control service and knowledge snapshots are authoritative.
Supervision receives the same scoped terms, allowed target forms and revision metadata;
its free-text advice is not a second terminology database. Locked terms retain their
existing authority. Ambiguous aliases and suspected source errors are not automatically
merged by the evidence protocol.

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
