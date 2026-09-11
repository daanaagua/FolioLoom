# Pi translation request efficiency

## Goal

Reduce model-visible input for the native Pi/API translation pipeline without
removing source content, rendering constraints, narrative memory, style guidance,
or local validation data.

## Scope

- Separate model-facing terminology data from persistence-only revision metadata.
- Retain full domain records for occurrence validation, version checks, repair,
  storage, and export audit.
- Measure the exact compact wire payload in request admission, using the same
  projection for text and structured budget components.
- Compare deterministic payload size and a short synthetic literary translation
  through the existing source, runner, Pi, validation, storage, and export path.

No changes to existing run model identity, reasoning effort, concurrency policy, source
segmentation, retry limits, database schema, Codex transport, or skill behavior.
No source-form relevance pruning or cross-snapshot cache is introduced.

## DeepSeek model-name compatibility

The canonical Flash API name is `deepseek-flash` as of 2026-09-10. Include it in
the provider catalogue and retain `deepseek-v4-flash` and `deepseek-v4-pro` for
existing profiles and runs. Do not normalize persisted request IDs into a new
name. Validate canonical and compatibility IDs at the Pi payload boundary.
Routing announcements describe the backend separately from the submitted ID.

## Wire contract

- `revisionId` and `renderFingerprint` identify local knowledge versions. They are
  not submitted by the model's term-usage tool and are omitted from model-visible
  stable terms and occurrence entries.
- All other current fields remain, including occurrence/concept identity, exact
  source positions, source forms, canonical and allowed targets, policy, notes,
  rule identity, and block applicability.
- `PreparedTranslationRequest.expectedTermOccurrences` retains the full records.
- Raw domain objects are not mutated. JSON and text projections must agree.
- Both typed-tool and framed-text requests use the same projection; fragment
  recovery still receives only occurrences belonging to its exact source span.

## Implementation sequence

1. Record the current short-run baseline and deterministic wire-size baseline.
2. Add regression tests for wire omission, retained local hashes, unchanged
   semantic fields and receipts, and unmodified inputs; implement the projection.
3. Run request/budget/validation/runner regressions and production build checks.
4. Repeat the bounded live run, audit and export, and inspect the translation's
   negation, reference, dialogue implication, paragraph order, and terminology.

## Acceptance

- The terminology-rich deterministic fixture has a smaller model-visible terms
  section while preserving every rendering constraint and expected receipt.
- Capacity calculations use the new wire size, not the larger persistence shape.
- Existing scope, fragment, transaction, and export tests remain valid.
- The short live fixture completes strict export or produces a specific failure
  for diagnosis; latency is reported as a sample, not a throughput guarantee.
- Two live runs together are limited to eight model requests and six minutes of
  execution time. Live artifacts and credentials stay outside tracked files.
