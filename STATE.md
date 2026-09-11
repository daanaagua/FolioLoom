# FolioLoom current state

- Date: 2026-09-11 (Asia/Shanghai).
- Version: v1.7.2. Release notes: [v1.7.2](docs/releases/v1.7.2.md).
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

- [Live discovery and Pi planning](docs/reports/2026-09-11-live-model-discovery.md)
- [Pi wire measurement](docs/reports/2026-09-11-pi-request-wire-measurement.md)
- [Pi request efficiency plan](docs/specs/2026-09-11-pi-request-wire-efficiency.md)
- [2026-09-05 reliability patch](state/2026-09-05.md)
- [v1.7.1 patch notes](docs/releases/v1.7.1.md)
- [v1.7.0 release](docs/releases/v1.7.0.md)
- [July execution/scheduler history](state/2026-07-30-legacy.md)
