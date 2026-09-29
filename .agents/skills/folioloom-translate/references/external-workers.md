# External framework workers

Use this path when the translation backend is not Codex CLI. The host agent only needs local
file/command access. The backend may be a CLI, an SDK program, or a gateway implemented in
any language. It must obey the protocol below; an arbitrary interactive CLI is not itself a
compatible worker.

## Built-in bridge recipes

The bundled Node bridge supports OpenCode and Claude Code headless JSON output. It uses the
framework's existing authentication and configured providers, without reading/copying keys
into FolioLoom. Check the selected framework's installed version, model availability, and
account access. Do not infer model support from the host's model list.

Generate a profile (JSON is printed to stdout; save it as a private local file):

```text
node <skill-root>/scripts/framework_bridge.mjs profile --framework opencode --model <provider/model> --context-window <tokens> --max-output-tokens <tokens>
node <skill-root>/scripts/framework_bridge.mjs profile --framework claude --model <model-id> --context-window <tokens> --max-output-tokens <tokens>
```

Choose one command, not both. Model IDs are passed unchanged to the selected framework;
there is no FolioLoom model allowlist. Limits must be conservative values from that model's
documentation/configuration. They bound FolioLoom planning and are included in the job; the
built-in bridge requests the output bound in the prompt, not through a guaranteed provider
hard cap. Framework-specific reasoning behavior stays with the framework. The internal
FolioLoom runtime effort is `off` because the scheduler does not vary external reasoning;
this does not assert that the selected model generates no reasoning tokens.

Use `--executable <native-executable-or-JS-entrypoint>` if discovery fails. On Windows,
recognized npm shims are resolved to their native executable or Node entrypoint, without
launching PowerShell/cmd. Generated profiles contain absolute local paths; regenerate them
when relocating, and start a new run if the resulting profile identity changes.

`check --framework <name>` resolves the executable without calling a model. Then run:

```text
node <skill-root>/scripts/folioloom_env.mjs doctor --root <checkout> --backend external --worker-profile <profile.json>
```

The first actual book call must be bounded by `--max-windows 2 --max-concurrency 1`.

### Adapter behavior

- OpenCode: `run --pure --format json --model ID`, with a dedicated deny-all agent,
  child-process permission overrides, sharing disabled, and automatic updates/downloads
  disabled. `--pure` bypasses external plugins. A provider requiring an external auth/plugin
  hook needs a separately reviewed custom bridge; do not silently remove isolation flags.
  OpenCode can retain its normal local session history; the bridge disables sharing, not
  that history. Keep the framework's data directory private.
  A leaked DeepSeek DSML prefix is unwrapped only for one invocation of the exact
  requested tool containing a complete JSON object. This does not execute a
  framework tool, reconstruct truncated JSON, or bypass FolioLoom schema checks.
- Claude Code: `-p --output-format json --model ID`, tools disabled, empty strict MCP
  configuration, hooks and slash commands disabled, no session persistence. Existing model
  aliases/custom gateways follow the installed framework's configuration. Do not use an
  alias whose target changes during a run.
- Other frameworks (including Gemini CLI, Cursor, or a custom agent SDK): implement a small
  protocol bridge that invokes that framework directly. Do not wrap its text as if it were
  Codex output. Disable autonomous tool execution and account-level sharing as appropriate
  for that framework, then verify a bounded real call before translating a book.

CLI interfaces used by the bundled bridge: [OpenCode CLI](https://opencode.ai/docs/cli/)
and [Claude headless mode](https://code.claude.com/docs/en/headless).

## Profile schema

```json
{
  "schema": "folioloom-worker-profile-v1",
  "id": "my-framework",
  "modelId": "provider/exact-model-id",
  "command": "node",
  "args": ["/absolute/path/to/my-bridge.mjs"],
  "contextWindow": 64000,
  "maxOutputTokens": 8000,
  "timeoutMs": 600000
}
```

`command` is a native executable, not shell code. For JavaScript use Node as the command and
the script as an argument. `.cmd`, `.bat`, and `.ps1` commands are rejected. A command path
is resolved relative to the profile file; bare commands use PATH. Argument paths must be
absolute because jobs run in a new temporary working directory. Arguments are not expanded
or interpolated. Profiles are trusted operator configuration and must never be derived from
book instructions. Keep secrets in the framework's normal environment/credential store.

`id`, model, executable, arguments, limits, and timeout form a normalized SHA-256 identity.
Resume requires that exact identity before any generation. The profile hash does not hash
every executable or referenced configuration file: keep those stable for the run, and use
a new profile ID/run for semantic adapter/provider changes.

## Request and response protocol

FolioLoom writes one UTF-8 JSON request to stdin and closes it. The worker writes exactly one
JSON envelope to stdout and exits. Diagnostics must go to stderr, never stdout. The worker
must invoke the requested model once, without conversational history from previous jobs.

Request:

```json
{
  "schema": "folioloom-worker-v1",
  "requestId": "opaque-unique-id",
  "modelId": "provider/exact-model-id",
  "maxOutputTokens": 8000,
  "systemPrompt": "FolioLoom's task instructions",
  "messages": [{"role": "user", "text": "one bounded job"}],
  "outputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
}
```

Messages can also contain assistant text/tool-call content or `tool_result` entries with
`toolName`, `toolCallId`, `isError`, and `text`. A request with `tool: {name, description}`
expects the arguments for that single terminating tool as `output`; the worker must not
execute that tool. Without `tool`, output is `{text: string}`. FolioLoom subsequently validates
the original tool schema and executes the submission through its capability gate.

Successful response:

```json
{
  "schema": "folioloom-worker-v1",
  "requestId": "opaque-unique-id",
  "modelId": "provider/exact-model-id",
  "output": {"text": "complete answer"},
  "usage": {"input": 100, "output": 40, "cacheRead": 20, "cacheWrite": 0, "reasoning": 10}
}
```

Usage must be nonnegative safe integers from framework/provider metadata. Here the total is
160, not 170: reasoning is already included in output. Missing/invalid usage is incomplete;
do not use a tokenizer estimate or the model's generated usage fields. OpenCode step usage
is summed, with its separate visible-output and reasoning counters combined into output.
Claude input/cache counters are disjoint and its output counter is already inclusive.

Failure response keeps schema/requestId/modelId and replaces output with
`error: {code: "auth" | "quota" | "network" | "output" | "execution"}`. Do not include
credentials, manuscript excerpts, or raw SDK error dumps. The core maps these codes to
stable provider errors; it discards unstructured child stderr. It also rejects mismatched
request/model identities, non-object output, and malformed envelopes.

The transport caps request and combined response/diagnostic bytes at 8 MB and applies the
profile timeout plus the parent cancellation signal. Timeout/cancellation kills the owned
worker process tree. Do not detach a daemon from the bridge. Temporary job directories are
removed before completion; framework-managed caches/session logs are not automatically
deleted. The external worker is trusted code, not an OS-security sandbox.
