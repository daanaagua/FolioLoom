# V5 Language Profiles and Lossless Quality Continuity Implementation Plan

> **Execution mode:** Complete these tasks in order with test-first changes. Keep the lossless path bounded: one lexical-anchor model call per wave and at most one targeted repair call per invalid batch submission.

**Goal:** Make V5 source-language aware and restore lexical, style, and deterministic validation continuity in the lossless full-book runner without sacrificing exact source coverage or parallel determinism.

**Architecture:** Add a registry of immutable `SourceLanguageProfile` objects and route structure recognition, anchor candidate extraction, normalization, and residue detection through it. Model aliases as provisional, evidence-bearing entity links that can be revalidated when later contexts arrive instead of forcing early string-based merges. Replace the raw previous-text tail with a hierarchical style state: immutable book constitution, scoped voice profile, mixed discourse-mode weights, and a bounded decaying local state. At each lossless wave, share immutable entity/term/style snapshots across physical requests, validate each returned logical window deterministically, repair only invalid blocks once, and atomically persist only evidence actually used by successful windows.

**Tech stack:** Python 3 project initializer and pytest; TypeScript 7, Node test runner, `Intl.Segmenter`, Unicode property escapes, SQLite, Pi agent runtime.

---

## Task 1: Add source-language metadata at project creation

**Files:**

- Modify: `src/core/source_ledger.py`
- Modify: `src/core/project_manager.py`
- Modify: `main.py`
- Modify: `tests/test_source_ledger.py`

**Step 1: Write failing tests**

Add tests proving:

- `ProjectManager.create_project(..., source_language="fr")` writes `sourceLanguage: "fr"` into `source_manifest.json` and project config.
- `main.py init ... --source-language en` forwards the exact value.
- unsupported or malformed language tags are rejected before project artifacts survive.
- omitting the option writes the backward-compatible explicit default `en` for newly created projects.

Run:

```powershell
..\.venv\Scripts\python.exe -m pytest tests\test_source_ledger.py -q
```

Expected: new tests fail because the argument and manifest field do not exist.

**Step 2: Implement the minimum manifest path**

- Normalize supported tags to lowercase primary subtags (`en`, `fr`, `de`, `es`, `ru`, `ja`, `und`).
- Add `source_language` to `ProjectManager.create_project` and `create_source_ledger`.
- Store `sourceLanguage` in the certified manifest and `source_language` in project config.
- Add `--source-language` to `init`; default new projects to `en`.
- Preserve atomic rollback on validation failure.

**Step 3: Run focused tests**

Run the pytest command above. Expected: pass.

**Step 4: Commit**

```powershell
git add main.py src/core/source_ledger.py src/core/project_manager.py tests/test_source_ledger.py
git commit -m "feat: record source language in project manifests"
```

## Task 2: Introduce the language profile registry

**Files:**

- Create: `translator-v5/src/language/types.ts`
- Create: `translator-v5/src/language/profiles.ts`
- Create: `translator-v5/test/language-profile.test.ts`

**Step 1: Write failing registry and behavior tests**

Cover:

- deterministic lookup for `en`, `fr`, `de`, `es`, `ru`, `ja`, and `und`;
- English and French heading classification;
- Unicode token segmentation and source-form normalization;
- English possessives and French apostrophe contractions;
- candidate collection includes a first-occurrence current-wave proper name even when its corpus frequency is one;
- candidates are deterministically scored and capped;
- residue findings distinguish prose tokens from allowed initials, formulas, URLs, and source forms explicitly preserved by a term.

Run:

```powershell
npm test -- --test-name-pattern="language profile"
```

Expected: fail because the modules do not exist.

**Step 2: Implement immutable profiles**

