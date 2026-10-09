# Durable provider-interruption recovery

Status: proposed architecture; the current implementation retains the existing
bounded recovery policy. This specification does not change run identity or
authorize automatic provider, model, account, or reasoning-effort substitution.

## Objective

A transient provider outage must not discard completed translation or require an
operator to restart the entire pipeline. A running process resumes eligible work
automatically within explicit time, attempt, and token limits. After a process
restart, the same run resumes from durable checkpoints and observes the same
limits. Persistent outages produce a resumable operational pause with a concrete
reason and next eligible action.

“Resume” means replay of an uncommitted logical operation, not continuation of a
partially received token stream. Without provider-side request retrieval or
idempotency guarantees, exactly-once remote execution cannot be promised.
Exactly-once local commit is mandatory.

## Existing foundation and failure path

- Source/run identity, run leases, window state, candidate checkpoints, chapter
  receipts, quality items, provider-response evidence, and token events are durable.
- `TokenLedger` already charges an incomplete settlement at the greater of known
  usage and its reservation. Actual usage remains distinct from this conservative
  budget debit; incomplete usage blocks strict export.
- `AutomaticRecovery.providerRetry` currently requires complete per-response usage.
  `SupervisionController` repeats that condition; translation recovery additionally
  requires globally complete historical accounting. An unmetered connection error
  therefore bypasses otherwise eligible transient recovery.
- Supervisor `started` records currently consume checkpoint/review attempts even
  if the provider fails before producing a usable semantic result.
- `QualityQueue.recoverInterrupted` currently turns an interrupted `reviewing`
  item into `blocked`, retaining its bounded attempt. Restarting the run drains
  other pending items but does not itself resume that interrupted item. A typed
  quality rework is currently required; the proposed coordinator must retain an
  operational retry state without treating interruption as a semantic failure.
- Anchor resolution, translation/repair, supervision, revalidation, and final
  quality work have different error paths. Fixing only final review would leave
  equivalent interruption failures in other phases.
- Existing recovery claims survive restart, but their sleep does not have a
  durable due time. Existing exhausted fault scopes are hard stops; they are not
  a provider-wide cooldown circuit.
- Crash reconciliation currently places the reservation estimate in the
  incomplete settlement's `actualTokens` field. The new journal must distinguish
  observed usage from conservative budget debit even on this recovery path;
  estimates must never appear in a sum labelled provider-reported tokens.

## Invariants

1. Source, manifest, configuration, task context, backend, model, effort, prompt,
   planner identity, and glossary identities must match before recovery dispatch.
2. One live writer lease owns a run. A transaction commits a candidate and its
   checkpoint advancement together, guarded by the expected dependency hash.
3. Completed, unchanged windows and accepted, unchanged review scopes are reused.
   Only unfinished or dependency-invalidated work is scheduled.
4. A remote attempt has a unique attempt ID, reservation, dispatch marker, response
   evidence when available, and settlement. A retry gets a new attempt ID.
5. Unknown usage is never converted to zero, inferred from generated prose, or
   silently reconciled by a later successful response.
6. Transport retries do not mint token baseline, erase historical errors, increase
   semantic repair limits, or renew credits merely because a process restarted.
7. Cancellation interrupts waiting and prohibits new dispatch. An explicit pause
   is never treated as a transient network failure.
8. No automatic fallback to another provider, model, credential, or TLS policy.

## Failure classification

| Failure | Automatic action | Durable result |
| --- | --- | --- |
| Connection reset/loss, interrupted stream, temporary DNS failure, recognized 502/503/504 | Bounded transport retry | Attempt settlement plus scheduled retry |
| 429 rate limit | Honor validated `Retry-After`; otherwise backoff | Shared provider cooldown |
| Per-request timeout | Retry only if the run is not cancelled or past its overall deadline | New attempt; old one remains accounted |
| Authentication, permission, exhausted quota/balance, invalid endpoint configuration, TLS/certificate failure | No automatic retry | `attention_required` with categorized reason |
| Unknown/unclassified error | No blind retry | Preserved checkpoint and diagnostic category |
| Invalid JSON/schema/tool result | Existing bounded protocol recovery | Protocol credit, not transport credit |
| Grounded semantic defect | Existing bounded repair/review | Semantic credit, not transport credit |
| Local storage, source identity, integrity, or token-envelope failure | No provider retry | Existing fail-closed boundary |

