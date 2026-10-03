# FolioLoom

**English** | [简体中文](README.zh-CN.md)

> A continuity-aware translation engine for long-form fiction.

FolioLoom is an open-source AI translation engine for novels and other long-form fiction. It treats source integrity, narrative memory, entity aliases, terminology continuity, local style, and failure recovery as one auditable pipeline, so complex books can remain consistent and traceable after chunking, parallel execution, and long-running translation sessions.

The current version is **FolioLoom v1.8.1**. The production TypeScript core lives in [`folioloom/`](folioloom/). Python code at the repository root primarily provides TXT, Markdown, DOCX, and EPUB input adapters and preserves the V1–V4 research history.

v1.8.1 strengthens native Pi supervision with host-issued evidence references, durable candidate checkpoints, restart-safe repair limits and dependency-aware review caching. Existing runs keep their recorded backend and supervision policy. See the [release notes](docs/releases/v1.8.1.md) and [reliability contracts](docs/reliability.md).

- ✓ **Partial mitigation for DeepSeek's mistaken copyright refusals:** caller-supplied source and usage context can now accompany translation, research, repair and supervision through the desktop task-context field or `--task-context-file`. Clear, truthful context helps address refusals based on unsupported assumptions about the task. This is a prompt-context correction, not a change to DeepSeek's policies or a guarantee against future refusals; it does not infer rights or invent authorization.

## What v1.8.1 can do

- Build a lossless source ledger with hashes and positional mappings.
- Use embedded Pi to approve bounded batches, query source evidence, review selected candidates and request grounded repairs, while the kernel retains budgets, validation and commits.
- Translate logical windows serially or with bounded concurrency, then resume safely after interruption.
- Record entity aliases, candidate relationships, and revalidation state with evidence.
- Freeze terminology anchors for each parallel wave to reduce name drift between sibling windows.
- Combine book-level style constraints, character voices, register weights, and decaying local state.
- Apply deterministic checks and one bounded local repair for omissions, unexpected residue, and structural errors.
- Export Chinese TXT, bilingual TXT, EPUB, and audit reports from the SQLite state store.
- Use newly imported EPUB files as export templates, preserving footnotes, backlinks, cross-chapter links, external URLs, OPF/spine/nav structure, styles, and other resources. FolioLoom refuses to publish an EPUB when structural slots or internal links are invalid.
- Use the Electron desktop app to import books, connect models, run a trial translation, translate a full book, pause and resume, export results, and maintain terminology and narrative memory.
- Import terminology from JSON, YAML, CSV, or XLSX files, with field mapping and conflict handling before data is written.
- Review and submit terminology edits while a full-book run is active. In-flight requests keep their old snapshot; accepted edits are applied once at the next durable wave boundary.
- Give one entity or term different Chinese renderings over immutable source-block ranges, with deterministic precedence and explicit overlap conflicts.
- Preview and run audited terminology retrofits. Receipt-backed unambiguous changes use local versioned repair; uncertain cases reuse sparse model revalidation; every job is resumable, rollback-capable, and an explicit strict-export gate.
- Apply language profiles for English, German, French, Spanish, Russian, Japanese, and Korean, with support for common Unicode encodings, Windows-1252, and legacy Japanese and Korean encodings.
- Export privacy-safe diagnostic JSON without API keys, book text, translations, or complete private paths.
- Show text blocks requiring attention, failure categories, public error codes, and next actions in the desktop app. Recoverable incidents receive at most one safe retry through shadow audit and atomic promotion.
- Scan the provider's live model list after credentials are entered, with manual refresh and explicit fallback status. New DeepSeek configurations default to `deepseek-flash`; existing compatible model IDs are preserved.
- Run an optional, isolated `codex exec` worker with the user's existing Codex CLI login, without a separate model API key or provider configuration.
- Use the repository-scoped [`$folioloom-translate`](.agents/skills/folioloom-translate/SKILL.md) skill to import a manuscript, run a bounded smoke translation, resume the same durable run, audit it, and strictly export it.
- Amortize safe Codex file work across adjacent logical windows, retain per-window validation and commits, try paragraph-heavy blocks whole before bounded fragment recovery, and import paragraph-heavy DOCX files in linear time.

