# FolioLoom current state

- Date: 2026-09-05 (Asia/Shanghai).
- Current patch: v1.7.1; terminology repair integrity, multi-form rule resolution,
  complete tie-conflict detection, dead-owner lease recovery, and indexed lookup.
- Storage remains schema v5. Existing local edits are replay-audited; ambiguous
  or corrupt edits block strict export rather than being silently rewritten.
- Validation and upgrade notes: [2026-09-05](state/2026-09-05.md).
- Still planned: visual source-range selection, per-edit diffs, live panel
  refresh, gradual store/runner extraction, and automated packaged-release gates.
- Fresh English/German 100K and full-book literary quality benchmarks remain
  deferred; historical README timings are not new v1.7.1 measurements.

## History

- [v1.7.1 patch notes](docs/releases/v1.7.1.md)
- [v1.7.0 release](docs/releases/v1.7.0.md)
- [July execution/scheduler history](state/2026-07-30-legacy.md)
