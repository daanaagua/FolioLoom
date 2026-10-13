# Source scope and omission review

FolioLoom distinguishes source coverage from semantic fidelity. Paragraph IDs,
ordering, structural slots and nonempty translation checks remain mandatory.
They cannot prove that every action or qualification in a paragraph survived
translation. Optional review produces evidence-backed suggestions without editing
the translation store.

## Original-source coverage

New imports retain a `source_scope.json` certificate. For an ordinary full-file
import, its basis is `provided-input`: every extracted member of the supplied
file is included. EPUB import uses the package spine and additional non-navigation
XHTML members, including epilogues, dedications and character lists. A file that
was cropped elsewhere is still only that supplied file; the importer cannot infer
an unavailable original.

To import an excerpt with original-book coverage, first import the original and
generate its scope plan:

```sh
npm run folioloom -- book import --source book.epub --project projects/original --source-language en
npm run folioloom -- book scope --manifest projects/original/source_manifest.json --output scope-plan.json
```

The plan identifies the original source version and lists every section in source
order. Each part has `sectionIndex`, Unicode-scalar `start` and `end`, and a
`disposition`: `translate`, `exclude`, or `regenerate`. Excluded or regenerated
parts require a nonempty `reason`. Parts may subdivide sections at paragraph
boundaries, but may not overlap, leave gaps, reorder sections or silently omit an
empty member. `book scope` also prints the section names and coordinates.

Edit the generated plan to describe the intended excerpt, then import the excerpt:

```sh
npm run folioloom -- book import --source excerpt.epub --project projects/excerpt --source-language en --original-manifest projects/original/source_manifest.json --scope-plan scope-plan.json
```

The selected source must exactly match the declared original ranges after removing
EPUB slot identifiers and normalizing paragraph separators. The project copies
the original source evidence, so moving the project does not depend on the old
absolute path. Nested excerpts must reference the original input, not another
excerpt. Changing the scope evidence invalidates its hash and run identity.

`book doctor` and `book audit` expose `sourceScope`, including the original sections,
dispositions and reasons. The source certificate is retained in the translation
database and checked when registering its plan and auditing exports.
`wholeOriginalSelected: false` means a complete translation of the selected scope
is not a complete translation of the original book. `regenerate` records an explicit
out-of-translation plan, such as rebuilding navigation; it does not certify that
the replacement artifact has been generated.

Legacy manifests retain their existing source versions and run identities. They
do not acquire original-book coverage evidence retroactively.

## Free scan and bounded semantic comparison

Create a review plan from a completed translation without constructing a provider:

```sh
npm run folioloom -- book review scan --store projects/book/book.db --run RUN_ID --output review-plan.json --max-candidates 20 --samples 3 --seed review-1
```

The scan separates structural failures from uncertain signals such as missing
numbers, severe compression, a changed negation or repeated translated text.
These signals are not verdicts. English-specific signals are only applied to
English sources. Chinese integer renderings are recognized for common small
numbers; other legitimate reformulations may still be nominated for comparison.

Unflagged samples are selected deterministically by the seed and are reviewed
before risk candidates, so a small call budget still examines the scanner's blind
spots. `max-candidates` bounds the combined selection; `samples` must be between
zero and that limit. A new scan output never overwrites an existing plan.

Model comparison is a separate, explicit command with separate budgets:

```sh
npm run folioloom -- book review run --store projects/book/book.db --run RUN_ID --input review-plan.json --output reviews/review-1 --config config.yaml --max-calls 6 --max-tokens 120000 --max-output-tokens 8192
npm run folioloom -- book review status --output reviews/review-1
```

The review uses the configured native provider API. `--opencode-auth` is available
for credentials in the same way as native translation; external worker bridges
are not used by this command. `--hard-deadline-ms` optionally bounds each call
(default 120000, maximum 600000).

Each selected paragraph is compared with nearby context. The model must return
`adequate`, `possible_omission`, or `uncertain`, with exact source and target quotes.
Unanchored quotes and malformed responses are rejected. Positive paraphrases of
negative statements and other faithful literary choices can be judged adequate.
No verdict automatically rewrites text, reopens a translation window or changes
the translation's historical accounting.

The review directory holds its immutable plan, a hash-chained journal and a derived
report. A dispatch reserves a conservative input allowance plus the requested
output cap before calling the provider. Actual complete usage replaces the
reservation; interrupted or unaccounted requests retain their reservation.
Provider failures and invalid results stop the review without an automatic retry.
Restart retains spent calls, token charges, limits, model settings and prompt
identity. Changing limits in the same directory is rejected. Creating another
directory constitutes a separate review with additional potential spend.

Source or translation changes invalidate the old plan, including changes while a
request is in flight. The translation database is opened read-only. The report
shows the total source paragraphs, planned and reviewed candidates, unflagged
samples and risk candidates judged adequate. `complete` means that the selected
review plan finished; it is not proof of full-book semantic completeness.

Evaluate proposed detector changes against both omitted content and faithful
paraphrases. Track candidate coverage, grounded review outcomes, unflagged samples,
actual added tokens and any regressions. A rule's suspicion alone must not become
an automatic correction.