## V4 Flash 100K benchmark

FolioLoom v1.5.1 was tested on fresh project databases with the current `deepseek-v4-flash` model, Active/Balanced scheduling, and three concurrent requests. v1.5.2 added EPUB structure preservation, v1.5.3 added desktop handling and recovery workflows, v1.6.0 added the separate Codex worker path, and v1.7.0 adds live terminology control and audited retrofit jobs without changing these historical measurements.

- German, *The Metamorphosis*: **10 minutes 55 seconds** for the first 100K characters.
- English, Part One of *Children of Time*: **18 minutes 56 seconds** for the first 100K characters.

Both runs passed strict export and audit with no human-required or failed windows. Actual time still depends on model service load, network conditions, paragraph structure, and knowledge revalidation. These figures are release-acceptance samples, not guaranteed throughput. See the [bilingual 100K acceptance report](docs/superpowers/reports/2026-07-30-translation-throughput-and-revalidation-live-validation.md) for the full methodology and results.

## Current limitations

- Releases currently include a Windows x64 single-file portable build and a portable ZIP, but they are not code-signed.
- The local V4 adjudication page and legacy Streamlit page remain in the repository but are not the primary interface.
- Semantic review is model-based and cannot guarantee literary quality. The historical 100K timings above do not measure the added supervisor's cost or latency.
- The desktop app supports book import, model compatibility checks, single-fragment trials, full-book start/pause/resume, live terminology review, audited batch term correction, the attention center, and strict export. Paragraph-level manual rewriting and general batch review are still planned.
- The desktop app includes DeepSeek, Kimi, Alibaba Cloud Model Studio, Volcano Ark, OpenAI, SiliconFlow, and custom OpenAI-compatible endpoints. Model discovery never silently changes the selected model; every model must still pass a live compatibility check. Known retired DeepSeek routes (`deepseek-chat` and `deepseek-reasoner`) are rejected.
- The Codex worker is currently a CLI/skill workflow, requires a locally installed and signed-in Codex CLI, and intentionally runs with `--max-concurrency 1`. It is not yet exposed in the desktop app.
- Original-template EPUB preservation applies only to projects re-imported with v1.5.2 or later. Older projects are not fuzzily aligned to guessed link positions; re-import the original EPUB before translating.

## Installation

Requirements: Windows, Python 3.11+, and Node.js 24+.

```powershell
git clone https://github.com/daanaagua/FolioLoom.git
Set-Location FolioLoom

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

Set-Location folioloom
npm.cmd ci
Set-Location ..
```

For provider-API runs, copy the example configuration. You can place a real API key in the untracked `config/config.yaml`, or pass `--opencode-auth` to `book run` and read credentials from your local OpenCode authentication file. Codex-worker runs use neither option.

```powershell
Copy-Item config\config.example.yaml config\config.yaml
# Edit config\config.yaml and replace the api_key placeholder with a local key;
# or append this to book run:
# --opencode-auth "$HOME\.local\share\opencode\auth.json"
```

Never commit real credentials, copyrighted source books, project databases, or model output.

## Quick start

The following example creates a `my_book` project and translates one window for inspection.

```powershell
# Run from the repository root; supports .txt/.md/.docx/.epub
.\.venv\Scripts\python.exe main.py init my_book "D:\books\my_book.epub" `
  --source-language en

Set-Location folioloom

# Read-only source coverage, chunking, and anomaly checks; does not call a model
npm.cmd run folioloom -- book doctor `
  --manifest ..\projects\my_book\source_manifest.json

# Translate one logical window
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --max-windows 1 `
  --max-concurrency 1

# Inspect status; --run may be omitted when the store contains only one run
npm.cmd run folioloom -- book status `
  --store ..\projects\my_book\artifacts\folioloom\book.db
```

After reviewing the trial translation, repeat `book run` without `--max-windows 1` to continue. The runner skips windows that have already been committed.

## Live terminology and audited correction

The desktop “Terminology & Memory” workbench can save terminology while translation is active. Changes made during an in-flight window are durably queued and become visible at the next wave boundary. A rendering rule may cover the whole book or an inclusive immutable source-block range; FolioLoom rejects stale endpoints and equal-precedence overlaps instead of guessing.