- Define typed heading, token, candidate, and residue results.
- Use `Intl.Segmenter` with Unicode property escapes; never split by ASCII-only regex in shared code.
- Build a Latin base profile and language-specific heading/stop-word data.
- Implement conservative `und` fallback based on Unicode scripts and repeated spans.
- Make candidate scoring pure and stable with deterministic tie-breaking.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="language profile"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/language translator-v5/test/language-profile.test.ts
git commit -m "feat: add source language profile registry"
```

## Task 3: Carry language identity through the certified source ledger

**Files:**

- Modify: `translator-v5/src/source/types.ts`
- Modify: `translator-v5/src/source/source-ledger.ts`
- Modify: `translator-v5/src/storage/lossless-book-store.ts`
- Modify: `translator-v5/src/fullbook/book-context.ts`
- Modify: `translator-v5/test/source-ledger.test.ts`
- Modify: `translator-v5/test/lossless-book-store.test.ts`
- Modify: `translator-v5/test/book-context.test.ts`

**Step 1: Write failing compatibility and identity tests**

Prove:

- a new manifest with `sourceLanguage: "fr"` exposes the French profile ID;
- changing only `sourceLanguage` changes the source/derived-plan identity for new manifests;
- an old manifest without the field retains its previous source version and loads as `en` compatibility mode;
- registered certified source payloads and resumed runs reject profile drift;
- `BookContext` exposes the selected immutable profile.

Run:

```powershell
npm test -- --test-name-pattern="source language|profile drift|compatibility language"
```

Expected: fail.

**Step 2: Implement identity propagation**

- Extend `ScalarSource` and `CertifiedSourceInput` with language/profile metadata.
- Include the language in new-manifest identity calculation while branching legacy missing-field calculation to the exact old identity algorithm.
- Persist the field inside the already-audited source payload JSON and run metadata; do not change relational schema version.
- Resolve `BookContext.languageProfile` once and reuse it.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="source language|profile drift|compatibility language"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/source translator-v5/src/storage/lossless-book-store.ts translator-v5/src/fullbook/book-context.ts translator-v5/test/source-ledger.test.ts translator-v5/test/lossless-book-store.test.ts translator-v5/test/book-context.test.ts
git commit -m "feat: bind language profiles to certified sources"
```

## Task 4: Route structure, lexical candidates, prompts, and residue through profiles

**Files:**

- Modify: `translator-v5/src/source/structure-annotator.ts`
- Modify: `translator-v5/src/agents/lexical-anchorer.ts`
- Modify: `translator-v5/src/agents/translator.ts`
- Modify: `translator-v5/src/tools/translation-tools.ts`
- Modify: `translator-v5/src/validators/translation-validator.ts`
- Modify: `translator-v5/src/pilot-runner.ts`
- Modify: `translator-v5/test/lexical-anchor.test.ts`
- Modify: `translator-v5/test/translation-agent.test.ts`
- Modify: `translator-v5/test/tools.test.ts`
- Modify: `translator-v5/test/window-planner.test.ts`

**Step 1: Write failing integration tests**

Add tests showing:

- French headings are annotated only with the French profile and English compatibility remains unchanged.
- `collectWindowAnchorCandidates` delegates to a profile, includes single current-wave forms, and retains whole-book contexts.
- translator/tool prompts say “source-language forms”, include profile identity, and contain no hard-coded “English forms”.
- validation delegates residue detection to the profile and preserves stable source forms.
- pilot runner uses the context profile end to end.

Run:

```powershell
npm test -- --test-name-pattern="lexical anchor|source-language forms|residue|structure"
```

Expected: fail.

**Step 2: Replace scattered English logic**

- Pass the profile explicitly; do not use a hidden mutable global.
- Keep compatibility overloads only where tests or public APIs require them, defaulting to `en`.
- Replace ASCII-specific candidate and untranslated-prose regexes with profile calls.
- Make prompt text language-neutral and include source/target language labels.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="lexical anchor|source-language forms|residue|structure"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/source/structure-annotator.ts translator-v5/src/agents/lexical-anchorer.ts translator-v5/src/agents/translator.ts translator-v5/src/tools/translation-tools.ts translator-v5/src/validators/translation-validator.ts translator-v5/src/pilot-runner.ts translator-v5/test
git commit -m "refactor: route source language behavior through profiles"
```

## Task 5: Add provisional entity links and evidence-driven alias revalidation

**Files:**

- Create: `translator-v5/src/domain/entity-links.ts`
- Create: `translator-v5/src/fullbook/entity-revalidation.ts`
- Modify: `translator-v5/src/agents/lexical-anchorer.ts`
- Modify: `translator-v5/src/knowledge/knowledge-store.ts`
- Modify: `translator-v5/src/storage/lossless-book-store.ts`
- Create: `translator-v5/test/entity-links.test.ts`
- Modify: `translator-v5/test/lexical-anchor.test.ts`
- Modify: `translator-v5/test/lossless-book-store.test.ts`

**Step 1: Write failing entity-link tests**

Prove:

- two surface forms can remain `provisional` without being forced into one entity;
- direct apposition, explicit naming evidence, or a sufficiently strong combination of independent contextual signals can promote a link to `confirmed`;
- string similarity alone can propose a link but can never confirm it;
- contradictory evidence moves the link to `conflicted` and preserves both evidence chains;
- confirmed aliases share one `conceptId` and preferred Chinese target while preserving their individual source forms;
- a new occurrence automatically schedules revalidation for a provisional or conflicted link;
- future knowledge can confirm an alias without silently rewriting already committed translation rows;
- the same evidence set produces the same score, state, and revision independent of insertion order.

Use a deterministic linkage score with separately recorded components, for example:

```text
linkScore = explicitNamingEvidence
          + appositionEvidence
          + contextualCompatibility
          + distributionalCompatibility
          + boundedModelVerdict
          - contradictionPenalty
