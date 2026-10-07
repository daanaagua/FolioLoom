# Bounded native Pi supervision

FolioLoom embeds `pi-agent-core`. Native runs use the configured provider API directly;
they do not launch a coding-agent CLI. The supervisor and translation workers use the
same explicitly configured model. External workers remain an opt-in compatibility path.

## Responsibilities

Each native wave resolves lexical anchors before requesting its bounded translation
plan. Planning and generation share that terminology view; provenance-only revision
IDs do not create new semantic review work. Meaning, authority, identities and source
scope remain dependency-bound.

Primary paragraph-preserving generation groups up to 24 paragraphs or 2400 estimated
source tokens per call. It still submits exact-cover typed paragraphs. Recovery keeps
the smaller 10-paragraph/720-token limit and local bisection for failed units; source
boundaries, protected occurrences and capacity checks are unchanged.

At the final barrier, an unchanged grounded chapter finding can go directly to local
repair. Reuse binds the candidate, scoped terms, original findings, preloaded comparison
blocks and actual comparison queries, including empty query results. Legacy receipts
without those bindings take the normal review path. Repair authorization is never an
acceptance or closure receipt. Post-repair reviews use changed paragraphs, neighbors
and every open issue; ambiguous locations or structural changes require a full review.
The original repair direction survives into closure as a source-bound instruction,
not a global glossary lock or a vote against legitimate contextual variants.

Independent chapter slices and final repairs use the configured concurrency. Repairs
lock their output blocks and source-bound comparison dependencies. A failure stops
queued tasks and drains in-flight receipts before the store closes. Read-only card
reviews preload comparison evidence and do not request disabled search tools.

DeepSeek value tools publish positional array schemas using `prefixItems`; the host
retains strict tuple, evidence and disposition validation. Only when exactly one
existing issue is bound can its flattened closure row be losslessly wrapped locally.
This changes neither its semantic judgment nor the allowed statuses or repair scope.

Native runs can opt into `--chapter-review bounded` (default: `off`). After source
translation and terminology revalidation, this pass checks every chapter's paired
source and committed translation, including windows not selected by risk planning.
It checks meaning, referents, unsupported time shifts and contextual terminology;
it does not correct suspected source spelling/OCR errors or explain away ambiguity.
EPUB-wrapped headings are recognized without changing source blocks. Cross-chapter
windows retain both sides of the boundary; oversized chapters are split at complete
window boundaries within the same context capacity.

Chapter findings enter the existing local quality-repair queue. Coverage and findings
are committed together; ordinary resume reuses applied checkpoints and does not repeat
the chapter pass after its targeted repairs. Pending findings can be extended without
replacing earlier evidence or renewing a spent review credit. Checkpoints and repairs
share the existing lifetime review cap. The selected chapter-review policy is part of
run identity; enabled but incomplete coverage blocks strict export.

English lexical discovery reserves up to four of the existing sixteen candidate slots
for recurrent lowercase noun heads, such as institutions and places. These candidates
are source-spelled hints, not a spelling corrector or an automatic glossary. Model
classification retains contextual alternatives and produces preferences rather than
new hard constraints. Pronoun contractions do not consume this candidate budget.

The supervisor can search the registered source, read bounded Unicode-scalar ranges,
approve a contiguous batch, identify source-grounded translation guidance, and choose
which blocks need semantic review. Reviews can accept a candidate, request a minimal
repair with host-issued source/target reference IDs, or pause a checkpoint. The host
resolves IDs to exact text and validates block, version and visibility before a decision
can take effect. Historical quote-based decisions remain strictly validated on read.
Readable focus quotes may omit EPUB slot markers. The host maps a unique exact visible
match inside the selected reference back to the original marked span. It does not normalize
words, punctuation or case, search outside the reference, or accept ambiguous projections.
Canonical journal focus spans retain the original markers for repair and closure checks.

The kernel owns window boundaries, scheduling, account/model configuration, budgets,
validation, database writes, ordered promotion and export. Source text and tool results
are data, not instructions. No filesystem, shell, SQL or arbitrary delegation tools are
exposed to the supervisor.

