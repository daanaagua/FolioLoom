import assert from "node:assert/strict";
import test from "node:test";
import { runReliabilityGate } from "../src/benchmark/reliability-gate.js";

for (const mode of ["quality", "fast"] as const) {
  test(`synthetic reliability gate: ${mode} recovers review faults with exact export and accounting`, async () => {
    const report = await runReliabilityGate({ words: 2000, faultEvery: 1, mode });
    assert.ok(report.injectedFaults > 0);
    assert.equal(report.resumes, report.injectedFaults);
    assert.equal(report.duplicateTranslations, 0);
    assert.equal(report.strictExportable, true);
    assert.equal(report.exportVerified, true);
    assert.equal(report.semanticQualityMeasured, false);
  });
}
