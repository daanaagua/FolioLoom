# Direct translation

New native CLI and desktop full-book tasks use the direct workflow. The host plans
source windows once. Each response supplies its translation and optional short
names grounded in that window's source and translated paragraphs. Accepted names
are recorded in SQLite and relevant entries are supplied to later windows in a
fixed concurrent waves. An explicit input glossary takes precedence, with block
scopes preserved; it does not disable discovery of other names.

The normal path uses one response per planned paragraph group. It has no tool-calling supervisor,
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

## Versioned naming corrections

New native runs use `direct-translation-5`. Existing protocol 1–4 runs retain their
recorded prompt and identity. Protocol 3 also preserves accepted local wave-plan
names when a repair omits unchanged entries, provided their source evidence and
rendering still match the final paragraph.

Protocols 4 and 5 include three bounded naming fields in the normal translation response:

- `names`: new typed entries with source evidence and a local ID, up to 48.
  An optional entity `sense` distinguishes explicitly different referents.
- `nameUses`: exact target substrings, occurrence numbers and source quotes tied
  to a shared name ID or a new local ID, up to 256. These become validated position
  receipts; they are not permission to replace all matching text.
- `nameChanges`: a shared name ID, expected revision, proposed rendering, source
  evidence and a short reason, up to eight. A matching position receipt is required.

All members of a wave use one frozen catalog. Responses and proposals are saved
before publication. A single supported rendering can advance a model-learned book
name's revision; competing proposals, stale revisions, invalid evidence and missing
receipts remain recorded for inspection. User-owned glossary entries cannot be
overridden. No independent planning, semantic review or naming-judgment call is made.

Before publication, the coordinator changes only attested target ranges. Peer
drafts use the settled rendering. Historical blocks with reliable receipts receive
new translation versions; original provider responses and previous versions remain
intact. Overlapping ranges, changed text, missing receipts and structural-slot
violations prevent broad rewriting. Unresolved cases remain visible rather than
starting another model review. A literal quote and an exact position establish
traceability; they do not prove that the model's interpretation is correct.

Catalog publication and historical local edits share one SQLite transaction.
The persisted plan makes publication idempotent and crash recovery reuses saved
drafts. Export waits for unfinished wave publication. Pending naming observations
are available separately; strict export continues to certify structure and actual
usage, not exhaustive semantic agreement.

Inspect effective names, decisions, pending observations and local patches without
calling a provider:

```sh
npm run folioloom -- book direct-naming status --store project/book.db --run run-id
```

Protocol-four stores require a reader supporting their revision events. Opening an
older run does not upgrade it or retrospectively rewrite its translations.

Protocol 5 uses short request-local shared IDs (`n0`, `n1`, ...) and compact
`nameUses` arrays. `["n0", "p2"]` asserts the semantic association; the host derives
positions only when the expected target appears exactly once. Repeated targets
require `["n0", "p2", null, 1]` with an explicit occurrence number. A different
rendering replaces `null`; homonymous catalog referents require a fifth field
containing a distinguishing source quote. Invalid or ambiguous receipts remain
observations, not automatic edits. Terms must use `scope=context` with a sense;
person/place/organization/work entities use `scope=book`.

For a continuation, `--naming-reference names.json` accepts a private file:

```json
{"schema":"folioloom-naming-reference-1","names":[{"source":"Heron Isle","target":"赫伦岛","kind":"place","scope":"book"}]}
```

These are model suggestions, separate from the user-owned `--glossary`. Only
literal source forms present in the current physical request are supplied, and
current catalog entries take precedence. Foreign paragraph evidence, versions
and user authority are not imported. The model must attest a new entry to the
current source before it enters the catalog. The normalized reference list is
part of run identity and must be supplied unchanged on resume. Do not place
an entire naming catalog inside a free-form style or task-context field.

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
remain intact in the logical commit plan. Protocol 5 proactively divides physical
requests at original paragraph boundaries, with at most 24 paragraphs per request
and an estimated visible-output limit of the smaller of 6,000 tokens or one quarter
of the model output capacity. Estimates account for source length, EPUB markers
and naming occurrences. Single oversized paragraphs are not cut internally.
The remaining output capacity reserves room for reasoning; estimates do not
guarantee that every model response will fit.
Use `--max-source-tokens`, `--max-blocks`, and `--max-concurrency` to set explicit
limits; the in-flight token limit is also enforced.

## Recovery and accounting

Provider responses are recorded before parsing and before committing their window.
A valid response or completed checkpoint can be replayed after interruption without
another provider call. Parallel results can be saved out of order; local window
promotion remains ordered and atomic. One failed request does not erase a sibling's
saved result. The run lease prevents concurrent writers.

Transient connection failures, timeouts and throttling receive bounded retries.
Retry due times and request counts are durable. Protocols 1–4 retain the default
eight total provider attempts per window, including successful fallback fragments.
Protocol 5 instead defaults to eight failed attempts per logical window. Successful
validated fragments do not spend failure credits. `--max-attempts` accepts one to
sixteen for the selected protocol. Saved responses are replayed before dispatch.
The protocol-five failure limit is retained when the flag is omitted on resume.
Each protocol-five window also receives a fixed token budget before its first
request, based on its initial request estimate times the initial allowance, plus
a hard call guard of `min(256, 2 * paragraphCount + initialAllowance)`. All calls,
including successes, consume this budget. Missing usage is charged conservatively.
Neither restart nor a higher failure limit renews the saved token budget or call
guard. `DIRECT_TOKEN_BUDGET_EXHAUSTED` stops before an unaffordable next request.
Existing transport grants keep their recorded base when the flag is omitted.
Increasing the attempt limit does not renew an existing token envelope.
Authentication, quota, TLS and unclassified failures are not automatically
retried. Cancellation interrupts waiting and prevents new dispatch.
Native fetch failures with a recognized socket, DNS or connection error retain
an allowlisted transport code and the pre-response phase as `PROVIDER_TRANSPORT`.
These pause the run instead of repeatedly consuming failure credits as generic
provider-busy errors. Raw request objects, credentials and socket addresses are
not copied into the error. HTTP 429 and service-busy responses retain bounded
recovery; a connection failure with missing usage remains unknown.

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

### Explicit token budget extension

For protocol 5, `book direct-recovery extend-budget` appends an explicitly
authorized token grant to one pending window. It does not renew failure credits,
the call guard, or any other window's budget. The original `generation_budget`
record remains unchanged; status reports `baseTokenLimit`, `additionalTokens`
and the effective `tokenLimit` separately from `chargedTokens`.

Save a JSON request with `requestId`, `windowId`, `expectedLastRequestId`,
`expectedIdentityHash`, `expectedTokenLimit`, `additionalTokens` and `reason`.
Use the current identity, last request and effective token limit from status.
The addition must be an integer from 1 to 1,000,000 tokens per request.

```sh
npm run folioloom -- book direct-recovery extend-budget --store project/book.db --run run-id --input budget-extension.json
```

Applying the same request again returns the original grant without adding tokens.
Changed request IDs do not bypass stale last-request or token-limit checks.
Active writer leases, completed windows and protocols 1–4 are rejected.
Grants persist across restart and keep their original attribution and amount.
They permit subsequent generation within the combined ceiling, but never erase
conservative charges or reconcile unknown provider usage. Strict export continues
to require complete real usage.

## Incremental naming memory

Typed naming, introduced in `direct-translation-3`, classifies entries as person, place,
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