Approvals cover up to four logical windows; the host reduces the batch before dispatch
when its context estimate exceeds model capacity. The controller gives each fresh decision
two model turns: one optional batch of evidence queries followed by a decision. The protocol
supports at most four turns and eight tool calls. DeepSeek planning uses a 32768-token
output ceiling; ordinary, chapter and final quality reviews use 65536 tokens, including
reasoning, through `max_tokens`. The native provider supplies a separate review envelope
within its documented 1M context/384K output capability; ordinary translation keeps its
37200-token default and conservative context envelope. Other models retain their declared
smaller caps; non-value native supervision retains its 8192-token ceiling. Admission uses
the same selected review model and output limit as dispatch. The provider limits are
documented in [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/).
Source search, source reads and committed-translation search share the same 12000-character
retrieval allowance. Results admit an ordered prefix of complete source evidence or paired
comparison hits before charging the ledger. Omitted references are not issued. Each result
reports truncation, remaining characters and whether queries are closed; a budget-closed
empty result is not a claim that no matching content exists. Once complete evidence cannot
fit, later queued queries return a closed result within the existing query-call allowance.
The next model turn exposes only the finalizer. The reserved final tool credit, model turn
cap and strict requirement for a valid submitted decision remain unchanged.
At that boundary, the wire request contains the original task and a read-only
`supervisor-decision-handoff-1` packet of completed query results. Query arguments,
exact evidence, truncation and errors remain visible as data; query-stage assistant
messages and tool-call history are not continued into the final decision. The full
original messages and provider usage remain in the audit journal. Evidence handles,
source/target permissions and semantic acceptance checks do not change. A failed
query is not evidence of absence and cannot authorize an invented conclusion.
The final stage still requires the selected finalizer or the explicitly configured
JSON channel. It does not add turns, reopen queries, clamp invalid arguments, switch
formats or synthesize an accepted tool receipt. Provider effort remains unchanged;
DeepSeek thinking-mode requests do not use unsupported forced `tool_choice` settings.
See the [DeepSeek API contract](https://api-docs.deepseek.com/api/create-chat-completion/).
Each checkpoint has two attempts per explicit release generation.
Ordinary reviews have three attempts per scoped terminology dependency; final quality items
keep their own three-attempt budget. All reviews share a twelve-attempt lifetime window cap.
Repair requires a remaining follow-up review credit before dispatch. Ordinary resume cannot bypass a paused checkpoint.
An explicit release is an operator action, not automatic model recovery.
It renews the ordinary checkpoint and its automatic-recovery scope under the same
durable generation; historical faults and run/lifetime ceilings remain in force.
An ordinary release cannot renew a final-quality-review epoch.
Repeated identical tool errors stop after two occurrences. A retry spends the original
checkpoint baseline instead of adding a new baseline allowance.

DeepSeek decisions use the `folioloom-supervisor-values-tool-1` transport while retaining bounded
source-query tools. A request-bound host frame supplies short integer handles for blocks and
issued evidence. The native `submit_supervisor_values` finalizer accepts one `values`
argument, with no other keys. The host does not parse decisions from ordinary prose.
Inside this argument the model returns exactly four positional values: planning uses
`[prefixCount, reviewBlocks, guidance, reason]`, and review uses
`[action, issues, dispositions, reason]`. New guidance rows contain
`[currentSource, referenceSourceOrNull, instruction]`. The first handle must select an
original current-batch passage inside the approved prefix. The optional second handle
may cite any issued source passage as read-only support; it never expands translation,
review or repair scope. Source queries expose `inCurrentBatch` and `referenceOnly`.
Canonical guidance retains the current `blockId`/`sourceRef` and an optional immutable
`referenceEvidence` record. Translation workers receive both roles explicitly, and
distinct instructions on the same current passage remain separate. Historical
`[source, instruction]` input remains readable with its original strict scope checks;
out-of-scope references are never silently relocated to a guessed current passage.
The model-facing schema advertises only the explicit three-field guidance row;
issue rows contain `[source, targetOrNull, problem]`. Prior-issue dispositions preserve the
host's order and contain `[status, source, target, note]`. Identity, versions, exact quotes
and evidence ranges are reconstructed by the host, not copied by the model. These bound
ranges also locate repair targets when identical paragraphs occur more than once.

The host rejects wrong lengths/types, unissued or wrong-side handles, cross-block evidence,
stale frames and extra prose before applying the existing canonical decision validation.
It still checks scope and every prior-issue disposition. Bounded retries receive a concise
validation error without changing the checkpoint baseline. The wire version is journaled
separately from the canonical protocol; historical decisions and dependency hashes remain
readable. Other providers retain the native canonical decision tool. Explicitly selected
JSON-object transports remain available and strictly parsed; provider JSON mode does not
waive host syntax validation. There is no format-guessing fallback or JSON auto-repair.

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

A valid all-null or identical-text semantic patch is a candidate-bound no-change
proposal, not a malformed response or a successful repair. Standard delivery retains
the original finding in its pending quality queue for grounded book-end closure.
No repaired candidate is created and no identical ordinary review is repeated.
Real unresolved findings still block strict export; malformed and stale patches
retain their existing rejection behavior and actual usage accounting.

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

### Concise issue closure and provisional names

Book-end review receives the original issue IDs and evidence. Each issue gets one
disposition: `fixed`, `dismissed`, `variant`, or `unresolved`, with a one-sentence note
of at most 160 characters and host-issued evidence references. A fixed finding requires
a change to its quoted problem text, not merely a different window hash. Under closure
v2, one grounded current-candidate judgment can dismiss a false positive or accept a
contextual variant. These classifications explain the decision; they do not require a
second model vote or matching labels. Concrete new issues remain separate repair work,
and an explicitly unresolved finding stays open. The existing review limits do not grow.
Historical v1 receipts retain their original verification contract. The storage transaction
checks candidate-bound receipts; an empty new issue list cannot erase old findings.
Reports distinguish actual repairs from false positives and justified variants.

Each prior issue carries host-computed change evidence and allowed disposition states.
`revise` is a proposal, not an applied edit. If a grounded correction request mistakenly
labels that same unchanged issue `fixed`, submission recovery retains it as `unresolved`
with a host-authored explanation and sends it through the existing bounded repair pass.
Every submitted reference, note, issue identity and source overlap still validates.
An `accept` decision cannot use this recovery; unchanged fixes remain invalid canonical
receipts. Raw provider responses and actual usage are retained. Variant judgments require
a concrete contextual, semantic or scoped-name reason, not merely several existing spellings.
Neither review credits nor automatic retry limits increase.

During final rework, original findings remain immutable closure input. Repair execution
may refresh a stale target reference only from the current candidate's validated review
evidence with overlapping original source scope. Missing current evidence stays unresolved;
old references cannot silently authorize a different paragraph or a wider patch.
An empty new-issue list is distinct from an empty work queue: a `revise` decision may
reuse existing unresolved findings when its current source/target references are grounded
in the original issue. Missing current evidence still cannot authorize repair.

Current surface evidence uses matching complete source and target paragraphs. When
paragraph alignment is unavailable, no unrelated target prefix is substituted as evidence.

Final quality review can query `search_target` by a source form or translated form.
The host snapshots committed translations in this project and returns at most four
read-only comparison hits, each with bounded source/target excerpts and a translation
hash. Equal paragraph counts permit paragraph-position context; otherwise the result
is explicitly block-only. These excerpts do not issue candidate evidence handles or
authorize edits outside the reviewed window. The snapshot binds the final decision's
cache identity and value frame. Queries share the existing evidence/tool budget and
close before the final decision turn; missing evidence must remain unresolved.

Names, forms of address and technical terms can retain provisional source/translation
observations, separate from locked terminology and entity aliases. The host records
only target forms present in the candidate; unknown realizations remain unknown.
Repeated evidence is reused, while a new explicit naming cue can reopen a contextual
decision. Bounded supervision compares changed realizations against compact prior
evidence, including parallel sibling windows at the commit boundary. Scoped rendering
rules remain authoritative; sharing an entity does not make a nickname interchangeable
with its formal name. Unrelated observations are excluded from request-local review.

A single recurrent lowercase noun can enter the existing bounded anchor path.
Technical classifications and host-discovered ordinary nouns retain occurrence-grounded
surface memory, independently of model self-ratings. A unique attested rendering
can be offered as a soft preference; multiple attested senses remain evidence without
one universal preferred rendering. Missing technical-term receipts remain unknown.

Typed translation calls include bounded host-issued surface occurrence IDs. Their same-call
receipts report actual renderings, including new renderings absent from anchor proposals.
The host checks the target paragraph, retains each occurrence independently, and leaves
missing or invalid receipts unknown. These observations never create hard locks. Changed
candidates cannot move a stale receipt into an unrelated paragraph. Unknown mappings may
be reconsidered with new source evidence; identical semantic evidence is reused.

Paragraph fragments request receipts only for owned source occurrences, never context-only
neighbors. Target paragraph coordinates are local to the fragment; retained occurrence IDs
and paragraph indices stay global through refinement and assembly. Fragmentation, receipt
grounding and delta review share semantic paragraph spans, including CRLF and certified scene
separators. Trailing whitespace does not create a paragraph; real merges still require full review.

Usage completeness requires a metered response for every actual model call and matching
aggregate counters. Local turn-limit messages are not provider responses. A positive total
cannot conceal an unmetered failure; unknown usage still blocks strict export and retry.

After a durable full review, repairs and dependency changes use changed paragraphs, relevant
terms, still-open issues and adjacent paragraphs. Structural mismatch falls back to full
review. Cache reuse requires exact candidate text, scoped dependencies and surface evidence.
Large journal payloads omit the optional delta base and use full review instead. A compact
source-only concordance accompanies cross-window surface questions; source facts and target
rendering conventions remain distinct. Existing unambiguous term receipts can resolve
compatible revalidation without another model call.

Quality mode retains its configured reasoning level (high by default), including active
scheduling; only explicit fast mode enumerates lower-effort alternatives. Historical
protocol-only surface records and untyped function-word noise are excluded from replay.
The store's generation-checked derived-surface quarantine appends superseding revisions
and a fresh snapshot without deleting original observations, translations or usage history.

### EPUB text patches and explicit quality rework

Semantic repairs of structurally valid EPUB candidates use `submit_epub_text_patch`.
The host issues editable text slots for the evidenced paragraphs and provides neighboring
paragraphs as read-only context. Each patch binds the candidate hash, block, slot and
expected text. The host applies the complete patch atomically while preserving the original
markers and separators. Duplicate slots, stale candidates, out-of-scope edits and marker
injection are rejected. Structural recovery and non-EPUB repair retain their existing paths.

Inspect final quality items with `book quality status --store <store> --run <id>`.
An unresolved or interrupted item can be explicitly reprocessed with
`book quality rework --store <store> --run <id> --input <request.json>`, followed by
the original `book run` resume command. The request contains exactly `itemId`, `requestId`,
`expectedRecordId`, `expectedCandidateHash` and a nonempty `reason`; the status command
provides the item and record identities. Rework schedules repair/review but does not call
a model or approve export itself.

Rework requires an idle run lease and a matching active candidate. Request IDs are
idempotent; conflicting reuse is rejected. Original issues, closure decisions and usage
remain in the append-only journal. At most two explicit rework rounds are accepted for an
item, with room required for the bounded review cycle inside the unchanged twelve-review
lifetime window limit. Ordinary resume never replenishes a finalized quality credit.

### Task context and resume

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

Review evidence is projected as complete semantic paragraphs. Delta review selects
the same paragraph positions on both sides, including changed text, open issues and
neighbors; it does not select intersecting character slices that can expose different
sentence tails. Full review supplies the complete scoped source and candidate, with
capacity checked before dispatch. Existing short-range evidence remains readable in
historical decisions and repair plans alongside the new paragraph-bound references.
Review receipts bind the evidence-projection version, so older sliced decisions cannot
silently satisfy a fresh complete-paragraph review.

Bounded retrieval remains distinct from complete review. Source queries expose their
visible scalar range; committed-translation previews report leading/trailing truncation.
Short paragraphs remain whole. Translation evidence and lexical context windows retain
the matched term instead of always taking the beginning of a long paragraph. Recovery
previews preserve Unicode scalars and propagate their original excerpt boundaries.
These changes do not increase query, retry, model-output or lifetime-review limits.

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

Final quality review uses occurrence-bound cards: the historical finding and old
wording are separated from the current paired paragraph. The host binds each old
issue to its original occurrence; ordered-value closure rows need only a status and
a short reason. A different occurrence is a new finding, not a new location for an
old issue. The current grounded repair direction reaches the repairer separately
from the historical allegation and is retained during post-repair review.

Comparison excerpts are prefetched locally from source terms attested in the
findings, within the existing 12,000-character allowance. They are observations,
not a majority-vote dictionary or hard terminology locks. Final card review exposes
only the submission tool, avoiding a query/submit transition. Ordinary generation,
reasoning effort and contextual variation are unchanged. Existing four-value
closure rows remain readable and subject to the same grounding checks.

Standard delivery separates complete-text availability from strict assurance.
Pending or blocked semantic reviews and unconverged terminology remain in the
quality report; an exhausted final-review protocol retains committed text and does
not restart a book. Source/structure corruption, missing coverage and broken export
evidence still block delivery. Unknown historical usage is reported but does not
block standard output; it still blocks strict export. A metered current response
can use its existing bounded protocol-recovery credit without erasing an older
unmetered response. Authentication, cancellation and provider failures are not
converted into semantic warnings.

Native value finalizers require an actual validated tool call. If a model ends with
ordinary text while session credit remains, it receives one explicit channel reminder
in the same conversation. The original response and evidence remain intact; the host
does not parse prose as a receipt or select an acceptance verdict on the model's behalf.
The reminder consumes an existing turn and shares the original deadline and token
reservation. Errors, truncation, cancellation and exhausted budgets do not trigger it.
Repeated text-only output remains a protocol failure.

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
