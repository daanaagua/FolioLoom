# Codex worker contract

## Checkout resolution and privacy

The skill must resolve FolioLoom before doing any work. Resolution order is explicit root,
`FOLIOLOOM_HOME`, then a
validated current-directory ancestor. A valid root contains `main.py`, the TypeScript package,
the Codex adapter, and the Codex worker CLI flags. Never accept an arbitrary Git root.

Books, databases, prompts, evidence, credentials, authentication state, and exports remain
private and untracked. Never copy Codex login state into the repository or a project folder.

## Ownership

FolioLoom owns source identity, prompts, tool schemas, token reservations, validation,
repairs, knowledge state, SQLite writes, audit, and exports. `codex exec` receives only one
model job through stdin and returns one schema-bounded result. The worker never receives a
database path and never commits a window.

The control conversation starts and observes the CLI. It does not act as the translation
model and does not use chat-tree subagents for production windows.

## CLI options

| Option | Rule |
|---|---|
| `--worker codex` | Selects the signed-in local Codex CLI transport. |
| `--codex-model ID` | Required and persisted as run model identity. |
| `--codex-context-window N` | Optional conservative FolioLoom planning limit; it does not alter the actual model. |
| `--codex-max-output-tokens N` | Optional conservative completion planning limit. Must be below context window. |
| `--codex-executable PATH` | Optional exact executable path; default is `codex` from PATH. |
| `--max-concurrency 1` | Required by the first implementation. Omission also resolves to 1. |
| `--run-mode quality` | The only supported Codex-worker mode in the first implementation. |

Use `book import --source PATH --project DIRECTORY --source-language ID` for a new
file-backed project. The native importer owns DOCX/EPUB extraction, raw hashing, canonical
UTF-8 text, provenance, atomic project creation, and the certified source manifest. It must
refuse an existing project rather than overwrite it.

`--config` and `--opencode-auth` are provider-API options and are mutually exclusive with
`--worker codex`. Codex authentication remains in the user's normal Codex installation; the
job does not copy credentials into FolioLoom.

Default planning limits are 256,000 context tokens and 32,768 output tokens. Override them
only from trustworthy model documentation or a user-provided constraint. Smaller values are
conservative; inflated values can make the scheduler admit a request the actual model rejects.

New Codex runs persist `codexExecutionPolicy: codex-file-v1`. This policy may pack at most two
adjacent pending logical windows into one bounded physical request and tries a structurally
high-paragraph block whole before recovery. Logical window validation and commits stay
independent. A clean serial wave may prepare two physical requests against one anchor
snapshot; a retry, fresh-wave condition, entity warning, or unresolved knowledge state backs
the next horizon down to one request. Shape collapse, paragraph loss, protocol drift, or provider context rejection
must return to the existing bounded window/block/paragraph recovery topology. A legacy Codex
run without this metadata resumes with legacy request shaping; never mutate its policy on
resume.

## Process isolation

Each model call uses a new temporary directory and:

```text
codex exec
  --model <id>
  --sandbox read-only
  --cd <isolated-temp-dir>
  --skip-git-repo-check
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --config model_reasoning_effort="high"
  --output-schema <schema.json>
  --output-last-message <last-message.json>
  --json
  -
```

The job is UTF-8 stdin, so source prose is absent from process arguments. The temporary
directory contains only the output schema and final response and is removed before the
StreamFn result settles. No shell is used to launch the executable.

The full-book path currently exposes zero tools for framed text or one terminating tool for
typed translation, repair, and lexical anchors. More than one tool fails before dispatch with
`CODEX_EXEC_UNSUPPORTED_TOOL_SET`.

## Usage mapping

The adapter reads the latest JSONL `turn.completed.usage` event:

- `input = input_tokens - cached_input_tokens - cache_write_input_tokens`;
- `cacheRead = cached_input_tokens`;
- `cacheWrite = cache_write_input_tokens`;
- `output = output_tokens`;
- `reasoning = reasoning_output_tokens` or the reported output-token detail;
- `totalTokens = input_tokens + output_tokens`.

If required fields are absent or invalid, all usage fields remain zero. Existing FolioLoom
accounting treats a dispatched model call with zero tokens as incomplete and conservatively
settles its reservation. Strict export must remain blocked.

## Stable failure meanings

| Marker | Meaning and next action |
|---|---|
| `CODEX_EXEC_FAILED` | Spawn, nonzero exit, network, account, or CLI failure. Inspect the diagnostic and Codex login/quota; resume the same run after recovery. |
| `CODEX_EXEC_INVALID_OUTPUT` | Missing or invalid final JSON. Let the existing bounded protocol/recovery path handle it; preserve evidence if it becomes human-required. |
| `CODEX_EXEC_UNSUPPORTED_TOOL_SET` | A caller exposed multiple tools. This is an integration error; do not retry as prose. |
| `CODEX_EXEC_ABORTED` | Parent cancellation or deadline. Inspect status and resume from the durable boundary. |

PiRuntime retains the ordinary provider classification and evidence callback, so raw response
evidence, request hashes, attempt IDs, and usage settlement follow the same path as API models.

## Resume identity

New Codex runs store `executionBackend: codex-exec`. A resume must preserve:

- backend and model ID;
- source version and protocol version;
- style profile and bounded prompt;
- glossary semantic hash;
- optimization profile and scheduler mode.
- Codex execution policy when the run already stores one.

Changing one of these requires a new store/run. Already committed windows are skipped on a
valid resume; running/staged work is handled by the existing recovery boundaries.

## Completion checklist

Read `book status`, `book audit`, strict `book export`, and `book verify-export`. A successful
short smoke proves the adapter path only. It does not prove full-book quality or 100K
throughput.
