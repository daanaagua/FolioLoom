// Exercise the public store API with a synthetic one-block book.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LosslessBookStore } from '../src/storage/lossless-book-store.js';
import { createKnowledgeSnapshot } from '../src/knowledge/snapshot.js';
import { conceptFromAnchor } from '../src/knowledge/lexical-concept.js';
import { expectedTermOccurrences } from '../src/knowledge/term-usage.js';
import { getSourceLanguageProfile } from '../src/language/profiles.js';
import { blockId } from '../src/source/block-builder.js';
import { auditLosslessBookStore, writeLosslessBookArtifacts } from '../src/report.js';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
test("persists safe repair and blocks legacy cascading corruption at strict export audit", () => {
const directory = mkdtempSync(join(tmpdir(), 'folioloom-review-retrofit-'));
const databasePath = join(directory, 'synthetic.db');
const store = new LosslessBookStore(databasePath);
try {
  const sourceText = 'Captain came. Captain stopped.';
  const sourceVersion = 'synthetic-source';
  const runId = 'synthetic-run';
  const id = blockId(sourceVersion, 0, sourceText.length, sourceText);
  const block = { id, sourceVersion, canonicalStart: 0, canonicalEnd: sourceText.length,
    sourceText, sourceHash: sha(sourceText), globalIndex: 0, tokenCount: 8,
    structureId: null, structureTitle: null };
  store.registerSource({
    sourceVersion, rawSha256: sha(sourceText), canonicalSha256: sha(sourceText),
    canonicalChars: sourceText.length, coordinateUnit: 'unicode_scalar', sourceFormat: 'txt',
    encoding: 'utf-8', extractor: 'synthetic', sourceLanguage: 'en',
    sourceLanguageProfileVersion: 'source-language-profile-1', sourceLanguageCompatibilityMode: false,
    ranges: [{ rangeId: 'range', canonicalStart: 0, canonicalEnd: sourceText.length,
      originKind: 'text' as const, originRef: 'synthetic.txt', transformation: 'identity' }],
  });
  store.replaceDerivedPlan(sourceVersion, { blocks: [block], annotations: [] });
  const snapshot = createKnowledgeSnapshot(runId, []);
  store.createTranslationRun({ runId, sourceVersion, protocolVersion: 'lossless-v5-1',
    modelId: 'synthetic-no-model', initialSnapshotId: snapshot.id, initialSnapshot: snapshot });
  store.initializeWindowPlan(runId, [{ windowId: 'window', ordinal: 0, chapterId: 'chapter',
    chapterTitle: 'Synthetic', blockIds: [id], globalIndexes: [0], sourceTokens: 8,
    sourceChars: sourceText.length, oversized: false }]);
  const concept = conceptFromAnchor({ sourceForm: 'Captain', target: '舰队长',
    mode: 'contextual', semanticClass: 'role', confidence: 0.95 });
  store.upsertLexicalConcepts(runId, [concept]);
  const usages = expectedTermOccurrences([{ id, sourceText }], [concept], getSourceLanguageProfile('en'))
    .map((occurrence, index) => ({ occurrenceId: occurrence.occurrenceId, blockId: id,
      conceptId: occurrence.conceptId, sourceForm: occurrence.sourceForm,
      sourceStart: occurrence.sourceStart, sourceEnd: occurrence.sourceEnd,
      discourseRole: 'narrative' as const, targetSurface: index === 0 ? '舰队长' : '船长' }));
  const oldText = '舰队长走来。船长停下。';
  store.claimWindow(runId, 'window');
  store.stageWindow({ runId, windowId: 'window', snapshotId: snapshot.id, status: 'completed',
    translations: [{ blockId: id, sourceHash: block.sourceHash, text: oldText }],
    knowledgeCandidates: [], conceptBindings: { usages, concepts: [concept] },
    styleTail: oldText, budget: { modelCalls: 1 }, warnings: [] });
  store.promoteStagedWindow(runId, 'window');
  let state = store.knowledgeState(runId);
  const commit = store.commitKnowledgeCommands({ requestId: 'rename-captain', runId,
    expectedGeneration: state.generation, expectedSnapshotId: state.snapshotId,
    commands: [{ type: 'upsert', objectType: 'term', normalizedSubject: 'captain',
      kind: 'term_rendering_rule:captain', expectedRevision: null, expectedScopeRevision: null,
      fieldPatch: { ruleId: 'captain', conceptId: concept.conceptId, sourceForms: ['Captain'],
        target: '新船长', allowedTargets: ['新船长'], policy: 'locked', locked: true,
        selector: { kind: 'whole_book' }, priority: 0 },
      ownedFields: ['/target', '/allowedTargets', '/selector'], scope: 'book', evidence: [], origin: 'manual' }],
  });
  state = store.knowledgeState(runId);
  const plan = store.planTermRetrofitJob({ requestId: 'retrofit', runId,
    ruleRevisionId: commit.revisionIds[0]!, expectedGeneration: state.generation,
    expectedSnapshotId: state.snapshotId });
  const job = store.applyTermRetrofitJob(runId, plan.jobId, plan.planHash);
  assert.equal(job.status, 'completed');
  assert.equal(store.activeTranslations(runId)[0]!.text, '新船长走来。新船长停下。');
  assert.equal(auditLosslessBookStore(store, runId).strictExportable, true);
  // Emulate an already persisted v1.7.0 cascading replacement. Its receipts
  // still pass surface-inclusion checks, so audit must replay the edit itself.
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("UPDATE translations SET text=? WHERE run_id=? AND active=1")
      .run('新新船长走来。新船长停下。', runId);
  } finally { database.close(); }
  const corruptAudit = auditLosslessBookStore(store, runId);
  assert.equal(corruptAudit.strictExportable, false);
  assert.ok(corruptAudit.incidentCodes.includes('TERM_RETROFIT_INTEGRITY_INVALID'));
  const exportDirectory = join(directory, 'must-not-be-published');
  assert.throws(() => writeLosslessBookArtifacts(store, runId, exportDirectory),
    /TERM_RETROFIT_INTEGRITY_INVALID/);
  assert.equal(existsSync(exportDirectory), false);
  const readOnly = LosslessBookStore.openReadOnly(databasePath);
  try {
    assert.equal(auditLosslessBookStore(readOnly, runId).strictExportable, false);
  } finally { readOnly.close(); }
  store.rollbackTermRetrofitJob(runId, job.jobId);
  assert.equal(store.activeTranslations(runId)[0]!.text, oldText);
  assert.ok(!auditLosslessBookStore(store, runId).incidentCodes.includes('TERM_RETROFIT_INTEGRITY_INVALID'));
} finally {
  store.close();
  // This directory is newly created by this probe; unlink only its regular files.
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (!item.isFile()) throw new Error(`Unexpected directory in synthetic fixture: ${item.name}`);
    unlinkSync(join(directory, item.name));
  }
  rmdirSync(directory);
}
});