```

Run:

```powershell
npm test -- --test-name-pattern="entity link|alias revalidation"
```

Expected: fail because entity-link state does not exist.

**Step 2: Implement append-only entity links**

- Store source forms, canonical normalization, evidence IDs, score components, status, confidence, preferred target, and revision provenance.
- Keep `provisional`, `confirmed`, and `conflicted` transitions explicit and append-only.
- Permit deterministic evidence to settle direct cases; use one bounded model verdict only when evidence can materially change translation.
- Treat `conceptId` as entity identity and `lexemeId` as a surface-form identity so confirmed aliases can share a concept without losing lexical history.
- Emit a typed drift candidate when a newly confirmed alias disagrees with an earlier active translation; do not rewrite translated blocks inside the knowledge transaction.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="entity link|alias revalidation"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/domain/entity-links.ts translator-v5/src/fullbook/entity-revalidation.ts translator-v5/src/agents/lexical-anchorer.ts translator-v5/src/knowledge/knowledge-store.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test
git commit -m "feat: revalidate evidence-backed entity aliases"
```

## Task 6: Add one immutable lexical and entity snapshot per lossless wave

**Files:**

- Modify: `translator-v5/src/fullbook/book-runner.ts`
- Modify: `translator-v5/src/agents/translation-batch.ts`
- Modify: `translator-v5/src/knowledge/knowledge-store.ts`
- Modify: `translator-v5/src/storage/lossless-book-store.ts`
- Modify: `translator-v5/test/book-runner.test.ts`
- Modify: `translator-v5/test/translation-batch.test.ts`
- Modify: `translator-v5/test/lossless-book-store.test.ts`

**Step 1: Write failing wave tests**

Test that:

- a clean run invokes lexical anchoring once for a wave, not once per window or request;
- all physical requests in the wave receive the same immutable term snapshot;
- reverse completion order produces byte-identical knowledge history;
- confirmed aliases are projected with one entity target into every request;
- provisional links are presented as uncertainty rather than as locked terminology;
- only actually referenced anchors become promoted knowledge evidence;
- a fully failed wave promotes no staged anchor knowledge;
- resuming with the same anchor input hash reuses the staged/cached decision.

Use fake Pi streams; no network/model calls.

Run:

```powershell
npm test -- --test-name-pattern="wave anchor|alias projection|failed wave anchor"
```

Expected: fail.

**Step 2: Implement bounded wave anchoring**