Prefer structured SDK status/code and cause-chain data. A narrow message classifier
is a compatibility fallback. Never classify an authentication/quota/TLS error as
transient merely because an outer wrapper says “connection error.” Logs redact
secrets, endpoints containing credentials, and source/prompt contents.

## Durable records and state

Add a versioned operational recovery journal. Keep it separate from semantic
supervision and the existing audit of actual token usage.

- `operationId`: stable hash of run, phase, logical scope, source identity, and
  dependency identity. Phases include anchoring, planning, translation, repair,
  window review, chapter review, revalidation, and quality closure.
- `attemptId`, `attemptOrdinal`, `reservationId`, `startedAt`, and optional
  `responseEvidenceIds`; references, not duplicated prompt or source text.
- `failureClass`, `retryable`, `usageState` (`complete` or `unknown`), and sanitized
  diagnostic code. Classification is host-owned, never model-authored.
- `state`: `ready`, `in_flight`, `retry_wait`, `paused_outage`,
  `attention_required`, `succeeded`, or `cancelled`.
- `nextAttemptAt`, `firstFailureAt`, `consecutiveFailures`, `lifetimeAttempts`,
  `policyVersion`, and provider-circuit identity.
- `leaseGeneration`/fencing token and dependency hash protect against stale writers.

Persist `retry_wait` and its due time before sleeping. Waiting does not hold a
SQLite transaction or a request-concurrency slot. The run lease remains heartbeated
while its process owns the scheduler. A restarted process checks the due time
instead of starting the delay from zero or sending immediately.

At startup, reconcile a previous `in_flight` attempt before scheduling:

- no durable dispatch marker: release only a proven unlaunched reservation;
- dispatched with a durable complete response: validate/reuse the response or
  candidate when its identity still matches, without recontacting the provider;
- dispatched without a recoverable complete response: settle unknown usage
  conservatively and schedule a new attempt if policy and budget permit;
- committed result: reuse it; never dispatch merely to recreate a receipt.

The local dispatch marker precedes the remote call. A crash between those events
is ambiguous and must remain conservatively unknown unless independently proven
unlaunched. A crash after a local commit cannot make that commit disappear.

## Retry policy and provider-wide circuit

Persist the selected policy with the run. Proposed initial defaults:

An attempt here is one phase execution/session, not one streamed chunk. Existing
per-session turn/output limits still bound its individual provider requests. Each
actual response retains its own evidence and usage; replaying a failed session
does not discard usage from earlier successful responses in that session.

- At most four automatic retries per logical operation, five remote attempts in
  total, including pre-crash attempts; at most 128 recovery attempts per run.
  Protocol/semantic recovery must also fit the operation's total dispatch limit;
  separate fault counters are additional ceilings, not multiplicative allowances.
- Retry waits: 2, 8, 30, and 90 seconds, with persisted ±20% jitter. A validated
  `Retry-After` is a lower bound, not permission to exceed the run deadline or
  the recovery window. If it exceeds those bounds, enter `paused_outage`.
- At most 15 minutes of recovery elapsed time for an operation, including request
  time and time across restarts. The overall run deadline and token envelope are
  independent hard ceilings.
- After three consecutive transient failures across the same run/provider
  identity, open the circuit for at least 30 seconds. Permit one half-open real
  operation, not an extra paid health-check request. On repeated failure, double
  the circuit wait up to five minutes, still within the recovery window.
- An open circuit holds new work for that provider. Already in-flight operations
  may finish and commit. A successful half-open operation closes the circuit;
  historical unknown usage and lifetime attempt counts remain unchanged.

Circuit coordination is initially per run and provider identity. Cross-run or
cross-process account-wide coordination is a separate feature; credentials are
never used as journal keys or written into recovery records.

When automatic limits are reached, pause durably instead of marking translated
content as failed or human-required. An ordinary resume observes the pause and
cannot renew credits. An explicit typed recovery-release operation can create a
new recovery epoch after the cause is addressed; it must record the reason,
scope, bounded allowance, and any explicit token-envelope amendment. It cannot
erase old attempts, reset lifetime caps, or approve semantic defects. Existing
supervision release and quality rework commands keep their separate meanings.

## Integration boundaries

Introduce one host-owned `ProviderRecoveryCoordinator`. Each phase adapter supplies
its operation identity, attempt execution, accounting settlement, checkpoint
read/commit, and cancellation signal. The coordinator owns classification,
durable retry scheduling, circuit state, and operational pauses. It does not
translate, judge semantic quality, or commit arbitrary model tool side effects.

