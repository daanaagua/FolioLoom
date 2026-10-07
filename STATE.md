# FolioLoom current state

- Date: 2026-10-07 (Asia/Shanghai). Code version: v1.9.0.
- Final supervisor turns receive the current task and a readonly evidence handoff,
  not the prior query conversation. Original receipts remain in the journal;
  evidence handles, native finalizers, provider effort and bounded budgets stay intact.
- Planning guidance separates an explicit current-passage target from optional
  read-only source support. Retrieval marks scope; issued-reference, approved-prefix
  and immutable-source checks remain strict. Historical guidance remains readable.
- Current-target/reference separation survives cached plans and translation request
  packing; distinct instructions on the same passage remain separate.
- Two-stage execution now anchors before planning, groups primary typed paragraphs
  at 24/2400, reuses unchanged grounded chapter findings for repair, and applies
  dependency-safe final deltas. Independent final tasks use configured concurrency;
  comparison locks and failure draining protect evidence and durable accounting.
- Value-tool schemas use the DeepSeek array dialect with strict local validation;
  single-issue row framing avoids a redundant correction round. Read-only closure
  cards retain repair directions and do not request disabled retrieval tools.
- A 270-word/14-paragraph native high-effort smoke passed strict audit, EPUB/export
  verification and zero-call resume. The unchanged-error closure probe used one call.
- Model self-ratings are no longer requested or used for lexical, research or
  translation-memory admission, reuse and ranking. Contextual senses and variants
  remain explicit; historical revision IDs and audit payloads remain readable.
- Chapter review splits into at most four contiguous windows before dispatch.
  Proven legacy pre-dispatch scope failures receive append-only ledger corrections;
  unknown provider usage remains incomplete. Recurrent ordinary nouns retain
  source/target receipts, and bounded chapter hints compare legacy realizations.
- Specialized-word memory now persists sense/scope/source-backed soft preferences,
  reuses them across restart and enumerates all exact source occurrences in audit
  and quality reports. Manual rules remain authoritative; deferred translation
  issues do not discard source-grounded preferences or permit arbitrary memory.
- Final review compiles occurrence-bound before/current cards and bounded comparison
  evidence locally. Ordered-value closure binds old issue positions in the host;
  new occurrences remain separate findings. Current repair directions are retained.
- Standard delivery exports complete validated text with open quality/terminology
  findings and unknown historical usage reported separately. Strict assurance stays
  independent; source, coverage, provenance and export-integrity gates remain hard.
- Metered current responses retain the original bounded protocol-recovery credits
  despite old unknown usage. Exhausted final semantic review preserves complete text.
- Supervisor retrieval shares one remaining-evidence budget across all query tools.
  Whole results are admitted before charging; exhaustion closes queries explicitly
  while preserving the original final-decision credit and strict receipt checks.
- Grounded repair proposals cannot claim unchanged text as a completed fix. Native
  submission recovery retains those issues as unresolved for the bounded repair pass;
  canonical acceptance, evidence grounding and review-credit checks remain strict.
- DeepSeek review has a separate 65536-token output envelope, shared by admission and
  dispatch. Planning stays at 32768; ordinary generation keeps its existing defaults.
- Final rework keeps original issues but binds repair execution to current validated
  evidence. Missing current grounding cannot authorize stale or expanded text patches.
- Grounded unresolved findings can request repair without duplicating them as new
  issues. Empty new findings do not erase the existing quality queue.
- Native providers share process-local environment proxy settings and a read-only
  startup check. TLS failures retain their transport code and cannot be retried or
  hidden by model-list fallback. Local endpoints bypass proxies; certificate trust
  is unchanged. See [provider networking](docs/provider-network.md).
- Native runs can opt into bounded chapter-wide source/translation review. EPUB
  headings are recognized without rebuilding source blocks; findings and coverage
  commit atomically into the existing quality queue. Applied checkpoints survive resume.
- English discovery adds up to four recurrent lowercase noun candidates within the
  existing sixteen-slot budget. They remain soft preferences; source spelling/OCR
  correction and speculative identity merging are excluded.
- Source-grounded technical terms retain occurrence-grounded provisional memory
  without concept promotion or hard locks. Multiple attested senses remain distinct.
- Valid no-change semantic repairs preserve the candidate and original findings;
  standard delivery routes them to grounded quality closure, not automatic acceptance.
- Quality closure now preserves each original issue and distinguishes fixed,
  dismissed, contextual-variant and unresolved outcomes. Evidence notes are capped
  at 160 characters. One grounded current-candidate judgment can close a false
  positive or contextual variant; classification labels are not consensus ballots.
