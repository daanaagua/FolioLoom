# FolioLoom current state

- Date: 2026-09-29 (Asia/Shanghai).
- Native Pi bounded supervision now plans batches, queries source evidence,
  requests grounded review/repair, and persists pause/release decisions. Task
  context is shared across model phases and checked on resume. CLI and desktop
  new native runs enable supervision by default; legacy runs retain their mode.
- Supervisor verification: 1040 core tests passed with one environment skip;
  74 renderer tests, both type checks, desktop build, and launch-form browser
  checks passed. [Architecture and controls](docs/bounded-supervisor.md).
- EPUB validation now ignores whitespace-only paragraph spans at lossless block
  boundaries; content and structural-slot checks remain strict. 53 focused tests
  and type checking passed. [Details](state/2026-09-29.md).
- Version: v1.8.0. Release notes: [v1.8.0](docs/releases/v1.8.0.md).
- Native live gates: 549-word translation/export and 96-word requested semantic
  review/export completed with fully accounted usage. Review schemas now explicitly
  exclude plan-only fields. Build dependency high/critical audit gate passes.
- Development branch: `feat/framework-neutral-worker-20260911` adds a host-neutral
  translation skill and a versioned external-framework/model worker protocol.
  Codex remains a separate compatible backend. OpenCode and Claude Code have
  bundled bridges; other CLIs/SDKs can implement the same contract.
- Worker verification: 1018 core tests passed, one environment-dependent skip;
  nine skill/bridge tests and both type checks passed. A 117-word OpenCode run
  passed audit, strict export, verification, and no-call resume in 17.27 seconds.
  See [external worker evidence](state/2026-09-11.md).
- Desktop model discovery now scans live endpoints, labels fallback and empty
  results, and preserves the selected model. New configurations use
  `deepseek-flash`; existing run identities remain unchanged.
- Native Pi wire data omits local revision hashes; full audit data stays local.
  DeepSeek planning deduplicates seven effort aliases into four strategies.
- Verification: 84 focused Node regressions, 73 renderer tests, type checks,
  desktop build, live discovery, and a canonical-ID 549-word run (59.6 seconds,
  strict export passed). See the [discovery report](docs/reports/2026-09-11-live-model-discovery.md).
- Storage remains schema v5. Existing local edits are replay-audited; ambiguous
  or corrupt edits block strict export rather than being silently rewritten.
- Still planned: visual source-range selection, per-edit diffs, live panel
  refresh, gradual store/runner extraction, and automated packaged-release gates.
- Fresh English/German 100K and full-book literary quality benchmarks remain
  deferred; historical README timings are not new v1.7.1 measurements.

## History

- [EPUB block-edge validation](state/2026-09-29.md)
- [External framework workers](state/2026-09-11.md)
- [Live discovery and Pi planning](docs/reports/2026-09-11-live-model-discovery.md)
- [Pi wire measurement](docs/reports/2026-09-11-pi-request-wire-measurement.md)
- [Pi request efficiency plan](docs/specs/2026-09-11-pi-request-wire-efficiency.md)
- [2026-09-05 reliability patch](state/2026-09-05.md)
- [v1.7.1 patch notes](docs/releases/v1.7.1.md)
- [v1.7.0 release](docs/releases/v1.7.0.md)
- [July execution/scheduler history](state/2026-07-30-legacy.md)