After saving a rule, open “Terminology Control” to preview its exact impact. Applying the locked plan creates new translation versions for receipt-backed local repairs and schedules the existing sparse model-revalidation path for ambiguous blocks. Planned jobs can be cancelled; completed or attention-required jobs can be rolled back. Queued edits, pending active term impacts, and unfinished retrofit items block strict export.

The same control plane is available to the CLI and the translation skill:

```powershell
npm.cmd run folioloom -- book knowledge queue-status --store <book.db> --run <run-id>
npm.cmd run folioloom -- book retrofit plan --store <book.db> --run <run-id> `
  --revision <rule-revision-id> --request <unique-request-id>
npm.cmd run folioloom -- book retrofit apply --store <book.db> --run <run-id> `
  --job <job-id> --plan-hash <plan-hash>
npm.cmd run folioloom -- book retrofit status --store <book.db> --run <run-id>
npm.cmd run folioloom -- book retrofit rollback --store <book.db> --run <run-id> `
  --job <job-id>
```

Typed term-upsert JSON and the complete safe workflow are documented in [the terminology-control reference](.agents/skills/folioloom-translate/references/terminology-control.md). The CLI and skill never edit SQLite directly.

## Translate with another framework and model

The translation skill can run from any agent host with local file and command access. The
host and actual translation backend are independent. A versioned external-worker protocol
accepts arbitrary framework/model IDs; bundled bridge recipes cover OpenCode and Claude Code,
and other CLIs or SDKs can implement the same contract. No Codex installation is required for
an external worker. See [external-worker setup and protocol](.agents/skills/folioloom-translate/references/external-workers.md).

From `folioloom`, after import and book doctor:

```text
npm run folioloom -- book run --manifest <manifest> --store <store> --worker external --worker-profile <profile.json> --max-windows 2 --max-concurrency 1 --output <exports>
```

The profile selects the real executable/model and conservative planning limits. Resume
preserves its identity; actual framework usage is audited, and missing usage blocks strict
export. CLI compatibility, configured account access, and structured-output quality must be
established for the selected model with a bounded smoke. Worker modes are CLI/skill-only;
they do not change the desktop provider workflow.

## Translate with a signed-in Codex CLI

FolioLoom v1.7.1 can use an isolated `codex exec` subprocess as its model transport. This path reuses your local interactive Codex login, so it does not require a separate model API key. FolioLoom still owns source identity, bounded requests, validation, recovery, SQLite commits, audit, and export; each subprocess sees only its current model job and cannot write to the project.

Install the Codex CLI, run `codex login`, then start Codex from the repository root. The repository-scoped skill is discovered from `.agents/skills/folioloom-translate`; invoke it directly with a file rather than pasting the book into chat:

```text
Use $folioloom-translate to translate D:\books\my_book.epub from English to Simplified Chinese with MODEL_ID.
```

The skill performs a read-only environment doctor, imports the authorized source, runs deterministic preflight, translates at most two logical windows for inspection, and then resumes the exact durable run before audit and strict export. To install the skill for use outside this checkout, copy the complete `.agents/skills/folioloom-translate` directory to your user-scoped `.agents/skills` directory; do not copy books, `projects/`, databases, exports, or Codex authentication state with it.

The equivalent initial CLI call, after native `book import` and `book doctor`, is:

```powershell
Set-Location folioloom
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --worker codex `
  --codex-model "MODEL_ID" `
  --max-windows 2 `
  --max-concurrency 1 `
  --output ..\projects\my_book\exports\codex