- Collect candidates from selected wave blocks plus compact whole-corpus concordance.
- Invoke `LexicalAnchorer` once with a dedicated budget ledger.
- Build an immutable `WaveAnchorSnapshot` containing stable terms, confirmed entity aliases, and bounded provisional-link warnings, with an input hash.
- Pass its relevant stable terms to each batch request.
- Convert referenced decisions into deterministic knowledge candidates attached to the earliest successful logical ordinal.
- Reuse existing staged/promoted revision machinery rather than adding a side-channel mutable glossary.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="wave anchor|alias projection|failed wave anchor"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/fullbook/book-runner.ts translator-v5/src/agents/translation-batch.ts translator-v5/src/knowledge/knowledge-store.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test
git commit -m "feat: anchor terminology once per lossless wave"
```

## Task 7: Replace the raw style tail with hierarchical structured style

**Files:**

- Create: `translator-v5/src/style/types.ts`
- Create: `translator-v5/src/style/effective-style.ts`
- Create: `translator-v5/src/style/style-observation.ts`
- Create: `translator-v5/src/style/style-projection.ts`
- Modify: `translator-v5/src/fullbook/book-runner.ts`
- Modify: `translator-v5/src/agents/translation-batch.ts`
- Modify: `translator-v5/src/tools/translation-tools.ts`
- Modify: `translator-v5/src/storage/lossless-book-store.ts`
- Create: `translator-v5/test/structured-style.test.ts`
- Modify: `translator-v5/test/book-runner.test.ts`
- Modify: `translator-v5/test/lossless-book-store.test.ts`

**Step 1: Write failing tests**

Verify:

- an immutable `BookStyleConstitution` stores executable global rules such as register, sentence policy, explicitation, imagery, dialogue, technical prose, and typography;
- scoped `VoiceProfile` records can distinguish narrator, character, letter, document, or quoted voice without changing the book constitution;
- a source block can carry mixed `DiscourseModeWeights` rather than one rigid label (`narrative`, `dialogue`, `action`, `description`, `technical`, `documentary`, `lyrical`, `interior`);
- effective style is a deterministic composition of book constitution, visible voice, top discourse modes, and decaying local state;
- the local state contains only bounded active register, relationship-sensitive address choices, rhythm observations, recent lexical choices, and continuity notes;
- local influence decays by logical distance and expires; it cannot mutate the immutable book constitution;
- examples are retrieved only from accepted translations with compatible voice and discourse mode, capped at two short snippets;
- all parallel siblings receive the same pre-wave style snapshot;
- reverse completion order and resume produce the same next style state by logical ordinal;
- rejected or repaired-but-invalid translations cannot become style evidence;
- the final prompt projection is bounded and contains concise rules rather than a raw prior translation dump.

Run:

```powershell
npm test -- --test-name-pattern="structured style|effective style|style projection"
```

Expected: fail for the lossless runner.

**Step 2: Implement the style hierarchy without an extra classifier call**

- Keep the book constitution explicit and versioned; initialize it from project configuration or an approved calibration result, never from an arbitrary previous block.
- Extract language-neutral source features such as quote ratio, paragraph shape, sentence-length distribution, numeral/formula density, parenthetical density, and document-like layout.
- Combine those deterministic features with bounded structured `styleObservation` returned in the existing translation submission; do not add a separate style-agent model call.
- Represent mode membership as normalized weights and project only the top relevant rules.
- Resolve voice from position-safe narrative/entity memory when available; otherwise use the declared main narrator profile without inventing a character voice.
- Maintain local observations with an exponential distance decay and hard TTL.
- Select zero to two accepted same-mode/same-voice examples; absence of a match is preferable to a mismatched example.
- Persist append-only observations and derive snapshots, so replay and audit reproduce the same style state.
- Pass a compact `EffectiveStyleProjection` to `runTranslationBatch`; retain `previousActiveTail` only as a temporary backward-compatibility input until migration tests pass.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="structured style|effective style|style projection"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/style translator-v5/src/fullbook/book-runner.ts translator-v5/src/agents/translation-batch.ts translator-v5/src/tools/translation-tools.ts translator-v5/src/storage/lossless-book-store.ts translator-v5/test
git commit -m "feat: compose scoped structured translation style"
```

## Task 8: Add deterministic batch validation and one targeted repair pass

**Files:**

- Modify: `translator-v5/src/agents/translation-batch.ts`
- Modify: `translator-v5/src/agents/repairer.ts`
- Modify: `translator-v5/src/fullbook/book-runner.ts`
- Modify: `translator-v5/test/translation-batch.test.ts`
- Modify: `translator-v5/test/book-runner.test.ts`

**Step 1: Write failing repair-boundary tests**

Cover:

- valid logical windows pass the shared `TranslationValidator` before staging;
- one invalid block triggers one repair call containing only that block and its precise failure codes;
- repaired output is revalidated;
- an invalid repair becomes typed retry/human state and is never promoted;
- a valid sibling window remains usable when another window fails;
- no whole-window retranslation occurs for one invalid block.

Run:

```powershell
npm test -- --test-name-pattern="batch validation|targeted batch repair"
```

Expected: fail.

