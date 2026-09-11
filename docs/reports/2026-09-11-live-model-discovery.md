# Live model discovery and Pi candidate deduplication

## Behaviour

- Desktop setup scans after credentials become available (800 ms debounce),
  rescans after provider/credential/endpoint changes, and supports manual refresh.
- Discovery calls the provider's trusted `/models` endpoint with an 8-second
  default deadline. Preset endpoints cannot be overridden by a desktop request.
- The renderer distinguishes live results, built-in fallback, failure, and an
  empty live list. Refresh retains the selected model even if it disappears.
  Stale responses cannot replace another provider's list.
- Discovery does not require the previous model to remain valid. Model IDs are
  validated, deduplicated, sorted, and capped at 500. Echoed credentials are
  excluded. Caller cancellation propagates; unavailable endpoints with no
  fallback fail explicitly.
- New example configurations and measurement runs use `deepseek-flash`.
  Existing run IDs and fingerprints are not rewritten. Newly discovered IDs
  still require the normal capability probe before translation.

## Native Pi planning

DeepSeek's effective reasoning levels are off, low, high, and max. The planner
groups minimal with low, and medium/xhigh/default with high. This reduces seven
advertised candidate efforts to four execution strategies and avoids creating
duplicate derived runtimes. The chosen raw quality profile, escalation path,
and durable fingerprint remain unchanged. Other providers retain their own
effort semantics.

This is a candidate-count reduction, not a 43% translation-speed improvement.
The earlier request-wire projection remains in place; source content, term
constraints, coverage checks, and strict-export requirements are unchanged.

## Verification

- 84 focused Node regressions across discovery, provider runtime/probe,
  desktop adapters/services/IPC and runtime planning.
- 73 renderer tests across six files; the new provider-return regression was
  reproduced before fixing scan-origin invalidation.
- Core and desktop type checks, production desktop build, and preload-artifact
  verification pass.
- Authenticated discovery through the updated registry returned
  `deepseek-flash` and `deepseek-v4-pro`, both marked live.
- Native desktop startup was exercised with an isolated profile. The actual
  ProviderSetup component and stylesheet were visually checked in a browser
  fixture: automatic live status, scan lock, manual fallback, empty list, and
  retained selection. This fixture does not make generation requests.

## Canonical-ID short run

The original two-chapter fixture `folioloom/test/fixtures/pi-short-novel.txt`
contains 549 English words / 2,972 Unicode scalars.

| Measure | Result |
| --- | ---: |
| Requested model | `deepseek-flash` |
| Effort / concurrency | high / 1 |
| Elapsed | 59.571 s |
| Model calls | 4 |
| Reported total tokens | 17,577 |
| Completed windows | 2 / 2 |
| Warning / failed / human-required windows | 0 / 0 / 0 |
| Store audit / strict export verification | pass / pass |

The call sequence was anchor extraction, translation, anchor extraction,
translation. No full-book or 100K benchmark is included. Timing is a smoke-run
observation, not a controlled speed comparison. Structural checks do not
substitute for literary-quality evaluation; spot inspection retained the
sample's promise distinction, letter addressee, and one-way-return distinction,
while some prose remains literal.

## Protocol references

- [DeepSeek V4.1 Flash announcement](https://deepseek.com/news/deepseek-v4-1-flash/)
- [DeepSeek chat completion reasoning parameters](https://api-docs.deepseek.com/api/create-chat-completion/)