```

Resume with the returned `--run` ID and the same model, style, glossary, and policy options. Remove `--max-windows 2` only after inspecting the partial export. Final delivery still requires `book audit`, strict `book export`, and `book verify-export`.

## Local desktop workbench (development preview)

The desktop workbench lets non-technical users select a manuscript, connect a model, translate a short trial, and then translate and export the entire book. It imports TXT, EPUB, DOCX, and Markdown directly; users do not need to select internal project files or databases.

```powershell
Set-Location folioloom
npm.cmd install
npm.cmd run desktop:dev
```

In the application:

1. Select a manuscript you are authorized to process.
2. Select a model provider and enter your API key, model name, and raw effort value.
3. Test the connection, then run a single-fragment trial translation.
4. Choose quality or fast mode under Translation Run and start the full book. A run can be paused safely and resumed after restarting the app.
5. Once the translation is complete and the audit passes, export Chinese TXT, bilingual TXT, EPUB, or all three.

API keys never enter the project, logs, UI return values, or installer. When Windows system encryption is available, keys are stored through Electron `safeStorage`; otherwise, they remain only for the current application session. Trial translation always uses one serial window. Full-book runs commit progress and translations to the manuscript's own SQLite state store without modifying the source file. Pausing or closing the app first cancels the active model request and waits for persistent state to settle; resuming preserves the run's model strategy. Export accepts only complete runs that pass strict validation and retains traceable lineage for TXT and EPUB output.

When a trial fails, export diagnostic JSON from the error panel or the persistent entry in the sidebar. Strict privacy mode retains only the version, run stage, status, counts, error codes, and redacted error chain. It excludes API keys, Authorization headers, source text, translations, prompts, raw model responses, and complete private paths.

Run `npm.cmd run desktop:dist` to build a Windows x64 portable package locally. Users can also download the portable ZIP from [GitHub Releases](https://github.com/daanaagua/FolioLoom/releases/latest). See [`folioloom/README.md`](folioloom/README.md) for desktop development details and security boundaries.

## Adjusting translation style

FolioLoom style configuration affects Chinese wording, sentence rhythm, and typography only. It cannot rewrite meaning, eliminate ambiguity, replace terminology, change chunk boundaries, or bypass validation protocols. This keeps book-level consistency intact while making the translation better match your reading preferences.

### Reusable YAML style profiles

Copy the example and specify only the fields you want to change.

```powershell
Copy-Item ..\config\style.example.yaml ..\config\style.yaml
# Edit ..\config\style.yaml

npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --style-profile ..\config\style.yaml
```

A style profile supports these optional fields under `style:`: `register`, `sentencePolicy`, `explicitation`, `imagery`, `dialogue`, `technicalProse`, `typography`, `narratorVoice`, and `additionalInstruction`. See [`config/style.example.yaml`](config/style.example.yaml) for the complete template. Regular fields are limited to 180 Unicode characters; `additionalInstruction` is limited to 600.

### One-time `--prompt`

Add `--prompt` for a final style instruction that applies only to the current run. It is appended to the runtime `additionalInstruction`; it does not modify the YAML file or replace the system prompt.

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --prompt "Keep dialogue restrained and avoid modern internet slang."
```

`--style-profile` and `--prompt` can be used together. Their additional instructions are merged in YAML-then-prompt order, with a combined limit of 600 Unicode characters.

Every run stores a hash of the **effective** style configuration in SQLite metadata. Resuming an existing run requires `--style-profile` and/or `--prompt` arguments that produce the same effective configuration. FolioLoom rejects a changed profile so the second half of a book cannot silently switch style. To try a new style, start a new run with a new state store (`--store`).

## Importing a glossary

A glossary supplies user-confirmed translations, aliases, and forms of address. It is not another prompt that the model must read in full. FolioLoom locates source forms locally using source-language token rules, without calling a model or consuming API tokens. During translation, only imported terms actually present in the current source request enter model context. Existing narrative memory and model-confirmed anchors continue to preserve global continuity.

The simplest JSON maps each source form to its default Chinese translation.

```json
{
  "Severian": "塞万里安",
  "Typhon": "提丰"
}
```

Use the structured format for inflected forms or context-sensitive Chinese. You can copy [`config/glossary.example.json`](config/glossary.example.json).

```json
{
  "schema": "folioloom-glossary-1",
  "terms": [
    {
      "source": "Severian",
      "target": "塞万里安",
      "policy": "locked",
      "forms": ["Severian's"]
    },
    {
      "source": "Archon",
      "target": "执政官",
      "policy": "contextual",
      "note": "Use 执政官 as an official title; direct address may become 阁下 when Chinese context requires it."
    }
  ]
}
```