All remote retries happen outside an individual provider session. The SDK's hidden
retries remain disabled. A phase may keep internal protocol recovery, but its
transport retry must be owned by the coordinator to prevent multiplicative loops.

Supervisor transport failures get separate durable transport attempts. Only an
attempt that reaches semantic/protocol evaluation consumes the corresponding
semantic/protocol budget. Unique remote-attempt IDs still include every failed
transport attempt. No retry replenishes the original token baseline. Existing
legacy records retain their original conservative attempt interpretation.

Partial translation text is never committed as a complete window. A complete,
validated candidate is saved before review; review interruption resumes from that
candidate. Quality repairs and chapter judgments retain their dependency guards.
If a sibling changes a dependency during the wait, discard only the stale
authorization and schedule against the current durable candidate.

## Status and delivery

Proposed public interface:

- New runs select `--recovery-policy durable-v1`; omission preserves legacy
  behavior until default enablement. Policy identity is checked on resume.
- `book recovery status --store <store> --run <id>` is read-only and returns
  operation states, due times, failure categories, remaining limits, and circuits.
- `book recovery release --store <store> --run <id> --input <request.json>` is an
  explicit mutation. Its request contains `requestId`, `operationId`,
  `expectedRecordId`, `expectedDependencyHash`, `reason`, and the requested bounded
  `additionalAttempts`. Duplicate identical requests are idempotent; stale or
  conflicting requests fail. An active writer lease rejects the mutation.
- Release re-arms the specified operation only. It does not start a detached
  process; the next foreground `book run --run <id>` resumes execution. Any token
  envelope amendment uses a separate explicit authorization, never an implicit
  effect of recovery release.

Status must distinguish content progress, operational recovery, semantic quality,
and accounting completeness. CLI and desktop show the current phase, preserved
completed scopes, retry ordinal/limit, next attempt time, pause reason, and unknown
usage count. They must not show a recoverable outage as “translation completed”
or a semantic issue as a network failure.

Standard delivery may export structurally complete text with existing explicit
quality/accounting findings. Strict delivery continues to require all existing
quality, knowledge, coverage, and actual-usage checks. A successful retry changes
operational progress, not strict accounting eligibility.

## Verification and rollout

Use deterministic clocks, persisted jitter, and injected provider streams; fault
tests must not require a live provider or actual outage.

1. For every phase, interrupt before the first token, mid-stream, and after a
   complete response. Recover transient cases, preserve actual/unknown usage,
   and issue no duplicate local commit.
2. Crash at reservation, dispatch, evidence save, candidate save, retry scheduling,
   and commit boundaries. Reopen the same SQLite store and verify scope reuse,
   due times, attempt counts, fencing, and ledger reconciliation.
3. Interrupt one of two concurrent operations. The other operation's valid work
   survives. An open circuit prevents new dispatch and permits only one half-open
   attempt; concurrent failures cannot consume or create duplicate retry credits.
4. Cancellation during retry wait returns promptly and cannot send another call.
   Authentication/quota/TLS/unknown faults never enter automatic retry.
5. Transport, protocol, and semantic faults have independent bounded counters;
   combined faults cannot multiply attempts or mint baseline tokens.
6. Active token admission continues to charge incomplete attempts conservatively.
   A later success leaves strict export blocked by the old unknown usage.
7. Completed runs resume with zero provider calls. Changed source/configuration or
   dependencies cannot reuse incompatible checkpoints or approvals.
8. Exhaustion produces a durable operational pause. Ordinary restart adds zero
   calls; explicit release records a bounded new epoch without clearing history.
9. CLI/desktop render waiting, outage pause, attention-required, and completion
   consistently; all labels derive from durable state.

Roll out as a new opt-in recovery-policy version, first with coordinator/store and
fault tests, then all phase adapters, then CLI/desktop presentation. Default
enablement requires the cross-phase fault matrix and migration tests to pass.
Existing runs without the version keep legacy recovery unless an explicit,
audited policy migration is requested. No in-place silent policy replacement.

## Non-goals

- Byte-offset continuation of a provider's token stream.
- Fabricating missing usage or declaring unknown attempts free.
- Infinite retries, detached daemons, or automatic host restarts.
- Automatic credential repair, billing changes, provider switching, or TLS bypass.
- Renewing semantic quality budgets to force acceptance.
- Guaranteeing zero duplicate provider billing after an ambiguous disconnect.
