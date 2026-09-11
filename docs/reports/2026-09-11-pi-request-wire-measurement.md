# Pi request wire measurement — 2026-09-11

## Changes

- Translation requests omit persistence-only `revisionId` and `renderFingerprint`
  from the model-facing stable-term and occurrence objects.
- Full records remain available to local validators, repair, storage, and audit.
  Terms, source positions, target constraints, scope, memory, and style are retained.
- Both text and JSON budget projections use the compact wire representation.
- The DeepSeek catalogue accepts canonical `deepseek-flash` alongside the existing
  `deepseek-v4-flash` and `deepseek-v4-pro` IDs, without rewriting stored run IDs.

## Deterministic input-size comparison

Fixture: 200 stable terms, two matched source occurrences, identical source and
rendering constraints before and after projection. No term is pruned.

| Measurement | Full records | Compact wire |
| --- | ---: | ---: |
| Terms section, UTF-8 bytes | 86,912 | 57,824 |
| User prompt, UTF-8 bytes | 87,806 | 58,718 |

The terms section is 33.5% smaller. This is a payload-size result for terminology-
rich input, not a claim that every translation becomes 33.5% faster. System
instructions and tool schemas are unchanged.

## Short native Pi run

- Fixture: `folioloom/test/fixtures/pi-short-novel.txt`, an original two-chapter
  English sample; 549 whitespace-delimited words / 2,972 Unicode scalars.
- Requested API ID: `deepseek-v4-flash`; effort: `high`; active/balanced scheduler;
  concurrency 1; output cap 8,192 tokens per provider request.
- Backend routing: DeepSeek's 2026-09-10 announcement maps this compatibility ID
  to **V4.1 Flash**. The canonical current ID is `deepseek-flash`, also observed
  in the authenticated model list. The submitted ID is preserved in run metadata.
- Candidate: 58.7 seconds, four model generations, 17,098 total tokens; two of two
  windows complete, zero warnings, zero failed or human-required windows.
- Store audit and exported-artifact verification pass, with no incident codes.
- The baseline stopped after its configured three-request cap. It is excluded
  from end-to-end speed comparisons; short-run cache and generation variability
  also prevent attributing individual request latency differences to the patch.
- Across the baseline and candidate: seven successful generations and one
  rejected authentication request, 28,570 total tokens, approximately 102 seconds
  of measured execution. No full-book or 100K run is included.

### Quality observations

The translation preserves the distinction between waiting until a bell and not
leaving before it, a letter's author versus addressee, intended meaning versus
written words, and crossing the river versus being able to return that night.
Paragraph order and recurring names are consistent. Some phrasing remains literal,
and `seal` becomes the more specific `火漆封印`; structural audit is not a literary
quality score.

### Next performance signal

Reasoning accounts for 9,435 of 10,672 candidate output tokens (88.4%). A separate
quality-controlled effort comparison is a stronger next latency experiment than
assuming local CPU dominates this sample. DeepSeek's current documentation maps
`medium` and `xhigh` to `high`, and `minimal` to `low`; generic effort labels must
not be interpreted as distinct provider settings.

## Regression coverage

- Request, budget, fragment, term-usage, runner, and revalidation groups: 167 pass.
- Provider and desktop model/error groups: 42 pass, including canonical-ID payload
  construction with network dispatch deliberately stopped.
- Core and desktop type checks, the benchmark script type check, and desktop
  production build verification pass.
- The bounded benchmark is opt-in and creates fresh output directories. Keys,
  credentials, database files, and live artifacts are not tracked.

## Protocol sources

- [V4.1 Flash announcement](https://deepseek.com/news/deepseek-v4-1-flash/)
- [Chat Completions model names and effort mapping](https://api-docs.deepseek.com/api/create-chat-completion/)