The three `policy` values behave as follows:

- `locked`: the validator requires the specified translation in every block containing the matched source form. Use it for confirmed proper names.
- `preferred`: the default policy. It gives the model a preferred translation without freezing every context to one literal form.
- `contextual`: supplies a translation and note without a literal hard lock. Use it for titles, honorifics, and forms of address that must change with Chinese syntax.

Run a model-free check first to see which `globalIndex` values each term matches and which forms do not occur in the source.

```powershell
npm.cmd run folioloom -- book doctor `
  --manifest ..\projects\my_book\source_manifest.json `
  --glossary ..\config\glossary.json
```

After reviewing the report, pass the same glossary to the production run.

```powershell
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --glossary ..\config\glossary.json
```

FolioLoom normalizes the glossary, computes a semantic hash, and stores it in run metadata. Resuming the same run requires a semantically identical glossary. Changing JSON whitespace, object-key order, term-array order, or the file path does not matter; changing a source form, translation, policy, inflection, or note is rejected. Start a new run with a new `--store` when switching glossaries.

## Core CLI commands

Run these commands from `folioloom/`.

```powershell
# Estimate windows from a legacy V4 SQLite database; read-only and model-free
npm.cmd run folioloom -- book preflight --db ..\projects\my_book\artifacts\parallel_v4\book.db

# Independently inspect the authenticated source
npm.cmd run folioloom -- book doctor --manifest ..\projects\my_book\source_manifest.json

# Start or resume translation
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml

# Status and recovery
npm.cmd run folioloom -- book status --store ..\projects\my_book\artifacts\folioloom\book.db
npm.cmd run folioloom -- book recover `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --run RUN_ID `
  --incident INCIDENT_CODE

# Independent audit and export
npm.cmd run folioloom -- book audit `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --run RUN_ID
npm.cmd run folioloom -- book export `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --run RUN_ID `
  --output ..\projects\my_book\exports\folioloom
```

Additional `recover` arguments depend on the incident type. Structural or source-text incidents may also require `--manifest`; bounded repairs that involve a model require `--config`. The system never bypasses budget errors by compressing source text, discarding rules, or fabricating completion state.

## Design principles

FolioLoom does not try to stuff as much background material as possible into every model request. It projects only the knowledge needed at the current position.

1. The source ledger and window planner define source boundaries that cannot be dropped.
2. A bounded agent records only translation-relevant questions and retrieves evidence through restricted tools.
3. Confirmed entities, terminology, and narrative memory become available according to their positions in the book.
4. Every parallel wave shares immutable anchors and prior state.
5. Each window is validated and then committed or quarantined independently, so a failure cannot contaminate neighboring translations.
6. An independent auditor recomputes coverage and ordering from the authenticated source and SQLite state.

Detailed design and implementation records are under [`docs/superpowers/`](docs/superpowers/).

## Bounded native Pi supervisor

New native API runs enable an embedded supervisor for source-grounded batch planning,
semantic review and local repair. The kernel retains budgets, commits and strict export
gates; no external coding-agent CLI is involved. Desktop controls and the CLI support a
private task-context prefix whose identity is preserved on resume. See the
[supervisor guide](docs/bounded-supervisor.md) for controls and recovery boundaries.

## Data, credentials, and copyright

- Keep API keys only in environment variables, local configuration, or the untracked `config/config.yaml`.
- `.gitignore` excludes `projects/`, databases, logs, exports, and downloaded books.
- Source anomalies are reported and never silently rewritten in the authenticated source.
- Translate only text that you own or are authorized to process, and obtain any rights required before publishing the result.

## Legacy V1–V4

The root-level `main.py` retains the legacy serial pipeline and `parallel_v4` tools for creating input projects, importing older translations, human blind review, and historical data migration. Common entry points include:

```powershell
.\.venv\Scripts\python.exe main.py serve-v4 my_book
.\.venv\Scripts\python.exe main.py review-v4 my_book
.\.venv\Scripts\python.exe main.py export-v4 my_book
```

These entry points remain available, but `folioloom` is the production translation core.

## License

[MIT](LICENSE)
