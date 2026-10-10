# Direct translation

New native CLI and desktop full-book tasks use the direct workflow. The host plans
source windows once. Each response supplies its translation and optional short
names grounded in that window's source and translated paragraphs. Accepted names
are recorded in SQLite and relevant entries are supplied to later windows in a
fixed concurrent waves. An explicit input glossary takes precedence, with block
scopes preserved; it does not disable discovery of other names.

The normal path uses one response per window. It has no tool-calling supervisor,
per-window lexical anchoring, semantic repair loop, chapter review, or quality
closure queue. Empty or unusable optional naming entries do not trigger analysis.
Names are generation context, not proof of correct interpretation; ordinary words
and ambiguous senses are not mechanically replaced in the exported text.

Each request contains the current paragraphs, short read-only source neighbors,
shared names, style, and the original task-context prefix. Output is raw JSON with
ordered paragraph IDs and translated text, plus optional literal source/target
typed naming entries when new or changed names occur. The parser requires exact paragraph coverage, order, nonempty text,
valid Unicode and unchanged EPUB slots. These are structural checks, not a claim
that every sentence has been semantically verified.

## Running

```sh
npm run folioloom -- book run --manifest project/source_manifest.json --store project/book.db --config model.yaml --workflow direct --max-concurrency 2 --output project/export
```

Omit `--workflow` for a new native task to select direct generation. Explicit
legacy planning/review flags select their supervised workflow. External workers
retain their existing adapter behavior. `--workflow supervised` selects the prior
pipeline; `--planning-mode source` remains available within that pipeline.

Resuming a stored run retains its original workflow, source plan, model, effort,
prompt, style, task context and explicit glossary. A different workflow requires a
new run. Core callers can opt in through `runBook({ workflow: "direct", ... })`;
calls without a workflow preserve the legacy API default for new stores.

Default source-window targets are 3,600 estimated source tokens, with a 4,800-token
packing limit and at most six immutable source blocks. Oversized single blocks
remain intact until capacity or structural output recovery requires paragraph
groups. Model output capacity includes reasoning, not just visible translation.
Use `--max-source-tokens`, `--max-blocks`, and `--max-concurrency` to set explicit
limits; the in-flight token limit is also enforced.

## Recovery and accounting

Provider responses are recorded before parsing and before committing their window.
A valid response or completed checkpoint can be replayed after interruption without
another provider call. Parallel results can be saved out of order; local window
promotion remains ordered and atomic. One failed request does not erase a sibling's
saved result. The run lease prevents concurrent writers.

Transient connection failures, timeouts and throttling receive bounded retries.
Retry due times and request counts are durable. The default allowance is eight
provider attempts per window, including structural fallback fragments; an explicit
`--max-attempts` may set a value from one to sixteen. Restarting does not reset these
counts. An explicitly increased `--max-attempts` applies to the same run and counts
all previous requests; successful saved subgroups are replayed without another call.
Existing transport grants keep their recorded base when the flag is omitted.
Increasing the attempt limit does not renew an existing token envelope.
Authentication, quota, TLS and unclassified failures are not automatically
retried. Cancellation interrupts waiting and prevents new dispatch.

Malformed or truncated multi-paragraph output is retried as smaller paragraph
groups, within the same window allowance. A successful sibling group is reusable.
The runner does not request an explanation or semantic review of the failure.

Each remote attempt has its own reservation, response evidence and settlement.
Incomplete usage stays unknown and consumes conservative budget; a later successful
retry does not make it known. Strict export still requires complete real usage.
Standard delivery retains accounting findings with structurally complete text.
An exhausted allowance yields `DIRECT_RECOVERY_PAUSED`, with earlier work retained.

### Explicit transport release

Read the current recovery boundary without making provider calls:

```sh
npm run folioloom -- book direct-recovery status --store project/book.db --run run-id
```

After correcting a connection problem, an explicitly authorized release may add
one to four attempts to one exhausted pending window, up to sixteen lifetime attempts.
Only windows whose recorded attempts all returned transport errors are eligible;
successful-but-invalid output, naming conflicts and missing response evidence
cannot receive this transport allowance. The original token envelope is unchanged.

Save a release JSON containing `requestId`, `windowId`, `expectedLastRequestId`,
`expectedIdentityHash`, `baseAttemptLimit`, `additionalAttempts` and `reason`.
Use the identity and last request from status, and retain the run's original base
attempt limit (eight by default; existing releases retain their recorded base).
Apply it without starting generation:

```sh
npm run folioloom -- book direct-recovery release --store project/book.db --run run-id --input release.json
```

The next ordinary `book run --run run-id` consumes only the saved remaining
allowance. Identical release requests are idempotent; stale references, changed
identities, mismatched base limits, conflicting IDs and active writer leases are
rejected. Historical requests, provider evidence, unknown usage and completed
translations are not altered. A later successful response does not unblock strict
accounting for historical unknown usage. This release is scoped to direct transport
recovery; it is not a semantic-review release or a provider-wide circuit coordinator.

## Incremental naming memory

New runs use `direct-translation-3`. The model classifies entries as person, place,
organization, work or distinctive term in the same response as the translation.
Each entry includes an exact source form, target, scope and short quote with a
source paragraph ID. Terms additionally include a concise sense. The program
checks the quote and source form against that paragraph and the target against
its aligned translation; it does not infer semantic categories from capitalization.
Ordinary words, uncertain entries and unsupported evidence are discarded without
another model call. Source matching is case-sensitive; aliases and inflections
remain independent. Up to 48 entries are allowed, not required. Unchanged shared
entries need not be returned again.

Stable person/place/organization/work entries become book-scoped naming constraints.
Distinctive terms are context-scoped preferences keyed by source and sense, not
global hard locks. The program cannot certify the model's semantic classification.
Comparison ignores paired outer title/quotation marks and, only for explicitly
possessive English source forms, a trailing Chinese possessive particle. This
comparison never rewrites translated prose or strips internal punctuation.

Each wave durably freezes its member windows and base names before dispatch. It
collects all drafts, then merges new names in source-window order; earlier accepted
book names and explicit glossaries retain precedence. All declared hard conflicts
in an affected window are repaired together against one frozen plan, within the
original attempt allowance. The next wave starts only after this wave completes.
Late entries from repair responses do not introduce new constraints into that plan.

Wave membership, naming plans, contexts, drafts and checkpoints survive interruption.
Resume can lower concurrency without changing a saved wave; its window limit must
cover that wave's unfinished members. A failed peer releases waiting workers while
preserving saved drafts. SQLite retrieves naming records, not all stored prose.

Stored `direct-translation-1` and `direct-translation-2` runs retain their original
prompts and identities. Protocol 1 keeps frozen names; protocol 2 keeps incremental
pairs and its refillable pool. Protocol-2 recovery checks all saved responses for
the same exact window, paragraph IDs and seed mode against current naming constraints,
even after its context hash changes. A compatible response can complete an exhausted
window without another call, token charge or refreshed allowance; the replay records
its original request provenance. Incompatible responses remain rejected.
Existing runs are not silently upgraded or rewritten. General semantic memory,
model-based revalidation and automatic issue closure remain supervised features.
Names are model-declared rendering evidence, not an exhaustive semantic guarantee:
omitted pairs, pronouns and ambiguous senses are not automatically resolved.