- Weak names and forms of address have provisional, source-grounded observations.
  Cross-window checks cover resumed and parallel sibling windows without turning
  nicknames into locked identity aliases. Scoped rendering rules remain authoritative.
- EPUB slot IDs are excluded from name concordance and provisional-memory replay.
- Verification: 1359 core tests passed with one Windows environment skip; core and
  desktop type checks and the production desktop build passed.
- Storage remains schema v5. Existing finalized quality records remain readable;
  current writes require candidate-bound closure receipts.
- Final quality reviews can query bounded committed translation excerpts. Comparison
  snapshots bind decision caches and value frames without expanding repair scope;
  query, retry and lifetime review limits remain unchanged.
- Review evidence now uses complete paired paragraphs, with version-bound review
  receipts and historical reference compatibility. Bounded retrieval retains matched
  terms and explicitly identifies excerpt ranges without splitting Unicode scalars.
- Closure v2 removes mandatory semantic revoting without raising review limits.
  Legacy v1 receipts retain their historical verification contract. Unknown name
  renderings use the matching paragraph, not the beginning of a target block.
- Broader product backlog: visual source-range selection, per-edit diffs, live
  panel refresh, and gradual store/runner extraction.
- Quality scheduling retains the configured effort; high remains the default.
- Surface receipts now bind actual renderings to host-issued source occurrences
  and target paragraphs. Missing or stale receipts stay unknown, never hard locks.
- Durable delta reviews retain changed paragraphs, neighbors and open issues.
  Review credits are dependency-scoped with a lifetime cap and pre-repair admission.
- Derived-noise quarantine preserves historical revisions and all translation/usage data.
- DeepSeek supervision uses request-bound fixed-length decision arrays in a native
  finalizer's sole values argument, with short
  evidence handles. The host retains identities, quotes, versions and repair ranges;
  canonical validation and bounded retry budgets remain unchanged.
- A text-only native value decision receives one channel reminder within the same
  session and existing turn budget. Only a real validated tool submission can finish;
  provider errors, truncation and cancellation do not trigger that reminder.
- Fragment receipts preserve global occurrence identities through local paragraph scopes,
  refinement and assembly. Delta review shares the same semantic paragraph coordinates.
- Usage completeness checks every actual provider response; local turn-limit sentinels
  are excluded, while unmetered failures remain incomplete.
- Readable EPUB focus quotes map back to exact source spans across host slot markers;
  invented text, ambiguous projections and unissued references remain rejected.
- Context planning reserves JSON metadata and UTF-8 entry bytes within the existing
  wire limit while retaining mandatory evidence, dependencies and risk coverage.
- Context admission reuses exact planning decisions in a bounded local cache;
  independent frontiers prune across token buckets within equal coverage, preserving
  resource tradeoffs and exact choices. Exceptional numerical/identity cases retain
  bucket-local behavior.
  The offline context benchmark covers 137 varied-cost candidates.
- EPUB semantic repairs submit candidate-bound text-slot patches; host-owned markers,
  paragraph boundaries, fixed breaks and unrelated paragraphs remain unchanged.
- EPUB repair wire responses use one fixed-length string/null array. Slot identity,
  expected text and candidate hashes are host-owned; malformed arrays fail atomically
  and rejected responses retain their actual provider usage.
- Repair focus retains its validated source/target context. Repeated terms are
  scoped to matching paragraphs inside that context; unscoped ambiguity is rejected.
- Multi-paragraph plain-text semantic repairs use the same ordered values protocol.
  Single-paragraph block repair and non-semantic repair retain their existing route.
- Explicit quality rework is append-only, idempotent and candidate/version checked;
  run leases and cumulative review limits remain enforced across rework rounds.
- Fixed-issue evidence uses bounded local edit alignment when a corrected phrase
  still contains its old substring; unrelated edits do not prove a fix.

## History

- [Candidate-bound repair evidence](state/2026-10-07.md)
- [Complete review evidence and bounded retrieval](state/2026-10-06.md)
- [Revalidation review lifecycle](state/2026-10-05.md)

- [Quality closure and surface consistency](state/2026-10-04.md)
- [Native Pi supervision](docs/bounded-supervisor.md)
- [EPUB block-edge validation](state/2026-09-29.md)
- [External framework workers](state/2026-09-11.md)
- [Live discovery and Pi planning](docs/reports/2026-09-11-live-model-discovery.md)
- [Pi wire measurement](docs/reports/2026-09-11-pi-request-wire-measurement.md)
- [2026-09-05 reliability patch](state/2026-09-05.md)
- [v1.7.1 patch notes](docs/releases/v1.7.1.md)
- [v1.7.0 release](docs/releases/v1.7.0.md)
- [July execution/scheduler history](state/2026-07-30-legacy.md)