**Step 2: Implement shared validation and bounded repair**

- Factor a batch adapter around the existing deterministic validator.
- Feed the selected language profile and stable-term projection into validation.
- Reuse the repair tool protocol with a strict one-pass batch cap.
- Merge repaired blocks into the untouched candidate and revalidate the complete logical window.
- Return typed window errors to the existing attempt policy.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="batch validation|targeted batch repair"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/agents/translation-batch.ts translator-v5/src/agents/repairer.ts translator-v5/src/fullbook/book-runner.ts translator-v5/test/translation-batch.test.ts translator-v5/test/book-runner.test.ts
git commit -m "fix: validate and locally repair lossless batches"
```

## Task 9: Report source extraction anomalies without mutating source

**Files:**

- Create: `translator-v5/src/source/anomaly-report.ts`
- Modify: `translator-v5/src/fullbook/book-runner.ts`
- Modify: `translator-v5/src/cli.ts`
- Create: `translator-v5/test/source-anomaly.test.ts`
- Modify: `translator-v5/test/cli.test.ts`

**Step 1: Write failing report tests**

Test deterministic counts and samples for:

- spaced hyphenation such as `Ma- chiavelli`;
- replacement/control characters;
- repeated frontmatter-like lines;
- extreme long lines;
- raw source text and source hashes remain unchanged.

Run:

```powershell
npm test -- --test-name-pattern="source anomaly"
```

Expected: fail.

**Step 2: Implement a pure report**

- Return typed anomaly codes, counts, bounded samples, and source scalar positions.
- Add the projection to doctor/run metadata and warning output.
- Do not normalize or rewrite any source member.

**Step 3: Run focused tests and typecheck**

```powershell
npm test -- --test-name-pattern="source anomaly"
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```powershell
git add translator-v5/src/source/anomaly-report.ts translator-v5/src/fullbook/book-runner.ts translator-v5/src/cli.ts translator-v5/test/source-anomaly.test.ts translator-v5/test/cli.test.ts
git commit -m "feat: report immutable source extraction anomalies"
```

## Task 10: Full regression and local Dragon Waiting gates

**Files:**

- Modify only if verification reveals a general defect; do not add book-specific rules.
- Produce runtime artifacts under ignored `projects/dragon_waiting_flash/`.

**Step 1: Run all offline verification**

```powershell
..\.venv\Scripts\python.exe -m pytest tests -q
Set-Location translator-v5
npm test
npm run typecheck
```

Expected: Python suite, all Node tests, and typecheck pass.

**Step 2: Reinitialize the English project from clean derived state**

Use the original file:

```text
D:\llm\qikan4\The Dragon Waiting- A Masque of History (Ford, John M) (z-library.sk, 1lib.sk, z-lib.sk).txt
```

Delete only the ignored `dragon_waiting_flash` derived project after verifying its resolved path is inside `D:\llm\小说翻译\projects`. Recreate with `--source-language en`.

**Step 3: Run doctor and one-window Flash gate**

- Confirm exact source coverage and anomaly report.
- Run one lossless window with one concurrent request.
- Inspect persisted anchor/knowledge history and bilingual output.
- Require `Loukianos of Samosata` and `Lucian the Scoffer` either to share a confirmed entity/target or to remain one explicit provisional link; they must not silently become two unrelated locked entities.
- Require no missing blocks, system leakage, or unhandled validation findings.

If this gate fails, stop and diagnose; do not launch the full book.

**Step 4: Run three-window continuity gate**

- Resume through three total windows.
- Confirm the next request receives a bounded effective style projection derived from the prior accepted logical state, not a raw translation tail.
- Confirm technical/documentary passages and dialogue receive different discourse-mode projections while retaining the same book constitution.
- Confirm anchor snapshots are reused consistently and audit passes.
- Record model calls, translation turns, source tokens, and wall time.

**Step 5: Run full English book only after both gates pass**

- Run the remaining 113-window plan with bounded adaptive concurrency.
- Audit the final run and export bilingual/readable artifacts.
- Report any remaining warnings with typed source anomaly codes.

**Step 6: Final verification commit**

```powershell
git status --short
git log --oneline --decorate -12
```

Commit only tracked general-purpose fixes or documentation. Never commit model outputs, credentials, SQLite files, or downloaded novels.
